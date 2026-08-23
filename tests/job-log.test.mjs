// @ts-nocheck
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import test from 'node:test';

import {
  MAX_JOB_LOG_BODY_BYTES,
  MAX_JOB_LOG_EVENT_BYTES,
  MAX_JOB_LOG_TITLE_BYTES,
  appendJobLogBlock,
  appendJobLogEvent,
  createJobLog,
  createJobLogSink,
  resolveJobLogFile,
} from '../scripts/lib/job-log.mjs';
import { resolveWorkspaceStorage } from '../scripts/lib/workspace.mjs';
import { ensurePrivateDirectoryWithin, withFileLock } from '../scripts/lib/fs.mjs';

const JOB_ID = 'a'.repeat(64);

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'zcode-job-log-'));
  const workspace = join(root, 'workspace');
  const dataRoot = join(root, 'data');
  await mkdir(workspace);
  return { root, workspace, dataRoot };
}

async function withFixture(operation) {
  const context = await fixture();
  try { return await operation(context); }
  finally { await rm(context.root, { recursive: true, force: true }); }
}

async function waitForPaths(paths) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if ((await Promise.all(paths.map((path) => stat(path).then(() => true, () => false)))).every(Boolean)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('Timed out waiting for deterministic child-process gates.');
}

function runNode(source) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '--eval', source], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Gated append child exceeded its timeout.')); }, 10_000);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => { clearTimeout(timeout); reject(error); });
    child.once('exit', (code, signal) => { clearTimeout(timeout); resolve({ code, signal, stdout, stderr }); });
  });
}

test('resolves the exact log sibling and creates a private regular file', async () => withFixture(async ({ dataRoot, workspace }) => {
  const logFile = await resolveJobLogFile({ dataRoot, workspace, jobId: JOB_ID });
  const storage = await resolveWorkspaceStorage({ dataRoot, workspace });
  assert.equal(logFile, join(storage.directory, 'jobs', `${JOB_ID}.log`));

  assert.equal(await createJobLog({ dataRoot, workspace, jobId: JOB_ID, title: 'Rescue' }), logFile);
  const info = await lstat(logFile);
  assert.equal(info.isFile(), true);
  assert.equal(info.isSymbolicLink(), false);
  if (process.platform !== 'win32') assert.equal(info.mode & 0o777, 0o600);
  assert.match(await readFile(logFile, 'utf8'), /^\[\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z\] Starting Rescue\.\n$/);
}));

