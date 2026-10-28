import { WorkflowService } from "../application/workflow";
import { StatusMigrationService, StatusMigrationSchema } from "../application/statusMigration";
import { ChangesFilterSchema, CommunicationMutationSchema, CommunicationFilterSchema, TaskFilterSchema } from "@AiDailyTasks/shared";
import { ExportService, TaskService } from "../application/services";
/**
 * Format parity: the repository must behave identically whether a task is
 * stored as legacy task.md or as structured task.json + observations.jsonl.
 *
 * The tests run the same scripted sequence of operations against two boards
 * that differ only in storage format and assert the resulting DTOs match. That
 * is the property the migration depends on — anything the Markdown board can
 * do, the converted board does the same way.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CreateRequestSchema, PatchRequestSchema, blockerExcerpt, type TaskDetail } from "@AiDailyTasks/shared";
import { ConfigService } from "../config";
import type { Env } from "../env";
import { parseTaskFile } from "../domain/task";
import {
  OBSERVATIONS_FILE,
  TASK_JSON_FILE,
  TASK_MARKDOWN_FILE,
  serializeObservationJsonl,
  serializeStructuredTask,
  structuredFromLegacy,
} from "../domain/structuredTask";
import { AttachmentStore } from "./attachmentStore";
import { EventBus } from "./eventBus";
import { RecentWrites } from "./recentWrites";
import { FsTaskRepository } from "./taskRepository";
import { TaskFileStore, type TaskStoreMode } from "./taskFileStore";

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.slice(1)), "../../../..");

const TASK_MD = `---
id: C01
title: Sample task
project: Sample
category: Bug
severity: Medium
risk: Low
status: In progress
status_detail: ""
created: 2026-01-01
updated: 2026-01-02
tags: []
skills: []
recurring: false
depends_on: []
blocks: []
relates_to: []
parent: null
children: []
sources: []
resources: []
---

## Summary

A task used to compare storage formats.

## Scope

Detailed markdown with a \`code span\` and a list:

- one
- two

## Observations

### 2026-01-01T09:00:00Z — human

First note.

### 2026-01-01T10:00:00Z — claude

Second note, with **bold** text.

### 2026-01-02T11:00:00Z — human

Third note.
`;

async function makeBoard(format: "markdown" | "structured"): Promise<Env> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `aidt-${format}-`));
  const dir = path.join(root, "board", "C01");
  await fs.mkdir(path.join(dir, "files"), { recursive: true });
  await fs.mkdir(path.join(dir, "resources"), { recursive: true });

  if (format === "markdown") {
    await fs.writeFile(path.join(dir, TASK_MARKDOWN_FILE), TASK_MD, "utf8");
  } else {
    const parsed = parseTaskFile(TASK_MD);
    assert.ok(parsed.ok, "fixture must parse");
    const structured = structuredFromLegacy(parsed);
    await fs.writeFile(path.join(dir, TASK_JSON_FILE), serializeStructuredTask(structured.task), "utf8");
    await fs.writeFile(path.join(dir, OBSERVATIONS_FILE), serializeObservationJsonl(structured.observations), "utf8");
  }

  return {
    root,
    boardDir: path.join(root, "board"),
    exportsDir: path.join(root, "exports"),
    graphsDir: path.join(root, "graphs"),
    projectDocsDir: path.join(root, "project-docs"),
    libraryDir: path.join(root, "board", "_meta", "resources"),
    configPath: path.join(root, "board.config.json"),
    configTemplatePath: path.join(REPO_ROOT, "board.config.json.template"),
    projectsPath: path.join(root, "projects.json"),
    webDistDir: path.join(root, "dist"),
    port: 0,
    host: "127.0.0.1",
    taskStore: format === "markdown" ? "markdown" : "json",
  };
}

function makeRepo(env: Env): FsTaskRepository {
  const bus = new EventBus();
  return new FsTaskRepository(
    env,
    new ConfigService(env),
    new AttachmentStore(env),
    new AttachmentStore(env, "resources", "resources"),
    bus,
    new RecentWrites(),
  );
}

/**
 * Everything except rev (an mtime) and the wall-clock timestamp the repository
 * stamps on a UI-edit note, both of which legitimately differ between two runs.
 */
const GENERATED_NOTE = /^Updated via web UI/;
const GENERATED_HEADER = /^### \S+ — human$(?=\n\nUpdated via web UI)/gm;

function comparable(detail: TaskDetail): unknown {
  const { rev: _rev, updatedEffective: _updatedEffective, latest_note_at: _latest, observation_fingerprint: _historyFingerprint, ...rest } = detail;
  return {
    ...rest,
    observations: rest.observations.map((observation) =>
      observation.recorded_at ? { ...observation, id: "<generated>", recorded_at: "<generated>", ...(observation.kind === "system" ? {at:"<generated>"} : {}) } : observation,
    ),
    rawBody: rest.rawBody.replace(GENERATED_HEADER, "### <generated> — human"),
  };
}

