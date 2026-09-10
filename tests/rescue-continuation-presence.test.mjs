import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createStateStore } from '../scripts/lib/state.mjs';
import { atomicWriteJson } from '../scripts/lib/fs.mjs';
import { closeRescueBinding, createRescueBinding, createRescueBindingAuthority, createRescueBindingPartition, rescueBindingPartitionKey } from '../scripts/lib/rescue-binding.mjs';
import { resolveWorkspaceStorage } from '../scripts/lib/workspace.mjs';

/** @param {import('node:test').TestContext} t */
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rescue-presence-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace'); const dataRoot = join(root, 'data');
  await mkdir(workspace); await mkdir(dataRoot, { mode: 0o700 });
  const store = createStateStore({ dataRoot });
  return { root, workspace, dataRoot, store, inspect: () => store.inspectRescueContinuationPresence({ workspace, parentSessionId: 'current-parent' }) };
}

/** @param {string} directory @returns {Promise<any>} */
async function snapshot(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return Object.fromEntries(await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name); const stats = await lstat(path);
    return [entry.name, { mtimeMs: stats.mtimeMs, mode: stats.mode, content: entry.isDirectory() ? await snapshot(path) : entry.isSymbolicLink() ? 'symlink' : await readFile(path, 'base64') }];
  })));
}

/** @param {any} ctx @param {string} [parentSessionId] @param {number} [count] */
async function bindingFiles(ctx, parentSessionId = 'current-parent', count = 1) {
  const storage = await resolveWorkspaceStorage(ctx);
  const key = rescueBindingPartitionKey({ workspace: ctx.workspace, parentSessionId });
  const authorityPath = join(storage.directory, `rescue-binding-authority-${key}.json`);
  const partitionPath = join(storage.directory, `rescue-binding-session-${key}.json`);
  const records = Array.from({ length: count }, (_, index) => createRescueBinding({
    workspace: ctx.workspace, parentSessionId, executorAgentId: `child-${index}`, executorAgentType: 'zcode-rescue',
    executorParentTurnId: 'turn', executorParentPermissionMode: 'workspace-write', executorAgentPath: `/root/rescue_${index}`,
    permissionMode: 'workspace-write', operationId: String(index + 1).repeat(64), anchorJobId: 'a'.repeat(64), currentJobId: 'a'.repeat(64),
  }));
  await atomicWriteJson(authorityPath, createRescueBindingAuthority({ workspace: ctx.workspace, parentSessionId }));
  await atomicWriteJson(partitionPath, createRescueBindingPartition({ workspace: ctx.workspace, parentSessionId, records }));
  return { authorityPath, partitionPath, storage };
}

test('continuation absence is read-only for a new parent and ignores other-parent history', async (t) => {
  const ctx = await fixture(t);
  const empty = await snapshot(ctx.dataRoot);
  assert.deepEqual(await ctx.inspect(), { state: 'none' });
  assert.deepEqual(await snapshot(ctx.dataRoot), empty);
  await ctx.store.reserveJob({ workspace: ctx.workspace, ownerSessionId: 'other-parent', ownerTurnId: 'turn', command: 'rescue', readOnly: false, permissionSnapshot: { permissionMode: 'workspace-write' } });
  await bindingFiles(ctx, 'other-parent');
  const before = await snapshot(ctx.dataRoot);
  assert.deepEqual(await ctx.inspect(), { state: 'none' });
  assert.deepEqual(await snapshot(ctx.dataRoot), before);
});

test('one or multiple current-parent bindings are presence, not resume eligibility', async (t) => {
  for (const count of [1, 2]) {
    const ctx = await fixture(t); await bindingFiles(ctx, 'current-parent', count);
    const before = await snapshot(ctx.dataRoot);
    assert.deepEqual(await ctx.inspect(), { state: 'present' });
    assert.deepEqual(await snapshot(ctx.dataRoot), before);
  }
});

