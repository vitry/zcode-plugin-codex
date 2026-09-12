// @ts-nocheck
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { markForwarding, recordSession, resolveForwardingRoute, resolveRecordedSessionStart, resolveRoutedForwardingExecutor, resolveRoutedStoppedForwardingExecutor } from '../hooks/lib/hook-state.mjs';
import { PluginError } from '../scripts/lib/errors.mjs';
import { createIdentityStore } from '../scripts/lib/identity.mjs';
import { hostLifecycleEpoch } from '../scripts/lib/host-lifecycle.mjs';
import { createStateStore } from '../scripts/lib/state.mjs';
import { resolveWorkspaceStorage } from '../scripts/lib/workspace.mjs';

const SESSION = 'reconcile-parent';
const SPAWN_TURN = 'reconcile-parent-turn-1';
const RETRY_TURN = 'reconcile-parent-turn-2';
const AGENT = 'reconcile-child';
const AGENT_PATH = '/root/zcode_rescue_task';
const CHILD_TURN = 'reconcile-child-turn';
const SESSION_STARTED_AT = '2026-09-12T00:00:00.000Z';

/**
 * The incident fixture: one Host-owned writable Rescue whose Rescue child died
 * (exact failed Host turn, no SubagentStop, no SessionEnd receipt) leaving its
 * three hook records (route, forwarding, executor) ACTIVE. The tracked job's
 * status is independently configurable: the incident itself is a succeeded job.
 * @param {any} t
 * @param {{placement?:string,job?:('succeeded'|'running')}} [options]
 */
async function reconciliationFixture(t, options = {}) {
  const placement = options.placement ?? 'foreground';
  const root = await mkdtemp(join(tmpdir(), 'zcode-rescue-child-reconcile-'));
  await mkdir(join(root, 'workspace'));
  const workspace = await realpath(join(root, 'workspace'));
  const dataRoot = join(root, 'data');
  t.after(() => rm(root, { force: true, recursive: true }));
  const identity = createIdentityStore({ dataRoot });
  await recordSession(dataRoot, { session_id: SESSION, cwd: workspace, source: 'startup' });
  await identity.beginCallerTurn({ sessionId: SESSION, turnId: SPAWN_TURN, workspace, permissionMode: 'workspace-write', prompt: 'rescue', sessionStartedAt: SESSION_STARTED_AT, sessionSource: 'startup', lifecycleResult: true });
  const spawningCaller = await identity.resolveActiveTurn({ sessionId: SESSION, workspace, workspaceBinding: 'claim' });
  const start = { session_id: SESSION, turn_id: CHILD_TURN, cwd: workspace, hook_event_name: 'SubagentStart', agent_id: AGENT, agent_type: 'zcode-rescue' };
  await markForwarding(dataRoot, start, spawningCaller);
  const epoch = hostLifecycleEpoch(SESSION, (await resolveRecordedSessionStart(dataRoot, workspace, SESSION)).startedAt);
  const store = createStateStore({ dataRoot });
  const reserved = await store.reserveFreshRescueJob({
    workspace,
    reservation: { workspace, ownerSessionId: SESSION, ownerTurnId: SPAWN_TURN, command: 'rescue', readOnly: false, permissionSnapshot: { permissionMode: 'workspace-write' } },
    executor: { parentSessionId: SESSION, parentTurnId: SPAWN_TURN, agentId: AGENT, agentType: 'zcode-rescue', agentPath: AGENT_PATH, workspace, parentPermissionMode: 'workspace-write' },
    lifecycle: { ownerLifecycleEpoch: epoch, executionOwner: 'host-child', hostPlacement: placement },
  });
  let reservationLease;
  if (options.fencedReservation === true) {
    // The outstanding-cleanup shape: a published sealed execution reservation
    // whose release the real identity store must refuse (no capability record).
    const authority = { version: 1, capabilityDigest: '1'.repeat(64), reservationId: '2'.repeat(64),
      jobId: reserved.job.id, ownerSessionId: reserved.job.ownerSessionId, workspace: reserved.job.workspace,
      operation: 'run-reserved-job', jobSpecFormat: 'sealed-v2' };
    await store.publishJobSpecCommitment(workspace, reserved.job.id, '3'.repeat(64), authority);
    reservationLease = '4'.repeat(64);
    await store.bindJobExecutionReservationLease(workspace, reserved.job.id, { capabilityDigest: authority.capabilityDigest, reservationId: authority.reservationId, workerLeaseId: reservationLease });
  }
  const claimed = await store.claimJobWorkerForExecution(workspace, reserved.job.id, { childPid: 999_999_999, workerLeaseId: reservationLease ?? reserved.job.id }, undefined, options.fencedReservation === true ? { sealedCommitment: '3'.repeat(64) } : undefined);
  let job = await store.transitionJob(workspace, reserved.job.id, ['queued'], 'running', { startedAt: new Date().toISOString(), zcodeSessionId: 'zs-reconcile', childPid: claimed.childPid, workerLeaseId: claimed.workerLeaseId });
  job = await store.transitionJob(workspace, job.id, ['running'], 'running', { inputId: 'accepted-input', startRevision: 1, beforeMessageIds: [] });
  if (options.job === undefined || options.job === 'succeeded') {
    job = await store.finishJob(workspace, job.id, ['running'], 'succeeded', { resultArtifact: 'results/final-answer.json', exitCode: 0 });
  }
  // The retry that prepares the continuation runs on a LATER parent turn: the
  // child died before its SubagentStop, so the parent moved on.
  await identity.beginCallerTurn({ sessionId: SESSION, turnId: RETRY_TURN, workspace, permissionMode: 'workspace-write', prompt: 'continue the rescue', sessionStartedAt: SESSION_STARTED_AT, sessionSource: 'startup', lifecycleResult: true });
  const caller = await identity.resolveActiveTurn({ sessionId: SESSION, workspace, workspaceBinding: 'claim' });
  assert.notEqual(caller.turnId, SPAWN_TURN, 'the preparing caller is a later parent turn');
  const storage = await resolveWorkspaceStorage({ dataRoot, workspace });
  const hookDirectory = join(storage.directory, 'hook-state');
  const names = await readdir(hookDirectory);
  const sessionStartedAt = (await resolveRecordedSessionStart(dataRoot, workspace, SESSION)).startedAt;
  assert.equal(hostLifecycleEpoch(SESSION, sessionStartedAt), epoch, 'the fixture epoch derives from the recorded session start');
  return {
    root, workspace, dataRoot, caller, store, job, epoch, start, sessionStartedAt,
    routePath: join(hookDirectory, names.find((name) => name.startsWith('route-'))),
    forwardPath: join(hookDirectory, names.find((name) => name.startsWith('forward-'))),
    executorPath: join(hookDirectory, names.find((name) => name.startsWith('executor-'))),
    bindingPath: join(storage.directory, `rescue-binding-session-${(await import('../scripts/lib/rescue-binding.mjs')).rescueBindingPartitionKey({ parentSessionId: SESSION, workspace: storage.workspacePath })}.json`),
  };
}

/** The exact Host evidence the incident child would present: a non-active thread
 * whose latest returned turn is the correlated, explicitly failed child turn. */
function incidentProof(fixture) {
  return {
    child: { id: AGENT, parentThreadId: SESSION, agentPath: AGENT_PATH, agentRole: 'zcode-rescue', cwd: fixture.workspace, status: { type: 'notLoaded' }, createdAt: 1, updatedAt: 2 },
    observedTurnId: CHILD_TURN,
    terminalStatus: 'failed',
  };
}

/** Spy seams over the real defaults: the Host evidence adapter and the ZCode
 * control client factory are the two remote seams; the stores stay real. The
 * default remote client serves one attributable active current turn before an
 * acknowledged stop and replays the same snapshot after it, so the existing
 * reconciler's stop/reread election runs against a live turn unless a test
 * overrides the reread. */
function observationSeams(fixture, proof, remote = {}) {
  const hostReads = [];
  const remoteStops = [];
  const clientCreations = [];
  const remoteState = { reads: 0, stopped: false };
  const runningSnapshot = () => ({
    projection: { status: 'running' }, runtime: { stateRevision: 8 }, messages: [
      { info: { role: 'user', messageId: 'accepted-input' }, parts: [{ type: 'text', text: 'task' }] },
    ],
  });
  return {
    hostReads, remoteStops, clientCreations, remoteState,
    dependencies: {
      listChildren: async () => [{
        id: AGENT, parentThreadId: SESSION, agentPath: AGENT_PATH, agentRole: 'zcode-rescue',
        cwd: fixture.workspace, status: { type: 'notLoaded' }, createdAt: 1, updatedAt: 2,
      }],
      readChildTurnEvidence: async (childId, parentId, expectedTurnId) => {
        hostReads.push({ childId, parentId, expectedTurnId });
        if (proof === undefined) throw new PluginError('RESCUE_CHILD_EVIDENCE_UNAVAILABLE', 'Codex could not serve exact terminal-turn evidence for the Rescue child.', { category: 'protocol', remedy: 'Treat the Rescue child as not proven terminal.' });
        return typeof proof === 'function' ? proof(hostReads.length) : proof;
      },
      createClient: async () => {
        clientCreations.push(true);
        return {
          readSession: async () => {
            remoteState.reads += 1;
            if (remote.readError !== undefined) throw remote.readError;
            return remote.readSnapshot?.(remoteState) ?? runningSnapshot();
          },
          stopSession: async () => {
            remoteState.stopped = true; remoteStops.push(true); remote.onStop?.();
          },
          close: async () => {},
        };
      },
    },
  };
}

/** The terminal interrupted reread the reconciler publishes as a cancelled winner. */
function interruptedReread(text) {
  return {
    projection: { status: 'completed' }, runtime: { stateRevision: 8 }, messages: [
      { info: { role: 'user', messageId: 'accepted-input' }, parts: [{ type: 'text', text: 'task' }] },
      { info: { role: 'assistant', messageId: 'answer', parentMessageId: 'accepted-input', finish: 'cancelled' }, parts: [{ type: 'text', text }] },
    ],
  };
}

/** The terminal succeeded reread the reconciler publishes as the natural-success winner. */
function succeededReread(text) {
  return {
    projection: { status: 'completed' }, runtime: { stateRevision: 8 }, messages: [
      { info: { role: 'user', messageId: 'accepted-input' }, parts: [{ type: 'text', text: 'task' }] },
      { info: { role: 'assistant', messageId: 'answer', parentMessageId: 'accepted-input', finish: 'stop' }, parts: [{ type: 'text', text }] },
    ],
  };
}

test('reconciles the terminal-job incident: exact failed Host turn, succeeded job, three active records, zero remote stops', async (t) => {
  const { reconcileRescueChildForPreparation } = await import('../scripts/lib/rescue-child-reconciliation.mjs');
  const fixture = await reconciliationFixture(t, { job: 'succeeded' });
  // The incident precondition: no SubagentStop arrived, so all three records
  // stayed active and the existing stopped lookup still rejects continuation.
  assert.equal((await resolveForwardingRoute(fixture.dataRoot, fixture.workspace, SESSION, CHILD_TURN)).state, 'active');
  assert.equal(JSON.parse(await readFile(fixture.executorPath, 'utf8')).active, true);
  await assert.rejects(resolveRoutedStoppedForwardingExecutor(fixture.dataRoot, fixture.workspace, AGENT), { code: 'EXECUTOR_STATE_MISMATCH' });
  const jobBefore = await fixture.store.readJob(fixture.workspace, fixture.job.id);
  const bindingBefore = await readFile(fixture.bindingPath, 'utf8');
  const seams = observationSeams(fixture, incidentProof(fixture));

  const outcome = await reconcileRescueChildForPreparation({
    dataRoot: fixture.dataRoot,
    caller: fixture.caller,
    envelope: { version: 3, options: { resume: 'resume' }, continuationTarget: { agentPath: AGENT_PATH } },
    appServerOptions: {},
    dependencies: seams.dependencies,
  });

  assert.deepEqual(outcome, { kind: 'reconciled', executionWorkspace: fixture.workspace });
  // All three stale records are stopped and the existing stopped lookup passes.
  assert.equal((await resolveForwardingRoute(fixture.dataRoot, fixture.workspace, SESSION, CHILD_TURN)).state, 'stopped');
  assert.equal(JSON.parse(await readFile(fixture.forwardPath, 'utf8')).active, false, 'the forwarding marker is inactive');
  const executor = JSON.parse(await readFile(fixture.executorPath, 'utf8'));
  assert.equal(executor.active, false, 'the executor record is inactive');
  assert.deepEqual(await resolveRoutedStoppedForwardingExecutor(fixture.dataRoot, fixture.workspace, AGENT), { executor, executionWorkspace: fixture.workspace });
  // The business winner is preserved byte-for-byte: no remote stop, no client,
  // no job mutation, no binding change.
  assert.equal(seams.remoteStops.length, 0, 'a terminal job is never remotely stopped');
  assert.equal(seams.clientCreations.length, 0, 'a terminal job needs no control channel');
  assert.deepEqual(await fixture.store.readJob(fixture.workspace, fixture.job.id), jobBefore);
  assert.equal(await readFile(fixture.bindingPath, 'utf8'), bindingBefore, 'the binding partition is unchanged');
  // Two exact Host observations bracket the settlement before the stop writes.
  assert.equal(seams.hostReads.length, 2);
  assert.deepEqual(seams.hostReads[0], { childId: AGENT, parentId: SESSION, expectedTurnId: CHILD_TURN });
  assert.deepEqual(seams.hostReads[1], seams.hostReads[0]);
});

test('skips fresh requests entirely without any read or write', async (t) => {
  const { reconcileRescueChildForPreparation } = await import('../scripts/lib/rescue-child-reconciliation.mjs');
  const fixture = await reconciliationFixture(t, { job: 'succeeded' });
  const seams = observationSeams(fixture, incidentProof(fixture));
  const outcome = await reconcileRescueChildForPreparation({
    dataRoot: fixture.dataRoot,
    caller: fixture.caller,
    envelope: { version: 3, options: { resume: 'fresh' }, continuationTarget: null },
    appServerOptions: {},
    dependencies: seams.dependencies,
  });
  assert.deepEqual(outcome, { kind: 'not-needed' });
  assert.equal(seams.hostReads.length, 0, 'a fresh request never reads Host evidence');
  assert.equal(seams.clientCreations.length, 0);
  assert.equal((await resolveForwardingRoute(fixture.dataRoot, fixture.workspace, SESSION, CHILD_TURN)).state, 'active', 'no record is touched');
});

