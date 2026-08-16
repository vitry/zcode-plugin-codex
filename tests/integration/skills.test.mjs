// @ts-nocheck
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { createIdentityStore } from '../../scripts/lib/identity.mjs';
import { createInvocationStore } from '../../scripts/lib/invocation.mjs';
import { withWorkerLease } from '../../scripts/lib/recovery.mjs';
import { createStateStore } from '../../scripts/lib/state.mjs';
import { resolveWorkspaceStorage } from '../../scripts/lib/workspace.mjs';
import { runChild } from '../helpers/run-child.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const cli = join(root, 'scripts', 'zcode-companion.mjs');
const fakeZCode = join(root, 'tests/fixtures/fake-zcode-cli.mjs');
const fakeCodex = join(root, 'tests/fixtures/fake-codex-app-server.mjs');

async function cleanupFixture(directory) {
  const delays = process.platform === 'win32' ? [80, 100, 250, 500, 1_000] : [80];
  let lastError;
  for (const delay of delays) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, delay));
    try {
      await rm(directory, { force: true, recursive: true });
      return;
    } catch (error) {
      if (process.platform !== 'win32' || !['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(error?.code)) throw error;
      lastError = error;
    }
  }
  throw lastError;
}

async function waitUntil(predicate, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (await predicate()) return; await new Promise((resolvePromise) => setTimeout(resolvePromise, 20)); }
  assert.fail(message);
}

async function workerLeaseAvailable(ctx, job) {
  if (!job?.workerLeaseId) return false;
  try { await withWorkerLease({ dataRoot: ctx.dataRoot, workspace: ctx.workspace, jobId: job.id, workerLeaseId: job.workerLeaseId, timeoutMs: 0 }, async () => {}); return true; }
  catch (error) { if (error?.code === 'LOCK_TIMEOUT') return false; throw error; }
}

async function waitForExactJobCleanup(ctx, store, jobId, timeoutMs = process.platform === 'win32' ? 30_000 : 5_000, cancel) {
  let latest;
  const settled = async () => { latest = await store.readJob(ctx.workspace, jobId); return ['succeeded', 'failed', 'cancelled'].includes(latest.status) && (!latest.workerLeaseId || await workerLeaseAvailable(ctx, latest)); };
  try { await waitUntil(settled, timeoutMs, `exact background job ${jobId} did not become terminal and release its worker lease`); }
  catch (error) {
    if (cancel) { await cancel().catch(() => {}); try { await waitUntil(settled, timeoutMs, `exact background job ${jobId} did not settle after job-aware cancellation`); return latest; } catch { /* preserve the original bounded cleanup failure */ } }
    ctx.preserveEvidence = true; throw error;
  }
  return latest;
}

async function findNewJobs(store, workspace, baselineIds) {
  const jobs = await store.listJobs(workspace);
  return jobs.filter((job) => !baselineIds.has(job.id));
}

async function run(command, args, cwd) {
  const result = await runChild(command, args, { cwd });
  if (result.code !== 0) throw new Error(`${command} exited ${result.code}`);
}

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-skills-'));
  const workspace = await realpath(await mkdir(join(directory, 'workspace'), { recursive: true }).then(() => join(directory, 'workspace')));
  const dataRoot = join(directory, 'data');
  await writeFile(join(workspace, 'tracked.txt'), 'base\n');
  await run('git', ['init', '-q'], workspace);
  await run('git', ['add', 'tracked.txt'], workspace);
  await run('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'base'], workspace);
  await writeFile(join(workspace, 'tracked.txt'), 'changed\n');
  const identity = createIdentityStore({ dataRoot });
  const callerA = await identity.createCallerContext({ sessionId: 'codex-a', turnId: 'turn-a', workspace, permissionMode: 'workspace-write' });
  const callerB = await identity.createCallerContext({ sessionId: 'codex-b', turnId: 'turn-b', workspace, permissionMode: 'read-only' });
  const env = { ...process.env, PLUGIN_DATA: dataRoot, PLUGIN_ROOT: root, ZCODE_PATH: fakeZCode };
  const context = { directory, workspace, dataRoot, callerA, callerB, env, preserveEvidence: false };
  t.after(async () => { if (!context.preserveEvidence) await cleanupFixture(directory); else t.diagnostic(`preserved background cleanup evidence at ${directory}`); });
  return context;
}

async function startRescueChild(ctx, parentSessionId, childId, turnId = `${childId}-turn`, agentType = 'zcode-rescue') {
  const result = await runChild(process.execPath, [join(root, 'hooks', 'subagent-hook.mjs')], {
    cwd: ctx.workspace, env: ctx.env, ordinaryInput: true,
    input: { session_id: parentSessionId, turn_id: turnId, cwd: ctx.workspace, hook_event_name: 'SubagentStart', transcript_path: null, model: 'gpt', permission_mode: 'acceptEdits', agent_id: childId, agent_type: agentType },
  });
  assert.equal(result.code, 0, result.stderr || result.stdout);
}

