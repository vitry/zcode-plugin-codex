// @ts-nocheck
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, realpath, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { spawn } from 'node:child_process';

import { parseArgs } from '../scripts/lib/args.mjs';
import { diagnoseZCodeAuth, pluginRootFromModuleUrl, runSetup } from '../scripts/lib/codex-config.mjs';
import { resolveWorkspaceStorage } from '../scripts/lib/workspace.mjs';
import { runCompanion } from '../scripts/zcode-companion.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const fakeCodex = join(root, 'tests/fixtures/fake-codex-app-server.mjs');
const fakeZCode = join(root, 'tests/fixtures/fake-zcode-cli.mjs');

test('setup arguments are strict, unique and mutually exclusive', () => {
  assert.deepEqual(parseArgs(['setup']), { command: 'setup', options: {}, positionals: [] });
  assert.deepEqual(parseArgs(['setup', '--enable-review-gate']), { command: 'setup', options: { reviewGate: true }, positionals: [] });
  assert.deepEqual(parseArgs(['setup', '--disable-review-gate']), { command: 'setup', options: { reviewGate: false }, positionals: [] });
  for (const args of [['setup', '--enable-review-gate', '--disable-review-gate'], ['setup', '--enable-review-gate', '--enable-review-gate'], ['setup', '--bad'], ['setup', 'extra']]) assert.throws(() => parseArgs(args), { code: 'ARGUMENT_INVALID' });
});

function hookMetadata(rootPath, trustStatus = 'untrusted', pluginId = 'zcode@vitry') {
  const events = ['sessionStart', 'userPromptSubmit', 'subagentStart', 'subagentStop', 'stop', 'sessionEnd'];
  const scripts = ['session-lifecycle-hook.mjs', 'user-prompt-hook.mjs', 'subagent-hook.mjs', 'subagent-hook.mjs', 'stop-review-gate-hook.mjs', 'session-end-hook.mjs'];
  return events.map((eventName, index) => ({ key: `plugin-hook-${index}`, currentHash: `${index}`.repeat(64), displayOrder: index, enabled: true, eventName, handlerType: 'command', isManaged: false, source: 'plugin', sourcePath: join(rootPath, 'hooks/hooks.json'), timeoutSec: eventName === 'stop' ? 900 : 5, trustStatus, pluginId, command: `node "$PLUGIN_ROOT/hooks/${scripts[index]}"` }));
}

async function context({ hooks = hookMetadata(root), features = { hooks: false }, zcodeEnv = {}, codexEnv = {} } = {}) {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'zpc-setup-workspace-'))); const dataRoot = await mkdtemp(join(tmpdir(), 'zpc-setup-data-')); const record = join(dataRoot, 'codex-requests.jsonl'); const zcodeRecord = join(dataRoot, 'zcode-requests.jsonl'); await writeFile(record, ''); await writeFile(zcodeRecord, '');
  const writable = { sandbox_workspace_write: { writable_roots: [dataRoot] } };
  const configResult = { config: { features, unrelated: { preserved: true }, ...writable }, origins: {}, layers: [{ name: { type: 'user', file: join(dataRoot, 'config.toml') }, version: 'version-1', config: { unrelated: { preserved: true }, ...writable } }] };
  const hooksResult = { data: [{ cwd, errors: [], warnings: [], hooks }] };
  return { cwd, dataRoot, record, zcodeRecord, options: { pluginRoot: root, dataRoot, cwd, reviewGate: undefined, env: { ...process.env, ZCODE_PATH: fakeZCode, FAKE_ZCODE_RECORD: zcodeRecord, FAKE_CODEX_RECORD: record, FAKE_CODEX_CONFIG_RESULT: JSON.stringify(configResult), FAKE_CODEX_HOOKS_RESULT: JSON.stringify(hooksResult), ...zcodeEnv, ...codexEnv }, codex: { executable: process.execPath, args: [fakeCodex], timeoutMs: 1_000 } } };
}

