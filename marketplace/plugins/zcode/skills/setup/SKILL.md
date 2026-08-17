---
name: setup
description: Use when a user needs ZCode discovery, version, authentication, hook trust, or optional review-gate diagnostics.
---

# ZCode Setup

Invoke as `$zcode:setup [--enable-review-gate | --disable-review-gate]`. Preserve the raw argument vector unchanged.

Resolve the plugin root as the directory two directories above this `SKILL.md`; use its absolute canonical plugin root. Run `node "<plugin-root>/scripts/zcode-companion.mjs" setup <raw-arguments>` in the current workspace without a shell. This is the only public skill that uses ordinary stdio and no protected authorization descriptor.

Run in the current turn; never launch a built-in subagent. Do not install ZCode, authenticate on the user's behalf, or edit plugin files. Present the complete companion output verbatim, including readiness, restart requirements, review-gate state, and next steps.

Setup owns the digest-backed `zcode-rescue` Role only beneath stable plugin data; it never writes the Role into a versioned plugin cache. One setup (`$zcode:setup`) run reconciles a fresh Role install, an owned upgrade, and a proven numeric-v1 receipt migration. ZCode does not own `hide_spawn_agent_metadata`; the Codex host owns the collaboration tool schema and decides whether it supplies `agent_type`. Setup removes only the legacy target-layer `false` proved by complete numeric-v1 ownership evidence. When setup must bootstrap the plugin data writable root before it can persist state, it reports the only separate `restart-required` and asks the user to restart Codex. Do not reinterpret a collision as repairable: a foreign same-name Role, project shadow, higher-precedence override, missing receipt, or modified Role/config must remain fail closed exactly as reported. Never suggest copying, adopting, or deleting the conflicting Role.

Workspace model policy is written only when the user explicitly supplies setup environment variables. `ZCODE_SETUP_DEFAULT_MODEL` is an alias, `provider/model`, or exact model ID. `ZCODE_SETUP_MODEL_ALIASES_JSON` is a JSON object whose values are exact `{providerId, modelId, variant?}` tuples. Setup persists a private canonical-workspace `config/models.json`; ordinary run commands use explicit `--model`, then its `defaultModel`, then ZCode's default. Never use or recommend the legacy runtime-only `ZCODE_MODEL_ALIASES` variable.
