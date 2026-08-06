---
name: review
description: Use when a user wants ZCode to review current Git changes or a branch comparison for correctness and regressions.
---

# ZCode Review

Invoke as `$zcode:review [--wait | --background] [--base <git-ref>] [--scope auto|working-tree|branch]`.

Keep this review always read-only. Do not edit, modify, apply, or fix workspace files. The native prompt hook has already recorded the exact arguments and focus text; never copy user text into a process command.

Resolve the plugin root as the directory two directories above this `SKILL.md`; use its absolute canonical plugin root. With the available terminal tool, run exactly the constant command `node "<plugin-root>/scripts/zcode-companion.mjs" invoke review` over ordinary stdio. Do not add arguments, task text, job IDs, credentials, or private descriptors.

If the companion returns `needs-choice`, ask once between foreground and background, recommending foreground only for a clearly tiny change. For foreground run only `node "<plugin-root>/scripts/zcode-companion.mjs" invoke-choice review wait`; for background run only the corresponding constant command ending in `invoke-choice review background`. Stay in the current turn; production owns any background worker.

Present the companion output verbatim without adding a second review. Preserve validation, setup, permission, timeout, and job errors, including every `$zcode:setup`, `$zcode:status`, or `$zcode:result` recovery command.
