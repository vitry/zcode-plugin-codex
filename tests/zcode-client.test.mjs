// @ts-nocheck
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import test from 'node:test';

import { createExistingManagedZCodeClient, createManagedZCodeClient, createZCodeClient, ZCodeClient } from '../scripts/lib/zcode-client.mjs';
import { brokerEndpointFor, brokerIdentityNameForWireOptions, ensureZCodeBroker, reconcileBrokerOwnership, writeBrokerIdentity, ZCodeBroker as ZCodeBrokerClass } from '../scripts/zcode-broker.mjs';
import { atomicWriteJson, withFileLock } from '../scripts/lib/fs.mjs';
import { PluginError } from '../scripts/lib/errors.mjs';
import { resolveWorkspaceStorage } from '../scripts/lib/workspace.mjs';

const fixture = fileURLToPath(new URL('./fixtures/fake-zcode-cli.mjs', import.meta.url));

test('conversation subscription uses the exact v4 contract and unsubscribes once', async () => {
  const calls = [];
  const protocol = {
    request: async (method, params) => {
      calls.push({ method, params });
      if (method === 'v4/conversation/subscribe') return { ack: { subscriptionId: 'sub-1', mode: 'snapshot', logEpoch: 'epoch-7' } };
      if (method === 'v4/conversation/unsubscribe') return {};
      throw new Error(`unexpected ${method}`);
    },
  };
  const client = new ZCodeClient(protocol);
  const subscription = await client.subscribeConversation('session-1', { connectionId: 'companion-1', clientMode: 'desktop-continuous' });
  assert.equal(subscription.subscriptionId, 'sub-1');
  assert.deepEqual(calls[0], { method: 'v4/conversation/subscribe', params: { topic: 'conversation/session-1', connectionId: 'companion-1', clientMode: 'desktop-continuous' } });
  await subscription.unsubscribe();
  await subscription.unsubscribe();
  assert.deepEqual(calls[1], { method: 'v4/conversation/unsubscribe', params: { topic: 'conversation/session-1', subscriptionId: 'sub-1', connectionId: 'companion-1' } });
  assert.equal(calls.length, 2);
});

test('conversation subscription validates options and the exact ack', async () => {
  const protocol = { request: async () => ({ ack: { subscriptionId: 'sub-1', mode: 'replay', logEpoch: 'epoch-7' } }) };
  const client = new ZCodeClient(protocol);
  await assert.rejects(client.subscribeConversation('session-1', { connectionId: 'companion-1', clientMode: 'desktop-continuous' }), { code: 'ZCODE_OUTPUT_INVALID' });
  await assert.rejects(client.subscribeConversation('session-1', { connectionId: 'x'.repeat(257), clientMode: 'desktop-continuous' }), { code: 'ZCODE_INPUT_INVALID' });
  await assert.rejects(client.subscribeConversation('session-1', { connectionId: 'companion-1', clientMode: 'unsupported' }), { code: 'ZCODE_INPUT_INVALID' });
});

test('conversation subscription accepts only the captured exact result and ack keys', async () => {
  const valid = { ack: { subscriptionId: 'sub-1', mode: 'resume', logEpoch: 'epoch-7' } };
  const resumed = await new ZCodeClient({ request: async () => structuredClone(valid) }).subscribeConversation('session-1', { connectionId: 'companion-1', clientMode: 'desktop-continuous' });
  assert.equal(resumed.subscriptionId, 'sub-1');
  const invalid = [
    {},
    { ...valid, topic: 'conversation/session-1' },
    { ack: { mode: 'snapshot', logEpoch: 'epoch-7' } },
    { ack: { ...valid.ack, topic: 'conversation/session-1' } },
    { ack: { ...valid.ack, subscriptionId: 7 } },
    { ack: { ...valid.ack, subscriptionId: 'sub\u0000secret' } },
    { ack: { ...valid.ack, mode: 'replay' } },
    { ack: { ...valid.ack, logEpoch: '' } },
  ];
  for (const result of invalid) {
    const client = new ZCodeClient({ request: async () => result });
    await assert.rejects(client.subscribeConversation('session-1', { connectionId: 'companion-1', clientMode: 'desktop-continuous' }), { code: 'ZCODE_OUTPUT_INVALID' });
  }
});

test('conversation unsubscribe rejects a non-empty acknowledgement', async () => {
  const client = new ZCodeClient({ request: async (method) => method.endsWith('/subscribe') ? { ack: { subscriptionId: 'sub-1', mode: 'snapshot', logEpoch: 'epoch-1' } } : { unexpected: true } });
  const subscription = await client.subscribeConversation('session-1', { connectionId: 'companion-1', clientMode: 'desktop-continuous' });
  await assert.rejects(subscription.unsubscribe(), { code: 'ZCODE_OUTPUT_INVALID' });
});

function processAlive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
async function waitForProcessExit(pid, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (processAlive(pid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  if (processAlive(pid)) assert.fail(`broker process ${pid} did not exit within ${timeoutMs}ms`);
}

function newTestBroker(options) {
  const ownershipPath = options.ownershipPath ?? (typeof options.endpoint === 'string' && options.endpoint.startsWith('\\\\.\\pipe\\') ? join(options.workspace, '.test-session-owners.json') : undefined);
  return new ZCodeBrokerClass({ ...options, ...(ownershipPath === undefined ? {} : { ownershipPath }) });
}

function brokerCreateSnapshot(sessionId, workspacePath = '/repo') {
  workspacePath = realpathSync(resolve(workspacePath));
  const model = { providerId: 'fake', modelId: 'model' };
  return {
    protocol: { name: 'ZCode Protocol', version: 1 },
    session: { sessionId, workspace: { workspacePath, workspaceKey: workspacePath }, sessionKind: 'interactive', title: 'Broker test session', mode: 'build', status: 'idle', model, createdAt: 1, updatedAt: 1 },
    settings: { model: { current: model, available: [] }, thoughtLevel: { enabled: true, available: [] }, mode: { current: 'build' } },
    projection: { sessionId, status: 'idle', mode: 'build', turnCount: 0, totalTokenCount: 0, contextUsed: 0, contextWindow: 1, pendingPermissions: [], activeToolCalls: [], backgroundJobs: [] },
    runtime: { eventSeq: 0, stateRevision: 0, pendingRequestIds: [] },
    messages: [],
  };
}

function brokerCreateParams(workspacePath, sessionId) {
  workspacePath = realpathSync(resolve(workspacePath));
  return { workspace: { workspacePath, workspaceKey: workspacePath }, ...(sessionId === undefined ? {} : { sessionId }) };
}

async function createPersistedTestBroker({ dataRoot, workspace, tokenByte, instanceByte, record, ...wireOptions }) {
  const storage = await resolveWorkspaceStorage({ dataRoot, workspace });
  const identityName = brokerIdentityNameForWireOptions(wireOptions);
  const profile = identityName === 'identity.json' ? undefined : identityName.slice('identity-'.length, -'.json'.length);
  const endpoint = brokerEndpointFor({ dataRoot, workspace: storage.workspacePath, ...(profile ? { identity: profile } : {}) });
  const brokerToken = tokenByte.repeat(64);
  const instanceId = instanceByte.repeat(48);
  const broker = await newTestBroker({ endpoint, brokerToken, instanceId, workspace: storage.workspacePath, launch: { command: process.execPath, args: [fixture], target: fixture }, env: { ...process.env, ...(record ? { FAKE_ZCODE_RECORD: record } : {}) }, ...wireOptions }).start();
  await writeBrokerIdentity(join(storage.directory, 'broker', identityName), { endpoint, pid: process.pid, instanceId, brokerToken });
  return broker;
}

async function createHealthOnlyServer(endpoint, { brokerToken, instanceId, hangHealth = false, closeAfterHealth = false }) {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket); socket.setEncoding('utf8'); let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk; let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const frame = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1); newline = buffer.indexOf('\n');
        if (frame.method === 'broker/auth' && frame.params?.token === brokerToken) socket.write(`${JSON.stringify({ id: frame.id, result: { authenticated: true } })}\n`);
        else if (frame.method === 'broker/health' && !hangHealth) {
          socket.write(`${JSON.stringify({ id: frame.id, result: { ok: true, pid: process.pid, instanceId } })}\n`);
          if (closeAfterHealth) server.close();
        }
      }
    });
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise((resolvePromise, reject) => { server.once('error', reject); server.listen(endpoint, resolvePromise); });
  return async () => { for (const socket of sockets) socket.destroy(); if (server.listening) await new Promise((resolvePromise) => server.close(resolvePromise)); };
}

async function readRecordedCalls(record) {
  let content;
  try { content = await readFile(record, 'utf8'); } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  return content.split('\n').flatMap((line) => {
    if (!line.trim()) return [];
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

async function waitForRecordedCalls(record, predicate, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  let calls = [];
  while (true) {
    calls = await readRecordedCalls(record);
    if (predicate(calls) || Date.now() >= deadline) return calls;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, Math.min(5, deadline - Date.now())));
  }
}

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
    const read = await client.readSession(sessionId);
    const resumed = await client.resumeSession(sessionId);
    const listed = await client.listSessions();
    const modeled = await client.setModel(sessionId, model);
    await client.setThoughtLevel(sessionId, 'high', { model: { ...model, thoughtLevels: ['low', 'HIGH'] } });
    await client.stopSession(sessionId);
    const calls = (await readFile(record, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(calls[0].params.workspace, { workspacePath: resolve('/repo'), workspaceKey: resolve('/repo') });
    assert.equal(calls[0].params.importedHistory.source, 'claudeCode');
    assert.deepEqual(calls.slice(0, 7).map((entry) => entry.method), ['session/create', 'session/read', 'session/resume', 'session/list', 'session/setModel', 'session/setThoughtLevel', 'session/stop']);
    assert.equal(calls[5].params.thoughtLevel, 'HIGH');
    assert.equal(calls[5].params.persistAsWorkspaceLastUsed, false);
    for (const result of [created, read, resumed, modeled]) { assert.deepEqual(result.protocol, { name: 'ZCode Protocol', version: 1 }); assert.equal(result.session.sessionKind, 'interactive'); assert.equal(result.settings.model.available[0].label, 'Fixture model'); assert.deepEqual(result.messages[0].info.model, model); assert.equal(result.goalStats.tokensUsed, 0); assert.equal(result.todos[0].priority, 'high'); assert.equal(result.todoGroups[0].source, 'session'); assert.equal(result.slashCommands[0].source, 'builtin'); }
    assert.equal(listed.sessions[0].sessionKind, 'interactive');
  });
});

test('session/create answers runtime preference requests with the exact string ID', async () => {
  await withClient(async (client, record) => {
    const created = await client.createSession({ workspace: '/repo' });
    assert.equal(created.session.sessionId, 'session-1');
    const calls = await readRecordedCalls(record);
    const response = calls.find((entry) => entry.id === 'server-1' && !entry.method);
    assert.deepEqual(response, { id: 'server-1', error: { code: -32601, message: 'Unsupported server request.' } });
  }, { FAKE_ZCODE_RUNTIME_PREFERENCES_ID: 'server-1' });
});

test('session/create rejects unsafe string server request IDs', async (t) => {
  const cases = [
    ['empty', ''],
    ['oversized', 'x'.repeat(513)],
    ['C0 control', 'server\u001b[31m'],
    ['C1 U+0085 control', 'server\u0085'],
    ['C1 U+009B control', 'server\u009b'],
    ['C1 U+009F control', 'server\u009f'],
  ];
  for (const [name, serverRequestId] of cases) {
    await t.test(name, () => withClient(async (client) => {
      await assert.rejects(client.createSession({ workspace: '/repo' }), { code: 'ZCODE_PROTOCOL_MALFORMED' });
    }, { FAKE_ZCODE_RUNTIME_PREFERENCES_ID: serverRequestId }));
  }
});

test('send waits only for matching-session completion and answers permission request', async () => {
  await withClient(async (client, record) => {
    const created = await client.createSession({ workspace: '/repo' });
    const sessionId = created.session.sessionId;
    const permissions = [];
    client.setPermissionHandler(async (request) => { permissions.push(request.toolName); return { decision: 'allow' }; });
    const sent = await client.send(sessionId, 'hello');
    assert.match(sent.inputId, /^[0-9a-f-]{36}$/); assert.equal(sent.stateRevision, 1);
    await client.waitForCompletion(sessionId);
    assert.deepEqual(permissions, ['write']);
    const calls = await waitForRecordedCalls(record, (entries) => entries.some((entry) => entry.id === 9000 && entry.result?.decision === 'allow'));
    const permissionResponse = calls.find((entry) => entry.id === 9000 && entry.result?.decision === 'allow');
    assert.ok(permissionResponse);
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
    await client.send(sessionId, 'stop'); const waiter = client.waitForCompletion(sessionId, 2_000); await new Promise((resolve) => setTimeout(resolve, 20)); await client.stopSession(sessionId); await assert.rejects(waiter, { code: 'ZCODE_SESSION_STOPPED' });
    assert.equal(client.turnState(sessionId), null);
    for (const map of [client.protocol.turns, client.protocol.completed, client.protocol.earlyCompletions, client.protocol.completionExpiry]) assert.equal(map.size, 0);
    assert.equal(client.protocol.completionWaiters.size, 0); assert.equal(client.protocol.waiterSessions.size, 0);
  }, { FAKE_ZCODE_SUPPRESS_FIRST_COMPLETION: '1', FAKE_ZCODE_SUPPRESS_COMPLETION_AT: '3' });
});

test('turn state proves an accepted send is active until acknowledged stop clears it', async () => {
  await withClient(async (client) => {
    const { session: { sessionId } } = await client.createSession({ workspace: '/repo' });
    await client.send(sessionId, 'active');
    assert.equal(client.turnState(sessionId), 'armed');
    await assert.rejects(client.send(sessionId, 'must reject while active'), { code: 'ZCODE_TURN_ACTIVE' });
    assert.deepEqual(await client.stopSession(sessionId), {});
    assert.equal(client.turnState(sessionId), null);
    await assert.rejects(client.waitForCompletion(sessionId, 20), { code: 'ZCODE_PROTOCOL_INPUT_INVALID' });
  }, { FAKE_ZCODE_SUPPRESS_COMPLETION_AT: '1' });
});

test('stop aborts an observed remote permission barrier for the active turn', { timeout: 2_000 }, async () => {
  await withClient(async (client) => {
    const { session: { sessionId } } = await client.createSession({ workspace: '/repo' });
    let reached; const permissionReached = new Promise((resolve) => { reached = resolve; });
    let aborted; const permissionAborted = new Promise((resolve) => { aborted = resolve; });
    client.setPermissionHandler((request, signal) => {
      reached(request.requestId);
      return new Promise((resolve, reject) => signal.addEventListener('abort', () => { aborted(); reject(new Error('turn stopped')); }, { once: true }));
    });
    await client.send(sessionId, 'request permission');
    assert.match(await permissionReached, /^permission-/);
    assert.equal(client.turnState(sessionId), 'armed');
    assert.deepEqual(await client.stopSession(sessionId), {});
    await permissionAborted;
    assert.equal(client.turnState(sessionId), null);
  }, { FAKE_ZCODE_PERMISSION: '1', FAKE_ZCODE_SUPPRESS_COMPLETION_AT: '1' });
});

test('stopping after completion does not change the already resolved completion result', async () => {
  await withClient(async (client) => {
    const { session: { sessionId } } = await client.createSession({ workspace: '/repo' });
    await client.send(sessionId, 'complete first');
    const completion = await client.waitForCompletion(sessionId);
    await client.stopSession(sessionId);
    assert.equal(completion.reason, 'prompt_completed');
    assert.equal(completion.sessionId, sessionId);
  });
});

