// @ts-nocheck
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { PluginError } from '../scripts/lib/errors.mjs';
import { ownerIdForSession } from '../scripts/lib/job-control.mjs';
import { reconcileOwnedJobs, settleEndedOwnerWritableJob, withWorkerLease } from '../scripts/lib/recovery.mjs';
import { executeJob } from '../scripts/lib/review.mjs';
import { createStateStore } from '../scripts/lib/state.mjs';
import { resolveWorkspaceStorage } from '../scripts/lib/workspace.mjs';

const cancelLockHolder = fileURLToPath(new URL('./fixtures/cancel-lock-holder.mjs', import.meta.url));

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'zcode-session-end-'));
  const workspace = join(root, 'workspace');
  const dataRoot = join(root, 'data');
  await mkdir(workspace);
  return { root, workspace, dataRoot, store: createStateStore({ dataRoot }) };
}

async function job(input, options = {}) {
  let value = await input.store.reserveJob({
    workspace: input.workspace,
    ownerSessionId: options.ownerSessionId ?? 'owner-a',
    ownerTurnId: options.ownerTurnId ?? Math.random().toString(16),
    command: options.command ?? 'rescue',
    readOnly: options.readOnly ?? false,
    permissionSnapshot: { permissionMode: 'workspace-write' },
  });
  if (options.claim !== false) {
    value = await input.store.claimJobWorker(input.workspace, value.id, {
      childPid: 999_999,
      workerLeaseId: options.workerLeaseId ?? 'd'.repeat(64),
    });
  }
  if (options.status === 'queued') return value;
  value = await input.store.transitionJob(input.workspace, value.id, ['queued'], 'running', {
    startedAt: new Date().toISOString(),
    ...(options.accepted === false ? {} : { zcodeSessionId: options.zcodeSessionId ?? 'remote-a' }),
  });
  if (options.boundary !== false) value = await input.store.transitionJob(input.workspace, value.id, ['running'], 'running', {
    inputId: 'input-a', startRevision: 7, beforeMessageIds: ['historical'],
  });
  if (options.status === 'cancelling') value = await input.store.transitionJob(input.workspace, value.id, ['running'], 'cancelling');
  return value;
}

function completed(text = 'session end completion') {
  return {
    projection: { status: 'completed' }, runtime: { stateRevision: 8 },
    messages: [{ info: { role: 'assistant', messageId: 'answer', parentMessageId: 'input-a' }, parts: [{ type: 'text', text }] }],
  };
}

function clientFor(value, options = {}) {
  let reads = 0;
  return {
    readSession: async (sessionId) => {
      assert.equal(sessionId, value.zcodeSessionId); reads += 1;
      if (options.readError) throw options.readError;
      return options.reads?.[reads - 1] ?? { projection: { status: 'running' }, runtime: { stateRevision: 8 }, messages: [] };
    },
    stopSession: async (sessionId) => {
      assert.equal(sessionId, value.zcodeSessionId); options.onStop?.();
      if (options.stopError) throw options.stopError;
    },
    close: async () => { options.onClose?.(); },
  };
}

function executorClient(text = 'executor result') {
  return {
    createSession: async () => ({ session: { sessionId: 'remote-a' }, settings: { model: { current: { providerId: 'p', modelId: 'm' }, available: [] } }, messages: [] }),
    setPermissionHandler: () => {}, subscribe: () => () => {},
    send: async () => ({ inputId: 'input-a', stateRevision: 7 }), waitForCompletion: async () => {},
    readSession: async () => ({ messages: [{ info: { role: 'assistant', messageId: 'executor-answer', parentMessageId: 'input-a' }, parts: [{ type: 'text', text }] }] }),
    close: async () => {},
  };
}

async function settle(input, createClient, ownerSessionId = 'owner-a') {
  return settleEndedOwnerWritableJob({
    store: input.store, dataRoot: input.dataRoot, workspace: input.workspace,
    ownerSessionId, lockTimeoutMs: 0, requestTimeoutMs: 250, createClient, signal: input.signal,
  });
}

test('SessionEnd cancels an unclaimed queued reservation and prevents a later claim', async () => {
  const input = await fixture(); const value = await job(input, { claim: false, status: 'queued' }); let clients = 0;
  await settle(input, async () => { clients += 1; throw new Error('queued jobs need no client'); });
  assert.equal((await input.store.readJob(input.workspace, value.id)).status, 'cancelled');
  assert.equal(clients, 0);
  await assert.rejects(input.store.claimJobWorker(input.workspace, value.id, { childPid: process.pid, workerLeaseId: 'a'.repeat(64) }), { code: 'WORKER_LEASE_CONFLICT' });
});

