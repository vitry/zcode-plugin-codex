import assert from 'node:assert/strict';
import { spawn as nodeSpawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  CODEX_APP_SERVER_DEFAULT_TIMEOUT_MS,
  listCodexThreadSpawnChildren,
  readCodexRescueChildTurnEvidence,
  readCodexThread,
  readCodexThreadSpawnChild,
  readCodexThreadSpawnChildIdentity,
  sanitizeCodexThreadSpawnChild,
} from '../scripts/lib/codex-app-server.mjs';
import { PluginError } from '../scripts/lib/errors.mjs';

const fake = fileURLToPath(new URL('./fixtures/fake-codex-app-server.mjs', import.meta.url));
const validThread = { id: 'thread-1', ephemeral: false, turns: [] };
const evidenceFixture = /** @type {any} */ (JSON.parse(readFileSync(
  fileURLToPath(new URL('./fixtures/codex-rescue/child-terminal-evidence.json', import.meta.url)), 'utf8')));
const EVIDENCE_PARENT_ID = '00000000-0000-7000-8000-000000000001';
const EVIDENCE_CHILD_ID = '00000000-0000-7000-8000-000000000002';
const EVIDENCE_TURN_ID = '00000000-0000-7000-8000-000000000003';
const EVIDENCE_REDACTION_MARKERS = ['[redacted: host error text excluded]', 'usageLimitExceeded'];

/** @param {Record<string,any>} [overrides] @returns {any} */
function childThread(overrides = {}) {
  return {
    id: 'child-1', sessionId: 'parent-1', forkedFromId: null, parentThreadId: 'parent-1',
    ephemeral: false, preview: '', section: null, sectionEnteredAt: null,
    modelProvider: 'openai', createdAt: 1, updatedAt: 2, recencyAt: 2,
    status: { type: 'notLoaded' }, path: null, cwd: '/repo', cliVersion: '0.147.0',
    source: { subAgent: { thread_spawn: {
      parent_thread_id: 'parent-1', depth: 1,
      agent_path: '/root/zcode_rescue_task', agent_nickname: null,
      agent_role: 'zcode-rescue',
    } } },
    threadSource: null, agentNickname: null, agentRole: 'zcode-rescue',
    gitInfo: null, name: null, turns: [], ...overrides,
  };
}

async function appOptions(env = {}, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'codex-app-server-children-'));
  const record = join(directory, 'requests.jsonl'); await writeFile(record, '');
  return {
    options: { executable: process.execPath, args: [fake], timeoutMs: 1_000,
      env: { ...process.env, FAKE_CODEX_RECORD: record, ...env }, ...overrides },
    record,
  };
}

