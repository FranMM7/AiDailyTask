function boundedValue(value:unknown):unknown { const text=JSON.stringify(value) ?? "null"; return text.length <= 60 ? value : text.slice(0,60)+"…"; }
import { randomUUID } from "node:crypto";
import {
  type ChangesFilter, type ChangesPage, type ChangeItem, type CommunicationFilter,
  type CommunicationPage, type CommunicationRow, statusFreshness,
} from "@AiDailyTasks/shared";
import type { FsTaskRepository } from "../infrastructure/taskRepository";
import { NotFoundError, ValidationError } from "../errors";

/** Bounded, expiring snapshots keep pages stable while other clients keep writing. */
class SnapshotPages<T> {
  private snapshots = new Map<string, { key: string; until: string; expires: number; items: T[] }>();
  page(key: string, items: T[], until: string, limit: number, cursor?: string) {
    for (const [id, value] of this.snapshots) if (value.expires < Date.now()) this.snapshots.delete(id);
    let id: string, offset = 0;
    if (cursor) {
      const parts = cursor.split(":"); id = parts[0]; offset = Number(parts[1]);
      if (parts.length !== 2 || !Number.isSafeInteger(offset) || offset < 0) throw new ValidationError("Invalid cursor; restart the query");
      const snapshot = this.snapshots.get(id);
      if (!snapshot || snapshot.key !== key) throw new ValidationError("Cursor expired or filters changed; restart the query");
      ({items, until} = snapshot);
      if (offset > items.length) throw new ValidationError("Invalid cursor offset; restart the query");
    } else {
      if (items.length > 100_000) throw new ValidationError("Too many changes; narrow the time window or project");
      while (this.snapshots.size >= 16) this.snapshots.delete(this.snapshots.keys().next().value!);
      id = randomUUID();
      this.snapshots.set(id, { key, items, until, expires: Date.now() + 10 * 60_000 });
    }
    return { items: items.slice(offset, offset + limit), until, next_cursor: offset + limit < items.length ? `${id}:${offset + limit}` : null };
  }
}

export class WorkflowService {
  private changes = new SnapshotPages<ChangeItem>();
  private communications = new SnapshotPages<CommunicationRow>();
  constructor(private readonly repo: FsTaskRepository) {}

  async listChanges(query: ChangesFilter): Promise<ChangesPage> {
    const {cursor, limit, ...filter} = query;
    const key = JSON.stringify(filter);
    const until = query.until ?? new Date().toISOString();
    if (!cursor && Date.parse(query.since) > Date.parse(until)) throw new ValidationError("until must not precede since");
    const rows: ChangeItem[] = [];
    if (!cursor) {
      // A narrow window normally skips the great majority of task histories.
      for (const summary of await this.repo.listSummaries()) {
        if (!summary.valid || (query.project && query.project !== summary.project)) continue;
        if (query.archived === "exclude" && summary.archived || query.archived === "only" && !summary.archived) continue;
        if (summary.rev <= Date.parse(query.since)) continue;
        const notes = await this.repo.allObservations(summary.id);
        const base = { task_id:summary.id, task_title:summary.title, project:summary.project, current_status:summary.status, current_freshness:statusFreshness(summary) };
        let hasRecordedMutation = false;
        for (const note of notes) {
          const at = note.recorded_at ?? note.at;
          if (!(Date.parse(at) > Date.parse(query.since) && Date.parse(at) <= Date.parse(until))) continue;
          if (note.recorded_at) hasRecordedMutation = true;
          rows.push({ ...base, id: `${summary.id}:${note.id}`, observation_id:note.id, at, occurred_at:note.at,
            type:note.event ?? "observation", excerpt:note.markdown.slice(0,1000),
            truncated:note.markdown.length > 1000 || !!note.changes || (note.verification_evidence?.length ?? 0) > 1000,
            verification:note.verification, verification_evidence:note.verification_evidence?.slice(0,1000),
            changes:note.changes ? Object.fromEntries(Object.entries(note.changes).slice(0,8).map(([key,c])=>[key,{before:boundedValue(c.before),after:boundedValue(c.after)}])) : undefined,
            fields:note.changes ? Object.keys(note.changes) : undefined, coverage:note.recorded_at ? "recorded" : "legacy" });
        }
        if (!hasRecordedMutation && summary.rev <= Date.parse(until)) rows.push({ ...base,
          id:`${summary.id}:snapshot:${summary.rev}`, at:new Date(summary.rev).toISOString(), type:"task_changed",
          excerpt:"Task files changed; a complete before/after history is unavailable.", truncated:false, coverage:"history_unavailable" });
      }
      rows.sort((a,b) => Date.parse(a.at)-Date.parse(b.at) || a.task_id.localeCompare(b.task_id) || a.id.localeCompare(b.id));
    }
    return { ...this.changes.page(key,rows,until,limit,cursor), coverage_note:"Recorded events use server recording time; older notes use their stated time. Direct file edits, copies and deletions cannot provide a complete historical audit. Current status is current context, not a historical snapshot." };
  }

  async listCommunications(query: CommunicationFilter): Promise<CommunicationPage> {
    const {cursor,limit,...filter}=query;
    const items: CommunicationRow[]=[];
    if (!cursor) for (const id of query.task_id ? [query.task_id] : await this.repo.listIds()) {
      let doc; try { doc=await this.repo.document(id); } catch (error) { if(query.task_id)throw error; continue; }
      const task=doc.frontmatter;
      if (query.project && query.project !== task.project) continue;
      if (query.archived === "exclude" && task.archived || query.archived === "only" && !task.archived) continue;
      for (const item of task.communications) {
        if (query.to && query.to.trim().toLowerCase() !== item.to.toLowerCase()) continue;
        if (query.channel && query.channel.trim().toLowerCase() !== item.channel.toLowerCase()) continue;
        if (query.state && query.state !== item.state) continue;
        if (query.awaiting_reply !== undefined && query.awaiting_reply !== (item.state === "sent" && item.awaiting_reply)) continue;
        const {body:_body,creation_fingerprint:_fingerprint,...fields}=item;
        items.push({...fields,task_id:id,task_title:task.title,project:task.project,archived:task.archived,task_status:task.status});
      }
    }
    items.sort((a,b)=>(a.sent_at ?? a.created_at).localeCompare(b.sent_at ?? b.created_at) || a.id.localeCompare(b.id));
    return this.communications.page(JSON.stringify(filter),items,"",limit,cursor);
  }

  async getCommunication(id: string, itemId: string) {
    const item=(await this.repo.document(id)).frontmatter.communications.find(c=>c.id === itemId);
    if (!item) throw new NotFoundError("Communication not found");
    const {creation_fingerprint:_fingerprint,...publicItem}=item;
    return publicItem;
  }
}
