/**
 * Loads and validates board.config.json into a BoardConfig, and exposes derived
 * lookups (value sets, status order, level rank, colors). Cached, with reload().
 */
import { readFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  type BoardConfig,
  STATUS_ORDER,
  LEVEL_RANK,
  type Status,
  type Level,
} from "@AiDailyTasks/shared";
import type { Env } from "./env";

const EnumDefSchema = z.object({
  id: z.string().trim().min(1),
  label: z.string().trim().min(1).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  order: z.number().optional(),
  rank: z.number().optional(),
});

const BoardConfigSchema = z.object({
  idPrefix: z.string(),
  idPad: z.number(),
  statuses: z.array(EnumDefSchema),
  categories: z.array(EnumDefSchema),
  severities: z.array(EnumDefSchema),
  risks: z.array(EnumDefSchema),
  // Projects moved to a local projects.json (see ProjectsService); tolerated here for
  // backward-compat but no longer the source of truth. The /api/config route merges the
  // real list in from ProjectsService.
  projects: z.array(z.object({ id: z.string(), label: z.string() })).optional().default([]),
  card: z.object({ colorBy: z.enum(["category", "severity"]) }),
  skills: z.array(EnumDefSchema).default([]),
  board: z.object({
    completedColumnLimit: z.number().int().min(1).max(500).optional(),
    showBacklogColumn: z.boolean().optional(),
    hiddenColumns: z.array(z.string()).optional(),
  }).optional(),
  navigation: z.object({ hiddenTabs: z.array(z.string()).optional() }).optional(),
  archive: z.object({ autoArchiveDays: z.number() }).optional(),
});

function assertUnique(name: string, ids: string[]): void {
  if (new Set(ids).size !== ids.length || ids.some((id) => !id.trim())) {
    throw new Error(`board.config.json ${name} must use unique, non-empty ids`);
  }
}

function assertProtectedStatuses(ids: string[]): void {
  for (const required of ["Backlog", "Completed"]) {
    if (!ids.includes(required)) throw new Error(`board.config.json statuses must retain protected id: ${required}`);
  }
}

export class ConfigService {
  private config: BoardConfig;
  private statusColors = new Map<string, string>();
  private categoryColors = new Map<string, string>();
  private severityColors = new Map<string, string>();
  private riskColors = new Map<string, string>();
  private statusOrders = new Map<string, number>();

  constructor(private readonly env: Env) {
    this.config = this.loadAndValidate();
  }

  private loadAndValidate(): BoardConfig {
    let raw: string;
    try {
      raw = readFileSync(this.env.configPath, "utf8");
    } catch (err) {
      throw new Error(
        `Failed to read board.config.json at ${this.env.configPath}: ${(err as Error).message}`,
      );
    }
    const parsed = BoardConfigSchema.parse(JSON.parse(raw));

    assertUnique("statuses", parsed.statuses.map((s) => s.id));
    assertUnique("categories", parsed.categories.map((s) => s.id));
    assertUnique("severities", parsed.severities.map((s) => s.id));
    assertUnique("risks", parsed.risks.map((s) => s.id));
    assertUnique("skills", parsed.skills.map((s) => s.id));
    assertProtectedStatuses(parsed.statuses.map((s) => s.id));
    if (!parsed.categories.length || !parsed.severities.length || !parsed.risks.length) {
      throw new Error("board.config.json categories, severities, and risks must not be empty");
    }

    this.statusColors = new Map(parsed.statuses.map((s) => [s.id, s.color]));
    this.categoryColors = new Map(parsed.categories.map((c) => [c.id, c.color]));
    this.severityColors = new Map(parsed.severities.map((s) => [s.id, s.color]));
    this.riskColors = new Map(parsed.risks.map((r) => [r.id, r.color]));
    this.statusOrders = new Map(
      parsed.statuses.map((s, i) => [s.id, s.order ?? i]),
    );
    return parsed;
  }

  reload(): BoardConfig {
    this.config = this.loadAndValidate();
    return this.config;
  }

  async update(input: unknown): Promise<BoardConfig> {
    const parsed = BoardConfigSchema.parse({ ...(input as object), projects: [] });
    const ids = (defs: { id: string }[]) => defs.map((item) => item.id);
    assertUnique("statuses", ids(parsed.statuses));
    assertUnique("categories", ids(parsed.categories));
    assertUnique("severities", ids(parsed.severities));
    assertUnique("risks", ids(parsed.risks));
    assertUnique("skills", ids(parsed.skills));
    assertProtectedStatuses(ids(parsed.statuses));
    if (!parsed.categories.length || !parsed.severities.length || !parsed.risks.length) {
      throw new Error("categories, severities, and risks must not be empty");
    }

    const { projects: _localProjects, ...persisted } = parsed;
    const temp = path.join(
      path.dirname(this.env.configPath),
      `.board.config.tmp-${process.pid}-${Date.now()}`,
    );
    await writeFile(temp, `${JSON.stringify(persisted, null, 2)}\n`, "utf8");
    await rename(temp, this.env.configPath);
    return this.reload();
  }

  get(): BoardConfig {
    return this.config;
  }

  get idPrefix(): string {
    return this.config.idPrefix;
  }
  get idPad(): number {
    return this.config.idPad;
  }
  /** Days after completion before a task is auto-archived (default 14). */
  get autoArchiveDays(): number {
    return this.config.archive?.autoArchiveDays ?? 14;
  }

  statusOrder(status: string): number {
    return this.statusOrders.get(status) ?? STATUS_ORDER[status as Status] ?? 0;
  }
  levelRank(level: string): number {
    return LEVEL_RANK[level as Level] ?? 0;
  }
  statusColor(status: string): string | undefined {
    return this.statusColors.get(status);
  }
  categoryColor(category: string): string | undefined {
    return this.categoryColors.get(category);
  }
  severityColor(severity: string): string | undefined {
    return this.severityColors.get(severity);
  }
  riskColor(risk: string): string | undefined {
    return this.riskColors.get(risk);
  }
}
