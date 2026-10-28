/**
 * The heart of the persistence format: parse + serialize task.md, and build the
 * contract DTOs. task.md = YAML frontmatter (via gray-matter/js-yaml) + a markdown
 * body split into "## Summary", "## Scope", "## Observations" (and any other
 * sections, which are preserved verbatim).
 */
import { decodeObservationMetadata, legacyObservationId } from "./observation";
import { statusFreshness } from "@AiDailyTasks/shared";
import matter from "gray-matter";
import yaml from "js-yaml";
import {
  FrontmatterSchema,
  type Frontmatter,
  type Observation,
  type Attachment,
  type TaskSummary,
  type TaskDetail,
} from "@AiDailyTasks/shared";

// ── Body model ───────────────────────────────────────────────────────────────
export interface BodySection {
  /** heading text without the leading "## " */
  heading: string;
  content: string;
}
export interface ParsedBody {
  /** content before the first "## " heading (usually empty) */
  preamble: string;
  sections: BodySection[];
}

/** Split a markdown body on level-2 (`## `) headings. `### ` etc. stay in content. */
export function parseBody(body: string): ParsedBody {
  const lines = body.split(/\r?\n/);
  const headingRe = /^##[ \t]+(.+?)[ \t]*$/;
  const preambleLines: string[] = [];
  const sections: BodySection[] = [];
  let current: { heading: string; lines: string[] } | null = null;

  for (const line of lines) {
    const m = headingRe.exec(line);
    if (m && !line.startsWith("###")) {
      if (current) sections.push({ heading: current.heading, content: current.lines.join("\n") });
      current = { heading: m[1], lines: [] };
    } else if (current) {
      current.lines.push(line);
    } else {
      preambleLines.push(line);
    }
  }
  if (current) sections.push({ heading: current.heading, content: current.lines.join("\n") });

  return {
    preamble: preambleLines.join("\n").trim(),
    sections: sections.map((s) => ({ heading: s.heading, content: s.content.replace(/^\n+|\n+$/g, "") })),
  };
}

export function getSection(pb: ParsedBody, heading: string): string {
  const found = pb.sections.find((s) => s.heading.toLowerCase() === heading.toLowerCase());
  return found ? found.content : "";
}

/** Replace (or append, if absent) a named section's content. Returns a new ParsedBody. */
export function setSection(pb: ParsedBody, heading: string, content: string): ParsedBody {
  const sections = pb.sections.map((s) => ({ ...s }));
  const idx = sections.findIndex((s) => s.heading.toLowerCase() === heading.toLowerCase());
  const clean = content.replace(/^\n+|\n+$/g, "");
  if (idx >= 0) {
    sections[idx].content = clean;
  } else {
    sections.push({ heading, content: clean });
  }
  return { preamble: pb.preamble, sections };
}

export function serializeBody(pb: ParsedBody): string {
  const parts: string[] = [];
  if (pb.preamble.trim().length > 0) parts.push(pb.preamble.trim());
  for (const s of pb.sections) {
    const content = s.content.replace(/^\n+|\n+$/g, "");
    parts.push(content.length > 0 ? `## ${s.heading}\n\n${content}` : `## ${s.heading}`);
  }
  return parts.join("\n\n");
}

// ── Observations ──────────────────────────────────────────────────────────────
const OBS_HEADER_RE = /^###[ \t]+(\S+)[ \t]+[—–-][ \t]+(.+?)[ \t]*$/gm;

export function parseObservations(sectionContent: string): Observation[] {
  if (!sectionContent.trim()) return [];
  const matches = [...sectionContent.matchAll(OBS_HEADER_RE)];
  const out: Observation[] = [];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const start = (m.index ?? 0) + m[0].length;
    const end = i + 1 < matches.length ? (matches[i + 1].index ?? sectionContent.length) : sectionContent.length;
    const observation: Observation = {
      at: m[1],
      author: m[2].trim(),
      ...decodeObservationMetadata(sectionContent.slice(start, end).replace(/^\n+|\n+$/g, "")),
    };
    observation.id ??= legacyObservationId(observation, i);
    out.push(observation);
  }
  return out;
}

