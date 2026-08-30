// @ts-nocheck
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createStateStore } from '../scripts/lib/state.mjs';
import { rescueBindingPartitionKey } from '../scripts/lib/rescue-binding.mjs';
import { resolveWorkspaceStorage } from '../scripts/lib/workspace.mjs';
import { runProcess } from '../scripts/lib/process.mjs';

const repairTool = new URL('../tools/repair-rescue-continuation-binding.mjs', import.meta.url).pathname;

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

test('historical repair dry-run validates the exact incident without writing', async () => {
  const fixture = await incidentFixture();
  const beforeBinding = await readFile(fixture.partitionPath, 'utf8');
  const beforeJob = await readFile(fixture.currentPath, 'utf8');

  assert.deepEqual(await fixture.store.repairRescueContinuationBinding(fixture.input), { status: 'repairable' });
  assert.equal(await readFile(fixture.partitionPath, 'utf8'), beforeBinding);
  assert.equal(await readFile(fixture.currentPath, 'utf8'), beforeJob);
});

test('historical repair apply changes only currentJobId and monotonically advances updatedAt', async () => {
  const fixture = await incidentFixture();
  const before = await partitionRecord(fixture);
  const beforeJob = await readFile(fixture.currentPath, 'utf8');

  assert.deepEqual(await fixture.store.repairRescueContinuationBinding({ ...fixture.input, apply: true }),
    { status: 'repaired' });
  const after = await partitionRecord(fixture);
  assert.equal(after.currentJobId, fixture.input.anchorJobId);
  assert.ok(Date.parse(after.updatedAt) > Date.parse(before.updatedAt));
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
