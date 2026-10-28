import { renderObservation } from "./observation";
import { ObservationMetadataSchema } from "@AiDailyTasks/shared";
/**
 * Versioned, portable representation for the structured board store.
 *
 * The task document deliberately excludes observations: they live in an
 * append-friendly JSONL file so a growing activity log never requires a task
 * rewrite or a full-history response.
 */
import { createHash } from "node:crypto";
import { nanoid } from "nanoid";
import { z } from "zod";
import {
  FrontmatterSchema,
  type Frontmatter,
  type Observation,
} from "@AiDailyTasks/shared";
import {
  type ParsedBody,
  type ParseResult,
  parseObservations,
  serializeTaskFile,
} from "./task";

/** Canonical filenames of the board's two on-disk task representations. */
export const TASK_MARKDOWN_FILE = "task.md";
export const TASK_JSON_FILE = "task.json";
export const OBSERVATIONS_FILE = "observations.jsonl";

const BodySectionSchema = z.object({
  heading: z.string().trim().min(1),
  content: z.string(),
});

/**
 * A stamp of observations.jsonl as of the last write.
 *
 * The board list needs each task's observation count but must not open a second
 * file per task to get it — on Windows that per-file cost dominates rendering
 * the whole board. `bytes` makes the cached `count` verifiable: a cheap stat
 * confirms the history has not changed since the stamp, and any mismatch falls
 * back to counting for real. So a hand-edited history is slower to read, never
 * wrong.
 */
const HistoryStampSchema = z.object({
  count: z.number().int().min(0),
  bytes: z.number().int().min(0),
  modified_at: z.number().optional(),
});
export type HistoryStamp = z.infer<typeof HistoryStampSchema>;

export const StructuredTaskFileSchema = z.object({
  schemaVersion: z.literal(1),
  frontmatter: FrontmatterSchema,
  body: z.object({
    preamble: z.string().default(""),
    /** All task sections except Observations, which are stored in observations.jsonl. */
    sections: z.array(BodySectionSchema),
  }),
  /** Absent on a task written before stamping existed; then the count is derived. */
  history: HistoryStampSchema.optional(),
});
export type StructuredTaskFile = z.infer<typeof StructuredTaskFileSchema>;

export const StoredObservationSchema = ObservationMetadataSchema.extend({
  id: z.string().regex(/^obs_[A-Za-z0-9_-]+$/),
  at: z.string().min(1),
  author: z.string().min(1),
  markdown: z.string(),
});
export type StoredObservation = z.infer<typeof StoredObservationSchema>;

function observationId(taskId: string, index: number, observation: Observation): string {
  const fingerprint = `${taskId}\u0000${index}\u0000${observation.at}\u0000${observation.author}\u0000${observation.markdown}`;
  return `obs_${createHash("sha256").update(fingerprint).digest("base64url").slice(0, 18)}`;
}

/**
 * Identifier for an observation created after migration. Migrated entries derive
 * a stable id from their content instead, so re-running the converter on the same
 * Markdown always produces byte-identical output.
 */
export function newObservationId(): string {
  return `obs_${nanoid(18)}`;
}

/** Convert a parsed legacy task into canonical structured files without losing custom sections. */
export function structuredFromLegacy(parsed: Extract<ParseResult, { ok: true }>): {
  task: StructuredTaskFile;
  observations: StoredObservation[];
} {
  const observationSection = parsed.parsed.sections.find((section) => section.heading === "Observations");
  const observations = parseObservations(observationSection?.content ?? "").map((observation, index) => ({
    ...observation,
    id: observation.id ?? observationId(parsed.frontmatter.id, index, observation),
  }));
  return {
    task: {
      schemaVersion: 1,
      frontmatter: parsed.frontmatter,
      body: {
        preamble: parsed.parsed.preamble,
        sections: parsed.parsed.sections.filter((section) => section.heading !== "Observations"),
      },
      history: historyStamp(serializeObservationJsonl(observations), observations.length),
    },
    observations,
  };
}

export function serializeStructuredTask(task: StructuredTaskFile): string {
  return `${JSON.stringify(task, null, 2)}\n`;
}

export function serializeObservationJsonl(observations: readonly StoredObservation[]): string {
  return observations.length === 0 ? "" : `${observations.map((observation) => JSON.stringify(observation)).join("\n")}\n`;
}

/** The stamp describing a history file with exactly these observations in it. */
export function historyStamp(serializedJsonl: string, count: number): HistoryStamp {
  return { count, bytes: Buffer.byteLength(serializedJsonl, "utf8") };
}

export function parseStructuredTask(raw: string): StructuredTaskFile {
  return StructuredTaskFileSchema.parse(JSON.parse(raw));
}

export function parseObservationJsonl(raw: string): StoredObservation[] {
  if (!raw.trim()) return [];
  return raw
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => StoredObservationSchema.parse(JSON.parse(line)));
}

/** Render the structured representation back to the established Markdown export format. */
export function renderStructuredTaskMarkdown(task: StructuredTaskFile, observations: StoredObservation[]): string {
  const body: ParsedBody = {
    preamble: task.body.preamble,
    sections: [
      ...task.body.sections,
      {
        heading: "Observations",
        content: observations
          .map(renderObservation)
          .join("\n\n"),
      },
    ],
  };
    const frontmatter = { ...task.frontmatter };
    if (frontmatter.status_detail_updated_at) {
      frontmatter.observation_fingerprint = createHash("sha256")
        .update(body.sections.at(-1)!.content.trim()).digest("hex");
    }
    return serializeTaskFile(frontmatter as Frontmatter, body);
}