test('0.147 default compatibility child persists and consumes one same-child Rescue choice', async (t) => {
  const ctx = await fixture(t); const identity = createIdentityStore({ dataRoot: ctx.dataRoot });
  await identity.beginCallerTurn({ sessionId: 'generic-parent', turnId: 'generic-seed', workspace: ctx.workspace, permissionMode: 'workspace-write', prompt: '$zcode:rescue --fresh --wait seed' });
  await startRescueChild(ctx, 'generic-parent', 'generic-child', 'generic-seed-child', 'default');
  assert.equal((await runChild(process.execPath, [cli, 'invoke', 'rescue'], { cwd: ctx.workspace, env: { ...ctx.env, CODEX_THREAD_ID: 'generic-child' } })).code, 0);
  await stopRescueChild(ctx, 'generic-parent', 'generic-child', 'generic-seed-child', 'default');
  await identity.beginCallerTurn({ sessionId: 'generic-parent', turnId: 'generic-origin', workspace: ctx.workspace, permissionMode: 'workspace-write', prompt: '$zcode:rescue --wait continue' });
  await startRescueChild(ctx, 'generic-parent', 'generic-child', 'generic-origin-child', 'default');
  const undecided = await runChild(process.execPath, [cli, 'invoke', 'rescue'], { cwd: ctx.workspace, env: { ...ctx.env, CODEX_THREAD_ID: 'generic-child' } });
  assert.equal(undecided.code, 3); assert.match(undecided.stdout, /needs-choice/);
  await stopRescueChild(ctx, 'generic-parent', 'generic-child', 'generic-origin-child', 'default');
  await identity.beginCallerTurn({ sessionId: 'generic-parent', turnId: 'generic-answer', workspace: ctx.workspace, permissionMode: 'workspace-write', prompt: 'resume' });
  const choice = await runChild(process.execPath, [cli, 'invoke-choice', 'rescue', 'resume'], { cwd: ctx.workspace, env: { ...ctx.env, CODEX_THREAD_ID: 'generic-child' } });
  assert.equal(choice.code, 0, choice.stderr || choice.stdout); assert.equal(choice.stdout, 'done\n');
  await assert.rejects(createInvocationStore({ dataRoot: ctx.dataRoot }).consumePending({ sessionId: 'generic-parent', workspace: ctx.workspace, command: 'rescue', choice: 'resume', executorAgentId: 'generic-child' }), { code: 'PENDING_INVOCATION_NOT_FOUND' });
  const replay = await runChild(process.execPath, [cli, 'invoke-choice', 'rescue', 'resume'], { cwd: ctx.workspace, env: { ...ctx.env, CODEX_THREAD_ID: 'generic-child' } });
  assert.notEqual(replay.code, 0); assert.match(replay.stdout, /PENDING_INVOCATION_NOT_FOUND/);
});
test('initial Rescue invocation must match the parent turn captured by SubagentStart', async (t) => {
  const ctx = await fixture(t); const identity = createIdentityStore({ dataRoot: ctx.dataRoot });
  await identity.beginCallerTurn({ sessionId: 'turn-parent', turnId: 'captured-turn', workspace: ctx.workspace, permissionMode: 'workspace-write', prompt: '$zcode:rescue --fresh --wait repair' });
  await startRescueChild(ctx, 'turn-parent', 'turn-child');
  await identity.beginCallerTurn({ sessionId: 'turn-parent', turnId: 'replacement-turn', workspace: ctx.workspace, permissionMode: 'workspace-write', prompt: '$zcode:rescue --fresh --wait different' });
  const result = await runChild(process.execPath, [cli, 'invoke', 'rescue'], { cwd: ctx.workspace, env: { ...ctx.env, CODEX_THREAD_ID: 'turn-child' } });
  assert.notEqual(result.code, 0); assert.match(result.stdout, /EXECUTOR_PARENT_TURN_MISMATCH/);
});

test('bound Rescue status sidecar exposes only safe fixed fields and starts no ZCode protocol', async (t) => {
  const ctx = await fixture(t); const identity = createIdentityStore({ dataRoot: ctx.dataRoot }); const store = createStateStore({ dataRoot: ctx.dataRoot });
  await identity.beginCallerTurn({ sessionId: 'status-parent', turnId: 'status-parent-turn', workspace: ctx.workspace, permissionMode: 'workspace-write', prompt: '$zcode:rescue --fresh --wait repair' });
  await startRescueChild(ctx, 'status-parent', 'status-child', 'status-child-turn');
  const job = await store.reserveJob({ workspace: ctx.workspace, ownerSessionId: 'status-parent', ownerTurnId: 'status-parent-turn', command: 'rescue', readOnly: false, permissionSnapshot: { permissionMode: 'workspace-write' } });
  await store.transitionJob(ctx.workspace, job.id, ['queued'], 'running', { startedAt: new Date().toISOString(), zcodeSessionId: 'PRIVATE_SESSION' });
  const observedAt = new Date().toISOString();
  await store.updateJobProgress(ctx.workspace, job.id, { phase: 'running', message: 'ZCode is working with a tool.', observedAt });
  const beforeStatus = await store.readJob(ctx.workspace, job.id);
  const protocolRecord = join(ctx.directory, 'status-protocol.jsonl');

  const result = await runChild(process.execPath, [cli, 'invoke-status', 'rescue'], { cwd: ctx.workspace, env: { ...ctx.env, CODEX_THREAD_ID: 'status-child', FAKE_ZCODE_RECORD: protocolRecord } });
  assert.equal(result.code, 0, result.stderr || result.stdout);
  const status = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(status), ['type', 'status', 'phase', 'lastActivityAt', 'progressPreview', 'terminal']);
  assert.deepEqual(status, { type: 'rescue-status', status: 'running', phase: 'running', lastActivityAt: observedAt, progressPreview: ['ZCode is working with a tool.'], terminal: false });
  assert.doesNotMatch(result.stdout, /job-|session-|workspace|worker|artifact|PRIVATE/i);
  assert.deepEqual(await store.readJob(ctx.workspace, job.id), beforeStatus);
  await assert.rejects(readFile(protocolRecord, 'utf8'), { code: 'ENOENT' });

  for (const argv of [
    ['invoke-status'], ['invoke-status', 'rescue', '--all'], ['invoke-status', 'rescue', 'job-id'], ['invoke-status', 'review'],
  ]) {
    const rejected = await runChild(process.execPath, [cli, ...argv], { cwd: ctx.workspace, env: { ...ctx.env, CODEX_THREAD_ID: 'status-child', FAKE_ZCODE_RECORD: protocolRecord } });
    assert.notEqual(rejected.code, 0, argv.join(' '));
  }
  await assert.rejects(readFile(protocolRecord, 'utf8'), { code: 'ENOENT' });
});

