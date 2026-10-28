/**
 * Share the local board over the web via an ngrok tunnel, for a limited time.
 *
 *   tsx src/tools/share.ts [--minutes <n>] [--port <n>] [--auth <user:pass>] [--domain <d>]
 *
 * Opens an ngrok tunnel to the running server (default http://127.0.0.1:4317) and
 * prints the public https URL. The tunnel closes automatically after --minutes
 * (default 30), or on Ctrl-C. The board has NO built-in authentication, so anyone
 * with the link can read/write it — use --auth user:pass to put HTTP Basic auth in
 * front of it, and keep the window short.
 *
 * Requirements:
 *   - The ngrok CLI on PATH (https://ngrok.com/download), signed in once with an
 *     authtoken: `ngrok config add-authtoken <token>` (or set NGROK_AUTHTOKEN).
 *   - The server already running: `npm start` (built UI + API) — run `npm run build` first.
 *
 * This does NOT start the server; it only exposes whatever is already listening on --port.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import readline from "node:readline";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { existsSync } from "node:fs";

export interface Options {
  port: number;
  minutes: number;
  auth?: string;
  domain?: string;
}

function notifyParent(message: object): void {
  if (!process.connected || !process.send) return;
  // A parent can disappear between the connected check and the send. Never let
  // a broken reporting channel skip tunnel cleanup.
  try { process.send(message, () => {}); } catch { /* Parent already closed. */ }
}

export function ngrokExecutable(): string {
  if (process.platform !== "win32") return "ngrok";
  const found = spawnSync("where.exe", ["ngrok.exe"], { encoding: "utf8", windowsHide: true });
  const executable = found.status === 0 ? found.stdout.trim().split(/\r?\n/)[0] : undefined;
  if (!executable) return "ngrok";
  // Chocolatey's shim can exit before its child when the parent disconnects,
  // leaving taskkill with a vanished root PID. Own the actual binary instead.
  const packaged = path.resolve(path.dirname(executable), "../lib/ngrok/tools/ngrok.exe");
  if (path.basename(path.dirname(executable)).toLowerCase() === "bin" && existsSync(packaged)) return packaged;
  return executable;
}

function parseArgs(argv: string[]): Options {
  const envPort = process.env.PORT;
  const opts: Options = {
    port: envPort && /^\d+$/.test(envPort) ? Number(envPort) : 4317,
    minutes: 30,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = (): string => {
      const v = argv[i + 1];
      if (v === undefined) throw new Error(`Missing value for ${arg}`);
      i++;
      return v;
    };
    switch (arg) {
      case "--minutes":
      case "-m":
        opts.minutes = Number(next());
        break;
      case "--port":
      case "-p":
        opts.port = Number(next());
        break;
      case "--auth":
        opts.auth = next();
        break;
      case "--domain":
        opts.domain = next();
        break;
      case "--help":
      case "-h":
        printUsageAndExit();
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!Number.isFinite(opts.port) || opts.port <= 0) throw new Error(`Invalid --port: ${opts.port}`);
  if (!Number.isFinite(opts.minutes) || opts.minutes <= 0) throw new Error(`Invalid --minutes: ${opts.minutes}`);
  if (opts.auth && !opts.auth.includes(":")) throw new Error(`--auth must be "user:password"`);
  return opts;
}

function printUsageAndExit(): never {
  console.log(
    [
      "Share the local board over the web via ngrok, for a limited time.",
      "",
      "Usage: npm run share -- [options]",
      "",
      "  -m, --minutes <n>     auto-close the tunnel after n minutes (default 30)",
      "  -p, --port <n>        local port to expose (default 4317, or $PORT)",
      "      --auth <u:p>      require HTTP Basic auth (strongly recommended)",
      "      --domain <d>      use a reserved ngrok domain (paid plans)",
      "  -h, --help            show this help",
      "",
      "The server must already be running (npm start). Ctrl-C closes the tunnel early.",
    ].join("\n"),
  );
  process.exit(0);
}

/** Confirm something is actually listening on the target port before we tunnel to it. */
async function assertServerRunning(port: number): Promise<void> {
  const url = `http://127.0.0.1:${port}/api/config`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch {
    throw new Error(
      `No AiDailyTasks server responding on http://127.0.0.1:${port}.\n` +
        `Start it first (in another terminal):  npm run build && npm start`,
    );
  }
}

function spawnNgrok(opts: Options): ChildProcess {
  // --log stdout gives us a machine-readable (logfmt) stream we parse for the public URL,
  // scoped to THIS process — more reliable than the agent API, whose port shifts when
  // another ngrok agent already holds 4040.
  const args = ["http", String(opts.port), "--log", "stdout", "--log-format", "logfmt"];
  if (opts.auth) args.push("--basic-auth", opts.auth);
  if (opts.domain) args.push("--domain", opts.domain);
  const child = spawn(ngrokExecutable(), args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  child.stderr?.on("data", (d: Buffer) => process.stderr.write(d));
  return child;
}

/** Pull a `key=value` field out of an ngrok logfmt line (value may be quoted). */
function logfmtField(line: string, key: string): string | undefined {
  const m = new RegExp(`\\b${key}=("([^"]*)"|(\\S+))`).exec(line);
  return m ? (m[2] ?? m[3]) : undefined;
}

/**
 * Watch ngrok's stdout for the "started tunnel" line (→ resolve with its url) or an
 * error line (→ reject with ngrok's own message). Rejects on timeout as a backstop.
 */
export function waitForPublicUrl(child: ChildProcess, timeoutMs = 20000): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    if (!child.stdout) return reject(new Error("ngrok produced no output stream."));
    const rl = readline.createInterface({ input: child.stdout });
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for ngrok to report a public URL."));
    }, timeoutMs);
    const cleanup = (): void => {
      clearTimeout(timer);
      rl.close();
      child.stdout?.resume();
      child.off("error", onError);
      child.off("exit", onExit);
    };
    const onError = (error: Error): void => { cleanup(); reject(error); };
    const onExit = (): void => { cleanup(); reject(new Error("ngrok exited before reporting a URL. Check your ngrok authtoken and account limits.")); };
    child.once("error", onError);
    child.once("exit", onExit);
    rl.on("line", (line) => {
      const url = logfmtField(line, "url");
      if (url && /^https:\/\//.test(url)) {
        cleanup();
        resolve(url);
        return;
      }
      const lvl = logfmtField(line, "lvl");
      if (lvl === "eror" || lvl === "error" || lvl === "crit") {
        cleanup();
        reject(new Error(logfmtField(line, "err") ?? logfmtField(line, "msg") ?? line));
      }
    });
  });
}