async function recordedCalls(/** @type {string} */ record) {
  return (await readFile(record, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

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

/** @param {string} originator @param {string} version @param {string} [terminal] @param {boolean} [suffix] */
function codexUserAgent(originator, version, terminal = 'dumb', suffix = true) {
  return `${originator}/${version} (Mac OS 26.5.2; arm64) ${terminal}${suffix ? ' (zcode-plugin-codex; 0.1.0)' : ''}`;
}

test('initializes before reading a full thread and ignores unrelated frames', async () => {
  const { value, calls } = await run({ FAKE_CODEX_NOTIFICATION: '1', FAKE_CODEX_OTHER_ID: '1', FAKE_CODEX_PARTIAL: '1', FAKE_CODEX_CRLF: '1' });
  assert.deepEqual(value, validThread);
  assert.deepEqual(calls.filter((call) => call.method).map((call) => call.method), ['initialize', 'initialized', 'thread/read']);
  assert.deepEqual(calls[0].params, { clientInfo: { name: 'zcode-plugin-codex', title: 'ZCode plugin for Codex', version: '0.1.0' }, capabilities: null });
  assert.equal(calls[0].jsonrpc, undefined);
  assert.deepEqual(calls[1], { method: 'initialized', params: {} });
  assert.deepEqual(calls[2], { id: 2, method: 'thread/read', params: { threadId: 'thread-1', includeTurns: true } });
});

test('empty-preview exact-parent discovery uses relationship semantics', async () => {
  const emptyPreviewChild = childThread();
  const visibleForeignChild = childThread({
    id: 'foreign-child', sessionId: 'parent-2', parentThreadId: 'parent-2', preview: 'visible globally',
    source: { subAgent: { thread_spawn: {
      parent_thread_id: 'parent-2', depth: 1, agent_path: '/root/foreign', agent_nickname: null, agent_role: 'default',
    } } },
    agentRole: 'default',
  });
  const { options, record } = await appOptions({
    FAKE_CODEX_USER_AGENT: codexUserAgent('zcode-plugin-codex', '0.147.0'),
    FAKE_CODEX_THREAD_SPAWN_GRAPH_JSON: JSON.stringify([emptyPreviewChild, visibleForeignChild]),
  });

  const children = await listCodexThreadSpawnChildren('parent-1', options);

  assert.equal(children.length, 1);
  assert.equal(children[0].agentPath, '/root/zcode_rescue_task');
  const calls = await recordedCalls(record);
  assert.deepEqual(calls.find((call) => call.method === 'initialize').params.capabilities, { experimentalApi: true });
  assert.equal(calls.find((call) => call.method === 'thread/list').params.parentThreadId, 'parent-1');
});

test('exact-parent discovery accepts supported originators and rejects silent-ignore app-server versions', async (t) => {
  const graph = JSON.stringify([childThread()]);
  for (const [name, userAgent] of [
    ['alternate originator 0.149', codexUserAgent('codex_originator_via_env_var', '0.149.0')],
    ['slash originator 0.149', codexUserAgent('team/originator', '0.149.0')],
    ['space originator 0.149', codexUserAgent('Codex Something Else', '0.149.0')],
    ['space and slash originator 0.149', codexUserAgent('Codex Team/Else Product', '0.149.0')],
    ['newer prerelease', codexUserAgent('originator', '0.149.0-alpha.8')],
    ['minimum 0.141', codexUserAgent('zcode-plugin-codex', '0.141.0')],
    ['minimum build metadata', codexUserAgent('originator', '0.141.0+build.8')],
    ['old versioned terminal', codexUserAgent('originator', '0.149.0', 'legacy/0.100.0')],
    ['no initialize suffix', codexUserAgent('Codex Something Else', '0.149.0', 'dumb', false)],
  ]) {
    await t.test(name, async () => {
      const { options } = await appOptions({
        FAKE_CODEX_USER_AGENT: userAgent,
        FAKE_CODEX_THREAD_SPAWN_GRAPH_JSON: graph,
      });
      assert.equal((await listCodexThreadSpawnChildren('parent-1', options)).length, 1);
    });
  }
  for (const [name, userAgent] of [
    ['new terminal cannot mask 0.117 host', codexUserAgent('originator', '0.117.0', 'vscode/1.104.0')],
    ['minimum prerelease', codexUserAgent('originator', '0.141.0-alpha.8')],
    ['0.140 boundary', codexUserAgent('zcode-plugin-codex', '0.140.0')],
    ['0.117 silent ignore', codexUserAgent('zcode-plugin-codex', '0.117.0')],
    ['leading-zero core', codexUserAgent('originator', '0.0141.0')],
    ['leading-zero prerelease', codexUserAgent('originator', '0.149.0-08')],
    ['earlier originator semver cannot mask old host', codexUserAgent('Codex/9.9.9 (originator) Else', '0.140.0')],
    ['earlier originator semver cannot mask malformed host', codexUserAgent('Codex/9.9.9 (originator) Else', 'not-semver')],
    ['missing platform delimiter', 'originator/0.149.0 fake'],
    ['unparseable', 'fake-codex'],
    ['oversized', codexUserAgent('originator', '0.149.0', `dumb${'x'.repeat(4096)}`)],
  ]) {
    await t.test(name, async () => {
      const { options, record } = await appOptions({
        FAKE_CODEX_USER_AGENT: userAgent,
        FAKE_CODEX_THREAD_SPAWN_GRAPH_JSON: graph,
      });
      await assert.rejects(listCodexThreadSpawnChildren('parent-1', options), { code: 'CODEX_THREAD_LIST_FAILED' });
      assert.equal((await recordedCalls(record)).some((call) => call.method === 'thread/list'), false);
    });
  }
});

test('lists exact-parent persisted spawn children over bounded stable pages and rereads one child', async () => {
  const pages = [
    { data: [], nextCursor: 'page-2', backwardsCursor: 'ignored' },
    { data: [childThread()], nextCursor: null, backwardsCursor: 'ignored-too' },
  ];
  const { options, record } = await appOptions({
    FAKE_CODEX_THREAD_LIST_RESULTS_JSON: JSON.stringify(pages),
    FAKE_CODEX_THREAD_JSON: JSON.stringify(childThread()),
    FAKE_CODEX_NOTIFICATION: '1', FAKE_CODEX_OTHER_ID: '1', FAKE_CODEX_PARTIAL: '1', FAKE_CODEX_CRLF: '1',
  }, { pageSize: 50 });
  const children = await listCodexThreadSpawnChildren('parent-1', options);
  assert.deepEqual(children, [{
    id: 'child-1', parentThreadId: 'parent-1', agentPath: '/root/zcode_rescue_task', agentRole: 'zcode-rescue',
    cwd: '/repo', status: { type: 'notLoaded' }, createdAt: 1, updatedAt: 2,
  }]);
  const calls = await recordedCalls(record);
  const lists = calls.filter((call) => call.method === 'thread/list');
  assert.deepEqual(lists.map((call) => call.params), [
    { parentThreadId: 'parent-1', sourceKinds: ['subAgentThreadSpawn'], limit: 50, sortKey: 'created_at', sortDirection: 'desc' },
    { parentThreadId: 'parent-1', sourceKinds: ['subAgentThreadSpawn'], limit: 50, sortKey: 'created_at', sortDirection: 'desc', cursor: 'page-2' },
  ]);
  assert.deepEqual(calls.find((call) => call.method === 'initialize').params.capabilities, { experimentalApi: true });

  const reread = await readCodexThreadSpawnChild('child-1', 'parent-1', options);
  assert.deepEqual(reread, children[0]);
  const allCalls = await recordedCalls(record);
  assert.deepEqual(allCalls.filter((call) => call.method === 'thread/read').at(-1).params, { threadId: 'child-1', includeTurns: false });
  assert.equal(allCalls.filter((call) => call.method === 'initialize').at(-1).params.capabilities, null);
});

test('reads an ambient spawn child identity without caller-supplied parent and returns a defensive copy', async () => {
  const raw = childThread({ status: { type: 'active', activeFlags: ['waitingOnApproval'] } });
  const { options, record } = await appOptions({ FAKE_CODEX_THREAD_JSON: JSON.stringify(raw) });
  const identity = await readCodexThreadSpawnChildIdentity('child-1', options);
  assert.deepEqual(identity, {
    id: 'child-1', parentThreadId: 'parent-1', agentPath: '/root/zcode_rescue_task', agentRole: 'zcode-rescue',
    cwd: '/repo', status: { type: 'active', activeFlags: ['waitingOnApproval'] }, createdAt: 1, updatedAt: 2,
  });
  raw.status.activeFlags.push('waitingOnUserInput');
  assert.deepEqual(identity.status, { type: 'active', activeFlags: ['waitingOnApproval'] });
  assert.deepEqual((await recordedCalls(record)).find((call) => call.method === 'thread/read').params,
    { threadId: 'child-1', includeTurns: false });
});

test('ambient spawn child identity rejects every identity and metadata drift', async (t) => {
  /** @type {Array<[string, (thread:any)=>void]>} */
  const cases = [
    ['wrong child', (thread) => { thread.id = 'private-wrong-child'; }],
    ['missing top parent', (thread) => { delete thread.parentThreadId; }],
    ['contradictory parent', (thread) => { thread.parentThreadId = 'other-parent'; }],
    ['missing nested parent', (thread) => { delete thread.source.subAgent.thread_spawn.parent_thread_id; }],
    ['top role drift', (thread) => { thread.agentRole = 'default'; }],
    ['nested role drift', (thread) => { thread.source.subAgent.thread_spawn.agent_role = 'default'; }],
    ['path drift', (thread) => { thread.source.subAgent.thread_spawn.agent_path = '../private'; }],
    ['malformed status', (thread) => { thread.status = { type: 'active', activeFlags: ['unknown'] }; }],
  ];
  for (const [name, mutate] of cases) await t.test(name, async () => {
    const thread = childThread(); mutate(thread);
    const { options } = await appOptions({ FAKE_CODEX_THREAD_JSON: JSON.stringify(thread) });
    await assert.rejects(readCodexThreadSpawnChildIdentity('child-1', options), (/** @type {any} */ error) => {
      assert.equal(error.code, 'CODEX_CHILD_METADATA_INVALID');
      assert.doesNotMatch(String(error.stack), /private-wrong-child/);
      return true;
    });
  });
});

test('ambient spawn child identity preserves bounded timeout abort overflow and reaping', async (t) => {
  await t.test('pre-abort', async () => {
    const controller = new AbortController(); controller.abort('private-reason'); let spawned = false;
    await assert.rejects(readCodexThreadSpawnChildIdentity('child-1', {
      signal: controller.signal, spawn: () => { spawned = true; throw new Error('must not spawn'); },
    }), { code: 'JOB_INTERRUPTED' });
    assert.equal(spawned, false);
  });
  /** @type {Array<[string, Record<string,string>, Record<string,number>, string]>} */
  const cases = [
    ['timeout', { FAKE_CODEX_HANG: 'thread/read' }, { timeoutMs: 1_000 }, 'CODEX_APP_SERVER_TIMEOUT'],
    ['overflow', { FAKE_CODEX_NOTIFICATION: '1', FAKE_CODEX_OTHER_ID: '1' }, { maxOutputBytes: 100 }, 'CODEX_APP_SERVER_OUTPUT_TOO_LARGE'],
  ];
  for (const [name, env, bounds, code] of cases) await t.test(name, async () => {
    const { options, record } = await appOptions({ FAKE_CODEX_THREAD_JSON: JSON.stringify(childThread()), ...env }, bounds);
    await assert.rejects(readCodexThreadSpawnChildIdentity('child-1', options), { code });
    if (process.platform !== 'win32') {
      for (let index = 0; index < 50 && !(await readFile(record, 'utf8')).includes('lifecycle'); index += 1) await new Promise((resolve) => setTimeout(resolve, 5));
      assert.match(await readFile(record, 'utf8'), /"lifecycle":"SIGTERM"/);
    }
  });
});

test('exact-parent list rejects every foreign or incomplete row', async (t) => {
  const legacy = childThread({
    id: 'legacy-child', parentThreadId: null, agentRole: 'worker',
    source: { subAgent: { thread_spawn: {
      parent_thread_id: 'legacy-parent', depth: 1, agent_path: null, agent_nickname: 'Legacy', agent_role: 'worker',
    } } },
  });
  const list = async (/** @type {any} */ thread) => {
    const { options } = await appOptions({
      FAKE_CODEX_THREAD_LIST_RESULTS_JSON: JSON.stringify({ data: [thread], nextCursor: null, backwardsCursor: null }),
    });
    return listCodexThreadSpawnChildren('parent-1', options);
  };
  const rejected = /** @type {[string,(thread:any)=>void][]} */ ([
    ['foreign legacy row', () => {}],
    ['missing top parent', (thread) => { delete thread.parentThreadId; }],
    ['non-string top parent', (thread) => { thread.parentThreadId = 7; }],
    ['unsafe top parent', (thread) => { thread.parentThreadId = 'legacy-parent\n'; }],
    ['contradictory top parent', (thread) => { thread.parentThreadId = 'other-parent'; }],
    ['requested nested parent', (thread) => { thread.source.subAgent.thread_spawn.parent_thread_id = 'parent-1'; }],
  ]);
  for (const [name, mutate] of rejected) await t.test(name, async () => {
    const thread = structuredClone(legacy); mutate(thread);
    await assert.rejects(list(thread), { code: 'CODEX_CHILD_METADATA_INVALID' });
  });
});

test('shared SpawnChild sanitizer accepts raw and sanitized snapshots with defensive status cloning', () => {
  const raw = childThread({ status: { type: 'active', activeFlags: ['waitingOnApproval'] } });
  const first = sanitizeCodexThreadSpawnChild(raw, 'parent-1', 'child-1');
  const second = sanitizeCodexThreadSpawnChild(first, 'parent-1', 'child-1');
  assert.deepEqual(second, first); assert.notEqual(second, first); assert.notEqual(second.status, first.status);
  /** @type {any} */ (first.status).activeFlags.push('waitingOnUserInput');
  assert.deepEqual(second.status, { type: 'active', activeFlags: ['waitingOnApproval'] });
  assert.throws(() => sanitizeCodexThreadSpawnChild({ ...second, extra: true }), { code: 'CODEX_CHILD_METADATA_INVALID' });
  assert.throws(() => sanitizeCodexThreadSpawnChild(second, 'wrong-parent', 'child-1'), { code: 'CODEX_CHILD_METADATA_INVALID' });
});

test('app-server list and read require raw thread-spawn provenance rather than sanitized snapshots', async (t) => {
  const snapshot = sanitizeCodexThreadSpawnChild(childThread());
  await t.test('list', async () => {
    const { options } = await appOptions({
      FAKE_CODEX_THREAD_LIST_RESULTS_JSON: JSON.stringify({ data: [snapshot], nextCursor: null, backwardsCursor: null }),
    });
    await assert.rejects(listCodexThreadSpawnChildren('parent-1', options), { code: 'CODEX_CHILD_METADATA_INVALID' });
  });
  await t.test('read', async () => {
    const { options } = await appOptions({ FAKE_CODEX_THREAD_JSON: JSON.stringify(snapshot) });
    await assert.rejects(readCodexThreadSpawnChild('child-1', 'parent-1', options), { code: 'CODEX_CHILD_METADATA_INVALID' });
  });
});

test('app-server operations honor pre-abort and promptly reap hung list/read children', async (t) => {
  await t.test('pre-aborted does not spawn', async () => {
    const controller = new AbortController();
    const interruption = new PluginError('JOB_INTERRUPTED', 'Preparation interrupted.', { category: 'interruption', remedy: 'Retry.' });
    controller.abort(interruption); let spawned = false;
    await assert.rejects(listCodexThreadSpawnChildren('parent-1', { signal: controller.signal, spawn: () => { spawned = true; throw new Error('must not spawn'); } }), (error) => error === interruption);
    assert.equal(spawned, false);
  });
  await t.test('untrusted abort reason is replaced', async () => {
    const controller = new AbortController(); controller.abort('PRIVATE_ABORT_REASON');
    await assert.rejects(readCodexThreadSpawnChild('child-1', 'parent-1', { signal: controller.signal }), (/** @type {any} */ error) => {
      assert.equal(error.code, 'JOB_INTERRUPTED'); assert.equal(error.category, 'interruption');
      assert.doesNotMatch(`${error.message}${error.remedy}${error.stack}`, /PRIVATE_ABORT_REASON/); return true;
    });
  });
  /** @type {Array<[string,string,(options:any)=>Promise<any>]>} */
  const operations = [
    ['initialize', 'initialize', (options) => readCodexThreadSpawnChild('child-1', 'parent-1', options)],
    ['list', 'thread/list', (options) => listCodexThreadSpawnChildren('parent-1', options)],
    ['read', 'thread/read', (options) => readCodexThreadSpawnChild('child-1', 'parent-1', options)],
    ['ambient identity', 'thread/read', (options) => readCodexThreadSpawnChildIdentity('child-1', options)],
  ];
  for (const [name, method, operation] of operations) await t.test(name, async () => {
    const controller = new AbortController(); const interruption = new PluginError('JOB_INTERRUPTED', `${name} interrupted.`, { category: 'interruption', remedy: 'Retry.' });
    const observed = /** @type {{child:import('node:child_process').ChildProcess|null}} */ ({ child: null });
    const spawn = (/** @type {string} */ command, /** @type {string[]} */ args, /** @type {any} */ spawnOptions) => {
      observed.child = nodeSpawn(command, args, spawnOptions); return observed.child;
    };
    const { options, record } = await appOptions({ FAKE_CODEX_HANG: method }, { timeoutMs: 15_000, signal: controller.signal, spawn });
    const promise = operation(options); const observedDeadline = Date.now() + 2_000;
    while (!(await recordedCalls(record)).some((call) => call.method === method) && Date.now() < observedDeadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal((await recordedCalls(record)).some((call) => call.method === method), true);
    const startedAt = Date.now(); controller.abort(interruption);
    await assert.rejects(promise, (error) => error === interruption);
    assert.ok(Date.now() - startedAt < 1_000, `${name} cancellation was not prompt`);
    assert.ok(observed.child, `${name} app-server child was not observed`);
    assert.equal(observed.child.exitCode !== null || observed.child.signalCode !== null, true, `${name} app-server child was not reaped`);
    const calls = await recordedCalls(record);
    if (process.platform !== 'win32') assert.equal(calls.some((call) => call.lifecycle === 'SIGTERM'), true);
  });
});

test('rejects contradictory or unsafe thread-spawn metadata', async (t) => {
  /** @type {Array<[string,(thread:any)=>void]>} */
  const cases = [
    ['contradictory parent', (thread) => { thread.source.subAgent.thread_spawn.parent_thread_id = 'secret-parent'; }],
    ['contradictory role', (thread) => { thread.source.subAgent.thread_spawn.agent_role = 'default'; }],
    ['missing path', (thread) => { thread.source.subAgent.thread_spawn.agent_path = null; }],
    ['relative path', (thread) => { thread.source.subAgent.thread_spawn.agent_path = 'root/task'; }],
    ['noncanonical path', (thread) => { thread.source.subAgent.thread_spawn.agent_path = '/root/a/../task'; }],
    ['control path', (thread) => { thread.source.subAgent.thread_spawn.agent_path = '/root/task\nsecret-path'; }],
    ['relative cwd', (thread) => { thread.cwd = 'repo'; }],
    ['noncanonical cwd', (thread) => { thread.cwd = '/repo/../secret-cwd'; }],
    ['unknown status', (thread) => { thread.status = { type: 'secret-status' }; }],
    ['unsafe status shape', (thread) => { thread.status = { type: 'idle', extra: 'secret-status' }; }],
  ];
  for (const [name, mutate] of cases) await t.test(name, async () => {
    const thread = childThread(); mutate(thread);
    const { options } = await appOptions({ FAKE_CODEX_THREAD_LIST_RESULTS_JSON: JSON.stringify({ data: [thread], nextCursor: null, backwardsCursor: null }) });
    await assert.rejects(listCodexThreadSpawnChildren('parent-1', options), (/** @type {any} */ error) => {
      assert.equal(error.code, 'CODEX_CHILD_METADATA_INVALID');
      assert.doesNotMatch(String(error.stack), /secret-(?:parent|path|cwd|status)/); return true;
    });
  });
});

test('rejects duplicate child IDs and paths', async (t) => {
  /** @type {Array<[string,any[]]>} */
  const duplicateCases = [
    ['id', [{ data: [childThread(), childThread({ cwd: '/other' })], nextCursor: null, backwardsCursor: null }]],
    ['path', [{ data: [childThread(), childThread({ id: 'child-2' })], nextCursor: null, backwardsCursor: null }]],
    ['cross-page id', [
      { data: [childThread()], nextCursor: 'page-2', backwardsCursor: null },
      { data: [childThread({ cwd: '/other', source: { subAgent: { thread_spawn: {
        parent_thread_id: 'parent-1', depth: 1, agent_path: '/root/task_2', agent_nickname: null, agent_role: 'zcode-rescue',
      } } } })], nextCursor: null, backwardsCursor: null },
    ]],
  ];
  for (const [name, pages] of duplicateCases) await t.test(name, async () => {
    const { options } = await appOptions({ FAKE_CODEX_THREAD_LIST_RESULTS_JSON: JSON.stringify(pages) });
    await assert.rejects(listCodexThreadSpawnChildren('parent-1', options), { code: 'CODEX_CHILD_METADATA_INVALID' });
  });
});

test('rejects unsafe or cyclic cursors and bounded page/item exhaustion', async (t) => {
  /** @type {Array<[string,any[],Record<string,number>,string]>} */
  const cases = [
    ['control cursor', [{ data: [], nextCursor: 'next\nsecret-cursor', backwardsCursor: null }], {}, 'CODEX_THREAD_LIST_INVALID'],
    ['unsafe backwards cursor', [{ data: [], nextCursor: null, backwardsCursor: 'back\nsecret-cursor' }], {}, 'CODEX_THREAD_LIST_INVALID'],
    ['oversized cursor', [{ data: [], nextCursor: 'x'.repeat(4097), backwardsCursor: null }], {}, 'CODEX_THREAD_LIST_INVALID'],
    ['cursor cycle', [{ data: [], nextCursor: 'same', backwardsCursor: null }], {}, 'CODEX_THREAD_LIST_CURSOR_CYCLE'],
    ['page budget', [{ data: [], nextCursor: 'a', backwardsCursor: null }, { data: [], nextCursor: 'b', backwardsCursor: null }], { maxPages: 2 }, 'CODEX_THREAD_LIST_LIMIT_EXCEEDED'],
    ['item budget', [{ data: [childThread(), childThread({ id: 'child-2', source: { subAgent: { thread_spawn: { parent_thread_id: 'parent-1', depth: 1, agent_path: '/root/task_2', agent_nickname: null, agent_role: 'zcode-rescue' } } } })], nextCursor: null, backwardsCursor: null }], { maxItems: 1 }, 'CODEX_THREAD_LIST_LIMIT_EXCEEDED'],
  ];
  for (const [name, pages, bounds, code] of cases) await t.test(name, async () => {
    const { options } = await appOptions({ FAKE_CODEX_THREAD_LIST_RESULTS_JSON: JSON.stringify(pages) }, bounds);
    await assert.rejects(listCodexThreadSpawnChildren('parent-1', options), (/** @type {any} */ error) => {
      assert.equal(error.code, code); assert.doesNotMatch(String(error.stack), /secret-cursor/); return true;
    });
  });
});

test('preserves the controlled write error when initialized notification cannot be sent', async () => {
  class BrokenAfterInitializeChild extends EventEmitter {
    constructor() {
      super(); this.stdout = new PassThrough(); this.stderr = new PassThrough();
      this.exitCode = null; this.signalCode = null;
      const stdin = /** @type {any} */ (new EventEmitter());
      stdin.writable = true; stdin.end = () => {};
      stdin.write = (/** @type {string} */ frame) => {
        const request = JSON.parse(frame);
        stdin.writable = false;
        queueMicrotask(() => this.stdout.write(`${JSON.stringify({ id: request.id, result: {} })}\n`));
      };
      this.stdin = stdin;
    }
    kill(/** @type {string} */ signal) { this.signalCode = signal; queueMicrotask(() => this.emit('exit', null, signal)); return true; }
  }
  await assert.rejects(readCodexThread('thread-1', { spawn: () => new BrokenAfterInitializeChild(), timeoutMs: 100 }), { code: 'CODEX_APP_SERVER_WRITE_FAILED' });
});

test('validates list bounds before spawning', async () => {
  for (const options of [{ pageSize: 101 }, { maxPages: 33 }, { maxItems: 1025 }, { pageSize: 0 }]) {
    await assert.rejects(listCodexThreadSpawnChildren('parent-1', { ...options, spawn: () => { throw new Error('must not spawn'); } }), { code: 'CODEX_APP_SERVER_INPUT_INVALID' });
  }
});

test('list and sanitized read reject malformed, remote error, timeout, disconnect, and wrong read identity', async (t) => {
  /** @type {Array<[string,string,Record<string,string>,Record<string,number>,string]>} */
  const cases = [
    ['malformed list', 'list', { FAKE_CODEX_MALFORMED: 'thread/list' }, {}, 'CODEX_APP_SERVER_MALFORMED'],
    ['remote list error', 'list', { FAKE_CODEX_ERROR: 'thread/list', FAKE_CODEX_STDERR_TEXT: ' token=super-secret ', FAKE_CODEX_STDERR_BYTES: '2000' }, { maxStderrBytes: 256 }, 'CODEX_THREAD_LIST_FAILED'],
    ['unsupported list initialization', 'list', { FAKE_CODEX_ERROR: 'initialize' }, {}, 'CODEX_APP_SERVER_INITIALIZE_FAILED'],
    ['list timeout', 'list', { FAKE_CODEX_HANG: 'thread/list' }, { timeoutMs: 50 }, 'CODEX_APP_SERVER_TIMEOUT'],
    ['list disconnect', 'list', { FAKE_CODEX_DISCONNECT: 'thread/list' }, {}, 'CODEX_APP_SERVER_DISCONNECTED'],
    ['wrong read identity', 'read', { FAKE_CODEX_THREAD_JSON: JSON.stringify(childThread({ id: 'secret-child-id' })) }, {}, 'CODEX_CHILD_METADATA_INVALID'],
  ];
  for (const [name, operation, env, overrides, code] of cases) await t.test(name, async () => {
    const { options } = await appOptions(env, overrides);
    const promise = operation === 'list'
      ? listCodexThreadSpawnChildren('parent-1', options)
      : readCodexThreadSpawnChild('child-1', 'parent-1', options);
    await assert.rejects(promise, (/** @type {any} */ error) => {
      assert.equal(error.code, code); assert.doesNotMatch(String(error.stack), /super-secret|secret-child-id/);
      if (name === 'remote list error') { assert.doesNotMatch(error.details.stderrTail, /super-secret/); assert.match(error.details.stderrTail, /REDACTED/); }
      return true;
    });
  });
});

test('uses codex app-server and a 15 second deadline by default', async () => {
  /** @type {any} */ let observed;
  await assert.rejects(readCodexThread('thread-1', { spawn: (command, args, options) => { observed = { command, args, options }; throw Object.assign(new Error('missing'), { code: 'ENOENT' }); } }), { code: 'CODEX_APP_SERVER_SPAWN_FAILED' });
  assert.equal(observed.command, 'codex'); assert.deepEqual(observed.args, ['app-server']); assert.equal(observed.options.shell, false);
  assert.equal(CODEX_APP_SERVER_DEFAULT_TIMEOUT_MS, 15_000);
});

test('preserves raw read timeout, disconnect, and invalid-input diagnostics', async (t) => {
  await t.test('timeout', async () => {
    await assert.rejects(run({ FAKE_CODEX_HANG: 'thread/read' }, { timeoutMs: 25 }), (/** @type {any} */ error) => {
      assert.equal(error.code, 'CODEX_APP_SERVER_TIMEOUT');
      assert.equal(error.message, 'Codex app-server timed out while reading the source thread.');
      assert.equal(error.remedy, 'Retry after confirming Codex can read the requested thread.');
      return true;
    });
  });
  await t.test('disconnect', async () => {
    await assert.rejects(run({ FAKE_CODEX_DISCONNECT: 'thread/read' }), (/** @type {any} */ error) => {
      assert.equal(error.code, 'CODEX_APP_SERVER_DISCONNECTED');
      assert.equal(error.message, 'Codex app-server exited before returning the source thread.');
      assert.equal(error.remedy, 'Restart Codex and retry.');
      assert.deepEqual(error.details, { code: 1, signal: null, stderrTail: '' });
      return true;
    });
  });
  await t.test('invalid input', async () => {
    await assert.rejects(readCodexThread('', {}), (/** @type {any} */ error) => {
      assert.equal(error.code, 'CODEX_APP_SERVER_INPUT_INVALID');
      assert.equal(error.message, 'Codex app-server input is invalid.');
      assert.equal(error.remedy, 'Provide a bounded thread ID and positive protocol limits.');
      return true;
    });
  });
});

test('rejects cumulative app-server output beyond the configured total budget', async () => {
  await assert.rejects(run({ FAKE_CODEX_NOTIFICATION: '1', FAKE_CODEX_OTHER_ID: '1' }, { maxOutputBytes: 100 }), {
    code: 'CODEX_APP_SERVER_OUTPUT_TOO_LARGE',
  });
});

test('fake app-server persists lifecycle markers synchronously before exiting', async () => {
  const source = await readFile(fake, 'utf8');
  assert.match(source, /appendFileSync/);
  assert.match(source, /recordLifecycle/);
  assert.match(source, /setInterval/);
  assert.match(source, /clearInterval/);
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
    if (process.platform !== 'win32') {
      for (let index = 0; index < 50 && !(await readFile(record, 'utf8')).includes('lifecycle'); index += 1) await new Promise((resolve) => setTimeout(resolve, 5));
      assert.match(await readFile(record, 'utf8'), /"lifecycle":"SIGTERM"/);
    }
  });
});

test('bounds and redacts stderr diagnostics without blocking', async () => {
  await assert.rejects(run({ FAKE_CODEX_STDERR_BYTES: '20000', FAKE_CODEX_STDERR_TEXT: ' token=super-secret ', FAKE_CODEX_ERROR: 'thread/read' }, { maxStderrBytes: 256 }), (/** @type {any} */ error) => {
    assert.equal(error.code, 'CODEX_THREAD_READ_FAILED');
    assert.ok(error.details.stderrTail.length <= 256); assert.doesNotMatch(error.details.stderrTail, /super-secret/); assert.match(error.details.stderrTail, /REDACTED/); return true;
  });
});

test('deep expected responses fail as controlled protocol errors and terminate the real child', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-app-deep-response-')); const record = join(directory, 'record.jsonl'); await writeFile(record, '');
  await assert.rejects(readCodexThread('thread-1', { executable: process.execPath, args: [fake], env: { ...process.env, FAKE_CODEX_RECORD: record, FAKE_CODEX_DEEP_RESPONSE_DEPTH: '10000' }, timeoutMs: 1_000 }), { code: 'CODEX_APP_SERVER_MALFORMED' });
  if (process.platform !== 'win32') {
    for (let index = 0; index < 50 && !(await readFile(record, 'utf8')).includes('lifecycle'); index += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.match(await readFile(record, 'utf8'), /"lifecycle":"SIGTERM"/);
  }
});

test('deep unrelated notifications are ignored without preventing a valid response', async () => {
  const { value } = await run({ FAKE_CODEX_DEEP_NOTIFICATION_DEPTH: '10000' });
  assert.deepEqual(value, validThread);
});

test('rejects malformed options and unsafe thread identifiers before spawn', async () => {
  for (const threadId of ['', 'x'.repeat(513)]) await assert.rejects(readCodexThread(threadId, { spawn: () => { throw new Error('must not spawn'); } }), { code: 'CODEX_APP_SERVER_INPUT_INVALID' });
  await assert.rejects(readCodexThread('ok', { timeoutMs: 0 }), { code: 'CODEX_APP_SERVER_INPUT_INVALID' });
  await assert.rejects(readCodexThread('ok', { signal: /** @type {any} */ ({ aborted: false }) }), { code: 'CODEX_APP_SERVER_INPUT_INVALID' });
});

test('termination has a finite reap deadline when an injected child never emits exit', async () => {
  class NeverExitChild extends EventEmitter {
    constructor() { super(); this.stdin = new PassThrough(); this.stdout = new PassThrough(); this.stderr = new PassThrough(); this.exitCode = null; this.signalCode = null; this.signals = /** @type {string[]} */ ([]); }
    kill(/** @type {string} */ signal) { this.signals.push(signal); return true; }
  }
  const child = new NeverExitChild(); const started = Date.now();
  await Promise.race([
    assert.rejects(readCodexThread('thread-1', { spawn: () => child, timeoutMs: 5 }), { code: 'CODEX_APP_SERVER_TIMEOUT' }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('termination did not honor a finite reap deadline')), 2_500)),
  ]);
  assert.ok(Date.now() - started < 2_500); assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(child.listenerCount('exit'), 0); assert.equal(child.listenerCount('error'), 0);
  assert.equal(child.stdout.listenerCount('data'), 0); assert.equal(child.stderr.listenerCount('data'), 0);
});

