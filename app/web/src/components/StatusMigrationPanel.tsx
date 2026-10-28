import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { request } from "@/api/client";

interface MigrationResult {preview_hash?:string;tasks:string[];invalid?:string[];files?:string[];collision?:boolean;chosen_status?:{color:string;order:number};state?:string;operation_id?:string;backup?:string;}
export function StatusMigrationPanel() {
  const cache=useQueryClient();const [result,setResult]=useState<MigrationResult>();const [operation,setOperation]=useState("");
  const mutation=useMutation({mutationFn:(mode:string)=>request<MigrationResult>("/migrations/status-alias",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({mode,task_id:"C278",...(mode === "apply" ? {preview_hash:result?.preview_hash} : {}),...(["resume","rollback"].includes(mode) ? {operation_id:operation} : {})})}),onSuccess:r=>{setResult(r);if(r.operation_id)setOperation(r.operation_id);if(r.state){void cache.invalidateQueries({queryKey:["config"]});void cache.invalidateQueries({queryKey:["tasks"]});}}});
  return <section className="space-y-2 rounded-xl border p-4"><h2 className="text-sm font-semibold">Cancellation status cleanup</h2><p className="text-xs text-slate-500">Preview the Depricated → Cancelled repair. It preserves cancellation settings and creates a backup under C278 before applying.</p>
    <button disabled={mutation.isPending} className="rounded border px-3 py-1 text-sm" onClick={()=>mutation.mutate("preview")}>Preview cancellation cleanup</button>
    {mutation.error && <p role="alert">{mutation.error.message}</p>}
    {result?.preview_hash && <div className="text-sm"><p>{result.tasks.length} tasks: {result.tasks.join(", ") || "None"}</p><p>{result.files?.length} files to change. {result.collision ? "Both statuses exist; the current Cancelled settings will be kept." : "Existing cancellation settings will be preserved."}</p>{!!result.invalid?.length && <p>Resolve invalid tasks before applying: {result.invalid.join(", ")}</p>}<button disabled={mutation.isPending || !!result.invalid?.length || !result.files?.length} className="mt-2 rounded bg-blue-600 px-3 py-1 text-white" onClick={()=>mutation.mutate("apply")}>Apply reviewed cleanup</button></div>}
    {result?.state && <p className="text-sm">Migration {result.state}. Backup: {result.backup}</p>}
    <details><summary className="text-xs">Resume or roll back a migration</summary><label className="block text-sm">Operation ID<input className="m-2 rounded border bg-transparent p-1" value={operation} onChange={e=>setOperation(e.target.value)}/></label><button disabled={mutation.isPending || !operation} className="mr-2 rounded border p-1 text-sm" onClick={()=>mutation.mutate("resume")}>Resume</button><button disabled={mutation.isPending || !operation} className="rounded border p-1 text-sm" onClick={()=>mutation.mutate("rollback")}>Restore backup</button></details>
  </section>;
}
