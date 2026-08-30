// @ts-nocheck
import assert from 'node:assert/strict';
import { access, lstat, mkdtemp, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createStateStore } from '../scripts/lib/state.mjs';
import { rescueBindingPartitionKey } from '../scripts/lib/rescue-binding.mjs';
import { resolveWorkspaceStorage } from '../scripts/lib/workspace.mjs';
import { runProcess } from '../scripts/lib/process.mjs';

const repairTool = fileURLToPath(new URL('../tools/repair-rescue-continuation-binding.mjs', import.meta.url));

function reservation(workspace, turn = 'turn-a') {
  return { workspace, ownerSessionId: 'parent-session', ownerTurnId: turn, command: 'rescue', readOnly: false,
    permissionSnapshot: { permissionMode: 'workspace-write' } };
}

function executor(workspace) {
  return { parentSessionId: 'parent-session', parentTurnId: 'origin-turn', agentId: 'rescue-child',
    agentType: 'zcode-rescue', agentPath: '/root/zcode_rescue_task', workspace,
    parentPermissionMode: 'workspace-write' };
}

async function incidentFixture() {
  const root = await mkdtemp(join(tmpdir(), 'zcode-binding-repair-'));
  const dataRoot = join(root, 'data'); const workspaceDirectory = join(root, 'workspace');
  await mkdir(workspaceDirectory); const workspace = await realpath(workspaceDirectory);
  const store = createStateStore({ dataRoot }); const hook = executor(workspace);
  const first = await store.reserveFreshRescueJob({ workspace, reservation: reservation(workspace), executor: hook });
  const claimed = await store.claimJobWorkerForExecution(workspace, first.job.id,
    { childPid: 999_999_999, workerLeaseId: first.job.id });
  await store.transitionJob(workspace, first.job.id, ['queued'], 'running', {
    startedAt: new Date().toISOString(), zcodeSessionId: 'historical-session',
    childPid: claimed.childPid, workerLeaseId: claimed.workerLeaseId,
  });
  await store.finishJob(workspace, first.job.id, ['running'], 'succeeded');
  const continuation = await store.reserveBoundRescueContinuation({ workspace,
    reservation: reservation(workspace, 'turn-b'), executor: hook, operationId: first.binding.operationId });

  const storage = await resolveWorkspaceStorage({ dataRoot, workspace });
  const currentPath = join(storage.directory, 'jobs', `${continuation.job.id}.json`);
  const failed = JSON.parse(await readFile(currentPath, 'utf8'));
  const finishedAt = new Date(Math.max(Date.now(), Date.parse(failed.updatedAt))).toISOString();
  failed.status = 'failed'; failed.finishedAt = finishedAt; failed.updatedAt = finishedAt;
  failed.error = { code: 'MODEL_UNAVAILABLE', message: 'redacted historical failure' };
  delete failed.rescueContinuationOrigin;
  await writeFile(currentPath, `${JSON.stringify(failed, null, 2)}\n`);

  const partitionPath = join(storage.directory, `rescue-binding-session-${rescueBindingPartitionKey({
    parentSessionId: first.binding.parentSessionId, workspace,
  })}.json`);
  const input = {
    workspace,
    parentSessionId: first.binding.parentSessionId,
    childAgentId: hook.agentId,
    childAgentPath: hook.agentPath,
    bindingKey: continuation.binding.key,
    operationId: continuation.binding.operationId,
    anchorJobId: first.job.id,
    failedCurrentJobId: continuation.job.id,
    expectedBindingUpdatedAt: continuation.binding.updatedAt,
  };
  return { root, dataRoot, workspace, store, first, continuation, storage, currentPath, partitionPath, input };
}

async function partitionRecord(fixture) {
  return JSON.parse(await readFile(fixture.partitionPath, 'utf8')).records[0];
}

async function treeSnapshot(path, root = path, result = {}) {
  const stats = await lstat(path, { bigint: true }); const relative = path.slice(root.length) || '.';
  result[relative] = { ctimeNs: stats.ctimeNs.toString(), mode: Number(stats.mode & 0o777n),
    mtimeNs: stats.mtimeNs.toString(), size: stats.size.toString(),
    ...(stats.isFile() ? { bytes: (await readFile(path)).toString('base64') } : {}) };
  if (stats.isDirectory()) for (const entry of (await readdir(path)).sort()) await treeSnapshot(join(path, entry), root, result);
  return result;
}

