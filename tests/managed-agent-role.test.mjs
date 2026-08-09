// @ts-nocheck
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rename, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { atomicWritePrivateFile, withFileLock } from '../scripts/lib/fs.mjs';
import {
  MANAGED_ROLE_DESCRIPTION,
  MANAGED_ROLE_NAME,
  MANAGED_ROLE_SCHEMA_VERSION,
  inspectManagedRescueRole,
  managedRolePaths,
  reconcileManagedRescueRole,
  renderManagedRescueRole,
} from '../scripts/lib/managed-agent-role.mjs';

const template = `developer_instructions = """
Root={{PLUGIN_ROOT}}
Again={{PLUGIN_ROOT}}
Last={{PLUGIN_ROOT}}
"""
`;

function roleConfig(path) {
  return { description: MANAGED_ROLE_DESCRIPTION, config_file: path };
}

function configState({ path, role, metadata = false, layers, errors = [], version = 'v1' }) {
  const config = {
    agents: role === undefined ? {} : { [MANAGED_ROLE_NAME]: role },
    features: { hooks: true, multi_agent_v2: { hide_spawn_agent_metadata: metadata } },
  };
  return {
    config,
    errors,
    layers: layers ?? [{ name: { type: 'user', file: '/config.toml' }, version, config }],
    origins: path ? { [`agents.${MANAGED_ROLE_NAME}`]: '/config.toml' } : {},
  };
}

async function fixture() {
  const dataRoot = await realpath(await mkdtemp(join(tmpdir(), 'zcode-managed-role-')));
  const pluginRoot = await realpath(await mkdtemp(join(tmpdir(), 'zcode plugin-')));
  const paths = managedRolePaths(dataRoot);
  const configTarget = { filePath: '/config.toml', expectedVersion: 'v1' };
  return { dataRoot, pluginRoot, paths, configTarget };
}

function common(ctx, config) {
  return {
    dataRoot: ctx.dataRoot,
    template,
    pluginRoot: ctx.pluginRoot,
    pluginIdentity: 'zcode@vitry',
    pluginVersion: '0.1.0',
    config,
    configTarget: ctx.configTarget,
    sessionStartedAt: '2999-01-01T00:00:00.000Z',
  };
}

test('atomic private file preserves exact bytes, replaces atomically, and remains private', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-role-atomic-'));
  const target = join(directory, 'zcode-rescue.toml');
  const bytes = Buffer.from('role-bytes\n\u0000tail');
  await writeFile(target, 'old bytes', { mode: 0o644 });

  await atomicWritePrivateFile(target, bytes);

  assert.deepEqual(await readFile(target), bytes);
  if (process.platform !== 'win32') assert.equal((await stat(target)).mode & 0o777, 0o600);
});

test('managed Rescue role exposes the fixed contract and stable non-cache paths', async () => {
  const ctx = await fixture();
  assert.equal(MANAGED_ROLE_NAME, 'zcode-rescue');
  assert.equal(MANAGED_ROLE_SCHEMA_VERSION, 1);
  assert.equal(MANAGED_ROLE_DESCRIPTION, 'Runs the fixed ZCode Rescue forwarder in an isolated Codex subagent.');
  assert.deepEqual(ctx.paths, {
    rolePath: join(ctx.dataRoot, 'agent-roles', 'zcode-rescue.toml'),
    receiptPath: join(ctx.dataRoot, 'agent-roles', 'zcode-rescue.receipt.json'),
    transactionPath: join(ctx.dataRoot, 'agent-roles', 'zcode-rescue.transaction.json'),
    lockPath: join(ctx.dataRoot, 'agent-roles', 'lock'),
  });
  assert.doesNotMatch(ctx.paths.rolePath, /cache|0\.1\.0/);
});

test('managed Rescue role rendering deterministically TOML-escapes only the canonical plugin root', () => {
  const unix = renderManagedRescueRole({ template, pluginRoot: '/opt/ZCode "active"' });
  assert.equal(unix, template.replaceAll('{{PLUGIN_ROOT}}', '/opt/ZCode \\"active\\"'));
  const windows = renderManagedRescueRole({ template, pluginRoot: 'C:\\Users\\me\\ZCode' });
  assert.match(windows, /C:\\\\Users\\\\me\\\\ZCode/);
  assert.throws(() => renderManagedRescueRole({ template: `${template} task={{TASK}}`, pluginRoot: '/opt/zcode' }), { code: 'MANAGED_ROLE_TEMPLATE_INVALID' });
  assert.throws(() => renderManagedRescueRole({ template, pluginRoot: '/opt/zcode\nsecret' }), { code: 'MANAGED_ROLE_ROOT_INVALID' });
});

test('managed Rescue role inspection distinguishes absent, foreign, and project-shadowed definitions', async () => {
  const ctx = await fixture();
  assert.equal((await inspectManagedRescueRole(common(ctx, configState({})))).status, 'install-required');
  assert.equal((await inspectManagedRescueRole(common(ctx, configState({ role: roleConfig('/foreign.toml') })))).status, 'foreign-conflict');
  const project = configState({ role: roleConfig(ctx.paths.rolePath), layers: [
    { name: { type: 'user', file: '/config.toml' }, version: 'v1', config: {} },
    { name: { type: 'project', file: '/repo/.codex/config.toml' }, version: 'p1', config: { agents: { [MANAGED_ROLE_NAME]: roleConfig('/project.toml') } } },
  ] });
  assert.equal((await inspectManagedRescueRole(common(ctx, project))).status, 'project-shadowed');
});

test('managed Rescue role refuses higher-precedence definitions and load errors', async () => {
  const ctx = await fixture();
  const managed = configState({ role: roleConfig('/managed.toml'), layers: [
    { name: { type: 'user', file: '/config.toml' }, version: 'v1', config: {} },
    { name: { type: 'managed', file: '/etc/codex.toml' }, version: 'm1', config: { agents: { [MANAGED_ROLE_NAME]: roleConfig('/managed.toml') } } },
  ] });
  assert.equal((await inspectManagedRescueRole(common(ctx, managed))).status, 'higher-precedence-conflict');
  assert.equal((await inspectManagedRescueRole(common(ctx, configState({ errors: [{ path: ctx.paths.rolePath, message: 'load failed' }] })))).status, 'unsupported');
});

