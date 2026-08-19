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
  assert.match(english, /Rescue child.{0,160}cc-style semantic progress/is);
  assert.match(english, /root.{0,160}fixed coarse liveness updates/is);
  assert.match(english, /terminal exit.{0,120}final stdout/is);
  assert.match(english, /zcode status.{0,120}\$zcode:status.{0,120}\/zcode:status/is);
  assert.match(english, /no job ID or option/is);
  assert.match(english, /Raw PTY.{0,200}credentials.{0,80}capabilities/is);

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
  assert.match(chinese, /Rescue 子 agent.{0,160}cc-style 语义进度/is);
  assert.match(chinese, /root.{0,160}固定的粗粒度存活更新/is);
  assert.match(chinese, /终态退出.{0,120}最终 stdout/is);
  assert.match(chinese, /zcode status.{0,120}\$zcode:status.{0,120}\/zcode:status/is);
  assert.match(chinese, /不接受 job ID 或选项/is);
  assert.match(chinese, /原始 PTY.{0,200}凭据.{0,80}capabilit/is);
});

test('release docs explain automatic Rescue routing and private prepared rollout', () => {
  const english = read('README.md');
  const chinese = read('README.zh-CN.md');
  assert.match(english, /explicit `?\$zcode:rescue`?.{0,180}proactive|proactive.{0,180}explicit `?\$zcode:rescue`/is);
  assert.match(english, /automatic routing.{0,120}no `?--auto`?/i);
  assert.match(english, /private stdin.{0,180}prepared state/is);
  assert.match(english, /raw-capable TTY[\s\S]+task-free readiness[\s\S]+one JSON line[\s\S]+LF/i);
  assert.match(english, /readiness[\s\S]+nonterminal[\s\S]+no (?:EOF|U\+0004)/i);
  assert.match(english, /active `?rescueChildId`?.{0,180}rejoin|rejoin.{0,180}active Rescue child/is);
  assert.match(english, /`currentJobId`.{0,180}durably reserved and published.{0,180}(?:queues|fails|cancelled)/is);
  assert.match(english, /task-independent[^\n]+`zcode_rescue_task`/i);
  assert.doesNotMatch(english, /task-specific native display names/i);
  assert.match(english, /rerun `?\$zcode:setup`?.{0,180}(?:digest|Role upgrade)|(?:digest|Role upgrade).{0,180}rerun `?\$zcode:setup`?/is);
  assert.match(chinese, /显式 `?\$zcode:rescue`?.{0,180}主动|主动.{0,180}显式 `?\$zcode:rescue`/is);
  assert.match(chinese, /自动路由.{0,120}(?:没有|不提供) `?--auto`?/i);
  assert.match(chinese, /私有 stdin.{0,180}prepared state/is);
  assert.match(chinese, /raw-capable TTY[\s\S]+不含 task 的 readiness[\s\S]+一行 JSON[\s\S]+LF/i);
  assert.match(chinese, /readiness[\s\S]+非终态[\s\S]+不发送 (?:EOF|U\+0004)/i);
  assert.match(chinese, /活动的 `?rescueChildId`?.{0,180}重新加入|重新加入.{0,180}活动的 Rescue child/is);
  assert.match(chinese, /`currentJobId`.{0,180}持久预留并发布.{0,180}(?:排队|失败|取消)/is);
  assert.match(chinese, /与任务无关[^\n]+`zcode_rescue_task`/i);
  assert.doesNotMatch(chinese, /任务相关的原生显示名称/);
  assert.match(chinese, /重新运行 `?\$zcode:setup`?.{0,180}(?:digest|Role 升级)|(?:digest|Role 升级).{0,180}重新运行 `?\$zcode:setup`?/is);
});