async function ownerEvidencePath(storage, jobId) {
  const root = join(storage.directory, 'job-owners');
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = join(root, entry.name, `${jobId}.json`);
    try { await access(candidate); return candidate; } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  }
  assert.fail(`owner evidence missing for ${jobId}`);
}

test('historical repair dry-run validates the exact incident without writing', async () => {
  const fixture = await incidentFixture();
  const beforeTree = await treeSnapshot(fixture.dataRoot);

  assert.deepEqual(await fixture.store.repairRescueContinuationBinding(fixture.input), { status: 'repairable' });
  assert.deepEqual(await treeSnapshot(fixture.dataRoot), beforeTree);
});

test('historical repair never creates a missing data root or incident layout', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zcode-binding-repair-absent-'));
  const workspaceDirectory = join(root, 'workspace'); const dataRoot = join(root, 'missing-data');
  await mkdir(workspaceDirectory); const workspace = await realpath(workspaceDirectory);
  const input = { workspace, parentSessionId: 'parent-session', childAgentId: 'rescue-child',
    childAgentPath: '/root/zcode_rescue_task', bindingKey: 'a'.repeat(64), operationId: 'b'.repeat(64),
    anchorJobId: 'c'.repeat(64), failedCurrentJobId: 'd'.repeat(64),
    expectedBindingUpdatedAt: '2026-08-29T00:00:00.000Z' };
  const store = createStateStore({ dataRoot });
  await assert.rejects(store.repairRescueContinuationBinding(input), { code: 'RESCUE_BINDING_REPAIR_INVALID' });
  await assert.rejects(access(dataRoot), { code: 'ENOENT' });
  await assert.rejects(store.repairRescueContinuationBinding({ ...input, apply: true }),
    { code: 'RESCUE_BINDING_REPAIR_INVALID' });
  await assert.rejects(access(dataRoot), { code: 'ENOENT' });
});

test('historical repair apply changes only currentJobId and monotonically advances updatedAt', async () => {
  const fixture = await incidentFixture();
  const before = await partitionRecord(fixture);
  const beforeJob = await readFile(fixture.currentPath, 'utf8');

  assert.deepEqual(await fixture.store.repairRescueContinuationBinding({ ...fixture.input, apply: true }),
    { status: 'repaired' });
  const after = await partitionRecord(fixture);
  assert.equal(after.currentJobId, fixture.input.anchorJobId);
  assert.equal(Date.parse(after.updatedAt), Date.parse(before.updatedAt) + 1);
  assert.deepEqual({ ...after, currentJobId: before.currentJobId, updatedAt: before.updatedAt }, before);
  assert.equal(await readFile(fixture.currentPath, 'utf8'), beforeJob);
});

test('historical repair recognizes only the exact already-restored generation', async () => {
  const fixture = await incidentFixture();
  await fixture.store.repairRescueContinuationBinding({ ...fixture.input, apply: true });
  assert.deepEqual(await fixture.store.repairRescueContinuationBinding({ ...fixture.input, apply: true }),
    { status: 'already-repaired' });
  assert.deepEqual(await fixture.store.repairRescueContinuationBinding(fixture.input),
    { status: 'already-repaired' });

  const partition = JSON.parse(await readFile(fixture.partitionPath, 'utf8'));
  partition.records[0].operationId = 'f'.repeat(64);
  await writeFile(fixture.partitionPath, `${JSON.stringify(partition, null, 2)}\n`);
  await assert.rejects(fixture.store.repairRescueContinuationBinding({ ...fixture.input, apply: true }),
    { code: 'RESCUE_BINDING_REPAIR_INVALID' });
});

test('historical repair rejects every non-repair timestamp that happens to point back to the anchor', async () => {
  for (const delta of [-1, 0, 2]) {
    const fixture = await incidentFixture();
    await fixture.store.repairRescueContinuationBinding({ ...fixture.input, apply: true });
    const partition = JSON.parse(await readFile(fixture.partitionPath, 'utf8'));
    partition.records[0].updatedAt = new Date(Date.parse(fixture.input.expectedBindingUpdatedAt) + delta).toISOString();
    await writeFile(fixture.partitionPath, `${JSON.stringify(partition, null, 2)}\n`);

    await assert.rejects(fixture.store.repairRescueContinuationBinding({ ...fixture.input, apply: true }),
      { code: 'RESCUE_BINDING_REPAIR_INVALID' });
  }
});