test('bound Rescue status sidecar rejects missing, sibling, stale-turn and ambiguous bindings', async (t) => {
  const ctx = await fixture(t); const identity = createIdentityStore({ dataRoot: ctx.dataRoot }); const store = createStateStore({ dataRoot: ctx.dataRoot });
  const missing = await runChild(process.execPath, [cli, 'invoke-status', 'rescue'], { cwd: ctx.workspace, env: { ...ctx.env, CODEX_THREAD_ID: 'missing-child' } });
  assert.notEqual(missing.code, 0); assert.match(missing.stdout, /EXECUTOR_IDENTITY_NOT_FOUND/);

  await identity.beginCallerTurn({ sessionId: 'side-parent', turnId: 'bound-turn', workspace: ctx.workspace, permissionMode: 'workspace-write', prompt: '$zcode:rescue --fresh --wait repair' });
  await startRescueChild(ctx, 'side-parent', 'bound-child', 'bound-child-turn');
  await store.reserveJob({ workspace: ctx.workspace, ownerSessionId: 'side-parent', ownerTurnId: 'bound-turn', command: 'rescue', readOnly: false, permissionSnapshot: { permissionMode: 'workspace-write' } });
  await startRescueChild(ctx, 'side-parent', 'same-turn-sibling', 'same-turn-sibling-turn');
  const sameTurnSibling = await runChild(process.execPath, [cli, 'invoke-status', 'rescue'], { cwd: ctx.workspace, env: { ...ctx.env, CODEX_THREAD_ID: 'bound-child' } });
  assert.notEqual(sameTurnSibling.code, 0); assert.match(sameTurnSibling.stdout, /EXECUTOR_IDENTITY_AMBIGUOUS/);
  await stopRescueChild(ctx, 'side-parent', 'same-turn-sibling', 'same-turn-sibling-turn');
  await identity.beginCallerTurn({ sessionId: 'side-parent', turnId: 'new-turn', workspace: ctx.workspace, permissionMode: 'workspace-write', prompt: 'new turn' });
  const stale = await runChild(process.execPath, [cli, 'invoke-status', 'rescue'], { cwd: ctx.workspace, env: { ...ctx.env, CODEX_THREAD_ID: 'bound-child' } });
  assert.notEqual(stale.code, 0); assert.match(stale.stdout, /EXECUTOR_PARENT_TURN_MISMATCH/);

  const sibling = await runChild(process.execPath, [cli, 'invoke-status', 'rescue'], { cwd: ctx.workspace, env: { ...ctx.env, CODEX_THREAD_ID: 'sibling-child' } });
  assert.notEqual(sibling.code, 0); assert.match(sibling.stdout, /EXECUTOR_IDENTITY_NOT_FOUND/);

  await store.reserveJob({ workspace: ctx.workspace, ownerSessionId: 'side-parent', ownerTurnId: 'bound-turn', command: 'rescue', readOnly: true, permissionSnapshot: { permissionMode: 'workspace-write' } });
  await identity.beginCallerTurn({ sessionId: 'side-parent', turnId: 'bound-turn', workspace: ctx.workspace, permissionMode: 'workspace-write', prompt: '$zcode:rescue --fresh --wait repair' });
  const ambiguous = await runChild(process.execPath, [cli, 'invoke-status', 'rescue'], { cwd: ctx.workspace, env: { ...ctx.env, CODEX_THREAD_ID: 'bound-child' } });
  assert.notEqual(ambiguous.code, 0); assert.match(ambiguous.stdout, /BOUND_RESCUE_STATUS_NOT_FOUND/);
});
async function stopRescueChild(ctx, parentSessionId, childId, turnId = `${childId}-turn`, agentType = 'zcode-rescue') {
  const result = await runChild(process.execPath, [join(root, 'hooks', 'subagent-hook.mjs')], { cwd: ctx.workspace, env: ctx.env, ordinaryInput: true, input: { session_id: parentSessionId, turn_id: turnId, cwd: ctx.workspace, hook_event_name: 'SubagentStop', transcript_path: null, model: 'gpt', permission_mode: 'acceptEdits', agent_id: childId, agent_type: agentType, agent_transcript_path: null, stop_hook_active: false, last_assistant_message: null } });
  assert.equal(result.code, 0, result.stderr || result.stdout);
}

function invoke(ctx, rawArgv, authorization, extraEnv = {}, ordinaryStdio = false) {
  return runChild(process.execPath, [cli, ...rawArgv], {
    cwd: ctx.workspace,
    env: { ...ctx.env, ...extraEnv },
    input: authorization,
    protectedInput: !ordinaryStdio,
  }).then((result) => ({ ...result, json: result.internal ? JSON.parse(result.internal) : null }));
}

function publicInvoke(ctx, rawArgv, caller = ctx.callerA, extraEnv = {}) {
  return invoke(ctx, rawArgv, { callerContext: caller }, extraEnv);
}

