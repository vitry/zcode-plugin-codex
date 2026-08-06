// @ts-nocheck
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');
const commands = ['review', 'adversarial-review', 'rescue', 'transfer', 'status', 'result', 'cancel', 'setup'];

test('English and Chinese release docs cover installation, operation, and qualification', () => {
  for (const path of ['README.md', 'README.zh-CN.md']) {
    const source = read(path);
    assert.match(source, /marketplace/i);
    assert.match(source, /Node\.js `>=22\.13\.0`/);
    assert.match(source, /vitry\/zcode-plugin-codex/);
    assert.match(source, /--ref marketplace/);
    assert.match(source, /zcode@vitry/);
    assert.match(source, /0\.16\.1/);
    assert.match(source, /\/Applications\/ZCode\.app\/Contents\/Resources\/glm\/zcode\.cjs/);
    assert.match(source, /ZCODE_SETUP_DEFAULT_MODEL/);
    assert.match(source, /ZCODE_SETUP_MODEL_ALIASES_JSON/);
    assert.match(source, /ZCODE_MODEL_ALIASES.{0,80}(?:ignored|忽略)/i);
    for (const command of commands) assert.match(source, new RegExp(`\\$zcode:${command}`));
    assert.match(source, /permission/i);
    assert.match(source, /PLUGIN_DATA/);
    assert.match(source, /review gate/i);
    assert.match(source, /Linux/i);
    assert.match(source, /Windows/i);
    assert.match(source, /not (?:real-CLI )?qualified/i);
    assert.match(source, /Apache-2\.0/i);
  }
});

test('marketplace catalog and publisher describe an installable vitry snapshot', () => {
  const catalog = JSON.parse(read('marketplace/.agents/plugins/marketplace.json'));
  assert.equal(catalog.name, 'vitry');
  assert.equal(catalog.interface.displayName, 'vitry Codex Plugins');
  assert.deepEqual(catalog.plugins, [{
    name: 'zcode',
    source: { source: 'local', path: './plugins/zcode' },
    policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
    category: 'Developer Tools',
  }]);
  const publisher = read('.github/workflows/publish-marketplace.yml');
  assert.match(publisher, /marketplace/);
  assert.match(publisher, /plugins\/zcode/);
  assert.match(publisher, /npm ci/);
  assert.match(publisher, /npm run check/);
  assert.match(publisher, /build-marketplace-snapshot\.mjs/);
  assert.match(publisher, /MARKETPLACE_SNAPSHOT/);
  assert.match(publisher, /tests\/integration\/package-install\.test\.mjs/);
  assert.match(publisher, /tests\/integration\/marketplace-install\.test\.mjs/);
  assert.match(publisher, /source_ref/);
  assert.match(publisher, /resolved_sha/);
  assert.match(publisher, /github\.event_name/);
  assert.match(publisher, /github\.ref/);
  assert.match(publisher, /refs\/tags\/v/);
  assert.match(publisher, /permissions:\s*\n\s*contents: read/);
  assert.match(publisher, /qualify:\s*\n\s*permissions:\s*\n\s*contents: read/);
  assert.match(publisher, /persist-credentials: false/);
  assert.match(publisher, /publish:\s*\n\s*needs: qualify\s*\n\s*permissions:\s*\n\s*contents: write/);
  assert.match(publisher, /actions\/upload-artifact@v4/);
  assert.match(publisher, /actions\/download-artifact@v4/);
  assert.match(publisher, /snapshot_sha256/);
  assert.match(publisher, /artifact-digest/);
  const publishJob = publisher.slice(publisher.indexOf('\n  publish:'));
  assert.doesNotMatch(publishJob, /npm (?:ci|install|run)|build-marketplace-snapshot|MARKETPLACE_SNAPSHOT/);
  assert.doesNotMatch(publishJob, /inputs\.ref|steps\.source|github\.ref(?:\W|$)/);
  assert.match(publishJob, /github\.event\.repository\.default_branch/);
  assert.match(publishJob, /sha256sum/);
  assert.match(publishJob, /tar -t/);
  assert.match(publishJob, /find .* -type l/);
  assert.ok(publisher.indexOf('npm run check') < publisher.indexOf('\n  publish:'));
  assert.ok(publisher.indexOf('marketplace-install.test.mjs') < publisher.indexOf('\n  publish:'));
  assert.ok(publisher.indexOf('download-artifact') < publisher.indexOf('git push'));
  assert.doesNotMatch(publisher, /GITHUB_REF_NAME/);
  assert.doesNotMatch(publisher, /github\.ref_name/);
});

