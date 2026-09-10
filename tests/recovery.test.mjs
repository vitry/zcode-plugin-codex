// @ts-nocheck
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { closeSync, constants, openSync } from 'node:fs';
import { mkdir, mkdtemp, chmod, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { createIdentityStore } from '../scripts/lib/identity.mjs';
import { PluginError } from '../scripts/lib/errors.mjs';
import { atomicWriteJson } from '../scripts/lib/fs.mjs';
import { WINDOWS_RUNNER_DUTY_FALLBACK_MS, createJobController, ownerIdForSession, runnerTerminationBudgetCapMs } from '../scripts/lib/job-control.mjs';
import { buildPrompt } from '../scripts/lib/prompts.mjs';
import { loadReviewOutputSchema, validateJsonSchema } from '../scripts/lib/review-schema.mjs';
import { createStateStore } from '../scripts/lib/state.mjs';
import { resolveWorkspaceStorage } from '../scripts/lib/workspace.mjs';
import { releaseManagedZCodeOwner } from '../scripts/lib/zcode-client.mjs';
import { failBackgroundDelivery, readInternalEnvelope, runCompanion, writeInternalResponse } from '../scripts/zcode-companion.mjs';

const writerProbe = fileURLToPath(new URL('./fixtures/internal-writer-child.mjs', import.meta.url));
const readerAbortProbe = fileURLToPath(new URL('./fixtures/internal-reader-abort-child.mjs', import.meta.url));
const cancellingHolder = fileURLToPath(new URL('./fixtures/cancelling-holder.mjs', import.meta.url));
const companionCli = fileURLToPath(new URL('../scripts/zcode-companion.mjs', import.meta.url));
const fakeZCode = fileURLToPath(new URL('./fixtures/fake-zcode-cli.mjs', import.meta.url));
const cancelAttemptChild = fileURLToPath(new URL('./fixtures/cancel-attempt-child.mjs', import.meta.url));
const cancelLockHolder = fileURLToPath(new URL('./fixtures/cancel-lock-holder.mjs', import.meta.url));
const execFileAsync = promisify(execFile);

function spawnCancelAttempt(args) {
  const child = spawn(process.execPath, [cancelAttemptChild, ...args], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }); let stdout = ''; let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; }); child.stderr.on('data', (chunk) => { stderr += chunk; });
  const result = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code) => code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(`cancel child ${code}: ${stderr}`))); });
  return { child, result, message: (type) => new Promise((resolve) => { const listener = (value) => { if (value?.type === type) { child.off('message', listener); resolve(value); } }; child.on('message', listener); }) };
}

function runWriterProbe(mode) {
  const child = spawn(process.execPath, [writerProbe, mode], { stdio: ['ignore', 'pipe', 'pipe', 'ignore', 'pipe'] });
  let stdout = ''; let stderr = ''; let internalError = null; let exited = false; let streamClosed = !child.stdio[4]; let exitCode;
  child.stdout.on('data', (chunk) => { stdout += chunk; }); child.stderr.on('data', (chunk) => { stderr += chunk; });
  if (mode === 'early-close') child.stdio[4].destroy();
  if (mode === 'slow-read') { child.stdio[4].pause(); setTimeout(() => { child.stdio[4].on('data', () => {}); child.stdio[4].resume(); }, 50); }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`writer probe ${mode} exceeded hard timeout`)); }, 2_000);
    const settle = () => { if (!exited || !streamClosed) return; clearTimeout(timer); resolve({ code: exitCode, stdout, stderr, internalError }); };
    child.stdio[4]?.once('error', (error) => { internalError = error; }); child.stdio[4]?.once('close', () => { streamClosed = true; settle(); });
    child.once('error', (error) => { clearTimeout(timer); reject(error); }); child.once('exit', (code) => { exitCode = code; exited = true; settle(); });
  });
}

async function context() {
  const root = await mkdtemp(join(tmpdir(), 'zcode-recovery-')); const workspace = join(root, 'workspace'); const dataRoot = join(root, 'data');
  await mkdir(workspace); const identity = createIdentityStore({ dataRoot });
  const callerContext = await identity.createCallerContext({ sessionId: 'owner', turnId: 'turn', workspace, permissionMode: 'workspace-write' });
  return { root, workspace, dataRoot, identity, callerContext, env: { ...process.env, ZCODE_DATA_ROOT: dataRoot } };
}

