---
name: orchestrate-board-work
description: Orchestrate AiDailyTasks board work from discovery through completion while preserving context in board tasks. Use when starting a session, scoping a task, implementing a task, verifying work, completing a task, or when the user invokes session-status, scope-task, work-task, verify-task, or complete-task.
---

# Orchestrate Board Work

Treat `board/<ID>/task.md` as the durable handoff and source of truth. Read `AGENTS.md` and the target task before acting. Read relevant attachments under `board/<ID>/files/`.

## Route the request

- `session-status`: Summarize in-progress, scoped, blocked, and high-severity work. Recommend the next task using dependencies, severity, and recent observations.
- `scope-task <ID>`: Inspect the codebase and attachments, resolve material ambiguity, write an implementation-ready scope with acceptance checks and dependencies, then move the task to `Scoped`.
- `work-task <ID>`: Require an adequately scoped task, move it to `In progress`, implement the smallest coherent vertical slice, and verify it. Do not commit or publish unless asked.
- `verify-task <ID>`: Derive checks from scope and changed files, run proportionate automated and manual checks, and record evidence and remaining risks.
- `complete-task <ID>`: Confirm acceptance checks and verification evidence, then set `Completed` and `completed` to today. Do not complete work with unresolved required checks.

## Preserve context

Append a concise timestamped observation after each meaningful stage. Record decisions, changed files, verification commands/results, and blockers. Update `updated` on every edit and keep relationships reciprocal.

Keep new plans and design notes in the task body or `board/<ID>/files/`; do not create loose tracking documents elsewhere.

## Execute safely

Inspect the working tree before editing and preserve unrelated changes. Prefer vertical slices that are independently demonstrable. Review the diff for unintended edits. Report the task ID, new status, verification result, and any remaining risk.
