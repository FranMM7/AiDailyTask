/**
 * task.md rendering: deterministic frontmatter (fixed key order) + body.
 */
import yaml from "js-yaml";
import type { Frontmatter } from "@AiDailyTasks/shared";

/** Emit frontmatter with the exact FrontmatterSchema key order. */
export function dumpFrontmatter(fm: Frontmatter): string {
  const obj: Record<string, unknown> = {};
  obj.id = fm.id;
  obj.title = fm.title;
  obj.project = fm.project;
  obj.category = fm.category;
  obj.severity = fm.severity;
  obj.risk = fm.risk;
  obj.status = fm.status;
  obj.status_detail = fm.status_detail;
  if (fm.created) obj.created = fm.created;
  if (fm.updated) obj.updated = fm.updated;
  if (fm.completed) obj.completed = fm.completed;
  obj.tags = fm.tags;
  obj.depends_on = fm.depends_on;
  obj.blocks = fm.blocks;
  obj.relates_to = fm.relates_to;
  obj.parent = fm.parent ?? null;
  obj.children = fm.children;
  obj.sources = fm.sources;
  const body = yaml.dump(obj, { lineWidth: -1, quotingType: '"', forceQuotes: false, noRefs: true });
  return `---\n${body}---\n`;
}

const NO_DETAIL = "_No detail section in source._";

export interface BodyParts {
  summaryMd: string;
  scopeMd: string;
  /** deterministic ISO-8601 UTC for the single migration observation. */
  migrationTs: string;
}

export function buildBody(parts: BodyParts): string {
  const summary = parts.summaryMd.trim() || "_No summary in source._";
  const scope = parts.scopeMd.trim() || NO_DETAIL;
  return (
    `## Summary\n\n${summary}\n\n` +
    `## Scope\n\n${scope}\n\n` +
    `## Observations\n\n` +
    `### ${parts.migrationTs} — claude\n\n` +
    `Migrated from the source audit document.\n`
  );
}

export function buildTaskMd(fm: Frontmatter, body: string): string {
  return `${dumpFrontmatter(fm)}\n${body}`;
}

export const NO_DETAIL_PLACEHOLDER = NO_DETAIL;
