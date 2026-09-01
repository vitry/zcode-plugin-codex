# Host-Managed Rescue Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make new Rescue runs Host-managed and session-bound, persist SessionEnd authority before cleanup, converge lifecycle races through one deep Reconciler, and preserve exact ZCode sessions for explicitly authorized resume.

**Architecture:** Add `host-lifecycle.mjs` as the bounded epoch/receipt store and `rescue-lifecycle.mjs` as the only high-level Rescue lifecycle decision and mutation seam. Existing StateStore, exact bindings, cancellation election, broker client, v4 observation, artifacts, worker leases, and legacy detached formats remain internal adapters; hooks, management commands, routing, and the companion become thin callers.

**Tech Stack:** Node.js 22.13 ESM, native `node:test`, existing StateStore/native advisory locks, ZCode 0.16.5 broker/app-server protocol, Codex native lifecycle hooks.

---

## File map

- Create `scripts/lib/host-lifecycle.mjs`: derive lifecycle epochs; atomically publish, list, settle, and retain bounded SessionEnd receipts.
- Create `scripts/lib/rescue-lifecycle.mjs`: compose validated Host, job, binding, worker, receipt, and remote evidence; own stop ordering and terminal winner publication.
- Create `tests/host-lifecycle.test.mjs`: receipt schema, idempotence, bounds, retention, epoch isolation, and compensation storage tests.
- Create `tests/rescue-lifecycle.test.mjs`: interface-level Host/job/binding/remote race matrix.
- Modify `scripts/lib/state.mjs`: new job fields, new-schema binding preservation, stop-cause publication, and exact resumability projection.
- Modify `scripts/lib/job-control.mjs`: delegate status/result/cancel/wait reconciliation and expose derived resumability.
- Modify `scripts/lib/recovery.mjs`: retain low-level historical/lease primitives while routing Rescue settlement through the Reconciler.
- Modify `scripts/lib/rescue-route-planner.mjs`: consume bounded Reconciler outcomes instead of independently joining lifecycle state.
- Modify `scripts/zcode-companion.mjs`: reserve Host-owned placement, stop launching detached workers for new Rescue, and publish terminal-before-notice.
- Modify `hooks/session-end-hook.mjs`: receipt-first, shared deadline, epoch-scoped settlement, then generic cleanup.
- Modify `hooks/session-lifecycle-hook.mjs`: record epochs and create local-only resume compensation.
- Modify `hooks/subagent-hook.mjs`: invoke foreground coordination-loss settlement after persisting child stop observation.
- Modify `hooks/user-prompt-hook.mjs`: reconcile previous-epoch obligations before granting new writable Rescue authority; retain unread notices as fallback.
- Modify `hooks/lib/hook-state.mjs`: expose notification peek/mark operations instead of marking unread jobs during discovery.
- Modify `scripts/lib/render.mjs` and `scripts/lib/rescue-launcher-command.mjs`: render Stop Cause, resumability, recovery hints, and deduplicated notices.
- Modify `skills/rescue/SKILL.md` and `agents/zcode-rescue.toml.template`: complexity placement, Host-managed background, and exact SessionEnd semantics.
- Modify existing unit/integration/contract/release tests and marketplace snapshot files listed in the final tasks.

### Task 1: Lifecycle epoch and receipt store

**Files:**
- Create: `scripts/lib/host-lifecycle.mjs`
- Create: `tests/host-lifecycle.test.mjs`

- [ ] **Step 1: Write failing epoch and receipt tests**

```js
test('one Host load produces a stable epoch and resume produces a distinct epoch', () => {
  assert.equal(hostLifecycleEpoch('session-a', '2026-09-02T00:00:00.000Z'), hostLifecycleEpoch('session-a', '2026-09-02T00:00:00.000Z'));
  assert.notEqual(hostLifecycleEpoch('session-a', '2026-09-02T00:00:00.000Z'), hostLifecycleEpoch('session-a', '2026-09-02T01:00:00.000Z'));
});

test('receipt creation is first-writer-wins and repeated publication only merges bounded hints', async () => {
  const store = createHostLifecycleStore({ dataRoot: fixture.dataRoot, now: fixture.now });
  const first = await store.publishSessionEnd({ sessionId: 'session-a', sessionStartedAt: START, endedAt: END, origin: 'session-end-hook', workspaceHints: [fixture.workspace] });
  const repeated = await store.publishSessionEnd({ sessionId: 'session-a', sessionStartedAt: START, endedAt: LATER, origin: 'resume-compensation', workspaceHints: [fixture.otherWorkspace] });
  assert.equal(repeated.endedAt, first.endedAt);
  assert.equal(repeated.origin, 'session-end-hook');
  assert.deepEqual(repeated.workspaceHints, [fixture.otherWorkspace, fixture.workspace].sort());
});
```

