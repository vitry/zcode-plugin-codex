import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, mkdir, readdir, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { PluginError } from '../scripts/lib/errors.mjs';
import { atomicWriteJson } from '../scripts/lib/fs.mjs';
import { createIdentityStore } from '../scripts/lib/identity.mjs';
import { createInvocationStore } from '../scripts/lib/invocation.mjs';
import { resolveWorkspaceStorage } from '../scripts/lib/workspace.mjs';

const identityModuleUrl = new URL('../scripts/lib/identity.mjs', import.meta.url).href;
const execFile = promisify(execFileCallback);

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

/** @param {string} dataRoot @param {string} workspace @param {string} token */
async function callerContextPath(dataRoot, workspace, token) {
  const storage = await resolveWorkspaceStorage({ dataRoot, workspace });
  const digest = createHash('sha256').update(token).digest('hex');
  return join(storage.directory, 'identity', 'callers', `${digest}.json`);
}

/** @param {string} dataRoot @param {string} workspace */
async function callerArtifactNames(dataRoot, workspace) {
  const storage = await resolveWorkspaceStorage({ dataRoot, workspace });
  try { return await readdir(join(storage.directory, 'identity', 'callers')); }
  catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error)?.code === 'ENOENT') return [];
    throw error;
  }
}

/** @param {string} root */
async function linkedWorktreeFixture(root) {
  const origin = join(root, 'origin');
  const execution = join(root, 'execution');
  await mkdir(origin);
  await execFile('git', ['init', '-q'], { cwd: origin });
  await execFile('git', ['config', 'user.email', 'identity@example.test'], { cwd: origin });
  await execFile('git', ['config', 'user.name', 'Identity Test'], { cwd: origin });
  await execFile('git', ['commit', '--allow-empty', '-qm', 'initial'], { cwd: origin });
  await execFile('git', ['worktree', 'add', '-q', '-b', 'execution', execution], { cwd: origin });
  return { origin, execution };
}

/** @param {string} dataRoot */
async function globalIdentityArtifacts(dataRoot) {
  const directory = join(await realpath(dataRoot), 'identity-lifecycle');
  const activeNames = await readdir(join(directory, 'active-turns'));
  const sessionNames = await readdir(join(directory, 'sessions'));
  assert.equal(activeNames.length, 1);
  assert.equal(sessionNames.length, 1);
  return {
    activePath: join(directory, 'active-turns', activeNames[0]),
    sessionPath: join(directory, 'sessions', sessionNames[0]),
  };
}

/** @param {string} dataRoot @param {string} sessionId */
async function globalActivePath(dataRoot, sessionId) {
  const key = createHash('sha256').update(JSON.stringify([sessionId])).digest('hex');
  return join(await realpath(dataRoot), 'identity-lifecycle', 'active-turns', `${key}.json`);
}

/** @param {string} dataRoot @param {string} sessionId */
async function globalSessionPath(dataRoot, sessionId) {
  const key = createHash('sha256').update(JSON.stringify([sessionId])).digest('hex');
  return join(await realpath(dataRoot), 'identity-lifecycle', 'sessions', `${key}.json`);
}

/** @param {string} dataRoot @param {any} input */
async function createOrphanPending(dataRoot, input) {
  let injected = false;
  const failing = createIdentityStore({
    dataRoot,
    publicationSeam: async (point) => {
      if (!injected && point === 'after-begin-pending-write') { injected = true; throw new Error('injected pending/ledger gap'); }
    },
  });
  await assert.rejects(failing.beginCallerTurn(input), /injected pending\/ledger gap/);
  const activePath = await globalActivePath(dataRoot, input.sessionId);
  const active = JSON.parse(await readFile(activePath, 'utf8'));
  await assert.rejects(readFile(await globalSessionPath(dataRoot, input.sessionId), 'utf8'), { code: 'ENOENT' });
  return { active, activePath };
}

function deferred() {
  /** @type {(value?:unknown)=>void} */ let resolvePromise = () => {};
  const promise = new Promise((resolve) => { resolvePromise = resolve; });
  return { promise, resolve: resolvePromise };
}

