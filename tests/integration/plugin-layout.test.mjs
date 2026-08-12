import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
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

  const hooksPath = resolve(rootPath, 'hooks/hooks.json');
  const relativeHooksPath = relative(rootPath, hooksPath);
  assert.notEqual(relativeHooksPath, '..');
  assert.equal(relativeHooksPath.startsWith(`..${sep}`), false);
  assert.doesNotThrow(() => readJson('hooks/hooks.json'));
  assert.equal(Object.hasOwn(manifest, 'hooks'), false, 'default hooks/hooks.json must not need a manifest override');
  for (const absentComponent of ['mcpServers', 'apps']) {
    assert.equal(
      Object.hasOwn(manifest, absentComponent),
      false,
      `${absentComponent} must not be declared without a companion file`,
    );
  }
});

test('source package layout carries the canonical isolated Rescue runtime only', () => {
  const packageJson = readJson('package.json');
  assert.ok(packageJson.files.includes('agents/'));
  assert.ok(packageJson.files.includes('scripts/'));
  for (const path of [
    'agents/zcode-rescue.toml.template',
    'scripts/lib/conversation-progress.mjs',
    'scripts/lib/managed-agent-role.mjs',
    'scripts/lib/progress.mjs',
  ]) assert.equal(existsSync(new URL(path, rootUrl)), true, `${path} must ship`);
  assert.equal(existsSync(new URL('agents/zcode-rescue.md', rootUrl)), false, 'obsolete Markdown forwarder must not ship');
});
