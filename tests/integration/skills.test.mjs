// @ts-nocheck
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { createIdentityStore } from '../../scripts/lib/identity.mjs';
import { runChild } from '../helpers/run-child.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const cli = join(root, 'scripts', 'zcode-companion.mjs');
const fakeZCode = join(root, 'tests/fixtures/fake-zcode-cli.mjs');
const fakeCodex = join(root, 'tests/fixtures/fake-codex-app-server.mjs');

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
  t.after(async () => { await new Promise((resolvePromise) => setTimeout(resolvePromise, 80)); await rm(directory, { force: true, recursive: true }); });
  return { workspace, callerA, callerB, env };
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
  const setup = await invoke(ctx, setupArgv, undefined, { FAKE_ZCODE_VERSION: '0.1.0' }, true);
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
