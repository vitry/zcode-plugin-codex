import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { PluginError } from '../scripts/lib/errors.mjs';
import { readZCodeCliMainModel } from '../scripts/lib/zcode-runtime-config.mjs';

/** @param {string} contents */
async function configFixture(contents) {
  const home = await mkdtemp(join(tmpdir(), 'zcode-runtime-config-'));
  const directory = join(home, '.zcode', 'cli');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'config.json'), contents);
  return home;
}

test('reads model.main from HOME and splits at only the first slash', async () => {
  const home = await configFixture(JSON.stringify({
    model: { main: 'provider/model/variant' },
    providerOptions: { endpoint: 'https://private.invalid', apiKey: 'PRIVATE_API_KEY' },
  }));

  assert.deepEqual(await readZCodeCliMainModel({ env: { HOME: home } }), {
    providerId: 'provider', modelId: 'model/variant',
  });
});

test('falls back from absent HOME to USERPROFILE', async () => {
  const home = await configFixture(JSON.stringify({ model: { main: 'fallback/model' } }));
  assert.deepEqual(await readZCodeCliMainModel({ env: { USERPROFILE: home } }), {
    providerId: 'fallback', modelId: 'model',
  });
});

test('falls back from empty HOME to USERPROFILE', async () => {
  const home = await configFixture(JSON.stringify({ model: { main: 'profile/model' } }));
  assert.deepEqual(await readZCodeCliMainModel({ env: { HOME: '', USERPROFILE: home } }), {
    providerId: 'profile', modelId: 'model',
  });
});

test('maps missing, unreadable, oversized, malformed, symlinked, and invalid config to one fixed secret-free error', async (t) => {
  const secret = 'PRIVATE_TOKEN_VALUE';
  /** @type {Array<[string,()=>Promise<string>]>} */
  const cases = [
    ['missing', async () => mkdtemp(join(tmpdir(), 'zcode-runtime-config-missing-'))],
    ['unreadable', async () => { const home = await configFixture(JSON.stringify({ model: { main: 'provider/model' } })); await chmod(join(home, '.zcode', 'cli', 'config.json'), 0o000); return home; }],
    ['oversized', async () => configFixture(JSON.stringify({ model: { main: `provider/${'x'.repeat(256)}` }, token: secret }))],
    ['malformed', async () => configFixture(`{"token":"${secret}",`) ],
    ['invalid main', async () => configFixture(JSON.stringify({ model: { main: 'missing-slash' }, apiKey: secret }))],
    ['empty provider', async () => configFixture(JSON.stringify({ model: { main: '/model' }, endpoint: secret }))],
    ['empty model', async () => configFixture(JSON.stringify({ model: { main: 'provider/' }, secret }))],
    ['symlink', async () => {
      const home = await mkdtemp(join(tmpdir(), 'zcode-runtime-config-link-'));
      const directory = join(home, '.zcode', 'cli'); await mkdir(directory, { recursive: true });
      const target = join(home, 'private.json'); await writeFile(target, JSON.stringify({ model: { main: 'provider/model' }, token: secret }));
      await symlink(target, join(directory, 'config.json')); return home;
    }],
  ];

  for (const [name, createHome] of cases) await t.test(name, async () => {
    const home = await createHome();
    const error = await readZCodeCliMainModel({ env: { HOME: home }, maxBytes: name === 'oversized' ? 32 : 64 * 1024 }).catch((caught) => caught);
    assert.ok(error instanceof PluginError);
    assert.equal(error.code, 'ZCODE_RUNTIME_MODEL_CONFIG_INVALID');
    assert.equal(error.message, 'ZCode runtime model configuration is unavailable.');
    assert.equal(error.cause, undefined);
    assert.deepEqual(error.details, {});
    assert.doesNotMatch(JSON.stringify(error), /config\.json|\.zcode|PRIVATE|token|secret|endpoint|apiKey|providerOptions/i);
  });
});
