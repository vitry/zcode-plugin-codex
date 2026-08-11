import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  truncate,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { PluginError } from '../scripts/lib/errors.mjs';
import { atomicWriteJson, isLockPublishCollision, readJsonFile, withFileLock } from '../scripts/lib/fs.mjs';
import { createStateStore } from '../scripts/lib/state.mjs';

test('production terminal callers delegate finishedAt selection to the locked state API', async () => {
  const sources = ['job-control.mjs', 'review.mjs', 'recovery.mjs', 'transfer.mjs'].map((name) => fileURLToPath(new URL(`../scripts/lib/${name}`, import.meta.url))).concat(fileURLToPath(new URL('../scripts/zcode-companion.mjs', import.meta.url)));
  for (const source of sources) assert.doesNotMatch(await readFile(source, 'utf8'), /finishedAt:\s*new Date\(\)\.toISOString\(\)/, source);
});
import { resolveWorkspaceStorage } from '../scripts/lib/workspace.mjs';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'zcode-state-'));
  const dataRoot = join(root, 'plugin-data');
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  return { dataRoot, root, workspace };
}

/** @param {string} indexRoot @param {string} jobId */
async function bindingLocation(indexRoot, jobId) {
  const ownerDirectories = (await readdir(indexRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && /^[a-f0-9]{64}$/.test(entry.name));
  for (const ownerDirectory of ownerDirectories) {
    const directory = join(indexRoot, ownerDirectory.name); const path = join(directory, `${jobId}.json`);
    try { await access(path); return { directory, path }; } catch { /* inspect the next exact owner directory */ }
  }
  assert.fail(`binding ${jobId} was not found`);
}

const jobInput = {
  ownerSessionId: 'session-a',
  ownerTurnId: 'turn-a',
  command: 'rescue',
  readOnly: false,
  permissionSnapshot: { mode: 'workspace-write' },
};

const fsModuleUrl = new URL('../scripts/lib/fs.mjs', import.meta.url).href;
const lockHolder = fileURLToPath(new URL('./fixtures/lock-holder.mjs', import.meta.url));

/** @param {string} lockPath */
function startLockHolder(lockPath) {
  return spawn(process.execPath, [lockHolder, lockPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
    windowsHide: true,
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
  let output = ''; let stderr = '';
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for child output: ${expected}; received: ${output}; stderr: ${stderr}`));
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
      reject(new Error(`Child exited with ${code}; output: ${output}; stderr: ${stderr}`));
    }
    child.stdout?.on('data', onData);
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
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

test('a queued job durably claims one exact worker before long-running setup', async () => {
  const { dataRoot, workspace } = await fixture();
  const store = createStateStore({ dataRoot });
  const job = await store.reserveJob({ workspace, ...jobInput });
  const workerLeaseId = 'a'.repeat(64);
  const claimed = await store.claimJobWorker(workspace, job.id, { childPid: 4321, workerLeaseId });
  assert.equal(claimed.status, 'queued');
  assert.equal(claimed.childPid, 4321);
  assert.equal(claimed.workerLeaseId, workerLeaseId);
  assert.deepEqual(await store.claimJobWorker(workspace, job.id, { childPid: 4321, workerLeaseId }), claimed, 'the exact worker may observe its durable claim again');
  await assert.rejects(store.claimJobWorker(workspace, job.id, { childPid: 4322, workerLeaseId: 'b'.repeat(64) }), { code: 'WORKER_LEASE_CONFLICT' });
  const running = await store.transitionJob(workspace, job.id, ['queued'], 'running', { startedAt: new Date().toISOString() });
  assert.equal(running.workerLeaseId, workerLeaseId);
  assert.equal(running.childPid, 4321);
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
    { ...jobInput, command: 'arbitrary-shell' },
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

test('state API rejects malformed reservation and transition shapes with stable errors', async () => {
  assert.throws(
    () => createStateStore(/** @type {any} */ (undefined)),
    (error) => error instanceof PluginError && error.code === 'DATA_ROOT_REQUIRED',
  );
  const { dataRoot, workspace } = await fixture();
  const store = createStateStore({ dataRoot });
  for (const reservation of /** @type {any[]} */ ([undefined, null, [], 'rescue'])) {
    await assert.rejects(
      store.reserveJob(reservation),
      (error) => error instanceof PluginError && error.code === 'JOB_INPUT_INVALID',
    );
  }

  const job = await store.reserveJob({ workspace, ...jobInput });
  for (const [expectedStatuses, nextStatus, patch] of /** @type {any[]} */ ([
    [undefined, 'running', {}],
    [{ queued: true }, 'running', {}],
    [[], 'running', {}],
    [['unknown'], 'running', {}],
    [['queued', 1], 'running', {}],
    [['queued'], undefined, {}],
    [['queued'], 'unknown', {}],
    [['queued'], 'running', null],
    [['queued'], 'running', []],
  ])) {
    await assert.rejects(
      store.transitionJob(workspace, job.id, expectedStatuses, nextStatus, patch),
      (error) => error instanceof PluginError && error.code === 'JOB_TRANSITION_INPUT_INVALID',
    );
  }
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

  await atomicWriteJson(path, { ...job, command: 'arbitrary-shell' });
  await assert.rejects(
    store.readJob(workspace, job.id),
    (error) => error instanceof PluginError && error.code === 'JOB_RECORD_INVALID',
  );

  for (const invalidJob of [
    { ...job, finishedAt: '2026-08-04T01:03:04.000Z' },
    { ...job, resultArtifact: 'artifacts/result.json' },
    { ...job, status: 'running', error: 'too early' },
    { ...job, status: 'failed', resultArtifact: 'artifacts/result.json' },
  ]) {
    await atomicWriteJson(path, invalidJob);
    await assert.rejects(
      store.readJob(workspace, job.id),
      (error) => error instanceof PluginError && error.code === 'JOB_RECORD_INVALID',
    );
  }
});

test('owned job listing migrates valid legacy records and fails closed without path disclosure on corrupt legacy state', async () => {
  const { dataRoot, root, workspace } = await fixture(); const source = createStateStore({ dataRoot });
  const legacyJob = await source.reserveJob({ workspace, ...jobInput });

  const migratedDataRoot = join(root, 'legacy-valid-data');
  const migratedStorage = await resolveWorkspaceStorage({ dataRoot: migratedDataRoot, workspace });
  await atomicWriteJson(join(migratedStorage.directory, 'jobs', `${legacyJob.id}.json`), legacyJob);
  const migratedStore = createStateStore({ dataRoot: migratedDataRoot });
  assert.deepEqual(await migratedStore.listOwnedJobs(workspace, legacyJob.ownerSessionId), [legacyJob]);

  const corruptDataRoot = join(root, 'legacy-corrupt-data');
  const corruptStorage = await resolveWorkspaceStorage({ dataRoot: corruptDataRoot, workspace });
  await mkdir(join(corruptStorage.directory, 'jobs'), { recursive: true });
  await writeFile(join(corruptStorage.directory, 'jobs', `${legacyJob.id}.json`), '{');
  const corruptStore = createStateStore({ dataRoot: corruptDataRoot });
  await assert.rejects(corruptStore.listOwnedJobs(workspace, legacyJob.ownerSessionId), (error) => {
    assert.ok(error instanceof PluginError);
    assert.equal(error.code, 'OWNED_JOB_INDEX_INVALID'); assert.deepEqual(error.details, { jobId: legacyJob.id });
    assert.doesNotMatch(error.message, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    return true;
  });
});

test('owned job bindings enforce exact bounded schema and tolerate only binding-first crash remnants', async () => {
  const { dataRoot, workspace } = await fixture(); const store = createStateStore({ dataRoot });
  const job = await store.reserveJob({ workspace, ...jobInput }); const storage = await resolveWorkspaceStorage({ dataRoot, workspace });
  const indexRoot = join(storage.directory, 'job-owners');
  const [ownerDirectory] = (await readdir(indexRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory() && /^[a-f0-9]{64}$/.test(entry.name));
  assert.ok(ownerDirectory, 'reservation must publish one hashed owner binding directory');
  const bindingPath = join(indexRoot, ownerDirectory.name, `${job.id}.json`); const original = await readFile(bindingPath, 'utf8');

  await atomicWriteJson(bindingPath, { jobId: job.id, ownerSessionId: job.ownerSessionId, version: 1, extra: true });
  await assert.rejects(store.listOwnedJobs(workspace, job.ownerSessionId), { code: 'OWNED_JOB_INDEX_INVALID', details: { jobId: job.id } });
  await writeFile(bindingPath, 'x'.repeat(8 * 1024 + 1));
  await assert.rejects(store.listOwnedJobs(workspace, job.ownerSessionId), { code: 'OWNED_JOB_INDEX_INVALID', details: { jobId: job.id } });

  await writeFile(bindingPath, original); await rm(join(storage.directory, 'jobs', `${job.id}.json`));
  assert.deepEqual(await store.listOwnedJobs(workspace, job.ownerSessionId), [], 'binding-first publication may leave one ignorable missing-job remnant');
});

test('owned job index repairs deleted bindings and mixed-version canonical writes before owner selection', async () => {
  const { dataRoot, workspace } = await fixture(); const firstStore = createStateStore({ dataRoot });
  const first = await firstStore.reserveJob({ workspace, ...jobInput }); const storage = await resolveWorkspaceStorage({ dataRoot, workspace });
  const indexRoot = join(storage.directory, 'job-owners');
  const markerPath = join(indexRoot, 'index.json'); const currentMarker = JSON.parse(await readFile(markerPath, 'utf8'));
  await atomicWriteJson(markerPath, {
    bindingJobIds: currentMarker.canonicalJobIds,
    canonicalJobIds: currentMarker.canonicalJobIds,
    complete: true,
    version: 2,
  });
  const [firstOwnerDirectory] = (await readdir(indexRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && /^[a-f0-9]{64}$/.test(entry.name));
  assert.ok(firstOwnerDirectory);
  await rm(join(indexRoot, firstOwnerDirectory.name, `${first.id}.json`));

  const legacyId = 'b'.repeat(64);
  const legacy = {
    ...first,
    id: legacyId,
    ownerSessionId: 'session-from-old-writer',
    ownerTurnId: 'turn-from-old-writer',
    readOnly: true,
  };
  await atomicWriteJson(join(storage.directory, 'jobs', `${legacyId}.json`), legacy);

  const secondStore = createStateStore({ dataRoot });
  assert.deepEqual(await secondStore.listOwnedJobs(workspace, first.ownerSessionId), [first], 'a deleted binding must not make an existing owner disappear');
  assert.deepEqual(await secondStore.listOwnedJobs(workspace, legacy.ownerSessionId), [legacy], 'a canonical record from an older writer must be indexed before owner selection');

  const marker = JSON.parse(await readFile(markerPath, 'utf8'));
  assert.deepEqual(Object.keys(marker).sort(), ['bindingTuples', 'canonicalJobIds', 'complete', 'version']);
  assert.equal(marker.version, 3); assert.equal(marker.complete, true);
  assert.deepEqual(marker.canonicalJobIds.count, 2); assert.deepEqual(marker.bindingTuples.count, 2);
  assert.match(marker.canonicalJobIds.digest, /^[a-f0-9]{64}$/); assert.match(marker.bindingTuples.digest, /^[a-f0-9]{64}$/);
});

test('owned job index repairs relocated, rewritten, duplicated, and swapped owner bindings', async (t) => {
  /** @type {Record<string, (input:any) => Promise<void>>} */
  const variants = {
    'move unchanged record': async ({ first, second }) => { await rename(first.path, join(second.directory, basename(first.path))); },
    'move and rewrite owner': async ({ first, second, firstJob }) => {
      const moved = join(second.directory, basename(first.path)); await rename(first.path, moved);
      await atomicWriteJson(moved, { jobId: firstJob.id, ownerSessionId: 'owner-b', version: 1 });
    },
    'duplicate binding': async ({ first, second }) => { await writeFile(join(second.directory, basename(first.path)), await readFile(first.path)); },
    'swap owner directories': async ({ root, first, second, firstJob, secondJob }) => {
      const temporary = join(root, 'binding-swap.tmp'); await rename(first.path, temporary);
      await rename(second.path, join(first.directory, `${secondJob.id}.json`));
      await rename(temporary, join(second.directory, `${firstJob.id}.json`));
    },
  };
  for (const [name, tamper] of Object.entries(variants)) await t.test(name, async () => {
    const { dataRoot, root, workspace } = await fixture(); const store = createStateStore({ dataRoot });
    const firstJob = await store.reserveJob({ workspace, ...jobInput, ownerSessionId: 'owner-a' });
    const secondJob = await store.reserveJob({ workspace, ...jobInput, ownerSessionId: 'owner-b', ownerTurnId: 'turn-b', readOnly: true });
    const storage = await resolveWorkspaceStorage({ dataRoot, workspace }); const indexRoot = join(storage.directory, 'job-owners');
    const first = await bindingLocation(indexRoot, firstJob.id); const second = await bindingLocation(indexRoot, secondJob.id);
    const markerBefore = await readFile(join(indexRoot, 'index.json'), 'utf8');
    await tamper({ root, first, second, firstJob, secondJob });
    assert.equal(await readFile(join(indexRoot, 'index.json'), 'utf8'), markerBefore, 'tamper fixture must leave the last trusted marker unchanged');

    assert.deepEqual(await store.listOwnedJobs(workspace, firstJob.ownerSessionId), [firstJob], `${name} must not hide owner A's writable guard`);
    assert.deepEqual(await store.listOwnedJobs(workspace, secondJob.ownerSessionId), [secondJob], `${name} must not authorize owner B for owner A's job`);
    const repairedFirst = await bindingLocation(indexRoot, firstJob.id); const repairedSecond = await bindingLocation(indexRoot, secondJob.id);
    assert.equal(repairedFirst.directory, first.directory); assert.equal(repairedSecond.directory, second.directory);
    assert.equal(JSON.parse(await readFile(join(indexRoot, 'index.json'), 'utf8')).version, 3);
  });
});