test('keeps the evidence fixture aligned with the synthetic test identities', () => {
  assert.equal(evidenceFixture.codexVersion, '0.154.0');
  assert.equal(evidenceFixture.identities.parentThreadId, EVIDENCE_PARENT_ID);
  assert.equal(evidenceFixture.identities.childThreadId, EVIDENCE_CHILD_ID);
  assert.equal(evidenceFixture.identities.expectedTurnId, EVIDENCE_TURN_ID);
  assert.equal(evidenceFixture.thread.turns[0].id, EVIDENCE_TURN_ID);
  assert.equal(evidenceFixture.thread.turns[0].status, 'failed');
  assert.deepEqual(evidenceFixture.correlation.qualifyingTurnStatuses, ['completed', 'failed', 'interrupted']);
});

test('returns exact correlated terminal evidence for the incident-shaped failed child turn', async () => {
  const { options, record } = await appOptions({ FAKE_CODEX_THREAD_JSON: JSON.stringify(evidenceFixture.thread) });
  const proof = await readCodexRescueChildTurnEvidence(EVIDENCE_CHILD_ID, EVIDENCE_PARENT_ID, EVIDENCE_TURN_ID, options);
  assert.equal(proof.observedTurnId, EVIDENCE_TURN_ID);
  assert.equal(proof.terminalStatus, 'failed');
  assert.deepEqual(Object.keys(proof).sort(), ['child', 'observedTurnId', 'terminalStatus']);
  assert.deepEqual(proof.child, {
    id: EVIDENCE_CHILD_ID, parentThreadId: EVIDENCE_PARENT_ID,
    agentPath: '/root/zcode_rescue_task_evidence', agentRole: 'zcode-rescue',
    cwd: '/workspace/zcode-rescue-evidence', status: { type: 'notLoaded' },
    createdAt: 1789000000, updatedAt: 1789000600,
  });
  const serialized = JSON.stringify(proof);
  for (const marker of EVIDENCE_REDACTION_MARKERS) assert.equal(serialized.includes(marker), false, `evidence leaked ${marker}`);
  const calls = await recordedCalls(record);
  assert.deepEqual(calls.find((call) => call.method === 'thread/read').params, { threadId: EVIDENCE_CHILD_ID, includeTurns: true });
  assert.equal(calls.find((call) => call.method === 'initialize').params.capabilities, null);
});