test('rejects non-canonical job IDs with one stable safe error', async () => withFixture(async ({ dataRoot, workspace }) => {
  for (const jobId of ['a'.repeat(63), 'A'.repeat(64), '../' + 'a'.repeat(61), `${'a'.repeat(64)}.log`]) {
    await assert.rejects(resolveJobLogFile({ dataRoot, workspace, jobId }), (error) => {
      assert.equal(error.code, 'JOB_LOG_ID_INVALID');
      assert.doesNotMatch(error.message, new RegExp(dataRoot.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      return true;
    });
  }
}));

test('rejects symbolic-link jobs ancestors and never writes their targets', { skip: process.platform === 'win32' }, async () => withFixture(async ({ root, dataRoot, workspace }) => {
  const storage = await resolveWorkspaceStorage({ dataRoot, workspace });
  const outside = join(root, 'outside');
  await mkdir(outside);
  await symlink(outside, join(storage.directory, 'jobs'), 'dir');
  await assert.rejects(createJobLog({ dataRoot, workspace, jobId: JOB_ID, title: 'Rescue' }), { code: 'JOB_LOG_PATH_UNSAFE' });
  await assert.rejects(stat(join(outside, `${JOB_ID}.log`)), { code: 'ENOENT' });
}));

test('rejects a symbolic-link leaf and never modifies its target', { skip: process.platform === 'win32' }, async () => withFixture(async ({ root, dataRoot, workspace }) => {
  const logFile = await resolveJobLogFile({ dataRoot, workspace, jobId: JOB_ID });
  const target = join(root, 'target.log');
  await writeFile(target, 'unchanged\n');
  await symlink(target, logFile);
  await assert.rejects(appendJobLogEvent({ dataRoot, workspace, jobId: JOB_ID, event: 'unsafe' }), { code: 'JOB_LOG_PATH_UNSAFE' });
  assert.equal(await readFile(target, 'utf8'), 'unchanged\n');
}));

test('foreign final installed immediately before publication remains canonical and unchanged', async () => withFixture(async ({ dataRoot, workspace }) => {
  const logFile = await resolveJobLogFile({ dataRoot, workspace, jobId: JOB_ID });
  const displaced = `${logFile}.pre-publication`;
  const probe = await open(join(dirname(logFile), '.publication-probe'), 'w+', 0o600);
  const prototype = Object.getPrototypeOf(probe);
  await probe.close();
  const originalSync = prototype.sync;
  let injected = false;
  prototype.sync = async function installForeignFinal(...args) {
    if (!injected) {
      injected = true;
      try { await rename(logFile, displaced); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
      await writeFile(logFile, 'foreign final\n', { mode: 0o600 });
    }
    return originalSync.call(this, ...args);
  };
  try { await createJobLog({ dataRoot, workspace, jobId: JOB_ID, title: 'Publication race' }); }
  finally { prototype.sync = originalSync; }
  assert.equal(injected, true);
  assert.equal(await readFile(logFile, 'utf8'), 'foreign final\n');
}));

test('verified reopening appends without truncating and rejects owner-accessible permissions', async () => withFixture(async ({ dataRoot, workspace }) => {
  const logFile = await createJobLog({ dataRoot, workspace, jobId: JOB_ID, title: 'Review' });
  const sink = await createJobLogSink({ dataRoot, workspace, jobId: JOB_ID });
  assert.equal(sink.disabled, false);
  assert.equal(sink.logFile, logFile);
  await sink.appendEvent('resumed');
  await sink.close();
  const contents = await readFile(logFile, 'utf8');
  assert.match(contents, /Starting Review\./);
  assert.match(contents, /resumed\n$/);

  if (process.platform !== 'win32') {
    await chmod(logFile, 0o640);
    await assert.rejects(appendJobLogEvent({ dataRoot, workspace, jobId: JOB_ID, event: 'must fail' }), { code: 'JOB_LOG_PATH_UNSAFE' });
    assert.doesNotMatch(await readFile(logFile, 'utf8'), /must fail/);
  }
}));

test('retains exactly one private unpublished temp per job without reopen amplification', async () => withFixture(async ({ dataRoot, workspace }) => {
  const first = await createJobLogSink({ dataRoot, workspace, jobId: JOB_ID });
  const storage = await resolveWorkspaceStorage({ dataRoot, workspace });
  const publicationDirectory = join(storage.directory, 'jobs', '.job-log-publication-locks', JOB_ID);
  const before = (await readdir(publicationDirectory)).sort();
  assert.equal(before.filter((entry) => entry.endsWith('.tmp')).length, 1);
  assert.deepEqual(before.filter((entry) => !entry.endsWith('.tmp')), ['advisory.lock']);
  const temporary = join(publicationDirectory, before.find((entry) => entry.endsWith('.tmp')));
  if (process.platform !== 'win32') assert.equal((await stat(temporary)).mode & 0o777, 0o600);

  const reopened = await createJobLogSink({ dataRoot, workspace, jobId: JOB_ID });
  assert.equal(reopened.logFile, first.logFile);
  assert.deepEqual((await readdir(publicationDirectory)).sort(), before);
  await Promise.all([first.close(), reopened.close()]);
}));

test('serializes concurrent sink appends in invocation order and separates blocks', async () => withFixture(async ({ dataRoot, workspace }) => {
  const sink = await createJobLogSink({ dataRoot, workspace, jobId: JOB_ID });
  await Promise.all([
    sink.appendEvent('first\r\nwith\tcontrols\u0000'),
    sink.appendEvent('second'),
    sink.appendBlock('Assistant\nmessage', 'line one\nline two\n'),
    sink.appendEvent('fourth'),
  ]);
  await sink.flush();
  const contents = await readFile(sink.logFile, 'utf8');
  const lines = contents.split('\n');
  assert.match(lines[0], /^\[.+Z\] first with controls$/);
  assert.match(lines[1], /^\[.+Z\] second$/);
  assert.equal(lines[2], '');
  assert.match(lines[3], /^\[.+Z\] Assistant message$/);
  assert.equal(lines[4], 'line one');
  assert.equal(lines[5], 'line two');
  assert.equal(lines[6], '');
  assert.match(lines[7], /^\[.+Z\] fourth$/);
}));

test('normalizes every public Unicode line separator out of event lines and block titles', async () => withFixture(async ({ dataRoot, workspace }) => {
  const sink = await createJobLogSink({ dataRoot, workspace, jobId: JOB_ID });
  await sink.appendEvent('event\u000bvertical\u000cform\u001cfile\u0085next\u2028third\u2029last');
  await sink.appendBlock('title\u0085next\u2028third\u2029last', 'body');
  await sink.close();
  const contents = await readFile(sink.logFile, 'utf8');
  assert.match(contents, /^\[.+Z\] event vertical form file next third last\n\n\[.+Z\] title next third last\nbody\n$/);
  for (const separator of ['\u000b', '\u000c', '\u001c', '\u0085', '\u2028', '\u2029']) assert.equal(contents.includes(separator), false);
}));

test('serializes equivalent spellings of one canonical workspace in invocation order', async () => withFixture(async ({ dataRoot, workspace }) => {
  const alias = `${workspace}${sep}.`;
  const sink = await createJobLogSink({ dataRoot, workspace, jobId: JOB_ID });
  const first = appendJobLogEvent({ dataRoot, workspace: alias, jobId: JOB_ID, event: 'alias first' });
  const second = sink.appendEvent('canonical second');
  await Promise.all([first, second]);
  await sink.close();
  const lines = (await readFile(sink.logFile, 'utf8')).trim().split('\n');
  assert.match(lines[0], /alias first$/);
  assert.match(lines[1], /canonical second$/);
}));

test('cross-process append locking keeps gated large block frames contiguous', async () => withFixture(async ({ root, dataRoot, workspace }) => {
  const logFile = await createJobLogSink({ dataRoot, workspace, jobId: JOB_ID }).then((sink) => sink.logFile);
  const gates = join(root, 'append-gates');
  await mkdir(gates);
  const bodyBytes = 256 * 1024;
  const moduleUrl = new URL('../scripts/lib/job-log.mjs', import.meta.url).href;
  const childSource = (id) => `
    import { constants } from 'node:fs';
    import { access, mkdir, open } from 'node:fs/promises';
    import { join } from 'node:path';
    import { appendJobLogBlock } from ${JSON.stringify(moduleUrl)};
    const gates = ${JSON.stringify(gates)}; const id = ${JSON.stringify(id)}; const peer = id === 'A' ? 'B' : 'A';
    await mkdir(join(gates, 'ready-' + id));
    while (true) { try { await access(join(gates, 'release')); break; } catch { await new Promise((resolve) => setTimeout(resolve, 5)); } }
    const probe = await open(${JSON.stringify(logFile)}, constants.O_RDONLY); const prototype = Object.getPrototypeOf(probe); await probe.close();
    const originalWrite = prototype.write; let call = 0;
    prototype.write = async function gatedPartial(buffer, offset = 0, length = buffer.byteLength - offset, position) {
      const result = await originalWrite.call(this, buffer, offset, Math.min(length, 65536), position); call += 1;
      await mkdir(join(gates, id + '-' + call)).catch(() => {});
      const peerGate = join(gates, peer + '-' + call); const deadline = Date.now() + 100;
      while (Date.now() < deadline) { try { await access(peerGate); break; } catch { await new Promise((resolve) => setTimeout(resolve, 2)); } }
      return result;
    };
    try { await appendJobLogBlock({ dataRoot: ${JSON.stringify(dataRoot)}, workspace: ${JSON.stringify(workspace)}, jobId: ${JSON.stringify(JOB_ID)}, title: 'Child ' + id, body: id.repeat(${bodyBytes}) }); }
    finally { prototype.write = originalWrite; }
  `;
  const children = [runNode(childSource('A')), runNode(childSource('B'))];
  await waitForPaths([join(gates, 'ready-A'), join(gates, 'ready-B')]);
  await mkdir(join(gates, 'release'));
  const results = await Promise.all(children);
  for (const result of results) assert.equal(result.code, 0, result.stderr || result.stdout);

  const contents = await readFile(logFile, 'utf8');
  const headers = [...contents.matchAll(/\n\[[^\]\n]+\] Child ([AB])\n/g)];
  assert.equal(headers.length, 2);
  assert.notEqual(headers[0][1], headers[1][1]);
  for (let index = 0; index < headers.length; index += 1) {
    const start = headers[index].index + headers[index][0].length;
    const end = index + 1 < headers.length ? headers[index + 1].index : contents.length;
    assert.equal(contents.slice(start, end), `${headers[index][1].repeat(bodyBytes)}\n`);
  }
}));

test('append revalidates admitted identity after waiting for the cross-process lock', async () => withFixture(async ({ dataRoot, workspace }) => {
  const sink = await createJobLogSink({ dataRoot, workspace, jobId: JOB_ID });
  const storage = await resolveWorkspaceStorage({ dataRoot, workspace });
  const jobsRoot = join(storage.directory, 'jobs');
  const locksRoot = join(jobsRoot, '.job-log-append-locks');
  await ensurePrivateDirectoryWithin(jobsRoot, locksRoot);
  const lockPath = join(locksRoot, JOB_ID);
  const displaced = `${sink.logFile}.lock-waiter`;
  let appendPromise;
  let observed;
  let settled = false;
  let settledWhileHeld;
  const probe = await open(sink.logFile, constants.O_RDONLY);
  const prototype = Object.getPrototypeOf(probe);
  const logIdentity = await probe.stat({ bigint: true });
  await probe.close();
  const originalStat = prototype.stat;
  let logStatCalls = 0; let markAdmitted;
  const admitted = new Promise((resolve) => { markAdmitted = resolve; });
  prototype.stat = async function markAdmission(...args) {
    const info = await originalStat.call(this, ...args);
    if (BigInt(info.dev) === logIdentity.dev && BigInt(info.ino) === logIdentity.ino) logStatCalls += 1;
    if (logStatCalls === 3) markAdmitted();
    return info;
  };
  try {
    await withFileLock(lockPath, async () => {
      appendPromise = appendJobLogEvent({ dataRoot, workspace, jobId: JOB_ID, event: 'must fail after waiting' });
      observed = appendPromise.then(() => ({ ok: true }), (error) => ({ ok: false, error })).finally(() => { settled = true; });
      await admitted;
      await new Promise((resolve) => setImmediate(resolve));
      settledWhileHeld = settled;
      if (!settled) {
        await rename(sink.logFile, displaced);
        await writeFile(sink.logFile, 'replacement\n', { mode: 0o600 });
      }
    });
    const outcome = await observed;
    assert.equal(settledWhileHeld, false);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.error.code, 'JOB_LOG_PATH_UNSAFE');
  } finally { prototype.stat = originalStat; }
  assert.equal(await readFile(sink.logFile, 'utf8'), 'replacement\n');
  assert.doesNotMatch(await readFile(displaced, 'utf8'), /must fail after waiting/);
}));

test('append-lock path failures throw safely for direct calls and only disable sinks', { skip: process.platform === 'win32' }, async () => withFixture(async ({ root, dataRoot, workspace }) => {
  const sink = await createJobLogSink({ dataRoot, workspace, jobId: JOB_ID });
  const storage = await resolveWorkspaceStorage({ dataRoot, workspace });
  const outside = join(root, 'outside-append-locks');
  await mkdir(outside);
  await symlink(outside, join(storage.directory, 'jobs', '.job-log-append-locks'), 'dir');
  await assert.rejects(appendJobLogEvent({ dataRoot, workspace, jobId: JOB_ID, event: 'direct lock failure' }), { code: 'JOB_LOG_APPEND_FAILED' });
  await sink.appendBlock('Sink lock failure', 'must not persist');
  assert.equal(sink.disabled, true);
  assert.equal(await readFile(sink.logFile, 'utf8'), '');
  assert.deepEqual(await readdir(outside), []);
}));

test('keeps concurrently appended jobs isolated', async () => withFixture(async ({ dataRoot, workspace }) => {
  const otherJobId = 'b'.repeat(64);
  const first = await createJobLogSink({ dataRoot, workspace, jobId: JOB_ID });
  const second = await createJobLogSink({ dataRoot, workspace, jobId: otherJobId });
  await Promise.all([first.appendEvent('only first'), second.appendEvent('only second')]);
  await Promise.all([first.close(), second.close()]);
  assert.match(await readFile(first.logFile, 'utf8'), /only first/);
  assert.doesNotMatch(await readFile(first.logFile, 'utf8'), /only second/);
  assert.match(await readFile(second.logFile, 'utf8'), /only second/);
  assert.doesNotMatch(await readFile(second.logFile, 'utf8'), /only first/);
}));

test('exposes and enforces explicit UTF-8 content bounds while preserving accepted block bodies', async () => withFixture(async ({ dataRoot, workspace }) => {
  assert.ok(MAX_JOB_LOG_EVENT_BYTES > 0);
  assert.ok(MAX_JOB_LOG_TITLE_BYTES > 0);
  assert.ok(MAX_JOB_LOG_BODY_BYTES > MAX_JOB_LOG_TITLE_BYTES);
  await createJobLogSink({ dataRoot, workspace, jobId: JOB_ID });
  await assert.rejects(appendJobLogEvent({ dataRoot, workspace, jobId: JOB_ID, event: 'x'.repeat(MAX_JOB_LOG_EVENT_BYTES + 1) }), { code: 'JOB_LOG_CONTENT_INVALID' });
  await assert.rejects(appendJobLogBlock({ dataRoot, workspace, jobId: JOB_ID, title: 'x'.repeat(MAX_JOB_LOG_TITLE_BYTES + 1), body: 'body' }), { code: 'JOB_LOG_CONTENT_INVALID' });
  await assert.rejects(appendJobLogBlock({ dataRoot, workspace, jobId: JOB_ID, title: 'title', body: 'x'.repeat(MAX_JOB_LOG_BODY_BYTES + 1) }), { code: 'JOB_LOG_CONTENT_INVALID' });

  const body = '  leading\n\tmiddle\ntrailing  ';
  await appendJobLogBlock({ dataRoot, workspace, jobId: JOB_ID, title: 'Safe', body });
  assert.match(await readFile(await resolveJobLogFile({ dataRoot, workspace, jobId: JOB_ID }), 'utf8'), /\] Safe\n {2}leading\n\tmiddle\ntrailing {2}\n$/);
}));