test('managed Rescue role classifies a lower-precedence same-name definition as foreign', async () => {
  const ctx = await fixture();
  const layered = configState({ role: roleConfig(ctx.paths.rolePath), layers: [
    { name: { type: 'user', file: '/base-config.toml' }, version: 'base', config: { agents: { [MANAGED_ROLE_NAME]: roleConfig('/foreign.toml') } } },
    { name: { type: 'user', file: '/config.toml' }, version: 'v1', config: {} },
  ] });
  assert.equal((await inspectManagedRescueRole(common(ctx, layered))).status, 'foreign-conflict');
});

test('managed Rescue role conflict errors identify bounded project, higher, and lower layer sources without values', async (t) => {
  const ctx = await fixture();
  const cases = [
    {
      name: 'project', status: 'project-shadowed', expected: { layerType: 'project', filePath: '/repo/.codex/config.toml', precedence: 'higher' },
      config: configState({ role: roleConfig('/project.toml'), layers: [
        { name: { type: 'user', file: '/config.toml' }, version: 'v1', config: {} },
        { name: { type: 'project', file: '/repo/.codex/config.toml' }, version: 'p1', config: { agents: { [MANAGED_ROLE_NAME]: roleConfig('/project.toml') } } },
      ] }),
    },
    {
      name: 'higher', status: 'higher-precedence-conflict', expected: { layerType: 'managed', filePath: '/etc/codex.toml', precedence: 'higher' },
      config: configState({ role: roleConfig('/managed.toml'), layers: [
        { name: { type: 'user', file: '/config.toml' }, version: 'v1', config: {} },
        { name: { type: 'managed', file: '/etc/codex.toml' }, version: 'm1', config: { agents: { [MANAGED_ROLE_NAME]: roleConfig('/managed.toml') } } },
      ] }),
    },
    {
      name: 'lower', status: 'foreign-conflict', expected: { layerType: 'managed', filePath: '/etc/lower-codex.toml', precedence: 'lower' },
      config: configState({ role: roleConfig(ctx.paths.rolePath), layers: [
        { name: { type: 'managed', file: '/etc/lower-codex.toml' }, version: 'm1', config: { agents: { [MANAGED_ROLE_NAME]: roleConfig('/foreign.toml') } } },
        { name: { type: 'user', file: '/config.toml' }, version: 'v1', config: { agents: { [MANAGED_ROLE_NAME]: roleConfig(ctx.paths.rolePath) } } },
      ] }),
    },
  ];
  for (const entry of cases) await t.test(entry.name, async () => {
    let error;
    await assert.rejects(reconcileManagedRescueRole({
      ...common(ctx, entry.config), batchWrite: async () => ({}), readConfig: async () => entry.config,
    }), (candidate) => { error = candidate; return candidate?.code === 'MANAGED_ROLE_CONFLICT'; });
    assert.equal(error.details.status, entry.status);
    assert.deepEqual(error.details.conflicts, [entry.expected]);
    assert.match(error.remedy, new RegExp(entry.expected.filePath.replaceAll('.', '\\.')));
    assert.match(error.remedy, /remove or rename.*\$zcode:setup/is);
    assert.doesNotMatch(JSON.stringify(error.details), /description|config_file|foreign\.toml/);
  });
});

test('managed Rescue role installs transactionally and becomes ready only on an exact rerun', async () => {
  const ctx = await fixture();
  let current = configState({});
  let writtenEdits;
  const result = await reconcileManagedRescueRole({
    ...common(ctx, current),
    additionalEdits: [{ keyPath: 'features.hooks', value: true, mergeStrategy: 'upsert' }],
    batchWrite: async (params) => {
      writtenEdits = params.edits;
      current = configState({ path: ctx.paths.rolePath, role: roleConfig(ctx.paths.rolePath), metadata: false });
      return { version: 'v2' };
    },
    readConfig: async () => current,
  });
  assert.equal(result.status, 'restart-required');
  assert.equal(result.changed, true);
  assert.deepEqual(writtenEdits, [
    { keyPath: 'features.hooks', value: true, mergeStrategy: 'upsert' },
    { keyPath: `agents.${MANAGED_ROLE_NAME}`, value: roleConfig(ctx.paths.rolePath), mergeStrategy: 'upsert' },
    { keyPath: 'features.multi_agent_v2.hide_spawn_agent_metadata', value: false, mergeStrategy: 'upsert' },
  ]);
  assert.equal(await readFile(ctx.paths.rolePath, 'utf8'), renderManagedRescueRole({ template, pluginRoot: ctx.pluginRoot }));
  const receipt = JSON.parse(await readFile(ctx.paths.receiptPath, 'utf8'));
  assert.deepEqual(Object.keys(receipt).sort(), ['configTarget', 'mutatedAt', 'plugin', 'priorSpawnMetadataValue', 'role', 'roleName', 'schemaVersion'].sort());
  assert.deepEqual(receipt.plugin, { identity: 'zcode@vitry', version: '0.1.0', root: ctx.pluginRoot });
  assert.equal(receipt.role.path, ctx.paths.rolePath);
  assert.match(receipt.role.sha256, /^[a-f0-9]{64}$/);
  await assert.rejects(readFile(ctx.paths.transactionPath), { code: 'ENOENT' });

  const ready = await reconcileManagedRescueRole({
    ...common(ctx, current),
    batchWrite: async () => { throw new Error('must not write'); },
    readConfig: async () => current,
  });
  assert.deepEqual(ready, { status: 'ready', changed: false, rolePath: ctx.paths.rolePath });
});

test('managed Rescue role remains restart-required in the mutation session and is ready in a fresh session', async () => {
  const ctx = await fixture();
  let current = configState({});
  const mutationSession = '2000-01-01T00:00:00.000Z';
  await reconcileManagedRescueRole({
    ...common(ctx, current), sessionStartedAt: mutationSession,
    batchWrite: async () => { current = configState({ role: roleConfig(ctx.paths.rolePath) }); return {}; },
    readConfig: async () => current,
  });
  const sameSession = await reconcileManagedRescueRole({
    ...common(ctx, current), sessionStartedAt: mutationSession,
    batchWrite: async () => { throw new Error('must not write'); }, readConfig: async () => current,
  });
  assert.deepEqual(sameSession, { status: 'restart-required', changed: false, rolePath: ctx.paths.rolePath });
  const freshSession = await reconcileManagedRescueRole({
    ...common(ctx, current), sessionStartedAt: '2999-01-01T00:00:00.000Z',
    batchWrite: async () => { throw new Error('must not write'); }, readConfig: async () => current,
  });
  assert.deepEqual(freshSession, { status: 'ready', changed: false, rolePath: ctx.paths.rolePath });
});

