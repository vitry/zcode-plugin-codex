// @ts-nocheck
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { createIdentityStore } from '../../scripts/lib/identity.mjs';
import { createStateStore } from '../../scripts/lib/state.mjs';
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

function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function ensureWorkerStopped(pid) {
  if (!Number.isSafeInteger(pid) || !processAlive(pid)) return;
  const wait = async (milliseconds) => {
    const deadline = Date.now() + milliseconds;
    while (processAlive(pid) && Date.now() < deadline) await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  };
  await wait(process.platform === 'win32' ? 5_000 : 1_000);
  if (processAlive(pid)) {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' });
    else try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch { /* already exited */ } }
    await wait(2_000);
  }
  assert.equal(processAlive(pid), false, `background worker ${pid} did not terminate`);
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
  t.after(() => cleanupFixture(directory));
  return { workspace, dataRoot, callerA, callerB, env };
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
  const result = await runChild(process.execPath, [cli, 'invoke', 'rescue'], { cwd: ctx.workspace, env: { ...ctx.env, CODEX_THREAD_ID: 'codex-a', FAKE_ZCODE_RECORD: record } });
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

test('invoke-choice consumes only the same session pending rescue once', async (t) => {
  const ctx = await fixture(t); const identity = createIdentityStore({ dataRoot: ctx.env.PLUGIN_DATA });
  await identity.beginCallerTurn({ sessionId: 'codex-a', turnId: 'seed', workspace: ctx.workspace, permissionMode: 'workspace-write', prompt: '$zcode:rescue --fresh --wait first repair' });
  assert.equal((await runChild(process.execPath, [cli, 'invoke', 'rescue'], { cwd: ctx.workspace, env: { ...ctx.env, CODEX_THREAD_ID: 'codex-a' } })).code, 0);
  await identity.beginCallerTurn({ sessionId: 'codex-a', turnId: 'choice-origin', workspace: ctx.workspace, permissionMode: 'workspace-write', prompt: '$zcode:rescue --wait continue repair' });
  const undecided = await runChild(process.execPath, [cli, 'invoke', 'rescue'], { cwd: ctx.workspace, env: { ...ctx.env, CODEX_THREAD_ID: 'codex-a' } });
  assert.equal(undecided.code, 3); assert.match(undecided.stdout, /needs-choice/);
  await identity.beginCallerTurn({ sessionId: 'codex-a', turnId: 'choice-answer', workspace: ctx.workspace, permissionMode: 'workspace-write', prompt: 'resume' });
  await identity.beginCallerTurn({ sessionId: 'codex-b', turnId: 'sibling-answer', workspace: ctx.workspace, permissionMode: 'read-only', prompt: 'resume' });
  const sibling = await runChild(process.execPath, [cli, 'invoke-choice', 'rescue', 'resume'], { cwd: ctx.workspace, env: { ...ctx.env, CODEX_THREAD_ID: 'codex-b' } });
  assert.notEqual(sibling.code, 0); assert.match(sibling.stdout, /PENDING_INVOCATION_NOT_FOUND/);
  const accepted = await runChild(process.execPath, [cli, 'invoke-choice', 'rescue', 'resume'], { cwd: ctx.workspace, env: { ...ctx.env, CODEX_THREAD_ID: 'codex-a' } });
  assert.equal(accepted.code, 0, accepted.stderr || accepted.stdout);
  const replay = await runChild(process.execPath, [cli, 'invoke-choice', 'rescue', 'fresh'], { cwd: ctx.workspace, env: { ...ctx.env, CODEX_THREAD_ID: 'codex-a' } });
  assert.notEqual(replay.code, 0); assert.match(replay.stdout, /PENDING_INVOCATION_NOT_FOUND/);
});

