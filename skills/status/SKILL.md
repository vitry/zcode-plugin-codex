---
name: status
description: Use when a user wants to inspect, list, or wait for durable ZCode jobs owned by the current Codex session.
---

# ZCode Status

Invoke as `$zcode:status [job-id] [--wait] [--timeout-ms <milliseconds>] [--all]`. Require an explicit job ID with `--wait`; accept a timeout only with `--wait`. The native prompt hook has already recorded the exact arguments.

Resolve the plugin root as the directory two directories above this `SKILL.md`; use its absolute canonical plugin root. With the available terminal tool, run exactly the constant command `node "<plugin-root>/scripts/zcode-companion.mjs" invoke status` over ordinary stdio. Do not add arguments, job IDs, credentials, or private descriptors.

Run in the current turn; never launch a built-in subagent. Present the companion output verbatim, including ownership markers, terminal state, timeout, and exact `$zcode:result` or `$zcode:cancel` follow-ups.

Status is the durable recovery surface after a parent turn, Rescue child, or Codex process is lost. Semantic progress is a bounded public preview, not raw child output, and owner-only result/cancel rules still apply; `--all` exposes only redacted other-owner metadata. Before uninstall, use status/result/cancel to settle owned jobs: uninstall does not automatically erase durable job records or stable plugin data.

The companion resolves one lifecycle-authoritative current job partition from the origin workspace or its exact bound execution target and preserves it privately across later turns. Never scan or merge workspace partitions. An explicit job ID cannot cross-partition or expand owner authority.