/** The scripted sequence both formats must agree on. */
async function run(env: Env): Promise<Record<string, unknown>> {
  const repo = makeRepo(env);
  const out: Record<string, unknown> = {};

  const summaries = await repo.listSummaries();
  assert.equal(summaries.length, 1);
  const summary = summaries[0];
  assert.ok(summary.valid);
  out.summary = { excerpt: summary.excerpt, observationCount: summary.observationCount, title: summary.title };

  const paged = await repo.read("C01", 2);
  assert.ok(paged.valid);
  out.paged = comparable(paged);

  out.page1 = await repo.listObservations("C01", undefined, 2);
  out.page2 = await repo.listObservations("C01", (out.page1 as { nextCursor: string }).nextCursor, 2);

  // Append, then patch a field — both must land and both must bump the revision.
  const beforeAppend = await repo.read("C01", 20);
  assert.ok(beforeAppend.valid);
  const appended = await repo.appendObservation("C01", {
    baseRev: beforeAppend.rev,
    author: "claude",
    text: "Fourth note added through the repository.",
    at: "2026-01-03T12:00:00Z",
  });
  assert.equal(appended.conflict, false);
  assert.ok(!appended.conflict);
  out.afterAppend = comparable(appended.task);

  const patched = await repo.patch("C01", {
    baseRev: appended.task.rev,
    fields: { status: "Completed" },
  });
  assert.equal(patched.conflict, false);
  assert.ok(!patched.conflict);
  out.afterPatch = comparable(patched.task);

  // A stale revision must still be rejected.
  const stale = await repo.patch("C01", { baseRev: beforeAppend.rev, fields: { risk: "High" } });
  out.staleRejected = stale.conflict;

  const archived = await repo.setArchived("C01", true, patched.task.rev);
  assert.equal(archived.conflict, false);
  assert.ok(!archived.conflict);
  out.afterArchive = comparable(archived.task);

  return out;
}

test("markdown and structured boards behave identically", async () => {
  const markdownEnv = await makeBoard("markdown");
  const structuredEnv = await makeBoard("structured");

  const fromMarkdown = await run(markdownEnv);
  const fromStructured = await run(structuredEnv);

  // rawBody is the Markdown rendering and is compared separately below.
  assert.deepEqual(fromStructured, fromMarkdown);

  await fs.rm(markdownEnv.root, { recursive: true, force: true });
  await fs.rm(structuredEnv.root, { recursive: true, force: true });
});

test("a write response matches what a fresh read returns", async () => {
  // detailAfterWrite builds the response from what was just written instead of
  // reading the task back. If the two ever diverge, a client that trusts a
  // mutation response is looking at something the board does not contain.
  for (const format of ["markdown", "structured"] as const) {
    const env = await makeBoard(format);
    const repo = makeRepo(env);

    const before = await repo.read("C01", 20);
    assert.ok(before.valid);
    const appended = await repo.appendObservation("C01", {
      baseRev: before.rev,
      author: "claude",
      text: "Written, then read back.",
    });
    assert.ok(!appended.conflict);
    assert.deepEqual(comparable(appended.task), comparable(await freshRead(repo, "C01")));

    const patched = await repo.patch("C01", {
      baseRev: appended.task.rev,
      fields: { severity: "High" },
      body: { scope: "Rewritten scope." },
    });
    assert.ok(!patched.conflict);
    assert.deepEqual(comparable(patched.task), comparable(await freshRead(repo, "C01")));

    const archived = await repo.setArchived("C01", true, patched.task.rev);
    assert.ok(!archived.conflict);
    assert.deepEqual(comparable(archived.task), comparable(await freshRead(repo, "C01")));

    await fs.rm(env.root, { recursive: true, force: true });
  }
});

async function freshRead(repo: FsTaskRepository, id: string): Promise<TaskDetail> {
  const detail = await repo.read(id, 20);
  assert.ok(detail.valid);
  return detail;
}

test("a structured task renders back to valid, equivalent markdown", async () => {
  const env = await makeBoard("structured");
  const store = new TaskFileStore(env.boardDir, "json", new RecentWrites());

  const rendered = await store.renderMarkdown("C01");
  const reparsed = parseTaskFile(rendered);
  assert.ok(reparsed.ok, `rendered markdown must parse: ${reparsed.ok ? "" : reparsed.error}`);

  const original = parseTaskFile(TASK_MD);
  assert.ok(original.ok);
  assert.deepEqual(reparsed.frontmatter, original.frontmatter);
  assert.deepEqual(
    reparsed.parsed.sections.map((s) => s.heading),
    original.parsed.sections.map((s) => s.heading),
  );

  await fs.rm(env.root, { recursive: true, force: true });
});