- [ ] **Step 2: Run the new tests and verify RED**

Run: `node --test tests/host-lifecycle.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `scripts/lib/host-lifecycle.mjs`.

- [ ] **Step 3: Implement the closed API and schema**

```js
export function hostLifecycleEpoch(sessionId, sessionStartedAt) {
  validateSessionId(sessionId); validateTimestamp(sessionStartedAt);
  return createHash('sha256').update('host-lifecycle-epoch-v1\0').update(sessionId).update('\0').update(sessionStartedAt).digest('hex');
}

export function createHostLifecycleStore({ dataRoot, now = () => new Date().toISOString() }) {
  return Object.freeze({
    publishSessionEnd: (input, options = {}) => publishReceipt(dataRoot, input, options),
    readReceipt: (epoch) => readReceipt(dataRoot, epoch),
    listPendingReceipts: (options = {}) => listPending(dataRoot, options),
    settleReceipt: (epoch, expectedUpdatedAt) => settleReceipt(dataRoot, epoch, expectedUpdatedAt, now()),
    pruneSettledReceipts: () => pruneSettled(dataRoot, { maximum: 512, retentionMs: 30 * 24 * 60 * 60_000 }),
  });
}
```

Use an epoch-specific private directory and advisory lock, `atomicWriteJson`, a 500 ms caller-supplied abort budget, strict keys, at most 128 canonical workspace hints, and 4,096 UTF-8 bytes per hint. Pending receipts are never age-pruned.

- [ ] **Step 4: Run the receipt suite and line-ending check**

Run: `node --test tests/host-lifecycle.test.mjs && npm run check:line-endings`

Expected: all receipt tests pass and `LF line endings verified` is printed.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/host-lifecycle.mjs tests/host-lifecycle.test.mjs
git commit -m "feat: persist host lifecycle receipts"
```

### Task 2: New Rescue job lifecycle fields and resumable bindings

**Files:**
- Modify: `scripts/lib/state.mjs`
- Modify: `scripts/lib/rescue-binding.mjs`
- Modify: `tests/state.test.mjs`
- Modify: `tests/rescue-binding.test.mjs`

- [ ] **Step 1: Write failing StateStore codec and transition tests**

```js
test('new Host-owned Rescue persists placement epoch and execution owner', async () => {
  const { job } = await store.reserveFreshRescueJob({
    workspace, reservation, executor,
    lifecycle: { ownerLifecycleEpoch: EPOCH, executionOwner: 'host-child', hostPlacement: 'background' },
  });
  assert.equal(job.ownerLifecycleEpoch, EPOCH);
  assert.equal(job.executionOwner, 'host-child');
  assert.equal(job.hostPlacement, 'background');
});

test('confirmed new-schema cancellation preserves the exact binding', async () => {
  const cancelled = await store.finishJob(workspace, running.id, ['cancelling'], 'cancelled', { stopIntent, stopCause: 'user' });
  const resolved = await store.resolveRescueBinding(bindingLookup);
  assert.equal(cancelled.stopCause, 'user');
  assert.equal(resolved.binding.currentJobId, running.id);
});
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `node --test --test-name-pattern='Host-owned Rescue|new-schema cancellation|stop cause|resumable' tests/state.test.mjs tests/rescue-binding.test.mjs`

Expected: FAIL because the new reservation fields and binding rule are rejected or absent.

- [ ] **Step 3: Extend the strict schemas and terminal transition**

Add exact enums and validators:

```js
const EXECUTION_OWNERS = new Set(['host-child']);
const HOST_PLACEMENTS = new Set(['foreground', 'background']);
const STOP_CAUSES = new Set(['user', 'session-end', 'host-coordination-loss']);

function validStopIntent(value) {
  return plain(value) && sameKeys(value, ['version', 'cause', 'requestedAt'])
    && value.version === 1 && STOP_CAUSES.has(value.cause) && validTimestamp(value.requestedAt);
}
```

Require `ownerLifecycleEpoch`, `executionOwner`, and `hostPlacement` together for new Host-owned Rescue records. Permit `stopIntent` only from nonterminal states and `stopCause` only on `cancelled`, with the same cause. Bypass `closeCurrentRescueBindingForCancellationLocked` only when the exact job has the new Host-owned schema; keep historical `closed/cancel` behavior unchanged.

- [ ] **Step 4: Run StateStore and binding suites**

Run: `node --test tests/state.test.mjs tests/rescue-binding.test.mjs tests/job-control.test.mjs`

Expected: all tests pass, including unchanged legacy cancel closure tests.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/state.mjs scripts/lib/rescue-binding.mjs tests/state.test.mjs tests/rescue-binding.test.mjs tests/job-control.test.mjs
git commit -m "feat: record host-owned rescue lifecycle"
```

