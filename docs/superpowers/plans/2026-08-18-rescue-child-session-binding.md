# Exact Rescue Child Session Binding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` and `superpowers:test-driven-development`. Implement each task RED → GREEN, commit only owned files, and do not revert concurrent changes.

**Goal:** Persist an exact Rescue-child operation binding so Root can continue the same stopped Rescue child on the exact ZCode session across parent turns, while retaining legacy choice behavior and fail-closed security.

**Architecture:** A versioned private binding record maps the trusted `(canonical workspace, parent session, executor agent)` identity to a stable anchor job and latest operation job. StateStore publishes binding changes and job reservations under one lock. Root chooses fresh/resume and either spawns a new child or follows up the exact existing child; the child continues to run only constant `invoke-prepared rescue`/`invoke-choice` commands.

**Tech Stack:** Node.js ESM, `node:test`, private filesystem state, Codex lifecycle hooks, TOML/Markdown installed contracts, generated marketplace snapshot.

---

## Task 1: Binding Model and Atomic StateStore Operations

**Ownership:** `scripts/lib/rescue-binding.mjs`, `scripts/lib/state.mjs`, focused state/binding tests only.

**Files:**
- Create: `scripts/lib/rescue-binding.mjs`
- Create: `tests/rescue-binding.test.mjs`
- Modify: `scripts/lib/state.mjs`
- Modify: `tests/state.test.mjs` only when an existing StateStore compatibility assertion belongs there

- [ ] Write failing tests for a pure exact binding codec/key API. Cover exact
  keys, version/state enums, canonical workspace, safe identifiers, timestamps,
  `operationId`, active/closed nullability, duplicate JSON keys, unknown keys,
  byte/count bounds, defensive copies, and fixed secret-free errors.
- [ ] Run `node --test tests/rescue-binding.test.mjs` and record the expected
  missing-module/API RED.
- [ ] Implement the deep pure helpers in `rescue-binding.mjs`; do not add job IO,
  public CLI parsing, task data, or ZCode session copies.
- [ ] Write failing StateStore tests for these wished-for deep methods:

```js
state.resolveRescueBinding({ parentSessionId, executorAgentId, permissionMode })
state.reserveFreshRescueJob({ reservation, executor })
state.reserveBoundRescueContinuation({ reservation, executor, operationId })
state.adoptRescueCandidate({ reservation, executor, candidateJobId })
state.closeRescueBindingsForSession({ parentSessionId, reason: 'session-ended' })
```

- [ ] Require `resolveRescueBinding` to return `{kind:'missing'}` only for true
  absence and `{kind:'bound', operationId, anchorJob, currentJob}` for a valid
  record. All corrupt/mismatch/dangling/cancelled/no-session cases fail closed.
- [ ] Require `reserveFreshRescueJob` to replace the generation and atomically
  publish `anchorJobId === currentJobId === job.id` under `.state.lock`.
- [ ] Require `reserveBoundRescueContinuation` to CAS `operationId`, validate the
  exact anchor session, reserve a new job that resumes it, retain `anchorJobId`,
  and atomically advance `currentJobId`.
- [ ] Require `adoptRescueCandidate` to revalidate the explicit legacy candidate,
  adopt it as anchor under current permission, reserve the continuation, and
  establish a new generation in the same transaction.
- [ ] Add concurrency/fault tests: two fresh writers, two continuation writers,
  stale generation, every publication failure seam, dangling record, corrupt
  sibling, symlink/path replacement, scan bound, session/agent/workspace/
  permission mismatch, and no partial published job/binding state.
- [ ] Preserve existing `reserveJob` behavior and persisted job schema; prove an
  old reader ignores `rescue-bindings/` and existing job fixtures remain valid.
- [ ] Implement private storage beneath `<workspace-store>/rescue-bindings/`
  using existing storage resolution, restrictive modes, bounded reads, atomic
  exact JSON writes, and the StateStore lock. Reuse platform-aware path/handle
  snapshot validation.
- [ ] Implement exact SessionEnd close tombstones with CAS-safe generation and
  bounded cleanup; do not close on job terminal or child stop.
- [ ] Run focused tests, lint, typecheck, and `git diff --check`; commit:
  `feat: persist exact Rescue operation bindings`.

