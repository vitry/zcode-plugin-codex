# Rescue Exact-Binding Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply only the real deltas from commit `ca8d7d9` so a fresh Rescue always gets a new Codex child/ZCode session, while a uniquely exact persisted child resumes only its original binding and ZCode session.

**Architecture:** Narrow PR #44's merged routing and lifecycle behavior at its existing planner, binding-lock/CAS, execution, recovery, and cancellation seams. Keep canonical workspace validation, private state, owner isolation, worker leases, writable exclusion, result artifacts, and fail-closed parsing intact; delete or reject conflicting adoption/fresh-replacement paths instead of adding a selector or protocol.

**Tech Stack:** Node.js 22 ESM, `node:test`, private JSON state under file locks, Codex app-server child discovery, ZCode session RPCs, checked-in marketplace snapshot.

---

## Baseline and real delta

PR #44 is already merged into `origin/main` at `ae27302`; this branch must open a new PR. Commit `ca8d7d9`'s compact spec and ADR amendment are the only requirements source. The current branch differs from merged PR #44 only by the three source-document commits `3af0086`, `8b67e4b`, and `ca8d7d9`; implementation and tests are still PR #44 behavior.

The current code already supplies canonical workspace checks, exact binding keys, private anchor/current job IDs, lock/CAS reservation, worker leases, writable-job exclusion, `session/resume`, owned `status`/`result`, `reconcileOwnedJobs`, `readSession`, result artifacts, and bounded SessionEnd settlement. The remaining production delta is exactly:

- `planRescueActivation()` currently lets fresh prefer/follow existing proven or legacy children and can adopt host-only children; fresh must instead always allocate a collision-free spawn, and pending fresh must return to the parent planner.
- Resume currently admits host-only/adoption routes and accepts closed v3 records through the legacy seam, while fresh can replace a same-child binding; historical migration must be lazy and limited to one exact v1/v2 `closed/session-ended` record, with exact `notLoaded` identity and zero-side-effect ambiguity/failure. Ordinary complete active bindings remain normal resume inputs, not migration evidence.
- The consumer still has `reactivatedFresh`, `legacy-adopt`, `legacy-bound`, and ambient-child fallback branches; an exact continuation must carry the selected binding/session through reservation and execute foreground/background against its original non-empty `zcodeSessionId` only.
- SessionEnd currently preserves every binding even when it has just confirmed cancellation of an active operation; it must preserve completed/no-active-attempt and exact legacy candidates, but close only the confirmed exact active operation while leaving siblings byte-identical.
- Existing response-loss recovery is substantially correct and needs named foreground/background regressions; cancellation re-reads the job under its lock but lacks one explicit final bound operation/generation/current-job/lease proof immediately before `session/stop`.
- Public text still advertises host-only/jobs-only adoption, same-child fresh replacement, and broad SessionEnd preservation; source/marketplace parity and release gates must be regenerated after the narrow implementation.

## Scope guard

Do not reintroduce any rejected spec detour:

- no atomic/keyed resume API, receipt/query API, signing/Ed25519, or commit-ID stop;
- no dispatch-fence, stop-reservation/retry-budget, claim-evidence, cancellation-attempt, or StateStore schema redesign;
- no jobs-only or unbound-child adoption, eager migration/repair, base/latest/timestamp ranking, automatic resend, rollback, or fresh fallback after response loss;
- no filesystem, privacy, writable-exclusion, broker, worker-lease, garbage-collection, cryptography, or audit redesign;
- no task-evidence manifest, tags/auditors, synthetic commits, 30-task governance, or complex qualification/CI governance.

Reuse PR #44's safety mechanisms and make the smallest local change. If any reviewer proposes a new mechanism outside this list of six tasks, stop and ask the user to approve a separate spec before changing the plan or implementation.

### Task 1: Make fresh and pending-fresh route only through a new child

**Files:**
- Modify: `scripts/lib/rescue-route-planner.mjs`
- Modify: `scripts/zcode-companion.mjs`
- Modify: `scripts/lib/rescue-preparation.mjs`
- Modify: `skills/rescue/SKILL.md`
- Test: `tests/rescue-route-planner.test.mjs`
- Test: `tests/integration/skills.test.mjs`
- Test: `tests/integration/companion.test.mjs`
- Test: `tests/skills-contracts.test.mjs`