test('historical repair rejects every caller identity or CAS mutation without writes', async () => {
  for (const patch of [
    { parentSessionId: 'other-parent' }, { childAgentId: 'other-child' },
    { childAgentPath: '/root/zcode_rescue_other' }, { bindingKey: 'a'.repeat(64) },
    { operationId: 'b'.repeat(64) }, { anchorJobId: 'c'.repeat(64) },
    { failedCurrentJobId: 'd'.repeat(64) },
    { expectedBindingUpdatedAt: '2026-01-01T00:00:00.000Z' },
  ]) {
    const fixture = await incidentFixture(); const before = await readFile(fixture.partitionPath, 'utf8');
    await assert.rejects(fixture.store.repairRescueContinuationBinding({ ...fixture.input, ...patch, apply: true }),
      { code: 'RESCUE_BINDING_REPAIR_INVALID' });
    assert.equal(await readFile(fixture.partitionPath, 'utf8'), before);
  }
});

test('historical repair rejects running evidence and any active writable Rescue job', async () => {
  for (const field of ['startedAt', 'zcodeSessionId', 'model', 'effort', 'promptArtifact', 'inputId',
    'startRevision', 'beforeMessageIds', 'resultArtifact']) {
    const fixture = await incidentFixture(); const job = JSON.parse(await readFile(fixture.currentPath, 'utf8'));
    if (field === 'startedAt') job[field] = job.createdAt;
    else if (field === 'zcodeSessionId') job[field] = 'accepted-session';
    else if (field === 'model') job[field] = 'gpt-5';
    else if (field === 'effort') job[field] = 'high';
    else if (field === 'promptArtifact' || field === 'resultArtifact') job[field] = { path: '/tmp/artifact', sha256: 'a'.repeat(64) };
    else if (field === 'inputId') job[field] = 'input';
    else if (field === 'startRevision') job[field] = 0;
    else job[field] = [];
    await writeFile(fixture.currentPath, `${JSON.stringify(job, null, 2)}\n`);
    await assert.rejects(fixture.store.repairRescueContinuationBinding({ ...fixture.input, apply: true }),
      { code: 'RESCUE_BINDING_REPAIR_INVALID' });
  }

  const fixture = await incidentFixture();
  await fixture.store.reserveJob(reservation(fixture.workspace, 'unrelated-active'));
  await assert.rejects(fixture.store.repairRescueContinuationBinding({ ...fixture.input, apply: true }),
    { code: 'RESCUE_BINDING_REPAIR_INVALID' });
});

test('historical repair rejects every active writable command but permits read-only jobs', async () => {
  for (const status of ['queued', 'running', 'cancelling']) {
    const fixture = await incidentFixture();
    let blocker = await fixture.store.reserveJob({ ...reservation(fixture.workspace, `blocker-${status}`),
      command: 'review' });
    if (status !== 'queued') blocker = await fixture.store.transitionJob(fixture.workspace, blocker.id, ['queued'], 'running');
    if (status === 'cancelling') await fixture.store.transitionJob(fixture.workspace, blocker.id, ['running'], 'cancelling');
    await assert.rejects(fixture.store.repairRescueContinuationBinding(fixture.input),
      { code: 'RESCUE_BINDING_REPAIR_INVALID' });
  }
  const fixture = await incidentFixture();
  await fixture.store.reserveJob({ ...reservation(fixture.workspace, 'read-only'), command: 'review', readOnly: true });
  assert.deepEqual(await fixture.store.repairRescueContinuationBinding(fixture.input), { status: 'repairable' });
});

test('historical repair validates only owner evidence relevant to the repair decision', async () => {
  const fixture = await incidentFixture();
  const unrelated = await fixture.store.reserveJob({ ...reservation(fixture.workspace, 'unrelated-read-only'),
    command: 'review', readOnly: true });
  await writeFile(await ownerEvidencePath(fixture.storage, unrelated.id), '{}\n');
  assert.deepEqual(await fixture.store.repairRescueContinuationBinding(fixture.input), { status: 'repairable' });

  await writeFile(await ownerEvidencePath(fixture.storage, fixture.first.job.id), '{}\n');
  await assert.rejects(fixture.store.repairRescueContinuationBinding(fixture.input),
    { code: 'RESCUE_BINDING_REPAIR_INVALID' });
});

