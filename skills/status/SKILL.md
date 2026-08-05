---
name: status
description: Use when a user wants to inspect, list, or wait for durable ZCode jobs owned by the current Codex session.
---

# ZCode Status

Invoke as `$zcode:status [job-id] [--wait] [--timeout-ms <milliseconds>] [--all]`. Preserve the raw argument vector unchanged. Require an explicit job ID with `--wait`; accept a timeout only with `--wait`.

Resolve the plugin root as the directory two directories above this `SKILL.md`; use its absolute canonical plugin root. Spawn `node "<plugin-root>/scripts/zcode-companion.mjs" status <raw-arguments>` without a shell. Pass `ZCODE_CALLER_CONTEXT` only as `{ "callerContext": value }` through protected descriptor 3 and read the trusted response through protected descriptor 4. Never print, render, log, persist, or place that value in argv.

Run in the current turn; never launch a built-in subagent. Present the companion output verbatim, including ownership markers, terminal state, timeout, and exact `$zcode:result` or `$zcode:cancel` follow-ups.
