import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Env } from "./env";
import { ConfigService } from "./config";

const template = `${JSON.stringify({
  idPrefix: "C",
  idPad: 2,
  statuses: [
    { id: "Backlog", label: "Backlog", color: "#94a3b8" },
    { id: "Completed", label: "Completed", color: "#22c55e" },
  ],
  categories: [{ id: "Feature", label: "Feature", color: "#22c55e" }],
  severities: [{ id: "Medium", label: "Medium", color: "#eab308" }],
  risks: [{ id: "Low", label: "Low", color: "#22c55e" }],
  card: { colorBy: "category" },
  skills: [],
}, null, 2)}\n`;

async function fixture(): Promise<{ env: Env; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "aidailytasks-config-"));
  const env: Env = {
    root,
    boardDir: path.join(root, "board"),
    exportsDir: path.join(root, "exports"),
    graphsDir: path.join(root, "graphs"),
    projectDocsDir: path.join(root, "project-docs"),
    configPath: path.join(root, "board.config.json"),
    configTemplatePath: path.join(root, "board.config.json.template"),
    projectsPath: path.join(root, "projects.json"),
    webDistDir: path.join(root, "dist"),
    port: 4317,
    host: "127.0.0.1",
  };
  await writeFile(env.configTemplatePath, template, "utf8");
  return { env, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("seeds a missing local config as an exact template copy", async (t) => {
  const { env, cleanup } = await fixture();
  t.after(cleanup);
  new ConfigService(env);
  assert.deepEqual(await readFile(env.configPath), await readFile(env.configTemplatePath));
});

test("preserves an existing local config", async (t) => {
  const { env, cleanup } = await fixture();
  t.after(cleanup);
  const local = template.replace('"idPad": 2', '"idPad": 4');
  await writeFile(env.configPath, local, "utf8");
  new ConfigService(env);
  assert.equal(await readFile(env.configPath, "utf8"), local);
});
