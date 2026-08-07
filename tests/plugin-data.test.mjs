import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { resolvePluginDataRoot } from '../scripts/lib/plugin-data.mjs';

test('explicit ZCODE_DATA_ROOT overrides every other plugin data location', () => {
  assert.equal(resolvePluginDataRoot({
    env: { ZCODE_DATA_ROOT: '/operator/data', PLUGIN_DATA: '/ignored/data', CODEX_HOME: '/codex-home' },
    pluginRoot: '/codex-home/plugins/cache/vitry/zcode/0.1.0',
  }), '/operator/data');
});

test('installed plugins derive a marketplace-qualified data root without injected plugin data', () => {
  assert.equal(resolvePluginDataRoot({
    env: { CODEX_HOME: '/codex-home' },
    pluginRoot: '/codex-home/plugins/cache/vitry/zcode/0.1.0',
  }), '/codex-home/plugins/data/zcode-vitry');
});

test('installed plugins accept only plugin-data injected for their active marketplace identity', () => {
  const pluginRoot = '/codex-home/plugins/cache/vitry/zcode/0.1.0';
  assert.equal(resolvePluginDataRoot({ env: { CODEX_HOME: '/codex-home', PLUGIN_DATA: '/codex-home/plugins/data/zcode-vitry' }, pluginRoot }), '/codex-home/plugins/data/zcode-vitry');
  assert.equal(resolvePluginDataRoot({ env: { CODEX_HOME: '/codex-home', CLAUDE_PLUGIN_DATA: '/codex-home/plugins/data/zcode-vitry' }, pluginRoot }), '/codex-home/plugins/data/zcode-vitry');
  assert.equal(resolvePluginDataRoot({ env: { CODEX_HOME: '/codex-home', PLUGIN_DATA: '/codex-home/plugins/data/zcode-other' }, pluginRoot }), '/codex-home/plugins/data/zcode-vitry');
  assert.equal(resolvePluginDataRoot({ env: { CODEX_HOME: '/codex-home', PLUGIN_DATA: '/arbitrary/data' }, pluginRoot }), '/codex-home/plugins/data/zcode-vitry');
});

test('source checkouts use the unqualified CODEX_HOME development root', () => {
  assert.equal(resolvePluginDataRoot({ env: { CODEX_HOME: '/codex-home' }, pluginRoot: '/source/zcode-plugin-codex' }), '/codex-home/plugins/data/zcode');
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
  for (const pluginRoot of [
    '/codex-home/plugins/cache/../zcode/0.1.0',
    '/codex-home/plugins/cache/vitry/zcode/../0.1.0',
    '/codex-home/plugins/cache/vitry/zcode/0.1.0/unexpected',
    '/codex-home/plugins/cache/vitry/zcode/0.1.0\u0000bad',
  ]) assert.throws(() => resolvePluginDataRoot({ env: { CODEX_HOME: '/codex-home' }, pluginRoot }), { code: 'PLUGIN_DATA_ROOT_INVALID' });
});