## Task 2: Companion Routing, Status, and Lifecycle Integration

**Ownership:** companion/job-control/hooks runtime files and their integration tests. Do not edit Skill/Role/docs/marketplace.

**Files:**
- Modify: `scripts/zcode-companion.mjs`
- Modify: `scripts/lib/job-control.mjs`
- Modify: `hooks/session-end-hook.mjs`
- Modify: `tests/integration/skills.test.mjs`
- Modify: `tests/integration/companion.test.mjs`
- Modify: `tests/job-control.test.mjs`
- Modify: `tests/hooks.test.mjs`
- Modify: `tests/identity.test.mjs` only for pending-choice compatibility

- [ ] Write failing tests proving `invoke-prepared` and `invoke-choice` propagate
  the trusted executor internally into `runCompanion`; no executor/binding/session
  identity may appear in argv, env, output, progress, pending record, or task.
- [ ] Add a two-candidate regression: child A creates session A, child B later
  creates session B, then child A in a new parent turn prepares `resume`; assert
  the fake peer receives `session/resume` for A, never B, with no `needs-choice`.
- [ ] Add fresh, foreground, background, succeeded/failed terminal anchor,
  current-job status, cancelled anchor, wrong permission, wrong workspace,
  sibling executor, replay, and concurrent writable-job cases.
- [ ] Add legacy tests: an old job without a binding still returns
  `needs-choice` for explicit no-choice; `invoke-choice resume` validates/adopts
  it; the next same-child continuation resumes exactly without asking. Explicit
  fresh establishes a new generation. Invalid binding never falls back.
- [ ] Run focused tests and record RED before production changes.
- [ ] Pass trusted executor context from both `invoke-prepared` and
  `invoke-choice` into `runCompanion`/`startPublic` without changing public argv.
- [ ] Select routing as follows: bound+resume → exact continuation transaction;
  bound+fresh → fresh transaction; missing binding → existing legacy candidate
  behavior; invalid binding → fixed failure. Require Root to materialize the
  bound route; do not let the child infer it.
- [ ] Preserve execution-time TOCTOU validation of the exact anchor job/session.
  Never call latest-candidate selection on a valid or invalid binding.
- [ ] Replace parent-turn unique-job “bound status” lookup with exact binding
  `currentJobId`; keep public status/history behavior unchanged.
- [ ] Add SessionEnd binding close to its existing advisory cleanup without
  clearing bindings from UserPrompt, Root Stop, SubagentStop, or job terminal.
- [ ] Run:

```bash
node --test tests/rescue-binding.test.mjs tests/state.test.mjs \
  tests/identity.test.mjs tests/job-control.test.mjs tests/hooks.test.mjs \
  tests/integration/skills.test.mjs tests/integration/companion.test.mjs
npm run lint
npm run typecheck
git diff --check
```

- [ ] Commit: `feat: resume the exact bound Rescue session`.

## Task 3: Root Orchestration, Installed Role, and Public Contracts

**Ownership:** source Skill/Role, contract tests, ADR/release docs. Do not edit generated marketplace files or qualification helper.

**Files:**
- Modify: `skills/rescue/SKILL.md`
- Modify: `agents/zcode-rescue.toml.template`
- Modify: `tests/helpers/rescue-skill-contract.mjs`
- Modify: `tests/skills-contracts.test.mjs`
- Modify: `tests/managed-agent-role.test.mjs`
- Modify: `tests/setup.test.mjs`
- Modify: `tests/release-contracts.test.mjs`
- Create: `docs/adr/0011-bind-rescue-child-to-zcode-session.md`
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `SECURITY.md`
- Modify: `CHANGELOG.md`

- [ ] Write contract RED tests for three Root states:
  active child → rejoin only; stopped same-operation child → preflight, private
  prepare with `resume`, exact followup, zero spawn; independent/fresh operation
  → prepare and spawn a new Rescue child.
- [ ] Preserve exact precedence for explicit choices, legacy one-time
  `needs-choice`, proactive clear routes, and proactive ambiguity. Assert Root,
  not the child, owns every semantic choice.