test('SessionEnd leaves a held claimed queued lease but cancels it after the lease is free', async () => {
  const input = await fixture(); const lease = 'e'.repeat(64); const value = await job(input, { status: 'queued', workerLeaseId: lease });
  await withWorkerLease({ dataRoot: input.dataRoot, workspace: input.workspace, jobId: value.id, workerLeaseId: lease }, () => settle(input, async () => { throw new Error('queued jobs need no client'); }));
  assert.equal((await input.store.readJob(input.workspace, value.id)).status, 'queued');
  await settle(input, async () => { throw new Error('queued jobs need no client'); });
  assert.equal((await input.store.readJob(input.workspace, value.id)).status, 'cancelled');
});

test('SessionEnd publishes a completed first read with an artifact and never stops', async () => {
  const input = await fixture(); const value = await job(input); let stops = 0; let derived;
  await settle(input, async (current, ownerId) => {
    assert.equal(current.id, value.id); assert.equal(current.ownerSessionId, 'owner-a'); derived = ownerId;
    return clientFor(current, { reads: [completed('already complete')], onStop: () => { stops += 1; } });
  });
  const stored = await input.store.readJob(input.workspace, value.id);
  assert.equal(derived, ownerIdForSession('owner-a')); assert.equal(stored.status, 'succeeded'); assert.equal(stops, 0);
  const storage = await resolveWorkspaceStorage({ dataRoot: input.dataRoot, workspace: input.workspace });
  assert.equal(await readFile(join(storage.directory, stored.resultArtifact), 'utf8'), 'already complete');
});

test('SessionEnd cancels an active turn only after acknowledged stop and noncompleted reread', async () => {
  const input = await fixture(); const value = await job(input); let stops = 0; let closes = 0;
  await settle(input, async (current) => clientFor(current, {
    reads: [{ projection: { status: 'running' }, runtime: { stateRevision: 8 }, messages: [] }, { projection: { status: 'paused' }, runtime: { stateRevision: 8 }, messages: [] }],
    onStop: () => { stops += 1; }, onClose: () => { closes += 1; },
  }));
  assert.equal((await input.store.readJob(input.workspace, value.id)).status, 'cancelled'); assert.equal(stops, 1); assert.equal(closes, 1);
});

test('SessionEnd preserves a completion that races an acknowledged stop', async () => {
  const input = await fixture(); const value = await job(input); let stops = 0;
  await settle(input, async (current) => clientFor(current, {
    reads: [{ projection: { status: 'waiting' }, runtime: { stateRevision: 8 }, messages: [] }, completed('race won')], onStop: () => { stops += 1; },
  }));
  const stored = await input.store.readJob(input.workspace, value.id); assert.equal(stored.status, 'succeeded'); assert.equal(stops, 1);
});

test('SessionEnd archives its writable job when the existing broker is unavailable', async () => {
  const input = await fixture(); const value = await job(input);
  await settle(input, async () => null);
  const stored = await input.store.readJob(input.workspace, value.id);
  assert.equal(stored.status, 'failed');
  assert.equal(stored.error.message, 'SessionEnd found no healthy existing ZCode broker identity; the orphan was archived.');
  assert.equal(stored.lastCancelError, undefined);
});

test('SessionEnd retains its writable job when existing client creation fails generically', async () => {
  const input = await fixture(); const value = await job(input);
  await settle(input, async () => { throw new Error('local owner store cannot be read'); });
  const stored = await input.store.readJob(input.workspace, value.id);
  assert.equal(stored.status, 'running');
  assert.match(stored.lastCancelError, /local owner store cannot be read/);
  assert.ok(Buffer.byteLength(stored.lastCancelError, 'utf8') <= 2_048);
});

test('SessionEnd propagates native and arbitrary abort reasons before archival', async () => {
  for (const [mode, returnsNull] of [['native', false], ['arbitrary', true]]) {
    const controller = new AbortController(); const input = { ...await fixture(), signal: controller.signal }; const value = await job(input);
    const reason = mode === 'native' ? undefined : Object.freeze({ source: 'arbitrary SessionEnd abort' });
    const settlement = settle(input, async () => {
      controller.abort(reason);
      if (returnsNull) return null;
      throw new PluginError('ZCODE_DISCONNECTED', 'disconnect raced SessionEnd abort', { category: 'runtime', remedy: 'restart' });
    });
    await assert.rejects(settlement, (error) => error === controller.signal.reason, mode);
    const stored = await input.store.readJob(input.workspace, value.id);
    assert.equal(stored.status, 'running', mode);
    assert.equal(stored.lastCancelError, undefined, mode);
  }
});

