// @ts-nocheck
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mock, test } from 'node:test';

import { closeProtocolUntil, connectZCodeBroker, ZCodeProtocolClient } from '../scripts/lib/zcode-protocol.mjs';

test('request accepts an already-scheduled response after its deadline timer becomes ready', async () => {
  const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.exitCode = null; child.signalCode = null; child.kill = () => true;
  const protocol = new ZCodeProtocolClient(child, { requestTimeoutMs: 100 });
  child.stdin.once('data', (chunk) => {
    const frame = JSON.parse(chunk.toString('utf8'));
    setImmediate(() => child.stdout.write(`${JSON.stringify({ id: frame.id, result: { ok: true } })}\n`));
  });
  const response = protocol.request('broker/health', {}, 20);
  await Promise.resolve();
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40);
  await assert.doesNotReject(response);
});

test('real socket response ready at the deadline wins before request timeout', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-protocol-ready-response-'));
  const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\zcode-protocol-${randomUUID()}` : join(directory, 'broker.sock');
  const brokerToken = 'b'.repeat(64); const ownerId = 'protocol-ready-response-owner'; let releaseResponse; let peer;
  const releaseResponseReady = new Promise((resolvePromise) => { releaseResponse = resolvePromise; });
  const server = net.createServer((socket) => {
    peer = socket; socket.setEncoding('utf8'); let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk; let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const frame = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1); newline = buffer.indexOf('\n');
        if (frame.method === 'broker/auth') socket.write(`${JSON.stringify({ id: frame.id, result: { authenticated: true } })}\n`);
        else { setImmediate(() => socket.write(`${JSON.stringify({ id: frame.id, result: { releasedSessionIds: [], failedSessionIds: [], deferredSessionCount: 0 } })}\n`)); releaseResponse(); }
      }
    });
  });
  await new Promise((resolvePromise, reject) => { server.once('error', reject); server.listen(endpoint, resolvePromise); });
  let protocol;
  try {
    protocol = await connectZCodeBroker(endpoint, { brokerToken, ownerId, requestTimeoutMs: 100 });
    const releasing = protocol.request('broker/releaseOwner', {}, 20); await releaseResponseReady;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40);
    assert.deepEqual(await releasing, { releasedSessionIds: [], failedSessionIds: [], deferredSessionCount: 0 });
  } finally { peer?.destroy(); await protocol?.close(); await new Promise((resolvePromise) => server.close(resolvePromise)); await rm(directory, { recursive: true, force: true }); }
});

test('broker connect bounds authentication and closes the socket when the peer never answers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-protocol-auth-'));
  const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\zcode-protocol-${randomUUID()}` : join(directory, 'broker.sock');
  let peer; let resolveAccepted; let resolvePeerClosed;
  const accepted = new Promise((resolvePromise) => { resolveAccepted = resolvePromise; });
  const peerClosed = new Promise((resolvePromise) => { resolvePeerClosed = resolvePromise; });
  const server = net.createServer((socket) => {
    peer = socket; resolveAccepted();
    socket.once('close', () => resolvePeerClosed());
    socket.resume();
  });
  await new Promise((resolvePromise, reject) => { server.once('error', reject); server.listen(endpoint, resolvePromise); });
  try {
    const startedAt = Date.now();
    const connecting = connectZCodeBroker(endpoint, { brokerToken: 'a'.repeat(64), ownerId: 'protocol-auth-timeout-owner', requestTimeoutMs: 40 });
    await accepted;
    await assert.rejects(connecting, { code: 'ZCODE_REQUEST_TIMEOUT' });
    assert.ok(Date.now() - startedAt < 500);
    assert.equal(await Promise.race([peerClosed.then(() => true), new Promise((resolvePromise) => { const timer = setTimeout(() => resolvePromise(false), 250); timer.unref?.(); })]), true);
  } finally {
    peer?.destroy();
    await new Promise((resolvePromise) => server.close(resolvePromise));
    await rm(directory, { recursive: true, force: true });
  }
});

test('broker connect and authentication share one absolute timeout budget', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-protocol-shared-budget-')); const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\zcode-protocol-${randomUUID()}` : join(directory, 'broker.sock'); let peer; const server = net.createServer((socket) => { peer = socket; socket.resume(); }); await new Promise((resolvePromise, reject) => { server.once('error', reject); server.listen(endpoint, resolvePromise); });
  const createConnection = net.createConnection; const now = Date.now; let currentTime = 1_000; Date.now = () => currentTime; net.createConnection = (...args) => { const socket = createConnection(...args); socket.once('connect', () => { currentTime = 1_070; }); return socket; };
  try { let observed; await assert.rejects(connectZCodeBroker(endpoint, { brokerToken: 'a'.repeat(64), ownerId: 'protocol-shared-budget-owner', requestTimeoutMs: 200 }), (error) => { observed = error; return error?.code === 'ZCODE_REQUEST_TIMEOUT'; }); assert.equal(observed.details.timeoutMs, 130, 'authentication must receive only the remaining connect budget'); }
  finally { Date.now = now; net.createConnection = createConnection; peer?.destroy(); await new Promise((resolvePromise) => server.close(resolvePromise)); await rm(directory, { recursive: true, force: true }); }
});