test('fails closed with unavailable evidence and no writes when the Host cannot prove the terminal turn', async (t) => {
  const { reconcileRescueChildForPreparation } = await import('../scripts/lib/rescue-child-reconciliation.mjs');
  const fixture = await reconciliationFixture(t, { job: 'succeeded' });
  const seams = observationSeams(fixture, undefined);
  await assert.rejects(reconcileRescueChildForPreparation({
    dataRoot: fixture.dataRoot,
    caller: fixture.caller,
    envelope: { version: 3, options: { resume: 'resume' }, continuationTarget: { agentPath: AGENT_PATH } },
    appServerOptions: {},
    dependencies: seams.dependencies,
  }), (/** @type {any} */ error) => {
    assert.equal(error.code, 'RESCUE_CHILD_EVIDENCE_UNAVAILABLE');
    return true;
  });
  assert.equal(seams.hostReads.length, 1, 'the unprovable first observation ends the bounded read budget');
  assert.equal(seams.clientCreations.length, 0, 'no business reconciliation runs without terminal evidence');
  assert.equal((await resolveForwardingRoute(fixture.dataRoot, fixture.workspace, SESSION, CHILD_TURN)).state, 'active', 'no recovery write happens on unknown Host evidence');
  assert.equal(JSON.parse(await readFile(fixture.executorPath, 'utf8')).active, true);
});

test('settles nonterminal foreground work through the existing reconciler and blocks continuation while the remote stop is unconfirmed', async (t) => {
  const { reconcileRescueChildForPreparation } = await import('../scripts/lib/rescue-child-reconciliation.mjs');
  const { settleRescueChildOwnedJob } = await import('../scripts/lib/recovery.mjs');
  const fixture = await reconciliationFixture(t, { job: 'running' });
  const seams = observationSeams(fixture, incidentProof(fixture));
  let settlements = 0; let settlementBudget;
  const wrappedSeams = {
    ...seams.dependencies,
    settleOwnedJob: async (input, jobId) => {
      settlements += 1; settlementBudget = input.timeoutMs;
      return settleRescueChildOwnedJob(input, jobId);
    },
  };
  await assert.rejects(reconcileRescueChildForPreparation({
    dataRoot: fixture.dataRoot,
    caller: fixture.caller,
    envelope: { version: 3, options: { resume: 'resume' }, continuationTarget: { agentPath: AGENT_PATH } },
    appServerOptions: {},
    dependencies: wrappedSeams,
  }), (/** @type {any} */ error) => {
    assert.equal(error.code, 'RESCUE_CHILD_RECOVERY_PENDING');
    return true;
  });
  assert.equal(settlements, 1, 'exactly one business reconciliation runs');
  assert.ok(settlementBudget <= 5_000, 'the settlement draws only from the shared five-second budget');
  assert.equal(seams.hostReads.length, 1, 'no second Host proof runs after an unresolved settlement');
  assert.equal(seams.remoteStops.length, 1, 'the existing reconciler attempted the exact remote stop');
  const stored = await fixture.store.readJob(fixture.workspace, fixture.job.id);
  assert.equal(stored.status, 'cancelling', 'the foreground coordination-loss stop persists its durable intent');
  assert.equal(stored.stopIntent?.cause, 'host-coordination-loss');
  assert.equal((await resolveForwardingRoute(fixture.dataRoot, fixture.workspace, SESSION, CHILD_TURN)).state, 'active', 'the child records stay untouched while the job settlement is unresolved');
  assert.equal(JSON.parse(await readFile(fixture.executorPath, 'utf8')).active, true);
});

test('an authoritative natural success during the coordination-loss stop settles the job and reconciles the child', async (t) => {
  const { reconcileRescueChildForPreparation } = await import('../scripts/lib/rescue-child-reconciliation.mjs');
  const { settleRescueChildOwnedJob } = await import('../scripts/lib/recovery.mjs');
  const fixture = await reconciliationFixture(t, { job: 'running' });
  const seams = observationSeams(fixture, incidentProof(fixture), {
    readSnapshot: (state) => state.stopped ? succeededReread('the rescue finished on its own') : undefined,
  });
  let settlements = 0;
  const wrappedSeams = {
    ...seams.dependencies,
    settleOwnedJob: async (input, jobId) => { settlements += 1; return settleRescueChildOwnedJob(input, jobId); },
  };
  const outcome = await reconcileRescueChildForPreparation({
    dataRoot: fixture.dataRoot,
    caller: fixture.caller,
    envelope: { version: 3, options: { resume: 'resume' }, continuationTarget: { agentPath: AGENT_PATH } },
    appServerOptions: {},
    dependencies: wrappedSeams,
  });
  assert.deepEqual(outcome, { kind: 'reconciled', executionWorkspace: fixture.workspace });
  assert.equal(settlements, 1);
  assert.equal(seams.remoteStops.length, 1, 'the stop was attempted before the natural success was observed');
  const stored = await fixture.store.readJob(fixture.workspace, fixture.job.id);
  assert.equal(stored.status, 'succeeded', 'the authoritative natural success wins the race');
  assert.equal(typeof stored.resultArtifact, 'string', 'the recovered result artifact is published');
  assert.equal((await resolveForwardingRoute(fixture.dataRoot, fixture.workspace, SESSION, CHILD_TURN)).state, 'stopped', 'the child records are settled only after the job settlement');
  assert.equal(JSON.parse(await readFile(fixture.executorPath, 'utf8')).active, false);
  assert.equal(seams.hostReads.length, 2, 'two exact Host observations bracket the settlement');
});

test('nonterminal background work without a receipt or intent stays pending without any stop', async (t) => {
  const { reconcileRescueChildForPreparation } = await import('../scripts/lib/rescue-child-reconciliation.mjs');
  const { settleRescueChildOwnedJob } = await import('../scripts/lib/recovery.mjs');
  const fixture = await reconciliationFixture(t, { placement: 'background', job: 'running' });
  const seams = observationSeams(fixture, incidentProof(fixture));
  let settlements = 0;
  const wrappedSeams = {
    ...seams.dependencies,
    settleOwnedJob: async (input, jobId) => { settlements += 1; return settleRescueChildOwnedJob(input, jobId); },
  };
  await assert.rejects(reconcileRescueChildForPreparation({
    dataRoot: fixture.dataRoot,
    caller: fixture.caller,
    envelope: { version: 3, options: { resume: 'resume' }, continuationTarget: { agentPath: AGENT_PATH } },
    appServerOptions: {},
    dependencies: wrappedSeams,
  }), { code: 'RESCUE_CHILD_RECOVERY_PENDING' });
  assert.equal(settlements, 1);
  assert.equal(seams.remoteStops.length, 0, 'background work is never stopped merely by child loss');
  assert.equal(seams.clientCreations.length, 1, 'the observation still joins the existing remote evidence');
  const stored = await fixture.store.readJob(fixture.workspace, fixture.job.id);
  assert.equal(stored.status, 'running', 'the original job completion stays pending');
  assert.equal(stored.stopIntent, undefined, 'no stop intent is minted');
  assert.equal((await resolveForwardingRoute(fixture.dataRoot, fixture.workspace, SESSION, CHILD_TURN)).state, 'active');
});

test('a matching SessionEnd receipt published before settlement keeps session-end precedence over the placement', async (t) => {
  const { reconcileRescueChildForPreparation } = await import('../scripts/lib/rescue-child-reconciliation.mjs');
  const { settleRescueChildOwnedJob } = await import('../scripts/lib/recovery.mjs');
  const { createHostLifecycleStore } = await import('../scripts/lib/host-lifecycle.mjs');
  const fixture = await reconciliationFixture(t, { placement: 'background', job: 'running' });
  const seams = observationSeams(fixture, incidentProof(fixture), {
    readSnapshot: (state) => state.stopped ? interruptedReread('settled by session end') : undefined,
  });
  let settlements = 0;
  const wrappedSeams = {
    ...seams.dependencies,
    settleOwnedJob: async (input, jobId) => { settlements += 1; return settleRescueChildOwnedJob(input, jobId); },
  };
  const lifecycle = createHostLifecycleStore({ dataRoot: fixture.dataRoot });
  await lifecycle.publishSessionEnd({
    sessionId: SESSION, sessionStartedAt: fixture.sessionStartedAt, endedAt: new Date().toISOString(),
    origin: 'session-end-hook', workspaceHints: [fixture.workspace],
  }, { signal: AbortSignal.timeout(250) });
  const outcome = await reconcileRescueChildForPreparation({
    dataRoot: fixture.dataRoot,
    caller: fixture.caller,
    envelope: { version: 3, options: { resume: 'resume' }, continuationTarget: { agentPath: AGENT_PATH } },
    appServerOptions: {},
    dependencies: wrappedSeams,
  });
  assert.deepEqual(outcome, { kind: 'reconciled', executionWorkspace: fixture.workspace });
  assert.equal(settlements, 1);
  const stored = await fixture.store.readJob(fixture.workspace, fixture.job.id);
  assert.equal(stored.status, 'cancelled');
  assert.equal(stored.stopCause, 'session-end', 'the matching receipt wins the cause even for a background placement');
  assert.equal(seams.remoteStops.length, 1);
  assert.equal((await resolveForwardingRoute(fixture.dataRoot, fixture.workspace, SESSION, CHILD_TURN)).state, 'stopped');
});

test('a SessionEnd receipt intervening before the stop intent is persisted wins the durable cause and keeps the child records', async (t) => {
  const { reconcileRescueChildForPreparation } = await import('../scripts/lib/rescue-child-reconciliation.mjs');
  const { settleRescueChildOwnedJob } = await import('../scripts/lib/recovery.mjs');
  const { createHostLifecycleStore } = await import('../scripts/lib/host-lifecycle.mjs');
  const fixture = await reconciliationFixture(t, { job: 'running' });
  const seams = observationSeams(fixture, incidentProof(fixture));
  const lifecycle = createHostLifecycleStore({ dataRoot: fixture.dataRoot });
  assert.equal(await lifecycle.readReceipt(fixture.epoch), null, 'no receipt exists before the recovery');
  const unavailable = new PluginError('ZCODE_DISCONNECTED', 'the existing broker is unreachable', { category: 'runtime', remedy: 'Restart.' });
  let settlements = 0;
  const wrappedSeams = {
    ...seams.dependencies,
    // The receipt lands on the PUBLIC remote seam, at the exact window between
    // the settlement's initial evidence read and the serialized stop-intent
    // persist: the client's first readSession publishes it, then reports the
    // control channel unavailable.
    settleOwnedJob: async (input, jobId) => {
      settlements += 1;
      return settleRescueChildOwnedJob({ ...input, createClient: async () => ({
        readSession: async () => {
          await lifecycle.publishSessionEnd({
            sessionId: SESSION, sessionStartedAt: fixture.sessionStartedAt, endedAt: new Date().toISOString(),
            origin: 'session-end-hook', workspaceHints: [fixture.workspace],
          }, { signal: AbortSignal.timeout(250) });
          throw unavailable;
        },
        stopSession: async () => { seams.remoteStops.push(true); },
        close: async () => {},
      }) }, jobId);
    },
  };
  await assert.rejects(reconcileRescueChildForPreparation({
    dataRoot: fixture.dataRoot,
    caller: fixture.caller,
    envelope: { version: 3, options: { resume: 'resume' }, continuationTarget: { agentPath: AGENT_PATH } },
    appServerOptions: {},
    dependencies: wrappedSeams,
  }), { code: 'RESCUE_CHILD_RECOVERY_PENDING' }, 'the unconfirmed control channel keeps the settlement pending');
  assert.equal(settlements, 1);
  const stored = await fixture.store.readJob(fixture.workspace, fixture.job.id);
  assert.equal(stored.status, 'cancelling');
  assert.equal(stored.stopIntent?.cause, 'session-end', 'a receipt published before the persist must win the cause over coordination loss');
  assert.equal((await lifecycle.readReceipt(fixture.epoch)).state, 'pending', 'the racing receipt stays pending for its own SessionEnd reconciliation');
  assert.equal((await resolveForwardingRoute(fixture.dataRoot, fixture.workspace, SESSION, CHILD_TURN)).state, 'active', 'no child record is written while the job settlement stays unresolved');
  assert.equal(seams.remoteStops.length, 0, 'the unavailable control channel was never stopped');
});

test('a cancelling-anchor operation fails the binding lookup with the canonical planner error before any settlement', async (t) => {
  const { reconcileRescueChildForPreparation } = await import('../scripts/lib/rescue-child-reconciliation.mjs');
  const { hostOwnedStopIntentPatch } = await import('../scripts/lib/rescue-binding.mjs');
  const fixture = await reconciliationFixture(t, { job: 'running' });
  const current = await fixture.store.readJob(fixture.workspace, fixture.job.id);
  await fixture.store.transitionJob(fixture.workspace, fixture.job.id, ['running'], 'cancelling', hostOwnedStopIntentPatch(current, 'user'));
  const seams = observationSeams(fixture, incidentProof(fixture));
  await assert.rejects(reconcileRescueChildForPreparation({
    dataRoot: fixture.dataRoot,
    caller: fixture.caller,
    envelope: { version: 3, options: { resume: 'resume' }, continuationTarget: { agentPath: AGENT_PATH } },
    appServerOptions: {},
    dependencies: seams.dependencies,
  }), (/** @type {any} */ error) => {
    assert.equal(error.code, 'RESCUE_BINDING_INVALID', 'the planner canonical code surfaces whether or not recovery ran');
    assert.equal(error.cause?.code, 'RESCUE_BINDING_INVALID', 'the original lookup rejection stays attached');
    return true;
  });
  assert.equal(seams.clientCreations.length, 0, 'no settlement runs for a binding the planner would reject');
  const stored = await fixture.store.readJob(fixture.workspace, fixture.job.id);
  assert.equal(stored.status, 'cancelling');
  assert.equal(stored.stopIntent?.cause, 'user', 'the durable intent is untouched');
  assert.equal((await resolveForwardingRoute(fixture.dataRoot, fixture.workspace, SESSION, CHILD_TURN)).state, 'active');
});