/** @param {Promise<unknown>} signal @param {string} message */
async function waitForTestSignal(signal, message) {
  /** @type {NodeJS.Timeout|undefined} */ let timer;
  try {
    await Promise.race([
      signal,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), 10_000); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
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

test('session proof creates exact private global v3 identity records without changing the caller token contract', async () => {
  const { dataRoot, identity, root } = await fixture();
  const { origin } = await linkedWorktreeFixture(root);
  const now = new Date('2026-08-20T12:00:00.000Z');
  const token = await identity.beginCallerTurn({
    sessionId: 'session-proof', turnId: 'turn-a', workspace: origin,
    permissionMode: 'workspace-write', prompt: 'repair', now,
    sessionStartedAt: '2026-08-20T11:59:00.000Z', sessionSource: 'startup',
  });
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  const { activePath, sessionPath } = await globalIdentityArtifacts(dataRoot);
  const active = JSON.parse(await readFile(activePath, 'utf8'));
  const originPath = await realpath(origin);
  assert.deepEqual(Object.keys(active).sort(), [
    'createdAt', 'executionWorkspace', 'generationId', 'key', 'kind', 'originWorkspace',
    'permissionMode', 'prompt', 'sessionId', 'status', 'turnId', 'version',
  ]);
  assert.match(active.generationId, /^[a-f0-9]{64}$/);
  assert.deepEqual({ ...active, key: '<key>', generationId: '<generation>' }, {
    version: 3, kind: 'active-turn', key: '<key>', sessionId: 'session-proof', generationId: '<generation>', turnId: 'turn-a',
    originWorkspace: originPath, executionWorkspace: null, permissionMode: 'workspace-write',
    prompt: 'repair', createdAt: now.toISOString(), status: 'active',
  });
  const ledger = JSON.parse(await readFile(sessionPath, 'utf8'));
  assert.deepEqual({ ...ledger, key: '<key>', updatedAt: '<time>' }, {
    version: 1, kind: 'identity-session', key: '<key>', sessionId: 'session-proof',
    sessionStartedAt: '2026-08-20T11:59:00.000Z', sessionSource: 'startup',
    knownWorkspaces: [originPath], endedAt: null, updatedAt: '<time>',
  });
  const caller = JSON.parse(await readFile(await callerContextPath(dataRoot, origin, token), 'utf8'));
  assert.deepEqual(Object.keys(caller).sort(), [
    'createdAt', 'digest', 'expiresAt', 'generationId', 'kind', 'permissionMode',
    'sessionId', 'turnId', 'version', 'workspace',
  ]);
  assert.equal(caller.version, 1); assert.equal(caller.kind, 'caller-context');
  assert.equal(caller.generationId, active.generationId); assert.equal('token' in caller, false);
  const consumed = await identity.consumeCallerContext(token, { workspace: origin, now });
  assert.equal('version' in consumed, false); assert.equal('generationId' in consumed, false);
  const activeDirectoryStat = await stat(dirname(activePath));
  const activeStat = await stat(activePath);
  const sessionStat = await stat(sessionPath);
  if (process.platform === 'win32') {
    assert.equal(activeDirectoryStat.isDirectory(), true);
    assert.equal(activeStat.isFile(), true);
    assert.equal(sessionStat.isFile(), true);
  } else {
    assert.equal(activeDirectoryStat.mode & 0o777, 0o700);
    assert.equal(activeStat.mode & 0o777, 0o600);
    assert.equal(sessionStat.mode & 0o777, 0o600);
  }
  assert.deepEqual(await identity.resolveActiveTurn({ sessionId: 'session-proof', workspace: origin }), {
    version: 2, kind: 'active-turn', sessionId: 'session-proof', turnId: 'turn-a',
    workspace: originPath, permissionMode: 'workspace-write', prompt: 'repair', createdAt: now.toISOString(),
  });
});

test('proved begin publishes one operation timestamp across active and session records', async () => {
  const { dataRoot, identity, workspaceA } = await fixture();
  const startedAt = '2026-08-20T11:59:00.000Z';
  let reads = 0;
  const input = {
    sessionId: 'session-clock', turnId: 'turn-a', workspace: workspaceA,
    permissionMode: 'workspace-write', prompt: 'first',
    sessionStartedAt: startedAt, sessionSource: 'startup',
    get now() {
      const timestamp = reads === 0 ? '2026-08-20T12:00:00.000Z' : '2026-08-20T11:58:00.000Z';
      reads += 1; return new Date(timestamp);
    },
  };

  await identity.beginCallerTurn(input);
  const active = JSON.parse(await readFile(await globalActivePath(dataRoot, input.sessionId), 'utf8'));
  const ledger = JSON.parse(await readFile(await globalSessionPath(dataRoot, input.sessionId), 'utf8'));
  assert.equal(reads, 1);
  assert.ok(Date.parse(active.createdAt) >= Date.parse(startedAt));
  assert.equal(ledger.updatedAt, active.createdAt);

  await identity.beginCallerTurn({
    ...input, turnId: 'turn-b', prompt: 'second', now: '2026-08-20T12:00:01.000Z',
  });
  assert.equal((await identity.resolveActiveTurn({ sessionId: input.sessionId, workspace: workspaceA })).turnId, 'turn-b');
});

test('public caller creation binds to an exact active v3 generation without changing consumption', async () => {
  const { dataRoot, identity, workspaceA } = await fixture();
  const input = {
    sessionId: 'session-a', turnId: 'turn-a', workspace: workspaceA,
    permissionMode: 'workspace-write', now: new Date('2026-08-20T12:00:00.000Z'),
  };
  await identity.beginCallerTurn({
    ...input, prompt: 'repair',
    sessionStartedAt: '2026-08-20T11:59:00.000Z', sessionSource: 'startup',
  });

  const token = await identity.createCallerContext(input);
  const active = JSON.parse(await readFile(await globalActivePath(dataRoot, input.sessionId), 'utf8'));
  const caller = JSON.parse(await readFile(await callerContextPath(dataRoot, workspaceA, token), 'utf8'));
  assert.equal(caller.version, 1);
  assert.equal(caller.kind, 'caller-context');
  assert.equal(caller.generationId, active.generationId);
  assert.deepEqual(await identity.consumeCallerContext(token, { workspace: workspaceA, now: input.now }), {
    sessionId: input.sessionId,
    turnId: input.turnId,
    workspace: await realpath(workspaceA),
    permissionMode: input.permissionMode,
    createdAt: input.now.toISOString(),
    expiresAt: new Date(input.now.getTime() + 30 * 60_000).toISOString(),
  });
});

test('public caller creation preserves exact legacy bytes and 30 minute TTL when lifecycle is truly absent', async () => {
  const { dataRoot, identity, workspaceA } = await fixture();
  const now = new Date('2026-08-20T12:00:00.000Z');
  const input = {
    sessionId: 'legacy-session', turnId: 'legacy-turn', workspace: workspaceA,
    permissionMode: 'default', now,
  };
  const token = await identity.createCallerContext(input);
  const path = await callerContextPath(dataRoot, workspaceA, token);
  const expected = {
    digest: createHash('sha256').update(token).digest('hex'),
    sessionId: input.sessionId,
    turnId: input.turnId,
    workspace: await realpath(workspaceA),
    permissionMode: input.permissionMode,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 30 * 60_000).toISOString(),
  };
  assert.equal(await readFile(path, 'utf8'), `${JSON.stringify(expected, null, 2)}\n`);
  const callerStat = await stat(path);
  if (process.platform === 'win32') assert.equal(callerStat.isFile(), true);
  else assert.equal(callerStat.mode & 0o777, 0o600);
  const lifecycle = join(await realpath(dataRoot), 'identity-lifecycle');
  assert.deepEqual(await readdir(join(lifecycle, 'active-turns')), []);
  assert.deepEqual(await readdir(join(lifecycle, 'sessions')), []);
});

test('public caller creation fails closed without artifacts for every non-matching lifecycle state', async (t) => {
  const cases = /** @type {Array<[string, (context:any)=>Promise<any>]>} */ ([
    ['pending active', async ({ activePath, active }) => writeFile(activePath, `${JSON.stringify({ ...active, status: 'pending' })}\n`, { mode: 0o600 })],
    ['ended session', async ({ identity, workspace, input }) => identity.cleanupSession(workspace, input.sessionId)],
    ['missing active', async ({ activePath }) => unlink(activePath)],
    ['malformed active', async ({ activePath }) => writeFile(activePath, '{broken', { mode: 0o600 })],
    ['future active schema', async ({ activePath, active }) => writeFile(activePath, `${JSON.stringify({ ...active, version: 4 })}\n`, { mode: 0o600 })],
    ['wrong turn', async ({ request }) => { request.turnId = 'turn-b'; }],
    ['wrong permission', async ({ request }) => { request.permissionMode = 'read-only'; }],
    ['mismatched stored session', async ({ activePath, active }) => writeFile(activePath, `${JSON.stringify({ ...active, sessionId: 'session-b' })}\n`, { mode: 0o600 })],
  ]);
  for (const [name, arrange] of cases) {
    await t.test(name, async () => {
      const { dataRoot, identity, workspaceA } = await fixture();
      const input = {
        sessionId: 'session-a', turnId: 'turn-a', workspace: workspaceA,
        permissionMode: 'workspace-write', now: new Date('2026-08-20T12:00:00.000Z'),
      };
      await identity.beginCallerTurn({
        ...input, prompt: 'repair',
        sessionStartedAt: '2026-08-20T11:59:00.000Z', sessionSource: 'startup',
      });
      const activePath = await globalActivePath(dataRoot, input.sessionId);
      const active = JSON.parse(await readFile(activePath, 'utf8'));
      const request = { ...input };
      await arrange({ active, activePath, dataRoot, identity, input, request, workspace: workspaceA });
      const before = await callerArtifactNames(dataRoot, workspaceA);
      await assert.rejects(identity.createCallerContext(request));
      assert.deepEqual(await callerArtifactNames(dataRoot, workspaceA), before);
    });
  }

  await t.test('execution workspace is not the origin', async () => {
    const { dataRoot, identity, root } = await fixture();
    const { origin, execution } = await linkedWorktreeFixture(root);
    const input = {
      sessionId: 'session-a', turnId: 'turn-a', workspace: origin, permissionMode: 'workspace-write',
      sessionStartedAt: '2026-08-20T11:59:00.000Z', sessionSource: 'startup',
    };
    await identity.beginCallerTurn(input);
    await identity.resolveActiveTurn({ sessionId: input.sessionId, workspace: execution, workspaceBinding: 'claim' });
    const before = await callerArtifactNames(dataRoot, execution);
    await assert.rejects(identity.createCallerContext({ ...input, workspace: execution }));
    assert.deepEqual(await callerArtifactNames(dataRoot, execution), before);
  });
});

test('protected caller publication is fenced from concurrent replacement and cleanup', async (t) => {
  for (const operation of ['replacement', 'cleanup']) {
    await t.test(operation, async () => {
      const { dataRoot, workspaceA } = await fixture();
      const proof = { sessionStartedAt: '2026-08-20T11:59:00.000Z', sessionSource: 'startup' };
      const input = { sessionId: 'session-a', turnId: 'turn-a', workspace: workspaceA, permissionMode: 'workspace-write' };
      const identity = createIdentityStore({ dataRoot });
      await identity.beginCallerTurn({ ...input, ...proof });
      const reached = deferred(); const release = deferred();
      const creating = createIdentityStore({
        dataRoot,
        publicationSeam: async (point) => {
          if (point === 'after-protected-caller-write') { reached.resolve(); await release.promise; }
        },
      }).createCallerContext(input);
      await waitForTestSignal(reached.promise, 'protected caller publication must expose the session-lock test seam')
        .catch(async (error) => { release.resolve(); await creating; throw error; });
      const mutation = operation === 'replacement'
        ? identity.beginCallerTurn({ ...input, ...proof, turnId: 'turn-b' })
        : identity.cleanupSession(workspaceA, input.sessionId);
      const sessionKey = createHash('sha256').update(JSON.stringify([input.sessionId])).digest('hex');
      const expectedLockPath = join(
        await realpath(dataRoot), 'identity-lifecycle', 'session-locks', sessionKey.slice(0, 2),
      );
      await assert.rejects(mutation, (error) => {
        const lockError = /** @type {any} */ (error);
        assert.equal(lockError?.code, 'LOCK_TIMEOUT');
        assert.equal(lockError?.details?.lockPath, expectedLockPath);
        return true;
      });
      release.resolve();
      const token = await creating;
      if (operation === 'replacement') await identity.beginCallerTurn({ ...input, ...proof, turnId: 'turn-b' });
      else await identity.cleanupSession(workspaceA, input.sessionId);
      await assert.rejects(identity.consumeCallerContext(token, { workspace: workspaceA }), { code: 'CALLER_CONTEXT_INVALID' });
    });
  }
});

test('session proof fields are paired and strict before any authorization artifact is created', async () => {
  for (const proof of [
    { sessionStartedAt: '2026-08-20T11:59:00.000Z' },
    { sessionSource: 'startup' },
    { sessionStartedAt: '2026-08-20 11:59:00Z', sessionSource: 'startup' },
    { sessionStartedAt: '2026-08-20T11:59:00.000Z', sessionSource: 'child' },
    { sessionStartedAt: '2027-08-20T11:59:00.000Z', sessionSource: 'resume' },
    { sessionStartedAt: '2026-08-20T11:59:00.000Z', sessionSource: 'startup', sessionId: 'x'.repeat(4097) },
    { lifecycleResult: true },
  ]) {
    const { dataRoot, identity, workspaceA } = await fixture();
    await assert.rejects(identity.beginCallerTurn(/** @type {any} */ ({
      sessionId: proof.sessionId ?? 'session-a', turnId: 'turn-a', workspace: workspaceA,
      permissionMode: 'default', now: '2026-08-20T12:00:00.000Z', ...proof,
    })), { code: 'IDENTITY_INPUT_INVALID' });
    await assert.rejects(stat(dataRoot), { code: 'ENOENT' });
  }
});

test('linked worktree binding previews without mutation then claims once and requires the exact execution target', async () => {
  const { dataRoot, identity, root } = await fixture();
  const { origin, execution } = await linkedWorktreeFixture(root);
  const proof = { sessionStartedAt: '2026-08-20T11:59:00.000Z', sessionSource: 'startup' };
  await identity.beginCallerTurn({ sessionId: 'session-a', turnId: 'turn-a', workspace: origin, permissionMode: 'workspace-write', prompt: 'work', ...proof });
  const { activePath, sessionPath } = await globalIdentityArtifacts(dataRoot);
  const beforeActive = await readFile(activePath, 'utf8');
  const beforeSession = await readFile(sessionPath, 'utf8');
  const preview = await identity.resolveActiveTurn({ sessionId: 'session-a', workspace: execution, workspaceBinding: 'preview' });
  assert.equal(preview.workspace, await realpath(execution));
  assert.equal(preview.originWorkspace, await realpath(origin));
  assert.equal(preview.executionWorkspace, null);
  assert.match(preview.generationId, /^[a-f0-9]{64}$/);
  assert.equal(await readFile(activePath, 'utf8'), beforeActive);
  assert.equal(await readFile(sessionPath, 'utf8'), beforeSession);
  await assert.rejects(identity.resolveActiveTurn({ sessionId: 'session-a', workspace: execution, workspaceBinding: 'execution' }), { code: 'ACTIVE_TURN_WORKSPACE_INELIGIBLE' });
  const claimed = await identity.resolveActiveTurn({ sessionId: 'session-a', workspace: execution, workspaceBinding: 'claim' });
  assert.equal(claimed.workspace, await realpath(execution));
  assert.equal((await identity.resolveActiveTurn({ sessionId: 'session-a', workspace: execution, workspaceBinding: 'execution' })).turnId, 'turn-a');
  assert.equal((await identity.resolveActiveTurn({ sessionId: 'session-a', workspace: execution, workspaceBinding: 'claim' })).turnId, 'turn-a');
  const persisted = JSON.parse(await readFile(activePath, 'utf8'));
  assert.equal(persisted.executionWorkspace, await realpath(execution));
  assert.deepEqual(JSON.parse(await readFile(sessionPath, 'utf8')).knownWorkspaces, [await realpath(origin), await realpath(execution)]);
});

test('competing linked worktree claims atomically bind one immutable target', async () => {
  const { identity, root } = await fixture();
  const { origin, execution } = await linkedWorktreeFixture(root);
  const other = join(root, 'execution-other');
  await execFile('git', ['worktree', 'add', '-q', '-b', 'execution-other', other], { cwd: origin });
  await identity.beginCallerTurn({
    sessionId: 'session-race', turnId: 'turn-race', workspace: origin, permissionMode: 'default',
    sessionStartedAt: '2026-08-20T11:59:00.000Z', sessionSource: 'startup',
  });
  const attempts = await Promise.allSettled([
    ...Array.from({ length: 8 }, () => identity.resolveActiveTurn({ sessionId: 'session-race', workspace: execution, workspaceBinding: 'claim' })),
    ...Array.from({ length: 8 }, () => identity.resolveActiveTurn({ sessionId: 'session-race', workspace: other, workspaceBinding: 'claim' })),
  ]);
  const fulfilled = attempts.filter((attempt) => attempt.status === 'fulfilled');
  assert.ok(fulfilled.length >= 8);
  const targets = new Set(fulfilled.map((attempt) => attempt.value.workspace));
  assert.equal(targets.size, 1);
  const winner = [...targets][0];
  const loser = winner === await realpath(execution) ? other : execution;
  await assert.rejects(identity.resolveActiveTurn({ sessionId: 'session-race', workspace: loser, workspaceBinding: 'claim' }), { code: 'ACTIVE_TURN_WORKSPACE_INELIGIBLE' });
});

test('cleanup terminalizes global session state and only a strictly newer proof can reopen it', async () => {
  const { identity, root } = await fixture();
  const { origin, execution } = await linkedWorktreeFixture(root);
  const base = { sessionId: 'session-a', workspace: origin, permissionMode: 'default', sessionStartedAt: '2026-08-20T11:59:00.000Z', sessionSource: 'startup' };
  await identity.beginCallerTurn({ ...base, turnId: 'turn-a' });
  await identity.resolveActiveTurn({ sessionId: 'session-a', workspace: execution, workspaceBinding: 'claim' });
  const cleanup = await identity.cleanupSession(origin, 'session-a');
  assert.deepEqual(cleanup, { knownWorkspaces: [await realpath(origin), await realpath(execution)] });
  await assert.rejects(identity.resolveActiveTurn({ sessionId: 'session-a', workspace: execution, workspaceBinding: 'execution' }), { code: 'ACTIVE_TURN_NOT_FOUND' });
  await assert.rejects(identity.beginCallerTurn({ ...base, turnId: 'turn-b', sessionSource: 'resume' }), { code: 'IDENTITY_SESSION_ENDED' });
  await identity.beginCallerTurn({ ...base, turnId: 'turn-c', sessionStartedAt: '2026-08-20T12:01:00.000Z', sessionSource: 'resume' });
  assert.equal((await identity.resolveActiveTurn({ sessionId: 'session-a', workspace: origin })).turnId, 'turn-c');
});

test('v3 binding validates options and refuses unrelated or non-Git workspaces without leaking paths', async () => {
  const { identity, root, workspaceA } = await fixture();
  const { origin } = await linkedWorktreeFixture(root);
  await identity.beginCallerTurn({
    sessionId: 'session-a', turnId: 'turn-a', workspace: origin, permissionMode: 'default',
    sessionStartedAt: '2026-08-20T11:59:00.000Z', sessionSource: 'startup',
  });
  for (const workspaceBinding of ['unknown', 1, null, {}]) {
    await assert.rejects(identity.resolveActiveTurn(/** @type {any} */ ({ sessionId: 'session-a', workspace: origin, workspaceBinding })), { code: 'IDENTITY_INPUT_INVALID' });
  }
  await assert.rejects(
    identity.resolveActiveTurn({ sessionId: 'session-a', workspace: workspaceA, workspaceBinding: 'preview' }),
    (error) => error instanceof PluginError && error.code === 'ACTIVE_TURN_WORKSPACE_INELIGIBLE'
      && !error.message.includes(workspaceA) && !error.message.includes(origin),
  );
  assert.equal((await identity.resolveActiveTurn({ sessionId: 'session-a', workspace: origin })).workspace, await realpath(origin));
});

test('malformed and duplicate-key global v3 records fail closed without legacy fallback', async () => {
  for (const corrupt of ['future', 'duplicate']) {
    const { dataRoot, identity, workspaceA } = await fixture();
    await identity.beginCallerTurn({ sessionId: 'session-a', turnId: 'legacy-turn', workspace: workspaceA, permissionMode: 'default' });
    await identity.beginCallerTurn({
      sessionId: 'session-a', turnId: 'global-turn', workspace: workspaceA, permissionMode: 'default',
      sessionStartedAt: '2026-08-20T11:59:00.000Z', sessionSource: 'startup',
    });
    const { activePath } = await globalIdentityArtifacts(dataRoot);
    if (corrupt === 'future') {
      const record = JSON.parse(await readFile(activePath, 'utf8')); record.version = 4;
      await atomicWriteJson(activePath, record);
    } else {
      const text = await readFile(activePath, 'utf8');
      await writeFile(activePath, text.replace('"version": 3,', '"version": 3,\n  "version": 3,'), { mode: 0o600 });
    }
    await assert.rejects(identity.resolveActiveTurn({ sessionId: 'session-a', workspace: workspaceA }), { code: 'AUTHORIZATION_RECORD_INVALID' });
  }
});

test('resolveOnlyActiveTurn includes canonical-origin v3 and fails closed on any invalid global v3 slot', async () => {
  const { dataRoot, identity, root } = await fixture();
  const { origin } = await linkedWorktreeFixture(root);
  await identity.beginCallerTurn({
    sessionId: 'session-a', turnId: 'turn-a', workspace: origin, permissionMode: 'default',
    sessionStartedAt: '2026-08-20T11:59:00.000Z', sessionSource: 'startup',
  });
  assert.equal((await identity.resolveOnlyActiveTurn({ workspace: origin })).turnId, 'turn-a');
  const { activePath } = await globalIdentityArtifacts(dataRoot);
  const record = JSON.parse(await readFile(activePath, 'utf8')); record.originWorkspace = join(origin, '..');
  await atomicWriteJson(activePath, record);
  await assert.rejects(identity.resolveOnlyActiveTurn({ workspace: origin }), { code: 'AUTHORIZATION_RECORD_INVALID' });
});

test('ending an exact v3 turn returns validated binding metadata and cleanup retains target metadata', async () => {
  const { identity, root } = await fixture();
  const { origin, execution } = await linkedWorktreeFixture(root);
  const input = {
    sessionId: 'session-a', turnId: 'turn-a', workspace: origin, permissionMode: 'default',
    sessionStartedAt: '2026-08-20T11:59:00.000Z', sessionSource: 'startup',
  };
  await identity.beginCallerTurn(input);
  await identity.resolveActiveTurn({ sessionId: 'session-a', workspace: execution, workspaceBinding: 'claim' });
  const canonicalExecution = await realpath(execution);
  assert.deepEqual(await identity.endCallerTurn({ sessionId: 'session-a', turnId: 'turn-a', workspace: execution }), {
    originWorkspace: await realpath(origin), executionWorkspace: canonicalExecution,
  });
  await rename(execution, `${execution}-moved`);
  assert.deepEqual(await identity.cleanupSession(origin, 'session-a'), {
    knownWorkspaces: [await realpath(origin), canonicalExecution],
  });
});

test('ending the wrong v3 turn neither revokes nor discloses binding metadata', async () => {
  const { identity, root } = await fixture();
  const { origin, execution } = await linkedWorktreeFixture(root);
  await identity.beginCallerTurn({
    sessionId: 'session-a', turnId: 'turn-a', workspace: origin, permissionMode: 'default',
    sessionStartedAt: '2026-08-20T11:59:00.000Z', sessionSource: 'startup',
  });
  await identity.resolveActiveTurn({ sessionId: 'session-a', workspace: execution, workspaceBinding: 'claim' });
  assert.equal(await identity.endCallerTurn({ sessionId: 'session-a', turnId: 'wrong-turn', workspace: execution }), undefined);
  assert.equal((await identity.resolveActiveTurn({ sessionId: 'session-a', workspace: execution, workspaceBinding: 'execution' })).turnId, 'turn-a');
});

test('proved duplicate begin rotates caller token while retaining generation and binding; authority changes replace them', async () => {
  const { identity, root } = await fixture();
  const { origin, execution } = await linkedWorktreeFixture(root);
  const base = /** @type {any} */ ({
    sessionId: 'session-a', turnId: 'turn-a', workspace: origin, permissionMode: 'workspace-write', prompt: 'same',
    sessionStartedAt: '2026-08-20T11:59:00.000Z', sessionSource: 'startup', lifecycleResult: true,
  });
  const first = await identity.beginCallerTurn(base);
  assert.match(first.token, /^[A-Za-z0-9_-]{43}$/); assert.equal(first.replacedTurn, null);
  const claimed = await identity.resolveActiveTurn({ sessionId: 'session-a', workspace: execution, workspaceBinding: 'claim' });
  const duplicate = await identity.beginCallerTurn(base);
  assert.notEqual(duplicate.token, first.token); assert.equal(duplicate.replacedTurn, null);
  await assert.rejects(identity.consumeCallerContext(first.token, { workspace: origin }), { code: 'CALLER_CONTEXT_INVALID' });
  assert.equal((await identity.consumeCallerContext(duplicate.token, { workspace: origin })).turnId, 'turn-a');
  const retained = await identity.resolveActiveTurn({ sessionId: 'session-a', workspace: origin, workspaceBinding: 'execution' });
  assert.equal(retained.generationId, claimed.generationId);
  assert.equal(retained.workspace, await realpath(execution));
  const replacement = await identity.beginCallerTurn({ ...base, prompt: 'changed' });
  assert.deepEqual(replacement.replacedTurn, {
    turnId: 'turn-a', generationId: claimed.generationId, executionWorkspace: await realpath(execution),
  });
  const replaced = await identity.resolveActiveTurn({ sessionId: 'session-a', workspace: origin, workspaceBinding: 'preview' });
  assert.notEqual(replaced.generationId, claimed.generationId);
  await assert.rejects(identity.resolveActiveTurn({ sessionId: 'session-a', workspace: origin, workspaceBinding: 'execution' }), { code: 'ACTIVE_TURN_WORKSPACE_INELIGIBLE' });
});

test('proved replacement from a new origin revokes prior-origin caller tokens', async () => {
  const { identity, root } = await fixture(); const { origin, execution } = await linkedWorktreeFixture(root);
  const proof = { sessionStartedAt: '2026-08-20T11:59:00.000Z', sessionSource: 'startup' };
  const old = await identity.beginCallerTurn({ sessionId: 'session-a', turnId: 'turn-a', workspace: origin, permissionMode: 'default', ...proof });
  await identity.beginCallerTurn({ sessionId: 'session-a', turnId: 'turn-b', workspace: execution, permissionMode: 'default', ...proof });
  await assert.rejects(identity.consumeCallerContext(old, { workspace: origin }), { code: 'CALLER_CONTEXT_INVALID' });
  assert.equal((await identity.resolveActiveTurn({ sessionId: 'session-a', workspace: execution })).turnId, 'turn-b');
});

test('any lifecycle ledger state suppresses stale workspace-local v2 fallback', async () => {
  for (const state of ['pending', 'ended', 'corrupt-ledger']) {
    const { dataRoot, identity, workspaceA } = await fixture();
    await identity.beginCallerTurn({ sessionId: 'session-a', turnId: 'stale-v2', workspace: workspaceA, permissionMode: 'default' });
    await identity.beginCallerTurn({
      sessionId: 'session-a', turnId: 'v3-turn', workspace: workspaceA, permissionMode: 'default',
      sessionStartedAt: '2026-08-20T11:59:00.000Z', sessionSource: 'startup',
    });
    const { activePath, sessionPath } = await globalIdentityArtifacts(dataRoot);
    if (state === 'pending') {
      const record = JSON.parse(await readFile(activePath, 'utf8')); record.status = 'pending'; await atomicWriteJson(activePath, record);
    } else if (state === 'ended') {
      await identity.cleanupSession(workspaceA, 'session-a');
    } else {
      const record = JSON.parse(await readFile(sessionPath, 'utf8')); record.version = 2; await atomicWriteJson(sessionPath, record);
    }
    await assert.rejects(identity.resolveActiveTurn({ sessionId: 'session-a', workspace: workspaceA }),
      (error) => error instanceof PluginError && ['ACTIVE_TURN_NOT_FOUND', 'AUTHORIZATION_RECORD_INVALID'].includes(error.code));
    await assert.rejects(identity.resolveOnlyActiveTurn({ workspace: workspaceA }),
      (error) => error instanceof PluginError && ['SETUP_SESSION_UNPROVEN', 'AUTHORIZATION_RECORD_INVALID'].includes(error.code));
  }
});

test('pending publication failures never authorize and exact retry repairs the generation', async () => {
  for (const point of ['after-pending', 'before-workspace-publish', 'after-caller-write', 'after-index-write', 'after-workspace-publish', 'before-active-publish']) {
    const { dataRoot, root } = await fixture(); const { origin } = await linkedWorktreeFixture(root);
    let injected = false;
    const failing = createIdentityStore({
      dataRoot,
      publicationSeam: async (current) => {
        if (!injected && current === point) { injected = true; throw new Error(`injected ${point}`); }
      },
    });
    const input = {
      sessionId: 'session-a', turnId: 'turn-a', workspace: origin, permissionMode: 'default',
      sessionStartedAt: '2026-08-20T11:59:00.000Z', sessionSource: 'startup',
    };
    await assert.rejects(failing.beginCallerTurn(input), /injected/);
    await assert.rejects(createIdentityStore({ dataRoot }).resolveActiveTurn({ sessionId: 'session-a', workspace: origin }), { code: 'ACTIVE_TURN_NOT_FOUND' });
    await createIdentityStore({ dataRoot }).beginCallerTurn(input);
    assert.equal((await createIdentityStore({ dataRoot }).resolveActiveTurn({ sessionId: 'session-a', workspace: origin })).turnId, 'turn-a');
  }
});

test('resolveOnly follows its bounded origin index and ignores unrelated global corruption', async () => {
  const { dataRoot, identity, root, workspaceA } = await fixture(); const { origin } = await linkedWorktreeFixture(root);
  await identity.beginCallerTurn({
    sessionId: 'session-a', turnId: 'turn-a', workspace: origin, permissionMode: 'default',
    sessionStartedAt: '2026-08-20T11:59:00.000Z', sessionSource: 'startup',
  });
  const unrelatedKey = 'f'.repeat(64);
  await writeFile(join(await realpath(dataRoot), 'identity-lifecycle', 'active-turns', `${unrelatedKey}.json`), '{broken', { mode: 0o600 });
  assert.equal((await identity.resolveOnlyActiveTurn({ workspace: origin })).turnId, 'turn-a');
  await assert.rejects(identity.resolveOnlyActiveTurn({ workspace: workspaceA }), { code: 'SETUP_SESSION_UNPROVEN' });
});

test('Git eligibility rejects a nested directory even when it belongs to the same worktree', async () => {
  const { identity, root } = await fixture(); const { origin } = await linkedWorktreeFixture(root); const nested = join(origin, 'nested'); await mkdir(nested);
  await identity.beginCallerTurn({
    sessionId: 'session-a', turnId: 'turn-a', workspace: origin, permissionMode: 'default',
    sessionStartedAt: '2026-08-20T11:59:00.000Z', sessionSource: 'startup',
  });
  await assert.rejects(identity.resolveActiveTurn({ sessionId: 'session-a', workspace: nested, workspaceBinding: 'preview' }), { code: 'ACTIVE_TURN_WORKSPACE_INELIGIBLE' });
});

test('session workspace ledger retains at most sixteen origins and targets and rejects overflow', async () => {
  const { dataRoot, root } = await fixture(); const origin = join(root, 'origin-ledger'); const common = join(root, 'common');
  await Promise.all([mkdir(origin), mkdir(common)]);
  const candidates = Array.from({ length: 16 }, (_, index) => join(root, `target-${index}`));
  await Promise.all(candidates.map((candidate) => mkdir(candidate)));
  const canonicalCommon = await realpath(common);
  const identity = createIdentityStore({
    dataRoot,
    gitProbe: async (workspace) => `true\n${await realpath(workspace)}\n${canonicalCommon}\n`,
  });
  const base = {
    sessionId: 'session-ledger', workspace: origin, permissionMode: 'default',
    sessionStartedAt: '2026-08-20T11:59:00.000Z', sessionSource: 'startup',
  };
  for (let index = 0; index < 15; index += 1) {
    await identity.beginCallerTurn({ ...base, turnId: `turn-${index}` });
    await identity.resolveActiveTurn({ sessionId: base.sessionId, workspace: candidates[index], workspaceBinding: 'claim' });
    await identity.endCallerTurn({ sessionId: base.sessionId, turnId: `turn-${index}`, workspace: origin });
  }
  await identity.beginCallerTurn({ ...base, turnId: 'overflow-turn' });
  await assert.rejects(identity.resolveActiveTurn({ sessionId: base.sessionId, workspace: candidates[15], workspaceBinding: 'claim' }), { code: 'IDENTITY_WORKSPACE_LEDGER_FULL' });
  const cleanup = await identity.cleanupSession(origin, base.sessionId);
  assert.equal(cleanup.knownWorkspaces.length, 16);
  assert.deepEqual(await identity.cleanupSession(origin, base.sessionId), cleanup);
});

test('cleanup revokes exact-session caller tokens in every known workspace without touching siblings', async () => {
  const { identity, root } = await fixture(); const { origin, execution } = await linkedWorktreeFixture(root);
  const targetToken = await identity.createCallerContext({ sessionId: 'session-a', turnId: 'target-turn', workspace: execution, permissionMode: 'default' });
  const siblingToken = await identity.createCallerContext({ sessionId: 'session-b', turnId: 'sibling-turn', workspace: execution, permissionMode: 'default' });
  await identity.beginCallerTurn({
    sessionId: 'session-a', turnId: 'turn-a', workspace: origin, permissionMode: 'default',
    sessionStartedAt: '2026-08-20T11:59:00.000Z', sessionSource: 'startup',
  });
  await identity.resolveActiveTurn({ sessionId: 'session-a', workspace: execution, workspaceBinding: 'claim' });
  await identity.cleanupSession(origin, 'session-a');
  await assert.rejects(identity.consumeCallerContext(targetToken, { workspace: execution }), { code: 'CALLER_CONTEXT_INVALID' });
  assert.equal((await identity.consumeCallerContext(siblingToken, { workspace: execution })).sessionId, 'session-b');
});

test('an ended session ledger revokes caller tokens before workspace cleanup completes', async () => {
  const { dataRoot, root } = await fixture(); const { origin } = await linkedWorktreeFixture(root);
  const input = {
    sessionId: 'session-a', turnId: 'turn-a', workspace: origin, permissionMode: 'default',
    sessionStartedAt: '2026-08-20T11:59:00.000Z', sessionSource: 'startup',
  };
  const token = await createIdentityStore({ dataRoot }).beginCallerTurn(input);
  const discovered = deferred(); const releaseConsume = deferred();
  const consumption = createIdentityStore({
    dataRoot,
    publicationSeam: async (point) => {
      if (point === 'after-caller-discovery') { discovered.resolve(); await releaseConsume.promise; }
    },
  }).consumeCallerContext(token, { workspace: origin });
  assert.equal(await Promise.race([
    discovered.promise.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 100)),
  ]), true, 'consumer must pause after discovering the token and before checking lifecycle state');
  const cleanup = createIdentityStore({
    dataRoot,
    publicationSeam: async (point) => {
      if (point === 'after-cleanup-tombstone') throw new Error('injected after tombstone');
    },
  });
  await assert.rejects(cleanup.cleanupSession(origin, 'session-a'), /injected after tombstone/);
  releaseConsume.resolve();
  await assert.rejects(consumption, { code: 'CALLER_CONTEXT_INVALID' });
  const { sessionPath } = await globalIdentityArtifacts(dataRoot);
  await writeFile(sessionPath, '{}\n', { mode: 0o600 });
  await assert.rejects(
    createIdentityStore({ dataRoot }).consumeCallerContext(token, { workspace: origin }),
    { code: 'AUTHORIZATION_RECORD_INVALID' },
  );
});