test("appending an observation does not rewrite the history file wholesale", async () => {
  const env = await makeBoard("structured");
  const repo = makeRepo(env);
  const file = path.join(env.boardDir, "C01", OBSERVATIONS_FILE);

  const before = await fs.readFile(file, "utf8");
  const detail = await repo.read("C01", 20);
  assert.ok(detail.valid);
  const result = await repo.appendObservation("C01", {
    baseRev: detail.rev,
    author: "claude",
    text: "Appended.",
  });
  assert.ok(!result.conflict);

  const after = await fs.readFile(file, "utf8");
  // The existing bytes are a prefix of the new file: nothing was rewritten.
  assert.ok(after.startsWith(before), "existing observation lines must be untouched");
  assert.equal(after.slice(before.length).trimEnd().split("\n").length, 1);

  await fs.rm(env.root, { recursive: true, force: true });
});

test("auto mode reads whichever format a task is stored in", async () => {
  for (const [format, mode] of [
    ["markdown", "auto"],
    ["structured", "auto"],
  ] as Array<["markdown" | "structured", TaskStoreMode]>) {
    const env = { ...(await makeBoard(format)), taskStore: mode };
    const repo = makeRepo(env);
    const detail = await repo.read("C01", 20);
    assert.ok(detail.valid, `${format} task must be readable in ${mode} mode`);
    assert.equal(detail.observationCount, 3);
    await fs.rm(env.root, { recursive: true, force: true });
  }
});

for (const format of ["markdown", "structured"] as const) {
  test(`${format}: blocker lifecycle survives reload, ignores duplicate writes and rejects stale resolution`, async (t) => {
    const env = await makeBoard(format);
    t.after(() => fs.rm(env.root, { recursive: true, force: true }));
    const repo = makeRepo(env);
    let task = await repo.read("C01", 20);
    assert.ok(task.valid);
    assert.equal(task.blocker, "");
    assert.equal(task.blocked_since, null);
    const started = await repo.patch("C01", { baseRev: task.rev, fields: { blocker: "Waiting for approval" } });
    assert.ok(!started.conflict);
    assert.ok(started.task.blocked_since);
    const since = started.task.blocked_since;
    const stale = await repo.patch("C01", { baseRev: task.rev, fields: { blocker: "" } });
    assert.ok(stale.conflict);
    const duplicate = await repo.patch("C01", { baseRev: started.task.rev, fields: { blocker: "Waiting for approval" } });
    assert.ok(!duplicate.conflict);
    assert.equal(duplicate.task.observationCount, started.task.observationCount);
    const edited = await repo.patch("C01", { baseRev: duplicate.task.rev, fields: { blocker: "Waiting for revised approval" } });
    assert.ok(!edited.conflict);
    assert.equal(edited.task.blocked_since, since);
    const resolved = await repo.patch("C01", { baseRev: edited.task.rev, fields: { blocker: "" } });
    assert.ok(!resolved.conflict);
    task = await makeRepo(env).read("C01", 20);
    assert.ok(task.valid);
    assert.equal(task.blocker, "");
    assert.equal(task.blocked_since, null);
    const events = task.observations.filter((o) => o.markdown.startsWith("Blocker "));
    assert.equal(events.length, 3);
    assert.equal(events[2].changes?.blocker.before, "Waiting for revised approval");
    assert.equal(events[2].started_at, since);
    assert.equal(events[2].resolved_at, events[2].at);
    assert.equal(task.status, "In progress");
  });
}


for (const format of ["markdown", "structured"] as const) {
  test(`${format}: detailed blocker Markdown survives creation, reload and resolution history`, async (t) => {
    const env = await makeBoard(format);
    t.after(() => fs.rm(env.root, { recursive: true, force: true }));
    const repo = makeRepo(env);
    const markdown = "## Waiting for approval\n\n" + "Evidence and attempted fix.\n".repeat(500) + "\n## Required decision\n\nApprove the migration.";
    const archivedDetails = markdown.split("\n").map(line => `> ${line}`).join("\n");
    const created = await repo.create(CreateRequestSchema.parse({ title: "Detailed blocker", category: "Feature", blocker: markdown }));
    const reloaded = await makeRepo(env).read(created.id, 20);
    assert.ok(reloaded.valid);
    assert.equal(reloaded.blocker, markdown);
    assert.ok(reloaded.observations.some(o => o.changes?.blocker.after === markdown));
    assert.ok(blockerExcerpt(markdown).length <= 243);
    assert.ok(!PatchRequestSchema.safeParse({ baseRev: reloaded.rev, fields: { blocker: "x".repeat(100_001) } }).success);
    const resolved = await repo.patch(created.id, { baseRev: reloaded.rev, fields: { blocker: "" } });
    assert.ok(!resolved.conflict);
    assert.equal(resolved.task.blocker, "");
    assert.equal(resolved.task.blocked_since, null);
    assert.ok(resolved.task.observations.some(o => o.markdown.startsWith("Blocker resolved") && o.changes?.blocker.before === markdown));
  });
}

