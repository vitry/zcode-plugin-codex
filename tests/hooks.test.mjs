// @ts-nocheck
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, cp, mkdtemp, readFile, realpath, writeFile, mkdir, readdir, rm, rmdir, stat, symlink, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { resolveWorkspaceStorage } from '../scripts/lib/workspace.mjs';
import { createStateStore } from '../scripts/lib/state.mjs';
import { createIdentityStore } from '../scripts/lib/identity.mjs';
import { createManagedZCodeClient, createZCodeClient, releaseManagedZCodeOwner } from '../scripts/lib/zcode-client.mjs';
import { ownerIdForSession } from '../scripts/lib/job-control.mjs';
import { brokerEndpointFor, ensureZCodeBroker, prioritizeBrokerOwnership, probeBrokerHealth, reconcileBrokerOwnership, writeBrokerIdentity } from '../scripts/zcode-broker.mjs';
import { runCompanion } from '../scripts/zcode-companion.mjs';
import { createRescuePreparationStore } from '../scripts/lib/rescue-preparation.mjs';
import { USER_PROMPT_ADDITIONAL_CONTEXT_LIMIT } from '../scripts/lib/rescue-launcher-command.mjs';
import { cleanupSession, isForwarding, markForwarding, recordSession, resolveForwardingExecutor, resolveForwardingRoute, resolveRoutedForwardingExecutor, resolveRoutedStoppedForwardingExecutor } from '../hooks/lib/hook-state.mjs';
import { runStopReviewGate } from '../hooks/stop-review-gate-hook.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const fakeZCode = join(root, 'tests/fixtures/fake-zcode-cli.mjs');
const socketMethodRecorder = new URL('./fixtures/record-socket-methods.mjs', import.meta.url).href;
const ownerReleaseProbe = fileURLToPath(new URL('./fixtures/probe-owner-release.mjs', import.meta.url));
const legacyBroker = join(root, 'tests/fixtures/legacy-zcode-broker-v1.mjs');
const ownerStoreLockHolder = join(root, 'tests/fixtures/owner-store-lock-holder.mjs');
const sharedLockHolder = join(root, 'tests/fixtures/lock-holder.mjs');
const rescueLauncherPath = await realpath(join(root, 'skills/rescue/launcher.mjs'));
const rescueLauncherCommand = `node "${rescueLauncherPath}"`;
const rescueLauncherDescriptor = `[zcode-rescue-launcher] ${JSON.stringify({ version: 1, launcherCommand: rescueLauncherCommand })}`;
// Parallel Windows runners can spend more than 750 ms scheduling a legacy
// broker request even though the SessionEnd cleanup budget remains bounded.
const brokerTestRequestTimeoutMs = process.platform === 'win32' ? 2_000 : 750;

function isGateRunPath(path) { return path.split(sep).includes('gate-runs'); }

async function jsonFiles(directory) {
  const found = []; let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch { return found; }
  for (const entry of entries) { const path = join(directory, entry.name); if (entry.isDirectory()) found.push(...await jsonFiles(path)); else if (entry.name.endsWith('.json')) found.push(path); }
  return found;
}

async function privateTreeSnapshot(directory) {
  const found = {};
  const visit = async (path, relative = '.') => {
    const metadata = await stat(path, { bigint: true });
    found[relative] = { type: metadata.isDirectory() ? 'directory' : 'file', mode: metadata.mode, size: metadata.size, mtimeNs: metadata.mtimeNs, ctimeNs: metadata.ctimeNs };
    if (metadata.isDirectory()) for (const entry of (await readdir(path, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) await visit(join(path, entry.name), relative === '.' ? entry.name : join(relative, entry.name));
    else found[relative].bytes = (await readFile(path)).toString('base64');
  };
  await visit(directory); return found;
}

async function assertPrivateRoutedError(action, code, secrets) {
  let caught; try { await action(); } catch (error) { caught = error; }
  assert.equal(caught?.code, code);
  const publicEnvelope = JSON.stringify({ error: { code: caught.code, category: caught.category, message: caught.message, remedy: caught.remedy, details: caught.details } });
  for (const secret of secrets) assert.equal(publicEnvelope.includes(secret), false, `public ${code} error must not disclose ${secret}`);
}

async function runHook(script, input, env = {}, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [options.absolute ? script : join(root, 'hooks', script)], {
      cwd: input.cwd ?? root,
      env: { ...process.env, PLUGIN_ROOT: root, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr, json: stdout.trim() ? JSON.parse(stdout) : null }));
    child.stdin.end(options.raw ?? JSON.stringify(input));
  });
}

async function probePidFromChild(pid) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ['-e', `try { process.kill(${JSON.stringify(pid)}, 0); process.stdout.write(JSON.stringify({ ok: true })); } catch (error) { process.stdout.write(JSON.stringify({ ok: false, code: error?.code ?? null })); }`], { stdio: ['ignore', 'pipe', 'ignore'] }); let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; }); child.once('error', reject); child.once('exit', () => resolvePromise(JSON.parse(stdout)));
  });
}

function assertRescueLauncherContext(result) {
  assert.equal(result.code, 0);
  const context = result.json?.hookSpecificOutput?.additionalContext;
  assert.equal(typeof context, 'string');
  assert.equal(context.split('\n')[0], rescueLauncherDescriptor);
  return context;
}

async function workspace() {
  const cwd = await mkdtemp(join(tmpdir(), 'zpc-hooks-workspace-'));
  const data = await mkdtemp(join(tmpdir(), 'zpc-hooks-data-'));
  await new Promise((resolve, reject) => {
    const child = spawn('git', ['init', '-q'], { cwd });
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`git init ${code}`)));
  });
  await writeFile(join(cwd, 'tracked.txt'), 'before\n');
  await new Promise((resolve, reject) => {
    const child = spawn('git', ['add', '.'], { cwd }); child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`git add ${code}`)));
  });
  await new Promise((resolve, reject) => {
    const child = spawn('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'init'], { cwd }); child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`git commit ${code}`)));
  });
  return { cwd, data, env: { PLUGIN_DATA: data } };
}

async function addLinkedWorktree(cwd, name = 'late-bind-target') {
  const target = await mkdtemp(join(tmpdir(), 'zpc-hooks-linked-parent-'));
  await rm(target, { recursive: true, force: true });
  await new Promise((resolvePromise, reject) => {
    const child = spawn('git', ['worktree', 'add', '-q', '-b', name, target], { cwd, shell: false });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolvePromise() : reject(new Error(`git worktree add ${code}`)));
  });
  return target;
}

async function routedExecutorFixture(t, label) {
  const { cwd: origin, data } = await workspace(); const target = await addLinkedWorktree(origin, label);
  t.after(() => rm(target, { recursive: true, force: true }));
  const identity = createIdentityStore({ dataRoot: data }); const sessionId = `${label}-parent`; const agentId = `${label}-child`;
  await recordSession(data, { session_id: sessionId, cwd: origin, source: 'startup' });
  await identity.beginCallerTurn({ sessionId, turnId: `${label}-parent-turn`, workspace: origin, permissionMode: 'workspace-write', prompt: label, sessionStartedAt: '2026-08-21T09:00:00.000Z', sessionSource: 'startup', lifecycleResult: true });
  const caller = await identity.resolveActiveTurn({ sessionId, workspace: target, workspaceBinding: 'claim' });
  const start = { session_id: sessionId, turn_id: `${label}-child-turn`, cwd: origin, hook_event_name: 'SubagentStart', agent_id: agentId, agent_type: 'zcode-rescue' };
  await markForwarding(data, start, caller);
  const originStorage = await resolveWorkspaceStorage({ dataRoot: data, workspace: origin }); const targetStorage = await resolveWorkspaceStorage({ dataRoot: data, workspace: target });
  const originDirectory = join(originStorage.directory, 'hook-state'); const targetDirectory = join(targetStorage.directory, 'hook-state');
  const routePath = join(originDirectory, (await readdir(originDirectory)).find((name) => name.startsWith('route-')));
  const executorPath = join(targetDirectory, (await readdir(targetDirectory)).find((name) => name.startsWith('executor-')));
  return { origin, data, target, start, caller, originDirectory, targetDirectory, routePath, executorPath };
}

async function acceptedWritableJob({ data, cwd, ownerSessionId, remoteSessionId, peerEnv = {} }) {
  const store = createStateStore({ dataRoot: data });
  let value = await store.reserveJob({ workspace: cwd, ownerSessionId, ownerTurnId: `turn-${ownerSessionId}`, command: 'rescue', readOnly: false, permissionSnapshot: { permissionMode: 'workspace-write' } });
  value = await store.claimJobWorker(cwd, value.id, { childPid: 999_999, workerLeaseId: 'd'.repeat(64) });
  const client = await createManagedZCodeClient({ dataRoot: data, workspace: cwd, launch: { command: process.execPath, args: [fakeZCode], target: fakeZCode }, ownerId: ownerIdForSession(ownerSessionId), env: { ...process.env, ...peerEnv } });
  await client.createSession({ workspace: cwd, sessionId: remoteSessionId });
  const sent = await client.send(remoteSessionId, 'recover this accepted turn');
  await client.close();
  value = await store.transitionJob(cwd, value.id, ['queued'], 'running', { startedAt: new Date().toISOString(), zcodeSessionId: remoteSessionId });
  value = await store.transitionJob(cwd, value.id, ['running'], 'running', { inputId: sent.inputId, startRevision: sent.stateRevision, beforeMessageIds: ['message-user-history', 'message-assistant-history'] });
  return { store, job: value };
}

async function writeGateConfig(data, cwd, value) { const storage = await resolveWorkspaceStorage({ dataRoot: data, workspace: cwd }); await mkdir(join(storage.directory, 'config'), { recursive: true }); await writeFile(join(storage.directory, 'config/review-gate.json'), JSON.stringify(value)); }
function stopFields(input) { const copy = { ...input }; delete copy.prompt; return copy; }
function processAlive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }

test('default hooks/hooks.json registers bounded native lifecycle hooks without a manifest override', async () => {
  const hooks = JSON.parse(await readFile(join(root, 'hooks/hooks.json'), 'utf8'));
  const contextCapableEvents = new Set(['SessionStart', 'UserPromptSubmit', 'SubagentStart']);
  assert.deepEqual(Object.keys(hooks.hooks).sort(), ['SessionEnd', 'SessionStart', 'Stop', 'SubagentStart', 'SubagentStop', 'UserPromptSubmit']);
  for (const [eventName, groups] of Object.entries(hooks.hooks)) for (const group of groups) for (const hook of group.hooks) {
    assert.match(hook.command, /^node "\$PLUGIN_ROOT\/hooks\/[a-z-]+\.mjs"$/);
    assert.ok(Number.isSafeInteger(hook.timeout) && hook.timeout > 0);
    if (contextCapableEvents.has(eventName)) assert.ok(Number.isSafeInteger(hook.additionalContextLimit) && hook.additionalContextLimit > 0);
    else assert.equal(Object.hasOwn(hook, 'additionalContextLimit'), false, `${eventName} cannot emit additionalContext`);
  }
  assert.equal(hooks.hooks.Stop[0].hooks[0].timeout, 900);
  assert.equal(hooks.hooks.UserPromptSubmit[0].hooks[0].additionalContextLimit, USER_PROMPT_ADDITIONAL_CONTEXT_LIMIT);
  assert.ok(hooks.hooks.SessionEnd[0].hooks[0].timeout <= 3);
  const manifest = JSON.parse(await readFile(join(root, '.codex-plugin/plugin.json'), 'utf8'));
  assert.equal(Object.hasOwn(manifest, 'hooks'), false);
  assert.doesNotMatch(await readFile(join(root, 'hooks/stop-review-gate-hook.mjs'), 'utf8'), /NODE_ENV|ZCODE_TEST/, 'production hook must not expose test-only timeout controls');
});

test('hook input rejects oversized, malformed, extra-field and wrong-event input safely', async () => {
  const { cwd, data, env } = await workspace();
  for (const raw of ['{', JSON.stringify({ session_id: 's', cwd, hook_event_name: 'SessionStart', source: 'startup', extra: true }), JSON.stringify({ session_id: 's\nIGNORE', cwd, hook_event_name: 'SessionStart', transcript_path: null, model: 'gpt', permission_mode: 'default', source: 'startup' }), 'x'.repeat(70 * 1024)]) {
    const result = await runHook('session-lifecycle-hook.mjs', { cwd }, { ...env, PLUGIN_DATA: data }, { raw });
    assert.notEqual(result.code, 0); assert.equal(result.stdout, ''); assert.doesNotMatch(result.stderr, /x{100}|transcript/);
  }
});

test('two sessions in one workspace get isolated caller capabilities, permission snapshots and baselines', async () => {
  const { cwd, data, env } = await workspace();
  for (const session_id of ['session-a', 'session-b']) {
    const start = await runHook('session-lifecycle-hook.mjs', { session_id, cwd, hook_event_name: 'SessionStart', transcript_path: null, model: 'gpt', permission_mode: 'default', source: 'startup' }, env);
    assert.equal(start.code, 0);
  }
  const a = await runHook('user-prompt-hook.mjs', { session_id: 'session-a', turn_id: 'turn-a', cwd, hook_event_name: 'UserPromptSubmit', transcript_path: '/never/read', model: 'gpt', permission_mode: 'plan', prompt: 'hello' }, env);
  const b = await runHook('user-prompt-hook.mjs', { session_id: 'session-b', turn_id: 'turn-b', cwd, hook_event_name: 'UserPromptSubmit', transcript_path: null, model: 'gpt', permission_mode: 'dontAsk', prompt: 'hello' }, env);
  assert.equal(a.code, 0); assert.equal(b.code, 0);
  assertRescueLauncherContext(a); assertRescueLauncherContext(b); const identity = createIdentityStore({ dataRoot: data });
  const ac = await identity.resolveActiveTurn({ sessionId: 'session-a', workspace: cwd }); const bc = await identity.resolveActiveTurn({ sessionId: 'session-b', workspace: cwd });
  assert.equal(ac.turnId, 'turn-a'); assert.equal(bc.turnId, 'turn-b'); assert.equal(ac.permissionMode, 'plan'); assert.equal(bc.permissionMode, 'dontAsk');
  assert.doesNotMatch(`${a.stdout}${b.stdout}`, /transcript_path|\/never\/read|brokerToken|executionCapability/);
  const files = await jsonFiles(join(data, 'workspaces'));
  const records = await Promise.all(files.map(async (path) => JSON.parse(await readFile(path, 'utf8'))));
  const allRecords = await Promise.all((await jsonFiles(data)).map(async (path) => JSON.parse(await readFile(path, 'utf8'))));
  const active = allRecords.filter((record) => record.kind === 'active-turn');
  assert.equal(active.length, 2); assert.ok(active.every((record) => record.version === 3 && record.status === 'active' && record.executionWorkspace === null));
  assert.equal(records.filter((record) => record.kind === 'active-turn').length, 0, 'proved prompt hooks must not write a v2 active mirror');
  assert.ok(records.some((record) => record.sessionId === 'session-a' && record.permissionMode === 'plan'));
  assert.ok(records.some((record) => record.sessionId === 'session-b' && record.permissionMode === 'dontAsk'));
  assert.ok(records.filter((record) => record.kind === 'baseline').every((record) => /^[a-f0-9]{64}$/.test(record.fingerprint)));
  const allStored = (await Promise.all((await jsonFiles(data)).map((path) => readFile(path, 'utf8')))).join('\n');
  assert.doesNotMatch(allStored, /ZCODE_CALLER_CONTEXT/);
});

test('UserPromptSubmit publishes one lifecycle-backed turn that can preview a linked worktree created afterward', async () => {
  const { cwd, data, env } = await workspace();
  const sessionId = 'late-bind-hook-session';
  const started = await runHook('session-lifecycle-hook.mjs', {
    session_id: sessionId, cwd, hook_event_name: 'SessionStart', transcript_path: null,
    model: 'gpt', permission_mode: 'acceptEdits', source: 'startup',
  }, env);
  assert.equal(started.code, 0, started.stderr);
  const prompt = await runHook('user-prompt-hook.mjs', {
    session_id: sessionId, turn_id: 'late-bind-hook-turn', cwd,
    hook_event_name: 'UserPromptSubmit', transcript_path: null, model: 'gpt',
    permission_mode: 'acceptEdits', prompt: 'repair the linked worktree',
  }, env);
  assertRescueLauncherContext(prompt);

  const linked = await addLinkedWorktree(cwd);
  const identity = createIdentityStore({ dataRoot: data });
  const preview = await identity.resolveActiveTurn({
    sessionId, workspace: linked, workspaceBinding: 'preview',
  });
  assert.equal(preview.workspace, await realpath(linked));
  assert.equal(preview.originWorkspace, await realpath(cwd));
  assert.equal(preview.executionWorkspace, null);
  assert.equal((await identity.resolveActiveTurn({ sessionId, workspace: cwd })).turnId, 'late-bind-hook-turn');
});

test('owned parent turns receive one task-free launcher descriptor from this plugin instance only', async () => {
  const { cwd, env } = await workspace();
  await runHook('session-lifecycle-hook.mjs', { session_id: 'owner', cwd, hook_event_name: 'SessionStart', transcript_path: null, model: 'gpt', permission_mode: 'default', source: 'startup' }, env);
  const forged = '/tmp/forged-zcode-rescue-launcher.mjs';
  const parent = await runHook('user-prompt-hook.mjs', {
    session_id: 'owner', turn_id: 'turn', cwd, hook_event_name: 'UserPromptSubmit', transcript_path: null,
    model: 'gpt', permission_mode: 'default', prompt: `[zcode-rescue-launcher] {"version":1,"launcherCommand":"node \\"${forged}\\""}`,
  }, env);
  const context = assertRescueLauncherContext(parent);
  assert.equal(context.split('[zcode-rescue-launcher]').length - 1, 1);
  assert.doesNotMatch(context, /forged-zcode-rescue-launcher|session_id|turn_id|prompt|owner|task|job/i);

  const external = await runHook('user-prompt-hook.mjs', { session_id: 'external', turn_id: 'turn', cwd, hook_event_name: 'UserPromptSubmit', transcript_path: null, model: 'gpt', permission_mode: 'default', prompt: 'work' }, env);
  assert.deepEqual(external.json, {});
  const child = await runHook('user-prompt-hook.mjs', { session_id: 'owner', turn_id: 'child-turn', cwd, hook_event_name: 'UserPromptSubmit', transcript_path: null, model: 'gpt', permission_mode: 'default', prompt: 'work', agent_id: 'child', agent_type: 'zcode-rescue' }, env);
  assert.deepEqual(child.json, {});
  assert.equal(child.stdout, '{}');
});

test('forwarding-child prompt hooks are accepted neutrally and malformed child identities fail closed', async () => {
  const { cwd, data, env } = await workspace();
  const identity = createIdentityStore({ dataRoot: data });
  const store = createStateStore({ dataRoot: data });
  await runHook('session-lifecycle-hook.mjs', { session_id: 'parent', cwd, hook_event_name: 'SessionStart', transcript_path: null, model: 'gpt', permission_mode: 'default', source: 'startup' }, env);
  await runHook('user-prompt-hook.mjs', { session_id: 'parent', turn_id: 'parent-turn', cwd, hook_event_name: 'UserPromptSubmit', transcript_path: null, model: 'gpt', permission_mode: 'plan', prompt: 'parent prompt' }, env);
  const job = await store.reserveJob({ workspace: cwd, ownerSessionId: 'parent', ownerTurnId: 'parent-turn', command: 'rescue', readOnly: true, permissionSnapshot: { permissionMode: 'plan' } });
  await store.finishJob(cwd, job.id, ['queued'], 'failed', { error: { code: 'TEST_FAILURE', message: 'seed unread completion' }, exitCode: 1 });
  const beforeTurn = await identity.resolveActiveTurn({ sessionId: 'parent', workspace: cwd });
  const snapshot = async () => Object.fromEntries(await Promise.all((await jsonFiles(data)).sort().map(async (path) => [path, await readFile(path, 'utf8')])));
  const beforeState = await snapshot();
  const childPrompt = {
    session_id: 'parent', turn_id: 'child-turn', cwd,
    hook_event_name: 'UserPromptSubmit', transcript_path: null,
    model: 'gpt', permission_mode: 'bypassPermissions', prompt: 'forward',
    agent_id: 'rescue-child', agent_type: 'zcode-rescue',
  };

  const accepted = await runHook('user-prompt-hook.mjs', childPrompt, env);
  assert.equal(accepted.code, 0); assert.equal(accepted.stdout, '{}'); assert.deepEqual(accepted.json, {});
  assert.deepEqual(await identity.resolveActiveTurn({ sessionId: 'parent', workspace: cwd }), beforeTurn, 'forwarded prompt must not replace the parent caller turn or permission/prompt snapshot');
  assert.deepEqual(await snapshot(), beforeState, 'forwarded prompt must not create a child caller, gate baseline, or unread-job marker');

  const invalidInputs = [
    { name: 'agent_id only', input: { ...childPrompt, agent_type: undefined } },
    { name: 'agent_type only', input: { ...childPrompt, agent_id: undefined } },
    { name: 'empty identity', input: { ...childPrompt, agent_id: '' } },
    { name: 'control-bearing identity', input: { ...childPrompt, agent_id: 'rescue\0child' } },
    { name: 'oversized identity', input: { ...childPrompt, agent_id: 'x'.repeat(513) } },
    { name: 'unknown field', input: { ...childPrompt, extra: true } },
  ];
  for (const { name, input } of invalidInputs) {
    const result = await runHook('user-prompt-hook.mjs', input, env);
    assert.notEqual(result.code, 0, name); assert.equal(result.stdout, '', name);
    assert.deepEqual(await snapshot(), beforeState, `${name} must fail before durable state changes`);
  }
});

test('caller authorization survives non-Git workspaces while gate baseline stays unavailable', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'zpc-nongit-')); const data = await mkdtemp(join(tmpdir(), 'zpc-hooks-data-')); const env = { PLUGIN_DATA: data };
  await runHook('session-lifecycle-hook.mjs', { session_id: 'nongit', cwd, hook_event_name: 'SessionStart', transcript_path: null, model: 'gpt', permission_mode: 'default', source: 'startup' }, env);
  const prompt = await runHook('user-prompt-hook.mjs', { session_id: 'nongit', turn_id: 'turn', cwd, hook_event_name: 'UserPromptSubmit', transcript_path: null, model: 'gpt', permission_mode: 'default', prompt: 'work' }, env);
  assertRescueLauncherContext(prompt); assert.equal((await createIdentityStore({ dataRoot: data }).resolveActiveTurn({ sessionId: 'nongit', workspace: cwd })).turnId, 'turn');
  const stop = await runHook('stop-review-gate-hook.mjs', { session_id: 'nongit', turn_id: 'turn', cwd, hook_event_name: 'Stop', transcript_path: null, model: 'gpt', permission_mode: 'default', stop_hook_active: false, last_assistant_message: 'done' }, env); assert.equal(stop.code, 0); assert.deepEqual(stop.json, {});
});

