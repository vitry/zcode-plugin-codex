# Changelog

All notable changes follow Semantic Versioning.

## Unreleased

- Fixed installed `$zcode:*` skills failing with `DATA_ROOT_REQUIRED` when Codex does not inject `PLUGIN_DATA` into ordinary skill commands.
- Added marketplace-qualified plugin-data discovery and a restart-safe `$zcode:setup` bootstrap that configures the data directory as a writable root before persisting state.
- Added ZCode CLI 0.16.1 compatibility for runtime-preference server requests with string IDs.
- Improved `$zcode:setup` guidance when the ZCode CLI has no model provider configured, including the distinction between Desktop and CLI settings and API-key providers that do not require OAuth.

## 0.1.0 - 2026-08-06

- Added eight native `$zcode:*` skills for review, adversarial review, Rescue, Transfer, job inspection, cancellation, and setup.
- Added direct ZCode Protocol sessions, model and effort selection, imported Codex history, durable owner-scoped jobs, single-use background execution, and strict permission routing.
- Added Codex lifecycle hooks, optional Stop review gate, a publishable `vitry` marketplace snapshot, marketplace hook trust setup, cross-platform fake peers, packed production installation checks, and opt-in macOS real-ZCode qualification.
