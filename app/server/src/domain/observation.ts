import { createHash } from "node:crypto";
import { ObservationMetadataSchema, type Observation } from "@AiDailyTasks/shared";

export function legacyObservationId(observation: Observation, index: number): string {
  return `obs_${createHash("sha256").update(JSON.stringify([index, observation.at, observation.author, observation.markdown])).digest("base64url").slice(0, 24)}`;
}

/** Reserved portable metadata. Base64 prevents Markdown headings/comments in data escaping. */
export function renderObservation(observation: Observation): string {
  const metadata = ObservationMetadataSchema.parse(observation);
  const escaped = /^(?:## |###\s+\S+\s+[—–-]\s+)/m.test(observation.markdown);
  const encoded = Buffer.from(JSON.stringify({ ...metadata, ...(escaped ? { markdown_base64: Buffer.from(observation.markdown).toString("base64") } : {}) })).toString("base64");
  const visible = escaped ? observation.markdown.split("\n").map(line => `> ${line}`).join("\n") : observation.markdown;
  return `### ${observation.at} \u2014 ${observation.author}\n\n<!-- aidt-observation:${encoded} -->\n${visible}`;
}

export function decodeObservationMetadata(markdown: string): { markdown: string } & Partial<Observation> {
  const match = /^<!-- aidt-observation:([A-Za-z0-9+/=]+) -->\r?\n/.exec(markdown);
  if (!match) return { markdown };
  try {
    const raw = JSON.parse(Buffer.from(match[1], "base64").toString("utf8"));
    return { ...ObservationMetadataSchema.parse(raw), markdown: typeof raw.markdown_base64 === "string" ? Buffer.from(raw.markdown_base64, "base64").toString("utf8") : markdown.slice(match[0].length) };
  } catch { return { markdown }; }
}

/** Human-readable exports preserve evidence and full event snapshots as well as note prose. */
export function observationEvidence(observation: Observation): string {
  const parts = [observation.markdown];
  if (observation.verification) parts.push(`Verification: ${observation.verification}`);
  if (observation.verification_evidence) parts.push(`Evidence: ${observation.verification_evidence}`);
  if (observation.changes) for (const [field, change] of Object.entries(observation.changes)) {
    parts.push(`${field} previous:\n${typeof change.before === "string" ? change.before : JSON.stringify(change.before, null, 2)}`);
    parts.push(`${field} updated:\n${typeof change.after === "string" ? change.after : JSON.stringify(change.after, null, 2)}`);
  }
  return parts.join("\n\n");
}