### Task 3: Deep Rescue Lifecycle Reconciler

**Files:**
- Create: `scripts/lib/rescue-lifecycle.mjs`
- Create: `tests/rescue-lifecycle.test.mjs`
- Modify: `scripts/lib/recovery.mjs`

- [ ] **Step 1: Write the failing interface matrix**

```js
test('foreground child loss persists stop intent before exact remote stop', async () => {
  const events = [];
  const reconciler = createRescueLifecycleReconciler(fixtureAdapters({ events, host: 'systemError', placement: 'foreground', remote: 'interrupted' }));
  const outcome = await reconciler.reconcile({ intent: { kind: 'stop', cause: 'host-coordination-loss' }, authority, workspace });
  assert.deepEqual(events.slice(0, 3), ['persist-stop-intent', 'revalidate-generation', 'stop-exact-turn']);
  assert.deepEqual(outcome, { kind: 'settled-terminal', status: 'cancelled', stopCause: 'host-coordination-loss', resumable: true });
});

test('background child loss without matching receipt keeps the remote turn running', async () => {
  const fixture = fixtureAdapters({ host: 'absent', placement: 'background', receipt: null, remote: 'running' });
  const outcome = await createRescueLifecycleReconciler(fixture.adapters).reconcile({ intent: { kind: 'observe' }, authority, workspace });
  assert.equal(outcome.kind, 'wait-current');
  assert.equal(fixture.stopCalls, 0);
});
```

Cover `active|idle|notLoaded|systemError|absent`, all job states, both placements, stale generation/binding/workspace/permission, stop acknowledgement ambiguity, natural success, engine failure, and matching/older receipt epochs.

- [ ] **Step 2: Run the matrix and verify RED**

Run: `node --test tests/rescue-lifecycle.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement the single external seam**

```js
export function createRescueLifecycleReconciler(adapters) {
  validateAdapters(adapters);
  return Object.freeze({
    async reconcile(request) {
      const joined = await loadAndValidateJoinedState(adapters, request);
      if (joined.currentWinner) return terminalOutcome(joined.currentWinner);
      if (requiresStop(joined, request.intent)) return stopAndSettle(adapters, joined, request.intent.cause, request.signal);
      if (joined.unresolvedStop) return retryStopAndSettle(adapters, joined, request.signal);
      return selectBoundedOutcome(joined, request.intent);
    },
  });
}
```

Move orchestration—not codecs or protocol primitives—from `recovery.mjs`. `stopAndSettle` must persist intent, revalidate exact binding/current job/generation, use existing cancellation election and stop/reread, let natural success win, publish `failed` for Engine Terminal Failure, retain `cancelling` on uncertainty, and clean terminal reservations only after the winner is durable.

- [ ] **Step 4: Run Reconciler and existing recovery/cancel suites**

Run: `node --test tests/rescue-lifecycle.test.mjs tests/recovery.test.mjs tests/job-control.test.mjs`

Expected: all tests pass; no existing orphan or cancellation race regresses.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/rescue-lifecycle.mjs scripts/lib/recovery.mjs tests/rescue-lifecycle.test.mjs tests/recovery.test.mjs
git commit -m "feat: centralize rescue lifecycle reconciliation"
```

### Task 4: Management commands use reconciliation and expose resumability

**Files:**
- Modify: `scripts/lib/job-control.mjs`
- Modify: `scripts/lib/render.mjs`
- Modify: `scripts/zcode-companion.mjs`
- Modify: `tests/job-control.test.mjs`
- Modify: `tests/render-progress.test.mjs`
- Modify: `tests/integration/companion.test.mjs`

- [ ] **Step 1: Write failing status/result/cancel/wait tests**

