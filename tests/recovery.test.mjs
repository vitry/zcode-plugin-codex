// @ts-nocheck
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createIdentityStore } from '../scripts/lib/identity.mjs';
import { createJobController } from '../scripts/lib/job-control.mjs';
import { buildPrompt } from '../scripts/lib/prompts.mjs';
import { loadReviewOutputSchema, validateJsonSchema } from '../scripts/lib/review-schema.mjs';
import { createStateStore } from '../scripts/lib/state.mjs';
import { resolveWorkspaceStorage } from '../scripts/lib/workspace.mjs';
import { failBackgroundDelivery, runCompanion, writeInternalResponse } from '../scripts/zcode-companion.mjs';

const writerProbe = fileURLToPath(new URL('./fixtures/internal-writer-child.mjs', import.meta.url));
const cancellingHolder = fileURLToPath(new URL('./fixtures/cancelling-holder.mjs', import.meta.url));
const companionCli = fileURLToPath(new URL('../scripts/zcode-companion.mjs', import.meta.url));
const fakeZCode = fileURLToPath(new URL('./fixtures/fake-zcode-cli.mjs', import.meta.url));

function runWriterProbe(mode) {
  const child = spawn(process.execPath, [writerProbe, mode], { stdio: ['ignore', 'pipe', 'pipe', 'ignore', 'pipe'] });
  let stdout = ''; let stderr = ''; child.stdout.on('data', (chunk) => { stdout += chunk; }); child.stderr.on('data', (chunk) => { stderr += chunk; });
  if (mode === 'early-close') child.stdio[4].destroy();
  if (mode === 'slow-read') { child.stdio[4].pause(); setTimeout(() => { child.stdio[4].on('data', () => {}); child.stdio[4].resume(); }, 50); }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`writer probe ${mode} exceeded hard timeout`)); }, 2_000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); }); child.once('exit', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

async function context() {
  const root = await mkdtemp(join(tmpdir(), 'zcode-recovery-')); const workspace = join(root, 'workspace'); const dataRoot = join(root, 'data');
  await mkdir(workspace); const identity = createIdentityStore({ dataRoot });
  const callerContext = await identity.createCallerContext({ sessionId: 'owner', turnId: 'turn', workspace, permissionMode: 'workspace-write' });
  return { root, workspace, dataRoot, identity, callerContext, env: { ...process.env, ZCODE_DATA_ROOT: dataRoot } };
}

test('background preparation failures terminalize the reservation and release the writable slot', async () => {
  for (const dependency of ['writeJobSpec', 'createExecutionCapability']) {
    const fixture = await context(); const failure = Object.assign(new Error(`${dependency} failed`), { code: 'EIO' });
    const dependencies = dependency === 'writeJobSpec'
      ? { writeJobSpec: async () => { throw failure; } }
      : { createExecutionCapability: async () => { throw failure; } };
    await assert.rejects(runCompanion(['rescue', '--background', '--fresh', 'repair'], { cwd: fixture.workspace, env: fixture.env, authorization: { callerContext: fixture.callerContext }, dependencies }), failure);
    const store = createStateStore({ dataRoot: fixture.dataRoot }); const failed = (await store.listJobs(fixture.workspace))[0];
    assert.equal(failed.status, 'failed'); assert.equal(failed.exitCode, 1); assert.ok(failed.finishedAt); assert.match(failed.error.message, /failed/);
    const later = await store.reserveJob({ workspace: fixture.workspace, ownerSessionId: 'owner', ownerTurnId: 'later', command: 'rescue', readOnly: false, permissionSnapshot: { permissionMode: 'workspace-write' } });
    assert.equal(later.status, 'queued');
  }
});

test('delivery failure revokes the minted capability and fails the queued job', async () => {
  const fixture = await context();
  const output = await runCompanion(['rescue', '--background', '--fresh', 'repair'], { cwd: fixture.workspace, env: fixture.env, authorization: { callerContext: fixture.callerContext } });
  await failBackgroundDelivery(output, Object.assign(new Error('fd4 closed'), { code: 'EPIPE' }));
  const storage = await resolveWorkspaceStorage({ dataRoot: fixture.dataRoot, workspace: fixture.workspace });
  const spec = JSON.parse(await readFile(join(storage.directory, 'job-specs', `${output.job.id}.json`), 'utf8'));
  const binding = { jobId: output.job.id, ownerSessionId: 'owner', workspace: fixture.workspace, operation: 'run-reserved-job', specDigest: spec.digest };
  await assert.rejects(fixture.identity.consumeExecutionCapability(output.executionCapability, binding), { code: 'EXECUTION_CAPABILITY_INVALID' });
  assert.equal((await createStateStore({ dataRoot: fixture.dataRoot }).readJob(fixture.workspace, output.job.id)).status, 'failed');
});

test('real CLI fd4 delivery failure revokes capability and releases the writable slot', async () => {
  const fixture = await context();
  const child = spawn(process.execPath, [companionCli, 'rescue', '--background', '--fresh', 'repair'], { cwd: fixture.workspace, env: fixture.env, stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'] });
  /** @type {import('node:stream').Writable} */ (child.stdio[3]).end(`${JSON.stringify({ callerContext: fixture.callerContext })}\n`);
  child.stdio[4].destroy();
  const code = await new Promise((resolve, reject) => { const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('companion delivery failure timed out')); }, 2_000); child.once('error', reject); child.once('exit', (value) => { clearTimeout(timer); resolve(value); }); });
  assert.notEqual(code, 0);
  const store = createStateStore({ dataRoot: fixture.dataRoot }); const [failed] = await store.listJobs(fixture.workspace); assert.equal(failed.status, 'failed');
  const storage = await resolveWorkspaceStorage({ dataRoot: fixture.dataRoot, workspace: fixture.workspace }); assert.deepEqual(await readdir(join(storage.directory, 'identity', 'capabilities')), []);
  const later = await store.reserveJob({ workspace: fixture.workspace, ownerSessionId: 'owner', ownerTurnId: 'later', command: 'rescue', readOnly: false, permissionSnapshot: { permissionMode: 'workspace-write' } }); assert.equal(later.status, 'queued');
});