test('SessionEnd does not archive broker absence while the exact worker lease is held', async () => {
  const input = await fixture(); const lease = 'f'.repeat(64); const value = await job(input, { workerLeaseId: lease }); let clients = 0;
  await withWorkerLease({ dataRoot: input.dataRoot, workspace: input.workspace, jobId: value.id, workerLeaseId: lease }, () => settle(input, async () => { clients += 1; return null; }));
  const stored = await input.store.readJob(input.workspace, value.id);
  assert.equal(stored.status, 'running');
  assert.equal(stored.lastCancelError, undefined);
  assert.equal(clients, 1);
});

test('SessionEnd does not archive broker absence without an exact worker lease', async () => {
  const input = await fixture(); const value = await job(input, { claim: false });
  await settle(input, async () => null);
  const stored = await input.store.readJob(input.workspace, value.id);
  assert.equal(stored.status, 'running');
  assert.equal(stored.lastCancelError, 'SessionEnd found no healthy existing ZCode broker identity; the orphan was archived.');
});

test('SessionEnd can stop through a reachable broker while the exact worker lease is held', async () => {
  const input = await fixture(); const lease = 'a'.repeat(64); const value = await job(input, { workerLeaseId: lease }); let stops = 0;
  await withWorkerLease({ dataRoot: input.dataRoot, workspace: input.workspace, jobId: value.id, workerLeaseId: lease }, () => settle(input, async (current) => clientFor(current, {
    reads: [{ projection: { status: 'running' }, runtime: { stateRevision: 8 }, messages: [] }, { projection: { status: 'paused' }, runtime: { stateRevision: 8 }, messages: [] }],
    onStop: () => { stops += 1; },
  })));
  assert.equal((await input.store.readJob(input.workspace, value.id)).status, 'cancelled');
  assert.equal(stops, 1);
});

test('SessionEnd propagates an abort observed by every successful client operation', async () => {
  for (const phase of ['create', 'read', 'stop', 'reread']) {
    const controller = new AbortController(); const input = { ...await fixture(), signal: controller.signal }; const value = await job(input); const reason = Object.freeze({ phase });
    const abortAfter = (value) => { if (phase === value) controller.abort(reason); };
    let reads = 0;
    const settlement = settle(input, async (current) => {
      abortAfter('create');
      return {
        readSession: async (sessionId) => { assert.equal(sessionId, current.zcodeSessionId); reads += 1; abortAfter(reads === 1 ? 'read' : 'reread'); return { projection: { status: reads === 1 ? 'running' : 'paused' }, runtime: { stateRevision: 8 }, messages: [] }; },
        stopSession: async (sessionId) => { assert.equal(sessionId, current.zcodeSessionId); abortAfter('stop'); },
        close: async () => {},
      };
    });
    await assert.rejects(settlement, (error) => error === reason, phase);
    assert.equal((await input.store.readJob(input.workspace, value.id)).status, 'running', phase);
  }
});

test('SessionEnd archives its writable job when the existing protocol disconnects', async () => {
  for (const [code, expected] of [
    ['ZCODE_BROKER_PROTOCOL_UNAVAILABLE', 'The reachable ZCode broker reported no existing ZCode Protocol; the orphan was archived.'],
    ['ZCODE_DISCONNECTED', 'The established ZCode control channel disconnected during orphan recovery; the orphan was archived.'],
  ]) {
    const input = await fixture(); const value = await job(input, { ownerTurnId: code }); let closes = 0;
    await settle(input, async (current) => clientFor(current, {
      readError: new PluginError(code, 'endpoint=/secret.sock token=secret owner=secret session=secret', { category: 'runtime', remedy: 'restart' }),
      onClose: () => { closes += 1; },
    }));
    const stored = await input.store.readJob(input.workspace, value.id);
    assert.equal(stored.status, 'failed', code);
    assert.equal(stored.error.message, expected, code);
    assert.doesNotMatch(stored.error.message, /secret/, code);
    assert.equal(stored.lastCancelError, undefined);
    assert.equal(closes, 1);
  }
});

