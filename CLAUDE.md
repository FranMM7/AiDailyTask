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
board.config.json       the enum vocabulary (statuses, categories, severities) — tracked template
projects.json           the project list — LOCAL & git-ignored (private); add via UI or by editing it
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
tags: []
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

Prefer the API only when you specifically want optimistic-concurrency/live behavior; direct file edits are the normal path and always safe.

## Vocabulary

Statuses, categories, and severity/risk levels are defined once in `board.config.json`. Status columns: **Not started · Scoped · In progress · Completed**. Category: **Refactor · Bug · Feature · UX · Arch · Org**. Severity/Risk: **Low · Low–Med · Medium · Med–High · High**.

**Projects** live in the local, git-ignored `projects.json` (a flat `[{ "id", "label" }]` array) — **Sample** by default. Add one via the UI ("＋" next to the project picker) or by editing `projects.json` directly; the server watches the file and the browser refreshes live. New tasks created from the UI get an auto-incremented id (server allocates `max + 1`).

## Running the app

- `npm install` (once, at the repo root — npm workspaces).
- `npm run dev` — server on **http://localhost:4317** + Vite dev UI on **http://localhost:5173**.
- `npm start` — serves the built UI + API from **http://localhost:4317** only (run `npm run build` first).
- `npm run import:dry` / `npm run import` — (re)import tasks from a markdown "audit" document (a status table + per-task sections). Point it at your own file with `-- --source <path>`; idempotent, never modifies the source. Optional — a fresh board works without it.
- `npm run share` — expose the running server over the web via an **ngrok tunnel that auto-closes after a time limit** (default 30 min). Options: `-- --minutes <n> --port <n> --auth user:pass`. Requires the ngrok CLI + an authtoken; does *not* start the server. The board has no login, so prefer `--auth` and keep the window short.
- `npm run mcp` — run the board as an **MCP server over stdio** (for a local agent). The HTTP server also exposes MCP at **http://localhost:4317/mcp** (Streamable HTTP). Tools: `list_tasks`, `get_task`, `create_task`, `update_task`, `add_observation`, `list_attachments`, `get_attachment`, `archive_task`/`unarchive_task`, `list_projects`, `add_project`, `get_config`, `get_graph`. See the README's "Connect an agent (MCP)" section.

The `board/` folder is also a valid Obsidian vault (frontmatter + `[[C26]]` wiki-links) if you want to open it there.
