import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { PluginError } from '../scripts/lib/errors.mjs';
import { createStateStore } from '../scripts/lib/state.mjs';
import { createJobController } from '../scripts/lib/job-control.mjs';
import { writeResultArtifact } from '../scripts/lib/review.mjs';
import * as transferModule from '../scripts/lib/transfer.mjs';
import { extractImportedHistory, executeTransfer, resolveTransferSource, TRANSFER_LIMITS } from '../scripts/lib/transfer.mjs';
import { resolveWorkspaceStorage } from '../scripts/lib/workspace.mjs';
import { withWorkerLease } from '../scripts/lib/recovery.mjs';

const source = 'codex-thread-1';
function thread(overrides = {}) {
  return { id: source, ephemeral: false, turns: [{ id: 'turn-secret', startedAt: 1_725_000_000, completedAt: 1_725_000_010, status: 'completed', items: [
    { type: 'userMessage', id: 'user-secret', content: [{ type: 'text', text: 'first' }, { type: 'image', url: 'ignored' }, { type: 'text', text: 'second' }] },
    { type: 'reasoning', id: 'reasoning-secret', summary: ['hidden thought'] },
    { type: 'commandExecution', command: 'cat secret' },
    { type: 'agentMessage', id: 'agent-secret', text: 'answer' },
  ] }], ...overrides };
}

test('resolves explicit source first and otherwise uses only validated caller sessionId', () => {
  assert.equal(resolveTransferSource({ source: 'explicit' }, { sessionId: 'current', transcript_path: '/unsafe' }), 'explicit');
  assert.equal(resolveTransferSource({}, { sessionId: 'current', transcript_path: '/unsafe' }), 'current');
  for (const caller of [{}, { sessionId: '' }, { sessionId: 'x'.repeat(TRANSFER_LIMITS.maxThreadIdBytes + 1) }]) assert.throws(() => resolveTransferSource({}, caller), { code: 'TRANSFER_SOURCE_INVALID' });
});

test('extracts ordered visible user and assistant text with turn timestamps only', () => {
  assert.deepEqual(extractImportedHistory(thread(), source), { messages: [
    { role: 'user', content: 'first\nsecond', timestamp: 1_725_000_000_000 },
    { role: 'assistant', content: 'answer', timestamp: 1_725_000_000_000 },
  ] });
  assert.doesNotMatch(JSON.stringify(extractImportedHistory(thread(), source)), /secret|hidden|commandExecution|turn-secret|user-secret|agent-secret/);
});

test('treats a null turn startedAt as an unavailable timestamp', () => {
  const history = extractImportedHistory(thread({ turns: [{ startedAt: null, items: [{ type: 'userMessage', content: [{ type: 'text', text: 'without time' }] }, { type: 'agentMessage', text: 'also without time' }] }] }), source);
  assert.deepEqual(history.messages, [{ role: 'user', content: 'without time' }, { role: 'assistant', content: 'also without time' }]);
});

test('requires the exact persisted source thread and rejects empty history', () => {
  for (const value of [null, {}, thread({ id: 'other' }), thread({ ephemeral: true }), thread({ ephemeral: undefined }), thread({ turns: [] }), thread({ turns: [{ items: [{ type: 'reasoning', text: 'private' }] }] })]) {
    assert.throws(() => extractImportedHistory(value, source), (/** @type {any} */ error) => ['CODEX_THREAD_INVALID', 'CODEX_THREAD_EPHEMERAL', 'TRANSFER_HISTORY_EMPTY'].includes(error.code));
  }
});

test('fails closed on recognized malformed items, unsafe objects and invalid timestamps', () => {
  const polluted = Object.create({ inherited: true }); Object.assign(polluted, thread());
  const variants = [polluted, thread({ turns: [{ startedAt: -1, items: [] }] }), thread({ turns: [{ startedAt: Math.floor(Number.MAX_SAFE_INTEGER / 1000) + 1, items: [] }] }), thread({ turns: [{ items: [{ type: 'userMessage', content: 'not-array' }] }] }), thread({ turns: [{ items: [{ type: 'agentMessage', text: 4 }] }] }), thread({ turns: [{ items: [{ type: 'userMessage', content: [{ type: 'text', text: 3 }] }] }] })];
  for (const value of variants) assert.throws(() => extractImportedHistory(value, source), { code: 'CODEX_THREAD_INVALID' });
});

