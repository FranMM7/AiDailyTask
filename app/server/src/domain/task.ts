/**
 * The heart of the persistence format: parse + serialize task.md, and build the
 * contract DTOs. task.md = YAML frontmatter (via gray-matter/js-yaml) + a markdown
 * body split into "## Summary", "## Scope", "## Observations" (and any other
 * sections, which are preserved verbatim).
 */
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
    out.push({
      at: m[1],
      author: m[2].trim(),
      markdown: sectionContent.slice(start, end).replace(/^\n+|\n+$/g, ""),
    });
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
];

const OPTIONAL_DATE_KEYS = new Set<keyof Frontmatter>(["created", "updated", "completed", "archived_at"]);

function orderedFrontmatter(fm: Frontmatter): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  for (const key of KEY_ORDER) {
    const value = fm[key];
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
    excerpt: excerpt(excerptSource),
    attachmentCount: args.attachmentCount,
    observationCount: args.observationCount,
    updatedEffective: updatedEffective(args.fm.updated, args.rev),
  };
}

export function toTaskDetail(args: {
  fm: Frontmatter;
  rev: number;
  parsed: ParsedBody;
  rawBody: string;
  attachments: Attachment[];
}): TaskDetail {
  return {
    ...args.fm,
    rev: args.rev,
    valid: true,
    summaryMarkdown: getSection(args.parsed, "Summary"),
    scopeMarkdown: getSection(args.parsed, "Scope"),
    observations: parseObservations(getSection(args.parsed, "Observations")),
    attachments: args.attachments,
    rawBody: args.rawBody,
    updatedEffective: updatedEffective(args.fm.updated, args.rev),
  };
}
