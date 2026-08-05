import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { createIdentityStore } from '../../scripts/lib/identity.mjs';
import { atomicWriteJson } from '../../scripts/lib/fs.mjs';
import { ownerIdForSession } from '../../scripts/lib/job-control.mjs';
import { createStateStore } from '../../scripts/lib/state.mjs';
import { createManagedZCodeClient } from '../../scripts/lib/zcode-client.mjs';
import { resolveWorkspaceStorage } from '../../scripts/lib/workspace.mjs';
import { renderOutput } from '../../scripts/lib/render.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const cli = join(root, 'scripts', 'zcode-companion.mjs');
const fake = join(root, 'tests', 'fixtures', 'fake-zcode-cli.mjs');

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-companion-'));
  const workspace = join(directory, 'repo'); const dataRoot = join(directory, 'data');
  await mkdir(workspace); await writeFile(join(workspace, 'tracked.txt'), 'base\n');
  await run('git', ['init', '-q'], { cwd: workspace });
  await run('git', ['add', 'tracked.txt'], { cwd: workspace });
  await run('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'base'], { cwd: workspace });
  await writeFile(join(workspace, 'tracked.txt'), 'changed\n');
  const identity = createIdentityStore({ dataRoot });
  const caller = await identity.createCallerContext({ sessionId: 'codex-session', turnId: 'turn-1', workspace, permissionMode: 'workspace-write' });
  const env = { ...process.env, ZCODE_DATA_ROOT: dataRoot, ZCODE_PATH: fake, ZCODE_INTERNAL_TRANSPORT: 'json' };
  return { caller, dataRoot, directory, env, identity, workspace };
}

/** @param {string} command @param {string[]} args @param {{cwd?:string,env?:NodeJS.ProcessEnv}} [options] */
function run(command, args, options = {}) {
  const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
  return new Promise((resolvePromise, reject) => {
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; }); child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject); child.once('exit', (code) => resolvePromise({ code, stdout, stderr }));
  });
}

/** @param {any} context @param {string[]} args @param {NodeJS.ProcessEnv} [extraEnv] */
async function companion(context, args, extraEnv = {}) {
  const result = await run(process.execPath, [cli, ...args], { cwd: context.workspace, env: { ...context.env, ...extraEnv } });
  return { ...result, json: result.stdout ? JSON.parse(result.stdout) : null };
}

test('module import has no CLI side effects', async () => {
  const result = await run(process.execPath, ['--input-type=module', '--eval', `await import(${JSON.stringify(new URL('../../scripts/zcode-companion.mjs', import.meta.url).href)}); process.stdout.write('imported')`]);
  assert.deepEqual({ code: result.code, stdout: result.stdout, stderr: result.stderr }, { code: 0, stdout: 'imported', stderr: '' });
});

test('real CLI runs foreground review/adversarial/rescue and persists private artifacts', async () => {
  const context = await fixture();
  for (const args of [
    ['review', '--caller-context', context.caller],
    ['adversarial-review', '--caller-context', context.caller, 'focus on auth'],
    ['rescue', '--fresh', '--model', 'model', '--effort', 'HIGH', '--caller-context', context.caller, 'repair tests'],
  ]) {
    const result = await companion(context, args);
    assert.equal(result.code, 0, `${result.stderr}${result.stdout}`); assert.equal(result.json.job.status, 'succeeded');
    assert.equal(result.json.result, 'done');
  }
  const storage = await resolveWorkspaceStorage(context);
  const owners = JSON.parse(await readFile(join(storage.directory, 'broker', 'session-owners.json'), 'utf8'));
  assert.ok(Object.values(owners.sessions).every((owner) => owner === ownerIdForSession('codex-session')));
  for (const directory of ['prompts', 'results']) {
    const entries = await readdir(join(storage.directory, directory)); assert.ok(entries.length >= 3);
    for (const entry of entries) assert.equal((await stat(join(storage.directory, directory, entry))).mode & 0o777, 0o600);
  }
  const allText = (await Promise.all((await readdir(join(storage.directory, 'prompts'))).map((name) => readFile(join(storage.directory, 'prompts', name), 'utf8')))).join('\n');
  assert.match(allText, /UNTRUSTED GIT DATA/); assert.match(allText, /focus on auth/); assert.doesNotMatch(allText, new RegExp(context.caller));
});

