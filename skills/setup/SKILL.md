---
name: setup
description: Use when a user needs ZCode discovery, version, authentication, hook trust, or optional review-gate diagnostics.
---

# ZCode Setup

Invoke as `$zcode:setup [--enable-review-gate | --disable-review-gate]`. Preserve the raw argument vector unchanged.

Resolve the plugin root as the directory two directories above this `SKILL.md`; use its absolute canonical plugin root. Run `node "<plugin-root>/scripts/zcode-companion.mjs" setup <raw-arguments>` in the current workspace without a shell. This is the only public skill that uses ordinary stdio and no protected authorization descriptor.

Run in the current turn; never launch a built-in subagent. Do not install ZCode, authenticate on the user's behalf, change a model, or edit plugin files. Present the complete companion output verbatim, including readiness, restart requirements, review-gate state, and next steps.
