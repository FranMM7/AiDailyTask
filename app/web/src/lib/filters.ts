import {
  STATUSES,
  CATEGORIES,
  LEVELS,
  type TaskFilter,
  type Status,
  type Category,
  type Level,
} from "@AiDailyTaks/shared";

const SORT_VALUES = [
  "id",
  "title",
  "status",
  "severity",
  "risk",
  "category",
  "updated",
  "created",
  "completed",
  "project",
] as const;
type SortValue = (typeof SORT_VALUES)[number];

const DATE_FIELDS = ["created", "updated", "completed"] as const;
type DateField = (typeof DATE_FIELDS)[number];

function pick<T extends string>(values: string[], allowed: readonly T[]): T[] {
  const set = allowed as readonly string[];
  return values.filter((v): v is T => set.includes(v));
}

/** Read a TaskFilter out of the URL search params (the single source of view state). */
export function readFilter(sp: URLSearchParams): TaskFilter {
  const status = pick<Status>(sp.getAll("status"), STATUSES);
  const category = pick<Category>(sp.getAll("category"), CATEGORIES);
  const severity = pick<Level>(sp.getAll("severity"), LEVELS);

  const sortRaw = sp.get("sort");
  const sort: SortValue = (SORT_VALUES as readonly string[]).includes(sortRaw ?? "")
    ? (sortRaw as SortValue)
    : "id";
  const order = sp.get("order") === "desc" ? "desc" : "asc";

  const project = sp.get("project") ?? undefined;
  const tag = sp.get("tag") ?? undefined;
  const q = sp.get("q") ?? undefined;

  const archivedRaw = sp.get("archived");
  const archived: TaskFilter["archived"] =
    archivedRaw === "only" || archivedRaw === "include" ? archivedRaw : "exclude";

  const dateFieldRaw = sp.get("dateField");
  const dateField = (DATE_FIELDS as readonly string[]).includes(dateFieldRaw ?? "")
    ? (dateFieldRaw as DateField)
    : undefined;
  const dateFrom = sp.get("dateFrom") || undefined;
  const dateTo = sp.get("dateTo") || undefined;

  return {
    project: project && project !== "All" ? project : undefined,
    status: status.length ? status : undefined,
    category: category.length ? category : undefined,
    severity: severity.length ? severity : undefined,
    tag,
    q,
    dateField,
    dateFrom,
    dateTo,
    archived,
    sort,
    order,
  };
}

/** Toggle a repeatable multi-select param value, returning a new URLSearchParams. */
export function toggleParam(sp: URLSearchParams, key: string, value: string): URLSearchParams {
  const existing = sp.getAll(key);
  const next = new URLSearchParams(sp);
  next.delete(key);
  const remaining = existing.includes(value)
    ? existing.filter((v) => v !== value)
    : [...existing, value];
  for (const v of remaining) next.append(key, v);
  return next;
}

/** Set (or clear, when value is empty/undefined) a single-valued param; returns a new URLSearchParams. */
export function setParam(
  sp: URLSearchParams,
  key: string,
  value: string | undefined,
): URLSearchParams {
  const next = new URLSearchParams(sp);
  if (value && value.length) next.set(key, value);
  else next.delete(key);
  return next;
}