test('enforces message count, message bytes and total history byte limits', () => {
  assert.throws(() => extractImportedHistory(thread({ turns: [{ items: [{ type: 'agentMessage', text: 'x'.repeat(TRANSFER_LIMITS.maxMessageBytes + 1) }] }] }), source), { code: 'TRANSFER_HISTORY_TOO_LARGE' });
  const tooMany = Array.from({ length: TRANSFER_LIMITS.maxMessages + 1 }, () => ({ type: 'agentMessage', text: 'x' }));
  assert.throws(() => extractImportedHistory(thread({ turns: [{ items: tooMany }] }), source), { code: 'TRANSFER_HISTORY_TOO_LARGE' });
  const chunk = 'x'.repeat(Math.floor(TRANSFER_LIMITS.maxTotalBytes / 2));
  assert.throws(() => extractImportedHistory(thread({ turns: [{ items: [{ type: 'agentMessage', text: chunk }, { type: 'agentMessage', text: chunk }, { type: 'agentMessage', text: 'xx' }] }] }), source), { code: 'TRANSFER_HISTORY_TOO_LARGE' });
  const escaped = '\0'.repeat(TRANSFER_LIMITS.maxMessageBytes);
  assert.throws(() => extractImportedHistory(thread({ turns: [{ items: [{ type: 'agentMessage', text: escaped }, { type: 'agentMessage', text: escaped }, { type: 'agentMessage', text: escaped }] }] }), source), { code: 'TRANSFER_HISTORY_TOO_LARGE' });
  assert.ok(transferModule.TRANSFER_WIRE_LIMITS.maxEncodedHistoryBytes < transferModule.TRANSFER_WIRE_LIMITS.maxFrameBytes);
});

async function executionFixture(readThread = async () => thread()) {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-transfer-')); const workspace = join(directory, 'repo'); const dataRoot = join(directory, 'data'); await mkdir(workspace);
  const store = createStateStore({ dataRoot });
  const job = await store.reserveJob({ workspace, ownerSessionId: 'codex-owner', ownerTurnId: 'turn-owner', command: 'transfer', codexThreadId: source, readOnly: true, permissionSnapshot: { permissionMode: 'workspace-write' } });
  /** @type {any[]} */
  const calls = [];
  /** @type {any} */
  const client = { createSession: async (/** @type {any} */ payload) => { calls.push(payload); return { session: { sessionId: 'zcode-session-1' } }; }, close: async () => { calls.push('close'); } };
  return { calls, client, dataRoot, directory, job, readThread, store, workspace };
}

test('creates imported history, writes a durable result, and succeeds the tracked read-only job', async () => {
  const context = await executionFixture(); const launch = { command: '/Applications/Z Code/zcode', args: ['--profile', 'a b'] };
  const output = await executeTransfer({ ...context, sourceThreadId: source, launch, createClient: async () => context.client });
  assert.equal(output.type, 'transfer'); assert.equal(output.job.status, 'succeeded'); assert.equal(output.job.codexThreadId, source); assert.equal(output.job.zcodeSessionId, 'zcode-session-1');
  assert.deepEqual(context.calls[0], { workspace: context.workspace, importedHistory: extractImportedHistory(thread(), source) });
  assert.equal(context.calls.includes('close'), true);
  assert.match(output.result, /^Imported from Codex/m); assert.match(output.result, /ZCode session ID: zcode-session-1/); assert.match(output.resumeCommand, /^'\/Applications\/Z Code\/zcode' --profile 'a b' --resume zcode-session-1$/);
  const storage = await resolveWorkspaceStorage(context);
  assert.equal(await readFile(join(storage.directory, output.job.resultArtifact), 'utf8'), output.result);
  assert.equal(output.job.logFile, join(storage.directory, 'jobs', `${output.job.id}.log`));
  const log = await readFile(output.job.logFile, 'utf8');
  assert.match(log, /Final output\nImported from Codex\n/);
  assert.equal((log.match(/Final output/g) ?? []).length, 1);
  assert.doesNotMatch(log, /Assistant message/);
});