test('permission response must be an offered option and replay is rejected', async () => {
  await withClient(async (client, record) => {
    const created = await client.createSession({ workspace: '/repo' });
    client.setPermissionHandler(async () => ({ decision: 'allow', reason: 'not offered' }));
    await client.send(created.session.sessionId, 'permission');
    await client.waitForCompletion(created.session.sessionId);
    const calls = await waitForRecordedCalls(record, (entries) => entries.filter((entry) => entry.error).length >= 2);
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

test('request failures retain only a bounded safe remote error code', async (t) => {
  await t.test('safe discriminator', () => withClient(async (client) => {
    await assert.rejects(client.listSessions(), (error) => {
      assert.equal(error.code, 'ZCODE_REQUEST_FAILED');
      assert.deepEqual(error.details, { method: 'session/list', rpcCode: -32099, remoteCode: 'model_config_missing' });
      assert.doesNotMatch(JSON.stringify(error.details), /remote-api-key-must-not-leak/);
      return true;
    });
  }, {
    FAKE_ZCODE_ERROR: 'session/list',
    FAKE_ZCODE_ERROR_DATA_CODE: 'model_config_missing',
    FAKE_ZCODE_ERROR_DATA_SECRET: 'remote-api-key-must-not-leak',
  }, { requestTimeoutMs: 2_000, completionTimeoutMs: 2_000 }));

  for (const [name, remoteCode] of [
    ['oversized', 'x'.repeat(129)],
    ['C0 control', 'model\u001bconfig'],
    ['C1 control', 'model\u0085config'],
  ]) {
    await t.test(name, () => withClient(async (client) => {
      await assert.rejects(client.listSessions(), (error) => {
        assert.equal(error.code, 'ZCODE_REQUEST_FAILED');
        assert.deepEqual(error.details, { method: 'session/list', rpcCode: -32099 });
        return true;
      });
    }, { FAKE_ZCODE_ERROR: 'session/list', FAKE_ZCODE_ERROR_DATA_CODE: remoteCode }, { requestTimeoutMs: 2_000, completionTimeoutMs: 2_000 }));
  }
});

test('RPC errors with missing or non-integer codes fail closed without leaking code contents', async (t) => {
  const cases = [
    ['missing', { FAKE_ZCODE_ERROR_OMIT_CODE: '1' }],
    ['string', { FAKE_ZCODE_ERROR_CODE_JSON: JSON.stringify('-32099') }],
    ['object', { FAKE_ZCODE_ERROR_CODE_JSON: JSON.stringify({ value: -32099 }) }],
    ['secret-bearing object', { FAKE_ZCODE_ERROR_CODE_JSON: JSON.stringify({ apiKey: 'rpc-code-secret-must-not-leak' }) }],
  ];
  for (const [name, env] of cases) {
    await t.test(name, () => withClient(async (client) => {
      await assert.rejects(client.listSessions(), (error) => {
        assert.equal(error.code, 'ZCODE_PROTOCOL_MALFORMED');
        assert.deepEqual(error.details, {});
        assert.doesNotMatch(JSON.stringify(error), /rpc-code-secret-must-not-leak/);
        return true;
      });
    }, { FAKE_ZCODE_ERROR: 'session/list', ...env }));
  }
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

test('applied model and thought responses must exactly match before send', async () => {
  for (const returned of [
    { providerId: 'fake', modelId: 'other' },
    { providerId: 'fake2', modelId: 'model' },
    { providerId: 'fake2', modelId: 'other', variant: 'unexpected' },
  ]) await withClient(async (client, record) => {
    const { session: { sessionId } } = await client.createSession({ workspace: '/repo' });
    await assert.rejects(client.setModel(sessionId, { providerId: 'fake2', modelId: 'other' }), { code: 'ZCODE_MODEL_APPLY_MISMATCH' });
    assert.ok(!(await readFile(record, 'utf8')).includes('session/send'));
  }, { FAKE_ZCODE_SET_MODEL_CURRENT: JSON.stringify(returned) });
  await withClient(async (client) => {
    const { session: { sessionId } } = await client.createSession({ workspace: '/repo' });
    await assert.rejects(client.setModel(sessionId, { providerId: 'fake2', modelId: 'other' }), { code: 'ZCODE_MODEL_APPLY_MISMATCH' });
  }, { FAKE_ZCODE_SET_MODEL_CURRENT: JSON.stringify({ providerId: 'fake2', modelId: 'other', extra: true }) });

  await withClient(async (client, record) => {
    const { session: { sessionId } } = await client.createSession({ workspace: '/repo' });
    await assert.rejects(client.setThoughtLevel(sessionId, 'high'), { code: 'ZCODE_THOUGHT_LEVEL_APPLY_MISMATCH' });
    assert.ok(!(await readFile(record, 'utf8')).includes('session/send'));
  }, { FAKE_ZCODE_SET_THOUGHT_CURRENT: 'low' });

  await withClient(async (client) => {
    const { session: { sessionId } } = await client.createSession({ workspace: '/repo' });
    await client.setModel(sessionId, { providerId: 'fake2', modelId: 'other' });
    await client.setThoughtLevel(sessionId, 'XHIGH');
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

test('session/stop accepts additive result fields from newer compatible versions', async () => {
  await withClient(async (client) => { const created = await client.createSession({ workspace: '/repo' }); assert.deepEqual(await client.stopSession(created.session.sessionId), { stopped: true }); }, { FAKE_ZCODE_BAD_STOP_EXTRA: '1' });
});

test('large child stderr is drained without blocking or contaminating protocol stdout', async () => {
  await withClient(async (client) => { const created = await client.createSession({ workspace: '/repo' }); assert.equal(created.session.sessionId, 'session-1'); }, { FAKE_ZCODE_STDERR_BYTES: String(2 * 1024 * 1024) });
});

test('session/create rejects unsafe or amplified session identifiers at the ZCode response boundary', async () => {
  for (const sessionId of ['line-one\nline-two', '\u001b[31mspoof', 'x'.repeat(513)]) {
    await withClient(async (client) => { await assert.rejects(client.createSession({ workspace: '/repo' }), { code: 'ZCODE_OUTPUT_INVALID' }); }, { FAKE_ZCODE_SESSION_ID: sessionId });
  }
});

test('disconnect diagnostics retain only a bounded redacted stderr tail', async () => {
  await withClient(async (client) => { await client.createSession({ workspace: '/repo' }); await assert.rejects(client.listSessions(), (error) => error.code === 'ZCODE_DISCONNECTED' && error.details.stderrTail.length <= 8192 && !error.details.stderrTail.includes('super-secret') && error.details.stderrTail.includes('[REDACTED]')); }, { FAKE_ZCODE_STDERR_BYTES: '20000', FAKE_ZCODE_STDERR_TEXT: ' token=super-secret ', FAKE_ZCODE_DISCONNECT: 'session/list' }, { requestTimeoutMs: 2_000 });
});

test('managed broker clients require an explicit stable owner credential', async () => {
  await assert.rejects(createManagedZCodeClient({ dataRoot: '/tmp/data', workspace: '/tmp/workspace', launch: { command: process.execPath, args: [] } }), { code: 'ZCODE_INPUT_INVALID' });
  for (const maxOutboundBytes of [0, 64 * 1024 * 1024 + 1]) await assert.rejects(createManagedZCodeClient({ dataRoot: '/tmp/data', workspace: '/tmp/workspace', launch: { command: process.execPath, args: [] }, ownerId: 'bounded-wire-owner', maxOutboundBytes }), { code: 'ZCODE_INPUT_INVALID' });
  for (const drainTimeoutMs of [0, 30_001]) await assert.rejects(createManagedZCodeClient({ dataRoot: '/tmp/data', workspace: '/tmp/workspace', launch: { command: process.execPath, args: [] }, ownerId: 'bounded-drain-owner', drainTimeoutMs }), { code: 'ZCODE_INPUT_INVALID' });
});

test('existing managed client connects to the exact healthy wire profile without ensuring a broker', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-existing-exact-'));
  const exactWire = { maxFrameBytes: 16 * 1024 * 1024, maxOutboundBytes: 16 * 1024 * 1024 };
  assert.equal(brokerIdentityNameForWireOptions(exactWire), 'identity-fc55dc554b54c5fb.json');
  let defaultBroker; let exactBroker; let client;
  try {
    defaultBroker = await createPersistedTestBroker({ dataRoot: directory, workspace: directory, tokenByte: '1', instanceByte: 'a' });
    exactBroker = await createPersistedTestBroker({ dataRoot: directory, workspace: directory, tokenByte: '2', instanceByte: 'b', ...exactWire });
    client = await createExistingManagedZCodeClient({ dataRoot: directory, workspace: directory, ownerId: 'existing-exact-owner', requestTimeoutMs: 100, ...exactWire });
    assert.ok(client);
    assert.equal(defaultBroker.owners, 0);
    assert.equal(exactBroker.owners, 1);
  } finally {
    await client?.close().catch(() => {}); await exactBroker?.close(); await defaultBroker?.close(); await rm(directory, { recursive: true, force: true });
  }
});

test('existing managed client returns null and never spawns when the broker is absent', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-existing-absent-'));
  try {
    assert.equal(await createExistingManagedZCodeClient({ dataRoot: directory, workspace: directory, ownerId: 'existing-absent-owner', requestTimeoutMs: 50 }), null);
    await assert.rejects(createExistingManagedZCodeClient({ dataRoot: directory, workspace: directory, ownerId: 'existing-no-launch-owner', requestTimeoutMs: 50, launch: { command: process.execPath, args: [fixture] } }), { code: 'ZCODE_INPUT_INVALID' });
    await assert.rejects(createExistingManagedZCodeClient({ dataRoot: directory, workspace: directory, ownerId: 'existing-no-env-owner', requestTimeoutMs: 50, env: process.env }), { code: 'ZCODE_INPUT_INVALID' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('existing managed client does not fall back to a sibling wire profile', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-existing-sibling-')); let defaultBroker;
  try {
    defaultBroker = await createPersistedTestBroker({ dataRoot: directory, workspace: directory, tokenByte: '3', instanceByte: 'c' });
    const client = await createExistingManagedZCodeClient({ dataRoot: directory, workspace: directory, ownerId: 'existing-sibling-owner', requestTimeoutMs: 50, maxFrameBytes: 4096 });
    assert.equal(client, null);
    assert.equal(defaultBroker.owners, 0);
  } finally { await defaultBroker?.close(); await rm(directory, { recursive: true, force: true }); }
});

test('existing managed client bounds an unhealthy broker probe', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-existing-hung-')); const wireOptions = { maxFrameBytes: 4096 }; let closeServer;
  try {
    for (const requestTimeoutMs of [0, 3_600_001]) await assert.rejects(createExistingManagedZCodeClient({ dataRoot: directory, workspace: directory, ownerId: 'existing-invalid-timeout', requestTimeoutMs, ...wireOptions }), { code: 'ZCODE_INPUT_INVALID' });
    const storage = await resolveWorkspaceStorage({ dataRoot: directory, workspace: directory }); const identityName = brokerIdentityNameForWireOptions(wireOptions); const profile = identityName.slice('identity-'.length, -'.json'.length); const endpoint = brokerEndpointFor({ dataRoot: directory, workspace: storage.workspacePath, identity: profile }); const brokerToken = '4'.repeat(64); const instanceId = 'd'.repeat(48);
    closeServer = await createHealthOnlyServer(endpoint, { brokerToken, instanceId, hangHealth: true });
    await writeBrokerIdentity(join(storage.directory, 'broker', identityName), { endpoint, pid: process.pid, instanceId, brokerToken });
    const startedAt = Date.now();
    assert.equal(await createExistingManagedZCodeClient({ dataRoot: directory, workspace: directory, ownerId: 'existing-hung-owner', requestTimeoutMs: 40, ...wireOptions }), null);
    assert.ok(Date.now() - startedAt < 500);
  } finally { await closeServer?.(); await rm(directory, { recursive: true, force: true }); }
});

test('existing managed client returns null when the broker dies between health and connect', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-existing-race-')); let closeServer;
  try {
    const storage = await resolveWorkspaceStorage({ dataRoot: directory, workspace: directory }); const identityName = brokerIdentityNameForWireOptions(); const endpoint = brokerEndpointFor({ dataRoot: directory, workspace: storage.workspacePath }); const brokerToken = '5'.repeat(64); const instanceId = 'e'.repeat(48);
    closeServer = await createHealthOnlyServer(endpoint, { brokerToken, instanceId, closeAfterHealth: true });
    await writeBrokerIdentity(join(storage.directory, 'broker', identityName), { endpoint, pid: process.pid, instanceId, brokerToken });
    assert.equal(await createExistingManagedZCodeClient({ dataRoot: directory, workspace: directory, ownerId: 'existing-race-owner', requestTimeoutMs: 100 }), null);
  } finally { await closeServer?.(); await rm(directory, { recursive: true, force: true }); }
});

test('existing managed client cannot lazily spawn a child protocol while normal managed clients still can', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-existing-no-child-')); const record = join(directory, 'calls.jsonl'); const ownerId = 'existing-no-child-owner'; const remoteSessionId = 'existing-no-child-session'; let broker; let existingClient; let normalClient;
  try {
    const storage = await resolveWorkspaceStorage({ dataRoot: directory, workspace: directory }); const brokerDirectory = join(storage.directory, 'broker'); const ownershipPath = join(brokerDirectory, 'session-owners.json'); await mkdir(brokerDirectory, { recursive: true }); await writeFile(ownershipPath, JSON.stringify({ version: 1, sessions: { [remoteSessionId]: ownerId } }));
    const endpoint = brokerEndpointFor({ dataRoot: directory, workspace: storage.workspacePath }); const brokerToken = '6'.repeat(64); const instanceId = 'f'.repeat(48); const launch = { command: process.execPath, args: [fixture], target: fixture };
    broker = await newTestBroker({ endpoint, ownershipPath, brokerToken, instanceId, workspace: storage.workspacePath, launch, env: { ...process.env, FAKE_ZCODE_RECORD: record, FAKE_ZCODE_WORKSPACE: storage.workspacePath } }).start();
    await writeBrokerIdentity(join(brokerDirectory, 'identity.json'), { endpoint, pid: process.pid, instanceId, brokerToken });
    existingClient = await createExistingManagedZCodeClient({ dataRoot: directory, workspace: directory, ownerId, requestTimeoutMs: 100 }); assert.ok(existingClient);
    await assert.rejects(existingClient.readSession(remoteSessionId), { code: 'ZCODE_BROKER_PROTOCOL_UNAVAILABLE' }); assert.equal(broker.protocol, null); assert.equal(broker.protocolPromise, null); await assert.rejects(readFile(record, 'utf8'), { code: 'ENOENT' });
    await existingClient.close(); existingClient = null;
    normalClient = await createManagedZCodeClient({ dataRoot: directory, workspace: directory, ownerId, launch, env: { ...process.env, FAKE_ZCODE_RECORD: record, FAKE_ZCODE_WORKSPACE: storage.workspacePath }, requestTimeoutMs: 500 });
    assert.equal((await normalClient.readSession(remoteSessionId)).session.sessionId, remoteSessionId); assert.ok((await readFile(record, 'utf8')).includes('session/read'));
  } finally { await existingClient?.close().catch(() => {}); await normalClient?.close().catch(() => {}); await broker?.close(); await rm(directory, { recursive: true, force: true }); }
});

test('named-pipe broker construction requires an explicit ownership path', () => {
  for (const endpoint of ['\\\\.\\pipe\\zcode-test', '\\\\.\\PIPE\\zcode-test']) assert.throws(() => new ZCodeBrokerClass({ endpoint, brokerToken: 'b'.repeat(64), workspace: '/tmp', launch: { command: process.execPath, args: [] } }), { code: 'ZCODE_BROKER_INPUT_INVALID' });
});

test('direct broker construction rejects unbounded wire and drain options', () => {
  const options = { endpoint: '/tmp/zcode-test.sock', brokerToken: 'b'.repeat(64), workspace: '/tmp', launch: { command: process.execPath, args: [] } };
  assert.throws(() => newTestBroker({ ...options, drainTimeoutMs: 30_001 }), { code: 'ZCODE_BROKER_INPUT_INVALID' });
  assert.throws(() => newTestBroker({ ...options, maxOutboundBytes: 64 * 1024 * 1024 + 1 }), { code: 'ZCODE_BROKER_INPUT_INVALID' });
});

test('direct broker clients require an explicit stable owner credential before connecting', async () => {
  for (const ownerId of [undefined, '', 'too-short']) await assert.rejects(createZCodeClient({ workspace: '/tmp', brokerEndpoint: '/missing-broker', brokerToken: 'a'.repeat(64), ...(ownerId === undefined ? {} : { ownerId }) }), { code: 'ZCODE_INPUT_INVALID' });
});

test('actual 0.16.1 snapshot and list required fields are enforced', async (t) => {
  await t.test('snapshot workspace', () => withClient(async (client) => { await assert.rejects(client.createSession({ workspace: '/repo' }), { code: 'ZCODE_OUTPUT_INVALID' }); }, { FAKE_ZCODE_BAD_SNAPSHOT: 'missing-workspace' }));
  await t.test('message envelope', () => withClient(async (client) => { await assert.rejects(client.createSession({ workspace: '/repo' }), { code: 'ZCODE_OUTPUT_INVALID' }); }, { FAKE_ZCODE_BAD_SNAPSHOT: 'empty-message' }));
  await t.test('list session info', () => withClient(async (client) => { await client.createSession({ workspace: '/repo' }); await assert.rejects(client.listSessions(), { code: 'ZCODE_OUTPUT_INVALID' }); }, { FAKE_ZCODE_BAD_LIST: 'session-id-only' }));
});

test('snapshot identity binding rejects cross-workspace and nested session aliases', async (t) => {
  for (const variant of ['wrong-workspace', 'wrong-workspace-key', 'wrong-projection-session', 'wrong-session-target', 'wrong-projection-target', 'wrong-message-session', 'wrong-part-session', 'wrong-part-message']) {
    await t.test(variant, () => withClient(async (client) => {
      await assert.rejects(client.createSession({ workspace: '/repo' }), { code: 'ZCODE_OUTPUT_INVALID' });
    }, { FAKE_ZCODE_BAD_SNAPSHOT: variant, FAKE_ZCODE_BAD_SNAPSHOT_METHOD: 'session/create' }));
  }
});

test('read, resume, and settings snapshots retain their canonical workspace binding', async (t) => {
  for (const method of ['session/read', 'session/resume', 'session/setModel', 'session/setThoughtLevel']) await t.test(method, () => withClient(async (client) => {
    const sessionId = (await client.createSession({ workspace: '/repo' })).session.sessionId;
    const operation = method === 'session/read' ? () => client.readSession(sessionId)
      : method === 'session/resume' ? () => client.resumeSession(sessionId)
        : method === 'session/setModel' ? () => client.setModel(sessionId, { providerId: 'fake2', modelId: 'other' })
          : () => client.setThoughtLevel(sessionId, 'high');
    await assert.rejects(operation(), { code: 'ZCODE_OUTPUT_INVALID' });
  }, { FAKE_ZCODE_BAD_SNAPSHOT: 'wrong-workspace', FAKE_ZCODE_BAD_SNAPSHOT_METHOD: method }));
});

test('broker rejects a non-canonical or foreign create workspace before forwarding', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-create-workspace-binding-')); const sessionId = 'workspace-binding-session'; const ownerId = 'workspace-binding-owner'; const writes = []; const socket = { writable: true, destroyed: false, zcodeWriter: { write: (line) => writes.push(JSON.parse(line)) }, destroy() {} }; const broker = newTestBroker({ endpoint: join(directory, 'broker.sock'), brokerToken: '1'.repeat(64), workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } }); broker.authenticated.add(socket); broker.socketOwnerIds.set(socket, ownerId); let forwarded = 0; const protocol = { request: async () => { forwarded += 1; return brokerCreateSnapshot(sessionId, '/foreign-workspace'); } }; broker.protocol = protocol;
  await broker.handleLocal(socket, JSON.stringify({ id: 89, method: 'session/create', params: { sessionId, workspace: { workspacePath: '/foreign-workspace', workspaceKey: '/foreign-workspace' } } }));
  assert.equal(forwarded, 0); assert.equal(writes.at(-1)?.error?.data?.pluginError?.code, 'ZCODE_BROKER_INPUT_INVALID'); assert.equal(broker.sessionOwners.has(sessionId), false); assert.equal(broker.protocol, protocol); await rm(directory, { recursive: true, force: true });
});

test('broker validates snapshot workspace and every current-session ID before committing ownership', async (t) => {
  for (const variant of ['missing-workspace', 'wrong-workspace', 'wrong-workspace-key', 'wrong-projection-session', 'wrong-session-target', 'wrong-projection-target', 'wrong-message-session', 'wrong-part-session', 'wrong-part-message']) for (const explicit of [false, true]) await t.test(`${variant}-${explicit ? 'explicit' : 'anonymous'}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), `zcode-broker-invalid-create-${explicit ? 'explicit' : 'anonymous'}-`));
    const endpoint = join(directory, 'broker.sock'); const ownershipPath = `${endpoint}.owners.json`; const brokerToken = '1'.repeat(64); const ownerId = `invalid-create-${explicit ? 'explicit' : 'anonymous'}-owner`; const sessionId = `invalid-create-${explicit ? 'explicit' : 'anonymous'}-session`;
    const broker = await newTestBroker({ endpoint, ownershipPath, brokerToken, workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture }, env: { ...process.env, FAKE_ZCODE_BAD_SNAPSHOT: variant, FAKE_ZCODE_BAD_SNAPSHOT_METHOD: 'session/create', FAKE_ZCODE_SESSION_ID: sessionId } }).start();
    let retiredProtocol; const clearProtocolGeneration = broker.clearProtocolGeneration.bind(broker); broker.clearProtocolGeneration = (protocol) => { retiredProtocol = protocol; return clearProtocolGeneration(protocol); };
    const client = await createZCodeClient({ workspace: directory, brokerEndpoint: endpoint, brokerToken, ownerId });
    try {
      await assert.rejects(client.createSession({ workspace: directory, ...(explicit ? { sessionId } : {}) }), { code: 'ZCODE_OUTPUT_INVALID' });
      assert.equal(broker.sessionOwners.has(sessionId), false);
      const durable = await readFile(ownershipPath, 'utf8').then((value) => JSON.parse(value).sessions, (error) => error.code === 'ENOENT' ? {} : Promise.reject(error));
      assert.equal(Object.hasOwn(durable, sessionId), false);
      assert.equal(broker.protocol, null);
      assert.ok(retiredProtocol);
    } finally { await client.close(); await broker.close(); await rm(directory, { recursive: true, force: true }); }
  });
});

test('invented and malformed nested 0.16.1 response fields are rejected', async (t) => {
  for (const variant of ['invented-session-kind', 'invented-subagent-kind', 'bad-protocol', 'missing-model-label', 'string-message-model', 'bad-goal-stats', 'bad-permission-origin', 'bad-runtime-cache', 'bad-timeline-trigger', 'bad-provider-options']) await t.test(variant, () => withClient(async (client) => { await assert.rejects(client.createSession({ workspace: '/repo' }), { code: 'ZCODE_OUTPUT_INVALID' }); }, { FAKE_ZCODE_BAD_SNAPSHOT: variant }, process.platform === 'win32' ? { requestTimeoutMs: 2_000, completionTimeoutMs: 2_000 } : {}));
});

test('harmless additive response fields are accepted with wire protocol version 1', async () => {
  await withClient(async (client) => { const result = await client.createSession({ workspace: '/repo' }); assert.equal(result.protocol.version, 1); assert.equal(result.protocol.futureProtocolField, 'ignored'); assert.equal(result.projection.futureProjectionField, 'new'); }, { FAKE_ZCODE_FUTURE_FIELDS: '1' });
});

test('wire protocol version 2 fails closed even when its fields are otherwise valid', async () => {
  await withClient(async (client) => { await assert.rejects(client.createSession({ workspace: '/repo' }), { code: 'ZCODE_OUTPUT_INVALID' }); }, { FAKE_ZCODE_PROTOCOL_VERSION: '2' });
});

test('invalid broker send response rolls back the turn and permits a retry', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-send-rollback-')); const endpoint = brokerEndpointFor({ dataRoot: directory, workspace: directory }); const brokerToken = '4'.repeat(64); const broker = await newTestBroker({ endpoint, brokerToken, workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture }, env: { ...process.env, FAKE_ZCODE_BAD_SEND_ONCE: '1' } }).start(); const client = await createZCodeClient({ workspace: directory, brokerEndpoint: endpoint, brokerToken, ownerId: 'send-rollback-owner' });
  try { const { session: { sessionId } } = await client.createSession({ workspace: directory }); await assert.rejects(client.send(sessionId, 'bad'), { code: 'ZCODE_OUTPUT_INVALID' }); assert.equal(broker.activeSessions.size, 0); assert.equal(broker.protocol.turns.size, 0); await client.send(sessionId, 'retry'); await client.waitForCompletion(sessionId); }
  finally { await client.close(); await broker.close(); await rm(directory, { recursive: true, force: true }); }
});

test('broker clears a shared failed protocol spawn so a later request can retry', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-spawn-retry-')); const endpoint = brokerEndpointFor({ dataRoot: directory, workspace: directory }); const brokerToken = '3'.repeat(64); const broker = await newTestBroker({ endpoint, brokerToken, workspace: directory, launch: { command: join(directory, 'missing'), args: [] } }).start(); const client = await createZCodeClient({ workspace: directory, brokerEndpoint: endpoint, brokerToken, ownerId: 'spawn-retry-owner' });
  try { const failures = await Promise.allSettled([client.createSession({ workspace: directory }), client.listSessions()]); assert.equal(failures.filter((item) => item.status === 'rejected').length, 2); assert.equal(broker.protocolPromise, null); broker.options.launch = { command: process.execPath, args: [fixture], target: fixture }; const created = await client.createSession({ workspace: directory }); assert.equal(created.session.sessionId, 'session-1'); }
  finally { await client.close(); await broker.close(); await rm(directory, { recursive: true, force: true }); }
});

test('broker cold start initializes one protocol generation once for concurrent forwarded requests', async (t) => {
  for (const concurrency of [2, 12]) await t.test(String(concurrency), async () => {
    const directory = await mkdtemp(join(tmpdir(), `zcode-broker-cold-${concurrency}-`)); const endpoint = join(directory, 'broker.sock'); const writes = []; const broker = await newTestBroker({ endpoint, brokerToken: '5'.repeat(64), workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture }, env: { ...process.env, FAKE_ZCODE_LIST_NOTIFICATION_ONCE: '1' } }).start(); const socket = { writable: true, destroyed: false, zcodeWriter: { write: (line) => writes.push(JSON.parse(line)) }, destroy() {} }; broker.sockets.add(socket); broker.authenticated.add(socket); broker.socketOwnerIds.set(socket, `cold-owner-${concurrency}-stable`); let releaseReloads; let reloadCount = 0; const reloadGate = new Promise((resolvePromise) => { releaseReloads = resolvePromise; }); broker.reloadOwnership = async () => { reloadCount += 1; if (reloadCount === concurrency) releaseReloads(); await reloadGate; }; const protocols = []; const getProtocol = broker.getProtocol.bind(broker); broker.getProtocol = async () => { const protocol = await getProtocol(); protocols.push(protocol); return protocol; };
    try { await Promise.all(Array.from({ length: concurrency }, (_, index) => broker.handleLocal(socket, JSON.stringify({ id: index + 1, method: 'session/list', params: {} })))); assert.equal(new Set(protocols).size, 1, 'concurrent waiters received different protocol objects'); assert.equal(broker.protocol.subscribers.size, 1, 'one protocol generation was initialized more than once'); assert.equal(writes.filter((frame) => frame.method === 'fixture/notification').length, 0, 'an owner-neutral notification was broadcast'); assert.equal(writes.filter((frame) => frame.result).length, concurrency); }
    finally { await broker.close(); await rm(directory, { recursive: true, force: true }); }
  });
});

test('broker drops owner-neutral notifications and routes attributed notifications only to their owner', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-notification-owner-routing-')); const endpoint = join(directory, 'broker.sock'); const brokerToken = '8'.repeat(64); const broker = await newTestBroker({ endpoint, brokerToken, workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture }, env: { ...process.env, FAKE_ZCODE_LIST_ROUTING_NOTIFICATIONS: '1' } }).start(); const ownerA = await createZCodeClient({ workspace: directory, brokerEndpoint: endpoint, brokerToken, ownerId: 'notification-routing-owner-a' }); const ownerB = await createZCodeClient({ workspace: directory, brokerEndpoint: endpoint, brokerToken, ownerId: 'notification-routing-owner-b' }); const sessionId = (await ownerA.createSession({ workspace: directory })).session.sessionId; const notificationsA = []; const notificationsB = []; const unsubscribeA = ownerA.protocol.subscribe((message) => notificationsA.push(message)); const unsubscribeB = ownerB.protocol.subscribe((message) => notificationsB.push(message));
  try { await ownerA.listSessions(); assert.deepEqual(notificationsA, [{ method: 'fixture/sessionNotification', params: { sessionId, occurrence: 1 } }]); assert.deepEqual(notificationsB, []); }
  finally { unsubscribeA(); unsubscribeB(); await ownerA.close(); await ownerB.close(); await broker.close(); await rm(directory, { recursive: true, force: true }); }
});

test('a never-closing retired protocol blocks replacement spawn and broker close completion', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-retired-never-close-')); const broker = newTestBroker({ endpoint: join(directory, 'broker.sock'), brokerToken: '7'.repeat(64), workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } }); let closeCalls = 0; const oldProtocol = { close: () => { closeCalls += 1; return new Promise(() => {}); } }; broker.protocol = oldProtocol; let spawnCalls = 0; broker.initializeProtocolGeneration = async () => { spawnCalls += 1; return {}; };
  broker.clearProtocolGeneration(oldProtocol); await assert.rejects(broker.getProtocol(), { code: 'ZCODE_PROTOCOL_RETIRING' }); assert.equal(closeCalls, 1); assert.equal(spawnCalls, 0); let closeOutcome = 'pending'; void broker.close().then(() => { closeOutcome = 'resolved'; }, () => { closeOutcome = 'rejected'; }); await new Promise((resolvePromise) => setTimeout(resolvePromise, 60)); assert.equal(closeOutcome, 'pending'); await rm(directory, { recursive: true, force: true });
});

test('retired protocol close rejection stays fail-closed and is reported by broker close', async (t) => {
  for (const asynchronous of [false, true]) await t.test(asynchronous ? 'async-rejection' : 'sync-rejection', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-retired-close-failure-')); const closeError = new Error(`retired close ${asynchronous ? 'async' : 'sync'} rejection`); const broker = newTestBroker({ endpoint: join(directory, 'broker.sock'), brokerToken: '8'.repeat(64), workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } }); const protocol = { close: () => { if (asynchronous) return Promise.reject(closeError); throw closeError; } }; broker.protocol = protocol; const retired = broker.clearProtocolGeneration(protocol); await retired.closePromise; assert.equal(retired.status, 'failed'); assert.equal(retired.error, closeError); assert.equal(broker.retiredProtocolGeneration, retired); await assert.rejects(broker.getProtocol(), { code: 'ZCODE_PROTOCOL_RETIRING' }); await assert.rejects(broker.close(), (error) => error === closeError); await rm(directory, { recursive: true, force: true });
  });
});

test('confirmed retired close reaps its 256 tombstones before a replacement subscribe', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-retired-tombstone-reap-')); const ownerId = 'retired-tombstone-owner'; const sessionId = 'retired-tombstone-session'; const writes = []; const socket = { writable: true, destroyed: false, zcodeWriter: { write: (line) => writes.push(JSON.parse(line)) }, destroy() {} }; const broker = newTestBroker({ endpoint: join(directory, 'broker.sock'), brokerToken: '6'.repeat(64), workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } }); broker.authenticated.add(socket); broker.socketOwnerIds.set(socket, ownerId); broker.sessionOwners.set(sessionId, { ownerId, socket }); broker.reloadOwnership = async () => {}; let resolveClose; let closeCalls = 0; const oldProtocol = { close: () => { closeCalls += 1; return new Promise((resolvePromise) => { resolveClose = resolvePromise; }); } }; broker.protocol = oldProtocol; for (let index = 0; index < 256; index += 1) broker.orphanedConversationSubscriptions.set(`retired-${index}`, { key: `retired-${index}`, protocol: oldProtocol, topic: `conversation/retired-${index}`, subscriptionId: `retired-sub-${index}`, connectionId: `retired-connection-${index}`, sessionId: `retired-${index}`, ownerId });
  broker.clearProtocolGeneration(oldProtocol); const retired = broker.retiredProtocolGeneration; assert.equal(closeCalls, 1); await assert.rejects(broker.getProtocol(), { code: 'ZCODE_PROTOCOL_RETIRING' }); resolveClose(); await retired.closePromise; assert.equal(broker.orphanedConversationSubscriptions.size, 0); let spawnCalls = 0; let subscribeCalls = 0; const replacement = { request: async () => { subscribeCalls += 1; return { ack: { subscriptionId: 'replacement-subscription', mode: 'snapshot', logEpoch: 'replacement-epoch' } }; }, close: async () => {} }; broker.initializeProtocolGeneration = async () => { spawnCalls += 1; broker.protocol = replacement; return replacement; }; assert.equal(await broker.getProtocol(), replacement); await broker.handleLocal(socket, JSON.stringify({ id: 82, method: 'v4/conversation/subscribe', params: { topic: `conversation/${sessionId}`, connectionId: 'replacement-connection', clientMode: 'desktop-continuous' } })); assert.equal(spawnCalls, 1); assert.equal(subscribeCalls, 1); assert.equal(writes.find((frame) => frame.id === 82)?.result?.ack?.subscriptionId, 'replacement-subscription'); await broker.close(); await rm(directory, { recursive: true, force: true });
});

test('a shared protocol initialization failure clears its promise and permits one initialized retry', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-init-retry-')); const broker = newTestBroker({ endpoint: join(directory, 'broker.sock'), brokerToken: '7'.repeat(64), workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } }); broker.closing = true;
  try { const failures = await Promise.allSettled([broker.getProtocol(), broker.getProtocol()]); assert.equal(failures.filter((outcome) => outcome.status === 'rejected').length, 2); assert.equal(broker.protocolPromise, null); assert.equal(broker.protocol, null); broker.closing = false; const retried = await broker.getProtocol(); assert.equal(broker.protocol, retried); assert.equal(retried.subscribers.size, 1); }
  finally { broker.closing = false; await broker.close(); await rm(directory, { recursive: true, force: true }); }
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
  const broker = await newTestBroker({ endpoint, brokerToken, workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture }, env: { ...process.env, FAKE_ZCODE_PERMISSION: '1' }, idleTimeoutMs: 10_000 }).start();
  await assert.rejects(createZCodeClient({ workspace: directory, brokerEndpoint: endpoint, brokerToken: 'b'.repeat(64), ownerId: 'typed-owner-invalid-token', requestTimeoutMs: 500 }), { code: 'ZCODE_REQUEST_FAILED' });
  const client = await createZCodeClient({ workspace: directory, brokerEndpoint: endpoint, brokerToken, ownerId: 'typed-owner-permission', requestTimeoutMs: 500, completionTimeoutMs: 500 });
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
  const broker = await newTestBroker({ endpoint, brokerToken, workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture }, env: { ...process.env, FAKE_ZCODE_SYNC_BATCH: 'stale-valid' }, idleTimeoutMs: 25 }).start();
  const client = await createZCodeClient({ workspace: directory, brokerEndpoint: endpoint, brokerToken, ownerId: 'consume-owner-stable', completionTimeoutMs: 500 });
  try { const { session: { sessionId } } = await client.createSession({ workspace: directory }); for (let i = 0; i < 2; i += 1) { await client.send(sessionId, String(i)); await client.waitForCompletion(sessionId); assert.equal(broker.activeSessions.size, 0); for (const map of [broker.protocol.turns, broker.protocol.completed, broker.protocol.earlyCompletions, broker.protocol.completionExpiry]) assert.equal(map.size, 0); } }
  finally { await client.close(); await broker.close(); await rm(directory, { recursive: true, force: true }); }
});

test('same-owner broker stop disconnects the exact active client completion waiter', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-stop-active-')); const endpoint = brokerEndpointFor({ dataRoot: directory, workspace: directory }); const brokerToken = '1'.repeat(64); const ownerId = 'stop-active-owner-stable';
  const broker = await newTestBroker({ endpoint, brokerToken, workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture }, env: { ...process.env, FAKE_ZCODE_SUPPRESS_FIRST_COMPLETION: '1' } }).start();
  const worker = await createZCodeClient({ workspace: directory, brokerEndpoint: endpoint, brokerToken, ownerId, completionTimeoutMs: 2_000 }); const controller = await createZCodeClient({ workspace: directory, brokerEndpoint: endpoint, brokerToken, ownerId });
  try { const { session: { sessionId } } = await worker.createSession({ workspace: directory }); await worker.send(sessionId, 'hold'); const completion = assert.rejects(worker.waitForCompletion(sessionId), { code: 'ZCODE_SESSION_STOPPED' }); assert.deepEqual(await controller.stopSession(sessionId), {}); await completion; }
  finally { await worker.close(); await controller.close(); await broker.close(); await rm(directory, { recursive: true, force: true }); }
});

test('same-owner read control requests cannot steal the active completion route before stop', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-read-active-')); const endpoint = brokerEndpointFor({ dataRoot: directory, workspace: directory }); const brokerToken = '4'.repeat(64); const ownerId = 'read-active-owner-stable';
  const broker = await newTestBroker({ endpoint, brokerToken, workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture }, env: { ...process.env, FAKE_ZCODE_SUPPRESS_FIRST_COMPLETION: '1' } }).start();
  const worker = await createZCodeClient({ workspace: directory, brokerEndpoint: endpoint, brokerToken, ownerId, completionTimeoutMs: 500 }); const controller = await createZCodeClient({ workspace: directory, brokerEndpoint: endpoint, brokerToken, ownerId });
  try { const { session: { sessionId } } = await worker.createSession({ workspace: directory }); await worker.send(sessionId, 'hold'); const completion = assert.rejects(worker.waitForCompletion(sessionId), { code: 'ZCODE_SESSION_STOPPED' }); await controller.readSession(sessionId); assert.deepEqual(await controller.stopSession(sessionId), {}); await completion; }
  finally { await worker.close(); await controller.close(); await broker.close(); await rm(directory, { recursive: true, force: true }); }
});

test('stopping one active session does not disconnect a sibling turn on the same client', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-stop-one-')); const endpoint = brokerEndpointFor({ dataRoot: directory, workspace: directory }); const brokerToken = '5'.repeat(64); const ownerId = 'stop-one-owner-stable'; const gate = join(directory, 'completion.gate'); await writeFile(gate, 'hold');
  const broker = await newTestBroker({ endpoint, brokerToken, workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture }, env: { ...process.env, FAKE_ZCODE_COMPLETION_GATE: gate } }).start();
  const worker = await createZCodeClient({ workspace: directory, brokerEndpoint: endpoint, brokerToken, ownerId, completionTimeoutMs: 2_000 }); const controller = await createZCodeClient({ workspace: directory, brokerEndpoint: endpoint, brokerToken, ownerId });
  try {
    const first = (await worker.createSession({ workspace: directory })).session.sessionId; await worker.send(first, 'first'); const firstCompletion = assert.rejects(worker.waitForCompletion(first), { code: 'ZCODE_SESSION_STOPPED' });
    const second = (await worker.createSession({ workspace: directory })).session.sessionId; await worker.send(second, 'second'); const secondCompletion = worker.waitForCompletion(second);
    assert.deepEqual(await controller.stopSession(first), {}); await firstCompletion;
    await writeFile(gate, 'release'); await secondCompletion;
  } finally { await worker.close(); await controller.close(); await broker.close(); await rm(directory, { recursive: true, force: true }); }
});

test('conversation subscriptions are owner-authorized and frames route only to the exact subscriber', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-conversation-owner-')); const endpoint = brokerEndpointFor({ dataRoot: directory, workspace: directory }); const brokerToken = '6'.repeat(64);
  const broker = await newTestBroker({ endpoint, brokerToken, workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture }, env: { ...process.env, FAKE_ZCODE_CONVERSATION_PROGRESS: '1' } }).start();
  const owner = await createZCodeClient({ workspace: directory, brokerEndpoint: endpoint, brokerToken, ownerId: 'conversation-owner-stable' }); const sibling = await createZCodeClient({ workspace: directory, brokerEndpoint: endpoint, brokerToken, ownerId: 'conversation-sibling-stable' }); const ownerMessages = []; const siblingMessages = []; const unsubscribeOwner = owner.subscribe((message) => ownerMessages.push(message)); const unsubscribeSibling = sibling.subscribe((message) => siblingMessages.push(message));
  try {
    const sessionId = (await owner.createSession({ workspace: directory })).session.sessionId;
    await assert.rejects(sibling.subscribeConversation(sessionId, { connectionId: 'sibling-connection', clientMode: 'desktop-continuous' }), { code: 'ZCODE_REQUEST_FAILED' });
    const subscription = await owner.subscribeConversation(sessionId, { connectionId: 'owner-connection', clientMode: 'desktop-continuous' });
    await assert.rejects(owner.subscribeConversation(sessionId, { connectionId: 'duplicate-connection', clientMode: 'desktop-continuous' }), { code: 'ZCODE_BROKER_INPUT_INVALID' });
    await assert.rejects(owner.protocol.request('v4/conversation/unsubscribe', { topic: `conversation/${sessionId}`, subscriptionId: 'unknown-subscription', connectionId: 'owner-connection' }), { code: 'ZCODE_SESSION_OWNER_CONFLICT' });
    await owner.send(sessionId, 'private progress'); await owner.waitForCompletion(sessionId); await subscription.unsubscribe();
    assert.equal(siblingMessages.some((message) => message.method === 'v4/conversation/frame'), false);
    assert.equal(ownerMessages.some((message) => message.method === 'v4/conversation/frame' && message.params?.subscriptionId === 'foreign-subscription'), false);
  } finally { unsubscribeOwner(); unsubscribeSibling(); await owner.close(); await sibling.close(); await broker.close(); await rm(directory, { recursive: true, force: true }); }
});

test('an unsafe conversation acknowledgement faults its protocol generation before retry', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-conversation-retry-')); const endpoint = brokerEndpointFor({ dataRoot: directory, workspace: directory }); const brokerToken = 'c'.repeat(64); const ownerId = 'conversation-retry-owner'; const badAckMarker = join(directory, 'bad-ack-once');
  const broker = await newTestBroker({ endpoint, brokerToken, workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture }, env: { ...process.env, FAKE_ZCODE_BAD_CONVERSATION_ACK_ONCE: '1', FAKE_ZCODE_BAD_CONVERSATION_ACK_MARKER: badAckMarker, FAKE_ZCODE_SUPPRESS_FIRST_COMPLETION: '1' } }).start(); const client = await createZCodeClient({ workspace: directory, brokerEndpoint: endpoint, brokerToken, ownerId, completionTimeoutMs: 1_000 });
  try { const sessionId = (await client.createSession({ workspace: directory })).session.sessionId; await client.send(sessionId, 'sibling turn'); const sibling = assert.rejects(client.waitForCompletion(sessionId), { code: 'ZCODE_SESSION_STOPPED' }); const failedProtocol = broker.protocol; await assert.rejects(client.subscribeConversation(sessionId, { connectionId: 'first-connection', clientMode: 'desktop-continuous' }), { code: 'ZCODE_BROKER_INPUT_INVALID' }); await sibling; assert.equal(broker.protocol, null); assert.equal(broker.conversationSubscriptions.size, 0); assert.equal(broker.pendingConversationTopics.size, 0); const retired = broker.retiredProtocolGeneration; assert.ok(retired); await retired.closePromise; assert.equal(broker.retiredProtocolGeneration, null); const replacementSession = (await client.createSession({ workspace: directory, sessionId: 'conversation-retry-replacement-session' })).session.sessionId; assert.notEqual(broker.protocol, failedProtocol); const retried = await client.subscribeConversation(replacementSession, { connectionId: 'second-connection', clientMode: 'desktop-continuous' }); assert.equal(retried.subscriptionId, `subscription-${replacementSession}`); await retried.unsubscribe(); }
  finally { await client.close(); await broker.close(); await rm(directory, { recursive: true, force: true }); }
});

test('an unsafe subscribe acknowledgement fences a same-chunk create result from the old protocol generation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-conversation-create-generation-')); const endpoint = join(directory, 'broker.sock'); const ownershipPath = `${endpoint}.owners.json`; const brokerToken = 'd'.repeat(64); const ownerId = 'conversation-create-generation-owner'; const existingSessionId = 'conversation-create-existing-session'; const createdSessionId = 'conversation-create-stale-session'; await writeFile(ownershipPath, JSON.stringify({ version: 1, sessions: { [existingSessionId]: ownerId } }));
  const broker = await newTestBroker({ endpoint, ownershipPath, brokerToken, workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture }, env: { ...process.env, FAKE_ZCODE_CONCURRENT_CREATE_SUBSCRIBE_BATCH: '1', FAKE_ZCODE_BAD_CONVERSATION_ACK_ONCE: '1' } }).start(); const getProtocol = broker.getProtocol.bind(broker); let failedProtocol; broker.getProtocol = async () => { const protocol = await getProtocol(); failedProtocol ??= protocol; return protocol; }; const client = await createZCodeClient({ workspace: directory, brokerEndpoint: endpoint, brokerToken, ownerId });
  try {
    const creating = client.createSession({ workspace: directory, sessionId: createdSessionId }); const subscribing = client.subscribeConversation(existingSessionId, { connectionId: 'concurrent-unsafe-subscribe', clientMode: 'desktop-continuous' }); const [createOutcome, subscribeOutcome] = await Promise.allSettled([creating, subscribing]);
    assert.equal(subscribeOutcome.status, 'rejected'); assert.equal(createOutcome.status, 'rejected'); assert.equal(broker.sessionOwners.has(createdSessionId), false); assert.deepEqual(JSON.parse(await readFile(ownershipPath, 'utf8')).sessions, { [existingSessionId]: ownerId }); const retired = broker.retiredProtocolGeneration; assert.ok(retired); await retired.closePromise; const replacementProtocol = await getProtocol(); assert.notEqual(replacementProtocol, failedProtocol); assert.equal(broker.sessionOwners.has(createdSessionId), false);
  } finally { await client.close(); await broker.close(); await rm(directory, { recursive: true, force: true }); }
});

test('a reverse-order same-chunk unsafe acknowledgement compensates a stale durable create', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-conversation-create-reverse-generation-')); const endpoint = join(directory, 'broker.sock'); const ownershipPath = `${endpoint}.owners.json`; const brokerToken = '4'.repeat(64); const ownerId = 'conversation-create-reverse-owner'; const existingSessionId = 'conversation-create-reverse-existing'; const createdSessionId = 'conversation-create-reverse-stale'; await writeFile(ownershipPath, JSON.stringify({ version: 1, sessions: { [existingSessionId]: ownerId } }));
  const broker = await newTestBroker({ endpoint, ownershipPath, brokerToken, workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture }, env: { ...process.env, FAKE_ZCODE_CONCURRENT_CREATE_SUBSCRIBE_REVERSE_BATCH: '1', FAKE_ZCODE_BAD_CONVERSATION_ACK_ONCE: '1' } }).start(); const client = await createZCodeClient({ workspace: directory, brokerEndpoint: endpoint, brokerToken, ownerId });
  try { const [createOutcome, subscribeOutcome] = await Promise.allSettled([client.createSession({ workspace: directory, sessionId: createdSessionId }), client.subscribeConversation(existingSessionId, { connectionId: 'reverse-unsafe-subscribe', clientMode: 'desktop-continuous' })]); assert.equal(subscribeOutcome.status, 'rejected'); assert.equal(createOutcome.status, 'rejected'); assert.equal(broker.sessionOwners.has(createdSessionId), false); assert.deepEqual(JSON.parse(await readFile(ownershipPath, 'utf8')).sessions, { [existingSessionId]: ownerId }); }
  finally { await client.close(); await broker.close(); await rm(directory, { recursive: true, force: true }); }
});

test('broker conversation admission rejects and cleans every safe malformed or duplicate acknowledgement', async (t) => {
  const safeInvalid = [
    { ack: { subscriptionId: 'safe-invalid-sub', mode: 'replay', logEpoch: 'epoch-1' } },
    { ack: { subscriptionId: 'safe-invalid-sub', mode: 'snapshot', logEpoch: 'epoch-1', extra: true } },
    { ack: { subscriptionId: 'safe-invalid-sub', mode: 'snapshot', logEpoch: 'epoch-1' }, extra: true },
    { ack: { subscriptionId: 'safe-invalid-sub', mode: 'snapshot', logEpoch: '' } },
  ];
  for (const [index, result] of safeInvalid.entries()) await t.test(`safe-invalid-${index}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-safe-invalid-ack-')); const writes = []; let cleanupCalls = 0; let closeCalls = 0; const sessionId = `safe-invalid-session-${index}`; const ownerId = 'safe-invalid-conversation-owner'; const broker = newTestBroker({ endpoint: join(directory, 'broker.sock'), brokerToken: '3'.repeat(64), workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } }); const socket = { writable: true, zcodeWriter: { write: (line) => writes.push(JSON.parse(line)) }, destroy() {} }; broker.authenticated.add(socket); broker.socketOwnerIds.set(socket, ownerId); broker.sessionOwners.set(sessionId, { ownerId, socket, claimToken: null }); broker.reloadOwnership = async () => {}; const protocol = { request: async (method) => { if (method === 'v4/conversation/subscribe') return result; if (method === 'v4/conversation/unsubscribe') { cleanupCalls += 1; return {}; } throw new Error(`unexpected ${method}`); }, close: async () => { closeCalls += 1; } }; broker.protocol = protocol;
    try { await broker.handleLocal(socket, JSON.stringify({ id: 1, method: 'v4/conversation/subscribe', params: { topic: `conversation/${sessionId}`, connectionId: `safe-invalid-connection-${index}`, clientMode: 'desktop-continuous' } })); assert.equal(writes.at(-1)?.error?.data?.pluginError?.code, 'ZCODE_BROKER_INPUT_INVALID'); assert.equal(cleanupCalls, 1); assert.equal(closeCalls, 0); assert.equal(broker.protocol, protocol); assert.equal(broker.conversationSubscriptions.size, 0); assert.equal(broker.pendingConversationTopics.size, 0); }
    finally { await rm(directory, { recursive: true, force: true }); }
  });
  await t.test('duplicate-safe-id', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-duplicate-safe-ack-')); const writes = []; let cleanupCalls = 0; const ownerId = 'duplicate-safe-conversation-owner'; const existingSessionId = 'duplicate-safe-existing-session'; const newSessionId = 'duplicate-safe-new-session'; const duplicateId = 'duplicate-safe-subscription'; const broker = newTestBroker({ endpoint: join(directory, 'broker.sock'), brokerToken: '8'.repeat(64), workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } }); const socket = { writable: true, zcodeWriter: { write: (line) => writes.push(JSON.parse(line)) }, destroy() {} }; broker.authenticated.add(socket); broker.socketOwnerIds.set(socket, ownerId); broker.sessionOwners.set(existingSessionId, { ownerId, socket, claimToken: null }); broker.sessionOwners.set(newSessionId, { ownerId, socket, claimToken: null }); broker.reloadOwnership = async () => {}; broker.conversationSubscriptions.set(JSON.stringify([`conversation/${existingSessionId}`, duplicateId]), { socket, topic: `conversation/${existingSessionId}`, subscriptionId: duplicateId, connectionId: 'existing-connection', sessionId: existingSessionId, ownerId }); const protocol = { request: async (method) => { if (method === 'v4/conversation/subscribe') return { ack: { subscriptionId: duplicateId, mode: 'resume', logEpoch: 'epoch-2' } }; cleanupCalls += 1; return {}; }, close: async () => {} }; broker.protocol = protocol;
    try { await broker.handleLocal(socket, JSON.stringify({ id: 2, method: 'v4/conversation/subscribe', params: { topic: `conversation/${newSessionId}`, connectionId: 'new-connection', clientMode: 'desktop-continuous' } })); assert.equal(writes.at(-1)?.error?.data?.pluginError?.code, 'ZCODE_BROKER_INPUT_INVALID'); assert.equal(cleanupCalls, 1); assert.equal(broker.protocol, protocol); assert.equal(broker.conversationSubscriptions.size, 1); assert.equal(broker.pendingConversationTopics.size, 0); }
    finally { await rm(directory, { recursive: true, force: true }); }
  });
});

test('broker uses one UTF-8 bounded subscription identifier contract for admission duplicates and routing', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-conversation-utf8-contract-')); const writes = []; const ownerId = 'conversation-utf8-contract-owner'; const firstSessionId = 'conversation-utf8-first-session'; const secondSessionId = 'conversation-utf8-second-session'; const validId = '界'.repeat(170); const oversizedId = '界'.repeat(171); const broker = newTestBroker({ endpoint: join(directory, 'broker.sock'), brokerToken: 'a'.repeat(64), workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } }); const socket = { writable: true, zcodeWriter: { write: (line) => writes.push(JSON.parse(line)) }, destroy() {} }; broker.authenticated.add(socket); broker.socketOwnerIds.set(socket, ownerId); broker.sessionOwners.set(firstSessionId, { ownerId, socket, claimToken: null }); broker.sessionOwners.set(secondSessionId, { ownerId, socket, claimToken: null }); broker.reloadOwnership = async () => {}; let nextSubscriptionId = validId; let cleanupCalls = 0; let closeCalls = 0; const protocol = { request: async (method) => { if (method === 'v4/conversation/subscribe') return { ack: { subscriptionId: nextSubscriptionId, mode: 'snapshot', logEpoch: 'epoch-utf8' } }; cleanupCalls += 1; return {}; }, close: async () => { closeCalls += 1; } }; broker.protocol = protocol;
  await broker.handleLocal(socket, JSON.stringify({ id: 1, method: 'v4/conversation/subscribe', params: { topic: `conversation/${firstSessionId}`, connectionId: 'utf8-first-connection', clientMode: 'desktop-continuous' } })); assert.equal(writes.at(-1)?.result?.ack?.subscriptionId, validId); const beforeFrame = writes.length; broker.routeConversationFrame({ method: 'v4/conversation/frame', params: { topic: `conversation/${firstSessionId}`, subscriptionId: validId, frame: { payload: 'utf8-route' } } }); assert.equal(writes.length, beforeFrame + 1); assert.equal(writes.at(-1).method, 'v4/conversation/frame');
  await broker.handleLocal(socket, JSON.stringify({ id: 2, method: 'v4/conversation/subscribe', params: { topic: `conversation/${secondSessionId}`, connectionId: 'utf8-duplicate-connection', clientMode: 'desktop-continuous' } })); assert.equal(writes.at(-1)?.error?.data?.pluginError?.code, 'ZCODE_BROKER_INPUT_INVALID'); assert.equal(cleanupCalls, 1); assert.equal(broker.conversationSubscriptions.size, 1);
  broker.conversationSubscriptions.clear(); nextSubscriptionId = oversizedId; await broker.handleLocal(socket, JSON.stringify({ id: 3, method: 'v4/conversation/subscribe', params: { topic: `conversation/${secondSessionId}`, connectionId: 'utf8-oversized-connection', clientMode: 'desktop-continuous' } })); assert.equal(writes.at(-1)?.error?.data?.pluginError?.code, 'ZCODE_BROKER_INPUT_INVALID'); assert.equal(broker.conversationSubscriptions.size, 0); assert.equal(closeCalls, 1); assert.equal(broker.protocol, null); await rm(directory, { recursive: true, force: true });
});

test('a stale safe subscribe acknowledgement cannot mutate a replacement protocol generation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-conversation-generation-cas-')); const writes = []; const broker = newTestBroker({ endpoint: join(directory, 'broker.sock'), brokerToken: '6'.repeat(64), workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } }); const socket = { writable: true, zcodeWriter: { write: (line) => writes.push(JSON.parse(line)) }, destroy() {} }; const ownerId = 'conversation-generation-owner'; const unsafeSession = 'unsafe-generation-session'; const safeSession = 'safe-generation-session';
  broker.authenticated.add(socket); broker.socketOwnerIds.set(socket, ownerId); broker.sessionOwners.set(unsafeSession, { ownerId, socket, claimToken: null }); broker.sessionOwners.set(safeSession, { ownerId, socket, claimToken: null }); broker.reloadOwnership = async () => {};
  let resolveUnsafe; let resolveSafe; const unsafeResponse = new Promise((resolvePromise) => { resolveUnsafe = resolvePromise; }); const safeResponse = new Promise((resolvePromise) => { resolveSafe = resolvePromise; }); const protocol = { request: (method, params) => { if (method === 'v4/conversation/subscribe') return params.topic.endsWith(unsafeSession) ? unsafeResponse : safeResponse; throw new Error('stale cleanup must not reach the old protocol'); }, close: async () => {} }; broker.protocol = protocol; broker.getProtocol = async () => protocol;
  const unsafe = broker.handleLocal(socket, JSON.stringify({ id: 1, method: 'v4/conversation/subscribe', params: { topic: `conversation/${unsafeSession}`, connectionId: 'unsafe-connection', clientMode: 'desktop-continuous' } })); const safe = broker.handleLocal(socket, JSON.stringify({ id: 2, method: 'v4/conversation/subscribe', params: { topic: `conversation/${safeSession}`, connectionId: 'safe-connection', clientMode: 'desktop-continuous' } })); await new Promise((resolvePromise) => setImmediate(resolvePromise)); resolveUnsafe({ ack: { subscriptionId: '' } }); await unsafe; const replacementProtocol = {}; const replacementTombstone = { key: 'replacement', protocol: replacementProtocol }; broker.protocol = replacementProtocol; broker.orphanedConversationSubscriptions.set('replacement', replacementTombstone); resolveSafe({ ack: { subscriptionId: 'stale-safe-subscription' } }); await safe;
  assert.equal(broker.protocol, replacementProtocol); assert.equal(broker.conversationSubscriptions.size, 0); assert.equal(broker.orphanedConversationSubscriptions.size, 1); assert.equal(broker.orphanedConversationSubscriptions.get('replacement'), replacementTombstone); assert.equal(broker.pendingConversationTopics.size, 0); assert.equal(writes.filter((frame) => frame.error).length, 2); await rm(directory, { recursive: true, force: true });
});

test('a stale malformed direct unsubscribe acknowledgement cannot add old-generation evidence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-unsubscribe-generation-cas-')); const ownerId = 'unsubscribe-generation-owner'; const sessionId = 'unsubscribe-generation-session'; const topic = `conversation/${sessionId}`; const subscriptionId = 'unsubscribe-generation-subscription'; const connectionId = 'unsubscribe-generation-connection'; const writes = []; const socket = { writable: true, zcodeWriter: { write: (line) => writes.push(JSON.parse(line)) }, destroy() {} }; const broker = newTestBroker({ endpoint: join(directory, 'broker.sock'), brokerToken: '1'.repeat(64), workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } }); broker.authenticated.add(socket); broker.socketOwnerIds.set(socket, ownerId); broker.sessionOwners.set(sessionId, { ownerId, socket }); broker.reloadOwnership = async () => {}; const key = JSON.stringify([topic, subscriptionId]); broker.conversationSubscriptions.set(key, { socket, topic, subscriptionId, connectionId, sessionId, ownerId }); let resolveUnsubscribe; let unsubscribeEntered; const entered = new Promise((resolvePromise) => { unsubscribeEntered = resolvePromise; }); let oldCloseCalls = 0; const oldProtocol = { request: () => { unsubscribeEntered(); return new Promise((resolvePromise) => { resolveUnsubscribe = resolvePromise; }); }, close: async () => { oldCloseCalls += 1; } }; broker.protocol = oldProtocol;
  const unsubscribing = broker.handleLocal(socket, JSON.stringify({ id: 81, method: 'v4/conversation/unsubscribe', params: { topic, subscriptionId, connectionId } })); await entered; broker.clearProtocolGeneration(oldProtocol); const replacementProtocol = {}; const replacementTombstone = { key: 'replacement-unsubscribe-generation', protocol: replacementProtocol }; broker.protocol = replacementProtocol; broker.orphanedConversationSubscriptions.set(replacementTombstone.key, replacementTombstone); resolveUnsubscribe({ malformed: true }); await unsubscribing;
  assert.equal(broker.protocol, replacementProtocol); assert.equal(broker.orphanedConversationSubscriptions.size, 1); assert.equal(broker.orphanedConversationSubscriptions.get(replacementTombstone.key), replacementTombstone); assert.equal(oldCloseCalls, 1); assert.equal(writes.find((frame) => frame.id === 81)?.result, undefined); assert.equal(broker.admission.activeCount, 0); await rm(directory, { recursive: true, force: true });
});

