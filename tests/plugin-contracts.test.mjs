import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const root = new URL('../', import.meta.url);

/** @param {string} relativePath */
function readJson(relativePath) {
  return JSON.parse(readFileSync(new URL(relativePath, root), 'utf8'));
}

test('plugin manifest exposes the native Codex plugin contract', () => {
  const manifestPath = new URL('.codex-plugin/plugin.json', root);

  assert.equal(
    existsSync(manifestPath),
    true,
    '.codex-plugin/plugin.json must exist',
  );

  const manifest = readJson('.codex-plugin/plugin.json');

  assert.equal(manifest.name, 'zcode-plugin-codex');
  assert.match(manifest.version, /^0\.1\.0(?:\+[0-9A-Za-z.-]+)?$/);
  assert.equal(manifest.author?.name, 'vitry');
  assert.equal(manifest.license, 'Apache-2.0');
  assert.equal(manifest.interface?.displayName, 'ZCode for Codex');
  assert.deepEqual(manifest.interface?.defaultPrompt, [
    'Ask ZCode to review my current changes.',
    'Delegate this implementation task to ZCode.',
  ]);
  assert.equal(
    Object.hasOwn(manifest, 'hooks'),
    false,
    'hooks must use default hooks/hooks.json discovery',
  );
});

test('package metadata exposes the supported Node contract', () => {
  const packagePath = new URL('package.json', root);

  assert.equal(existsSync(packagePath), true, 'package.json must exist');

  const packageJson = readJson('package.json');

  assert.equal(packageJson.type, 'module');
  assert.equal(packageJson.engines?.node, '>=18.18.0');
  assert.deepEqual(packageJson.dependencies ?? {}, {});
});
