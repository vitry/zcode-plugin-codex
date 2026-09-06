# True Background Rescue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. The user has delegated implementation to another agent, waived plan review, and requires a new development worktree.

**Goal:** Preserve parameter-controlled foreground Rescue and replace its attached background branch with session-bound detached execution.

**Architecture:** Keep the existing job/binding/receipt system authoritative. Reserve private execution input and a persistent runner-format discriminator, spawn one runner, and reuse exact claim/execution/reconciliation. Repair the demonstrated recovery CAS defect before exposing the new handoff window.

**Tech Stack:** Node.js >=22.13, ESM, node:test, filesystem advisory locks, existing ZCode broker/protocol and Codex hooks, three-platform GitHub Actions matrix.

---

## Authority, baseline, and execution rules

Read `docs/superpowers/specs/2026-09-07-true-background-rescue-design.md`, including its self-review corrections, before coding. It is the normative contract. Runtime baseline is `ddd409e3fc280ccb73ec255d955d52d47f66d725`; the design branch's later documentation-only commit carries this plan and the revised spec. The old handoff contains corrected architectural claims; do not use it as implementation authority.

The user approved the product scope and does not want a plan review gate. Proceed through routine implementation decisions. Only a genuine change to approved product behavior needs escalation. No runtime changes have been made by the planning session. Implementation, tests, and local commits belong to the next agent; publishing, merging, and changing the live installed plugin are outside this handoff.

Do not spawn another Rescue to implement its own runtime accidentally. This is ordinary development by the receiving agent; references to Rescue are the feature under development.

## Task 0: Create the required development worktree

**Files:** Carry the committed spec, discussion evidence, CONTEXT, and this plan from the design branch; preserve all unrelated worktrees.

- [ ] Read applicable `AGENTS.md` and the worktree skill. Inspect the repository and source design worktree:

```sh
git worktree list
git -C .worktrees/host-managed-rescue-lifecycle status --short
git -C .worktrees/host-managed-rescue-lifecycle log -1 --oneline
git check-ignore .worktrees
```

- [ ] Verify the source documentation commit named in the temporary handoff. Create a new branch/worktree from that commit, not from `main`. From the repository root, when both names are unused:

```sh
git worktree add -b feat/true-background-rescue .worktrees/true-background-rescue design/host-managed-rescue-lifecycle
cd .worktrees/true-background-rescue
git status --short
npm ci
```

Expected: a new checkout containing the corrected spec and plan, with no inherited dirty files. If either target exists, choose a new unused suffix; never reuse or remove another developer's worktree. Confirm HEAD equals the handoff documentation commit before runtime edits.

- [ ] Baseline targeted suites:

```sh
node --test --test-concurrency=1 tests/rescue-binding.test.mjs tests/recovery.test.mjs tests/rescue-lifecycle.test.mjs tests/session-end.test.mjs
```

Expected: baseline suite passes. The newly identified CAS race is absent from this suite and must be introduced next. Record pre-existing failures separately.

## File ownership and module boundaries

| Files | Responsibility |
| --- | --- |
| `scripts/lib/state.mjs` | Job schema, reservation publication, claim/lease CAS, atomic binding rollback, stop-intent transitions |
| New `scripts/lib/rescue-execution-input.mjs` | Closed input codec and bounded queued acknowledgement projection; no filesystem/lifecycle decisions |
| New `scripts/lib/rescue-runner.mjs` | OS spawn adapter only; same-entry internal subcommand, ignored stdio, spawn event, unref |
| `scripts/zcode-companion.mjs` | Compose reservation, runner entry, shared execution, authoritative continuation derivation; keep foreground path |
| `scripts/lib/rescue-lifecycle.mjs` | Joined stop policy, runner cleanup ordering, retained uncertainty |
| `scripts/lib/recovery.mjs`, `scripts/lib/job-control.mjs` | Existing state/lease/control adapters, pre-start recovery, cancel and receipt settlement |
| `hooks/lib/hook-state.mjs`, `hooks/session-end-hook.mjs`, `hooks/subagent-hook.mjs` | Epoch/receipt integration, bounded cleanup, child-exit and notification behavior |
| `scripts/lib/render.mjs`, `skills/rescue/SKILL.md`, `agents/zcode-rescue.toml.template` | Queued versus completion messaging and foreground/background instructions |
| `tests/*`, `tests/integration/*`, `.github/workflows/ci.yml` | Behavior/race/installed-artifact/platform qualification |
| `docs/adr/0021-run-rescue-background-in-a-session-bound-runner.md`, prior ADRs, `README.zh-CN.md`, `CHANGELOG.md`, `CONTEXT.md` | Explicit governance and public behavior |

