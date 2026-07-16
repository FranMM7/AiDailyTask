import fs from "node:fs/promises";
import path from "node:path";
import type { ProjectDocumentation } from "@AiDailyTasks/shared";
import type { Env } from "../env";
import { NotFoundError, ValidationError } from "../errors";
import type { ProjectsService } from "../projects";

const SAFE_ID = /^[\p{L}\p{N}][\p{L}\p{N} ._-]*$/u;
const INSTRUCTIONS = "instructions.md";
const README_META = "readme.json";

interface ReadmeMeta { name: string; importedAt: string }

export class ProjectDocumentationService {
  constructor(private readonly env: Env, private readonly projects: ProjectsService) {}

  private project(id: string) {
    const project = this.projects.get(id);
    if (!project) throw new NotFoundError(`Project "${id}" not found`);
    return project;
  }

  private dir(id: string): string {
    if (!SAFE_ID.test(id)) throw new ValidationError(`Invalid project id: ${id}`);
    return path.join(this.env.projectDocsDir, id);
  }

  async get(id: string): Promise<ProjectDocumentation> {
    const project = this.project(id);
    const dir = this.dir(id);
    const instructions = await fs.readFile(path.join(dir, INSTRUCTIONS), "utf8").catch(() => "");
    let readme: ProjectDocumentation["readme"] = null;
    try {
      const meta = JSON.parse(await fs.readFile(path.join(dir, README_META), "utf8")) as ReadmeMeta;
      const markdown = await fs.readFile(path.join(dir, "README.md"), "utf8");
      readme = { ...meta, markdown };
    } catch { /* no imported README yet */ }
    return { project, instructions, readme };
  }

  async update(id: string, instructions: string): Promise<ProjectDocumentation> {
    this.project(id);
    const dir = this.dir(id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, INSTRUCTIONS), instructions, "utf8");
    return this.get(id);
  }

  async importReadme(id: string): Promise<ProjectDocumentation> {
    const project = this.project(id);
    if (!project.root) throw new ValidationError(`Project "${id}" has no source path`);
    const root = path.resolve(project.root);
    let entries;
    try { entries = await fs.readdir(root, { withFileTypes: true }); }
    catch { throw new ValidationError(`Project source path is not readable: ${project.root}`); }
    const entry = entries.find((item) => item.isFile() && /^readme(?:\.[^.]+)?\.md$/i.test(item.name))
      ?? entries.find((item) => item.isFile() && /^readme\.md$/i.test(item.name));
    if (!entry) throw new NotFoundError(`No Markdown README found at the root of project "${id}"`);
    const source = path.join(root, entry.name);
    const markdown = await fs.readFile(source, "utf8");
    const dir = this.dir(id);
    await fs.mkdir(dir, { recursive: true });
    const meta: ReadmeMeta = { name: entry.name, importedAt: new Date().toISOString() };
    await fs.writeFile(path.join(dir, "README.md"), markdown, "utf8");
    await fs.writeFile(path.join(dir, README_META), `${JSON.stringify(meta, null, 2)}\n`, "utf8");
    return this.get(id);
  }
}
