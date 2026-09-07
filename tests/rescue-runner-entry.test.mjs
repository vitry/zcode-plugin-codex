import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { parseArgs } from '../scripts/lib/args.mjs';
import { createHostLifecycleStore, hostLifecycleEpoch } from '../scripts/lib/host-lifecycle.mjs';
import { spawnRescueRunner } from '../scripts/lib/rescue-runner.mjs';
import { readResultArtifact } from '../scripts/lib/review.mjs';
import { createStateStore } from '../scripts/lib/state.mjs';
import { resolveWorkspaceStorage } from '../scripts/lib/workspace.mjs';
import { atomicWriteJson } from '../scripts/lib/fs.mjs';
import { recordSession, resolveRecordedSessionStart } from '../hooks/lib/hook-state.mjs';
import { runCompanion } from '../scripts/zcode-companion.mjs';
import { scaleTestTimeout } from './helpers/test-timeouts.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const cli = join(root, 'scripts', 'zcode-companion.mjs');
const fake = join(root, 'tests', 'fixtures', 'fake-zcode-cli.mjs');
const PRIVATE_TASK = 'true background runner entry private task';
const TERMINAL_STATUSES = ['succeeded', 'failed', 'cancelled'];
const OWNER_SESSION = 'codex-session';

/** Minimal isolated workspace + installed-data-root fixture with the fake ZCode CLI. */
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-rescue-runner-entry-'));
  const workspace = join(directory, 'repo'); const dataRoot = join(directory, 'data');
  await mkdir(workspace, { recursive: true });
  // The runner's lifecycle admission reuses the CURRENT epoch/receipt evidence:
  // the owner session's recorded SessionStart defines the epoch the reservation
  // carries, so the fixture records it exactly like a real SessionStart hook.
  await recordSession(dataRoot, { cwd: workspace, session_id: OWNER_SESSION, source: 'startup' });
  const startedAt = (await resolveRecordedSessionStart(dataRoot, workspace, OWNER_SESSION)).startedAt;
  const ownerLifecycleEpoch = hostLifecycleEpoch(OWNER_SESSION, startedAt);
  const store = createStateStore({ dataRoot });
  const reservation = (/** @type {string} */ turnId) => ({
    workspace, ownerSessionId: OWNER_SESSION, ownerTurnId: turnId, command: 'rescue', readOnly: false,
    permissionSnapshot: { permissionMode: 'workspace-write' },
  });
  const executor = (/** @type {string} */ tag, /** @type {string} */ turnId) => ({
    parentSessionId: OWNER_SESSION, parentTurnId: turnId, agentId: `runner-entry-child-${tag}`,
    agentType: 'zcode-rescue', agentPath: '/root/zcode_rescue_task', workspace,
    parentPermissionMode: 'workspace-write',
  });
  const env = { ...process.env, ZCODE_DATA_ROOT: dataRoot, ZCODE_PATH: fake };
  const lifecycle = { ownerLifecycleEpoch, executionOwner: 'host-child', hostPlacement: 'background' };
  const reserveBackground = async () => (await store.reserveFreshRescueJob({
    workspace, reservation: reservation('turn-runner-entry'), executor: executor('background', 'turn-runner-entry'),
    lifecycle, executionInput: { version: 1, task: PRIVATE_TASK },
  })).job;
  const record = join(directory, 'fake-zcode-requests.jsonl');
  return {
    directory, dataRoot, env, executor, lifecycle, ownerLifecycleEpoch, record,
    reserveBackground, reservation, startedAt, store, workspace,
  };
}

/** Publish the exact matching-epoch SessionEnd receipt for the fixture's owner session. @param {any} context @param {string} [origin] */
async function publishOwnerReceipt(context, origin = 'session-end-hook') {
  return createHostLifecycleStore({ dataRoot: context.dataRoot }).publishSessionEnd({
    sessionId: OWNER_SESSION, sessionStartedAt: context.startedAt,
    endedAt: new Date().toISOString(), origin, workspaceHints: [context.workspace],
  });
}

