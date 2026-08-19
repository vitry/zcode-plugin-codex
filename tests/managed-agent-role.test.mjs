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
  MANAGED_ROLE_RECEIPT_SCHEMA_VERSION,
  MANAGED_ROLE_SCHEMA_VERSION,
  inspectManagedRescueRole,
  managedRolePaths,
  reconcileManagedRescueRole,
  renderManagedRescueRole,
} from '../scripts/lib/managed-agent-role.mjs';

const template = `developer_instructions = """
Root={{RESCUE_LAUNCHER_COMMAND}}
Again={{RESCUE_LAUNCHER_COMMAND}}
Last={{RESCUE_LAUNCHER_COMMAND}}
Status={{RESCUE_LAUNCHER_COMMAND}}
"""
`;

function roleConfig(path) {
  return { description: MANAGED_ROLE_DESCRIPTION, config_file: path };
}

function metadataAfterEdits(previous, edits) {
  let value = previous;
  for (const edit of edits) {
    if (edit.keyPath !== 'features.multi_agent_v2.hide_spawn_agent_metadata') continue;
    value = edit.value === null ? undefined : edit.value;
  }
  return value;
}

function configState({ path, role, metadata, layers, errors = [], version = 'v1' }) {
  const config = {
    agents: role === undefined ? {} : { [MANAGED_ROLE_NAME]: role },
    features: { hooks: true, multi_agent_v2: {} },
  };
  if (metadata !== undefined) config.features.multi_agent_v2.hide_spawn_agent_metadata = metadata;
  return {
    config,
    errors,
    layers: layers ?? [{ name: { type: 'user', file: '/config.toml' }, version, config }],
    origins: path ? { [`agents.${MANAGED_ROLE_NAME}`]: '/config.toml' } : {},
  };
}

function layeredMetadataState(ctx, { targetMetadata, effectiveMetadata, targetVersion = 'v1' }) {
  const targetConfig = {
    agents: { [MANAGED_ROLE_NAME]: roleConfig(ctx.paths.rolePath) },
    features: { multi_agent_v2: {} },
  };
  if (targetMetadata !== undefined) targetConfig.features.multi_agent_v2.hide_spawn_agent_metadata = targetMetadata;
  return configState({
    role: roleConfig(ctx.paths.rolePath),
    metadata: effectiveMetadata,
    layers: [
      { name: { type: 'user', file: '/config.toml' }, version: targetVersion, config: targetConfig },
      { name: { type: 'project', file: '/repo/.codex/config.toml' }, version: 'p1', config: { features: { multi_agent_v2: { hide_spawn_agent_metadata: effectiveMetadata } } } },
    ],
  });
}

async function writeOwnedReceipt(ctx, {
  schemaVersion = 1,
  roleBytes = Buffer.from(renderManagedRescueRole({ template, pluginRoot: ctx.pluginRoot })),
  pluginIdentity = 'zcode@vitry',
  pluginVersion = '0.1.0',
  pluginRoot = ctx.pluginRoot,
  roleDigest = createHash('sha256').update(roleBytes).digest('hex'),
  configFilePath = ctx.configTarget.filePath,
  mutatedAt = '2025-01-01T00:00:00.000Z',
  priorSpawnMetadataValue,
} = {}) {
  await mkdir(join(ctx.dataRoot, 'agent-roles'), { recursive: true });
  await writeFile(ctx.paths.rolePath, roleBytes);
  const receipt = {
    schemaVersion,
    roleName: MANAGED_ROLE_NAME,
    plugin: { identity: pluginIdentity, version: pluginVersion, root: pluginRoot },
    configTarget: { filePath: configFilePath },
    role: { path: ctx.paths.rolePath, schemaVersion: MANAGED_ROLE_SCHEMA_VERSION, sha256: roleDigest },
    mutatedAt,
    ...(priorSpawnMetadataValue === undefined ? {} : { priorSpawnMetadataValue }),
  };
  await writeFile(ctx.paths.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  return { receipt, receiptBytes: await readFile(ctx.paths.receiptPath), roleBytes };
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
  assert.equal(MANAGED_ROLE_RECEIPT_SCHEMA_VERSION, '1.0.0');
  assert.equal(MANAGED_ROLE_DESCRIPTION, 'Runs the fixed ZCode Rescue forwarder in an isolated Codex subagent.');
  assert.deepEqual(ctx.paths, {
    rolePath: join(ctx.dataRoot, 'agent-roles', 'zcode-rescue.toml'),
    receiptPath: join(ctx.dataRoot, 'agent-roles', 'zcode-rescue.receipt.json'),
    transactionPath: join(ctx.dataRoot, 'agent-roles', 'zcode-rescue.transaction.json'),
    lockPath: join(ctx.dataRoot, 'agent-roles', 'lock'),
  });
  assert.doesNotMatch(ctx.paths.rolePath, /cache|0\.1\.0/);
});

test('installed Rescue Role consumes only a previously prepared task-blind invocation', async () => {
  const source = await readFile(new URL('../agents/zcode-rescue.toml.template', import.meta.url), 'utf8');
  assert.match(source, /Run the installed prepared ZCode Rescue forwarder now/);
  assert.match(source, /invoke-prepared rescue/);
  assert.doesNotMatch(source, /invoke rescue(?:\s|$)/m);
  assert.doesNotMatch(source, /\{\{(?:TASK|SOURCE|OPTIONS|ARGS|JOB|SESSION|WORKSPACE|PERMISSION|CAPABILITY)[^}]*\}\}/i);
  assert.match(source, /task-blind/i);
  assert.match(source, /capability-free/i);
  assert.match(source, /same exact prepared assignment[\s\S]+initial turn[\s\S]+stopped same-child prepared continuation/i);
  assert.match(source, /one-command-per-turn rule applies to both/i);
  assert.match(source, /assignment alone does not prove the sender or binding/i);
  assert.match(source, /companion command[\s\S]+validates the exact executor and private binding/i);
  assert.match(source, /non-exact assignment[\s\S]+arbitrary message[\s\S]+nested Rescue[\s\S]+independent repository work/i);
});

test('owned previous Role bytes require one upgrade before exact continuation Role is ready', async () => {
  const ctx = await fixture();
  const currentTemplate = await readFile(new URL('../agents/zcode-rescue.toml.template', import.meta.url), 'utf8');
  const addedContract = [
    'The same exact prepared assignment is valid for either the initial turn or a stopped same-child prepared continuation selected by the parent. The one-command-per-turn rule applies to both. The assignment alone does not prove the sender or binding: run only its mapped companion command, which validates the exact executor and private binding before work starts.',
    'Reject every non-exact assignment, arbitrary message, nested Rescue request, and independent repository work without running a command.',
  ].join('\n');
  const previousTemplate = currentTemplate.replace(`${addedContract}\n\n`, '')
    .replaceAll('{{RESCUE_LAUNCHER_COMMAND}}', 'node "{{PLUGIN_ROOT}}/scripts/zcode-companion.mjs"');
  assert.notEqual(previousTemplate, currentTemplate, 'the Task 3 Role must add an exact prepared-continuation contract');
  assert.equal(createHash('sha256').update(previousTemplate).digest('hex'), 'efc7f28226dcbab083fa99bea581debc0a16d5251b026b72b3392d59e3991aac');
  const previousBytes = Buffer.from(previousTemplate.replaceAll('{{PLUGIN_ROOT}}', JSON.stringify(ctx.pluginRoot).slice(1, -1)));
  await writeOwnedReceipt(ctx, { schemaVersion: '1.0.0', roleBytes: previousBytes });
  const config = configState({ role: roleConfig(ctx.paths.rolePath) });
  assert.equal((await inspectManagedRescueRole({ ...common(ctx, config), template: currentTemplate })).status, 'upgrade-required');
  let writes = 0;
  let activations = 0;
  const upgraded = await reconcileManagedRescueRole({
    ...common(ctx, config), template: currentTemplate,
    batchWrite: async () => { writes += 1; return {}; }, readConfig: async () => config,
    activate: async () => { activations += 1; },
  });
  assert.equal(upgraded.status, 'ready'); assert.equal(upgraded.changed, true); assert.equal(writes, 1); assert.equal(activations, 1);
  assert.deepEqual(await readFile(ctx.paths.rolePath), Buffer.from(renderManagedRescueRole({ template: currentTemplate, pluginRoot: ctx.pluginRoot })));
  assert.equal((await inspectManagedRescueRole({ ...common(ctx, config), template: currentTemplate })).status, 'ready');
});

