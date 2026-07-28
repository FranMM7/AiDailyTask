import assert from "node:assert/strict";
import test from "node:test";
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