- [ ] **RED:** Replace the PR #44 tests that expect fresh to reactivate/prefer base/newest/adopted children. Add direct cases where stopped/resumable `task`, `task_2`, completed, bound, and `notLoaded` children are occupancy only and fresh emits `spawn zcode_rescue_task_3`; assert no follow-up, binding write/close, or RPC. Add a pending-choice case proving `fresh` consumes/invalidates that pending choice, performs nothing in the old child, and causes the active parent planner to produce the new spawn. Add resume cases where two usable bindings always fail `RESCUE_CHILD_AMBIGUOUS`, even if one child is ambient or retained. Expected: failures show the current follow-up/`preferredCandidate`, legacy-adoption, and same-child `invoke-choice fresh` behavior.
- [ ] **GREEN:** Make the planner branch on fresh before candidate selection: validate/list all children only for collision-free occupancy, emit v1 `spawn`, and never resolve/adopt/follow them. Narrow pending fresh so the old child only consumes the existing pending record and returns a parent-replan outcome; retain a fixed native target only for an already-selected pending resume. Remove the conflicting skill instruction that runs fresh inside the old child; do not add a new public route or selector.
- [ ] **Focused verify:** Run `node --test tests/rescue-route-planner.test.mjs tests/integration/skills.test.mjs tests/integration/companion.test.mjs tests/skills-contracts.test.mjs`. Expected: PASS, including one create on the new child and byte-identical old bindings.
- [ ] **Commit:** `git add scripts/lib/rescue-route-planner.mjs scripts/zcode-companion.mjs scripts/lib/rescue-preparation.mjs skills/rescue/SKILL.md tests/rescue-route-planner.test.mjs tests/integration/skills.test.mjs tests/integration/companion.test.mjs tests/skills-contracts.test.mjs && git commit -m "fix: route fresh rescue to a new child"`.
- [ ] **Independent reviews:** Give the task commit and `ca8d7d9` to one fresh spec reviewer to check fresh/pending/ambiguity only; after fixes, give the diff to a different quality reviewer to check dead branches, fail-closed behavior, and test clarity. Resolve both reviews before Task 2.

### Task 2: Limit lazy migration to one exact legacy binding and accept exact `notLoaded`

**Files:**
- Modify: `scripts/lib/rescue-route-planner.mjs`
- Modify: `scripts/zcode-companion.mjs`
- Modify: `scripts/lib/rescue-preparation.mjs`
- Modify: `scripts/lib/state.mjs`
- Modify: `scripts/lib/rescue-binding.mjs`
- Test: `tests/rescue-route-planner.test.mjs`
- Test: `tests/state.test.mjs`
- Test: `tests/rescue-binding.test.mjs`
- Test: `tests/integration/companion.test.mjs`

- [ ] **RED:** Build the incident fixture with an unbound/host-only base distractor and the sole exact `/root/zcode_rescue_task_2` v1/v2 `closed/session-ended` binding. Parameterize exact `notLoaded` success and idle/systemError, parent/path/Role/workspace, authority kind, key/operation/current/anchor/generation, job owner/status/session, permission, duplicate/corrupt/incomplete evidence failures. Assert `_2` resumes its original non-empty session by eligibility, never suffix; valid revoked/nonmatching complete siblings are ignored, two usable bindings are ambiguous, and every stale-CAS/fail-closed loser has zero mutation and zero RPC. Keep a separate complete active-v3 normal-resume control. Expected: failures expose closed-v3 migration, host-only adoption, incomplete-distractor handling, or active-only observation assumptions.
- [ ] **GREEN:** Resolve eligibility before routing. Keep read-only discovery, but under the existing workspace lock re-read and atomically reserve only one exact schema v1/v2 `closed/session-ended` binding whose child graph, historical path/digest, approved Role/type, authority kind, operation, anchor/current jobs, original `zcodeSessionId`, permission, generation, and CAS inputs all match. Treat exact `notLoaded` as normal only with that complete join; delete the old jobs-only/host-only adoption route plus its `legacy-adopt`/`legacy-bound` preparation generation, activation proof, and companion consumption paths. In the migration path reject v3, active, revoked target, corrupt, contradictory, duplicate, unclassifiable, or non-unique evidence without weakening ordinary exact active-binding resume.
- [ ] **Focused verify:** Run `node --test tests/rescue-route-planner.test.mjs tests/state.test.mjs tests/rescue-binding.test.mjs tests/integration/companion.test.mjs`. Expected: PASS with `_2` selected only in the sole-eligible fixture and all negative fixtures proving zero side effects.
- [ ] **Commit:** `git add scripts/lib/rescue-route-planner.mjs scripts/zcode-companion.mjs scripts/lib/rescue-preparation.mjs scripts/lib/state.mjs scripts/lib/rescue-binding.mjs tests/rescue-route-planner.test.mjs tests/state.test.mjs tests/rescue-binding.test.mjs tests/integration/companion.test.mjs && git commit -m "fix: migrate only exact legacy rescue bindings"`.
- [ ] **Independent reviews:** A fresh spec reviewer checks every migration bullet and A1/A5 against the commit, including distractor classification and CAS; a separate quality reviewer checks codec compatibility, lock boundaries, error sanitization, and mutation/RPC counters. Fix findings before Task 3.