test('conversation routing revalidates current ownership and enforces pending frame bounds', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-conversation-bounds-')); const writes = [];
  const broker = newTestBroker({ endpoint: join(directory, 'broker.sock'), brokerToken: 'f'.repeat(64), workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } });
  const socket = { writable: true, zcodeWriter: { write: (line) => writes.push(JSON.parse(line)) }, destroy() {} }; const sessionId = 'bounded-conversation-session'; const topic = `conversation/${sessionId}`; const subscriptionId = 'bounded-subscription'; const message = { method: 'v4/conversation/frame', params: { topic, subscriptionId, frame: { payload: 'safe' } } };
  broker.sessionOwners.set(sessionId, { ownerId: 'original-owner-stable', socket, claimToken: null }); broker.conversationSubscriptions.set(JSON.stringify([topic, subscriptionId]), { socket, topic, subscriptionId, connectionId: 'connection-1', sessionId, ownerId: 'original-owner-stable' });
  broker.routeConversationFrame(message); assert.equal(writes.length, 1);
  broker.sessionOwners.set(sessionId, { ownerId: 'replacement-owner-stable', socket: null, claimToken: null }); broker.routeConversationFrame(message); assert.equal(writes.length, 1);
  broker.conversationSubscriptions.clear(); broker.pendingConversationTopics.set(topic, { socket, token: 'pending-token', frames: [], bytes: 0 }); broker.routeConversationFrame({ ...message, params: { ...message.params, frame: { payload: 'x'.repeat(70 * 1024) } } }); assert.equal(broker.pendingConversationTopics.get(topic).frames.length, 0);
  for (let index = 0; index < 16; index += 1) broker.routeConversationFrame({ ...message, params: { ...message.params, frame: { payload: String(index) } } }); broker.routeConversationFrame(message); assert.equal(broker.pendingConversationTopics.get(topic).frames.length, 16);
  await rm(directory, { recursive: true, force: true });
});

test('conversation subscription admission and disconnect cleanup are globally bounded', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-conversation-global-bound-')); const writes = []; const calls = [];
  const broker = newTestBroker({ endpoint: join(directory, 'broker.sock'), brokerToken: '0'.repeat(64), workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } }); const socket = { writable: true, zcodeWriter: { write: (line) => writes.push(JSON.parse(line)) }, destroy() {} }; const ownerId = 'bounded-owner-stable'; const sessionId = 'bounded-session';
  broker.authenticated.add(socket); broker.socketOwnerIds.set(socket, ownerId); broker.sessionOwners.set(sessionId, { ownerId, socket, claimToken: null }); broker.reloadOwnership = async () => {};
  for (let index = 0; index < 256; index += 1) broker.conversationSubscriptions.set(`seed-${index}`, { socket: {}, topic: `conversation/seed-${index}`, subscriptionId: `sub-${index}`, connectionId: `connection-${index}`, sessionId: `seed-${index}`, ownerId });
  broker.getProtocol = async () => ({ request: async (...args) => { calls.push(args); return {}; } });
  await broker.handleLocal(socket, JSON.stringify({ id: 1, method: 'v4/conversation/subscribe', params: { topic: `conversation/${sessionId}`, connectionId: 'bounded-connection', clientMode: 'desktop-continuous' } })); assert.equal(calls.length, 0); assert.equal(writes.at(-1).error.data.pluginError.code, 'ZCODE_BROKER_INPUT_INVALID');
  broker.conversationSubscriptions.clear(); broker.conversationSubscriptions.set('exact', { socket, topic: `conversation/${sessionId}`, subscriptionId: 'exact-subscription', connectionId: 'exact-connection', sessionId, ownerId }); broker.protocol = { request: async (...args) => { calls.push(args); return {}; } }; await broker.cleanupSocketSubscriptions(socket); assert.deepEqual(calls.at(-1), ['v4/conversation/unsubscribe', { topic: `conversation/${sessionId}`, subscriptionId: 'exact-subscription', connectionId: 'exact-connection' }, 250]); assert.equal(broker.conversationSubscriptions.size, 0);
  await rm(directory, { recursive: true, force: true });
});

test('three hundred malformed unsubscribe acknowledgements cannot spawn overlapping retired generations', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-malformed-unsubscribe-cap-')); const ownerId = 'malformed-unsubscribe-cap-owner'; const writes = []; const socket = { writable: true, destroyed: false, zcodeWriter: { write: (line) => writes.push(JSON.parse(line)) }, destroy() {} }; const broker = newTestBroker({ endpoint: join(directory, 'broker.sock'), brokerToken: '7'.repeat(64), workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } }); broker.authenticated.add(socket); broker.socketOwnerIds.set(socket, ownerId); broker.reloadOwnership = async () => {}; let subscribeCalls = 0; let unsubscribeCalls = 0; let closeCalls = 0;
  const protocol = { request: async (method, params) => { if (method === 'v4/conversation/subscribe') { subscribeCalls += 1; return { ack: { subscriptionId: `malformed-unsubscribe-${params.topic}`, mode: 'snapshot', logEpoch: 'malformed-epoch' } }; } unsubscribeCalls += 1; return { malformed: true }; }, close: () => { closeCalls += 1; return new Promise(() => {}); } }; broker.protocol = protocol;
  for (let index = 0; index < 300; index += 1) {
    const sessionId = `malformed-unsubscribe-session-${index}`; broker.sessionOwners.set(sessionId, { ownerId, socket, claimToken: null }); const subscriptionId = `malformed-unsubscribe-conversation/${sessionId}`; const connectionId = `malformed-connection-${index}`; const subscribeId = 1_000 + index * 2; await broker.handleLocal(socket, JSON.stringify({ id: subscribeId, method: 'v4/conversation/subscribe', params: { topic: `conversation/${sessionId}`, connectionId, clientMode: 'desktop-continuous' } })); if (writes.find((frame) => frame.id === subscribeId)?.result) await broker.handleLocal(socket, JSON.stringify({ id: subscribeId + 1, method: 'v4/conversation/unsubscribe', params: { topic: `conversation/${sessionId}`, subscriptionId, connectionId } }));
  }
  assert.equal(subscribeCalls, 1); assert.equal(unsubscribeCalls, 1); assert.equal(closeCalls, 1); assert.equal(broker.orphanedConversationSubscriptions.size, 1); assert.equal(broker.conversationSubscriptions.size, 0); assert.equal(broker.admission.activeCount, 0); assert.equal(broker.retiredProtocolGeneration?.protocol, protocol); await rm(directory, { recursive: true, force: true });
});