test('qualifies completed and interrupted turns and every non-active thread status', async (t) => {
  for (const status of ['completed', 'interrupted']) await t.test(`terminal ${status} turn`, async () => {
    const thread = structuredClone(evidenceFixture.thread);
    thread.turns[0].status = status;
    if (status === 'interrupted') { thread.turns[0].startedAt = null; thread.turns[0].completedAt = null; thread.turns[0].items = []; }
    const { options } = await appOptions({ FAKE_CODEX_THREAD_JSON: JSON.stringify(thread) });
    const proof = await readCodexRescueChildTurnEvidence(EVIDENCE_CHILD_ID, EVIDENCE_PARENT_ID, EVIDENCE_TURN_ID, options);
    assert.equal(proof.observedTurnId, EVIDENCE_TURN_ID);
    assert.equal(proof.terminalStatus, status);
  });
  for (const threadStatus of ['notLoaded', 'idle', 'systemError']) await t.test(`non-active ${threadStatus} thread with terminal turn`, async () => {
    const thread = structuredClone(evidenceFixture.thread);
    thread.status = { type: threadStatus };
    const { options } = await appOptions({ FAKE_CODEX_THREAD_JSON: JSON.stringify(thread) });
    const proof = await readCodexRescueChildTurnEvidence(EVIDENCE_CHILD_ID, EVIDENCE_PARENT_ID, EVIDENCE_TURN_ID, options);
    assert.equal(proof.terminalStatus, 'failed');
    assert.deepEqual(proof.child.status, { type: threadStatus });
  });
});

