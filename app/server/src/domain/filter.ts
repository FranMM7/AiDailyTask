/**
 * Filter + sort task summaries for GET /api/tasks.
 *
 * Invalid tasks (failed frontmatter) can't be matched on fields; they are only
 * included when NO narrowing filter is active, and are appended (sorted by id)
 * after the valid, sorted results so the board always surfaces broken files.
 */
import {
  type TaskSummary,
  type TaskSummaryOrInvalid,
  type TaskFilter,
  STATUS_ORDER,
  LEVEL_RANK,
  CATEGORIES,
  idNum,
} from "@AiDailyTasks/shared";

function isValid(t: TaskSummaryOrInvalid): t is TaskSummary {
  return t.valid === true;
}

function hasNarrowingFilter(f: TaskFilter): boolean {
  return Boolean(
    f.project ||
      (f.status && f.status.length) ||
      (f.category && f.category.length) ||
      (f.severity && f.severity.length) ||
      f.tag ||
      (f.q && f.q.trim()) ||
      (f.dateField && (f.dateFrom || f.dateTo)) ||
      f.archived === "only",
  );
}

/** The YYYY-MM-DD value of the date field a range filter is testing. */
function dateFieldValue(t: TaskSummary, field: NonNullable<TaskFilter["dateField"]>): string {
  const raw =
    field === "created" ? t.created : field === "completed" ? t.completed : t.updatedEffective;
  return (raw ?? "").slice(0, 10);
}

function matches(t: TaskSummary, f: TaskFilter): boolean {
  // Archived visibility (default "exclude" keeps archived tasks off the main views).
  const archived = f.archived ?? "exclude";
  if (archived === "exclude" && t.archived) return false;
  if (archived === "only" && !t.archived) return false;

  if (f.project && t.project !== f.project) return false;
  if (f.status && f.status.length && !f.status.includes(t.status)) return false;
  if (f.category && f.category.length && !f.category.includes(t.category)) return false;
  if (f.severity && f.severity.length && !f.severity.includes(t.severity)) return false;
  if (f.tag && !t.tags.includes(f.tag)) return false;
  if (f.q && f.q.trim()) {
    const needle = f.q.trim().toLowerCase();
    const hay = `${t.id} ${t.title} ${t.status_detail} ${t.excerpt}`.toLowerCase();
    if (!hay.includes(needle)) return false;
  }
  if (f.dateField && (f.dateFrom || f.dateTo)) {
    const day = dateFieldValue(t, f.dateField);
    if (!day) return false; // no value in the chosen field → excluded while a range is active
    if (f.dateFrom && day < f.dateFrom) return false;
    if (f.dateTo && day > f.dateTo) return false;
  }
  return true;
}

function compare(a: TaskSummary, b: TaskSummary, sort: TaskFilter["sort"]): number {
  switch (sort) {
    case "title":
      return a.title.localeCompare(b.title);
    case "status":
      return (STATUS_ORDER[a.status] ?? 0) - (STATUS_ORDER[b.status] ?? 0);
    case "severity":
      return (LEVEL_RANK[a.severity] ?? 0) - (LEVEL_RANK[b.severity] ?? 0);
    case "risk":
      return (LEVEL_RANK[a.risk] ?? 0) - (LEVEL_RANK[b.risk] ?? 0);
    case "category":
      return CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category);
    case "project":
      return a.project.localeCompare(b.project);
    case "updated":
      return Date.parse(a.updatedEffective) - Date.parse(b.updatedEffective);
    case "created":
      return Date.parse(a.created ?? "") - Date.parse(b.created ?? "") || idNum(a.id) - idNum(b.id);
    case "completed":
      return Date.parse(a.completed ?? "") - Date.parse(b.completed ?? "") || idNum(a.id) - idNum(b.id);
    case "id":
    default:
      return idNum(a.id) - idNum(b.id);
  }
}

export function applyFilter(items: TaskSummaryOrInvalid[], f: TaskFilter): TaskSummaryOrInvalid[] {
  const valids = items.filter(isValid);
  const invalids = items.filter((t): t is Exclude<TaskSummaryOrInvalid, TaskSummary> => !t.valid);

  const filtered = valids.filter((t) => matches(t, f));
  filtered.sort((a, b) => {
    const c = compare(a, b, f.sort);
    return f.order === "desc" ? -c : c;
  });

  if (hasNarrowingFilter(f)) return filtered;

  invalids.sort((a, b) => {
    const an = idNum(a.id);
    const bn = idNum(b.id);
    if (Number.isNaN(an) || Number.isNaN(bn)) return a.id.localeCompare(b.id);
    return an - bn;
  });
  return [...filtered, ...invalids];
}
