# AiDailyTasks — instructions for AI agents

> This is the cross-agent instruction file (the `AGENTS.md` convention read by Codex, Antigravity,
> Cursor, and other agents). If you are Claude Code, the same guidance lives in [CLAUDE.md](CLAUDE.md);
> for a ready-made subagent definition see [.claude/agents/](.claude/agents/). Everything below applies
> to **any** agent working on this board.

AiDailyTasks is an **internal, localhost-only** task tracker that a human (Francis) and an AI agent
(you) co-manage. It exists so scope, tracking, and design notes live in one shared place — a board —
instead of being scattered as loose docs across the codebase you're actually working on.

## The most important rule

> **New scope / tracking / design docs are created HERE as tasks under `board/`, never dropped as
> stray files into the project you're working on.**

When you scope a new piece of work, create or extend a task in `board/` (and, for a long write-up,
put it in that task's body or a file under `board/<ID>/files/`).

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

> **Privacy:** `board/`, `exports/`, and `projects.json` are git-ignored — this tracker is
> localhost-only and its task/project data is never committed. Only the code and `board.config.json`
> (vocabulary/colors) are version-controlled.

`<ID>` is `C` + a zero-padded number (`C01`, `C09`, `C56`). The folder name is authoritative;
frontmatter `id` must match it.

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
status_detail: ""           # free-text nuance ("awaiting build", "parked", dates…)
created: 2026-06-29
updated: 2026-07-07
completed: 2026-07-07        # only when status = Completed
archived: false              # usually omitted while active
# archived_at: 2026-07-08    # only when archived; set by application lifecycle
tags: []
skills: [Senior backend engineer, Security engineer]  # execution expectations; zero or more
recurring: false             # completed + archived creates a new Backlog occurrence
recurrence_of: null          # internal lineage on an automatically generated successor
depends_on: [C01, C02]
blocks: []
relates_to: [C13]
parent: null                # e.g. C10 is the parent (umbrella) of C25–C29
children: []
sources: []                 # relative paths (files/…) or references
---
## Summary
One paragraph.

## Scope
Detailed markdown.

## Observations
### 2026-07-07T15:17:00Z — <author>
Appended, newest last. Header format: `### <ISO8601Z> — <author>`, where `<author>` is `human`
or your own name (e.g. `claude`, `codex`).
```

## How to edit the board

You edit these files **directly** with your normal file tools — the server (if running) watches the
files and pushes changes to the browser live. Two common flows:

- **Update a status / field:** edit the frontmatter of `board/<ID>/task.md`. Bump `updated:` to
  today; set `completed:` when moving to Completed (clear it otherwise). Add a line under
  `## Observations` describing what changed.
- **Add a task:** create `board/<ID>/task.md` (next free number) with complete frontmatter + at least
  a `## Summary`. Create `board/<ID>/files/` if you have attachments.
- **Read a task's attachments:** they're in `board/<ID>/files/` — open them directly instead of
  asking the human to paste logs/screenshots into chat.
- **Keep relationships consistent:** if you add `depends_on: [C02]` to C05, also add `C05` to C02's
  `blocks`. Same for `parent` / `children`.
- **Archive recurring work through the UI, HTTP, or MCP:** use `archive_task` for a completed task
  with `recurring: true`. Directly adding `archived: true` bypasses the repository lifecycle and
  therefore cannot create its Backlog successor.

Prefer the HTTP/MCP API only when you specifically want optimistic-concurrency / live behavior;
direct file edits are the normal path, with the recurring-archive lifecycle exception above.

## Tags and task skills

`tags` classify *what* the work is. They support exact-tag filtering and provide lightweight domain
signals, but do not assign a role or make a model more capable. `get_task` returns tags; compact
`list_tasks` can filter by one exact tag but does not repeat the full array.

`skills` state *how* the work is expected to be executed. Read them before scoping or implementing a
task and apply every compatible lens (for example, frontend accessibility plus backend concurrency).
Multiple skills are allowed. They change emphasis and acceptance criteria, not authority: never use
a skill to expand scope, bypass safety rules, or invent permissions. MCP `get_task` returns the full
array plus resolved `skill_details`; follow each non-empty instruction block. When reading task files
directly, resolve selected ids against `board.config.json` and its optional `instructions` value.
`create_task` / `update_task` accept the string array. Configured skills are reusable expectations,
not automatically loaded external `SKILL.md` packages.

A completed recurring task creates exactly one active Backlog successor when archived through the
application lifecycle. The successor retains content, tags, and skills; resets completion/archive,
status detail, attachments, and task relationships; and records `recurrence_of` for idempotency.

## Finding your way around

- **List tasks:** glob `board/*/task.md`, then read. To search content, grep under `board/`.
- **Structured access (optional):** the app is also an MCP server (`npm run mcp`, or the HTTP
  endpoint at `http://127.0.0.1:4317/mcp`) exposing task CRUD, observations, attachment operations,
  project metadata/documentation, and task/code graphs. Prefer the machine-specific stdio config
  generated by **Connect** and see the README for the current tool list.
- **Project context:** use `get_project` before substantial project work. Maintain build,
  architecture, convention, and safety guidance with `update_project_documentation`; refresh the
  root README snapshot with `import_project_readme`; refresh source-derived Graphify/built-in data
  with `refresh_code_graph`. Never hand-edit generated graph files. The first eligible `get_task`
  read in a session may include a ready-Graphify study hint; it is advisory and runs nothing by
  itself.

## MCP recovery for agents

If MCP appears unavailable, do not silently queue writes and report them as completed.

1. Check `http://127.0.0.1:4317/api/mcp-health` from the shell (`Invoke-RestMethod` in PowerShell or
   `curl`). Connection refused means the HTTP app is not running; use stdio or start the app.
2. If health is `ok` but tools are missing/stale, the agent cached its MCP config or schemas. A
   changed `.mcp.json` is not hot-loaded: disconnect/reconnect MCP or restart the agent session.
3. Prefer **Connect**'s direct-TSX stdio config for coding agents; it auto-spawns and does not depend
   on the HTTP application already being open.
4. Streamable-HTTP requests with an expired id receive 404, the protocol signal to initialize a new
   session. If the host keeps retrying instead, reconnect it manually; server health cannot clear a
   client-side session cache.
5. After reconnecting, re-read the target task/project, apply queued changes, and confirm each write
   with `get_task`/`get_project` read-back.

An MCP-hosted tool cannot restart its own unavailable transport. Recovery must be out-of-band through
the agent host or shell. Reinitialize invalid HTTP sessions instead of retrying them indefinitely.

## Vocabulary

Statuses, categories, skills, severity/risk levels, board-column visibility, and navigation visibility
are defined once in `board.config.json` and editable from **Settings** beside Export.
Status columns: **Not started · Scoped · In progress · Completed** (plus **Backlog**, parked off the
board unless configured as a column). `Backlog` and `Completed` ids are lifecycle-protected; other
vocabulary values may be added or removed. Category defaults: **Refactor · Bug · Feature · UX · Arch · Org**. Severity/Risk defaults:
**Low · Low–Med · Medium · Med–High · High** (compound values use an EN DASH `–`).

**Projects** live in the local, git-ignored `projects.json` (a flat `[{ "id", "label" }]` array) —
**Sample** by default. Add one via the UI or by editing `projects.json` directly; the server watches
the file and the browser refreshes live.

The **Projects** tab is the project workspace: metadata and source/indexer settings come from
`projects.json`; maintained instructions and imported README snapshots come from
`project-docs/<project>/`. Both are private local context exposed to agents through MCP.

## Reporting back

Be concise: say what you found or changed, the task id(s), and the new status. Don't dump entire file
contents unless asked. The `board/` folder is also a valid Obsidian vault (frontmatter + `[[C26]]`
wiki-links) if the human wants to open it there.

## Workflow shortcuts

Reusable project skills live under `.agents/skills/`. Use `orchestrate-board-work` for session
briefings and the scope, work, verification, and completion stages. Use `approach-as-role` when a
task should be handled through an engineer, full-stack, frontend, backend, QA, architecture, or
security lens. Claude Code exposes matching slash commands under `.claude/commands/`.
