import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import test from 'node:test';

import { resolvePluginDataRoot } from '../scripts/lib/plugin-data.mjs';
import { platformPathEqual } from '../scripts/lib/codex-config.mjs';

test('explicit ZCODE_DATA_ROOT overrides every other plugin data location', () => {
  const codexHome = resolve('codex-home-fixture'); const explicit = resolve('operator-data-fixture');
  assert.equal(resolvePluginDataRoot({
    env: { ZCODE_DATA_ROOT: explicit, PLUGIN_DATA: resolve('ignored-data-fixture'), CODEX_HOME: codexHome },
    pluginRoot: join(codexHome, 'plugins', 'cache', 'vitry', 'zcode', '0.1.0'),
  }), explicit);
});

test('installed plugins derive a marketplace-qualified data root without injected plugin data', () => {
  const codexHome = resolve('codex-home-fixture');
  assert.equal(resolvePluginDataRoot({
    env: { CODEX_HOME: codexHome },
    pluginRoot: join(codexHome, 'plugins', 'cache', 'vitry', 'zcode', '0.1.0'),
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
  assert.equal(await realpath(link), await realpath(installed));
});

test('installed identity rejects malformed cache segments', () => {
  const codexHome = resolve('codex-home-fixture'); const cache = join(codexHome, 'plugins', 'cache');
  for (const pluginRoot of [
    `${cache}${sep}..${sep}zcode${sep}0.1.0`,
    `${cache}${sep}vitry${sep}zcode${sep}..${sep}0.1.0`,
    join(cache, 'vitry', 'zcode', '0.1.0', 'unexpected'),
    `${join(cache, 'vitry', 'zcode', '0.1.0')}\u0000bad`,
  ]) assert.throws(() => resolvePluginDataRoot({ env: { CODEX_HOME: codexHome }, pluginRoot }), { code: 'PLUGIN_DATA_ROOT_INVALID' });
});
