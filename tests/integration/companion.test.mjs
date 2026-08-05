import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
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
  const env = { ...process.env, ZCODE_DATA_ROOT: dataRoot, ZCODE_PATH: fake };
  return { caller, dataRoot, directory, env, identity, workspace };
}

/** @param {string} command @param {string[]} args @param {{cwd?:string,env?:NodeJS.ProcessEnv,input?:unknown,rawInput?:string}} [options] */
function run(command, args, options = {}) {
  const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'], shell: false });
  return new Promise((resolvePromise, reject) => {
    let stdout = ''; let stderr = ''; let internal = '';
    child.stdout?.on('data', (chunk) => { stdout += chunk; }); child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.stdio[4]?.on('data', (chunk) => { internal += chunk; });
    /** @type {import('node:stream').Writable} */ (child.stdio[3]).end(options.rawInput ?? `${JSON.stringify(options.input ?? {})}\n`);
    child.once('error', reject); child.once('exit', (code) => resolvePromise({ code, stdout, stderr, internal }));
  });
}

/** @param {any} context @param {string[]} args @param {NodeJS.ProcessEnv} [extraEnv] @param {Record<string,unknown>} [authorization] */
async function companion(context, args, extraEnv = {}, authorization = { callerContext: context.caller }) {
  const result = await run(process.execPath, [cli, ...args], { cwd: context.workspace, env: { ...context.env, ...extraEnv }, input: authorization });
  return { ...result, json: result.internal ? JSON.parse(result.internal) : null };
}

test('module import has no CLI side effects', async () => {
  const result = await run(process.execPath, ['--input-type=module', '--eval', `await import(${JSON.stringify(new URL('../../scripts/zcode-companion.mjs', import.meta.url).href)}); process.stdout.write('imported')`]);
  assert.deepEqual({ code: result.code, stdout: result.stdout, stderr: result.stderr }, { code: 0, stdout: 'imported', stderr: '' });
});

