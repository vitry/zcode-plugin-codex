// @ts-nocheck
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { hostLifecycleEpoch } from '../scripts/lib/host-lifecycle.mjs';
import { createJobController, withWorkerLease } from '../scripts/lib/job-control.mjs';
import { scavengeWritableJobs } from '../scripts/lib/recovery.mjs';
import { hostOwnedStopIntentPatch, STOP_CAUSES, validHostLifecycleRecord, validStopIntent } from '../scripts/lib/rescue-binding.mjs';
import { createRescueLifecycleReconciler } from '../scripts/lib/rescue-lifecycle.mjs';
import { createStateStore } from '../scripts/lib/state.mjs';
import { createManagementRescueReconcile } from '../scripts/zcode-companion.mjs';

/**
 * Task 6 lifecycle-feasibility spike (bounded): prove or reject Task 2's
 * candidate strategies for an MCP-transport accepted invocation using ONLY
 * existing seams — the shared reservation/claim acceptance path, the durable
 * stop intent, the worker process-lifetime lease with its orphan scavenge,
 * and the Rescue Lifecycle Reconciler bound to its production adapters. The
 * fixture adds NO binding identity, NO second job type, and NO second
 * lifecycle state machine: the durable state of an accepted invocation is the
 * existing Host-owned writable Rescue record, whose transport state
 * (`foregroundAdapter`) is private runtime state — persisted only inside the
 * v5 preparation/pending envelopes, never a field of the Rescue job record
 * (scripts/lib/state.mjs) and never binding or job authority.
 */

const record = JSON.parse(await readFile(new URL('../qualification/mcp-lifecycle.json', import.meta.url), 'utf8'));

// The Host tool ceiling the Task 6 descriptor grants the MCP transport
// (`tool_timeout_sec: 360000` — the 100-hour Host ceiling).
const HOST_TOOL_CEILING_MS = 360_000 * 1000;
const OWNER_SESSION = 'mcp-host-session';
const ZCODE_SESSION = 'zs-mcp-accepted';
const CHILD_AGENT_ID = 'mcp-rescue-child';

/**
 * One REGISTERED invocation's durable lifecycle, built through the existing
 * production reservation seam: the exact reservation `startPublic` uses for
 * every child-authorized Rescue (the Host-owned trio with a foreground
 * placement; no detached-runner marker). The durable record exists here
 * BEFORE any work admission.
 */
async function registeredInvocationFixture() {
  const root = await mkdtemp(join(tmpdir(), 'zcode-mcp-lifecycle-'));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const dataRoot = join(root, 'data');
  const store = createStateStore({ dataRoot });
  const sessionStartedAt = new Date().toISOString();
  const epoch = hostLifecycleEpoch(OWNER_SESSION, sessionStartedAt);
  const reserved = await store.reserveFreshRescueJob({
    workspace,
    reservation: { workspace, ownerSessionId: OWNER_SESSION, ownerTurnId: 'mcp-origin-turn', command: 'rescue', readOnly: false, permissionSnapshot: { permissionMode: 'workspace-write' } },
    executor: { parentSessionId: OWNER_SESSION, parentTurnId: 'mcp-origin-turn', agentId: CHILD_AGENT_ID, agentType: 'zcode-rescue', agentPath: '/root/zcode_rescue_task', workspace, parentPermissionMode: 'workspace-write' },
    lifecycle: { ownerLifecycleEpoch: epoch, executionOwner: 'host-child', hostPlacement: 'foreground' },
  });
  const registered = await store.readJob(workspace, reserved.job.id);
  assert.equal(validHostLifecycleRecord(registered), true, 'the registered record already carries the durable supervisor ownership trio');
  return { root, workspace, dataRoot, store, epoch, job: reserved.job, admissions: 0 };
}

/**
 * WORK ADMISSION (strictly after registration; counted, so "no second
 * launch" is assertable): the store's worker claim is the linearization point
 * that admits work, followed by the accepted remote session and the persisted
 * turn boundary. `worker` names the admitted executor's recorded identity —
 * the real child process holding the worker lease when the test models a
 * live MCP server, the production-shaped stand-in otherwise.
 */
