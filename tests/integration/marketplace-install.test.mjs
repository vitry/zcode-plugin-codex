// @ts-nocheck
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

import { buildMarketplaceSnapshot } from '../../scripts/build-marketplace-snapshot.mjs';
import { runProcess, terminateProcess } from '../../scripts/lib/process.mjs';
import { codexLaunch, npmLaunch } from '../../scripts/lib/tool-launch.mjs';
import { runChild } from '../helpers/run-child.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const expectedSkills = ['adversarial-review', 'cancel', 'rescue', 'result', 'review', 'setup', 'status', 'transfer'];

async function run(args, cwd, env) {
  const launch = codexLaunch(args, { root, env });
  return runProcess(launch, { cwd, env, timeoutMs: 30_000, maxOutputBytes: 4 * 1024 * 1024 });
}

function listPluginComponents(cwd, env) {
  return new Promise((resolvePromise, reject) => {
    const launch = codexLaunch(['app-server'], { root, env });
    const child = spawn(launch.command, launch.args, { ...launch.options, cwd, env, detached: process.platform !== 'win32', windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let bytes = 0; let settled = false; let skillsResult;
    const timer = setTimeout(() => { void finish(new Error(`plugin component listing timed out: ${stderr}`)); }, 30_000);
    const finish = async (error, value) => {
      if (settled) return; settled = true;
      clearTimeout(timer);
      child.stdin.end();
      await terminateProcess(child, { graceMs: 250 }).catch(() => {});
      error ? reject(error) : resolvePromise(value);
    };
    child.once('error', (error) => { void finish(error); });
    child.once('exit', (code, signal) => { if (!settled) void finish(new Error(`Codex app-server exited before skills/list: ${code ?? signal}`)); });
    child.stderr.on('data', (chunk) => { bytes += chunk.length; stderr = `${stderr}${chunk}`.slice(-8192); if (bytes > 8 * 1024 * 1024) void finish(new Error('skills/list exceeded its output limit')); });
    child.stdout.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > 8 * 1024 * 1024) { void finish(new Error('skills/list exceeded its output limit')); return; }
      stdout += chunk;
      for (;;) {
        const newline = stdout.indexOf('\n');
        if (newline < 0) return;
        const line = stdout.slice(0, newline); stdout = stdout.slice(newline + 1);
        let frame;
        try { frame = JSON.parse(line); } catch { continue; }
        if (frame.id === 1 && frame.result) {
          child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
          child.stdin.write(`${JSON.stringify({ id: 2, method: 'skills/list', params: { cwds: [cwd], forceReload: true } })}\n`);
        } else if (frame.id === 2) {
          if (frame.error) void finish(new Error(`skills/list failed: ${JSON.stringify(frame.error)} ${stderr}`));
          else { skillsResult = frame.result; child.stdin.write(`${JSON.stringify({ id: 3, method: 'hooks/list', params: { cwds: [cwd] } })}\n`); }
        } else if (frame.id === 3) {
          if (frame.error) void finish(new Error(`hooks/list failed: ${JSON.stringify(frame.error)} ${stderr}`));
          else void finish(null, { skills: skillsResult, hooks: frame.result });
        }
      }
    });
    child.stdin.write(`${JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'zcode-marketplace-test', version: '1.0.0' }, capabilities: { experimentalApi: true } } })}\n`);
  });
}

async function findPluginRoots(directory, found = []) {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch { return found; }
  if (entries.some((entry) => entry.name === '.codex-plugin' && entry.isDirectory())) found.push(directory);
  for (const entry of entries) if (entry.isDirectory()) await findPluginRoots(join(directory, entry.name), found);
  return found;
}

