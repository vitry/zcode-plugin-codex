// @ts-nocheck
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { resolveModel } from '../../scripts/lib/args.mjs';
import { createZCodeClient } from '../../scripts/lib/zcode-client.mjs';
import { discoverZCode } from '../../scripts/lib/zcode-discovery.mjs';

const skipReason = process.env.ZCODE_REAL_E2E !== '1'
  ? 'unqualified local real E2E: set ZCODE_REAL_E2E=1 on an authenticated macOS ZCode installation'
  : process.platform !== 'darwin'
    ? 'unqualified real E2E: macOS is the only real-CLI-qualified platform'
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
    await rm(temporary, { force: true, recursive: true });
  });
  const discovery = await discoverZCode({ explicitPath: process.env.ZCODE_PATH, env: process.env });
  assert.match(discovery.version, /^\d+\.\d+\.\d+/);

  client = await createZCodeClient({
    workspace: temporary,
    launch: discovery.launch,
    env: process.env,
    requestTimeoutMs: 30_000,
    completionTimeoutMs: 180_000,
  });
  client.setPermissionHandler((request) => request.options.find((option) => option.response?.decision === 'deny')?.response);

  let created;
  try {
    created = await client.createSession({ workspace: temporary });
  } catch (error) {
    assert.fail(`ZCode authentication/readiness failed during session/create: ${error instanceof Error ? error.message : String(error)}`);
  }
  const sessionId = created.session.sessionId;
  sessions.add(sessionId);

  const requestedModel = process.env.ZCODE_REAL_E2E_MODEL;
  if (requestedModel) {
    let aliases = {};
    if (process.env.ZCODE_MODEL_ALIASES) aliases = JSON.parse(process.env.ZCODE_MODEL_ALIASES);
    const model = resolveModel(requestedModel, aliases, created.settings.model.available);
    const selected = await client.setModel(sessionId, model);
    assert.deepEqual(selected.settings.model.current, model);
  }

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