test('release docs bind Rescue to its owned instance launcher without crossing namespaces', () => {
  const english = read('README.md');
  const chinese = read('README.zh-CN.md');
  const security = read('SECURITY.md');
  const changelog = read('CHANGELOG.md');

  assert.match(english, /source checkout.{0,160}installed plugin.{0,160}intentionally isolated namespaces/is);
  assert.match(english, /`zcode`.{0,120}`zcode-<marketplace>`/is);
  assert.match(english, /owned `?UserPromptSubmit`? hook.{0,180}machine-rendered.{0,100}instance-bound launcher command/is);
  assert.match(english, /exact plugin instance.{0,180}(?:reuse|reuses).{0,100}exact bytes/is);
  assert.match(english, /never.{0,100}`node scripts\/zcode-companion\.mjs`.{0,180}(?:PATH|global package|cache search)/is);
  assert.match(english, /`source-session-unproven`.{0,180}terminal.{0,180}(?:do not|never).{0,100}`?\$zcode:setup`?/is);
  assert.match(english, /launcher error.{0,160}shell-unsafe install path.{0,160}reinstall/is);
  assert.match(english, /does not (?:merge|search|redirect|copy)[\s\S]{0,240}(?:installed|source) namespace/i);
  assert.match(english, /existing installed and source-development data.{0,160}(?:unchanged|same locations)/is);
  assert.match(english, /managed Role digest.{0,160}(?:upgrade-required|rerun `?\$zcode:setup`?)/is);

  assert.match(chinese, /source checkout.{0,160}已安装插件.{0,160}刻意隔离的命名空间/is);
  assert.match(chinese, /`zcode`.{0,120}`zcode-<marketplace>`/is);
  assert.match(chinese, /受管 `?UserPromptSubmit`? hook.{0,180}机器渲染.{0,100}instance-bound launcher command/is);
  assert.match(chinese, /精确插件实例.{0,180}原样复用.{0,100}字节/is);
  assert.match(chinese, /绝不.{0,100}`node scripts\/zcode-companion\.mjs`.{0,180}(?:PATH|全局包|cache 搜索)/is);
  assert.match(chinese, /`source-session-unproven`.{0,180}终态.{0,180}(?:不要|绝不).{0,100}`?\$zcode:setup`?/is);
  assert.match(chinese, /launcher error.{0,160}shell-unsafe 安装路径.{0,160}重新安装/is);
  assert.match(chinese, /不会(?:合并|搜索|重定向|复制)[\s\S]{0,240}(?:已安装|source)命名空间/i);
  assert.match(chinese, /现有已安装数据和 source-development 数据.{0,160}(?:保持不变|原位置)/is);
  assert.match(chinese, /受管 Role digest.{0,160}(?:upgrade-required|重新运行 `?\$zcode:setup`?)/is);

  assert.match(security, /instance-bound launcher.{0,200}owned parent lifecycle context/is);
  assert.match(security, /(?:must not|never).{0,160}(?:cwd-relative|direct companion|PATH|cache search)/is);
  assert.match(security, /(?:must not|never).{0,160}(?:merge|search|redirect|copy).{0,160}namespace/is);
  assert.match(changelog, /instance-bound Rescue launcher/i);
  assert.match(changelog, /source-session-unproven.{0,160}(?:terminal|no setup retry)/is);
  assert.match(changelog, /installed.{0,100}source-development namespaces.{0,160}isolated/is);
});

test('binding ADR defines current status at durable continuation publication', () => {
  const adr = read('docs/adr/0013-bind-rescue-child-to-zcode-session.md');
  assert.match(adr, /`currentJobId`.{0,180}durably reserved and published.{0,180}(?:queues|fails|cancelled)/is);
  assert.doesNotMatch(adr, /advances `currentJobId` only after a successful continuation/i);
});

test('security confines task material to exact single-consume prepared state', () => {
  const security = read('SECURITY.md');
  assert.match(security, /task.{0,180}parent.{0,120}write_stdin/is);
  for (const term of ['session', 'turn', 'workspace', 'executor', 'single consume', 'expiry', 'cleanup']) {
    assert.match(security, new RegExp(term, 'i'));
  }
  assert.match(security, /(?:must not|never)[\s\S]+argv[\s\S]+environment[\s\S]+output[\s\S]+log[\s\S]+artifact[\s\S]+child/i);
  assert.match(security, /raw mode[\s\S]+before[^\n]+readiness[\s\S]+before[^\n]+task bytes/i);
  assert.match(security, /tool output[\s\S]+(?:must not|never)[^\n]+payload/i);
  assert.doesNotMatch(security, /session history cleanup|conversation history cleanup/i);
  const changelog = read('CHANGELOG.md');
  assert.match(changelog, /automatic proactive Rescue routing/i);
  assert.match(changelog, /private stdin.{0,180}prepared state/is);
  assert.match(changelog, /active-child rejoin/i);
  assert.match(changelog, /raw TTY readiness[\s\S]+without EOF/i);
});