test('isolated Codex marketplace lists and installs the eight-skill snapshot', async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), 'zcode-marketplace-install-'));
  t.after(() => rm(temporary, { force: true, recursive: true }));
  const marketplace = process.env.MARKETPLACE_SNAPSHOT
    ? await realpath(process.env.MARKETPLACE_SNAPSHOT)
    : join(temporary, 'marketplace');
  const codexHome = join(temporary, 'codex-home');
  const isolatedHome = join(temporary, 'home');
  await Promise.all([mkdir(codexHome, { recursive: true }), mkdir(isolatedHome, { recursive: true })]);
  if (!process.env.MARKETPLACE_SNAPSHOT) await buildMarketplaceSnapshot({
    root,
    output: marketplace,
    sourceRef: 'test',
    sourceSha: '0'.repeat(40),
    npmExecPath: process.env.NPM_CLI_JS ?? npmLaunch([]).args[0],
    env: process.env,
  });
  const provenance = JSON.parse(await readFile(join(marketplace, '.agents', 'plugins', 'provenance.json'), 'utf8'));
  assert.equal(provenance.packageVersion, JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version);
  assert.equal(provenance.pluginVersion, provenance.packageVersion);
  assert.equal(provenance.sourceRef, process.env.MARKETPLACE_SOURCE_REF ?? 'test');
  assert.equal(provenance.sourceSha, process.env.MARKETPLACE_SOURCE_SHA ?? '0'.repeat(40));
  await assert.rejects(readFile(join(marketplace, 'plugins', 'zcode', 'node_modules', '@openai', 'codex', 'package.json'), 'utf8'), { code: 'ENOENT' });
  await assert.rejects(readFile(join(marketplace, 'plugins', 'zcode', 'tests', 'integration', 'marketplace-install.test.mjs'), 'utf8'), { code: 'ENOENT' });
  const env = { ...process.env, CODEX_HOME: codexHome, HOME: isolatedHome, USERPROFILE: isolatedHome };

  const added = await run(['plugin', 'marketplace', 'add', marketplace, '--json'], temporary, env);
  assert.equal(added.code, 0, added.stderr || added.stdout);
  const addJson = JSON.parse(added.stdout);
  assert.equal(addJson.marketplaceName, 'vitry');

  const listed = await run(['plugin', 'list', '--marketplace', 'vitry', '--available', '--json'], temporary, env);
  assert.equal(listed.code, 0, listed.stderr || listed.stdout);
  assert.deepEqual(JSON.parse(listed.stdout).available.map((entry) => entry.pluginId), ['zcode@vitry']);

  const installed = await run(['plugin', 'add', 'zcode@vitry', '--json'], temporary, env);
  assert.equal(installed.code, 0, installed.stderr || installed.stdout);
  const roots = await findPluginRoots(codexHome);
  const installedRoot = roots.find((path) => basename(join(path, '..', '..')) === 'zcode')
    ?? roots.find((path) => path.includes(`${join('cache', 'vitry', 'zcode')}`));
  assert.ok(installedRoot, `installed plugin root missing under ${codexHome}: ${roots.join(', ')}`);
  assert.deepEqual((await readdir(join(installedRoot, 'skills'), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort(), expectedSkills);
  const installedManifest = JSON.parse(await readFile(join(installedRoot, '.codex-plugin', 'plugin.json'), 'utf8'));
  assert.equal(installedManifest.name, 'zcode');
  assert.equal(Object.hasOwn(installedManifest, 'hooks'), false);
  assert.ok(JSON.parse(await readFile(join(installedRoot, 'hooks', 'hooks.json'), 'utf8')).hooks);
  assert.match(await readFile(join(installedRoot, 'agents', 'zcode-rescue.toml.template'), 'utf8'), /^developer_instructions = """/);
  await assert.rejects(readFile(join(installedRoot, 'agents', 'zcode-rescue.md'), 'utf8'), { code: 'ENOENT' });
  const listedComponents = await listPluginComponents(temporary, env);
  const installedSkills = listedComponents.skills.data.flatMap((entry) => entry.skills)
    .filter((skill) => /^(?:zcode|zcode-plugin-codex):/.test(skill.name));
  assert.deepEqual(installedSkills.map((skill) => skill.name).sort(), expectedSkills.map((name) => `zcode:${name}`).sort());
  assert.ok(installedSkills.every((skill) => skill.enabled === true));
  assert.match(JSON.stringify(listedComponents.hooks), /session-lifecycle-hook|user-prompt-hook/, 'Codex must auto-discover the installed default hooks/hooks.json');
  const nativeBinding = await realpath(join(installedRoot, 'node_modules', 'fs-native-extensions'));
  const installedRootPath = await realpath(installedRoot); const nativeBindingRelative = relative(installedRootPath, nativeBinding);
  assert.ok(nativeBindingRelative && !isAbsolute(nativeBindingRelative) && nativeBindingRelative !== '..' && !nativeBindingRelative.startsWith(`..${sep}`));
  // Keep the installed native binding in a short-lived probe process. Loading
  // it in this test process leaves the Windows .node file locked until the
  // whole test runner exits, which prevents the marketplace cache cleanup.
  const lockProbe = await runChild(process.execPath, ['--input-type=module', '--eval', `
    const { withFileLock } = await import(${JSON.stringify(pathToFileURL(join(installedRoot, 'scripts', 'lib', 'fs.mjs')).href)});
    const result = await withFileLock(${JSON.stringify(join(temporary, 'snapshot-native.lock'))}, async () => 'locked');
    if (result !== 'locked') throw new Error('lock failed');
  `], { cwd: temporary, env });
  assert.equal(lockProbe.code, 0, lockProbe.stderr || lockProbe.stdout);

  const pluginData = join(await realpath(codexHome), 'plugins', 'data', 'zcode-vitry');
  const hookEnv = { ...env };
  const sessionId = 'installed-session'; const turnId = 'installed-turn';
  const lifecycle = await runChild(process.execPath, [join(installedRoot, 'hooks', 'session-lifecycle-hook.mjs')], {
    cwd: temporary, env: hookEnv, ordinaryInput: true,
    input: { session_id: sessionId, cwd: temporary, hook_event_name: 'SessionStart', transcript_path: null, model: 'gpt', permission_mode: 'acceptEdits', source: 'startup' },
  });
  assert.equal(lifecycle.code, 0, lifecycle.stderr || lifecycle.stdout);
  const prompt = await runChild(process.execPath, [join(installedRoot, 'hooks', 'user-prompt-hook.mjs')], {
    cwd: temporary, env: hookEnv, ordinaryInput: true,
    input: { session_id: sessionId, turn_id: turnId, cwd: temporary, hook_event_name: 'UserPromptSubmit', transcript_path: null, model: 'gpt', permission_mode: 'acceptEdits', prompt: '$zcode:status --all' },
  });
  assert.equal(prompt.code, 0, prompt.stderr || prompt.stdout);
  assert.doesNotMatch(prompt.stdout, /ZCODE_CALLER_CONTEXT|callerContext/);
  const direct = await runChild(process.execPath, [join(installedRoot, 'scripts', 'zcode-companion.mjs'), 'invoke', 'status'], {
    cwd: temporary, env: { ...hookEnv, CODEX_THREAD_ID: sessionId },
  });
  assert.equal(direct.code, 0, direct.stderr || direct.stdout);
  assert.equal(direct.stdout, '\nModel policy: default=ZCode default; aliases=none\n');
  assert.equal(direct.internal, '');

  const setupRecord = join(temporary, 'setup-requests.jsonl');
  await writeFile(setupRecord, '');
  const setupConfig = { config: { sandbox_workspace_write: { writable_roots: [] } }, origins: {}, layers: [{ name: { type: 'user', file: join(codexHome, 'config.toml') }, version: 'version-1', config: {} }] };
  const setupConfigured = { config: { sandbox_workspace_write: { writable_roots: [pluginData] } }, origins: {}, layers: [{ name: { type: 'user', file: join(codexHome, 'config.toml') }, version: 'version-2', config: { sandbox_workspace_write: { writable_roots: [pluginData] } } }] };
  const setup = await runChild(process.execPath, [join(installedRoot, 'scripts', 'zcode-companion.mjs'), 'setup'], {
    cwd: temporary,
    env: {
      ...env,
      CODEX_APP_SERVER_PATH: process.execPath,
      CODEX_APP_SERVER_ARGS_JSON: JSON.stringify([join(root, 'tests', 'fixtures', 'fake-codex-app-server.mjs')]),
      FAKE_CODEX_RECORD: setupRecord,
      FAKE_CODEX_CONFIG_RESULTS_JSON: JSON.stringify([setupConfig, setupConfigured]),
    },
  });
  assert.equal(setup.code, 0, setup.stderr || setup.stdout);
  assert.equal(JSON.parse(setup.stdout).status, 'restart-required');
  const setupCalls = (await readFile(setupRecord, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  assert.deepEqual(setupCalls.find((call) => call.method === 'config/batchWrite').params.edits, [{
    keyPath: 'sandbox_workspace_write.writable_roots', value: [pluginData], mergeStrategy: 'replace',
  }]);

  const hookEvents = ['sessionStart', 'userPromptSubmit', 'subagentStart', 'subagentStop', 'stop', 'sessionEnd'];
  const hookScripts = ['session-lifecycle-hook.mjs', 'user-prompt-hook.mjs', 'subagent-hook.mjs', 'subagent-hook.mjs', 'stop-review-gate-hook.mjs', 'session-end-hook.mjs'];
  const installedHooks = hookEvents.map((eventName, index) => ({
    key: `installed-hook-${index}`, currentHash: `${index}`.repeat(64), enabled: true, eventName, handlerType: 'command', source: 'plugin',
    sourcePath: join(installedRoot, 'hooks', 'hooks.json'), trustStatus: 'trusted', pluginId: 'zcode@vitry',
    command: `node "$PLUGIN_ROOT/hooks/${hookScripts[index]}"`,
  }));
  const readyConfig = { config: { features: { hooks: true }, sandbox_workspace_write: { writable_roots: [pluginData] } }, origins: {}, layers: [{ name: { type: 'user', file: join(codexHome, 'config.toml') }, version: 'version-2', config: { sandbox_workspace_write: { writable_roots: [pluginData] } } }] };
  const rerun = await runChild(process.execPath, [join(installedRoot, 'scripts', 'zcode-companion.mjs'), 'setup'], {
    cwd: temporary,
    env: {
      ...env,
      ZCODE_PATH: join(root, 'tests', 'fixtures', 'fake-zcode-cli.mjs'),
      CODEX_APP_SERVER_PATH: process.execPath,
      CODEX_APP_SERVER_ARGS_JSON: JSON.stringify([join(root, 'tests', 'fixtures', 'fake-codex-app-server.mjs')]),
      FAKE_CODEX_RECORD: setupRecord,
      FAKE_CODEX_CONFIG_RESULT: JSON.stringify(readyConfig),
      FAKE_CODEX_HOOKS_RESULT: JSON.stringify({ data: [{ cwd: await realpath(temporary), errors: [], warnings: [], hooks: installedHooks }] }),
      FAKE_ZCODE_RECORD: join(temporary, 'setup-zcode-requests.jsonl'),
    },
  });
  assert.equal(rerun.code, 0, rerun.stderr || rerun.stdout);
  assert.equal(JSON.parse(rerun.stdout).status, 'restart-required');
  const rolePath = join(pluginData, 'agent-roles', 'zcode-rescue.toml');
  assert.match(await readFile(rolePath, 'utf8'), /invoke rescue/);
  assert.doesNotMatch(rolePath, /cache|0\.1\.0/);
  const ended = await runChild(process.execPath, [join(installedRoot, 'hooks', 'session-end-hook.mjs')], {
    cwd: temporary, env: hookEnv, ordinaryInput: true,
    input: { session_id: sessionId, cwd: temporary, hook_event_name: 'SessionEnd', transcript_path: null, reason: 'other' },
  });
  assert.equal(ended.code, 0, ended.stderr || ended.stdout);
  const freshSessionId = 'installed-fresh-session'; const freshTurnId = 'installed-fresh-turn';
  const freshLifecycle = await runChild(process.execPath, [join(installedRoot, 'hooks', 'session-lifecycle-hook.mjs')], {
    cwd: temporary, env: hookEnv, ordinaryInput: true,
    input: { session_id: freshSessionId, cwd: temporary, hook_event_name: 'SessionStart', transcript_path: null, model: 'gpt', permission_mode: 'acceptEdits', source: 'startup' },
  });
  assert.equal(freshLifecycle.code, 0, freshLifecycle.stderr || freshLifecycle.stdout);
  const freshPrompt = await runChild(process.execPath, [join(installedRoot, 'hooks', 'user-prompt-hook.mjs')], {
    cwd: temporary, env: hookEnv, ordinaryInput: true,
    input: { session_id: freshSessionId, turn_id: freshTurnId, cwd: temporary, hook_event_name: 'UserPromptSubmit', transcript_path: null, model: 'gpt', permission_mode: 'acceptEdits', prompt: 'Please verify that ZCode is set up correctly.' },
  });
  assert.equal(freshPrompt.code, 0, freshPrompt.stderr || freshPrompt.stdout);
  const fresh = await runChild(process.execPath, [join(installedRoot, 'scripts', 'zcode-companion.mjs'), 'setup'], {
    cwd: temporary,
    env: {
      ...env,
      ZCODE_PATH: join(root, 'tests', 'fixtures', 'fake-zcode-cli.mjs'),
      CODEX_APP_SERVER_PATH: process.execPath,
      CODEX_APP_SERVER_ARGS_JSON: JSON.stringify([join(root, 'tests', 'fixtures', 'fake-codex-app-server.mjs')]),
      FAKE_CODEX_RECORD: setupRecord,
      FAKE_CODEX_HOOKS_RESULT: JSON.stringify({ data: [{ cwd: await realpath(temporary), errors: [], warnings: [], hooks: installedHooks }] }),
      FAKE_ZCODE_RECORD: join(temporary, 'setup-zcode-requests.jsonl'),
    },
  });
  assert.equal(fresh.code, 0, fresh.stderr || fresh.stdout);
  assert.equal(JSON.parse(fresh.stdout).status, 'ready');
  const workspaceEntries = await readdir(join(pluginData, 'workspaces'));
  assert.equal(workspaceEntries.length, 1);
  assert.equal(JSON.parse(await readFile(join(pluginData, 'workspaces', workspaceEntries[0], 'config', 'review-gate.json'), 'utf8')).setupReady, true);
});