```js
test('status wait retries unresolved stop through the Reconciler', async () => {
  const statuses = ['cancelling', 'cancelling', 'cancelled'];
  const reconciler = { reconcile: async () => ({ kind: statuses.shift() === 'cancelled' ? 'settled-terminal' : 'unresolved-stop' }) };
  const job = await controller.wait(workspace, jobId, owner, { reconciler, timeoutMs: 100 });
  assert.equal(job.status, 'cancelled');
});

test('terminal views expose resumable and Stop Cause without a ZCode session id', () => {
  const output = renderOutput({ type: 'job', job: { ...cancelled, resumable: true, stopCause: 'session-end' } });
  assert.match(output, /Resumable: yes/); assert.match(output, /Stop cause: session-end/); assert.doesNotMatch(output, /zcodeSessionId/);
});
```

- [ ] **Step 2: Run focused management tests and verify RED**

Run: `node --test --test-name-pattern='resumable|Stop Cause|retries unresolved stop' tests/job-control.test.mjs tests/render-progress.test.mjs tests/integration/companion.test.mjs`

Expected: FAIL because reconciliation and public fields are absent.

- [ ] **Step 3: Inject the Reconciler at the controller seam**

```js
export function createJobController(options) {
  const reconcile = options.reconcile ?? (async () => null);
  return Object.freeze({
    async status(workspace, ownerSessionId, jobId) {
      await reconcile({ intent: { kind: 'observe' }, workspace, ownerSessionId, selector: { jobId } });
      return projectOwned(await selectOwned(workspace, ownerSessionId, jobId, 'status'));
    },
    async result(workspace, ownerSessionId, jobId) {
      await reconcile({ intent: { kind: 'observe' }, workspace, ownerSessionId, selector: { jobId } });
      return projectOwned(await selectOwned(workspace, ownerSessionId, jobId, 'result'));
    },
    async cancel(workspace, jobId, ownerSessionId) {
      await reconcile({ intent: { kind: 'stop', cause: 'user' }, workspace, ownerSessionId, selector: { jobId } });
      return projectOwned(await selectOwned(workspace, ownerSessionId, jobId, 'status'));
    },
  });
}
```

Keep implicit Result terminal-only selection. Derive `resumable` from exact current binding, permission, terminal settlement, accepted session, and absence of an unresolved stop; never persist it or expose the session ID.

- [ ] **Step 4: Run management, rendering, and companion tests**

Run: `node --test tests/job-control.test.mjs tests/render-progress.test.mjs tests/integration/companion.test.mjs`

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/job-control.mjs scripts/lib/render.mjs scripts/zcode-companion.mjs tests/job-control.test.mjs tests/render-progress.test.mjs tests/integration/companion.test.mjs
git commit -m "feat: reconcile rescue management commands"
```

### Task 5: Receipt-first bounded SessionEnd

**Files:**
- Modify: `hooks/session-end-hook.mjs`
- Modify: `scripts/lib/recovery.mjs`
- Modify: `tests/integration/two-session-hooks.test.mjs`
- Modify: `tests/recovery.test.mjs`

- [ ] **Step 1: Write failing ordering, budget, and race tests**

```js
test('SessionEnd persists its receipt before contended identity cleanup', async () => {
  const run = hookWithHeldIdentityLock('session-end-hook.mjs', sessionEndInput);
  await waitForReceipt(dataRoot, EPOCH);
  run.kill('SIGKILL');
  assert.equal((await lifecycle.readReceipt(EPOCH)).state, 'pending');
});