test('managed Rescue role renders only one validated machine launcher command', () => {
  const unix = renderManagedRescueRole({ template, pluginRoot: '/opt/ZCode active' });
  assert.equal(unix, template.replaceAll('{{RESCUE_LAUNCHER_COMMAND}}', 'node \\"/opt/ZCode active/skills/rescue/launcher.mjs\\"'));
  const windows = renderManagedRescueRole({ template, pluginRoot: 'C:\\Users\\me\\ZCode' });
  assert.match(windows, /node \\"C:\\\\Users\\\\me\\\\ZCode\\\\skills\\\\rescue\\\\launcher\.mjs\\"/);
  for (const pluginRoot of ['/opt/ZCode "active"', '/opt/$(touch PWNED)', '/opt/`touch PWNED`', '/opt/slash\\']) {
    assert.throws(() => renderManagedRescueRole({ template, pluginRoot }), { code: 'MANAGED_ROLE_ROOT_INVALID' });
  }
  assert.throws(() => renderManagedRescueRole({ template: `${template} task={{TASK}}`, pluginRoot: '/opt/zcode' }), { code: 'MANAGED_ROLE_TEMPLATE_INVALID' });
  assert.throws(() => renderManagedRescueRole({ template: template.replace('Status={{RESCUE_LAUNCHER_COMMAND}}\n', ''), pluginRoot: '/opt/zcode' }), { code: 'MANAGED_ROLE_TEMPLATE_INVALID' });
  assert.throws(() => renderManagedRescueRole({ template: template.replace('Status={{RESCUE_LAUNCHER_COMMAND}}', 'Status={{RESCUE_LAUNCHER_COMMAND}}\nExtra={{RESCUE_LAUNCHER_COMMAND}}'), pluginRoot: '/opt/zcode' }), { code: 'MANAGED_ROLE_TEMPLATE_INVALID' });
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

test('managed Rescue role fresh install writes only the Role registration and returns ready', async () => {
  const ctx = await fixture();
  let current = configState({});
  let writtenEdits;
  const result = await reconcileManagedRescueRole({
    ...common(ctx, current),
    batchWrite: async (params) => {
      writtenEdits = params.edits;
      current = configState({ path: ctx.paths.rolePath, role: roleConfig(ctx.paths.rolePath), metadata: metadataAfterEdits(undefined, params.edits) });
      return { version: 'v2' };
    },
    readConfig: async () => current,
  });
  assert.deepEqual(result, { status: 'ready', changed: true, rolePath: ctx.paths.rolePath });
  assert.deepEqual(writtenEdits, [
    { keyPath: `agents.${MANAGED_ROLE_NAME}`, value: roleConfig(ctx.paths.rolePath), mergeStrategy: 'upsert' },
  ]);
  assert.equal(await readFile(ctx.paths.rolePath, 'utf8'), renderManagedRescueRole({ template, pluginRoot: ctx.pluginRoot }));
  const receipt = JSON.parse(await readFile(ctx.paths.receiptPath, 'utf8'));
  assert.equal(receipt.schemaVersion, '1.0.0');
  assert.equal(Object.hasOwn(receipt, 'priorSpawnMetadataValue'), false);
  assert.deepEqual(receipt.plugin, { identity: 'zcode@vitry', version: '0.1.0', root: ctx.pluginRoot });
  assert.equal(receipt.role.path, ctx.paths.rolePath);
  assert.match(receipt.role.sha256, /^[a-f0-9]{64}$/);
  await assert.rejects(readFile(ctx.paths.transactionPath), { code: 'ENOENT' });
});

test('managed Rescue role runs activation before receipt commit with the verified config version', async () => {
  const ctx = await fixture();
  let current = configState({});
  let activation;
  const result = await reconcileManagedRescueRole({
    ...common(ctx, current),
    batchWrite: async (params) => {
      current = configState({ role: roleConfig(ctx.paths.rolePath), version: 'v2' });
      return { filePath: params.filePath, version: 'v2' };
    },
    readConfig: async () => current,
    activate: async (context) => {
      activation = context;
      await assert.rejects(readFile(ctx.paths.receiptPath), { code: 'ENOENT' });
    },
  });
  assert.deepEqual(result, { status: 'ready', changed: true, rolePath: ctx.paths.rolePath });
  assert.equal(activation.config, current);
  assert.deepEqual(activation.writeResult, { filePath: '/config.toml', version: 'v2' });
  assert.deepEqual(activation.configTarget, { filePath: '/config.toml', expectedVersion: 'v1' });
  assert.equal(activation.selectedVersion, 'v2');
});

test('managed Rescue role migrates an exact numeric-v1 legacy install and deletes only its target false leaf', async () => {
  const ctx = await fixture();
  await writeOwnedReceipt(ctx, { priorSpawnMetadataValue: true });
  let current = configState({ role: roleConfig(ctx.paths.rolePath), metadata: false });
  let writtenEdits;
  const result = await reconcileManagedRescueRole({
    ...common(ctx, current),
    batchWrite: async (params) => {
      writtenEdits = params.edits;
      current = configState({ role: roleConfig(ctx.paths.rolePath), version: 'v2' });
      return { version: 'v2' };
    },
    readConfig: async () => current,
  });
  assert.deepEqual(result, { status: 'ready', changed: true, rolePath: ctx.paths.rolePath });
  assert.deepEqual(writtenEdits, [
    { keyPath: 'features.multi_agent_v2.hide_spawn_agent_metadata', value: null, mergeStrategy: 'upsert' },
    { keyPath: `agents.${MANAGED_ROLE_NAME}`, value: roleConfig(ctx.paths.rolePath), mergeStrategy: 'upsert' },
  ]);
  const receipt = JSON.parse(await readFile(ctx.paths.receiptPath, 'utf8'));
  const { mutatedAt, ...stableReceipt } = receipt;
  assert.equal(typeof mutatedAt, 'string');
  assert.equal(Number.isFinite(Date.parse(mutatedAt)), true);
  assert.equal(new Date(mutatedAt).toISOString(), mutatedAt);
  assert.deepEqual(stableReceipt, {
    schemaVersion: '1.0.0',
    roleName: MANAGED_ROLE_NAME,
    plugin: { identity: 'zcode@vitry', version: '0.1.0', root: ctx.pluginRoot },
    configTarget: { filePath: ctx.configTarget.filePath },
    role: {
      path: ctx.paths.rolePath,
      schemaVersion: MANAGED_ROLE_SCHEMA_VERSION,
      sha256: createHash('sha256').update(renderManagedRescueRole({ template, pluginRoot: ctx.pluginRoot })).digest('hex'),
    },
  });
  await assert.rejects(readFile(ctx.paths.transactionPath), { code: 'ENOENT' });
});

test('managed Rescue role migrates numeric-v1 with an absent target leaf without a metadata edit', async () => {
  const ctx = await fixture();
  await writeOwnedReceipt(ctx);
  let current = configState({ role: roleConfig(ctx.paths.rolePath) });
  let writtenEdits;
  const result = await reconcileManagedRescueRole({
    ...common(ctx, current), batchWrite: async (params) => {
      writtenEdits = params.edits;
      current = configState({ role: roleConfig(ctx.paths.rolePath), version: 'v2' });
      return { version: 'v2' };
    }, readConfig: async () => current,
  });
  assert.deepEqual(result, { status: 'ready', changed: true, rolePath: ctx.paths.rolePath });
  assert.deepEqual(writtenEdits, [
    { keyPath: `agents.${MANAGED_ROLE_NAME}`, value: roleConfig(ctx.paths.rolePath), mergeStrategy: 'upsert' },
  ]);
  assert.equal(JSON.parse(await readFile(ctx.paths.receiptPath, 'utf8')).schemaVersion, '1.0.0');
});

test('managed Rescue role fails closed when numeric-v1 target metadata drifted true', async () => {
  const ctx = await fixture();
  const { receiptBytes, roleBytes } = await writeOwnedReceipt(ctx, { priorSpawnMetadataValue: false });
  const current = configState({ role: roleConfig(ctx.paths.rolePath), metadata: true });
  let writes = 0;
  await assert.rejects(reconcileManagedRescueRole({
    ...common(ctx, current), batchWrite: async () => { writes += 1; return {}; }, readConfig: async () => current,
  }), { code: 'MANAGED_ROLE_CONFLICT' });
  assert.equal(writes, 0);
  assert.deepEqual(await readFile(ctx.paths.rolePath), roleBytes);
  assert.deepEqual(await readFile(ctx.paths.receiptPath), receiptBytes);
  await assert.rejects(readFile(ctx.paths.transactionPath), { code: 'ENOENT' });
});

test('managed Rescue role migration authorizes only the exact target-layer false leaf', async (t) => {
  await t.test('target false and effective true deletes the target leaf', async () => {
    const ctx = await fixture();
    await writeOwnedReceipt(ctx, { priorSpawnMetadataValue: true });
    let current = layeredMetadataState(ctx, { targetMetadata: false, effectiveMetadata: true });
    assert.equal(current.layers[0].name.file, '/config.toml');
    assert.equal(current.layers[0].config.features.multi_agent_v2.hide_spawn_agent_metadata, false);
    assert.equal(current.layers[1].config.features.multi_agent_v2.hide_spawn_agent_metadata, true);
    assert.equal(current.config.features.multi_agent_v2.hide_spawn_agent_metadata, true);
    let writtenEdits;
    const result = await reconcileManagedRescueRole({
      ...common(ctx, current),
      batchWrite: async (params) => {
        writtenEdits = params.edits;
        current = layeredMetadataState(ctx, { targetMetadata: undefined, effectiveMetadata: true, targetVersion: 'v2' });
        return { version: 'v2' };
      },
      readConfig: async () => current,
    });
    assert.deepEqual(result, { status: 'ready', changed: true, rolePath: ctx.paths.rolePath });
    assert.deepEqual(writtenEdits, [
      { keyPath: 'features.multi_agent_v2.hide_spawn_agent_metadata', value: null, mergeStrategy: 'upsert' },
      { keyPath: `agents.${MANAGED_ROLE_NAME}`, value: roleConfig(ctx.paths.rolePath), mergeStrategy: 'upsert' },
    ]);
  });

  await t.test('target true and effective false fails closed', async () => {
    const ctx = await fixture();
    const before = await writeOwnedReceipt(ctx, { priorSpawnMetadataValue: false });
    const current = layeredMetadataState(ctx, { targetMetadata: true, effectiveMetadata: false });
    assert.equal(current.layers[0].name.file, '/config.toml');
    assert.equal(current.layers[0].config.features.multi_agent_v2.hide_spawn_agent_metadata, true);
    assert.equal(current.layers[1].config.features.multi_agent_v2.hide_spawn_agent_metadata, false);
    assert.equal(current.config.features.multi_agent_v2.hide_spawn_agent_metadata, false);
    let writes = 0;
    await assert.rejects(reconcileManagedRescueRole({
      ...common(ctx, current),
      batchWrite: async () => { writes += 1; return {}; },
      readConfig: async () => current,
    }), { code: 'MANAGED_ROLE_CONFLICT' });
    assert.equal(writes, 0);
    assert.deepEqual(await readFile(ctx.paths.rolePath), before.roleBytes);
    assert.deepEqual(await readFile(ctx.paths.receiptPath), before.receiptBytes);
    await assert.rejects(readFile(ctx.paths.transactionPath), { code: 'ENOENT' });
  });
});

test('managed Rescue role fresh install never edits unrelated host metadata', async (t) => {
  for (const metadata of [false, true]) await t.test(String(metadata), async () => {
    const ctx = await fixture();
    let current = configState({ metadata });
    let writtenEdits;
    const result = await reconcileManagedRescueRole({
      ...common(ctx, current), batchWrite: async (params) => {
        writtenEdits = params.edits;
        current = configState({ role: roleConfig(ctx.paths.rolePath), metadata: metadataAfterEdits(metadata, params.edits), version: 'v2' });
        return { version: 'v2' };
      }, readConfig: async () => current,
    });
    assert.deepEqual(result, { status: 'ready', changed: true, rolePath: ctx.paths.rolePath });
    assert.equal(writtenEdits.some((edit) => edit.keyPath === 'features.multi_agent_v2.hide_spawn_agent_metadata'), false);
  });
});

test('managed Rescue role current receipt is ready regardless of effective host metadata', async (t) => {
  for (const metadata of [undefined, false, true]) await t.test(metadata === undefined ? 'absent' : String(metadata), async () => {
    const ctx = await fixture();
    await writeOwnedReceipt(ctx, { schemaVersion: '1.0.0' });
    const current = configState({ role: roleConfig(ctx.paths.rolePath), metadata });
    assert.equal((await inspectManagedRescueRole(common(ctx, current))).status, 'ready');
    const result = await reconcileManagedRescueRole({
      ...common(ctx, current), batchWrite: async () => { throw new Error('must not write'); }, readConfig: async () => current,
    });
    assert.deepEqual(result, { status: 'ready', changed: false, rolePath: ctx.paths.rolePath });
  });
});

test('managed Rescue role current receipt ignores equal and later mutation watermarks', async (t) => {
  const sessionStartedAt = '2025-01-01T00:00:00.000Z';
  for (const mutatedAt of [sessionStartedAt, '2025-01-01T00:00:01.000Z']) await t.test(mutatedAt, async () => {
    const ctx = await fixture();
    await writeOwnedReceipt(ctx, { schemaVersion: '1.0.0', mutatedAt });
    const current = configState({ role: roleConfig(ctx.paths.rolePath) });
    const input = { ...common(ctx, current), sessionStartedAt };
    assert.equal((await inspectManagedRescueRole(input)).status, 'ready');
    assert.deepEqual(await reconcileManagedRescueRole({
      ...input,
      batchWrite: async () => { throw new Error('must not write'); },
      readConfig: async () => current,
    }), { status: 'ready', changed: false, rolePath: ctx.paths.rolePath });
  });
});

test('managed Rescue role reports drift for missing receipt, modified file, digest, or registration', async (t) => {
  const ctx = await fixture();
  await mkdir(join(ctx.dataRoot, 'agent-roles'), { recursive: true });
  await writeFile(ctx.paths.rolePath, renderManagedRescueRole({ template, pluginRoot: ctx.pluginRoot }));
  const config = configState({ role: roleConfig(ctx.paths.rolePath) });
  assert.equal((await inspectManagedRescueRole(common(ctx, config))).status, 'drift');
  await unlink(ctx.paths.rolePath);

  await writeOwnedReceipt(ctx, { schemaVersion: '1.0.0' });
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

test('managed Rescue role classifies a numeric-v1 owned receipt as upgrade-required', async () => {
  const ctx = await fixture();
  await writeOwnedReceipt(ctx);
  const current = configState({ role: roleConfig(ctx.paths.rolePath), metadata: false });
  assert.equal((await inspectManagedRescueRole(common(ctx, current))).status, 'upgrade-required');
});

test('managed Rescue role rejects selected-layer registration extras even when effective registration is normalized', async () => {
  const ctx = await fixture();
  const seeded = await writeOwnedReceipt(ctx, { schemaVersion: '1.0.0' });
  const selected = { ...roleConfig(ctx.paths.rolePath), foreign: true };
  const current = configState({
    role: { ...roleConfig(ctx.paths.rolePath), nickname_candidates: null },
    layers: [{
      name: { type: 'user', file: '/config.toml' }, version: 'v1',
      config: { agents: { [MANAGED_ROLE_NAME]: selected }, features: { multi_agent_v2: { hide_spawn_agent_metadata: false } } },
    }],
  });
  assert.equal((await inspectManagedRescueRole(common(ctx, current))).status, 'drift');
  let writes = 0;
  await assert.rejects(reconcileManagedRescueRole({
    ...common(ctx, current), batchWrite: async () => { writes += 1; return {}; }, readConfig: async () => current,
  }), { code: 'MANAGED_ROLE_CONFLICT' });
  assert.equal(writes, 0);
  assert.deepEqual(await readFile(ctx.paths.rolePath), seeded.roleBytes);
  assert.deepEqual(await readFile(ctx.paths.receiptPath), seeded.receiptBytes);
});

test('managed Rescue role rejects non-exact receipt schemas and legacy fields', async (t) => {
  const ctx = await fixture();
  const current = configState({ role: roleConfig(ctx.paths.rolePath), metadata: false });
  for (const schemaVersion of [0, 2, '1', '1.0', '1.0.1', '1.1.0', '2.0.0']) await t.test(`schema ${schemaVersion}`, async () => {
    await writeOwnedReceipt(ctx, { schemaVersion });
    assert.equal((await inspectManagedRescueRole(common(ctx, current))).status, 'drift');
  });
  await t.test('current receipt with legacy prior metadata field', async () => {
    await writeOwnedReceipt(ctx, { schemaVersion: '1.0.0', priorSpawnMetadataValue: false });
    assert.equal((await inspectManagedRescueRole(common(ctx, current))).status, 'drift');
  });
  await t.test('numeric-v1 receipt with non-boolean prior metadata field', async () => {
    await writeOwnedReceipt(ctx, { priorSpawnMetadataValue: 'false' });
    assert.equal((await inspectManagedRescueRole(common(ctx, current))).status, 'drift');
  });
});

test('managed Rescue role treats a changed selected config target as drift', async () => {
  const ctx = await fixture();
  await writeOwnedReceipt(ctx, { schemaVersion: '1.0.0' });
  const current = configState({ role: roleConfig(ctx.paths.rolePath) });
  const changedTarget = { ...common(ctx, current), configTarget: { filePath: '/other-config.toml', expectedVersion: 'other-v1' } };
  assert.equal((await inspectManagedRescueRole(changedTarget)).status, 'drift');
});

test('managed Rescue role never cleans metadata without exact numeric-v1 ownership proof', async (t) => {
  const cases = [
    {
      name: 'malformed receipt',
      prepare: async (ctx) => {
        await writeOwnedReceipt(ctx);
        await writeFile(ctx.paths.receiptPath, '{not-json');
        return configState({ role: roleConfig(ctx.paths.rolePath), metadata: false });
      },
    },
    {
      name: 'foreign receipt',
      prepare: async (ctx) => {
        await writeOwnedReceipt(ctx, { pluginIdentity: 'foreign@owner' });
        return configState({ role: roleConfig(ctx.paths.rolePath), metadata: false });
      },
    },
    {
      name: 'wrong digest',
      prepare: async (ctx) => {
        await writeOwnedReceipt(ctx, { roleDigest: '0'.repeat(64) });
        return configState({ role: roleConfig(ctx.paths.rolePath), metadata: false });
      },
    },
    {
      name: 'project shadow',
      prepare: async (ctx) => {
        await writeOwnedReceipt(ctx);
        return configState({ role: roleConfig('/project.toml'), metadata: false, layers: [
          { name: { type: 'user', file: '/config.toml' }, version: 'v1', config: { agents: { [MANAGED_ROLE_NAME]: roleConfig(ctx.paths.rolePath) }, features: { multi_agent_v2: { hide_spawn_agent_metadata: false } } } },
          { name: { type: 'project', file: '/repo/.codex/config.toml' }, version: 'p1', config: { agents: { [MANAGED_ROLE_NAME]: roleConfig('/project.toml') } } },
        ] });
      },
    },
    {
      name: 'foreign registration',
      prepare: async (ctx) => {
        await writeOwnedReceipt(ctx);
        return configState({ role: roleConfig('/foreign.toml'), metadata: false });
      },
    },
  ];
  for (const entry of cases) await t.test(entry.name, async () => {
    const ctx = await fixture();
    const current = await entry.prepare(ctx);
    const roleBefore = await readFile(ctx.paths.rolePath);
    const receiptBefore = await readFile(ctx.paths.receiptPath);
    let writes = 0;
    await assert.rejects(reconcileManagedRescueRole({
      ...common(ctx, current), batchWrite: async () => { writes += 1; return {}; }, readConfig: async () => current,
    }), { code: 'MANAGED_ROLE_CONFLICT' });
    assert.equal(writes, 0);
    assert.deepEqual(await readFile(ctx.paths.rolePath), roleBefore);
    assert.deepEqual(await readFile(ctx.paths.receiptPath), receiptBefore);
  });
});

test('managed Rescue role migration rolls back exact numeric-v1 state after post-write verification failure', async () => {
  const ctx = await fixture();
  const beforeFiles = await writeOwnedReceipt(ctx, { priorSpawnMetadataValue: true });
  const legacy = configState({ role: roleConfig(ctx.paths.rolePath), metadata: false });
  let current = legacy;
  const writes = [];
  await assert.rejects(reconcileManagedRescueRole({
    ...common(ctx, legacy),
    batchWrite: async (params) => {
      writes.push(params);
      if (writes.length === 1) {
        const targetConfig = { agents: { [MANAGED_ROLE_NAME]: roleConfig(ctx.paths.rolePath) }, features: { multi_agent_v2: {} } };
        current = configState({ role: roleConfig('/project.toml'), layers: [
          { name: { type: 'user', file: '/config.toml' }, version: 'v2', config: targetConfig },
          { name: { type: 'project', file: '/repo/.codex/config.toml' }, version: 'p1', config: { agents: { [MANAGED_ROLE_NAME]: roleConfig('/project.toml') } } },
        ] });
      } else current = configState({ role: roleConfig(ctx.paths.rolePath), metadata: false, version: 'v3' });
      return { version: `v${writes.length + 1}` };
    },
    readConfig: async () => current,
  }), { code: 'MANAGED_ROLE_RECONCILE_FAILED' });
  assert.equal(writes.length, 2);
  assert.deepEqual(writes[1].edits, [
    { keyPath: `agents.${MANAGED_ROLE_NAME}`, value: roleConfig(ctx.paths.rolePath), mergeStrategy: 'upsert' },
    { keyPath: 'features.multi_agent_v2.hide_spawn_agent_metadata', value: false, mergeStrategy: 'upsert' },
  ]);
  assert.deepEqual(await readFile(ctx.paths.rolePath), beforeFiles.roleBytes);
  assert.deepEqual(await readFile(ctx.paths.receiptPath), beforeFiles.receiptBytes);
  assert.equal(JSON.parse(await readFile(ctx.paths.receiptPath, 'utf8')).schemaVersion, 1);
  await assert.rejects(readFile(ctx.paths.transactionPath), { code: 'ENOENT' });
});

test('managed Rescue role migration rolls back exact numeric-v1 state after receipt commit failure', async () => {
  const ctx = await fixture();
  const beforeFiles = await writeOwnedReceipt(ctx, { priorSpawnMetadataValue: false });
  const legacy = configState({ role: roleConfig(ctx.paths.rolePath), metadata: false });
  let current = legacy;
  const writes = [];
  await assert.rejects(reconcileManagedRescueRole({
    ...common(ctx, legacy),
    batchWrite: async (params) => {
      writes.push(params);
      current = writes.length === 1
        ? configState({ role: roleConfig(ctx.paths.rolePath), version: 'v2' })
        : configState({ role: roleConfig(ctx.paths.rolePath), metadata: false, version: 'v3' });
      return { version: `v${writes.length + 1}` };
    },
    readConfig: async () => current,
    beforeReceiptCommit: async () => {
      const journal = JSON.parse(await readFile(ctx.paths.transactionPath, 'utf8'));
      assert.equal(journal.schemaVersion, 2);
      assert.equal(journal.deletesLegacyMetadata, true);
      assert.deepEqual(journal.previousMetadata, { present: true, value: false });
      throw new Error('forced receipt commit failure');
    },
  }), { code: 'MANAGED_ROLE_RECONCILE_FAILED' });
  assert.equal(writes.length, 2);
  assert.deepEqual(writes[1].edits, [
    { keyPath: `agents.${MANAGED_ROLE_NAME}`, value: roleConfig(ctx.paths.rolePath), mergeStrategy: 'upsert' },
    { keyPath: 'features.multi_agent_v2.hide_spawn_agent_metadata', value: false, mergeStrategy: 'upsert' },
  ]);
  assert.deepEqual(await readFile(ctx.paths.rolePath), beforeFiles.roleBytes);
  assert.deepEqual(await readFile(ctx.paths.receiptPath), beforeFiles.receiptBytes);
  await assert.rejects(readFile(ctx.paths.transactionPath), { code: 'ENOENT' });
});

test('managed Rescue role activation failure restores exact legacy state before a successful retry', async () => {
  const ctx = await fixture();
  const before = await writeOwnedReceipt(ctx, { priorSpawnMetadataValue: true });
  let current = configState({ role: roleConfig(ctx.paths.rolePath), metadata: false });
  let writes = 0;
  await assert.rejects(reconcileManagedRescueRole({
    ...common(ctx, current),
    batchWrite: async () => {
      writes += 1;
      current = writes === 1
        ? configState({ role: roleConfig(ctx.paths.rolePath), version: 'v2' })
        : configState({ role: roleConfig(ctx.paths.rolePath), metadata: false, version: 'v3' });
      return { filePath: '/config.toml', version: `v${writes + 1}` };
    },
    readConfig: async () => current,
    activate: async () => { throw new Error('activation failed'); },
  }), { code: 'MANAGED_ROLE_RECONCILE_FAILED' });
  assert.equal(writes, 2);
  assert.deepEqual(await readFile(ctx.paths.rolePath), before.roleBytes);
  assert.deepEqual(await readFile(ctx.paths.receiptPath), before.receiptBytes);
  assert.equal(current.config.features.multi_agent_v2.hide_spawn_agent_metadata, false);
  await assert.rejects(readFile(ctx.paths.transactionPath), { code: 'ENOENT' });

  const retry = await reconcileManagedRescueRole({
    ...common(ctx, current), configTarget: { filePath: '/config.toml', expectedVersion: 'v3' },
    batchWrite: async () => {
      writes += 1;
      current = configState({ role: roleConfig(ctx.paths.rolePath), version: 'v4' });
      return { filePath: '/config.toml', version: 'v4' };
    },
    readConfig: async () => current,
    activate: async () => {},
  });
  assert.deepEqual(retry, { status: 'ready', changed: true, rolePath: ctx.paths.rolePath });
  assert.equal(JSON.parse(await readFile(ctx.paths.receiptPath, 'utf8')).schemaVersion, '1.0.0');
});

test('managed Rescue role preserves evidence unless rollback write is reread as the exact previous state', async (t) => {
  for (const kind of ['no-op', 'partial', 'malformed']) await t.test(kind, async () => {
    const ctx = await fixture();
    await writeOwnedReceipt(ctx, { priorSpawnMetadataValue: true });
    let current = configState({ role: roleConfig(ctx.paths.rolePath), metadata: false });
    let writes = 0;
    await assert.rejects(reconcileManagedRescueRole({
      ...common(ctx, current),
      batchWrite: async () => {
        writes += 1;
        if (writes === 1) {
          current = configState({ role: roleConfig(ctx.paths.rolePath), version: 'v2' });
          return { filePath: '/config.toml', version: 'v2' };
        }
        if (kind === 'partial') current = configState({ metadata: false, version: 'v3' });
        return kind === 'malformed' ? {} : { filePath: '/config.toml', version: 'v3' };
      },
      readConfig: async () => current,
      activate: async () => { throw new Error('activation failed'); },
    }), { code: 'MANAGED_ROLE_ROLLBACK_INCOMPLETE' });
    assert.equal(writes, 2);
    assert.equal((await stat(ctx.paths.transactionPath)).isFile(), true);
    assert.equal((await stat(ctx.paths.rolePath)).isFile(), true);
    assert.equal((await stat(ctx.paths.receiptPath)).isFile(), true);
  });
});

test('managed Rescue role classifies selected-layer state after a successful but ineffective batch', async (t) => {
  await t.test('exact no-op restores files without a config rollback and permits a normal retry', async () => {
    const ctx = await fixture();
    const before = await writeOwnedReceipt(ctx, { priorSpawnMetadataValue: true });
    let current = configState({ role: roleConfig(ctx.paths.rolePath), metadata: false });
    let writes = 0;
    await assert.rejects(reconcileManagedRescueRole({
      ...common(ctx, current),
      batchWrite: async () => {
        writes += 1;
        current = configState({ role: roleConfig(ctx.paths.rolePath), metadata: false, version: 'v2' });
        return { version: 'v2' };
      },
      readConfig: async () => current,
    }), { code: 'MANAGED_ROLE_RECONCILE_FAILED' });
    assert.equal(writes, 1);
    assert.equal(JSON.parse(await readFile(ctx.paths.receiptPath, 'utf8')).schemaVersion, 1);
    assert.deepEqual(await readFile(ctx.paths.rolePath), before.roleBytes);
    assert.deepEqual(await readFile(ctx.paths.receiptPath), before.receiptBytes);
    await assert.rejects(readFile(ctx.paths.transactionPath), { code: 'ENOENT' });

    const retry = await reconcileManagedRescueRole({
      ...common(ctx, current),
      configTarget: { ...ctx.configTarget, expectedVersion: 'v2' },
      batchWrite: async (params) => {
        writes += 1;
        current = configState({ role: roleConfig(ctx.paths.rolePath), version: 'v3' });
        return { version: 'v3', edits: params.edits };
      },
      readConfig: async () => current,
    });
    assert.equal(writes, 2);
    assert.deepEqual(retry, { status: 'ready', changed: true, rolePath: ctx.paths.rolePath });
    assert.equal(JSON.parse(await readFile(ctx.paths.receiptPath, 'utf8')).schemaVersion, '1.0.0');
  });

  await t.test('partial write preserves recovery evidence', async () => {
    const ctx = await fixture();
    let current = configState({});
    await assert.rejects(reconcileManagedRescueRole({
      ...common(ctx, current),
      additionalEdits: [{ keyPath: 'hooks.state', value: { trusted: true }, mergeStrategy: 'upsert' }],
      batchWrite: async () => {
        current = configState({ role: roleConfig(ctx.paths.rolePath), version: 'v2' });
        return { version: 'v2' };
      },
      readConfig: async () => current,
    }), { code: 'MANAGED_ROLE_ROLLBACK_INCOMPLETE' });
    await assert.rejects(readFile(ctx.paths.receiptPath), { code: 'ENOENT' });
    assert.equal((await stat(ctx.paths.transactionPath)).isFile(), true);
  });
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
  assert.equal(Object.hasOwn(JSON.parse(await readFile(ctx.paths.transactionPath, 'utf8')), 'deletesLegacyMetadata'), false);
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
  const markerMode = (await stat(marker)).mode & 0o777;
  await mkdir(join(ctx.dataRoot, 'agent-roles'));
  await symlink(outside, ctx.paths.lockPath);
  assert.equal((await inspectManagedRescueRole(common(ctx, configState({})))).status, 'unsupported');
  await assert.rejects(reconcileManagedRescueRole({
    ...common(ctx, configState({})), batchWrite: async () => ({}), readConfig: async () => configState({}),
  }), { code: 'MANAGED_ROLE_PATH_UNSAFE' });
  assert.equal(await readFile(marker, 'utf8'), 'outside-safe');
  assert.equal((await stat(marker)).mode & 0o777, markerMode);
});

test('managed Rescue role rejects a symlinked advisory lock file without touching its target', async () => {
  const ctx = await fixture();
  const outside = join(await realpath(await mkdtemp(join(tmpdir(), 'zcode-lock-file-outside-'))), 'outside.lock');
  await writeFile(outside, 'outside-lock', { mode: 0o644 });
  const outsideMode = (await stat(outside)).mode & 0o777;
  await mkdir(ctx.paths.lockPath, { recursive: true });
  await symlink(outside, join(ctx.paths.lockPath, 'advisory.lock'));
  assert.equal((await inspectManagedRescueRole(common(ctx, configState({})))).status, 'unsupported');
  await assert.rejects(reconcileManagedRescueRole({
    ...common(ctx, configState({})), batchWrite: async () => ({}), readConfig: async () => configState({}),
  }), { code: 'MANAGED_ROLE_PATH_UNSAFE' });
  assert.equal(await readFile(outside, 'utf8'), 'outside-lock');
  assert.equal((await stat(outside)).mode & 0o777, outsideMode);
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
  const outsideMode = (await stat(outside)).mode & 0o777;
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
  assert.equal((await stat(outside)).mode & 0o777, outsideMode);
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
        current = configState({ role: roleConfig(ctx.paths.rolePath), metadata: metadataAfterEdits(undefined, params.edits), version: 'v2' });
        throw Object.assign(new Error('response lost after commit'), { code: 'CODEX_CONFIG_REQUEST_FAILED' });
      }
      current = configState({ version: 'v3' });
      return { version: 'v3' };
    },
    readConfig: async () => current,
  }), { code: 'MANAGED_ROLE_RECONCILE_FAILED' });
  assert.equal(writes.length, 2);
  assert.equal(writes[1].expectedVersion, 'v2');
  assert.deepEqual(writes[1].edits, [
    { keyPath: `agents.${MANAGED_ROLE_NAME}`, value: null, mergeStrategy: 'upsert' },
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
  const journal = JSON.parse(await readFile(ctx.paths.transactionPath, 'utf8'));
  assert.equal(journal.schemaVersion, 2);
  assert.equal(journal.deletesLegacyMetadata, false);
  assert.equal(Object.hasOwn(journal, 'previousMetadata'), false);
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
    } else if (prior === 'undefined') {
      current.config.features.hooks = undefined;
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
    ...common(ctx, current), batchWrite: async (params) => { current = configState({ role: roleConfig(ctx.paths.rolePath), metadata: metadataAfterEdits(undefined, params.edits) }); return {}; }, readConfig: async () => current,
  });
  assert.equal(result.status, 'ready');
  assert.notEqual(await readFile(ctx.paths.rolePath, 'utf8'), 'partial');
  await assert.rejects(readFile(ctx.paths.transactionPath), { code: 'ENOENT' });
});

