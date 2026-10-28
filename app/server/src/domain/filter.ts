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
  idNum,
} from "@AiDailyTasks/shared";

function isValid(t: TaskSummaryOrInvalid): t is TaskSummary {
  return t.valid === true;
}

function hasNarrowingFilter(f: TaskFilter): boolean {
  return Boolean(
    f.priority?.length || f.has_next_action !== undefined || f.action_undated !== undefined || f.next_action_owner !== undefined || f.next_action_date_from || f.next_action_date_to || f.project ||
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

  if (f.priority?.length && !f.priority.includes(t.priority)) return false;
  if (f.has_next_action !== undefined && f.has_next_action !== !!t.next_action) return false;
  if (f.next_action_owner !== undefined && (t.next_action?.owner ?? "").toLowerCase() !== f.next_action_owner.toLowerCase()) return false;
  if (f.action_undated && (!t.next_action || t.next_action.due_date)) return false;
  if ((f.next_action_date_from || f.next_action_date_to) && (!t.next_action?.due_date || f.next_action_date_from && t.next_action.due_date < f.next_action_date_from || f.next_action_date_to && t.next_action.due_date > f.next_action_date_to)) return false;
  if ((f.has_next_action || f.action_undated || f.next_action_owner !== undefined || f.next_action_date_from || f.next_action_date_to) && !f.include_closed && ["Completed","Cancelled"].includes(t.status)) return false;
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
      return a.category.localeCompare(b.category);
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

export function applyFilter(items: TaskSummaryOrInvalid[], f: TaskFilter, priorityRank: (value:string)=>number = () => 2): TaskSummaryOrInvalid[] {
  const valids = items.filter(isValid);
  const invalids = items.filter((t): t is Exclude<TaskSummaryOrInvalid, TaskSummary> => !t.valid);

  const filtered = valids.filter((t) => matches(t, f));
  filtered.sort((a, b) => {
    if(f.sort === "priority") return (priorityRank(a.priority)-priorityRank(b.priority))*(f.order === "desc" ? -1 : 1) || (a.next_action?.due_date ?? "9999").localeCompare(b.next_action?.due_date ?? "9999") || idNum(a.id)-idNum(b.id);
    const c=compare(a,b,f.sort);
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