async function cleanupRecoveryFixture(fixture) {
  const storage = await resolveWorkspaceStorage({ dataRoot: fixture.dataRoot, workspace: fixture.workspace }); const brokerDirectory = join(storage.directory, 'broker'); const pids = [];
  try {
    for (const name of await readdir(brokerDirectory)) if (/^identity(?:-[a-f0-9]{16})?\.json$/.test(name)) {
      try { const identity = JSON.parse(await readFile(join(brokerDirectory, name), 'utf8')); if (Number.isSafeInteger(identity.pid) && identity.pid > 0) pids.push(identity.pid); } catch { /* invalid test artifact */ }
    }
  } catch { /* no broker */ }
  await releaseManagedZCodeOwner({ dataRoot: fixture.dataRoot, workspace: fixture.workspace, ownerId: ownerIdForSession('owner'), requestTimeoutMs: 500 }).catch(() => {});
  const deadline = Date.now() + 1_500; while (pids.some(processAlive) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  for (const pid of pids.filter(processAlive)) try { process.kill(pid, 'SIGTERM'); } catch { /* exited */ }
  const termDeadline = Date.now() + 1_000; while (pids.some(processAlive) && Date.now() < termDeadline) await new Promise((resolve) => setTimeout(resolve, 20));
  for (const pid of pids.filter(processAlive)) try { process.kill(pid, 'SIGKILL'); } catch { /* exited */ }
  await rm(fixture.root, { force: true, recursive: true });
  assert.equal(pids.some(processAlive), false, `recovery test leaked broker pids: ${pids.join(',')}`);
}

async function cancellationAttempt(dataRoot, workspace, jobId) {
  const storage = await resolveWorkspaceStorage({ dataRoot, workspace });
  return JSON.parse(await readFile(join(storage.directory, 'cancel-attempts', `${jobId}.json`), 'utf8'));
}

function processAlive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
async function waitForJob(store, workspace, jobId, predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs; let job;
  while (Date.now() < deadline) { job = await store.readJob(workspace, jobId); if (predicate(job)) return job; await new Promise((resolve) => setTimeout(resolve, 10)); }
  assert.fail(`job ${jobId} did not reach expected state: ${JSON.stringify(job)}`);
}

async function orphanJob(fixture, options = {}) {
  const store = createStateStore({ dataRoot: fixture.dataRoot });
  const ownerSessionId = options.ownerSessionId ?? 'owner';
  const job = await store.reserveJob({ workspace: fixture.workspace, ownerSessionId, ownerTurnId: options.turnId ?? 'orphan', command: options.command ?? 'rescue', ...(options.command === 'transfer' ? { codexThreadId: ownerSessionId } : {}), readOnly: options.readOnly ?? false, permissionSnapshot: { permissionMode: 'workspace-write' } });
  const workerLeaseId = options.workerLeaseId ?? 'd'.repeat(64);
  const worker = { childPid: 999999, workerLeaseId };
  if (options.claim !== false) {
    if (job.command === 'rescue' && job.readOnly === false) await store.claimJobWorkerForExecution(fixture.workspace, job.id, worker);
    else await store.claimJobWorker(fixture.workspace, job.id, worker);
  }
  if (options.status === 'queued') return { job: await store.readJob(fixture.workspace, job.id), store, workerLeaseId };
  let running = await store.transitionJob(fixture.workspace, job.id, ['queued'], 'running', {
    startedAt: options.startedAt ?? new Date().toISOString(),
    ...(job.command === 'rescue' && job.readOnly === false ? worker : {}),
    ...(options.sessionId === false ? {} : { zcodeSessionId: options.sessionId ?? 'orphan-session' }),
  });
  if (options.boundary !== false) running = await store.transitionJob(fixture.workspace, job.id, ['running'], 'running', { inputId: 'accepted-input', startRevision: 7, beforeMessageIds: ['historical'] });
  if (options.status === 'cancelling') running = await store.transitionJob(fixture.workspace, job.id, ['running'], 'cancelling');
  return { job: running, store, workerLeaseId };
}

function recoveryClient(job, options = {}) {
  return {
    listSessions: async () => ({ sessions: options.missing ? [] : [{ sessionId: job.zcodeSessionId }] }),
    readSession: async () => options.snapshot ?? activeCurrentTurn(job.inputId),
    stopSession: async (sessionId) => { assert.equal(sessionId, job.zcodeSessionId); options.onStop?.(); if (options.stopError) throw options.stopError; },
    close: async () => { options.onClose?.(); },
  };
}

function activeCurrentTurn(inputId = 'accepted-input', status = 'running') {
  return { projection: { status }, runtime: { stateRevision: 8 }, messages: [
    { info: { role: 'user', messageId: inputId }, parts: [{ type: 'text', text: 'task' }] },
  ] };
}

function coherentCurrentTurn(inputId, text = 'recovered answer', finish = 'stop') {
  return { projection: { status: 'completed' }, runtime: { stateRevision: 8 }, messages: [
    { info: { role: 'user', messageId: inputId }, parts: [{ type: 'text', text: 'task' }] },
    { info: { role: 'assistant', messageId: `answer-${inputId}`, parentMessageId: inputId, finish }, parts: [{ type: 'text', text }] },
  ] };
}

test('cross-owner scavenging derives maintenance ownership from each durable writable blocker', async () => {
  const fixture = await context(); const reconciled = []; const clientOwners = [];
  const { scavengeWritableJobs } = await import('../scripts/lib/recovery.mjs');
  for (const ownerSessionId of ['departed-owner-a', 'departed-owner-b']) {
    const { job, store } = await orphanJob(fixture, { ownerSessionId, turnId: ownerSessionId });
    await scavengeWritableJobs({
      store, dataRoot: fixture.dataRoot, workspace: fixture.workspace,
      reconcileOwnership: async (input) => { reconciled.push(input); },
      createClient: async (current, ownerId) => { clientOwners.push({ jobId: current.id, ownerId }); return recoveryClient(current, { missing: true }); },
    });
    assert.equal((await store.readJob(fixture.workspace, job.id)).status, 'failed');
  }
  assert.deepEqual(reconciled.map(({ ownerId, ownedSessionIds }) => ({ ownerId, ownedSessionIds })), [
    { ownerId: ownerIdForSession('departed-owner-a'), ownedSessionIds: ['orphan-session'] },
    { ownerId: ownerIdForSession('departed-owner-b'), ownedSessionIds: ['orphan-session'] },
  ]);
  assert.deepEqual(clientOwners.map(({ ownerId }) => ownerId), [ownerIdForSession('departed-owner-a'), ownerIdForSession('departed-owner-b')]);
});

test('workspace scavenging never inspects a blocker whose exact worker lease is held', async () => {
  const fixture = await context(); const { job, store, workerLeaseId } = await orphanJob(fixture); let ownershipCalls = 0; let clientCalls = 0;
  const { scavengeWritableJobs, withWorkerLease } = await import('../scripts/lib/recovery.mjs');
  await withWorkerLease({ dataRoot: fixture.dataRoot, workspace: fixture.workspace, jobId: job.id, workerLeaseId }, () => scavengeWritableJobs({
    store, dataRoot: fixture.dataRoot, workspace: fixture.workspace,
    reconcileOwnership: async () => { ownershipCalls += 1; },
    createClient: async () => { clientCalls += 1; throw new Error('held lease must prevent inspection'); },
  }));
  assert.equal(ownershipCalls, 0); assert.equal(clientCalls, 0);
  assert.equal((await store.readJob(fixture.workspace, job.id)).status, 'running');
});

test('workspace scavenging archives an orphan when its managed control channel cannot be established', async () => {
  const fixture = await context(); const { job, store } = await orphanJob(fixture);
  const { scavengeWritableJobs } = await import('../scripts/lib/recovery.mjs');
  await scavengeWritableJobs({
    store, dataRoot: fixture.dataRoot, workspace: fixture.workspace,
    reconcileOwnership: async () => {},
    createClient: async () => { throw new PluginError('ZCODE_DISCONNECTED', 'endpoint=/secret.sock token=secret owner=secret session=secret', { category: 'runtime', remedy: 'Restart the operation.' }); },
  });
  const recovered = await store.readJob(fixture.workspace, job.id);
  assert.equal(recovered.status, 'failed');
  assert.equal(recovered.error.message, 'Reservation-time recovery could not establish the managed ZCode control channel; the orphan was archived.');
  assert.doesNotMatch(recovered.error.message, /secret/);
  assert.equal(recovered.lastCancelError, undefined);
});

test('workspace scavenging retains an orphan when managed client creation fails generically', async () => {
  for (const mode of ['generic-error', 'null-client']) {
    const fixture = await context(); const { job, store } = await orphanJob(fixture); let closes = 0;
    const { scavengeWritableJobs } = await import('../scripts/lib/recovery.mjs');
    await scavengeWritableJobs({
      store, dataRoot: fixture.dataRoot, workspace: fixture.workspace,
      reconcileOwnership: async () => {},
      createClient: async () => {
        if (mode === 'generic-error') throw new Error('local recovery configuration is invalid');
        return null;
      },
    });
    const recovered = await store.readJob(fixture.workspace, job.id);
    assert.equal(recovered.status, 'running', mode);
    assert.match(recovered.lastCancelError, /recovery client is unavailable|local recovery configuration is invalid/, mode);
    assert.ok(Buffer.byteLength(recovered.lastCancelError, 'utf8') <= 2_048, mode);
    assert.equal(closes, 0, mode);
  }
});

test('workspace scavenging propagates native and arbitrary abort reasons before archival', async () => {
  for (const [mode, returnsNull] of [['native', false], ['arbitrary', true]]) {
    const fixture = await context(); const { job, store } = await orphanJob(fixture); const controller = new AbortController();
    const reason = mode === 'native' ? undefined : Object.freeze({ source: 'arbitrary caller abort' });
    const { scavengeWritableJobs } = await import('../scripts/lib/recovery.mjs');
    const scavenging = scavengeWritableJobs({
      store, dataRoot: fixture.dataRoot, workspace: fixture.workspace, signal: controller.signal,
      reconcileOwnership: async () => {},
      createClient: async () => {
        controller.abort(reason);
        if (returnsNull) return null;
        throw new PluginError('ZCODE_DISCONNECTED', 'disconnect raced caller abort', { category: 'runtime', remedy: 'restart' });
      },
    });
    await assert.rejects(scavenging, (error) => error === controller.signal.reason, mode);
    const recovered = await store.readJob(fixture.workspace, job.id);
    assert.equal(recovered.status, 'running', mode);
    assert.equal(recovered.lastCancelError, undefined, mode);
  }
});

test('workspace scavenging propagates an abort observed by every successful client operation', async () => {
  for (const phase of ['create', 'list', 'read', 'stop', 'reread']) {
    const fixture = await context(); const { job, store } = await orphanJob(fixture); const controller = new AbortController(); const reason = Object.freeze({ phase });
    const abortAfter = (value) => { if (phase === value) controller.abort(reason); };
    let reads = 0; let closes = 0;
    const { scavengeWritableJobs } = await import('../scripts/lib/recovery.mjs');
    const scavenging = scavengeWritableJobs({
      store, dataRoot: fixture.dataRoot, workspace: fixture.workspace, signal: controller.signal,
      reconcileOwnership: async () => {},
      createClient: async () => {
        abortAfter('create');
        return {
          listSessions: async () => { abortAfter('list'); return { sessions: [{ sessionId: job.zcodeSessionId }] }; },
          readSession: async () => { reads += 1; abortAfter(reads === 1 ? 'read' : 'reread'); return activeCurrentTurn(job.inputId, reads === 1 ? 'running' : 'paused'); },
          stopSession: async () => { abortAfter('stop'); },
          close: async () => { closes += 1; },
        };
      },
    });
    await assert.rejects(scavenging, (error) => error === reason, phase);
    assert.equal((await store.readJob(fixture.workspace, job.id)).status, 'running', phase);
    assert.equal(closes, 1, phase);
  }
});

test('workspace scavenging distinguishes unavailable established control channels', async () => {
  for (const [code, expected] of [
    ['ZCODE_BROKER_PROTOCOL_UNAVAILABLE', 'The reachable ZCode broker reported no existing ZCode Protocol; the orphan was archived.'],
    ['ZCODE_DISCONNECTED', 'The established ZCode control channel disconnected during orphan recovery; the orphan was archived.'],
  ]) {
    const fixture = await context(); const { job, store } = await orphanJob(fixture); let closes = 0;
    const { scavengeWritableJobs } = await import('../scripts/lib/recovery.mjs');
    await scavengeWritableJobs({
      store, dataRoot: fixture.dataRoot, workspace: fixture.workspace,
      reconcileOwnership: async () => {},
      createClient: async () => ({
        listSessions: async () => { throw new PluginError(code, 'endpoint=/secret.sock token=secret owner=secret session=secret', { category: 'runtime', remedy: 'Restart the operation.' }); },
        close: async () => { closes += 1; },
      }),
    });
    const recovered = await store.readJob(fixture.workspace, job.id);
    assert.equal(recovered.status, 'failed', code);
    assert.equal(recovered.error.message, expected, code);
    assert.doesNotMatch(recovered.error.message, /secret/, code);
    assert.equal(closes, 1, code);
  }
});

test('workspace scavenging retains boundaryless writable guards when control cannot disprove an accepted send', async () => {
  for (const status of ['running', 'cancelling']) for (const stage of ['create', 'list', 'read', 'missing']) {
    const fixture = await context(); const { job, store } = await orphanJob(fixture, { boundary: false, status, turnId: `${status}-${stage}` });
    const unavailable = new PluginError('ZCODE_DISCONNECTED', `private ${stage} control details`, { category: 'runtime', remedy: 'Restart the operation.' });
    const { scavengeWritableJobs } = await import('../scripts/lib/recovery.mjs');
    await scavengeWritableJobs({
      store, dataRoot: fixture.dataRoot, workspace: fixture.workspace,
      reconcileOwnership: async () => {},
      createClient: async () => {
        if (stage === 'create') throw unavailable;
        return {
          listSessions: async () => {
            if (stage === 'list') throw unavailable;
            return { sessions: stage === 'missing' ? [] : [{ sessionId: job.zcodeSessionId }] };
          },
          stopSession: async () => {},
          readSession: async () => { if (stage === 'read') throw unavailable; return activeCurrentTurn(undefined, 'idle'); },
          close: async () => {},
        };
      },
    });
    const recovered = await store.readJob(fixture.workspace, job.id);
    assert.equal(recovered.status, 'running', `${status}/${stage}`);
    assert.equal(typeof recovered.lastCancelError, 'string', `${status}/${stage}`);
    assert.ok(Buffer.byteLength(recovered.lastCancelError, 'utf8') <= 2_048, `${status}/${stage}`);
    assert.doesNotMatch(recovered.lastCancelError, /private/, `${status}/${stage}`);
  }
});

test('workspace scavenging ignores read-only and terminal jobs', async () => {
  const fixture = await context(); const store = createStateStore({ dataRoot: fixture.dataRoot });
  const terminal = await store.reserveJob({ workspace: fixture.workspace, ownerSessionId: 'old-terminal', ownerTurnId: 'terminal', command: 'rescue', readOnly: false, permissionSnapshot: { permissionMode: 'workspace-write' } });
  await store.transitionJob(fixture.workspace, terminal.id, ['queued'], 'failed', { error: { message: 'already done' }, finishedAt: new Date().toISOString(), exitCode: 1 });
  const readOnly = await orphanJob(fixture, { ownerSessionId: 'old-reader', turnId: 'reader', readOnly: true });
  const writable = await orphanJob(fixture, { ownerSessionId: 'old-writer', turnId: 'writer' }); const inspected = [];
  const { scavengeWritableJobs } = await import('../scripts/lib/recovery.mjs');
  await scavengeWritableJobs({ store, dataRoot: fixture.dataRoot, workspace: fixture.workspace, reconcileOwnership: async () => {}, createClient: async (job) => { inspected.push(job.id); return recoveryClient(job, { missing: true }); } });
  assert.deepEqual(inspected, [writable.job.id]);
  assert.equal((await store.readJob(fixture.workspace, terminal.id)).status, 'failed');
  assert.equal((await store.readJob(fixture.workspace, readOnly.job.id)).status, 'running');
});

test('workspace scavenging preserves an unclaimed reservation through claim grace and fails it after expiry', async () => {
  const fixture = await context(); const now = Date.now();
  const { job, store } = await orphanJob(fixture, { claim: false, status: 'queued' }); const storage = await resolveWorkspaceStorage({ dataRoot: fixture.dataRoot, workspace: fixture.workspace });
  await atomicWriteJson(join(storage.directory, 'jobs', `${job.id}.json`), { ...job, createdAt: new Date(now - 60_000).toISOString() });
  const { scavengeWritableJobs } = await import('../scripts/lib/recovery.mjs');
  const input = { store, dataRoot: fixture.dataRoot, workspace: fixture.workspace, now: () => now, reconcileOwnership: async () => { throw new Error('queued reservation needs no ownership'); }, createClient: async () => { throw new Error('queued reservation needs no client'); } };
  await scavengeWritableJobs(input); assert.equal((await store.readJob(fixture.workspace, job.id)).status, 'queued');
  await atomicWriteJson(join(storage.directory, 'jobs', `${job.id}.json`), { ...(await store.readJob(fixture.workspace, job.id)), createdAt: new Date(now - 600_000).toISOString() });
  await scavengeWritableJobs(input); assert.equal((await store.readJob(fixture.workspace, job.id)).status, 'failed');
});

test('workspace scavenging fails closed on corrupt or contradictory private execution-fence evidence', async () => {
  for (const mode of ['corrupt-authority', 'contradictory-lease']) {
    const fixture = await context(); const store = createStateStore({ dataRoot: fixture.dataRoot });
    const job = await store.reserveJob({
      workspace: fixture.workspace, ownerSessionId: 'owner', ownerTurnId: mode,
      command: 'rescue', readOnly: false, permissionSnapshot: { permissionMode: 'workspace-write' },
    });
    const authority = {
      version: 1, capabilityDigest: 'a'.repeat(64), reservationId: 'b'.repeat(64),
      jobId: job.id, ownerSessionId: job.ownerSessionId, workspace: job.workspace,
      operation: 'run-reserved-job', jobSpecFormat: 'sealed-v2', workerLeaseId: 'c'.repeat(64),
    };
    await store.publishJobSpecCommitment(fixture.workspace, job.id, 'd'.repeat(64), authority);
    const wrapped = {
      ...store,
      readJob: async (...args) => {
        const current = await store.readJob(...args);
        return mode === 'corrupt-authority'
          ? { ...current, rescueExecutionReservation: { ...current.rescueExecutionReservation, unexpected: true } }
          : { ...current, workerLeaseId: 'e'.repeat(64) };
      },
      finishJob: async () => { assert.fail(`${mode} must not terminalize uncertain fence ownership`); },
    };
    let clients = 0;
    const { scavengeWritableJobs } = await import('../scripts/lib/recovery.mjs');
    const outcomes = await scavengeWritableJobs({
      store: wrapped, dataRoot: fixture.dataRoot, workspace: fixture.workspace,
      now: () => Date.parse(job.createdAt) + 10 * 60_000,
      reconcileOwnership: async () => { assert.fail(`${mode} must not reconcile remote ownership`); },
      createClient: async () => { clients += 1; throw new Error('unreachable'); },
    });
    assert.equal(clients, 0, mode);
    assert.equal(outcomes.at(-1).status, 'queued', mode);
    assert.equal((await store.readJob(fixture.workspace, job.id)).status, 'queued', mode);
    await cleanupRecoveryFixture(fixture);
  }
});

test('queued recovery and SessionEnd cannot terminalize a worker fence published after their first read', async () => {
  for (const settlement of ['recovery', 'session-end']) {
    const fixture = await context(); const store = createStateStore({ dataRoot: fixture.dataRoot });
    const job = await store.reserveJob({
      workspace: fixture.workspace, ownerSessionId: 'owner', ownerTurnId: settlement,
      command: 'rescue', readOnly: false, permissionSnapshot: { permissionMode: 'workspace-write' },
    });
    const authority = {
      version: 1, capabilityDigest: '1'.repeat(64), reservationId: '2'.repeat(64),
      jobId: job.id, ownerSessionId: job.ownerSessionId, workspace: job.workspace,
      operation: 'run-reserved-job', jobSpecFormat: 'sealed-v2',
    };
    await store.publishJobSpecCommitment(fixture.workspace, job.id, '3'.repeat(64), authority);
    let releaseInitialRead; const initialReadReleased = new Promise((resolve) => { releaseInitialRead = resolve; });
    let initialReadReached; const initialRead = new Promise((resolve) => { initialReadReached = resolve; }); let paused = false;
    const wrapped = {
      ...store,
      readJob: async (...args) => {
        const current = await store.readJob(...args);
        if (!paused && current.id === job.id && current.status === 'queued'
          && current.rescueExecutionReservation?.workerLeaseId === undefined) {
          paused = true; initialReadReached(); await initialReadReleased;
        }
        return current;
      },
    };
    const { scavengeWritableJobs, settleEndedOwnerWritableJob, withWorkerLease } = await import('../scripts/lib/recovery.mjs');
    const settling = settlement === 'recovery'
      ? scavengeWritableJobs({ store: wrapped, dataRoot: fixture.dataRoot, workspace: fixture.workspace,
        now: () => Date.parse(job.createdAt) + 10 * 60_000,
        createClient: async () => { throw new Error('queued fence race must not create a client'); } })
      : settleEndedOwnerWritableJob({ store: wrapped, dataRoot: fixture.dataRoot, workspace: fixture.workspace,
        ownerSessionId: job.ownerSessionId, lockTimeoutMs: 0,
        createClient: async () => { throw new Error('queued fence race must not create a client'); } });
    await initialRead;
    const lease = settlement === 'recovery' ? '4'.repeat(64) : '5'.repeat(64);
    let releaseWorker; const workerReleased = new Promise((resolve) => { releaseWorker = resolve; });
    let fencePublished; const fenced = new Promise((resolve) => { fencePublished = resolve; });
    const worker = withWorkerLease({ dataRoot: fixture.dataRoot, workspace: fixture.workspace,
      jobId: job.id, workerLeaseId: lease }, async () => {
      await store.bindJobExecutionReservationLease(fixture.workspace, job.id, {
        capabilityDigest: authority.capabilityDigest, reservationId: authority.reservationId, workerLeaseId: lease,
      });
      fencePublished(); await workerReleased;
    });
    await fenced; releaseInitialRead();
    await settling;
    const retained = await store.readJob(fixture.workspace, job.id);
    assert.equal(retained.status, 'queued', settlement);
    assert.equal(retained.rescueExecutionReservation.workerLeaseId, lease, settlement);
    releaseWorker(); await worker; await cleanupRecoveryFixture(fixture);
  }
});

test('workspace scavenging stops an active orphan and rereads completion before terminalizing', async () => {
  const fixture = await context(); const { job, store } = await orphanJob(fixture); let reads = 0; let stops = 0;
  const completed = coherentCurrentTurn('accepted-input', 'completion won the stop race');
  const { scavengeWritableJobs } = await import('../scripts/lib/recovery.mjs');
  await scavengeWritableJobs({ store, dataRoot: fixture.dataRoot, workspace: fixture.workspace, reconcileOwnership: async () => {}, createClient: async () => ({
    listSessions: async () => ({ sessions: [{ sessionId: job.zcodeSessionId }] }),
    readSession: async () => { reads += 1; return reads === 1 ? activeCurrentTurn(job.inputId) : completed; },
    stopSession: async () => { stops += 1; }, close: async () => {},
  }) });
  const recovered = await store.readJob(fixture.workspace, job.id);
  assert.equal(recovered.status, 'succeeded'); assert.equal(stops, 1); assert.equal(reads, 2); assert.ok(recovered.resultArtifact);
  const storage = await resolveWorkspaceStorage({ dataRoot: fixture.dataRoot, workspace: fixture.workspace });
  assert.equal(await readFile(join(storage.directory, recovered.resultArtifact), 'utf8'), 'completion won the stop race');
  const log = await readFile(recovered.logFile, 'utf8');
  assert.equal((log.match(/Final output/g) ?? []).length, 1); assert.match(log, /Final output\ncompletion won the stop race\n/);
  assert.doesNotMatch(log, /Assistant message/);
});

test('workspace scavenging retains an unattributable active snapshot without stopping', async () => {
  const fixture = await context(); const { job, store } = await orphanJob(fixture); let stops = 0;
  const { scavengeWritableJobs } = await import('../scripts/lib/recovery.mjs');
  await scavengeWritableJobs({
    store, dataRoot: fixture.dataRoot, workspace: fixture.workspace, reconcileOwnership: async () => {},
    createClient: async () => recoveryClient(job, {
      snapshot: { projection: { status: 'running' }, runtime: { stateRevision: 8 }, messages: [] },
      onStop: () => { stops += 1; },
    }),
  });
  const retained = await store.readJob(fixture.workspace, job.id);
  assert.equal(retained.status, 'running'); assert.equal(stops, 0);
});

test('owner recovery retains unresolved empty idle and later publishes one coherent current-turn result', async () => {
  const fixture = await context(); const { job, store } = await orphanJob(fixture); let phase = 0; let stops = 0;
  const snapshots = [
    { projection: { status: 'idle' }, runtime: { stateRevision: 7 }, messages: [] },
    { projection: { status: 'running' }, runtime: { stateRevision: 8 }, messages: [{ info: { role: 'user', messageId: 'accepted-input' }, parts: [{ type: 'text', text: 'task' }] }] },
    { projection: { status: 'completed' }, runtime: { stateRevision: 9 }, messages: [
      { info: { role: 'user', messageId: 'accepted-input' }, parts: [{ type: 'text', text: 'task' }] },
      { info: { role: 'assistant', messageId: 'answer-current', parentMessageId: 'accepted-input', finish: 'stop' }, parts: [{ type: 'text', text: 'recovered current turn' }] },
    ] },
  ];
  const { reconcileOwnedJobs } = await import('../scripts/lib/recovery.mjs');
  const recover = () => reconcileOwnedJobs({
    store, dataRoot: fixture.dataRoot, workspace: fixture.workspace, ownerSessionId: job.ownerSessionId,
    reconcileOwnership: async () => {},
    createClient: async () => ({
      listSessions: async () => ({ sessions: [{ sessionId: job.zcodeSessionId }] }),
      readSession: async () => snapshots[phase],
      stopSession: async () => { stops += 1; }, close: async () => {},
    }),
  });

  await recover(); assert.equal((await store.readJob(fixture.workspace, job.id)).status, 'running');
  phase = 1; await recover(); assert.equal((await store.readJob(fixture.workspace, job.id)).status, 'running');
  phase = 2; await recover(); const recovered = await store.readJob(fixture.workspace, job.id);
  assert.equal(recovered.status, 'succeeded'); assert.equal(stops, 0);
  const storage = await resolveWorkspaceStorage({ dataRoot: fixture.dataRoot, workspace: fixture.workspace });
  assert.equal(await readFile(join(storage.directory, recovered.resultArtifact), 'utf8'), 'recovered current turn');
  await recover(); const log = await readFile(recovered.logFile, 'utf8');
  assert.equal((log.match(/Final output/g) ?? []).length, 1);
});

test('recovery log attachment and Final append failures emit one fixed safe diagnostic without changing the winner', async () => {
  const { scavengeWritableJobs } = await import('../scripts/lib/recovery.mjs');
  for (const failure of ['attach', 'final']) {
    const fixture = await context(); const { job, store } = await orphanJob(fixture, { ownerSessionId: `owner-${failure}` }); const lines = [];
    let replaced = false;
    const replaceLog = async () => {
      if (replaced) return; replaced = true;
      const current = await store.readJob(fixture.workspace, job.id); await rm(current.logFile); await mkdir(current.logFile);
    };
    const wrapped = {
      ...store,
      ...(failure === 'attach' ? { attachJobLog: async () => { throw new Error('PRIVATE_RECOVERY_ATTACH_PATH'); } } : {}),
      ...(failure === 'final' ? { finishJob: async (...args) => { const winner = await store.finishJob(...args); if (args[3] === 'succeeded') await replaceLog(); return winner; } } : {}),
    };
    const snapshot = coherentCurrentTurn(job.inputId, `recovered despite ${failure}`);
    await scavengeWritableJobs({ store: wrapped, dataRoot: fixture.dataRoot, workspace: fixture.workspace, reconcileOwnership: async () => {}, createClient: async () => recoveryClient(job, { snapshot }), progressWriter: (line) => lines.push(line) });
    const winner = await store.readJob(fixture.workspace, job.id); assert.equal(winner.status, 'succeeded'); assert.ok(winner.resultArtifact);
    if (failure === 'final') assert.equal(replaced, true);
    assert.equal(lines.filter((line) => line === '[zcode] ZCode job log was disabled.\n').length, 1, failure);
    assert.doesNotMatch(lines.join(''), /PRIVATE_RECOVERY_ATTACH_PATH|zcode-recovery-|\.log/u, failure);
  }
});

test('recovery success finalization failure preserves the result for a later retry', async () => {
  const fixture = await context(); const { job, store } = await orphanJob(fixture); const storageError = new PluginError('JSON_WRITE_FAILED', 'recovery success write failed once', { category: 'storage', remedy: 'retry recovery' }); let failedWrites = 0; let successWrites = 0; let failSuccess = true;
  const wrapped = { ...store, finishJob: async (workspace, jobId, expected, next, patch) => { if (next === 'succeeded') { successWrites += 1; if (failSuccess) { failSuccess = false; throw storageError; } } else failedWrites += 1; return store.finishJob(workspace, jobId, expected, next, patch); } };
  const completed = coherentCurrentTurn('accepted-input', 'recover this result later');
  const { scavengeWritableJobs } = await import('../scripts/lib/recovery.mjs');
  await assert.rejects(scavengeWritableJobs({ store: wrapped, dataRoot: fixture.dataRoot, workspace: fixture.workspace, reconcileOwnership: async () => {}, createClient: async () => recoveryClient(job, { snapshot: completed }) }), (error) => error === storageError || error?.cause === storageError);
  assert.equal(successWrites, 1); assert.equal(failedWrites, 0); assert.equal((await store.readJob(fixture.workspace, job.id)).status, 'running');
  const storage = await resolveWorkspaceStorage({ dataRoot: fixture.dataRoot, workspace: fixture.workspace }); assert.equal(await readFile(join(storage.directory, 'results', `${job.id}.md`), 'utf8'), 'recover this result later');
  assert.doesNotMatch(await readFile((await store.readJob(fixture.workspace, job.id)).logFile, 'utf8'), /Assistant message|Final output/);
  await scavengeWritableJobs({ store: wrapped, dataRoot: fixture.dataRoot, workspace: fixture.workspace, reconcileOwnership: async () => {}, createClient: async () => recoveryClient(job, { snapshot: completed }) }); const recovered = await store.readJob(fixture.workspace, job.id); assert.equal(recovered.status, 'succeeded'); assert.equal(successWrites, 2); assert.equal(failedWrites, 0); assert.equal(await readFile(join(storage.directory, recovered.resultArtifact), 'utf8'), 'recover this result later');
  const log = await readFile(recovered.logFile, 'utf8');
  assert.equal((log.match(/Final output/g) ?? []).length, 1); assert.match(log, /Final output\nrecover this result later\n/);
});

test('acknowledged stop retains a cancelling orphan when post-stop completion has no coherent current-turn result', async () => {
  const fixture = await context(); const { job, store } = await orphanJob(fixture, { status: 'cancelling' }); let reads = 0; let stops = 0;
  const { scavengeWritableJobs } = await import('../scripts/lib/recovery.mjs');
  await scavengeWritableJobs({ store, dataRoot: fixture.dataRoot, workspace: fixture.workspace, reconcileOwnership: async () => {}, createClient: async () => ({
    listSessions: async () => ({ sessions: [{ sessionId: job.zcodeSessionId }] }),
    readSession: async () => { reads += 1; return reads === 1
      ? activeCurrentTurn(job.inputId)
      : { projection: { status: 'completed' }, runtime: { stateRevision: 8 }, messages: [] }; },
    stopSession: async () => { stops += 1; }, close: async () => {},
  }) });
  const recovered = await store.readJob(fixture.workspace, job.id);
  assert.equal(recovered.status, 'running'); assert.equal(stops, 1); assert.equal(reads, 2); assert.equal(recovered.resultArtifact, undefined);
  assert.match(recovered.lastCancelError, /unresolved/);
  assert.doesNotMatch(await readFile(recovered.logFile, 'utf8'), /Assistant message|Final output/);
});

test('workspace scavenging retains the writable guard when active stop is unacknowledged', async () => {
  const fixture = await context(); const { job, store } = await orphanJob(fixture); const longError = `stop refused ${'x'.repeat(3_000)}`;
  const { scavengeWritableJobs } = await import('../scripts/lib/recovery.mjs');
  await scavengeWritableJobs({ store, dataRoot: fixture.dataRoot, workspace: fixture.workspace, reconcileOwnership: async () => {}, createClient: async () => recoveryClient(job, { stopError: new Error(longError) }) });
  const recovered = await store.readJob(fixture.workspace, job.id);
  assert.equal(recovered.status, 'running'); assert.match(recovered.lastCancelError, /stop refused/); assert.ok(recovered.lastCancelError.length <= 2_048);
  await assert.rejects(store.reserveJob({ workspace: fixture.workspace, ownerSessionId: 'new-owner', ownerTurnId: 'new', command: 'rescue', readOnly: false, permissionSnapshot: { permissionMode: 'workspace-write' } }), { code: 'WRITABLE_JOB_EXISTS' });
});

test('workspace scavenging maps paused running to failed but requires stop acknowledgement for cancelling', async () => {
  for (const [status, stopAcknowledged, expected] of [['running', true, 'failed'], ['cancelling', true, 'running'], ['cancelling', false, 'running']]) {
    const fixture = await context(); const { job, store } = await orphanJob(fixture, { status, turnId: `${status}-${stopAcknowledged}` }); let stops = 0;
    const { scavengeWritableJobs } = await import('../scripts/lib/recovery.mjs');
    await scavengeWritableJobs({ store, dataRoot: fixture.dataRoot, workspace: fixture.workspace, reconcileOwnership: async () => {}, createClient: async () => recoveryClient(job, {
      snapshot: activeCurrentTurn(job.inputId, 'paused'), onStop: () => { stops += 1; }, ...(stopAcknowledged ? {} : { stopError: new Error('paused stop refused') }),
    }) });
    const recovered = await store.readJob(fixture.workspace, job.id);
    assert.equal(recovered.status, expected, `${status}/${stopAcknowledged}`); assert.equal(stops, status === 'cancelling' ? 1 : 0);
  }
});

test('workspace scavenging fails an orphan whose persisted remote session is missing', async () => {
  const fixture = await context(); const { job, store } = await orphanJob(fixture); let stops = 0;
  const { scavengeWritableJobs } = await import('../scripts/lib/recovery.mjs');
  await scavengeWritableJobs({ store, dataRoot: fixture.dataRoot, workspace: fixture.workspace, reconcileOwnership: async () => {}, createClient: async () => recoveryClient(job, { missing: true, onStop: () => { stops += 1; } }) });
  const recovered = await store.readJob(fixture.workspace, job.id); assert.equal(recovered.status, 'failed'); assert.equal(recovered.error.message, 'ZCode session is missing during recovery.'); assert.equal(stops, 0);
});

test('terminal completion racing orphan settlement is never overwritten', async () => {
  const fixture = await context(); const { job, store } = await orphanJob(fixture); let raced = false;
  const wrapped = { ...store, finishJob: async (...args) => {
    if (!raced && args[3] === 'failed') {
      raced = true;
      await store.finishJob(fixture.workspace, job.id, ['running'], 'succeeded', { resultArtifact: `results/${job.id}.md`, exitCode: 0 });
    }
    return store.finishJob(...args);
  } };
  const { scavengeWritableJobs } = await import('../scripts/lib/recovery.mjs');
  await scavengeWritableJobs({ store: wrapped, dataRoot: fixture.dataRoot, workspace: fixture.workspace, reconcileOwnership: async () => {}, createClient: async () => recoveryClient(job, { snapshot: activeCurrentTurn(job.inputId, 'paused') }) });
  const winner = await store.readJob(fixture.workspace, job.id); assert.equal(winner.status, 'succeeded');
  assert.doesNotMatch(await readFile(winner.logFile, 'utf8'), /Assistant message|Final output/);
});

test('background preparation failures terminalize the reservation and release the writable slot', async () => {
  for (const dependency of ['writeJobSpec', 'createExecutionCapability']) {
    const fixture = await context(); const failure = Object.assign(new Error(`${dependency} failed`), { code: 'EIO' });
    const dependencies = dependency === 'writeJobSpec'
      ? { writeJobSpec: async () => { throw failure; } }
      : { createExecutionCapability: async () => { throw failure; } };
    await assert.rejects(runCompanion(['rescue', '--background', '--fresh', 'repair'], { cwd: fixture.workspace, env: fixture.env, authorization: { callerContext: fixture.callerContext }, dependencies }), failure);
    const store = createStateStore({ dataRoot: fixture.dataRoot }); const failed = (await store.listJobs(fixture.workspace))[0];
    assert.equal(failed.status, 'failed'); assert.equal(failed.exitCode, 1); assert.ok(failed.finishedAt); assert.match(failed.error.message, /failed/);
    const later = await store.reserveJob({ workspace: fixture.workspace, ownerSessionId: 'owner', ownerTurnId: 'later', command: 'rescue', readOnly: false, permissionSnapshot: { permissionMode: 'workspace-write' } });
    assert.equal(later.status, 'queued');
  }
});

test('delivery failure revokes the minted capability and fails the queued job', async () => {
  const fixture = await context();
  const output = await runCompanion(['rescue', '--background', '--fresh', 'repair'], { cwd: fixture.workspace, env: fixture.env, authorization: { callerContext: fixture.callerContext } });
  await failBackgroundDelivery(output, Object.assign(new Error('fd4 closed'), { code: 'EPIPE' }));
  const binding = { jobId: output.job.id, ownerSessionId: 'owner', workspace: fixture.workspace,
    operation: 'run-reserved-job', jobSpecFormat: 'sealed-v2' };
  await assert.rejects(fixture.identity.consumeExecutionCapability(output.executionCapability, binding), { code: 'EXECUTION_CAPABILITY_REVOKED' });
  assert.equal((await createStateStore({ dataRoot: fixture.dataRoot }).readJob(fixture.workspace, output.job.id)).status, 'failed');
});

test('foreground executions persist an exact worker lease identity', async (t) => {
  const fixture = await context();
  t.after(() => cleanupRecoveryFixture(fixture));
  const output = await runCompanion(['rescue', '--fresh', 'repair'], { cwd: fixture.workspace, env: { ...fixture.env, ZCODE_PATH: fakeZCode }, authorization: { callerContext: fixture.callerContext } });
  const persisted = await createStateStore({ dataRoot: fixture.dataRoot }).readJob(fixture.workspace, output.job.id);
  assert.equal(persisted.childPid, process.pid); assert.match(persisted.workerLeaseId, /^[a-f0-9]{64}$/);
});

test('enclosing foreground execution preserves executor ownership after ambiguous read and stop failure', async (t) => {
  for (const stopSucceeds of [false, true]) {
    const fixture = await context();
    t.after(() => cleanupRecoveryFixture(fixture));
    const env = { ...fixture.env, ZCODE_PATH: fakeZCode, FAKE_ZCODE_ERROR: 'session/read', ...(stopSucceeds ? {} : { FAKE_ZCODE_STOP_ERROR_PREFIX: 'session-' }) };
    await assert.rejects(runCompanion(['rescue', '--fresh', `ambiguous-${stopSucceeds}`], { cwd: fixture.workspace, env, authorization: { callerContext: fixture.callerContext } }), /fixture request failed/);
    const store = createStateStore({ dataRoot: fixture.dataRoot }); const [persisted] = await store.listJobs(fixture.workspace);
    assert.equal(persisted.status, stopSucceeds ? 'failed' : 'running');
    if (!stopSucceeds) {
      assert.match(persisted.lastCancelError, /fixture stop failed/);
      await assert.rejects(store.reserveJob({ workspace: fixture.workspace, ownerSessionId: 'owner', ownerTurnId: 'later', command: 'rescue', readOnly: false, permissionSnapshot: { permissionMode: 'workspace-write' } }), { code: 'WRITABLE_JOB_EXISTS' });
    }
  }
});

test('enclosing background execution preserves executor ownership after boundary callback and stop failure', async (t) => {
  for (const stopSucceeds of [false, true]) {
    const fixture = await context();
    t.after(() => cleanupRecoveryFixture(fixture));
    const env = { ...fixture.env, ZCODE_PATH: fakeZCode, ...(stopSucceeds ? {} : { FAKE_ZCODE_STOP_ERROR_PREFIX: 'session-' }) };
    const reserved = await runCompanion(['rescue', '--background', '--fresh', `boundary-${stopSucceeds}`], { cwd: fixture.workspace, env, authorization: { callerContext: fixture.callerContext } });
    await assert.rejects(runCompanion(reserved.privateInvocation, { cwd: fixture.workspace, env, authorization: { executionCapability: reserved.executionCapability, jobId: reserved.job.id }, startupAck: async () => { throw new Error('boundary callback failed'); } }), /boundary callback failed/);
    const store = createStateStore({ dataRoot: fixture.dataRoot }); const persisted = await store.readJob(fixture.workspace, reserved.job.id);
    assert.equal(persisted.status, stopSucceeds ? 'failed' : 'running');
    if (!stopSucceeds) {
      assert.match(persisted.lastCancelError, /fixture stop failed/);
      await assert.rejects(store.reserveJob({ workspace: fixture.workspace, ownerSessionId: 'owner', ownerTurnId: 'later', command: 'rescue', readOnly: false, permissionSnapshot: { permissionMode: 'workspace-write' } }), { code: 'WRITABLE_JOB_EXISTS' });
    }
  }
});

test('foreground and background workers persist their exact lease before discovery', async () => {
  for (const execution of ['foreground', 'background']) {
    const fixture = await context(); const store = createStateStore({ dataRoot: fixture.dataRoot }); let observed;
    const dependencies = { discoverLaunch: async () => { [observed] = await store.listJobs(fixture.workspace); throw new Error(`discovery stopped ${execution}`); } };
    if (execution === 'foreground') {
      await assert.rejects(runCompanion(['rescue', '--fresh', 'repair'], { cwd: fixture.workspace, env: fixture.env, authorization: { callerContext: fixture.callerContext }, dependencies }), /discovery stopped foreground/);
    } else {
      const reserved = await runCompanion(['rescue', '--background', '--fresh', 'repair'], { cwd: fixture.workspace, env: fixture.env, authorization: { callerContext: fixture.callerContext }, dependencies });
      await assert.rejects(runCompanion(reserved.privateInvocation, { cwd: fixture.workspace, env: fixture.env, authorization: { executionCapability: reserved.executionCapability, jobId: reserved.job.id }, dependencies }), /discovery stopped background/);
    }
    assert.equal(observed.status, 'queued', execution); assert.equal(observed.childPid, process.pid, execution); assert.match(observed.workerLeaseId, /^[a-f0-9]{64}$/, execution);
  }
});

test('accepted-send crashes without a durable boundary always retain the writable guard after best-effort stop', async () => {
  for (const stopSucceeds of [true, false]) {
    const fixture = await context(); const { job, store } = await orphanJob(fixture, { boundary: false }); let stops = 0;
    const { reconcileOwnedJobs } = await import('../scripts/lib/recovery.mjs');
    await reconcileOwnedJobs({ store, dataRoot: fixture.dataRoot, workspace: fixture.workspace, ownerSessionId: 'owner', reconcileOwnership: async () => {}, createClient: async () => recoveryClient(job, { onStop: () => { stops += 1; }, ...(stopSucceeds ? {} : { stopError: new Error('stop refused') }) }) });
    const recovered = await store.readJob(fixture.workspace, job.id); assert.equal(stops, 1);
    assert.equal(recovered.status, 'running');
    if (!stopSucceeds) assert.match(recovered.lastCancelError, /stop refused/);
    await assert.rejects(store.reserveJob({ workspace: fixture.workspace, ownerSessionId: 'owner', ownerTurnId: 'later', command: 'rescue', readOnly: false, permissionSnapshot: { permissionMode: 'workspace-write' } }), { code: 'WRITABLE_JOB_EXISTS' });
  }
});

test('ambiguous remote protocol retains the guard unless best-effort stop is acknowledged', async () => {
  const fixture = await context(); const { job, store } = await orphanJob(fixture); let stops = 0;
  const { reconcileOwnedJobs } = await import('../scripts/lib/recovery.mjs');
  await reconcileOwnedJobs({ store, dataRoot: fixture.dataRoot, workspace: fixture.workspace, ownerSessionId: 'owner', reconcileOwnership: async () => {}, createClient: async () => recoveryClient(job, { snapshot: { projection: { status: 'future-state' }, runtime: { stateRevision: 8 }, messages: [] }, onStop: () => { stops += 1; }, stopError: new Error('ambiguous stop refused') }) });
  const recovered = await store.readJob(fixture.workspace, job.id);
  assert.equal(stops, 1); assert.equal(recovered.status, 'running'); assert.match(recovered.lastCancelError, /ambiguous stop refused/);
});

test('cancelling recovery distinguishes completed, stopped, active-acked, and active-unacked remote turns', async () => {
  for (const mode of ['completed', 'paused', 'active-acked', 'active-unacked']) {
    const fixture = await context(); const { job, store } = await orphanJob(fixture, { status: 'cancelling', turnId: mode }); let stops = 0;
    const snapshot = mode === 'completed'
      ? coherentCurrentTurn('accepted-input', 'recovered answer')
      : activeCurrentTurn(job.inputId, mode === 'paused' ? 'paused' : 'running');
    const { reconcileOwnedJobs } = await import('../scripts/lib/recovery.mjs');
    await reconcileOwnedJobs({ store, dataRoot: fixture.dataRoot, workspace: fixture.workspace, ownerSessionId: 'owner', reconcileOwnership: async () => {}, createClient: async () => recoveryClient(job, { snapshot, onStop: () => { stops += 1; }, ...(mode === 'active-unacked' ? { stopError: new Error('retry stop') } : {}) }) });
    const recovered = await store.readJob(fixture.workspace, job.id);
    assert.equal(recovered.status, mode === 'completed' ? 'succeeded' : 'running', mode);
    assert.equal(stops, mode === 'paused' || mode.startsWith('active') ? 1 : 0, mode);
    if (mode === 'active-unacked') assert.match(recovered.lastCancelError, /retry stop/);
    const log = await readFile(recovered.logFile, 'utf8');
    if (mode === 'completed') {
      assert.equal((log.match(/Final output/g) ?? []).length, 1); assert.match(log, /Final output\nrecovered answer\n/);
    } else assert.doesNotMatch(log, /Assistant message|Final output/);
  }
});

test('queued recovery keeps live claims, fails orphan claims, and ages legacy reservations conservatively', async () => {
  const fixture = await context(); const now = Date.now(); const { reconcileOwnedJobs, withWorkerLease } = await import('../scripts/lib/recovery.mjs');
  const active = await orphanJob(fixture, { status: 'queued', turnId: 'active', workerLeaseId: 'a'.repeat(64) });
  const orphan = await orphanJob(fixture, { status: 'queued', turnId: 'orphan', workerLeaseId: 'b'.repeat(64), readOnly: true });
  const recent = await orphanJob(fixture, { status: 'queued', turnId: 'recent', claim: false, readOnly: true });
  const stale = await orphanJob(fixture, { status: 'queued', turnId: 'stale', claim: false, readOnly: true });
  const storage = await resolveWorkspaceStorage({ dataRoot: fixture.dataRoot, workspace: fixture.workspace });
  await atomicWriteJson(join(storage.directory, 'jobs', `${stale.job.id}.json`), { ...stale.job, createdAt: new Date(now - 600_000).toISOString(), updatedAt: new Date(now - 600_000).toISOString() });
  const activeLease = withWorkerLease({ dataRoot: fixture.dataRoot, workspace: fixture.workspace, jobId: active.job.id, workerLeaseId: active.workerLeaseId }, async () => {
    await reconcileOwnedJobs({ store: active.store, dataRoot: fixture.dataRoot, workspace: fixture.workspace, ownerSessionId: 'owner', now: () => now, reconcileOwnership: async () => {}, createClient: async () => { throw new Error('queued jobs need no client'); } });
  });
  await activeLease;
  assert.equal((await active.store.readJob(fixture.workspace, active.job.id)).status, 'queued');
  assert.equal((await orphan.store.readJob(fixture.workspace, orphan.job.id)).status, 'failed');
  assert.equal((await recent.store.readJob(fixture.workspace, recent.job.id)).status, 'queued');
  assert.equal((await stale.store.readJob(fixture.workspace, stale.job.id)).status, 'failed');
});

test('legacy running jobs with a live recorded process are not reconciled during upgrade', async () => {
  const fixture = await context(); const store = createStateStore({ dataRoot: fixture.dataRoot });
  const reserved = await store.reserveJob({ workspace: fixture.workspace, ownerSessionId: 'owner', ownerTurnId: 'legacy-live', command: 'review', readOnly: false, permissionSnapshot: { permissionMode: 'workspace-write' } });
  await store.transitionJob(fixture.workspace, reserved.id, ['queued'], 'running', { childPid: process.pid, startedAt: new Date().toISOString(), zcodeSessionId: 'legacy-session' });
  await store.transitionJob(fixture.workspace, reserved.id, ['running'], 'running', { inputId: 'legacy-input', startRevision: 1, beforeMessageIds: [] });
  let clients = 0; const { reconcileOwnedJobs } = await import('../scripts/lib/recovery.mjs');
  await reconcileOwnedJobs({ store, dataRoot: fixture.dataRoot, workspace: fixture.workspace, ownerSessionId: 'owner', reconcileOwnership: async () => {}, createClient: async () => { clients += 1; throw new Error('must not inspect a live legacy worker'); } });
  assert.equal(clients, 0); assert.equal((await store.readJob(fixture.workspace, reserved.id)).status, 'running');
});

test('orphan Transfer stops a known remote session before failure and retains it when stop is unacknowledged', async () => {
  for (const scenario of ['no-session', 'known-acked', 'known-unacked']) {
    const fixture = await context(); const { job, store } = await orphanJob(fixture, { command: 'transfer', readOnly: true, boundary: false, sessionId: scenario === 'no-session' ? false : 'transfer-session', turnId: scenario }); let clients = 0; let stops = 0;
    const { reconcileOwnedJobs } = await import('../scripts/lib/recovery.mjs');
    await reconcileOwnedJobs({ store, dataRoot: fixture.dataRoot, workspace: fixture.workspace, ownerSessionId: 'owner', reconcileOwnership: async () => {}, createClient: async () => { clients += 1; return recoveryClient(job, { onStop: () => { stops += 1; }, ...(scenario === 'known-unacked' ? { stopError: new Error('transfer stop refused') } : {}) }); } });
    const recovered = await store.readJob(fixture.workspace, job.id);
    assert.equal(clients, scenario === 'no-session' ? 0 : 1, scenario); assert.equal(stops, scenario === 'no-session' ? 0 : 1, scenario);
    assert.equal(recovered.status, scenario === 'known-unacked' ? 'running' : 'failed', scenario);
    if (scenario === 'known-unacked') assert.match(recovered.lastCancelError, /transfer stop refused/);
  }
});

for (const execution of ['foreground', 'background']) {
  test(`${execution} accepted send survives a lost worker response through status and result recovery`, async (t) => {
    const fixture = await context(); const control = join(fixture.root, `${execution}-response-loss-control.json`); const record = join(fixture.root, `${execution}-response-loss-record.jsonl`);
    await Promise.all([writeFile(control, JSON.stringify({ mode: 'active' })), writeFile(record, '')]);
    const env = { ...fixture.env, ZCODE_PATH: fakeZCode, FAKE_ZCODE_RECOVERY_CONTROL: control, FAKE_ZCODE_RECORD: record, FAKE_ZCODE_SUPPRESS_FIRST_COMPLETION: '1' };
    let args = ['rescue', '--fresh', `${execution} response loss`]; let authorization = { callerContext: fixture.callerContext };
    let jobId;
    if (execution === 'background') {
      const reserved = await runCompanion([...args.slice(0, 1), '--background', ...args.slice(1)], { cwd: fixture.workspace, env, authorization });
      jobId = reserved.job.id; args = reserved.privateInvocation; authorization = { executionCapability: reserved.executionCapability, jobId };
    }
    const child = spawn(process.execPath, [companionCli, ...args], { cwd: fixture.workspace, env, stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'ignore'], shell: false });
    let exited = false; const childExit = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', () => { exited = true; resolve(undefined); }); });
    /** @type {import('node:stream').Writable} */ (child.stdio[3]).end(`${JSON.stringify(authorization)}\n`);
    const store = createStateStore({ dataRoot: fixture.dataRoot });
    const running = jobId
      ? await waitForJob(store, fixture.workspace, jobId, (job) => job.status === 'running' && typeof job.inputId === 'string')
      : await waitForJob({ readJob: async () => (await store.listOwnedJobs(fixture.workspace, 'owner')).at(-1) }, fixture.workspace, undefined, (job) => job?.status === 'running' && typeof job.inputId === 'string');
    jobId = running.id;
    t.after(async () => { if (!exited) { try { child.kill('SIGKILL'); } catch { /* already exited */ } await childExit.catch(() => {}); } await cleanupRecoveryFixture(fixture); });
    child.kill('SIGKILL'); await childExit;
    await writeFile(control, JSON.stringify({ mode: 'completed' }));

    const status = await runCompanion(['status', jobId], { cwd: fixture.workspace, env, authorization: { callerContext: fixture.callerContext } });
    assert.equal(status.job.status, 'succeeded', execution);
    const result = await runCompanion(['result', jobId], { cwd: fixture.workspace, env, authorization: { callerContext: fixture.callerContext } });
    assert.equal(result.result, 'done', execution);
    const recovered = await store.readJob(fixture.workspace, jobId); const calls = (await readFile(record, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
    assert.equal(recovered.status, 'succeeded', execution); assert.equal(typeof recovered.resultArtifact, 'string', execution);
    assert.equal(await readFile(join((await resolveWorkspaceStorage({ dataRoot: fixture.dataRoot, workspace: fixture.workspace })).directory, recovered.resultArtifact), 'utf8'), 'done', execution);
    assert.equal(calls.filter((frame) => frame.method === 'session/send').length, 1, `${execution}: exactly one accepted send`);
    assert.equal(calls.filter((frame) => frame.method === 'session/create').length, 1, `${execution}: recovery must not create a fresh session`);
    assert.equal(calls.filter((frame) => frame.method === 'session/resume').length, 0, `${execution}: recovery must not resend through resume`);
    assert.equal(calls.filter((frame) => frame.method === 'session/stop').length, 0, `${execution}: completed recovery must not roll back remotely`);
    assert.deepEqual((await store.listOwnedJobs(fixture.workspace, 'owner')).map((job) => job.id), [jobId], `${execution}: recovery must retain the same owned job`);
  });
}

test('a crashed real background worker reconciles remote terminal state without failing remote active work', async (t) => {
  for (const [remoteMode, expectedStatus] of [['completed', 'succeeded'], ['stopped', 'failed'], ['missing', 'failed']]) {
    const fixture = await context(); const control = join(fixture.root, 'recovery-control.json'); await writeFile(control, JSON.stringify({ mode: 'active' }));
    const env = { ...fixture.env, ZCODE_PATH: fakeZCode, FAKE_ZCODE_RECOVERY_CONTROL: control, FAKE_ZCODE_SUPPRESS_FIRST_COMPLETION: '1' };
    const started = await runCompanion(['rescue', '--background', '--fresh', `recover ${remoteMode}`], { cwd: fixture.workspace, env, authorization: { callerContext: fixture.callerContext }, autoLaunchBackground: true });
    const store = createStateStore({ dataRoot: fixture.dataRoot });
    const running = await waitForJob(store, fixture.workspace, started.job.id, (job) => job.status === 'running' && job.childPid && job.inputId);
    t.after(async () => { if (processAlive(running.childPid)) try { process.kill(running.childPid, 'SIGKILL'); } catch { /* already exited */ } await cleanupRecoveryFixture(fixture); });
    assert.equal((await runCompanion(['status', running.id], { cwd: fixture.workspace, env, authorization: { callerContext: fixture.callerContext } })).job.status, 'running', 'a healthy worker must never be reconciled away');
    process.kill(running.childPid, 'SIGKILL'); const exitDeadline = Date.now() + 2_000; while (processAlive(running.childPid) && Date.now() < exitDeadline) await new Promise((resolve) => setTimeout(resolve, 10)); assert.equal(processAlive(running.childPid), false);
    const storage = await resolveWorkspaceStorage({ dataRoot: fixture.dataRoot, workspace: fixture.workspace });
    await atomicWriteJson(join(storage.directory, 'jobs', `${running.id}.json`), { ...(await store.readJob(fixture.workspace, running.id)), childPid: process.pid });
    assert.equal((await runCompanion(['status', running.id], { cwd: fixture.workspace, env, authorization: { callerContext: fixture.callerContext } })).job.status, 'running', 'an orphan with a provably remote-active turn stays running');
    let reconciled;
    if (remoteMode === 'completed') {
      const update = setTimeout(() => { void writeFile(control, JSON.stringify({ mode: remoteMode })); }, 50);
      t.after(() => clearTimeout(update));
      reconciled = await runCompanion(['status', running.id, '--wait', '--timeout-ms', '1000'], { cwd: fixture.workspace, env, authorization: { callerContext: fixture.callerContext } });
    } else {
      await writeFile(control, JSON.stringify({ mode: remoteMode }));
      reconciled = await runCompanion(['status', running.id], { cwd: fixture.workspace, env, authorization: { callerContext: fixture.callerContext } });
    }
    assert.equal(reconciled.job.status, expectedStatus, remoteMode);
    if (remoteMode === 'completed') {
      const result = (await runCompanion(['result', running.id], { cwd: fixture.workspace, env, authorization: { callerContext: fixture.callerContext } })).result;
      assert.equal(result, 'done'); assert.doesNotMatch(result, /historical-result/);
    }
  }
});

test('reconciliation retains one ambiguous owned job, continues siblings, and never scans another owner', async () => {
  const fixture = await context(); const store = createStateStore({ dataRoot: fixture.dataRoot }); const jobs = [];
  for (const [ownerSessionId, suffix, leaseCharacter] of [['owner', 'bad', 'a'], ['owner', 'good', 'b'], ['sibling', 'sibling', 'c']]) {
    const job = await store.reserveJob({ workspace: fixture.workspace, ownerSessionId, ownerTurnId: suffix, command: 'rescue', readOnly: true, permissionSnapshot: { permissionMode: 'workspace-write' } });
    await store.transitionJob(fixture.workspace, job.id, ['queued'], 'running', { childPid: 999999, workerLeaseId: leaseCharacter.repeat(64), startedAt: new Date().toISOString(), zcodeSessionId: `session-${suffix}` });
    jobs.push(await store.transitionJob(fixture.workspace, job.id, ['running'], 'running', { inputId: `input-${suffix}`, startRevision: 1, beforeMessageIds: [] }));
  }
  const [bad, good, sibling] = jobs; const created = []; let closes = 0;
  const { reconcileOwnedJobs } = await import('../scripts/lib/recovery.mjs');
  await reconcileOwnedJobs({ store, dataRoot: fixture.dataRoot, workspace: fixture.workspace, ownerSessionId: 'owner', reconcileOwnership: async () => {}, createClient: async (job) => {
    created.push(job.id); if (job.id === bad.id) throw new Error('broken recovery client');
    return { listSessions: async () => ({ sessions: [{ sessionId: job.zcodeSessionId }] }), readSession: async () => ({ ...coherentCurrentTurn(job.inputId, `recovered ${job.id}`), runtime: { stateRevision: 2 } }), close: async () => { closes += 1; } };
  } });
  assert.equal((await store.readJob(fixture.workspace, bad.id)).status, 'running');
  assert.equal((await store.readJob(fixture.workspace, good.id)).status, 'succeeded');
  assert.equal((await store.readJob(fixture.workspace, sibling.id)).status, 'running');
  assert.deepEqual(created.sort(), [bad.id, good.id].sort()); assert.equal(closes, 1);
});

test('owned recovery ignores a foreign corrupt job through its trusted owner binding', async () => {
  const fixture = await context(); const store = createStateStore({ dataRoot: fixture.dataRoot }); const jobs = [];
  for (const [ownerSessionId, suffix, lease] of [['owner', 'mine', 'a'], ['foreign-owner', 'foreign', 'b']]) {
    const reserved = await store.reserveJob({ workspace: fixture.workspace, ownerSessionId, ownerTurnId: suffix, command: 'rescue', readOnly: true, permissionSnapshot: { permissionMode: 'workspace-write' } });
    await store.claimJobWorker(fixture.workspace, reserved.id, { childPid: 999999, workerLeaseId: lease.repeat(64) });
    await store.transitionJob(fixture.workspace, reserved.id, ['queued'], 'running', { startedAt: new Date().toISOString(), zcodeSessionId: `session-${suffix}` });
    jobs.push(await store.transitionJob(fixture.workspace, reserved.id, ['running'], 'running', { inputId: `input-${suffix}`, startRevision: 1, beforeMessageIds: [] }));
  }
  const [mine, foreign] = jobs; const storage = await resolveWorkspaceStorage({ dataRoot: fixture.dataRoot, workspace: fixture.workspace });
  await writeFile(join(storage.directory, 'jobs', `${foreign.id}.json`), '{');
  let clients = 0;
  const { reconcileOwnedJobs } = await import('../scripts/lib/recovery.mjs');
  const recovered = await reconcileOwnedJobs({
    store, dataRoot: fixture.dataRoot, workspace: fixture.workspace, ownerSessionId: 'owner', reconcileOwnership: async () => {},
    createClient: async (job) => { clients += 1; return recoveryClient(job, { snapshot: { ...coherentCurrentTurn(mine.inputId, 'owned recovery completed'), runtime: { stateRevision: 2 } } }); },
  });
  assert.equal(clients, 1); assert.equal(recovered.length, 1); assert.equal(recovered[0].id, mine.id); assert.equal(recovered[0].status, 'succeeded');
  const succeeded = await store.readJob(fixture.workspace, mine.id);
  assert.equal(succeeded.status, 'succeeded');
  assert.equal(succeeded.logFile, join(storage.directory, 'jobs', `${mine.id}.log`));
  const log = await readFile(succeeded.logFile, 'utf8');
  assert.match(log, /Final output\nowned recovery completed\n/);
  assert.equal((log.match(/Final output/g) ?? []).length, 1);
  assert.doesNotMatch(log, /Assistant message/);
  assert.equal(JSON.parse(await readFile(join(storage.directory, 'job-owners', 'index.json'), 'utf8')).version, 3, 'a matching tuple marker must avoid parsing bound foreign canonical state');
});

test('owned recovery fails closed on its own corrupt job without exposing an absolute state path', async () => {
  const fixture = await context(); const { job, store } = await orphanJob(fixture, { readOnly: true }); const storage = await resolveWorkspaceStorage({ dataRoot: fixture.dataRoot, workspace: fixture.workspace });
  await writeFile(join(storage.directory, 'jobs', `${job.id}.json`), '{'); let clients = 0;
  const { reconcileOwnedJobs } = await import('../scripts/lib/recovery.mjs');
  await assert.rejects(reconcileOwnedJobs({
    store, dataRoot: fixture.dataRoot, workspace: fixture.workspace, ownerSessionId: 'owner', reconcileOwnership: async () => {},
    createClient: async () => { clients += 1; throw new Error('own corruption must fail before client creation'); },
  }), (error) => {
    assert.equal(error.code, 'OWNED_JOB_RECORD_INVALID'); assert.deepEqual(error.details, { jobId: job.id });
    assert.doesNotMatch(error.message, new RegExp(fixture.root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    return true;
  });
  assert.equal(clients, 0);
});

test('one job cancellation-lock or storage failure cannot skip a later owned orphan', async () => {
  const fixture = await context(); const store = createStateStore({ dataRoot: fixture.dataRoot }); const jobs = [];
  for (const [suffix, lease] of [['broken-lock', 'e'], ['later', 'f']]) {
    const reserved = await store.reserveJob({ workspace: fixture.workspace, ownerSessionId: 'owner', ownerTurnId: suffix, command: 'rescue', readOnly: true, permissionSnapshot: { permissionMode: 'workspace-write' } });
    await store.transitionJob(fixture.workspace, reserved.id, ['queued'], 'running', { childPid: 999999, workerLeaseId: lease.repeat(64), startedAt: new Date().toISOString(), zcodeSessionId: `session-${suffix}` });
    jobs.push(await store.transitionJob(fixture.workspace, reserved.id, ['running'], 'running', { inputId: `input-${suffix}`, startRevision: 1, beforeMessageIds: [] }));
  }
  let failedRead = false; const wrapped = { ...store, readJob: async (workspace, jobId) => { if (jobId === jobs[0].id && !failedRead) { failedRead = true; throw new Error('simulated per-job storage fault'); } return store.readJob(workspace, jobId); } };
  const { reconcileOwnedJobs } = await import('../scripts/lib/recovery.mjs');
  await reconcileOwnedJobs({ store: wrapped, dataRoot: fixture.dataRoot, workspace: fixture.workspace, ownerSessionId: 'owner', reconcileOwnership: async () => {}, createClient: async (job) => recoveryClient(job, { snapshot: { ...coherentCurrentTurn(job.inputId, 'later recovered'), runtime: { stateRevision: 2 } } }) });
  assert.equal((await store.readJob(fixture.workspace, jobs[0].id)).status, 'running');
  assert.equal((await store.readJob(fixture.workspace, jobs[1].id)).status, 'succeeded');
});

test('real CLI fd4 delivery failure revokes capability and releases the writable slot', async () => {
  const fixture = await context();
  const child = spawn(process.execPath, [companionCli, 'rescue', '--background', '--fresh', 'repair'], { cwd: fixture.workspace, env: fixture.env, stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'] });
  /** @type {import('node:stream').Writable} */ (child.stdio[3]).end(`${JSON.stringify({ callerContext: fixture.callerContext })}\n`);
  child.stdio[4].on('error', () => {});
  child.stdio[4].destroy();
  const code = await new Promise((resolve, reject) => { const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('companion delivery failure timed out')); }, process.platform === 'win32' ? 5_000 : 2_000); child.once('error', reject); child.once('exit', (value) => { clearTimeout(timer); resolve(value); }); });
  assert.notEqual(code, 0);
  const store = createStateStore({ dataRoot: fixture.dataRoot }); const [failed] = await store.listJobs(fixture.workspace); assert.equal(failed.status, 'failed');
  const storage = await resolveWorkspaceStorage({ dataRoot: fixture.dataRoot, workspace: fixture.workspace }); const capabilityFiles = await readdir(join(storage.directory, 'identity', 'capabilities')); assert.equal(capabilityFiles.length, 1); assert.ok(JSON.parse(await readFile(join(storage.directory, 'identity', 'capabilities', capabilityFiles[0]), 'utf8')).revokedAt);
  const later = await store.reserveJob({ workspace: fixture.workspace, ownerSessionId: 'owner', ownerTurnId: 'later', command: 'rescue', readOnly: false, permissionSnapshot: { permissionMode: 'workspace-write' } }); assert.equal(later.status, 'queued');
});

test('internal response writer handles partial writes and stable pipe failures', async () => {
  const chunks = []; let calls = 0;
  await writeInternalResponse({ ok: true }, 44, { timeoutMs: 100, write: (_fd, buffer, offset, length, _position, callback) => {
    const count = Math.min(length, calls++ === 0 ? 2 : length); chunks.push(buffer.subarray(offset, offset + count)); queueMicrotask(() => callback(null, count));
  } });
  assert.equal(Buffer.concat(chunks).toString(), '{"ok":true}\n');
  for (const code of ['EPIPE', 'EBADF']) await assert.rejects(writeInternalResponse({ ok: true }, 44, { timeoutMs: 100, write: (_fd, _buffer, _offset, _length, _position, callback) => queueMicrotask(() => callback(Object.assign(new Error(code), { code }), 0)) }), { code: 'INTERNAL_RESPONSE_WRITE_FAILED' });
});

test('aborting a real fd3 read rejects the original reason and releases the child process', async (t) => {
  const child = spawn(process.execPath, [readerAbortProbe], { stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = ''; let exited = false;
  child.stdout.on('data', (chunk) => { stdout += chunk; }); child.stderr.on('data', (chunk) => { stderr += chunk; });
  t.after(() => { child.stdio[3]?.destroy(); if (!exited) child.kill('SIGKILL'); });
  const exitPromise = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => { exited = true; resolve({ code, signal }); }); });
  /** @type {NodeJS.Timeout|undefined} */ let deadline;
  const exit = await Promise.race([exitPromise, new Promise((resolve, reject) => { void resolve; deadline = setTimeout(() => reject(new Error('aborted fd3 reader retained its pipe handle')), 2_000); })]).finally(() => clearTimeout(deadline));
  assert.deepEqual(exit, { code: 0, signal: null }, stderr);
  assert.equal(stdout, 'rejected-original\n');
});

test('internal envelope abort waits for the owned read stream to close', async () => {
  const stream = new EventEmitter(); stream.destroyed = false; let destroys = 0;
  stream.destroy = () => { stream.destroyed = true; destroys += 1; };
  const controller = new AbortController(); const interruption = new PluginError('JOB_INTERRUPTED', 'wait for close');
  let settled = false;
  const reading = readInternalEnvelope(33, { signal: controller.signal, createStream: () => stream });
  reading.then(() => { settled = true; }, () => { settled = true; });
  controller.abort(interruption);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(destroys, 1); assert.equal(settled, false);
  stream.emit('close');
  await assert.rejects(reading, (error) => error === interruption);
});

test('internal envelope closes its owned stream once on success, error, and timeout', async () => {
  for (const mode of ['success', 'error', 'timeout']) {
    const stream = new EventEmitter(); stream.destroyed = false; let destroys = 0;
    stream.destroy = () => { stream.destroyed = true; destroys += 1; queueMicrotask(() => stream.emit('close')); };
    const reading = readInternalEnvelope(33, { timeoutMs: 5, createStream: () => stream });
    if (mode === 'success') { stream.emit('data', Buffer.from('{"ok":true}')); stream.emit('end'); }
    if (mode === 'error') stream.emit('error', new Error('pipe failed'));
    if (mode === 'success') assert.deepEqual(await reading, { ok: true });
    else await assert.rejects(reading, { code: 'INTERNAL_AUTHORIZATION_INVALID' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(destroys, 1, mode);
  }
});

test('internal envelope maps synchronous stream construction failures to its stable error', async () => {
  await assert.rejects(
    readInternalEnvelope(33, { createStream: () => { throw new TypeError('secret unsupported descriptor'); } }),
    (error) => error instanceof PluginError
      && error.code === 'INTERNAL_AUTHORIZATION_INVALID'
      && !error.message.includes('secret'),
  );
});

test('internal response writer times out without blocking the event loop and closes once', async () => {
  let closes = 0; let ticked = false; setImmediate(() => { ticked = true; });
  await assert.rejects(writeInternalResponse({ ok: true }, 44, { timeoutMs: 10, write: () => {}, close: (_fd, callback) => { closes += 1; callback(); } }), { code: 'INTERNAL_RESPONSE_WRITE_TIMEOUT' });
  assert.equal(closes, 1); assert.equal(ticked, true);
});

test('internal response writer cancels a pending write before closing its descriptor', async () => {
  let cancelled = 0; let closes = 0; let lateCallback;
  await assert.rejects(writeInternalResponse({ ok: true }, 44, {
    timeoutMs: 10,
    write: (_fd, _buffer, _offset, _length, _position, callback) => { lateCallback = callback; return { cancel: () => { cancelled += 1; } }; },
    close: (_fd, callback) => { closes += 1; callback(); },
  }), { code: 'INTERNAL_RESPONSE_WRITE_TIMEOUT' });
  assert.equal(cancelled, 1); assert.equal(closes, 1);
  lateCallback?.(null, 1);
});

test('successful internal response writes unref the protected socket instead of resetting its parent reader', async () => {
  if (process.platform === 'win32') return;
  const root = await mkdtemp(join(tmpdir(), 'zcode-fd4-')); const fifo = join(root, 'pipe');
  await execFileAsync('mkfifo', [fifo]);
  const readerFd = openSync(fifo, constants.O_RDONLY | constants.O_NONBLOCK); const writerFd = openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK);
  const originalDestroy = Socket.prototype.destroy; const originalUnref = Socket.prototype.unref;
  let destroyed = 0; let unrefed = 0;
  const isWriterSocket = (socket) => socket?._handle?.fd === writerFd;
  Socket.prototype.destroy = function (...args) { if (isWriterSocket(this)) destroyed += 1; return originalDestroy.apply(this, args); };
  Socket.prototype.unref = function (...args) { if (isWriterSocket(this)) unrefed += 1; return originalUnref.apply(this, args); };
  try {
    await writeInternalResponse({ ok: true }, writerFd, { timeoutMs: 100 });
    assert.equal(destroyed, 0);
    assert.equal(unrefed, 1);
  } finally {
    Socket.prototype.destroy = originalDestroy; Socket.prototype.unref = originalUnref;
    try { closeSync(readerFd); } catch { /* writer path may already be closed */ }
    try { closeSync(writerFd); } catch { /* expected while proving success does not close it */ }
    await rm(root, { force: true, recursive: true });
  }
});

test('real fd4 writer is bounded for no-reader, slow-reader, and early-close pipes', async () => {
  // Windows anonymous pipes may buffer this bounded frame without a reader;
  // the no-reader timeout probe is specific to POSIX pipe backpressure. The
  // deterministic writer timeout/failure cases above still cover the same
  // contract on every platform.
  if (process.platform !== 'win32') { const noRead = await runWriterProbe('no-read'); assert.equal(noRead.code, 0); assert.match(noRead.stdout, /INTERNAL_RESPONSE_WRITE_TIMEOUT/); }
  const slowRead = await runWriterProbe('slow-read'); assert.equal(slowRead.code, 0); assert.match(slowRead.stdout, /ok/); assert.equal(slowRead.internalError, null);
  const earlyClose = await runWriterProbe('early-close'); assert.equal(earlyClose.code, 0); assert.match(earlyClose.stdout, /INTERNAL_RESPONSE_WRITE_FAILED/);
});

test('a persisted cancelling job is taken over under the cancellation lock', async () => {
  const fixture = await context(); const store = createStateStore({ dataRoot: fixture.dataRoot });
  const job = await store.reserveJob({ workspace: fixture.workspace, ownerSessionId: 'owner', ownerTurnId: 'turn', command: 'review', readOnly: false, permissionSnapshot: { permissionMode: 'workspace-write' } });
  await store.transitionJob(fixture.workspace, job.id, ['queued'], 'running', { zcodeSessionId: 'session-z' }); await store.transitionJob(fixture.workspace, job.id, ['running'], 'cancelling');
  let stops = 0; const controller = createJobController({ store, dataRoot: fixture.dataRoot, stopSession: async (sessionId) => { assert.equal(sessionId, 'session-z'); stops += 1; } });
  assert.equal((await controller.cancel(fixture.workspace, job.id, 'owner')).status, 'cancelled'); assert.equal(stops, 1);
});

test('a second process takes over after a cancelling lock holder is SIGKILLed', async () => {
  const fixture = await context(); const store = createStateStore({ dataRoot: fixture.dataRoot });
  const job = await store.reserveJob({ workspace: fixture.workspace, ownerSessionId: 'owner', ownerTurnId: 'turn', command: 'review', readOnly: false, permissionSnapshot: { permissionMode: 'workspace-write' } });
  await store.transitionJob(fixture.workspace, job.id, ['queued'], 'running', { zcodeSessionId: 'session-z' });
  const child = spawn(process.execPath, [cancellingHolder, fixture.dataRoot, fixture.workspace, job.id], { stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); child.once('exit', (code) => reject(new Error(`holder exited early: ${code}`))); });
  child.kill('SIGKILL'); await new Promise((resolve) => child.once('exit', resolve));
  let stops = 0; const controller = createJobController({ store, dataRoot: fixture.dataRoot, stopSession: async () => { stops += 1; } });
  assert.equal((await controller.cancel(fixture.workspace, job.id, 'owner')).status, 'cancelled'); assert.equal(stops, 1);
});

test('a cross-process follower joins the leader failure without stopping again', async () => {
  const fixture = await context(); const store = createStateStore({ dataRoot: fixture.dataRoot });
  const job = await store.reserveJob({ workspace: fixture.workspace, ownerSessionId: 'owner', ownerTurnId: 'turn', command: 'review', readOnly: false, permissionSnapshot: { permissionMode: 'workspace-write' } });
  await store.transitionJob(fixture.workspace, job.id, ['queued'], 'running', { zcodeSessionId: 'session-z' });
  const leader = spawnCancelAttempt(['leader-failure-ipc', fixture.dataRoot, fixture.workspace, job.id]); await leader.message('stop-entered');
  const follower = spawnCancelAttempt(['follower-ipc', fixture.dataRoot, fixture.workspace, job.id]); await follower.message('follower-selected'); leader.child.send({ type: 'release' });
  const [leaderResult, followerResult] = await Promise.all([leader.result, follower.result]);
  assert.deepEqual(followerResult.error, leaderResult.error); assert.equal(leaderResult.error.code, 'JOB_CANCEL_FAILED'); assert.equal(followerResult.job.status, 'running'); assert.equal(followerResult.job.lastCancelError, 'refused');
});

test('a cross-process follower joins the leader success without stopping again', async () => {
  const fixture = await context(); const store = createStateStore({ dataRoot: fixture.dataRoot });
  const job = await store.reserveJob({ workspace: fixture.workspace, ownerSessionId: 'owner', ownerTurnId: 'turn', command: 'review', readOnly: false, permissionSnapshot: { permissionMode: 'workspace-write' } });
  await store.transitionJob(fixture.workspace, job.id, ['queued'], 'running', { zcodeSessionId: 'session-z' });
  const leader = spawnCancelAttempt(['leader-success-ipc', fixture.dataRoot, fixture.workspace, job.id]); await leader.message('stop-entered');
  const follower = spawnCancelAttempt(['follower-ipc', fixture.dataRoot, fixture.workspace, job.id]); await follower.message('follower-selected'); leader.child.send({ type: 'release' });
  const [leaderResult, followerResult] = await Promise.all([leader.result, follower.result]); assert.equal(leaderResult.job.status, 'cancelled'); assert.equal(followerResult.job.status, 'cancelled');
});

test('a follower takes leadership after a pre-transition lock holder crash', async () => {
  for (const initialStatus of ['queued', 'running']) {
    const fixture = await context(); const store = createStateStore({ dataRoot: fixture.dataRoot });
    const job = await store.reserveJob({ workspace: fixture.workspace, ownerSessionId: 'owner', ownerTurnId: 'turn', command: 'review', readOnly: false, permissionSnapshot: { permissionMode: 'workspace-write' } });
    if (initialStatus === 'running') await store.transitionJob(fixture.workspace, job.id, ['queued'], 'running', { zcodeSessionId: 'session-z' });
    const holder = spawn(process.execPath, [cancelLockHolder, fixture.dataRoot, fixture.workspace, job.id], { stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise((resolve, reject) => { holder.stdout.once('data', resolve); holder.once('error', reject); });
    let selected = () => {}; const followerSelected = new Promise((resolve) => { selected = () => resolve(undefined); }); let stops = 0;
    const controller = createJobController({ store, dataRoot: fixture.dataRoot, afterFollowerSelected: async () => { selected(); }, stopSession: async () => { stops += 1; } });
    const cancellation = controller.cancel(fixture.workspace, job.id, 'owner'); await followerSelected; const holderExit = new Promise((resolve) => holder.once('exit', resolve)); holder.kill('SIGKILL'); await holderExit;
    assert.equal((await cancellation).status, 'cancelled'); assert.equal(stops, initialStatus === 'running' ? 1 : 0);
  }
});

test('historical cancel failure does not make a retry follower join a leader killed before publishing active', async () => {
  const fixture = await context(); const store = createStateStore({ dataRoot: fixture.dataRoot });
  const job = await store.reserveJob({ workspace: fixture.workspace, ownerSessionId: 'owner', ownerTurnId: 'turn', command: 'review', readOnly: false, permissionSnapshot: { permissionMode: 'workspace-write' } });
  await store.transitionJob(fixture.workspace, job.id, ['queued'], 'running', { zcodeSessionId: 'session-z' });
  await assert.rejects(createJobController({ store, dataRoot: fixture.dataRoot, stopSession: async () => { throw new Error('historical refusal'); } }).cancel(fixture.workspace, job.id, 'owner'), { code: 'JOB_CANCEL_FAILED' });
  const holder = spawn(process.execPath, [cancelLockHolder, fixture.dataRoot, fixture.workspace, job.id, 'before-active'], { stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => { holder.stdout.once('data', resolve); holder.once('error', reject); });
  let followerReady = () => {}; const selected = new Promise((resolve) => { followerReady = () => resolve(undefined); }); let stops = 0;
  const cancellation = createJobController({ store, dataRoot: fixture.dataRoot, afterFollowerSelected: async () => { followerReady(); }, stopSession: async () => { stops += 1; } }).cancel(fixture.workspace, job.id, 'owner');
  await selected; const exited = new Promise((resolve) => holder.once('exit', resolve)); holder.kill('SIGKILL'); await exited;
  assert.equal((await cancellation).status, 'cancelled'); assert.equal(stops, 1); assert.equal((await cancellationAttempt(fixture.dataRoot, fixture.workspace, job.id)).status, 'succeeded');
});

test('a follower takes over the same active attempt after publication but before transition', async () => {
  const fixture = await context(); const store = createStateStore({ dataRoot: fixture.dataRoot });
  const job = await store.reserveJob({ workspace: fixture.workspace, ownerSessionId: 'owner', ownerTurnId: 'turn', command: 'review', readOnly: false, permissionSnapshot: { permissionMode: 'workspace-write' } });
  await store.transitionJob(fixture.workspace, job.id, ['queued'], 'running', { zcodeSessionId: 'session-z' }); const attemptId = 'b'.repeat(64);
  const holder = spawn(process.execPath, [cancelLockHolder, fixture.dataRoot, fixture.workspace, job.id, 'after-active', attemptId], { stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => { holder.stdout.once('data', resolve); holder.once('error', reject); });
  let followerReady = () => {}; const selected = new Promise((resolve) => { followerReady = () => resolve(undefined); }); let stops = 0;
  const cancellation = createJobController({ store, dataRoot: fixture.dataRoot, afterFollowerSelected: async () => { followerReady(); }, stopSession: async () => { stops += 1; } }).cancel(fixture.workspace, job.id, 'owner');
  await selected; const exited = new Promise((resolve) => holder.once('exit', resolve)); holder.kill('SIGKILL'); await exited;
  assert.equal((await cancellation).status, 'cancelled'); assert.equal(stops, 1); const attempt = await cancellationAttempt(fixture.dataRoot, fixture.workspace, job.id); assert.equal(attempt.attemptId, attemptId); assert.equal(attempt.status, 'succeeded');
});

test('a follower joins failed-pending-release without stopping and settles the attempt failed', async () => {
  const fixture = await context(); const store = createStateStore({ dataRoot: fixture.dataRoot });
  const job = await store.reserveJob({ workspace: fixture.workspace, ownerSessionId: 'owner', ownerTurnId: 'turn', command: 'review', readOnly: false, permissionSnapshot: { permissionMode: 'workspace-write' } });
  await store.transitionJob(fixture.workspace, job.id, ['queued'], 'running', { zcodeSessionId: 'session-z' }); const attemptId = 'c'.repeat(64);
  const holder = spawn(process.execPath, [cancelLockHolder, fixture.dataRoot, fixture.workspace, job.id, 'failed-pending', attemptId], { stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => { holder.stdout.once('data', resolve); holder.once('error', reject); });
  let followerReady = () => {}; const selected = new Promise((resolve) => { followerReady = () => resolve(undefined); }); let stops = 0;
  const cancellation = createJobController({ store, dataRoot: fixture.dataRoot, afterFollowerSelected: async () => { followerReady(); }, stopSession: async () => { stops += 1; } }).cancel(fixture.workspace, job.id, 'owner');
  await selected; const exited = new Promise((resolve) => holder.once('exit', resolve)); holder.kill('SIGKILL'); await exited;
  await assert.rejects(cancellation, { code: 'JOB_CANCEL_FAILED', message: `Could not cancel job ${job.id}: refused` }); assert.equal(stops, 0);
  const attempt = await cancellationAttempt(fixture.dataRoot, fixture.workspace, job.id); assert.equal(attempt.attemptId, attemptId); assert.equal(attempt.status, 'failed');
});

test('review contract is embedded in the request and schema evaluation fails closed', async () => {
  const prompt = await buildPrompt({ command: 'review', gitFacts: {} });
  assert.match(prompt, /ZCODE_REVIEW_OUTPUT_SCHEMA:/); assert.match(prompt, /"additionalProperties":false/);
  assert.equal(validateJsonSchema({ findings: [] }, { type: 'object', required: ['findings'], properties: { findings: { type: 'array', items: { type: 'string' } } }, additionalProperties: false }), true);
  assert.throws(() => validateJsonSchema({}, { type: 'number' }), { code: 'REVIEW_SCHEMA_INVALID' });
});

test('the cached review schema is recursively immutable under concurrent loads', async () => {
  const [left, right] = await Promise.all([loadReviewOutputSchema(), loadReviewOutputSchema()]); assert.equal(left, right);
  assert.equal(Object.isFrozen(left), true); assert.equal(Object.isFrozen(left.required), true); assert.equal(Object.isFrozen(left.properties.findings.items.properties.severity.enum), true);
  assert.throws(() => left.required.push('forged'), TypeError); assert.throws(() => left.properties.findings.items.properties.severity.enum.push('bogus'), TypeError);
  assert.equal(validateJsonSchema({}, await loadReviewOutputSchema()), false);
});

test('fake peer tolerates non-string send content and still completes stop', async () => {
  const child = spawn(process.execPath, [fakeZCode], { stdio: ['pipe', 'pipe', 'pipe'] }); let stdout = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stdin.end([
    { id: 1, method: 'session/create', params: { sessionId: 'non-string', workspace: { workspacePath: '/repo' } } },
    { id: 2, method: 'session/send', params: { sessionId: 'non-string', content: { invalid: true }, inputId: 'input' } },
    { id: 3, method: 'session/stop', params: { sessionId: 'non-string' } },
  ].map((message) => JSON.stringify(message)).join('\n') + '\n');
  const code = await new Promise((resolve, reject) => { const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('fake stop path timed out')); }, 2_000); child.once('error', reject); child.once('exit', (value) => { clearTimeout(timer); resolve(value); }); });
  assert.equal(code, 0); const messages = stdout.trim().split('\n').map(JSON.parse); assert.deepEqual(messages.filter(({ id }) => id === 3).map(({ result }) => result), [{}]);
});

test('SessionEnd settlement persists the durable session-end stop intent for a Host-owned running Rescue', async () => {
  const fixture = await context(); const store = createStateStore({ dataRoot: fixture.dataRoot });
  const workspace = await realpath(fixture.workspace);
  const reserved = await store.reserveFreshRescueJob({ workspace, reservation: { workspace, ownerSessionId: 'owner',
    ownerTurnId: 'turn', command: 'rescue', readOnly: false, permissionSnapshot: { permissionMode: 'workspace-write' } },
    executor: { parentSessionId: 'owner', parentTurnId: 'turn', agentId: 'host-owned-session-end-child', agentType: 'zcode-rescue',
      agentPath: '/root/zcode_rescue_task', workspace, parentPermissionMode: 'workspace-write' },
    lifecycle: { ownerLifecycleEpoch: '1'.repeat(64), executionOwner: 'host-child', hostPlacement: 'background' } });
  const claimed = await store.claimJobWorkerForExecution(workspace, reserved.job.id, { childPid: 999_999_999, workerLeaseId: reserved.job.id });
  await store.transitionJob(workspace, reserved.job.id, ['queued'], 'running', { startedAt: new Date().toISOString(),
    zcodeSessionId: 'zs-session-end-settlement', childPid: claimed.childPid, workerLeaseId: claimed.workerLeaseId });
  await store.transitionJob(workspace, reserved.job.id, ['running'], 'running', { inputId: 'input-session-end', startRevision: 1, beforeMessageIds: [] });
  const { settleEndedOwnerWritableJob } = await import('../scripts/lib/recovery.mjs');
  const outcome = await settleEndedOwnerWritableJob({ store, dataRoot: fixture.dataRoot, workspace, ownerSessionId: 'owner',
    lockTimeoutMs: 0, includeSettlementEvidence: true, createClient: async () => ({
      readSession: async () => coherentCurrentTurn('input-session-end', 'partial', 'cancelled'),
      stopSession: async () => {}, close: async () => {},
    }) });
  assert.equal(outcome.kind, 'confirmed-cancellation');
  assert.equal(outcome.job.status, 'cancelled');
  assert.equal(outcome.job.stopCause, 'session-end');
  assert.equal(outcome.job.stopIntent.cause, 'session-end');
  assert.equal((await store.resolveRescueBinding({ workspace, parentSessionId: 'owner',
    executorAgentId: 'host-owned-session-end-child' })).binding.state, 'active');
  await cleanupRecoveryFixture(fixture);
});

test('SessionEnd settlement closes its control client when the abort fires after client creation', async () => {
  const fixture = await context(); const { job, store } = await orphanJob(fixture);
  const controller = new AbortController();
  const reason = Object.freeze({ phase: 'post-create' });
  let closes = 0;
  const { settleEndedOwnerWritableJob } = await import('../scripts/lib/recovery.mjs');
  await assert.rejects(settleEndedOwnerWritableJob({
    store, dataRoot: fixture.dataRoot, workspace: fixture.workspace, ownerSessionId: 'owner',
    lockTimeoutMs: 0, signal: controller.signal,
    createClient: async () => {
      const client = {
        readSession: async () => { throw new Error('must not read after the abort'); },
        stopSession: async () => {},
        close: async () => { closes += 1; },
      };
      controller.abort(reason);
      return client;
    },
  }), (error) => error === reason);
  assert.equal(closes, 1, 'the created control client must be closed on the post-creation abort path');
  assert.equal((await store.readJob(fixture.workspace, job.id)).status, 'running');
  await cleanupRecoveryFixture(fixture);
});

async function hostOwnedRunningRescue(fixture, { session, input, agent, epoch }) {
  const store = createStateStore({ dataRoot: fixture.dataRoot });
  const workspace = await realpath(fixture.workspace);
  const reserved = await store.reserveFreshRescueJob({ workspace, reservation: { workspace, ownerSessionId: 'owner',
    ownerTurnId: 'turn', command: 'rescue', readOnly: false, permissionSnapshot: { permissionMode: 'workspace-write' } },
    executor: { parentSessionId: 'owner', parentTurnId: 'turn', agentId: agent, agentType: 'zcode-rescue',
      agentPath: '/root/zcode_rescue_task', workspace, parentPermissionMode: 'workspace-write' },
    lifecycle: { ownerLifecycleEpoch: epoch, executionOwner: 'host-child', hostPlacement: 'background' } });
  const claimed = await store.claimJobWorkerForExecution(workspace, reserved.job.id, { childPid: 999_999_999, workerLeaseId: reserved.job.id });
  await store.transitionJob(workspace, reserved.job.id, ['queued'], 'running', { startedAt: new Date().toISOString(),
    zcodeSessionId: session, childPid: claimed.childPid, workerLeaseId: claimed.workerLeaseId });
  await store.transitionJob(workspace, reserved.job.id, ['running'], 'running', { inputId: input, startRevision: 1, beforeMessageIds: [] });
  return { store, workspace };
}

test('SessionEnd settlement racing natural success publishes succeeded with its result artifact', async () => {
  const fixture = await context();
  const { store, workspace } = await hostOwnedRunningRescue(fixture, { session: 'zs-natural-success', input: 'input-natural-success',
    agent: 'host-owned-natural-success-child', epoch: '2'.repeat(64) });
  let stops = 0;
  const { settleEndedOwnerWritableJob } = await import('../scripts/lib/recovery.mjs');
  const outcome = await settleEndedOwnerWritableJob({ store, dataRoot: fixture.dataRoot, workspace, ownerSessionId: 'owner',
    lockTimeoutMs: 0, includeSettlementEvidence: true, createClient: async () => ({
      readSession: async () => coherentCurrentTurn('input-natural-success', 'natural success won the stop race'),
      stopSession: async () => { stops += 1; }, close: async () => {},
    }) });
  assert.equal(outcome.kind, 'durable-completion');
  assert.equal(outcome.job.status, 'succeeded');
  assert.ok(outcome.job.resultArtifact, 'the natural-success winner must publish its authoritative result artifact');
  assert.equal(stops, 0, 'a terminal remote winner must settle without another stop');
  const storage = await resolveWorkspaceStorage({ dataRoot: fixture.dataRoot, workspace });
  assert.equal(await readFile(join(storage.directory, outcome.job.resultArtifact), 'utf8'), 'natural success won the stop race');
  await cleanupRecoveryFixture(fixture);
});

test('SessionEnd settlement with an unacknowledged stop retains the durable cancelling status', async () => {
  const fixture = await context();
  const { store, workspace } = await hostOwnedRunningRescue(fixture, { session: 'zs-unacked-stop', input: 'input-unacked-stop',
    agent: 'host-owned-unacked-stop-child', epoch: '3'.repeat(64) });
  const { settleEndedOwnerWritableJob } = await import('../scripts/lib/recovery.mjs');
  const outcome = await settleEndedOwnerWritableJob({ store, dataRoot: fixture.dataRoot, workspace, ownerSessionId: 'owner',
    lockTimeoutMs: 0, includeSettlementEvidence: true, createClient: async () => ({
      readSession: async () => activeCurrentTurn('input-unacked-stop'),
      stopSession: async () => { throw new Error('session stop refused'); }, close: async () => {},
    }) });
  assert.equal(outcome.kind, 'retained-writable-guard');
  assert.equal(outcome.job.status, 'cancelling', 'uncertainty must retain cancelling, never roll back to running');
  assert.equal(outcome.job.stopIntent.cause, 'session-end');
  // The retained cancelling guard carries the bounded retry diagnostic — the
  // only visible retry evidence once status strips the private stop intent.
  assert.equal(outcome.job.lastCancelError, 'session stop refused');
  await assert.rejects(store.reserveJob({ workspace, ownerSessionId: 'next-owner', ownerTurnId: 'next',
    command: 'rescue', readOnly: false, permissionSnapshot: { permissionMode: 'workspace-write' } }), { code: 'WRITABLE_JOB_EXISTS' });
  await cleanupRecoveryFixture(fixture);
});

test('SessionEnd settlement retains cancelling when the control channel is unavailable', async () => {
  const fixture = await context(); const { store } = await orphanJob(fixture, { boundary: false, turnId: 'unavailable-settle' });
  const { settleEndedOwnerWritableJob } = await import('../scripts/lib/recovery.mjs');
  const outcome = await settleEndedOwnerWritableJob({ store, dataRoot: fixture.dataRoot, workspace: fixture.workspace,
    ownerSessionId: 'owner', lockTimeoutMs: 0, includeSettlementEvidence: true,
    createClient: async () => { throw new PluginError('ZCODE_DISCONNECTED', 'endpoint=/secret.sock token=secret', { category: 'runtime', remedy: 'Restart.' }); } });
  assert.equal(outcome.kind, 'retained-writable-guard');
  assert.equal(outcome.job.status, 'cancelling', 'an unresolved stop keeps its durable cancelling status even without a control channel');
  assert.doesNotMatch(outcome.job.lastCancelError ?? '', /secret/);
  await cleanupRecoveryFixture(fixture);
});

async function hostOwnedRunningRescueInWorkspace(fixture, workspace, { session, input, agent, epoch, placement = 'background' }) {
  const store = createStateStore({ dataRoot: fixture.dataRoot });
  const reserved = await store.reserveFreshRescueJob({ workspace, reservation: { workspace, ownerSessionId: 'owner',
    ownerTurnId: 'turn', command: 'rescue', readOnly: false, permissionSnapshot: { permissionMode: 'workspace-write' } },
    executor: { parentSessionId: 'owner', parentTurnId: 'turn', agentId: agent, agentType: 'zcode-rescue',
      agentPath: '/root/zcode_rescue_task', workspace, parentPermissionMode: 'workspace-write' },
    lifecycle: { ownerLifecycleEpoch: epoch, executionOwner: 'host-child', hostPlacement: placement } });
  const claimed = await store.claimJobWorkerForExecution(workspace, reserved.job.id, { childPid: 999_999_999, workerLeaseId: reserved.job.id });
  await store.transitionJob(workspace, reserved.job.id, ['queued'], 'running', { startedAt: new Date().toISOString(),
    zcodeSessionId: session, childPid: claimed.childPid, workerLeaseId: claimed.workerLeaseId });
  await store.transitionJob(workspace, reserved.job.id, ['running'], 'running', { inputId: input, startRevision: 1, beforeMessageIds: [] });
  return { store, job: reserved.job };
}

async function hostOwnedFreeWritableRunning(fixture, workspace, { session, input }) {
  const store = createStateStore({ dataRoot: fixture.dataRoot });
  const reserved = await store.reserveJob({ workspace, ownerSessionId: 'owner', ownerTurnId: input, command: 'rescue', readOnly: false, permissionSnapshot: { permissionMode: 'workspace-write' } });
  const claimed = await store.claimJobWorkerForExecution(workspace, reserved.id, { childPid: 999_999_999, workerLeaseId: reserved.id });
  await store.transitionJob(workspace, reserved.id, ['queued'], 'running', { startedAt: new Date().toISOString(), zcodeSessionId: session, childPid: claimed.childPid, workerLeaseId: claimed.workerLeaseId });
  await store.transitionJob(workspace, reserved.id, ['running'], 'running', { inputId: input, startRevision: 1, beforeMessageIds: [] });
  return { job: reserved };
}

test('SessionEnd receipt-scoped discovery and settlement stop only matching-epoch host-owned writable Rescue', async () => {
  const fixture = await context(); const store = createStateStore({ dataRoot: fixture.dataRoot });
  const workspaceA = await realpath(fixture.workspace);
  await mkdir(join(fixture.root, 'workspace-b')); await mkdir(join(fixture.root, 'workspace-c'));
  const workspaceB = await realpath(join(fixture.root, 'workspace-b'));
  const workspaceC = await realpath(join(fixture.root, 'workspace-c'));
  const { hostLifecycleEpoch } = await import('../scripts/lib/host-lifecycle.mjs');
  const MATCHED = hostLifecycleEpoch('owner', '2026-01-01T00:00:00.000Z');
  const FOREIGN = hostLifecycleEpoch('other', '2026-01-02T00:00:00.000Z');
  const matched = await hostOwnedRunningRescueInWorkspace(fixture, workspaceA, { session: 'zs-matched', input: 'input-matched', agent: 'matched-child', epoch: MATCHED });
  const foreign = await hostOwnedRunningRescueInWorkspace(fixture, workspaceB, { session: 'zs-foreign', input: 'input-foreign', agent: 'foreign-child', epoch: FOREIGN });
  const legacy = await hostOwnedFreeWritableRunning(fixture, workspaceC, { session: 'zs-legacy', input: 'input-legacy' });
  await store.reserveJob({ workspace: workspaceA, ownerSessionId: 'owner', ownerTurnId: 'ro', command: 'rescue', readOnly: true, permissionSnapshot: { permissionMode: 'default' } });
  const { discoverSessionEndObligations, settleEndedRescueJob, endedObligationSettled } = await import('../scripts/lib/recovery.mjs');
  const knownWorkspaces = [workspaceA, workspaceB, workspaceC];
  const epochScoped = await discoverSessionEndObligations({ store, knownWorkspaces, ownerSessionId: 'owner', epoch: MATCHED });
  assert.deepEqual(epochScoped.map((o) => o.job.id).sort(), [matched.job.id, legacy.job.id].sort(),
    'epoch-scoped discovery keeps the matching-epoch host job and a legacy job but excludes a foreign-epoch host job and read-only runs');
  const unscoped = await discoverSessionEndObligations({ store, knownWorkspaces, ownerSessionId: 'owner', epoch: null });
  assert.deepEqual(unscoped.map((o) => o.job.id).sort(), [matched.job.id, foreign.job.id, legacy.job.id].sort(),
    'an unproven epoch disables the epoch filter so the legacy settle path is preserved across every workspace');
  const cancelledClient = (inputId) => async () => ({
    readSession: async () => coherentCurrentTurn(inputId, 'settled by session-end', 'cancelled'),
    stopSession: async () => {}, close: async () => {},
  });
  const matchedOutcome = await settleEndedRescueJob({ store, dataRoot: fixture.dataRoot, workspace: workspaceA, ownerSessionId: 'owner',
    epoch: MATCHED, lockTimeoutMs: 0, includeSettlementEvidence: true, createClient: cancelledClient('input-matched') }, matched.job.id);
  assert.equal(matchedOutcome.kind, 'confirmed-cancellation');
  assert.equal(matchedOutcome.job.status, 'cancelled');
  assert.equal(matchedOutcome.job.stopCause, 'session-end');
  assert.equal(endedObligationSettled(matchedOutcome), true, 'a terminal host obligation discharges the receipt');
  const foreignOutcome = await settleEndedRescueJob({ store, dataRoot: fixture.dataRoot, workspace: workspaceB, ownerSessionId: 'owner',
    epoch: MATCHED, lockTimeoutMs: 0, includeSettlementEvidence: true, createClient: cancelledClient('input-foreign') }, foreign.job.id);
  assert.equal(foreignOutcome.kind, 'epoch-not-owned', 'a retained old-epoch receipt never stops a post-resume host job');
  assert.equal((await store.readJob(workspaceB, foreign.job.id)).status, 'running', 'the foreign-epoch job is untouched');
  assert.equal(endedObligationSettled(foreignOutcome), false);
  const legacyOutcome = await settleEndedRescueJob({ store, dataRoot: fixture.dataRoot, workspace: workspaceC, ownerSessionId: 'owner',
    epoch: MATCHED, lockTimeoutMs: 0, includeSettlementEvidence: true, createClient: cancelledClient('input-legacy') }, legacy.job.id);
  assert.equal(endedObligationSettled(legacyOutcome), true, 'a legacy writable obligation is settled through the reconciler even under a matching-epoch receipt');
  assert.equal((await store.readJob(workspaceC, legacy.job.id)).status, 'cancelled');
  // A bare legacy 'cancelling' guard with no exact stop intent is NOT settlement:
  // the pending receipt must remain the durable compensation authority.
  assert.equal(endedObligationSettled({ kind: null, job: { status: 'cancelling' } }), false, 'a bare cancelling guard never discharges the receipt');
  assert.equal(endedObligationSettled({ kind: null, job: { status: 'cancelling', stopIntent: { version: 1, cause: 'session-end', requestedAt: new Date().toISOString() } } }), true);
  await cleanupRecoveryFixture(fixture);
});

test('read-only worker termination derives its budget from the absolute SessionEnd deadline', async () => {
  const fixture = await context();
  const { job, store } = await orphanJob(fixture, { turnId: 'deadline-ro', command: 'review', readOnly: true });
  const { settleEndedReadOnlyDetachedJob, withWorkerLease } = await import('../scripts/lib/recovery.mjs');
  const kills = [];
  const terminateSpy = async (pid, options) => { kills.push(options); };
  const settle = (extra) => settleEndedReadOnlyDetachedJob({
    store, dataRoot: fixture.dataRoot, workspace: fixture.workspace, ownerSessionId: 'owner',
    epoch: null, lockTimeoutMs: 0, includeSettlementEvidence: true, terminateProcessTree: terminateSpy,
    createClient: async () => { throw new PluginError('ZCODE_DISCONNECTED', 'endpoint withheld', { category: 'runtime', remedy: 'Restart.' }); },
    ...extra,
  }, job.id);
  const lease = { dataRoot: fixture.dataRoot, workspace: fixture.workspace, jobId: job.id, workerLeaseId: job.workerLeaseId, timeoutMs: 0 };
  await withWorkerLease(lease, async () => {
    await settle({ deadlineMs: Date.now() - 1 }).catch(() => {});
    assert.equal(kills.length, 0, 'a spent SessionEnd deadline must not grant a fresh local termination budget');
    await settle({ deadlineMs: Date.now() + 5_000 }).catch(() => {});
    assert.equal(kills.length, 1, 'the worker kill still runs inside a live deadline');
    // POSIX keeps the historical 750ms cap; Windows uses the platform's larger
    // real process-operation cap (see runnerTerminationBudgetCapMs).
    assert.ok(kills[0].timeoutMs > 0 && kills[0].timeoutMs <= runnerTerminationBudgetCapMs(), `the termination budget is capped by the shared deadline (got ${kills[0].timeoutMs})`);
  });
  await cleanupRecoveryFixture(fixture);
});

test('SessionEnd attempts remote stop before killing an exact read-only worker', async () => {
  // A historical read-only detached run (Review) whose worker still holds its
  // lease at SessionEnd: the bounded exact remote stop must be attempted FIRST
  // and the recorded worker tree terminated only afterwards — never the other
  // way round, and never through the writable Rescue binding interface.
  const fixture = await context();
  const { job, store } = await orphanJob(fixture, { turnId: 'stop-then-kill', command: 'review', readOnly: true });
  const { settleEndedReadOnlyDetachedJob, withWorkerLease } = await import('../scripts/lib/recovery.mjs');
  const events = []; let bindingInterfaceTouched = 0;
  const observedStore = { ...store, revalidateBoundRescueStop: async (...args) => { bindingInterfaceTouched += 1; return store.revalidateBoundRescueStop(...args); } };
  const lease = { dataRoot: fixture.dataRoot, workspace: fixture.workspace, jobId: job.id, workerLeaseId: job.workerLeaseId, timeoutMs: 0 };
  const outcome = await withWorkerLease(lease, () => settleEndedReadOnlyDetachedJob({
    store: observedStore, dataRoot: fixture.dataRoot, workspace: fixture.workspace, ownerSessionId: 'owner',
    epoch: null, lockTimeoutMs: 0, deadlineMs: Date.now() + 5_000, includeSettlementEvidence: true,
    reconcileOwnership: async () => {},
    terminateProcessTree: async (pid) => { assert.equal(pid, job.childPid); events.push('kill'); },
    createClient: async () => ({
      listSessions: async () => ({ sessions: [{ sessionId: job.zcodeSessionId }] }),
      readSession: async () => activeCurrentTurn(job.inputId),
      stopSession: async (sessionId) => { assert.equal(sessionId, job.zcodeSessionId); events.push('stop'); },
      close: async () => { events.push('close'); },
    }),
  }, job.id));
  assert.deepEqual(events.filter((event) => event !== 'close'), ['stop', 'kill']);
  assert.equal(events.indexOf('stop') < events.indexOf('kill'), true, 'the remote stop precedes the exact worker-tree kill');
  assert.equal(bindingInterfaceTouched, 0, 'read-only settlement never routes through the writable binding guard');
  // Process death is never remote terminal proof: the still-active remote turn
  // leaves the record unresolved for the pending receipt instead of a claimed stop.
  assert.equal(outcome.kind, 'retained-writable-guard');
  assert.equal((await store.readJob(fixture.workspace, job.id)).status, 'running');
  await cleanupRecoveryFixture(fixture);
});

test('SessionEnd settlement retains the durable cancelling intent for a host-owned record whose remote stop cannot be proven', async () => {
  const fixture = await context(); const workspace = await realpath(fixture.workspace);
  const { hostLifecycleEpoch } = await import('../scripts/lib/host-lifecycle.mjs');
  const EPOCH = hostLifecycleEpoch('owner', '2026-01-01T00:00:00.000Z');
  const { store, job } = await hostOwnedRunningRescueInWorkspace(fixture, workspace, { session: 'zs-unproven', input: 'input-unproven', agent: 'unproven-child', epoch: EPOCH });
  const { settleEndedRescueJob, endedObligationSettled } = await import('../scripts/lib/recovery.mjs');
  const outcome = await settleEndedRescueJob({ store, dataRoot: fixture.dataRoot, workspace, ownerSessionId: 'owner',
    epoch: EPOCH, lockTimeoutMs: 0, includeSettlementEvidence: true, createClient: async () => ({
      readSession: async () => activeCurrentTurn('input-unproven'),
      stopSession: async () => {}, close: async () => {} }) }, job.id);
  assert.equal(outcome.kind, 'retained-writable-guard');
  assert.equal(outcome.job.status, 'cancelling', 'an unresolved stop retains cancelling and never claims a terminal winner');
  assert.equal(outcome.job.stopIntent.cause, 'session-end', 'the durable session-end stop intent is the delegation evidence');
  assert.equal(endedObligationSettled(outcome), true, 'a persisted unresolved stop intent discharges the receipt without claiming stopped');
  assert.equal((await store.readJob(workspace, job.id)).status, 'cancelling');
  await cleanupRecoveryFixture(fixture);
});

const unavailableControlClient = async () => {
  throw new PluginError('ZCODE_DISCONNECTED', 'the existing broker is unreachable', { category: 'runtime', remedy: 'Restart.' });
};

test('coordination-loss settlement with unavailable control retains the cancelling guard instead of archiving', async () => {
  const fixture = await context(); const workspace = await realpath(fixture.workspace);
  const { hostLifecycleEpoch } = await import('../scripts/lib/host-lifecycle.mjs');
  const EPOCH = hostLifecycleEpoch('owner', '2026-01-01T00:00:00.000Z');
  const { store, job } = await hostOwnedRunningRescueInWorkspace(fixture, workspace, { session: 'zs-cl-retain', input: 'input-cl-retain', agent: 'cl-retain-child', epoch: EPOCH, placement: 'foreground' });
  const { settleEndedRescueJob } = await import('../scripts/lib/recovery.mjs');
  const outcome = await settleEndedRescueJob({ store, dataRoot: fixture.dataRoot, workspace, ownerSessionId: 'owner',
    epoch: EPOCH, lockTimeoutMs: 0, includeSettlementEvidence: true, unavailableOutcome: 'retain',
    intent: { kind: 'stop', cause: 'host-coordination-loss' }, sessionEndReceiptEvidence: 'older',
    createClient: unavailableControlClient }, job.id);
  assert.equal(outcome.kind, 'retained-writable-guard', 'unconfirmed control must retain the durable guard');
  const stored = await store.readJob(workspace, job.id);
  assert.equal(stored.status, 'cancelling', 'coordination-loss settlement never marks the job failed while the remote turn is unconfirmed');
  assert.notEqual(stored.status, 'failed', 'releasing the writable exclusion on unconfirmed control is forbidden');
  assert.equal(stored.stopIntent?.cause, 'host-coordination-loss', 'the coordination-loss cause stays the durable evidence');
  await assert.rejects(store.reserveJob({ workspace, ownerSessionId: 'next-owner', ownerTurnId: 'next',
    command: 'rescue', readOnly: false, permissionSnapshot: { permissionMode: 'workspace-write' } }), { code: 'WRITABLE_JOB_EXISTS' },
    'the retained guard still excludes new writable work');
  await cleanupRecoveryFixture(fixture);
});

test('without the retain option the unavailable-executor settlement keeps its archival semantics', async () => {
  const fixture = await context(); const workspace = await realpath(fixture.workspace);
  const { hostLifecycleEpoch } = await import('../scripts/lib/host-lifecycle.mjs');
  const EPOCH = hostLifecycleEpoch('owner', '2026-01-01T00:00:00.000Z');
  const { store, job } = await hostOwnedRunningRescueInWorkspace(fixture, workspace, { session: 'zs-cl-archive', input: 'input-cl-archive', agent: 'cl-archive-child', epoch: EPOCH, placement: 'foreground' });
  const { settleEndedRescueJob } = await import('../scripts/lib/recovery.mjs');
  const outcome = await settleEndedRescueJob({ store, dataRoot: fixture.dataRoot, workspace, ownerSessionId: 'owner',
    epoch: EPOCH, lockTimeoutMs: 0, includeSettlementEvidence: true,
    intent: { kind: 'stop', cause: 'host-coordination-loss' }, sessionEndReceiptEvidence: 'older',
    createClient: unavailableControlClient }, job.id);
  assert.equal(outcome.kind, 'terminal', 'the default (SessionEnd) settlement still archives the proven-free worker');
  assert.equal((await store.readJob(workspace, job.id)).status, 'failed');
  await cleanupRecoveryFixture(fixture);
});

/** A store view that publishes the matching-epoch receipt after its SECOND readJob of the job, so the receipt lands between the settlement path's initial evidence read and the serialized persist. */
function receiptPublishedMidRaceStore(store, lifecycle, workspace, jobId, receiptInput) {
  let reads = 0;
  return {
    ...store,
    readJob: async (/** @type {string} */ readWorkspace, /** @type {string} */ readJobId, /** @type {any} */ options) => {
      const current = await store.readJob(readWorkspace, readJobId, options);
      if (readWorkspace === workspace && readJobId === jobId && ++reads === 2) {
        await lifecycle.publishSessionEnd(receiptInput, { signal: AbortSignal.timeout(250) });
      }
      return current;
    },
  };
}

test('coordination-loss settlement rechecks the epoch receipt before persisting and switches to session-end', async () => {
  const fixture = await context(); const workspace = await realpath(fixture.workspace);
  const { hostLifecycleEpoch } = await import('../scripts/lib/host-lifecycle.mjs');
  const { createHostLifecycleStore } = await import('./helpers/host-lifecycle-store.mjs');
  const EPOCH = hostLifecycleEpoch('owner', '2026-01-01T00:00:00.000Z');
  const { store, job } = await hostOwnedRunningRescueInWorkspace(fixture, workspace, { session: 'zs-receipt-race', input: 'input-receipt-race', agent: 'receipt-race-child', epoch: EPOCH, placement: 'foreground' });
  const lifecycle = createHostLifecycleStore({ dataRoot: fixture.dataRoot });
  assert.equal(await lifecycle.readReceipt(EPOCH), null, 'no receipt exists at the initial read');
  const racedStore = receiptPublishedMidRaceStore(store, lifecycle, workspace, job.id, {
    sessionId: 'owner', sessionStartedAt: '2026-01-01T00:00:00.000Z', endedAt: new Date().toISOString(),
    origin: 'session-end-hook', workspaceHints: [workspace],
  });
  const { settleEndedRescueJob } = await import('../scripts/lib/recovery.mjs');
  const outcome = await settleEndedRescueJob({ store: racedStore, dataRoot: fixture.dataRoot, workspace, ownerSessionId: 'owner',
    epoch: EPOCH, lockTimeoutMs: 0, includeSettlementEvidence: true, unavailableOutcome: 'retain',
    revalidateReceiptBeforeStop: true,
    intent: { kind: 'stop', cause: 'host-coordination-loss' }, sessionEndReceiptEvidence: 'older',
    createClient: unavailableControlClient }, job.id);
  assert.equal(['retained-writable-guard', 'settled-terminal'].includes(outcome.kind), true, `the settlement stays bounded (was ${outcome.kind})`);
  const stored = await store.readJob(workspace, job.id);
  assert.equal(stored.status, 'cancelling', 'the retained guard keeps its durable cancelling status');
  assert.equal(stored.stopIntent?.cause, 'session-end', 'a receipt published before the persist must win the cause over coordination loss');
  assert.equal((await lifecycle.readReceipt(EPOCH)).state, 'pending', 'the racing receipt stays pending for its own SessionEnd reconciliation');
  await cleanupRecoveryFixture(fixture);
});

/** A store view that publishes the matching-epoch receipt only AFTER the settlement's durable job write: the first read observing the persisted `cancelling` record is strictly later than the in-lock revalidator's receipt read, so the publication lands in exactly the window the revalidator cannot close. */
function receiptPublishedAfterWriteStore(store, lifecycle, workspace, jobId, receiptInput) {
  let published = false;
  return {
    ...store,
    readJob: async (/** @type {string} */ readWorkspace, /** @type {string} */ readJobId, /** @type {any} */ options) => {
      const current = await store.readJob(readWorkspace, readJobId, options);
      if (readWorkspace === workspace && readJobId === jobId && !published && current.status === 'cancelling') {
        published = true;
        await lifecycle.publishSessionEnd(receiptInput, { signal: AbortSignal.timeout(250) });
      }
      return current;
    },
  };
}

test('the next reconciliation corrects a coordination-loss cause that outran the receipt publication', async () => {
  const fixture = await context(); const workspace = await realpath(fixture.workspace);
  const { hostLifecycleEpoch } = await import('../scripts/lib/host-lifecycle.mjs');
  const { createHostLifecycleStore } = await import('./helpers/host-lifecycle-store.mjs');
  const EPOCH = hostLifecycleEpoch('owner', '2026-01-01T00:00:00.000Z');
  const { store, job } = await hostOwnedRunningRescueInWorkspace(fixture, workspace, { session: 'zs-cl-backstop', input: 'input-cl-backstop', agent: 'cl-backstop-child', epoch: EPOCH, placement: 'foreground' });
  const lifecycle = createHostLifecycleStore({ dataRoot: fixture.dataRoot });
  assert.equal(await lifecycle.readReceipt(EPOCH), null, 'no receipt exists before the settlement');
  const racedStore = receiptPublishedAfterWriteStore(store, lifecycle, workspace, job.id, {
    sessionId: 'owner', sessionStartedAt: '2026-01-01T00:00:00.000Z', endedAt: new Date().toISOString(),
    origin: 'session-end-hook', workspaceHints: [workspace],
  });
  const { settleEndedRescueJob, endedObligationSettled } = await import('../scripts/lib/recovery.mjs');
  const outcome = await settleEndedRescueJob({ store: racedStore, dataRoot: fixture.dataRoot, workspace, ownerSessionId: 'owner',
    epoch: EPOCH, lockTimeoutMs: 0, includeSettlementEvidence: true, unavailableOutcome: 'retain',
    revalidateReceiptBeforeStop: true,
    intent: { kind: 'stop', cause: 'host-coordination-loss' }, sessionEndReceiptEvidence: 'older',
    createClient: unavailableControlClient }, job.id);
  assert.equal(outcome.kind, 'retained-writable-guard');
  const raced = await store.readJob(workspace, job.id);
  assert.equal(raced.stopIntent?.cause, 'host-coordination-loss', 'the revalidator read null, so the escaped race persisted coordination-loss');
  assert.equal((await lifecycle.readReceipt(EPOCH)).state, 'pending', 'the receipt published after the write is durably pending');
  // The later matching-receipt reconciliation (SessionEnd stage 5 / prompt-time
  // prior-epoch reconciliation) must correct the durable cause before discharge.
  const reconciliation = await settleEndedRescueJob({ store, dataRoot: fixture.dataRoot, workspace, ownerSessionId: 'owner',
    epoch: EPOCH, lockTimeoutMs: 0, includeSettlementEvidence: true, unavailableOutcome: 'retain',
    createClient: unavailableControlClient }, job.id);
  assert.equal(['retained-writable-guard', 'settled-terminal'].includes(reconciliation.kind), true, `the reconciliation stays bounded (was ${reconciliation.kind})`);
  const stored = await store.readJob(workspace, job.id);
  assert.equal(stored.status, 'cancelling', 'the corrected guard keeps its durable cancelling status');
  assert.equal(stored.stopIntent?.cause, 'session-end', 'the matching receipt wins over the persisted coordination-loss cause');
  assert.equal(endedObligationSettled(reconciliation), true, 'the corrected guard discharges the receipt without claiming stopped');
  await cleanupRecoveryFixture(fixture);
});

test('receipt discharge corrects a retained coordination-loss intent one way and never rewrites other causes', async () => {
  const fixture = await context(); const workspace = await realpath(fixture.workspace);
  await mkdir(join(fixture.root, 'workspace-b'));
  const workspaceB = await realpath(join(fixture.root, 'workspace-b'));
  const { hostLifecycleEpoch } = await import('../scripts/lib/host-lifecycle.mjs');
  const { createHostLifecycleStore } = await import('./helpers/host-lifecycle-store.mjs');
  const { hostOwnedStopIntentPatch } = await import('../scripts/lib/rescue-binding.mjs');
  const EPOCH = hostLifecycleEpoch('owner', '2026-01-01T00:00:00.000Z');
  const { delegateEndedStopIntent, settleEndedRescueJob } = await import('../scripts/lib/recovery.mjs');
  const coordinationLoss = await hostOwnedRunningRescueInWorkspace(fixture, workspace, { session: 'zs-cl-discharge', input: 'input-cl-discharge', agent: 'cl-discharge-child', epoch: EPOCH, placement: 'foreground' });
  const clCurrent = await coordinationLoss.store.readJob(workspace, coordinationLoss.job.id);
  await coordinationLoss.store.transitionJob(workspace, coordinationLoss.job.id, ['running'], 'cancelling', hostOwnedStopIntentPatch(clCurrent, 'host-coordination-loss'));
  const userStopped = await hostOwnedRunningRescueInWorkspace(fixture, workspaceB, { session: 'zs-user-discharge', input: 'input-user-discharge', agent: 'user-discharge-child', epoch: EPOCH, placement: 'foreground' });
  const userCurrent = await userStopped.store.readJob(workspaceB, userStopped.job.id);
  await userStopped.store.transitionJob(workspaceB, userStopped.job.id, ['running'], 'cancelling', hostOwnedStopIntentPatch(userCurrent, 'user'));
  const lifecycle = createHostLifecycleStore({ dataRoot: fixture.dataRoot });
  await lifecycle.publishSessionEnd({
    sessionId: 'owner', sessionStartedAt: '2026-01-01T00:00:00.000Z', endedAt: new Date().toISOString(),
    origin: 'session-end-hook', workspaceHints: [workspace, workspaceB],
  }, { signal: AbortSignal.timeout(250) });
  const delegated = await delegateEndedStopIntent({ store: coordinationLoss.store, dataRoot: fixture.dataRoot, workspace, ownerSessionId: 'owner', epoch: EPOCH }, coordinationLoss.job.id);
  assert.equal(delegated.status, 'cancelling', 'discharge never claims a stopped terminal');
  assert.equal(delegated.stopIntent.cause, 'session-end', 'the matching pending receipt corrects the coordination-loss cause at discharge');
  assert.equal((await coordinationLoss.store.readJob(workspace, coordinationLoss.job.id)).stopIntent.cause, 'session-end');
  const untouched = await delegateEndedStopIntent({ store: userStopped.store, dataRoot: fixture.dataRoot, workspace: workspaceB, ownerSessionId: 'owner', epoch: EPOCH }, userStopped.job.id);
  assert.equal(untouched.stopIntent.cause, 'user', 'a cause other than coordination-loss is never rewritten');
  // One-way: a later coordination-loss settlement pass over the corrected guard never downgrades it.
  await settleEndedRescueJob({ store: coordinationLoss.store, dataRoot: fixture.dataRoot, workspace, ownerSessionId: 'owner',
    epoch: EPOCH, lockTimeoutMs: 0, includeSettlementEvidence: true, unavailableOutcome: 'retain',
    intent: { kind: 'stop', cause: 'host-coordination-loss' }, sessionEndReceiptEvidence: 'older',
    createClient: unavailableControlClient }, coordinationLoss.job.id);
  assert.equal((await coordinationLoss.store.readJob(workspace, coordinationLoss.job.id)).stopIntent.cause, 'session-end',
    'a corrected session-end cause is never rewritten back to coordination-loss');
  await cleanupRecoveryFixture(fixture);
});

test('coordination-loss settlement keeps its cause when the recheck still finds no receipt', async () => {
  const fixture = await context(); const workspace = await realpath(fixture.workspace);
  const { hostLifecycleEpoch } = await import('../scripts/lib/host-lifecycle.mjs');
  const { createHostLifecycleStore } = await import('./helpers/host-lifecycle-store.mjs');
  const EPOCH = hostLifecycleEpoch('owner', '2026-01-01T00:00:00.000Z');
  const { store, job } = await hostOwnedRunningRescueInWorkspace(fixture, workspace, { session: 'zs-cl-recheck-clean', input: 'input-cl-recheck-clean', agent: 'cl-recheck-clean-child', epoch: EPOCH, placement: 'foreground' });
  const lifecycle = createHostLifecycleStore({ dataRoot: fixture.dataRoot });
  const { settleEndedRescueJob } = await import('../scripts/lib/recovery.mjs');
  await settleEndedRescueJob({ store, dataRoot: fixture.dataRoot, workspace, ownerSessionId: 'owner',
    epoch: EPOCH, lockTimeoutMs: 0, includeSettlementEvidence: true, unavailableOutcome: 'retain',
    revalidateReceiptBeforeStop: true,
    intent: { kind: 'stop', cause: 'host-coordination-loss' }, sessionEndReceiptEvidence: 'older',
    createClient: unavailableControlClient }, job.id);
  const stored = await store.readJob(workspace, job.id);
  assert.equal(stored.status, 'cancelling');
  assert.equal(stored.stopIntent?.cause, 'host-coordination-loss', 'an absent receipt never rewrites the coordination-loss cause');
  assert.equal(await lifecycle.readReceipt(EPOCH), null);
  await cleanupRecoveryFixture(fixture);
});

test('SessionEnd delegates an unresolved obligation to a durable session-end stop intent without remote control', async () => {
  const fixture = await context(); const store = createStateStore({ dataRoot: fixture.dataRoot });
  const workspace = await realpath(fixture.workspace);
  const { hostLifecycleEpoch } = await import('../scripts/lib/host-lifecycle.mjs');
  const EPOCH = hostLifecycleEpoch('owner', '2026-01-01T00:00:00.000Z');
  const { job } = await hostOwnedRunningRescueInWorkspace(fixture, workspace, { session: 'zs-delegate', input: 'input-delegate', agent: 'delegate-child', epoch: EPOCH });
  const { delegateEndedStopIntent } = await import('../scripts/lib/recovery.mjs');
  const delegated = await delegateEndedStopIntent({ store, dataRoot: fixture.dataRoot, workspace, ownerSessionId: 'owner' }, job.id);
  assert.equal(delegated.status, 'cancelling', 'delegation moves the running writable rescue to cancelling so a later reconciliation continues');
  assert.equal(delegated.stopIntent.cause, 'session-end');
  assert.equal((await store.readJob(workspace, job.id)).status, 'cancelling');
  await cleanupRecoveryFixture(fixture);
});

test('read-only detached recovery retains the durable remote turn when a stop cannot establish a winner', async () => {
  const fixture = await context(); const { job, store } = await orphanJob(fixture, { command: 'rescue', readOnly: true, turnId: 'readonly-retention' });
  let stops = 0;
  const settled = await settleSelectedJobProbe(store, fixture, job.id);
  assert.ok(['running', 'cancelling'].includes(settled.status), 'process death alone must not publish a remote cancellation');
  assert.notEqual(settled.status, 'cancelled', 'a read-only orphan is never cancelled by process death alone');
  assert.equal(stops, 0, 'a running read-only orphan with a live remote turn is not blindly stopped');
  await cleanupRecoveryFixture(fixture);
  async function settleSelectedJobProbe(stateStore, ctx, jobId) {
    const { reconcileOwnedJobs } = await import('../scripts/lib/recovery.mjs');
    const outcomes = await reconcileOwnedJobs({
      store: stateStore, dataRoot: ctx.dataRoot, workspace: ctx.workspace, ownerSessionId: job.ownerSessionId,
      reconcileOwnership: async () => {},
      createClient: async () => ({
        listSessions: async () => ({ sessions: [{ sessionId: job.zcodeSessionId }] }),
        readSession: async () => activeCurrentTurn(job.inputId),
        stopSession: async () => { stops += 1; }, close: async () => {},
      }),
    });
    return outcomes.find((candidate) => candidate.id === jobId) ?? await stateStore.readJob(ctx.workspace, jobId);
  }
});

test('SessionEnd discovery fails closed at its bounded budget when the workspace job-state lock is contended', async () => {
  const fixture = await context(); const store = createStateStore({ dataRoot: fixture.dataRoot });
  const workspace = await realpath(fixture.workspace);
  const { discoverSessionEndObligations } = await import('../scripts/lib/recovery.mjs');
  const { withFileLock } = await import('../scripts/lib/fs.mjs');
  const storage = await resolveWorkspaceStorage({ dataRoot: fixture.dataRoot, workspace });
  const started = Date.now();
  // Pre-acquire the exact job-state workspace lock, then discovery given a short
  // stage timeout must fail closed at the bound instead of waiting the default
  // five-second state lock.
  await withFileLock(join(storage.directory, '.state.lock'), async () => {
    await assert.rejects(
      discoverSessionEndObligations({ store, knownWorkspaces: [workspace], ownerSessionId: 'owner', epoch: null, timeoutMs: 50 }),
      (error) => error?.code === 'LOCK_TIMEOUT',
    );
  });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 1_500, `bounded discovery must fail closed well before the default 5s lock wait (took ${elapsed}ms)`);
  await cleanupRecoveryFixture(fixture);
});

test('SessionEnd owner-release guard marks a workspace with an active foreign-epoch writable job release-unsafe', async () => {
  const fixture = await context(); const store = createStateStore({ dataRoot: fixture.dataRoot });
  const workspaceA = await realpath(fixture.workspace);
  await mkdir(join(fixture.root, 'workspace-clean'));
  const workspaceClean = await realpath(join(fixture.root, 'workspace-clean'));
  const { hostLifecycleEpoch } = await import('../scripts/lib/host-lifecycle.mjs');
  const OLD = hostLifecycleEpoch('owner', '2026-01-01T00:00:00.000Z');
  const NEWER = hostLifecycleEpoch('owner', '2026-02-02T00:00:00.000Z');
  // workspaceA: an active writable job owned by a NEWER epoch (a post-resume turn).
  await hostOwnedRunningRescueInWorkspace(fixture, workspaceA, { session: 'zs-newer', input: 'input-newer', agent: 'newer-child', epoch: NEWER });
  // workspaceClean: an active writable job owned by the SAME (old) epoch — this one
  // is this receipt's own obligation, so it is NOT foreign.
  await hostOwnedRunningRescueInWorkspace(fixture, workspaceClean, { session: 'zs-old', input: 'input-old', agent: 'old-child', epoch: OLD });
  const { activeForeignEpochWorkspaces } = await import('../scripts/lib/recovery.mjs');
  const foreign = await activeForeignEpochWorkspaces({ store, knownWorkspaces: [workspaceA, workspaceClean], ownerSessionId: 'owner', epoch: OLD });
  assert.deepEqual([...foreign], [workspaceA], 'a workspace with an active newer-epoch job is release-unsafe; a same-epoch active job is this receipt obligation');
  // A null epoch cannot scope the exclusion.
  const allForeign = await activeForeignEpochWorkspaces({ store, knownWorkspaces: [workspaceA, workspaceClean], ownerSessionId: 'owner', epoch: null });
  assert.equal(allForeign.size, 0, 'an unproven epoch treats no workspace as foreign');
  await cleanupRecoveryFixture(fixture);
});

test('the SessionEnd-wrapped state seams honor the bounded lock budget and preserve defaults', async () => {
  const fixture = await context(); const store = createStateStore({ dataRoot: fixture.dataRoot });
  const workspace = await realpath(fixture.workspace);
  const { hostLifecycleEpoch } = await import('../scripts/lib/host-lifecycle.mjs');
  const EPOCH = hostLifecycleEpoch('owner', '2026-01-01T00:00:00.000Z');
  const { job } = await hostOwnedRunningRescueInWorkspace(fixture, workspace, { session: 'zs-seam', input: 'in-seam', agent: 'seam-child', epoch: EPOCH });
  const { withFileLock } = await import('../scripts/lib/fs.mjs');
  const storage = await resolveWorkspaceStorage({ dataRoot: fixture.dataRoot, workspace });
  const contended = (promise) => assert.rejects(promise, (error) => error?.code === 'LOCK_TIMEOUT');
  const started = Date.now();
  await withFileLock(join(storage.directory, '.state.lock'), async () => {
    await contended(store.revalidateBoundRescueStop({ workspace, jobId: job.id, ownerSessionId: 'owner', status: 'running', zcodeSessionId: 'zs-seam', timeoutMs: 50 }));
    await contended(store.finishQueuedJobAfterRecoveryLease(workspace, job.id, null, undefined, 'failed', {}, { timeoutMs: 50 }));
    await contended(store.cleanupTerminalExecutionReservation(workspace, job.id, { releaseExecutionReservation: async () => {} }, { timeoutMs: 50 }));
    // The guarded active-continuation rollback transaction and the standalone
    // cancelled-resume binding lookup are SessionEnd-bounded seams too: their
    // state-lock waits must honor the same sub-budget (the rollback's proof and
    // binding validation all live INSIDE the bounded acquisition, so a contended
    // call never validates anything and never waits the default five seconds).
    await contended(store.finishActiveRescueContinuationFailure(workspace, job.id, null, undefined, 'failed', {}, { timeoutMs: 50 }));
    await contended(store.rescueBindingForJob({ workspace, ownerSessionId: 'owner', jobId: job.id }, { timeoutMs: 50 }));
  });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 1_500, `every bounded seam must fail closed well before the default 5s lock wait (took ${elapsed}ms)`);
  // Omitting the budget keeps the existing unlocked-completion defaults exactly,
  // and an AbortSignal in the input is a lock option, never a binding-validation
  // failure (the bounded SessionEnd wrapper always threads one).
  const controller = new AbortController();
  await store.revalidateBoundRescueStop({ workspace, jobId: job.id, ownerSessionId: 'owner', status: 'running', zcodeSessionId: 'zs-seam', signal: controller.signal, timeoutMs: 250 });
  await cleanupRecoveryFixture(fixture);
});

test('delegateEndedStopIntent threads the caller lock budget and refuses a successor epoch', async () => {
  const { delegateEndedStopIntent } = await import('../scripts/lib/recovery.mjs');
  const { hostLifecycleEpoch } = await import('../scripts/lib/host-lifecycle.mjs');
  const EPOCH = hostLifecycleEpoch('owner', '2026-01-01T00:00:00.000Z');
  const SUCCESSOR = hostLifecycleEpoch('owner', '2026-02-02T00:00:00.000Z');
  const triple = { id: 'j1', ownerSessionId: 'owner', command: 'rescue', readOnly: false, status: 'running', zcodeSessionId: 'zs', ownerLifecycleEpoch: EPOCH, executionOwner: 'host-child', hostPlacement: 'background' };
  const spyStore = (job) => {
    const seen = [];
    return { seen, readJob: async (workspace, jobId, options = {}) => { seen.push(options); return { ...job }; },
      transitionJob: async (workspace, jobId, expected, next, patch, options = {}) => { seen.push(options); return { ...job, status: next }; } };
  };
  const controller = new AbortController();
  const writable = spyStore(triple);
  await delegateEndedStopIntent({ store: writable, dataRoot: 'd', workspace: 'w', ownerSessionId: 'owner', epoch: EPOCH, endedAt: '2026-01-01T00:00:00.000Z', signal: controller.signal, timeoutMs: 25 }, 'j1');
  assert.equal(writable.seen.length, 2, 'the delegation performs its read and its intent write under the caller budget');
  assert.ok(writable.seen.every((options) => options.timeoutMs === 25 && options.signal === controller.signal), 'both state touches share the caller signal and sub-budget');
  const successor = spyStore({ ...triple, ownerLifecycleEpoch: SUCCESSOR });
  await assert.rejects(
    delegateEndedStopIntent({ store: successor, dataRoot: 'd', workspace: 'w', ownerSessionId: 'owner', epoch: EPOCH, endedAt: '2026-01-01T00:00:00.000Z' }, 'j1'),
    (error) => /epoch/i.test(error?.message ?? ''),
  );
  assert.equal(successor.seen.length, 1, 'a successor-epoch record is refused before any intent write');
});

test('SessionEnd excludes a trio-less successor run from obligations and marks it release-unsafe by boundary time', async () => {
  const fixture = await context(); const store = createStateStore({ dataRoot: fixture.dataRoot });
  const workspace = await realpath(fixture.workspace);
  const { hostLifecycleEpoch } = await import('../scripts/lib/host-lifecycle.mjs');
  const EPOCH = hostLifecycleEpoch('owner', '2026-01-01T00:00:00.000Z');
  // A read-only detached review carries no lifecycle trio; its only boundary
  // evidence is its creation time against the receipt's own endedAt.
  const review = await store.reserveJob({ workspace, ownerSessionId: 'owner', ownerTurnId: 'ro-turn', command: 'review', readOnly: true, permissionSnapshot: { permissionMode: 'read-only' } });
  await store.transitionJob(workspace, review.id, ['queued'], 'running', { startedAt: new Date().toISOString(), zcodeSessionId: 'zs-ro' });
  const { discoverSessionEndObligations, activeForeignEpochWorkspaces } = await import('../scripts/lib/recovery.mjs');
  const pastBoundary = new Date(Date.now() - 60_000).toISOString();
  const futureBoundary = new Date(Date.now() + 60_000).toISOString();
  assert.deepEqual(await discoverSessionEndObligations({ store, knownWorkspaces: [workspace], ownerSessionId: 'owner', epoch: EPOCH, endedAt: pastBoundary }), [],
    'a run created after the boundary is not this receipt obligation, even without a lifecycle trio');
  const foreignAfter = await activeForeignEpochWorkspaces({ store, knownWorkspaces: [workspace], ownerSessionId: 'owner', epoch: EPOCH, endedAt: pastBoundary });
  assert.deepEqual([...foreignAfter], [workspace], 'the successor run marks its workspace unsafe to release');
  const obligationsBefore = await discoverSessionEndObligations({ store, knownWorkspaces: [workspace], ownerSessionId: 'owner', epoch: EPOCH, endedAt: futureBoundary });
  assert.equal(obligationsBefore.length, 1, 'a run that existed by the boundary keeps the legacy settle semantics');
  assert.equal((await activeForeignEpochWorkspaces({ store, knownWorkspaces: [workspace], ownerSessionId: 'owner', epoch: EPOCH, endedAt: futureBoundary })).size, 0);
  // An exactly-equal boundary millisecond is successor-owned too (RFC3339 ms
  // precision race): never this receipt's obligation, always release-unsafe.
  const storedReview = await store.readJob(workspace, review.id);
  assert.deepEqual(await discoverSessionEndObligations({ store, knownWorkspaces: [workspace], ownerSessionId: 'owner', epoch: EPOCH, endedAt: storedReview.createdAt }), []);
  assert.equal((await activeForeignEpochWorkspaces({ store, knownWorkspaces: [workspace], ownerSessionId: 'owner', epoch: EPOCH, endedAt: storedReview.createdAt })).size, 1);
  // An unproven boundary disables the timestamp guard exactly as before.
  assert.equal((await discoverSessionEndObligations({ store, knownWorkspaces: [workspace], ownerSessionId: 'owner', epoch: EPOCH })).length, 1);
  await cleanupRecoveryFixture(fixture);
});

test('SessionEnd settle-phase job read fails closed at its bounded budget when the workspace state lock is held', async () => {
  const fixture = await context(); const store = createStateStore({ dataRoot: fixture.dataRoot });
  const workspace = await realpath(fixture.workspace);
  const { hostLifecycleEpoch } = await import('../scripts/lib/host-lifecycle.mjs');
  const EPOCH = hostLifecycleEpoch('owner', '2026-01-01T00:00:00.000Z');
  const { job } = await hostOwnedRunningRescueInWorkspace(fixture, workspace, { session: 'zs-settle-lock', input: 'in-settle-lock', agent: 'settle-lock-child', epoch: EPOCH });
  const { settleEndedRescueJob } = await import('../scripts/lib/recovery.mjs');
  const { withFileLock } = await import('../scripts/lib/fs.mjs');
  const storage = await resolveWorkspaceStorage({ dataRoot: fixture.dataRoot, workspace });
  const started = Date.now();
  // Pre-hold the exact job-state lock, then a bounded settlement read must fail
  // closed at its sub-budget instead of waiting the default five-second state lock.
  await withFileLock(join(storage.directory, '.state.lock'), async () => {
    await assert.rejects(
      settleEndedRescueJob({ store, dataRoot: fixture.dataRoot, workspace, ownerSessionId: 'owner', epoch: EPOCH,
        lockTimeoutMs: 0, timeoutMs: 50, includeSettlementEvidence: true, createClient: async () => ({ readSession: async () => activeCurrentTurn('in-settle-lock'), stopSession: async () => {}, close: async () => {} }) }, job.id),
      (error) => error?.code === 'LOCK_TIMEOUT',
    );
  });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 1_500, `bounded settlement read must fail closed well before the default 5s lock wait (took ${elapsed}ms)`);
  await cleanupRecoveryFixture(fixture);
});

test('SessionEnd settle treats an unreadable/corrupt job read as pending, not as a proven missing job', async () => {
  const fixture = await context(); const store = createStateStore({ dataRoot: fixture.dataRoot });
  const workspace = await realpath(fixture.workspace);
  const { hostLifecycleEpoch } = await import('../scripts/lib/host-lifecycle.mjs');
  const { isJobNotFound } = await import('../scripts/lib/state.mjs');
  const EPOCH = hostLifecycleEpoch('owner', '2026-01-01T00:00:00.000Z');
  const { job } = await hostOwnedRunningRescueInWorkspace(fixture, workspace, { session: 'zs-corrupt', input: 'in-corrupt', agent: 'corrupt-child', epoch: EPOCH });
  const storage = await resolveWorkspaceStorage({ dataRoot: fixture.dataRoot, workspace });
  await writeFile(join(storage.directory, 'jobs', `${job.id}.json`), '{ this is not a valid job record');
  const { settleEndedRescueJob } = await import('../scripts/lib/recovery.mjs');
  // A corrupt read is NOT a proven absence: it must surface as an error so the
  // caller keeps the obligation pending rather than settling as if the job vanished.
  await assert.rejects(
    settleEndedRescueJob({ store, dataRoot: fixture.dataRoot, workspace, ownerSessionId: 'owner', epoch: EPOCH,
      lockTimeoutMs: 0, timeoutMs: 2_000, includeSettlementEvidence: true, createClient: async () => { throw new Error('no client'); } }, job.id),
    (error) => !isJobNotFound(error),
  );
  await cleanupRecoveryFixture(fixture);
});

/** One Host-owned detached-runner reservation claimed by a runner that has already exited: the
 * recorded claim lease is free, so pre-start settlement is evidence-eligible. A foreground
 * placement models the historical attached record and therefore carries no runner marker.
 * @param {any} fixture @param {string} workspace @param {{agent:string,epoch:string,placement?:string,claim?:boolean}} options */
async function hostOwnedQueuedRunnerJob(fixture, workspace, { agent, epoch, placement = 'background', claim = true }) {
  await recordBrokerIdentity(fixture.dataRoot, workspace);
  const store = createStateStore({ dataRoot: fixture.dataRoot });
  const reserved = await store.reserveFreshRescueJob({ workspace, reservation: { workspace, ownerSessionId: 'owner',
    ownerTurnId: `turn-${agent}`, command: 'rescue', readOnly: false, permissionSnapshot: { permissionMode: 'workspace-write' } },
    executor: { parentSessionId: 'owner', parentTurnId: `turn-${agent}`, agentId: agent, agentType: 'zcode-rescue',
      agentPath: '/root/zcode_rescue_task', workspace, parentPermissionMode: 'workspace-write' },
    lifecycle: { ownerLifecycleEpoch: epoch, executionOwner: 'host-child', hostPlacement: placement },
    ...(placement === 'background' ? { executionInput: { version: 1, task: 'bounded private task' } } : {}) });
  const worker = { childPid: 999_999_998, workerLeaseId: reserved.job.id };
  if (claim) await store.claimJobWorkerForExecution(workspace, reserved.job.id, worker);
  return { store, job: reserved.job, workerLeaseId: worker.workerLeaseId };
}

/** One Host-owned claimed queued ACTIVE-CONTINUATION attempt: the prior attempt succeeded, the
 * binding advanced to this queued continuation, and a runner claim (free lease) is retained.
 * @param {any} fixture @param {string} workspace @param {{agent:string,epoch:string}} options */
async function hostOwnedClaimedQueuedContinuation(fixture, workspace, { agent, epoch }) {
  await recordBrokerIdentity(fixture.dataRoot, workspace);
  const store = createStateStore({ dataRoot: fixture.dataRoot });
  const executor = { parentSessionId: 'owner', parentTurnId: `turn-${agent}`, agentId: agent,
    agentType: 'zcode-rescue', agentPath: '/root/zcode_rescue_task', workspace, parentPermissionMode: 'workspace-write' };
  const reservation = { workspace, ownerSessionId: 'owner', ownerTurnId: `turn-${agent}`, command: 'rescue',
    readOnly: false, permissionSnapshot: { permissionMode: 'workspace-write' } };
  const lifecycle = { ownerLifecycleEpoch: epoch, executionOwner: 'host-child', hostPlacement: 'background' };
  const first = await store.reserveFreshRescueJob({ workspace, reservation, executor, lifecycle,
    executionInput: { version: 1, task: 'bounded private task' } });
  const firstWorker = { childPid: 999_999_998, workerLeaseId: first.job.id };
  await store.claimJobWorkerForExecution(workspace, first.job.id, firstWorker);
  await store.transitionJob(workspace, first.job.id, ['queued'], 'running', {
    startedAt: new Date().toISOString(), zcodeSessionId: `zs-${agent}`, ...firstWorker });
  await store.finishJob(workspace, first.job.id, ['running'], 'succeeded');
  const continuation = await store.reserveBoundRescueContinuation({ workspace,
    reservation: { ...reservation, ownerTurnId: `turn-${agent}-b` }, executor, operationId: first.binding.operationId,
    lifecycle, executionInput: { version: 1, task: 'bounded private continuation' } });
  const worker = { childPid: process.pid, workerLeaseId: continuation.job.id };
  await store.claimJobWorkerForExecution(workspace, continuation.job.id, worker);
  return { store, job: continuation.job, workerLeaseId: worker.workerLeaseId,
    proof: continuation.job.rescueContinuationOrigin };
}

test('new runner queued jobs never fail from age alone and settle only with a proven free claim', async () => {
  const fixture = await context(); const workspace = await realpath(fixture.workspace);
  await mkdir(join(fixture.root, 'workspace-b'));
  const workspaceB = await realpath(join(fixture.root, 'workspace-b'));
  const { hostLifecycleEpoch } = await import('../scripts/lib/host-lifecycle.mjs');
  const EPOCH = hostLifecycleEpoch('owner', '2026-01-01T00:00:00.000Z');
  const unclaimed = await hostOwnedQueuedRunnerJob(fixture, workspace, { agent: 'ageless-unclaimed', epoch: EPOCH, claim: false });
  const claimed = await hostOwnedQueuedRunnerJob(fixture, workspaceB, { agent: 'ageless-claimed', epoch: EPOCH });
  const { scavengeWritableJobs, withWorkerLease } = await import('../scripts/lib/recovery.mjs');
  const now = Date.now();
  for (const [selected, selectedWorkspace] of [[unclaimed.job, workspace], [claimed.job, workspaceB]]) {
    const storage = await resolveWorkspaceStorage({ dataRoot: fixture.dataRoot, workspace: selectedWorkspace });
    await atomicWriteJson(join(storage.directory, 'jobs', `${selected.id}.json`),
      { ...(await unclaimed.store.readJob(selectedWorkspace, selected.id)), createdAt: new Date(now - 600_000).toISOString() });
  }
  const scavenge = (/** @type {string} */ scavengeWorkspace) => scavengeWritableJobs({ store: unclaimed.store,
    dataRoot: fixture.dataRoot, workspace: scavengeWorkspace, now: () => now,
    reconcileOwnership: async () => { throw new Error('queued runner jobs need no ownership reconciliation'); },
    createClient: async () => { throw new Error('queued runner jobs need no control client'); } });
  // An arbitrarily old unclaimed runner job stays queued, and a held claim defers.
  await withWorkerLease({ dataRoot: fixture.dataRoot, workspace: workspaceB, jobId: claimed.job.id,
    workerLeaseId: claimed.workerLeaseId }, () => scavenge(workspaceB));
  await scavenge(workspace);
  assert.equal((await unclaimed.store.readJob(workspace, unclaimed.job.id)).status, 'queued');
  assert.equal((await unclaimed.store.readJob(workspaceB, claimed.job.id)).status, 'queued');
  // A proven free claim lease permits pre-start failure: input removed, marker kept.
  await scavenge(workspaceB);
  const failed = await unclaimed.store.readJob(workspaceB, claimed.job.id);
  assert.equal(failed.status, 'failed');
  assert.equal('rescueExecutionInput' in failed, false);
  assert.equal(failed.rescueRunnerVersion, 1);
  await cleanupRecoveryFixture(fixture);
});

test('unclaimed queued runner jobs settle a durable stop intent as cancelled during recovery', async () => {
  const fixture = await context();
  await mkdir(join(fixture.root, 'workspace-b'));
  const workspace = await realpath(fixture.workspace);
  const workspaceB = await realpath(join(fixture.root, 'workspace-b'));
  const { hostLifecycleEpoch } = await import('../scripts/lib/host-lifecycle.mjs');
  const EPOCH = hostLifecycleEpoch('owner', '2026-01-01T00:00:00.000Z');
  const scavengeCase = await hostOwnedQueuedRunnerJob(fixture, workspace, { agent: 'unclaimed-intent-scavenge', epoch: EPOCH, claim: false });
  const ownerCase = await hostOwnedQueuedRunnerJob(fixture, workspaceB, { agent: 'unclaimed-intent-owner', epoch: EPOCH, claim: false });
  for (const [selectedWorkspace, caseContext] of [[workspace, scavengeCase], [workspaceB, ownerCase]]) {
    const storage = await resolveWorkspaceStorage({ dataRoot: fixture.dataRoot, workspace: selectedWorkspace });
    await atomicWriteJson(join(storage.directory, 'jobs', `${caseContext.job.id}.json`), { ...(await caseContext.store.readJob(selectedWorkspace, caseContext.job.id)),
      stopIntent: { version: 1, cause: 'user', requestedAt: new Date().toISOString() } });
    assert.equal((await caseContext.store.rescueBindingForJob({ workspace: selectedWorkspace, ownerSessionId: 'owner', jobId: caseContext.job.id }))?.state, 'active');
  }
  const noRemote = {
    reconcileOwnership: async () => { throw new Error('queued runner jobs need no ownership reconciliation'); },
    createClient: async () => { throw new Error('queued runner jobs need no control client'); },
  };
  const { scavengeWritableJobs, reconcileOwnedJobs } = await import('../scripts/lib/recovery.mjs');
  await scavengeWritableJobs({ store: scavengeCase.store, dataRoot: fixture.dataRoot, workspace, ...noRemote });
  await reconcileOwnedJobs({ store: ownerCase.store, dataRoot: fixture.dataRoot, workspace: workspaceB, ownerSessionId: 'owner', ...noRemote });
  for (const [selectedWorkspace, caseContext, kind] of [[workspace, scavengeCase, 'scavenge'], [workspaceB, ownerCase, 'owner-recovery']]) {
    const settled = await caseContext.store.readJob(selectedWorkspace, caseContext.job.id);
    assert.equal(settled.status, 'cancelled', `${kind}: the persisted stop decision must not stay queued forever`);
    assert.equal(settled.stopCause, 'user', kind);
    assert.equal(settled.stopIntent.cause, 'user', kind);
    assert.equal('rescueExecutionInput' in settled, false, `${kind}: the runner input is removed with the cancelled settlement`);
    assert.equal(settled.rescueRunnerVersion, 1, kind);
    assert.equal(await caseContext.store.rescueBindingForJob({ workspace: selectedWorkspace, ownerSessionId: 'owner', jobId: caseContext.job.id }), null,
      `${kind}: the cancelled settlement closes the exact operation binding`);
  }
  await cleanupRecoveryFixture(fixture);
});

test('an unclaimed legacy queued job settles its durable stop intent cancelled before the claim grace', async () => {
  const fixture = await context(); const workspace = await realpath(fixture.workspace);
  const { hostLifecycleEpoch } = await import('../scripts/lib/host-lifecycle.mjs');
  const EPOCH = hostLifecycleEpoch('owner', '2026-01-01T00:00:00.000Z');
  // Foreground placement models the historical attached record: the lifecycle
  // trio is present but there is NO runner marker, so recovery reaches this
  // record through the legacy claim-grace branch, not the marker branch.
  const { store, job } = await hostOwnedQueuedRunnerJob(fixture, workspace, { agent: 'unmarked-intent-child', epoch: EPOCH, placement: 'foreground', claim: false });
  const storage = await resolveWorkspaceStorage({ dataRoot: fixture.dataRoot, workspace });
  const now = Date.now();
  await atomicWriteJson(join(storage.directory, 'jobs', `${job.id}.json`), { ...(await store.readJob(workspace, job.id)),
    createdAt: new Date(now - 60_000).toISOString(), updatedAt: new Date(now - 60_000).toISOString(),
    stopIntent: { version: 1, cause: 'user', requestedAt: new Date().toISOString() } });
  assert.equal('rescueRunnerVersion' in (await store.readJob(workspace, job.id)), false, 'the fixture must model the unmarked legacy record');
  assert.equal((await store.rescueBindingForJob({ workspace, ownerSessionId: 'owner', jobId: job.id }))?.state, 'active');
  const { scavengeWritableJobs } = await import('../scripts/lib/recovery.mjs');
  await scavengeWritableJobs({ store, dataRoot: fixture.dataRoot, workspace, now: () => now,
    reconcileOwnership: async () => { throw new Error('queued reservations need no ownership reconciliation'); },
    createClient: async () => { throw new Error('queued reservations need no control client'); } });
  const settled = await store.readJob(workspace, job.id);
  assert.equal(settled.status, 'cancelled', 'the durable stop decision must not wait out the legacy claim grace');
  assert.equal(settled.stopCause, 'user');
  assert.equal(settled.stopIntent.cause, 'user');
  assert.equal(await store.rescueBindingForJob({ workspace, ownerSessionId: 'owner', jobId: job.id }), null,
    'the cancelled settlement closes the exact operation binding');
  await cleanupRecoveryFixture(fixture);
});

test('an unclaimed queued runner job settles its session-end intent cancelled when the epoch receipt matches', async () => {
  const fixture = await context(); const workspace = await realpath(fixture.workspace);
  const { hostLifecycleEpoch } = await import('../scripts/lib/host-lifecycle.mjs');
  const { createHostLifecycleStore } = await import('./helpers/host-lifecycle-store.mjs');
  const EPOCH = hostLifecycleEpoch('owner', '2026-01-01T00:00:00.000Z');
  const { store, job } = await hostOwnedQueuedRunnerJob(fixture, workspace, { agent: 'unclaimed-se-child', epoch: EPOCH, claim: false });
  const storage = await resolveWorkspaceStorage({ dataRoot: fixture.dataRoot, workspace });
  await atomicWriteJson(join(storage.directory, 'jobs', `${job.id}.json`), { ...(await store.readJob(workspace, job.id)),
    stopIntent: { version: 1, cause: 'session-end', requestedAt: new Date().toISOString() } });
  await createHostLifecycleStore({ dataRoot: fixture.dataRoot }).publishSessionEnd({
    sessionId: 'owner', sessionStartedAt: '2026-01-01T00:00:00.000Z', endedAt: new Date().toISOString(),
    origin: 'session-end-hook', workspaceHints: [workspace],
  }, { signal: AbortSignal.timeout(250) });
  const { scavengeWritableJobs } = await import('../scripts/lib/recovery.mjs');
  await scavengeWritableJobs({ store, dataRoot: fixture.dataRoot, workspace,
    reconcileOwnership: async () => { throw new Error('queued runner jobs need no ownership reconciliation'); },
    createClient: async () => { throw new Error('queued runner jobs need no control client'); } });
  const settled = await store.readJob(workspace, job.id);
  assert.equal(settled.status, 'cancelled', 'the session-end stop decision must not stay queued forever');
  assert.equal(settled.stopCause, 'session-end');
  assert.equal(settled.stopIntent.cause, 'session-end');
  assert.equal('rescueExecutionInput' in settled, false);
  await cleanupRecoveryFixture(fixture);
});

test('an unclaimed queued runner job without a stop intent still never ages into failure', async () => {
  const fixture = await context(); const workspace = await realpath(fixture.workspace);
  const { hostLifecycleEpoch } = await import('../scripts/lib/host-lifecycle.mjs');
  const EPOCH = hostLifecycleEpoch('owner', '2026-01-01T00:00:00.000Z');
  const { store, job } = await hostOwnedQueuedRunnerJob(fixture, workspace, { agent: 'unclaimed-ageless-child', epoch: EPOCH, claim: false });
  const storage = await resolveWorkspaceStorage({ dataRoot: fixture.dataRoot, workspace });
  const now = Date.now();
  await atomicWriteJson(join(storage.directory, 'jobs', `${job.id}.json`), { ...(await store.readJob(workspace, job.id)),
    createdAt: new Date(now - 600_000).toISOString(), updatedAt: new Date(now - 600_000).toISOString() });
  const { scavengeWritableJobs } = await import('../scripts/lib/recovery.mjs');
  await scavengeWritableJobs({ store, dataRoot: fixture.dataRoot, workspace, now: () => now,
    reconcileOwnership: async () => { throw new Error('queued runner jobs need no ownership reconciliation'); },
    createClient: async () => { throw new Error('queued runner jobs need no control client'); } });
  assert.equal((await store.readJob(workspace, job.id)).status, 'queued', 'age alone never fails an unclaimed marked queued job');
  await cleanupRecoveryFixture(fixture);
});

test('a durable queued stop intent wins recovery settlement over pre-start failure', async () => {
  const fixture = await context(); const workspace = await realpath(fixture.workspace);
  const { hostLifecycleEpoch } = await import('../scripts/lib/host-lifecycle.mjs');
  const EPOCH = hostLifecycleEpoch('owner', '2026-01-01T00:00:00.000Z');
  const { store, job } = await hostOwnedQueuedRunnerJob(fixture, workspace, { agent: 'stop-wins-child', epoch: EPOCH });
  const storage = await resolveWorkspaceStorage({ dataRoot: fixture.dataRoot, workspace });
  await atomicWriteJson(join(storage.directory, 'jobs', `${job.id}.json`), { ...(await store.readJob(workspace, job.id)),
    stopIntent: { version: 1, cause: 'session-end', requestedAt: new Date().toISOString() } });
  const { scavengeWritableJobs } = await import('../scripts/lib/recovery.mjs');
  await scavengeWritableJobs({ store, dataRoot: fixture.dataRoot, workspace,
    reconcileOwnership: async () => { throw new Error('queued runner jobs need no ownership reconciliation'); },
    createClient: async () => { throw new Error('queued runner jobs need no control client'); } });
  const settled = await store.readJob(workspace, job.id);
  assert.equal(settled.status, 'cancelled', 'a winning stop intent must select cancellation, never failure');
  assert.equal(settled.stopCause, 'session-end');
  assert.equal(settled.stopIntent.cause, 'session-end');
  assert.equal('rescueExecutionInput' in settled, false);
  assert.equal(settled.rescueRunnerVersion, 1);
  await cleanupRecoveryFixture(fixture);
});

test('cancellation racing infrastructure failure settles cancelled and never publishes the failure', async () => {
  const fixture = await context(); const workspace = await realpath(fixture.workspace);
  const { hostLifecycleEpoch } = await import('../scripts/lib/host-lifecycle.mjs');
  const EPOCH = hostLifecycleEpoch('owner', '2026-01-01T00:00:00.000Z');
  const { store, job } = await hostOwnedQueuedRunnerJob(fixture, workspace, { agent: 'cancel-race-child', epoch: EPOCH });
  const storage = await resolveWorkspaceStorage({ dataRoot: fixture.dataRoot, workspace });
  let reads = 0;
  const raced = {
    ...store,
    readJob: async (/** @type {string} */ readWorkspace, /** @type {string} */ readJobId, /** @type {any} */ options) => {
      const current = await store.readJob(readWorkspace, readJobId, options);
      if (current.id === job.id && current.status === 'queued' && current.stopIntent === undefined && ++reads === 2) {
        // The cancel's durable intent lands after recovery's first read but before
        // its locked settlement; the returned snapshot stays pre-intent on purpose.
        await atomicWriteJson(join(storage.directory, 'jobs', `${job.id}.json`), { ...current,
          stopIntent: { version: 1, cause: 'user', requestedAt: new Date().toISOString() } });
      }
      return current;
    },
  };
  const { scavengeWritableJobs } = await import('../scripts/lib/recovery.mjs');
  await scavengeWritableJobs({ store: raced, dataRoot: fixture.dataRoot, workspace,
    reconcileOwnership: async () => { throw new Error('queued runner jobs need no ownership reconciliation'); },
    createClient: async () => { throw new Error('queued runner jobs need no control client'); } });
  const settled = await store.readJob(workspace, job.id);
  assert.equal(settled.status, 'cancelled', 'the persisted stop decision must win the settlement race');
  assert.equal(settled.stopCause, 'user');
  assert.equal('rescueExecutionInput' in settled, false);
  await cleanupRecoveryFixture(fixture);
});

test('a stop intent delegated mid-race wins the active-continuation failure rollback', async () => {
  const fixture = await context(); const workspace = await realpath(fixture.workspace);
  const { hostLifecycleEpoch } = await import('../scripts/lib/host-lifecycle.mjs');
  const EPOCH = hostLifecycleEpoch('owner', '2026-01-01T00:00:00.000Z');
  const { store, job, workerLeaseId } = await hostOwnedClaimedQueuedContinuation(fixture, workspace,
    { agent: 'continuation-stop-race-child', epoch: EPOCH });
  let reads = 0;
  const raced = {
    ...store,
    readJob: async (/** @type {string} */ readWorkspace, /** @type {string} */ readJobId, /** @type {any} */ options) => {
      const current = await store.readJob(readWorkspace, readJobId, options);
      if (current.id === job.id && current.status === 'queued' && current.stopIntent === undefined && ++reads === 3) {
        // The SessionEnd delegation lands after recovery's unlocked intent probe
        // (the settle re-read) but before the locked rollback transaction re-reads
        // the record under the state lock: the specialized transaction must obey
        // the durable decision it then observes, exactly like the generic guard.
        await store.transitionJob(readWorkspace, job.id, ['queued'], 'queued',
          { stopIntent: { version: 1, cause: 'session-end', requestedAt: new Date().toISOString() } });
      }
      return current;
    },
  };
  const { failJob } = await import('../scripts/lib/recovery.mjs');
  const input = { store: raced, dataRoot: fixture.dataRoot, workspace };
  const escaped = await failJob(input, job, new Error('Claimed queued worker exited before execution started.'));
  assert.equal(escaped.status, 'queued', 'a winning stop intent must never be settled as failed by the rollback');
  assert.equal(escaped.stopIntent?.cause, 'session-end', 'the delegated intent stays authoritative');
  const settled = await failJob(input, job, new Error('Claimed queued worker exited before execution started.'));
  assert.equal(settled.status, 'cancelled', 'the delegated decision converges through the guarded cancellation');
  assert.equal(settled.stopCause, 'session-end');
  assert.equal(settled.stopIntent.cause, 'session-end');
  assert.equal(settled.workerLeaseId, workerLeaseId, 'the exact claim is retained through the settlement');
  await cleanupRecoveryFixture(fixture);
});

test('the active-continuation failure rollback honors a bounded SessionEnd lock budget under contention', async () => {
  const fixture = await context(); const workspace = await realpath(fixture.workspace);
  const { hostLifecycleEpoch } = await import('../scripts/lib/host-lifecycle.mjs');
  const EPOCH = hostLifecycleEpoch('owner', '2026-01-01T00:00:00.000Z');
  const { store, job, workerLeaseId, proof } = await hostOwnedClaimedQueuedContinuation(fixture, workspace,
    { agent: 'rollback-budget-child', epoch: EPOCH });
  const { withFileLock } = await import('../scripts/lib/fs.mjs');
  const storage = await resolveWorkspaceStorage({ dataRoot: fixture.dataRoot, workspace });
  // Contention is introduced mid-race: the holder grabs the exact workspace state
  // lock after the free-lease probe's re-read and releases it only once the
  // rollback attempt has concluded, so the guarded transaction must fail closed
  // at its bounded budget instead of waiting the default five-second state lock.
  let concludeRollback;
  const rollbackConcluded = new Promise((resolve) => { concludeRollback = resolve; });
  let enteredHolder;
  const holderEntered = new Promise((resolve) => { enteredHolder = resolve; });
  let reads = 0; let holder;
  const contended = {
    ...store,
    readJob: async (/** @type {string} */ readWorkspace, /** @type {string} */ readJobId, /** @type {any} */ options) => {
      const current = await store.readJob(readWorkspace, readJobId, options);
      if (current.id === job.id && current.status === 'queued' && ++reads === 3) {
        holder = withFileLock(join(storage.directory, '.state.lock'), async () => {
          enteredHolder();
          await rollbackConcluded;
        }).catch(() => {});
        await holderEntered;
      }
      return current;
    },
    finishActiveRescueContinuationFailure: async (/** @type {any} */ ...rollbackArgs) => {
      try { return await store.finishActiveRescueContinuationFailure(...rollbackArgs); }
      catch (error) { concludeRollback(); await holder; throw error; }
      finally { concludeRollback(); }
    },
  };
  const started = Date.now();
  const { failJob } = await import('../scripts/lib/recovery.mjs');
  const deferred = await failJob({ store: contended, dataRoot: fixture.dataRoot, workspace,
    signal: AbortSignal.timeout(2_500), timeoutMs: 250 }, job, new Error('Claimed queued worker exited before execution started.'));
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 2_000, `the contended rollback must defer well before the default 5s lock wait (took ${elapsed}ms)`);
  assert.equal(deferred.status, 'queued', 'a contended rollback defers: the claimed queued attempt stays queued for the next recovery pass');
  assert.equal(deferred.workerLeaseId, workerLeaseId, 'the exact claim is retained through the deferred settlement');
  assert.equal(deferred.stopIntent, undefined, 'no stop decision is fabricated by the deferred rollback');
  await holder;
  // The budget bounds waiting, never uncontended progress: once the lock is free,
  // the same bounded transaction restores the exact prior binding and publishes
  // the pre-start failure.
  const failed = await store.finishActiveRescueContinuationFailure(workspace, job.id, workerLeaseId, proof,
    'failed', { error: { message: 'Claimed queued worker exited before execution started.' }, exitCode: 1 }, { timeoutMs: 250 });
  assert.equal(failed.status, 'failed');
  assert.equal('rescueExecutionInput' in failed, false);
  assert.equal(await store.rescueBindingForJob({ workspace, ownerSessionId: 'owner', jobId: job.id }), null,
    'the bounded transaction restores the exact prior binding');
  await cleanupRecoveryFixture(fixture);
});