test('owned job index rejects directory and binding symlinks that escape private workspace state', async () => {
  const directoryFixture = await fixture(); const directoryStore = createStateStore({ dataRoot: directoryFixture.dataRoot });
  const directoryJob = await directoryStore.reserveJob({ workspace: directoryFixture.workspace, ...jobInput });
  const directoryStorage = await resolveWorkspaceStorage({ dataRoot: directoryFixture.dataRoot, workspace: directoryFixture.workspace });
  const indexRoot = join(directoryStorage.directory, 'job-owners'); const outsideIndex = join(directoryFixture.root, 'outside-index');
  await rename(indexRoot, outsideIndex); await symlink(outsideIndex, indexRoot);
  await assert.rejects(directoryStore.listOwnedJobs(directoryFixture.workspace, directoryJob.ownerSessionId), (error) => {
    assert.ok(error instanceof PluginError);
    assert.equal(error.code, 'OWNED_JOB_INDEX_INVALID');
    assert.doesNotMatch(error.message, new RegExp(directoryFixture.root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    return true;
  });

  const bindingFixture = await fixture(); const bindingStore = createStateStore({ dataRoot: bindingFixture.dataRoot });
  const bindingJob = await bindingStore.reserveJob({ workspace: bindingFixture.workspace, ...jobInput });
  const bindingStorage = await resolveWorkspaceStorage({ dataRoot: bindingFixture.dataRoot, workspace: bindingFixture.workspace });
  const bindingIndex = join(bindingStorage.directory, 'job-owners');
  const [bindingOwnerDirectory] = (await readdir(bindingIndex, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && /^[a-f0-9]{64}$/.test(entry.name));
  assert.ok(bindingOwnerDirectory);
  const bindingPath = join(bindingIndex, bindingOwnerDirectory.name, `${bindingJob.id}.json`); const outsideBinding = join(bindingFixture.root, 'outside-binding.json');
  await rename(bindingPath, outsideBinding); await symlink(outsideBinding, bindingPath);
  await assert.rejects(bindingStore.listOwnedJobs(bindingFixture.workspace, bindingJob.ownerSessionId), (error) => {
    assert.ok(error instanceof PluginError);
    assert.equal(error.code, 'OWNED_JOB_INDEX_INVALID');
    assert.doesNotMatch(error.message, new RegExp(bindingFixture.root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    return true;
  });
  assert.deepEqual(JSON.parse(await readFile(outsideBinding, 'utf8')), { jobId: bindingJob.id, ownerSessionId: bindingJob.ownerSessionId, version: 1 });
});

test('owned job index rejects a huge sparse binding through its bounded reader', async () => {
  const { dataRoot, root, workspace } = await fixture(); const store = createStateStore({ dataRoot });
  const job = await store.reserveJob({ workspace, ...jobInput }); const storage = await resolveWorkspaceStorage({ dataRoot, workspace });
  const indexRoot = join(storage.directory, 'job-owners');
  const [ownerDirectory] = (await readdir(indexRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && /^[a-f0-9]{64}$/.test(entry.name));
  assert.ok(ownerDirectory);
  const bindingPath = join(indexRoot, ownerDirectory.name, `${job.id}.json`); await truncate(bindingPath, 4 * 1024 * 1024 * 1024);
  const started = Date.now();
  await assert.rejects(store.listOwnedJobs(workspace, job.ownerSessionId), (error) => {
    assert.ok(error instanceof PluginError);
    assert.equal(error.code, 'OWNED_JOB_INDEX_INVALID'); assert.deepEqual(error.details, { jobId: job.id });
    assert.doesNotMatch(error.message, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    return true;
  });
  assert.ok(Date.now() - started < 1_000, 'a sparse oversized binding must be rejected before an unbounded file read');
});

test('persisted jobs are bound to their filename and canonical workspace scope', async () => {
  const { dataRoot, root, workspace } = await fixture();
  const otherWorkspace = join(root, 'other-workspace');
  await mkdir(otherWorkspace);
  const store = createStateStore({ dataRoot });
  const [job, otherJob] = await Promise.all([
    store.reserveJob({ workspace, ...jobInput }),
    store.reserveJob({ workspace: otherWorkspace, ...jobInput, ownerTurnId: 'turn-b' }),
  ]);
  const storage = await resolveWorkspaceStorage({ dataRoot, workspace });
  const otherStorage = await resolveWorkspaceStorage({ dataRoot, workspace: otherWorkspace });
  const path = join(storage.directory, 'jobs', `${job.id}.json`);
  const otherPath = join(otherStorage.directory, 'jobs', `${otherJob.id}.json`);

  await atomicWriteJson(path, { ...job, id: otherJob.id });
  await assert.rejects(
    store.readJob(workspace, job.id),
    (error) => error instanceof PluginError && error.code === 'JOB_RECORD_INVALID',
  );
  await atomicWriteJson(path, job);

  await atomicWriteJson(otherPath, job);
  await assert.rejects(
    store.transitionJob(otherWorkspace, otherJob.id, ['queued'], 'running'),
    (error) => error instanceof PluginError && error.code === 'JOB_RECORD_INVALID',
  );
  await atomicWriteJson(otherPath, otherJob);

  await atomicWriteJson(join(otherStorage.directory, 'jobs', `${job.id}.json`), job);
  await assert.rejects(
    store.listJobs(otherWorkspace),
    (error) => error instanceof PluginError && error.code === 'JOB_RECORD_INVALID',
  );
});

test('job listing ignores files whose names are not canonical job IDs', async () => {
  const { dataRoot, workspace } = await fixture();
  const store = createStateStore({ dataRoot });
  const job = await store.reserveJob({ workspace, ...jobInput });
  const storage = await resolveWorkspaceStorage({ dataRoot, workspace });
  await atomicWriteJson(join(storage.directory, 'jobs', 'copied-job.json'), job);

  assert.deepEqual(await store.listJobs(workspace), [job]);
});

test('persisted job timestamps must remain monotonic', async () => {
  const { dataRoot, workspace } = await fixture();
  const store = createStateStore({ dataRoot });
  const job = await store.reserveJob({ workspace, ...jobInput });
  const storage = await resolveWorkspaceStorage({ dataRoot, workspace });
  const path = join(storage.directory, 'jobs', `${job.id}.json`);
  const created = Date.parse(job.createdAt);
  const beforeCreated = new Date(created - 1).toISOString();
  const afterCreated = new Date(created + 2_000).toISOString();
  const betweenCreatedAndStarted = new Date(created + 1_000).toISOString();
  for (const invalidJob of [
    { ...job, updatedAt: beforeCreated },
    { ...job, status: 'running', startedAt: beforeCreated },
    {
      ...job,
      status: 'succeeded',
      startedAt: afterCreated,
      finishedAt: betweenCreatedAndStarted,
    },
    { ...job, status: 'failed', finishedAt: beforeCreated },
  ]) {
    await atomicWriteJson(path, invalidJob);
    await assert.rejects(
      store.readJob(workspace, job.id),
      (error) => error instanceof PluginError && error.code === 'JOB_RECORD_INVALID',
    );
  }
});

test('persisted updatedAt cannot precede startedAt', async () => {
  const { dataRoot, workspace } = await fixture();
  const store = createStateStore({ dataRoot });
  const job = await store.reserveJob({ workspace, ...jobInput });
  const storage = await resolveWorkspaceStorage({ dataRoot, workspace });
  const path = join(storage.directory, 'jobs', `${job.id}.json`);
  await atomicWriteJson(path, {
    ...job,
    status: 'running',
    startedAt: new Date(Date.parse(job.updatedAt) + 1).toISOString(),
  });

  await assert.rejects(
    store.readJob(workspace, job.id),
    (error) => error instanceof PluginError && error.code === 'JOB_RECORD_INVALID',
  );
});

test('persisted updatedAt cannot precede finishedAt', async () => {
  const { dataRoot, workspace } = await fixture();
  const store = createStateStore({ dataRoot });
  const job = await store.reserveJob({ workspace, ...jobInput });
  const storage = await resolveWorkspaceStorage({ dataRoot, workspace });
  const path = join(storage.directory, 'jobs', `${job.id}.json`);
  await atomicWriteJson(path, {
    ...job,
    status: 'succeeded',
    finishedAt: new Date(Date.parse(job.updatedAt) + 1).toISOString(),
  });

  await assert.rejects(
    store.readJob(workspace, job.id),
    (error) => error instanceof PluginError && error.code === 'JOB_RECORD_INVALID',
  );
});

test('running transition advances updatedAt through a future startedAt', async () => {
  const { dataRoot, workspace } = await fixture();
  const store = createStateStore({ dataRoot });
  const job = await store.reserveJob({ workspace, ...jobInput });
  const startedAt = new Date(Date.now() + 60_000).toISOString();
  const running = await store.transitionJob(workspace, job.id, ['queued'], 'running', { startedAt });

  assert.ok(Date.parse(running.updatedAt) >= Date.parse(startedAt));
  assert.equal(new Date(running.updatedAt).toISOString(), running.updatedAt);
});

test('terminal transition advances updatedAt through a future finishedAt', async () => {
  const { dataRoot, workspace } = await fixture();
  const store = createStateStore({ dataRoot });
  const job = await store.reserveJob({ workspace, ...jobInput });
  await store.transitionJob(workspace, job.id, ['queued'], 'running');
  const finishedAt = new Date(Date.now() + 60_000).toISOString();
  const succeeded = await store.transitionJob(workspace, job.id, ['running'], 'succeeded', {
    finishedAt,
  });

  assert.ok(Date.parse(succeeded.updatedAt) >= Date.parse(finishedAt));
  assert.equal(new Date(succeeded.updatedAt).toISOString(), succeeded.updatedAt);
});

test('job transitions reject reversed phase times and preserve updatedAt monotonicity', async () => {
  const { dataRoot, workspace } = await fixture();
  const store = createStateStore({ dataRoot });
  const job = await store.reserveJob({ workspace, ...jobInput });
  const created = Date.parse(job.createdAt);
  await assert.rejects(
    store.transitionJob(workspace, job.id, ['queued'], 'running', {
      startedAt: new Date(created - 1).toISOString(),
    }),
    (error) => error instanceof PluginError && error.code === 'JOB_PATCH_INVALID',
  );

  const storage = await resolveWorkspaceStorage({ dataRoot, workspace });
  const path = join(storage.directory, 'jobs', `${job.id}.json`);
  const future = new Date(Date.now() + 60_000).toISOString();
  await atomicWriteJson(path, { ...job, createdAt: future, updatedAt: future });
  const running = await store.transitionJob(workspace, job.id, ['queued'], 'running', {
    startedAt: future,
  });
  assert.ok(Date.parse(running.updatedAt) >= Date.parse(future));

  await assert.rejects(
    store.transitionJob(workspace, job.id, ['running'], 'succeeded', {
      finishedAt: new Date(Date.parse(future) - 1).toISOString(),
    }),
    (error) => error instanceof PluginError && error.code === 'JOB_PATCH_INVALID',
  );

  const failedJob = await store.reserveJob({
    workspace, ...jobInput, readOnly: true, ownerTurnId: 'turn-failed',
  });
  await assert.rejects(
    store.transitionJob(workspace, failedJob.id, ['queued'], 'failed', {
      finishedAt: new Date(Date.parse(failedJob.createdAt) - 1).toISOString(),
    }),
    (error) => error instanceof PluginError && error.code === 'JOB_PATCH_INVALID',
  );
});

test('tracked job fields persist through their legal lifecycle phases', async () => {
  const { dataRoot, workspace } = await fixture();
  const store = createStateStore({ dataRoot });
  const succeededJob = await store.reserveJob({ workspace, ...jobInput });
  const startedAt = new Date(Date.parse(succeededJob.createdAt) + 1_000).toISOString();
  const finishedAt = new Date(Date.parse(succeededJob.createdAt) + 2_000).toISOString();
  const running = await store.transitionJob(workspace, succeededJob.id, ['queued'], 'running', {
    childPid: 123,
    effort: 'xhigh',
    model: { providerId: 'zai', modelId: 'glm-4.5', variant: 'thinking' },
    promptArtifact: 'artifacts/prompt.json',
    startedAt,
    zcodeSessionId: 'zcode-session-a',
  });
  assert.equal(running.startedAt, startedAt);
  assert.deepEqual(running.model, {
    providerId: 'zai', modelId: 'glm-4.5', variant: 'thinking',
  });

  const refreshed = await store.transitionJob(workspace, succeededJob.id, ['running'], 'running', {
    model: 'configured-alias',
    zcodeSessionId: 'zcode-session-b',
  });
  assert.equal(refreshed.model, 'configured-alias');
  assert.equal(refreshed.zcodeSessionId, 'zcode-session-b');

  const succeeded = await store.transitionJob(workspace, succeededJob.id, ['running'], 'succeeded', {
    exitCode: 0,
    finishedAt,
    resultArtifact: 'artifacts/result.json',
  });
  assert.equal(succeeded.finishedAt, finishedAt);
  assert.equal(succeeded.resultArtifact, 'artifacts/result.json');
  assert.deepEqual(await store.readJob(workspace, succeededJob.id), succeeded);

  const failedJob = await store.reserveJob({ workspace, ...jobInput });
  await store.transitionJob(workspace, failedJob.id, ['queued'], 'running');
  const failed = await store.transitionJob(workspace, failedJob.id, ['running'], 'failed', {
    error: { code: 'BROKER_FAILED', message: 'broker stopped' },
    exitCode: 1,
    finishedAt,
  });
  assert.deepEqual(failed.error, { code: 'BROKER_FAILED', message: 'broker stopped' });
  assert.deepEqual(await store.readJob(workspace, failedJob.id), failed);

  const cancelledJob = await store.reserveJob({ workspace, ...jobInput });
  await store.transitionJob(workspace, cancelledJob.id, ['queued'], 'running');
  await store.transitionJob(workspace, cancelledJob.id, ['running'], 'cancelling');
  const cancelled = await store.transitionJob(workspace, cancelledJob.id, ['cancelling'], 'cancelled', {
    error: 'cancelled by caller',
    exitCode: null,
    finishedAt,
  });
  assert.equal(cancelled.error, 'cancelled by caller');
  assert.deepEqual(await store.readJob(workspace, cancelledJob.id), cancelled);
});

test('running and cancelling jobs persist bounded monotonic progress', async () => {
  const { dataRoot, workspace } = await fixture();
  const store = createStateStore({ dataRoot });
  const queued = await store.reserveJob({ workspace, ...jobInput });
  const startedAt = queued.createdAt;
  let job = await store.transitionJob(workspace, queued.id, ['queued'], 'running', { startedAt });
  const identity = {
    id: job.id,
    workspace: job.workspace,
    ownerSessionId: job.ownerSessionId,
    ownerTurnId: job.ownerTurnId,
    command: job.command,
    readOnly: job.readOnly,
    permissionSnapshot: job.permissionSnapshot,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
  };

  for (let index = 1; index <= 5; index += 1) {
    const observedAt = startedAt;
    const previousUpdatedAt = job.updatedAt;
    job = await store.updateJobProgress(workspace, job.id, {
      phase: index === 5 ? 'waiting' : 'running',
      message: index === 5 ? 'Command completed: npm test (25ms).' : `Progress ${index}`,
      observedAt,
    });
    assert.ok(Date.parse(job.updatedAt) >= Date.parse(previousUpdatedAt));
    assert.ok(Date.parse(job.updatedAt) >= Date.parse(observedAt));
  }

  assert.equal(job.phase, 'waiting');
  assert.equal(job.lastActivityAt, startedAt);
  assert.deepEqual(job.progressPreview, ['Progress 2', 'Progress 3', 'Progress 4', 'Command completed: npm test (25ms).']);
  assert.deepEqual({
    id: job.id,
    workspace: job.workspace,
    ownerSessionId: job.ownerSessionId,
    ownerTurnId: job.ownerTurnId,
    command: job.command,
    readOnly: job.readOnly,
    permissionSnapshot: job.permissionSnapshot,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
  }, identity);

  const duplicate = await store.updateJobProgress(workspace, job.id, {
    phase: 'running',
    message: 'Command completed: npm test (25ms).',
    observedAt: startedAt,
  });
  assert.equal(duplicate.phase, 'running');
  assert.deepEqual(duplicate.progressPreview, job.progressPreview);

  const cancelling = await store.transitionJob(workspace, job.id, ['running'], 'cancelling');
  const cancellingProgress = await store.updateJobProgress(workspace, job.id, {
    phase: 'finalizing',
    message: 'Stopping ZCode.',
    observedAt: startedAt,
  });
  assert.equal(cancellingProgress.status, 'cancelling');
  assert.equal(cancellingProgress.phase, 'finalizing');
  assert.ok(Date.parse(cancellingProgress.updatedAt) >= Date.parse(cancelling.updatedAt));
});

test('progress is a no-op once queued or terminal lifecycle state wins', async () => {
  const { dataRoot, workspace } = await fixture();
  const store = createStateStore({ dataRoot });
  const queued = await store.reserveJob({ workspace, ...jobInput });
  const event = {
    phase: 'starting',
    message: 'ZCode started the delegated turn.',
    observedAt: queued.updatedAt,
  };
  assert.deepEqual(await store.updateJobProgress(workspace, queued.id, event), queued);

  const running = await store.transitionJob(workspace, queued.id, ['queued'], 'running');
  const succeeded = await store.transitionJob(workspace, running.id, ['running'], 'succeeded', {
    finishedAt: running.updatedAt,
  });
  assert.deepEqual(await store.updateJobProgress(workspace, succeeded.id, event), succeeded);
  assert.deepEqual(await store.readJob(workspace, succeeded.id), succeeded);
});

test('future progress is rejected without poisoning a subsequent current update', async () => {
  const { dataRoot, workspace } = await fixture();
  const store = createStateStore({ dataRoot });
  const queued = await store.reserveJob({ workspace, ...jobInput });
  const running = await store.transitionJob(workspace, queued.id, ['queued'], 'running', {
    startedAt: queued.createdAt,
  });
  const future = new Date(Date.now() + 60_000).toISOString();
  await assert.rejects(
    store.updateJobProgress(workspace, running.id, {
      phase: 'running', message: 'Future activity.', observedAt: future,
    }),
    (error) => error instanceof PluginError && error.code === 'JOB_PROGRESS_INPUT_INVALID',
  );
  assert.deepEqual(await store.readJob(workspace, running.id), running);

  const observedAt = new Date().toISOString();
  const progressed = await store.updateJobProgress(workspace, running.id, {
    phase: 'running', message: 'Current activity.', observedAt,
  });
  assert.equal(progressed.lastActivityAt, observedAt);
  assert.deepEqual(progressed.progressPreview, ['Current activity.']);
});

test('progress winning the lock prevents an earlier completion but permits a later one', async () => {
  const { dataRoot, workspace } = await fixture();
  const store = createStateStore({ dataRoot });
  const queued = await store.reserveJob({ workspace, ...jobInput });
  const running = await store.transitionJob(workspace, queued.id, ['queued'], 'running');
  const storage = await resolveWorkspaceStorage({ dataRoot, workspace });
  const path = join(storage.directory, 'jobs', `${running.id}.json`);
  const startedAt = '2020-01-01T00:00:00.000Z';
  const historical = {
    ...running,
    createdAt: startedAt,
    startedAt,
    updatedAt: '2020-01-01T00:00:01.000Z',
  };
  await atomicWriteJson(path, historical);
  const progressed = await store.updateJobProgress(workspace, running.id, {
    phase: 'finalizing',
    message: 'ZCode completed the delegated turn.',
    observedAt: '2020-01-01T00:00:02.000Z',
  });

  await atomicWriteJson(path, {
    ...progressed,
    status: 'succeeded',
    finishedAt: '2020-01-01T00:00:01.000Z',
  });
  await assert.rejects(store.readJob(workspace, running.id), { code: 'JOB_RECORD_INVALID' });
  await atomicWriteJson(path, progressed);

  await assert.rejects(
    store.transitionJob(workspace, running.id, ['running'], 'succeeded', {
      finishedAt: '2020-01-01T00:00:01.000Z',
    }),
    { code: 'JOB_PATCH_INVALID' },
  );
  const succeeded = await store.finishJob(workspace, running.id, ['running'], 'succeeded', {});
  assert.equal(succeeded.status, 'succeeded');
  assert.equal(succeeded.lastActivityAt, progressed.lastActivityAt);
  assert.ok(Date.parse(succeeded.finishedAt) >= Date.parse(progressed.lastActivityAt));
});

test('progress rejects malformed, unsafe, and out-of-timeline events', async () => {
  const { dataRoot, workspace } = await fixture();
  const store = createStateStore({ dataRoot });
  const queued = await store.reserveJob({ workspace, ...jobInput });
  const startedAt = queued.createdAt;
  const running = await store.transitionJob(workspace, queued.id, ['queued'], 'running', { startedAt });
  const observedAt = startedAt;
  const valid = { phase: 'running', message: 'Safe progress.', observedAt };
  const invalidEvents = /** @type {any[]} */ ([
    null,
    [],
    { ...valid, phase: 'unknown' },
    { ...valid, observedAt: 'tomorrow' },
    { ...valid, observedAt: new Date(Date.parse(startedAt) - 1).toISOString() },
    { ...valid, message: 'x'.repeat(257) },
    { ...valid, message: `${'é'.repeat(127)}abc` },
    { ...valid, message: 'line one\nline two' },
    { ...valid, message: '\u001b[31mspoof' },
    { ...valid, message: 'safe\u202Etxt' },
    { ...valid, extra: true },
  ]);

  for (const event of invalidEvents) {
    await assert.rejects(
      store.updateJobProgress(workspace, running.id, event),
      (error) => error instanceof PluginError && error.code === 'JOB_PROGRESS_INPUT_INVALID',
    );
  }
  assert.deepEqual(await store.readJob(workspace, running.id), running);
});

test('accepted send boundaries persist for durable worker recovery', async () => {
  const { dataRoot, workspace } = await fixture(); const store = createStateStore({ dataRoot });
  const queued = await store.reserveJob({ workspace, ...jobInput });
  await store.transitionJob(workspace, queued.id, ['queued'], 'running', { childPid: 123, startedAt: new Date().toISOString(), zcodeSessionId: 'zcode-recovery-session' });
  const boundary = await store.transitionJob(workspace, queued.id, ['running'], 'running', {
    inputId: 'input-recovery-1', startRevision: 41, beforeMessageIds: ['message-before-a', 'message-before-b'],
  });
  assert.equal(boundary.inputId, 'input-recovery-1'); assert.equal(boundary.startRevision, 41);
  assert.deepEqual(boundary.beforeMessageIds, ['message-before-a', 'message-before-b']);
  assert.deepEqual(await store.readJob(workspace, queued.id), boundary);
});

test('recovery boundaries reject partial, duplicate, oversized, and rewritten values', async () => {
  const { dataRoot, workspace } = await fixture(); const store = createStateStore({ dataRoot });
  const queued = await store.reserveJob({ workspace, ...jobInput });
  await store.transitionJob(workspace, queued.id, ['queued'], 'running', { startedAt: new Date().toISOString(), zcodeSessionId: 'zcode-recovery-session' });
  for (const patch of [
    { inputId: 'input-only' },
    { inputId: 'input-duplicate', startRevision: 1, beforeMessageIds: ['same-message', 'same-message'] },
    { inputId: 'input-oversized', startRevision: 1, beforeMessageIds: Array.from({ length: 600 }, (_, index) => `${index}-${'x'.repeat(500)}`) },
  ]) await assert.rejects(store.transitionJob(workspace, queued.id, ['running'], 'running', patch), { code: 'JOB_PATCH_INVALID' });
  await store.transitionJob(workspace, queued.id, ['running'], 'running', { inputId: 'input-stable', startRevision: 7, beforeMessageIds: ['before-stable'] });
  await assert.rejects(store.transitionJob(workspace, queued.id, ['running'], 'running', { inputId: 'input-rewritten', startRevision: 8, beforeMessageIds: ['before-rewritten'] }), { code: 'JOB_PATCH_INVALID' });
});

test('tracked job fields reject unsafe values and invalid lifecycle phases', async () => {
  const { dataRoot, workspace } = await fixture();
  const store = createStateStore({ dataRoot });
  const job = await store.reserveJob({ workspace, ...jobInput });
  for (const patch of /** @type {Array<Record<string, unknown>>} */ ([
    { zcodeSessionId: '' },
    { zcodeSessionId: 'line-one\nline-two' },
    { zcodeSessionId: '\u001b[31mspoof' },
    { zcodeSessionId: 'x'.repeat(513) },
    { model: {} },
    { effort: 'ultra' },
    { startedAt: 'tomorrow' },
    { promptArtifact: '../outside.json' },
    { promptArtifact: { path: 'prompt.json' } },
  ])) {
    await assert.rejects(
      store.transitionJob(workspace, job.id, ['queued'], 'running', patch),
      (error) => error instanceof PluginError && error.code === 'JOB_PATCH_INVALID',
    );
  }

  await store.transitionJob(workspace, job.id, ['queued'], 'running');
  for (const patch of /** @type {Array<Record<string, unknown>>} */ ([
    { childPid: 456 },
    { effort: 'high' },
    { model: 'configured-alias' },
    { promptArtifact: 'artifacts/prompt.json' },
    { zcodeSessionId: 'zcode-session-a' },
  ])) {
    await assert.rejects(
      store.transitionJob(workspace, job.id, ['running'], 'failed', patch),
      (error) => error instanceof PluginError && error.code === 'JOB_PATCH_INVALID',
    );
  }
  for (const patch of /** @type {Array<Record<string, unknown>>} */ ([
    { startedAt: '2026-08-04T01:02:03.000Z' },
    { finishedAt: '2026-08-04T01:03:04.000Z' },
    { resultArtifact: 'result.json' },
    { error: 'too early' },
  ])) {
    await assert.rejects(
      store.transitionJob(workspace, job.id, ['running'], 'running', patch),
      (error) => error instanceof PluginError && error.code === 'JOB_PATCH_INVALID',
    );
  }
  await assert.rejects(
    store.transitionJob(workspace, job.id, ['running'], 'succeeded', {
      error: 'wrong terminal phase', resultArtifact: '/absolute/result.json',
    }),
    (error) => error instanceof PluginError && error.code === 'JOB_PATCH_INVALID',
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
    (error) => error instanceof PluginError && error.code === 'JOB_TRANSITION_INPUT_INVALID',
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
  assert.equal(rejection.reason.remedy, 'Retry later or inspect the redacted workspace list with $zcode:status --all.');
  assert.doesNotMatch(rejection.reason.remedy, /read-only/i);

  const readOnlyJobs = await Promise.all([
    store.reserveJob({ workspace, ...jobInput, ownerTurnId: 'read-a', readOnly: true }),
    store.reserveJob({ workspace, ...jobInput, ownerTurnId: 'read-b', readOnly: true }),
  ]);
  assert.equal(readOnlyJobs.length, 2);
});

test('writable exclusion remedy does not advertise a read-only rescue mode', async () => {
  const { dataRoot, workspace } = await fixture(); const store = createStateStore({ dataRoot });
  await store.reserveJob({ workspace, ...jobInput });
  await assert.rejects(
    store.reserveJob({ workspace, ...jobInput, ownerTurnId: 'blocked-turn' }),
    (error) => error instanceof PluginError && error.code === 'WRITABLE_JOB_EXISTS'
      && error.remedy === 'Retry later or inspect the redacted workspace list with $zcode:status --all.'
      && !/read-only/i.test(error.remedy),
  );
});

test('workspace storage hashes the real path and creates private directories', async () => {
  const { dataRoot, workspace } = await fixture();
  const first = await resolveWorkspaceStorage({ dataRoot, workspace });
  const second = await resolveWorkspaceStorage({ dataRoot, workspace: `${workspace}/.` });

  assert.equal(first.workspaceKey, second.workspaceKey);
  assert.match(first.workspaceKey, /^[a-f0-9]{64}$/);
  assert.equal(first.directory, join(dataRoot, 'workspaces', first.workspaceKey));
  const workspaceDirectory = await stat(first.directory); if (process.platform === 'win32') assert.equal(workspaceDirectory.isDirectory(), true); else assert.equal(workspaceDirectory.mode & 0o777, 0o700);
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
  const recordFile = await stat(path); if (process.platform === 'win32') assert.equal(recordFile.isFile(), true); else assert.equal(recordFile.mode & 0o777, 0o600);
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

test('concurrent first use publishes one valid advisory lock layout', async () => {
  const { root } = await fixture(); const lockPath = join(root, 'concurrent-layout.lock'); let inside = 0; let maximumInside = 0;
  try {
    await Promise.all(Array.from({ length: 16 }, () => withFileLock(lockPath, async () => { inside += 1; maximumInside = Math.max(maximumInside, inside); await new Promise((resolvePromise) => setImmediate(resolvePromise)); inside -= 1; })));
    assert.equal(maximumInside, 1);
    assert.deepEqual(await readdir(lockPath), ['advisory.lock']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('only a Windows rename EPERM is classified as a lock publish collision', () => {
  const denied = Object.assign(new Error('denied'), { code: 'EPERM' });
  assert.equal(isLockPublishCollision(denied, 'win32'), true);
  assert.equal(isLockPublishCollision(denied, 'linux'), false);
  assert.equal(isLockPublishCollision(Object.assign(new Error('I/O failure'), { code: 'EIO' }), 'win32'), false);
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

test('an old child holder never removes a replacement lock during release', { skip: process.platform === 'win32' ? 'Windows cannot remove an open lock directory while simulating the Unix inode ABA race.' : false }, async () => {
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
