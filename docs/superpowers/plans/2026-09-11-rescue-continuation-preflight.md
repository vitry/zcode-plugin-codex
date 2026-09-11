# Rescue Continuation Preflight Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox syntax for tracking.

**Goal:** Prevent a new Codex Host from inferring operation resume merely from project progress.

**Architecture:** Attach a strictly local, read-only current-parent binding observation to the existing owned `role-status rescue` response. The Skill uses it for inferred mode selection; private prepare remains the activation authority.

**Tech Stack:** Node.js ES modules, node:test, existing private binding codecs and Codex launcher.

## Task 1: Runtime observation and boundary tests

Files: add an observation method in `scripts/lib/state.mjs` with focused unit tests;
update `scripts/zcode-companion.mjs` and existing role-status integration tests.
Reuse the state module's bounded binding/index readers and noncreating storage
resolution pattern. A focused `scripts/lib/rescue-continuation-preflight.mjs` is
optional if it avoids duplicating those checks. Avoid changing existing state
codecs or schemas.

- [ ] Add failing fixtures for exact-parent absence, another parent's evidence,
  current-parent evidence, incomplete/corrupt storage, legacy evidence, and local
  read failures. Snapshot files before/after to prove no business-state writes.
- [ ] Implement a closed public observation shape:

  ```js
  { state: 'none' } // or 'present', 'blocked'; no private identifiers
  ```

- [ ] Wire observation only after real owned-parent identity and Role readiness
  succeed. Use canonical target cwd with the existing linked-worktree preview.
  Dependency-injected role-only tests must not accidentally inspect real user data.
- [ ] Exercise the real command seam with role-status fixtures, checking no ZCode
  invocation, no consumed preparation, and no new immutable workspace binding.
- [ ] Run the focused new unit test and role-status integration tests. Existing
  `node --test tests/rescue-route-planner.test.mjs tests/rescue-launcher-command.test.mjs`
  baseline is 154 passing tests on commit `130b652`.

## Task 2: Skill routing and documentation

Files: `skills/rescue/SKILL.md`, relevant Skill contract/qualification tests,
`docs/adr/0013-bind-rescue-child-to-zcode-session.md`, and user-facing Rescue docs
if their route description needs to change.

- [ ] Move inferred mode selection after owned Role preflight while keeping active
  exact-child rejoin first. Document all seven routing rules in the spec.
- [ ] Assert new-parent project continuation uses fresh, same-parent exact
  continuation remains resume, and explicit same-operation intent cannot silently
  become fresh. Cover blocked or missing observations and multiple retained tasks.
- [ ] Reconcile older contradictory "clear continuation always resumes" wording;
  do not remove exact-child selection or fail-closed prepare contracts.
- [ ] Keep marketplace mirrors using the repository's established symlink/snapshot
  process; do not hand-edit a user's installed plugin cache.

## Task 3: Review, verification, and PR

- [ ] Implementer self-review, then independent spec review and code-quality review.
- [ ] Fix findings and rerun affected checks.
- [ ] Run `npm run check` (report environment-dependent qualification skips honestly)
  and inspect the final diff for private data and unrelated changes.
- [ ] Commit the scoped changes, push `fix/rescue-continuation-preflight`, and create
  a PR against `main` with symptom, resulting behavior, scope limitations, and tests.

The user explicitly requested subagent implementation and a PR. No additional
design-approval or execution-mode prompt is needed for this bounded change.
