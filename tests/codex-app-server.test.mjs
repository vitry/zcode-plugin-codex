import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { CODEX_APP_SERVER_DEFAULT_TIMEOUT_MS, readCodexThread } from '../scripts/lib/codex-app-server.mjs';

const fake = fileURLToPath(new URL('./fixtures/fake-codex-app-server.mjs', import.meta.url));
const validThread = { id: 'thread-1', ephemeral: false, turns: [] };

async function run(env = {}, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'codex-app-server-'));
  const record = join(directory, 'requests.jsonl'); await writeFile(record, '');
  const value = await readCodexThread('thread-1', {
    executable: process.execPath, args: [fake], timeoutMs: 1_000,
    env: { ...process.env, FAKE_CODEX_RECORD: record, FAKE_CODEX_THREAD_JSON: JSON.stringify(validThread), ...env },
    ...options,
  });
  return { value, calls: (await readFile(record, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)), record };
}

test('initializes before reading a full thread and ignores unrelated frames', async () => {
  const { value, calls } = await run({ FAKE_CODEX_NOTIFICATION: '1', FAKE_CODEX_OTHER_ID: '1', FAKE_CODEX_PARTIAL: '1', FAKE_CODEX_CRLF: '1' });
  assert.deepEqual(value, validThread);
  assert.deepEqual(calls.filter((call) => call.method).map((call) => call.method), ['initialize', 'initialized', 'thread/read']);
  assert.deepEqual(calls[0].params, { clientInfo: { name: 'zcode-plugin-codex', title: 'ZCode plugin for Codex', version: '0.1.0' }, capabilities: null });
  assert.equal(calls[0].jsonrpc, undefined);
  assert.deepEqual(calls[1], { method: 'initialized', params: {} });
  assert.deepEqual(calls[2].params, { threadId: 'thread-1', includeTurns: true });
});

test('uses codex app-server and a 15 second deadline by default', async () => {
  /** @type {any} */ let observed;
  await assert.rejects(readCodexThread('thread-1', { spawn: (command, args, options) => { observed = { command, args, options }; throw Object.assign(new Error('missing'), { code: 'ENOENT' }); } }), { code: 'CODEX_APP_SERVER_SPAWN_FAILED' });
  assert.equal(observed.command, 'codex'); assert.deepEqual(observed.args, ['app-server']); assert.equal(observed.options.shell, false);
  assert.equal(CODEX_APP_SERVER_DEFAULT_TIMEOUT_MS, 15_000);
});

test('terminates the child on success, JSON-RPC error, malformed output, oversized line and timeout', async (t) => {
  /** @type {Array<[Record<string,string>,Record<string,number>,string|null]>} */ const cases = [
    [{}, {}, null],
    [{ FAKE_CODEX_ERROR: 'thread/read' }, {}, 'CODEX_THREAD_READ_FAILED'],
    [{ FAKE_CODEX_MALFORMED: 'thread/read' }, {}, 'CODEX_APP_SERVER_MALFORMED'],
    [{ FAKE_CODEX_AMBIGUOUS: 'thread/read' }, {}, 'CODEX_APP_SERVER_MALFORMED'],
    [{ FAKE_CODEX_OVERSIZE: 'thread/read', FAKE_CODEX_OVERSIZE_BYTES: '2048' }, { maxLineBytes: 256 }, 'CODEX_APP_SERVER_FRAME_TOO_LARGE'],
    [{ FAKE_CODEX_HANG: 'thread/read' }, { timeoutMs: 500 }, 'CODEX_APP_SERVER_TIMEOUT'],
  ];
  for (const [env, options, code] of cases) await t.test(code ?? 'success', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'codex-app-lifecycle-')); const record = join(directory, 'record.jsonl'); await writeFile(record, '');
    const promise = readCodexThread('thread-1', { executable: process.execPath, args: [fake], env: { ...process.env, FAKE_CODEX_RECORD: record, FAKE_CODEX_THREAD_JSON: JSON.stringify(validThread), ...env }, timeoutMs: 1_000, ...options });
    if (code) await assert.rejects(promise, { code }); else await promise;
    for (let index = 0; index < 50 && !(await readFile(record, 'utf8')).includes('lifecycle'); index += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.match(await readFile(record, 'utf8'), /"lifecycle":"SIGTERM"/);
  });
});

test('bounds and redacts stderr diagnostics without blocking', async () => {
  await assert.rejects(run({ FAKE_CODEX_STDERR_BYTES: '20000', FAKE_CODEX_STDERR_TEXT: ' token=super-secret ', FAKE_CODEX_ERROR: 'thread/read' }, { maxStderrBytes: 256 }), (/** @type {any} */ error) => {
    assert.equal(error.code, 'CODEX_THREAD_READ_FAILED');
    assert.ok(error.details.stderrTail.length <= 256); assert.doesNotMatch(error.details.stderrTail, /super-secret/); assert.match(error.details.stderrTail, /REDACTED/); return true;
  });
});

test('rejects malformed options and unsafe thread identifiers before spawn', async () => {
  for (const threadId of ['', 'x'.repeat(513)]) await assert.rejects(readCodexThread(threadId, { spawn: () => { throw new Error('must not spawn'); } }), { code: 'CODEX_APP_SERVER_INPUT_INVALID' });
  await assert.rejects(readCodexThread('ok', { timeoutMs: 0 }), { code: 'CODEX_APP_SERVER_INPUT_INVALID' });
});
