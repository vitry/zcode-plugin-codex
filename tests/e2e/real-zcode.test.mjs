// @ts-nocheck
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { access, cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { diagnoseZCodeAuth } from '../../scripts/lib/codex-config.mjs';
import { managedRolePaths, MANAGED_ROLE_DESCRIPTION, renderManagedRescueRole } from '../../scripts/lib/managed-agent-role.mjs';
import { createZCodeClient } from '../../scripts/lib/zcode-client.mjs';
import { discoverZCode } from '../../scripts/lib/zcode-discovery.mjs';
import { resolveWorkspaceStorage } from '../../scripts/lib/workspace.mjs';
import { resolveRealZCodeModelEnvironment } from '../helpers/real-zcode-model.mjs';
import { runChild } from '../helpers/run-child.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const fakeCodex = join(root, 'tests', 'fixtures', 'fake-codex-app-server.mjs');
const fakeZCode = join(root, 'tests', 'fixtures', 'fake-zcode-cli.mjs');
const prepareTtyShim = new URL('../fixtures/prepare-tty-shim.mjs', import.meta.url).href;
const dependencyNodeModules = dirname(dirname(createRequire(import.meta.url).resolve('fs-native-extensions/package.json')));

let modelEnvironment; let modelEnvironmentFailure;
try { modelEnvironment = resolveRealZCodeModelEnvironment(process.env); }
catch (error) {
  if (error?.code !== 'ZCODE_REAL_MODEL_CONFLICT') throw error;
  modelEnvironmentFailure = unqualified('model-environment-conflict', error.message);
}
const requestedModel = modelEnvironment?.model;
const qualificationRequired = process.env.ZCODE_REQUIRE_QUALIFIED === '1';
const skipReason = modelEnvironmentFailure || (process.env.ZCODE_REAL_E2E !== '1'
  ? unqualified('opt-in-required', 'Set ZCODE_REAL_E2E=1 on an authenticated macOS ZCode installation.')
  : process.platform !== 'darwin'
    ? unqualified('platform-unsupported', 'macOS is the only real-CLI-qualified platform.')
    : !requestedModel
      ? unqualified('model-required', 'Set a non-empty ZCODE_REAL_E2E_MODEL.')
      : false);

function unqualified(code, detail) { return `real-zcode-unqualified ${JSON.stringify({ qualified: false, code, detail })}`; }

test('real qualification preflight proves the installed origin-to-worktree authority path before spending ZCode credits', async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), 'zcode-real-authority-preflight-'));
  const originDirectory = join(temporary, 'origin'); const executionDirectory = join(temporary, 'execution');
  await mkdir(originDirectory); await runGit(['init', '-q'], originDirectory); await writeFile(join(originDirectory, 'fixture.txt'), 'base\n');
  await runGit(['add', 'fixture.txt'], originDirectory); await runGit(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'base'], originDirectory);
  await runGit(['worktree', 'add', '-qb', 'real-preflight-target', executionDirectory], originDirectory);
  const observed = await establishInstalledWorkspaceBoundTurn({ temporary, dataRoot: join(temporary, 'plugin-data'),
    originWorkspace: await realpath(originDirectory), executionWorkspace: await realpath(executionDirectory) });
  t.after(async () => { await observed.cleanup(); await rm(temporary, { recursive: true, force: true }); });
  assert.equal(observed.active.originWorkspace, await realpath(originDirectory));
  assert.equal(observed.active.executionWorkspace, await realpath(executionDirectory));
  assert.equal(observed.roleMutated, false);
  await observed.startChild('real-preflight-child');
  const first = await observed.invokePrepared({ childId: 'real-preflight-child', zcodePath: fakeZCode }); assert.equal(first.code, 0, first.stderr || first.stdout);
  await observed.stopChild('real-preflight-child'); await observed.prepareProactive({ task: 'continue preflight' });
  const second = await observed.invokePrepared({ childId: 'real-preflight-child', zcodePath: fakeZCode }); assert.equal(second.code, 0, second.stderr || second.stdout);
  const jobs = await readBoundJobs(join(temporary, 'plugin-data'), await realpath(executionDirectory));
  assert.equal(jobs.length, 2); assert.equal(new Set(jobs.map((job) => job.zcodeSessionId)).size, 1);
});

