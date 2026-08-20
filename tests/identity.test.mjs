import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readdir, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';

import { PluginError } from '../scripts/lib/errors.mjs';
import { atomicWriteJson } from '../scripts/lib/fs.mjs';
import { createIdentityStore } from '../scripts/lib/identity.mjs';
import { createInvocationStore } from '../scripts/lib/invocation.mjs';
import { resolveWorkspaceStorage } from '../scripts/lib/workspace.mjs';

const identityModuleUrl = new URL('../scripts/lib/identity.mjs', import.meta.url).href;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'zcode-identity-'));
  const dataRoot = join(root, 'plugin-data');
  const workspaceA = join(root, 'workspace-a');
  const workspaceB = join(root, 'workspace-b');
  await Promise.all([mkdir(workspaceA), mkdir(workspaceB)]);
  return {
    dataRoot,
    identity: createIdentityStore({ dataRoot }),
    root,
    workspaceA,
    workspaceB,
  };
}

/** @param {string} directory */
async function artifactText(directory) {
  /** @type {string[]} */
  const chunks = [];
  /** @param {string} path */
  async function visit(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) await visit(child);
      else chunks.push(await readFile(child, 'utf8'));
    }
  }
  await visit(directory);
  return chunks.join('\n');
}

/** @param {string} dataRoot @param {string} workspace @param {string} sessionId */
async function activeTurnPath(dataRoot, workspace, sessionId) {
  const storage = await resolveWorkspaceStorage({ dataRoot, workspace });
  const workspacePath = await realpath(workspace);
  const key = createHash('sha256').update(JSON.stringify([sessionId, workspacePath])).digest('hex');
  return join(storage.directory, 'identity', 'active-turns', `${key}.json`);
}

/** @param {string} dataRoot @param {string} method @param {unknown[]} args */
function runIdentityChild(dataRoot, method, args) {
  const source = `
    import { createIdentityStore } from ${JSON.stringify(identityModuleUrl)};
    const identity = createIdentityStore({ dataRoot: process.argv[1] });
    const method = process.argv[2];
    const args = JSON.parse(process.argv[3]);
    try {
      await identity[method](...args);
      process.stdout.write('ok');
    } catch (error) {
      process.stdout.write(\`error:\${error.code}\`);
    }
  `;
  const child = spawn(process.execPath, [
    '--input-type=module',
    '--eval',
    source,
    dataRoot,
    method,
    JSON.stringify(args),
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`Identity child timed out: ${method}`));
    }, 5_000);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      if (code !== 0) reject(new Error(`Identity child exited ${code}: ${stderr}`));
      else resolve(stdout);
    });
  });
}

test('caller context is reusable only for its workspace and expires after 30 minutes', async () => {
  const { identity, workspaceA, workspaceB } = await fixture();
  const createdAt = new Date('2026-08-04T00:00:00.000Z');
  const token = await identity.createCallerContext({
    sessionId: 'session-a',
    turnId: 'turn-a',
    workspace: workspaceA,
    permissionMode: 'workspace-write',
    now: createdAt,
  });

  const first = await identity.consumeCallerContext(token, {
    workspace: workspaceA,
    now: new Date(createdAt.getTime() + 1_000),
  });
  const second = await identity.consumeCallerContext(token, {
    workspace: workspaceA,
    now: new Date(createdAt.getTime() + 29 * 60_000),
  });
  assert.equal(first.sessionId, 'session-a');
  assert.equal(first.turnId, 'turn-a');
  assert.deepEqual(second, first);

  await assert.rejects(
    identity.consumeCallerContext(token, { workspace: workspaceB, now: createdAt }),
    (error) => error instanceof PluginError && error.code === 'CALLER_CONTEXT_INVALID',
  );
  await assert.rejects(
    identity.consumeCallerContext(token, {
      workspace: workspaceA,
      now: new Date(createdAt.getTime() + 30 * 60_000),
    }),
    (error) => error instanceof PluginError && error.code === 'CALLER_CONTEXT_EXPIRED',
  );
});