test('cleanup and retry validate exact empty unsubscribe acknowledgements and reap evidence only after close', async (t) => {
  for (const retry of [false, true]) await t.test(retry ? 'retry' : 'cleanup', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-malformed-unsubscribe-cleanup-')); const broker = newTestBroker({ endpoint: join(directory, 'broker.sock'), brokerToken: '2'.repeat(64), workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } }); const record = { key: `malformed-${retry}`, topic: `conversation/malformed-${retry}`, subscriptionId: `malformed-sub-${retry}`, connectionId: `malformed-connection-${retry}`, sessionId: `malformed-${retry}`, ownerId: 'malformed-cleanup-owner' }; let closeCalls = 0; const protocol = { request: async () => ({ extra: true }), close: async () => { closeCalls += 1; } }; broker.protocol = protocol;
    if (retry) { await broker.unsubscribeConversationRecords(protocol, [record], 0); await broker.retryOrphanedSubscriptions(protocol, 250); } else await broker.unsubscribeConversationRecords(protocol, [record], 250);
    assert.equal(broker.orphanedConversationSubscriptions.has(record.key), false); assert.equal(broker.protocol, null); assert.equal(broker.retiredProtocolGeneration, null); assert.equal(closeCalls, 1); await rm(directory, { recursive: true, force: true });
  });
  await t.test('old-generation-late-result', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-unsubscribe-old-generation-')); const broker = newTestBroker({ endpoint: join(directory, 'broker.sock'), brokerToken: '3'.repeat(64), workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } }); const record = { key: 'old-generation-unsubscribe', topic: 'conversation/old-generation-unsubscribe', subscriptionId: 'old-generation-sub', connectionId: 'old-generation-connection', sessionId: 'old-generation-unsubscribe', ownerId: 'old-generation-owner' }; let resolveRequest; const oldProtocol = { request: () => new Promise((resolvePromise) => { resolveRequest = resolvePromise; }) }; const replacement = {}; broker.protocol = oldProtocol; const cleaning = broker.unsubscribeConversationRecords(oldProtocol, [record], 250); await new Promise((resolvePromise) => setImmediate(resolvePromise)); const retired = broker.clearProtocolGeneration(oldProtocol); await retired.closePromise; broker.protocol = replacement; resolveRequest({}); await cleaning; assert.equal(broker.orphanedConversationSubscriptions.has(record.key), false); assert.equal(broker.protocol, replacement); await rm(directory, { recursive: true, force: true });
  });
  await t.test('malformed-retry-fences-subscribe-continuation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-unsubscribe-retry-generation-')); const ownerId = 'retry-generation-owner'; const sessionId = 'retry-generation-session'; const topic = `conversation/${sessionId}`; const writes = []; const socket = { writable: true, zcodeWriter: { write: (line) => writes.push(JSON.parse(line)) }, destroy() {} }; const broker = newTestBroker({ endpoint: join(directory, 'broker.sock'), brokerToken: '5'.repeat(64), workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } }); broker.authenticated.add(socket); broker.socketOwnerIds.set(socket, ownerId); broker.sessionOwners.set(sessionId, { ownerId, socket }); broker.reloadOwnership = async () => {}; const orphan = { key: 'retry-generation-orphan', topic: 'conversation/retry-generation-orphan', subscriptionId: 'retry-generation-orphan-sub', connectionId: 'retry-generation-orphan-connection', sessionId: 'retry-generation-orphan', ownerId }; let subscribeCalls = 0; const protocol = { request: async (method) => { if (method === 'v4/conversation/unsubscribe') return { malformed: true }; subscribeCalls += 1; return { ack: { subscriptionId: 'must-not-enter', mode: 'snapshot', logEpoch: 'must-not-enter' } }; }, close: async () => {} }; broker.protocol = protocol; await broker.unsubscribeConversationRecords(protocol, [orphan], 0);
    await broker.handleLocal(socket, JSON.stringify({ id: 99, method: 'v4/conversation/subscribe', params: { topic, connectionId: 'retry-generation-connection', clientMode: 'desktop-continuous' } })); assert.equal(subscribeCalls, 0); assert.equal(broker.protocol, null); assert.equal(writes.at(-1)?.result, undefined); assert.equal(broker.admission.activeCount, 0); await rm(directory, { recursive: true, force: true });
  });
});

test('failed upstream unsubscribe becomes a bounded non-routing orphan and retries later', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-conversation-orphan-')); const writes = []; let failUnsubscribe = true; const calls = [];
  const broker = newTestBroker({ endpoint: join(directory, 'broker.sock'), brokerToken: '9'.repeat(64), workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } }); const socket = { writable: true, zcodeWriter: { write: (line) => writes.push(JSON.parse(line)) }, destroy() {} }; const ownerId = 'orphan-owner-stable'; const sessionId = 'orphan-session'; const topic = `conversation/${sessionId}`; const subscriptionId = 'orphan-subscription';
  const protocol = { request: async (...args) => { calls.push(args); if (args[0] === 'v4/conversation/unsubscribe' && failUnsubscribe) throw new Error('upstream unavailable'); return {}; } }; broker.protocol = protocol;
  broker.conversationSubscriptions.set(JSON.stringify([topic, subscriptionId]), { socket, topic, subscriptionId, connectionId: 'orphan-connection', sessionId, ownerId }); await broker.cleanupSocketSubscriptions(socket);
  assert.equal(broker.conversationSubscriptions.size, 0); assert.equal(broker.orphanedConversationSubscriptions.size, 1);
  broker.routeConversationFrame({ method: 'v4/conversation/frame', params: { topic, subscriptionId, frame: { payload: 'must not route' } } }); assert.equal(writes.length, 0);
  for (let index = 0; index < 255; index += 1) broker.conversationSubscriptions.set(`active-${index}`, { socket: {}, topic: `conversation/active-${index}`, subscriptionId: `active-${index}`, connectionId: `active-${index}`, sessionId: `active-${index}`, ownerId });
  broker.authenticated.add(socket); broker.socketOwnerIds.set(socket, ownerId); broker.sessionOwners.set(sessionId, { ownerId, socket, claimToken: null }); broker.reloadOwnership = async () => {};
  await broker.handleLocal(socket, JSON.stringify({ id: 1, method: 'v4/conversation/subscribe', params: { topic, connectionId: 'replacement-connection', clientMode: 'desktop-continuous' } })); assert.equal(writes.at(-1).error.data.pluginError.code, 'ZCODE_BROKER_INPUT_INVALID'); assert.equal(broker.orphanedConversationSubscriptions.size, 1);
  failUnsubscribe = false; await new Promise((resolvePromise) => setTimeout(resolvePromise, 60)); await broker.retryOrphanedSubscriptions(protocol, 250); assert.equal(broker.orphanedConversationSubscriptions.size, 0); assert.ok(calls.length >= 2);
  await rm(directory, { recursive: true, force: true });
});

test('conversation orphan retries are coalesced bounded and cannot resurrect after a newer ack', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-conversation-orphan-race-')); const broker = newTestBroker({ endpoint: join(directory, 'broker.sock'), brokerToken: '8'.repeat(64), workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } }); const protocol = { request: async () => ({}) }; broker.protocol = protocol;
  for (let index = 0; index < 9; index += 1) await broker.unsubscribeConversationRecords(protocol, [{ key: `orphan-${index}`, topic: `conversation/orphan-${index}`, subscriptionId: `subscription-${index}`, connectionId: `connection-${index}`, sessionId: `orphan-${index}`, ownerId: 'orphan-race-owner' }], 0);
  let retryCalls = 0; protocol.request = async () => { retryCalls += 1; await new Promise((resolvePromise) => setTimeout(resolvePromise, 10)); return {}; };
  await Promise.all([broker.retryOrphanedSubscriptions(protocol, 250), broker.retryOrphanedSubscriptions(protocol, 250)]); assert.equal(retryCalls, 8); assert.equal(broker.orphanedConversationSubscriptions.size, 1);
  const record = { key: 'raced-orphan', topic: 'conversation/raced', subscriptionId: 'raced-subscription', connectionId: 'raced-connection', sessionId: 'raced', ownerId: 'orphan-race-owner' }; let resolveFirst; let rejectFirst; let resolveSecond; let call = 0;
  protocol.request = () => { call += 1; return new Promise((resolvePromise, rejectPromise) => { if (call === 1) { resolveFirst = resolvePromise; rejectFirst = rejectPromise; } else resolveSecond = resolvePromise; }); };
  const first = broker.unsubscribeConversationRecords(protocol, [record], 250); const second = broker.unsubscribeConversationRecords(protocol, [record], 250); await new Promise((resolvePromise) => setImmediate(resolvePromise)); resolveSecond({}); await second; rejectFirst(new Error('late failure')); await first; assert.equal(broker.orphanedConversationSubscriptions.has(record.key), false); void resolveFirst;
  const nullProtocolSocket = {}; broker.conversationSubscriptions.set('null-protocol', { socket: nullProtocolSocket, topic: 'conversation/null-protocol', subscriptionId: 'null-subscription', connectionId: 'null-connection', sessionId: 'null-protocol', ownerId: 'orphan-race-owner' }); broker.protocol = null; await broker.cleanupSocketSubscriptions(nullProtocolSocket); assert.equal(broker.orphanedConversationSubscriptions.has('null-protocol'), true);
  await rm(directory, { recursive: true, force: true });
});

test('malformed subscribe cleanup failure retains a non-routing orphan tombstone', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-conversation-malformed-cleanup-')); const writes = []; const broker = newTestBroker({ endpoint: join(directory, 'broker.sock'), brokerToken: '7'.repeat(64), workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } }); const socket = { writable: true, zcodeWriter: { write: (line) => writes.push(JSON.parse(line)) }, destroy() {} }; const ownerId = 'malformed-cleanup-owner'; const sessionId = 'malformed-cleanup-session'; const topic = `conversation/${sessionId}`;
  broker.authenticated.add(socket); broker.socketOwnerIds.set(socket, ownerId); broker.sessionOwners.set(sessionId, { ownerId, socket, claimToken: null }); broker.reloadOwnership = async () => {};
  const protocol = { request: async (method) => { if (method === 'v4/conversation/subscribe') { broker.pendingConversationTopics.delete(topic); return { ack: { subscriptionId: 'safe-subscription' } }; } throw new Error('unsubscribe failed'); } }; broker.protocol = protocol;
  await broker.handleLocal(socket, JSON.stringify({ id: 1, method: 'v4/conversation/subscribe', params: { topic, connectionId: 'malformed-connection', clientMode: 'desktop-continuous' } })); assert.equal(writes.at(-1).error.data.pluginError.code, 'ZCODE_BROKER_INPUT_INVALID'); assert.equal(broker.orphanedConversationSubscriptions.size, 1); broker.routeConversationFrame({ method: 'v4/conversation/frame', params: { topic, subscriptionId: 'safe-subscription' } }); assert.equal(writes.length, 1);
  await rm(directory, { recursive: true, force: true });
});

test('owner release cleans sixteen slow subscriptions within one shared budget', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-release-cleanup-budget-')); const endpoint = join(directory, 'broker.sock'); const ownerId = 'release-budget-owner'; const socket = { writable: true, destroyed: false, zcodeWriter: { write() {} }, destroy() {} }; const broker = newTestBroker({ endpoint, brokerToken: 'a'.repeat(64), workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } }); const sessions = {};
  for (let index = 0; index < 16; index += 1) { const sessionId = `budget-session-${index}`; sessions[sessionId] = ownerId; broker.sessionOwners.set(sessionId, { ownerId, socket, claimToken: null }); broker.conversationSubscriptions.set(`budget-${index}`, { socket, topic: `conversation/${sessionId}`, subscriptionId: `budget-sub-${index}`, connectionId: `budget-connection-${index}`, sessionId, ownerId }); }
  await writeFile(`${endpoint}.owners.json`, JSON.stringify({ version: 1, sessions })); broker.ownershipStoreEstablished = true; let unsubscribeCalls = 0;
  broker.protocol = { request: async (method) => { if (method === 'session/stop') return {}; unsubscribeCalls += 1; await new Promise((resolvePromise) => setTimeout(resolvePromise, 80)); throw new Error('slow unsubscribe failure'); }, cancelTurn() {} };
  const started = Date.now(); const released = await broker.releaseOwner(socket, ownerId, []); const elapsed = Date.now() - started;
  assert.equal(released.releasedSessionIds.length, 16); assert.equal(released.failedSessionIds.length, 0); assert.equal(unsubscribeCalls, 16); assert.ok(elapsed < 750, `release cleanup exceeded its shared budget: ${elapsed}ms`); assert.equal(broker.orphanedConversationSubscriptions.size, 16);
  await rm(directory, { recursive: true, force: true });
});

test('owner release never waits for malformed-unsubscribe protocol close cleanup', async (t) => {
  for (const closeMode of ['1000ms', 'nonsettle']) await t.test(closeMode, { timeout: 2_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-release-close-budget-')); const endpoint = join(directory, 'broker.sock'); const ownershipPath = `${endpoint}.owners.json`; const ownerId = `release-close-owner-${closeMode}`; const sessionId = `release-close-session-${closeMode}`; const socket = { writable: true, destroyed: false, zcodeWriter: { write() {} }, destroy() {} }; const broker = newTestBroker({ endpoint, ownershipPath, brokerToken: '9'.repeat(64), workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } }); broker.sessionOwners.set(sessionId, { ownerId, socket }); broker.conversationSubscriptions.set('release-close-subscription', { socket, topic: `conversation/${sessionId}`, subscriptionId: `release-close-sub-${closeMode}`, connectionId: `release-close-connection-${closeMode}`, sessionId, ownerId }); await writeFile(ownershipPath, JSON.stringify({ version: 1, sessions: { [sessionId]: ownerId } })); broker.ownershipStoreEstablished = true; let closeCalls = 0; const protocol = { request: async (method) => method === 'session/stop' ? {} : { malformed: true }, cancelTurn() {}, close: () => { closeCalls += 1; if (closeMode === 'nonsettle') return new Promise(() => {}); return new Promise((resolvePromise) => { const timer = setTimeout(resolvePromise, 1_000); timer.unref?.(); }); } }; broker.protocol = protocol;
    const started = Date.now(); let timeout; const timedOut = Symbol('release-timeout'); const outcome = await Promise.race([broker.releaseOwner(socket, ownerId, []), new Promise((resolvePromise) => { timeout = setTimeout(() => resolvePromise(timedOut), 700); })]); clearTimeout(timeout); const elapsed = Date.now() - started;
    assert.notEqual(outcome, timedOut); assert.ok(elapsed < 550, `release waited for protocol close cleanup: ${elapsed}ms`); assert.deepEqual(outcome.releasedSessionIds, []); assert.deepEqual(outcome.failedSessionIds, [sessionId]); assert.equal(closeCalls, 1); assert.equal(broker.orphanedConversationSubscriptions.size, 1); assert.equal(broker.sessionOwners.get(sessionId)?.ownerId, ownerId); assert.equal(JSON.parse(await readFile(ownershipPath, 'utf8')).sessions[sessionId], ownerId); await rm(directory, { recursive: true, force: true });
  });
});

test('owner release preserves ownership while a retired protocol is pending or failed', async (t) => {
  for (const closeMode of ['pending', 'failed']) await t.test(closeMode, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-release-retired-')); const endpoint = join(directory, 'broker.sock'); const ownershipPath = `${endpoint}.owners.json`; const ownerId = `release-retired-${closeMode}-owner`; const sessionId = `release-retired-${closeMode}-session`; const socket = { writable: true, destroyed: false, zcodeWriter: { write() {} }, destroy() {} }; const broker = newTestBroker({ endpoint, ownershipPath, brokerToken: '8'.repeat(64), workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } }); broker.sessionOwners.set(sessionId, { ownerId, socket }); await writeFile(ownershipPath, JSON.stringify({ version: 1, sessions: { [sessionId]: ownerId } })); broker.ownershipStoreEstablished = true; let closeCalls = 0; const closeError = new Error('retired close failed'); const protocol = { close: () => { closeCalls += 1; return closeMode === 'pending' ? new Promise(() => {}) : Promise.reject(closeError); } }; broker.protocol = protocol; const retired = broker.clearProtocolGeneration(protocol); if (closeMode === 'failed') { await retired.closePromise; assert.equal(retired.error, closeError); }
    const released = await broker.releaseOwner(socket, ownerId, []); assert.deepEqual(released.releasedSessionIds, []); assert.deepEqual(released.failedSessionIds, [sessionId]); assert.equal(released.deferredSessionCount, 0); assert.equal(closeCalls, 1); assert.equal(broker.retiredProtocolGeneration, retired); assert.equal(broker.sessionOwners.get(sessionId)?.ownerId, ownerId); assert.equal(JSON.parse(await readFile(ownershipPath, 'utf8')).sessions[sessionId], ownerId); assert.equal(broker.stoppingSessions.has(sessionId), false); await rm(directory, { recursive: true, force: true });
  });
});

test('owner release keeps its stop fence through durable ownership commit', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-release-commit-fence-')); const endpoint = join(directory, 'broker.sock'); const ownershipPath = `${endpoint}.owners.json`; const ownerId = 'release-commit-owner'; const sessionId = 'release-commit-session'; const writes = []; let sendCalls = 0; let readCalls = 0;
  const socket = { writable: true, destroyed: false, zcodeWriter: { write: (line) => writes.push(JSON.parse(line)) }, destroy() {} }; const broker = newTestBroker({ endpoint, brokerToken: 'b'.repeat(64), workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } }); broker.authenticated.add(socket); broker.socketOwnerIds.set(socket, ownerId); broker.sessionOwners.set(sessionId, { ownerId, socket, claimToken: null }); broker.activeSessionSockets.set(sessionId, { socket, token: 'release-active', baseline: 1, inputId: 'release-input' }); broker.activeSessions.add(sessionId); await writeFile(ownershipPath, JSON.stringify({ version: 1, sessions: { [sessionId]: ownerId } })); broker.ownershipStoreEstablished = true; broker.protocol = { request: async (method) => { if (method === 'session/send') sendCalls += 1; if (method === 'session/read') readCalls += 1; return {}; }, cancelTurn() {} };
  let releaseLock; let lockEntered; const gate = new Promise((resolvePromise) => { releaseLock = resolvePromise; }); const entered = new Promise((resolvePromise) => { lockEntered = resolvePromise; }); const holder = withFileLock(`${ownershipPath}.lock`, async () => { lockEntered(); await gate; }); await entered;
  const releasing = broker.releaseOwner(socket, ownerId, []); await new Promise((resolvePromise) => setTimeout(resolvePromise, 40)); const fencedDuringCommit = broker.stoppingSessions.has(sessionId); const sending = broker.handleLocal(socket, JSON.stringify({ id: 91, method: 'session/send', params: { sessionId, inputId: 'new-input', content: 'must reject' } })); const reading = broker.handleLocal(socket, JSON.stringify({ id: 92, method: 'session/read', params: { sessionId } })); await new Promise((resolvePromise) => setTimeout(resolvePromise, 20)); assert.equal(sendCalls, 0); assert.equal(readCalls, 0);
  releaseLock(); await holder; const released = await releasing; await Promise.all([sending, reading]); assert.equal(fencedDuringCommit, true); assert.deepEqual(released.releasedSessionIds, [sessionId]); assert.equal(broker.sessionOwners.has(sessionId), false); assert.equal(broker.activeSessionSockets.has(sessionId), false); assert.equal(writes.filter((frame) => frame.error).length, 2); await rm(directory, { recursive: true, force: true });
});

test('owner release fences a session without an existing protocol through durable ownership commit', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-release-no-protocol-fence-')); const endpoint = join(directory, 'broker.sock'); const ownershipPath = `${endpoint}.owners.json`; const ownerId = 'release-no-protocol-owner'; const sessionId = 'release-no-protocol-session'; const socket = { writable: true, destroyed: false, zcodeWriter: { write() {} }, destroy() {} }; const broker = newTestBroker({ endpoint, brokerToken: 'd'.repeat(64), workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } }); broker.sessionOwners.set(sessionId, { ownerId, socket, claimToken: null }); await writeFile(ownershipPath, JSON.stringify({ version: 1, sessions: { [sessionId]: ownerId } })); broker.ownershipStoreEstablished = true;
  let releaseLock; let lockEntered; const gate = new Promise((resolvePromise) => { releaseLock = resolvePromise; }); const entered = new Promise((resolvePromise) => { lockEntered = resolvePromise; }); const holder = withFileLock(`${ownershipPath}.lock`, async () => { lockEntered(); await gate; }); await entered; const releasing = broker.releaseOwner(socket, ownerId, []); await new Promise((resolvePromise) => setTimeout(resolvePromise, 40)); const fencedDuringCommit = broker.stoppingSessions.has(sessionId);
  releaseLock(); await holder; const released = await releasing; assert.equal(fencedDuringCommit, true); assert.deepEqual(released.releasedSessionIds, [sessionId]); assert.equal(broker.sessionOwners.has(sessionId), false); assert.equal(broker.stoppingSessions.has(sessionId), false); await rm(directory, { recursive: true, force: true });
});

test('protocol reset invalidates an owner release acknowledgement and clears its exact fence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-release-reset-fence-')); const endpoint = join(directory, 'broker.sock'); const ownershipPath = `${endpoint}.owners.json`; const ownerId = 'release-reset-owner'; const sessionId = 'release-reset-session'; const socket = { writable: true, destroyed: false, zcodeWriter: { write() {} }, destroy() {} }; const broker = newTestBroker({ endpoint, brokerToken: 'e'.repeat(64), workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } }); broker.sessionOwners.set(sessionId, { ownerId, socket, claimToken: null }); await writeFile(ownershipPath, JSON.stringify({ version: 1, sessions: { [sessionId]: ownerId } })); broker.ownershipStoreEstablished = true; const protocol = { request: async () => { queueMicrotask(() => broker.clearProtocolGeneration(protocol)); return {}; }, cancelTurn() {} }; broker.protocol = protocol;
  let releaseLock; let lockEntered; const gate = new Promise((resolvePromise) => { releaseLock = resolvePromise; }); const entered = new Promise((resolvePromise) => { lockEntered = resolvePromise; }); const holder = withFileLock(`${ownershipPath}.lock`, async () => { lockEntered(); await gate; }); await entered; const releasing = broker.releaseOwner(socket, ownerId, []); await new Promise((resolvePromise) => setTimeout(resolvePromise, 40)); const fencedAfterReset = broker.stoppingSessions.has(sessionId);
  releaseLock(); await holder; const released = await releasing; assert.equal(fencedAfterReset, false); assert.deepEqual(released.releasedSessionIds, []); assert.deepEqual(released.failedSessionIds, [sessionId]); assert.equal(broker.sessionOwners.get(sessionId)?.ownerId, ownerId); assert.equal(JSON.parse(await readFile(ownershipPath, 'utf8')).sessions[sessionId], ownerId); assert.equal(broker.stoppingSessions.has(sessionId), false); await rm(directory, { recursive: true, force: true });
});

test('one session admission prevents subscribe and owner release from entering the same upstream batch', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-release-subscribe-admission-')); const endpoint = join(directory, 'broker.sock'); const ownershipPath = `${endpoint}.owners.json`; const ownerId = 'release-subscribe-admission-owner'; const sessionId = 'release-subscribe-admission-session'; const writes = []; const socket = { writable: true, destroyed: false, zcodeWriter: { write: (line) => writes.push(JSON.parse(line)) }, destroy() {} }; await writeFile(ownershipPath, JSON.stringify({ version: 1, sessions: { [sessionId]: ownerId } })); const broker = newTestBroker({ endpoint, ownershipPath, brokerToken: 'a'.repeat(64), workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } }); broker.ownershipStoreEstablished = true; broker.sessionOwners.set(sessionId, { ownerId, socket, claimToken: null }); broker.authenticated.add(socket); broker.socketOwnerIds.set(socket, ownerId); broker.reloadOwnership = async () => {}; let resolveStop; let stopCalls = 0; let subscribeCalls = 0; const protocol = { request: (method) => { if (method === 'session/stop') { stopCalls += 1; return new Promise((resolvePromise) => { resolveStop = resolvePromise; }); } subscribeCalls += 1; return Promise.resolve({ ack: { subscriptionId: 'must-not-subscribe', mode: 'snapshot', logEpoch: 'must-not-subscribe' } }); }, cancelTurn() {} }; broker.protocol = protocol;
  const releasing = broker.releaseOwner(socket, ownerId, []); while (!stopCalls) await new Promise((resolvePromise) => setImmediate(resolvePromise)); await broker.handleLocal(socket, JSON.stringify({ id: 60, method: 'v4/conversation/subscribe', params: { topic: `conversation/${sessionId}`, connectionId: 'release-subscribe-admission', clientMode: 'desktop-continuous' } })); assert.equal(subscribeCalls, 0); assert.equal(writes.find((frame) => frame.id === 60)?.error?.data?.pluginError?.code, 'ZCODE_TURN_ACTIVE'); resolveStop({}); const released = await releasing; assert.deepEqual(released.releasedSessionIds, [sessionId]); assert.equal(broker.sessionOwners.has(sessionId), false); assert.equal(broker.stoppingSessions.has(sessionId), false); await rm(directory, { recursive: true, force: true });
});

test('owner release compensates when its protocol generation resets during the durable write', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-release-write-generation-')); const endpoint = join(directory, 'broker.sock'); const ownershipPath = `${endpoint}.owners.json`; const ownerId = 'release-write-generation-owner'; const sessionId = 'release-write-generation-session'; const socket = { writable: true, destroyed: false, zcodeWriter: { write() {} }, destroy() {} }; const broker = newTestBroker({ endpoint, brokerToken: '0'.repeat(64), workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } }); broker.sessionOwners.set(sessionId, { ownerId, socket, claimToken: null }); await writeFile(ownershipPath, JSON.stringify({ version: 1, sessions: { [sessionId]: ownerId } })); broker.ownershipStoreEstablished = true; const protocol = { request: async () => ({}), cancelTurn() {} }; broker.protocol = protocol; let writeApplied; let resumeWrite; const applied = new Promise((resolvePromise) => { writeApplied = resolvePromise; }); const gate = new Promise((resolvePromise) => { resumeWrite = resolvePromise; }); let writes = 0; broker.writeOwnerStore = async (sessions) => { writes += 1; await atomicWriteJson(ownershipPath, { version: 1, sessions }); if (writes === 1) { writeApplied(); await gate; } };
  const releasing = broker.releaseOwner(socket, ownerId, []); await applied; broker.clearProtocolGeneration(protocol); resumeWrite(); const result = await releasing; assert.deepEqual(result.releasedSessionIds, []); assert.deepEqual(result.failedSessionIds, [sessionId]); assert.equal(writes, 2); assert.equal(broker.sessionOwners.get(sessionId)?.ownerId, ownerId); assert.equal(JSON.parse(await readFile(ownershipPath, 'utf8')).sessions[sessionId], ownerId); assert.equal(broker.stoppingSessions.has(sessionId), false); await rm(directory, { recursive: true, force: true });
});