### Task 3: Resume the same child only through its original ZCode session

**Files:**
- Modify: `scripts/zcode-companion.mjs`
- Modify: `scripts/lib/state.mjs`
- Modify: `scripts/lib/rescue-preparation.mjs`
- Test: `tests/integration/companion.test.mjs`
- Test: `tests/state.test.mjs`
- Test: `tests/job-control.test.mjs`

- [ ] **RED:** Add foreground and background end-to-end continuations for the same parent, exact child ID/path/Role/workspace, binding operation, and original `zcodeSessionId`. Assert one native follow-up, one continuation reservation, exact `session/resume`, and the normal send/result path; assert zero spawn, automatic fresh, fallback child, and `session/create`. Mutate route child, binding/session/anchor/current job, operation/generation, workspace, or permission after planning and expect fail closed before RPC. Expected: failures identify any break in exact binding/session propagation or final revalidation.
- [ ] **GREEN:** Only pass the planner-selected exact binding identity through preparation/consumption into `reserveBoundRescueContinuation`; derive `resumeSessionId` from its validated exact anchor job and revalidate immediately before foreground/background resume. Preserve the existing send, progress, artifact, and background capability paths; legacy adoption generation/consumption was removed in Task 2 and is not redesigned here.
- [ ] **Focused verify:** Run `node --test tests/integration/companion.test.mjs tests/state.test.mjs tests/job-control.test.mjs`. Expected: PASS with foreground/background using the original session and every mutation stopping before RPC.
- [ ] **Commit:** `git add scripts/zcode-companion.mjs scripts/lib/state.mjs scripts/lib/rescue-preparation.mjs tests/integration/companion.test.mjs tests/state.test.mjs tests/job-control.test.mjs && git commit -m "fix: resume the exact rescue child session"`.
- [ ] **Independent reviews:** A fresh spec reviewer checks A2 and the no-fallback/no-create invariants against the commit; a different quality reviewer checks private-state boundaries, foreground/background parity, race revalidation, and fixture signal quality. Resolve both before Task 4.

### Task 4: Preserve only resumable SessionEnd bindings and close one confirmed active operation

**Files:**
- Modify: `hooks/session-end-hook.mjs`
- Modify: `scripts/lib/recovery.mjs`
- Modify: `scripts/lib/state.mjs`
- Test: `tests/session-end.test.mjs`
- Test: `tests/hooks.test.mjs`
- Test: `tests/rescue-binding.test.mjs`
- Test: `tests/integration/companion.test.mjs`

- [ ] **RED:** Cover SessionEnd for (a) completed/no-active-current-attempt exact binding, (b) exact v1/v2 `closed/session-ended` candidate, (c) active writable attempt with acknowledged stop/cancellation, (d) unacknowledged stop, and (e) completion racing stop. Require (a)/(b)/(e) to remain resumable, (c) to close only its exact operation after durable cancellation, and (d) to retain the guard without claiming completion/resumability. Snapshot an unrelated sibling binding before each path and require byte equality afterward. Expected: the acknowledged active path leaves its binding broadly active, while existing broad-preservation tests conflict with the narrower lifecycle contract.
- [ ] **GREEN:** Return enough existing settlement evidence for SessionEnd to distinguish durable completion from confirmed cancellation, then perform one exact operation/current-job CAS close only for confirmed active cancellation. Keep completed/no-active bindings and exact legacy candidates untouched, reconcile stop races through the existing result artifact, and retain unacknowledged guards. Do not partition-wide close, alter owner release, or touch siblings.
- [ ] **Focused verify:** Run `node --test tests/session-end.test.mjs tests/hooks.test.mjs tests/rescue-binding.test.mjs tests/integration/companion.test.mjs`. Expected: PASS for preservation, exact close, race, guard, and sibling-byte-isolation cases.
- [ ] **Commit:** `git add hooks/session-end-hook.mjs scripts/lib/recovery.mjs scripts/lib/state.mjs tests/session-end.test.mjs tests/hooks.test.mjs tests/rescue-binding.test.mjs tests/integration/companion.test.mjs && git commit -m "fix: settle exact rescue binding on session end"`.
- [ ] **Independent reviews:** A fresh spec reviewer checks A4 and every SessionEnd state transition against durable job/binding evidence; a separate quality reviewer checks timeout behavior, stop races, CAS ordering, sibling isolation, and preservation of PR #44's orphan/lease guard. Fix all findings before Task 5.