Do not create a new scheduler, ledger, heartbeat, launcher capability, or public lifecycle API. The two new helpers isolate input encoding and OS spawning; all lifecycle decisions remain in existing modules. Tests may add narrow test-only dependency barriers; production code must not honor test environment variables as authorization.

## Task 1: Repair and prove queued recovery lease exclusion

**Modify:** `scripts/lib/state.mjs` (`transitionStoredJob`). **Test:** `tests/rescue-binding.test.mjs`, `tests/recovery.test.mjs`.

- [ ] Add this regression to `tests/rescue-binding.test.mjs`, using its existing fixture helpers:

```js
test('queued recovery rejects a stale unclaimed observation after worker claim', async () => {
  const { workspace, store } = await fixture();
  const first = await store.reserveFreshRescueJob({
    workspace, reservation: reservation(workspace), executor: executor(workspace),
  });
  const worker = { childPid: process.pid, workerLeaseId: 'b'.repeat(64) };
  await store.claimJobWorkerForExecution(workspace, first.job.id, worker);
  await assert.rejects(store.finishQueuedJobAfterRecoveryLease(
    workspace, first.job.id, null, undefined, 'failed',
    { error: { message: 'stale recovery observation' }, exitCode: 1 },
  ), { code: 'WORKER_LEASE_CONFLICT' });
  const current = await store.readJob(workspace, first.job.id);
  assert.equal(current.status, 'queued');
  assert.equal(current.workerLeaseId, worker.workerLeaseId);
});
```

- [ ] Run `node --test --test-name-pattern='stale unclaimed observation' tests/rescue-binding.test.mjs`. Expected before correction: failure because the promise resolves to failed.
- [ ] Correct the guard without making the internal recovery expectation a mutable job field:

```diff
-    if (Object.hasOwn(effectivePatch, 'recoveryWorkerLeaseId')) {
+    if (Object.hasOwn(options, 'recoveryWorkerLeaseId')) {
```

Keep the comparison against `job.workerLeaseId ?? job.rescueExecutionReservation?.workerLeaseId ?? null` and throw `WORKER_LEASE_CONFLICT` on mismatch. Preserve historical reservation lease handling.
- [ ] Add the same assertion with expected lease `'c'.repeat(64)` against the actual `'b'.repeat(64)` claim, plus terminal-first late claim and held-lease recovery-defer cases. Both orderings must retain the winner and reject stale work.
- [ ] Run `node --test tests/rescue-binding.test.mjs tests/recovery.test.mjs`; expected pass. Commit only the correction and its regression tests: `fix: enforce queued recovery worker lease CAS`.

## Task 2: Closed runner input and persistent format identity

**Create:** `scripts/lib/rescue-execution-input.mjs`, `tests/rescue-execution-input.test.mjs`. **Modify:** `scripts/lib/state.mjs`. **Test:** `tests/state.test.mjs`, `tests/rescue-binding.test.mjs`.

- [ ] Define and test these exports; they are private runtime helpers:

```js
// validateRescueExecutionInput(value) returns a fresh validated copy or throws.
// No coercion, unknown keys, arrays, custom prototypes, or caller references.
export const RESCUE_RUNNER_VERSION = 1;
export const RESCUE_EXECUTION_INPUT_MAX_BYTES = 512 * 1024;
export const RESCUE_EXECUTION_MODEL_MAX_BYTES = 4 * 1024;
// Fields: version === 1, nonblank task <= RESCUE_TASK_MAX_BYTES,
// optional nonempty model <= RESCUE_EXECUTION_MODEL_MAX_BYTES,
// optional effort in the existing EFFORT_LEVELS closed enum.
// JSON byte length <= RESCUE_EXECUTION_INPUT_MAX_BYTES.
```

Use existing error conventions with bounded field names, never the invalid task value. Keep imports acyclic: if sharing constants with StateStore would create a cycle, validate the codec's effort through a passed existing enum or move only that existing constant to a shared leaf.
- [ ] Contract assertions for the codec test (import `validateRescueExecutionInput` and `RESCUE_TASK_MAX_BYTES`):