test('rejects every uncorrelated or unprovable child evidence shape with unavailable evidence', async (t) => {
  const NEWER_TURN_ID = '00000000-0000-7000-8000-0000000000ff';
  /** @param {any} thread @param {string} [secret] */
  const rejectsUnavailable = async (thread, secret = '') => {
    const { options } = await appOptions({ FAKE_CODEX_THREAD_JSON: JSON.stringify(thread) });
    await assert.rejects(readCodexRescueChildTurnEvidence(EVIDENCE_CHILD_ID, EVIDENCE_PARENT_ID, EVIDENCE_TURN_ID, options), (/** @type {any} */ error) => {
      assert.equal(error.code, 'RESCUE_CHILD_EVIDENCE_UNAVAILABLE');
      if (secret) assert.doesNotMatch(String(error.stack), new RegExp(secret));
      return true;
    });
  };
  /** @type {Array<[string,(thread:any)=>void,string]>} */
  const cases = [
    ['top-level parent drift', (thread) => { thread.parentThreadId = 'unproven-parent-thread'; }, 'unproven-parent-thread'],
    ['provenance parent drift', (thread) => { thread.source.subAgent.thread_spawn.parent_thread_id = 'unproven-parent-thread'; }, 'unproven-parent-thread'],
    ['child identity drift', (thread) => { thread.id = 'unproven-child-thread'; }, 'unproven-child-thread'],
    ['agent path drift', (thread) => { thread.source.subAgent.thread_spawn.agent_path = '/root/../unproven-path'; }, 'unproven-path'],
    ['active thread', (thread) => { thread.status = { type: 'active', activeFlags: ['waitingOnUserInput'] }; }, ''],
    ['empty turns', (thread) => { thread.turns = []; }, ''],
    ['missing turns', (thread) => { delete thread.turns; }, ''],
    ['non-array turns', (thread) => { thread.turns = { id: EVIDENCE_TURN_ID }; }, ''],
    ['unknown thread status', (thread) => { thread.status = { type: 'secret-status' }; }, 'secret-status'],
    ['missing thread status', (thread) => { delete thread.status; }, ''],
    ['case-different latest turn status', (thread) => { thread.turns[0].status = 'Completed'; }, ''],
    ['unknown latest turn status', (thread) => { thread.turns[0].status = 'daydreaming'; }, 'daydreaming'],
    ['non-terminal latest turn', (thread) => { thread.turns[0].status = 'inProgress'; }, ''],
    ['duplicate turn identities', (thread) => { thread.turns = [thread.turns[0], { ...thread.turns[0], status: 'completed' }]; }, ''],
    ['newer turn than expected', (thread) => { thread.turns = [...thread.turns, { id: NEWER_TURN_ID, status: 'completed', items: [], itemsView: 'full', startedAt: 1789000700, completedAt: 1789000800, durationMs: 100 }]; }, '0000000000ff'],
    ['newest-first turn order', (thread) => { thread.turns = [{ id: NEWER_TURN_ID, status: 'completed', items: [], itemsView: 'full', startedAt: 1789000700, completedAt: 1789000800, durationMs: 100 }, thread.turns[0]]; }, '0000000000ff'],
    ['non-terminal turn below the latest', (thread) => { thread.turns = [{ id: '00000000-0000-7000-8000-00000000000ee', status: 'inProgress', items: [], itemsView: 'full', startedAt: 1788999900, completedAt: 1788999950, durationMs: 50 }, thread.turns[0]]; }, ''],
    ['malformed latest turn record', (thread) => { thread.turns[0].id = 42; }, ''],
  ];
  for (const [name, mutate, secret] of cases) await t.test(name, async () => {
    const thread = structuredClone(evidenceFixture.thread); mutate(thread);
    await rejectsUnavailable(thread, secret);
  });
});