async function admitInvocation(fixture, worker = { childPid: 999_999_999, workerLeaseId: fixture.job.id }) {
  const admittedAt = Date.now();
  const claim = await fixture.store.claimJobWorkerForExecution(fixture.workspace, fixture.job.id, worker);
  await fixture.store.transitionJob(fixture.workspace, fixture.job.id, ['queued'], 'running', { startedAt: new Date().toISOString(), zcodeSessionId: ZCODE_SESSION, childPid: claim.childPid, workerLeaseId: claim.workerLeaseId });
  const inputId = `input-${fixture.job.id.slice(0, 16)}`;
  await fixture.store.transitionJob(fixture.workspace, fixture.job.id, ['running'], 'running', { inputId, startRevision: 1, beforeMessageIds: [] });
  fixture.admissions += 1;
  return { admittedAt, inputId, worker };
}

/** A registered invocation admitted through the stand-in worker identity. */
async function acceptedInvocationFixture() {
  const fixture = await registeredInvocationFixture();
  const { admittedAt, inputId } = await admitInvocation(fixture);
  return { ...fixture, admittedAt, inputId, admissionsCount: () => fixture.admissions };
}

/**
 * One bounded management control client over the accepted remote session.
 * The first read observes the turn still executing; every later read observes
 * the terminal interruption the exact stop produced. The client records every
 * control call: the supervision paths may list, read, and stop the exact
 * turn, and must never launch work again (no send/create seam exists here).
 */
function supervisionClient(sharedCalls, inputId) {
  let reads = 0;
  const calls = [];
  const userMessage = { info: { role: 'user', messageId: inputId, semantics: { origin: 'real_user', kind: 'user_prompt', uiVisibility: 'visible' } }, parts: [{ type: 'text', text: 'task' }] };
  return {
    calls,
    listSessions: async () => {
      calls.push('list'); sharedCalls.push('list');
      return { sessions: [{ sessionId: ZCODE_SESSION }] };
    },
    readSession: async () => {
      reads += 1;
      calls.push('read'); sharedCalls.push('read');
      if (reads === 1) return { projection: { status: 'running' }, runtime: { stateRevision: 2 }, messages: [userMessage] };
      return { projection: { status: 'idle' }, runtime: { stateRevision: 3 }, messages: [
        userMessage,
        { info: { role: 'assistant', messageId: `assistant-${inputId}`, parentMessageId: inputId, finish: 'cancelled' }, parts: [{ type: 'text', text: 'stopped' }] },
      ] };
    },
    stopSession: async () => { calls.push('stop'); sharedCalls.push('stop'); },
    close: async () => { calls.push('close'); sharedCalls.push('close'); },
  };
}

/** A real detached, self-grouped child that holds the worker lease for its lifetime — the accepted invocation's live MCP server. @param {string} dataRoot @param {string} workspace @param {string} jobId @param {string} workerLeaseId */
function spawnDetachedLeaseHolder(dataRoot, workspace, jobId, workerLeaseId) {
  const moduleUrl = new URL('../scripts/lib/job-control.mjs', import.meta.url).href;
  const code = `const { withWorkerLease } = await import(${JSON.stringify(moduleUrl)});`
    + ` setInterval(() => {}, 1 << 30);`
    + ` await withWorkerLease({ dataRoot: ${JSON.stringify(dataRoot)}, workspace: ${JSON.stringify(workspace)},`
    + ` jobId: ${JSON.stringify(jobId)}, workerLeaseId: ${JSON.stringify(workerLeaseId)} }, () => new Promise(() => {}));`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { detached: true, stdio: 'ignore' });
  child.unref();
  return child;
}

/** @param {string} dataRoot @param {string} workspace @param {string} jobId @param {string} workerLeaseId */
async function leaseIsHeld(dataRoot, workspace, jobId, workerLeaseId) {
  try {
    await withWorkerLease({ dataRoot, workspace, jobId, workerLeaseId, timeoutMs: 0 }, async () => undefined);
    return false;
  } catch (error) {
    if (!(error instanceof Error && error.code === 'LOCK_TIMEOUT')) throw error;
    return true;
  }
}

