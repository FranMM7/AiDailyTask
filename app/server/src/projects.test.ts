import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Env } from "./env";
import { EventBus } from "./infrastructure/eventBus";
import { ProjectsService } from "./projects";
import { NotFoundError, ValidationError } from "./errors";

async function fixture(): Promise<{ svc: ProjectsService; env: Env; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "aidailytasks-projects-"));
  const env = { projectsPath: path.join(root, "projects.json") } as Env;
  const svc = new ProjectsService(env, new EventBus());
  await svc.ensureFile();
  return { svc, env, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("add appends a project and refuses a duplicate id", async () => {
  const { svc, cleanup } = await fixture();
  try {
    const projects = await svc.add({ id: "Alpha", label: "Alpha Project" });
    assert.ok(projects.some((p) => p.id === "Alpha" && p.label === "Alpha Project"));
    await assert.rejects(svc.add({ id: "alpha" }), ValidationError); // case-insensitive dedupe
  } finally {
    await cleanup();
  }
});

test("update edits label/root and keeps the id immutable", async () => {
  const { svc, cleanup } = await fixture();
  try {
    await svc.add({ id: "Alpha" });
    const projects = await svc.update("Alpha", { label: "Renamed", root: "C:\\src\\alpha" });
    const alpha = projects.find((p) => p.id === "Alpha");
    assert.equal(alpha?.label, "Renamed");
    assert.equal(alpha?.root, "C:\\src\\alpha");
    await assert.rejects(svc.update("Missing", { label: "x" }), NotFoundError);
  } finally {
    await cleanup();
  }
});

test("remove deletes an unused project and persists the change", async () => {
  const { svc, env, cleanup } = await fixture();
  try {
    await svc.add({ id: "Alpha" });
    await svc.add({ id: "Beta" });
    const projects = await svc.remove("Alpha", 0);
    assert.ok(!projects.some((p) => p.id === "Alpha"));
    assert.ok(projects.some((p) => p.id === "Beta"));
    const onDisk = JSON.parse(await readFile(env.projectsPath, "utf8")) as { id: string }[];
    assert.ok(!onDisk.some((p) => p.id === "Alpha"));
  } finally {
    await cleanup();
  }
});

test("remove refuses while tasks still use the project, and for unknown ids", async () => {
  const { svc, cleanup } = await fixture();
  try {
    await svc.add({ id: "Alpha" });
    await assert.rejects(svc.remove("Alpha", 3), ValidationError);
    assert.ok(svc.list().some((p) => p.id === "Alpha")); // untouched after the refusal
    await assert.rejects(svc.remove("Missing", 0), NotFoundError);
  } finally {
    await cleanup();
  }
});