test('real ZCode discovery, two-turn session, read-only Companion, cancellation, model, and history import', {
  skip: qualificationRequired ? false : skipReason,
  timeout: 420_000,
}, async (t) => {
  if (skipReason) assert.fail(skipReason);
  const temporary = await mkdtemp(join(tmpdir(), 'zcode-real-e2e-'));
  const originDirectory = join(temporary, 'origin'); const executionDirectory = join(temporary, 'execution');
  await mkdir(originDirectory);
  await runGit(['init', '-q'], originDirectory);
  await writeFile(join(originDirectory, 'fixture.txt'), 'base\n');
  await runGit(['add', 'fixture.txt'], originDirectory);
  await runGit(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'base'], originDirectory);
  await runGit(['worktree', 'add', '-qb', 'real-zcode-target', executionDirectory], originDirectory);
  const originWorkspace = await realpath(originDirectory); const executionWorkspace = await realpath(executionDirectory);
  const sessions = new Set();
  let client; let boundTurn;
  t.after(async () => {
    if (client) {
      for (const sessionId of sessions) await client.stopSession(sessionId, 10_000).catch(() => {});
      await client.close().catch(() => {});
    }
    if (boundTurn) await boundTurn.cleanup().catch(() => {});
    await rm(temporary, { force: true, recursive: true });
  });
  const discovery = await discoverZCode({ explicitPath: process.env.ZCODE_PATH, env: process.env });
  assert.match(discovery.version, /^\d+\.\d+\.\d+/);
  assert.deepEqual(await diagnoseZCodeAuth({
    workspace: executionWorkspace,
    discovery,
    env: process.env,
    requestTimeoutMs: 30_000,
  }), { ready: true, status: 'authenticated' });

  const dataRoot = join(temporary, 'plugin-data');
  const firstPrompt = 'Inspect only this empty temporary workspace. Do not write files or run mutating commands. Reply with a short acknowledgement.';
  const secondPrompt = 'Continue in this exact session. Inspect only and reply with a second short acknowledgement distinct from the first.';
  boundTurn = await establishInstalledWorkspaceBoundTurn({ temporary, dataRoot, originWorkspace, executionWorkspace, initialTask: firstPrompt, model: requestedModel });
  assert.equal(boundTurn.active.executionWorkspace, executionWorkspace);
  assert.equal(boundTurn.roleMutated, false);
  const childId = 'real-zcode-rescue-child'; await boundTurn.startChild(childId);
  const firstInvoke = await boundTurn.invokePrepared({ childId, zcodePath: discovery.path });
  assert.equal(firstInvoke.code, 0, firstInvoke.stderr || firstInvoke.stdout); assert.ok(firstInvoke.stdout.trim());
  const [firstJob] = await readBoundJobs(dataRoot, executionWorkspace);
  assert.equal(firstJob.workspace, executionWorkspace); assert.equal(firstJob.status, 'succeeded'); assert.ok(firstJob.zcodeSessionId); assert.ok(firstJob.inputId);

  client = await createZCodeClient({
    workspace: executionWorkspace,
    launch: discovery.launch,
    env: process.env,
    requestTimeoutMs: 30_000,
    completionTimeoutMs: 180_000,
  });
  client.setPermissionHandler((request) => {
    const denied = request.options.find((option) => option.response?.decision === 'deny');
    assert.ok(denied, 'every real E2E permission request must offer an exact deny response');
    return denied.response;
  });

  const sessionId = firstJob.zcodeSessionId;
  sessions.add(sessionId);
  const firstCompleted = await client.readSession(sessionId);
  const firstAssistantResults = visibleAssistantResultsForTurn(firstCompleted, firstJob.inputId, new Set(firstJob.beforeMessageIds), firstPrompt);
  assert.ok(firstAssistantResults.length >= 1, 'the first installed bound turn must expose a non-empty assistant result');
  await boundTurn.stopChild(childId);
  await boundTurn.prepareProactive({ task: secondPrompt, model: requestedModel });
  const secondInvoke = await boundTurn.invokePrepared({ childId, zcodePath: discovery.path });
  assert.equal(secondInvoke.code, 0, secondInvoke.stderr || secondInvoke.stdout); assert.ok(secondInvoke.stdout.trim());
  const jobs = await readBoundJobs(dataRoot, executionWorkspace); assert.equal(jobs.length, 2);
  const secondJob = jobs[1]; assert.equal(secondJob.zcodeSessionId, sessionId); assert.notEqual(secondJob.inputId, firstJob.inputId);
  const secondCompleted = await client.readSession(sessionId);
  const secondAssistantResults = visibleAssistantResultsForTurn(secondCompleted, secondJob.inputId, new Set(secondJob.beforeMessageIds), secondPrompt);
  assert.ok(secondAssistantResults.length >= 1, 'the second installed bound turn must expose a new non-empty assistant result');
  assert.ok(secondAssistantResults.every((message) => !new Set(firstAssistantResults.map((entry) => entry.info.messageId)).has(message.info.messageId)));
  assert.ok(secondAssistantResults.some((message) => !new Set(firstAssistantResults.map(visibleAssistantText)).has(visibleAssistantText(message))));
  assert.equal(JSON.parse(await readFile(boundTurn.activePath, 'utf8')).executionWorkspace, executionWorkspace);

  const cancellation = await client.createSession({ workspace: executionWorkspace });
  const cancellationId = cancellation.session.sessionId;
  sessions.add(cancellationId);
  let permissionReachedResolve; const permissionReached = new Promise((resolve) => { permissionReachedResolve = resolve; });
  let permissionAbortedResolve; const permissionAborted = new Promise((resolve) => { permissionAbortedResolve = resolve; });
  client.setPermissionHandler((request, signal) => {
    const denied = request.options.find((option) => option.response?.decision === 'deny');
    assert.ok(denied, 'the remote cancellation barrier must offer an exact deny response');
    permissionReachedResolve(request);
    return new Promise((_, reject) => signal.addEventListener('abort', () => { permissionAbortedResolve(); reject(new Error('turn stopped')); }, { once: true }));
  });
  const active = await client.send(cancellationId, 'Attempt to create cancellation-probe.txt using a write or shell tool. Do not merely explain and do not try an alternative.');
  assert.equal(active.accepted, true);
  const remotePermission = await boundedBarrier(permissionReached, 'remote permission request');
  assert.equal(remotePermission.sessionId, cancellationId);
  assert.equal(client.turnState(cancellationId), 'armed');
  await assert.rejects(client.send(cancellationId, 'This second send must be rejected while the first turn is active.'), { code: 'ZCODE_TURN_ACTIVE' });
  // ZCode Protocol 0.16.1 exposes a successful object acknowledgement, not a
  // remote "cancelled" terminal enum. The strongest exact invariant is that
  // the accepted turn is armed before that ack and absent immediately after it.
  const stopped = await client.stopSession(cancellationId, 10_000);
  assert.ok(stopped && typeof stopped === 'object' && !Array.isArray(stopped));
  await boundedBarrier(permissionAborted, 'permission abort after stop');
  assert.equal(client.turnState(cancellationId), null);
  await assert.rejects(client.waitForCompletion(cancellationId, 10_000), { code: 'ZCODE_PROTOCOL_INPUT_INVALID' });
  await assert.rejects(access(join(executionWorkspace, 'cancellation-probe.txt')), { code: 'ENOENT' });
  client.setPermissionHandler((request) => {
    const denied = request.options.find((option) => option.response?.decision === 'deny');
    assert.ok(denied); return denied.response;
  });
  sessions.delete(cancellationId);

  await client.stopSession(sessionId, 10_000);
  sessions.delete(sessionId);

  const imported = await client.createSession({
    workspace: executionWorkspace,
    importedHistory: { messages: [
      { role: 'user', content: 'Synthetic Codex user turn.' },
      { role: 'assistant', content: 'Synthetic Codex assistant turn.' },
    ] },
  });
  const importedId = imported.session.sessionId;
  sessions.add(importedId);
  const history = await client.readSession(importedId);
  assert.ok(history.messages.some((message) => message.info?.role === 'user'));
  assert.ok(history.messages.some((message) => message.info?.role === 'assistant'));
  await client.stopSession(importedId, 10_000);
  sessions.delete(importedId);
});

