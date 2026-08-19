# Rescue Root Provenance Diagnostics Design

**Date:** 2026-08-19

## Problem

An installed Rescue Skill can be active while a model accidentally runs the source-checkout command `node scripts/zcode-companion.mjs ...`. The two companions are byte-identical, but they intentionally use different private namespaces: an installed plugin uses `zcode-<marketplace>` and a source checkout uses the legacy `zcode` development root. The source command therefore cannot see the installed active turn or managed Role.

Today `role-status` collapses that identity failure into `unsupported` and recommends `$zcode:setup`. Setup then reports `SETUP_SESSION_UNPROVEN`, which looks like a broken upgrade and encourages a useless setup loop. The Skill already describes the correct installed absolute path, but the rule is buried and does not explicitly forbid cwd-relative invocation.

## Goals

- Preserve marketplace-qualified and source-development namespace isolation.
- Detect an unbound source-checkout lifecycle accurately and fail before setup or child spawn.
- Return a fixed, task-free diagnostic that tells Root to use the companion resolved from the active Skill.
- Put the companion-root invariant before all Rescue classification and routing prose.
- Keep intentional source development usable when that source namespace has a proven active lifecycle.
- Keep public output free of filesystem paths, data roots, session IDs, tasks, and authorization material.

## Non-goals

- Do not merge, alias, search, or copy state between `zcode` and `zcode-<marketplace>`.
- Do not auto-discover or redirect to another installed plugin version.
- Do not treat every source checkout as invalid.
- Do not weaken active-turn, managed-Role, workspace, or executor authorization.

## Design

### Root provenance

Deepen `scripts/lib/plugin-data.mjs` so one resolution returns both the canonical data root and a small trusted provenance value:

- `marketplace`: the companion is under the exact installed cache shape already accepted by the resolver;
- `source`: every other accepted plugin root, including the repository checkout.

The existing `resolvePluginDataRoot()` remains compatible and delegates to the deeper resolver. No marketplace name, plugin path, or data root is exposed in public output.

### Diagnostic boundary

`role-status rescue` keeps all existing managed-Role statuses. It may return one new fixed status, `source-session-unproven`, only when all of these are true:

1. the trusted companion provenance is `source`;
2. the current invocation cannot prove its active turn/session in that source namespace; and
3. no managed-Role inspection has begun.

Its fixed remedy tells Root to invoke the absolute companion path derived from the active Rescue Skill and explicitly says not to run setup from this source checkout. Other discovery, configuration, Role, Codex app-server, and inspection failures retain their existing status/error behavior; they are not relabeled as root mistakes.

`setup` similarly preserves the underlying authorization failure but gives the same source-specific fixed remedy when its source namespace lacks a provable active lifecycle. It never reads or mutates the installed namespace.

### Skill entry gate

Immediately after the Skill front matter, before objective normalization or routing, Root must bind one immutable `rescuePluginRoot` from the current `SKILL.md` location. Every parent and child companion command must use:

`node "<rescuePluginRoot>/scripts/zcode-companion.mjs" ...`

The Skill explicitly forbids cwd-relative `node scripts/zcode-companion.mjs`, PATH/global/package discovery, repository-root inference, and switching plugin roots after a diagnostic. A `source-session-unproven` result is terminal for that route: report the fixed remedy and do not call setup, prepare, spawn, or follow up.

This keeps the model-facing rule short while the program remains the authority for provenance and isolation.

## Compatibility and rollout

- Existing installed data and source-development data remain byte-for-byte in their current locations.
- Existing ready/install/upgrade/drift/conflict statuses are unchanged.
- Existing source development succeeds when its own hook lifecycle is present.
- The Role template is unchanged unless implementation review proves a child-side entry rule is also required.
- Source changes are committed first; the marketplace snapshot is generated once from a clean exact source commit and committed separately with matching provenance.

## Verification

- Unit tests for exact installed/source provenance and explicit data-root compatibility.
- Integration tests reproducing source command plus installed-only lifecycle without allowing setup/spawn.
- Negative tests proving genuine Role/config failures are not mislabeled.
- Skill pressure tests where an agent starts in the source repository and is tempted to run a cwd-relative command; RED before the edit, GREEN after it.
- Source/marketplace byte parity, isolated install, full tests, lint, typecheck, line endings, and PR CI.