test('SessionEnd delegates unresolved jobs to exact durable stop intents', async () => {
  const result = await runSessionEnd({ stop: 'never-settles', budgetMs: 2750 });
  assert.equal(result.elapsedMs < 3000, true);
  assert.equal((await store.readJob(workspace, job.id)).status, 'cancelling');
  assert.equal((await lifecycle.readReceipt(EPOCH)).state, 'settled');
});
```

- [ ] **Step 2: Run focused SessionEnd tests and verify RED**

Run: `node --test --test-name-pattern='receipt|contended identity|durable stop intents|read-only detached' tests/integration/two-session-hooks.test.mjs tests/recovery.test.mjs`

Expected: FAIL because current SessionEnd cleans identity first and has no receipt.

- [ ] **Step 3: Reorder the hook under one shared deadline**

Implement this exact stage order:

```js
const deadline = Date.now() + 2750;
const receipt = await lifecycle.publishSessionEnd(boundary, { signal: stageSignal(deadline, 500) });
const obligations = await discoverEpochObligations(receipt);
await runBounded(obligations, 2, (job) => reconciler.reconcile({ intent: { kind: 'stop', cause: 'session-end' }, selector: { jobId: job.id }, workspace: job.workspace, signal: stageSignal(deadline) }));
await delegateOrSettleReceipt(receipt, obligations);
await cleanupGenericSessionState({ deadline, knownWorkspaces });
```

Never lazily start a broker during SessionEnd. For detached Review/Adversarial, attempt exact remote stop, then terminate only the recorded process tree; process death alone does not publish remote cancellation.

- [ ] **Step 4: Run hook/recovery tests and assert the hard bound**

Run: `node --test tests/integration/two-session-hooks.test.mjs tests/recovery.test.mjs`

Expected: all tests pass; timeout fixtures finish below three seconds.

- [ ] **Step 5: Commit**

```bash
git add hooks/session-end-hook.mjs scripts/lib/recovery.mjs tests/integration/two-session-hooks.test.mjs tests/recovery.test.mjs
git commit -m "feat: record session end before settlement"
```

### Task 6: Resume compensation and prompt-time reconciliation

**Files:**
- Modify: `hooks/session-lifecycle-hook.mjs`
- Modify: `hooks/user-prompt-hook.mjs`
- Modify: `hooks/lib/hook-state.mjs`
- Modify: `tests/setup.test.mjs`
- Modify: `tests/integration/two-session-hooks.test.mjs`

- [ ] **Step 1: Write failing resume/compact epoch tests**

```js
test('resume synthesizes a local receipt for an unclosed previous epoch without remote work', async () => {
  await recordNonterminalOwnedJob(previousEpoch);
  const calls = { broker: 0 };
  await runSessionStart('resume', { createClient: async () => { calls.broker += 1; } });
  assert.equal((await lifecycle.readReceipt(previousEpoch)).origin, 'resume-compensation');
  assert.equal(calls.broker, 0);
});

test('compact remains in the same epoch and creates no receipt', async () => {
  const before = await recordedEpoch(); await runSessionStart('compact');
  assert.equal(await recordedEpoch(), before); assert.equal((await lifecycle.listPendingReceipts()).length, 0);
});
```

- [ ] **Step 2: Run lifecycle-hook tests and verify RED**

Run: `node --test --test-name-pattern='resume synthesizes|compact remains|previous epoch' tests/setup.test.mjs tests/integration/two-session-hooks.test.mjs`

Expected: FAIL because SessionStart currently records only one session timestamp.

- [ ] **Step 3: Add local compensation and the first active reconciliation seam**

On `source=resume`, atomically read the previous recorded epoch, scan only local validated job ownership, publish `resume-compensation` when nonterminal obligations lack a receipt, then publish the new session record. On `compact`, retain the current epoch. In UserPromptSubmit, reconcile matching pending receipts before `beginCallerTurn`; caller authority remains available for status/result/cancel, while the existing writable reservation seam rejects new Rescue until reconciliation clears the old Writable Guard.

```js
const pending = await lifecycle.pendingForPreviousEpoch(input.session_id, input.cwd);
await reconcilePendingReceipts(pending, { signal: boundedPromptSignal });
await identity.beginCallerTurn(callerInput);
```

- [ ] **Step 4: Run setup and two-session hook suites**

Run: `node --test tests/setup.test.mjs tests/integration/two-session-hooks.test.mjs`

Expected: all tests pass; sibling sessions and post-resume jobs remain untouched.

- [ ] **Step 5: Commit**

```bash
git add hooks/session-lifecycle-hook.mjs hooks/user-prompt-hook.mjs hooks/lib/hook-state.mjs tests/setup.test.mjs tests/integration/two-session-hooks.test.mjs
git commit -m "feat: compensate missing session end on resume"
```

### Task 7: Rescue Child coordination-loss policy

**Files:**
- Modify: `hooks/subagent-hook.mjs`
- Modify: `scripts/lib/rescue-route-planner.mjs`
- Modify: `tests/integration/two-session-hooks.test.mjs`
- Modify: `tests/rescue-route-planner.test.mjs`

- [ ] **Step 1: Write failing foreground/background child-loss tests**

```js
test('SubagentStop stops a foreground Host-owned Rescue but not a live-session background Rescue', async () => {
  const foreground = await hostOwnedRunningJob('foreground');
  await runSubagentStop(foreground.child); assert.equal((await readJob(foreground)).stopIntent.cause, 'host-coordination-loss');
  const background = await hostOwnedRunningJob('background');
  await runSubagentStop(background.child); assert.equal((await readJob(background)).status, 'running');
});
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `node --test --test-name-pattern='SubagentStop stops|coordination loss' tests/integration/two-session-hooks.test.mjs tests/rescue-route-planner.test.mjs`

Expected: FAIL because SubagentStop only marks forwarding provenance.

