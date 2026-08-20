// @ts-nocheck
import assert from 'node:assert/strict';
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

test('direct append rejects a valid private replacement installed after canonical admission', async () => withFixture(async ({ dataRoot, workspace }) => {
  const sink = await createJobLogSink({ dataRoot, workspace, jobId: JOB_ID });
  const probe = await open(sink.logFile, constants.O_RDONLY);
  const prototype = Object.getPrototypeOf(probe);
  await probe.close();
  const originalStat = prototype.stat;
  const originalSync = prototype.sync;
  let statCalls = 0;
  let releaseSync;
  const syncRelease = new Promise((resolve) => { releaseSync = resolve; });
  let markSyncReached;
  const syncReached = new Promise((resolve) => { markSyncReached = resolve; });
  let markAdmissionVerified;
  const admissionVerified = new Promise((resolve) => { markAdmissionVerified = resolve; });
  let held = false;
  prototype.stat = async function patchedStat(...args) {
    const info = await originalStat.call(this, ...args);
    statCalls += 1;
    if (statCalls === 6) markAdmissionVerified();
    return info;
  };
  prototype.sync = async function patchedSync(...args) {
    if (!held) {
      held = true;
      markSyncReached();
      await syncRelease;
    }
    return originalSync.call(this, ...args);
  };
  const displaced = `${sink.logFile}.admitted`;
  try {
    const blocker = sink.appendEvent('blocking append');
    await syncReached;
    const direct = appendJobLogEvent({ dataRoot, workspace, jobId: JOB_ID, event: 'must not reach replacement' });
    await admissionVerified;
    await rename(sink.logFile, displaced);
    await writeFile(sink.logFile, 'replacement\n', { mode: 0o600 });
    releaseSync();
    await blocker;
    await assert.rejects(direct, { code: 'JOB_LOG_PATH_UNSAFE' });
    assert.equal(sink.disabled, true);
    assert.equal(await readFile(sink.logFile, 'utf8'), 'replacement\n');
    assert.doesNotMatch(await readFile(displaced, 'utf8'), /must not reach replacement/);
  } finally {
    releaseSync();
    prototype.stat = originalStat;
    prototype.sync = originalSync;
  }
}));

test('direct block append rejects a valid private replacement installed after canonical admission', async () => withFixture(async ({ dataRoot, workspace }) => {
  const sink = await createJobLogSink({ dataRoot, workspace, jobId: JOB_ID });
  const probe = await open(sink.logFile, constants.O_RDONLY);
  const prototype = Object.getPrototypeOf(probe);
  await probe.close();
  const originalStat = prototype.stat;
  const originalSync = prototype.sync;
  let statCalls = 0;
  let releaseSync;
  const syncRelease = new Promise((resolve) => { releaseSync = resolve; });
  let markSyncReached;
  const syncReached = new Promise((resolve) => { markSyncReached = resolve; });
  let markAdmissionVerified;
  const admissionVerified = new Promise((resolve) => { markAdmissionVerified = resolve; });
  let held = false;
  prototype.stat = async function patchedStat(...args) {
    const info = await originalStat.call(this, ...args);
    statCalls += 1;
    if (statCalls === 6) markAdmissionVerified();
    return info;
  };
  prototype.sync = async function patchedSync(...args) {
    if (!held) {
      held = true;
      markSyncReached();
      await syncRelease;
    }
    return originalSync.call(this, ...args);
  };
  const displaced = `${sink.logFile}.block-admitted`;
  try {
    const blocker = sink.appendEvent('blocking block append');
    await syncReached;
    const direct = appendJobLogBlock({
      dataRoot,
      workspace,
      jobId: JOB_ID,
      title: 'Must not reach replacement',
      body: 'private selected body',
    });
    await admissionVerified;
    await rename(sink.logFile, displaced);
    await writeFile(sink.logFile, 'replacement\n', { mode: 0o600 });
    releaseSync();
    await blocker;
    await assert.rejects(direct, { code: 'JOB_LOG_PATH_UNSAFE' });
    assert.equal(sink.disabled, true);
    assert.equal(await readFile(sink.logFile, 'utf8'), 'replacement\n');
    const displacedContents = await readFile(displaced, 'utf8');
    assert.doesNotMatch(displacedContents, /Must not reach replacement/);
    assert.doesNotMatch(displacedContents, /private selected body/);
  } finally {
    releaseSync();
    prototype.stat = originalStat;
    prototype.sync = originalSync;
  }
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
      const jobsDirectory = dirname(logFile);
      const entries = await readdir(jobsDirectory);
      replacementPath = entries
        .filter((entry) => entry.includes(JOB_ID) && entry.endsWith('.tmp'))
        .map((entry) => join(jobsDirectory, entry))[0] ?? logFile;
      const displaced = `${replacementPath}.plugin-owned`;
      try { await rename(replacementPath, displaced); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
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
