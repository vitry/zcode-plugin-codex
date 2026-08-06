// @ts-nocheck
import assert from 'node:assert/strict';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { resolveModel } from '../../scripts/lib/args.mjs';
import { diagnoseZCodeAuth } from '../../scripts/lib/codex-config.mjs';
import { createIdentityStore } from '../../scripts/lib/identity.mjs';
import { ownerIdForSession } from '../../scripts/lib/job-control.mjs';
import { createZCodeClient } from '../../scripts/lib/zcode-client.mjs';
import { releaseManagedZCodeOwner } from '../../scripts/lib/zcode-client.mjs';
import { discoverZCode } from '../../scripts/lib/zcode-discovery.mjs';
import { runCompanion } from '../../scripts/zcode-companion.mjs';

const requestedModel = process.env.ZCODE_REAL_E2E_MODEL?.trim();
const skipReason = process.env.ZCODE_REAL_E2E !== '1'
  ? 'unqualified local real E2E: set ZCODE_REAL_E2E=1 on an authenticated macOS ZCode installation'
  : process.platform !== 'darwin'
    ? 'unqualified real E2E: macOS is the only real-CLI-qualified platform'
    : !requestedModel
      ? 'unqualified real E2E: set a non-empty ZCODE_REAL_E2E_MODEL'
      : false;

test('real ZCode discovery, read-only turn, cancellation, model, and history import', {
  skip: skipReason,
  timeout: 240_000,
}, async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), 'zcode-real-e2e-'));
  const sessions = new Set();
  let client;
  t.after(async () => {
    if (client) {
      for (const sessionId of sessions) await client.stopSession(sessionId, 10_000).catch(() => {});
      await client.close().catch(() => {});
    }
    await releaseManagedZCodeOwner({ dataRoot: join(temporary, 'plugin-data'), workspace: temporary, ownerId: ownerIdForSession('real-zcode-e2e'), requestTimeoutMs: 10_000 }).catch(() => {});
    await rm(temporary, { force: true, recursive: true });
  });
  const discovery = await discoverZCode({ explicitPath: process.env.ZCODE_PATH, env: process.env });
  assert.match(discovery.version, /^\d+\.\d+\.\d+/);
  assert.deepEqual(await diagnoseZCodeAuth({
    workspace: temporary,
    discovery,
    env: process.env,
    requestTimeoutMs: 30_000,
  }), { ready: true, status: 'authenticated' });

  const dataRoot = join(temporary, 'plugin-data'); const identity = createIdentityStore({ dataRoot });
  const callerContext = await identity.createCallerContext({ sessionId: 'real-zcode-e2e', turnId: 'real-model-turn', workspace: temporary, permissionMode: 'read-only' });
  const companion = await runCompanion(['rescue', '--fresh', '--model', requestedModel, 'Inspect this empty workspace read-only and return a short acknowledgement.'], { cwd: temporary, env: { ...process.env, ZCODE_DATA_ROOT: dataRoot, ZCODE_PATH: discovery.path }, authorization: { callerContext } });
  assert.equal(companion.job.status, 'succeeded'); assert.ok(companion.result.trim()); assert.ok(companion.job.model);

  client = await createZCodeClient({
    workspace: temporary,
    launch: discovery.launch,
    env: process.env,
    requestTimeoutMs: 30_000,
    completionTimeoutMs: 180_000,
  });
  client.setPermissionHandler((request) => {
    const denied = request.options.find((option) => option.response?.decision === 'deny');
    assert.ok(denied, 'every real E2E permission request must offer an exact deny response');
    return denied.response;
  });

  let created;
  try {
    created = await client.createSession({ workspace: temporary });
  } catch (error) {
    assert.fail(`ZCode authentication/readiness failed during session/create: ${error instanceof Error ? error.message : String(error)}`);
  }
  const sessionId = created.session.sessionId;
  sessions.add(sessionId);

  const model = resolveModel(requestedModel, {}, created.settings.model.available);
  const selected = await client.setModel(sessionId, model);
  assert.deepEqual(selected.settings.model.current, model);

  const cancellation = await client.createSession({ workspace: temporary });
  const cancellationId = cancellation.session.sessionId;
  sessions.add(cancellationId);
  let permissionReachedResolve; const permissionReached = new Promise((resolve) => { permissionReachedResolve = resolve; });
  let permissionAbortedResolve; const permissionAborted = new Promise((resolve) => { permissionAbortedResolve = resolve; });
  client.setPermissionHandler((request, signal) => {
    const denied = request.options.find((option) => option.response?.decision === 'deny');
    assert.ok(denied, 'the remote cancellation barrier must offer an exact deny response');
    permissionReachedResolve(request);
    return new Promise((_, reject) => signal.addEventListener('abort', () => { permissionAbortedResolve(); reject(new Error('turn stopped')); }, { once: true }));
  });
  const active = await client.send(cancellationId, 'Attempt to create cancellation-probe.txt using a write or shell tool. Do not merely explain and do not try an alternative.');
  assert.equal(active.accepted, true);
  const remotePermission = await boundedBarrier(permissionReached, 'remote permission request');
  assert.equal(remotePermission.sessionId, cancellationId);
  assert.equal(client.turnState(cancellationId), 'armed');
  await assert.rejects(client.send(cancellationId, 'This second send must be rejected while the first turn is active.'), { code: 'ZCODE_TURN_ACTIVE' });
  // ZCode Protocol 0.16.1 exposes a successful object acknowledgement, not a
  // remote "cancelled" terminal enum. The strongest exact invariant is that
  // the accepted turn is armed before that ack and absent immediately after it.
  const stopped = await client.stopSession(cancellationId, 10_000);
  assert.ok(stopped && typeof stopped === 'object' && !Array.isArray(stopped));
  await boundedBarrier(permissionAborted, 'permission abort after stop');
  assert.equal(client.turnState(cancellationId), null);
  await assert.rejects(client.waitForCompletion(cancellationId, 10_000), { code: 'ZCODE_PROTOCOL_INPUT_INVALID' });
  await assert.rejects(access(join(temporary, 'cancellation-probe.txt')), { code: 'ENOENT' });
  client.setPermissionHandler((request) => {
    const denied = request.options.find((option) => option.response?.decision === 'deny');
    assert.ok(denied); return denied.response;
  });
  sessions.delete(cancellationId);

  const sent = await client.send(sessionId, 'Inspect only this empty temporary workspace. Do not write files or run mutating commands. Reply with a short acknowledgement.');
  assert.equal(sent.accepted, true);
  await client.waitForCompletion(sessionId, 180_000);
  const completed = await client.readSession(sessionId);
  assert.ok(completed.messages.some((message) => message.info?.role === 'assistant'
    && message.parts?.some((part) => part.type === 'text' && typeof part.text === 'string' && part.text.trim())));
  await client.stopSession(sessionId, 10_000);
  sessions.delete(sessionId);

  const imported = await client.createSession({
    workspace: temporary,
    importedHistory: { messages: [
      { role: 'user', content: 'Synthetic Codex user turn.' },
      { role: 'assistant', content: 'Synthetic Codex assistant turn.' },
    ] },
  });
  const importedId = imported.session.sessionId;
  sessions.add(importedId);
  const history = await client.readSession(importedId);
  assert.ok(history.messages.some((message) => message.info?.role === 'user'));
  assert.ok(history.messages.some((message) => message.info?.role === 'assistant'));
  await client.stopSession(importedId, 10_000);
  sessions.delete(importedId);
});

function boundedBarrier(promise, label, timeoutMs = 60_000) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}.`)), timeoutMs); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