test('an already-fired SessionEnd abort aborts the active-continuation rollback before acquiring the state lock', async () => {
  const fixture = await context(); const workspace = await realpath(fixture.workspace);
  const { hostLifecycleEpoch } = await import('../scripts/lib/host-lifecycle.mjs');
  const EPOCH = hostLifecycleEpoch('owner', '2026-01-01T00:00:00.000Z');
  const { store, job } = await hostOwnedClaimedQueuedContinuation(fixture, workspace,
    { agent: 'rollback-abort-child', epoch: EPOCH });
  const { withFileLock } = await import('../scripts/lib/fs.mjs');
  const storage = await resolveWorkspaceStorage({ dataRoot: fixture.dataRoot, workspace });
  // The state lock is held for the remainder of the test, so any acquisition
  // attempt would wait: an already-aborted caller budget must refuse at the lock
  // door with the original abort reason instead of acquiring or timing out.
  let releaseHolder;
  const release = new Promise((resolve) => { releaseHolder = resolve; });
  let enteredHolder;
  const holderEntered = new Promise((resolve) => { enteredHolder = resolve; });
  let reads = 0;
  const contended = {
    ...store,
    readJob: async (/** @type {string} */ readWorkspace, /** @type {string} */ readJobId, /** @type {any} */ options) => {
      const current = await store.readJob(readWorkspace, readJobId, options);
      if (current.id === job.id && current.status === 'queued' && ++reads === 3) {
        void withFileLock(join(storage.directory, '.state.lock'), async () => {
          enteredHolder();
          await release;
        }).catch(() => {});
        await holderEntered;
      }
      return current;
    },
    finishActiveRescueContinuationFailure: async (/** @type {any} */ ...rollbackArgs) => {
      try { return await store.finishActiveRescueContinuationFailure(...rollbackArgs); }
      finally { releaseHolder(); }
    },
  };
  const controller = new AbortController();
  controller.abort();
  const started = Date.now();
  const { failJob } = await import('../scripts/lib/recovery.mjs');
  try {
    await assert.rejects(
      failJob({ store: contended, dataRoot: fixture.dataRoot, workspace,
        signal: controller.signal, timeoutMs: 250 }, job, new Error('Claimed queued worker exited before execution started.')),
      (error) => error === controller.signal.reason,
    );
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 2_000, `the aborted rollback must refuse promptly instead of acquiring (took ${elapsed}ms)`);
  } finally { releaseHolder(); }
  assert.equal((await store.readJob(workspace, job.id)).status, 'queued', 'the aborted attempt publishes nothing');
  await cleanupRecoveryFixture(fixture);
});

