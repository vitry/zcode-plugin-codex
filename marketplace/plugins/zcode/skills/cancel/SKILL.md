---
name: cancel
description: Use when a user wants to stop an active or queued ZCode job owned by the current Codex session.
---

# ZCode Cancel

Invoke as `$zcode:cancel [job-id]`; without an ID, allow the companion to select the latest eligible owned job. The native prompt hook has already recorded the exact arguments.

Resolve the plugin root as the directory two directories above this `SKILL.md`; use its absolute canonical plugin root. With the available terminal tool, run exactly the constant command `node "<plugin-root>/scripts/zcode-companion.mjs" invoke cancel` over ordinary stdio. Do not add arguments, job IDs, credentials, or private descriptors.

Run in the current turn; never launch a built-in subagent. Present the companion output verbatim. Never describe cancellation as successful unless the returned state does; preserve stop failures and exact `$zcode:status` recovery commands.

Invocation from either the eligible origin workspace or its exact bound execution target resolves to the same selected target partition, which the companion preserves privately across later turns as the one lifecycle-authoritative current job partition. Never scan or merge workspace partitions. An explicit job ID cannot cross-partition or expand owner authority.
