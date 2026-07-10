/**
 * Registry of writes the server itself performed, keyed by absolute path + mtimeMs.
 * The repository registers here before/after atomic writes; the chokidar watcher
 * consults it to suppress self-echoes (so server writes don't re-broadcast).
 * Entries auto-expire.
 */
import path from "node:path";

const TTL_MS = 10_000;

export class RecentWrites {
  private entries = new Map<string, number>();

  private key(filePath: string, mtimeMs: number): string {
    // Round to the millisecond to tolerate float jitter between stat calls.
    return `${path.resolve(filePath)}::${Math.round(mtimeMs)}`;
  }

  add(filePath: string, mtimeMs: number): void {
    this.entries.set(this.key(filePath, mtimeMs), Date.now());
    this.gc();
  }

  /** True if this exact (path, mtime) was recently written by us. */
  has(filePath: string, mtimeMs: number): boolean {
    const k = this.key(filePath, mtimeMs);
    const at = this.entries.get(k);
    if (at === undefined) return false;
    if (Date.now() - at > TTL_MS) {
      this.entries.delete(k);
      return false;
    }
    return true;
  }

  private gc(): void {
    const now = Date.now();
    for (const [k, at] of this.entries) {
      if (now - at > TTL_MS) this.entries.delete(k);
    }
  }
}