// ── Parse / serialize a full task.md ──────────────────────────────────────────
export type ParseResult =
  | { ok: true; frontmatter: Frontmatter; body: string; parsed: ParsedBody }
  | { ok: false; error: string; rawFrontmatter?: string; rawBody?: string };

export function parseTaskFile(raw: string): ParseResult {
  let file: matter.GrayMatterFile<string>;
  try {
    file = matter(raw, {
      engines: {
        yaml: {
          parse: (s: string) => (yaml.load(s, { schema: yaml.JSON_SCHEMA }) as object) ?? {},
          stringify: () => {
            throw new Error("gray-matter stringify is not used");
          },
        },
      },
    });
  } catch (err) {
    return { ok: false, error: `YAML parse error: ${(err as Error).message}`, rawBody: raw };
  }

  const res = FrontmatterSchema.safeParse(file.data);
  if (!res.success) {
    const error = res.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`).join("; ");
    return { ok: false, error, rawFrontmatter: file.matter ?? "", rawBody: file.content };
  }
  return { ok: true, frontmatter: res.data, body: file.content, parsed: parseBody(file.content) };
}

const KEY_ORDER: readonly (keyof Frontmatter)[] = [
  "id",
  "title",
  "project",
  "category",
  "severity",
  "risk",
  "status",
  "status_detail",
  "status_detail_updated_at",
  "status_detail_fingerprint",
  "observation_fingerprint",
  "latest_note_at",
  "priority",
  "next_action",
  "communications",
  "blocker",
  "blocked_since",
  "created",
  "updated",
  "completed",
  "archived",
  "archived_at",
  "tags",
  "skills",
  "recurring",
  "recurrence_of",
  "depends_on",
  "blocks",
  "relates_to",
  "parent",
  "children",
  "sources",
  "resources",
];

const OPTIONAL_DATE_KEYS = new Set<keyof Frontmatter>(["created", "updated", "completed", "archived_at"]);

function orderedFrontmatter(fm: Frontmatter): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  for (const key of KEY_ORDER) {
    const value = fm[key];
    if (value === undefined) continue;
    if (key === "archived") {
      // Boolean flag; only persisted when true so active tasks stay unchanged.
      if (value === true) o[key] = true;
    } else if (key === "recurrence_of") {
      if (value) o[key] = value;
    } else if (OPTIONAL_DATE_KEYS.has(key)) {
      if (value !== undefined && value !== null && value !== "") o[key] = value;
    } else {
      o[key] = value ?? null;
    }
  }
  return o;
}

export function dumpFrontmatter(fm: Frontmatter): string {
  return yaml.dump(orderedFrontmatter(fm), {
    schema: yaml.JSON_SCHEMA,
    lineWidth: -1,
    noRefs: true,
    sortKeys: false,
  });
}

/** Produce canonical task.md text: fixed-order YAML frontmatter + markdown body. */
export function serializeTaskFile(fm: Frontmatter, body: ParsedBody | string): string {
  const yamlStr = dumpFrontmatter(fm);
  const bodyStr = (typeof body === "string" ? body : serializeBody(body)).replace(/^\n+/, "").trimEnd();
  return `---\n${yamlStr}---\n\n${bodyStr}\n`;
}

// ── DTO builders ──────────────────────────────────────────────────────────────
/** updatedEffective = max(frontmatter.updated, file mtime) as ISO-8601. */
export function updatedEffective(updated: string | undefined, mtimeMs: number): string {
  const mtimeIso = new Date(mtimeMs).toISOString();
  if (!updated) return mtimeIso;
  const parsed = Date.parse(updated);
  if (Number.isNaN(parsed)) return mtimeIso;
  return parsed >= mtimeMs ? new Date(parsed).toISOString() : mtimeIso;
}

/** Strip markdown to ~`max` chars of plain text for card excerpts. */
export function excerpt(md: string, max = 200): string {
  const stripped = md
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}[ \t]+/gm, "")
    .replace(/[*_~>#]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return stripped.length <= max ? stripped : `${stripped.slice(0, max).trimEnd()}…`;
}

export function toTaskSummary(args: {
  fm: Frontmatter;
  rev: number;
  summaryMarkdown: string;
  scopeMarkdown: string;
  attachmentCount: number;
  observationCount: number;
}): TaskSummary {
  const excerptSource = args.summaryMarkdown.trim() || args.scopeMarkdown.trim();
  return {
    ...args.fm,
    rev: args.rev,
    valid: true,
    communications: [],
    status_freshness: statusFreshness(args.fm),
    communication_counts: { draft: args.fm.communications.filter(c => c.state === "draft").length, awaiting_reply: args.fm.communications.filter(c => c.state === "sent" && c.awaiting_reply).length },
    excerpt: excerpt(excerptSource),
    attachmentCount: args.attachmentCount,
    observationCount: args.observationCount,
    updatedEffective: updatedEffective(args.fm.updated, args.rev),
  };
}

/**
 * Build the detail DTO from an already-resolved observation page.
 *
 * Observations are passed in rather than parsed out of the body so a structured
 * task never has to materialize its history to answer a detail request; the
 * Markdown path resolves its page first and calls the same builder.
 */
export function buildTaskDetail(args: {
  fm: Frontmatter;
  rev: number;
  summaryMarkdown: string;
  scopeMarkdown: string;
  qaMarkdown: string;
  verificationMarkdown?: string;
  /** The newest page (oldest-to-newest within the page), or the whole history. */
  observations: Observation[];
  /** Length of the complete history, not of the page above. */
  observationCount: number;
  attachments: Attachment[];
  resourceFiles?: Attachment[];
  rawBody: string;
  paged: boolean;
}): TaskDetail {
  return {
    ...args.fm,
    rev: args.rev,
    valid: true,
    status_freshness: statusFreshness(args.fm),
    communications: [],
    communication_count: args.fm.communications.length,
    communication_counts: {draft:args.fm.communications.filter(c=>c.state === "draft").length,awaiting_reply:args.fm.communications.filter(c=>c.state === "sent" && c.awaiting_reply).length},
    summary: args.summaryMarkdown, scope: args.scopeMarkdown, qa: args.qaMarkdown, verification: args.verificationMarkdown ?? "",
    verificationMarkdown: args.verificationMarkdown ?? "",
    summaryMarkdown: args.summaryMarkdown,
    scopeMarkdown: args.scopeMarkdown,
    qaMarkdown: args.qaMarkdown,
    observations: args.observations,
    observationCount: args.observationCount,
    nextObservationCursor:
      args.paged && args.observationCount > args.observations.length
        ? String(args.observationCount - args.observations.length)
        : null,
    attachments: args.attachments,
    resourceFiles: args.resourceFiles ?? [],
    // Valid task views consume the structured section fields above. Do not duplicate
    // the complete Markdown body (and its full observation history) in paged API
    // responses; rawBody is only needed for internal full reads / invalid diagnostics.
    rawBody: args.paged ? "" : args.rawBody,
    updatedEffective: updatedEffective(args.fm.updated, args.rev),
  };
}

/** Markdown-shaped convenience wrapper: split the history out of the body first. */
export function toTaskDetail(args: {
  fm: Frontmatter;
  rev: number;
  parsed: ParsedBody;
  rawBody: string;
  attachments: Attachment[];
  resourceFiles?: Attachment[];
  /** Omit to include the complete history (exports and internal callers). */
  observationLimit?: number;
}): TaskDetail {
  const all = parseObservations(getSection(args.parsed, "Observations"));
  const limit = args.observationLimit;
  return buildTaskDetail({
    fm: args.fm,
    rev: args.rev,
    summaryMarkdown: getSection(args.parsed, "Summary"),
    scopeMarkdown: getSection(args.parsed, "Scope"),
    qaMarkdown: getSection(args.parsed, "QA"),
    verificationMarkdown: getSection(args.parsed, "Verification evidence"),
    observations: limit === undefined ? all : all.slice(-Math.max(1, limit)),
    observationCount: all.length,
    attachments: args.attachments,
    resourceFiles: args.resourceFiles,
    rawBody: args.rawBody,
    paged: limit !== undefined,
  });
}