test('a permission change between the capture and the stop writes supersedes the recovery without touching any record', async (t) => {
  const { reconcileRescueChildForPreparation } = await import('../scripts/lib/rescue-child-reconciliation.mjs');
  const fixture = await reconciliationFixture(t, { job: 'succeeded' });
  const proof = incidentProof(fixture);
  const seams = observationSeams(fixture, (call) => {
    if (call === 1) void mutateBindingRecord(fixture, (record) => ({ ...record, permissionMode: 'acceptEdits' }));
    return proof;
  });
  await assert.rejects(reconcileRescueChildForPreparation({
    dataRoot: fixture.dataRoot,
    caller: fixture.caller,
    envelope: { version: 3, options: { resume: 'resume' }, continuationTarget: { agentPath: AGENT_PATH } },
    appServerOptions: {},
    dependencies: seams.dependencies,
  }), (/** @type {any} */ error) => {
    assert.equal(error.code, 'RESCUE_CHILD_RECOVERY_SUPERSEDED');
    return true;
  });
  assert.equal(JSON.parse(await readFile(fixture.executorPath, 'utf8')).active, true, 'the executor record is never deactivated for a superseded recovery');
  assert.equal((await resolveForwardingRoute(fixture.dataRoot, fixture.workspace, SESSION, CHILD_TURN)).state, 'active', 'the route stays active');
  assert.equal(JSON.parse(await readFile(fixture.forwardPath, 'utf8')).active, true, 'the forwarding marker stays active');
});

test('an advanced binding currentJob between the capture and the stop writes supersedes the recovery', async (t) => {
  const { reconcileRescueChildForPreparation } = await import('../scripts/lib/rescue-child-reconciliation.mjs');
  const fixture = await reconciliationFixture(t, { job: 'succeeded' });
  const proof = incidentProof(fixture);
  const seams = observationSeams(fixture, (call) => {
    if (call === 1) {
      void (async () => {
        const successor = await fixture.store.reserveJob({ workspace: fixture.workspace, ownerSessionId: SESSION, ownerTurnId: 'successor-turn', command: 'rescue', readOnly: false, permissionSnapshot: { permissionMode: 'workspace-write' } });
        await mutateBindingRecord(fixture, (record) => ({ ...record, currentJobId: successor.id }));
      })();
    }
    return proof;
  });
  await assert.rejects(reconcileRescueChildForPreparation({
    dataRoot: fixture.dataRoot,
    caller: fixture.caller,
    envelope: { version: 3, options: { resume: 'resume' }, continuationTarget: { agentPath: AGENT_PATH } },
    appServerOptions: {},
    dependencies: seams.dependencies,
  }), { code: 'RESCUE_CHILD_RECOVERY_SUPERSEDED' });
  assert.equal(JSON.parse(await readFile(fixture.executorPath, 'utf8')).active, true, 'the successor operation is never deactivated by the old tuple');
  assert.equal((await resolveForwardingRoute(fixture.dataRoot, fixture.workspace, SESSION, CHILD_TURN)).state, 'active');
});

/** Rewrite the parent's binding partition record for this child under the partition's own validation. */
async function mutateBindingRecord(fixture, mutate) {
  const { rescueBindingPartitionKey, readRescueBindingPartitionFile } = await import('../scripts/lib/rescue-binding.mjs');
  const { resolveWorkspaceStorage } = await import('../scripts/lib/workspace.mjs');
  const { writeFile } = await import('node:fs/promises');
  const storage = await resolveWorkspaceStorage({ dataRoot: fixture.dataRoot, workspace: fixture.workspace });
  const expected = { parentSessionId: SESSION, workspace: storage.workspacePath };
  const path = join(storage.directory, `rescue-binding-session-${rescueBindingPartitionKey(expected)}.json`);
  const partition = await readRescueBindingPartitionFile(storage.directory, path, expected);
  const records = partition.records.map((/** @type {any} */ record) => record.key === partition.records[0].key ? mutate(record) : record);
  await writeFile(path, `${JSON.stringify({ ...partition, records }, null, 2)}\n`);
}

test('an epoch-less pre-lifecycle executor record fails closed before any Host read or write', async (t) => {
  const { reconcileRescueChildForPreparation } = await import('../scripts/lib/rescue-child-reconciliation.mjs');
  const fixture = await reconciliationFixture(t, { job: 'succeeded' });
  // Republish the executor record in the pre-lifecycle compat shape: no epoch pair.
  const executor = JSON.parse(await readFile(fixture.executorPath, 'utf8'));
  assert.equal(typeof executor.ownerLifecycleEpoch, 'string', 'the fixture executor initially carries its epoch');
  delete executor.ownerLifecycleEpoch;
  delete executor.ownerLifecycleEpochStartedAt;
  await writeFile(fixture.executorPath, `${JSON.stringify(executor, null, 2)}\n`);
  const seams = observationSeams(fixture, incidentProof(fixture));
  await assert.rejects(reconcileRescueChildForPreparation({
    dataRoot: fixture.dataRoot,
    caller: fixture.caller,
    envelope: { version: 3, options: { resume: 'resume' }, continuationTarget: { agentPath: AGENT_PATH } },
    appServerOptions: {},
    dependencies: seams.dependencies,
  }), (/** @type {any} */ error) => {
    assert.equal(error.code, 'RESCUE_CHILD_EVIDENCE_UNAVAILABLE', 'an unconstructible exact tuple is insufficient evidence, never a non-exact fallback');
    return true;
  });
  assert.equal(seams.hostReads.length, 0, 'no Host evidence is read without an exact tuple');
  assert.equal(JSON.parse(await readFile(fixture.executorPath, 'utf8')).active, true, 'the epoch-less record is untouched');
  assert.equal((await resolveForwardingRoute(fixture.dataRoot, fixture.workspace, SESSION, CHILD_TURN)).state, 'active');
});

test('a terminal job with outstanding execution cleanup blocks continuation until its duties are discharged', async (t) => {
  const { reconcileRescueChildForPreparation } = await import('../scripts/lib/rescue-child-reconciliation.mjs');
  const fixture = await reconciliationFixture(t, { job: 'succeeded', fencedReservation: true });
  assert.equal(fixture.job.rescueExecutionReservation?.workerLeaseId, '4'.repeat(64), 'the fixture carries the outstanding reservation');
  const seams = observationSeams(fixture, incidentProof(fixture));
  await assert.rejects(reconcileRescueChildForPreparation({
    dataRoot: fixture.dataRoot,
    caller: fixture.caller,
    envelope: { version: 3, options: { resume: 'resume' }, continuationTarget: { agentPath: AGENT_PATH } },
    appServerOptions: {},
    dependencies: seams.dependencies,
  }), (/** @type {any} */ error) => {
    assert.equal(error.code, 'RESCUE_CHILD_RECOVERY_PENDING');
    return true;
  });
  assert.equal(seams.hostReads.length, 1, 'the second Host proof never runs past the undischarged obligation');
  assert.equal(seams.clientCreations.length, 0, 'the terminal winner is never remotely controlled');
  const stored = await fixture.store.readJob(fixture.workspace, fixture.job.id);
  assert.equal(stored.status, 'succeeded', 'the winner is preserved');
  assert.equal(stored.rescueExecutionReservation?.workerLeaseId, '4'.repeat(64), 'the failed cleanup retains the durable reservation for the next bounded pass');
  assert.equal((await resolveForwardingRoute(fixture.dataRoot, fixture.workspace, SESSION, CHILD_TURN)).state, 'active', 'no child record is settled over an undischarged obligation');
  assert.equal(JSON.parse(await readFile(fixture.executorPath, 'utf8')).active, true);
});

test('concurrent duplicate recoveries reconcile idempotently without duplicate writers or a changed winner', async (t) => {
  const { reconcileRescueChildForPreparation } = await import('../scripts/lib/rescue-child-reconciliation.mjs');
  const fixture = await reconciliationFixture(t, { job: 'succeeded' });
  const first = observationSeams(fixture, incidentProof(fixture));
  const second = observationSeams(fixture, incidentProof(fixture));
  const outcomes = await Promise.all([
    reconcileRescueChildForPreparation({ dataRoot: fixture.dataRoot, caller: fixture.caller,
      envelope: { version: 3, options: { resume: 'resume' }, continuationTarget: { agentPath: AGENT_PATH } },
      appServerOptions: {}, dependencies: first.dependencies }).then((value) => value, (error) => error),
    reconcileRescueChildForPreparation({ dataRoot: fixture.dataRoot, caller: fixture.caller,
      envelope: { version: 3, options: { resume: 'resume' }, continuationTarget: { agentPath: AGENT_PATH } },
      appServerOptions: {}, dependencies: second.dependencies }).then((value) => value, (error) => error),
  ]);
  for (const outcome of outcomes) {
    // A concurrent loser may either reconcile idempotently or observe that the
    // other writer already unstuck the records; neither may corrupt state.
    assert.ok(outcome.kind === 'reconciled' || outcome.kind === 'not-needed', `both concurrent recoveries stay bounded (got ${JSON.stringify(outcome)})`);
    if (outcome.kind === 'reconciled') assert.equal(outcome.executionWorkspace, fixture.workspace);
  }
  const jobBefore = fixture.job;
  assert.deepEqual(await fixture.store.readJob(fixture.workspace, fixture.job.id), jobBefore, 'the terminal winner is unchanged');
  assert.equal(first.remoteStops.length + second.remoteStops.length, 0, 'no concurrent recovery remotely stops the terminal job');
  for (const seams of [first, second]) assert.ok(seams.hostReads.length <= 2, 'no concurrent recovery exceeds the two-read bound');
  assert.equal(first.hostReads.length + second.hostReads.length >= 2, true, 'the reconciling recovery still brackets the settlement with two exact Host reads');
  assert.equal((await resolveForwardingRoute(fixture.dataRoot, fixture.workspace, SESSION, CHILD_TURN)).state, 'stopped');
  const executor = JSON.parse(await readFile(fixture.executorPath, 'utf8'));
  assert.equal(executor.active, false);
  assert.deepEqual(await resolveRoutedStoppedForwardingExecutor(fixture.dataRoot, fixture.workspace, AGENT), { executor, executionWorkspace: fixture.workspace });
});

test('a caller interruption during the second Host proof aborts the recovery instead of failing closed silently', async (t) => {
  const { reconcileRescueChildForPreparation } = await import('../scripts/lib/rescue-child-reconciliation.mjs');
  const fixture = await reconciliationFixture(t, { job: 'succeeded' });
  const proof = incidentProof(fixture);
  const controller = new AbortController();
  const interruption = () => new PluginError('JOB_INTERRUPTED', 'Recovery interrupted.', { category: 'interruption', remedy: 'Retry.' });
  let calls = 0;
  const seams = observationSeams(fixture, () => {
    calls += 1;
    if (calls === 2) {
      controller.abort(interruption());
      throw interruption();
    }
    return proof;
  });
  await assert.rejects(reconcileRescueChildForPreparation({
    dataRoot: fixture.dataRoot,
    caller: fixture.caller,
    envelope: { version: 3, options: { resume: 'resume' }, continuationTarget: { agentPath: AGENT_PATH } },
    appServerOptions: {},
    signal: controller.signal,
    dependencies: seams.dependencies,
  }), (/** @type {any} */ error) => {
    assert.equal(error.code, 'JOB_INTERRUPTED', 'a genuinely upstream interruption propagates untouched');
    return true;
  });
  assert.equal(calls, 2);
  assert.equal((await resolveForwardingRoute(fixture.dataRoot, fixture.workspace, SESSION, CHILD_TURN)).state, 'active', 'an interrupted recovery writes nothing');
  assert.equal(JSON.parse(await readFile(fixture.executorPath, 'utf8')).active, true);
});

test('maps its own expired budget onto a bounded outcome instead of leaking raw aborts', async (t) => {
  const { reconcileRescueChildForPreparation } = await import('../scripts/lib/rescue-child-reconciliation.mjs');
  const fixture = await reconciliationFixture(t, { job: 'succeeded' });
  const seams = observationSeams(fixture, incidentProof(fixture));
  const probes = [];
  const discoveryReads = [];
  // A clock that jumps past the deadline right after the coordinator captures
  // it: every later stage window must observe the expired shared budget.
  const capturedAt = Date.now();
  let clockReads = 0;
  const budgetSeams = {
    ...seams.dependencies,
    now: () => { clockReads += 1; return clockReads === 1 ? capturedAt : capturedAt + 60_000; },
    listChildren: async (...args) => { discoveryReads.push(args); return seams.dependencies.listChildren(...args); },
    resolveActiveExecutor: async (...args) => { probes.push(args); return seams.dependencies.resolveActiveExecutor(...args); },
  };
  const outcome = await reconcileRescueChildForPreparation({
    dataRoot: fixture.dataRoot,
    caller: fixture.caller,
    envelope: { version: 3, options: { resume: 'resume' }, continuationTarget: { agentPath: AGENT_PATH } },
    appServerOptions: {},
    dependencies: budgetSeams,
  }).then((value) => value, (error) => error);
  assert.equal(outcome.code, 'RESCUE_CHILD_EVIDENCE_UNAVAILABLE', `a budget expiry is a bounded evidence outcome, never a raw leak (got ${JSON.stringify(outcome)})`);
  assert.match(outcome.message, /budget expired/);
  assert.equal(discoveryReads.length, 0, 'no stage — discovery included — may start past an expired budget');
  assert.equal(probes.length, 0, 'no stage may start past an expired budget');
  assert.equal(seams.hostReads.length, 0);
  assert.equal(JSON.parse(await readFile(fixture.executorPath, 'utf8')).active, true, 'no record is touched after the budget expired');
});