test('unborn repositories get baselines and full untracked contents affect fingerprints', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'zpc-unborn-')); const data = await mkdtemp(join(tmpdir(), 'zpc-hooks-data-')); const env = { PLUGIN_DATA: data };
  await new Promise((resolvePromise, reject) => { const child = spawn('git', ['init', '-q'], { cwd }); child.once('error', reject); child.once('exit', (code) => code === 0 ? resolvePromise() : reject(new Error(`git init ${code}`))); });
  const bytes = Buffer.alloc(384 * 1024, 65); await writeFile(join(cwd, 'large.bin'), bytes); await runHook('session-lifecycle-hook.mjs', { session_id: 'unborn', cwd, hook_event_name: 'SessionStart', transcript_path: null, model: 'gpt', permission_mode: 'default', source: 'startup' }, env);
  const prompt = await runHook('user-prompt-hook.mjs', { session_id: 'unborn', turn_id: 'turn', cwd, hook_event_name: 'UserPromptSubmit', transcript_path: null, model: 'gpt', permission_mode: 'default', prompt: 'work' }, env); assertRescueLauncherContext(prompt); assert.equal((await createIdentityStore({ dataRoot: data }).resolveActiveTurn({ sessionId: 'unborn', workspace: cwd })).turnId, 'turn');
  bytes.fill(66, 160 * 1024, 224 * 1024); await writeFile(join(cwd, 'large.bin'), bytes);
  const stop = await runHook('stop-review-gate-hook.mjs', { session_id: 'unborn', turn_id: 'turn', cwd, hook_event_name: 'Stop', transcript_path: null, model: 'gpt', permission_mode: 'default', stop_hook_active: false, last_assistant_message: 'done' }, env); assert.equal(stop.code, 0); assert.deepEqual(stop.json, {});
  assert.equal((await jsonFiles(join(data, 'workspaces'))).filter(isGateRunPath).length, 1, 'same-size middle-only untracked edits must change the fingerprint');
});

test('changing only an untracked symlink target changes the fingerprint without following it', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'zpc-symlink-')); const data = await mkdtemp(join(tmpdir(), 'zpc-hooks-data-')); const env = { PLUGIN_DATA: data };
  await new Promise((resolvePromise, reject) => { const child = spawn('git', ['init', '-q'], { cwd }); child.once('error', reject); child.once('exit', (code) => code === 0 ? resolvePromise() : reject(new Error(`git init ${code}`))); });
  const link = join(cwd, 'untracked-link'); await symlink('missing-target-a', link); await runHook('session-lifecycle-hook.mjs', { session_id: 'symlink', cwd, hook_event_name: 'SessionStart', transcript_path: null, model: 'gpt', permission_mode: 'default', source: 'startup' }, env);
  const prompt = await runHook('user-prompt-hook.mjs', { session_id: 'symlink', turn_id: 'turn', cwd, hook_event_name: 'UserPromptSubmit', transcript_path: null, model: 'gpt', permission_mode: 'default', prompt: 'work' }, env); assert.equal(prompt.code, 0);
  await unlink(link); await symlink('missing-target-b', link);
  const stop = await runHook('stop-review-gate-hook.mjs', { session_id: 'symlink', turn_id: 'turn', cwd, hook_event_name: 'Stop', transcript_path: null, model: 'gpt', permission_mode: 'default', stop_hook_active: false, last_assistant_message: 'done' }, env); assert.equal(stop.code, 0); assert.deepEqual(stop.json, {});
  assert.equal((await jsonFiles(join(data, 'workspaces'))).filter(isGateRunPath).length, 1, 'same-path symlink target changes must reach the gate path');
});

test('subagent hook marks forwarding suppression without changing parent permission snapshot', async () => {
  const { cwd, data, env } = await workspace();
  await runHook('session-lifecycle-hook.mjs', { session_id: 'parent', cwd, hook_event_name: 'SessionStart', transcript_path: null, model: 'gpt', permission_mode: 'plan', source: 'startup' }, env);
  await runHook('user-prompt-hook.mjs', { session_id: 'parent', turn_id: 'turn', cwd, hook_event_name: 'UserPromptSubmit', transcript_path: null, model: 'gpt', permission_mode: 'plan', prompt: 'go' }, env);
  await createIdentityStore({ dataRoot: data }).resolveActiveTurn({ sessionId: 'parent', workspace: cwd, workspaceBinding: 'claim' });
  const sub = await runHook('subagent-hook.mjs', { session_id: 'parent', turn_id: 'turn', cwd, hook_event_name: 'SubagentStart', transcript_path: null, model: 'gpt', permission_mode: 'bypassPermissions', agent_id: 'agent-1', agent_type: 'zcode-rescue' }, env);
  assert.equal(sub.code, 0); assert.match(sub.json.hookSpecificOutput.additionalContext, /forwarding subagent/i);
  assert.doesNotMatch(JSON.stringify(sub.json), /callerContext|executionCapability|[a-f0-9]{64}/);
  const stop = await runHook('subagent-hook.mjs', { session_id: 'parent', turn_id: 'turn', cwd, hook_event_name: 'SubagentStop', transcript_path: null, model: 'gpt', permission_mode: 'bypassPermissions', agent_id: 'agent-1', agent_type: 'zcode-rescue', agent_transcript_path: null, stop_hook_active: false, last_assistant_message: null }, env);
  assert.equal(stop.code, 0); assert.deepEqual(stop.json, {});
});

test('origin cwd routes a bound worktree child and exact replacement stop without scanning', async (t) => {
  const { cwd: origin, data, env } = await workspace();
  const target = await addLinkedWorktree(origin, 'origin-cwd-child-route');
  t.after(() => rm(target, { recursive: true, force: true }));
  const identity = createIdentityStore({ dataRoot: data });
  const sessionStarted = await runHook('session-lifecycle-hook.mjs', { session_id: 'routed-parent', cwd: origin, hook_event_name: 'SessionStart', transcript_path: null, model: 'gpt', permission_mode: 'default', source: 'startup' }, env);
  assert.equal(sessionStarted.code, 0, sessionStarted.stderr);
  const prompted = await runHook('user-prompt-hook.mjs', { session_id: 'routed-parent', turn_id: 'parent-turn-a', cwd: origin, hook_event_name: 'UserPromptSubmit', transcript_path: null, model: 'gpt', permission_mode: 'acceptEdits', prompt: 'repair in the linked worktree' }, env);
  assert.equal(prompted.code, 0, prompted.stderr);
  const bound = await identity.resolveActiveTurn({ sessionId: 'routed-parent', workspace: target, workspaceBinding: 'claim' });

  const start = { session_id: 'routed-parent', turn_id: 'child-turn-a', cwd: origin, hook_event_name: 'SubagentStart', transcript_path: null, model: 'gpt', permission_mode: 'acceptEdits', agent_id: 'routed-child', agent_type: 'zcode-rescue' };
  const started = await runHook('subagent-hook.mjs', start, env);
  assert.equal(started.code, 0, started.stderr);
  const executor = await resolveForwardingExecutor(data, target, 'routed-child');
  assert.equal(executor.workspace, await realpath(target));
  assert.equal(executor.parentGenerationId, bound.generationId);
  await assert.rejects(resolveForwardingExecutor(data, origin, 'routed-child'), { code: 'EXECUTOR_IDENTITY_NOT_FOUND' });
  const originStorage = await resolveWorkspaceStorage({ dataRoot: data, workspace: origin });
  const targetStorage = await resolveWorkspaceStorage({ dataRoot: data, workspace: target });
  const originRoutePath = join(originStorage.directory, 'hook-state', (await readdir(join(originStorage.directory, 'hook-state'))).find((name) => name.startsWith('route-')));
  const targetExecutorPath = join(targetStorage.directory, 'hook-state', (await readdir(join(targetStorage.directory, 'hook-state'))).find((name) => name.startsWith('executor-')));
  const before = { route: await readFile(originRoutePath), executor: await readFile(targetExecutorPath) };
  const beforeTree = await privateTreeSnapshot(data);
  assert.deepEqual(await resolveRoutedForwardingExecutor(data, origin, 'routed-child'), { executor, executionWorkspace: await realpath(target) });
  assert.deepEqual({ route: await readFile(originRoutePath), executor: await readFile(targetExecutorPath) }, before, 'routed lookup must not rewrite authority bytes');
  assert.deepEqual(await privateTreeSnapshot(data), beforeTree, 'routed lookup must not change active-turn or workspace partition bytes and metadata');

  await runHook('user-prompt-hook.mjs', { session_id: 'routed-parent', turn_id: 'parent-turn-b', cwd: origin, hook_event_name: 'UserPromptSubmit', transcript_path: null, model: 'gpt', permission_mode: 'acceptEdits', prompt: 'replacement turn' }, env);
  const stopped = await runHook('subagent-hook.mjs', { ...start, hook_event_name: 'SubagentStop', agent_transcript_path: null, stop_hook_active: false, last_assistant_message: null }, env);
  assert.equal(stopped.code, 0, stopped.stderr);
  const terminal = await resolveForwardingExecutor(data, target, 'routed-child', { continuation: true, durableProvenance: true });
  assert.equal(terminal.active, false);
  assert.equal(terminal.parentGenerationId, bound.generationId, 'replacement authority must not redirect exact child cleanup');
});

test('routed executor preserves active and stopped invocation modes', async (t) => {
  const { cwd: origin, data } = await workspace(); const target = await addLinkedWorktree(origin, 'routed-executor-modes');
  t.after(() => rm(target, { recursive: true, force: true }));
  const identity = createIdentityStore({ dataRoot: data });
  await recordSession(data, { session_id: 'routed-mode-parent', cwd: origin, source: 'startup' });
  await identity.beginCallerTurn({ sessionId: 'routed-mode-parent', turnId: 'routed-mode-parent-turn', workspace: origin, permissionMode: 'workspace-write', prompt: 'route modes', sessionStartedAt: '2026-08-21T09:00:00.000Z', sessionSource: 'startup', lifecycleResult: true });
  const caller = await identity.resolveActiveTurn({ sessionId: 'routed-mode-parent', workspace: target, workspaceBinding: 'claim' });
  const start = { session_id: caller.sessionId, turn_id: 'routed-mode-child-turn', cwd: origin, hook_event_name: 'SubagentStart', agent_id: 'routed-mode-child', agent_type: 'zcode-rescue' };
  await markForwarding(data, start, caller);
  await assert.rejects(resolveRoutedForwardingExecutor(data, origin, start.agent_id, { continuation: true }), { code: 'EXECUTOR_STATE_MISMATCH' });
  await markForwarding(data, { ...start, hook_event_name: 'SubagentStop' });
  await assert.rejects(resolveRoutedForwardingExecutor(data, origin, start.agent_id), { code: 'EXECUTOR_STATE_MISMATCH' });
  const routed = await resolveRoutedForwardingExecutor(data, origin, start.agent_id, { continuation: true, durableProvenance: true });
  assert.equal(routed.executor.active, false); assert.equal(routed.executionWorkspace, await realpath(target));
});

test('stopped routed executor resolution is durable, read-only, and cannot be weakened by caller options', async (t) => {
  const fixture = await routedExecutorFixture(t, 'stopped-routed-wrapper');
  await markForwarding(fixture.data, { ...fixture.start, hook_event_name: 'SubagentStop' });
  const stoppedAt = JSON.parse(await readFile(fixture.executorPath, 'utf8')).createdAt;
  const before = await privateTreeSnapshot(fixture.data);
  const resolved = await resolveRoutedStoppedForwardingExecutor(
    fixture.data,
    fixture.origin,
    fixture.start.agent_id,
    { now: new Date(Date.parse(stoppedAt) + 31 * 60_000), continuation: false, durableProvenance: false },
  );
  assert.equal(resolved.executor.active, false);
  assert.equal(resolved.executionWorkspace, await realpath(fixture.target));
  assert.deepEqual(await privateTreeSnapshot(fixture.data), before);
});

test('stopped routed executor wrapper fails closed on active, Role, route, and target drift without rewriting state', async (t) => {
  const expectUnchangedFailure = async (label, mutate, code) => {
    const fixture = await routedExecutorFixture(t, `stopped-wrapper-${label}`);
    await markForwarding(fixture.data, { ...fixture.start, hook_event_name: 'SubagentStop' });
    await mutate(fixture);
    const before = await privateTreeSnapshot(fixture.data);
    await assert.rejects(resolveRoutedStoppedForwardingExecutor(fixture.data, fixture.origin, fixture.start.agent_id), { code });
    assert.deepEqual(await privateTreeSnapshot(fixture.data), before, `${label} rejection must be read-only`);
  };
  await expectUnchangedFailure('active', async (fixture) => {
    const record = JSON.parse(await readFile(fixture.executorPath, 'utf8'));
    await writeFile(fixture.executorPath, JSON.stringify({ ...record, active: true }), { mode: 0o600 });
  }, 'EXECUTOR_STATE_MISMATCH');
  await expectUnchangedFailure('role', async (fixture) => {
    const record = JSON.parse(await readFile(fixture.executorPath, 'utf8'));
    await writeFile(fixture.executorPath, JSON.stringify({ ...record, agentType: 'explorer' }), { mode: 0o600 });
  }, 'EXECUTOR_ROLE_UNAPPROVED');
  await expectUnchangedFailure('route', (fixture) => writeFile(fixture.routePath, '{', { mode: 0o600 }), 'EXECUTOR_ROUTE_INVALID');
  await expectUnchangedFailure('ambiguous-route', async (fixture) => {
    const route = await readFile(fixture.routePath);
    await writeFile(join(fixture.originDirectory, 'route-duplicate.json'), route, { mode: 0o600 });
  }, 'EXECUTOR_IDENTITY_AMBIGUOUS');
  await expectUnchangedFailure('target', async (fixture) => {
    const route = JSON.parse(await readFile(fixture.routePath, 'utf8'));
    await writeFile(fixture.routePath, JSON.stringify({ ...route, targetWorkspace: fixture.origin }), { mode: 0o600 });
  }, 'EXECUTOR_ROUTE_INVALID');
  await assert.rejects(resolveRoutedStoppedForwardingExecutor('data', 'origin', 'child', { unexpected: true }), { code: 'EXECUTOR_ROUTE_INVALID' });
});

test('direct executor resolver preserves workspace and lock infrastructure errors', async (t) => {
  const missingWorkspace = join((await workspace()).cwd, 'missing-workspace');
  await assert.rejects(resolveForwardingExecutor(await mkdtemp(join(tmpdir(), 'zcode-direct-errors-data-')), missingWorkspace, 'missing-child'), { code: 'WORKSPACE_RESOLVE_FAILED' });
  const fixture = await routedExecutorFixture(t, 'direct-lock-errors'); const targetLock = join(fixture.targetDirectory, '.lock'); const advisoryLock = join(targetLock, 'advisory.lock');
  await unlink(advisoryLock); await symlink(fixture.executorPath, advisoryLock);
  await assert.rejects(resolveForwardingExecutor(fixture.data, fixture.target, fixture.start.agent_id), { code: 'LOCK_PATH_UNSAFE' });
  await unlink(advisoryLock); await writeFile(advisoryLock, '', { mode: 0o600 });
  const holder = spawn(process.execPath, [sharedLockHolder, targetLock], { stdio: ['pipe', 'pipe', 'pipe'] }); t.after(() => { holder.stdin.end(); holder.kill(); });
  await new Promise((resolvePromise, reject) => { holder.once('error', reject); holder.stdout.once('data', resolvePromise); });
  await assert.rejects(resolveForwardingExecutor(fixture.data, fixture.target, fixture.start.agent_id), { code: 'LOCK_TIMEOUT' });
  holder.stdin.end(); await new Promise((resolvePromise) => holder.once('exit', resolvePromise));
});

test('routed executor treats every ambient executor claim or corruption as terminal', async (t) => {
  const fixture = await routedExecutorFixture(t, 'routed-ambient-boundaries');
  const targetExecutor = JSON.parse(await readFile(fixture.executorPath, 'utf8'));
  const canonicalName = fixture.executorPath.split(sep).at(-1); const canonicalPath = join(fixture.originDirectory, canonicalName);
  const ambient = { ...targetExecutor, originWorkspace: await realpath(fixture.origin), workspace: await realpath(fixture.origin) };
  const expect = async (record, code, name = canonicalName) => {
    await writeFile(join(fixture.originDirectory, name), typeof record === 'string' ? record : JSON.stringify(record));
    await chmod(join(fixture.originDirectory, name), 0o600);
    await assert.rejects(resolveRoutedForwardingExecutor(fixture.data, fixture.origin, fixture.start.agent_id), { code });
    await rm(join(fixture.originDirectory, name), { force: true });
  };
  await expect({ ...ambient, active: false }, 'EXECUTOR_IDENTITY_NOT_FOUND');
  await expect({ ...ambient, createdAt: new Date(Date.now() - 31 * 60_000).toISOString() }, 'EXECUTOR_IDENTITY_EXPIRED');
  await expect({ ...ambient, createdAt: new Date(Date.now() + 60_000).toISOString() }, 'EXECUTOR_IDENTITY_INVALID');
  await expect({ ...ambient, agentType: 'explorer' }, 'EXECUTOR_ROLE_UNAPPROVED');
  await writeFile(canonicalPath, JSON.stringify(ambient), { mode: 0o600 });
  await assert.rejects(resolveRoutedForwardingExecutor(fixture.data, fixture.origin, fixture.start.agent_id, { continuation: true }), { code: 'EXECUTOR_STATE_MISMATCH' });
  await rm(canonicalPath);
  await expect(ambient, 'EXECUTOR_IDENTITY_AMBIGUOUS', 'executor-noncanonical-same-child.json');
  await writeFile(canonicalPath, JSON.stringify(ambient), { mode: 0o600 }); await writeFile(join(fixture.originDirectory, 'executor-duplicate-same-child.json'), JSON.stringify(ambient), { mode: 0o600 });
  await assert.rejects(resolveRoutedForwardingExecutor(fixture.data, fixture.origin, fixture.start.agent_id), { code: 'EXECUTOR_IDENTITY_AMBIGUOUS' });
  await rm(canonicalPath); await rm(join(fixture.originDirectory, 'executor-duplicate-same-child.json'));
  await expect('{', 'EXECUTOR_IDENTITY_INVALID', 'executor-malformed-unrelated.json');
  await expect(`{"pad":"${'x'.repeat(17 * 1024)}"}`, 'EXECUTOR_IDENTITY_INVALID', 'executor-oversized-unrelated.json');
});

test('routed executor validates the complete route set before selecting one claim', async (t) => {
  const fixture = await routedExecutorFixture(t, 'routed-route-boundaries'); const originalBytes = await readFile(fixture.routePath); const original = JSON.parse(originalBytes);
  const reset = async () => { for (const name of await readdir(fixture.originDirectory)) if (name.startsWith('route-')) await rm(join(fixture.originDirectory, name)); await writeFile(fixture.routePath, originalBytes, { mode: 0o600 }); };
  await rm(fixture.routePath); await assert.rejects(resolveRoutedForwardingExecutor(fixture.data, fixture.origin, fixture.start.agent_id), { code: 'EXECUTOR_IDENTITY_NOT_FOUND' });
  await writeFile(fixture.routePath, JSON.stringify({ ...original, agentId: 'unrelated-child' }), { mode: 0o600 }); await assert.rejects(resolveRoutedForwardingExecutor(fixture.data, fixture.origin, fixture.start.agent_id), { code: 'EXECUTOR_IDENTITY_NOT_FOUND' });
  await reset(); await writeFile(join(fixture.originDirectory, 'route-duplicate.json'), JSON.stringify({ ...original, state: 'stopped' }), { mode: 0o600 }); await assert.rejects(resolveRoutedForwardingExecutor(fixture.data, fixture.origin, fixture.start.agent_id), { code: 'EXECUTOR_IDENTITY_AMBIGUOUS' });
  await reset(); await writeFile(join(fixture.originDirectory, 'route-malformed-unrelated.json'), '{', { mode: 0o600 });
  await assert.rejects(resolveRoutedForwardingExecutor(fixture.data, fixture.origin, fixture.start.agent_id), (error) => error?.code === 'EXECUTOR_ROUTE_INVALID' && error?.cause instanceof SyntaxError);
  await reset(); await writeFile(join(fixture.originDirectory, 'route-oversized-unrelated.json'), `{"pad":"${'x'.repeat(17 * 1024)}"}`, { mode: 0o600 });
  await assert.rejects(resolveRoutedForwardingExecutor(fixture.data, fixture.origin, fixture.start.agent_id), (error) => error?.code === 'EXECUTOR_ROUTE_INVALID' && error?.cause?.code === 'PRIVATE_PATH_UNSAFE');
  for (const age of [0, 31_000]) {
    await reset(); const stamp = new Date(Date.now() - age).toISOString(); await writeFile(fixture.routePath, JSON.stringify({ ...original, state: 'pending', createdAt: stamp, updatedAt: stamp }), { mode: 0o600 });
    await assert.rejects(resolveRoutedForwardingExecutor(fixture.data, fixture.origin, fixture.start.agent_id), { code: 'EXECUTOR_STATE_MISMATCH' });
  }
  await reset(); await writeFile(fixture.routePath, JSON.stringify({ ...original, updatedAt: new Date(Date.now() + 60_000).toISOString() }), { mode: 0o600 });
  await assert.rejects(resolveRoutedForwardingExecutor(fixture.data, fixture.origin, fixture.start.agent_id), { code: 'EXECUTOR_ROUTE_INVALID' });
  await reset(); await writeFile(fixture.routePath, JSON.stringify({ ...original, createdAt: new Date(Date.now() + 60_000).toISOString(), updatedAt: new Date(Date.now() + 60_000).toISOString() }), { mode: 0o600 });
  await assert.rejects(resolveRoutedForwardingExecutor(fixture.data, fixture.origin, fixture.start.agent_id), { code: 'EXECUTOR_ROUTE_INVALID' });
  await reset();
});