test('managed Rescue role recovers numeric-v1 interrupted journal previousMetadata exactly', async () => {
  const ctx = await fixture();
  const seeded = await writeOwnedReceipt(ctx, { priorSpawnMetadataValue: true });
  await writeFile(ctx.paths.transactionPath, `${JSON.stringify({
    schemaVersion: 1,
    phase: 'config-written',
    rolePath: ctx.paths.rolePath,
    roleExisted: true,
    previousRoleBase64: seeded.roleBytes.toString('base64'),
    receiptExisted: true,
    previousReceiptBase64: seeded.receiptBytes.toString('base64'),
    intendedSha256: createHash('sha256').update(seeded.roleBytes).digest('hex'),
    previousRegistration: { present: true, value: roleConfig(ctx.paths.rolePath) },
    previousMetadata: { present: true, value: true },
    previousAdditional: [],
    desiredAdditional: [],
    configVersion: 'v2',
  })}\n`);
  let current = configState({ role: roleConfig(ctx.paths.rolePath), metadata: false, version: 'v2' });
  let rollback;
  await assert.rejects(reconcileManagedRescueRole({
    ...common(ctx, current),
    batchWrite: async (params) => {
      rollback = params;
      current = configState({ role: roleConfig(ctx.paths.rolePath), metadata: true, version: 'v3' });
      return { version: 'v3' };
    },
    readConfig: async () => current,
  }), { code: 'MANAGED_ROLE_CONFLICT' });
  assert.equal(rollback.expectedVersion, 'v2');
  assert.deepEqual(rollback.edits, [
    { keyPath: `agents.${MANAGED_ROLE_NAME}`, value: roleConfig(ctx.paths.rolePath), mergeStrategy: 'upsert' },
    { keyPath: 'features.multi_agent_v2.hide_spawn_agent_metadata', value: true, mergeStrategy: 'upsert' },
  ]);
  assert.deepEqual(await readFile(ctx.paths.rolePath), seeded.roleBytes);
  assert.deepEqual(await readFile(ctx.paths.receiptPath), seeded.receiptBytes);
  await assert.rejects(readFile(ctx.paths.transactionPath), { code: 'ENOENT' });
});