test('owner release aborts its unlocked winner read after a reset compensation misses the deadline', { timeout: 1_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-release-compensation-deadline-')); const endpoint = join(directory, 'broker.sock'); const ownershipPath = `${endpoint}.owners.json`; const ownerId = 'release-compensation-deadline-owner'; const sessionId = 'release-compensation-deadline-session'; const socket = { writable: true, destroyed: false, zcodeWriter: { write() {} }, destroy() {} }; const broker = newTestBroker({ endpoint, brokerToken: '2'.repeat(64), workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } }); broker.sessionOwners.set(sessionId, { ownerId, socket, claimToken: null }); await writeFile(ownershipPath, JSON.stringify({ version: 1, sessions: { [sessionId]: ownerId } })); broker.ownershipStoreEstablished = true; const protocol = { request: async () => ({}), cancelTurn() {} }; broker.protocol = protocol; let writes = 0; let observedSignal; broker.writeOwnerStore = async (sessions, options) => { writes += 1; if (writes === 1) { await atomicWriteJson(ownershipPath, { version: 1, sessions }); broker.clearProtocolGeneration(protocol); return; } await new Promise((resolvePromise, rejectPromise) => { if (options.signal.aborted) { rejectPromise(options.signal.reason); return; } options.signal.addEventListener('abort', () => rejectPromise(options.signal.reason), { once: true }); }); }; broker.readOwnerStoreUnlocked = async (_allowMissing, options = {}) => { observedSignal = options.signal; if (!options.signal) { await new Promise((resolvePromise) => setTimeout(resolvePromise, 160)); return { exists: true, sessions: Object.create(null) }; } options.signal.throwIfAborted(); return { exists: true, sessions: Object.create(null) }; };
  const started = Date.now(); await assert.rejects(broker.releaseOwner(socket, ownerId, [], started + 80), { code: 'ZCODE_OWNER_RELEASE_TIMEOUT' }); const elapsed = Date.now() - started; assert.ok(elapsed < 180, `release exceeded its deadline while reading the compensation winner: ${elapsed}ms`); while (broker.releaseTasks.size) await new Promise((resolvePromise) => setImmediate(resolvePromise)); assert.equal(observedSignal?.aborted, true); assert.equal(broker.sessionOwners.get(sessionId)?.ownerId, ownerId); assert.equal(broker.uncertainOwnerReleases.get(sessionId), ownerId); assert.equal(broker.stoppingSessions.has(sessionId), false); await rm(directory, { recursive: true, force: true });
});

test('owner release rejects non-object stop results before local or durable side effects', async (t) => {
  for (const [name, invalid] of [['null', null], ['array', []], ['scalar', 7], ['string', 'invalid']]) await t.test(name, async () => {
    const directory = await mkdtemp(join(tmpdir(), `zcode-broker-release-stop-${name}-`)); const endpoint = join(directory, 'broker.sock'); const ownershipPath = `${endpoint}.owners.json`; const ownerId = 'release-invalid-stop-owner'; const sessionId = `release-invalid-stop-${name}`; const socket = { writable: true, destroyed: false, zcodeWriter: { write() {} }, destroy() {} }; const broker = newTestBroker({ endpoint, brokerToken: '1'.repeat(64), workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } }); broker.sessionOwners.set(sessionId, { ownerId, socket, claimToken: null }); await writeFile(ownershipPath, JSON.stringify({ version: 1, sessions: { [sessionId]: ownerId } })); broker.ownershipStoreEstablished = true; let cancelCalls = 0; broker.protocol = { request: async () => invalid, cancelTurn: () => { cancelCalls += 1; } };
    const result = await broker.releaseOwner(socket, ownerId, []); assert.deepEqual(result.releasedSessionIds, []); assert.deepEqual(result.failedSessionIds, [sessionId]); assert.equal(cancelCalls, 0); assert.equal(broker.sessionOwners.get(sessionId)?.ownerId, ownerId); assert.equal(JSON.parse(await readFile(ownershipPath, 'utf8')).sessions[sessionId], ownerId); assert.equal(broker.stoppingSessions.has(sessionId), false); await rm(directory, { recursive: true, force: true });
  });
});

test('owner operation leases make pending read model and resume RPCs mutually exclusive with release', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-owner-operation-leases-')); const endpoint = join(directory, 'broker.sock'); const ownershipPath = `${endpoint}.owners.json`; const ownerId = 'owner-operation-lease-owner'; const sessionId = 'owner-operation-lease-session'; const writes = []; const socket = { writable: true, destroyed: false, zcodeWriter: { write: (line) => writes.push(JSON.parse(line)) }, destroy() {} }; const broker = newTestBroker({ endpoint, brokerToken: 'b'.repeat(64), workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } }); broker.authenticated.add(socket); broker.socketOwnerIds.set(socket, ownerId); broker.sessionOwners.set(sessionId, { ownerId, socket, claimToken: null }); await writeFile(ownershipPath, JSON.stringify({ version: 1, sessions: { [sessionId]: ownerId } })); broker.ownershipStoreEstablished = true; broker.reloadOwnership = async () => {}; const pending = new Map(); let stopCalls = 0; const protocol = { request: (method) => { if (method === 'session/stop') { stopCalls += 1; return Promise.resolve({}); } return new Promise((resolvePromise, rejectPromise) => { pending.set(method, { resolvePromise, rejectPromise }); }); }, cancelTurn() {} }; broker.protocol = protocol; const methods = ['session/read', 'session/setModel', 'session/resume']; const operations = methods.map((method, index) => broker.handleLocal(socket, JSON.stringify({ id: 10 + index, method, params: { sessionId, ...(method === 'session/setModel' ? { model: { providerId: 'fake', modelId: 'model' }, persistAsWorkspaceLastUsed: false } : {}) } }))); while (pending.size !== methods.length) await new Promise((resolvePromise) => setImmediate(resolvePromise));
  const release = await broker.releaseOwner(socket, ownerId, []); assert.deepEqual(release.releasedSessionIds, []); assert.deepEqual(release.failedSessionIds, [sessionId]); assert.equal(stopCalls, 0); assert.equal(broker.sessionOwners.get(sessionId)?.ownerId, ownerId); assert.equal(JSON.parse(await readFile(ownershipPath, 'utf8')).sessions[sessionId], ownerId); for (const method of methods) pending.get(method).resolvePromise({ method }); await Promise.all(operations); assert.equal(writes.filter((frame) => frame.result).length, methods.length); assert.equal(broker.admission.activeSessionCount, 0); await rm(directory, { recursive: true, force: true });
});

test('known durable ownership rejects a foreign request before reload or admission and leaves the owner unblocked', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-known-owner-preflight-')); const endpoint = join(directory, 'broker.sock'); const ownershipPath = `${endpoint}.owners.json`; const ownerA = 'known-owner-preflight-owner-a'; const ownerB = 'known-owner-preflight-owner-b'; const sessionId = 'known-owner-preflight-session'; const writesA = []; const writesB = []; const socketA = { writable: true, destroyed: false, zcodeWriter: { write: (line) => writesA.push(JSON.parse(line)) }, destroy() {} }; const socketB = { writable: true, destroyed: false, zcodeWriter: { write: (line) => writesB.push(JSON.parse(line)) }, destroy() {} }; const broker = newTestBroker({ endpoint, ownershipPath, brokerToken: '2'.repeat(64), workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } }); for (const [socket, ownerId] of [[socketA, ownerA], [socketB, ownerB]]) { broker.authenticated.add(socket); broker.socketOwnerIds.set(socket, ownerId); } broker.sessionOwners.set(sessionId, { ownerId: ownerA, socket: socketA, claimToken: null }); broker.ownershipStoreEstablished = true; await writeFile(ownershipPath, JSON.stringify({ version: 1, sessions: { [sessionId]: ownerA } })); let reloadCalls = 0; let releaseReload; broker.reloadOwnership = async () => { reloadCalls += 1; await new Promise((resolvePromise) => { releaseReload = resolvePromise; }); }; let upstreamCalls = 0; broker.protocol = { request: async (method) => { upstreamCalls += 1; return method === 'session/stop' ? {} : { ok: true }; }, cancelTurn() {} };
  const foreign = broker.handleLocal(socketB, JSON.stringify({ id: 23, method: 'session/stop', params: { sessionId } })); for (let turn = 0; turn < 20 && reloadCalls === 0; turn += 1) await new Promise((resolvePromise) => setImmediate(resolvePromise)); const reloadsBeforeCleanup = reloadCalls; releaseReload?.(); await foreign;
  assert.equal(reloadsBeforeCleanup, 0); assert.equal(writesB.at(-1)?.error?.code, -32041); assert.equal(upstreamCalls, 0); assert.equal(broker.admission.activeCount, 0);
  broker.reloadOwnership = async () => {}; await broker.handleLocal(socketA, JSON.stringify({ id: 24, method: 'session/read', params: { sessionId } })); assert.deepEqual(writesA.at(-1)?.result, { ok: true }); const released = await broker.releaseOwner(socketA, ownerA, []); assert.deepEqual(released.releasedSessionIds, [sessionId]); assert.equal(upstreamCalls, 2); await rm(directory, { recursive: true, force: true });
});

test('foreign clients cannot occupy a known transient create claim', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-transient-owner-preflight-')); const ownerA = 'transient-owner-preflight-owner-a'; const ownerB = 'transient-owner-preflight-owner-b'; const sessionId = 'transient-owner-preflight-session'; const writesA = []; const writesB = []; const socketA = { writable: true, destroyed: false, zcodeWriter: { write: (line) => writesA.push(JSON.parse(line)) }, destroy() {} }; const socketB = { writable: true, destroyed: false, zcodeWriter: { write: (line) => writesB.push(JSON.parse(line)) }, destroy() {} }; const broker = newTestBroker({ endpoint: join(directory, 'broker.sock'), brokerToken: '3'.repeat(64), workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } }); for (const [socket, ownerId] of [[socketA, ownerA], [socketB, ownerB]]) { broker.authenticated.add(socket); broker.socketOwnerIds.set(socket, ownerId); } broker.reloadOwnership = async () => {}; let rejectCreate; let upstreamCalls = 0; broker.protocol = { request: () => { upstreamCalls += 1; return new Promise((_resolvePromise, rejectPromise) => { rejectCreate = rejectPromise; }); } };
  const creating = broker.handleLocal(socketA, JSON.stringify({ id: 25, method: 'session/create', params: brokerCreateParams(directory, sessionId) })); while (!rejectCreate) await new Promise((resolvePromise) => setImmediate(resolvePromise)); await broker.handleLocal(socketB, JSON.stringify({ id: 26, method: 'session/read', params: { sessionId } })); assert.equal(writesB.at(-1)?.error?.code, -32041); assert.equal(upstreamCalls, 1); assert.equal(broker.admission.sessionClaims.get(sessionId)?.ownerId, ownerA); rejectCreate(new Error('finish transient claim')); await creating; assert.equal(broker.admission.activeCount, 0); await rm(directory, { recursive: true, force: true });
});

test('unknown ownership reloads before reservation and corrupt reloads leave no transient lease', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-unknown-owner-preflight-')); const ownerA = 'unknown-owner-preflight-owner-a'; const ownerB = 'unknown-owner-preflight-owner-b'; const sessionId = 'unknown-owner-preflight-session'; const writes = []; const socket = { writable: true, destroyed: false, zcodeWriter: { write: (line) => writes.push(JSON.parse(line)) }, destroy() {} }; const broker = newTestBroker({ endpoint: join(directory, 'broker.sock'), brokerToken: '4'.repeat(64), workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } }); broker.authenticated.add(socket); broker.socketOwnerIds.set(socket, ownerB); let enterReload; let finishReload; const entered = new Promise((resolvePromise) => { enterReload = resolvePromise; }); const gate = new Promise((resolvePromise) => { finishReload = resolvePromise; }); broker.reloadOwnership = async () => { enterReload(); await gate; broker.sessionOwners.set(sessionId, { ownerId: ownerA, socket: null, claimToken: null }); }; let upstreamCalls = 0; broker.protocol = { request: async () => { upstreamCalls += 1; return { ok: true }; } };
  const reading = broker.handleLocal(socket, JSON.stringify({ id: 27, method: 'session/read', params: { sessionId } })); await entered; assert.equal(broker.admission.sessionLeases.has(sessionId), false); finishReload(); await reading; assert.equal(writes.at(-1)?.error?.code, -32041); assert.equal(upstreamCalls, 0); assert.equal(broker.admission.activeCount, 0);
  const corruptSessionId = 'unknown-owner-corrupt-session'; let leaseSeenDuringReload = false; broker.reloadOwnership = async () => { leaseSeenDuringReload = broker.admission.sessionLeases.has(corruptSessionId); throw new PluginError('ZCODE_OWNER_STORE_INVALID', 'corrupt owner store'); }; await broker.handleLocal(socket, JSON.stringify({ id: 28, method: 'session/read', params: { sessionId: corruptSessionId } })); assert.equal(leaseSeenDuringReload, false); assert.equal(writes.at(-1)?.error?.data?.pluginError?.code, 'ZCODE_OWNER_STORE_INVALID'); assert.equal(broker.admission.activeCount, 0); await rm(directory, { recursive: true, force: true });
});

test('owner operation leases reject every owner RPC while an explicit create claim is pending', async (t) => {
  const cases = [
    ['session/read', {}],
    ['session/resume', {}],
    ['session/setModel', { model: { providerId: 'fake', modelId: 'model' }, persistAsWorkspaceLastUsed: false }],
    ['session/setThoughtLevel', { thoughtLevel: 'medium', persistAsWorkspaceLastUsed: false }],
  ];
  for (const [index, [method, extraParams]] of cases.entries()) await t.test(method, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-owner-operation-claim-')); const sessionId = `owner-operation-claim-${index}`; const ownerId = 'owner-operation-claim-owner'; const writes = []; const socket = { writable: true, destroyed: false, zcodeWriter: { write: (line) => writes.push(JSON.parse(line)) }, destroy() {} }; const broker = newTestBroker({ endpoint: join(directory, 'broker.sock'), brokerToken: 'e'.repeat(64), workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } }); broker.authenticated.add(socket); broker.socketOwnerIds.set(socket, ownerId); broker.reloadOwnership = async () => {}; let rejectCreate; let createCalls = 0; let operationCalls = 0; const protocol = { request: (requestedMethod) => { if (requestedMethod === 'session/create') { createCalls += 1; return new Promise((_resolvePromise, rejectPromise) => { rejectCreate = rejectPromise; }); } operationCalls += 1; return Promise.resolve({ applied: true }); } }; broker.protocol = protocol;
    const creating = broker.handleLocal(socket, JSON.stringify({ id: 30, method: 'session/create', params: brokerCreateParams(directory, sessionId) })); while (!createCalls) await new Promise((resolvePromise) => setImmediate(resolvePromise)); assert.equal(typeof broker.admission.sessionClaims.get(sessionId)?.token, 'string'); await broker.handleLocal(socket, JSON.stringify({ id: 31, method, params: { sessionId, ...extraParams } })); rejectCreate(new Error('create failed')); await creating; const operationResponse = writes.find((frame) => frame.id === 31); assert.equal(operationCalls, 0); assert.equal(operationResponse?.result, undefined); assert.equal(operationResponse?.error?.data?.pluginError?.code, 'ZCODE_TURN_ACTIVE'); assert.equal(broker.sessionOwners.has(sessionId), false); await rm(directory, { recursive: true, force: true });
  });
});

test('an explicit create claim fences the session before ownership reload completes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-create-reload-entry-fence-')); const ownerId = 'create-reload-entry-owner'; const sessionId = 'create-reload-entry-session'; const writes = []; const socket = { writable: true, destroyed: false, zcodeWriter: { write: (line) => writes.push(JSON.parse(line)) }, destroy() {} }; const broker = newTestBroker({ endpoint: join(directory, 'broker.sock'), brokerToken: '4'.repeat(64), workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } }); broker.authenticated.add(socket); broker.socketOwnerIds.set(socket, ownerId); broker.sessionOwners.set(sessionId, { ownerId, socket }); let releaseReload; let reloadCalls = 0; broker.reloadOwnership = async () => { reloadCalls += 1; if (reloadCalls === 1) await new Promise((resolvePromise) => { releaseReload = resolvePromise; }); }; let createCalls = 0; let sendCalls = 0; const protocol = { request: async (method) => { if (method === 'session/create') { createCalls += 1; throw new Error('create failed'); } sendCalls += 1; return { accepted: true, sessionId, stateRevision: 1 }; }, beginTurn() {}, armTurn() {}, abortTurn() {} }; broker.protocol = protocol;
  const creating = broker.handleLocal(socket, JSON.stringify({ id: 32, method: 'session/create', params: brokerCreateParams(directory, sessionId) })); while (!releaseReload) await new Promise((resolvePromise) => setImmediate(resolvePromise)); await broker.handleLocal(socket, JSON.stringify({ id: 33, method: 'session/send', params: { sessionId, inputId: 'reload-entry-input', queryId: 'reload-entry-input', content: 'must remain fenced' } })); releaseReload(); await creating;
  assert.equal(createCalls, 1); assert.equal(sendCalls, 0); assert.equal(writes.find((frame) => frame.id === 33)?.error?.data?.pluginError?.code, 'ZCODE_TURN_ACTIVE'); assert.equal(broker.admission.activeCount, 0); await rm(directory, { recursive: true, force: true });
});

test('a failed explicit create cannot leave a same-session send route active and unowned', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-create-send-fence-')); const sessionId = 'create-send-fence-session'; const ownerId = 'create-send-fence-owner'; const writes = []; const socket = { writable: true, destroyed: false, zcodeWriter: { write: (line) => writes.push(JSON.parse(line)) }, destroy() {} }; const broker = newTestBroker({ endpoint: join(directory, 'broker.sock'), brokerToken: '3'.repeat(64), workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } }); broker.authenticated.add(socket); broker.socketOwnerIds.set(socket, ownerId); broker.reloadOwnership = async () => {}; let rejectCreate; let createCalls = 0; let sendCalls = 0; const protocol = { request: (method) => { if (method === 'session/create') { createCalls += 1; return new Promise((_resolvePromise, rejectPromise) => { rejectCreate = rejectPromise; }); } sendCalls += 1; return Promise.resolve({ accepted: true, sessionId, stateRevision: 1 }); }, beginTurn() {}, armTurn() {}, abortTurn() {} }; broker.protocol = protocol;
  const creating = broker.handleLocal(socket, JSON.stringify({ id: 40, method: 'session/create', params: brokerCreateParams(directory, sessionId) })); while (!createCalls) await new Promise((resolvePromise) => setImmediate(resolvePromise)); await broker.handleLocal(socket, JSON.stringify({ id: 41, method: 'session/send', params: { sessionId, inputId: 'create-send-input', queryId: 'create-send-input', content: 'must not send' } })); rejectCreate(new Error('create failed')); await creating; assert.equal(sendCalls, 0); assert.equal(writes.find((frame) => frame.id === 41)?.result, undefined); assert.equal(broker.sessionOwners.has(sessionId), false); assert.equal(broker.activeSessionSockets.has(sessionId), false); assert.equal(broker.activeSessions.has(sessionId), false); await rm(directory, { recursive: true, force: true });
});

test('a production ownership reload cannot erase a same-owner transient create fence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-create-reload-fence-')); const endpoint = join(directory, 'broker.sock'); const ownershipPath = `${endpoint}.owners.json`; const sessionId = 'create-reload-fence-session'; const ownerId = 'create-reload-fence-owner'; const writes = []; const socket = { writable: true, destroyed: false, zcodeWriter: { write: (line) => writes.push(JSON.parse(line)) }, destroy() {} }; await writeFile(ownershipPath, JSON.stringify({ version: 1, sessions: { [sessionId]: ownerId } })); const broker = newTestBroker({ endpoint, ownershipPath, brokerToken: '4'.repeat(64), workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } }); broker.ownershipStoreEstablished = true; broker.sessionOwners.set(sessionId, { ownerId, socket, claimToken: null }); broker.authenticated.add(socket); broker.socketOwnerIds.set(socket, ownerId); let rejectCreate; let createCalls = 0; let sendCalls = 0; const protocol = { request: (method) => { if (method === 'session/create') { createCalls += 1; return new Promise((_resolvePromise, rejectPromise) => { rejectCreate = rejectPromise; }); } sendCalls += 1; return Promise.resolve({ accepted: true, sessionId, stateRevision: 1 }); }, beginTurn() {}, armTurn() {}, abortTurn() {} }; broker.protocol = protocol;
  const creating = broker.handleLocal(socket, JSON.stringify({ id: 42, method: 'session/create', params: brokerCreateParams(directory, sessionId) })); while (!createCalls) await new Promise((resolvePromise) => setImmediate(resolvePromise)); await broker.reloadOwnership(); await broker.handleLocal(socket, JSON.stringify({ id: 43, method: 'session/send', params: { sessionId, inputId: 'create-reload-input', queryId: 'create-reload-input', content: 'must remain fenced' } })); rejectCreate(new Error('create failed')); await creating; assert.equal(sendCalls, 0); assert.equal(writes.find((frame) => frame.id === 43)?.result, undefined); assert.equal(broker.sessionOwners.get(sessionId)?.ownerId, ownerId); assert.equal(JSON.parse(await readFile(ownershipPath, 'utf8')).sessions[sessionId], ownerId); assert.equal(broker.activeSessionSockets.has(sessionId), false); assert.equal(broker.admission.activeCount, 0); await rm(directory, { recursive: true, force: true });
});

test('anonymous create cannot alias an existing or concurrently returned session identifier', async (t) => {
  await t.test('existing same-owner session', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-anonymous-existing-alias-')); const endpoint = join(directory, 'broker.sock'); const ownershipPath = `${endpoint}.owners.json`; const ownerId = 'anonymous-existing-alias-owner'; const sessionId = 'anonymous-existing-alias-session'; const existingWrites = []; const creatingWrites = []; const existingSocket = { writable: true, destroyed: false, zcodeWriter: { write: (line) => existingWrites.push(JSON.parse(line)) }, destroy() {} }; const creatingSocket = { writable: true, destroyed: false, zcodeWriter: { write: (line) => creatingWrites.push(JSON.parse(line)) }, destroy() {} }; const broker = newTestBroker({ endpoint, ownershipPath, brokerToken: '6'.repeat(64), workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } }); broker.authenticated.add(creatingSocket); broker.socketOwnerIds.set(creatingSocket, ownerId); broker.sessionOwners.set(sessionId, { ownerId, socket: existingSocket }); await writeFile(ownershipPath, JSON.stringify({ version: 1, sessions: { [sessionId]: ownerId } })); broker.ownershipStoreEstablished = true; broker.protocol = { request: async () => brokerCreateSnapshot(sessionId, directory) };
    await broker.handleLocal(creatingSocket, JSON.stringify({ id: 61, method: 'session/create', params: brokerCreateParams(directory) })); assert.equal(creatingWrites.at(-1)?.result, undefined); assert.equal(broker.sessionOwners.get(sessionId)?.socket, existingSocket); assert.equal(JSON.parse(await readFile(ownershipPath, 'utf8')).sessions[sessionId], ownerId); assert.equal(broker.admission.activeCount, 0); await rm(directory, { recursive: true, force: true });
  });
  await t.test('later concurrent response', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-anonymous-concurrent-alias-')); const endpoint = join(directory, 'broker.sock'); const ownershipPath = `${endpoint}.owners.json`; const ownerId = 'anonymous-concurrent-alias-owner'; const sessionId = 'anonymous-concurrent-alias-session'; const writesA = []; const writesB = []; const socketA = { writable: true, destroyed: false, zcodeWriter: { write: (line) => writesA.push(JSON.parse(line)) }, destroy() {} }; const socketB = { writable: true, destroyed: false, zcodeWriter: { write: (line) => writesB.push(JSON.parse(line)) }, destroy() {} }; const broker = newTestBroker({ endpoint, ownershipPath, brokerToken: '7'.repeat(64), workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } }); for (const socket of [socketA, socketB]) { broker.authenticated.add(socket); broker.socketOwnerIds.set(socket, ownerId); } broker.owners = 2; let resolveA; let resolveB; let calls = 0; broker.protocol = { request: () => { calls += 1; return new Promise((resolvePromise) => { if (calls === 1) resolveA = resolvePromise; else resolveB = resolvePromise; }); } }; const creatingA = broker.handleLocal(socketA, JSON.stringify({ id: 62, method: 'session/create', params: brokerCreateParams(directory) })); while (calls < 1) await new Promise((resolvePromise) => setImmediate(resolvePromise)); const creatingB = broker.handleLocal(socketB, JSON.stringify({ id: 63, method: 'session/create', params: brokerCreateParams(directory) })); while (calls < 2) await new Promise((resolvePromise) => setImmediate(resolvePromise)); resolveA(brokerCreateSnapshot(sessionId, directory)); await creatingA; resolveB(brokerCreateSnapshot(sessionId, directory)); await creatingB;
    assert.equal(writesA.at(-1)?.result?.session?.sessionId, sessionId); assert.equal(writesB.at(-1)?.result, undefined); assert.equal(broker.sessionOwners.get(sessionId)?.socket, socketA); assert.equal(JSON.parse(await readFile(ownershipPath, 'utf8')).sessions[sessionId], ownerId); assert.equal(broker.admission.activeCount, 0); await rm(directory, { recursive: true, force: true });
  });
  await t.test('overlapping commit', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-anonymous-overlap-alias-')); const endpoint = join(directory, 'broker.sock'); const ownershipPath = `${endpoint}.owners.json`; const ownerId = 'anonymous-overlap-alias-owner'; const sessionId = 'anonymous-overlap-alias-session'; const writesA = []; const writesB = []; const socketA = { writable: true, destroyed: false, zcodeWriter: { write: (line) => writesA.push(JSON.parse(line)) }, destroy() {} }; const socketB = { writable: true, destroyed: false, zcodeWriter: { write: (line) => writesB.push(JSON.parse(line)) }, destroy() {} }; const broker = newTestBroker({ endpoint, ownershipPath, brokerToken: '5'.repeat(64), workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } }); for (const socket of [socketA, socketB]) { broker.authenticated.add(socket); broker.socketOwnerIds.set(socket, ownerId); } broker.owners = 2; let resolveA; let resolveB; let calls = 0; broker.protocol = { request: () => { calls += 1; return new Promise((resolvePromise) => { if (calls === 1) resolveA = resolvePromise; else resolveB = resolvePromise; }); } }; let enterWrite; let resumeWrite; const writeEntered = new Promise((resolvePromise) => { enterWrite = resolvePromise; }); const writeGate = new Promise((resolvePromise) => { resumeWrite = resolvePromise; }); broker.writeOwnerStore = async (sessions) => { enterWrite(); await writeGate; await atomicWriteJson(ownershipPath, { version: 1, sessions }); }; const creatingA = broker.handleLocal(socketA, JSON.stringify({ id: 65, method: 'session/create', params: brokerCreateParams(directory) })); while (calls < 1) await new Promise((resolvePromise) => setImmediate(resolvePromise)); const creatingB = broker.handleLocal(socketB, JSON.stringify({ id: 66, method: 'session/create', params: brokerCreateParams(directory) })); while (calls < 2) await new Promise((resolvePromise) => setImmediate(resolvePromise)); resolveA(brokerCreateSnapshot(sessionId, directory)); await writeEntered; resolveB(brokerCreateSnapshot(sessionId, directory)); await creatingB; resumeWrite(); await creatingA;
    assert.equal(writesA.at(-1)?.result?.session?.sessionId, sessionId); assert.equal(writesB.at(-1)?.result, undefined); assert.equal(broker.sessionOwners.get(sessionId)?.socket, socketA); assert.equal(JSON.parse(await readFile(ownershipPath, 'utf8')).sessions[sessionId], ownerId); assert.equal(broker.admission.activeCount, 0); await rm(directory, { recursive: true, force: true });
  });
  await t.test('durable same-owner race', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-anonymous-durable-alias-')); const endpoint = join(directory, 'broker.sock'); const ownershipPath = `${endpoint}.owners.json`; const ownerId = 'anonymous-durable-alias-owner'; const sessionId = 'anonymous-durable-alias-session'; const writes = []; const socket = { writable: true, destroyed: false, zcodeWriter: { write: (line) => writes.push(JSON.parse(line)) }, destroy() {} }; const broker = newTestBroker({ endpoint, ownershipPath, brokerToken: '4'.repeat(64), workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } }); broker.authenticated.add(socket); broker.socketOwnerIds.set(socket, ownerId); broker.owners = 1; await writeFile(ownershipPath, JSON.stringify({ version: 1, sessions: {} })); broker.ownershipStoreEstablished = true; let resolveCreate; let requestEntered; const entered = new Promise((resolvePromise) => { requestEntered = resolvePromise; }); broker.protocol = { request: () => { requestEntered(); return new Promise((resolvePromise) => { resolveCreate = resolvePromise; }); } }; const creating = broker.handleLocal(socket, JSON.stringify({ id: 67, method: 'session/create', params: brokerCreateParams(directory) })); await entered; await atomicWriteJson(ownershipPath, { version: 1, sessions: { [sessionId]: ownerId } }); resolveCreate(brokerCreateSnapshot(sessionId, directory)); await creating;
    assert.equal(writes.at(-1)?.result, undefined); assert.notEqual(broker.sessionOwners.get(sessionId)?.socket, socket); assert.equal(JSON.parse(await readFile(ownershipPath, 'utf8')).sessions[sessionId], ownerId); assert.equal(broker.admission.activeCount, 0); await rm(directory, { recursive: true, force: true });
  });
});

