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
  keys, version/state enums, canonical workspace, safe identifiers, persisted
  approved `executorAgentType` provenance, timestamps,
  `operationId`, active/closed nullability, duplicate JSON keys, unknown keys,
  byte/count bounds, defensive copies, and fixed secret-free errors.
- [ ] Run `node --test tests/rescue-binding.test.mjs` and record the expected
  missing-module/API RED.
- [ ] Implement the deep pure helpers in `rescue-binding.mjs`; do not add job IO,
  public CLI parsing, task data, or ZCode session copies.
- [ ] Write failing StateStore tests for these wished-for deep methods:

```js
state.resolveRescueBinding({ workspace, parentSessionId, executorAgentId, permissionMode })
state.resolveRescueBindingForResume({ workspace, parentSessionId, executorAgentId, permissionMode })
state.readBoundRescueCurrentJob({ workspace, parentSessionId, executorAgentId })
state.reserveFreshRescueJob({ workspace, reservation, executor })
state.reserveBoundRescueContinuation({ workspace, reservation, executor, operationId })
state.adoptRescueCandidate({ workspace, reservation, executor, candidateJobId })
state.closeRescueBindingsForSession({ workspace, parentSessionId, reason: 'session-ended' })
```

- [ ] Keep record resolution separate from route-specific job validation.
  `resolveRescueBinding` returns missing only for true absence or a typed valid
  record; `resolveRescueBindingForResume` requires a non-cancelled anchor with an
  exact persisted session; `readBoundRescueCurrentJob` accepts a valid queued,
  failed, or cancelled current job for status. Corrupt/mismatched records fail
  closed in all paths.
- [ ] Require `reserveFreshRescueJob` to replace the generation and atomically
  publish `anchorJobId === currentJobId === job.id` under `.state.lock`.
- [ ] Require `reserveBoundRescueContinuation` to CAS `operationId`, validate the
  exact anchor session, reserve a new job that resumes it, retain `anchorJobId`,
  and atomically advance `currentJobId`.
- [ ] Require `adoptRescueCandidate` to revalidate the explicit legacy candidate,
  adopt it as anchor under current permission, reserve the continuation, and
  establish a new generation in the same transaction.
- [ ] Add concurrency/fault tests: two fresh writers, two continuation writers,
  stale generation, every publication failure seam, safe partial-state matrix,
  dangling record, corrupt
  sibling, symlink/path replacement, scan bound, session/agent/workspace/
  permission mismatch, and no unsafe partial published job/binding state.
- [ ] Preserve existing `reserveJob` behavior and persisted job schema; prove an
  old reader ignores `rescue-bindings/` and existing job fixtures remain valid.
- [ ] Implement private storage beneath `<workspace-store>/rescue-bindings/`
  using existing storage resolution, restrictive modes, bounded reads, atomic
  exact JSON writes, and the StateStore lock. Reuse platform-aware path/handle
  snapshot validation.
- [ ] Implement exact SessionEnd close tombstones with CAS-safe generation and
  bounded cleanup; do not close on job terminal or child stop. Store slots under
  a hashed parent-session partition and cap each session at 1,024 records (+1
  overflow detection), GC only valid closed tombstones older than 30 days under
  the state lock before new-slot creation, never age-GC active records, and fail
  closed on same-session corrupt siblings or remaining capacity exhaustion.
  Prove an abandoned/advisory-close-failed session cannot consume sibling
  session capacity.
- [ ] Run focused tests, lint, typecheck, and `git diff --check`; commit:
  `feat: persist exact Rescue operation bindings`.

## Task 2: Companion Routing, Status, and Lifecycle Integration

**Ownership:** companion/job-control/hooks runtime files and their integration tests. Do not edit Skill/Role/docs/marketplace.

**Files:**
- Modify: `scripts/zcode-companion.mjs`
- Modify: `scripts/lib/job-control.mjs`
- Modify: `hooks/lib/hook-state.mjs`
- Modify: `hooks/session-end-hook.mjs`
- Modify: `tests/integration/skills.test.mjs`
- Modify: `tests/integration/companion.test.mjs`
- Modify: `tests/job-control.test.mjs`
- Modify: `tests/hooks.test.mjs`
- Modify: `tests/identity.test.mjs` only for pending-choice compatibility

- [ ] Write failing tests proving `invoke-prepared` and `invoke-choice` propagate
  the trusted executor internally into `runCompanion`; no executor/binding/session
  identity may appear in argv, env, output, progress, or task. The private
  pending record admits only its exact-schema executor, route kind, candidate,
  expected-generation, and expected-current-job fields.
- [ ] Reproduce the real Codex 0.147 lifecycle: one SubagentStart creates the
  executor, SubagentStop marks it inactive, a later `followup_task` produces no
  second SubagentStart, and the executor retains its historical parent turn.
  Add RED tests for a restricted stopped `invoke-prepared` continuation using a
  fresh preparation and exact binding; forged refresh/active state and historical
  turn mutation must fail closed.
- [ ] Add a two-candidate regression: child A creates session A, child B later
  creates session B, then child A in a new parent turn prepares `resume`; assert
  the fake peer receives `session/resume` for A, never B, with no `needs-choice`.
- [ ] Add fresh, foreground, background, succeeded/failed terminal anchor,
  current-job status, cancelled anchor, wrong permission, wrong workspace,
  sibling executor, replay, and concurrent writable-job cases.