test('managed Rescue role commits its freshness watermark after effective verification and journals the exact receipt first', async () => {
  const ctx = await fixture();
  let current = configState({});
  let effectiveVerified = false;
  let journalVerified = false;
  const watermark = '2025-01-01T00:00:02.000Z';
  await reconcileManagedRescueRole({
    ...common(ctx, current),
    sessionStartedAt: '2025-01-01T00:00:00.000Z',
    now: () => {
      assert.equal(effectiveVerified, true, 'watermark must follow effective-config verification');
      return watermark;
    },
    batchWrite: async () => { current = configState({ role: roleConfig(ctx.paths.rolePath) }); return {}; },
    readConfig: async () => { effectiveVerified = true; return current; },
    beforeReceiptCommit: async (receiptBytes) => {
      const journal = JSON.parse(await readFile(ctx.paths.transactionPath, 'utf8'));
      assert.equal(journal.phase, 'receipt-prepared');
      assert.equal(journal.intendedReceiptSha256, createHash('sha256').update(receiptBytes).digest('hex'));
      journalVerified = true;
    },
  });
  assert.equal(journalVerified, true);
  assert.equal(JSON.parse(await readFile(ctx.paths.receiptPath, 'utf8')).mutatedAt, watermark);
  assert.equal((await inspectManagedRescueRole({ ...common(ctx, current), sessionStartedAt: '2025-01-01T00:00:01.000Z' })).status, 'restart-required');
  assert.equal((await inspectManagedRescueRole({ ...common(ctx, current), sessionStartedAt: '2025-01-01T00:00:03.000Z' })).status, 'ready');
});

test('managed Rescue role receipt records a provable prior metadata value without authorization data', async () => {
  const ctx = await fixture();
  let current = configState({ metadata: true });
  await reconcileManagedRescueRole({
    ...common(ctx, current),
    batchWrite: async () => { current = configState({ role: roleConfig(ctx.paths.rolePath), metadata: false }); return { version: 'v2' }; },
    readConfig: async () => current,
  });
  const receipt = JSON.parse(await readFile(ctx.paths.receiptPath, 'utf8'));
  assert.equal(receipt.priorSpawnMetadataValue, true);
  assert.doesNotMatch(JSON.stringify(receipt), /task|args|job|session|permission|capability|credential/i);
});

test('managed Rescue role reports drift for missing receipt, modified file, digest, or registration', async (t) => {
  const ctx = await fixture();
  await mkdir(join(ctx.dataRoot, 'agent-roles'), { recursive: true });
  await writeFile(ctx.paths.rolePath, renderManagedRescueRole({ template, pluginRoot: ctx.pluginRoot }));
  const config = configState({ role: roleConfig(ctx.paths.rolePath) });
  assert.equal((await inspectManagedRescueRole(common(ctx, config))).status, 'drift');
  await unlink(ctx.paths.rolePath);

  let current = configState({});
  await reconcileManagedRescueRole({ ...common(ctx, current), batchWrite: async () => { current = config; return {}; }, readConfig: async () => current });
  await t.test('modified file', async () => {
    await writeFile(ctx.paths.rolePath, 'modified');
    assert.equal((await inspectManagedRescueRole(common(ctx, config))).status, 'drift');
  });
  await writeFile(ctx.paths.rolePath, renderManagedRescueRole({ template, pluginRoot: ctx.pluginRoot }));
  await t.test('modified digest', async () => {
    const receipt = JSON.parse(await readFile(ctx.paths.receiptPath, 'utf8')); receipt.role.sha256 = '0'.repeat(64); await writeFile(ctx.paths.receiptPath, JSON.stringify(receipt));
    assert.equal((await inspectManagedRescueRole(common(ctx, config))).status, 'drift');
  });
  await t.test('modified registration', async () => {
    assert.equal((await inspectManagedRescueRole(common(ctx, configState({ role: { ...roleConfig(ctx.paths.rolePath), description: 'changed' } })))).status, 'drift');
  });
});

test('managed Rescue role classifies an owned old version as upgrade-required', async () => {
  const ctx = await fixture();
  let current = configState({});
  await reconcileManagedRescueRole({ ...common(ctx, current), pluginVersion: '0.0.9', batchWrite: async () => { current = configState({ role: roleConfig(ctx.paths.rolePath) }); return {}; }, readConfig: async () => current });
  assert.equal((await inspectManagedRescueRole(common(ctx, current))).status, 'upgrade-required');
});

test('managed Rescue role upgrades a provably owned old schema but rejects unknown new schemas', async () => {
  const ctx = await fixture();
  let current = configState({});
  await reconcileManagedRescueRole({ ...common(ctx, current), batchWrite: async () => { current = configState({ role: roleConfig(ctx.paths.rolePath) }); return {}; }, readConfig: async () => current });
  const receipt = JSON.parse(await readFile(ctx.paths.receiptPath, 'utf8'));
  receipt.schemaVersion = 0;
  receipt.role.schemaVersion = 0;
  delete receipt.mutatedAt;
  await writeFile(ctx.paths.receiptPath, `${JSON.stringify(receipt)}\n`);
  assert.equal((await inspectManagedRescueRole(common(ctx, current))).status, 'upgrade-required');
  receipt.schemaVersion = 2;
  receipt.role.schemaVersion = 2;
  await writeFile(ctx.paths.receiptPath, `${JSON.stringify(receipt)}\n`);
  assert.equal((await inspectManagedRescueRole(common(ctx, current))).status, 'drift');
});