test('caller contexts from interleaved sessions never become a workspace-wide fallback', async () => {
  const { identity, workspaceA } = await fixture();
  const now = new Date('2026-08-04T00:00:00.000Z');
  const [tokenA, tokenB] = await Promise.all([
    identity.createCallerContext({
      sessionId: 'session-a', turnId: 'turn-a', workspace: workspaceA,
      permissionMode: 'read-only', now,
    }),
    identity.createCallerContext({
      sessionId: 'session-b', turnId: 'turn-b', workspace: workspaceA,
      permissionMode: 'workspace-write', now,
    }),
  ]);

  const [contextB, contextA] = await Promise.all([
    identity.consumeCallerContext(tokenB, { workspace: workspaceA, now }),
    identity.consumeCallerContext(tokenA, { workspace: workspaceA, now }),
  ]);
  assert.equal(contextA.sessionId, 'session-a');
  assert.equal(contextA.permissionMode, 'read-only');
  assert.equal(contextB.sessionId, 'session-b');
  assert.equal(contextB.permissionMode, 'workspace-write');
  await assert.rejects(
    identity.consumeCallerContext('forged-token', { workspace: workspaceA, now }),
    (error) => error instanceof PluginError && error.code === 'CALLER_CONTEXT_INVALID',
  );
});

test('current active turns use the lifecycle-bound v2 schema and remain valid without a wall-clock expiry', async () => {
  const { dataRoot, identity, workspaceA, workspaceB } = await fixture();
  const now = new Date('2026-08-04T00:00:00.000Z');
  await identity.beginCallerTurn({ sessionId: 'session-a', turnId: 'turn-a', workspace: workspaceA, permissionMode: 'workspace-write', prompt: '$zcode:rescue --wait repair auth', now });
  await identity.beginCallerTurn({ sessionId: 'session-b', turnId: 'turn-b', workspace: workspaceA, permissionMode: 'read-only', prompt: '$zcode:review --wait', now });

  const expected = {
    version: 2, kind: 'active-turn', sessionId: 'session-a', turnId: 'turn-a', workspace: await realpath(workspaceA), permissionMode: 'workspace-write', prompt: '$zcode:rescue --wait repair auth', createdAt: now.toISOString(),
  };
  for (const elapsed of [30 * 60_000, 60 * 60_000, 24 * 60 * 60_000]) {
    assert.deepEqual(await identity.resolveActiveTurn({ sessionId: 'session-a', workspace: workspaceA, now: new Date(now.getTime() + elapsed) }), expected);
  }
  const stored = JSON.parse(await readFile(await activeTurnPath(dataRoot, workspaceA, 'session-a'), 'utf8'));
  assert.deepEqual(Object.keys(stored).sort(), ['createdAt', 'key', 'kind', 'permissionMode', 'prompt', 'sessionId', 'turnId', 'version', 'workspace']);
  assert.equal(stored.version, 2); assert.equal(stored.kind, 'active-turn'); assert.equal('expiresAt' in stored, false);
  await assert.rejects(identity.resolveActiveTurn({ sessionId: 'missing', workspace: workspaceA, now }), { code: 'ACTIVE_TURN_NOT_FOUND' });
  await assert.rejects(identity.resolveActiveTurn({ sessionId: 'session-a', workspace: workspaceB, now }), { code: 'ACTIVE_TURN_NOT_FOUND' });
});

test('legacy unversioned active turns retain their strict expiry semantics', async () => {
  const { dataRoot, identity, workspaceA } = await fixture(); const createdAt = new Date('2026-08-04T00:00:00.000Z'); const workspace = await realpath(workspaceA);
  const path = await activeTurnPath(dataRoot, workspaceA, 'legacy-session'); const key = basename(path, '.json');
  const legacy = { key, sessionId: 'legacy-session', turnId: 'legacy-turn', workspace, permissionMode: 'default', prompt: 'legacy', createdAt: createdAt.toISOString(), expiresAt: new Date(createdAt.getTime() + 30 * 60_000).toISOString() };
  await atomicWriteJson(path, legacy);
  assert.equal((await identity.resolveActiveTurn({ sessionId: 'legacy-session', workspace: workspaceA, now: new Date(createdAt.getTime() + 29 * 60_000) })).turnId, 'legacy-turn');
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), legacy, 'reading a legacy record must not upgrade it');
  await assert.rejects(identity.resolveActiveTurn({ sessionId: 'legacy-session', workspace: workspaceA, now: new Date(createdAt.getTime() + 30 * 60_000) }), { code: 'ACTIVE_TURN_EXPIRED' });
});

test('active turn schema validation rejects unknown, wrong-kind, expiring-v2, and mixed legacy records', async () => {
  for (const mutate of /** @type {((record: Record<string, any>) => void)[]} */ ([
    (record) => { record.version = 3; },
    (record) => { record.kind = 'caller'; },
    (record) => { record.expiresAt = '2026-08-04T00:30:00.000Z'; },
    (record) => { delete record.version; },
    (record) => { delete record.kind; },
  ])) {
    const { dataRoot, identity, workspaceA } = await fixture(); await identity.beginCallerTurn({ sessionId: 'session-a', turnId: 'turn-a', workspace: workspaceA, permissionMode: 'default', prompt: 'work', now: new Date('2026-08-04T00:00:00.000Z') });
    const path = await activeTurnPath(dataRoot, workspaceA, 'session-a'); const record = JSON.parse(await readFile(path, 'utf8')); mutate(record); await atomicWriteJson(path, record);
    await assert.rejects(identity.resolveActiveTurn({ sessionId: 'session-a', workspace: workspaceA }), { code: 'AUTHORIZATION_RECORD_INVALID' });
  }
});

