---
name: setup
description: Use when a user needs ZCode discovery, version, authentication, hook trust, or optional review-gate diagnostics.
---

# ZCode Setup

Invoke as `$zcode:setup [--enable-review-gate | --disable-review-gate]`. Preserve the raw argument vector unchanged.

Resolve the plugin root as the directory two directories above this `SKILL.md`; use its absolute canonical plugin root. Run `node "<plugin-root>/scripts/zcode-companion.mjs" setup <raw-arguments>` in the current workspace without a shell. This is the only public skill that uses ordinary stdio and no protected authorization descriptor.

Run in the current turn; never launch a built-in subagent. Do not install ZCode, authenticate on the user's behalf, or edit plugin files. Present the complete companion output verbatim, including readiness, restart requirements, review-gate state, and next steps.

Workspace model policy is written only when the user explicitly supplies setup environment variables. `ZCODE_SETUP_DEFAULT_MODEL` is an alias, `provider/model`, or exact model ID. `ZCODE_SETUP_MODEL_ALIASES_JSON` is a JSON object whose values are exact `{providerId, modelId, variant?}` tuples. Setup persists a private canonical-workspace `config/models.json`; ordinary run commands use explicit `--model`, then its `defaultModel`, then ZCode's default. Never use or recommend the legacy runtime-only `ZCODE_MODEL_ALIASES` variable.
