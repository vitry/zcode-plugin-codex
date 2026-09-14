# Interrupt Cancellation Settlement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. If the user explicitly chooses delegation, use superpowers:subagent-driven-development. Steps use checkbox syntax for tracking.

**Goal:** Settle explicit cancellation without a final assistant report after a qualified exact stop response and executor cleanup, while retaining protection on failure or uncertainty.

**Architecture:** Centralize cancellation decisions in the existing Rescue Lifecycle Reconciler. Management, foreground, and SessionEnd adapters supply validated execution evidence; StateStore, leases, and CAS retain publication authority. Evidence for settlement without a report lives only in the current cancellation attempt, with no persisted replayable receipt and no change to business-success classification.

**Tech Stack:** Node.js ESM, node:test, existing file locks and worker leases, ZCode AppServer, ESLint, and TypeScript checkJs.

**Spec:** `docs/superpowers/specs/2026-09-14-interrupt-cancellation-settlement-design.md`. Use its explicit evidence requirements to resolve ambiguity in the prior discussion; do not weaken proof merely to terminalize a historical job.

## Handoff constraints

- Implement in this repository. The exact live-data repair in Task 7/spec section 10 is additionally required and authorized; no other dataRoot mutation is in scope. Do not install/publish the plugin or continue Neon Strike development. Do not send a new engine task as part of repair.
- Read applicable AGENTS.md and CONTEXT.md before implementation. Record existing changes using `git status --short`. Other agents or the user may be working concurrently; do not revert their changes.
- `findings.md`, `progress.md`, and `task_plan.md` may be existing untracked files; do not overwrite them. Implement in an isolated worktree. These two handoff documents may not yet be committed; ensure readable copies are available in that worktree.
- Use failing test, implementation, and passing test for each task. A new failure must exercise the intended behavior, not a setup/import error. Deliver implementation and review evidence; automatic merge, commit, or publication is not required.

## File responsibilities

| File | Responsibility |
|---|---|
| `scripts/lib/rescue-lifecycle.mjs` | Shared decision rules, natural-outcome precedence, cancellation evidence consumption |
| `scripts/zcode-companion.mjs` | Management adapter, existing-broker observation, bounded read/stop, guarded publication |
| `scripts/lib/job-control.mjs` | Cancel election, foreground/external cancellation distinction, executor cleanup |
| `scripts/lib/recovery.mjs` | SessionEnd/child-loss adapters, runner cleanup, recovery publication |
| `scripts/zcode-broker.mjs`, `scripts/lib/zcode-client.mjs`, `scripts/lib/zcode-protocol.mjs` | Verify and test upstream continuity across read/stop; disallow settlement without a report where continuity cannot be proven |
| `scripts/lib/state.mjs` | Change only if publication constraints require it; preserve owner/generation/lease validation |
| `scripts/lib/render.mjs` | Present cancellation without a final report; confirm the existing exports before editing |
| `tests/rescue-lifecycle.test.mjs` | Decisions and races |
| `tests/job-control.test.mjs` | Actual controller/management/foreground composition |
| `tests/session-end.test.mjs`, `tests/recovery.test.mjs` | Lifecycle adapters, budgets, guards, recovery |
| `tests/render-progress.test.mjs`, `tests/state.test.mjs` | Presentation and persistence invariants |
| `README.md`, `README.zh-CN.md`, `CONTEXT.md` | Consistent cancellation semantics |
| `scripts/build-marketplace-snapshot.mjs` | Existing distribution snapshot build; do not hand-edit generated mirrors |

## Task 1: Establish the baseline and regression assertions

- [ ] Read the full spec and `selectOwned`, `loadManagementRemoteEvidence`, `stopAndSettle`, `settleRemoteEvidence`, `publishManagementWinner`, `publishEndedWinner`, and the foreground cancel election.
- [ ] Run the baseline:

```sh
node --test tests/rescue-lifecycle.test.mjs tests/job-control.test.mjs tests/session-end.test.mjs tests/recovery.test.mjs
```

- [ ] Extend the existing fixtureAdapters in `tests/rescue-lifecycle.test.mjs` with a qualified stop acknowledgement, no final report, and exact successful cleanup. Preserve existing unreadable-without-proof cases. Model stop response, remote state, and worker cleanup separately; do not change all unreadable expectations to cancelled.
- [ ] Make the new assertions explicit:

```js
assert.equal(outcome.status, 'cancelled');
assert.equal(fixture.stopCalls, 1);
assert.equal(fixture.events.includes('reread-remote'), true);
// Use this fixture's actual publication events to assert cleanup precedes publication.
// Also assert no success report, session/send, or resume occurs.
```

- [ ] Add counterpart tests for stop failure, incomplete cleanup, and contrary active evidence; expect cancelling.
- [ ] Run `node --test tests/rescue-lifecycle.test.mjs` and save the intended new failures before changing implementation.

## Task 2: Shared cancellation evidence and decisions

- [ ] Extend the internal adapter contract in `rescue-lifecycle.mjs` so stop `acknowledged`, cleanup outcomes, and current-turn identity checks remain separate evidence. Do not rename acknowledgement to stopped.
- [ ] Preserve existing natural-terminal precedence. Implement this decision order without changing success classification in `turn-terminal.mjs`:

```text
existing terminal winner -> return winner
coherent natural terminal -> publish under existing cleanup rules
explicit current-turn interruption -> cleanup then cancel
qualified exact-runtime stop response -> one bounded reread
  coherent success -> preserve success
  still-active / mismatched runtime -> retain
  no final report + verified applicable local cleanup -> cancel
  otherwise -> retain
failed stop without independent interruption -> retain
```

- [ ] Validate the scope of evidence for the current attempt. Do not derive it from lastCancelError, old logs, or reconstructed idle. Define a JSDoc discriminated union if evidence crosses adapters instead of distributing untyped Boolean parameters.
- [ ] Require a valid pre-stop current-turn snapshot from this attempt, exact job/binding/worker identity, and an unchanged upstream protocol generation. Check whether the broker can lazily reconstruct upstream on the same local connection. If it can, reuse existing generation/token validation or provide internal continuity evidence, not object identity. Keep private generation information out of public output. First test rejection of upstream replacement with the same session ID and initial-read failure followed by stop acknowledgement. Entry points without proof remain cancelling.
- [ ] Run runner cleanup only once per pass and preserve its budget/CAS rules. `unmarked` must not implicitly mean that a foreground executor exited in the new path.
- [ ] Make Task 1 tests pass, then run `node --test tests/turn-terminal.test.mjs` to verify unchanged normal-result classification.

## Task 3: Wire management and explicit cancel

- [ ] In `tests/job-control.test.mjs`, use real `createManagementRescueReconcile`/controller composition and a temporary StateStore to exercise qualified acknowledgement, missing report, and successful cleanup. Assert persisted cancelled status, completion time, stopCause, and guard release.
- [ ] Assert control ordering: a failed initial read with valid stopIntent still attempts exact stop; an inactive stop does not settle. Assert no create/resume/send or new-broker fallback in the new evidence path.
- [ ] Add held-worker-lease, wrong-generation, and success-race cases to reject unauthorized publication. Run them to obtain RED before implementation.
- [ ] Update the management adapters in `scripts/zcode-companion.mjs` and cancellation election in `scripts/lib/job-control.mjs` to share Task 2's decision. Preserve lock ordering; do not reacquire an already-held cancellation lock. Existing nonqueued cancellation in `publishManagementWinner`/`publishEndedWinner` ultimately calls `recovery.cancelJob`, which calls `finishJob` directly and **does not implicitly acquire a worker lease**. The new path must establish explicit cleanup/lease publication protection. Reusing the helper does not make it lease-aware. Do not impose the new lease requirements on the existing authoritative-terminal path.
- [ ] Supply separate evidence for foreground self-finalization and external management. The internal path provides evidence only after it stops sending and releases its original transport turn; external callers still need exact lease/child termination evidence. Never terminate an unmarked process group.
- [ ] For the new external publisher, acquire the exact worker lease under the cancellation lock, revalidate identity and stopIntent, then CAS. For internal foreground publication, verify ownership of the original claim and use owner-held publication without reacquiring its own lease. Test both through real call chains; contention or invalid identity returns the winner or cancelling.
- [ ] Distinguish success already persisted by another publisher from unretrieved remote completion. Promise only that an existing durable winner is preserved and observed success has precedence. A late result must not overwrite cancelled after cancellation wins CAS.
- [ ] Run `node --test tests/job-control.test.mjs tests/rescue-lifecycle.test.mjs` until passing.