for (const format of ["markdown", "structured"] as const) {
  test(`${format}: status limits, freshness and lossless verified observations`, async t=>{
    const env=await makeBoard(format); t.after(()=>fs.rm(env.root,{recursive:true,force:true}));
    const repo=makeRepo(env); let task=await repo.read("C01",20); assert.ok(task.valid);
    assert.equal(task.status_freshness,"unknown");
    const long="Previous status "+"x".repeat(1000);
    if(format === "structured") {const file=path.join(env.boardDir,"C01/task.json");const raw=JSON.parse(await fs.readFile(file,"utf8"));raw.frontmatter.status_detail=long;await fs.writeFile(file,JSON.stringify(raw));}
    else {const file=path.join(env.boardDir,"C01/task.md");await fs.writeFile(file,(await fs.readFile(file,"utf8")).replace('status_detail: ""',`status_detail: "${long}"`));}
    task=await repo.read("C01",20);assert.ok(task.valid);
    const unchanged=await repo.patch(task.id,{baseRev:task.rev,fields:{status_detail:long,title:"Renamed"}});assert.ok(!unchanged.conflict);
    await assert.rejects(repo.patch(task.id,{baseRev:unchanged.task.rev,fields:{status_detail:"x".repeat(601)}}),/600/);
    await assert.rejects(repo.patch(task.id,{baseRev:unchanged.task.rev,fields:{status_detail:"a\n\nb"}}),/paragraph/);
    const changed=await repo.patch(task.id,{baseRev:unchanged.task.rev,fields:{status_detail:"  Ready for review  "}});assert.ok(!changed.conflict);
    assert.equal(changed.task.status_detail,"Ready for review");assert.equal(changed.task.status_freshness,"fresh");
    assert.equal(changed.task.observations.filter(o=>o.changes?.status_detail?.before === long).length,1);
    const noOp=await repo.patch(task.id,{baseRev:changed.task.rev,fields:{status_detail:" Ready for review "}});assert.ok(!noOp.conflict);assert.equal(noOp.task.rev,changed.task.rev);
    await assert.rejects(repo.appendObservation(task.id,{baseRev:changed.task.rev,text:"Claim",author:"codex",verification:"verified",verification_evidence:" "}),/evidence/);
    const markdown="## Heading\n\n### 2026-01-01T00:00:00Z — fake\nA note with Unicode ✓ and Markdown boundaries.";
    const appended=await repo.appendObservation(task.id,{baseRev:changed.task.rev,text:markdown,author:"codex",at:"2020-01-01T00:00:00Z",verification:"verified",verification_evidence:"Compared both formats; content matched."});assert.ok(!appended.conflict);
    assert.equal(appended.task.status_freshness,"newer_notes");
    const note=appended.task.observations.at(-1)!;assert.equal(note.markdown,markdown);assert.ok(note.id);assert.ok(note.recorded_at);
    const reloaded=await makeRepo(env).observation(task.id,note.id!);assert.deepEqual(reloaded,note);
    const fixed=await repo.patch(task.id,{baseRev:appended.task.rev,fields:{status_detail:"Checked today"}});assert.ok(!fixed.conflict);assert.equal(fixed.task.status_freshness,"fresh");
    const generated=await repo.patch(task.id,{baseRev:fixed.task.rev,fields:{blocker:"Wait"}});assert.ok(!generated.conflict);assert.equal(generated.task.status_freshness,"fresh");
  });
  test(`${format}: communications lifecycle, retries, counts and recurring resets`,async t=>{
    const env=await makeBoard(format);t.after(()=>fs.rm(env.root,{recursive:true,force:true}));const repo=makeRepo(env),workflow=new WorkflowService(repo);
    let task=await repo.create(CreateRequestSchema.parse({title:"Recurring",category:"Feature",recurring:true,priority:"High",next_action:{text:"Review",owner:null,due_date:"2026-12-31"},qa:"User steps",verification:"Old run evidence"}));
    const input=CommunicationMutationSchema.parse({baseRev:task.rev,item_id:"retry_1",fields:{to:" Jason ",channel:"Teams",subject:"Review",body:"Full body"}});
    const draft=await repo.mutateCommunication(task.id,input,true);assert.ok(!draft.conflict);
    assert.equal(draft.task.communication_counts.draft,1);
    const retry=await repo.mutateCommunication(task.id,input,true);assert.ok(!retry.conflict);assert.equal(retry.task.rev,draft.task.rev);
    await assert.rejects(repo.mutateCommunication(task.id,{...input,fields:{...input.fields,subject:"Other"}},true),/different content/);
    assert.equal((await workflow.listCommunications(CommunicationFilterSchema.parse({awaiting_reply:true}))).items.length,0);
    const sent=await repo.mutateCommunication(task.id,CommunicationMutationSchema.parse({baseRev:draft.task.rev,item_id:"retry_1",fields:{state:"sent",sent_at:"2026-09-28T09:00:00-06:00",awaiting_reply:true}}),false);assert.ok(!sent.conflict);
    assert.equal(sent.task.communication_counts.awaiting_reply,1);
    const waiting=await workflow.listCommunications(CommunicationFilterSchema.parse({awaiting_reply:true,to:"jason"}));assert.equal(waiting.items.length,1);assert.ok(!("body" in waiting.items[0]));
    assert.equal((await workflow.getCommunication(task.id,"retry_1")).body,"Full body");
    await assert.rejects(repo.mutateCommunication(task.id,CommunicationMutationSchema.parse({baseRev:sent.task.rev,item_id:"retry_1",fields:{state:"draft",sent_at:null,awaiting_reply:false}}),false),/Sent history/);
    const replied=await repo.mutateCommunication(task.id,CommunicationMutationSchema.parse({baseRev:sent.task.rev,item_id:"retry_1",fields:{state:"replied",replied_at:"2026-09-28T16:00:00Z",awaiting_reply:false}}),false);assert.ok(!replied.conflict);
    assert.equal((await workflow.listCommunications(CommunicationFilterSchema.parse({awaiting_reply:true}))).items.length,0);
    const done=await repo.patch(task.id,{baseRev:replied.task.rev,fields:{status:"Completed"}});assert.ok(!done.conflict);
    const archived=await repo.setArchived(task.id,true,done.task.rev);assert.ok(!archived.conflict);assert.ok(archived.successor);
    assert.equal(archived.successor.priority,"High");assert.equal(archived.successor.next_action,null);assert.equal(archived.successor.communication_count,0);assert.equal(archived.successor.verification,"");assert.equal(archived.successor.qa,"User steps");
  });
  test(`${format}: changed-since stable pages and full observation lookup`,async t=>{
    const env=await makeBoard(format);t.after(()=>fs.rm(env.root,{recursive:true,force:true}));const repo=makeRepo(env),workflow=new WorkflowService(repo);
    let task=await repo.read("C01",20);assert.ok(task.valid);
    for(let i=0;i<3;i++){const r=await repo.appendObservation(task.id,{baseRev:task.rev,text:`New ${i}`,author:"codex"});assert.ok(!r.conflict);task=r.task;}
    const q=ChangesFilterSchema.parse({since:"2020-01-01T00:00:00Z",limit:1});const first=await workflow.listChanges(q);assert.ok(first.next_cursor);
    const later=await repo.appendObservation(task.id,{baseRev:task.rev,text:"Concurrent append",author:"codex"});assert.ok(!later.conflict);
    const all=[...first.items];let cursor:string|null=first.next_cursor;
    while(cursor){const page=await workflow.listChanges({...q,cursor});assert.equal(page.until,first.until);all.push(...page.items);cursor=page.next_cursor;}
    assert.equal(new Set(all.map(i=>i.id)).size,all.length);assert.ok(!all.some(i=>i.excerpt === "Concurrent append"));
    const item=all.find(i=>i.excerpt === "New 0")!;assert.equal((await repo.observation(item.task_id,item.observation_id!)).markdown,"New 0");
    await assert.rejects(workflow.listChanges({...q,cursor:first.next_cursor!,project:"Other"}),/filters changed/);
    await assert.rejects(new WorkflowService(repo).listChanges({...q,cursor:first.next_cursor!}),/expired/);
  });
  test(`${format}: cancellation migration rejects stale previews, resumes and rolls back exact bytes`,async t=>{
    const env=await makeBoard(format);t.after(()=>fs.rm(env.root,{recursive:true,force:true}));const config=new ConfigService(env);
    await config.update({...config.get(),statuses:[...config.get().statuses,{id:"Depricated",label:"Cancel",color:"#123456",order:7}],board:{hiddenColumns:["Depricated"]}});
    const repo=makeRepo(env);let task=await repo.read("C01",20);assert.ok(task.valid);
    const cancelled=await repo.patch(task.id,{baseRev:task.rev,fields:{status:"Depricated"}});assert.ok(!cancelled.conflict);
    const service=new StatusMigrationService(env,config,repo),input=StatusMigrationSchema.parse({task_id:"C01"});
    const preview=await service.run(input);assert.ok("preview_hash" in preview);
    const edit=await repo.patch(task.id,{baseRev:cancelled.task.rev,fields:{title:"Changed since preview"}});assert.ok(!edit.conflict);
    await assert.rejects(service.run({...input,mode:"apply",preview_hash:preview.preview_hash}),/Preview changed/);
    const before=await fs.readFile(path.join(env.boardDir,"C01",format === "markdown" ? "task.md" : "task.json"),"utf8");
    const ready=await service.run(input);assert.ok("preview_hash" in ready);
    const applied=await service.run({...input,mode:"apply",preview_hash:ready.preview_hash});assert.ok("state" in applied);assert.equal(applied.state,"applied");
    const reloaded=await repo.read("C01",20);assert.ok(reloaded.valid);assert.equal(reloaded.status,"Cancelled");assert.equal(reloaded.completed,undefined);assert.equal(config.get().statusAliases?.Depricated,"Cancelled");
    const resumed=await service.run({...input,mode:"resume",operation_id:applied.operation_id});assert.ok("state" in resumed);assert.equal(resumed.state,"applied");
    const again=await service.run(input);assert.ok("files" in again);assert.deepEqual(again.files,[]);
    await service.run({...input,mode:"rollback",operation_id:applied.operation_id});
    assert.equal(await fs.readFile(path.join(env.boardDir,"C01",format === "markdown" ? "task.md" : "task.json"),"utf8"),before);
  });
}

