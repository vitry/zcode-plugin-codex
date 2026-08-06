// @ts-nocheck
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
  const delays = process.platform === 'win32' ? [100, 250, 500, 1_000] : [0];
  let lastError;
  for (const delay of delays) {
    if (delay) await new Promise((resolvePromise) => setTimeout(resolvePromise, delay));
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

function child(command, args, { cwd, env, input, protectedInput = false }) {
  return runChild(command, args, { cwd, env, input, protectedInput, ordinaryInput: !protectedInput })
    .then((result) => {
      if (protectedInput) return { ...result, json: JSON.parse(result.internal) };
      if (!result.stdout) return { ...result, json: null };
      try { return { ...result, json: JSON.parse(result.stdout) }; } catch { return { ...result, json: result.stdout }; }
    });
}

async function git(cwd, args) {
  const result = await child('git', args, { cwd, env: process.env });
  assert.equal(result.code, 0, result.stderr);
}

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-two-session-'));
  const workspace = join(directory, 'workspace'); const dataRoot = join(directory, 'data');
  await mkdir(workspace); await writeFile(join(workspace, 'tracked.txt'), 'base\n');
  await git(workspace, ['init', '-q']); await git(workspace, ['add', 'tracked.txt']);
  await git(workspace, ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'base']);
  await writeFile(join(workspace, 'tracked.txt'), 'changed\n');
  const env = { ...process.env, PLUGIN_ROOT: root, PLUGIN_DATA: dataRoot, ZCODE_PATH: fakeZCode };
  t.after(() => cleanupFixture(directory));
  return { workspace, dataRoot, env };
}

async function hook(ctx, script, input) {
  const result = await child(process.execPath, [join(root, 'hooks', script)], { cwd: ctx.workspace, env: ctx.env, input });
  assert.equal(result.code, 0, result.stderr);
  return result.json;
}

function companion(ctx, argv, caller, extraEnv = {}) {
  return child(process.execPath, [cli, ...argv], { cwd: ctx.workspace, env: { ...ctx.env, ...extraEnv }, input: { callerContext: caller }, protectedInput: true });
}

function thread(id) {
  return { id, ephemeral: false, turns: [{ items: [{ type: 'userMessage', content: [{ type: 'text', text: `hello ${id}` }] }] }] };
}

