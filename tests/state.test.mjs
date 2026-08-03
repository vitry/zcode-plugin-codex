import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { PluginError } from '../scripts/lib/errors.mjs';
import { atomicWriteJson, readJsonFile } from '../scripts/lib/fs.mjs';
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
  command: ['zcode', 'rescue'],
  readOnly: false,
  permissionSnapshot: { mode: 'workspace-write' },
};

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
