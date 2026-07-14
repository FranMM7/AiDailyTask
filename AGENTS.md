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
board.config.json       the enum vocabulary (statuses, categories, severities) — tracked template
projects.json           the project list — LOCAL & git-ignored (private); add via UI or by editing it
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
tags: []
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

Prefer the HTTP/MCP API only when you specifically want optimistic-concurrency / live behavior;
direct file edits are the normal path and always safe.

## Finding your way around

- **List tasks:** glob `board/*/task.md`, then read. To search content, grep under `board/`.
- **Structured access (optional):** the app is also an MCP server (`npm run mcp`, or the HTTP
  endpoint at `http://127.0.0.1:4317/mcp`) exposing `list_tasks`, `get_task`, `create_task`,
  `update_task`, `add_observation`, `list_attachments`, `get_attachment`,
  `archive_task` / `unarchive_task`, `list_projects`,
  `add_project`, `get_config`, `get_graph`. See the README for connection details.

## Vocabulary

Statuses, categories, and severity/risk levels are defined once in `board.config.json`.
Status columns: **Not started · Scoped · In progress · Completed** (plus **Backlog**, parked off the
board). Category: **Refactor · Bug · Feature · UX · Arch · Org**. Severity/Risk:
**Low · Low–Med · Medium · Med–High · High** (compound values use an EN DASH `–`).

**Projects** live in the local, git-ignored `projects.json` (a flat `[{ "id", "label" }]` array) —
**Sample** by default. Add one via the UI or by editing `projects.json` directly; the server watches
the file and the browser refreshes live.

## Reporting back

Be concise: say what you found or changed, the task id(s), and the new status. Don't dump entire file
contents unless asked. The `board/` folder is also a valid Obsidian vault (frontmatter + `[[C26]]`
wiki-links) if the human wants to open it there.

## Workflow shortcuts

Reusable project skills live under `.agents/skills/`. Use `orchestrate-board-work` for session
briefings and the scope, work, verification, and completion stages. Use `approach-as-role` when a
task should be handled through an engineer, full-stack, frontend, backend, QA, architecture, or
security lens. Claude Code exposes matching slash commands under `.claude/commands/`.