test('managed Rescue role rolls back with the CAS version from the verified current snapshot', async () => {
  const ctx = await fixture();
  const seeded = await writeOwnedReceipt(ctx, { priorSpawnMetadataValue: true });
  await writeFile(ctx.paths.transactionPath, `${JSON.stringify({
    schemaVersion: 1,
    phase: 'config-written',
    rolePath: ctx.paths.rolePath,
    roleExisted: true,
    previousRoleBase64: seeded.roleBytes.toString('base64'),
    receiptExisted: true,
    previousReceiptBase64: seeded.receiptBytes.toString('base64'),
    intendedSha256: createHash('sha256').update(seeded.roleBytes).digest('hex'),
    previousRegistration: { present: true, value: roleConfig(ctx.paths.rolePath) },
    previousMetadata: { present: true, value: true },
    previousAdditional: [],
    desiredAdditional: [],
    configVersion: 'v2',
  })}\n`);
  let current = configState({ role: roleConfig(ctx.paths.rolePath), metadata: false, version: 'v3' });
  let rollback;
  await assert.rejects(reconcileManagedRescueRole({
    ...common(ctx, current),
    batchWrite: async (params) => {
      rollback = params;
      current = configState({ role: roleConfig(ctx.paths.rolePath), metadata: true, version: 'v4' });
      return { version: 'v4' };
    },
    readConfig: async () => current,
  }), { code: 'MANAGED_ROLE_CONFLICT' });
  assert.equal(rollback.expectedVersion, 'v3');
  assert.deepEqual(await readFile(ctx.paths.rolePath), seeded.roleBytes);
  assert.deepEqual(await readFile(ctx.paths.receiptPath), seeded.receiptBytes);
  await assert.rejects(readFile(ctx.paths.transactionPath), { code: 'ENOENT' });
});

