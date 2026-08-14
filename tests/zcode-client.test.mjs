// @ts-nocheck
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import net from 'node:net';
import test from 'node:test';

import { createExistingManagedZCodeClient, createManagedZCodeClient, createZCodeClient, releaseManagedZCodeOwner, ZCodeClient } from '../scripts/lib/zcode-client.mjs';
import { brokerEndpointFor, brokerIdentityNameForWireOptions, ensureZCodeBroker, inspectBrokerIdentity, probeBrokerHealth, reconcileBrokerOwnership, writeBrokerIdentity, ZCodeBroker as ZCodeBrokerClass } from '../scripts/zcode-broker.mjs';
import { atomicWriteJson, withFileLock } from '../scripts/lib/fs.mjs';
import { PluginError } from '../scripts/lib/errors.mjs';
import { resolveWorkspaceStorage } from '../scripts/lib/workspace.mjs';
import { validCreateSnapshot, validSetupAuthProbeSnapshot, validSnapshot } from '../scripts/lib/zcode-schema.mjs';

const fixture = fileURLToPath(new URL('./fixtures/fake-zcode-cli.mjs', import.meta.url));
const brokerStartupFault = fileURLToPath(new URL('./fixtures/broker-startup-fault.cjs', import.meta.url));
const MACOS_UNIX_SOCKET_PATH_MAX_BYTES = 104;

async function withTestDeadlineKeepalive(operation) {
  const keepalive = setInterval(() => {}, 1_000);
  try { return await operation(); } finally { clearInterval(keepalive); }
}

async function compactBrokerTemp() {
  const base = process.platform === 'win32' ? tmpdir() : realpathSync('/tmp');
  const directory = await mkdtemp(join(base, 'zb-'));
  if (process.platform !== 'win32') assert.ok(Buffer.byteLength(join(directory, 'broker.sock')) <= MACOS_UNIX_SOCKET_PATH_MAX_BYTES, 'direct test broker endpoint exceeds the macOS Unix socket path limit');
  return directory;
}

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
async function assertEndpointPublished(endpoint) {
  if (process.platform !== 'win32') { assert.equal((await stat(endpoint)).isSocket(), true); return; }
  await new Promise((resolvePromise, rejectPromise) => {
    const socket = net.createConnection(endpoint); const timer = setTimeout(() => { socket.destroy(); rejectPromise(new Error('named pipe did not accept a connection')); }, 500); timer.unref?.();
    socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolvePromise(); }); socket.once('error', (error) => { clearTimeout(timer); rejectPromise(error); });
  });
}
async function waitForProcessExit(pid, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (processAlive(pid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  if (processAlive(pid)) assert.fail(`broker process ${pid} did not exit within ${timeoutMs}ms`);
}

function newTestBroker(options) {
  const ownershipPath = options.ownershipPath ?? (typeof options.endpoint === 'string' && options.endpoint.startsWith('\\\\.\\pipe\\') ? join(options.workspace, '.test-session-owners.json') : undefined);
  return new ZCodeBrokerClass({ ...options, ...(ownershipPath === undefined ? {} : { ownershipPath }) });
}

function retireTestSessionLease(broker, sessionId) {
  const lease = broker.admission.sessionLeases.get(sessionId)?.values().next().value;
  if (lease) broker.admission.finishSessionRequest(lease);
}

function canonicalTestWorkspace(workspacePath) {
  try { return realpathSync.native(resolve(workspacePath)); } catch { return workspacePath; }
}

function brokerCreateSnapshot(sessionId, workspacePath = '/repo') {
  workspacePath = canonicalTestWorkspace(workspacePath);
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
  workspacePath = canonicalTestWorkspace(workspacePath);
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

async function createHealthOnlyServer(endpoint, { brokerToken, instanceId, healthResult, hangHealth = false, hangAuth = false, hangRelease = false, deferRelease = false, authDelayMs = 0, healthDelayMs = 0, onMethod = () => {}, onReleaseReady = () => {} }) {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket); socket.setEncoding('utf8'); let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk; let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const frame = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1); newline = buffer.indexOf('\n');
        onMethod(frame.method); if (frame.method === 'broker/auth' && frame.params?.token === brokerToken && !hangAuth) { if (authDelayMs) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, authDelayMs); socket.write(`${JSON.stringify({ id: frame.id, result: { authenticated: true, ...(frame.params.existingProtocolOnly === true ? { existingProtocolOnly: true } : {}) } })}\n`); }
        else if (frame.method === 'broker/health' && !hangHealth) {
          if (healthDelayMs) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, healthDelayMs);
          socket.write(`${JSON.stringify({ id: frame.id, result: healthResult ?? { ok: true, pid: process.pid, instanceId } })}\n`);
        }
        else if (frame.method === 'broker/releaseOwner' && !hangRelease) {
          const respond = () => socket.write(`${JSON.stringify({ id: frame.id, result: { releasedSessionIds: [], failedSessionIds: [], deferredSessionCount: 0 } })}\n`);
          if (deferRelease) { setImmediate(respond); onReleaseReady(); } else respond();
        }
        else if (frame.method === 'broker/capabilities') socket.write(`${JSON.stringify({ id: frame.id, result: { releaseOwnerExclusions: false } })}\n`);
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

async function waitForJsonFile(path, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { return JSON.parse(await readFile(path, 'utf8')); } catch { await new Promise((resolvePromise) => setTimeout(resolvePromise, 5)); }
  }
  assert.fail(`timed out waiting for ${path}`);
}

async function withClient(callback, env = {}, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-client-'));
  const record = join(directory, 'calls.jsonl');
  const client = await createZCodeClient({
    workspace: directory,
    launch: { command: process.execPath, args: [fixture], target: fixture },
    env: { ...process.env, FAKE_ZCODE_RECORD: record, ...env },
    requestTimeoutMs: process.platform === 'win32' ? 2_000 : 500,
    completionTimeoutMs: process.platform === 'win32' ? 2_000 : 500,
    ...options,
  });
  try { await callback(client, record); } finally { await client.close(); await rm(directory, { recursive: true, force: true }); }
}

async function withFreshManagedClient(callback, env = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-managed-client-'));
  const launch = { command: process.execPath, args: [fixture], target: fixture };
  const storage = await resolveWorkspaceStorage({ dataRoot: directory, workspace: directory });
  const identityPath = join(storage.directory, 'broker', 'identity.json');
  let client; let identity;
  try {
    client = await createManagedZCodeClient({ dataRoot: directory, workspace: directory, launch, ownerId: 'fresh-managed-client-owner', env: { ...process.env, ...env } });
    await callback(client, directory);
  } finally {
    try { identity = JSON.parse(await readFile(identityPath, 'utf8')); } catch { /* broker did not publish an identity */ }
    await client?.close().catch(() => {});
    if (identity?.pid && processAlive(identity.pid)) try { process.kill(identity.pid, 'SIGTERM'); } catch { /* already exited */ }
    if (identity?.pid) await waitForProcessExit(identity.pid);
    await rm(directory, { recursive: true, force: true });
  }
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

test('ordinary session/create accepts the bounded 0.16.1 initial empty-session snapshot', async () => {
  await withClient(async (client) => {
    const created = await client.createSession({ workspace: '/repo' });
    assert.equal(created.session.sessionId, 'session-1');
    assert.equal(created.projection.sessionId, 'unknown');
    assert.deepEqual(created.messages, []);
  }, { FAKE_ZCODE_EMPTY_SESSION: '1' });
});

test('fresh managed broker session/create accepts the bounded initial empty-session snapshot', async () => {
  await withFreshManagedClient(async (client, directory) => {
    const created = await client.createSession({ workspace: directory });
    assert.equal(created.session.sessionId, 'session-1');
    assert.equal(created.projection.sessionId, 'unknown');
    assert.deepEqual(created.messages, []);
  }, { FAKE_ZCODE_EMPTY_SESSION: '1' });
});

test('fresh managed broker session/create rejects conflicting or non-empty unknown-projection snapshots', async (t) => {
  for (const variant of ['conflict', 'non-idle', 'event-seq', 'messages', 'target']) await t.test(variant, () => withFreshManagedClient(async (client, directory) => {
    await assert.rejects(client.createSession({ workspace: directory }), { code: 'ZCODE_OUTPUT_INVALID' });
  }, { FAKE_ZCODE_EMPTY_SESSION: '1', FAKE_ZCODE_EMPTY_SESSION_VARIANT: variant }));
});

test('ordinary session/create rejects conflicting or non-empty unknown-projection snapshots', async (t) => {
  for (const variant of ['conflict', 'non-idle', 'event-seq', 'messages', 'target']) await t.test(variant, () => withClient(async (client) => {
    await assert.rejects(client.createSession({ workspace: '/repo' }), { code: 'ZCODE_OUTPUT_INVALID' });
  }, { FAKE_ZCODE_EMPTY_SESSION: '1', FAKE_ZCODE_EMPTY_SESSION_VARIANT: variant }));
});

test('ordinary empty session/create retains explicit session ID binding', async () => {
  await withClient(async (client) => {
    await assert.rejects(client.createSession({ workspace: '/repo', sessionId: 'requested-session' }), { code: 'ZCODE_OUTPUT_INVALID' });
  }, { FAKE_ZCODE_EMPTY_SESSION: '1', FAKE_ZCODE_SESSION_ID: 'different-session' });
});

test('the unknown-projection exception remains confined to session/create', async (t) => {
  for (const method of ['session/read', 'session/resume', 'session/setModel', 'session/setThoughtLevel']) await t.test(method, () => withClient(async (client) => {
    const sessionId = (await client.createSession({ workspace: '/repo' })).session.sessionId;
    const operation = method === 'session/read' ? () => client.readSession(sessionId)
      : method === 'session/resume' ? () => client.resumeSession(sessionId)
        : method === 'session/setModel' ? () => client.setModel(sessionId, { providerId: 'fake2', modelId: 'other' })
          : () => client.setThoughtLevel(sessionId, 'high');
    await assert.rejects(operation(), { code: 'ZCODE_OUTPUT_INVALID' });
  }, { FAKE_ZCODE_EMPTY_SESSION: '1' }));
});

test('the empty-create validator rejects every remaining non-empty or conflicting relation', async () => {
  await withClient(async (client) => {
    const empty = await client.createSession({ workspace: '/repo' });
    const sessionId = empty.session.sessionId; const workspace = resolve('/repo');
    assert.equal(validSnapshot(empty, sessionId, workspace), false, 'fixture must enter the empty-create branch');
    const target = { sessionId, targetId: 'target-1', objective: 'not empty', summaryTitle: null, status: 'active', tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 1 };
    const permission = { requestId: 'request-1', toolCallId: 'tool-1', toolName: 'write', reason: 'not empty', riskLevel: 'low', options: [{ optionId: 'allow', kind: 'allow', name: 'Allow', response: { decision: 'allow' } }], requestedAt: 1 };
    const verification = { passed: false, reason: 'not empty' };
    const cases = [
      ['non-idle session status', (value) => { value.session.status = 'running'; }, true],
      ['non-null session target', (value) => { value.session.target = target; }, true],
      ['current projection turn', (value) => { value.projection.currentTurnId = 'turn-1'; }, true],
      ['nonzero projection turn count', (value) => { value.projection.turnCount = 1; }, true],
      ['nonzero projection token count', (value) => { value.projection.totalTokenCount = 1; }, true],
      ['nonzero projection context use', (value) => { value.projection.contextUsed = 1; }, true],
      ['pending projection permission', (value) => { value.projection.pendingPermissions = [permission]; }, true],
      ['active projection tool call', (value) => { value.projection.activeToolCalls = [{ toolCallId: 'tool-1', toolName: 'write', status: 'pending' }]; }, true],
      ['background projection job', (value) => { value.projection.backgroundJobs = [{}]; }, true],
      ['projection error', (value) => { value.projection.lastError = { type: 'runtime', message: 'not empty' }; }, true],
      ['nonzero runtime revision', (value) => { value.runtime.stateRevision = 1; }, true],
      ['active runtime turn ID', (value) => { value.runtime.activeTurnId = 'turn-1'; }, true],
      ['active runtime turn kind', (value) => { value.runtime.activeTurnKind = 'regular'; }, true],
      ['pending runtime request', (value) => { value.runtime.pendingRequestIds = ['request-1']; }, true],
      ['runtime API retry', (value) => { value.runtime.apiRetry = { kind: 'api_retry', attempt: 1, maxRetries: 2, retryDelayMs: 100, errorStatus: null, error: 'retrying' }; }, true],
      ['runtime context usage', (value) => { value.runtime.contextUsage = { used: 1, size: 128000 }; }, true],
      ['runtime goal verification', (value) => { value.runtime.goalVerifications = [verification]; }, true],
      ['runtime goal verification timeline', (value) => { value.runtime.goalVerificationTimeline = [{ version: 1, kind: 'synthetic', type: 'goal_verification', display: 'separator', targetId: 'target-1', verificationId: 'verification-1', status: 'started' }]; }, true],
      ['wrong workspace path', (value) => { value.session.workspace.workspacePath = '/wrong-workspace'; }, false],
      ['wrong workspace key', (value) => { value.session.workspace.workspaceKey = '/wrong-workspace'; }, false],
    ];
    for (const [name, mutate, strictCompatible] of cases) {
      const candidate = structuredClone(empty); mutate(candidate);
      assert.equal(validSnapshot(candidate, sessionId, workspace), false, `${name}: strict branch must remain unavailable`);
      assert.equal(validCreateSnapshot(candidate, sessionId, workspace), false, `${name}: empty-create branch must reject the mutation`);
      assert.equal(validSetupAuthProbeSnapshot(candidate, sessionId, workspace), false, `${name}: setup probe must reject the mutation`);
      if (strictCompatible) {
        candidate.projection.sessionId = sessionId;
        assert.equal(validSnapshot(candidate, sessionId, workspace), true, `${name}: mutation must otherwise retain a valid snapshot envelope`);
      }
    }
    const explicitEmpty = structuredClone(empty);
    explicitEmpty.session.target = null; explicitEmpty.projection.target = null; explicitEmpty.runtime.apiRetry = null;
    explicitEmpty.runtime.goalVerifications = []; explicitEmpty.runtime.goalVerificationTimeline = [];
    assert.equal(validCreateSnapshot(explicitEmpty, sessionId, workspace), true, 'explicit null and empty activity state must remain fresh');
    assert.equal(validSetupAuthProbeSnapshot(explicitEmpty, sessionId, workspace), true, 'setup probe must accept explicit null and empty activity state');
  }, { FAKE_ZCODE_EMPTY_SESSION: '1' });
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

test('broker idle timeout uses one bounded safe-integer contract before startup', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-idle-validation-'));
  const endpoint = join(directory, 'broker.sock');
  const launch = { command: process.execPath, args: [fixture], target: fixture };
  const ownerId = 'bounded-idle-owner';
  const invalid = [0, 999, 3_600_001, 1.5, NaN, Infinity, '1000', null];
  try {
    const storage = await resolveWorkspaceStorage({ dataRoot: directory, workspace: directory });
    const brokerDirectory = join(storage.directory, 'broker');
    for (const idleTimeoutMs of invalid) {
      assert.throws(() => newTestBroker({ endpoint, brokerToken: 'i'.repeat(64), workspace: directory, launch, idleTimeoutMs }), { code: 'ZCODE_BROKER_INPUT_INVALID' });
      await assert.rejects(ensureZCodeBroker({ dataRoot: directory, workspace: directory, launch, idleTimeoutMs }), { code: 'ZCODE_BROKER_INPUT_INVALID' });
      await assert.rejects(createManagedZCodeClient({ dataRoot: directory, workspace: directory, launch, ownerId, idleTimeoutMs }), { code: 'ZCODE_INPUT_INVALID' });
      await assert.rejects(stat(brokerDirectory), { code: 'ENOENT' });
    }
    for (const idleTimeoutMs of [1_000, 3_600_000]) assert.doesNotThrow(() => newTestBroker({ endpoint, brokerToken: 'i'.repeat(64), workspace: directory, launch, idleTimeoutMs }));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('minimum ensured broker idle timeout survives delayed first client acquisition', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-idle-acquisition-'));
  const launch = { command: process.execPath, args: [fixture], target: fixture };
  let identity; let client;
  try {
    identity = await ensureZCodeBroker({ dataRoot: directory, workspace: directory, launch, idleTimeoutMs: 1_000 });
    const blockedUntil = Date.now() + 200;
    while (Date.now() < blockedUntil) { /* deterministic caller-side event-loop stall */ }
    assert.equal(processAlive(identity.pid), true);
    client = await createZCodeClient({ workspace: directory, brokerEndpoint: identity.endpoint, brokerToken: identity.brokerToken, ownerId: 'idle-acquisition-owner' });
    assert.deepEqual(await client.listSessions(), { sessions: [] });
  } finally {
    await client?.close().catch(() => {});
    if (identity?.pid && processAlive(identity.pid)) try { process.kill(identity.pid, 'SIGTERM'); } catch { /* already exited */ }
    if (identity?.pid) await waitForProcessExit(identity.pid);
    await rm(directory, { recursive: true, force: true });
  }
});

test('maximum managed broker idle timeout remains accepted end to end', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-idle-maximum-')); const launch = { command: process.execPath, args: [fixture], target: fixture }; let client; let identity;
  try {
    client = await createManagedZCodeClient({ dataRoot: directory, workspace: directory, launch, ownerId: 'idle-maximum-owner', idleTimeoutMs: 3_600_000 }); assert.deepEqual(await client.listSessions(), { sessions: [] }); const storage = await resolveWorkspaceStorage({ dataRoot: directory, workspace: directory }); identity = JSON.parse(await readFile(join(storage.directory, 'broker', 'identity.json'), 'utf8'));
  } finally { await client?.close().catch(() => {}); if (identity?.pid && processAlive(identity.pid)) try { process.kill(identity.pid, 'SIGTERM'); } catch { /* already exited */ } if (identity?.pid) await waitForProcessExit(identity.pid); await rm(directory, { recursive: true, force: true }); }
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

test('existing managed client ignores a healthy identity redirected to another workspace broker', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-existing-cross-workspace-')); const dataRoot = join(directory, 'data'); const workspaceA = join(directory, 'workspace-a'); const workspaceB = join(directory, 'workspace-b'); const wireOptions = { maxFrameBytes: 4096 }; let brokerB;
  try {
    await mkdir(workspaceA, { recursive: true }); await mkdir(workspaceB, { recursive: true }); brokerB = await createPersistedTestBroker({ dataRoot, workspace: workspaceB, tokenByte: '6', instanceByte: 'e', ...wireOptions }); const storageA = await resolveWorkspaceStorage({ dataRoot, workspace: workspaceA }); const identityPathA = join(storageA.directory, 'broker', brokerIdentityNameForWireOptions(wireOptions));
    await writeBrokerIdentity(identityPathA, { endpoint: brokerB.options.endpoint, pid: process.pid, instanceId: brokerB.options.instanceId, brokerToken: brokerB.options.brokerToken }); const identityBefore = await readFile(identityPathA, 'utf8');
    assert.equal(await createExistingManagedZCodeClient({ dataRoot, workspace: workspaceA, ownerId: 'cross-workspace-existing-owner', requestTimeoutMs: 100, ...wireOptions }), null); assert.equal(brokerB.owners, 0); await assertEndpointPublished(brokerB.options.endpoint); assert.equal(await readFile(identityPathA, 'utf8'), identityBefore); assert.equal((await readdir(join(storageA.directory, 'broker'))).some((name) => name.startsWith('config-')), false);
  } finally { await brokerB?.close(); await rm(directory, { recursive: true, force: true }); }
});

test('managed owner release reports a profile identity redirected to another workspace without connecting it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-release-cross-workspace-')); const dataRoot = join(directory, 'data'); const workspaceA = join(directory, 'workspace-a'); const workspaceB = join(directory, 'workspace-b'); const ownerId = 'cross-workspace-release-owner'; const sessionId = 'cross-workspace-release-session'; const record = join(directory, 'calls.jsonl'); const wireOptions = { maxFrameBytes: 4096 }; let brokerB; let ownerB;
  try {
    await mkdir(workspaceA, { recursive: true }); await mkdir(workspaceB, { recursive: true }); brokerB = await createPersistedTestBroker({ dataRoot, workspace: workspaceB, tokenByte: '7', instanceByte: 'f', record, ...wireOptions }); ownerB = await createZCodeClient({ workspace: workspaceB, brokerEndpoint: brokerB.options.endpoint, brokerToken: brokerB.options.brokerToken, ownerId }); await ownerB.createSession({ workspace: workspaceB, sessionId, importedHistory: { messages: [{ role: 'user', content: 'owned by workspace B' }] } }); await ownerB.close(); ownerB = null; const ownershipBefore = await readFile(brokerB.ownershipPath, 'utf8'); await writeFile(record, '');
    const storageA = await resolveWorkspaceStorage({ dataRoot, workspace: workspaceA }); const identityPathA = join(storageA.directory, 'broker', brokerIdentityNameForWireOptions(wireOptions)); await writeBrokerIdentity(identityPathA, { endpoint: brokerB.options.endpoint, pid: process.pid, instanceId: brokerB.options.instanceId, brokerToken: brokerB.options.brokerToken }); const identityBefore = await readFile(identityPathA, 'utf8');
    let cleanupError; await assert.rejects(releaseManagedZCodeOwner({ dataRoot, workspace: workspaceA, ownerId, requestTimeoutMs: 100 }), (error) => { cleanupError = error; return error?.code === 'ZCODE_OWNER_RELEASE_INCOMPLETE'; }); assert.deepEqual(cleanupError.details.identityStatusCounts, { invalid: 1 }); const diagnostic = JSON.stringify({ message: cleanupError.message, details: cleanupError.details }); for (const secret of [brokerB.options.endpoint, brokerB.options.brokerToken, workspaceA, workspaceB, identityPathA]) assert.equal(diagnostic.includes(secret), false); assert.equal(brokerB.sessionOwners.get(sessionId)?.ownerId, ownerId); assert.equal(await readFile(brokerB.ownershipPath, 'utf8'), ownershipBefore); assert.equal((await readRecordedCalls(record)).some((call) => call.method === 'session/stop'), false); assert.equal(brokerB.owners, 0); await assertEndpointPublished(brokerB.options.endpoint); assert.equal(await readFile(identityPathA, 'utf8'), identityBefore);
  } finally { await ownerB?.close().catch(() => {}); await brokerB?.close(); await rm(directory, { recursive: true, force: true }); }
});

test('managed owner release reports a structurally corrupt existing identity without leaking it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-release-corrupt-identity-')); const sentinelEndpoint = 'sentinel-foreign-endpoint'; const sentinelToken = 'sentinel-secret-token';
  try { const storage = await resolveWorkspaceStorage({ dataRoot: directory, workspace: directory }); const brokerDirectory = join(storage.directory, 'broker'); const identityPath = join(brokerDirectory, 'identity.json'); await mkdir(brokerDirectory, { recursive: true }); await writeFile(identityPath, JSON.stringify({ endpoint: sentinelEndpoint, brokerToken: sentinelToken })); let cleanupError; await assert.rejects(releaseManagedZCodeOwner({ dataRoot: directory, workspace: directory, ownerId: 'corrupt-identity-release-owner', requestTimeoutMs: 100 }), (error) => { cleanupError = error; return error?.code === 'ZCODE_OWNER_RELEASE_INCOMPLETE'; }); assert.deepEqual(cleanupError.details.identityStatusCounts, { invalid: 1 }); const diagnostic = JSON.stringify({ message: cleanupError.message, details: cleanupError.details }); for (const secret of [sentinelEndpoint, sentinelToken, directory, identityPath]) assert.equal(diagnostic.includes(secret), false); }
  finally { await rm(directory, { recursive: true, force: true }); }
});

test('managed owner release succeeds only when no matching identity exists', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-release-absent-identity-'));
  try { assert.deepEqual(await releaseManagedZCodeOwner({ dataRoot: directory, workspace: directory, ownerId: 'absent-identity-release-owner', requestTimeoutMs: 100 }), { releasedSessionIds: [], failedSessionIds: [], deferredSessionCount: 0 }); }
  finally { await rm(directory, { recursive: true, force: true }); }
});

test('managed owner release counts dead and unhealthy canonical identity profiles', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-release-invalid-statuses-')); let closeServer;
  try {
    const storage = await resolveWorkspaceStorage({ dataRoot: directory, workspace: directory }); const brokerDirectory = join(storage.directory, 'broker'); const defaultEndpoint = brokerEndpointFor({ dataRoot: directory, workspace: storage.workspacePath }); await writeBrokerIdentity(join(brokerDirectory, 'identity.json'), { endpoint: defaultEndpoint, pid: 999_999_999, instanceId: 'd'.repeat(48), brokerToken: 'e'.repeat(64) }); const wireOptions = { maxFrameBytes: 4096 }; const identityName = brokerIdentityNameForWireOptions(wireOptions); const profile = identityName.slice('identity-'.length, -'.json'.length); const unhealthy = { endpoint: brokerEndpointFor({ dataRoot: directory, workspace: storage.workspacePath, identity: profile }), pid: process.pid, instanceId: 'f'.repeat(48), brokerToken: '1'.repeat(64) }; closeServer = await createHealthOnlyServer(unhealthy.endpoint, { ...unhealthy, hangHealth: true }); await writeBrokerIdentity(join(brokerDirectory, identityName), unhealthy); let cleanupError; await assert.rejects(releaseManagedZCodeOwner({ dataRoot: directory, workspace: directory, ownerId: 'invalid-status-release-owner', requestTimeoutMs: 100 }), (error) => { cleanupError = error; return error?.code === 'ZCODE_OWNER_RELEASE_INCOMPLETE'; }); assert.deepEqual(cleanupError.details.identityStatusCounts, { dead: 1, unhealthy: 1 }); const diagnostic = JSON.stringify({ message: cleanupError.message, details: cleanupError.details }); for (const secret of [defaultEndpoint, unhealthy.endpoint, unhealthy.brokerToken, directory]) assert.equal(diagnostic.includes(secret), false);
  } finally { await closeServer?.(); await rm(directory, { recursive: true, force: true }); }
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

test('existing managed client authenticates and verifies through one connection', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-existing-single-probe-')); const methods = []; let closeServer; let client;
  try {
    const storage = await resolveWorkspaceStorage({ dataRoot: directory, workspace: directory }); const endpoint = brokerEndpointFor({ dataRoot: directory, workspace: storage.workspacePath }); const record = { endpoint, pid: process.pid, instanceId: '2'.repeat(48), brokerToken: '3'.repeat(64) }; closeServer = await createHealthOnlyServer(endpoint, { ...record, onMethod: (method) => methods.push(method) }); await writeBrokerIdentity(join(storage.directory, 'broker', 'identity.json'), record);
    client = await createExistingManagedZCodeClient({ dataRoot: directory, workspace: directory, ownerId: 'existing-single-probe-owner', requestTimeoutMs: 500 }); assert.ok(client); assert.equal(client.brokerHealth, undefined); assert.deepEqual(methods, ['broker/auth', 'broker/health']);
  } finally { await client?.close(); await closeServer?.(); await rm(directory, { recursive: true, force: true }); }
});

