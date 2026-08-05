---
name: cancel
description: Use when a user wants to stop an active or queued ZCode job owned by the current Codex session.
---

# ZCode Cancel

Invoke as `$zcode:cancel [job-id]`. Preserve the raw argument vector unchanged; without an ID, allow the companion to select the latest eligible owned job.

Resolve the plugin root as the directory two directories above this `SKILL.md`; use its absolute canonical plugin root. Spawn `node "<plugin-root>/scripts/zcode-companion.mjs" cancel <raw-arguments>` without a shell. Pass `ZCODE_CALLER_CONTEXT` only as `{ "callerContext": value }` through protected descriptor 3 and read the trusted response through protected descriptor 4. Never print, render, log, persist, or place that value in argv.

Run in the current turn; never launch a built-in subagent. Present the companion output verbatim. Never describe cancellation as successful unless the returned state does; preserve stop failures and exact `$zcode:status` recovery commands.