test('Transfer success finalization failure keeps its recoverable result and never rewrites failed', async () => {
  const context = await executionFixture(); const storageError = new PluginError('JSON_WRITE_FAILED', 'transfer success write failed once', { category: 'storage', remedy: 'retry recovery' }); let failedWrites = 0; let successWrites = 0;
  const store = { ...context.store, finishJob: async (/** @type {string} */ workspace, /** @type {string} */ jobId, /** @type {string[]} */ expected, /** @type {string} */ next, /** @type {Record<string,unknown>} */ patch) => { if (next === 'succeeded') { successWrites += 1; throw storageError; } failedWrites += 1; return context.store.finishJob(workspace, jobId, expected, next, patch); } };
  await assert.rejects(executeTransfer({ ...context, store, sourceThreadId: source, launch: { command: 'zcode', args: [] }, createClient: async () => context.client }), (error) => error === storageError || /** @type {any} */ (error)?.cause === storageError);
  assert.equal(successWrites, 1); assert.equal(failedWrites, 0); assert.equal((await context.store.readJob(context.workspace, context.job.id)).status, 'running');
  const storage = await resolveWorkspaceStorage(context); assert.match(await readFile(join(storage.directory, 'results', `${context.job.id}.md`), 'utf8'), /ZCode session ID: zcode-session-1/);
});

test('Transfer persists and holds its exact worker lease before reading Codex history', async () => {
  const context = await executionFixture(); /** @type {any} */ let observed;
  await assert.rejects(executeTransfer({ ...context, sourceThreadId: source, launch: { command: 'zcode', args: [] }, readThread: async () => {
    observed = await context.store.readJob(context.workspace, context.job.id);
    await assert.rejects(withWorkerLease({ dataRoot: context.dataRoot, workspace: context.workspace, jobId: observed.id, workerLeaseId: observed.workerLeaseId, timeoutMs: 0 }, async () => {}), { code: 'LOCK_TIMEOUT' });
    throw new Error('stop after lease observation');
  }, createClient: async () => context.client }), /stop after lease observation/);
  const persisted = /** @type {any} */ (observed); assert.equal(persisted.status, 'running'); assert.equal(persisted.childPid, process.pid); assert.match(persisted.workerLeaseId, /^[a-f0-9]{64}$/);
});

test('thread/read and conversion failures happen before ZCode creation and durably fail the job', async () => {
  for (const readThread of [async () => { throw Object.assign(new Error('unavailable'), { code: 'CODEX_THREAD_READ_FAILED' }); }, async () => thread({ turns: [] })]) {
    const context = await executionFixture(readThread); let createCalls = 0;
    await assert.rejects(executeTransfer({ ...context, sourceThreadId: source, launch: { command: 'zcode', args: [] }, createClient: async () => { createCalls += 1; return context.client; } }));
    assert.equal(createCalls, 0); const failed = await context.store.readJob(context.workspace, context.job.id); assert.equal(failed.status, 'failed'); assert.equal(failed.resultArtifact, undefined);
    assert.doesNotMatch(await readFile(failed.logFile, 'utf8'), /Assistant message|Final output/);
  }
});