test('maps a budget expiry during the second Host proof onto the bounded pending outcome', async (t) => {
  const { reconcileRescueChildForPreparation } = await import('../scripts/lib/rescue-child-reconciliation.mjs');
  const fixture = await reconciliationFixture(t, { job: 'succeeded' });
  const proof = incidentProof(fixture);
  const hostReads = [];
  const seams = observationSeams(fixture, undefined);
  const interruption = () => new PluginError('JOB_INTERRUPTED', 'Codex app-server operation was interrupted.', { category: 'interruption', remedy: 'Retry the operation.' });
  const budgetSeams = {
    ...seams.dependencies,
    readChildTurnEvidence: async (childId, parentId, expectedTurnId, window) => {
      hostReads.push({ childId, parentId, expectedTurnId });
      if (hostReads.length === 1) return proof;
      assert.equal(typeof window?.timeoutMs, 'number', 'the Host proof draws the shared stage window');
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(proof), 60_000);
        window.signal.addEventListener('abort', () => { clearTimeout(timer); reject(interruption()); }, { once: true });
      });
    },
  };
  const jobBefore = await fixture.store.readJob(fixture.workspace, fixture.job.id);
  const outcome = await reconcileRescueChildForPreparation({
    dataRoot: fixture.dataRoot,
    caller: fixture.caller,
    envelope: { version: 3, options: { resume: 'resume' }, continuationTarget: { agentPath: AGENT_PATH } },
    appServerOptions: {},
    dependencies: budgetSeams,
  }).then((value) => value, (error) => error);
  assert.equal(outcome.code, 'RESCUE_CHILD_RECOVERY_PENDING', `the budget expiry during the re-proof stays bounded (got ${JSON.stringify(outcome)})`);
  assert.match(outcome.message, /budget expired/);
  assert.equal(hostReads.length, 2, 'the second proof was attempted inside the budget');
  assert.deepEqual(await fixture.store.readJob(fixture.workspace, fixture.job.id), jobBefore, 'the winner is untouched');
  assert.equal((await resolveForwardingRoute(fixture.dataRoot, fixture.workspace, SESSION, CHILD_TURN)).state, 'active', 'no stop-state write escapes a budget expiry');
}, { timeout: 15_000 });

test('bounds the business settlement stage and maps its budget expiry onto the pending outcome', async (t) => {
  const { reconcileRescueChildForPreparation } = await import('../scripts/lib/rescue-child-reconciliation.mjs');
  const { settleRescueChildOwnedJob } = await import('../scripts/lib/recovery.mjs');
  const fixture = await reconciliationFixture(t, { job: 'running' });
  const seams = observationSeams(fixture, incidentProof(fixture));
  let settlements = 0;
  const budgetSeams = {
    ...seams.dependencies,
    settleOwnedJob: async (input, jobId) => { settlements += 1; return settleRescueChildOwnedJob(input, jobId); },
    createClient: async () => ({
      // The control channel never answers within the recovery budget: only the
      // stage window can end the wait. The unref'd fallback keeps the test
      // process able to drain even while the coordinator is unbounded.
      readSession: () => new Promise((resolve) => { const timer = setTimeout(resolve, 30_000); timer.unref?.(); }),
      stopSession: async () => { seams.remoteStops.push(true); },
      close: async () => {},
    }),
  };
  const startedAt = Date.now();
  const outcome = await reconcileRescueChildForPreparation({
    dataRoot: fixture.dataRoot,
    caller: fixture.caller,
    envelope: { version: 3, options: { resume: 'resume' }, continuationTarget: { agentPath: AGENT_PATH } },
    appServerOptions: {},
    dependencies: budgetSeams,
  }).then((value) => value, (error) => error);
  assert.equal(outcome.code, 'RESCUE_CHILD_RECOVERY_PENDING', `an unsettled budget expiry stays bounded (got ${JSON.stringify(outcome)})`);
  assert.match(outcome.message, /budget expired/);
  assert.ok(Date.now() - startedAt < 9_000, `the hanging settlement is bounded by the shared budget (took ${Date.now() - startedAt}ms)`);
  assert.equal(settlements, 1, 'at most one business reconciliation runs');
  const stored = await fixture.store.readJob(fixture.workspace, fixture.job.id);
  assert.equal(['running', 'cancelling'].includes(stored.status), true, 'the job keeps a coherent durable state');
  assert.equal(stored.stopIntent === undefined || stored.stopIntent.cause === 'host-coordination-loss', true);
  assert.equal((await resolveForwardingRoute(fixture.dataRoot, fixture.workspace, SESSION, CHILD_TURN)).state, 'active', 'no stop-state write escapes');
}, { timeout: 15_000 });

test('propagates a genuine upstream abort untouched instead of mapping it to a recovery outcome', async (t) => {
  const { reconcileRescueChildForPreparation } = await import('../scripts/lib/rescue-child-reconciliation.mjs');
  const fixture = await reconciliationFixture(t, { job: 'succeeded' });
  const controller = new AbortController();
  const interruption = () => new PluginError('JOB_INTERRUPTED', 'Recovery interrupted.', { category: 'interruption', remedy: 'Retry.' });
  const hostReads = [];
  const seams = observationSeams(fixture, undefined);
  const abortedSeams = {
    ...seams.dependencies,
    readChildTurnEvidence: async () => {
      hostReads.push(true);
      controller.abort(interruption());
      throw interruption();
    },
  };
  await assert.rejects(reconcileRescueChildForPreparation({
    dataRoot: fixture.dataRoot,
    caller: fixture.caller,
    envelope: { version: 3, options: { resume: 'resume' }, continuationTarget: { agentPath: AGENT_PATH } },
    appServerOptions: {},
    signal: controller.signal,
    dependencies: abortedSeams,
  }), (/** @type {any} */ error) => {
    assert.equal(error.code, 'JOB_INTERRUPTED', 'the upstream interruption propagates');
    return true;
  });
  assert.equal(hostReads.length, 1);
  assert.equal(JSON.parse(await readFile(fixture.executorPath, 'utf8')).active, true, 'an upstream abort writes nothing');
});

test('rejects Host evidence whose agentPath, agentRole, or cwd diverges from the binding on the first read', async (t) => {
  const { reconcileRescueChildForPreparation } = await import('../scripts/lib/rescue-child-reconciliation.mjs');
  const fixture = await reconciliationFixture(t, { job: 'succeeded' });
  for (const [label, mutate] of [
    ['agentPath', (child) => ({ ...child, agentPath: '/root/zcode_rescue_task_other' })],
    ['agentRole', (child) => ({ ...child, agentRole: 'default' })],
    ['cwd', (child) => ({ ...child, cwd: '/private/other/workspace' })],
  ]) await t.test(`divergent ${label}`, async () => {
    const divergentProof = { ...incidentProof(fixture), child: mutate(incidentProof(fixture).child) };
    const seams = observationSeams(fixture, divergentProof);
    await assert.rejects(reconcileRescueChildForPreparation({
      dataRoot: fixture.dataRoot,
      caller: fixture.caller,
      envelope: { version: 3, options: { resume: 'resume' }, continuationTarget: { agentPath: AGENT_PATH } },
      appServerOptions: {},
      dependencies: seams.dependencies,
    }), (/** @type {any} */ error) => {
      assert.equal(error.code, 'RESCUE_CHILD_EVIDENCE_UNAVAILABLE');
      assert.equal(error.message, 'Codex child evidence did not match the expected Rescue binding.');
      return true;
    });
    assert.equal(seams.hostReads.length, 1);
    assert.equal(JSON.parse(await readFile(fixture.executorPath, 'utf8')).active, true, `no record is touched for a divergent ${label}`);
    assert.equal((await resolveForwardingRoute(fixture.dataRoot, fixture.workspace, SESSION, CHILD_TURN)).state, 'active');
  });
});

test('rejects Host evidence whose binding identity diverges on the second read with zero stop-state writes', async (t) => {
  const { reconcileRescueChildForPreparation } = await import('../scripts/lib/rescue-child-reconciliation.mjs');
  const fixture = await reconciliationFixture(t, { job: 'succeeded' });
  const proof = incidentProof(fixture);
  const divergent = { ...proof, child: { ...proof.child, agentPath: '/root/zcode_rescue_task_other' } };
  const seams = observationSeams(fixture, (call) => call === 1 ? proof : divergent);
  await assert.rejects(reconcileRescueChildForPreparation({
    dataRoot: fixture.dataRoot,
    caller: fixture.caller,
    envelope: { version: 3, options: { resume: 'resume' }, continuationTarget: { agentPath: AGENT_PATH } },
    appServerOptions: {},
    dependencies: seams.dependencies,
  }), (/** @type {any} */ error) => {
    assert.equal(error.code, 'RESCUE_CHILD_EVIDENCE_UNAVAILABLE', 'the second read must also match the binding before any stop write');
    assert.equal(error.message, 'Codex child evidence did not match the expected Rescue binding.');
    return true;
  });
  assert.equal(seams.hostReads.length, 2);
  assert.equal(JSON.parse(await readFile(fixture.executorPath, 'utf8')).active, true, 'the executor is never deactivated on a divergent re-proof');
  assert.equal((await resolveForwardingRoute(fixture.dataRoot, fixture.workspace, SESSION, CHILD_TURN)).state, 'active');
  assert.equal(JSON.parse(await readFile(fixture.forwardPath, 'utf8')).active, true);
});

test('a changed parent epoch across the executor, binding, and job join supersedes the recovery', async (t) => {
  const { reconcileRescueChildForPreparation } = await import('../scripts/lib/rescue-child-reconciliation.mjs');
  const fixture = await reconciliationFixture(t, { job: 'succeeded' });
  const executor = JSON.parse(await readFile(fixture.executorPath, 'utf8'));
  // A coherently republished executor under a DIFFERENT Host lifecycle epoch:
  // the record shape stays valid, but it no longer names the job's epoch.
  const resumedStartedAt = '2026-09-01T00:00:00.000Z';
  await writeFile(fixture.executorPath, `${JSON.stringify({ ...executor,
    ownerLifecycleEpoch: hostLifecycleEpoch(SESSION, resumedStartedAt), ownerLifecycleEpochStartedAt: resumedStartedAt }, null, 2)}\n`);
  const seams = observationSeams(fixture, incidentProof(fixture));
  await assert.rejects(reconcileRescueChildForPreparation({
    dataRoot: fixture.dataRoot,
    caller: fixture.caller,
    envelope: { version: 3, options: { resume: 'resume' }, continuationTarget: { agentPath: AGENT_PATH } },
    appServerOptions: {},
    dependencies: seams.dependencies,
  }), { code: 'RESCUE_CHILD_RECOVERY_SUPERSEDED' });
  assert.equal(seams.hostReads.length, 0, 'the join is validated before any Host evidence is read');
  assert.equal(JSON.parse(await readFile(fixture.executorPath, 'utf8')).active, true);
  assert.equal((await resolveForwardingRoute(fixture.dataRoot, fixture.workspace, SESSION, CHILD_TURN)).state, 'active');
});

test('rejects two stuck children with the preserved ambiguity error instead of choosing one', async (t) => {
  const { reconcileRescueChildForPreparation } = await import('../scripts/lib/rescue-child-reconciliation.mjs');
  const fixture = await reconciliationFixture(t, { job: 'succeeded' });
  await markForwarding(fixture.dataRoot, { ...fixture.start, turn_id: `${CHILD_TURN}-second`, agent_id: `${AGENT}-second` }, await createIdentityStore({ dataRoot: fixture.dataRoot }).resolveActiveTurn({ sessionId: SESSION, workspace: fixture.workspace, workspaceBinding: 'claim' }));
  const seams = observationSeams(fixture, incidentProof(fixture));
  seams.dependencies.listChildren = async () => [
    { id: AGENT, parentThreadId: SESSION, agentPath: AGENT_PATH, agentRole: 'zcode-rescue', cwd: fixture.workspace, status: { type: 'notLoaded' }, createdAt: 1, updatedAt: 2 },
    { id: `${AGENT}-second`, parentThreadId: SESSION, agentPath: '/root/zcode_rescue_task_second', agentRole: 'zcode-rescue', cwd: fixture.workspace, status: { type: 'notLoaded' }, createdAt: 1, updatedAt: 2 },
  ];
  await assert.rejects(reconcileRescueChildForPreparation({
    dataRoot: fixture.dataRoot,
    caller: fixture.caller,
    envelope: { version: 3, options: { resume: 'resume' }, continuationTarget: null },
    appServerOptions: {},
    dependencies: seams.dependencies,
  }), { code: 'RESCUE_CHILD_AMBIGUOUS' });
  assert.equal((await resolveForwardingRoute(fixture.dataRoot, fixture.workspace, SESSION, CHILD_TURN)).state, 'active');
});

test('skips candidates whose executor records are absent or not stuck and settles only the exact stuck child', async (t) => {
  const { reconcileRescueChildForPreparation } = await import('../scripts/lib/rescue-child-reconciliation.mjs');
  const fixture = await reconciliationFixture(t, { job: 'succeeded' });
  const seams = observationSeams(fixture, incidentProof(fixture));
  seams.dependencies.listChildren = async () => [
    { id: 'unrecorded-sibling', parentThreadId: SESSION, agentPath: '/root/zcode_rescue_task_other', agentRole: 'zcode-rescue', cwd: fixture.workspace, status: { type: 'notLoaded' }, createdAt: 1, updatedAt: 2 },
    { id: AGENT, parentThreadId: SESSION, agentPath: AGENT_PATH, agentRole: 'zcode-rescue', cwd: fixture.workspace, status: { type: 'notLoaded' }, createdAt: 1, updatedAt: 2 },
  ];
  const outcome = await reconcileRescueChildForPreparation({
    dataRoot: fixture.dataRoot,
    caller: fixture.caller,
    envelope: { version: 3, options: { resume: 'resume' }, continuationTarget: null },
    appServerOptions: {},
    dependencies: seams.dependencies,
  });
  assert.deepEqual(outcome, { kind: 'reconciled', executionWorkspace: fixture.workspace }, 'the absent sibling is skipped and the stuck child reconciles');
  assert.equal((await resolveForwardingRoute(fixture.dataRoot, fixture.workspace, SESSION, CHILD_TURN)).state, 'stopped');
});