test('visible assistant result selection is linked to the exact accepted input or its sole prompt-matching persisted user root', () => {
  const snapshot = { messages: [
    { info: { role: 'assistant', messageId: 'assistant-first', parentMessageId: 'input-first' }, parts: [{ type: 'text', text: 'first' }] },
    { info: { role: 'assistant', messageId: 'assistant-empty', parentMessageId: 'input-second' }, parts: [{ type: 'text', text: '   ' }] },
    { info: { role: 'assistant', messageId: 'assistant-second', parentMessageId: 'input-second' }, parts: [{ type: 'text', text: 'second' }] },
  ] };
  assert.deepEqual(visibleAssistantResultsForTurn(snapshot, 'input-second', new Set()).map((message) => message.info.messageId), ['assistant-second']);
  assert.deepEqual(visibleAssistantResultsForTurn(snapshot, 'input-missing', new Set()), []);
  const remapped = { messages: [
    { info: { role: 'user', messageId: 'persisted-root', semantics: { origin: 'real_user', kind: 'user_prompt', uiVisibility: 'visible' } }, parts: [{ type: 'text', text: 'prompt' }] },
    { info: { role: 'assistant', messageId: 'persisted-result', parentMessageId: 'persisted-root' }, parts: [{ type: 'text', text: 'result' }] },
  ] };
  assert.deepEqual(visibleAssistantResultsForTurn(remapped, 'unpersisted-input', new Set(), 'prompt').map((message) => message.info.messageId), ['persisted-result']);
  assert.deepEqual(visibleAssistantResultsForTurn(remapped, 'unpersisted-input', new Set(), 'wrong prompt'), []);
  const stale = structuredClone(remapped);
  stale.messages[0].info.createdAt = '2026-08-21T00:00:00.000Z';
  assert.deepEqual(visibleAssistantResultsForTurn(stale, 'unpersisted-input', new Set(['persisted-root']), 'prompt'), []);
  const unrelated = structuredClone(remapped);
  unrelated.messages.unshift({ info: { role: 'user', messageId: 'unrelated-real-root', semantics: { origin: 'real_user', kind: 'user_prompt', uiVisibility: 'visible' } }, parts: [{ type: 'text', text: 'unrelated prompt' }] });
  assert.deepEqual(visibleAssistantResultsForTurn(unrelated, 'unpersisted-input', new Set(), 'prompt'), []);
  remapped.messages.push({ info: { role: 'user', messageId: 'ambiguous-root', semantics: { origin: 'real_user', kind: 'user_prompt', uiVisibility: 'visible' } }, parts: [{ type: 'text', text: 'other' }] });
  assert.deepEqual(visibleAssistantResultsForTurn(remapped, 'unpersisted-input', new Set(), 'prompt'), []);
  const unmarked = structuredClone(remapped); unmarked.messages = unmarked.messages.slice(0, 2); delete unmarked.messages[0].info.semantics;
  assert.deepEqual(visibleAssistantResultsForTurn(unmarked, 'unpersisted-input', new Set()), []);
  for (const origin of ['system', 'migration']) {
    const foreign = structuredClone(unmarked); foreign.messages[0].info.semantics = { origin, kind: 'user_prompt', uiVisibility: 'visible' };
    assert.deepEqual(visibleAssistantResultsForTurn(foreign, 'unpersisted-input', new Set()), []);
  }
  const hidden = structuredClone(snapshot); hidden.messages[2].info.semantics = { origin: 'agent_runtime', kind: 'assistant_response', uiVisibility: 'hidden' };
  assert.deepEqual(visibleAssistantResultsForTurn(hidden, 'input-second', new Set()), []);
  const wrongKind = structuredClone(snapshot); wrongKind.messages[2].info.semantics = { origin: 'agent_runtime', kind: 'timeline_event', uiVisibility: 'visible' };
  assert.deepEqual(visibleAssistantResultsForTurn(wrongKind, 'input-second', new Set()), []);
});