test('internal response writer handles partial writes and stable pipe failures', async () => {
  const chunks = []; let calls = 0;
  await writeInternalResponse({ ok: true }, 44, { timeoutMs: 100, write: (_fd, buffer, offset, length, _position, callback) => {
    const count = Math.min(length, calls++ === 0 ? 2 : length); chunks.push(buffer.subarray(offset, offset + count)); queueMicrotask(() => callback(null, count));
  } });
  assert.equal(Buffer.concat(chunks).toString(), '{"ok":true}\n');
  for (const code of ['EPIPE', 'EBADF']) await assert.rejects(writeInternalResponse({ ok: true }, 44, { timeoutMs: 100, write: (_fd, _buffer, _offset, _length, _position, callback) => queueMicrotask(() => callback(Object.assign(new Error(code), { code }), 0)) }), { code: 'INTERNAL_RESPONSE_WRITE_FAILED' });
});

test('internal response writer times out without blocking the event loop and closes once', async () => {
  let closes = 0; let ticked = false; setImmediate(() => { ticked = true; });
  await assert.rejects(writeInternalResponse({ ok: true }, 44, { timeoutMs: 10, write: () => {}, close: (_fd, callback) => { closes += 1; callback(); } }), { code: 'INTERNAL_RESPONSE_WRITE_TIMEOUT' });
  assert.equal(closes, 1); assert.equal(ticked, true);
});

test('real fd4 writer is bounded for no-reader, slow-reader, and early-close pipes', async () => {
  const noRead = await runWriterProbe('no-read'); assert.equal(noRead.code, 0); assert.match(noRead.stdout, /INTERNAL_RESPONSE_WRITE_TIMEOUT/);
  const slowRead = await runWriterProbe('slow-read'); assert.equal(slowRead.code, 0); assert.match(slowRead.stdout, /ok/);
  const earlyClose = await runWriterProbe('early-close'); assert.equal(earlyClose.code, 0); assert.match(earlyClose.stdout, /INTERNAL_RESPONSE_WRITE_FAILED/);
});