test('public broker capabilities keeps legacy health compatibility without exposing private identity fields', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-health-fields-')); const endpoint = brokerEndpointFor({ dataRoot: directory, workspace: directory }); let closeServer; let client;
  try {
    closeServer = await createHealthOnlyServer(endpoint, { brokerToken: '8'.repeat(64), instanceId: '9'.repeat(48), healthResult: { ok: true } }); client = await createZCodeClient({ workspace: directory, brokerEndpoint: endpoint, brokerToken: '8'.repeat(64), ownerId: 'legacy-health-fields-owner', requestTimeoutMs: 100 }); assert.deepEqual(await client.brokerCapabilities(), { releaseOwnerExclusions: false }); assert.equal(client.brokerHealth, undefined);
  } finally { await client?.close(); await closeServer?.(); await rm(directory, { recursive: true, force: true }); }
});

test('broker health connect authentication request and close share one probe budget', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-health-shared-budget-')); const endpoint = brokerEndpointFor({ dataRoot: directory, workspace: directory }); const record = { endpoint, pid: process.pid, instanceId: '4'.repeat(48), brokerToken: '5'.repeat(64) }; let closeServer;
  try { closeServer = await createHealthOnlyServer(endpoint, { ...record, authDelayMs: 100, hangHealth: true }); const startedAt = Date.now(); assert.equal(await probeBrokerHealth(record, 300), false); const elapsed = Date.now() - startedAt; assert.ok(elapsed < 360, `health probe consumed separate stage budgets: ${elapsed}ms`); }
  finally { await closeServer?.(); await rm(directory, { recursive: true, force: true }); }
});

test('a live unhealthy broker identity prevents concurrent replacement startup', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-ensure-live-unhealthy-')); let closeServer; let outcomes = [];
  try {
    const storage = await resolveWorkspaceStorage({ dataRoot: directory, workspace: directory }); const identityName = brokerIdentityNameForWireOptions(); const brokerDirectory = join(storage.directory, 'broker'); const endpoint = brokerEndpointFor({ dataRoot: directory, workspace: storage.workspacePath }); const brokerToken = '9'.repeat(64); const instanceId = 'f'.repeat(48);
    closeServer = await createHealthOnlyServer(endpoint, { brokerToken, instanceId, hangHealth: true }); await writeBrokerIdentity(join(brokerDirectory, identityName), { endpoint, pid: process.pid, instanceId, brokerToken }); const options = { dataRoot: directory, workspace: directory, launch: { command: join(directory, 'must-not-spawn'), args: [] } };
    outcomes = await Promise.allSettled([ensureZCodeBroker(options), ensureZCodeBroker(options)]); assert.deepEqual(outcomes.map((outcome) => outcome.status), ['rejected', 'rejected']); for (const outcome of outcomes) assert.equal(outcome.reason?.code, 'ZCODE_BROKER_UNHEALTHY'); await assertEndpointPublished(endpoint); assert.equal((await readdir(brokerDirectory)).some((name) => name.startsWith('config-')), false);
  } finally { for (const outcome of outcomes) if (outcome.status === 'fulfilled' && processAlive(outcome.value.pid)) try { process.kill(outcome.value.pid, 'SIGTERM'); } catch { /* already exited */ } await closeServer?.(); await rm(directory, { recursive: true, force: true }); }
});

test('missing identity cannot let failed broker startups replace a live canonical endpoint', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-ensure-live-missing-identity-')); const record = join(directory, 'calls.jsonl'); const outcomes = []; let closeServer; let oldClient;
  try {
    const storage = await resolveWorkspaceStorage({ dataRoot: directory, workspace: directory }); const brokerDirectory = join(storage.directory, 'broker'); const identityPath = join(brokerDirectory, brokerIdentityNameForWireOptions()); const endpoint = brokerEndpointFor({ dataRoot: directory, workspace: storage.workspacePath }); const oldRecord = { endpoint, pid: process.pid, instanceId: '7'.repeat(48), brokerToken: '8'.repeat(64) };
    closeServer = await createHealthOnlyServer(endpoint, oldRecord); oldClient = await createZCodeClient({ workspace: directory, brokerEndpoint: endpoint, brokerToken: oldRecord.brokerToken, ownerId: 'live-missing-identity-owner', requestTimeoutMs: 100 }); assert.deepEqual(await oldClient.brokerCapabilities(), { releaseOwnerExclusions: false }); const options = { dataRoot: directory, workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture }, env: { ...process.env, FAKE_ZCODE_RECORD: record } };
    for (let attempt = 0; attempt < 2; attempt += 1) outcomes.push(await ensureZCodeBroker(options).then((value) => ({ status: 'fulfilled', value }), (error) => ({ status: 'rejected', error })));
    assert.deepEqual(outcomes.map((outcome) => outcome.status), ['rejected', 'rejected']); for (const outcome of outcomes) assert.equal(outcome.error?.code, 'ZCODE_BROKER_UNHEALTHY'); assert.deepEqual(await oldClient.brokerCapabilities(), { releaseOwnerExclusions: false }); assert.equal(await probeBrokerHealth(oldRecord, 100), true); await assert.rejects(readFile(identityPath), (error) => error.code === 'ENOENT'); await assertEndpointPublished(endpoint); assert.deepEqual(await readRecordedCalls(record), []); assert.equal((await readdir(brokerDirectory)).some((name) => name.startsWith('config-')), false);
  } finally { await oldClient?.close().catch(() => {}); for (const outcome of outcomes) if (outcome.status === 'fulfilled' && processAlive(outcome.value.pid)) { try { process.kill(outcome.value.pid, 'SIGTERM'); } catch { /* already exited */ } await waitForProcessExit(outcome.value.pid); } await closeServer?.(); await rm(directory, { recursive: true, force: true }); }
});

test('SIGKILL before and after startup identity publication leaves the next ensure recoverable', async () => {
  for (const phase of ['before-publish', 'after-publish']) for (let iteration = 0; iteration < 5; iteration += 1) {
    const directory = await mkdtemp(join(tmpdir(), `zcode-ensure-${phase}-kill-`)); const marker = join(directory, 'startup.json'); let recoveryPid;
    try {
      const storage = await resolveWorkspaceStorage({ dataRoot: directory, workspace: directory }); const identityPath = join(storage.directory, 'broker', brokerIdentityNameForWireOptions()); const options = { dataRoot: directory, workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } }; const faultEnv = { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require=${brokerStartupFault}`.trim(), FAKE_BROKER_STARTUP_FAULT: phase, FAKE_BROKER_STARTUP_MARKER: marker };
      const starting = ensureZCodeBroker({ ...options, env: faultEnv }); const failedStartup = assert.rejects(starting, { code: 'ZCODE_BROKER_START_FAILED' }); const startup = await waitForJsonFile(phase === 'before-publish' ? marker : identityPath); process.kill(startup.pid, 'SIGKILL'); await waitForProcessExit(startup.pid); await failedStartup;
      const recovered = await ensureZCodeBroker(options); recoveryPid = recovered.pid; assert.equal(await probeBrokerHealth(recovered, 100), true); await assertEndpointPublished(recovered.endpoint); assert.equal(JSON.parse(await readFile(identityPath, 'utf8')).instanceId, recovered.instanceId);
    } finally { if (recoveryPid && processAlive(recoveryPid)) try { process.kill(recoveryPid, 'SIGTERM'); } catch { /* already exited */ } if (recoveryPid) await waitForProcessExit(recoveryPid); await rm(directory, { recursive: true, force: true }); }
  }
});

test('broker startup removes only its exact config across child bootstrap failures', async () => {
  const invalidDirectory = await mkdtemp(join(tmpdir(), 'zcode-ensure-invalid-node-options-'));
  try {
    const storage = await resolveWorkspaceStorage({ dataRoot: invalidDirectory, workspace: invalidDirectory }); const brokerDirectory = join(storage.directory, 'broker');
    await assert.rejects(ensureZCodeBroker({ dataRoot: invalidDirectory, workspace: invalidDirectory, launch: { command: process.execPath, args: [fixture], target: fixture }, env: { ...process.env, NODE_OPTIONS: '--not-a-real-node-option' } }), { code: 'ZCODE_BROKER_START_FAILED' }); assert.equal((await readdir(brokerDirectory)).some((name) => name.startsWith('config-')), false);
  } finally { await rm(invalidDirectory, { recursive: true, force: true }); }

  const foreignDirectory = await mkdtemp(join(tmpdir(), 'zcode-ensure-foreign-config-')); const marker = join(foreignDirectory, 'startup.json'); const gate = join(foreignDirectory, 'release.gate');
  try {
    const storage = await resolveWorkspaceStorage({ dataRoot: foreignDirectory, workspace: foreignDirectory }); const brokerDirectory = join(storage.directory, 'broker'); const starting = ensureZCodeBroker({ dataRoot: foreignDirectory, workspace: foreignDirectory, launch: { command: process.execPath, args: [fixture], target: fixture }, env: { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require=${brokerStartupFault}`.trim(), FAKE_BROKER_STARTUP_FAULT: 'before-main-exit', FAKE_BROKER_STARTUP_MARKER: marker, FAKE_BROKER_STARTUP_GATE: gate } }); await waitForJsonFile(marker); const configName = (await readdir(brokerDirectory)).find((name) => name.startsWith('config-')); assert.ok(configName); const configPath = join(brokerDirectory, configName); const foreign = '{"instanceId":"foreign-config-owner"}\n'; await writeFile(configPath, foreign); await writeFile(gate, 'release'); await assert.rejects(starting, { code: 'ZCODE_BROKER_START_FAILED' }); assert.equal(await readFile(configPath, 'utf8'), foreign);
  } finally { await writeFile(gate, 'release').catch(() => {}); await rm(foreignDirectory, { recursive: true, force: true }); }
});

test('a dead identity cannot replace a different live listener on its canonical endpoint', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-ensure-dead-identity-live-endpoint-')); const outcomes = []; let closeServer; let oldClient;
  try {
    const storage = await resolveWorkspaceStorage({ dataRoot: directory, workspace: directory }); const brokerDirectory = join(storage.directory, 'broker'); const identityPath = join(brokerDirectory, brokerIdentityNameForWireOptions()); const endpoint = brokerEndpointFor({ dataRoot: directory, workspace: storage.workspacePath }); const liveRecord = { endpoint, pid: process.pid, instanceId: '3'.repeat(48), brokerToken: '4'.repeat(64) }; const deadPid = 2_147_483_647; assert.equal(processAlive(deadPid), false);
    closeServer = await createHealthOnlyServer(endpoint, liveRecord); oldClient = await createZCodeClient({ workspace: directory, brokerEndpoint: endpoint, brokerToken: liveRecord.brokerToken, ownerId: 'dead-identity-live-endpoint-owner', requestTimeoutMs: 100 }); assert.deepEqual(await oldClient.brokerCapabilities(), { releaseOwnerExclusions: false }); await writeBrokerIdentity(identityPath, { endpoint, pid: deadPid, instanceId: '5'.repeat(48), brokerToken: '6'.repeat(64) }); const identityBefore = await readFile(identityPath, 'utf8'); const options = { dataRoot: directory, workspace: directory, launch: { command: join(directory, 'must-not-spawn'), args: [] } };
    for (let attempt = 0; attempt < 2; attempt += 1) outcomes.push(await ensureZCodeBroker(options).then((value) => ({ status: 'fulfilled', value }), (error) => ({ status: 'rejected', error })));
    assert.deepEqual(outcomes.map((outcome) => outcome.status), ['rejected', 'rejected']); for (const outcome of outcomes) assert.equal(outcome.error?.code, 'ZCODE_BROKER_UNHEALTHY'); assert.deepEqual(await oldClient.brokerCapabilities(), { releaseOwnerExclusions: false }); assert.equal(await probeBrokerHealth(liveRecord, 100), true); assert.equal(await readFile(identityPath, 'utf8'), identityBefore); await assertEndpointPublished(endpoint); assert.equal((await readdir(brokerDirectory)).some((name) => name.startsWith('config-')), false);
  } finally { await oldClient?.close().catch(() => {}); for (const outcome of outcomes) if (outcome.status === 'fulfilled' && processAlive(outcome.value.pid)) { try { process.kill(outcome.value.pid, 'SIGTERM'); } catch { /* already exited */ } await waitForProcessExit(outcome.value.pid); } await closeServer?.(); await rm(directory, { recursive: true, force: true }); }
});

test('a confirmed dead exact broker identity can be replaced safely', { skip: process.platform === 'win32' }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-ensure-dead-recovery-')); let brokerPid; let staleChild;
  try {
    const storage = await resolveWorkspaceStorage({ dataRoot: directory, workspace: directory }); const identityName = brokerIdentityNameForWireOptions(); const brokerDirectory = join(storage.directory, 'broker'); const identityPath = join(brokerDirectory, identityName); const endpoint = brokerEndpointFor({ dataRoot: directory, workspace: storage.workspacePath }); const marker = join(directory, 'stale-listener.json'); await mkdir(brokerDirectory, { recursive: true }); staleChild = spawn(process.execPath, [brokerStartupFault], { env: { ...process.env, FAKE_BROKER_STARTUP_FAULT: 'stale-listener', FAKE_BROKER_STARTUP_MARKER: marker, FAKE_BROKER_STARTUP_ENDPOINT: endpoint }, stdio: 'ignore' }); const exited = new Promise((resolvePromise) => staleChild.once('exit', resolvePromise)); const started = await waitForJsonFile(marker); assert.equal(started.pid, staleChild.pid); process.kill(staleChild.pid, 'SIGKILL'); await exited; const deadPid = staleChild.pid; assert.equal(processAlive(deadPid), false); assert.equal((await stat(endpoint)).isSocket(), true); const options = { dataRoot: directory, workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture }, idleTimeoutMs: 1_000 }; await writeBrokerIdentity(identityPath, { endpoint: join(directory, 'wrong-endpoint.sock'), pid: deadPid, instanceId: 'a'.repeat(48), brokerToken: 'b'.repeat(64) }); await assert.rejects(ensureZCodeBroker(options), { code: 'ZCODE_BROKER_UNHEALTHY' }); assert.equal((await stat(endpoint)).isSocket(), true); assert.equal((await readdir(brokerDirectory)).some((name) => name.startsWith('config-')), false); await writeBrokerIdentity(identityPath, { endpoint, pid: deadPid, instanceId: 'a'.repeat(48), brokerToken: 'b'.repeat(64) });
    const record = await ensureZCodeBroker(options); brokerPid = record.pid; assert.notEqual(record.pid, deadPid); assert.equal(processAlive(record.pid), true); assert.equal((await stat(endpoint)).isSocket(), true);
  } finally { if (staleChild?.pid && processAlive(staleChild.pid)) try { process.kill(staleChild.pid, 'SIGKILL'); } catch { /* already exited */ } if (staleChild?.pid) await waitForProcessExit(staleChild.pid); if (brokerPid && processAlive(brokerPid)) try { process.kill(brokerPid, 'SIGTERM'); } catch { /* idle shutdown won */ } if (brokerPid) await waitForProcessExit(brokerPid); await rm(directory, { recursive: true, force: true }); }
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
    const directory = await compactBrokerTemp();
    const endpoint = brokerEndpointFor({ dataRoot: directory, workspace: directory }); const ownershipPath = join(directory, 'session-owners.json'); const brokerToken = '1'.repeat(64); const ownerId = `invalid-create-${explicit ? 'explicit' : 'anonymous'}-owner`; const sessionId = `invalid-create-${explicit ? 'explicit' : 'anonymous'}-session`;
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
    const directory = await compactBrokerTemp(); const endpoint = brokerEndpointFor({ dataRoot: directory, workspace: directory }); const writes = []; const broker = await newTestBroker({ endpoint, brokerToken: '5'.repeat(64), workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture }, env: { ...process.env, FAKE_ZCODE_LIST_NOTIFICATION_ONCE: '1' } }).start(); const socket = { writable: true, destroyed: false, zcodeWriter: { write: (line) => writes.push(JSON.parse(line)) }, destroy() {} }; broker.sockets.add(socket); broker.authenticated.add(socket); broker.socketOwnerIds.set(socket, `cold-owner-${concurrency}-stable`); let releaseReloads; let reloadCount = 0; const reloadGate = new Promise((resolvePromise) => { releaseReloads = resolvePromise; }); broker.reloadOwnership = async () => { reloadCount += 1; if (reloadCount === concurrency) releaseReloads(); await reloadGate; }; const protocols = []; const getProtocol = broker.getProtocol.bind(broker); broker.getProtocol = async () => { const protocol = await getProtocol(); protocols.push(protocol); return protocol; };
    try { await Promise.all(Array.from({ length: concurrency }, (_, index) => broker.handleLocal(socket, JSON.stringify({ id: index + 1, method: 'session/list', params: {} })))); assert.equal(new Set(protocols).size, 1, 'concurrent waiters received different protocol objects'); assert.equal(broker.protocol.subscribers.size, 1, 'one protocol generation was initialized more than once'); assert.equal(writes.filter((frame) => frame.method === 'fixture/notification').length, 0, 'an owner-neutral notification was broadcast'); assert.equal(writes.filter((frame) => frame.result).length, concurrency); }
    finally { await broker.close(); await rm(directory, { recursive: true, force: true }); }
  });
});

test('broker rejects every unknown local method before admission reload or upstream forwarding', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-method-allowlist-')); const endpoint = join(directory, 'broker.sock'); const ownerId = 'method-allowlist-owner'; const sessionId = 'method-allowlist-session'; const writes = []; const socket = { writable: true, destroyed: false, zcodeWriter: { write: (line) => writes.push(JSON.parse(line)) }, destroy() {} }; const broker = newTestBroker({ endpoint, brokerToken: 'e'.repeat(64), workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } }); broker.authenticated.add(socket); broker.socketOwnerIds.set(socket, ownerId); broker.sessionOwners.set(sessionId, { ownerId, socket }); await writeFile(`${endpoint}.owners.json`, JSON.stringify({ version: 1, sessions: { [sessionId]: ownerId } })); broker.ownershipStoreEstablished = true; let resolveStop; let stopCalls = 0; const forwarded = []; broker.protocol = { request: (method) => { if (method === 'session/stop') { stopCalls += 1; return new Promise((resolvePromise) => { resolveStop = resolvePromise; }); } forwarded.push(method); return Promise.resolve({ forwarded: true }); }, cancelTurn() {} };
  const releasing = broker.releaseOwner(socket, ownerId, []); while (!stopCalls) await new Promise((resolvePromise) => setImmediate(resolvePromise)); for (const [id, method, params] of [[71, 'session/futureMutation', { sessionId }], [72, 'future/mutation', {}], [73, 'broker/releaseSession', { sessionId }]]) await broker.handleLocal(socket, JSON.stringify({ id, method, params })); assert.deepEqual(forwarded, []); for (const id of [71, 72, 73]) assert.equal(writes.find((frame) => frame.id === id)?.error?.data?.pluginError?.code, 'ZCODE_BROKER_INPUT_INVALID'); resolveStop({}); const released = await releasing; assert.deepEqual(released.releasedSessionIds, [sessionId]); assert.equal(broker.admission.activeCount, 0); await rm(directory, { recursive: true, force: true });
});

test('broker drops owner-neutral notifications and routes attributed notifications only to their owner', async () => {
  const directory = await compactBrokerTemp(); const endpoint = brokerEndpointFor({ dataRoot: directory, workspace: directory }); const brokerToken = '8'.repeat(64); const broker = await newTestBroker({ endpoint, brokerToken, workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture }, env: { ...process.env, FAKE_ZCODE_LIST_ROUTING_NOTIFICATIONS: '1' } }).start(); const ownerA = await createZCodeClient({ workspace: directory, brokerEndpoint: endpoint, brokerToken, ownerId: 'notification-routing-owner-a' }); const ownerB = await createZCodeClient({ workspace: directory, brokerEndpoint: endpoint, brokerToken, ownerId: 'notification-routing-owner-b' }); const sessionId = (await ownerA.createSession({ workspace: directory })).session.sessionId; const notificationsA = []; const notificationsB = []; const unsubscribeA = ownerA.protocol.subscribe((message) => notificationsA.push(message)); const unsubscribeB = ownerB.protocol.subscribe((message) => notificationsB.push(message));
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

test('pending retired protocol health fails closed until successful retirement restores service', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-retired-health-recovery-')); let broker; let resolveClose;
  try {
    broker = await createPersistedTestBroker({ dataRoot: directory, workspace: directory, tokenByte: '4', instanceByte: 'c' }); const storage = await resolveWorkspaceStorage({ dataRoot: directory, workspace: directory }); const identityPath = join(storage.directory, 'broker', 'identity.json'); const record = JSON.parse(await readFile(identityPath, 'utf8')); const identityBefore = await readFile(identityPath, 'utf8'); const oldProtocol = { close: () => new Promise((resolvePromise) => { resolveClose = resolvePromise; }) }; broker.protocol = oldProtocol; const retired = broker.clearProtocolGeneration(oldProtocol); assert.equal(await probeBrokerHealth(record, 100), false); assert.equal((await inspectBrokerIdentity(identityPath, { expectedEndpoint: record.endpoint })).status, 'unhealthy'); await assert.rejects(ensureZCodeBroker({ dataRoot: directory, workspace: directory, launch: { command: join(directory, 'must-not-spawn'), args: [] } }), { code: 'ZCODE_BROKER_UNHEALTHY' }); assert.equal(await readFile(identityPath, 'utf8'), identityBefore); resolveClose(); await retired.closePromise; assert.equal(broker.retiredProtocolGeneration, null); assert.equal(await probeBrokerHealth(record, 100), true); assert.equal((await inspectBrokerIdentity(identityPath, { expectedEndpoint: record.endpoint })).status, 'healthy'); const ensured = await ensureZCodeBroker({ dataRoot: directory, workspace: directory, launch: { command: join(directory, 'must-not-spawn'), args: [] } }); assert.equal(ensured.pid, record.pid); assert.equal(ensured.instanceId, record.instanceId);
  } finally { resolveClose?.(); await broker?.close().catch(() => {}); await rm(directory, { recursive: true, force: true }); }
});

test('failed retired protocol health stays fail-closed without replacing the live broker', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-retired-health-failed-')); let broker;
  try {
    broker = await createPersistedTestBroker({ dataRoot: directory, workspace: directory, tokenByte: '5', instanceByte: 'd' }); const storage = await resolveWorkspaceStorage({ dataRoot: directory, workspace: directory }); const brokerDirectory = join(storage.directory, 'broker'); const identityPath = join(brokerDirectory, 'identity.json'); const record = JSON.parse(await readFile(identityPath, 'utf8')); const identityBefore = await readFile(identityPath, 'utf8'); const closeError = new Error('retired health close failed'); const oldProtocol = { close: () => Promise.reject(closeError) }; broker.protocol = oldProtocol; const retired = broker.clearProtocolGeneration(oldProtocol); await retired.closePromise; assert.equal(retired.status, 'failed'); await assert.rejects(broker.getProtocol(), { code: 'ZCODE_PROTOCOL_RETIRING' }); assert.equal(await probeBrokerHealth(record, 100), false); assert.equal((await inspectBrokerIdentity(identityPath, { expectedEndpoint: record.endpoint })).status, 'unhealthy'); await assert.rejects(ensureZCodeBroker({ dataRoot: directory, workspace: directory, launch: { command: join(directory, 'must-not-spawn'), args: [] } }), { code: 'ZCODE_BROKER_UNHEALTHY' }); assert.equal(await readFile(identityPath, 'utf8'), identityBefore); assert.equal((await readdir(brokerDirectory)).some((name) => name.startsWith('config-')), false); assert.equal(broker.server?.listening, true);
  } finally { await broker?.close().catch(() => {}); await rm(directory, { recursive: true, force: true }); }
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

test('broker endpoint identity canonicalizes existing data-root and workspace aliases', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-endpoint-canonical-')); try { const canonical = realpathSync(directory); assert.equal(brokerEndpointFor({ dataRoot: directory, workspace: directory }), brokerEndpointFor({ dataRoot: canonical, workspace: canonical })); } finally { await rm(directory, { recursive: true, force: true }); }
});

test('typed client uses a local broker whose single CLI owner handles permissions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-'));
  const endpoint = brokerEndpointFor({ dataRoot: directory, workspace: directory });
  const brokerToken = 'a'.repeat(64);
  const broker = await newTestBroker({ endpoint, brokerToken, workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture }, env: { ...process.env, FAKE_ZCODE_PERMISSION: '1' }, idleTimeoutMs: 10_000 }).start();
  await assert.rejects(createZCodeClient({ workspace: directory, brokerEndpoint: endpoint, brokerToken: 'b'.repeat(64), ownerId: 'typed-owner-invalid-token', requestTimeoutMs: 500 }), { code: 'ZCODE_REQUEST_FAILED' });
  const client = await createZCodeClient({ workspace: directory, brokerEndpoint: endpoint, brokerToken, ownerId: 'typed-owner-permission', requestTimeoutMs: 3_000, completionTimeoutMs: 3_000 });
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