test('create ownership commit recovers or fences every durable write outcome', async (t) => {
  for (const mode of ['before-apply', 'apply-then-throw', 'winner-read-fail', 'foreign-winner']) await t.test(mode, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-create-commit-winner-')); const endpoint = join(directory, 'broker.sock'); const ownershipPath = `${endpoint}.owners.json`; const ownerId = 'create-commit-winner-owner'; const foreignOwnerId = 'create-commit-winner-foreign'; const sessionId = `create-commit-${mode}`; const writes = []; const socket = { writable: true, destroyed: false, zcodeWriter: { write: (line) => writes.push(JSON.parse(line)) }, destroy() {} }; const broker = newTestBroker({ endpoint, ownershipPath, brokerToken: '9'.repeat(64), workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } }); broker.authenticated.add(socket); broker.socketOwnerIds.set(socket, ownerId); broker.owners = 1; await writeFile(ownershipPath, JSON.stringify({ version: 1, sessions: {} })); broker.ownershipStoreEstablished = true; broker.protocol = { request: async () => brokerCreateSnapshot(sessionId, directory) }; const writeError = new Error(`create commit ${mode}`); const winnerReadError = new Error('winner unreadable'); broker.writeOwnerStore = async (sessions) => { if (mode !== 'before-apply') await atomicWriteJson(ownershipPath, { version: 1, sessions: mode === 'foreign-winner' ? { ...sessions, [sessionId]: foreignOwnerId } : sessions }); if (mode === 'winner-read-fail') broker.readOwnerStoreUnlocked = async () => { throw winnerReadError; }; throw writeError; };
    await broker.handleLocal(socket, JSON.stringify({ id: 64, method: 'session/create', params: brokerCreateParams(directory) })); const response = writes.find((frame) => frame.id === 64); const durable = JSON.parse(await readFile(ownershipPath, 'utf8')).sessions;
    if (mode === 'apply-then-throw') { assert.equal(response?.result?.session?.sessionId, sessionId); assert.equal(broker.sessionOwners.get(sessionId)?.ownerId, ownerId); assert.equal(durable[sessionId], ownerId); assert.equal(broker.ownershipStoreEstablished, true); }
    else if (mode === 'foreign-winner') { assert.equal(response?.result, undefined); assert.equal(broker.sessionOwners.get(sessionId)?.ownerId, foreignOwnerId); assert.equal(durable[sessionId], foreignOwnerId); }
    else { assert.equal(response?.result, undefined); assert.equal(broker.sessionOwners.get(sessionId)?.ownerId, ownerId); assert.equal(mode === 'winner-read-fail' ? durable[sessionId] : undefined, mode === 'winner-read-fail' ? ownerId : undefined); }
    assert.equal(broker.admission.activeCount, 0); await rm(directory, { recursive: true, force: true });
  });
});

test('a generation reset during create winner recovery compensates the exact applied commit', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-create-winner-reset-')); const endpoint = join(directory, 'broker.sock'); const ownershipPath = `${endpoint}.owners.json`; const ownerId = 'create-winner-reset-owner'; const sessionId = 'create-winner-reset-session'; const writes = []; const socket = { writable: true, destroyed: false, zcodeWriter: { write: (line) => writes.push(JSON.parse(line)) }, destroy() {} }; const broker = newTestBroker({ endpoint, ownershipPath, brokerToken: '3'.repeat(64), workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } }); broker.authenticated.add(socket); broker.socketOwnerIds.set(socket, ownerId); broker.owners = 1; await writeFile(ownershipPath, JSON.stringify({ version: 1, sessions: {} })); broker.ownershipStoreEstablished = true; const commitError = new Error('create acknowledgement lost before reset'); const protocol = { request: async () => brokerCreateSnapshot(sessionId, directory), close: async () => {} }; broker.protocol = protocol; let writeCalls = 0; broker.writeOwnerStore = async (sessions) => { writeCalls += 1; await atomicWriteJson(ownershipPath, { version: 1, sessions }); if (writeCalls === 1) throw commitError; }; const readOwnerStoreUnlocked = broker.readOwnerStoreUnlocked.bind(broker); let enterWinnerRead; let resumeWinnerRead; const winnerReadEntered = new Promise((resolvePromise) => { enterWinnerRead = resolvePromise; }); const winnerReadGate = new Promise((resolvePromise) => { resumeWinnerRead = resolvePromise; }); broker.readOwnerStoreUnlocked = async (...args) => { enterWinnerRead(); await winnerReadGate; return readOwnerStoreUnlocked(...args); };
  const creating = broker.handleLocal(socket, JSON.stringify({ id: 68, method: 'session/create', params: brokerCreateParams(directory) })); await winnerReadEntered; broker.clearProtocolGeneration(protocol); resumeWinnerRead(); await creating; assert.equal(writes.at(-1)?.result, undefined); assert.equal(broker.sessionOwners.has(sessionId), false); assert.equal(Object.hasOwn(JSON.parse(await readFile(ownershipPath, 'utf8')).sessions, sessionId), false); assert.equal(broker.admission.activeCount, 0); await rm(directory, { recursive: true, force: true });
});

test('owner create/release admission defers earlier creates and blocks later creates', async (t) => {
  for (const explicit of [false, true]) await t.test(`create-first-${explicit ? 'explicit' : 'anonymous'}`, { timeout: 3_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-create-first-release-')); const endpoint = join(directory, 'broker.sock'); const ownershipPath = `${endpoint}.owners.json`; const ownerId = 'create-first-release-owner'; const createdSessionId = `create-first-${explicit ? 'explicit' : 'anonymous'}-session`; const writes = []; const socket = { writable: true, destroyed: false, zcodeWriter: { write: (line) => writes.push(JSON.parse(line)) }, destroy() {} }; const broker = newTestBroker({ endpoint, ownershipPath, brokerToken: '5'.repeat(64), workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } }); broker.authenticated.add(socket); broker.socketOwnerIds.set(socket, ownerId); broker.owners = 1; let resolveCreate; let markCreateEntered; const createEntered = new Promise((resolvePromise) => { markCreateEntered = resolvePromise; }); let createCalls = 0; const protocol = { request: (method) => { if (method === 'session/create') { createCalls += 1; markCreateEntered(); return new Promise((resolvePromise) => { resolveCreate = resolvePromise; }); } if (method === 'session/list') return Promise.resolve({ sessions: [{ sessionId: createdSessionId }] }); if (method === 'session/stop') return Promise.resolve({}); throw new Error(`unexpected ${method}`); }, cancelTurn() {} }; broker.protocol = protocol; const createParams = brokerCreateParams(directory, explicit ? createdSessionId : undefined);
    const creating = broker.handleLocal(socket, JSON.stringify({ id: 50, method: 'session/create', params: createParams })); await createEntered; assert.equal(createCalls, 1); await broker.handleLocal(socket, JSON.stringify({ id: 51, method: 'broker/releaseOwner', params: { excludeSessionIds: [] } })); assert.deepEqual(writes.find((frame) => frame.id === 51)?.result, { releasedSessionIds: [], failedSessionIds: [], deferredSessionCount: 1 }); resolveCreate(brokerCreateSnapshot(createdSessionId, directory)); await creating; assert.equal(writes.find((frame) => frame.id === 50)?.result?.session?.sessionId, createdSessionId); assert.equal(broker.sessionOwners.get(createdSessionId)?.ownerId, ownerId); assert.equal(JSON.parse(await readFile(ownershipPath, 'utf8')).sessions[createdSessionId], ownerId); await broker.handleLocal(socket, JSON.stringify({ id: 55, method: 'session/list', params: {} })); const listed = writes.find((frame) => frame.id === 55); assert.equal(listed?.error, undefined, JSON.stringify(listed)); assert.deepEqual(listed?.result?.sessions, [{ sessionId: createdSessionId }]); await broker.handleLocal(socket, JSON.stringify({ id: 56, method: 'broker/releaseOwner', params: { excludeSessionIds: [] } })); assert.deepEqual(writes.find((frame) => frame.id === 56)?.result?.releasedSessionIds, [createdSessionId]); assert.equal(broker.sessionOwners.has(createdSessionId), false); assert.equal(broker.admission.activeCount, 0); assert.deepEqual(JSON.parse(await readFile(ownershipPath, 'utf8')).sessions, {}); await rm(directory, { recursive: true, force: true });
  });
  for (const explicit of [false, true]) await t.test(`create-failure-${explicit ? 'explicit' : 'anonymous'}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-create-release-failure-')); const endpoint = join(directory, 'broker.sock'); const ownerId = 'create-release-failure-owner'; const sessionId = `create-release-failure-${explicit ? 'explicit' : 'anonymous'}`; const writes = []; const socket = { writable: true, destroyed: false, zcodeWriter: { write: (line) => writes.push(JSON.parse(line)) }, destroy() {} }; const broker = newTestBroker({ endpoint, brokerToken: '7'.repeat(64), workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } }); broker.authenticated.add(socket); broker.socketOwnerIds.set(socket, ownerId); let rejectCreate; let enteredCreate; const entered = new Promise((resolvePromise) => { enteredCreate = resolvePromise; }); broker.protocol = { request: () => { enteredCreate(); return new Promise((_resolvePromise, rejectPromise) => { rejectCreate = rejectPromise; }); } }; const creating = broker.handleLocal(socket, JSON.stringify({ id: 57, method: 'session/create', params: brokerCreateParams(directory, explicit ? sessionId : undefined) })); await entered; await broker.handleLocal(socket, JSON.stringify({ id: 58, method: 'broker/releaseOwner', params: { excludeSessionIds: [] } })); assert.equal(writes.find((frame) => frame.id === 58)?.result?.deferredSessionCount, 1); rejectCreate(new Error('create failed after deferred release')); await creating; assert.equal(writes.find((frame) => frame.id === 57)?.result, undefined); assert.equal(broker.admission.activeCount, 0); assert.equal(broker.admission.ownerStates.size, 0); assert.equal(broker.admission.sessionClaims.size, 0); assert.equal(broker.sessionOwners.has(sessionId), false); await rm(directory, { recursive: true, force: true });
  });
  for (const explicit of [true, false]) await t.test(`release-first-${explicit ? 'explicit' : 'anonymous'}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-release-first-create-')); const endpoint = join(directory, 'broker.sock'); const ownershipPath = `${endpoint}.owners.json`; const ownerA = 'release-first-create-owner-a'; const ownerB = 'release-first-create-owner-b'; const stableSessionId = `release-first-stable-${explicit}`; const ownerACreated = `release-first-owner-a-${explicit ? 'explicit' : 'anonymous'}`; const ownerBCreated = `release-first-owner-b-${explicit}`; const writesA = []; const writesB = []; const socketA = { writable: true, destroyed: false, zcodeWriter: { write: (line) => writesA.push(JSON.parse(line)) }, destroy() {} }; const socketB = { writable: true, destroyed: false, zcodeWriter: { write: (line) => writesB.push(JSON.parse(line)) }, destroy() {} }; await writeFile(ownershipPath, JSON.stringify({ version: 1, sessions: { [stableSessionId]: ownerA } })); const broker = newTestBroker({ endpoint, ownershipPath, brokerToken: '6'.repeat(64), workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } }); broker.ownershipStoreEstablished = true; broker.sessionOwners.set(stableSessionId, { ownerId: ownerA, socket: socketA, claimToken: null }); for (const [socket, ownerId] of [[socketA, ownerA], [socketB, ownerB]]) { broker.authenticated.add(socket); broker.socketOwnerIds.set(socket, ownerId); } let resolveStop; let stopCalls = 0; const createCalls = []; const protocol = { request: (method, params) => { if (method === 'session/stop') { stopCalls += 1; return new Promise((resolvePromise) => { resolveStop = resolvePromise; }); } createCalls.push(params.sessionId ?? ownerACreated); return Promise.resolve(brokerCreateSnapshot(params.sessionId ?? ownerACreated, directory)); }, cancelTurn() {} }; broker.protocol = protocol;
    const releasing = broker.handleLocal(socketA, JSON.stringify({ id: 52, method: 'broker/releaseOwner', params: { excludeSessionIds: [] } })); while (!stopCalls) await new Promise((resolvePromise) => setImmediate(resolvePromise)); await broker.handleLocal(socketA, JSON.stringify({ id: 53, method: 'session/create', params: brokerCreateParams(directory, explicit ? ownerACreated : undefined) })); await broker.handleLocal(socketB, JSON.stringify({ id: 54, method: 'session/create', params: brokerCreateParams(directory, ownerBCreated) })); resolveStop({}); await releasing; assert.equal(createCalls.includes(ownerACreated), false); assert.equal(writesA.find((frame) => frame.id === 53)?.result, undefined); assert.equal(writesB.find((frame) => frame.id === 54)?.result?.session?.sessionId, ownerBCreated); assert.equal(broker.sessionOwners.has(ownerACreated), false); assert.equal(broker.sessionOwners.get(ownerBCreated)?.ownerId, ownerB); assert.equal(broker.sessionOwners.has(stableSessionId), false); assert.equal(broker.admission.activeCount, 0); await rm(directory, { recursive: true, force: true });
  });
});

test('owner release grandfathers pending create tokens through a slow ownership reload', async (t) => {
  for (const explicit of [false, true]) await t.test(explicit ? 'explicit' : 'anonymous', async () => {
    const directory = await mkdtemp(join(tmpdir(), `zcode-broker-grandfather-create-${explicit ? 'explicit' : 'anonymous'}-`)); const endpoint = join(directory, 'broker.sock'); const ownershipPath = `${endpoint}.owners.json`; const ownerId = `grandfather-create-${explicit ? 'explicit' : 'anonymous'}-owner`; const sessionId = `grandfather-create-${explicit ? 'explicit' : 'anonymous'}-session`; const writes = []; const socket = { writable: true, destroyed: false, zcodeWriter: { write: (line) => writes.push(JSON.parse(line)) }, destroy() {} }; const broker = newTestBroker({ endpoint, ownershipPath, brokerToken: '9'.repeat(64), workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } }); broker.authenticated.add(socket); broker.socketOwnerIds.set(socket, ownerId); broker.owners = 1;
    let resolveCreate; let createEntered; const enteredCreate = new Promise((resolvePromise) => { createEntered = resolvePromise; }); let stopCalls = 0; broker.protocol = { request: (method) => { if (method === 'session/create') { createEntered(); return new Promise((resolvePromise) => { resolveCreate = resolvePromise; }); } if (method === 'session/stop') { stopCalls += 1; return Promise.resolve({}); } throw new Error(`unexpected ${method}`); }, cancelTurn() {} };
    let releaseReloadEntered; let finishReleaseReload; const enteredReleaseReload = new Promise((resolvePromise) => { releaseReloadEntered = resolvePromise; }); const releaseReloadGate = new Promise((resolvePromise) => { finishReleaseReload = resolvePromise; }); broker.reloadOwnership = async (deadline) => { if (deadline !== undefined) { releaseReloadEntered(); await releaseReloadGate; } };
    const creating = broker.handleLocal(socket, JSON.stringify({ id: 87, method: 'session/create', params: brokerCreateParams(directory, explicit ? sessionId : undefined) })); await enteredCreate;
    const releasing = broker.handleLocal(socket, JSON.stringify({ id: 88, method: 'broker/releaseOwner', params: { excludeSessionIds: [] } })); await enteredReleaseReload; resolveCreate(brokerCreateSnapshot(sessionId, directory)); await creating;
    const createResponse = writes.find((frame) => frame.id === 87); assert.equal(createResponse?.error, undefined, JSON.stringify(createResponse)); assert.equal(createResponse?.result?.session?.sessionId, sessionId); assert.equal(broker.sessionOwners.get(sessionId)?.ownerId, ownerId); assert.equal(JSON.parse(await readFile(ownershipPath, 'utf8')).sessions[sessionId], ownerId);
    finishReleaseReload(); await releasing; assert.deepEqual(writes.find((frame) => frame.id === 88)?.result, { releasedSessionIds: [], failedSessionIds: [], deferredSessionCount: 1 }); assert.equal(stopCalls, 0); assert.equal(broker.sessionOwners.get(sessionId)?.ownerId, ownerId); assert.equal(JSON.parse(await readFile(ownershipPath, 'utf8')).sessions[sessionId], ownerId); assert.equal(broker.admission.activeCount, 0); await rm(directory, { recursive: true, force: true });
  });
});

test('owner operation leases isolate sibling release and clear exactly on reset and rejection', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-owner-operation-siblings-')); const endpoint = join(directory, 'broker.sock'); const ownershipPath = `${endpoint}.owners.json`; const ownerId = 'owner-operation-sibling-owner'; const leasedSessionId = 'owner-operation-leased-session'; const siblingSessionId = 'owner-operation-sibling-session'; const writes = []; const socket = { writable: true, destroyed: false, zcodeWriter: { write: (line) => writes.push(JSON.parse(line)) }, destroy() {} }; const broker = newTestBroker({ endpoint, brokerToken: 'c'.repeat(64), workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } }); broker.authenticated.add(socket); broker.socketOwnerIds.set(socket, ownerId); broker.sessionOwners.set(leasedSessionId, { ownerId, socket, claimToken: null }); broker.sessionOwners.set(siblingSessionId, { ownerId, socket, claimToken: null }); await writeFile(ownershipPath, JSON.stringify({ version: 1, sessions: { [leasedSessionId]: ownerId, [siblingSessionId]: ownerId } })); broker.ownershipStoreEstablished = true; broker.reloadOwnership = async () => {}; let resolveRead; const readPending = new Promise((resolvePromise) => { resolveRead = resolvePromise; }); let rejectModel; const modelPending = new Promise((_resolvePromise, rejectPromise) => { rejectModel = rejectPromise; }); let readCalls = 0; let modelCalls = 0; const protocol = { request: (method, params) => { if (method === 'session/read') { readCalls += 1; return readPending; } if (method === 'session/setModel') { modelCalls += 1; return modelPending; } return method === 'session/stop' && params.sessionId === siblingSessionId ? Promise.resolve({}) : Promise.reject(new Error(`unexpected ${method}`)); }, cancelTurn() {} }; broker.protocol = protocol; const reading = broker.handleLocal(socket, JSON.stringify({ id: 21, method: 'session/read', params: { sessionId: leasedSessionId } })); while (!readCalls) await new Promise((resolvePromise) => setImmediate(resolvePromise)); const released = await broker.releaseOwner(socket, ownerId, []); assert.deepEqual(released.releasedSessionIds, [siblingSessionId]); assert.deepEqual(released.failedSessionIds, [leasedSessionId]); assert.equal(broker.sessionOwners.get(leasedSessionId)?.ownerId, ownerId); assert.equal(broker.sessionOwners.has(siblingSessionId), false); resolveRead({ ok: true }); await reading; assert.equal(broker.admission.activeSessionCount, 0);
  const setting = broker.handleLocal(socket, JSON.stringify({ id: 22, method: 'session/setModel', params: { sessionId: leasedSessionId, model: { providerId: 'fake', modelId: 'model' }, persistAsWorkspaceLastUsed: false } })); while (!modelCalls) await new Promise((resolvePromise) => setImmediate(resolvePromise)); broker.clearProtocolGeneration(protocol); rejectModel(new Error('reset rejection')); await setting; assert.equal(writes.at(-1)?.error !== undefined, true); assert.equal(broker.admission.activeSessionCount, 0); await rm(directory, { recursive: true, force: true });
});

test('owner operation lease admission is globally bounded and exact-token release is idempotent', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-owner-operation-bound-')); const broker = newTestBroker({ endpoint: join(directory, 'broker.sock'), brokerToken: 'd'.repeat(64), workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } }); const ownerId = 'owner-operation-bound-owner'; const socket = {}; const leases = [];
  for (let index = 0; index < 256; index += 1) { const sessionId = `owner-operation-bound-${index}`; broker.sessionOwners.set(sessionId, { ownerId, socket, claimToken: null }); leases.push(broker.admission.beginSessionRequest('session/read', sessionId, ownerId, socket)); } broker.scheduleIdleShutdown(); assert.equal(broker.idleTimer, null); assert.equal(broker.admission.activeSessionCount, 256); const overflowSessionId = 'owner-operation-bound-overflow'; broker.sessionOwners.set(overflowSessionId, { ownerId, socket, claimToken: null }); assert.throws(() => broker.admission.beginSessionRequest('session/read', overflowSessionId, ownerId, socket), { code: 'ZCODE_TURN_ACTIVE' }); broker.admission.finishSessionRequest(leases[0]); broker.admission.finishSessionRequest(leases[0]); const replacement = broker.admission.beginSessionRequest('session/setThoughtLevel', overflowSessionId, ownerId, socket); assert.equal(broker.admission.activeSessionCount, 256); for (const lease of leases.slice(1)) broker.admission.finishSessionRequest(lease); broker.admission.finishSessionRequest(replacement); assert.equal(broker.admission.activeSessionCount, 0); assert.equal(broker.admission.sessionLeases.size, 0); assert.notEqual(broker.idleTimer, null); broker.cancelIdleShutdown(); await rm(directory, { recursive: true, force: true });
});

test('anonymous and explicit creates share one global transient-operation limit and recover after rejection', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-create-global-bound-')); const broker = newTestBroker({ endpoint: join(directory, 'broker.sock'), brokerToken: 'e'.repeat(64), workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } }); const operations = []; const writes = []; let reloadCalls = 0; let upstreamCalls = 0; let rejectCreates; const createGate = new Promise((_resolvePromise, rejectPromise) => { rejectCreates = rejectPromise; }); broker.reloadOwnership = async () => { reloadCalls += 1; }; broker.protocol = { request: () => { upstreamCalls += 1; return createGate; } };
  for (let index = 0; index < 256; index += 1) { const ownerId = `create-global-bound-owner-${index}`; const socket = { writable: true, destroyed: false, zcodeWriter: { write: (line) => writes.push(JSON.parse(line)) }, destroy() {} }; broker.authenticated.add(socket); broker.socketOwnerIds.set(socket, ownerId); operations.push(broker.handleLocal(socket, JSON.stringify({ id: 1000 + index, method: 'session/create', params: brokerCreateParams(directory, index % 2 === 0 ? `create-global-bound-session-${index}` : undefined) }))); }
  while (upstreamCalls < 256) await new Promise((resolvePromise) => setImmediate(resolvePromise)); assert.equal(broker.admission.activeCount, 256);
  const overflowSocket = { writable: true, destroyed: false, zcodeWriter: { write: (line) => writes.push(JSON.parse(line)) }, destroy() {} }; broker.authenticated.add(overflowSocket); broker.socketOwnerIds.set(overflowSocket, 'create-global-bound-overflow-owner'); const overflowing = broker.handleLocal(overflowSocket, JSON.stringify({ id: 2000, method: 'session/create', params: brokerCreateParams(directory) })); for (let turn = 0; turn < 20 && upstreamCalls === 256 && !writes.some((frame) => frame.id === 2000); turn += 1) await new Promise((resolvePromise) => setImmediate(resolvePromise)); const overflowForwarded = upstreamCalls > 256; rejectCreates(new Error('release global create slots')); await overflowing; await Promise.all(operations); assert.equal(reloadCalls, 256); assert.equal(upstreamCalls, 256); assert.equal(overflowForwarded, false); assert.equal(writes.find((frame) => frame.id === 2000)?.error?.data?.pluginError?.code, 'ZCODE_TURN_ACTIVE'); assert.equal(broker.admission.activeCount, 0); assert.equal(broker.admission.ownerStates.size, 0); assert.equal(broker.admission.sessionLeases.size, 0);
  broker.protocol = { request: async () => { upstreamCalls += 1; return brokerCreateSnapshot('create-global-bound-recovered', directory); } }; await broker.handleLocal(overflowSocket, JSON.stringify({ id: 2001, method: 'session/create', params: brokerCreateParams(directory) })); assert.equal(writes.find((frame) => frame.id === 2001)?.result?.session?.sessionId, 'create-global-bound-recovered'); assert.equal(broker.admission.activeCount, 0); await rm(directory, { recursive: true, force: true });
});

test('owner release clears its stop fence when local settlement fails before durable commit', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-release-settle-failure-')); const endpoint = join(directory, 'broker.sock'); const ownershipPath = `${endpoint}.owners.json`; const ownerId = 'release-settle-failure-owner'; const sessionId = 'release-settle-failure-session'; const socket = { writable: true, destroyed: false, zcodeWriter: { write() {} }, destroy() {} }; const broker = newTestBroker({ endpoint, brokerToken: 'f'.repeat(64), workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } }); broker.sessionOwners.set(sessionId, { ownerId, socket, claimToken: null }); await writeFile(ownershipPath, JSON.stringify({ version: 1, sessions: { [sessionId]: ownerId } })); broker.ownershipStoreEstablished = true; const settleError = new Error('local settlement failed'); broker.protocol = { request: async () => ({}), cancelTurn: () => { throw settleError; } };
  await assert.rejects(broker.releaseOwner(socket, ownerId, []), (error) => error === settleError); assert.equal(broker.stoppingSessions.has(sessionId), false); assert.equal(broker.sessionOwners.get(sessionId)?.ownerId, ownerId); const durable = JSON.parse(await readFile(ownershipPath, 'utf8')); assert.equal(durable.sessions[sessionId], ownerId); await rm(directory, { recursive: true, force: true });
});