test('managed Rescue role treats a changed selected config target as drift', async () => {
  const ctx = await fixture();
  let current = configState({});
  await reconcileManagedRescueRole({ ...common(ctx, current), batchWrite: async () => { current = configState({ role: roleConfig(ctx.paths.rolePath) }); return {}; }, readConfig: async () => current });
  const changedTarget = { ...common(ctx, current), configTarget: { filePath: '/other-config.toml', expectedVersion: 'other-v1' } };
  assert.equal((await inspectManagedRescueRole(changedTarget)).status, 'drift');
});

test('managed Rescue role rolls back all proven setup leaves after post-write shadowing', async () => {
  const ctx = await fixture();
  const before = configState({ metadata: true });
  let writes = 0;
  let rollbackEdits;
  await assert.rejects(reconcileManagedRescueRole({
    ...common(ctx, before),
    additionalEdits: [{ keyPath: 'features.hooks', value: true, mergeStrategy: 'upsert' }],
    batchWrite: async (params) => {
      writes += 1;
      if (writes === 2) rollbackEdits = params.edits;
      return { version: `v${writes + 1}` };
    },
    readConfig: async () => {
      const targetConfig = {
        features: { hooks: true, multi_agent_v2: { hide_spawn_agent_metadata: false } },
        agents: { [MANAGED_ROLE_NAME]: roleConfig(ctx.paths.rolePath) },
      };
      return configState({ role: roleConfig('/project.toml'), metadata: false, layers: [
        { name: { type: 'user', file: '/config.toml' }, version: 'v2', config: targetConfig },
        { name: { type: 'project', file: '/repo/.codex/config.toml' }, version: 'p1', config: { agents: { [MANAGED_ROLE_NAME]: roleConfig('/project.toml') } } },
      ] });
    },
  }), { code: 'MANAGED_ROLE_RECONCILE_FAILED' });
  assert.equal(writes, 2);
  assert.deepEqual(rollbackEdits, [
    { keyPath: 'features.hooks', value: true, mergeStrategy: 'upsert' },
    { keyPath: `agents.${MANAGED_ROLE_NAME}`, value: null, mergeStrategy: 'upsert' },
    { keyPath: 'features.multi_agent_v2.hide_spawn_agent_metadata', value: true, mergeStrategy: 'upsert' },
  ]);
});

test('managed Rescue role preserves evidence when role-written recovery finds unjournaled foreign config', async () => {
  const ctx = await fixture();
  await mkdir(join(ctx.dataRoot, 'agent-roles'), { recursive: true });
  await writeFile(ctx.paths.rolePath, 'partial');
  await writeFile(ctx.paths.transactionPath, `${JSON.stringify({
    schemaVersion: 1,
    phase: 'role-written',
    rolePath: ctx.paths.rolePath,
    roleExisted: false,
    receiptExisted: false,
    intendedSha256: createHash('sha256').update('partial').digest('hex'),
    previousRegistration: { present: false },
    previousMetadata: { present: false },
    previousAdditional: [],
  })}\n`);
  let writes = 0;
  const foreign = configState({ role: roleConfig('/foreign.toml') });
  await assert.rejects(reconcileManagedRescueRole({
    ...common(ctx, foreign), batchWrite: async () => { writes += 1; return {}; }, readConfig: async () => foreign,
  }), { code: 'MANAGED_ROLE_ROLLBACK_INCOMPLETE' });
  assert.equal(writes, 0);
  assert.equal((await stat(ctx.paths.rolePath)).isFile(), true);
  assert.equal((await stat(ctx.paths.transactionPath)).isFile(), true);
});

test('managed Rescue role rejects unsafe symlink installation paths', async () => {
  const ctx = await fixture();
  const outside = await mkdtemp(join(tmpdir(), 'zcode-role-outside-'));
  await symlink(outside, join(ctx.dataRoot, 'agent-roles'));
  assert.equal((await inspectManagedRescueRole(common(ctx, configState({})))).status, 'unsupported');
  await assert.rejects(reconcileManagedRescueRole({
    ...common(ctx, configState({})), batchWrite: async () => ({}), readConfig: async () => configState({}),
  }), { code: 'MANAGED_ROLE_PATH_UNSAFE' });
});

test('managed Rescue role rejects a symlinked lock directory without touching its target', async () => {
  const ctx = await fixture();
  const outside = await realpath(await mkdtemp(join(tmpdir(), 'zcode-lock-outside-')));
  const marker = join(outside, 'marker');
  await writeFile(marker, 'outside-safe', { mode: 0o644 });
  await mkdir(join(ctx.dataRoot, 'agent-roles'));
  await symlink(outside, ctx.paths.lockPath);
  assert.equal((await inspectManagedRescueRole(common(ctx, configState({})))).status, 'unsupported');
  await assert.rejects(reconcileManagedRescueRole({
    ...common(ctx, configState({})), batchWrite: async () => ({}), readConfig: async () => configState({}),
  }), { code: 'MANAGED_ROLE_PATH_UNSAFE' });
  assert.equal(await readFile(marker, 'utf8'), 'outside-safe');
  assert.equal((await stat(marker)).mode & 0o777, 0o644);
});

test('managed Rescue role rejects a symlinked advisory lock file without touching its target', async () => {
  const ctx = await fixture();
  const outside = join(await realpath(await mkdtemp(join(tmpdir(), 'zcode-lock-file-outside-'))), 'outside.lock');
  await writeFile(outside, 'outside-lock', { mode: 0o644 });
  await mkdir(ctx.paths.lockPath, { recursive: true });
  await symlink(outside, join(ctx.paths.lockPath, 'advisory.lock'));
  assert.equal((await inspectManagedRescueRole(common(ctx, configState({})))).status, 'unsupported');
  await assert.rejects(reconcileManagedRescueRole({
    ...common(ctx, configState({})), batchWrite: async () => ({}), readConfig: async () => configState({}),
  }), { code: 'MANAGED_ROLE_PATH_UNSAFE' });
  assert.equal(await readFile(outside, 'utf8'), 'outside-lock');
  assert.equal((await stat(outside)).mode & 0o777, 0o644);
});