test("patch adapters reject ambiguity and unknown keys, preserve clear/omit semantics",()=>{
  assert.deepEqual(PatchRequestSchema.parse({baseRev:1,summary:"",body:{summaryMarkdown:""},priority:"High"}),{baseRev:1,fields:{priority:"High"},body:{summary:""}});
  assert.equal(PatchRequestSchema.safeParse({baseRev:1,summary:"a",body:{summary:"b"}}).success,false);
  assert.equal(PatchRequestSchema.safeParse({baseRev:1,fields:{wat:1}}).success,false);
  assert.equal(PatchRequestSchema.safeParse({baseRev:1,unknown:"x"}).success,false);
  assert.equal(CreateRequestSchema.safeParse({title:"Bad date",category:"Feature",next_action:{text:"Do",due_date:"2026-02-30"}}).success,false);
});

test("cancellation migration preserves canonical settings, excludes invalid files, resumes partial apply and guards rollback", async t => {
  const env = await makeBoard("structured");
  t.after(() => fs.rm(env.root, { recursive: true, force: true }));
  const config = new ConfigService(env);
  await config.update({ ...config.get(), statuses: [...config.get().statuses,
    { id: "Depricated", label: "Cancel", color: "#123456", order: 7 },
    { id: "Cancelled", label: "Cancelled", color: "#abcdef", order: 8 }], board: { hiddenColumns: ["Depricated"] } });
  const repo = makeRepo(env);
  const original = await repo.read("C01", 20); assert.ok(original.valid);
  await repo.patch("C01", { baseRev: original.rev, fields: { status: "Depricated" } });
  const invalidDir = path.join(env.boardDir, "C02"); await fs.mkdir(invalidDir);
  await fs.writeFile(path.join(invalidDir, "task.json"), "invalid fixture");
  const service = new StatusMigrationService(env, config, repo);
  const input = StatusMigrationSchema.parse({ task_id: "C01" });
  const preview = await service.run(input); assert.ok("preview_hash" in preview);
  assert.equal(preview.collision, true); assert.equal(preview.chosen_status.color, "#abcdef");
  assert.deepEqual(preview.invalid, ["C02"]);
  await assert.rejects(service.run({ ...input, mode: "apply", preview_hash: preview.preview_hash }), /invalid tasks/);
  const excluded = { ...input, exclude_invalid: ["C02"] };
  const ready = await service.run(excluded); assert.ok("preview_hash" in ready);
  const applied = await service.run({ ...excluded, mode: "apply", preview_hash: ready.preview_hash }); assert.ok("backup" in applied);
  assert.equal(await fs.readFile(path.join(invalidDir, "task.json"), "utf8"), "invalid fixture");
  assert.deepEqual(config.get().board?.hiddenColumns, ["Cancelled"]);
  const journal = JSON.parse(await fs.readFile(applied.backup, "utf8"));
  // Reconstruct a process interruption after one of the prepared writes.
  for (const change of journal.changes.slice(1)) {
    const target = path.join(env.root, change.relative);
    if (change.before === null) await fs.unlink(target); else await fs.writeFile(target, change.before);
  }
  journal.state = "prepared"; await fs.writeFile(applied.backup, JSON.stringify(journal));
  const resumed = await service.run({ ...excluded, mode: "resume", operation_id: applied.operation_id }); assert.ok("state" in resumed);
  assert.equal(resumed.state, "applied");
  const taskPath = path.join(env.boardDir, "C01", "task.json");
  const migrated = await fs.readFile(taskPath, "utf8");
  await fs.writeFile(taskPath, migrated + "\n");
  await assert.rejects(service.run({ ...excluded, mode: "rollback", operation_id: applied.operation_id }), /outside this migration/);
  assert.equal(config.get().statusAliases?.Depricated, "Cancelled");
  await fs.writeFile(taskPath, migrated);
  await service.run({ ...excluded, mode: "rollback", operation_id: applied.operation_id });
  const restored = await repo.read("C01", 20); assert.ok(restored.valid); assert.equal(restored.status, "Depricated");
});