function visibleAssistantResultsForTurn(session, inputId, beforeMessageIds, acceptedPrompt) {
  if (typeof inputId !== 'string' || inputId.length === 0 || !(beforeMessageIds instanceof Set) || !Array.isArray(session?.messages)
    || acceptedPrompt !== undefined && (typeof acceptedPrompt !== 'string' || acceptedPrompt.length === 0)) return [];
  const newMessages = session.messages.filter((message) => typeof message?.info?.messageId === 'string' && !beforeMessageIds.has(message.info.messageId));
  const directlyLinked = newMessages.some((message) => visibleAssistant(message, inputId));
  let parentMessageId = inputId;
  if (!directlyLinked) {
    const roots = newMessages.filter((message) => message?.info?.role === 'user' && message.info.synthetic !== true
      && message.info.visibility !== 'model-only' && message.info.source === undefined
      && message.info.semantics?.origin === 'real_user' && message.info.semantics.kind === 'user_prompt'
      && message.info.semantics.uiVisibility === 'visible');
    if (roots.length !== 1) return [];
    if (acceptedPrompt === undefined || visibleMessageText(roots[0]) !== acceptedPrompt) return [];
    parentMessageId = roots[0].info.messageId;
  }
  return newMessages.filter((message) => visibleAssistant(message, parentMessageId));
}