test('preserves the discovery error mapping exactly as the planner raises it', async (t) => {
  const { reconcileRescueChildForPreparation } = await import('../scripts/lib/rescue-child-reconciliation.mjs');
  const fixture = await reconciliationFixture(t, { job: 'succeeded' });
  const base = {
    dataRoot: fixture.dataRoot,
    caller: fixture.caller,
    envelope: { version: 3, options: { resume: 'resume' }, continuationTarget: { agentPath: AGENT_PATH } },
    appServerOptions: {},
  };
  const metadataInvalid = new PluginError('CODEX_CHILD_METADATA_INVALID', 'Codex returned invalid persisted child metadata.', { category: 'protocol', remedy: 'Restart or upgrade Codex, then retry the Rescue request.' });
  await assert.rejects(reconcileRescueChildForPreparation({ ...base,
    dependencies: { ...observationSeams(fixture, incidentProof(fixture)).dependencies, listChildren: async () => { throw metadataInvalid; } },
  }), (/** @type {any} */ error) => error.code === 'CODEX_CHILD_METADATA_INVALID' && error === metadataInvalid, 'the metadata rejection is preserved untouched');
  await assert.rejects(reconcileRescueChildForPreparation({ ...base,
    dependencies: { ...observationSeams(fixture, incidentProof(fixture)).dependencies, listChildren: async () => { throw new Error('codex exploded'); } },
  }), { code: 'CODEX_CHILD_DISCOVERY_FAILED' });
  await assert.rejects(reconcileRescueChildForPreparation({ ...base,
    dependencies: { ...observationSeams(fixture, incidentProof(fixture)).dependencies, listChildren: async () => 'not-an-array' },
  }), { code: 'CODEX_CHILD_DISCOVERY_FAILED' }, 'a malformed discovery result cannot select a target');
  assert.deepEqual(await reconcileRescueChildForPreparation({ ...base,
    dependencies: { ...observationSeams(fixture, incidentProof(fixture)).dependencies, listChildren: async () => [] },
  }), { kind: 'not-needed' }, 'an empty discovery is legitimate; the planner flow stays untouched');
});

test('validates the recovery request against the shared planner envelope rules and the dependency allowlist', async (t) => {
  const { reconcileRescueChildForPreparation } = await import('../scripts/lib/rescue-child-reconciliation.mjs');
  const fixture = await reconciliationFixture(t, { job: 'succeeded' });
  const base = { dataRoot: fixture.dataRoot, caller: fixture.caller, appServerOptions: {}, dependencies: observationSeams(fixture, incidentProof(fixture)).dependencies };
  // A version-1 envelope is valid (and fresh skips entirely).
  assert.deepEqual(await reconcileRescueChildForPreparation({ ...base, envelope: { version: 1, options: { resume: 'fresh' } } }), { kind: 'not-needed' });
  const invalid = async (envelope, dependencies = base.dependencies) => assert.rejects(
    reconcileRescueChildForPreparation({ ...base, envelope, dependencies }), { code: 'RESCUE_ROUTE_INVALID' });
  await invalid({ version: 1, options: { resume: 'resume' }, continuationTarget: null }, base.dependencies, 'v1 cannot carry a continuation target');
  await invalid({ version: 2, options: { resume: 'resume' }, continuationTarget: { agentPath: AGENT_PATH } }, base.dependencies, 'a v2 pair target needs the child id');
  await invalid({ version: 2, options: { resume: 'fresh' }, continuationTarget: { agentPath: AGENT_PATH, childId: AGENT } }, base.dependencies, 'a non-null target requires resume');
  await invalid({ version: 3, options: { resume: 'resume' }, continuationTarget: { agentPath: AGENT_PATH, childId: AGENT } }, base.dependencies, 'a v3 path target admits no child id');
  await invalid({ version: 3, options: { resume: 'resume' }, continuationTarget: { agentPath: '/root/../escape' } }, base.dependencies, 'agent paths stay canonical');
  await invalid(undefined, base.dependencies, 'an envelope is required');
  await assert.rejects(reconcileRescueChildForPreparation({ ...base, envelope: { version: 3, options: { resume: 'resume' }, continuationTarget: { agentPath: AGENT_PATH } }, caller: { ...fixture.caller, permissionMode: 'superuser' } }), { code: 'RESCUE_ROUTE_INVALID' }, 'the permission mode stays validated');
  await assert.rejects(reconcileRescueChildForPreparation({ ...base, envelope: { version: 3, options: { resume: 'resume' }, continuationTarget: { agentPath: AGENT_PATH } }, dependencies: { ...base.dependencies, unknownSeam: async () => {} } }), { code: 'RESCUE_ROUTE_INVALID' }, 'unknown dependency keys are rejected');
  await assert.rejects(reconcileRescueChildForPreparation({ ...base, envelope: { version: 3, options: { resume: 'resume' }, continuationTarget: { agentPath: AGENT_PATH } }, dependencies: { ...base.dependencies, readReceipt: 'not-a-function' } }), { code: 'RESCUE_ROUTE_INVALID' }, 'dependency seams must be functions');
  await assert.rejects(reconcileRescueChildForPreparation({ ...base, envelope: { version: 3, options: { resume: 'resume' }, continuationTarget: { agentPath: AGENT_PATH } }, dependencies: { ...base.dependencies, store: 'not-an-object' } }), { code: 'RESCUE_ROUTE_INVALID' }, 'the injected store must be an object');
});

test('a plain rejection on the second Host proof lands on the bounded pending outcome', async (t) => {
  const { reconcileRescueChildForPreparation } = await import('../scripts/lib/rescue-child-reconciliation.mjs');
  const fixture = await reconciliationFixture(t, { job: 'succeeded' });
  const proof = incidentProof(fixture);
  const plainFailure = new PluginError('CODEX_THREAD_READ_FAILED', 'Codex could not read the requested thread.', { category: 'configuration', remedy: 'Confirm the Codex thread ID is persisted.' });
  const seams = observationSeams(fixture, (call) => {
    if (call === 2) throw plainFailure;
    return proof;
  });
  await assert.rejects(reconcileRescueChildForPreparation({
    dataRoot: fixture.dataRoot,
    caller: fixture.caller,
    envelope: { version: 3, options: { resume: 'resume' }, continuationTarget: { agentPath: AGENT_PATH } },
    appServerOptions: {},
    dependencies: seams.dependencies,
  }), (/** @type {any} */ error) => {
    assert.equal(error.code, 'RESCUE_CHILD_RECOVERY_PENDING');
    assert.equal(error.cause, plainFailure, 'the redacted adapter rejection stays attached as the cause');
    return true;
  });
  assert.equal(JSON.parse(await readFile(fixture.executorPath, 'utf8')).active, true);
});

test('concurrent recovery over nonterminal foreground work waits inside the shared budget and both calls reconcile', async (t) => {
  const { reconcileRescueChildForPreparation } = await import('../scripts/lib/rescue-child-reconciliation.mjs');
  const { settleRescueChildOwnedJob } = await import('../scripts/lib/recovery.mjs');
  const fixture = await reconciliationFixture(t, { job: 'running' });
  const proof = incidentProof(fixture);
  // Both settlements are held on a shared start line so their job-cancellation
  // lock attempts contend, and the winner's remote reread is slowed inside the
  // lock: with the remaining budget as the lock timeout the loser waits and
  // then converges on the durable winner; a fail-fast lock would bail pending.
  let arrived = 0; let releaseStartLine; const startLine = new Promise((resolve) => { releaseStartLine = resolve; });
  const makeSeams = () => {
    const seams = observationSeams(fixture, proof, {
      readSnapshot: (state) => {
        if (!state.stopped) return undefined;
        return new Promise((resolve) => { const timer = setTimeout(() => resolve(succeededReread('the rescue finished on its own')), 300); timer.unref?.(); });
      },
    });
    return {
      seams,
      dependencies: {
        ...seams.dependencies,
        settleOwnedJob: async (input, jobId) => {
          arrived += 1;
          if (arrived === 2) releaseStartLine();
          await startLine;
          return settleRescueChildOwnedJob(input, jobId);
        },
      },
    };
  };
  const first = makeSeams();
  const second = makeSeams();
  const run = (seams) => reconcileRescueChildForPreparation({
    dataRoot: fixture.dataRoot,
    caller: fixture.caller,
    envelope: { version: 3, options: { resume: 'resume' }, continuationTarget: { agentPath: AGENT_PATH } },
    appServerOptions: {},
    dependencies: seams.dependencies,
  }).then((value) => value, (error) => error);
  const startedAt = Date.now();
  const outcomes = await Promise.all([run(first), run(second)]);
  assert.ok(Date.now() - startedAt < 9_000, `both concurrent recoveries stay bounded (took ${Date.now() - startedAt}ms)`);
  for (const outcome of outcomes) {
    assert.ok(outcome.kind === 'reconciled', `each concurrent recovery reconciles within the shared budget (got ${JSON.stringify(outcome)})`);
    assert.equal(outcome.executionWorkspace, fixture.workspace);
  }
  const stored = await fixture.store.readJob(fixture.workspace, fixture.job.id);
  assert.equal(stored.status, 'succeeded', 'the natural-success winner is durable exactly once');
  assert.equal(first.seams.remoteStops.length + second.seams.remoteStops.length, 1, 'exactly one exact remote stop is issued across both calls');
  assert.equal((await resolveForwardingRoute(fixture.dataRoot, fixture.workspace, SESSION, CHILD_TURN)).state, 'stopped');
}, { timeout: 15_000 });


test('no stage starts past an expired budget, binding revalidation included', async (t) => {
  const { reconcileRescueChildForPreparation } = await import('../scripts/lib/rescue-child-reconciliation.mjs');
  const fixture = await reconciliationFixture(t, { job: 'succeeded' });
  const proof = incidentProof(fixture);
  const probes = [];
  const bindingLookups = [];
  // The clock stays real until the probe stage runs, then jumps past the
  // deadline: the probe may complete, but every later stage — the binding
  // lookup first — must refuse to start on the expired shared budget.
  const realNow = Date.now;
  let expired = false;
  const budgetSeams = {
    ...observationSeams(fixture, proof).dependencies,
    now: () => expired ? realNow() + 60_000 : realNow(),
    resolveActiveExecutor: async (dataRoot, ambientWorkspace, agentId, window) => {
      expired = true;
      probes.push([dataRoot, ambientWorkspace, agentId]);
      return resolveRoutedForwardingExecutor(dataRoot, ambientWorkspace, agentId, window);
    },
    store: {
      resolveRescueBindingForResume: async (lookup) => { bindingLookups.push(lookup); throw new Error('the binding lookup must never start past an expired budget'); },
    },
  };
  const outcome = await reconcileRescueChildForPreparation({
    dataRoot: fixture.dataRoot,
    caller: fixture.caller,
    envelope: { version: 3, options: { resume: 'resume' }, continuationTarget: { agentPath: AGENT_PATH } },
    appServerOptions: {},
    dependencies: budgetSeams,
  }).then((value) => value, (error) => error);
  assert.equal(outcome.code, 'RESCUE_CHILD_EVIDENCE_UNAVAILABLE', `the stage after expiry lands on the bounded evidence outcome (got ${JSON.stringify(outcome)} ${String(outcome?.message)})`);
  assert.match(outcome.message, /budget expired/);
  assert.equal(probes.length, 1, 'the probe that started inside the budget completes');
  assert.equal(bindingLookups.length, 0, 'the binding stage never starts past an expired budget');
  assert.equal(JSON.parse(await readFile(fixture.executorPath, 'utf8')).active, true);
});

test('a budget expiry during the receipt stage surfaces the bounded outcome instead of a fabricated no-receipt path', async (t) => {
  const { reconcileRescueChildForPreparation } = await import('../scripts/lib/rescue-child-reconciliation.mjs');
  const { settleRescueChildOwnedJob } = await import('../scripts/lib/recovery.mjs');
  const fixture = await reconciliationFixture(t, { job: 'running' });
  const seams = observationSeams(fixture, incidentProof(fixture));
  let settlements = 0;
  const budgetSeams = {
    ...seams.dependencies,
    settleOwnedJob: async (input, jobId) => { settlements += 1; return settleRescueChildOwnedJob(input, jobId); },
    // The receipt read never answers within the shared budget; the unref'd
    // fallback keeps the test process able to drain while the stage waits.
    readReceipt: () => new Promise((resolve) => { const timer = setTimeout(() => resolve(null), 30_000); timer.unref?.(); }),
  };
  const startedAt = Date.now();
  const outcome = await reconcileRescueChildForPreparation({
    dataRoot: fixture.dataRoot,
    caller: fixture.caller,
    envelope: { version: 3, options: { resume: 'resume' }, continuationTarget: { agentPath: AGENT_PATH } },
    appServerOptions: {},
    dependencies: budgetSeams,
  }).then((value) => value, (error) => error);
  assert.ok(Date.now() - startedAt < 9_000, `the hanging receipt read is bounded by the shared budget (took ${Date.now() - startedAt}ms)`);
  assert.equal(outcome.code, 'RESCUE_CHILD_EVIDENCE_UNAVAILABLE', `the receipt-stage budget expiry surfaces as the bounded outcome (got ${JSON.stringify(outcome)} ${String(outcome?.message)})`);
  assert.match(outcome.message, /budget expired/, 'the bounded outcome must not be swallowed into a fabricated no-receipt path');
  assert.equal(settlements, 0, 'no business reconciliation runs on an expired receipt stage');
  assert.equal(seams.remoteStops.length, 0, 'no remote stop is issued past the expired budget');
  assert.equal((await resolveForwardingRoute(fixture.dataRoot, fixture.workspace, SESSION, CHILD_TURN)).state, 'active');
}, { timeout: 15_000 });