test('routed executor rejects target drift, expiry, symlinks, and route count overflow without leaking authority', async (t) => {
  const fixture = await routedExecutorFixture(t, 'routed-target-boundaries'); const originalExecutor = await readFile(fixture.executorPath); const originalRoute = await readFile(fixture.routePath);
  const mutateExecutor = async (changes, code) => {
    await writeFile(fixture.executorPath, JSON.stringify({ ...JSON.parse(originalExecutor), ...changes }), { mode: 0o600 });
    await assert.rejects(resolveRoutedForwardingExecutor(fixture.data, fixture.origin, fixture.start.agent_id), { code });
    await writeFile(fixture.executorPath, originalExecutor, { mode: 0o600 });
  };
  await mutateExecutor({ parentTurnId: 'wrong-target-turn' }, 'EXECUTOR_ROUTE_INVALID');
  await mutateExecutor({ parentGenerationId: 'f'.repeat(64) }, 'EXECUTOR_ROUTE_INVALID');
  await mutateExecutor({ createdAt: new Date(Date.now() - 31 * 60_000).toISOString() }, 'EXECUTOR_IDENTITY_EXPIRED');
  await mutateExecutor({ agentType: 'explorer' }, 'EXECUTOR_ROLE_UNAPPROVED');
  const symlinkPath = join(fixture.originDirectory, 'route-symlink.json'); await symlink(fixture.routePath, symlinkPath);
  await assert.rejects(resolveRoutedForwardingExecutor(fixture.data, fixture.origin, fixture.start.agent_id), { code: 'EXECUTOR_ROUTE_INVALID' }); await unlink(symlinkPath);
  const executorLink = join(fixture.originDirectory, fixture.executorPath.split(sep).at(-1)); await symlink(fixture.executorPath, executorLink);
  await assert.rejects(resolveRoutedForwardingExecutor(fixture.data, fixture.origin, fixture.start.agent_id), { code: 'EXECUTOR_IDENTITY_INVALID' }); await unlink(executorLink);
  const targetLinkSource = join(fixture.targetDirectory, 'executor-link-source.json'); await writeFile(targetLinkSource, originalExecutor, { mode: 0o600 }); await unlink(fixture.executorPath); await symlink(targetLinkSource, fixture.executorPath);
  await assert.rejects(resolveRoutedForwardingExecutor(fixture.data, fixture.origin, fixture.start.agent_id), { code: 'EXECUTOR_ROUTE_INVALID' }); await unlink(fixture.executorPath); await writeFile(fixture.executorPath, originalExecutor, { mode: 0o600 }); await unlink(targetLinkSource);
  const canonicalOrigin = await realpath(fixture.origin);
  await Promise.all(Array.from({ length: 1_025 }, (_, index) => writeFile(join(fixture.originDirectory, `executor-overflow-${index}.json`), JSON.stringify({ ...JSON.parse(originalExecutor), agentId: `unrelated-executor-${index}`, originWorkspace: canonicalOrigin, workspace: canonicalOrigin }), { mode: 0o600 })));
  await assert.rejects(resolveRoutedForwardingExecutor(fixture.data, fixture.origin, fixture.start.agent_id), { code: 'EXECUTOR_IDENTITY_AMBIGUOUS' });
  for (const name of await readdir(fixture.originDirectory)) if (name.startsWith('executor-overflow-')) await unlink(join(fixture.originDirectory, name));
  const route = JSON.parse(originalRoute); await Promise.all(Array.from({ length: 1_025 }, (_, index) => writeFile(join(fixture.originDirectory, `route-overflow-${index}.json`), JSON.stringify({ ...route, agentId: `unrelated-${index}` }), { mode: 0o600 })));
  await assert.rejects(resolveRoutedForwardingExecutor(fixture.data, fixture.origin, fixture.start.agent_id), { code: 'EXECUTOR_IDENTITY_AMBIGUOUS' });
});

test('routed executor never creates or mutates storage while rejecting an unprovisioned forged target', async (t) => {
  const fixture = await routedExecutorFixture(t, 'routed-read-only-target'); const forgedTarget = await mkdtemp(join(tmpdir(), 'zcode-routed-forged-target-'));
  t.after(() => rm(forgedTarget, { recursive: true, force: true }));
  const route = JSON.parse(await readFile(fixture.routePath, 'utf8')); await writeFile(fixture.routePath, JSON.stringify({ ...route, targetWorkspace: await realpath(forgedTarget) }), { mode: 0o600 });
  const before = await privateTreeSnapshot(fixture.data);
  await assert.rejects(resolveRoutedForwardingExecutor(fixture.data, fixture.origin, fixture.start.agent_id), { code: 'EXECUTOR_ROUTE_INVALID' });
  assert.deepEqual(await privateTreeSnapshot(fixture.data), before, 'a forged target without an existing partition must leave the entire private data tree unchanged');
});

test('routed executor treats a missing lock directory in populated hook state as corruption', async (t) => {
  const fixture = await routedExecutorFixture(t, 'routed-missing-lock-directory');
  await rm(join(fixture.originDirectory, '.lock'), { recursive: true });
  await assert.rejects(resolveRoutedForwardingExecutor(fixture.data, fixture.origin, fixture.start.agent_id), { code: 'EXECUTOR_ROUTE_INVALID' });
});

test('routed executor treats a missing advisory lock in populated hook state as corruption', async (t) => {
  const fixture = await routedExecutorFixture(t, 'routed-missing-advisory-lock');
  await unlink(join(fixture.originDirectory, '.lock', 'advisory.lock'));
  await assert.rejects(resolveRoutedForwardingExecutor(fixture.data, fixture.origin, fixture.start.agent_id), { code: 'EXECUTOR_ROUTE_INVALID' });
});

test('routed executor rejects permissive private authority modes without repairing them', { skip: process.platform === 'win32' ? 'Windows does not expose POSIX private modes.' : false }, async (t) => {
  const fixture = await routedExecutorFixture(t, 'routed-private-modes');
  for (const [path, permissive, privateMode] of [
    [fixture.originDirectory, 0o777, 0o700], [fixture.routePath, 0o666, 0o600],
    [fixture.targetDirectory, 0o777, 0o700], [fixture.executorPath, 0o666, 0o600],
    [join(fixture.originDirectory, '.lock'), 0o777, 0o700], [join(fixture.originDirectory, '.lock', 'advisory.lock'), 0o666, 0o600],
  ]) {
    await chmod(path, permissive); const beforeMode = (await stat(path)).mode & 0o777;
    await assert.rejects(resolveRoutedForwardingExecutor(fixture.data, fixture.origin, fixture.start.agent_id));
    assert.equal((await stat(path)).mode & 0o777, beforeMode, 'read-only resolution must not repair permissive authority modes');
    await chmod(path, privateMode);
  }
});

test('routed executor requires every route and executor authority field to match exactly', async (t) => {
  const fixture = await routedExecutorFixture(t, 'routed-exact-match'); const routeBytes = await readFile(fixture.routePath); const route = JSON.parse(routeBytes); const executorBytes = await readFile(fixture.executorPath); const executor = JSON.parse(executorBytes);
  for (const changes of [
    { agentId: 'routed-exact-match-other-child' }, { agentType: 'default' }, { parentSessionId: 'routed-exact-match-other-parent' },
    { parentGenerationId: 'e'.repeat(64) }, { parentTurnId: 'routed-exact-match-other-parent-turn' }, { parentPermissionMode: 'default' },
    { childTurnId: 'routed-exact-match-other-child-turn' }, { originWorkspace: '/routed-exact-match-other-origin' }, { workspace: '/routed-exact-match-other-target' },
    { createdAt: new Date(Date.parse(executor.createdAt) - 1_000).toISOString() },
  ]) {
    await writeFile(fixture.executorPath, JSON.stringify({ ...executor, ...changes }), { mode: 0o600 });
    await assert.rejects(resolveRoutedForwardingExecutor(fixture.data, fixture.origin, fixture.start.agent_id), { code: 'EXECUTOR_ROUTE_INVALID' });
    await writeFile(fixture.executorPath, executorBytes, { mode: 0o600 });
  }
  await writeFile(fixture.routePath, JSON.stringify({ ...route, parentGenerationId: 'f'.repeat(64) }), { mode: 0o600 });
  await assert.rejects(resolveRoutedForwardingExecutor(fixture.data, fixture.origin, fixture.start.agent_id), { code: 'EXECUTOR_ROUTE_INVALID' });
  await writeFile(fixture.routePath, JSON.stringify({ ...route, agentType: 'explorer' }), { mode: 0o600 });
  await assert.rejects(resolveRoutedForwardingExecutor(fixture.data, fixture.origin, fixture.start.agent_id), { code: 'EXECUTOR_ROUTE_INVALID' });
});

test('every routed executor public error family redacts workspace and authority identities', async (t) => {
  const fixture = await routedExecutorFixture(t, 'routed-public-errors'); const routeBytes = await readFile(fixture.routePath); const route = JSON.parse(routeBytes); const executorBytes = await readFile(fixture.executorPath); const secrets = [fixture.origin, fixture.target, fixture.start.agent_id, fixture.start.session_id, fixture.start.turn_id, fixture.caller.generationId];
  const expect = (code, options = {}) => assertPrivateRoutedError(() => resolveRoutedForwardingExecutor(fixture.data, fixture.origin, fixture.start.agent_id, options), code, secrets);
  await unlink(fixture.routePath); await expect('EXECUTOR_IDENTITY_NOT_FOUND');
  await writeFile(fixture.routePath, '{', { mode: 0o600 }); await expect('EXECUTOR_ROUTE_INVALID');
  await writeFile(fixture.routePath, JSON.stringify({ ...route, state: 'pending' }), { mode: 0o600 }); await expect('EXECUTOR_STATE_MISMATCH');
  await writeFile(fixture.routePath, JSON.stringify({ ...route, updatedAt: new Date(Date.now() + 60_000).toISOString() }), { mode: 0o600 }); await expect('EXECUTOR_ROUTE_INVALID');
  await writeFile(fixture.routePath, routeBytes, { mode: 0o600 }); await expect('EXECUTOR_STATE_MISMATCH', { continuation: true });
  await writeFile(fixture.executorPath, JSON.stringify({ ...JSON.parse(executorBytes), parentTurnId: 'routed-public-errors-forged-target-turn' }), { mode: 0o600 }); await expect('EXECUTOR_ROUTE_INVALID');
});

test('pending executor route linearizes Start and Stop without an active orphan', async (t) => {
  const { cwd: origin, data } = await workspace(); const target = await addLinkedWorktree(origin, 'pending-route-race');
  t.after(() => rm(target, { recursive: true, force: true }));
  const identity = createIdentityStore({ dataRoot: data }); const proof = { sessionStartedAt: '2026-08-21T09:00:00.000Z', sessionSource: 'startup', lifecycleResult: true };
  await recordSession(data, { session_id: 'route-race-parent', cwd: origin, source: 'startup' });
  await identity.beginCallerTurn({ sessionId: 'route-race-parent', turnId: 'route-race-parent-turn', workspace: origin, permissionMode: 'workspace-write', prompt: 'race', ...proof });
  const caller = await identity.resolveActiveTurn({ sessionId: 'route-race-parent', workspace: target, workspaceBinding: 'claim' });
  const start = { session_id: 'route-race-parent', turn_id: 'route-race-parent-turn', cwd: origin, hook_event_name: 'SubagentStart', agent_id: 'route-race-child', agent_type: 'zcode-rescue' };
  let release; let pendingReachedResolve; const pendingReached = new Promise((resolvePromise) => { pendingReachedResolve = resolvePromise; }); const blocker = new Promise((resolvePromise) => { release = resolvePromise; });
  const starting = markForwarding(data, start, caller, { publicationSeam: async (point) => { if (point === 'after-route-pending') { pendingReachedResolve(); await blocker; } } });
  await pendingReached;
  assert.equal(await isForwarding(data, { session_id: start.session_id, turn_id: start.turn_id, cwd: origin }), true, 'fresh pending route must suppress the transient Root Stop window');
  assert.deepEqual(await runStopReviewGate({ session_id: start.session_id, turn_id: start.turn_id, cwd: origin, stop_hook_active: false }, { dataRoot: data, env: {}, timeoutMs: 1 }), {});
  assert.equal((await identity.resolveActiveTurn({ sessionId: start.session_id, workspace: origin, workspaceBinding: 'execution' })).generationId, caller.generationId, 'pending forwarding must not revoke parent authority');
  await assert.rejects(resolveForwardingExecutor(data, target, start.agent_id), { code: 'EXECUTOR_IDENTITY_NOT_FOUND' });
  await markForwarding(data, { ...start, hook_event_name: 'SubagentStop' });
  release(); await starting;
  assert.equal((await resolveForwardingRoute(data, origin, start.session_id, start.turn_id)).state, 'stopped');
  assert.equal((await resolveForwardingExecutor(data, target, start.agent_id, { continuation: true, durableProvenance: true })).active, false);
  await assert.rejects(resolveForwardingExecutor(data, target, start.agent_id), { code: 'EXECUTOR_IDENTITY_NOT_FOUND' });
});

test('a replayed SubagentStart rejects an exact stopped route without reviving its executor', async () => {
  const { cwd, data } = await workspace(); const identity = createIdentityStore({ dataRoot: data });
  const proof = { sessionStartedAt: '2026-08-21T09:00:00.000Z', sessionSource: 'startup', lifecycleResult: true };
  await identity.beginCallerTurn({ sessionId: 'stopped-replay-parent', turnId: 'stopped-replay-parent-turn', workspace: cwd, permissionMode: 'workspace-write', prompt: 'stopped replay', ...proof });
  const caller = await identity.resolveActiveTurn({ sessionId: 'stopped-replay-parent', workspace: cwd, workspaceBinding: 'claim' });
  const start = { session_id: caller.sessionId, turn_id: 'stopped-replay-child-turn', cwd, hook_event_name: 'SubagentStart', agent_id: 'stopped-replay-child', agent_type: 'zcode-rescue' };
  await markForwarding(data, start, caller);
  await markForwarding(data, { ...start, hook_event_name: 'SubagentStop' });
  assert.equal((await resolveForwardingRoute(data, cwd, start.session_id, start.turn_id)).state, 'stopped');
  assert.equal((await resolveForwardingExecutor(data, cwd, start.agent_id, { continuation: true, durableProvenance: true })).active, false);

  let crossedPublicationSeam = false;
  await assert.rejects(markForwarding(data, start, caller, { publicationSeam: () => { crossedPublicationSeam = true; } }), { code: 'EXECUTOR_ROUTE_INVALID' });
  assert.equal(crossedPublicationSeam, false, 'a pre-existing stopped route must reject before executor publication');
  assert.equal((await resolveForwardingRoute(data, cwd, start.session_id, start.turn_id)).state, 'stopped');
  assert.equal((await resolveForwardingExecutor(data, cwd, start.agent_id, { continuation: true, durableProvenance: true })).active, false);
  await assert.rejects(resolveForwardingExecutor(data, cwd, start.agent_id), { code: 'EXECUTOR_IDENTITY_NOT_FOUND' });
});

test('pending executor route crash is short-lived, retryable, and cleanup removes exact routes', async (t) => {
  const { cwd: origin, data } = await workspace(); const target = await addLinkedWorktree(origin, 'pending-route-retry');
  t.after(() => rm(target, { recursive: true, force: true }));
  const identity = createIdentityStore({ dataRoot: data }); const proof = { sessionStartedAt: '2026-08-21T09:00:00.000Z', sessionSource: 'startup', lifecycleResult: true };
  await identity.beginCallerTurn({ sessionId: 'route-retry-parent', turnId: 'route-retry-parent-turn', workspace: origin, permissionMode: 'workspace-write', prompt: 'retry', ...proof });
  const caller = await identity.resolveActiveTurn({ sessionId: 'route-retry-parent', workspace: target, workspaceBinding: 'claim' });
  const start = { session_id: 'route-retry-parent', turn_id: 'route-retry-child-turn', cwd: origin, hook_event_name: 'SubagentStart', agent_id: 'route-retry-child', agent_type: 'zcode-rescue' };
  await assert.rejects(markForwarding(data, start, caller, { publicationSeam: (point) => { if (point === 'after-route-pending') throw new Error('injected pending crash'); } }), /injected pending crash/);
  const pending = await resolveForwardingRoute(data, origin, start.session_id, start.turn_id); assert.equal(pending.state, 'pending');
  assert.equal(await isForwarding(data, { session_id: start.session_id, turn_id: start.turn_id, cwd: origin }, { now: new Date(Date.parse(pending.updatedAt) + 30_000) }), false);
  await markForwarding(data, start, caller); assert.equal((await resolveForwardingRoute(data, origin, start.session_id, start.turn_id)).state, 'active');
  await cleanupSession(data, origin, start.session_id);
  await assert.rejects(resolveForwardingRoute(data, origin, start.session_id, start.turn_id), { code: 'EXECUTOR_ROUTE_NOT_FOUND' });
  const targetStorage = await resolveWorkspaceStorage({ dataRoot: data, workspace: target }); assert.ok((await readdir(join(targetStorage.directory, 'hook-state'))).some((name) => name.startsWith('executor-')), 'target cleanup remains independently retryable');
  await cleanupSession(data, target, start.session_id); await assert.rejects(resolveForwardingExecutor(data, target, start.agent_id), { code: 'EXECUTOR_IDENTITY_NOT_FOUND' });
});

test('expired pending retry refreshes its lease but cannot publish after parent authority is revoked', async (t) => {
  const { cwd: origin, data } = await workspace(); const target = await addLinkedWorktree(origin, 'pending-route-expired-retry');
  t.after(() => rm(target, { recursive: true, force: true }));
  const identity = createIdentityStore({ dataRoot: data }); const proof = { sessionStartedAt: '2026-08-21T09:00:00.000Z', sessionSource: 'startup', lifecycleResult: true };
  await identity.beginCallerTurn({ sessionId: 'expired-retry-parent', turnId: 'expired-retry-parent-turn', workspace: origin, permissionMode: 'workspace-write', prompt: 'expired retry', ...proof });
  const caller = await identity.resolveActiveTurn({ sessionId: 'expired-retry-parent', workspace: target, workspaceBinding: 'claim' });
  const start = { session_id: caller.sessionId, turn_id: 'expired-retry-child-turn', cwd: origin, hook_event_name: 'SubagentStart', agent_id: 'expired-retry-child', agent_type: 'zcode-rescue' };
  await assert.rejects(markForwarding(data, start, caller, { publicationSeam: (point) => { if (point === 'after-route-pending') throw new Error('initial pending crash'); } }), /initial pending crash/);
  const storage = await resolveWorkspaceStorage({ dataRoot: data, workspace: origin }); const directory = join(storage.directory, 'hook-state');
  const routePath = join(directory, (await readdir(directory)).find((name) => name.startsWith('route-'))); const stale = JSON.parse(await readFile(routePath, 'utf8'));
  const staleAt = new Date(Date.now() - 31_000).toISOString(); await writeFile(routePath, JSON.stringify({ ...stale, createdAt: staleAt, updatedAt: staleAt }));
  let releasePending; let pendingResolve; const pending = new Promise((resolvePromise) => { pendingResolve = resolvePromise; }); const pendingBlocker = new Promise((resolvePromise) => { releasePending = resolvePromise; });
  let releaseExecutor; let executorResolve; const executor = new Promise((resolvePromise) => { executorResolve = resolvePromise; }); const executorBlocker = new Promise((resolvePromise) => { releaseExecutor = resolvePromise; });
  const retry = markForwarding(data, start, caller, { publicationSeam: async (point) => {
    if (point === 'after-route-pending') { pendingResolve(); await pendingBlocker; }
    if (point === 'after-executor-write') { executorResolve(); await executorBlocker; }
  } });
  await pending;
  const refreshed = await resolveForwardingRoute(data, origin, start.session_id, start.turn_id); assert.ok(Date.parse(refreshed.updatedAt) > Date.parse(staleAt));
  assert.equal(await isForwarding(data, { session_id: start.session_id, turn_id: start.turn_id, cwd: origin }), true);
  assert.deepEqual(await runStopReviewGate({ session_id: start.session_id, turn_id: start.turn_id, cwd: origin, stop_hook_active: false }, { dataRoot: data, env: {}, timeoutMs: 1 }), {});
  releasePending(); await executor;
  await identity.endCallerTurn({ sessionId: caller.sessionId, turnId: caller.turnId, workspace: origin });
  releaseExecutor(); await assert.rejects(retry, { code: 'EXECUTOR_PARENT_TURN_MISMATCH' });
  assert.equal((await resolveForwardingRoute(data, origin, start.session_id, start.turn_id)).state, 'stopped');
  assert.equal((await resolveForwardingExecutor(data, target, start.agent_id, { continuation: true, durableProvenance: true })).active, false);
});

test('legacy pending authority is proved without a generation and Stop still wins the publication race', async () => {
  const { cwd, data } = await workspace(); const identity = createIdentityStore({ dataRoot: data });
  await identity.beginCallerTurn({ sessionId: 'legacy-pending-parent', turnId: 'legacy-pending-parent-turn', workspace: cwd, permissionMode: 'workspace-write', prompt: 'legacy pending' });
  const caller = await identity.resolveActiveTurn({ sessionId: 'legacy-pending-parent', workspace: cwd }); assert.equal(caller.generationId, undefined);
  const start = { session_id: caller.sessionId, turn_id: 'legacy-pending-child-turn', cwd, hook_event_name: 'SubagentStart', agent_id: 'legacy-pending-child', agent_type: 'zcode-rescue' };
  let release; let pendingResolve; const pending = new Promise((resolvePromise) => { pendingResolve = resolvePromise; }); const blocker = new Promise((resolvePromise) => { release = resolvePromise; });
  const starting = markForwarding(data, start, caller, { publicationSeam: async (point) => { if (point === 'after-route-pending') { pendingResolve(); await blocker; } } });
  await pending; assert.equal(await isForwarding(data, { session_id: start.session_id, turn_id: start.turn_id, cwd }), true);
  await markForwarding(data, { ...start, hook_event_name: 'SubagentStop' }); release(); await starting;
  assert.equal((await resolveForwardingRoute(data, cwd, start.session_id, start.turn_id)).state, 'stopped');
  assert.equal((await resolveForwardingExecutor(data, cwd, start.agent_id, { continuation: true, durableProvenance: true })).active, false);
});