test('real CLI runs foreground review/adversarial/rescue and persists private artifacts', async () => {
  const context = await fixture();
  for (const args of [
    ['review'],
    ['adversarial-review', 'focus on auth'],
    ['rescue', '--fresh', '--model', 'model', '--effort', 'HIGH', 'repair tests'],
  ]) {
    const result = await companion(context, args);
    assert.equal(result.code, 0, `${result.stderr}${result.stdout}`); assert.equal(result.json.job.status, 'succeeded');
    assert.equal(args[0] === 'rescue' ? result.json.result : JSON.parse(result.json.result).findings.length, args[0] === 'rescue' ? 'done' : 0);
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
  const reserved = await companion(context, ['review', '--background']);
  assert.equal(reserved.code, 0, reserved.stderr); assert.equal(reserved.json.type, 'background');
  assert.deepEqual(reserved.json.privateInvocation.slice(0, 2), ['run-reserved-job', reserved.json.job.id]);
  const capability = reserved.json.executionCapability; assert.ok(capability); assert.deepEqual(reserved.json.privateInvocation, ['run-reserved-job', reserved.json.job.id]); assert.doesNotMatch(JSON.stringify(reserved.json.job), new RegExp(capability));
  assert.doesNotMatch(renderOutput(reserved.json, { json: true }), new RegExp(capability));
  assert.doesNotMatch(`${reserved.stdout}${reserved.stderr}`, new RegExp(capability));
  const privateAuth = { executionCapability: capability, jobId: reserved.json.job.id };
  const first = await companion(context, reserved.json.privateInvocation, {}, privateAuth);
  assert.equal(first.code, 0, first.stderr); assert.equal(first.json.job.status, 'succeeded');
  const replay = await companion(context, reserved.json.privateInvocation, {}, privateAuth);
  assert.notEqual(replay.code, 0); assert.equal(replay.json.error.code, 'EXECUTION_CAPABILITY_CONSUMED');
});

test('status/list/result and queued cancellation enforce owned job semantics', async () => {
  const context = await fixture();
  const reserved = await companion(context, ['rescue', '--background', '--fresh', 'task']);
  assert.equal(reserved.code, 0, `${reserved.stderr}${reserved.stdout}`);
  const id = reserved.json.job.id;
  const listed = await companion(context, ['status', '--all']);
  assert.equal(listed.code, 0); assert.equal(listed.json.jobs.length, 1); assert.equal(listed.json.jobs[0].id, id);
  const unfinished = await companion(context, ['result', id]);
  assert.notEqual(unfinished.code, 0); assert.match(unfinished.json.error.remedy, new RegExp(`\\$zcode:status ${id} --wait`));
  const cancelled = await companion(context, ['cancel', id], { FAKE_ZCODE_VERSION: '0.1.0' });
  assert.equal(cancelled.code, 0); assert.equal(cancelled.json.job.status, 'cancelled');
  const status = await companion(context, ['status', id, '--wait', '--timeout-ms', '10']);
  assert.equal(status.code, 0); assert.equal(status.json.job.status, 'cancelled');
});

test('caller context is mandatory and diagnostics do not leak tokens or fake permission secrets', async () => {
  const context = await fixture();
  const missing = await companion(context, ['review'], { ZCODE_CALLER_CONTEXT: context.caller }, {});
  assert.notEqual(missing.code, 0); assert.equal(missing.json.error.code, 'INTERNAL_AUTHORIZATION_INVALID');
  const permitted = await companion(context, ['review'], { FAKE_ZCODE_PERMISSION: '1' });
  assert.equal(permitted.code, 0, permitted.stderr);
  assert.doesNotMatch(`${permitted.stdout}${permitted.stderr}`, /never-log-me/);
  assert.doesNotMatch(`${permitted.stdout}${permitted.stderr}`, new RegExp(context.caller));
});

test('internal authorization channel rejects malformed and oversized envelopes', async () => {
  const context = await fixture();
  for (const rawInput of ['{not-json}\n', `${JSON.stringify({ callerContext: 'x'.repeat(70 * 1024) })}\n`]) {
    const result = await run(process.execPath, [cli, 'review'], { cwd: context.workspace, env: context.env, rawInput });
    assert.notEqual(result.code, 0); assert.equal(JSON.parse(result.internal).error.code, 'INTERNAL_AUTHORIZATION_INVALID');
  }
});

test('caller authorization is absent from the running process command line and public streams', async () => {
  const context = await fixture(); const reserved = await companion(context, ['review', '--background']);
  const caller = await context.identity.createCallerContext({ sessionId: 'codex-session', turnId: 'turn-ps', workspace: context.workspace, permissionMode: 'workspace-write' });
  const child = spawn(process.execPath, [cli, 'status', reserved.json.job.id, '--wait', '--timeout-ms', '500'], { cwd: context.workspace, env: context.env, stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'], shell: false });
  let stdout = ''; let stderr = ''; let internal = ''; child.stdout?.on('data', (chunk) => { stdout += chunk; }); child.stderr?.on('data', (chunk) => { stderr += chunk; }); child.stdio[4]?.on('data', (chunk) => { internal += chunk; }); /** @type {import('node:stream').Writable} */ (child.stdio[3]).end(`${JSON.stringify({ callerContext: caller })}\n`);
  const inspected = await run('ps', ['-p', String(child.pid), '-o', 'command=']);
  assert.equal(inspected.code, 0); assert.doesNotMatch(inspected.stdout, new RegExp(caller));
  const code = await new Promise((resolvePromise, reject) => { child.once('error', reject); child.once('exit', resolvePromise); });
  assert.notEqual(code, 0); assert.doesNotMatch(`${stdout}${stderr}`, new RegExp(caller)); assert.equal(JSON.parse(internal).error.code, 'JOB_WAIT_TIMEOUT');
});

test('result refuses a symlink even when a persisted artifact path is scoped', async () => {
  const context = await fixture();
  const completed = await companion(context, ['review']);
  assert.equal(completed.code, 0, `${completed.stderr}${completed.stdout}`);
  const artifact = completed.json.job.resultArtifact;
  const storage = await resolveWorkspaceStorage(context);
  const artifactPath = join(storage.directory, artifact);
  await unlink(artifactPath); await symlink(join(context.workspace, 'tracked.txt'), artifactPath);
  const result = await companion(context, ['result', completed.json.job.id]);
  assert.notEqual(result.code, 0); assert.equal(result.json.error.code, 'RESULT_READ_FAILED');
});

test('artifact read and write reject intermediate directory symlinks', async () => {
  const writeContext = await fixture(); const writeStorage = await resolveWorkspaceStorage(writeContext); const writeEscape = join(writeContext.directory, 'write-escape');
  await mkdir(writeEscape); await symlink(writeEscape, join(writeStorage.directory, 'prompts'));
  const writeResult = await companion(writeContext, ['review']);
  assert.notEqual(writeResult.code, 0); assert.equal((await readdir(writeEscape)).length, 0);

  const readContext = await fixture(); const completed = await companion(readContext, ['review']); const readStorage = await resolveWorkspaceStorage(readContext);
  const resultsRoot = join(readStorage.directory, 'results'); const readEscape = join(readContext.directory, 'read-escape'); await mkdir(readEscape);
  const name = completed.json.job.resultArtifact.split('/').at(-1); await rename(join(resultsRoot, name), join(readEscape, name)); await rm(resultsRoot, { recursive: true }); await symlink(readEscape, resultsRoot);
  const readResult = await companion(readContext, ['result', completed.json.job.id]);
  assert.notEqual(readResult.code, 0); assert.equal(readResult.json.error.code, 'RESULT_READ_FAILED');
});

test('artifact writes reject an existing final symlink without replacing its target', async () => {
  const context = await fixture(); const reserved = await companion(context, ['review', '--background']); const storage = await resolveWorkspaceStorage(context);
  const prompts = join(storage.directory, 'prompts'); const escape = join(context.directory, 'prompt-escape'); await mkdir(prompts); await writeFile(escape, 'outside');
  const finalPath = join(prompts, `${reserved.json.job.id}.md`); await symlink(escape, finalPath);
  const result = await companion(context, reserved.json.privateInvocation, {}, { executionCapability: reserved.json.executionCapability, jobId: reserved.json.job.id });
  assert.notEqual(result.code, 0); assert.equal(await readFile(escape, 'utf8'), 'outside'); assert.equal((await stat(finalPath)).isFile(), true);
  assert.equal((await createStateStore({ dataRoot: context.dataRoot }).readJob(context.workspace, reserved.json.job.id)).status, 'failed');
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
    const cancelled = await companion(context, ['cancel', queued.id]);
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
  const fresh = await companion(context, ['rescue', '--fresh', 'first task']);
  assert.equal(fresh.code, 0, `${fresh.stderr}${fresh.stdout}`);
  const undecided = await companion(context, ['rescue', 'next task']);
  assert.equal(undecided.code, 3); assert.equal(undecided.json.type, 'needs-choice');
  assert.deepEqual(undecided.json.choices, ['--resume', '--fresh']);
  const resumed = await companion(context, ['rescue', '--resume', 'next task']);
  assert.equal(resumed.code, 0, `${resumed.stderr}${resumed.stdout}`);
  assert.equal(resumed.json.job.zcodeSessionId, fresh.json.job.zcodeSessionId);
});

test('foreground launch failure durably fails its reserved job', async () => {
  const context = await fixture();
  const failed = await companion(context, ['review'], { FAKE_ZCODE_VERSION: '0.1.0' });
  assert.notEqual(failed.code, 0);
  const jobs = await createStateStore({ dataRoot: context.dataRoot }).listJobs(context.workspace);
  assert.equal(jobs.length, 1); assert.equal(jobs[0].status, 'failed'); assert.equal(jobs[0].exitCode, 1);
});

test('private execution rejects a permission snapshot mismatch', async () => {
  const context = await fixture();
  const reserved = await companion(context, ['review', '--background']);
  const storage = await resolveWorkspaceStorage(context);
  const jobPath = join(storage.directory, 'jobs', `${reserved.json.job.id}.json`);
  const job = JSON.parse(await readFile(jobPath, 'utf8')); job.permissionSnapshot = { permissionMode: 'bypassPermissions' };
  await atomicWriteJson(jobPath, job);
  const result = await companion(context, reserved.json.privateInvocation, {}, { executionCapability: reserved.json.executionCapability, jobId: reserved.json.job.id });
  assert.notEqual(result.code, 0); assert.equal(result.json.error.code, 'EXECUTION_SNAPSHOT_MISMATCH');
});

test('tampered background spec is rejected before consuming its capability', async () => {
  const context = await fixture();
  const reserved = await companion(context, ['rescue', '--background', '--fresh', 'original task']);
  const storage = await resolveWorkspaceStorage(context);
  const path = join(storage.directory, 'job-specs', `${reserved.json.job.id}.json`);
  const original = JSON.parse(await readFile(path, 'utf8')); const tampered = structuredClone(original); tampered.spec.task = 'tampered task';
  await atomicWriteJson(path, tampered);
  const authorization = { executionCapability: reserved.json.executionCapability, jobId: reserved.json.job.id };
  const denied = await companion(context, reserved.json.privateInvocation, {}, authorization);
  assert.notEqual(denied.code, 0); assert.equal(denied.json.error.code, 'JOB_SPEC_TAMPERED');
  await atomicWriteJson(path, original);
  const retried = await companion(context, reserved.json.privateInvocation, {}, authorization);
  assert.equal(retried.code, 0, `${retried.stderr}${retried.stdout}`);
});

test('background resume revalidates the bound candidate immediately before resuming', async () => {
  const context = await fixture();
  const completed = await companion(context, ['rescue', '--fresh', 'first task']);
  const reserved = await companion(context, ['rescue', '--resume', '--background', 'second task']);
  const storage = await resolveWorkspaceStorage(context);
  const candidatePath = join(storage.directory, 'jobs', `${completed.json.job.id}.json`);
  const candidate = JSON.parse(await readFile(candidatePath, 'utf8')); candidate.zcodeSessionId = 'substituted-session';
  await atomicWriteJson(candidatePath, candidate);
  const result = await companion(context, reserved.json.privateInvocation, {}, { executionCapability: reserved.json.executionCapability, jobId: reserved.json.job.id });
  assert.notEqual(result.code, 0); assert.equal(result.json.error.code, 'RESUME_CANDIDATE_INVALID');
  assert.equal((await createStateStore({ dataRoot: context.dataRoot }).readJob(context.workspace, reserved.json.job.id)).status, 'failed');
});

test('model selection is applied at create time when resolvable and after live catalog or resume otherwise', async () => {
  const context = await fixture(); const recordPath = join(context.directory, 'requests.jsonl');
  const readRequests = async () => (await readFile(recordPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));

  await companion(context, ['rescue', '--fresh', '--model', 'fake2/other', 'qualified'], { FAKE_ZCODE_RECORD: recordPath });
  let requests = await readRequests();
  assert.deepEqual(requests.find((request) => request.method === 'session/create').params.model, { providerId: 'fake2', modelId: 'other' });

  await writeFile(recordPath, '');
  await companion(context, ['rescue', '--fresh', '--model', 'quick', 'alias'], { FAKE_ZCODE_RECORD: recordPath, ZCODE_MODEL_ALIASES: JSON.stringify({ quick: { providerId: 'fake2', modelId: 'other' } }) });
  requests = await readRequests();
  assert.deepEqual(requests.find((request) => request.method === 'session/create').params.model, { providerId: 'fake2', modelId: 'other' });

  await writeFile(recordPath, '');
  await companion(context, ['rescue', '--fresh', '--model', 'other', 'catalog'], { FAKE_ZCODE_RECORD: recordPath });
  requests = await readRequests();
  assert.equal(requests.find((request) => request.method === 'session/create').params.model, undefined);
  assert.deepEqual(requests.find((request) => request.method === 'session/setModel').params.model, { providerId: 'fake2', modelId: 'other' });

  await writeFile(recordPath, '');
  const resumed = await companion(context, ['rescue', '--resume', '--model', 'fake/model', 'resume'], { FAKE_ZCODE_RECORD: recordPath });
  assert.equal(resumed.code, 0, `${resumed.stderr}${resumed.stdout}`);
  requests = await readRequests();
  assert.ok(requests.some((request) => request.method === 'session/resume'));
  assert.ok(requests.some((request) => request.method === 'session/setModel' && request.params.model.providerId === 'fake'));
});

test('result extraction accepts mixed visible output and rejects reasoning-only or invalid structured output', async () => {
  const mixedContext = await fixture(); const mixed = await companion(mixedContext, ['review'], { FAKE_ZCODE_RESULT_MODE: 'mixed' });
  assert.equal(mixed.code, 0, `${mixed.stderr}${mixed.stdout}`); assert.deepEqual(JSON.parse(mixed.json.result), { findings: [] }); assert.doesNotMatch(mixed.json.result, /private reasoning|ignored/);
  for (const mode of ['reasoning-only', 'invalid-structured']) {
    const context = await fixture(); const result = await companion(context, ['review'], { FAKE_ZCODE_RESULT_MODE: mode });
    assert.notEqual(result.code, 0); assert.doesNotMatch(`${result.stdout}${result.stderr}${result.internal}`, /private reasoning/);
    const jobs = await createStateStore({ dataRoot: context.dataRoot }).listJobs(context.workspace);
    assert.equal(jobs[0].status, 'failed'); assert.equal(jobs[0].resultArtifact, undefined);
  }
});

test('status --all reports every workspace job with nonsecret ownership markers', async () => {
  const context = await fixture();
  await companion(context, ['review', '--background']);
  await companion(context, ['adversarial-review', '--background', 'focus']);
  const otherCaller = await context.identity.createCallerContext({ sessionId: 'other-session', turnId: 'other-turn', workspace: context.workspace, permissionMode: 'read-only' });
  await companion(context, ['review', '--background'], {}, { callerContext: otherCaller });
  const listed = await companion(context, ['status', '--all']);
  assert.equal(listed.json.jobs.length, 3);
  assert.equal(listed.json.jobs.filter((/** @type {any} */ job) => job.owned).length, 2);
  assert.deepEqual(new Set(listed.json.jobs.map((/** @type {any} */ job) => job.owner)), new Set(['same-owner', 'other']));
  assert.ok(listed.json.jobs.every((/** @type {any} */ job) => !('ownerSessionId' in job) && !('ownerTurnId' in job) && !('permissionSnapshot' in job)));
});

test('real CLI status wait stays alive until its timeout', async () => {
  const context = await fixture();
  const reserved = await companion(context, ['review', '--background']);
  const waited = await companion(context, ['status', reserved.json.job.id, '--wait', '--timeout-ms', '20']);
  assert.equal(waited.code, 1); assert.equal(waited.json.error.code, 'JOB_WAIT_TIMEOUT');
});