test('a queued claimed coordination-loss intent is corrected to session-end when its receipt exists', async () => {
  const fixture = await context(); const workspace = await realpath(fixture.workspace);
  const { hostLifecycleEpoch } = await import('../scripts/lib/host-lifecycle.mjs');
  const { createHostLifecycleStore } = await import('./helpers/host-lifecycle-store.mjs');
  const EPOCH = hostLifecycleEpoch('owner', '2026-01-01T00:00:00.000Z');
  const { store, job } = await hostOwnedQueuedRunnerJob(fixture, workspace, { agent: 'queued-cl-child', epoch: EPOCH, placement: 'foreground' });
  const storage = await resolveWorkspaceStorage({ dataRoot: fixture.dataRoot, workspace });
  await atomicWriteJson(join(storage.directory, 'jobs', `${job.id}.json`), { ...(await store.readJob(workspace, job.id)),
    stopIntent: { version: 1, cause: 'host-coordination-loss', requestedAt: new Date().toISOString() } });
  const lifecycle = createHostLifecycleStore({ dataRoot: fixture.dataRoot });
  await lifecycle.publishSessionEnd({
    sessionId: 'owner', sessionStartedAt: '2026-01-01T00:00:00.000Z', endedAt: new Date().toISOString(),
    origin: 'session-end-hook', workspaceHints: [workspace],
  }, { signal: AbortSignal.timeout(250) });
  const { settleEndedRescueJob } = await import('../scripts/lib/recovery.mjs');
  const outcome = await settleEndedRescueJob({ store, dataRoot: fixture.dataRoot, workspace, ownerSessionId: 'owner',
    epoch: EPOCH, lockTimeoutMs: 0, includeSettlementEvidence: true, unavailableOutcome: 'retain',
    intent: { kind: 'stop', cause: 'host-coordination-loss' }, sessionEndReceiptEvidence: 'older',
    createClient: unavailableControlClient }, job.id);
  assert.equal(outcome.kind, 'confirmed-cancellation');
  const stored = await store.readJob(workspace, job.id);
  assert.equal(stored.status, 'cancelled');
  assert.equal(stored.stopCause, 'session-end', 'the matching receipt wins the durable stop cause over coordination loss');
  assert.equal(stored.stopIntent.cause, 'session-end');
  await cleanupRecoveryFixture(fixture);
});

