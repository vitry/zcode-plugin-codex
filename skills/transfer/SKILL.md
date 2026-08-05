---
name: transfer
description: Use when a user wants to continue the current or another persisted Codex conversation as a resumable ZCode session.
---

# ZCode Transfer

Invoke as `$zcode:transfer [--source <codex-thread-id>]`. Treat `--source` as a Codex thread ID; without it, transfer the current thread. Preserve the raw argument vector unchanged.

Resolve the plugin root as the directory two directories above this `SKILL.md`; use its absolute canonical plugin root. Spawn `node "<plugin-root>/scripts/zcode-companion.mjs" transfer <raw-arguments>` without a shell. Pass `ZCODE_CALLER_CONTEXT` only as `{ "callerContext": value }` through protected descriptor 3 and read the trusted response through protected descriptor 4. Never print, render, log, persist, or place that value in argv.

Run in the current turn; do not launch a built-in subagent. Present the companion output verbatim, preserving the ZCode session ID and resume command. Present inaccessible, missing, or ephemeral thread errors and their `$zcode:setup` recovery guidance exactly.
