---
name: rescue
description: Use when a user wants ZCode to investigate, implement, repair, or continue a substantial coding task in the current workspace.
---

# ZCode Rescue

Invoke as `$zcode:rescue [--background | --wait] [--resume | --fresh] [--model <provider/model|alias>] [--effort none|minimal|low|medium|high|xhigh] <task...>`.

Require non-empty task text. Rescue may change the workspace and defaults to foreground. Use the built-in `zcode:zcode-rescue` forwarding subagent only when `--background` is explicit; otherwise execute in the current turn. Preserve the raw argument vector unchanged, including model, effort, routing flags, and task text.

Resolve the plugin root as the directory two directories above this `SKILL.md`; use its absolute canonical plugin root. Spawn `node "<plugin-root>/scripts/zcode-companion.mjs" rescue <raw-arguments>` without a shell. Pass `ZCODE_CALLER_CONTEXT` only as `{ "callerContext": value }` through protected descriptor 3 and read the trusted response through protected descriptor 4. Never print, render, log, persist, or place that value in argv.

If the companion returns `needs-choice`, ask once whether to continue the eligible Rescue session or start fresh, then repeat the same invocation with the selected `--resume` or `--fresh` while preserving every original token. For explicit background work, give the forwarding subagent only the returned reserved job ID and one-time execution capability; never send it the caller context or original task.

Present ZCode's output verbatim. Preserve validation, setup, permission, timeout, resume, and job recovery commands exactly.
