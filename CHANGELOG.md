# Changelog

All notable changes follow Semantic Versioning.

## Unreleased

- Stopped writing the Codex host's `hide_spawn_agent_metadata` flag; one setup now reconciles the managed Role and safely removes only a legacy `false` proved by complete numeric-v1 ownership evidence.
- Added a packaged bilingual manual-uninstall guide for receipt-gated Role/config cleanup while retaining durable jobs, results, progress, logs, and history by default.
- Fixed `$zcode:setup` managed Role reconciliation with Codex 0.147 effective configuration, which normalizes an otherwise exact Role registration with `nickname_candidates = null`.
- Fixed local cachebuster reinstallations so SemVer build metadata keeps the installed plugin's marketplace-qualified data root valid.
- Fixed installed `$zcode:*` skills failing with `DATA_ROOT_REQUIRED` when Codex does not inject `PLUGIN_DATA` into ordinary skill commands.
- Added marketplace-qualified plugin-data discovery and a restart-safe `$zcode:setup` bootstrap that configures the data directory as a writable root before persisting state.
- Added ZCode CLI 0.16.1 compatibility for runtime-preference server requests with string IDs.
- Improved `$zcode:setup` guidance when the ZCode CLI has no model provider configured, including the distinction between Desktop and CLI settings and API-key providers that do not require OAuth.
- Added foreground activity output, a 20-second heartbeat, and durable status previews for long-running ZCode work.
- Added bounded foreground `SIGINT` and `SIGTERM` handling: the plugin cancels before session creation or sends `session/stop` only to the exact persisted ZCode session, while background jobs continue until completion or explicit cancellation with `$zcode:cancel`.
- Added safe orphan settlement through best-effort `SessionEnd` handling and a reservation-time crash fallback while preserving owner-only access. A broker-unavailable orphan with a free worker lease is archived as `failed` and releases the writable guard; an unacknowledged stop on a reachable control channel still retains the guard.
- Added a digest-backed managed `zcode-rescue` Role, one isolated native child for foreground Rescue and same-child choices, bounded semantic progress, parent-output isolation, unchanged production-owned background authorization, and opt-in installed Codex 0.147 qualification coverage for steering, acknowledged cancellation, and durable loss recovery.
- Hardened marketplace publication to require an exact clean source commit, build from an isolated detached worktree after its own lockfile-driven `npm ci --ignore-scripts`, record the dependency-lock hash, verify the complete bundled runtime, reject canonical or symlink output overlap, and atomically publish only a complete staged snapshot.
- Strengthened installed Codex 0.147 qualification with fail-closed runtime identity negatives, exact child semantic-progress evidence, private production capability verification, and an explicit scoped observation when the noninteractive harness cannot expose TUI events.
- Restored `ZCODE_REAL_E2E_MODEL` as the canonical real qualification model variable; the deprecated `ZCODE_REAL_MODEL` alias is accepted only when it does not conflict.
- Kept the package version at `0.1.0` for these Unreleased behavior changes.

## 0.1.0 - 2026-08-06

- Added eight native `$zcode:*` skills for review, adversarial review, Rescue, Transfer, job inspection, cancellation, and setup.
- Added direct ZCode Protocol sessions, model and effort selection, imported Codex history, durable owner-scoped jobs, single-use background execution, and strict permission routing.
- Added Codex lifecycle hooks, optional Stop review gate, a publishable `vitry` marketplace snapshot, marketplace hook trust setup, cross-platform fake peers, packed production installation checks, and opt-in macOS real-ZCode qualification.
