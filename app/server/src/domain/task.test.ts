import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ConfigService } from "../config";
import type { Env } from "../env";
import { EventBus } from "../infrastructure/eventBus";
import { AttachmentStore } from "../infrastructure/attachmentStore";
import { FsTaskRepository } from "../infrastructure/taskRepository";
import { RecentWrites } from "../infrastructure/recentWrites";
import {
  getSection,
  parseBody,
  parseTaskFile,
  serializeBody,
  serializeTaskFile,
  setSection,
  toTaskDetail,
} from "./task";

const FM = `---
id: C01
title: QA section round-trip
project: Sample
category: Feature
severity: Medium
risk: Low
status: Scoped
status_detail: ""
created: 2026-07-28
updated: 2026-07-28
tags: []
skills: []
recurring: false
recurrence_of: null
depends_on: []
blocks: []
relates_to: []
parent: null
children: []
sources: []
resources:
  - id: monthly_query
    title: Monthly query
    kind: query
    order: 0
    language: sql
    content: SELECT 1
---`;

test("a '## QA' body section parses and surfaces as qaMarkdown", () => {
  const raw = `${FM}

## Summary

One line.

## QA

1. Open the app
2. Expect the tab

## Observations
`;
  const parsed = parseTaskFile(raw);
  assert.ok(parsed.ok);
  assert.equal(getSection(parsed.parsed, "QA"), "1. Open the app\n2. Expect the tab");

  const detail = toTaskDetail({
    fm: parsed.frontmatter,
    rev: 1,
    parsed: parsed.parsed,
    rawBody: parsed.body,
    attachments: [],
  });
  assert.equal(detail.qaMarkdown, "1. Open the app\n2. Expect the tab");
});

test("qaMarkdown is empty when the task has no QA section", () => {
  const raw = `${FM}

## Summary

One line.
`;
  const parsed = parseTaskFile(raw);
  assert.ok(parsed.ok);
  const detail = toTaskDetail({
    fm: parsed.frontmatter,
    rev: 1,
    parsed: parsed.parsed,
    rawBody: parsed.body,
    attachments: [],
  });
  assert.equal(detail.qaMarkdown, "");
});

test("setSection adds QA to a body without one and round-trips through serialize/parse", () => {
  const body = parseBody("## Summary\n\nS.\n\n## Scope\n\nSc.\n\n## Observations");
  const withQa = setSection(body, "QA", "Steps:\n\n1. Do the thing");
  const serialized = serializeBody(withQa);
  assert.ok(serialized.includes("## QA"));

  const reparsed = parseBody(serialized);
  assert.equal(getSection(reparsed, "QA"), "Steps:\n\n1. Do the thing");
  // Existing sections are untouched.
  assert.equal(getSection(reparsed, "Summary"), "S.");
  assert.equal(getSection(reparsed, "Scope"), "Sc.");
});

test("setSection with an empty string clears QA content but keeps other sections intact", () => {
  const body = parseBody("## Summary\n\nS.\n\n## QA\n\nold steps\n\n## Observations");
  const cleared = setSection(body, "QA", "");
  const reparsed = parseBody(serializeBody(cleared));
  assert.equal(getSection(reparsed, "QA"), "");
  assert.equal(getSection(reparsed, "Summary"), "S.");
});

test("a full task file with QA survives serializeTaskFile -> parseTaskFile", () => {
  const parsed = parseTaskFile(`${FM}\n\n## Summary\n\nS.\n`);
  assert.ok(parsed.ok);
  const withQa = setSection(parsed.parsed, "QA", "Manual pass:\n\n- step one");
  const raw = serializeTaskFile(parsed.frontmatter, withQa);
  const reparsed = parseTaskFile(raw);
  assert.ok(reparsed.ok);
  assert.equal(getSection(reparsed.parsed, "QA"), "Manual pass:\n\n- step one");
});

test("ordered task resources survive frontmatter serialization", () => {
  const parsed = parseTaskFile(`${FM}\n\n## Summary\n\nS.\n`);
  assert.ok(parsed.ok);
  assert.equal(parsed.frontmatter.resources[0]?.title, "Monthly query");
  const reparsed = parseTaskFile(serializeTaskFile(parsed.frontmatter, parsed.parsed));
  assert.ok(reparsed.ok);
  assert.deepEqual(reparsed.frontmatter.resources, parsed.frontmatter.resources);
});

test("recurring successor retains resource files but not ordinary attachments", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aidailytasks-resources-"));
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
  const env: Env = {
    root,
    boardDir: path.join(root, "board"),
    exportsDir: path.join(root, "exports"),
    graphsDir: path.join(root, "graphs"),
    projectDocsDir: path.join(root, "project-docs"),
    configPath: path.join(root, "board.config.json"),
    configTemplatePath: path.join(repoRoot, "board.config.json.template"),
    projectsPath: path.join(root, "projects.json"),
    webDistDir: path.join(root, "dist"),
    port: 0,
    host: "127.0.0.1",
  };

  try {
    await fs.mkdir(env.boardDir, { recursive: true });
    const attachments = new AttachmentStore(env);
    const resourceFiles = new AttachmentStore(env, "resources", "resources/files");
    const repo = new FsTaskRepository(env, new ConfigService(env), attachments, resourceFiles, new EventBus(), new RecentWrites());
    const source = await repo.create({
      title: "Recurring close",
      project: "Sample",
      category: "Feature",
      severity: "Medium",
      risk: "Low",
      status: "Completed",
      status_detail: "",
      tags: [], skills: [], recurring: true,
      depends_on: [], blocks: [], relates_to: [], parent: null,
      resources: [{ id: "close_script", title: "Close script", kind: "script", order: 0, language: "powershell", content: "Write-Output close" }, { id: "guide", title: "Guide", kind: "file", order: 1, fileName: "guide.txt" }],
      summary: "", scope: "", qa: "",
    });
    await attachments.save(source.id, "evidence.log", Buffer.from("one-off evidence"));
    await resourceFiles.save(source.id, "guide.txt", Buffer.from("durable guide"));

    const archived = await repo.setArchived(source.id, true, source.rev);
    assert.equal(archived.conflict, false);
    assert.ok(archived.successor);
    assert.deepEqual(archived.successor.resources, source.resources);
    assert.equal(archived.successor.attachments.length, 0);
    assert.equal(archived.successor.resourceFiles.length, 1);
    assert.equal(archived.successor.resourceFiles[0]?.name, "guide.txt");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
