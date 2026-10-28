import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Env } from "../env";
import type { ConfigService } from "../config";
import type { FsTaskRepository } from "../infrastructure/taskRepository";
import { parseTaskFile, dumpFrontmatter, getSection, parseBody } from "../domain/task";
import { parseStructuredTask, newObservationId } from "../domain/structuredTask";
import { renderObservation } from "../domain/observation";
import { ValidationError } from "../errors";

export const StatusMigrationSchema=z.object({
  mode:z.enum(["preview","apply","resume","rollback"]).default("preview"),
  task_id:z.string().regex(/^C\d+$/).default("C278"),
  preview_hash:z.string().optional(), operation_id:z.string().uuid().optional(),
  exclude_invalid:z.array(z.string().regex(/^C\d+$/)).default([]),
}).strict();
type Input=z.infer<typeof StatusMigrationSchema>;
type FileChange={relative:string;before:string|null;after:string};
type Journal={id:string;state:"prepared"|"applied"|"rolled_back";changes:FileChange[];tasks:string[];preview_hash:string};
const hash=(value:string)=>createHash("sha256").update(value).digest("hex");

/** One specific vocabulary repair. Journals preserve exact bytes and can resume either direction. */
export class StatusMigrationService {
  constructor(private env:Env,private config:ConfigService,private repo:FsTaskRepository) {}
  async run(input:Input) {
    return this.repo.gate.run(async()=>{
      this.config.reload();
      await this.repo.document(input.task_id);
      if(input.mode === "resume" || input.mode === "rollback") {
        if(!input.operation_id) throw new ValidationError("operation_id is required");
        const file=this.journalPath(input.task_id,input.operation_id);
        const journal=JSON.parse(await fs.readFile(file,"utf8")) as Journal;
        return this.execute(journal,file,input.mode === "rollback");
      }
      const plan=await this.preview(input);
      if(input.mode === "preview") return plan.report;
      if(input.preview_hash !== plan.report.preview_hash) throw new ValidationError("Preview changed; run preview again and review the new plan");
      if(plan.report.invalid.some(id=>!input.exclude_invalid.includes(id))) throw new ValidationError("Resolve invalid tasks or explicitly exclude their IDs before applying");
      if(!plan.changes.length) return {...plan.report,applied:true,operation_id:null};
      const journal:Journal={id:randomUUID(),state:"prepared",changes:plan.changes,tasks:plan.report.tasks,preview_hash:plan.report.preview_hash};
      const file=this.journalPath(input.task_id,journal.id);
      await fs.mkdir(path.dirname(file),{recursive:true});
      // The journal itself is the complete, exact-byte backup, written before any mutation.
      await this.atomic(file,JSON.stringify(journal,null,2));
      return this.execute(journal,file,false);
    });
  }
  private journalPath(task:string,id:string) {return path.join(this.env.boardDir,task,"files","status-migration",id,"journal.json");}
  private async read(file:string):Promise<string|null> {try{return await fs.readFile(file,"utf8");}catch(e){if((e as NodeJS.ErrnoException).code === "ENOENT")return null;throw e;}}
  private resolve(relative:string) {
    const root=path.dirname(this.env.configPath), file=path.resolve(root,relative);
    const rel=path.relative(root,file);
    if(rel.startsWith("..") || path.isAbsolute(rel) || !(relative === "board.config.json" || /^board[\\/]C\d+[\\/](task\.json|task\.md|observations\.jsonl)$/.test(relative))) throw new ValidationError("Unsafe migration journal path");
    return file;
  }
  private async atomic(file:string,text:string) {const temp=`${file}.migration-${randomUUID()}`;await fs.writeFile(temp,text,"utf8");await fs.rename(temp,file);}
  private async preview(input:Input) {
    const configRaw=(await fs.readFile(this.env.configPath,"utf8"));
    const config=JSON.parse(configRaw);
    const old=config.statuses.find((s:{id:string})=>s.id === "Depricated"), canonical=config.statuses.find((s:{id:string})=>s.id === "Cancelled");
    const chosen={...(canonical ?? old ?? {color:"#64748b",order:config.statuses.length}),id:"Cancelled",label:"Cancelled"};
    config.statuses=config.statuses.filter((s:{id:string})=>s.id !== "Depricated" && s.id !== "Cancelled");config.statuses.push(chosen);
    // Cancelled becomes a concrete status; other aliases must point directly to it.
    config.statusAliases={...Object.fromEntries(Object.entries(config.statusAliases ?? {})
      .filter(([source])=>source !== "Cancelled" && source !== "Depricated")
      .map(([source,target])=>[source,target === "Depricated" ? "Cancelled" : target])),Depricated:"Cancelled"};
    if(config.board?.hiddenColumns) config.board.hiddenColumns=[...new Set(config.board.hiddenColumns.map((s:string)=>s === "Depricated" ? "Cancelled" : s))];
    const changes:FileChange[]=[], inventory:string[]=[configRaw], tasks:string[]=[],invalid:string[]=[];
    const at=new Date().toISOString();
    for(const id of await this.repo.listIds()) {
      const dir=path.join(this.env.boardDir,id);
      const json=await this.read(path.join(dir,"task.json")), md=await this.read(path.join(dir,"task.md"));
      const history=await this.read(path.join(dir,"observations.jsonl"));
      inventory.push(id,json ?? "",md ?? "",history ?? "");
      try {
        const parsed=json !== null ? parseStructuredTask(json) : parseTaskFile(md ?? "");
        if("ok" in parsed && !parsed.ok) throw new Error(parsed.error);
        const fm=parsed.frontmatter;
        if(fm.status !== "Depricated") continue;
        tasks.push(id);
        const note={id:newObservationId(),at,recorded_at:at,author:"system",kind:"system" as const,event:"status.migrated",markdown:"Normalized cancellation status from Depricated to Cancelled.",changes:{status:{before:"Depricated",after:"Cancelled"}}};
        if(json !== null) {
          const raw=JSON.parse(json); raw.frontmatter.status="Cancelled";raw.frontmatter.updated=at.slice(0,10);
          const updatedHistory=(history ?? "").replace(/\s*$/,"")+(history?.trim() ? "\n" : "")+JSON.stringify(note)+"\n";
          raw.history={count:updatedHistory.trim().split(/\r?\n/).length,bytes:Buffer.byteLength(updatedHistory)};
          changes.push({relative:`board/${id}/observations.jsonl`,before:history,after:updatedHistory},{relative:`board/${id}/task.json`,before:json,after:JSON.stringify(raw,null,2)+"\n"});
        } else {
          const p=parseTaskFile(md!);if(!p.ok)throw new Error(p.error);
          // Keep the original body bytes, inserting only the new note into Observations.
          let body=p.body; const heading=/^## Observations[ \t]*\r?$/m.exec(body);
          if(heading) {const rest=body.slice(heading.index+heading[0].length);const next=/^## /m.exec(rest);const end=next ? heading.index+heading[0].length+next.index : body.length;body=body.slice(0,end).trimEnd()+"\n\n"+renderObservation(note)+"\n\n"+body.slice(end);}
          else body=body.trimEnd()+"\n\n## Observations\n\n"+renderObservation(note)+"\n";
          const observation_fingerprint = fm.observation_fingerprint
            ? hash(getSection(parseBody(body), "Observations").trim()) : undefined;
          const after=`---\n${dumpFrontmatter({...fm,status:"Cancelled",updated:at.slice(0,10),observation_fingerprint})}---${body}`;
          if(!parseTaskFile(after).ok)throw new Error("Generated Markdown did not parse");
          changes.push({relative:`board/${id}/task.md`,before:md,after});
        }
      } catch {invalid.push(id);}
    }
    if(JSON.stringify(JSON.parse(configRaw)) !== JSON.stringify(config)) changes.push({relative:"board.config.json",before:configRaw,after:JSON.stringify(config,null,2)+"\n"});
    return {changes,report:{preview_hash:hash(JSON.stringify([inventory,input.exclude_invalid])),tasks,invalid,excluded:input.exclude_invalid,files:changes.map(c=>c.relative),collision:!!old && !!canonical,chosen_status:chosen,alias:{Depricated:"Cancelled"},note:"Canonical settings win collisions. Journals back up exact bytes; direct filesystem writers must remain stopped during apply/rollback."}};
  }
  private async execute(journal:Journal,file:string,rollback:boolean) {
    if(journal.state === "rolled_back" && !rollback)throw new ValidationError("This operation was rolled back; create a new preview");
    const changes=rollback ? [...journal.changes].reverse() : journal.changes;
    // Preflight every file before applying any. Resume accepts only known before/after bytes.
    for(const c of changes) {
      const current=await this.read(this.resolve(c.relative));
      if(current !== c.before && current !== c.after) throw new ValidationError(`File changed outside this migration: ${c.relative}. Restore/review it before resuming; no further files changed.`);
    }
    for(const c of changes) {
      const destination=this.resolve(c.relative), target=rollback ? c.before : c.after;
      const current=await this.read(destination);
      if(current === target)continue;
      if(current !== (rollback ? c.after : c.before)) throw new ValidationError(`Concurrent file edit: ${c.relative}; use the saved journal to resume`);
      if(target === null)await fs.unlink(destination);else await this.atomic(destination,target);
    }
    this.config.reload();
    for(const id of journal.tasks) {const t=await this.repo.document(id);if(!rollback && t.frontmatter.status !== "Cancelled")throw new Error(`Migration verification failed: ${id}`);}
    journal.state=rollback ? "rolled_back" : "applied";
    await this.atomic(file,JSON.stringify(journal,null,2));
    return {operation_id:journal.id,state:journal.state,tasks:journal.tasks,backup:file};
  }
}