test('file locking rejects a lock directory replaced by a symlink between validation and open', { skip: process.platform === 'win32' ? 'Windows cannot rename an open lock directory in this race fixture.' : false }, async () => {
  const ctx = await fixture();
  await withFileLock(ctx.paths.lockPath, async () => undefined);
  const heldLock = `${ctx.paths.lockPath}.held`;
  const outside = await realpath(await mkdtemp(join(tmpdir(), 'zcode-lock-race-outside-')));
  const outsideAdvisory = join(outside, 'advisory.lock');
  await writeFile(outsideAdvisory, 'outside-safe', { mode: 0o644 });
  let injected = false;
  await assert.rejects(withFileLock(ctx.paths.lockPath, async () => { throw new Error('must not enter'); }, {
    beforeLockOpen: async () => {
      injected = true;
      await rename(ctx.paths.lockPath, heldLock);
      await symlink(outside, ctx.paths.lockPath);
    },
  }), (error) => error?.code === 'LOCK_OPEN_FAILED' || error?.code === 'LOCK_PATH_UNSAFE');
  assert.equal(injected, true);
  assert.equal(await readFile(outsideAdvisory, 'utf8'), 'outside-safe');
  assert.equal((await stat(outsideAdvisory)).mode & 0o777, 0o644);
});

test('file locking rejects an advisory file replaced by a symlink between validation and open', async () => {
  const ctx = await fixture();
  await withFileLock(ctx.paths.lockPath, async () => undefined);
  const advisory = join(ctx.paths.lockPath, 'advisory.lock');
  const outside = join(await realpath(await mkdtemp(join(tmpdir(), 'zcode-advisory-race-outside-'))), 'outside.lock');
  await writeFile(outside, 'outside-safe', { mode: 0o644 });
  let injected = false;
  await assert.rejects(withFileLock(ctx.paths.lockPath, async () => { throw new Error('must not enter'); }, {
    beforeLockOpen: async () => {
      injected = true;
      await unlink(advisory);
      await symlink(outside, advisory);
    },
  }), (error) => error?.code === 'LOCK_OPEN_FAILED' || error?.code === 'LOCK_PATH_UNSAFE');
  assert.equal(injected, true);
  assert.equal(await readFile(outside, 'utf8'), 'outside-safe');
  assert.equal((await stat(outside)).mode & 0o777, 0o644);
});

test('managed Rescue role rolls back owned file state on version races and leaves no ready receipt', async () => {
  const ctx = await fixture();
  await assert.rejects(reconcileManagedRescueRole({
    ...common(ctx, configState({})),
    batchWrite: async () => { throw Object.assign(new Error('version race'), { code: 'CODEX_CONFIG_REQUEST_FAILED' }); },
    readConfig: async () => configState({}),
  }), { code: 'MANAGED_ROLE_RECONCILE_FAILED' });
  await assert.rejects(readFile(ctx.paths.rolePath), { code: 'ENOENT' });
  await assert.rejects(readFile(ctx.paths.receiptPath), { code: 'ENOENT' });
  await assert.rejects(readFile(ctx.paths.transactionPath), { code: 'ENOENT' });
});

test('managed Rescue role rolls back an applied config write with the current selected-layer CAS version after transport failure', async () => {
  const ctx = await fixture();
  let current = configState({});
  const writes = [];
  await assert.rejects(reconcileManagedRescueRole({
    ...common(ctx, current),
    batchWrite: async (params) => {
      writes.push(params);
      if (writes.length === 1) {
        current = configState({ role: roleConfig(ctx.paths.rolePath), version: 'v2' });
        throw Object.assign(new Error('response lost after commit'), { code: 'CODEX_CONFIG_REQUEST_FAILED' });
      }
      current = configState({ version: 'v3' });
      return { version: 'v3' };
    },
    readConfig: async () => current,
  }), { code: 'MANAGED_ROLE_RECONCILE_FAILED' });
  assert.equal(writes.length, 2);
  assert.equal(writes[1].expectedVersion, 'v2');
  assert.deepEqual(writes[1].edits.slice(-2), [
    { keyPath: `agents.${MANAGED_ROLE_NAME}`, value: null, mergeStrategy: 'upsert' },
    { keyPath: 'features.multi_agent_v2.hide_spawn_agent_metadata', value: false, mergeStrategy: 'upsert' },
  ]);
  await assert.rejects(readFile(ctx.paths.rolePath), { code: 'ENOENT' });
  await assert.rejects(readFile(ctx.paths.transactionPath), { code: 'ENOENT' });
});

test('managed Rescue role preserves all recovery evidence for mixed config after an ambiguous applied-write failure', async () => {
  const ctx = await fixture();
  let current = configState({});
  let writes = 0;
  let error;
  await assert.rejects(reconcileManagedRescueRole({
    ...common(ctx, current),
    batchWrite: async () => {
      writes += 1;
      current = configState({ role: { description: 'foreign concurrent role', config_file: '/foreign.toml' }, version: 'v2' });
      throw Object.assign(new Error('response lost after foreign write won'), { code: 'CODEX_CONFIG_REQUEST_FAILED' });
    },
    readConfig: async () => current,
  }), (candidate) => { error = candidate; return candidate?.code === 'MANAGED_ROLE_ROLLBACK_INCOMPLETE'; });
  assert.equal(writes, 1);
  assert.equal(current.config.agents[MANAGED_ROLE_NAME].description, 'foreign concurrent role');
  assert.equal((await stat(ctx.paths.rolePath)).isFile(), true);
  assert.equal((await stat(ctx.paths.transactionPath)).isFile(), true);
  assert.ok(error.details.remaining.includes(ctx.paths.rolePath));
  assert.ok(error.details.remaining.includes(ctx.paths.receiptPath));
  assert.ok(error.details.remaining.includes(ctx.configTarget.filePath));
  assert.ok(error.details.remaining.includes(ctx.paths.transactionPath));
});