test('natural terminal denies its exact pending permission and tombstones a late local approval', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-terminal-permission-')); const endpoint = brokerEndpointFor({ dataRoot: directory, workspace: directory }); const brokerToken = '8'.repeat(64); const record = join(directory, 'calls.jsonl'); const broker = await newTestBroker({ endpoint, brokerToken, workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture }, env: { ...process.env, FAKE_ZCODE_PERMISSION: '1', FAKE_ZCODE_RECORD: record } }).start(); const client = await createZCodeClient({ workspace: directory, brokerEndpoint: endpoint, brokerToken, ownerId: 'terminal-permission-owner', completionTimeoutMs: 1_000 }); let approve;
  try {
    const { session: { sessionId } } = await client.createSession({ workspace: directory }); let permissionEntered; const entered = new Promise((resolvePromise) => { permissionEntered = resolvePromise; }); const approval = new Promise((resolvePromise) => { approve = () => resolvePromise({ decision: 'allow' }); }); client.setPermissionHandler(async () => { permissionEntered(); return approval; }); await client.send(sessionId, 'complete while permission is pending'); await entered; const completion = await client.waitForCompletion(sessionId); assert.equal(completion.reason, 'prompt_completed'); assert.equal(broker.activeSessionSockets.has(sessionId), false); assert.equal(broker.activeSessions.has(sessionId), false); assert.equal(broker.permissionPending.size, 0); assert.equal(broker.retiredPermissionResponses.size, 1);
    approve(); await waitForRecordedCalls(record, (calls) => calls.some((call) => call.id === 9000 && call.result)); const permissionResponses = (await readRecordedCalls(record)).filter((call) => call.id === 9000 && call.result); assert.deepEqual(permissionResponses.map((call) => call.result), [{ decision: 'deny' }]); assert.deepEqual(await client.brokerCapabilities(), { releaseOwnerExclusions: true }); assert.equal(broker.retiredPermissionResponses.size, 0);
  } finally { approve?.(); await client.close(); await broker.close(); await rm(directory, { recursive: true, force: true }); }
});

test('failed send denies its exact pending permission and tombstones a late local approval', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-send-permission-error-')); const endpoint = brokerEndpointFor({ dataRoot: directory, workspace: directory }); const brokerToken = '6'.repeat(64); const record = join(directory, 'calls.jsonl'); const broker = await newTestBroker({ endpoint, brokerToken, workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture }, env: { ...process.env, FAKE_ZCODE_PERMISSION: '1', FAKE_ZCODE_BAD_SEND_ONCE: '1', FAKE_ZCODE_SYNC_BATCH: 'stale-valid', FAKE_ZCODE_RECORD: record } }).start(); const client = await createZCodeClient({ workspace: directory, brokerEndpoint: endpoint, brokerToken, ownerId: 'send-permission-error-owner' }); let approve;
  try {
    const { session: { sessionId } } = await client.createSession({ workspace: directory }); let permissionEntered; const entered = new Promise((resolvePromise) => { permissionEntered = resolvePromise; }); const approval = new Promise((resolvePromise) => { approve = () => resolvePromise({ decision: 'allow' }); }); client.setPermissionHandler(async () => { permissionEntered(); return approval; }); const sending = client.send(sessionId, 'fail after permission'); await entered; await assert.rejects(sending, { code: 'ZCODE_OUTPUT_INVALID' }); assert.equal(broker.activeSessionSockets.has(sessionId), false); assert.equal(broker.permissionPending.size, 0); assert.equal(broker.retiredPermissionResponses.size, 1);
    approve(); await waitForRecordedCalls(record, (calls) => calls.some((call) => call.id === 9000 && call.result)); assert.deepEqual((await readRecordedCalls(record)).filter((call) => call.id === 9000 && call.result).map((call) => call.result), [{ decision: 'deny' }]); assert.deepEqual(await client.brokerCapabilities(), { releaseOwnerExclusions: true }); assert.equal(broker.retiredPermissionResponses.size, 0);
  } finally { approve?.(); await client.close(); await broker.close(); await rm(directory, { recursive: true, force: true }); }
});

test('broker consumes validated completion and permits repeated turns without retained state', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-consume-')); const endpoint = brokerEndpointFor({ dataRoot: directory, workspace: directory }); const brokerToken = '9'.repeat(64);
  const broker = await newTestBroker({ endpoint, brokerToken, workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture }, env: { ...process.env, FAKE_ZCODE_SYNC_BATCH: 'stale-valid' }, idleTimeoutMs: 1_000 }).start();
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

test('a disconnected active turn keeps its exact terminal metadata and permits idle reap', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-detached-turn-')); const endpoint = brokerEndpointFor({ dataRoot: directory, workspace: directory }); const brokerToken = '6'.repeat(64); const ownerId = 'detached-turn-owner-stable'; const gate = join(directory, 'completion.gate'); const record = join(directory, 'calls.jsonl'); await writeFile(gate, 'hold'); const broker = await newTestBroker({ endpoint, brokerToken, workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture }, env: { ...process.env, FAKE_ZCODE_COMPLETION_GATE: gate, FAKE_ZCODE_RECORD: record }, idleTimeoutMs: 1_000 }).start(); const worker = await createZCodeClient({ workspace: directory, brokerEndpoint: endpoint, brokerToken, ownerId }); let controller;
  try {
    const sessionId = (await worker.createSession({ workspace: directory })).session.sessionId; await worker.send(sessionId, 'finish after disconnect'); assert.equal(broker.activeSessions.has(sessionId), true); const activeSocket = broker.activeSessionSockets.get(sessionId)?.socket; broker.fastIdleRequested = true; await worker.close(); await worker.close(); for (let index = 0; index < 100 && broker.activeSessionSockets.get(sessionId)?.socket === activeSocket; index += 1) await new Promise((resolvePromise) => setTimeout(resolvePromise, 5)); const detached = broker.activeSessionSockets.get(sessionId); assert.equal(detached?.socket, null); assert.equal(Number.isSafeInteger(detached?.baseline), true); assert.equal(detached?.inputId.length > 0, true); assert.equal(broker.activeSessions.has(sessionId), true);
    controller = await createZCodeClient({ workspace: directory, brokerEndpoint: endpoint, brokerToken, ownerId }); await assert.rejects(controller.send(sessionId, 'must remain fenced'), { code: 'ZCODE_TURN_ACTIVE' }); assert.equal((await readRecordedCalls(record)).filter((call) => call.method === 'session/send').length, 1); await controller.close(); controller = null; await writeFile(gate, 'release'); for (let index = 0; index < 400 && (broker.activeSessions.has(sessionId) || broker.activeSessionSockets.has(sessionId)); index += 1) await new Promise((resolvePromise) => setTimeout(resolvePromise, 5)); assert.equal(broker.activeSessions.has(sessionId), false); assert.equal(broker.activeSessionSockets.has(sessionId), false); for (let index = 0; index < 400 && (broker.server || broker.protocol); index += 1) await new Promise((resolvePromise) => setTimeout(resolvePromise, 5)); assert.equal(broker.server, null); assert.equal(broker.protocol, null);
  } finally { await writeFile(gate, 'release').catch(() => {}); await controller?.close().catch(() => {}); await worker.close().catch(() => {}); await broker.close(); await rm(directory, { recursive: true, force: true }); }
});

test('a reconnected owner can stop an exact detached turn without terminal resurrection', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-detached-stop-')); const endpoint = brokerEndpointFor({ dataRoot: directory, workspace: directory }); const brokerToken = '7'.repeat(64); const ownerId = 'detached-stop-owner-stable'; const gate = join(directory, 'completion.gate'); await writeFile(gate, 'hold'); const broker = await newTestBroker({ endpoint, brokerToken, workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture }, env: { ...process.env, FAKE_ZCODE_COMPLETION_GATE: gate } }).start(); const worker = await createZCodeClient({ workspace: directory, brokerEndpoint: endpoint, brokerToken, ownerId }); let controller;
  try {
    const sessionId = (await worker.createSession({ workspace: directory })).session.sessionId; await worker.send(sessionId, 'stop after disconnect'); const activeSocket = broker.activeSessionSockets.get(sessionId)?.socket; await worker.close(); for (let index = 0; index < 100 && broker.activeSessionSockets.get(sessionId)?.socket === activeSocket; index += 1) await new Promise((resolvePromise) => setTimeout(resolvePromise, 5)); assert.equal(broker.activeSessionSockets.get(sessionId)?.socket, null); controller = await createZCodeClient({ workspace: directory, brokerEndpoint: endpoint, brokerToken, ownerId }); assert.deepEqual(await controller.stopSession(sessionId), {}); assert.equal(broker.activeSessionSockets.has(sessionId), false); assert.equal(broker.activeSessions.has(sessionId), false); await writeFile(gate, 'release'); await new Promise((resolvePromise) => setTimeout(resolvePromise, 25)); assert.equal(broker.activeSessionSockets.has(sessionId), false); assert.equal(broker.activeSessions.has(sessionId), false);
  } finally { await writeFile(gate, 'release').catch(() => {}); await controller?.close().catch(() => {}); await worker.close().catch(() => {}); await broker.close(); await rm(directory, { recursive: true, force: true }); }
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
  const directory = await compactBrokerTemp(); const endpoint = brokerEndpointFor({ dataRoot: directory, workspace: directory }); const ownershipPath = join(directory, 'session-owners.json'); const brokerToken = 'd'.repeat(64); const ownerId = 'conversation-create-generation-owner'; const existingSessionId = 'conversation-create-existing-session'; const createdSessionId = 'conversation-create-stale-session'; await writeFile(ownershipPath, JSON.stringify({ version: 1, sessions: { [existingSessionId]: ownerId } }));
  const broker = await newTestBroker({ endpoint, ownershipPath, brokerToken, workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture }, env: { ...process.env, FAKE_ZCODE_CONCURRENT_CREATE_SUBSCRIBE_BATCH: '1', FAKE_ZCODE_BAD_CONVERSATION_ACK_ONCE: '1' } }).start(); const getProtocol = broker.getProtocol.bind(broker); const clearProtocolGeneration = broker.clearProtocolGeneration.bind(broker); let failedProtocol; let failedRetirement; broker.getProtocol = async () => { const protocol = await getProtocol(); failedProtocol ??= protocol; return protocol; }; broker.clearProtocolGeneration = (protocol) => { const retired = clearProtocolGeneration(protocol); if (protocol === failedProtocol) failedRetirement ??= retired; return retired; }; const client = await createZCodeClient({ workspace: directory, brokerEndpoint: endpoint, brokerToken, ownerId });
  try {
    const creating = client.createSession({ workspace: directory, sessionId: createdSessionId }); const subscribing = client.subscribeConversation(existingSessionId, { connectionId: 'concurrent-unsafe-subscribe', clientMode: 'desktop-continuous' }); const [createOutcome, subscribeOutcome] = await Promise.allSettled([creating, subscribing]);
    assert.equal(subscribeOutcome.status, 'rejected'); assert.equal(createOutcome.status, 'rejected'); assert.equal(broker.sessionOwners.has(createdSessionId), false); assert.deepEqual(JSON.parse(await readFile(ownershipPath, 'utf8')).sessions, { [existingSessionId]: ownerId }); await new Promise((resolvePromise) => setImmediate(resolvePromise)); assert.ok(failedRetirement); await failedRetirement.closePromise; const replacementProtocol = await getProtocol(); assert.notEqual(replacementProtocol, failedProtocol); assert.equal(broker.sessionOwners.has(createdSessionId), false);
  } finally { await client.close(); await broker.close(); await rm(directory, { recursive: true, force: true }); }
});

test('a reverse-order same-chunk unsafe acknowledgement compensates a stale durable create', async () => {
  const directory = await compactBrokerTemp(); const endpoint = brokerEndpointFor({ dataRoot: directory, workspace: directory }); const ownershipPath = join(directory, 'session-owners.json'); const brokerToken = '4'.repeat(64); const ownerId = 'conversation-create-reverse-owner'; const existingSessionId = 'conversation-create-reverse-existing'; const createdSessionId = 'conversation-create-reverse-stale'; await writeFile(ownershipPath, JSON.stringify({ version: 1, sessions: { [existingSessionId]: ownerId } }));
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

test('a retired subscription id and its early frame cannot be reassigned to a new owner', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-retired-subscription-reuse-')); const endpoint = join(directory, 'broker.sock'); const sessionId = 'retired-reuse-session'; const topic = `conversation/${sessionId}`; const subscriptionId = 'retired-reuse-subscription'; const oldOwner = 'retired-reuse-old-owner'; const newOwner = 'retired-reuse-new-owner'; const oldWrites = []; const newWrites = []; const oldSocket = { writable: true, destroyed: false, zcodeWriter: { write: (line) => oldWrites.push(JSON.parse(line)) }, destroy() {} }; const newSocket = { writable: true, destroyed: false, zcodeWriter: { write: (line) => newWrites.push(JSON.parse(line)) }, destroy() {} }; const broker = newTestBroker({ endpoint, brokerToken: 'f'.repeat(64), workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } }); for (const [socket, ownerId] of [[oldSocket, oldOwner], [newSocket, newOwner]]) { broker.authenticated.add(socket); broker.socketOwnerIds.set(socket, ownerId); } broker.sessionOwners.set(sessionId, { ownerId: oldOwner, socket: oldSocket }); broker.reloadOwnership = async () => {};
  let subscribeCalls = 0; let resolveReusedAck; let closeCalls = 0; const protocol = { request: async (method) => { if (method === 'v4/conversation/subscribe') { subscribeCalls += 1; if (subscribeCalls === 1) return { ack: { subscriptionId, mode: 'snapshot', logEpoch: 'retired-reuse-old-epoch' } }; return new Promise((resolvePromise) => { resolveReusedAck = resolvePromise; }); } if (method === 'v4/conversation/unsubscribe') return {}; throw new Error(`unexpected ${method}`); }, close: async () => { closeCalls += 1; } }; broker.protocol = protocol;
  await broker.handleLocal(oldSocket, JSON.stringify({ id: 41, method: 'v4/conversation/subscribe', params: { topic, connectionId: 'retired-reuse-old-connection', clientMode: 'desktop-continuous' } })); await broker.handleLocal(oldSocket, JSON.stringify({ id: 42, method: 'v4/conversation/unsubscribe', params: { topic, subscriptionId, connectionId: 'retired-reuse-old-connection' } })); broker.sessionOwners.set(sessionId, { ownerId: newOwner, socket: newSocket }); const subscribing = broker.handleLocal(newSocket, JSON.stringify({ id: 43, method: 'v4/conversation/subscribe', params: { topic, connectionId: 'retired-reuse-new-connection', clientMode: 'desktop-continuous' } })); while (!resolveReusedAck) await new Promise((resolvePromise) => setImmediate(resolvePromise)); broker.routeConversationFrame({ method: 'v4/conversation/frame', params: { topic, subscriptionId, frame: { payload: 'old-owner-frame' } } }); resolveReusedAck({ ack: { subscriptionId, mode: 'resume', logEpoch: 'retired-reuse-new-epoch' } }); await subscribing;
  assert.equal(newWrites.some((frame) => frame.method === 'v4/conversation/frame'), false); assert.equal(newWrites.find((frame) => frame.id === 43)?.error?.data?.pluginError?.code, 'ZCODE_BROKER_INPUT_INVALID'); assert.equal(broker.conversationSubscriptions.size, 0); assert.equal(broker.pendingConversationTopics.size, 0); assert.equal(broker.protocol, null); assert.equal(closeCalls, 1); await rm(directory, { recursive: true, force: true });
});

test('the 256th retired subscription resets its exact protocol generation instead of evicting evidence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-retired-subscription-cap-')); const broker = newTestBroker({ endpoint: join(directory, 'broker.sock'), brokerToken: '1'.repeat(64), workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } }); let closeCalls = 0; const protocol = { request: async () => ({}), close: async () => { closeCalls += 1; } }; broker.protocol = protocol; const records = Array.from({ length: 256 }, (_, index) => ({ key: `retired-cap-${index}`, topic: `conversation/retired-cap-session-${index}`, subscriptionId: `retired-cap-subscription-${index}`, connectionId: `retired-cap-connection-${index}`, sessionId: `retired-cap-session-${index}`, ownerId: 'retired-cap-owner' })); await broker.unsubscribeConversationRecords(protocol, records, 250); await broker.retiredProtocolGeneration?.closePromise;
  assert.equal(closeCalls, 1); assert.equal(broker.protocol, null); assert.equal(broker.orphanedConversationSubscriptions.size, 0); assert.equal(broker.pendingConversationTopics.size, 0); await rm(directory, { recursive: true, force: true });
});

test('conversation routing revalidates current ownership and enforces pending frame bounds', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-conversation-bounds-')); const writes = [];
  const broker = newTestBroker({ endpoint: join(directory, 'broker.sock'), brokerToken: 'f'.repeat(64), workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } });
  const socket = { writable: true, zcodeWriter: { write: (line) => writes.push(JSON.parse(line)) }, destroy() {} }; const sessionId = 'bounded-conversation-session'; const topic = `conversation/${sessionId}`; const subscriptionId = 'bounded-subscription'; const message = { method: 'v4/conversation/frame', params: { topic, subscriptionId, frame: { payload: 'safe' } } }; const protocol = {}; broker.protocol = protocol;
  broker.sessionOwners.set(sessionId, { ownerId: 'original-owner-stable', socket, claimToken: null }); broker.conversationSubscriptions.set(JSON.stringify([topic, subscriptionId]), { socket, topic, subscriptionId, connectionId: 'connection-1', sessionId, ownerId: 'original-owner-stable' });
  broker.routeConversationFrame(message); assert.equal(writes.length, 1);
  broker.sessionOwners.set(sessionId, { ownerId: 'replacement-owner-stable', socket: null, claimToken: null }); broker.routeConversationFrame(message); assert.equal(writes.length, 1);
  broker.conversationSubscriptions.clear(); broker.pendingConversationTopics.set(topic, { socket, token: 'pending-token', protocol, sessionId, ownerId: 'replacement-owner-stable', earlySubscriptionId: null, ambiguous: false, frames: [], bytes: 0 }); broker.routeConversationFrame({ ...message, params: { ...message.params, frame: { payload: 'x'.repeat(70 * 1024) } } }); assert.equal(broker.pendingConversationTopics.get(topic).frames.length, 0);
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

test('owner release cleans sixteen subscriptions concurrently within one shared budget', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-release-cleanup-budget-')); const endpoint = join(directory, 'broker.sock'); const ownerId = 'release-budget-owner'; const socket = { writable: true, destroyed: false, zcodeWriter: { write() {} }, destroy() {} }; const broker = newTestBroker({ endpoint, brokerToken: 'a'.repeat(64), workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } }); const sessions = {};
  for (let index = 0; index < 16; index += 1) { const sessionId = `budget-session-${index}`; sessions[sessionId] = ownerId; broker.sessionOwners.set(sessionId, { ownerId, socket, claimToken: null }); broker.conversationSubscriptions.set(`budget-${index}`, { socket, topic: `conversation/${sessionId}`, subscriptionId: `budget-sub-${index}`, connectionId: `budget-connection-${index}`, sessionId, ownerId }); }
  await writeFile(`${endpoint}.owners.json`, JSON.stringify({ version: 1, sessions })); broker.ownershipStoreEstablished = true; let unsubscribeCalls = 0; let releaseFirstBatch; let releaseSecondBatch; let markFirstBatchEntered; let markSecondBatchEntered; const firstBatchEntered = new Promise((resolvePromise) => { markFirstBatchEntered = resolvePromise; }); const secondBatchEntered = new Promise((resolvePromise) => { markSecondBatchEntered = resolvePromise; }); const firstBatchGate = new Promise((resolvePromise) => { releaseFirstBatch = resolvePromise; }); const secondBatchGate = new Promise((resolvePromise) => { releaseSecondBatch = resolvePromise; });
  broker.protocol = { request: async (method) => { if (method === 'session/stop') return {}; unsubscribeCalls += 1; const batchGate = unsubscribeCalls <= 8 ? firstBatchGate : secondBatchGate; if (unsubscribeCalls === 8) markFirstBatchEntered(); if (unsubscribeCalls === 16) markSecondBatchEntered(); await batchGate; throw new Error('slow unsubscribe failure'); }, cancelTurn() {} };
  const releasing = broker.releaseOwner(socket, ownerId, []); await firstBatchEntered; assert.equal(unsubscribeCalls, 8, 'the first bounded cleanup batch must enter concurrently'); releaseFirstBatch(); await secondBatchEntered; assert.equal(unsubscribeCalls, 16, 'the second bounded cleanup batch must enter after the first settles'); releaseSecondBatch(); const released = await releasing;
  assert.equal(released.releasedSessionIds.length, 16); assert.equal(released.failedSessionIds.length, 0); assert.equal(unsubscribeCalls, 16); assert.equal(broker.orphanedConversationSubscriptions.size, 16);
  await rm(directory, { recursive: true, force: true });
});

test('an idle owner release keeps its valid stop acknowledgement through malformed cleanup', async (t) => {
  for (const closeMode of ['1000ms', 'nonsettle']) await t.test(closeMode, { timeout: 2_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-release-close-budget-')); const endpoint = join(directory, 'broker.sock'); const ownershipPath = `${endpoint}.owners.json`; const ownerId = `release-close-owner-${closeMode}`; const sessionId = `release-close-session-${closeMode}`; const socket = { writable: true, destroyed: false, zcodeWriter: { write() {} }, destroy() {} }; const broker = newTestBroker({ endpoint, ownershipPath, brokerToken: '9'.repeat(64), workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } }); broker.sessionOwners.set(sessionId, { ownerId, socket }); broker.conversationSubscriptions.set('release-close-subscription', { socket, topic: `conversation/${sessionId}`, subscriptionId: `release-close-sub-${closeMode}`, connectionId: `release-close-connection-${closeMode}`, sessionId, ownerId }); await writeFile(ownershipPath, JSON.stringify({ version: 1, sessions: { [sessionId]: ownerId } })); broker.ownershipStoreEstablished = true; let closeCalls = 0; const protocol = { request: async (method) => method === 'session/stop' ? {} : { malformed: true }, cancelTurn() {}, close: () => { closeCalls += 1; if (closeMode === 'nonsettle') return new Promise(() => {}); return new Promise((resolvePromise) => { const timer = setTimeout(resolvePromise, 1_000); timer.unref?.(); }); } }; broker.protocol = protocol;
    const started = Date.now(); let timeout; const timedOut = Symbol('release-timeout'); const outcome = await Promise.race([broker.releaseOwner(socket, ownerId, []), new Promise((resolvePromise) => { timeout = setTimeout(() => resolvePromise(timedOut), 700); })]); clearTimeout(timeout); const elapsed = Date.now() - started;
    assert.notEqual(outcome, timedOut); assert.ok(elapsed < 550, `release waited for protocol close cleanup: ${elapsed}ms`); assert.deepEqual(outcome.releasedSessionIds, [sessionId]); assert.deepEqual(outcome.failedSessionIds, []); assert.equal(closeCalls, 1); assert.equal(broker.orphanedConversationSubscriptions.size, 1); assert.equal(broker.sessionOwners.has(sessionId), false); assert.equal(Object.hasOwn(JSON.parse(await readFile(ownershipPath, 'utf8')).sessions, sessionId), false); await rm(directory, { recursive: true, force: true });
  });
});

test('owner release commits only its authoritative stop winner after malformed cleanup resets the protocol', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-release-cleanup-reset-')); const endpoint = join(directory, 'broker.sock'); const ownershipPath = `${endpoint}.owners.json`; const ownerId = 'release-cleanup-reset-owner'; const sessionId = 'release-cleanup-reset-session'; const siblingId = 'release-cleanup-reset-sibling'; const socket = { writable: true, destroyed: false, zcodeWriter: { write() {} }, destroy() {} }; const broker = newTestBroker({ endpoint, ownershipPath, brokerToken: 'd'.repeat(64), workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } }); broker.sessionOwners.set(sessionId, { ownerId, socket }); broker.sessionOwners.set(siblingId, { ownerId, socket }); const activeTurn = { socket, token: 'release-cleanup-reset-turn', baseline: 1, inputId: 'release-cleanup-reset-input' }; broker.activeSessionSockets.set(sessionId, activeTurn); broker.activeSessions.add(sessionId); const subscription = { socket, topic: `conversation/${sessionId}`, subscriptionId: 'release-cleanup-reset-subscription', connectionId: 'release-cleanup-reset-connection', sessionId, ownerId }; broker.conversationSubscriptions.set('release-cleanup-reset-key', subscription); await writeFile(ownershipPath, JSON.stringify({ version: 1, sessions: { [sessionId]: ownerId, [siblingId]: ownerId } })); broker.ownershipStoreEstablished = true; let stopCalls = 0; let cancelCalls = 0; let unsubscribeCalls = 0; let closeCalls = 0; const oldProtocol = { request: async (method) => { if (method === 'session/stop') { stopCalls += 1; return {}; } assert.equal(method, 'v4/conversation/unsubscribe'); unsubscribeCalls += 1; return { malformed: true }; }, cancelTurn: () => { cancelCalls += 1; }, close: async () => { closeCalls += 1; } }; broker.protocol = oldProtocol;
  const released = await broker.releaseOwner(socket, ownerId, []); assert.deepEqual(released.releasedSessionIds.sort(), [sessionId, siblingId].sort()); assert.deepEqual(released.failedSessionIds, []); assert.equal(stopCalls, 2); assert.equal(cancelCalls, 1); assert.equal(unsubscribeCalls, 1); assert.equal(closeCalls, 1); assert.equal(broker.sessionOwners.has(sessionId), false); assert.equal(broker.sessionOwners.has(siblingId), false); assert.deepEqual(JSON.parse(await readFile(ownershipPath, 'utf8')).sessions, {}); for (let index = 0; index < 20 && broker.retiredProtocolGeneration; index += 1) await new Promise((resolvePromise) => setImmediate(resolvePromise)); assert.equal(broker.retiredProtocolGeneration, null); assert.equal(broker.orphanedConversationSubscriptions.size, 0); await rm(directory, { recursive: true, force: true });
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

test('an idle stop winner remains authoritative when its protocol resets during the durable write', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-release-write-generation-')); const endpoint = join(directory, 'broker.sock'); const ownershipPath = `${endpoint}.owners.json`; const ownerId = 'release-write-generation-owner'; const sessionId = 'release-write-generation-session'; const socket = { writable: true, destroyed: false, zcodeWriter: { write() {} }, destroy() {} }; const broker = newTestBroker({ endpoint, brokerToken: '0'.repeat(64), workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } }); broker.sessionOwners.set(sessionId, { ownerId, socket, claimToken: null }); await writeFile(ownershipPath, JSON.stringify({ version: 1, sessions: { [sessionId]: ownerId } })); broker.ownershipStoreEstablished = true; const protocol = { request: async () => ({}), cancelTurn() {} }; broker.protocol = protocol; let writeApplied; let resumeWrite; const applied = new Promise((resolvePromise) => { writeApplied = resolvePromise; }); const gate = new Promise((resolvePromise) => { resumeWrite = resolvePromise; }); let writes = 0; broker.writeOwnerStore = async (sessions) => { writes += 1; await atomicWriteJson(ownershipPath, { version: 1, sessions }); if (writes === 1) { writeApplied(); await gate; } };
  const releasing = broker.releaseOwner(socket, ownerId, []); await applied; broker.clearProtocolGeneration(protocol); resumeWrite(); const result = await releasing; assert.deepEqual(result.releasedSessionIds, [sessionId]); assert.deepEqual(result.failedSessionIds, []); assert.equal(writes, 1); assert.equal(broker.sessionOwners.has(sessionId), false); assert.equal(Object.hasOwn(JSON.parse(await readFile(ownershipPath, 'utf8')).sessions, sessionId), false); assert.equal(broker.stoppingSessions.has(sessionId), false); await rm(directory, { recursive: true, force: true });
});