test('owner release registers every acknowledged batch stop before local settlement', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-release-batch-fences-')); const endpoint = join(directory, 'broker.sock'); const ownershipPath = `${endpoint}.owners.json`; const ownerId = 'release-batch-fence-owner'; const sessionIds = ['release-batch-session-a', 'release-batch-session-b']; const socket = { writable: true, destroyed: false, zcodeWriter: { write() {} }, destroy() {} }; const broker = newTestBroker({ endpoint, brokerToken: '1'.repeat(64), workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } }); const sessions = Object.fromEntries(sessionIds.map((sessionId) => [sessionId, ownerId])); for (const sessionId of sessionIds) broker.sessionOwners.set(sessionId, { ownerId, socket, claimToken: null }); await writeFile(ownershipPath, JSON.stringify({ version: 1, sessions })); broker.ownershipStoreEstablished = true; const settleError = new Error('first local settlement failed'); let cancelCalls = 0; broker.protocol = { request: async () => ({}), cancelTurn: () => { cancelCalls += 1; if (cancelCalls === 1) throw settleError; } };
  await assert.rejects(broker.releaseOwner(socket, ownerId, []), (error) => error === settleError); assert.equal(broker.stoppingSessions.has(sessionIds[0]), false); assert.equal(broker.stoppingSessions.has(sessionIds[1]), false); assert.deepEqual(JSON.parse(await readFile(ownershipPath, 'utf8')).sessions, sessions); await rm(directory, { recursive: true, force: true });
});

test('owner release recovers an atomic owner commit that applied before throwing', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-release-apply-throw-')); const endpoint = join(directory, 'broker.sock'); const ownershipPath = `${endpoint}.owners.json`; const ownerId = 'release-apply-throw-owner'; const sessionId = 'release-apply-throw-session'; const socket = { writable: true, destroyed: false, zcodeWriter: { write() {} }, destroy() {} }; const broker = newTestBroker({ endpoint, brokerToken: '2'.repeat(64), workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } }); broker.sessionOwners.set(sessionId, { ownerId, socket, claimToken: null }); await writeFile(ownershipPath, JSON.stringify({ version: 1, sessions: { [sessionId]: ownerId } })); broker.ownershipStoreEstablished = true; const commitError = new Error('owner commit acknowledgement lost'); let writeAttempts = 0; broker.writeOwnerStore = async (sessions) => { writeAttempts += 1; await atomicWriteJson(ownershipPath, { version: 1, sessions }); throw commitError; };
  const released = await broker.releaseOwner(socket, ownerId, []); assert.equal(writeAttempts, 1); assert.deepEqual(released.releasedSessionIds, [sessionId]); assert.equal(broker.sessionOwners.has(sessionId), false); assert.deepEqual(JSON.parse(await readFile(ownershipPath, 'utf8')).sessions, {}); await rm(directory, { recursive: true, force: true });
});

test('owner mutation observes a release abort immediately after an uncooperative durable write', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-owner-write-post-abort-')); const endpoint = join(directory, 'broker.sock'); const ownershipPath = `${endpoint}.owners.json`; const ownerId = 'owner-write-post-abort-owner'; const sessionId = 'owner-write-post-abort-session'; const broker = newTestBroker({ endpoint, ownershipPath, brokerToken: '1'.repeat(64), workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } }); await writeFile(ownershipPath, JSON.stringify({ version: 1, sessions: { [sessionId]: ownerId } })); const controller = new AbortController(); const timeoutError = new PluginError('ZCODE_OWNER_RELEASE_TIMEOUT', 'release expired after the durable write', { category: 'timeout', remedy: 'Retry.' }); broker.writeOwnerStore = async (sessions) => { await atomicWriteJson(ownershipPath, { version: 1, sessions }); controller.abort(timeoutError); };
  await assert.rejects(broker.commitOwnerMutation(false, () => true, (sessions) => { delete sessions[sessionId]; }, { signal: controller.signal }), (error) => error === timeoutError); assert.deepEqual(JSON.parse(await readFile(ownershipPath, 'utf8')).sessions, {}); await rm(directory, { recursive: true, force: true });
});

test('an unresolved owner commit stays fail-closed and reconciles its durable winner on the next reload', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-release-unknown-winner-')); const endpoint = join(directory, 'broker.sock'); const ownershipPath = `${endpoint}.owners.json`; const ownerId = 'release-unknown-winner-owner'; const sessionId = 'release-unknown-winner-session'; const socket = { writable: true, destroyed: false, zcodeWriter: { write() {} }, destroy() {} }; const broker = newTestBroker({ endpoint, brokerToken: '7'.repeat(64), workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } }); broker.sessionOwners.set(sessionId, { ownerId, socket, claimToken: null }); await writeFile(ownershipPath, JSON.stringify({ version: 1, sessions: { [sessionId]: ownerId } })); broker.ownershipStoreEstablished = true; const commitError = new Error('owner commit acknowledgement lost'); const recoveryError = new Error('durable winner temporarily unreadable'); const readOwnerStore = broker.readOwnerStore.bind(broker); broker.writeOwnerStore = async (sessions) => { await atomicWriteJson(ownershipPath, { version: 1, sessions }); throw commitError; }; broker.readOwnerStore = async () => { throw recoveryError; };
  await assert.rejects(broker.releaseOwner(socket, ownerId, []), (error) => error === commitError); assert.equal(broker.sessionOwners.get(sessionId)?.ownerId, ownerId); assert.deepEqual(JSON.parse(await readFile(ownershipPath, 'utf8')).sessions, {}); broker.readOwnerStore = readOwnerStore; await broker.reloadOwnership(); assert.equal(broker.sessionOwners.has(sessionId), false); await rm(directory, { recursive: true, force: true });
});

test('broker release entry bounds ownership reload inside the absolute release budget', { timeout: 3_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-release-entry-budget-')); const endpoint = join(directory, 'broker.sock'); const ownershipPath = `${endpoint}.owners.json`; const ownerId = 'release-entry-budget-owner'; const sessionId = 'release-entry-budget-session'; const writes = []; const socket = { writable: true, destroyed: false, zcodeWriter: { write: (line) => writes.push(JSON.parse(line)) }, destroy() {} }; const broker = newTestBroker({ endpoint, brokerToken: '3'.repeat(64), workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } }); broker.authenticated.add(socket); broker.socketOwnerIds.set(socket, ownerId); broker.sessionOwners.set(sessionId, { ownerId, socket, claimToken: null }); await writeFile(ownershipPath, JSON.stringify({ version: 1, sessions: { [sessionId]: ownerId } })); broker.ownershipStoreEstablished = true;
  let releaseLock; let lockEntered; const gate = new Promise((resolvePromise) => { releaseLock = resolvePromise; }); const entered = new Promise((resolvePromise) => { lockEntered = resolvePromise; }); const holder = withFileLock(`${ownershipPath}.lock`, async () => { lockEntered(); await gate; }); await entered; const started = Date.now(); const handling = broker.handleLocal(socket, JSON.stringify({ id: 77, method: 'broker/releaseOwner', params: { excludeSessionIds: [] } })); let outcome;
  try { outcome = await Promise.race([handling.then(() => ({ handled: true })), new Promise((resolvePromise) => setTimeout(() => resolvePromise({ timeout: true }), 850))]); } finally { releaseLock(); await holder; }
  await handling; assert.equal(outcome.timeout, undefined, 'real broker/releaseOwner entry exceeded its absolute reload budget'); assert.ok(Date.now() - started < 1_000); assert.equal(writes.at(-1).error?.data?.pluginError?.code, 'ZCODE_OWNER_RELEASE_TIMEOUT'); assert.equal(broker.sessionOwners.get(sessionId)?.ownerId, ownerId); await rm(directory, { recursive: true, force: true });
});

test('broker release entry aborts a stalled owner-store read inside its absolute budget', { timeout: 3_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-release-read-budget-')); const endpoint = join(directory, 'broker.sock'); const ownershipPath = `${endpoint}.owners.json`; const ownerId = 'release-read-budget-owner'; const sessionId = 'release-read-budget-session'; const writes = []; const socket = { writable: true, destroyed: false, zcodeWriter: { write: (line) => writes.push(JSON.parse(line)) }, destroy() {} }; const broker = newTestBroker({ endpoint, brokerToken: '5'.repeat(64), workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } }); broker.authenticated.add(socket); broker.socketOwnerIds.set(socket, ownerId); broker.sessionOwners.set(sessionId, { ownerId, socket, claimToken: null }); await writeFile(ownershipPath, JSON.stringify({ version: 1, sessions: { [sessionId]: ownerId } })); broker.ownershipStoreEstablished = true; let reads = 0; broker.readOwnerStore = async (_allowMissing, options) => { reads += 1; await new Promise((resolvePromise, rejectPromise) => { options.signal.addEventListener('abort', () => rejectPromise(options.signal.reason), { once: true }); }); };
  const started = Date.now(); await broker.handleLocal(socket, JSON.stringify({ id: 78, method: 'broker/releaseOwner', params: { excludeSessionIds: [] } })); assert.equal(reads, 1); assert.ok(Date.now() - started < 850); assert.equal(writes.at(-1).error?.data?.pluginError?.code, 'ZCODE_OWNER_RELEASE_TIMEOUT'); assert.equal(broker.sessionOwners.get(sessionId)?.ownerId, ownerId); await rm(directory, { recursive: true, force: true });
});

test('broker release returns at its hard deadline while its tracked continuation keeps owner fences', { timeout: 4_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-release-uncooperative-read-')); const endpoint = join(directory, 'broker.sock'); const ownershipPath = `${endpoint}.owners.json`; const ownerId = 'release-uncooperative-read-owner'; const sessionId = 'release-uncooperative-read-session'; const writes = []; const socket = { writable: true, destroyed: false, zcodeWriter: { write: (line) => writes.push(JSON.parse(line)) }, destroy() {} }; const broker = newTestBroker({ endpoint, ownershipPath, brokerToken: '2'.repeat(64), workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } }); broker.authenticated.add(socket); broker.socketOwnerIds.set(socket, ownerId); broker.sessionOwners.set(sessionId, { ownerId, socket, claimToken: null }); await writeFile(ownershipPath, JSON.stringify({ version: 1, sessions: { [sessionId]: ownerId } })); broker.ownershipStoreEstablished = true;
  let reads = 0; broker.readOwnerStore = async () => { reads += 1; if (reads === 1) await new Promise((resolvePromise) => setTimeout(resolvePromise, 900)); return { exists: true, sessions: { [sessionId]: ownerId } }; };
  let sendCalls = 0; let createCalls = 0; let stopCalls = 0; broker.protocol = { request: async (method) => { if (method === 'session/send') { sendCalls += 1; return { accepted: true, sessionId, stateRevision: 1 }; } if (method === 'session/create') { createCalls += 1; throw new Error('a fenced create reached ZCode'); } if (method === 'session/stop') { stopCalls += 1; return {}; } throw new Error(`unexpected ${method}`); }, beginTurn() {}, armTurn() {}, abortTurn() {}, cancelTurn() {} };
  const started = Date.now(); const handling = broker.handleLocal(socket, JSON.stringify({ id: 83, method: 'broker/releaseOwner', params: { excludeSessionIds: [] } }));
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 700));
  const releaseResponse = writes.find((frame) => frame.id === 83); assert.equal(releaseResponse?.error?.data?.pluginError?.code, 'ZCODE_OWNER_RELEASE_TIMEOUT'); assert.ok(Date.now() - started < 850, 'caller did not return at the independent release deadline'); assert.equal(broker.admission.ownerStates.get(ownerId)?.release?.ownerId, ownerId); assert.equal(broker.sessionOwners.get(sessionId)?.ownerId, ownerId);
  await broker.handleLocal(socket, JSON.stringify({ id: 84, method: 'session/send', params: { sessionId, inputId: 'release-fenced-send', queryId: 'release-fenced-send', content: 'must not reach ZCode' } }));
  await broker.handleLocal(socket, JSON.stringify({ id: 85, method: 'session/create', params: brokerCreateParams(directory, 'release-fenced-create') }));
  assert.equal(sendCalls, 0); assert.equal(createCalls, 0); assert.equal(writes.find((frame) => frame.id === 84)?.error?.data?.pluginError?.code, 'ZCODE_TURN_ACTIVE'); assert.equal(writes.find((frame) => frame.id === 85)?.error?.data?.pluginError?.code, 'ZCODE_TURN_ACTIVE');
  await handling; while (broker.releaseTasks?.size) await new Promise((resolvePromise) => setImmediate(resolvePromise)); assert.equal(stopCalls, 0, 'timed-out reload continued into a late stop/commit'); assert.equal(broker.admission.ownerStates.has(ownerId), false); assert.equal(JSON.parse(await readFile(ownershipPath, 'utf8')).sessions[sessionId], ownerId);
  const retried = await broker.releaseOwner(socket, ownerId, []); assert.deepEqual(retried.releasedSessionIds, [sessionId]); assert.equal(stopCalls, 1); assert.equal(broker.sessionOwners.has(sessionId), false); await rm(directory, { recursive: true, force: true });
});

test('owner release caller normalizes a continuation that wins the race after an event-loop stall', { timeout: 3_000 }, async (t) => {
  for (const outcome of ['success', 'error']) await t.test(outcome, async () => {
    const directory = await mkdtemp(join(tmpdir(), `zcode-broker-release-late-${outcome}-`)); const broker = newTestBroker({ endpoint: join(directory, 'broker.sock'), brokerToken: '8'.repeat(64), workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } }); const ownerId = `release-late-${outcome}-owner`; const socket = { destroyed: false }; const continuationError = new Error('late continuation error must not escape the absolute deadline');
    broker.releaseOwnerAdmitted = async () => { await new Promise((resolvePromise) => setImmediate(resolvePromise)); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 620); if (outcome === 'error') throw continuationError; return { releasedSessionIds: [], failedSessionIds: [], deferredSessionCount: 0 }; };
    const started = Date.now(); await assert.rejects(broker.releaseOwner(socket, ownerId, []), { code: 'ZCODE_OWNER_RELEASE_TIMEOUT' }); const elapsed = Date.now() - started; assert.ok(elapsed >= 600 && elapsed < 850, `late ${outcome} was not normalized at the absolute deadline: ${elapsed}ms`); assert.equal(broker.admission.ownerStates.has(ownerId), false); assert.equal(broker.releaseTasks.size, 0); await rm(directory, { recursive: true, force: true });
  });
});

test('broker close awaits and reports a timed-out release continuation', { timeout: 3_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-close-release-continuation-')); const endpoint = join(directory, 'broker.sock'); const ownershipPath = `${endpoint}.owners.json`; const ownerId = 'close-release-continuation-owner'; const sessionId = 'close-release-continuation-session'; const writes = []; const socket = { writable: true, destroyed: false, zcodeWriter: { write: (line) => writes.push(JSON.parse(line)) }, destroy() { this.destroyed = true; } }; const broker = newTestBroker({ endpoint, ownershipPath, brokerToken: '3'.repeat(64), workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } }); broker.authenticated.add(socket); broker.socketOwnerIds.set(socket, ownerId); broker.sessionOwners.set(sessionId, { ownerId, socket, claimToken: null }); await writeFile(ownershipPath, JSON.stringify({ version: 1, sessions: { [sessionId]: ownerId } })); broker.ownershipStoreEstablished = true;
  let releaseProtocolClose; const protocolCloseGate = new Promise((resolvePromise) => { releaseProtocolClose = resolvePromise; }); broker.protocol = { close: () => protocolCloseGate };
  let releaseRead; const readGate = new Promise((resolvePromise) => { releaseRead = resolvePromise; }); broker.readOwnerStore = async () => { await readGate; return { exists: true, sessions: { [sessionId]: ownerId } }; };
  const handling = broker.handleLocal(socket, JSON.stringify({ id: 86, method: 'broker/releaseOwner', params: { excludeSessionIds: [] } })); await new Promise((resolvePromise) => setTimeout(resolvePromise, 700)); assert.equal(writes.find((frame) => frame.id === 86)?.error?.data?.pluginError?.code, 'ZCODE_OWNER_RELEASE_TIMEOUT');
  let closeOutcome = 'pending'; const closing = broker.close(); void closing.then(() => { closeOutcome = 'resolved'; }, () => { closeOutcome = 'rejected'; }); await new Promise((resolvePromise) => setTimeout(resolvePromise, 40)); assert.equal(closeOutcome, 'pending');
  releaseRead(); await handling; while (broker.releaseTasks.size) await new Promise((resolvePromise) => setImmediate(resolvePromise)); assert.equal(closeOutcome, 'pending'); releaseProtocolClose(); await assert.rejects(closing, { code: 'ZCODE_OWNER_RELEASE_TIMEOUT' }); assert.equal(closeOutcome, 'rejected'); assert.equal(broker.sessionOwners.get(sessionId)?.ownerId, ownerId); await rm(directory, { recursive: true, force: true });
});

test('broker release entry aborts a stalled owner-store write and keeps ownership retryable', { timeout: 3_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-release-write-budget-')); const endpoint = join(directory, 'broker.sock'); const ownershipPath = `${endpoint}.owners.json`; const ownerId = 'release-write-budget-owner'; const sessionId = 'release-write-budget-session'; const writes = []; const socket = { writable: true, destroyed: false, zcodeWriter: { write: (line) => writes.push(JSON.parse(line)) }, destroy() {} }; const broker = newTestBroker({ endpoint, brokerToken: '6'.repeat(64), workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } }); broker.authenticated.add(socket); broker.socketOwnerIds.set(socket, ownerId); broker.sessionOwners.set(sessionId, { ownerId, socket, claimToken: null }); await writeFile(ownershipPath, JSON.stringify({ version: 1, sessions: { [sessionId]: ownerId } })); broker.ownershipStoreEstablished = true; let writeAttempts = 0; broker.writeOwnerStore = async (_sessions, options) => { writeAttempts += 1; await new Promise((resolvePromise, rejectPromise) => { options.signal.addEventListener('abort', () => rejectPromise(options.signal.reason), { once: true }); }); };
  const started = Date.now(); await broker.handleLocal(socket, JSON.stringify({ id: 79, method: 'broker/releaseOwner', params: { excludeSessionIds: [] } })); assert.equal(writeAttempts, 1); assert.ok(Date.now() - started < 850); assert.equal(writes.at(-1).error?.data?.pluginError?.code, 'ZCODE_OWNER_RELEASE_TIMEOUT'); assert.equal(broker.sessionOwners.get(sessionId)?.ownerId, ownerId); assert.equal(JSON.parse(await readFile(ownershipPath, 'utf8')).sessions[sessionId], ownerId); assert.equal(broker.stoppingSessions.has(sessionId), false); await rm(directory, { recursive: true, force: true });
});

test('broker release canonicalizes a lock timeout that crosses the deadline before its abort callback', { timeout: 3_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-release-timeout-race-')); const endpoint = join(directory, 'broker.sock'); const ownershipPath = `${endpoint}.owners.json`; const ownerId = 'release-timeout-race-owner'; const sessionId = 'release-timeout-race-session'; const writes = []; const socket = { writable: true, destroyed: false, zcodeWriter: { write: (line) => writes.push(JSON.parse(line)) }, destroy() {} }; const broker = newTestBroker({ endpoint, brokerToken: '9'.repeat(64), workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } }); broker.authenticated.add(socket); broker.socketOwnerIds.set(socket, ownerId); broker.sessionOwners.set(sessionId, { ownerId, socket, claimToken: null }); await writeFile(ownershipPath, JSON.stringify({ version: 1, sessions: { [sessionId]: ownerId } })); broker.ownershipStoreEstablished = true; broker.readOwnerStore = async () => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 610); throw new PluginError('LOCK_TIMEOUT', 'The lock deadline won the event-loop race.', { category: 'storage', remedy: 'Retry.' }); };
  await broker.handleLocal(socket, JSON.stringify({ id: 80, method: 'broker/releaseOwner', params: { excludeSessionIds: [] } })); assert.equal(writes.at(-1).error?.data?.pluginError?.code, 'ZCODE_OWNER_RELEASE_TIMEOUT'); assert.equal(broker.sessionOwners.get(sessionId)?.ownerId, ownerId); await rm(directory, { recursive: true, force: true });
});

test('owner release bounds durable ownership lock contention and retains a retryable mapping', { timeout: 3_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-release-commit-budget-')); const endpoint = join(directory, 'broker.sock'); const ownershipPath = `${endpoint}.owners.json`; const ownerId = 'release-budget-lock-owner'; const sessionId = 'release-budget-lock-session'; const socket = { writable: true, destroyed: false, zcodeWriter: { write() {} }, destroy() {} }; const broker = newTestBroker({ endpoint, brokerToken: 'c'.repeat(64), workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } }); broker.sessionOwners.set(sessionId, { ownerId, socket, claimToken: null }); broker.activeSessionSockets.set(sessionId, { socket, token: 'lock-active', baseline: 1, inputId: 'lock-input' }); broker.activeSessions.add(sessionId); await writeFile(ownershipPath, JSON.stringify({ version: 1, sessions: { [sessionId]: ownerId } })); broker.ownershipStoreEstablished = true; let stops = 0; broker.protocol = { request: async (method) => { if (method === 'session/stop') stops += 1; return {}; }, cancelTurn() {} };
  let releaseLock; let lockEntered; const gate = new Promise((resolvePromise) => { releaseLock = resolvePromise; }); const entered = new Promise((resolvePromise) => { lockEntered = resolvePromise; }); const holder = withFileLock(`${ownershipPath}.lock`, async () => { lockEntered(); await gate; }); await entered; const started = Date.now(); const releasing = broker.releaseOwner(socket, ownerId, []); let outcome;
  try { outcome = await Promise.race([releasing.then((value) => ({ value }), (error) => ({ error })), new Promise((resolvePromise) => setTimeout(() => resolvePromise({ timeout: true }), 850))]); } finally { releaseLock(); await holder; }
  await releasing.catch(() => {}); while (broker.releaseTasks.size) await new Promise((resolvePromise) => setImmediate(resolvePromise)); assert.equal(outcome.timeout, undefined, 'releaseOwner exceeded its absolute budget while committing ownership'); assert.equal(outcome.error?.code, 'ZCODE_OWNER_RELEASE_TIMEOUT'); assert.ok(Date.now() - started < 1_000); assert.equal(stops, 1); assert.equal(broker.sessionOwners.get(sessionId)?.ownerId, ownerId); assert.equal(broker.activeSessionSockets.has(sessionId), false); assert.equal(broker.stoppingSessions.has(sessionId), false); await rm(directory, { recursive: true, force: true });
});

test('session stop settles only its permission and ignores the exact late response without harming multiplexed work', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-permission-stop-')); const writes = []; let destroyed = 0;
  const broker = newTestBroker({ endpoint: join(directory, 'broker.sock'), brokerToken: '7'.repeat(64), workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } });
  const socket = { writable: true, zcodeWriter: { write: (line) => writes.push(JSON.parse(line)) }, destroy: () => { destroyed += 1; } }; const wrongSocket = { ...socket, destroy: () => { destroyed += 1; } };
  broker.authenticated.add(socket); broker.authenticated.add(wrongSocket); broker.socketOwnerIds.set(socket, 'permission-owner-stable'); broker.socketOwnerIds.set(wrongSocket, 'permission-owner-stable');
  broker.activeSessionSockets.set('session-a', { socket, token: 'turn-a' }); broker.activeSessionSockets.set('session-b', { socket, token: 'turn-b' });
  const request = (sessionId) => ({ requestId: `request-${sessionId}`, sessionId, options: [{ response: { decision: 'allow' } }, { response: { decision: 'deny' } }] });
  const permissionA = broker.requestPermission(request('session-a')); const permissionB = broker.requestPermission(request('session-b')); const [idA, idB] = writes.map((frame) => frame.id);
  broker.settleStoppedSession('session-a', broker.activeSessionSockets.get('session-a'));
  assert.deepEqual(await permissionA, { decision: 'deny' }); let bSettled = false; permissionB.finally(() => { bSettled = true; }).catch(() => {}); await new Promise((resolve) => setImmediate(resolve)); assert.equal(bSettled, false);
  await broker.handleLocal(socket, JSON.stringify({ id: idA, result: { decision: 'allow' } })); assert.equal(destroyed, 0);
  await broker.handleLocal(wrongSocket, JSON.stringify({ id: idA, result: { decision: 'allow' } })); assert.equal(destroyed, 1);
  await broker.handleLocal(socket, JSON.stringify({ id: idB, result: { decision: 'allow' } })); assert.deepEqual(await permissionB, { decision: 'allow' }); assert.equal(destroyed, 1);
  await broker.handleLocal(socket, JSON.stringify({ id: idB + 999, result: { decision: 'allow' } })); assert.equal(destroyed, 2);
  await rm(directory, { recursive: true, force: true });
});

test('protocol reset retires pending permissions so exact late responses do not destroy the multiplexed socket', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-permission-reset-')); const writes = []; let ownerDestroyed = 0; let attackerDestroyed = 0; const broker = newTestBroker({ endpoint: join(directory, 'broker.sock'), brokerToken: '4'.repeat(64), workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } }); const ownerSocket = { writable: true, zcodeWriter: { write: (line) => writes.push(JSON.parse(line)) }, destroy: () => { ownerDestroyed += 1; } }; const attackerSocket = { ...ownerSocket, destroy: () => { attackerDestroyed += 1; } }; broker.authenticated.add(ownerSocket); broker.authenticated.add(attackerSocket); const protocol = {}; broker.protocol = protocol; broker.activeSessionSockets.set('permission-reset-session', { socket: ownerSocket, token: 'permission-reset-turn' }); const request = { requestId: 'permission-reset-request', sessionId: 'permission-reset-session', options: [{ response: { decision: 'allow' } }, { response: { decision: 'deny' } }] }; const permission = broker.requestPermission(request); const permissionId = writes.at(-1).id;
  broker.clearProtocolGeneration(protocol); assert.deepEqual(await permission, { decision: 'deny' }); await broker.handleLocal(attackerSocket, JSON.stringify({ id: permissionId, result: { decision: 'allow' } })); assert.equal(attackerDestroyed, 1); await broker.handleLocal(ownerSocket, JSON.stringify({ id: permissionId, result: { decision: 'allow' } })); assert.equal(ownerDestroyed, 0); await broker.handleLocal(ownerSocket, JSON.stringify({ id: permissionId + 999, result: { decision: 'allow' } })); assert.equal(ownerDestroyed, 1); await rm(directory, { recursive: true, force: true });
});

test('a late stop acknowledgement cannot clear or deny a newer generation of the same session', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-stop-generation-')); const writes = [];
  const broker = newTestBroker({ endpoint: join(directory, 'broker.sock'), brokerToken: '8'.repeat(64), workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } });
  const oldSocket = { writable: true, zcodeWriter: { write: (line) => writes.push(JSON.parse(line)) }, destroy() {} }; const newSocket = { ...oldSocket }; broker.authenticated.add(newSocket);
  const request = { requestId: 'old-request', sessionId: 'shared-session', options: [{ response: { decision: 'allow' } }, { response: { decision: 'deny' } }] };
  const oldTurn = { socket: oldSocket, token: 'old-turn' }; broker.activeSessionSockets.set(request.sessionId, oldTurn); const oldPermission = broker.requestPermission(request);
  const newTurn = { socket: newSocket, token: 'new-turn' }; broker.activeSessionSockets.set(request.sessionId, newTurn); const newPermission = broker.requestPermission({ ...request, requestId: 'new-request' }); let newSettled = false; newPermission.finally(() => { newSettled = true; }).catch(() => {});
  broker.settleStoppedSession(request.sessionId, oldTurn); assert.deepEqual(await oldPermission, { decision: 'deny' }); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(newSettled, false); assert.equal(broker.activeSessionSockets.get(request.sessionId), newTurn);
  const newId = writes.find((frame) => frame.params?.requestId === 'new-request').id; await broker.handleLocal(newSocket, JSON.stringify({ id: newId, result: { decision: 'allow' } })); assert.deepEqual(await newPermission, { decision: 'allow' });
  await rm(directory, { recursive: true, force: true });
});