/** The fake ZCode requests recorded for one runner invocation. @param {string} record */
async function recordedRequests(record) {
  const contents = await readFile(record, 'utf8').catch(() => '');
  return contents.trim().split('\n').filter(Boolean).map((/** @type {string} */ line) => JSON.parse(line));
}

/** @param {any} context @param {string[]} argv @param {{dependencies?:any}} [runtime] */
async function runRunnerEntry(context, argv, runtime = {}) {
  return runCompanion(argv, {
    cwd: context.workspace,
    env: { ...context.env, FAKE_ZCODE_RECORD: context.record },
    ...(runtime.dependencies === undefined ? {} : { dependencies: runtime.dependencies }),
  });
}

/** Bounded best-effort cleanup of the detached runner process group. @param {number} pid */
async function terminateRunnerTree(pid) {
  if (process.platform === 'win32') {
    try { process.kill(pid); } catch { /* already exited */ }
    return;
  }
  try { process.kill(-pid, 'SIGKILL'); } catch { /* group already gone; fall through */ }
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch { return; }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** The exact CLI parser contract for the private Host-runner selector. */
test('the CLI parser accepts exactly run-host-rescue-job plus one digest and no option overrides', () => {
  const jobId = 'a'.repeat(64);
  assert.deepEqual(parseArgs(['run-host-rescue-job', jobId]), {
    command: 'run-host-rescue-job', options: {}, positionals: [jobId],
  });
  for (const argv of [
    ['run-host-rescue-job'],
    ['run-host-rescue-job', jobId, jobId],
    ['run-host-rescue-job', 'not-a-digest'],
    ['run-host-rescue-job', jobId, '--task', 'override'],
    ['run-host-rescue-job', jobId, '--resume'],
    ['run-host-rescue-job', jobId, '--fresh'],
    ['run-host-rescue-job', jobId, '--model', 'provider/model'],
    ['run-host-rescue-job', jobId, '--effort', 'high'],
    ['run-host-rescue-job', jobId, '--wait'],
    ['run-host-rescue-job', jobId, 'extra'],
  ]) {
    assert.throws(() => parseArgs(argv), (/** @type {any} */ error) => error.code === 'ARGUMENT_INVALID'
      && error.category === 'validation', `expected ARGUMENT_INVALID for ${JSON.stringify(argv)}`);
  }
});

/** THE finding-disproving test: a real detached spawned child must claim and
 * execute the exact queued Host-owned background job to a durable terminal
 * result through the existing shared execution path and fake ZCode. */
test('a real detached runner child claims and executes its exact Host-owned background job', {
  timeout: scaleTestTimeout(180_000),
}, async (t) => {
  const context = await fixture();
  const reserved = await context.reserveBackground();
  assert.equal(reserved.status, 'queued');
  assert.equal(reserved.rescueRunnerVersion, 1);
  const record = context.record;
  await writeFile(record, '');
  // The REAL OS spawn adapter with no test overrides: the child is the
  // installed companion entry resolving `run-host-rescue-job <digest>`.
  const spawned = await spawnRescueRunner({
    companionPath: cli, workspace: context.workspace, jobId: reserved.id,
    env: { ...context.env, FAKE_ZCODE_RECORD: record },
  });
  assert.ok(typeof spawned.pid === 'number' && spawned.pid > 0, 'the runner child must spawn');
  t.after(async () => {
    await terminateRunnerTree(/** @type {number} */ (spawned.pid));
    await rm(context.directory, { force: true, recursive: true }).catch(() => {});
  });

  // Bounded polling deadline: the detached child must claim (PID/lease
  // publication) and drive the job to a durable terminal winner on its own.
  const deadline = Date.now() + scaleTestTimeout(120_000);
  /** @type {any} */ let job;
  for (;;) {
    job = await context.store.readJob(context.workspace, reserved.id);
    if (TERMINAL_STATUSES.includes(job.status)) break;
    if (Date.now() > deadline) {
      assert.fail(`detached runner child never settled the job; last status ${job.status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(job.status, 'succeeded', `the runner must execute the task; error: ${JSON.stringify(job.error ?? null)}`);
  // The REAL spawned child claimed the job: its PID and a generated process-
  // lifetime worker lease are the published executor identity.
  assert.equal(job.childPid, spawned.pid);
  assert.equal(/^\b[a-f0-9]{64}\b$/u.test(job.workerLeaseId ?? ''), true);
  // Task 3's settled behavior holds because the shared seams ran: the private
  // input is removed on running publication while the marker is retained.
  assert.equal(job.rescueExecutionInput, undefined);
  assert.equal(job.rescueRunnerVersion, 1);
  // The turn ran exactly once against the fake ZCode with the private task.
  const requests = (await readFile(record, 'utf8')).trim().split('\n').filter(Boolean)
    .map((/** @type {string} */ line) => JSON.parse(line));
  assert.equal(requests.filter((/** @type {any} */ request) => request.method === 'session/create').length, 1);
  assert.equal(requests.filter((/** @type {any} */ request) => request.method === 'session/send').length, 1);
  assert.ok(JSON.stringify(requests.find((/** @type {any} */ request) => request.method === 'session/send')).includes(PRIVATE_TASK));
  const result = await readResultArtifact({
    dataRoot: context.dataRoot, workspace: context.workspace, artifact: job.resultArtifact,
  });
  assert.match(result, /done/u);
  // The runner exits after terminal publication; nothing lingers.
  const exitDeadline = Date.now() + scaleTestTimeout(15_000);
  while (Date.now() < exitDeadline) {
    try { process.kill(/** @type {number} */ (spawned.pid), 0); } catch { break; }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  let exited = false;
  try { process.kill(/** @type {number} */ (spawned.pid), 0); } catch { exited = true; }
  assert.equal(exited, true, 'the detached runner must exit after terminal publication');
});

/** THE P1 linked-worktree regression: the lifecycle epoch derives from the
 * parent session's ORIGIN workspace while the runner executes in a linked
 * execution workspace, so the reservation must persist the executor's origin
 * workspace and the entry must resolve its admission evidence against that
 * persisted origin — never against the execution cwd, which has no SessionStart
 * record and would fail every claim closed with PRIOR_EPOCH_UNSETTLED. */
test('a linked-worktree runner claims and executes by resolving admission against the persisted origin workspace', {
  timeout: scaleTestTimeout(120_000),
}, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-rescue-runner-entry-linked-'));
  await mkdir(join(directory, 'origin'), { recursive: true });
  await mkdir(join(directory, 'linked'), { recursive: true });
  // Canonical workspace spellings, exactly what the runtime's workspace
  // resolution hands every reservation and binding authority.
  const originWorkspace = await realpath(join(directory, 'origin'));
  const executionWorkspace = await realpath(join(directory, 'linked'));
  const dataRoot = join(directory, 'data');
  // The linked-worktree shape: the owner session's SessionStart record exists
  // ONLY at the origin workspace; the job and runner live in the linked
  // execution workspace.
  await recordSession(dataRoot, { cwd: originWorkspace, session_id: OWNER_SESSION, source: 'startup' });
  const startedAt = (await resolveRecordedSessionStart(dataRoot, originWorkspace, OWNER_SESSION)).startedAt;
  const ownerLifecycleEpoch = hostLifecycleEpoch(OWNER_SESSION, startedAt);
  const store = createStateStore({ dataRoot });
  const reserved = (await store.reserveFreshRescueJob({
    workspace: executionWorkspace,
    reservation: {
      workspace: executionWorkspace, ownerSessionId: OWNER_SESSION, ownerTurnId: 'turn-runner-linked',
      command: 'rescue', readOnly: false, permissionSnapshot: { permissionMode: 'workspace-write' },
    },
    executor: {
      parentSessionId: OWNER_SESSION, parentTurnId: 'turn-runner-linked', agentId: 'runner-entry-child-linked',
      agentType: 'zcode-rescue', agentPath: '/root/zcode_rescue_task', originWorkspace,
      workspace: executionWorkspace, parentPermissionMode: 'workspace-write',
    },
    lifecycle: { ownerLifecycleEpoch, executionOwner: 'host-child', hostPlacement: 'background' },
    executionInput: { version: 1, task: PRIVATE_TASK },
  })).job;
  t.after(() => rm(directory, { force: true, recursive: true }).catch(() => {}));
  // The reservation authority persisted the origin-workspace provenance beside
  // the runner marker, while execution stays bound to the linked workspace.
  assert.equal(reserved.rescueOriginWorkspace, originWorkspace);
  assert.equal(reserved.rescueRunnerVersion, 1);
  assert.equal(reserved.workspace, executionWorkspace);
  const record = join(directory, 'fake-zcode-requests.jsonl');
  await writeFile(record, '');
  // RED (before the fix): the entry resolved the SessionStart anchor against
  // the execution workspace, so every claim failed closed with
  // PRIOR_EPOCH_UNSETTLED and no remote call ever happened.
  await runRunnerEntry({ dataRoot, workspace: executionWorkspace, env: { ...process.env, ZCODE_DATA_ROOT: dataRoot, ZCODE_PATH: fake }, record },
    ['run-host-rescue-job', reserved.id]);
  const job = await store.readJob(executionWorkspace, reserved.id);
  assert.equal(job.status, 'succeeded', `the runner must execute the linked-worktree job; error: ${JSON.stringify(job.error ?? null)}`);
  assert.equal(typeof job.childPid, 'number');
  assert.equal(/^\b[a-f0-9]{64}\b$/u.test(job.workerLeaseId ?? ''), true);
  assert.equal(job.rescueExecutionInput, undefined);
  assert.equal(job.rescueRunnerVersion, 1);
  const requests = await recordedRequests(record);
  assert.equal(requests.filter((/** @type {any} */ request) => request.method === 'session/create').length, 1);
  assert.equal(requests.filter((/** @type {any} */ request) => request.method === 'session/send').length, 1);
  assert.ok(JSON.stringify(requests.find((/** @type {any} */ request) => request.method === 'session/send')).includes(PRIVATE_TASK));
  const result = await readResultArtifact({ dataRoot, workspace: executionWorkspace, artifact: job.resultArtifact });
  assert.match(result, /done/u);
});

/** THE P1 regression: a SessionEnd receipt published after reservation but
 * before the runner claims must block dispatch at the claim seam — no
 * create/resume/send, the job stays queued (the receipt boundary owns its
 * cancellation), and the runner exits nonzero without any remote call. */
test('a SessionEnd receipt published before the claim prevents dispatch with no remote call', {
  timeout: scaleTestTimeout(60_000),
}, async () => {
  const context = await fixture();
  const reserved = await context.reserveBackground();
  await writeFile(context.record, '');
  await publishOwnerReceipt(context);
  await assert.rejects(() => runRunnerEntry(context, ['run-host-rescue-job', reserved.id]),
    (/** @type {any} */ error) => error.code === 'PRIOR_EPOCH_UNSETTLED');
  // The job stays queued and unclaimed: the receipt boundary (SessionEnd
  // reconciliation) owns cancelling it, never the late runner.
  const job = await context.store.readJob(context.workspace, reserved.id);
  assert.equal(job.status, 'queued');
  assert.equal(job.childPid, undefined);
  assert.equal(job.workerLeaseId === undefined || job.workerLeaseId === null, true);
  // The fake observed no writable dispatch at all.
  const requests = await recordedRequests(context.record);
  assert.equal(requests.filter((/** @type {any} */ request) => request.method === 'session/create').length, 0);
  assert.equal(requests.filter((/** @type {any} */ request) => request.method === 'session/send').length, 0);
});

/** The same-epoch receipt blocks even when its boundary already SETTLED: the
 * settled state is invisible to a pending-only scan, so the admission fence
 * must match the job's own epoch receipt in any state. */
test('a settled receipt for the job\'s own epoch still prevents dispatch', {
  timeout: scaleTestTimeout(60_000),
}, async () => {
  const context = await fixture();
  const reserved = await context.reserveBackground();
  await writeFile(context.record, '');
  const receipt = await publishOwnerReceipt(context);
  await createHostLifecycleStore({ dataRoot: context.dataRoot })
    .settleReceipt(receipt.epoch, receipt.updatedAt);
  await assert.rejects(() => runRunnerEntry(context, ['run-host-rescue-job', reserved.id]),
    (/** @type {any} */ error) => error.code === 'PRIOR_EPOCH_UNSETTLED'
      && error.details?.endedEpoch === 'settled');
  const job = await context.store.readJob(context.workspace, reserved.id);
  assert.equal(job.status, 'queued');
  assert.equal(job.childPid, undefined);
  const requests = await recordedRequests(context.record);
  assert.equal(requests.filter((/** @type {any} */ request) => request.method === 'session/send').length, 0);
});

/** A receipt published between the claim and the final send admission must
 * block the send: the existing fail-closed send-admission behavior applies —
 * the running publication and its Writable Guard are retained for the boundary
 * owner, and the send never occurs. */
test('a receipt published between the claim and the send admission blocks the send', {
  timeout: scaleTestTimeout(120_000),
}, async (t) => {
  const context = await fixture();
  const reserved = await context.reserveBackground();
  await writeFile(context.record, '');
  let published = false;
  await assert.rejects(() => runRunnerEntry(context, ['run-host-rescue-job', reserved.id], {
    // The seam runs strictly after the claim and before the send admission, so
    // the receipt becomes durable inside the claim-to-send window it must gate.
    dependencies: { testOnlyAfterExecutionClaim: async () => { await publishOwnerReceipt(context); published = true; } },
  }), (/** @type {any} */ error) => error.code === 'PRIOR_EPOCH_UNSETTLED');
  assert.equal(published, true, 'the receipt must have been published inside the claim-to-send window');
  const requests = await recordedRequests(context.record);
  assert.equal(requests.filter((/** @type {any} */ request) => request.method === 'session/send').length, 0);
  // Existing fail-closed behavior: the running publication exists and its
  // writable guard is retained — the runner never settles it and never resends.
  const job = await context.store.readJob(context.workspace, reserved.id);
  assert.equal(job.status, 'running');
  t.after(async () => {
    await context.store.finishJob(context.workspace, reserved.id, ['running'], 'cancelled', {
      exitCode: null, stopIntent: { version: 1, cause: 'session-end', requestedAt: new Date().toISOString() },
      stopCause: 'session-end',
    }).catch(() => {});
  });
});

/** A superseded epoch (the owner's recorded SessionStart replaced by a same-ID
 * resume) no longer matches the job's reserved epoch: dispatch is rejected
 * before any remote call. */
test('a superseded lifecycle epoch rejects dispatch with no remote call', {
  timeout: scaleTestTimeout(60_000),
}, async () => {
  const context = await fixture();
  const reserved = await context.reserveBackground();
  await writeFile(context.record, '');
  // A same-ID resume replaces the SessionStart record: the current epoch no
  // longer matches the epoch the job was reserved under.
  await recordSession(context.dataRoot, { cwd: context.workspace, session_id: OWNER_SESSION, source: 'startup' });
  const successor = await resolveRecordedSessionStart(context.dataRoot, context.workspace, OWNER_SESSION);
  assert.notEqual(hostLifecycleEpoch(OWNER_SESSION, successor.startedAt), context.ownerLifecycleEpoch,
    'the successor record must define a different epoch for this test to be meaningful');
  await assert.rejects(() => runRunnerEntry(context, ['run-host-rescue-job', reserved.id]),
    (/** @type {any} */ error) => error.code === 'PRIOR_EPOCH_UNSETTLED' && error.details?.superseded === true);
  const job = await context.store.readJob(context.workspace, reserved.id);
  assert.equal(job.status, 'queued');
  assert.equal(job.childPid, undefined);
  const requests = await recordedRequests(context.record);
  assert.equal(requests.filter((/** @type {any} */ request) => request.method === 'session/create').length, 0);
  assert.equal(requests.filter((/** @type {any} */ request) => request.method === 'session/send').length, 0);
});

test('the runner entry rejects a foreground placement job with a bounded error and no partial state', async () => {
  const context = await fixture();
  const reserved = (await context.store.reserveFreshRescueJob({
    workspace: context.workspace, reservation: context.reservation('turn-runner-foreground'),
    executor: context.executor('foreground', 'turn-runner-foreground'),
    lifecycle: { ...context.lifecycle, hostPlacement: 'foreground' },
  })).job;
  await assert.rejects(() => runRunnerEntry(context, ['run-host-rescue-job', reserved.id]),
    (/** @type {any} */ error) => error.code === 'RESCUE_RUNNER_JOB_NOT_EXECUTABLE' && error.category === 'authorization');
  const job = await context.store.readJob(context.workspace, reserved.id);
  assert.equal(job.status, 'queued');
  assert.equal(job.childPid, undefined);
  assert.equal(job.workerLeaseId, undefined);
});

test('the runner entry rejects a legacy unmarked job with a bounded error and no partial state', async () => {
  const context = await fixture();
  const reserved = await context.store.reserveJob({
    workspace: context.workspace, ownerSessionId: 'codex-session', ownerTurnId: 'turn-runner-legacy',
    command: 'rescue', readOnly: false, permissionSnapshot: { permissionMode: 'workspace-write' },
  });
  await assert.rejects(() => runRunnerEntry(context, ['run-host-rescue-job', reserved.id]),
    (/** @type {any} */ error) => error.code === 'RESCUE_RUNNER_JOB_NOT_EXECUTABLE' && error.category === 'authorization');
  const job = await context.store.readJob(context.workspace, reserved.id);
  assert.equal(job.status, 'queued');
  assert.equal(job.childPid, undefined);
  assert.equal(job.workerLeaseId, undefined);
});

test('the runner entry rejects malformed stored execution input with a bounded error and no partial state', async () => {
  const context = await fixture();
  const reserved = await context.reserveBackground();
  const storage = await resolveWorkspaceStorage({ dataRoot: context.dataRoot, workspace: context.workspace });
  const jobPath = join(storage.directory, 'jobs', `${reserved.id}.json`);
  const record = JSON.parse(await readFile(jobPath, 'utf8'));
  record.rescueExecutionInput = { ...record.rescueExecutionInput, effort: 'bogus-effort' };
  await atomicWriteJson(jobPath, record);
  await assert.rejects(() => runRunnerEntry(context, ['run-host-rescue-job', reserved.id]),
    (/** @type {any} */ error) => typeof error.code === 'string' && error.category !== undefined);
  const job = await context.store.readJob(context.workspace, reserved.id).catch(() => null);
  // Fail closed: the corrupted record stays exactly as it was — never claimed,
  // never partially settled, never "repaired" by the runner entry.
  assert.ok(job === null || job.status === 'queued' && job.childPid === undefined);
});

test('the runner entry rejects a terminal job with a bounded error and no partial state', async () => {
  const context = await fixture();
  const reserved = await context.reserveBackground();
  await context.store.finishJob(context.workspace, reserved.id, ['queued'], 'failed', {
    error: { message: 'terminal before the runner claimed' }, exitCode: 1,
  });
  await assert.rejects(() => runRunnerEntry(context, ['run-host-rescue-job', reserved.id]),
    (/** @type {any} */ error) => error.code === 'RESCUE_RUNNER_JOB_NOT_EXECUTABLE' && error.category === 'authorization');
  const job = await context.store.readJob(context.workspace, reserved.id);
  assert.equal(job.status, 'failed');
  assert.equal(job.childPid, undefined);
  assert.equal(job.workerLeaseId, undefined);
});

test('the runner entry rejects wrong argument shapes before touching any job', async () => {
  const context = await fixture();
  const reserved = await context.reserveBackground();
  for (const argv of [
    ['run-host-rescue-job'],
    ['run-host-rescue-job', reserved.id, reserved.id],
    ['run-host-rescue-job', 'not-a-digest'],
    ['run-host-rescue-job', reserved.id, '--task', 'override'],
    ['run-host-rescue-job', reserved.id, '--resume'],
  ]) {
    await assert.rejects(() => runRunnerEntry(context, argv), (/** @type {any} */ error) => error.code === 'ARGUMENT_INVALID');
  }
  const job = await context.store.readJob(context.workspace, reserved.id);
  assert.equal(job.status, 'queued');
  assert.equal(job.childPid, undefined);
});