test('a persisted cancelling job is taken over under the cancellation lock', async () => {
  const fixture = await context(); const store = createStateStore({ dataRoot: fixture.dataRoot });
  const job = await store.reserveJob({ workspace: fixture.workspace, ownerSessionId: 'owner', ownerTurnId: 'turn', command: 'rescue', readOnly: false, permissionSnapshot: { permissionMode: 'workspace-write' } });
  await store.transitionJob(fixture.workspace, job.id, ['queued'], 'running', { zcodeSessionId: 'session-z' }); await store.transitionJob(fixture.workspace, job.id, ['running'], 'cancelling');
  let stops = 0; const controller = createJobController({ store, dataRoot: fixture.dataRoot, stopSession: async (sessionId) => { assert.equal(sessionId, 'session-z'); stops += 1; } });
  assert.equal((await controller.cancel(fixture.workspace, job.id, 'owner')).status, 'cancelled'); assert.equal(stops, 1);
});

test('a second process takes over after a cancelling lock holder is SIGKILLed', async () => {
  const fixture = await context(); const store = createStateStore({ dataRoot: fixture.dataRoot });
  const job = await store.reserveJob({ workspace: fixture.workspace, ownerSessionId: 'owner', ownerTurnId: 'turn', command: 'rescue', readOnly: false, permissionSnapshot: { permissionMode: 'workspace-write' } });
  await store.transitionJob(fixture.workspace, job.id, ['queued'], 'running', { zcodeSessionId: 'session-z' });
  const child = spawn(process.execPath, [cancellingHolder, fixture.dataRoot, fixture.workspace, job.id], { stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); child.once('exit', (code) => reject(new Error(`holder exited early: ${code}`))); });
  child.kill('SIGKILL'); await new Promise((resolve) => child.once('exit', resolve));
  let stops = 0; const controller = createJobController({ store, dataRoot: fixture.dataRoot, stopSession: async () => { stops += 1; } });
  assert.equal((await controller.cancel(fixture.workspace, job.id, 'owner')).status, 'cancelled'); assert.equal(stops, 1);
});

test('review contract is embedded in the request and schema evaluation fails closed', async () => {
  const prompt = await buildPrompt({ command: 'review', gitFacts: {} });
  assert.match(prompt, /ZCODE_REVIEW_OUTPUT_SCHEMA:/); assert.match(prompt, /"additionalProperties":false/);
  assert.equal(validateJsonSchema({ findings: [] }, { type: 'object', required: ['findings'], properties: { findings: { type: 'array', items: { type: 'string' } } }, additionalProperties: false }), true);
  assert.throws(() => validateJsonSchema({}, { type: 'number' }), { code: 'REVIEW_SCHEMA_INVALID' });
});

test('the cached review schema is recursively immutable under concurrent loads', async () => {
  const [left, right] = await Promise.all([loadReviewOutputSchema(), loadReviewOutputSchema()]); assert.equal(left, right);
  assert.equal(Object.isFrozen(left), true); assert.equal(Object.isFrozen(left.required), true); assert.equal(Object.isFrozen(left.properties.findings.items.properties.severity.enum), true);
  assert.throws(() => left.required.push('forged'), TypeError); assert.throws(() => left.properties.findings.items.properties.severity.enum.push('bogus'), TypeError);
  assert.equal(validateJsonSchema({}, await loadReviewOutputSchema()), false);
});

test('fake peer tolerates non-string send content and still completes stop', async () => {
  const child = spawn(process.execPath, [fakeZCode], { stdio: ['pipe', 'pipe', 'pipe'] }); let stdout = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stdin.end([
    { id: 1, method: 'session/create', params: { sessionId: 'non-string', workspace: { workspacePath: '/repo' } } },
    { id: 2, method: 'session/send', params: { sessionId: 'non-string', content: { invalid: true }, inputId: 'input' } },
    { id: 3, method: 'session/stop', params: { sessionId: 'non-string' } },
  ].map((message) => JSON.stringify(message)).join('\n') + '\n');
  const code = await new Promise((resolve, reject) => { const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('fake stop path timed out')); }, 2_000); child.once('error', reject); child.once('exit', (value) => { clearTimeout(timer); resolve(value); }); });
  assert.equal(code, 0); const messages = stdout.trim().split('\n').map(JSON.parse); assert.deepEqual(messages.filter(({ id }) => id === 3).map(({ result }) => result), [{}]);
});
