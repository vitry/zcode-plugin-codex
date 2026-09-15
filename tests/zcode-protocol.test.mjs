// @ts-nocheck
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter, getEventListeners } from 'node:events';
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

test('an aborted request rejects promptly with the abort reason and drops its late response', async () => {
  // The bounded pre-stop evidence read aborts its underlying request when the
  // read outlives its budget, so the broker's EXCLUSIVE stop admission is not
  // serialized behind the orphaned read. The abort must reject the pending
  // request immediately with the abort reason, and the protocol must survive
  // the late response for the abandoned id — dropping it silently instead of
  // resolving anything or failing the connection as uncorrelated.
  const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.exitCode = null; child.signalCode = null; child.kill = () => true;
  const protocol = new ZCodeProtocolClient(child, { requestTimeoutMs: 5_000 });
  const frames = [];
  child.stdin.on('data', (chunk) => { try { frames.push(JSON.parse(chunk.toString('utf8'))); } catch { /* partial frame */ } });
  const controller = new AbortController();
  const reason = new Error('the bounded read outlived its budget');
  const pending = protocol.request('session/read', { sessionId: 'session-abort' }, undefined, controller.signal);
  await Promise.resolve();
  assert.equal(frames.length, 1, 'the request frame was sent');
  controller.abort(reason);
  await assert.rejects(pending, (error) => error === reason, 'the abort rejects the pending request immediately');
  child.stdout.write(`${JSON.stringify({ id: frames.at(-1).id, result: { ok: true } })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(protocol.closed, false, 'the protocol survives a response for an aborted request');
});

test('repeated in-flight aborts against a silent peer are reaped at their budget and never overflow pending', async () => {
  // The bounded pre-stop read aborts its request and KEEPS the marked entry
  // installed for the silent late-response drop. Against a peer that never
  // answers, nothing deletes those entries — so their original deadline
  // timers must stay armed: repeated bounded-read aborts may not accumulate
  // until the pending-map limit turns every later request into a
  // ZCODE_PENDING_OVERFLOW rejection.
  const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.exitCode = 0; child.signalCode = null; child.kill = () => true;
  const protocol = new ZCodeProtocolClient(child, { requestTimeoutMs: 5_000 });
  const frames = [];
  child.stdin.on('data', (chunk) => { frames.push(JSON.parse(chunk.toString('utf8'))); });
  const controllers = [];
  const attempts = [];
  for (let index = 0; index < 1024; index += 1) {
    const controller = new AbortController();
    controllers.push(controller);
    attempts.push(protocol.request('session/read', { sessionId: `session-reap-${index}` }, 120, controller.signal).then(() => 'resolved', (error) => error));
  }
  await Promise.resolve();
  const reason = new Error('the bounded read outlived its budget');
  for (const controller of controllers) controller.abort(reason);
  const outcomes = await Promise.all(attempts);
  assert.ok(outcomes.every((outcome) => outcome === reason), 'every aborted request rejects with its abort reason');
  // The original request budgets (120ms) must reap the retained entries even
  // though the silent peer never answers.
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(protocol.pending.size, 0, 'aborted-but-retained entries are reaped at their original budget');
  assert.equal(protocol.closed, false, 'the silent peer never failed the connection');
  // The pending map is free again: the next request must be admitted instead
  // of rejected as pending overflow.
  const followUp = protocol.request('broker/health', {}, 1_000);
  for (let turn = 0; turn < 200 && frames.length < 1_025; turn += 1) await new Promise((resolve) => setImmediate(resolve));
  const followUpFrame = frames.at(-1);
  assert.equal(followUpFrame?.method, 'broker/health', 'the follow-up request was sent and admitted');
  child.stdout.write(`${JSON.stringify({ id: followUpFrame.id, result: { ok: true } })}\n`);
  assert.deepEqual(await followUp, { ok: true }, 'a request after the reaped aborts is admitted and answered');
  await protocol.close();
});

test('a correlated error frame lends its bounded serving-generation stamp to the rejected request', async () => {
  // Spec 4.4 line 73 through the 4.2 continuity chain: a broker stamps a
  // session/read ERROR response with the protocol generation that PRODUCED
  // the error, and the rejected request surfaces that stamp as internal
  // `details.brokerProtocolGeneration` evidence — a failed read CAN carry its
  // own per-response provenance. Unstamped error frames (and every unbounded
  // or missing shape) stay unstamped: transport-level failures never gain a
  // generation here.
  const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.exitCode = 0; child.signalCode = null; child.kill = () => true;
  const protocol = new ZCodeProtocolClient(child, { requestTimeoutMs: 5_000, acceptBrokerControl: true });
  const frames = [];
  child.stdin.on('data', (chunk) => { frames.push(JSON.parse(chunk.toString('utf8'))); });
  const stamped = protocol.request('session/read', { sessionId: 'session-error-stamp' }, 1_000).then(() => 'resolved', (error) => error);
  for (let turn = 0; turn < 100 && frames.length < 1; turn += 1) await new Promise((resolvePromise) => setImmediate(resolvePromise));
  child.stdout.write(`${JSON.stringify({ id: frames[0].id, error: { code: -32000, message: 'ZCode session/read failed: the session is inactive.', data: { pluginError: { code: 'ZCODE_OUTPUT_INVALID', category: 'protocol', remedy: 'Retry the operation.', details: { method: 'session/read' } }, protocolGeneration: 'a'.repeat(32) } } })}\n`);
  const stampedError = await stamped;
  assert.equal(stampedError instanceof Error && stampedError.details?.brokerProtocolGeneration, 'a'.repeat(32),
    'the correlated error frame stamps the rejection with its producing generation');
  const unstamped = protocol.request('session/read', { sessionId: 'session-error-unstamped' }, 1_000).then(() => 'resolved', (error) => error);
  for (let turn = 0; turn < 100 && frames.length < 2; turn += 1) await new Promise((resolvePromise) => setImmediate(resolvePromise));
  child.stdout.write(`${JSON.stringify({ id: frames.at(-1).id, error: { code: -32000, message: 'ZCode session/read failed: the session is inactive.', data: { pluginError: { code: 'ZCODE_OUTPUT_INVALID', category: 'protocol', remedy: 'Retry the operation.', details: { method: 'session/read' } }, protocolGeneration: 'not-a-generation' } } })}\n`);
  const unstampedError = await unstamped;
  assert.equal(unstampedError instanceof Error && unstampedError.details?.brokerProtocolGeneration, undefined,
    'an unbounded stamp shape is never surfaced as provenance');
  await protocol.close();
});

test('a settled request leaves zero abort listeners attached to its signal', async () => {
  // Repeated status-wait reads carry LONG-LIVED signals: an abort listener
  // that survives settlement would accumulate on every operation until the
  // listener warnings start. Every settlement path must detach it.
  const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.exitCode = null; child.signalCode = null; child.kill = () => true;
  const protocol = new ZCodeProtocolClient(child, { requestTimeoutMs: 5_000 });
  child.stdin.on('data', (chunk) => {
    const frame = JSON.parse(chunk.toString('utf8'));
    setImmediate(() => child.stdout.write(`${JSON.stringify({ id: frame.id, result: { ok: true } })}\n`));
  });
  const controller = new AbortController();
  await protocol.request('session/read', { sessionId: 'session-listeners' }, undefined, controller.signal);
  await Promise.resolve();
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0, 'the abort listener is detached when the request settles');
});

test('a request with an already-aborted signal rejects immediately with nothing left in pending', async () => {
  // A never-sent request has no in-flight operation to release: it must
  // reject fast and leave the pending map exactly as it found it, instead of
  // occupying an entry until the full request timeout.
  const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.exitCode = null; child.signalCode = null; child.kill = () => true;
  const protocol = new ZCodeProtocolClient(child, { requestTimeoutMs: 5_000 });
  const frames = [];
  child.stdin.on('data', (chunk) => { try { frames.push(JSON.parse(chunk.toString('utf8'))); } catch { /* partial frame */ } });
  const controller = new AbortController();
  const reason = new Error('the budget expired before the read started');
  controller.abort(reason);
  const pendingSizeBefore = protocol.pending.size;
  await assert.rejects(protocol.request('session/read', { sessionId: 'session-pre-aborted' }, undefined, controller.signal),
    (error) => error === reason, 'the pre-aborted signal rejects the request fast with its reason');
  assert.equal(protocol.pending.size, pendingSizeBefore, 'a never-sent request leaves nothing in pending');
  assert.equal(frames.length, 0, 'no frame is sent for an already-aborted request');
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

test('a failed protocol connection is permanently closed and proves no continuity', async () => {
  const first = new ZCodeProtocolClient(fakeProtocolChild());
  const second = new ZCodeProtocolClient(fakeProtocolChild());
  try {
    // Socket-level continuity is bounded but NEVER upstream-generation proof:
    // the broker can reconstruct its engine behind one unchanged client
    // connection, which is why continuity attestation derives from the
    // broker's serving-generation stamps instead (see zcode-broker.mjs). No
    // socket-token primitive exists to be mistaken for generation proof.
    assert.equal('connectionToken' in first, false);
    assert.equal(first.closed, false);
    first.fail(new Error('transport reset mid-attempt'));
    assert.equal(first.closed, true, 'a failed connection can serve no further request');
    assert.equal(second.closed, false);
  } finally {
    await first.close();
    await second.close();
  }
});