test('a newer proof from another origin cannot revive a token left behind by failed cleanup', async () => {
  const { dataRoot, workspaceA, workspaceB } = await fixture();
  const identity = createIdentityStore({ dataRoot });
  const oldToken = await identity.beginCallerTurn({
    sessionId: 'session-a', turnId: 'turn-a', workspace: workspaceA, permissionMode: 'default',
    sessionStartedAt: '2026-08-20T11:59:00.000Z', sessionSource: 'startup',
  });
  await assert.rejects(createIdentityStore({
    dataRoot,
    publicationSeam: async (point) => {
      if (point === 'after-cleanup-tombstone') throw new Error('injected after tombstone');
    },
  }).cleanupSession(workspaceA, 'session-a'), /injected after tombstone/);
  const newToken = await identity.beginCallerTurn({
    sessionId: 'session-a', turnId: 'turn-b', workspace: workspaceB, permissionMode: 'default',
    sessionStartedAt: '2026-08-20T12:01:00.000Z', sessionSource: 'resume',
  });
  await assert.rejects(identity.consumeCallerContext(oldToken, { workspace: workspaceA }), { code: 'CALLER_CONTEXT_INVALID' });
  assert.equal((await identity.consumeCallerContext(newToken, { workspace: workspaceB })).turnId, 'turn-b');
});