- [ ] **Step 3: Trigger bounded lifecycle reconciliation after recording Stop**

Keep `markForwarding` first. Resolve only the exact route/binding/job for the stopped child, then call `reconcile(stop(host-coordination-loss))` for foreground or `reconcile(observe)` for background. A matching epoch receipt always selects `stop(session-end)`; an old receipt selects neither.

- [ ] **Step 4: Run hook, route, and Reconciler tests**

Run: `node --test tests/rescue-lifecycle.test.mjs tests/rescue-route-planner.test.mjs tests/integration/two-session-hooks.test.mjs`

Expected: all tests pass with zero sibling/foreign stop calls.

- [ ] **Step 5: Commit**

```bash
git add hooks/subagent-hook.mjs scripts/lib/rescue-route-planner.mjs tests/rescue-route-planner.test.mjs tests/integration/two-session-hooks.test.mjs
git commit -m "feat: settle foreground rescue child loss"
```

### Task 8: Host-managed foreground and background Rescue execution

**Files:**
- Modify: `scripts/zcode-companion.mjs`
- Modify: `scripts/lib/invocation.mjs`
- Modify: `tests/integration/companion.test.mjs`
- Modify: `tests/plugin-contracts.test.mjs`

- [ ] **Step 1: Write failing ownership tests**

```js
test('new background Rescue runs attached and creates no detached execution artifacts', async () => {
  const effects = { workers: 0, capabilities: 0, specs: 0 };
  const result = await invokePreparedBackground({ effects });
  assert.equal(result.type, 'background');
  assert.deepEqual(effects, { workers: 0, capabilities: 0, specs: 0 });
  assert.equal((await readJob(result.job.id)).executionOwner, 'host-child');
});
```

- [ ] **Step 2: Run companion ownership tests and verify RED**

Run: `node --test --test-name-pattern='runs attached|zero detached|Host-owned background' tests/integration/companion.test.mjs tests/plugin-contracts.test.mjs`

Expected: FAIL because `startPublic` still seals a spec and calls `startBackgroundWorker`.

- [ ] **Step 3: Remove detached ownership from the new Rescue branch**

For child-authorized Rescue, reserve lifecycle fields from the prepared placement and always call the attached execution path:

```js
const lifecycle = { ownerLifecycleEpoch: context.ownerLifecycleEpoch, executionOwner: 'host-child', hostPlacement: parsed.options.execution };
reserved = await reservePublicRescueJob(context, () => store.reserveFreshRescueJob({ workspace: cwd, reservation, ...childProof, lifecycle }));
const terminal = await executeWithWorkerLease({ ...context, job: reserved.job, spec });
return parsed.options.execution === 'background' ? { type: 'background-terminal', job: terminal.job } : terminal;
```

Retain `run-reserved-job`, sealed spec, capability, worker lease, and `startBackgroundWorker` only for historical detached Rescue and read-only commands.

- [ ] **Step 4: Run companion, background-worker, and compatibility tests**

Run: `node --test tests/integration/companion.test.mjs tests/background-worker.test.mjs tests/plugin-contracts.test.mjs`

Expected: all tests pass; historical worker tests remain green while new Rescue asserts zero launches.

- [ ] **Step 5: Commit**

```bash
git add scripts/zcode-companion.mjs scripts/lib/invocation.mjs tests/integration/companion.test.mjs tests/plugin-contracts.test.mjs
git commit -m "feat: keep rescue execution host managed"
```

### Task 9: Durable terminal-before-live completion delivery

**Files:**
- Modify: `hooks/lib/hook-state.mjs`
- Modify: `scripts/lib/rescue-launcher-command.mjs`
- Modify: `scripts/zcode-companion.mjs`
- Modify: `tests/rescue-launcher-command.test.mjs`
- Modify: `tests/integration/companion.test.mjs`

- [ ] **Step 1: Write failing ordering and deduplication tests**

```js
test('background completion publishes durable winner before one Host notice', async () => {
  const events = [];
  await runHostBackground({ onTerminalWrite: () => events.push('terminal'), onArtifactWrite: () => events.push('artifact'), onNotice: () => events.push('notice') });
  assert.deepEqual(events, ['artifact', 'terminal', 'notice']);
  assert.deepEqual(await peekUnreadJobs(dataRoot, workspace, owner), []);
});

test('failed live delivery remains unread for PromptSubmit fallback', async () => {
  await assert.rejects(runHostBackground({ onNotice: () => { throw new Error('delivery lost'); } }));
  assert.equal((await peekUnreadJobs(dataRoot, workspace, owner)).length, 1);
});
```

