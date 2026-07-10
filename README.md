# AiDailyTaks

A **local, localhost-only** task tracker (Monday/Jira-style) for refactor/bug/feature work, co-managed by a human and an AI agent. Task data is plain Markdown + YAML frontmatter — one folder per task — so the agent edits tasks with plain file tools while the human uses the web UI, and both stay in sync live. It's a lightweight way to give an AI coding agent shared, persistent context for the work you're doing together.

## Quick start

```bash
npm install            # once, from the repo root (npm workspaces)
npm run import:dry     # optional: preview importing tasks from a markdown audit doc
npm run import         # optional: generate board/ from that doc (idempotent) — see CLAUDE.md
npm run dev            # server :4317 + Vite UI :5173
```

For daily use without the dev server:

```bash
npm run build          # builds the web UI
npm start              # serves UI + API together on http://localhost:4317
```

## Layout

```
board/<ID>/task.md     a task (frontmatter + markdown body)              [git-ignored — private]
board/<ID>/files/      that task's attachments                            [git-ignored — private]
board/_meta/           overview / relationships / runtime-evidence / …    [git-ignored — private]
exports/               generated markdown exports                         [git-ignored — private]
projects.json          the project list ({id,label}) — add via the UI     [git-ignored — private]
board.config.json      enum vocabulary (statuses, categories, severities) — tracked template
app/shared/            zod contract + TS types (used by server AND web)
app/server/            Fastify + TypeScript backend (+ the audit importer)
app/web/               React + Vite + TypeScript frontend
```

**This is a localhost-only tool and your task data is private.** `board/`, `exports/`, and `projects.json`
are git-ignored so nothing you track ever lands in git; only the code and the `board.config.json`
vocabulary template are version-controlled.

## Connect an agent (MCP)

AiDailyTaks is also an **MCP server**, so an AI agent can read/create/update tasks, manage
projects, and inspect the graph through tools (`list_tasks`, `get_task`, `create_task`,
`update_task`, `add_observation`, `archive_task`/`unarchive_task`, `list_projects`,
`add_project`, `get_config`, `get_graph`). Both transports expose the same tools.

> **In-app helper:** open the **Connect** tab in the UI for copy-paste configs (HTTP + stdio)
> and the live tool list — the URL/paths are filled in from the running server.

**Option A — over HTTP (on the running server).** The MCP endpoint comes up automatically with
`npm run dev` (and `npm start`). Point any Streamable-HTTP MCP client at:

```
http://127.0.0.1:4317/mcp
```

**Option B — stdio (spawn it locally, no HTTP server needed).** The agent runs the process
and talks over stdin/stdout. Example client config (e.g. `claude_desktop_config.json` or a
`.mcp.json`):

```jsonc
{
  "mcpServers": {
    "AiDailyTaks": { "command": "npm", "args": ["run", "mcp"], "cwd": "C:/Code/AiDailyTaks" }
  }
}
```

Or run it directly: `npm run mcp`. Both paths edit the same `board/` files with the same
optimistic-concurrency + atomic writes as the web UI, so the browser updates live.

See [CLAUDE.md](CLAUDE.md) for the working conventions (most importantly: **new scope docs are created here as tasks, not scattered across the codebase you're working on**).