test('rejects unsafe session IDs and launcher controls before persistence, rendering, or artifact creation', async () => {
  for (const sessionId of ['line-one\nline-two', '\u001b[31mspoof', 'x'.repeat(513)]) {
    const context = await executionFixture(); context.client.createSession = async () => ({ session: { sessionId } }); let artifactWrites = 0;
    await assert.rejects(executeTransfer({ ...context, sourceThreadId: source, launch: { command: 'zcode', args: [] }, createClient: async () => context.client, writeResult: async () => { artifactWrites += 1; return 'must-not-exist'; } }), { code: 'ZCODE_OUTPUT_INVALID' });
    assert.equal(artifactWrites, 0); const failed = await context.store.readJob(context.workspace, context.job.id); assert.equal(failed.status, 'failed'); assert.equal(failed.zcodeSessionId, undefined); assert.equal(failed.resultArtifact, undefined);
  }
  for (const launch of [{ command: 'zcode\nspoof', args: [] }, { command: 'zcode', args: ['--profile', '\u001b[31mspoof'] }]) {
    const context = await executionFixture(); let artifactWrites = 0;
    await assert.rejects(executeTransfer({ ...context, sourceThreadId: source, launch, createClient: async () => context.client, writeResult: async () => { artifactWrites += 1; return 'must-not-exist'; } }), { code: 'TRANSFER_INPUT_INVALID' });
    assert.equal(artifactWrites, 0);
  }
});

function deferred() { let resolve = () => {}; const promise = new Promise((done) => { resolve = () => done(undefined); }); return { promise, resolve }; }

test('joins an in-flight successful cancellation after artifact write and does not publish success or leave an orphan', async () => {
  const context = await executionFixture(); const artifactWritten = deferred(); const releaseWriter = deferred(); const stopEntered = deferred(); const releaseStop = deferred(); let createCalls = 0; let writeCalls = 0; let transferSettled = false; let artifact = '';
  context.client.createSession = async () => { createCalls += 1; return { session: { sessionId: 'zcode-session-1' } }; };
  const transfer = executeTransfer({ ...context, sourceThreadId: source, launch: { command: 'zcode', args: [] }, createClient: async () => context.client, writeResult: async (input) => { writeCalls += 1; artifact = await writeResultArtifact(input); artifactWritten.resolve(); await releaseWriter.promise; return artifact; } }).then((value) => { transferSettled = true; return { value, error: null }; }, (error) => { transferSettled = true; return { value: null, error }; });
  await artifactWritten.promise;
  const controller = createJobController({ store: context.store, dataRoot: context.dataRoot, stopSession: async () => { stopEntered.resolve(); await releaseStop.promise; } });
  const cancelling = controller.cancel(context.workspace, context.job.id, 'codex-owner'); await stopEntered.promise; releaseWriter.resolve(); await new Promise((resolve) => setTimeout(resolve, 20)); assert.equal(transferSettled, false);
  releaseStop.resolve(); assert.equal((await cancelling).status, 'cancelled'); assert.equal((await transfer).error?.code, 'TRANSFER_CANCELLED');
  const final = await context.store.readJob(context.workspace, context.job.id); assert.equal(final.status, 'cancelled'); assert.equal(final.resultArtifact, undefined); assert.equal(createCalls, 1); assert.equal(writeCalls, 1);
  const storage = await resolveWorkspaceStorage(context); await assert.rejects(readFile(join(storage.directory, artifact), 'utf8'), { code: 'ENOENT' });
});

test('joins a failed cancellation after artifact write and completes exactly once', async () => {
  const context = await executionFixture(); const artifactWritten = deferred(); const releaseWriter = deferred(); const stopEntered = deferred(); const releaseStop = deferred(); let createCalls = 0; let writeCalls = 0; let transferSettled = false;
  context.client.createSession = async () => { createCalls += 1; return { session: { sessionId: 'zcode-session-1' } }; };
  const transfer = executeTransfer({ ...context, sourceThreadId: source, launch: { command: 'zcode', args: [] }, createClient: async () => context.client, writeResult: async (input) => { writeCalls += 1; const artifact = await writeResultArtifact(input); artifactWritten.resolve(); await releaseWriter.promise; return artifact; } }).then((value) => { transferSettled = true; return { value, error: null }; }, (error) => { transferSettled = true; return { value: null, error }; });
  await artifactWritten.promise;
  const controller = createJobController({ store: context.store, dataRoot: context.dataRoot, stopSession: async () => { stopEntered.resolve(); await releaseStop.promise; throw new Error('refused'); } });
  const cancelling = controller.cancel(context.workspace, context.job.id, 'codex-owner'); await stopEntered.promise; releaseWriter.resolve(); await new Promise((resolve) => setTimeout(resolve, 20)); assert.equal(transferSettled, false);
  releaseStop.resolve(); await assert.rejects(cancelling, { code: 'JOB_CANCEL_FAILED' }); const output = (await transfer).value;
  assert.ok(output); assert.equal(output.job.status, 'succeeded'); assert.equal(createCalls, 1); assert.equal(writeCalls, 1); assert.equal((await context.store.readJob(context.workspace, context.job.id)).status, 'succeeded');
});

