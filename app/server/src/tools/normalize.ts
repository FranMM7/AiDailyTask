/**
 * Field normalizers: category / severity / risk / status / dates.
 * Maps are exactly as specified by the import brief.
 */
import { CATEGORIES, LEVELS, STATUSES } from "@AiDailyTaks/shared";
import type { Category, Level, Status } from "@AiDailyTaks/shared";

export interface Warning {
  id: string;
  field: string;
  message: string;
}

export function normalizeCategory(raw: string, id: string, warnings: Warning[]): Category {
  const t = raw.trim();
  const hit = CATEGORIES.find((c) => c.toLowerCase() === t.toLowerCase());
  if (hit) return hit;
  warnings.push({ id, field: "category", message: `unknown category "${t}" — passed through as-is` });
  // Pass through by best effort; keep the raw label but typed as Category.
  return (t || "Refactor") as Category;
}

/** Preprocess a level cell already stripped of struck spans (delete-aware text). */
export function normalizeLevel(text: string, id: string, field: string, warnings: Warning[]): Level {
  const cleaned = text
    .replace(/\*\*/g, "")
    .replace(/`/g, "")
    .toLowerCase()
    .replace(/[—–-]+/g, "-")
    .trim();
  const map: Record<string, Level> = {
    low: "Low",
    "low-med": "Low–Med",
    "low-medium": "Low–Med",
    med: "Medium",
    medium: "Medium",
    "med-high": "Med–High",
    "medium-high": "Med–High",
    high: "High",
  };
  const hit = map[cleaned];
  if (hit) return hit;
  warnings.push({ id, field, message: `unrecognized level "${text}" (cleaned "${cleaned}") — defaulted to Medium` });
  return "Medium";
}

const CLOSE_WORDS = ["done", "complete", "completed", "closed", "shipped", "fixed", "validated"];
const FLAG_WORDS: Array<{ re: RegExp; flag: string }> = [
  { re: /awaiting[^.;]*\bvs\b|awaiting\s+vs\s+build|awaiting\s+build/i, flag: "awaiting-vs-build" },
  { re: /apply\s+in\s+vs/i, flag: "apply-in-vs" },
  { re: /\bparked\b/i, flag: "parked" },
  { re: /\bpending\b/i, flag: "pending" },
];

export interface StatusResult {
  status: Status;
  statusDetail: string;
  flags: string[];
}

/**
 * Normalize a status cell. `text` is the delete-aware plain text of the cell.
 * Base verb from the leading token (before the first em/en dash); clause after
 * the first dash goes to status_detail; flags recorded too.
 */
export function normalizeStatus(text: string, id: string, warnings: Warning[]): StatusResult {
  const full = text.trim();
  const dashIdx = full.search(/[—–]/);
  const head = (dashIdx === -1 ? full : full.slice(0, dashIdx)).toLowerCase();
  let statusDetail = dashIdx === -1 ? "" : full.slice(dashIdx + 1).trim();

  const flags: string[] = [];
  for (const { re, flag } of FLAG_WORDS) if (re.test(full)) flags.push(flag);

  const headHasClose = CLOSE_WORDS.some((w) => new RegExp(`\\b${w}\\b`).test(head));

  let status: Status;
  if (headHasClose) {
    status = "Completed";
  } else if (/\bnot started\b/.test(head)) {
    status = "Not started";
  } else if (/\bscoped\b|\bdesigned\b/.test(head)) {
    status = "Scoped";
  } else if (/\bin progress\b|\bwip\b/.test(head)) {
    status = "In progress";
  } else if (/\bimplemented\b|\bawaiting\b|\bapply\s+in\s+vs\b|\bparked\b|\bpending\b/.test(head)) {
    status = "In progress";
  } else {
    warnings.push({ id, field: "status", message: `could not classify status head "${head.trim()}" — defaulted to In progress` });
    status = "In progress";
  }

  // Ensure flags are represented in the free-text detail.
  const missing = flags.filter((f) => !statusDetail.toLowerCase().includes(f.replace(/-/g, " ").replace("vs", "vs")));
  if (missing.length && !statusDetail) statusDetail = missing.join("; ");

  return { status, statusDetail, flags };
}

const DATE_RE = /\b(20\d{2}-\d{2}-\d{2})\b/g;

export function allDates(text: string): string[] {
  return [...text.matchAll(DATE_RE)].map((m) => m[1]);
}

export interface DateResult {
  created?: string;
  updated?: string;
  completed?: string;
}

/**
 * Derive created/updated/completed. The status + details cells are primary;
 * the detail body is folded in so tasks whose only dates live in the write-up
 * (e.g. C1) still get created/updated/completed.
 */
export function deriveDates(
  statusText: string,
  detailsText: string,
  bodyText: string,
  status: Status,
): DateResult {
  const combined = `${statusText}\n${detailsText}\n${bodyText}`;
  const dates = allDates(combined);
  const sorted = [...new Set(dates)].sort();
  const res: DateResult = {};
  if (sorted.length) {
    res.updated = sorted[sorted.length - 1];
  }

  // created: first "Logged <date>" / "New (<date>)" else min
  const logged = /(?:Logged|New)\s*\(?\s*(20\d{2}-\d{2}-\d{2})/i.exec(combined);
  if (logged) res.created = logged[1];
  else if (sorted.length) res.created = sorted[0];

  if (status === "Completed") {
    res.completed = closeDate(combined) ?? (sorted.length ? sorted[sorted.length - 1] : undefined);
  }
  return res;
}

/** A date adjacent (within a short window) to a close verb, latest wins. */
function closeDate(text: string): string | undefined {
  const verbs = "Closed|Completed|Complete|Done|Shipped|Fixed|Validated|Committed|committed";
  const after = new RegExp(`\\b(?:${verbs})\\b[^.]{0,40}?(20\\d{2}-\\d{2}-\\d{2})`, "g");
  const before = new RegExp(`(20\\d{2}-\\d{2}-\\d{2})[^.]{0,20}?\\b(?:${verbs})\\b`, "g");
  const hits: string[] = [];
  for (const m of text.matchAll(after)) hits.push(m[1]);
  for (const m of text.matchAll(before)) hits.push(m[1]);
  if (!hits.length) return undefined;
  return [...new Set(hits)].sort().at(-1);
}
