// @ts-nocheck
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import test from 'node:test';

import { createZCodeClient } from '../scripts/lib/zcode-client.mjs';
import { brokerEndpointFor, ensureZCodeBroker, ZCodeBroker } from '../scripts/zcode-broker.mjs';

const fixture = new URL('./fixtures/fake-zcode-cli.mjs', import.meta.url).pathname;

async function withClient(callback, env = {}, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-client-'));
  const record = join(directory, 'calls.jsonl');
  const client = await createZCodeClient({
    workspace: directory,
    launch: { command: process.execPath, args: [fixture], target: fixture },
    env: { ...process.env, FAKE_ZCODE_RECORD: record, ...env },
    requestTimeoutMs: 500,
    completionTimeoutMs: 500,
    ...options,
  });
  try { await callback(client, record); } finally { await client.close(); await rm(directory, { recursive: true, force: true }); }
}

test('typed operations use real 0.16.1 method and parameter shapes', async () => {
  await withClient(async (client, record) => {
    const model = { providerId: 'zai', modelId: 'glm-5', variant: 'fast' };
    const created = await client.createSession({ workspace: '/repo', model, importedHistory: { messages: [{ role: 'user', content: 'old', timestamp: 1 }, { role: 'assistant', content: 'answer' }] } });
    const sessionId = created.session.sessionId;
    await client.readSession(sessionId);
    await client.resumeSession(sessionId);
    await client.listSessions();
    await client.setModel(sessionId, model);
    await client.setThoughtLevel(sessionId, 'high', { model: { ...model, thoughtLevels: ['low', 'HIGH'] } });
    await client.stopSession(sessionId);
    const calls = (await readFile(record, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(calls[0].params.workspace, { workspacePath: '/repo', workspaceKey: '/repo' });
    assert.equal(calls[0].params.importedHistory.source, 'claudeCode');
    assert.deepEqual(calls.slice(0, 7).map((entry) => entry.method), ['session/create', 'session/read', 'session/resume', 'session/list', 'session/setModel', 'session/setThoughtLevel', 'session/stop']);
    assert.equal(calls[5].params.thoughtLevel, 'HIGH');
    assert.equal(calls[5].params.persistAsWorkspaceLastUsed, false);
  });
});

test('send waits only for matching-session completion and answers permission request', async () => {
  await withClient(async (client, record) => {
    const created = await client.createSession({ workspace: '/repo' });
    const sessionId = created.session.sessionId;
    const permissions = [];
    client.setPermissionHandler(async (request) => { permissions.push(request.toolName); return { decision: 'allow' }; });
    await client.send(sessionId, 'hello');
    await client.waitForCompletion(sessionId);
    assert.deepEqual(permissions, ['write']);
    const calls = (await readFile(record, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.ok(calls.some((entry) => entry.id === 9000 && entry.result?.decision === 'allow'));
  }, { FAKE_ZCODE_PERMISSION: '1' });
});

test('completion arms after send response and requires a newer revision', async () => {
  await withClient(async (client) => {
    const created = await client.createSession({ workspace: '/repo' });
    await client.send(created.session.sessionId, 'barrier');
    const completion = await client.waitForCompletion(created.session.sessionId);
    assert.equal(completion.revision, 1001);
  }, { FAKE_ZCODE_BARRIER: '1' });
});

test('completion in the same frame batch after response survives the arm barrier', async () => {
  await withClient(async (client) => { const created = await client.createSession({ workspace: '/repo' }); await client.send(created.session.sessionId, 'sync'); const completion = await client.waitForCompletion(created.session.sessionId); assert.equal(completion.revision, 2); }, { FAKE_ZCODE_SYNC_COMPLETE: '1' });
});

test('stale and valid completions in the same stdout write choose the valid revision', async () => {
  await withClient(async (client) => { const created = await client.createSession({ workspace: '/repo' }); await client.send(created.session.sessionId, 'sync'); const completion = await client.waitForCompletion(created.session.sessionId); assert.equal(completion.revision, 2); }, { FAKE_ZCODE_SYNC_BATCH: 'stale-valid' });
});

test('completion timeout and stop fully clean the turn and allow another send', async () => {
  await withClient(async (client) => {
    const { session: { sessionId } } = await client.createSession({ workspace: '/repo' });
    await client.send(sessionId, 'timeout'); await assert.rejects(client.waitForCompletion(sessionId, 20), { code: 'ZCODE_COMPLETION_TIMEOUT' });
    await client.send(sessionId, 'retry'); await client.waitForCompletion(sessionId);
    await client.send(sessionId, 'stop'); const waiter = client.waitForCompletion(sessionId, 2_000); await client.stopSession(sessionId); await assert.rejects(waiter, { code: 'ZCODE_SESSION_STOPPED' });
    for (const map of [client.protocol.turns, client.protocol.completed, client.protocol.earlyCompletions, client.protocol.completionExpiry]) assert.equal(map.size, 0);
    assert.equal(client.protocol.completionWaiters.size, 0); assert.equal(client.protocol.waiterSessions.size, 0);
  }, { FAKE_ZCODE_SUPPRESS_FIRST_COMPLETION: '1' });
});

test('permission response must be an offered option and replay is rejected', async () => {
  await withClient(async (client, record) => {
    const created = await client.createSession({ workspace: '/repo' });
    client.setPermissionHandler(async () => ({ decision: 'allow', reason: 'not offered' }));
    await client.send(created.session.sessionId, 'permission');
    await client.waitForCompletion(created.session.sessionId);
    const calls = (await readFile(record, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(calls.filter((entry) => entry.error).length, 2);
  }, { FAKE_ZCODE_PERMISSION: '1', FAKE_ZCODE_PERMISSION_REPLAY: '1' });
});

test('malformed permission option fails closed without invoking handler', async () => {
  await withClient(async (client, record) => {
    const created = await client.createSession({ workspace: '/repo' });
    let invoked = false; client.setPermissionHandler(async () => { invoked = true; return { decision: 'allow' }; });
    await client.send(created.session.sessionId, 'permission'); await client.waitForCompletion(created.session.sessionId);
    assert.equal(invoked, false);
    const calls = (await readFile(record, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.ok(calls.some((entry) => entry.error));
  }, { FAKE_ZCODE_PERMISSION: '1', FAKE_ZCODE_PERMISSION_MALFORMED: '1' });
});

test('cross-session completion cannot finish the requested session', async () => {
  await withClient(async (client) => {
    const created = await client.createSession({ workspace: '/repo' });
    const sessionId = created.session.sessionId;
    await client.send(sessionId, 'hello');
    await assert.rejects(client.waitForCompletion(sessionId), { code: 'ZCODE_COMPLETION_TIMEOUT' });
  }, { FAKE_ZCODE_CROSS_SESSION: 'other' }, { completionTimeoutMs: 30 });
});

test('disconnect rejects completion waiters immediately', async () => {
  await withClient(async (client) => {
    const created = await client.createSession({ workspace: '/repo' });
    await client.send(created.session.sessionId, 'wait');
    const waiting = client.waitForCompletion(created.session.sessionId, 2_000);
    await assert.rejects(client.listSessions(), { code: 'ZCODE_DISCONNECTED' });
    await assert.rejects(waiting, { code: 'ZCODE_DISCONNECTED' });
  }, { FAKE_ZCODE_DISCONNECT: 'session/list', FAKE_ZCODE_CROSS_SESSION: 'other' });
});

test('malformed, oversized, disconnect and request error fail closed', async (t) => {
  const cases = [
    [{ FAKE_ZCODE_MALFORMED: 'session/list' }, {}, 'ZCODE_PROTOCOL_MALFORMED'],
    [{ FAKE_ZCODE_OVERSIZE: 'session/list' }, { maxFrameBytes: 256 }, 'ZCODE_PROTOCOL_FRAME_TOO_LARGE'],
    [{ FAKE_ZCODE_DISCONNECT: 'session/list' }, {}, 'ZCODE_DISCONNECTED'],
    [{ FAKE_ZCODE_ERROR: 'session/list' }, {}, 'ZCODE_REQUEST_FAILED'],
  ];
  for (const [env, options, code] of cases) await t.test(code, () => withClient(async (client) => {
    await assert.rejects(client.listSessions(), { code });
  }, env, options));
});

test('thought level validates vocabulary and advertised values without guessing', async () => {
  await withClient(async (client) => {
    const created = await client.createSession({ workspace: '/repo' });
    const sessionId = created.session.sessionId;
    await assert.rejects(client.setThoughtLevel(sessionId, 'max'), { code: 'ZCODE_THOUGHT_LEVEL_INVALID' });
    await assert.rejects(client.setThoughtLevel(sessionId, 'medium'), { code: 'ZCODE_THOUGHT_LEVEL_UNSUPPORTED' });
    await client.setThoughtLevel(sessionId, 'LoW');
  });
});

test('setModel refreshes selected catalog before thought validation', async () => {
  await withClient(async (client, record) => {
    const created = await client.createSession({ workspace: '/repo' }); const sessionId = created.session.sessionId;
    await client.setModel(sessionId, { providerId: 'fake2', modelId: 'other' });
    await assert.rejects(client.setThoughtLevel(sessionId, 'low'), { code: 'ZCODE_THOUGHT_LEVEL_UNSUPPORTED' });
    await client.setThoughtLevel(sessionId, 'xhigh');
    const calls = (await readFile(record, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(calls.at(-1).params.thoughtLevel, 'XHIGH');
  });
});

test('public input validation rejects malformed imported history and extra fields', async () => {
  await withClient(async (client) => {
    await assert.rejects(client.createSession({ workspace: '/repo', importedHistory: { source: 'other', messages: [{ role: 'tool', content: 'x' }] } }), { code: 'ZCODE_INPUT_INVALID' });
    await assert.rejects(client.send('s', 'x', { secret: true }), { code: 'ZCODE_INPUT_INVALID' });
  });
});

test('typed operation results fail closed when their runtime shape is invalid', async () => {
  await withClient(async (client) => {
    await assert.rejects(client.listSessions(), { code: 'ZCODE_OUTPUT_INVALID' });
  }, { FAKE_ZCODE_BAD_RESULT: 'session/list' });
});

test('session/stop accepts only the real empty 0.16.1 result', async () => {
  await withClient(async (client) => { const created = await client.createSession({ workspace: '/repo' }); await assert.rejects(client.stopSession(created.session.sessionId), { code: 'ZCODE_OUTPUT_INVALID' }); }, { FAKE_ZCODE_BAD_STOP_EXTRA: '1' });
});

test('large child stderr is drained without blocking or contaminating protocol stdout', async () => {
  await withClient(async (client) => { const created = await client.createSession({ workspace: '/repo' }); assert.equal(created.session.sessionId, 'session-1'); }, { FAKE_ZCODE_STDERR_BYTES: String(2 * 1024 * 1024) });
});

test('actual 0.16.1 snapshot and list required fields are enforced', async (t) => {
  await t.test('snapshot workspace', () => withClient(async (client) => { await assert.rejects(client.createSession({ workspace: '/repo' }), { code: 'ZCODE_OUTPUT_INVALID' }); }, { FAKE_ZCODE_BAD_SNAPSHOT: 'missing-workspace' }));
  await t.test('message envelope', () => withClient(async (client) => { await assert.rejects(client.createSession({ workspace: '/repo' }), { code: 'ZCODE_OUTPUT_INVALID' }); }, { FAKE_ZCODE_BAD_SNAPSHOT: 'empty-message' }));
  await t.test('list session info', () => withClient(async (client) => { await client.createSession({ workspace: '/repo' }); await assert.rejects(client.listSessions(), { code: 'ZCODE_OUTPUT_INVALID' }); }, { FAKE_ZCODE_BAD_LIST: 'session-id-only' }));
});

test('broker endpoints are bounded and platform-safe', () => {
  const unix = brokerEndpointFor({ platform: 'darwin', dataRoot: `/tmp/${'a'.repeat(300)}`, workspace: '/repo' });
  const windows = brokerEndpointFor({ platform: 'win32', dataRoot: 'C:\\data', workspace: 'C:\\repo' });
  assert.ok(Buffer.byteLength(unix) < 104);
  assert.match(windows, /^\\\\\.\\pipe\\zcode-[a-f0-9]+$/);
});

test('typed client uses a local broker whose single CLI owner handles permissions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-'));
  const endpoint = brokerEndpointFor({ dataRoot: directory, workspace: directory });
  const brokerToken = 'a'.repeat(64);
  const broker = await new ZCodeBroker({ endpoint, brokerToken, workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture }, env: { ...process.env, FAKE_ZCODE_PERMISSION: '1' }, idleTimeoutMs: 10_000 }).start();
  await assert.rejects(createZCodeClient({ workspace: directory, brokerEndpoint: endpoint, brokerToken: 'b'.repeat(64), requestTimeoutMs: 500 }), { code: 'ZCODE_REQUEST_FAILED' });
  const client = await createZCodeClient({ workspace: directory, brokerEndpoint: endpoint, brokerToken, requestTimeoutMs: 500, completionTimeoutMs: 500 });
  try {
    const created = await client.createSession({ workspace: directory });
    client.setPermissionHandler(async () => ({ decision: 'allow' }));
    await client.send(created.session.sessionId, 'through broker');
    await client.waitForCompletion(created.session.sessionId);
  } finally {
    await client.close();
    await broker.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('broker consumes validated completion and permits repeated turns without retained state', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-consume-')); const endpoint = brokerEndpointFor({ dataRoot: directory, workspace: directory }); const brokerToken = '9'.repeat(64);
  const broker = await new ZCodeBroker({ endpoint, brokerToken, workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture }, env: { ...process.env, FAKE_ZCODE_SYNC_BATCH: 'stale-valid' }, idleTimeoutMs: 25 }).start();
  const client = await createZCodeClient({ workspace: directory, brokerEndpoint: endpoint, brokerToken, completionTimeoutMs: 500 });
  try { const { session: { sessionId } } = await client.createSession({ workspace: directory }); for (let i = 0; i < 2; i += 1) { await client.send(sessionId, String(i)); await client.waitForCompletion(sessionId); assert.equal(broker.activeSessions.size, 0); for (const map of [broker.protocol.turns, broker.protocol.completed, broker.protocol.earlyCompletions, broker.protocol.completionExpiry]) assert.equal(map.size, 0); } }
  finally { await client.close(); await broker.close(); await rm(directory, { recursive: true, force: true }); }
});

test('completed broker becomes truly idle after its final owner disconnects', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-idle-')); const endpoint = brokerEndpointFor({ dataRoot: directory, workspace: directory }); const brokerToken = '7'.repeat(64);
  const broker = await new ZCodeBroker({ endpoint, brokerToken, workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture }, idleTimeoutMs: 20 }).start(); const client = await createZCodeClient({ workspace: directory, brokerEndpoint: endpoint, brokerToken });
  try { const { session: { sessionId } } = await client.createSession({ workspace: directory }); await client.send(sessionId, 'finish'); await client.waitForCompletion(sessionId); await client.close(); for (let index = 0; index < 100 && (broker.server || broker.protocol); index += 1) await new Promise((resolve) => setTimeout(resolve, 5)); assert.equal(broker.server, null); assert.equal(broker.protocol, null); assert.equal(broker.activeSessions.size, 0); }
  finally { await client.close(); await broker.close(); await rm(directory, { recursive: true, force: true }); }
});

test('concurrent lazy broker acquisition publishes one healthy pid and identity', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-ensure-'));
  try {
    const options = { dataRoot: directory, workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture }, idleTimeoutMs: 100 };
    const identities = await Promise.all([ensureZCodeBroker(options), ensureZCodeBroker(options)]);
    assert.equal(identities[0].pid, identities[1].pid);
    assert.equal(identities[0].instanceId, identities[1].instanceId);
    const client = await createZCodeClient({ workspace: directory, brokerEndpoint: identities[0].endpoint, brokerToken: identities[0].brokerToken });
    await client.close();
    try { process.kill(identities[0].pid, 'SIGTERM'); } catch { /* idle shutdown won */ }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('broker allows explicit imported create and atomically assigns resume ownership', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-owner-'));
  const endpoint = brokerEndpointFor({ dataRoot: directory, workspace: directory });
  const brokerToken = 'c'.repeat(64);
  const broker = await new ZCodeBroker({ endpoint, brokerToken, workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } }).start();
  const first = await createZCodeClient({ workspace: directory, brokerEndpoint: endpoint, brokerToken });
  const second = await createZCodeClient({ workspace: directory, brokerEndpoint: endpoint, brokerToken });
  try {
    const explicit = await first.createSession({ workspace: directory, sessionId: 'imported-session', importedHistory: { messages: [{ role: 'user', content: 'history' }] } });
    assert.equal(explicit.session.sessionId, 'imported-session');
    const results = await Promise.allSettled([first.resumeSession('race-session'), second.resumeSession('race-session')]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  } finally { await first.close(); await second.close(); await broker.close(); await rm(directory, { recursive: true, force: true }); }
});

test('unauthenticated broker socket receives no notifications and owns no session', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-unauth-')); const endpoint = brokerEndpointFor({ dataRoot: directory, workspace: directory }); const brokerToken = 'd'.repeat(64);
  const broker = await new ZCodeBroker({ endpoint, brokerToken, workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } }).start();
  const attacker = net.createConnection(endpoint); await new Promise((resolve) => attacker.once('connect', resolve)); let received = '';
  attacker.on('data', (chunk) => { received += chunk; });
  const client = await createZCodeClient({ workspace: directory, brokerEndpoint: endpoint, brokerToken });
  try { const created = await client.createSession({ workspace: directory }); await client.send(created.session.sessionId, 'private'); await client.waitForCompletion(created.session.sessionId); await new Promise((resolve) => setTimeout(resolve, 20)); assert.equal(received, ''); }
  finally { attacker.destroy(); await client.close(); await broker.close(); await rm(directory, { recursive: true, force: true }); }
});

test('stable owner credential prevents sibling reclaim after disconnect', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-owner-id-')); const endpoint = brokerEndpointFor({ dataRoot: directory, workspace: directory }); const brokerToken = 'e'.repeat(64); const broker = await new ZCodeBroker({ endpoint, brokerToken, workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } }).start();
  const ownerId = 'owner-session-credential-1'; const owner = await createZCodeClient({ workspace: directory, brokerEndpoint: endpoint, brokerToken, ownerId });
  await owner.createSession({ workspace: directory, sessionId: 'durable-session', importedHistory: { messages: [{ role: 'user', content: 'x' }] } }); await owner.close();
  const sibling = await createZCodeClient({ workspace: directory, brokerEndpoint: endpoint, brokerToken, ownerId: 'sibling-credential-2' });
  await assert.rejects(sibling.resumeSession('durable-session'), { code: 'ZCODE_REQUEST_FAILED' }); await sibling.close();
  const resumed = await createZCodeClient({ workspace: directory, brokerEndpoint: endpoint, brokerToken, ownerId }); await resumed.resumeSession('durable-session'); await resumed.close(); await broker.close(); await rm(directory, { recursive: true, force: true });
});

test('late same-owner claim failure cannot erase a newer successful claim', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-owner-aba-')); const endpoint = brokerEndpointFor({ dataRoot: directory, workspace: directory }); const brokerToken = '8'.repeat(64); const ownerId = 'owner-credential-aba';
  const broker = await new ZCodeBroker({ endpoint, brokerToken, workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture }, env: { ...process.env, FAKE_ZCODE_RESUME_ABA: '1' } }).start();
  const first = await createZCodeClient({ workspace: directory, brokerEndpoint: endpoint, brokerToken, ownerId }); const second = await createZCodeClient({ workspace: directory, brokerEndpoint: endpoint, brokerToken, ownerId });
  try { const results = await Promise.allSettled([first.resumeSession('aba-session'), second.resumeSession('aba-session')]); assert.deepEqual(results.map((result) => result.status).sort(), ['fulfilled', 'rejected']); const sibling = await createZCodeClient({ workspace: directory, brokerEndpoint: endpoint, brokerToken, ownerId: 'sibling-credential-aba' }); try { await assert.rejects(sibling.resumeSession('aba-session'), { code: 'ZCODE_REQUEST_FAILED' }); } finally { await sibling.close(); } }
  finally { await first.close(); await second.close(); await broker.close(); await rm(directory, { recursive: true, force: true }); }
});

test('launch target is revalidated before spawning', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-missing-'));
  const target = join(directory, 'gone.mjs');
  await writeFile(target, '');
  await rm(target);
  await assert.rejects(createZCodeClient({ workspace: directory, launch: { command: process.execPath, args: [target], target } }), { code: 'ZCODE_LAUNCH_TARGET_MISSING' });
  await rm(directory, { recursive: true, force: true });
});