test('owner release rolls back every winner when a sibling lease expires during the durable write', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-release-authoritative-write-')); const endpoint = join(directory, 'broker.sock'); const ownershipPath = `${endpoint}.owners.json`; const ownerId = 'release-authoritative-write-owner'; const sessionId = 'release-authoritative-write-session'; const siblingId = 'release-authoritative-write-sibling'; const socket = { writable: true, destroyed: false, zcodeWriter: { write() {} }, destroy() {} }; const broker = newTestBroker({ endpoint, ownershipPath, brokerToken: '1'.repeat(64), workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } }); broker.sessionOwners.set(sessionId, { ownerId, socket }); broker.sessionOwners.set(siblingId, { ownerId, socket }); const activeTurn = { socket, token: 'release-authoritative-write-turn', baseline: 1, inputId: 'release-authoritative-write-input' }; broker.activeSessionSockets.set(sessionId, activeTurn); broker.activeSessions.add(sessionId); await writeFile(ownershipPath, JSON.stringify({ version: 1, sessions: { [sessionId]: ownerId, [siblingId]: ownerId } })); broker.ownershipStoreEstablished = true; let cancelCalls = 0; let writeCalls = 0; const protocol = { request: async () => ({}), cancelTurn: () => { cancelCalls += 1; }, close: async () => {} }; broker.protocol = protocol; broker.writeOwnerStore = async (sessions) => { writeCalls += 1; await atomicWriteJson(ownershipPath, { version: 1, sessions }); if (writeCalls === 1) { retireTestSessionLease(broker, siblingId); broker.clearProtocolGeneration(protocol); } };
  const result = await broker.releaseOwner(socket, ownerId, []); assert.deepEqual(result.releasedSessionIds, []); assert.deepEqual(result.failedSessionIds.sort(), [sessionId, siblingId].sort()); assert.equal(cancelCalls, 1); assert.equal(broker.sessionOwners.get(sessionId)?.ownerId, ownerId); assert.equal(broker.sessionOwners.get(siblingId)?.ownerId, ownerId); assert.deepEqual(JSON.parse(await readFile(ownershipPath, 'utf8')).sessions, { [sessionId]: ownerId, [siblingId]: ownerId }); assert.equal(broker.stoppingSessions.has(sessionId), false); assert.equal(broker.stoppingSessions.has(siblingId), false); await rm(directory, { recursive: true, force: true });
});

test('owner release fails closed when stale sibling compensation fails before restoring authority', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-release-compensation-before-apply-')); const endpoint = join(directory, 'broker.sock'); const ownershipPath = `${endpoint}.owners.json`; const ownerId = 'release-compensation-before-apply-owner'; const sessionId = 'release-compensation-before-apply-session'; const siblingId = 'release-compensation-before-apply-sibling'; const socket = { writable: true, destroyed: false, zcodeWriter: { write() {} }, destroy() {} }; const broker = newTestBroker({ endpoint, ownershipPath, brokerToken: '5'.repeat(64), workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } }); broker.sessionOwners.set(sessionId, { ownerId, socket }); broker.sessionOwners.set(siblingId, { ownerId, socket }); broker.activeSessionSockets.set(sessionId, { socket, token: 'release-compensation-before-apply-turn', baseline: 1, inputId: 'release-compensation-before-apply-input' }); broker.activeSessions.add(sessionId); await writeFile(ownershipPath, JSON.stringify({ version: 1, sessions: { [sessionId]: ownerId, [siblingId]: ownerId } })); broker.ownershipStoreEstablished = true; const compensationError = new Error('sibling compensation failed before apply'); let writeCalls = 0; const protocol = { request: async () => ({}), cancelTurn() {}, close: async () => {} }; broker.protocol = protocol; broker.writeOwnerStore = async (sessions) => { writeCalls += 1; if (writeCalls === 1) { await atomicWriteJson(ownershipPath, { version: 1, sessions }); retireTestSessionLease(broker, siblingId); broker.clearProtocolGeneration(protocol); return; } throw compensationError; };
  await assert.rejects(broker.releaseOwner(socket, ownerId, []), (error) => error === compensationError); assert.deepEqual(JSON.parse(await readFile(ownershipPath, 'utf8')).sessions, {}); assert.equal(broker.sessionOwners.get(sessionId)?.ownerId, ownerId); assert.equal(broker.sessionOwners.get(siblingId)?.ownerId, ownerId); assert.equal(broker.uncertainOwnerReleases.get(sessionId), ownerId); assert.equal(broker.uncertainOwnerReleases.get(siblingId), ownerId); await rm(directory, { recursive: true, force: true });
});

test('owner release rolls back an applied commit when a sibling lease expires before write recovery', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-release-authoritative-commit-error-')); const endpoint = join(directory, 'broker.sock'); const ownershipPath = `${endpoint}.owners.json`; const ownerId = 'release-authoritative-commit-error-owner'; const sessionId = 'release-authoritative-commit-error-session'; const siblingId = 'release-authoritative-commit-error-sibling'; const socket = { writable: true, destroyed: false, zcodeWriter: { write() {} }, destroy() {} }; const broker = newTestBroker({ endpoint, ownershipPath, brokerToken: '3'.repeat(64), workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } }); broker.sessionOwners.set(sessionId, { ownerId, socket }); broker.sessionOwners.set(siblingId, { ownerId, socket }); broker.activeSessionSockets.set(sessionId, { socket, token: 'release-authoritative-commit-error-turn', baseline: 1, inputId: 'release-authoritative-commit-error-input' }); broker.activeSessions.add(sessionId); await writeFile(ownershipPath, JSON.stringify({ version: 1, sessions: { [sessionId]: ownerId, [siblingId]: ownerId } })); broker.ownershipStoreEstablished = true; const writeError = new Error('owner commit applied before throwing'); let writeCalls = 0; const protocol = { request: async () => ({}), cancelTurn() {}, close: async () => {} }; broker.protocol = protocol; broker.writeOwnerStore = async (sessions) => { writeCalls += 1; await atomicWriteJson(ownershipPath, { version: 1, sessions }); if (writeCalls === 1) { retireTestSessionLease(broker, siblingId); broker.clearProtocolGeneration(protocol); throw writeError; } };
  const result = await broker.releaseOwner(socket, ownerId, []); assert.deepEqual(result.releasedSessionIds, []); assert.deepEqual(result.failedSessionIds.sort(), [sessionId, siblingId].sort()); assert.equal(writeCalls, 2); assert.equal(broker.sessionOwners.get(sessionId)?.ownerId, ownerId); assert.equal(broker.sessionOwners.get(siblingId)?.ownerId, ownerId); assert.deepEqual(JSON.parse(await readFile(ownershipPath, 'utf8')).sessions, { [sessionId]: ownerId, [siblingId]: ownerId }); assert.equal(broker.uncertainOwnerReleases.size, 0); await rm(directory, { recursive: true, force: true });
});

test('owner release never reports an authoritative winner restored by ambiguous sibling compensation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-release-authoritative-compensation-')); const endpoint = join(directory, 'broker.sock'); const ownershipPath = `${endpoint}.owners.json`; const ownerId = 'release-authoritative-compensation-owner'; const sessionId = 'release-authoritative-compensation-session'; const siblingId = 'release-authoritative-compensation-sibling'; const socket = { writable: true, destroyed: false, zcodeWriter: { write() {} }, destroy() {} }; const broker = newTestBroker({ endpoint, ownershipPath, brokerToken: '2'.repeat(64), workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } }); broker.sessionOwners.set(sessionId, { ownerId, socket }); broker.sessionOwners.set(siblingId, { ownerId, socket }); broker.activeSessionSockets.set(sessionId, { socket, token: 'release-authoritative-compensation-turn', baseline: 1, inputId: 'release-authoritative-compensation-input' }); broker.activeSessions.add(sessionId); const before = { [sessionId]: ownerId, [siblingId]: ownerId }; await writeFile(ownershipPath, JSON.stringify({ version: 1, sessions: before })); broker.ownershipStoreEstablished = true; const compensationError = new Error('ambiguous compensation restored the authoritative winner'); let writeCalls = 0; const protocol = { request: async () => ({}), cancelTurn() {}, close: async () => {} }; broker.protocol = protocol; broker.writeOwnerStore = async (sessions) => { writeCalls += 1; if (writeCalls === 1) { await atomicWriteJson(ownershipPath, { version: 1, sessions }); retireTestSessionLease(broker, siblingId); broker.clearProtocolGeneration(protocol); return; } await atomicWriteJson(ownershipPath, { version: 1, sessions: before }); throw compensationError; };
  const result = await broker.releaseOwner(socket, ownerId, []); assert.deepEqual(result.releasedSessionIds, []); assert.deepEqual(result.failedSessionIds.sort(), [sessionId, siblingId].sort()); assert.deepEqual(JSON.parse(await readFile(ownershipPath, 'utf8')).sessions, before); assert.equal(broker.uncertainOwnerReleases.size, 0); await rm(directory, { recursive: true, force: true });
});

test('owner release revalidates its authoritative winner inside the sibling compensation lock', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-release-compensation-lock-')); const endpoint = join(directory, 'broker.sock'); const ownershipPath = `${endpoint}.owners.json`; const ownerId = 'release-compensation-lock-owner'; const sessionId = 'release-compensation-lock-session'; const siblingId = 'release-compensation-lock-sibling'; const socket = { writable: true, destroyed: false, zcodeWriter: { write() {} }, destroy() {} }; const broker = newTestBroker({ endpoint, ownershipPath, brokerToken: '4'.repeat(64), workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } }); broker.sessionOwners.set(sessionId, { ownerId, socket }); broker.sessionOwners.set(siblingId, { ownerId, socket }); broker.activeSessionSockets.set(sessionId, { socket, token: 'release-compensation-lock-turn', baseline: 1, inputId: 'release-compensation-lock-input' }); broker.activeSessions.add(sessionId); const before = { [sessionId]: ownerId, [siblingId]: ownerId }; await writeFile(ownershipPath, JSON.stringify({ version: 1, sessions: before })); broker.ownershipStoreEstablished = true; const writeError = new Error('owner commit applied before lock revalidation'); const protocol = { request: async () => ({}), cancelTurn() {}, close: async () => {} }; broker.protocol = protocol; broker.writeOwnerStore = async (sessions) => { await atomicWriteJson(ownershipPath, { version: 1, sessions }); retireTestSessionLease(broker, siblingId); broker.clearProtocolGeneration(protocol); throw writeError; }; const compensateOwnerCommit = broker.compensateOwnerCommit.bind(broker); broker.compensateOwnerCommit = async (...args) => { await atomicWriteJson(ownershipPath, { version: 1, sessions: before }); return compensateOwnerCommit(...args); };
  const result = await broker.releaseOwner(socket, ownerId, []); assert.deepEqual(result.releasedSessionIds, []); assert.deepEqual(result.failedSessionIds.sort(), [sessionId, siblingId].sort()); assert.deepEqual(JSON.parse(await readFile(ownershipPath, 'utf8')).sessions, before); assert.equal(broker.uncertainOwnerReleases.size, 0); await rm(directory, { recursive: true, force: true });
});

test('owner release aborts its unlocked winner read after a reset compensation misses the deadline', { timeout: 1_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-release-compensation-deadline-')); const endpoint = join(directory, 'broker.sock'); const ownershipPath = `${endpoint}.owners.json`; const ownerId = 'release-compensation-deadline-owner'; const sessionId = 'release-compensation-deadline-session'; const siblingId = 'release-compensation-deadline-sibling'; const socket = { writable: true, destroyed: false, zcodeWriter: { write() {} }, destroy() {} }; const broker = newTestBroker({ endpoint, brokerToken: '2'.repeat(64), workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } }); broker.sessionOwners.set(sessionId, { ownerId, socket, claimToken: null }); broker.sessionOwners.set(siblingId, { ownerId, socket, claimToken: null }); broker.activeSessionSockets.set(sessionId, { socket, token: 'release-compensation-deadline-turn', baseline: 1, inputId: 'release-compensation-deadline-input' }); broker.activeSessions.add(sessionId); await writeFile(ownershipPath, JSON.stringify({ version: 1, sessions: { [sessionId]: ownerId, [siblingId]: ownerId } })); broker.ownershipStoreEstablished = true; const protocol = { request: async () => ({}), cancelTurn() {} }; broker.protocol = protocol; let writes = 0; let observedSignal; broker.writeOwnerStore = async (sessions, options) => { writes += 1; if (writes === 1) { await atomicWriteJson(ownershipPath, { version: 1, sessions }); retireTestSessionLease(broker, siblingId); broker.clearProtocolGeneration(protocol); return; } await new Promise((resolvePromise, rejectPromise) => { if (options.signal.aborted) { rejectPromise(options.signal.reason); return; } options.signal.addEventListener('abort', () => rejectPromise(options.signal.reason), { once: true }); }); }; broker.readOwnerStoreUnlocked = async (_allowMissing, options = {}) => { observedSignal = options.signal; if (!options.signal) { await new Promise((resolvePromise) => setTimeout(resolvePromise, 160)); return { exists: true, sessions: Object.create(null) }; } options.signal.throwIfAborted(); return { exists: true, sessions: Object.create(null) }; };
  const started = Date.now(); await withTestDeadlineKeepalive(() => assert.rejects(broker.releaseOwner(socket, ownerId, [], started + 80), { code: 'ZCODE_OWNER_RELEASE_TIMEOUT' })); const elapsed = Date.now() - started; assert.ok(elapsed < 180, `release exceeded its deadline while reading the compensation winner: ${elapsed}ms`); while (broker.releaseTasks.size) await new Promise((resolvePromise) => setImmediate(resolvePromise)); assert.equal(observedSignal?.aborted, true); assert.equal(broker.sessionOwners.get(sessionId)?.ownerId, ownerId); assert.equal(broker.sessionOwners.get(siblingId)?.ownerId, ownerId); assert.equal(broker.uncertainOwnerReleases.get(sessionId), ownerId); assert.equal(broker.uncertainOwnerReleases.get(siblingId), ownerId); assert.equal(broker.stoppingSessions.has(sessionId), false); assert.equal(broker.stoppingSessions.has(siblingId), false); await rm(directory, { recursive: true, force: true });
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
  const reading = broker.handleLocal(socket, JSON.stringify({ id: 27, method: 'session/read', params: { sessionId } })); await entered; const activeDuringReload = broker.admission.activeCount; const sessionLeaseDuringReload = broker.admission.sessionLeases.has(sessionId); finishReload(); await reading; assert.equal(activeDuringReload, 1); assert.equal(sessionLeaseDuringReload, false); assert.equal(writes.at(-1)?.error?.code, -32041); assert.equal(upstreamCalls, 0); assert.equal(broker.admission.activeCount, 0);
  const corruptSessionId = 'unknown-owner-corrupt-session'; let leaseSeenDuringReload = false; broker.reloadOwnership = async () => { leaseSeenDuringReload = broker.admission.sessionLeases.has(corruptSessionId); throw new PluginError('ZCODE_OWNER_STORE_INVALID', 'corrupt owner store'); }; await broker.handleLocal(socket, JSON.stringify({ id: 28, method: 'session/read', params: { sessionId: corruptSessionId } })); assert.equal(leaseSeenDuringReload, false); assert.equal(writes.at(-1)?.error?.data?.pluginError?.code, 'ZCODE_OWNER_STORE_INVALID'); assert.equal(broker.admission.activeCount, 0); await rm(directory, { recursive: true, force: true });
});

test('an active owner release rejects unknown ownership before reload or upstream work', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-preflight-release-fence-')); const ownerId = 'preflight-release-fence-owner'; const sessionId = 'preflight-release-fence-session'; const writes = []; const socket = { writable: true, destroyed: false, zcodeWriter: { write: (line) => writes.push(JSON.parse(line)) }, destroy() {} }; const broker = newTestBroker({ endpoint: join(directory, 'broker.sock'), brokerToken: '5'.repeat(64), workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } }); broker.authenticated.add(socket); broker.socketOwnerIds.set(socket, ownerId); const releaseAdmission = broker.admission.beginOwnerRequest('broker/releaseOwner', ownerId); let reloadCalls = 0; let upstreamCalls = 0; broker.reloadOwnership = async () => { reloadCalls += 1; }; broker.protocol = { request: async () => { upstreamCalls += 1; return { ok: true }; } };
  await broker.handleLocal(socket, JSON.stringify({ id: 29, method: 'session/read', params: { sessionId } })); assert.equal(reloadCalls, 0); assert.equal(upstreamCalls, 0); assert.equal(writes.at(-1)?.error?.data?.pluginError?.code, 'ZCODE_TURN_ACTIVE'); assert.equal(broker.admission.activeCount, 1); broker.admission.finishOwnerRequest(releaseAdmission); assert.equal(broker.admission.activeCount, 0); await rm(directory, { recursive: true, force: true });
});

test('unknown ownership preflights cap reload concurrency globally before the 257th request', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-preflight-global-bound-')); const ownerId = 'preflight-global-bound-owner'; const writes = []; const socket = { writable: true, destroyed: false, zcodeWriter: { write: (line) => writes.push(JSON.parse(line)) }, destroy() {} }; const broker = newTestBroker({ endpoint: join(directory, 'broker.sock'), brokerToken: '6'.repeat(64), workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } }); broker.authenticated.add(socket); broker.socketOwnerIds.set(socket, ownerId); let reloadCalls = 0; let finishReload; const reloadGate = new Promise((resolvePromise) => { finishReload = resolvePromise; }); broker.reloadOwnership = async () => { reloadCalls += 1; await reloadGate; }; let upstreamCalls = 0; broker.protocol = { request: async () => { upstreamCalls += 1; return { ok: true }; } }; const operations = [];
  for (let index = 0; index < 257; index += 1) operations.push(broker.handleLocal(socket, JSON.stringify({ id: 3000 + index, method: 'session/read', params: { sessionId: `preflight-global-bound-session-${index}` } })));
  for (let turn = 0; turn < 100 && reloadCalls < 256 && !writes.some((frame) => frame.id === 3256); turn += 1) await new Promise((resolvePromise) => setImmediate(resolvePromise)); const reloadsBeforeCleanup = reloadCalls; const activeBeforeCleanup = broker.admission.activeCount; const sessionLeasesBeforeCleanup = broker.admission.sessionLeases.size; finishReload(); await Promise.all(operations);
  assert.equal(reloadsBeforeCleanup, 256); assert.equal(activeBeforeCleanup, 256); assert.equal(sessionLeasesBeforeCleanup, 0); assert.equal(writes.find((frame) => frame.id === 3256)?.error?.data?.pluginError?.code, 'ZCODE_TURN_ACTIVE'); assert.equal(upstreamCalls, 0); assert.equal(broker.admission.activeCount, 0); assert.equal(broker.admission.ownerStates.size, 0); await rm(directory, { recursive: true, force: true });
});

test('release retires 256 preflight authorities without releasing their physical operation slots', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-preflight-physical-slots-')); const ownerA = 'preflight-physical-owner-a'; const ownerB = 'preflight-physical-owner-b'; const broker = newTestBroker({ endpoint: join(directory, 'broker.sock'), brokerToken: 'b'.repeat(64), workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } }); const preflights = [];
  for (let index = 0; index < 256; index += 1) preflights.push(broker.admission.beginOwnershipPreflight(ownerA, `preflight-physical-session-${index}`)); const release = broker.admission.beginOwnerRequest('broker/releaseOwner', ownerA); assert.equal(broker.admission.activeOperationCount, 256); assert.equal(broker.admission.activeReleaseCount, 1); assert.equal(broker.admission.activeCount, 257); assert.equal(broker.admission.ownerStates.get(ownerA)?.preflights.size, 256); assert.equal(preflights.some((preflight) => broker.admission.ownershipPreflightCurrent(preflight)), false); assert.throws(() => broker.admission.beginOwnershipPreflight(ownerB, 'preflight-physical-overflow'), (error) => error?.code === 'ZCODE_TURN_ACTIVE'); const siblingRelease = broker.admission.beginOwnerRequest('broker/releaseOwner', ownerB); assert.equal(broker.admission.activeReleaseCount, 2); assert.throws(() => broker.admission.beginOwnerRequest('broker/releaseOwner', ownerA), (error) => error?.code === 'ZCODE_TURN_ACTIVE' && /already/.test(error.message));
  broker.admission.finishOwnerRequest(siblingRelease); broker.admission.finishOwnerRequest(release); assert.equal(broker.admission.activeOperationCount, 256); assert.equal(broker.admission.activeReleaseCount, 0); assert.throws(() => broker.admission.beginOwnershipPreflight(ownerB, 'preflight-physical-still-full'), (error) => error?.code === 'ZCODE_TURN_ACTIVE'); broker.admission.finishOwnershipPreflight(preflights.shift()); const replacement = broker.admission.beginOwnershipPreflight(ownerB, 'preflight-physical-replacement'); for (const preflight of preflights) broker.admission.finishOwnershipPreflight(preflight); broker.admission.finishOwnershipPreflight(replacement); assert.equal(broker.admission.activeCount, 0); assert.equal(broker.admission.ownerStates.size, 0); await rm(directory, { recursive: true, force: true });
});

test('owner release admission bounds different owners and prioritizes same-owner conflicts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-release-capacity-')); const broker = newTestBroker({ endpoint: join(directory, 'broker.sock'), brokerToken: '2'.repeat(64), workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } }); const releases = [];
  for (let index = 0; index < 16; index += 1) releases.push(broker.admission.beginOwnerRequest('broker/releaseOwner', `release-capacity-owner-${index}`)); assert.equal(broker.admission.activeReleaseCount, 16); assert.throws(() => broker.admission.beginOwnerRequest('broker/releaseOwner', 'release-capacity-owner-0'), (error) => error?.code === 'ZCODE_TURN_ACTIVE' && /already/.test(error.message)); assert.throws(() => broker.admission.beginOwnerRequest('broker/releaseOwner', 'release-capacity-overflow-owner'), (error) => error?.code === 'ZCODE_TURN_ACTIVE' && /too many/.test(error.message)); for (const release of releases) broker.admission.finishOwnerRequest(release); assert.equal(broker.admission.activeReleaseCount, 0); assert.equal(broker.admission.ownerStates.size, 0); await rm(directory, { recursive: true, force: true });
});

test('public owner release reports same-owner and capacity admission conflicts without hanging', async () => {
  const directory = await compactBrokerTemp(); const endpoint = brokerEndpointFor({ dataRoot: directory, workspace: directory }); const brokerToken = 'e'.repeat(64); const launch = { command: process.execPath, args: [fixture], target: fixture }; const broker = await newTestBroker({ endpoint, brokerToken, workspace: directory, launch }).start(); let client; const held = [];
  try {
    client = await createZCodeClient({ workspace: directory, brokerEndpoint: endpoint, brokerToken, ownerId: 'release-public-same-owner' }); held.push(broker.admission.beginOwnerRequest('broker/releaseOwner', 'release-public-same-owner')); let started = Date.now(); await assert.rejects(client.releaseOwner([]), (error) => error?.code === 'ZCODE_TURN_ACTIVE' && /already/.test(error.message)); assert.ok(Date.now() - started < 200);
    broker.admission.finishOwnerRequest(held.pop()); for (let index = 0; index < 16; index += 1) held.push(broker.admission.beginOwnerRequest('broker/releaseOwner', `release-public-capacity-owner-${index}`)); started = Date.now(); await assert.rejects(client.releaseOwner([]), (error) => error?.code === 'ZCODE_TURN_ACTIVE' && /too many/.test(error.message)); assert.ok(Date.now() - started < 200);
  } finally { for (const release of held) broker.admission.finishOwnerRequest(release); await client?.close().catch(() => {}); await broker.close(); await rm(directory, { recursive: true, force: true }); }
});