function visibleAssistant(message, parentMessageId) {
  const semantics = message?.info?.semantics;
  return message?.info?.role === 'assistant' && message.info.parentMessageId === parentMessageId
    && typeof message.info.messageId === 'string' && message.info.messageId.length > 0
    && (semantics === undefined || semantics.origin === 'agent_runtime' && semantics.kind === 'assistant_response' && semantics.uiVisibility === 'visible')
    && message.parts?.some((part) => part?.type === 'text' && typeof part.text === 'string' && part.text.trim());
}

function visibleAssistantText(message) {
  return message.parts.filter((part) => part?.type === 'text' && typeof part.text === 'string').map((part) => part.text.trim()).filter(Boolean).join('\n');
}

function visibleMessageText(message) {
  return (Array.isArray(message?.parts) ? message.parts : []).filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text).join('');
}

function boundedBarrier(promise, label, timeoutMs = 60_000) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}.`)), timeoutMs); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function runGit(args, cwd) {
  return new Promise((resolve, reject) => execFile('git', args, { cwd, encoding: 'utf8', shell: false }, (error, stdout) => error ? reject(error) : resolve(stdout)));
}

async function establishInstalledWorkspaceBoundTurn({ temporary, dataRoot, originWorkspace, executionWorkspace, initialTask = 'inspect real linked worktree', model }) {
  const sessionId = 'real-zcode-e2e'; const turnId = 'real-model-turn';
  const codexHome = join(temporary, 'installed-codex-home');
  const installed = join(codexHome, 'plugins', 'cache', 'vitry', 'zcode', '0.1.0');
  await mkdir(installed, { recursive: true });
  for (const name of ['agents', 'hooks', 'schemas', 'scripts', 'skills']) await cp(join(root, name), join(installed, name), { recursive: true });
  await cp(join(root, 'package.json'), join(installed, 'package.json'));
  await symlink(dependencyNodeModules, join(installed, 'node_modules'), 'dir');
  const env = { ...process.env, ZCODE_DATA_ROOT: dataRoot };
  const hook = (script, input) => runChild(process.execPath, [join(installed, 'hooks', script)], { cwd: originWorkspace, env, ordinaryInput: true, input });
  const started = await hook('session-lifecycle-hook.mjs', { session_id: sessionId, cwd: originWorkspace, hook_event_name: 'SessionStart', transcript_path: null, model: 'gpt', permission_mode: 'default', source: 'startup' });
  assert.equal(started.code, 0, started.stderr || started.stdout);
  const promptText = `$zcode:rescue ${initialTask}`;
  const prompted = await hook('user-prompt-hook.mjs', { session_id: sessionId, turn_id: turnId, cwd: originWorkspace, hook_event_name: 'UserPromptSubmit', transcript_path: null, model: 'gpt', permission_mode: 'default', prompt: promptText });
  assert.equal(prompted.code, 0, prompted.stderr || prompted.stdout);
  const [activeName] = await readdir(join(dataRoot, 'identity-lifecycle', 'active-turns'));
  const activePath = join(dataRoot, 'identity-lifecycle', 'active-turns', activeName);
  const beforeRole = await readFile(activePath); const beforeRoleStat = await stat(activePath);
  const canonicalDataRoot = await realpath(dataRoot); const rolePaths = managedRolePaths(canonicalDataRoot);
  const configFile = join(canonicalDataRoot, 'config.toml'); const installedRoot = await realpath(installed);
  const roleBytes = Buffer.from(renderManagedRescueRole({ template: await readFile(join(installed, 'agents', 'zcode-rescue.toml.template'), 'utf8'), pluginRoot: installedRoot }));
  await mkdir(dirname(rolePaths.rolePath), { recursive: true }); await writeFile(rolePaths.rolePath, roleBytes);
  await writeFile(rolePaths.receiptPath, `${JSON.stringify({ schemaVersion: '1.0.0', roleName: 'zcode-rescue', plugin: { identity: 'zcode@vitry', version: '0.1.0', root: installedRoot }, configTarget: { filePath: configFile }, role: { path: rolePaths.rolePath, schemaVersion: 1, sha256: createHash('sha256').update(roleBytes).digest('hex') }, mutatedAt: new Date().toISOString() }, null, 2)}\n`);
  const registration = { description: MANAGED_ROLE_DESCRIPTION, config_file: rolePaths.rolePath };
  const configured = { features: { multi_agent_v2: { hide_spawn_agent_metadata: false } }, agents: { 'zcode-rescue': registration } };
  const config = { config: configured, origins: {}, layers: [{ name: { type: 'user', file: configFile }, version: 'version-1', config: configured }] };
  const launcherEnv = { ...env, CODEX_HOME: codexHome, CODEX_THREAD_ID: sessionId, CODEX_APP_SERVER_PATH: process.execPath, CODEX_APP_SERVER_ARGS_JSON: JSON.stringify([fakeCodex]), FAKE_CODEX_CONFIG_RESULT: JSON.stringify(config) };
  const role = await runSpawn(process.execPath, [join(installed, 'skills', 'rescue', 'launcher.mjs'), 'role-status', 'rescue'], { cwd: executionWorkspace, env: launcherEnv });
  assert.equal(role.code, 0, role.stderr || role.stdout);
  assert.deepEqual(JSON.parse(role.stdout), { type: 'role-status', role: 'zcode-rescue', status: 'ready' });
  const afterRoleStat = await stat(activePath);
  const roleMutated = !beforeRole.equals(await readFile(activePath)) || beforeRoleStat.mtimeMs !== afterRoleStat.mtimeMs;
  const frame = `${JSON.stringify({ version: 1, source: 'explicit', task: initialTask, options: { execution: 'foreground', resume: 'fresh', ...(model ? { model } : {}) } })}\n`;
  const prepared = await runSpawn(process.execPath, [join(installed, 'skills', 'rescue', 'launcher.mjs'), 'prepare', 'rescue'], { cwd: executionWorkspace, env: { ...launcherEnv, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${prepareTtyShim}`.trim() }, input: frame });
  assert.equal(prepared.code, 0, prepared.stderr || prepared.stdout);
  assert.match(prepared.stdout, /"type":"prepared"/u);
  const active = JSON.parse(await readFile(activePath, 'utf8'));
  let cleaned = false;
  const launcher = join(installed, 'skills', 'rescue', 'launcher.mjs');
  const childInput = (event, childId) => ({ session_id: sessionId, turn_id: 'real-zcode-child-turn', cwd: originWorkspace, hook_event_name: event, transcript_path: null,
    model: 'gpt', permission_mode: 'default', agent_id: childId, agent_type: 'zcode-rescue', ...(event === 'SubagentStop' ? { agent_transcript_path: null, stop_hook_active: false, last_assistant_message: null } : {}) });
  return {
    active, activePath, roleMutated,
    startChild: async (childId) => { const result = await hook('subagent-hook.mjs', childInput('SubagentStart', childId)); assert.equal(result.code, 0, result.stderr || result.stdout); },
    stopChild: async (childId) => { const result = await hook('subagent-hook.mjs', childInput('SubagentStop', childId)); assert.equal(result.code, 0, result.stderr || result.stdout); },
    prepareProactive: async ({ task, model: nextModel }) => {
      const nextFrame = `${JSON.stringify({ version: 1, source: 'proactive', task, options: { execution: 'foreground', resume: 'resume', ...(nextModel ? { model: nextModel } : {}) } })}\n`;
      const result = await runSpawn(process.execPath, [launcher, 'prepare', 'rescue'], { cwd: executionWorkspace,
        env: { ...launcherEnv, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${prepareTtyShim}`.trim() }, input: nextFrame });
      assert.equal(result.code, 0, result.stderr || result.stdout); assert.match(result.stdout, /"type":"prepared"/u);
    },
    invokePrepared: ({ childId, zcodePath }) => runSpawn(process.execPath, [launcher, 'invoke-prepared', 'rescue'], { cwd: executionWorkspace,
      env: { ...launcherEnv, CODEX_THREAD_ID: childId, ZCODE_PATH: zcodePath } }),
    cleanup: async () => {
      if (cleaned) return; cleaned = true;
      const ended = await hook('session-end-hook.mjs', { session_id: sessionId, cwd: originWorkspace, hook_event_name: 'SessionEnd', transcript_path: null, reason: 'other' });
      assert.equal(ended.code, 0, ended.stderr || ended.stdout);
      await assert.rejects(access(activePath), { code: 'ENOENT' });
    },
  };
}

async function readBoundJobs(dataRoot, workspace) {
  const storage = await resolveWorkspaceStorage({ dataRoot, workspace }); const directory = join(storage.directory, 'jobs');
  const values = [];
  for (const name of await readdir(directory)) {
    if (!/^[a-f0-9]{64}\.json$/u.test(name)) continue;
    const value = JSON.parse(await readFile(join(directory, name), 'utf8'));
    if (value.ownerSessionId === 'real-zcode-e2e' && value.command === 'rescue') values.push(value);
  }
  return values.sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
}

function runSpawn(command, args, { cwd, env, input } = {}) {
  const child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; }); child.stderr.on('data', (chunk) => { stderr += chunk; });
  if (input === undefined) child.stdin.end(); else child.stdin.end(input);
  return new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal, stdout, stderr })); });
}