/** Kill ngrok and its children. On Windows the PATH `ngrok` is a shim that spawns the
 *  real ngrok.exe, so a plain kill() orphans it — use taskkill /T to take the whole tree. */
export function killTree(child: ChildProcess): void {
  if (child.killed || child.pid === undefined) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  } else {
    child.kill();
  }
}

async function main(): Promise<void> {
  // Cover disconnect/stop during the server health check, before ngrok is spawned.
  let stopWorker = (): void => process.exit(0);
  process.on("disconnect", () => stopWorker());
  process.on("message", (message: { type?: string }) => { if (message.type === "stop") stopWorker(); });
  const opts: Options = process.send
    ? await new Promise(resolve => process.once("message", (message: { options: Options }) => resolve(message.options)))
    : parseArgs(process.argv.slice(2));

  await assertServerRunning(opts.port);

  const child = spawnNgrok(opts);
  process.once("exit", () => killTree(child));

  let closed = false;
  const shutdown = (code: number, msg?: string): void => {
    if (closed) return;
    closed = true;
    if (msg) console.log(msg);
    killTree(child);
    if (code !== 0) notifyParent({ type: "error", message: "ngrok could not start. Check its authtoken, account limits and configuration, or run npm run share for details." });
    process.exit(code);
  };

  // The worker owns expiry and cleanup even if the HTTP process is restarted/killed.
  stopWorker = () => shutdown(0);
  const onSignal = (): void => shutdown(0, "\nClosing the tunnel…");
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  child.on("error", (err) => {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      shutdown(
        1,
        "ngrok CLI not found on PATH. Install it from https://ngrok.com/download and run\n" +
          "  ngrok config add-authtoken <your-token>",
      );
    } else {
      shutdown(1, `Failed to launch ngrok: ${err.message}`);
    }
  });
  child.on("exit", (code) => {
    if (!closed) shutdown(code ?? 0, "\nngrok exited.");
  });

  let publicUrl: string;
  try {
    publicUrl = await waitForPublicUrl(child);
  } catch (err) {
    shutdown(1, `${(err as Error).message}\nCheck that your ngrok authtoken is set (ngrok config add-authtoken <token>).`);
    return;
  }

  const closesAt = new Date(Date.now() + opts.minutes * 60_000);
  notifyParent({ type: "ready", url: publicUrl, expiresAt: closesAt.toISOString() });
  const hhmm = closesAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  console.log("");
  console.log(`  🌐  Board shared:  ${publicUrl}`);
  console.log(`      → forwarding to http://127.0.0.1:${opts.port}`);
  console.log(`      ⏱  auto-closes in ${opts.minutes} min (at ${hhmm}) · Ctrl-C to stop now`);
  if (opts.auth) {
    console.log(`      🔒  HTTP Basic auth required (user "${opts.auth.split(":")[0]}")`);
  } else {
    console.log(`      ⚠️  NO authentication — anyone with the link can read AND edit the board.`);
    console.log(`          Re-run with --auth user:password to lock it down.`);
  }
  console.log("");

  const timer = setTimeout(() => {
    shutdown(0, `\n⏱  Time's up (${opts.minutes} min) — closing the tunnel.`);
  }, opts.minutes * 60_000);
  timer.unref();

}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((err) => {
  notifyParent({ type: "error", message: "Could not start sharing. Check the running server and ngrok configuration." });
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