test('preserves every accepted block-body byte including CRLF, CR, and controls', async () => withFixture(async ({ dataRoot, workspace }) => {
  const sink = await createJobLogSink({ dataRoot, workspace, jobId: JOB_ID });
  const body = 'first\r\nsecond\rthird\u0000fourth';
  await sink.appendBlock('Exact body', body);
  await sink.close();
  const contents = await readFile(sink.logFile);
  const headerEnd = contents.indexOf(Buffer.from('Exact body\n')) + Buffer.byteLength('Exact body\n');
  assert.ok(headerEnd >= Buffer.byteLength('Exact body\n'));
  assert.deepEqual(contents.subarray(headerEnd), Buffer.from(`${body}\n`, 'utf8'));
}));

test('retries partial writes until complete event and block frames persist', async () => withFixture(async ({ dataRoot, workspace }) => {
  const sink = await createJobLogSink({ dataRoot, workspace, jobId: JOB_ID });
  const probe = await open(sink.logFile, constants.O_RDONLY);
  const prototype = Object.getPrototypeOf(probe);
  await probe.close();
  const originalWrite = prototype.write;
  let writeCalls = 0;
  prototype.write = async function partialWrite(buffer, offset = 0, length = buffer.byteLength - offset, position) {
    writeCalls += 1;
    return originalWrite.call(this, buffer, offset, Math.min(length, 7), position);
  };
  try {
    await sink.appendEvent('complete event frame');
    await sink.appendBlock('Complete block frame', 'complete\r\nbody\u0000bytes');
    await sink.close();
  } finally { prototype.write = originalWrite; }
  const contents = await readFile(sink.logFile, 'utf8');
  assert.ok(writeCalls > 2);
  assert.match(contents, /^\[.+Z\] complete event frame\n\n\[.+Z\] Complete block frame\n/u);
  assert.equal(contents.slice(contents.indexOf('complete\r\nbody')), 'complete\r\nbody\u0000bytes\n');
}));