test('resumes this recovery own partially stopped tuple: stopped route, active executor', async (t) => {
  const { reconcileRescueChildForPreparation } = await import('../scripts/lib/rescue-child-reconciliation.mjs');
  const fixture = await reconciliationFixture(t, { job: 'succeeded' });
  // The coordinator's own prior pass died after its origin stage: the stopped
  // route and inactive forwarding marker are durable, the executor is not yet
  // deactivated — the exact partial state the advertised retry must finish.
  const route = JSON.parse(await readFile(fixture.routePath, 'utf8'));
  await writeFile(fixture.routePath, `${JSON.stringify({ ...route, state: 'stopped' }, null, 2)}\n`);
  const forward = JSON.parse(await readFile(fixture.forwardPath, 'utf8'));
  await writeFile(fixture.forwardPath, `${JSON.stringify({ ...forward, active: false }, null, 2)}\n`);
  assert.equal(JSON.parse(await readFile(fixture.executorPath, 'utf8')).active, true, 'the fixture models the partial state: the executor is still active');
  assert.equal((await resolveForwardingRoute(fixture.dataRoot, fixture.workspace, SESSION, CHILD_TURN)).state, 'stopped');
  const seams = observationSeams(fixture, incidentProof(fixture));
  const outcome = await reconcileRescueChildForPreparation({
    dataRoot: fixture.dataRoot,
    caller: fixture.caller,
    envelope: { version: 3, options: { resume: 'resume' }, continuationTarget: { agentPath: AGENT_PATH } },
    appServerOptions: {},
    dependencies: seams.dependencies,
  });
  assert.deepEqual(outcome, { kind: 'reconciled', executionWorkspace: fixture.workspace }, 'the retry finishes the same tuple partial writes');
  const executor = JSON.parse(await readFile(fixture.executorPath, 'utf8'));
  assert.equal(executor.active, false, 'the executor is deactivated by the retry');
  assert.equal((await resolveForwardingRoute(fixture.dataRoot, fixture.workspace, SESSION, CHILD_TURN)).state, 'stopped');
  assert.deepEqual(await resolveRoutedStoppedForwardingExecutor(fixture.dataRoot, fixture.workspace, AGENT), { executor, executionWorkspace: fixture.workspace }, 'the existing stopped lookup passes');
  assert.equal(seams.remoteStops.length, 0, 'the terminal job is never remotely stopped');
  assert.equal(seams.hostReads.length, 2, 'the partial resume runs the same full pipeline');
});

test('a partial state belonging to a different tuple keeps skipping without writes', async (t) => {
  const { reconcileRescueChildForPreparation } = await import('../scripts/lib/rescue-child-reconciliation.mjs');
  const fixture = await reconciliationFixture(t, { job: 'succeeded' });
  const route = JSON.parse(await readFile(fixture.routePath, 'utf8'));
  await writeFile(fixture.routePath, `${JSON.stringify({ ...route, state: 'stopped' }, null, 2)}\n`);
  const forward = JSON.parse(await readFile(fixture.forwardPath, 'utf8'));
  await writeFile(fixture.forwardPath, `${JSON.stringify({ ...forward, active: false }, null, 2)}\n`);
  // A successor republished the shared executor file for a NEW child turn: the
  // partial state no longer belongs to the captured tuple's identity.
  const executor = JSON.parse(await readFile(fixture.executorPath, 'utf8'));
  const successorExecutor = { ...executor, childTurnId: `${CHILD_TURN}-successor`, parentTurnId: `${SPAWN_TURN}-successor` };
  await writeFile(fixture.executorPath, `${JSON.stringify(successorExecutor, null, 2)}\n`);
  const seams = observationSeams(fixture, incidentProof(fixture));
  const outcome = await reconcileRescueChildForPreparation({
    dataRoot: fixture.dataRoot,
    caller: fixture.caller,
    envelope: { version: 3, options: { resume: 'resume' }, continuationTarget: { agentPath: AGENT_PATH } },
    appServerOptions: {},
    dependencies: seams.dependencies,
  });
  assert.deepEqual(outcome, { kind: 'not-needed' }, 'a foreign partial state is never resumed');
  assert.equal(seams.hostReads.length, 0, 'no Host evidence is read for a foreign tuple');
  assert.deepEqual(JSON.parse(await readFile(fixture.executorPath, 'utf8')), successorExecutor, 'the successor executor bytes are unchanged');
  assert.equal(JSON.parse(await readFile(fixture.forwardPath, 'utf8')).active, false, 'the foreign partial forwarding marker is untouched');
});

test('a parent generation advanced between capture and the stop stage supersedes the recovery with zero stop writes', async (t) => {
  const { reconcileRescueChildForPreparation } = await import('../scripts/lib/rescue-child-reconciliation.mjs');
  const fixture = await reconciliationFixture(t, { job: 'succeeded' });
  const identity = createIdentityStore({ dataRoot: fixture.dataRoot });
  const proof = incidentProof(fixture);
  const seams = observationSeams(fixture, proof);
  const baseEvidence = seams.dependencies.readChildTurnEvidence;
  seams.dependencies.readChildTurnEvidence = async (/** @type {any} */ ...args) => {
    const result = await baseEvidence(...args);
    if (seams.hostReads.length === 1) {
      // The parent advances to another turn while the recovery is in flight.
      await identity.beginCallerTurn({ sessionId: SESSION, turnId: `${RETRY_TURN}-successor`, workspace: fixture.workspace, permissionMode: 'workspace-write', prompt: 'next turn', sessionStartedAt: SESSION_STARTED_AT, sessionSource: 'startup', lifecycleResult: true });
    }
    return result;
  };
  const jobBefore = await fixture.store.readJob(fixture.workspace, fixture.job.id);
  const executorBefore = await readFile(fixture.executorPath, 'utf8');
  await assert.rejects(reconcileRescueChildForPreparation({
    dataRoot: fixture.dataRoot,
    caller: fixture.caller,
    envelope: { version: 3, options: { resume: 'resume' }, continuationTarget: { agentPath: AGENT_PATH } },
    appServerOptions: {},
    dependencies: seams.dependencies,
  }), (/** @type {any} */ error) => {
    assert.equal(error.code, 'RESCUE_CHILD_RECOVERY_SUPERSEDED');
    assert.match(error.message, /caller authority was superseded/);
    return true;
  });
  assert.equal(seams.hostReads.length, 1, 'the superseded verdict lands after the first proof, before any business mutation');
  assert.equal(JSON.parse(await readFile(fixture.executorPath, 'utf8')).active, true, 'the executor is never deactivated by a superseded caller');
  assert.equal((await resolveForwardingRoute(fixture.dataRoot, fixture.workspace, SESSION, CHILD_TURN)).state, 'active');
  assert.equal(JSON.parse(await readFile(fixture.forwardPath, 'utf8')).active, true);
  assert.deepEqual(await fixture.store.readJob(fixture.workspace, fixture.job.id), jobBefore);
  assert.equal(await readFile(fixture.executorPath, 'utf8'), executorBefore);
});

test('a changed caller permission between capture and the stop stage supersedes the recovery', async (t) => {
  const { reconcileRescueChildForPreparation } = await import('../scripts/lib/rescue-child-reconciliation.mjs');
  const fixture = await reconciliationFixture(t, { job: 'succeeded' });
  const identity = createIdentityStore({ dataRoot: fixture.dataRoot });
  const proof = incidentProof(fixture);
  const seams = observationSeams(fixture, proof);
  const baseEvidence = seams.dependencies.readChildTurnEvidence;
  seams.dependencies.readChildTurnEvidence = async (/** @type {any} */ ...args) => {
    const result = await baseEvidence(...args);
    if (seams.hostReads.length === 1) {
      // The parent re-authorized under a different permission mode.
      await identity.beginCallerTurn({ sessionId: SESSION, turnId: `${RETRY_TURN}-permission`, workspace: fixture.workspace, permissionMode: 'acceptEdits', prompt: 're-authorized turn', sessionStartedAt: SESSION_STARTED_AT, sessionSource: 'startup', lifecycleResult: true });
    }
    return result;
  };
  await assert.rejects(reconcileRescueChildForPreparation({
    dataRoot: fixture.dataRoot,
    caller: fixture.caller,
    envelope: { version: 3, options: { resume: 'resume' }, continuationTarget: { agentPath: AGENT_PATH } },
    appServerOptions: {},
    dependencies: seams.dependencies,
  }), (/** @type {any} */ error) => {
    assert.equal(error.code, 'RESCUE_CHILD_RECOVERY_SUPERSEDED');
    assert.match(error.message, /caller authority was superseded/);
    return true;
  });
  assert.equal(JSON.parse(await readFile(fixture.executorPath, 'utf8')).active, true, 'no stop-state write escapes a changed permission');
  assert.equal((await resolveForwardingRoute(fixture.dataRoot, fixture.workspace, SESSION, CHILD_TURN)).state, 'active');
});

test('a caller abort during the partial-executor lookup propagates instead of masquerading as not-needed', async (t) => {
  const { reconcileRescueChildForPreparation } = await import('../scripts/lib/rescue-child-reconciliation.mjs');
  const fixture = await reconciliationFixture(t, { job: 'succeeded' });
  // The partial fixture: the prior pass wrote the stopped route and inactive
  // forwarding marker; the executor is still active.
  const route = JSON.parse(await readFile(fixture.routePath, 'utf8'));
  await writeFile(fixture.routePath, `${JSON.stringify({ ...route, state: 'stopped' }, null, 2)}\n`);
  const forward = JSON.parse(await readFile(fixture.forwardPath, 'utf8'));
  await writeFile(fixture.forwardPath, `${JSON.stringify({ ...forward, active: false }, null, 2)}\n`);
  const controller = new AbortController();
  const reason = new PluginError('JOB_INTERRUPTED', 'Recovery interrupted.', { category: 'interruption', remedy: 'Retry.' });
  const seams = observationSeams(fixture, incidentProof(fixture));
  seams.dependencies.resolvePartialExecutor = async () => {
    controller.abort(reason);
    throw reason;
  };
  await assert.rejects(reconcileRescueChildForPreparation({
    dataRoot: fixture.dataRoot,
    caller: fixture.caller,
    envelope: { version: 3, options: { resume: 'resume' }, continuationTarget: { agentPath: AGENT_PATH } },
    appServerOptions: {},
    signal: controller.signal,
    dependencies: seams.dependencies,
  }), (/** @type {any} */ error) => {
    assert.equal(error, reason, 'the caller abort reason propagates untouched');
    return true;
  });
  assert.equal(JSON.parse(await readFile(fixture.executorPath, 'utf8')).active, true, 'an aborted recovery writes nothing');
});

test('a budget expiry during the partial-executor lookup surfaces the bounded evidence outcome', async (t) => {
  const { reconcileRescueChildForPreparation } = await import('../scripts/lib/rescue-child-reconciliation.mjs');
  const fixture = await reconciliationFixture(t, { job: 'succeeded' });
  const route = JSON.parse(await readFile(fixture.routePath, 'utf8'));
  await writeFile(fixture.routePath, `${JSON.stringify({ ...route, state: 'stopped' }, null, 2)}\n`);
  const forward = JSON.parse(await readFile(fixture.forwardPath, 'utf8'));
  await writeFile(fixture.forwardPath, `${JSON.stringify({ ...forward, active: false }, null, 2)}\n`);
  const seams = observationSeams(fixture, incidentProof(fixture));
  seams.dependencies.resolvePartialExecutor = () => new Promise((resolve) => { const timer = setTimeout(resolve, 30_000); timer.unref?.(); });
  const startedAt = Date.now();
  const outcome = await reconcileRescueChildForPreparation({
    dataRoot: fixture.dataRoot,
    caller: fixture.caller,
    envelope: { version: 3, options: { resume: 'resume' }, continuationTarget: { agentPath: AGENT_PATH } },
    appServerOptions: {},
    dependencies: seams.dependencies,
  }).then((value) => value, (error) => error);
  assert.ok(Date.now() - startedAt < 9_000, `the hanging partial lookup is bounded by the shared budget (took ${Date.now() - startedAt}ms)`);
  assert.equal(outcome.code, 'RESCUE_CHILD_EVIDENCE_UNAVAILABLE', `the partial-stage budget expiry is bounded, never not-needed (got ${JSON.stringify(outcome)} ${String(outcome?.message)})`);
  assert.match(outcome.message, /budget expired/);
  assert.equal(JSON.parse(await readFile(fixture.executorPath, 'utf8')).active, true);
}, { timeout: 15_000 });

test('a caller abort during the stuck-active probe propagates instead of skipping the candidate', async (t) => {
  const { reconcileRescueChildForPreparation } = await import('../scripts/lib/rescue-child-reconciliation.mjs');
  const fixture = await reconciliationFixture(t, { job: 'succeeded' });
  const controller = new AbortController();
  const reason = new PluginError('JOB_INTERRUPTED', 'Recovery interrupted.', { category: 'interruption', remedy: 'Retry.' });
  const seams = observationSeams(fixture, incidentProof(fixture));
  seams.dependencies.resolveActiveExecutor = async () => {
    controller.abort(reason);
    // A skip-class rejection after the abort must not hide the cancellation.
    throw new PluginError('EXECUTOR_IDENTITY_NOT_FOUND', 'No trusted SubagentStart record matches this executor.', { category: 'authorization', remedy: 'Retry from the original parent thread after the Rescue child is active.' });
  };
  await assert.rejects(reconcileRescueChildForPreparation({
    dataRoot: fixture.dataRoot,
    caller: fixture.caller,
    envelope: { version: 3, options: { resume: 'resume' }, continuationTarget: { agentPath: AGENT_PATH } },
    appServerOptions: {},
    signal: controller.signal,
    dependencies: seams.dependencies,
  }), (/** @type {any} */ error) => {
    assert.equal(error, reason, 'the caller abort reason wins over the skip-class failure');
    return true;
  });
  assert.equal(JSON.parse(await readFile(fixture.executorPath, 'utf8')).active, true);
});