### Task 5: Lock in existing response-loss recovery and fence stale cancellation

**Files:**
- Modify: `scripts/lib/job-control.mjs`
- Modify: `scripts/lib/recovery.mjs`
- Modify: `scripts/lib/state.mjs`
- Test: `tests/job-control.test.mjs`
- Test: `tests/recovery.test.mjs`
- Test: `tests/session-end.test.mjs`
- Test: `tests/integration/companion.test.mjs`

- [ ] **RED:** Add foreground/background response-loss regressions where send acceptance survives lost status and result responses; recover the same owned job through `status`, `result`, `reconcileOwnedJobs`, `readSession`, and `resultArtifact`, proving exactly one accepted send and zero resend/create/fresh/rollback. These regressions describe existing production behavior: if either fails, stop implementation and revise this plan before touching recovery behavior. Add gated races for every bound `session/stop` call in job-control and recovery/SessionEnd: after initial observation, advance current job/operation/generation or lease, release the stale caller, and assert zero RPC, no binding close, and an untouched winner.
- [ ] **GREEN:** Do not change status/result response-loss production behavior. Production edits are limited to the smallest shared StateStore read/guard immediately before each bound `stopSession` in job-control and recovery, proving exact owner/job cancellable status, binding current operation/generation/job, and worker lease or explicit absence; stale evidence fails before RPC. Do not redesign cancel attempts, StateStore, recovery, SessionEnd, or add a retry/state protocol.
- [ ] **Focused verify:** Run `node --test tests/job-control.test.mjs tests/recovery.test.mjs tests/session-end.test.mjs tests/integration/companion.test.mjs`. Expected: PASS with unchanged one-send response-loss recovery in both modes and zero stop from every stale explicit-cancel, recovery, and SessionEnd loser.
- [ ] **Commit:** `git add scripts/lib/job-control.mjs scripts/lib/recovery.mjs scripts/lib/state.mjs tests/job-control.test.mjs tests/recovery.test.mjs tests/session-end.test.mjs tests/integration/companion.test.mjs && git commit -m "fix: revalidate rescue cancellation before stop"`.
- [ ] **Independent reviews:** A fresh spec reviewer checks A6/A7 and confirms no automatic recovery action was added; a different quality reviewer checks the exact pre-RPC race window, lock ordering, lease semantics, and regression-test determinism. Resolve both before Task 6.

### Task 6: Update contracts, regenerate marketplace, and qualify the new PR

**Files:**
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `SECURITY.md`
- Modify: `CHANGELOG.md`
- Modify: `tests/release-contracts.test.mjs`
- Modify: `tests/public-text.test.mjs`
- Modify: `tests/plugin-contracts.test.mjs`
- Modify: `tests/codex-rescue-qualification.test.mjs`
- Modify: `tests/helpers/codex-rescue-qualification.mjs`
- Modify: `tests/e2e/codex-skills-e2e.test.mjs`
- Regenerate: `marketplace/.agents/plugins/provenance.json`
- Regenerate: `marketplace/plugins/zcode/README.md`
- Regenerate: `marketplace/plugins/zcode/README.zh-CN.md`
- Regenerate: `marketplace/plugins/zcode/SECURITY.md`
- Regenerate: `marketplace/plugins/zcode/CHANGELOG.md`
- Regenerate: `marketplace/plugins/zcode/docs/adr/0013-bind-rescue-child-to-zcode-session.md`
- Regenerate: `marketplace/plugins/zcode/hooks/session-end-hook.mjs`
- Regenerate: `marketplace/plugins/zcode/scripts/zcode-companion.mjs`
- Regenerate: `marketplace/plugins/zcode/scripts/lib/job-control.mjs`
- Regenerate: `marketplace/plugins/zcode/scripts/lib/recovery.mjs`
- Regenerate: `marketplace/plugins/zcode/scripts/lib/rescue-binding.mjs`
- Regenerate: `marketplace/plugins/zcode/scripts/lib/rescue-preparation.mjs`
- Regenerate: `marketplace/plugins/zcode/scripts/lib/rescue-route-planner.mjs`
- Regenerate: `marketplace/plugins/zcode/scripts/lib/state.mjs`
- Regenerate: `marketplace/plugins/zcode/skills/rescue/SKILL.md`