test('ownership preflight converts to one exact session lease without double counting', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-preflight-convert-')); const ownerId = 'preflight-convert-owner'; const sessionId = 'preflight-convert-session'; const writes = []; const socket = { writable: true, destroyed: false, zcodeWriter: { write: (line) => writes.push(JSON.parse(line)) }, destroy() {} }; const broker = newTestBroker({ endpoint: join(directory, 'broker.sock'), brokerToken: '7'.repeat(64), workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } }); broker.authenticated.add(socket); broker.socketOwnerIds.set(socket, ownerId); let enterReload; let finishReload; const reloadEntered = new Promise((resolvePromise) => { enterReload = resolvePromise; }); const reloadGate = new Promise((resolvePromise) => { finishReload = resolvePromise; }); broker.reloadOwnership = async () => { enterReload(); await reloadGate; broker.sessionOwners.set(sessionId, { ownerId, socket, claimToken: null }); }; let enterUpstream; let finishUpstream; const upstreamEntered = new Promise((resolvePromise) => { enterUpstream = resolvePromise; }); const upstreamGate = new Promise((resolvePromise) => { finishUpstream = resolvePromise; }); broker.protocol = { request: async () => { enterUpstream(); await upstreamGate; return { ok: true }; } };
  const reading = broker.handleLocal(socket, JSON.stringify({ id: 29, method: 'session/read', params: { sessionId } })); await reloadEntered; const leaseDuringReload = broker.admission.sessionLeases.has(sessionId); const countDuringReload = broker.admission.activeCount; finishReload(); await upstreamEntered; const leasesDuringUpstream = broker.admission.sessionLeases.get(sessionId); const leaseCountDuringUpstream = leasesDuringUpstream?.size; const leaseOwnerDuringUpstream = [...leasesDuringUpstream.values()][0].ownerId; const countDuringUpstream = broker.admission.activeCount; finishUpstream(); await reading;
  assert.equal(leaseDuringReload, false); assert.equal(countDuringReload, 1); assert.equal(leaseCountDuringUpstream, 1); assert.equal(leaseOwnerDuringUpstream, ownerId); assert.equal(countDuringUpstream, 1); assert.deepEqual(writes.at(-1)?.result, { ok: true }); assert.equal(broker.admission.activeCount, 0); await rm(directory, { recursive: true, force: true });
});

test('ownership preflight conversion rejects a stale token without reserving a replacement lease', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-preflight-stale-')); const ownerId = 'preflight-stale-owner'; const sessionId = 'preflight-stale-session'; const socket = { writable: true, destroyed: false, zcodeWriter: { write() {} }, destroy() {} }; const broker = newTestBroker({ endpoint: join(directory, 'broker.sock'), brokerToken: '0'.repeat(64), workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } }); const preflight = broker.admission.beginOwnershipPreflight(ownerId, sessionId); broker.admission.finishOwnershipPreflight(preflight);
  assert.throws(() => broker.admission.beginSessionRequest('session/read', sessionId, ownerId, socket, null, preflight), (error) => error?.code === 'ZCODE_TURN_ACTIVE'); assert.equal(broker.admission.activeCount, 0); assert.equal(broker.admission.activeSessionCount, 0); assert.equal(broker.admission.sessionLeases.has(sessionId), false); assert.equal(broker.admission.ownerStates.size, 0); await rm(directory, { recursive: true, force: true });
});

test('a protocol reset after ownership preflight conversion reclaims the exact operation lease', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-preflight-reset-')); const ownerId = 'preflight-reset-owner'; const sessionId = 'preflight-reset-session'; const writes = []; const socket = { writable: true, destroyed: false, zcodeWriter: { write: (line) => writes.push(JSON.parse(line)) }, destroy() {} }; const broker = newTestBroker({ endpoint: join(directory, 'broker.sock'), brokerToken: '9'.repeat(64), workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } }); broker.authenticated.add(socket); broker.socketOwnerIds.set(socket, ownerId); broker.reloadOwnership = async () => { broker.sessionOwners.set(sessionId, { ownerId, socket, claimToken: null }); }; let enterUpstream; let finishUpstream; const upstreamEntered = new Promise((resolvePromise) => { enterUpstream = resolvePromise; }); const protocol = { request: () => new Promise((resolvePromise) => { finishUpstream = resolvePromise; enterUpstream(); }), close: async () => {} }; broker.protocol = protocol;
  const reading = broker.handleLocal(socket, JSON.stringify({ id: 30, method: 'session/read', params: { sessionId } })); await upstreamEntered; assert.equal(broker.admission.activeCount, 1); assert.equal(broker.admission.sessionLeases.get(sessionId)?.size, 1); assert.equal(broker.admission.ownerStates.size, 0); const retired = broker.clearProtocolGeneration(protocol); finishUpstream({ ok: true }); await reading; await retired.closePromise;
  assert.equal(writes.at(-1)?.result, undefined); assert.equal(writes.at(-1)?.error !== undefined, true); assert.equal(broker.admission.activeCount, 0); assert.equal(broker.admission.activeSessionCount, 0); assert.equal(broker.admission.sessionLeases.has(sessionId), false); assert.equal(broker.admission.ownerStates.size, 0); await rm(directory, { recursive: true, force: true });
});

test('a release that starts during ownership reload prevents preflight conversion', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-preflight-release-race-')); const ownerId = 'preflight-release-race-owner'; const sessionId = 'preflight-release-race-session'; const writes = []; const socket = { writable: true, destroyed: false, zcodeWriter: { write: (line) => writes.push(JSON.parse(line)) }, destroy() {} }; const broker = newTestBroker({ endpoint: join(directory, 'broker.sock'), brokerToken: '8'.repeat(64), workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } }); broker.authenticated.add(socket); broker.socketOwnerIds.set(socket, ownerId); let enterReload; let finishReload; const entered = new Promise((resolvePromise) => { enterReload = resolvePromise; }); const gate = new Promise((resolvePromise) => { finishReload = resolvePromise; }); broker.reloadOwnership = async () => { enterReload(); await gate; broker.sessionOwners.set(sessionId, { ownerId, socket, claimToken: null }); }; let upstreamCalls = 0; broker.protocol = { request: async () => { upstreamCalls += 1; return { ok: true }; } };
  const reading = broker.handleLocal(socket, JSON.stringify({ id: 30, method: 'session/read', params: { sessionId } })); await entered; const releaseAdmission = broker.admission.beginOwnerRequest('broker/releaseOwner', ownerId); finishReload(); await reading; assert.equal(upstreamCalls, 0); assert.equal(writes.at(-1)?.error?.data?.pluginError?.code, 'ZCODE_TURN_ACTIVE'); assert.equal(broker.admission.activeCount, 1); broker.admission.finishOwnerRequest(releaseAdmission); assert.equal(broker.admission.activeCount, 0); assert.equal(broker.admission.sessionLeases.has(sessionId), false); await rm(directory, { recursive: true, force: true });
});

test('a completed owner release permanently fences a stale ownership reload snapshot', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-preflight-release-aba-')); const endpoint = join(directory, 'broker.sock'); const ownershipPath = `${endpoint}.owners.json`; const ownerId = 'preflight-release-aba-owner'; const sessionId = 'preflight-release-aba-session'; const writes = []; const socket = { writable: true, destroyed: false, zcodeWriter: { write: (line) => writes.push(JSON.parse(line)) }, destroy() {} }; await writeFile(ownershipPath, JSON.stringify({ version: 1, sessions: { [sessionId]: ownerId } })); const broker = newTestBroker({ endpoint, ownershipPath, brokerToken: 'a'.repeat(64), workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } }); broker.authenticated.add(socket); broker.socketOwnerIds.set(socket, ownerId); broker.ownershipStoreEstablished = true; let upstreamReads = 0; let stopCalls = 0; let stopEntered; let resumeStop; const enteredStop = new Promise((resolvePromise) => { stopEntered = resolvePromise; }); const stopGate = new Promise((resolvePromise) => { resumeStop = resolvePromise; }); broker.protocol = { request: async (method) => { if (method === 'session/stop') { stopCalls += 1; stopEntered(); await stopGate; return {}; } if (method === 'session/read') { upstreamReads += 1; return { ok: true }; } throw new Error(`unexpected ${method}`); }, cancelTurn() {} };
  const readOwnerStore = broker.readOwnerStore.bind(broker); let readCalls = 0; let staleReadEntered; let resumeStaleRead; const entered = new Promise((resolvePromise) => { staleReadEntered = resolvePromise; }); const gate = new Promise((resolvePromise) => { resumeStaleRead = resolvePromise; }); broker.readOwnerStore = async (...args) => { const loaded = await readOwnerStore(...args); readCalls += 1; if (readCalls === 1) { staleReadEntered(); await gate; } return loaded; };
  const reading = broker.handleLocal(socket, JSON.stringify({ id: 31, method: 'session/read', params: { sessionId } })); await entered; const stalePreflight = [...broker.admission.ownerStates.get(ownerId).preflights.values()][0]; const releasing = broker.handleLocal(socket, JSON.stringify({ id: 32, method: 'broker/releaseOwner', params: { excludeSessionIds: [] } })); await enteredStop; assert.equal(broker.admission.ownershipPreflightCurrent(stalePreflight), false); resumeStop(); await releasing; assert.equal(stopCalls, 1); assert.deepEqual(writes.find((frame) => frame.id === 32)?.result?.releasedSessionIds, [sessionId]); assert.equal(broker.sessionOwners.has(sessionId), false); assert.equal(Object.hasOwn(JSON.parse(await readFile(ownershipPath, 'utf8')).sessions, sessionId), false);
  resumeStaleRead(); await reading; const response = writes.find((frame) => frame.id === 31); assert.equal(upstreamReads, 0); assert.equal(response?.result, undefined); assert.equal(response?.error?.data?.pluginError?.code, 'ZCODE_TURN_ACTIVE'); assert.ok(JSON.stringify(response).length < 1024); assert.equal(broker.sessionOwners.has(sessionId), false); assert.equal(Object.hasOwn(JSON.parse(await readFile(ownershipPath, 'utf8')).sessions, sessionId), false); assert.equal(broker.admission.activeCount, 0); assert.equal(broker.admission.ownerStates.size, 0); const nextPreflight = broker.admission.beginOwnershipPreflight(ownerId, 'preflight-release-aba-next'); assert.ok(nextPreflight.generation > stalePreflight.generation); broker.admission.finishOwnershipPreflight(nextPreflight); assert.equal(broker.admission.activeCount, 0); await rm(directory, { recursive: true, force: true });
});

test('a grandfathered explicit create cannot apply an old reload snapshot after releasing its sibling', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-create-reload-revision-')); const endpoint = join(directory, 'broker.sock'); const ownershipPath = `${endpoint}.owners.json`; const ownerId = 'create-reload-revision-owner'; const siblingSessionId = 'create-reload-revision-sibling'; const createdSessionId = 'create-reload-revision-created'; const writes = []; const socket = { writable: true, destroyed: false, zcodeWriter: { write: (line) => writes.push(JSON.parse(line)) }, destroy() {} }; await writeFile(ownershipPath, JSON.stringify({ version: 1, sessions: { [siblingSessionId]: ownerId } })); const broker = newTestBroker({ endpoint, ownershipPath, brokerToken: 'c'.repeat(64), workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } }); broker.authenticated.add(socket); broker.socketOwnerIds.set(socket, ownerId); broker.ownershipStoreEstablished = true; let createCalls = 0; let stopCalls = 0; broker.protocol = { request: async (method) => { if (method === 'session/create') { createCalls += 1; return brokerCreateSnapshot(createdSessionId, directory); } if (method === 'session/stop') { stopCalls += 1; return {}; } throw new Error(`unexpected ${method}`); }, cancelTurn() {} };
  const readOwnerStore = broker.readOwnerStore.bind(broker); let readCalls = 0; let createReloadEntered; let resumeCreateReload; const entered = new Promise((resolvePromise) => { createReloadEntered = resolvePromise; }); const gate = new Promise((resolvePromise) => { resumeCreateReload = resolvePromise; }); broker.readOwnerStore = async (...args) => { const loaded = await readOwnerStore(...args); readCalls += 1; if (readCalls === 1) { createReloadEntered(); await gate; } return loaded; };
  const creating = broker.handleLocal(socket, JSON.stringify({ id: 33, method: 'session/create', params: brokerCreateParams(directory, createdSessionId) })); await entered; const releasing = broker.handleLocal(socket, JSON.stringify({ id: 34, method: 'broker/releaseOwner', params: { excludeSessionIds: [] } })); await releasing; assert.equal(stopCalls, 1); assert.deepEqual(writes.find((frame) => frame.id === 34)?.result, { releasedSessionIds: [siblingSessionId], failedSessionIds: [], deferredSessionCount: 1 }); assert.equal(broker.sessionOwners.has(siblingSessionId), false); assert.deepEqual(JSON.parse(await readFile(ownershipPath, 'utf8')).sessions, {});
  resumeCreateReload(); await creating; const createResponse = writes.find((frame) => frame.id === 33); assert.equal(createResponse?.error, undefined, JSON.stringify(createResponse)); assert.equal(createResponse?.result?.session?.sessionId, createdSessionId); assert.equal(createCalls, 1); assert.equal(broker.sessionOwners.has(siblingSessionId), false); assert.equal(broker.sessionOwners.get(createdSessionId)?.ownerId, ownerId); assert.deepEqual(JSON.parse(await readFile(ownershipPath, 'utf8')).sessions, { [createdSessionId]: ownerId }); await broker.reloadOwnership(); assert.equal(broker.sessionOwners.has(siblingSessionId), false); assert.equal(broker.sessionOwners.get(createdSessionId)?.ownerId, ownerId); assert.equal(broker.admission.activeCount, 0); await rm(directory, { recursive: true, force: true });
});

test('durable create commits cannot apply their full ownership snapshots out of order', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-create-commit-revision-')); const endpoint = join(directory, 'broker.sock'); const ownershipPath = `${endpoint}.owners.json`; const ownerA = 'create-commit-revision-owner-a'; const ownerB = 'create-commit-revision-owner-b'; const sessionA = 'create-commit-revision-session-a'; const sessionB = 'create-commit-revision-session-b'; const writesA = []; const writesB = []; const socketA = { writable: true, destroyed: false, zcodeWriter: { write: (line) => writesA.push(JSON.parse(line)) }, destroy() {} }; const socketB = { writable: true, destroyed: false, zcodeWriter: { write: (line) => writesB.push(JSON.parse(line)) }, destroy() {} }; const broker = newTestBroker({ endpoint, ownershipPath, brokerToken: 'd'.repeat(64), workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } }); for (const [socket, ownerId] of [[socketA, ownerA], [socketB, ownerB]]) { broker.authenticated.add(socket); broker.socketOwnerIds.set(socket, ownerId); } broker.reloadOwnership = async () => {}; broker.protocol = { request: async (_method, params) => brokerCreateSnapshot(params.sessionId, directory) };
  const commitOwnerMutation = broker.commitOwnerMutation.bind(broker); let committed = 0; let firstCommitEntered; let resumeFirstCommit; const entered = new Promise((resolvePromise) => { firstCommitEntered = resolvePromise; }); const gate = new Promise((resolvePromise) => { resumeFirstCommit = resolvePromise; }); broker.commitOwnerMutation = async (...args) => { const commit = await commitOwnerMutation(...args); committed += 1; if (committed === 1) { firstCommitEntered(); await gate; } return commit; };
  const creatingA = broker.handleLocal(socketA, JSON.stringify({ id: 35, method: 'session/create', params: brokerCreateParams(directory, sessionA) })); await entered; const creatingB = broker.handleLocal(socketB, JSON.stringify({ id: 36, method: 'session/create', params: brokerCreateParams(directory, sessionB) })); await creatingB; assert.equal(writesB.at(-1)?.error, undefined, JSON.stringify(writesB.at(-1))); resumeFirstCommit(); await creatingA; assert.equal(writesA.at(-1)?.error, undefined, JSON.stringify(writesA.at(-1))); assert.equal(broker.sessionOwners.get(sessionA)?.ownerId, ownerA); assert.equal(broker.sessionOwners.get(sessionB)?.ownerId, ownerB); assert.deepEqual(JSON.parse(await readFile(ownershipPath, 'utf8')).sessions, { [sessionA]: ownerA, [sessionB]: ownerB }); assert.equal(broker.admission.activeCount, 0); await rm(directory, { recursive: true, force: true });
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
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-owner-operation-siblings-')); const endpoint = join(directory, 'broker.sock'); const ownershipPath = `${endpoint}.owners.json`; const ownerId = 'owner-operation-sibling-owner'; const leasedSessionId = 'owner-operation-leased-session'; const siblingSessionId = 'owner-operation-sibling-session'; const writes = []; const socket = { writable: true, destroyed: false, zcodeWriter: { write: (line) => writes.push(JSON.parse(line)) }, destroy() {} }; const broker = newTestBroker({ endpoint, brokerToken: 'c'.repeat(64), workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } }); broker.authenticated.add(socket); broker.socketOwnerIds.set(socket, ownerId); broker.sessionOwners.set(leasedSessionId, { ownerId, socket, claimToken: null }); broker.sessionOwners.set(siblingSessionId, { ownerId, socket, claimToken: null }); await writeFile(ownershipPath, JSON.stringify({ version: 1, sessions: { [leasedSessionId]: ownerId, [siblingSessionId]: ownerId } })); broker.ownershipStoreEstablished = true; broker.reloadOwnership = async () => {}; let resolveRead; const readPending = new Promise((resolvePromise) => { resolveRead = resolvePromise; }); let rejectModel; const modelPending = new Promise((_resolvePromise, rejectPromise) => { rejectModel = rejectPromise; }); let readCalls = 0; let modelCalls = 0; const protocol = { request: (method, params) => { if (method === 'session/read') { readCalls += 1; return readPending; } if (method === 'session/setModel') { modelCalls += 1; return modelPending; } return method === 'session/stop' && params.sessionId === siblingSessionId ? Promise.resolve({}) : Promise.reject(new Error(`unexpected ${method}`)); }, cancelTurn() {} }; broker.protocol = protocol; const reading = broker.handleLocal(socket, JSON.stringify({ id: 21, method: 'session/read', params: { sessionId: leasedSessionId } })); while (!readCalls) await new Promise((resolvePromise) => setImmediate(resolvePromise)); const released = await broker.releaseOwner(socket, ownerId, [], Date.now() + 2_000); assert.deepEqual(released.releasedSessionIds, [siblingSessionId]); assert.deepEqual(released.failedSessionIds, [leasedSessionId]); assert.equal(broker.sessionOwners.get(leasedSessionId)?.ownerId, ownerId); assert.equal(broker.sessionOwners.has(siblingSessionId), false); resolveRead({ ok: true }); await reading; assert.equal(broker.admission.activeSessionCount, 0);
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
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-release-settle-failure-')); const endpoint = join(directory, 'broker.sock'); const ownershipPath = `${endpoint}.owners.json`; const ownerId = 'release-settle-failure-owner'; const sessionId = 'release-settle-failure-session'; const writes = []; const socket = { writable: true, destroyed: false, zcodeWriter: { write: (line) => writes.push(JSON.parse(line)) }, destroy() {} }; const broker = newTestBroker({ endpoint, brokerToken: 'f'.repeat(64), workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } }); broker.sessionOwners.set(sessionId, { ownerId, socket, claimToken: null }); const activeTurn = { socket, token: 'release-settle-failure-turn', baseline: 1, inputId: 'release-settle-failure-input' }; broker.activeSessionSockets.set(sessionId, activeTurn); broker.activeSessions.add(sessionId); await writeFile(ownershipPath, JSON.stringify({ version: 1, sessions: { [sessionId]: ownerId } })); broker.ownershipStoreEstablished = true; const permission = broker.requestPermission({ requestId: 'release-settle-failure-permission', sessionId, options: [{ response: { decision: 'allow' } }, { response: { decision: 'deny' } }] }); let permissionSettled = false; permission.finally(() => { permissionSettled = true; }).catch(() => {}); const settleError = new Error('local settlement failed'); const protocolTurns = new Set([sessionId]); let cancelCalls = 0; broker.protocol = { request: async () => ({}), cancelTurn: () => { cancelCalls += 1; if (cancelCalls === 1) throw settleError; protocolTurns.delete(sessionId); } };
  await assert.rejects(broker.releaseOwner(socket, ownerId, []), (error) => error === settleError); await new Promise((resolvePromise) => setImmediate(resolvePromise)); assert.equal(broker.stoppingSessions.has(sessionId), false); assert.equal(broker.activeSessionSockets.get(sessionId), activeTurn); assert.equal(broker.activeSessions.has(sessionId), true); assert.equal(protocolTurns.has(sessionId), true); assert.equal(broker.permissionPending.size, 1); assert.equal(permissionSettled, false); assert.equal(broker.sessionOwners.get(sessionId)?.ownerId, ownerId); assert.equal(JSON.parse(await readFile(ownershipPath, 'utf8')).sessions[sessionId], ownerId); const retried = await broker.releaseOwner(socket, ownerId, []); assert.deepEqual(retried.releasedSessionIds, [sessionId]); assert.equal(cancelCalls, 2); assert.equal(protocolTurns.has(sessionId), false); assert.equal(broker.activeSessionSockets.has(sessionId), false); assert.equal(broker.activeSessions.has(sessionId), false); assert.equal(broker.permissionPending.size, 0); assert.deepEqual(await permission, { decision: 'deny' }); assert.equal(broker.sessionOwners.has(sessionId), false); assert.deepEqual(JSON.parse(await readFile(ownershipPath, 'utf8')).sessions, {}); await rm(directory, { recursive: true, force: true });
});

test('owner release registers every acknowledged batch stop before local settlement', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-release-batch-fences-')); const endpoint = join(directory, 'broker.sock'); const ownershipPath = `${endpoint}.owners.json`; const ownerId = 'release-batch-fence-owner'; const sessionIds = ['release-batch-session-a', 'release-batch-session-b']; const socket = { writable: true, destroyed: false, zcodeWriter: { write() {} }, destroy() {} }; const broker = newTestBroker({ endpoint, brokerToken: '1'.repeat(64), workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } }); const sessions = Object.fromEntries(sessionIds.map((sessionId) => [sessionId, ownerId])); for (const sessionId of sessionIds) { broker.sessionOwners.set(sessionId, { ownerId, socket, claimToken: null }); broker.activeSessionSockets.set(sessionId, { socket, token: `release-batch-turn-${sessionId}`, baseline: 1, inputId: `release-batch-input-${sessionId}` }); broker.activeSessions.add(sessionId); } await writeFile(ownershipPath, JSON.stringify({ version: 1, sessions })); broker.ownershipStoreEstablished = true; const settleError = new Error('first local settlement failed'); let cancelCalls = 0; broker.protocol = { request: async () => ({}), cancelTurn: () => { cancelCalls += 1; if (cancelCalls === 1) throw settleError; } };
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
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-release-unknown-winner-')); const endpoint = join(directory, 'broker.sock'); const ownershipPath = `${endpoint}.owners.json`; const ownerId = 'release-unknown-winner-owner'; const sessionId = 'release-unknown-winner-session'; const socket = { writable: true, destroyed: false, zcodeWriter: { write() {} }, destroy() {} }; const broker = newTestBroker({ endpoint, brokerToken: '7'.repeat(64), workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } }); broker.sessionOwners.set(sessionId, { ownerId, socket, claimToken: null }); await writeFile(ownershipPath, JSON.stringify({ version: 1, sessions: { [sessionId]: ownerId } })); broker.ownershipStoreEstablished = true; const commitError = new Error('owner commit acknowledgement lost'); const recoveryError = new Error('durable winner temporarily unreadable'); const readOwnerStore = broker.readOwnerStore.bind(broker); const readOwnerStoreUnlocked = broker.readOwnerStoreUnlocked.bind(broker); broker.writeOwnerStore = async (sessions) => { await atomicWriteJson(ownershipPath, { version: 1, sessions }); throw commitError; }; broker.readOwnerStore = async () => { throw recoveryError; }; broker.readOwnerStoreUnlocked = async () => { throw recoveryError; };
  await assert.rejects(broker.releaseOwner(socket, ownerId, []), (error) => error === commitError); assert.equal(broker.sessionOwners.get(sessionId)?.ownerId, ownerId); assert.deepEqual(JSON.parse(await readFile(ownershipPath, 'utf8')).sessions, {}); broker.readOwnerStore = readOwnerStore; broker.readOwnerStoreUnlocked = readOwnerStoreUnlocked; await broker.reloadOwnership(); assert.equal(broker.sessionOwners.has(sessionId), false); await rm(directory, { recursive: true, force: true });
});

test('broker release entry bounds ownership reload inside the absolute release budget', { timeout: 3_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-release-entry-budget-')); const endpoint = join(directory, 'broker.sock'); const ownershipPath = `${endpoint}.owners.json`; const ownerId = 'release-entry-budget-owner'; const sessionId = 'release-entry-budget-session'; const writes = []; const socket = { writable: true, destroyed: false, zcodeWriter: { write: (line) => writes.push(JSON.parse(line)) }, destroy() {} }; const broker = newTestBroker({ endpoint, brokerToken: '3'.repeat(64), workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } }); broker.authenticated.add(socket); broker.socketOwnerIds.set(socket, ownerId); broker.sessionOwners.set(sessionId, { ownerId, socket, claimToken: null }); await writeFile(ownershipPath, JSON.stringify({ version: 1, sessions: { [sessionId]: ownerId } })); broker.ownershipStoreEstablished = true;
  let releaseLock; let lockEntered; const gate = new Promise((resolvePromise) => { releaseLock = resolvePromise; }); const entered = new Promise((resolvePromise) => { lockEntered = resolvePromise; }); const holder = withFileLock(`${ownershipPath}.lock`, async () => { lockEntered(); await gate; }); await entered; const started = Date.now(); const handling = broker.handleLocal(socket, JSON.stringify({ id: 77, method: 'broker/releaseOwner', params: { excludeSessionIds: [] } })); let outcome;
  try { outcome = await Promise.race([handling.then(() => ({ handled: true })), new Promise((resolvePromise) => setTimeout(() => resolvePromise({ timeout: true }), 850))]); } finally { releaseLock(); await holder; }
  await handling; assert.equal(outcome.timeout, undefined, 'real broker/releaseOwner entry exceeded its absolute reload budget'); assert.ok(Date.now() - started < 1_000); assert.equal(writes.at(-1).error?.data?.pluginError?.code, 'ZCODE_OWNER_RELEASE_TIMEOUT'); assert.equal(broker.sessionOwners.get(sessionId)?.ownerId, ownerId); await rm(directory, { recursive: true, force: true });
});