test('managed Rescue role accepts a valid schema-v2 legacy-deletion journal and resumes migration', async () => {
  const ctx = await fixture();
  const seeded = await writeOwnedReceipt(ctx, { priorSpawnMetadataValue: true });
  await writeFile(ctx.paths.transactionPath, `${JSON.stringify({
    schemaVersion: 2,
    phase: 'config-written',
    rolePath: ctx.paths.rolePath,
    roleExisted: true,
    previousRoleBase64: seeded.roleBytes.toString('base64'),
    receiptExisted: true,
    previousReceiptBase64: seeded.receiptBytes.toString('base64'),
    intendedSha256: createHash('sha256').update(seeded.roleBytes).digest('hex'),
    previousRegistration: { present: true, value: roleConfig(ctx.paths.rolePath) },
    deletesLegacyMetadata: true,
    previousMetadata: { present: true, value: false },
    previousAdditional: [],
    desiredAdditional: [],
    configVersion: 'v2',
  })}\n`);
  let current = configState({ role: roleConfig(ctx.paths.rolePath), version: 'v2' });
  const writes = [];
  const result = await reconcileManagedRescueRole({
    ...common(ctx, current),
    batchWrite: async (params) => {
      writes.push(params);
      current = writes.length === 1
        ? configState({ role: roleConfig(ctx.paths.rolePath), metadata: false, version: 'v3' })
        : configState({ role: roleConfig(ctx.paths.rolePath), version: 'v4' });
      return { version: `v${writes.length + 2}` };
    },
    readConfig: async () => current,
  });
  assert.deepEqual(writes.map((write) => write.expectedVersion), ['v2', 'v3']);
  assert.deepEqual(writes[0].edits.at(-1), {
    keyPath: 'features.multi_agent_v2.hide_spawn_agent_metadata', value: false, mergeStrategy: 'upsert',
  });
  assert.deepEqual(result, { status: 'ready', changed: true, rolePath: ctx.paths.rolePath });
  assert.equal(JSON.parse(await readFile(ctx.paths.receiptPath, 'utf8')).schemaVersion, '1.0.0');
  await assert.rejects(readFile(ctx.paths.transactionPath), { code: 'ENOENT' });
});

