import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import Fastify from "fastify";
import { ShareController, registerShareRoutes } from "./share";
import { waitForPublicUrl } from "../../tools/share";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

function worker() {
  const child = new EventEmitter() as ChildProcess;
  Object.assign(child, { connected: true, stdout: new PassThrough(), send(message: { type: string }, callback?: () => void) {
    if (message.type === "stop") queueMicrotask(() => child.emit("exit", 0));
    callback?.(); return true;
  } });
  return child;
}

test("share lifecycle rejects duplicates, hides stale URLs and supports stop, expiry and failure retry", async () => {
  let child = worker();
  const controller = new ShareController(() => child);
  assert.equal(controller.start({ minutes: 1 }, 4317).phase, "starting");
  assert.throws(() => controller.start({ minutes: 1 }, 4317), /already running/);
  child.emit("message", { type: "ready", url: "https://fixture.ngrok.app", expiresAt: new Date(Date.now() + 60000).toISOString() });
  assert.equal(controller.state.phase, "active");
  assert.equal((await controller.stop()).phase, "idle");
  assert.equal(controller.state.url, null);
  child = worker(); controller.start({ minutes: 1 }, 4317);
  child.emit("message", { type: "ready", url: "https://fixture.ngrok.app", expiresAt: new Date().toISOString() });
  child.emit("exit", 0); // Worker owns its expiry timer.
  assert.equal(controller.state.phase, "idle");
  child = worker(); controller.start({ minutes: 1 }, 4317);
  child.emit("message", { type: "error", message: "Account configuration failed" }); child.emit("exit", 1);
  assert.equal(controller.state.phase, "error"); assert.equal(controller.state.url, null);
  child = worker(); controller.start({ minutes: 1 }, 4317);
  const stopped = controller.stop();
  child.emit("message", { type: "ready", url: "https://late.ngrok.app", expiresAt: new Date().toISOString() });
  assert.equal(controller.state.phase, "stopping"); await stopped;
});

test("ngrok startup handles HTTPS, log errors, process errors, early exits and timeout", async () => {
  const child = worker(); const ready = waitForPublicUrl(child);
  child.stdout!.emit("data", 'msg="started tunnel" url=https://fixture.ngrok.app\n');
  assert.equal(await ready, "https://fixture.ngrok.app");
  for (const kind of ["log", "error", "exit", "timeout"]) {
    const failed = worker(); const result = waitForPublicUrl(failed, 10);
    if (kind === "log") failed.stdout!.emit("data", 'lvl=eror err="bad credentials"\n');
    if (kind === "error") failed.emit("error", new Error("ENOENT"));
    if (kind === "exit") failed.emit("exit", 1);
    await assert.rejects(result);
    assert.equal(failed.listenerCount("exit"), 0);
  }
});

test("share HTTP validates lifetime, denies remote/forwarded/cross-origin controls and stops on shutdown", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "share-http-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, "index.html"), "fixture");
  let installed = true;
  const child = worker(); const controller = new ShareController(() => child);
  const app = Fastify(); registerShareRoutes(app, 4317, dir, controller, async () => installed);
  const headers = { host: "127.0.0.1:4317", origin: "http://127.0.0.1:4317" };
  for (const bad of [{host:"public.ngrok.app"},{origin:"https://evil.example"},{"x-forwarded-for":"127.0.0.1"},{"forwarded":"for=127.0.0.1"},{"sec-fetch-site":"cross-site"}]) {
    for (const method of ["GET", "POST", "DELETE"] as const) {
      assert.equal((await app.inject({method,url:"/api/share",headers:{...headers,...bad},...(method === "POST" ? {payload:{minutes:30}} : {})})).statusCode,403);
    }
  }
  for (const minutes of [0,-1,1.5,1441,"30"]) assert.equal((await app.inject({method:"POST",url:"/api/share",headers,payload:{minutes}})).statusCode,400);
  installed = false;
  assert.equal((await app.inject({method:"POST",url:"/api/share",headers,payload:{minutes:30}})).statusCode,409);
  installed = true;
  assert.equal((await app.inject({method:"POST",url:"/api/share",headers,payload:{minutes:30}})).statusCode,202);
  assert.equal((await app.inject({method:"POST",url:"/api/share",headers,payload:{minutes:30}})).statusCode,409);
  await app.close(); assert.equal(controller.state.phase,"idle");
});
