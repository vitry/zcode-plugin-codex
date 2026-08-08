// @ts-nocheck
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { closeSync, constants, openSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { createIdentityStore } from '../scripts/lib/identity.mjs';
import { PluginError } from '../scripts/lib/errors.mjs';
import { atomicWriteJson } from '../scripts/lib/fs.mjs';
import { createJobController, ownerIdForSession } from '../scripts/lib/job-control.mjs';
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
  if (options.claim !== false) await store.claimJobWorker(fixture.workspace, job.id, { childPid: 999999, workerLeaseId });
  if (options.status === 'queued') return { job: await store.readJob(fixture.workspace, job.id), store, workerLeaseId };
  let running = await store.transitionJob(fixture.workspace, job.id, ['queued'], 'running', { startedAt: options.startedAt ?? new Date().toISOString(), ...(options.sessionId === false ? {} : { zcodeSessionId: options.sessionId ?? 'orphan-session' }) });
  if (options.boundary !== false) running = await store.transitionJob(fixture.workspace, job.id, ['running'], 'running', { inputId: 'accepted-input', startRevision: 7, beforeMessageIds: ['historical'] });
  if (options.status === 'cancelling') running = await store.transitionJob(fixture.workspace, job.id, ['running'], 'cancelling');
  return { job: running, store, workerLeaseId };
}