test('resolveOnlyActiveTurn fails closed when current and unexpired legacy turns are both present', async () => {
  const { dataRoot, identity, workspaceA } = await fixture(); const now = new Date('2026-08-04T00:00:00.000Z'); const workspace = await realpath(workspaceA);
  await identity.beginCallerTurn({ sessionId: 'current', turnId: 'current-turn', workspace: workspaceA, permissionMode: 'default', prompt: 'current', now });
  const path = await activeTurnPath(dataRoot, workspaceA, 'legacy'); const key = basename(path, '.json');
  await atomicWriteJson(path, { key, sessionId: 'legacy', turnId: 'legacy-turn', workspace, permissionMode: 'default', prompt: 'legacy', createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + 60_000).toISOString() });
  await assert.rejects(identity.resolveOnlyActiveTurn({ workspace: workspaceA, now }), (error) => error instanceof PluginError && error.code === 'SETUP_SESSION_UNPROVEN' && error.details.activeTurnCount === 2);
  assert.equal((await identity.resolveOnlyActiveTurn({ workspace: workspaceA, now: new Date(now.getTime() + 60_000) })).turnId, 'current-turn');
});

test('endCallerTurn accepts current and legacy records and deletes only the exact turn', async () => {
  for (const schema of ['current', 'legacy']) {
    const { dataRoot, identity, workspaceA } = await fixture(); const input = { sessionId: `${schema}-session`, turnId: `${schema}-turn`, workspace: workspaceA, permissionMode: 'default', prompt: schema }; const path = await activeTurnPath(dataRoot, workspaceA, input.sessionId);
    await identity.beginCallerTurn(input);
    if (schema === 'legacy') { const current = JSON.parse(await readFile(path, 'utf8')); delete current.version; delete current.kind; current.expiresAt = new Date(Date.parse(current.createdAt) + 30 * 60_000).toISOString(); await atomicWriteJson(path, current); }
    await identity.endCallerTurn({ sessionId: input.sessionId, turnId: 'other-turn', workspace: workspaceA });
    assert.equal((await identity.resolveActiveTurn({ sessionId: input.sessionId, workspace: workspaceA })).turnId, input.turnId);
    await identity.endCallerTurn({ sessionId: input.sessionId, turnId: input.turnId, workspace: workspaceA });
    await assert.rejects(identity.resolveActiveTurn({ sessionId: input.sessionId, workspace: workspaceA }), { code: 'ACTIVE_TURN_NOT_FOUND' });
  }
});

test('pending invocation choices preserve the exact originating turn, workspace, and permission snapshot', async () => {
  const { dataRoot, workspaceA, workspaceB } = await fixture();
  const { createInvocationStore } = await import('../scripts/lib/invocation.mjs');
  const pending = createInvocationStore({ dataRoot });
  const now = new Date('2026-08-04T00:00:00.000Z');
  const candidateJobId = 'd'.repeat(64);
  await pending.savePending({ sessionId: 'session-a', turnId: 'turn-a', workspace: workspaceA, permissionMode: 'workspace-write', command: 'rescue', source: 'proactive', executorAgentId: 'rescue-child', spec: { argv: ['rescue', 'literal task'] }, routeKind: 'legacy', candidateJobId, now });
  await assert.rejects(
    pending.consumePending({ sessionId: 'session-b', workspace: workspaceA, command: 'rescue', choice: 'resume', executorAgentId: 'rescue-child', now }),
    (error) => error instanceof PluginError && error.code === 'PENDING_INVOCATION_NOT_FOUND' && error.remedy === 'Repeat the original command in this Codex thread.',
  );
  await assert.rejects(
    pending.consumePending({ sessionId: 'session-a', workspace: workspaceB, command: 'rescue', choice: 'resume', executorAgentId: 'rescue-child', now }),
    (error) => error instanceof PluginError && error.code === 'PENDING_INVOCATION_NOT_FOUND' && error.remedy === 'Repeat the original command in this Codex thread.',
  );
  await assert.rejects(pending.consumePending({ sessionId: 'session-a', workspace: workspaceA, command: 'rescue', choice: 'resume', executorAgentId: 'sibling-child', now }), { code: 'PENDING_INVOCATION_NOT_FOUND' });
  assert.deepEqual(await pending.consumePending({ sessionId: 'session-a', workspace: workspaceA, command: 'rescue', choice: 'resume', executorAgentId: 'rescue-child', now }), {
    argv: ['rescue', '--resume', 'literal task'],
    source: 'proactive',
    caller: { sessionId: 'session-a', turnId: 'turn-a', workspace: await realpath(workspaceA), permissionMode: 'workspace-write' },
    route: { routeKind: 'legacy', candidateJobId },
  });
  await assert.rejects(
    pending.consumePending({ sessionId: 'session-a', workspace: workspaceA, command: 'rescue', choice: 'fresh', executorAgentId: 'rescue-child', now }),
    (error) => error instanceof PluginError && error.code === 'PENDING_INVOCATION_NOT_FOUND' && error.remedy === 'Repeat the original command in this Codex thread.',
  );
});

