# Rescue Child Loss Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans task-by-task. Do not delegate unless the current session authorizes it.

**Goal:** Continue the same operation after safely reconciling a terminated Rescue child's stale active records.

**Architecture:** Add bounded recovery before prepare planning; reuse business lifecycle settlement and conditional Hook writes. Separate Host evidence, job settlement, and child updates. Keep the planner read-only.

**Tech Stack:** Node.js ESM, node:test, existing file locks/StateStore, Codex app-server.

**Specification:** `docs/superpowers/specs/2026-09-12-rescue-child-loss-reconciliation-design.md`. Its evidence, lock order, and failure rules are mandatory. New interfaces below are planned additions, not existing APIs.

## Task 1 — Host evidence adapter and authentic fixture

Files: `scripts/lib/codex-app-server.mjs`, `tests/codex-app-server.test.mjs`, `tests/fixtures/fake-codex-app-server.mjs`, new `tests/fixtures/codex-rescue/child-terminal-evidence.json`.

- [ ] Inspect instructions/worktree, isolate implementation, and preserve untracked user files. Read the spec and lifecycle ADRs.
- [ ] Establish Hook childTurnId-to-Host-turn correlation from actual local schema/read-only records. Save authentic structure with synthetic identities and source version, excluding prompts/full errors. Unsupported correlation yields unavailable evidence; timestamp proximity is insufficient.
- [ ] Write failing tests for `readCodexRescueChildTurnEvidence(childId, parentId, expectedTurnId, options)`:

```js
assert.equal(proof.observedTurnId, expectedTurnId);
assert.equal(proof.terminalStatus, 'failed');
assert.deepEqual(Object.keys(proof).sort(), ['child', 'observedTurnId', 'terminalStatus']);
// Independently mutate parent, latest turn, active state, and unknown status.
await assert.rejects(readEvidence(changedFixture), { code: 'RESCUE_CHILD_EVIDENCE_UNAVAILABLE' });
```

- [ ] Run `node --test tests/codex-app-server.test.mjs`; confirm new tests fail. Implement includeTurns reading, existing sanitizer, output limits, timeout/signal, and minimal output without extending public SpawnChild.
- [ ] Rerun to pass; cover completed/failed/interrupted, empty turns, duplicate IDs, newer turns, truncation, response errors, and timeout. Commit adapter/tests.

## Task 2 — Conditional stop-state primitive

Files: `hooks/lib/hook-state.mjs`, `tests/hooks.test.mjs`, `tests/integration/two-session-hooks.test.mjs`.

- [ ] Create active route/forward/executor fixtures and a failing test detecting an old tuple deactivating a successor.
- [ ] Extract `settleExactForwardingStop(expected, validate)` from markForwarding's SubagentStop branch. expected is validated internal identity; validate is an internal callback, never model-supplied.
- [ ] Implement staged compare-and-set:

```text
validate outside locks; no network calls within file locks
origin lock: compare old route; write exact stopped route/forward
target lock: compare old executor; write inactive executor
re-read exact records; succeed only after stopped lookup passes
```

- [ ] Preserve lock order/bounds. Multiple file writes are not atomic. Generation conflict yields superseded; same-tuple partial writes are retryable. Normal Hooks share writes without inheriting recovery's terminal-job prerequisite.
- [ ] Inject each-stage failure, new SubagentStart, duplicate stop, cross-workspace routes, and old epochs. Assert successor bytes unchanged. Run `node --test tests/hooks.test.mjs tests/integration/two-session-hooks.test.mjs`; commit.

## Task 3 — Bounded recovery coordinator

Files: new `scripts/lib/rescue-child-reconciliation.mjs`, new `tests/rescue-child-reconciliation.test.mjs`, `scripts/lib/recovery.mjs`, `tests/recovery.test.mjs`.

- [ ] Introduce `reconcileRescueChildForPreparation({ dataRoot, caller, envelope, appServerOptions, signal, dependencies })`. Encapsulate production dependencies; inject real stores and Host/remote seams in tests.
- [ ] Reproduce the terminal-job incident with a failing test: active executor, exact failed Host turn, succeeded job, no receipt. Assert reconciled, three stopped records, unchanged job/result/binding, zero remote stops.
- [ ] Reuse/extract exact selection and identity validation. Skip fresh; reject ambiguity/mismatch. Never duplicate latest-job selection.
- [ ] Implement:

```text
select exact candidate -> capture tuple -> read Host proof
-> existing business reconciliation
-> require terminal outcome and discharged execution obligations
-> second Host proof -> validate unchanged binding/caller
-> conditional stop-state update -> stopped lookup
```

- [ ] Feed nonterminal foreground work through recovery adapters into existing Lifecycle Reconciler observe/host-coordination-loss. Reuse intent, generation checks, stop/reread, winner/guard behavior; no second stop state machine.
- [ ] Nonterminal background without receipt/intent remains pending, without stop. Otherwise preserve precedence. Do not skip terminal-job cleanup obligations.
- [ ] Share five seconds, at most two Host reads and one business reconciliation. Use specified errors; never swallow failure and prepare anyway.
- [ ] Run `node --test tests/rescue-child-reconciliation.test.mjs tests/recovery.test.mjs tests/rescue-lifecycle.test.mjs`. Cover unknown Host, remote pending, natural-success races, changed permission/currentJob, intervening SessionEnd, concurrent recovery. Commit.

## Task 4 — Prepare integration and execution gates

Files: `scripts/zcode-companion.mjs`, `scripts/lib/rescue-preparation.mjs` only if revalidation is missing, `tests/rescue-preparation.test.mjs`, `tests/rescue-route-planner.test.mjs`, `tests/integration/companion.test.mjs`.

- [ ] Write a failing real-entry prepare integration test with incident-shaped data, not a success-only planner stub. Expect original child, no engine send/spawn.
- [ ] Call recovery after envelope reading and before planRescueActivation. No candidate preserves original flow; failure saves no preparation.
- [ ] Keep full planner validation then save. Verify save/consume reject intervening parent turn, permission, binding, currentJob, and child-generation changes. Add only missing checks; preserve migration rules.
- [ ] Race two prepares: at most one consumable preparation. Interleave SubagentStart/followup and protect successor state. Explicit fresh skips recovery; role-status performs no recovery writes.
- [ ] Run `node --test tests/rescue-preparation.test.mjs tests/rescue-route-planner.test.mjs tests/integration/companion.test.mjs`. Existing idle/systemError rejection without executor proof must pass. Commit.

## Task 5 — Regression, packaging, delivery

Files: `CHANGELOG.md`, generated `marketplace/plugins/zcode/`, spec/plan for actual validation results.

- [ ] Run focused tests and map assertions to all eight acceptance criteria.
- [ ] Generate marketplace snapshot using the actual CLI of `scripts/build-marketplace-snapshot.mjs`; inspect expected-only changes. Do not modify installed caches or incident executor records manually.
- [ ] Run `npm run check`; distinguish pass/fail/skipped opt-in qualification. If authentic Host correlation is unqualified, report a release blocker. Safe rejection tests are not incident recovery.
- [ ] Review diff, redaction, SessionEnd/background regressions; update changelog, complete review, commit.
- [ ] Report actual implementation/validation status. This is a design handoff, not completed implementation. No separate PR/merge instruction was given for this issue; follow subsequent authorization for publication.

## Completion criteria

Authentic Host structure reproduces failure before and successful same-operation/child preparation after the fix. Successors remain intact, unresolved remote work retains its guard, SessionEnd is unchanged, required checks pass, and source matches marketplace. Disclose unsupported Host evidence rather than weakening authorization.