test('a newer same-origin generation cannot authorize a restored old caller token', async () => {
  const { dataRoot, workspaceA } = await fixture(); const identity = createIdentityStore({ dataRoot });
  const base = { sessionId: 'session-a', turnId: 'turn-a', workspace: workspaceA, permissionMode: 'default' };
  const oldToken = await identity.beginCallerTurn({
    ...base, sessionStartedAt: '2026-08-20T11:59:00.000Z', sessionSource: 'startup',
  });
  const oldPath = await callerContextPath(dataRoot, workspaceA, oldToken);
  const oldRecord = await readFile(oldPath, 'utf8');
  await assert.rejects(createIdentityStore({
    dataRoot,
    publicationSeam: async (point) => {
      if (point === 'after-cleanup-tombstone') throw new Error('injected after tombstone');
    },
  }).cleanupSession(workspaceA, 'session-a'), /injected after tombstone/);
  const newToken = await identity.beginCallerTurn({
    ...base, sessionStartedAt: '2026-08-20T12:01:00.000Z', sessionSource: 'resume',
  });
  await writeFile(oldPath, oldRecord, { mode: 0o600 });
  await assert.rejects(identity.consumeCallerContext(oldToken, { workspace: workspaceA }), { code: 'CALLER_CONTEXT_INVALID' });
  assert.equal((await identity.consumeCallerContext(newToken, { workspace: workspaceA })).turnId, 'turn-a');
});

