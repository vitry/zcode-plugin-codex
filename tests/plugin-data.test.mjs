import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { resolvePluginDataContext, resolvePluginDataRoot } from '../scripts/lib/plugin-data.mjs';
import { platformPathEqual } from '../scripts/lib/codex-config.mjs';

test('explicit ZCODE_DATA_ROOT overrides every other plugin data location', () => {
  const codexHome = resolve('codex-home-fixture'); const explicit = resolve('operator-data-fixture');
  assert.equal(resolvePluginDataRoot({
    env: { ZCODE_DATA_ROOT: explicit, PLUGIN_DATA: resolve('ignored-data-fixture'), CODEX_HOME: codexHome },
    pluginRoot: join(codexHome, 'plugins', 'cache', 'vitry', 'zcode', '0.1.0'),
  }), explicit);
  assert.equal(resolvePluginDataRoot({
    env: { ZCODE_DATA_ROOT: explicit, CODEX_HOME: 'invalid\u0000home' },
    pluginRoot: 'invalid\u0000plugin',
  }), explicit);
});

test('plugin data context preserves explicit roots while reporting trusted installation provenance', () => {
  const codexHome = resolve('codex-home-fixture'); const explicit = resolve('operator-data-fixture');
  assert.deepEqual(resolvePluginDataContext({
    env: { ZCODE_DATA_ROOT: explicit, CODEX_HOME: codexHome },
    pluginRoot: join(codexHome, 'plugins', 'cache', 'vitry', 'zcode', '0.1.0'),
  }), { dataRoot: explicit, provenance: 'marketplace' });
  assert.deepEqual(resolvePluginDataContext({
    env: { ZCODE_DATA_ROOT: explicit, CODEX_HOME: codexHome },
    pluginRoot: resolve('source', 'zcode-plugin-codex'),
  }), { dataRoot: explicit, provenance: 'source' });
});

test('installed plugins derive a marketplace-qualified data root without injected plugin data', () => {
  const codexHome = resolve('codex-home-fixture');
  assert.equal(resolvePluginDataRoot({
    env: { CODEX_HOME: codexHome },
    pluginRoot: join(codexHome, 'plugins', 'cache', 'vitry', 'zcode', '0.1.0'),
  }), join(codexHome, 'plugins', 'data', 'zcode-vitry'));
});

test('installed plugins accept the Codex cachebuster build metadata used for local updates', () => {
  const codexHome = resolve('codex-home-fixture');
  assert.equal(resolvePluginDataRoot({
    env: { CODEX_HOME: codexHome },
    pluginRoot: join(codexHome, 'plugins', 'cache', 'vitry', 'zcode', '0.1.0+codex.local-20260813-030655'),
  }), join(codexHome, 'plugins', 'data', 'zcode-vitry'));
});

test('installed plugins accept only plugin-data injected for their active marketplace identity', () => {
  const codexHome = resolve('codex-home-fixture'); const pluginRoot = join(codexHome, 'plugins', 'cache', 'vitry', 'zcode', '0.1.0'); const expected = join(codexHome, 'plugins', 'data', 'zcode-vitry');
  assert.equal(resolvePluginDataRoot({ env: { CODEX_HOME: codexHome, PLUGIN_DATA: expected }, pluginRoot }), expected);
  assert.equal(resolvePluginDataRoot({ env: { CODEX_HOME: codexHome, CLAUDE_PLUGIN_DATA: expected }, pluginRoot }), expected);
  assert.equal(resolvePluginDataRoot({ env: { CODEX_HOME: codexHome, PLUGIN_DATA: join(codexHome, 'plugins', 'data', 'zcode-other') }, pluginRoot }), expected);
  assert.equal(resolvePluginDataRoot({ env: { CODEX_HOME: codexHome, PLUGIN_DATA: resolve('arbitrary-data-fixture') }, pluginRoot }), expected);
});

test('source checkouts use the unqualified CODEX_HOME development root', () => {
  const codexHome = resolve('codex-home-fixture');
  assert.equal(resolvePluginDataRoot({ env: { CODEX_HOME: codexHome }, pluginRoot: resolve('source', 'zcode-plugin-codex') }), join(codexHome, 'plugins', 'data', 'zcode'));
  assert.deepEqual(resolvePluginDataContext({ env: { CODEX_HOME: codexHome }, pluginRoot: resolve('source', 'zcode-plugin-codex') }), {
    dataRoot: join(codexHome, 'plugins', 'data', 'zcode'), provenance: 'source',
  });
});

test('Codex config path equality is case-insensitive only on Windows', () => {
  assert.equal(platformPathEqual('C:\\Codex\\Data', 'c:\\codex\\data', 'win32'), true);
  assert.equal(platformPathEqual('/Codex/Data', '/codex/data', 'linux'), false);
});