test('broker release entry aborts a stalled owner-store read inside its absolute budget', { timeout: 3_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-release-read-budget-')); const endpoint = join(directory, 'broker.sock'); const ownershipPath = `${endpoint}.owners.json`; const ownerId = 'release-read-budget-owner'; const sessionId = 'release-read-budget-session'; const writes = []; const socket = { writable: true, destroyed: false, zcodeWriter: { write: (line) => writes.push(JSON.parse(line)) }, destroy() {} }; const broker = newTestBroker({ endpoint, brokerToken: '5'.repeat(64), workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } }); broker.authenticated.add(socket); broker.socketOwnerIds.set(socket, ownerId); broker.sessionOwners.set(sessionId, { ownerId, socket, claimToken: null }); await writeFile(ownershipPath, JSON.stringify({ version: 1, sessions: { [sessionId]: ownerId } })); broker.ownershipStoreEstablished = true; let reads = 0; broker.readOwnerStore = async (_allowMissing, options) => { reads += 1; await new Promise((resolvePromise, rejectPromise) => { options.signal.addEventListener('abort', () => rejectPromise(options.signal.reason), { once: true }); }); };
  const started = Date.now(); await withTestDeadlineKeepalive(() => broker.handleLocal(socket, JSON.stringify({ id: 78, method: 'broker/releaseOwner', params: { excludeSessionIds: [] } }))); assert.equal(reads, 1); assert.ok(Date.now() - started < 850); assert.equal(writes.at(-1).error?.data?.pluginError?.code, 'ZCODE_OWNER_RELEASE_TIMEOUT'); assert.equal(broker.sessionOwners.get(sessionId)?.ownerId, ownerId); await rm(directory, { recursive: true, force: true });
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

test('owner release caller preserves a continuation that settles before its deadline check after an event-loop stall', { timeout: 3_000 }, async (t) => {
  for (const outcome of ['success', 'error']) await t.test(outcome, async () => {
    const directory = await mkdtemp(join(tmpdir(), `zcode-broker-release-late-${outcome}-`)); const broker = newTestBroker({ endpoint: join(directory, 'broker.sock'), brokerToken: '8'.repeat(64), workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } }); const ownerId = `release-late-${outcome}-owner`; const socket = { destroyed: false }; const continuationError = new Error('ready continuation error must survive the deadline check');
    broker.releaseOwnerAdmitted = async () => { await new Promise((resolvePromise) => setImmediate(resolvePromise)); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 620); if (outcome === 'error') throw continuationError; return { releasedSessionIds: [], failedSessionIds: [], deferredSessionCount: 0 }; };
    const started = Date.now(); const releasing = broker.releaseOwner(socket, ownerId, []); if (outcome === 'error') await assert.rejects(releasing, (error) => error === continuationError); else assert.deepEqual(await releasing, { releasedSessionIds: [], failedSessionIds: [], deferredSessionCount: 0 }); const elapsed = Date.now() - started; assert.ok(elapsed >= 600 && elapsed < 850, `ready ${outcome} did not settle in the first deadline check phase: ${elapsed}ms`); assert.equal(broker.admission.ownerStates.has(ownerId), false); assert.equal(broker.releaseTasks.size, 0); await rm(directory, { recursive: true, force: true });
  });
});

test('owner release accepts an already-scheduled durable commit after its deadline timer becomes ready', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-release-ready-commit-')); const ownerId = 'release-ready-commit-owner'; const sessionId = 'release-ready-commit-session'; const socket = { destroyed: false }; const broker = newTestBroker({ endpoint: join(directory, 'broker.sock'), brokerToken: '7'.repeat(64), workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } }); broker.sessionOwners.set(sessionId, { ownerId, socket });
  let commitScheduled; const scheduled = new Promise((resolvePromise) => { commitScheduled = resolvePromise; });
  broker.releaseOwnerAdmitted = () => new Promise((resolvePromise) => { setImmediate(() => { broker.sessionOwners.delete(sessionId); resolvePromise({ releasedSessionIds: [sessionId], failedSessionIds: [], deferredSessionCount: 0 }); }); commitScheduled(); });
  const started = Date.now(); const releasing = broker.releaseOwner(socket, ownerId, [], started + 20); await scheduled; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40);
  assert.deepEqual(await releasing, { releasedSessionIds: [sessionId], failedSessionIds: [], deferredSessionCount: 0 }); assert.equal(broker.sessionOwners.has(sessionId), false); await rm(directory, { recursive: true, force: true });
});

test('broker close awaits and reports a timed-out release continuation', { timeout: 3_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-close-release-continuation-')); const endpoint = join(directory, 'broker.sock'); const ownershipPath = `${endpoint}.owners.json`; const ownerId = 'close-release-continuation-owner'; const sessionId = 'close-release-continuation-session'; const writes = []; const socket = { writable: true, destroyed: false, zcodeWriter: { write: (line) => writes.push(JSON.parse(line)) }, destroy() { this.destroyed = true; } }; const broker = newTestBroker({ endpoint, ownershipPath, brokerToken: '3'.repeat(64), workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } }); broker.authenticated.add(socket); broker.socketOwnerIds.set(socket, ownerId); broker.sessionOwners.set(sessionId, { ownerId, socket, claimToken: null }); await writeFile(ownershipPath, JSON.stringify({ version: 1, sessions: { [sessionId]: ownerId } })); broker.ownershipStoreEstablished = true;
  let releaseProtocolClose; const protocolCloseGate = new Promise((resolvePromise) => { releaseProtocolClose = resolvePromise; }); broker.protocol = { close: () => protocolCloseGate };
  let releaseRead; const readGate = new Promise((resolvePromise) => { releaseRead = resolvePromise; }); broker.readOwnerStore = async () => { await readGate; return { exists: true, sessions: { [sessionId]: ownerId } }; };
  const handling = broker.handleLocal(socket, JSON.stringify({ id: 86, method: 'broker/releaseOwner', params: { excludeSessionIds: [] } })); await new Promise((resolvePromise) => setTimeout(resolvePromise, 700)); assert.equal(writes.find((frame) => frame.id === 86)?.error?.data?.pluginError?.code, 'ZCODE_OWNER_RELEASE_TIMEOUT');
  let closeOutcome = 'pending'; const closing = broker.close(); void closing.then(() => { closeOutcome = 'resolved'; }, () => { closeOutcome = 'rejected'; }); await new Promise((resolvePromise) => setTimeout(resolvePromise, 40)); assert.equal(closeOutcome, 'pending');
  releaseRead(); await handling; while (broker.releaseTasks.size) await new Promise((resolvePromise) => setImmediate(resolvePromise)); assert.equal(closeOutcome, 'pending'); releaseProtocolClose(); await assert.rejects(closing, { code: 'ZCODE_OWNER_RELEASE_TIMEOUT' }); assert.equal(closeOutcome, 'rejected'); assert.equal(broker.sessionOwners.get(sessionId)?.ownerId, ownerId); await rm(directory, { recursive: true, force: true });
});

test('broker closing stops new authentication and health while protocol retirement is pending', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-closing-admission-')); const endpoint = brokerEndpointFor({ dataRoot: directory, workspace: directory }); const brokerToken = 'a'.repeat(64); const broker = await newTestBroker({ endpoint, brokerToken, workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } }).start(); const existing = await createZCodeClient({ workspace: directory, brokerEndpoint: endpoint, brokerToken, ownerId: 'closing-admission-existing-owner' }); let resolveProtocolClose; const oldProtocol = { close: () => new Promise((resolvePromise) => { resolveProtocolClose = resolvePromise; }) }; broker.protocol = oldProtocol; let lateClient; let closing;
  try {
    closing = broker.close(); let closeSettled = false; void closing.finally(() => { closeSettled = true; }).catch(() => {}); await new Promise((resolvePromise) => setImmediate(resolvePromise)); assert.equal(closeSettled, false); const lateOutcome = await Promise.race([createZCodeClient({ workspace: directory, brokerEndpoint: endpoint, brokerToken, ownerId: 'closing-admission-late-owner', requestTimeoutMs: 100 }).then(async (client) => { lateClient = client; return { status: 'fulfilled', health: await client.brokerCapabilities(100) }; }, (error) => ({ status: 'rejected', error })), new Promise((resolvePromise) => setTimeout(() => resolvePromise({ status: 'timeout' }), 300))]); await lateClient?.close().catch(() => {}); lateClient = null; assert.equal(lateOutcome.status, 'rejected'); assert.equal(closeSettled, false); resolveProtocolClose(); await closing; assert.equal(closeSettled, true); assert.equal(broker.server, null); assert.equal(broker.sockets.size, 0);
  } finally { await lateClient?.close().catch(() => {}); await existing.close().catch(() => {}); resolveProtocolClose?.(); await closing?.catch(() => {}); await broker.close().catch(() => {}); await rm(directory, { recursive: true, force: true }); }
});

test('broker release entry aborts a stalled owner-store write and keeps ownership retryable', { timeout: 3_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-release-write-budget-')); const endpoint = join(directory, 'broker.sock'); const ownershipPath = `${endpoint}.owners.json`; const ownerId = 'release-write-budget-owner'; const sessionId = 'release-write-budget-session'; const writes = []; const socket = { writable: true, destroyed: false, zcodeWriter: { write: (line) => writes.push(JSON.parse(line)) }, destroy() {} }; const broker = newTestBroker({ endpoint, brokerToken: '6'.repeat(64), workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } }); broker.authenticated.add(socket); broker.socketOwnerIds.set(socket, ownerId); broker.sessionOwners.set(sessionId, { ownerId, socket, claimToken: null }); await writeFile(ownershipPath, JSON.stringify({ version: 1, sessions: { [sessionId]: ownerId } })); broker.ownershipStoreEstablished = true; let writeAttempts = 0; let releaseContinuation; const continuationGate = new Promise((resolvePromise) => { releaseContinuation = resolvePromise; }); broker.writeOwnerStore = async (_sessions, options) => { writeAttempts += 1; try { await new Promise((resolvePromise, rejectPromise) => { options.signal.addEventListener('abort', () => rejectPromise(options.signal.reason), { once: true }); }); } finally { await continuationGate; } };
  try {
    const started = Date.now(); await withTestDeadlineKeepalive(() => broker.handleLocal(socket, JSON.stringify({ id: 79, method: 'broker/releaseOwner', params: { excludeSessionIds: [] } }))); assert.equal(writeAttempts, 1); assert.ok(Date.now() - started < 850); assert.equal(writes.at(-1).error?.data?.pluginError?.code, 'ZCODE_OWNER_RELEASE_TIMEOUT'); assert.equal(broker.sessionOwners.get(sessionId)?.ownerId, ownerId); assert.equal(JSON.parse(await readFile(ownershipPath, 'utf8')).sessions[sessionId], ownerId); assert.equal(broker.stoppingSessions.has(sessionId), true, 'caller timeout must not imply tracked continuation cleanup'); releaseContinuation(); while (broker.releaseTasks.size) await new Promise((resolvePromise) => setImmediate(resolvePromise)); assert.equal(broker.stoppingSessions.has(sessionId), false);
  } finally { releaseContinuation(); await Promise.allSettled([...broker.releaseTasks]); await rm(directory, { recursive: true, force: true }); }
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

test('permission without an exact active turn is denied without a local request', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-permission-no-turn-')); const writes = []; const broker = newTestBroker({ endpoint: join(directory, 'broker.sock'), brokerToken: 'a'.repeat(64), workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } }); const sessionId = 'permission-no-turn-session'; const socket = { writable: true, zcodeWriter: { write: (line) => writes.push(JSON.parse(line)) }, destroy() {} }; broker.sessionOwners.set(sessionId, { ownerId: 'permission-no-turn-owner', socket, claimToken: null }); const request = { requestId: 'permission-no-turn-request', sessionId, options: [{ response: { decision: 'allow' } }, { response: { decision: 'deny' } }] }; const permission = broker.requestPermission(request);
  try { assert.equal(broker.permissionPending.size, 0); assert.deepEqual(writes, []); assert.deepEqual(await permission, { decision: 'deny' }); } finally { broker.settleStoppedSession(sessionId, undefined); await permission; await rm(directory, { recursive: true, force: true }); }
});

test('protocol reset retires pending permissions so exact late responses do not destroy the multiplexed socket', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-permission-reset-')); const writes = []; let ownerDestroyed = 0; let attackerDestroyed = 0; const broker = newTestBroker({ endpoint: join(directory, 'broker.sock'), brokerToken: '4'.repeat(64), workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } }); const ownerSocket = { writable: true, zcodeWriter: { write: (line) => writes.push(JSON.parse(line)) }, destroy: () => { ownerDestroyed += 1; } }; const attackerSocket = { ...ownerSocket, destroy: () => { attackerDestroyed += 1; } }; broker.authenticated.add(ownerSocket); broker.authenticated.add(attackerSocket); const protocol = {}; broker.protocol = protocol; broker.activeSessionSockets.set('permission-reset-session', { socket: ownerSocket, token: 'permission-reset-turn' }); const request = { requestId: 'permission-reset-request', sessionId: 'permission-reset-session', options: [{ response: { decision: 'allow' } }, { response: { decision: 'deny' } }] }; const permission = broker.requestPermission(request); const permissionId = writes.at(-1).id;
  broker.clearProtocolGeneration(protocol); assert.deepEqual(await permission, { decision: 'deny' }); await broker.handleLocal(attackerSocket, JSON.stringify({ id: permissionId, result: { decision: 'allow' } })); assert.equal(attackerDestroyed, 1); await broker.handleLocal(ownerSocket, JSON.stringify({ id: permissionId, result: { decision: 'allow' } })); assert.equal(ownerDestroyed, 0); await broker.handleLocal(ownerSocket, JSON.stringify({ id: permissionId + 999, result: { decision: 'allow' } })); assert.equal(ownerDestroyed, 1); await rm(directory, { recursive: true, force: true });
});

test('a late stop acknowledgement is a no-op for every newer generation side effect', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-stop-generation-')); const writes = [];
  const broker = newTestBroker({ endpoint: join(directory, 'broker.sock'), brokerToken: '8'.repeat(64), workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } });
  const oldSocket = { writable: true, zcodeWriter: { write: (line) => writes.push(JSON.parse(line)) }, destroy() {} }; const newSocket = { ...oldSocket }; broker.authenticated.add(oldSocket); broker.authenticated.add(newSocket);
  const request = { requestId: 'old-request', sessionId: 'shared-session', options: [{ response: { decision: 'allow' } }, { response: { decision: 'deny' } }] };
  const oldTurn = { socket: oldSocket, token: 'old-turn' }; broker.activeSessionSockets.set(request.sessionId, oldTurn); const oldPermission = broker.requestPermission(request);
  const newTurn = { socket: newSocket, token: 'new-turn' }; broker.activeSessionSockets.set(request.sessionId, newTurn); const newPermission = broker.requestPermission({ ...request, requestId: 'new-request' }); let oldSettled = false; let newSettled = false; oldPermission.finally(() => { oldSettled = true; }).catch(() => {}); newPermission.finally(() => { newSettled = true; }).catch(() => {});
  assert.equal(broker.settleStoppedSession(request.sessionId, oldTurn), false); await new Promise((resolve) => setImmediate(resolve)); assert.equal(oldSettled, false); assert.equal(newSettled, false); assert.equal(broker.activeSessionSockets.get(request.sessionId), newTurn); assert.equal(writes.some((frame) => frame.method === 'broker/sessionStopped'), false);
  const oldId = writes.find((frame) => frame.params?.requestId === 'old-request').id; const newId = writes.find((frame) => frame.params?.requestId === 'new-request').id; await broker.handleLocal(oldSocket, JSON.stringify({ id: oldId, result: { decision: 'allow' } })); await broker.handleLocal(newSocket, JSON.stringify({ id: newId, result: { decision: 'allow' } })); assert.deepEqual(await oldPermission, { decision: 'allow' }); assert.deepEqual(await newPermission, { decision: 'allow' });
  await rm(directory, { recursive: true, force: true });
});

test('public cleanup releases two owners concurrently and clears both durable mappings', { timeout: 5_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-managed-release-concurrent-')); const record = join(directory, 'calls.jsonl'); const gate = join(directory, 'stop.gate'); const launch = { command: process.execPath, args: [fixture], target: fixture }; const ownerA = 'managed-release-concurrent-owner-a'; const ownerB = 'managed-release-concurrent-owner-b'; const sessionA = 'managed-release-concurrent-session-a'; const sessionB = 'managed-release-concurrent-session-b'; let identity; let releases = [];
  try {
    await writeFile(gate, 'hold'); const env = { ...process.env, FAKE_ZCODE_RECORD: record, FAKE_ZCODE_STOP_GATE: gate }; const clientA = await createManagedZCodeClient({ dataRoot: directory, workspace: directory, launch, ownerId: ownerA, env }); await clientA.createSession({ workspace: directory, sessionId: sessionA }); await clientA.close(); const clientB = await createManagedZCodeClient({ dataRoot: directory, workspace: directory, launch, ownerId: ownerB, env }); await clientB.createSession({ workspace: directory, sessionId: sessionB }); await clientB.close(); const storage = await resolveWorkspaceStorage({ dataRoot: directory, workspace: directory }); const ownershipPath = join(storage.directory, 'broker', 'session-owners.json'); identity = JSON.parse(await readFile(join(storage.directory, 'broker', 'identity.json'), 'utf8')); const requestTimeoutMs = process.platform === 'win32' ? 2_000 : 750; releases = [releaseManagedZCodeOwner({ dataRoot: directory, workspace: directory, ownerId: ownerA, requestTimeoutMs }), releaseManagedZCodeOwner({ dataRoot: directory, workspace: directory, ownerId: ownerB, requestTimeoutMs })]; const deadline = Date.now() + 200; let stopCalls; while (Date.now() < deadline && (stopCalls = (await readRecordedCalls(record)).filter((call) => call.method === 'session/stop').length) < 2) await new Promise((resolvePromise) => setTimeout(resolvePromise, 5)); stopCalls = (await readRecordedCalls(record)).filter((call) => call.method === 'session/stop').length; assert.equal(stopCalls, 2, 'different owner releases must enter stop concurrently before either gate opens'); await writeFile(gate, 'release'); const results = await Promise.all(releases); assert.deepEqual(results.map((result) => result.releasedSessionIds.sort()).sort(), [[sessionA], [sessionB]].sort()); assert.deepEqual(JSON.parse(await readFile(ownershipPath, 'utf8')).sessions, {});
  } finally { await writeFile(gate, 'release').catch(() => {}); await Promise.allSettled(releases); if (identity?.pid && processAlive(identity.pid)) try { process.kill(identity.pid, 'SIGTERM'); } catch { /* already exited */ } if (identity?.pid) await waitForProcessExit(identity.pid); await rm(directory, { recursive: true, force: true }); }
});

test('managed owner cleanup authenticates and verifies each broker once before release', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-managed-release-single-probe-')); const methods = []; let closeServer;
  try {
    const storage = await resolveWorkspaceStorage({ dataRoot: directory, workspace: directory }); const endpoint = brokerEndpointFor({ dataRoot: directory, workspace: storage.workspacePath }); const record = { endpoint, pid: process.pid, instanceId: '3'.repeat(48), brokerToken: '4'.repeat(64) }; closeServer = await createHealthOnlyServer(endpoint, { ...record, onMethod: (method) => methods.push(method) }); await writeBrokerIdentity(join(storage.directory, 'broker', 'identity.json'), record);
    assert.deepEqual(await releaseManagedZCodeOwner({ dataRoot: directory, workspace: directory, ownerId: 'managed-release-single-probe-owner', requestTimeoutMs: 500 }), { releasedSessionIds: [], failedSessionIds: [], deferredSessionCount: 0 });
    assert.deepEqual(methods, ['broker/auth', 'broker/health', 'broker/releaseOwner']);
  } finally { await closeServer?.(); await rm(directory, { recursive: true, force: true }); }
});

test('managed owner cleanup accepts a real-socket release proof already ready at its deadline', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-managed-release-ready-response-')); const methods = []; let closeServer; let markReleaseReady;
  const releaseReady = new Promise((resolvePromise) => { markReleaseReady = resolvePromise; });
  try {
    const storage = await resolveWorkspaceStorage({ dataRoot: directory, workspace: directory }); const endpoint = brokerEndpointFor({ dataRoot: directory, workspace: storage.workspacePath }); const record = { endpoint, pid: process.pid, instanceId: '8'.repeat(48), brokerToken: '9'.repeat(64) }; closeServer = await createHealthOnlyServer(endpoint, { ...record, deferRelease: true, onReleaseReady: markReleaseReady, onMethod: (method) => methods.push(method) }); await writeBrokerIdentity(join(storage.directory, 'broker', 'identity.json'), record);
    const releasing = releaseManagedZCodeOwner({ dataRoot: directory, workspace: directory, ownerId: 'managed-release-ready-response-owner', requestTimeoutMs: 20, cleanupBudgetMs: 100 }); await releaseReady;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40);
    assert.deepEqual(await releasing, { releasedSessionIds: [], failedSessionIds: [], deferredSessionCount: 0 }); assert.deepEqual(methods, ['broker/auth', 'broker/health', 'broker/releaseOwner']);
  } finally { await closeServer?.(); await rm(directory, { recursive: true, force: true }); }
});

test('managed owner cleanup rejects a live broker whose health identity mismatches the exact record', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-managed-release-identity-mismatch-')); const methods = []; let closeServer;
  try {
    const storage = await resolveWorkspaceStorage({ dataRoot: directory, workspace: directory }); const endpoint = brokerEndpointFor({ dataRoot: directory, workspace: storage.workspacePath }); const record = { endpoint, pid: process.pid, instanceId: '5'.repeat(48), brokerToken: '6'.repeat(64) }; closeServer = await createHealthOnlyServer(endpoint, { ...record, instanceId: '7'.repeat(48), onMethod: (method) => methods.push(method) }); await writeBrokerIdentity(join(storage.directory, 'broker', 'identity.json'), record);
    await assert.rejects(releaseManagedZCodeOwner({ dataRoot: directory, workspace: directory, ownerId: 'managed-release-identity-mismatch-owner', requestTimeoutMs: 500 }), (error) => error?.code === 'ZCODE_OWNER_RELEASE_INCOMPLETE' && error.details?.identityStatusCounts?.unhealthy === 1);
    assert.deepEqual(methods, ['broker/auth', 'broker/health']);
  } finally { await closeServer?.(); await rm(directory, { recursive: true, force: true }); }
});

test('managed owner cleanup reports a verified-profile disconnect instead of empty success', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-managed-release-health-race-')); let closeServer;
  try {
    const storage = await resolveWorkspaceStorage({ dataRoot: directory, workspace: directory }); const endpoint = brokerEndpointFor({ dataRoot: directory, workspace: storage.workspacePath }); const record = { endpoint, pid: process.pid, instanceId: '7'.repeat(48), brokerToken: '8'.repeat(64) }; closeServer = await createHealthOnlyServer(endpoint, { ...record, hangRelease: true }); await writeBrokerIdentity(join(storage.directory, 'broker', 'identity.json'), record); await assert.rejects(releaseManagedZCodeOwner({ dataRoot: directory, workspace: directory, ownerId: 'managed-release-health-race-owner', requestTimeoutMs: 100 }), { code: 'ZCODE_OWNER_RELEASE_INCOMPLETE' });
  } finally { await closeServer?.(); await rm(directory, { recursive: true, force: true }); }
});

test('managed owner cleanup cannot report success without one verified broker health proof', { timeout: 4_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-managed-release-proof-')); const methods = []; let closeServer;
  try {
    const storage = await resolveWorkspaceStorage({ dataRoot: directory, workspace: directory }); const endpoint = brokerEndpointFor({ dataRoot: directory, workspace: storage.workspacePath }); const record = { endpoint, pid: process.pid, instanceId: '9'.repeat(48), brokerToken: 'a'.repeat(64) }; closeServer = await createHealthOnlyServer(endpoint, { ...record, hangHealth: true, onMethod: (method) => methods.push(method) }); await writeBrokerIdentity(join(storage.directory, 'broker', 'identity.json'), record); await assert.rejects(releaseManagedZCodeOwner({ dataRoot: directory, workspace: directory, ownerId: 'managed-release-proof-owner', requestTimeoutMs: 1_800 }), (error) => { assert.equal(error?.code, 'ZCODE_OWNER_RELEASE_INCOMPLETE'); assert.deepEqual(error.details?.identityStatusCounts, { unhealthy: 1 }); return true; }); assert.equal(methods.filter((method) => method === 'broker/auth').length, 1); assert.equal(methods.filter((method) => method === 'broker/health').length, 1); assert.equal(methods.includes('broker/releaseOwner'), false);
  } finally { await closeServer?.(); await rm(directory, { recursive: true, force: true }); }
});

test('managed owner cleanup honors a caller-shortened shared deadline', { timeout: 2_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-managed-release-short-budget-')); const methods = []; let closeServer;
  try {
    const storage = await resolveWorkspaceStorage({ dataRoot: directory, workspace: directory }); const endpoint = brokerEndpointFor({ dataRoot: directory, workspace: storage.workspacePath }); const record = { endpoint, pid: process.pid, instanceId: '4'.repeat(48), brokerToken: '5'.repeat(64) }; closeServer = await createHealthOnlyServer(endpoint, { ...record, hangHealth: true, onMethod: (method) => methods.push(method) }); await writeBrokerIdentity(join(storage.directory, 'broker', 'identity.json'), record); const started = Date.now(); await assert.rejects(releaseManagedZCodeOwner({ dataRoot: directory, workspace: directory, ownerId: 'managed-release-short-budget-owner', requestTimeoutMs: 1_800, cleanupBudgetMs: 200 }), (error) => error?.code === 'ZCODE_OWNER_RELEASE_INCOMPLETE' && error.details?.identityStatusCounts?.unhealthy === 1); assert.ok(Date.now() - started < 750, 'caller-shortened cleanup exceeded its shared deadline'); assert.equal(methods.filter((method) => method === 'broker/health').length, 1); assert.equal(methods.includes('broker/releaseOwner'), false);
  } finally { await closeServer?.(); await rm(directory, { recursive: true, force: true }); }
});

