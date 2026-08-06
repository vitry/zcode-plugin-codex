---
name: rescue
description: Use when a user wants ZCode to investigate, implement, repair, or continue a substantial coding task in the current workspace.
---

# ZCode Rescue

Invoke as `$zcode:rescue [--background | --wait] [--resume | --fresh] [--model <provider/model|alias>] [--effort none|minimal|low|medium|high|xhigh] <task...>`.

Require non-empty task text. Rescue may change the workspace and defaults to foreground. The native prompt hook has already recorded the exact arguments and task text; never copy user text into a process command.

Resolve the plugin root as the directory two directories above this `SKILL.md`; use its absolute canonical plugin root. With the available terminal tool, run exactly the constant command `node "<plugin-root>/scripts/zcode-companion.mjs" invoke rescue` over ordinary stdio. Do not add arguments, task text, job IDs, credentials, or private descriptors.

If the companion returns `needs-choice`, ask once whether to resume the eligible Rescue session or start fresh. For resume run only `node "<plugin-root>/scripts/zcode-companion.mjs" invoke-choice rescue resume`; for fresh run only the corresponding constant command ending in `invoke-choice rescue fresh`. Stay in the current turn; production owns any background worker.

Present ZCode's output verbatim. Preserve validation, setup, permission, timeout, resume, and job recovery commands exactly.
