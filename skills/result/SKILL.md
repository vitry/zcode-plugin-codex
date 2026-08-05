---
name: result
description: Use when a user wants the complete stored output of a finished ZCode job in the current workspace.
---

# ZCode Result

Invoke as `$zcode:result [job-id]`. Preserve the raw argument vector unchanged; without an ID, allow the companion to select the latest eligible owned job.

Resolve the plugin root as the directory two directories above this `SKILL.md`; use its absolute canonical plugin root. Spawn `node "<plugin-root>/scripts/zcode-companion.mjs" result <raw-arguments>` without a shell. Pass `ZCODE_CALLER_CONTEXT` only as `{ "callerContext": value }` through protected descriptor 3 and read the trusted response through protected descriptor 4. Never print, render, log, persist, or place that value in argv.

Run in the current turn; never launch a built-in subagent. Present the complete companion output verbatim, including findings, paths, line numbers, parse errors, and exact `$zcode:status` recovery commands.
