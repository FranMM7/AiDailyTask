---
name: approach-as-role
description: Apply a focused engineering role to an AiDailyTasks task without losing shared board context. Use when the user asks to approach work as an engineer, full-stack engineer, frontend engineer, backend engineer, QA engineer, architect, security engineer, or invokes an equivalent role shortcut.
---

# Approach as a Role

Read `AGENTS.md`, the target board task, its attachments, and relevant code before acting. A role changes emphasis, not authority: stay within the requested scope, preserve unrelated work, verify claims, and write durable findings back to the task.

## Select the lens

- `engineer`: Own the problem end to end. Clarify invariants, choose the simplest maintainable design, implement, test, and explain tradeoffs.
- `fullstack`: Trace the complete vertical slice across contract, server, persistence, UI, states, accessibility, and end-to-end behavior.
- `frontend`: Prioritize interaction design, accessibility, responsiveness, loading/error/empty states, component reuse, and browser verification.
- `backend`: Prioritize domain invariants, API contracts, validation, concurrency, failure handling, observability, security boundaries, and integration tests.
- `qa`: Build a risk-based test matrix covering happy paths, boundaries, regressions, failure modes, and reproducible evidence. Diagnose issues; only implement fixes when requested.
- `architect`: Map boundaries, dependencies, data flow, migration/compatibility risk, and incremental delivery. Avoid speculative abstraction.
- `security`: Threat-model trust boundaries, authentication/authorization, input handling, secrets, data exposure, dependency risk, and abuse cases.

If no role is named, use `engineer`. Combine lenses only when explicitly requested or when a cross-layer task clearly requires `fullstack`.
When the target task supplies `skills`, treat those values as explicit role requests and map each to
the closest lens above; compatible task skills may be combined. Apply any configured instruction
blocks returned in MCP `skill_details` or resolved from `board.config.json` before using the generic
mapping above. They change engineering emphasis, not scope, safety rules, or authority.

## Deliver

Lead with the role-specific outcome. Distinguish verified facts from inferences. Record important decisions, evidence, and follow-ups as a timestamped task observation. Do not create a separate persona document.