test('revoking the global active turn invalidates its caller before token deletion completes', async () => {
  const { dataRoot, workspaceA } = await fixture();
  const input = {
    sessionId: 'session-a', turnId: 'turn-a', workspace: workspaceA, permissionMode: 'default',
    sessionStartedAt: '2026-08-20T11:59:00.000Z', sessionSource: 'startup',
  };
  const token = await createIdentityStore({ dataRoot }).beginCallerTurn(input);
  const ending = createIdentityStore({
    dataRoot,
    publicationSeam: async (point) => {
      if (point === 'after-active-revoke') throw new Error('injected after active revoke');
    },
  });
  await assert.rejects(ending.endCallerTurn({ sessionId: 'session-a', turnId: 'turn-a', workspace: workspaceA }), /injected after active revoke/);
  await assert.rejects(createIdentityStore({ dataRoot }).consumeCallerContext(token, { workspace: workspaceA }), { code: 'CALLER_CONTEXT_INVALID' });
});

test('proved begin fencing prevents a delayed loser from deleting a returned winner token or index', async () => {
  const { dataRoot, root } = await fixture(); const { origin } = await linkedWorktreeFixture(root);
  const reached = deferred(); const release = deferred();
  const input = /** @type {any} */ ({
    sessionId: 'session-race', workspace: origin, permissionMode: 'default',
    sessionStartedAt: '2026-08-20T11:59:00.000Z', sessionSource: 'startup', lifecycleResult: true,
  });
  const delayed = createIdentityStore({
    dataRoot,
    publicationSeam: async (point) => {
      if (point === 'before-workspace-publish') { reached.resolve(); await release.promise; }
    },
  }).beginCallerTurn({ ...input, turnId: 'loser-turn' });
  await reached.promise;
  const winner = await createIdentityStore({ dataRoot }).beginCallerTurn({ ...input, turnId: 'winner-turn' });
  release.resolve();
  await assert.rejects(delayed, { code: 'AUTHORIZATION_RECORD_INVALID' });
  const identity = createIdentityStore({ dataRoot });
  assert.equal((await identity.consumeCallerContext(winner.token, { workspace: origin })).turnId, 'winner-turn');
  const active = await identity.resolveOnlyActiveTurn({ workspace: origin });
  assert.equal(active.turnId, 'winner-turn');
  assert.equal((await identity.resolveActiveTurn({ sessionId: 'session-race', workspace: origin, workspaceBinding: 'preview' })).generationId,
    JSON.parse(await readFile(await globalActivePath(dataRoot, 'session-race'), 'utf8')).generationId);
});

test('slow Git inspection for one session does not block another session', async () => {
  const { dataRoot, root } = await fixture();
  const repoARoot = join(root, 'repo-a-root'); const repoBRoot = join(root, 'repo-b-root');
  await Promise.all([mkdir(repoARoot), mkdir(repoBRoot)]);
  const repoA = await linkedWorktreeFixture(repoARoot); const repoB = await linkedWorktreeFixture(repoBRoot);
  const proof = { sessionStartedAt: '2026-08-20T11:59:00.000Z', sessionSource: 'startup' };
  const identity = createIdentityStore({ dataRoot });
  await identity.beginCallerTurn({ sessionId: 'session-a', turnId: 'turn-a', workspace: repoA.origin, permissionMode: 'default', ...proof });
  await identity.beginCallerTurn({ sessionId: 'session-b', turnId: 'turn-b', workspace: repoB.origin, permissionMode: 'default', ...proof });
  const entered = deferred(); const release = deferred();
  const slow = createIdentityStore({
    dataRoot,
    gitProbe: async (workspace) => {
      entered.resolve(); await release.promise;
      const { stdout } = await execFile('git', ['rev-parse', '--path-format=absolute', '--is-inside-work-tree', '--show-toplevel', '--git-common-dir'], { cwd: workspace });
      return stdout;
    },
  }).resolveActiveTurn({ sessionId: 'session-a', workspace: repoA.execution, workspaceBinding: 'preview' });
  await entered.promise;
  let sessionBResolved = false;
  const sessionB = identity.resolveActiveTurn({ sessionId: 'session-b', workspace: repoB.origin }).then((value) => { sessionBResolved = true; return value; });
  await Promise.race([sessionB, new Promise((resolve) => setTimeout(resolve, 100))]);
  const resolvedBeforeRelease = sessionBResolved;
  release.resolve(); await slow; await sessionB;
  assert.equal(resolvedBeforeRelease, true, 'session B must resolve before session A Git probe is released');
});