test('zero-progress writes fail safely without reporting a persisted frame', async () => withFixture(async ({ dataRoot, workspace }) => {
  const sink = await createJobLogSink({ dataRoot, workspace, jobId: JOB_ID });
  const probe = await open(sink.logFile, constants.O_RDONLY);
  const prototype = Object.getPrototypeOf(probe);
  await probe.close();
  const originalWrite = prototype.write;
  prototype.write = async () => ({ bytesWritten: 0, buffer: Buffer.alloc(0) });
  try {
    await assert.rejects(appendJobLogEvent({ dataRoot, workspace, jobId: JOB_ID, event: 'direct zero progress' }), { code: 'JOB_LOG_APPEND_FAILED' });
    await sink.appendEvent('must not report persisted');
  }
  finally { prototype.write = originalWrite; }
  assert.equal(sink.disabled, true);
  assert.equal(await readFile(sink.logFile, 'utf8'), '');
}));

test('close atomically rejects later admission and drains only already accepted appends', async () => withFixture(async ({ dataRoot, workspace }) => {
  const sink = await createJobLogSink({ dataRoot, workspace, jobId: JOB_ID });
  const probe = await open(sink.logFile, constants.O_RDONLY);
  const prototype = Object.getPrototypeOf(probe);
  await probe.close();
  const originalSync = prototype.sync;
  let releaseSync;
  const syncRelease = new Promise((resolve) => { releaseSync = resolve; });
  let markSyncReached;
  const syncReached = new Promise((resolve) => { markSyncReached = resolve; });
  let held = false;
  prototype.sync = async function heldSync(...args) {
    if (!held) { held = true; markSyncReached(); await syncRelease; }
    return originalSync.call(this, ...args);
  };
  try {
    const accepted = sink.appendEvent('accepted before close');
    await syncReached;
    const closing = sink.close();
    const rejected = sink.appendEvent('rejected after close');
    releaseSync();
    await Promise.all([accepted, closing, rejected]);
  } finally { releaseSync(); prototype.sync = originalSync; }
  assert.equal(sink.disabled, true);
  const contents = await readFile(sink.logFile, 'utf8');
  assert.match(contents, /accepted before close/);
  assert.doesNotMatch(contents, /rejected after close/);
}));

