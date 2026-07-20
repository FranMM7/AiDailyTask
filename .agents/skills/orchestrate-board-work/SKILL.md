---
name: orchestrate-board-work
description: Orchestrate AiDailyTasks board work from discovery through completion while preserving context in board tasks. Use when starting a session, scoping a task, implementing a task, verifying work, completing a task, or when the user invokes session-status, scope-task, work-task, verify-task, or complete-task.
---

# Orchestrate Board Work

Treat `board/<ID>/task.md` as the durable handoff and source of truth. Read `AGENTS.md` and the target task before acting. Read relevant attachments under `board/<ID>/files/`.

## Route the request

- `session-status`: Summarize in-progress, scoped, blocked, and high-severity work. Recommend the next task using dependencies, severity, and recent observations.
- `scope-task <ID>`: Inspect the codebase and attachments, resolve material ambiguity, write an implementation-ready scope with acceptance checks and dependencies, then move the task to `Scoped`.
- `work-task <ID>`: Require an adequately scoped task, read and apply all task `skills`, move it to `In progress`, implement the smallest coherent vertical slice, and verify it. Do not commit or publish unless asked.
- `verify-task <ID>`: Derive checks from scope and changed files, run proportionate automated and manual checks, and record evidence and remaining risks.
- `complete-task <ID>`: Confirm acceptance checks and verification evidence, then set `Completed` and `completed` to today. Do not complete work with unresolved required checks.

## Preserve context

Append a concise timestamped observation after each meaningful stage. Record decisions, changed files, verification commands/results, and blockers. Update `updated` on every edit and keep relationships reciprocal.

Keep new plans and design notes in the task body or `board/<ID>/files/`; do not create loose tracking documents elsewhere.

## Apply task execution skills

Treat `tags` as discovery/classification metadata and `skills` as execution expectations. Before
scoping, working, or verifying a task, read the full `skills` array and apply every compatible lens
to design decisions and acceptance checks. Multiple values may be combined. Skills change emphasis,
not authority: they never broaden scope, override repository instructions, or grant permission for
external/destructive actions. A configured task skill is a durable role string; do not assume it
automatically loads an external skill package with the same name. Apply non-empty instructions from
MCP `skill_details`; for direct file reads, resolve selected ids against the `skills` definitions in
`board.config.json`. Treat unmatched free-form values as role strings without inventing instructions.

When completing recurring work, use the application's archive operation after setting Completed.
Directly writing `archived: true` bypasses creation of the idempotent Backlog successor.

## Execute safely

Inspect the working tree before editing and preserve unrelated changes. Prefer vertical slices that are independently demonstrable. Review the diff for unintended edits. Report the task ID, new status, verification result, and any remaining risk.

## Recover MCP context

When MCP is missing or stale, check `http://127.0.0.1:4317/api/mcp-health` out-of-band. Connection
refused means the HTTP app is not running; healthy status with stale tools means the agent must
disconnect/reconnect or restart so `.mcp.json` and tool schemas reload. Prefer the **Connect** tab's
direct-TSX stdio config. Never claim queued board writes succeeded: after reconnecting, re-read the
task/project, apply the queued change, and verify it with a read-back. An MCP tool cannot restart its
own unavailable transport.
