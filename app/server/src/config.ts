/**
 * Loads and validates board.config.json into a BoardConfig, and exposes derived
 * lookups (value sets, status order, level rank, colors). Cached, with reload().
 */
import { readFileSync } from "node:fs";
import { z } from "zod";
import {
  type BoardConfig,
  STATUSES,
  CATEGORIES,
  LEVELS,
  STATUS_ORDER,
  LEVEL_RANK,
  type Status,
  type Level,
} from "@AiDailyTaks/shared";
import type { Env } from "./env";

const EnumDefSchema = z.object({
  id: z.string(),
  label: z.string().optional(),
  color: z.string(),
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
  board: z.object({ completedColumnLimit: z.number().optional() }).optional(),
  archive: z.object({ autoArchiveDays: z.number() }).optional(),
});

function assertCovers(name: string, ids: string[], canonical: readonly string[]): void {
  const set = new Set(ids);
  const missing = canonical.filter((v) => !set.has(v));
  if (missing.length > 0) {
    throw new Error(
      `board.config.json ${name} is missing canonical values: ${missing.join(", ")}`,
    );
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

    // Validate the config's vocabulary against the frozen contract.
    assertCovers("statuses", parsed.statuses.map((s) => s.id), STATUSES);
    assertCovers("categories", parsed.categories.map((c) => c.id), CATEGORIES);
    assertCovers("severities", parsed.severities.map((s) => s.id), LEVELS);
    assertCovers("risks", parsed.risks.map((r) => r.id), LEVELS);

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