test("cancellation migration repairs existing aliases that target the old status", async t => {
  const env = await makeBoard("structured");
  t.after(() => fs.rm(env.root, { recursive: true, force: true }));
  const config = new ConfigService(env);
  await config.update({ ...config.get(), statuses: [...config.get().statuses,
    { id: "Depricated", label: "Cancel", color: "#123456", order: 7 }],
    statusAliases: { Cancelled: "Depricated", Obsolete: "Depricated" } });
  const repo = makeRepo(env);
  const task = await repo.read("C01", 20); assert.ok(task.valid);
  await repo.patch(task.id, { baseRev: task.rev, fields: { status: "Depricated" } });
  const service = new StatusMigrationService(env, config, repo);
  const input = StatusMigrationSchema.parse({ task_id: "C01" });
  const preview = await service.run(input); assert.ok("preview_hash" in preview);
  const applied = await service.run({ ...input, mode: "apply", preview_hash: preview.preview_hash });
  assert.ok("operation_id" in applied);
  assert.deepEqual(config.get().statusAliases, { Obsolete: "Cancelled", Depricated: "Cancelled" });
  assert.equal(repo.canonicalStatus("Obsolete"), "Cancelled");
  await service.run({ ...input, mode: "rollback", operation_id: applied.operation_id! });
  assert.deepEqual(config.get().statusAliases, { Cancelled: "Depricated", Obsolete: "Depricated" });
});