test('background reservation exposes one private invocation, which is single-use', async () => {
  const context = await fixture();
  const reserved = await companion(context, ['review', '--background', '--caller-context', context.caller]);
  assert.equal(reserved.code, 0, reserved.stderr); assert.equal(reserved.json.type, 'background');
  assert.deepEqual(reserved.json.privateInvocation.slice(0, 2), ['run-reserved-job', reserved.json.job.id]);
  const capability = reserved.json.privateInvocation[3]; assert.ok(capability); assert.doesNotMatch(JSON.stringify(reserved.json.job), new RegExp(capability));
  assert.doesNotMatch(renderOutput(reserved.json, { json: true }), new RegExp(capability));
  const first = await companion(context, reserved.json.privateInvocation);
  assert.equal(first.code, 0, first.stderr); assert.equal(first.json.job.status, 'succeeded');
  const replay = await companion(context, reserved.json.privateInvocation);
  assert.notEqual(replay.code, 0); assert.equal(replay.json.error.code, 'EXECUTION_CAPABILITY_CONSUMED');
});

test('status/list/result and queued cancellation enforce owned job semantics', async () => {
  const context = await fixture();
  const reserved = await companion(context, ['rescue', '--background', '--fresh', '--caller-context', context.caller, 'task']);
  assert.equal(reserved.code, 0, `${reserved.stderr}${reserved.stdout}`);
  const id = reserved.json.job.id;
  const listed = await companion(context, ['status', '--all', '--caller-context', context.caller]);
  assert.equal(listed.code, 0); assert.equal(listed.json.jobs.length, 1); assert.equal(listed.json.jobs[0].id, id);
  const unfinished = await companion(context, ['result', id, '--caller-context', context.caller]);
  assert.notEqual(unfinished.code, 0); assert.match(unfinished.json.error.remedy, new RegExp(`\\$zcode:status ${id} --wait`));
  const cancelled = await companion(context, ['cancel', id, '--caller-context', context.caller], { FAKE_ZCODE_VERSION: '0.1.0' });
  assert.equal(cancelled.code, 0); assert.equal(cancelled.json.job.status, 'cancelled');
  const status = await companion(context, ['status', id, '--wait', '--timeout-ms', '10', '--caller-context', context.caller]);
  assert.equal(status.code, 0); assert.equal(status.json.job.status, 'cancelled');
});

test('caller context is mandatory and diagnostics do not leak tokens or fake permission secrets', async () => {
  const context = await fixture();
  const missing = await companion(context, ['review']);
  assert.notEqual(missing.code, 0); assert.equal(missing.json.error.code, 'CALLER_CONTEXT_REQUIRED'); assert.match(missing.json.error.remedy, /\$zcode:setup/);
  const permitted = await companion(context, ['review', '--caller-context', context.caller], { FAKE_ZCODE_PERMISSION: '1' });
  assert.equal(permitted.code, 0, permitted.stderr);
  assert.doesNotMatch(`${permitted.stdout}${permitted.stderr}`, /never-log-me/);
  assert.doesNotMatch(`${permitted.stdout}${permitted.stderr}`, new RegExp(context.caller));
});

test('result refuses a symlink even when a persisted artifact path is scoped', async () => {
  const context = await fixture();
  const completed = await companion(context, ['review', '--caller-context', context.caller]);
  assert.equal(completed.code, 0, `${completed.stderr}${completed.stdout}`);
  const artifact = completed.json.job.resultArtifact;
  const storage = await resolveWorkspaceStorage(context);
  const artifactPath = join(storage.directory, artifact);
  await unlink(artifactPath); await symlink(join(context.workspace, 'tracked.txt'), artifactPath);
  const result = await companion(context, ['result', completed.json.job.id, '--caller-context', context.caller]);
  assert.notEqual(result.code, 0); assert.equal(result.json.error.code, 'RESULT_READ_FAILED');
});