test('artifact failure terminalization joins successful and failed cancellation attempts', async () => {
  for (const stopSucceeds of [true, false]) {
    const context = await executionFixture(); const writerEntered = deferred(); const releaseWriter = deferred(); const stopEntered = deferred(); const releaseStop = deferred(); let settled = false;
    const transfer = executeTransfer({ ...context, sourceThreadId: source, launch: { command: 'zcode', args: [] }, createClient: async () => context.client, writeResult: async () => { writerEntered.resolve(); await releaseWriter.promise; throw new Error('disk refused'); } }).then((value) => { settled = true; return { value, error: null }; }, (error) => { settled = true; return { value: null, error }; });
    await writerEntered.promise;
    const controller = createJobController({ store: context.store, dataRoot: context.dataRoot, stopSession: async () => { stopEntered.resolve(); await releaseStop.promise; if (!stopSucceeds) throw new Error('stop refused'); } });
    const cancelling = controller.cancel(context.workspace, context.job.id, 'codex-owner'); await stopEntered.promise; releaseWriter.resolve(); await new Promise((resolve) => setTimeout(resolve, 20)); assert.equal(settled, false);
    releaseStop.resolve(); if (stopSucceeds) assert.equal((await cancelling).status, 'cancelled'); else await assert.rejects(cancelling, { code: 'JOB_CANCEL_FAILED' });
    assert.match((await transfer).error?.message ?? '', /disk refused/); const final = await context.store.readJob(context.workspace, context.job.id); assert.equal(final.status, stopSucceeds ? 'cancelled' : 'failed'); assert.equal(final.resultArtifact, undefined);
  }
});

test('Transfer interruption during Codex read cancels without creating a remote session', async () => {
  const controller = new AbortController(); const interruption = new PluginError('JOB_INTERRUPTED', 'read interrupted'); const context = await executionFixture(); let creates = 0;
  await assert.rejects(executeTransfer({ ...context, sourceThreadId: source, launch: { command: 'zcode', args: [] }, signal: controller.signal, readThread: async () => { controller.abort(interruption); throw new Error('bounded read failed after interruption'); }, createClient: async () => { creates += 1; return context.client; } }), (error) => error === interruption);
  const persisted = await context.store.readJob(context.workspace, context.job.id);
  assert.equal(creates, 0); assert.equal(persisted.status, 'cancelled'); assert.ok(persisted.finishedAt); assert.equal(persisted.zcodeSessionId, undefined); assert.equal(persisted.resultArtifact, undefined);
});

test('Transfer owns and closes a client returned after createClient observes interruption', async () => {
  const controller = new AbortController(); const interruption = new PluginError('JOB_INTERRUPTED', 'client interrupted'); const context = await executionFixture(); let closes = 0; let sessions = 0;
  context.client.close = async () => { closes += 1; }; context.client.createSession = async () => { sessions += 1; return { session: { sessionId: 'must-not-create' } }; };
  await assert.rejects(executeTransfer({ ...context, sourceThreadId: source, launch: { command: 'zcode', args: [] }, signal: controller.signal, createClient: async () => { controller.abort(interruption); return context.client; } }), (error) => error === interruption);
  const persisted = await context.store.readJob(context.workspace, context.job.id);
  assert.equal(closes, 1); assert.equal(sessions, 0); assert.equal(persisted.status, 'cancelled'); assert.equal(persisted.zcodeSessionId, undefined); assert.equal(persisted.resultArtifact, undefined);
});