test('a superseded caller authority is rejected before any business mutation on a running foreground job', async (t) => {
  const { reconcileRescueChildForPreparation } = await import('../scripts/lib/rescue-child-reconciliation.mjs');
  const { settleRescueChildOwnedJob } = await import('../scripts/lib/recovery.mjs');
  const fixture = await reconciliationFixture(t, { job: 'running' });
  const identity = createIdentityStore({ dataRoot: fixture.dataRoot });
  const proof = incidentProof(fixture);
  const seams = observationSeams(fixture, proof);
  let settlements = 0;
  const baseEvidence = seams.dependencies.readChildTurnEvidence;
  seams.dependencies.readChildTurnEvidence = async (/** @type {any} */ ...args) => {
    const result = await baseEvidence(...args);
    if (seams.hostReads.length === 1) {
      // The parent advances to another turn while the first Host observation
      // is read — before any business mutation would be authorized.
      await identity.beginCallerTurn({ sessionId: SESSION, turnId: `${RETRY_TURN}-settlement-successor`, workspace: fixture.workspace, permissionMode: 'workspace-write', prompt: 'next turn', sessionStartedAt: SESSION_STARTED_AT, sessionSource: 'startup', lifecycleResult: true });
    }
    return result;
  };
  const wrappedSeams = {
    ...seams.dependencies,
    settleOwnedJob: async (input, jobId) => { settlements += 1; return settleRescueChildOwnedJob(input, jobId); },
  };
  const jobBefore = await fixture.store.readJob(fixture.workspace, fixture.job.id);
  await assert.rejects(reconcileRescueChildForPreparation({
    dataRoot: fixture.dataRoot,
    caller: fixture.caller,
    envelope: { version: 3, options: { resume: 'resume' }, continuationTarget: { agentPath: AGENT_PATH } },
    appServerOptions: {},
    dependencies: wrappedSeams,
  }), (/** @type {any} */ error) => {
    assert.equal(error.code, 'RESCUE_CHILD_RECOVERY_SUPERSEDED');
    assert.match(error.message, /caller authority was superseded/);
    return true;
  });
  assert.equal(seams.hostReads.length, 1, 'no second Host observation runs past the superseded authority');
  assert.equal(settlements, 0, 'the business settlement never runs for a superseded caller');
  assert.equal(seams.remoteStops.length, 0, 'the remote session is never stopped with a superseded authority');
  const stored = await fixture.store.readJob(fixture.workspace, fixture.job.id);
  assert.equal(stored.status, 'running', 'the running job is untouched');
  assert.equal(stored.stopIntent, undefined, 'no stop intent is persisted');
  assert.deepEqual(stored, jobBefore, 'the job record is byte-identical');
  assert.equal((await resolveForwardingRoute(fixture.dataRoot, fixture.workspace, SESSION, CHILD_TURN)).state, 'active', 'no stop-state write escapes');
  assert.equal(JSON.parse(await readFile(fixture.executorPath, 'utf8')).active, true);
});

test('an unresolved non-fresh request never reaches recovery', async (t) => {
  const { reconcileRescueChildForPreparation } = await import('../scripts/lib/rescue-child-reconciliation.mjs');
  const { settleRescueChildOwnedJob } = await import('../scripts/lib/recovery.mjs');
  const fixture = await reconciliationFixture(t, { job: 'running' });
  const seams = observationSeams(fixture, incidentProof(fixture));
  let settlements = 0;
  const probes = [];
  const wrappedSeams = {
    ...seams.dependencies,
    settleOwnedJob: async (input, jobId) => { settlements += 1; return settleRescueChildOwnedJob(input, jobId); },
    resolveActiveExecutor: async (...args) => { probes.push(args); return seams.dependencies.resolveActiveExecutor(...args); },
  };
  // Neither resume semantics nor a resolved continuation target: recovery is
  // out of scope for this request even though it is not explicitly fresh.
  const outcome = await reconcileRescueChildForPreparation({
    dataRoot: fixture.dataRoot,
    caller: fixture.caller,
    envelope: { version: 3, options: {}, continuationTarget: null },
    appServerOptions: {},
    dependencies: wrappedSeams,
  });
  assert.deepEqual(outcome, { kind: 'not-needed' });
  assert.equal(settlements, 0, 'no business settlement runs for an unresolved request');
  assert.equal(seams.remoteStops.length, 0, 'a running foreground job is never stopped for an unresolved request');
  assert.equal(seams.hostReads.length, 0, 'no Host evidence is read');
  assert.equal(probes.length, 0, 'no executor probes run');
  assert.equal((await resolveForwardingRoute(fixture.dataRoot, fixture.workspace, SESSION, CHILD_TURN)).state, 'active');
});

/** A cross-workspace partial state: the stopped route lives at the origin, the
 * still-active executor at the claimed target worktree directory. */
async function crossWorkspacePartialFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'zcode-rescue-partial-cross-'));
  await mkdir(join(root, 'origin'));
  const origin = await realpath(join(root, 'origin'));
  const dataRoot = join(root, 'data');
  t.after(() => rm(root, { force: true, recursive: true }));
  // The claimed target must be a real linked worktree of the origin repo for
  // the caller's execution-workspace claim to be eligible.
  for (const command of [['init', '-q'], ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'init', '--allow-empty']]) {
    await new Promise((resolvePromise, rejectPromise) => {
      const child = spawn('git', command, { cwd: origin, shell: false });
      child.once('error', rejectPromise);
      child.once('exit', (code) => code === 0 ? resolvePromise() : rejectPromise(new Error(`git ${command[0]} ${code}`)));
    });
  }
  const target = join(root, 'target');
  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('git', ['worktree', 'add', '-q', '-b', 'reconcile-target', target], { cwd: origin, shell: false });
    child.once('error', rejectPromise);
    child.once('exit', (code) => code === 0 ? resolvePromise() : rejectPromise(new Error(`git worktree add ${code}`)));
  });
  const identity = createIdentityStore({ dataRoot });
  await recordSession(dataRoot, { session_id: SESSION, cwd: origin, source: 'startup' });
  await identity.beginCallerTurn({ sessionId: SESSION, turnId: SPAWN_TURN, workspace: origin, permissionMode: 'workspace-write', prompt: 'rescue', sessionStartedAt: SESSION_STARTED_AT, sessionSource: 'startup', lifecycleResult: true });
  const caller = await identity.resolveActiveTurn({ sessionId: SESSION, workspace: target, workspaceBinding: 'claim' });
  await markForwarding(dataRoot, { session_id: SESSION, turn_id: CHILD_TURN, cwd: origin, hook_event_name: 'SubagentStart', agent_id: AGENT, agent_type: 'zcode-rescue' }, caller);
  const originStorage = await resolveWorkspaceStorage({ dataRoot, workspace: origin });
  const originHook = join(originStorage.directory, 'hook-state');
  const names = await readdir(originHook);
  const routePath = join(originHook, names.find((name) => name.startsWith('route-')));
  const forwardPath = join(originHook, names.find((name) => name.startsWith('forward-')));
  const route = JSON.parse(await readFile(routePath, 'utf8'));
  await writeFile(routePath, `${JSON.stringify({ ...route, state: 'stopped' }, null, 2)}\n`);
  const forward = JSON.parse(await readFile(forwardPath, 'utf8'));
  await writeFile(forwardPath, `${JSON.stringify({ ...forward, active: false }, null, 2)}\n`);
  assert.notEqual(route.targetWorkspace, origin.workspacePath ?? origin, 'the fixture routes execution across workspaces');
  const targetStorage = await resolveWorkspaceStorage({ dataRoot, workspace: target });
  return { root, origin, target, dataRoot, targetLock: join(targetStorage.directory, 'hook-state', '.lock') };
}

test('the partial lookup target stage honors the caller budget on a contended lock', async (t) => {
  const { resolvePartiallyStoppedForwardingExecutor } = await import('../hooks/lib/hook-state.mjs');
  const fixture = await crossWorkspacePartialFixture(t);
  const holder = spawn(process.execPath, [join(fileURLToPath(new URL('./fixtures/', import.meta.url)), 'lock-holder.mjs'), fixture.targetLock], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { holder.stdin.end(); holder.kill(); });
  await new Promise((resolvePromise, reject) => { holder.once('error', reject); holder.stdout.once('data', resolvePromise); });
  const startedAt = Date.now();
  const outcome = await resolvePartiallyStoppedForwardingExecutor(fixture.dataRoot, fixture.origin, AGENT, { timeoutMs: 400 })
    .then((value) => value, (error) => error);
  assert.ok(Date.now() - startedAt < 2_500, `the target probe must honor the caller budget instead of the five-second default (took ${Date.now() - startedAt}ms)`);
  assert.ok(outcome instanceof PluginError || outcome instanceof Error, `the contended target stage rejects bounded (got ${JSON.stringify(outcome)})`);
  assert.notEqual(outcome?.code, undefined, 'the bounded rejection carries a diagnostic code');
});

test('the partial lookup target stage honors the injected clock for the executor lifetime bound', async (t) => {
  const { resolvePartiallyStoppedForwardingExecutor } = await import('../hooks/lib/hook-state.mjs');
  const fixture = await reconciliationFixture(t, { job: 'succeeded' });
  const route = JSON.parse(await readFile(fixture.routePath, 'utf8'));
  const backdated = new Date(Date.now() - 5 * 60_000).toISOString();
  await writeFile(fixture.routePath, `${JSON.stringify({ ...route, state: 'stopped', createdAt: backdated, updatedAt: backdated }, null, 2)}\n`);
  const forward = JSON.parse(await readFile(fixture.forwardPath, 'utf8'));
  await writeFile(fixture.forwardPath, `${JSON.stringify({ ...forward, active: false }, null, 2)}\n`);
  const executor = JSON.parse(await readFile(fixture.executorPath, 'utf8'));
  await writeFile(fixture.executorPath, `${JSON.stringify({ ...executor, createdAt: backdated }, null, 2)}\n`);
  // A clock 31 minutes past the backdated records: the origin scan accepts it,
  // and the target probe must see the same clock and enforce the active
  // executor lifetime bound.
  const injectedNow = Date.parse(backdated) + 31 * 60_000;
  const outcome = await resolvePartiallyStoppedForwardingExecutor(fixture.dataRoot, fixture.workspace, AGENT, { now: injectedNow })
    .then((value) => value, (error) => error);
  assert.equal(outcome?.code, 'EXECUTOR_IDENTITY_EXPIRED', `the target probe must honor the injected clock (got ${JSON.stringify(outcome)} ${String(outcome?.message)})`);
});

test('recovery never settles a child routed to a different execution workspace than the preparing caller', async (t) => {
  const { reconcileRescueChildForPreparation } = await import('../scripts/lib/rescue-child-reconciliation.mjs');
  // Git repo origin + linked worktree target: the child routes origin→target,
  // the binding and its running foreground job live at the target, but the
  // preparing caller's canonical workspace is the origin — the planner's
  // validateCandidate would reject this candidate (EXECUTOR_ROUTE_INVALID).
  const root = await mkdtemp(join(tmpdir(), 'zcode-rescue-foreign-exec-'));
  await mkdir(join(root, 'origin'));
  const origin = await realpath(join(root, 'origin'));
  const dataRoot = join(root, 'data');
  t.after(() => rm(root, { force: true, recursive: true }));
  for (const command of [['init', '-q'], ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'init', '--allow-empty']]) {
    await new Promise((resolvePromise, rejectPromise) => {
      const child = spawn('git', command, { cwd: origin, shell: false });
      child.once('error', rejectPromise);
      child.once('exit', (code) => code === 0 ? resolvePromise() : rejectPromise(new Error(`git ${command[0]} ${code}`)));
    });
  }
  const target = join(root, 'target');
  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('git', ['worktree', 'add', '-q', '-b', 'foreign-exec-target', target], { cwd: origin, shell: false });
    child.once('error', rejectPromise);
    child.once('exit', (code) => code === 0 ? resolvePromise() : rejectPromise(new Error(`git worktree add ${code}`)));
  });
  const identity = createIdentityStore({ dataRoot });
  await recordSession(dataRoot, { session_id: SESSION, cwd: origin, source: 'startup' });
  await identity.beginCallerTurn({ sessionId: SESSION, turnId: SPAWN_TURN, workspace: origin, permissionMode: 'workspace-write', prompt: 'rescue', sessionStartedAt: SESSION_STARTED_AT, sessionSource: 'startup', lifecycleResult: true });
  const spawningCaller = await identity.resolveActiveTurn({ sessionId: SESSION, workspace: target, workspaceBinding: 'claim' });
  await markForwarding(dataRoot, { session_id: SESSION, turn_id: CHILD_TURN, cwd: origin, hook_event_name: 'SubagentStart', agent_id: AGENT, agent_type: 'zcode-rescue' }, spawningCaller);
  const epoch = hostLifecycleEpoch(SESSION, (await resolveRecordedSessionStart(dataRoot, origin, SESSION)).startedAt);
  const store = createStateStore({ dataRoot });
  const reserved = await store.reserveFreshRescueJob({
    workspace: target,
    reservation: { workspace: target, ownerSessionId: SESSION, ownerTurnId: SPAWN_TURN, command: 'rescue', readOnly: false, permissionSnapshot: { permissionMode: 'workspace-write' } },
    executor: { parentSessionId: SESSION, parentTurnId: SPAWN_TURN, agentId: AGENT, agentType: 'zcode-rescue', agentPath: AGENT_PATH, workspace: target, parentPermissionMode: 'workspace-write' },
    lifecycle: { ownerLifecycleEpoch: epoch, executionOwner: 'host-child', hostPlacement: 'foreground' },
  });
  const claimed = await store.claimJobWorkerForExecution(target, reserved.job.id, { childPid: 999_999_999, workerLeaseId: reserved.job.id });
  const job = await store.transitionJob(target, reserved.job.id, ['queued'], 'running', { startedAt: new Date().toISOString(), zcodeSessionId: 'zs-foreign-exec', childPid: claimed.childPid, workerLeaseId: claimed.workerLeaseId });
  await store.transitionJob(target, job.id, ['running'], 'running', { inputId: 'accepted-input', startRevision: 1, beforeMessageIds: [] });
  // The preparing caller's canonical workspace is the ORIGIN: the planner
  // rejects the child's foreign execution workspace before preparing.
  const caller = { sessionId: SESSION, turnId: RETRY_TURN, workspace: origin, originWorkspace: origin, permissionMode: 'workspace-write' };
  const seams = observationSeams({ workspace: origin, dataRoot }, incidentProof({ workspace: origin }));
  let settlements = 0;
  const wrappedSeams = {
    ...seams.dependencies,
    settleOwnedJob: async (input, jobId) => { settlements += 1; return settleRescueChildOwnedJob(input, jobId); },
  };
  const outcome = await reconcileRescueChildForPreparation({
    dataRoot,
    caller,
    envelope: { version: 3, options: { resume: 'resume' }, continuationTarget: { agentPath: AGENT_PATH } },
    appServerOptions: {},
    dependencies: wrappedSeams,
  });
  assert.deepEqual(outcome, { kind: 'not-needed' }, 'a foreign execution workspace is never settled; the planner owns the rejection');
  assert.equal(settlements, 0, 'no business settlement runs for a foreign execution workspace');
  assert.equal(seams.remoteStops.length, 0, 'the foreign foreground job is never remotely stopped');
  const stored = await store.readJob(target, job.id);
  assert.equal(stored.status, 'running', 'the foreign running job is untouched');
  assert.equal(stored.stopIntent, undefined, 'no stop intent is persisted');
  assert.equal((await resolveForwardingRoute(dataRoot, origin, SESSION, CHILD_TURN)).state, 'active');
});