test('managed owner cleanup bounds its initial identity health probe by the caller deadline', { timeout: 2_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-managed-release-health-budget-')); const methods = []; let closeServer;
  try {
    const storage = await resolveWorkspaceStorage({ dataRoot: directory, workspace: directory }); const endpoint = brokerEndpointFor({ dataRoot: directory, workspace: storage.workspacePath }); const record = { endpoint, pid: process.pid, instanceId: '6'.repeat(48), brokerToken: '7'.repeat(64) }; closeServer = await createHealthOnlyServer(endpoint, { ...record, hangHealth: true, onMethod: (method) => methods.push(method) }); await writeBrokerIdentity(join(storage.directory, 'broker', 'identity.json'), record); const started = Date.now(); await assert.rejects(releaseManagedZCodeOwner({ dataRoot: directory, workspace: directory, ownerId: 'managed-release-health-budget-owner', requestTimeoutMs: 1_800, cleanupBudgetMs: 200 }), (error) => error?.code === 'ZCODE_OWNER_RELEASE_INCOMPLETE' && error.details?.identityStatusCounts?.unhealthy === 1); assert.ok(Date.now() - started < 750, 'identity health probe exceeded the caller cleanup deadline'); assert.equal(methods.filter((method) => method === 'broker/health').length, 1); assert.equal(methods.includes('broker/releaseOwner'), false);
  } finally { await closeServer?.(); await rm(directory, { recursive: true, force: true }); }
});

test('managed owner cleanup bounds its single authentication inside the shared deadline', { timeout: 4_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-managed-release-auth-budget-')); const methods = []; let closeServer; let cleanup;
  try {
    const storage = await resolveWorkspaceStorage({ dataRoot: directory, workspace: directory }); const endpoint = brokerEndpointFor({ dataRoot: directory, workspace: storage.workspacePath }); const record = { endpoint, pid: process.pid, instanceId: 'b'.repeat(48), brokerToken: 'c'.repeat(64) }; closeServer = await createHealthOnlyServer(endpoint, { ...record, hangAuth: true, onMethod: (method) => methods.push(method) }); await writeBrokerIdentity(join(storage.directory, 'broker', 'identity.json'), record); const started = Date.now(); cleanup = releaseManagedZCodeOwner({ dataRoot: directory, workspace: directory, ownerId: 'managed-release-auth-budget-owner', requestTimeoutMs: 3_600_000 }); const timeout = Symbol('cleanup-timeout'); const outcome = await Promise.race([cleanup.then(() => ({ status: 'fulfilled' }), (error) => ({ status: 'rejected', error })), new Promise((resolvePromise) => setTimeout(() => resolvePromise(timeout), 2_300))]); if (outcome === timeout) { await closeServer(); closeServer = null; await cleanup.catch(() => {}); assert.fail('owner cleanup exceeded its shared deadline during broker authentication'); } assert.equal(outcome.status, 'rejected'); assert.equal(outcome.error?.code, 'ZCODE_OWNER_RELEASE_INCOMPLETE'); assert.deepEqual(outcome.error?.details?.identityStatusCounts, { unhealthy: 1 }); assert.ok(Date.now() - started < 2_200); assert.equal(methods.filter((method) => method === 'broker/auth').length, 1); assert.equal(methods.includes('broker/releaseOwner'), false);
  } finally { await closeServer?.(); await cleanup?.catch(() => {}); await rm(directory, { recursive: true, force: true }); }
});

test('owner release uses the same exact-session stop notification without disconnecting the client', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-release-active-')); const endpoint = brokerEndpointFor({ dataRoot: directory, workspace: directory }); const brokerToken = 'a'.repeat(64); const ownerId = 'release-active-owner-stable';
  const broker = await newTestBroker({ endpoint, brokerToken, workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture }, env: { ...process.env, FAKE_ZCODE_SUPPRESS_FIRST_COMPLETION: '1' } }).start();
  const worker = await createZCodeClient({ workspace: directory, brokerEndpoint: endpoint, brokerToken, ownerId, completionTimeoutMs: 1_000 }); const controller = await createZCodeClient({ workspace: directory, brokerEndpoint: endpoint, brokerToken, ownerId });
  try { const sessionId = (await worker.createSession({ workspace: directory })).session.sessionId; const subscription = await worker.subscribeConversation(sessionId, { connectionId: 'release-owner-connection', clientMode: 'desktop-continuous' }); await worker.send(sessionId, 'hold'); const stopped = assert.rejects(worker.waitForCompletion(sessionId), { code: 'ZCODE_SESSION_STOPPED' }); let fencedDuringApply = false; const settleStoppedSession = broker.settleStoppedSession.bind(broker); broker.settleStoppedSession = (...args) => { fencedDuringApply = broker.stoppingSessions.has(sessionId); return settleStoppedSession(...args); }; const released = await controller.releaseOwner([]); assert.deepEqual(released.releasedSessionIds, [sessionId]); await stopped; assert.equal(fencedDuringApply, true); assert.equal([...broker.conversationSubscriptions.values()].some((entry) => entry.sessionId === sessionId), false); await subscription.unsubscribe().catch(() => {}); assert.deepEqual(await controller.brokerCapabilities(), { releaseOwnerExclusions: true }); }
  finally { await worker.close(); await controller.close(); await broker.close(); await rm(directory, { recursive: true, force: true }); }
});

test('failed send protocol acquisition and binding release exact admission tokens across sessions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-send-admission-failure-')); const broker = newTestBroker({ endpoint: join(directory, 'broker.sock'), brokerToken: 'c'.repeat(64), workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } }); const ownerId = 'send-admission-failure-owner'; const writes = [];
  const socket = { writable: true, destroyed: false, zcodeWriter: { write: (line) => writes.push(JSON.parse(line)) }, destroy() {} }; broker.authenticated.add(socket); broker.socketOwnerIds.set(socket, ownerId); broker.reloadOwnership = async () => {}; broker.getProtocol = async () => { throw new Error('protocol acquisition failed'); };
  for (let index = 0; index < 300; index += 1) { if (index === 150) { const protocol = {}; broker.getProtocol = async () => protocol; broker.admission.bindSessionProtocol = () => { throw new Error('protocol binding failed'); }; } const sessionId = `send-admission-failure-session-${index}`; broker.sessionOwners.set(sessionId, { ownerId, socket, claimToken: null }); await broker.handleLocal(socket, JSON.stringify({ id: index + 1, method: 'session/send', params: { sessionId, inputId: `send-admission-input-${index}`, queryId: `send-admission-query-${index}`, content: 'must fail before protocol binding' } })); }
  assert.equal(writes.length, 300); assert.equal(writes.slice(0, 150).every((frame) => frame.error?.message === 'protocol acquisition failed'), true); assert.equal(writes.slice(150).every((frame) => frame.error?.message === 'protocol binding failed'), true); assert.equal(broker.admittingSessions.size, 0); assert.equal(broker.activeSessionSockets.size, 0); assert.equal(broker.activeSessions.size, 0); assert.equal(broker.admission.activeCount, 0); assert.equal(broker.admission.sessionLeases.size, 0); await rm(directory, { recursive: true, force: true });
});

test('successful send keeps its active route after admission cleanup', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-send-admission-success-')); const broker = newTestBroker({ endpoint: join(directory, 'broker.sock'), brokerToken: 'b'.repeat(64), workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } }); const ownerId = 'send-admission-success-owner'; const sessionId = 'send-admission-success-session'; const writes = [];
  const socket = { writable: true, destroyed: false, zcodeWriter: { write: (line) => writes.push(JSON.parse(line)) }, destroy() {} }; broker.authenticated.add(socket); broker.socketOwnerIds.set(socket, ownerId); broker.sessionOwners.set(sessionId, { ownerId, socket, claimToken: null }); broker.reloadOwnership = async () => {}; const protocol = { request: async () => ({ accepted: true, sessionId, stateRevision: 7 }), beginTurn() {}, armTurn() {}, abortTurn() {} }; broker.protocol = protocol; broker.getProtocol = async () => protocol;
  await broker.handleLocal(socket, JSON.stringify({ id: 1, method: 'session/send', params: { sessionId, inputId: 'send-admission-success-input', queryId: 'send-admission-success-query', content: 'accepted' } }));
  assert.deepEqual(writes, [{ id: 1, result: { accepted: true, sessionId, stateRevision: 7 } }]); assert.equal(broker.admittingSessions.size, 0); assert.equal(broker.activeSessionSockets.get(sessionId)?.socket, socket); assert.equal(broker.activeSessionSockets.get(sessionId)?.baseline, 7); assert.equal(broker.activeSessions.has(sessionId), true); assert.equal(broker.admission.activeCount, 0); await rm(directory, { recursive: true, force: true });
});

test('direct stop establishes its generation fence before awaiting protocol acquisition', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-stop-admission-')); const broker = newTestBroker({ endpoint: join(directory, 'broker.sock'), brokerToken: 'd'.repeat(64), workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } }); const sessionId = 'stop-admission-session'; const ownerId = 'stop-admission-owner'; const writes = [];
  const socket = { writable: true, zcodeWriter: { write: (line) => writes.push(JSON.parse(line)) }, destroy() {} }; broker.authenticated.add(socket); broker.socketOwnerIds.set(socket, ownerId); broker.sessionOwners.set(sessionId, { ownerId, socket, claimToken: null }); broker.activeSessionSockets.set(sessionId, { socket, token: 'active-generation', baseline: 1, inputId: 'input-1' });
  let entered; let release; const protocolRequested = new Promise((resolve) => { entered = resolve; }); const gate = new Promise((resolve) => { release = resolve; }); const protocol = { request: async () => ({}), cancelTurn() {} }; broker.getProtocol = async () => { entered(); await gate; broker.protocol = protocol; return protocol; };
  const stopping = broker.handleLocal(socket, JSON.stringify({ id: 1, method: 'session/stop', params: { sessionId } })); await protocolRequested;
  assert.equal(broker.stoppingSessions.get(sessionId)?.activeToken, 'active-generation'); release(); await stopping; assert.deepEqual(writes.at(-1), { id: 1, result: {} }); await rm(directory, { recursive: true, force: true });
});

test('direct stop preserves its exact turn and permission when protocol cancellation throws before retry', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-stop-cancel-retry-')); const broker = newTestBroker({ endpoint: join(directory, 'broker.sock'), brokerToken: 'e'.repeat(64), workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } }); const sessionId = 'stop-cancel-retry-session'; const ownerId = 'stop-cancel-retry-owner'; const writes = []; const socket = { writable: true, destroyed: false, zcodeWriter: { write: (line) => writes.push(JSON.parse(line)) }, destroy() {} }; broker.authenticated.add(socket); broker.socketOwnerIds.set(socket, ownerId); broker.sessionOwners.set(sessionId, { ownerId, socket, claimToken: null }); broker.reloadOwnership = async () => {}; const activeTurn = { socket, token: 'stop-cancel-retry-turn', baseline: 1, inputId: 'stop-cancel-retry-input' }; broker.activeSessionSockets.set(sessionId, activeTurn); broker.activeSessions.add(sessionId); const topic = `conversation/${sessionId}`; const subscriptionId = 'stop-cancel-retry-subscription'; const subscriptionKey = 'stop-cancel-retry-key'; const subscription = { socket, topic, subscriptionId, connectionId: 'stop-cancel-retry-connection', sessionId, ownerId }; broker.conversationSubscriptions.set(subscriptionKey, subscription); const upstreamSubscriptions = new Set([subscriptionId]); const permission = broker.requestPermission({ requestId: 'stop-cancel-retry-permission', sessionId, options: [{ response: { decision: 'allow' } }, { response: { decision: 'deny' } }] }); let permissionSettled = false; permission.finally(() => { permissionSettled = true; }).catch(() => {}); const cancelError = new Error('stop cancellation failed'); const protocolTurns = new Set([sessionId]); let cancelCalls = 0; let unsubscribeCalls = 0; const protocol = { request: async (method, params) => { if (method === 'session/stop') return {}; assert.equal(method, 'v4/conversation/unsubscribe'); unsubscribeCalls += 1; upstreamSubscriptions.delete(params.subscriptionId); return {}; }, cancelTurn: () => { cancelCalls += 1; if (cancelCalls === 1) throw cancelError; protocolTurns.delete(sessionId); } }; broker.protocol = protocol; broker.getProtocol = async () => protocol;
  await broker.handleLocal(socket, JSON.stringify({ id: 1, method: 'session/stop', params: { sessionId } })); await new Promise((resolvePromise) => setImmediate(resolvePromise)); assert.equal(writes.find((frame) => frame.id === 1)?.error?.message, cancelError.message); assert.equal(broker.activeSessionSockets.get(sessionId), activeTurn); assert.equal(broker.activeSessions.has(sessionId), true); assert.equal(protocolTurns.has(sessionId), true); assert.equal(broker.permissionPending.size, 1); assert.equal(permissionSettled, false); assert.equal(broker.conversationSubscriptions.get(subscriptionKey), subscription); assert.equal(upstreamSubscriptions.has(subscriptionId), true); assert.equal(unsubscribeCalls, 0); assert.equal(broker.stoppingSessions.has(sessionId), false);
  await broker.handleLocal(socket, JSON.stringify({ id: 2, method: 'session/stop', params: { sessionId } })); assert.deepEqual(writes.find((frame) => frame.id === 2)?.result, {}); assert.equal(cancelCalls, 2); assert.equal(protocolTurns.has(sessionId), false); assert.equal(broker.activeSessionSockets.has(sessionId), false); assert.equal(broker.activeSessions.has(sessionId), false); assert.equal(broker.permissionPending.size, 0); assert.deepEqual(await permission, { decision: 'deny' }); assert.equal(broker.conversationSubscriptions.has(subscriptionKey), false); assert.equal(upstreamSubscriptions.has(subscriptionId), false); assert.equal(unsubscribeCalls, 1); assert.equal(broker.stoppingSessions.has(sessionId), false); broker.cancelIdleShutdown(); await rm(directory, { recursive: true, force: true });
});

test('direct stop success remains authoritative when malformed conversation cleanup resets its generation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-stop-cleanup-reset-')); const broker = newTestBroker({ endpoint: join(directory, 'broker.sock'), brokerToken: 'f'.repeat(64), workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } }); const ownerId = 'stop-cleanup-reset-owner'; const sessionId = 'stop-cleanup-reset-session'; const siblingId = 'stop-cleanup-reset-sibling'; const writes = []; const socket = { writable: true, destroyed: false, zcodeWriter: { write: (line) => writes.push(JSON.parse(line)) }, destroy() {} }; broker.authenticated.add(socket); broker.socketOwnerIds.set(socket, ownerId); broker.sessionOwners.set(sessionId, { ownerId, socket }); broker.sessionOwners.set(siblingId, { ownerId, socket }); broker.reloadOwnership = async () => {}; const activeTurn = { socket, token: 'stop-cleanup-reset-turn', baseline: 1, inputId: 'stop-cleanup-reset-input' }; broker.activeSessionSockets.set(sessionId, activeTurn); broker.activeSessions.add(sessionId); const oldSubscription = { socket, topic: `conversation/${sessionId}`, subscriptionId: 'stop-cleanup-reset-subscription', connectionId: 'stop-cleanup-reset-connection', sessionId, ownerId }; broker.conversationSubscriptions.set('stop-cleanup-reset-key', oldSubscription); let cancelCalls = 0; let unsubscribeCalls = 0; let closeCalls = 0; const oldProtocol = { request: async (method) => { if (method === 'session/stop') return {}; assert.equal(method, 'v4/conversation/unsubscribe'); unsubscribeCalls += 1; return { malformed: true }; }, cancelTurn: () => { cancelCalls += 1; }, close: async () => { closeCalls += 1; } }; broker.protocol = oldProtocol; broker.getProtocol = async () => oldProtocol;
  await broker.handleLocal(socket, JSON.stringify({ id: 3, method: 'session/stop', params: { sessionId } })); assert.deepEqual(writes.find((frame) => frame.id === 3)?.result, {}); assert.equal(writes.find((frame) => frame.id === 3)?.error, undefined); assert.equal(cancelCalls, 1); assert.equal(unsubscribeCalls, 1); assert.equal(closeCalls, 1); assert.equal(broker.activeSessionSockets.has(sessionId), false); assert.equal(broker.activeSessions.has(sessionId), false); for (let index = 0; index < 20 && broker.retiredProtocolGeneration; index += 1) await new Promise((resolvePromise) => setImmediate(resolvePromise)); assert.equal(broker.retiredProtocolGeneration, null); assert.equal(broker.orphanedConversationSubscriptions.size, 0); let replacementSubscribes = 0; const replacement = { request: async () => { replacementSubscribes += 1; return { ack: { subscriptionId: 'stop-cleanup-reset-replacement', mode: 'snapshot', logEpoch: 'stop-cleanup-reset-epoch' } }; }, close: async () => {} }; broker.protocol = replacement; broker.getProtocol = async () => replacement; await broker.handleLocal(socket, JSON.stringify({ id: 4, method: 'v4/conversation/subscribe', params: { topic: `conversation/${siblingId}`, connectionId: 'stop-cleanup-reset-new-connection', clientMode: 'desktop-continuous' } })); assert.equal(writes.find((frame) => frame.id === 4)?.result?.ack?.subscriptionId, 'stop-cleanup-reset-replacement'); assert.equal(replacementSubscribes, 1); assert.equal([...broker.conversationSubscriptions.values()].every((entry) => entry.protocol === undefined && entry.sessionId === siblingId), true); await broker.close(); await rm(directory, { recursive: true, force: true });
});

test('an idle direct stop remains authoritative after terminal evidence eviction and malformed cleanup', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-stop-idle-evicted-')); const broker = newTestBroker({ endpoint: join(directory, 'broker.sock'), brokerToken: 'a'.repeat(64), workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } }); const ownerId = 'stop-idle-evicted-owner'; const sessionId = 'stop-idle-evicted-session'; const writes = []; const socket = { writable: true, destroyed: false, zcodeWriter: { write: (line) => writes.push(JSON.parse(line)) }, destroy() {} }; broker.authenticated.add(socket); broker.socketOwnerIds.set(socket, ownerId); broker.sessionOwners.set(sessionId, { ownerId, socket }); broker.reloadOwnership = async () => {}; const oldProtocol = { request: async (method) => method === 'session/stop' ? {} : { malformed: true }, cancelTurn() { throw new Error('idle stop must not cancel a turn'); }, close: async () => {} }; broker.protocol = oldProtocol; broker.getProtocol = async () => oldProtocol; const target = { token: 'evicted-terminal-token', baseline: 1, inputId: 'evicted-terminal-input' }; broker.recordTerminalWinner(sessionId, oldProtocol, target); for (let index = 0; index < 256; index += 1) broker.recordTerminalWinner(`eviction-${index}`, oldProtocol, { token: `eviction-token-${index}`, baseline: index, inputId: `eviction-input-${index}` }); assert.equal(broker.terminalWinnerEvidence.has(sessionId), false); broker.conversationSubscriptions.set('stop-idle-evicted-key', { socket, topic: `conversation/${sessionId}`, subscriptionId: 'stop-idle-evicted-subscription', connectionId: 'stop-idle-evicted-connection', sessionId, ownerId });
  await broker.handleLocal(socket, JSON.stringify({ id: 5, method: 'session/stop', params: { sessionId } })); assert.deepEqual(writes.find((frame) => frame.id === 5)?.result, {}); assert.equal(writes.find((frame) => frame.id === 5)?.error, undefined); assert.equal(broker.protocol, null); assert.equal(broker.conversationSubscriptions.size, 0); await broker.close(); await rm(directory, { recursive: true, force: true });
});

test('an authoritative direct stop survives a full orphan tombstone cap', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-stop-orphan-cap-')); const broker = newTestBroker({ endpoint: join(directory, 'broker.sock'), brokerToken: 'd'.repeat(64), workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } }); const ownerId = 'stop-orphan-cap-owner'; const sessionId = 'stop-orphan-cap-session'; const writes = []; const socket = { writable: true, destroyed: false, zcodeWriter: { write: (line) => writes.push(JSON.parse(line)) }, destroy() {} }; broker.authenticated.add(socket); broker.socketOwnerIds.set(socket, ownerId); broker.sessionOwners.set(sessionId, { ownerId, socket }); broker.reloadOwnership = async () => {}; const active = { socket, token: 'stop-orphan-cap-turn', baseline: 1, inputId: 'stop-orphan-cap-input' }; broker.activeSessionSockets.set(sessionId, active); broker.activeSessions.add(sessionId); let cancelCalls = 0; let closeCalls = 0; let unsubscribeCalls = 0; const protocol = { request: async (method) => { if (method === 'v4/conversation/unsubscribe') unsubscribeCalls += 1; return {}; }, cancelTurn: () => { cancelCalls += 1; }, close: async () => { closeCalls += 1; } }; broker.protocol = protocol; broker.getProtocol = async () => protocol; for (let index = 0; index < 255; index += 1) broker.orphanedConversationSubscriptions.set(`stop-orphan-cap-${index}`, { key: `stop-orphan-cap-${index}`, protocol, topic: `conversation/orphan-${index}`, subscriptionId: `stop-orphan-cap-sub-${index}`, connectionId: `stop-orphan-cap-connection-${index}`, sessionId: `orphan-${index}`, ownerId }); for (let index = 0; index < 2; index += 1) broker.conversationSubscriptions.set(`stop-orphan-cap-target-${index}`, { socket, topic: `conversation/${sessionId}`, subscriptionId: `stop-orphan-cap-target-sub-${index}`, connectionId: `stop-orphan-cap-target-connection-${index}`, sessionId, ownerId });
  await broker.handleLocal(socket, JSON.stringify({ id: 51, method: 'session/stop', params: { sessionId } })); for (let index = 0; index < 20 && broker.retiredProtocolGeneration; index += 1) await new Promise((resolvePromise) => setImmediate(resolvePromise)); assert.deepEqual(writes.find((frame) => frame.id === 51)?.result, {}); assert.equal(writes.find((frame) => frame.id === 51)?.error, undefined); assert.equal(cancelCalls, 1); assert.equal(unsubscribeCalls, 0); assert.equal(closeCalls, 1); assert.equal(broker.protocol, null); assert.equal(broker.conversationSubscriptions.size, 0); assert.equal(broker.orphanedConversationSubscriptions.size, 0); await broker.close(); await rm(directory, { recursive: true, force: true });
});

test('an authoritative owner release survives a full orphan tombstone cap and commits ownership', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-release-orphan-cap-')); const endpoint = join(directory, 'broker.sock'); const ownershipPath = `${endpoint}.owners.json`; const broker = newTestBroker({ endpoint, ownershipPath, brokerToken: 'e'.repeat(64), workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } }); const ownerId = 'release-orphan-cap-owner'; const sessionId = 'release-orphan-cap-session'; const socket = { writable: true, destroyed: false, zcodeWriter: { write() {} }, destroy() {} }; broker.sessionOwners.set(sessionId, { ownerId, socket }); const active = { socket, token: 'release-orphan-cap-turn', baseline: 1, inputId: 'release-orphan-cap-input' }; broker.activeSessionSockets.set(sessionId, active); broker.activeSessions.add(sessionId); await writeFile(ownershipPath, JSON.stringify({ version: 1, sessions: { [sessionId]: ownerId } })); broker.ownershipStoreEstablished = true; let cancelCalls = 0; let closeCalls = 0; const protocol = { request: async () => ({}), cancelTurn: () => { cancelCalls += 1; }, close: async () => { closeCalls += 1; } }; broker.protocol = protocol; for (let index = 0; index < 256; index += 1) broker.orphanedConversationSubscriptions.set(`release-orphan-cap-${index}`, { key: `release-orphan-cap-${index}`, protocol, topic: `conversation/orphan-${index}`, subscriptionId: `release-orphan-cap-sub-${index}`, connectionId: `release-orphan-cap-connection-${index}`, sessionId: `orphan-${index}`, ownerId }); broker.conversationSubscriptions.set('release-orphan-cap-target', { socket, topic: `conversation/${sessionId}`, subscriptionId: 'release-orphan-cap-target-sub', connectionId: 'release-orphan-cap-target-connection', sessionId, ownerId });
  const result = await broker.releaseOwner(socket, ownerId, []); for (let index = 0; index < 20 && broker.retiredProtocolGeneration; index += 1) await new Promise((resolvePromise) => setImmediate(resolvePromise)); assert.deepEqual(result.releasedSessionIds, [sessionId]); assert.deepEqual(result.failedSessionIds, []); assert.equal(cancelCalls, 1); assert.equal(closeCalls, 1); assert.equal(broker.sessionOwners.has(sessionId), false); assert.deepEqual(JSON.parse(await readFile(ownershipPath, 'utf8')).sessions, {}); assert.ok(broker.orphanedConversationSubscriptions.size <= 256); await broker.close(); await rm(directory, { recursive: true, force: true });
});

test('an in-flight direct stop keeps its exact natural terminal winner after evidence eviction', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-stop-inflight-eviction-')); const broker = newTestBroker({ endpoint: join(directory, 'broker.sock'), brokerToken: 'f'.repeat(64), workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } }); const ownerId = 'stop-inflight-eviction-owner'; const sessionId = 'stop-inflight-eviction-session'; const writes = []; const socket = { writable: true, destroyed: false, zcodeWriter: { write: (line) => writes.push(JSON.parse(line)) }, destroy() {} }; broker.authenticated.add(socket); broker.socketOwnerIds.set(socket, ownerId); broker.sessionOwners.set(sessionId, { ownerId, socket }); broker.reloadOwnership = async () => {}; const active = { socket, token: 'stop-inflight-eviction-turn', baseline: 1, inputId: 'stop-inflight-eviction-input' }; broker.activeSessionSockets.set(sessionId, active); broker.activeSessions.add(sessionId); let resolveStop; let enteredResolve; const entered = new Promise((resolvePromise) => { enteredResolve = resolvePromise; }); const protocol = { request: () => { enteredResolve(); return new Promise((resolvePromise) => { resolveStop = resolvePromise; }); }, cancelTurn() { throw new Error('natural terminal winner must not be cancelled'); } }; broker.protocol = protocol; broker.getProtocol = async () => protocol;
  const stopping = broker.handleLocal(socket, JSON.stringify({ id: 52, method: 'session/stop', params: { sessionId } })); await entered; broker.recordTerminalWinner(sessionId, protocol, active); broker.activeSessionSockets.delete(sessionId); broker.activeSessions.delete(sessionId); for (let index = 0; index < 256; index += 1) broker.recordTerminalWinner(`stop-inflight-eviction-${index}`, protocol, { token: `stop-inflight-eviction-token-${index}`, baseline: index, inputId: `stop-inflight-eviction-input-${index}` }); assert.equal(broker.terminalWinnerEvidence.has(sessionId), false); resolveStop({}); await stopping; assert.deepEqual(writes.find((frame) => frame.id === 52)?.result, {}); assert.equal(writes.find((frame) => frame.id === 52)?.error, undefined); await broker.close(); await rm(directory, { recursive: true, force: true });
});