test('managed Rescue role treats partially applied or concurrently changed intended leaves as incomplete', async (t) => {
  const cases = [
    {
      name: 'additional leaf',
      additionalEdits: [{ keyPath: 'features.hooks', value: true, mergeStrategy: 'upsert' }],
      change(config) { config.config.features.hooks = false; },
    },
    { name: 'spawn metadata', change(config) { config.config.features.multi_agent_v2.hide_spawn_agent_metadata = true; } },
    { name: 'Role description', change(config) { config.config.agents[MANAGED_ROLE_NAME].description = 'concurrent description'; } },
    { name: 'Role path', change(config) { config.config.agents[MANAGED_ROLE_NAME].config_file = '/concurrent.toml'; } },
  ];
  for (const entry of cases) await t.test(entry.name, async () => {
    const ctx = await fixture();
    let current = configState({});
    let writes = 0;
    await assert.rejects(reconcileManagedRescueRole({
      ...common(ctx, current), additionalEdits: entry.additionalEdits,
      batchWrite: async () => {
        writes += 1;
        current = configState({ role: roleConfig(ctx.paths.rolePath), version: 'v2' });
        entry.change(current);
        throw Object.assign(new Error('response lost after partial or concurrent mutation'), { code: 'CODEX_CONFIG_REQUEST_FAILED' });
      },
      readConfig: async () => current,
    }), { code: 'MANAGED_ROLE_ROLLBACK_INCOMPLETE' });
    assert.equal(writes, 1);
    assert.equal((await stat(ctx.paths.rolePath)).isFile(), true);
    assert.equal((await stat(ctx.paths.transactionPath)).isFile(), true);
  });
});

test('managed Rescue role distinguishes exact previous absent, false, and unpersistable undefined leaves', async (t) => {
  for (const prior of ['absent', 'false', 'undefined']) await t.test(prior, async () => {
    const ctx = await fixture();
    const current = configState({});
    if (prior === 'absent') {
      delete current.config.features.hooks;
      delete current.config.features.multi_agent_v2.hide_spawn_agent_metadata;
    } else if (prior === 'undefined') {
      current.config.features.hooks = undefined;
      current.config.features.multi_agent_v2.hide_spawn_agent_metadata = undefined;
    }
    let writes = 0;
    const expectedCode = prior === 'undefined' ? 'MANAGED_ROLE_ROLLBACK_INCOMPLETE' : 'MANAGED_ROLE_RECONCILE_FAILED';
    await assert.rejects(reconcileManagedRescueRole({
      ...common(ctx, current), additionalEdits: [{ keyPath: 'features.hooks', value: true, mergeStrategy: 'upsert' }],
      batchWrite: async () => { writes += 1; throw Object.assign(new Error('write not applied'), { code: 'CODEX_CONFIG_REQUEST_FAILED' }); },
      readConfig: async () => current,
    }), { code: expectedCode });
    assert.equal(writes, 1);
    if (prior === 'undefined') {
      assert.equal((await stat(ctx.paths.rolePath)).isFile(), true);
      assert.equal((await stat(ctx.paths.transactionPath)).isFile(), true);
    } else {
      await assert.rejects(readFile(ctx.paths.rolePath), { code: 'ENOENT' });
      await assert.rejects(readFile(ctx.paths.transactionPath), { code: 'ENOENT' });
    }
  });
});

test('managed Rescue role treats an invalid config reread as unprovable even when leaves appear absent', async () => {
  const ctx = await fixture();
  const initial = configState({});
  delete initial.config.features.multi_agent_v2.hide_spawn_agent_metadata;
  let current = initial;
  await assert.rejects(reconcileManagedRescueRole({
    ...common(ctx, initial),
    batchWrite: async () => { current = {}; throw Object.assign(new Error('response lost'), { code: 'CODEX_CONFIG_REQUEST_FAILED' }); },
    readConfig: async () => current,
  }), { code: 'MANAGED_ROLE_ROLLBACK_INCOMPLETE' });
  assert.equal((await stat(ctx.paths.rolePath)).isFile(), true);
  assert.equal((await stat(ctx.paths.transactionPath)).isFile(), true);
});

test('managed Rescue role recovers an interrupted owned transaction before retrying', async () => {
  const ctx = await fixture();
  await mkdir(join(ctx.dataRoot, 'agent-roles'), { recursive: true });
  await writeFile(ctx.paths.rolePath, 'partial');
  await writeFile(ctx.paths.transactionPath, `${JSON.stringify({
    schemaVersion: 1,
    phase: 'prepared',
    rolePath: ctx.paths.rolePath,
    roleExisted: false,
    receiptExisted: false,
    intendedSha256: createHash('sha256').update('partial').digest('hex'),
    previousRegistration: { present: false },
    previousMetadata: { present: false },
  })}\n`);
  let current = configState({});
  const result = await reconcileManagedRescueRole({
    ...common(ctx, current), batchWrite: async () => { current = configState({ role: roleConfig(ctx.paths.rolePath) }); return {}; }, readConfig: async () => current,
  });
  assert.equal(result.status, 'restart-required');
  assert.notEqual(await readFile(ctx.paths.rolePath, 'utf8'), 'partial');
  await assert.rejects(readFile(ctx.paths.transactionPath), { code: 'ENOENT' });
});

test('managed Rescue role recovers a role-written crash using the current selected-layer version', async () => {
  const ctx = await fixture();
  const roleBytes = Buffer.from(renderManagedRescueRole({ template, pluginRoot: ctx.pluginRoot }));
  await mkdir(join(ctx.dataRoot, 'agent-roles'), { recursive: true });
  await writeFile(ctx.paths.rolePath, roleBytes);
  await writeFile(ctx.paths.transactionPath, `${JSON.stringify({
    schemaVersion: 1, phase: 'role-written', rolePath: ctx.paths.rolePath,
    roleExisted: false, receiptExisted: false,
    intendedSha256: createHash('sha256').update(roleBytes).digest('hex'),
    previousRegistration: { present: false }, previousMetadata: { present: false },
    previousAdditional: [], desiredAdditional: [],
  })}\n`);
  const current = configState({ role: roleConfig(ctx.paths.rolePath), version: 'v2' });
  let rollback;
  await assert.rejects(reconcileManagedRescueRole({
    ...common(ctx, current),
    batchWrite: async (params) => { rollback = params; return { version: 'v3' }; },
    readConfig: async () => current,
  }), { code: 'MANAGED_ROLE_CONFLICT' });
  assert.equal(rollback.expectedVersion, 'v2');
  await assert.rejects(readFile(ctx.paths.rolePath), { code: 'ENOENT' });
  await assert.rejects(readFile(ctx.paths.transactionPath), { code: 'ENOENT' });
});