test('pending bound Rescue choices persist exact private route snapshots and return them only internally', async () => {
  const { dataRoot, workspaceA } = await fixture(); const pending = createInvocationStore({ dataRoot });
  const candidateJobId = 'a'.repeat(64); const expectedOperationId = 'b'.repeat(64); const expectedCurrentJobId = 'c'.repeat(64);
  await pending.savePending({
    sessionId: 'session-a', turnId: 'turn-a', workspace: workspaceA, permissionMode: 'workspace-write', command: 'rescue',
    source: 'explicit', executorAgentId: 'rescue-child', spec: { argv: ['rescue', 'task'] }, routeKind: 'bound',
    candidateJobId, expectedOperationId, expectedCurrentJobId,
  });
  const storage = await resolveWorkspaceStorage({ dataRoot, workspace: workspaceA }); const directory = join(storage.directory, 'invocations', 'pending'); const [name] = await readdir(directory);
  const record = JSON.parse(await readFile(join(directory, name), 'utf8'));
  assert.equal(record.version, 2); assert.equal(record.routeKind, 'bound'); assert.equal(record.candidateJobId, candidateJobId);
  assert.equal(record.expectedOperationId, expectedOperationId); assert.equal(record.expectedCurrentJobId, expectedCurrentJobId);
  const consumed = await pending.consumePending({ sessionId: 'session-a', workspace: workspaceA, command: 'rescue', choice: 'resume', executorAgentId: 'rescue-child' });
  assert.deepEqual(consumed.route, { routeKind: 'bound', candidateJobId, expectedOperationId, expectedCurrentJobId });
});

test('non-Rescue pending choices retain their public schema across the pending version upgrade', async () => {
  const { dataRoot, workspaceA } = await fixture(); const pending = createInvocationStore({ dataRoot });
  await pending.savePending({ sessionId: 'session-a', turnId: 'turn-a', workspace: workspaceA, permissionMode: 'workspace-write', command: 'review', spec: { argv: ['review'] } });
  assert.deepEqual(await pending.consumePending({ sessionId: 'session-a', workspace: workspaceA, command: 'review', choice: 'wait' }), {
    argv: ['review', '--wait'], caller: { sessionId: 'session-a', turnId: 'turn-a', workspace: await realpath(workspaceA), permissionMode: 'workspace-write' },
  });
});

test('expired pending Rescue choice is deleted and fails with an actionable recovery', async () => {
  const { dataRoot, workspaceA } = await fixture();
  const { createInvocationStore } = await import('../scripts/lib/invocation.mjs');
  const pending = createInvocationStore({ dataRoot });
  const now = new Date('2026-08-04T00:00:00.000Z');
  await pending.savePending({ sessionId: 'session-a', turnId: 'turn-a', workspace: workspaceA, permissionMode: 'workspace-write', command: 'rescue', executorAgentId: 'rescue-child', spec: { argv: ['rescue', 'literal task'] }, now });
  await assert.rejects(
    pending.consumePending({ sessionId: 'session-a', workspace: workspaceA, command: 'rescue', choice: 'fresh', executorAgentId: 'rescue-child', now: new Date(now.getTime() + 30 * 60_000) }),
    (error) => error instanceof PluginError && error.code === 'PENDING_INVOCATION_EXPIRED' && typeof error.remedy === 'string' && error.remedy.length > 0,
  );
  await assert.rejects(
    pending.consumePending({ sessionId: 'session-a', workspace: workspaceA, command: 'rescue', choice: 'fresh', executorAgentId: 'rescue-child', now }),
    { code: 'PENDING_INVOCATION_NOT_FOUND' },
  );
});