test('real CLI cancellation waits for stop acknowledgement and reports stop failure', async () => {
  for (const stopFails of [false, true]) {
    const context = await fixture();
    const launch = { command: process.execPath, args: [fake], target: fake };
    const client = await createManagedZCodeClient({ dataRoot: context.dataRoot, workspace: context.workspace, launch, ownerId: ownerIdForSession('codex-session'), env: { ...context.env, ...(stopFails ? { FAKE_ZCODE_ERROR: 'session/stop' } : {}) } });
    const created = await client.createSession({ workspace: context.workspace }); await client.close();
    const store = createStateStore({ dataRoot: context.dataRoot });
    const queued = await store.reserveJob({ workspace: context.workspace, ownerSessionId: 'codex-session', ownerTurnId: 'turn-1', command: 'rescue', readOnly: false, permissionSnapshot: { permissionMode: 'workspace-write' } });
    await store.transitionJob(context.workspace, queued.id, ['queued'], 'running', { zcodeSessionId: created.session.sessionId });
    const cancelled = await companion(context, ['cancel', queued.id, '--caller-context', context.caller]);
    if (stopFails) {
      assert.notEqual(cancelled.code, 0); assert.equal(cancelled.json.error.code, 'JOB_CANCEL_FAILED');
      assert.equal((await store.readJob(context.workspace, queued.id)).status, 'running');
    } else {
      assert.equal(cancelled.code, 0, `${cancelled.stderr}${cancelled.stdout}`); assert.equal(cancelled.json.job.status, 'cancelled');
    }
  }
});

test('rescue requires an explicit choice when an owned resumable session exists', async () => {
  const context = await fixture();
  const fresh = await companion(context, ['rescue', '--fresh', '--caller-context', context.caller, 'first task']);
  assert.equal(fresh.code, 0, `${fresh.stderr}${fresh.stdout}`);
  const undecided = await companion(context, ['rescue', '--caller-context', context.caller, 'next task']);
  assert.equal(undecided.code, 3); assert.equal(undecided.json.type, 'needs-choice');
  assert.deepEqual(undecided.json.choices, ['--resume', '--fresh']);
  const resumed = await companion(context, ['rescue', '--resume', '--caller-context', context.caller, 'next task']);
  assert.equal(resumed.code, 0, `${resumed.stderr}${resumed.stdout}`);
  assert.equal(resumed.json.job.zcodeSessionId, fresh.json.job.zcodeSessionId);
});

test('foreground launch failure durably fails its reserved job', async () => {
  const context = await fixture();
  const failed = await companion(context, ['review', '--caller-context', context.caller], { FAKE_ZCODE_VERSION: '0.1.0' });
  assert.notEqual(failed.code, 0);
  const jobs = await createStateStore({ dataRoot: context.dataRoot }).listJobs(context.workspace);
  assert.equal(jobs.length, 1); assert.equal(jobs[0].status, 'failed'); assert.equal(jobs[0].exitCode, 1);
});

test('private execution rejects a permission snapshot mismatch', async () => {
  const context = await fixture();
  const reserved = await companion(context, ['review', '--background', '--caller-context', context.caller]);
  const storage = await resolveWorkspaceStorage(context);
  const jobPath = join(storage.directory, 'jobs', `${reserved.json.job.id}.json`);
  const job = JSON.parse(await readFile(jobPath, 'utf8')); job.permissionSnapshot = { permissionMode: 'bypassPermissions' };
  await atomicWriteJson(jobPath, job);
  const result = await companion(context, reserved.json.privateInvocation);
  assert.notEqual(result.code, 0); assert.equal(result.json.error.code, 'EXECUTION_SNAPSHOT_MISMATCH');
});

test('real CLI status wait stays alive until its timeout', async () => {
  const context = await fixture();
  const reserved = await companion(context, ['review', '--background', '--caller-context', context.caller]);
  const waited = await companion(context, ['status', reserved.json.job.id, '--wait', '--timeout-ms', '20', '--caller-context', context.caller]);
  assert.equal(waited.code, 1); assert.equal(waited.json.error.code, 'JOB_WAIT_TIMEOUT');
});