test('pending target rewrite neither suppresses Root Stop nor leaves an active executor', async (t) => {
  const { cwd: origin, data } = await workspace(); const target = await addLinkedWorktree(origin, 'route-target-original'); const forgedTarget = await addLinkedWorktree(origin, 'route-target-forged');
  t.after(() => Promise.all([target, forgedTarget].map((path) => rm(path, { recursive: true, force: true }))));
  const identity = createIdentityStore({ dataRoot: data }); const proof = { sessionStartedAt: '2026-08-21T09:00:00.000Z', sessionSource: 'startup', lifecycleResult: true };
  await identity.beginCallerTurn({ sessionId: 'target-rewrite-parent', turnId: 'target-rewrite-parent-turn', workspace: origin, permissionMode: 'workspace-write', prompt: 'target rewrite', ...proof });
  const caller = await identity.resolveActiveTurn({ sessionId: 'target-rewrite-parent', workspace: target, workspaceBinding: 'claim' });
  const start = { session_id: caller.sessionId, turn_id: 'target-rewrite-child-turn', cwd: origin, hook_event_name: 'SubagentStart', agent_id: 'target-rewrite-child', agent_type: 'zcode-rescue' };
  let release; let writtenResolve; const written = new Promise((resolvePromise) => { writtenResolve = resolvePromise; }); const blocker = new Promise((resolvePromise) => { release = resolvePromise; });
  const starting = markForwarding(data, start, caller, { publicationSeam: async (point) => { if (point === 'after-executor-write') { writtenResolve(); await blocker; } } });
  await written;
  const storage = await resolveWorkspaceStorage({ dataRoot: data, workspace: origin }); const directory = join(storage.directory, 'hook-state'); const names = await readdir(directory);
  const routePath = join(directory, names.find((name) => name.startsWith('route-'))); const markerPath = join(directory, names.find((name) => name.startsWith('forward-'))); const canonicalForged = await realpath(forgedTarget);
  await writeFile(routePath, JSON.stringify({ ...JSON.parse(await readFile(routePath, 'utf8')), targetWorkspace: canonicalForged }));
  await writeFile(markerPath, JSON.stringify({ ...JSON.parse(await readFile(markerPath, 'utf8')), targetWorkspace: canonicalForged }));
  assert.equal(await isForwarding(data, { session_id: start.session_id, turn_id: start.turn_id, cwd: origin }), false);
  release(); await assert.rejects(starting, { code: 'EXECUTOR_ROUTE_INVALID' });
  assert.equal((await resolveForwardingRoute(data, origin, start.session_id, start.turn_id)).state, 'pending', 'an untrusted rewritten route must not be blessed with a stopped transition');
  const targetStorage = await resolveWorkspaceStorage({ dataRoot: data, workspace: target }); const targetDirectory = join(targetStorage.directory, 'hook-state');
  const rawExecutor = JSON.parse(await readFile(join(targetDirectory, (await readdir(targetDirectory)).find((name) => name.startsWith('executor-'))), 'utf8')); assert.equal(rawExecutor.active, false);
  await assert.rejects(resolveForwardingExecutor(data, target, start.agent_id), { code: 'EXECUTOR_IDENTITY_NOT_FOUND' });
});

test('active publication rejects a replacement generation that moves execution worktrees', async (t) => {
  const { cwd: origin, data } = await workspace(); const firstTarget = await addLinkedWorktree(origin, 'publication-target-first'); const replacementTarget = await addLinkedWorktree(origin, 'publication-target-replacement');
  t.after(() => Promise.all([firstTarget, replacementTarget].map((path) => rm(path, { recursive: true, force: true }))));
  const identity = createIdentityStore({ dataRoot: data }); const proof = { sessionStartedAt: '2026-08-21T09:00:00.000Z', sessionSource: 'startup', lifecycleResult: true };
  await identity.beginCallerTurn({ sessionId: 'publication-replacement-parent', turnId: 'same-publication-turn', workspace: origin, permissionMode: 'workspace-write', prompt: 'first generation', ...proof });
  const first = await identity.resolveActiveTurn({ sessionId: 'publication-replacement-parent', workspace: firstTarget, workspaceBinding: 'claim' });
  const start = { session_id: first.sessionId, turn_id: 'publication-replacement-child-turn', cwd: origin, hook_event_name: 'SubagentStart', agent_id: 'publication-replacement-child', agent_type: 'zcode-rescue' };
  let release; let writtenResolve; const written = new Promise((resolvePromise) => { writtenResolve = resolvePromise; }); const blocker = new Promise((resolvePromise) => { release = resolvePromise; });
  const starting = markForwarding(data, start, first, { publicationSeam: async (point) => { if (point === 'after-executor-write') { writtenResolve(); await blocker; } } });
  await written;
  await identity.beginCallerTurn({ sessionId: first.sessionId, turnId: first.turnId, workspace: origin, permissionMode: first.permissionMode, prompt: 'replacement generation', ...proof });
  const replacement = await identity.resolveActiveTurn({ sessionId: first.sessionId, workspace: replacementTarget, workspaceBinding: 'claim' }); assert.notEqual(replacement.generationId, first.generationId);
  release(); await assert.rejects(starting, { code: 'EXECUTOR_PARENT_TURN_MISMATCH' });
  assert.equal((await resolveForwardingRoute(data, origin, start.session_id, start.turn_id)).state, 'stopped');
  const targetStorage = await resolveWorkspaceStorage({ dataRoot: data, workspace: firstTarget }); const targetDirectory = join(targetStorage.directory, 'hook-state');
  const rawExecutor = JSON.parse(await readFile(join(targetDirectory, (await readdir(targetDirectory)).find((name) => name.startsWith('executor-'))), 'utf8')); assert.equal(rawExecutor.active, false);
});

test('route finalization failures compensate the exact executor without rebuilding untrusted origin state', async (t) => {
  const run = async (name, mutate) => {
    const { cwd: origin, data } = await workspace(); const target = await addLinkedWorktree(origin, `finalization-${name}`);
    t.after(() => rm(target, { recursive: true, force: true }));
    const identity = createIdentityStore({ dataRoot: data }); const proof = { sessionStartedAt: '2026-08-21T09:00:00.000Z', sessionSource: 'startup', lifecycleResult: true };
    await identity.beginCallerTurn({ sessionId: `finalization-${name}-parent`, turnId: `finalization-${name}-parent-turn`, workspace: origin, permissionMode: 'workspace-write', prompt: name, ...proof });
    const caller = await identity.resolveActiveTurn({ sessionId: `finalization-${name}-parent`, workspace: target, workspaceBinding: 'claim' });
    const start = { session_id: caller.sessionId, turn_id: `finalization-${name}-child-turn`, cwd: origin, hook_event_name: 'SubagentStart', agent_id: `finalization-${name}-child`, agent_type: 'zcode-rescue' };
    let release; let writtenResolve; const written = new Promise((resolvePromise) => { writtenResolve = resolvePromise; }); const blocker = new Promise((resolvePromise) => { release = resolvePromise; });
    const starting = markForwarding(data, start, caller, { publicationSeam: async (point) => { if (point === 'after-executor-write') { writtenResolve(); await blocker; } } });
    await written;
    const originStorage = await resolveWorkspaceStorage({ dataRoot: data, workspace: origin }); const originDirectory = join(originStorage.directory, 'hook-state'); const originNames = await readdir(originDirectory);
    const routePath = join(originDirectory, originNames.find((entry) => entry.startsWith('route-'))); const markerPath = join(originDirectory, originNames.find((entry) => entry.startsWith('forward-')));
    const targetStorage = await resolveWorkspaceStorage({ dataRoot: data, workspace: target }); const targetDirectory = join(targetStorage.directory, 'hook-state'); const executorPath = join(targetDirectory, (await readdir(targetDirectory)).find((entry) => entry.startsWith('executor-')));
    await mutate({ data, origin, target, routePath, markerPath, executorPath }); release();
    await assert.rejects(starting, (error) => error?.code === 'EXECUTOR_ROUTE_INVALID' && !`${error.message}${error.remedy}`.includes(origin));
    let executor = null; try { executor = JSON.parse(await readFile(executorPath, 'utf8')); } catch { /* SessionEnd may already have removed it. */ }
    assert.notEqual(executor?.active, true, 'failed finalization must never retain an active exact executor');
    return { routePath, markerPath };
  };

  await t.test('missing route', async () => {
    const { routePath } = await run('missing-route', ({ routePath: path }) => unlink(path));
    await assert.rejects(readFile(routePath, 'utf8'), { code: 'ENOENT' });
  });
  await t.test('malformed route', async () => {
    const { routePath } = await run('malformed-route', ({ routePath: path }) => writeFile(path, '{"state":'));
    assert.equal(await readFile(routePath, 'utf8'), '{"state":', 'compensation must not rewrite malformed origin state');
  });
  await t.test('SessionEnd target-first cleanup', async () => {
    const { routePath, markerPath } = await run('session-end-target-first', async ({ data, origin, target }) => { await cleanupSession(data, target, 'finalization-session-end-target-first-parent'); await cleanupSession(data, origin, 'finalization-session-end-target-first-parent'); });
    await assert.rejects(readFile(routePath, 'utf8'), { code: 'ENOENT' }); await assert.rejects(readFile(markerPath, 'utf8'), { code: 'ENOENT' });
  });
});

test('executor persistence failure after rename is compensated without hiding the primary error', async (t) => {
  const { cwd: origin, data } = await workspace(); const target = await addLinkedWorktree(origin, 'executor-post-rename-failure');
  t.after(() => rm(target, { recursive: true, force: true }));
  const identity = createIdentityStore({ dataRoot: data }); const proof = { sessionStartedAt: '2026-08-21T09:00:00.000Z', sessionSource: 'startup', lifecycleResult: true };
  await identity.beginCallerTurn({ sessionId: 'post-rename-parent', turnId: 'post-rename-parent-turn', workspace: origin, permissionMode: 'workspace-write', prompt: 'post rename', ...proof });
  const caller = await identity.resolveActiveTurn({ sessionId: 'post-rename-parent', workspace: target, workspaceBinding: 'claim' });
  const start = { session_id: caller.sessionId, turn_id: 'post-rename-child-turn', cwd: origin, hook_event_name: 'SubagentStart', agent_id: 'post-rename-child', agent_type: 'zcode-rescue' };
  await assert.rejects(markForwarding(data, start, caller, { publicationSeam: (point) => { if (point === 'after-executor-persisted') throw new Error('injected post-rename failure'); } }),
    (error) => error?.code === 'EXECUTOR_ROUTE_INVALID' && error?.cause?.message === 'injected post-rename failure');
  const targetStorage = await resolveWorkspaceStorage({ dataRoot: data, workspace: target }); const targetDirectory = join(targetStorage.directory, 'hook-state');
  const rawExecutor = JSON.parse(await readFile(join(targetDirectory, (await readdir(targetDirectory)).find((name) => name.startsWith('executor-'))), 'utf8')); assert.equal(rawExecutor.active, false);
  assert.equal((await resolveForwardingRoute(data, origin, start.session_id, start.turn_id)).state, 'pending', 'failed executor publication must not promote its route');
});

test('executor uniqueness is scoped to parent generation while duplicate same-generation children remain ambiguous', async (t) => {
  const { cwd: origin, data } = await workspace(); const target = await addLinkedWorktree(origin, 'executor-generation-scope');
  t.after(() => rm(target, { recursive: true, force: true }));
  const identity = createIdentityStore({ dataRoot: data }); const proof = { sessionStartedAt: '2026-08-21T09:00:00.000Z', sessionSource: 'startup', lifecycleResult: true };
  await identity.beginCallerTurn({ sessionId: 'generation-parent', turnId: 'same-parent-turn', workspace: origin, permissionMode: 'workspace-write', prompt: 'generation one', ...proof });
  const first = await identity.resolveActiveTurn({ sessionId: 'generation-parent', workspace: target, workspaceBinding: 'claim' });
  await markForwarding(data, { session_id: 'generation-parent', turn_id: 'child-generation-one', cwd: origin, hook_event_name: 'SubagentStart', agent_id: 'generation-child-one', agent_type: 'zcode-rescue' }, first);
  await identity.beginCallerTurn({ sessionId: 'generation-parent', turnId: 'same-parent-turn', workspace: origin, permissionMode: 'workspace-write', prompt: 'generation two', ...proof });
  const second = await identity.resolveActiveTurn({ sessionId: 'generation-parent', workspace: target, workspaceBinding: 'claim' }); assert.notEqual(first.generationId, second.generationId);
  await markForwarding(data, { session_id: 'generation-parent', turn_id: 'child-generation-two', cwd: origin, hook_event_name: 'SubagentStart', agent_id: 'generation-child-two', agent_type: 'zcode-rescue' }, second);
  assert.equal((await resolveForwardingExecutor(data, target, 'generation-child-two')).parentGenerationId, second.generationId);
  await markForwarding(data, { session_id: 'generation-parent', turn_id: 'child-generation-two-b', cwd: origin, hook_event_name: 'SubagentStart', agent_id: 'generation-child-two-b', agent_type: 'zcode-rescue' }, second);
  await assert.rejects(resolveForwardingExecutor(data, target, 'generation-child-two'), { code: 'EXECUTOR_IDENTITY_AMBIGUOUS' });
});

test('executor routes use bounded nofollow reads and bounded sibling-safe cleanup', async () => {
  const { cwd, data } = await workspace(); const identity = createIdentityStore({ dataRoot: data });
  const make = async (sessionId, childId) => {
    await identity.beginCallerTurn({ sessionId, turnId: `${sessionId}-turn`, workspace: cwd, permissionMode: 'workspace-write', prompt: sessionId });
    const caller = await identity.resolveActiveTurn({ sessionId, workspace: cwd }); const input = { session_id: sessionId, turn_id: `${childId}-turn`, cwd, hook_event_name: 'SubagentStart', agent_id: childId, agent_type: 'zcode-rescue' };
    await markForwarding(data, input, caller); return input;
  };
  const owner = await make('route-owner', 'route-owner-child'); const sibling = await make('route-sibling', 'route-sibling-child');
  const storage = await resolveWorkspaceStorage({ dataRoot: data, workspace: cwd }); const directory = join(storage.directory, 'hook-state');
  const routeNames = (await readdir(directory)).filter((name) => name.startsWith('route-')); assert.equal(routeNames.length, 2);
  const exactOwnerRoute = (await Promise.all(routeNames.map(async (name) => ({ name, record: JSON.parse(await readFile(join(directory, name), 'utf8')) })))).find((entry) => entry.record.parentSessionId === owner.session_id);
  const routePath = join(directory, exactOwnerRoute.name); const original = await readFile(routePath, 'utf8'); const outside = join(data, 'outside-route.json'); await writeFile(outside, original, { mode: 0o600 });
  await unlink(routePath); await symlink(outside, routePath);
  await assert.rejects(resolveForwardingRoute(data, cwd, owner.session_id, owner.turn_id), (error) => error?.code === 'EXECUTOR_ROUTE_INVALID' && error?.cause?.code === 'PRIVATE_PATH_UNSAFE');
  await unlink(routePath); await writeFile(routePath, original, { mode: 0o600 }); await writeFile(routePath, `{"pad":"${'x'.repeat(17 * 1024)}"}`, { mode: 0o600 });
  await assert.rejects(resolveForwardingRoute(data, cwd, owner.session_id, owner.turn_id), (error) => error?.code === 'EXECUTOR_ROUTE_INVALID' && error?.cause?.code === 'PRIVATE_PATH_UNSAFE');
  await writeFile(routePath, original, { mode: 0o600 });
  const forged = JSON.stringify({ ...JSON.parse(original), parentSessionId: 'forged-route-owner' });
  await Promise.all([
    (async () => { for (let index = 0; index < 32; index += 1) await writeFile(routePath, index % 2 === 0 ? forged : original, { mode: 0o600 }); })(),
    (async () => { for (let index = 0; index < 32; index += 1) { try { assert.equal((await resolveForwardingRoute(data, cwd, owner.session_id, owner.turn_id)).parentSessionId, owner.session_id); } catch (error) { assert.equal(error.code, 'EXECUTOR_ROUTE_INVALID'); } } })(),
  ]);
  await writeFile(routePath, original, { mode: 0o600 }); await cleanupSession(data, cwd, owner.session_id);
  await assert.rejects(resolveForwardingRoute(data, cwd, owner.session_id, owner.turn_id), { code: 'EXECUTOR_ROUTE_NOT_FOUND' });
  assert.equal((await resolveForwardingRoute(data, cwd, sibling.session_id, sibling.turn_id)).parentSessionId, sibling.session_id);

  await Promise.all(Array.from({ length: 2_050 }, (_, index) => writeFile(join(directory, `junk-${String(index).padStart(4, '0')}.json`), '{}')));
  await assert.rejects(cleanupSession(data, cwd, sibling.session_id), (error) => error?.code === 'HOOK_STATE_CAPACITY' && !`${error.message}${error.remedy}`.includes(sibling.session_id));
});

test('origin cwd Root Stop revokes authority before bound worktree preparation cleanup', async (t) => {
  const { cwd: origin, data, env } = await workspace();
  const target = await addLinkedWorktree(origin, 'origin-cwd-root-stop');
  t.after(() => rm(target, { recursive: true, force: true }));
  const identity = createIdentityStore({ dataRoot: data });
  const preparations = createRescuePreparationStore({ dataRoot: data });
  const started = await runHook('session-lifecycle-hook.mjs', { session_id: 'stop-routed-parent', cwd: origin, hook_event_name: 'SessionStart', transcript_path: null, model: 'gpt', permission_mode: 'default', source: 'startup' }, env);
  assert.equal(started.code, 0, started.stderr);
  const prompt = { session_id: 'stop-routed-parent', turn_id: 'stop-routed-turn', cwd: origin, hook_event_name: 'UserPromptSubmit', transcript_path: null, model: 'gpt', permission_mode: 'acceptEdits', prompt: 'finish target work' };
  assert.equal((await runHook('user-prompt-hook.mjs', prompt, env)).code, 0);
  const caller = await identity.resolveActiveTurn({ sessionId: prompt.session_id, workspace: target, workspaceBinding: 'claim' });
  await preparations.save({ ...caller, recordedPrompt: caller.prompt, envelope: { version: 1, source: 'proactive', task: 'finish target work', options: {} } });

  const stopped = await runHook('stop-review-gate-hook.mjs', { ...stopFields(prompt), hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'done' }, env);
  assert.equal(stopped.code, 0, stopped.stderr);
  await assert.rejects(identity.resolveActiveTurn({ sessionId: prompt.session_id, workspace: origin }), { code: 'ACTIVE_TURN_NOT_FOUND' });
  await assert.rejects(preparations.consume({ ...caller, executorAgentId: 'child' }), { code: 'RESCUE_PREPARATION_NOT_FOUND' });
});

test('origin cwd SessionEnd tombstones before bounded cleanup across two origins and targets', async (t) => {
  const { cwd: originA, data, env } = await workspace();
  const targetA = await addLinkedWorktree(originA, 'session-target-a');
  const originB = await addLinkedWorktree(originA, 'session-origin-b');
  const targetB = await addLinkedWorktree(originA, 'session-target-b');
  t.after(() => Promise.all([targetA, originB, targetB].map((path) => rm(path, { recursive: true, force: true }))));
  const identity = createIdentityStore({ dataRoot: data });
  const proof = { sessionStartedAt: '2026-08-21T09:00:00.000Z', sessionSource: 'startup', lifecycleResult: true };
  await identity.beginCallerTurn({ sessionId: 'multi-workspace-parent', turnId: 'turn-a', workspace: originA, permissionMode: 'workspace-write', prompt: 'a', ...proof });
  await identity.resolveActiveTurn({ sessionId: 'multi-workspace-parent', workspace: targetA, workspaceBinding: 'claim' });
  const childStart = { session_id: 'multi-workspace-parent', turn_id: 'child-a', cwd: originA, hook_event_name: 'SubagentStart', transcript_path: null, model: 'gpt', permission_mode: 'acceptEdits', agent_id: 'multi-child', agent_type: 'zcode-rescue' };
  assert.equal((await runHook('subagent-hook.mjs', childStart, env)).code, 0);

  await identity.beginCallerTurn({ sessionId: 'multi-workspace-parent', turnId: 'turn-b', workspace: originB, permissionMode: 'workspace-write', prompt: 'b', ...proof });
  const callerB = await identity.resolveActiveTurn({ sessionId: 'multi-workspace-parent', workspace: targetB, workspaceBinding: 'claim' });
  const preparations = createRescuePreparationStore({ dataRoot: data });
  await preparations.save({ ...callerB, recordedPrompt: callerB.prompt, envelope: { version: 1, source: 'proactive', task: 'b', options: {} } });
  await preparations.save({ sessionId: 'sibling-session', turnId: 'sibling-turn', workspace: targetB, permissionMode: 'default', recordedPrompt: 'sibling', envelope: { version: 1, source: 'proactive', task: 'sibling', options: {} } });

  await identity.beginCallerTurn({ sessionId: 'multi-workspace-parent', turnId: 'turn-c', workspace: originA, permissionMode: 'workspace-write', prompt: 'c', ...proof });
  await identity.resolveActiveTurn({ sessionId: 'multi-workspace-parent', workspace: targetA, workspaceBinding: 'claim' });

  const targetAStorage = await resolveWorkspaceStorage({ dataRoot: data, workspace: targetA }); const targetAHookState = join(targetAStorage.directory, 'hook-state'); const blockedLock = join(targetAHookState, '.lock', 'advisory.lock');
  await rm(blockedLock, { force: true }); await mkdir(blockedLock);
  const endInput = { session_id: 'multi-workspace-parent', cwd: originA, hook_event_name: 'SessionEnd', transcript_path: null, reason: 'other' };
  const ended = await runHook('session-end-hook.mjs', endInput, env);
  assert.equal(ended.code, 0, ended.stderr);
  await assert.rejects(identity.resolveActiveTurn({ sessionId: 'multi-workspace-parent', workspace: originA }), { code: 'ACTIVE_TURN_NOT_FOUND' });
  assert.ok((await readdir(targetAHookState)).some((name) => name.startsWith('executor-')), 'failed target cleanup must retain retryable state after the tombstone');
  await rmdir(blockedLock);
  const retried = await runHook('session-end-hook.mjs', endInput, env); assert.equal(retried.code, 0, retried.stderr);
  await assert.rejects(resolveForwardingExecutor(data, targetA, 'multi-child'), { code: 'EXECUTOR_IDENTITY_NOT_FOUND' });
  await assert.rejects(preparations.consume({ ...callerB, executorAgentId: 'multi-child' }), { code: 'RESCUE_PREPARATION_NOT_FOUND' });
  assert.equal((await preparations.consume({ sessionId: 'sibling-session', turnId: 'sibling-turn', workspace: targetB, permissionMode: 'default', executorAgentId: 'sibling-child' })).envelope.task, 'sibling');
});