test('a sink disables observationally after its file identity is replaced', async () => withFixture(async ({ dataRoot, workspace }) => {
  const sink = await createJobLogSink({ dataRoot, workspace, jobId: JOB_ID });
  const displaced = `${sink.logFile}.displaced`;
  await rename(sink.logFile, displaced);
  await writeFile(sink.logFile, 'replacement\n', { mode: 0o600 });
  await sink.appendEvent('must not reach either identity');
  assert.equal(sink.disabled, true);
  assert.equal(await readFile(sink.logFile, 'utf8'), 'replacement\n');
  assert.equal(await readFile(displaced, 'utf8'), '');
}));

test('direct block append revalidates identity after waiting for the cross-process lock', async () => withFixture(async ({ dataRoot, workspace }) => {
  const sink = await createJobLogSink({ dataRoot, workspace, jobId: JOB_ID });
  const storage = await resolveWorkspaceStorage({ dataRoot, workspace });
  const jobsRoot = join(storage.directory, 'jobs');
  const locksRoot = join(jobsRoot, '.job-log-append-locks');
  await ensurePrivateDirectoryWithin(jobsRoot, locksRoot);
  const lockPath = join(locksRoot, JOB_ID);
  const probe = await open(sink.logFile, constants.O_RDONLY);
  const prototype = Object.getPrototypeOf(probe);
  const logIdentity = await probe.stat({ bigint: true });
  await probe.close();
  const originalStat = prototype.stat;
  let logStatCalls = 0;
  let markAdmitted;
  const admitted = new Promise((resolve) => { markAdmitted = resolve; });
  prototype.stat = async function markAdmission(...args) {
    const info = await originalStat.call(this, ...args);
    if (BigInt(info.dev) === logIdentity.dev && BigInt(info.ino) === logIdentity.ino) logStatCalls += 1;
    if (logStatCalls === 3) markAdmitted();
    return info;
  };
  const displaced = `${sink.logFile}.block-admitted`;
  let observed; let settled = false; let settledWhileHeld;
  try {
    await withFileLock(lockPath, async () => {
      const append = appendJobLogBlock({ dataRoot, workspace, jobId: JOB_ID, title: 'Must not reach replacement', body: 'private selected body' });
      observed = append.then(() => ({ ok: true }), (error) => ({ ok: false, error })).finally(() => { settled = true; });
      await admitted;
      await new Promise((resolve) => setImmediate(resolve));
      settledWhileHeld = settled;
      if (!settled) {
        await rename(sink.logFile, displaced);
        await writeFile(sink.logFile, 'replacement\n', { mode: 0o600 });
      }
    });
    const outcome = await observed;
    assert.equal(settledWhileHeld, false);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.error.code, 'JOB_LOG_PATH_UNSAFE');
  } finally { prototype.stat = originalStat; }
  assert.equal(await readFile(sink.logFile, 'utf8'), 'replacement\n');
  const displacedContents = await readFile(displaced, 'utf8');
  assert.doesNotMatch(displacedContents, /Must not reach replacement/);
  assert.doesNotMatch(displacedContents, /private selected body/);
}));