test('correlates the expected turn as latest when multi-turn chronology proves oldest-first order', async () => {
  const thread = structuredClone(evidenceFixture.thread);
  thread.turns = [
    { id: '00000000-0000-7000-8000-0000000000aa', status: 'completed', items: [], itemsView: 'full', startedAt: 1788999900, completedAt: 1788999950, durationMs: 50 },
    thread.turns[0],
  ];
  const { options } = await appOptions({ FAKE_CODEX_THREAD_JSON: JSON.stringify(thread) });
  const proof = await readCodexRescueChildTurnEvidence(EVIDENCE_CHILD_ID, EVIDENCE_PARENT_ID, EVIDENCE_TURN_ID, options);
  assert.equal(proof.observedTurnId, EVIDENCE_TURN_ID);
  assert.equal(proof.terminalStatus, 'failed');
});

test('maps app-server response failures and timeouts to unavailable evidence with bounded diagnostics', async (t) => {
  /** @type {Array<[string,Record<string,string>,Record<string,unknown>,string,string]>} */
  const cases = [
    ['remote response error', { FAKE_CODEX_ERROR: 'thread/read' }, {}, 'CODEX_THREAD_READ_FAILED', 'do-not-copy'],
    ['truncated frame', { FAKE_CODEX_MALFORMED: 'thread/read' }, {}, 'CODEX_APP_SERVER_MALFORMED', ''],
    ['oversized frame', { FAKE_CODEX_OVERSIZE: 'thread/read', FAKE_CODEX_OVERSIZE_BYTES: '2048' }, { maxLineBytes: 256 }, 'CODEX_APP_SERVER_FRAME_TOO_LARGE', ''],
    ['deadline timeout', { FAKE_CODEX_HANG: 'thread/read' }, { timeoutMs: 50 }, 'CODEX_APP_SERVER_TIMEOUT', ''],
    ['disconnect', { FAKE_CODEX_DISCONNECT: 'thread/read' }, {}, 'CODEX_APP_SERVER_DISCONNECTED', ''],
    ['spawn failure', {}, { spawn: () => { throw Object.assign(new Error('missing codex'), { code: 'ENOENT' }); } }, 'CODEX_APP_SERVER_SPAWN_FAILED', 'missing codex'],
  ];
  for (const [name, env, overrides, causeCode, secret] of cases) await t.test(name, async () => {
    const { options } = await appOptions({ ...env, FAKE_CODEX_THREAD_JSON: JSON.stringify(evidenceFixture.thread) }, overrides);
    await assert.rejects(readCodexRescueChildTurnEvidence(EVIDENCE_CHILD_ID, EVIDENCE_PARENT_ID, EVIDENCE_TURN_ID, options), (/** @type {any} */ error) => {
      assert.equal(error.code, 'RESCUE_CHILD_EVIDENCE_UNAVAILABLE');
      assert.equal(error.cause?.code, causeCode);
      const serialized = `${error.message}${error.remedy}${JSON.stringify(error.details)}${String(error.stack)}${String(error.cause?.stack ?? '')}`;
      if (secret) assert.doesNotMatch(serialized, new RegExp(secret));
      return true;
    });
  });
  await t.test('stderr diagnostics stay bounded and redacted', async () => {
    const { options } = await appOptions(
      { FAKE_CODEX_ERROR: 'thread/read', FAKE_CODEX_STDERR_TEXT: ' token=super-secret ', FAKE_CODEX_STDERR_BYTES: '2000', FAKE_CODEX_THREAD_JSON: JSON.stringify(evidenceFixture.thread) }, { maxStderrBytes: 256 });
    await assert.rejects(readCodexRescueChildTurnEvidence(EVIDENCE_CHILD_ID, EVIDENCE_PARENT_ID, EVIDENCE_TURN_ID, options), (/** @type {any} */ error) => {
      assert.equal(error.code, 'RESCUE_CHILD_EVIDENCE_UNAVAILABLE');
      const tail = error.cause?.details?.stderrTail;
      assert.ok(tail.length <= 256); assert.doesNotMatch(tail, /super-secret/); assert.match(tail, /REDACTED/);
      return true;
    });
  });
  await t.test('thread/read result without a thread', async () => {
    const { options } = await appOptions({ FAKE_CODEX_OMIT_THREAD: '1', FAKE_CODEX_THREAD_JSON: JSON.stringify(evidenceFixture.thread) });
    await assert.rejects(readCodexRescueChildTurnEvidence(EVIDENCE_CHILD_ID, EVIDENCE_PARENT_ID, EVIDENCE_TURN_ID, options), (/** @type {any} */ error) => {
      assert.equal(error.code, 'RESCUE_CHILD_EVIDENCE_UNAVAILABLE');
      return true;
    });
  });
});