test('explicit interruption: the durable stop intent seam settles an armed intent with no delivered signal, but no existing input arms it for an MCP invocation (release-blocked)', async () => {
  // The characterized record retains ONLY the release-blocked candidate: no
  // case observed a delivered handler abort (`signal-abort`), and the only
  // Stop-Hook observations pair with completed turns or Host-side timeouts,
  // never with an interrupted pending MCP tool call.
  assert.deepEqual(record.candidateStrategies.explicitInterrupt, ['release-blocked']);
  for (const [name, observation] of Object.entries(record.cases)) {
    assert.notEqual(observation.handlerSettlement, 'signal-abort', `${name} must not characterize a delivered abort`);
  }
  // The seam's closed cause set names every Durable Stop Intent input that
  // exists: a live caller's user stop, the SessionEnd receipt, and Host
  // Coordination Loss. The last two are the Host-loss supervision authority
  // (dimension 2); none is a mechanism that DELIVERS a user's explicit
  // interrupt into the MCP server process.
  assert.deepEqual([...STOP_CAUSES].sort(), ['host-coordination-loss', 'session-end', 'user']);

  const fixture = await acceptedInvocationFixture();
  const sharedCalls = [];
  try {
    // (a) The seam is real where its authority exists: an ARMED durable stop
    // intent settles the accepted invocation through the existing interruption
    // settlement with NO delivered signal anywhere — the reconciler actively
    // stops the exact remote turn because the durable decision authorizes it.
    const armed = hostOwnedStopIntentPatch(fixture.job, 'user');
    assert.equal(validStopIntent(armed.stopIntent), true, 'the accepted Host-owned record can carry the durable stop intent — the durable STATE is not the blocker');
    await fixture.store.transitionJob(fixture.workspace, fixture.job.id, ['running'], 'cancelling', armed);
    const reconcileRescueLifecycle = createManagementRescueReconcile({
      store: fixture.store, dataRoot: fixture.dataRoot, workspace: fixture.workspace, ownerSessionId: OWNER_SESSION,
      createClient: async () => supervisionClient(sharedCalls, fixture.inputId),
      createRescueLifecycleReconciler,
    });
    // No AbortSignal is passed: the settlement is driven by the durable intent alone.
    const outcome = await reconcileRescueLifecycle({ intent: { kind: 'stop', cause: 'user' }, authority: { ownerSessionId: OWNER_SESSION }, workspace: fixture.workspace, selector: { jobId: fixture.job.id } });
    assert.equal(outcome.kind, 'settled-terminal', `the armed intent reaches existing interruption settlement: ${JSON.stringify(outcome)}`);
    assert.equal(outcome.status, 'cancelled');
    const settled = await fixture.store.readJob(fixture.workspace, fixture.job.id);
    assert.equal(settled.status, 'cancelled');
    assert.equal(settled.stopCause, 'user');
    assert.equal(settled.stopIntent.cause, 'user');
    assert.ok(sharedCalls.includes('stop'), 'the durable intent — not a signal — drove the exact remote stop');

    // (b) The seam is structurally bound to Host-lifecycle records: the
    // read-only commands of the MCP surface (review, adversarial-review,
    // status) produce durable records that can NEVER carry a stop intent —
    // the patch mints nothing and the store rejects the field outright.
    const readOnlyJob = await fixture.store.reserveJob({ workspace: fixture.workspace, ownerSessionId: OWNER_SESSION, ownerTurnId: 'mcp-origin-turn', command: 'review', readOnly: true, permissionSnapshot: { permissionMode: 'workspace-write' } });
    assert.deepEqual(hostOwnedStopIntentPatch(readOnlyJob, 'user'), {}, 'no stop intent is minted without the Host-owned trio');
    await fixture.store.transitionJob(fixture.workspace, readOnlyJob.id, ['queued'], 'running', { startedAt: new Date().toISOString(), zcodeSessionId: 'zs-mcp-review' });
    await assert.rejects(
      fixture.store.transitionJob(fixture.workspace, readOnlyJob.id, ['running'], 'cancelling', { stopIntent: armed.stopIntent }),
      (error) => error.code === 'JOB_PATCH_INVALID',
      'the store structurally rejects a stop intent on a read-only record',
    );
    assert.equal(fixture.admissionsCount(), 1, 'no proof armed a second admission');

    // (c) Honest freeze: no existing seam meets the dimension. The durable
    // stop intent settles armed intents, but the only arming inputs an MCP
    // invocation can reach post-mortem are the session-end/coordination-loss
    // authorities (the Host-loss dimension below); no characterized
    // signal/event or existing input carries the user's explicit interrupt
    // into the accepted invocation, and the read-only commands are excluded
    // structurally. The dimension stays release-blocked.
    assert.equal(record.selectedStrategies?.explicitInterrupt, 'release-blocked');
  } finally {
    await rm(fixture.root, { force: true, recursive: true }).catch(() => {});
  }
});