- [ ] Reuse the exact constant `invoke-prepared rescue` assignment for initial
  and same-child prepared continuation turns. Keep one foreground companion exec
  per assignment/child turn and retain the existing next-turn `invoke-choice`
  assignments. Do not add task, binding, job, or session identifiers.
- [ ] Update named Role and generic forwarder contracts so stopped exact-child
  followup is authorized while arbitrary messages, sibling continuation,
  concurrent commands, retries, nested Rescue, and independent repository work
  remain forbidden.
- [ ] Add upgrade tests: previous Role bytes/receipt report `upgrade-required`,
  setup upgrades once, upgraded status is ready, and drift remains fail closed.
- [ ] Document durable binding, same-child exact continuation, legacy adoption,
  permission/session lifecycle, compatibility, and failure semantics in EN/ZH,
  SECURITY, CHANGELOG, and superseding ADR 0011. Keep task-boundary and project
  failure semantics unchanged.
- [ ] Run focused contract/release tests, lint, typecheck, diff check; commit:
  `docs: define exact Rescue child continuation`.

## Task 4: Qualification, Installed E2E, and Marketplace Snapshot

**Ownership:** qualification helpers/tests, installed E2E, marketplace builder/tests/generated snapshot.

**Files:**
- Modify: `tests/helpers/installed-rescue-lifecycle-contract.mjs`
- Modify: `tests/helpers/codex-rescue-qualification.mjs`
- Modify: `tests/codex-rescue-qualification.test.mjs`
- Modify: `tests/e2e/codex-skills-e2e.test.mjs`
- Modify: `scripts/build-marketplace-snapshot.mjs`
- Modify: `tests/marketplace-snapshot.test.mjs`
- Modify: `tests/integration/marketplace-install.test.mjs`
- Modify: `tests/plugin-contracts.test.mjs`
- Regenerate: `marketplace/plugins/zcode/**`

- [ ] Add a separate captured continuation qualifier for named and generic
  forwarders: operation 1 prepares/spawns/invokes; the same child stops; a new
  parent turn prepares resume; Root performs zero new spawns and one exact
  followup; the child performs one new `invoke-prepared`; fake ZCode resumes the
  original exact session and sends one new turn.
- [ ] Add foreground/background and proactive/explicit fixtures while preserving
  the distinct legacy `needs-choice → same child invoke-choice` qualifier.
- [ ] Add fail-closed mutations for sibling target, second spawn, task-name/path
  lookup, missing binding auto-latest, duplicate/corrupt/oversized binding,
  wrong parent session/workspace/executor/permission, stale generation, anchor/
  current job mismatch, cancelled/no-session anchor, and leaked private IDs.
- [ ] Extend optional live installed qualification with a cross-parent-turn clear
  continuation and exact fake/real peer session evidence where credentials permit;
  retain structured opt-in skips without credentials.
- [ ] Add `rescue-binding.mjs` and all changed critical runtime/hook/Skill/Role/
  docs to required payload, install existence, and byte-parity contracts.
- [ ] Commit all source/test/builder changes first. From that clean exact SHA, run
  the official marketplace builder once, verify provenance, and commit generated
  snapshot changes separately.
- [ ] Run marketplace/install/parity, qualification, lint/typecheck/line endings,
  full `npm test`, and `npm run test:qualified`; commit qualification and generated
  snapshot changes with truthful messages.

## Task 5: Independent Review, Full Verification, PR, and CI

- [ ] Dispatch independent specification and code-quality/security reviewers for
  each implementation task. Resolve every Critical or Important finding through
  a fresh TDD fix and re-review until approved.
- [ ] Dispatch whole-branch Standards and Spec reviewers against base `686faec`.
- [ ] From a clean worktree run fresh verification:

```bash
npm run check:line-endings
npm run lint
npm run typecheck
npm test
npm run test:qualified
git diff --check 686faec...HEAD
```

- [ ] Verify critical source/marketplace files byte-identical and provenance bound
  to the clean source commit used by the builder.
- [ ] Push `feat/rescue-child-session-binding`, open a PR to `main`, and report the
  exact behavior/compatibility/security/test evidence.
- [ ] Monitor every required GitHub Actions job until terminal. Diagnose failures
  systematically, fix in scope, rerun reviews and local verification, push, and
  continue monitoring. Completion requires all required CI jobs green.