## Task 4: Keep SessionEnd, child loss, and recovery consistent

- [ ] In `tests/session-end.test.mjs` and `tests/recovery.test.mjs`, add qualified acknowledgement without a final report, cleanup timeout, failed stop with independent current-turn interruption, and repeated recovery. Use existing runner fixtures, not real ZCode.
- [ ] For marked runners, verify completed termination/sweep and lease acquisition before publication. For unmarked/foreground cases, verify a no-op cleanup is not exit evidence.
- [ ] Connect `scripts/lib/recovery.mjs` adapters to the shared decision while preserving stopIntent persistence ordering, SessionEnd receipts, epochs, budgets, and successor protection.
- [ ] Test a process crash after acknowledgement: the next attempt cannot reuse the previous in-memory acknowledgement. It may remain unresolved instead of inventing durable confirmation.
- [ ] Rerun the four baseline test files. Examine existing unreadable tests individually for qualifying evidence; never replace their expectations wholesale.

## Task 5: Cancellation results and the public contract

- [ ] Add rendering coverage in `tests/render-progress.test.mjs` for cancelled without a final report. Result must not require a success artifact; retain existing partial-log links and stopCause.
- [ ] Reuse the job schema and completion-time fields, clearing obsolete lastCancelError on cancellation. Add fields only if the current schema cannot represent required public information, with round-trip/schema tests. Do not persist an acknowledgement Boolean without identity.
- [ ] Use `Run cancelled; no final ZCode report was produced.` when no final report is available. Do not claim execution success, passing tests, or universal termination of background tools.
- [ ] Update README's stop-confirmation definition and explain in CONTEXT that cancellation settlement differs from a final model report. State the known limitation: historical inactive-runtime jobs without terminal evidence do not automatically become cancelled because of this change.
- [ ] Run `node --test tests/render-progress.test.mjs tests/state.test.mjs tests/job-control.test.mjs`.

## Task 6: Distribution, verification, and handoff

- [ ] Read the existing entry point and tests for `scripts/build-marketplace-snapshot.mjs`. Output must be outside the source directory; do not use `marketplace/plugins/zcode` directly as `--output`. Generate a snapshot in an external temporary directory using the actual `--source-sha`, then follow repository distribution conventions to verify required mirrors. Do not fabricate provenance, overwrite unrelated changes, or modify the installed cache. If handing off an uncommitted diff, complete source checks and explicitly defer snapshot generation until a commit SHA is available; never label new implementation with an old SHA.
- [ ] Run:

```sh
npm run check:line-endings
npm run lint
npm run typecheck
npm test
npm run test:qualified
git diff --check
```

- [ ] Record exit codes. List qualification tests skipped for credentials or environment separately; skipped tests are not real-engine passes. Do not use the original Neon Strike session to fill coverage gaps.
- [ ] Map each spec acceptance case to a test. Check scope: no cold resume, manual job mutation, relaxed success classifier, or global broker termination.
- [ ] Deliver the implementation summary, RED/GREEN evidence, complete check results, remaining limitations, and a reviewable diff. If the user assigns a separate reviewer, hand off without publishing.

