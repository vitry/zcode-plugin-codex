import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { PluginError } from '../scripts/lib/errors.mjs';
import { atomicWriteJson, readJsonFile, withFileLock } from '../scripts/lib/fs.mjs';
import { createStateStore } from '../scripts/lib/state.mjs';
import { resolveWorkspaceStorage } from '../scripts/lib/workspace.mjs';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'zcode-state-'));
  const dataRoot = join(root, 'plugin-data');
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  return { dataRoot, root, workspace };
}

const jobInput = {
  ownerSessionId: 'session-a',
  ownerTurnId: 'turn-a',
  command: 'rescue',
  readOnly: false,
  permissionSnapshot: { mode: 'workspace-write' },
};

const fsModuleUrl = new URL('../scripts/lib/fs.mjs', import.meta.url).href;

/** @param {string} lockPath */
function startLockHolder(lockPath) {
  const source = `
    import { withFileLock } from ${JSON.stringify(fsModuleUrl)};
    const lockPath = process.argv[1];
    try {
      await withFileLock(lockPath, async () => {
        process.stdout.write('acquired\\n');
        await new Promise((resolve) => process.stdin.once('data', resolve));
      }, {
        pollIntervalMs: 5,
        timeoutMs: 1_000,
      });
      process.stdout.write('released\\n');
    } catch (error) {
      process.stdout.write(\`error:\${error.code}\\n\`);
    }
  `;
  return spawn(process.execPath, ['--input-type=module', '--eval', source, lockPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

/** @param {string} lockPath */
function startTimedLockAttempt(lockPath) {
  const source = `
    import { withFileLock } from ${JSON.stringify(fsModuleUrl)};
    try {
      await withFileLock(process.argv[1], async () => {
        process.stdout.write('entered');
      }, {
        pollIntervalMs: 5,
        timeoutMs: 75,
      });
    } catch (error) {
      process.stdout.write(\`error:\${error.code}\`);
    }
  `;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', source, lockPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    let output = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve(output);
      else reject(new Error(`Timed lock child exited ${code}: ${stderr}`));
    });
  });
}

