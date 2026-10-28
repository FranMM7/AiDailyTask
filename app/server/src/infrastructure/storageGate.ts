import fs from "node:fs/promises";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { Mutex } from "async-mutex";

/** Cross-transport write exclusion, also used by maintenance. Nested recurrence writes reuse it. */
export class StorageGate {
  private readonly mutex = new Mutex();
  private readonly context = new AsyncLocalStorage<boolean>();
  constructor(private readonly boardDir: string) {}
  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.context.getStore()) return operation();
    return this.mutex.runExclusive(async () => {
      const parent = path.join(this.boardDir, "_meta", "runtime");
      await fs.mkdir(parent, { recursive: true });
      const lock = path.join(parent, "write.lock");
      const deadline = Date.now() + 5000;
      for (;;) {
        try { await fs.mkdir(lock); break; }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          if (Date.now() >= deadline) throw new Error("Storage is busy or a maintenance lock remains. Stop other writers and inspect board/_meta/runtime/write.lock before retrying.");
          await new Promise(resolve => setTimeout(resolve, 25));
        }
      }
      try {
        await fs.writeFile(path.join(lock, "owner.json"), JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
        return await this.context.run(true, operation);
      } finally {
        await fs.unlink(path.join(lock, "owner.json")).catch(() => {});
        await fs.rmdir(lock);
      }
    });
  }
}