test('installed identity follows a symlinked cache directory', async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), 'zpc-plugin-cache-link-'));
  t.after(() => import('node:fs/promises').then(({ rm }) => rm(temporary, { force: true, recursive: true })));
  const codexHome = join(temporary, 'codex-home'); const cacheTarget = join(temporary, 'cache-target');
  await mkdir(join(codexHome, 'plugins'), { recursive: true }); await mkdir(join(cacheTarget, 'vitry', 'zcode', '0.1.0'), { recursive: true });
  await symlink(cacheTarget, join(codexHome, 'plugins', 'cache'));
  assert.equal(resolvePluginDataRoot({ env: { CODEX_HOME: codexHome }, pluginRoot: join(codexHome, 'plugins', 'cache', 'vitry', 'zcode', '0.1.0') }), join(await realpath(codexHome), 'plugins', 'data', 'zcode-vitry'));
});

test('installed identity follows canonical symlinked plugin paths', async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), 'zpc-plugin-data-'));
  t.after(() => import('node:fs/promises').then(({ rm }) => rm(temporary, { force: true, recursive: true })));
  const codexHome = join(temporary, 'codex-home');
  const installed = join(codexHome, 'plugins', 'cache', 'vitry', 'zcode', '0.1.0');
  const link = join(temporary, 'active-plugin');
  await mkdir(installed, { recursive: true });
  await symlink(installed, link);
  const actualHome = await realpath(codexHome);
  assert.equal(resolvePluginDataRoot({ env: { CODEX_HOME: codexHome }, pluginRoot: link }), join(actualHome, 'plugins', 'data', 'zcode-vitry'));
  assert.deepEqual(resolvePluginDataContext({ env: { CODEX_HOME: codexHome }, pluginRoot: link }), {
    dataRoot: join(actualHome, 'plugins', 'data', 'zcode-vitry'), provenance: 'marketplace',
  });
  assert.equal(await realpath(link), await realpath(installed));
});

test('trusted lexical companion entry preserves marketplace identity for an exact owned cache symlink only', async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), 'zpc-plugin-entry-link-'));
  t.after(() => import('node:fs/promises').then(({ rm }) => rm(temporary, { force: true, recursive: true })));
  const codexHome = join(temporary, 'codex-home'); const ownedRoot = resolve(fileURLToPath(new URL('../', import.meta.url)));
  const installed = join(codexHome, 'plugins', 'cache', 'vitry', 'zcode', '0.1.0');
  await mkdir(dirname(installed), { recursive: true }); await symlink(ownedRoot, installed, 'dir');
  const entryPath = join(installed, 'scripts', 'zcode-companion.mjs');
  assert.deepEqual(resolvePluginDataContext({ env: { CODEX_HOME: codexHome }, pluginRoot: ownedRoot, entryPath }), {
    dataRoot: join(await realpath(codexHome), 'plugins', 'data', 'zcode-vitry'), provenance: 'marketplace',
  });

  const wrongRoot = join(temporary, 'wrong-plugin'); await mkdir(join(wrongRoot, 'scripts'), { recursive: true });
  await writeFile(join(wrongRoot, 'scripts', 'zcode-companion.mjs'), 'export {};\n');
  const wrongTarget = join(codexHome, 'plugins', 'cache', 'other', 'zcode', '0.1.0');
  await mkdir(dirname(wrongTarget), { recursive: true }); await symlink(wrongRoot, wrongTarget, 'dir');
  for (const candidate of [
    join(wrongTarget, 'scripts', 'zcode-companion.mjs'),
    join(temporary, 'outside-cache', 'scripts', 'zcode-companion.mjs'),
    join(codexHome, 'plugins', 'cache', 'vitry', 'wrong-plugin', '0.1.0', 'scripts', 'zcode-companion.mjs'),
    `${installed}${sep}..${sep}0.1.0${sep}scripts${sep}zcode-companion.mjs`,
    `${entryPath}\u0000bad`,
  ]) assert.throws(() => resolvePluginDataContext({ env: { CODEX_HOME: codexHome }, pluginRoot: ownedRoot, entryPath: candidate }), { code: 'PLUGIN_DATA_ROOT_INVALID' });
});

test('installed identity rejects malformed cache segments', () => {
  const codexHome = resolve('codex-home-fixture'); const cache = join(codexHome, 'plugins', 'cache');
  for (const pluginRoot of [
    `${cache}${sep}..${sep}zcode${sep}0.1.0`,
    `${cache}${sep}vitry${sep}zcode${sep}..${sep}0.1.0`,
    join(cache, 'vitry', 'zcode', '0.1.0', 'unexpected'),
    join(cache, 'vitry', 'zcode', '0.1.0++bad'),
    join(cache, 'vitry', 'zcode', '+codex.local'),
    join(cache, 'vitry', 'zcode', '0.1.0+'),
    `${join(cache, 'vitry', 'zcode', '0.1.0')}\u0000bad`,
  ]) assert.throws(() => resolvePluginDataRoot({ env: { CODEX_HOME: codexHome }, pluginRoot }), { code: 'PLUGIN_DATA_ROOT_INVALID' });
});
