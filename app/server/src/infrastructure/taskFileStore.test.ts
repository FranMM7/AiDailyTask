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
import type { TaskDetail } from "@AiDailyTasks/shared";
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
  const { rev: _rev, updatedEffective: _updatedEffective, ...rest } = detail;
  return {
    ...rest,
    observations: rest.observations.map((observation) =>
      GENERATED_NOTE.test(observation.markdown) ? { ...observation, at: "<generated>" } : observation,
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