test('an unapproved-role sibling never blocks recovery of the valid Rescue child', async (t) => {
  const { reconcileRescueChildForPreparation } = await import('../scripts/lib/rescue-child-reconciliation.mjs');
  const fixture = await reconciliationFixture(t, { job: 'succeeded' });
  const spawningCaller = await createIdentityStore({ dataRoot: fixture.dataRoot }).resolveActiveTurn({ sessionId: SESSION, workspace: fixture.workspace, workspaceBinding: 'claim' });
  await markForwarding(fixture.dataRoot, { session_id: SESSION, turn_id: `${CHILD_TURN}-helper`, cwd: fixture.workspace, hook_event_name: 'SubagentStart', agent_id: `${AGENT}-helper`, agent_type: 'reviewer' }, spawningCaller);
  const seams = observationSeams(fixture, incidentProof(fixture));
  seams.dependencies.listChildren = async () => [
    { id: `${AGENT}-helper`, parentThreadId: SESSION, agentPath: '/root/zcode_rescue_helper', agentRole: 'reviewer', cwd: fixture.workspace, status: { type: 'notLoaded' }, createdAt: 1, updatedAt: 2 },
    { id: AGENT, parentThreadId: SESSION, agentPath: AGENT_PATH, agentRole: 'zcode-rescue', cwd: fixture.workspace, status: { type: 'notLoaded' }, createdAt: 1, updatedAt: 2 },
  ];
  const outcome = await reconcileRescueChildForPreparation({
    dataRoot: fixture.dataRoot,
    caller: fixture.caller,
    envelope: { version: 3, options: { resume: 'resume' }, continuationTarget: null },
    appServerOptions: {},
    dependencies: seams.dependencies,
  });
  assert.deepEqual(outcome, { kind: 'reconciled', executionWorkspace: fixture.workspace }, 'the occupancy sibling is filtered before probing');
  assert.equal((await resolveForwardingRoute(fixture.dataRoot, fixture.workspace, SESSION, CHILD_TURN)).state, 'stopped');
  assert.equal(JSON.parse(await readFile(fixture.executorPath, 'utf8')).active, false);
});

test('an active generic sibling does not produce RESCUE_CHILD_AMBIGUOUS when the valid child exists', async (t) => {
  const { reconcileRescueChildForPreparation } = await import('../scripts/lib/rescue-child-reconciliation.mjs');
  const fixture = await reconciliationFixture(t, { job: 'succeeded' });
  const spawningCaller = await createIdentityStore({ dataRoot: fixture.dataRoot }).resolveActiveTurn({ sessionId: SESSION, workspace: fixture.workspace, workspaceBinding: 'claim' });
  await markForwarding(fixture.dataRoot, { session_id: SESSION, turn_id: `${CHILD_TURN}-generic`, cwd: fixture.workspace, hook_event_name: 'SubagentStart', agent_id: `${AGENT}-generic`, agent_type: 'default' }, spawningCaller);
  const seams = observationSeams(fixture, incidentProof(fixture));
  seams.dependencies.listChildren = async () => [
    { id: `${AGENT}-generic`, parentThreadId: SESSION, agentPath: '/tmp/unmanaged/sibling', agentRole: null, cwd: fixture.workspace, status: { type: 'notLoaded' }, createdAt: 1, updatedAt: 2 },
    { id: AGENT, parentThreadId: SESSION, agentPath: AGENT_PATH, agentRole: 'zcode-rescue', cwd: fixture.workspace, status: { type: 'notLoaded' }, createdAt: 1, updatedAt: 2 },
  ];
  const outcome = await reconcileRescueChildForPreparation({
    dataRoot: fixture.dataRoot,
    caller: fixture.caller,
    envelope: { version: 3, options: { resume: 'resume' }, continuationTarget: null },
    appServerOptions: {},
    dependencies: seams.dependencies,
  });
  assert.deepEqual(outcome, { kind: 'reconciled', executionWorkspace: fixture.workspace }, 'the unmanaged generic sibling is filtered before probing');
  assert.equal((await resolveForwardingRoute(fixture.dataRoot, fixture.workspace, SESSION, CHILD_TURN)).state, 'stopped');
  assert.equal(JSON.parse(await readFile(fixture.executorPath, 'utf8')).active, false);
});

/** A cross-workspace running foreground Rescue: SessionStart record at the
 * origin repo, the child routed to (and the binding, job, and executor at) the
 * linked worktree, and the preparing caller running in that worktree. */
async function crossWorkspaceRunningFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'zcode-rescue-cross-running-'));
  await mkdir(join(root, 'origin'));
  const origin = await realpath(join(root, 'origin'));
  const dataRoot = join(root, 'data');
  t.after(() => rm(root, { force: true, recursive: true }));
  for (const command of [['init', '-q'], ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'init', '--allow-empty']]) {
    await new Promise((resolvePromise, rejectPromise) => {
      const child = spawn('git', command, { cwd: origin, shell: false });
      child.once('error', rejectPromise);
      child.once('exit', (code) => code === 0 ? resolvePromise() : rejectPromise(new Error(`git ${command[0]} ${code}`)));
    });
  }
  const target = join(root, 'target');
  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('git', ['worktree', 'add', '-q', '-b', 'cross-running-target', target], { cwd: origin, shell: false });
    child.once('error', rejectPromise);
    child.once('exit', (code) => code === 0 ? resolvePromise() : rejectPromise(new Error(`git worktree add ${code}`)));
  });
  const identity = createIdentityStore({ dataRoot });
  await recordSession(dataRoot, { session_id: SESSION, cwd: origin, source: 'startup' });
  await identity.beginCallerTurn({ sessionId: SESSION, turnId: SPAWN_TURN, workspace: origin, permissionMode: 'workspace-write', prompt: 'rescue', sessionStartedAt: SESSION_STARTED_AT, sessionSource: 'startup', lifecycleResult: true });
  const spawningCaller = await identity.resolveActiveTurn({ sessionId: SESSION, workspace: target, workspaceBinding: 'claim' });
  await markForwarding(dataRoot, { session_id: SESSION, turn_id: CHILD_TURN, cwd: origin, hook_event_name: 'SubagentStart', agent_id: AGENT, agent_type: 'zcode-rescue' }, spawningCaller);
  const epoch = hostLifecycleEpoch(SESSION, (await resolveRecordedSessionStart(dataRoot, origin, SESSION)).startedAt);
  const store = createStateStore({ dataRoot });
  const reserved = await store.reserveFreshRescueJob({
    workspace: target,
    reservation: { workspace: target, ownerSessionId: SESSION, ownerTurnId: SPAWN_TURN, command: 'rescue', readOnly: false, permissionSnapshot: { permissionMode: 'workspace-write' } },
    executor: { parentSessionId: SESSION, parentTurnId: SPAWN_TURN, agentId: AGENT, agentType: 'zcode-rescue', agentPath: AGENT_PATH, workspace: target, parentPermissionMode: 'workspace-write' },
    lifecycle: { ownerLifecycleEpoch: epoch, executionOwner: 'host-child', hostPlacement: 'foreground' },
  });
  const claimed = await store.claimJobWorkerForExecution(target, reserved.job.id, { childPid: 999_999_999, workerLeaseId: reserved.job.id });
  const job = await store.transitionJob(target, reserved.job.id, ['queued'], 'running', { startedAt: new Date().toISOString(), zcodeSessionId: 'zs-cross-running', childPid: claimed.childPid, workerLeaseId: claimed.workerLeaseId });
  await store.transitionJob(target, job.id, ['running'], 'running', { inputId: 'accepted-input', startRevision: 1, beforeMessageIds: [] });
  // The preparing caller runs in the worktree (the invocation cwd): its
  // canonical workspace is the target and its origin is the repo root.
  await identity.beginCallerTurn({ sessionId: SESSION, turnId: RETRY_TURN, workspace: origin, permissionMode: 'workspace-write', prompt: 'continue the rescue', sessionStartedAt: SESSION_STARTED_AT, sessionSource: 'startup', lifecycleResult: true });
  const caller = await identity.resolveActiveTurn({ sessionId: SESSION, workspace: target, workspaceBinding: 'claim' });
  assert.equal(caller.originWorkspace, origin, 'the preparing caller keeps its origin workspace');
  const targetStorage = await resolveWorkspaceStorage({ dataRoot, workspace: target });
  const executorPath = join(targetStorage.directory, 'hook-state', (await readdir(join(targetStorage.directory, 'hook-state'))).find((name) => name.startsWith('executor-')));
  return { root, origin, target, dataRoot, caller, store, job, epoch, executorPath };
}

test('cross-workspace recovery reads the caller session epoch from the origin workspace and reconciles', async (t) => {
  const { reconcileRescueChildForPreparation } = await import('../scripts/lib/rescue-child-reconciliation.mjs');
  const { settleRescueChildOwnedJob } = await import('../scripts/lib/recovery.mjs');
  const fixture = await crossWorkspaceRunningFixture(t);
  const seams = observationSeams(fixture, incidentProof({ workspace: fixture.origin }), {
    readSnapshot: (state) => state.stopped ? succeededReread('the rescue finished in the worktree') : undefined,
  });
  seams.dependencies.listChildren = async () => [
    { id: AGENT, parentThreadId: SESSION, agentPath: AGENT_PATH, agentRole: 'zcode-rescue', cwd: fixture.origin, status: { type: 'notLoaded' }, createdAt: 1, updatedAt: 2 },
  ];
  let settlements = 0;
  const wrappedSeams = {
    ...seams.dependencies,
    settleOwnedJob: async (input, jobId) => { settlements += 1; return settleRescueChildOwnedJob(input, jobId); },
  };
  const outcome = await reconcileRescueChildForPreparation({
    dataRoot: fixture.dataRoot,
    caller: fixture.caller,
    envelope: { version: 3, options: { resume: 'resume' }, continuationTarget: { agentPath: AGENT_PATH } },
    appServerOptions: {},
    dependencies: wrappedSeams,
  });
  assert.deepEqual(outcome, { kind: 'reconciled', executionWorkspace: await realpath(fixture.target) }, 'valid cross-workspace recovery proceeds past the caller-authority gate');
  assert.equal(settlements, 1);
  assert.equal(seams.remoteStops.length, 1);
  const stored = await fixture.store.readJob(fixture.target, fixture.job.id);
  assert.equal(stored.status, 'succeeded', 'the coordination-loss settlement settles the running job');
  assert.equal((await resolveForwardingRoute(fixture.dataRoot, fixture.origin, SESSION, CHILD_TURN)).state, 'stopped');
  assert.equal(JSON.parse(await readFile(fixture.executorPath, 'utf8')).active, false);
  assert.equal(seams.hostReads.length, 2);
});

test('a genuinely missing origin session record still fails closed as superseded', async (t) => {
  const { reconcileRescueChildForPreparation } = await import('../scripts/lib/rescue-child-reconciliation.mjs');
  const { settleRescueChildOwnedJob } = await import('../scripts/lib/recovery.mjs');
  const fixture = await crossWorkspaceRunningFixture(t);
  const originStorage = await resolveWorkspaceStorage({ dataRoot: fixture.dataRoot, workspace: fixture.origin });
  const originHook = join(originStorage.directory, 'hook-state');
  for (const name of await readdir(originHook)) if (name.startsWith('session-')) await rm(join(originHook, name));
  const seams = observationSeams(fixture, incidentProof({ workspace: fixture.origin }));
  seams.dependencies.listChildren = async () => [
    { id: AGENT, parentThreadId: SESSION, agentPath: AGENT_PATH, agentRole: 'zcode-rescue', cwd: fixture.origin, status: { type: 'notLoaded' }, createdAt: 1, updatedAt: 2 },
  ];
  let settlements = 0;
  const wrappedSeams = {
    ...seams.dependencies,
    settleOwnedJob: async (input, jobId) => { settlements += 1; return settleRescueChildOwnedJob(input, jobId); },
  };
  const jobBefore = await fixture.store.readJob(fixture.target, fixture.job.id);
  await assert.rejects(reconcileRescueChildForPreparation({
    dataRoot: fixture.dataRoot,
    caller: fixture.caller,
    envelope: { version: 3, options: { resume: 'resume' }, continuationTarget: { agentPath: AGENT_PATH } },
    appServerOptions: {},
    dependencies: wrappedSeams,
  }), (/** @type {any} */ error) => {
    assert.equal(error.code, 'RESCUE_CHILD_RECOVERY_SUPERSEDED');
    assert.match(error.message, /could not be re-resolved/);
    assert.equal(error.cause?.code, 'SETUP_SESSION_UNPROVEN');
    return true;
  });
  assert.equal(settlements, 0, 'no business settlement runs without a provable session epoch');
  assert.equal(seams.remoteStops.length, 0);
  assert.deepEqual(await fixture.store.readJob(fixture.target, fixture.job.id), jobBefore);
});