test('claim write failures are recoverable and cleanup retains the claimed target', async () => {
  for (const point of ['before-claim-ledger-write', 'after-claim-ledger-write', 'before-claim-active-write', 'after-claim-active-write']) {
    const { dataRoot, root } = await fixture(); const { origin, execution } = await linkedWorktreeFixture(root);
    const input = {
      sessionId: 'session-a', turnId: 'turn-a', workspace: origin, permissionMode: 'default',
      sessionStartedAt: '2026-08-20T11:59:00.000Z', sessionSource: 'startup',
    };
    await createIdentityStore({ dataRoot }).beginCallerTurn(input);
    let injected = false;
    const failing = createIdentityStore({
      dataRoot,
      publicationSeam: async (current) => {
        if (!injected && current === point) { injected = true; throw new Error(`injected ${point}`); }
      },
    });
    await assert.rejects(failing.resolveActiveTurn({ sessionId: 'session-a', workspace: execution, workspaceBinding: 'claim' }), /injected/);
    const reopened = createIdentityStore({ dataRoot });
    assert.equal((await reopened.resolveActiveTurn({ sessionId: 'session-a', workspace: execution, workspaceBinding: 'claim' })).workspace, await realpath(execution));
    const { sessionPath } = await globalIdentityArtifacts(dataRoot);
    const ledger = JSON.parse(await readFile(sessionPath, 'utf8'));
    await writeFile(sessionPath, `${JSON.stringify({ ...ledger, knownWorkspaces: [await realpath(origin)] })}\n`, { mode: 0o600 });
    assert.equal((await reopened.resolveActiveTurn({ sessionId: 'session-a', workspace: execution, workspaceBinding: 'claim' })).workspace, await realpath(execution));
    assert.deepEqual(await reopened.cleanupSession(origin, 'session-a'), { knownWorkspaces: [await realpath(origin), await realpath(execution)] });
  }
});

test('begin retry preserves a pending generation when ledger publication failed', async () => {
  const { dataRoot, root } = await fixture(); const { origin } = await linkedWorktreeFixture(root);
  const input = {
    sessionId: 'session-a', turnId: 'turn-a', workspace: origin, permissionMode: 'default',
    sessionStartedAt: '2026-08-20T11:59:00.000Z', sessionSource: 'startup',
  };
  let injected = false;
  const failing = createIdentityStore({
    dataRoot,
    publicationSeam: async (point) => {
      if (!injected && point === 'after-begin-pending-write') { injected = true; throw new Error('injected pending/ledger gap'); }
    },
  });
  await assert.rejects(failing.beginCallerTurn(input), /injected/);
  const pendingGeneration = JSON.parse(await readFile(await globalActivePath(dataRoot, 'session-a'), 'utf8')).generationId;
  await createIdentityStore({ dataRoot }).beginCallerTurn(input);
  assert.equal(JSON.parse(await readFile(await globalActivePath(dataRoot, 'session-a'), 'utf8')).generationId, pendingGeneration);
});

test('a conflicting trusted begin supersedes an orphan pending lifecycle and exact retry rotates only its caller token', async () => {
  const { dataRoot, workspaceA, workspaceB } = await fixture();
  const identity = createIdentityStore({ dataRoot });
  const oldToken = await identity.createCallerContext({ sessionId: 'session-orphan', turnId: 'legacy-turn', workspace: workspaceA, permissionMode: 'default' });
  const siblingToken = await identity.createCallerContext({ sessionId: 'session-sibling', turnId: 'sibling-turn', workspace: workspaceA, permissionMode: 'default' });
  const oldPath = await callerContextPath(dataRoot, workspaceA, oldToken); const oldBytes = await readFile(oldPath, 'utf8');
  const initial = {
    sessionId: 'session-orphan', turnId: 'turn-initial', workspace: workspaceA, permissionMode: 'default', prompt: 'initial prompt',
    sessionStartedAt: '2026-08-21T11:59:00.000Z', sessionSource: 'startup', now: '2026-08-21T12:00:00.000Z', lifecycleResult: true,
  };
  const orphan = await createOrphanPending(dataRoot, initial);
  const replacement = /** @type {any} */ ({
    ...initial, turnId: 'turn-replacement', workspace: workspaceB, permissionMode: 'read-only', prompt: 'replacement prompt',
    now: '2026-08-21T12:01:00.000Z',
  });
  const first = await identity.beginCallerTurn(replacement);
  assert.deepEqual(first.replacedTurn, {
    turnId: initial.turnId, generationId: orphan.active.generationId, executionWorkspace: null,
  });
  const active = JSON.parse(await readFile(await globalActivePath(dataRoot, initial.sessionId), 'utf8'));
  assert.equal(active.status, 'active'); assert.equal(active.turnId, replacement.turnId);
  assert.equal(active.originWorkspace, await realpath(workspaceB)); assert.equal(active.permissionMode, replacement.permissionMode);
  assert.equal(active.prompt, replacement.prompt); assert.notEqual(active.generationId, orphan.active.generationId);
  const ledger = JSON.parse(await readFile(await globalSessionPath(dataRoot, initial.sessionId), 'utf8'));
  assert.deepEqual(ledger.knownWorkspaces, [await realpath(workspaceA), await realpath(workspaceB)]); assert.equal(ledger.endedAt, null);
  const caller = JSON.parse(await readFile(await callerContextPath(dataRoot, workspaceB, first.token), 'utf8'));
  assert.equal(caller.generationId, active.generationId);
  await assert.rejects(identity.consumeCallerContext(oldToken, { workspace: workspaceA, now: replacement.now }), { code: 'CALLER_CONTEXT_INVALID' });
  await assert.rejects(readFile(oldPath, 'utf8'), { code: 'ENOENT' });
  assert.equal((await identity.consumeCallerContext(siblingToken, { workspace: workspaceA })).sessionId, 'session-sibling');
  assert.equal((await identity.consumeCallerContext(first.token, { workspace: workspaceB, now: replacement.now })).turnId, replacement.turnId);

  const retry = await identity.beginCallerTurn(replacement);
  assert.equal(retry.replacedTurn, null);
  assert.equal(JSON.parse(await readFile(await globalActivePath(dataRoot, initial.sessionId), 'utf8')).generationId, active.generationId);
  await assert.rejects(identity.consumeCallerContext(first.token, { workspace: workspaceB, now: replacement.now }), { code: 'CALLER_CONTEXT_INVALID' });
  assert.equal((await identity.consumeCallerContext(retry.token, { workspace: workspaceB, now: replacement.now })).turnId, replacement.turnId);
  await writeFile(oldPath, oldBytes, { mode: 0o600 });
  assert.deepEqual(await identity.cleanupSession(workspaceB, initial.sessionId), {
    knownWorkspaces: [await realpath(workspaceA), await realpath(workspaceB)],
  });
  await assert.rejects(readFile(oldPath, 'utf8'), { code: 'ENOENT' });
  assert.equal((await identity.consumeCallerContext(siblingToken, { workspace: workspaceA })).sessionId, 'session-sibling');
});

test('strictly newer trusted resume and clear proofs supersede an orphan without cleanup', async () => {
  for (const sessionSource of ['resume', 'clear']) {
    const { dataRoot, workspaceA } = await fixture();
    const initial = {
      sessionId: `session-newer-${sessionSource}`, turnId: 'turn-initial', workspace: workspaceA, permissionMode: 'default',
      prompt: 'same authority', sessionStartedAt: '2026-08-21T11:59:00.000Z', sessionSource: 'startup', now: '2026-08-21T12:00:00.000Z', lifecycleResult: true,
    };
    const { active: orphan } = await createOrphanPending(dataRoot, initial);
    const identity = createIdentityStore({ dataRoot });
    const newerInput = /** @type {any} */ ({
      ...initial,
      sessionStartedAt: '2026-08-21T12:01:00.000Z', sessionSource, now: '2026-08-21T12:02:00.000Z',
    });
    const newer = await identity.beginCallerTurn(newerInput);
    assert.deepEqual(newer.replacedTurn, { turnId: initial.turnId, generationId: orphan.generationId, executionWorkspace: null });
    const active = JSON.parse(await readFile(await globalActivePath(dataRoot, initial.sessionId), 'utf8'));
    assert.equal(active.status, 'active'); assert.equal(active.turnId, initial.turnId); assert.notEqual(active.generationId, orphan.generationId);
    const ledger = JSON.parse(await readFile(await globalSessionPath(dataRoot, initial.sessionId), 'utf8'));
    assert.equal(ledger.sessionStartedAt, '2026-08-21T12:01:00.000Z'); assert.equal(ledger.sessionSource, sessionSource);
    assert.equal((await identity.consumeCallerContext(newer.token, { workspace: workspaceA, now: newerInput.now })).turnId, initial.turnId);
    const retry = await identity.beginCallerTurn(newerInput);
    assert.equal(retry.replacedTurn, null);
    assert.equal(JSON.parse(await readFile(await globalActivePath(dataRoot, initial.sessionId), 'utf8')).generationId, active.generationId);
  }
});

test('orphan recovery rejects rollback snapshots and future trusted proofs', async () => {
  for (const kind of ['rollback', 'future-proof']) {
    const { dataRoot, workspaceA } = await fixture();
    const initial = {
      sessionId: `session-${kind}`, turnId: 'turn-initial', workspace: workspaceA, permissionMode: 'default',
      sessionStartedAt: '2026-08-21T11:59:00.000Z', sessionSource: 'startup', now: '2026-08-21T12:00:00.000Z',
    };
    await createOrphanPending(dataRoot, initial);
    const candidate = kind === 'rollback'
      ? { ...initial, turnId: 'rollback', now: '2026-08-21T11:59:30.000Z' }
      : { ...initial, turnId: 'future', sessionStartedAt: '2026-08-21T12:02:00.000Z', sessionSource: 'resume', now: '2026-08-21T12:01:00.000Z' };
    await assert.rejects(createIdentityStore({ dataRoot }).beginCallerTurn(candidate),
      { code: kind === 'rollback' ? 'AUTHORIZATION_RECORD_INVALID' : 'IDENTITY_INPUT_INVALID' });
  }
});