test('managed Rescue role keeps recovery incomplete when an applied config has no current CAS version', async () => {
  const ctx = await fixture();
  const roleBytes = Buffer.from(renderManagedRescueRole({ template, pluginRoot: ctx.pluginRoot }));
  await mkdir(join(ctx.dataRoot, 'agent-roles'), { recursive: true });
  await writeFile(ctx.paths.rolePath, roleBytes);
  await writeFile(ctx.paths.transactionPath, `${JSON.stringify({
    schemaVersion: 1, phase: 'role-written', rolePath: ctx.paths.rolePath,
    roleExisted: false, receiptExisted: false, intendedSha256: createHash('sha256').update(roleBytes).digest('hex'),
    previousRegistration: { present: false }, previousMetadata: { present: false }, previousAdditional: [], desiredAdditional: [],
  })}\n`);
  const current = configState({ role: roleConfig(ctx.paths.rolePath) });
  delete current.layers[0].version;
  let writes = 0;
  let error;
  await assert.rejects(reconcileManagedRescueRole({
    ...common(ctx, current), batchWrite: async () => { writes += 1; return {}; }, readConfig: async () => current,
  }), (candidate) => { error = candidate; return candidate?.code === 'MANAGED_ROLE_ROLLBACK_INCOMPLETE'; });
  assert.equal(writes, 0);
  assert.ok(error.details.remaining.includes(ctx.configTarget.filePath));
  assert.equal((await stat(ctx.paths.transactionPath)).isFile(), true);
});

test('managed Rescue role recovers an upgrade interrupted before new bytes were written', async () => {
  const ctx = await fixture();
  let current = configState({});
  await reconcileManagedRescueRole({ ...common(ctx, current), pluginVersion: '0.0.9', batchWrite: async () => { current = configState({ role: roleConfig(ctx.paths.rolePath) }); return {}; }, readConfig: async () => current });
  const previousRole = await readFile(ctx.paths.rolePath);
  const previousReceipt = await readFile(ctx.paths.receiptPath);
  const nextPluginRoot = await realpath(await mkdtemp(join(tmpdir(), 'zcode next plugin-')));
  const nextBytes = Buffer.from(renderManagedRescueRole({ template, pluginRoot: nextPluginRoot }));
  await writeFile(ctx.paths.transactionPath, `${JSON.stringify({
    schemaVersion: 1,
    phase: 'prepared',
    rolePath: ctx.paths.rolePath,
    roleExisted: true,
    previousRoleBase64: previousRole.toString('base64'),
    receiptExisted: true,
    previousReceiptBase64: previousReceipt.toString('base64'),
    intendedSha256: createHash('sha256').update(nextBytes).digest('hex'),
    previousRegistration: { present: true, value: roleConfig(ctx.paths.rolePath) },
    previousMetadata: { present: true, value: false },
    previousAdditional: [],
    desiredAdditional: [],
  })}\n`);
  const result = await reconcileManagedRescueRole({
    ...common(ctx, current), pluginRoot: nextPluginRoot,
    batchWrite: async () => ({}), readConfig: async () => current,
  });
  assert.equal(result.status, 'restart-required');
  assert.equal(JSON.parse(await readFile(ctx.paths.receiptPath, 'utf8')).plugin.root, nextPluginRoot);
});

test('managed Rescue role rolls back config after a crash with a journaled receipt watermark', async () => {
  const ctx = await fixture();
  const roleBytes = Buffer.from(renderManagedRescueRole({ template, pluginRoot: ctx.pluginRoot }));
  await mkdir(join(ctx.dataRoot, 'agent-roles'), { recursive: true });
  await writeFile(ctx.paths.rolePath, roleBytes);
  const intendedReceiptBytes = Buffer.from('not-yet-written');
  await writeFile(ctx.paths.transactionPath, `${JSON.stringify({
    schemaVersion: 1,
    phase: 'receipt-prepared',
    rolePath: ctx.paths.rolePath,
    roleExisted: false,
    receiptExisted: false,
    intendedSha256: createHash('sha256').update(roleBytes).digest('hex'),
    intendedReceiptSha256: createHash('sha256').update(intendedReceiptBytes).digest('hex'),
    intendedReceiptBase64: intendedReceiptBytes.toString('base64'),
    previousRegistration: { present: false },
    previousMetadata: { present: false },
    previousAdditional: [],
    desiredAdditional: [],
    configVersion: 'v2',
  })}\n`);
  const current = configState({ role: roleConfig(ctx.paths.rolePath) });
  let rollbackWrites = 0;
  await assert.rejects(reconcileManagedRescueRole({
    ...common(ctx, current),
    batchWrite: async () => { rollbackWrites += 1; return {}; },
    readConfig: async () => current,
  }), { code: 'MANAGED_ROLE_CONFLICT' });
  assert.equal(rollbackWrites, 1);
  await assert.rejects(readFile(ctx.paths.rolePath), { code: 'ENOENT' });
  await assert.rejects(readFile(ctx.paths.transactionPath), { code: 'ENOENT' });
});

test('managed Rescue role preserves an unproven receipt during interrupted rollback', async () => {
  const ctx = await fixture();
  let current = configState({});
  await reconcileManagedRescueRole({ ...common(ctx, current), batchWrite: async () => { current = configState({ role: roleConfig(ctx.paths.rolePath) }); return {}; }, readConfig: async () => current });
  const roleBytes = await readFile(ctx.paths.rolePath);
  const previousReceipt = await readFile(ctx.paths.receiptPath);
  const foreignReceipt = Buffer.from('{"foreign":true}\n');
  await writeFile(ctx.paths.receiptPath, foreignReceipt);
  await writeFile(ctx.paths.transactionPath, `${JSON.stringify({
    schemaVersion: 1,
    phase: 'prepared',
    rolePath: ctx.paths.rolePath,
    roleExisted: true,
    previousRoleBase64: roleBytes.toString('base64'),
    receiptExisted: true,
    previousReceiptBase64: previousReceipt.toString('base64'),
    intendedSha256: createHash('sha256').update(roleBytes).digest('hex'),
    intendedReceiptSha256: '0'.repeat(64),
    previousRegistration: { present: true, value: roleConfig(ctx.paths.rolePath) },
    previousMetadata: { present: true, value: false },
    previousAdditional: [],
    desiredAdditional: [],
  })}\n`);
  let error;
  await assert.rejects(reconcileManagedRescueRole({
    ...common(ctx, current), batchWrite: async () => ({}), readConfig: async () => current,
  }), (candidate) => { error = candidate; return candidate?.code === 'MANAGED_ROLE_ROLLBACK_INCOMPLETE'; });
  assert.equal(error.details.rolePath, ctx.paths.rolePath);
  assert.equal(error.details.receiptPath, ctx.paths.receiptPath);
  assert.equal(error.details.configPath, ctx.configTarget.filePath);
  assert.equal(error.details.transactionPath, ctx.paths.transactionPath);
  assert.match(error.remedy, /restore.*remove.*transaction.*\$zcode:setup/is);
  assert.deepEqual(await readFile(ctx.paths.receiptPath), foreignReceipt);
  assert.equal((await stat(ctx.paths.transactionPath)).isFile(), true);
});