test('a create failure returns a disabled non-throwing sink without a path', { skip: process.platform === 'win32' }, async () => withFixture(async ({ root, dataRoot, workspace }) => {
  const storage = await resolveWorkspaceStorage({ dataRoot, workspace });
  const outside = join(root, 'outside');
  await mkdir(outside);
  await symlink(outside, join(storage.directory, 'jobs'), 'dir');
  const sink = await createJobLogSink({ dataRoot, workspace, jobId: JOB_ID });
  assert.equal(sink.disabled, true);
  assert.equal(sink.logFile, undefined);
  await sink.appendEvent('ignored');
  await sink.appendBlock('ignored', 'ignored');
  await sink.flush();
  await sink.close();
  assert.deepEqual(await readdir(outside), []);
}));

test('failed unpublished-temp creation never deletes a foreign temp replacement', async () => withFixture(async ({ dataRoot, workspace }) => {
  const logFile = await resolveJobLogFile({ dataRoot, workspace, jobId: JOB_ID });
  const probe = await open(join(dirname(logFile), '.cleanup-probe'), 'w+', 0o600);
  const prototype = Object.getPrototypeOf(probe);
  await probe.close();
  const originalSync = prototype.sync;
  let replacementPath;
  prototype.sync = async function replaceUnpublishedTemp() {
    if (replacementPath === undefined) {
      const publicationDirectory = join(dirname(logFile), '.job-log-publication-locks', JOB_ID);
      const temporaryEntries = (await readdir(publicationDirectory)).filter((entry) => entry.endsWith('.tmp'));
      assert.equal(temporaryEntries.length, 1);
      replacementPath = join(publicationDirectory, temporaryEntries[0]);
      const displaced = `${replacementPath}.plugin-owned`;
      await rename(replacementPath, displaced);
      await writeFile(replacementPath, 'foreign temp replacement\n', { mode: 0o600 });
    }
    throw Object.assign(new Error('injected unpublished durability failure'), { code: 'EIO' });
  };
  try {
    await assert.rejects(createJobLog({ dataRoot, workspace, jobId: JOB_ID, title: 'Cleanup race' }), { code: 'JOB_LOG_CREATE_FAILED' });
  } finally { prototype.sync = originalSync; }
  assert.ok(replacementPath);
  assert.equal(await readFile(replacementPath, 'utf8'), 'foreign temp replacement\n');
}));

test('direct appends reject replacement races observed through handle identity', async () => withFixture(async ({ dataRoot, workspace }) => {
  const logFile = await createJobLog({ dataRoot, workspace, jobId: JOB_ID, title: 'Race' });
  const probe = await open(logFile, constants.O_RDONLY);
  const prototype = Object.getPrototypeOf(probe);
  await probe.close();
  const originalStat = prototype.stat;
  let calls = 0;
  prototype.stat = async function patchedStat(...args) {
    const info = await originalStat.call(this, ...args);
    calls += 1;
    if (calls === 3) return new Proxy(info, { get(target, property) { return property === 'ino' ? target.ino + (typeof target.ino === 'bigint' ? 1n : 1) : Reflect.get(target, property); } });
    return info;
  };
  try {
    await assert.rejects(appendJobLogEvent({ dataRoot, workspace, jobId: JOB_ID, event: 'raced' }), { code: 'JOB_LOG_PATH_UNSAFE' });
  } finally { prototype.stat = originalStat; }
  assert.doesNotMatch(await readFile(logFile, 'utf8'), /raced/);
}));
