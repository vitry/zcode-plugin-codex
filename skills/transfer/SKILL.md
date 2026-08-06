---
name: transfer
description: Use when a user wants to continue the current or another persisted Codex conversation as a resumable ZCode session.
---

# ZCode Transfer

Invoke as `$zcode:transfer [--source <codex-thread-id>]`. Treat `--source` as a Codex thread ID; without it, transfer the current thread. The native prompt hook has already recorded the exact arguments; never copy them into a process command.

Resolve the plugin root as the directory two directories above this `SKILL.md`; use its absolute canonical plugin root. With the available terminal tool, run exactly the constant command `node "<plugin-root>/scripts/zcode-companion.mjs" invoke transfer` over ordinary stdio. Do not add arguments, thread IDs, credentials, or private descriptors.

Run in the current turn; do not launch a built-in subagent. Present the companion output verbatim, preserving the ZCode session ID and resume command. Present inaccessible, missing, or ephemeral thread errors and their `$zcode:setup` recovery guidance exactly.