test('all eight skill commands preserve argv and execute across the CLI fd boundary', async (t) => {
  const ctx = await fixture(t);
  for (const skill of ['review', 'adversarial-review', 'rescue', 'transfer', 'status', 'result', 'cancel', 'setup']) {
    assert.match(await readFile(join(root, 'skills', skill, 'SKILL.md'), 'utf8'), new RegExp(`\\$zcode:${skill}`));
  }

  const invocations = [];
  const call = async (argv, caller = ctx.callerA, env = {}) => {
    const result = await publicInvoke(ctx, argv, caller, env); invocations.push({ argv, result }); return result;
  };
  const review = await call(['review', '--wait']);
  assert.equal(review.json.job.status, 'succeeded');
  const adversarial = await call(['adversarial-review', '--wait', 'challenge auth'], ctx.callerB);
  assert.equal(adversarial.json.job.status, 'succeeded');
  const rescue = await call(['rescue', '--fresh', '--wait', 'repair the fixture']);
  assert.equal(rescue.json.job.status, 'succeeded');

  const thread = { id: 'codex-a', ephemeral: false, turns: [
    { items: [{ type: 'userMessage', content: [{ type: 'text', text: 'hello' }] }] },
    { items: [{ type: 'agentMessage', text: 'hi' }] },
  ] };
  const transfer = await call(['transfer'], ctx.callerA, {
    CODEX_APP_SERVER_PATH: process.execPath,
    CODEX_APP_SERVER_ARGS_JSON: JSON.stringify([fakeCodex]),
    FAKE_CODEX_THREAD_JSON: JSON.stringify(thread),
  });
  assert.equal(transfer.json.job.status, 'succeeded');
  assert.equal(transfer.json.job.codexThreadId, 'codex-a');

  const status = await call(['status', rescue.json.job.id]);
  assert.equal(status.json.job.id, rescue.json.job.id);
  const result = await call(['result', rescue.json.job.id]);
  assert.equal(result.json.result, 'done');
  const queued = await call(['rescue', '--fresh', '--background', 'cancel this']);
  const cancelled = await call(['cancel', queued.json.job.id]);
  assert.equal(cancelled.json.job.status, 'cancelled');

  const setupArgv = ['setup'];
  const setupConfig = { config: { sandbox_workspace_write: { writable_roots: [ctx.dataRoot] } }, origins: {}, layers: [{ name: { type: 'user', file: join(ctx.dataRoot, 'config.toml') }, version: 'version-1', config: { sandbox_workspace_write: { writable_roots: [ctx.dataRoot] } } }] };
  const lifecycle = await runChild(process.execPath, [join(root, 'hooks', 'session-lifecycle-hook.mjs')], {
    cwd: ctx.workspace, env: ctx.env, ordinaryInput: true,
    input: { session_id: 'codex-setup', cwd: ctx.workspace, hook_event_name: 'SessionStart', transcript_path: null, model: 'gpt', permission_mode: 'acceptEdits', source: 'startup' },
  });
  assert.equal(lifecycle.code, 0, lifecycle.stderr || lifecycle.stdout);
  const prompt = await runChild(process.execPath, [join(root, 'hooks', 'user-prompt-hook.mjs')], {
    cwd: ctx.workspace, env: ctx.env, ordinaryInput: true,
    input: { session_id: 'codex-setup', turn_id: 'turn-setup', cwd: ctx.workspace, hook_event_name: 'UserPromptSubmit', transcript_path: null, model: 'gpt', permission_mode: 'acceptEdits', prompt: '$zcode:setup' },
  });
  assert.equal(prompt.code, 0, prompt.stderr || prompt.stdout);
  const setup = await invoke(ctx, setupArgv, undefined, {
    FAKE_ZCODE_VERSION: '0.1.0',
    CODEX_APP_SERVER_PATH: process.execPath,
    CODEX_APP_SERVER_ARGS_JSON: JSON.stringify([fakeCodex]),
    FAKE_CODEX_CONFIG_RESULT: JSON.stringify(setupConfig),
  }, true);
  assert.equal(setup.code, 0, setup.stderr || setup.stdout);
  assert.match(setup.stdout, /outdated/);
  invocations.push({ argv: setupArgv, result: setup });

  assert.deepEqual(invocations.map(({ result: value }) => value.spawnargs),
    invocations.map(({ argv }) => [process.execPath, cli, ...argv]));
  const secret = ctx.callerA;
  for (const { result: value } of invocations) {
    assert.doesNotMatch(`${value.stdout}${value.stderr}${value.spawnargs.join(' ')}`, new RegExp(secret));
  }
});

test('background private child receives only its one-use execution envelope', async (t) => {
  const ctx = await fixture(t);
  const reserved = await publicInvoke(ctx, ['review', '--background']);
  assert.equal(reserved.code, 0, reserved.stderr);
  assert.equal(reserved.json.type, 'background');
  assert.deepEqual(reserved.json.privateInvocation, ['run-reserved-job', reserved.json.job.id]);
  assert.doesNotMatch(`${reserved.stdout}${reserved.stderr}${reserved.spawnargs.join(' ')}`, new RegExp(reserved.json.executionCapability));
  assert.doesNotMatch(JSON.stringify(reserved.json.job), new RegExp(reserved.json.executionCapability));

  const authorization = { executionCapability: reserved.json.executionCapability, jobId: reserved.json.job.id };
  const first = await invoke(ctx, reserved.json.privateInvocation, authorization);
  assert.deepEqual(first.spawnargs, [process.execPath, cli, ...reserved.json.privateInvocation]);
  assert.equal(first.code, 0, first.stderr);
  assert.equal(first.json.job.status, 'succeeded');
  assert.doesNotMatch(`${first.stdout}${first.stderr}${first.spawnargs.join(' ')}`, new RegExp(ctx.callerA));
  assert.doesNotMatch(`${first.stdout}${first.stderr}${first.spawnargs.join(' ')}`, new RegExp(authorization.executionCapability));

  const replay = await invoke(ctx, reserved.json.privateInvocation, authorization);
  assert.notEqual(replay.code, 0);
  assert.equal(replay.json.error.code, 'EXECUTION_CAPABILITY_CONSUMED');
});

test('installed-style invoke uses ordinary stdio, ambient thread identity, and literal recorded prompt text', async (t) => {
  const ctx = await fixture(t); const identity = createIdentityStore({ dataRoot: ctx.env.PLUGIN_DATA });
  const marker = join(ctx.workspace, 'escaped'); const record = join(ctx.workspace, 'direct-record.jsonl');
  await identity.beginCallerTurn({ sessionId: 'codex-a', turnId: 'direct-turn', workspace: ctx.workspace, permissionMode: 'workspace-write', prompt: '$zcode:rescue --fresh --wait repair $(touch escaped) literally' });
  await startRescueChild(ctx, 'codex-a', 'direct-child');
  const result = await runChild(process.execPath, [cli, 'invoke', 'rescue'], { cwd: ctx.workspace, env: { ...ctx.env, CODEX_THREAD_ID: 'direct-child', FAKE_ZCODE_RECORD: record } });
  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.equal(result.stdout, 'done\n');
  await assert.rejects(readFile(marker, 'utf8'), { code: 'ENOENT' });
  const sent = (await readFile(record, 'utf8')).trim().split('\n').map((line) => JSON.parse(line)).find((frame) => frame.method === 'session/send');
  assert.match(sent.params.content, /repair \$\(touch escaped\) literally/);
  assert.equal(result.internal, '');

  const envWithoutThread = { ...ctx.env };
  delete envWithoutThread.CODEX_THREAD_ID;
  const missing = await runChild(process.execPath, [cli, 'invoke', 'status'], { cwd: ctx.workspace, env: envWithoutThread });
  assert.notEqual(missing.code, 0); assert.match(missing.stdout, /THREAD_ID_REQUIRED/);
  const sibling = await runChild(process.execPath, [cli, 'invoke', 'status'], { cwd: ctx.workspace, env: { ...ctx.env, CODEX_THREAD_ID: 'codex-bogus' } });
  assert.notEqual(sibling.code, 0); assert.match(sibling.stdout, /ACTIVE_TURN_NOT_FOUND/);
});