- [ ] Add legacy tests: an old job without a binding still returns
  `needs-choice` for explicit no-choice and persists the exact candidate job ID
  only in the private pending record; insert a later eligible job before
  `invoke-choice resume` and prove the originally presented candidate is the one
  validated/adopted. The next same-child continuation resumes exactly without
  asking. Old pending records lacking candidate identity must reject resume after
  upgrade (fresh remains safe). Explicit fresh establishes a new generation.
  Invalid binding never falls back.
- [ ] Add the bound explicit no-flag route: it also returns `needs-choice` and
  stores the exact bound `anchorJobId` as its private candidate. Inserting a
  later job cannot change it. Resume choice CAS-reserves an exact bound
  continuation; fresh choice creates a new generation. It never legacy-adopts
  or calls latest-candidate selection. A generation or `currentJobId` change
  while waiting rejects the stale choice for both resume and fresh rather than
  retargeting it; neither failure may reserve a job.
- [ ] Run focused tests and record RED before production changes.
- [ ] Pass trusted executor context from both `invoke-prepared` and
  `invoke-choice` into `runCompanion`/`startPublic` without changing public argv.
- [ ] Extend `invoke-prepared` authorization without depending on a second
  SubagentStart: initial execution requires an active same-turn executor; bound
  continuation requires the exact retained stopped executor provenance, fresh preparation
  for the current active parent turn, and matching binding. Do not overwrite the
  executor's old `parentTurnId`.
- [ ] Preserve stopped executor records as provenance instead of deleting them
  merely for age. Initial/unbound routes keep the 30-minute TTL. Only a bound
  continuation with matching fresh preparation, binding, parent session,
  workspace, permission, stopped state, and persisted approved agent type may
  use provenance older than 30 minutes. Test long-running and terminal
  greater-than-30-minute continuations plus expired unbound rejection.
- [ ] Version the private pending-choice schema to hold `candidateJobId` without
  exposing it in output. Add `routeKind` and, for bound choices,
  `expectedOperationId` plus `expectedCurrentJobId`. Preserve the existing narrow `invoke-choice` authority:
  unexpired stopped executor + same parent session/workspace/executor + single-use
  originating pending record/permission. Do not require historical parentTurnId
  to equal the new active turn. Bound choices may use durable stopped provenance
  only while their candidate, expected generation, and expected current job still
  match in the same StateStore lock transaction.
- [ ] Select routing as follows: bound+resume → exact continuation transaction;
  bound+fresh → fresh transaction; bound+omitted explicit → exact-anchor
  `needs-choice`; missing binding → existing legacy candidate behavior; invalid
  binding → fixed failure. Require Root to materialize the bound route; do not
  let the child infer it.
- [ ] Permit a current trusted `fresh` route to replace a structurally valid
  same-slot binding with an older permission mode. Resume with that mismatch and
  every structural/identity corruption remain fail closed.
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
- Create: `docs/adr/0013-bind-rescue-child-to-zcode-session.md`
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `SECURITY.md`
- Modify: `CHANGELOG.md`

- [ ] Write contract RED tests for Root states: active child → rejoin only;
  stopped proactive clear same-operation child → preflight, private prepare with
  `resume`, exact followup, zero spawn; stopped explicit bound candidate without
  a flag → prepare without a route, exact followup, `needs-choice`, then same-child
  `invoke-choice`; independent/fresh operation → prepare and spawn a new Rescue
  child.
- [ ] Preserve exact precedence for explicit choices, one-time `needs-choice`
  for every explicit bound-or-legacy candidate without a flag, proactive clear
  routes, and proactive ambiguity. Assert Root, not the child, owns every
  semantic choice.
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
  SECURITY, CHANGELOG, and ADR 0013 superseding the stopped-continuation portion
  of ADR 0010. Keep task-boundary and project
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
- [ ] Make the host lifecycle evidence explicit: exactly one original
  SubagentStart, one SubagentStop, and no second SubagentStart before followup;
  the stopped executor retains its old parent turn while the new preparation is
  bound to the fresh parent turn. Reject a fabricated second Start, active-state
  rewrite, or old-turn rewrite.
- [ ] Add foreground/background and proactive/explicit fixtures while preserving
  both bound and legacy explicit `needs-choice → same child invoke-choice`
  qualifiers. Only a clear proactive bound continuation skips the choice.
- [ ] Add fail-closed mutations for sibling target, second spawn, task-name/path
  lookup, missing binding auto-latest, duplicate/corrupt/oversized binding,
  wrong parent session/workspace/executor/permission, stale generation, anchor/
  current job mismatch, cancelled/no-session anchor, and leaked private IDs.
- [ ] Add resolver-specific fixtures: queued/pre-session-failed/cancelled current
  jobs remain reportable while a valid anchor resumes; cancelled/no-session
  anchor does not. Add candidate-insertion-between-choice-and-followup and old
  pending-without-candidate upgrade cases.
- [ ] Add stale bound-choice fixtures where an intervening same-operation
  continuation advances `currentJobId` without changing `operationId`; both old
  resume and fresh answers must fail before reservation.
- [ ] Add greater-than-30-minute fixtures: exact bound stopped provenance succeeds
  only with fresh preparation and matching generation; expired unbound/legacy
  executor, active executor, role mismatch, and missing provenance fail closed.
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