test('Transfer interruption after create persists and stops the exact remote session once', async () => {
  const controller = new AbortController(); const interruption = new PluginError('JOB_INTERRUPTED', 'create interrupted'); const context = await executionFixture(); let stops = 0; let closes = 0;
  context.client.createSession = async () => { controller.abort(interruption); return { session: { sessionId: 'zcode-interrupted-create' } }; };
  context.client.stopSession = async (/** @type {string} */ sessionId) => { assert.equal(sessionId, 'zcode-interrupted-create'); stops += 1; };
  context.client.close = async () => { closes += 1; };
  await assert.rejects(executeTransfer({ ...context, sourceThreadId: source, launch: { command: 'zcode', args: [] }, signal: controller.signal, createClient: async () => context.client }), (error) => error === interruption);
  const persisted = await context.store.readJob(context.workspace, context.job.id);
  assert.equal(stops, 1); assert.equal(closes, 1); assert.equal(persisted.zcodeSessionId, 'zcode-interrupted-create'); assert.equal(persisted.status, 'cancelled'); assert.equal(persisted.resultArtifact, undefined);
});

test('Transfer interruption preserves running and the original interruption when remote stop fails', async () => {
  const controller = new AbortController(); const interruption = new PluginError('JOB_INTERRUPTED', 'stop interrupted'); const context = await executionFixture(); let stops = 0;
  context.client.createSession = async () => { controller.abort(interruption); return { session: { sessionId: 'zcode-stop-refused' } }; };
  context.client.stopSession = async () => { stops += 1; throw new Error(`stop-refused-${'x'.repeat(4_000)}`); };
  await assert.rejects(executeTransfer({ ...context, sourceThreadId: source, launch: { command: 'zcode', args: [] }, signal: controller.signal, createClient: async () => context.client }), (error) => error === interruption);
  const persisted = await context.store.readJob(context.workspace, context.job.id);
  assert.equal(stops, 1); assert.equal(persisted.status, 'running'); assert.equal(persisted.zcodeSessionId, 'zcode-stop-refused'); assert.match(persisted.lastCancelError, /^stop-refused-/); assert.ok(Buffer.byteLength(persisted.lastCancelError) <= 2_048);
});

test('Transfer interruption removes a written result while a completed finalization still wins', async () => {
  {
    const controller = new AbortController(); const interruption = new PluginError('JOB_INTERRUPTED', 'artifact interrupted'); const context = await executionFixture(); let artifact = '';
    context.client.stopSession = async () => {};
    await assert.rejects(executeTransfer({ ...context, sourceThreadId: source, launch: { command: 'zcode', args: [] }, signal: controller.signal, createClient: async () => context.client, writeResult: async (input) => { artifact = await writeResultArtifact(input); controller.abort(interruption); return artifact; } }), (error) => error === interruption);
    const persisted = await context.store.readJob(context.workspace, context.job.id); assert.equal(persisted.status, 'cancelled'); assert.equal(persisted.resultArtifact, undefined);
    const storage = await resolveWorkspaceStorage(context); await assert.rejects(readFile(join(storage.directory, artifact), 'utf8'), { code: 'ENOENT' });
  }
  {
    const controller = new AbortController(); const context = await executionFixture();
    const wrapped = { ...context.store, transitionJob: async (/** @type {string} */ workspace, /** @type {string} */ jobId, /** @type {string[]} */ expected, /** @type {string} */ next, /** @type {Record<string,unknown>} */ patch = {}) => { const result = await context.store.transitionJob(workspace, jobId, expected, next, patch); if (next === 'succeeded') controller.abort(new PluginError('JOB_INTERRUPTED', 'late')); return result; } };
    const output = await executeTransfer({ ...context, store: wrapped, sourceThreadId: source, launch: { command: 'zcode', args: [] }, signal: controller.signal, createClient: async () => context.client });
    assert.equal(output.job.status, 'succeeded'); assert.ok(output.job.resultArtifact); assert.equal((await context.store.readJob(context.workspace, context.job.id)).status, 'succeeded');
  }
});