test('setup uses current config/read, hooks/list and one atomic exact trust/features batch write', async () => {
  const ctx = await context(); const report = await runSetup({ ...ctx.options, reviewGate: true });
  assert.equal(report.status, 'restart-required', JSON.stringify(report)); assert.equal(report.zcode.version, '0.16.1'); assert.equal(report.auth.ready, true); assert.equal(report.reviewGate.enabled, true);
  const calls = (await readFile(ctx.record, 'utf8')).trim().split('\n').map(JSON.parse).filter((call) => call.method);
  assert.deepEqual(calls.map((call) => call.method), ['initialize', 'initialized', 'config/read', 'hooks/list', 'config/batchWrite']);
  assert.deepEqual(calls[2].params, { cwd: ctx.cwd, includeLayers: true }); assert.deepEqual(calls[3].params, { cwds: [ctx.cwd] });
  const params = calls[4].params; assert.equal(params.expectedVersion, 'version-1'); assert.equal(params.reloadUserConfig, true); assert.equal(params.edits.length, 2);
  assert.deepEqual(params.edits[0], { keyPath: 'features.hooks', value: true, mergeStrategy: 'upsert' });
  assert.equal(params.edits[1].keyPath, 'hooks.state'); assert.equal(params.edits[1].mergeStrategy, 'upsert');
  assert.deepEqual(Object.keys(params.edits[1].value), ['plugin-hook-0', 'plugin-hook-1', 'plugin-hook-2', 'plugin-hook-3', 'plugin-hook-4', 'plugin-hook-5']);
  assert.deepEqual(params.edits[1].value['plugin-hook-0'], { trusted_hash: '0'.repeat(64) });
  assert.doesNotMatch(JSON.stringify(params), /plugin_hooks/); assert.doesNotMatch(JSON.stringify(params), /unrelated/);
  const storage = await resolveWorkspaceStorage({ dataRoot: ctx.dataRoot, workspace: ctx.cwd }); const gate = JSON.parse(await readFile(join(storage.directory, 'config/review-gate.json'), 'utf8')); assert.deepEqual(gate, { version: 1, enabled: true, setupReady: true, status: 'restart-required' });
});

