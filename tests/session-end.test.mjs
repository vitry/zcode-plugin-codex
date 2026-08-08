// @ts-nocheck
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { PluginError } from '../scripts/lib/errors.mjs';
import { ownerIdForSession } from '../scripts/lib/job-control.mjs';
import { settleEndedOwnerWritableJob, withWorkerLease } from '../scripts/lib/recovery.mjs';
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
    ownerSessionId, lockTimeoutMs: 0, requestTimeoutMs: 250, createClient,
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

test('SessionEnd keeps jobs nonterminal when the existing client, read, or stop is unavailable', async () => {
  for (const scenario of ['null-client', 'read-timeout', 'stop-failure']) {
    const input = await fixture(); const value = await job(input, { ownerTurnId: scenario }); let closes = 0;
    await settle(input, async (current) => scenario === 'null-client' ? null : clientFor(current, {
      ...(scenario === 'read-timeout' ? { readError: new PluginError('ZCODE_REQUEST_TIMEOUT', 'read timed out', { category: 'timeout', remedy: 'retry' }) } : {}),
      ...(scenario === 'stop-failure' ? { stopError: new Error('stop refused') } : {}), onClose: () => { closes += 1; },
    }));
    const stored = await input.store.readJob(input.workspace, value.id);
    assert.ok(['running', 'cancelling'].includes(stored.status), scenario);
    assert.ok(typeof stored.lastCancelError === 'string' && stored.lastCancelError.length > 0 && stored.lastCancelError.length <= 2_048, scenario);
    if (scenario === 'null-client') assert.match(stored.lastCancelError, /existing ZCode broker is unavailable/i);
    if (scenario === 'read-timeout') assert.match(stored.lastCancelError, /read timed out/i);
    if (scenario === 'stop-failure') assert.match(stored.lastCancelError, /stop refused/i);
    assert.equal(closes, scenario === 'null-client' ? 0 : 1);
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
      if (!directory.endsWith('/results')) return;
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
