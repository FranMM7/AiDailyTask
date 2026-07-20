# Changelog

All notable changes to AiDailyTasks are documented here. The project follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) conventions.

## Unreleased — 2026-07-20

### Added

- Task `skills` metadata with multi-value editing, configured suggestions, deterministic Markdown
  persistence, Markdown export, and MCP create/read/update support.
- A Settings view beside Export for board-column and navigation visibility plus local CRUD of
  statuses, categories, skills, severities, and risks. Backlog and Completed ids are protected.
- Task-graph status filtering, independent-task visibility, URL-backed focus, recursive
  dependency/parent isolation, clear focus, and double-click task details.
- A once-per-MCP-session Graphify project-study hint when the task project has a ready Graphify
  index. The advisory never runs indexing or a graph query automatically.
- Recurring tasks. Archiving completed recurring work creates one clean Backlog successor with
  lineage-based duplicate prevention and reports the successor through REST, MCP, and UI feedback.
- Six verified screenshots covering task skills, settings/vocabulary, configurable board columns,
  graph focus, and recurring successors.

### Changed

- Statuses, categories, severity, and risk contracts now accept configured local values instead of
  compile-time-only enums.
- Markdown exports include task skills and recurrence state.
- Agent guidance now distinguishes classification tags from execution skills and requires task
  skills to influence planning, implementation, and verification without broadening authority.
- README setup now starts from a clean clone and documents the repository's private, git-ignored
  board/project data model.

### Compatibility and verification

- Existing task files remain valid: missing `skills` becomes `[]`, missing `recurring` becomes
  `false`, and missing recurrence lineage becomes `null`.
- Workspace typecheck and production builds passed. Browser coverage passed at 1440×1000 and
  390×844 with no console/page errors. Stdio MCP checks covered tags/skills, settings, Graphify
  hint side effects, and concurrent recurring-task archive behavior.
- A disposable clone under `C:\Code\Others` was seeded for final QA and permanently removed after
  screenshot capture.