test('rescue evidence honors signal cancellation and validates identifiers before spawn', async (t) => {
  const interruption = () => new PluginError('JOB_INTERRUPTED', 'Recovery interrupted.', { category: 'interruption', remedy: 'Retry.' });
  await t.test('pre-aborted signal does not spawn', async () => {
    const controller = new AbortController(); const reason = interruption();
    controller.abort(reason); let spawned = false;
    await assert.rejects(readCodexRescueChildTurnEvidence(EVIDENCE_CHILD_ID, EVIDENCE_PARENT_ID, EVIDENCE_TURN_ID, {
      signal: controller.signal, spawn: () => { spawned = true; throw new Error('must not spawn'); },
    }), (error) => error === reason);
    assert.equal(spawned, false);
  });
  await t.test('mid-flight signal interruption stays a cancellation, not evidence', async () => {
    const controller = new AbortController(); const reason = interruption();
    const { options, record } = await appOptions({ FAKE_CODEX_HANG: 'thread/read', FAKE_CODEX_THREAD_JSON: JSON.stringify(evidenceFixture.thread) }, { timeoutMs: 15_000, signal: controller.signal });
    const promise = readCodexRescueChildTurnEvidence(EVIDENCE_CHILD_ID, EVIDENCE_PARENT_ID, EVIDENCE_TURN_ID, options);
    const deadline = Date.now() + 2_000;
    while (!(await recordedCalls(record)).some((call) => call.method === 'thread/read') && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort(reason);
    await assert.rejects(promise, (error) => error === reason);
  });
  await t.test('untrusted abort reason is replaced', async () => {
    const controller = new AbortController(); controller.abort('PRIVATE_ABORT_REASON');
    await assert.rejects(readCodexRescueChildTurnEvidence(EVIDENCE_CHILD_ID, EVIDENCE_PARENT_ID, EVIDENCE_TURN_ID, { signal: controller.signal }), (/** @type {any} */ error) => {
      assert.equal(error.code, 'JOB_INTERRUPTED');
      assert.doesNotMatch(`${error.message}${error.remedy}${error.stack}`, /PRIVATE_ABORT_REASON/);
      return true;
    });
  });
  await t.test('invalid identifiers are validation errors before spawn', async () => {
    const unspawnable = { spawn: () => { throw new Error('must not spawn'); } };
    for (const [childId, parentId, turnId] of [['', EVIDENCE_PARENT_ID, EVIDENCE_TURN_ID], [EVIDENCE_CHILD_ID, '', EVIDENCE_TURN_ID], [EVIDENCE_CHILD_ID, EVIDENCE_PARENT_ID, ''], [EVIDENCE_CHILD_ID, EVIDENCE_PARENT_ID, 'x'.repeat(513)]]) {
      await assert.rejects(readCodexRescueChildTurnEvidence(childId, parentId, turnId, unspawnable), { code: 'CODEX_APP_SERVER_INPUT_INVALID' });
    }
    await assert.rejects(readCodexRescueChildTurnEvidence('ok', 'ok', 'ok', { ...unspawnable, timeoutMs: 0 }), { code: 'CODEX_APP_SERVER_INPUT_INVALID' });
  });
});