test('an in-flight owner release keeps its exact natural terminal winner after evidence eviction', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-release-inflight-eviction-')); const endpoint = join(directory, 'broker.sock'); const ownershipPath = `${endpoint}.owners.json`; const broker = newTestBroker({ endpoint, ownershipPath, brokerToken: '1'.repeat(64), workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } }); const ownerId = 'release-inflight-eviction-owner'; const sessionId = 'release-inflight-eviction-session'; const socket = { writable: true, destroyed: false, zcodeWriter: { write() {} }, destroy() {} }; broker.sessionOwners.set(sessionId, { ownerId, socket }); const active = { socket, token: 'release-inflight-eviction-turn', baseline: 1, inputId: 'release-inflight-eviction-input' }; broker.activeSessionSockets.set(sessionId, active); broker.activeSessions.add(sessionId); await writeFile(ownershipPath, JSON.stringify({ version: 1, sessions: { [sessionId]: ownerId } })); broker.ownershipStoreEstablished = true; let resolveStop; let enteredResolve; const entered = new Promise((resolvePromise) => { enteredResolve = resolvePromise; }); const protocol = { request: () => { enteredResolve(); return new Promise((resolvePromise) => { resolveStop = resolvePromise; }); }, cancelTurn() { throw new Error('natural terminal winner must not be cancelled'); } }; broker.protocol = protocol;
  const releasing = broker.releaseOwner(socket, ownerId, []); await entered; broker.recordTerminalWinner(sessionId, protocol, active); broker.activeSessionSockets.delete(sessionId); broker.activeSessions.delete(sessionId); for (let index = 0; index < 256; index += 1) broker.recordTerminalWinner(`release-inflight-eviction-${index}`, protocol, { token: `release-inflight-eviction-token-${index}`, baseline: index, inputId: `release-inflight-eviction-input-${index}` }); assert.equal(broker.terminalWinnerEvidence.has(sessionId), false); resolveStop({}); const result = await releasing; assert.deepEqual(result.releasedSessionIds, [sessionId]); assert.deepEqual(result.failedSessionIds, []); assert.equal(broker.sessionOwners.has(sessionId), false); assert.deepEqual(JSON.parse(await readFile(ownershipPath, 'utf8')).sessions, {}); await broker.close(); await rm(directory, { recursive: true, force: true });
});

test('a stop acknowledgement cannot authorize or clean a newer active route', async (t) => {
  for (const scenario of ['idle-to-new', 'terminal-old-to-new', 'active-old-to-new']) await t.test(scenario, async () => {
    const directory = await mkdtemp(join(tmpdir(), `zcode-broker-stop-newer-${scenario}-`)); const broker = newTestBroker({ endpoint: join(directory, 'broker.sock'), brokerToken: 'b'.repeat(64), workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } }); const ownerId = `stop-newer-${scenario}-owner`; const sessionId = `stop-newer-${scenario}-session`; const writes = []; const socket = { writable: true, destroyed: false, zcodeWriter: { write: (line) => writes.push(JSON.parse(line)) }, destroy() {} }; broker.authenticated.add(socket); broker.socketOwnerIds.set(socket, ownerId); broker.sessionOwners.set(sessionId, { ownerId, socket }); broker.reloadOwnership = async () => {}; const oldTurn = { socket, token: `stop-newer-${scenario}-old`, baseline: 1, inputId: `stop-newer-${scenario}-old-input` }; if (scenario !== 'idle-to-new') { broker.activeSessionSockets.set(sessionId, oldTurn); broker.activeSessions.add(sessionId); } let resolveStop; let stopEntered; const entered = new Promise((resolvePromise) => { stopEntered = resolvePromise; }); let unsubscribeCalls = 0; const protocol = { request: (method) => { if (method === 'session/stop') { stopEntered(); return new Promise((resolvePromise) => { resolveStop = resolvePromise; }); } unsubscribeCalls += 1; return Promise.resolve({}); }, cancelTurn() { throw new Error('a newer route must not be cancelled'); } }; broker.protocol = protocol; broker.getProtocol = async () => protocol; const stopping = broker.handleLocal(socket, JSON.stringify({ id: 6, method: 'session/stop', params: { sessionId } })); await entered; if (scenario === 'terminal-old-to-new') { broker.recordTerminalWinner(sessionId, protocol, oldTurn); broker.activeSessionSockets.delete(sessionId); broker.activeSessions.delete(sessionId); } const newTurn = { socket, token: `stop-newer-${scenario}-new`, baseline: 2, inputId: `stop-newer-${scenario}-new-input` }; broker.activeSessionSockets.set(sessionId, newTurn); broker.activeSessions.add(sessionId); const subscriptionKey = `stop-newer-${scenario}-key`; const subscription = { socket, topic: `conversation/${sessionId}`, subscriptionId: `stop-newer-${scenario}-subscription`, connectionId: `stop-newer-${scenario}-connection`, sessionId, ownerId }; broker.conversationSubscriptions.set(subscriptionKey, subscription); resolveStop({}); await stopping; assert.equal(writes.find((frame) => frame.id === 6)?.result, undefined); assert.equal(writes.find((frame) => frame.id === 6)?.error?.data?.pluginError?.code, 'ZCODE_BROKER_INPUT_INVALID'); assert.equal(broker.activeSessionSockets.get(sessionId), newTurn); assert.equal(broker.activeSessions.has(sessionId), true); assert.equal(broker.conversationSubscriptions.get(subscriptionKey), subscription); assert.equal(unsubscribeCalls, 0); await rm(directory, { recursive: true, force: true });
  });
});

test('an owner release acknowledgement cannot detach a newer active route subscription', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-release-newer-route-')); const endpoint = join(directory, 'broker.sock'); const ownershipPath = `${endpoint}.owners.json`; const broker = newTestBroker({ endpoint, ownershipPath, brokerToken: 'c'.repeat(64), workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture } }); const ownerId = 'release-newer-route-owner'; const sessionId = 'release-newer-route-session'; const socket = { writable: true, destroyed: false, zcodeWriter: { write() {} }, destroy() {} }; broker.sessionOwners.set(sessionId, { ownerId, socket }); await writeFile(ownershipPath, JSON.stringify({ version: 1, sessions: { [sessionId]: ownerId } })); broker.ownershipStoreEstablished = true; const oldTurn = { socket, token: 'release-newer-route-old', baseline: 1, inputId: 'release-newer-route-old-input' }; broker.activeSessionSockets.set(sessionId, oldTurn); broker.activeSessions.add(sessionId); let resolveStop; let stopEntered; const entered = new Promise((resolvePromise) => { stopEntered = resolvePromise; }); let unsubscribeCalls = 0; const protocol = { request: (method) => { if (method === 'session/stop') { stopEntered(); return new Promise((resolvePromise) => { resolveStop = resolvePromise; }); } unsubscribeCalls += 1; return Promise.resolve({}); }, cancelTurn() { throw new Error('a newer release route must not be cancelled'); } }; broker.protocol = protocol; const releasing = broker.releaseOwner(socket, ownerId, []); await entered; const newTurn = { socket, token: 'release-newer-route-new', baseline: 2, inputId: 'release-newer-route-new-input' }; broker.activeSessionSockets.set(sessionId, newTurn); const subscriptionKey = 'release-newer-route-key'; const subscription = { socket, topic: `conversation/${sessionId}`, subscriptionId: 'release-newer-route-subscription', connectionId: 'release-newer-route-connection', sessionId, ownerId }; broker.conversationSubscriptions.set(subscriptionKey, subscription); resolveStop({}); const result = await releasing; assert.deepEqual(result.releasedSessionIds, []); assert.deepEqual(result.failedSessionIds, [sessionId]); assert.equal(broker.activeSessionSockets.get(sessionId), newTurn); assert.equal(broker.conversationSubscriptions.get(subscriptionKey), subscription); assert.equal(unsubscribeCalls, 0); assert.equal(broker.sessionOwners.get(sessionId)?.ownerId, ownerId); assert.equal(JSON.parse(await readFile(ownershipPath, 'utf8')).sessions[sessionId], ownerId); await rm(directory, { recursive: true, force: true });
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

test('a natural terminal that wins before a direct stop acknowledgement remains waitable', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-terminal-wins-stop-')); const endpoint = brokerEndpointFor({ dataRoot: directory, workspace: directory }); const brokerToken = '8'.repeat(64); const ownerId = 'terminal-wins-stop-owner'; const completionGate = join(directory, 'completion.gate'); const stopGate = join(directory, 'stop.gate'); const stopReached = join(directory, 'stop.reached'); await writeFile(completionGate, 'hold'); await writeFile(stopGate, 'hold'); const broker = await newTestBroker({ endpoint, brokerToken, workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture }, env: { ...process.env, FAKE_ZCODE_COMPLETION_GATE: completionGate, FAKE_ZCODE_STOP_GATE: stopGate, FAKE_ZCODE_STOP_GATE_REACHED: stopReached, FAKE_ZCODE_CONVERSATION_UNSUBSCRIBE_MALFORMED: '1' } }).start(); const client = await createZCodeClient({ workspace: directory, brokerEndpoint: endpoint, brokerToken, ownerId, completionTimeoutMs: 1_000 });
  try {
    const sessionId = (await client.createSession({ workspace: directory })).session.sessionId; await client.subscribeConversation(sessionId, { connectionId: 'terminal-wins-stop-connection', clientMode: 'desktop-continuous' }); await client.send(sessionId, 'terminal wins direct stop'); const stopping = client.stopSession(sessionId); const deadline = Date.now() + 1_000; while ((await readFile(stopReached, 'utf8').catch(() => '')) !== 'blocked' && Date.now() < deadline) await new Promise((resolvePromise) => setTimeout(resolvePromise, 5)); assert.equal(await readFile(stopReached, 'utf8'), 'blocked'); await writeFile(completionGate, 'release'); for (let index = 0; index < 200 && broker.activeSessionSockets.has(sessionId); index += 1) await new Promise((resolvePromise) => setTimeout(resolvePromise, 5)); assert.equal(broker.activeSessionSockets.has(sessionId), false); for (let index = 0; index < 200 && !client.protocol.completed.get(sessionId)?.length; index += 1) await new Promise((resolvePromise) => setTimeout(resolvePromise, 5)); assert.equal(client.protocol.completed.get(sessionId)?.length, 1); await writeFile(stopGate, 'release'); assert.deepEqual(await stopping, {}); const completion = await client.waitForCompletion(sessionId); assert.equal(completion.reason, 'prompt_completed'); assert.equal(broker.protocol, null); assert.equal(broker.conversationSubscriptions.size, 0);
  } finally { await writeFile(completionGate, 'release').catch(() => {}); await writeFile(stopGate, 'release').catch(() => {}); await client.close(); await broker.close(); await rm(directory, { recursive: true, force: true }); }
});

test('a natural terminal that wins before owner release remains waitable after release acknowledgement', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-terminal-wins-release-')); const endpoint = brokerEndpointFor({ dataRoot: directory, workspace: directory }); const brokerToken = '9'.repeat(64); const ownerId = 'terminal-wins-release-owner'; const completionGate = join(directory, 'completion.gate'); const stopGate = join(directory, 'stop.gate'); const stopReached = join(directory, 'stop.reached'); const record = join(directory, 'calls.jsonl'); await writeFile(completionGate, 'hold'); await writeFile(stopGate, 'hold'); const broker = await newTestBroker({ endpoint, brokerToken, workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture }, env: { ...process.env, FAKE_ZCODE_COMPLETION_GATE: completionGate, FAKE_ZCODE_STOP_GATE: stopGate, FAKE_ZCODE_STOP_GATE_REACHED: stopReached, FAKE_ZCODE_CONVERSATION_UNSUBSCRIBE_MALFORMED: '1', FAKE_ZCODE_RECORD: record } }).start(); const worker = await createZCodeClient({ workspace: directory, brokerEndpoint: endpoint, brokerToken, ownerId, completionTimeoutMs: 1_000 }); const controller = await createZCodeClient({ workspace: directory, brokerEndpoint: endpoint, brokerToken, ownerId });
  try {
    const sessionId = (await worker.createSession({ workspace: directory })).session.sessionId; await worker.subscribeConversation(sessionId, { connectionId: 'terminal-wins-release-connection', clientMode: 'desktop-continuous' }); await worker.send(sessionId, 'terminal wins owner release'); const releasing = controller.releaseOwner([]); const deadline = Date.now() + 1_000; while ((await readFile(stopReached, 'utf8').catch(() => '')) !== 'blocked' && Date.now() < deadline) await new Promise((resolvePromise) => setTimeout(resolvePromise, 5)); assert.equal(await readFile(stopReached, 'utf8'), 'blocked'); await writeFile(completionGate, 'release'); for (let index = 0; index < 200 && broker.activeSessionSockets.has(sessionId); index += 1) await new Promise((resolvePromise) => setTimeout(resolvePromise, 5)); assert.equal(broker.activeSessionSockets.has(sessionId), false); for (let index = 0; index < 200 && !worker.protocol.completed.get(sessionId)?.length; index += 1) await new Promise((resolvePromise) => setTimeout(resolvePromise, 5)); assert.equal(worker.protocol.completed.get(sessionId)?.length, 1); await writeFile(stopGate, 'release'); const released = await releasing; assert.deepEqual(released.releasedSessionIds, [sessionId]); const completion = await worker.waitForCompletion(sessionId); assert.equal(completion.reason, 'prompt_completed'); assert.equal(broker.sessionOwners.has(sessionId), false); assert.equal(broker.protocol, null); assert.equal((await readRecordedCalls(record)).filter((call) => call.method === 'session/stop').length, 1);
  } finally { await writeFile(completionGate, 'release').catch(() => {}); await writeFile(stopGate, 'release').catch(() => {}); await worker.close(); await controller.close(); await broker.close(); await rm(directory, { recursive: true, force: true }); }
});

test('a direct stop retry consumes its exact natural terminal winner before malformed cleanup', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-terminal-retry-stop-')); const endpoint = brokerEndpointFor({ dataRoot: directory, workspace: directory }); const brokerToken = 'a'.repeat(64); const ownerId = 'terminal-retry-stop-owner'; const completionGate = join(directory, 'completion.gate'); const stopGate = join(directory, 'stop.gate'); const stopReached = join(directory, 'stop.reached'); const record = join(directory, 'calls.jsonl'); await writeFile(completionGate, 'hold'); await writeFile(stopGate, 'hold'); const broker = await newTestBroker({ endpoint, brokerToken, workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture }, env: { ...process.env, FAKE_ZCODE_COMPLETION_GATE: completionGate, FAKE_ZCODE_STOP_GATE: stopGate, FAKE_ZCODE_STOP_GATE_REACHED: stopReached, FAKE_ZCODE_STOP_ERROR_ONCE: '1', FAKE_ZCODE_CONVERSATION_UNSUBSCRIBE_MALFORMED: '1', FAKE_ZCODE_RECORD: record } }).start(); const client = await createZCodeClient({ workspace: directory, brokerEndpoint: endpoint, brokerToken, ownerId, completionTimeoutMs: 1_000 });
  try {
    const sessionId = (await client.createSession({ workspace: directory })).session.sessionId; await client.subscribeConversation(sessionId, { connectionId: 'terminal-retry-stop-connection', clientMode: 'desktop-continuous' }); await client.send(sessionId, 'terminal survives direct retry'); const firstStop = client.stopSession(sessionId); const deadline = Date.now() + 1_000; while ((await readFile(stopReached, 'utf8').catch(() => '')) !== 'blocked' && Date.now() < deadline) await new Promise((resolvePromise) => setTimeout(resolvePromise, 5)); await writeFile(completionGate, 'release'); for (let index = 0; index < 200 && broker.activeSessionSockets.has(sessionId); index += 1) await new Promise((resolvePromise) => setTimeout(resolvePromise, 5)); assert.equal(broker.activeSessionSockets.has(sessionId), false); await writeFile(stopGate, 'release'); await assert.rejects(firstStop, { code: 'ZCODE_REQUEST_FAILED' }); assert.equal(broker.terminalWinnerEvidence.size, 1); assert.deepEqual(await client.stopSession(sessionId), {}); assert.equal(broker.terminalWinnerEvidence.size, 0); assert.equal((await client.waitForCompletion(sessionId)).reason, 'prompt_completed'); assert.equal(broker.protocol, null); assert.equal((await readRecordedCalls(record)).filter((call) => call.method === 'session/stop').length, 2);
  } finally { await writeFile(completionGate, 'release').catch(() => {}); await writeFile(stopGate, 'release').catch(() => {}); await client.close(); await broker.close(); await rm(directory, { recursive: true, force: true }); }
});

test('an owner release retry consumes its exact natural terminal winner and removes durable ownership', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-terminal-retry-release-')); const endpoint = brokerEndpointFor({ dataRoot: directory, workspace: directory }); const brokerToken = 'b'.repeat(64); const ownerId = 'terminal-retry-release-owner'; const completionGate = join(directory, 'completion.gate'); const stopGate = join(directory, 'stop.gate'); const stopReached = join(directory, 'stop.reached'); const record = join(directory, 'calls.jsonl'); await writeFile(completionGate, 'hold'); await writeFile(stopGate, 'hold'); const broker = await newTestBroker({ endpoint, brokerToken, workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture }, env: { ...process.env, FAKE_ZCODE_COMPLETION_GATE: completionGate, FAKE_ZCODE_STOP_GATE: stopGate, FAKE_ZCODE_STOP_GATE_REACHED: stopReached, FAKE_ZCODE_STOP_ERROR_ONCE: '1', FAKE_ZCODE_CONVERSATION_UNSUBSCRIBE_MALFORMED: '1', FAKE_ZCODE_RECORD: record } }).start(); const worker = await createZCodeClient({ workspace: directory, brokerEndpoint: endpoint, brokerToken, ownerId, completionTimeoutMs: 1_000 }); const controller = await createZCodeClient({ workspace: directory, brokerEndpoint: endpoint, brokerToken, ownerId });
  try {
    const sessionId = (await worker.createSession({ workspace: directory })).session.sessionId; await worker.subscribeConversation(sessionId, { connectionId: 'terminal-retry-release-connection', clientMode: 'desktop-continuous' }); await worker.send(sessionId, 'terminal survives release retry'); const firstRelease = controller.releaseOwner([]); const deadline = Date.now() + 1_000; while ((await readFile(stopReached, 'utf8').catch(() => '')) !== 'blocked' && Date.now() < deadline) await new Promise((resolvePromise) => setTimeout(resolvePromise, 5)); await writeFile(completionGate, 'release'); for (let index = 0; index < 200 && broker.activeSessionSockets.has(sessionId); index += 1) await new Promise((resolvePromise) => setTimeout(resolvePromise, 5)); assert.equal(broker.activeSessionSockets.has(sessionId), false); await writeFile(stopGate, 'release'); const failed = await firstRelease; assert.deepEqual(failed.releasedSessionIds, []); assert.deepEqual(failed.failedSessionIds, [sessionId]); assert.equal(broker.terminalWinnerEvidence.size, 1); const released = await controller.releaseOwner([]); assert.deepEqual(released.releasedSessionIds, [sessionId]); assert.deepEqual(released.failedSessionIds, []); assert.equal(broker.terminalWinnerEvidence.size, 0); assert.equal((await worker.waitForCompletion(sessionId)).reason, 'prompt_completed'); assert.equal(broker.sessionOwners.has(sessionId), false); assert.equal(broker.protocol, null); assert.equal((await readRecordedCalls(record)).filter((call) => call.method === 'session/stop').length, 2);
  } finally { await writeFile(completionGate, 'release').catch(() => {}); await writeFile(stopGate, 'release').catch(() => {}); await worker.close(); await controller.close(); await broker.close(); await rm(directory, { recursive: true, force: true }); }
});

test('an owner release retains natural terminal evidence until durable ownership commits', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-terminal-durable-retry-')); const endpoint = brokerEndpointFor({ dataRoot: directory, workspace: directory }); const brokerToken = 'c'.repeat(64); const ownerId = 'terminal-durable-retry-owner'; const completionGate = join(directory, 'completion.gate'); const stopGate = join(directory, 'stop.gate'); const stopReached = join(directory, 'stop.reached'); const record = join(directory, 'calls.jsonl'); await writeFile(completionGate, 'hold'); await writeFile(stopGate, 'hold'); const broker = await newTestBroker({ endpoint, brokerToken, workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture }, env: { ...process.env, FAKE_ZCODE_COMPLETION_GATE: completionGate, FAKE_ZCODE_STOP_GATE: stopGate, FAKE_ZCODE_STOP_GATE_REACHED: stopReached, FAKE_ZCODE_CONVERSATION_UNSUBSCRIBE_MALFORMED_AFTER: '2', FAKE_ZCODE_RECORD: record } }).start(); const worker = await createZCodeClient({ workspace: directory, brokerEndpoint: endpoint, brokerToken, ownerId, completionTimeoutMs: 1_000 }); const controller = await createZCodeClient({ workspace: directory, brokerEndpoint: endpoint, brokerToken, ownerId });
  try {
    const sessionId = (await worker.createSession({ workspace: directory })).session.sessionId; await worker.subscribeConversation(sessionId, { connectionId: 'terminal-durable-retry-first', clientMode: 'desktop-continuous' }); await worker.send(sessionId, 'terminal survives durable retry'); const writeOwnerStore = broker.writeOwnerStore.bind(broker); const durableError = new Error('durable release failed before apply'); let failWrite = true; broker.writeOwnerStore = async (...args) => { if (failWrite) { failWrite = false; throw durableError; } return writeOwnerStore(...args); }; const firstRelease = controller.releaseOwner([]); const deadline = Date.now() + 1_000; while ((await readFile(stopReached, 'utf8').catch(() => '')) !== 'blocked' && Date.now() < deadline) await new Promise((resolvePromise) => setTimeout(resolvePromise, 5)); await writeFile(completionGate, 'release'); for (let index = 0; index < 200 && broker.activeSessionSockets.has(sessionId); index += 1) await new Promise((resolvePromise) => setTimeout(resolvePromise, 5)); await writeFile(stopGate, 'release'); await assert.rejects(firstRelease); assert.equal(broker.sessionOwners.get(sessionId)?.ownerId, ownerId); assert.equal(broker.terminalWinnerEvidence.size, 1); for (let index = 0; index < 256; index += 1) broker.recordTerminalWinner(`durable-eviction-${index}`, broker.protocol, { token: `durable-eviction-token-${index}`, baseline: index, inputId: `durable-eviction-input-${index}` }); assert.equal(broker.terminalWinnerEvidence.has(sessionId), false); await worker.subscribeConversation(sessionId, { connectionId: 'terminal-durable-retry-second', clientMode: 'desktop-continuous' }); const released = await controller.releaseOwner([]); assert.deepEqual(released.releasedSessionIds, [sessionId]); assert.deepEqual(released.failedSessionIds, []); assert.equal(broker.sessionOwners.has(sessionId), false); assert.equal(broker.terminalWinnerEvidence.size, 0); assert.equal((await readRecordedCalls(record)).filter((call) => call.method === 'session/stop').length, 2);
  } finally { await writeFile(completionGate, 'release').catch(() => {}); await writeFile(stopGate, 'release').catch(() => {}); await worker.close(); await controller.close(); await broker.close(); await rm(directory, { recursive: true, force: true }); }
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
  try { const { session: { sessionId } } = await client.createSession({ workspace: directory }); await client.send(sessionId, 'hold'); const completionStopped = assert.rejects(client.waitForCompletion(sessionId), { code: 'ZCODE_SESSION_STOPPED' }); assert.deepEqual(await client.stopSession(sessionId), {}); await completionStopped; assert.equal((await client.listSessions()).sessions[0].sessionId, sessionId); }
  finally { await client.close(); await broker.close(); await rm(directory, { recursive: true, force: true }); }
});

test('completed broker becomes truly idle after its final owner disconnects', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-broker-idle-')); const endpoint = brokerEndpointFor({ dataRoot: directory, workspace: directory }); const brokerToken = '7'.repeat(64);
  const broker = await newTestBroker({ endpoint, brokerToken, workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture }, idleTimeoutMs: 1_000 }).start(); const client = await createZCodeClient({ workspace: directory, brokerEndpoint: endpoint, brokerToken, ownerId: 'idle-owner-stable' });
  try { const { session: { sessionId } } = await client.createSession({ workspace: directory }); await client.send(sessionId, 'finish'); await client.waitForCompletion(sessionId); await client.close(); for (let index = 0; index < 300 && (broker.server || broker.protocol); index += 1) await new Promise((resolve) => setTimeout(resolve, 5)); assert.equal(broker.server, null); assert.equal(broker.protocol, null); assert.equal(broker.activeSessions.size, 0); }
  finally { await client.close(); await broker.close(); await rm(directory, { recursive: true, force: true }); }
});

test('concurrent lazy broker acquisition publishes one healthy pid and identity', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-ensure-')); let brokerPid;
  try {
    const options = { dataRoot: directory, workspace: directory, launch: { command: process.execPath, args: [fixture], target: fixture }, idleTimeoutMs: 1_000 };
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
  const directory = await mkdtemp(join(tmpdir(), 'zcode-owner-restart-')); const workspace = realpathSync.native(directory); const endpoint = brokerEndpointFor({ dataRoot: directory, workspace: directory }); const ownershipPath = join(directory, 'owners.json'); const brokerToken = '6'.repeat(64); const launch = { command: process.execPath, args: [fixture], target: fixture };
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