test('trusted SubagentStart binds one active child executor and fails closed on sibling, parent, workspace, stale stop, and duplicate records', async () => {
  const { cwd, data, env } = await workspace();
  const storage = await resolveWorkspaceStorage({ dataRoot: data, workspace: cwd });
  const identity = createIdentityStore({ dataRoot: data });
  await identity.beginCallerTurn({ sessionId: 'parent-thread', turnId: 'parent-origin', workspace: cwd, permissionMode: 'workspace-write', prompt: '$zcode:rescue --wait repair' });
  const input = (event, turnId, agentId = 'rescue-child', agentType = 'zcode-rescue') => ({ session_id: 'parent-thread', turn_id: turnId, cwd, hook_event_name: event, transcript_path: null, model: 'gpt', permission_mode: 'acceptEdits', agent_id: agentId, agent_type: agentType, ...(event === 'SubagentStop' ? { agent_transcript_path: null, stop_hook_active: false, last_assistant_message: null } : {}) });
  assert.equal((await runHook('subagent-hook.mjs', input('SubagentStart', 'child-turn-1'), env)).code, 0);
  assert.deepEqual(await resolveForwardingExecutor(data, cwd, 'rescue-child'), {
    kind: 'subagent-executor', agentId: 'rescue-child', agentType: 'zcode-rescue', parentSessionId: 'parent-thread', parentGenerationId: null, parentTurnId: 'parent-origin', parentPermissionMode: 'workspace-write', childTurnId: 'child-turn-1', originWorkspace: storage.workspacePath, workspace: storage.workspacePath, active: true, createdAt: (await resolveForwardingExecutor(data, cwd, 'rescue-child')).createdAt,
  });
  await runHook('subagent-hook.mjs', input('SubagentStart', 'general-turn', 'general-child', 'default'), env);
  await assert.rejects(resolveForwardingExecutor(data, cwd, 'general-child'), { code: 'EXECUTOR_IDENTITY_AMBIGUOUS' });
  await runHook('subagent-hook.mjs', input('SubagentStop', 'general-turn', 'general-child', 'default'), env);
  await runHook('subagent-hook.mjs', input('SubagentStart', 'wrong-role-turn', 'wrong-role-child', 'explorer'), env);
  await assert.rejects(resolveForwardingExecutor(data, cwd, 'wrong-role-child'), { code: 'EXECUTOR_ROLE_UNAPPROVED' });
  await runHook('subagent-hook.mjs', input('SubagentStop', 'wrong-role-turn', 'wrong-role-child', 'explorer'), env);
  await assert.rejects(resolveForwardingExecutor(data, cwd, 'sibling-child'), { code: 'EXECUTOR_IDENTITY_NOT_FOUND' });
  await assert.rejects(resolveForwardingExecutor(data, cwd, 'parent-thread'), { code: 'EXECUTOR_IDENTITY_NOT_FOUND' });
  const other = await mkdtemp(join(tmpdir(), 'zcode-wrong-workspace-'));
  await assert.rejects(resolveForwardingExecutor(data, other, 'rescue-child'), { code: 'EXECUTOR_IDENTITY_NOT_FOUND' });
  await rm(other, { recursive: true });
  await identity.beginCallerTurn({ sessionId: 'parent-thread', turnId: 'parent-answer', workspace: cwd, permissionMode: 'bypassPermissions', prompt: 'resume' });
  await runHook('subagent-hook.mjs', input('SubagentStart', 'child-turn-2'), env);
  await runHook('subagent-hook.mjs', input('SubagentStop', 'child-turn-1'), env);
  assert.equal((await resolveForwardingExecutor(data, cwd, 'rescue-child')).childTurnId, 'child-turn-2', 'a stale stop cannot deactivate a newer child turn');
  await runHook('subagent-hook.mjs', input('SubagentStart', 'other-turn', 'other-rescue-child'), env);
  await assert.rejects(resolveForwardingExecutor(data, cwd, 'rescue-child'), { code: 'EXECUTOR_IDENTITY_AMBIGUOUS' });
  await runHook('subagent-hook.mjs', input('SubagentStop', 'other-turn', 'other-rescue-child'), env);
  await assert.rejects(resolveForwardingExecutor(data, cwd, 'rescue-child', { continuation: true }), { code: 'EXECUTOR_STATE_MISMATCH' });
  await runHook('subagent-hook.mjs', input('SubagentStop', 'child-turn-2'), env);
  await assert.rejects(resolveForwardingExecutor(data, cwd, 'rescue-child'), { code: 'EXECUTOR_IDENTITY_NOT_FOUND' });
  assert.equal((await resolveForwardingExecutor(data, cwd, 'rescue-child', { continuation: true })).parentTurnId, 'parent-answer');
  await runHook('subagent-hook.mjs', input('SubagentStart', 'child-turn-3'), env);
  await cleanupSession(data, cwd, 'parent-thread');
  await assert.rejects(resolveForwardingExecutor(data, cwd, 'rescue-child'), { code: 'EXECUTOR_IDENTITY_NOT_FOUND' });
  await runHook('subagent-hook.mjs', input('SubagentStart', 'child-turn-4'), env);
  await writeFile(join(storage.directory, 'hook-state', 'executor-forged.json'), JSON.stringify({ ...(await resolveForwardingExecutor(data, cwd, 'rescue-child')), updatedAt: new Date().toISOString() }));
  await assert.rejects(resolveForwardingExecutor(data, cwd, 'rescue-child'), { code: 'EXECUTOR_IDENTITY_INVALID' });
});

test('legacy exact-workspace executor remains readable only without its lifecycle route', async () => {
  const { cwd, data, env } = await workspace(); const identity = createIdentityStore({ dataRoot: data });
  await identity.beginCallerTurn({ sessionId: 'legacy-executor-parent', turnId: 'legacy-parent-turn', workspace: cwd, permissionMode: 'workspace-write', prompt: 'legacy' });
  const input = { session_id: 'legacy-executor-parent', turn_id: 'legacy-child-turn', cwd, hook_event_name: 'SubagentStart', transcript_path: null, model: 'gpt', permission_mode: 'acceptEdits', agent_id: 'legacy-child', agent_type: 'zcode-rescue' };
  assert.equal((await runHook('subagent-hook.mjs', input, env)).code, 0);
  const storage = await resolveWorkspaceStorage({ dataRoot: data, workspace: cwd }); const directory = join(storage.directory, 'hook-state'); const names = await readdir(directory);
  const executorPath = join(directory, names.find((name) => name.startsWith('executor-'))); const routePath = join(directory, names.find((name) => name.startsWith('route-')));
  const current = JSON.parse(await readFile(executorPath, 'utf8')); delete current.parentGenerationId; delete current.originWorkspace;
  await writeFile(executorPath, JSON.stringify(current)); await unlink(routePath);
  assert.equal((await resolveForwardingExecutor(data, cwd, 'legacy-child')).parentTurnId, 'legacy-parent-turn');
  const stopped = await runHook('subagent-hook.mjs', { ...input, hook_event_name: 'SubagentStop', agent_transcript_path: null, stop_hook_active: false, last_assistant_message: null }, env);
  assert.equal(stopped.code, 0, stopped.stderr);
  assert.equal((await resolveForwardingExecutor(data, cwd, 'legacy-child', { continuation: true })).active, false);
});

test('executor records enforce exact schema, byte, time, TTL, and file-count bounds', async () => {
  const { cwd, data, env } = await workspace(); const identity = createIdentityStore({ dataRoot: data });
  await identity.beginCallerTurn({ sessionId: 'bounded-parent', turnId: 'bounded-turn', workspace: cwd, permissionMode: 'workspace-write', prompt: '$zcode:rescue --fresh --wait bounded' });
  const start = { session_id: 'bounded-parent', turn_id: 'bounded-child-turn', cwd, hook_event_name: 'SubagentStart', transcript_path: null, model: 'gpt', permission_mode: 'acceptEdits', agent_id: 'bounded-child', agent_type: 'zcode-rescue' };
  const storage = await resolveWorkspaceStorage({ dataRoot: data, workspace: cwd }); const directory = join(storage.directory, 'hook-state');
  const reset = async () => { assert.equal((await runHook('subagent-hook.mjs', start, env)).code, 0); return (await readdir(directory)).find((name) => name.startsWith('executor-') && name.endsWith('.json')); };
  for (const mutate of [
    (record) => { record.extra = true; },
    (record) => { record.agentId = 'x'.repeat(513); },
    (record) => { record.parentPermissionMode = 'hostile'; },
    (record) => { record.createdAt = '2026-08-10T00:00:00.000001Z'; },
  ]) {
    const name = await reset(); const path = join(directory, name); const record = JSON.parse(await readFile(path, 'utf8')); mutate(record); await writeFile(path, JSON.stringify(record));
    await assert.rejects(resolveForwardingExecutor(data, cwd, 'bounded-child'), { code: 'EXECUTOR_IDENTITY_INVALID' });
  }
  let name = await reset(); await writeFile(join(directory, name), `{"kind":"subagent-executor","pad":"${'x'.repeat(17 * 1024)}"}`);
  await assert.rejects(resolveForwardingExecutor(data, cwd, 'bounded-child'), { code: 'EXECUTOR_IDENTITY_INVALID' });
  name = await reset(); const fresh = await resolveForwardingExecutor(data, cwd, 'bounded-child');
  await assert.rejects(resolveForwardingExecutor(data, cwd, 'bounded-child', { now: new Date(Date.parse(fresh.createdAt) - 1) }), { code: 'EXECUTOR_IDENTITY_INVALID' });
  await assert.rejects(resolveForwardingExecutor(data, cwd, 'bounded-child', { now: new Date(Date.parse(fresh.createdAt) + 30 * 60_000) }), { code: 'EXECUTOR_IDENTITY_EXPIRED' });
  await reset(); await writeFile(join(directory, 'executor-corrupt-sibling.json'), '{');
  await assert.rejects(resolveForwardingExecutor(data, cwd, 'bounded-child'), { code: 'EXECUTOR_IDENTITY_INVALID' });
  await cleanupSession(data, cwd, 'ended-unrelated-parent');
  assert.equal((await resolveForwardingExecutor(data, cwd, 'bounded-child')).agentId, 'bounded-child', 'SessionEnd cleanup must remove corrupt executor state without deleting a valid sibling session');
  const executorName = (await readdir(directory)).find((candidate) => candidate.startsWith('executor-') && candidate.endsWith('.json'));
  await writeFile(join(directory, executorName), `{"kind":"subagent-executor","pad":"${'x'.repeat(17 * 1024)}"}`);
  const boundedStop = await runHook('subagent-hook.mjs', { ...start, hook_event_name: 'SubagentStop', agent_transcript_path: null, stop_hook_active: false, last_assistant_message: null }, env);
  assert.notEqual(boundedStop.code, 0, 'SubagentStop must reject an oversized exact executor record through the bounded reader');
  await cleanupSession(data, cwd, 'bounded-parent');
  await reset();
  const exactName = (await readdir(directory)).find((candidate) => candidate.startsWith('executor-') && candidate.endsWith('.json'));
  const inexact = JSON.parse(await readFile(join(directory, exactName), 'utf8')); inexact.extra = true; await writeFile(join(directory, exactName), JSON.stringify(inexact));
  const exactStop = await runHook('subagent-hook.mjs', { ...start, hook_event_name: 'SubagentStop', agent_transcript_path: null, stop_hook_active: false, last_assistant_message: null }, env);
  assert.notEqual(exactStop.code, 0, 'SubagentStop must fail closed on an inexact executor schema');
  await cleanupSession(data, cwd, 'bounded-parent');
  await reset();
  const siblingStart = { ...start, turn_id: 'future-sibling-turn', agent_id: 'future-sibling' };
  assert.equal((await runHook('subagent-hook.mjs', siblingStart, env)).code, 0);
  for (const candidate of await readdir(directory)) {
    if (!candidate.startsWith('executor-')) continue;
    const path = join(directory, candidate); const record = JSON.parse(await readFile(path, 'utf8'));
    if (record.agentId === 'future-sibling') { record.createdAt = new Date(Date.now() + 60_000).toISOString(); await writeFile(path, JSON.stringify(record)); }
  }
  await assert.rejects(resolveForwardingExecutor(data, cwd, 'bounded-child'), { code: 'EXECUTOR_IDENTITY_INVALID' });
  await reset(); await Promise.all(Array.from({ length: 1_024 }, (_, index) => writeFile(join(directory, `executor-unrelated-${index}.json`), '{}')));
  await assert.rejects(resolveForwardingExecutor(data, cwd, 'bounded-child'), { code: 'EXECUTOR_IDENTITY_AMBIGUOUS' });
});

test('expired stopped executor provenance is retained and available only through the durable bound path', async () => {
  const { cwd, data, env } = await workspace(); const identity = createIdentityStore({ dataRoot: data });
  await identity.beginCallerTurn({ sessionId: 'durable-parent', turnId: 'origin', workspace: cwd, permissionMode: 'workspace-write', prompt: '$zcode:rescue --fresh durable' });
  const input = { session_id: 'durable-parent', turn_id: 'child-turn', cwd, hook_event_name: 'SubagentStart', transcript_path: null, model: 'gpt', permission_mode: 'acceptEdits', agent_id: 'durable-child', agent_type: 'zcode-rescue' };
  assert.equal((await runHook('subagent-hook.mjs', input, env)).code, 0);
  assert.equal((await runHook('subagent-hook.mjs', { ...input, hook_event_name: 'SubagentStop', agent_transcript_path: null, stop_hook_active: false, last_assistant_message: null }, env)).code, 0);
  const original = await resolveForwardingExecutor(data, cwd, 'durable-child', { continuation: true });
  const expiredAt = new Date(Date.parse(original.createdAt) + 31 * 60_000);
  await assert.rejects(resolveForwardingExecutor(data, cwd, 'durable-child', { continuation: true, now: expiredAt }), { code: 'EXECUTOR_IDENTITY_EXPIRED' });
  const retained = await resolveForwardingExecutor(data, cwd, 'durable-child', { continuation: true, durableProvenance: true, now: expiredAt });
  assert.equal(retained.agentId, 'durable-child'); assert.equal(retained.active, false); assert.equal(retained.parentTurnId, 'origin');
  await assert.rejects(resolveForwardingExecutor(data, cwd, 'durable-child', { continuation: true, now: expiredAt }), { code: 'EXECUTOR_IDENTITY_EXPIRED' }, 'ordinary expiry must not delete retained provenance');
});

test('SessionEnd removes only its session contexts and leaves sibling jobs/session ownership', async () => {
  const { cwd, data, env } = await workspace();
  for (const session_id of ['a', 'b']) {
    await runHook('session-lifecycle-hook.mjs', { session_id, cwd, hook_event_name: 'SessionStart', transcript_path: null, model: 'gpt', permission_mode: 'default', source: 'startup' }, env);
    await runHook('user-prompt-hook.mjs', { session_id, turn_id: `turn-${session_id}`, cwd, hook_event_name: 'UserPromptSubmit', transcript_path: null, model: 'gpt', permission_mode: 'default', prompt: 'go' }, env);
  }
  const ended = await runHook('session-end-hook.mjs', { session_id: 'a', cwd, hook_event_name: 'SessionEnd', transcript_path: null, reason: 'other' }, env);
  assert.equal(ended.code, 0); assert.equal(ended.stdout, '');
  const records = await Promise.all((await jsonFiles(data)).map(async (path) => JSON.parse(await readFile(path, 'utf8'))));
  const endedRecords = records.filter((record) => record.sessionId === 'a');
  assert.equal(endedRecords.length, 1, 'ended v3 sessions retain only their revoking lifecycle tombstone');
  assert.equal(endedRecords[0].kind, 'identity-session'); assert.equal(typeof endedRecords[0].endedAt, 'string');
  assert.ok(records.some((record) => record.sessionId === 'b' && record.kind === 'active-turn'));
  const inventedModel = await runHook('session-end-hook.mjs', { session_id: 'b', cwd, hook_event_name: 'SessionEnd', transcript_path: null, model: 'gpt', reason: 'other' }, env); assert.notEqual(inventedModel.code, 0, 'SessionEnd must keep an exact native field contract');
});

test('SessionEnd preserves exact Rescue bindings while retaining their durable jobs', async () => {
  const { cwd, data, env } = await workspace(); const store = createStateStore({ dataRoot: data });
  await runHook('session-lifecycle-hook.mjs', { session_id: 'bound-parent', cwd, hook_event_name: 'SessionStart', transcript_path: null, model: 'gpt', permission_mode: 'default', source: 'startup' }, env);
  const executor = { agentId: 'bound-child', agentType: 'zcode-rescue', parentSessionId: 'bound-parent', parentTurnId: 'turn-a', parentPermissionMode: 'workspace-write', workspace: cwd };
  const reserved = await store.reserveFreshRescueJob({ workspace: cwd, reservation: { workspace: cwd, ownerSessionId: 'bound-parent', ownerTurnId: 'turn-a', command: 'rescue', readOnly: false, permissionSnapshot: { permissionMode: 'workspace-write' } }, executor });
  await store.finishJob(cwd, reserved.job.id, ['queued'], 'failed');
  const ended = await runHook('session-end-hook.mjs', { session_id: 'bound-parent', cwd, hook_event_name: 'SessionEnd', transcript_path: null, reason: 'other' }, env);
  assert.equal(ended.code, 0, ended.stderr || ended.stdout);
  const binding = await store.resolveRescueBinding({ workspace: cwd, parentSessionId: 'bound-parent', executorAgentId: 'bound-child', executorAgentType: 'zcode-rescue', permissionMode: 'workspace-write' });
  assert.equal(binding.kind, 'bound'); assert.equal(binding.binding.state, 'active');
  assert.equal((await store.readJob(cwd, reserved.job.id)).id, reserved.job.id);
});