```js
assert.deepEqual(validateRescueExecutionInput({ version: 1, task: 'repair' }),
  { version: 1, task: 'repair' });
for (const value of [null, [], { version: 2, task: 'repair' },
  { version: 1, task: ' ' }, { version: 1, task: 'repair', scope: 'auto' },
  { version: 1, task: 'x'.repeat(RESCUE_TASK_MAX_BYTES + 1) },
  { version: 1, task: 'repair', model: 'x'.repeat(4097) }]) {
  assert.throws(() => validateRescueExecutionInput(value));
}
```

- [ ] Run `node --test tests/rescue-execution-input.test.mjs`; first fails on missing codec, then passes after implementing the closed checks.
- [ ] Extend fresh/continuation reservation with optional `executionInput`. Only valid Host-owned background reservations accept it; they set `rescueRunnerVersion: 1` and store the validated input inside the initial job JSON. Do not persist it after reserving in a second write. Keep foreground calls without this parameter byte-compatible where practical.
- [ ] Extend StateStore record validation and cleanup: marker retained for queued/running/terminal, input required for new runnable queued jobs, removed on every queued-to-running/terminal path including specialized rollback. Marker without input must fail execution, not be reclassified as historical. Corrupt record handling stays fail-closed.
- [ ] Add reservation-publication fault tests using existing checkpoints: no runner is exposed before complete reservation; partial job/binding writes recover under existing guards; input and marker never disappear from a still-runnable queued job.
- [ ] Run `node --test tests/rescue-execution-input.test.mjs tests/state.test.mjs tests/rescue-binding.test.mjs`; commit `feat: persist bounded rescue runner input in job records`.

## Task 3: Pre-start settlement and durable queued cancellation

**Modify:** `scripts/lib/state.mjs`, `scripts/lib/recovery.mjs`, `scripts/lib/job-control.mjs`. **Test:** `tests/rescue-binding.test.mjs`, `tests/recovery.test.mjs`, `tests/job-control.test.mjs`.

- [ ] Extend existing active-continuation failure fixtures to invoke generic recovery with a claimed queued B/free lease. Assert B failed, binding current restored to A, strict migration-proof lookup succeeds, and late B claim rejects. Before wiring, the strict lookup reproduces `RESCUE_BINDING_INVALID`.
- [ ] Make queued recovery select the existing guarded active-continuation rollback transaction when eligible. Preserve migration rollback as a distinct existing policy. Load the durable proof under lock, verify the exact expected lease, restore binding before terminal publication, and retain the proof across recoverable publication faults.
- [ ] Exclude only marker-identified new runner jobs from age-only queued failure. Unclaimed new jobs remain queued at arbitrarily old ages; held claims defer; free claimed leases permit pre-start failure. A job with stop authority follows cancellation instead of failure rollback.
- [ ] Persist a valid `stopIntent` on claimed queued cancellation before remote/local work. Reuse `stopIntent` rather than add another state field. Extend queued transition/claim/rollback guards and bounded diagnostics where needed. Enforce this transition contract:

```text
queued + claim + stop(user/session-end)
  -> queued + same claim + durable stopIntent
  -> same lease acquired after runner exit
  -> cancelled + stopCause, input removed

queued + claim + proven setup failure + no winning stop
  -> exact binding restoration (continuation only)
  -> failed, input removed
```

- [ ] Add tests for cancel persistence followed by controller death, claim/running attempt after queued stop intent, cancellation racing infrastructure rollback, and receipt-wins cause correction. No queued stop may be lost or authorize another send.
- [ ] Keep fresh pre-session failures non-resumable and test the public route's fresh-new-child recovery. Test explicit pre-session cancel closes the current operation, rather than silently restoring A as if cancellation were infrastructure failure.
- [ ] Run `node --test tests/rescue-binding.test.mjs tests/recovery.test.mjs tests/job-control.test.mjs`; commit `fix: converge rescue pre-start failures and queued stops`.

## Task 4: OS spawn adapter with no readiness protocol

**Create:** `scripts/lib/rescue-runner.mjs`, `tests/rescue-runner.test.mjs`. **Preserve:** `scripts/lib/background-worker.mjs` and historical ACK tests.

- [ ] Implement `spawnRescueRunner({ companionPath, workspace, jobId, env, spawnChild })`, with injected `spawnChild` defaulting to Node spawn. Validate absolute entry/workspace and digest job ID using existing path/identifier utilities. Launch contract:

```js
const child = spawnChild(process.execPath,
  [companionPath, 'run-host-rescue-job', jobId], {
    cwd: workspace, env, detached: true, windowsHide: true,
    shell: false, stdio: 'ignore',
  });
await new Promise((resolve, reject) => {
  child.once('error', reject);
  child.once('spawn', resolve);
});
child.unref();
```

Translate synchronous spawn and OS creation errors to bounded existing-style runtime errors. Keep an error listener after spawn so a later error cannot become an unhandled parent exception. Never use fd3/fd4, readiness timers, capability transport, or the legacy worker environment selector.
- [ ] Use an EventEmitter fake child to assert exact spawn arguments and one `unref`. Gate the fake's `spawn` event: before it the promise is pending; after it the promise resolves without any ready/claim event. Test synchronous throw, error before spawn, and later exit without parent-side terminalization.
- [ ] Run `node --test tests/rescue-runner.test.mjs tests/background-worker.test.mjs`; commit `feat: add detached rescue runner spawn adapter`.

## Task 5: Internal runner entry and shared dispatch fencing

**Modify:** `scripts/zcode-companion.mjs`, `scripts/lib/state.mjs`, `scripts/lib/recovery.mjs`, `hooks/lib/hook-state.mjs`. **Test:** `tests/integration/companion.test.mjs`, `tests/rescue-binding.test.mjs`, `tests/hooks.test.mjs`.

- [ ] Add the private `run-host-rescue-job <digest>` entry before the normal fd3 authorization reader. Resolve the installed data root and canonical workspace normally; accept no public task, owner, permission, epoch, or resume override. Require exact valid marker/input and Host-owned background state.
- [ ] Share the existing worker-lease/claim and `executeReserved` path, excluding historical capability setup. Derive `spec.task/model/effort` from the validated input and `candidateJobId/resumeSessionId` from the exact stored continuation anchor/proof. Never build them from a latest lookup.
- [ ] Add a bounded admission adapter callable under the state lock and before send. Reuse current epoch/receipt resolution based on the reserved owner and persisted origin workspace. Reject any matching receipt (including settled), superseded epoch, stop intent, stale exact binding/permission/claim, or unreadable authority. Do not require a live Rescue Child or a fresh parent-turn capability after enqueue.
- [ ] Preserve lock order: runner lifetime lease; admission via cancellation lock then state lock; controller lease probes nonblocking. Receipt publication remains independent, so receipt racing an already-entered send uses existing stop/missing-boundary recovery.
- [ ] Add tests that invoke the actual private entry with isolated data: foreground job rejected; legacy job rejected; malformed input rejected; duplicate claim does not send; normal child stop before delayed claim still executes; matching receipt before claim/send prevents send; exact continuation resumes original session once. Use existing fake ZCode, never a provider.
- [ ] Test setup errors before entering `executeReserved`: settle only the same unclaimed/owned claim, preserve another claimant, and run Task 3's rollback policy. After possible send admission, retain the existing guard rather than pre-start rollback.
- [ ] Run `node --test --test-concurrency=1 tests/rescue-binding.test.mjs tests/hooks.test.mjs tests/integration/companion.test.mjs`; commit `feat: execute host-owned rescue jobs through exact runner admission`.

## Task 6: Wire parameter-controlled enqueue and acknowledgement delivery

**Modify:** `scripts/zcode-companion.mjs`, `scripts/lib/rescue-execution-input.mjs`, `scripts/lib/render.mjs`. **Test:** `tests/args.test.mjs`, `tests/integration/companion.test.mjs`, `tests/render-progress.test.mjs`, `tests/rescue-launcher.test.mjs`.

- [ ] Build validated execution input before new background reservation. Replace only the `parsed.options.execution === 'background' && validHostLifecycleRecord(job)` attached branch with Task 4 spawning; new records must carry Task 2 input/marker. Attached foreground still calls existing execution and returns full terminal result.
- [ ] Implement a bounded acknowledgement projection with only this shape:

```js
return {
  type: 'background',
  job: { id: job.id, command: 'rescue', status: 'queued', createdAt: job.createdAt },
  resultCommand: '$zcode:result', statusCommand: '$zcode:status',
};
```

