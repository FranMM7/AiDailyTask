/**
 * Manages files under board/<id>/files/: list, save, read (with stat + mime),
 * delete. Filenames are sanitized (no path separators, NFC-normalized, deduped
 * with a numeric suffix). Every resolved path is guarded to stay under the files
 * directory (path-traversal protection).
 */
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { ReadStream } from "node:fs";
import mime from "mime";
import { type Attachment, normalizeId } from "@AiDailyTasks/shared";
import type { Env } from "../env";
import { NotFoundError, ValidationError } from "../errors";

export class AttachmentStore {
  constructor(private readonly env: Env) {}

  filesDir(id: string): string {
    return path.join(this.env.boardDir, normalizeId(id), "files");
  }

  private mimeOf(name: string): string {
    return mime.getType(name) ?? "application/octet-stream";
  }

  private urlFor(id: string, name: string): string {
    return `/api/tasks/${normalizeId(id)}/attachments/${encodeURIComponent(name)}`;
  }

  /** Sanitize to a bare filename; throws if nothing usable remains. */
  sanitizeName(raw: string): string {
    const base = path.basename(raw.normalize("NFC")).replace(/[\\/]/g, "").replace(/^\.+/, "").trim();
    if (!base || base === "." || base === "..") {
      throw new ValidationError(`Invalid attachment filename: ${JSON.stringify(raw)}`);
    }
    return base;
  }

  /** Resolve a requested name under files/, rejecting any traversal. */
  private resolveSafe(id: string, name: string): string {
    const dir = this.filesDir(id);
    const decoded = name.normalize("NFC");
    const resolved = path.resolve(dir, decoded);
    const rel = path.relative(dir, resolved);
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel) || rel.includes(path.sep + "..")) {
      throw new ValidationError(`Illegal attachment path: ${JSON.stringify(name)}`);
    }
    return resolved;
  }

  private async statAttachment(id: string, absPath: string, name: string): Promise<Attachment> {
    const st = await fs.stat(absPath);
    return {
      name,
      size: st.size,
      mime: this.mimeOf(name),
      modified: new Date(st.mtimeMs).toISOString(),
      url: this.urlFor(id, name),
    };
  }

  async list(id: string): Promise<Attachment[]> {
    const dir = this.filesDir(id);
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch {
      return [];
    }
    const rows = await Promise.all(names.map(async (name): Promise<Attachment | null> => {
      const abs = path.join(dir, name);
      try {
        const st = await fs.stat(abs);
        if (!st.isFile()) return null;
        return {
          name,
          size: st.size,
          mime: this.mimeOf(name),
          modified: new Date(st.mtimeMs).toISOString(),
          url: this.urlFor(id, name),
        };
      } catch {
        return null; // skip vanished file
      }
    }));
    const out = rows.filter((row): row is Attachment => row !== null);
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }

  /** Pick a non-colliding filename by inserting " (n)" before the extension. */
  private async dedupeName(dir: string, name: string): Promise<string> {
    const ext = path.extname(name);
    const stem = name.slice(0, name.length - ext.length);
    let candidate = name;
    let n = 1;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        await fs.access(path.join(dir, candidate));
        candidate = `${stem}-${n}${ext}`;
        n += 1;
      } catch {
        return candidate;
      }
    }
  }

  async save(id: string, rawName: string, data: Buffer): Promise<Attachment> {
    const dir = this.filesDir(id);
    await fs.mkdir(dir, { recursive: true });
    const clean = this.sanitizeName(rawName);
    const finalName = await this.dedupeName(dir, clean);
    const abs = path.join(dir, finalName);
    await fs.writeFile(abs, data);
    return this.statAttachment(id, abs, finalName);
  }

  async read(id: string, name: string): Promise<{ path: string; size: number; mime: string; stream: (opts?: { start?: number; end?: number }) => ReadStream }> {
    const abs = this.resolveSafe(id, name);
    let st;
    try {
      st = await fs.stat(abs);
    } catch {
      throw new NotFoundError(`Attachment not found: ${name}`);
    }
    if (!st.isFile()) throw new NotFoundError(`Attachment not found: ${name}`);
    return {
      path: abs,
      size: st.size,
      mime: this.mimeOf(name),
      stream: (opts) => createReadStream(abs, opts),
    };
  }

  async delete(id: string, name: string): Promise<void> {
    const abs = this.resolveSafe(id, name);
    try {
      await fs.unlink(abs);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new NotFoundError(`Attachment not found: ${name}`);
      }
      throw err;
    }
  }
}
