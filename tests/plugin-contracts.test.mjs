import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const rootPath = fileURLToPath(root);
const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const requiredManifestFields = [
  'author',
  'description',
  'homepage',
  'interface',
  'keywords',
  'license',
  'name',
  'repository',
  'skills',
  'version',
];
const requiredInterfaceFields = [
  'capabilities',
  'category',
  'defaultPrompt',
  'developerName',
  'displayName',
  'longDescription',
  'shortDescription',
  'websiteURL',
];
const assetFields = ['composerIcon', 'logo', 'logoDark'];

/** @param {string} relativePath */
function readJson(relativePath) {
  return JSON.parse(readFileSync(new URL(relativePath, root), 'utf8'));
}

/** @param {Record<string, any>} manifest */
function assertManifestContract(manifest) {
  assert.deepEqual(
    Object.keys(manifest).sort(),
    requiredManifestFields,
    'manifest must contain exactly the supported top-level fields',
  );
  assert.match(manifest.version, semverPattern);
  assert.equal(manifest.skills, './skills/');

  for (const field of requiredInterfaceFields) {
    assert.equal(
      Object.hasOwn(manifest.interface, field),
      true,
      `interface.${field} is required`,
    );
  }

  assert.equal(
    Array.isArray(manifest.interface.defaultPrompt),
    true,
    'interface.defaultPrompt must be an array',
  );
  assert.ok(
    manifest.interface.defaultPrompt.length >= 1
      && manifest.interface.defaultPrompt.length <= 3,
    'interface.defaultPrompt must contain 1-3 prompts',
  );
  for (const prompt of manifest.interface.defaultPrompt) {
    assert.equal(typeof prompt, 'string');
    assert.ok(prompt.length <= 128, 'default prompts must be at most 128 characters');
  }

  const declaredAssets = assetFields
    .filter((field) => Object.hasOwn(manifest.interface, field))
    .map((field) => manifest.interface[field]);
  if (Object.hasOwn(manifest.interface, 'screenshots')) {
    declaredAssets.push(...manifest.interface.screenshots);
  }

  for (const asset of declaredAssets) {
    assert.match(asset, /^\.\/assets\//);
    const assetPath = resolve(rootPath, asset);
    const relativeAssetPath = relative(rootPath, assetPath);
    assert.notEqual(relativeAssetPath, '..');
    assert.equal(relativeAssetPath.startsWith(`..${sep}`), false);
    assert.equal(existsSync(assetPath), true, `${asset} must exist`);
  }
}

test('plugin manifest exposes the native Codex plugin contract', () => {
  const manifestPath = new URL('.codex-plugin/plugin.json', root);

  assert.equal(
    existsSync(manifestPath),
    true,
    '.codex-plugin/plugin.json must exist',
  );

  const manifest = readJson('.codex-plugin/plugin.json');

  assertManifestContract(manifest);
  assert.equal(manifest.name, 'zcode-plugin-codex');
  assert.equal(manifest.author?.name, 'vitry');
  assert.equal(manifest.license, 'Apache-2.0');
  assert.equal(manifest.interface?.displayName, 'ZCode for Codex');
  assert.deepEqual(manifest.interface?.defaultPrompt, [
    'Ask ZCode to review my current changes.',
    'Delegate this implementation task to ZCode.',
  ]);
});

test('plugin manifest contract rejects unsupported components and fields', () => {
  const manifest = readJson('.codex-plugin/plugin.json');

  for (const field of ['hooks', 'mcpServers', 'apps', 'unknownField']) {
    assert.throws(
      () => assertManifestContract({ ...manifest, [field]: './missing.json' }),
      /exactly the supported top-level fields/,
    );
  }
});

test('plugin manifest contract rejects missing required fields', () => {
  const manifest = readJson('.codex-plugin/plugin.json');

  for (const field of requiredManifestFields) {
    const invalidManifest = { ...manifest };
    delete invalidManifest[field];
    assert.throws(
      () => assertManifestContract(invalidManifest),
      /exactly the supported top-level fields/,
    );
  }

  for (const field of requiredInterfaceFields) {
    const invalidInterface = { ...manifest.interface };
    delete invalidInterface[field];
    assert.throws(
      () => assertManifestContract({ ...manifest, interface: invalidInterface }),
      new RegExp(`interface\\.${field} is required`),
    );
  }
});

test('plugin manifest contract rejects invalid versions and missing assets', () => {
  const manifest = readJson('.codex-plugin/plugin.json');

  for (const version of ['0.0.0', '1.2.3', '1.2.3-alpha.1+build.5']) {
    assert.doesNotThrow(() => assertManifestContract({ ...manifest, version }));
  }

  for (const version of ['1', '1.0', '01.0.0', '1.0.0-01', '1.0.0+']) {
    assert.throws(
      () => assertManifestContract({ ...manifest, version }),
      /regular expression/,
    );
  }

  assert.throws(
    () => assertManifestContract({
      ...manifest,
      interface: { ...manifest.interface, logo: './assets/missing.png' },
    }),
    /must exist/,
  );
});

test('plugin manifest contract rejects invalid skills and starter prompts', () => {
  const manifest = readJson('.codex-plugin/plugin.json');

  for (const skills of ['skills/', './other-skills/', '../skills/']) {
    assert.throws(
      () => assertManifestContract({ ...manifest, skills }),
      /\.\/skills\//,
    );
  }

  for (const defaultPrompt of [
    'one',
    [],
    ['one', 'two', 'three', 'four'],
    ['x'.repeat(129)],
  ]) {
    assert.throws(
      () => assertManifestContract({
        ...manifest,
        interface: { ...manifest.interface, defaultPrompt },
      }),
      /defaultPrompt|default prompts/,
    );
  }
});

test('package metadata exposes Node 18 and only the pinned native lock dependency', () => {
  const packagePath = new URL('package.json', root);

  assert.equal(existsSync(packagePath), true, 'package.json must exist');

  const packageJson = readJson('package.json');

  assert.equal(packageJson.type, 'module');
  assert.equal(packageJson.engines?.node, '>=18.18.0');
  assert.deepEqual(packageJson.dependencies ?? {}, {
    'fs-native-extensions': '1.5.0',
  }, 'no runtime dependency other than the exact native lock pin is allowed');
  assert.deepEqual(packageJson.overrides ?? {}, {
    'bare-addon-resolve': '1.9.4',
  }, 'only the Node 18 compatibility override is allowed');
  assert.deepEqual(packageJson.bundleDependencies ?? [], [
    'fs-native-extensions',
  ], 'the native lock tree must be bundled for production consumers');
  assert.equal(existsSync(new URL('npm-shrinkwrap.json', root)), true);
  assert.equal(existsSync(new URL('package-lock.json', root)), false);
  const shrinkwrap = readJson('npm-shrinkwrap.json');
  assert.equal(
    shrinkwrap.packages?.['node_modules/require-addon/node_modules/bare-addon-resolve']?.version,
    '1.9.4',
    'the published dependency tree must retain the Node 18-compatible resolver',
  );
  assert.match(packageJson.version, semverPattern);
  const [major, minor] = packageJson.version.split('.').map(Number);
  assert.equal(major, 0);
  assert.ok(minor >= 1);
  assert.equal(packageJson.devDependencies?.['@types/node'], '^18.19.0');
});

test('package test scripts do not depend on shell glob expansion', () => {
  const packageJson = readJson('package.json');

  assert.equal(packageJson.scripts?.test, 'node --test');
  assert.equal(
    packageJson.scripts?.['test:unit'],
    'node --test tests/plugin-contracts.test.mjs',
  );
  assert.equal(
    packageJson.scripts?.['test:integration'],
    'node --test tests/integration/plugin-layout.test.mjs',
  );
});