/** @param {import('node:child_process').ChildProcess} child @param {string} expected */
async function waitForOutput(child, expected) {
  let output = '';
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for child output: ${expected}; received: ${output}`));
    }, 2_000);
    function cleanup() {
      clearTimeout(timeout);
      child.stdout?.off('data', onData);
      child.off('exit', onExit);
    }
    /** @param {Buffer} chunk */
    function onData(chunk) {
      output += chunk.toString();
      if (output.includes(expected)) {
        cleanup();
        resolve(undefined);
      }
    }
    /** @param {number | null} code */
    function onExit(code) {
      cleanup();
      reject(new Error(`Child exited with ${code}; output: ${output}`));
    }
    child.stdout?.on('data', onData);
    child.once('exit', onExit);
  });
}

/** @param {import('node:child_process').ChildProcess} child */
async function releaseLockHolder(child) {
  if (child.exitCode !== null) return;
  child.stdin?.end('release\n');
  await once(child, 'exit');
}

/** @param {string} path */
async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

test('jobs follow queued -> running -> succeeded and persist complete metadata', async () => {
  const { dataRoot, workspace } = await fixture();
  const store = createStateStore({ dataRoot });

  const queued = await store.reserveJob({ workspace, ...jobInput });
  assert.match(queued.id, /^[a-f0-9]{64}$/);
  assert.equal(queued.status, 'queued');

  const running = await store.transitionJob(workspace, queued.id, ['queued'], 'running', {
    childPid: 123,
  });
  assert.equal(running.status, 'running');
  assert.equal(running.childPid, 123);

  const succeeded = await store.transitionJob(workspace, queued.id, ['running'], 'succeeded', {
    exitCode: 0,
  });
  assert.equal(succeeded.status, 'succeeded');
  assert.deepEqual(await store.readJob(workspace, queued.id), succeeded);
  assert.deepEqual(await store.listJobs(workspace), [succeeded]);
});

test('cancellation can finish or return to running with the stop error', async () => {
  const { dataRoot, workspace } = await fixture();
  const store = createStateStore({ dataRoot });

  const cancelledJob = await store.reserveJob({ workspace, ...jobInput });
  await store.transitionJob(workspace, cancelledJob.id, ['queued'], 'running');
  await store.transitionJob(workspace, cancelledJob.id, ['running'], 'cancelling');
  const cancelled = await store.transitionJob(
    workspace,
    cancelledJob.id,
    ['cancelling'],
    'cancelled',
  );
  assert.equal(cancelled.status, 'cancelled');

  const retriedJob = await store.reserveJob({ workspace, ...jobInput });
  await store.transitionJob(workspace, retriedJob.id, ['queued'], 'running');
  await store.transitionJob(workspace, retriedJob.id, ['running'], 'cancelling');
  const restored = await store.transitionJob(
    workspace,
    retriedJob.id,
    ['cancelling'],
    'running',
    { lastCancelError: 'process refused SIGTERM' },
  );
  assert.equal(restored.status, 'running');
  assert.equal(restored.lastCancelError, 'process refused SIGTERM');
});

test('terminal jobs and invalid transitions are rejected with stable PluginErrors', async () => {
  const { dataRoot, workspace } = await fixture();
  const store = createStateStore({ dataRoot });
  const job = await store.reserveJob({ workspace, ...jobInput });
  await store.transitionJob(workspace, job.id, ['queued'], 'running');
  await store.transitionJob(workspace, job.id, ['running'], 'failed');

  await assert.rejects(
    store.transitionJob(workspace, job.id, ['failed'], 'running'),
    (error) => error instanceof PluginError
      && error.code === 'JOB_TERMINAL'
      && error.category === 'state'
      && typeof error.remedy === 'string',
  );

  const queued = await store.reserveJob({ workspace, ...jobInput });
  await assert.rejects(
    store.transitionJob(workspace, queued.id, ['running'], 'succeeded'),
    (error) => error instanceof PluginError
      && error.code === 'JOB_STATUS_CONFLICT'
      && error.details.actualStatus === 'queued',
  );
  await assert.rejects(
    store.transitionJob(workspace, queued.id, ['queued'], 'succeeded'),
    (error) => error instanceof PluginError && error.code === 'JOB_INVALID_TRANSITION',
  );
});

test('transition patches cannot rewrite job identity or scheduling invariants', async () => {
  const { dataRoot, workspace } = await fixture();
  const store = createStateStore({ dataRoot });
  const job = await store.reserveJob({ workspace, ...jobInput });
  const forbiddenPatches = [
    { id: 'a'.repeat(64) },
    { jobId: 'b'.repeat(64) },
    { workspace: '/forged/workspace' },
    { ownerSessionId: 'session-b' },
    { ownerTurnId: 'turn-b' },
    { command: 'different-command' },
    { readOnly: true },
    { permissionSnapshot: { mode: 'read-only' } },
    { createdAt: '2000-01-01T00:00:00.000Z' },
  ];

  for (const patch of forbiddenPatches) {
    await assert.rejects(
      store.transitionJob(workspace, job.id, ['queued'], 'running', patch),
      (error) => error instanceof PluginError
        && error.code === 'JOB_PATCH_FORBIDDEN'
        && error.category === 'state',
    );
  }

  const unchanged = await store.readJob(workspace, job.id);
  assert.equal(unchanged.status, 'queued');
  assert.equal(unchanged.readOnly, false);
  await assert.rejects(
    store.reserveJob({ workspace, ...jobInput, ownerTurnId: 'turn-b' }),
    (error) => error instanceof PluginError && error.code === 'WRITABLE_JOB_EXISTS',
  );
});

test('job reservation rejects incomplete or non-persistable input without weakening writable exclusivity', async () => {
  const { dataRoot, workspace } = await fixture();
  const store = createStateStore({ dataRoot });
  const invalidReservations = /** @type {any[]} */ ([
    { ...jobInput, workspace: undefined },
    { ...jobInput, readOnly: undefined },
    { ...jobInput, ownerSessionId: '' },
    { ...jobInput, ownerTurnId: '   ' },
    { ...jobInput, command: '' },
    { ...jobInput, permissionSnapshot: [] },
    { ...jobInput, permissionSnapshot: { mode: undefined } },
  ]);
  for (const reservation of invalidReservations) {
    await assert.rejects(
      store.reserveJob({ workspace, ...reservation }),
      (error) => error instanceof PluginError && error.code === 'JOB_INPUT_INVALID',
    );
  }

  await store.reserveJob({ workspace, ...jobInput });
  await assert.rejects(
    store.reserveJob({ workspace, ...jobInput, ownerTurnId: 'second-turn' }),
    (error) => error instanceof PluginError && error.code === 'WRITABLE_JOB_EXISTS',
  );
});

test('persisted jobs are schema-validated before use', async () => {
  const { dataRoot, workspace } = await fixture();
  const store = createStateStore({ dataRoot });
  const job = await store.reserveJob({ workspace, ...jobInput });
  const storage = await resolveWorkspaceStorage({ dataRoot, workspace });
  const path = join(storage.directory, 'jobs', `${job.id}.json`);
  await atomicWriteJson(path, { ...job, readOnly: 'false' });

  await assert.rejects(
    store.readJob(workspace, job.id),
    (error) => error instanceof PluginError && error.code === 'JOB_RECORD_INVALID',
  );

  await atomicWriteJson(path, { ...job, childPid: '123' });
  await assert.rejects(
    store.readJob(workspace, job.id),
    (error) => error instanceof PluginError && error.code === 'JOB_RECORD_INVALID',
  );
});

test('transition patch fields are typed and restricted to their lifecycle stage', async () => {
  const { dataRoot, workspace } = await fixture();
  const store = createStateStore({ dataRoot });
  const job = await store.reserveJob({ workspace, ...jobInput });
  for (const [nextStatus, patch] of /** @type {Array<[string, Record<string, unknown>]>} */ ([
    ['running', { childPid: 0 }],
    ['failed', { childPid: 123 }],
    ['running', { exitCode: 0 }],
    ['running', { lastCancelError: 'not a rollback' }],
  ])) {
    await assert.rejects(
      store.transitionJob(workspace, job.id, ['queued'], nextStatus, patch),
      (error) => error instanceof PluginError && error.code === 'JOB_PATCH_INVALID',
    );
  }

  await store.transitionJob(workspace, job.id, ['queued'], 'running', { childPid: 123 });
  await assert.rejects(
    store.transitionJob(workspace, job.id, ['running'], 'failed', { exitCode: 1.5 }),
    (error) => error instanceof PluginError && error.code === 'JOB_PATCH_INVALID',
  );
  await assert.rejects(
    store.transitionJob(workspace, job.id, ['running'], 'failed', /** @type {any} */ (null)),
    (error) => error instanceof PluginError && error.code === 'JOB_PATCH_INVALID',
  );
});

test('a workspace permits one writable job while read-only jobs remain concurrent', async () => {
  const { dataRoot, workspace } = await fixture();
  const store = createStateStore({ dataRoot });

  const attempts = await Promise.allSettled([
    store.reserveJob({ workspace, ...jobInput }),
    store.reserveJob({ workspace, ...jobInput, ownerTurnId: 'turn-b' }),
  ]);
  assert.equal(attempts.filter(({ status }) => status === 'fulfilled').length, 1);
  const rejection = attempts.find(({ status }) => status === 'rejected');
  assert.ok(rejection && rejection.status === 'rejected');
  assert.equal(rejection.reason.code, 'WRITABLE_JOB_EXISTS');

  const readOnlyJobs = await Promise.all([
    store.reserveJob({ workspace, ...jobInput, ownerTurnId: 'read-a', readOnly: true }),
    store.reserveJob({ workspace, ...jobInput, ownerTurnId: 'read-b', readOnly: true }),
  ]);
  assert.equal(readOnlyJobs.length, 2);
});

test('workspace storage hashes the real path and creates private directories', async () => {
  const { dataRoot, workspace } = await fixture();
  const first = await resolveWorkspaceStorage({ dataRoot, workspace });
  const second = await resolveWorkspaceStorage({ dataRoot, workspace: `${workspace}/.` });

  assert.equal(first.workspaceKey, second.workspaceKey);
  assert.match(first.workspaceKey, /^[a-f0-9]{64}$/);
  assert.equal(first.directory, join(dataRoot, 'workspaces', first.workspaceKey));
  assert.equal((await stat(first.directory)).mode & 0o777, 0o700);
});

test('atomic JSON writes use private files and leave no sibling temporary artifact', async () => {
  const { root } = await fixture();
  const directory = join(root, 'atomic');
  const path = join(directory, 'record.json');
  await mkdir(directory, { mode: 0o700 });

  await Promise.all([
    atomicWriteJson(path, { writer: 'a', payload: 'a'.repeat(1000) }),
    atomicWriteJson(path, { writer: 'b', payload: 'b'.repeat(1000) }),
  ]);

  const parsed = JSON.parse(await readFile(path, 'utf8'));
  assert.ok(parsed.writer === 'a' || parsed.writer === 'b');
  assert.equal(parsed.payload, parsed.writer.repeat(1000));
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(directory), ['record.json']);
});

test('the advisory lock keeps one stable inode and never renames ownership metadata', async () => {
  const { root } = await fixture();
  const lockPath = join(root, 'stable.lock');
  /** @type {number | undefined} */
  let inodeWhileHeld;
  await withFileLock(lockPath, async () => {
    assert.deepEqual(await readdir(lockPath), ['advisory.lock']);
    inodeWhileHeld = (await stat(join(lockPath, 'advisory.lock'))).ino;
  });

  assert.deepEqual(await readdir(lockPath), ['advisory.lock']);
  assert.equal((await stat(join(lockPath, 'advisory.lock'))).ino, inodeWhileHeld);
  await withFileLock(lockPath, async () => {
    assert.equal((await stat(join(lockPath, 'advisory.lock'))).ino, inodeWhileHeld);
  });
});

test('lock timing options reject non-finite, fractional, or unsafe values', async () => {
  const { root } = await fixture();
  const lockPath = join(root, 'options.lock');
  for (const options of [
    { timeoutMs: Number.NaN }, { timeoutMs: -1 }, { timeoutMs: 1.5 },
    { pollIntervalMs: 0 }, { pollIntervalMs: Number.POSITIVE_INFINITY }, { pollIntervalMs: 1.5 },
  ]) {
    await assert.rejects(
      withFileLock(lockPath, async () => undefined, options),
      (error) => error instanceof PluginError && error.code === 'LOCK_OPTIONS_INVALID',
    );
  }
});

test('a live child lock holder cannot be evicted solely because directory mtime is old', async () => {
  const { root } = await fixture();
  const lockPath = join(root, 'live.lock');
  const child = startLockHolder(lockPath);
  try {
    await waitForOutput(child, 'acquired');
    const old = new Date(Date.now() - 60_000);
    await utimes(lockPath, old, old);

    await assert.rejects(
      withFileLock(lockPath, async () => 'must-not-enter', {
        pollIntervalMs: 5,
        timeoutMs: 75,
      }),
      (error) => error instanceof PluginError && error.code === 'LOCK_TIMEOUT',
    );
  } finally {
    await releaseLockHolder(child);
    await rm(lockPath, { force: true, recursive: true });
  }
});

test('a synchronized stale takeover attempt never creates parallel critical sections', async () => {
  const { root } = await fixture();
  const lockPath = join(root, 'barrier.lock');
  const holder = startLockHolder(lockPath);
  try {
    await waitForOutput(holder, 'acquired');
    const ownerPath = join(lockPath, 'owner.json');
    if (await pathExists(ownerPath)) {
      const owner = await readJsonFile(ownerPath);
      await atomicWriteJson(ownerPath, {
        ...owner,
        hostname: 'unreachable-remote-host',
        heartbeatAt: new Date(Date.now() - 60_000).toISOString(),
      });
    }

    const contenderResult = await startTimedLockAttempt(lockPath);
    assert.equal(contenderResult, 'error:LOCK_TIMEOUT');
  } finally {
    await releaseLockHolder(holder);
    await rm(lockPath, { force: true, recursive: true });
  }
});

test('an advisory lock is automatically released when its child holder is killed', async () => {
  const { root } = await fixture();
  const lockPath = join(root, 'dead.lock');
  const child = startLockHolder(lockPath);
  await waitForOutput(child, 'acquired');
  child.kill('SIGKILL');
  await once(child, 'exit');

  const result = await withFileLock(lockPath, async () => 'recovered', {
    pollIntervalMs: 5,
    timeoutMs: 75,
  });
  assert.equal(result, 'recovered');
  assert.equal(await pathExists(lockPath), true, 'persistent advisory lock directory remains reusable');
});

test('an advisory lock is automatically released when its child holder exits', async () => {
  const { root } = await fixture();
  const lockPath = join(root, 'exited.lock');
  const child = startLockHolder(lockPath);
  await waitForOutput(child, 'acquired');
  child.kill('SIGTERM');
  await once(child, 'exit');
  const result = await withFileLock(lockPath, async () => 'recovered', {
    pollIntervalMs: 5,
    timeoutMs: 75,
  });
  assert.equal(result, 'recovered');
});

test('an old child holder never removes a replacement lock during release', async () => {
  const { root } = await fixture();
  const lockPath = join(root, 'aba.lock');
  const replacementMarker = join(lockPath, 'replacement-owner');
  const child = startLockHolder(lockPath);
  try {
    await waitForOutput(child, 'acquired');
    await rm(lockPath, { recursive: true });
    await mkdir(lockPath, { mode: 0o700 });
    await writeFile(replacementMarker, 'new-owner');
    await releaseLockHolder(child);

    assert.equal(await pathExists(replacementMarker), true);
  } finally {
    if (child.exitCode === null) child.kill();
    await rm(lockPath, { force: true, recursive: true });
  }
});

test('path and JSON failures retain their causes behind stable PluginErrors', async () => {
  const { dataRoot, root } = await fixture();
  const missingWorkspace = join(root, 'missing-workspace');
  await assert.rejects(
    resolveWorkspaceStorage({ dataRoot, workspace: missingWorkspace }),
    (error) => error instanceof PluginError
      && error.code === 'WORKSPACE_RESOLVE_FAILED'
      && error.cause instanceof Error,
  );

  const malformed = join(root, 'bad.json');
  await writeFile(malformed, '{');
  await assert.rejects(
    readJsonFile(malformed),
    (error) => error instanceof PluginError
      && error.code === 'JSON_PARSE_FAILED'
      && error.cause instanceof Error,
  );
});