test('legacy pending Rescue without an executor binding is atomically rejected and deleted', async () => {
  const { dataRoot, workspaceA } = await fixture();
  const { createInvocationStore } = await import('../scripts/lib/invocation.mjs');
  const pending = createInvocationStore({ dataRoot });
  await pending.savePending({ sessionId: 'session-a', turnId: 'turn-a', workspace: workspaceA, permissionMode: 'workspace-write', command: 'rescue', executorAgentId: 'rescue-child', spec: { argv: ['rescue', 'literal task'] } });
  const storage = await resolveWorkspaceStorage({ dataRoot, workspace: workspaceA }); const directory = join(storage.directory, 'invocations', 'pending'); const [name] = await readdir(directory);
  const legacy = JSON.parse(await readFile(join(directory, name), 'utf8')); delete legacy.version; delete legacy.source; delete legacy.executorAgentId; await atomicWriteJson(join(directory, name), legacy);
  await assert.rejects(
    pending.consumePending({ sessionId: 'session-a', workspace: workspaceA, command: 'rescue', choice: 'resume', executorAgentId: 'rescue-child' }),
    (error) => error instanceof PluginError && error.code === 'PENDING_INVOCATION_INCOMPATIBLE' && /Repeat the original Rescue command/.test(error.remedy),
  );
  await assert.rejects(pending.consumePending({ sessionId: 'session-a', workspace: workspaceA, command: 'rescue', choice: 'resume', executorAgentId: 'rescue-child' }), { code: 'PENDING_INVOCATION_NOT_FOUND' });
});

test('legacy executor-bound pending Rescue without source remains explicit', async () => {
  const { dataRoot, workspaceA } = await fixture();
  const { createInvocationStore } = await import('../scripts/lib/invocation.mjs');
  const pending = createInvocationStore({ dataRoot });
  await pending.savePending({ sessionId: 'session-a', turnId: 'turn-a', workspace: workspaceA, permissionMode: 'workspace-write', command: 'rescue', source: 'proactive', executorAgentId: 'rescue-child', spec: { argv: ['rescue', 'literal task'] } });
  const storage = await resolveWorkspaceStorage({ dataRoot, workspace: workspaceA }); const directory = join(storage.directory, 'invocations', 'pending'); const [name] = await readdir(directory);
  const legacy = JSON.parse(await readFile(join(directory, name), 'utf8')); delete legacy.version; delete legacy.source; await atomicWriteJson(join(directory, name), legacy);
  assert.deepEqual(await pending.consumePending({ sessionId: 'session-a', workspace: workspaceA, command: 'rescue', choice: 'fresh', executorAgentId: 'rescue-child' }), {
    argv: ['rescue', '--fresh', 'literal task'], source: 'explicit',
    caller: { sessionId: 'session-a', turnId: 'turn-a', workspace: await realpath(workspaceA), permissionMode: 'workspace-write' },
  });
});

test('ending an active turn does not hide corrupted private identity state', async () => {
  const { dataRoot, identity, workspaceA } = await fixture();
  await identity.beginCallerTurn({ sessionId: 'session-a', turnId: 'turn-a', workspace: workspaceA, permissionMode: 'default', prompt: 'work' });
  const storage = await resolveWorkspaceStorage({ dataRoot, workspace: workspaceA }); const directory = join(storage.directory, 'identity', 'active-turns'); const [name] = await readdir(directory);
  await atomicWriteJson(join(directory, name), { corrupted: true });
  await assert.rejects(identity.endCallerTurn({ sessionId: 'session-a', turnId: 'turn-a', workspace: workspaceA }), { code: 'AUTHORIZATION_RECORD_INVALID' });
});