test("priority removal checks current settings from other writers", async t => {
  const env = await makeBoard("structured");
  t.after(() => fs.rm(env.root, { recursive: true, force: true }));
  const staleConfig = new ConfigService(env);
  const savedSettings = staleConfig.get();
  const writer = new ConfigService(env);
  await writer.update({ ...writer.get(), priorities: [...writer.get().priorities!,
    { id: "Review", color: "#123456", rank: 1 }] });
  const repo = makeRepo(env);
  await repo.create(CreateRequestSchema.parse({ title: "Uses a new priority", category: "Feature", priority: "Review" }));
  await assert.rejects(staleConfig.update(savedSettings), /Priority Review is used/);
  assert.ok(new ConfigService(env).get().priorities!.some(p => p.id === "Review"));
});

for (const format of ["markdown", "structured"] as const) {
  test(`${format}: direct history edits invalidate freshness until status is reviewed`, async t => {
    const env = await makeBoard(format);
    t.after(() => fs.rm(env.root, { recursive: true, force: true }));
    const repo = makeRepo(env);
    const initial = await repo.read("C01"); assert.ok(initial.valid);
    const status = await repo.patch(initial.id, { baseRev: initial.rev, fields: { status_detail: "Checked status" } });
    assert.ok(!status.conflict); assert.equal(status.task.status_freshness, "fresh");
    if (format === "markdown") await fs.appendFile(path.join(env.boardDir, "C01/task.md"), "\n### 2020-01-01T00:00:00Z — human\n\nBackdated external note.\n");
    else await fs.appendFile(path.join(env.boardDir, "C01/observations.jsonl"), JSON.stringify({ id: "obs_external", at: "2020-01-01T00:00:00Z", author: "human", markdown: "Backdated external note." }) + "\n");
    const external = await repo.read(initial.id); assert.ok(external.valid);
    assert.equal(external.status_freshness, "unknown");
    const reviewed = await repo.patch(initial.id, { baseRev: external.rev, fields: { status_detail: "Reviewed external note" } });
    assert.ok(!reviewed.conflict);
    const reloaded = await makeRepo(env).read(initial.id); assert.ok(reloaded.valid);
    assert.equal(reloaded.status_freshness, "fresh");
  });

  test(`${format}: planning filters preserve ranked dates, closed states, backlog and reopening`, async t => {
    const env = await makeBoard(format);
    t.after(() => fs.rm(env.root, { recursive: true, force: true }));
    const config = new ConfigService(env);
    await config.update({ ...config.get(), statuses: [...config.get().statuses,
      { id: "Cancelled", color: "#123456" }], statusAliases: { Depricated: "Cancelled" } });
    const repo = makeRepo(env), service = new TaskService(repo);
    const make = (title: string, priority: string, date: string | null, status = "Backlog") =>
      repo.create(CreateRequestSchema.parse({ title, category: "Feature", priority, status,
        next_action: { text: "Review", owner: null, due_date: date } }));
    const urgent = await make("Urgent tomorrow", "Urgent", "2027-01-01");
    const early = await make("High overdue", "High", "2026-12-31");
    const high = await make("High tomorrow", "High", "2027-01-01");
    const undated = await make("High undated", "High", null);
    const done = await make("Completed tomorrow", "High", "2027-01-01", "Completed");
    const cancelled = await make("Cancelled tomorrow", "High", "2027-01-01", "Depricated");
    const archived = await make("Archived tomorrow", "High", "2027-01-01");
    await repo.setArchived(archived.id, true, archived.rev);
    const list = async (filter: object) => (await service.list(TaskFilterSchema.parse(filter))).map(t => t.id);
    assert.deepEqual(await list({ has_next_action: true, sort: "priority" }), [urgent.id, early.id, high.id, undated.id]);
    const tomorrow = { has_next_action: true, sort: "priority", next_action_date_from: "2027-01-01", next_action_date_to: "2027-01-01" };
    assert.deepEqual(await list(tomorrow), [urgent.id, high.id]);
    assert.deepEqual(await list({ ...tomorrow, include_closed: true }), [urgent.id, high.id, done.id, cancelled.id]);
    assert.deepEqual(await list({ action_undated: true }), [undated.id]);
    assert.deepEqual(await list({ next_action_date_to: "2026-12-31" }), [early.id]);
    assert.deepEqual(await list({ status: ["Depricated"] }), [cancelled.id]);
    assert.deepEqual(await list({ ...tomorrow, next_action_owner: "Francis" }), []);
    assert.deepEqual(await list({ ...tomorrow, next_action_owner: "" }), [urgent.id, high.id]);
    await repo.patch(done.id, { baseRev: done.rev, fields: { status: "In progress" } });
    assert.deepEqual(await list(tomorrow), [urgent.id, high.id, done.id]);
    const cleared = await repo.patch(high.id, { baseRev: high.rev, fields: { next_action: null } });
    assert.ok(!cleared.conflict);
    assert.equal(cleared.task.observations.at(-1)?.changes?.next_action.after, null);
    assert.deepEqual(await list(tomorrow), [urgent.id, done.id]);
    await assert.rejects(config.update({ ...config.get(), priorities: config.get().priorities!.filter(p => p.id !== "High") }), /is used/);
    await assert.rejects(config.update({ ...config.get(), priorities: config.get().priorities!.filter(p => p.id !== "Normal") }), /Normal default/);
  });

  test(`${format}: exports and conversion retain evidence, planning and communication facts`, async t => {
    const env = await makeBoard(format);
    t.after(() => fs.rm(env.root, { recursive: true, force: true }));
    const repo = makeRepo(env);
    const created = await repo.create(CreateRequestSchema.parse({ title: "Portable workflow", category: "Feature",
      priority: "High", next_action: { text: "Review results", owner: "Francis", due_date: "2027-01-01" },
      qa: "User reproduction steps", verification: "Executed checks", blocker: "First blocker\nSecond line" }));
    const noted = await repo.appendObservation(created.id, { baseRev: created.rev, author: "codex", text: "A verified result",
      verification: "verified", verification_evidence: "Compared fixture contents; matched." });
    assert.ok(!noted.conflict);
    const message = await repo.mutateCommunication(created.id, CommunicationMutationSchema.parse({ baseRev: noted.task.rev,
      item_id: "portable_message", fields: { to: "Jason", channel: "Teams", subject: "Draft subject", body: "Draft body" } }), true);
    assert.ok(!message.conflict);
    const store = new TaskFileStore(env.boardDir, env.taskStore, new RecentWrites());
    const parsed = parseTaskFile(await store.renderMarkdown(created.id)); assert.ok(parsed.ok);
    const converted = structuredFromLegacy(parsed);
    assert.equal(converted.task.frontmatter.priority, "High");
    assert.equal(converted.task.frontmatter.next_action?.due_date, "2027-01-01");
    assert.equal(converted.task.frontmatter.communications[0].body, "Draft body");
    const note = converted.observations.find(o => o.markdown === "A verified result")!;
    assert.equal(note.id, noted.task.observations.at(-1)?.id);
    assert.equal(note.verification_evidence, "Compared fixture contents; matched.");
    assert.equal(note.verification, "verified");
    const output = await new ExportService(env, repo).buildAndSave({ includeScope: true, includeObservations: true, groupBy: "none" });
    for (const text of ["User reproduction steps", "Executed checks", "Review results", "Draft body", "Verification: verified",
      "Compared fixture contents; matched.", "First blocker", "Second line"]) assert.ok(output.markdown.includes(text), text);
  });
}
