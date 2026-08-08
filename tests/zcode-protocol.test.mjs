// @ts-nocheck
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { connectZCodeBroker } from '../scripts/lib/zcode-protocol.mjs';

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