function recoveryClient(job, options = {}) {
  return {
    listSessions: async () => ({ sessions: options.missing ? [] : [{ sessionId: job.zcodeSessionId }] }),
    readSession: async () => options.snapshot ?? ({ projection: { status: 'running' }, runtime: { stateRevision: 8 }, messages: [] }),
    stopSession: async (sessionId) => { assert.equal(sessionId, job.zcodeSessionId); options.onStop?.(); if (options.stopError) throw options.stopError; },
    close: async () => { options.onClose?.(); },
  };
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
          readSession: async () => { reads += 1; abortAfter(reads === 1 ? 'read' : 'reread'); return { projection: { status: reads === 1 ? 'running' : 'paused' }, runtime: { stateRevision: 8 }, messages: [] }; },
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

test('workspace scavenging stops an active orphan and rereads completion before terminalizing', async () => {
  const fixture = await context(); const { job, store } = await orphanJob(fixture); let reads = 0; let stops = 0;
  const completed = { projection: { status: 'completed' }, runtime: { stateRevision: 8 }, messages: [{ info: { role: 'assistant', messageId: 'answer', parentMessageId: 'accepted-input' }, parts: [{ type: 'text', text: 'completion won the stop race' }] }] };
  const { scavengeWritableJobs } = await import('../scripts/lib/recovery.mjs');
  await scavengeWritableJobs({ store, dataRoot: fixture.dataRoot, workspace: fixture.workspace, reconcileOwnership: async () => {}, createClient: async () => ({
    listSessions: async () => ({ sessions: [{ sessionId: job.zcodeSessionId }] }),
    readSession: async () => { reads += 1; return reads === 1 ? { projection: { status: 'running' }, runtime: { stateRevision: 8 }, messages: [] } : completed; },
    stopSession: async () => { stops += 1; }, close: async () => {},
  }) });
  const recovered = await store.readJob(fixture.workspace, job.id);
  assert.equal(recovered.status, 'succeeded'); assert.equal(stops, 1); assert.equal(reads, 2); assert.ok(recovered.resultArtifact);
  const storage = await resolveWorkspaceStorage({ dataRoot: fixture.dataRoot, workspace: fixture.workspace });
  assert.equal(await readFile(join(storage.directory, recovered.resultArtifact), 'utf8'), 'completion won the stop race');
});

test('acknowledged stop cancels a cancelling orphan when post-stop completion has no valid result', async () => {
  const fixture = await context(); const { job, store } = await orphanJob(fixture, { status: 'cancelling' }); let reads = 0; let stops = 0;
  const { scavengeWritableJobs } = await import('../scripts/lib/recovery.mjs');
  await scavengeWritableJobs({ store, dataRoot: fixture.dataRoot, workspace: fixture.workspace, reconcileOwnership: async () => {}, createClient: async () => ({
    listSessions: async () => ({ sessions: [{ sessionId: job.zcodeSessionId }] }),
    readSession: async () => { reads += 1; return { projection: { status: reads === 1 ? 'running' : 'completed' }, runtime: { stateRevision: 8 }, messages: [] }; },
    stopSession: async () => { stops += 1; }, close: async () => {},
  }) });
  const recovered = await store.readJob(fixture.workspace, job.id);
  assert.equal(recovered.status, 'cancelled'); assert.equal(stops, 1); assert.equal(reads, 2); assert.equal(recovered.resultArtifact, undefined);
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
  for (const [status, stopAcknowledged, expected] of [['running', true, 'failed'], ['cancelling', true, 'cancelled'], ['cancelling', false, 'running']]) {
    const fixture = await context(); const { job, store } = await orphanJob(fixture, { status, turnId: `${status}-${stopAcknowledged}` }); let stops = 0;
    const { scavengeWritableJobs } = await import('../scripts/lib/recovery.mjs');
    await scavengeWritableJobs({ store, dataRoot: fixture.dataRoot, workspace: fixture.workspace, reconcileOwnership: async () => {}, createClient: async () => recoveryClient(job, {
      snapshot: { projection: { status: 'paused' }, runtime: { stateRevision: 8 }, messages: [] }, onStop: () => { stops += 1; }, ...(stopAcknowledged ? {} : { stopError: new Error('paused stop refused') }),
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
  const wrapped = { ...store, transitionJob: async (...args) => {
    if (!raced && args[3] === 'failed') {
      raced = true;
      await store.transitionJob(fixture.workspace, job.id, ['running'], 'succeeded', { resultArtifact: `results/${job.id}.md`, finishedAt: new Date().toISOString(), exitCode: 0 });
    }
    return store.transitionJob(...args);
  } };
  const { scavengeWritableJobs } = await import('../scripts/lib/recovery.mjs');
  await scavengeWritableJobs({ store: wrapped, dataRoot: fixture.dataRoot, workspace: fixture.workspace, reconcileOwnership: async () => {}, createClient: async () => recoveryClient(job, { snapshot: { projection: { status: 'paused' }, runtime: { stateRevision: 8 }, messages: [] } }) });
  assert.equal((await store.readJob(fixture.workspace, job.id)).status, 'succeeded');
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
  const storage = await resolveWorkspaceStorage({ dataRoot: fixture.dataRoot, workspace: fixture.workspace });
  const spec = JSON.parse(await readFile(join(storage.directory, 'job-specs', `${output.job.id}.json`), 'utf8'));
  const binding = { jobId: output.job.id, ownerSessionId: 'owner', workspace: fixture.workspace, operation: 'run-reserved-job', specDigest: spec.digest };
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

test('accepted-send crashes without a durable boundary stop remotely or retain the writable guard', async () => {
  for (const stopSucceeds of [true, false]) {
    const fixture = await context(); const { job, store } = await orphanJob(fixture, { boundary: false }); let stops = 0;
    const { reconcileOwnedJobs } = await import('../scripts/lib/recovery.mjs');
    await reconcileOwnedJobs({ store, dataRoot: fixture.dataRoot, workspace: fixture.workspace, ownerSessionId: 'owner', reconcileOwnership: async () => {}, createClient: async () => recoveryClient(job, { onStop: () => { stops += 1; }, ...(stopSucceeds ? {} : { stopError: new Error('stop refused') }) }) });
    const recovered = await store.readJob(fixture.workspace, job.id); assert.equal(stops, 1);
    assert.equal(recovered.status, stopSucceeds ? 'failed' : 'running');
    if (!stopSucceeds) {
      assert.match(recovered.lastCancelError, /stop refused/);
      await assert.rejects(store.reserveJob({ workspace: fixture.workspace, ownerSessionId: 'owner', ownerTurnId: 'later', command: 'rescue', readOnly: false, permissionSnapshot: { permissionMode: 'workspace-write' } }), { code: 'WRITABLE_JOB_EXISTS' });
    }
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
      ? { projection: { status: 'completed' }, runtime: { stateRevision: 8 }, messages: [{ info: { role: 'assistant', messageId: 'answer', parentMessageId: 'accepted-input' }, parts: [{ type: 'text', text: 'recovered answer' }] }] }
      : { projection: { status: mode === 'paused' ? 'paused' : 'running' }, runtime: { stateRevision: 8 }, messages: [] };
    const { reconcileOwnedJobs } = await import('../scripts/lib/recovery.mjs');
    await reconcileOwnedJobs({ store, dataRoot: fixture.dataRoot, workspace: fixture.workspace, ownerSessionId: 'owner', reconcileOwnership: async () => {}, createClient: async () => recoveryClient(job, { snapshot, onStop: () => { stops += 1; }, ...(mode === 'active-unacked' ? { stopError: new Error('retry stop') } : {}) }) });
    const recovered = await store.readJob(fixture.workspace, job.id);
    assert.equal(recovered.status, mode === 'completed' ? 'succeeded' : mode === 'active-unacked' ? 'running' : 'cancelled', mode);
    assert.equal(stops, mode === 'paused' || mode.startsWith('active') ? 1 : 0, mode);
    if (mode === 'active-unacked') assert.match(recovered.lastCancelError, /retry stop/);
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
  const reserved = await store.reserveJob({ workspace: fixture.workspace, ownerSessionId: 'owner', ownerTurnId: 'legacy-live', command: 'rescue', readOnly: false, permissionSnapshot: { permissionMode: 'workspace-write' } });
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
    return { listSessions: async () => ({ sessions: [{ sessionId: job.zcodeSessionId }] }), readSession: async () => ({ projection: { status: 'completed' }, runtime: { stateRevision: 2 }, messages: [{ info: { role: 'assistant', messageId: `assistant-${job.id}`, parentMessageId: job.inputId }, parts: [{ type: 'text', text: `recovered ${job.id}` }] }] }), close: async () => { closes += 1; } };
  } });
  assert.equal((await store.readJob(fixture.workspace, bad.id)).status, 'running');
  assert.equal((await store.readJob(fixture.workspace, good.id)).status, 'succeeded');
  assert.equal((await store.readJob(fixture.workspace, sibling.id)).status, 'running');
  assert.deepEqual(created.sort(), [bad.id, good.id].sort()); assert.equal(closes, 1);
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
  await reconcileOwnedJobs({ store: wrapped, dataRoot: fixture.dataRoot, workspace: fixture.workspace, ownerSessionId: 'owner', reconcileOwnership: async () => {}, createClient: async (job) => recoveryClient(job, { snapshot: { projection: { status: 'completed' }, runtime: { stateRevision: 2 }, messages: [{ info: { role: 'assistant', messageId: `answer-${job.id}`, parentMessageId: job.inputId }, parts: [{ type: 'text', text: 'later recovered' }] }] } }) });
  assert.equal((await store.readJob(fixture.workspace, jobs[0].id)).status, 'running');
  assert.equal((await store.readJob(fixture.workspace, jobs[1].id)).status, 'succeeded');
});

test('real CLI fd4 delivery failure revokes capability and releases the writable slot', async () => {
  const fixture = await context();
  const child = spawn(process.execPath, [companionCli, 'rescue', '--background', '--fresh', 'repair'], { cwd: fixture.workspace, env: fixture.env, stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'] });
  /** @type {import('node:stream').Writable} */ (child.stdio[3]).end(`${JSON.stringify({ callerContext: fixture.callerContext })}\n`);
  child.stdio[4].on('error', () => {});
  child.stdio[4].destroy();
  const code = await new Promise((resolve, reject) => { const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('companion delivery failure timed out')); }, 2_000); child.once('error', reject); child.once('exit', (value) => { clearTimeout(timer); resolve(value); }); });
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
  const job = await store.reserveJob({ workspace: fixture.workspace, ownerSessionId: 'owner', ownerTurnId: 'turn', command: 'rescue', readOnly: false, permissionSnapshot: { permissionMode: 'workspace-write' } });
  await store.transitionJob(fixture.workspace, job.id, ['queued'], 'running', { zcodeSessionId: 'session-z' }); await store.transitionJob(fixture.workspace, job.id, ['running'], 'cancelling');
  let stops = 0; const controller = createJobController({ store, dataRoot: fixture.dataRoot, stopSession: async (sessionId) => { assert.equal(sessionId, 'session-z'); stops += 1; } });
  assert.equal((await controller.cancel(fixture.workspace, job.id, 'owner')).status, 'cancelled'); assert.equal(stops, 1);
});

test('a second process takes over after a cancelling lock holder is SIGKILLed', async () => {
  const fixture = await context(); const store = createStateStore({ dataRoot: fixture.dataRoot });
  const job = await store.reserveJob({ workspace: fixture.workspace, ownerSessionId: 'owner', ownerTurnId: 'turn', command: 'rescue', readOnly: false, permissionSnapshot: { permissionMode: 'workspace-write' } });
  await store.transitionJob(fixture.workspace, job.id, ['queued'], 'running', { zcodeSessionId: 'session-z' });
  const child = spawn(process.execPath, [cancellingHolder, fixture.dataRoot, fixture.workspace, job.id], { stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); child.once('exit', (code) => reject(new Error(`holder exited early: ${code}`))); });
  child.kill('SIGKILL'); await new Promise((resolve) => child.once('exit', resolve));
  let stops = 0; const controller = createJobController({ store, dataRoot: fixture.dataRoot, stopSession: async () => { stops += 1; } });
  assert.equal((await controller.cancel(fixture.workspace, job.id, 'owner')).status, 'cancelled'); assert.equal(stops, 1);
});

test('a cross-process follower joins the leader failure without stopping again', async () => {
  const fixture = await context(); const store = createStateStore({ dataRoot: fixture.dataRoot });
  const job = await store.reserveJob({ workspace: fixture.workspace, ownerSessionId: 'owner', ownerTurnId: 'turn', command: 'rescue', readOnly: false, permissionSnapshot: { permissionMode: 'workspace-write' } });
  await store.transitionJob(fixture.workspace, job.id, ['queued'], 'running', { zcodeSessionId: 'session-z' });
  const leader = spawnCancelAttempt(['leader-failure-ipc', fixture.dataRoot, fixture.workspace, job.id]); await leader.message('stop-entered');
  const follower = spawnCancelAttempt(['follower-ipc', fixture.dataRoot, fixture.workspace, job.id]); await follower.message('follower-selected'); leader.child.send({ type: 'release' });
  const [leaderResult, followerResult] = await Promise.all([leader.result, follower.result]);
  assert.deepEqual(followerResult.error, leaderResult.error); assert.equal(leaderResult.error.code, 'JOB_CANCEL_FAILED'); assert.equal(followerResult.job.status, 'running'); assert.equal(followerResult.job.lastCancelError, 'refused');
});

test('a cross-process follower joins the leader success without stopping again', async () => {
  const fixture = await context(); const store = createStateStore({ dataRoot: fixture.dataRoot });
  const job = await store.reserveJob({ workspace: fixture.workspace, ownerSessionId: 'owner', ownerTurnId: 'turn', command: 'rescue', readOnly: false, permissionSnapshot: { permissionMode: 'workspace-write' } });
  await store.transitionJob(fixture.workspace, job.id, ['queued'], 'running', { zcodeSessionId: 'session-z' });
  const leader = spawnCancelAttempt(['leader-success-ipc', fixture.dataRoot, fixture.workspace, job.id]); await leader.message('stop-entered');
  const follower = spawnCancelAttempt(['follower-ipc', fixture.dataRoot, fixture.workspace, job.id]); await follower.message('follower-selected'); leader.child.send({ type: 'release' });
  const [leaderResult, followerResult] = await Promise.all([leader.result, follower.result]); assert.equal(leaderResult.job.status, 'cancelled'); assert.equal(followerResult.job.status, 'cancelled');
});

test('a follower takes leadership after a pre-transition lock holder crash', async () => {
  for (const initialStatus of ['queued', 'running']) {
    const fixture = await context(); const store = createStateStore({ dataRoot: fixture.dataRoot });
    const job = await store.reserveJob({ workspace: fixture.workspace, ownerSessionId: 'owner', ownerTurnId: 'turn', command: 'rescue', readOnly: false, permissionSnapshot: { permissionMode: 'workspace-write' } });
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
  const job = await store.reserveJob({ workspace: fixture.workspace, ownerSessionId: 'owner', ownerTurnId: 'turn', command: 'rescue', readOnly: false, permissionSnapshot: { permissionMode: 'workspace-write' } });
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
  const job = await store.reserveJob({ workspace: fixture.workspace, ownerSessionId: 'owner', ownerTurnId: 'turn', command: 'rescue', readOnly: false, permissionSnapshot: { permissionMode: 'workspace-write' } });
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
  const job = await store.reserveJob({ workspace: fixture.workspace, ownerSessionId: 'owner', ownerTurnId: 'turn', command: 'rescue', readOnly: false, permissionSnapshot: { permissionMode: 'workspace-write' } });
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