test('managed Rescue role classifies a config-written no-op as not applied and retries without rollback config writes', async () => {
  const ctx = await fixture();
  const seeded = await writeOwnedReceipt(ctx, { priorSpawnMetadataValue: true });
  await writeFile(ctx.paths.transactionPath, `${JSON.stringify({
    schemaVersion: 2,
    phase: 'config-written',
    rolePath: ctx.paths.rolePath,
    roleExisted: true,
    previousRoleBase64: seeded.roleBytes.toString('base64'),
    receiptExisted: true,
    previousReceiptBase64: seeded.receiptBytes.toString('base64'),
    intendedSha256: createHash('sha256').update(seeded.roleBytes).digest('hex'),
    previousRegistration: { present: true, value: roleConfig(ctx.paths.rolePath) },
    deletesLegacyMetadata: true,
    previousMetadata: { present: true, value: false },
    previousAdditional: [],
    desiredAdditional: [],
    configVersion: 'v2',
  })}\n`);
  let current = configState({ role: roleConfig(ctx.paths.rolePath), metadata: false, version: 'v2' });
  const writes = [];
  const result = await reconcileManagedRescueRole({
    ...common(ctx, current),
    batchWrite: async (params) => {
      writes.push(params);
      current = configState({ role: roleConfig(ctx.paths.rolePath), version: 'v3' });
      return { version: 'v3' };
    },
    readConfig: async () => current,
  });
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].edits, [
    { keyPath: 'features.multi_agent_v2.hide_spawn_agent_metadata', value: null, mergeStrategy: 'upsert' },
    { keyPath: `agents.${MANAGED_ROLE_NAME}`, value: roleConfig(ctx.paths.rolePath), mergeStrategy: 'upsert' },
  ]);
  assert.deepEqual(result, { status: 'ready', changed: true, rolePath: ctx.paths.rolePath });
  assert.equal(JSON.parse(await readFile(ctx.paths.receiptPath, 'utf8')).schemaVersion, '1.0.0');
  await assert.rejects(readFile(ctx.paths.transactionPath), { code: 'ENOENT' });
});

