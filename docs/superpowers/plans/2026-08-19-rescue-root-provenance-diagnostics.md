# Rescue Root Provenance Diagnostics Implementation Plan

> Execute with subagent-driven development, TDD, per-task spec review, then code-quality review.

**Goal:** Preserve isolated plugin namespaces while making wrong source-root Rescue invocation fail fast and replacing model-built companion paths with an instance-bound launcher.

**Architecture:** Deepen plugin-data resolution to return trusted root provenance, consume that provenance only at the `role-status`/`setup` diagnostic boundary, have the owned parent hook inject one machine-derived sibling launcher descriptor, and front-load its immutable use in the Rescue Skill. The launcher dispatches in-process through a strict Rescue argv allowlist. Do not search or redirect across namespaces.

## Task 1: Root provenance and runtime RED/GREEN

**Files:** `scripts/lib/plugin-data.mjs`, `scripts/zcode-companion.mjs`, `skills/rescue/launcher.mjs`, `tests/plugin-data.test.mjs`, `tests/integration/companion.test.mjs`, and a focused launcher test.

1. Add RED unit tests for `{dataRoot, provenance}` across installed cache, source checkout, explicit `ZCODE_DATA_ROOT`, invalid cache-like paths, aliases, and Windows path normalization.
2. Add RED integration tests reproducing an installed-only lifecycle followed by source `role-status`; require fixed `source-session-unproven`, no `$zcode:setup` loop, and no leaked path/task/session details.
3. Add RED setup coverage for the source-specific fixed remedy while preserving the existing error code/category.
4. Add controls: a proven source lifecycle remains ready; installed missing-turn behavior remains unchanged; Role/config/inspection failures are not relabeled.
5. Add RED launcher tests for the exact Rescue argv allowlist, rejected extra/user text/setup/public commands, same-process TTY/stdin/stdout/signal/exit behavior, and self-bound companion import.
6. Export the existing companion CLI entry without changing direct execution; add the sibling launcher that validates argv then dispatches in-process.
7. Implement the deep resolver while preserving `resolvePluginDataRoot()`.
8. Narrowly classify only pre-inspection source lifecycle failures; keep all other error paths intact.
9. Run focused tests and lint/typecheck/diff-check. Commit.
10. Spec review, then quality/security review; fix and repeat until both approve.

## Task 2: Rescue Skill entry contract RED/GREEN

**Files:** `hooks/user-prompt-hook.mjs`, `tests/hooks.test.mjs`, `skills/rescue/SKILL.md`, `agents/zcode-rescue.toml.template`, `tests/helpers/rescue-skill-contract.mjs`, `tests/skills-contracts.test.mjs`, and managed-Role/setup tests.

1. Run a baseline pressure scenario in a fresh subagent: active installed Skill, cwd is the source repository, and a source-relative command is salient. Record whether it chooses the wrong root or setup loop.
2. Add RED hook tests requiring every owned parent turn to receive one exact launcher descriptor derived from the executing plugin instance, while subagents, external sessions, task/session/job text, and user-forged launcher strings cannot supply it.
3. Add RED static/behavioral tests requiring the immutable `rescueLauncherPath` gate before objective/routing, launcher-only commands everywhere, explicit direct-companion/cwd-relative/PATH/root-switch prohibitions, and terminal handling of missing/ambiguous launcher or `source-session-unproven` with zero setup/prepare/spawn/followup.
4. Update the named Role and generic assignment to carry the already-bound launcher path without child rediscovery; preserve one-command-per-assignment and task blindness.
5. Rewrite only the entry and duplicated command wording needed to make the invariant short, early, and unambiguous; do not alter routing precedence or private preparation.
6. Repeat the same pressure scenario and require exact reuse of the hook-provided launcher.
7. Run hook, Skill, managed Role, setup, and integration focused tests. Commit.
8. Spec review, then quality review; fix and repeat until approved.

## Task 3: Public contract and marketplace snapshot

**Files:** `README.md`, `README.zh-CN.md`, `SECURITY.md`, `CHANGELOG.md`, release/marketplace contract tests, generated `marketplace/plugins/zcode/**`, and provenance.

1. Add RED release tests for namespace isolation, the new fixed diagnostic, and the prohibition on source-root setup retry.
2. Document that source and installed namespaces intentionally differ, how the Skill selects its companion, and the safe remedy.
3. Run the relevant contract and parity tests; commit all source/docs/tests.
4. From the clean exact source SHA, run the official marketplace builder once and commit generated output/provenance separately.
5. Run isolated marketplace install/build/parity tests.
6. Spec review, then quality review; fix and repeat until approved.

## Task 4: Final qualification, PR, and CI

1. Run focused incident regression and Skill pressure qualification.
2. Run `npm test`, qualified tests, lint, typecheck, line-ending check, and `git diff --check`.
3. Request whole-branch Spec and Standards reviews against the fixed base; resolve all Critical/Important findings and rerun affected verification.
4. Push `fix/rescue-root-diagnostics`, open a PR with RED/GREEN evidence and explicit compatibility statement.
5. Watch every required CI check to completion. Diagnose and fix failures in scope, repeat review/verification, and stop only after the PR is green.