test('historical repair rejects unsafe anchor, binding authority, and owner index state', async () => {
  {
    const fixture = await incidentFixture(); const anchorPath = join(fixture.storage.directory, 'jobs', `${fixture.first.job.id}.json`);
    const anchor = JSON.parse(await readFile(anchorPath, 'utf8')); delete anchor.zcodeSessionId;
    await writeFile(anchorPath, `${JSON.stringify(anchor, null, 2)}\n`);
    await assert.rejects(fixture.store.repairRescueContinuationBinding(fixture.input),
      { code: 'RESCUE_BINDING_REPAIR_INVALID' });
  }
  {
    const fixture = await incidentFixture(); const partition = JSON.parse(await readFile(fixture.partitionPath, 'utf8'));
    partition.records[0].childAuthority.agentPath = '/root/zcode_rescue_other';
    await writeFile(fixture.partitionPath, `${JSON.stringify(partition, null, 2)}\n`);
    await assert.rejects(fixture.store.repairRescueContinuationBinding(fixture.input),
      { code: 'RESCUE_BINDING_REPAIR_INVALID' });
  }
  {
    const fixture = await incidentFixture();
    await writeFile(join(fixture.storage.directory, 'job-owners', 'index.json'), '{}\n');
    await assert.rejects(fixture.store.repairRescueContinuationBinding(fixture.input),
      { code: 'RESCUE_BINDING_REPAIR_INVALID' });
  }
});

test('historical repair rejects malformed and partial API requests', async () => {
  const fixture = await incidentFixture();
  for (const input of [null, {}, { ...fixture.input, unknown: true },
    { ...fixture.input, apply: 'yes' }, { ...fixture.input, childAgentPath: 'relative' }]) {
    await assert.rejects(fixture.store.repairRescueContinuationBinding(input),
      { code: 'RESCUE_BINDING_REPAIR_INVALID' });
  }
  await assert.rejects(fixture.store.repairRescueContinuationBinding({ ...fixture.input,
    expectedBindingUpdatedAt: '+275760-09-13T00:00:00.000Z' }),
  { code: 'RESCUE_BINDING_REPAIR_INVALID' });
});

function cliArgs(fixture) {
  return [repairTool, '--data-root', fixture.dataRoot, '--workspace', fixture.input.workspace,
    '--parent-session-id', fixture.input.parentSessionId, '--child-agent-id', fixture.input.childAgentId,
    '--child-agent-path', fixture.input.childAgentPath, '--binding-key', fixture.input.bindingKey,
    '--operation-id', fixture.input.operationId, '--anchor-job-id', fixture.input.anchorJobId,
    '--failed-current-job-id', fixture.input.failedCurrentJobId,
    '--expected-binding-updated-at', fixture.input.expectedBindingUpdatedAt];
}

test('repository repair CLI is dry-run by default and applies only with --apply', async () => {
  const fixture = await incidentFixture();
  const dry = await runProcess({ command: process.execPath, args: cliArgs(fixture), options: { shell: false } },
    { cwd: fixture.workspace, timeoutMs: 30_000 });
  assert.equal(dry.code, 0, dry.stderr); assert.deepEqual(JSON.parse(dry.stdout), { status: 'repairable' });
  assert.equal((await partitionRecord(fixture)).currentJobId, fixture.input.failedCurrentJobId);

  const apply = await runProcess({ command: process.execPath, args: [...cliArgs(fixture), '--apply'], options: { shell: false } },
    { cwd: fixture.workspace, timeoutMs: 30_000 });
  assert.equal(apply.code, 0, apply.stderr); assert.deepEqual(JSON.parse(apply.stdout), { status: 'repaired' });
  assert.equal((await partitionRecord(fixture)).currentJobId, fixture.input.anchorJobId);
  const repeated = await runProcess({ command: process.execPath, args: [...cliArgs(fixture), '--apply'], options: { shell: false } },
    { cwd: fixture.workspace, timeoutMs: 30_000 });
  assert.equal(repeated.code, 0, repeated.stderr);
  assert.deepEqual(JSON.parse(repeated.stdout), { status: 'already-repaired' });
});

test('repository repair CLI rejects missing, duplicate, unknown, and secret-bearing arguments safely', async () => {
  const fixture = await incidentFixture(); const base = cliArgs(fixture);
  for (const args of [base.slice(0, -2), [...base, '--apply', '--apply'], [...base, '--unknown', 'secret-task-text'],
    [...base.slice(0, -1), '--apply']]) {
    const result = await runProcess({ command: process.execPath, args, options: { shell: false } },
      { cwd: fixture.workspace, timeoutMs: 30_000 });
    assert.notEqual(result.code, 0);
    assert.deepEqual(JSON.parse(result.stderr), {
      code: 'RESCUE_BINDING_REPAIR_INVALID', message: 'The requested Rescue binding repair is not safe to apply.',
    });
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /secret-task-text/u);
  }
});