test('orphan recovery rejects malformed, future, active, and ledger-conflicting authority without legacy fallback', async () => {
  for (const state of ['malformed', 'future', 'active', 'ledger-conflict']) {
    const { dataRoot, workspaceA, workspaceB } = await fixture();
    const initial = {
      sessionId: `session-${state}`, turnId: 'turn-initial', workspace: workspaceA, permissionMode: 'default', prompt: 'initial',
      sessionStartedAt: '2026-08-21T11:59:00.000Z', sessionSource: 'startup', now: '2026-08-21T12:00:00.000Z',
    };
    const { active, activePath } = await createOrphanPending(dataRoot, initial);
    if (state === 'malformed') await atomicWriteJson(activePath, { ...active, unexpected: true });
    if (state === 'future') await atomicWriteJson(activePath, { ...active, createdAt: '2999-08-21T12:05:00.000Z' });
    if (state === 'active') await atomicWriteJson(activePath, { ...active, status: 'active' });
    if (state === 'ledger-conflict') {
      await atomicWriteJson(await globalSessionPath(dataRoot, initial.sessionId), {
        version: 1, kind: 'identity-session', key: active.key, sessionId: initial.sessionId,
        sessionStartedAt: initial.sessionStartedAt, sessionSource: initial.sessionSource, knownWorkspaces: [await realpath(workspaceB)],
        endedAt: null, updatedAt: '2026-08-21T12:00:00.000Z',
      });
    }
    const identity = createIdentityStore({ dataRoot });
    const replacement = { ...initial, turnId: 'turn-replacement', workspace: workspaceB, permissionMode: 'read-only', prompt: 'replacement', now: '2026-08-21T12:01:00.000Z' };
    await assert.rejects(identity.beginCallerTurn(replacement),
      { code: 'AUTHORIZATION_RECORD_INVALID' });
    if (state !== 'ledger-conflict') await assert.rejects(identity.cleanupSession(workspaceA, initial.sessionId), { code: 'AUTHORIZATION_RECORD_INVALID' });
    await assert.rejects(identity.createCallerContext({ sessionId: initial.sessionId, turnId: initial.turnId, workspace: workspaceA, permissionMode: initial.permissionMode }),
      (error) => error instanceof PluginError && ['AUTHORIZATION_RECORD_INVALID', 'CALLER_CONTEXT_INVALID'].includes(error.code));
    assert.deepEqual(await callerArtifactNames(dataRoot, workspaceA), []); assert.deepEqual(await callerArtifactNames(dataRoot, workspaceB), []);
  }
});

test('cleanup terminalizes a legal orphan pending lifecycle and fences old session proof', async () => {
  const { dataRoot, workspaceA } = await fixture();
  const initial = {
    sessionId: 'session-cleanup-orphan', turnId: 'turn-initial', workspace: workspaceA, permissionMode: 'default',
    sessionStartedAt: '2026-08-21T11:59:00.000Z', sessionSource: 'startup', now: '2026-08-21T12:00:00.000Z',
  };
  const { active } = await createOrphanPending(dataRoot, initial);
  const identity = createIdentityStore({ dataRoot }); const canonical = await realpath(workspaceA);
  const cleaned = await identity.cleanupSession(workspaceA, initial.sessionId);
  assert.deepEqual(cleaned, { knownWorkspaces: [canonical] });
  await assert.rejects(readFile(await globalActivePath(dataRoot, initial.sessionId), 'utf8'), { code: 'ENOENT' });
  const tombstone = JSON.parse(await readFile(await globalSessionPath(dataRoot, initial.sessionId), 'utf8'));
  assert.deepEqual(tombstone.knownWorkspaces, [canonical]); assert.ok(tombstone.endedAt !== null);
  assert.ok(Date.parse(tombstone.endedAt) >= Date.parse(active.createdAt));
  assert.deepEqual(await identity.cleanupSession(workspaceA, initial.sessionId), cleaned);
  await assert.rejects(identity.beginCallerTurn({ ...initial, turnId: 'stale-retry', now: '2026-08-21T12:01:00.000Z' }), { code: 'IDENTITY_SESSION_ENDED' });
  const newer = await identity.beginCallerTurn({
    ...initial, turnId: 'new-session-turn', sessionStartedAt: '2026-08-21T12:01:00.000Z', sessionSource: 'resume', now: '2026-08-21T12:02:00.000Z',
  });
  assert.equal((await identity.consumeCallerContext(newer, { workspace: workspaceA, now: '2026-08-21T12:02:00.000Z' })).turnId, 'new-session-turn');
});

test('orphan replacement active publication excludes cleanup under the same session lock', async () => {
  const { dataRoot, workspaceA } = await fixture();
  const initial = {
    sessionId: 'session-orphan-race', turnId: 'turn-initial', workspace: workspaceA, permissionMode: 'default',
    sessionStartedAt: '2026-08-21T11:59:00.000Z', sessionSource: 'startup', now: '2026-08-21T12:00:00.000Z',
  };
  await createOrphanPending(dataRoot, initial);
  const entered = deferred(); const release = deferred(); const events = [];
  const replacement = createIdentityStore({
    dataRoot,
    publicationSeam: async (point) => {
      if (point === 'before-active-publish') { events.push('replacement-locked'); entered.resolve(); await release.promise; }
      if (point === 'after-active-publish') events.push('replacement-active');
    },
  }).beginCallerTurn({ ...initial, turnId: 'turn-replacement', prompt: 'replacement', now: '2026-08-21T12:01:00.000Z' });
  await entered.promise;
  events.push('cleanup-requested');
  const cleanup = createIdentityStore({
    dataRoot,
    publicationSeam: async (point) => { if (point === 'after-cleanup-tombstone') events.push('cleanup-tombstoned'); },
  }).cleanupSession(workspaceA, initial.sessionId);
  release.resolve();
  const [token, cleaned] = await Promise.all([replacement, cleanup]);
  assert.deepEqual(events, ['replacement-locked', 'cleanup-requested', 'replacement-active', 'cleanup-tombstoned']);
  assert.deepEqual(cleaned, { knownWorkspaces: [await realpath(workspaceA)] });
  await assert.rejects(createIdentityStore({ dataRoot }).consumeCallerContext(token, { workspace: workspaceA }), { code: 'CALLER_CONTEXT_INVALID' });
});

test('moved execution workspace does not prevent exact v3 turn revocation', async () => {
  const { identity, root } = await fixture(); const { origin, execution } = await linkedWorktreeFixture(root);
  await identity.beginCallerTurn({
    sessionId: 'session-a', turnId: 'turn-a', workspace: origin, permissionMode: 'default',
    sessionStartedAt: '2026-08-20T11:59:00.000Z', sessionSource: 'startup',
  });
  await identity.resolveActiveTurn({ sessionId: 'session-a', workspace: execution, workspaceBinding: 'claim' });
  const canonicalExecution = await realpath(execution); await rename(execution, `${execution}-moved`);
  assert.deepEqual(await identity.endCallerTurn({ sessionId: 'session-a', turnId: 'turn-a', workspace: origin }), {
    originWorkspace: await realpath(origin), executionWorkspace: canonicalExecution,
  });
  assert.deepEqual(await identity.cleanupSession(origin, 'session-a'), {
    knownWorkspaces: [await realpath(origin), canonicalExecution],
  });
});

