/**
 * Projects live in a local, git-ignored projects.json (a flat JSON array of
 * { id, label }) — NOT in board.config.json, so the config file stays a shareable
 * template while project names remain private, on-disk, editable by hand or the model.
 *
 * The file is read fresh on each list() so a hand-edit is picked up immediately; add()
 * validates + de-dupes + writes atomically and publishes `config.updated` so the browser
 * refetches. Missing/invalid files degrade to an empty list rather than crashing the board.
 */
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { nanoid } from "nanoid";
import type { CreateProjectRequest, ProjectDef } from "@AiDailyTaks/shared";
import type { Env } from "./env";
import type { EventBus } from "./infrastructure/eventBus";
import { ValidationError } from "./errors";

const ProjectsFileSchema = z.array(
  z.object({ id: z.string().min(1), label: z.string().min(1) }),
);

/** Default seed for a fresh install (no projects.json yet). */
const DEFAULT_PROJECTS: ProjectDef[] = [{ id: "Sample", label: "Sample" }];

export class ProjectsService {
  constructor(
    private readonly env: Env,
    private readonly bus: EventBus,
  ) {}

  /** Create projects.json with the default seed if it does not exist yet. */
  async ensureFile(): Promise<void> {
    try {
      await fs.access(this.env.projectsPath);
    } catch {
      await this.write(DEFAULT_PROJECTS);
    }
  }

  /** Current projects, read fresh from disk. Returns [] if the file is missing/unreadable/invalid. */
  list(): ProjectDef[] {
    let raw: string;
    try {
      raw = readFileSync(this.env.projectsPath, "utf8");
    } catch {
      return [];
    }
    try {
      return ProjectsFileSchema.parse(JSON.parse(raw));
    } catch {
      return [];
    }
  }

  /** Add a project (idempotent on id). Publishes config.updated. Returns the full list. */
  async add(req: CreateProjectRequest): Promise<ProjectDef[]> {
    const id = req.id.trim();
    if (!id) throw new ValidationError("Project id is required");
    const label = (req.label ?? id).trim() || id;
    const current = this.list();
    if (current.some((p) => p.id.toLowerCase() === id.toLowerCase())) {
      throw new ValidationError(`Project "${id}" already exists`);
    }
    const next = [...current, { id, label }];
    await this.write(next);
    this.bus.publish({ type: "config.updated" });
    return next;
  }

  private async write(projects: ProjectDef[]): Promise<void> {
    const contents = `${JSON.stringify(projects, null, 2)}\n`;
    const tmp = path.join(
      path.dirname(this.env.projectsPath),
      `projects.json.tmp-${nanoid(8)}`,
    );
    await fs.writeFile(tmp, contents, "utf8");
    try {
      await fs.rename(tmp, this.env.projectsPath);
    } catch (err) {
      await fs.rm(tmp, { force: true });
      throw err;
    }
  }
}
