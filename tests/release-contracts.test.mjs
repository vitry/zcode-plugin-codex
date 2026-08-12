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

test('release docs explain progress reporting and supported interruption boundaries', () => {
  const english = read('README.md');
  assert.match(english, /foreground runs? stream(?:s)? ZCode activity/i);
  assert.match(english, /20-second heartbeat/i);
  assert.match(english, /status.{0,100}progress previews/i);
  assert.match(english, /background jobs?.{0,160}(?:do not|does not|won't) automatically cancel/i);
  assert.match(english, /\$zcode:cancel/);
  assert.match(english, /SIGINT.*SIGTERM/i);
  assert.match(english, /session\/stop/);
  assert.match(english, /exact persisted ZCode session/i);
  assert.match(english, /does not claim to (?:stop|kill).{0,100}detached grandchildren/i);

  const chinese = read('README.zh-CN.md');
  assert.match(chinese, /前台运行.{0,80}ZCode 活动/);
  assert.match(chinese, /20 秒.{0,20}心跳/);
  assert.match(chinese, /status.{0,100}进度预览/i);
  assert.match(chinese, /后台任务.{0,160}不会自动取消/);
  assert.match(chinese, /\$zcode:cancel/);
  assert.match(chinese, /SIGINT.*SIGTERM/i);
  assert.match(chinese, /session\/stop/);
  assert.match(chinese, /精确持久化的 ZCode session/);
  assert.match(chinese, /不(?:声称|保证)(?:停止|终止|杀死).{0,100}detached grandchildren/i);
});

test('Unreleased changelog records progress and interruption behavior without a version bump', () => {
  const changelog = read('CHANGELOG.md');
  assert.match(changelog, /foreground activity/i);
  assert.match(changelog, /20-second heartbeat/i);
  assert.match(changelog, /status previews/i);
  assert.match(changelog, /background.{0,120}explicit cancellation/i);
  assert.match(changelog, /SIGINT.*SIGTERM/i);
  assert.match(changelog, /session\/stop/);
  assert.equal(JSON.parse(read('package.json')).version, '0.1.0');
});

test('release docs explain safe orphan settlement without weakening job ownership', () => {
  const english = read('README.md');
  assert.match(english, /SessionEnd.{0,160}best-effort/i);
  assert.match(english, /claimed queued reservation.{0,160}worker lease is held/i);
  assert.match(english, /later Rescue.{0,200}provably orphaned/i);
  assert.match(english, /does not transfer ownership/i);
  assert.match(english, /reservation-time crash fallback.{0,240}held exact worker lease.{0,160}writable guard/i);
  assert.match(english, /exact worker lease is free.{0,240}(?:broker|control channel).{0,80}unavailable.{0,160}failed.{0,160}releases the writable guard/is);
  assert.match(english, /abandonment.{0,100}not confirmed remote stop/is);
  assert.match(english, /reachable broker.{0,160}unacknowledged `session\/stop`.{0,160}keeps the writable guard/is);
  assert.match(english, /\$zcode:status --all.{0,160}redacted/i);

  const chinese = read('README.zh-CN.md');
  assert.match(chinese, /SessionEnd.{0,160}best-effort/i);
  assert.match(chinese, /已 claim 的 queued reservation.{0,160}worker lease/i);
  assert.match(chinese, /后续 Rescue.{0,200}可证明的孤儿/i);
  assert.match(chinese, /不会转移 ownership/i);
  assert.match(chinese, /预留时的崩溃回退.{0,240}持有的精确 worker lease.{0,160}writable guard/i);
  assert.match(chinese, /精确 worker lease 已释放.{0,240}(?:broker|控制通道).{0,80}不可用.{0,160}failed.{0,160}释放 writable guard/is);
  assert.match(chinese, /放弃追踪.{0,100}不代表远端停止已确认/is);
  assert.match(chinese, /broker 仍可连接.{0,160}未确认的 `session\/stop`.{0,160}保留 writable guard/is);
  assert.match(chinese, /\$zcode:status --all.{0,160}脱敏/i);

  const changelog = read('CHANGELOG.md');
  assert.match(changelog, /safe orphan settlement/i);
  assert.match(changelog, /SessionEnd/i);
  assert.match(changelog, /reservation-time crash fallback/i);
  assert.match(changelog, /broker-unavailable orphan.{0,160}failed.{0,160}writable guard/i);
  assert.match(changelog, /unacknowledged stop.{0,160}reachable control channel.{0,160}guard/i);
  assert.equal(JSON.parse(read('package.json')).version, '0.1.0');
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
  const eventBlock = /^on:\n[ ]{2}push:\n[ ]{4}branches: \[main\]\n[ ]{2}pull_request:\n\npermissions:$/m;
  const assertEventBlock = (source) => {
    const normalizedSource = source.replaceAll('\r\n', '\n');
    assert.match(normalizedSource, eventBlock);
    const filteredPullRequestWorkflow = normalizedSource.replace(
      /^([ ]{2}pull_request:)\n/m,
      '$1\n    branches: [main]\n',
    );
    assert.doesNotMatch(filteredPullRequestWorkflow, eventBlock);
  };
  assertEventBlock(workflow);
  assertEventBlock(workflow.replaceAll(/\r?\n/g, '\r\n'));
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
  assert.match(packageTest, /timeoutMs:\s*120_000/);
});

test('required marketplace builder coverage runs explicitly after the default-discovered suite', () => {
  const packageJson = JSON.parse(read('package.json'));
  assert.equal(packageJson.scripts.test, 'node --test && node --test tests/integration/marketplace-snapshot-build.mjs');
  const lightweight = read('tests/marketplace-snapshot.test.mjs');
  const heavy = read('tests/integration/marketplace-snapshot-build.mjs');
  assert.doesNotMatch(lightweight, /cleanRepositoryClone|concurrent snapshot|break dependency lock/);
  assert.match(heavy, /cleanRepositoryClone/);
  assert.match(heavy, /concurrent snapshot one/);
  assert.match(heavy, /break dependency lock/);
  assert.doesNotMatch(heavy, /npm\(\['ci'/);
  const plan = read('docs/superpowers/plans/2026-08-03-zcode-plugin-codex-implementation.md');
  assert.match(plan, /node --test tests\/marketplace-snapshot\.test\.mjs tests\/integration\/marketplace-snapshot-build\.mjs/);
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
  assert.doesNotMatch(qualified, /require-qualified\.cjs/); const required = packageJson.scripts['test:qualification-required']; assert.match(required, /require-qualified\.cjs/); assert.match(read('tests/helpers/require-qualified.cjs'), /ZCODE_REQUIRE_QUALIFIED\s*=\s*['"]1['"]/);
  assert.match(packageJson.scripts.check, /npm run test:qualified/);
  const real = read('tests/e2e/real-zcode.test.mjs');
  assert.match(real, /resolveRealZCodeModelEnvironment/); assert.match(real, /ZCODE_REAL_MODEL_CONFLICT/); assert.match(real, /runCompanion/); assert.match(real, /--model/);
  const realModel = read('tests/helpers/real-zcode-model.mjs');
  assert.match(realModel, /ZCODE_REAL_E2E_MODEL/); assert.match(realModel, /ZCODE_REAL_MODEL/); assert.match(realModel, /deprecatedAliasUsed/);
  const installed = read('tests/e2e/codex-skills-e2e.test.mjs');
  assert.match(installed, /codex-skills-unqualified/); assert.match(installed, /exec/); assert.match(installed, /--ephemeral/); assert.match(installed, /--json/); assert.match(installed, /\$zcode:review/); assert.match(installed, /buildMarketplaceSnapshot/);
  assert.match(installed, /codex-skills-observation/); assert.match(installed, /tui-evidence-not-exposed/); assert.match(installed, /qualificationScope:\s*'tui'/);
  assert.doesNotMatch(installed, /unqualified\(\s*['"]tui-evidence/);
  assert.match(installed, /turn\/steer/); assert.match(installed, /pendingWait/); assert.match(installed, /steering must retain the exact native child ID/);
  assert.match(installed, /target must remain nonterminal before stop acknowledgement/); assert.match(installed, /installed cancel must stop the exact durable remote session/);
  assert.match(installed, /close\('SIGKILL'\)/); assert.match(installed, /the exact installed Codex parent process must be gone before recovery/); assert.match(installed, /must not execute another ZCode turn/);
  assert.match(installed, /qualifyInstalledIdentityFailures/);
  for (const code of ['THREAD_ID_REQUIRED', 'EXECUTOR_IDENTITY_NOT_FOUND', 'EXECUTOR_IDENTITY_EXPIRED', 'EXECUTOR_PARENT_TURN_MISMATCH']) assert.match(installed, new RegExp(code));
  assert.match(installed, /installPrivateCapabilityObserver/); assert.match(installed, /capabilityChecked/); assert.match(installed, /privateExecutionCapability/);
  const manifest = JSON.parse(read('.codex-plugin/plugin.json')); assert.equal(Object.hasOwn(manifest, 'hooks'), false); assert.ok(JSON.parse(read('hooks/hooks.json')).hooks);
  const companion = read('scripts/zcode-companion.mjs'); assert.match(companion, /startBackgroundWorker/);
  for (const command of commands) {
    const skill = read(`skills/${command}/SKILL.md`);
    assert.doesNotMatch(skill, /FD3|FD4|caller.?context|execution capability/i);
  }
});

test('isolated Rescue release guidance states exact inspection, privacy, recovery, and compatibility limits', () => {
  const english = read('README.md');
  const chinese = read('README.zh-CN.md');
  for (const source of [english, chinese]) {
    assert.match(source, /zcode-rescue/);
    assert.match(source, /\/agent/);
    assert.match(source, /\/subagents/);
    assert.match(source, /\/ps/);
    assert.match(source, /96/);
    assert.match(source, /agent_type/);
    assert.match(source, /subscription/i);
    assert.match(source, /uninstall/i);
    assert.match(source, /ZCODE_CODEX_SKILLS_E2E=1 ZCODE_CODEX_RESCUE_E2E=1 ZCODE_REAL_E2E=1 ZCODE_REAL_E2E_MODEL='provider\/model' npm run test:qualification-required/);
    assert.match(source, /ZCODE_REAL_MODEL.{0,120}deprecated|deprecated.{0,120}ZCODE_REAL_MODEL/is);
    assert.match(source, /conflict|冲突/i);
  }
  assert.match(english, /restart Codex.{0,160}rerun `?\$zcode:setup/is);
  assert.match(english, /collision.{0,200}(?:foreign|project|higher-precedence)/is);
  assert.match(english, /truncation.{0,120}not secret redaction/is);
  assert.match(english, /parent thread/i);
  assert.match(english, /child thread/i);
  assert.match(english, /\/ps.{0,180}current(?:ly active)? thread/is);
  assert.match(english, /background semantics remain unchanged/i);
  assert.match(english, /Codex 0\.147/);
  assert.match(english, /unqualified/i);
  assert.match(chinese, /重启 Codex.{0,160}(?:再次|重新)运行 `?\$zcode:setup/is);
  assert.match(chinese, /冲突.{0,200}(?:外部|项目|高优先级|更高优先级)/is);
  assert.match(chinese, /截断.{0,120}不是秘密脱敏/is);
  assert.match(chinese, /父线程/);
  assert.match(chinese, /子线程/);
  assert.match(chinese, /\/ps.{0,180}当前(?:活动)?线程/is);
  assert.match(chinese, /后台语义保持不变/);
  assert.match(chinese, /Codex 0\.147/);
  assert.match(chinese, /unqualified/i);

  const security = read('SECURITY.md');
  assert.match(security, /96-character/);
  assert.match(security, /not secret redaction/i);
  assert.match(security, /managed Role/i);
  assert.match(security, /same-UID/i);
  assert.match(security, /uninstall/i);

  const changelog = read('CHANGELOG.md');
  assert.match(changelog, /managed `zcode-rescue` Role/);
  assert.match(changelog, /semantic progress/);
  assert.match(changelog, /native child/i);

  const setup = read('skills/setup/SKILL.md');
  assert.match(setup, /stable plugin data/i);
  assert.match(setup, /restart Codex/i);
  assert.match(setup, /collision/i);
  const rescue = read('skills/rescue/SKILL.md');
  assert.match(rescue, /\/agent|\/subagents/);
  assert.match(rescue, /\/ps/);
  assert.match(rescue, /96-character/);
  assert.match(rescue, /not secret redaction/i);
  assert.match(rescue, /subscription/i);
  const status = read('skills/status/SKILL.md');
  assert.match(status, /durable/i);
  assert.match(status, /parent|owner/i);
  assert.match(status, /semantic progress/i);
  assert.match(status, /uninstall/i);

  const installedQualification = read('tests/e2e/codex-skills-e2e.test.mjs');
  assert.match(installedQualification, /SUPPORTED_CODEX_LINES\s*=\s*Object\.freeze\(\['0\.147'\]\)/);
  assert.match(installedQualification, /tui-evidence-not-exposed/);
  assert.match(installedQualification, /codex-skills-observation/);
  assert.match(installedQualification, /Object\.hasOwn\(payload, 'qualified'\), false/);
  assert.match(read('tests/e2e/real-zcode.test.mjs'), /real-zcode-unqualified/);
});

test('repository checkout preserves release payloads with LF line endings', () => {
  assert.match(read('.gitattributes'), /^\* text=auto eol=lf\n$/);
});
