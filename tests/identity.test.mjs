import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { PluginError } from '../scripts/lib/errors.mjs';
import { createIdentityStore } from '../scripts/lib/identity.mjs';

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

test('execution capability is exact-match and atomically single-use', async () => {
  const { identity, workspaceA, workspaceB } = await fixture();
  const expected = {
    jobId: 'job-a',
    ownerSessionId: 'session-a',
    workspace: workspaceA,
    operation: 'continue',
  };
  const token = await identity.createExecutionCapability({
    ...expected,
    permissionSnapshot: { mode: 'workspace-write' },
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
});

test('execution capabilities cannot be double-consumed across child processes', async () => {
  const { dataRoot, identity, workspaceA } = await fixture();
  const expected = {
    jobId: 'job-multiprocess',
    ownerSessionId: 'session-a',
    workspace: workspaceA,
    operation: 'continue',
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