It represents accepted reservation, not latest state. Do not register the new response in the historical `backgroundBindings` capability/delivery rollback machinery. Post-spawn stdout failure leaves the job intact; pre-spawn deterministic failure uses Task 3 settlement.
- [ ] Use barriers for both timing cases: runner blocked before claim while enqueue resolves; fast runner already terminal before enqueue output. Assert neither case corrupts the job or claims a completion notification.
- [ ] Test parameter matrix: `--wait` waits for full result, `--background` returns queued, both flags reject, no-flag inference/default unchanged, and both fresh/resume work in each placement. Root must not keep a background child waiting solely for completion.
- [ ] Test sentinel private data through text/JSON/error/Status/list/Result metadata projections. Preserve full authorized Result content; redaction applies to private metadata, not to erasing the user's requested output.
- [ ] Run `node --test --test-concurrency=1 tests/args.test.mjs tests/render-progress.test.mjs tests/rescue-launcher.test.mjs tests/integration/companion.test.mjs`; commit `feat: return queued for true background rescue`.

## Task 7: Reconciler-owned local runner termination

**Modify:** `scripts/lib/rescue-lifecycle.mjs`, `scripts/lib/recovery.mjs`, `scripts/lib/job-control.mjs`, `hooks/session-end-hook.mjs`, `hooks/lib/hook-state.mjs`. **Test:** `tests/rescue-lifecycle.test.mjs`, `tests/session-end.test.mjs`, `tests/recovery.test.mjs`, `tests/integration/two-session-hooks.test.mjs`.

- [ ] Extend private lifecycle adapters to perform runner cleanup after exact bounded remote stop/reread, including error paths. Reuse `terminateLeasedProcessTree`/`terminateRecordedProcessTree`; guard with marker, exact owner/epoch/job/claim and two nonblocking lease probes. Do not terminate an unmarked attached process group.
- [ ] Add joined-state tests asserting this order and outcomes:

```text
receipt/stop intent -> generation revalidation -> remote stop/reread
  -> marked runner identity revalidation -> bounded local termination
  -> exact lease acquisition and re-read -> winner or retained guard

remote timeout -> remaining local cleanup budget -> unresolved guard
natural success -> durable success -> local cleanup if still held
queued live claim -> queued stopIntent -> kill -> acquire lease -> cancelled
```

- [ ] Reserve local time inside the existing SessionEnd total budget; do not let remote abort cancel local cleanup's independent remaining budget. Include lock contention before stop, during stop, and after terminal publication. Never block waiting for a worker lease under cancellation/state locks.
- [ ] Retry local cleanup from durable cancelling-job evidence after receipt delegation. Terminal jobs may still have a held marked runner lease during cleanup; receipt discovery and terminal early returns must not drop that duty. Preserve marker/PID/lease until the executor releases; do not add a separate cleanup ledger.
- [ ] Keep queued stop receipts pending until settled. A delegated cancelling job continues blocking writable admission. Test same-epoch receipt, old receipt versus new epoch, same session ID across resume, natural winner, missing boundary, missing broker, and failed stop with successful local kill.
- [ ] Verify SubagentStop without a receipt does not kill background; foreground coordination loss continues to stop. Run `node --test --test-concurrency=1 tests/rescue-lifecycle.test.mjs tests/session-end.test.mjs tests/recovery.test.mjs tests/integration/two-session-hooks.test.mjs`; commit `feat: settle detached rescue runners at authorized stop boundaries`.

## Task 8: Real process handoff and crash qualification

**Create:** `tests/integration/true-background-rescue.test.mjs`, `tests/fixtures/host-rescue-runner-probe.mjs`. **Reuse:** `tests/fixtures/fake-zcode-cli.mjs`, installed lifecycle helpers. **Modify if needed:** `.github/workflows/ci.yml`.

- [ ] Use a real parent process and runner plus isolated plugin data. Gate fake-engine completion, receive queued, terminate only the test parent, and prove the runner publishes progress and terminal output. Poll durable records with bounded deadlines; do not infer detachment from a mocked `unref()` alone.
- [ ] Exercise process death before claim (retained queued), after claim before running (eligible recovery), after accepted boundary (exact Status/Result recovery), and accepted send without published boundary (retained writable exclusion). Assert at most one `session/send`, same job ID, and no automatic resume/relaunch.
- [ ] Run real user cancel and SessionEnd against gated queued/running children; assert runner/process descendants exit while the managed broker is not killed as a descendant. Test a free lease with a live unrelated PID and verify no signal is sent.
- [ ] Test exact continuation across stop/resume and placement changes with unchanged permission; permission mismatch rejects. Test a late old-epoch runner after compensation and new reservation: no second driver.
- [ ] Fixtures own cleanup: capture only created child handles/PIDs and temporary paths; await exits, release fake brokers, then remove only fixture directories. Do not send signals to production plugin processes or arbitrary recorded PIDs.
- [ ] Run `node --test --test-concurrency=1 tests/integration/true-background-rescue.test.mjs` locally. Add/retain native macOS/Linux/Windows matrix execution; no unconditional Windows skip for these acceptance cases. Record unavailable native platforms as pending, not passing. Commit `test: qualify true background rescue handoff and crash races`.