- [ ] **Step 2: Run notice tests and verify RED**

Run: `node --test --test-name-pattern='Host notice|live delivery|unread' tests/rescue-launcher-command.test.mjs tests/integration/companion.test.mjs`

Expected: FAIL because `unreadJobs` currently marks during discovery and no live terminal notice exists.

- [ ] **Step 3: Split notification observation from acknowledgement**

Add `peekUnreadJobs(dataRoot, workspace, sessionId)` and `markJobNotified(dataRoot, workspace, sessionId, jobId)`; keep the old bounded marker format. Emit only after result artifact and terminal StateStore publication. The bounded notice contains job ID, terminal status, safe failure/Stop Cause summary, `resumable`, and the Result command. Mark notified only after successful Host delivery.

- [ ] **Step 4: Run notification and prompt fallback tests**

Run: `node --test tests/rescue-launcher-command.test.mjs tests/integration/companion.test.mjs tests/integration/two-session-hooks.test.mjs`

Expected: all tests pass with no duplicate prompt notice.

- [ ] **Step 5: Commit**

```bash
git add hooks/lib/hook-state.mjs scripts/lib/rescue-launcher-command.mjs scripts/zcode-companion.mjs tests/rescue-launcher-command.test.mjs tests/integration/companion.test.mjs tests/integration/two-session-hooks.test.mjs
git commit -m "feat: deliver durable rescue completion notices"
```

### Task 10: Complexity placement and public Rescue contract

**Files:**
- Modify: `skills/rescue/SKILL.md`
- Modify: `agents/zcode-rescue.toml.template`
- Modify: `scripts/lib/invocation.mjs`
- Modify: `tests/plugin-contracts.test.mjs`
- Modify: `tests/e2e/codex-skills-e2e.test.mjs`

- [ ] **Step 1: Write failing placement contract tests**

```js
test('Rescue infers placement without another question and flags override', () => {
  assert.equal(classifyRescuePlacement({ explicit: 'wait', complexity: 'high' }), 'foreground');
  assert.equal(classifyRescuePlacement({ explicit: 'background', complexity: 'low' }), 'background');
  assert.equal(classifyRescuePlacement({ complexity: 'low' }), 'foreground');
  assert.equal(classifyRescuePlacement({ complexity: 'open-ended' }), 'background');
});
```

Contract fixtures must also prove Review/Adversarial still ask without flags and management commands remain foreground.

- [ ] **Step 2: Run skill/Role contract tests and verify RED**

Run: `node --test --test-name-pattern='infers placement|Review.*ask|Host-managed' tests/plugin-contracts.test.mjs tests/e2e/codex-skills-e2e.test.mjs`

Expected: FAIL because Rescue still defaults to foreground and Role text describes detached background.

- [ ] **Step 3: Update the task-free parent/child protocol**

Define explicit selection rules in Skill and generated Role: small and clearly bounded → foreground; multi-step, open-ended, or likely long → background; flags authoritative; inferred background announced without confirmation. The prepared envelope carries only the placement enum—never task text or private identifiers—and both placements invoke the same constant child command.

- [ ] **Step 4: Run contract and captured qualification tests**

Run: `node --test tests/plugin-contracts.test.mjs tests/e2e/codex-skills-e2e.test.mjs`

Expected: all non-opt-in tests pass; authenticated qualification remains explicitly skipped.

- [ ] **Step 5: Commit**

```bash
git add skills/rescue/SKILL.md agents/zcode-rescue.toml.template scripts/lib/invocation.mjs tests/plugin-contracts.test.mjs tests/e2e/codex-skills-e2e.test.mjs
git commit -m "feat: select rescue placement by complexity"
```

### Task 11: Historical detached and read-only compatibility

**Files:**
- Modify: `scripts/zcode-companion.mjs`
- Modify: `scripts/lib/recovery.mjs`
- Modify: `tests/recovery.test.mjs`
- Modify: `tests/integration/companion.test.mjs`

- [ ] **Step 1: Write failing upgrade compatibility tests**

```js
test('upgrade does not adopt cancel or relaunch a historical detached Rescue', async () => {
  const legacy = await installHistoricalDetachedFixture({ closeReason: 'cancel' });
  await reconcileOwnedJobs(ownerInput);
  assert.equal(legacy.spawnCalls, 0);
  await assert.rejects(resolveResume(legacy.binding), { code: 'RESCUE_BINDING_CLOSED' });
});

test('SessionEnd attempts remote stop before killing an exact read-only worker', async () => {
  const events = []; await settleReadOnlyDetached({ stop: () => events.push('stop'), killExactTree: () => events.push('kill') });
  assert.deepEqual(events, ['stop', 'kill']);
});
```

