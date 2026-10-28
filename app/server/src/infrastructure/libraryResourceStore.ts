import fs from "node:fs/promises";
import path from "node:path";
import mime from "mime";
import { randomUUID } from "node:crypto";
import { type CreateLibraryResource, type LibraryResource, CreateLibraryResourceSchema } from "@AiDailyTasks/shared";
import type { Env } from "../env";
import { NotFoundError, ValidationError } from "../errors";

export class LibraryResourceStore {
  private readonly dataPath: string;
  private readonly filesDir: string;
  constructor(private readonly env: Env) { const dir = env.libraryDir ?? path.join(env.boardDir, "_meta", "resources"); this.dataPath = path.join(dir, "resources.json"); this.filesDir = path.join(dir, "files"); }
  private async readAll(): Promise<LibraryResource[]> { try { const raw: unknown = JSON.parse(await fs.readFile(this.dataPath, "utf8")); return Array.isArray(raw) ? raw as LibraryResource[] : []; } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; throw e; } }
  private async writeAll(rows: LibraryResource[]) { await fs.mkdir(path.dirname(this.dataPath), { recursive: true }); await fs.writeFile(this.dataPath, `${JSON.stringify(rows, null, 2)}\n`, "utf8"); }
  async list(): Promise<LibraryResource[]> { return (await this.readAll()).sort((a,b) => a.title.localeCompare(b.title)); }
  async get(id: string): Promise<LibraryResource> { const row = (await this.readAll()).find((r) => r.id === id); if (!row) throw new NotFoundError(`Library resource not found: ${id}`); return row; }
  async create(input: CreateLibraryResource): Promise<LibraryResource> { const parsed = CreateLibraryResourceSchema.parse(input); const now = new Date().toISOString(); const row: LibraryResource = { ...parsed, id: `lib_${randomUUID().replace(/-/g, "")}`, created: now, updated: now }; const all = await this.readAll(); all.push(row); await this.writeAll(all); return row; }
  async update(id: string, input: Partial<CreateLibraryResource>): Promise<LibraryResource> { const all = await this.readAll(); const i = all.findIndex((r) => r.id === id); if (i < 0) throw new NotFoundError(`Library resource not found: ${id}`); const next = CreateLibraryResourceSchema.parse({ ...all[i], ...input, fileName: input.fileName ?? all[i].fileName }); const row = { ...all[i], ...next, id, created: all[i].created, updated: new Date().toISOString() }; all[i] = row; await this.writeAll(all); return row; }
  async delete(id: string) { const all = await this.readAll(); const row = all.find((r) => r.id === id); if (!row) throw new NotFoundError(`Library resource not found: ${id}`); await this.writeAll(all.filter((r) => r.id !== id)); if (row.fileName) await fs.rm(path.join(this.filesDir, id), { recursive: true, force: true }); }
  private clean(name: string) { const out = path.basename(name.normalize("NFC")).replace(/[\\/]/g, "").replace(/^\.+/, "").trim(); if (!out) throw new ValidationError("Invalid resource filename"); return out; }
  async saveFile(id: string, name: string, data: Buffer): Promise<LibraryResource> { const row = await this.get(id); const fileName = this.clean(name); const dir = path.join(this.filesDir, id); await fs.mkdir(dir, { recursive: true }); await fs.writeFile(path.join(dir, fileName), data); return this.update(id, { kind: "file", fileName, content: undefined }); }
  async readFile(id: string) { const row = await this.get(id); if (!row.fileName) throw new NotFoundError("Resource has no file"); const file = path.resolve(this.filesDir, id, row.fileName); if (!file.startsWith(path.resolve(this.filesDir, id) + path.sep)) throw new ValidationError("Illegal resource path"); return { path: file, mime: mime.getType(row.fileName) ?? "application/octet-stream", name: row.fileName }; }
}
