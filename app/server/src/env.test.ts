import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadEnv, resolveDataRoot } from "./env";

test("data location defaults, pointer, override and app paths stay consistent", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aidt-paths-"));
  const previousRoot = process.env.AiDailyTasks_ROOT;
  const previousData = process.env.AIDAILYTASKS_DATA_ROOT;
  try {
    process.env.AiDailyTasks_ROOT = root;
    delete process.env.AIDAILYTASKS_DATA_ROOT;
    assert.equal(resolveDataRoot(root), root);
    fs.writeFileSync(path.join(root, "storage.local.json"), JSON.stringify({ dataRoot: "private-data" }));
    assert.throws(() => loadEnv(), /ENOENT/);
    fs.mkdirSync(path.join(root, "private-data"));
    const env = loadEnv();
    assert.equal(env.boardDir, path.join(root, "private-data", "board"));
    assert.equal(env.projectsPath, path.join(root, "private-data", "projects.json"));
    assert.equal(env.projectDocsDir, path.join(root, "private-data", "project-docs"));
    assert.equal(env.configPath, path.join(root, "private-data", "board.config.json"));
    assert.equal(env.webDistDir, path.join(root, "app", "web", "dist"));
    assert.equal(env.configTemplatePath, path.join(root, "board.config.json.template"));
    assert.equal(env.root, root);
    fs.mkdirSync(path.join(root, "override"));
    process.env.AIDAILYTASKS_DATA_ROOT = path.join(root, "override");
    assert.equal(loadEnv().boardDir, path.join(root, "override", "board"));
    delete process.env.AIDAILYTASKS_DATA_ROOT;
    fs.writeFileSync(path.join(root, "storage.local.json"), "null");
    assert.throws(() => loadEnv(), /dataRoot/);
    fs.writeFileSync(path.join(root, "storage.local.json"), "{");
    assert.throws(() => loadEnv(), SyntaxError);
  } finally {
    if (previousRoot === undefined) delete process.env.AiDailyTasks_ROOT;
    else process.env.AiDailyTasks_ROOT = previousRoot;
    if (previousData === undefined) delete process.env.AIDAILYTASKS_DATA_ROOT;
    else process.env.AIDAILYTASKS_DATA_ROOT = previousData;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
