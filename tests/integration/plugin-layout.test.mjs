import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const rootUrl = new URL('../../', import.meta.url);
const rootPath = fileURLToPath(rootUrl);

/** @param {string} relativePath */
function readJson(relativePath) {
  return JSON.parse(readFileSync(new URL(relativePath, rootUrl), 'utf8'));
}

test('package and plugin manifest describe the same plugin release', () => {
  const packageJson = readJson('package.json');
  const manifest = readJson('.codex-plugin/plugin.json');

  assert.equal(packageJson.name, 'zcode-plugin-codex');
  assert.equal(manifest.name, 'zcode');
  assert.equal(manifest.version, packageJson.version);
  assert.equal(manifest.license, packageJson.license);
});

test('plugin component declarations stay within the plugin root', () => {
  const manifest = readJson('.codex-plugin/plugin.json');

  assert.match(manifest.skills, /^\.\//);

  const skillsPath = resolve(rootPath, manifest.skills);
  const relativeSkillsPath = relative(rootPath, skillsPath);

  assert.notEqual(relativeSkillsPath, '..');
  assert.equal(relativeSkillsPath.startsWith(`..${sep}`), false);

  for (const absentComponent of ['hooks', 'mcpServers', 'apps']) {
    assert.equal(
      Object.hasOwn(manifest, absentComponent),
      false,
      `${absentComponent} must not be declared without a companion file`,
    );
  }
});