test('a current-parent legacy Rescue job without binding is never absence', async (t) => {
  const ctx = await fixture(t);
  const job = await ctx.store.reserveJob({ workspace: ctx.workspace, ownerSessionId: 'current-parent', ownerTurnId: 'turn', command: 'rescue', readOnly: false, permissionSnapshot: { permissionMode: 'workspace-write' } });
  const storage = await resolveWorkspaceStorage(ctx);
  const path = join(storage.directory, 'jobs', `${job.id}.json`);
  const legacy = JSON.parse(await readFile(path, 'utf8')); delete legacy.rescueReservationKind;
  await atomicWriteJson(path, legacy);
  const ownerDirectory = createHash('sha256').update('zcode-owner-index-v1\0current-parent').digest('hex');
  await atomicWriteJson(join(storage.directory, 'job-owners', ownerDirectory, `${job.id}.json`), { version: 1, ownerSessionId: 'current-parent', jobId: job.id });
  const before = await snapshot(ctx.dataRoot);
  assert.deepEqual(await ctx.inspect(), { state: 'present' });
  assert.deepEqual(await snapshot(ctx.dataRoot), before);
});

test('partial, malformed and unsafe current-parent binding evidence is blocked without repair', async (t) => {
  for (const damage of ['authority-only', 'partition-only', 'malformed', 'symlink']) {
    const ctx = await fixture(t); const files = await bindingFiles(ctx);
    if (damage === 'authority-only') await unlink(files.partitionPath);
    if (damage === 'partition-only') await unlink(files.authorityPath);
    if (damage === 'malformed') await writeFile(files.partitionPath, '{');
    if (damage === 'symlink') { await unlink(files.partitionPath); await symlink(files.authorityPath, files.partitionPath); }
    const before = await snapshot(ctx.dataRoot);
    assert.deepEqual(await ctx.inspect(), { state: 'blocked' }, damage);
    assert.deepEqual(await snapshot(ctx.dataRoot), before);
  }
});

test('missing or inconsistent owner index cannot prove absence or trigger index repair', async (t) => {
  for (const damage of ['missing', 'malformed']) {
    const ctx = await fixture(t);
    await ctx.store.reserveJob({ workspace: ctx.workspace, ownerSessionId: 'current-parent', ownerTurnId: 'turn', command: 'rescue', readOnly: false, permissionSnapshot: { permissionMode: 'workspace-write' } });
    const storage = await resolveWorkspaceStorage(ctx); const marker = join(storage.directory, 'job-owners', 'index.json');
    if (damage === 'missing') await unlink(marker); else await writeFile(marker, '{}');
    const before = await snapshot(ctx.dataRoot);
    assert.deepEqual(await ctx.inspect(), { state: 'blocked' });
    assert.deepEqual(await snapshot(ctx.dataRoot), before);
  }
});

test('a digest-consistent owner index misattributing a current-parent job body is blocked, never absence', async (t) => {
  const ctx = await fixture(t);
  const job = await ctx.store.reserveJob({ workspace: ctx.workspace, ownerSessionId: 'current-parent', ownerTurnId: 'turn', command: 'rescue', readOnly: false, permissionSnapshot: { permissionMode: 'workspace-write' } });
  const storage = await resolveWorkspaceStorage(ctx);
  const owners = join(storage.directory, 'job-owners');
  const trueOwner = createHash('sha256').update('zcode-owner-index-v1\0current-parent').digest('hex');
  const falseOwner = createHash('sha256').update('zcode-owner-index-v1\0other-parent').digest('hex');
  // Relabel the index layout: move the tuple to another owner directory, then
  // forge the marker over the tampered layout so every layout digest still
  // matches while the canonical body keeps claiming current-parent ownership.
  await mkdir(join(owners, falseOwner), { mode: 0o700 });
  await rename(join(owners, trueOwner, `${job.id}.json`), join(owners, falseOwner, `${job.id}.json`));
  const tuples = createHash('sha256').update('zcode-owner-index-binding-tuples-v3\0').update(`${falseOwner}/${job.id}`).digest('hex');
  const ids = createHash('sha256').update('zcode-owner-index-job-ids-v2\0').update(job.id).digest('hex');
  await atomicWriteJson(join(owners, 'index.json'), { bindingTuples: { count: 1, digest: tuples }, canonicalJobIds: { count: 1, digest: ids }, complete: true, version: 3 });
  const before = await snapshot(ctx.dataRoot);
  assert.deepEqual(await ctx.inspect(), { state: 'blocked' });
  assert.deepEqual(await snapshot(ctx.dataRoot), before);
});

