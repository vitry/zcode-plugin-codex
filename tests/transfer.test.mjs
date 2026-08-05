import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createStateStore } from '../scripts/lib/state.mjs';
import * as transferModule from '../scripts/lib/transfer.mjs';
import { extractImportedHistory, executeTransfer, resolveTransferSource, TRANSFER_LIMITS } from '../scripts/lib/transfer.mjs';
import { resolveWorkspaceStorage } from '../scripts/lib/workspace.mjs';

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
    { role: 'user', content: 'first\nsecond', timestamp: 1_725_000_000 },
    { role: 'assistant', content: 'answer', timestamp: 1_725_000_000 },
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
  const variants = [polluted, thread({ turns: [{ startedAt: -1, items: [] }] }), thread({ turns: [{ items: [{ type: 'userMessage', content: 'not-array' }] }] }), thread({ turns: [{ items: [{ type: 'agentMessage', text: 4 }] }] }), thread({ turns: [{ items: [{ type: 'userMessage', content: [{ type: 'text', text: 3 }] }] }] })];
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
  /** @type {any[]} */ const calls = []; const client = { createSession: async (/** @type {any} */ payload) => { calls.push(payload); return { session: { sessionId: 'zcode-session-1' } }; }, close: async () => { calls.push('close'); } };
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
});

test('thread/read and conversion failures happen before ZCode creation and durably fail the job', async () => {
  for (const readThread of [async () => { throw Object.assign(new Error('unavailable'), { code: 'CODEX_THREAD_READ_FAILED' }); }, async () => thread({ turns: [] })]) {
    const context = await executionFixture(readThread); let createCalls = 0;
    await assert.rejects(executeTransfer({ ...context, sourceThreadId: source, launch: { command: 'zcode', args: [] }, createClient: async () => { createCalls += 1; return context.client; } }));
    assert.equal(createCalls, 0); const failed = await context.store.readJob(context.workspace, context.job.id); assert.equal(failed.status, 'failed'); assert.equal(failed.resultArtifact, undefined);
  }
});
