import { z } from "zod";

export const CalendarDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(
  value => !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value,
  "Use a real calendar date (YYYY-MM-DD)",
);
export const TimestampSchema = z.string().datetime({ offset: true });
export const NextActionSchema = z.object({
  text: z.string().trim().min(1).max(600),
  owner: z.string().trim().max(120).nullable().default(null),
  due_date: CalendarDateSchema.nullable().default(null),
}).strict();
export type NextAction = z.infer<typeof NextActionSchema>;
export const VerificationSchema = z.enum(["verified", "unverified", "assumption"]);
export const ObservationMetadataSchema = z.object({
  id: z.string().regex(/^obs_[A-Za-z0-9_-]+$/).optional(),
  recorded_at: TimestampSchema.optional(),
  kind: z.enum(["note", "system"]).optional(),
  verification: VerificationSchema.optional(),
  verification_evidence: z.string().max(100_000).optional(),
  changes: z.record(z.object({ before: z.unknown(), after: z.unknown() })).optional(),
  event: z.string().optional(),
  started_at: TimestampSchema.nullable().optional(),
  resolved_at: TimestampSchema.nullable().optional(),
});
export const CommunicationFieldsSchema = z.object({
  to: z.string().trim().min(1).max(200),
  channel: z.string().trim().min(1).max(80),
  subject: z.string().trim().min(1).max(300),
  body: z.string().max(100_000).default(""),
  state: z.enum(["draft", "sent", "replied", "cancelled"]).default("draft"),
  sent_at: TimestampSchema.nullable().default(null),
  replied_at: TimestampSchema.nullable().default(null),
  awaiting_reply: z.boolean().default(false),
  reference_url: z.string().url().refine(v => /^https?:\/\//i.test(v), "Use an HTTP(S) URL").nullable().default(null),
}).strict();
export const CommunicationSchema = CommunicationFieldsSchema.extend({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
  created_at: TimestampSchema,
  updated_at: TimestampSchema,
  creation_fingerprint: z.string().optional(),
}).superRefine((item, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: "custom", message });
  if (item.state === "draft" && (item.sent_at || item.replied_at || item.awaiting_reply)) issue("A draft cannot have send/reply dates or await a reply");
  if ((item.state === "sent" || item.state === "replied") && !item.sent_at) issue("Sent items require sent_at");
  if (item.state === "replied" && (!item.replied_at || item.awaiting_reply)) issue("A reply requires replied_at and clears awaiting_reply");
  if (item.state === "sent" && item.replied_at) issue("Record a reply using state=replied");
  if (item.state === "cancelled" && item.awaiting_reply) issue("Cancelled items cannot await a reply");
  if (item.replied_at && (!item.sent_at || Date.parse(item.replied_at) < Date.parse(item.sent_at))) issue("Reply cannot precede sending");
});
export type Communication = z.infer<typeof CommunicationSchema>;
export const CommunicationMutationSchema = z.object({
  baseRev: z.number(),
  item_id: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/).optional(),
  fields: CommunicationFieldsSchema.partial(),
}).strict();
export type CommunicationMutation = z.infer<typeof CommunicationMutationSchema>;
export const CommunicationFilterSchema = z.object({
  task_id: z.string().regex(/^C\d+$/).optional(),
  project: z.string().optional(),
  to: z.string().optional(),
  channel: z.string().optional(),
  state: z.enum(["draft", "sent", "replied", "cancelled"]).optional(),
  awaiting_reply: z.boolean().optional(),
  archived: z.enum(["include", "exclude", "only"]).default("include"),
  limit: z.number().int().min(1).max(200).default(100),
  cursor: z.string().optional(),
});
export type CommunicationFilter = z.infer<typeof CommunicationFilterSchema>;
export interface CommunicationRow extends Omit<Communication, "body" | "creation_fingerprint"> {
  task_id: string; task_title: string; project: string; archived: boolean; task_status: string;
}
export interface CommunicationPage { items: CommunicationRow[]; next_cursor: string | null }

export const ChangesFilterSchema = z.object({
  since: TimestampSchema,
  until: TimestampSchema.optional(),
  project: z.string().optional(),
  archived: z.enum(["include", "exclude", "only"]).default("include"),
  limit: z.number().int().min(1).max(200).default(100),
  cursor: z.string().optional(),
}).refine(q => !q.until || Date.parse(q.until) >= Date.parse(q.since), "until must not precede since");
export type ChangesFilter = z.infer<typeof ChangesFilterSchema>;
export type Freshness = "fresh" | "newer_notes" | "unknown";
export interface ChangeItem {
  id: string; task_id: string; task_title: string; project: string; at: string; occurred_at?: string;
  type: string; excerpt: string; truncated: boolean; observation_id?: string;
  verification?: z.infer<typeof VerificationSchema>; verification_evidence?: string;
  coverage: "recorded" | "legacy" | "history_unavailable";
  current_status: string; current_freshness: Freshness;
  fields?: string[];
  changes?: Record<string,{before:unknown;after:unknown}>;
}
export interface ChangesPage { items: ChangeItem[]; next_cursor: string | null; until: string; coverage_note: string }
export const DEFAULT_PRIORITIES = [
  { id: "Urgent", color: "#ef4444", rank: 0 },
  { id: "High", color: "#f97316", rank: 1 },
  { id: "Normal", color: "#3b82f6", rank: 2 },
  { id: "Low", color: "#64748b", rank: 3 },
];

/** This is a cue to review the status, not an assertion that it is incorrect. */
export function statusFreshness(task: { status_detail_updated_at?: string | null; latest_note_at?: string | null }): Freshness {
  const status=Date.parse(task.status_detail_updated_at ?? "");
  if (!Number.isFinite(status)) return "unknown";
  if (task.latest_note_at && !Number.isFinite(Date.parse(task.latest_note_at))) return "unknown";
  return task.latest_note_at && Date.parse(task.latest_note_at) >= status ? "newer_notes" : "fresh";
}