test('legacy exact resolve and active-turn scan reject oversized JSON through bounded readers', async () => {
  for (const method of ['resolveActiveTurn', 'resolveOnlyActiveTurn']) {
    const { dataRoot, identity, workspaceA } = await fixture();
    await identity.beginCallerTurn({ sessionId: 'legacy-session', turnId: 'legacy-turn', workspace: workspaceA, permissionMode: 'default' });
    const path = await activeTurnPath(dataRoot, workspaceA, 'legacy-session');
    await writeFile(path, `{"oversized":"${'x'.repeat(128 * 1024)}"`, { mode: 0o600 });
    const operation = method === 'resolveActiveTurn'
      ? identity.resolveActiveTurn({ sessionId: 'legacy-session', workspace: workspaceA })
      : identity.resolveOnlyActiveTurn({ workspace: workspaceA });
    await assert.rejects(operation, { code: 'AUTHORIZATION_RECORD_INVALID' });
  }
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

test('resolveOnlyActiveTurn rejects every canonical slot identity mismatch', async () => {
  for (const variant of ['filename', 'record-key', 'computed-key', 'workspace']) {
    const { dataRoot, identity, workspaceA, workspaceB } = await fixture();
    await identity.beginCallerTurn({ sessionId: 'session-a', turnId: 'turn-a', workspace: workspaceA, permissionMode: 'default', prompt: 'work' });
    const path = await activeTurnPath(dataRoot, workspaceA, 'session-a'); const record = JSON.parse(await readFile(path, 'utf8')); const forgedKey = 'f'.repeat(64);
    if (variant === 'filename') await rename(path, join(dirname(path), `${forgedKey}.json`));
    if (variant === 'record-key') { record.key = forgedKey; await atomicWriteJson(path, record); }
    if (variant === 'computed-key') { record.key = forgedKey; record.sessionId = 'forged-session'; await atomicWriteJson(join(dirname(path), `${forgedKey}.json`), record); await rename(path, `${path}.ignored`); }
    if (variant === 'workspace') { record.workspace = await realpath(workspaceB); await atomicWriteJson(path, record); }
    await assert.rejects(identity.resolveOnlyActiveTurn({ workspace: workspaceA }), { code: 'AUTHORIZATION_RECORD_INVALID' });
  }
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

test('endCallerTurn rejects mismatched slot identity without deleting the persisted record', async () => {
  for (const field of ['key', 'sessionId', 'workspace']) {
    const { dataRoot, identity, workspaceA, workspaceB } = await fixture(); const input = { sessionId: 'session-a', turnId: 'turn-a', workspace: workspaceA, permissionMode: 'default', prompt: 'work' };
    await identity.beginCallerTurn(input); const path = await activeTurnPath(dataRoot, workspaceA, input.sessionId); const record = JSON.parse(await readFile(path, 'utf8'));
    if (field === 'key') record.key = 'f'.repeat(64);
    if (field === 'sessionId') record.sessionId = 'forged-session';
    if (field === 'workspace') record.workspace = await realpath(workspaceB);
    await atomicWriteJson(path, record); const before = await readFile(path, 'utf8');
    await assert.rejects(identity.endCallerTurn({ sessionId: input.sessionId, turnId: input.turnId, workspace: workspaceA }), { code: 'AUTHORIZATION_RECORD_INVALID' });
    assert.equal(await readFile(path, 'utf8'), before);
  }
});

test('concurrent same-session replacements leave one exact active slot and one matching caller authorization', async () => {
  const { dataRoot, identity, workspaceA } = await fixture(); const workspace = await realpath(workspaceA);
  const turns = Array.from({ length: 12 }, (_, index) => `turn-${index}`);
  const tokens = await Promise.all(turns.map((turnId) => identity.beginCallerTurn({ sessionId: 'session-a', turnId, workspace: workspaceA, permissionMode: 'default', prompt: turnId })));
  const active = await identity.resolveOnlyActiveTurn({ workspace: workspaceA }); const storage = await resolveWorkspaceStorage({ dataRoot, workspace: workspaceA });
  const activeFiles = await readdir(join(storage.directory, 'identity', 'active-turns')); assert.deepEqual(activeFiles, [`${createHash('sha256').update(JSON.stringify(['session-a', workspace])).digest('hex')}.json`]);
  const attempts = await Promise.allSettled(tokens.map((token) => identity.consumeCallerContext(token, { workspace: workspaceA })));
  const authorized = attempts.filter((attempt) => attempt.status === 'fulfilled'); assert.equal(authorized.length, 1); assert.equal(authorized[0].value.turnId, active.turnId);
  const callerFiles = (await readdir(join(storage.directory, 'identity', 'callers'))).filter((name) => name.endsWith('.json')); assert.equal(callerFiles.length, 1);
  const caller = JSON.parse(await readFile(join(storage.directory, 'identity', 'callers', callerFiles[0]), 'utf8'));
  assert.equal(caller.sessionId, 'session-a'); assert.equal(caller.turnId, active.turnId); assert.equal(caller.workspace, workspace); assert.equal(callerFiles[0], `${caller.digest}.json`);
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
  const expected = /** @type {any} */ ({
    jobId: 'job-a',
    ownerSessionId: 'session-a',
    workspace: workspaceA,
    operation: 'run-reserved-job',
    jobSpecFormat: 'sealed-v2',
  });
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

test('execution capability reservation is private releasable and commits consumedAt exactly once', async () => {
  const { dataRoot, identity, workspaceA } = await fixture(); const expected = /** @type {any} */ ({
    jobId: 'reserved-capability', ownerSessionId: 'session-a', workspace: workspaceA,
    operation: 'run-reserved-job', jobSpecFormat: 'sealed-v2',
  });
  const token = await identity.createExecutionCapability({ ...expected, permissionSnapshot: { permissionMode: 'workspace-write' } });
  const reservationId = 'a'.repeat(64); const foreignReservation = 'b'.repeat(64);
  assert.equal((await identity.inspectExecutionCapability(token, expected, reservationId)).jobId, expected.jobId);
  const reserved = await identity.reserveExecutionCapability(token, expected, reservationId);
  assert.equal(reserved.executionReservationId, undefined);
  await assert.rejects(identity.reserveExecutionCapability(token, expected, foreignReservation), { code: 'EXECUTION_CAPABILITY_CONSUMED' });
  await assert.rejects(identity.consumeExecutionCapability(token, expected), { code: 'EXECUTION_CAPABILITY_CONSUMED' });
  await assert.rejects(identity.revokeExecutionCapability(token, expected), { code: 'EXECUTION_CAPABILITY_CONSUMED' });
  await identity.releaseExecutionCapability(token, expected, foreignReservation);
  const storage = await resolveWorkspaceStorage({ dataRoot, workspace: workspaceA }); const path = join(storage.directory,
    'identity', 'capabilities', `${createHash('sha256').update(token).digest('hex')}.json`);
  assert.equal(JSON.parse(await readFile(path, 'utf8')).executionReservationId, reservationId);
  await identity.releaseExecutionCapability(token, expected, reservationId);
  assert.equal(JSON.parse(await readFile(path, 'utf8')).executionReservationId, undefined);
  await identity.reserveExecutionCapability(token, expected, reservationId);
  const consumed = await identity.commitExecutionCapability(token, expected, reservationId);
  assert.ok(Date.parse(consumed.consumedAt)); assert.equal(consumed.executionReservationId, undefined);
  await assert.rejects(identity.commitExecutionCapability(token, expected, reservationId), { code: 'EXECUTION_CAPABILITY_CONSUMED' });
});

test('terminal recovery releases an exact lease reservation by private capability digest without its bearer', async () => {
  const { dataRoot, identity, workspaceA, workspaceB } = await fixture(); const workspace = await realpath(workspaceA);
  const expected = /** @type {any} */ ({ jobId: 'recovery-capability', ownerSessionId: 'session-a', workspace,
    operation: 'run-reserved-job', jobSpecFormat: 'sealed-v2' });
  const token = await identity.createExecutionCapability({
    ...expected, permissionSnapshot: { permissionMode: 'workspace-write' },
  });
  const capabilityDigest = createHash('sha256').update(token).digest('hex');
  const reservationId = 'a'.repeat(64); const workerLeaseId = 'b'.repeat(64);
  await identity.reserveExecutionCapability(token, expected, reservationId, workerLeaseId);
  const proof = /** @type {any} */ ({ capabilityDigest, reservationId, workerLeaseId, jobId: expected.jobId,
    ownerSessionId: expected.ownerSessionId, workspace, operation: expected.operation,
    jobSpecFormat: expected.jobSpecFormat, terminalStatus: 'failed' });
  for (const mismatch of [
    { ...proof, reservationId: 'c'.repeat(64) },
    { ...proof, workerLeaseId: 'd'.repeat(64) },
    { ...proof, jobId: 'other-job' },
    { ...proof, ownerSessionId: 'other-owner' },
    { ...proof, workspace: workspaceB },
    { ...proof, terminalStatus: 'running' },
  ]) await assert.rejects(identity.releaseExecutionReservation(mismatch));
  const storage = await resolveWorkspaceStorage({ dataRoot, workspace }); const path = join(storage.directory,
    'identity', 'capabilities', `${capabilityDigest}.json`);
  assert.equal(JSON.parse(await readFile(path, 'utf8')).executionReservationId, reservationId);
  await identity.releaseExecutionReservation(proof);
  const released = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(released.executionReservationId, undefined);
  assert.equal(released.executionReservationWorkerLeaseId, undefined);
  await identity.releaseExecutionReservation(proof);
  await identity.reserveExecutionCapability(token, expected, reservationId, workerLeaseId);
  await identity.commitExecutionCapability(token, expected, reservationId, workerLeaseId);
  await assert.rejects(identity.releaseExecutionReservation({ ...proof, workerLeaseId: 'e'.repeat(64) }));
  await identity.releaseExecutionReservation(proof);
});

test('revocation preserves consumed outcomes for legacy and spec-bound capabilities', async () => {
  for (const expected of /** @type {any[]} */ ([
    { jobId: 'legacy-job', ownerSessionId: 'session-a', operation: 'continue' },
    { jobId: 'spec-job', ownerSessionId: 'session-a', operation: 'run-reserved-job', jobSpecFormat: 'sealed-v2' },
  ])) {
    const { identity, workspaceA } = await fixture(); const binding = { ...expected, workspace: workspaceA };
    const token = await identity.createExecutionCapability({ ...binding, permissionSnapshot: { permissionMode: 'workspace-write' } });
    await identity.consumeExecutionCapability(token, binding);
    await assert.rejects(identity.revokeExecutionCapability(token, binding), { code: 'EXECUTION_CAPABILITY_CONSUMED' });
    await assert.rejects(identity.consumeExecutionCapability(token, binding), { code: 'EXECUTION_CAPABILITY_CONSUMED' });
  }
});

test('revocation durably tombstones unconsumed legacy and spec-bound capabilities', async () => {
  for (const expected of /** @type {any[]} */ ([
    { jobId: 'legacy-job', ownerSessionId: 'session-a', operation: 'continue' },
    { jobId: 'spec-job', ownerSessionId: 'session-a', operation: 'run-reserved-job', jobSpecFormat: 'sealed-v2' },
  ])) {
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

test('production issuer rejects an untyped historical run-reserved-job capability', async () => {
  const { identity, workspaceA } = await fixture();
  await assert.rejects(identity.createExecutionCapability({ jobId: 'historical-only', ownerSessionId: 'session-a',
    workspace: workspaceA, operation: 'run-reserved-job', specDigest: 'a'.repeat(64),
    permissionSnapshot: { permissionMode: 'workspace-write' } }), { code: 'IDENTITY_INPUT_INVALID' });
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