test('execution capability is exact-match and atomically single-use', async () => {
  const { identity, workspaceA, workspaceB } = await fixture();
  const expected = {
    jobId: 'job-a',
    ownerSessionId: 'session-a',
    workspace: workspaceA,
    operation: 'run-reserved-job',
    specDigest: 'a'.repeat(64),
  };
  const token = await identity.createExecutionCapability({
    ...expected,
    permissionSnapshot: { permissionMode: 'workspace-write' },
  });

  await assert.rejects(
    identity.consumeExecutionCapability(token, { ...expected, jobId: 'forged-job' }),
    (error) => error instanceof PluginError && error.code === 'EXECUTION_CAPABILITY_MISMATCH',
  );
  await assert.rejects(
    identity.consumeExecutionCapability(token, { ...expected, ownerSessionId: 'session-b' }),
    (error) => error instanceof PluginError && error.code === 'EXECUTION_CAPABILITY_MISMATCH',
  );
  await assert.rejects(
    identity.consumeExecutionCapability(token, { ...expected, workspace: workspaceB }),
    (error) => error instanceof PluginError && error.code === 'EXECUTION_CAPABILITY_INVALID',
  );

  const attempts = await Promise.allSettled([
    identity.consumeExecutionCapability(token, expected),
    identity.consumeExecutionCapability(token, expected),
  ]);
  assert.equal(attempts.filter(({ status }) => status === 'fulfilled').length, 1);
  assert.equal(attempts.filter(({ status }) => status === 'rejected').length, 1);
  const success = attempts.find(({ status }) => status === 'fulfilled');
  assert.ok(success && success.status === 'fulfilled');
  assert.equal(success.value.jobId, 'job-a');
  assert.deepEqual(success.value.permissionSnapshot, { permissionMode: 'workspace-write' });
  assert.equal(JSON.stringify(success.value).includes(token), false);
});

test('revocation preserves consumed outcomes for legacy and spec-bound capabilities', async () => {
  for (const expected of [
    { jobId: 'legacy-job', ownerSessionId: 'session-a', operation: 'continue' },
    { jobId: 'spec-job', ownerSessionId: 'session-a', operation: 'run-reserved-job', specDigest: 'c'.repeat(64) },
  ]) {
    const { identity, workspaceA } = await fixture(); const binding = { ...expected, workspace: workspaceA };
    const token = await identity.createExecutionCapability({ ...binding, permissionSnapshot: { permissionMode: 'workspace-write' } });
    await identity.consumeExecutionCapability(token, binding);
    await assert.rejects(identity.revokeExecutionCapability(token, binding), { code: 'EXECUTION_CAPABILITY_CONSUMED' });
    await assert.rejects(identity.consumeExecutionCapability(token, binding), { code: 'EXECUTION_CAPABILITY_CONSUMED' });
  }
});

test('revocation durably tombstones unconsumed legacy and spec-bound capabilities', async () => {
  for (const expected of [
    { jobId: 'legacy-job', ownerSessionId: 'session-a', operation: 'continue' },
    { jobId: 'spec-job', ownerSessionId: 'session-a', operation: 'run-reserved-job', specDigest: 'd'.repeat(64) },
  ]) {
    const { dataRoot, identity, workspaceA } = await fixture(); const binding = { ...expected, workspace: workspaceA };
    const token = await identity.createExecutionCapability({ ...binding, permissionSnapshot: { permissionMode: 'workspace-write' } }); await identity.revokeExecutionCapability(token, binding);
    const storage = await resolveWorkspaceStorage({ dataRoot, workspace: workspaceA }); const path = join(storage.directory, 'identity', 'capabilities', `${createHash('sha256').update(token).digest('hex')}.json`);
    const first = JSON.parse(await readFile(path, 'utf8')); assert.equal(first.consumedAt, null); assert.ok(Date.parse(first.revokedAt));
    const reopened = createIdentityStore({ dataRoot }); await assert.rejects(reopened.consumeExecutionCapability(token, binding), { code: 'EXECUTION_CAPABILITY_REVOKED' });
    await reopened.revokeExecutionCapability(token, binding); const second = JSON.parse(await readFile(path, 'utf8')); assert.equal(second.revokedAt, first.revokedAt);
    await assert.rejects(reopened.consumeExecutionCapability(token, binding), { code: 'EXECUTION_CAPABILITY_REVOKED' });
  }
});

test('execution records written before revokedAt remain compatible as unrevoked', async () => {
  const { dataRoot, identity, workspaceA } = await fixture(); const binding = { jobId: 'pre-revocation-field', ownerSessionId: 'session-a', workspace: workspaceA, operation: 'continue' };
  const token = await identity.createExecutionCapability({ ...binding, permissionSnapshot: { permissionMode: 'workspace-write' } }); const storage = await resolveWorkspaceStorage({ dataRoot, workspace: workspaceA });
  const path = join(storage.directory, 'identity', 'capabilities', `${createHash('sha256').update(token).digest('hex')}.json`); const legacy = JSON.parse(await readFile(path, 'utf8')); delete legacy.revokedAt; await atomicWriteJson(path, legacy);
  assert.equal((await createIdentityStore({ dataRoot }).consumeExecutionCapability(token, binding)).jobId, binding.jobId);
});