test('SessionEnd persists a claimed queued stop intent and settles cancelled once the lease is free', async () => {
  const fixture = await context(); const workspace = await realpath(fixture.workspace);
  const { hostLifecycleEpoch } = await import('../scripts/lib/host-lifecycle.mjs');
  const EPOCH = hostLifecycleEpoch('owner', '2026-01-01T00:00:00.000Z');
  const { store, job, workerLeaseId } = await hostOwnedQueuedRunnerJob(fixture, workspace, { agent: 'queued-se-child', epoch: EPOCH });
  const { settleEndedOwnerWritableJob, withWorkerLease } = await import('../scripts/lib/recovery.mjs');
  let leaseEntered = () => {}; const leaseAcquired = new Promise((resolve) => { leaseEntered = () => resolve(undefined); });
  let releaseLease = () => {}; const leaseReleased = new Promise((resolve) => { releaseLease = () => resolve(undefined); });
  const holder = withWorkerLease({ dataRoot: fixture.dataRoot, workspace, jobId: job.id, workerLeaseId },
    async () => { leaseEntered(); await leaseReleased; });
  const noClient = async () => { throw new Error('a queued reservation needs no control client'); };
  // The fixture records a dead executor pid (the runner exited, its exact claim
  // survives); the injected seams observe the identity-proven kill without
  // signaling anything and stage the sweep verdicts (the real termination and
  // sweep paths are qualified with a genuine detached holder in the Task 7
  // matrix tests below).
  /** @type {number[]} */ const kills = [];
  const terminate = async (/** @type {number} */ pid) => { kills.push(pid); };
  await leaseAcquired; // the settlement must observe the lease provably held, whatever the I/O scheduling
  const first = await settleEndedOwnerWritableJob({ store, dataRoot: fixture.dataRoot, workspace,
    ownerSessionId: 'owner', lockTimeoutMs: 0, includeSettlementEvidence: true, createClient: noClient, terminateProcessTree: terminate,
    sweepDeadRootDescendants: async () => ({ kind: 'swept', killed: [424_242], pending: [] }) });
  assert.deepEqual(kills, [999_999_998], 'the durable queued stop intent drives the bounded local termination of the lease-proven marked runner before the lease-acquiring settlement');
  assert.equal(first.kind, 'retained-writable-guard', 'a held claim whose same-pass sweep found survivors defers the settlement');
  const retained = await store.readJob(workspace, job.id);
  assert.equal(retained.status, 'queued');
  assert.equal(retained.workerLeaseId, workerLeaseId, 'the exact claim survives the deferred stop');
  assert.equal(retained.stopIntent?.cause, 'session-end', 'the stop decision is durable before any settlement');
  releaseLease(); await holder;
  const second = await settleEndedOwnerWritableJob({ store, dataRoot: fixture.dataRoot, workspace,
    ownerSessionId: 'owner', lockTimeoutMs: 0, includeSettlementEvidence: true, createClient: noClient, terminateProcessTree: terminate,
    sweepDeadRootDescendants: async () => ({ kind: 'clean' }) });
  assert.equal(second.kind, 'confirmed-cancellation');
  assert.equal(second.job.status, 'cancelled');
  assert.equal(second.job.stopCause, 'session-end');
  assert.equal('rescueExecutionInput' in second.job, false);
  assert.deepEqual(kills, [999_999_998], 'the proven-free lease on the second pass is never signaled again (PID-reuse guard); the completed-clean sweep settles');
  await cleanupRecoveryFixture(fixture);
});

