import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { killTree, ngrokExecutable } from "../../tools/share";

export const ShareOptions = z.object({
  minutes: z.number().int().min(1).max(1440),
  auth: z.string().max(500).regex(/^[^:\s]+:.+$/, "Use username:password").optional(),
}).strict();

export interface ShareState {
  phase: "idle" | "starting" | "active" | "stopping" | "error";
  url: string | null;
  expiresAt: string | null;
  error: string | null;
}
const idle = (): ShareState => ({ phase: "idle", url: null, expiresAt: null, error: null });

/** Runtime control is local-only, including through proxies and cross-origin browsers. */
export function isLocalShareRequest(req: FastifyRequest): boolean {
  const local = (host: string) => ["localhost", "127.0.0.1", "[::1]", "::1", "::ffff:127.0.0.1"].includes(host);
  if (!local(req.ip) || Object.keys(req.headers).some(key => key === "forwarded" || key.startsWith("x-forwarded-"))) return false;
  try {
    if (!local(new URL(`http://${req.headers.host}`).hostname)) return false;
    if (req.headers.origin && !local(new URL(req.headers.origin).hostname)) return false;
    return !req.headers["sec-fetch-site"] || req.headers["sec-fetch-site"] !== "cross-site";
  } catch { return false; }
}

export function ngrokAvailable(): Promise<boolean> {
  return new Promise(resolve => execFile(ngrokExecutable(), ["version"], { windowsHide: true, timeout: 3000 }, error => resolve(!error)));
}

export class ShareController {
  private child?: ChildProcess;
  private value = idle();
  constructor(private launch = () => spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("../../tools/share.ts", import.meta.url))], {
    windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"],
  })) {}
  get state(): ShareState { return { ...this.value }; }
  start(options: z.infer<typeof ShareOptions>, port: number): ShareState {
    if (this.child) throw new Error("A sharing session is already running. Stop it before starting another.");
    this.value = { ...idle(), phase: "starting" };
    let child: ChildProcess;
    try { child = this.launch(); } catch (error) { this.value = idle(); throw error; }
    this.child = child;
    const fail = (message: string) => { this.value = { ...idle(), phase: "error", error: message }; };
    const timer = setTimeout(() => { fail("Sharing startup timed out. Check ngrok configuration."); killTree(child); }, 30000);
    timer.unref();
    child.on("message", (message: { type?: string; url?: string; expiresAt?: string; message?: string }) => {
      if (this.child !== child || this.value.phase === "stopping") return;
      if (message.type === "ready" && this.value.phase === "starting" && message.url?.startsWith("https://") && message.expiresAt) {
        clearTimeout(timer);
        this.value = { phase: "active", url: message.url, expiresAt: message.expiresAt, error: null };
      } else if (message.type === "error") { clearTimeout(timer); fail(message.message ?? "Sharing failed."); }
    });
    child.once("error", () => { clearTimeout(timer); fail("Could not launch the sharing process."); if (this.child === child) this.child = undefined; });
    child.once("exit", code => {
      clearTimeout(timer);
      if (this.child !== child) return;
      this.child = undefined;
      if (this.value.phase === "error") return;
      if (code && this.value.phase !== "stopping") fail("ngrok stopped unexpectedly. Check its configuration and try again.");
      else this.value = idle();
    });
    child.send({ type: "start", options: { ...options, port } }, error => { if (error) fail("Could not configure the sharing process."); });
    return this.state;
  }
  async stop(): Promise<ShareState> {
    const child = this.child;
    if (!child) { this.value = idle(); return this.state; }
    this.value = { ...idle(), phase: "stopping" };
    await new Promise<void>(resolve => {
      const deadline = setTimeout(() => killTree(child), 5000);
      deadline.unref();
      child.once("exit", () => { clearTimeout(deadline); resolve(); });
      if (child.connected) child.send({ type: "stop" }, () => {});
      else child.kill();
    });
    return this.state;
  }
}

export function registerShareRoutes(app: FastifyInstance, port: number, webDistDir: string, controller = new ShareController(), available = ngrokAvailable): void {
  app.addHook("onClose", async () => { await controller.stop(); });
  app.register(async routes => {
    routes.addHook("onRequest", async (req, reply) => {
      if (!isLocalShareRequest(req)) return reply.code(403).send({ error: { code: "local_only", message: "Manage sharing from localhost on the server computer." } });
    });
    routes.get("/api/share", async () => {
      const state = controller.state;
      // Active polling need not spawn a second ngrok process just to check installation.
      const installed = ["starting", "active", "stopping"].includes(state.phase) || await available();
      return { ...state, installed, uiReady: existsSync(`${webDistDir}/index.html`) };
    });
    routes.post("/api/share", async (req, reply) => {
      const parsed = ShareOptions.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: { code: "validation_error", message: "Choose a whole number of minutes from 1 to 1440 and valid optional username:password credentials." } });
      if (!existsSync(`${webDistDir}/index.html`)) return reply.code(409).send({ error: { code: "build_required", message: "Run npm run build first so visitors can open the board." } });
      if (!await available()) return reply.code(409).send({ error: { code: "ngrok_missing", message: "Install ngrok on PATH and configure its authtoken, then retry." } });
      try { return reply.code(202).send(controller.start(parsed.data, port)); }
      catch (error) { return reply.code(409).send({ error: { code: "share_conflict", message: (error as Error).message } }); }
    });
    routes.delete("/api/share", async () => controller.stop());
  });
}