test('owner release uses the same exact-session stop notification without disconnecting the client', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-release-active-')); const endpoint = brokerEndpointFor({ dataRoot: directory, workspace: directory }); const brokerToken = 'a'.repeat(64); const ownerId = 'release-active-owner-stable';
  const broker = await newTestBroker({ endpoint, brokerToken, workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture }, env: { ...process.env, FAKE_ZCODE_SUPPRESS_FIRST_COMPLETION: '1' } }).start();
  const worker = await createZCodeClient({ workspace: directory, brokerEndpoint: endpoint, brokerToken, ownerId, completionTimeoutMs: 1_000 }); const controller = await createZCodeClient({ workspace: directory, brokerEndpoint: endpoint, brokerToken, ownerId });
  try { const sessionId = (await worker.createSession({ workspace: directory })).session.sessionId; const subscription = await worker.subscribeConversation(sessionId, { connectionId: 'release-owner-connection', clientMode: 'desktop-continuous' }); await worker.send(sessionId, 'hold'); const stopped = assert.rejects(worker.waitForCompletion(sessionId), { code: 'ZCODE_SESSION_STOPPED' }); let fencedDuringApply = false; const settleStoppedSession = broker.settleStoppedSession.bind(broker); broker.settleStoppedSession = (...args) => { fencedDuringApply = broker.stoppingSessions.has(sessionId); return settleStoppedSession(...args); }; const released = await controller.releaseOwner([]); assert.deepEqual(released.releasedSessionIds, [sessionId]); await stopped; assert.equal(fencedDuringApply, true); assert.equal([...broker.conversationSubscriptions.values()].some((entry) => entry.sessionId === sessionId), false); await subscription.unsubscribe().catch(() => {}); assert.deepEqual(await controller.brokerCapabilities(), { releaseOwnerExclusions: true }); }
  finally { await worker.close(); await controller.close(); await broker.close(); await rm(directory, { recursive: true, force: true }); }
});

test('direct stop establishes its generation fence before awaiting protocol acquisition', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-stop-admission-')); const broker = newTestBroker({ endpoint: join(directory, 'broker.sock'), brokerToken: 'd'.repeat(64), workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } }); const sessionId = 'stop-admission-session'; const ownerId = 'stop-admission-owner'; const writes = [];
  const socket = { writable: true, zcodeWriter: { write: (line) => writes.push(JSON.parse(line)) }, destroy() {} }; broker.authenticated.add(socket); broker.socketOwnerIds.set(socket, ownerId); broker.sessionOwners.set(sessionId, { ownerId, socket, claimToken: null }); broker.activeSessionSockets.set(sessionId, { socket, token: 'active-generation', baseline: 1, inputId: 'input-1' });
  let entered; let release; const protocolRequested = new Promise((resolve) => { entered = resolve; }); const gate = new Promise((resolve) => { release = resolve; }); const protocol = { request: async () => ({}), cancelTurn() {} }; broker.getProtocol = async () => { entered(); await gate; broker.protocol = protocol; return protocol; };
  const stopping = broker.handleLocal(socket, JSON.stringify({ id: 1, method: 'session/stop', params: { sessionId } })); await protocolRequested;
  assert.equal(broker.stoppingSessions.get(sessionId)?.activeToken, 'active-generation'); release(); await stopping; assert.deepEqual(writes.at(-1), { id: 1, result: {} }); await rm(directory, { recursive: true, force: true });
});

test('an invalid early terminal cannot clear the accepted generation route', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-terminal-generation-')); const endpoint = brokerEndpointFor({ dataRoot: directory, workspace: directory }); const brokerToken = 'e'.repeat(64); const ownerId = 'terminal-generation-owner';
  const broker = await newTestBroker({ endpoint, brokerToken, workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture }, env: { ...process.env, FAKE_ZCODE_BARRIER: '1' } }).start(); const creator = await createZCodeClient({ workspace: directory, brokerEndpoint: endpoint, brokerToken, ownerId }); const sender = await createZCodeClient({ workspace: directory, brokerEndpoint: endpoint, brokerToken, ownerId, completionTimeoutMs: 1_000 });
  try { const sessionId = (await creator.createSession({ workspace: directory })).session.sessionId; await sender.send(sessionId, 'barrier'); await sender.waitForCompletion(sessionId); }
  finally { await creator.close(); await sender.close(); await broker.close(); await rm(directory, { recursive: true, force: true }); }
});

test('a pending stop fences new sends until its exact acknowledgement', { timeout: 5_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-stop-fence-')); const endpoint = brokerEndpointFor({ dataRoot: directory, workspace: directory }); const brokerToken = 'b'.repeat(64); const ownerId = 'stop-fence-owner-stable'; const gate = join(directory, 'stop.gate'); const reached = join(directory, 'stop.reached'); await writeFile(gate, 'hold');
  const broker = await newTestBroker({ endpoint, brokerToken, workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture }, env: { ...process.env, FAKE_ZCODE_STOP_GATE: gate, FAKE_ZCODE_STOP_GATE_REACHED: reached } }).start();
  const creator = await createZCodeClient({ workspace: directory, brokerEndpoint: endpoint, brokerToken, ownerId }); const controller = await createZCodeClient({ workspace: directory, brokerEndpoint: endpoint, brokerToken, ownerId }); const sender = await createZCodeClient({ workspace: directory, brokerEndpoint: endpoint, brokerToken, ownerId });
  const bounded = async (promise, label) => { let timer; try { return await Promise.race([promise, new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), 1_000); })]); } finally { clearTimeout(timer); } };
  try { const sessionId = (await creator.createSession({ workspace: directory })).session.sessionId; const stopping = controller.stopSession(sessionId); const deadline = Date.now() + 1_000; while ((await readFile(reached, 'utf8').catch(() => '')) !== 'blocked' && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5)); assert.equal(await readFile(reached, 'utf8'), 'blocked'); await assert.rejects(bounded(sender.send(sessionId, 'must be fenced'), 'fenced send'), { code: 'ZCODE_TURN_ACTIVE' }); await writeFile(gate, 'release'); await bounded(stopping, 'stop acknowledgement'); assert.equal((await bounded(sender.send(sessionId, 'after stop'), 'post-stop send')).accepted, true); await bounded(sender.waitForCompletion(sessionId), 'post-stop completion'); }
  finally { await writeFile(gate, 'release').catch(() => {}); await creator.close(); await controller.close(); await sender.close(); await broker.close(); await rm(directory, { recursive: true, force: true }); }
});

test('failed same-owner broker stop preserves the active client and its later completion', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-stop-failed-')); const endpoint = brokerEndpointFor({ dataRoot: directory, workspace: directory }); const brokerToken = '2'.repeat(64); const ownerId = 'stop-failed-owner-stable'; const gate = join(directory, 'completion.gate'); await writeFile(gate, 'hold');
  const broker = await newTestBroker({ endpoint, brokerToken, workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture }, env: { ...process.env, FAKE_ZCODE_COMPLETION_GATE: gate, FAKE_ZCODE_STOP_ERROR_PREFIX: 'session-' } }).start();
  const worker = await createZCodeClient({ workspace: directory, brokerEndpoint: endpoint, brokerToken, ownerId, completionTimeoutMs: 2_000 }); const controller = await createZCodeClient({ workspace: directory, brokerEndpoint: endpoint, brokerToken, ownerId });
  try { const { session: { sessionId } } = await worker.createSession({ workspace: directory }); await worker.send(sessionId, 'hold'); const completion = worker.waitForCompletion(sessionId); await assert.rejects(controller.stopSession(sessionId), { code: 'ZCODE_REQUEST_FAILED' }); await writeFile(gate, 'release'); await completion; }
  finally { await worker.close(); await controller.close(); await broker.close(); await rm(directory, { recursive: true, force: true }); }
});

test('active broker client can stop its own turn without disconnecting itself', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-stop-self-')); const endpoint = brokerEndpointFor({ dataRoot: directory, workspace: directory }); const brokerToken = '3'.repeat(64);
  const broker = await newTestBroker({ endpoint, brokerToken, workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture }, env: { ...process.env, FAKE_ZCODE_SUPPRESS_FIRST_COMPLETION: '1' } }).start(); const client = await createZCodeClient({ workspace: directory, brokerEndpoint: endpoint, brokerToken, ownerId: 'stop-self-owner-stable' });
  try { const { session: { sessionId } } = await client.createSession({ workspace: directory }); await client.send(sessionId, 'hold'); const completion = client.waitForCompletion(sessionId); assert.deepEqual(await client.stopSession(sessionId), {}); await assert.rejects(completion, { code: 'ZCODE_SESSION_STOPPED' }); assert.equal((await client.listSessions()).sessions[0].sessionId, sessionId); }
  finally { await client.close(); await broker.close(); await rm(directory, { recursive: true, force: true }); }
});

test('completed broker becomes truly idle after its final owner disconnects', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-idle-')); const endpoint = brokerEndpointFor({ dataRoot: directory, workspace: directory }); const brokerToken = '7'.repeat(64);
  const broker = await newTestBroker({ endpoint, brokerToken, workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture }, idleTimeoutMs: 20 }).start(); const client = await createZCodeClient({ workspace: directory, brokerEndpoint: endpoint, brokerToken, ownerId: 'idle-owner-stable' });
  try { const { session: { sessionId } } = await client.createSession({ workspace: directory }); await client.send(sessionId, 'finish'); await client.waitForCompletion(sessionId); await client.close(); for (let index = 0; index < 100 && (broker.server || broker.protocol); index += 1) await new Promise((resolve) => setTimeout(resolve, 5)); assert.equal(broker.server, null); assert.equal(broker.protocol, null); assert.equal(broker.activeSessions.size, 0); }
  finally { await client.close(); await broker.close(); await rm(directory, { recursive: true, force: true }); }
});

test('concurrent lazy broker acquisition publishes one healthy pid and identity', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-ensure-')); let brokerPid;
  try {
    const options = { dataRoot: directory, workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture }, idleTimeoutMs: 100 };
    const identities = await Promise.all([ensureZCodeBroker(options), ensureZCodeBroker(options)]);
    brokerPid = identities[0].pid;
    assert.equal(identities[0].pid, identities[1].pid);
    assert.equal(identities[0].instanceId, identities[1].instanceId);
    const client = await createZCodeClient({ workspace: directory, brokerEndpoint: identities[0].endpoint, brokerToken: identities[0].brokerToken, ownerId: 'ensure-owner-stable' });
    await client.close();
  } finally {
    if (brokerPid && processAlive(brokerPid)) try { process.kill(brokerPid, 'SIGTERM'); } catch { /* idle shutdown won */ }
    if (brokerPid) await waitForProcessExit(brokerPid);
    await rm(directory, { recursive: true, force: true });
  }
});

test('broker allows explicit imported create and atomically assigns resume ownership', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-owner-'));
  const endpoint = brokerEndpointFor({ dataRoot: directory, workspace: directory });
  const brokerToken = 'c'.repeat(64);
  const broker = await newTestBroker({ endpoint, brokerToken, workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } }).start();
  const first = await createZCodeClient({ workspace: directory, brokerEndpoint: endpoint, brokerToken, ownerId: 'explicit-owner-first' });
  const second = await createZCodeClient({ workspace: directory, brokerEndpoint: endpoint, brokerToken, ownerId: 'explicit-owner-second' });
  try {
    const explicit = await first.createSession({ workspace: directory, sessionId: 'imported-session', importedHistory: { messages: [{ role: 'user', content: 'history' }] } });
    assert.equal(explicit.session.sessionId, 'imported-session');
    await first.createSession({ workspace: directory, sessionId: 'race-session', importedHistory: { messages: [{ role: 'user', content: 'history' }] } });
    const results = await Promise.allSettled([first.resumeSession('race-session'), second.resumeSession('race-session')]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  } finally { await first.close(); await second.close(); await broker.close(); await rm(directory, { recursive: true, force: true }); }
});

test('unauthenticated broker socket receives no notifications and owns no session', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-unauth-')); const endpoint = brokerEndpointFor({ dataRoot: directory, workspace: directory }); const brokerToken = 'd'.repeat(64);
  const broker = await newTestBroker({ endpoint, brokerToken, workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } }).start();
  const attacker = net.createConnection(endpoint); await new Promise((resolve) => attacker.once('connect', resolve)); let received = '';
  attacker.on('data', (chunk) => { received += chunk; });
  const client = await createZCodeClient({ workspace: directory, brokerEndpoint: endpoint, brokerToken, ownerId: 'notification-owner' });
  try { const created = await client.createSession({ workspace: directory }); await client.send(created.session.sessionId, 'private'); await client.waitForCompletion(created.session.sessionId); await new Promise((resolve) => setTimeout(resolve, 20)); assert.equal(received, ''); }
  finally { attacker.destroy(); await client.close(); await broker.close(); await rm(directory, { recursive: true, force: true }); }
});

test('stable owner credential prevents sibling reclaim after disconnect', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-owner-id-')); const endpoint = brokerEndpointFor({ dataRoot: directory, workspace: directory }); const brokerToken = 'e'.repeat(64); const broker = await newTestBroker({ endpoint, brokerToken, workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } }).start();
  const ownerId = 'owner-session-credential-1'; const owner = await createZCodeClient({ workspace: directory, brokerEndpoint: endpoint, brokerToken, ownerId });
  await owner.createSession({ workspace: directory, sessionId: 'durable-session', importedHistory: { messages: [{ role: 'user', content: 'x' }] } }); await owner.close();
  const sibling = await createZCodeClient({ workspace: directory, brokerEndpoint: endpoint, brokerToken, ownerId: 'sibling-credential-2' });
  await assert.rejects(sibling.resumeSession('durable-session'), { code: 'ZCODE_REQUEST_FAILED' }); await sibling.close();
  const resumed = await createZCodeClient({ workspace: directory, brokerEndpoint: endpoint, brokerToken, ownerId }); await resumed.resumeSession('durable-session'); await resumed.close(); await broker.close(); await rm(directory, { recursive: true, force: true });
});

test('late same-owner claim failure cannot erase a newer successful claim', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-owner-aba-')); const endpoint = brokerEndpointFor({ dataRoot: directory, workspace: directory }); const brokerToken = '8'.repeat(64); const ownerId = 'owner-credential-aba';
  const broker = await newTestBroker({ endpoint, brokerToken, workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture }, env: { ...process.env, FAKE_ZCODE_RESUME_ABA: '1' } }).start();
  const first = await createZCodeClient({ workspace: directory, brokerEndpoint: endpoint, brokerToken, ownerId }); const second = await createZCodeClient({ workspace: directory, brokerEndpoint: endpoint, brokerToken, ownerId });
  try { await first.createSession({ workspace: directory, sessionId: 'aba-session', importedHistory: { messages: [{ role: 'user', content: 'x' }] } }); const results = await Promise.allSettled([first.resumeSession('aba-session'), second.resumeSession('aba-session')]); assert.deepEqual(results.map((result) => result.status).sort(), ['fulfilled', 'rejected']); const sibling = await createZCodeClient({ workspace: directory, brokerEndpoint: endpoint, brokerToken, ownerId: 'sibling-credential-aba' }); try { await assert.rejects(sibling.resumeSession('aba-session'), { code: 'ZCODE_REQUEST_FAILED' }); } finally { await sibling.close(); } }
  finally { await first.close(); await second.close(); await broker.close(); await rm(directory, { recursive: true, force: true }); }
});

test('durable owner bindings survive broker restart and fail closed when corrupt', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-owner-restart-')); const workspace = realpathSync(directory); const endpoint = brokerEndpointFor({ dataRoot: directory, workspace: directory }); const ownershipPath = join(directory, 'owners.json'); const brokerToken = '6'.repeat(64); const launch = { command: process.execPath, args: [fixture], target: fixture };
  let broker = await newTestBroker({ endpoint, ownershipPath, brokerToken, workspace: directory, launch, env: { ...process.env, FAKE_ZCODE_WORKSPACE: workspace } }).start(); const ownerId = 'stable-owner-for-restart'; const owner = await createZCodeClient({ workspace: directory, brokerEndpoint: endpoint, brokerToken, ownerId }); await owner.createSession({ workspace: directory, sessionId: 'restart-session', importedHistory: { messages: [{ role: 'user', content: 'x' }] } }); const ownershipStat = await stat(ownershipPath); if (process.platform === 'win32') assert.equal(ownershipStat.isFile(), true); else assert.equal(ownershipStat.mode & 0o777, 0o600); await owner.close(); await broker.close();
  broker = await newTestBroker({ endpoint, ownershipPath, brokerToken, workspace: directory, launch, env: { ...process.env, FAKE_ZCODE_WORKSPACE: workspace } }).start(); const sibling = await createZCodeClient({ workspace: directory, brokerEndpoint: endpoint, brokerToken, ownerId: 'different-owner-restart' }); await assert.rejects(sibling.resumeSession('restart-session'), { code: 'ZCODE_REQUEST_FAILED' }); await sibling.close(); const reconnect = await createZCodeClient({ workspace: directory, brokerEndpoint: endpoint, brokerToken, ownerId }); await reconnect.resumeSession('restart-session'); await reconnect.close(); await broker.close();
  await writeFile(ownershipPath, '{bad'); await assert.rejects(newTestBroker({ endpoint, ownershipPath, brokerToken, workspace: directory, launch }).start(), { code: 'ZCODE_OWNER_STORE_INVALID' }); await rm(directory, { recursive: true, force: true });
});

test('trusted reconciliation seeds pre-upgrade ownership and live broker reloads it fail closed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-owner-reconcile-')); const storage = await resolveWorkspaceStorage({ dataRoot: directory, workspace: directory }); const ownershipPath = join(storage.directory, 'broker', 'session-owners.json'); const endpoint = brokerEndpointFor({ dataRoot: directory, workspace: directory }); const brokerToken = '5'.repeat(64); const record = join(directory, 'calls.jsonl'); const ownerId = 'reconciled-owner-stable'; const sessionId = 'pre-upgrade-session'; const liveSessionId = 'live-reconciled-session';
  await reconcileBrokerOwnership({ dataRoot: directory, workspace: directory, ownerId, ownedSessionIds: [sessionId] });
  const broker = await newTestBroker({ endpoint, ownershipPath, brokerToken, workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture }, env: { ...process.env, FAKE_ZCODE_RECORD: record, FAKE_ZCODE_WORKSPACE: storage.workspacePath } }).start();
  try {
    await reconcileBrokerOwnership({ dataRoot: directory, workspace: directory, ownerId, ownedSessionIds: [sessionId] });
    await reconcileBrokerOwnership({ dataRoot: directory, workspace: directory, ownerId, ownedSessionIds: [sessionId, liveSessionId] });
    const owner = await createZCodeClient({ workspace: directory, brokerEndpoint: endpoint, brokerToken, ownerId }); await owner.resumeSession(sessionId); await owner.resumeSession(liveSessionId); await owner.close();
    assert.ok((await readFile(record, 'utf8')).split('\n').some((line) => line && JSON.parse(line).method === 'session/resume'));
    const sibling = await createZCodeClient({ workspace: directory, brokerEndpoint: endpoint, brokerToken, ownerId: 'reconciled-sibling' }); await assert.rejects(sibling.resumeSession(sessionId), { code: 'ZCODE_REQUEST_FAILED' }); await sibling.close();
    await assert.rejects(reconcileBrokerOwnership({ dataRoot: directory, workspace: directory, ownerId: 'conflicting-owner', ownedSessionIds: [sessionId] }), { code: 'ZCODE_SESSION_OWNER_CONFLICT' });
    await rm(ownershipPath); const reconnected = await createZCodeClient({ workspace: directory, brokerEndpoint: endpoint, brokerToken, ownerId }); await assert.rejects(reconnected.resumeSession(sessionId), { code: 'ZCODE_OWNER_STORE_INVALID' }); assert.equal(broker.sessionOwners.get(sessionId).ownerId, ownerId); await reconcileBrokerOwnership({ dataRoot: directory, workspace: directory, ownerId, ownedSessionIds: [sessionId, liveSessionId] }); await reconnected.resumeSession(sessionId); await reconnected.close();
    await writeFile(ownershipPath, '{bad'); await assert.rejects(reconcileBrokerOwnership({ dataRoot: directory, workspace: directory, ownerId, ownedSessionIds: [sessionId] }), { code: 'ZCODE_OWNER_STORE_INVALID' });
  } finally { await broker.close(); await rm(directory, { recursive: true, force: true }); }
});

test('broker removes only the identity record belonging to its own instance', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-identity-clean-')); const endpoint = brokerEndpointFor({ dataRoot: directory, workspace: directory }); const identityPath = join(directory, 'identity.json'); const options = { endpoint, identityPath, brokerToken: '2'.repeat(64), workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } };
  await writeFile(identityPath, JSON.stringify({ instanceId: 'instance-a' }), { mode: 0o600 }); const first = await newTestBroker({ ...options, instanceId: 'instance-a' }).start(); await first.close(); await assert.rejects(readFile(identityPath), (error) => error.code === 'ENOENT');
  await writeFile(identityPath, JSON.stringify({ instanceId: 'replacement' }), { mode: 0o600 }); const second = await newTestBroker({ ...options, instanceId: 'instance-b' }).start(); await second.close(); assert.equal(JSON.parse(await readFile(identityPath, 'utf8')).instanceId, 'replacement'); await rm(directory, { recursive: true, force: true });
});

test('broker identity cleanup rechecks ownership inside the startup advisory lock', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-identity-lock-')); const identityPath = join(directory, 'identity.json'); const lockPath = join(directory, '.lock');
  const broker = newTestBroker({ endpoint: join(directory, 'broker.sock'), identityPath, instanceId: 'old-instance', brokerToken: '2'.repeat(64), workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } });
  await writeFile(identityPath, JSON.stringify({ instanceId: 'old-instance' }), { mode: 0o600 });
  let releaseLock; let signalAcquired; const acquired = new Promise((resolve) => { signalAcquired = resolve; }); const release = new Promise((resolve) => { releaseLock = resolve; });
  const holder = withFileLock(lockPath, async () => { signalAcquired(); await release; });
  await acquired;
  let cleanupSettled = false; const cleanup = broker.removeIdentityIfOwned().finally(() => { cleanupSettled = true; });
  for (let turn = 0; turn < 20; turn += 1) await new Promise((resolve) => setImmediate(resolve));
  const settledWhileLocked = cleanupSettled;
  await writeFile(identityPath, JSON.stringify({ instanceId: 'replacement-instance' }), { mode: 0o600 });
  releaseLock(); await holder; await cleanup;
  assert.equal(settledWhileLocked, false, 'cleanup must wait for the startup lock');
  assert.equal(JSON.parse(await readFile(identityPath, 'utf8')).instanceId, 'replacement-instance');
  await rm(directory, { recursive: true, force: true });
});

test('broker identity cleanup reports corrupt identity paths as stable plugin errors', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-identity-error-')); const identityPath = join(directory, 'identity.json');
  const broker = newTestBroker({ endpoint: join(directory, 'broker.sock'), identityPath, instanceId: 'old-instance', brokerToken: '2'.repeat(64), workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } });
  await writeFile(identityPath, '{not-json', { mode: 0o600 });
  await assert.rejects(broker.removeIdentityIfOwned(), { name: 'PluginError', code: 'ZCODE_BROKER_IDENTITY_CLEANUP_FAILED' });
  await rm(directory, { recursive: true, force: true });
});

test('concurrent broker close callers share completion through locked identity cleanup', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-close-shared-')); const endpoint = brokerEndpointFor({ dataRoot: directory, workspace: directory }); const identityPath = join(directory, 'identity.json'); const lockPath = join(directory, '.lock');
  const broker = await newTestBroker({ endpoint, identityPath, instanceId: 'shared-close-instance', brokerToken: '2'.repeat(64), workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } }).start();
  await writeFile(identityPath, JSON.stringify({ instanceId: 'shared-close-instance' }), { mode: 0o600 });
  const protocol = await broker.getProtocol(); const child = protocol.child;
  let cleanupCalls = 0; const removeIdentityIfOwned = broker.removeIdentityIfOwned.bind(broker); broker.removeIdentityIfOwned = async () => { cleanupCalls += 1; return removeIdentityIfOwned(); };
  let releaseLock; let signalAcquired; const acquired = new Promise((resolve) => { signalAcquired = resolve; }); const release = new Promise((resolve) => { releaseLock = resolve; });
  const holder = withFileLock(lockPath, async () => { signalAcquired(); await release; }); await acquired;
  let firstSettled = false; let secondSettled = false;
  const firstClose = broker.close(); firstClose.finally(() => { firstSettled = true; }).catch(() => {});
  const secondClose = broker.close(); secondClose.finally(() => { secondSettled = true; }).catch(() => {});
  for (let turn = 0; turn < 20; turn += 1) await new Promise((resolve) => setImmediate(resolve));
  const samePromise = firstClose === secondClose; const settledWhileLocked = [firstSettled, secondSettled];
  releaseLock(); await holder; await Promise.all([firstClose, secondClose]);
  assert.equal(samePromise, true);
  assert.deepEqual(settledWhileLocked, [false, false]);
  assert.equal(broker.server, null); assert.equal(broker.protocol, null); assert.ok(child.exitCode !== null || child.signalCode !== null);
  await assert.rejects(readFile(identityPath), (error) => error.code === 'ENOENT');
  const thirdClose = broker.close(); assert.equal(thirdClose, firstClose); await thirdClose; assert.equal(cleanupCalls, 1);
  await rm(directory, { recursive: true, force: true });
});

test('concurrent broker close callers observe the same cleanup failure without unhandled rejection', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-close-failure-')); const identityPath = join(directory, 'identity.json');
  const broker = newTestBroker({ endpoint: join(directory, 'broker.sock'), identityPath, instanceId: 'failed-close-instance', brokerToken: '2'.repeat(64), workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } });
  await writeFile(identityPath, '{not-json', { mode: 0o600 });
  const firstClose = broker.close(); const secondClose = broker.close();
  const outcomes = await Promise.allSettled([firstClose, secondClose]);
  assert.equal(firstClose, secondClose);
  assert.deepEqual(outcomes.map((outcome) => outcome.status), ['rejected', 'rejected']);
  assert.equal(outcomes[0].reason, outcomes[1].reason);
  assert.equal(outcomes[0].reason.code, 'ZCODE_BROKER_IDENTITY_CLEANUP_FAILED');
  const thirdClose = broker.close(); assert.equal(thirdClose, firstClose); await assert.rejects(thirdClose, { code: 'ZCODE_BROKER_IDENTITY_CLEANUP_FAILED' });
  await rm(directory, { recursive: true, force: true });
});

test('launch target is revalidated before spawning', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-missing-'));
  const target = join(directory, 'gone.mjs');
  await writeFile(target, '');
  await rm(target);
  await assert.rejects(createZCodeClient({ workspace: directory, launch: { command: process.execPath, args: [target], target } }), { code: 'ZCODE_LAUNCH_TARGET_MISSING' });
  await rm(directory, { recursive: true, force: true });
});