## Task 7: Repair and verify the exact incident data

This task implements spec section 10. It is required for the overall handoff, after code checks; it does not authorize business development. Do not weaken automatic settlement to make this incident pass.

- [ ] Add a narrowly scoped maintenance entry point under `scripts/repair-cancellation-incident.mjs` only if normal authorized reconciliation cannot repair the record. Add `tests/incident-cancellation-repair.test.mjs` for the maintenance path. Integrate existing authorization and StateStore APIs; do not use the script as a raw file-write escape hatch. Keep this explicit maintenance operation separate from ordinary status/result.
- [ ] The maintenance interface must support a dry run and an explicit apply action for the exact project/job/session tuple in spec section 10, reject other selectors, and require the existing original-owner capability. Dry run reports a bounded public eligibility verdict and planned record set, not private descriptors. If existing tools cannot provide owner-authorized maintenance, deliver that missing integration before claiming the repair path is executable.
- [ ] Write tests first for wrong owner/partition/session, successor generation, held lease, live managed executor, incomplete cleanup, invalid backup, and concurrent terminal publication; each must refuse mutation or preserve the winner. Add positive administrative cancellation, repeat apply, and rollback-conflict cases. Assert no session/send, no engine-database writes, and no forged terminal messages.
- [ ] Implement a private backup/manifest using the exact affected StateStore and auxiliary records, then rehearse against isolated copies. Capture a coherent backup under the relevant locks/lease, or revalidate every pre-repair hash under those protections immediately before apply. Any changed auxiliary record invalidates the prepared backup/plan and requires recapture; do not rely solely on job generation CAS. Validate that only expected records change. Do not include credentials or raw task payloads in public evidence.
- [ ] Use the existing incident report to locate the exact live target, then reread current evidence. Prefer the regular cancellation path if it now qualifies. Otherwise use the audited administrative path only after the original worker lease is free, applicable descendants are cleaned, identity matches, and bounded inspection finds no known active associated execution. Unknown identity or cleanup is a blocker, not an excuse to force cancelled.
- [ ] Apply through the original owner's authorized runtime and guarded StateStore transaction. Preserve the session, existing stop cause, logs, and partial artifacts; use repair-time completion and an explicit administrative-repair diagnostic. Reconcile dependent binding/claim/attempt records via existing transitions. Never patch the job JSON in isolation or delete history.
- [ ] Record official owning-context status/result after apply. Assert cancelled, no fabricated final report, consistent writable guard and binding, and unchanged session association. Repeat the read and dry run to demonstrate idempotency. Check resumability only through existing non-executing eligibility surfaces; do not launch work to test it.
- [ ] Validate rollback on the rehearsal data: original backup hashes, unchanged post-repair state, no successor, and locks held. A concurrent change must prevent rollback. Supply the procedure and private backup location with the before/after report.
- [ ] Run `node --test tests/incident-cancellation-repair.test.mjs` if a maintenance entry point was added, then rerun relevant state/recovery/controller tests and the Task 6 checks for new implementation changes. Report code, rehearsal, and live repair separately. Missing owner authority requires a precise original-session handoff and an explicit incomplete live-repair status, not a false success.

## Implementation pitfalls

1. Shared brokers are independent of workers. Worker disappearance alone cannot prove remote termination.
2. `session/stop {}` is a handling acknowledgement. Qualification requires the exact original-runtime evidence and complete cancellation cleanup; reconstructed runtimes cannot bypass the boundary.
3. Failure to read a current-turn result does not authorize cancellation after arbitrary failures. Contrary evidence such as continued activity or a different generation must prevent settlement.
4. Removing the final-report requirement must not remove natural-success race handling or release a writer guard before required cleanup.
5. Automatic cancellation must not fabricate missing incident evidence. The exact live incident repair is a separate required deliverable under Task 7, with its own authority, backup, audit, and verification.