test('a competing stop intent that wins the mid-race is adopted as the durable winner, never a leaked patch rejection', async () => {
  const fixture = await context(); const workspace = await realpath(fixture.workspace);
  const { hostLifecycleEpoch } = await import('../scripts/lib/host-lifecycle.mjs');
  const EPOCH = hostLifecycleEpoch('owner', '2026-01-01T00:00:00.000Z');
  const { store, job } = await hostOwnedQueuedRunnerJob(fixture, workspace, { agent: 'persist-race-child', epoch: EPOCH });
  let reads = 0;
  const raced = {
    ...store,
    readJob: async (/** @type {string} */ readWorkspace, /** @type {string} */ readJobId, /** @type {any} */ options) => {
      const current = await store.readJob(readWorkspace, readJobId, options);
      if (readWorkspace === workspace && readJobId === job.id && current.status === 'queued'
        && current.stopIntent === undefined && ++reads === 2) {
        // A concurrent user stop's durable intent lands after the settlement's
        // locked evidence read (the Reconciler's joined view) but before the
        // intent persist's state-locked write; the returned snapshot stays
        // pre-intent on purpose so the minted patch loses the race.
        await store.transitionJob(readWorkspace, job.id, ['queued'], 'queued',
          { stopIntent: { version: 1, cause: 'user', requestedAt: new Date().toISOString() } });
      }
      return current;
    },
  };
  const { settleEndedRescueJob } = await import('../scripts/lib/recovery.mjs');
  const outcome = await settleEndedRescueJob({ store: raced, dataRoot: fixture.dataRoot, workspace,
    ownerSessionId: 'owner', epoch: EPOCH, lockTimeoutMs: 0, includeSettlementEvidence: true,
    createClient: async () => { throw new Error('a claimed queued reservation needs no control client'); } }, job.id);
  assert.equal(outcome.kind, 'confirmed-cancellation', 'the raced stop converges instead of escaping the settlement');
  assert.equal(outcome.job.status, 'cancelled');
  assert.equal(outcome.job.stopCause, 'user', 'the COMPETING intent owns the durable stop cause');
  const stored = await store.readJob(workspace, job.id);
  assert.equal(stored.status, 'cancelled');
  assert.equal(stored.stopCause, 'user');
  assert.equal(stored.stopIntent.cause, 'user', 'the winning intent is never overwritten');
  assert.equal('rescueExecutionInput' in stored, false);
  await cleanupRecoveryFixture(fixture);
});

test('SessionEnd delegation corrects a queued coordination-loss intent before returning when its receipt exists', async () => {
  const fixture = await context(); const workspace = await realpath(fixture.workspace);
  const { hostLifecycleEpoch } = await import('../scripts/lib/host-lifecycle.mjs');
  const { createHostLifecycleStore } = await import('./helpers/host-lifecycle-store.mjs');
  const EPOCH = hostLifecycleEpoch('owner', '2026-01-01T00:00:00.000Z');
  const { store, job, workerLeaseId } = await hostOwnedQueuedRunnerJob(fixture, workspace, { agent: 'delegate-cl-child', epoch: EPOCH });
  const storage = await resolveWorkspaceStorage({ dataRoot: fixture.dataRoot, workspace });
  await atomicWriteJson(join(storage.directory, 'jobs', `${job.id}.json`), { ...(await store.readJob(workspace, job.id)),
    stopIntent: { version: 1, cause: 'host-coordination-loss', requestedAt: new Date().toISOString() } });
  const lifecycle = createHostLifecycleStore({ dataRoot: fixture.dataRoot });
  await lifecycle.publishSessionEnd({
    sessionId: 'owner', sessionStartedAt: '2026-01-01T00:00:00.000Z', endedAt: new Date().toISOString(),
    origin: 'session-end-hook', workspaceHints: [workspace],
  }, { signal: AbortSignal.timeout(250) });
  const { delegateEndedStopIntent } = await import('../scripts/lib/recovery.mjs');
  const delegated = await delegateEndedStopIntent({ store, dataRoot: fixture.dataRoot, workspace, ownerSessionId: 'owner', epoch: EPOCH }, job.id);
  assert.equal(delegated.status, 'queued', 'delegation never terminalizes the claimed queued runner');
  assert.equal(delegated.workerLeaseId, workerLeaseId, 'the exact claim is retained through the correction');
  assert.equal(delegated.stopIntent.cause, 'session-end', 'the matching receipt corrects the coordination-loss cause before the early return');
  assert.equal((await store.readJob(workspace, job.id)).stopIntent.cause, 'session-end', 'the correction is persisted durably');
  // Generic recovery later terminalizes on the persisted decision: the corrected
  // receipt-winning cause must be the durable cancelled label, not the stale one.
  const { scavengeWritableJobs } = await import('../scripts/lib/recovery.mjs');
  const now = Date.now();
  await scavengeWritableJobs({ store, dataRoot: fixture.dataRoot, workspace, now: () => now,
    reconcileOwnership: async () => { throw new Error('queued runner jobs need no ownership reconciliation'); },
    createClient: async () => { throw new Error('queued runner jobs need no control client'); } });
  const settled = await store.readJob(workspace, job.id);
  assert.equal(settled.status, 'cancelled');
  assert.equal(settled.stopCause, 'session-end', 'generic recovery terminalizes on the corrected receipt-winning cause');
  await cleanupRecoveryFixture(fixture);
});

test('SessionEnd delegation keeps a queued coordination-loss intent when no receipt exists', async () => {
  const fixture = await context(); const workspace = await realpath(fixture.workspace);
  const { hostLifecycleEpoch } = await import('../scripts/lib/host-lifecycle.mjs');
  const { createHostLifecycleStore } = await import('./helpers/host-lifecycle-store.mjs');
  const EPOCH = hostLifecycleEpoch('owner', '2026-01-01T00:00:00.000Z');
  const { store, job, workerLeaseId } = await hostOwnedQueuedRunnerJob(fixture, workspace, { agent: 'delegate-cl-norc-child', epoch: EPOCH });
  const storage = await resolveWorkspaceStorage({ dataRoot: fixture.dataRoot, workspace });
  await atomicWriteJson(join(storage.directory, 'jobs', `${job.id}.json`), { ...(await store.readJob(workspace, job.id)),
    stopIntent: { version: 1, cause: 'host-coordination-loss', requestedAt: new Date().toISOString() } });
  const lifecycle = createHostLifecycleStore({ dataRoot: fixture.dataRoot });
  assert.equal(await lifecycle.readReceipt(EPOCH), null, 'no receipt exists for the epoch');
  const { delegateEndedStopIntent } = await import('../scripts/lib/recovery.mjs');
  const delegated = await delegateEndedStopIntent({ store, dataRoot: fixture.dataRoot, workspace, ownerSessionId: 'owner', epoch: EPOCH }, job.id);
  assert.equal(delegated.status, 'queued');
  assert.equal(delegated.workerLeaseId, workerLeaseId, 'the exact claim is retained');
  assert.equal(delegated.stopIntent.cause, 'host-coordination-loss', 'an absent receipt never rewrites the coordination-loss cause');
  assert.equal((await store.readJob(workspace, job.id)).stopIntent.cause, 'host-coordination-loss');
  // The foreground policy keeps coordination-loss: generic recovery terminalizes on it unchanged.
  const { scavengeWritableJobs } = await import('../scripts/lib/recovery.mjs');
  const now = Date.now();
  await scavengeWritableJobs({ store, dataRoot: fixture.dataRoot, workspace, now: () => now,
    reconcileOwnership: async () => { throw new Error('queued runner jobs need no ownership reconciliation'); },
    createClient: async () => { throw new Error('queued runner jobs need no control client'); } });
  const settled = await store.readJob(workspace, job.id);
  assert.equal(settled.status, 'cancelled');
  assert.equal(settled.stopCause, 'host-coordination-loss', 'the pre-existing non-receipt semantics are preserved');
  await cleanupRecoveryFixture(fixture);
});

test('SessionEnd delegation adopts a competing valid intent that wins its mid-race instead of leaking the patch rejection', async () => {
  const fixture = await context(); const workspace = await realpath(fixture.workspace);
  const { hostLifecycleEpoch } = await import('../scripts/lib/host-lifecycle.mjs');
  const EPOCH = hostLifecycleEpoch('owner', '2026-01-01T00:00:00.000Z');
  const { store, job, workerLeaseId } = await hostOwnedQueuedRunnerJob(fixture, workspace, { agent: 'delegate-race-child', epoch: EPOCH });
  let reads = 0;
  const raced = {
    ...store,
    readJob: async (/** @type {string} */ readWorkspace, /** @type {string} */ readJobId, /** @type {any} */ options) => {
      const current = await store.readJob(readWorkspace, readJobId, options);
      if (readWorkspace === workspace && readJobId === job.id && current.status === 'queued'
        && current.stopIntent === undefined && ++reads === 1) {
        // A concurrent user stop's durable intent lands after the delegate's read
        // but before its state-locked write; the returned snapshot stays
        // pre-intent on purpose so the minted session-end patch loses the race.
        await store.transitionJob(readWorkspace, job.id, ['queued'], 'queued',
          { stopIntent: { version: 1, cause: 'user', requestedAt: new Date().toISOString() } });
      }
      return current;
    },
  };
  const { delegateEndedStopIntent, scavengeWritableJobs } = await import('../scripts/lib/recovery.mjs');
  const delegated = await delegateEndedStopIntent({ store: raced, dataRoot: fixture.dataRoot, workspace,
    ownerSessionId: 'owner', epoch: EPOCH }, job.id);
  assert.equal(delegated.status, 'queued', 'delegation stays bounded on the raced record');
  assert.equal(delegated.workerLeaseId, workerLeaseId, 'the exact claim is retained through the race');
  assert.equal(delegated.stopIntent?.cause, 'user', 'the competing intent is adopted, never replaced');
  // The later lease-acquisition settlement applies the adopted intent.
  await scavengeWritableJobs({ store, dataRoot: fixture.dataRoot, workspace,
    reconcileOwnership: async () => { throw new Error('queued runner jobs need no ownership reconciliation'); },
    createClient: async () => { throw new Error('queued runner jobs need no control client'); } });
  const settled = await store.readJob(workspace, job.id);
  assert.equal(settled.status, 'cancelled', 'the adopted decision converges on settlement');
  assert.equal(settled.stopCause, 'user');
  await cleanupRecoveryFixture(fixture);
});

/** One Host-owned queued runner in the exact execution-fence gap: `fenceJobWorkerExecution` has
 * published `rescueExecutionReservation.workerLeaseId` but `claimJobWorkerForExecution` has not yet
 * copied it to `job.workerLeaseId`, so the only durable lease evidence is the reservation's.
 * @param {any} fixture @param {string} workspace @param {{agent:string,epoch:string,lease:string}} options */
async function hostOwnedFencedQueuedRunnerJob(fixture, workspace, { agent, epoch, lease }) {
  const { store, job } = await hostOwnedQueuedRunnerJob(fixture, workspace, { agent, epoch, claim: false });
  const stored = await store.readJob(workspace, job.id);
  const authority = {
    version: 1, capabilityDigest: '1'.repeat(64), reservationId: '2'.repeat(64),
    jobId: stored.id, ownerSessionId: stored.ownerSessionId, workspace: stored.workspace,
    operation: 'run-reserved-job', jobSpecFormat: 'sealed-v2',
  };
  await store.publishJobSpecCommitment(workspace, stored.id, '3'.repeat(64), authority);
  await store.bindJobExecutionReservationLease(workspace, stored.id,
    { capabilityDigest: authority.capabilityDigest, reservationId: authority.reservationId, workerLeaseId: lease });
  const fenced = await store.readJob(workspace, stored.id);
  assert.equal(fenced.workerLeaseId, undefined, 'the fixture must model the pre-claim fence gap');
  assert.equal(fenced.rescueExecutionReservation.workerLeaseId, lease, 'the fixture must carry the fence lease');
  assert.equal(fenced.rescueRunnerVersion, 1, 'the fixture must model a marked runner reservation');
  return { store, job: fenced, workerLeaseId: lease };
}

const fencedNoRemote = {
  reconcileOwnership: async () => { throw new Error('queued runner jobs need no ownership reconciliation'); },
  createClient: async () => { throw new Error('queued runner jobs need no control client'); },
};

test('SessionEnd delegation persists the stop intent for a fenced not-yet-claimed queued runner', async () => {
  const fixture = await context(); const workspace = await realpath(fixture.workspace);
  const { hostLifecycleEpoch } = await import('../scripts/lib/host-lifecycle.mjs');
  const { createHostLifecycleStore } = await import('./helpers/host-lifecycle-store.mjs');
  const EPOCH = hostLifecycleEpoch('owner', '2026-01-01T00:00:00.000Z');
  const { store, job } = await hostOwnedFencedQueuedRunnerJob(fixture, workspace, { agent: 'fence-gap-delegate', epoch: EPOCH, lease: '4'.repeat(64) });
  const lifecycle = createHostLifecycleStore({ dataRoot: fixture.dataRoot });
  await lifecycle.publishSessionEnd({
    sessionId: 'owner', sessionStartedAt: '2026-01-01T00:00:00.000Z', endedAt: new Date().toISOString(),
    origin: 'session-end-hook', workspaceHints: [workspace],
  }, { signal: AbortSignal.timeout(250) });
  const { delegateEndedStopIntent, scavengeWritableJobs } = await import('../scripts/lib/recovery.mjs');
  const delegated = await delegateEndedStopIntent({ store, dataRoot: fixture.dataRoot, workspace, ownerSessionId: 'owner', epoch: EPOCH }, job.id);
  assert.equal(delegated.status, 'queued', 'the fenced reservation lease counts as claimed: delegation retains the record queued');
  assert.equal(delegated.workerLeaseId, undefined, 'the pre-claim fence gap is retained exactly');
  assert.equal(delegated.stopIntent?.cause, 'session-end', 'the session-end decision persists against the reservation lease');
  // The later lease-aware settlement (which compares the same effective lease) applies the
  // durable decision once the fence lease is proven free.
  await scavengeWritableJobs({ store, dataRoot: fixture.dataRoot, workspace, ...fencedNoRemote });
  const settled = await store.readJob(workspace, job.id);
  assert.equal(settled.status, 'cancelled', 'the fenced runner converges on the persisted decision');
  assert.equal(settled.stopCause, 'session-end');
  await cleanupRecoveryFixture(fixture);
});

test('SessionEnd settlement persists the stop intent for a fenced queued runner holding its live fence lease', async () => {
  const fixture = await context(); const workspace = await realpath(fixture.workspace);
  const { hostLifecycleEpoch } = await import('../scripts/lib/host-lifecycle.mjs');
  const EPOCH = hostLifecycleEpoch('owner', '2026-01-01T00:00:00.000Z');
  const { store, job, workerLeaseId } = await hostOwnedFencedQueuedRunnerJob(fixture, workspace, { agent: 'fence-gap-settle', epoch: EPOCH, lease: '5'.repeat(64) });
  const { settleEndedRescueJob, scavengeWritableJobs, withWorkerLease } = await import('../scripts/lib/recovery.mjs');
  let releaseWorker; const workerReleased = new Promise((resolve) => { releaseWorker = resolve; });
  let fenceReached; const fenceHeld = new Promise((resolve) => { fenceReached = resolve; });
  const holder = withWorkerLease({ dataRoot: fixture.dataRoot, workspace, jobId: job.id, workerLeaseId },
    async () => { fenceReached(); await workerReleased; });
  await fenceHeld;
  try {
    await settleEndedRescueJob({ store, dataRoot: fixture.dataRoot, workspace, ownerSessionId: 'owner',
      epoch: EPOCH, lockTimeoutMs: 0, createClient: unavailableControlClient }, job.id);
  } finally { releaseWorker(); await holder; }
  const persisted = await store.readJob(workspace, job.id);
  assert.equal(persisted.status, 'queued', 'a live fence lease defers the settlement to its runner');
  assert.equal(persisted.stopIntent?.cause, 'session-end', 'the stop intent persists during the fence gap so the runner claim loses');
  await scavengeWritableJobs({ store, dataRoot: fixture.dataRoot, workspace, ...fencedNoRemote });
  const settled = await store.readJob(workspace, job.id);
  assert.equal(settled.status, 'cancelled', 'the freed fence lease converges the durable session-end decision');
  assert.equal(settled.stopCause, 'session-end');
  await cleanupRecoveryFixture(fixture);
});

test('scavenge defers a fenced queued runner to its live fence lease and settles only by the claimed rules', async () => {
  const fixture = await context(); const workspace = await realpath(fixture.workspace);
  const { hostLifecycleEpoch } = await import('../scripts/lib/host-lifecycle.mjs');
  const EPOCH = hostLifecycleEpoch('owner', '2026-01-01T00:00:00.000Z');
  const { store, job, workerLeaseId } = await hostOwnedFencedQueuedRunnerJob(fixture, workspace, { agent: 'fence-gap-scavenge', epoch: EPOCH, lease: '6'.repeat(64) });
  // A durable session-end decision already owns this record (a prior delegation pass persisted it).
  await store.transitionJob(workspace, job.id, ['queued'], 'queued',
    { stopIntent: { version: 1, cause: 'session-end', requestedAt: new Date().toISOString() } });
  let terminalizations = 0;
  const guardedStore = {
    ...store,
    finishQueuedJobAfterRecoveryLease: async (/** @type {any} */ ...args) => {
      terminalizations += 1; return store.finishQueuedJobAfterRecoveryLease(...args);
    },
  };
  const { scavengeWritableJobs, withWorkerLease } = await import('../scripts/lib/recovery.mjs');
  const now = Date.now();
  let releaseWorker; const workerReleased = new Promise((resolve) => { releaseWorker = resolve; });
  let fenceReached; const fenceHeld = new Promise((resolve) => { fenceReached = resolve; });
  const holder = withWorkerLease({ dataRoot: fixture.dataRoot, workspace, jobId: job.id, workerLeaseId },
    async () => { fenceReached(); await workerReleased; });
  await fenceHeld;
  await scavengeWritableJobs({ store: guardedStore, dataRoot: fixture.dataRoot, workspace,
    now: () => now + 10 * 60_000, ...fencedNoRemote });
  const deferred = await store.readJob(workspace, job.id);
  assert.equal(deferred.status, 'queued', 'a live fence lease is never a free or unclaimed lease');
  assert.equal(deferred.stopIntent?.cause, 'session-end', 'the durable decision is retained untouched while the runner holds the fence');
  assert.equal(terminalizations, 0, 'no unclaimed stop-intent or aging terminalization may run while the fence lease is live');
  releaseWorker(); await holder;
  await scavengeWritableJobs({ store, dataRoot: fixture.dataRoot, workspace,
    now: () => now + 10 * 60_000, ...fencedNoRemote });
  const settled = await store.readJob(workspace, job.id);
  assert.equal(settled.status, 'cancelled', 'the freed fence lease settles per the claimed rules on the durable decision');
  assert.equal(settled.stopCause, 'session-end');
  // A fenced runner whose fence lease is proven free with no durable decision fails by the
  // CLAIMED pre-start rule, never the unclaimed claim-grace rule.
  const freedNoIntent = await hostOwnedFencedQueuedRunnerJob(fixture, workspace, { agent: 'fence-gap-freed', epoch: EPOCH, lease: '7'.repeat(64) });
  await scavengeWritableJobs({ store, dataRoot: fixture.dataRoot, workspace,
    now: () => now + 10 * 60_000, ...fencedNoRemote });
  const failed = await store.readJob(workspace, freedNoIntent.job.id);
  assert.equal(failed.status, 'failed', 'the proven-free fence lease permits the claimed pre-start failure');
  assert.equal(failed.error?.message, 'Claimed queued worker exited before execution started.',
    'the claimed classification, not the unclaimed grace policy, labels the failure');
  await cleanupRecoveryFixture(fixture);
});

// ---------------------------------------------------------------------------
// Task 7: reconciler-owned local runner termination at authorized stop
// boundaries. The Reconciler drives the seam (joined-state order tests live in
// tests/rescue-lifecycle.test.mjs); these tests pin the production adapter
// wiring: marker + exact owner/epoch/job/claim revalidation, two nonblocking
// held-lease probes, the PID-reuse guard (a free lease is never signaled), the
// terminal-obligation duty, the durable-cancelling-evidence retry, every
// remote-control exit (failed stop, missing broker, natural winner, missing
// boundary, remote abort), and the receipt/admission rules around them.
// ---------------------------------------------------------------------------

/** One MARKED detached-runner Host-owned Rescue in an exact durable state. With
 * `detachedHolder` the claim records a REAL detached lease-holding child as the
 * executor pid (the process-tree termination qualification). */
async function markedRunnerRescue(fixture, options = {}) {
  const { status = 'running', epoch = '9'.repeat(64), placement = 'background', childPid = 999_999_999,
    workerLeaseId = 'e'.repeat(64), session = 'zs-marked', inputId = 'input-marked', boundary = true,
    stopIntentCause = null, agent = 'marked-child', workspace: workspaceArg, detachedHolder = false,
    // A production rescue runner always runs its turn through a broker whose
    // identity the workspace records, so the sweep's three-valued lookup
    // RESOLVES by default. Opt out for tests whose premise is the unproven
    // (absent) lookup.
    brokerIdentity = true } = options;
  const store = createStateStore({ dataRoot: fixture.dataRoot });
  const workspace = workspaceArg ?? await realpath(fixture.workspace);
  if (brokerIdentity) await recordBrokerIdentity(fixture.dataRoot, workspace);
  const reserved = await store.reserveFreshRescueJob({ workspace,
    reservation: { workspace, ownerSessionId: 'owner', ownerTurnId: `turn-${agent}`, command: 'rescue', readOnly: false,
      permissionSnapshot: { permissionMode: 'workspace-write' } },
    executor: { parentSessionId: 'owner', parentTurnId: `turn-${agent}`, agentId: agent, agentType: 'zcode-rescue',
      agentPath: '/root/zcode_rescue_task', workspace, parentPermissionMode: 'workspace-write' },
    lifecycle: { ownerLifecycleEpoch: epoch, executionOwner: 'host-child', hostPlacement: placement },
    executionInput: { version: 1, task: 'bounded private task' } });
  const jobId = reserved.job.id;
  let holderChild = null;
  if (detachedHolder) {
    holderChild = spawnDetachedLeaseHolder(fixture.dataRoot, workspace, jobId, workerLeaseId);
    await new Promise((resolve) => holderChild.once('spawn', resolve));
    if (!await waitForHeldLease({ ...fixture, workspace }, jobId, workerLeaseId)) {
      try { process.kill(-holderChild.pid, 'SIGKILL'); } catch { /* gone */ }
      throw new Error('the detached holder never acquired its lease');
    }
  }
  const claimPid = detachedHolder ? holderChild.pid : childPid;
  if (childPid !== false) await store.claimJobWorkerForExecution(workspace, jobId, { childPid: claimPid, workerLeaseId });
  let job = await store.readJob(workspace, jobId);
  if (status === 'queued') {
    if (stopIntentCause) {
      await store.transitionJob(workspace, jobId, ['queued'], 'queued',
        { stopIntent: { version: 1, cause: stopIntentCause, requestedAt: new Date().toISOString() } });
      job = await store.readJob(workspace, jobId);
    }
    return { store, workspace, job, workerLeaseId, holderChild };
  }
  await store.transitionJob(workspace, jobId, ['queued'], 'running', {
    startedAt: new Date().toISOString(), zcodeSessionId: session, childPid: claimPid, workerLeaseId });
  if (boundary) await store.transitionJob(workspace, jobId, ['running'], 'running', { inputId, startRevision: 1, beforeMessageIds: [] });
  if (status === 'cancelling') {
    const current = await store.readJob(workspace, jobId);
    const { hostOwnedStopIntentPatch } = await import('../scripts/lib/rescue-binding.mjs');
    await store.transitionJob(workspace, jobId, ['running'], 'cancelling',
      stopIntentCause ? hostOwnedStopIntentPatch(current, stopIntentCause) : {});
    job = await store.readJob(workspace, jobId);
  }
  if (status === 'succeeded' || status === 'failed' || status === 'cancelled') {
    job = await store.finishJob(workspace, jobId, ['running'], status,
      status === 'succeeded' ? { resultArtifact: `results/${jobId}.md`, exitCode: 0 } : status === 'failed' ? { error: { message: 'boom' }, exitCode: 1 } : { exitCode: null });
  }
  return { store, workspace, job, workerLeaseId, holderChild };
}

