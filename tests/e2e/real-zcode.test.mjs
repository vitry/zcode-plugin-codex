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
import { createManagedZCodeClient } from '../../scripts/lib/zcode-client.mjs';
import { releaseManagedZCodeOwner } from '../../scripts/lib/zcode-client.mjs';
import { discoverZCode } from '../../scripts/lib/zcode-discovery.mjs';
import { runCompanion } from '../../scripts/zcode-companion.mjs';
import { resolveRealZCodeModelEnvironment } from '../helpers/real-zcode-model.mjs';

let modelEnvironment; let modelEnvironmentFailure;
try { modelEnvironment = resolveRealZCodeModelEnvironment(process.env); }
catch (error) {
  if (error?.code !== 'ZCODE_REAL_MODEL_CONFLICT') throw error;
  modelEnvironmentFailure = unqualified('model-environment-conflict', error.message);
}
const requestedModel = modelEnvironment?.model;
const qualificationRequired = process.env.ZCODE_REQUIRE_QUALIFIED === '1';
const skipReason = modelEnvironmentFailure || (process.env.ZCODE_REAL_E2E !== '1'
  ? unqualified('opt-in-required', 'Set ZCODE_REAL_E2E=1 on an authenticated macOS ZCode installation.')
  : process.platform !== 'darwin'
    ? unqualified('platform-unsupported', 'macOS is the only real-CLI-qualified platform.')
    : !requestedModel
      ? unqualified('model-required', 'Set a non-empty ZCODE_REAL_E2E_MODEL.')
      : false);

function unqualified(code, detail) { return `real-zcode-unqualified ${JSON.stringify({ qualified: false, code, detail })}`; }

test('real ZCode discovery, two-turn session, read-only Companion, cancellation, model, and history import', {
  skip: qualificationRequired ? false : skipReason,
  timeout: 420_000,
}, async (t) => {
  if (skipReason) assert.fail(skipReason);
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
  const companion = await runCompanion(['rescue', '--fresh', '--model', requestedModel, 'Inspect this empty workspace read-only and return a short acknowledgement.'], {
    cwd: temporary,
    env: { ...process.env, ZCODE_DATA_ROOT: dataRoot, ZCODE_PATH: discovery.path },
    authorization: { callerContext },
    dependencies: { createManagedZCodeClient: (options) => createManagedZCodeClient({ ...options, completionTimeoutMs: 180_000 }) },
  });
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
  await client.waitForCompletion(sessionId);
  const firstCompleted = await client.readSession(sessionId);
  const firstAssistantResults = visibleAssistantResultsForTurn(firstCompleted, sent.inputId, messageIds(selected));
  assert.ok(firstAssistantResults.length >= 1, 'the first direct real turn must expose a non-empty assistant result');
  const continued = await client.send(sessionId, 'Continue in this exact session. Inspect only and reply with a second short acknowledgement distinct from the first.');
  assert.equal(continued.accepted, true);
  await client.waitForCompletion(sessionId);
  const secondCompleted = await client.readSession(sessionId);
  const secondAssistantResults = visibleAssistantResultsForTurn(secondCompleted, continued.inputId, messageIds(firstCompleted));
  assert.ok(secondAssistantResults.length >= 1, 'the second direct real turn must expose a new non-empty assistant result linked to its accepted input');
  const firstAssistantIds = new Set(firstAssistantResults.map((entry) => entry.info.messageId));
  assert.ok(secondAssistantResults.every((message) => !firstAssistantIds.has(message.info.messageId)),
    'the second direct real turn must not reuse a first-turn assistant result');
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

test('visible assistant result selection is linked to the exact accepted input or its sole persisted user root', () => {
  const snapshot = { messages: [
    { info: { role: 'assistant', messageId: 'assistant-first', parentMessageId: 'input-first' }, parts: [{ type: 'text', text: 'first' }] },
    { info: { role: 'assistant', messageId: 'assistant-empty', parentMessageId: 'input-second' }, parts: [{ type: 'text', text: '   ' }] },
    { info: { role: 'assistant', messageId: 'assistant-second', parentMessageId: 'input-second' }, parts: [{ type: 'text', text: 'second' }] },
  ] };
  assert.deepEqual(visibleAssistantResultsForTurn(snapshot, 'input-second', new Set()).map((message) => message.info.messageId), ['assistant-second']);
  assert.deepEqual(visibleAssistantResultsForTurn(snapshot, 'input-missing', new Set()), []);
  const remapped = { messages: [
    { info: { role: 'user', messageId: 'persisted-root', semantics: { origin: 'real_user', kind: 'user_prompt', uiVisibility: 'visible' } }, parts: [{ type: 'text', text: 'prompt' }] },
    { info: { role: 'assistant', messageId: 'persisted-result', parentMessageId: 'persisted-root' }, parts: [{ type: 'text', text: 'result' }] },
  ] };
  assert.deepEqual(visibleAssistantResultsForTurn(remapped, 'unpersisted-input', new Set()).map((message) => message.info.messageId), ['persisted-result']);
  remapped.messages.push({ info: { role: 'user', messageId: 'ambiguous-root', semantics: { origin: 'real_user', kind: 'user_prompt', uiVisibility: 'visible' } }, parts: [{ type: 'text', text: 'other' }] });
  assert.deepEqual(visibleAssistantResultsForTurn(remapped, 'unpersisted-input', new Set()), []);
});

function visibleAssistantResultsForTurn(session, inputId, beforeMessageIds) {
  if (typeof inputId !== 'string' || inputId.length === 0 || !(beforeMessageIds instanceof Set) || !Array.isArray(session?.messages)) return [];
  const newMessages = session.messages.filter((message) => typeof message?.info?.messageId === 'string' && !beforeMessageIds.has(message.info.messageId));
  const directlyLinked = newMessages.some((message) => message?.info?.role === 'assistant' && message.info.parentMessageId === inputId);
  let parentMessageId = inputId;
  if (!directlyLinked) {
    const roots = newMessages.filter((message) => message?.info?.role === 'user' && message.info.synthetic !== true
      && message.info.visibility !== 'model-only' && message.info.source === undefined
      && (message.info.semantics === undefined || message.info.semantics.origin === 'real_user'
        && message.info.semantics.kind === 'user_prompt' && message.info.semantics.uiVisibility === 'visible'));
    if (roots.length !== 1) return [];
    parentMessageId = roots[0].info.messageId;
  }
  return newMessages.filter((message) => message?.info?.role === 'assistant' && message.info.parentMessageId === parentMessageId
    && typeof message.info.messageId === 'string' && message.info.messageId.length > 0
    && message.parts?.some((part) => part?.type === 'text' && typeof part.text === 'string' && part.text.trim()));
}

function messageIds(session) {
  return new Set((Array.isArray(session?.messages) ? session.messages : [])
    .map((message) => message?.info?.messageId).filter((value) => typeof value === 'string'));
}

function boundedBarrier(promise, label, timeoutMs = 60_000) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}.`)), timeoutMs); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