test('execution capabilities cannot be double-consumed across child processes', async () => {
  const { dataRoot, identity, workspaceA } = await fixture();
  const expected = {
    jobId: 'job-multiprocess',
    ownerSessionId: 'session-a',
    workspace: workspaceA,
    operation: 'continue',
    specDigest: 'b'.repeat(64),
  };
  const token = await identity.createExecutionCapability({
    ...expected,
    permissionSnapshot: { mode: 'workspace-write' },
  });

  const results = await Promise.all([
    runIdentityChild(dataRoot, 'consumeExecutionCapability', [token, expected]),
    runIdentityChild(dataRoot, 'consumeExecutionCapability', [token, expected]),
  ]);
  assert.deepEqual(results.sort(), ['error:EXECUTION_CAPABILITY_CONSUMED', 'ok']);
});

test('gate baseline binds session, turn, and workspace and rejects replay', async () => {
  const { identity, workspaceA, workspaceB } = await fixture();
  await identity.recordGateBaseline({
    sessionId: 'session-a',
    turnId: 'turn-a',
    workspace: workspaceA,
  });

  await assert.rejects(
    identity.consumeGateBaseline({
      sessionId: 'session-a', turnId: 'forged-turn', workspace: workspaceA,
    }),
    (error) => error instanceof PluginError && error.code === 'GATE_BASELINE_NOT_FOUND',
  );
  await assert.rejects(
    identity.consumeGateBaseline({
      sessionId: 'session-b', turnId: 'turn-a', workspace: workspaceA,
    }),
    (error) => error instanceof PluginError && error.code === 'GATE_BASELINE_NOT_FOUND',
  );
  await assert.rejects(
    identity.consumeGateBaseline({
      sessionId: 'session-a', turnId: 'turn-a', workspace: workspaceB,
    }),
    (error) => error instanceof PluginError && error.code === 'GATE_BASELINE_NOT_FOUND',
  );

  const baseline = await identity.consumeGateBaseline({
    sessionId: 'session-a', turnId: 'turn-a', workspace: workspaceA,
  });
  assert.equal(baseline.sessionId, 'session-a');
  await assert.rejects(
    identity.consumeGateBaseline({
      sessionId: 'session-a', turnId: 'turn-a', workspace: workspaceA,
    }),
    (error) => error instanceof PluginError && error.code === 'GATE_BASELINE_CONSUMED',
  );
});

test('gate baseline is create-only under concurrency and cannot be rebuilt after consumption', async () => {
  const { identity, workspaceA } = await fixture();
  const baselineIdentity = {
    sessionId: 'session-a',
    turnId: 'turn-a',
    workspace: workspaceA,
  };

  const creations = await Promise.allSettled([
    identity.recordGateBaseline(baselineIdentity),
    identity.recordGateBaseline(baselineIdentity),
  ]);
  assert.equal(creations.filter(({ status }) => status === 'fulfilled').length, 1);
  const duplicate = creations.find(({ status }) => status === 'rejected');
  assert.ok(duplicate && duplicate.status === 'rejected');
  assert.equal(duplicate.reason.code, 'GATE_BASELINE_EXISTS');

  await identity.consumeGateBaseline(baselineIdentity);
  await assert.rejects(
    identity.recordGateBaseline(baselineIdentity),
    (error) => error instanceof PluginError && error.code === 'GATE_BASELINE_EXISTS',
  );
});

test('gate baselines cannot be double-consumed across child processes', async () => {
  const { dataRoot, identity, workspaceA } = await fixture();
  const baselineIdentity = {
    sessionId: 'session-multiprocess',
    turnId: 'turn-multiprocess',
    workspace: workspaceA,
  };
  await identity.recordGateBaseline(baselineIdentity);

  const results = await Promise.all([
    runIdentityChild(dataRoot, 'consumeGateBaseline', [baselineIdentity]),
    runIdentityChild(dataRoot, 'consumeGateBaseline', [baselineIdentity]),
  ]);
  assert.deepEqual(results.sort(), ['error:GATE_BASELINE_CONSUMED', 'ok']);
});

test('authorization artifacts contain digests but never plaintext random tokens', async () => {
  const { dataRoot, identity, workspaceA } = await fixture();
  const callerToken = await identity.createCallerContext({
    sessionId: 'session-a', turnId: 'turn-a', workspace: workspaceA,
    permissionMode: 'read-only', now: new Date(),
  });
  const capabilityToken = await identity.createExecutionCapability({
    jobId: 'job-a', ownerSessionId: 'session-a', workspace: workspaceA,
    operation: 'continue', permissionSnapshot: { mode: 'read-only' },
  });

  assert.match(callerToken, /^[A-Za-z0-9_-]{43}$/);
  assert.match(capabilityToken, /^[A-Za-z0-9_-]{43}$/);
  const artifacts = await artifactText(dataRoot);
  assert.equal(artifacts.includes(callerToken), false);
  assert.equal(artifacts.includes(capabilityToken), false);
});