test('SessionEnd keeps jobs nonterminal when a reachable protocol read or stop is unacknowledged', async () => {
  for (const scenario of ['read-timeout', 'stop-failure']) {
    const input = await fixture(); const value = await job(input, { ownerTurnId: scenario }); let closes = 0;
    await settle(input, async (current) => clientFor(current, {
      ...(scenario === 'read-timeout' ? { readError: new PluginError('ZCODE_REQUEST_TIMEOUT', 'read timed out', { category: 'timeout', remedy: 'retry' }) } : {}),
      ...(scenario === 'stop-failure' ? { stopError: new Error('stop refused') } : {}), onClose: () => { closes += 1; },
    }));
    const stored = await input.store.readJob(input.workspace, value.id);
    assert.ok(['running', 'cancelling'].includes(stored.status), scenario);
    assert.ok(typeof stored.lastCancelError === 'string' && stored.lastCancelError.length > 0 && stored.lastCancelError.length <= 2_048, scenario);
    if (scenario === 'read-timeout') assert.match(stored.lastCancelError, /read timed out/i);
    if (scenario === 'stop-failure') assert.match(stored.lastCancelError, /stop refused/i);
    assert.equal(closes, 1);
  }
});

test('SessionEnd maintenance failure never overwrites a terminal executor race', async () => {
  const input = await fixture(); const value = await job(input); let raced = false;
  const wrapped = {
    ...input.store,
    transitionJob: async (workspace, jobId, expected, next, patch = {}) => {
      if (!raced && next === 'running' && patch.lastCancelError) {
        raced = true;
        await input.store.transitionJob(workspace, jobId, ['running'], 'failed', { error: { message: 'executor won maintenance failure race' }, finishedAt: new Date().toISOString(), exitCode: 1 });
      }
      return input.store.transitionJob(workspace, jobId, expected, next, patch);
    },
  };
  await settle({ ...input, store: wrapped }, async (current) => clientFor(current, { stopError: new Error('stop failed late') }));
  const stored = await input.store.readJob(input.workspace, value.id); assert.equal(stored.status, 'failed'); assert.equal(stored.error.message, 'executor won maintenance failure race'); assert.equal(stored.lastCancelError, undefined);
});

test('SessionEnd bounds multibyte maintenance failures by UTF-8 bytes without splitting emoji', async () => {
  const input = await fixture(); const value = await job(input); const failure = `停止失败🚫${'诊断🚧'.repeat(1_000)}`;
  await settle(input, async (current) => clientFor(current, { stopError: new Error(failure) }));
  const stored = await input.store.readJob(input.workspace, value.id);
  assert.match(stored.lastCancelError, /^停止失败🚫诊断🚧/); assert.ok(Buffer.byteLength(stored.lastCancelError, 'utf8') <= 2_048); assert.doesNotMatch(stored.lastCancelError, /\uFFFD/);
});

test('SessionEnd ignores foreign-owner and read-only jobs', async () => {
  const foreignInput = await fixture(); const foreign = await job(foreignInput, { ownerSessionId: 'owner-b' }); let clients = 0;
  await settle(foreignInput, async () => { clients += 1; throw new Error('must not inspect foreign job'); });
  assert.equal((await foreignInput.store.readJob(foreignInput.workspace, foreign.id)).status, 'running');

  const readOnlyInput = await fixture(); const readOnly = await job(readOnlyInput, { readOnly: true });
  await settle(readOnlyInput, async () => { clients += 1; throw new Error('must not inspect read-only job'); });
  assert.equal((await readOnlyInput.store.readJob(readOnlyInput.workspace, readOnly.id)).status, 'running'); assert.equal(clients, 0);
});

test('SessionEnd cancellation-lock contention returns immediately without remote work', async (t) => {
  const input = await fixture(); const value = await job(input); let clients = 0;
  const holder = spawn(process.execPath, [cancelLockHolder, input.dataRoot, input.workspace, value.id], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { try { holder.kill('SIGTERM'); } catch { /* exited */ } });
  await new Promise((resolve, reject) => { holder.stdout.once('data', resolve); holder.once('error', reject); holder.once('exit', (code) => reject(new Error(`lock holder exited ${code}`))); });
  const started = Date.now(); await settle(input, async () => { clients += 1; return null; });
  assert.ok(Date.now() - started < 250); assert.equal(clients, 0); assert.equal((await input.store.readJob(input.workspace, value.id)).status, 'running');
});