test('role-status default app-server path is read-only and leaves caller context and jobs untouched', async (t) => {
  const ctx = await fixture(t); const identity = createIdentityStore({ dataRoot: ctx.dataRoot });
  const sessionId = 'role-status-owner'; const turnId = 'role-status-turn';
  const callerContext = await identity.beginCallerTurn({ sessionId, turnId, workspace: ctx.workspace, permissionMode: 'acceptEdits', prompt: '$zcode:rescue --fresh repair' });
  await identity.beginCallerTurn({ sessionId: 'role-status-sibling', turnId: 'sibling-turn', workspace: ctx.workspace, permissionMode: 'read-only', prompt: 'unrelated sibling' });
  const lifecycle = await runChild(process.execPath, [join(root, 'hooks', 'session-lifecycle-hook.mjs')], {
    cwd: ctx.workspace, env: ctx.env, ordinaryInput: true,
    input: { session_id: sessionId, cwd: ctx.workspace, hook_event_name: 'SessionStart', transcript_path: null, model: 'gpt', permission_mode: 'acceptEdits', source: 'startup' },
  });
  assert.equal(lifecycle.code, 0, lifecycle.stderr || lifecycle.stdout);
  const configRecord = join(ctx.workspace, 'role-status-codex.jsonl');
  const zcodeRecord = join(ctx.workspace, 'role-status-zcode.jsonl');
  await writeFile(configRecord, ''); await writeFile(zcodeRecord, '');
  const configFile = join(ctx.dataRoot, 'config.toml');
  const config = { config: { features: { multi_agent_v2: { hide_spawn_agent_metadata: false } } }, origins: {}, layers: [{ name: { type: 'user', file: configFile }, version: 'version-1', config: {} }] };
  const result = await runChild(process.execPath, [cli, 'role-status', 'rescue'], {
    cwd: ctx.workspace,
    env: { ...ctx.env, CODEX_THREAD_ID: sessionId, CODEX_APP_SERVER_PATH: process.execPath, CODEX_APP_SERVER_ARGS_JSON: JSON.stringify([fakeCodex]), FAKE_CODEX_CONFIG_RESULT: JSON.stringify(config), FAKE_CODEX_RECORD: configRecord, FAKE_ZCODE_RECORD: zcodeRecord },
  });
  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.deepEqual(JSON.parse(result.stdout), { type: 'role-status', role: 'zcode-rescue', status: 'install-required', remedy: '$zcode:setup' });
  assert.equal(result.internal, '');
  const configCalls = (await readFile(configRecord, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  assert.deepEqual(configCalls.filter((frame) => frame.method).map((frame) => frame.method), ['initialize', 'initialized', 'config/read']);
  assert.equal(await readFile(zcodeRecord, 'utf8'), '');
  assert.deepEqual(await createStateStore({ dataRoot: ctx.dataRoot }).listJobs(ctx.workspace), []);
  const consumed = await identity.consumeCallerContext(callerContext, { workspace: ctx.workspace });
  assert.equal(consumed.sessionId, sessionId);
  assert.equal(consumed.turnId, turnId);
});

test('invoke-choice consumes only the same session pending rescue once', async (t) => {
  const ctx = await fixture(t); const identity = createIdentityStore({ dataRoot: ctx.env.PLUGIN_DATA });
  await identity.beginCallerTurn({ sessionId: 'codex-a', turnId: 'seed', workspace: ctx.workspace, permissionMode: 'workspace-write', prompt: '$zcode:rescue --fresh --wait first repair' });
  await startRescueChild(ctx, 'codex-a', 'choice-child-a');
  assert.equal((await runChild(process.execPath, [cli, 'invoke', 'rescue'], { cwd: ctx.workspace, env: { ...ctx.env, CODEX_THREAD_ID: 'choice-child-a' } })).code, 0);
  await stopRescueChild(ctx, 'codex-a', 'choice-child-a');
  await identity.beginCallerTurn({ sessionId: 'codex-a', turnId: 'choice-origin', workspace: ctx.workspace, permissionMode: 'workspace-write', prompt: '$zcode:rescue --wait continue repair' });
  await startRescueChild(ctx, 'codex-a', 'choice-child-a', 'choice-origin-child');
  const undecided = await runChild(process.execPath, [cli, 'invoke', 'rescue'], { cwd: ctx.workspace, env: { ...ctx.env, CODEX_THREAD_ID: 'choice-child-a' } });
  assert.equal(undecided.code, 3); assert.match(undecided.stdout, /needs-choice/);
  await stopRescueChild(ctx, 'codex-a', 'choice-child-a', 'choice-origin-child');
  await identity.beginCallerTurn({ sessionId: 'codex-a', turnId: 'choice-answer', workspace: ctx.workspace, permissionMode: 'workspace-write', prompt: 'resume' });
  await identity.beginCallerTurn({ sessionId: 'codex-b', turnId: 'sibling-answer', workspace: ctx.workspace, permissionMode: 'read-only', prompt: 'resume' });
  await startRescueChild(ctx, 'codex-b', 'choice-child-b');
  const sibling = await runChild(process.execPath, [cli, 'invoke-choice', 'rescue', 'resume'], { cwd: ctx.workspace, env: { ...ctx.env, CODEX_THREAD_ID: 'choice-child-b' } });
  assert.notEqual(sibling.code, 0); assert.match(sibling.stdout, /(?:PENDING_INVOCATION_NOT_FOUND|EXECUTOR_STATE_MISMATCH)/);
  const accepted = await runChild(process.execPath, [cli, 'invoke-choice', 'rescue', 'resume'], { cwd: ctx.workspace, env: { ...ctx.env, CODEX_THREAD_ID: 'choice-child-a' } });
  assert.equal(accepted.code, 0, accepted.stderr || accepted.stdout);
  const replay = await runChild(process.execPath, [cli, 'invoke-choice', 'rescue', 'fresh'], { cwd: ctx.workspace, env: { ...ctx.env, CODEX_THREAD_ID: 'choice-child-a' } });
  assert.notEqual(replay.code, 0); assert.match(replay.stdout, /PENDING_INVOCATION_NOT_FOUND/);
});

test('same-parent sibling cannot consume a pending Rescue choice without trusted executor identity', async (t) => {
  const ctx = await fixture(t); const identity = createIdentityStore({ dataRoot: ctx.env.PLUGIN_DATA });
  const hook = join(root, 'hooks', 'subagent-hook.mjs');
  const agentHook = (event, agentId, turnId) => runChild(process.execPath, [hook], {
    cwd: ctx.workspace, env: ctx.env, ordinaryInput: true,
    input: { session_id: 'shared-parent', turn_id: turnId, cwd: ctx.workspace, hook_event_name: event, transcript_path: null, model: 'gpt', permission_mode: 'acceptEdits', agent_id: agentId, agent_type: 'zcode-rescue', ...(event === 'SubagentStop' ? { agent_transcript_path: null, stop_hook_active: false, last_assistant_message: null } : {}) },
  });
  await identity.beginCallerTurn({ sessionId: 'shared-parent', turnId: 'seed', workspace: ctx.workspace, permissionMode: 'workspace-write', prompt: '$zcode:rescue --fresh --wait seed' });
  assert.equal((await agentHook('SubagentStart', 'rescue-child', 'child-seed')).code, 0);
  assert.equal((await runChild(process.execPath, [cli, 'invoke', 'rescue'], { cwd: ctx.workspace, env: { ...ctx.env, CODEX_THREAD_ID: 'rescue-child' } })).code, 0);
  assert.equal((await agentHook('SubagentStop', 'rescue-child', 'child-seed')).code, 0);
  await identity.beginCallerTurn({ sessionId: 'shared-parent', turnId: 'origin', workspace: ctx.workspace, permissionMode: 'workspace-write', prompt: '$zcode:rescue --wait protected' });
  assert.equal((await agentHook('SubagentStart', 'rescue-child', 'child-origin')).code, 0);
  assert.equal((await runChild(process.execPath, [cli, 'invoke', 'rescue'], { cwd: ctx.workspace, env: { ...ctx.env, CODEX_THREAD_ID: 'rescue-child' } })).code, 3);
  assert.equal((await agentHook('SubagentStop', 'rescue-child', 'child-origin')).code, 0);
  await identity.beginCallerTurn({ sessionId: 'shared-parent', turnId: 'later-answer', workspace: ctx.workspace, permissionMode: 'bypassPermissions', prompt: 'resume' });
  assert.equal((await agentHook('SubagentStart', 'sibling-child', 'sibling-answer')).code, 0);
  const sibling = await runChild(process.execPath, [cli, 'invoke-choice', 'rescue', 'resume'], { cwd: ctx.workspace, env: { ...ctx.env, CODEX_THREAD_ID: 'sibling-child' } });
  assert.notEqual(sibling.code, 0);
  assert.match(sibling.stdout, /(?:PENDING_INVOCATION_NOT_FOUND|EXECUTOR_STATE_MISMATCH)/);
  const parent = await runChild(process.execPath, [cli, 'invoke-choice', 'rescue', 'resume'], { cwd: ctx.workspace, env: { ...ctx.env, CODEX_THREAD_ID: 'shared-parent' } });
  assert.notEqual(parent.code, 0); assert.match(parent.stdout, /EXECUTOR_IDENTITY_(?:NOT_FOUND|UNAVAILABLE)/);
  const accepted = await runChild(process.execPath, [cli, 'invoke-choice', 'rescue', 'resume'], { cwd: ctx.workspace, env: { ...ctx.env, CODEX_THREAD_ID: 'rescue-child' } });
  assert.equal(accepted.code, 0, accepted.stderr || accepted.stdout);
  await assert.rejects(
    createInvocationStore({ dataRoot: ctx.dataRoot }).consumePending({ sessionId: 'shared-parent', workspace: ctx.workspace, command: 'rescue', choice: 'fresh', executorAgentId: 'rescue-child' }),
    { code: 'PENDING_INVOCATION_NOT_FOUND' },
  );
});

test('installed Rescue instructions keep needs-choice and every wait continuation on one child', async () => {
  const source = await readFile(join(root, 'skills', 'rescue', 'SKILL.md'), 'utf8');
  const role = await readFile(join(root, 'agents', 'zcode-rescue.toml.template'), 'utf8');
  const resume = 'Continue the pending ZCode Rescue with resume. Run only the installed resume forwarder command and return its public stdout verbatim.';
  const fresh = 'Continue the pending ZCode Rescue with fresh. Run only the installed fresh forwarder command and return its public stdout verbatim.';
  assert.match(source, /Keep the returned child ID as `rescueChildId`/);
  assert.match(source, /Do not call `spawn_agent` again after `rescueChildId` exists/);
  assert.match(source, /ask the user exactly once/i);
  assert.match(source, /followup_task\(\{\s*target:\s*rescueChildId,\s*message:\s*continuationMessage,?\s*\}\)/s);
  assert.match(source, /wait_agent\(\{\s*timeout_ms:\s*30000\s*\}\)/);
  assert.match(source, /select only the result or status belonging to `rescueChildId`/);
  assert.equal(source.split(resume).length - 1, 2);
  assert.equal(source.split(fresh).length - 1, 2);
  assert.match(role, /return a `needs-choice` response byte-for-byte and stop without selecting/i);
  assert.match(role, /For the exact resume continuation above, run only:[\s\S]+invoke-choice rescue resume/);
  assert.match(role, /For the exact fresh continuation above, run only:[\s\S]+invoke-choice rescue fresh/);
});

test('installed named and generic Rescue forwarders define terminal yielded-execution handling identically', async () => {
  const source = await readFile(join(root, 'skills', 'rescue', 'SKILL.md'), 'utf8');
  const role = await readFile(join(root, 'agents', 'zcode-rescue.toml.template'), 'utf8');
  const generic = /```text\n(Act only as the installed ZCode Rescue forwarder\.[\s\S]+?)\n```/.exec(source)?.[1];
  assert.ok(generic);
  const semantics = [
    /result containing an exit code is terminal/i,
    /running execution or session handle is nonterminal/i,
    /poll only that same handle with the host continuation tool until it reports an exit code/i,
    /Partial stdout, stderr, heartbeat text, or an outer code-cell completion is not terminal/i,
    /needs-choice response with exit code 3 is terminal for the current child turn/i,
    /exactly one `exec_command` companion process/i,
    /continuation calls only observe its original running handle/i,
  ];
  for (const forwarder of [role, generic]) for (const contract of semantics) assert.match(forwarder, contract);
  assert.equal((role.match(/invoke rescue/g) ?? []).length, 1);
  assert.equal((generic.match(/invoke rescue/g) ?? []).length, 1);
});

test('invoke-choice executes with the originating permission snapshot in both directions', async (t) => {
  const ctx = await fixture(t); const identity = createIdentityStore({ dataRoot: ctx.env.PLUGIN_DATA }); const record = join(ctx.workspace, 'permission-record.jsonl');
  const env = { ...ctx.env, FAKE_ZCODE_PERMISSION: '1', FAKE_ZCODE_PERMISSION_RISK: 'high', FAKE_ZCODE_RECORD: record };
  const decisions = async () => (await readFile(record, 'utf8')).trim().split('\n').map((line) => JSON.parse(line)).filter((frame) => frame?.result?.decision).map((frame) => frame.result.decision);
  await identity.beginCallerTurn({ sessionId: 'normal-origin', turnId: 'seed-normal', workspace: ctx.workspace, permissionMode: 'workspace-write', prompt: '$zcode:rescue --fresh --wait seed normal' });
  await startRescueChild(ctx, 'normal-origin', 'normal-child', 'seed-normal-child');
  assert.equal((await runChild(process.execPath, [cli, 'invoke', 'rescue'], { cwd: ctx.workspace, env: { ...env, CODEX_THREAD_ID: 'normal-child' } })).code, 0);
  await stopRescueChild(ctx, 'normal-origin', 'normal-child', 'seed-normal-child');
  await identity.beginCallerTurn({ sessionId: 'normal-origin', turnId: 'origin-normal', workspace: ctx.workspace, permissionMode: 'workspace-write', prompt: '$zcode:rescue --wait protected normal' });
  await startRescueChild(ctx, 'normal-origin', 'normal-child', 'origin-normal-child');
  assert.equal((await runChild(process.execPath, [cli, 'invoke', 'rescue'], { cwd: ctx.workspace, env: { ...env, CODEX_THREAD_ID: 'normal-child' } })).code, 3);
  await stopRescueChild(ctx, 'normal-origin', 'normal-child', 'origin-normal-child');
  await identity.beginCallerTurn({ sessionId: 'normal-origin', turnId: 'answer-bypass', workspace: ctx.workspace, permissionMode: 'bypassPermissions', prompt: 'fresh' });
  const denied = await runChild(process.execPath, [cli, 'invoke-choice', 'rescue', 'fresh'], { cwd: ctx.workspace, env: { ...env, CODEX_THREAD_ID: 'normal-child' } });
  assert.equal(denied.code, 0, denied.stderr || denied.stdout);
  assert.equal((await decisions()).at(-1), 'deny', 'a bypass answer turn must not upgrade the normal origin turn');

  await identity.beginCallerTurn({ sessionId: 'bypass-origin', turnId: 'seed-bypass', workspace: ctx.workspace, permissionMode: 'bypassPermissions', prompt: '$zcode:rescue --fresh --wait seed bypass' });
  await startRescueChild(ctx, 'bypass-origin', 'bypass-child', 'seed-bypass-child');
  assert.equal((await runChild(process.execPath, [cli, 'invoke', 'rescue'], { cwd: ctx.workspace, env: { ...env, CODEX_THREAD_ID: 'bypass-child' } })).code, 0);
  await stopRescueChild(ctx, 'bypass-origin', 'bypass-child', 'seed-bypass-child');
  await identity.beginCallerTurn({ sessionId: 'bypass-origin', turnId: 'origin-bypass', workspace: ctx.workspace, permissionMode: 'bypassPermissions', prompt: '$zcode:rescue --wait protected bypass' });
  await startRescueChild(ctx, 'bypass-origin', 'bypass-child', 'origin-bypass-child');
  assert.equal((await runChild(process.execPath, [cli, 'invoke', 'rescue'], { cwd: ctx.workspace, env: { ...env, CODEX_THREAD_ID: 'bypass-child' } })).code, 3);
  await stopRescueChild(ctx, 'bypass-origin', 'bypass-child', 'origin-bypass-child');
  await identity.beginCallerTurn({ sessionId: 'bypass-origin', turnId: 'answer-normal', workspace: ctx.workspace, permissionMode: 'workspace-write', prompt: 'fresh' });
  const allowed = await runChild(process.execPath, [cli, 'invoke-choice', 'rescue', 'fresh'], { cwd: ctx.workspace, env: { ...env, CODEX_THREAD_ID: 'bypass-child' } });
  assert.equal(allowed.code, 0, allowed.stderr || allowed.stdout);
  assert.equal((await decisions()).at(-1), 'allow', 'a normal answer turn must not downgrade the bypass origin turn');
});

test('direct background invocation keeps capabilities private and production owns the worker', async (t) => {
  const ctx = await fixture(t); const identity = createIdentityStore({ dataRoot: ctx.env.PLUGIN_DATA });
  const callerContext = await identity.beginCallerTurn({ sessionId: 'background-owner', turnId: 'background-turn', workspace: ctx.workspace, permissionMode: 'read-only', prompt: '$zcode:review --background' });
  ctx.preserveEvidence = true; const launched = await runChild(process.execPath, [cli, 'invoke', 'review'], { cwd: ctx.workspace, env: { ...ctx.env, CODEX_THREAD_ID: 'background-owner' } });
  assert.equal(launched.code, 0, launched.stderr || launched.stdout);
  const jobId = /Reserved background job ([a-f0-9]{64})\./.exec(launched.stdout)?.[1];
  assert.ok(jobId, launched.stdout); assert.doesNotMatch(`${launched.stdout}${launched.stderr}${launched.spawnargs.join(' ')}`, /executionCapability|callerContext|privateInvocation/);
  const store = createStateStore({ dataRoot: ctx.env.PLUGIN_DATA }); let job;
  // Windows CI can be heavily contended while several independent fixtures
  // start brokers and native lock probes. Keep the worker bounded, but leave
  // enough room for that startup/lock contention before declaring it stuck.
  const deadline = Date.now() + (process.platform === 'win32' ? 30_000 : 5_000);
  do { job = await store.readJob(ctx.workspace, jobId); if (['succeeded', 'failed', 'cancelled'].includes(job.status)) break; await new Promise((resolvePromise) => setTimeout(resolvePromise, 20)); } while (Date.now() < deadline);
  job = await waitForExactJobCleanup(ctx, store, jobId, process.platform === 'win32' ? 30_000 : 5_000, () => publicInvoke(ctx, ['cancel', jobId], callerContext));
  assert.equal(job.status, 'succeeded', JSON.stringify(job.error));
  ctx.preserveEvidence = false;
});

test('named and generic Rescue children receive only queued background output while production workers remain controllable', async (t) => {
  const ctx = await fixture(t); const identity = createIdentityStore({ dataRoot: ctx.env.PLUGIN_DATA }); const store = createStateStore({ dataRoot: ctx.env.PLUGIN_DATA });
  const gate = join(ctx.directory, 'background-completion.gate'); const gateReached = join(ctx.directory, 'background-completion.reached'); const record = join(ctx.directory, 'background-zcode.jsonl');
  for (const [route, agentType, control] of [['named', 'zcode-rescue', 'result'], ['generic', 'default', 'cancel']]) {
    const parentId = `background-${route}-parent`; const childId = `background-${route}-child`; const turnId = `background-${route}-turn`;
    const baselineJobIds = new Set((await store.listJobs(ctx.workspace)).map((job) => job.id));
    ctx.preserveEvidence = true; let backgroundVerified = false;
    await writeFile(gate, 'hold'); await writeFile(gateReached, ''); await writeFile(record, '');
    const callerContext = await identity.beginCallerTurn({ sessionId: parentId, turnId, workspace: ctx.workspace, permissionMode: 'workspace-write', prompt: `$zcode:rescue --fresh --background ${route} native child` });
    await startRescueChild(ctx, parentId, childId, `${turnId}-child`, agentType);
    try {
      const launched = await runChild(process.execPath, [cli, 'invoke', 'rescue'], { cwd: ctx.workspace, env: { ...ctx.env, CODEX_THREAD_ID: childId, FAKE_ZCODE_RECORD: record, FAKE_ZCODE_COMPLETION_GATE: gate, FAKE_ZCODE_COMPLETION_GATE_REACHED: gateReached, FAKE_ZCODE_COMPLETION_GATE_REACHED_DELAY_MS: '100' } });
      assert.equal(launched.code, 0, launched.stderr || launched.stdout);
      const jobId = /^Reserved background job ([a-f0-9]{64})\.\n$/.exec(launched.stdout)?.[1];
      assert.ok(jobId, `native ${route} child must receive only the public queued envelope: ${launched.stdout}`);
      let job = await store.readJob(ctx.workspace, jobId);
      await waitUntil(async () => await readFile(gateReached, 'utf8').catch(() => '') === 'blocked', 5_000, 'the fake peer did not reach its exact post-ack completion gate');
      assert.deepEqual(launched.spawnargs, [process.execPath, cli, 'invoke', 'rescue']);
      assert.equal(launched.internal, ''); assert.equal(launched.stderr, '');
      assert.doesNotMatch(`${launched.stdout}${launched.stderr}${launched.spawnargs.join(' ')}`, /executionCapability|callerContext|privateInvocation|capability-sentinel-only-fd3/);

      assert.equal(job.status, 'running', `the ${route} child must be able to exit after fd4 acknowledgement while its detached worker continues`);
      assert.equal(await workerLeaseAvailable(ctx, job), false, `the ${route} worker must still hold its exact lease after fd4 acknowledgement`);
      const status = await publicInvoke(ctx, ['status', jobId], callerContext);
      assert.equal(status.code, 0, status.stderr); assert.equal(status.json.job.status, 'running');
      assert.doesNotMatch(`${status.stdout}${status.stderr}${status.internal}`, /executionCapability|callerContext|privateInvocation/);

      if (control === 'cancel') {
        const cancelled = await publicInvoke(ctx, ['cancel', jobId], callerContext);
        const cancelJob = await store.readJob(ctx.workspace, jobId); const callsAtCancel = await readFile(record, 'utf8').catch((error) => `record-read:${error?.code}`); const storage = await resolveWorkspaceStorage({ dataRoot: ctx.dataRoot, workspace: ctx.workspace });
        const brokerFiles = await readFile(join(storage.directory, 'broker', 'identity.json'), 'utf8').catch((error) => `identity-read:${error?.code}`);
        const cancelEvidence = JSON.stringify({ code: cancelled.code, stdout: cancelled.stdout, stderr: cancelled.stderr, internal: cancelled.internal, json: cancelled.json, job: cancelJob, callsAtCancel, brokerFiles });
        assert.equal(cancelled.code, 0, cancelEvidence); assert.equal(cancelled.json.job.status, 'cancelled');
        await waitForExactJobCleanup(ctx, store, jobId, undefined, () => publicInvoke(ctx, ['cancel', jobId], callerContext));
        const calls = (await readFile(record, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
        assert.equal(calls.filter((call) => call.method === 'session/send').length, 1); assert.equal(calls.filter((call) => call.method === 'session/stop').length, 1); assert.equal(cancelled.json.job.resultArtifact, undefined);
      } else {
        await writeFile(gate, 'release');
        const waited = await publicInvoke(ctx, ['status', jobId, '--wait', '--timeout-ms', '5000'], callerContext);
        assert.equal(waited.code, 0, waited.stderr); assert.equal(waited.json.job.status, 'succeeded');
        const result = await publicInvoke(ctx, ['result', jobId], callerContext);
        assert.equal(result.code, 0, result.stderr); assert.equal(result.json.result, 'done');
        assert.doesNotMatch(`${result.stdout}${result.stderr}${result.internal}`, /executionCapability|callerContext|privateInvocation/);
      }
      backgroundVerified = true;
    } finally {
      await writeFile(gate, 'release').catch(() => {});
      const jobs = new Map();
      for (let attempt = 0; attempt < 20; attempt += 1) { for (const job of await findNewJobs(store, ctx.workspace, baselineJobIds)) jobs.set(job.id, job); await new Promise((resolvePromise) => setTimeout(resolvePromise, 50)); }
      for (const job of jobs.values()) await waitForExactJobCleanup(ctx, store, job.id, undefined, () => publicInvoke(ctx, ['cancel', job.id], callerContext));
      assert.equal(jobs.size, 1, `expected exactly one new ${route} background job during cleanup`);
      if (backgroundVerified) ctx.preserveEvidence = false;
    }
  }
});