test('deadline-aware protocol close returns while an uncooperative transport never exits', async () => {
  const killCalls = []; const transport = { stdout: null, stderr: null, stdin: { end() {} }, exitCode: null, signalCode: null, once() { return this; }, kill(signal) { killCalls.push(signal); return true; } }; const protocol = new ZCodeProtocolClient(transport); const startedAt = Date.now(); await closeProtocolUntil(protocol, startedAt + 50); const elapsed = Date.now() - startedAt; assert.ok(elapsed >= 40 && elapsed < 200); assert.deepEqual(killCalls, ['SIGTERM']);
});

test('broker connect rejects a malformed existing-protocol-only capability before opening a socket', async () => {
  await assert.rejects(connectZCodeBroker('/definitely-missing-zcode-broker', {
    brokerToken: 'a'.repeat(64), ownerId: 'protocol-capability-owner', existingProtocolOnly: 'yes', requestTimeoutMs: 40,
  }), { code: 'ZCODE_PROTOCOL_INPUT_INVALID' });
});

test('broker connect fails closed when an older broker does not acknowledge existing-protocol-only', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-protocol-capability-'));
  const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\zcode-protocol-${randomUUID()}` : join(directory, 'broker.sock');
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket); socket.setEncoding('utf8'); let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk; const newline = buffer.indexOf('\n'); if (newline === -1) return;
      const frame = JSON.parse(buffer.slice(0, newline));
      socket.write(`${JSON.stringify({ id: frame.id, result: { authenticated: true } })}\n`);
    });
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise((resolvePromise, reject) => { server.once('error', reject); server.listen(endpoint, resolvePromise); });
  try {
    await assert.rejects(connectZCodeBroker(endpoint, { brokerToken: 'a'.repeat(64), ownerId: 'protocol-capability-owner', existingProtocolOnly: true, requestTimeoutMs: 100 }), { code: 'ZCODE_BROKER_CAPABILITY_UNAVAILABLE' });
    for (let turn = 0; turn < 20 && sockets.size; turn += 1) await new Promise((resolvePromise) => setImmediate(resolvePromise));
    assert.equal(sockets.size, 0);
  } finally { for (const socket of sockets) socket.destroy(); await new Promise((resolvePromise) => server.close(resolvePromise)); await rm(directory, { recursive: true, force: true }); }
});

function fakeProtocolChild() {
  const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.exitCode = 0; child.signalCode = null; child.kill = () => true;
  return child;
}

const permissionOptions = [
  { optionId: 'allow', kind: 'allow', name: 'Allow', response: { decision: 'allow' } },
  { optionId: 'deny', kind: 'deny', name: 'Deny', response: { decision: 'deny' } },
];

/** @param {string} sessionId @param {number} revision */
function legacyCompletionLine(sessionId, revision) {
  return JSON.stringify({ method: 'state.updated', params: { scope: 'session', sessionId, revision, reason: 'prompt_completed' } });
}

/** @param {number} id @param {string} requestId @param {string} sessionId */
function permissionLine(id, requestId, sessionId) {
  return JSON.stringify({ id, method: 'interaction/requestPermission', params: { requestId, sessionId, toolCallId: `tool-${requestId}`, toolName: 'write', reason: 'test', riskLevel: 'low', input: {}, options: permissionOptions } });
}

const flushTurnFrames = () => new Promise((resolvePromise) => setImmediate(resolvePromise));

/** @param {ZCodeProtocolClient} protocol @param {string} sessionId @param {number} id @param {string} requestId */
async function allowPermissionAfterExpiry(protocol, sessionId, id, requestId) {
  let handled = 0;
  protocol.setPermissionHandler(() => { handled += 1; return { decision: 'allow' }; });
  protocol.handleLine(permissionLine(id, requestId, sessionId));
  await flushTurnFrames();
  const response = JSON.parse(protocol.child.stdin.read().toString());
  assert.deepEqual(response, { id, result: { decision: 'allow' } }, 'a permission request after cache expiry must still reach the handler');
  assert.equal(handled, 1);
}

test('legacy completion cache expiry keeps an early-queued observed turn armed and permissions flowing', async () => {
  const child = fakeProtocolChild(); const protocol = new ZCodeProtocolClient(child);
  try {
    protocol.beginTurn('session-legacy');
    protocol.handleLine(legacyCompletionLine('session-legacy', 2));
    mock.timers.enable({ apis: ['setTimeout'] });
    protocol.armTurn('session-legacy', 1, 'input-legacy');
    const observed = await protocol.observeCompletion('session-legacy');
    assert.equal(observed.reason, 'prompt_completed');
    mock.timers.tick(10 * 60_000);
    assert.equal(protocol.turnState('session-legacy'), 'armed', 'cache expiry must not cancel a still-running turn');
    await allowPermissionAfterExpiry(protocol, 'session-legacy', 99, 'perm-after-early-expiry');
    assert.equal(protocol.closed, false, 'the connection must stay open');
  } finally {
    mock.timers.reset();
    protocol.releaseTurn('session-legacy');
  }
});

test('legacy completion cache expiry keeps a live-observed turn armed and permissions flowing', async () => {
  const child = fakeProtocolChild(); const protocol = new ZCodeProtocolClient(child);
  try {
    protocol.beginTurn('session-legacy'); protocol.armTurn('session-legacy', 1, 'input-legacy');
    const observed = protocol.observeCompletion('session-legacy');
    mock.timers.enable({ apis: ['setTimeout'] });
    protocol.handleLine(legacyCompletionLine('session-legacy', 2));
    assert.equal((await observed).reason, 'prompt_completed');
    mock.timers.tick(10 * 60_000);
    assert.equal(protocol.turnState('session-legacy'), 'armed', 'cache expiry must not cancel a still-running turn');
    await allowPermissionAfterExpiry(protocol, 'session-legacy', 99, 'perm-after-live-expiry');
    assert.equal(protocol.closed, false, 'the connection must stay open');
  } finally {
    mock.timers.reset();
    protocol.releaseTurn('session-legacy');
  }
});

test('legacy completion cache expiry drops the stale wake so a later wait times out on its own', async () => {
  const child = fakeProtocolChild(); const protocol = new ZCodeProtocolClient(child);
  try {
    protocol.beginTurn('session-legacy'); protocol.armTurn('session-legacy', 1, 'input-legacy');
    mock.timers.enable({ apis: ['setTimeout'] });
    protocol.handleLine(legacyCompletionLine('session-legacy', 2));
    mock.timers.tick(10 * 60_000);
    assert.equal(protocol.completed.size, 0, 'the cached legacy completion must be dropped on expiry');
    assert.equal(protocol.completionExpiry.size, 0, 'the expiry timer must not linger');
    assert.equal(protocol.turnState('session-legacy'), 'armed', 'bounded cache cleanup must not cancel the turn');
    const waiting = protocol.waitForCompletion('session-legacy', 50);
    const timingOut = assert.rejects(waiting, { code: 'ZCODE_COMPLETION_TIMEOUT' });
    mock.timers.tick(50);
    await timingOut;
    assert.equal(protocol.turnState('session-legacy'), null, 'waitForCompletion keeps its own documented destructive timeout');
    assert.equal(protocol.closed, false, 'the connection must stay open');
  } finally {
    mock.timers.reset();
  }
});

test('re-queued legacy completions never arm a destructive expiry', async () => {
  const child = fakeProtocolChild(); const protocol = new ZCodeProtocolClient(child);
  try {
    protocol.beginTurn('session-legacy'); protocol.armTurn('session-legacy', 1, 'input-legacy');
    mock.timers.enable({ apis: ['setTimeout'] });
    protocol.handleLine(legacyCompletionLine('session-legacy', 2));
    protocol.handleLine(legacyCompletionLine('session-legacy', 3));
    const observed = await protocol.observeCompletion('session-legacy');
    assert.equal(observed.revision, 3, 're-queue replaces the cached wake');
    mock.timers.tick(10 * 60_000);
    assert.equal(protocol.completed.size, 0, 'the final expiry still drops the cached wake');
    assert.equal(protocol.turnState('session-legacy'), 'armed', 'no re-queued expiry may cancel the turn');
    await allowPermissionAfterExpiry(protocol, 'session-legacy', 99, 'perm-after-requeue-expiry');
    assert.equal(protocol.closed, false, 'the connection must stay open');
  } finally {
    mock.timers.reset();
    protocol.releaseTurn('session-legacy');
  }
});

test('explicit stop control still ends an armed legacy turn', () => {
  const child = fakeProtocolChild(); const protocol = new ZCodeProtocolClient(child, { acceptBrokerControl: true });
  protocol.beginTurn('session-legacy'); protocol.armTurn('session-legacy', 1, 'input-legacy');
  protocol.handleLine(JSON.stringify({ method: 'broker/sessionStopped', params: { sessionId: 'session-legacy' } }));
  assert.equal(protocol.turnState('session-legacy'), null, 'broker stop control must cancel the turn');
  protocol.beginTurn('session-legacy'); protocol.armTurn('session-legacy', 1, 'input-legacy');
  protocol.cancelTurn('session-legacy');
  assert.equal(protocol.turnState('session-legacy'), null, 'explicit cancellation must end the turn');
  protocol.beginTurn('session-legacy'); protocol.armTurn('session-legacy', 1, 'input-legacy');
  protocol.releaseTurn('session-legacy');
  assert.equal(protocol.turnState('session-legacy'), null, 'local release must end the turn');
  assert.equal(protocol.closed, false);
});