/** Hold one exact worker lease inside this process until `release()` resolves. */
async function inProcessLeaseHolder(fixture, jobId, workerLeaseId) {
  const { withWorkerLease } = await import('../scripts/lib/recovery.mjs');
  let entered = () => {}; const acquired = new Promise((resolve) => { entered = resolve; });
  let release = () => {}; const released = new Promise((resolve) => { release = resolve; });
  const holder = withWorkerLease({ dataRoot: fixture.dataRoot, workspace: fixture.workspace, jobId, workerLeaseId },
    async () => { entered(); await released; });
  holder.catch(() => {});
  return { acquired, release, done: holder };
}

/** A real detached, self-grouped child that holds the lease for its lifetime.
 * The referenced interval keeps the child's event loop alive while the lease
 * operation is pending (an idle drained loop would end the -e child). */
function spawnDetachedLeaseHolder(dataRoot, workspace, jobId, workerLeaseId) {
  const moduleUrl = new URL('../scripts/lib/recovery.mjs', import.meta.url).href;
  const code = `const { withWorkerLease } = await import(${JSON.stringify(moduleUrl)});`
    + ` setInterval(() => {}, 1 << 30);`
    + ` await withWorkerLease({ dataRoot: ${JSON.stringify(dataRoot)}, workspace: ${JSON.stringify(workspace)},`
    + ` jobId: ${JSON.stringify(jobId)}, workerLeaseId: ${JSON.stringify(workerLeaseId)} }, () => new Promise(() => {}));`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { detached: true, stdio: 'ignore' });
  child.unref();
  return child;
}

async function leaseIsHeld(fixture, jobId, workerLeaseId) {
  const { withWorkerLease } = await import('../scripts/lib/recovery.mjs');
  try {
    await withWorkerLease({ dataRoot: fixture.dataRoot, workspace: fixture.workspace, jobId, workerLeaseId, timeoutMs: 0 }, () => undefined);
    return false;
  } catch (error) {
    if (!(error instanceof PluginError && error.code === 'LOCK_TIMEOUT')) throw error;
    return true;
  }
}

async function waitForHeldLease(fixture, jobId, workerLeaseId, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await leaseIsHeld(fixture, jobId, workerLeaseId)) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

test('SessionEnd settles a claimed queued marked runner as intent -> kill -> acquire lease -> cancelled in one pass', async () => {
  const fixture = await context();
  const { store, workspace, job, workerLeaseId } = await markedRunnerRescue(fixture, { status: 'queued', agent: 'queued-converge' });
  const holder = await inProcessLeaseHolder({ ...fixture, workspace }, job.id, workerLeaseId);
  const events = [];
  const wrapped = {
    ...store,
    transitionJob: async (/** @type {any} */ ...args) => {
      const [, id, , next] = args;
      if (id === job.id && next === 'queued') events.push('persist-intent');
      return store.transitionJob(...args);
    },
    finishQueuedJobAfterRecoveryLease: async (/** @type {any} */ ...args) => {
      events.push('acquire-lease-cancel');
      return store.finishQueuedJobAfterRecoveryLease(...args);
    },
  };
  const { settleEndedRescueJob, endedObligationSettled } = await import('../scripts/lib/recovery.mjs');
  await holder.acquired;
  const outcome = await settleEndedRescueJob({ store: wrapped, dataRoot: fixture.dataRoot, workspace, ownerSessionId: 'owner',
    epoch: null, lockTimeoutMs: 0, includeSettlementEvidence: true,
    terminateProcessTree: async (/** @type {number} */ pid) => { events.push(`kill:${pid}`); holder.release(); },
    createClient: async () => { throw new Error('a queued reservation has no remote session to control'); } }, job.id);
  await holder.done;
  assert.deepEqual(events, ['persist-intent', `kill:${999_999_999}`, 'acquire-lease-cancel'],
    'the durable stop intent precedes the bounded local termination, which precedes the lease-acquiring cancelled publication');
  assert.equal(outcome.kind, 'confirmed-cancellation');
  assert.equal(outcome.job.status, 'cancelled');
  assert.equal(outcome.job.stopCause, 'session-end');
  assert.equal('rescueExecutionInput' in outcome.job, false, 'the queued terminal removes the private input');
  assert.equal(outcome.job.rescueRunnerVersion, 1, 'the marker persists through the terminal record');
  assert.equal(endedObligationSettled(outcome), true, 'the settled terminal discharges the receipt');
  await cleanupRecoveryFixture(fixture);
});

test('a proven-free lease never authorizes signaling the recorded runner pid', async () => {
  const fixture = await context();
  // A live unrelated process recorded as the runner pid while the lease is
  // FREE (the executor already exited and released): signaling it could kill an
  // unrelated process, so the PID-reuse guard must skip it.
  const bystander = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30_000)'], { stdio: 'ignore' });
  bystander.unref();
  try {
    const { store, workspace, job, workerLeaseId } = await markedRunnerRescue(fixture, { status: 'queued', childPid: bystander.pid, agent: 'free-lease' });
    const kills = [];
    const { settleEndedRescueJob } = await import('../scripts/lib/recovery.mjs');
    const outcome = await settleEndedRescueJob({ store, dataRoot: fixture.dataRoot, workspace, ownerSessionId: 'owner',
      epoch: null, lockTimeoutMs: 0, includeSettlementEvidence: true,
      terminateProcessTree: async (/** @type {number} */ pid) => { kills.push(pid); },
      createClient: async () => { throw new Error('unused'); } }, job.id);
    // An alive recorded pid under a FREE lease is the accepted residual reuse
    // risk: the dead-root proof fails, so the pass could not run the sweep and
    // the pass RETAINS the active record (the reconciler's unresolved-stop
    // projection) — and nothing was signaled.
    assert.equal(outcome.kind, 'retained-writable-guard', 'the alive-root residual is retained, never settled');
    assert.equal(outcome.job.status, 'queued');
    assert.deepEqual(kills, [], 'the lease was acquirable (free): the recorded pid is no longer proven to be the runner');
    assert.equal(processAlive(bystander.pid), true, 'the unrelated live pid was not signaled');
    assert.equal(await leaseIsHeld({ ...fixture, workspace }, job.id, workerLeaseId), false);
  } finally { try { bystander.kill('SIGKILL'); } catch { /* gone */ } }
  await cleanupRecoveryFixture(fixture);
});

test('an unmarked attached claim is never a detached process-group termination target', async () => {
  const fixture = await context();
  const store = createStateStore({ dataRoot: fixture.dataRoot });
  const workspace = await realpath(fixture.workspace);
  const legacy = await store.reserveJob({ workspace, ownerSessionId: 'owner', ownerTurnId: 'legacy-hold', command: 'rescue', readOnly: false, permissionSnapshot: { permissionMode: 'workspace-write' } });
  const claimed = await store.claimJobWorkerForExecution(workspace, legacy.id, { childPid: process.pid, workerLeaseId: 'c'.repeat(64) });
  const holder = await inProcessLeaseHolder({ ...fixture, workspace }, legacy.id, claimed.workerLeaseId);
  const kills = [];
  const { settleEndedRescueJob, endedObligationSettled } = await import('../scripts/lib/recovery.mjs');
  await holder.acquired;
  const outcome = await settleEndedRescueJob({ store, dataRoot: fixture.dataRoot, workspace, ownerSessionId: 'owner',
    epoch: null, lockTimeoutMs: 0, includeSettlementEvidence: true,
    terminateProcessTree: async (/** @type {number} */ pid) => { kills.push(pid); },
    createClient: async () => { throw new Error('unused'); } }, legacy.id);
  holder.release(); await holder.done;
  assert.deepEqual(kills, [], 'the historical attached background must never enter detached process-tree cleanup');
  assert.equal(outcome.job.status, 'queued', 'the unmarked claimant defers to its starting worker exactly as before Task 7');
  assert.equal(endedObligationSettled(outcome), false, 'a held queued stop keeps the receipt pending');
  await cleanupRecoveryFixture(fixture);
});

test('discovery surfaces a terminal marked runner still holding its lease and the terminal early return terminates it', async () => {
  const fixture = await context();
  const workspace = await realpath(fixture.workspace);
  const held = await markedRunnerRescue(fixture, { status: 'succeeded', agent: 'terminal-held', workspace, detachedHolder: true });
  const free = await markedRunnerRescue(fixture, { status: 'succeeded', agent: 'terminal-free', workspace, workerLeaseId: 'a'.repeat(64) });
  try {
    const { discoverSessionEndObligations, settleEndedRescueJob } = await import('../scripts/lib/recovery.mjs');
    const obligations = await discoverSessionEndObligations({ store: held.store, dataRoot: fixture.dataRoot,
      knownWorkspaces: [workspace], ownerSessionId: 'owner', epoch: null });
    assert.deepEqual(obligations.map((/** @type {any} */ o) => o.job.id), [held.job.id, free.job.id],
      'every terminal marked claim is a cleanup obligation; the lease only selects the kill mode');
    // The real default termination converges: the detached holder dies and its
    // lease releases inside the bounded local budget.
    const outcome = await settleEndedRescueJob({ store: held.store, dataRoot: fixture.dataRoot, workspace,
      ownerSessionId: 'owner', epoch: null, lockTimeoutMs: 0, includeSettlementEvidence: true,
      createClient: async () => { throw new Error('terminal records need no remote control'); } }, held.job.id);
    assert.equal(outcome.job.status, 'succeeded', 'the terminal winner is untouched');
    assert.equal(processAlive(held.holderChild.pid), false, 'the still-held marked runner lease drives the bounded process-tree termination');
    const stored = await held.store.readJob(workspace, held.job.id);
    assert.equal(stored.rescueRunnerVersion, 1, 'the marker persists for the cleanup selection until the executor releases it');
    void free;
  } finally { try { process.kill(-held.holderChild.pid, 'SIGKILL'); } catch { /* already terminated by the pass */ } }
  await cleanupRecoveryFixture(fixture);
});

test('durable cancelling evidence retries the local cleanup through owner recovery and never upgrades remote uncertainty', async () => {
  const fixture = await context();
  const workspace = await realpath(fixture.workspace);
  const { store, job, holderChild } = await markedRunnerRescue(fixture, { status: 'cancelling', stopIntentCause: 'session-end', agent: 'cancelling-retry', workspace, detachedHolder: true });
  try {
    const { reconcileOwnedJobs } = await import('../scripts/lib/recovery.mjs');
    await reconcileOwnedJobs({ store, dataRoot: fixture.dataRoot, workspace, ownerSessionId: 'owner',
      reconcileOwnership: async () => {},
      createClient: async () => { throw new PluginError('ZCODE_DISCONNECTED', 'no broker', { category: 'runtime', remedy: 'restart' }); } });
    assert.equal(processAlive(holderChild.pid), false, 'the durable cancelling stop intent re-arms the local runner cleanup');
    const stored = await store.readJob(workspace, job.id);
    assert.equal(stored.status, 'cancelling', 'process death is never remote terminal proof: local death never upgrades the guard to cancelled');
    assert.equal(stored.stopIntent?.cause, 'session-end', 'the durable decision stays the retry evidence');
  } finally { try { process.kill(-holderChild.pid, 'SIGKILL'); } catch { /* terminated */ } }
  await cleanupRecoveryFixture(fixture);
});

test('durable queued stop evidence retries the claimed-queued cleanup through scavenging to cancelled', async () => {
  const fixture = await context();
  const workspace = await realpath(fixture.workspace);
  const { store, job, holderChild } = await markedRunnerRescue(fixture, { status: 'queued', stopIntentCause: 'session-end', agent: 'queued-retry', workspace, detachedHolder: true });
  try {
    const { scavengeWritableJobs } = await import('../scripts/lib/recovery.mjs');
    await scavengeWritableJobs({ store, dataRoot: fixture.dataRoot, workspace,
      reconcileOwnership: async () => {},
      createClient: async () => { throw new Error('a queued record has no remote session'); } });
    assert.equal(processAlive(holderChild.pid), false, 'the claimed queued stop decision terminates the wedged runner');
    const stored = await store.readJob(workspace, job.id);
    assert.equal(stored.status, 'cancelled', 'queued stopIntent -> kill -> acquire lease -> cancelled at the recovery seam too');
    assert.equal(stored.stopCause, 'session-end', 'the durable intent labels the winner, not a stale infrastructure failure');
  } finally { try { process.kill(-holderChild.pid, 'SIGKILL'); } catch { /* terminated */ } }
  await cleanupRecoveryFixture(fixture);
});

test('terminateMarkedRunnerTree fails closed on every unproven identity and never signals', async () => {
  const fixture = await context();
  const { terminateMarkedRunnerTree } = await import('../scripts/lib/job-control.mjs');
  const { store, workspace, job } = await markedRunnerRescue(fixture, { status: 'running', agent: 'guards' });
  const kills = [];
  const terminate = async (/** @type {number} */ pid) => { kills.push(pid); };
  const base = { store, dataRoot: fixture.dataRoot, workspace, ownerSessionId: 'owner' };
  assert.deepEqual(await terminateMarkedRunnerTree(base, { ...job, rescueRunnerVersion: undefined }, terminate), { kind: 'unmarked' },
    'the marker is the FIRST gate: an unmarked record is never even lease-probed');
  assert.deepEqual(await terminateMarkedRunnerTree(base, { ...job, command: 'review' }, terminate), { kind: 'unmarked' });
  assert.deepEqual(await terminateMarkedRunnerTree(base, { ...job, childPid: undefined }, terminate), { kind: 'unproven' },
    'a marked claim without a proven executor PID (the fence gap) is never a termination target');
  assert.deepEqual(await terminateMarkedRunnerTree({ ...base, ownerSessionId: 'someone-else' }, job, terminate), { kind: 'not-proven' });
  assert.deepEqual(await terminateMarkedRunnerTree({ ...base, epoch: '1'.repeat(64) }, job, terminate), { kind: 'not-proven' },
    'the owner/epoch of the settled boundary must match the durable record');
  assert.deepEqual(await terminateMarkedRunnerTree(base, { ...job, workerLeaseId: '7'.repeat(64) }, terminate), { kind: 'not-proven' },
    'a stale claim selection never reaches the lease probe');
  assert.deepEqual(await terminateMarkedRunnerTree({ ...base, deadlineMs: Date.now() - 1 }, job, terminate), { kind: 'budget-expired' },
    'a spent absolute deadline retains the duty for the next bounded pass');
  const contended = { ...store, readJob: async () => { throw new PluginError('LOCK_TIMEOUT', 'state lock contended', { category: 'timeout', remedy: 'retry' }); } };
  assert.deepEqual(await terminateMarkedRunnerTree({ ...base, store: contended }, job, terminate), { kind: 'not-proven' },
    'a contended identity re-read fails closed without signaling');
  // Exact identity but a FREE lease: guarded termination probes twice and never
  // signals (the lease holder here is nothing — the job was claimed without a
  // live holder).
  assert.deepEqual(await terminateMarkedRunnerTree(base, job, terminate), { kind: 'settled' });
  assert.deepEqual(kills, [], 'no guarded branch above signaled a pid');
  await cleanupRecoveryFixture(fixture);
});

test('a failed remote stop still terminates the proven marked runner and retains the remote uncertainty', async () => {
  const fixture = await context();
  const { store, workspace, job, workerLeaseId } = await markedRunnerRescue(fixture, { agent: 'stop-fail' });
  const holder = await inProcessLeaseHolder({ ...fixture, workspace }, job.id, workerLeaseId);
  const events = [];
  const { settleEndedRescueJob, endedObligationSettled } = await import('../scripts/lib/recovery.mjs');
  await holder.acquired;
  const outcome = await settleEndedRescueJob({ store, dataRoot: fixture.dataRoot, workspace, ownerSessionId: 'owner',
    epoch: null, lockTimeoutMs: 0, includeSettlementEvidence: true,
    terminateProcessTree: async (/** @type {number} */ pid) => { events.push(`kill:${pid}`); },
    createClient: async () => ({
      readSession: async () => activeCurrentTurn('input-marked'),
      stopSession: async () => { events.push('stop'); throw new Error('stop refused'); },
      close: async () => {},
    }) }, job.id);
  holder.release(); await holder.done;
  assert.deepEqual(events, ['stop', `kill:${999_999_999}`], 'the local termination runs on the failed-stop remote exit, after the attempted stop');
  assert.equal(outcome.kind, 'retained-writable-guard');
  assert.equal(outcome.job.status, 'cancelling', 'remote uncertainty is retained, never claimed cancelled');
  assert.equal(outcome.job.stopIntent.cause, 'session-end');
  assert.equal(outcome.job.lastCancelError, 'stop refused', 'the durable cancelling evidence re-arms the next pass');
  assert.equal(endedObligationSettled(outcome), true, 'a cancelling job with the exact intent discharges the receipt — the cleanup already ran and the retry authority is durable');
  await cleanupRecoveryFixture(fixture);
});

test('the missing-broker exit terminates the marked runner and archives only once its lease is proven free', async () => {
  const fixture = await context();
  const workspace = await realpath(fixture.workspace);
  const { store, job, holderChild } = await markedRunnerRescue(fixture, { agent: 'no-broker', workspace, detachedHolder: true });
  try {
    const events = [];
    const wrapped = { ...store, finishJob: async (/** @type {any} */ ...args) => { events.push('archive'); return store.finishJob(...args); } };
    const { settleEndedRescueJob } = await import('../scripts/lib/recovery.mjs');
    const outcome = await settleEndedRescueJob({ store: wrapped, dataRoot: fixture.dataRoot, workspace, ownerSessionId: 'owner',
      epoch: null, lockTimeoutMs: 0, includeSettlementEvidence: true,
      createClient: async () => null }, job.id);
    assert.equal(processAlive(holderChild.pid), false, 'the unavailable remote-control exit terminates the proven runner tree');
    assert.equal(outcome.job.status, 'failed', 'archival only happened after the terminated executor freed its exact lease');
    assert.deepEqual(events, ['archive']);
    assert.equal(outcome.job.error.message, 'SessionEnd found no healthy existing ZCode broker identity; the orphan was archived.');
  } finally { try { process.kill(-holderChild.pid, 'SIGKILL'); } catch { /* terminated */ } }
  await cleanupRecoveryFixture(fixture);
});

test('a natural terminal winner publishes only behind the completed-clean sweep duty', async () => {
  const fixture = await context();
  const { store, workspace, job, workerLeaseId } = await markedRunnerRescue(fixture, { agent: 'natural-winner' });
  const holder = await inProcessLeaseHolder({ ...fixture, workspace }, job.id, workerLeaseId);
  const events = [];
  const wrapped = { ...store, finishJob: async (/** @type {any} */ ...args) => { events.push('publish-succeeded'); return store.finishJob(...args); } };
  const { settleEndedRescueJob } = await import('../scripts/lib/recovery.mjs');
  await holder.acquired;
  const outcome = await settleEndedRescueJob({ store: wrapped, dataRoot: fixture.dataRoot, workspace, ownerSessionId: 'owner',
    epoch: null, lockTimeoutMs: 0, includeSettlementEvidence: true,
    terminateProcessTree: async (/** @type {number} */ pid) => { events.push(`kill:${pid}`); holder.release(); await holder; },
    createClient: async () => ({
      readSession: async () => coherentCurrentTurn('input-marked', 'natural success won'),
      stopSession: async () => { events.push('stop'); },
      close: async () => {},
    }) }, job.id);
  holder.release(); await holder.done.catch(() => { /* already released */ });
  assert.equal(outcome.kind, 'durable-completion', 'the natural winner is authoritative over the stop');
  assert.equal(events.includes('stop'), false, 'a proven terminal never receives another stop');
  assert.deepEqual(events, [`kill:${999_999_999}`, 'publish-succeeded'],
    'the marked-runner cleanup duty (kill decision plus the completed-clean sweep) runs BEFORE the publication: a remote terminal winner never terminalizes over an unproven sweep');
  await cleanupRecoveryFixture(fixture);
});

test('a missing durable turn boundary retains the guard after terminating the proven runner', async () => {
  const fixture = await context();
  const { store, workspace, job, workerLeaseId } = await markedRunnerRescue(fixture, { agent: 'missing-boundary', boundary: false });
  const holder = await inProcessLeaseHolder({ ...fixture, workspace }, job.id, workerLeaseId);
  const kills = [];
  const { settleEndedRescueJob, endedObligationSettled } = await import('../scripts/lib/recovery.mjs');
  await holder.acquired;
  const outcome = await settleEndedRescueJob({ store, dataRoot: fixture.dataRoot, workspace, ownerSessionId: 'owner',
    epoch: null, lockTimeoutMs: 0, includeSettlementEvidence: true,
    terminateProcessTree: async (/** @type {number} */ pid) => { kills.push(pid); },
    createClient: async () => ({
      readSession: async () => activeCurrentTurn('input-missing'),
      stopSession: async () => {},
      close: async () => {},
    }) }, job.id);
  holder.release(); await holder.done;
  assert.deepEqual(kills, [999_999_999], 'the acknowledged-stop-without-boundary exit still performs the local termination');
  assert.equal(outcome.job.status, 'cancelling', 'an unattributable turn boundary is uncertainty: the guard is retained, never claimed cancelled');
  assert.equal(endedObligationSettled(outcome), true, 'cancelling + exact intent discharges the receipt while the durable intent owns the next reconcile');
  await cleanupRecoveryFixture(fixture);
});

test('an old-epoch receipt grants neither settlement nor termination authority over a resumed marked runner', async () => {
  const fixture = await context();
  const { hostLifecycleEpoch } = await import('../scripts/lib/host-lifecycle.mjs');
  const NEW = hostLifecycleEpoch('owner', '2026-05-05T00:00:00.000Z');
  const OLD = hostLifecycleEpoch('owner', '2026-01-01T00:00:00.000Z');
  const { store, workspace, job } = await markedRunnerRescue(fixture, { agent: 'resumed-same-session', epoch: NEW });
  const kills = [];
  const clients = [];
  const { settleEndedRescueJob, endedObligationSettled } = await import('../scripts/lib/recovery.mjs');
  const outcome = await settleEndedRescueJob({ store, dataRoot: fixture.dataRoot, workspace, ownerSessionId: 'owner',
    epoch: OLD, endedAt: '2026-02-01T00:00:00.000Z', lockTimeoutMs: 0, includeSettlementEvidence: true,
    terminateProcessTree: async (/** @type {number} */ pid) => { kills.push(pid); },
    createClient: async () => { clients.push(1); return { readSession: async () => activeCurrentTurn('input-marked'), stopSession: async () => {}, close: async () => {} }; } }, job.id);
  assert.equal(outcome.kind, 'epoch-not-owned', 'the same session ID across a resume keeps the new-epoch run out of the old receipt');
  assert.equal(clients.length, 0);
  assert.deepEqual(kills, [], 'an unowned obligation never reaches the termination guard');
  assert.equal(endedObligationSettled(outcome), false);
  assert.equal((await store.readJob(workspace, job.id)).status, 'running');
  await cleanupRecoveryFixture(fixture);
});

test('a spent remote signal after the durable decision keeps the independent local cleanup budget and ends in the retained guard', async () => {
  const fixture = await context();
  const { store, workspace, job, workerLeaseId } = await markedRunnerRescue(fixture, { status: 'queued', agent: 'remote-abort' });
  const holder = await inProcessLeaseHolder({ ...fixture, workspace }, job.id, workerLeaseId);
  const controller = new AbortController();
  const kills = [];
  const wrapped = {
    ...store,
    transitionJob: async (/** @type {any} */ ...args) => {
      const [, id, , next] = args;
      const persisted = await store.transitionJob(...args);
      // The remote-control budget dies right after the durable decision lands:
      // the queued stop decision is durable, so the local termination duty owns
      // its independent remaining budget (bounded by the absolute deadline,
      // NEVER by this expired signal).
      if (id === job.id && next === 'queued' && persisted.stopIntent) controller.abort(new Error('remote budget spent'));
      return persisted;
    },
  };
  const { settleEndedRescueJob, endedObligationSettled } = await import('../scripts/lib/recovery.mjs');
  await holder.acquired;
  await assert.rejects(settleEndedRescueJob({ store: wrapped, dataRoot: fixture.dataRoot, workspace, ownerSessionId: 'owner',
    epoch: null, lockTimeoutMs: 0, includeSettlementEvidence: true, signal: controller.signal,
    terminateProcessTree: async (/** @type {number} */ pid) => { kills.push(pid); },
    createClient: async () => { throw new Error('unused'); } }, job.id), /remote budget spent/);
  holder.release(); await holder.done;
  assert.deepEqual(kills, [999_999_999], 'the expired remote-control signal never gates the local kill');
  const stored = await store.readJob(workspace, job.id);
  assert.equal(stored.status, 'queued', 'the unresolved pass retains the durable queued stop decision for the next bounded pass');
  assert.equal(endedObligationSettled({ kind: null, job: stored }), false, 'a queued stop keeps the receipt pending until settled');
  await assert.rejects(store.reserveJob({ workspace, ownerSessionId: 'next', ownerTurnId: 'next-turn', command: 'rescue', readOnly: false,
    permissionSnapshot: { permissionMode: 'workspace-write' } }), { code: 'WRITABLE_JOB_EXISTS' },
    'the pending queued stop still blocks writable admission');
  await cleanupRecoveryFixture(fixture);
});

test('lock contention before and during the stop defers with the durable duty intact and never signals', async () => {
  const { withJobCancellationLock } = await import('../scripts/lib/job-control.mjs');
  const fixture = await context();
  const { store, workspace, job, workerLeaseId } = await markedRunnerRescue(fixture, { agent: 'contention' });
  const holder = await inProcessLeaseHolder({ ...fixture, workspace }, job.id, workerLeaseId);
  const { settleEndedRescueJob, endedObligationSettled } = await import('../scripts/lib/recovery.mjs');
  await holder.acquired;
  // (1) Contention BEFORE stop: the cancellation lock is held elsewhere — the
  // settlement never blocks waiting for it (zero-timeout acquisition) and defers
  // without remote work, signal, or a state change.
  let clients = 0; const kills = [];
  const held = await withJobCancellationLock({ dataRoot: fixture.dataRoot, workspace, jobId: job.id }, async () =>
    settleEndedRescueJob({ store, dataRoot: fixture.dataRoot, workspace, ownerSessionId: 'owner', epoch: null,
      lockTimeoutMs: 0, includeSettlementEvidence: true,
      terminateProcessTree: async (/** @type {number} */ pid) => { kills.push(pid); },
      createClient: async () => { clients += 1; throw new Error('unused'); } }, job.id));
  assert.equal(held.kind, 'retained-writable-guard', 'cancellation-lock contention defers the whole pass');
  assert.equal(clients, 0); assert.deepEqual(kills, [], 'no stop means no remote-exit cleanup yet');
  assert.equal((await store.readJob(workspace, job.id)).status, 'running');
  // (2) Contention DURING stop: the durable persist itself loses the state lock.
  // The settlement fails closed to the retained-writable-guard: nothing was
  // controlled remotely, nothing is signaled, and the caller keeps the
  // obligation pending (persist-before-control — no decision, no cleanup duty).
  const contended = {
    ...store,
    transitionJob: async (/** @type {any} */ ...args) => {
      if (args[3] === 'cancelling') throw new PluginError('LOCK_TIMEOUT', 'state lock contended during stop', { category: 'timeout', remedy: 'retry' });
      return store.transitionJob(...args);
    },
  };
  const during = await settleEndedRescueJob({ store: contended, dataRoot: fixture.dataRoot, workspace, ownerSessionId: 'owner',
    epoch: null, lockTimeoutMs: 0, includeSettlementEvidence: true,
    terminateProcessTree: async (/** @type {number} */ pid) => { kills.push(pid); },
    createClient: async () => ({ readSession: async () => activeCurrentTurn('input-marked'), stopSession: async () => {}, close: async () => {} }) }, job.id);
  assert.equal(during.kind, 'retained-writable-guard', 'a contended decision persist fails closed without any remote control');
  assert.deepEqual(kills, [], 'persist-before-control: contention before the decision authorizes no termination');
  assert.equal((await store.readJob(workspace, job.id)).status, 'running');
  assert.equal(endedObligationSettled(during), false, 'the undis-charged obligation keeps the receipt pending');
  // (3) Contention of the cleanup duty's identity re-read: the guarded helper
  // fails closed as non-termination, and the winner publication is GATED on
  // the duty — the pass retains the active record instead of publishing over
  // an unproven sweep. A second workspace: the (1)/(2) job is still the first
  // workspace's active writable guard, so the natural-success fixture
  // reserves its own.
  await mkdir(join(fixture.root, 'workspace-3'));
  const workspaceThree = await realpath(join(fixture.root, 'workspace-3'));
  const natural = await markedRunnerRescue(fixture, { agent: 'pre-publish-contention', workerLeaseId: 'd'.repeat(64), workspace: workspaceThree });
  let cleanupReads = 0;
  const postPublish = {
    ...natural.store,
    readJob: async (/** @type {any} */ ...args) => {
      const value = await natural.store.readJob(...args);
      // The cleanup seam is the only caller that reads the job with a bounded
      // integer timeoutMs on this path: contend exactly that re-read, once.
      if (Number.isSafeInteger(args[2]?.timeoutMs) && ++cleanupReads === 1) {
        throw new PluginError('LOCK_TIMEOUT', 'cleanup re-read contended', { category: 'timeout', remedy: 'retry' });
      }
      return value;
    },
  };
  const base = { store: postPublish, dataRoot: fixture.dataRoot,
    workspace: workspaceThree, ownerSessionId: 'owner', epoch: null, lockTimeoutMs: 0, includeSettlementEvidence: true,
    terminateProcessTree: async (/** @type {number} */ pid) => { kills.push(pid); },
    createClient: async () => ({ readSession: async () => coherentCurrentTurn('input-marked', 'done'), stopSession: async () => {}, close: async () => {} }) };
  const retained = await settleEndedRescueJob(base, natural.job.id);
  assert.equal(retained.kind, 'retained-writable-guard', 'a contended cleanup re-read retains the pass before any publication');
  // Persist-before-control made the durable guard `cancelling` (with its
  // session-end intent) BEFORE the gated cleanup ran; no terminal winner was
  // published over the unproven sweep.
  const retainedRecord = await natural.store.readJob(workspaceThree, natural.job.id);
  assert.equal(retainedRecord.status, 'cancelling', 'the winner publication never ran over the unproven sweep: the durable guard is retained');
  assert.equal(retainedRecord.stopIntent?.cause, 'session-end', 'the durable decision stays the retry authority');
  assert.equal(cleanupReads, 1, 'the cleanup duty did attempt its identity revalidation before publication');
  assert.deepEqual(kills, [], 'a failed cleanup re-read signals nothing; the durable record keeps re-arming the duty');
  // The retried pass proves the claim (free lease, clean sweep) and the SAME
  // pass publishes the natural winner.
  const winner = await settleEndedRescueJob({ ...base,
    sweepDeadRootDescendants: async () => ({ kind: 'clean' }) }, natural.job.id);
  assert.equal(winner.kind, 'durable-completion', 'the gated pass converges once the cleanup proves the sweep');
  holder.release(); await holder.done;
  await cleanupRecoveryFixture(fixture);
});

test('an unprovable lease state fails the terminal duty closed while discovery keeps surfacing the claim', { skip: process.platform === 'win32' ? 'Windows cannot express the unreadable-lock-file fault fixture.' : false }, async () => {
  const fixture = await context();
  const workspace = await realpath(fixture.workspace);
  const held = await markedRunnerRescue(fixture, { status: 'succeeded', agent: 'terminal-probe-fault', workspace, detachedHolder: true });
  try {
    const { discoverSessionEndObligations, settleEndedRescueJob, endedObligationSettled } = await import('../scripts/lib/recovery.mjs');
    const discovery = (/** @type {any} */ overrides = {}) => discoverSessionEndObligations({ store: held.store, dataRoot: fixture.dataRoot,
      knownWorkspaces: [workspace], ownerSessionId: 'owner', epoch: null, ...overrides });
    assert.deepEqual((await discovery()).map((/** @type {any} */ o) => o.job.id), [held.job.id], 'sanity: the held lease is a cleanup obligation');
    // Discovery never depends on the lease state at all: an unreadable advisory
    // lock file (I/O/permission corruption) cannot drop the obligation — the
    // claim stays surfaced and the SETTLEMENT fails closed instead.
    const advisory = join(await resolveWorkspaceStorage({ dataRoot: fixture.dataRoot, workspace }).then((/** @type {any} */ storage) => storage.directory),
      'worker-leases', `${held.job.id}-${held.workerLeaseId}.lock`, 'advisory.lock');
    await chmod(advisory, 0o000);
    assert.deepEqual((await discovery()).map((/** @type {any} */ o) => o.job.id), [held.job.id],
      'the terminal marked claim is an obligation regardless of the unprovable lease state');
    const base = { store: held.store, dataRoot: fixture.dataRoot, workspace,
      ownerSessionId: 'owner', epoch: null, lockTimeoutMs: 0, includeSettlementEvidence: true,
      sweepDeadRootDescendants: () => Promise.resolve({ kind: 'clean' }),
      createClient: async () => { throw new Error('terminal records need no remote control'); } };
    // The duty's own lease probe hits the same fault: an unprovable state is
    // never "released" — the cleanup stays pending and the runner survives.
    const pending = await settleEndedRescueJob(base, held.job.id);
    assert.equal(pending.kind, 'runner-cleanup-pending', 'an unprovable lease probe is uncertainty, never settlement');
    assert.equal(pending.cleanup, 'not-proven');
    assert.equal(processAlive(held.holderChild.pid), true, 'the runner was never signalled on an unproven identity');
    assert.equal(endedObligationSettled(pending), false, 'the receipt stays pending');
    // Once the fault clears while the runner still holds the lease, the next
    // pass re-arms the duty and the settlement converges with the real kill.
    await chmod(advisory, 0o600);
    const outcome = await settleEndedRescueJob(base, held.job.id);
    assert.equal(outcome.kind, 'durable-completion');
    assert.equal(outcome.job.status, 'succeeded', 'the terminal winner is untouched');
    assert.equal(endedObligationSettled(outcome), true, 'the kill plus the completed-clean sweep discharge the receipt');
    assert.equal(processAlive(held.holderChild.pid), false, 'the retried duty terminated the proven runner');
    // The freed lease does NOT drop the obligation: the sweep duty re-arms
    // until a pass proves the tree gone.
    const released = await discovery();
    assert.deepEqual(released.map((/** @type {any} */ o) => o.job.id), [held.job.id], 'the freed marked claim stays an obligation');
  } finally { try { process.kill(-held.holderChild.pid, 'SIGKILL'); } catch { /* terminated by the pass */ } }
  await cleanupRecoveryFixture(fixture);
});