- [ ] **RED:** Update release/public-text and qualification assertions first. Replace host-only adoption and pending-fresh same-child fixtures in `tests/codex-rescue-qualification.test.mjs`, its helper, and the Codex E2E suite with A1 exact `_2` eligibility/ambiguity, A3 parent-replanned new-child fresh, and A8 source/marketplace/foreground/background parity. Reject jobs-only adoption, same-child fresh/replacement, broad SessionEnd preservation, latest/base fallback, and response-loss resend; require bilingual exact-binding, v1/v2 migration/`notLoaded`, exact-session resume, confirmed exact close, and status/result recovery wording. Expected: focused contracts fail on PR #44 snapshots and old rollout assertions.
- [ ] **GREEN:** Make the smallest matching English/Chinese README, SECURITY, and Unreleased changelog edits; update only the named qualification helper/snapshots/E2E expectations to A1/A3/A8. Do not hand-edit generated runtime mirrors or add qualification governance.
- [ ] **Commit boundary A — source/docs/qualification:** Run `node --test tests/release-contracts.test.mjs tests/public-text.test.mjs tests/codex-rescue-qualification.test.mjs`, then `git diff --check`. Confirm `git status --short` contains only the intended non-generated source docs and qualification tests, stage those exact files, inspect `git diff --cached --name-only`, and commit them with `git commit -m "docs: publish exact rescue binding contracts"`. Require `git status --porcelain=v1` to be empty before continuing; the marketplace builder must run with no tracked or untracked changes.
- [ ] **Commit boundary B — generated marketplace snapshot:** From that clean source commit, run the repository builder and mechanically synchronize its actual output layout; do not hand-edit generated files:

  ```bash
  SOURCE_SHA="$(git rev-parse HEAD)"
  SNAPSHOT_PARENT="$(mktemp -d)"
  trap 'rm -rf "$SNAPSHOT_PARENT"' EXIT
  node scripts/build-marketplace-snapshot.mjs \
    --output "$SNAPSHOT_PARENT/marketplace-snapshot" \
    --source-ref "$SOURCE_SHA" \
    --source-sha "$SOURCE_SHA"
  rsync -a --delete "$SNAPSHOT_PARENT/marketplace-snapshot/plugins/zcode/" marketplace/plugins/zcode/
  cmp -s "$SNAPSHOT_PARENT/marketplace-snapshot/.agents/plugins/marketplace.json" marketplace/.agents/plugins/marketplace.json || cp "$SNAPSHOT_PARENT/marketplace-snapshot/.agents/plugins/marketplace.json" marketplace/.agents/plugins/marketplace.json
  cmp -s "$SNAPSHOT_PARENT/marketplace-snapshot/.agents/plugins/provenance.json" marketplace/.agents/plugins/provenance.json || cp "$SNAPSHOT_PARENT/marketplace-snapshot/.agents/plugins/provenance.json" marketplace/.agents/plugins/provenance.json
  ```

  Verify parity, plugin contracts, the builder, and installation against that exact output:

  ```bash
  node --test tests/marketplace-snapshot.test.mjs tests/plugin-contracts.test.mjs tests/release-contracts.test.mjs
  node --test tests/integration/marketplace-snapshot-build.mjs
  MARKETPLACE_SNAPSHOT="$SNAPSHOT_PARENT/marketplace-snapshot" \
  MARKETPLACE_SOURCE_REF="$SOURCE_SHA" \
  MARKETPLACE_SOURCE_SHA="$SOURCE_SHA" \
  node --test tests/integration/marketplace-install.test.mjs
  git diff --check
  ```

  Confirm only `marketplace/plugins/zcode`, `marketplace/.agents/plugins/marketplace.json`, and `marketplace/.agents/plugins/provenance.json` changed; stage exactly those paths, inspect `git diff --cached --name-only`, and commit separately with `git commit -m "build: refresh ZCode marketplace snapshot"`.
- [ ] **Final qualification:** From the clean two-commit result, run `npm run check` and `node --test tests/integration/package-install.test.mjs`. Inspect `git status --short`, `git diff --stat origin/main...HEAD`, and `git diff origin/main...HEAD -- README.md README.zh-CN.md SECURITY.md CHANGELOG.md scripts hooks tests marketplace` for scope and private-state leakage. Expected: all local gates PASS, the worktree is clean, and provenance identifies boundary A's `SOURCE_SHA` rather than the generated-snapshot commit.
- [ ] **Independent reviews:** First give the complete `origin/main...HEAD` diff plus `ca8d7d9` to a fresh spec reviewer; resolve findings and rerun focused/full gates. Then give the clean final diff to a different quality reviewer; resolve findings and rerun `npm run check`, packed/native gates, and `git diff --check`. Push this branch and open a new PR (PR #44 is merged); require all six matrix CI jobs—Ubuntu/macOS/Windows on Node 22.13 and LTS—to be green before merge.
