---
name: result
description: Use when a user wants the complete stored output of a finished ZCode job in the current workspace.
---

# ZCode Result

Invoke as `$zcode:result [job-id]`; without an ID, allow the companion to select the latest eligible owned job. The native prompt hook has already recorded the exact arguments.

Resolve the plugin root as the directory two directories above this `SKILL.md`; use its absolute canonical plugin root. With the available terminal tool, run exactly the constant command `node "<plugin-root>/scripts/zcode-companion.mjs" invoke result` over ordinary stdio. Do not add arguments, job IDs, credentials, or private descriptors.

Run in the current turn; never launch a built-in subagent. Present the complete companion output verbatim, including findings, paths, line numbers, parse errors, and exact `$zcode:status` recovery commands.