test('a terminal marked-runner cleanup that fails or exhausts its deadline keeps the obligation pending until cleanup proves the release', async () => {
  const fixture = await context();
  const workspace = await realpath(fixture.workspace);
  const held = await markedRunnerRescue(fixture, { status: 'succeeded', agent: 'terminal-cleanup-pending', workspace, detachedHolder: true });
  try {
    const { discoverSessionEndObligations, settleEndedRescueJob, endedObligationSettled } = await import('../scripts/lib/recovery.mjs');
    const base = { store: held.store, dataRoot: fixture.dataRoot, workspace, ownerSessionId: 'owner', epoch: null,
      lockTimeoutMs: 0, includeSettlementEvidence: true,
      createClient: async () => { throw new Error('terminal records need no remote control'); } };
    assert.deepEqual((await discoverSessionEndObligations({ store: held.store, dataRoot: fixture.dataRoot,
      knownWorkspaces: [workspace], ownerSessionId: 'owner', epoch: null })).map((/** @type {any} */ o) => o.job.id), [held.job.id]);
    // (1) A failing kill is NOT settlement: the terminal early return keeps the
    // obligation pending, the receipt is not discharged, and the surviving
    // runner stays alive.
    const failed = await settleEndedRescueJob({ ...base, deadlineMs: Date.now() + 5_000,
      terminateProcessTree: async () => { throw new Error('kill failed'); } }, held.job.id);
    assert.equal(failed.kind, 'runner-cleanup-pending');
    assert.equal(failed.job.status, 'succeeded', 'the durable terminal winner is untouched');
    assert.equal(failed.job.workerLeaseId, held.workerLeaseId, 'no durable evidence is stripped while the duty is pending');
    assert.equal(endedObligationSettled(failed), false, 'the pending duty must not discharge the receipt');
    assert.equal(processAlive(held.holderChild.pid), true, 'the surviving runner stays alive');
    // The hook-shaped raw-record reread projection cannot discharge either: the
    // marked claim alone never proves the local cleanup converged.
    const stored = await held.store.readJob(workspace, held.job.id);
    assert.equal(endedObligationSettled({ kind: null, job: stored }), false, 'the raw projection keeps the receipt pending');
    // (2) A spent deadline is equally pending: the bounded pass never claims a
    // cleanup it did not finish.
    const expired = await settleEndedRescueJob({ ...base, deadlineMs: Date.now() - 1 }, held.job.id);
    assert.equal(expired.kind, 'runner-cleanup-pending');
    assert.equal(endedObligationSettled(expired), false);
    assert.equal(processAlive(held.holderChild.pid), true);
    // (3) The next bounded pass with a working kill converges and discharges.
    const settled = await settleEndedRescueJob(base, held.job.id);
    assert.equal(settled.kind, 'durable-completion');
    assert.equal(settled.job.status, 'succeeded');
    assert.equal(processAlive(held.holderChild.pid), false, 'the retried duty terminates the proven runner');
    assert.equal(endedObligationSettled(settled), true, 'the proven release discharges the receipt');
    assert.equal(await leaseIsHeld({ ...fixture, workspace }, held.job.id, held.workerLeaseId), false);
    // A plain terminal record without a marked claim settles exactly as before:
    // no held lease, no duty, no pending outcome — even with a failing kill.
    const plain = await held.store.reserveJob({ workspace, ownerSessionId: 'owner', ownerTurnId: 'plain-terminal', command: 'rescue', readOnly: false, permissionSnapshot: { permissionMode: 'workspace-write' } });
    await held.store.finishJob(workspace, plain.id, ['queued'], 'failed', { error: { message: 'plain terminal' }, exitCode: 1 });
    const plainOutcome = await settleEndedRescueJob({ ...base, terminateProcessTree: async () => { throw new Error('kill failed'); } }, plain.id);
    assert.equal(plainOutcome.kind, 'terminal');
    assert.equal(endedObligationSettled(plainOutcome), true, 'plain terminal records settle exactly as before Task 7');
  } finally { try { process.kill(-held.holderChild.pid, 'SIGKILL'); } catch { /* terminated by the pass */ } }
  await cleanupRecoveryFixture(fixture);
});

test('an INCOMPLETE verified kill keeps the terminal obligation pending even when the runner lease freed', async () => {
  const fixture = await context();
  const workspace = await realpath(fixture.workspace);
  const held = await markedRunnerRescue(fixture, { status: 'succeeded', agent: 'incomplete-free-lease', workspace });
  const holder = await inProcessLeaseHolder({ ...fixture, workspace }, held.job.id, held.workerLeaseId);
  try {
    const { settleEndedRescueJob, endedObligationSettled } = await import('../scripts/lib/recovery.mjs');
    const base = { store: held.store, dataRoot: fixture.dataRoot, workspace, ownerSessionId: 'owner', epoch: null,
      lockTimeoutMs: 0, includeSettlementEvidence: true, deadlineMs: Date.now() + 5_000,
      createClient: async () => { throw new Error('terminal records need no remote control'); } };
    // The Windows verified walk signalled the recorded runner FIRST (it dies and
    // its process-lifetime lease releases) and then spent its shared budget
    // before the descendant dispatch: the seam reports INCOMPLETE with the
    // surviving descendant pending. The freed runner lease proves the RUNNER
    // gone, never the tree, so the obligation must stay pending.
    const incomplete = await settleEndedRescueJob({ ...base,
      terminateProcessTree: async () => { holder.release(); return { completed: false, dispatched: 1, pending: [424_242] }; } }, held.job.id);
    assert.equal(incomplete.kind, 'runner-cleanup-pending',
      'a freed runner lease alone never proves the tree cleanup: the incomplete duty keeps the obligation pending');
    assert.equal(incomplete.cleanup, 'budget-expired', 'the incomplete verified sequence keeps the budget-expired duty convention');
    assert.equal(incomplete.job.status, 'succeeded', 'the durable terminal winner is untouched');
    assert.equal(incomplete.job.workerLeaseId, held.workerLeaseId, 'no durable evidence is stripped while the duty is pending');
    assert.equal(endedObligationSettled(incomplete), false, 'the receipt stays the durable compensation authority');
    // The pending duty re-arms: on the next bounded pass the runner's lease is
    // already released, the guarded duty reports the runner exited-and-released
    // (a COMPLETED duty outcome), and the proven release settles via the probe.
    const settled = await settleEndedRescueJob({ ...base,
      terminateProcessTree: async () => { throw new Error('a free lease is never signalled'); } }, held.job.id);
    assert.equal(settled.kind, 'durable-completion', 'a COMPLETED duty outcome settles via the probe');
    assert.equal(endedObligationSettled(settled), true, 'the proven release discharges the receipt');
  } finally { holder.release(); await holder.done.catch(() => { /* already released */ }); }
  await cleanupRecoveryFixture(fixture);
});

test('the pending duty re-run kills the surviving descendant: the stub walk rediscovers it via the retained PPID', async () => {
  const fixture = await context();
  const workspace = await realpath(fixture.workspace);
  const held = await markedRunnerRescue(fixture, { status: 'succeeded', agent: 'ppid-retention', workspace });
  const holder = await inProcessLeaseHolder({ ...fixture, workspace }, held.job.id, held.workerLeaseId);
  try {
    const { settleEndedRescueJob, endedObligationSettled } = await import('../scripts/lib/recovery.mjs');
    // A stub process table with Windows PPID retention: the descendant's
    // recorded parent stays the recorded runner pid even after the runner dies
    // (Win32_Process keeps the original PPID — no re-parenting).
    const tree = new Map([
      [999_999_999, { alive: true }],
      [424_242, { alive: true, ppid: 999_999_999 }],
    ]);
    const passes = [];
    /** The verified Windows walk simulation: the runner FIRST, then every live
     * PPID-descendant; the descendant dispatch fails once the budget is spent. */
    const walk = (/** @type {boolean} */ descendantDispatchFails) => async (/** @type {number} */ pid) => {
      assert.equal(pid, 999_999_999, 'the walk is rooted at the recorded runner pid');
      const targets = [pid, ...[...tree].filter(([, identity]) => identity.ppid === pid && identity.alive).map(([candidate]) => candidate)];
      /** @type {number[]} */
      const dispatched = [];
      for (const target of targets) {
        if (target !== pid && descendantDispatchFails) break;
        tree.get(target).alive = false;
        dispatched.push(target);
      }
      passes.push({ descendantDispatchFails, dispatched, descendantFound: targets.includes(424_242) });
      return dispatched.length === targets.length ? undefined : { completed: false, dispatched: dispatched.length, pending: targets.slice(dispatched.length) };
    };
    const base = () => ({ store: held.store, dataRoot: fixture.dataRoot, workspace, ownerSessionId: 'owner', epoch: null,
      lockTimeoutMs: 0, includeSettlementEvidence: true,
      // The pass deadline is PLATFORM-SPLIT: only the stubbed KILL is
      // instant — the same-pass descendant sweep and its broker-exclusion
      // lookup are REAL. On Windows they are actual process-table snapshots
      // behind a 1.5s lookup-skip reserve (see
      // WINDOWS_MIN_RUNNER_TERMINATION_BUDGET_MS), so a flat 600ms deadline
      // skips the sweep's lookup and the pass can never come back clean on a
      // real Windows host; the Windows budget is the duty's own convergence
      // fallback. Pass 1 stays pending through the stub's EXPLICIT incomplete
      // kill outcome regardless of the budget, and pass 2's completing walk
      // plus its real clean sweep settle inside it.
      deadlineMs: Date.now() + (process.platform === 'win32' ? WINDOWS_RUNNER_DUTY_FALLBACK_MS : 600),
      createClient: async () => { throw new Error('terminal records need no remote control'); } });
    // Pass 1: the runner dispatch lands but the descendant dispatch exhausts the
    // deadline; the terminated runner's lease is still HELD (not reaped yet), so
    // the obligation stays pending exactly as established.
    const pending = await settleEndedRescueJob({ ...base(), terminateProcessTree: walk(true) }, held.job.id);
    assert.equal(pending.kind, 'runner-cleanup-pending');
    assert.equal(endedObligationSettled(pending), false);
    assert.equal(tree.get(999_999_999).alive, false, 'the runner dispatch landed');
    assert.equal(tree.get(424_242).alive, true, 'the descendant survived the first pass');
    // Pass 2: the duty re-runs lookup+kill; the walk STILL finds the descendant
    // through the retained PPID, the completing dispatch kills it, the reaped
    // runner's lease releases, and only then does the proven release discharge.
    const completingWalk = walk(false);
    const settled = await settleEndedRescueJob({ ...base(), terminateProcessTree: async (/** @type {number} */ pid) => {
      const outcome = await completingWalk(pid);
      holder.release(); // the reaped runner's process-lifetime lease releases
      return outcome;
    } }, held.job.id);
    assert.equal(passes.length, 2, 'the duty re-ran lookup+kill on the second bounded pass');
    assert.equal(passes[1].descendantFound, true, 'the descendant walk still finds the survivor via the retained PPID');
    assert.deepEqual(passes[1].dispatched, [999_999_999, 424_242], 'the second pass kills the surviving descendant');
    assert.equal(tree.get(424_242).alive, false, 'the descendant did not survive the retry');
    assert.equal(settled.kind, 'durable-completion');
    assert.equal(endedObligationSettled(settled), true, 'the COMPLETED kill settles via the probe');
  } finally { holder.release(); await holder.done.catch(() => { /* already released */ }); }
  await cleanupRecoveryFixture(fixture);
});

/** Override the host platform for one Windows-branch sweep unit test; restored
 * on every outcome. The sweep's table walk stays platform-gated in production,
 * so the override is the only way to drive it on a macOS/Linux test host. It
 * must only span the process.mjs helper itself (pure liveness probes plus the
 * injectable seams), never the surrounding durable-state machinery. */
function withWindowsPlatformOverride(run) {
  const original = process.platform;
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  return Promise.resolve().then(run).finally(() => {
    Object.defineProperty(process, 'platform', { value: original, configurable: true });
  });
}

test('a released runner lease settles only after the dead-root descendant sweep proves the tree gone', async () => {
  const fixture = await context();
  const workspace = await realpath(fixture.workspace);
  const held = await markedRunnerRescue(fixture, { status: 'succeeded', agent: 'dead-root-sweep', workspace });
  try {
    const { settleEndedRescueJob, endedObligationSettled } = await import('../scripts/lib/recovery.mjs');
    const { sweepDeadRootDescendantTree } = await import('../scripts/lib/process.mjs');
    // A Windows-flavored survivor: the recorded runner (999_999_999, proven DEAD
    // by the sweep's own liveness probe) left a descendant alive — Win32_Process
    // retains the original PPID after the parent dies (no re-parenting), so the
    // walk still finds it under the dead root.
    let survivorAlive = true;
    const enumerations = [];
    const kills = [];
    const sweepSeam = (/** @type {number} */ pid, /** @type {any} */ options) => withWindowsPlatformOverride(() => sweepDeadRootDescendantTree(pid, {
      ...options,
      enumerateProcessTable: async (/** @type {number} */ timeoutMs) => {
        enumerations.push(timeoutMs);
        return survivorAlive ? new Map([[424_242, { ppid: pid, commandLine: 'C:\\Tools\\node.exe C:\\ws\\worker.mjs' }]]) : new Map();
      },
      runProcessKill: async (/** @type {string} */ command, /** @type {string[]} */ args) => {
        kills.push([...args]);
        if (args.includes('424242')) survivorAlive = false;
      },
    }));
    const base = { store: held.store, dataRoot: fixture.dataRoot, workspace, ownerSessionId: 'owner', epoch: null,
      lockTimeoutMs: 0, includeSettlementEvidence: true, deadlineMs: Date.now() + 5_000,
      sweepDeadRootDescendants: sweepSeam,
      createClient: async () => { throw new Error('terminal records need no remote control'); } };
    // Pass 1: the runner's lease is ALREADY free (the guarded duty reports the
    // released pid without signalling it), but the dead-root sweep finds the
    // surviving descendant, kills it, and keeps the obligation pending until a
    // pass proves nothing is left. (RED before the fix: the freed lease settled
    // the obligation outright without any walk.)
    const pending = await settleEndedRescueJob(base, held.job.id);
    assert.equal(pending.kind, 'runner-cleanup-pending',
      'a freed lease alone never proves the tree gone: the dead-root sweep must run before settlement');
    assert.equal(endedObligationSettled(pending), false, 'the surviving descendant keeps the receipt pending');
    assert.equal(pending.sweep, 'swept', 'the pending outcome names the sweep that killed verified survivors');
    assert.deepEqual(kills, [['/PID', '424242', '/F']], 'the sweep force-killed exactly the verified surviving descendant');
    assert.equal(survivorAlive, false, 'the descendant did not survive the sweep');
    assert.equal(enumerations.length, 2, 'the killing pass plans from one snapshot and revalidates against a second before any kill');
    // Pass 2: the sweep finds nothing left to kill and the proven release settles.
    const settled = await settleEndedRescueJob(base, held.job.id);
    assert.equal(settled.kind, 'durable-completion', 'a COMPLETED sweep that finds nothing settles via the probe');
    assert.equal(endedObligationSettled(settled), true, 'the proven release plus the clean sweep discharge the receipt');
    assert.equal(enumerations.length, 3, 'the settling pass planned one fresh snapshot and needed no revalidation');
  } finally { await cleanupRecoveryFixture(fixture); }
});

test('an alive recorded pid under a released lease keeps the obligation pending without any sweep walk', async () => {
  const fixture = await context();
  const workspace = await realpath(fixture.workspace);
  const resident = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30);'], { stdio: 'ignore', shell: false });
  try {
    assert.ok(Number.isSafeInteger(resident.pid) && resident.pid > 0, 'the stand-in recorded pid must be live');
    const held = await markedRunnerRescue(fixture, { status: 'succeeded', agent: 'alive-root-risk', workspace, childPid: resident.pid });
    const { settleEndedRescueJob, endedObligationSettled } = await import('../scripts/lib/recovery.mjs');
    const { sweepDeadRootDescendantTree } = await import('../scripts/lib/process.mjs');
    const enumerations = [];
    const outcome = await settleEndedRescueJob({
      store: held.store, dataRoot: fixture.dataRoot, workspace, ownerSessionId: 'owner', epoch: null,
      lockTimeoutMs: 0, includeSettlementEvidence: true, deadlineMs: Date.now() + 5_000,
      sweepDeadRootDescendants: (/** @type {number} */ pid, /** @type {any} */ options) => sweepDeadRootDescendantTree(pid, {
        ...options,
        enumerateProcessTable: async () => { enumerations.push(1); return new Map(); },
      }),
      createClient: async () => { throw new Error('terminal records need no remote control'); },
    }, held.job.id);
    // A live recorded pid under a FREE lease cannot be distinguished from a pid
    // reused by an unrelated live process (the accepted residual reuse risk):
    // the sweep never walks — and the settlement machinery never signals — such
    // a pid. Because the dead-root proof FAILED, the pass could not run the
    // sweep, so the obligation stays pending: settlement requires a completed
    // sweep, and an alive root is not one.
    assert.equal(outcome.kind, 'runner-cleanup-pending', 'the residual-reuse-risk case is pending, never settled unproven');
    assert.equal(outcome.sweep, 'root-alive', 'the pending outcome names the alive-root residual');
    assert.equal(endedObligationSettled(outcome), false);
    assert.deepEqual(enumerations, [], 'the sweep never enumerates below a live recorded pid');
  } finally {
    try { resident.kill('SIGKILL'); } catch { /* already gone */ }
    await cleanupRecoveryFixture(fixture);
  }
});

test('an incomplete kill on the cancelling recovery path retains the durable guard and the writable exclusion', async () => {
  const fixture = await context();
  const workspace = await realpath(fixture.workspace);
  const { store, job, workerLeaseId } = await markedRunnerRescue(fixture, { status: 'cancelling', stopIntentCause: 'session-end', agent: 'incomplete-guard', workspace });
  const holder = await inProcessLeaseHolder({ ...fixture, workspace }, job.id, workerLeaseId);
  try {
    const { reconcileOwnedJobs } = await import('../scripts/lib/recovery.mjs');
    await reconcileOwnedJobs({ store, dataRoot: fixture.dataRoot, workspace, ownerSessionId: 'owner',
      deadlineMs: Date.now() + 5_000,
      terminateProcessTree: async () => { holder.release(); return { completed: false, dispatched: 1, pending: [424_242] }; },
      reconcileOwnership: async () => {},
      createClient: async () => { throw new PluginError('ZCODE_DISCONNECTED', 'no broker', { category: 'runtime', remedy: 'restart' }); } });
    const stored = await store.readJob(workspace, job.id);
    assert.equal(stored.status, 'cancelling', 'an incomplete kill never upgrades the guard to cancelled');
    assert.equal(stored.stopIntent?.cause, 'session-end', 'the durable stop intent stays the retry authority');
    await assert.rejects(store.reserveJob({ workspace, ownerSessionId: 'next', ownerTurnId: 'next-turn', command: 'rescue', readOnly: false,
      permissionSnapshot: { permissionMode: 'workspace-write' } }), { code: 'WRITABLE_JOB_EXISTS' },
    'the writable exclusion stays pending while surviving descendants have no proven kill');
  } finally { holder.release(); await holder.done.catch(() => { /* already released */ }); }
  await cleanupRecoveryFixture(fixture);
});

/** Record one durable broker identity in the workspace so the sweep's
 * WINDOWS-path lookup RESOLVES (complete, signature-bearing identity set):
 * the recorded pid is dead, so the walk excludes nothing — only the resolved
 * STATUS matters to the duty. (The POSIX group sweep never consults the
 * lookup at all.) */
async function recordBrokerIdentity(dataRoot, workspace) {
  const { writeBrokerIdentity } = await import('../scripts/zcode-broker.mjs');
  const storage = await resolveWorkspaceStorage({ dataRoot, workspace });
  await writeBrokerIdentity(join(storage.directory, 'broker', 'identity.json'), {
    endpoint: 'recovery-sweep-fixture-endpoint', pid: 111_000_001,
    launch: { command: '/tools/node', args: ['broker.mjs', 'config.json'] },
  });
}

test('a terminal marked claim is an obligation regardless of lease state: the lease only selects the kill mode', async () => {
  const fixture = await context();
  const workspace = await realpath(fixture.workspace);
  const held = await markedRunnerRescue(fixture, { status: 'succeeded', agent: 'terminal-obligation-held', workspace, detachedHolder: true });
  const free = await markedRunnerRescue(fixture, { status: 'succeeded', agent: 'terminal-obligation-free', workspace, workerLeaseId: 'a'.repeat(64) });
  try {
    const { discoverSessionEndObligations } = await import('../scripts/lib/recovery.mjs');
    // RED before the fix: the released lease dropped the record from discovery,
    // so the receipt settled without ever re-arming the descendant sweep duty.
    const obligations = await discoverSessionEndObligations({ store: held.store, dataRoot: fixture.dataRoot,
      knownWorkspaces: [workspace], ownerSessionId: 'owner', epoch: null });
    assert.deepEqual(obligations.map((/** @type {any} */ o) => o.job.id), [held.job.id, free.job.id],
      'discovery never depends on the lease being held: a terminal marked claim is always an obligation');
  } finally { try { process.kill(-held.holderChild.pid, 'SIGKILL'); } catch { /* fixture teardown */ } }
  await cleanupRecoveryFixture(fixture);
});

test('the sweep exclusion rule splits by platform: a Windows absent lookup walks with the proven-empty set, only a failed lookup fails closed', async () => {
  const fixture = await context();
  const workspace = await realpath(fixture.workspace);
  const held = await markedRunnerRescue(fixture, { status: 'succeeded', agent: 'absent-lookup-sweep', workspace, workerLeaseId: 'a'.repeat(64), brokerIdentity: false });
  try {
    const { settleEndedRescueJob, endedObligationSettled } = await import('../scripts/lib/recovery.mjs');
    const sweepInvocations = [];
    const base = { store: held.store, dataRoot: fixture.dataRoot, workspace, ownerSessionId: 'owner', epoch: null,
      lockTimeoutMs: 0, includeSettlementEvidence: true, deadlineMs: Date.now() + 5_000, platform: 'win32',
      sweepDeadRootDescendants: (/** @type {number} */ pid, /** @type {any} */ options) => {
        sweepInvocations.push({ pid, options });
        return Promise.resolve({ kind: 'clean' });
      },
      createClient: async () => { throw new Error('terminal records need no remote control'); } };
    // The workspace records NO broker identity (the runner exited before
    // creating one, or the broker already retired): the absent lookup is the
    // PROVEN complete empty scan, so the Windows walk plans under the held
    // startup lock with the empty exclusion set instead of failing the duty
    // closed pending forever. RED before the split: no walk ever ran.
    const settled = await settleEndedRescueJob(base, held.job.id);
    assert.equal(settled.kind, 'durable-completion', 'the absent lookup still plans the lock-held empty-exclusion walk');
    assert.equal(endedObligationSettled(settled), true);
    assert.deepEqual(sweepInvocations.map((/** @type {any} */ call) => call.pid), [held.job.childPid],
      'the walk runs exactly once, rooted at the recorded pid');
    assert.deepEqual(sweepInvocations[0]?.options?.excludeBrokers, [],
      'the absent outcome forwards the PROVEN-EMPTY exclusion set, never the fail-closed state');
    // Once the workspace records a complete broker identity the Windows lookup
    // resolves (lock-held exclusions) and the walk runs under them.
    await recordBrokerIdentity(fixture.dataRoot, workspace);
    const resolvedJob = await markedRunnerRescue(fixture, { status: 'succeeded', agent: 'resolved-lookup-sweep', workspace, workerLeaseId: 'b'.repeat(64) });
    sweepInvocations.length = 0;
    const resolved = await settleEndedRescueJob({ ...base, store: resolvedJob.store }, resolvedJob.job.id);
    assert.equal(resolved.kind, 'durable-completion', 'a resolved lock-held lookup plans the sweep');
    assert.equal(endedObligationSettled(resolved), true);
    assert.deepEqual(sweepInvocations.map((/** @type {any} */ call) => call.pid), [resolvedJob.job.childPid],
      'the resolved walk runs exactly once, rooted at the recorded pid');
    assert.equal(sweepInvocations[0]?.options?.excludeBrokers?.[0]?.pid, 111_000_001,
      'the walk runs under the resolved identity-matched exclusions');
    // A FAILED (unreadable/corrupt) lookup stays fail closed: an unprovable
    // exclusion set must never silently become an empty one — the prior
    // round's rule, unchanged by the platform split.
    const storage = await resolveWorkspaceStorage({ dataRoot: fixture.dataRoot, workspace });
    await writeFile(join(storage.directory, 'broker', 'identity.json'), '{ not json', 'utf8');
    const corruptJob = await markedRunnerRescue(fixture, { status: 'succeeded', agent: 'failed-lookup-sweep', workspace, workerLeaseId: 'c'.repeat(64), brokerIdentity: false });
    sweepInvocations.length = 0;
    const pending = await settleEndedRescueJob({ ...base, store: corruptJob.store }, corruptJob.job.id);
    assert.equal(pending.kind, 'runner-cleanup-pending', 'a failed lookup never proves the tree gone');
    assert.equal(pending.sweep, 'incomplete', 'the pending outcome names the unproven broker scan');
    assert.deepEqual(sweepInvocations, [], 'the sweep never walks below an unproven exclusion state');
    assert.equal(endedObligationSettled(pending), false, 'the receipt stays the compensation authority');
  } finally { await cleanupRecoveryFixture(fixture); }
});

test('a released marked claim sweeps before the recovery convergence publishes the cancelled winner', async () => {
  const fixture = await context();
  const workspace = await realpath(fixture.workspace);
  // Claimed queued marked runner whose lease is already released (claimed
  // without a live holder): the durable stop decision re-arms the duty.
  const { store, job } = await markedRunnerRescue(fixture, { status: 'queued', stopIntentCause: 'session-end', agent: 'released-queued-sweep', workspace });
  try {
    const { scavengeWritableJobs } = await import('../scripts/lib/recovery.mjs');
    /** @type {string[]} */
    const sweepKinds = ['swept', 'clean'];
    const sweepInvocations = [];
    const base = { store, dataRoot: fixture.dataRoot, workspace, reconcileOwnership: async () => {},
      createClient: async () => { throw new Error('a queued record has no remote session'); } };
    // Pass 1: RED before the fix — the released lease reported the duty settled
    // without any walk and the record converged to cancelled in the same pass.
    const retained = await scavengeWritableJobs({ ...base, deadlineMs: Date.now() + 5_000,
      sweepDeadRootDescendants: (/** @type {number} */ pid) => { sweepInvocations.push(pid); return Promise.resolve({ kind: sweepKinds[0], killed: [424_242], pending: [] }); } });
    assert.equal(retained.at(-1)?.id, job.id);
    const storedAfterSwept = await store.readJob(workspace, job.id);
    assert.equal(storedAfterSwept.status, 'queued', 'a sweep that killed verified survivors never converges the record');
    assert.equal(storedAfterSwept.stopIntent?.cause, 'session-end', 'the durable decision stays the retry authority');
    assert.deepEqual(sweepInvocations, [job.childPid], 'the released-lease pass ran the dead-root sweep');
    await assert.rejects(store.reserveJob({ workspace, ownerSessionId: 'next', ownerTurnId: 'next-turn', command: 'rescue', readOnly: false,
      permissionSnapshot: { permissionMode: 'workspace-write' } }), { code: 'WRITABLE_JOB_EXISTS' },
    'the retained queued stop keeps the writable exclusion');
    // Pass 2: the sweep finds nothing left to kill and the SAME pass converges.
    const settled = await scavengeWritableJobs({ ...base, deadlineMs: Date.now() + 5_000,
      sweepDeadRootDescendants: () => Promise.resolve({ kind: 'clean' }) });
    assert.equal(settled.at(-1)?.id, job.id);
    const storedSettled = await store.readJob(workspace, job.id);
    assert.equal(storedSettled.status, 'cancelled', 'queued stopIntent -> released lease -> completed-clean sweep -> cancelled');
    assert.equal(storedSettled.stopCause, 'session-end', 'the durable intent labels the winner');
  } finally { await cleanupRecoveryFixture(fixture); }
});

test('a stop-settled pass retains the guard instead of publishing a terminal winner over an unproven sweep', async () => {
  const fixture = await context();
  const workspace = await realpath(fixture.workspace);
  const { store, workspace: _w, job, workerLeaseId } = await markedRunnerRescue(fixture, { agent: 'natural-gate' });
  void _w;
  const holder = await inProcessLeaseHolder({ ...fixture, workspace }, job.id, workerLeaseId);
  try {
    const { settleEndedRescueJob } = await import('../scripts/lib/recovery.mjs');
    /** @type {string[]} */
    const publications = [];
    const wrapped = { ...store, finishJob: async (/** @type {any} */ ...args) => { publications.push(args[3]); return store.finishJob(...args); } };
    const base = { store: wrapped, dataRoot: fixture.dataRoot, workspace, ownerSessionId: 'owner', epoch: null,
      lockTimeoutMs: 0, includeSettlementEvidence: true, deadlineMs: Date.now() + 5_000,
      createClient: async () => ({
        readSession: async () => coherentCurrentTurn('input-marked', 'natural success won'),
        stopSession: async () => {},
        close: async () => {},
      }) };
    // Pass 1: RED before the fix — the natural winner published `succeeded`
    // FIRST and discarded the incomplete duty outcome, terminalizing the marked
    // job with verified descendants still unproven.
    const retained = await settleEndedRescueJob({ ...base,
      terminateProcessTree: async () => { holder.release(); return { completed: false, dispatched: 1, pending: [424_242] }; } }, job.id);
    assert.equal(retained.kind, 'retained-writable-guard', 'an unproven sweep never publishes the terminal winner');
    assert.equal(retained.job.status, 'cancelling', 'the durable guard is retained for the next bounded pass');
    assert.deepEqual(publications, [], 'no terminal publication happened in the unproven pass');
    assert.equal(retained.job.stopIntent?.cause, 'session-end', 'the durable intent stays the retry authority');
    // Pass 2: the duty completes clean and the SAME pass publishes the winner.
    const settled = await settleEndedRescueJob({ ...base,
      sweepDeadRootDescendants: () => Promise.resolve({ kind: 'clean' }),
      terminateProcessTree: async () => {} }, job.id);
    assert.equal(settled.kind, 'durable-completion', 'the completed-clean sweep discharges the pass');
    assert.deepEqual(publications, ['succeeded'], 'the winner publishes only after the clean sweep');
  } finally { holder.release(); await holder.done.catch(() => { /* already released */ }); }
  await cleanupRecoveryFixture(fixture);
});

test('a terminal marked job settles only after a completed-clean sweep, regardless of lease state', async () => {
  const fixture = await context();
  const workspace = await realpath(fixture.workspace);
  // (a) HELD lease: the guarded kill runs in the pass, but the same-pass sweep
  // finds a verified survivor — the obligation stays pending.
  const heldPass = await markedRunnerRescue(fixture, { status: 'succeeded', agent: 'invariant-held', workspace, detachedHolder: true });
  try {
    const { settleEndedRescueJob, endedObligationSettled } = await import('../scripts/lib/recovery.mjs');
    const base = { store: heldPass.store, dataRoot: fixture.dataRoot, workspace, ownerSessionId: 'owner', epoch: null,
      lockTimeoutMs: 0, includeSettlementEvidence: true, deadlineMs: Date.now() + 5_000,
      createClient: async () => { throw new Error('terminal records need no remote control'); } };
    const swept = await settleEndedRescueJob({ ...base,
      sweepDeadRootDescendants: () => Promise.resolve({ kind: 'swept', killed: [424_242], pending: [] }) }, heldPass.job.id);
    assert.equal(swept.kind, 'runner-cleanup-pending', 'a kill whose sweep found survivors never settles');
    assert.equal(swept.sweep, 'swept');
    assert.equal(processAlive(heldPass.holderChild.pid), false, 'the kill did run in the same pass');
    assert.equal(endedObligationSettled(swept), false);
    const settled = await settleEndedRescueJob({ ...base,
      sweepDeadRootDescendants: () => Promise.resolve({ kind: 'clean' }) }, heldPass.job.id);
    assert.equal(settled.kind, 'durable-completion', 'the completed-clean sweep settles on a later pass');
    assert.equal(endedObligationSettled(settled), true);
    // (b) FREE lease: the dead-root sweep is the only evidence this pass ran.
    const freePass = await markedRunnerRescue(fixture, { status: 'failed', agent: 'invariant-free', workspace, workerLeaseId: 'b'.repeat(64) });
    const freeSwept = await settleEndedRescueJob({ ...base,
      sweepDeadRootDescendants: () => Promise.resolve({ kind: 'swept', killed: [424_243], pending: [] }) }, freePass.job.id);
    assert.equal(freeSwept.kind, 'runner-cleanup-pending', 'a freed lease settles only through the sweep too');
    const freeSettled = await settleEndedRescueJob({ ...base,
      sweepDeadRootDescendants: () => Promise.resolve({ kind: 'clean' }) }, freePass.job.id);
    assert.equal(freeSettled.kind, 'terminal', 'the free-lease pass settles through its completed-clean sweep');
    assert.equal(endedObligationSettled(freeSettled), true);
  } finally { try { process.kill(-heldPass.holderChild.pid, 'SIGKILL'); } catch { /* fixture teardown */ } }
  await cleanupRecoveryFixture(fixture);
});
