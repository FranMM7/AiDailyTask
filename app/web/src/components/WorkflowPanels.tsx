import { useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import type { ChangesPage, CommunicationPage, Freshness, Observation } from "@AiDailyTasks/shared";
import { request } from "@/api/client";
import { useTaskDrawer } from "@/lib/navigation";
import { MarkdownView } from "./MarkdownView";

export function FreshnessLabel({freshness}:{freshness:Freshness}) {
  if (freshness === "fresh") return null;
  return <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">{freshness === "newer_notes" ? "Notes newer than status" : "Status freshness unknown"}</p>;
}

export function ObservationEvidence({observation:o}:{observation:Observation}) {
  return <div className="mb-2 space-y-1 text-xs text-slate-500">
    <span>{o.kind === "system" ? "System history" : o.verification ?? "Not classified"}</span>
    {o.id && <span className="ml-2 break-all font-mono" title="Stable observation reference">{o.id}</span>}
    {o.recorded_at && o.recorded_at !== o.at && <p>Recorded {o.recorded_at}</p>}
    {o.verification_evidence && <details><summary>Evidence</summary><p className="whitespace-pre-wrap break-words">{o.verification_evidence}</p></details>}
    {o.changes && <details><summary>View changes</summary>
      {o.started_at && <p>Started {o.started_at}{o.resolved_at ? ` · Resolved ${o.resolved_at}` : ""}</p>}
      {Object.entries(o.changes).map(([field,change])=>{
        const before=typeof change.before === "string" ? change.before : JSON.stringify(change.before,null,2) ?? "";
        const after=typeof change.after === "string" ? change.after : JSON.stringify(change.after,null,2) ?? "";
        // Linear, bounded prefix/suffix comparison; full values stay available below.
        const a=before.slice(0,4000).split("\n"), b=after.slice(0,4000).split("\n");
        let prefix=0; while(prefix<Math.min(a.length,b.length) && a[prefix] === b[prefix]) prefix++;
        return <div key={field} className="mt-2 break-words"><strong>{field}</strong>
          <pre className="whitespace-pre-wrap">Removed: {a.slice(prefix,prefix+8).join("\n") || "(none)"}{"\n"}Added: {b.slice(prefix,prefix+8).join("\n") || "(none)"}</pre>
          <p>Preview limited to eight lines from the first change.</p>
          <details><summary>{after ? "View previous" : "View resolved details"}</summary><pre className="whitespace-pre-wrap">{before || "(empty)"}</pre></details>
          <details><summary>View updated</summary><pre className="whitespace-pre-wrap">{after || "(empty)"}</pre></details>
        </div>;
      })}
    </details>}
  </div>;
}

const control="rounded border border-slate-300 bg-transparent p-1.5 text-sm dark:border-slate-700";
function localStart() { const d=new Date(); d.setHours(0,0,0,0); return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16); }
export function WorkflowPanels({ onNavigate }: { onNavigate?: () => void }) {
  const [params]=useSearchParams();
  const project=params.get("project") || undefined;
  const [panel,setPanel]=useState<"changes"|"waiting"|null>(null);
  const [since,setSince]=useState(localStart);
  const [windowStart,setWindowStart]=useState<string|null>(null);
  const [to,setTo]=useState(""); const [channel,setChannel]=useState("");
  const [archived,setArchived]=useState(false);
  const [drafts,setDrafts]=useState(false);
  const {openTask}=useTaskDrawer();
  const showTask = (id: string) => { onNavigate?.(); openTask(id); };
  const changes=useInfiniteQuery({queryKey:["changes",project,windowStart],enabled:panel === "changes" && !!windowStart,initialPageParam:undefined as string|undefined,
    queryFn:({pageParam})=>{const q=new URLSearchParams({since:windowStart!}); if(project)q.set("project",project); if(pageParam)q.set("cursor",pageParam); return request<ChangesPage>(`/changes?${q}`);},
    getNextPageParam:p=>p.next_cursor ?? undefined});
  const waiting=useInfiniteQuery({queryKey:["communications",project,to,channel,archived,drafts],enabled:panel === "waiting",initialPageParam:undefined as string|undefined,
    queryFn:({pageParam})=>{const q=new URLSearchParams(drafts ? {state:"draft"} : {awaiting_reply:"true"}); if(project)q.set("project",project); if(to)q.set("to",to); if(channel)q.set("channel",channel); if(archived)q.set("archived","exclude"); if(pageParam)q.set("cursor",pageParam); return request<CommunicationPage>(`/communications?${q}`);},
    getNextPageParam:p=>p.next_cursor ?? undefined});
  return <div className="w-full space-y-2">
    <div className="flex gap-2"><button className={control} onClick={()=>setPanel(panel === "changes" ? null : "changes")}>Changes since</button><button className={control} onClick={()=>setPanel(panel === "waiting" ? null : "waiting")}>Waiting on</button></div>
    {panel === "changes" && <section aria-label="Changes since" className="space-y-2 rounded border p-3">
      <label>Since <input aria-label="Changes since date" className={control} type="datetime-local" value={since} onChange={e=>setSince(e.target.value)}/></label>
      <button className={control} disabled={!since} onClick={()=>{setWindowStart(new Date(since).toISOString()); if(windowStart === new Date(since).toISOString()) void changes.refetch();}}>Show changes</button>
      {changes.isFetching && <p role="status">Loading changes…</p>}
      {changes.error && <p role="alert">{changes.error.message}. Start a new query to refresh expired pages.</p>}
      {changes.data && <p className="text-xs">Through {changes.data.pages[0].until}. {changes.data.pages[0].coverage_note}</p>}
      {changes.data?.pages.flatMap(p=>p.items).map(item=><article key={item.id} className="border-t py-2 text-sm">
        <button className="text-blue-600 underline" onClick={()=>showTask(item.task_id)}>{item.task_id} · {item.task_title}</button>
        <p>{item.at} · {item.type} · {item.verification ?? (item.type === "observation" ? "Not classified" : "System history")} · {item.coverage}</p>
        <p className="whitespace-pre-wrap break-words">{item.excerpt}</p>
        {item.observation_id && <FullObservation taskId={item.task_id} observationId={item.observation_id}/>} 
      </article>)}
      {changes.data && !changes.data.pages[0].items.length && <p>No changes in this window.</p>}
      {changes.hasNextPage && <button className={control} disabled={changes.isFetching} onClick={()=>void changes.fetchNextPage()}>Load more changes</button>}
    </section>}
    {panel === "waiting" && <section aria-label="Waiting on" className="space-y-2 rounded border p-3">
      <div className="flex flex-wrap gap-2"><input aria-label="Recipient filter" placeholder="Exact recipient" className={control} value={to} onChange={e=>setTo(e.target.value)}/><input aria-label="Channel filter" placeholder="Exact channel" className={control} value={channel} onChange={e=>setChannel(e.target.value)}/><label><input type="checkbox" checked={archived} onChange={e=>setArchived(e.target.checked)}/> Exclude archived tasks</label><label><input type="checkbox" checked={drafts} onChange={e=>setDrafts(e.target.checked)}/> Show drafts</label></div>
      {waiting.isFetching && <p role="status">Loading communications…</p>}{waiting.error && <p role="alert">{waiting.error.message}</p>}
      {[...new Set(waiting.data?.pages.flatMap(p=>p.items).map(i=>i.to.trim().toLowerCase()))].map(recipient=><div key={recipient}><h4 className="font-semibold">{recipient}</h4>{waiting.data?.pages.flatMap(p=>p.items).filter(i=>i.to.trim().toLowerCase() === recipient).map(item=><p key={`${item.task_id}:${item.id}`} className="py-1 text-sm"><button className="text-blue-600 underline" onClick={()=>showTask(item.task_id)}>{item.task_id} · {item.subject}</button> · {item.channel} · {item.state} · {item.sent_at ?? "Unsent"} · {item.task_status}{item.archived ? " · Archived" : ""}</p>)}</div>)}
      {waiting.data && !waiting.data.pages[0].items.length && <p>No matching communications.</p>}
      {waiting.hasNextPage && <button className={control} disabled={waiting.isFetching} onClick={()=>void waiting.fetchNextPage()}>Load more communications</button>}
    </section>}
  </div>;
}

function FullObservation({taskId,observationId}:{taskId:string;observationId:string}) {
  const [note,setNote]=useState<Observation>(); const [error,setError]=useState("");
  return <details onToggle={e=>{if(e.currentTarget.open && !note) void request<{observation:Observation}>(`/tasks/${taskId}/observations/${observationId}`).then(r=>setNote(r.observation)).catch(e=>setError(e.message));}}><summary>Full observation and evidence</summary>{error && <p role="alert">{error}</p>}{note && <><ObservationEvidence observation={note}/><MarkdownView markdown={note.markdown}/></>}</details>;
}