test('host/process loss: the dead MCP server is proven by its worker lease and the existing scavenge settles the orphan with no hook receipt (durable-supervision)', async () => {
  // The candidates retain durable-supervision; the proof below must carry it
  // through the ACTUAL server-death scenario. The characterization for a
  // killed server (cliSigkill) observes NO hook event at all — server death
  // produces no SessionEnd receipt, so this proof fabricates none and drives
  // only the existing worker-lease scavenge machinery.
  assert.ok(record.candidateStrategies.hostLoss.includes('durable-supervision'));
  assert.equal(record.cases.cliSigkill.hookEvent, 'not-observed');
  assert.equal(record.cases.cliSigkill.transportState, 'stdin-eof');

  const fixture = await registeredInvocationFixture();
  const sharedCalls = [];
  const workerLeaseId = 'f'.repeat(64);
  // The MCP server IS the accepted invocation's worker: a real child process
  // holding the exact process-lifetime worker lease the production claim records.
  const holder = spawnDetachedLeaseHolder(fixture.dataRoot, fixture.workspace, fixture.job.id, workerLeaseId);
  const holderPid = holder.pid;
  const pollUntilLease = async (expected, deadline) => {
    while (await leaseIsHeld(fixture.dataRoot, fixture.workspace, fixture.job.id, workerLeaseId) !== expected) {
      if (Date.now() > deadline) throw new Error(`the worker lease never became ${expected ? 'held' : 'free'}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  try {
    assert.equal(typeof holderPid, 'number', 'the worker spawned with a pid');
    // ADMISSION (once, strictly after registration): the claim records the
    // live worker's exact pid + lease identity on the durable record.
    const admitted = await admitInvocation(fixture, { childPid: holderPid, workerLeaseId });
    await pollUntilLease(true, Date.now() + 5_000);
    const supervisionInputs = () => ({
      store: fixture.store, dataRoot: fixture.dataRoot, workspace: fixture.workspace,
      // The production ownership pass reconciles broker-owner records under
      // the data root; the injectable seam models that pass with no broker
      // daemon in this environment.
      reconcileOwnership: async () => undefined,
      createClient: async () => supervisionClient(sharedCalls, admitted.inputId),
    });
    // While the worker is ALIVE the same scavenge pass may not settle: the
    // zero-timeout worker-lease probe hits the live holder and retains.
    const retained = (await scavengeWritableJobs(supervisionInputs())).at(-1);
    assert.equal(retained.status, 'running', 'a live worker lease retains the accepted invocation');
    // THE MCP SERVER DIES HERE (SIGKILL — the cliSigkill shape): the handler
    // side simply stops existing — no settlement write, no receipt, no
    // session-end publication of any kind.
    try { process.kill(-holderPid, 'SIGKILL'); } catch { holder.kill('SIGKILL'); }
    await pollUntilLease(false, Date.now() + 5_000);
    // The existing scavenge machinery owns the orphan: the FREE lease proves
    // the worker dead (the same zero-timeout probe that retained above), the
    // pass actively stops the exact remote turn, and the record settles to a
    // durable non-success outcome without a second launch.
    const settled = (await scavengeWritableJobs(supervisionInputs())).at(-1);
    assert.equal(settled.status, 'failed', `the orphan settles to a durable non-success outcome: ${settled.status} ${JSON.stringify(settled.error ?? null)}`);
    assert.match(String(settled.error?.message ?? ''), /executor exited/, 'the settlement carries the worker-death evidence');
    const durable = await fixture.store.readJob(fixture.workspace, fixture.job.id);
    assert.equal(durable.status, 'failed');
    assert.equal(validStopIntent(durable.stopIntent), false, 'no stop intent exists — no fabricated hook authority');
    assert.ok(sharedCalls.includes('stop'), 'the scavenge pass actively stopped the exact remote turn');
    assert.equal(sharedCalls.includes('send'), false, 'the supervision pass never relaunches the accepted work');
    assert.equal(fixture.admissions, 1, 'exactly one admission — no second launch');
    assert.equal(record.selectedStrategies?.hostLoss, 'durable-supervision');
  } finally {
    try { process.kill(-holderPid, 'SIGKILL'); } catch { /* the worker already exited */ }
    await rm(fixture.root, { force: true, recursive: true }).catch(() => {});
  }
});

test('host timeout ceiling: a controller-owned deadline armed at admission settles through existing interruption settlement before the Host ceiling (server-deadline)', async () => {
  // The characterized Host timeout paths deliver no handler abort, so the
  // host-abort candidate is excluded and the deadline must be the controller's
  // own in-process decision — never an unobserved Host timeout callback.
  assert.ok(record.candidateStrategies.hostTimeout.includes('server-deadline'));
  for (const key of ['pluginToolTimeout', 'directConfigToolTimeout']) {
    assert.equal(record.cases[key].handlerSettlement, 'not-observed', `${key} delivered no handler abort`);
    assert.notEqual(record.cases[key].unknownReason, 'none');
  }

  const fixture = await acceptedInvocationFixture();
  const sharedCalls = [];
  const deadlineController = new AbortController();
  // The deadline's carrier is a REFERENCED timer: an unref'ed timer (e.g. the
  // internal one AbortSignal.timeout arms) can let the event loop drain
  // before the abort ever fires, leaving the awaited settlement pending
  // forever. The controller owns the timer, observes it in-process, and the
  // cleanup below clears it.
  const deadlineTimer = setTimeout(() => deadlineController.abort(new Error('The MCP server deadline expired.')), 100);
  try {
    const reconcileRescueLifecycle = createManagementRescueReconcile({
      store: fixture.store, dataRoot: fixture.dataRoot, workspace: fixture.workspace, ownerSessionId: OWNER_SESSION,
      createClient: async () => supervisionClient(sharedCalls, fixture.inputId),
      createRescueLifecycleReconciler,
    });
    const controller = createJobController({ store: fixture.store, dataRoot: fixture.dataRoot, reconcile: reconcileRescueLifecycle });
    // The server-side deadline: armed by the controller IN ITS OWN PROCESS at
    // admission, strictly inside the Host ceiling. When it fires, the
    // controller drives the existing cancellation election, whose durable
    // stop intent and reconciler pass enter the existing interruption
    // settlement. The fixture injects no Host timeout input of any kind.
    const settledPromise = new Promise((resolve, reject) => {
      deadlineController.signal.addEventListener('abort', () => {
        controller.cancel(fixture.workspace, fixture.job.id, OWNER_SESSION, 'host-coordination-loss').then(resolve, reject);
      }, { once: true });
    });
    const settled = await settledPromise;
    assert.equal(settled.status, 'cancelled', `the deadline settled through existing interruption settlement: ${JSON.stringify(settled)}`);
    const durable = await fixture.store.readJob(fixture.workspace, fixture.job.id);
    assert.equal(durable.status, 'cancelled');
    assert.equal(validStopIntent(durable.stopIntent), true, 'the deadline entered through the durable stop intent');
    assert.ok(sharedCalls.includes('stop'), 'the deadline pass actively stopped the exact remote turn');
    assert.ok(Date.now() - fixture.admittedAt < HOST_TOOL_CEILING_MS, 'the settlement completed long before the Host ceiling');
    assert.equal(fixture.admissionsCount(), 1, 'the deadline settled the same accepted invocation without a second launch');
    assert.equal(record.selectedStrategies?.hostTimeout, 'server-deadline');
  } finally {
    clearTimeout(deadlineTimer);
    await rm(fixture.root, { force: true, recursive: true }).catch(() => {});
  }
});
