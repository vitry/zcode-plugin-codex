---
name: adversarial-review
description: Use when a user wants ZCode to challenge an implementation, its assumptions, tradeoffs, or hidden failure modes.
---

# ZCode Adversarial Review

Invoke as `$zcode:adversarial-review [--wait | --background] [--base <git-ref>] [--scope auto|working-tree|branch] [review focus...]`.

Keep this review always read-only. Do not edit, modify, apply, or fix workspace files. Preserve the raw argument vector unchanged, including all focus text, and present ZCode's output verbatim without weakening or supplementing it.

Resolve the plugin root as the directory two directories above this `SKILL.md`; use its absolute canonical plugin root. Spawn `node "<plugin-root>/scripts/zcode-companion.mjs" adversarial-review <raw-arguments>` without a shell. Pass `ZCODE_CALLER_CONTEXT` only as `{ "callerContext": value }` through protected descriptor 3 and read the trusted response through protected descriptor 4. Never print, render, log, persist, or place that value in argv.

Honor explicit `--wait` or `--background`. Without either flag, estimate the selected Git scope and ask once between foreground and background, recommending foreground only for a clearly tiny change. Preserve all existing tokens when adding the chosen execution flag. Use the built-in `zcode:zcode-rescue` forwarding subagent only when `--background` is explicit: give it only the returned reserved job ID and one-time execution capability. Otherwise stay in the current turn.

Present validation, setup, permission, timeout, and job errors verbatim, including every `$zcode:setup`, `$zcode:status`, or `$zcode:result` recovery command.