test('managed Rescue role preserves an interrupted config-written journal for mixed selected-layer state', async () => {
  const ctx = await fixture();
  const roleBytes = Buffer.from(renderManagedRescueRole({ template, pluginRoot: ctx.pluginRoot }));
  await mkdir(join(ctx.dataRoot, 'agent-roles'), { recursive: true });
  await writeFile(ctx.paths.rolePath, roleBytes);
  await writeFile(ctx.paths.transactionPath, `${JSON.stringify({
    schemaVersion: 2,
    phase: 'config-written',
    rolePath: ctx.paths.rolePath,
    roleExisted: false,
    receiptExisted: false,
    intendedSha256: createHash('sha256').update(roleBytes).digest('hex'),
    previousRegistration: { present: false },
    deletesLegacyMetadata: false,
    previousAdditional: [{ keyPath: 'hooks.state', present: false }],
    desiredAdditional: [{ keyPath: 'hooks.state', value: { trusted: true } }],
    configVersion: 'v2',
  })}\n`);
  const current = configState({ role: roleConfig(ctx.paths.rolePath), version: 'v2' });
  let writes = 0;
  await assert.rejects(reconcileManagedRescueRole({
    ...common(ctx, current),
    batchWrite: async () => { writes += 1; return {}; },
    readConfig: async () => current,
  }), { code: 'MANAGED_ROLE_ROLLBACK_INCOMPLETE' });
  assert.equal(writes, 0);
  assert.deepEqual(await readFile(ctx.paths.rolePath), roleBytes);
  assert.equal((await stat(ctx.paths.transactionPath)).isFile(), true);
});

test('managed Rescue role refreshes config and CAS version after old-journal recovery before migration', async () => {
  const ctx = await fixture();
  const seeded = await writeOwnedReceipt(ctx, { priorSpawnMetadataValue: true });
  await writeFile(ctx.paths.transactionPath, `${JSON.stringify({
    schemaVersion: 1,
    phase: 'config-written',
    rolePath: ctx.paths.rolePath,
    roleExisted: true,
    previousRoleBase64: seeded.roleBytes.toString('base64'),
    receiptExisted: true,
    previousReceiptBase64: seeded.receiptBytes.toString('base64'),
    intendedSha256: createHash('sha256').update(seeded.roleBytes).digest('hex'),
    previousRegistration: { present: true, value: roleConfig(ctx.paths.rolePath) },
    previousMetadata: { present: true, value: false },
    previousAdditional: [],
    desiredAdditional: [],
    configVersion: 'v2',
  })}\n`);
  let current = configState({ role: roleConfig(ctx.paths.rolePath), metadata: false, version: 'v2' });
  const expectedVersions = [];
  const result = await reconcileManagedRescueRole({
    ...common(ctx, current),
    batchWrite: async (params) => {
      expectedVersions.push(params.expectedVersion);
      if (expectedVersions.length === 1) {
        current = configState({ role: roleConfig(ctx.paths.rolePath), metadata: false, version: 'v3' });
        return { version: 'v3' };
      }
      current = configState({ role: roleConfig(ctx.paths.rolePath), version: 'v4' });
      return { version: 'v4' };
    },
    readConfig: async () => current,
  });
  assert.deepEqual(expectedVersions, ['v2', 'v3']);
  assert.deepEqual(result, { status: 'ready', changed: true, rolePath: ctx.paths.rolePath });
  assert.equal(JSON.parse(await readFile(ctx.paths.receiptPath, 'utf8')).schemaVersion, '1.0.0');
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
  let current = configState({ role: roleConfig(ctx.paths.rolePath), metadata: false, version: 'v2' });
  const expectedVersions = [];
  const result = await reconcileManagedRescueRole({
    ...common(ctx, current),
    batchWrite: async (params) => {
      expectedVersions.push(params.expectedVersion);
      if (expectedVersions.length === 1) {
        current = configState({ version: 'v3' });
        return { version: 'v3' };
      }
      current = configState({ role: roleConfig(ctx.paths.rolePath), version: 'v4' });
      return { version: 'v4' };
    },
    readConfig: async () => current,
  });
  assert.deepEqual(expectedVersions, ['v2', 'v3']);
  assert.deepEqual(result, { status: 'ready', changed: true, rolePath: ctx.paths.rolePath });
  assert.equal(JSON.parse(await readFile(ctx.paths.receiptPath, 'utf8')).schemaVersion, '1.0.0');
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
  const seeded = await writeOwnedReceipt(ctx, { pluginVersion: '0.0.9', priorSpawnMetadataValue: true });
  let current = configState({ role: roleConfig(ctx.paths.rolePath), metadata: false });
  const previousRole = seeded.roleBytes;
  const previousReceipt = seeded.receiptBytes;
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
    batchWrite: async (params) => { current = configState({ role: roleConfig(ctx.paths.rolePath), metadata: metadataAfterEdits(current.config.features.multi_agent_v2.hide_spawn_agent_metadata, params.edits), version: 'v2' }); return { version: 'v2' }; }, readConfig: async () => current,
  });
  assert.equal(result.status, 'ready');
  assert.equal(JSON.parse(await readFile(ctx.paths.receiptPath, 'utf8')).plugin.root, nextPluginRoot);
});