test('already enabled and trusted hooks report ready without config writes', async () => {
  const ctx = await context({ hooks: hookMetadata(root, 'trusted'), features: { hooks: true } }); const report = await runSetup(ctx.options);
  assert.equal(report.status, 'ready'); const calls = (await readFile(ctx.record, 'utf8')).trim().split('\n').map(JSON.parse); assert.ok(!calls.some((call) => call.method === 'config/batchWrite'));
  const zcodeCalls = (await readFile(ctx.zcodeRecord, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); assert.deepEqual(zcodeCalls.map((call) => call.method), ['session/create', 'session/stop']);
});

test('setup bootstraps an absent writable plugin-data root before writing workspace state', async () => {
  const ctx = await context({ hooks: hookMetadata(root, 'trusted'), features: { hooks: true } });
  const dataRoot = join(ctx.dataRoot, 'codex-home', 'plugins', 'data', 'zcode-vitry');
  const configResult = {
    config: { features: { hooks: true }, sandbox_workspace_write: { writable_roots: ['/existing/root'] } },
    origins: {},
    layers: [{ name: { type: 'user', file: join(ctx.dataRoot, 'config.toml') }, version: 'version-1', config: {} }],
  };
  const configuredResult = { ...configResult, config: { ...configResult.config, sandbox_workspace_write: { writable_roots: ['/existing/root', dataRoot] } }, layers: [{ ...configResult.layers[0], version: 'version-2', config: { sandbox_workspace_write: { writable_roots: [dataRoot] } } }] };
  const report = await runSetup({ ...ctx.options, dataRoot, env: { ...ctx.options.env, FAKE_CODEX_CONFIG_RESULTS_JSON: JSON.stringify([configResult, configuredResult]) } });
  assert.equal(report.status, 'restart-required');
  const calls = (await readFile(ctx.record, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse).filter((call) => call.method);
  const batch = calls.find((call) => call.method === 'config/batchWrite');
  assert.deepEqual(batch.params.edits, [{ keyPath: 'sandbox_workspace_write.writable_roots', value: [dataRoot], mergeStrategy: 'replace' }]);
  const storage = await resolveWorkspaceStorage({ dataRoot, workspace: ctx.cwd });
  await assert.rejects(readFile(join(storage.directory, 'config', 'review-gate.json')), { code: 'ENOENT' });
});

test('setup preserves user writable roots without globalizing effective project roots', async () => {
  const ctx = await context({ hooks: hookMetadata(root, 'trusted'), features: { hooks: true } });
  const dataRoot = join(ctx.dataRoot, 'stable-plugin-data');
  const before = { config: { sandbox_workspace_write: { writable_roots: ['/project-only'] } }, origins: {}, layers: [{ name: { type: 'user', file: join(ctx.dataRoot, 'config.toml') }, version: 'version-1', config: { sandbox_workspace_write: { writable_roots: ['/user-only'] } } }] };
  const after = { ...before, config: { sandbox_workspace_write: { writable_roots: ['/project-only', dataRoot] } }, layers: [{ ...before.layers[0], version: 'version-2', config: { sandbox_workspace_write: { writable_roots: ['/user-only', dataRoot] } } }] };
  const report = await runSetup({ ...ctx.options, dataRoot, env: { ...ctx.options.env, FAKE_CODEX_CONFIG_RESULTS_JSON: JSON.stringify([before, after]) } });
  assert.equal(report.status, 'restart-required');
  const calls = (await readFile(ctx.record, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  assert.deepEqual(calls.find((call) => call.method === 'config/batchWrite').params.edits[0].value, ['/user-only', dataRoot]);
  assert.equal(calls.filter((call) => call.method === 'config/read').length, 2);
});

test('setup detects a higher-precedence writable-root override immediately after writing user config', async () => {
  const ctx = await context({ hooks: hookMetadata(root, 'trusted'), features: { hooks: true } });
  const dataRoot = join(ctx.dataRoot, 'overridden-plugin-data');
  const before = { config: { sandbox_workspace_write: { writable_roots: ['/project-only'] } }, origins: {}, layers: [{ name: { type: 'user', file: join(ctx.dataRoot, 'config.toml') }, version: 'version-1', config: {} }] };
  const after = { ...before, layers: [{ ...before.layers[0], version: 'version-2', config: { sandbox_workspace_write: { writable_roots: [dataRoot] } } }] };
  await assert.rejects(runSetup({ ...ctx.options, dataRoot, env: { ...ctx.options.env, FAKE_CODEX_CONFIG_RESULTS_JSON: JSON.stringify([before, after]) } }), { code: 'PLUGIN_DATA_ROOT_OVERRIDDEN' });
  const calls = (await readFile(ctx.record, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  assert.deepEqual(calls.filter((call) => call.method).map((call) => call.method), ['initialize', 'initialized', 'config/read', 'config/batchWrite', 'config/read']);
  await assert.rejects(stat(dataRoot), { code: 'ENOENT' });
});

test('setup writes profile roots with the matching profile file and version', async () => {
  const ctx = await context({ hooks: hookMetadata(root, 'trusted'), features: { hooks: true } });
  const dataRoot = join(ctx.dataRoot, 'profile-plugin-data'); const baseFile = join(ctx.dataRoot, 'config.toml'); const profileFile = join(ctx.dataRoot, 'profiles', 'work.toml');
  const base = { name: { type: 'user', file: baseFile, profile: null }, version: 'base-version', config: { sandbox_workspace_write: { writable_roots: ['/base-root'] } } };
  const profile = { name: { type: 'user', file: profileFile, profile: 'work' }, version: 'profile-version', config: { sandbox_workspace_write: { writable_roots: ['/profile-root'] } } };
  const before = { config: { sandbox_workspace_write: { writable_roots: ['/profile-root'] } }, origins: {}, layers: [base, profile] };
  const after = { ...before, config: { sandbox_workspace_write: { writable_roots: ['/profile-root', dataRoot] } }, layers: [base, { ...profile, version: 'profile-version-2', config: { sandbox_workspace_write: { writable_roots: ['/profile-root', dataRoot] } } }] };
  await runSetup({ ...ctx.options, dataRoot, env: { ...ctx.options.env, FAKE_CODEX_CONFIG_RESULTS_JSON: JSON.stringify([before, after]) } });
  const calls = (await readFile(ctx.record, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  const params = calls.find((call) => call.method === 'config/batchWrite').params;
  assert.equal(params.filePath, profileFile); assert.equal(params.expectedVersion, 'profile-version');
  assert.deepEqual(params.edits[0].value, ['/profile-root', dataRoot]);
});

test('setup persists model policy only from explicit setup environment variables', async () => {
  const configured = await context({ hooks: hookMetadata(root, 'trusted'), features: { hooks: true }, zcodeEnv: { ZCODE_SETUP_DEFAULT_MODEL: 'fast', ZCODE_SETUP_MODEL_ALIASES_JSON: JSON.stringify({ fast: { providerId: 'fake2', modelId: 'other' } }), ZCODE_MODEL_ALIASES: JSON.stringify({ ignored: { providerId: 'fake', modelId: 'model' } }) } });
  await runSetup(configured.options); const storage = await resolveWorkspaceStorage({ dataRoot: configured.dataRoot, workspace: configured.cwd }); const path = join(storage.directory, 'config', 'models.json');
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { version: 1, defaultModel: 'fast', models: { fast: { providerId: 'fake2', modelId: 'other' } } });
  const configDirectory = await stat(join(storage.directory, 'config')); const modelFile = await stat(path);
  if (process.platform === 'win32') { assert.equal(configDirectory.isDirectory(), true); assert.equal(modelFile.isFile(), true); }
  else { assert.equal(configDirectory.mode & 0o777, 0o700); assert.equal(modelFile.mode & 0o777, 0o600); }
  assert.deepEqual((await runSetup({ ...configured.options, env: { ...configured.options.env, ZCODE_SETUP_DEFAULT_MODEL: 'fake/model', ZCODE_SETUP_MODEL_ALIASES_JSON: undefined } })).modelPolicy, { configured: true, defaultModel: 'fake/model', aliases: ['fast'] });
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { version: 1, defaultModel: 'fake/model', models: { fast: { providerId: 'fake2', modelId: 'other' } } }, 'unspecified aliases are preserved');
  assert.deepEqual((await runSetup({ ...configured.options, env: { ...configured.options.env, ZCODE_SETUP_DEFAULT_MODEL: undefined, ZCODE_SETUP_MODEL_ALIASES_JSON: JSON.stringify({ careful: { providerId: 'fake', modelId: 'model' } }) } })).modelPolicy, { configured: true, defaultModel: 'fake/model', aliases: ['careful'] });
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { version: 1, defaultModel: 'fake/model', models: { careful: { providerId: 'fake', modelId: 'model' } } }, 'unspecified default is preserved');

  const legacyOnly = await context({ hooks: hookMetadata(root, 'trusted'), features: { hooks: true }, zcodeEnv: { ZCODE_MODEL_ALIASES: JSON.stringify({ ignored: { providerId: 'fake', modelId: 'model' } }) } });
  await runSetup(legacyOnly.options); const legacyStorage = await resolveWorkspaceStorage({ dataRoot: legacyOnly.dataRoot, workspace: legacyOnly.cwd });
  await assert.rejects(readFile(join(legacyStorage.directory, 'config', 'models.json')), { code: 'ENOENT' });
});

test('setup readiness ignores session/list and is proven by create plus cleanup', async () => {
  const ctx = await context({ hooks: hookMetadata(root, 'trusted'), features: { hooks: true }, zcodeEnv: { FAKE_ZCODE_ERROR: 'session/list' } }); const report = await runSetup(ctx.options); assert.equal(report.status, 'ready');
  const calls = (await readFile(ctx.zcodeRecord, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); assert.ok(!calls.some((call) => call.method === 'session/list')); assert.ok(calls.some((call) => call.method === 'session/create')); assert.ok(calls.some((call) => call.method === 'session/stop'));
});

test('plugin-level authentication diagnostic is session/create based and actionable', async () => {
  const ready = await context({ hooks: hookMetadata(root, 'trusted'), features: { hooks: true } });
  const discovery = { launch: { command: process.execPath, args: [fakeZCode], target: fakeZCode } };
  assert.deepEqual(await diagnoseZCodeAuth({ workspace: ready.cwd, discovery, env: ready.options.env }), {
    ready: true,
    status: 'authenticated',
  });
  const unavailable = await diagnoseZCodeAuth({ workspace: ready.cwd, discovery, env: { ...ready.options.env, FAKE_ZCODE_ERROR: 'session/create' } });
  assert.equal(unavailable.ready, false);
  assert.equal(unavailable.status, 'unauthenticated');
  assert.match(unavailable.reason, /session\/create/i);
  assert.match(unavailable.remedy, /authenticate.*ZCode/i);
});

test('plugin-level authentication diagnostic identifies a missing ZCode CLI model provider', async () => {
  const ready = await context({ hooks: hookMetadata(root, 'trusted'), features: { hooks: true } });
  const discovery = { launch: { command: process.execPath, args: [fakeZCode], target: fakeZCode } };
  const diagnostic = await diagnoseZCodeAuth({
    workspace: ready.cwd,
    discovery,
    env: {
      ...ready.options.env,
      FAKE_ZCODE_ERROR: 'session/create',
      FAKE_ZCODE_ERROR_DATA_CODE: 'model_config_missing',
      FAKE_ZCODE_ERROR_DATA_SECRET: 'remote-api-key-must-not-leak',
    },
  });
  assert.equal(diagnostic.ready, false);
  assert.equal(diagnostic.status, 'unauthenticated');
  assert.match(diagnostic.reason, /ZCode CLI model provider is not configured/i);
  assert.match(diagnostic.remedy, /configure an API-key provider in ZCode CLI/i);
  assert.match(diagnostic.remedy, /run \$zcode:setup again/i);
  assert.doesNotMatch(`${diagnostic.reason} ${diagnostic.remedy}`, /OAuth|log ?in|remote-api-key-must-not-leak/i);
});

test('plugin-level authentication diagnostic keeps the generic remedy for other remote codes', async () => {
  const ready = await context({ hooks: hookMetadata(root, 'trusted'), features: { hooks: true } });
  const discovery = { launch: { command: process.execPath, args: [fakeZCode], target: fakeZCode } };
  const diagnostic = await diagnoseZCodeAuth({
    workspace: ready.cwd,
    discovery,
    env: { ...ready.options.env, FAKE_ZCODE_ERROR: 'session/create', FAKE_ZCODE_ERROR_DATA_CODE: 'provider_rate_limited' },
  });
  assert.equal(diagnostic.ready, false);
  assert.equal(diagnostic.status, 'unauthenticated');
  assert.equal(diagnostic.reason, 'ZCode session/create could not prove model authentication.');
  assert.equal(diagnostic.remedy, 'Authenticate with ZCode, then run $zcode:setup again.');
});

test('plugin-level authentication diagnostic does not mislabel model provider codes from other methods', async () => {
  const diagnostic = await diagnoseZCodeAuth({
    workspace: '/repo',
    discovery: { launch: { command: 'unused', args: [] } },
    createClient: async () => ({
      createSession: async () => {
        throw Object.assign(new Error('future request failed'), {
          code: 'ZCODE_REQUEST_FAILED',
          details: { method: 'session/list', remoteCode: 'model_config_missing' },
        });
      },
      close: async () => {},
    }),
  });
  assert.deepEqual(diagnostic, {
    ready: false,
    status: 'unauthenticated',
    reason: 'ZCode session/create could not prove model authentication.',
    remedy: 'Authenticate with ZCode, then run $zcode:setup again.',
  });
});

test('setup selects only its qualified marketplace hooks from mixed hooks/list output', async () => {
  const foreign = await mkdtemp(join(tmpdir(), 'foreign-hooks-')); await mkdir(join(foreign, 'hooks')); await writeFile(join(foreign, 'hooks/hooks.json'), '{}');
  const own = hookMetadata(root); const other = hookMetadata(foreign, 'untrusted', 'other-plugin@someone').map((hook, index) => ({ ...hook, key: `other-${index}` }));
  const user = { key: 'user-hook', currentHash: 'f'.repeat(64), displayOrder: 99, enabled: true, eventName: 'stop', handlerType: 'command', isManaged: false, source: 'user', timeoutSec: 5, trustStatus: 'untrusted', command: 'echo user' };
  const ctx = await context({ hooks: [user, ...other, ...own] }); const report = await runSetup(ctx.options); assert.equal(report.status, 'restart-required', JSON.stringify(report));
  const calls = (await readFile(ctx.record, 'utf8')).trim().split('\n').map(JSON.parse); const batch = calls.find((call) => call.method === 'config/batchWrite'); const trust = batch.params.edits.find((edit) => edit.keyPath === 'hooks.state').value;
  assert.deepEqual(Object.keys(trust).sort(), own.map((hook) => hook.key).sort()); assert.ok(!Object.hasOwn(trust, 'user-hook')); assert.ok(!Object.keys(trust).some((key) => key.startsWith('other-')));
});

test('setup rejects missing, outdated, unauthenticated and foreign/untrusted hook sources deterministically', async (t) => {
  await t.test('outdated', async () => { const ctx = await context(); const report = await runSetup({ ...ctx.options, dependencies: { discoverZCode: async () => { throw Object.assign(new Error('outdated'), { code: 'ZCODE_VERSION_UNSUPPORTED' }); } } }); assert.equal(report.status, 'outdated'); });
  await t.test('missing', async () => { const ctx = await context(); const report = await runSetup({ ...ctx.options, dependencies: { discoverZCode: async () => { throw Object.assign(new Error('missing'), { code: 'ZCODE_NOT_FOUND' }); } } }); assert.equal(report.status, 'missing'); });
  await t.test('unauthenticated', async () => { const ctx = await context({ zcodeEnv: { FAKE_ZCODE_ERROR: 'session/create' } }); const report = await runSetup(ctx.options); assert.equal(report.status, 'unauthenticated'); assert.equal(report.auth.ready, false); });
  await t.test('untrusted-source', async () => { const foreign = await mkdtemp(join(tmpdir(), 'foreign-hooks-')); await mkdir(join(foreign, 'hooks')); await writeFile(join(foreign, 'hooks/hooks.json'), '{}'); const ctx = await context({ hooks: hookMetadata(foreign) }); const report = await runSetup(ctx.options); assert.equal(report.status, 'untrusted'); assert.ok(!(await readFile(ctx.record, 'utf8')).includes('config/batchWrite')); });
});

test('setup never follows a forged PLUGIN_ROOT symlink or edits plugin files', async () => {
  const ctx = await context(); const before = await readFile(join(root, 'hooks/hooks.json'), 'utf8');
  await assert.rejects(runSetup({ ...ctx.options, pluginRoot: join(root, '..') }), { code: 'PLUGIN_ROOT_UNTRUSTED' });
  assert.equal(await readFile(join(root, 'hooks/hooks.json'), 'utf8'), before);
});

test('plugin root derivation decodes file URLs with spaces and percent characters portably', () => {
  const expected = join(tmpdir(), 'plugin root % encoded'); const moduleUrl = pathToFileURL(join(expected, 'scripts', 'lib', 'codex-config.mjs'));
  assert.equal(pluginRootFromModuleUrl(moduleUrl), expected);
});

test('app-server failure cannot persist a ready gate and enable/disable touches only workspace gate state', async () => {
  const failed = await context({ codexEnv: { FAKE_CODEX_ERROR: 'hooks/list' } }); await assert.rejects(runSetup({ ...failed.options, reviewGate: true }), { code: 'CODEX_CONFIG_REQUEST_FAILED' });
  if (process.platform !== 'win32') {
    for (let index = 0; index < 50 && !(await readFile(failed.record, 'utf8')).includes('lifecycle'); index += 1) await new Promise((resolvePromise) => setTimeout(resolvePromise, 10)); assert.match(await readFile(failed.record, 'utf8'), /"lifecycle":"SIGTERM"/);
  }
  const failedStorage = await resolveWorkspaceStorage({ dataRoot: failed.dataRoot, workspace: failed.cwd }); await assert.rejects(readFile(join(failedStorage.directory, 'config/review-gate.json'), 'utf8'), { code: 'ENOENT' });
  const disabled = await context({ hooks: hookMetadata(root, 'trusted'), features: { hooks: true } }); const report = await runSetup({ ...disabled.options, reviewGate: false }); assert.equal(report.reviewGate.enabled, false);
  const disabledStorage = await resolveWorkspaceStorage({ dataRoot: disabled.dataRoot, workspace: disabled.cwd }); const gate = JSON.parse(await readFile(join(disabledStorage.directory, 'config/review-gate.json'), 'utf8')); assert.equal(gate.enabled, false); assert.equal(gate.setupReady, true);
});

test('review-gate toggles are isolated between workspaces sharing PLUGIN_DATA', async () => {
  const first = await context({ hooks: hookMetadata(root, 'trusted'), features: { hooks: true } }); await runSetup({ ...first.options, reviewGate: true }); const secondCwd = await realpath(await mkdtemp(join(tmpdir(), 'zpc-setup-second-'))); const secondHooks = { data: [{ cwd: secondCwd, errors: [], warnings: [], hooks: hookMetadata(root, 'trusted') }] }; const second = { ...first.options, cwd: secondCwd, reviewGate: false, env: { ...first.options.env, FAKE_CODEX_HOOKS_RESULT: JSON.stringify(secondHooks) } }; await runSetup(second);
  const firstStorage = await resolveWorkspaceStorage({ dataRoot: first.dataRoot, workspace: first.cwd }); const secondStorage = await resolveWorkspaceStorage({ dataRoot: first.dataRoot, workspace: secondCwd }); assert.equal(JSON.parse(await readFile(join(firstStorage.directory, 'config/review-gate.json'), 'utf8')).enabled, true); assert.equal(JSON.parse(await readFile(join(secondStorage.directory, 'config/review-gate.json'), 'utf8')).enabled, false);
});

test('real companion setup is the only public command that needs no caller authorization', async () => {
  const ctx = await context({ hooks: hookMetadata(root, 'trusted'), features: { hooks: true } }); const report = await runCompanion(['setup', '--enable-review-gate'], { cwd: ctx.cwd, env: { ...ctx.options.env, PLUGIN_ROOT: root, PLUGIN_DATA: ctx.dataRoot, CODEX_APP_SERVER_PATH: process.execPath, CODEX_APP_SERVER_ARGS_JSON: JSON.stringify([fakeCodex]) } }); assert.equal(report.status, 'ready'); assert.equal(report.reviewGate.enabled, true);
  await assert.rejects(runCompanion(['status'], { cwd: ctx.cwd, env: { ...ctx.options.env, PLUGIN_ROOT: root, PLUGIN_DATA: ctx.dataRoot } }), { code: 'INTERNAL_AUTHORIZATION_INVALID' });
});

test('setup executable succeeds on ordinary stdio without protected fd3/fd4', async () => {
  const ctx = await context({ hooks: hookMetadata(root, 'trusted'), features: { hooks: true } }); const result = await new Promise((resolvePromise, reject) => { const child = spawn(process.execPath, [join(root, 'scripts/zcode-companion.mjs'), 'setup', '--disable-review-gate'], { cwd: ctx.cwd, env: { ...ctx.options.env, PLUGIN_ROOT: root, PLUGIN_DATA: ctx.dataRoot, CODEX_APP_SERVER_PATH: process.execPath, CODEX_APP_SERVER_ARGS_JSON: JSON.stringify([fakeCodex]) }, stdio: ['ignore', 'pipe', 'pipe'] }); let stdout = ''; let stderr = ''; child.stdout.on('data', (chunk) => { stdout += chunk; }); child.stderr.on('data', (chunk) => { stderr += chunk; }); child.once('error', reject); child.once('exit', (code) => resolvePromise({ code, stdout, stderr })); }); assert.equal(result.code, 0, result.stderr); assert.equal(JSON.parse(result.stdout).status, 'ready'); assert.doesNotMatch(`${result.stdout}${result.stderr}`, /INTERNAL_RESPONSE/);
});