test('managed Rescue role reports exact recovery paths for unproven interrupted Role bytes', async () => {
  const ctx = await fixture();
  await mkdir(join(ctx.dataRoot, 'agent-roles'), { recursive: true });
  await writeFile(ctx.paths.rolePath, 'foreign-after-crash');
  await writeFile(ctx.paths.transactionPath, `${JSON.stringify({
    schemaVersion: 1, phase: 'role-written', rolePath: ctx.paths.rolePath,
    roleExisted: false, receiptExisted: false, intendedSha256: '0'.repeat(64),
    previousRegistration: { present: false }, previousMetadata: { present: false }, previousAdditional: [], desiredAdditional: [],
  })}\n`);
  let error;
  await assert.rejects(reconcileManagedRescueRole({
    ...common(ctx, configState({})), batchWrite: async () => ({}), readConfig: async () => configState({}),
  }), (candidate) => { error = candidate; return true; });
  assert.equal(error.details.rolePath, ctx.paths.rolePath);
  assert.equal(error.details.receiptPath, ctx.paths.receiptPath);
  assert.equal(error.details.configPath, ctx.configTarget.filePath);
  assert.equal(error.details.transactionPath, ctx.paths.transactionPath);
  assert.ok(error.details.remaining.includes(ctx.paths.rolePath));
  assert.ok(error.details.remaining.includes(ctx.paths.transactionPath));
  assert.match(error.remedy, /restore.*remove.*transaction.*\$zcode:setup/is);
});

test('managed Rescue role reports precise recovery for a malformed transaction journal', async () => {
  const ctx = await fixture();
  await mkdir(join(ctx.dataRoot, 'agent-roles'), { recursive: true });
  await writeFile(ctx.paths.transactionPath, '{"schemaVersion":99}\n');
  let error;
  await assert.rejects(reconcileManagedRescueRole({
    ...common(ctx, configState({})), batchWrite: async () => ({}), readConfig: async () => configState({}),
  }), (candidate) => { error = candidate; return candidate?.code === 'MANAGED_ROLE_ROLLBACK_INCOMPLETE'; });
  assert.equal(error.details.rolePath, ctx.paths.rolePath);
  assert.equal(error.details.receiptPath, ctx.paths.receiptPath);
  assert.equal(error.details.configPath, ctx.configTarget.filePath);
  assert.equal(error.details.transactionPath, ctx.paths.transactionPath);
  assert.deepEqual(error.details.remaining, [ctx.paths.transactionPath]);
  assert.match(error.remedy, /restore.*remove.*transaction.*\$zcode:setup/is);
  assert.equal((await stat(ctx.paths.transactionPath)).isFile(), true);
});

test('managed Rescue role rejects malformed additional journal entries without touching recovery evidence', async (t) => {
  const cases = [
    { name: 'empty previous entry', previousAdditional: [{}], desiredAdditional: [] },
    { name: 'undefined desired key', previousAdditional: [], desiredAdditional: [{ value: true }] },
    { name: 'control key', previousAdditional: [], desiredAdditional: [{ keyPath: 'features.hooks\nforeign', value: true }] },
    { name: 'duplicate key', previousAdditional: [], desiredAdditional: [{ keyPath: 'features.hooks', value: true }, { keyPath: 'features.hooks', value: false }] },
    { name: 'too many entries', previousAdditional: [], desiredAdditional: [{ keyPath: 'features.hooks', value: true }, { keyPath: 'hooks.state', value: {} }, { keyPath: 'features.hooks', value: false }] },
    { name: 'unpersistable desired value', previousAdditional: [], desiredAdditional: [{ keyPath: 'features.hooks', value: undefined }] },
    { name: 'missing present value', previousAdditional: [{ keyPath: 'features.hooks', present: true }], desiredAdditional: [] },
    { name: 'value on absent previous leaf', previousAdditional: [{ keyPath: 'features.hooks', present: false, value: false }], desiredAdditional: [] },
    { name: 'unexpected previous key', previousAdditional: [{ keyPath: 'features.hooks', present: false, extra: true }], desiredAdditional: [] },
  ];
  for (const entry of cases) await t.test(entry.name, async () => {
    const ctx = await fixture();
    await mkdir(join(ctx.dataRoot, 'agent-roles'), { recursive: true });
    await writeFile(ctx.paths.rolePath, 'partial');
    await writeFile(ctx.paths.transactionPath, `${JSON.stringify({
      schemaVersion: 1, phase: 'role-written', rolePath: ctx.paths.rolePath,
      roleExisted: false, receiptExisted: false,
      intendedSha256: createHash('sha256').update('partial').digest('hex'),
      previousRegistration: { present: false }, previousMetadata: { present: false },
      previousAdditional: entry.previousAdditional, desiredAdditional: entry.desiredAdditional,
    })}\n`);
    let writes = 0;
    let error;
    await assert.rejects(reconcileManagedRescueRole({
      ...common(ctx, configState({})), batchWrite: async () => { writes += 1; return {}; }, readConfig: async () => configState({}),
    }), (candidate) => { error = candidate; return candidate?.code === 'MANAGED_ROLE_ROLLBACK_INCOMPLETE'; });
    assert.equal(writes, 0);
    assert.equal(error.details.transactionPath, ctx.paths.transactionPath);
    assert.deepEqual(error.details.remaining, [ctx.paths.transactionPath]);
    assert.equal(await readFile(ctx.paths.rolePath, 'utf8'), 'partial');
    assert.equal((await stat(ctx.paths.transactionPath)).isFile(), true);
  });
});
