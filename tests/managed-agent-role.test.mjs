// @ts-nocheck
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { atomicWritePrivateFile } from '../scripts/lib/fs.mjs';
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

function configState({ path, role, metadata = false, layers, errors = [] }) {
  const config = {
    agents: role === undefined ? {} : { [MANAGED_ROLE_NAME]: role },
    features: { hooks: true, multi_agent_v2: { hide_spawn_agent_metadata: metadata } },
  };
  return {
    config,
    errors,
    layers: layers ?? [{ name: { type: 'user', file: '/config.toml' }, version: 'v1', config }],
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
  assert.deepEqual(Object.keys(receipt).sort(), ['configTarget', 'plugin', 'priorSpawnMetadataValue', 'role', 'roleName', 'schemaVersion'].sort());
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

test('managed Rescue role does not roll back config for a journal that never reached config mutation', async () => {
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
  }), { code: 'MANAGED_ROLE_CONFLICT' });
  assert.equal(writes, 0);
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

test('managed Rescue role recovers an interrupted owned transaction before retrying', async () => {
  const ctx = await fixture();
  await mkdir(join(ctx.dataRoot, 'agent-roles'), { recursive: true });
  await writeFile(ctx.paths.rolePath, 'partial');
  await writeFile(ctx.paths.transactionPath, `${JSON.stringify({
    schemaVersion: 1,
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
  await assert.rejects(reconcileManagedRescueRole({
    ...common(ctx, current), batchWrite: async () => ({}), readConfig: async () => current,
  }), { code: 'MANAGED_ROLE_ROLLBACK_INCOMPLETE' });
  assert.deepEqual(await readFile(ctx.paths.receiptPath), foreignReceipt);
  assert.equal((await stat(ctx.paths.transactionPath)).isFile(), true);
});