test('legacy protected companion calls remain isolated after real hooks stop exposing caller tokens', async (t) => {
  const ctx = await fixture(t);
  const identity = createIdentityStore({ dataRoot: ctx.dataRoot });
  const sessions = [
    { id: 'session-a', turn: 'turn-a', permission: 'acceptEdits' },
    { id: 'session-b', turn: 'turn-b', permission: 'plan' },
  ];
  for (const session of sessions) {
    await hook(ctx, 'session-lifecycle-hook.mjs', { session_id: session.id, cwd: ctx.workspace, hook_event_name: 'SessionStart', transcript_path: null, model: 'gpt', permission_mode: session.permission, source: 'startup' });
    const output = await hook(ctx, 'user-prompt-hook.mjs', { session_id: session.id, turn_id: session.turn, cwd: ctx.workspace, hook_event_name: 'UserPromptSubmit', transcript_path: null, model: 'gpt', permission_mode: session.permission, prompt: 'work' });
    assert.doesNotMatch(JSON.stringify(output), /ZCODE_CALLER_CONTEXT|callerContext/);
    session.caller = await identity.createCallerContext({ sessionId: session.id, turnId: session.turn, workspace: ctx.workspace, permissionMode: session.permission });
  }
  const [a, b] = sessions;
  assert.notEqual(a.caller, b.caller);

  for (const session of [a, b]) {
    const transfer = await companion(ctx, ['transfer'], session.caller, {
      CODEX_APP_SERVER_PATH: process.execPath,
      CODEX_APP_SERVER_ARGS_JSON: JSON.stringify([fakeCodex]),
      FAKE_CODEX_THREAD_JSON: JSON.stringify(thread(session.id)),
    });
    assert.equal(transfer.code, 0, transfer.stderr);
    assert.equal(transfer.json.job.codexThreadId, session.id, 'transfer without --source must use the authenticated caller session');
    session.transfer = transfer.json.job;
  }

  for (const session of [a, b]) {
    const rescue = await companion(ctx, ['rescue', '--fresh', '--wait', `repair for ${session.id}`], session.caller);
    assert.equal(rescue.code, 0, rescue.stderr);
    assert.equal(rescue.json.job.status, 'succeeded');
    session.rescue = rescue.json.job;
  }
  const jobs = await createStateStore({ dataRoot: ctx.dataRoot }).listJobs(ctx.workspace);
  assert.equal(jobs.find((job) => job.id === a.rescue.id).permissionSnapshot.permissionMode, 'acceptEdits');
  assert.equal(jobs.find((job) => job.id === b.rescue.id).permissionSnapshot.permissionMode, 'plan');
  assert.notEqual(jobs.find((job) => job.id === a.rescue.id).zcodeSessionId, jobs.find((job) => job.id === b.rescue.id).zcodeSessionId);

  for (const session of [a, b]) {
    const choice = await companion(ctx, ['rescue', 'continue repair'], session.caller);
    assert.equal(choice.code, 3);
    assert.equal(choice.json.type, 'needs-choice');
    assert.equal(choice.json.candidate.id, session.rescue.id);
    const status = await companion(ctx, ['status'], session.caller);
    assert.equal(status.json.job.id, session.rescue.id);
    const result = await companion(ctx, ['result'], session.caller);
    assert.equal(result.json.job.id, session.rescue.id);
    assert.equal(result.json.result, 'done');
  }

  for (const [owner, sibling] of [[a, b], [b, a]]) {
    for (const command of ['status', 'result']) {
      const denied = await companion(ctx, [command, sibling.rescue.id], owner.caller);
      assert.notEqual(denied.code, 0);
      assert.equal(denied.json.error.code, 'OWNED_JOB_NOT_FOUND');
    }
  }

  a.queued = (await companion(ctx, ['review', '--background'], a.caller)).json.job;
  b.queued = (await companion(ctx, ['review', '--background'], b.caller)).json.job;
  const crossCancel = await companion(ctx, ['cancel', b.queued.id], a.caller);
  assert.notEqual(crossCancel.code, 0);
  assert.equal(crossCancel.json.error.code, 'OWNED_JOB_NOT_FOUND');
  const bBefore = await companion(ctx, ['status'], b.caller);
  assert.equal(bBefore.json.job.status, 'queued');
  for (const session of [a, b]) {
    const cancelled = await companion(ctx, ['cancel'], session.caller);
    assert.equal(cancelled.code, 0, cancelled.stderr);
    assert.equal(cancelled.json.job.id, session.queued.id);
    assert.equal(cancelled.json.job.status, 'cancelled');
  }
});

test('real prompt hooks keep direct ambient-thread invocation exact in one workspace', async (t) => {
  const ctx = await fixture(t);
  for (const session of [
    { id: 'session-a', turn: 'turn-a', prompt: '$zcode:rescue --fresh --wait repair alpha' },
    { id: 'session-b', turn: 'turn-b', prompt: '$zcode:rescue --fresh --wait repair beta' },
  ]) {
    await hook(ctx, 'session-lifecycle-hook.mjs', { session_id: session.id, cwd: ctx.workspace, hook_event_name: 'SessionStart', transcript_path: null, model: 'gpt', permission_mode: 'acceptEdits', source: 'startup' });
    const output = await hook(ctx, 'user-prompt-hook.mjs', { session_id: session.id, turn_id: session.turn, cwd: ctx.workspace, hook_event_name: 'UserPromptSubmit', transcript_path: null, model: 'gpt', permission_mode: 'acceptEdits', prompt: session.prompt });
    assert.doesNotMatch(JSON.stringify(output), /ZCODE_CALLER_CONTEXT|callerContext/);
  }
  const a = await child(process.execPath, [cli, 'invoke', 'rescue'], { cwd: ctx.workspace, env: { ...ctx.env, CODEX_THREAD_ID: 'session-a' } });
  const b = await child(process.execPath, [cli, 'invoke', 'rescue'], { cwd: ctx.workspace, env: { ...ctx.env, CODEX_THREAD_ID: 'session-b' } });
  assert.equal(a.code, 0, a.stderr || a.stdout); assert.equal(b.code, 0, b.stderr || b.stdout);
  const jobs = await createStateStore({ dataRoot: ctx.dataRoot }).listJobs(ctx.workspace);
  assert.equal(jobs.filter((job) => job.ownerSessionId === 'session-a').length, 1);
  assert.equal(jobs.filter((job) => job.ownerSessionId === 'session-b').length, 1);
});
