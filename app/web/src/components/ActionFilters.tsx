import { useNavigate, useSearchParams } from "react-router-dom";
import { useConfig } from "@/api/hooks";

const control="rounded border border-slate-300 bg-transparent p-1 text-xs dark:border-slate-700";
/** Calendar arithmetic in the browser's timezone; no UTC date shift. */
export function localDay(offset=0, now=new Date()): string {
  const d=new Date(now.getFullYear(),now.getMonth(),now.getDate()+offset);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}
export function ActionFilters() {
  const [params,setParams]=useSearchParams(); const navigate=useNavigate(); const {data:config}=useConfig();
  const set=(key:string,value:string)=>{const p=new URLSearchParams(params); value ? p.set(key,value) : p.delete(key); setParams(p,{replace:true});};
  const preset=(which:string)=>{
    const p=new URLSearchParams(params);
    for(const key of ["next_action_date_from","next_action_date_to","action_undated","has_next_action","status"]) p.delete(key);
    if(which) {p.set("has_next_action","true");p.set("sort","priority");p.set("order","asc");p.delete("archived");}
    if(which === "Today" || which === "Tomorrow") {const day=localDay(which === "Tomorrow" ? 1 : 0);p.set("next_action_date_from",day);p.set("next_action_date_to",day);}
    if(which === "Overdue") p.set("next_action_date_to",localDay(-1));
    if(which === "Undated") p.set("action_undated","true");
    navigate(`/table?${p}`);
  };
  return <div className="flex w-full flex-wrap items-center gap-2 text-xs">
    {["Today","Tomorrow","Overdue","Undated"].map(p=><button key={p} className={control} onClick={()=>preset(p)}>{p}</button>)}
    <button className={control} onClick={()=>preset("")}>All dates</button>
    <label>Owner <input className={control} placeholder="Exact owner" value={params.get("next_action_owner") ?? ""} onChange={e=>set("next_action_owner",e.target.value)}/></label>
    <label>Priority <select className={control} value={params.get("priority") ?? ""} onChange={e=>set("priority",e.target.value)}><option value="">All</option>{config?.priorities?.map(p=><option key={p.id}>{p.id}</option>)}</select></label>
    <label><input type="checkbox" checked={params.get("include_closed") === "true"} onChange={e=>set("include_closed",e.target.checked ? "true" : "")}/> Include closed</label>
  </div>;
}