## Task 9: Delivery, ADRs, skill instructions, and isolated package parity

**Modify:** `skills/rescue/SKILL.md`, `agents/zcode-rescue.toml.template`, `scripts/lib/render.mjs`, `hooks/lib/hook-state.mjs`, `README.zh-CN.md`, `CHANGELOG.md`, `CONTEXT.md`, ADRs 0017/0018. **Create:** ADR 0021 as named above. **Test:** `tests/integration/skills.test.mjs`, `tests/release-contracts.test.mjs`, `tests/codex-rescue-qualification.test.mjs`, `tests/hooks.test.mjs`.

- [ ] Record ADR 0021: normal background Rescue uses one session-bound detached executor; foreground remains attached; queued is accepted-only; completion uses pull/PromptSubmit; exact binding and one ledger retained. Mark only the conflicting clauses in ADRs 0017/0018 superseded and cross-link; preserve other decisions and ADRs 0019/0020.
- [ ] Replace instructions requiring the background child to observe until terminal with enqueue-and-return behavior. Preserve task-free private preparation and exact child continuation. Queued acknowledgement never finalizes completion markers.
- [ ] Test PromptSubmit discovery for success/failure after child exit; delivery claims prevent simultaneous duplicate delivery, but a crash before marker finalization remains retryable. Preserve Status/Result and foreground full result behavior.
- [ ] Run isolated artifact checks:

```sh
node --test --test-concurrency=1 tests/integration/skills.test.mjs tests/release-contracts.test.mjs tests/codex-rescue-qualification.test.mjs tests/hooks.test.mjs
node --test tests/integration/plugin-layout.test.mjs tests/integration/package-install.test.mjs
node --test tests/integration/marketplace-snapshot-build.mjs
```

Expected: new entry/helpers included in packed/generated plugins and executable from an isolated installed root, with private data rooted correctly. Use existing build tools; never hand-edit or reinstall the user's live plugin cache. Commit `docs: document and package session-bound true background rescue` with the corresponding tested instruction changes.

## Task 10: Final verification and delivery

- [ ] Run the repository's complete local gate once implementation and instruction changes are finished:

```sh
npm run check
git diff --check
git status --short
```

Expected: code/style/type/tests pass; inspect reported skips. `test:qualified` can skip without external qualification prerequisites; do not report skipped real Codex/ZCode tests as passed. Run required qualification only when its configured controlled environment is available.
- [ ] Inspect native platform results for Task 8. If no Windows/Linux host or CI result is available, deliver the implementation with that explicit unfulfilled release condition; do not silently narrow the approved three-platform scope or fabricate success.
- [ ] Self-review against every acceptance section of the corrected spec. Check all four placement/continuation combinations and both claim/terminal race orders. Fix concrete regressions before delivery; avoid a new general-purpose lifecycle framework.
- [ ] Record test results, relevant skips, commit IDs, new worktree location, and remaining external qualification in the receiving agent's final handoff. Do not merge/push/deploy unless separately instructed.

## Spec coverage and planning self-review

| Spec requirement | Tasks |
| --- | --- |
| Foreground/background flags and inference preserved | 6, 8, 9 |
| Reserve before spawn, one ledger, bounded input, format compatibility | 2, 4, 5 |
| Recovery CAS, failure rollback, no age failure/no restart | 1, 3, 8 |
| Exact authority and receipt/dispatch race | 5, 7, 8 |
| Queued stop persistence and writable exclusion after receipt discharge | 3, 7 |
| Runner process cleanup, identity risk, shared budget | 7, 8 |
| Exact continuation across epochs and placements | 5, 8 |
| Queued delivery loss, result privacy, PromptSubmit | 6, 9 |
| ADR supersession and historical/read-only compatibility | 2, 4, 9 |
| New development worktree and three-platform/package qualification | 0, 8, 9, 10 |

This plan is approved to execute without a separate user plan-review checkpoint. The next agent should adapt local function factoring to the actual code while preserving these contracts; it must not treat illustrative adapter structure as permission to bypass existing guarded state transitions.