test('managed Rescue role rolls back config after a crash with a journaled receipt watermark before retrying', async () => {
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
  let current = configState({ role: roleConfig(ctx.paths.rolePath), metadata: false });
  const expectedVersions = [];
  const result = await reconcileManagedRescueRole({
    ...common(ctx, current),
    batchWrite: async (params) => {
      expectedVersions.push(params.expectedVersion);
      if (expectedVersions.length === 1) {
        current = configState({ version: 'v2' });
        return { version: 'v2' };
      }
      current = configState({ role: roleConfig(ctx.paths.rolePath), version: 'v3' });
      return { version: 'v3' };
    },
    readConfig: async () => current,
  });
  assert.deepEqual(expectedVersions, ['v1', 'v2']);
  assert.deepEqual(result, { status: 'ready', changed: true, rolePath: ctx.paths.rolePath });
  assert.equal(JSON.parse(await readFile(ctx.paths.receiptPath, 'utf8')).schemaVersion, '1.0.0');
  await assert.rejects(readFile(ctx.paths.transactionPath), { code: 'ENOENT' });
});

test('managed Rescue role restores previous receipt bytes when receipt-prepared intended bytes already exist', async () => {
  const ctx = await fixture();
  const seeded = await writeOwnedReceipt(ctx, { priorSpawnMetadataValue: true });
  const intendedReceiptBytes = Buffer.from('{"schemaVersion":"1.0.0","committed":true}\n');
  await writeFile(ctx.paths.receiptPath, intendedReceiptBytes);
  await writeFile(ctx.paths.transactionPath, `${JSON.stringify({
    schemaVersion: 1,
    phase: 'receipt-prepared',
    rolePath: ctx.paths.rolePath,
    roleExisted: true,
    previousRoleBase64: seeded.roleBytes.toString('base64'),
    receiptExisted: true,
    previousReceiptBase64: seeded.receiptBytes.toString('base64'),
    intendedSha256: createHash('sha256').update(seeded.roleBytes).digest('hex'),
    intendedReceiptSha256: createHash('sha256').update(intendedReceiptBytes).digest('hex'),
    intendedReceiptBase64: intendedReceiptBytes.toString('base64'),
    previousRegistration: { present: true, value: roleConfig(ctx.paths.rolePath) },
    previousMetadata: { present: true, value: true },
    previousAdditional: [],
    desiredAdditional: [],
    configVersion: 'v2',
  })}\n`);
  let current = configState({ role: roleConfig(ctx.paths.rolePath), metadata: false, version: 'v2' });
  let rollbackWrites = 0;
  await assert.rejects(reconcileManagedRescueRole({
    ...common(ctx, current),
    batchWrite: async () => {
      rollbackWrites += 1;
      current = configState({ role: roleConfig(ctx.paths.rolePath), metadata: true, version: 'v3' });
      return { version: 'v3' };
    },
    readConfig: async () => current,
  }), { code: 'MANAGED_ROLE_CONFLICT' });
  assert.equal(rollbackWrites, 1);
  assert.deepEqual(await readFile(ctx.paths.receiptPath), seeded.receiptBytes);
  await assert.rejects(readFile(ctx.paths.transactionPath), { code: 'ENOENT' });
});

test('managed Rescue role preserves an unproven receipt during interrupted rollback', async () => {
  const ctx = await fixture();
  const seeded = await writeOwnedReceipt(ctx, { schemaVersion: '1.0.0' });
  const current = configState({ role: roleConfig(ctx.paths.rolePath) });
  const roleBytes = seeded.roleBytes;
  const previousReceipt = seeded.receiptBytes;
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

test('managed Rescue role rejects a schema-v1 metadata intent without touching recovery evidence', async () => {
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
    deletesLegacyMetadata: true,
    previousMetadata: { present: false },
    previousAdditional: [],
    desiredAdditional: [],
  })}\n`);
  let writes = 0;
  await assert.rejects(reconcileManagedRescueRole({
    ...common(ctx, configState({})),
    batchWrite: async () => { writes += 1; return {}; },
    readConfig: async () => configState({}),
  }), { code: 'MANAGED_ROLE_ROLLBACK_INCOMPLETE' });
  assert.equal(writes, 0);
  assert.equal(await readFile(ctx.paths.rolePath, 'utf8'), 'partial');
  assert.equal((await stat(ctx.paths.transactionPath)).isFile(), true);
});

test('managed Rescue role rejects schema-v2 metadata authority that is not bound to exact numeric-v1 ownership', async (t) => {
  const cases = [
    { name: 'missing explicit intent', mutate: (journal) => { delete journal.deletesLegacyMetadata; } },
    { name: 'false intent with previous metadata', mutate: (journal) => { journal.deletesLegacyMetadata = false; } },
    { name: 'arbitrary restore value', mutate: (journal) => { journal.previousMetadata.value = true; } },
    { name: 'foreign plugin receipt', mutate: (journal, receipt) => { receipt.plugin.identity = 'foreign@owner'; journal.previousReceiptBase64 = Buffer.from(`${JSON.stringify(receipt)}\n`).toString('base64'); } },
    { name: 'different config target', mutate: (journal, receipt) => { receipt.configTarget.filePath = '/other.toml'; journal.previousReceiptBase64 = Buffer.from(`${JSON.stringify(receipt)}\n`).toString('base64'); } },
    { name: 'different role digest', mutate: (journal, receipt) => { receipt.role.sha256 = '0'.repeat(64); journal.previousReceiptBase64 = Buffer.from(`${JSON.stringify(receipt)}\n`).toString('base64'); } },
    { name: 'different previous role bytes', mutate: (journal) => { journal.previousRoleBase64 = Buffer.from('foreign role').toString('base64'); } },
    { name: 'non-exact previous registration', mutate: (journal) => { journal.previousRegistration.value.description = 'foreign'; } },
  ];
  for (const entry of cases) await t.test(entry.name, async () => {
    const ctx = await fixture();
    const seeded = await writeOwnedReceipt(ctx, { priorSpawnMetadataValue: true });
    const receipt = structuredClone(seeded.receipt);
    const journal = {
      schemaVersion: 2,
      phase: 'role-written',
      rolePath: ctx.paths.rolePath,
      roleExisted: true,
      previousRoleBase64: seeded.roleBytes.toString('base64'),
      receiptExisted: true,
      previousReceiptBase64: seeded.receiptBytes.toString('base64'),
      intendedSha256: createHash('sha256').update(seeded.roleBytes).digest('hex'),
      previousRegistration: { present: true, value: roleConfig(ctx.paths.rolePath) },
      deletesLegacyMetadata: true,
      previousMetadata: { present: true, value: false },
      previousAdditional: [],
      desiredAdditional: [],
    };
    entry.mutate(journal, receipt);
    await writeFile(ctx.paths.transactionPath, `${JSON.stringify(journal)}\n`);
    let writes = 0;
    await assert.rejects(reconcileManagedRescueRole({
      ...common(ctx, configState({ role: roleConfig(ctx.paths.rolePath), metadata: false })),
      batchWrite: async () => { writes += 1; return {}; },
      readConfig: async () => configState({ role: roleConfig(ctx.paths.rolePath), metadata: false }),
    }), { code: 'MANAGED_ROLE_ROLLBACK_INCOMPLETE' });
    assert.equal(writes, 0);
    assert.deepEqual(await readFile(ctx.paths.rolePath), seeded.roleBytes);
    assert.equal((await stat(ctx.paths.transactionPath)).isFile(), true);
  });
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
