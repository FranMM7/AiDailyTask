# AiDailyTasks — working conventions

This is an **internal, localhost-only** task tracker that Francis and Claude co-manage. It replaces scope/tracking notes that would otherwise be scattered as loose docs across the codebase being worked on.

## The most important rule

> **New scope / tracking / design docs are created HERE as tasks under `board/`, never dropped as stray files into the project you're working on.**

The codebase you're working on is for code, not for notes between Francis and Claude. When you scope a new piece of work, create/extend a task in `board/` (and, if you want a long design write-up, put it in that task's body or a file under `board/<ID>/files/`).

## Data model (the source of truth is the files, not a database)

```
board/<ID>/task.md      YAML frontmatter + markdown body
board/<ID>/files/       that task's attachments (logs, screenshots, PDFs, scope docs)
board/_meta/            overview, relationships narrative, runtime evidence, unfiled docs, import report
exports/                generated markdown exports
board.config.json       vocabulary, task skills, board columns, and navigation — tracked template
projects.json           the project list — LOCAL & git-ignored (private); add via UI or by editing it
project-docs/<project>/  agent instructions + imported README snapshots — LOCAL & git-ignored
```

> **Privacy:** `board/`, `exports/`, and `projects.json` are git-ignored — this tracker is localhost-only and its task/project data is never committed. Only the code and `board.config.json` (vocabulary/colors) are version-controlled.

`<ID>` is `C` + zero-padded number (`C01`, `C09`, `C56`). The folder name is authoritative; frontmatter `id` must match it.

### `task.md`

```yaml
---
id: C09
title: Hardcoded values & magic strings/numbers
project: Sample
category: Refactor          # Refactor | Bug | Feature | UX | Arch | Org
severity: Medium            # Low | Low–Med | Medium | Med–High | High   (en dash –)
risk: Low
status: Completed           # Not started | Scoped | In progress | Completed
status_detail: ""           # free-text nuance ("awaiting VS build", "parked", dates…)
created: 2026-06-29
updated: 2026-07-07
completed: 2026-07-07        # only when status = Completed
archived: false              # usually omitted while active
# archived_at: 2026-07-08    # only when archived; set by application lifecycle
tags: []
skills: [Senior backend engineer, Security engineer]
recurring: false             # completed + application archive creates a Backlog successor
recurrence_of: null          # internal lineage on an automatically generated successor
depends_on: [C01, C02]
blocks: []
relates_to: [C13]
parent: null                # e.g. C10 is the parent (umbrella) of C25–C29
children: []
sources: []                 # relative paths (files/…) or references ("session 495b")
---
## Summary
One paragraph.

## Scope
Detailed markdown.

## Observations
### 2026-07-07T15:17:00Z — claude
Appended, newest last. Header format: `### <ISO8601Z> — <author>` where author is `human` or `claude`.
```

## How Claude edits the board

You can edit these files **directly** with your normal Read/Edit/Write tools — the server (if running) watches the files and pushes changes to the browser live. Two ways to work:

- **Update a status / field:** edit the frontmatter of `board/<ID>/task.md`. Bump `updated:` to today; set `completed:` when moving to Completed. Add a line under `## Observations` describing what changed.
- **Add a task:** create `board/<ID>/task.md` (next free number) with full frontmatter + at least a `## Summary`. Create `board/<ID>/files/` if you have attachments.
- **Read a task's attachments:** they're in `board/<ID>/files/` — open them directly instead of asking Francis to paste logs/screenshots into chat.
- **Archive recurring work through the UI/API/MCP:** use `archive_task` after completion. A direct
  `archived: true` file edit bypasses successor creation.

Prefer the API only when you specifically want optimistic-concurrency/live behavior; direct file
edits are the normal path, with the recurring-archive lifecycle exception above.

## Tags, skills, and recurrence

Tags classify the work and support exact-tag discovery; they do not assign a role. Skills are the
task's execution expectations. Before scoping or implementing, read every `skills` value and apply
the compatible engineering lenses without expanding scope or authority. Multiple skills may be
combined. `get_task` returns tags and skills, while `create_task` / `update_task` accept them;
configured skills are suggestions, not automatically loaded external skill packages.

When a completed recurring task is archived through the application, it creates exactly one active
Backlog successor. Content, tags, and skills carry forward; lifecycle state, attachments, status
detail, and graph relationships reset. `recurrence_of` records the generated task's lineage.

## Vocabulary

Statuses, categories, skills, severity/risk levels, board columns, and visible navigation tabs are
defined in `board.config.json` and editable from **Settings** beside Export. Default status columns:
**Not started · Scoped · In progress · Completed**, with **Backlog** parked off-board unless enabled.
`Backlog` and `Completed` ids are lifecycle-protected. Category defaults: **Refactor · Bug · Feature · UX · Arch · Org**. Severity/Risk defaults: **Low · Low–Med · Medium · Med–High · High**.

**Projects** live in the local, git-ignored `projects.json` (a flat `[{ "id", "label" }]` array) — **Sample** by default. Add one via the UI ("＋" next to the project picker) or by editing `projects.json` directly; the server watches the file and the browser refreshes live. New tasks created from the UI get an auto-incremented id (server allocates `max + 1`).

The **Projects** tab holds project metadata, source/indexer settings, maintained agent instructions,
and imported root README snapshots. Before substantial project work, use `get_project`; update durable
guidance with `update_project_documentation`, import/refresh README context with
`import_project_readme`, and rebuild source-derived context with `refresh_code_graph`.
The first eligible `get_task` read in an MCP session may include a ready-Graphify study hint; it is
advisory and does not generate, refresh, or query the graph automatically.

## MCP recovery

If MCP appears down, check `http://127.0.0.1:4317/api/mcp-health` from the shell. If health is `ok`
but tools are stale, reconnect MCP or restart this Claude session: `.mcp.json` and tool schemas are
loaded at session start and do not hot-reload. Prefer the direct-TSX stdio configuration generated by
the **Connect** tab. An MCP tool cannot restart its own unavailable transport. After reconnecting,
re-read the task/project, flush queued changes, and verify them with `get_task`/`get_project` before
reporting success.

## Running the app

- `npm install` (once, at the repo root — npm workspaces).
- `npm run dev` — server on **http://localhost:4317** + Vite dev UI on **http://localhost:5173**.
- `npm start` — serves the built UI + API from **http://localhost:4317** only (run `npm run build` first).
- `npm run import:dry` / `npm run import` — (re)import tasks from a markdown "audit" document (a status table + per-task sections). Point it at your own file with `-- --source <path>`; idempotent, never modifies the source. Optional — a fresh board works without it.
- `npm run share` — expose the running server over the web via an **ngrok tunnel that auto-closes after a time limit** (default 30 min). Options: `-- --minutes <n> --port <n> --auth user:pass`. Requires the ngrok CLI + an authtoken; does *not* start the server. The board has no login, so prefer `--auth` and keep the window short.
- `npm run mcp` — run the board as an **MCP server over stdio** (for a local agent). The HTTP server also exposes MCP at **http://localhost:4317/mcp** (Streamable HTTP). Tools cover task CRUD, observations, attachments, project metadata/documentation, and graphs. See the README's "Connect any AI agent (MCP)" section.

The `board/` folder is also a valid Obsidian vault (frontmatter + `[[C26]]` wiki-links) if you want to open it there.