- [ ] **Step 2: Run compatibility tests and verify RED**

Run: `node --test --test-name-pattern='historical detached|read-only worker|closed cancel' tests/recovery.test.mjs tests/integration/companion.test.mjs`

Expected: FAIL because read-only SessionEnd does not yet enforce remote-stop-before-process-kill ordering.

- [ ] **Step 3: Preserve legacy readers while forbidding new detached Rescue creation**

Gate `run-reserved-job` on validated historical reservation/spec evidence. Keep owner status/result/cancel and PromptSubmit fallback. Do not create a monitor child, rewrite schemas, reopen `closed/cancel`, or cancel records during installation. Reuse low-level stop/client/worker-tree helpers for read-only settlement without routing writable decisions around the Reconciler.

- [ ] **Step 4: Run all recovery and companion compatibility tests**

Run: `node --test tests/recovery.test.mjs tests/integration/companion.test.mjs tests/state.test.mjs`

Expected: all tests pass, including historical v1/v2 migration fixtures.

- [ ] **Step 5: Commit**

```bash
git add scripts/zcode-companion.mjs scripts/lib/recovery.mjs tests/recovery.test.mjs tests/integration/companion.test.mjs
git commit -m "test: preserve detached job compatibility"
```

### Task 12: Release surfaces, marketplace parity, and qualification

**Files:**
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `SECURITY.md`
- Modify: `CHANGELOG.md`
- Modify: `tests/release-contracts.test.mjs`
- Modify: `tests/marketplace-snapshot.test.mjs`
- Regenerate: `marketplace/plugins/zcode/**`
- Regenerate: `marketplace/.agents/plugins/provenance.json`

- [ ] **Step 1: Write failing release-contract assertions**

```js
test('release docs define Host-managed session-bound Rescue', () => {
  for (const text of [read('README.md'), read('README.zh-CN.md'), read('SECURITY.md')]) {
    assert.match(text, /session-bound/i);
    assert.match(text, /resumable/i);
    assert.doesNotMatch(text, /background Rescue.*independent/i);
  }
});
```

- [ ] **Step 2: Run release tests and verify RED**

Run: `node --test tests/release-contracts.test.mjs tests/marketplace-snapshot.test.mjs`

Expected: FAIL until docs and installed snapshot match the new behavior.

- [ ] **Step 3: Update public docs and generated payload**

Document placement inference, session-bound `--background`, Stop Cause, `resumable`, `cancelling`, SessionEnd behavior, historical compatibility, and real qualification. Regenerate the managed Role/template and marketplace snapshot using the repository builder from a clean source commit; do not hand-edit generated runtime files.

- [ ] **Step 4: Run static, full, packed, and opt-in-safe qualification**

Run:

```bash
npm run check:line-endings
npm run lint
npm run typecheck
npm test
npm run test:qualified
```

Expected: lint/typecheck succeed; ordinary and packed tests report zero failures; authenticated Codex/ZCode cases report explicit opt-in skips unless their environment flags are set.

- [ ] **Step 5: Run the controlled real incident qualification when credentials are authorized**

Run:

```bash
ZCODE_CODEX_RESCUE_E2E=1 ZCODE_REAL_E2E=1 npm run test:qualification-required
```

Expected: graceful logout writes the receipt, resume recognizes pending settlement, exact `session/stop` interrupts an active permission barrier, and no prohibited workspace mutation occurs. If credentials are not authorized, record this gate as not run; do not weaken or fake it.

- [ ] **Step 6: Commit release surfaces**

```bash
git add README.md README.zh-CN.md SECURITY.md CHANGELOG.md tests/release-contracts.test.mjs tests/marketplace-snapshot.test.mjs marketplace
git commit -m "docs: publish host-managed rescue lifecycle"
```

## Completion gate

Before integration, compare every section of `docs/superpowers/specs/2026-09-02-host-managed-rescue-lifecycle-design.md` to Tasks 1–12. Required evidence is: receipt-first SessionEnd; resume compensation; epoch isolation; foreground/background child-loss split; no new detached Rescue; read-only and historical compatibility; terminal-before-notice; resumable binding semantics; Stop Cause; unresolved writable exclusion; exact permission enforcement; all normal tests green; real qualification either passed under explicit authorization or recorded as an outstanding release gate.