test('caller turn lifecycle revokes exact older and completed turns without touching siblings', async () => {
  const { identity, workspaceA } = await fixture(); const base = { workspace: workspaceA, permissionMode: 'default' };
  const old = await identity.beginCallerTurn({ ...base, sessionId: 'owner', turnId: 'turn-1' }); const sibling = await identity.beginCallerTurn({ ...base, sessionId: 'sibling', turnId: 'turn-sibling' }); const current = await identity.beginCallerTurn({ ...base, sessionId: 'owner', turnId: 'turn-2' });
  await assert.rejects(identity.consumeCallerContext(old, { workspace: workspaceA }), { code: 'CALLER_CONTEXT_INVALID' }); assert.equal((await identity.consumeCallerContext(current, { workspace: workspaceA })).turnId, 'turn-2'); assert.equal((await identity.consumeCallerContext(sibling, { workspace: workspaceA })).sessionId, 'sibling');
  await identity.endCallerTurn({ sessionId: 'owner', turnId: 'turn-2', workspace: workspaceA }); await assert.rejects(identity.consumeCallerContext(current, { workspace: workspaceA }), { code: 'CALLER_CONTEXT_INVALID' }); assert.equal((await identity.consumeCallerContext(sibling, { workspace: workspaceA })).turnId, 'turn-sibling');
});

test('identity creation rejects missing identities and uncontrolled modes or operations', async () => {
  const { identity, workspaceA } = await fixture();
  const caller = {
    sessionId: 'session-a', turnId: 'turn-a', workspace: workspaceA,
    permissionMode: 'read-only', now: new Date(),
  };
  for (const invalid of /** @type {any[]} */ ([
    { ...caller, sessionId: '' },
    { ...caller, turnId: undefined },
    { ...caller, permissionMode: 'god-mode' },
  ])) {
    await assert.rejects(
      identity.createCallerContext(invalid),
      (error) => error instanceof PluginError && error.code === 'IDENTITY_INPUT_INVALID',
    );
  }
  const capability = {
    jobId: 'job-a', ownerSessionId: 'session-a', workspace: workspaceA,
    operation: 'rescue', permissionSnapshot: { mode: 'read-only' },
  };
  for (const invalid of /** @type {any[]} */ ([
    { ...capability, jobId: undefined },
    { ...capability, ownerSessionId: '' },
    { ...capability, operation: 'arbitrary-shell' },
    { ...capability, permissionSnapshot: [] },
  ])) {
    await assert.rejects(
      identity.createExecutionCapability(invalid),
      (error) => error instanceof PluginError && error.code === 'IDENTITY_INPUT_INVALID',
    );
  }
});

test('identity consumption validates expected identities before storage access', async () => {
  const { identity, workspaceA } = await fixture();
  await assert.rejects(
    identity.consumeExecutionCapability('token', /** @type {any} */ (undefined)),
    (error) => error instanceof PluginError && error.code === 'IDENTITY_INPUT_INVALID',
  );
  await assert.rejects(
    identity.consumeExecutionCapability('token', {
      jobId: '', ownerSessionId: 'session-a', workspace: workspaceA, operation: 'rescue',
    }),
    (error) => error instanceof PluginError && error.code === 'IDENTITY_INPUT_INVALID',
  );
  await assert.rejects(
    identity.consumeGateBaseline({ sessionId: 'session-a', turnId: '', workspace: workspaceA }),
    (error) => error instanceof PluginError && error.code === 'IDENTITY_INPUT_INVALID',
  );
});

test('corrupted persisted authorization records fail closed before comparison', async () => {
  const { dataRoot, identity, workspaceA } = await fixture();
  const storage = await resolveWorkspaceStorage({ dataRoot, workspace: workspaceA });
  const token = await identity.createCallerContext({
    sessionId: 'session-a', turnId: 'turn-a', workspace: workspaceA,
    permissionMode: 'read-only', now: new Date(),
  });
  const digest = createHash('sha256').update(token).digest('hex');
  await atomicWriteJson(join(storage.directory, 'identity', 'callers', `${digest}.json`), {
    digest,
    sessionId: 123,
  });
  await assert.rejects(
    identity.consumeCallerContext(token, { workspace: workspaceA, now: new Date() }),
    (error) => error instanceof PluginError && error.code === 'AUTHORIZATION_RECORD_INVALID',
  );
});