test('security, changelog, and provenance are release-ready', () => {
  const security = read('SECURITY.md');
  assert.match(security, /privately/i);
  assert.match(security, /caller-context/i);
  assert.match(security, /permission/i);
  const changelog = read('CHANGELOG.md');
  assert.match(changelog, /0\.1\.0/);
  assert.match(changelog, /2026-08-06/);
  const notice = read('NOTICE');
  assert.match(notice, /Copyright 2026 OpenAI/);
  assert.match(notice, /zcode-plugin-cc/);
  assert.match(notice, /Apache License, Version 2\.0/);
  assert.doesNotMatch(notice, /scaffold stage/);
});

test('CI runs full and packed native suites on three platforms and Node 22.13', () => {
  const workflow = read('.github/workflows/ci.yml');
  for (const os of ['ubuntu-latest', 'macos-latest', 'windows-latest']) assert.match(workflow, new RegExp(os));
  assert.match(workflow, /22\.13\.0/);
  assert.match(workflow, /lts\/\*/);
  assert.match(workflow, /npm ci/);
  assert.match(workflow, /npm run check/);
  assert.match(workflow, /tests\/integration\/package-install\.test\.mjs/);
  assert.match(workflow, /fs-native-extensions/);
  assert.match(workflow, /tryLock/);
  assert.doesNotMatch(workflow, /fetch-depth|git diff|git log/);
  const packageTest = read('tests/integration/package-install.test.mjs');
  const marketplaceTest = read('tests/integration/marketplace-install.test.mjs');
  for (const source of [packageTest, marketplaceTest]) {
    assert.match(source, /tool-launch\.mjs/);
    assert.match(source, /runProcess/);
    assert.match(source, /shell:\s*false/);
    assert.doesNotMatch(source, /spawnSync/);
    assert.match(source, /await run\(/);
    assert.doesNotMatch(source, /\.cmd/);
  }
  assert.match(packageTest, /NODE22_BINARY/);
  assert.doesNotMatch(packageTest, /NODE18_BINARY|node@18|Node 18/);
});

test('runtime baseline is Node 22.13 across implementation plans and locking ADR', () => {
  for (const path of [
    'docs/superpowers/plans/2026-08-03-zcode-plugin-codex-implementation.md',
    'docs/superpowers/plans/2026-08-06-runtime-correctness-remediation.md',
    'docs/adr/0009-cross-process-locking.md',
  ]) {
    const source = read(path);
    assert.match(source, /Node(?:\.js)? 22\.13/);
    assert.doesNotMatch(source, /Node(?:\.js)? 18(?:\.18)?/);
  }
});

test('release qualification covers the installed direct bridge and explicit real model', () => {
  const packageJson = JSON.parse(read('package.json')); const qualified = packageJson.scripts['test:qualified'];
  assert.match(qualified, /tests\/e2e\/codex-skills-e2e\.test\.mjs/); assert.match(qualified, /tests\/e2e\/real-zcode\.test\.mjs/);
  assert.match(packageJson.scripts.check, /npm run test:qualified/);
  const real = read('tests/e2e/real-zcode.test.mjs');
  assert.match(real, /ZCODE_REAL_E2E_MODEL\?\.trim\(\)/); assert.match(real, /runCompanion/); assert.match(real, /--model/);
  const installed = read('tests/e2e/codex-skills-e2e.test.mjs');
  assert.match(installed, /codex-skills-unqualified/); assert.match(installed, /exec/); assert.match(installed, /--ephemeral/); assert.match(installed, /--json/); assert.match(installed, /\$zcode:review/); assert.match(installed, /buildMarketplaceSnapshot/);
  const manifest = JSON.parse(read('.codex-plugin/plugin.json')); assert.equal(Object.hasOwn(manifest, 'hooks'), false); assert.ok(JSON.parse(read('hooks/hooks.json')).hooks);
  const companion = read('scripts/zcode-companion.mjs'); assert.match(companion, /startBackgroundWorker/);
  for (const command of commands) {
    const skill = read(`skills/${command}/SKILL.md`);
    assert.doesNotMatch(skill, /FD3|FD4|caller.?context|execution capability/i);
  }
});