test('SessionEnd releases only its broker owner sessions and lets the idle broker exit', async () => {
  const { cwd, data, env } = await workspace(); const record = join(data, 'zcode-calls.jsonl'); const socketMethods = join(data, 'hook-socket-methods.txt'); const fsErrors = join(data, 'hook-fs-errors.txt'); await writeFile(record, ''); await writeFile(socketMethods, ''); await writeFile(fsErrors, '');
  const launch = { command: process.execPath, args: [fakeZCode], target: fakeZCode }; const clients = [];
  for (const sessionId of ['a', 'b']) {
    await runHook('session-lifecycle-hook.mjs', { session_id: sessionId, cwd, hook_event_name: 'SessionStart', transcript_path: null, model: 'gpt', permission_mode: 'default', source: 'startup' }, env);
    const client = await createManagedZCodeClient({ dataRoot: data, workspace: cwd, launch, ownerId: ownerIdForSession(sessionId), env: { ...process.env, FAKE_ZCODE_RECORD: record } });
    clients.push(client); await client.createSession({ workspace: cwd, sessionId: `zcode-${sessionId}` });
  }
  for (const client of clients) await client.close();
  const storage = await resolveWorkspaceStorage({ dataRoot: data, workspace: cwd }); const identity = JSON.parse(await readFile(join(storage.directory, 'broker/identity.json'), 'utf8')); const ownershipPath = join(storage.directory, 'broker/session-owners.json'); const ownershipBefore = await stat(ownershipPath); const hookStartedAt = Date.now();
  const ended = await runHook('session-end-hook.mjs', { session_id: 'a', cwd, hook_event_name: 'SessionEnd', transcript_path: null, reason: 'other' }, { ...env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${socketMethodRecorder}`.trim(), ZCODE_TEST_SOCKET_METHOD_RECORD: socketMethods, ZCODE_TEST_FS_ERROR_RECORD: fsErrors }); const hookElapsedMs = Date.now() - hookStartedAt;
  assert.equal(ended.code, 0);
  const owners = JSON.parse(await readFile(ownershipPath, 'utf8'));
  let releaseDiagnostic = 'owner release succeeded without diagnostic collection';
  if (JSON.stringify(owners.sessions) !== JSON.stringify({ 'zcode-b': ownerIdForSession('b') })) {
    const callsAtFailure = (await readFile(record, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)); const ownershipAfter = await stat(ownershipPath); const healthyAfterFailure = await probeBrokerHealth(identity, 250); const childPidProbe = await probePidFromChild(identity.pid); let ownedJobsProbe; let markerBeforeRetry;
    try { markerBeforeRetry = { value: JSON.parse(await readFile(join(storage.directory, 'job-owners/index.json'), 'utf8')) }; } catch (error) { markerBeforeRetry = { errorCode: error?.code ?? null }; }
    try { ownedJobsProbe = { count: (await createStateStore({ dataRoot: data }).listOwnedJobs(cwd, 'a')).length }; } catch (error) { ownedJobsProbe = { error: { code: error?.code ?? null, category: error?.category ?? null, details: error?.details ?? null } }; }
    const hookSocketMethods = (await readFile(socketMethods, 'utf8')).trim().split('\n').filter(Boolean); const retrySocketMethodsPath = join(data, 'retry-socket-methods.txt'); await writeFile(retrySocketMethodsPath, '');
    const retry = await runHook(ownerReleaseProbe, { dataRoot: data, workspace: cwd, ownerSessionId: 'a', ownerId: ownerIdForSession('a') }, { ...env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${socketMethodRecorder}`.trim(), ZCODE_TEST_SOCKET_METHOD_RECORD: retrySocketMethodsPath }, { absolute: true });
    const expectedEndpoint = brokerEndpointFor({ dataRoot: data, workspace: storage.workspacePath }); const endpointDigest = (value) => createHash('sha256').update(value).digest('hex').slice(0, 12);
    releaseDiagnostic = `release-stage ${JSON.stringify({ hookElapsedMs, stopObserved: callsAtFailure.some((call) => call.method === 'session/stop' && call.params?.sessionId === 'zcode-a'), hookSocketMethods, hookFsErrors: (await readFile(fsErrors, 'utf8')).trim().split('\n').filter(Boolean), endpointMatch: identity.endpoint === expectedEndpoint, actualEndpointDigest: endpointDigest(identity.endpoint), expectedEndpointDigest: endpointDigest(expectedEndpoint), markerBeforeRetry, retrySocketMethods: (await readFile(retrySocketMethodsPath, 'utf8')).trim().split('\n').filter(Boolean), retry: retry.json ?? { code: retry.code, stderr: retry.stderr.trim() || null }, ownerStoreReplaced: ownershipAfter.ino !== ownershipBefore.ino || ownershipAfter.mtimeMs !== ownershipBefore.mtimeMs, healthyAfterFailure, childPidProbe, ownedJobsProbe, hookCode: ended.code, hookDiagnostic: ended.stderr.trim() || null })}`;
  }
  assert.deepEqual(owners.sessions, { 'zcode-b': ownerIdForSession('b') }, releaseDiagnostic);
  assert.deepEqual((await readFile(socketMethods, 'utf8')).trim().split('\n'), ['broker/auth', 'broker/health', 'broker/releaseOwner']);
  const calls = (await readFile(record, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.ok(calls.some((call) => call.method === 'session/stop' && call.params?.sessionId === 'zcode-a'));
  assert.ok(!calls.some((call) => call.method === 'session/stop' && call.params?.sessionId === 'zcode-b'));
  const deadline = Date.now() + 2_000; while (Date.now() < deadline && processAlive(identity.pid)) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(processAlive(identity.pid), false, 'released idle broker must exit promptly');
});

test('SessionEnd settles its writable job before generic owner release and preserves siblings', async () => {
  const { cwd, data, env } = await workspace(); const record = join(data, 'settlement-order.jsonl'); const control = join(data, 'recovery-control.json');
  await writeFile(record, ''); await writeFile(control, JSON.stringify({ mode: 'active' }));
  const { store, job } = await acceptedWritableJob({ data, cwd, ownerSessionId: 'settled-owner', remoteSessionId: 'settled-remote', peerEnv: { FAKE_ZCODE_RECORD: record, FAKE_ZCODE_RECOVERY_CONTROL: control } });
  let sibling = await store.reserveJob({ workspace: cwd, ownerSessionId: 'sibling-owner', ownerTurnId: 'sibling-turn', command: 'review', readOnly: true, permissionSnapshot: { permissionMode: 'default' } });
  sibling = await store.transitionJob(cwd, sibling.id, ['queued'], 'running', { startedAt: new Date().toISOString(), zcodeSessionId: 'sibling-remote' });
  const ended = await runHook('session-end-hook.mjs', { session_id: 'settled-owner', cwd, hook_event_name: 'SessionEnd', transcript_path: null, reason: 'other' }, env);
  assert.equal(ended.code, 0, ended.stderr); assert.equal((await store.readJob(cwd, job.id)).status, 'cancelled'); assert.equal((await store.readJob(cwd, sibling.id)).status, 'running');
  const calls = (await readFile(record, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); const readIndex = calls.findIndex((call) => call.method === 'session/read' && call.params?.sessionId === 'settled-remote'); const stopIndex = calls.findIndex((call) => call.method === 'session/stop' && call.params?.sessionId === 'settled-remote');
  assert.ok(readIndex >= 0 && stopIndex > readIndex, 'durable read/stop settlement must precede generic release cleanup'); assert.ok(!calls.some((call) => call.params?.sessionId === 'sibling-remote'));
});

test('SessionEnd never starts a broker when exact existing settlement is unavailable', async () => {
  const { cwd, data, env } = await workspace(); const record = join(data, 'no-spawn.jsonl'); const store = createStateStore({ dataRoot: data });
  let value = await store.reserveJob({ workspace: cwd, ownerSessionId: 'absent-owner', ownerTurnId: 'absent-turn', command: 'rescue', readOnly: false, permissionSnapshot: { permissionMode: 'workspace-write' } });
  value = await store.claimJobWorker(cwd, value.id, { childPid: 999_999, workerLeaseId: 'a'.repeat(64) });
  value = await store.transitionJob(cwd, value.id, ['queued'], 'running', { startedAt: new Date().toISOString(), zcodeSessionId: 'absent-remote' });
  value = await store.transitionJob(cwd, value.id, ['running'], 'running', { inputId: 'accepted-input', startRevision: 1, beforeMessageIds: [] });
  const identity = createIdentityStore({ dataRoot: data }); await identity.createCallerContext({ sessionId: 'absent-owner', turnId: 'turn', workspace: cwd, permissionMode: 'default' });
  const ended = await runHook('session-end-hook.mjs', { session_id: 'absent-owner', cwd, hook_event_name: 'SessionEnd', transcript_path: null, reason: 'other' }, { ...env, ZCODE_PATH: fakeZCode, FAKE_ZCODE_RECORD: record });
  assert.equal(ended.code, 0, ended.stderr); const archived = await store.readJob(cwd, value.id); assert.equal(archived.status, 'failed'); assert.equal(archived.error.message, 'SessionEnd found no healthy existing ZCode broker identity; the orphan was archived.'); await assert.rejects(readFile(record, 'utf8'), { code: 'ENOENT' }); await assert.rejects(identity.resolveActiveTurn({ sessionId: 'absent-owner', workspace: cwd }), { code: 'ACTIVE_TURN_NOT_FOUND' });
  const hookSource = await readFile(join(root, 'hooks/session-end-hook.mjs'), 'utf8'); assert.match(hookSource, /createExistingManagedZCodeClient/); assert.doesNotMatch(hookSource, /maxFrameBytes|maxOutboundBytes|drainTimeoutMs/, 'writable Rescue is pinned to the default managed broker profile');
});

test('SessionEnd archives a job when a reachable broker has no existing protocol and never lazily spawns ZCode', async () => {
  const { cwd, data, env } = await workspace(); const record = join(data, 'historical-release.jsonl'); await writeFile(record, ''); const store = createStateStore({ dataRoot: data }); const ownerSessionId = 'historical-job-owner'; const ownerId = ownerIdForSession(ownerSessionId);
  let value = await store.reserveJob({ workspace: cwd, ownerSessionId, ownerTurnId: 'historical-turn', command: 'rescue', readOnly: false, permissionSnapshot: { permissionMode: 'workspace-write' } }); value = await store.claimJobWorker(cwd, value.id, { childPid: 999_999, workerLeaseId: 'b'.repeat(64) }); value = await store.transitionJob(cwd, value.id, ['queued'], 'running', { startedAt: new Date().toISOString(), zcodeSessionId: 'historical-job-remote' }); value = await store.transitionJob(cwd, value.id, ['running'], 'running', { inputId: 'accepted-input', startRevision: 7, beforeMessageIds: [] });
  await reconcileBrokerOwnership({ dataRoot: data, workspace: cwd, ownerId, ownedSessionIds: [value.zcodeSessionId] }); await ensureZCodeBroker({ dataRoot: data, workspace: cwd, launch: { command: process.execPath, args: [fakeZCode], target: fakeZCode }, env: { ...process.env, FAKE_ZCODE_RECORD: record } });
  const ended = await runHook('session-end-hook.mjs', { session_id: ownerSessionId, cwd, hook_event_name: 'SessionEnd', transcript_path: null, reason: 'other' }, env); assert.equal(ended.code, 0, ended.stderr); const archived = await store.readJob(cwd, value.id); assert.equal(archived.status, 'failed'); assert.equal(archived.error.message, 'The reachable ZCode broker reported no existing ZCode Protocol; the orphan was archived.'); assert.equal(await readFile(record, 'utf8'), '');
});

test('SessionEnd remains bounded when existing stop acknowledgement is unavailable', async () => {
  const { cwd, data, env } = await workspace(); const record = join(data, 'bounded-settlement.jsonl'); const control = join(data, 'bounded-control.json'); await writeFile(record, ''); await writeFile(control, JSON.stringify({ mode: 'active' }));
  const { store, job } = await acceptedWritableJob({ data, cwd, ownerSessionId: 'bounded-owner', remoteSessionId: 'bounded-remote', peerEnv: { FAKE_ZCODE_RECORD: record, FAKE_ZCODE_RECOVERY_CONTROL: control, FAKE_ZCODE_SUPPRESS_METHOD: 'session/stop' } });
  const started = Date.now(); const ended = await runHook('session-end-hook.mjs', { session_id: 'bounded-owner', cwd, hook_event_name: 'SessionEnd', transcript_path: null, reason: 'other' }, env);
  assert.equal(ended.code, 0, ended.stderr); assert.ok(Date.now() - started < 2_500); assert.ok(['running', 'cancelling'].includes((await store.readJob(cwd, job.id)).status));
});

test('a failed SessionEnd stop is later settled by reservation scavenging before owner B is admitted', async (t) => {
  const { cwd, data, env } = await workspace(); const record = join(data, 'fallback.jsonl'); const control = join(data, 'fallback-control.json'); await writeFile(record, ''); await writeFile(control, JSON.stringify({ mode: 'active' }));
  const { store, job } = await acceptedWritableJob({ data, cwd, ownerSessionId: 'fallback-owner-a', remoteSessionId: 'fallback-remote', peerEnv: { FAKE_ZCODE_RECORD: record, FAKE_ZCODE_RECOVERY_CONTROL: control, FAKE_ZCODE_STOP_ERROR_PREFIX: 'fallback-remote' } });
  const storage = await resolveWorkspaceStorage({ dataRoot: data, workspace: cwd }); const brokerIdentity = JSON.parse(await readFile(join(storage.directory, 'broker/identity.json'), 'utf8')); t.after(() => { try { process.kill(brokerIdentity.pid, 'SIGTERM'); } catch { /* exited */ } });
  const ended = await runHook('session-end-hook.mjs', { session_id: 'fallback-owner-a', cwd, hook_event_name: 'SessionEnd', transcript_path: null, reason: 'other' }, env); assert.equal(ended.code, 0, ended.stderr); assert.ok(['running', 'cancelling'].includes((await store.readJob(cwd, job.id)).status));
  await writeFile(control, JSON.stringify({ mode: 'completed' }));
  const admitted = await runCompanion(['rescue', '--background', '--fresh', 'owner B continues'], { cwd, env: { ...process.env, PLUGIN_DATA: data, ZCODE_DATA_ROOT: data, ZCODE_PATH: fakeZCode }, caller: { sessionId: 'fallback-owner-b', turnId: 'fallback-turn-b', permissionMode: 'workspace-write' }, autoLaunchBackground: false });
  assert.equal(admitted.type, 'background'); assert.equal(admitted.job.ownerSessionId, 'fallback-owner-b'); assert.ok(['succeeded', 'failed'].includes((await store.readJob(cwd, job.id)).status), 'reservation scavenging must safely terminalize the released orphan before admission');
});

test('SessionEnd drains deferred owner batches without touching siblings or looping on failures', async () => {
  const { cwd, data, env } = await workspace(); const record = join(data, 'zcode-calls.jsonl'); await writeFile(record, ''); const owner = ownerIdForSession('many'); const sibling = ownerIdForSession('sibling');
  await reconcileBrokerOwnership({ dataRoot: data, workspace: cwd, ownerId: owner, ownedSessionIds: Array.from({ length: 17 }, (_, index) => `historical-${String(index).padStart(2, '0')}`) }); await reconcileBrokerOwnership({ dataRoot: data, workspace: cwd, ownerId: sibling, ownedSessionIds: ['sibling-session'] });
  const client = await createManagedZCodeClient({ dataRoot: data, workspace: cwd, launch: { command: process.execPath, args: [fakeZCode], target: fakeZCode }, ownerId: owner, env: { ...process.env, FAKE_ZCODE_RECORD: record } }); await client.createSession({ workspace: cwd, sessionId: 'new-active-session' }); await client.close();
  const started = Date.now(); const ended = await runHook('session-end-hook.mjs', { session_id: 'many', cwd, hook_event_name: 'SessionEnd', transcript_path: null, reason: 'other' }, env); assert.equal(ended.code, 0, ended.stderr); assert.ok(Date.now() - started < 2_500, 'repeated release must remain inside the native hook budget');
  const storage = await resolveWorkspaceStorage({ dataRoot: data, workspace: cwd }); const owners = JSON.parse(await readFile(join(storage.directory, 'broker/session-owners.json'), 'utf8')).sessions; assert.deepEqual(owners, { 'sibling-session': sibling });
  const calls = (await readFile(record, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); assert.ok(calls.some((call) => call.method === 'session/stop' && call.params?.sessionId === 'new-active-session'), 'a newer active session beyond the first 16 mappings must be stopped'); assert.ok(!calls.some((call) => call.method === 'session/stop' && call.params?.sessionId === 'sibling-session'));
});

test('SessionEnd advances beyond a failed 16-mapping prefix to clean a later active session', async () => {
  const { cwd, data, env } = await workspace(); const record = join(data, 'zcode-calls.jsonl'); await writeFile(record, ''); const owner = ownerIdForSession('failed-prefix'); const sibling = ownerIdForSession('failed-sibling');
  await reconcileBrokerOwnership({ dataRoot: data, workspace: cwd, ownerId: owner, ownedSessionIds: Array.from({ length: 17 }, (_, index) => `failed-history-${String(index).padStart(2, '0')}`) }); await reconcileBrokerOwnership({ dataRoot: data, workspace: cwd, ownerId: sibling, ownedSessionIds: ['failed-sibling-session'] });
  const client = await createManagedZCodeClient({ dataRoot: data, workspace: cwd, launch: { command: process.execPath, args: [fakeZCode], target: fakeZCode }, ownerId: owner, env: { ...process.env, FAKE_ZCODE_RECORD: record, FAKE_ZCODE_STOP_ERROR_PREFIX: 'failed-history-' } }); await client.createSession({ workspace: cwd, sessionId: 'later-active-session' }); await client.close();
  const started = Date.now(); const ended = await runHook('session-end-hook.mjs', { session_id: 'failed-prefix', cwd, hook_event_name: 'SessionEnd', transcript_path: null, reason: 'other' }, env); assert.equal(ended.code, 0, ended.stderr); assert.ok(Date.now() - started < 2_500);
  const storage = await resolveWorkspaceStorage({ dataRoot: data, workspace: cwd }); const owners = JSON.parse(await readFile(join(storage.directory, 'broker/session-owners.json'), 'utf8')).sessions; assert.equal(owners['later-active-session'], undefined); assert.equal(owners['failed-sibling-session'], sibling); assert.equal(Object.keys(owners).filter((sessionId) => sessionId.startsWith('failed-history-')).length, 17, 'failed mappings must remain owned for a later cleanup');
  const stops = (await readFile(record, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse).filter((call) => call.method === 'session/stop').map((call) => call.params.sessionId); assert.equal(stops.filter((sessionId) => sessionId.startsWith('failed-history-')).length, 17, 'failed mappings must be tried at most once in this cleanup'); assert.ok(stops.includes('later-active-session')); assert.ok(!stops.includes('failed-sibling-session'));
});

test('HEAD cleanup interoperates with the hermetic v1 broker while a sibling remains active', async (t) => {
  const { cwd, data } = await workspace(); const record = join(data, 'legacy-zcode-calls.jsonl'); await writeFile(record, '');
  const owner = ownerIdForSession('legacy-prefix'); const sibling = ownerIdForSession('legacy-sibling'); const probeOwner = ownerIdForSession('legacy-probe'); const histories = Array.from({ length: 17 }, (_, index) => `legacy-history-${String(index).padStart(2, '0')}`); await reconcileBrokerOwnership({ dataRoot: data, workspace: cwd, ownerId: owner, ownedSessionIds: histories }); await reconcileBrokerOwnership({ dataRoot: data, workspace: cwd, ownerId: sibling, ownedSessionIds: ['legacy-sibling-session'] }); await reconcileBrokerOwnership({ dataRoot: data, workspace: cwd, ownerId: probeOwner, ownedSessionIds: ['legacy-exclusion-probe'] });
  const storage = await resolveWorkspaceStorage({ dataRoot: data, workspace: cwd }); const brokerDirectory = join(storage.directory, 'broker'); const identityPath = join(brokerDirectory, 'identity.json'); const ownershipPath = join(brokerDirectory, 'session-owners.json'); const configPath = join(brokerDirectory, 'legacy-config.json'); const endpoint = brokerEndpointFor({ dataRoot: data, workspace: storage.workspacePath }); const instanceId = 'b'.repeat(48); const brokerToken = 'c'.repeat(64);
  await writeFile(configPath, JSON.stringify({ endpoint, instanceId, brokerToken, launch: { command: process.execPath, args: [fakeZCode], target: fakeZCode }, workspace: storage.workspacePath, ownershipPath, identityPath }));
  const legacy = spawn(process.execPath, [legacyBroker, configPath], { cwd, env: { ...process.env, FAKE_ZCODE_RECORD: record, FAKE_ZCODE_STOP_ERROR_PREFIX: 'legacy-history-' }, stdio: ['ignore', 'ignore', 'pipe'] }); let legacyStderr = ''; let legacyExited = false; legacy.stderr.on('data', (chunk) => { legacyStderr += chunk; }); legacy.once('exit', () => { legacyExited = true; }); await writeBrokerIdentity(identityPath, { endpoint, pid: legacy.pid, instanceId, brokerToken });
  t.after(async () => { if (!legacyExited) { try { process.kill(legacy.pid, 'SIGTERM'); } catch { /* already exited */ } } });
  const identity = { endpoint, pid: legacy.pid, instanceId, brokerToken }; const readyDeadline = Date.now() + 5_000; while (Date.now() < readyDeadline && !await probeBrokerHealth(identity)) await new Promise((resolve) => setTimeout(resolve, 25)); assert.equal(await probeBrokerHealth(identity), true, legacyStderr);
  const client = await createZCodeClient({ workspace: cwd, brokerEndpoint: endpoint, brokerToken, ownerId: owner, requestTimeoutMs: brokerTestRequestTimeoutMs }); assert.deepEqual(await client.brokerCapabilities(), { releaseOwnerExclusions: false }); await client.createSession({ workspace: cwd, sessionId: 'legacy-later-active' }); await client.close(); const siblingClient = await createZCodeClient({ workspace: cwd, brokerEndpoint: endpoint, brokerToken, ownerId: sibling, requestTimeoutMs: brokerTestRequestTimeoutMs }); await siblingClient.createSession({ workspace: cwd, sessionId: 'legacy-sibling-active' }); t.after(() => siblingClient.close()); const probe = await createZCodeClient({ workspace: cwd, brokerEndpoint: endpoint, brokerToken, ownerId: probeOwner, requestTimeoutMs: brokerTestRequestTimeoutMs }); assert.deepEqual((await probe.releaseOwner(['legacy-exclusion-probe'])).releasedSessionIds, ['legacy-exclusion-probe'], 'v1 broker must faithfully ignore the future exclusion field'); await probe.close();
  const result = await releaseManagedZCodeOwner({ dataRoot: data, workspace: cwd, ownerId: owner, requestTimeoutMs: brokerTestRequestTimeoutMs }); assert.equal(processAlive(legacy.pid), true, 'active sibling must keep the shared legacy broker alive'); let owners = JSON.parse(await readFile(ownershipPath, 'utf8')).sessions; assert.equal(owners['legacy-later-active'], undefined); assert.equal(owners['legacy-sibling-active'], sibling); assert.equal(owners['legacy-sibling-session'], sibling); assert.equal(histories.filter((sessionId) => owners[sessionId] === owner).length, 17); assert.ok(result.failedSessionIds.length <= 17); assert.ok(result.deferredSessionCount <= 17); assert.ok((await siblingClient.listSessions()).sessions.some((session) => session.sessionId === 'legacy-sibling-active'));
  const reuseOwner = ownerIdForSession('legacy-reuse'); const reuse = await createZCodeClient({ workspace: cwd, brokerEndpoint: endpoint, brokerToken, ownerId: reuseOwner, requestTimeoutMs: brokerTestRequestTimeoutMs }); await reuse.createSession({ workspace: cwd, sessionId: 'legacy-later-active' }); await reuse.close(); owners = JSON.parse(await readFile(ownershipPath, 'utf8')).sessions; assert.equal(owners['legacy-later-active'], reuseOwner);
  const stops = (await readFile(record, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse).filter((call) => call.method === 'session/stop').map((call) => call.params.sessionId); assert.ok(stops.includes('legacy-later-active')); assert.ok(!stops.includes('legacy-sibling-active')); assert.ok(stops.filter((sessionId) => sessionId.startsWith('legacy-history-')).length <= 32, 'legacy failed prefix retries must stay bounded');
});

test('legacy fallback stays inside the hook budget when the owner store lock is contended cross-process', async (t) => {
  const { cwd, data } = await workspace(); const record = join(data, 'contended-zcode-calls.jsonl'); await writeFile(record, ''); const owner = ownerIdForSession('contended-owner'); const sibling = ownerIdForSession('contended-sibling'); const histories = Array.from({ length: 17 }, (_, index) => `contended-history-${String(index).padStart(2, '0')}`); await reconcileBrokerOwnership({ dataRoot: data, workspace: cwd, ownerId: owner, ownedSessionIds: histories });
  const storage = await resolveWorkspaceStorage({ dataRoot: data, workspace: cwd }); const brokerDirectory = join(storage.directory, 'broker'); const identityPath = join(brokerDirectory, 'identity.json'); const ownershipPath = join(brokerDirectory, 'session-owners.json'); const configPath = join(brokerDirectory, 'contended-config.json'); const endpoint = brokerEndpointFor({ dataRoot: data, workspace: storage.workspacePath }); const instanceId = 'd'.repeat(48); const brokerToken = 'e'.repeat(64); await writeFile(configPath, JSON.stringify({ endpoint, instanceId, brokerToken, launch: { command: process.execPath, args: [fakeZCode], target: fakeZCode }, workspace: storage.workspacePath, ownershipPath, identityPath }));
  const legacy = spawn(process.execPath, [legacyBroker, configPath], { cwd, env: { ...process.env, FAKE_ZCODE_RECORD: record, FAKE_ZCODE_STOP_ERROR_PREFIX: 'contended-history-' }, stdio: ['ignore', 'ignore', 'pipe'] }); let legacyExited = false; legacy.once('exit', () => { legacyExited = true; }); await writeBrokerIdentity(identityPath, { endpoint, pid: legacy.pid, instanceId, brokerToken }); t.after(() => { if (!legacyExited) { try { process.kill(legacy.pid, 'SIGTERM'); } catch { /* exited */ } } }); const identity = { endpoint, pid: legacy.pid, instanceId, brokerToken }; const readyDeadline = Date.now() + 5_000; while (Date.now() < readyDeadline && !await probeBrokerHealth(identity)) await new Promise((resolve) => setTimeout(resolve, 25)); assert.equal(await probeBrokerHealth(identity), true);
  const target = await createZCodeClient({ workspace: cwd, brokerEndpoint: endpoint, brokerToken, ownerId: owner, requestTimeoutMs: brokerTestRequestTimeoutMs }); await target.createSession({ workspace: cwd, sessionId: 'contended-target-active' }); await target.close(); const siblingClient = await createZCodeClient({ workspace: cwd, brokerEndpoint: endpoint, brokerToken, ownerId: sibling, requestTimeoutMs: brokerTestRequestTimeoutMs }); await siblingClient.createSession({ workspace: cwd, sessionId: 'contended-sibling-active' }); t.after(() => siblingClient.close());
  const beforeContention = JSON.parse(await readFile(ownershipPath, 'utf8')).sessions; assert.equal(beforeContention['contended-target-active'], owner); assert.equal(beforeContention['contended-sibling-active'], sibling);
  const holder = spawn(process.execPath, [ownerStoreLockHolder, data, cwd, 'identity.json'], { stdio: ['pipe', 'pipe', 'pipe'] }); t.after(() => { try { process.kill(holder.pid, 'SIGTERM'); } catch { /* exited */ } }); const holderArmed = await new Promise((resolvePromise, reject) => { holder.stdout.once('data', (chunk) => resolvePromise(chunk.toString('utf8').trim())); holder.once('error', reject); holder.once('exit', (code) => reject(new Error(`lock holder exited ${code}`))); }); assert.equal(holderArmed, `armed:${ownershipPath}.lock`);
  const holderReadyPromise = new Promise((resolvePromise, reject) => { holder.stdout.once('data', (chunk) => resolvePromise(chunk.toString('utf8').trim())); holder.once('error', reject); holder.once('exit', (code) => reject(new Error(`lock holder exited ${code}`))); }); holder.stdin.write('acquire'); const holderReady = await holderReadyPromise; assert.equal(holderReady, `ready:${ownershipPath}.lock`); assert.equal(processAlive(holder.pid), true);
  const lockProbeSource = `import { withFileLock } from ${JSON.stringify(new URL('../scripts/lib/fs.mjs', import.meta.url).href)}; try { await withFileLock(process.argv[1], async () => {}, { timeoutMs: 0 }); process.stdout.write('acquired'); } catch (error) { process.stdout.write(error.code); }`; const probe = spawn(process.execPath, ['--input-type=module', '--eval', lockProbeSource, `${ownershipPath}.lock`], { stdio: ['ignore', 'pipe', 'pipe'] }); let probeOutput = ''; probe.stdout.on('data', (chunk) => { probeOutput += chunk; }); await new Promise((resolvePromise, reject) => { probe.once('error', reject); probe.once('exit', resolvePromise); }); assert.equal(probeOutput, 'LOCK_TIMEOUT');
  const started = Date.now(); const ended = await runHook('session-end-hook.mjs', { session_id: 'contended-owner', cwd, hook_event_name: 'SessionEnd', transcript_path: null, reason: 'other' }, { PLUGIN_DATA: data }); assert.equal(ended.code, 0, ended.stderr); assert.ok(Date.now() - started < 2_500, 'contended legacy cleanup must remain inside the SessionEnd budget'); const owners = JSON.parse(await readFile(ownershipPath, 'utf8')).sessions; assert.equal(owners['contended-target-active'], owner); assert.equal(owners['contended-sibling-active'], sibling); assert.equal(histories.filter((sessionId) => owners[sessionId] === owner).length, 17);
  holder.stdin.end('release'); await new Promise((resolvePromise) => holder.once('exit', resolvePromise)); const persisted = await readFile(ownershipPath, 'utf8'); assert.doesNotThrow(() => JSON.parse(persisted)); assert.ok((await siblingClient.listSessions()).sessions.some((session) => session.sessionId === 'contended-sibling-active'));
});

test('ownership prioritization honors a bounded timeout under a verified cross-process lock', async (t) => {
  const { cwd, data } = await workspace(); const owner = ownerIdForSession('bounded-prioritize'); await reconcileBrokerOwnership({ dataRoot: data, workspace: cwd, ownerId: owner, ownedSessionIds: ['bounded-prioritize-session'] }); const storage = await resolveWorkspaceStorage({ dataRoot: data, workspace: cwd }); const ownershipPath = join(storage.directory, 'broker/session-owners.json');
  const validOptions = { dataRoot: data, workspace: cwd, identityName: 'identity.json', ownerId: owner, sessionIds: ['bounded-prioritize-session'] }; for (const lockTimeoutMs of [undefined, -1, 1.5, 5_001, Number.MAX_SAFE_INTEGER + 1]) await assert.rejects(prioritizeBrokerOwnership({ ...validOptions, lockTimeoutMs }), { code: 'ZCODE_BROKER_INPUT_INVALID' });
  const holder = spawn(process.execPath, [ownerStoreLockHolder, data, cwd, 'identity.json'], { stdio: ['pipe', 'pipe', 'pipe'] }); t.after(() => { try { process.kill(holder.pid, 'SIGTERM'); } catch { /* exited */ } }); await new Promise((resolvePromise, reject) => { holder.stdout.once('data', resolvePromise); holder.once('error', reject); }); const holderReadyPromise = new Promise((resolvePromise, reject) => { holder.stdout.once('data', (chunk) => resolvePromise(chunk.toString('utf8').trim())); holder.once('error', reject); }); holder.stdin.write('acquire'); assert.equal(await holderReadyPromise, `ready:${ownershipPath}.lock`);
  const moduleUrl = new URL('../scripts/zcode-broker.mjs', import.meta.url).href; const source = `import { prioritizeBrokerOwnership } from ${JSON.stringify(moduleUrl)}; const started = Date.now(); try { await prioritizeBrokerOwnership(JSON.parse(process.argv[1])); process.stdout.write(JSON.stringify({ ok: true, elapsed: Date.now() - started })); } catch (error) { process.stdout.write(JSON.stringify({ ok: false, code: error.code, elapsed: Date.now() - started })); }`; const contender = spawn(process.execPath, ['--input-type=module', '--eval', source, JSON.stringify({ ...validOptions, lockTimeoutMs: 1_000 })], { stdio: ['ignore', 'pipe', 'pipe'] }); let output = ''; contender.stdout.on('data', (chunk) => { output += chunk; }); await new Promise((resolvePromise, reject) => { contender.once('error', reject); contender.once('exit', resolvePromise); }); const result = JSON.parse(output); assert.deepEqual({ ok: result.ok, code: result.code }, { ok: false, code: 'LOCK_TIMEOUT' }); assert.ok(result.elapsed < 2_000, `bounded lock attempt took ${result.elapsed}ms`);
  const owners = JSON.parse(await readFile(ownershipPath, 'utf8')).sessions; assert.equal(owners['bounded-prioritize-session'], owner); holder.stdin.end('release'); await new Promise((resolvePromise) => holder.once('exit', resolvePromise)); const persisted = await readFile(ownershipPath, 'utf8'); assert.doesNotThrow(() => JSON.parse(persisted));
});

test('owner release spans existing broker profiles and preserves mappings whose stop failed', async () => {
  const { cwd, data } = await workspace(); const record = join(data, 'zcode-calls.jsonl'); await writeFile(record, '');
  const launch = { command: process.execPath, args: [fakeZCode], target: fakeZCode }; const ownerA = ownerIdForSession('a'); const ownerB = ownerIdForSession('b');
  const profiles = [{}, { maxFrameBytes: 16 * 1024 * 1024, maxOutboundBytes: 16 * 1024 * 1024 }];
  for (const [index, profile] of profiles.entries()) {
    const first = await createManagedZCodeClient({ dataRoot: data, workspace: cwd, launch, ownerId: ownerA, env: { ...process.env, FAKE_ZCODE_RECORD: record, ...(index ? { FAKE_ZCODE_ERROR: 'session/stop' } : {}) }, ...profile });
    await first.createSession({ workspace: cwd, sessionId: `owner-a-${index}` }); await first.close();
    const sibling = await createManagedZCodeClient({ dataRoot: data, workspace: cwd, launch, ownerId: ownerB, env: { ...process.env, FAKE_ZCODE_RECORD: record, ...(index ? { FAKE_ZCODE_ERROR: 'session/stop' } : {}) }, ...profile });
    await sibling.createSession({ workspace: cwd, sessionId: `owner-b-${index}` }); await sibling.close();
  }
  const result = await releaseManagedZCodeOwner({ dataRoot: data, workspace: cwd, ownerId: ownerA, requestTimeoutMs: brokerTestRequestTimeoutMs });
  assert.deepEqual(result.releasedSessionIds, ['owner-a-0']); assert.deepEqual(result.failedSessionIds, ['owner-a-1']);
  const storage = await resolveWorkspaceStorage({ dataRoot: data, workspace: cwd }); const brokerFiles = await readdir(join(storage.directory, 'broker')); const stores = brokerFiles.filter((name) => /^session-owners(?:-[a-f0-9]{16})?\.json$/.test(name));
  const mappings = Object.assign({}, ...await Promise.all(stores.map(async (name) => {
    const value = JSON.parse(await readFile(join(storage.directory, 'broker', name), 'utf8')); return value.sessions;
  })));
  assert.deepEqual(mappings, { 'owner-b-0': ownerB, 'owner-a-1': ownerA, 'owner-b-1': ownerB });
  const calls = (await readFile(record, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.ok(calls.some((call) => call.method === 'session/stop' && call.params?.sessionId === 'owner-a-0'));
  assert.ok(calls.some((call) => call.method === 'session/stop' && call.params?.sessionId === 'owner-a-1'));
  assert.ok(!calls.some((call) => call.method === 'session/stop' && /^owner-b-/.test(call.params?.sessionId ?? '')));
});

test('hung owner stops are broker-bounded and retain every unconfirmed and sibling mapping', async () => {
  const { cwd, data } = await workspace(); const record = join(data, 'zcode-calls.jsonl'); await writeFile(record, ''); const ownerA = ownerIdForSession('hung-a'); const ownerB = ownerIdForSession('hung-b');
  const launch = { command: process.execPath, args: [fakeZCode], target: fakeZCode }; const peerEnv = { ...process.env, FAKE_ZCODE_RECORD: record, FAKE_ZCODE_SUPPRESS_METHOD: 'session/stop' };
  const first = await createManagedZCodeClient({ dataRoot: data, workspace: cwd, launch, ownerId: ownerA, env: peerEnv });
  for (let index = 0; index < 4; index += 1) await first.createSession({ workspace: cwd, sessionId: `hung-owner-${index}` }); await first.close();
  const sibling = await createManagedZCodeClient({ dataRoot: data, workspace: cwd, launch, ownerId: ownerB, env: peerEnv }); await sibling.createSession({ workspace: cwd, sessionId: 'hung-sibling' }); await sibling.close();
  const storage = await resolveWorkspaceStorage({ dataRoot: data, workspace: cwd }); const identity = JSON.parse(await readFile(join(storage.directory, 'broker/identity.json'), 'utf8')); const started = Date.now();
  const result = await releaseManagedZCodeOwner({ dataRoot: data, workspace: cwd, ownerId: ownerA, requestTimeoutMs: brokerTestRequestTimeoutMs });
  assert.ok(Date.now() - started < 2_000, 'broker owner cleanup must finish inside the SessionEnd budget'); assert.deepEqual(result.releasedSessionIds, []); assert.deepEqual(result.failedSessionIds.sort(), ['hung-owner-0', 'hung-owner-1', 'hung-owner-2', 'hung-owner-3']); assert.equal(result.deferredSessionCount, 0);
  const owners = JSON.parse(await readFile(join(storage.directory, 'broker/session-owners.json'), 'utf8')).sessions;
  assert.deepEqual(owners, { 'hung-owner-0': ownerA, 'hung-owner-1': ownerA, 'hung-owner-2': ownerA, 'hung-owner-3': ownerA, 'hung-sibling': ownerB });
  const calls = (await readFile(record, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)); assert.equal(calls.filter((call) => call.method === 'session/stop').length, 4); assert.ok(!calls.some((call) => call.method === 'session/stop' && call.params?.sessionId === 'hung-sibling'));
  const deadline = Date.now() + 2_000; while (Date.now() < deadline && processAlive(identity.pid)) await new Promise((resolve) => setTimeout(resolve, 25)); assert.equal(processAlive(identity.pid), false, 'bounded broker local task must permit fast idle exit');
});

test('owner release does not spawn ZCode when a live broker has only historical ownership', async () => {
  const { cwd, data } = await workspace(); const record = join(data, 'zcode-calls.jsonl'); await writeFile(record, ''); const ownerA = ownerIdForSession('historical-a'); const ownerB = ownerIdForSession('historical-b');
  await reconcileBrokerOwnership({ dataRoot: data, workspace: cwd, ownerId: ownerA, ownedSessionIds: ['historical-a-session'] }); await reconcileBrokerOwnership({ dataRoot: data, workspace: cwd, ownerId: ownerB, ownedSessionIds: ['historical-b-session'] });
  const identity = await ensureZCodeBroker({ dataRoot: data, workspace: cwd, launch: { command: process.execPath, args: [fakeZCode], target: fakeZCode }, env: { ...process.env, FAKE_ZCODE_RECORD: record } }); const started = Date.now();
  const result = await releaseManagedZCodeOwner({ dataRoot: data, workspace: cwd, ownerId: ownerA, requestTimeoutMs: brokerTestRequestTimeoutMs }); assert.ok(Date.now() - started < 2_000); assert.deepEqual(result, { releasedSessionIds: ['historical-a-session'], failedSessionIds: [], deferredSessionCount: 0 }); assert.equal(await readFile(record, 'utf8'), '', 'cleanup must not spawn the configured ZCode peer');
  const storage = await resolveWorkspaceStorage({ dataRoot: data, workspace: cwd }); assert.deepEqual(JSON.parse(await readFile(join(storage.directory, 'broker/session-owners.json'), 'utf8')).sessions, { 'historical-b-session': ownerB });
  const deadline = Date.now() + 2_000; while (Date.now() < deadline && processAlive(identity.pid)) await new Promise((resolve) => setTimeout(resolve, 25)); assert.equal(processAlive(identity.pid), false);
});

test('terminal completion context is routed durably once to its exact owner', async () => {
  const { cwd, data, env } = await workspace(); await runHook('session-lifecycle-hook.mjs', { session_id: 'owner', cwd, hook_event_name: 'SessionStart', transcript_path: null, model: 'gpt', permission_mode: 'default', source: 'startup' }, env);
  const store = createStateStore({ dataRoot: data }); const job = await store.reserveJob({ workspace: cwd, ownerSessionId: 'owner', ownerTurnId: 'old', command: 'review', readOnly: true, permissionSnapshot: { permissionMode: 'default' } }); await store.transitionJob(cwd, job.id, ['queued'], 'failed', { error: { message: 'done' }, finishedAt: new Date().toISOString(), exitCode: 1 });
  const input = { session_id: 'owner', turn_id: 'new-1', cwd, hook_event_name: 'UserPromptSubmit', transcript_path: null, model: 'gpt', permission_mode: 'default', prompt: 'next' };
  const first = await runHook('user-prompt-hook.mjs', input, env); const second = await runHook('user-prompt-hook.mjs', { ...input, turn_id: 'new-2' }, env);
  assert.match(first.json.hookSpecificOutput.additionalContext, new RegExp(job.id)); assert.doesNotMatch(second.json?.hookSpecificOutput?.additionalContext ?? '', new RegExp(job.id));
});

test('launcher descriptor and five terminal job notices stay below the declared hook context limit', async () => {
  const { cwd, data, env } = await workspace();
  await runHook('session-lifecycle-hook.mjs', { session_id: 'owner', cwd, hook_event_name: 'SessionStart', transcript_path: null, model: 'gpt', permission_mode: 'default', source: 'startup' }, env);
  const store = createStateStore({ dataRoot: data });
  const jobs = [];
  for (let index = 0; index < 5; index += 1) {
    const job = await store.reserveJob({ workspace: cwd, ownerSessionId: 'owner', ownerTurnId: `old-${index}`, command: 'review', readOnly: true, permissionSnapshot: { permissionMode: 'default' } });
    jobs.push(await store.transitionJob(cwd, job.id, ['queued'], 'cancelled', { finishedAt: new Date().toISOString(), exitCode: null }));
  }
  const result = await runHook('user-prompt-hook.mjs', { session_id: 'owner', turn_id: 'new', cwd, hook_event_name: 'UserPromptSubmit', transcript_path: null, model: 'gpt', permission_mode: 'default', prompt: 'next' }, env);
  const context = assertRescueLauncherContext(result);
  const limit = JSON.parse(await readFile(join(root, 'hooks/hooks.json'), 'utf8')).hooks.UserPromptSubmit[0].hooks[0].additionalContextLimit;
  assert.ok(Buffer.byteLength(context) <= limit);
  for (const job of jobs) assert.match(context, new RegExp(job.id));
});

test('unsafe owned launcher path emits a fixed error after authoritative prompt publication', async () => {
  const { cwd, data, env } = await workspace();
  await runHook('session-lifecycle-hook.mjs', { session_id: 'owner', cwd, hook_event_name: 'SessionStart', transcript_path: null, model: 'gpt', permission_mode: 'default', source: 'startup' }, env);
  const unsafeRoot = join(await mkdtemp(join(tmpdir(), 'zpc-unsafe-root-')), 'plugin $unsafe');
  await mkdir(unsafeRoot, { recursive: true });
  for (const directory of ['hooks', 'scripts', 'skills']) await cp(join(root, directory), join(unsafeRoot, directory), { recursive: true });
  const dependency = dirname(createRequire(import.meta.url).resolve('fs-native-extensions'));
  await mkdir(join(unsafeRoot, 'node_modules'), { recursive: true });
  await symlink(dependency, join(unsafeRoot, 'node_modules/fs-native-extensions'), 'dir');
  const result = await runHook(join(unsafeRoot, 'hooks/user-prompt-hook.mjs'), { session_id: 'owner', turn_id: 'must-not-mint', cwd, hook_event_name: 'UserPromptSubmit', transcript_path: null, model: 'gpt', permission_mode: 'default', prompt: 'private prompt' }, env, { absolute: true });
  assert.equal(result.code, 0, result.stderr);
  const context = result.json?.hookSpecificOutput?.additionalContext;
  assert.equal(context, '[zcode-rescue-launcher-error] {"version":1,"code":"RESCUE_LAUNCHER_PATH_UNSAFE","remedy":"Reinstall the ZCode plugin and retry from a new owned parent turn."}');
  assert.doesNotMatch(context, /launcherCommand|node |private prompt|must-not-mint/);
  const active = await createIdentityStore({ dataRoot: data }).resolveActiveTurn({ sessionId: 'owner', workspace: cwd });
  assert.equal(active.turnId, 'must-not-mint'); assert.equal(active.prompt, 'private prompt');
});

test('caller contexts end at the earlier turn boundary without crossing sibling sessions', async (t) => {
  await t.test('a new prompt revokes only older turns from the same session', async () => {
    const { cwd, data, env } = await workspace(); const identity = createIdentityStore({ dataRoot: data });
    for (const session_id of ['owner', 'sibling']) {
      const started = await runHook('session-lifecycle-hook.mjs', { session_id, cwd, hook_event_name: 'SessionStart', transcript_path: null, model: 'gpt', permission_mode: 'default', source: 'startup' }, env);
      assert.equal(started.code, 0, started.stderr);
    }
    for (const prompt of [
      { session_id: 'owner', turn_id: 't1', prompt: 'one' },
      { session_id: 'sibling', turn_id: 's1', prompt: 'sibling' },
      { session_id: 'owner', turn_id: 't2', prompt: 'two' },
    ]) {
      const submitted = await runHook('user-prompt-hook.mjs', { ...prompt, cwd, hook_event_name: 'UserPromptSubmit', transcript_path: null, model: 'gpt', permission_mode: 'default' }, env);
      assert.equal(submitted.code, 0, submitted.stderr);
    }
    assert.equal((await identity.resolveActiveTurn({ sessionId: 'owner', workspace: cwd })).turnId, 't2'); assert.equal((await identity.resolveActiveTurn({ sessionId: 'sibling', workspace: cwd })).turnId, 's1');
    await identity.endCallerTurn({ sessionId: 'owner', turnId: 't1', workspace: cwd }); assert.equal((await identity.resolveActiveTurn({ sessionId: 'owner', workspace: cwd })).turnId, 't2');
  });
  for (const mode of ['disabled', 'setup-not-ready', 'allow']) await t.test(`${mode} Stop ends the current caller turn`, async () => {
    const { cwd, data, env } = await workspace(); const identity = createIdentityStore({ dataRoot: data }); await runHook('session-lifecycle-hook.mjs', { session_id: 'owner', cwd, hook_event_name: 'SessionStart', transcript_path: null, model: 'gpt', permission_mode: 'default', source: 'startup' }, env);
    if (mode !== 'disabled') await writeGateConfig(data, cwd, { enabled: true, setupReady: mode === 'allow', ...(mode === 'setup-not-ready' ? { reason: 'unauthenticated' } : {}) });
    const promptInput = { session_id: 'owner', turn_id: 'turn', cwd, hook_event_name: 'UserPromptSubmit', transcript_path: null, model: 'gpt', permission_mode: 'default', prompt: 'edit' }; await runHook('user-prompt-hook.mjs', promptInput, env); await writeFile(join(cwd, 'tracked.txt'), `${mode}\n`);
    const stop = await runHook('stop-review-gate-hook.mjs', { ...stopFields(promptInput), hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'done' }, { ...env, ZCODE_PATH: fakeZCode, FAKE_ZCODE_GATE_RESULT: 'ALLOW: clean' }); assert.notEqual(stop.json?.decision, 'block'); await assert.rejects(identity.resolveActiveTurn({ sessionId: 'owner', workspace: cwd }), { code: 'ACTIVE_TURN_NOT_FOUND' });
  });
  await t.test('BLOCK keeps the caller turn reusable for continuation', async () => {
    const { cwd, data, env } = await workspace(); const identity = createIdentityStore({ dataRoot: data }); await writeGateConfig(data, cwd, { enabled: true, setupReady: true }); await runHook('session-lifecycle-hook.mjs', { session_id: 'owner', cwd, hook_event_name: 'SessionStart', transcript_path: null, model: 'gpt', permission_mode: 'default', source: 'startup' }, env);
    const promptInput = { session_id: 'owner', turn_id: 'turn', cwd, hook_event_name: 'UserPromptSubmit', transcript_path: null, model: 'gpt', permission_mode: 'default', prompt: 'edit' }; await runHook('user-prompt-hook.mjs', promptInput, env); await writeFile(join(cwd, 'tracked.txt'), 'blocked\n'); const stop = await runHook('stop-review-gate-hook.mjs', { ...stopFields(promptInput), hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'done' }, { ...env, ZCODE_PATH: fakeZCode, FAKE_ZCODE_GATE_RESULT: 'BLOCK: continue' }); assert.equal(stop.json.decision, 'block'); assert.equal((await identity.resolveActiveTurn({ sessionId: 'owner', workspace: cwd })).turnId, 'turn');
  });
  await t.test('a concurrent duplicate cannot revoke a turn while the real review blocks', async () => {
    const { cwd, data, env } = await workspace(); const identity = createIdentityStore({ dataRoot: data }); await writeGateConfig(data, cwd, { enabled: true, setupReady: true }); await runHook('session-lifecycle-hook.mjs', { session_id: 'owner', cwd, hook_event_name: 'SessionStart', transcript_path: null, model: 'gpt', permission_mode: 'default', source: 'startup' }, env);
    const promptInput = { session_id: 'owner', turn_id: 'turn', cwd, hook_event_name: 'UserPromptSubmit', transcript_path: null, model: 'gpt', permission_mode: 'default', prompt: 'edit' }; await runHook('user-prompt-hook.mjs', promptInput, env); await writeFile(join(cwd, 'tracked.txt'), 'blocked concurrent\n'); const stopInput = { ...stopFields(promptInput), hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'done' }; const results = await Promise.all([runHook('stop-review-gate-hook.mjs', stopInput, { ...env, ZCODE_PATH: fakeZCode, FAKE_ZCODE_GATE_RESULT: 'BLOCK: continue' }), runHook('stop-review-gate-hook.mjs', stopInput, { ...env, ZCODE_PATH: fakeZCode, FAKE_ZCODE_GATE_RESULT: 'BLOCK: continue' })]); assert.equal(results.filter((result) => result.json?.decision === 'block').length, 1); assert.equal((await identity.resolveActiveTurn({ sessionId: 'owner', workspace: cwd })).turnId, 'turn');
  });
});

test('Stop suppresses continuation, forwarding and external sessions before starting ZCode', async () => {
  const { cwd, data, env } = await workspace(); const record = join(data, 'zcode-calls.jsonl'); await writeFile(record, '');
  const externalPrompt = await runHook('user-prompt-hook.mjs', { session_id: 'external', turn_id: 'turn', cwd, hook_event_name: 'UserPromptSubmit', transcript_path: null, model: 'gpt', permission_mode: 'default', prompt: 'x' }, env); assert.deepEqual(externalPrompt.json, {});
  await runHook('session-lifecycle-hook.mjs', { session_id: 'parent', cwd, hook_event_name: 'SessionStart', transcript_path: null, model: 'gpt', permission_mode: 'default', source: 'startup' }, env); const prompt = { session_id: 'parent', turn_id: 'turn', cwd, hook_event_name: 'UserPromptSubmit', transcript_path: null, model: 'gpt', permission_mode: 'default', prompt: 'x' }; await runHook('user-prompt-hook.mjs', prompt, env); await writeFile(join(cwd, 'tracked.txt'), 'changed\n');
  const stop = { session_id: 'parent', turn_id: 'turn', cwd, hook_event_name: 'Stop', transcript_path: null, model: 'gpt', permission_mode: 'bypassPermissions', stop_hook_active: true, last_assistant_message: 'done' }; const continuation = await runHook('stop-review-gate-hook.mjs', stop, { ...env, ZCODE_PATH: fakeZCode, FAKE_ZCODE_RECORD: record }); assert.deepEqual(continuation.json, {});
  await runHook('subagent-hook.mjs', { session_id: 'parent', turn_id: 'turn', cwd, hook_event_name: 'SubagentStart', transcript_path: null, model: 'gpt', permission_mode: 'bypassPermissions', agent_id: 'agent', agent_type: 'zcode-rescue' }, env); const forwarding = await runHook('stop-review-gate-hook.mjs', { ...stop, stop_hook_active: false }, { ...env, ZCODE_PATH: fakeZCode, FAKE_ZCODE_RECORD: record }); assert.deepEqual(forwarding.json, {}); assert.equal(await readFile(record, 'utf8'), '');
});

test('prompt, Root Stop, and SessionEnd clean only their exact prepared Rescue lifecycle', async (t) => {
  await t.test('new proved prompt revokes authority before cleaning the replaced bound target preparation', async () => {
    const { cwd, data, env } = await workspace(); const identity = createIdentityStore({ dataRoot: data }); const prepared = createRescuePreparationStore({ dataRoot: data });
    const sessionId = 'bound-replacement-owner';
    await runHook('session-lifecycle-hook.mjs', { session_id: sessionId, cwd, hook_event_name: 'SessionStart', transcript_path: null, model: 'gpt', permission_mode: 'default', source: 'startup' }, env);
    const first = await runHook('user-prompt-hook.mjs', { session_id: sessionId, turn_id: 'old-bound-turn', cwd, hook_event_name: 'UserPromptSubmit', transcript_path: null, model: 'gpt', permission_mode: 'default', prompt: '$zcode:rescue old bound objective' }, env);
    assert.equal(first.code, 0, first.stderr);
    const target = await addLinkedWorktree(cwd, 'bound-replacement-target');
    const caller = await identity.resolveActiveTurn({ sessionId, workspace: target, workspaceBinding: 'claim' });
    await prepared.save({ ...caller, recordedPrompt: caller.prompt, envelope: { version: 1, source: 'explicit', task: 'old bound objective', options: {} } });
    const replacedGeneration = caller.generationId;

    const next = await runHook('user-prompt-hook.mjs', { session_id: sessionId, turn_id: 'new-root-turn', cwd, hook_event_name: 'UserPromptSubmit', transcript_path: null, model: 'gpt', permission_mode: 'default', prompt: 'new root objective' }, env);
    assert.equal(next.code, 0, next.stderr);
    const current = await identity.resolveActiveTurn({ sessionId, workspace: cwd, workspaceBinding: 'preview' });
    assert.notEqual(current.generationId, replacedGeneration); assert.equal(current.executionWorkspace, null);
    await assert.rejects(prepared.consume({ sessionId, turnId: 'old-bound-turn', workspace: target, permissionMode: 'default', executorAgentId: 'old-child' }), { code: 'RESCUE_PREPARATION_NOT_FOUND' });
  });

  await t.test('new top-level prompt removes only older turns in the same session and workspace', async () => {
    const { cwd, data, env } = await workspace(); const identity = createIdentityStore({ dataRoot: data }); const prepared = createRescuePreparationStore({ dataRoot: data });
    for (const sessionId of ['owner', 'sibling']) await runHook('session-lifecycle-hook.mjs', { session_id: sessionId, cwd, hook_event_name: 'SessionStart', transcript_path: null, model: 'gpt', permission_mode: 'default', source: 'startup' }, env);
    await identity.beginCallerTurn({ sessionId: 'owner', turnId: 'old-turn', workspace: cwd, permissionMode: 'default', prompt: 'old proactive objective' });
    await prepared.save({ sessionId: 'owner', turnId: 'old-turn', workspace: cwd, permissionMode: 'default', recordedPrompt: 'old proactive objective', envelope: { version: 1, source: 'proactive', task: 'old objective', options: {} } });
    await identity.beginCallerTurn({ sessionId: 'sibling', turnId: 'sibling-turn', workspace: cwd, permissionMode: 'default', prompt: 'sibling proactive objective' });
    await prepared.save({ sessionId: 'sibling', turnId: 'sibling-turn', workspace: cwd, permissionMode: 'default', recordedPrompt: 'sibling proactive objective', envelope: { version: 1, source: 'proactive', task: 'sibling objective', options: {} } });
    const submitted = await runHook('user-prompt-hook.mjs', { session_id: 'owner', turn_id: 'new-turn', cwd, hook_event_name: 'UserPromptSubmit', transcript_path: null, model: 'gpt', permission_mode: 'default', prompt: 'new prompt' }, env);
    assert.equal(submitted.code, 0, submitted.stderr);
    await assert.rejects(prepared.consume({ sessionId: 'owner', turnId: 'old-turn', workspace: cwd, permissionMode: 'default', executorAgentId: 'child' }), { code: 'RESCUE_PREPARATION_NOT_FOUND' });
    assert.equal((await prepared.consume({ sessionId: 'sibling', turnId: 'sibling-turn', workspace: cwd, permissionMode: 'default', executorAgentId: 'sibling-child' })).envelope.task, 'sibling objective');
  });

  await t.test('storage-level cleanup failure cannot undo a newly published active caller turn', async () => {
    const { cwd, data, env } = await workspace(); const identity = createIdentityStore({ dataRoot: data }); const storage = await resolveWorkspaceStorage({ dataRoot: data, workspace: cwd });
    await runHook('session-lifecycle-hook.mjs', { session_id: 'cleanup-failure-owner', cwd, hook_event_name: 'SessionStart', transcript_path: null, model: 'gpt', permission_mode: 'default', source: 'startup' }, env);
    await mkdir(join(storage.directory, 'invocations'), { recursive: true }); await writeFile(join(storage.directory, 'invocations', 'prepared'), 'unsafe non-directory');
    const submitted = await runHook('user-prompt-hook.mjs', { session_id: 'cleanup-failure-owner', turn_id: 'must-not-mint', cwd, hook_event_name: 'UserPromptSubmit', transcript_path: null, model: 'gpt', permission_mode: 'default', prompt: 'private prompt bytes' }, env);
    assertRescueLauncherContext(submitted); assert.equal(submitted.stderr, '');
    const active = await identity.resolveActiveTurn({ sessionId: 'cleanup-failure-owner', workspace: cwd });
    assert.equal(active.turnId, 'must-not-mint'); assert.equal(active.prompt, 'private prompt bytes');
  });

  await t.test('Root Stop deletes its exact preparation while a forwarding Stop preserves the parent preparation', async () => {
    const { cwd, data, env } = await workspace(); const prepared = createRescuePreparationStore({ dataRoot: data });
    await runHook('session-lifecycle-hook.mjs', { session_id: 'owner', cwd, hook_event_name: 'SessionStart', transcript_path: null, model: 'gpt', permission_mode: 'default', source: 'startup' }, env);
    const prompt = { session_id: 'owner', turn_id: 'root-turn', cwd, hook_event_name: 'UserPromptSubmit', transcript_path: null, model: 'gpt', permission_mode: 'default', prompt: 'root proactive objective' };
    await runHook('user-prompt-hook.mjs', prompt, env);
    await prepared.save({ sessionId: 'owner', turnId: 'root-turn', workspace: cwd, permissionMode: 'default', recordedPrompt: prompt.prompt, envelope: { version: 1, source: 'proactive', task: 'root objective', options: {} } });
    const stopped = await runHook('stop-review-gate-hook.mjs', { ...stopFields(prompt), hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'done' }, env);
    assert.equal(stopped.code, 0, stopped.stderr);
    await assert.rejects(prepared.consume({ sessionId: 'owner', turnId: 'root-turn', workspace: cwd, permissionMode: 'default', executorAgentId: 'child' }), { code: 'RESCUE_PREPARATION_NOT_FOUND' });

    const forwardingPrompt = { ...prompt, turn_id: 'forwarding-turn', prompt: 'forwarding proactive objective' }; await runHook('user-prompt-hook.mjs', forwardingPrompt, env);
    await createIdentityStore({ dataRoot: data }).resolveActiveTurn({ sessionId: 'owner', workspace: cwd, workspaceBinding: 'claim' });
    await prepared.save({ sessionId: 'owner', turnId: 'forwarding-turn', workspace: cwd, permissionMode: 'default', recordedPrompt: forwardingPrompt.prompt, envelope: { version: 1, source: 'proactive', task: 'forwarding objective', options: {} } });
    await runHook('subagent-hook.mjs', { session_id: 'owner', turn_id: 'forwarding-turn', cwd, hook_event_name: 'SubagentStart', transcript_path: null, model: 'gpt', permission_mode: 'default', agent_id: 'forward-child', agent_type: 'zcode-rescue' }, env);
    assert.deepEqual((await runHook('stop-review-gate-hook.mjs', { ...stopFields(forwardingPrompt), hook_event_name: 'Stop', stop_hook_active: true, last_assistant_message: 'done' }, env)).json, {});
    assert.equal((await prepared.consume({ sessionId: 'owner', turnId: 'forwarding-turn', workspace: cwd, permissionMode: 'default', executorAgentId: 'forward-child' })).envelope.task, 'forwarding objective');
  });

  await t.test('SessionEnd removes one session without touching its sibling', async () => {
    const { cwd, data, env } = await workspace(); const prepared = createRescuePreparationStore({ dataRoot: data }); const identity = createIdentityStore({ dataRoot: data });
    for (const sessionId of ['owner', 'sibling']) {
      await identity.beginCallerTurn({ sessionId, turnId: `${sessionId}-turn`, workspace: cwd, permissionMode: 'default', prompt: `${sessionId} prompt` });
      await prepared.save({ sessionId, turnId: `${sessionId}-turn`, workspace: cwd, permissionMode: 'default', recordedPrompt: `${sessionId} proactive objective`, envelope: { version: 1, source: 'proactive', task: `${sessionId} objective`, options: {} } });
    }
    const ended = await runHook('session-end-hook.mjs', { session_id: 'owner', cwd, hook_event_name: 'SessionEnd', transcript_path: null, reason: 'other' }, env);
    assert.equal(ended.code, 0, ended.stderr);
    await assert.rejects(identity.resolveActiveTurn({ sessionId: 'owner', workspace: cwd }), { code: 'ACTIVE_TURN_NOT_FOUND' });
    assert.equal((await identity.resolveActiveTurn({ sessionId: 'sibling', workspace: cwd })).turnId, 'sibling-turn');
    await assert.rejects(prepared.consume({ sessionId: 'owner', turnId: 'owner-turn', workspace: cwd, permissionMode: 'default', executorAgentId: 'child' }), { code: 'RESCUE_PREPARATION_NOT_FOUND' });
    assert.equal((await prepared.consume({ sessionId: 'sibling', turnId: 'sibling-turn', workspace: cwd, permissionMode: 'default', executorAgentId: 'sibling-child' })).envelope.task, 'sibling objective');
  });
});

test('Stop gate skips unchanged and atomically consumes exact changed baseline', async () => {
  const { cwd, data, env } = await workspace();
  await writeGateConfig(data, cwd, { enabled: true, setupReady: true });
  await runHook('session-lifecycle-hook.mjs', { session_id: 'parent', cwd, hook_event_name: 'SessionStart', transcript_path: null, model: 'gpt', permission_mode: 'default', source: 'startup' }, env);
  const prompt = { session_id: 'parent', turn_id: 'turn-1', cwd, hook_event_name: 'UserPromptSubmit', transcript_path: null, model: 'gpt', permission_mode: 'default', prompt: 'edit' };
  await runHook('user-prompt-hook.mjs', prompt, env);
  const unchanged = await runHook('stop-review-gate-hook.mjs', { session_id: 'parent', turn_id: 'turn-1', cwd, hook_event_name: 'Stop', transcript_path: null, model: 'gpt', permission_mode: 'default', stop_hook_active: false, last_assistant_message: 'done' }, env);
  assert.equal(unchanged.code, 0); assert.deepEqual(unchanged.json, {});
  await runHook('user-prompt-hook.mjs', { ...prompt, turn_id: 'turn-2' }, env);
  await writeFile(join(cwd, 'tracked.txt'), 'after\n');
  const wrong = await runHook('stop-review-gate-hook.mjs', { session_id: 'other', turn_id: 'turn-2', cwd, hook_event_name: 'Stop', transcript_path: null, model: 'gpt', permission_mode: 'default', stop_hook_active: false, last_assistant_message: 'done' }, env);
  assert.equal(wrong.code, 0); assert.deepEqual(wrong.json, {});
  const input = { session_id: 'parent', turn_id: 'turn-2', cwd, hook_event_name: 'Stop', transcript_path: null, model: 'gpt', permission_mode: 'default', stop_hook_active: false, last_assistant_message: 'done' };
  const [one, two] = await Promise.all([runHook('stop-review-gate-hook.mjs', input, { ...env, ZCODE_PATH: fakeZCode, FAKE_ZCODE_GATE_RESULT: 'ALLOW: clean' }), runHook('stop-review-gate-hook.mjs', input, { ...env, ZCODE_PATH: fakeZCode, FAKE_ZCODE_GATE_RESULT: 'ALLOW: clean' })]);
  assert.equal([one, two].filter((result) => result.json?.decision === 'block').length, 0);
  const snapshots = (await jsonFiles(join(data, 'workspaces'))).filter(isGateRunPath);
  assert.equal(snapshots.length, 1);
});

test('Stop gate suppresses continuation/nested runs, fails open when setup is not ready, and conservatively blocks bad reviews', async (t) => {
  for (const [name, fake, extra, expected] of [['allow', 'ALLOW: looks good', {}, {}], ['block', 'BLOCK: fix issue', {}, { decision: 'block', reason: 'fix issue' }], ['empty', '__EMPTY__', {}, { decision: 'block' }], ['malformed', 'maybe', {}, { decision: 'block' }], ['failure', 'unused', { FAKE_ZCODE_ERROR: 'session/send' }, { decision: 'block' }], ['read-failure', 'unused', { FAKE_ZCODE_ERROR: 'session/read' }, { decision: 'block' }], ['timeout', 'unused', { FAKE_ZCODE_SUPPRESS_FIRST_COMPLETION: '1' }, { decision: 'block' }]]) await t.test(name, async () => {
    const { cwd, data, env } = await workspace(); const record = join(data, 'zcode-calls.jsonl'); await writeFile(record, ''); await writeGateConfig(data, cwd, { enabled: true, setupReady: true });
    await runHook('session-lifecycle-hook.mjs', { session_id: 's', cwd, hook_event_name: 'SessionStart', transcript_path: null, model: 'gpt', permission_mode: 'default', source: 'startup' }, env);
    const base = { session_id: 's', turn_id: 't', cwd, hook_event_name: 'UserPromptSubmit', transcript_path: null, model: 'gpt', permission_mode: 'default', prompt: 'edit' };
    await runHook('user-prompt-hook.mjs', base, env); await writeFile(join(cwd, 'new.txt'), 'changed');
    const stop = stopFields(base);
    const script = name === 'timeout' ? join(root, 'tests/fixtures/stop-gate-with-timeout.mjs') : 'stop-review-gate-hook.mjs';
    const result = await runHook(script, { ...stop, hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'done' }, { ...env, ZCODE_PATH: fakeZCode, FAKE_ZCODE_RECORD: record, FAKE_ZCODE_GATE_RESULT: fake, ...extra }, { absolute: name === 'timeout' });
    const calls = ['failure', 'read-failure', 'timeout'].includes(name) ? (await readFile(record, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
    if (name === 'timeout') assert.ok(calls.some((call) => call.method === 'session/send'), 'timeout must reach the intended completion wait');
    assert.equal(result.code, 0); if (expected.decision) assert.equal(result.json.decision, expected.decision); else assert.deepEqual(result.json, expected);
    if (expected.reason) assert.equal(result.json.reason, expected.reason); if (result.json.reason) assert.ok(result.json.reason.length <= 1000);
    if (['failure', 'read-failure', 'timeout'].includes(name)) {
      assert.ok(calls.some((call) => call.method === 'session/stop'), `${name} must stop its created review session`);
    }
  });
  const { cwd, data, env } = await workspace(); await writeGateConfig(data, cwd, { enabled: true, setupReady: false, reason: 'untrusted' });
  await runHook('session-lifecycle-hook.mjs', { session_id: 's', cwd, hook_event_name: 'SessionStart', transcript_path: null, model: 'gpt', permission_mode: 'default', source: 'startup' }, env);
  const base = { session_id: 's', turn_id: 't', cwd, hook_event_name: 'UserPromptSubmit', transcript_path: null, model: 'gpt', permission_mode: 'default', prompt: 'edit' };
  await runHook('user-prompt-hook.mjs', base, env); await writeFile(join(cwd, 'new.txt'), 'changed');
  const stop = stopFields(base);
  const notReady = await runHook('stop-review-gate-hook.mjs', { ...stop, hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'done' }, env);
  assert.equal(notReady.code, 0); assert.notEqual(notReady.json.decision, 'block'); assert.match(notReady.json.systemMessage, /\$zcode:setup/);
});

test('Stop rechecks stale setup readiness before session creation and fails open', async (t) => {
  for (const scenario of [
    { name: 'missing', extra: { FAKE_GATE_DISCOVERY_ERROR: 'ZCODE_NOT_FOUND' }, fixture: true, reason: 'ZCODE_NOT_FOUND' },
    { name: 'outdated', extra: { FAKE_ZCODE_VERSION: '0.15.0' }, fixture: false, reason: 'ZCODE_VERSION_UNSUPPORTED' },
    { name: 'unauthenticated', extra: { FAKE_ZCODE_ERROR: 'session/create' }, fixture: false, reason: 'ZCODE_REQUEST_FAILED' },
  ]) await t.test(scenario.name, async () => {
    const { cwd, data, env } = await workspace(); const record = join(data, 'zcode-calls.jsonl'); await writeFile(record, ''); await writeGateConfig(data, cwd, { enabled: true, setupReady: true, status: 'ready' }); await runHook('session-lifecycle-hook.mjs', { session_id: 'owner', cwd, hook_event_name: 'SessionStart', transcript_path: null, model: 'gpt', permission_mode: 'default', source: 'startup' }, env);
    const prompt = { session_id: 'owner', turn_id: 'turn', cwd, hook_event_name: 'UserPromptSubmit', transcript_path: null, model: 'gpt', permission_mode: 'default', prompt: 'edit' }; await runHook('user-prompt-hook.mjs', prompt, env); await writeFile(join(cwd, 'tracked.txt'), `${scenario.name}\n`); const script = scenario.fixture ? join(root, 'tests/fixtures/stop-gate-with-timeout.mjs') : 'stop-review-gate-hook.mjs'; const result = await runHook(script, { ...stopFields(prompt), hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'done' }, { ...env, ZCODE_PATH: fakeZCode, FAKE_ZCODE_RECORD: record, ...scenario.extra }, { absolute: scenario.fixture });
    assert.equal(result.code, 0); assert.notEqual(result.json?.decision, 'block'); assert.match(result.json.systemMessage, /\$zcode:setup/); const runs = (await jsonFiles(join(data, 'workspaces'))).filter(isGateRunPath); assert.equal(runs.length, 1); const snapshot = JSON.parse(await readFile(runs[0], 'utf8')); assert.equal(snapshot.status, 'skipped_setup_not_ready'); assert.equal(snapshot.reason, scenario.reason);
    const calls = (await readFile(record, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); assert.ok(!calls.some((call) => call.method === 'session/send'));
  });
});
