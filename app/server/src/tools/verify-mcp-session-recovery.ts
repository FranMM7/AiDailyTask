import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const serverCwd = path.join(repoRoot, "app", "server");
const tsxCli = path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");

interface RunningServer {
  child: ChildProcess;
  output: () => string;
}

interface Health {
  status: string;
  activeSessions: number;
  pid: number;
}

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert(address && typeof address === "object");
      const { port } = address;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function readHealth(baseUrl: string): Promise<Health> {
  const response = await fetch(`${baseUrl}/api/mcp-health`);
  assert.equal(response.status, 200);
  return (await response.json()) as Health;
}

async function startServer(root: string, port: number): Promise<RunningServer> {
  let logs = "";
  const child = spawn(process.execPath, [tsxCli, "src/main.ts"], {
    cwd: serverCwd,
    env: { ...process.env, PORT: String(port), AiDailyTasks_ROOT: root },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk) => { logs += String(chunk); });
  child.stderr?.on("data", (chunk) => { logs += String(chunk); });

  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`MCP test server exited early (${child.exitCode})\n${logs}`);
    try {
      await readHealth(baseUrl);
      return { child, output: () => logs };
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  child.kill();
  throw new Error(`Timed out starting MCP test server\n${logs}`);
}

async function stopServer(server: RunningServer): Promise<void> {
  if (server.child.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => server.child.once("exit", () => resolve()));
  server.child.kill("SIGTERM");
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
  if (server.child.exitCode === null) {
    server.child.kill("SIGKILL");
    await exited;
  }
}

function requestHeaders(sessionId?: string): Record<string, string> {
  return {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    ...(sessionId ? { "mcp-session-id": sessionId } : {}),
  };
}

async function initialize(baseUrl: string, clientName: string): Promise<string> {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: requestHeaders(),
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: clientName, version: "1.0.0" },
      },
    }),
  });
  const body = await response.text();
  assert.equal(response.status, 200, body);
  assert.match(body, /"result"/);
  const sessionId = response.headers.get("mcp-session-id");
  assert(sessionId, "Initialization response omitted mcp-session-id");

  const initialized = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: requestHeaders(sessionId),
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  assert.equal(initialized.status, 202, await initialized.text());
  return sessionId;
}

async function listTools(baseUrl: string, sessionId: string, id: number): Promise<void> {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: requestHeaders(sessionId),
    body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/list", params: {} }),
  });
  const body = await response.text();
  assert.equal(response.status, 200, body);
  assert.match(body, /"tools"/);
}

async function sessionStatus(
  baseUrl: string,
  method: "POST" | "GET" | "DELETE",
  sessionId?: string,
): Promise<number> {
  const response = await fetch(`${baseUrl}/mcp`, {
    method,
    headers: method === "GET" || method === "DELETE"
      ? { accept: "text/event-stream", ...(sessionId ? { "mcp-session-id": sessionId } : {}) }
      : requestHeaders(sessionId),
    ...(method === "POST"
      ? { body: JSON.stringify({ jsonrpc: "2.0", id: 99, method: "tools/list", params: {} }) }
      : {}),
  });
  await response.text();
  return response.status;
}

const testRoot = await mkdtemp(path.join(tmpdir(), "aidailytasks-mcp-recovery-"));
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;
let server: RunningServer | undefined;

try {
  await copyFile(path.join(repoRoot, "board.config.json"), path.join(testRoot, "board.config.json"));
  server = await startServer(testRoot, port);
  const firstPid = (await readHealth(baseUrl)).pid;

  assert.equal(await sessionStatus(baseUrl, "POST"), 400, "Missing POST session id must remain 400");
  assert.equal(await sessionStatus(baseUrl, "GET"), 400, "Missing GET session id must remain 400");
  assert.equal(await sessionStatus(baseUrl, "DELETE"), 400, "Missing DELETE session id must remain 400");
  assert.equal(await sessionStatus(baseUrl, "POST", "unknown-session"), 404);
  assert.equal(await sessionStatus(baseUrl, "GET", "unknown-session"), 404);
  assert.equal(await sessionStatus(baseUrl, "DELETE", "unknown-session"), 404);

  const originalSessions = await Promise.all([
    initialize(baseUrl, "recovery-a"),
    initialize(baseUrl, "recovery-b"),
  ]);
  await Promise.all(originalSessions.map((sessionId, index) => listTools(baseUrl, sessionId, index + 10)));
  assert.equal((await readHealth(baseUrl)).activeSessions, 2);

  await stopServer(server);
  server = await startServer(testRoot, port);
  const secondPid = (await readHealth(baseUrl)).pid;
  assert.notEqual(secondPid, firstPid, "Server restart did not produce a new process");
  for (const sessionId of originalSessions) {
    assert.equal(await sessionStatus(baseUrl, "POST", sessionId), 404, "Pre-restart session must be stale");
  }

  const recoveredSessions = await Promise.all([
    initialize(baseUrl, "recovered-a"),
    initialize(baseUrl, "recovered-b"),
  ]);
  await Promise.all(recoveredSessions.map((sessionId, index) => listTools(baseUrl, sessionId, index + 20)));

  assert.equal(await sessionStatus(baseUrl, "DELETE", recoveredSessions[0]), 200);
  assert.equal(await sessionStatus(baseUrl, "POST", recoveredSessions[0]), 404);
  assert.equal((await readHealth(baseUrl)).activeSessions, 1);

  process.stdout.write(`${JSON.stringify({
    result: "passed",
    port,
    firstPid,
    secondPid,
    concurrentSessions: 2,
    staleStatus: 404,
    missingStatus: 400,
    recoveredSessions: 2,
  }, null, 2)}\n`);
} catch (error) {
  if (server) process.stderr.write(server.output());
  throw error;
} finally {
  if (server) await stopServer(server);
  await rm(testRoot, { recursive: true, force: true });
}