test('SessionEnd repairs a missing owner binding before deciding no writable guard exists', async () => {
  const input = await fixture(); const value = await job(input, { claim: false, status: 'queued' });
  const storage = await resolveWorkspaceStorage({ dataRoot: input.dataRoot, workspace: input.workspace }); const indexRoot = join(storage.directory, 'job-owners');
  const [ownerDirectory] = (await readdir(indexRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && /^[a-f0-9]{64}$/.test(entry.name));
  assert.ok(ownerDirectory); await rm(join(indexRoot, ownerDirectory.name, `${value.id}.json`));
  const settled = await settle(input, async () => { throw new Error('queued settlement must not create a client'); });
  assert.equal(settled.id, value.id); assert.equal(settled.status, 'cancelled');
  assert.equal((await input.store.readJob(input.workspace, value.id)).status, 'cancelled');
});

test('SessionEnd never overwrites a terminal executor race', async () => {
  const input = await fixture(); const value = await job(input); let raced = false;
  const wrapped = {
    ...input.store,
    transitionJob: async (workspace, jobId, expected, next, patch = {}) => {
      if (!raced && next === 'cancelling') {
        raced = true;
        await input.store.transitionJob(workspace, jobId, ['running'], 'failed', { error: { message: 'executor failed first' }, finishedAt: new Date().toISOString(), exitCode: 1 });
      }
      return input.store.transitionJob(workspace, jobId, expected, next, patch);
    },
  };
  await settle({ ...input, store: wrapped }, async (current) => clientFor(current, { reads: [{ projection: { status: 'running' }, runtime: { stateRevision: 8 }, messages: [] }, { projection: { status: 'paused' }, runtime: { stateRevision: 8 }, messages: [] }] }));
  const stored = await input.store.readJob(input.workspace, value.id); assert.equal(stored.status, 'failed'); assert.equal(stored.error.message, 'executor failed first');
});

test('executeJob holds the cancellation lock across result artifact publication', async () => {
  const input = await fixture(); const reservation = await job(input, { claim: false, status: 'queued' }); let observed;
  const output = await executeJob({
    job: reservation, workspace: input.workspace, dataRoot: input.dataRoot, store: input.store, client: executorClient(), task: 'finish',
    syncDirectory: async (directory) => {
      if (basename(directory) !== 'results') return;
      observed = await settle(input, async (current) => clientFor(current, { reads: [{ projection: { status: 'running' }, runtime: { stateRevision: 8 }, messages: [] }, { projection: { status: 'paused' }, runtime: { stateRevision: 8 }, messages: [] }] }));
    },
  });
  assert.equal(observed.status, 'running', 'nonblocking SessionEnd must lose while executor publishes under the cancellation lock'); assert.equal(output.job.status, 'succeeded');
});

test('executeJob respects a SessionEnd completion winner without rewriting its result artifact', async () => {
  const input = await fixture(); const reservation = await job(input, { claim: false, status: 'queued' });
  const output = await executeJob({
    job: reservation, workspace: input.workspace, dataRoot: input.dataRoot, store: input.store, client: executorClient('late executor result'), task: 'finish',
    onBoundaryPersisted: async (running) => {
      await settle(input, async (current) => clientFor(current, { reads: [{ ...completed('maintenance result'), messages: [{ info: { role: 'assistant', messageId: 'maintenance-answer', parentMessageId: running.inputId }, parts: [{ type: 'text', text: 'maintenance result' }] }] }] }));
    },
  });
  const stored = await input.store.readJob(input.workspace, reservation.id); const storage = await resolveWorkspaceStorage({ dataRoot: input.dataRoot, workspace: input.workspace });
  assert.equal(output.job.status, 'succeeded'); assert.equal(output.result, 'maintenance result'); assert.equal(stored.status, 'succeeded'); assert.equal(await readFile(join(storage.directory, stored.resultArtifact), 'utf8'), 'maintenance result');
});

test('executeJob does not write a result after SessionEnd cancellation wins', async () => {
  const input = await fixture(); const reservation = await job(input, { claim: false, status: 'queued' });
  await assert.rejects(executeJob({
    job: reservation, workspace: input.workspace, dataRoot: input.dataRoot, store: input.store, client: executorClient(), task: 'finish',
    onBoundaryPersisted: async () => settle(input, async (current) => clientFor(current, { reads: [{ projection: { status: 'running' }, runtime: { stateRevision: 8 }, messages: [] }, { projection: { status: 'paused' }, runtime: { stateRevision: 8 }, messages: [] }] })),
  }), { code: 'JOB_TERMINAL' });
  const stored = await input.store.readJob(input.workspace, reservation.id); const storage = await resolveWorkspaceStorage({ dataRoot: input.dataRoot, workspace: input.workspace });
  assert.equal(stored.status, 'cancelled'); await assert.rejects(readFile(join(storage.directory, 'results', `${reservation.id}.md`)), { code: 'ENOENT' });
});

test('late child success and progress cannot mutate a SessionEnd cancellation winner', async () => {
  const input = await fixture(); const reservation = await job(input, { claim: false, status: 'queued' }); let observe = () => {}; let cancelledWinner;
  const client = {
    ...executorClient('late child success'),
    subscribe: (handler) => { observe = handler; return () => {}; },
  };
  await assert.rejects(executeJob({
    job: reservation, workspace: input.workspace, dataRoot: input.dataRoot, store: input.store, client, task: 'finish late',
    onBoundaryPersisted: async () => {
      await settle(input, async (current) => clientFor(current, {
        reads: [{ projection: { status: 'running' }, runtime: { stateRevision: 8 }, messages: [] }, { projection: { status: 'paused' }, runtime: { stateRevision: 8 }, messages: [] }],
      }));
      cancelledWinner = await input.store.readJob(input.workspace, reservation.id);
      observe({ method: 'state.updated', params: { type: 'state.updated', scope: 'session', sessionId: 'remote-a', revision: 9, reason: 'tool_call_started', patch: {} } });
      observe({ method: 'state.updated', params: { type: 'state.updated', scope: 'session', sessionId: 'remote-a', revision: 10, reason: 'prompt_completed', patch: { status: 'idle' } } });
    },
  }), { code: 'JOB_TERMINAL' });
  const stored = await input.store.readJob(input.workspace, reservation.id); const storage = await resolveWorkspaceStorage({ dataRoot: input.dataRoot, workspace: input.workspace });
  assert.deepEqual(stored, cancelledWinner); assert.equal(stored.status, 'cancelled'); assert.equal(stored.resultArtifact, undefined);
  await assert.rejects(readFile(join(storage.directory, 'results', `${reservation.id}.md`)), { code: 'ENOENT' });
});

test('competing SessionEnd and orphan recovery elect exactly one terminal settlement', async () => {
  for (let iteration = 0; iteration < 8; iteration += 1) {
    const input = await fixture(); const value = await job(input); let stops = 0; let recoveryClients = 0; let announceStop = () => {}; let releaseStop = () => {}; let announceOrphanListed = () => {};
    const stopEntered = new Promise((resolve) => { announceStop = resolve; }); const stopGate = new Promise((resolve) => { releaseStop = resolve; });
    const orphanListed = new Promise((resolve) => { announceOrphanListed = resolve; });
    const ending = settle(input, async (current) => {
      let reads = 0;
      return {
        readSession: async (sessionId) => { assert.equal(sessionId, current.zcodeSessionId); reads += 1; return { projection: { status: reads === 1 ? 'running' : 'paused' }, runtime: { stateRevision: 8 }, messages: [] }; },
        stopSession: async (sessionId) => { assert.equal(sessionId, current.zcodeSessionId); stops += 1; announceStop(); await stopGate; },
        close: async () => {},
      };
    });
    await stopEntered;
    const competingStore = {
      ...input.store,
      listOwnedJobs: async (...args) => { const listed = await input.store.listOwnedJobs(...args); announceOrphanListed(); return listed; },
    };
    const orphan = reconcileOwnedJobs({
      store: competingStore, dataRoot: input.dataRoot, workspace: input.workspace, ownerSessionId: 'owner-a', reconcileOwnership: async () => {},
      createClient: async () => { recoveryClients += 1; throw new Error('orphan contender must observe the SessionEnd winner'); },
    });
    await orphanListed;
    releaseStop();
    const [ended, recovered] = await Promise.all([ending, orphan]);
    const stored = await input.store.readJob(input.workspace, value.id);
    assert.equal(stops, 1, `iteration ${iteration}`); assert.equal(recoveryClients, 0, `iteration ${iteration}`); assert.equal(ended.status, 'cancelled'); assert.equal(recovered[0].status, 'cancelled'); assert.deepEqual(stored, ended);
  }
});