test('invoke-choice executes with the originating permission snapshot in both directions', async (t) => {
  const ctx = await fixture(t); const identity = createIdentityStore({ dataRoot: ctx.env.PLUGIN_DATA }); const record = join(ctx.workspace, 'permission-record.jsonl');
  const env = { ...ctx.env, FAKE_ZCODE_PERMISSION: '1', FAKE_ZCODE_PERMISSION_RISK: 'high', FAKE_ZCODE_RECORD: record };
  const decisions = async () => (await readFile(record, 'utf8')).trim().split('\n').map((line) => JSON.parse(line)).filter((frame) => frame?.result?.decision).map((frame) => frame.result.decision);

  await identity.beginCallerTurn({ sessionId: 'normal-origin', turnId: 'seed-normal', workspace: ctx.workspace, permissionMode: 'workspace-write', prompt: '$zcode:rescue --fresh --wait seed normal' });
  assert.equal((await runChild(process.execPath, [cli, 'invoke', 'rescue'], { cwd: ctx.workspace, env: { ...env, CODEX_THREAD_ID: 'normal-origin' } })).code, 0);
  await identity.beginCallerTurn({ sessionId: 'normal-origin', turnId: 'origin-normal', workspace: ctx.workspace, permissionMode: 'workspace-write', prompt: '$zcode:rescue --wait protected normal' });
  assert.equal((await runChild(process.execPath, [cli, 'invoke', 'rescue'], { cwd: ctx.workspace, env: { ...env, CODEX_THREAD_ID: 'normal-origin' } })).code, 3);
  await identity.beginCallerTurn({ sessionId: 'normal-origin', turnId: 'answer-bypass', workspace: ctx.workspace, permissionMode: 'bypassPermissions', prompt: 'fresh' });
  const denied = await runChild(process.execPath, [cli, 'invoke-choice', 'rescue', 'fresh'], { cwd: ctx.workspace, env: { ...env, CODEX_THREAD_ID: 'normal-origin' } });
  assert.equal(denied.code, 0, denied.stderr || denied.stdout);
  assert.equal((await decisions()).at(-1), 'deny', 'a bypass answer turn must not upgrade the normal origin turn');

  await identity.beginCallerTurn({ sessionId: 'bypass-origin', turnId: 'seed-bypass', workspace: ctx.workspace, permissionMode: 'bypassPermissions', prompt: '$zcode:rescue --fresh --wait seed bypass' });
  assert.equal((await runChild(process.execPath, [cli, 'invoke', 'rescue'], { cwd: ctx.workspace, env: { ...env, CODEX_THREAD_ID: 'bypass-origin' } })).code, 0);
  await identity.beginCallerTurn({ sessionId: 'bypass-origin', turnId: 'origin-bypass', workspace: ctx.workspace, permissionMode: 'bypassPermissions', prompt: '$zcode:rescue --wait protected bypass' });
  assert.equal((await runChild(process.execPath, [cli, 'invoke', 'rescue'], { cwd: ctx.workspace, env: { ...env, CODEX_THREAD_ID: 'bypass-origin' } })).code, 3);
  await identity.beginCallerTurn({ sessionId: 'bypass-origin', turnId: 'answer-normal', workspace: ctx.workspace, permissionMode: 'workspace-write', prompt: 'fresh' });
  const allowed = await runChild(process.execPath, [cli, 'invoke-choice', 'rescue', 'fresh'], { cwd: ctx.workspace, env: { ...env, CODEX_THREAD_ID: 'bypass-origin' } });
  assert.equal(allowed.code, 0, allowed.stderr || allowed.stdout);
  assert.equal((await decisions()).at(-1), 'allow', 'a normal answer turn must not downgrade the bypass origin turn');
});

test('direct background invocation keeps capabilities private and production owns the worker', async (t) => {
  const ctx = await fixture(t); const identity = createIdentityStore({ dataRoot: ctx.env.PLUGIN_DATA });
  await identity.beginCallerTurn({ sessionId: 'background-owner', turnId: 'background-turn', workspace: ctx.workspace, permissionMode: 'read-only', prompt: '$zcode:review --background' });
  const launched = await runChild(process.execPath, [cli, 'invoke', 'review'], { cwd: ctx.workspace, env: { ...ctx.env, CODEX_THREAD_ID: 'background-owner' } });
  assert.equal(launched.code, 0, launched.stderr || launched.stdout);
  const jobId = /Reserved background job ([a-f0-9]{64})\./.exec(launched.stdout)?.[1];
  assert.ok(jobId, launched.stdout); assert.doesNotMatch(`${launched.stdout}${launched.stderr}${launched.spawnargs.join(' ')}`, /executionCapability|callerContext|privateInvocation/);
  const store = createStateStore({ dataRoot: ctx.env.PLUGIN_DATA }); let job;
  // Windows CI can be heavily contended while several independent fixtures
  // start brokers and native lock probes. Keep the worker bounded, but leave
  // enough room for that startup/lock contention before declaring it stuck.
  const deadline = Date.now() + (process.platform === 'win32' ? 30_000 : 5_000);
  do { job = await store.readJob(ctx.workspace, jobId); if (['succeeded', 'failed', 'cancelled'].includes(job.status)) break; await new Promise((resolvePromise) => setTimeout(resolvePromise, 20)); } while (Date.now() < deadline);
  await ensureWorkerStopped(job.childPid);
  assert.equal(job.status, 'succeeded', JSON.stringify(job.error));
});