test('unreadable foreign-owned job bodies are blocked even without current-parent bindings', async (t) => {
  for (const damage of ['malformed', 'oversized']) {
    const ctx = await fixture(t);
    const job = await ctx.store.reserveJob({ workspace: ctx.workspace, ownerSessionId: 'other-parent', ownerTurnId: 'turn', command: 'rescue', readOnly: false, permissionSnapshot: { permissionMode: 'workspace-write' } });
    const storage = await resolveWorkspaceStorage(ctx); const path = join(storage.directory, 'jobs', `${job.id}.json`);
    if (damage === 'malformed') await writeFile(path, '{');
    // Oversized means beyond OWNER_JOB_BODY_MAX_BYTES (scripts/lib/state.mjs), kept literal here.
    if (damage === 'oversized') await writeFile(path, ' '.repeat(1024 * 1024 + 1));
    const before = await snapshot(ctx.dataRoot);
    assert.deepEqual(await ctx.inspect(), { state: 'blocked' }, damage);
    assert.deepEqual(await snapshot(ctx.dataRoot), before);
  }
});

test('closed binding evidence remains present', async (t) => {
  const ctx = await fixture(t); const files = await bindingFiles(ctx);
  const partition = JSON.parse(await readFile(files.partitionPath, 'utf8'));
  partition.records = partition.records.map((/** @type {any} */ record) => closeRescueBinding(record, { operationId: record.operationId, reason: 'session-ended' }));
  await atomicWriteJson(files.partitionPath, partition);
  assert.deepStrictEqual(await ctx.inspect(), { state: 'present' });
});

test('a current-parent non-rescue job with a consistent index proves absence', async (t) => {
  const ctx = await fixture(t);
  await ctx.store.reserveJob({ workspace: ctx.workspace, ownerSessionId: 'current-parent', ownerTurnId: 'turn', command: 'review', readOnly: true, permissionSnapshot: { permissionMode: 'default' } });
  const before = await snapshot(ctx.dataRoot);
  assert.deepEqual(await ctx.inspect(), { state: 'none' });
  assert.deepEqual(await snapshot(ctx.dataRoot), before);
});

test('malformed continuation inspection inputs are blocked without touching storage', async (t) => {
  const ctx = await fixture(t);
  const malformed = [
    null,
    undefined,
    { workspace: ctx.workspace, parentSessionId: null },
    { workspace: ctx.workspace, parentSessionId: undefined },
    { workspace: ctx.workspace, parentSessionId: '' },
    { workspace: ctx.workspace, parentSessionId: 'control\u0000id' },
    { parentSessionId: 'current-parent' },
    { workspace: 'relative/workspace', parentSessionId: 'current-parent' },
    { workspace: `${ctx.workspace}/`, parentSessionId: 'current-parent' },
    { workspace: join(ctx.root, 'absent-workspace'), parentSessionId: 'current-parent' },
  ];
  const before = await snapshot(ctx.dataRoot);
  for (const input of malformed) {
    assert.deepEqual(await ctx.store.inspectRescueContinuationPresence(/** @type {any} */ (input)), { state: 'blocked' }, JSON.stringify(input));
  }
  assert.deepEqual(await snapshot(ctx.dataRoot), before);
});

test('oversized or unreadable owned job and unsafe data directories are blocked', async (t) => {
  for (const damage of ['oversized', 'malformed', 'job-symlink', 'index-directory-symlink', 'permissions']) {
    if (damage === 'permissions' && process.platform === 'win32') continue;
    const ctx = await fixture(t);
    const job = await ctx.store.reserveJob({ workspace: ctx.workspace, ownerSessionId: 'current-parent', ownerTurnId: 'turn', command: 'rescue', readOnly: false, permissionSnapshot: { permissionMode: 'workspace-write' } });
    const storage = await resolveWorkspaceStorage(ctx); const path = join(storage.directory, 'jobs', `${job.id}.json`);
    // Oversized means beyond OWNER_JOB_BODY_MAX_BYTES (scripts/lib/state.mjs), kept literal here.
    if (damage === 'oversized') await writeFile(path, ' '.repeat(1024 * 1024 + 1));
    if (damage === 'malformed') await writeFile(path, '{');
    if (damage === 'job-symlink') { await unlink(path); await symlink(join(ctx.root, 'absent'), path); }
    if (damage === 'index-directory-symlink') { await rm(join(storage.directory, 'job-owners'), { recursive: true }); await symlink(ctx.dataRoot, join(storage.directory, 'job-owners')); }
    if (damage === 'permissions') await chmod(join(storage.directory, 'jobs'), 0o755);
    const before = await snapshot(ctx.dataRoot);
    assert.deepEqual(await ctx.inspect(), { state: 'blocked' }, damage);
    assert.deepEqual(await snapshot(ctx.dataRoot), before);
  }
});
