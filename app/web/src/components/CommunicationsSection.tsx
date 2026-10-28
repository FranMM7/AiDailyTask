import { useState } from "react";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { Communication, CommunicationPage, TaskDetail } from "@AiDailyTasks/shared";
import { request } from "@/api/client";

const control="w-full rounded border border-slate-300 bg-transparent p-2 text-sm dark:border-slate-700";
export function CommunicationsSection({task}:{task:TaskDetail}) {
  const cache=useQueryClient();
  const [editing,setEditing]=useState<{baseRev:number;item_id:string;existing:boolean;fields:Partial<Communication>}|null>(null);
  const [error,setError]=useState("");
  const items=useInfiniteQuery({queryKey:["communications",task.id,task.rev],initialPageParam:undefined as string|undefined,
    queryFn:({pageParam})=>request<CommunicationPage>(`/communications?task_id=${task.id}${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ""}`),
    getNextPageParam:p=>p.next_cursor ?? undefined});
  const save=useMutation({mutationFn:()=>request<{task:TaskDetail}>(`/tasks/${task.id}/communications`,{method:editing!.existing ? "PATCH" : "POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({baseRev:editing!.baseRev,item_id:editing!.item_id,fields:editing!.fields})}),
    onSuccess:r=>{cache.setQueryData(["task",task.id],r); void cache.invalidateQueries({queryKey:["communications"]}); void cache.invalidateQueries({queryKey:["tasks"]}); setEditing(null); setError("");},onError:e=>setError(e.message)});
  const set=(key:string,value:unknown)=>setEditing(old=>old ? {...old,fields:{...old.fields,[key]:value}} : old);
  const edit=async(id:string)=>{
    try { const c=await request<Communication>(`/tasks/${task.id}/communications/${id}`); const {id:_id,created_at:_created,updated_at:_updated,creation_fingerprint:_fingerprint,...fields}=c; setEditing({baseRev:task.rev,item_id:id,existing:true,fields}); setError(""); }
    catch(e) {setError((e as Error).message);}
  };
  return <section className="space-y-3"><h3 className="font-semibold">Communications</h3><p className="text-xs text-slate-500">Record drafts, sends and replies here. These controls save local records.</p>
    {!editing && <button className="rounded border px-3 py-1 text-sm" onClick={()=>setEditing({baseRev:task.rev,item_id:crypto.randomUUID(),existing:false,fields:{to:"",channel:"",subject:"",body:"",state:"draft",sent_at:null,replied_at:null,awaiting_reply:false,reference_url:null}})}>New communication</button>}
    {error && <p role="alert" className="text-sm text-red-600">{error} Your draft is retained. If the task changed, reload it and review your draft before retrying.</p>}
    {editing && <form className="space-y-2" onSubmit={e=>{e.preventDefault();save.mutate();}}>
      <label className="block text-sm">To<input required maxLength={200} className={control} value={editing.fields.to} onChange={e=>set("to",e.target.value)}/></label>
      <label className="block text-sm">Channel<input required maxLength={80} className={control} value={editing.fields.channel} onChange={e=>set("channel",e.target.value)}/></label>
      <label className="block text-sm">Subject<input required maxLength={300} className={control} value={editing.fields.subject} onChange={e=>set("subject",e.target.value)}/></label>
      <label className="block text-sm">Message body<textarea maxLength={100000} rows={5} className={control} value={editing.fields.body} onChange={e=>set("body",e.target.value)}/></label>
      <p className="text-sm">State: {editing.fields.state}</p>
      {editing.fields.state === "draft" && <button type="button" className="rounded border p-2 text-sm" onClick={()=>setEditing({...editing,fields:{...editing.fields,state:"sent",sent_at:new Date().toISOString()}})}>Record as sent</button>}
      {editing.existing && editing.fields.state === "sent" && <button type="button" className="rounded border p-2 text-sm" onClick={()=>setEditing({...editing,fields:{...editing.fields,state:"replied",replied_at:new Date().toISOString(),awaiting_reply:false}})}>Record reply</button>}
      {editing.fields.sent_at && <label className="block text-sm">Sent at (timestamp with timezone)<input required className={control} value={editing.fields.sent_at} onChange={e=>set("sent_at",e.target.value)}/></label>}
      {editing.fields.replied_at && <label className="block text-sm">Replied at (timestamp with timezone)<input required className={control} value={editing.fields.replied_at} onChange={e=>set("replied_at",e.target.value)}/></label>}
      {editing.fields.state === "sent" && <label className="block text-sm"><input type="checkbox" checked={editing.fields.awaiting_reply} onChange={e=>set("awaiting_reply",e.target.checked)}/> Awaiting reply</label>}
      <label className="block text-sm">Reference URL<input type="url" className={control} value={editing.fields.reference_url ?? ""} onChange={e=>set("reference_url",e.target.value || null)}/></label>
      {editing.fields.state !== "cancelled" && <button type="button" className="rounded border p-2 text-sm" onClick={()=>setEditing({...editing,fields:{...editing.fields,state:"cancelled",awaiting_reply:false}})}>Mark cancelled</button>}
      <div className="flex gap-2"><button type="submit" disabled={save.isPending} className="rounded bg-blue-600 px-3 py-2 text-sm text-white">{save.isPending ? "Saving…" : "Save communication"}</button><button type="button" onClick={()=>setEditing(null)}>Discard edits</button></div>
    </form>}
    {items.error && <p role="alert">{items.error.message}</p>}
    {items.data?.pages.flatMap(p=>p.items).map(c=><article key={c.id} className="rounded border p-3 text-sm"><strong>{c.subject}</strong><p>{c.to} · {c.channel} · {c.state}{c.awaiting_reply ? " · Awaiting reply" : ""}</p><p>{c.sent_at ? `Sent ${c.sent_at}` : "Unsent"}</p><button disabled={!!editing} className="text-blue-600 underline" onClick={()=>void edit(c.id)}>View / edit communication</button></article>)}
    {items.hasNextPage && <button disabled={items.isFetching} onClick={()=>void items.fetchNextPage()}>Load more communications</button>}
    {items.data && !items.data.pages[0].items.length && <p className="text-sm text-slate-500">No communications recorded.</p>}
  </section>;
}
