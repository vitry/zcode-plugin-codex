// @ts-nocheck
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import test from 'node:test';

import { createExistingManagedZCodeClient, createManagedZCodeClient, createZCodeClient } from '../scripts/lib/zcode-client.mjs';
import { brokerEndpointFor, brokerIdentityNameForWireOptions, ensureZCodeBroker, reconcileBrokerOwnership, writeBrokerIdentity, ZCodeBroker as ZCodeBrokerClass } from '../scripts/zcode-broker.mjs';
import { withFileLock } from '../scripts/lib/fs.mjs';
import { resolveWorkspaceStorage } from '../scripts/lib/workspace.mjs';

const fixture = fileURLToPath(new URL('./fixtures/fake-zcode-cli.mjs', import.meta.url));

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
  }));

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
    }, { FAKE_ZCODE_ERROR: 'session/list', FAKE_ZCODE_ERROR_DATA_CODE: remoteCode }));
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
  const directory = await mkdtemp(join(tmpdir(), 'zcode-owner-restart-')); const endpoint = brokerEndpointFor({ dataRoot: directory, workspace: directory }); const ownershipPath = join(directory, 'owners.json'); const brokerToken = '6'.repeat(64); const launch = { command: process.execPath, args: [fixture], target: fixture };
  let broker = await newTestBroker({ endpoint, ownershipPath, brokerToken, workspace: directory, launch }).start(); const ownerId = 'stable-owner-for-restart'; const owner = await createZCodeClient({ workspace: directory, brokerEndpoint: endpoint, brokerToken, ownerId }); await owner.createSession({ workspace: directory, sessionId: 'restart-session', importedHistory: { messages: [{ role: 'user', content: 'x' }] } }); const ownershipStat = await stat(ownershipPath); if (process.platform === 'win32') assert.equal(ownershipStat.isFile(), true); else assert.equal(ownershipStat.mode & 0o777, 0o600); await owner.close(); await broker.close();
  broker = await newTestBroker({ endpoint, ownershipPath, brokerToken, workspace: directory, launch }).start(); const sibling = await createZCodeClient({ workspace: directory, brokerEndpoint: endpoint, brokerToken, ownerId: 'different-owner-restart' }); await assert.rejects(sibling.resumeSession('restart-session'), { code: 'ZCODE_REQUEST_FAILED' }); await sibling.close(); const reconnect = await createZCodeClient({ workspace: directory, brokerEndpoint: endpoint, brokerToken, ownerId }); await reconnect.resumeSession('restart-session'); await reconnect.close(); await broker.close();
  await writeFile(ownershipPath, '{bad'); await assert.rejects(newTestBroker({ endpoint, ownershipPath, brokerToken, workspace: directory, launch }).start(), { code: 'ZCODE_OWNER_STORE_INVALID' }); await rm(directory, { recursive: true, force: true });
});

test('trusted reconciliation seeds pre-upgrade ownership and live broker reloads it fail closed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-owner-reconcile-')); const storage = await resolveWorkspaceStorage({ dataRoot: directory, workspace: directory }); const ownershipPath = join(storage.directory, 'broker', 'session-owners.json'); const endpoint = brokerEndpointFor({ dataRoot: directory, workspace: directory }); const brokerToken = '5'.repeat(64); const record = join(directory, 'calls.jsonl'); const ownerId = 'reconciled-owner-stable'; const sessionId = 'pre-upgrade-session'; const liveSessionId = 'live-reconciled-session';
  await reconcileBrokerOwnership({ dataRoot: directory, workspace: directory, ownerId, ownedSessionIds: [sessionId] });
  const broker = await newTestBroker({ endpoint, ownershipPath, brokerToken, workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture }, env: { ...process.env, FAKE_ZCODE_RECORD: record } }).start();
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
