import { useState, type ReactNode } from "react";
import { Check, Copy, Plug, Terminal, Globe } from "lucide-react";
import type { McpInfo } from "@AiDailyTasks/shared";
import { useMcpInfo } from "@/api/hooks";
import { toast } from "@/store/toast";

function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      toast("Copied to clipboard", "success");
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast("Couldn't access the clipboard", "error");
    }
  };
  return (
    <button
      type="button"
      onClick={copy}
      className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 px-2.5 py-1 text-xs font-medium hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
    >
      {copied ? <Check size={13} className="text-green-500" /> : <Copy size={13} />}
      {copied ? "Copied" : label}
    </button>
  );
}

function CodeBlock({ title, code, icon }: { title: ReactNode; code: string; icon?: ReactNode }) {
  return (
    <div className="rounded-lg border border-slate-200 dark:border-slate-800">
      <div className="flex items-center justify-between gap-2 border-b border-slate-200 px-3 py-1.5 dark:border-slate-800">
        <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-500">
          {icon}
          {title}
        </span>
        <CopyButton text={code} />
      </div>
      <pre className="overflow-x-auto p-3 text-xs leading-relaxed">
        <code>{code}</code>
      </pre>
    </div>
  );
}

function Section({ title, children, hint }: { title: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <section className="rounded-xl border border-slate-200 p-4 dark:border-slate-800">
      <h2 className="text-sm font-semibold">{title}</h2>
      {hint ? <p className="mt-0.5 mb-3 text-xs text-slate-500">{hint}</p> : <div className="mb-3" />}
      <div className="space-y-3">{children}</div>
    </section>
  );
}

function buildBlocks(info: McpInfo) {
  const name = info.serverName;
  const httpConfig = JSON.stringify(
    { mcpServers: { [name]: { type: "http", url: info.http.url } } },
    null,
    2,
  );
  const stdioConfig = JSON.stringify(
    { mcpServers: { [name]: { command: info.stdio.command, args: info.stdio.args, cwd: info.stdio.cwd } } },
    null,
    2,
  );
  const cli = `claude mcp add --transport http ${name} ${info.http.url}`;
  return { httpConfig, stdioConfig, cli };
}

export function McpConfigView() {
  const { data: info, isLoading, isError } = useMcpInfo();

  if (isLoading) return <Msg>Loading connection details…</Msg>;
  if (isError || !info) return <Msg>Couldn't load MCP info. Is the server running?</Msg>;

  const { httpConfig, stdioConfig, cli } = buildBlocks(info);

  return (
    <div className="h-full overflow-auto p-4 sm:p-6">
      <div className="mx-auto max-w-3xl space-y-6">
        <header>
          <h1 className="inline-flex items-center gap-2 text-lg font-semibold">
            <Plug size={18} /> Connect an agent (MCP)
          </h1>
          <p className="mt-1 text-xs text-slate-500">
            This board is also an MCP server, so an AI agent can read and manage tasks directly. Pick a
            transport, copy the config, and paste it into your agent. Both expose the same {info.tools.length} tools.
          </p>
        </header>

        <Section
          title="Option A · HTTP (server already running)"
          hint={
            <>
              Works whenever the app is up (<code>npm run dev</code> or <code>npm start</code>). Point any
              Streamable-HTTP MCP client at this URL.
            </>
          }
        >
          <div className="flex items-center gap-2">
            <code className="flex-1 truncate rounded-md bg-slate-100 px-3 py-2 text-sm dark:bg-slate-900">
              {info.http.url}
            </code>
            <CopyButton text={info.http.url} label="Copy URL" />
          </div>
          <CodeBlock
            title="mcp config (.mcp.json / claude_desktop_config.json)"
            code={httpConfig}
            icon={<Globe size={13} />}
          />
          <CodeBlock title="Claude Code — one command" code={cli} icon={<Terminal size={13} />} />
        </Section>

        <Section
          title="Option B · stdio (agent spawns it)"
          hint="No server needed — the agent launches the process and talks over stdin/stdout. Requires this repo checked out locally."
        >
          <CodeBlock
            title="mcp config (.mcp.json / claude_desktop_config.json)"
            code={stdioConfig}
            icon={<Terminal size={13} />}
          />
        </Section>

        <Section title="Available tools" hint="The same set over either transport.">
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {info.tools.map((t) => (
              <li key={t.name} className="flex items-baseline gap-3 py-1.5">
                <code className="shrink-0 text-xs font-semibold text-blue-600 dark:text-blue-400">
                  {t.name}
                </code>
                <span className="text-xs text-slate-500">{t.description}</span>
              </li>
            ))}
          </ul>
        </Section>
      </div>
    </div>
  );
}

function Msg({ children }: { children: ReactNode }) {
  return <div className="p-8 text-center text-sm text-slate-500">{children}</div>;
}