test('Unreleased changelog records progress and interruption behavior without a version bump', () => {
  const changelog = read('CHANGELOG.md');
  assert.match(changelog, /foreground activity/i);
  assert.match(changelog, /20-second heartbeat/i);
  assert.match(changelog, /status previews/i);
  assert.match(changelog, /background.{0,120}explicit cancellation/i);
  assert.match(changelog, /SIGINT.*SIGTERM/i);
  assert.match(changelog, /session\/stop/);
  assert.match(changelog, /cc-style semantic progress/i);
  assert.match(changelog, /fixed coarse root liveness/i);
  assert.match(changelog, /terminal exit.{0,100}final stdout/i);
  assert.match(changelog, /bound no-argument status sidecar/i);
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
  assert.equal(packageJson.scripts.test, 'node --test --test-concurrency=1 && node --test tests/integration/marketplace-snapshot-build.mjs');
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
  assert.match(english, /writable.{0,80}root.{0,160}restart Codex.{0,160}rerun `?\$zcode:setup/is);
  assert.match(english, /collision.{0,200}(?:foreign|project|higher-precedence)/is);
  assert.match(english, /truncation.{0,120}not secret redaction/is);
  assert.match(english, /parent thread/i);
  assert.match(english, /child thread/i);
  assert.match(english, /\/ps.{0,180}current(?:ly active)? thread/is);
  assert.match(english, /background semantics remain unchanged/i);
  assert.match(english, /Codex 0\.147/);
  assert.match(english, /unqualified/i);
  assert.match(chinese, /writable root.{0,160}重启 Codex.{0,160}(?:再次|重新)运行 `?\$zcode:setup/is);
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
  assert.match(setup, /writable.{0,80}root.{0,160}restart Codex/is);
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

test('release guidance documents exact stopped-child binding, lifecycle, upgrade, and legacy behavior bilingually', () => {
  const english = read('README.md'); const chinese = read('README.zh-CN.md');
  for (const source of [english, chinese]) {
    assert.match(source, /anchorJobId|anchor job/i);
    assert.match(source, /currentJobId|current job/i);
    assert.match(source, /same (?:stopped )?(?:Rescue )?child|同一(?:个)?已停止的 Rescue child/i);
    assert.match(source, /no second `?SubagentStart`?|不会.*第二次 `?SubagentStart`?/i);
    assert.match(source, /legacy[\s\S]+(?:adopt|采用|接纳)/i);
    assert.match(source, /permission[\s\S]+fresh|权限[\s\S]+fresh/i);
    assert.match(source, /SessionEnd[\s\S]+(?:close|关闭)/i);
    assert.match(source, /invalid[\s\S]+binding[\s\S]+fail closed|无效[\s\S]+binding[\s\S]+fail closed/i);
    assert.match(source, /upgrade-required|升级.*required|需要升级/i);
  }
  const security = read('SECURITY.md'); const changelog = read('CHANGELOG.md'); const adr = read('docs/adr/0013-bind-rescue-child-to-zcode-session.md');
  assert.match(security, /durable Rescue binding[\s\S]+same stopped child[\s\S]+exact ZCode session/i);
  assert.match(security, /private[\s\S]+anchorJobId[\s\S]+currentJobId/i);
  assert.match(changelog, /exact stopped-child Rescue continuation/i);
  assert.match(changelog, /no second `?SubagentStart`?/i);
  assert.match(adr, /^---\nstatus: accepted\nsupersedes: stopped-rescue-choice-continuation-in-adr-0010\n---/);
  assert.match(adr, /invoke-prepared rescue[\s\S]+same stopped child[\s\S]+anchorJobId[\s\S]+currentJobId/i);
  assert.match(adr, /legacy[\s\S]+permission[\s\S]+SessionEnd[\s\S]+fail closed/i);
});

test('release package ships receipt-gated manual uninstall guidance', () => {
  const guidePath = 'docs/manual-uninstall.md';
  const english = read('README.md');
  const chinese = read('README.zh-CN.md');
  const guide = read(guidePath);
  const [englishGuide, chineseGuide] = guide.split('\n---\n');
  const packageJson = JSON.parse(read('package.json'));

  for (const source of [english, chinese]) assert.match(source, /\[.*(?:uninstall|卸载|清理).*\]\(docs\/manual-uninstall\.md\)/i);
  assert.ok(packageJson.files.includes(guidePath));
  assert.equal(packageJson.files.filter((entry) => entry === guidePath).length, 1);

  assert.match(guide, /no plugin uninstall lifecycle hook/i);
  assert.match(guide, /没有插件卸载生命周期 hook/i);
  assert.match(guide, /settle or cancel.{0,120}active jobs/is);
  assert.match(guide, /结束或取消.{0,120}活动任务/is);
  assert.match(guide, /plugin\.identity.{0,160}configTarget\.filePath.{0,160}role\.path.{0,160}role\.sha256/is);
  assert.match(guide, /agents\.zcode-rescue/);
  for (const section of [englishGuide, chineseGuide]) {
    assert.match(section, /features\.multi_agent_v2\.hide_spawn_agent_metadata/);
    assert.match(section, /features\.multi_agent_v2\.hide_spawn_agent_metadata\s*=\s*false/);
    assert.match(section, /numeric-v1/i);
    assert.doesNotMatch(section, /`features\.hide_spawn_agent_metadata`/);
  }
  assert.match(guide, /never (?:remove|delete).{0,160}(?:true|project layer|foreign|unproven)/is);
  assert.match(guide, /绝不(?:移除|删除).{0,160}(?:true|项目层|外部|无法证明)/is);
  for (const category of ['jobs/', 'job-owners/', 'job-specs/', 'prompts/', 'results/', 'progress', 'logs', 'history']) assert.match(guide, new RegExp(category.replace('/', '\\/'), 'i'));
  assert.match(guide, /retained by default/i);
  assert.match(guide, /默认保留/);
  assert.match(guide, /replac(?:e|ing) the plugin source.{0,200}run `?\$zcode:setup`? once/is);
  assert.match(guide, /替换插件源.{0,200}(?:运行|执行)一次 `?\$zcode:setup`?/is);
  assert.match(guide, /writable-root bootstrap.{0,120}only separate restart/is);
  assert.match(guide, /仅.{0,120}writable-root bootstrap.{0,120}重启/is);
  assert.match(guide, /uninstalling the plugin files alone.{0,160}(?:leaves|does not remove)/is);
});

test('manual cleanup separates disposable runtime state from retained history', () => {
  const guide = read('docs/manual-uninstall.md');
  const [english, chinese] = guide.split('\n---\n');
  for (const section of [english, chinese]) {
    for (const path of [
      'identity/', 'hook-state/', 'invocations/', 'broker/', 'gate-runs/',
      'cancel-attempts/', 'cancel-attempt-locks/', 'cancel-locks/', 'worker-leases/',
      '.state.lock', '.artifacts.lock', 'config/review-gate.json',
    ]) assert.match(section, new RegExp(path.replaceAll('.', '\\.').replaceAll('/', '\\/')));
    for (const path of ['jobs/', 'job-owners/', 'job-specs/', 'prompts/', 'results/']) {
      assert.match(section, new RegExp(path.replace('/', '\\/')));
    }
    assert.match(section, /persisted progress|持久 progress/i);
    assert.match(section, /logs?\/history|日志.{0,40}历史|logs?.{0,20}history/i);
  }
  assert.match(english, /after all jobs and (?:plugin )?processes have stopped.{0,120}selectively remove/is);
  assert.match(english, /retain.{0,240}jobs\/.{0,240}job-specs\/.{0,240}prompts\/.{0,240}results\//is);
  assert.match(english, /config\/review-gate\.json.{0,160}setup preference.{0,80}readiness.{0,80}not.{0,80}(?:lock|job history)/is);
  assert.match(chinese, /所有任务和.{0,40}进程.{0,40}停止.{0,120}选择性移除/is);
  assert.match(chinese, /保留.{0,240}jobs\/.{0,240}job-specs\/.{0,240}prompts\/.{0,240}results\//is);
  assert.match(chinese, /config\/review-gate\.json.{0,160}setup.{0,80}(?:偏好|配置).{0,80}readiness.{0,80}不是.{0,80}(?:锁|job 历史)/is);
});

test('manual cleanup covers unreceipted shared setup configuration conservatively', () => {
  const guide = read('docs/manual-uninstall.md');
  const [english, chinese] = guide.split('\n---\n');
  for (const section of [english, chinese]) {
    assert.match(section, /sandbox_workspace_write\.writable_roots/);
    assert.match(section, /features\.hooks/);
    assert.match(section, /hooks\.state/);
    assert.match(section, /current.{0,80}receipt|当前.{0,80}收据/is);
    assert.match(section, /prior-value ownership|先前值.{0,40}所有权|原值.{0,40}所有权/i);
    assert.match(section, /exact(?:ly)? match|精确匹配/i);
    assert.match(section, /no other consumer|没有其他消费者|无其他消费者/i);
  }
  assert.match(english, /features\.hooks.{0,240}(?:leave|remain|keep|stays?).{0,120}unless.{0,160}independently determines?.{0,80}(?:hooks are )?unused/is);
  assert.match(chinese, /features\.hooks.{0,240}(?:保留|保持).{0,120}除非.{0,160}独立确认.{0,80}(?:不再使用|未使用)/is);
  assert.doesNotMatch(guide, /receipt (?:proves|authorizes).{0,160}(?:writable_roots|features\.hooks|hooks\.state)/is);
});

test('manual cleanup requires job settlement before uninstall and gives a safe recovery path', () => {
  const guide = read('docs/manual-uninstall.md');
  const [english, chinese] = guide.split('\n---\n');
  assert.match(english, /before uninstalling.{0,200}(?:status|result|cancel)/is);
  assert.match(english, /temporarily reinstall.{0,160}trusted.{0,80}version-compatible source/is);
  assert.match(english, /same plugin identity/is);
  assert.match(english, /resume the exact original owning Codex session.{0,160}canonical workspace/is);
  assert.match(english, /new (?:Codex )?session.{0,80}(?:is|remains) insufficient/is);
  assert.match(english, /original (?:owning )?session cannot be resumed.{0,200}only.{0,80}verified external ZCode control path/is);
  assert.match(english, /retain.{0,120}uncertain recovery state/is);
  assert.match(chinese, /卸载前.{0,200}(?:status|result|cancel)/is);
  assert.match(chinese, /已经卸载|已经移除/);
  assert.match(chinese, /临时重新安装/);
  assert.match(chinese, /可信.{0,80}版本兼容的源/is);
  assert.match(chinese, /相同插件 identity/);
  assert.match(chinese, /恢复精确的原 owning Codex session.{0,160}canonical workspace/is);
  assert.match(chinese, /新(?:的 )?Codex session.{0,80}(?:不足|不够)/is);
  assert.match(chinese, /无法恢复原 owning session.{0,200}只能.{0,80}外部已验证的 ZCode 控制路径/is);
  assert.match(chinese, /保留.{0,120}不确定的恢复状态/is);
});

test('current docs assign spawn schema ownership to Codex and supersede the historical Role lifecycle', () => {
  for (const path of ['README.md', 'README.zh-CN.md', 'skills/setup/SKILL.md']) {
    const source = read(path);
    assert.match(source, /Codex host.{0,120}(?:owns|管理|负责).{0,120}(?:collaboration tool schema|协作工具 schema)/is);
    assert.match(source, /does not own|不拥有/i);
    assert.match(source, /hide_spawn_agent_metadata/);
    assert.match(source, /one setup|一次 setup|一次 `?\$zcode:setup/i);
    assert.match(source, /numeric-v1/i);
    assert.doesNotMatch(source, /Role install.{0,160}restart|Role 安装.{0,160}重启/is);
  }
  const design = read('docs/superpowers/specs/2026-08-09-rescue-native-subagent-progress-design.md');
  assert.match(design, /superseded/i);
  assert.match(design, /2026-08-13-remove-spawn-metadata-override-design\.md/);
  assert.match(read('SECURITY.md'), /receipt.{0,200}fail closed.{0,200}(?:foreign|project)/is);
  assert.match(read('CHANGELOG.md'), /hide_spawn_agent_metadata.{0,200}numeric-v1/is);
});

test('repository and CI enforce the LF line-ending constitution', () => {
  assert.match(read('.gitattributes'), /^\* text=auto eol=lf\n$/);
  const adr = read('docs/adr/0012-enforce-lf-line-endings.md');
  assert.match(adr, /Git-tracked text files/i);
  assert.match(adr, /generated marketplace/i);
  assert.match(adr, /CRLF.{0,120}(?:runtime|test)/is);

  const packageJson = JSON.parse(read('package.json'));
  assert.equal(packageJson.scripts['check:line-endings'], 'node scripts/check-line-endings.mjs');
  assert.match(packageJson.scripts.check, /^npm run check:line-endings && npm run lint/);

  const workflow = read('.github/workflows/ci.yml');
  const installIndex = workflow.indexOf('- run: npm ci');
  const lineEndingIndex = workflow.indexOf('- name: Enforce LF line endings');
  const checkIndex = workflow.indexOf('- run: npm run check');
  assert.ok(installIndex >= 0 && installIndex < lineEndingIndex && lineEndingIndex < checkIndex);
  assert.match(workflow.slice(lineEndingIndex, checkIndex), /run: npm run check:line-endings/);
});
