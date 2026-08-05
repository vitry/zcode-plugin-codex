// @ts-nocheck
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { createIdentityStore } from '../../scripts/lib/identity.mjs';
import { runCompanion } from '../../scripts/zcode-companion.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const fakeZCode = join(root, 'tests/fixtures/fake-zcode-cli.mjs');
const fakeCodex = join(root, 'tests/fixtures/fake-codex-app-server.mjs');

async function run(command, args, cwd) {
  const { spawn } = await import('node:child_process');
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'ignore' });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolvePromise() : reject(new Error(`${command} exited ${code}`)));
  });
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
  return { workspace, dataRoot, identity, callerA, callerB, env };
}

function invoke(ctx, argv, caller = ctx.callerA, extraEnv = {}) {
  return runCompanion(argv, { cwd: ctx.workspace, env: { ...ctx.env, ...extraEnv }, authorization: { callerContext: caller } });
}

test('all eight skill commands execute against fake peers', async (t) => {
  const ctx = await fixture(t);
  for (const skill of ['review', 'adversarial-review', 'rescue', 'transfer', 'status', 'result', 'cancel', 'setup']) {
    assert.match(await readFile(join(root, 'skills', skill, 'SKILL.md'), 'utf8'), new RegExp(`\\$zcode:${skill}`));
  }

  const review = await invoke(ctx, ['review', '--wait']);
  assert.equal(review.job.status, 'succeeded');
  const adversarial = await invoke(ctx, ['adversarial-review', '--wait', 'challenge auth'], ctx.callerB);
  assert.equal(adversarial.job.status, 'succeeded');
  const rescue = await invoke(ctx, ['rescue', '--fresh', '--wait', 'repair the fixture']);
  assert.equal(rescue.job.status, 'succeeded');

  const thread = { id: 'codex-a', ephemeral: false, turns: [
    { items: [{ type: 'userMessage', content: [{ type: 'text', text: 'hello' }] }] },
    { items: [{ type: 'agentMessage', text: 'hi' }] },
  ] };
  const transfer = await invoke(ctx, ['transfer'], ctx.callerA, {
    CODEX_APP_SERVER_PATH: process.execPath,
    CODEX_APP_SERVER_ARGS_JSON: JSON.stringify([fakeCodex]),
    FAKE_CODEX_THREAD_JSON: JSON.stringify(thread),
  });
  assert.equal(transfer.job.status, 'succeeded');
  assert.equal(transfer.job.codexThreadId, 'codex-a');

  const status = await invoke(ctx, ['status', rescue.job.id]);
  assert.equal(status.job.id, rescue.job.id);
  const result = await invoke(ctx, ['result', rescue.job.id]);
  assert.equal(result.result, 'done');
  const queued = await invoke(ctx, ['rescue', '--fresh', '--background', 'cancel this']);
  const cancelled = await invoke(ctx, ['cancel', queued.job.id]);
  assert.equal(cancelled.job.status, 'cancelled');

  const setup = await runCompanion(['setup'], {
    cwd: ctx.workspace,
    env: ctx.env,
    dependencies: { discoverZCode: async () => { throw Object.assign(new Error('not installed'), { code: 'ZCODE_NOT_FOUND' }); } },
  });
  assert.equal(setup.status, 'missing');
});

test('interleaved sessions retain ownership and background capability rejects replay', async (t) => {
  const ctx = await fixture(t);
  const reserved = await invoke(ctx, ['review', '--background'], ctx.callerA);
  assert.equal(reserved.type, 'background');
  await assert.rejects(invoke(ctx, ['status', reserved.job.id], ctx.callerB), { code: 'OWNED_JOB_NOT_FOUND' });

  const authorization = { executionCapability: reserved.executionCapability, jobId: reserved.job.id };
  const first = await runCompanion(reserved.privateInvocation, { cwd: ctx.workspace, env: ctx.env, authorization });
  assert.equal(first.job.status, 'succeeded');
  await assert.rejects(runCompanion(reserved.privateInvocation, { cwd: ctx.workspace, env: ctx.env, authorization }), { code: 'EXECUTION_CAPABILITY_CONSUMED' });

  const own = await invoke(ctx, ['result', reserved.job.id], ctx.callerA);
  assert.equal(own.job.ownerSessionId, 'codex-a');
  const bJob = await invoke(ctx, ['rescue', '--fresh', '--background', 'session b task'], ctx.callerB);
  await assert.rejects(invoke(ctx, ['cancel', bJob.job.id], ctx.callerA), { code: 'OWNED_JOB_NOT_FOUND' });
  assert.equal((await invoke(ctx, ['cancel', bJob.job.id], ctx.callerB)).job.status, 'cancelled');
});
