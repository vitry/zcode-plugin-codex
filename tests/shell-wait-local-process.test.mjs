// @ts-nocheck
// Focused local-process observation tests (local-settlement Task 2; report
// §25.4/§25.8 frozen contract). OFFLINE research only: the real processes
// spawned here are HARMLESS LOCAL Node children under the OS temp directory
// (stand-in probe entries written by this file, plus the production launcher
// fast-fail envelope exactly like the closure suite's offline control). No
// Codex host, ZCode task, companion launch, or authenticated trial runs in
// this entry, it never imports another test entry, and it never signals any
// synthetic PID into the real OS (every synthetic identity goes through
// injected fake inspection seams). Selected ONLY through the shell-research
// suite (tools/run-test-suite.mjs).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { chmod, lstat, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import {
  captureEnvironment,
  closurePreloadSource,
  writeClosurePreload,
} from '../tools/shell-wait-probe/closure-observation.mjs';

// ---------------------------------------------------------------------------
// Isolation: every spawned child composes over an isolated base environment —
// the ambient identity variable is STRIPPED and every home/data-root variable
// is redirected into a disposable root, so no spawned child can reach the
// real user Codex home or carry the ambient identity (the closure suite's
// post-merge-review fix 1 discipline, mirrored locally because test entries
// never import other test entries).
// ---------------------------------------------------------------------------
const AMBIENT_IDENTITY_VARIABLES = Object.freeze(['CODEX_THREAD_ID']);

let sharedIsolatedEnvRoot = null;

/** This file's one disposable isolation root (created lazily, removed at exit). */
function isolatedEnvRoot() {
  if (sharedIsolatedEnvRoot === null) {
    sharedIsolatedEnvRoot = mkdtempSync(join(tmpdir(), 'shell-wait-local-process-env-'));
    process.once('exit', () => { try { rmSync(sharedIsolatedEnvRoot, { recursive: true, force: true }); } catch { /* best-effort disposal */ } });
  }
  return sharedIsolatedEnvRoot;
}

/** @param {string} [root] @returns {NodeJS.ProcessEnv} */
function isolatedBaseEnv(root = isolatedEnvRoot()) {
  const home = join(root, 'isolated-home');
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    CODEX_HOME: join(root, 'isolated-codex-home'),
    ZCODE_DATA_ROOT: join(root, 'isolated-data-root'),
    PLUGIN_DATA: join(root, 'isolated-plugin-data'),
    CLAUDE_PLUGIN_DATA: join(root, 'isolated-claude-plugin-data'),
  };
  for (const variable of AMBIENT_IDENTITY_VARIABLES) delete env[variable];
  // The ambient NODE_OPTIONS may carry presets from the surrounding suite
  // (e.g. the nested self-test's --require canary, which writes to stderr):
  // every spawned child must compose its capture NODE_OPTIONS from a CLEAN
  // base, so the child carries EXACTLY the fixture-generated preload and the
  // exact public stdout/stderr contracts stay meaningful.
  delete env.NODE_OPTIONS;
  return env;
}

/** Bounded spawned child (stdout/stderr captured up to 256 KiB for the delivery assertions). */
function spawnBounded(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdoutChunks = []; const stderrChunks = []; let bytes = 0;
    child.stdout.on('data', (chunk) => { bytes += chunk.length; if (bytes <= 256 * 1024) stdoutChunks.push(chunk); });
    child.stderr.on('data', (chunk) => { if (bytes <= 256 * 1024) stderrChunks.push(chunk); });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      const decoder = new TextDecoder('utf-8');
      resolve({ code, signal, stdout: decoder.decode(Buffer.concat(stdoutChunks)), stderr: decoder.decode(Buffer.concat(stderrChunks)), pid: child.pid });
    });
  });
}

/** Spawn without waiting for exit; resolves once the child pid is known. */
function spawnDetached(command, args, env) {
  const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.resume(); child.stderr.resume();
  return child;
}

/** Poll until the predicate holds or the bounded deadline passes. */
async function waitFor(predicate, deadlineMs = 2000) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

describe('local-process observation: generated startup identity record (task 2, §25.4 item 3)', async () => {
  const { mkdir } = await import('node:fs/promises');

  /**
   * One fresh disposable observation scope, composed exactly like the fixture
   * arms the seam: the fixture-generated preload written into the temp root,
   * a private 0700 capture directory, a fresh 64-hex nonce, and the composed
   * capture environment. The declared entry is a stand-in probe written by
   * THIS file (its realpath — macOS /var is a symlink), never the installed
   * launcher, unless a test explicitly passes the production launcher shape.
   */
  async function observationScope(t, { probeBody, brokerProbeBody } = {}) {
    const root = await mkdtemp(join(tmpdir(), 'shell-wait-local-process-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const captureDirectory = join(root, 'stdout-capture');
    await mkdir(captureDirectory, { mode: 0o700 });
    const nonce = randomBytes(32).toString('hex');
    const preload = await writeClosurePreload(root);
    let entryRealpath = null;
    let brokerEntryRealpath = null;
    if (probeBody !== undefined) {
      const probePath = join(root, 'probe-entry.mjs');
      await writeFile(probePath, probeBody, { mode: 0o700 });
      entryRealpath = await realpath(probePath);
    }
    if (brokerProbeBody !== undefined) {
      const brokerPath = join(root, 'broker-standin.mjs');
      await writeFile(brokerPath, brokerProbeBody, { mode: 0o700 });
      brokerEntryRealpath = await realpath(brokerPath);
    }
    const env = captureEnvironment({
      captureDirectory,
      nonce,
      entryRealpath: entryRealpath ?? join(root, 'undeclared-entry.mjs'),
      brokerEntryRealpath: brokerEntryRealpath ?? undefined,
      baseEnv: isolatedBaseEnv(root),
      nodeOptionsFragment: preload.nodeOptionsFragment,
    });
    return { root, captureDirectory, nonce, preload, env, entryRealpath, brokerEntryRealpath };
  }

  const holdProbeBody = [
    "import { writeFileSync } from 'node:fs';",
    "try { writeFileSync(process.env.HOLD_SENTINEL, String(Date.now())); } catch { }",
    "process.stdout.write('business-line\\n');",
    'await new Promise((resolve) => setTimeout(resolve, 600));',
    "process.stdout.write('final-line\\n');",
    '',
  ].join('\n');

  test('the gated invocation writes its startup identity record at preload install, before the entry body', async (t) => {
    const scope = await observationScope(t, { probeBody: holdProbeBody });
    const sentinel = join(scope.root, 'hold-sentinel');
    scope.env.HOLD_SENTINEL = sentinel;
    const child = spawnDetached(process.execPath, [scope.entryRealpath, 'invoke-prepared', 'rescue'], scope.env);
    t.after(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } });
    // The record must appear while the child is still STARTING (before the
    // entry body's sentinel write), i.e. created at preload install.
    const recordPath = join(scope.captureDirectory, `${scope.nonce}.identity.json`);
    const appeared = await waitFor(async () => {
      try { await lstat(recordPath); return true; } catch { return false; }
    });
    assert.equal(appeared, true, 'the nonce-keyed identity record appears while the child starts');
    const record = JSON.parse(await readFile(recordPath, 'utf8'));
    assert.deepEqual(Object.keys(record).sort(), ['argv', 'entryRealpath', 'firstWriteEpochMs', 'firstWritePreciseMs', 'nonce', 'pid', 'ppid', 'role', 'startOriginMs', 'version'],
      'the record is a closed bounded shape (version, role, nonce, entryRealpath, argv, pid, ppid, firstWriteEpochMs, precise generation instants)');
    assert.equal(record.version, 2);
    assert.equal(record.role, 'invocation');
    assert.equal(record.nonce, scope.nonce, 'the record binds the invocation scope nonce');
    assert.equal(record.entryRealpath, scope.entryRealpath);
    assert.deepEqual(record.argv, ['invoke-prepared', 'rescue'], 'the argv shape is the frozen terminal selector');
    assert.equal(record.pid, child.pid, 'the record carries the real child PID');
    assert.ok(Number.isSafeInteger(record.ppid) && record.ppid > 0, 'the record carries a positive parent PID');
    assert.ok(Number.isSafeInteger(record.firstWriteEpochMs) && record.firstWriteEpochMs > 0, 'the record carries its first-write instant');
    // Install-time creation proof, independent of parent polling speed: the
    // entry body stamps its own execution instant into the sentinel, and the
    // record's first-write instant must be at or before it (the preload runs
    // entirely before the entry module body).
    await waitFor(async () => lstat(sentinel).then(() => true, () => false));
    const entryBodyEpochMs = Number((await readFile(sentinel, 'utf8')).trim());
    assert.ok(Number.isSafeInteger(entryBodyEpochMs) && entryBodyEpochMs > 0, 'the entry body stamped its execution instant');
    assert.ok(record.firstWriteEpochMs <= entryBodyEpochMs,
      'the record was written at preload install, BEFORE the entry body executed');
  });

  test('the same gated run keeps the stdout-capture contract byte-identical: schema version 1, complete admission, exact business stdout', async (t) => {
    const scope = await observationScope(t, { probeBody: holdProbeBody });
    const outcome = await spawnBounded(process.execPath, [scope.entryRealpath, 'invoke-prepared', 'rescue'], scope.env);
    assert.equal(outcome.code, 0, 'the business exit code is preserved');
    assert.equal(outcome.stdout, 'business-line\nfinal-line\n', 'production stdout is unchanged by the identity extension');
    assert.equal(outcome.stderr, '');
    const { admitStdoutCapture } = await import('../tools/shell-wait-probe/closure-observation.mjs');
    const admission = await admitStdoutCapture({ captureDirectory: scope.captureDirectory, nonce: scope.nonce, expectedExitCode: 0 });
    assert.equal(admission.status, 'complete', 'the stdout capture stays complete with the identity record alongside');
    assert.equal(admission.closureObservationVersion, 1, 'the stdout-capture schema stays version 1 — the extension is additive');
    assert.equal(admission.stdout, 'business-line\nfinal-line\n');
    assert.equal(admission.byteCount, Buffer.byteLength('business-line\nfinal-line\n'));
    assert.equal(admission.truncated, false);
    assert.match(admission.captureSha256, /^[a-f0-9]{64}$/u);
    assert.equal(admission.verifiedDigest, admission.captureSha256);
    // The v1 meta shape is unchanged: no new field leaked into the meta.
    const metaRaw = JSON.parse(await readFile(join(scope.captureDirectory, `${scope.nonce}.meta.json`), 'utf8'));
    assert.deepEqual(Object.keys(metaRaw).sort(),
      ['argv', 'byteCount', 'captureSha256', 'durationMs', 'entryRealpath', 'exitCode', 'finalizations', 'finalizedBy', 'maxBytes', 'nonce', 'truncated', 'version', 'writesAfterFinalization'],
      'the exit meta keeps its exact closed v1 field set');
  });

  test('the preload stays inert on wrong argv, wrong entry, and absent capture environment: zero records', async (t) => {
    // Wrong argv (same entry, different subcommand shape).
    const wrongArgv = await observationScope(t, { probeBody: holdProbeBody });
    const wrongArgvOutcome = await spawnBounded(process.execPath, [wrongArgv.entryRealpath, 'role-status', 'rescue'], wrongArgv.env);
    assert.equal(wrongArgvOutcome.code, 0);
    assert.equal((await readdir(wrongArgv.captureDirectory)).length, 0, 'a non-declared argv installs NOTHING');

    // Wrong entry (declared entry differs from the executed file).
    const wrongEntry = await observationScope(t, { probeBody: holdProbeBody });
    const otherProbe = join(wrongEntry.root, 'other-entry.mjs');
    await writeFile(otherProbe, "process.stdout.write('other\\n');\n", { mode: 0o700 });
    const otherRealpath = await realpath(otherProbe);
    const wrongEntryOutcome = await spawnBounded(process.execPath, [otherRealpath, 'invoke-prepared', 'rescue'], wrongEntry.env);
    assert.equal(wrongEntryOutcome.code, 0);
    assert.equal(wrongEntryOutcome.stdout, 'other\n', 'the foreign entry still runs normally');
    assert.equal((await readdir(wrongEntry.captureDirectory)).length, 0, 'a non-declared entry installs NOTHING');

    // Capture environment absent entirely (plain node -e).
    const absent = await observationScope(t, { probeBody: holdProbeBody });
    const bare = { ...isolatedBaseEnv(absent.root) };
    const absentOutcome = await spawnBounded(process.execPath, ['-e', "process.stdout.write('bare\\n');"], bare);
    assert.equal(absentOutcome.code, 0);
    assert.equal((await readdir(absent.captureDirectory)).length, 0, 'no capture environment installs NOTHING');
  });

  test('the generated source gates the identity record on the same frozen selector and never imports research modules', () => {
    const source = closurePreloadSource();
    assert.ok(!source.includes('shell-wait-probe'), 'the preload source must never import the research modules');
    assert.ok(source.includes('invoke-prepared'), 'the frozen argv selector stays part of the generated gate');
    assert.ok(source.includes('.identity.json'), 'the invocation identity record file is part of the generated source');
    assert.ok(source.includes("'wx'"), 'every fixture-owned file is created exclusively (wx)');
  });
});

describe('local-process observation: startup identity record admission (task 2, §25.4 items 3/8)', async () => {
  const { mkdir } = await import('node:fs/promises');
  const { admitStartupIdentityRecord } = await import('../tools/shell-wait-probe/local-process-observation.mjs');

  /** One disposable capture directory with a real child-run record in it. */
  async function scopeWithRecord(t) {
    const root = await mkdtemp(join(tmpdir(), 'shell-wait-local-process-admit-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const captureDirectory = join(root, 'stdout-capture');
    await mkdir(captureDirectory, { mode: 0o700 });
    const nonce = randomBytes(32).toString('hex');
    const preload = await writeClosurePreload(root);
    const probePath = join(root, 'probe-entry.mjs');
    await writeFile(probePath, "process.stdout.write('x\\n');\n", { mode: 0o700 });
    const entryRealpath = await realpath(probePath);
    const env = captureEnvironment({
      captureDirectory, nonce, entryRealpath,
      baseEnv: isolatedBaseEnv(root), nodeOptionsFragment: preload.nodeOptionsFragment,
    });
    const outcome = await spawnBounded(process.execPath, [entryRealpath, 'invoke-prepared', 'rescue'], env);
    assert.equal(outcome.code, 0);
    return { root, captureDirectory, nonce, entryRealpath };
  }

  /** Fingerprint a directory's regular entries (names, sizes, modes) — the read-side write-freedom proof. */
  async function fingerprintDirectory(directory) {
    const names = (await readdir(directory)).sort();
    const entries = [];
    for (const name of names) {
      const stats = await lstat(join(directory, name));
      entries.push(`${name}:${stats.size}:${(stats.mode & 0o777).toString(8)}`);
    }
    return entries.join('|');
  }

  test('a real gated run admits an established startup identity bound to nonce, entry, argv and the child PID', async (t) => {
    const scope = await scopeWithRecord(t);
    const admission = await admitStartupIdentityRecord({ captureDirectory: scope.captureDirectory, nonce: scope.nonce });
    assert.equal(admission.localProcessObservationVersion, 1);
    assert.equal(admission.class, 'startup-identity');
    assert.equal(admission.status, 'established');
    assert.equal(admission.reason, null);
    assert.deepEqual(Object.keys(admission.identity).sort(),
      ['argv', 'entryRealpath', 'firstWriteEpochMs', 'firstWritePreciseMs', 'nonce', 'pid', 'ppid', 'role', 'startOriginMs'],
      'the admitted identity projection carries exactly the closed record facts');
    assert.equal(admission.identity.role, 'invocation');
    assert.equal(admission.identity.nonce, scope.nonce);
    assert.equal(admission.identity.entryRealpath, scope.entryRealpath);
    assert.deepEqual(admission.identity.argv, ['invoke-prepared', 'rescue']);
    assert.ok(Number.isSafeInteger(admission.identity.pid) && admission.identity.pid > 0);
    assert.ok(Number.isSafeInteger(admission.identity.ppid) && admission.identity.ppid > 0);
    assert.ok(Number.isSafeInteger(admission.identity.firstWriteEpochMs) && admission.identity.firstWriteEpochMs > 0);
    assert.ok(Number.isFinite(admission.identity.startOriginMs) && admission.identity.startOriginMs > 0, 'the precise process start is admitted');
    assert.ok(admission.identity.firstWritePreciseMs >= admission.identity.startOriginMs, 'the precise write postdates the precise start');
    assert.ok(Number.isSafeInteger(admission.readEpochMs) && admission.readEpochMs > 0, 'the admission stamps its read instant');
    // A fake clock is accepted so offline tests stay deterministic.
    const stamped = await admitStartupIdentityRecord({ captureDirectory: scope.captureDirectory, nonce: scope.nonce, nowEpochMs: 1234 });
    assert.equal(stamped.readEpochMs, 1234, 'the read instant accepts the caller-supplied clock');
  });

  test('a missing record is the NAMED missing fact — never "never launched" and never launch readiness', async (t) => {
    const scope = await scopeWithRecord(t);
    const foreign = await admitStartupIdentityRecord({ captureDirectory: scope.captureDirectory, nonce: randomBytes(32).toString('hex') });
    assert.equal(foreign.status, 'missing');
    assert.equal(foreign.reason, 'identity-record-missing');
    assert.equal(foreign.identity, null);
    assert.match(foreign.reason, /missing/u);
    assert.ok(!JSON.stringify(foreign).match(/never-launched|not-launched|launch-verified/u),
      'no vocabulary claims the invocation never launched or verified a launch');
  });

  test('torn, shape-invalid, foreign-nonce and oversize records are named invalid exposing no identity', async (t) => {
    const torn = await scopeWithRecord(t);
    const recordPath = join(torn.captureDirectory, `${torn.nonce}.identity.json`);
    const original = await readFile(recordPath, 'utf8');
    await writeFile(recordPath, original.slice(0, Math.floor(original.length / 2)), { mode: 0o600 });
    const tornVerdict = await admitStartupIdentityRecord({ captureDirectory: torn.captureDirectory, nonce: torn.nonce });
    assert.equal(tornVerdict.status, 'invalid');
    assert.equal(tornVerdict.reason, 'identity-record-torn');
    assert.equal(tornVerdict.identity, null);

    const shape = await scopeWithRecord(t);
    const shapePath = join(shape.captureDirectory, `${shape.nonce}.identity.json`);
    const record = JSON.parse(await readFile(shapePath, 'utf8'));
    record.unexpectedField = 1;
    await writeFile(shapePath, JSON.stringify(record) + '\n', { mode: 0o600 });
    const shapeVerdict = await admitStartupIdentityRecord({ captureDirectory: shape.captureDirectory, nonce: shape.nonce });
    assert.equal(shapeVerdict.status, 'invalid');
    assert.equal(shapeVerdict.reason, 'identity-record-shape-invalid');

    const foreignNonce = await scopeWithRecord(t);
    const foreignPath = join(foreignNonce.captureDirectory, `${foreignNonce.nonce}.identity.json`);
    const foreignRecord = JSON.parse(await readFile(foreignPath, 'utf8'));
    foreignRecord.nonce = 'b'.repeat(64);
    await writeFile(foreignPath, JSON.stringify(foreignRecord) + '\n', { mode: 0o600 });
    const foreignVerdict = await admitStartupIdentityRecord({ captureDirectory: foreignNonce.captureDirectory, nonce: foreignNonce.nonce });
    assert.equal(foreignVerdict.status, 'invalid');
    assert.equal(foreignVerdict.reason, 'identity-record-nonce-mismatch', 'a record of another scope never attests this scope');

    const oversize = await scopeWithRecord(t);
    const oversizePath = join(oversize.captureDirectory, `${oversize.nonce}.identity.json`);
    await writeFile(oversizePath, JSON.stringify({ padding: 'x'.repeat(8 * 1024) }) + '\n', { mode: 0o600 });
    const oversizeVerdict = await admitStartupIdentityRecord({ captureDirectory: oversize.captureDirectory, nonce: oversize.nonce });
    assert.equal(oversizeVerdict.status, 'invalid');
    assert.equal(oversizeVerdict.reason, 'identity-record-oversize');
  });

  test('non-regular records, permission failures and entry mismatches stay named and unestablished', async (t) => {
    const symlinked = await scopeWithRecord(t);
    const recordPath = join(symlinked.captureDirectory, `${symlinked.nonce}.identity.json`);
    const outside = join(symlinked.root, 'outside-target.txt');
    await writeFile(outside, 'harmless', { mode: 0o600 });
    await rename(recordPath, `${recordPath}.real`);
    await symlink(outside, recordPath);
    const symlinkVerdict = await admitStartupIdentityRecord({ captureDirectory: symlinked.captureDirectory, nonce: symlinked.nonce });
    assert.equal(symlinkVerdict.status, 'invalid');
    assert.equal(symlinkVerdict.reason, 'identity-record-not-regular');

    const unreadable = await scopeWithRecord(t);
    const unreadablePath = join(unreadable.captureDirectory, `${unreadable.nonce}.identity.json`);
    await chmod(unreadablePath, 0o000);
    t.after(() => chmod(unreadablePath, 0o600).catch(() => {}));
    const unreadableVerdict = await admitStartupIdentityRecord({ captureDirectory: unreadable.captureDirectory, nonce: unreadable.nonce });
    assert.equal(unreadableVerdict.status, 'invalid');
    assert.equal(unreadableVerdict.reason, 'identity-record-unreadable');
    await chmod(unreadablePath, 0o600);

    const entry = await scopeWithRecord(t);
    const entryVerdict = await admitStartupIdentityRecord({
      captureDirectory: entry.captureDirectory, nonce: entry.nonce,
      expectedEntryRealpath: join(entry.root, 'a-different-declared-entry.mjs'),
    });
    assert.equal(entryVerdict.status, 'invalid');
    assert.equal(entryVerdict.reason, 'entry-realpath-mismatch', 'the record binds the declared entry realpath');
  });

  test('admission timestamps are honest: the read instant is sampled after the I/O completes, with its start recorded', async (t) => {
    const scope = await scopeWithRecord(t);
    const before = Date.now();
    const admission = await admitStartupIdentityRecord({ captureDirectory: scope.captureDirectory, nonce: scope.nonce });
    const after = Date.now();
    assert.equal(admission.status, 'established');
    // The interval start is sampled when the admission BEGINS, before any
    // I/O; the read instant is its completion — a record created during the
    // awaits can never be reported as observed before its own creation, and
    // a read completing after a cutoff carries a post-cutoff timestamp.
    assert.ok(Number.isSafeInteger(admission.readStartedEpochMs) && admission.readStartedEpochMs <= before + 10,
      'the started sample precedes the admission I/O');
    assert.ok(admission.readEpochMs >= admission.readStartedEpochMs, 'completion is at or after the start');
    assert.ok(admission.readEpochMs >= after - 10, 'the read instant is the completion of the actual I/O');
    // An explicit fake clock pins BOTH interval ends deterministically.
    const stamped = await admitStartupIdentityRecord({ captureDirectory: scope.captureDirectory, nonce: scope.nonce, nowEpochMs: 4321 });
    assert.equal(stamped.readStartedEpochMs, 4321);
    assert.equal(stamped.readEpochMs, 4321);
    // The missing-record verdict carries the same honest interval.
    const missing = await admitStartupIdentityRecord({ captureDirectory: scope.captureDirectory, nonce: randomBytes(32).toString('hex') });
    assert.equal(missing.status, 'missing');
    assert.ok(Number.isSafeInteger(missing.readStartedEpochMs) && Number.isSafeInteger(missing.readEpochMs));
  });

  test('the admission completion instant covers the bounded record read on every read path (injected seam)', async (t) => {
    const scope = await scopeWithRecord(t);
    const validRecord = JSON.parse(await readFile(join(scope.captureDirectory, `${scope.nonce}.identity.json`), 'utf8'));
    // Class sweep (timestamp honesty): the admission's awaited evidence work
    // is the bounded record read — the completion instant must postdate it
    // on BOTH the established and the invalid (torn) path.
    const before = Date.now();
    const established = await admitStartupIdentityRecord({
      captureDirectory: scope.captureDirectory, nonce: scope.nonce,
      readRecordFile: async () => {
        await new Promise((resolve) => setTimeout(resolve, 40));
        return validRecord;
      },
    });
    assert.equal(established.status, 'established');
    assert.ok(established.readStartedEpochMs <= before + 10, 'the started sample precedes the admission I/O');
    assert.ok(established.readEpochMs >= before + 35, 'the established completion covers the bounded read await');
    const torn = await admitStartupIdentityRecord({
      captureDirectory: scope.captureDirectory, nonce: scope.nonce,
      readRecordFile: async () => {
        await new Promise((resolve) => setTimeout(resolve, 40));
        throw new SyntaxError('unexpected end of JSON input');
      },
    });
    assert.equal(torn.status, 'invalid');
    assert.equal(torn.reason, 'identity-record-torn');
    assert.ok(torn.readEpochMs >= before + 80, 'the invalid completion also covers the bounded read await');
    assert.ok(torn.readEpochMs >= torn.readStartedEpochMs);
  });

  test('an unsearchable capture directory is the named unreadable verdict, never a rejected observation', async (t) => {
    const scope = await scopeWithRecord(t);
    // An unsearchable ANCESTOR of the record (the capture directory itself)
    // makes the initial lstat fail with EACCES: the admission must convert
    // that inspection failure into its named verdict — the observation
    // operation never rejects and never fabricates an identity.
    await chmod(scope.captureDirectory, 0o000);
    t.after(() => chmod(scope.captureDirectory, 0o700).catch(() => {}));
    const verdict = await admitStartupIdentityRecord({ captureDirectory: scope.captureDirectory, nonce: scope.nonce });
    await chmod(scope.captureDirectory, 0o700);
    assert.equal(verdict.status, 'invalid');
    assert.equal(verdict.reason, 'identity-record-unreadable', 'the fs inspection failure is the named fact');
    assert.equal(verdict.identity, null);
    assert.ok(Number.isSafeInteger(verdict.readEpochMs), 'the named verdict still carries its honest interval');
  });

  test('the admission performs no writes: the capture directory fingerprints identically before and after', async (t) => {
    const scope = await scopeWithRecord(t);
    const before = await fingerprintDirectory(scope.captureDirectory);
    await admitStartupIdentityRecord({ captureDirectory: scope.captureDirectory, nonce: scope.nonce });
    await admitStartupIdentityRecord({ captureDirectory: scope.captureDirectory, nonce: randomBytes(32).toString('hex') });
    assert.equal(await fingerprintDirectory(scope.captureDirectory), before,
      'the read-side admission is purely observational — no file appears, changes mode, or changes size');
  });

  test('option validation fails before any read', async (t) => {
    const scope = await scopeWithRecord(t);
    await assert.rejects(() => admitStartupIdentityRecord({ captureDirectory: 'relative-dir', nonce: scope.nonce }), /absolute/u);
    await assert.rejects(() => admitStartupIdentityRecord({ captureDirectory: scope.captureDirectory, nonce: 'short' }), /64-hex/u);
    await assert.rejects(() => admitStartupIdentityRecord({ captureDirectory: scope.captureDirectory, nonce: scope.nonce, role: 'unknown-role' }), /role/u);
    await assert.rejects(() => admitStartupIdentityRecord(null), /object/u);
  });
});

describe('local-process observation: OS-verified live identity and exit/absence (task 2, §25.4 items 4/5/6)', async () => {
  const { mkdir } = await import('node:fs/promises');
  const { admitStartupIdentityRecord, adjudicateLocalExit, observeLocalProcess } = await import('../tools/shell-wait-probe/local-process-observation.mjs');
  const { admitStdoutCapture } = await import('../tools/shell-wait-probe/closure-observation.mjs');

  /**
   * Scope + gated real child that holds briefly. The test owns the child; the
   * cleanup hook kills it only if the assertion path left it running.
   */
  async function scopeWithLiveChild(t, { probeTail = '' } = {}) {
    const root = await mkdtemp(join(tmpdir(), 'shell-wait-local-process-live-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const captureDirectory = join(root, 'stdout-capture');
    await mkdir(captureDirectory, { mode: 0o700 });
    const nonce = randomBytes(32).toString('hex');
    const preload = await writeClosurePreload(root);
    const probePath = join(root, 'probe-entry.mjs');
    const body = [
      "process.stdout.write('held\\n');",
      'await new Promise((resolve) => setTimeout(resolve, 700));',
      probeTail,
      '',
    ].join('\n');
    await writeFile(probePath, body, { mode: 0o700 });
    const entryRealpath = await realpath(probePath);
    const env = captureEnvironment({
      captureDirectory, nonce, entryRealpath,
      baseEnv: isolatedBaseEnv(root), nodeOptionsFragment: preload.nodeOptionsFragment,
    });
    const child = spawn(process.execPath, [entryRealpath, 'invoke-prepared', 'rescue'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const exited = new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })));
    t.after(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } });
    // The install-time identity record is the scope's readiness fact: every
    // observation below happens only after the preload has installed.
    const recordPath = join(captureDirectory, `${nonce}.identity.json`);
    assert.equal(await waitFor(async () => lstat(recordPath).then(() => true, () => false)), true,
      'the startup identity record appears at preload install');
    return { root, captureDirectory, nonce, entryRealpath, env, child, exited };
  }

  test('a live gated child is OS-verified with pid, start identity and the capture nonce while alive', async (t) => {
    const scope = await scopeWithLiveChild(t);
    const verdict = await observeLocalProcess({ pid: scope.child.pid, nonce: scope.nonce, nowEpochMs: undefined });
    assert.equal(verdict.localProcessObservationVersion, 1);
    assert.equal(verdict.class, 'os-live-observation');
    assert.equal(verdict.status, 'established', 'the double read verifies the live gated child through the real OS');
    assert.equal(verdict.reason, null);
    assert.equal(verdict.observation.pid, scope.child.pid);
    assert.equal(verdict.observation.ppid, process.pid, 'the child is this test process\'s direct child while alive');
    assert.ok(typeof verdict.observation.startIdentity === 'string' && verdict.observation.startIdentity.length > 0,
      'the OS start identity is captured verbatim');
    assert.equal(verdict.observation.nonce, scope.nonce);
    assert.ok(Number.isSafeInteger(verdict.readEpochMs) && verdict.readEpochMs > 0);
    assert.equal(verdict.observation.ppidChangedFromCapture, null, 'no captured ppid was supplied');
  });

  test('after the child exits the same read reports the named absent fact', async (t) => {
    const scope = await scopeWithLiveChild(t);
    const live = await observeLocalProcess({ pid: scope.child.pid, nonce: scope.nonce });
    assert.equal(live.status, 'established');
    await scope.exited;
    const gone = await observeLocalProcess({ pid: scope.child.pid, nonce: scope.nonce, expectedStartIdentity: live.observation.startIdentity });
    assert.equal(gone.status, 'absent', 'the OS reports no such process after the verified exit');
    assert.equal(gone.reason, 'process-absent');
    assert.equal(gone.absenceConfirmed, true, 'the real default seam CONFIRMS the absence against the OS');
    assert.equal(gone.observation, null);
    assert.ok(Number.isSafeInteger(gone.readEpochMs) && gone.readEpochMs >= live.readEpochMs);
  });

  test('observation timestamps are honest: the read instant is the COMPLETION instant, not the pre-await sample (injected seam)', async () => {
    // Real inspection performs multiple asynchronous OS reads; the stamped
    // instant must be when the read COMPLETED so a disappearance timestamp
    // can never credit evidence collected before the read that produced it.
    const before = Date.now();
    const verdict = await observeLocalProcess({
      pid: 4_194_303, nonce: 'a'.repeat(64),
      inspect: async () => {
        await new Promise((resolve) => setTimeout(resolve, 40));
        return undefined;
      },
    });
    assert.equal(verdict.status, 'absent');
    assert.ok(Number.isSafeInteger(verdict.readStartedEpochMs) && verdict.readStartedEpochMs >= before,
      'the started sample is taken when the read begins');
    assert.ok(verdict.readStartedEpochMs <= before + 10, 'the started sample precedes the inspection await');
    assert.ok(verdict.readEpochMs >= before + 35,
      'the read instant is the COMPLETION instant — it includes the whole asynchronous inspection');
    assert.ok(verdict.readEpochMs >= verdict.readStartedEpochMs, 'completion is at or after the start');
    // An explicit fake clock pins BOTH interval ends deterministically.
    const stamped = await observeLocalProcess({ pid: 4_194_303, nonce: 'a'.repeat(64), nowEpochMs: 5000, inspect: async () => undefined });
    assert.equal(stamped.readStartedEpochMs, 5000);
    assert.equal(stamped.readEpochMs, 5000);
  });

  test('positive absence requires OS confirmation: unconfirmed reads stay named-unestablished (injected seams)', async () => {
    // An ambiguous inspection (diagnostic failure, lost signal race) returns
    // undefined like a real exit does — it must NEVER become positive
    // absence on its own.
    const unconfirmed = await observeLocalProcess({
      pid: 4_194_303, nonce: 'a'.repeat(64),
      inspect: async () => undefined,
      absenceConfirmation: async () => 'unconfirmed',
    });
    assert.equal(unconfirmed.status, 'unestablished', 'a failed/ambiguous OS read stays unestablished — never disappearance');
    assert.equal(unconfirmed.reason, 'absence-unconfirmed');
    assert.equal(unconfirmed.observation, null);
    // A CONFIRMED absence is the positive fact, and the verdict carries the
    // confirmation basis explicitly.
    const confirmed = await observeLocalProcess({
      pid: 4_194_303, nonce: 'a'.repeat(64),
      inspect: async () => undefined,
      absenceConfirmation: async () => 'absent',
    });
    assert.equal(confirmed.status, 'absent');
    assert.equal(confirmed.reason, 'process-absent');
    assert.equal(confirmed.absenceConfirmed, true, 'the absence verdict records that the OS confirmed it');
    // An injected seam without a confirmation dependency owns its absence
    // semantics (synthetic identities never touch the real OS).
    const injected = await observeLocalProcess({ pid: 4_194_303, nonce: 'a'.repeat(64), inspect: async () => undefined });
    assert.equal(injected.status, 'absent');
    assert.equal(injected.absenceConfirmed, null, 'the injected seam\'s absence semantics are its own — no confirmation claim');
  });

  test('the completion instant covers the absence confirmation await on every path (injected seams)', async () => {
    // Class sweep (timestamp honesty): EVERY awaited evidence step precedes
    // the completion sample. An absence whose CONFIRMATION takes real time
    // must be stamped after that confirmation — never before it began.
    const before = Date.now();
    const verdict = await observeLocalProcess({
      pid: 4_194_303, nonce: 'a'.repeat(64),
      inspect: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return undefined;
      },
      absenceConfirmation: async () => {
        await new Promise((resolve) => setTimeout(resolve, 60));
        return 'absent';
      },
    });
    assert.equal(verdict.status, 'absent');
    assert.equal(verdict.absenceConfirmed, true);
    assert.ok(verdict.readStartedEpochMs <= before + 10, 'the started sample precedes the inspection');
    assert.ok(verdict.readEpochMs >= before + 70,
      'the completion instant includes the inspection AND the whole confirmation await');
    // The same rule on the ESTABLISHED path: the completion covers the
    // inspection await.
    const established = await observeLocalProcess({
      pid: 4_194_303, nonce: 'a'.repeat(64),
      inspect: async () => {
        await new Promise((resolve) => setTimeout(resolve, 40));
        return { pid: 4_194_303, ppid: 4_194_302, startIdentity: 'S1', nonce: 'a'.repeat(64) };
      },
    });
    assert.equal(established.status, 'established');
    assert.ok(established.readEpochMs >= before + 70 + 30,
      'the established completion covers its own inspection await');
  });

  test('a failed liveness read and a mid-read identity change are named unestablished facts (injected seams)', async () => {
    const failed = await observeLocalProcess({ pid: 4_194_303, nonce: 'a'.repeat(64), inspect: async () => { throw new Error('ps exited nonzero'); } });
    assert.equal(failed.status, 'unestablished');
    assert.equal(failed.reason, 'liveness-read-failed');
    assert.equal(failed.observation, null);

    const changed = await observeLocalProcess({
      pid: 4_194_303, nonce: 'a'.repeat(64),
      inspect: async () => { throw new Error('the exact fake-ZCode process identity changed'); },
    });
    assert.equal(changed.status, 'unestablished');
    // ROUND-23: the mid-read identity change is POSITIVE replacement
    // evidence (its own named class consumed by the reuse latch) — the old
    // `identity-changed-during-read` label folded it into the generic torn
    // class where a later absence could credit the successor's disappearance
    // to the original generation.
    assert.equal(changed.reason, 'start-identity-generation-changed', 'a race between the double reads is positive reuse evidence, named and latched');
    assert.equal(changed.observation, null);
  });

  test('a reused start identity is never accepted as the captured generation (injected seam)', async () => {
    const reused = await observeLocalProcess({
      pid: 4_194_303, nonce: 'a'.repeat(64), expectedStartIdentity: 'Thu Jan  1 00:00:00 2026',
      inspect: async () => ({ pid: 4_194_303, ppid: 4_194_302, startIdentity: 'Fri Jan  2 00:00:00 2026', nonce: 'a'.repeat(64) }),
    });
    assert.equal(reused.status, 'unestablished');
    assert.equal(reused.reason, 'start-identity-generation-changed', 'a different start identity is a DIFFERENT process');
    assert.equal(reused.observation, null, 'no observation is exposed for a foreign generation');
  });

  test('a changed parent is recorded, never treated as death: established with ppidChangedFromCapture (injected seam)', async () => {
    // An unchanged parent records the negative fact explicitly.
    const matching = await observeLocalProcess({
      pid: 4_194_303, nonce: 'a'.repeat(64), capturedPpid: 4_194_302,
      inspect: async () => ({ pid: 4_194_303, ppid: 4_194_302, startIdentity: 'S1', nonce: 'a'.repeat(64) }),
    });
    assert.equal(matching.status, 'established');
    assert.equal(matching.observation.ppidChangedFromCapture, false, 'the unchanged parent is the recorded negative fact');
    // A reparented live process stays ESTABLISHED: the changed parent is the
    // recorded observation fact (reparenting never destroys an already
    // captured start identity), never an invalidation, never death.
    const reparented = await observeLocalProcess({
      pid: 4_194_303, nonce: 'a'.repeat(64), capturedPpid: 4_194_302,
      inspect: async () => ({ pid: 4_194_303, ppid: 1, startIdentity: 'S1', nonce: 'a'.repeat(64) }),
    });
    assert.equal(reparented.status, 'established', 'a changed parent NEVER invalidates the observation');
    assert.equal(reparented.observation.ppid, 1, 'the current (post-reparenting) parent is what the observation records');
    assert.equal(reparented.observation.ppidChangedFromCapture, true, 'the reparenting is RECORDED on the public verdict field');
    assert.equal(reparented.observation.startIdentity, 'S1', 'the captured start identity stands through the reparenting');
  });

  test('absence confirmation is platform-injected: the Linux branch never touches the host OS', async () => {
    const { confirmProcessAbsenceWithOs } = await import('../tools/shell-wait-probe/local-process-observation.mjs');
    // The Linux branch, exercised through INJECTED seams only (platform +
    // filesystem) — it must behave identically on ANY host, so the
    // registered shell-research suite cannot break on a Linux runner.
    const linuxEnoent = await confirmProcessAbsenceWithOs(4_194_303, undefined, {
      platform: 'linux',
      readFile: async () => { const error = new Error('EACCES'); /** @type {any} */ (error).code = 'ENOENT'; throw error; },
    });
    assert.equal(linuxEnoent, 'absent', 'the exact ENOENT confirms absence on the injected Linux platform');
    const linuxEacces = await confirmProcessAbsenceWithOs(4_194_303, undefined, {
      platform: 'linux',
      readFile: async () => { const error = new Error('EACCES'); /** @type {any} */ (error).code = 'EACCES'; throw error; },
    });
    assert.equal(linuxEacces, 'unconfirmed', 'a permission failure stays unconfirmed');
    const linuxExists = await confirmProcessAbsenceWithOs(4_194_303, undefined, {
      platform: 'linux',
      readFile: async () => '5049 (node) S 1',
    });
    assert.equal(linuxExists, 'unconfirmed', 'a readable /proc entry means the process exists — never absence');
    // The darwin branch is likewise platform-pinned for synthetic pids.
    const darwinPinned = await confirmProcessAbsenceWithOs(4_194_303, async () => ({ code: 1, stdout: '', stderr: '' }), { platform: 'darwin' });
    assert.equal(darwinPinned, 'absent', 'the injected darwin platform exercises the ps strictness');
  });

  test('every ps identity query spawns with a PINNED UTC C-locale env — the real darwin reader binds on any host locale', async () => {
    // Round-32 finding 1: TZ=UTC alone does not pin ps's date FORMATTING —
    // under a non-C locale (LC_ALL=fr_FR.UTF-8) lstart renders localized
    // month/day names and ordering, which the strict UTC field parse rejects
    // (null start instant) and darwin duties could never establish on that
    // host. Every ps identity query pins LC_ALL=C alongside TZ=UTC, audited
    // through the injected runProcess seam (the REAL reader's invocation and
    // parse run on the captured launch).
    const { observeLocalProcess } = await import('../tools/shell-wait-probe/local-process-observation.mjs');
    /** @type {{ launch: any, options: any }[]} */
    const spawns = [];
    const runProcess = async (/** @type {any} */ launch, /** @type {any} */ options) => {
      spawns.push({ launch, options });
      return { code: 0, stdout: '  4194303   4000 Sun Nov  2 01:30:00 2025\n', stderr: '' };
    };
    const nonce = 'b'.repeat(64);
    // The seams ride the INPUT osSeams (the module-level seam discipline):
    // the platform seam reaches the start-instant resolution too, so the
    // resolved start instant is asserted on ANY host (the round-32 finding-2
    // discipline).
    const observation = await observeLocalProcess({
      pid: 4_194_303, nonce,
      osSeams: { platform: 'darwin', runProcess, environ: 'present' },
    });
    assert.equal(observation.status, 'established', 'the C-locale shape parses and the observation establishes');
    assert.ok(spawns.length >= 2, 'the double-read performed its ps queries through the injected seam');
    for (const spawn of spawns) {
      assert.equal(spawn.launch.command, 'ps');
      assert.equal(spawn.options.env.TZ, 'UTC', 'the lstart rendering is pinned to UTC');
      assert.equal(spawn.options.env.LC_ALL, 'C', 'the date formatting is pinned to the C locale');
    }
    assert.equal(observation.observation.startInstantEpochMs, Date.UTC(2025, 10, 2, 1, 30, 0),
      'the C-locale-rendered lstart resolves field-explicit UTC');
  });

  test('macOS absence confirmation requires an error-free no-match: diagnostic failures stay unconfirmed', async () => {
    const { confirmProcessAbsenceWithOs } = await import('../tools/shell-wait-probe/local-process-observation.mjs');
    /** @param {number} code @param {string} stdout @param {string} stderr */
    const psResult = (code, stdout, stderr) => async () => ({ code, stdout, stderr });
    // The TRUE macOS no-match (measured on this host): exit 1, empty stdout,
    // and an ERROR-FREE (empty) stderr — a failed query carries diagnostics.
    const trueNoMatch = await confirmProcessAbsenceWithOs(4_194_303, psResult(1, '', ''), { platform: 'darwin' });
    assert.equal(trueNoMatch, 'absent', 'the error-free no-match confirms absence');
    // Any stderr diagnostic (usage error, pid-limit message, permission
    // failure) or any other exit code is a FAILED query — never a
    // confirmation.
    for (const [label, result] of [
      ['a pid-limit diagnostic', psResult(1, '', 'ps: process id too large: 40123\n')],
      ['a usage-error diagnostic', psResult(1, '', 'ps: illegal option -- x\nusage: ps [-AaCcEefhjlMmrSTvwXx]\n')],
      ['an unexpected nonzero code with no diagnostics', psResult(3, '', '')],
      ['a process that appeared mid-confirmation', psResult(0, '  4194303\n', '')],
    ]) {
      const verdict = await confirmProcessAbsenceWithOs(4_194_303, /** @type {any} */ (result), { platform: 'darwin' });
      assert.equal(verdict, 'unconfirmed', `${label} must never confirm absence`);
    }
  });

  test('input validation fails before any read', async () => {
    await assert.rejects(() => observeLocalProcess({ pid: 0, nonce: 'a'.repeat(64) }), /pid/u);
    await assert.rejects(() => observeLocalProcess({ pid: 4_194_303, nonce: 'nothex' }), /64-hex/u);
    await assert.rejects(() => observeLocalProcess({ pid: 4_194_303, nonce: 'a'.repeat(64), nowEpochMs: -1 }), /epoch/u);
    assert.throws(() => adjudicateLocalExit({ presence: { class: 'startup-identity' }, absenceReads: [] }), /os-live-observation/u);
    assert.throws(() => adjudicateLocalExit({ presence: null, absenceReads: 'not-a-list' }), /absence/u);
  });

  test('natural exit: verified presence earlier plus verified absence later is the named disappeared fact, corroborated by the exit meta', async (t) => {
    const scope = await scopeWithLiveChild(t);
    const recordAdmission = await admitStartupIdentityRecord({ captureDirectory: scope.captureDirectory, nonce: scope.nonce });
    assert.equal(recordAdmission.status, 'established', 'the startup record was captured while the child started');
    const live = await observeLocalProcess({ pid: scope.child.pid, nonce: scope.nonce });
    assert.equal(live.status, 'established');
    // The OS-verified identity joins the startup record: same pid, same nonce.
    assert.equal(live.observation.pid, recordAdmission.identity.pid);
    await scope.exited;
    assert.equal(scope.child.exitCode, 0, 'a natural exit with code 0');
    const gone = await observeLocalProcess({ pid: scope.child.pid, nonce: scope.nonce });
    assert.equal(gone.status, 'absent');
    const stdoutAdmission = await admitStdoutCapture({ captureDirectory: scope.captureDirectory, nonce: scope.nonce, expectedExitCode: 0 });
    assert.equal(stdoutAdmission.status, 'complete', 'a natural exit completes the capture pair');
    const exit = await adjudicateLocalExit({
      presence: live, absenceReads: [gone],
      exitMetaAdmission: {
        status: stdoutAdmission.status, nonce: scope.nonce, role: 'invocation',
        invocationIdentity: { pid: live.observation.pid, startIdentity: live.observation.startIdentity, nonce: scope.nonce },
      },
    });
    assert.equal(exit.localProcessObservationVersion, 1);
    assert.equal(exit.class, 'exit-absence');
    assert.equal(exit.status, 'disappeared', 'verified presence earlier + verified absence of the SAME identity later');
    assert.equal(exit.reason, null);
    assert.deepEqual(exit.boundIdentity, { pid: live.observation.pid, startIdentity: live.observation.startIdentity, nonce: scope.nonce });
    // ROUND-32: the adjudication reports the IDENTITY-READ instant (the
    // honest identity-evidence instant) — on Linux a cold boot-clock cache
    // makes the whole-observation completion later, and equality against it
    // would flake on ms-boundary crossings.
    assert.equal(exit.lastVerifiedPresenceEpochMs, live.identityReadEpochMs);
    assert.ok(exit.firstVerifiedAbsenceEpochMs >= exit.lastVerifiedPresenceEpochMs, 'the absence is at or after the presence');
    assert.equal(exit.exitCorroboratedByMeta, true, 'the completed meta corroborates the lawful exit');
  });

  test('abrupt termination of the test-owned control: meta missing is named, the identity record stands, disappearance needs no meta', async (t) => {
    const scope = await scopeWithLiveChild(t);
    const live = await observeLocalProcess({ pid: scope.child.pid, nonce: scope.nonce });
    assert.equal(live.status, 'established');
    // The TEST kills its OWN child with SIGKILL (uncatchable): the exit
    // bookkeeping cannot run — the original interrupted-run shape.
    scope.child.kill('SIGKILL');
    const outcome = await scope.exited;
    assert.equal(outcome.signal, 'SIGKILL');
    const recordAdmission = await admitStartupIdentityRecord({ captureDirectory: scope.captureDirectory, nonce: scope.nonce });
    assert.equal(recordAdmission.status, 'established', 'the startup identity record survives the uncatchable termination');
    const gone = await observeLocalProcess({ pid: scope.child.pid, nonce: scope.nonce, expectedStartIdentity: live.observation.startIdentity });
    assert.equal(gone.status, 'absent');
    const stdoutAdmission = await admitStdoutCapture({ captureDirectory: scope.captureDirectory, nonce: scope.nonce });
    assert.equal(stdoutAdmission.status, 'incomplete');
    assert.equal(stdoutAdmission.reason, 'capture-meta-missing', 'the exit bookkeeping is named missing — the three live-run shape');
    const exit = await adjudicateLocalExit({ presence: live, absenceReads: [gone], exitMetaAdmission: stdoutAdmission });
    assert.equal(exit.status, 'disappeared', 'the OS absence proves the disappearance WITHOUT the meta');
    assert.equal(exit.exitCorroboratedByMeta, false, 'a missing meta corroborates nothing; process evidence is never blocked by it');
    assert.ok(exit.firstVerifiedAbsenceEpochMs >= exit.lastVerifiedPresenceEpochMs);
  });

  test('an exit meta alone never proves death and never covers an unobserved generation', async () => {
    // Presence established, NO absence read at all: the completed meta must
    // not manufacture a disappearance.
    const live = await observeLocalProcess({
      pid: 4_194_303, nonce: 'a'.repeat(64), nowEpochMs: 1000,
      inspect: async () => ({ pid: 4_194_303, ppid: 4_194_302, startIdentity: 'S1', nonce: 'a'.repeat(64) }),
    });
    const exit = await adjudicateLocalExit({ presence: live, absenceReads: [], exitMetaAdmission: { status: 'complete' } });
    assert.equal(exit.status, 'unestablished');
    assert.equal(exit.reason, 'no-absence-read-after-presence');
    assert.equal(exit.exitCorroboratedByMeta, false, 'a normal-exit meta corroborates ONLY an established disappearance');
    assert.equal(exit.boundIdentity, null);
    // A null presence (absent baseline) stays named-unestablished.
    const noPresence = await adjudicateLocalExit({ presence: { class: 'os-live-observation', status: 'absent', reason: 'process-absent', observation: null, readEpochMs: 900 }, absenceReads: [], exitMetaAdmission: { status: 'complete' } });
    assert.equal(noPresence.status, 'unestablished');
    assert.equal(noPresence.reason, 'presence-unestablished', 'an absent baseline never becomes a confirmed disappearance');
  });

  test('reused-PID evidence keeps the exit unestablished and never becomes death (injected seams)', async () => {
    const live = await observeLocalProcess({
      pid: 4_194_303, nonce: 'a'.repeat(64), nowEpochMs: 1000,
      inspect: async () => ({ pid: 4_194_303, ppid: 4_194_302, startIdentity: 'S1', nonce: 'a'.repeat(64) }),
    });
    const reused = await observeLocalProcess({
      pid: 4_194_303, nonce: 'a'.repeat(64), nowEpochMs: 2000, expectedStartIdentity: 'S1',
      inspect: async () => ({ pid: 4_194_303, ppid: 4_194_302, startIdentity: 'S2', nonce: 'a'.repeat(64) }),
    });
    assert.equal(reused.status, 'unestablished');
    const exit = await adjudicateLocalExit({ presence: live, absenceReads: [reused] });
    assert.equal(exit.status, 'unestablished');
    assert.equal(exit.reason, 'pid-start-identity-reused', 'a reused PID is a different process — never proof of death');
    assert.equal(exit.firstVerifiedAbsenceEpochMs, null);
  });

  test('later same-generation evidence after an absence read wins as live, and unestablished-only evidence stays named', async () => {
    /** @param {(epochMs: number) => Promise<any>} read */
    const makePresence = () => observeLocalProcess({
      pid: 4_194_303, nonce: 'a'.repeat(64), nowEpochMs: 1000,
      inspect: async () => ({ pid: 4_194_303, ppid: 4_194_302, startIdentity: 'S1', nonce: 'a'.repeat(64) }),
    });
    const absent = (epochMs) => observeLocalProcess({ pid: 4_194_303, nonce: 'a'.repeat(64), nowEpochMs: epochMs, inspect: async () => undefined });
    const aliveAgain = (epochMs) => observeLocalProcess({
      pid: 4_194_303, nonce: 'a'.repeat(64), nowEpochMs: epochMs, expectedStartIdentity: 'S1',
      inspect: async () => ({ pid: 4_194_303, ppid: 4_194_302, startIdentity: 'S1', nonce: 'a'.repeat(64) }),
    });
    const failedRead = (epochMs) => observeLocalProcess({ pid: 4_194_303, nonce: 'a'.repeat(64), nowEpochMs: epochMs, inspect: async () => { throw new Error('ps exited nonzero'); } });

    const live = await makePresence();
    // Watcher lost the exit race at 2000; the same generation is verified
    // again at 3000: the process is LIVE (the absence was a race, not death).
    const racedExit = await adjudicateLocalExit({ presence: live, absenceReads: [await absent(2000), await aliveAgain(3000)] });
    assert.equal(racedExit.status, 'live', 'later verified same-generation presence overrides the earlier absence read');
    assert.equal(racedExit.firstVerifiedAbsenceEpochMs, null);
    // Only failed reads: named-unestablished, never death.
    const onlyFailed = await adjudicateLocalExit({ presence: live, absenceReads: [await failedRead(2000)] });
    assert.equal(onlyFailed.status, 'unestablished');
    assert.equal(onlyFailed.reason, 'absence-unestablished');
    assert.equal(onlyFailed.exitCorroboratedByMeta, false);
    // Unordered input is handled by the explicit epoch ordering.
    const unordered = await adjudicateLocalExit({ presence: live, absenceReads: [await aliveAgain(3000), await absent(2000)] });
    assert.equal(unordered.status, 'live', 'the adjudication orders reads by their read instants, not list order');
  });

  test('absence evidence at or before the presence baseline is rejected, never credited (injected seams)', async () => {
    // Class sweep (ordering): absence requires STRICT recency over ALL prior
    // same-generation presence — including the baseline itself. An absence
    // stamped at the baseline instant is a tie with the baseline, and a tie
    // can never manufacture disappearance.
    const makePresence = (epochMs) => observeLocalProcess({
      pid: 4_194_303, nonce: 'a'.repeat(64), nowEpochMs: epochMs,
      inspect: async () => ({ pid: 4_194_303, ppid: 4_194_302, startIdentity: 'S1', nonce: 'a'.repeat(64) }),
    });
    const absent = (epochMs) => observeLocalProcess({ pid: 4_194_303, nonce: 'a'.repeat(64), nowEpochMs: epochMs, inspect: async () => undefined });
    const live = await makePresence(1000);
    const tiedAbsenceOnly = await adjudicateLocalExit({ presence: live, absenceReads: [await absent(1000)] });
    assert.equal(tiedAbsenceOnly.status, 'unestablished', 'an absence at the baseline instant is not strictly later — never disappearance');
    assert.equal(tiedAbsenceOnly.reason, 'no-absence-read-after-presence');
    assert.equal(tiedAbsenceOnly.firstVerifiedAbsenceEpochMs, null);
    // The same tie with a live read at the baseline: still never disappearance.
    const tieWithLive = await adjudicateLocalExit({ presence: live, absenceReads: [await makePresence(1000), await absent(1000)] });
    assert.equal(tieWithLive.status, 'unestablished');
    assert.equal(tieWithLive.firstVerifiedAbsenceEpochMs, null);
    // Strictly-later absence still credits (unchanged behavior).
    const later = await adjudicateLocalExit({ presence: live, absenceReads: [await absent(1001)] });
    assert.equal(later.status, 'disappeared');
    assert.equal(later.firstVerifiedAbsenceEpochMs, 1001);
  });

  test('equal read instants never manufacture disappearance over live evidence (injected seams)', async () => {
    // Millisecond ties are legitimate: rearranging the SAME evidence at one
    // instant must never flip a live generation to disappeared.
    const makePresence = () => observeLocalProcess({
      pid: 4_194_303, nonce: 'a'.repeat(64), nowEpochMs: 1000,
      inspect: async () => ({ pid: 4_194_303, ppid: 4_194_302, startIdentity: 'S1', nonce: 'a'.repeat(64) }),
    });
    const live = await makePresence();
    const absentAtTie = await observeLocalProcess({ pid: 4_194_303, nonce: 'a'.repeat(64), nowEpochMs: 2000, inspect: async () => undefined });
    const liveAtTie = await observeLocalProcess({
      pid: 4_194_303, nonce: 'a'.repeat(64), nowEpochMs: 2000, expectedStartIdentity: 'S1',
      inspect: async () => ({ pid: 4_194_303, ppid: 4_194_302, startIdentity: 'S1', nonce: 'a'.repeat(64) }),
    });
    const liveFirst = await adjudicateLocalExit({ presence: live, absenceReads: [liveAtTie, absentAtTie] });
    const absentFirst = await adjudicateLocalExit({ presence: live, absenceReads: [absentAtTie, liveAtTie] });
    assert.equal(liveFirst.status, 'live');
    assert.equal(absentFirst.status, 'live', 'a tie resolves conservatively: live survives, never disappearance');
    assert.equal(absentFirst.firstVerifiedAbsenceEpochMs, null, 'no absence instant is credited from a tied read');
  });

  test('the verdict reports the LAST verified same-generation survival instant, not the first (injected seams)', async () => {
    const makePresence = (epochMs) => observeLocalProcess({
      pid: 4_194_303, nonce: 'a'.repeat(64), nowEpochMs: epochMs,
      inspect: async () => ({ pid: 4_194_303, ppid: 4_194_302, startIdentity: 'S1', nonce: 'a'.repeat(64) }),
    });
    const absent = (epochMs) => observeLocalProcess({ pid: 4_194_303, nonce: 'a'.repeat(64), nowEpochMs: epochMs, inspect: async () => undefined });
    const live = await makePresence(1000);
    // Verified live at 2000, then absent at 3000: the disappearance binds to
    // the LAST survival instant (2000), never the first capture (1000).
    const survived = await adjudicateLocalExit({ presence: live, absenceReads: [await makePresence(2000), await absent(3000)] });
    assert.equal(survived.status, 'disappeared');
    assert.equal(survived.lastVerifiedPresenceEpochMs, 2000, 'the last verified survival instant is tracked');
    assert.equal(survived.firstVerifiedAbsenceEpochMs, 3000, 'the absence is strictly after the last survival');
    // A live verdict reports its latest verified presence too.
    const raced = await adjudicateLocalExit({ presence: live, absenceReads: [await absent(2000), await makePresence(3000)] });
    assert.equal(raced.status, 'live');
    assert.equal(raced.lastVerifiedPresenceEpochMs, 3000, 'the live verdict carries its latest verified presence');
  });

  test('exit meta corroborates only its own scope and role: foreign or unbound metadata is never credited (injected seams)', async () => {
    const makePresence = () => observeLocalProcess({
      pid: 4_194_303, nonce: 'a'.repeat(64), nowEpochMs: 1000,
      inspect: async () => ({ pid: 4_194_303, ppid: 4_194_302, startIdentity: 'S1', nonce: 'a'.repeat(64) }),
    });
    const live = await makePresence();
    const gone = await observeLocalProcess({ pid: 4_194_303, nonce: 'a'.repeat(64), nowEpochMs: 2000, inspect: async () => undefined });
    // The stdout capture exists ONLY for the gated invocation (the broker
    // gate writes no stdout pair), so crediting corroboration requires the
    // admission's scope AND its invocation role — otherwise the fact stays
    // uncredited, never false corroboration.
    const boundIdentity = { pid: 4_194_303, startIdentity: 'S1', nonce: 'a'.repeat(64) };
    const own = await adjudicateLocalExit({ presence: live, absenceReads: [gone], exitMetaAdmission: { status: 'complete', nonce: 'a'.repeat(64), role: 'invocation', invocationIdentity: boundIdentity } });
    assert.equal(own.status, 'disappeared');
    assert.equal(own.exitCorroboratedByMeta, true, 'the admission\'s own scope+role+identity metadata corroborates');
    const otherProcess = await adjudicateLocalExit({ presence: live, absenceReads: [gone], exitMetaAdmission: { status: 'complete', nonce: 'a'.repeat(64), role: 'invocation', invocationIdentity: { pid: 4_194_304, startIdentity: 'S1', nonce: 'a'.repeat(64) } } });
    assert.equal(otherProcess.exitCorroboratedByMeta, false, 'metadata bound to ANOTHER process never corroborates this exit');
    const foreignScope = await adjudicateLocalExit({ presence: live, absenceReads: [gone], exitMetaAdmission: { status: 'complete', nonce: 'd'.repeat(64), role: 'invocation' } });
    assert.equal(foreignScope.exitCorroboratedByMeta, false, 'scope B metadata never corroborates scope A');
    const unbound = await adjudicateLocalExit({ presence: live, absenceReads: [gone], exitMetaAdmission: { status: 'complete' } });
    assert.equal(unbound.exitCorroboratedByMeta, false, 'metadata without its scope binding is not credited');
    const wrongRole = await adjudicateLocalExit({ presence: live, absenceReads: [gone], exitMetaAdmission: { status: 'complete', nonce: 'a'.repeat(64), role: 'broker-daemon' } });
    assert.equal(wrongRole.exitCorroboratedByMeta, false, 'the stdout capture is invocation-only by construction');
    // Malformed binding input throws (the adjudicator is synchronous).
    assert.throws(() => adjudicateLocalExit({ presence: live, absenceReads: [gone], exitMetaAdmission: { status: 'complete', nonce: 'short' } }), /64-hex/u);
  });

  test('invocation metadata corroborates ONLY the invocation exit: scope alone never credits a broker or transport exit', async () => {
    // The invocation and broker processes DELIBERATELY share the capture
    // nonce, so the nonce can never distinguish whose exit the metadata
    // describes: corroboration is bound to the admitted INVOCATION identity.
    const scopeNonce = 'a'.repeat(64);
    const companionIdentity = { pid: 5100, startIdentity: 'S-COMPANION', nonce: scopeNonce };
    const daemonIdentity = { pid: 5200, startIdentity: 'S-DAEMON', nonce: scopeNonce };
    const makePresence = (identity) => observeLocalProcess({
      pid: identity.pid, nonce: identity.nonce, nowEpochMs: 1000,
      inspect: async () => ({ pid: identity.pid, ppid: 4000, startIdentity: identity.startIdentity, nonce: identity.nonce }),
    });
    const absentFor = (identity, epochMs) => observeLocalProcess({ pid: identity.pid, nonce: identity.nonce, nowEpochMs: epochMs, inspect: async () => undefined });

    // A BROKER disappearance with complete same-scope INVOCATION metadata
    // (bound to the companion identity): NOT credited.
    const brokerLive = await makePresence(daemonIdentity);
    const brokerExit = await adjudicateLocalExit({
      presence: brokerLive, absenceReads: [await absentFor(daemonIdentity, 2000)],
      exitMetaAdmission: { status: 'complete', nonce: scopeNonce, role: 'invocation', invocationIdentity: companionIdentity },
    });
    assert.equal(brokerExit.status, 'disappeared');
    assert.equal(brokerExit.exitCorroboratedByMeta, false, 'invocation metadata never corroborates a broker exit');

    // The invocation's OWN exit, metadata bound to the SAME identity: credited.
    const invocationLive = await makePresence(companionIdentity);
    const invocationExit = await adjudicateLocalExit({
      presence: invocationLive, absenceReads: [await absentFor(companionIdentity, 2000)],
      exitMetaAdmission: { status: 'complete', nonce: scopeNonce, role: 'invocation', invocationIdentity: companionIdentity },
    });
    assert.equal(invocationExit.exitCorroboratedByMeta, true, 'the metadata bound to the same identity corroborates');
    // A MISMATCHED invocation identity is not credited either.
    const mismatched = await adjudicateLocalExit({
      presence: invocationLive, absenceReads: [await absentFor(companionIdentity, 2000)],
      exitMetaAdmission: { status: 'complete', nonce: scopeNonce, role: 'invocation', invocationIdentity: daemonIdentity },
    });
    assert.equal(mismatched.exitCorroboratedByMeta, false);
    // An UNBOUND invocation identity is not credited (no invented binding).
    const unbound = await adjudicateLocalExit({
      presence: invocationLive, absenceReads: [await absentFor(companionIdentity, 2000)],
      exitMetaAdmission: { status: 'complete', nonce: scopeNonce, role: 'invocation' },
    });
    assert.equal(unbound.exitCorroboratedByMeta, false);
  });

  test('a detected generation change is a LATCH: a later absence never converts it into A\'s disappearance', async () => {
    // Round-20 finding: presence A (1000) -> replacement B established
    // (2000) -> B absent (3000) used to return `disappeared` bound to A with
    // the successor's absence instant — losing the named reuse refusal and
    // letting the successor's disappearance complete A's duties.
    const makePresence = (epochMs, startIdentity) => observeLocalProcess({
      pid: 4_194_303, nonce: 'a'.repeat(64), nowEpochMs: epochMs,
      inspect: async () => ({ pid: 4_194_303, ppid: 4_194_302, startIdentity, nonce: 'a'.repeat(64) }),
    });
    const absent = (epochMs) => observeLocalProcess({ pid: 4_194_303, nonce: 'a'.repeat(64), nowEpochMs: epochMs, inspect: async () => undefined });
    const live = await makePresence(1000, 'S1');
    const replacement = await makePresence(2000, 'S2');
    const exit = await adjudicateLocalExit({
      presence: live,
      absenceReads: [replacement, await absent(3000)],
    });
    assert.equal(exit.status, 'unestablished', 'the reuse refusal survives the later absence read');
    assert.equal(exit.reason, 'pid-start-identity-reused', 'the exact named refusal is preserved');
    assert.equal(exit.firstVerifiedAbsenceEpochMs, null, 'the successor absence is never credited to generation A');
    assert.equal(exit.exitCorroboratedByMeta, false);
    // A direct absence of the ORIGINAL generation (same start identity as A,
    // no intervening reuse) still adjudicates normally.
    const normal = await adjudicateLocalExit({
      presence: live,
      absenceReads: [await observeLocalProcess({
        pid: 4_194_303, nonce: 'a'.repeat(64), nowEpochMs: 2000, expectedStartIdentity: 'S1',
        inspect: async () => undefined,
      })],
    });
    assert.equal(normal.status, 'disappeared', 'a direct absence of generation A adjudicates normally');
  });

  test('tied generation-change evidence LATCHES regardless of read order, and a missing presence instant never binds', async () => {
    // Round-21 finding 1: a replacement established at the SAME millisecond
    // as a same-generation live read must LATCH the reuse refusal before the
    // absence-recency filtering — rearranging the two tied reads must yield
    // the same verdict, and the later absence of the replacement never
    // becomes A's disappearance.
    const makePresence = (epochMs) => observeLocalProcess({
      pid: 4_194_303, nonce: 'a'.repeat(64), nowEpochMs: epochMs,
      inspect: async () => ({ pid: 4_194_303, ppid: 4_194_302, startIdentity: 'S1', nonce: 'a'.repeat(64) }),
    });
    const replacement = (epochMs) => observeLocalProcess({
      pid: 4_194_303, nonce: 'a'.repeat(64), nowEpochMs: epochMs,
      inspect: async () => ({ pid: 4_194_303, ppid: 4_194_302, startIdentity: 'S2', nonce: 'a'.repeat(64) }),
    });
    const absent = (epochMs) => observeLocalProcess({ pid: 4_194_303, nonce: 'a'.repeat(64), nowEpochMs: epochMs, inspect: async () => undefined });
    const live = await makePresence(1000);
    const liveAtTie = await makePresence(2000);
    const replacementAtTie = await replacement(2000);
    const lateAbsence = await absent(3000);
    const oneOrder = await adjudicateLocalExit({ presence: live, absenceReads: [liveAtTie, replacementAtTie, lateAbsence] });
    const otherOrder = await adjudicateLocalExit({ presence: live, absenceReads: [replacementAtTie, liveAtTie, lateAbsence] });
    assert.equal(oneOrder.status, 'unestablished');
    assert.equal(oneOrder.reason, 'pid-start-identity-reused', 'the tied generation change latches (order 1)');
    assert.equal(otherOrder.status, 'unestablished');
    assert.equal(otherOrder.reason, 'pid-start-identity-reused', 'the tied generation change latches (order 2)');
    assert.equal(oneOrder.firstVerifiedAbsenceEpochMs, null);
    assert.equal(otherOrder.firstVerifiedAbsenceEpochMs, null);

    // Round-21 finding 2: an established-tagged baseline WITHOUT a read
    // instant (recency comparison against undefined) or WITHOUT a start
    // identity (no bound generation) is rejected before boundIdentity is
    // constructed — disappearance requires a verified presence instant and a
    // bound generation.
    const noEpoch = {
      localProcessObservationVersion: 1, class: 'os-live-observation', status: 'established',
      reason: null,
      observation: { pid: 4_194_303, ppid: 4_194_302, startIdentity: 'S1', nonce: 'a'.repeat(64), startInstantEpochMs: 0, ppidChangedFromCapture: null },
      queried: { pid: 4_194_303, nonce: 'a'.repeat(64) },
      readStartedEpochMs: 100, readEpochMs: undefined, absenceConfirmed: null,
    };
    const noStartIdentity = {
      localProcessObservationVersion: 1, class: 'os-live-observation', status: 'established',
      reason: null,
      observation: { pid: 4_194_303, ppid: 4_194_302, nonce: 'a'.repeat(64), startInstantEpochMs: 0, ppidChangedFromCapture: null },
      queried: { pid: 4_194_303, nonce: 'a'.repeat(64) },
      readStartedEpochMs: 100, readEpochMs: 200, absenceConfirmed: null,
    };
    const absentRead = await absent(2000);
    const noEpochVerdict = await adjudicateLocalExit({ presence: noEpoch, absenceReads: [absentRead] });
    assert.equal(noEpochVerdict.status, 'unestablished', 'a baseline without a read instant never binds');
    assert.equal(noEpochVerdict.reason, 'presence-instant-unverified');
    assert.equal(noEpochVerdict.boundIdentity, null);
    const noIdentityVerdict = await adjudicateLocalExit({ presence: noStartIdentity, absenceReads: [absentRead] });
    assert.equal(noIdentityVerdict.status, 'unestablished', 'a baseline without a start identity never binds');
    assert.equal(noIdentityVerdict.reason, 'presence-generation-unverified');
    assert.equal(noIdentityVerdict.boundIdentity, null);
  });

  test('NAMED generation-change reads tie-latch like established replacements, and OLD evidence never latches', async () => {
    // Round-22 finding 1: with expectedStartIdentity supplied, a replacement
    // produces an UNESTABLISHED verdict (reason start-identity-generation-
    // changed) rather than an established one. If that named verdict ties
    // with a same-generation live read, sorting places the live read first
    // and the recency filter discarded the replacement evidence — a later
    // absence then returned `disappeared` for the original generation
    // despite positively detected PID reuse. The tie latch must apply to
    // NAMED generation-change verdicts too.
    const live = await observeLocalProcess({
      pid: 4_194_303, nonce: 'a'.repeat(64), nowEpochMs: 1000,
      inspect: async () => ({ pid: 4_194_303, ppid: 4_194_302, startIdentity: 'S1', nonce: 'a'.repeat(64) }),
    });
    const liveAtTie = await observeLocalProcess({
      pid: 4_194_303, nonce: 'a'.repeat(64), nowEpochMs: 2000,
      inspect: async () => ({ pid: 4_194_303, ppid: 4_194_302, startIdentity: 'S1', nonce: 'a'.repeat(64) }),
    });
    const namedChangeAtTie = await observeLocalProcess({
      pid: 4_194_303, nonce: 'a'.repeat(64), nowEpochMs: 2000, expectedStartIdentity: 'S1',
      inspect: async () => ({ pid: 4_194_303, ppid: 4_194_302, startIdentity: 'S2', nonce: 'a'.repeat(64) }),
    });
    const lateAbsence = await observeLocalProcess({ pid: 4_194_303, nonce: 'a'.repeat(64), nowEpochMs: 3000, inspect: async () => undefined });
    const liveFirst = await adjudicateLocalExit({ presence: live, absenceReads: [liveAtTie, namedChangeAtTie, lateAbsence] });
    const namedFirst = await adjudicateLocalExit({ presence: live, absenceReads: [namedChangeAtTie, liveAtTie, lateAbsence] });
    assert.equal(liveFirst.status, 'unestablished');
    assert.equal(liveFirst.reason, 'pid-start-identity-reused', 'the named tie latches (live read sorted first)');
    assert.equal(namedFirst.status, 'unestablished');
    assert.equal(namedFirst.reason, 'pid-start-identity-reused', 'the named tie latches (named read sorted first)');
    assert.equal(liveFirst.firstVerifiedAbsenceEpochMs, null);
    assert.equal(namedFirst.firstVerifiedAbsenceEpochMs, null);

    // Round-22 finding 2: an OLD generation observed BEFORE the presence
    // baseline must NEVER latch — it predates the current occupant and is
    // irrelevant evidence; omitting it yields a normal disappearance and the
    // verdict must match.
    const baseline = await observeLocalProcess({
      pid: 4_194_303, nonce: 'a'.repeat(64), nowEpochMs: 3000,
      inspect: async () => ({ pid: 4_194_303, ppid: 4_194_302, startIdentity: 'S1', nonce: 'a'.repeat(64) }),
    });
    const oldGeneration = await observeLocalProcess({
      pid: 4_194_303, nonce: 'a'.repeat(64), nowEpochMs: 1000, expectedStartIdentity: 'S1',
      inspect: async () => ({ pid: 4_194_303, ppid: 4_194_302, startIdentity: 'S0', nonce: 'a'.repeat(64) }),
    });
    const absence = await observeLocalProcess({ pid: 4_194_303, nonce: 'a'.repeat(64), nowEpochMs: 4000, inspect: async () => undefined });
    const withOld = await adjudicateLocalExit({ presence: baseline, absenceReads: [oldGeneration, absence] });
    assert.equal(withOld.status, 'disappeared', 'an OLD replacement observation never latches the reuse refusal');
    assert.equal(withOld.reason, null);
    assert.equal(withOld.firstVerifiedAbsenceEpochMs, 4000);
  });

  test('an inspector-detected mid-read PID reuse LATCHES the reuse refusal (not read-torn)', async () => {
    // Round-23 finding 1: a PID reused BETWEEN the inspector's two
    // start-identity reads throws the generic identity-changed error — that
    // is POSITIVE replacement evidence and must latch the reuse refusal, not
    // fold into the generic read-torn class (where a later absence would
    // return `disappeared` for the original generation).
    const live = await observeLocalProcess({
      pid: 4_194_303, nonce: 'a'.repeat(64), nowEpochMs: 1000,
      inspect: async () => ({ pid: 4_194_303, ppid: 4_194_302, startIdentity: 'S1', nonce: 'a'.repeat(64) }),
    });
    const midReadReuse = await observeLocalProcess({
      pid: 4_194_303, nonce: 'a'.repeat(64), nowEpochMs: 2000,
      inspect: async () => { throw new Error('the exact fake-ZCode process identity changed'); },
    });
    assert.equal(midReadReuse.status, 'unestablished');
    assert.equal(midReadReuse.reason, 'start-identity-generation-changed',
      'the inspector-detected change is its OWN named class, not read-torn');
    const lateAbsence = await observeLocalProcess({ pid: 4_194_303, nonce: 'a'.repeat(64), nowEpochMs: 3000, inspect: async () => undefined });
    const exit = await adjudicateLocalExit({ presence: live, absenceReads: [midReadReuse, lateAbsence] });
    assert.equal(exit.status, 'unestablished', 'the detected reuse latches — the successor absence never becomes A\'s disappearance');
    assert.equal(exit.reason, 'pid-start-identity-reused');
    assert.equal(exit.firstVerifiedAbsenceEpochMs, null);

    // CLASS SWEEP: reparenting alone is NOT reuse (the round-1 rule) — a
    // ppid-only divergence stays read-torn and never latches.
    const reparentOnly = await observeLocalProcess({
      pid: 4_194_303, nonce: 'a'.repeat(64), nowEpochMs: 2500, expectedStartIdentity: 'S1',
      inspect: async () => { throw new Error('the exact fake-ZCode process ppid changed'); },
    });
    assert.equal(reparentOnly.status, 'unestablished');
    assert.equal(reparentOnly.reason, 'liveness-read-failed', 'reparenting alone is the generic torn class — never reuse');
    const reparentExit = await adjudicateLocalExit({ presence: live, absenceReads: [reparentOnly, lateAbsence] });
    assert.equal(reparentExit.status, 'disappeared', 'a torn read does not latch; the absence adjudicates normally');
  });

  test('a foreign absence read never establishes this generation\'s disappearance (injected seams)', async () => {
    // Established presence of PID 5100; an absence read that queried PID 9999
    // carries neither 5100's identity nor its nonce — it is evidence about a
    // different process and must never decide PID 5100's exit.
    const live = await observeLocalProcess({
      pid: 5100, nonce: 'a'.repeat(64), nowEpochMs: 1000,
      inspect: async () => ({ pid: 5100, ppid: 4000, startIdentity: 'S1', nonce: 'a'.repeat(64) }),
    });
    assert.equal(live.status, 'established');
    assert.deepEqual(live.queried, { pid: 5100, nonce: 'a'.repeat(64) }, 'every verdict preserves the queried identity');
    const foreignAbsence = await observeLocalProcess({ pid: 9999, nonce: 'a'.repeat(64), nowEpochMs: 2000, inspect: async () => undefined });
    assert.equal(foreignAbsence.status, 'absent');
    assert.deepEqual(foreignAbsence.queried, { pid: 9999, nonce: 'a'.repeat(64) }, 'absence verdicts preserve WHO was queried');
    const exit = await adjudicateLocalExit({ presence: live, absenceReads: [foreignAbsence] });
    assert.equal(exit.status, 'unestablished', 'a foreign absence read never establishes PID 5100 as disappeared');
    assert.equal(exit.reason, 'no-absence-read-after-presence');
    assert.equal(exit.firstVerifiedAbsenceEpochMs, null, 'no absence instant is credited from the foreign read');
    // A malformed read (no queried identity at all) is rejected as input.
    assert.throws(() => adjudicateLocalExit({
      presence: live,
      absenceReads: [{ class: 'os-live-observation', status: 'absent', reason: 'process-absent', observation: null, readEpochMs: 2000 }],
    }), /queried/u, 'an absence verdict without its queried identity is malformed input');
  });

  test('delayed capture after an unobserved quick exit: the startup record survives, the OS generation stays unestablished', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'shell-wait-local-process-delayed-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const captureDirectory = join(root, 'stdout-capture');
    await mkdir(captureDirectory, { mode: 0o700 });
    const nonce = randomBytes(32).toString('hex');
    const preload = await writeClosurePreload(root);
    const probePath = join(root, 'probe-entry.mjs');
    await writeFile(probePath, "process.stdout.write('quick\\n');\n", { mode: 0o700 });
    const entryRealpath = await realpath(probePath);
    const env = captureEnvironment({ captureDirectory, nonce, entryRealpath, baseEnv: isolatedBaseEnv(root), nodeOptionsFragment: preload.nodeOptionsFragment });
    const outcome = await spawnBounded(process.execPath, [entryRealpath, 'invoke-prepared', 'rescue'], env);
    assert.equal(outcome.code, 0);
    // The first capture read happens only AFTER the exit (the delayed shape).
    const recordAdmission = await admitStartupIdentityRecord({ captureDirectory, nonce });
    assert.equal(recordAdmission.status, 'established', 'the install-time record captured the identity before the disappearance');
    const postExit = await observeLocalProcess({ pid: recordAdmission.identity.pid, nonce });
    assert.equal(postExit.status, 'absent');
    const exit = await adjudicateLocalExit({ presence: postExit, absenceReads: [] });
    assert.equal(exit.status, 'unestablished');
    assert.equal(exit.reason, 'presence-unestablished',
      'no OS-verified presence was ever established — the disappearance is NOT fabricated from the record alone');
  });
});

describe('local-process observation: broker-daemon hop and the bounded local-duty verdict (task 2, §25.4 item 4 / §25.5)', async () => {
  const { mkdir } = await import('node:fs/promises');
  const { adjudicateLocalDuties, admitStartupIdentityRecord, joinAncestryHops } = await import('../tools/shell-wait-probe/local-process-observation.mjs');
  const { CAPTURE_BROKER_ENTRY_VARIABLE } = await import('../tools/shell-wait-probe/closure-observation.mjs');

  /** One disposable scope with declared invocation + broker stand-in entries. */
  async function brokerScope(t) {
    const root = await mkdtemp(join(tmpdir(), 'shell-wait-local-process-broker-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const captureDirectory = join(root, 'stdout-capture');
    await mkdir(captureDirectory, { mode: 0o700 });
    const nonce = randomBytes(32).toString('hex');
    const preload = await writeClosurePreload(root);
    const brokerPath = join(root, 'broker-standin.mjs');
    await writeFile(brokerPath, "process.stdout.write('broker-stdout\\n');\n", { mode: 0o700 });
    const brokerEntryRealpath = await realpath(brokerPath);
    const configPath = join(root, 'broker-config.json');
    await writeFile(configPath, '{}\n', { mode: 0o600 });
    const env = captureEnvironment({
      captureDirectory, nonce, entryRealpath: join(root, 'undeclared-invocation.mjs'),
      brokerEntryRealpath, baseEnv: isolatedBaseEnv(root), nodeOptionsFragment: preload.nodeOptionsFragment,
    });
    return { root, captureDirectory, nonce, brokerEntryRealpath, configPath, env };
  }

  test('the declared broker-argv child writes ONLY its broker identity record: no stdout capture, no interception', async (t) => {
    const scope = await brokerScope(t);
    assert.equal(CAPTURE_BROKER_ENTRY_VARIABLE, 'ZCODE_SHELL_WAIT_CAPTURE_BROKER_ENTRY_REALPATH');
    assert.equal(scope.env[CAPTURE_BROKER_ENTRY_VARIABLE], scope.brokerEntryRealpath, 'the composed environment carries the declared broker entry');
    const outcome = await spawnBounded(process.execPath, [scope.brokerEntryRealpath, scope.configPath], scope.env);
    assert.equal(outcome.code, 0, 'the broker-like child exits normally');
    assert.equal(outcome.stdout, 'broker-stdout\n', 'its stdout is NOT intercepted — the stdout capture stays the gated invocation\'s alone');
    assert.equal(outcome.stderr, '');
    const entries = (await readdir(scope.captureDirectory)).sort();
    assert.deepEqual(entries, [`${scope.nonce}.identity-broker.json`], 'exactly the broker record, no stdout pair');
    const record = JSON.parse(await readFile(join(scope.captureDirectory, `${scope.nonce}.identity-broker.json`), 'utf8'));
    assert.deepEqual(Object.keys(record).sort(),
      ['configRealpathSha256', 'entryRealpath', 'firstWriteEpochMs', 'firstWritePreciseMs', 'nonce', 'pid', 'ppid', 'role', 'startOriginMs', 'version'],
      'the broker record is a closed bounded shape; the raw config path is never persisted');
    assert.equal(record.version, 2);
    assert.equal(record.role, 'broker-daemon');
    assert.equal(record.nonce, scope.nonce);
    assert.equal(record.entryRealpath, scope.brokerEntryRealpath);
    const { createHash } = await import('node:crypto');
    assert.equal(record.configRealpathSha256, createHash('sha256').update(await realpath(scope.configPath), 'utf8').digest('hex'),
      'the record binds a digest of the canonical broker config path');
    assert.ok(Number.isSafeInteger(record.pid) && record.pid === outcome.pid);
    const admission = await admitStartupIdentityRecord({ captureDirectory: scope.captureDirectory, nonce: scope.nonce, role: 'broker-daemon' });
    assert.equal(admission.status, 'established');
    assert.equal(admission.identity.role, 'broker-daemon');
    assert.equal(admission.identity.configRealpathSha256, record.configRealpathSha256);
    assert.equal(admission.identity.argv, undefined, 'the broker identity carries no terminal argv');
    const wrongRole = await admitStartupIdentityRecord({ captureDirectory: scope.captureDirectory, nonce: scope.nonce });
    assert.equal(wrongRole.status, 'missing', 'the broker record never admits as the invocation role (role-selected file suffixes)');
  });

  test('the broker entry composition never inherits a stale broker variable through baseEnv (disabled by default)', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'shell-wait-local-process-broker-leak-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const captureDirectory = join(root, 'stdout-capture');
    await mkdir(captureDirectory, { mode: 0o700 });
    const nonce = randomBytes(32).toString('hex');
    const preload = await writeClosurePreload(root);
    const staleBroker = join(root, 'stale-broker.mjs');
    await writeFile(staleBroker, '', { mode: 0o700 });
    // A POLLUTED base env carrying a stale declared broker entry (e.g. an
    // inherited fixture environment): omitting brokerEntryRealpath must
    // explicitly REMOVE the variable — the broker gate is disabled by
    // default, and a stale declaration must never survive into the new
    // scope under the fresh nonce.
    const pollutedBase = { ...isolatedBaseEnv(root), [CAPTURE_BROKER_ENTRY_VARIABLE]: staleBroker };
    const omitted = captureEnvironment({
      captureDirectory, nonce, entryRealpath: join(root, 'undeclared-invocation.mjs'),
      baseEnv: pollutedBase, nodeOptionsFragment: preload.nodeOptionsFragment,
    });
    assert.equal(CAPTURE_BROKER_ENTRY_VARIABLE in omitted, false,
      'the inherited broker variable is explicitly removed when no broker entry is supplied');
    assert.equal(omitted[CAPTURE_BROKER_ENTRY_VARIABLE], undefined);
    // Supplying a broker entry WINS over the inherited value.
    const suppliedBroker = join(root, 'supplied-broker.mjs');
    await writeFile(suppliedBroker, '', { mode: 0o700 });
    const supplied = captureEnvironment({
      captureDirectory, nonce, entryRealpath: join(root, 'undeclared-invocation.mjs'),
      brokerEntryRealpath: suppliedBroker,
      baseEnv: pollutedBase, nodeOptionsFragment: preload.nodeOptionsFragment,
    });
    assert.equal(supplied[CAPTURE_BROKER_ENTRY_VARIABLE], suppliedBroker, 'the supplied broker entry replaces the inherited one');
  });

  test('without a declared broker entry the broker gate is disabled: a broker-argv child installs NOTHING', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'shell-wait-local-process-broker-off-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const captureDirectory = join(root, 'stdout-capture');
    await mkdir(captureDirectory, { mode: 0o700 });
    const nonce = randomBytes(32).toString('hex');
    const preload = await writeClosurePreload(root);
    const brokerPath = join(root, 'broker-standin.mjs');
    await writeFile(brokerPath, "process.stdout.write('broker-stdout\\n');\n", { mode: 0o700 });
    const brokerEntryRealpath = await realpath(brokerPath);
    const env = captureEnvironment({
      captureDirectory, nonce, entryRealpath: join(root, 'undeclared-invocation.mjs'),
      baseEnv: isolatedBaseEnv(root), nodeOptionsFragment: preload.nodeOptionsFragment,
    });
    assert.equal(env[CAPTURE_BROKER_ENTRY_VARIABLE], undefined, 'the variable is absent without the declared broker entry');
    const outcome = await spawnBounded(process.execPath, [brokerEntryRealpath, join(root, 'config.json')], env);
    assert.equal(outcome.code, 0);
    assert.equal((await readdir(captureDirectory)).length, 0, 'an undeclared broker gate installs NOTHING');
    await assert.throws(() => captureEnvironment({
      captureDirectory, nonce, entryRealpath: join(root, 'e.mjs'), brokerEntryRealpath: 'relative-broker',
    }), /absolute/u, 'the broker entry composition validates the absolute path');
  });

  // Synthetic captured identities for the pure adjudications (no synthetic
  // PID ever reaches the real OS — these are pure functions of supplied
  // capture-time facts).
  const NONCE = 'c'.repeat(64);
  const companion = { pid: 5100, ppid: 4000, startIdentity: 'S-COMPANION', nonce: NONCE, startInstantEpochMs: 0 };
  const daemon = { pid: 5200, ppid: 5100, startIdentity: 'S-DAEMON', nonce: NONCE, startInstantEpochMs: 1000 };
  const daemonReparented = { pid: 5200, ppid: 1, startIdentity: 'S-DAEMON', nonce: NONCE };
  const transportMarker = { pid: 5300, ppid: 5200, nonce: NONCE };
  /** @param {{ pid: number, ppid: number, startIdentity: string, nonce: string }} observation */
  const establishedObservation = (observation, epochMs) => ({
    localProcessObservationVersion: 1, class: 'os-live-observation', status: 'established',
    reason: null, observation: { ...observation, ppidChangedFromCapture: null }, readEpochMs: epochMs,
  });

  test('the two-hop ancestry join is established only with both endpoints positively captured and the ppids equal at capture time', () => {
    const established = joinAncestryHops({
      nonce: NONCE,
      companionObservation: establishedObservation(companion, 2500),
      daemonObservation: establishedObservation(daemon, 2600),
      transportMarker,
      markerEpochMs: 2500,
    });
    assert.equal(established.class, 'ancestry-join');
    assert.deepEqual(established.hops.map((hop) => hop.status), ['established', 'established']);
    assert.equal(established.companionToTransportAttributed, true, 'both hops positively captured — the attribution crosses both');

    const uncapturedDaemon = joinAncestryHops({ nonce: NONCE, companionObservation: establishedObservation(companion, 2500), daemonObservation: null, transportMarker });
    assert.deepEqual(uncapturedDaemon.hops.map((hop) => [hop.status, hop.reason]), [
      ['unestablished', 'hop-endpoint-unestablished'], ['unestablished', 'hop-endpoint-unestablished'],
    ]);
    assert.equal(uncapturedDaemon.companionToTransportAttributed, false,
      'the Companion↔transport attribution never crosses an unestablished hop by inference');
  });

  test('a marker never attests another process merely because they inherited the nonce: ppid equality is the evidence', () => {
    // Same scope nonce on every fact, but the marker's ppid is NOT the
    // captured daemon: the hop stays unestablished despite the nonce.
    const foreignMarker = { pid: 5300, ppid: 9999, nonce: NONCE };
    const verdict = joinAncestryHops({
      nonce: NONCE,
      companionObservation: establishedObservation(companion, 2500),
      daemonObservation: establishedObservation(daemon, 2600),
      transportMarker: foreignMarker,
    });
    assert.equal(verdict.hops[1].status, 'unestablished');
    assert.equal(verdict.hops[1].reason, 'marker-ppid-mismatch-at-capture');
    assert.equal(verdict.companionToTransportAttributed, false);
  });

  test('a reparented daemon breaks the capture-time ppid equality: the hop is named-unestablished, never death', () => {
    const reparented = joinAncestryHops({
      nonce: NONCE,
      companionObservation: establishedObservation(companion, 2500),
      daemonObservation: establishedObservation(daemonReparented, 2000),
      transportMarker,
    });
    assert.equal(reparented.hops[0].status, 'unestablished');
    assert.equal(reparented.hops[0].reason, 'daemon-ppid-mismatch-at-capture');
    assert.equal(reparented.hops[0].detail, 'capture-time-only', 'the equality is a capture-time fact; a changed parent proves nothing about liveness');
  });

  test('a foreign-scope nonce on any endpoint refuses the join by scope binding', () => {
    const foreignNonceObservation = establishedObservation({ ...daemon, nonce: 'd'.repeat(64) }, 1010);
    const verdict = joinAncestryHops({
      nonce: NONCE,
      companionObservation: establishedObservation(companion, 2500),
      daemonObservation: foreignNonceObservation,
      transportMarker,
    });
    assert.equal(verdict.hops[0].status, 'unestablished');
    assert.equal(verdict.hops[0].reason, 'scope-nonce-mismatch');
    // The transport hop verifies against the DECLARED expected transport
    // nonce (the marker's own scope, never the capture scope).
    const foreignMarkerNonce = joinAncestryHops({
      nonce: NONCE,
      companionObservation: establishedObservation(companion, 2500),
      daemonObservation: establishedObservation(daemon, 2600),
      transportMarker: { ...transportMarker, nonce: 'd'.repeat(64) },
      expectedTransportNonce: NONCE,
    });
    assert.equal(foreignMarkerNonce.hops[1].status, 'unestablished');
    assert.equal(foreignMarkerNonce.hops[1].reason, 'transport-nonce-mismatch');
  });

  test('the REAL fixture chain joins: the transport marker carries its own declared transport nonce, not the capture nonce', () => {
    // The driver generates FAKE_ZCODE_PROCESS_NONCE independently of the
    // fixture capture nonce, and the fake-ZCode marker carries THAT transport
    // nonce — the daemon→transport hop is bound by the marker's own expected
    // nonce plus ancestry, never by the capture scope.
    const transportNonce = 'a1b2'.repeat(16);
    const realChain = joinAncestryHops({
      nonce: NONCE,
      companionObservation: establishedObservation(companion, 2500),
      daemonObservation: establishedObservation(daemon, 2600),
      transportMarker: { pid: 5300, ppid: 5200, nonce: transportNonce },
      expectedTransportNonce: transportNonce,
      markerEpochMs: 2500,
    });
    assert.deepEqual(realChain.hops.map((hop) => [hop.status, hop.reason]), [
      ['established', null],
      ['established', null],
    ], 'the real transport nonce joins through its own declared expectation');
    assert.equal(realChain.companionToTransportAttributed, true, 'the real fixture chain attributes end to end');

    // A marker whose nonce differs from the EXPECTED transport nonce refuses.
    const foreignTransport = joinAncestryHops({
      nonce: NONCE,
      companionObservation: establishedObservation(companion, 2500),
      daemonObservation: establishedObservation(daemon, 2600),
      transportMarker: { pid: 5300, ppid: 5200, nonce: 'e1f2'.repeat(16) },
      expectedTransportNonce: transportNonce,
    });
    assert.equal(foreignTransport.hops[1].status, 'unestablished');
    assert.equal(foreignTransport.hops[1].reason, 'transport-nonce-mismatch');
  });

  test('a FOREIGN-NONCE daemon never hosts in-scope transport evidence: the daemon→transport hop independently verifies the daemon scope', () => {
    // Round-10 finding 2: the daemon inherits the capture nonce, so its
    // observation carries the scope; when the daemon endpoint belongs to
    // ANOTHER invocation nonce the daemon→transport hop must refuse even if
    // the marker's ppid and its own expected transport nonce match — positive
    // foreign-scope evidence is never labeled with the requested scope.
    const foreignDaemonObs = {
      localProcessObservationVersion: 1, class: 'os-live-observation', status: 'established',
      reason: null,
      observation: { pid: 5200, ppid: 4000, startIdentity: 'S-FOREIGN-DAEMON', nonce: 'd'.repeat(64), startInstantEpochMs: 1000, ppidChangedFromCapture: null },
      queried: { pid: 5200, nonce: 'd'.repeat(64) },
      readStartedEpochMs: 1010, readEpochMs: 1010, absenceConfirmed: null,
    };
    const inScopeMarker = { pid: 5300, ppid: 5200, nonce: NONCE };
    // WITH the Companion endpoint unavailable: the foreign daemon must not
    // host in-scope transport evidence on its own.
    const noCompanion = joinAncestryHops({
      nonce: NONCE,
      companionObservation: null,
      daemonObservation: foreignDaemonObs,
      transportMarker: inScopeMarker,
      expectedTransportNonce: NONCE,
    });
    assert.deepEqual(noCompanion.hops.map((hop) => [hop.status, hop.reason]), [
      ['unestablished', 'hop-endpoint-unestablished'],
      ['unestablished', 'scope-nonce-mismatch'],
    ], 'the foreign daemon endpoint refuses the hop by ITS OWN scope, independent of the companion');
    assert.equal(noCompanion.companionToTransportAttributed, false);

    // WITH the Companion established: the foreign daemon STILL refuses the
    // hop — the daemon endpoint's scope is verified independently of hop 1.
    const withCompanion = joinAncestryHops({
      nonce: NONCE,
      companionObservation: establishedObservation(companion, 2500),
      daemonObservation: foreignDaemonObs,
      transportMarker: inScopeMarker,
      expectedTransportNonce: NONCE,
    });
    assert.deepEqual(withCompanion.hops.map((hop) => [hop.status, hop.reason]), [
      ['unestablished', 'scope-nonce-mismatch'],
      ['unestablished', 'scope-nonce-mismatch'],
    ], 'the foreign daemon breaks BOTH hops: the companion hop by its scope, the transport hop by the daemon endpoint\'s scope');
    assert.equal(withCompanion.companionToTransportAttributed, false);
  });

  test('Linux lower-bound start instants propagate their uncertainty into hop lifetime checks', () => {
    // Round-18 finding: on Linux the computed creation instant is a LOWER
    // BOUND (whole-second btime, true creation in [computed, computed +
    // 1000)). A daemon whose computed start is T with the marker written at
    // T+500 old-bound-safe the hop (daemonStart <= markerTime) even though
    // the TRUE daemon creation (>= T+800) postdates the marker — under PID
    // reuse that is false attribution. Only orderings that hold even at the
    // UNCERTAINTY BOUND may credit; orderings that hold merely via the
    // uncertainty window are named-unestablished.
    const daemonComputedStart = 1700000000000;
    const daemon = establishedObservation({ pid: 5200, ppid: 5100, startIdentity: 'proc:42', nonce: NONCE, startInstantEpochMs: daemonComputedStart }, 1700000001700);
    // The companion's read instant postdates the daemon's UNCERTAINTY BOUND
    // (computed + 1000), so hop 1's daemon-start ordering is demonstrable
    // and this test isolates the marker-time propagation.
    const companion = establishedObservation({ pid: 5100, ppid: 4000, startIdentity: 'S-COMPANION', nonce: NONCE, startInstantEpochMs: 1699999999000 }, 1700000001100);
    // The marker written at computed+500 is INSIDE the daemon's uncertainty
    // window — the hop must not credit.
    const insideWindow = joinAncestryHops({
      nonce: NONCE,
      companionObservation: companion,
      daemonObservation: daemon,
      transportMarker: { pid: 5300, ppid: 5200, nonce: NONCE },
      markerEpochMs: daemonComputedStart + 500,
    });
    assert.equal(insideWindow.hops[1].status, 'unestablished',
      'the marker inside the daemon uncertainty window never credits the hop');
    assert.equal(insideWindow.hops[1].reason, 'generation-lifetime-unverifiable');
    assert.equal(insideWindow.companionToTransportAttributed, false);

    // The marker at or beyond the UNCERTAINTY BOUND (computed + 1000) is
    // DEMONSTRABLY after the daemon creation — the hop credits.
    const atBound = joinAncestryHops({
      nonce: NONCE,
      companionObservation: companion,
      daemonObservation: daemon,
      transportMarker: { pid: 5300, ppid: 5200, nonce: NONCE },
      markerEpochMs: daemonComputedStart + 1000,
    });
    assert.equal(atBound.hops[1].status, 'established',
      'a marker at the uncertainty bound is DEMONSTRABLY after the daemon creation');
    assert.equal(atBound.companionToTransportAttributed, true);

    // Companion-side: a Linux companion whose start bound is later than the
    // daemon read cannot guarantee it existed at the daemon read — named.
    const linuxCompanion = establishedObservation({ pid: 5100, ppid: 4000, startIdentity: 'proc:7', nonce: NONCE, startInstantEpochMs: 1699999999500 }, 1700000000900);
    const companionAmbiguous = joinAncestryHops({
      nonce: NONCE,
      companionObservation: linuxCompanion,
      daemonObservation: daemon,
      transportMarker: { pid: 5300, ppid: 5200, nonce: NONCE },
      markerEpochMs: daemonComputedStart + 1000,
    });
    assert.equal(companionAmbiguous.hops[0].status, 'unestablished',
      'the companion start bound exceeding the daemon read is named, not credited');
    assert.equal(companionAmbiguous.hops[0].reason, 'generation-lifetime-unverifiable');
  });

  test('darwin whole-second lstart carries the same rounding uncertainty in hop lifetime checks', () => {
    // Round-19 finding: darwin lstart is whole-second, but startBoundMs gave
    // it ZERO uncertainty — a daemon actually created at T+800ms reports
    // start T and could join a marker written at T+500ms (before the true
    // creation) under broker PID reuse. The SAME demonstrable/ambiguous/
    // refused structure applies: lstart second T means true creation in
    // [T, T+1000).
    const daemon = establishedObservation({ pid: 5200, ppid: 5100, startIdentity: 'S-DAEMON', nonce: NONCE, startInstantEpochMs: 1700000000000 }, 1700000001700);
    const companion = establishedObservation({ pid: 5100, ppid: 4000, startIdentity: 'S-COMPANION', nonce: NONCE, startInstantEpochMs: 1699999999000 }, 1700000001100);
    // The marker INSIDE the reported start second (T, T+1000): the true
    // daemon creation may postdate it — never credited.
    const insideStartSecond = joinAncestryHops({
      nonce: NONCE,
      companionObservation: companion,
      daemonObservation: daemon,
      transportMarker: { pid: 5300, ppid: 5200, nonce: NONCE },
      markerEpochMs: 1700000000500,
    });
    assert.equal(insideStartSecond.hops[1].status, 'unestablished',
      'a marker inside the reported lstart second never credits the darwin hop');
    assert.equal(insideStartSecond.hops[1].reason, 'generation-lifetime-unverifiable');
    assert.equal(insideStartSecond.companionToTransportAttributed, false);

    // The marker at/after the +1000ms bound: DEMONSTRABLY after the daemon
    // creation — credit.
    const atBound = joinAncestryHops({
      nonce: NONCE,
      companionObservation: companion,
      daemonObservation: daemon,
      transportMarker: { pid: 5300, ppid: 5200, nonce: NONCE },
      markerEpochMs: 1700000001000,
    });
    assert.equal(atBound.hops[1].status, 'established',
      'a marker at the lstart rounding bound is demonstrably after the daemon creation');
    assert.equal(atBound.companionToTransportAttributed, true);
  });

  test('a hop without generation-compatible lifetimes is never credited: PPID+nonce equality alone is not ancestry', () => {
    // Round-17 finding: with PID reuse, a daemon observed at epoch 1000 with
    // PPID 5100 joins a Companion whose PID is 5100 but whose OS start
    // instant is 2000 — that Companion did NOT exist at the daemon's capture
    // time. Each endpoint's OS start instant must precede the other
    // endpoint's capture/read instant before a hop is credited.
    const lateCompanion = establishedObservation({ pid: 5100, ppid: 4000, startIdentity: 'S-LATE', nonce: NONCE, startInstantEpochMs: 2000 }, 3000);
    const earlyDaemon = establishedObservation({ pid: 5200, ppid: 5100, startIdentity: 'S-DAEMON', nonce: NONCE, startInstantEpochMs: 1000 }, 1010);
    const reuse = joinAncestryHops({
      nonce: NONCE,
      companionObservation: lateCompanion,
      daemonObservation: earlyDaemon,
      transportMarker: { ...transportMarker, ppid: 5200 },
    });
    assert.equal(reuse.hops[0].status, 'unestablished',
      'the companion did not exist at the daemon capture time — PPID equality is not ancestry');
    assert.equal(reuse.hops[0].reason, 'generation-lifetime-unverifiable');
    assert.equal(reuse.companionToTransportAttributed, false);

    // Missing lifetime evidence is NAMED, never bridged: an endpoint without
    // a start instant keeps the hop unestablished.
    const noInstants = joinAncestryHops({
      nonce: NONCE,
      companionObservation: establishedObservation({ pid: 5100, ppid: 4000, startIdentity: 'S-NI', nonce: NONCE, startInstantEpochMs: null }, 1000),
      daemonObservation: establishedObservation({ pid: 5200, ppid: 5100, startIdentity: 'S-D', nonce: NONCE, startInstantEpochMs: null }, 1010),
      transportMarker: { ...transportMarker, ppid: 5200 },
    });
    assert.equal(noInstants.hops[0].reason, 'generation-lifetime-unverifiable');
    assert.equal(noInstants.hops[1].reason, 'generation-lifetime-unverifiable');
    assert.equal(noInstants.companionToTransportAttributed, false);

    // GENERATION-COMPATIBLE lifetimes still join: companion (start 800,
    // read 1000) predates the daemon (start 850, read 1010) — the daemon
    // existed at the companion's read, the companion existed at the daemon's
    // start and read.
    const compatible = joinAncestryHops({
      nonce: NONCE,
      companionObservation: establishedObservation(
        { pid: 5100, ppid: 4000, startIdentity: 'S-C2', nonce: NONCE, startInstantEpochMs: 0 }, 2500),
      daemonObservation: establishedObservation(
        { pid: 5200, ppid: 5100, startIdentity: 'S-D2', nonce: NONCE, startInstantEpochMs: 1000 }, 2600),
      transportMarker: { pid: 5300, ppid: 5200, nonce: NONCE },
      markerEpochMs: 2000,
    });
    assert.deepEqual(compatible.hops.map((hop) => [hop.status, hop.reason]), [
      ['established', null],
      ['established', null],
    ], 'generation-compatible lifetimes join');
    assert.equal(compatible.companionToTransportAttributed, true);
  });

  test('an ancestry endpoint WITHOUT an OS start identity is named-unavailable — never joined', () => {
    // Round-23 finding 2: an established-tagged endpoint missing its OS
    // start identity carries no verified generation; compatible
    // pid/ppid/nonce/instants made both hops established with NEITHER
    // endpoint generation-verified. Incomplete endpoints are named-
    // unavailable, never joined (the round-15/16 completeness bar).
    const noIdentityCompanion = {
      localProcessObservationVersion: 1, class: 'os-live-observation', status: 'established',
      reason: null,
      observation: { pid: 5100, ppid: 4000, nonce: NONCE, startInstantEpochMs: 0, ppidChangedFromCapture: null },
      queried: { pid: 5100, nonce: NONCE },
      readStartedEpochMs: 1000, readEpochMs: 2500, absenceConfirmed: null,
    };
    const noIdentityDaemon = {
      localProcessObservationVersion: 1, class: 'os-live-observation', status: 'established',
      reason: null,
      observation: { pid: 5200, ppid: 5100, nonce: NONCE, startInstantEpochMs: 1000, ppidChangedFromCapture: null },
      queried: { pid: 5200, nonce: NONCE },
      readStartedEpochMs: 1010, readEpochMs: 2600, absenceConfirmed: null,
    };
    const verdict = joinAncestryHops({
      nonce: NONCE,
      companionObservation: noIdentityCompanion,
      daemonObservation: noIdentityDaemon,
      transportMarker: { pid: 5300, ppid: 5200, nonce: NONCE },
      markerEpochMs: 2000,
    });
    // The named-unavailable endpoint is expressed as the named-unestablished
    // hop (both hops' endpoints are incomplete, so both refuse).
    assert.deepEqual(verdict.hops.map((hop) => [hop.status, hop.reason]), [
      ['unestablished', 'hop-endpoint-unestablished'],
      ['unestablished', 'hop-endpoint-unestablished'],
    ], 'incomplete endpoints are named-unavailable — never joined');
    assert.equal(verdict.companionToTransportAttributed, false);
  });

  test('valid negative verdicts are unavailable endpoints: each hop is adjudicated independently, never thrown away', () => {
    // An ABSENT daemon verdict is a valid os-live-observation value: the join
    // must return its named-unestablished hops, not throw a TypeError.
    const absentDaemon = { class: 'os-live-observation', status: 'absent', reason: 'process-absent', observation: null, readEpochMs: 2000 };
    const withAbsentDaemon = joinAncestryHops({ nonce: NONCE, companionObservation: establishedObservation(companion, 2500), daemonObservation: absentDaemon, transportMarker });
    assert.deepEqual(withAbsentDaemon.hops.map((hop) => [hop.status, hop.reason]), [
      ['unestablished', 'hop-endpoint-unestablished'],
      ['unestablished', 'hop-endpoint-unestablished'],
    ], 'the absent endpoint names BOTH hops unestablished');
    assert.equal(withAbsentDaemon.companionToTransportAttributed, false);

    // An UNESTABLISHED companion verdict: the daemon→transport hop is
    // independently adjudicated and stays established — never lost to the
    // first hop's failure.
    const unestablishedCompanion = { class: 'os-live-observation', status: 'unestablished', reason: 'liveness-read-failed', observation: null, readEpochMs: 900 };
    const preserved = joinAncestryHops({ nonce: NONCE, companionObservation: unestablishedCompanion, daemonObservation: establishedObservation(daemon, 2600), transportMarker, markerEpochMs: 2500 });
    assert.deepEqual(preserved.hops.map((hop) => [hop.status, hop.reason]), [
      ['unestablished', 'hop-endpoint-unestablished'],
      ['established', null],
    ], 'each hop is adjudicated independently from its own endpoints');
    assert.equal(preserved.companionToTransportAttributed, false, 'the attribution never crosses the unestablished companion hop');
    // Malformed input (a non os-live-observation object) still throws.
    assert.throws(() => joinAncestryHops({ nonce: NONCE, companionObservation: { class: 'startup-identity', status: 'established', readEpochMs: 1 }, daemonObservation: null, transportMarker }), /os-live-observation/u);
  });

  test('input validation of the ancestry join', () => {
    assert.throws(() => joinAncestryHops({ nonce: 'short', companionObservation: null, daemonObservation: null, transportMarker }), /64-hex/u);
    assert.throws(() => joinAncestryHops({ nonce: NONCE, companionObservation: establishedObservation(companion, 2500), daemonObservation: null, transportMarker: { pid: 1 } }), /marker/u);
    assert.throws(() => joinAncestryHops({ nonce: NONCE, companionObservation: null, daemonObservation: null, transportMarker, expectedTransportNonce: 'short' }), /64-hex/u);
    assert.throws(() => joinAncestryHops({
      nonce: NONCE,
      companionObservation: { class: 'startup-identity', status: 'established', readEpochMs: 1 },
      daemonObservation: null, transportMarker,
    }), /os-live-observation/u);
  });

  test('endpoint lifetimes anchor on the IDENTITY-READ instant — delayed completion never extends a captured generation', () => {
    // Round-28 finding 3: the Companion's whole-observation completion can
    // land long after its identity reads (delayed Linux boot-clock
    // resolution); a pid-reusing replacement creating the "daemon" inside
    // that window then passed the lifetime checks against the ORIGINAL
    // Companion. The lifetime horizon is the identity-READ instant:
    // asynchronous work that contributes no identity evidence never extends
    // a captured generation's verified lifetime.
    const delayedCompanion = establishedObservation(
      { pid: 5100, ppid: 4000, startIdentity: 'S-COMPANION', nonce: NONCE, startInstantEpochMs: 500 }, 3000);
    delayedCompanion.identityReadEpochMs = 1000;
    const replacementEraDaemon = establishedObservation(
      { pid: 5200, ppid: 5100, startIdentity: 'S-DAEMON', nonce: NONCE, startInstantEpochMs: 1500 }, 1600);
    replacementEraDaemon.identityReadEpochMs = 1600;
    const verdict = joinAncestryHops({
      nonce: NONCE,
      companionObservation: delayedCompanion,
      daemonObservation: replacementEraDaemon,
      transportMarker,
      markerEpochMs: 2000,
    });
    const hop = verdict.hops.find((entry) => entry.hop === 'companion-to-daemon');
    assert.equal(hop.status, 'unestablished', 'the daemon was created after the Companion\'s identity evidence closed');
    assert.equal(hop.reason, 'generation-lifetime-unverifiable');
    // Without the carried identity-read instant the whole-observation
    // completion stays the fallback (the pre-round-28 fixture shape).
    const fallbackCompanion = establishedObservation(
      { pid: 5100, ppid: 4000, startIdentity: 'S-COMPANION', nonce: NONCE, startInstantEpochMs: 500 }, 3000);
    const fallbackVerdict = joinAncestryHops({
      nonce: NONCE,
      companionObservation: fallbackCompanion,
      daemonObservation: replacementEraDaemon,
      transportMarker,
      markerEpochMs: 2000,
    });
    const fallbackHop = fallbackVerdict.hops.find((entry) => entry.hop === 'companion-to-daemon');
    assert.equal(fallbackHop.status, 'established', 'the fallback (no identityReadEpochMs) keeps the pre-round-28 semantics');
  });

  test('the bounded local-duty verdict settles only when every applicable local identity is positively established', () => {
    const invocationFact = { startupRecord: { status: 'established', identity: { pid: 5100, nonce: NONCE, role: 'invocation', firstWriteEpochMs: 1900, startOriginMs: 1000.1, firstWritePreciseMs: 1000.3 } }, osObservation: establishedObservation(companion, 2500) };
    const brokerFact = { startupRecord: { status: 'established', identity: { pid: 5200, nonce: NONCE, role: 'broker-daemon', firstWriteEpochMs: 1900, startOriginMs: 1000.2, firstWritePreciseMs: 1000.4 } }, osObservation: establishedObservation(daemon, 2600) };
    const transportFact = { startupRecord: null, osObservation: establishedObservation({ ...transportMarker, startIdentity: 'proc:42' }, 1020) };
    const settled = adjudicateLocalDuties({ nonce: NONCE, invocation: invocationFact, broker: brokerFact, transport: transportFact, identifiedDescendants: [] });
    assert.equal(settled.class, 'local-duty-verdict');
    assert.equal(settled.settled, true);
    assert.deepEqual(settled.duties.map((duty) => duty.duty), ['invocation-process', 'broker-daemon', 'transport-descendant']);
    assert.ok(settled.duties.every((duty) => duty.status === 'established' && duty.reasons.length === 0));
    assert.deepEqual(settled.duties[0].identity, { pid: 5100, startIdentity: 'S-COMPANION', nonce: NONCE });

    // A missing broker fact keeps the whole verdict unsettled with named reasons.
    const noBroker = adjudicateLocalDuties({ nonce: NONCE, invocation: invocationFact, broker: null, transport: transportFact, identifiedDescendants: [] });
    assert.equal(noBroker.settled, false);
    const brokerDuty = noBroker.duties.find((duty) => duty.duty === 'broker-daemon');
    assert.equal(brokerDuty.status, 'unestablished');
    assert.deepEqual(brokerDuty.reasons, ['no-fact-supplied']);
    assert.equal(noBroker.duties.find((duty) => duty.duty === 'invocation-process').status, 'established');

    // A startup record whose pid the OS observation does not confirm never joins.
    const mismatched = adjudicateLocalDuties({
      nonce: NONCE,
      invocation: { startupRecord: { status: 'established', identity: { pid: 5100, nonce: NONCE, role: 'invocation', firstWriteEpochMs: 1900, startOriginMs: 1000.1, firstWritePreciseMs: 1000.3 } }, osObservation: establishedObservation({ ...companion, pid: 5555 }, 1000) },
      broker: brokerFact, transport: transportFact, identifiedDescendants: [],
    });
    assert.equal(mismatched.settled, false);
    assert.deepEqual(mismatched.duties.find((duty) => duty.duty === 'invocation-process').reasons, ['pid-join-mismatch']);

    // A supplied identified descendant is its own duty and gates settled.
    const liveDescendant = adjudicateLocalDuties({
      nonce: NONCE,
      invocation: invocationFact, broker: brokerFact, transport: transportFact,
      identifiedDescendants: [{ label: 'extra-scope-process', osObservation: establishedObservation({ pid: 5400, ppid: 5100, startIdentity: 'S-EXTRA', nonce: NONCE }, 1030) }],
    });
    assert.equal(liveDescendant.settled, false, 'a live positively identified descendant is an outstanding local duty');
    const descendantDuty = liveDescendant.duties.find((duty) => duty.duty === 'identified-descendant');
    assert.equal(descendantDuty.status, 'established', 'the descendant duty itself is positively established');
    assert.equal(descendantDuty.identity.pid, 5400);
    // The same descendant positively adjudicated GONE lets the verdict settle.
    const goneDescendant = adjudicateLocalDuties({
      nonce: NONCE,
      invocation: invocationFact, broker: brokerFact, transport: transportFact,
      identifiedDescendants: [{
        label: 'extra-scope-process',
        osObservation: establishedObservation({ pid: 5400, ppid: 5100, startIdentity: 'S-EXTRA', nonce: NONCE }, 1030),
        exit: { class: 'exit-absence', status: 'disappeared', reason: null, boundIdentity: { pid: 5400, startIdentity: 'S-EXTRA', nonce: NONCE }, lastVerifiedPresenceEpochMs: 1030, firstVerifiedAbsenceEpochMs: 2000, exitCorroboratedByMeta: false },
      }],
    });
    assert.equal(goneDescendant.settled, true, 'a positively adjudicated descendant disappearance completes the local duty');
    assert.equal(goneDescendant.duties.find((duty) => duty.duty === 'identified-descendant').exitStatus, 'disappeared');

    // A transport is established by its marker-captured OS observation alone.
    const transportOnly = adjudicateLocalDuties({ nonce: NONCE, invocation: invocationFact, broker: brokerFact, transport: { startupRecord: null, osObservation: establishedObservation({ ...transportMarker, startIdentity: 'proc:42' }, 1020) }, identifiedDescendants: [] });
    assert.equal(transportOnly.duties.find((duty) => duty.duty === 'transport-descendant').status, 'established',
      'the transport establishment rides the existing marker machinery, not the invocation startup record');
  });

  test('a descendant exit adjudication for ANOTHER process never completes the local duty', () => {
    /** @param {{ pid: number, ppid: number, startIdentity: string, nonce: string }} observation */
    const obs = (observation, epochMs) => ({
      localProcessObservationVersion: 1, class: 'os-live-observation', status: 'established',
      reason: null, observation: { ...observation, ppidChangedFromCapture: null }, readEpochMs: epochMs,
    });
    const invocationFact = { startupRecord: { status: 'established', identity: { pid: 5100, nonce: NONCE, role: 'invocation', firstWriteEpochMs: 1900, startOriginMs: 1000.1, firstWritePreciseMs: 1000.3 } }, osObservation: obs(companion, 2000) };
    const brokerFact = { startupRecord: { status: 'established', identity: { pid: 5200, nonce: NONCE, role: 'broker-daemon', firstWriteEpochMs: 1900, startOriginMs: 1000.2, firstWritePreciseMs: 1000.4 } }, osObservation: obs(daemon, 2010) };
    const transportFact = { startupRecord: null, osObservation: obs({ ...transportMarker, startIdentity: 'proc:42' }, 1020) };
    // A valid disappearance adjudication FOR ANOTHER PROCESS (PID 9999,
    // foreign start identity and nonce) supplied for the LIVE descendant
    // (PID 5400): the exit evidence must not be credited to 5400.
    const foreignExit = {
      class: 'exit-absence', status: 'disappeared', reason: null,
      boundIdentity: { pid: 9999, startIdentity: 'S-OTHER', nonce: 'd'.repeat(64) },
      lastVerifiedPresenceEpochMs: 1030, firstVerifiedAbsenceEpochMs: 2000, exitCorroboratedByMeta: false,
    };
    const verdict = adjudicateLocalDuties({
      nonce: NONCE,
      invocation: invocationFact, broker: brokerFact, transport: transportFact,
      identifiedDescendants: [{ label: 'extra-scope-process', osObservation: obs({ pid: 5400, ppid: 5100, startIdentity: 'S-EXTRA', nonce: NONCE }, 1030), exit: foreignExit }],
    });
    assert.equal(verdict.settled, false, 'another process\'s disappearance never completes this descendant\'s outstanding duty');
    const duty = verdict.duties.find((entry) => entry.duty === 'identified-descendant');
    assert.equal(duty.status, 'established', 'the descendant identity remains positively established');
    assert.equal(duty.exitStatus, 'disappeared', 'the supplied exit status is projected as supplied — uncredited');

    // The matching identity (same pid, start identity and nonce) IS credited.
    const matchingExit = {
      class: 'exit-absence', status: 'disappeared', reason: null,
      boundIdentity: { pid: 5400, startIdentity: 'S-EXTRA', nonce: NONCE },
      lastVerifiedPresenceEpochMs: 1030, firstVerifiedAbsenceEpochMs: 2000, exitCorroboratedByMeta: false,
    };
    const matched = adjudicateLocalDuties({
      nonce: NONCE,
      invocation: invocationFact, broker: brokerFact, transport: transportFact,
      identifiedDescendants: [{ label: 'extra-scope-process', osObservation: obs({ pid: 5400, ppid: 5100, startIdentity: 'S-EXTRA', nonce: NONCE }, 1030), exit: matchingExit }],
    });
    assert.equal(matched.settled, true, 'the descendant\'s OWN disappearance completes the duty');
  });

  test('one process never attests another role: each startup-backed duty requires its own admitted role', () => {
    const obs = (observation, epochMs) => ({
      localProcessObservationVersion: 1, class: 'os-live-observation', status: 'established',
      reason: null, observation: { ...observation, ppidChangedFromCapture: null }, readEpochMs: epochMs,
    });
    const transportFact = { startupRecord: null, osObservation: obs({ ...transportMarker, startIdentity: 'proc:42' }, 1020) };
    // ONE established INVOCATION fact supplied as BOTH duties: the
    // invocation duty joins; the broker duty must refuse — a broker duty
    // requires a BROKER-role record.
    const invocationFact = {
      startupRecord: { status: 'established', identity: { pid: 5100, nonce: NONCE, role: 'invocation', firstWriteEpochMs: 1900, startOriginMs: 1000.1, firstWritePreciseMs: 1000.3 } },
      osObservation: obs(companion, 2000),
    };
    const both = adjudicateLocalDuties({ nonce: NONCE, invocation: invocationFact, broker: invocationFact, transport: transportFact, identifiedDescendants: [] });
    assert.equal(both.settled, false, 'an invocation fact never establishes the broker duty');
    assert.equal(both.duties.find((entry) => entry.duty === 'invocation-process').status, 'established');
    const brokerDuty = both.duties.find((entry) => entry.duty === 'broker-daemon');
    assert.equal(brokerDuty.status, 'unestablished');
    assert.ok(brokerDuty.reasons.includes('startup-role-mismatch'), 'the role mismatch is the named reason');

    // Symmetric: a BROKER-role record never attests the invocation duty,
    // while the broker duty it belongs to stays established.
    const brokerFact = {
      startupRecord: { status: 'established', identity: { pid: 5200, nonce: NONCE, role: 'broker-daemon', firstWriteEpochMs: 1900, startOriginMs: 1000.2, firstWritePreciseMs: 1000.4 } },
      osObservation: obs(daemon, 2010),
    };
    const swapped = adjudicateLocalDuties({ nonce: NONCE, invocation: brokerFact, broker: brokerFact, transport: transportFact, identifiedDescendants: [] });
    assert.equal(swapped.duties.find((entry) => entry.duty === 'invocation-process').status, 'unestablished');
    assert.equal(swapped.duties.find((entry) => entry.duty === 'broker-daemon').status, 'established');
  });

  test('a descendant exit whose absence is not strictly after the descendant observation is never credited', () => {
    const obs = (observation, epochMs) => ({
      localProcessObservationVersion: 1, class: 'os-live-observation', status: 'established',
      reason: null, observation: { ...observation, ppidChangedFromCapture: null }, readEpochMs: epochMs,
    });
    const invocationFact = { startupRecord: { status: 'established', identity: { pid: 5100, nonce: NONCE, role: 'invocation', firstWriteEpochMs: 1900, startOriginMs: 1000.1, firstWritePreciseMs: 1000.3 } }, osObservation: obs(companion, 2000) };
    const brokerFact = { startupRecord: { status: 'established', identity: { pid: 5200, nonce: NONCE, role: 'broker-daemon', firstWriteEpochMs: 1900, startOriginMs: 1000.2, firstWritePreciseMs: 1000.4 } }, osObservation: obs(daemon, 2010) };
    const transportFact = { startupRecord: null, osObservation: obs({ ...transportMarker, startIdentity: 'proc:42' }, 1020) };
    // Class sweep (ordering): even with a perfectly matching bound identity,
    // an exit whose absence instant is NOT strictly after the descendant's
    // own observed presence (1030) is ordering-impossible evidence — a tie
    // or earlier absence can never complete the duty.
    const backwardsExit = {
      class: 'exit-absence', status: 'disappeared', reason: null,
      boundIdentity: { pid: 5400, startIdentity: 'S-EXTRA', nonce: NONCE },
      lastVerifiedPresenceEpochMs: 200, firstVerifiedAbsenceEpochMs: 500, exitCorroboratedByMeta: false,
    };
    const verdict = adjudicateLocalDuties({
      nonce: NONCE,
      invocation: invocationFact, broker: brokerFact, transport: transportFact,
      identifiedDescendants: [{ label: 'extra-scope-process', osObservation: obs({ pid: 5400, ppid: 5100, startIdentity: 'S-EXTRA', nonce: NONCE }, 1030), exit: backwardsExit }],
    });
    assert.equal(verdict.settled, false, 'an absence not strictly after the descendant observation is never credited');
    assert.equal(verdict.duties.find((entry) => entry.duty === 'identified-descendant').status, 'established');
  });

  test('a descendant exit confirmed inside the completion window completes the duty — the presence horizon is the identity-READ instant', () => {
    // Round-30 finding 2: delayed Linux boot-clock resolution can finish an
    // observation long after its identity reads; a concurrent absence
    // confirmed AFTER the identity reads but BEFORE the completion was
    // correctly `disappeared` in adjudicateLocalExit (round-28 ordering) yet
    // THIS comparison still rejected it against the whole-observation
    // completion, leaving the aggregate unsettled. The descendant's presence
    // horizon anchors on its identity-READ instant (legacy fallback kept) —
    // consistently with the exit adjudicator.
    const obs = (observation, epochMs) => ({
      localProcessObservationVersion: 1, class: 'os-live-observation', status: 'established',
      reason: null, observation: { ...observation, ppidChangedFromCapture: null }, readEpochMs: epochMs,
    });
    const invocationFact = { startupRecord: { status: 'established', identity: { pid: 5100, nonce: NONCE, role: 'invocation', firstWriteEpochMs: 1900, startOriginMs: 1000.1, firstWritePreciseMs: 1000.3 } }, osObservation: obs(companion, 2000) };
    const brokerFact = { startupRecord: { status: 'established', identity: { pid: 5200, nonce: NONCE, role: 'broker-daemon', firstWriteEpochMs: 1900, startOriginMs: 1000.2, firstWritePreciseMs: 1000.4 } }, osObservation: obs(daemon, 2010) };
    const transportFact = { startupRecord: null, osObservation: obs({ ...transportMarker, startIdentity: 'proc:42' }, 1020) };
    const delayedDescendant = obs({ pid: 5400, ppid: 5100, startIdentity: 'S-EXTRA', nonce: NONCE }, 4000);
    delayedDescendant.identityReadEpochMs = 2000;
    const lawfulExit = {
      class: 'exit-absence', status: 'disappeared', reason: null,
      boundIdentity: { pid: 5400, startIdentity: 'S-EXTRA', nonce: NONCE },
      lastVerifiedPresenceEpochMs: 2000, firstVerifiedAbsenceEpochMs: 3000, exitCorroboratedByMeta: false,
    };
    const verdict = adjudicateLocalDuties({
      nonce: NONCE,
      invocation: invocationFact, broker: brokerFact, transport: transportFact,
      identifiedDescendants: [{ label: 'extra-scope-process', osObservation: delayedDescendant, exit: lawfulExit }],
    });
    assert.equal(verdict.settled, true, 'the absence is strictly after the identity-READ instant — the duty completes');
    // The ordering refusal itself is unchanged: an absence at or before the
    // identity-READ instant never completes the duty.
    const backwardsExit = { ...lawfulExit, firstVerifiedAbsenceEpochMs: 2000 };
    const backwards = adjudicateLocalDuties({
      nonce: NONCE,
      invocation: invocationFact, broker: brokerFact, transport: transportFact,
      identifiedDescendants: [{ label: 'extra-scope-process', osObservation: delayedDescendant, exit: backwardsExit }],
    });
    assert.equal(backwards.settled, false, 'a tie with the identity-READ instant is still ordering-impossible');
    // Legacy fallback: a descendant observation without the carried instant
    // keeps the whole-observation-completion horizon.
    const legacyDescendant = obs({ pid: 5500, ppid: 5100, startIdentity: 'S-EXTRA2', nonce: NONCE }, 2500);
    const legacyExit = {
      class: 'exit-absence', status: 'disappeared', reason: null,
      boundIdentity: { pid: 5500, startIdentity: 'S-EXTRA2', nonce: NONCE },
      lastVerifiedPresenceEpochMs: 2500, firstVerifiedAbsenceEpochMs: 2400, exitCorroboratedByMeta: false,
    };
    const legacy = adjudicateLocalDuties({
      nonce: NONCE,
      invocation: invocationFact, broker: brokerFact, transport: transportFact,
      identifiedDescendants: [{ label: 'extra-scope-process', osObservation: legacyDescendant, exit: legacyExit }],
    });
    assert.equal(legacy.settled, false, 'the fallback horizon is the completion (2400 <= 2500 refuses)');
  });

  test('darwin lstart is collected and parsed in EXPLICIT UTC — the fall-back hour cannot skew the start instant', async () => {
    // Round-31 finding 2: ps renders lstart in LOCAL time without an offset;
    // during a DST fall-back hour that rendering is ambiguous and host-local
    // Date.parse picks the earlier occurrence of the repeated hour
    // (America/New_York: a process started at 06:30Z renders
    // 'Sun Nov  2 01:30:00' which parses as 06:30Z-EST vs the 01:30Z the
    // fields read) — a genuine process failed the startup-generation join by
    // an hour. The real reader requests TZ=UTC and the parse is
    // field-explicit UTC: the resolved instant is exactly the UTC
    // interpretation of the rendered fields, deterministically (the injected
    // seam fixes the rendered text; no real DST is awaited).
    const { observeLocalProcess, adjudicateLocalDuties } = await import('../tools/shell-wait-probe/local-process-observation.mjs');
    const lstart = 'Sun Nov  2 01:30:00 2025';
    const expectedUtcMs = Date.UTC(2025, 10, 2, 1, 30, 0);
    // The seams ride the INPUT osSeams (the module-level seam discipline):
    // the platform seam reaches the start-instant resolution too, so a
    // darwin-seamed observation resolves its lstart on ANY host.
    const observation = await observeLocalProcess({
      pid: 4_194_303, nonce: NONCE, nowEpochMs: expectedUtcMs + 5000,
      osSeams: { platform: 'darwin', ps: async () => ({ pid: 4_194_303, ppid: 4000, lstart }), environ: 'present' },
    });
    assert.equal(observation.status, 'established');
    assert.equal(observation.observation.startInstantEpochMs, expectedUtcMs,
      'the rendered fields parse as exactly their UTC interpretation');
    // The end-to-end consequence: a startup record written inside that same
    // second BINDS (the skewed instant failed the second containment).
    const verdict = adjudicateLocalDuties({
      nonce: NONCE,
      invocation: {
        startupRecord: { status: 'established', identity: { pid: 4_194_303, nonce: NONCE, role: 'invocation', startOriginMs: expectedUtcMs + 100.5, firstWritePreciseMs: expectedUtcMs + 150.5, firstWriteEpochMs: expectedUtcMs } },
        osObservation: observation,
      },
      broker: null, transport: null, identifiedDescendants: [],
    });
    const duty = verdict.duties.find((entry) => entry.duty === 'invocation-process');
    assert.equal(duty.status, 'established', 'the genuine process binds its startup record');
  });

  test('a fork just before a second boundary binds: the OS creation second may precede the Node-init second', () => {
    // Round-8 finding 1: a process FORKED just before a boundary whose Node
    // initializes just after has timeOrigin in the NEXT second — ordinary
    // startup timing, not PID reuse. The darwin containment accepts the OS
    // creation second OR the immediately preceding one; the residual window
    // (a successor forked in that same two-second span after the write) is
    // the documented named bound.
    const obs = (observation, epochMs) => ({
      localProcessObservationVersion: 1, class: 'os-live-observation', status: 'established',
      reason: null, observation: { ...observation, ppidChangedFromCapture: null }, readEpochMs: epochMs,
    });
    const transportFact = { startupRecord: null, osObservation: obs({ ...transportMarker, startIdentity: 'proc:42' }, 1020) };
    const brokerFact = {
      startupRecord: { status: 'established', identity: { pid: 5200, nonce: NONCE, role: 'broker-daemon', startOriginMs: 1000.25, firstWritePreciseMs: 1000.4, firstWriteEpochMs: 1000 } },
      osObservation: obs(daemon, 2010),
    };
    // timeOrigin 2000.05 (Node-init second 2000); OS creation second 1000
    // (forked just before the boundary): the PRECEDING-second containment.
    const forkBeforeBoundary = adjudicateLocalDuties({
      nonce: NONCE,
      invocation: {
        startupRecord: { status: 'established', identity: { pid: 5100, nonce: NONCE, role: 'invocation', startOriginMs: 2000.05, firstWritePreciseMs: 2000.2, firstWriteEpochMs: 2000 } },
        osObservation: obs({ pid: 5100, ppid: 4000, startIdentity: 'S-FORKED', nonce: NONCE, startInstantEpochMs: 1000 }, 2100),
      },
      broker: brokerFact, transport: transportFact, identifiedDescendants: [],
    });
    const duty = forkBeforeBoundary.duties.find((entry) => entry.duty === 'invocation-process');
    assert.equal(duty.status, 'established', 'the fork-before-boundary writer binds through the preceding-second containment');
    assert.deepEqual(duty.reasons, []);
    // Two seconds before: OUTSIDE the bounded window — named mismatch.
    const farAway = adjudicateLocalDuties({
      nonce: NONCE,
      invocation: {
        startupRecord: { status: 'established', identity: { pid: 5100, nonce: NONCE, role: 'invocation', startOriginMs: 2000.05, firstWritePreciseMs: 2000.2, firstWriteEpochMs: 2000 } },
        osObservation: obs({ pid: 5100, ppid: 4000, startIdentity: 'S-FAR', nonce: NONCE, startInstantEpochMs: 3000 }, 2100),
      },
      broker: brokerFact, transport: transportFact, identifiedDescendants: [],
    });
    assert.deepEqual(farAway.duties.find((entry) => entry.duty === 'invocation-process').reasons, ['generation-start-second-mismatch'],
      'an OS creation second outside the bounded containment is named');
  });

  test('the Linux start-instant resolution completes BEFORE the verdict completion timestamp', async () => {
    const { observeLocalProcess } = await import('../tools/shell-wait-probe/local-process-observation.mjs');
    // Round-9 finding 2: on Linux the start-instant resolution awaits
    // /proc-stat/boot-clock work; the verdict completion must be sampled
    // only AFTER that resolution — never the pre-resolution sample.
    const before = Date.now();
    const verdict = await observeLocalProcess({
      pid: 4_194_303, nonce: 'b'.repeat(64),
      inspect: async () => ({ pid: 4_194_303, ppid: 4000, startIdentity: 'proc:4242', nonce: 'b'.repeat(64) }),
      linuxClock: {
        clock: (async () => {
          await new Promise((resolve) => setTimeout(resolve, 40));
          return { btimeMs: 1700000000000, hz: 100 };
        })(),
      },
    });
    assert.equal(verdict.status, 'established');
    assert.equal(verdict.observation.startInstantEpochMs, 1700000000000 + 42420);
    assert.ok(Number.isSafeInteger(verdict.readStartedEpochMs) && verdict.readStartedEpochMs <= before + 10,
      'the started sample precedes the inspection');
    assert.ok(verdict.readEpochMs >= before + 35,
      'the completion instant covers the start-instant resolution await as well');
  });

  test('Linux btime whole-second uncertainty: a successor created inside the uncertainty window is refused or ambiguous, never established', async () => {
    // Round-12 finding: /proc/stat btime is WHOLE SECONDS — the computed
    // creation instant can be almost a second EARLY (the boot's fractional
    // offset is lost), so the TRUE creation lies in [computed, computed+1000).
    // With an 800 ms boot offset, a same-nonce successor created 440 ms AFTER
    // the record write has computed instant 440 ms BEFORE the write — the old
    // rule bound it as the writer. The uncertainty window must be honored.
    const { observeLocalProcess } = await import('../tools/shell-wait-probe/local-process-observation.mjs');
    const scopeNonce = 'b'.repeat(64);
    const identity = { pid: 5100, nonce: scopeNonce, role: 'invocation', startOriginMs: 1700000000000, firstWritePreciseMs: 1700000000100, firstWriteEpochMs: 1700000000000 };
    // btime whole-second: btimeMs = 1700000000000 - 800 (the boot's fractional
    // offset lost by truncation); the target's ticks place its computed
    // creation at 1699999999700 — 400ms BEFORE the record write — while its
    // TRUE creation (computed + 800ms fractional offset) is 1700000000500,
    // AFTER the write.
    const live = await observeLocalProcess({
      pid: 5100, nonce: scopeNonce,
      inspect: async () => ({ pid: 5100, ppid: 4000, startIdentity: 'proc:42', nonce: scopeNonce }),
      linuxClock: { clock: { btimeMs: 1699999999200, hz: 100 } },
    });
    assert.equal(live.status, 'established');
    const computedCreation = live.observation.startInstantEpochMs;
    assert.equal(computedCreation, 1699999999620, 'the computed instant is btime + ticks/CLK_TCK (whole-second btime, fractional offset lost)');
    const joinVerdict = await (await import('../tools/shell-wait-probe/local-process-observation.mjs')).adjudicateLocalDuties({
      nonce: scopeNonce,
      invocation: {
        startupRecord: { status: 'established', identity: { ...identity } },
        osObservation: live,
      },
      broker: null, transport: null, identifiedDescendants: [],
    });
    const duty = joinVerdict.duties.find((entry) => entry.duty === 'invocation-process');
    assert.notEqual(duty.status, 'established',
      'a successor whose TRUE creation may postdate the write is never established-by-default');
    assert.ok(
      duty.reasons.includes('generation-start-ambiguous') || duty.reasons.includes('generation-start-after-write'),
      `the uncertainty is named (got: ${duty.reasons.join(',')})`,
    );
  });

  test('a REPARENTED process (ppid-only mid-read change) adjudicates its confirmed absence normally — never latched as reuse', async () => {
    // Round-24 finding: the REAL inspector threw ONE generic 'identity
    // changed' message for BOTH a changed start identity AND a ppid-only
    // change, so round-23's regex misclassified ordinary reparenting (the
    // daemon whose Companion dies) as the reuse class — permanently blocking
    // the reparented process's disappearance adjudication. The inspector now
    // throws SELF-DESCRIBING errors, and the reparenting case is driven
    // through the REAL inspect implementation with injected OS seams.
    const { inspectVerifiedProcessIdentity, observeLocalProcess, adjudicateLocalExit } = await import('../tools/shell-wait-probe/local-process-observation.mjs');
    // The real double-read over injected OS seams: the first ps read reports
    // ppid 4000, the marker read says present, the second ps read reports
    // ppid 1 (reparented) — start identity IDENTICAL.
    const psReads = [
      { pid: 4_194_303, ppid: 4000, lstart: 'Thu Jan  1 00:00:00 2026' },
      { pid: 4_194_303, ppid: 1, lstart: 'Thu Jan  1 00:00:00 2026' },
    ];
    let read = 0;
    const inspectWith = (osSeams) => () => inspectVerifiedProcessIdentity(4_194_303, 'b'.repeat(64), 'ZCODE_SHELL_WAIT_CAPTURE_NONCE', osSeams);
    const seams = {
      platform: 'darwin',
      ps: async () => (read++ === 0 ? psReads[0] : psReads[1]),
      environ: 'present',
    };
    const reparented = await observeLocalProcess({
      pid: 4_194_303, nonce: 'b'.repeat(64), nowEpochMs: 2500, expectedStartIdentity: 'S1',
      inspect: inspectWith(seams),
    });
    assert.equal(reparented.status, 'unestablished', 'the reparented mid-read state is unestablished');
    assert.equal(reparented.reason, 'liveness-read-failed',
      'REparenting alone stays in the generic torn class — never the reuse class');
    // The reparented observation followed by a CONFIRMED absence adjudicates
    // the absence normally — never latched into pid-start-identity-reused.
    const live = await observeLocalProcess({
      pid: 4_194_303, nonce: 'b'.repeat(64), nowEpochMs: 1000,
      inspect: async () => ({ pid: 4_194_303, ppid: 4000, startIdentity: 'S1', nonce: 'b'.repeat(64) }),
    });
    const absence = await observeLocalProcess({ pid: 4_194_303, nonce: 'b'.repeat(64), nowEpochMs: 3000, inspect: async () => undefined });
    const exit = await adjudicateLocalExit({ presence: live, absenceReads: [reparented, absence] });
    assert.equal(exit.status, 'disappeared', 'the confirmed absence adjudicates normally — never latched');
    assert.equal(exit.reason, null);
    assert.equal(exit.firstVerifiedAbsenceEpochMs, 3000);

    // NO OVER-CORRECTION: the start-identity-change case still latches (the
    // real inspector's identity-changed error keeps its own class).
    let psCall = 0;
    const identityChangeSeams = {
      platform: 'darwin',
      ps: async () => (psCall++ === 0 ? psReads[0] : { ...psReads[1], lstart: 'Fri Jan  2 00:00:00 2026' }),
      environ: 'present',
    };
    const identityChanged = await observeLocalProcess({
      pid: 4_194_303, nonce: 'b'.repeat(64), nowEpochMs: 2500, expectedStartIdentity: 'S1',
      inspect: inspectWith(identityChangeSeams),
    });
    assert.equal(identityChanged.reason, 'start-identity-generation-changed',
      'the start-identity change keeps its own named class');
    const latched = await adjudicateLocalExit({ presence: live, absenceReads: [identityChanged, absence] });
    assert.equal(latched.status, 'unestablished');
    assert.equal(latched.reason, 'pid-start-identity-reused', 'the start-identity reuse still latches');
    assert.equal(latched.firstVerifiedAbsenceEpochMs, null);
  });

  test('an environment-NONCE mismatch is a named non-reuse fact — the confirmed absence still adjudicates', async () => {
    // Round-25 finding: the nonce-mismatch throw ALSO carried 'identity
    // changed', so the regex labeled a nonce-verification failure as proven
    // PID reuse and adjudicateLocalExit permanently latched it — verified
    // presence A -> nonce mismatch -> verified same-generation presence ->
    // confirmed absence incorrectly stayed pid-start-identity-reused. A
    // nonce mismatch is now its OWN named non-reuse class; only an OBSERVED
    // OS start-identity change is generation-change evidence.
    const { inspectVerifiedProcessIdentity, observeLocalProcess, adjudicateLocalExit } = await import('../tools/shell-wait-probe/local-process-observation.mjs');
    // Round-27 refinement of this fixture: the mismatch read's observed
    // start identity now RIDES the verdict and the exit adjudicator compares
    // it with the BOUND generation — so the non-latching arm must be
    // SAME-generation (lstart 'S1', the bound identity). A mismatch read
    // that observed a DIFFERENT start identity is positive replacement
    // evidence and latches (the round-27 test covers that shape).
    const psReads = [
      { pid: 4_194_303, ppid: 4000, lstart: 'S1' },
      { pid: 4_194_303, ppid: 4000, lstart: 'S1' },
    ];
    let psCall = 0;
    const nonceMismatchInspect = () => inspectVerifiedProcessIdentity(4_194_303, 'b'.repeat(64), 'ZCODE_SHELL_WAIT_CAPTURE_NONCE', {
      platform: 'darwin',
      ps: async () => psReads[psCall++ % 2],
      environ: 'mismatch',
    });
    const nonceMismatch = await observeLocalProcess({
      pid: 4_194_303, nonce: 'b'.repeat(64), nowEpochMs: 2000,
      inspect: nonceMismatchInspect,
    });
    assert.equal(nonceMismatch.status, 'unestablished', 'the nonce-mismatch failure is named uncertainty');
    assert.equal(nonceMismatch.reason, 'liveness-read-failed', 'it maps to the non-reuse torn class — never the reuse class');
    assert.equal(nonceMismatch.observation, null);
    // The full sequence: presence A -> nonce mismatch -> same-generation
    // presence -> confirmed absence adjudicates the absence normally.
    const live = await observeLocalProcess({
      pid: 4_194_303, nonce: 'b'.repeat(64), nowEpochMs: 1000,
      inspect: async () => ({ pid: 4_194_303, ppid: 4000, startIdentity: 'S1', nonce: 'b'.repeat(64) }),
    });
    const liveAgain = await observeLocalProcess({
      pid: 4_194_303, nonce: 'b'.repeat(64), nowEpochMs: 2500,
      inspect: async () => ({ pid: 4_194_303, ppid: 4000, startIdentity: 'S1', nonce: 'b'.repeat(64) }),
    });
    const absence = await observeLocalProcess({ pid: 4_194_303, nonce: 'b'.repeat(64), nowEpochMs: 3000, inspect: async () => undefined });
    const exit = await adjudicateLocalExit({ presence: live, absenceReads: [nonceMismatch, liveAgain, absence] });
    assert.equal(exit.status, 'disappeared', 'the confirmed absence adjudicates normally — the nonce failure never latches');
    assert.equal(exit.reason, null);
    assert.equal(exit.firstVerifiedAbsenceEpochMs, 3000);
    // Class sweep: an OBSERVED start-identity change is still the reuse class.
    const psReadsChange = [
      { pid: 4_194_303, ppid: 4000, lstart: 'Thu Jan  1 00:00:00 2026' },
      { pid: 4_194_303, ppid: 4000, lstart: 'Fri Jan  2 00:00:00 2026' },
    ];
    let changeCall = 0;
    const identityChange = await observeLocalProcess({
      pid: 4_194_303, nonce: 'b'.repeat(64), nowEpochMs: 2000,
      inspect: () => inspectVerifiedProcessIdentity(4_194_303, 'b'.repeat(64), 'ZCODE_SHELL_WAIT_CAPTURE_NONCE', {
        platform: 'darwin',
        ps: async () => psReadsChange[changeCall++ % 2],
        environ: 'present',
      }),
    });
    assert.equal(identityChange.reason, 'start-identity-generation-changed', 'the observed start-identity change keeps the reuse class');
    const latched = await adjudicateLocalExit({ presence: live, absenceReads: [identityChange, absence] });
    assert.equal(latched.status, 'unestablished');
    assert.equal(latched.reason, 'pid-start-identity-reused', 'the observed start-identity change still latches');
  });

  test('a nonce mismatch with an OBSERVED different start identity latches reuse — never read-torn', async () => {
    // Round-26 finding 1: a PID reused by a process WITHOUT the capture
    // nonce makes the marker read report mismatch while the OS read carries
    // the REPLACEMENT's start identity. Discarding that identity made the
    // verdict a plain read failure, and a subsequent absence returned
    // `disappeared` for the original generation. The observed start identity
    // is preserved on the failure and compared with the expected generation:
    // demonstrably different -> the reuse class (latched).
    const { inspectVerifiedProcessIdentity, observeLocalProcess, adjudicateLocalExit } = await import('../tools/shell-wait-probe/local-process-observation.mjs');
    const psReads = [
      { pid: 4_194_303, ppid: 4000, lstart: 'Thu Jan  1 00:00:00 2026' },
      { pid: 4_194_303, ppid: 4000, lstart: 'Thu Jan  1 00:00:00 2026' },
    ];
    let psCall = 0;
    const replacement = await observeLocalProcess({
      pid: 4_194_303, nonce: 'b'.repeat(64), nowEpochMs: 2000, expectedStartIdentity: 'S1',
      inspect: () => inspectVerifiedProcessIdentity(4_194_303, 'b'.repeat(64), 'ZCODE_SHELL_WAIT_CAPTURE_NONCE', {
        platform: 'darwin',
        ps: async () => psReads[psCall++ % 2],
        environ: 'mismatch',
      }),
    });
    assert.equal(replacement.status, 'unestablished');
    assert.equal(replacement.reason, 'start-identity-generation-changed',
      'the observed start identity differs from the expected generation — the reuse class');
    assert.equal(replacement.observation, null);
    const live = await observeLocalProcess({
      pid: 4_194_303, nonce: 'b'.repeat(64), nowEpochMs: 1000,
      inspect: async () => ({ pid: 4_194_303, ppid: 4000, startIdentity: 'S1', nonce: 'b'.repeat(64) }),
    });
    const absence = await observeLocalProcess({ pid: 4_194_303, nonce: 'b'.repeat(64), nowEpochMs: 3000, inspect: async () => undefined });
    const exit = await adjudicateLocalExit({ presence: live, absenceReads: [replacement, absence] });
    assert.equal(exit.status, 'unestablished', 'the reuse refusal survives the later absence');
    assert.equal(exit.reason, 'pid-start-identity-reused');
    assert.equal(exit.firstVerifiedAbsenceEpochMs, null);
    // SAME generation carrying the nonce failure (e.g. the nonce env lost):
    // stays the named nonce-failure fact and the absence adjudicates normally.
    const sameGenerationPsReads = [
      { pid: 4_194_303, ppid: 4000, lstart: 'S1' },
      { pid: 4_194_303, ppid: 4000, lstart: 'S1' },
    ];
    let sameGenCall = 0;
    const sameGeneration = await observeLocalProcess({
      pid: 4_194_303, nonce: 'b'.repeat(64), nowEpochMs: 2000, expectedStartIdentity: 'S1',
      inspect: () => inspectVerifiedProcessIdentity(4_194_303, 'b'.repeat(64), 'ZCODE_SHELL_WAIT_CAPTURE_NONCE', {
        platform: 'darwin',
        ps: async () => sameGenerationPsReads[sameGenCall++ % 2],
        environ: 'mismatch',
      }),
    });
    assert.equal(sameGeneration.reason, 'liveness-read-failed', 'a same-generation nonce failure stays the named nonce fact');
    const normalExit = await adjudicateLocalExit({ presence: live, absenceReads: [sameGeneration, absence] });
    assert.equal(normalExit.status, 'disappeared', 'the same-generation nonce failure never latches');
  });

  test('a nonce mismatch latches the BOUND generation even WITHOUT an expectedStartIdentity — the carried identity rides the verdict', async () => {
    // Round-27 finding 2: with the OPTIONAL expectedStartIdentity OMITTED,
    // the round-26 preservation had nothing to compare against and still
    // DISCARDED the replacement's observed start identity (a plain
    // liveness-read-failed) — presence S1 -> nonce-mismatched S2 -> absence
    // returned `disappeared` for S1. The observed start identity now RIDES
    // the nonce-failure verdict, and the exit adjudicator — which knows the
    // BOUND generation — classifies a demonstrably different carried
    // identity as positive replacement evidence and latches.
    const { inspectVerifiedProcessIdentity, observeLocalProcess, adjudicateLocalExit } = await import('../tools/shell-wait-probe/local-process-observation.mjs');
    const live = await observeLocalProcess({
      pid: 4_194_303, nonce: 'b'.repeat(64), nowEpochMs: 1000,
      inspect: async () => ({ pid: 4_194_303, ppid: 4000, startIdentity: 'S1', nonce: 'b'.repeat(64) }),
    });
    assert.equal(live.status, 'established');
    // The replacement read goes through the REAL double-read (injected OS
    // seams): the ps lstart S2 is the replacement's OS start identity, the
    // environ read reports the nonce mismatch, and NO expectedStartIdentity
    // is supplied to the observation.
    const replacement = await observeLocalProcess({
      pid: 4_194_303, nonce: 'b'.repeat(64), nowEpochMs: 2000,
      inspect: () => inspectVerifiedProcessIdentity(4_194_303, 'b'.repeat(64), 'ZCODE_SHELL_WAIT_CAPTURE_NONCE', {
        platform: 'darwin',
        ps: async () => ({ pid: 4_194_303, ppid: 4000, lstart: 'S2' }),
        environ: 'mismatch',
      }),
    });
    assert.equal(replacement.status, 'unestablished');
    assert.equal(replacement.reason, 'liveness-read-failed',
      'without an expected start identity the read stays the named nonce failure');
    assert.equal(replacement.observedStartIdentity, 'S2', 'the observed start identity rides the verdict for the adjudicator');
    const absence = await observeLocalProcess({ pid: 4_194_303, nonce: 'b'.repeat(64), nowEpochMs: 3000, inspect: async () => undefined });
    const exit = await adjudicateLocalExit({ presence: live, absenceReads: [replacement, absence] });
    assert.equal(exit.status, 'unestablished', 'the carried identity differs from the BOUND generation — positive replacement evidence');
    assert.equal(exit.reason, 'pid-start-identity-reused');
    assert.equal(exit.firstVerifiedAbsenceEpochMs, null);
    // A carried identity EQUAL to the bound generation is the same-generation
    // nonce failure: never latches, the absence adjudicates normally.
    const sameGeneration = await observeLocalProcess({
      pid: 4_194_303, nonce: 'b'.repeat(64), nowEpochMs: 2000,
      inspect: () => inspectVerifiedProcessIdentity(4_194_303, 'b'.repeat(64), 'ZCODE_SHELL_WAIT_CAPTURE_NONCE', {
        platform: 'darwin',
        ps: async () => ({ pid: 4_194_303, ppid: 4000, lstart: 'S1' }),
        environ: 'mismatch',
      }),
    });
    assert.equal(sameGeneration.observedStartIdentity, 'S1');
    const normalExit = await adjudicateLocalExit({ presence: live, absenceReads: [sameGeneration, absence] });
    assert.equal(normalExit.status, 'disappeared', 'a carried identity equal to the bound generation never latches');
  });

  test('a mid-read disappearance of a DIFFERENT occupant latches reuse — the first read\'s identity is never discarded', async () => {
    // Round-28 finding 1: a PID-reusing successor that exits between the
    // FIRST start-identity read and the marker/second read used to fall
    // through the inspector's early returns (marker-gone / absent second
    // read) as a bare undefined — discarding the identity the first read
    // positively observed. The absence then read as the BOUND generation's
    // lawful disappearance instead of the reuse latch. The observed identity
    // now rides the early return like the nonce-mismatch failure does.
    const { inspectVerifiedProcessIdentity, observeLocalProcess, adjudicateLocalExit } = await import('../tools/shell-wait-probe/local-process-observation.mjs');
    const live = await observeLocalProcess({
      pid: 4_194_303, nonce: 'b'.repeat(64), nowEpochMs: 1000,
      inspect: async () => ({ pid: 4_194_303, ppid: 4000, startIdentity: 'S1', nonce: 'b'.repeat(64) }),
    });
    assert.equal(live.status, 'established');
    // MARKER-GONE after a successful first read: the replacement's lstart S2
    // is observed, then the pid is gone before the environment read.
    const markerGone = await observeLocalProcess({
      pid: 4_194_303, nonce: 'b'.repeat(64), nowEpochMs: 2000, expectedStartIdentity: 'S1',
      inspect: () => inspectVerifiedProcessIdentity(4_194_303, 'b'.repeat(64), 'ZCODE_SHELL_WAIT_CAPTURE_NONCE', {
        platform: 'darwin',
        ps: async () => ({ pid: 4_194_303, ppid: 4000, lstart: 'S2' }),
        environ: 'gone',
      }),
    });
    assert.equal(markerGone.status, 'unestablished');
    assert.equal(markerGone.reason, 'start-identity-generation-changed',
      'the first read positively observed a different generation before the pid vanished');
    // ABSENT SECOND READ after a successful first read: the marker nonce is
    // present (scope-only evidence) but the pid is gone before the second
    // start-identity read.
    let secondCall = 0;
    const afterGone = await observeLocalProcess({
      pid: 4_194_303, nonce: 'b'.repeat(64), nowEpochMs: 2000, expectedStartIdentity: 'S1',
      inspect: () => inspectVerifiedProcessIdentity(4_194_303, 'b'.repeat(64), 'ZCODE_SHELL_WAIT_CAPTURE_NONCE', {
        platform: 'darwin',
        ps: async () => (secondCall++ === 0 ? { pid: 4_194_303, ppid: 4000, lstart: 'S2' } : undefined),
        environ: 'present',
      }),
    });
    assert.equal(afterGone.status, 'unestablished');
    assert.equal(afterGone.reason, 'start-identity-generation-changed',
      'the same ride on the absent-second-read path');
    const absence = await observeLocalProcess({ pid: 4_194_303, nonce: 'b'.repeat(64), nowEpochMs: 3000, inspect: async () => undefined });
    const latched = await adjudicateLocalExit({ presence: live, absenceReads: [markerGone, afterGone, absence] });
    assert.equal(latched.status, 'unestablished', 'the discarded-replacement shape can never return the original generation\'s disappearance');
    assert.equal(latched.reason, 'pid-start-identity-reused');
    assert.equal(latched.firstVerifiedAbsenceEpochMs, null);
    // The VERIFIED generation's OWN mid-read disappearance (first read S1,
    // then gone) stays the lawful positive absence fact.
    let ownCall = 0;
    const ownGone = await observeLocalProcess({
      pid: 4_194_303, nonce: 'b'.repeat(64), nowEpochMs: 2000, expectedStartIdentity: 'S1',
      inspect: () => inspectVerifiedProcessIdentity(4_194_303, 'b'.repeat(64), 'ZCODE_SHELL_WAIT_CAPTURE_NONCE', {
        platform: 'darwin',
        ps: async () => (ownCall++ === 0 ? { pid: 4_194_303, ppid: 4000, lstart: 'S1' } : undefined),
        environ: 'gone',
      }),
    });
    assert.equal(ownGone.status, 'absent', 'the verified generation\'s own mid-read disappearance is the positive absence fact');
    const lawful = await adjudicateLocalExit({ presence: live, absenceReads: [ownGone] });
    assert.equal(lawful.status, 'disappeared', 'the verified generation\'s own mid-read absence adjudicates normally');
  });

  test('exit evidence orders presence/reuse by the IDENTITY-READ instant — a delayed baseline completion never discards a replacement', async () => {
    // Round-28 finding 2: the baseline's whole-observation completion can be
    // pushed later than its identity reads by asynchronous work that
    // contributes no identity evidence (the Linux boot-clock resolution).
    // Ordering presence/reuse by that completion discarded a replacement
    // observed inside the window: identity reads establish A at t=100, the
    // replacement is observed at t=102, the baseline completes at t=105, and
    // an absence at t=106 returned `disappeared` for A. Identity evidence
    // orders by the identity-READ instant; absence evidence keeps the
    // whole-observation completion (the collection-cutoff instant).
    const { adjudicateLocalExit } = await import('../tools/shell-wait-probe/local-process-observation.mjs');
    const presence = {
      localProcessObservationVersion: 1, class: 'os-live-observation', status: 'established',
      reason: null,
      observation: { pid: 4_194_303, ppid: 4000, startIdentity: 'S1', nonce: 'b'.repeat(64), startInstantEpochMs: null, ppidChangedFromCapture: null },
      queried: { pid: 4_194_303, nonce: 'b'.repeat(64) },
      readStartedEpochMs: 95, identityReadEpochMs: 100, readEpochMs: 105, absenceConfirmed: null,
    };
    const replacement = {
      localProcessObservationVersion: 1, class: 'os-live-observation', status: 'unestablished',
      reason: 'start-identity-generation-changed', observation: null,
      queried: { pid: 4_194_303, nonce: 'b'.repeat(64) },
      readStartedEpochMs: 101, identityReadEpochMs: 102, readEpochMs: 103, absenceConfirmed: null,
    };
    const absence = {
      localProcessObservationVersion: 1, class: 'os-live-observation', status: 'absent',
      reason: 'process-absent', observation: null,
      queried: { pid: 4_194_303, nonce: 'b'.repeat(64) },
      readStartedEpochMs: 106, readEpochMs: 106, absenceConfirmed: true,
    };
    const latched = adjudicateLocalExit({ presence, absenceReads: [replacement, absence] });
    assert.equal(latched.status, 'unestablished',
      'the replacement observed inside the baseline completion window is LATER identity evidence');
    assert.equal(latched.reason, 'pid-start-identity-reused');
    assert.equal(latched.firstVerifiedAbsenceEpochMs, null);
    assert.equal(latched.lastVerifiedPresenceEpochMs, 100, 'the last verified presence is the identity-READ instant');
    // List order never decides (the reads still sort by their collection
    // instant; the replacement latches either way).
    const reordered = adjudicateLocalExit({ presence, absenceReads: [absence, replacement] });
    assert.equal(reordered.reason, 'pid-start-identity-reused');
    // A same-generation live read moves the verified-presence horizon by its
    // OWN identity instant; the absence after it adjudicates normally.
    const laterLive = {
      ...replacement, status: 'established', reason: null,
      observation: { ...presence.observation },
      readStartedEpochMs: 103, identityReadEpochMs: 104, readEpochMs: 104,
    };
    const survived = adjudicateLocalExit({ presence, absenceReads: [laterLive, absence] });
    assert.equal(survived.status, 'disappeared', 'same-generation identity evidence after the baseline keeps the lawful disappearance');
    assert.equal(survived.lastVerifiedPresenceEpochMs, 104, 'the horizon moves to the newer identity-READ instant');
  });

  test('an ABSENT verdict carrying a DIFFERENT observed identity latches the bound generation — the omitted-expectation arm', async () => {
    // Round-29 finding 1: with the OPTIONAL expectedStartIdentity omitted,
    // the round-28 observed-then-gone ride returns an ABSENT verdict
    // carrying the replacement's identity — and the exit adjudicator's
    // absence-admission branch ignored it, reporting `disappeared` for the
    // baseline instead of the reuse latch. The carried identity is checked
    // against the BOUND generation BEFORE absence is admitted.
    const { inspectVerifiedProcessIdentity, observeLocalProcess, adjudicateLocalExit } = await import('../tools/shell-wait-probe/local-process-observation.mjs');
    const live = await observeLocalProcess({
      pid: 4_194_303, nonce: 'b'.repeat(64), nowEpochMs: 1000,
      inspect: async () => ({ pid: 4_194_303, ppid: 4000, startIdentity: 'S1', nonce: 'b'.repeat(64) }),
    });
    assert.equal(live.status, 'established');
    // NO expectedStartIdentity: the first read observes the replacement's
    // S2, the pid vanishes before the marker read — the absence flow keeps
    // the positive absence shape and the observed identity rides it.
    const replacementGone = await observeLocalProcess({
      pid: 4_194_303, nonce: 'b'.repeat(64), nowEpochMs: 2000,
      inspect: () => inspectVerifiedProcessIdentity(4_194_303, 'b'.repeat(64), 'ZCODE_SHELL_WAIT_CAPTURE_NONCE', {
        platform: 'darwin',
        ps: async () => ({ pid: 4_194_303, ppid: 4000, lstart: 'S2' }),
        environ: 'gone',
      }),
    });
    assert.equal(replacementGone.status, 'absent', 'without an expectation the mid-read disappearance keeps the absence flow');
    assert.equal(replacementGone.observedStartIdentity, 'S2', 'the observed identity rides the absent verdict');
    const absence = await observeLocalProcess({ pid: 4_194_303, nonce: 'b'.repeat(64), nowEpochMs: 3000, inspect: async () => undefined });
    const latched = await adjudicateLocalExit({ presence: live, absenceReads: [replacementGone, absence] });
    assert.equal(latched.status, 'unestablished', 'a carried demonstrably-different identity is replacement evidence before absence is admitted');
    assert.equal(latched.reason, 'pid-start-identity-reused');
    assert.equal(latched.firstVerifiedAbsenceEpochMs, null);
    // A carried identity EQUAL to the bound generation admits the absence.
    const ownGone = await observeLocalProcess({
      pid: 4_194_303, nonce: 'b'.repeat(64), nowEpochMs: 2000,
      inspect: () => inspectVerifiedProcessIdentity(4_194_303, 'b'.repeat(64), 'ZCODE_SHELL_WAIT_CAPTURE_NONCE', {
        platform: 'darwin',
        ps: async () => ({ pid: 4_194_303, ppid: 4000, lstart: 'S1' }),
        environ: 'gone',
      }),
    });
    assert.equal(ownGone.observedStartIdentity, 'S1');
    const lawful = await adjudicateLocalExit({ presence: live, absenceReads: [ownGone, absence] });
    assert.equal(lawful.status, 'disappeared', 'a carried-equal observed identity admits the absence normally');
  });

  test('a carried replacement identity latches INDEPENDENTLY of the confirmation-failure class', async () => {
    // Round-30 finding 1: the round-28 observed-then-gone ride can produce
    // `absence-unconfirmed` / `absence-confirmation-failed` verdicts STILL
    // carrying the replacement's observed identity (the OS confirmation
    // failed or would not re-confirm). The latch condition keyed on
    // `liveness-read-failed` alone ignored that evidence — presence A ->
    // unconfirmed read carrying generation B -> later absence incorrectly
    // yielded `disappeared` for A. ANY read carrying a demonstrably
    // different observed identity participates in the reuse latch, whatever
    // its named failure class.
    const { inspectVerifiedProcessIdentity, observeLocalProcess, adjudicateLocalExit } = await import('../tools/shell-wait-probe/local-process-observation.mjs');
    const live = await observeLocalProcess({
      pid: 4_194_303, nonce: 'b'.repeat(64), nowEpochMs: 1000,
      inspect: async () => ({ pid: 4_194_303, ppid: 4000, startIdentity: 'S1', nonce: 'b'.repeat(64) }),
    });
    assert.equal(live.status, 'established');
    const absence = await observeLocalProcess({ pid: 4_194_303, nonce: 'b'.repeat(64), nowEpochMs: 3000, inspect: async () => undefined });
    // UNCONFIRMED: the observed-then-gone ride with the OS confirmation
    // refusing to re-confirm the absence.
    const unconfirmedGone = await observeLocalProcess({
      pid: 4_194_303, nonce: 'b'.repeat(64), nowEpochMs: 2000,
      inspect: () => inspectVerifiedProcessIdentity(4_194_303, 'b'.repeat(64), 'ZCODE_SHELL_WAIT_CAPTURE_NONCE', {
        platform: 'darwin',
        ps: async () => ({ pid: 4_194_303, ppid: 4000, lstart: 'S2' }),
        environ: 'gone',
      }),
      absenceConfirmation: async () => 'unconfirmed',
    });
    assert.equal(unconfirmedGone.status, 'unestablished');
    assert.equal(unconfirmedGone.reason, 'absence-unconfirmed');
    assert.equal(unconfirmedGone.observedStartIdentity, 'S2', 'the replacement identity rides the unconfirmed verdict');
    const unconfirmedExit = await adjudicateLocalExit({ presence: live, absenceReads: [unconfirmedGone, absence] });
    assert.equal(unconfirmedExit.status, 'unestablished', 'the carried replacement identity latches regardless of the failure class');
    assert.equal(unconfirmedExit.reason, 'pid-start-identity-reused');
    assert.equal(unconfirmedExit.firstVerifiedAbsenceEpochMs, null);
    // CONFIRMATION-FAILED: the same ride with a rejecting confirmation seam.
    const failedGone = await observeLocalProcess({
      pid: 4_194_303, nonce: 'b'.repeat(64), nowEpochMs: 2000,
      inspect: () => inspectVerifiedProcessIdentity(4_194_303, 'b'.repeat(64), 'ZCODE_SHELL_WAIT_CAPTURE_NONCE', {
        platform: 'darwin',
        ps: async () => ({ pid: 4_194_303, ppid: 4000, lstart: 'S2' }),
        environ: 'gone',
      }),
      absenceConfirmation: async () => { throw new Error('EIO: confirmation I/O failed'); },
    });
    assert.equal(failedGone.status, 'unestablished');
    assert.equal(failedGone.reason, 'absence-confirmation-failed');
    assert.equal(failedGone.observedStartIdentity, 'S2');
    const failedExit = await adjudicateLocalExit({ presence: live, absenceReads: [failedGone, absence] });
    assert.equal(failedExit.reason, 'pid-start-identity-reused', 'the confirmation-failure class latches the same way');
    // A carried-EQUAL identity in the same failure classes never latches.
    const equalUnconfirmed = await observeLocalProcess({
      pid: 4_194_303, nonce: 'b'.repeat(64), nowEpochMs: 2000,
      inspect: () => inspectVerifiedProcessIdentity(4_194_303, 'b'.repeat(64), 'ZCODE_SHELL_WAIT_CAPTURE_NONCE', {
        platform: 'darwin',
        ps: async () => ({ pid: 4_194_303, ppid: 4000, lstart: 'S1' }),
        environ: 'gone',
      }),
      absenceConfirmation: async () => 'unconfirmed',
    });
    assert.equal(equalUnconfirmed.observedStartIdentity, 'S1');
    const equalExit = await adjudicateLocalExit({ presence: live, absenceReads: [equalUnconfirmed, absence] });
    assert.equal(equalExit.status, 'disappeared', 'a carried-equal identity in a failure class never latches');
  });

  test('a carried identity is evaluated at its INSPECTION instant — an old generation read before the baseline never latches', async () => {
    // Round-31 finding 1: with the expectation omitted and the absence
    // confirmation DELAYED, the carried identity inherited the
    // CONFIRMATION's completion instant: old generation B read at t=1000,
    // generation A positively observed at t=2000, the confirmation finishes
    // at t=3000 — B latched as a replacement observed AFTER A and A's lawful
    // disappearance was permanently refused. The INSPECTION instant (when
    // the identity evidence was actually read, before the confirmation
    // await) now rides the carried identity and the latch compares THAT
    // instant: B predates A's presence and never latches it; a replacement
    // genuinely read after A's presence still latches (the round-29/30
    // regressions).
    const { inspectVerifiedProcessIdentity, observeLocalProcess, adjudicateLocalExit } = await import('../tools/shell-wait-probe/local-process-observation.mjs');
    // The absence read observes the OLD generation B at its inspection; the
    // confirmation finishes ~80ms later (a REAL delayed confirmation).
    const before = Date.now();
    const delayedGone = await observeLocalProcess({
      pid: 4_194_303, nonce: 'b'.repeat(64),
      inspect: () => inspectVerifiedProcessIdentity(4_194_303, 'b'.repeat(64), 'ZCODE_SHELL_WAIT_CAPTURE_NONCE', {
        platform: 'darwin',
        ps: async () => ({ pid: 4_194_303, ppid: 4000, lstart: 'S-OLD-B' }),
        environ: 'gone',
      }),
      absenceConfirmation: async () => {
        // The 300ms window keeps wide margins under parallel-suite load.
        await new Promise((resolve) => setTimeout(resolve, 300));
        return 'absent';
      },
    });
    assert.equal(delayedGone.status, 'absent');
    assert.equal(delayedGone.observedStartIdentity, 'S-OLD-B');
    assert.ok(Number.isSafeInteger(delayedGone.observedIdentityReadEpochMs), 'the inspection instant rides the carried identity');
    assert.ok(delayedGone.observedIdentityReadEpochMs <= before + 100, 'the inspection instant precedes the confirmation await');
    assert.ok(delayedGone.readEpochMs >= before + 300, 'the completion covers the confirmation await');
    // Generation A's presence is verified AFTER B's inspection, BEFORE the
    // confirmation (mid-delay, deterministic).
    const liveA = await observeLocalProcess({
      pid: 4_194_303, nonce: 'b'.repeat(64), nowEpochMs: before + 150,
      inspect: async () => ({ pid: 4_194_303, ppid: 4000, startIdentity: 'S1', nonce: 'b'.repeat(64) }),
    });
    assert.equal(liveA.status, 'established');
    const exit = await adjudicateLocalExit({ presence: liveA, absenceReads: [delayedGone] });
    // ROUND-36 refinement: B's absence COLLECTION overlapped A's presence
    // evidence (B's read started at ~before, A was verified at before+150) —
    // it proves nothing about the state after A's verification and is
    // named-unconfirmed for the decision. The ROUND-31 CORE is unchanged:
    // B never LATCHES A's disappearance as reuse (the reason is never
    // pid-start-identity-reused); with no demonstrably post-presence
    // absence, A's fate is honestly named-unestablished.
    assert.equal(exit.status, 'unestablished');
    assert.equal(exit.reason, 'absence-unestablished');
    assert.notEqual(exit.reason, 'pid-start-identity-reused');
  });

  test('carried identities are classified in IDENTITY-TIME order — a later-completing read never erases an earlier replacement', async () => {
    // Round-33 finding 1: with delayed absence confirmation, replacement B
    // carried its identity-read instant 2000 but COMPLETED at 4000; with
    // another A observation at 3000, completion-order processing advanced
    // the presence horizon to 3000 BEFORE B was evaluated at its carried
    // instant — B was discarded as old evidence and the later same-
    // generation read washed out the reuse latch (`disappeared`), whereas
    // without the extra live observation B correctly latched. Evidence
    // ORDER must not decide: the decision sequence orders every read by its
    // DECISION instant (identityReadEpochMs for identity-bearing reads — a
    // carried-identity read IS identity-bearing — and confirmation
    // completion for plain absences), so B is classified against the
    // horizon as of ITS read instant and the terminal latch holds.
    const { adjudicateLocalExit } = await import('../tools/shell-wait-probe/local-process-observation.mjs');
    const presence = {
      localProcessObservationVersion: 1, class: 'os-live-observation', status: 'established',
      reason: null,
      observation: { pid: 4_194_303, ppid: 4000, startIdentity: 'S1', nonce: 'b'.repeat(64), startInstantEpochMs: null, ppidChangedFromCapture: null },
      queried: { pid: 4_194_303, nonce: 'b'.repeat(64) },
      readStartedEpochMs: 1000, identityReadEpochMs: 1000, readEpochMs: 1000, absenceConfirmed: null,
    };
    // Replacement B: observed-then-gone with a DELAYED confirmation —
    // identity evidence at 2000, confirmation completing at 4000.
    const replacementGone = {
      localProcessObservationVersion: 1, class: 'os-live-observation', status: 'absent',
      reason: 'process-absent', observation: null,
      queried: { pid: 4_194_303, nonce: 'b'.repeat(64) },
      readStartedEpochMs: 1990, identityReadEpochMs: 2000,
      observedStartIdentity: 'S2', observedIdentityReadEpochMs: 2000,
      readEpochMs: 4000, absenceConfirmed: true,
    };
    // Another same-generation A observation at 3000 (completion 3000).
    const laterLive = {
      localProcessObservationVersion: 1, class: 'os-live-observation', status: 'established',
      reason: null,
      observation: { pid: 4_194_303, ppid: 4000, startIdentity: 'S1', nonce: 'b'.repeat(64), startInstantEpochMs: null, ppidChangedFromCapture: null },
      queried: { pid: 4_194_303, nonce: 'b'.repeat(64) },
      readStartedEpochMs: 3000, identityReadEpochMs: 3000, readEpochMs: 3000, absenceConfirmed: null,
    };
    const latched = await adjudicateLocalExit({ presence, absenceReads: [replacementGone, laterLive] });
    assert.equal(latched.status, 'unestablished',
      'B was READ at 2000, before the later A evidence — the replacement latches regardless of its late confirmation');
    assert.equal(latched.reason, 'pid-start-identity-reused');
    assert.equal(latched.firstVerifiedAbsenceEpochMs, null);
    // List order never decides.
    const reordered = await adjudicateLocalExit({ presence, absenceReads: [laterLive, replacementGone] });
    assert.equal(reordered.reason, 'pid-start-identity-reused');
  });

  test('overlapping same-generation disappearances report the EARLIEST confirmation completion — decision order never inflates the absence instant', async () => {
    // Round 34: two overlapping same-generation observed-then-gone reads —
    // carried identity instants 200/300, confirmations completing 500/400.
    // Identity-time ordering processes the 500-completing read first, and
    // the run start stayed at the first-PROCESSED completion: a pre-cutoff
    // verified absence (400) was reported post-cutoff (500). The reported
    // first verified absence instant of the run is the EARLIEST confirmed
    // completion, whatever order the overlapping decisions arrive in.
    const { adjudicateLocalExit } = await import('../tools/shell-wait-probe/local-process-observation.mjs');
    const presence = {
      localProcessObservationVersion: 1, class: 'os-live-observation', status: 'established',
      reason: null,
      observation: { pid: 4_194_303, ppid: 4000, startIdentity: 'S1', nonce: 'b'.repeat(64), startInstantEpochMs: null, ppidChangedFromCapture: null },
      queried: { pid: 4_194_303, nonce: 'b'.repeat(64) },
      readStartedEpochMs: 100, identityReadEpochMs: 100, readEpochMs: 100, absenceConfirmed: null,
    };
    const absentRead = (carriedInstant, completedAt) => ({
      localProcessObservationVersion: 1, class: 'os-live-observation', status: 'absent',
      reason: 'process-absent', observation: null,
      queried: { pid: 4_194_303, nonce: 'b'.repeat(64) },
      readStartedEpochMs: carriedInstant, identityReadEpochMs: carriedInstant,
      observedStartIdentity: 'S1', observedIdentityReadEpochMs: carriedInstant,
      readEpochMs: completedAt, absenceConfirmed: true,
    });
    const exit = await adjudicateLocalExit({ presence, absenceReads: [absentRead(200, 500), absentRead(300, 400)] });
    assert.equal(exit.status, 'disappeared');
    assert.equal(exit.reason, null);
    assert.equal(exit.firstVerifiedAbsenceEpochMs, 400, 'the earliest verified absence instant — decision order never inflates it');
    assert.equal(exit.lastVerifiedPresenceEpochMs, 100);
    // List order never decides (either admission order reports 400).
    const reordered = await adjudicateLocalExit({ presence, absenceReads: [absentRead(300, 400), absentRead(200, 500)] });
    assert.equal(reordered.firstVerifiedAbsenceEpochMs, 400);
  });

  test('the final live/absent decision is CONFIRMATION-time — a later-confirmed absence is never overwritten by an earlier-read presence', async () => {
    // Round 35 (the inverse interleaving of round 34): an observed-then-gone
    // read carries identity instant ~t0+2 but confirms absence at ~t0+80,
    // while ANOTHER read verifies the same generation alive at ~t0+30 (after
    // a transient ps failure). Sorting the absent verdict at its carried
    // instant let the later live evidence overwrite it — the verdict was
    // `live` despite the later confirmed absence. The two orderings stay
    // SEPARATE: identity-time governs replacement detection (the latch —
    // rounds 29-33 keep passing), and the final live/absent decision is
    // confirmation-time: an absence confirming after the last same-
    // generation presence evidence decides (`disappeared` at its
    // completion), while a presence whose identity read postdates every
    // confirmed absence still adjudicates `live`.
    const { inspectVerifiedProcessIdentity, observeLocalProcess, adjudicateLocalExit } = await import('../tools/shell-wait-probe/local-process-observation.mjs');
    const baseline = await observeLocalProcess({
      pid: 4_194_303, nonce: 'b'.repeat(64), nowEpochMs: 100,
      inspect: async () => ({ pid: 4_194_303, ppid: 4000, startIdentity: 'S1', nonce: 'b'.repeat(64) }),
    });
    assert.equal(baseline.status, 'established');
    const before = Date.now();
    // The overlapping same-generation live read FIRST (a transient ps
    // failure recovered): verified at before+150.
    const overlappingLive = await observeLocalProcess({
      pid: 4_194_303, nonce: 'b'.repeat(64), nowEpochMs: before + 150,
      inspect: async () => ({ pid: 4_194_303, ppid: 4000, startIdentity: 'S1', nonce: 'b'.repeat(64) }),
    });
    assert.equal(overlappingLive.status, 'established');
    // The observed-then-gone read STARTS after that presence evidence
    // (demonstrably post-presence, non-overlapping collection: round 36)
    // and confirms ~300ms later — its late CONFIRMATION is still credited
    // against the earlier-read presence (the round-35 rule for
    // demonstrably post-presence absences; the OVERLAPPING collection
    // shape is the round-36 named-unconfirmed case).
    // Start the absence read only AFTER the overlapping live stamp: its
    // collection interval demonstrably postdates the presence evidence.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const goneLater = await observeLocalProcess({
      pid: 4_194_303, nonce: 'b'.repeat(64),
      inspect: () => inspectVerifiedProcessIdentity(4_194_303, 'b'.repeat(64), 'ZCODE_SHELL_WAIT_CAPTURE_NONCE', {
        platform: 'darwin',
        ps: async () => ({ pid: 4_194_303, ppid: 4000, lstart: 'S1' }),
        environ: 'gone',
      }),
      absenceConfirmation: async () => {
        await new Promise((resolve) => setTimeout(resolve, 300));
        return 'absent';
      },
    });
    assert.equal(goneLater.status, 'absent');
    assert.equal(goneLater.observedStartIdentity, 'S1');
    assert.ok(goneLater.readStartedEpochMs > overlappingLive.identityReadEpochMs, 'the collection is demonstrably post-presence');
    assert.ok(goneLater.readEpochMs >= before + 500, 'the absence confirmed late');
    const exit = await adjudicateLocalExit({ presence: baseline, absenceReads: [goneLater, overlappingLive] });
    assert.equal(exit.status, 'disappeared', 'the absence confirmed AFTER the last same-generation presence evidence decides');
    assert.equal(exit.firstVerifiedAbsenceEpochMs, goneLater.readEpochMs, 'the confirmed completion is the reported absence instant');
    assert.equal(exit.lastVerifiedPresenceEpochMs, overlappingLive.identityReadEpochMs);
    // The inverse arm: a presence whose identity read POSTDATES every
    // confirmed absence still adjudicates live.
    const laterLive = await observeLocalProcess({
      pid: 4_194_303, nonce: 'b'.repeat(64), nowEpochMs: goneLater.readEpochMs + 50,
      inspect: async () => ({ pid: 4_194_303, ppid: 4000, startIdentity: 'S1', nonce: 'b'.repeat(64) }),
    });
    const stillLive = await adjudicateLocalExit({ presence: baseline, absenceReads: [goneLater, laterLive] });
    assert.equal(stillLive.status, 'live', 'a presence identity-read postdating every confirmed absence adjudicates live');
    assert.equal(stillLive.lastVerifiedPresenceEpochMs, laterLive.identityReadEpochMs);
  });

  test('an absence whose COLLECTION overlaps the presence evidence is never credited — completion alone does not prove snapshot ordering', async () => {
    // Round 36: completion timestamps bound collection latency; they do NOT
    // prove snapshot ordering. An absence query can capture its OS no-match
    // BEFORE the presence observation and DELIVER the result after it — the
    // confirmation-time decision then reported `disappeared` for a process
    // that was verifiably alive. The absence read's START must postdate the
    // presence evidence's identity-read instant (non-overlapping read
    // intervals); an overlapping collection interval is named-unconfirmed
    // for the decision (it proves nothing about the state after the
    // presence), never credited as disappearance — in BOTH absence-admission
    // passes.
    const { inspectVerifiedProcessIdentity, observeLocalProcess, adjudicateLocalExit } = await import('../tools/shell-wait-probe/local-process-observation.mjs');
    // The absence read starts FIRST: its OS no-match snapshot is captured
    // immediately, and the confirmation is HELD until after the presence
    // observation below completes.
    let releaseConfirmation;
    const held = new Promise((resolve) => { releaseConfirmation = resolve; });
    const pendingAbsence = observeLocalProcess({
      pid: 4_194_303, nonce: 'b'.repeat(64),
      inspect: () => inspectVerifiedProcessIdentity(4_194_303, 'b'.repeat(64), 'ZCODE_SHELL_WAIT_CAPTURE_NONCE', {
        platform: 'darwin',
        ps: async () => ({ pid: 4_194_303, ppid: 4000, lstart: 'S1' }),
        environ: 'gone',
      }),
      absenceConfirmation: async () => { await held; return 'absent'; },
    });
    // The absence snapshot is captured and the confirmation is pending.
    await new Promise((resolve) => setTimeout(resolve, 50));
    // The presence observation completes AFTER the absence's snapshot.
    const live = await observeLocalProcess({
      pid: 4_194_303, nonce: 'b'.repeat(64),
      inspect: async () => ({ pid: 4_194_303, ppid: 4000, startIdentity: 'S1', nonce: 'b'.repeat(64) }),
    });
    assert.equal(live.status, 'established');
    // Release AFTER a measured gap: the confirmation completion lands
    // deterministically after the presence evidence instant (the pre-fix
    // completion-only comparison then credits the overlapping absence).
    setTimeout(() => releaseConfirmation(), 30);
    const pending = await pendingAbsence;
    assert.equal(pending.status, 'absent');
    assert.ok(live.identityReadEpochMs > pending.readStartedEpochMs,
      'the presence evidence POSTDATES the absence read\'s start — the collection intervals overlap');
    const exit = await adjudicateLocalExit({ presence: live, absenceReads: [pending] });
    assert.equal(exit.status, 'unestablished', 'the overlapping absence proves nothing about the state after the presence');
    assert.equal(exit.reason, 'absence-unestablished', 'named-unconfirmed for the decision — never credited as disappearance');
    // A NON-OVERLAPPING post-presence absence (started after the presence
    // evidence) still credits the lawful disappearance.
    const postPresenceAbsence = await observeLocalProcess({ pid: 4_194_303, nonce: 'b'.repeat(64), nowEpochMs: live.identityReadEpochMs + 50, inspect: async () => undefined });
    const credited = await adjudicateLocalExit({ presence: live, absenceReads: [pending, postPresenceAbsence] });
    assert.equal(credited.status, 'disappeared', 'a demonstrably post-presence absence still credits the disappearance');
    assert.equal(credited.firstVerifiedAbsenceEpochMs, postPresenceAbsence.readEpochMs);
  });

  test('reads order by their DECISION instant — a stale-presence completion never outranks a later absence', async () => {
    // Round-29 finding 2: sorting by the whole-observation completion placed
    // a live read whose Linux clock resolution finished LATE (identity reads
    // done at t, completion at t+120) AFTER a confirmed absence in between —
    // the stale-presence completion outranked the later absence and the
    // verdict was `live`. Identity-bearing reads order by their identity-READ
    // instant; absences by their confirmation completion — the same instants
    // the recency checks consume.
    const { observeLocalProcess, adjudicateLocalExit } = await import('../tools/shell-wait-probe/local-process-observation.mjs');
    // Baseline and stale read observe the SAME generation (proc-ticks shaped
    // — the Linux clock resolution is what delays the completion).
    const baseline = await observeLocalProcess({
      pid: 4_194_303, nonce: 'b'.repeat(64), nowEpochMs: 500,
      inspect: async () => ({ pid: 4_194_303, ppid: 4000, startIdentity: 'proc:800', nonce: 'b'.repeat(64) }),
      linuxClock: { clock: { btimeMs: 0, hz: 1000 } },
    });
    // The stale-presence read through the REAL observation API with an
    // injected delayed clock: identity reads complete ~immediately, the
    // whole-observation completion ~120ms later.
    const before = Date.now();
    const delayedClock = (async () => {
      // The 300ms window keeps wide margins under parallel-suite load: the
      // identity evidence (~immediate) precedes the confirmed absence (+150)
      // precedes the whole-observation completion (+300).
      await new Promise((resolve) => setTimeout(resolve, 300));
      return { btimeMs: before - 10_000, hz: 100 };
    })();
    const staleLive = await observeLocalProcess({
      pid: 4_194_303, nonce: 'b'.repeat(64),
      inspect: async () => ({ pid: 4_194_303, ppid: 4000, startIdentity: 'proc:800', nonce: 'b'.repeat(64) }),
      linuxClock: { clock: delayedClock },
    });
    assert.equal(staleLive.status, 'established');
    assert.ok(staleLive.identityReadEpochMs < before + 150, 'the identity evidence closed early');
    assert.ok(staleLive.readEpochMs >= before + 300, 'the completion lands late');
    // The confirmed absence sits strictly between the two instants.
    const absence = {
      localProcessObservationVersion: 1, class: 'os-live-observation', status: 'absent',
      reason: 'process-absent', observation: null,
      queried: { pid: 4_194_303, nonce: 'b'.repeat(64) },
      readStartedEpochMs: before + 150, readEpochMs: before + 150, absenceConfirmed: true,
    };
    const exit = await adjudicateLocalExit({ presence: baseline, absenceReads: [staleLive, absence] });
    assert.equal(exit.status, 'disappeared', 'the later absence decides — the stale-presence completion never outranks it');
    assert.equal(exit.lastVerifiedPresenceEpochMs, staleLive.identityReadEpochMs, 'the last verified presence is the identity-READ instant');
    assert.equal(exit.firstVerifiedAbsenceEpochMs, before + 150);
  });

  test('a REJECTING absence confirmation is a named failure verdict, never a rejection (injected seam)', async () => {
    const { observeLocalProcess } = await import('../tools/shell-wait-probe/local-process-observation.mjs');
    // Round-10 finding 2: a supplied absenceConfirmation seam that throws
    // I/O errors must produce a named unestablished verdict with the
    // completed read interval — consistent with inspection-failure handling.
    const before = Date.now();
    const verdict = await observeLocalProcess({
      pid: 4_194_303, nonce: 'b'.repeat(64),
      inspect: async () => undefined,
      absenceConfirmation: async () => { throw new Error('EIO: confirmation I/O failed'); },
    });
    assert.equal(verdict.status, 'unestablished', 'the failed confirmation is named uncertainty — the observation never rejects');
    assert.equal(verdict.reason, 'absence-confirmation-failed');
    assert.equal(verdict.observation, null);
    assert.ok(Number.isSafeInteger(verdict.readStartedEpochMs) && verdict.readStartedEpochMs >= before, 'the started sample is recorded');
    assert.ok(verdict.readEpochMs >= before, 'the completion covers the failed confirmation await');
  });

  test('a supplied inspect returning a FOREIGN-NONCE observation is named unestablished — never relabeled in-scope', async () => {
    const { observeLocalProcess } = await import('../tools/shell-wait-probe/local-process-observation.mjs');
    // Round-15 finding 1: the inspect seam owns its result; when it returns
    // the requested PID but a DIFFERENT nonce, the observation must be named
    // unestablished — the returned nonce is never relabeled to the requested
    // scope (foreign-scope evidence cannot become in-scope).
    const verdict = await observeLocalProcess({
      pid: 4_194_303, nonce: 'b'.repeat(64),
      inspect: async () => ({ pid: 4_194_303, ppid: 4000, startIdentity: 'S1', nonce: 'd'.repeat(64) }),
    });
    assert.equal(verdict.status, 'unestablished', 'a foreign-nonce observation is never established');
    assert.equal(verdict.reason, 'observation-nonce-mismatch', 'the divergence is the named reason');
    assert.equal(verdict.observation, null, 'no foreign facts are exposed');
  });

  test('a boot-clock read failure NEVER rejects the observation: named null start instant instead', async () => {
    const { observeLocalProcess: observeForClock } = await import('../tools/shell-wait-probe/local-process-observation.mjs');
    // Round-9 finding 3: on Linux with the target /proc readable but
    // /proc/stat masked, the boot-clock read rejects AFTER the inspection
    // succeeded — the observation must catch that and carry a named null
    // start instant (generation-binding-unavailable downstream), never
    // reject.
    const verdict = await observeForClock({
      pid: 4_194_303, nonce: 'b'.repeat(64),
      inspect: async () => ({ pid: 4_194_303, ppid: 4000, startIdentity: 'proc:4242', nonce: 'b'.repeat(64) }),
      linuxClock: {
        clock: Promise.reject(new Error('EACCES: /proc/stat masked')),
      },
    });
    assert.equal(verdict.status, 'established', 'the inspection succeeded — the observation stands');
    assert.equal(verdict.observation.startInstantEpochMs, null, 'the unresolvable boot clock is a named null');
    assert.equal(verdict.readEpochMs !== undefined, true);
  });

  test('a successor created demonstrably AFTER the record write is refused even inside the naive window', async () => {
    // Round-10 finding 1: the symmetric tolerance accepted a same-nonce
    // successor created 500ms after the record write (record start T,
    // written T+100, successor created T+500) because |Δ| ≤ 1000. The write
    // instant DEMONSTRABLY excludes it: the original was alive at T+100, so
    // a process created at T+500 is not the writer.
    const successor = adjudicateLocalDuties({
      nonce: NONCE,
      invocation: {
        startupRecord: { status: 'established', identity: { pid: 5100, nonce: NONCE, role: 'invocation', startOriginMs: 1700000000000, firstWritePreciseMs: 1700000000100, firstWriteEpochMs: 1700000000000 } },
        osObservation: establishedObservation({ pid: 5100, ppid: 4000, startIdentity: 'proc:900', nonce: NONCE, startInstantEpochMs: 1700000000500 }, 1700000002000),
      },
      broker: null, transport: null, identifiedDescendants: [],
    });
    const duty = successor.duties.find((entry) => entry.duty === 'invocation-process');
    assert.equal(duty.status, 'unestablished', 'a creation demonstrably after the write is a successor — never the writer');
    assert.deepEqual(duty.reasons, ['generation-start-after-write']);
    // A creation within the documented /proc resolution AFTER the write
    // stays named-ambiguous (clock resolution, never guessed).
    const resolutionAmbiguous = adjudicateLocalDuties({
      nonce: NONCE,
      invocation: {
        startupRecord: { status: 'established', identity: { pid: 5100, nonce: NONCE, role: 'invocation', startOriginMs: 1700000000000, firstWritePreciseMs: 1700000000100, firstWriteEpochMs: 1700000000000 } },
        osObservation: establishedObservation({ pid: 5100, ppid: 4000, startIdentity: 'proc:12', nonce: NONCE, startInstantEpochMs: 1700000000105 }, 1700000002000),
      },
      broker: null, transport: null, identifiedDescendants: [],
    });
    assert.deepEqual(resolutionAmbiguous.duties.find((entry) => entry.duty === 'invocation-process').reasons, ['generation-start-ambiguous'],
      'a creation only ~5ms after the write is inside the /proc resolution — named ambiguous');
    // The early-side startup-delay tolerance is preserved: creation up to
    // the window BEFORE the record start binds.
    // Under the uncertainty-propagated rule a candidate created FAR before
    // the record write demonstrably existed at write time — it cannot be a
    // same-nonce successor (successors are created after the original died,
    // i.e. after the write) — so it binds as the writer.
    const earlyCandidate = adjudicateLocalDuties({
      nonce: NONCE,
      invocation: {
        startupRecord: { status: 'established', identity: { pid: 5100, nonce: NONCE, role: 'invocation', startOriginMs: 1700000000000, firstWritePreciseMs: 1700000000100, firstWriteEpochMs: 1700000000000 } },
        osObservation: establishedObservation({ pid: 5100, ppid: 4000, startIdentity: 'proc:900', nonce: NONCE, startInstantEpochMs: 1699999996000 }, 1700000002000),
      },
      broker: null, transport: null, identifiedDescendants: [],
    });
    assert.deepEqual(earlyCandidate.duties.find((entry) => entry.duty === 'invocation-process').reasons, [],
      'a candidate that demonstrably existed at write time cannot be a successor');
    // A same-second write on Linux stays AMBIGUOUS (the whole-second btime
    // uncertainty makes same-second writes genuinely unexcludable — the
    // documented bound; only a ≥1s write gap binds).
    const sameSecond = await adjudicateLocalDuties({
      nonce: NONCE,
      invocation: {
        startupRecord: { status: 'established', identity: { pid: 5100, nonce: NONCE, role: 'invocation', startOriginMs: 1700000000000, firstWritePreciseMs: 1700000000100, firstWriteEpochMs: 1700000000000 } },
        osObservation: establishedObservation({ pid: 5100, ppid: 4000, startIdentity: 'proc:900', nonce: NONCE, startInstantEpochMs: 1699999999500 }, 1700000002000),
      },
      broker: null, transport: null, identifiedDescendants: [],
    });
    assert.deepEqual(sameSecond.duties.find((entry) => entry.duty === 'invocation-process').reasons, ['generation-start-ambiguous'],
      'a same-second write cannot be distinguished from a successor under whole-second btime');
  });

  test('the Linux proc-ticks creation instant binds the generation (injected clock, never the host OS)', async () => {
    // Class sweep (finding 1(b)): the Linux /proc starttime ticks + btime +
    // CLK_TCK resolve a ~10ms creation instant, so Linux is not permanently
    // generation-binding-unavailable. The clock is INJECTED.
    const { observeLocalProcess } = await import('../tools/shell-wait-probe/local-process-observation.mjs');
    const scopeNonce = 'b'.repeat(64);
    const live = await observeLocalProcess({
      pid: 4_194_303, nonce: scopeNonce,
      inspect: async () => ({ pid: 4_194_303, ppid: 4000, startIdentity: 'proc:4242', nonce: scopeNonce }),
      linuxClock: { clock: { btimeMs: 1700000000000, hz: 100 } },
    });
    assert.equal(live.status, 'established');
    assert.equal(live.observation.startIdentity, 'proc:4242');
    assert.equal(live.observation.startInstantEpochMs, 1700000000000 + 42420,
      'creation epoch = btime + starttime ticks / CLK_TCK');
    // The duty join binds only when the ENTIRE whole-second btime uncertainty
    // window precedes the write — here the record write is a full second
    // after the computed creation, so no successor can predate the write.
    const verdict = await (await import('../tools/shell-wait-probe/local-process-observation.mjs')).adjudicateLocalDuties({
      nonce: scopeNonce,
      invocation: {
        startupRecord: { status: 'established', identity: { pid: 4_194_303, nonce: scopeNonce, role: 'invocation', startOriginMs: 1700000000000 + 42430, firstWritePreciseMs: 1700000000000 + 42420 + 1000 + 40, firstWriteEpochMs: 1700000000042 } },
        osObservation: live,
      },
      broker: null, transport: null, identifiedDescendants: [],
    });
    const duty = verdict.duties.find((entry) => entry.duty === 'invocation-process');
    assert.equal(duty.status, 'established', 'the Linux creation binding establishes the invocation duty');
    assert.deepEqual(duty.reasons, []);
  });

  test('the precise generation binding: the OS second contains the record start, and the write postdates it', () => {
    // Round-5 finding, resolved with the prescribed precise rule: the
    // preload embeds the process's OWN sub-millisecond start instant
    // (performance.timeOrigin) and its precise write instant, so the binding
    // no longer depends on whole-second lstart arithmetic.
    const obs = (observation, epochMs) => ({
      localProcessObservationVersion: 1, class: 'os-live-observation', status: 'established',
      reason: null, observation: { ...observation, ppidChangedFromCapture: null }, readEpochMs: epochMs,
    });
    const transportFact = { startupRecord: null, osObservation: obs({ ...transportMarker, startIdentity: 'proc:42' }, 1020) };
    const brokerFact = {
      startupRecord: { status: 'established', identity: { pid: 5200, nonce: NONCE, role: 'broker-daemon', startOriginMs: 1000.25, firstWritePreciseMs: 1000.4, firstWriteEpochMs: 1000 } },
      osObservation: obs(daemon, 2010),
    };
    // FAST STARTUP binds: the record was written 150 microseconds after the
    // process start (same wall-clock second) — the OS lstart second
    // CONTAINS the precise start and the write postdates it.
    const fastStartup = adjudicateLocalDuties({
      nonce: NONCE,
      invocation: {
        startupRecord: { status: 'established', identity: { pid: 5100, nonce: NONCE, role: 'invocation', startOriginMs: 1000.1, firstWritePreciseMs: 1000.25, firstWriteEpochMs: 1000 } },
        osObservation: obs({ pid: 5100, ppid: 4000, startIdentity: 'S-FAST', nonce: NONCE, startInstantEpochMs: 1000 }, 2000),
      },
      broker: brokerFact, transport: transportFact, identifiedDescendants: [],
    });
    assert.equal(fastStartup.settled, true, 'a fast same-second startup BINDS through the precise record instants');
    assert.equal(fastStartup.duties.find((entry) => entry.duty === 'invocation-process').status, 'established');
    // The OS second OUTSIDE the bounded containment (neither the Node-init
    // second nor the immediately preceding one) is a named mismatch — the
    // observed process started in a different era than the writer.
    const secondMismatch = adjudicateLocalDuties({
      nonce: NONCE,
      invocation: {
        startupRecord: { status: 'established', identity: { pid: 5100, nonce: NONCE, role: 'invocation', startOriginMs: 2500.1, firstWritePreciseMs: 2500.4, firstWriteEpochMs: 2500 } },
        osObservation: obs({ pid: 5100, ppid: 4000, startIdentity: 'S-OTHER', nonce: NONCE, startInstantEpochMs: 3000 }, 2000),
      },
      broker: brokerFact, transport: transportFact, identifiedDescendants: [],
    });
    const mismatchDuty = secondMismatch.duties.find((entry) => entry.duty === 'invocation-process');
    assert.equal(mismatchDuty.status, 'unestablished');
    assert.deepEqual(mismatchDuty.reasons, ['generation-start-second-mismatch']);
    // A record claiming a write BEFORE its own process start is impossible
    // for a writer — named, never guessed.
    const backwards = adjudicateLocalDuties({
      nonce: NONCE,
      invocation: {
        startupRecord: { status: 'established', identity: { pid: 5100, nonce: NONCE, role: 'invocation', startOriginMs: 5000.5, firstWritePreciseMs: 4000.25, firstWriteEpochMs: 5000 } },
        osObservation: obs({ pid: 5100, ppid: 4000, startIdentity: 'S', nonce: NONCE, startInstantEpochMs: 5000 }, 2000),
      },
      broker: brokerFact, transport: transportFact, identifiedDescendants: [],
    });
    assert.deepEqual(backwards.duties.find((entry) => entry.duty === 'invocation-process').reasons, ['generation-start-after-record']);
    // Missing precise instants keep the duty honestly unestablished.
    const unavailable = adjudicateLocalDuties({
      nonce: NONCE,
      invocation: {
        startupRecord: { status: 'established', identity: { pid: 5100, nonce: NONCE, role: 'invocation', startOriginMs: null, firstWritePreciseMs: null, firstWriteEpochMs: 1000 } },
        osObservation: obs({ pid: 5100, ppid: 4000, startIdentity: 'S', nonce: NONCE, startInstantEpochMs: 1000 }, 2000),
      },
      broker: brokerFact, transport: transportFact, identifiedDescendants: [],
    });
    assert.deepEqual(unavailable.duties.find((entry) => entry.duty === 'invocation-process').reasons, ['generation-binding-unavailable']);
  });

  test('mixed-scope facts never settle the aggregate: one shared invocation scope binds every duty', () => {
    const obs = (observation, epochMs) => ({
      localProcessObservationVersion: 1, class: 'os-live-observation', status: 'established',
      reason: null, observation: { ...observation, ppidChangedFromCapture: null }, readEpochMs: epochMs,
    });
    const transportFact = { startupRecord: null, osObservation: obs({ ...transportMarker, startIdentity: 'proc:42' }, 1020) };
    const invocationFact = {
      startupRecord: { status: 'established', identity: { pid: 5100, nonce: NONCE, role: 'invocation', firstWriteEpochMs: 1900, startOriginMs: 1000.1, firstWritePreciseMs: 1000.3 } },
      osObservation: obs(companion, 2000),
    };
    // Broker fact from CONCURRENT invocation scope B; transport from scope C.
    const brokerScopeB = {
      startupRecord: { status: 'established', identity: { pid: 5200, nonce: 'd'.repeat(64), role: 'broker-daemon', firstWriteEpochMs: 1900, startOriginMs: 1000.2, firstWritePreciseMs: 1000.4 } },
      osObservation: obs({ ...daemon, nonce: 'd'.repeat(64) }, 1010),
    };
    const transportScopeC = { startupRecord: null, osObservation: obs({ ...transportMarker, nonce: 'e'.repeat(64), startIdentity: 'proc:42' }, 1020) };
    const verdict = adjudicateLocalDuties({ nonce: NONCE, invocation: invocationFact, broker: brokerScopeB, transport: transportScopeC, identifiedDescendants: [] });
    assert.equal(verdict.settled, false, 'mixing concurrent fixture invocations is a named refusal — never settled');
    assert.deepEqual(verdict.duties.find((entry) => entry.duty === 'invocation-process').reasons, [],
      'the expected-scope invocation duty joins');
    assert.deepEqual(verdict.duties.find((entry) => entry.duty === 'broker-daemon').reasons, ['scope-nonce-mismatch']);
    assert.deepEqual(verdict.duties.find((entry) => entry.duty === 'transport-descendant').reasons, ['scope-nonce-mismatch']);
    // Positive control: with EVERY fact in the expected scope the aggregate
    // settles — the mixed-scope refusal is the nonce binding, not the shape.
    const inScopeBroker = {
      startupRecord: { status: 'established', identity: { pid: 5200, nonce: NONCE, role: 'broker-daemon', firstWriteEpochMs: 2900, startOriginMs: 1000.2, firstWritePreciseMs: 1000.4 } },
      osObservation: obs(daemon, 2010),
    };
    const inScope = adjudicateLocalDuties({ nonce: NONCE, invocation: invocationFact, broker: inScopeBroker, transport: transportFact, identifiedDescendants: [] });
    assert.equal(inScope.settled, true, 'the fully in-scope aggregate settles');
    // A descendant exit from another scope is likewise never credited.
    const scopedExit = {
      class: 'exit-absence', status: 'disappeared', reason: null,
      boundIdentity: { pid: 5400, startIdentity: 'S-EXTRA', nonce: 'e'.repeat(64) },
      lastVerifiedPresenceEpochMs: 1030, firstVerifiedAbsenceEpochMs: 2000, exitCorroboratedByMeta: false,
    };
    const scopedDescendant = adjudicateLocalDuties({
      nonce: NONCE, invocation: invocationFact, broker: brokerScopeB, transport: transportScopeC,
      identifiedDescendants: [{ label: 'extra', osObservation: obs({ pid: 5400, ppid: 5100, startIdentity: 'S-EXTRA', nonce: 'e'.repeat(64) }, 1030), exit: scopedExit }],
    });
    assert.equal(scopedDescendant.settled, false, 'a foreign-scope descendant disappearance never completes the aggregate');
  });

  test('a PID-reusing successor carrying the scope nonce never satisfies the invocation duty join', () => {
    // The invocation exited before its first OS observation; the startup
    // record (written at 1500 by the ORIGINAL process) was left behind, and
    // a same-nonce successor now occupies the PID — its OS start instant
    // (9000) is AFTER the record write, which a writer can never be.
    const reuseVerdict = adjudicateLocalDuties({
      nonce: NONCE,
      invocation: {
        startupRecord: { status: 'established', identity: { pid: 5100, nonce: NONCE, role: 'invocation', firstWriteEpochMs: 1500, startOriginMs: 800.1, firstWritePreciseMs: 800.3 } },
        osObservation: establishedObservation({ pid: 5100, ppid: 4000, startIdentity: 'S-REUSE', nonce: NONCE, startInstantEpochMs: 9000 }, 2000),
      },
      broker: { startupRecord: { status: 'established', identity: { pid: 5200, nonce: NONCE, role: 'broker-daemon', firstWriteEpochMs: 2900, startOriginMs: 1000.2, firstWritePreciseMs: 1000.4 } }, osObservation: establishedObservation(daemon, 2600) },
      transport: { startupRecord: null, osObservation: establishedObservation({ ...transportMarker, startIdentity: 'proc:42' }, 1020) },
      identifiedDescendants: [],
    });
    assert.equal(reuseVerdict.settled, false, 'a PID-reusing successor must never be accepted as the original invocation');
    const duty = reuseVerdict.duties.find((entry) => entry.duty === 'invocation-process');
    assert.equal(duty.status, 'unestablished');
    assert.deepEqual(duty.reasons, ['generation-start-second-mismatch'],
      'the record\'s own precise start binds the generation: the OS second does not contain it');

    // The writer binds: a start instant at or before the record write joins.
    const writerVerdict = adjudicateLocalDuties({
      nonce: NONCE,
      invocation: {
        startupRecord: { status: 'established', identity: { pid: 5100, nonce: NONCE, role: 'invocation', firstWriteEpochMs: 1700000001500, startOriginMs: 1700000000100.25, firstWritePreciseMs: 1700000000150.4 } },
        osObservation: establishedObservation({ pid: 5100, ppid: 4000, startIdentity: 'S-COMPANION', nonce: NONCE, startInstantEpochMs: 1700000000000 }, 1700000001700),
      },
      broker: { startupRecord: { status: 'established', identity: { pid: 5200, nonce: NONCE, role: 'broker-daemon', firstWriteEpochMs: 2900, startOriginMs: 1000.2, firstWritePreciseMs: 1000.4 } }, osObservation: establishedObservation(daemon, 2600) },
      transport: { startupRecord: null, osObservation: establishedObservation({ ...transportMarker, startIdentity: 'proc:42' }, 1020) },
      identifiedDescendants: [],
    });
    assert.equal(writerVerdict.duties.find((entry) => entry.duty === 'invocation-process').status, 'established',
      'the process that started before its own record write is the writer');
  });

  test('an unresolvable start instant keeps the duty named-unestablished (generation binding unavailable)', () => {
    // A start identity whose instant cannot be resolved (the linux proc-tick
    // reads) cannot demonstrate the generation binding — the duty stays
    // named-unestablished instead of accepting the PID+nonce match.
    const verdict = adjudicateLocalDuties({
      nonce: NONCE,
      invocation: {
        startupRecord: { status: 'established', identity: { pid: 5100, nonce: NONCE, role: 'invocation', firstWriteEpochMs: 1500, startOriginMs: 800.1, firstWritePreciseMs: 800.3 } },
        osObservation: establishedObservation({ pid: 5100, ppid: 4000, startIdentity: 'proc:4242', nonce: NONCE, startInstantEpochMs: null }, 2000),
      },
      broker: { startupRecord: { status: 'established', identity: { pid: 5200, nonce: NONCE, role: 'broker-daemon', firstWriteEpochMs: 2900, startOriginMs: 1000.2, firstWritePreciseMs: 1000.4 } }, osObservation: establishedObservation(daemon, 2600) },
      transport: { startupRecord: null, osObservation: establishedObservation({ ...transportMarker, startIdentity: 'proc:42' }, 1020) },
      identifiedDescendants: [],
    });
    assert.equal(verdict.settled, false);
    const duty = verdict.duties.find((entry) => entry.duty === 'invocation-process');
    assert.equal(duty.status, 'unestablished');
    assert.deepEqual(duty.reasons, ['generation-binding-unavailable']);
  });

  test('a startup-backed duty ALSO refuses an established-tagged observation missing its OS start identity', () => {
    // Round-16 finding: the round-15 completeness gate covered only the
    // transport/descendant branch — the startup-backed branch (invocation/
    // broker) let an established-tagged {pid, ppid, nonce} observation
    // through (pid/nonce checks pass, the missing start identity falls
    // through the generation comparison), producing settled:true with
    // identities missing their OS generation. One completeness gate for
    // every duty-establishing branch.
    const markerOnly = {
      localProcessObservationVersion: 1, class: 'os-live-observation', status: 'established',
      reason: null,
      observation: { pid: 5100, ppid: 4000, nonce: NONCE, startInstantEpochMs: null, ppidChangedFromCapture: null },
      queried: { pid: 5100, nonce: NONCE },
      readStartedEpochMs: 1000, readEpochMs: 1000, absenceConfirmed: null,
    };
    const invocationFact = {
      startupRecord: { status: 'established', identity: { pid: 5100, nonce: NONCE, role: 'invocation', startOriginMs: 1000.1, firstWritePreciseMs: 1000.3, firstWriteEpochMs: 1900 } },
      osObservation: markerOnly,
    };
    const brokerFact = {
      startupRecord: { status: 'established', identity: { pid: 5200, nonce: NONCE, role: 'broker-daemon', startOriginMs: 1000.2, firstWritePreciseMs: 1000.4, firstWriteEpochMs: 1900 } },
      osObservation: { ...markerOnly, observation: { ...markerOnly.observation, pid: 5200 } },
    };
    const verdict = adjudicateLocalDuties({
      nonce: NONCE,
      invocation: invocationFact,
      broker: brokerFact,
      transport: { startupRecord: null, osObservation: { ...markerOnly, observation: { ...markerOnly.observation, pid: 5300 } } },
      identifiedDescendants: [],
    });
    assert.equal(verdict.settled, false, 'a bare marker never settles the aggregate');
    const invocationDuty = verdict.duties.find((entry) => entry.duty === 'invocation-process');
    assert.equal(invocationDuty.status, 'unestablished', 'the STARTUP-BACKED invocation duty refuses the bare marker');
    assert.deepEqual(invocationDuty.reasons, ['os-observation-incomplete'],
      'the same completeness gate applies to startup-backed duties');
    const brokerDuty = verdict.duties.find((entry) => entry.duty === 'broker-daemon');
    assert.deepEqual(brokerDuty.reasons, ['os-observation-incomplete']);
  });

  test('a bare {pid, ppid, nonce} observation without a start identity NEVER establishes any duty', () => {
    // Round-15 finding 2: an established-tagged observation with positive
    // pid and nonce but NO OS start identity is incomplete marker evidence —
    // it must not substitute for verified generation evidence on ANY duty.
    const markerOnly = {
      localProcessObservationVersion: 1, class: 'os-live-observation', status: 'established',
      reason: null,
      observation: { pid: 5300, ppid: 5200, nonce: NONCE, startInstantEpochMs: null, ppidChangedFromCapture: null },
      queried: { pid: 5300, nonce: NONCE },
      readStartedEpochMs: 1020, readEpochMs: 1020, absenceConfirmed: null,
    };
    const verdict = adjudicateLocalDuties({
      nonce: NONCE,
      invocation: null,
      broker: null,
      transport: { startupRecord: null, osObservation: markerOnly },
      identifiedDescendants: [{ label: 'bare-marker', osObservation: markerOnly }],
    });
    const transportDuty = verdict.duties.find((entry) => entry.duty === 'transport-descendant');
    assert.equal(transportDuty.status, 'unestablished', 'the transport duty never establishes on a bare marker');
    assert.deepEqual(transportDuty.reasons, ['os-observation-incomplete'], 'the incompleteness is the named reason');
    const descendantDuty = verdict.duties.find((entry) => entry.duty === 'identified-descendant');
    assert.equal(descendantDuty.status, 'unestablished', 'the descendant duty never establishes on a bare marker');
    assert.deepEqual(descendantDuty.reasons, ['os-observation-incomplete']);
    assert.equal(verdict.settled, false, 'the aggregate never settles on incomplete generation evidence');
  });

  test('a Linux observation completed BEFORE the record writer started is STALE — it never establishes the duty', async () => {
    // Round-26 finding 2: a CACHED observation of generation A can establish
    // a later startup record from generation B that reused A's pid AND
    // capture nonce: the completion 5s before the writer's startOrigin still
    // yielded established with A's start identity. Generation continuity
    // requires the observation completion to POSTDATE the record writer's
    // startup.
    const staleObservation = establishedObservation(
      { pid: 5100, ppid: 4000, startIdentity: 'proc:66', nonce: NONCE, startInstantEpochMs: 1699999996600 }, 1699999996500);
    const verdict = adjudicateLocalDuties({
      nonce: NONCE,
      invocation: {
        startupRecord: { status: 'established', identity: { pid: 5100, nonce: NONCE, role: 'invocation', startOriginMs: 1700000000000, firstWritePreciseMs: 1700000000100, firstWriteEpochMs: 1700000000000 } },
        osObservation: staleObservation,
      },
      broker: null, transport: null, identifiedDescendants: [],
    });
    const duty = verdict.duties.find((entry) => entry.duty === 'invocation-process');
    assert.equal(duty.status, 'unestablished', 'a stale observation never establishes the duty');
    assert.deepEqual(duty.reasons, ['os-observation-stale'], 'the staleness is the named reason');
    assert.equal(verdict.settled, false);
    // FAIL-CLOSED on the completion instant itself: an established-tagged
    // observation whose OS start instant is generation-CONSISTENT but which
    // carries NO verifiable read instant cannot demonstrate that it postdates
    // the record writer's startup — equally unable to bridge the generations,
    // named the same way (never established-by-default).
    const unstamped = establishedObservation(
      { pid: 5100, ppid: 4000, startIdentity: 'proc:66', nonce: NONCE, startInstantEpochMs: 1699999996600 });
    const unstampedVerdict = adjudicateLocalDuties({
      nonce: NONCE,
      invocation: {
        startupRecord: { status: 'established', identity: { pid: 5100, nonce: NONCE, role: 'invocation', startOriginMs: 1700000000000, firstWritePreciseMs: 1700000000100, firstWriteEpochMs: 1700000000000 } },
        osObservation: unstamped,
      },
      broker: null, transport: null, identifiedDescendants: [],
    });
    const unstampedDuty = unstampedVerdict.duties.find((entry) => entry.duty === 'invocation-process');
    assert.equal(unstampedDuty.status, 'unestablished', 'an observation with no verifiable completion instant never establishes the duty');
    assert.deepEqual(unstampedDuty.reasons, ['os-observation-stale'], 'the unverifiable instant is named the same fail-closed way');
    assert.equal(unstampedVerdict.settled, false);
  });

  test('an observation whose IDENTITY reads completed before the record writer started is STALE even when the clock resolution delays past it', async () => {
    // Round-27 finding 1: on Linux the identity double-read finishes BEFORE
    // the asynchronous boot-clock resolution; a pid+nonce reuser starting
    // DURING that await makes the whole-observation completion postdate the
    // writer's startup while every identity read observed the EARLIER
    // generation — the round-26 gate anchored on the whole-observation
    // completion then accepted the earlier generation's start identity for
    // the reuser's record. The continuity gate anchors on the identity-READ
    // completion instant (the identity evidence's own validity horizon),
    // carried on the verdict. The delayed clock here is REAL (an injected
    // boot-clock promise that takes real wall time); the identity reads
    // complete ~immediately and the whole-observation completion ~120ms
    // later — the reuser's record starts mid-window.
    const { observeLocalProcess, adjudicateLocalDuties } = await import('../tools/shell-wait-probe/local-process-observation.mjs');
    const before = Date.now();
    const bootMs = before - 10_000;
    const delayedClock = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 120));
      return { btimeMs: bootMs, hz: 100 };
    })();
    // Generation A: a proc-ticks identity whose computed creation is 2s
    // BEFORE `before` (boot 10s ago + 8000ms of ticks) — an OLD generation
    // the creation-instant rules cannot exclude against a later writer.
    const observation = await observeLocalProcess({
      pid: 5100, nonce: NONCE,
      inspect: async () => ({ pid: 5100, ppid: 4000, startIdentity: 'proc:800', nonce: NONCE }),
      linuxClock: { clock: delayedClock },
    });
    assert.equal(observation.status, 'established');
    assert.ok(Number.isSafeInteger(observation.identityReadEpochMs), 'the verdict carries the identity-READ completion instant');
    assert.ok(observation.identityReadEpochMs < before + 150, 'the identity reads completed before the reuser starts');
    // Generation B reuses the pid + capture nonce and starts MID-WINDOW
    // (before + 60): after the identity reads, before the completion.
    const verdict = adjudicateLocalDuties({
      nonce: NONCE,
      invocation: {
        startupRecord: { status: 'established', identity: { pid: 5100, nonce: NONCE, role: 'invocation', startOriginMs: before + 150, firstWritePreciseMs: before + 155, firstWriteEpochMs: before + 150 } },
        osObservation: observation,
      },
      broker: null, transport: null, identifiedDescendants: [],
    });
    const duty = verdict.duties.find((entry) => entry.duty === 'invocation-process');
    assert.equal(duty.status, 'unestablished',
      'the identity evidence closed before the writer started — the whole-observation completion cannot vouch for it');
    assert.deepEqual(duty.reasons, ['os-observation-stale'], 'the staleness anchors on the identity-READ instant');
    assert.equal(verdict.settled, false);
  });

  test('input validation of the duty verdict', () => {
    assert.throws(() => adjudicateLocalDuties(null), /object/u);
    assert.throws(() => adjudicateLocalDuties({ nonce: NONCE, invocation: { startupRecord: null, osObservation: { class: 'startup-identity' } } }), /os-live-observation/u);
    assert.throws(() => adjudicateLocalDuties({ nonce: NONCE, identifiedDescendants: 'not-a-list' }), /list/u);
    const validFact = {
      startupRecord: { status: 'established', identity: { pid: 5100, nonce: NONCE, role: 'invocation', firstWriteEpochMs: 1900, startOriginMs: 1000.1, firstWritePreciseMs: 1000.3 } },
      osObservation: establishedObservation(companion, 2500),
    };
    assert.throws(() => adjudicateLocalDuties({ invocation: validFact }), /scope/u, 'the aggregate binds an EXPECTED invocation scope');
    assert.throws(() => adjudicateLocalDuties({ nonce: 'short', invocation: validFact }), /64-hex/u);
  });
});

describe('local-process observation: non-interference proof (task 2, plan §2)', async () => {
  const { mkdir } = await import('node:fs/promises');
  const { readFileSync } = await import('node:fs');
  const observerModulePath = fileURLToPath(new URL('../tools/shell-wait-probe/local-process-observation.mjs', import.meta.url));
  const observerModule = await import('../tools/shell-wait-probe/local-process-observation.mjs');
  const { formatDirectInvocationError } = await import('../scripts/lib/direct-invocation-result.mjs');
  const { PluginError } = await import('../scripts/lib/errors.mjs');

  // The exact production fast-fail expectation, built through the REAL
  // production formatter from the CODEX_THREAD_ID gate error shape — the
  // §19.3 T1 pinned 207-byte envelope.
  const threadIdRequiredEnvelope = formatDirectInvocationError(
    new PluginError('THREAD_ID_REQUIRED', 'The active Codex thread identity is unavailable.', { category: 'authorization', remedy: 'Invoke this installed skill from an active Codex turn.' }),
  );

  test('REAL-CHILD end-to-end fast startup: admission -> OS observation -> duty join binds a same-second record', async (t) => {
    // The exact hole six rounds of synthetic timestamps (>1s apart) missed:
    // a REAL harmless gated child whose record write lands in the SAME
    // wall-clock second as its OS start must still bind through the precise
    // record instants — never stay generation-ambiguous.
    const root = await mkdtemp(join(tmpdir(), 'shell-wait-local-process-fast-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const captureDirectory = join(root, 'stdout-capture');
    await mkdir(captureDirectory, { mode: 0o700 });
    const nonce = randomBytes(32).toString('hex');
    const preload = await writeClosurePreload(root);
    const probePath = join(root, 'probe-entry.mjs');
    await writeFile(probePath, [
      "process.stdout.write('fast\\n');",
      'await new Promise((resolve) => setTimeout(resolve, 1200));',
    ].join('\n'), { mode: 0o700 });
    const entryRealpath = await realpath(probePath);
    const env = captureEnvironment({ captureDirectory, nonce, entryRealpath, baseEnv: isolatedBaseEnv(root), nodeOptionsFragment: preload.nodeOptionsFragment });
    // ONE child flows the whole chain: the SAME process is admitted (its
    // record), OS-observed while alive, duty-joined, then adjudicated gone
    // after its exit. The hold probe keeps it alive for the live leg.
    const observationModule = await import('../tools/shell-wait-probe/local-process-observation.mjs');
    const child = spawn(process.execPath, [entryRealpath, 'invoke-prepared', 'rescue'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    t.after(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } });
    // ROUND-33: the exit promise is created IMMEDIATELY after spawn — before
    // any awaited observation leg — so on a slow runner a child that exits
    // while those legs await can never miss its own exit event (the
    // scopeWithLiveChild pattern; a late-registered listener hangs forever).
    const exitOutcome = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
    const recordPath = join(captureDirectory, `${nonce}.identity.json`);
    assert.equal(await waitFor(async () => lstat(recordPath).then(() => true, () => false)), true,
      'the startup identity record appears at preload install');
    // Admission: the record carries PRECISE instants, and the write happened
    // within the same wall-clock second as the process start (fast startup).
    const admission = await observationModule.admitStartupIdentityRecord({ captureDirectory, nonce, expectedEntryRealpath: entryRealpath });
    assert.equal(admission.status, 'established');
    const { startOriginMs, firstWritePreciseMs } = admission.identity;
    assert.ok(Number.isFinite(startOriginMs) && startOriginMs > 0, 'the record embeds the precise process start');
    assert.ok(firstWritePreciseMs >= startOriginMs, 'the precise write postdates the precise start');
    assert.ok(firstWritePreciseMs - startOriginMs < 1000, 'the startup is genuinely FAST (sub-second write)');
    let liveObserved = null;
    assert.equal(await waitFor(async () => {
      const verdict = await observationModule.observeLocalProcess({ pid: child.pid, nonce });
      if (verdict.status === 'established') { liveObserved = verdict; return true; }
      return false;
    }), true, 'the child is OS-verified while alive');
    assert.equal(liveObserved.status, 'established');
    assert.equal(liveObserved.observation.pid, admission.identity.pid, 'the OS observation is of the record writer process');
    // The DUTY JOIN on the same child is PLATFORM-GATED (round-13, the
    // round-5 pattern): the darwin whole-second containment BINDS a fast
    // same-second startup (exact, never weakened); on Linux the whole-second
    // btime uncertainty deliberately keeps a same-second write
    // `generation-start-ambiguous` (the honest conservative outcome the
    // round-12 rule names). The Linux branch is additionally asserted
    // DETERMINISTICALLY below through injected seams, so it is verified on
    // every host.
    const dutyJoin = await observationModule.adjudicateLocalDuties({
      nonce,
      invocation: {
        startupRecord: { status: 'established', identity: admission.identity },
        osObservation: liveObserved,
      },
      broker: null, transport: null, identifiedDescendants: [],
    });
    const invocationDuty = dutyJoin.duties.find((entry) => entry.duty === 'invocation-process');
    if (process.platform === 'darwin') {
      // BOUNDARY-SAFETY CONFIRMATION (round 14): the darwin rule requires the
      // OS creation second to CONTAIN timeOrigin OR be the immediately
      // preceding second — and lstart IS the creation instant itself, so the
      // creation second contains timeOrigin by construction even when the
      // startup crosses a wall-clock boundary (the fork and the Node init
      // record the same lstart second); boundary crossing therefore cannot
      // break the darwin binding. Asserted explicitly from the measured
      // instants.
      const originSecond = Math.floor(admission.identity.startOriginMs / 1000) * 1000;
      assert.ok(
        liveObserved.observation.startInstantEpochMs === originSecond
          || liveObserved.observation.startInstantEpochMs === originSecond - 1000,
        'DARWIN: the OS creation second contains timeOrigin (or is the preceding second) — boundary crossing is contained');
      assert.equal(invocationDuty.status, 'established',
        'DARWIN: the FAST same-second startup BINDS — record precise start inside the OS second, write postdating it');
      assert.deepEqual(invocationDuty.reasons, [], 'DARWIN: no generation reservation reasons remain');
    } else {
      // LINUX: the expected outcome is DERIVED from the child's own MEASURED
      // interval (record precise start/write + the observation's computed
      // btime lower bound) — a fast startup that crosses a wall-clock
      // boundary can legitimately BIND, so the assertion accepts exactly the
      // label the implementation must produce for that measured interval
      // (never a hardcoded ambiguous).
      const computed = liveObserved.observation.startInstantEpochMs;
      const recordWrite = admission.identity.firstWritePreciseMs;
      let expectedReasons;
      let expectedStatus;
      if (computed > recordWrite + 10) {
        expectedReasons = ['generation-start-after-write'];
        expectedStatus = 'unestablished';
      } else if (recordWrite < computed + 1000) {
        expectedReasons = ['generation-start-ambiguous'];
        expectedStatus = 'unestablished';
      } else {
        expectedReasons = [];
        expectedStatus = 'established';
      }
      assert.equal(invocationDuty.status, expectedStatus,
        `LINUX: the measured interval (computed ${computed}, write ${recordWrite}) must produce exactly the derived outcome`);
      assert.deepEqual(invocationDuty.reasons, expectedReasons,
        'LINUX: the exact named label for the measured interval');
    }
    // DETERMINISTIC LINUX-BRANCH PROOF (injected seams, runs on every host
    // and on ANY wall-clock): the synthetic btime/ticks are DERIVED FROM THE
    // WRITE INSTANT so the write provably lands INSIDE the computed
    // uncertainty window [computed, computed + 1000) by construction —
    // computed = round(write − 500) gives computed < write < computed + 1000
    // always (the real timeOrigin is fractional, so the derived instant is
    // rounded to a safe integer without leaving the window) — never by
    // clock luck (the round-14 correction: a boundary-crossing startup made
    // the old floor(origin)-derived control wall-clock dependent).
    const write = admission.identity.firstWritePreciseMs;
    const computedCreation = Math.round(write - 500);
    const linuxShapedLive = {
      localProcessObservationVersion: 1, class: 'os-live-observation', status: 'established',
      reason: null,
      observation: { pid: admission.identity.pid, ppid: process.pid, startIdentity: 'proc:42', nonce, startInstantEpochMs: computedCreation, ppidChangedFromCapture: null },
      queried: { pid: admission.identity.pid, nonce },
      readStartedEpochMs: Date.now(), readEpochMs: Date.now(), absenceConfirmed: null,
    };
    const linuxShapedJoin = await observationModule.adjudicateLocalDuties({
      nonce,
      invocation: {
        startupRecord: { status: 'established', identity: admission.identity },
        osObservation: linuxShapedLive,
      },
      broker: null, transport: null, identifiedDescendants: [],
    });
    const linuxShapedDuty = linuxShapedJoin.duties.find((entry) => entry.duty === 'invocation-process');
    assert.equal(linuxShapedDuty.status, 'unestablished',
      'LINUX (deterministic, injected): the write inside the btime uncertainty window never establishes — on any wall-clock');
    assert.deepEqual(linuxShapedDuty.reasons, ['generation-start-ambiguous'],
      'LINUX (deterministic, injected): the exact named conservative label — constructed from the write instant');
    // End-to-end continuation: the child exits and its disappearance is
    // adjudicated against its own verified presence (the exit promise was
    // registered at spawn — the exit event can never be missed).
    assert.equal(await exitOutcome, 0);
    const gone = await observationModule.observeLocalProcess({ pid: child.pid, nonce, expectedStartIdentity: liveObserved.observation.startIdentity });
    assert.equal(gone.status, 'absent');
    const exitVerdict = await observationModule.adjudicateLocalExit({ presence: liveObserved, absenceReads: [gone] });
    assert.equal(exitVerdict.status, 'disappeared');
  });

  test('the public surface of the observer module is the frozen contract — no stop authority, no lifecycle machinery', () => {
    assert.deepEqual(Object.keys(observerModule).sort(), [
      'EXECUTING_CLOSURE_PRELOAD_SOURCE',
      'EXECUTING_HELPER_MATERIALIZATION',
      'EXECUTING_LOCAL_PROCESS_OBSERVATION_SOURCE',
      'FAKE_ZCODE_NONCE_VARIABLE',
      'LINUX_BTIME_UNCERTAINTY_MS',
      'LINUX_PROC_RESOLUTION_MS',
      'LOCAL_OBSERVER_DIGEST_TAG',
      'LOCAL_PROCESS_OBSERVATION_VERSION',
      'adjudicateLocalDuties',
      'adjudicateLocalExit',
      'admitStartupIdentityRecord',
      'captureVerifiedProcessIdentity',
      'composeAncestryJoinForRuntime',
      'confirmProcessAbsenceWithOs',
      'inspectVerifiedProcessIdentity',
      'joinAncestryHops',
      'localProcessObserverProvenance',
      'observeLocalProcess',
      'readLocalObserverWorkingTreeProvenance',
      'terminateVerifiedProcess',
      'validateProcessMarker',
      'validateProcessNonce',
      'verifyLocalObserverHelperMaterialization',
    ], 'the observer exposes exactly the admission/adjudication/provenance surface — no terminate, kill or signal authority');
    // The non-interference static contract: the observer imports no
    // child-process machinery, registers no handlers, and keeps no timer.
    const source = readFileSync(observerModulePath, 'utf8');
    assert.ok(!source.includes('node:child_process'), 'the observer spawns no child process');
    assert.ok(!source.includes('setInterval('), 'the observer keeps no interval timer');
    // The only permitted delay is the BOUNDED termination deadline poll (a
    // Date.now()-bounded loop inside the awaited terminateVerifiedProcess);
    // nothing keeps the event loop alive past its awaited work.
    const setTimeoutUses = source.split('setTimeout(').length - 1;
    assert.ok(setTimeoutUses <= 1, 'the observer uses no unbounded or extra timers');
    if (setTimeoutUses === 1) {
      assert.ok(/setTimeout\(resolve, 50\)/u.test(source), 'the single delay is the bounded termination deadline poll');
    }
    assert.ok(!/process\.on\(/u.test(source), 'the observer registers no signal or exit handler');
  });

  test('the REAL launcher fast-fail stays byte-exact with the observation armed (public stdout/stderr/exit preserved)', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'shell-wait-local-process-launcher-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const captureDirectory = join(root, 'stdout-capture');
    await mkdir(captureDirectory, { mode: 0o700 });
    const nonce = randomBytes(32).toString('hex');
    const preload = await writeClosurePreload(root);
    const launcherRealpath = await realpath(fileURLToPath(new URL('../skills/rescue/launcher.mjs', import.meta.url)));
    const env = captureEnvironment({
      captureDirectory, nonce, entryRealpath: launcherRealpath,
      baseEnv: isolatedBaseEnv(root), nodeOptionsFragment: preload.nodeOptionsFragment,
    });
    const outcome = await spawnBounded(process.execPath, [launcherRealpath, 'invoke-prepared', 'rescue'], env);
    assert.equal(outcome.code, 1, 'the production fast-fail exit code is preserved');
    assert.equal(outcome.stdout, threadIdRequiredEnvelope.text, 'production stdout is byte-exact under observation');
    assert.equal(outcome.stderr, '');
    const { admitStdoutCapture } = await import('../tools/shell-wait-probe/closure-observation.mjs');
    const admission = await admitStdoutCapture({ captureDirectory, nonce, expectedExitCode: 1, expectedEntryRealpath: launcherRealpath });
    assert.equal(admission.status, 'complete');
    assert.equal(admission.exitAttribution, 'verified');
    const recordAdmission = await observerModule.admitStartupIdentityRecord({ captureDirectory, nonce, expectedEntryRealpath: launcherRealpath });
    assert.equal(recordAdmission.status, 'established', 'the identity record binds the REAL production launcher realpath');
    // Private fixture-owned files: everything bounded, inside the disposable
    // root, with the private permission contract.
    for (const name of [`${nonce}.stdout`, `${nonce}.meta.json`, `${nonce}.identity.json`]) {
      const stats = await lstat(join(captureDirectory, name));
      assert.ok(stats.isFile() && stats.size <= 65536, `${name} stays bounded`);
      assert.equal(stats.mode & 0o777, 0o600, `${name} is 0600-private`);
    }
    assert.equal((await lstat(captureDirectory)).mode & 0o777, 0o700, 'the capture directory is 0700-private');
  });

  test('an explicit business error exit keeps its exact stderr and exit code; the meta corroborates the lawful exit', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'shell-wait-local-process-error-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const captureDirectory = join(root, 'stdout-capture');
    await mkdir(captureDirectory, { mode: 0o700 });
    const nonce = randomBytes(32).toString('hex');
    const preload = await writeClosurePreload(root);
    const probePath = join(root, 'probe-entry.mjs');
    await writeFile(probePath, [
      "process.stdout.write('partial\\n');",
      "process.stderr.write('business failure detail\\n');",
      'process.exitCode = 3;',
      '',
    ].join('\n'), { mode: 0o700 });
    const entryRealpath = await realpath(probePath);
    const env = captureEnvironment({ captureDirectory, nonce, entryRealpath, baseEnv: isolatedBaseEnv(root), nodeOptionsFragment: preload.nodeOptionsFragment });
    const outcome = await spawnBounded(process.execPath, [entryRealpath, 'invoke-prepared', 'rescue'], env);
    assert.equal(outcome.code, 3, 'the business error exit code is preserved');
    assert.equal(outcome.stderr, 'business failure detail\n', 'stderr is untouched by the observation');
    const { admitStdoutCapture } = await import('../tools/shell-wait-probe/closure-observation.mjs');
    const admission = await admitStdoutCapture({ captureDirectory, nonce, expectedExitCode: 3 });
    assert.equal(admission.status, 'complete');
    assert.equal(admission.exitCode, 3);
    assert.equal(admission.stdout, 'partial\n');
    const exitFacts = await observerModule.adjudicateLocalExit({
      presence: await observerModule.observeLocalProcess({ pid: outcome.pid, nonce, inspect: async () => undefined }),
      absenceReads: [],
      exitMetaAdmission: admission,
    });
    assert.equal(exitFacts.status, 'unestablished');
    assert.equal(exitFacts.exitCorroboratedByMeta, false, 'the meta corroborates only an established disappearance — never instead of one');
  });

  test('observer write failure is a NAMED missing-observation fact and never a replaced business result (real control)', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'shell-wait-local-process-writefail-'));
    t.after(async () => {
      await chmod(captureDirectory, 0o700).catch(() => {});
      await rm(root, { recursive: true, force: true });
    });
    const captureDirectory = join(root, 'stdout-capture');
    await mkdir(captureDirectory, { mode: 0o700 });
    const nonce = randomBytes(32).toString('hex');
    const preload = await writeClosurePreload(root);
    const probePath = join(root, 'probe-entry.mjs');
    await writeFile(probePath, [
      "process.stdout.write('held\\n');",
      'await new Promise((resolve) => setTimeout(resolve, 700));',
      "process.stdout.write('done\\n');",
      '',
    ].join('\n'), { mode: 0o700 });
    const entryRealpath = await realpath(probePath);
    const env = captureEnvironment({ captureDirectory, nonce, entryRealpath, baseEnv: isolatedBaseEnv(root), nodeOptionsFragment: preload.nodeOptionsFragment });
    const child = spawn(process.execPath, [entryRealpath, 'invoke-prepared', 'rescue'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    // ROUND-33 sweep: the close/stdout listeners register IMMEDIATELY after
    // spawn — the awaited install wait and chmod below can outrun the child
    // on a slow runner, and a late-registered close listener misses the
    // event forever (unresolved promise).
    const outcome = new Promise((resolve) => {
      const stdoutChunks = [];
      child.stdout.on('data', (chunk) => stdoutChunks.push(chunk));
      child.once('close', (code, signal) => resolve({ code, signal, stdout: Buffer.concat(stdoutChunks).toString('utf8') }));
    });
    const recordPath = join(captureDirectory, `${nonce}.identity.json`);
    assert.equal(await waitFor(async () => lstat(recordPath).then(() => true, () => false)), true, 'the identity record installed');
    // The preload writes the identity record FIRST and the P2 capture file
    // SECOND (closure-preload.mjs): the chmod below must wait for BOTH —
    // under load the read-only flip raced the capture file's own creation
    // and the admission honestly reported `missing` (the capture file never
    // existed) instead of the tested `capture-meta-missing` shape.
    const captureFile = join(captureDirectory, `${nonce}.stdout`);
    assert.equal(await waitFor(async () => lstat(captureFile).then(() => true, () => false)), true, 'the P2 capture file installed');
    // The TEST makes its own fixture capture directory read-only AFTER the
    // install-time writes: the exit meta bookkeeping cannot land — the real
    // "observer lost the exit write" shape.
    await chmod(captureDirectory, 0o500);
    const closed = await outcome;
    await chmod(captureDirectory, 0o700);
    assert.equal(closed.code, 0, 'the business exit code is preserved even though the observer could not write');
    assert.equal(closed.stdout, 'held\ndone\n', 'the business stdout is preserved byte-exact');
    const recordAdmission = await observerModule.admitStartupIdentityRecord({ captureDirectory, nonce });
    assert.equal(recordAdmission.status, 'established', 'the install-time identity record stands');
    const { admitStdoutCapture } = await import('../tools/shell-wait-probe/closure-observation.mjs');
    const admission = await admitStdoutCapture({ captureDirectory, nonce });
    assert.equal(admission.status, 'incomplete');
    assert.equal(admission.reason, 'capture-meta-missing', 'the failed observer write is the NAMED missing fact');
    assert.equal(admission.stdout, null, 'a failed exit bookkeeping never fabricates a complete capture');
  });

  test('concurrent invocations are nonce-scoped: each scope admits only its own identity, no cross-attestation', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'shell-wait-local-process-concurrent-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const captureDirectory = join(root, 'stdout-capture');
    await mkdir(captureDirectory, { mode: 0o700 });
    const preload = await writeClosurePreload(root);
    const probePath = join(root, 'probe-entry.mjs');
    await writeFile(probePath, [
      "process.stdout.write('started\\n');",
      'await new Promise((resolve) => setTimeout(resolve, 500));',
      '',
    ].join('\n'), { mode: 0o700 });
    const entryRealpath = await realpath(probePath);
    const nonceA = randomBytes(32).toString('hex');
    const nonceB = randomBytes(32).toString('hex');
    const makeEnv = (nonce) => captureEnvironment({ captureDirectory, nonce, entryRealpath, baseEnv: isolatedBaseEnv(root), nodeOptionsFragment: preload.nodeOptionsFragment });
    const [outcomeA, outcomeB] = await Promise.all([
      spawnBounded(process.execPath, [entryRealpath, 'invoke-prepared', 'rescue'], makeEnv(nonceA)),
      spawnBounded(process.execPath, [entryRealpath, 'invoke-prepared', 'rescue'], makeEnv(nonceB)),
    ]);
    assert.equal(outcomeA.code, 0);
    assert.equal(outcomeB.code, 0);
    assert.notEqual(outcomeA.pid, outcomeB.pid, 'two distinct concurrent invocation processes');
    const admissionA = await observerModule.admitStartupIdentityRecord({ captureDirectory, nonce: nonceA });
    const admissionB = await observerModule.admitStartupIdentityRecord({ captureDirectory, nonce: nonceB });
    assert.equal(admissionA.status, 'established');
    assert.equal(admissionB.status, 'established');
    assert.equal(admissionA.identity.pid, outcomeA.pid);
    assert.equal(admissionB.identity.pid, outcomeB.pid);
    assert.equal((await readdir(captureDirectory)).filter((name) => name.endsWith('.identity.json')).length, 2,
      'each scope keeps exactly its own nonce-keyed identity record in the shared directory');
  });
});

describe('local-process observation: observer provenance and source-drift detection (task 2, plan §3)', async () => {
  const { readFileSync } = await import('node:fs');
  const { localProcessObserverProvenance, readLocalObserverWorkingTreeProvenance, EXECUTING_LOCAL_PROCESS_OBSERVATION_SOURCE, EXECUTING_CLOSURE_PRELOAD_SOURCE, EXECUTING_HELPER_MATERIALIZATION, LOCAL_OBSERVER_DIGEST_TAG } = await import('../tools/shell-wait-probe/local-process-observation.mjs');
  const { closurePreloadSource } = await import('./../tools/shell-wait-probe/closure-preload.mjs'.replace('./../', '../'));

  // The v4 construction: observer bytes (the identity machinery LIVES here)
  // || the closure-preload module's executing bytes || the three MATERIALIZED
  // executing helper copy digests || the generated capture source,
  // NUL-separated under the versioned tag.
  const digest = (tag, localBytes, closurePreloadBytes, helperDigests, generatedBytes) => createHash('sha256')
    .update(`${tag}\0`)
    .update(localBytes)
    .update('\0')
    .update(closurePreloadBytes)
    .update('\0')
    .update(`${helperDigests['scripts/lib/fs.mjs']}\0${helperDigests['scripts/lib/process.mjs']}\0${helperDigests['scripts/lib/errors.mjs']}`)
    .update('\0')
    .update(generatedBytes)
    .digest('hex');

  test('the executing provenance binds the observer bytes, the materialized executing helper copies and the generated capture source under the v4 tag', () => {
    const provenance = localProcessObserverProvenance();
    assert.equal(provenance.tag, 'zcode-shell-wait-local-observer-v4');
    assert.equal(provenance.revision, 'working-tree-uncommitted');
    assert.equal(provenance.model, null, 'the executing model stays unknown in the provenance');
    const expected = digest(
      provenance.tag,
      EXECUTING_LOCAL_PROCESS_OBSERVATION_SOURCE,
      EXECUTING_CLOSURE_PRELOAD_SOURCE,
      EXECUTING_HELPER_MATERIALIZATION.bytes,
      Buffer.from(closurePreloadSource(), 'utf8'),
    );
    assert.equal(provenance.digest, expected, 'the digest is the documented NUL-separated construction over the actual executing bytes');
    assert.match(String(provenance.digestInput), /local-process-observation\.mjs/u);
    assert.match(String(provenance.digestInput), /closure-preload\.mjs/u, 'the digest input names the generated preload seam');
    assert.match(String(provenance.digestInput), /MATERIALIZED EXECUTING COPY DIGESTS/u, 'the digest input names the materialized executing helper copies');
    assert.match(String(provenance.digestInput), /closurePreloadSource|generated/u, 'the digest input names the generated capture source');
    assert.equal(provenance.generatedPreloadSha256, createHash('sha256').update(Buffer.from(closurePreloadSource(), 'utf8')).digest('hex'),
      'the recorded generated-preload hash is the actual source hash');
  });

  test('the binding is load-bearing: changing any input changes the digest and the recorded generated hash', () => {
    const provenance = localProcessObserverProvenance();
    const generated = Buffer.from(closurePreloadSource(), 'utf8');
    const digests = EXECUTING_HELPER_MATERIALIZATION.bytes;
    const flipLast = (hex) => hex.slice(0, -1) + (hex.endsWith('0') ? '1' : '0');
    assert.notEqual(
      digest(LOCAL_OBSERVER_DIGEST_TAG, Buffer.concat([EXECUTING_LOCAL_PROCESS_OBSERVATION_SOURCE, Buffer.from('\n')]), EXECUTING_CLOSURE_PRELOAD_SOURCE, digests, generated),
      provenance.digest,
      'an observer-module-only byte change must change the digest',
    );
    assert.notEqual(
      digest(LOCAL_OBSERVER_DIGEST_TAG, EXECUTING_LOCAL_PROCESS_OBSERVATION_SOURCE, Buffer.concat([EXECUTING_CLOSURE_PRELOAD_SOURCE, Buffer.from('\n')]), digests, generated),
      provenance.digest,
      'a closure-preload-only byte change must change the digest',
    );
    assert.notEqual(
      digest(LOCAL_OBSERVER_DIGEST_TAG, EXECUTING_LOCAL_PROCESS_OBSERVATION_SOURCE, EXECUTING_CLOSURE_PRELOAD_SOURCE, { ...digests, 'scripts/lib/fs.mjs': flipLast(digests['scripts/lib/fs.mjs']) }, generated),
      provenance.digest,
      'a materialized-fs-copy digest change must change the digest',
    );
    assert.notEqual(
      digest(LOCAL_OBSERVER_DIGEST_TAG, EXECUTING_LOCAL_PROCESS_OBSERVATION_SOURCE, EXECUTING_CLOSURE_PRELOAD_SOURCE, { ...digests, 'scripts/lib/process.mjs': flipLast(digests['scripts/lib/process.mjs']) }, generated),
      provenance.digest,
      'a materialized-process-copy digest change must change the digest',
    );
    assert.notEqual(
      digest(LOCAL_OBSERVER_DIGEST_TAG, EXECUTING_LOCAL_PROCESS_OBSERVATION_SOURCE, EXECUTING_CLOSURE_PRELOAD_SOURCE, { ...digests, 'scripts/lib/errors.mjs': flipLast(digests['scripts/lib/errors.mjs']) }, generated),
      provenance.digest,
      'a materialized-errors-copy digest change must change the digest',
    );
    assert.notEqual(
      digest(LOCAL_OBSERVER_DIGEST_TAG, EXECUTING_LOCAL_PROCESS_OBSERVATION_SOURCE, EXECUTING_CLOSURE_PRELOAD_SOURCE, digests, Buffer.concat([generated, Buffer.from('\n')])),
      provenance.digest,
      'a generated-preload-only byte change must change the digest',
    );
    const otherTag = digest('zcode-shell-wait-local-observer-v3', EXECUTING_LOCAL_PROCESS_OBSERVATION_SOURCE, EXECUTING_CLOSURE_PRELOAD_SOURCE, digests, generated);
    assert.notEqual(otherTag, provenance.digest, 'copying an old construction version must not reproduce the digest');
  });

  test('materialization lands INSIDE the repo dependency scope and the copied fs.mjs loads (standalone-safe)', async () => {
    // Round-9 finding 1: the cache root must resolve to the REPOSITORY root
    // (`../..` from tools/shell-wait-probe/), not its parent — in a
    // standalone checkout a parent-rooted cache falls outside
    // dependency-resolution scope and the copied fs.mjs cannot load its
    // native dependency, breaking startup admission and inspection.
    assert.equal(EXECUTING_HELPER_MATERIALIZATION.dir !== null, true, 'materialization succeeded');
    const path = await import('node:path');
    const repositoryRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
    assert.ok(EXECUTING_HELPER_MATERIALIZATION.dir.startsWith(path.join(repositoryRoot, 'node_modules') + '/'),
      'the cache layout is inside the repo node_modules scope');
    assert.ok(EXECUTING_HELPER_MATERIALIZATION.bytes['scripts/lib/fs.mjs'], 'the copied fs bytes are hashed');
  });

  test('the copied fs.mjs ACTUALLY LOADS from the materialization (executing == hashed)', async () => {
    const { pathToFileURL } = await import('node:url');
    assert.ok(EXECUTING_HELPER_MATERIALIZATION.dir !== null);
    const copiedFs = await import(pathToFileURL(join(EXECUTING_HELPER_MATERIALIZATION.dir, 'scripts/lib/fs.mjs')).href);
    assert.equal(typeof copiedFs.readBoundedJsonFile, 'function', 'the copied fs.mjs resolves its imports and loads');
    const copiedProcess = await import(pathToFileURL(join(EXECUTING_HELPER_MATERIALIZATION.dir, 'scripts/lib/process.mjs')).href);
    assert.equal(typeof copiedProcess.runProcess, 'function', 'the copied process.mjs loads');
  });

  test('executing provenance is NAMED-UNAVAILABLE when materialization is unavailable (null digest, never undefined interpolation)', async () => {
    // Round-9 finding 4: a read-only checkout can fail cache initialization;
    // observation then falls back to cached production modules. The
    // EXECUTING provenance must mirror the record-time reader and go
    // NAMED-UNAVAILABLE (null digest) — never emit a digest with literal
    // `undefined` helper-copy interpolation that binds nothing.
    const unavailable = localProcessObserverProvenance({ materialization: { dir: null, bytes: {} } });
    assert.equal(unavailable.revision, 'helper-materialization-unavailable');
    assert.equal(unavailable.digest, null, 'no digest is attributed without the executing copies');
    assert.equal(unavailable.tag, LOCAL_OBSERVER_DIGEST_TAG);
    assert.match(String(unavailable.digestInput ?? ''), /helper-materialization-unavailable/u);
    assert.equal(unavailable.model, null);
    // The available path is unchanged.
    const available = localProcessObserverProvenance();
    assert.equal(available.revision, 'working-tree-uncommitted');
    assert.match(available.digest, /^[a-f0-9]{64}$/u);
    assert.equal(available.tag, LOCAL_OBSERVER_DIGEST_TAG);
  });

  test('a PRIVATE-constant edit invisible to exported strings is caught by the executing-copy byte drift', async (t) => {
    // Round-8 finding 2: changing only POST_EXIT_DRAIN_MS in
    // scripts/lib/process.mjs keeps every exported function string identical,
    // so an exported-string comparison reports consistent:true while the
    // executing code is the old version. The materialized-copy mechanism
    // hashes the EXECUTING bytes and drift-checks them against current disk.
    const { verifyLocalObserverHelperMaterialization } = await import('../tools/shell-wait-probe/local-process-observation.mjs');
    const { mkdtempSync, copyFileSync, writeFileSync } = await import('node:fs');
    const { pathToFileURL } = await import('node:url');
    const processHelperPath = fileURLToPath(new URL('../scripts/lib/process.mjs', import.meta.url));
    const originalBytes = readFileSync(processHelperPath);
    const root = mkdtempSync(join(tmpdir(), 'helper-private-edit-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    // The edited copy keeps the production relative-import layout
    // (scripts/lib/ with its ./errors.mjs sibling) so the namespace loads.
    const editedLib = join(root, 'scripts', 'lib');
    await (await import('node:fs/promises')).mkdir(editedLib, { recursive: true });
    await (await import('node:fs/promises')).copyFile(fileURLToPath(new URL('../scripts/lib/errors.mjs', import.meta.url)), join(editedLib, 'errors.mjs'));
    const editedPath = join(editedLib, 'process.mjs');
    copyFileSync(processHelperPath, editedPath);
    const text = readFileSync(editedPath, 'utf8');
    assert.ok(text.includes('POST_EXIT_DRAIN_MS'), 'the private constant exists in the helper');
    writeFileSync(editedPath, text.replace(/POST_EXIT_DRAIN_MS = \d+/u, 'POST_EXIT_DRAIN_MS = 999999'), 'utf8');
    const editedBytes = readFileSync(editedPath);
    assert.notEqual(Buffer.compare(originalBytes, editedBytes), 0, 'the private edit changed the bytes');
    // THE OLD MECHANISM (exported-string comparison): the same file compared
    // against itself reports consistent — the documented blind spot.
    const namespaceOf = async (path) => import(pathToFileURL(path).href);
    const cachedNamespace = await namespaceOf(editedPath);
    const freshNamespace = await namespaceOf(editedPath);
    const oldStyleConsistent = Object.keys(cachedNamespace).sort().join(',') === Object.keys(freshNamespace).sort().join(',')
      && Object.keys(cachedNamespace).every((key) => String(cachedNamespace[key]) === String(freshNamespace[key]));
    assert.equal(oldStyleConsistent, true, 'the exported-string mechanism genuinely cannot see the private edit');
    // THE NEW MECHANISM: byte drift between the executing copy digests and
    // the current disk bytes (injected seams; the real verifier reads the
    // production files).
    const drift = await verifyLocalObserverHelperMaterialization({
      diskBytes: async (relativeName) => (relativeName === 'scripts/lib/process.mjs' ? editedBytes : readFileSync(fileURLToPath(new URL(`../${relativeName}`, import.meta.url)))),
    });
    assert.equal(drift.consistent, false, 'the byte mechanism catches the private edit');
    assert.ok(drift.mismatches.some((entry) => entry.includes('scripts/lib/process.mjs')), 'the drifted helper is named');
  });

  test('helper materialization drift goes NAMED-UNAVAILABLE in the record-time provenance', async () => {
    const { readLocalObserverWorkingTreeProvenance } = await import('../tools/shell-wait-probe/local-process-observation.mjs');
    const processHelperPath = fileURLToPath(new URL('../scripts/lib/process.mjs', import.meta.url));
    const realBytes = await (await import('node:fs/promises')).readFile(processHelperPath);
    const recordTime = await readLocalObserverWorkingTreeProvenance({
      diskBytes: async (relativeName) => (relativeName === 'scripts/lib/process.mjs' ? Buffer.concat([realBytes, Buffer.from('\n')]) : realBytes),
    });
    assert.equal(recordTime.revision, 'helper-materialization-drift', 'the revision names the drift case');
    assert.equal(recordTime.digest, null, 'no digest is attributed across the divergence');
    assert.ok(recordTime.helperCacheMismatches.some((entry) => entry.includes('scripts/lib/process.mjs')), 'the drifted helper is named');
    assert.match(String(recordTime.digestInput ?? ''), /helper-materialization-drift/u);
  });

  test('the record-time working-tree reader uses the same construction, so at rest the digests agree (drift = none)', async () => {
    const recordTime = await readLocalObserverWorkingTreeProvenance();
    const executing = localProcessObserverProvenance();
    assert.equal(recordTime.digest, executing.digest, 'at rest the working-tree bytes equal the materialized/init bytes');
    assert.equal(recordTime.tag, executing.tag);
    assert.equal(recordTime.generatedPreloadSha256, executing.generatedPreloadSha256);
    assert.equal(recordTime.helperCache.consistent, true, 'at rest the executing helper copies match the on-disk helpers');
    assert.match(String(recordTime.digestInput), /working-tree/u, 'the record-time reader names its working-tree basis');
    assert.equal(EXECUTING_LOCAL_PROCESS_OBSERVATION_SOURCE.equals(readFileSync(fileURLToPath(new URL('../tools/shell-wait-probe/local-process-observation.mjs', import.meta.url)))), true);
  });
});

describe('local-process observation: arming fails closed without the declared broker entry (task 2, §25.4 item 4)', async () => {
  test('arming a fixture whose installed root lacks zcode-broker.mjs fails loudly with the named error', async (t) => {
    const { spawnSync } = await import('node:child_process');
    const { cp, mkdir } = await import('node:fs/promises');
    const { createShellWaitFixture } = await import('../tools/shell-wait-probe/fixture.mjs');
    const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
    const repositorySha = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
    const root = await mkdtemp(join(tmpdir(), 'shell-wait-local-process-armfail-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const output = join(root, 'output');
    await mkdir(output, { mode: 0o700 });
    // The fast seam-injected installer (the closure describe's exact pattern)
    // materializes the launcher the capture gate realpaths but DELIBERATELY
    // no scripts/zcode-broker.mjs: the arming must refuse loudly — never a
    // silently undeclared broker-daemon hop (§25.10).
    await assert.rejects(
      () => createShellWaitFixture({
        sourceRoot: repositoryRoot, sourceSha: repositorySha, codexBinary: process.execPath,
        output, variant: 'candidate', capMs: null, stdoutCapture: true,
      }, {
        buildSnapshot: async ({ output: snapshotOutput, sourceSha }) => {
          await mkdir(join(snapshotOutput, '.agents', 'plugins'), { recursive: true });
          await writeFile(join(snapshotOutput, '.agents', 'plugins', 'provenance.json'), JSON.stringify({ sourceSha }), 'utf8');
        },
        installPlugin: async ({ codexHome, cleanSource }) => {
          const installed = join(codexHome, 'plugins', 'cache', 'vitry', 'zcode', '0.1.0');
          await mkdir(join(installed, 'agents'), { recursive: true });
          for (const skill of ['rescue', 'review', 'adversarial-review', 'status']) {
            await mkdir(join(installed, 'skills', skill), { recursive: true });
            await cp(join(cleanSource, 'skills', skill, 'SKILL.md'), join(installed, 'skills', skill, 'SKILL.md'));
          }
          await cp(join(cleanSource, 'agents', 'zcode-rescue.toml.template'), join(installed, 'agents', 'zcode-rescue.toml.template'));
          await writeFile(join(installed, 'skills', 'rescue', 'launcher.mjs'), 'process.exit(0);\n', 'utf8');
          await writeFile(join(codexHome, 'config.toml'), '[plugins."zcode@vitry"]\nenabled = true\n', 'utf8');
          return { pluginVersion: '0.1.0' };
        },
        runSetup: async () => ({ sessionEstablished: true, launcherDescriptorPublished: true, setupAttempts: 1, roleStatus: 'ready', capVerified: true }),
      }),
      /armed observation seam requires the installed zcode-broker\.mjs/u,
      'the arming must fail loudly when the declared broker-daemon entry cannot be resolved',
    );
  });
});

// ---------------------------------------------------------------------------
// Local-settlement Task 3 (plan Task 3): the registered gates wired into the
// live executor. OFFLINE throughout: the held turn runs on injected
// executor/observation seams exactly like the existing driver tests — no
// host, provider, or real Companion process is ever launched here. The only
// real bytes are the observer's own closed verdict shapes (task 2 exports).
// ---------------------------------------------------------------------------

describe('local-settlement task 3: the concurrent local-observation runtime in the held turn (§25.7 local reads row)', async () => {
  const { runHeldHostTurn } = await import('../tools/shell-wait-probe/driver.mjs');

  const CAPTURE_NONCE = 'c'.repeat(64);
  const TRANSPORT_NONCE = '9'.repeat(64);
  const ENTRY = '/private/tmp/fixture-installed/skills/rescue/launcher.mjs';
  const BROKER_ENTRY = '/private/tmp/fixture-installed/scripts/zcode-broker.mjs';
  const DECLARATION = Object.freeze({
    captureDirectory: '/private/tmp/fixture-capture',
    nonce: CAPTURE_NONCE,
    entryRealpath: ENTRY,
    brokerEntryRealpath: BROKER_ENTRY,
  });

  /** One established invocation startup-record admission (the observer's own shape). */
  const admissionEstablished = (over = {}) => ({
    localProcessObservationVersion: 1,
    class: 'startup-identity',
    status: 'established',
    reason: null,
    identity: {
      role: 'invocation', nonce: CAPTURE_NONCE, entryRealpath: ENTRY,
      argv: ['invoke-prepared', 'rescue'], pid: 60100, ppid: 600,
      firstWriteEpochMs: 1000, startOriginMs: 1000.1, firstWritePreciseMs: 1100.5,
    },
    readStartedEpochMs: 1000,
    readEpochMs: 1100,
    ...over,
  });
  /** One established OS live observation bound to the admitted generation (darwin-style start identity).
   * Ancestry re-verification (review round 2): the runtime now composes the
   * ancestry join from these SAME embedded verdicts, so the synthesis carries
   * the per-row second gaps andCompatible parentage that the frozen hop
   * lifetimes credit; the read instant windows stay ≥ the uniform bound.
   * @param {{ row?: 'companion'|'daemon'|'transport', startInstantEpochMs?: number, readStartedEpochMs?: number, identityReadEpochMs?: number, readEpochMs?: number, observation?: any, queried?: any }} over */
  const osEstablished = (over = {}) => {
    const row = over?.row ?? 'companion';
    const defaults = {
      companion: { pid: 60100, ppid: 600, startIdentity: 'S-COMPANION', nonce: CAPTURE_NONCE, startInstantEpochMs: 1_000 },
      daemon: { pid: 60200, ppid: 60100, startIdentity: 'S-DAEMON', nonce: CAPTURE_NONCE, startInstantEpochMs: 3_000 },
      transport: { pid: 60300, ppid: 60200, startIdentity: 'S-TRANSPORT', nonce: TRANSPORT_NONCE, startInstantEpochMs: 5_000 },
    }[row];
    return {
      localProcessObservationVersion: 1,
      class: 'os-live-observation',
      status: 'established',
      reason: null,
      observation: { ...defaults, ppidChangedFromCapture: null,
        ...(over?.observation ?? {}) },
      queried: { pid: /** @type {any} */ (defaults).pid,
        nonce: row === 'transport' ? TRANSPORT_NONCE : CAPTURE_NONCE,
        ...(over?.queried ?? {}) },
      // The COMPANION row's READ windows live AFTER the daemon row's start
      // instant by ≥ the uniform whole-second bound (the ancestry join's
      // generation-compatibility: a parent proves its child existed only
      // when its OWN read happened after the child's creation).
      readStartedEpochMs: over?.readStartedEpochMs ?? (row === 'companion' ? 4_000 : row === 'daemon' ? 4_100 : 6_100),
      identityReadEpochMs: over?.identityReadEpochMs ?? (row === 'companion' ? 4_200 : row === 'daemon' ? 4_300 : 6_300),
      readEpochMs: over?.readEpochMs ?? (row === 'companion' ? 4_500 : row === 'daemon' ? 4_500 : 6_500),
      absenceConfirmed: null,
      ...(() => { const rest = { ...over }; delete rest.row; delete rest.startInstantEpochMs; delete rest.readStartedEpochMs; delete rest.identityReadEpochMs; delete rest.readEpochMs; delete rest.observation; delete rest.queried; return rest; })(),
    };
  };
  /** One positively confirmed absence of the SAME queried identity. */
  const osAbsent = (over = {}) => ({
    localProcessObservationVersion: 1,
    class: 'os-live-observation',
    status: 'absent',
    reason: 'no-such-process',
    observation: null,
    queried: { pid: 60100, nonce: CAPTURE_NONCE },
    readStartedEpochMs: 5000,
    readEpochMs: 5100,
    absenceConfirmed: true,
    ...over,
  });

  test('the armed runtime admits the RUNTIME declaration and sees the real Companion alive before the interruption', async () => {
    // The fake-host instrument: the launch result stays pending while the
    // local-observation runtime runs, so every runtime fact below is provably
    // collected BEFORE the host process ended (before any interruption).
    const calls = [];
    let launchSettled = false;
    const transportCaptures = [];
    const held = await runHeldHostTurn({
      gatePath: 'unused-gate',
      launch: async () => ({
        result: new Promise((resolve) => setTimeout(() => { launchSettled = true; resolve({ code: 0, stdout: '', stderr: '' }); }, 40)),
        terminate: async () => {},
      }),
      waitForGate: async () => new Promise(() => {}),
      captureProcessIdentity: async () => {
        transportCaptures.push(true);
        // The marker's ppid binds to the DAEMON pid and its epoch to the
        // daemon row (both compared by the runtime ancestry hop (b)).
        return { pid: 60300, ppid: 60200, nonce: TRANSPORT_NONCE, startIdentity: 'S-TRANSPORT', markerEpochMs: 4_200 };
      },
      readProcessIdentity: async () => ({ pid: 60300, ppid: 60100, nonce: TRANSPORT_NONCE, startIdentity: 'S-TRANSPORT' }),
      terminateProcessIdentity: async () => ({ attempted: true, signalled: 'SIGTERM', exited: true, failure: null }),
      waitForProcessExit: async () => {},
      releaseGate: async () => {},
      localObservation: DECLARATION,
      captureLocalObservationIdentity: async (input) => {
        calls.push(['admit', input, launchSettled]);
        return admissionEstablished();
      },
      observeLocalObservationIdentity: async (input) => {
        calls.push(['observe', input, launchSettled]);
        return osEstablished();
      },
      captureLocalBrokerObservationIdentity: async (input) => {
        calls.push(['broker-admit', input, launchSettled]);
        return {
          ...admissionEstablished(),
          identity: { role: 'broker-daemon', nonce: CAPTURE_NONCE, entryRealpath: BROKER_ENTRY, configRealpathSha256: 'b'.repeat(64), pid: 60200, ppid: 60100, firstWriteEpochMs: 3_020, startOriginMs: 3_000.2, firstWritePreciseMs: 3_020.6 },
        };
      },
      observeLocalBrokerObservationIdentity: async (input) => {
        calls.push(['broker-observe', input, launchSettled]);
        return osEstablished({ row: 'daemon' });
      },
      observeLocalTransportObservationIdentity: async (input) => {
        calls.push(['transport-observe', input, launchSettled]);
        return osEstablished({ row: 'transport' });
      },
      sleep: async () => {},
      // The monotonic clock ADVANCES per read (the existing held-turn
      // harness shape): the hold loop terminates by clock progress and the
      // turn ends when the launch result settles — never a hot wait.
      now: (() => { let value = 0; return () => (value += 500); })(),
      holdMs: 5_000,
      budgetMs: 60_000,
      processNonce: TRANSPORT_NONCE,
    });
    // The RUNTIME declaration (not a fake-peer identity): the admission input
    // carries the fixture capture nonce and the declared launcher entry —
    // never the transport's own FAKE_ZCODE_PROCESS_NONCE and never a marker
    // identity.
    const admit = calls.find(([kind]) => kind === 'admit');
    assert.ok(admit, 'the runtime admitted the startup identity record');
    assert.equal(admit[1].nonce, CAPTURE_NONCE, 'the admission runs against the fixture capture scope nonce');
    assert.notEqual(admit[1].nonce, TRANSPORT_NONCE, 'the capture scope is never the fake-peer transport nonce');
    assert.equal(admit[1].expectedEntryRealpath, ENTRY, 'the admission binds the declared launcher entry');
    assert.equal(admit[1].role, 'invocation');
    // The observation is chained to the ADMITTED identity (never a stale or
    // cached generation), scoped by the same capture nonce.
    const observe = calls.find(([kind]) => kind === 'observe');
    assert.ok(observe, 'the runtime observed the admitted identity');
    assert.equal(observe[1].pid, 60100, 'the observation queries the admitted record pid');
    assert.equal(observe[1].expectedStartIdentity, undefined, 'no stale start identity is injected ahead of the admission');
    assert.equal(observe[1].nonce, CAPTURE_NONCE);
    // EARLY arming: every runtime fact was collected while the host turn was
    // still open (before the launch result settled — before any interruption)
    // — EXCEPT the transport's EXIT observation, which by design (review
    // round 8) reads the exit window after the invocation's confirmed
    // absence.
    for (const [kind, , settledAtCall] of calls) {
      if (kind === 'transport-observe' && settledAtCall === true) continue;
      assert.equal(settledAtCall, false, `the ${kind} fact was collected before the host turn ended`);
    }
    // No extra Child poll: the driver's own transport capture ran exactly
    // once (the local runtime never polls the Child's handle).
    assert.equal(transportCaptures.length, 1, 'the local runtime adds no extra transport/Child capture');
    // The persisted block: armed, with the runtime verdicts and stamps.
    const block = held.cleanup.localObservation;
    assert.ok(block, 'the held record carries the local-observation block');
    assert.equal(block.version, 1);
    assert.equal(block.armed, true);
    assert.equal(block.admission.status, 'established');
    assert.equal(block.presence.status, 'established', 'the real Companion was seen ALIVE before the interruption');
    assert.equal(typeof block.presence.readEpochMs, 'number', 'the presence fact carries its collection timestamp');
    // The scope digest binds the block without persisting the raw nonce.
    const { createHash } = await import('node:crypto');
    assert.equal(block.nonceSha256, createHash('sha256').update(CAPTURE_NONCE).digest('hex'), 'the block carries the scope DIGEST, never the raw nonce');
    assert.equal(JSON.stringify(block).includes(CAPTURE_NONCE), false, 'the raw capture nonce never rides the block');
    assert.equal(JSON.stringify(block).includes(TRANSPORT_NONCE), false, 'the raw transport nonce never rides the block');
    // The duty facts: the three applicable duties from the runtime facts.
    assert.ok(block.duties, 'the runtime composed the local-duty verdict');
    assert.deepEqual(block.duties.duties.map((duty) => duty.duty), ['invocation-process', 'broker-daemon', 'transport-descendant']);
    assert.equal(block.duties.settled, true, `every applicable local duty was positively established (ancestry ${JSON.stringify(block.ancestry ?? null)}, duties ${JSON.stringify(block.duties.duties)})`);
    // The composition carries its own completion instant for the fences.
    assert.equal(typeof block.composedAtMs, 'number');
  });

  test('the runtime adjudicates the invocation exit from post-release absence reads and persists it before disposal', async () => {
    let reads = 0;
    const held = await runHeldHostTurn({
      gatePath: 'unused-gate',
      // The launch result stays pending until the runtime's post-release
      // absence phase completed its FIRST absence read — the turn cannot end
      // (never the final abort) before the runtime collected the absence fact,
      // so the choreography is scheduling-independent: the facts provably ride
      // the record BEFORE the turn ends.
      launch: async () => ({
        result: new Promise((resolve) => {
          // Bounded: if the runtime's fence window ever withheld the absence
          // read (an untested shape), the turn still ends quickly and the
          // premise assertion below fails loudly — never a runner hang.
          const anchor = setInterval(() => { clearInterval(anchor); resolve({ code: 0, stdout: '', stderr: '' }); }, 2_000);
          anchor.unref?.();
        }),
        terminate: async () => {},
      }),
      waitForGate: async () => {},
      captureProcessIdentity: async () => ({ pid: 60300, ppid: 60100, nonce: TRANSPORT_NONCE, startIdentity: 'S-TRANSPORT' }),
      readProcessIdentity: async () => undefined,
      terminateProcessIdentity: async () => ({ attempted: true, signalled: 'SIGTERM', exited: true, failure: null }),
      waitForProcessExit: async () => {},
      releaseGate: async () => {},
      localObservation: DECLARATION,
      captureLocalObservationIdentity: async () => admissionEstablished(),
      observeLocalObservationIdentity: async () => { reads += 1; return reads === 1 ? osEstablished() : osAbsent({ readStartedEpochMs: 5000 + reads, readEpochMs: 5100 + reads }); },
      captureLocalBrokerObservationIdentity: async () => ({
        ...admissionEstablished(),
        identity: { role: 'broker-daemon', nonce: CAPTURE_NONCE, entryRealpath: BROKER_ENTRY, configRealpathSha256: 'b'.repeat(64), pid: 60200, ppid: 60100, firstWriteEpochMs: 1000, startOriginMs: 1000.2, firstWritePreciseMs: 1100.6 },
      }),
      observeLocalBrokerObservationIdentity: async () => osEstablished({ observation: { pid: 60200, ppid: 60100, startIdentity: 'S-DAEMON', nonce: CAPTURE_NONCE, startInstantEpochMs: 1000, ppidChangedFromCapture: null }, queried: { pid: 60200, nonce: CAPTURE_NONCE } }),
      observeLocalTransportObservationIdentity: async () => osEstablished({ observation: { pid: 60300, ppid: 60100, startIdentity: 'S-TRANSPORT', nonce: TRANSPORT_NONCE, startInstantEpochMs: 1000, ppidChangedFromCapture: null }, queried: { pid: 60300, nonce: TRANSPORT_NONCE } }),
      sleep: async () => {},
      // The hold runs to its deadline on the advancing clock, so the turn is
      // still in the held phase when the runtime finishes its establishment
      // facts — the post-release absence phase then runs against the fence
      // window, exactly the registered choreography. The budget is far
      // beyond this call-counting clock, so no budget abort can race the
      // phases (the turn ends by the anchored launch result, never the
      // budget).
      now: (() => { let value = 0; return () => (value += 500); })(),
      holdMs: 5_000,
      budgetMs: 10_000_000_000,
      processNonce: TRANSPORT_NONCE,
    });
    const block = held.cleanup.localObservation;
    assert.ok(block, 'the block persists on the early-completion path too');
    assert.ok(reads >= 2, `premise: the runtime ran the post-release absence phase (reads=${reads}, stoppedAt=${block.stoppedAt}, releasedGate=${held.cleanup.releasedGate}, fence=${block.fenceAtMs}, boundary=${block.cleanupBoundaryAtMs}, cutoff=${block.cutoffAtMs})`);
    assert.equal(block.exit.status, 'disappeared', 'the previously established generation was positively adjudicated gone');
    assert.equal(block.exit.boundIdentity.pid, 60100);
    assert.equal(typeof block.exit.firstVerifiedAbsenceEpochMs, 'number');
  });

  test('a missing startup record is a named unestablished fact — never launch readiness, never readiness', async () => {
    const held = await runHeldHostTurn({
      gatePath: 'unused-gate',
      launch: async () => ({ result: Promise.resolve({ code: 0, stdout: '', stderr: '' }), terminate: async () => {} }),
      waitForGate: async () => {},
      captureProcessIdentity: async () => ({ pid: 60300, ppid: 60100, nonce: TRANSPORT_NONCE, startIdentity: 'S-TRANSPORT' }),
      readProcessIdentity: async () => undefined,
      terminateProcessIdentity: async () => ({ attempted: true, signalled: 'SIGTERM', exited: true, failure: null }),
      waitForProcessExit: async () => {},
      releaseGate: async () => {},
      localObservation: DECLARATION,
      captureLocalObservationIdentity: async () => ({
        ...admissionEstablished(),
        status: 'missing',
        reason: 'identity-record-missing',
        identity: null,
      }),
      observeLocalObservationIdentity: async () => { throw new Error('the observation must never run without an admitted identity'); },
      captureLocalBrokerObservationIdentity: async () => ({ ...admissionEstablished(), status: 'missing', reason: 'identity-record-missing', identity: null }),
      observeLocalBrokerObservationIdentity: async () => { throw new Error('the broker observation must never run without an admitted identity'); },
      observeLocalTransportObservationIdentity: async () => osEstablished({ observation: { pid: 60300, ppid: 60100, startIdentity: 'S-TRANSPORT', nonce: TRANSPORT_NONCE, startInstantEpochMs: 1000, ppidChangedFromCapture: null }, queried: { pid: 60300, nonce: TRANSPORT_NONCE } }),
      sleep: async () => {},
      now: () => 1_000,
      holdMs: 0,
      budgetMs: 60_000,
      processNonce: TRANSPORT_NONCE,
    });
    const block = held.cleanup.localObservation;
    assert.ok(block, 'the block still rides the record');
    assert.equal(block.admission.status, 'missing', 'the missing record is the named missing fact');
    assert.equal(block.presence, null, 'no presence fact is invented');
    assert.equal(block.duties.settled, false, 'the duties never settle on a missing record');
    assert.ok(block.duties.duties.find((duty) => duty.duty === 'invocation-process').reasons.includes('no-fact-supplied'));
  });

  test('the runtime is inert without the declaration: no block, no seams, schema stable', async () => {
    let seamCalls = 0;
    const held = await runHeldHostTurn({
      gatePath: 'unused-gate',
      launch: async () => ({ result: Promise.resolve({ code: 0, stdout: '', stderr: '' }), terminate: async () => {} }),
      waitForGate: async () => {},
      captureProcessIdentity: async () => ({ pid: 60300, ppid: 60100, nonce: TRANSPORT_NONCE, startIdentity: 'S-TRANSPORT' }),
      readProcessIdentity: async () => undefined,
      terminateProcessIdentity: async () => ({ attempted: true, signalled: 'SIGTERM', exited: true, failure: null }),
      waitForProcessExit: async () => {},
      releaseGate: async () => {},
      captureLocalObservationIdentity: async () => { seamCalls += 1; return admissionEstablished(); },
      sleep: async () => {},
      now: () => 1_000,
      holdMs: 0,
      budgetMs: 60_000,
      processNonce: TRANSPORT_NONCE,
    });
    assert.equal(seamCalls, 0, 'no local-observation seam runs without the declaration');
    assert.equal(Object.hasOwn(held.cleanup, 'localObservation'), false, 'an unarmed run gains no block key (schema stability)');
  });

  test('a failure path (launch rejects) still persists the collected local facts', async () => {
    const held = await runHeldHostTurn({
      gatePath: 'unused-gate',
      launch: async () => { throw new Error('the host failed before the gate'); },
      waitForGate: async () => new Promise(() => {}),
      captureProcessIdentity: async () => ({ pid: 60300, ppid: 60100, nonce: TRANSPORT_NONCE, startIdentity: 'S-TRANSPORT' }),
      readProcessIdentity: async () => ({ pid: 60300, ppid: 60100, nonce: TRANSPORT_NONCE, startIdentity: 'S-TRANSPORT' }),
      terminateProcessIdentity: async () => ({ attempted: true, signalled: 'SIGTERM', exited: true, failure: null }),
      waitForProcessExit: async () => {},
      releaseGate: async () => {},
      localObservation: DECLARATION,
      captureLocalObservationIdentity: async () => admissionEstablished(),
      observeLocalObservationIdentity: async () => osEstablished(),
      captureLocalBrokerObservationIdentity: async () => ({
        ...admissionEstablished(),
        identity: { role: 'broker-daemon', nonce: CAPTURE_NONCE, entryRealpath: BROKER_ENTRY, configRealpathSha256: 'b'.repeat(64), pid: 60200, ppid: 60100, firstWriteEpochMs: 1000, startOriginMs: 1000.2, firstWritePreciseMs: 1100.6 },
      }),
      observeLocalBrokerObservationIdentity: async () => osEstablished({ observation: { pid: 60200, ppid: 60100, startIdentity: 'S-DAEMON', nonce: CAPTURE_NONCE, startInstantEpochMs: 1000, ppidChangedFromCapture: null }, queried: { pid: 60200, nonce: CAPTURE_NONCE } }),
      observeLocalTransportObservationIdentity: async () => osEstablished({ observation: { pid: 60300, ppid: 60100, startIdentity: 'S-TRANSPORT', nonce: TRANSPORT_NONCE, startInstantEpochMs: 1000, ppidChangedFromCapture: null }, queried: { pid: 60300, nonce: TRANSPORT_NONCE } }),
      sleep: async () => {},
      now: () => 1_000,
      holdMs: 5_000,
      budgetMs: 60_000,
      processNonce: TRANSPORT_NONCE,
    }).catch((error) => error?.heldTurn ?? null);
    assert.ok(held, 'premise: the failed turn carried its held record');
    // The independently recovered PARTIAL facts: the turn never reached the
    // release boundary for which the phase-3 composition facts are armed, so
    // whatever completed BEFORE the failure persists on the failure record —
    // and nothing is guessed beyond it (the broker phase-3 observation never
    // ran: its duty stays the named no-fact unestablished, and the verdict
    // stays honestly unset on this shape).
    const block = held.cleanup.localObservation;
    assert.ok(block, 'the collected facts survive the failure');
    assert.equal(block.admission.status, 'established');
    assert.equal(block.presence.status, 'established');
    assert.ok(block.duties, 'the composed local-duty verdict still rides the record');
    assert.equal(block.duties.settled, false,
      'a phase-3 fact the turn never collected stays unestablished — the failure record never owes a settled verdict');
    const invocationDuty = block.duties.duties.find((duty) => duty.duty === 'invocation-process');
    assert.equal(invocationDuty.status, 'established', 'the pre-failure invocation facts stand');
    assert.equal(block.duties.duties.find((duty) => duty.duty === 'broker-daemon').reasons.includes('no-fact-supplied'), true,
      'the broker omission is the named no-fact fact, never a fabricated absence or a replacement');
    // The transport descendant observed under its OWN declared nonce (the
    // runtime binds to the driver's exact transport identity, never a
    // fake-peer scope): its digest rides the block, never the raw nonce.
    const { createHash } = await import('node:crypto');
    assert.equal(block.transportObservation.queried.nonceSha256, createHash('sha256').update(TRANSPORT_NONCE).digest('hex'),
      'the transport observation queries the DECLARED transport nonce (digest-bearing)');
    assert.equal(JSON.stringify(block).includes(TRANSPORT_NONCE), false, 'the raw transport nonce never rides the block');
  });
});

describe('local-settlement task 3: the pre-host capability gate (§25.3/§25.8 — every applicable mandatory layer refuses a known-missing mechanism BEFORE any host/provider invocation)', async () => {
  const { evaluateLiveLaunchPreflight, LOCAL_OBSERVATION_REQUIRED_CASES, localObservationDeclarationFor } = await import('../tools/shell-wait-probe/driver.mjs');
  const { createHash } = await import('node:crypto');
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const ENTRY = '/private/tmp/fixture-installed/skills/rescue/launcher.mjs';
  const BROKER_ENTRY = '/private/tmp/fixture-installed/scripts/zcode-broker.mjs';
  const sha = (value) => createHash('sha256').update(value).digest('hex');
  const armingDeclaration = (preloadSha256 = 'p'.repeat(64)) => ({
    preload: 'closure-observe.mjs',
    preloadSha256,
    maxBytes: 65536,
    gate: { argv: ['invoke-prepared', 'rescue'], declaredEntryRealpathSha256: sha(ENTRY) },
    brokerGate: { declaredBrokerEntryRealpathSha256: sha(BROKER_ENTRY) },
    identityRecord: { version: 2, roles: { invocation: 'identity.json', brokerDaemon: 'identity-broker.json' } },
    environmentVariables: ['ZCODE_FIXTURE_CAPTURE_DIRECTORY', 'ZCODE_FIXTURE_CAPTURE_NONCE', 'ZCODE_FIXTURE_CAPTURE_ENTRY', 'ZCODE_FIXTURE_CAPTURE_MAX_BYTES', 'ZCODE_FIXTURE_CAPTURE_BROKER_ENTRY'],
    selector: 'fixture-only capture environment present AND realpath(argv[1]) equal to the declared installed launcher realpath AND argv exactly [invoke-prepared, rescue]',
  });
  const armedFixture = async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'local-process-preflight-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const preloadPath = join(root, 'closure-observe.mjs');
    const preloadBytes = '// the executing preload artifact\n';
    const preloadSha = sha(preloadBytes);
    await writeFile(preloadPath, preloadBytes, { mode: 0o600 });
    const workspace = join(root, 'ws');
    const dataRoot = join(root, 'data-root');
    await mkdir(workspace, { mode: 0o700 });
    await mkdir(dataRoot, { mode: 0o700 });
    const output = join(root, 'case-output');
    await mkdir(output, { mode: 0o700 });
    // (Review round 32, Finding 2) the REAL composer creates the capture
    // directory (the preload requires it to exist); the helper mirrors it.
    await mkdir(join(root, 'stdout-capture'), { recursive: true, mode: 0o700 });
    const captureHandle = Object.freeze({ preloadPath, preloadSha256: preloadSha, captureDirectory: join(root, 'stdout-capture'), nonce: 'a'.repeat(64), maxBytes: 65536, entryRealpath: ENTRY, brokerEntryRealpath: BROKER_ENTRY });
    // (Review round 2) the effective env carries the arming: every capture
    // variable binds the handle and NODE_OPTIONS loads the declared
    // preload artifact — the preflight verifies what the launch executes.
    const BS = String.fromCharCode(92); const quotedPreload = `"${preloadPath.replace(/\\/g, BS + BS).replace(/"/g, BS + '"')}"`;
    return {
      root,
      output,
      preloadPath,
      handle: {
        workspace, codexHome: join(root, 'home'),
        installedRoot: join(root, 'installed'),
        env: {
          HOME: join(root, 'home'), ZCODE_DATA_ROOT: dataRoot,
          ZCODE_SHELL_WAIT_CAPTURE_DIR: captureHandle.captureDirectory,
          ZCODE_SHELL_WAIT_CAPTURE_NONCE: captureHandle.nonce,
          ZCODE_SHELL_WAIT_CAPTURE_ENTRY_REALPATH: captureHandle.entryRealpath,
          ZCODE_SHELL_WAIT_CAPTURE_MAX_BYTES: '65536',
          ZCODE_SHELL_WAIT_CAPTURE_BROKER_ENTRY_REALPATH: captureHandle.brokerEntryRealpath,
          NODE_OPTIONS: `--require ${quotedPreload}`,
        },
        stdoutCapture: captureHandle,
        record: { variant: 'candidate', closureStdoutCapture: armingDeclaration(preloadSha) },
      },
    };
  };
  const input = (fixture, over = {}) => ({
    case: 'rescue-interrupt', survivalControlSelector: null,
    fixture,
    ...over,
  });

  test('the registered interrupt gate is mandatory (the producer map is closed and covers the V case)', () => {
    assert.equal(LOCAL_OBSERVATION_REQUIRED_CASES.has('rescue-interrupt'), true,
      'the local-settlement V case requires the local Companion observation pre-host');
  });

  test('an unarmed fixture refuses the launch pre-host for each applicable mandatory layer — launch-call count zero', async (t) => {
    const { runShellWaitCase } = await import('../tools/shell-wait-probe/driver.mjs');
    const { root, handle } = await armedFixture(t);
    const unarmed = { ...handle, stdoutCapture: undefined, record: { variant: 'candidate' } };
    const verdict = await evaluateLiveLaunchPreflight(input(unarmed));
    assert.equal(verdict.ok, false);
    assert.match(String(verdict.reason), /known absent/u, `the named known-absent refusal carries: ${verdict.reason}`);
    // The pipeline-level refusal through the DEFAULT live executor: the only
    // site that may invoke the host/provider refuses BEFORE its first
    // invocation (the preflight runs before the version probe and the held
    // turn — launch-call count zero, not even the version probe). The
    // offline injected-executor re-analyses keep their own choreography (the
    // §24.11 instrument pattern); the record these tests build carries no
    // localProcess block, so the offline join v6 still maps null and the
    // oracle v5 still refuses legacy shapes by name.
    const previousGate = process.env.ZCODE_SHELL_WAIT_E2E;
    process.env.ZCODE_SHELL_WAIT_E2E = '1';
    try {
      const output = root;  // prepared output directory from the fixture helper
      await assert.rejects(
        runShellWaitCase(
          { case: 'rescue-interrupt', codexBinary: process.execPath, sourceSha: 'a'.repeat(40), workerDurationMs: 420_000, capMs: 3_600_000, pollMs: 3_600_000, budgetMs: 1_200_000, output },
          { createFixture: async () => ({ ...unarmed, dispose: async () => {} }) },
        ),
        /known absent/u,
      );
    } finally {
      if (previousGate === undefined) delete process.env.ZCODE_SHELL_WAIT_E2E;
      else process.env.ZCODE_SHELL_WAIT_E2E = previousGate;
    }
  });

  test('an armed fixture missing its record-level arming declaration (offline provenance) refuses pre-host', async (t) => {
    const { handle } = await armedFixture(t);
    const withoutRecord = { ...handle, record: { variant: 'candidate' } };
    const { evaluateLiveLaunchPreflight: preflight } = { evaluateLiveLaunchPreflight };
    const verdict = await preflight(input(withoutRecord));
    assert.equal(verdict.ok, false);
    assert.match(String(verdict.reason), /arming declaration|offline provenance|record/u,
      `the record-binding refusal names the missing offline proof: ${verdict.reason}`);
  });

  test('an arming declaration that disagrees with the armed handle refuses pre-host (the wrong instrument)', async (t) => {
    const { handle } = await armedFixture(t);
    const drifted = {
      ...handle,
      record: { variant: 'candidate', closureStdoutCapture: { ...armingDeclaration(), gate: { argv: ['invoke-prepared', 'rescue'], declaredEntryRealpathSha256: sha('/different/launcher.mjs') } } },
    };
    const verdict = await evaluateLiveLaunchPreflight(input(drifted));
    assert.equal(verdict.ok, false);
    assert.match(String(verdict.reason), /disagree|wrong instrument|declared launcher entry digest|broker/u,
      `the drift refusal names the binding failure: ${verdict.reason}`);
  });

  test('a fixture whose recorded arming disagrees about the broker hop refuses pre-host', async (t) => {
    const { handle } = await armedFixture(t);
    const brokerDrift = {
      ...handle,
      record: { variant: 'candidate', closureStdoutCapture: { ...armingDeclaration(), brokerGate: { declaredBrokerEntryRealpathSha256: sha('/different/zcode-broker.mjs') } } },
    };
    const verdict = await evaluateLiveLaunchPreflight(input(brokerDrift));
    assert.equal(verdict.ok, false);
    assert.match(String(verdict.reason), /broker/u, `the broker-drift refusal names the undeclared hop: ${verdict.reason}`);
  });

  test('a fully armed-and-bound fixture passes the pre-host gate and composes the runtime declaration', async (t) => {
    const { handle } = await armedFixture(t);
    const verdict = await evaluateLiveLaunchPreflight(input(handle), { lstat: (await import('node:fs/promises')).lstat });
    assert.equal(verdict.ok, true, `an armed, bound fixture must pass: ${verdict.reason}`);
    const declaration = localObservationDeclarationFor(handle, 'rescue-interrupt');
    assert.ok(declaration, 'the executor composes the runtime declaration from the armed handle');
    assert.equal(declaration.nonce, 'a'.repeat(64));
    assert.equal(declaration.entryRealpath, ENTRY);
    assert.equal(declaration.brokerEntryRealpath, BROKER_ENTRY);
    assert.equal(localObservationDeclarationFor(handle, 'rescue-long'), null, 'a case outside the closed producer map stays unarmed');
    assert.equal(localObservationDeclarationFor({ ...handle, stdoutCapture: undefined }, 'rescue-interrupt'), null, 'an unarmed fixture composes no declaration');
  });
});

describe('local-settlement task 3: the COMPLETE armed path through the real fixture — createShellWaitFixture → evaluateLiveLaunchPreflight → the executor arming → runHeldHostTurn → persisted record (§25.7 local reads row / §25.10)', async () => {
  const { spawnSync } = await import('node:child_process');
  const { cp, mkdir, readFile, readdir } = await import('node:fs/promises');
  const { createShellWaitFixture } = await import('../tools/shell-wait-probe/fixture.mjs');
  const driver = await import('../tools/shell-wait-probe/driver.mjs');
  const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
  const repositorySha = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();

  /** The fast seam-injected installer: the exact installed layout the arming
   * realpaths (launcher + broker + Skills + Role template) — no real
   * install, no host. */
  const seamInjectedDependencies = (extra = {}) => ({
    buildSnapshot: async ({ output: snapshotOutput, sourceSha }) => {
      await mkdir(join(snapshotOutput, '.agents', 'plugins'), { recursive: true });
      await writeFile(join(snapshotOutput, '.agents', 'plugins', 'provenance.json'), JSON.stringify({ sourceSha }), 'utf8');
    },
    installPlugin: async ({ codexHome, cleanSource }) => {
      const installed = join(codexHome, 'plugins', 'cache', 'vitry', 'zcode', '0.1.0');
      await mkdir(join(installed, 'agents'), { recursive: true });
      for (const skill of ['rescue', 'review', 'adversarial-review', 'status']) {
        await mkdir(join(installed, 'skills', skill), { recursive: true });
        await cp(join(cleanSource, 'skills', skill, 'SKILL.md'), join(installed, 'skills', skill, 'SKILL.md'));
      }
      await cp(join(cleanSource, 'agents', 'zcode-rescue.toml.template'), join(installed, 'agents', 'zcode-rescue.toml.template'));
      await writeFile(join(installed, 'skills', 'rescue', 'launcher.mjs'), 'process.exit(0);\n', 'utf8');
      await mkdir(join(installed, 'scripts'), { recursive: true });
      await writeFile(join(installed, 'scripts', 'zcode-broker.mjs'), '// the declared broker-daemon entry\n', 'utf8');
      await writeFile(join(codexHome, 'config.toml'), '[plugins."zcode@vitry"]\nenabled = true\n', 'utf8');
      return { pluginVersion: '0.1.0' };
    },
    runSetup: async () => ({ sessionEstablished: true, launcherDescriptorPublished: true, setupAttempts: 1, roleStatus: 'ready', capVerified: true }),
    ...extra,
  });

  test('the armed fixture drives the runtime against its OWN capture declaration; the record persists the facts before disposal', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'local-process-complete-path-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const output = join(root, 'output');
    await mkdir(output, { mode: 0o700 });
    const fixture = await createShellWaitFixture({
      sourceRoot: repositoryRoot, sourceSha: repositorySha, codexBinary: process.execPath,
      output, variant: 'candidate', capMs: null, stdoutCapture: true,
    }, seamInjectedDependencies());
    t.after(() => fixture.dispose());
    // The fixture's own arming (the §25.3 seam): the runtime NEVER composes a
    // caller-supplied scope — the declaration is the fixture's.
    const declaration = driver.localObservationDeclarationFor(fixture, 'rescue-interrupt');
    assert.ok(declaration, 'premise: the real fixture arms the observation for the interrupt case');
    assert.equal(driver.localObservationDeclarationFor(fixture, 'rescue-long'), null,
      'the closed producer map keeps other cases unarmed');
    // The offline preflight (the REAL export against the REAL fixture).
    const preflight = await driver.evaluateLiveLaunchPreflight({ case: 'rescue-interrupt', survivalControlSelector: null, fixture });
    assert.equal(preflight.ok, true, `the armed fixture passes its own preflight: ${preflight.reason}`);
    // The executor choreography (the observation layer exactly as the default
    // executor runs it): the armed declaration wires the RUNTIME; the hold
    // turn runs on injected fakes so NOTHING real is ever launched. Launch
    // calls are counted — the observation layer runs, the launch never does.
    let launchCalls = 0;
    let admitCalls = 0;
    const runtimeCalls = [];
    const held = await driver.runHeldHostTurn({
      gatePath: 'unused-gate',
      localObservation: declaration,
      holdMs: 0,
      budgetMs: 1_200_000,
      launch: async () => { launchCalls += 1; return { result: Promise.resolve({ code: 0, stdout: '', stderr: '' }), terminate: async () => {} }; },
      waitForGate: async () => {},
      captureProcessIdentity: async () => ({ pid: 70100, ppid: 700, nonce: 'f'.repeat(64), startIdentity: 'S-EXEC' }),
      readProcessIdentity: async () => undefined,
      terminateProcessIdentity: async () => ({ attempted: true, signalled: 'SIGTERM', exited: true, failure: null }),
      waitForProcessExit: async () => {},
      releaseGate: async () => {},
      captureLocalObservationIdentity: async (admissionInput) => { admitCalls += 1; runtimeCalls.push(admissionInput); return null; },
      observeLocalObservationIdentity: async (observationInput) => { runtimeCalls.push(observationInput); return null; },
      captureLocalBrokerObservationIdentity: async (admissionInput) => { runtimeCalls.push(admissionInput); return null; },
      observeLocalBrokerObservationIdentity: async (observationInput) => { runtimeCalls.push(observationInput); return null; },
      observeLocalTransportObservationIdentity: async (observationInput) => { runtimeCalls.push(observationInput); return null; },
      sleep: async () => {},
    });
    assert.equal(launchCalls, 1, 'the executor launches exactly once (the counted held turn) — never more for the observation');
    assert.ok(admitCalls >= 1, 'premise: the runtime armed against its declaration');
    // The RUNTIME declaration (never a fake-peer identity, never a stale
    // cached result): the admission input binds THIS fixture's capture scope
    // and declared entries — the runtime declaration/nonce/identity itself.
    const admission = runtimeCalls.at(0);
    assert.equal(admission.nonce, declaration.nonce, 'the admission runs against the fixture capture scope nonce');
    assert.equal(admission.expectedEntryRealpath, declaration.entryRealpath, 'the admission binds the declared launcher entry');
    const block = held.cleanup.localObservation;
    assert.ok(block, 'the runtime block rides the held record');
    assert.equal(block.armed, true);
    // The FULL pipeline: the executor's mapped facts → serializer → reload
    // → the local block persists on the record before disposal.
    const liveFacts = driver.mapShellWaitLiveFacts(
      { case: 'rescue-interrupt', pollMs: 3_600_000, waitPolicy: null, interruptBaselineSelector: null, survivalControlSelector: null },
      held,
      { status: 'inconclusive', inconclusive: { reason: 'the offline path never runs the evidence scan' }, facts: null },
      null, null, fixture, [], [],
    );
    const record = await driver.runShellWaitCase(
      { case: 'rescue-interrupt', codexBinary: process.execPath, sourceSha: repositorySha, workerDurationMs: 420_000, capMs: 3_600_000, pollMs: 3_600_000, budgetMs: 1_200_000, output },
      { createFixture: async () => fixture, executeLiveCase: async () => liveFacts },
    );
    assert.equal(record.status, 'executed');
    const recordName = (await readdir(output)).find((name) => name.endsWith('.record.json'));
    const persisted = JSON.parse(await readFile(join(output, recordName), 'utf8'));
    assert.ok(persisted.localProcess, 'the local-observation block persists on the case record before disposal (§25.7 persistence fence)');
    assert.equal(persisted.localProcess.nonceSha256, createHash('sha256').update(declaration.nonce).digest('hex'),
      'the persisted block carries the capture scope DIGEST, never the raw fixture nonce');
    assert.equal(JSON.stringify(persisted.localProcess).includes(declaration.nonce), false, 'the raw fixture nonce never rides the record');
  });

  test('the continuous junction: the runtime-produced block reaches the final acceptance through the real pipeline (real fixture → preflight → armed held turn → serializer → reload → Gate-D join → oracle)', async (t) => {
    const { runHeldHostTurn, mapShellWaitLiveFacts, runShellWaitCase, evaluateLiveLaunchPreflight, localObservationDeclarationFor, nativeInterruptionGateDInput } = driver;
    const { readdir, readFile, realpath, mkdir, writeFile, rm, mkdtemp } = await import('node:fs/promises');
    const { IDENTITY_RECORD_VERSION } = await import('../tools/shell-wait-probe/closure-preload.mjs');
    const root = await mkdtemp(join(tmpdir(), 'local-process-junction-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const junctionOutput = join(root, 'output');
    await mkdir(junctionOutput, { mode: 0o700 });
    // (1) the REAL fixture with the ARMED capture seam (its own declaration).
    const junctionFixture = await createShellWaitFixture({
      sourceRoot: repositoryRoot, sourceSha: repositorySha, codexBinary: process.execPath,
      output: junctionOutput, variant: 'candidate', capMs: null, stdoutCapture: true,
    }, seamInjectedDependencies());
    t.after(() => junctionFixture.dispose());
    // (2) the pre-host preflight on the REAL armed fixture, and the runtime
    // declaration composed from ITS OWN arming.
    const junctionPreflight = await evaluateLiveLaunchPreflight({ case: 'rescue-interrupt', survivalControlSelector: null, fixture: junctionFixture });
    assert.deepEqual(junctionPreflight, { ok: true, reason: null }, `the real armed fixture passes its own preflight (${junctionPreflight.reason ?? ''})`);
    const junctionDeclaration = localObservationDeclarationFor(junctionFixture, 'rescue-interrupt');
    assert.ok(junctionDeclaration, 'the runtime arms on the fixture declaration');
    assert.equal(junctionDeclaration.entryRealpath, await realpath(join(junctionFixture.installedRoot, 'skills', 'rescue', 'launcher.mjs')));
    assert.equal(junctionDeclaration.brokerEntryRealpath, await realpath(join(junctionFixture.installedRoot, 'scripts', 'zcode-broker.mjs')));

    // (3) the REAL nonce-keyed identity record files materialize at the
    // fixture's OWN capture directory (the same files the preload writes):
    // invocation + broker, bound to the real entry realpaths of the fixture.
    const junctionDigest = (value) => createHash('sha256').update(value).digest('hex');
    const junctionStartSecond = Date.parse('2026-10-01T00:00:01Z');
    const junctionLstart = (second) => second === 1 ? 'Thu Oct  1 00:00:01 2026' : second === 3 ? 'Thu Oct  1 00:00:03 2026' : 'Thu Oct  1 00:00:05 2026';
    const junctionCaptureNonce = junctionDeclaration.nonce;
    const junctionTransportNonce = 'f'.repeat(64);
    const junctionInvocationRecord = {
      version: IDENTITY_RECORD_VERSION, role: 'invocation', nonce: junctionCaptureNonce,
      entryRealpath: junctionDeclaration.entryRealpath, argv: ['invoke-prepared', 'rescue'],
      pid: 60100, ppid: 600,
      firstWriteEpochMs: junctionStartSecond + 20, startOriginMs: junctionStartSecond + 0.5, firstWritePreciseMs: junctionStartSecond + 20.5,
    };
    const junctionBrokerRecord = {
      version: IDENTITY_RECORD_VERSION, role: 'broker-daemon', nonce: junctionCaptureNonce,
      entryRealpath: junctionDeclaration.brokerEntryRealpath,
      configRealpathSha256: junctionDigest(join(junctionFixture.installedRoot, 'scripts', 'lib', 'broker-config.toml')),
      pid: 60200, ppid: 60100,
      firstWriteEpochMs: junctionStartSecond + 3_022, startOriginMs: junctionStartSecond + 3_002.5, firstWritePreciseMs: junctionStartSecond + 3_022.5,
    };
    await writeFile(join(junctionDeclaration.captureDirectory, `${junctionCaptureNonce}.identity.json`), JSON.stringify(junctionInvocationRecord), { mode: 0o600 });
    await writeFile(join(junctionDeclaration.captureDirectory, `${junctionCaptureNonce}.identity-broker.json`), JSON.stringify(junctionBrokerRecord), { mode: 0o600 });

    // (4) the held turn (armed): the executor fakes launch the turn; the OS
    // observations dispatch BY QUERIED PID with PER-PID counters (a call
    // index races under load), the rows carry the per-row second gaps and
    // the capture-time parentage the ancestry hop lifetimes credit, the
    // phase-3 signal gates the hold clock, and the phase-4 confirmed absence
    // anchors the launch result — every applicable duty composes pre-fence
    // and the synthetic pids never reach the real OS.
    /** @type {Map<number, number>} */
    const junctionPidCalls = new Map([[60100, 0], [60200, 0], [60300, 0]]);
    let junctionPhaseThree = false;
    let junctionPhaseFourAbsence = false;
    const junctionRow = (pid) => ({
      pid,
      ppid: pid === 60100 ? 600 : pid === 60200 ? 60100 : 60200,
      lstart: junctionLstart(pid === 60100 ? 1 : pid === 60200 ? 3 : 5),
    });
    const junctionPsSeam = async (/** @type {any} */ queriedPid) => {
      const pid = typeof queriedPid === 'number' ? queriedPid : (typeof queriedPid === 'object' && queriedPid !== null ? queriedPid.pid : 0);
      const calls = (junctionPidCalls.get(pid) ?? 0) + 1;
      junctionPidCalls.set(pid, calls);
      if (pid === 60100) {
        if (calls <= 2) return junctionRow(60100);
        // The ancestry's REFRESHED companion read (calls 3-4).
        if (calls <= 4) return junctionRow(60100);
        // The phase-4 absence read (call 5+): a REAL ~30 ms delay before the
        // no-process answer — the strict-recency tie rule (an absence
        // at/before the last verified presence can never manufacture
        // disappearance) needs the absence's completion in a LATER wall
        // millisecond than the presence's identity instant, and the whole
        // runtime otherwise completes inside ONE real millisecond.
        await new Promise((resolve) => setTimeout(resolve, 30));
        return undefined;
      }
      if (pid === 60200) return junctionRow(60200);
      if (pid === 60300) {
        if (calls <= 2) { if (calls === 2) junctionPhaseThree = true; return junctionRow(60300); }
        // Call pair 2: the runtime's transport-exit read — the CLI (and
        // its transport generation) is gone; the confirmed absence is the
        // transport's pre-fence exit evidence.
        await new Promise((resolve) => setTimeout(resolve, 30));
        return undefined;
      }
      return undefined;
    };
    const held = await runHeldHostTurn({
      gatePath: 'unused-gate',
      holdMs: 300_000,
      budgetMs: 10_000_000_000,
      measurementCutoffSchedule: true,
      launch: async () => ({
        result: new Promise((resolve) => {
          const anchor = setInterval(() => {
            if (junctionPhaseFourAbsence) { clearInterval(anchor); resolve({ code: 0, stdout: '', stderr: '' }); }
          }, 5);
          anchor.unref?.();
          setTimeout(() => { clearInterval(anchor); resolve({ code: 0, stdout: '', stderr: '' }); }, 10_000).unref?.();
        }),
        terminate: async () => {},
      }),
      waitForGate: async () => {},
      captureProcessIdentity: async () => ({ pid: 60300, ppid: 60200, nonce: junctionTransportNonce, startIdentity: 'Thu Oct  1 00:00:05 2026', markerEpochMs: Date.parse('2026-10-01T00:00:04.45Z') }),
      readProcessIdentity: async () => undefined,
      terminateProcessIdentity: async () => ({ attempted: true, signalled: 'SIGTERM', exited: true, failure: null }),
      waitForProcessExit: async () => {},
      releaseGate: async () => {},
      localObservation: junctionDeclaration,
      localObservationObserverOptions: {
        osSeams: { platform: 'darwin', ps: junctionPsSeam, environ: 'present' },
        absenceConfirmation: async () => {
          junctionPhaseFourAbsence = true;
          return 'absent';
        },
      },
      // The junction's sleep pace is REAL-timed at 5 ms: the hold loop's
      // ~600 gated calls take ~3 real seconds while the runtime's phases
      // (real fs + seams) complete in the first tens of ms even under heavy
      // load — the phase-4 absence read is then ALWAYS pre-release and
      // pre-cutoff (the registered cutoff = the release + 10 real seconds).
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5))),
      now: (() => { let value = 0; let gated = false; return () => {
        if (!gated) { if (junctionPhaseThree) gated = true; else return 0; }
        value += 500;
        return value;
      }; })(),
      // The wall clock stays the DEFAULT (real Date.now): the registered
      // cutoff = the release + 10 real seconds, the phase-4 absence read
      // completes in milliseconds — the pre-fence margin is real time, so
      // the call-counting fake clocks can never climb past the fence under
      // load (the flake mechanism this replaces).
      processNonce: junctionTransportNonce,
    });
    // (5) the armed runtime ran its full lifecycle against the real files.
    const junctionBlock = held.cleanup.localObservation;
    assert.ok(junctionBlock, 'the block persisted on the held record');
    assert.equal(junctionBlock.armed, true);
    assert.equal(junctionBlock.admission.status, 'established', `the inline record admission ran (actual ${junctionBlock.admission?.status} ${junctionBlock.admission?.reason ?? ''})`);
    assert.equal(junctionBlock.presence?.status, 'established', `the real run ran the invocation presence (actual ${junctionBlock.presence?.status} ${junctionBlock.presence?.reason ?? ''})`);
    assert.equal(junctionBlock.brokerAdmission?.status, 'established', `the broker record admitted (actual ${junctionBlock.brokerAdmission?.status} ${junctionBlock.brokerAdmission?.reason ?? ''})`);
    assert.equal(junctionBlock.brokerObservation?.status, 'established', `the broker observed (actual ${junctionBlock.brokerObservation?.status})`);
    assert.equal(junctionBlock.transportObservation?.status, 'established', `the transport observed (actual ${junctionBlock.transportObservation?.status} ${junctionBlock.transportObservation?.reason ?? ''})`);
    assert.equal(junctionBlock.exit?.status, 'disappeared', `the honest pre-fence absence adjudicated (DUMP ${JSON.stringify({ stopped: junctionBlock.stoppedAt, reads: (junctionBlock.reads ?? []).map((read) => ({ s: read.status, r: read.reason ?? null, st: read.readStartedEpochMs, e: read.readEpochMs, pf: read.postFence === true, a: read.absenceConfirmed })), exitReason: junctionBlock.exit?.reason ?? null, released: held.cleanup.releasedGate, label: held.cleanup.label, cut: held.cleanup.measurementCutoffAtMs, cutEcho: junctionBlock.cutoffAtMs, presence: junctionBlock.presence === null ? null : { ir: junctionBlock.presence.identityReadEpochMs, re: junctionBlock.presence.readEpochMs }, boundary: held.cleanup.cleanupBoundaryAtMs, pidCalls: [...junctionPidCalls.entries()], fence: junctionBlock.fenceAtMs })}`);
    assert.ok(typeof held.cleanup.measurementCutoffAtMs === 'number', 'premise: the registered cutoff stamped');
    assert.equal(junctionBlock.cutoffAtMs, held.cleanup.measurementCutoffAtMs, 'the echo carries the cutoff');
    assert.equal(junctionBlock.duties?.settled, true, `the runtime composition settled the applicable duties (ancestry ${JSON.stringify(junctionBlock.ancestry ?? null)}, duties ${JSON.stringify(junctionBlock.duties?.duties ?? [])})`);

    // (6) the executor's live facts map the held record; the REAL serializer
    // persists the runtime-produced block beside the result.
    const junctionLiveFacts = mapShellWaitLiveFacts(
      { case: 'rescue-interrupt', pollMs: 3_600_000, waitPolicy: null, interruptBaselineSelector: null, survivalControlSelector: null },
      held, { status: 'inconclusive', inconclusive: { reason: 'the offline path never runs the evidence scan' }, facts: null },
      null, null, junctionFixture, [], [],
    );
    assert.ok(junctionLiveFacts.localProcess, 'the runtime block rides the mapped facts');
    const junctionRecord = await runShellWaitCase(
      { case: 'rescue-interrupt', codexBinary: process.execPath, sourceSha: repositorySha, workerDurationMs: 420_000, capMs: 3_600_000, pollMs: 3_600_000, budgetMs: 1_200_000, output: junctionOutput },
      { createFixture: async () => junctionFixture, executeLiveCase: async () => junctionLiveFacts },
    );
    assert.equal(junctionRecord.status, 'executed');
    const junctionRecordName = (await readdir(junctionOutput)).find((name) => name.endsWith('.record.json'));
    const junctionReload = JSON.parse(await readFile(join(junctionOutput, junctionRecordName), 'utf8'));
    assert.ok(junctionReload.localProcess, 'the runtime block SURVIVES serialize→reload');

    // (7) the offline Gate-D join composes the runtime-produced block; the
    // fence re-verification runs against the record's OWN cutoff.
    const junctionJoined = nativeInterruptionGateDInput(junctionReload);
    const { evaluateNativeInterruptionSettlement } = await import('../tools/shell-wait-probe/release-qualification.mjs');
    const junctionDecision = evaluateNativeInterruptionSettlement(junctionJoined);
    // (8) the acceptance decision composes ALL applicable duties: the
    // local-process layer is CREDITED from the runtime's own block.
    assert.equal(junctionJoined.localProcessDuties?.contractVersion, 1);
    assert.equal(junctionJoined.localProcessDuties?.settled, true, JSON.stringify(junctionJoined.localProcessDuties?.refusals));
    assert.deepEqual(junctionJoined.localProcessDuties?.refusals, []);
    assert.equal(junctionJoined.localProcessDuties?.fence.kind, 'measurement-cutoff', 'the operative fence is the registered measurement cutoff');
    assert.equal(junctionJoined.localProcessDuties?.duties.length, 3, 'all three applicable local duties composed');
    assert.equal(junctionDecision.qualified, false, "the offline run's remote layers stay honestly unknown (never qualified)");
    assert.equal(junctionDecision.layers.localProcess, true, 'the local-process layer is included and credited');
    assert.deepEqual(junctionDecision.reasons.filter((reason) => reason.startsWith('local-process')), [],
      'no local-process refusal rides the verdict: the local layer was positively established pre-fence');
    assert.ok(junctionDecision.reasons.includes('delivery-not-established'), JSON.stringify(junctionDecision.reasons));
  });
});

describe('local-settlement task 3: the offline Gate-D join composes the local-duty contract with the §25.7 credit fences (join v6; the §25.10 persisted block is the ONLY local evidence source)', async () => {
  const { nativeInterruptionGateDInput, NATIVE_INTERRUPTION_GATE_D_JOIN_VERSION } = await import('../tools/shell-wait-probe/driver.mjs');
  const { createHash } = await import('node:crypto');

  const sha = (value) => createHash('sha256').update(value).digest('hex');
  const MEASUREMENT_CUTOFF_AT_MS = 20_000;
  /** One complete, pre-fence, echo-consistent armed block (the runtime's persisted shape). */
  const armedBlock = (over = {}) => ({
    version: 1,
    armed: true,
    clock: 'wall-epoch-ms',
    // (Review round 2) the persisted ancestry join rides the block: both
    // hops established, the same §25.4 two-hop attribution the runtime
    // composed; the join re-verification gates the settlement on it.
    ancestry: { localProcessObservationVersion: 1, class: 'ancestry-join', nonceSha256: sha('n'.repeat(64)), companionToTransportAttributed: true, hops: [
      { hop: 'companion-to-daemon', status: 'established', reason: null },
      { hop: 'daemon-to-transport', status: 'established', reason: null },
    ] },
    // (Review round 3, Finding 4) the refreshed ancestry endpoint markers
    // ride the block — the hops' claimed compositions are re-verified from
    // them (generation-bound to the duty slots, marker digested).
    ancestryEndpoints: {
      companion: { class: 'os-live-observation', status: 'established', reason: null, localProcessObservationVersion: 1, observation: { pid: 60100, ppid: 600, startIdentity: 'S-COMPANION', startInstantEpochMs: 0, ppidChangedFromCapture: null, nonceSha256: sha('n'.repeat(64)) }, queried: { pid: 60100, nonceSha256: sha('n'.repeat(64)) }, readStartedEpochMs: 5000, identityReadEpochMs: 5050, readEpochMs: 5100, absenceConfirmed: null },
      daemon: { class: 'os-live-observation', status: 'established', reason: null, localProcessObservationVersion: 1, observation: { pid: 60200, ppid: 60100, startIdentity: 'S-DAEMON', startInstantEpochMs: 1000, ppidChangedFromCapture: null, nonceSha256: sha('n'.repeat(64)) }, queried: { pid: 60200, nonceSha256: sha('n'.repeat(64)) }, readStartedEpochMs: 5000, identityReadEpochMs: 5060, readEpochMs: 5200, absenceConfirmed: null },
      transportMarker: { pid: 60300, ppid: 60200, nonceSha256: sha('f'.repeat(64)), markerEpochMs: 4500 },
    },
    nonceSha256: sha('n'.repeat(64)),
    // (Review round 33, Finding 1) the endpoint creation instants must AGREE
    // with their base observations: the Companion generation is created in
    // epoch second 0 (its admission record start lives inside that second),
    // the daemon in second 1000 — the lifetime rules then hold with the
    // agreeing instants.
    admission: { status: 'established', reason: null, class: 'startup-identity', localProcessObservationVersion: 1, identity: { role: 'invocation', argv: ['invoke-prepared', 'rescue'], entryRealpathSha256: sha('launcher-entry'), pid: 60100, ppid: 600, firstWriteEpochMs: 0, startOriginMs: 0.1, firstWritePreciseMs: 0.5, nonceSha256: sha('n'.repeat(64)) }, readStartedEpochMs: 1000, readEpochMs: 1100 },
    presence: { class: 'os-live-observation', status: 'established', reason: null, localProcessObservationVersion: 1, observation: { pid: 60100, ppid: 600, startIdentity: 'S-COMPANION', startInstantEpochMs: 0, ppidChangedFromCapture: null, nonceSha256: sha('n'.repeat(64)) }, queried: { pid: 60100, nonceSha256: sha('n'.repeat(64)) }, readStartedEpochMs: 1100, identityReadEpochMs: 1150, readEpochMs: 1200, absenceConfirmed: null },
    reads: [{ class: 'os-live-observation', status: 'absent', reason: 'no-such-process', localProcessObservationVersion: 1, observation: null, queried: { pid: 60100, nonceSha256: sha('n'.repeat(64)) }, readStartedEpochMs: 5100, readEpochMs: 5200, absenceConfirmed: true }],
    exit: { class: 'exit-absence', status: 'disappeared', reason: null, localProcessObservationVersion: 1, boundIdentity: { pid: 60100, startIdentity: 'S-COMPANION', nonceSha256: sha('n'.repeat(64)) }, lastVerifiedPresenceEpochMs: 1150, firstVerifiedAbsenceEpochMs: 5200, exitCorroboratedByMeta: false },
    brokerAdmission: { status: 'established', reason: null, class: 'startup-identity', localProcessObservationVersion: 1, identity: { role: 'broker-daemon', entryRealpathSha256: sha('broker-entry'), pid: 60200, ppid: 60100, firstWriteEpochMs: 1000, startOriginMs: 1000.2, firstWritePreciseMs: 1100.6, nonceSha256: sha('n'.repeat(64)) }, readStartedEpochMs: 1100, readEpochMs: 1150 },
    brokerObservation: { class: 'os-live-observation', status: 'established', reason: null, localProcessObservationVersion: 1, observation: { pid: 60200, ppid: 60100, startIdentity: 'S-DAEMON', startInstantEpochMs: 1000, ppidChangedFromCapture: null, nonceSha256: sha('n'.repeat(64)) }, queried: { pid: 60200, nonceSha256: sha('n'.repeat(64)) }, readStartedEpochMs: 1150, identityReadEpochMs: 1160, readEpochMs: 1300, absenceConfirmed: null },
    transportObservation: { class: 'os-live-observation', status: 'established', reason: null, localProcessObservationVersion: 1, observation: { pid: 60300, ppid: 60100, startIdentity: 'S-TRANSPORT', startInstantEpochMs: 1000, ppidChangedFromCapture: null, nonceSha256: sha('f'.repeat(64)) }, queried: { pid: 60300, nonceSha256: sha('f'.repeat(64)) }, readStartedEpochMs: 1150, identityReadEpochMs: 1170, readEpochMs: 1400, absenceConfirmed: null },
    transportExit: { class: 'os-live-observation', status: 'absent', reason: 'no-such-process', localProcessObservationVersion: 1, observation: null, queried: { pid: 60300, nonceSha256: sha('f'.repeat(64)) }, readStartedEpochMs: 5300, identityReadEpochMs: 5350, readEpochMs: 5400, absenceConfirmed: true },
    duties: { class: 'local-duty-verdict', localProcessObservationVersion: 1, settled: true, duties: [
      { duty: 'invocation-process', status: 'established', reasons: [], identity: { pid: 60100, startIdentity: 'S-COMPANION', nonceSha256: sha('n'.repeat(64)) } },
      { duty: 'broker-daemon', status: 'established', reasons: [], identity: { pid: 60200, startIdentity: 'S-DAEMON', nonceSha256: sha('n'.repeat(64)) } },
      { duty: 'transport-descendant', status: 'established', reasons: [], identity: { pid: 60300, startIdentity: 'S-TRANSPORT', nonceSha256: sha('f'.repeat(64)) } },
    ] },
    stoppedAt: null,
    fenceAtMs: null,
    cutoffAtMs: MEASUREMENT_CUTOFF_AT_MS,
    cleanupBoundaryAtMs: null,
    composedAtMs: 6000,
    ...over,
  });
  const record = (over = {}) => ({
    status: 'executed', case: 'rescue-interrupt', executedAt: '2026-10-30T00:00:00.000Z',
    interrupt: { measurementCutoffAtMs: MEASUREMENT_CUTOFF_AT_MS },
    stdoutCaptureDeclaration: {
      preload: 'closure-observe.mjs', preloadSha256: sha('preload-bytes'), maxBytes: 65536,
      gate: { argv: ['invoke-prepared', 'rescue'], declaredEntryRealpathSha256: sha('launcher-entry') },
      brokerGate: { declaredBrokerEntryRealpathSha256: sha('broker-entry') },
      identityRecord: { version: 2, roles: { invocation: 'identity.json', brokerDaemon: 'identity-broker.json' } },
      environmentVariables: [],
    },
    observations: {}, child: {},
    localProcess: armedBlock(),
    ...over,
  });

  test('the join maps the armed block to a settled local-duty contract under the operative fence', () => {
    assert.equal(NATIVE_INTERRUPTION_GATE_D_JOIN_VERSION, 37, 'the join version registers the local-duty input contract');
    const input = nativeInterruptionGateDInput(record());
    assert.ok(input.localProcessDuties, 'the armed block composes the local-duty input');
    assert.equal(input.localProcessDuties.contractVersion, 1);
    assert.equal(input.localProcessDuties.settled, true, 'all three applicable duties established pre-fence with the invocation exit proven gone pre-fence');
    assert.deepEqual(input.localProcessDuties.refusals, []);
    assert.equal(input.localProcessDuties.fence.operativeAtMs, MEASUREMENT_CUTOFF_AT_MS);
    assert.equal(input.localProcessDuties.fence.kind, 'measurement-cutoff');
  });

  test('a legacy record without the block maps NULL — the contract refuses, never a permissive legacy fallback', () => {
    const { localProcess: dropped, ...legacy } = record();
    assert.equal(dropped !== undefined, true, 'premise: the record carried the block that is now dropped');
    const input = nativeInterruptionGateDInput(legacy);
    assert.equal(input.localProcessDuties, null, 'an absent block is null (never guessed), the named-unadjudicated path');
  });

  test('an in-flight observation refused at the cutoff EQUALITY gets no credit (values equal refuse)', () => {
    const input = nativeInterruptionGateDInput(record({
      localProcess: armedBlock({ presence: { class: 'os-live-observation', status: 'established', reason: null, observation: { pid: 60100, ppid: 600, startIdentity: 'S-COMPANION', startInstantEpochMs: 1000, ppidChangedFromCapture: null, nonceSha256: sha('n'.repeat(64)) }, queried: { pid: 60100, nonceSha256: sha('n'.repeat(64)) }, readStartedEpochMs: 19000, identityReadEpochMs: 19999, readEpochMs: MEASUREMENT_CUTOFF_AT_MS, absenceConfirmed: null } }),
    }));
    assert.equal(input.localProcessDuties.settled, false, 'a fact completing exactly AT the cutoff never credits (§25.7 equality)');
    assert.ok(input.localProcessDuties.refusals.includes('observation-at-or-after-fence'), JSON.stringify(input.localProcessDuties.refusals));
  });

  test('facts without a demonstrable completion instant get no credit (missing timestamps refuse)', () => {
    const input = nativeInterruptionGateDInput(record({
      localProcess: armedBlock({ transportObservation: { class: 'os-live-observation', status: 'established', reason: null, observation: { pid: 60300, ppid: 60100, startIdentity: 'S-TRANSPORT', startInstantEpochMs: 1000, ppidChangedFromCapture: null, nonceSha256: sha('f'.repeat(64)) }, queried: { pid: 60300, nonceSha256: sha('f'.repeat(64)) }, absenceConfirmed: null } }),
    }));
    assert.equal(input.localProcessDuties.settled, false);
    assert.ok(input.localProcessDuties.refusals.includes('observation-instant-unprovable'), JSON.stringify(input.localProcessDuties.refusals));
  });

  test('an iterated refreshed read landing AT/AFTER the cutoff never credits (post-cutoff refresh refuses)', () => {
    const input = nativeInterruptionGateDInput(record({
      localProcess: armedBlock({
        brokerObservation: { class: 'os-live-observation', status: 'established', reason: null, observation: { pid: 60200, ppid: 60100, startIdentity: 'S-DAEMON', startInstantEpochMs: 1000, ppidChangedFromCapture: null, nonceSha256: sha('n'.repeat(64)) }, queried: { pid: 60200, nonceSha256: sha('n'.repeat(64)) }, readStartedEpochMs: 20000, identityReadEpochMs: 21000, readEpochMs: 21_500, absenceConfirmed: null },
      }),
    }));
    assert.equal(input.localProcessDuties.settled, false);
    assert.ok(input.localProcessDuties.refusals.includes('observation-at-or-after-fence'), JSON.stringify(input.localProcessDuties.refusals));
  });

  test('a disappearance whose verified absence sits at/after the cutoff never completes the local exit (post-cutoff death refuses)', () => {
    const input = nativeInterruptionGateDInput(record({
      localProcess: armedBlock({ exit: { class: 'exit-absence', status: 'disappeared', reason: null, boundIdentity: { pid: 60100, startIdentity: 'S-COMPANION', nonceSha256: sha('n'.repeat(64)) }, lastVerifiedPresenceEpochMs: 1150, firstVerifiedAbsenceEpochMs: MEASUREMENT_CUTOFF_AT_MS, exitCorroboratedByMeta: false } }),
    }));
    assert.equal(input.localProcessDuties.settled, false, 'the local exit must be proven strictly before the fence');
    assert.ok(input.localProcessDuties.refusals.includes('local-exit-at-or-after-fence'), JSON.stringify(input.localProcessDuties.refusals));
  });

  test('a torn echo (the block echoes a cutoff stamp DISAGREEING with the record) gets no credit', () => {
    const input = nativeInterruptionGateDInput(record({
      localProcess: armedBlock({ cutoffAtMs: MEASUREMENT_CUTOFF_AT_MS + 1 }),
    }));
    assert.equal(input.localProcessDuties.settled, false);
    assert.ok(input.localProcessDuties.refusals.includes('cutoff-echo-mismatch'), JSON.stringify(input.localProcessDuties.refusals));
  });

  test('an observation stamped on an incompatible clock gets no credit', () => {
    const input = nativeInterruptionGateDInput(record({
      localProcess: armedBlock({ clock: 'held-turn-monotonic-elapsed-ms' }),
    }));
    assert.equal(input.localProcessDuties.settled, false);
    assert.ok(input.localProcessDuties.refusals.includes('local-observation-clock-incompatible'), JSON.stringify(input.localProcessDuties.refusals));
  });

  test('an established-duty record whose invocation exit is NOT positively adjudicated gone stays unsettled (applicable local cleanup unknown or still live refuses)', () => {
    const input = nativeInterruptionGateDInput(record({
      localProcess: armedBlock({ exit: null, reads: [] }),
    }));
    assert.equal(input.localProcessDuties.settled, false);
    assert.ok(input.localProcessDuties.refusals.includes('local-exit-unestablished'), JSON.stringify(input.localProcessDuties.refusals));
  });

  test('an EARLIER termination-initiation boundary is the operative fence (the pre-boundary credit retention)', () => {
    const boundaryAtMs = 15_000;
    const input = nativeInterruptionGateDInput(record({
      interrupt: { measurementCutoffAtMs: MEASUREMENT_CUTOFF_AT_MS, cleanupBoundaryAtMs: boundaryAtMs },
      localProcess: armedBlock({ cleanupBoundaryAtMs: boundaryAtMs }),
    }));
    assert.equal(input.localProcessDuties.fence.operativeAtMs, boundaryAtMs);
    assert.equal(input.localProcessDuties.fence.kind, 'termination-boundary', 'the EARLIER boundary closes credit before the measurement cutoff');
    assert.equal(input.localProcessDuties.settled, true, 'the pre-boundary facts (all completions < 15000) retain their qualified source');
  });
});

describe('local-settlement task 3: the frozen Gate-D oracle composes the local-duty conjunct (oracle v5 — all applicable duties into the final acceptance)', async () => {
  const { evaluateNativeInterruptionSettlement, NATIVE_INTERRUPTION_ORACLE_VERSION } = await import('../tools/shell-wait-probe/release-qualification.mjs');
  /** Every pre-existing conjunct POSITIVE: the false-positive shape subtracts
   * ONLY the local-duty layer. */
  const positiveOhterLayers = () => ({
    delivery: {
      delivered: true, exactTargetMatch: true, aliasResolved: true, terminalBeforeInterrupt: false,
      deliverySent: true, previousStatusOnly: false, unreadableContinuation: false, pendingWindowConfirmed: true,
      hostActivityAdmitted: true,
    },
    turnSettled: true, deliveryToSettlementMs: 5000, companionOutcome: 'terminal-result',
    durableObligations: 'settled', cleanupKill: false,
    survivalControl: { noCollateralQualified: true },
    terminalWinner: 'succeeded', naturalCompletionObserved: false, statusObservationTimeoutOnly: false,
  });
  const settledLocalDuties = () => ({
    contractVersion: 1, settled: true, duties: [], exit: { status: 'disappeared' },
    fence: { operativeAtMs: 20_000, kind: 'measurement-cutoff' }, refusals: [],
  });

  test('the stale settled false-positive: native response + remote terminal + durable settled + control with the LOCAL cleanup unknown still refuses', () => {
    // The §25.10 shape recorded in N: an applicable local layer unobserved
    // (settled false — duties composed but the local exit/cleanup
    // unestablished) may never ride a qualified verdict because every other
    // layer passed.
    const verdict = evaluateNativeInterruptionSettlement({
      ...positiveOhterLayers(),
      localProcessDuties: { ...settledLocalDuties(), settled: false, refusals: ['local-exit-unestablished'] },
    });
    assert.equal(NATIVE_INTERRUPTION_ORACLE_VERSION, 5, 'the oracle version registers the v5 local-duty conjunct');
    assert.equal(verdict.qualified, false, 'the false-positive shape refuses');
    assert.deepEqual(verdict.reasons, ['local-process-duty-unsettled'], 'exactly the local reason rides — nothing else was disturbed');
    assert.equal(verdict.layers.localProcess, false, 'the local layer reports its own failure');
  });

  test('the paired observed-clean control qualifies with the local conjunct settled', () => {
    const verdict = evaluateNativeInterruptionSettlement({
      ...positiveOhterLayers(),
      localProcessDuties: settledLocalDuties(),
    });
    assert.deepEqual(verdict.reasons, []);
    assert.equal(verdict.qualified, true, 'every applicable duty composed pre-fence qualifies');
    assert.equal(verdict.layers.localProcess, true);
  });

  test('a missing local-duty block is the named-unadjudicated refusal — never a legacy fallback that permissively passes', () => {
    // Pre-Task-3 callers (legacy shapes) fail closed with their own reason.
    const verdict = evaluateNativeInterruptionSettlement(positiveOhterLayers());
    assert.equal(verdict.qualified, false);
    assert.ok(verdict.reasons.includes('local-process-observation-unadjudicated'), JSON.stringify(verdict.reasons));
    assert.equal(verdict.layers.localProcess, false);
  });

  test('no alternate branch bypasses: a durable sample fallback beside the unsettled local layer still refuses', () => {
    // The refusal is conjunctive: whatever the durable samples/preserved
    // snapshots established, the local layer keeps its own fail-closed reason.
    const verdict = evaluateNativeInterruptionSettlement({
      ...positiveOhterLayers(),
      durableObligations: 'unresolved',
      // The join's settlement fallback would ground the layer from the
      // latest admissible sample — the LOCAL conjunct is still refused by
      // its own state.
      localProcessDuties: { ...settledLocalDuties(), settled: false, refusals: ['local-duties-unestablished'] },
    });
    assert.equal(verdict.qualified, false);
    assert.ok(verdict.reasons.includes('durable-obligations-unresolved'));
    assert.ok(verdict.reasons.includes('local-process-duty-unsettled'), JSON.stringify(verdict.reasons));
  });

  test('applicability unknown refuses: a null block rides the same named-unadjudicated path as an absent one', () => {
    const verdict = evaluateNativeInterruptionSettlement({
      ...positiveOhterLayers(),
      localProcessDuties: null,
    });
    assert.ok(verdict.reasons.includes('local-process-observation-unadjudicated'), JSON.stringify(verdict.reasons));
  });

  test('a malformed local-duty block is an input-contract error, never a silent pass or silent refusal', () => {
    assert.throws(
      () => evaluateNativeInterruptionSettlement({ ...positiveOhterLayers(), localProcessDuties: { settled: 'maybe' } }),
      /local-process/i,
    );
    assert.throws(
      () => evaluateNativeInterruptionSettlement({ ...positiveOhterLayers(), localProcessDuties: { contractVersion: 99, settled: true, duties: [], refusals: [] } }),
      /contract/i,
    );
  });

  test('the layer grid reports the local layer independently', () => {
    const refused = evaluateNativeInterruptionSettlement({
      ...positiveOhterLayers(),
      localProcessDuties: { ...settledLocalDuties(), settled: false, refusals: ['local-exit-unestablished'] },
    });
    assert.deepEqual(refused.layers, {
      delivery: true, turnSettlement: true, companion: true, durableObligations: true, noCollateral: true, localProcess: false,
    });
  });
});

describe('local-settlement task 3: both §25.7 credit fences bound the runtime END to END (measurement cutoff + any earlier termination-initiation boundary; normal observation teardown is not a boundary)', async () => {
  const { runHeldHostTurn, OBSERVATION_TEARDOWN_AFTER_CUTOFF_MS } = await import('../tools/shell-wait-probe/driver.mjs');
  const CAPTURE_NONCE = 'c'.repeat(64);
  const TRANSPORT_NONCE = '9'.repeat(64);
  const ENTRY = '/private/tmp/fixture-installed/skills/rescue/launcher.mjs';
  const BROKER_ENTRY = '/private/tmp/fixture-installed/scripts/zcode-broker.mjs';
  const DECLARATION = Object.freeze({ captureDirectory: '/private/tmp/fixture-capture', nonce: CAPTURE_NONCE, entryRealpath: ENTRY, brokerEntryRealpath: BROKER_ENTRY });
  const admissionEstablished = (over = {}) => ({
    localProcessObservationVersion: 1, class: 'startup-identity', status: 'established', reason: null,
    identity: { role: 'invocation', nonce: CAPTURE_NONCE, entryRealpath: ENTRY, argv: ['invoke-prepared', 'rescue'], pid: 60100, ppid: 600, firstWriteEpochMs: 1000, startOriginMs: 1000.1, firstWritePreciseMs: 1100.5 },
    readStartedEpochMs: 1000, readEpochMs: 1100, ...over,
  });
  const osEstablished = (over = {}) => ({
    localProcessObservationVersion: 1, class: 'os-live-observation', status: 'established', reason: null,
    observation: { pid: 60100, ppid: 600, startIdentity: 'S-COMPANION', nonce: CAPTURE_NONCE, startInstantEpochMs: 1000, ppidChangedFromCapture: null },
    queried: { pid: 60100, nonce: CAPTURE_NONCE }, readStartedEpochMs: 1100, identityReadEpochMs: 1150, readEpochMs: 1200, absenceConfirmed: null, ...over,
  });
  const osAbsent = (over = {}) => ({
    localProcessObservationVersion: 1, class: 'os-live-observation', status: 'absent', reason: 'no-such-process',
    observation: null, queried: { pid: 60100, nonce: CAPTURE_NONCE },
    readStartedEpochMs: 5000, readEpochMs: 5100, absenceConfirmed: true, ...over,
  });
  const baseHarness = (over = {}) => ({
    gatePath: 'unused-gate',
    launch: async () => ({
      // The result stays pending until the fence is EXERCISED (the absence
      // read happened) — the turn cannot end while the runtime still needs
      // its read slot; hard-bounded so a wedged shape fails the premise
      // loudly instead of hanging the runner.
      result: new Promise((resolve) => { const anchor = setInterval(() => { clearInterval(anchor); resolve({ code: 0, stdout: '', stderr: '' }); }, 2_000); anchor.unref?.(); }),
      terminate: async () => {},
    }),
    waitForGate: async () => {},
    captureProcessIdentity: async () => ({ pid: 60300, ppid: 60100, nonce: TRANSPORT_NONCE, startIdentity: 'S-TRANSPORT' }),
    readProcessIdentity: async () => undefined,
    terminateProcessIdentity: async () => ({ attempted: true, signalled: 'SIGTERM', exited: true, failure: null }),
    waitForProcessExit: async () => {},
    releaseGate: async () => {},
    localObservation: DECLARATION,
    captureLocalObservationIdentity: async () => admissionEstablished(),
    captureLocalBrokerObservationIdentity: async () => ({ ...admissionEstablished(), identity: { role: 'broker-daemon', nonce: CAPTURE_NONCE, entryRealpath: BROKER_ENTRY, configRealpathSha256: 'b'.repeat(64), pid: 60200, ppid: 60100, firstWriteEpochMs: 1000, startOriginMs: 1000.2, firstWritePreciseMs: 1100.6 } }),
    observeLocalBrokerObservationIdentity: async () => osEstablished({ observation: { pid: 60200, ppid: 60100, startIdentity: 'S-DAEMON', nonce: CAPTURE_NONCE, startInstantEpochMs: 1000, ppidChangedFromCapture: null }, queried: { pid: 60200, nonce: CAPTURE_NONCE } }),
    observeLocalTransportObservationIdentity: async () => osEstablished({ observation: { pid: 60300, ppid: 60100, startIdentity: 'S-TRANSPORT', nonce: TRANSPORT_NONCE, startInstantEpochMs: 1000, ppidChangedFromCapture: null }, queried: { pid: 60300, nonce: TRANSPORT_NONCE } }),
    sleep: async () => {},
    processNonce: TRANSPORT_NONCE,
    ...over,
  });

  test("a read whose collection interval straddles the fence \u2014 started before a termination-initiation boundary, completed at/after it \u2014 gets no credit", async () => {
    let reads = 0;
    let boundaryRecorder = null;
    const held = await runHeldHostTurn(baseHarness({
      // The launch closure captures the budget context's termination-boundary
      // recorder: the boundary is stamped DURING the absence read (the
      // boundary initiation happens while the observation was pending).
      launch: async (budgetContext) => {
        boundaryRecorder = budgetContext?.recordCleanupBoundary ?? null;
        return {
          result: new Promise((resolve) => {
            const anchor = setInterval(() => { clearInterval(anchor); resolve({ code: 0, stdout: '', stderr: '' }); }, 2_000);
            anchor.unref?.();
          }),
          terminate: async () => {},
        };
      },
      observeLocalObservationIdentity: async () => {
        reads += 1;
        if (reads === 1 || reads === 2) return osEstablished();
        // The phase-4 read whose collection straddles the (just-stamped)
        // boundary: completion at 1001, boundary stamped at 1000 — the START
        // predates the fence, the COMPLETION does not. No credit either way.
        if (typeof boundaryRecorder === 'function') boundaryRecorder();
        return osAbsent({ readStartedEpochMs: 900, readEpochMs: 1_001 });
      },
      now: () => 1_000,
      // The boundary recorder stamps THIS wall clock (the fence domain).
      wallClockNow: () => 1_000,
      holdMs: 0,
      budgetMs: 1_200_000,
    }));
    const block = held.cleanup.localObservation;
    assert.ok(block);
    assert.ok(reads >= 2, `premise: the phase-4 absence read ran (actual ${reads})`);
    assert.equal(held.cleanup.cleanupBoundaryAtMs, 1_000, `premise: the termination-initiation boundary stamped (actual ${held.cleanup.cleanupBoundaryAtMs})`);
    const posted = block.reads.at(-1);
    assert.equal(posted.postFence, true, 'the straddling completion is posted as the NAMED post-fence observation');
    assert.equal(block.stoppedAt, 'termination-boundary', `the fence stop names the EARLIER boundary (actual ${block.stoppedAt})`);
    assert.equal(block.fenceAtMs, 1_000, 'the fence echo carries the boundary instant');
    // The excluded read is NO evidence: the exit stays the honest
    // no-absence shape (never a disappearance manufactured from a
    // post-fence read) with the bound generation retained.
    assert.equal(block.exit.status, 'unestablished', 'the excluded straddling read is no evidence at all');
    assert.equal(block.exit.reason, 'no-absence-read-after-presence');
    assert.equal(block.exit.firstVerifiedAbsenceEpochMs, null, 'no absence instant is claimed from post-fence reads');
  });
  test("a read that completed after the record's EARLIER termination-initiation boundary gets no credit (post-cleanup death refuses the exit)", async () => {
    // The boundary is stamped DURING the read (a termination initiation that
    // happened while the observation was pending) — at completion the
    // operative fence is the EARLIER boundary. The run's post-fence read is
    // named, and the exit never disappears from it.
    let reads = 0;
    const held = await runHeldHostTurn(baseHarness({
      observeLocalObservationIdentity: async () => {
        reads += 1;
        if (reads === 1) return osEstablished();
        return osAbsent({ readStartedEpochMs: 5100, readEpochMs: 5200 });
      },
      now: () => 1_000,
      holdMs: 0,
      budgetMs: 1_200_000,
    }));
    const block = held.cleanup.localObservation;
    assert.ok(block);
    assert.equal(reads >= 2, true, `premise: both reads ran (actual ${reads})`);
    // With NO recorded fence and the cleanup boundary stamped only AFTER
    // the runtime completed its reads, the pre-window facts remain qualified
    // exactly as they were established — the runtime never fabricates a
    // fence from its own completion.
    assert.equal(block.exit.status, 'disappeared', 'a pre-boundary confirmed absence keeps its qualified source');
    assert.equal(block.cleanupBoundaryAtMs === null || block.exit.firstVerifiedAbsenceEpochMs < block.cleanupBoundaryAtMs, true,
      'the exit absence instant never claims a boundary-crossing completion');
  });

  test("normal observation teardown is NOT a termination boundary: the scheduled run records the cutoff, never a manufactured teardown/kill boundary, never a disappearance", async () => {
    // The release seam is the harness's own 50-ms real brake: after it
    // resolves, the runtime gets its fence precheck (the payday pure clocks
    // sit past the cutoff immediately) BEFORE the recorded-cleanup boundary
    // of whatever late-Root cleanup follows the planned observation end. The
    // carrying assertion: the TEARDOWN instant itself (the cutoff + 5000 ms
    // planned observation end) is never recorded as a termination boundary
    // on the turn or on the block, and the observation never manufactures a
    // disappearance out of the teardown.
    const held = await runHeldHostTurn({
      gatePath: 'unused-gate',
      launch: async () => ({
        result: new Promise(() => { /* never resolves: the scheduled window closes first */ }),
        terminate: async () => {},
      }),
      waitForGate: async () => {},
      captureProcessIdentity: async () => ({ pid: 60300, ppid: 60100, nonce: TRANSPORT_NONCE, startIdentity: 'S-TRANSPORT' }),
      readProcessIdentity: async () => undefined,
      terminateProcessIdentity: async () => ({ attempted: true, signalled: 'SIGTERM', exited: true, failure: null }),
      waitForProcessExit: async () => {},
      releaseGate: async () => { await new Promise((resolve) => setTimeout(resolve, 50)); },
      localObservation: DECLARATION,
      captureLocalObservationIdentity: async () => admissionEstablished(),
      observeLocalObservationIdentity: async () => osEstablished(),
      captureLocalBrokerObservationIdentity: async () => ({ ...admissionEstablished(), identity: { role: 'broker-daemon', nonce: CAPTURE_NONCE, entryRealpath: BROKER_ENTRY, configRealpathSha256: 'b'.repeat(64), pid: 60200, ppid: 60100, firstWriteEpochMs: 1000, startOriginMs: 1000.2, firstWritePreciseMs: 1100.6 } }),
      observeLocalBrokerObservationIdentity: async () => osEstablished({ observation: { pid: 60200, ppid: 60100, startIdentity: 'S-DAEMON', nonce: CAPTURE_NONCE, startInstantEpochMs: 1000, ppidChangedFromCapture: null }, queried: { pid: 60200, nonce: CAPTURE_NONCE } }),
      observeLocalTransportObservationIdentity: async () => osEstablished({ observation: { pid: 60300, ppid: 60100, startIdentity: 'S-TRANSPORT', nonce: TRANSPORT_NONCE, startInstantEpochMs: 1000, ppidChangedFromCapture: null }, queried: { pid: 60300, nonce: TRANSPORT_NONCE } }),
      sleep: async () => {},
      now: (() => { let value = 0; return () => (value += 500); })(),
      wallClockNow: (() => { let value = 0; return () => (value += 500); })(),
      holdMs: 5_000,
      budgetMs: 10_000_000_000,
      measurementCutoffSchedule: true,
      processNonce: TRANSPORT_NONCE,
    });
    const block = held.cleanup.localObservation;
    assert.ok(block);
    const cutoff = held.cleanup.measurementCutoffAtMs;
    assert.equal(typeof cutoff === 'number' && Number.isFinite(cutoff) && cutoff >= 10_000, true, `premise: the cutoff schedule armed and stamped (actual ${cutoff})`);
    // The fence precheck caught the runtime BEFORE any read (the payday
    // pure clocks sit past the cutoff at phase-4 entry): the stop names the
    // MEASUREMENT cutoff and echoes exactly the cutoff instant.
    assert.equal(block.stoppedAt, 'measurement-cutoff', `the fence stop names the MEASUREMENT cutoff (actual ${block.stoppedAt})`);
    assert.equal(block.fenceAtMs, cutoff, 'the fence echo carries the cutoff instant');
    // Every admitted read is strictly PRE-fence (equality included in the
    // refusal); nothing past the fence ever rides the adjudication.
    if (Array.isArray(block.reads) && block.reads.length > 0) {
      assert.ok(block.reads.every((read) => typeof read.readEpochMs === 'number' && read.readEpochMs < cutoff && read.postFence !== true),
        `every admitted read keeps a demonstrably pre-fence completion (actual ${JSON.stringify(block.reads.map((read) => ({ e: read.readEpochMs, post: read.postFence === true })))})`);
    }
    // section 24.8 teardown is NOT a termination boundary: the PLANNED
    // observation end (cutoff + 5000 ms) is never recorded as a cleanup
    // boundary on the turn's cleanup facts (a boundary may legitimately
    // exist from a RECORDED cause such as fix C's late-Root cleanup --- its
    // value and the block echo are consistent, never the teardown instant).
    assert.notEqual(held.cleanup.cleanupBoundaryAtMs, cutoff + OBSERVATION_TEARDOWN_AFTER_CUTOFF_MS,
      'the planned observation teardown instant is never recorded as a termination boundary');
    assert.equal(block.cleanupBoundaryAtMs === null || block.cleanupBoundaryAtMs === held.cleanup.cleanupBoundaryAtMs, true,
      "the block's boundary echo stays consistent with the turn's cleanup facts");
    // The observation teardown never manufactures a disappearance.
    assert.equal(block.exit === null || block.exit.status === 'unestablished' || block.exit.status === 'live', true, 'teardown never manufactures a disappearance');
  });
});

describe('local-settlement task 3: the abort path and the runtime evidence gates (never guessed, never replaced)', async () => {
  const { runHeldHostTurn } = await import('../tools/shell-wait-probe/driver.mjs');
  const CAPTURE_NONCE = 'c'.repeat(64);
  const TRANSPORT_NONCE = '9'.repeat(64);
  const ENTRY = '/private/tmp/fixture-installed/skills/rescue/launcher.mjs';
  const BROKER_ENTRY = '/private/tmp/fixture-installed/scripts/zcode-broker.mjs';
  const DECLARATION = Object.freeze({ captureDirectory: '/private/tmp/fixture-capture', nonce: CAPTURE_NONCE, entryRealpath: ENTRY, brokerEntryRealpath: BROKER_ENTRY });
  const admissionEstablished = (over = {}) => ({
    localProcessObservationVersion: 1, class: 'startup-identity', status: 'established', reason: null,
    identity: { role: 'invocation', nonce: CAPTURE_NONCE, entryRealpath: ENTRY, argv: ['invoke-prepared', 'rescue'], pid: 60100, ppid: 600, firstWriteEpochMs: 1000, startOriginMs: 1000.1, firstWritePreciseMs: 1100.5 },
    readStartedEpochMs: 1000, readEpochMs: 1100, ...over,
  });
  const osEstablished = (over = {}) => ({
    localProcessObservationVersion: 1, class: 'os-live-observation', status: 'established', reason: null,
    observation: { pid: 60100, ppid: 600, startIdentity: 'S-COMPANION', nonce: CAPTURE_NONCE, startInstantEpochMs: 1000, ppidChangedFromCapture: null },
    queried: { pid: 60100, nonce: CAPTURE_NONCE }, readStartedEpochMs: 1100, identityReadEpochMs: 1150, readEpochMs: 1200, absenceConfirmed: null, ...over,
  });

  test('a budget-expiry abort persists the collected local facts on the carried record before the turn ends', async () => {
    const reads = [];
    const held = await runHeldHostTurn({
      gatePath: 'unused-gate',
      // The turn spins its hold on a never-resolving gate while the budget
      // timer runs OUT; the runtime keeps observing concurrently.
      launch: async () => ({ result: new Promise(() => {}), terminate: async () => {} }),
      waitForGate: async () => new Promise(() => {}),
      captureProcessIdentity: async () => ({ pid: 60300, ppid: 60100, nonce: TRANSPORT_NONCE, startIdentity: 'S-TRANSPORT' }),
      readProcessIdentity: async () => ({ pid: 60300, ppid: 60100, nonce: TRANSPORT_NONCE, startIdentity: 'S-TRANSPORT' }),
      terminateProcessIdentity: async () => ({ attempted: true, signalled: 'SIGTERM', exited: true, failure: null }),
      waitForProcessExit: async () => {},
      releaseGate: async () => {},
      localObservation: DECLARATION,
      captureLocalObservationIdentity: async () => admissionEstablished(),
      observeLocalObservationIdentity: async () => { reads.push(true); return osEstablished(); },
      captureLocalBrokerObservationIdentity: async () => admissionEstablished(),
      observeLocalBrokerObservationIdentity: async () => osEstablished({ observation: { pid: 60200, ppid: 60100, startIdentity: 'S-DAEMON', nonce: CAPTURE_NONCE, startInstantEpochMs: 1000, ppidChangedFromCapture: null } }),
      observeLocalTransportObservationIdentity: async () => osEstablished({ observation: { pid: 60300, ppid: 60100, startIdentity: 'S-TRANSPORT', nonce: TRANSPORT_NONCE, startInstantEpochMs: 1000, ppidChangedFromCapture: null } }),
      sleep: async () => {},
      // The monotonic clock advances per call (a call-counted clock): the
      // hold never ends (its deadline is unreachable), the BUDGET fires —
      // the budget-abort path drives the turn's end deterministically.
      now: (() => { let value = 0; return () => (value += 500); })(),
      holdMs: 1_000_000_000,
      budgetMs: 5_000,
    });
    assert.equal(held.budgetExpired, true, `premise: the turn ended by the budget abort (the runtime observed ${reads.length} reads before it)`);
    const block = held.cleanup.localObservation;
    assert.ok(block, 'the collected local facts ride the budget-aborted record');
    assert.equal(block.armed, true);
    assert.equal(block.admission.status, 'established', 'the admitted invocation identity survives the abort');
    assert.equal(block.composedAtMs !== null, true, 'the duty composition completed before the record left the turn');
  });
});

describe('local-settlement task 3 review round: the EXECUTED observation path keeps the §25.7 fence honest through the actual composition (the runtime dispatches the REAL observer, per-path completion sampling)', async () => {
  const { runHeldHostTurn, mapShellWaitLiveFacts, nativeInterruptionGateDInput } = await import('../tools/shell-wait-probe/driver.mjs');
  const { admitStartupIdentityRecord } = await import('../tools/shell-wait-probe/local-process-observation.mjs');
  const { IDENTITY_RECORD_VERSION } = await import('../tools/shell-wait-probe/closure-preload.mjs');
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const CAPTURE_NONCE = 'a'.repeat(64);
  const TRANSPORT_NONCE = 'f'.repeat(64);
  /** The C-locale UTC ps lstart text for ONE fixed creation second (the
   * single-digit day renders with the double space the UTC parser expects). */
  const LSTART = 'Thu Oct  1 00:00:01 2026';
  const START_SECOND_MS = Date.parse('2026-10-01T00:00:01Z');
  const LIVE_ROW = () => ({ pid: 60100, ppid: 600, lstart: LSTART });

  const buildArming = async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'local-process-review-runtime-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const installed = join(root, 'installed');
    const captureDirectory = join(root, 'capture');
    const launcherPath = join(installed, 'skills', 'rescue', 'launcher.mjs');
    await mkdir(captureDirectory, { mode: 0o700 });
    await mkdir(join(installed, 'skills', 'rescue'), { recursive: true });
    await writeFile(launcherPath, '// stand-in launcher entry\n', 'utf8');
    const recordPath = join(captureDirectory, `${CAPTURE_NONCE}.identity.json`);
    const record = {
      version: IDENTITY_RECORD_VERSION,
      role: 'invocation',
      nonce: CAPTURE_NONCE,
      entryRealpath: launcherPath,
      argv: ['invoke-prepared', 'rescue'],
      pid: 60100,
      ppid: 600,
      firstWriteEpochMs: START_SECOND_MS + 20,
      startOriginMs: START_SECOND_MS + 0.5,
      firstWritePreciseMs: START_SECOND_MS + 20.5,
    };
    await writeFile(recordPath, JSON.stringify(record), { mode: 0o600 });
    const declaration = { captureDirectory, nonce: CAPTURE_NONCE, entryRealpath: launcherPath };
    return { captureDirectory, declaration };
  };

  test('an observation whose collection straddles a mid-read termination-initiation boundary credits nothing on the runtime path (per-path completions, not the dispatch stamp)', async (t) => {
    const { captureDirectory, declaration } = await buildArming(t);
    // Honest admission first: the runtime-path fixture uses the REAL record
    // admission (the same read the executed path performs, offline-pinned).
    const admitted = await admitStartupIdentityRecord({
      captureDirectory, nonce: CAPTURE_NONCE, role: 'invocation',
      expectedEntryRealpath: declaration.entryRealpath,
      nowEpochMs: START_SECOND_MS + 25,
    });
    assert.equal(admitted.status, 'established', `premise: the real record file admits (actual ${admitted.status} ${admitted.reason ?? ''})`);

    // ps call sequence: (1,2) the phase-2 presence double-read (live row);
    // (3) the FIRST phase-4 absence read's first start-identity read — it
    // stamps the termination-initiation boundary (via the launch context's
    // recorded recorder) and then resolves NO process: the read's collection
    // straddles the boundary it cannot see, and ONLY an honest per-path
    // completion stamp can prove that straddle.
    let psCalls = 0;
    let boundaryRecorder = null;
    const psSeam = async () => {
      psCalls += 1;
      if (psCalls === 3) {
        if (typeof boundaryRecorder === 'function') boundaryRecorder();
        return undefined;
      }
      return LIVE_ROW();
    };
    const held = await runHeldHostTurn({
      gatePath: 'unused-gate',
      holdMs: 0,
      budgetMs: 10_000_000_000,
      launch: async (budgetContext) => {
        boundaryRecorder = budgetContext?.recordCleanupBoundary ?? null;
        return {
          result: new Promise((resolve) => { setTimeout(() => resolve({ code: 0, stdout: '', stderr: '' }), 2_000); }),
          terminate: async () => {},
        };
      },
      // NO observeLocalObservationIdentity injection: the runtime composes the
      // REAL observeLocalProcess (the executed path); the OS seams ride the
      // composition's instrument options — a synthetic pid never reaches the
      // real OS.
      waitForGate: async () => {},
      captureProcessIdentity: async () => ({ pid: 60300, ppid: 60100, nonce: TRANSPORT_NONCE, startIdentity: 'S-TRANSPORT' }),
      readProcessIdentity: async () => ({ pid: 60300, ppid: 60100, nonce: TRANSPORT_NONCE, startIdentity: 'S-TRANSPORT' }),
      terminateProcessIdentity: async () => ({ attempted: true, signalled: 'SIGTERM', exited: true, failure: null }),
      waitForProcessExit: async () => {},
      releaseGate: async () => {},
      localObservation: declaration,
      localObservationObserverOptions: {
        osSeams: { platform: 'darwin', ps: psSeam, environ: 'present' },
        absenceConfirmation: async () => 'absent',
      },
      sleep: async () => {},
      // The wall clock ADVANCES per call: every per-path completion sample
      // taken after the boundary stamp is demonstrably at/after the fence.
      now: (() => { let value = 0; return () => (value += 500); })(),
      wallClockNow: (() => { let value = START_SECOND_MS + 5_000; return () => (value += 500); })(),
      processNonce: TRANSPORT_NONCE,
    });
    const block = held.cleanup.localObservation;
    assert.ok(block, 'the armed runtime persisted its block');
    const posted = (block.reads ?? []).at(-1);
    assert.ok(posted, `premise: the runtime collected at least one absence read (reads ${JSON.stringify(block.reads?.map((read) => ({ status: read.status, started: read.readStartedEpochMs, completed: read.readEpochMs, postFence: read.postFence === true, reason: read.reason ?? null })))})`);
    assert.equal(held.cleanup.cleanupBoundaryAtMs !== null && typeof held.cleanup.cleanupBoundaryAtMs === 'number', true,
      `premise: the boundary was stamped on the runtime wall clock (actual ${held.cleanup.cleanupBoundaryAtMs})`);
    assert.equal(posted.readStartedEpochMs < held.cleanup.cleanupBoundaryAtMs, true,
      `the straddle is honest on the START side: the read dispatched before the fence (${posted.readStartedEpochMs} < ${held.cleanup.cleanupBoundaryAtMs})`);
    assert.equal(posted.readEpochMs >= held.cleanup.cleanupBoundaryAtMs, true,
      `the straddle is honest on the COMPLETION side: the collection finished at/after the fence (${posted.readEpochMs} >= ${held.cleanup.cleanupBoundaryAtMs})`);
    assert.equal(posted.postFence, true, 'the straddling read is the NAMED post-fence observation — a boundary-crossing collection never credits');
    assert.equal(block.stoppedAt, 'termination-boundary', `the fence stop names the EARLIER boundary (actual ${block.stoppedAt})`);
    assert.equal(block.fenceAtMs, held.cleanup.cleanupBoundaryAtMs, 'the fence echo carries the boundary instant');
    // The boundary-crossing collection is NO absence evidence at all.
    assert.equal(block.exit === null || block.exit.status === 'unestablished', true,
      `no disappearance is adjudicated from a straddling collection (actual ${block.exit?.status})`);
    if (block.exit !== null) {
      assert.equal(block.exit.firstVerifiedAbsenceEpochMs, null, 'no absence instant is claimed from the straddling read');
      assert.equal(block.exit.reason, 'no-absence-read-after-presence');
    }
    // The offline join re-verification consumed the HONEST per-path stamps
    // when the mapped record reloads: no absence credit rides and the block's
    // echoed boundary agrees with the record's own stamp.
    const liveFacts = mapShellWaitLiveFacts(
      { case: 'rescue-interrupt', pollMs: 3_600_000, waitPolicy: null, interruptBaselineSelector: null, survivalControlSelector: null },
      held, { status: 'inconclusive', inconclusive: { reason: 'the offline path never runs the evidence scan' }, facts: null },
      null, null, null, [], [],
    );
    const joined = nativeInterruptionGateDInput({
      status: 'executed', case: 'rescue-interrupt',
      interrupt: { measurementCutoffAtMs: null, cleanupBoundaryAtMs: held.cleanup.cleanupBoundaryAtMs },
      observations: {}, child: {},
      localProcess: liveFacts.localProcess,
    });
    assert.equal(joined.localProcessDuties === null, false, 'the runtime block composes the local-duty contract');
    assert.ok(joined.localProcessDuties.refusals.includes('local-exit-unestablished'), JSON.stringify(joined.localProcessDuties.refusals));
    assert.equal(joined.localProcessDuties.refusals.includes('cleanup-boundary-echo-mismatch'), false, 'the block echo agrees with the stamped boundary');
    assert.equal(joined.localProcessDuties.settled, false, 'the joined contract refuses: the straddling read is no absence evidence');
  });
});

describe('local-settlement task 3 review round 2 (four P2 findings): the local-duty composition gates ancestry, re-verifies the persisted duties and exit, and verifies the effective launch environment', async () => {
  const { nativeInterruptionGateDInput } = await import('../tools/shell-wait-probe/driver.mjs');
  const { evaluateNativeInterruptionSettlement } = await import('../tools/shell-wait-probe/release-qualification.mjs');
  const { createHash } = await import('node:crypto');
  const sha = (v) => createHash('sha256').update(v).digest('hex');
  const MEASUREMENT_CUTOFF_AT_MS = 20_000;

  /** One coherent armed block + a record, locally built for the re-verification battery. */
  const arm = () => {
    const scopeNonce = 'a'.repeat(64);
    const transport = 'f'.repeat(64);
    const observation = (pid, ppid, startIdentity, scope, readStarted, identityRead, readEpoch, startInstant = 1000) => ({
      localProcessObservationVersion: 1, class: 'os-live-observation', status: 'established', reason: null,
      observation: { pid, ppid, startIdentity, startInstantEpochMs: startInstant, ppidChangedFromCapture: null, nonceSha256: scope },
      queried: { pid, nonceSha256: scope },
      readStartedEpochMs: readStarted, identityReadEpochMs: identityRead, readEpochMs: readEpoch,
      absenceConfirmed: null,
    });
    const block = {
      version: 1, armed: true, clock: 'wall-epoch-ms', nonceSha256: sha(scopeNonce),
      admission: { localProcessObservationVersion: 1, class: 'startup-identity', status: 'established', reason: null, identity: { role: 'invocation', argv: ['invoke-prepared', 'rescue'], entryRealpathSha256: sha('launcher-entry'), pid: 60100, ppid: 600, firstWriteEpochMs: 1000, startOriginMs: 1000.1, firstWritePreciseMs: 1100.5, nonceSha256: sha(scopeNonce) }, readStartedEpochMs: 1000, readEpochMs: 1100 },
      presence: observation(60100, 600, 'S-COMPANION', sha(scopeNonce), 1900, 2100, 2300),
      transportExit: { localProcessObservationVersion: 1, class: 'os-live-observation', status: 'absent', reason: 'no-such-process', observation: null, queried: { pid: 60300, nonceSha256: sha(transport) }, readStartedEpochMs: 5200, identityReadEpochMs: 5250, readEpochMs: 5300, absenceConfirmed: true },
      reads: [{ localProcessObservationVersion: 1, class: 'os-live-observation', status: 'absent', reason: 'no-such-process', observation: null, queried: { pid: 60100, nonceSha256: sha(scopeNonce) }, readStartedEpochMs: 4900, readEpochMs: 5100, absenceConfirmed: true }],
      exit: { localProcessObservationVersion: 1, class: 'exit-absence', status: 'disappeared', reason: null, boundIdentity: { pid: 60100, startIdentity: 'S-COMPANION', nonceSha256: sha(scopeNonce) }, lastVerifiedPresenceEpochMs: 2100, firstVerifiedAbsenceEpochMs: 5100, exitCorroboratedByMeta: false },
      brokerAdmission: { localProcessObservationVersion: 1, class: 'startup-identity', status: 'established', reason: null, identity: { role: 'broker-daemon', entryRealpathSha256: sha('broker-entry'), pid: 60200, ppid: 60100, firstWriteEpochMs: 3000, startOriginMs: 3000.2, firstWritePreciseMs: 3100.6, nonceSha256: sha(scopeNonce) }, readStartedEpochMs: 1900, readEpochMs: 2100 },
      brokerObservation: observation(60200, 60100, 'S-DAEMON', sha(scopeNonce), 3300, 3400, 3500, 3000),
      transportObservation: observation(60300, 60200, 'S-TRANSPORT', sha(transport), 2000, 2200, 2500, 5000),
      ancestry: { localProcessObservationVersion: 1, class: 'ancestry-join', nonceSha256: sha(scopeNonce), companionToTransportAttributed: true, hops: [
        { hop: 'companion-to-daemon', status: 'established', reason: null },
        { hop: 'daemon-to-transport', status: 'established', reason: null },
      ] },
      // (Review round 3, Finding 4; round 4, Finding 2) the refreshed
      // endpoint markers ride the honest positive: generation-bound to the
      // duty slots, lifetime-consistent at the uniform bound, the marker
      // claiming the daemon's parentage, the transport's OWN scope and its
      // OWN persisted write instant.
      ancestryEndpoints: {
        companion: observation(60100, 600, 'S-COMPANION', sha(scopeNonce), 4600, 4650, 4700, 1000),
        daemon: observation(60200, 60100, 'S-DAEMON', sha(scopeNonce), 4600, 4650, 4750, 3000),
        transportMarker: { pid: 60300, ppid: 60200, nonceSha256: sha(transport), markerEpochMs: 4450 },
      },
      duties: { localProcessObservationVersion: 1, class: 'local-duty-verdict', settled: true, duties: [
        { duty: 'invocation-process', status: 'established', reasons: [], identity: { pid: 60100, startIdentity: 'S-COMPANION', nonceSha256: sha(scopeNonce) } },
        { duty: 'broker-daemon', status: 'established', reasons: [], identity: { pid: 60200, startIdentity: 'S-DAEMON', nonceSha256: sha(scopeNonce) } },
        { duty: 'transport-descendant', status: 'established', reasons: [], identity: { pid: 60300, startIdentity: 'S-TRANSPORT', nonceSha256: sha(transport) } },
      ] },
      stoppedAt: null, fenceAtMs: null, cutoffAtMs: MEASUREMENT_CUTOFF_AT_MS, cleanupBoundaryAtMs: null, composedAtMs: 6000,
    };
    const record = (over = {}) => ({
      status: 'executed', case: 'rescue-interrupt', executedAt: '2026-10-30T00:00:00.000Z',
      interrupt: { measurementCutoffAtMs: MEASUREMENT_CUTOFF_AT_MS },
      stdoutCaptureDeclaration: {
        preload: 'closure-observe.mjs', preloadSha256: sha('preload-bytes'), maxBytes: 65536,
        gate: { argv: ['invoke-prepared', 'rescue'], declaredEntryRealpathSha256: sha('launcher-entry') },
        brokerGate: { declaredBrokerEntryRealpathSha256: sha('broker-entry') },
        identityRecord: { version: 2, roles: { invocation: 'identity.json', brokerDaemon: 'identity-broker.json' } },
        environmentVariables: [],
      },
      observations: {}, child: {},
      localProcess: block,
      ...over,
    });
    return { scopeNonce, transport, block, record };
  };
  const cleanCopy = (base) => JSON.parse(JSON.stringify(base));

  test("F2 RED → an aggregate claiming settled with the three duty pieces removed ({} duties list) is refused by name (never trusted)", () => {
    const g = arm();
    const stripped = cleanCopy(g.record());
    stripped.localProcess.duties = { localProcessObservationVersion: 1, class: 'local-duty-verdict', settled: true, duties: [] };
    const verdict = evaluateNativeInterruptionSettlement(nativeInterruptionGateDInput(stripped));
    assert.equal(verdict.qualified, false);
    const reasons = nativeInterruptionGateDInput(stripped).localProcessDuties;
    assert.equal(reasons.settled, false, 'the untrusted aggregate never settles without its persisted pieces');
    for (const named of ['inline-duty-invocation-process-unpersisted', 'inline-duty-broker-daemon-unpersisted', 'inline-duty-transport-descendant-unpersisted']) {
      assert.ok(reasons.refusals.includes(named), `${named} missing from ${JSON.stringify(reasons.refusals)}`);
    }
  });

  test('F2 RED (2) → established duties whose echoed OBSERVATIONS were removed are refused by name (a listed-established aggregate with no backing pieces)', () => {
    const g = arm();
    const stripped = cleanCopy(g.record());
    delete stripped.localProcess.presence;
    delete stripped.localProcess.brokerObservation;
    delete stripped.localProcess.transportObservation;
    const verdict = evaluateNativeInterruptionSettlement(nativeInterruptionGateDInput(stripped));
    assert.equal(verdict.qualified, false);
    const reasons = nativeInterruptionGateDInput(stripped).localProcessDuties;
    assert.equal(reasons.settled, false);
    for (const named of ['inline-duty-observation-missing', 'exit-presence-unpersisted']) {
      assert.ok(reasons.refusals.includes(named), `${named} missing from ${JSON.stringify(reasons.refusals)}`);
    }
  });

  test("F2 RED → an aggregate listing EXPLICIT-unestablished entries while claiming settled is refused by name", () => {
    const g = arm();
    const torn = cleanCopy(g.record());
    torn.localProcess.duties.duties[0].status = 'unestablished';
    torn.localProcess.duties.duties[0].reasons = ['os-observation-unestablished'];
    const consolidated = nativeInterruptionGateDInput(torn).localProcessDuties;
    assert.equal(consolidated.settled, false, 'the aggregate-inconsistent shape never settles');
    assert.ok(consolidated.refusals.includes('inline-duty-aggregate-inconsistent'), JSON.stringify(consolidated.refusals));
  });

  test('F3 RED → the persisted exit bound to a FOREIGN identity and stripped reads never credits', () => {
    const g = arm();
    const foreign = cleanCopy(g.record());
    foreign.localProcess.exit.boundIdentity = { pid: 60999, startIdentity: 'S-FOREIGN', nonceSha256: sha(g.scopeNonce) };
    foreign.localProcess.reads = [];
    const consolidated = nativeInterruptionGateDInput(foreign).localProcessDuties;
    assert.equal(consolidated.settled, false, 'a foreign bound identity never settles');
    assert.ok(consolidated.refusals.includes('exit-bound-identity-foreign'), JSON.stringify(consolidated.refusals));
    assert.ok(consolidated.refusals.includes('exit-absence-uncorrelated'), JSON.stringify(consolidated.refusals));
  });

  test('F3 RED → a disappeared verdict whose absence instant is NOT any persisted confirmed-absence completion is refused by name', () => {
    const g = arm();
    const invented = cleanCopy(g.record());
    invented.localProcess.exit.firstVerifiedAbsenceEpochMs = 9_999;
    const consolidated = nativeInterruptionGateDInput(invented).localProcessDuties;
    assert.equal(consolidated.settled, false);
    assert.ok(consolidated.refusals.includes('exit-absence-uncorrelated'), JSON.stringify(consolidated.refusals));
  });

  test('F1 RED (offline) → a block whose persisted ancestry join is UNATTRIBUTED never settles', () => {
    const g = arm();
    const refused = cleanCopy(g.record());
    refused.localProcess.ancestry.companionToTransportAttributed = false;
    refused.localProcess.ancestry.hops = [
      { hop: 'companion-to-daemon', status: 'unestablished', reason: 'generation-lifetime-unverifiable' },
      { hop: 'daemon-to-transport', status: 'unestablished', reason: 'marker-ppid-mismatch-at-capture' },
    ];
    const consolidated = nativeInterruptionGateDInput(refused).localProcessDuties;
    assert.equal(consolidated.settled, false, 'unattributed ancestry never settles the local layer');
    assert.ok(consolidated.refusals.includes('ancestry-hops-unattributed'), JSON.stringify(consolidated.refusals));
  });

  test('F1 RED (offline) → a LEGACY block without the persisted ancestry verdict never settles (fail-closed, named)', () => {
    const g = arm();
    const legacy = cleanCopy(g.record());
    delete legacy.localProcess.ancestry;
    const consolidated = nativeInterruptionGateDInput(legacy).localProcessDuties;
    assert.equal(consolidated.settled, false);
    assert.ok(consolidated.refusals.includes('ancestry-unpersisted'), JSON.stringify(consolidated.refusals));
  });

  test('the POSITIVE control: the honest armed block (ancestry attributed, duties consistent, exit bound and credited) settles with ZERO refusals', () => {
    const g = arm();
    const consolidated = nativeInterruptionGateDInput(g.record()).localProcessDuties;
    assert.deepEqual(consolidated.refusals, [], JSON.stringify(consolidated.refusals));
    assert.equal(consolidated.settled, true);
    const verdict = evaluateNativeInterruptionSettlement({
      delivery: { delivered: true, exactTargetMatch: true, aliasResolved: true, terminalBeforeInterrupt: false, deliverySent: true, previousStatusOnly: false, unreadableContinuation: false, pendingWindowConfirmed: true, hostActivityAdmitted: true },
      turnSettled: true, deliveryToSettlementMs: 5000, companionOutcome: 'terminal-result',
      durableObligations: 'settled', cleanupKill: false, survivalControl: { noCollateralQualified: true },
      terminalWinner: 'succeeded', naturalCompletionObserved: false, statusObservationTimeoutOnly: false,
      localProcessDuties: consolidated,
    });
    assert.equal(verdict.qualified, true);
  });

  test('F3: a persisted presence read completing AFTER the confirmed absence never lets the exit credit (the live-wins rule re-verified)', () => {
    const g = arm();
    const supersede = cleanCopy(g.record());
    supersede.localProcess.reads.push({ localProcessObservationVersion: 1, class: 'os-live-observation', status: 'established', reason: null, observation: { pid: 60100, ppid: 600, startIdentity: 'S-COMPANION', startInstantEpochMs: 1000, ppidChangedFromCapture: null, nonceSha256: sha(g.scopeNonce) }, queried: { pid: 60100, nonceSha256: sha(g.scopeNonce) }, readStartedEpochMs: 5150, identityReadEpochMs: 5170, readEpochMs: 5200, absenceConfirmed: null });
    const consolidated = nativeInterruptionGateDInput(supersede).localProcessDuties;
    assert.equal(consolidated.settled, false, 'a later same-generation presence read re-wins the verdict — the persisted exit cannot claim it');
    assert.ok(consolidated.refusals.includes('exit-absence-superseded'), JSON.stringify(consolidated.refusals));
  });
});

describe('local-settlement task 3 review round 2 (P2 findings, runtime + preflight): the runtime composes and gates the ancestry join; the preflight verifies the effective capture environment', async () => {
  const { runHeldHostTurn, evaluateLiveLaunchPreflight } = await import('../tools/shell-wait-probe/driver.mjs');
  const { IDENTITY_RECORD_VERSION } = await import('../tools/shell-wait-probe/closure-preload.mjs');
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { createHash } = await import('node:crypto');

  const CAPTURE_NONCE = 'a'.repeat(64);
  const TRANSPORT_NONCE = 'f'.repeat(64);
  const START_SECOND_MS = Date.parse('2026-10-01T00:00:01Z');
  // Per-row seconds: uniform whole-second bounds (round 19) make same-second
  // generation joins unverifiable, so the synthesis carries its OWN gaps:
  // the Companion in second 1, the daemon in second 3 (the broker record's
  // precise start lives inside it), the transport in second 5, and the
  // marker epoch inside (daemonStart + 1000, daemonRead].
  const COMPANION_LSTART = 'Thu Oct  1 00:00:01 2026';
  const DAEMON_LSTART = 'Thu Oct  1 00:00:03 2026';
  const TRANSPORT_LSTART = 'Thu Oct  1 00:00:05 2026';
  const MARKER_EPOCH_MS = START_SECOND_MS + 3_450;
  const invRow = () => ({ pid: 60100, ppid: 600, lstart: COMPANION_LSTART });
  const broRow = () => ({ pid: 60200, ppid: 60100, lstart: DAEMON_LSTART });
  const traRow = () => ({ pid: 60300, ppid: 60200, lstart: TRANSPORT_LSTART });
  const wrongBroRow = () => ({ pid: 60200, ppid: 60500, lstart: DAEMON_LSTART });

  const buildRunner = async (t, rows) => {
    const root = await mkdtemp(join(tmpdir(), 'local-process-r2-runtime-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const installed = join(root, 'installed');
    const captureDirectory = join(root, 'capture');
    const launcherPath = join(installed, 'skills', 'rescue', 'launcher.mjs');
    const brokerPath = join(installed, 'scripts', 'zcode-broker.mjs');
    await mkdir(captureDirectory, { mode: 0o700 });
    await mkdir(join(installed, 'skills', 'rescue'), { recursive: true });
    await mkdir(join(installed, 'scripts'), { recursive: true });
    await writeFile(launcherPath, '// stand-in launcher\n', 'utf8');
    await writeFile(brokerPath, '// stand-in broker entry\n', 'utf8');
    const recordPath = join(captureDirectory, `${CAPTURE_NONCE}.identity.json`);
    const record = {
      version: IDENTITY_RECORD_VERSION, role: 'invocation', nonce: CAPTURE_NONCE,
      entryRealpath: launcherPath, argv: ['invoke-prepared', 'rescue'],
      pid: 60100, ppid: 600,
      firstWriteEpochMs: START_SECOND_MS + 20, startOriginMs: START_SECOND_MS + 0.5, firstWritePreciseMs: START_SECOND_MS + 20.5,
    };
    await writeFile(recordPath, JSON.stringify(record), { mode: 0o600 });
    const brokerRecord = {
      version: IDENTITY_RECORD_VERSION, role: 'broker-daemon', nonce: CAPTURE_NONCE,
      entryRealpath: brokerPath, configRealpathSha256: createHash('sha256').update(join(root, 'config')).digest('hex'),
      pid: 60200, ppid: 60100,
      firstWriteEpochMs: START_SECOND_MS + 3_022, startOriginMs: START_SECOND_MS + 3_002.5, firstWritePreciseMs: START_SECOND_MS + 3_022.5,
    };
    await writeFile(join(captureDirectory, `${CAPTURE_NONCE}.identity-broker.json`), JSON.stringify(brokerRecord), { mode: 0o600 });
    const declaration = { captureDirectory, nonce: CAPTURE_NONCE, entryRealpath: launcherPath, brokerEntryRealpath: brokerPath };
    let psCalls = 0;
    const psSeam = async () => {
      psCalls += 1;
      return rows({ calls: psCalls });
    };
    return { root, declaration, psSeam, counter: () => psCalls };
  };

  test('F1 (runtime): wrong parentage keeps the duties unresolved and the ancestry join names both hops', async (t) => {
    // The broker row's ppid points at a FOREIGN pid (≠ the Companion pid) and
    // the transport marker's ppid at another FOREIGN pid (≠ the daemon pid):
    // every per-duty slot binds (pid+nonce+start), but the
    // Companion→broker→transport parentage is broken in both hops.
    let phaseThreeObserved = false;
    const wrong = await buildRunner(t, ({ calls }) => {
      if (calls <= 2) return invRow();
      if (calls <= 4) return wrongBroRow();
      if (calls <= 6) { if (calls === 6) phaseThreeObserved = true; return traRow(); }
      return undefined;
    });
    const held = await runHeldHostTurn({
      gatePath: 'unused-gate',
      // The hold spans phase-1..3 (the mono clock is GATED on the phase-3
      // completion signal; the sleep is real-timed) so the runtime wins the
      // phase race; the launch result is anchored on the runtime's own
      // absence read (ps call ≥ 7) with a hard fallback.
      holdMs: 300_000,
      budgetMs: 10_000_000_000,
      launch: async () => ({
        result: new Promise((resolve) => {
          const anchor = setInterval(() => { if (wrong.counter() >= 7) { clearInterval(anchor); resolve({ code: 0, stdout: '', stderr: '' }); } }, 5);
          anchor.unref?.();
          setTimeout(() => { clearInterval(anchor); resolve({ code: 0, stdout: '', stderr: '' }); }, 10_000).unref?.();
        }),
        terminate: async () => {},
      }),
      waitForGate: async () => {},
      captureProcessIdentity: async () => ({ pid: 60300, ppid: 60700, nonce: TRANSPORT_NONCE, startIdentity: TRANSPORT_LSTART, markerEpochMs: MARKER_EPOCH_MS }),
      readProcessIdentity: async () => undefined,
      terminateProcessIdentity: async () => ({ attempted: true, signalled: 'SIGTERM', exited: true, failure: null }),
      waitForProcessExit: async () => {},
      releaseGate: async () => {},
      localObservation: wrong.declaration,
      localObservationObserverOptions: {
        osSeams: { platform: 'darwin', ps: wrong.psSeam, environ: 'present' },
        absenceConfirmation: async () => 'absent',
      },
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 1))),
      now: (() => { let value = 0; let gated = false; return () => {
        if (!gated) { if (phaseThreeObserved) gated = true; else return 0; }
        value += 500;
        return value;
      }; })(),
      wallClockNow: (() => { let value = START_SECOND_MS + 5_000; return () => (value += 500); })(),
      processNonce: TRANSPORT_NONCE,
    });
    const block = held.cleanup.localObservation;
    assert.ok(block);
    assert.ok(block.ancestry, 'the runtime persisted the ancestry join verdict with the block');
    assert.equal(block.ancestry.companionToTransportAttributed, false, 'both hops unestablished → unattributed');
    assert.ok(block.ancestry.hops.some((hop) => hop.hop === 'companion-to-daemon' && hop.status === 'unestablished' && hop.reason === 'daemon-ppid-mismatch-at-capture'), JSON.stringify(block.ancestry.hops));
    assert.ok(block.ancestry.hops.some((hop) => hop.hop === 'daemon-to-transport' && hop.status === 'unestablished' && hop.reason === 'marker-ppid-mismatch-at-capture'), JSON.stringify(block.ancestry.hops));
    assert.equal(block.duties?.settled, false, 'the local duties never settle on unattributed ancestry (the runtime gate)');
    assert.equal(block.duties?.ancestryRefusal, 'ancestry-hops-unattributed', 'the named refusal rides the aggregate (never silently dropped)');
  });

  test('F1 (runtime, keeper): coherent parentage composes an attributed ancestry and the duties settle', async (t) => {
    let phaseThreeObserved = false;
    const coherent = await buildRunner(t, ({ calls }) => {
      if (calls <= 2) return invRow();
      if (calls <= 4) return broRow();
      if (calls <= 6) { if (calls === 6) phaseThreeObserved = true; return traRow(); }
      return undefined;
    });
    const held = await runHeldHostTurn({
      gatePath: 'unused-gate',
      holdMs: 300_000,
      budgetMs: 10_000_000_000,
      launch: async () => ({
        result: new Promise((resolve) => {
          const anchor = setInterval(() => { if (coherent.counter() >= 7) { clearInterval(anchor); resolve({ code: 0, stdout: '', stderr: '' }); } }, 5);
          anchor.unref?.();
          setTimeout(() => { clearInterval(anchor); resolve({ code: 0, stdout: '', stderr: '' }); }, 10_000).unref?.();
        }),
        terminate: async () => {},
      }),
      waitForGate: async () => {},
      captureProcessIdentity: async () => ({ pid: 60300, ppid: 60200, nonce: TRANSPORT_NONCE, startIdentity: TRANSPORT_LSTART, markerEpochMs: MARKER_EPOCH_MS }),
      readProcessIdentity: async () => undefined,
      terminateProcessIdentity: async () => ({ attempted: true, signalled: 'SIGTERM', exited: true, failure: null }),
      waitForProcessExit: async () => {},
      releaseGate: async () => {},
      localObservation: coherent.declaration,
      localObservationObserverOptions: {
        osSeams: { platform: 'darwin', ps: coherent.psSeam, environ: 'present' },
        absenceConfirmation: async () => 'absent',
      },
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 1))),
      now: (() => { let value = 0; let gated = false; return () => {
        if (!gated) { if (phaseThreeObserved) gated = true; else return 0; }
        value += 500;
        return value;
      }; })(),
      wallClockNow: (() => { let value = START_SECOND_MS + 5_000; return () => (value += 500); })(),
      processNonce: TRANSPORT_NONCE,
    });
    const block = held.cleanup.localObservation;
    assert.ok(block);
    assert.ok(block.ancestry, 'the ancestry verdict persisted');
    assert.equal(block.ancestry.companionToTransportAttributed, true, JSON.stringify(block.ancestry.hops));
    assert.equal(block.duties?.settled, true, JSON.stringify(block.duties?.duties));
    assert.equal(block.duties?.ancestryRefusal, undefined, 'no refusal rides an attributed composition');
  });

  test('F4 (preflight): the effective launch environment lacking the capture arming is refused BEFORE the launch', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'local-process-r2-preflight-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const workspace = join(root, 'ws');
    const dataRoot = join(root, 'data-root');
    await mkdir(workspace, { mode: 0o700 });
    await mkdir(dataRoot, { mode: 0o700 });
    const preloadPath = join(root, 'closure-stdout-preload.cjs');
    // (Review round 5, Finding 4) the declared digest derives from the
    // ACTUAL artifact bytes: the on-disk integrity check compares the disk
    // hash with this declaration.
    const preloadSha = createHash('sha256').update('// the executing preload artifact\n').digest('hex');
    await writeFile(preloadPath, '// the executing preload artifact\n', 'utf8');
    const entryRealpath = '/private/tmp/r2-installed/skills/rescue/launcher.mjs';
    const brokerEntryRealpath = '/private/tmp/r2-installed/scripts/zcode-broker.mjs';
    const handle = {
      preloadPath, preloadSha256: preloadSha,
      captureDirectory: join(root, 'stdout-capture'), nonce: 'a'.repeat(64), maxBytes: 65536,
      entryRealpath, brokerEntryRealpath,
    };
    // (Review round 32, Finding 2) the REAL composer creates the capture
    // directory; the helper mirrors it.
    await mkdir(join(root, 'stdout-capture'), { recursive: true, mode: 0o700 });
    const arming = {
      preload: 'closure-stdout-preload.cjs', preloadSha256: preloadSha, maxBytes: 65536,
      gate: { argv: ['invoke-prepared', 'rescue'], declaredEntryRealpathSha256: createHash('sha256').update(entryRealpath).digest('hex') },
      brokerGate: { declaredBrokerEntryRealpathSha256: createHash('sha256').update(brokerEntryRealpath).digest('hex') },
      identityRecord: { version: 2, roles: { invocation: 'identity.json', brokerDaemon: 'identity-broker.json' } },
      environmentVariables: [],
    };
    // (a) The digests agree but the environment carries NONE of the capture
    // arming: the host would launch with NO capture capability.
    const dryEnv = await evaluateLiveLaunchPreflight({
      case: 'rescue-interrupt', survivalControlSelector: null,
      fixture: { workspace, env: { ZCODE_DATA_ROOT: dataRoot }, stdoutCapture: handle, record: { closureStdoutCapture: arming } },
    });
    assert.equal(dryEnv.ok, false, 'a matching-digest handle with a dry environment must refuse');
    assert.match(String(dryEnv.reason), /effective capture environment/iu, dryEnv.reason);
    // (b) NODE_OPTIONS present but LOADING NOTHING: the same refusal.
    const idleOptions = await evaluateLiveLaunchPreflight({
      case: 'rescue-interrupt', survivalControlSelector: null,
      fixture: { workspace, env: { ZCODE_DATA_ROOT: dataRoot, NODE_OPTIONS: '--max-old-space-size=1024' }, stdoutCapture: handle, record: { closureStdoutCapture: arming } },
    });
    assert.equal(idleOptions.ok, false);
    assert.match(String(idleOptions.reason), /effective capture environment/iu, idleOptions.reason);
    // (c) The positive: the composed environment loads THIS declared preload
    // and binds every declared capture variable to the handle.
    const quoted = `"${preloadPath.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    const armed = await evaluateLiveLaunchPreflight({
      case: 'rescue-interrupt', survivalControlSelector: null,
      fixture: {
        workspace, stdoutCapture: handle, record: { closureStdoutCapture: arming },
        env: {
          ZCODE_DATA_ROOT: dataRoot,
          ZCODE_SHELL_WAIT_CAPTURE_DIR: handle.captureDirectory,
          ZCODE_SHELL_WAIT_CAPTURE_NONCE: handle.nonce,
          ZCODE_SHELL_WAIT_CAPTURE_ENTRY_REALPATH: handle.entryRealpath,
          ZCODE_SHELL_WAIT_CAPTURE_MAX_BYTES: String(handle.maxBytes),
          ZCODE_SHELL_WAIT_CAPTURE_BROKER_ENTRY_REALPATH: handle.brokerEntryRealpath,
          NODE_OPTIONS: `--require ${quoted}`,
        },
      },
    });
    assert.deepEqual(armed, { ok: true, reason: null }, armed.reason);
  });
});

describe('local-settlement task 3 review round 3 (one P1 + four P2): the transport inspector verifies its OWN nonce variable; the ancestry endpoints refresh after the downstream startup; the replay re-verifies the admissions, the ancestry chain and the generation-change reads', async () => {
  const { runHeldHostTurn } = await import('../tools/shell-wait-probe/driver.mjs');
  const { IDENTITY_RECORD_VERSION } = await import('../tools/shell-wait-probe/closure-preload.mjs');
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { createHash } = await import('node:crypto');
  const sha = (v) => createHash('sha256').update(v).digest('hex');

  const CAPTURE_NONCE = 'a'.repeat(64);
  const TRANSPORT_NONCE = 'f'.repeat(64);
  const START_SECOND_MS = Date.parse('2026-10-01T00:00:01Z');
  /** The C-locale UTC text of the wall-clock second containing `ms`. */
  const utcSecondText = (ms) => {
    const d = new Date(Math.floor(ms / 1000) * 1000);
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const day = d.getUTCDate();
    return `${days[d.getUTCDay()]} ${months[d.getUTCMonth()]} ${(day < 10 ? ' ' : '') + day} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}:${String(d.getUTCSeconds()).padStart(2, '0')} ${d.getUTCFullYear()}`;
  };

  /**
   * The runtime harness with the FAITHFUL environment shape: the ps eww
   * command column carries BOTH nonce variables with their OWN values (the
   * capture scope nonce and the transport's OWN declared nonce), the rows
   * claim their own read-time creation seconds, and the downstream spawns
   * are delayed (the transport's first read at ~+2.2 s) so the early
   * endpoints genuinely cannot cover the downstream creation.
   */
  const buildRunner = async (t, overrides = {}) => {
    const root = await mkdtemp(join(tmpdir(), 'local-process-r3-runtime-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const installed = join(root, 'installed');
    const captureDirectory = join(root, 'capture');
    const launcherPath = join(installed, 'skills', 'rescue', 'launcher.mjs');
    const brokerPath = join(installed, 'scripts', 'zcode-broker.mjs');
    await mkdir(captureDirectory, { mode: 0o700 });
    await mkdir(join(installed, 'skills', 'rescue'), { recursive: true });
    await mkdir(join(installed, 'scripts'), { recursive: true });
    await writeFile(launcherPath, '// stand-in launcher\n', 'utf8');
    await writeFile(brokerPath, '// stand-in broker entry\n', 'utf8');
    const t0 = Date.now();
    // The rows claim FIXED creation seconds relative to the turn start (the
    // production spawn choreography): the Companion started ~100 ms before
    // its phase-2 read; the daemon spawned ~1.9 s later (its claimed start
    // second is ≥ 2 s after the Companion's — Lifetime the early read can
    // never cover, always before the refreshed one); the transport ~2.5 s.
    const companionSecond = Math.floor((t0 - 100) / 1000) * 1000;
    const daemonSecond = Math.floor((t0 + 1_900) / 1000) * 1000;
    const transportSecond = Math.floor((t0 + 2_500) / 1000) * 1000;
    const invocationRecord = {
      version: IDENTITY_RECORD_VERSION, role: 'invocation', nonce: CAPTURE_NONCE,
      entryRealpath: launcherPath, argv: ['invoke-prepared', 'rescue'],
      pid: 60100, ppid: 600,
      firstWriteEpochMs: companionSecond + 80, startOriginMs: companionSecond + 50, firstWritePreciseMs: companionSecond + 80.5,
    };
    const brokerRecord = {
      version: IDENTITY_RECORD_VERSION, role: 'broker-daemon', nonce: CAPTURE_NONCE,
      entryRealpath: brokerPath, configRealpathSha256: sha(join(root, 'config')),
      pid: 60200, ppid: 60100,
      firstWriteEpochMs: daemonSecond + 470, startOriginMs: daemonSecond + 450, firstWritePreciseMs: daemonSecond + 470.5,
    };
    await writeFile(join(captureDirectory, `${CAPTURE_NONCE}.identity.json`), JSON.stringify(invocationRecord), { mode: 0o600 });
    await writeFile(join(captureDirectory, `${CAPTURE_NONCE}.identity-broker.json`), JSON.stringify(brokerRecord), { mode: 0o600 });
    const declaration = { captureDirectory, nonce: CAPTURE_NONCE, entryRealpath: launcherPath, brokerEntryRealpath: brokerPath };
    /** @type {Map<number, number>} */
    const pidCalls = new Map();
    let phaseThree = false;
    let phaseFourAbsence = false;
    // The rows claim FIXED creation seconds relative to the turn start (the
    // production spawn choreography): the Companion started ~100 ms before
    // its phase-2 read; the daemon spawned with its claimed start second ≥
    // Companion start + 2 s (the early read can never cover it — always
    // before the refreshed one); the transport ~2.5 s.
    const rowFor = (pid) => ({
      pid,
      ppid: pid === 60100 ? 600 : pid === 60200 ? (overrides.brokerParentPid ?? 60100) : (overrides.markerParentPid ?? 60200),
      lstart: utcSecondText(pid === 60100 ? companionSecond : pid === 60200 ? daemonSecond : transportSecond),
    });
    const psSeam = async (/** @type {any} */ queriedPid) => {
      const pid = typeof queriedPid === 'number' ? queriedPid : (typeof queriedPid === 'object' && queriedPid !== null ? queriedPid.pid : 0);
      const calls = (pidCalls.get(pid) ?? 0) + 1;
      pidCalls.set(pid, calls);
      if (pid === 60100) {
        if (calls <= 2) return rowFor(60100);
        // The ancestry's REFRESHED companion read (calls 3-4).
        if (calls <= 4) return rowFor(60100);
        // The phase-4 absence read (call 5+): the real 30 ms delay, then the
        // no-process answer.
        await new Promise((resolve) => setTimeout(resolve, 30));
        return undefined;
      }
      if (pid === 60200) {
        // The daemon is not observable until AFTER its claimed creation
        // second's record write (the record's claimed precise start is
        // daemonSecond+450): the first read waits real time — the early
        // Companion read can never cover this daemon.
        if (calls === 1) {
          const waitMs = daemonSecond + 700 - Date.now();
          if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(waitMs, 2_500)));
        }
        return rowFor(60200);
      }
      if (pid === 60300) {
        // The transport spawns after the daemon (its marker write instant is
        // daemonSecond+1300): the FIRST read waits real time past the marker
        // and the hop lifetime bounds. The phase-3 signal fires at the FIRST
        // read's RESOLUTION — the nonce verification may refuse the read
        // entirely (the faithful-env RED shape), and the hold clock must
        // never deadlock on a refused read.
        if (calls === 1) {
          const waitMs = Math.max(daemonSecond + 2_050, t0 + 2_700) - Date.now();
          if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(waitMs, 3_500)));
          phaseThree = true;
        }
        if (calls === 2) phaseThree = true;
        return rowFor(60300);
      }
      return undefined;
    };
    // THE FAITHFUL environment read: the ps eww command column carries BOTH
    // nonce variables with their OWN values — the capture scope's nonce for
    // the capture variable, the transport's OWN declared nonce for
    // FAKE_ZCODE_PROCESS_NONCE.
    const runProcessSeam = async (launch) => {
      const args = Array.isArray(launch?.args) ? launch.args.join(' ') : '';
      if (args.includes('eww')) {
        return { code: 0, stdout: `node ${launcherPath} invoke-prepared rescue ZCODE_SHELL_WAIT_CAPTURE_NONCE=${CAPTURE_NONCE} FAKE_ZCODE_PROCESS_NONCE=${TRANSPORT_NONCE}\n`, stderr: '' };
      }
      // The lstart rows: "<pid> <ppid> <lstart text>".
      const pid = Number(/-p\s+(\d+)/u.exec(args)?.[1] ?? 0);
      const row = rowFor(pid);
      return { code: 0, stdout: `${row.pid} ${row.ppid} ${row.lstart}\n`, stderr: '' };
    };
    return {
      root, declaration, psSeam, runProcessSeam, t0,
      // The marker's OWN write instant: after the daemon's claimed creation
      // second (+1000 lifetime bound) and before the refreshed daemon read.
      markerEpochMs: Math.max(t0 + 2_600, daemonSecond + 1_200),
      flags: { get phaseThree() { return phaseThree; }, get phaseFourAbsence() { return phaseFourAbsence; }, markAbsence: () => { phaseFourAbsence = true; } },
      pidCalls,
    };
  };

  const runTurn = (runner) => runHeldHostTurn({
    gatePath: 'unused-gate',
    holdMs: 300_000,
    budgetMs: 10_000_000_000,
    measurementCutoffSchedule: true,
    launch: async () => ({
      result: new Promise((resolve) => {
        const anchor = setInterval(() => {
          if (runner.flags.phaseFourAbsence) { clearInterval(anchor); resolve({ code: 0, stdout: '', stderr: '' }); }
        }, 5);
        anchor.unref?.();
        setTimeout(() => { clearInterval(anchor); resolve({ code: 0, stdout: '', stderr: '' }); }, 10_000).unref?.();
      }),
      terminate: async () => {},
    }),
    waitForGate: async () => {},
    // The marker's OWN write instant: T0+2600 — after the daemon's claimed
    // creation second (+1000 bound) and before the refreshed daemon read.
    captureProcessIdentity: async () => ({ pid: 60300, ppid: 60200, nonce: TRANSPORT_NONCE, startIdentity: utcSecondText(runner.t0 + 2_500), markerEpochMs: runner.markerEpochMs }),
    readProcessIdentity: async () => undefined,
    terminateProcessIdentity: async () => ({ attempted: true, signalled: 'SIGTERM', exited: true, failure: null }),
    waitForProcessExit: async () => {},
    releaseGate: async () => {},
    localObservation: runner.declaration,
    localObservationObserverOptions: {
      osSeams: { platform: 'darwin', ps: runner.psSeam, runProcess: runner.runProcessSeam },
      absenceConfirmation: async () => { runner.flags.markAbsence(); return 'absent'; },
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5))),
    now: (() => { let value = 0; let gated = false; return () => {
      if (!gated) { if (runner.flags.phaseThree) gated = true; else return 0; }
      value += 500;
      return value;
    }; })(),
    processNonce: TRANSPORT_NONCE,
  });

  test('F1 (P1): the transport observation verifies its OWN declared nonce variable (FAKE_ZCODE_PROCESS_NONCE) through the faithful environment', async (t) => {
    const runner = await buildRunner(t);
    const held = await runTurn(runner);
    const block = held.cleanup.localObservation;
    assert.ok(block, 'the block persisted');
    // The transport was observed ALIVE through the REAL inspector reading the
    // FAITHFUL env: its own declared nonce variable, not the capture scope's.
    assert.equal(block.transportObservation?.status, 'established',
      `the transport observation establishes through its own nonce variable (actual ${block.transportObservation?.status} ${block.transportObservation?.reason ?? ''})`);
    const transportDuty = (block.duties?.duties ?? []).find((duty) => duty.duty === 'transport-descendant');
    assert.equal(transportDuty?.status, 'established', `the transport duty establishes (actual ${transportDuty?.status} ${JSON.stringify(transportDuty?.reasons ?? [])})`);
  });

  test('F2 (P2): the ancestry endpoints REFRESH after the downstream startup — the early Companion sample can never cover a late-spawning daemon', async (t) => {
    const runner = await buildRunner(t);
    const held = await runTurn(runner);
    const block = held.cleanup.localObservation;
    assert.ok(block);
    // The refreshed endpoint observations persist with the block (the early
    // presence baseline stays the pre-launch witness).
    assert.ok(block.ancestryEndpoints, 'the refreshed ancestry endpoints persist with the block');
    assert.equal(block.ancestryEndpoints.companion?.status, 'established', 'the refreshed companion endpoint established');
    assert.equal(block.ancestryEndpoints.daemon?.status, 'established', 'the refreshed daemon endpoint established');
    assert.ok(block.ancestryEndpoints.companion.readEpochMs > START_SECOND_MS + 2_000,
      `the refreshed companion read covers the daemon's claimed creation (${block.ancestryEndpoints.companion.readEpochMs} > start+2000)`);
    assert.equal(block.ancestry.companionToTransportAttributed, true, JSON.stringify(block.ancestry.hops));
    assert.equal(block.duties?.settled, true, 'the duties settle on the refreshed-endpoint ancestry');
  });
});

describe('local-settlement task 3 review round 3 (four P2): the offline join re-verifies the persisted ADMISSIONS, the NAMED ancestry hops + ppid chain and the generation-change reads', async () => {
  const { nativeInterruptionGateDInput } = await import('../tools/shell-wait-probe/driver.mjs');
  const { evaluateNativeInterruptionSettlement } = await import('../tools/shell-wait-probe/release-qualification.mjs');
  const { createHash } = await import('node:crypto');
  const sha = (v) => createHash('sha256').update(v).digest('hex');
  const MEASUREMENT_CUTOFF_AT_MS = 20_000;

  /** The coherent armed positive for the replay re-verification battery: the
   * full persisted block — admissions, observations, refreshed ancestry
   * endpoints, named hops, duties, exit, confirmed-absence read. */
  const armReplay = () => {
    const scopeNonce = 'a'.repeat(64);
    const transport = 'f'.repeat(64);
    const observation = (pid, ppid, startIdentity, scope, readStarted, identityRead, readEpoch, startInstant = 1000) => ({
      localProcessObservationVersion: 1, class: 'os-live-observation', status: 'established', reason: null,
      observation: { pid, ppid, startIdentity, startInstantEpochMs: startInstant, ppidChangedFromCapture: null, nonceSha256: scope },
      queried: { pid, nonceSha256: scope },
      readStartedEpochMs: readStarted, identityReadEpochMs: identityRead, readEpochMs: readEpoch,
      absenceConfirmed: null,
    });
    const block = {
      version: 1, armed: true, clock: 'wall-epoch-ms', nonceSha256: sha(scopeNonce),
      admission: { localProcessObservationVersion: 1, class: 'startup-identity', status: 'established', reason: null, identity: { role: 'invocation', argv: ['invoke-prepared', 'rescue'], entryRealpathSha256: sha('launcher-entry'), pid: 60100, ppid: 600, firstWriteEpochMs: 1000, startOriginMs: 1000.1, firstWritePreciseMs: 1100.5, nonceSha256: sha(scopeNonce) }, readStartedEpochMs: 1000, readEpochMs: 1100 },
      presence: observation(60100, 600, 'S-COMPANION', sha(scopeNonce), 1900, 2100, 2300),
      brokerAdmission: { localProcessObservationVersion: 1, class: 'startup-identity', status: 'established', reason: null, identity: { role: 'broker-daemon', entryRealpathSha256: sha('broker-entry'), pid: 60200, ppid: 60100, firstWriteEpochMs: 3000, startOriginMs: 3000.2, firstWritePreciseMs: 3100.6, nonceSha256: sha(scopeNonce) }, readStartedEpochMs: 1900, readEpochMs: 2100 },
      brokerObservation: observation(60200, 60100, 'S-DAEMON', sha(scopeNonce), 3300, 3400, 3500, 3000),
      transportObservation: observation(60300, 60200, 'S-TRANSPORT', sha(transport), 2000, 2200, 2500, 5000),
      ancestryEndpoints: {
        companion: observation(60100, 600, 'S-COMPANION', sha(scopeNonce), 4600, 4650, 4700, 1000),
        daemon: observation(60200, 60100, 'S-DAEMON', sha(scopeNonce), 4600, 4650, 4750, 3000),
        transportMarker: { pid: 60300, ppid: 60200, nonceSha256: sha(transport), markerEpochMs: 4450 },
      },
      ancestry: { localProcessObservationVersion: 1, class: 'ancestry-join', nonceSha256: sha(scopeNonce), companionToTransportAttributed: true, hops: [
        { hop: 'companion-to-daemon', status: 'established', reason: null },
        { hop: 'daemon-to-transport', status: 'established', reason: null },
      ] },
      duties: { localProcessObservationVersion: 1, class: 'local-duty-verdict', settled: true, duties: [
        { duty: 'invocation-process', status: 'established', reasons: [], identity: { pid: 60100, startIdentity: 'S-COMPANION', nonceSha256: sha(scopeNonce) } },
        { duty: 'broker-daemon', status: 'established', reasons: [], identity: { pid: 60200, startIdentity: 'S-DAEMON', nonceSha256: sha(scopeNonce) } },
        { duty: 'transport-descendant', status: 'established', reasons: [], identity: { pid: 60300, startIdentity: 'S-TRANSPORT', nonceSha256: sha(transport) } },
      ] },
      transportExit: { localProcessObservationVersion: 1, class: 'os-live-observation', status: 'absent', reason: 'no-such-process', observation: null, queried: { pid: 60300, nonceSha256: sha(transport) }, readStartedEpochMs: 5200, identityReadEpochMs: 5250, readEpochMs: 5300, absenceConfirmed: true },
      reads: [{ localProcessObservationVersion: 1, class: 'os-live-observation', status: 'absent', reason: 'no-such-process', observation: null, queried: { pid: 60100, nonceSha256: sha(scopeNonce) }, readStartedEpochMs: 4900, readEpochMs: 5100, absenceConfirmed: true }],
      exit: { localProcessObservationVersion: 1, class: 'exit-absence', status: 'disappeared', reason: null, boundIdentity: { pid: 60100, startIdentity: 'S-COMPANION', nonceSha256: sha(scopeNonce) }, lastVerifiedPresenceEpochMs: 2100, firstVerifiedAbsenceEpochMs: 5100, exitCorroboratedByMeta: false },
      stoppedAt: null, fenceAtMs: null, cutoffAtMs: MEASUREMENT_CUTOFF_AT_MS, cleanupBoundaryAtMs: null, composedAtMs: 6000,
    };
    const record = (over = {}) => ({
      status: 'executed', case: 'rescue-interrupt', executedAt: '2026-10-30T00:00:00.000Z',
      interrupt: { measurementCutoffAtMs: MEASUREMENT_CUTOFF_AT_MS },
      stdoutCaptureDeclaration: {
        preload: 'closure-observe.mjs', preloadSha256: sha('preload-bytes'), maxBytes: 65536,
        gate: { argv: ['invoke-prepared', 'rescue'], declaredEntryRealpathSha256: sha('launcher-entry') },
        brokerGate: { declaredBrokerEntryRealpathSha256: sha('broker-entry') },
        identityRecord: { version: 2, roles: { invocation: 'identity.json', brokerDaemon: 'identity-broker.json' } },
        environmentVariables: [],
      },
      observations: {}, child: {},
      localProcess: block,
      ...over,
    });
    return { scopeNonce, transport, block, record };
  };
  const cleanCopy = (base) => JSON.parse(JSON.stringify(base));

  test('F3 (P2) RED → a positive record with BOTH startup admissions DELETED is refused by name (never trusted to have had them)', () => {
    const g = armReplay();
    const stripped = cleanCopy(g.record());
    delete stripped.localProcess.admission;
    delete stripped.localProcess.brokerAdmission;
    const consolidated = nativeInterruptionGateDInput(stripped).localProcessDuties;
    assert.equal(consolidated.settled, false, 'an admission-less record never replays as settled');
    for (const named of ['inline-admission-invocation-unpersisted', 'inline-admission-broker-unpersisted']) {
      assert.ok(consolidated.refusals.includes(named), `${named} missing from ${JSON.stringify(consolidated.refusals)}`);
    }
    const verdict = evaluateNativeInterruptionSettlement(nativeInterruptionGateDInput(stripped));
    assert.equal(verdict.qualified, false, 'the oracle refuses the local layer');
  });

  test('F3 (P2) RED → an admission whose evidence completes AT/AFTER the cutoff never carries pre-fence credit', () => {
    const g = armReplay();
    const late = cleanCopy(g.record());
    late.localProcess.admission.readEpochMs = MEASUREMENT_CUTOFF_AT_MS + 5_000;
    const consolidated = nativeInterruptionGateDInput(late).localProcessDuties;
    assert.equal(consolidated.settled, false);
    assert.ok(consolidated.refusals.includes('admission-at-or-after-fence'), JSON.stringify(consolidated.refusals));
  });

  test('F4 (P2) RED → attributed:true with a MISSING NAMED hop is refused (the serialized boolean alone never credits)', () => {
    const g = armReplay();
    const torn = cleanCopy(g.record());
    torn.localProcess.ancestry.hops = [{ hop: 'companion-to-daemon', status: 'established', reason: null }];
    const consolidated = nativeInterruptionGateDInput(torn).localProcessDuties;
    assert.equal(consolidated.settled, false);
    assert.ok(consolidated.refusals.includes('ancestry-hops-unattributed'), JSON.stringify(consolidated.refusals));
  });

  test('F4 (P2) RED → attributed:true with the refreshed ENDPOINT markers missing/malformed is refused by name', () => {
    const g = armReplay();
    const torn = cleanCopy(g.record());
    delete torn.localProcess.ancestryEndpoints;
    const consolidated = nativeInterruptionGateDInput(torn).localProcessDuties;
    assert.equal(consolidated.settled, false);
    assert.ok(consolidated.refusals.includes('ancestry-endpoints-unpersisted'), JSON.stringify(consolidated.refusals));
  });

  test('F4 (P2) RED → the hops claim established but NO persisted piece proves the capture-time parent (a foreign broker parent in BOTH the record and the observation) is refused by name', () => {
    const g = armReplay();
    const torn = cleanCopy(g.record());
    // (Review round 8, Finding 3) the OS-observed ppid and the admitted
    // record's ppid are EQUIVALENT capture-time evidence — the chain is
    // foreign only when NEITHER proves the Companion's parentage.
    torn.localProcess.brokerObservation.observation.ppid = 60999;
    torn.localProcess.brokerAdmission.identity.ppid = 60999;
    const consolidated = nativeInterruptionGateDInput(torn).localProcessDuties;
    assert.equal(consolidated.settled, false);
    assert.ok(consolidated.refusals.includes('ancestry-ppid-chain-foreign'), JSON.stringify(consolidated.refusals));
  });

  test('F4 (P2) RED → an ancestry ENDPOINT describing a FOREIGN generation is refused by name (the refreshed reads bind to the same duties)', () => {
    const g = armReplay();
    const torn = cleanCopy(g.record());
    torn.localProcess.ancestryEndpoints.companion.observation.startIdentity = 'S-FOREIGN';
    const consolidated = nativeInterruptionGateDInput(torn).localProcessDuties;
    assert.equal(consolidated.settled, false);
    assert.ok(consolidated.refusals.includes('ancestry-endpoint-generation-foreign'), JSON.stringify(consolidated.refusals));
  });

  test('F5 (P2) RED → a persisted start-identity GENERATION CHANGE (established, named and carried shapes) never lets the exit credit the original disappearance', () => {
    const g = armReplay();
    const reused = cleanCopy(g.record());
    reused.localProcess.reads.push({
      localProcessObservationVersion: 1, class: 'os-live-observation', status: 'established', reason: null,
      observation: { pid: 60100, ppid: 600, startIdentity: 'S-REUSE', startInstantEpochMs: 4000, ppidChangedFromCapture: null, nonceSha256: sha(g.scopeNonce) },
      queried: { pid: 60100, nonceSha256: sha(g.scopeNonce) },
      readStartedEpochMs: 4900, identityReadEpochMs: 4950, readEpochMs: 5050, absenceConfirmed: null,
    });
    let consolidated = nativeInterruptionGateDInput(reused).localProcessDuties;
    assert.equal(consolidated.settled, false, 'a same-scope successor read latches the reuse');
    assert.ok(consolidated.refusals.includes('exit-reuse-latched'), JSON.stringify(consolidated.refusals));
    assert.ok(!consolidated.refusals.includes('exit-absence-superseded'), JSON.stringify(consolidated.refusals));
    const named = cleanCopy(g.record());
    named.localProcess.reads.push({
      localProcessObservationVersion: 1, class: 'os-live-observation', status: 'unestablished', reason: 'start-identity-generation-changed',
      observation: null, queried: { pid: 60100, nonceSha256: sha(g.scopeNonce) },
      readStartedEpochMs: 4900, identityReadEpochMs: 4950, readEpochMs: 5050, absenceConfirmed: null,
    });
    consolidated = nativeInterruptionGateDInput(named).localProcessDuties;
    assert.equal(consolidated.settled, false);
    assert.ok(consolidated.refusals.includes('exit-reuse-latched'), JSON.stringify(consolidated.refusals));
    const carried = cleanCopy(g.record());
    carried.localProcess.reads.push({
      localProcessObservationVersion: 1, class: 'os-live-observation', status: 'unestablished', reason: 'nonce-mismatch-observed-then-gone',
      observedStartIdentity: 'S-REUSE',
      observation: null, queried: { pid: 60100, nonceSha256: sha(g.scopeNonce) },
      readStartedEpochMs: 4900, identityReadEpochMs: 4950, readEpochMs: 5050, absenceConfirmed: null,
    });
    consolidated = nativeInterruptionGateDInput(carried).localProcessDuties;
    assert.equal(consolidated.settled, false);
    assert.ok(consolidated.refusals.includes('exit-reuse-latched'), JSON.stringify(consolidated.refusals));
  });
});

describe('local-settlement task 3 review round 4 (four P2): the replay re-adjudicates the admission generations and the ancestry endpoint lifetimes; the runtime bounds in-flight operations by the shared abort; the persisted endpoints are the selected ones', async () => {
  const { runHeldHostTurn, nativeInterruptionGateDInput, NATIVE_INTERRUPTION_GATE_D_JOIN_VERSION } = await import('../tools/shell-wait-probe/driver.mjs');
  const { createHash } = await import('node:crypto');
  const sha = (v) => createHash('sha256').update(v).digest('hex');
  const MEASUREMENT_CUTOFF_AT_MS = 20_000;

  /** The coherent armed positive for the round-4 replay battery: the
   * lifetime-consistent refreshed endpoints (the Companion's second precedes
   * the daemon's by ≥ the uniform bound; the marker's write instant sits in
   * (daemonStart + bound, daemonRead]) with the marker's OWN persisted
   * epoch. */
  const armRound4 = () => {
    const scopeNonce = 'a'.repeat(64);
    const transport = 'f'.repeat(64);
    const observation = (pid, ppid, startIdentity, startInstant, scope, readStarted, identityRead, readEpoch) => ({
      localProcessObservationVersion: 1, class: 'os-live-observation', status: 'established', reason: null,
      observation: { pid, ppid, startIdentity, startInstantEpochMs: startInstant, ppidChangedFromCapture: null, nonceSha256: scope },
      queried: { pid, nonceSha256: scope },
      readStartedEpochMs: readStarted, identityReadEpochMs: identityRead, readEpochMs: readEpoch,
      absenceConfirmed: null,
    });
    const block = {
      version: 1, armed: true, clock: 'wall-epoch-ms', nonceSha256: sha(scopeNonce),
      admission: { localProcessObservationVersion: 1, class: 'startup-identity', status: 'established', reason: null, identity: { role: 'invocation', argv: ['invoke-prepared', 'rescue'], entryRealpathSha256: sha('launcher-entry'), pid: 60100, ppid: 600, firstWriteEpochMs: 1000, startOriginMs: 1000.1, firstWritePreciseMs: 1100.5, nonceSha256: sha(scopeNonce) }, readStartedEpochMs: 1000, readEpochMs: 1100 },
      presence: observation(60100, 600, 'S-COMPANION', 1000, sha(scopeNonce), 1900, 2100, 2300),
      brokerAdmission: { localProcessObservationVersion: 1, class: 'startup-identity', status: 'established', reason: null, identity: { role: 'broker-daemon', entryRealpathSha256: sha('broker-entry'), pid: 60200, ppid: 60100, firstWriteEpochMs: 3000, startOriginMs: 3000.2, firstWritePreciseMs: 3100.6, nonceSha256: sha(scopeNonce) }, readStartedEpochMs: 1900, readEpochMs: 2100 },
      brokerObservation: observation(60200, 60100, 'S-DAEMON', 3000, sha(scopeNonce), 2000, 2200, 2400),
      transportObservation: observation(60300, 60200, 'S-TRANSPORT', 5000, sha(transport), 2000, 2200, 2500),
      ancestryEndpoints: {
        companion: observation(60100, 600, 'S-COMPANION', 1000, sha(scopeNonce), 4600, 4650, 4700),
        daemon: observation(60200, 60100, 'S-DAEMON', 3000, sha(scopeNonce), 4600, 4650, 4750),
        transportMarker: { pid: 60300, ppid: 60200, nonceSha256: sha(transport), markerEpochMs: 4450 },
      },
      ancestry: { localProcessObservationVersion: 1, class: 'ancestry-join', nonceSha256: sha(scopeNonce), companionToTransportAttributed: true, hops: [
        { hop: 'companion-to-daemon', status: 'established', reason: null },
        { hop: 'daemon-to-transport', status: 'established', reason: null },
      ] },
      duties: { localProcessObservationVersion: 1, class: 'local-duty-verdict', settled: true, duties: [
        { duty: 'invocation-process', status: 'established', reasons: [], identity: { pid: 60100, startIdentity: 'S-COMPANION', nonceSha256: sha(scopeNonce) } },
        { duty: 'broker-daemon', status: 'established', reasons: [], identity: { pid: 60200, startIdentity: 'S-DAEMON', nonceSha256: sha(scopeNonce) } },
        { duty: 'transport-descendant', status: 'established', reasons: [], identity: { pid: 60300, startIdentity: 'S-TRANSPORT', nonceSha256: sha(transport) } },
      ] },
      transportExit: { localProcessObservationVersion: 1, class: 'os-live-observation', status: 'absent', reason: 'no-such-process', observation: null, queried: { pid: 60300, nonceSha256: sha(transport) }, readStartedEpochMs: 5200, identityReadEpochMs: 5250, readEpochMs: 5300, absenceConfirmed: true },
      reads: [{ localProcessObservationVersion: 1, class: 'os-live-observation', status: 'absent', reason: 'no-such-process', observation: null, queried: { pid: 60100, nonceSha256: sha(scopeNonce) }, readStartedEpochMs: 4900, readEpochMs: 5100, absenceConfirmed: true }],
      exit: { localProcessObservationVersion: 1, class: 'exit-absence', status: 'disappeared', reason: null, boundIdentity: { pid: 60100, startIdentity: 'S-COMPANION', nonceSha256: sha(scopeNonce) }, lastVerifiedPresenceEpochMs: 2100, firstVerifiedAbsenceEpochMs: 5100, exitCorroboratedByMeta: false },
      stoppedAt: null, fenceAtMs: null, cutoffAtMs: MEASUREMENT_CUTOFF_AT_MS, cleanupBoundaryAtMs: null, composedAtMs: 6000,
    };
    const record = (over = {}) => ({
      status: 'executed', case: 'rescue-interrupt', executedAt: '2026-10-30T00:00:00.000Z',
      interrupt: { measurementCutoffAtMs: MEASUREMENT_CUTOFF_AT_MS },
      stdoutCaptureDeclaration: {
        preload: 'closure-observe.mjs', preloadSha256: sha('preload-bytes'), maxBytes: 65536,
        gate: { argv: ['invoke-prepared', 'rescue'], declaredEntryRealpathSha256: sha('launcher-entry') },
        brokerGate: { declaredBrokerEntryRealpathSha256: sha('broker-entry') },
        identityRecord: { version: 2, roles: { invocation: 'identity.json', brokerDaemon: 'identity-broker.json' } },
        environmentVariables: [],
      },
      observations: {}, child: {},
      localProcess: block,
      ...over,
    });
    return { scopeNonce, transport, block, record };
  };
  const cleanCopy = (base) => JSON.parse(JSON.stringify(base));

  test('F1 (P2) RED → a replay admission whose STARTUP GENERATION contradicts its OS observation is refused by name (the frozen containment rule re-applied)', () => {
    const g = armRound4();
    const torn = cleanCopy(g.record());
    torn.localProcess.admission.identity.startOriginMs = 19_000;
    torn.localProcess.admission.identity.firstWritePreciseMs = 19_001;
    const consolidated = nativeInterruptionGateDInput(torn).localProcessDuties;
    assert.equal(consolidated.settled, false, 'the serialized established flag never overrules the frozen generation rule');
    assert.ok(consolidated.refusals.includes('admission-start-mismatch'), JSON.stringify(consolidated.refusals));
  });

  test('F1 (P2) RED → a replay admission whose OS observation PREDATES the record writer is refused (the frozen freshness rule re-applied)', () => {
    const g = armRound4();
    const torn = cleanCopy(g.record());
    torn.localProcess.presence.identityReadEpochMs = 500;
    const consolidated = nativeInterruptionGateDInput(torn).localProcessDuties;
    assert.equal(consolidated.settled, false);
    assert.ok(consolidated.refusals.includes('admission-observation-stale'), JSON.stringify(consolidated.refusals));
  });

  test('F2 (P2) RED → an ancestry ENDPOINT completing at/after the cutoff never credits the hops', () => {
    const g = armRound4();
    const torn = cleanCopy(g.record());
    torn.localProcess.ancestryEndpoints.companion.readEpochMs = MEASUREMENT_CUTOFF_AT_MS + 5_000;
    const consolidated = nativeInterruptionGateDInput(torn).localProcessDuties;
    assert.equal(consolidated.settled, false);
    assert.ok(consolidated.refusals.includes('observation-at-or-after-fence'), JSON.stringify(consolidated.refusals));
  });

  test('F2 (P2) RED → an ancestry endpoint whose creation CONTRADICTS the hop lifetime window is refused (the frozen lifetime rules re-applied)', () => {
    const g = armRound4();
    const torn = cleanCopy(g.record());
    torn.localProcess.ancestryEndpoints.daemon.observation.startInstantEpochMs = 30_000;
    const consolidated = nativeInterruptionGateDInput(torn).localProcessDuties;
    assert.equal(consolidated.settled, false);
    assert.ok(consolidated.refusals.includes('ancestry-endpoint-lifetime-unverifiable'), JSON.stringify(consolidated.refusals));
  });

  test('F2 (P2) RED → a transport marker WITHOUT its persisted write instant can never credit the daemon→transport hop (fail-closed for pre-round-4 blocks)', () => {
    const g = armRound4();
    const torn = cleanCopy(g.record());
    delete torn.localProcess.ancestryEndpoints.transportMarker.markerEpochMs;
    const consolidated = nativeInterruptionGateDInput(torn).localProcessDuties;
    assert.equal(consolidated.settled, false);
    assert.ok(consolidated.refusals.includes('ancestry-endpoints-unpersisted'), JSON.stringify(consolidated.refusals));
  });

  test('F3 (P2) RED → an in-flight local observation cannot extend the turn past the shared budget; the unfinished observation is the NAMED fact', async () => {
    const CAPTURE_NONCE = 'c'.repeat(64);
    const TRANSPORT_NONCE = '9'.repeat(64);
    const ENTRY = '/private/tmp/fixture-installed/skills/rescue/launcher.mjs';
    const BROKER_ENTRY = '/private/tmp/fixture-installed/scripts/zcode-broker.mjs';
    const declaration = { captureDirectory: '/private/tmp/fixture-capture-r4', nonce: CAPTURE_NONCE, entryRealpath: ENTRY, brokerEntryRealpath: BROKER_ENTRY };
    const admissionEstablished = () => ({
      localProcessObservationVersion: 1, class: 'startup-identity', status: 'established', reason: null,
      identity: { role: 'invocation', nonce: CAPTURE_NONCE, entryRealpath: ENTRY, argv: ['invoke-prepared', 'rescue'], pid: 60100, ppid: 600, firstWriteEpochMs: 1000, startOriginMs: 1000.1, firstWritePreciseMs: 1100.5 },
      readStartedEpochMs: 1000, readEpochMs: 1100,
    });
    const osEstablished = (pid, startIdentity, nonce) => ({
      localProcessObservationVersion: 1, class: 'os-live-observation', status: 'established', reason: null,
      observation: { pid, ppid: 600, startIdentity, nonce, startInstantEpochMs: 1000, ppidChangedFromCapture: null },
      queried: { pid, nonce }, readStartedEpochMs: 1100, identityReadEpochMs: 1150, readEpochMs: 1200, absenceConfirmed: null,
    });
    const t0ms = Date.now();
    const held = await runHeldHostTurn({
      gatePath: 'unused-gate',
      holdMs: 300_000,
      budgetMs: 100,
      launch: async () => ({
        result: new Promise((resolve) => { const anchor = setInterval(() => { clearInterval(anchor); resolve({ code: 0, stdout: '', stderr: '' }); }, 40); anchor.unref?.(); }),
        terminate: async () => {},
      }),
      waitForGate: async () => {},
      captureProcessIdentity: async () => ({ pid: 60300, ppid: 60100, nonce: TRANSPORT_NONCE, startIdentity: 'S-TRANSPORT' }),
      readProcessIdentity: async () => undefined,
      terminateProcessIdentity: async () => ({ attempted: true, signalled: 'SIGTERM', exited: true, failure: null }),
      waitForProcessExit: async () => {},
      releaseGate: async () => {},
      localObservation: declaration,
      // The invocation admission is STILL IN FLIGHT when the shared budget
      // expires (the 1.2 s op vs the 100 ms budget): the turn must never
      // wait for it — the runtime settles it with the NAMED
      // unfinished-observation fact instead.
      captureLocalObservationIdentity: async () => { await new Promise((resolve) => setTimeout(resolve, 1_200)); return admissionEstablished(); },
      observeLocalObservationIdentity: async () => osEstablished(60100, 'S-COMPANION', CAPTURE_NONCE),
      captureLocalBrokerObservationIdentity: async () => ({ ...admissionEstablished(), identity: { role: 'broker-daemon', nonce: CAPTURE_NONCE, entryRealpath: BROKER_ENTRY, configRealpathSha256: 'b'.repeat(64), pid: 60200, ppid: 60100, firstWriteEpochMs: 1000, startOriginMs: 1000.2, firstWritePreciseMs: 1100.6 } }),
      observeLocalBrokerObservationIdentity: async () => osEstablished(60200, 'S-DAEMON', CAPTURE_NONCE),
      observeLocalTransportObservationIdentity: async () => osEstablished(60300, 'S-TRANSPORT', TRANSPORT_NONCE),
      // A REAL (5-ms-capped) sleep: the hold loop must yield to macrotasks
      // so the budget interval can actually fire (a no-op sleep would
      // microtask-spin the hold loop and starve the very budget it waits
      // for).
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5))),
      // The REAL monotonic clock drives the budget poll: the 100 ms budget
      // expires ~100 ms into the 1.2 s in-flight admission.
      now: () => performance.now(),
      processNonce: TRANSPORT_NONCE,
    });
    const elapsedMs = Date.now() - t0ms;
    assert.ok(elapsedMs < 900, `the turn returns bounded by the shared budget, never by the in-flight observation (actual ${elapsedMs} ms; the in-flight op alone is 1200 ms)`);
    const block = held.cleanup.localObservation;
    assert.ok(block);
    assert.equal(block.stoppedAt, 'unfinished-observation', `the NAMED unfinished-observation fact persists (actual ${JSON.stringify(block.stoppedAt)})`);
    assert.equal(block.admission?.status, 'unestablished', `the in-flight admission settles as the named fact (actual ${block.admission?.status} ${block.admission?.reason ?? ''})`);
    assert.equal(block.admission?.reason, 'observation-window-closed');
    assert.notEqual(block.duties?.settled, true, 'an unfinished observation never settles the duties');
  });

  test('F3 keeper → with the budget NOT expired the same observation completes normally (the §25.7 measurement semantics intact)', async () => {
    const CAPTURE_NONCE = 'c'.repeat(64);
    const TRANSPORT_NONCE = '9'.repeat(64);
    const ENTRY = '/private/tmp/fixture-installed/skills/rescue/launcher.mjs';
    const BROKER_ENTRY = '/private/tmp/fixture-installed/scripts/zcode-broker.mjs';
    const declaration = { captureDirectory: '/private/tmp/fixture-capture-r4k', nonce: CAPTURE_NONCE, entryRealpath: ENTRY, brokerEntryRealpath: BROKER_ENTRY };
    // Lifetime-consistent FIXED stamps: the Companion's creation second
    // precedes the daemon's by the uniform bound; the marker's write instant
    // sits in (daemonStart + bound, the refreshed daemon read]; the
    // refreshed reads (companion calls >= 3) carry the LATER completion
    // stamps that cover the daemon's window.
    const COMPANION_START = 1_000;
    const DAEMON_START = 5_000;
    const MARKER_EPOCH = 6_500;
    const REFRESH_IDENTITY_READ = 7_000;
    const admissionEstablished = () => ({
      localProcessObservationVersion: 1, class: 'startup-identity', status: 'established', reason: null,
      identity: { role: 'invocation', nonce: CAPTURE_NONCE, entryRealpath: ENTRY, argv: ['invoke-prepared', 'rescue'], pid: 60100, ppid: 600, firstWriteEpochMs: COMPANION_START + 80, startOriginMs: COMPANION_START + 50, firstWritePreciseMs: COMPANION_START + 80.5 },
      readStartedEpochMs: 1_900, readEpochMs: 2_000,
    });
    const osEstablished = (pid, ppid, startIdentity, nonce, startInstant, identityRead, readEpoch) => ({
      localProcessObservationVersion: 1, class: 'os-live-observation', status: 'established', reason: null,
      observation: { pid, ppid, startIdentity, nonce, startInstantEpochMs: startInstant, ppidChangedFromCapture: null },
      queried: { pid, nonce }, readStartedEpochMs: identityRead - 50, identityReadEpochMs: identityRead, readEpochMs: readEpoch, absenceConfirmed: null,
    });
    // The result anchors on the runtime's OWN full lifecycle (the phase-4
    // absence = companion read 5): the turn ends only after the runtime
    // settled, so the slow-but-completing admission is honored in full.
    let companionReads = 0;
    let phaseThree = false;
    let transportReads = 0;
    const held = await runHeldHostTurn({
      gatePath: 'unused-gate',
      holdMs: 300_000,
      budgetMs: 10_000_000_000,
      launch: async () => ({
        result: new Promise((resolve) => {
          const anchor = setInterval(() => { if (companionReads >= 2) { clearInterval(anchor); resolve({ code: 0, stdout: '', stderr: '' }); } }, 5);
          anchor.unref?.();
          setTimeout(() => { clearInterval(anchor); resolve({ code: 0, stdout: '', stderr: '' }); }, 10_000).unref?.();
        }),
        terminate: async () => {},
      }),
      waitForGate: async () => {},
      captureProcessIdentity: async () => ({ pid: 60300, ppid: 60200, nonce: TRANSPORT_NONCE, startIdentity: 'S-TRANSPORT', markerEpochMs: MARKER_EPOCH }),
      readProcessIdentity: async () => undefined,
      terminateProcessIdentity: async () => ({ attempted: true, signalled: 'SIGTERM', exited: true, failure: null }),
      waitForProcessExit: async () => {},
      releaseGate: async () => {},
      localObservation: declaration,
      captureLocalObservationIdentity: async () => { await new Promise((resolve) => setTimeout(resolve, 150)); return admissionEstablished(); },
      observeLocalObservationIdentity: async () => {
        companionReads += 1;
        // Call 1: the phase-2 presence; call 2: the ancestry's REFRESHED
        // companion read (completing LATER — it covers the daemon's creation
        // window, the composition's hop-1 companion read); calls >= 3: the
        // phase-4 reads (still live — the loop runs until the turn's abort).
        return companionReads === 1
          ? osEstablished(60100, 600, 'S-COMPANION', CAPTURE_NONCE, COMPANION_START, 2_100, 2_300)
          : osEstablished(60100, 600, 'S-COMPANION', CAPTURE_NONCE, COMPANION_START, REFRESH_IDENTITY_READ, 7_100);
      },
      captureLocalBrokerObservationIdentity: async () => ({ ...admissionEstablished(), identity: { role: 'broker-daemon', nonce: CAPTURE_NONCE, entryRealpath: BROKER_ENTRY, configRealpathSha256: 'b'.repeat(64), pid: 60200, ppid: 60100, firstWriteEpochMs: DAEMON_START + 70, startOriginMs: DAEMON_START + 45, firstWritePreciseMs: DAEMON_START + 70.5 } }),
      observeLocalBrokerObservationIdentity: async () => osEstablished(60200, 60100, 'S-DAEMON', CAPTURE_NONCE, DAEMON_START, 7_200, 7_300),
      observeLocalTransportObservationIdentity: async () => {
        transportReads += 1;
        phaseThree = true;
        if (transportReads === 1) return osEstablished(60300, 60200, 'S-TRANSPORT', TRANSPORT_NONCE, 6_400, 5_600, 5_700);
        // Call 2: the runtime's transport-exit read — confirmed absent.
        return new Promise((resolve) => setTimeout(() => resolve({
          localProcessObservationVersion: 1, class: 'os-live-observation', status: 'absent', reason: 'no-such-process',
          observation: null, queried: { pid: 60300, nonce: TRANSPORT_NONCE },
          readStartedEpochMs: Date.now(), readEpochMs: Date.now(), absenceConfirmed: true,
        }), 30));
      },
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5))),
      // The GATED monotonic clock (the r2/r3 pattern): the hold deadline is
      // unreachable until the runtime's phase-3 completes, so the hold walk
      // begins only after the runtime's downstream establishments.
      now: (() => { let value = 0; let gated = false; return () => {
        if (!gated) { if (phaseThree) gated = true; else return 0; }
        value += 500;
        return value;
      }; })(),
      processNonce: TRANSPORT_NONCE,
    });
    const block = held.cleanup.localObservation;
    assert.ok(block);
    assert.equal(block.admission?.status, 'established', 'the slow-but-completing admission is honored in full');
    assert.notEqual(block.stoppedAt, 'unfinished-observation', 'no unfinished fact rides a completed observation');
    assert.equal(block.duties?.settled, true, JSON.stringify(block.duties?.duties ?? block.duties));
  });

  test('F4 (P2) RED → a transiently FAILED refresh keeps the runtime verdict and the offline replay on IDENTICAL evidence (the SELECTED endpoints persist; the failed refresh rides separately)', async () => {
    const CAPTURE_NONCE = 'c'.repeat(64);
    const TRANSPORT_NONCE = '9'.repeat(64);
    const ENTRY = '/private/tmp/fixture-installed/skills/rescue/launcher.mjs';
    const BROKER_ENTRY = '/private/tmp/fixture-installed/scripts/zcode-broker.mjs';
    const declaration = { captureDirectory: '/private/tmp/fixture-capture-r4f', nonce: CAPTURE_NONCE, entryRealpath: ENTRY, brokerEntryRealpath: BROKER_ENTRY };
    // Fixed lifetime-consistent seconds (the early Companion read ALREADY
    // covers the daemon's creation — the refresh is redundant when it
    // succeeds and the fallback is honest when it fails).
    const BASE = Math.floor(Date.now() / 1000) * 1000;
    const companionStart = BASE - 4_000;
    const daemonStart = BASE - 2_000;
    const markerEpochMs = BASE - 1_000;
    let companionReads = 0;
    let phaseThree = false;
    const admissionEstablished = () => ({
      localProcessObservationVersion: 1, class: 'startup-identity', status: 'established', reason: null,
      identity: { role: 'invocation', nonce: CAPTURE_NONCE, entryRealpath: ENTRY, argv: ['invoke-prepared', 'rescue'], pid: 60100, ppid: 600, firstWriteEpochMs: companionStart + 80, startOriginMs: companionStart + 50, firstWritePreciseMs: companionStart + 80.5 },
      readStartedEpochMs: Date.now(), readEpochMs: Date.now(),
    });
    const osEstablished = (pid, ppid, startIdentity, startInstant, nonce) => ({
      localProcessObservationVersion: 1, class: 'os-live-observation', status: 'established', reason: null,
      observation: { pid, ppid, startIdentity, nonce, startInstantEpochMs: startInstant, ppidChangedFromCapture: null },
      queried: { pid, nonce }, readStartedEpochMs: Date.now(), identityReadEpochMs: Date.now(), readEpochMs: Date.now(), absenceConfirmed: null,
    });
    const osFailed = (pid, nonce) => ({
      localProcessObservationVersion: 1, class: 'os-live-observation', status: 'unestablished', reason: 'liveness-read-failed',
      observation: null, queried: { pid, nonce }, readStartedEpochMs: Date.now(), identityReadEpochMs: Date.now(), readEpochMs: Date.now(), absenceConfirmed: null,
    });
    let transportReads = 0;
    const held = await runHeldHostTurn({
      gatePath: 'unused-gate',
      holdMs: 300_000,
      budgetMs: 10_000_000_000,
      measurementCutoffSchedule: true,
      // The result anchors on the runtime's OWN phase-4 confirmed absence
      // (companion read 3): the whole lifecycle — refresh, absence, exit
      // adjudication — composes BEFORE the turn ends.
      launch: async () => ({
        result: new Promise((resolve) => {
          const anchor = setInterval(() => { if (companionReads >= 3) { clearInterval(anchor); resolve({ code: 0, stdout: '', stderr: '' }); } }, 5);
          anchor.unref?.();
          setTimeout(() => { clearInterval(anchor); resolve({ code: 0, stdout: '', stderr: '' }); }, 10_000).unref?.();
        }),
        terminate: async () => {},
      }),
      waitForGate: async () => {},
      captureProcessIdentity: async () => ({ pid: 60300, ppid: 60200, nonce: TRANSPORT_NONCE, startIdentity: 'S-TRANSPORT', markerEpochMs }),
      readProcessIdentity: async () => undefined,
      terminateProcessIdentity: async () => ({ attempted: true, signalled: 'SIGTERM', exited: true, failure: null }),
      waitForProcessExit: async () => {},
      releaseGate: async () => {},
      localObservation: declaration,
      captureLocalObservationIdentity: async () => admissionEstablished(),
      // calls 1-2: the phase-2 presence (the COVERING early read); calls
      // 3-4: the ancestry's refreshed companion read — TRANSIENTLY FAILED;
      // calls 5+: the phase-4 confirmed absences.
      observeLocalObservationIdentity: async () => {
        companionReads += 1;
        // Call 1: the phase-2 presence (the COVERING early read); call 2:
        // the ancestry's refreshed companion read — TRANSIENTLY FAILED;
        // calls >= 3: the phase-4 confirmed absences.
        if (companionReads === 1) return osEstablished(60100, 600, 'S-COMPANION', companionStart, CAPTURE_NONCE);
        if (companionReads === 2) return osFailed(60100, CAPTURE_NONCE);
        // The confirmed absence completes in a LATER real millisecond than
        // the presence's identity instant (the strict-recency tie rule: a
        // same-millisecond absence can never manufacture a disappearance).
        return new Promise((resolve) => setTimeout(() => resolve({ ...osFailed(60100, CAPTURE_NONCE), status: 'absent', reason: 'no-such-process', absenceConfirmed: true, readStartedEpochMs: Date.now(), readEpochMs: Date.now() }), 30));
      },
      captureLocalBrokerObservationIdentity: async () => ({ ...admissionEstablished(), identity: { role: 'broker-daemon', nonce: CAPTURE_NONCE, entryRealpath: BROKER_ENTRY, configRealpathSha256: 'b'.repeat(64), pid: 60200, ppid: 60100, firstWriteEpochMs: daemonStart + 470, startOriginMs: daemonStart + 450, firstWritePreciseMs: daemonStart + 470.5 } }),
      observeLocalBrokerObservationIdentity: async () => {
        return osEstablished(60200, 60100, 'S-DAEMON', daemonStart, CAPTURE_NONCE);
      },
      observeLocalTransportObservationIdentity: async () => {
        try {
        transportReads += 1;
        phaseThree = true;
        if (transportReads === 1) return osEstablished(60300, 60200, 'S-TRANSPORT', markerEpochMs - 500, TRANSPORT_NONCE);
        // Call 2: the runtime's transport-exit read — confirmed absent.
        return new Promise((resolve) => setTimeout(() => resolve({
          localProcessObservationVersion: 1, class: 'os-live-observation', status: 'absent', reason: 'no-such-process',
          observation: null, queried: { pid: 60300, nonce: TRANSPORT_NONCE },
          readStartedEpochMs: Date.now(), readEpochMs: Date.now(), absenceConfirmed: true,
        }), 30));
        } catch (e) { console.error('R8TSEAM-THREW', e && e.message, e && e.stack?.split('\n')[1]); throw e; }
      },
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5))),
      // The GATED monotonic clock: the hold walk begins at the runtime's
      // phase-3 completion (the transport read), never before.
      now: (() => { let value = 0; let gated = false; return () => {
        if (!gated) { if (phaseThree) gated = true; else return 0; }
        value += 500;
        return value;
      }; })(),
      processNonce: TRANSPORT_NONCE,
    });
    const block = held.cleanup.localObservation;
    assert.ok(block);
    console.error('R8F4DUMP', JSON.stringify({ transport: block.transportObservation, transportExit: block.transportExit ?? null, stopped: block.stoppedAt, transportReads }));
    assert.equal(block.ancestry?.companionToTransportAttributed, true, JSON.stringify(block.ancestry?.hops ?? []));
    assert.equal(block.duties?.settled, true, `the runtime composes on the covering early endpoint (duties ${JSON.stringify(block.duties?.duties ?? [])})`);
    // The persisted endpoints are EXACTLY what the composition consumed —
    // the SELECTED fallback (the early presence), never the failed refresh.
    assert.equal(block.ancestryEndpoints?.companion?.status, 'established', `the SELECTED companion endpoint persists (actual ${JSON.stringify(block.ancestryEndpoints?.companion?.status)} ${block.ancestryEndpoints?.companion?.reason ?? ''})`);
    assert.equal(block.ancestryEndpoints?.companion?.observation?.startIdentity, block.presence?.observation?.startIdentity, 'the selected endpoint IS the fallback generation');
    // The failed refresh is retained as the NAMED fact beside it.
    assert.ok(block.ancestryEndpointRefreshes, 'the failed refreshes ride the block as named facts');
    assert.notEqual(block.ancestryEndpointRefreshes.companion?.status, 'established');
    // The offline replay of the SAME evidence settles identically.
    const joined = nativeInterruptionGateDInput({
      status: 'executed', case: 'rescue-interrupt',
      // (Review round 28, Finding 1) the harness mirrors the REAL record
      // composer (driver.mjs:1167): the interrupt carries the termination
      // boundary echo exactly when the runtime stamped one — the block and
      // the record are echo-consistent by construction.
      interrupt: {
        measurementCutoffAtMs: held.cleanup.measurementCutoffAtMs,
        ...(typeof held.cleanup.cleanupBoundaryAtMs === 'number' ? { cleanupBoundaryAtMs: held.cleanup.cleanupBoundaryAtMs } : {}),
      },
      stdoutCaptureDeclaration: {
        gate: { argv: ['invoke-prepared', 'rescue'], declaredEntryRealpathSha256: sha(ENTRY) },
        brokerGate: { declaredBrokerEntryRealpathSha256: sha(BROKER_ENTRY) },
      },
      observations: {}, child: {},
      localProcess: block,
    });
    assert.deepEqual(joined.localProcessDuties?.refusals, [], `the runtime verdict and the offline replay see identical evidence (refusals ${JSON.stringify(joined.localProcessDuties?.refusals)})`);
    assert.equal(joined.localProcessDuties?.settled, true);
  });

  test('the join version registers the round-4 replay growth', () => {
    assert.equal(NATIVE_INTERRUPTION_GATE_D_JOIN_VERSION, 37, 'join v18 (2026-10-30 local-settlement Task 3 review round 14): the tied-absence collection continuation, the transport-exit recency/carried-identity re-adjudication and the incomplete-interval start refusals; v17 (round 13): the identity-read containment check, the FROZEN argv selector enforced over mere persisted agreement, and the persisted block-version gate; v16 (round 12) = the collection-interval validity; v15 (round 11) = the invocation-absence strict tie against the walked horizon, the contradictory-duplicate-duty-slot refusal and the selected-endpoint parentage rule covering a failed refresh; v14 (round 10): the transport PID-reuse latch + the strict transport-absence tie rule; v13 (round 9): the transport exit is re-adjudicated like the invocation (the recency and carried-identity generation rules); v12 (round 8): the transport exit conjunct + the refreshed-presence horizon + the record-based capture parentage; v11 (round 7): the persisted ancestry-refresh evidence joins the offline reuse latch; v10 (round 6) = the admission entry-digest/argv-selector binding against the persisted capture declarations and the unsupported-duty-slot refusal; v9 (round 5) = the declared-scope binding, the identity-bearing absence reuse latch and the walked presence horizon; v8 (round 4) = the admission-generation re-adjudication + the endpoint lifetime/pre-fence/marker-epoch re-verification; v7 = the round-3 admissions/named-hops/reuse replay; v6 = the local-duty input contract');
  });
});

describe('local-settlement task 3 review round 5 (five P2): the replay binds the DECLARED scope, latches identity-bearing absences, walks the presence horizon, hashes the preload ON DISK, and never lets a reparenting refresh invalidate the capture-time ancestry', async () => {
  const { runHeldHostTurn, nativeInterruptionGateDInput, NATIVE_INTERRUPTION_GATE_D_JOIN_VERSION, evaluateLiveLaunchPreflight } = await import('../tools/shell-wait-probe/driver.mjs');
  const { createHash } = await import('node:crypto');
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const sha = (v) => createHash('sha256').update(v).digest('hex');
  const MEASUREMENT_CUTOFF_AT_MS = 20_000;

  const armRound5 = () => {
    const scopeNonce = 'a'.repeat(64);
    const transport = 'f'.repeat(64);
    const observation = (pid, ppid, startIdentity, scope, readStarted, identityRead, readEpoch, startInstant = 1000) => ({
      localProcessObservationVersion: 1, class: 'os-live-observation', status: 'established', reason: null,
      observation: { pid, ppid, startIdentity, startInstantEpochMs: startInstant, ppidChangedFromCapture: null, nonceSha256: scope },
      queried: { pid, nonceSha256: scope },
      readStartedEpochMs: readStarted, identityReadEpochMs: identityRead, readEpochMs: readEpoch,
      absenceConfirmed: null,
    });
    const block = {
      version: 1, armed: true, clock: 'wall-epoch-ms', nonceSha256: sha(scopeNonce),
      admission: { localProcessObservationVersion: 1, class: 'startup-identity', status: 'established', reason: null, identity: { role: 'invocation', argv: ['invoke-prepared', 'rescue'], entryRealpathSha256: sha('launcher-entry'), pid: 60100, ppid: 600, firstWriteEpochMs: 1000, startOriginMs: 1000.1, firstWritePreciseMs: 1100.5, nonceSha256: sha(scopeNonce) }, readStartedEpochMs: 1000, readEpochMs: 1100 },
      presence: observation(60100, 600, 'S-COMPANION', sha(scopeNonce), 1900, 2100, 2300),
      brokerAdmission: { localProcessObservationVersion: 1, class: 'startup-identity', status: 'established', reason: null, identity: { role: 'broker-daemon', entryRealpathSha256: sha('broker-entry'), pid: 60200, ppid: 60100, firstWriteEpochMs: 3000, startOriginMs: 3000.2, firstWritePreciseMs: 3100.6, nonceSha256: sha(scopeNonce) }, readStartedEpochMs: 1900, readEpochMs: 2100 },
      brokerObservation: observation(60200, 60100, 'S-DAEMON', sha(scopeNonce), 3300, 3400, 3500, 3000),
      transportObservation: observation(60300, 60200, 'S-TRANSPORT', sha(transport), 2000, 2200, 2500, 5000),
      ancestryEndpoints: {
        companion: observation(60100, 600, 'S-COMPANION', sha(scopeNonce), 4600, 4650, 4700, 1000),
        daemon: observation(60200, 60100, 'S-DAEMON', sha(scopeNonce), 4600, 4650, 4750, 3000),
        transportMarker: { pid: 60300, ppid: 60200, nonceSha256: sha(transport), markerEpochMs: 4450 },
      },
      ancestry: { localProcessObservationVersion: 1, class: 'ancestry-join', nonceSha256: sha(scopeNonce), companionToTransportAttributed: true, hops: [
        { hop: 'companion-to-daemon', status: 'established', reason: null },
        { hop: 'daemon-to-transport', status: 'established', reason: null },
      ] },
      duties: { localProcessObservationVersion: 1, class: 'local-duty-verdict', settled: true, duties: [
        { duty: 'invocation-process', status: 'established', reasons: [], identity: { pid: 60100, startIdentity: 'S-COMPANION', nonceSha256: sha(scopeNonce) } },
        { duty: 'broker-daemon', status: 'established', reasons: [], identity: { pid: 60200, startIdentity: 'S-DAEMON', nonceSha256: sha(scopeNonce) } },
        { duty: 'transport-descendant', status: 'established', reasons: [], identity: { pid: 60300, startIdentity: 'S-TRANSPORT', nonceSha256: sha(transport) } },
      ] },
      transportExit: { localProcessObservationVersion: 1, class: 'os-live-observation', status: 'absent', reason: 'no-such-process', observation: null, queried: { pid: 60300, nonceSha256: sha(transport) }, readStartedEpochMs: 5200, identityReadEpochMs: 5250, readEpochMs: 5300, absenceConfirmed: true },
      reads: [{ localProcessObservationVersion: 1, class: 'os-live-observation', status: 'absent', reason: 'no-such-process', observation: null, queried: { pid: 60100, nonceSha256: sha(scopeNonce) }, readStartedEpochMs: 4900, readEpochMs: 5100, absenceConfirmed: true }],
      exit: { localProcessObservationVersion: 1, class: 'exit-absence', status: 'disappeared', reason: null, boundIdentity: { pid: 60100, startIdentity: 'S-COMPANION', nonceSha256: sha(scopeNonce) }, lastVerifiedPresenceEpochMs: 2100, firstVerifiedAbsenceEpochMs: 5100, exitCorroboratedByMeta: false },
      stoppedAt: null, fenceAtMs: null, cutoffAtMs: MEASUREMENT_CUTOFF_AT_MS, cleanupBoundaryAtMs: null, composedAtMs: 6000,
    };
    const record = (over = {}) => ({
      status: 'executed', case: 'rescue-interrupt', executedAt: '2026-10-30T00:00:00.000Z',
      interrupt: { measurementCutoffAtMs: MEASUREMENT_CUTOFF_AT_MS },
      stdoutCaptureDeclaration: {
        preload: 'closure-observe.mjs', preloadSha256: sha('preload-bytes'), maxBytes: 65536,
        gate: { argv: ['invoke-prepared', 'rescue'], declaredEntryRealpathSha256: sha('launcher-entry') },
        brokerGate: { declaredBrokerEntryRealpathSha256: sha('broker-entry') },
        identityRecord: { version: 2, roles: { invocation: 'identity.json', brokerDaemon: 'identity-broker.json' } },
        environmentVariables: [],
      },
      observations: {}, child: {},
      localProcess: block,
      ...over,
    });
    return { scopeNonce, transport, block, record };
  };
  const cleanCopy = (base) => JSON.parse(JSON.stringify(base));

  test("F1 (P2) RED → a COHERENT foreign-scope broker subtree (admission + observation + endpoint + duty all re-keyed) never settles — the block's declared scope binds", () => {
    const g = armRound5();
    const foreign = sha('x'.repeat(64));
    const torn = cleanCopy(g.record());
    torn.localProcess.brokerAdmission.identity.nonceSha256 = foreign;
    torn.localProcess.brokerObservation.observation.nonceSha256 = foreign;
    torn.localProcess.brokerObservation.queried.nonceSha256 = foreign;
    torn.localProcess.ancestryEndpoints.daemon.observation.nonceSha256 = foreign;
    torn.localProcess.ancestryEndpoints.daemon.queried.nonceSha256 = foreign;
    const brokerDuty = torn.localProcess.duties.duties.find((duty) => duty.duty === 'broker-daemon');
    brokerDuty.identity.nonceSha256 = foreign;
    const consolidated = nativeInterruptionGateDInput(torn).localProcessDuties;
    assert.equal(consolidated.settled, false, 'a foreign-scope subtree never settles (the runtime scope checks reject the pairing)');
    assert.ok(consolidated.refusals.includes('admission-scope-foreign'), JSON.stringify(consolidated.refusals));
    assert.ok(consolidated.refusals.includes('ancestry-endpoint-scope-foreign'), JSON.stringify(consolidated.refusals));
  });

  test('F2 (P2) RED → an ABSENCE read carrying a foreign observed identity (observed-then-gone) latches the reuse exactly like the frozen exit', () => {
    const g = armRound5();
    const reused = cleanCopy(g.record());
    reused.localProcess.reads.push({
      localProcessObservationVersion: 1, class: 'os-live-observation', status: 'absent', reason: 'no-such-process',
      observation: null, observedStartIdentity: 'S-REUSE', observedIdentityReadEpochMs: 4950,
      queried: { pid: 60100, nonceSha256: sha(g.scopeNonce) },
      readStartedEpochMs: 4900, readEpochMs: 5100, absenceConfirmed: true,
    });
    const consolidated = nativeInterruptionGateDInput(reused).localProcessDuties;
    assert.equal(consolidated.settled, false, 'the successor\'s mid-read absence is never the bound generation\'s death');
    assert.ok(consolidated.refusals.includes('exit-reuse-latched'), JSON.stringify(consolidated.refusals));
  });

  test('F3 (P2) RED → absence collection must start at/after the LATEST same-generation presence (the horizon walks the whole persisted sequence)', () => {
    const g = armRound5();
    const later = cleanCopy(g.record());
    // A later VERIFIED presence of the SAME generation (identity-read 5020)
    // moves the horizon; the confirmed absence (collected 4900-5100) started
    // BEFORE it and proves nothing about the state after the last presence.
    later.localProcess.reads.push({
      localProcessObservationVersion: 1, class: 'os-live-observation', status: 'established', reason: null,
      observation: { pid: 60100, ppid: 600, startIdentity: 'S-COMPANION', startInstantEpochMs: 1000, ppidChangedFromCapture: null, nonceSha256: sha(g.scopeNonce) },
      queried: { pid: 60100, nonceSha256: sha(g.scopeNonce) },
      readStartedEpochMs: 4970, identityReadEpochMs: 5020, readEpochMs: 5050, absenceConfirmed: null,
    });
    const consolidated = nativeInterruptionGateDInput(later).localProcessDuties;
    assert.equal(consolidated.settled, false, 'the sequence stays live: the absence overlapped the LATEST presence');
    assert.ok(consolidated.refusals.includes('exit-absence-overlaps-presence'), JSON.stringify(consolidated.refusals));
  });

  test('F4 (P2) RED → the preflight hashes the preload artifact ON DISK against the DECLARED digest (a replaced/truncated artifact refuses)', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'local-process-r5-preflight-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const workspace = join(root, 'ws');
    const dataRoot = join(root, 'data-root');
    const captureDirectory = join(root, 'stdout-capture');
    await mkdir(workspace, { mode: 0o700 });
    await mkdir(dataRoot, { mode: 0o700 });
    await mkdir(captureDirectory, { mode: 0o700 });
    const preloadBytes = '// the executing preload artifact\n';
    const preloadPath = join(root, 'closure-stdout-preload.cjs');
    await writeFile(preloadPath, preloadBytes, 'utf8');
    const entryRealpath = '/private/tmp/r5-installed/skills/rescue/launcher.mjs';
    const brokerEntryRealpath = '/private/tmp/r5-installed/scripts/zcode-broker.mjs';
    const handle = {
      preloadPath, preloadSha256: sha(preloadBytes), captureDirectory, nonce: 'a'.repeat(64), maxBytes: 65536,
      entryRealpath, brokerEntryRealpath,
    };
    const arming = {
      preload: 'closure-stdout-preload.cjs', preloadSha256: sha(preloadBytes), maxBytes: 65536,
      gate: { argv: ['invoke-prepared', 'rescue'], declaredEntryRealpathSha256: sha(entryRealpath) },
      brokerGate: { declaredBrokerEntryRealpathSha256: sha(brokerEntryRealpath) },
      identityRecord: { version: 2, roles: { invocation: 'identity.json', brokerDaemon: 'identity-broker.json' } },
      environmentVariables: [],
    };
    const fixture = {
      workspace, stdoutCapture: handle, record: { closureStdoutCapture: arming },
      env: {
        ZCODE_DATA_ROOT: dataRoot,
        ZCODE_SHELL_WAIT_CAPTURE_DIR: handle.captureDirectory,
        ZCODE_SHELL_WAIT_CAPTURE_NONCE: handle.nonce,
        ZCODE_SHELL_WAIT_CAPTURE_ENTRY_REALPATH: handle.entryRealpath,
        ZCODE_SHELL_WAIT_CAPTURE_MAX_BYTES: String(handle.maxBytes),
        ZCODE_SHELL_WAIT_CAPTURE_BROKER_ENTRY_REALPATH: handle.brokerEntryRealpath,
        NODE_OPTIONS: `--require "${preloadPath}"`,
      },
    };
    const input = { case: 'rescue-interrupt', survivalControlSelector: null, fixture };
    // (a) The premise: with the disk bytes matching the declaration the
    // armed fixture passes.
    const armed = await evaluateLiveLaunchPreflight(input);
    assert.deepEqual(armed, { ok: true, reason: null }, `premise: the coherent armed fixture passes (${armed.reason ?? ''})`);
    // (b) The artifact is REPLACED on disk after fixture creation (an
    // existing non-observer module): the cached hashes still agree — only
    // the ON-DISK hash against the DECLARED digest catches the drift.
    await writeFile(preloadPath, '// a non-observer module\n', 'utf8');
    const drifted = await evaluateLiveLaunchPreflight(input);
    assert.equal(drifted.ok, false, 'a replaced preload artifact must refuse pre-launch');
    assert.match(String(drifted.reason), /preload artifact/iu, drifted.reason);
    // (c) A TRUNCATED artifact refuses the same way.
    await writeFile(preloadPath, '', 'utf8');
    const truncated = await evaluateLiveLaunchPreflight(input);
    assert.equal(truncated.ok, false);
    assert.match(String(truncated.reason), /preload artifact/iu, truncated.reason);
  });

  test('F5 (P2) → a reparenting refresh never invalidates the capture-time ancestry (the round-7 two-fact rule: the refresh is the lifetime bound, the capture-time parent link satisfies the ppid hop)', async () => {
    const CAPTURE_NONCE = 'c'.repeat(64);
    const TRANSPORT_NONCE = '9'.repeat(64);
    const ENTRY = '/private/tmp/fixture-installed/skills/rescue/launcher.mjs';
    const BROKER_ENTRY = '/private/tmp/fixture-installed/scripts/zcode-broker.mjs';
    const declaration = { captureDirectory: '/private/tmp/fixture-capture-r5', nonce: CAPTURE_NONCE, entryRealpath: ENTRY, brokerEntryRealpath: BROKER_ENTRY };
    const COMPANION_START = 1_000;
    const DAEMON_START = 5_000;
    const MARKER_EPOCH = 6_500;
    const REFRESH_IDENTITY_READ = 7_000;
    const admissionEstablished = () => ({
      localProcessObservationVersion: 1, class: 'startup-identity', status: 'established', reason: null,
      identity: { role: 'invocation', nonce: CAPTURE_NONCE, entryRealpath: ENTRY, argv: ['invoke-prepared', 'rescue'], pid: 60100, ppid: 600, firstWriteEpochMs: COMPANION_START + 80, startOriginMs: COMPANION_START + 50, firstWritePreciseMs: COMPANION_START + 80.5 },
      readStartedEpochMs: 1_900, readEpochMs: 2_000,
    });
    const osEstablished = (pid, ppid, startIdentity, nonce, startInstant, identityRead, readEpoch) => ({
      localProcessObservationVersion: 1, class: 'os-live-observation', status: 'established', reason: null,
      observation: { pid, ppid, startIdentity, nonce, startInstantEpochMs: startInstant, ppidChangedFromCapture: null },
      queried: { pid, nonce }, readStartedEpochMs: identityRead - 50, identityReadEpochMs: identityRead, readEpochMs: readEpoch, absenceConfirmed: null,
    });
    let companionReads = 0;
    let daemonReads = 0;
    let phaseThree = false;
    const held = await runHeldHostTurn({
      gatePath: 'unused-gate',
      holdMs: 300_000,
      budgetMs: 10_000_000_000,
      // The result anchors on the runtime's OWN phase-4 confirmed absence
      // (companion read 3): the whole lifecycle composes BEFORE the turn ends.
      launch: async () => ({
        result: new Promise((resolve) => {
          const anchor = setInterval(() => { if (companionReads >= 3) { clearInterval(anchor); resolve({ code: 0, stdout: '', stderr: '' }); } }, 5);
          anchor.unref?.();
          setTimeout(() => { clearInterval(anchor); resolve({ code: 0, stdout: '', stderr: '' }); }, 10_000).unref?.();
        }),
        terminate: async () => {},
      }),
      waitForGate: async () => {},
      captureProcessIdentity: async () => ({ pid: 60300, ppid: 60200, nonce: TRANSPORT_NONCE, startIdentity: 'S-TRANSPORT', markerEpochMs: MARKER_EPOCH }),
      readProcessIdentity: async () => undefined,
      terminateProcessIdentity: async () => ({ attempted: true, signalled: 'SIGTERM', exited: true, failure: null }),
      waitForProcessExit: async () => {},
      releaseGate: async () => {},
      localObservation: declaration,
      captureLocalObservationIdentity: async () => admissionEstablished(),
      // Call 1: the phase-2 presence; call 2: the ancestry's refreshed
      // companion read (LATER stamps covering the daemon's window);
      // calls >= 3: the phase-4 confirmed absences (a real 30 ms gap — the
      // strict-recency tie rule).
      observeLocalObservationIdentity: async () => {
        companionReads += 1;
        if (companionReads === 1) return osEstablished(60100, 600, 'S-COMPANION', CAPTURE_NONCE, COMPANION_START, 2_100, 2_300);
        if (companionReads === 2) return osEstablished(60100, 600, 'S-COMPANION', CAPTURE_NONCE, COMPANION_START, REFRESH_IDENTITY_READ, 7_100);
        return new Promise((resolve) => setTimeout(() => resolve({
          localProcessObservationVersion: 1, class: 'os-live-observation', status: 'absent', reason: 'no-such-process',
          observation: null, queried: { pid: 60100, nonce: CAPTURE_NONCE },
          readStartedEpochMs: Date.now(), readEpochMs: Date.now(), absenceConfirmed: true,
        }), 30));
      },
      captureLocalBrokerObservationIdentity: async () => ({ ...admissionEstablished(), identity: { role: 'broker-daemon', nonce: CAPTURE_NONCE, entryRealpath: BROKER_ENTRY, configRealpathSha256: 'b'.repeat(64), pid: 60200, ppid: 60100, firstWriteEpochMs: DAEMON_START + 70, startOriginMs: DAEMON_START + 45, firstWritePreciseMs: DAEMON_START + 70.5 } }),
      // Call 1 (the phase-3 capture-time read): the daemon's parent IS the
      // Companion (60100). Call 2 (the ancestry's refresh): the Companion
      // has EXITED and the detached broker was reparented to init (ppid 1) —
      // the SAME start identity, a CHANGED parent.
      observeLocalBrokerObservationIdentity: async () => {
        daemonReads += 1;
        return daemonReads === 1
          ? osEstablished(60200, 60100, 'S-DAEMON', CAPTURE_NONCE, DAEMON_START, 7_200, 7_300)
          : osEstablished(60200, 1, 'S-DAEMON', CAPTURE_NONCE, DAEMON_START, REFRESH_IDENTITY_READ + 200, 7_600);
      },
      observeLocalTransportObservationIdentity: async () => {
        phaseThree = true;
        return osEstablished(60300, 60200, 'S-TRANSPORT', TRANSPORT_NONCE, 6_400, 5_600, 5_700);
      },
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5))),
      // The GATED monotonic clock: the hold walk begins at the runtime's
      // phase-3 completion (the transport read), never before.
      now: (() => { let value = 0; let gated = false; return () => {
        if (!gated) { if (phaseThree) gated = true; else return 0; }
        value += 500;
        return value;
      }; })(),
      processNonce: TRANSPORT_NONCE,
    });
    const block = held.cleanup.localObservation;
    assert.ok(block);
    // (Review round 7, Finding 2 — the two-fact rule) the refreshed
    // (reparented) daemon endpoint carries the LIFETIME coverage (its read
    // extends beyond the transport marker); the CAPTURE-TIME parent link
    // persists beside it (the broker observation) and satisfies the ppid
    // hop — the ancestry attributes and the duties settle on BOTH facts.
    assert.equal(block.ancestry?.companionToTransportAttributed, true, JSON.stringify(block.ancestry?.hops ?? []));
    assert.equal(block.duties?.settled, true, `the duties settle on the two-fact ancestry (duties ${JSON.stringify(block.duties?.duties ?? [])})`);
    assert.equal(block.ancestryEndpoints?.daemon?.observation?.ppid, 1, `the refreshed (reparented) endpoint is the persisted lifetime evidence (actual ${JSON.stringify(block.ancestryEndpoints?.daemon?.observation ?? null)})`);
    assert.equal(block.brokerObservation?.observation?.ppid, 60100, 'the capture-time parent link persists');
  });

  test('the join version registers the round-5 replay growth', () => {
    assert.equal(NATIVE_INTERRUPTION_GATE_D_JOIN_VERSION, 37, 'join v18 (2026-10-30 local-settlement Task 3 review round 14): the tied-absence collection continuation, the transport-exit recency/carried-identity re-adjudication and the incomplete-interval start refusals; v17 (round 13): the identity-read containment check, the FROZEN argv selector enforced over mere persisted agreement, and the persisted block-version gate; v16 (round 12) = the collection-interval validity; v15 (round 11) = the invocation-absence strict tie against the walked horizon, the contradictory-duplicate-duty-slot refusal and the selected-endpoint parentage rule covering a failed refresh; v14 (round 10): the transport PID-reuse latch + the strict transport-absence tie rule; v13 (round 9): the transport exit is re-adjudicated like the invocation (the recency and carried-identity generation rules); v12 (round 8): the transport exit conjunct + the refreshed-presence horizon + the record-based capture parentage; v11 (round 7): the persisted ancestry-refresh evidence joins the offline reuse latch; v10 (round 6) = the admission entry-digest/argv-selector binding against the persisted capture declarations and the unsupported-duty-slot refusal; v9 (round 5) = the declared-scope binding (the startup-backed duties + the ancestry endpoints), the identity-bearing ABSENCE reuse latch and the walked presence horizon; v8 (round 4) = the persisted-admission generation re-adjudication + the ancestry endpoint pre-fence/lifetime/marker-epoch re-verification; v7 (round 3) = the admissions/named-hops/ppid-chain/generation-change replay; v6 = the local-duty input contract');
  });
});

describe('local-settlement task 3 review round 6 (four P2): the replay binds the entry/argv declarations and refuses unsupported duty slots; observation work cannot start after the window closes; the live provenance binds the executing helper copies', async () => {
  const { runHeldHostTurn, nativeInterruptionGateDInput, NATIVE_INTERRUPTION_GATE_D_JOIN_VERSION } = await import('../tools/shell-wait-probe/driver.mjs');
  const { EXECUTING_OBSERVER_PROVENANCE } = await import('../tools/shell-wait-probe/driver.mjs');
  const { EXECUTING_HELPER_MATERIALIZATION } = await import('../tools/shell-wait-probe/local-process-observation.mjs');
  const { createHash } = await import('node:crypto');
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const sha = (v) => createHash('sha256').update(v).digest('hex');
  const MEASUREMENT_CUTOFF_AT_MS = 20_000;

  /** The coherent armed positive with the CAPTURE DECLARATIONS the entry/argv
   * binding consumes (the invocation admission carries its entry digest and
   * the registered rescue argv selector; the broker admission its entry
   * digest). */
  const armRound6 = () => {
    const scopeNonce = 'a'.repeat(64);
    const transport = 'f'.repeat(64);
    const launcherEntryDigest = sha('launcher-entry');
    const brokerEntryDigest = sha('broker-entry');
    const observation = (pid, ppid, startIdentity, scope, readStarted, identityRead, readEpoch, startInstant = 1000) => ({
      localProcessObservationVersion: 1, class: 'os-live-observation', status: 'established', reason: null,
      observation: { pid, ppid, startIdentity, startInstantEpochMs: startInstant, ppidChangedFromCapture: null, nonceSha256: scope },
      queried: { pid, nonceSha256: scope },
      readStartedEpochMs: readStarted, identityReadEpochMs: identityRead, readEpochMs: readEpoch,
      absenceConfirmed: null,
    });
    const block = {
      version: 1, armed: true, clock: 'wall-epoch-ms', nonceSha256: sha(scopeNonce),
      admission: { localProcessObservationVersion: 1, class: 'startup-identity', status: 'established', reason: null, identity: { role: 'invocation', argv: ['invoke-prepared', 'rescue'], entryRealpathSha256: launcherEntryDigest, pid: 60100, ppid: 600, firstWriteEpochMs: 1000, startOriginMs: 1000.1, firstWritePreciseMs: 1100.5, nonceSha256: sha(scopeNonce) }, readStartedEpochMs: 1000, readEpochMs: 1100 },
      presence: observation(60100, 600, 'S-COMPANION', sha(scopeNonce), 1900, 2100, 2300),
      brokerAdmission: { localProcessObservationVersion: 1, class: 'startup-identity', status: 'established', reason: null, identity: { role: 'broker-daemon', entryRealpathSha256: brokerEntryDigest, pid: 60200, ppid: 60100, firstWriteEpochMs: 3000, startOriginMs: 3000.2, firstWritePreciseMs: 3100.6, nonceSha256: sha(scopeNonce) }, readStartedEpochMs: 1900, readEpochMs: 2100 },
      brokerObservation: observation(60200, 60100, 'S-DAEMON', sha(scopeNonce), 3300, 3400, 3500, 3000),
      transportObservation: observation(60300, 60200, 'S-TRANSPORT', sha(transport), 2000, 2200, 2500, 5000),
      ancestryEndpoints: {
        companion: observation(60100, 600, 'S-COMPANION', sha(scopeNonce), 4600, 4650, 4700, 1000),
        daemon: observation(60200, 60100, 'S-DAEMON', sha(scopeNonce), 4600, 4650, 4750, 3000),
        transportMarker: { pid: 60300, ppid: 60200, nonceSha256: sha(transport), markerEpochMs: 4450 },
      },
      ancestry: { localProcessObservationVersion: 1, class: 'ancestry-join', nonceSha256: sha(scopeNonce), companionToTransportAttributed: true, hops: [
        { hop: 'companion-to-daemon', status: 'established', reason: null },
        { hop: 'daemon-to-transport', status: 'established', reason: null },
      ] },
      duties: { localProcessObservationVersion: 1, class: 'local-duty-verdict', settled: true, duties: [
        { duty: 'invocation-process', status: 'established', reasons: [], identity: { pid: 60100, startIdentity: 'S-COMPANION', nonceSha256: sha(scopeNonce) } },
        { duty: 'broker-daemon', status: 'established', reasons: [], identity: { pid: 60200, startIdentity: 'S-DAEMON', nonceSha256: sha(scopeNonce) } },
        { duty: 'transport-descendant', status: 'established', reasons: [], identity: { pid: 60300, startIdentity: 'S-TRANSPORT', nonceSha256: sha(transport) } },
      ] },
      transportExit: { localProcessObservationVersion: 1, class: 'os-live-observation', status: 'absent', reason: 'no-such-process', observation: null, queried: { pid: 60300, nonceSha256: sha(transport) }, readStartedEpochMs: 5200, identityReadEpochMs: 5250, readEpochMs: 5300, absenceConfirmed: true },
      reads: [{ localProcessObservationVersion: 1, class: 'os-live-observation', status: 'absent', reason: 'no-such-process', observation: null, queried: { pid: 60100, nonceSha256: sha(scopeNonce) }, readStartedEpochMs: 4900, readEpochMs: 5100, absenceConfirmed: true }],
      exit: { localProcessObservationVersion: 1, class: 'exit-absence', status: 'disappeared', reason: null, boundIdentity: { pid: 60100, startIdentity: 'S-COMPANION', nonceSha256: sha(scopeNonce) }, lastVerifiedPresenceEpochMs: 2100, firstVerifiedAbsenceEpochMs: 5100, exitCorroboratedByMeta: false },
      stoppedAt: null, fenceAtMs: null, cutoffAtMs: MEASUREMENT_CUTOFF_AT_MS, cleanupBoundaryAtMs: null, composedAtMs: 6000,
    };
    const record = (over = {}) => ({
      status: 'executed', case: 'rescue-interrupt', executedAt: '2026-10-30T00:00:00.000Z',
      interrupt: { measurementCutoffAtMs: MEASUREMENT_CUTOFF_AT_MS },
      stdoutCaptureDeclaration: {
        preload: 'closure-observe.mjs', preloadSha256: sha('preload-bytes'), maxBytes: 65536,
        gate: { argv: ['invoke-prepared', 'rescue'], declaredEntryRealpathSha256: launcherEntryDigest },
        brokerGate: { declaredBrokerEntryRealpathSha256: brokerEntryDigest },
        identityRecord: { version: 2, roles: { invocation: 'identity.json', brokerDaemon: 'identity-broker.json' } },
        environmentVariables: [],
      },
      observations: {}, child: {},
      localProcess: block,
      ...over,
    });
    return { scopeNonce, transport, block, record, launcherEntryDigest, brokerEntryDigest };
  };
  const cleanCopy = (base) => JSON.parse(JSON.stringify(base));

  test("F1 (P2) RED → an admission whose ENTRY DIGEST and ARGV SELECTOR contradict the record's capture declarations never settles", () => {
    const g = armRound6();
    const torn = cleanCopy(g.record());
    torn.localProcess.admission.identity.argv = ['status', 'list'];
    torn.localProcess.admission.identity.entryRealpathSha256 = sha('an-unrelated-program');
    const consolidated = nativeInterruptionGateDInput(torn).localProcessDuties;
    assert.equal(consolidated.settled, false, 'the serialized admission status alone never binds the selector');
    assert.ok(consolidated.refusals.includes('admission-entry-unbound'), JSON.stringify(consolidated.refusals));
    assert.ok(consolidated.refusals.includes('admission-selector-foreign'), JSON.stringify(consolidated.refusals));
  });

  test('F1 keeper → the honest declaration-bound admissions settle (the record declarations bind, never block)', () => {
    const g = armRound6();
    const consolidated = nativeInterruptionGateDInput(g.record()).localProcessDuties;
    assert.deepEqual(consolidated.refusals, [], JSON.stringify(consolidated.refusals));
    assert.equal(consolidated.settled, true);
  });

  test("F2 (P2) RED → an aggregate claiming settlement while listing an UNESTABLISHED identified-descendant (exitStatus 'still-live') is refused, never silently skipped", () => {
    const g = armRound6();
    const torn = cleanCopy(g.record());
    torn.localProcess.duties.duties.push({
      duty: 'identified-descendant', status: 'unestablished', reasons: ['exit-unestablished'],
      exitStatus: 'still-live', identity: { pid: 60400, startIdentity: 'S-DESC', nonceSha256: sha(g.scopeNonce) },
    });
    const consolidated = nativeInterruptionGateDInput(torn).localProcessDuties;
    assert.equal(consolidated.settled, false, 'positively identified descendants without established exits never settle');
    assert.ok(consolidated.refusals.includes('inline-duty-unsupported-slot'), JSON.stringify(consolidated.refusals));
  });

  test('F3 (P2) RED → observation work never STARTS after the window closed (the cancellation propagates through the observer between reads)', async () => {
    const CAPTURE_NONCE = 'c'.repeat(64);
    const TRANSPORT_NONCE = '9'.repeat(64);
    const ENTRY = '/private/tmp/fixture-installed/skills/rescue/launcher.mjs';
    const BROKER_ENTRY = '/private/tmp/fixture-installed/scripts/zcode-broker.mjs';
    const declaration = { captureDirectory: '/private/tmp/fixture-capture-r6', nonce: CAPTURE_NONCE, entryRealpath: ENTRY, brokerEntryRealpath: BROKER_ENTRY };
    const COMPANION_START = 1_000;
    const admissionEstablished = () => ({
      localProcessObservationVersion: 1, class: 'startup-identity', status: 'established', reason: null,
      identity: { role: 'invocation', nonce: CAPTURE_NONCE, entryRealpath: ENTRY, argv: ['invoke-prepared', 'rescue'], pid: 60100, ppid: 600, firstWriteEpochMs: COMPANION_START + 80, startOriginMs: COMPANION_START + 50, firstWritePreciseMs: COMPANION_START + 80.5 },
      readStartedEpochMs: 1_900, readEpochMs: 2_000,
    });
    // The REAL observer with a DELAYED ps: every ps call records its START
    // instant; the first read is in flight when the 100 ms budget expires.
    /** @type {number[]} */
    const psStarts = [];
    const row = (pid) => ({ pid, ppid: 600, lstart: 'Thu Oct  1 00:00:01 2026' });
    const psSeam = async (/** @type {any} */ pid) => {
      psStarts.push(Date.now());
      await new Promise((resolve) => setTimeout(resolve, 400));
      return row(typeof pid === 'number' ? pid : pid?.pid ?? 60100);
    };
    const t0ms = Date.now();
    const held = await runHeldHostTurn({
      gatePath: 'unused-gate',
      holdMs: 300_000,
      budgetMs: 100,
      launch: async () => ({
        result: new Promise((resolve) => { const anchor = setInterval(() => { clearInterval(anchor); resolve({ code: 0, stdout: '', stderr: '' }); }, 40); anchor.unref?.(); }),
        terminate: async () => {},
      }),
      waitForGate: async () => {},
      captureProcessIdentity: async () => ({ pid: 60300, ppid: 60100, nonce: TRANSPORT_NONCE, startIdentity: 'S-TRANSPORT' }),
      readProcessIdentity: async () => undefined,
      terminateProcessIdentity: async () => ({ attempted: true, signalled: 'SIGTERM', exited: true, failure: null }),
      waitForProcessExit: async () => {},
      releaseGate: async () => {},
      localObservation: declaration,
      captureLocalObservationIdentity: async () => admissionEstablished(),
      localObservationObserverOptions: {
        osSeams: { platform: 'darwin', ps: psSeam, environ: 'present' },
        absenceConfirmation: async () => 'absent',
      },
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5))),
      now: () => performance.now(),
      processNonce: TRANSPORT_NONCE,
    });
    const turnReturnedAt = Date.now() - t0ms;
    assert.ok(turnReturnedAt < 900, `the turn returns bounded by the shared budget (actual ${turnReturnedAt} ms)`);
    // Let the un-cancellable in-flight seam settle; NOTHING may start after it.
    await new Promise((resolve) => setTimeout(resolve, 700));
    assert.equal(psStarts.length, 1, `no observation read may START after the window closed (actual starts at +${psStarts.map((t) => t - t0ms).join(', ')} ms)`);
    const block = held.cleanup.localObservation;
    assert.ok(block);
    assert.equal(block.stoppedAt, 'unfinished-observation', `the named unfinished fact persists (actual ${JSON.stringify(block.stoppedAt)})`);
  });

  test('F4 (P2) RED → the live provenance binds the MATERIALIZED executing helper copies (the digest is load-bearing over scripts/lib/{fs,process,errors}.mjs)', async () => {
    const observerModule = await import('../tools/shell-wait-probe/local-process-observation.mjs');
    const evidenceModule = await import('../tools/shell-wait-probe/evidence.mjs');
    const shapeModule = await import('../tools/shell-wait-probe/shape-diagnostic.mjs');
    const releaseModule = await import('../tools/shell-wait-probe/release-qualification.mjs');
    const closureObservationModule = await import('../tools/shell-wait-probe/closure-observation.mjs');
    const closurePreloadModule = await import('../tools/shell-wait-probe/closure-preload.mjs');
    assert.match(String(EXECUTING_OBSERVER_PROVENANCE.digestInput), /scripts\/lib\/fs\.mjs/, 'the digest input must NAME the executing helper bindings');
    assert.match(String(EXECUTING_OBSERVER_PROVENANCE.digestInput), /scripts\/lib\/process\.mjs/, 'the digest input must NAME the executing helper bindings');
    assert.match(String(EXECUTING_OBSERVER_PROVENANCE.digestInput), /scripts\/lib\/errors\.mjs/, 'the digest input must NAME the executing helper bindings');
    // Replicate the recorded construction INCLUDING the materialized
    // executing helper-copy digests: a construction that omits them cannot
    // produce the recorded digest (load-bearing, not just labelled).
    const driverSource = readFileSync(fileURLToPath(new URL('../tools/shell-wait-probe/driver.mjs', import.meta.url)));
    const expected = createHash('sha256')
      .update('zcode-shell-wait-observer-v8\0')
      .update(evidenceModule.EXECUTING_EVIDENCE_SOURCE).update('\0')
      .update(shapeModule.EXECUTING_SHAPE_DIAGNOSTIC_SOURCE).update('\0')
      .update(releaseModule.EXECUTING_RELEASE_QUALIFICATION_SOURCE).update('\0')
      .update(closureObservationModule.EXECUTING_CLOSURE_OBSERVATION_SOURCE).update('\0')
      .update(closurePreloadModule.EXECUTING_CLOSURE_PRELOAD_SOURCE).update('\0')
      .update(observerModule.EXECUTING_LOCAL_PROCESS_OBSERVATION_SOURCE).update('\0')
      .update(driverSource).update('\0')
      .update(EXECUTING_HELPER_MATERIALIZATION.bytes['scripts/lib/fs.mjs']).update('\0')
      .update(EXECUTING_HELPER_MATERIALIZATION.bytes['scripts/lib/process.mjs']).update('\0')
      .update(EXECUTING_HELPER_MATERIALIZATION.bytes['scripts/lib/errors.mjs'])
      .digest('hex');
    assert.equal(EXECUTING_OBSERVER_PROVENANCE.digest, expected, 'the recorded provenance digest must bind the executing helper copies');
  });

  test('the join version registers the round-6 replay growth', () => {
    assert.equal(NATIVE_INTERRUPTION_GATE_D_JOIN_VERSION, 37, 'join v18 (2026-10-30 local-settlement Task 3 review round 14): the tied-absence collection continuation, the transport-exit recency/carried-identity re-adjudication and the incomplete-interval start refusals; v17 (round 13): the identity-read containment check, the FROZEN argv selector enforced over mere persisted agreement, and the persisted block-version gate; v16 (round 12) = the collection-interval validity; v15 (round 11) = the invocation-absence strict tie against the walked horizon, the contradictory-duplicate-duty-slot refusal and the selected-endpoint parentage rule covering a failed refresh; v14 (round 10): the transport PID-reuse latch + the strict transport-absence tie rule; v13 (round 9): the transport exit is re-adjudicated like the invocation (the recency and carried-identity generation rules); v12 (round 8): the transport exit conjunct + the refreshed-presence horizon + the record-based capture parentage; v11 (round 7): the persisted ancestry-refresh evidence joins the offline reuse latch; v10 (round 6) = the admission entry-digest/argv-selector binding against the persisted capture declarations and the unsupported-duty-slot refusal; v9 (round 5) = the declared-scope binding, the identity-bearing absence reuse latch and the walked presence horizon; v8 (round 4) = the persisted-admission generation re-adjudication + the ancestry endpoint pre-fence/lifetime/marker-epoch re-verification; v7 (round 3) = the admissions/named-hops/ppid-chain/generation-change replay; v6 = the local-duty input contract');
  });
});

describe('local-settlement task 3 review round 7 (two P2): a generation-changing refresh read participates in the exit adjudication and the offline latch; a reparenting refresh provides the lifetime bound while the capture-time parent link satisfies the ppid hop', async () => {
  const { runHeldHostTurn, nativeInterruptionGateDInput, NATIVE_INTERRUPTION_GATE_D_JOIN_VERSION } = await import('../tools/shell-wait-probe/driver.mjs');
  const { createHash } = await import('node:crypto');
  const sha = (v) => createHash('sha256').update(v).digest('hex');
  const MEASUREMENT_CUTOFF_AT_MS = 20_000;

  /** The round-7 offline positive: the round-6 shape plus the persisted
   * `ancestryEndpointRefreshes` field (the named refresh facts the offline
   * latch consumes). */
  const armRound7 = () => {
    const scopeNonce = 'a'.repeat(64);
    const transport = 'f'.repeat(64);
    const launcherEntryDigest = sha('launcher-entry');
    const brokerEntryDigest = sha('broker-entry');
    const observation = (pid, ppid, startIdentity, scope, readStarted, identityRead, readEpoch, startInstant = 1000) => ({
      localProcessObservationVersion: 1, class: 'os-live-observation', status: 'established', reason: null,
      observation: { pid, ppid, startIdentity, startInstantEpochMs: startInstant, ppidChangedFromCapture: null, nonceSha256: scope },
      queried: { pid, nonceSha256: scope },
      readStartedEpochMs: readStarted, identityReadEpochMs: identityRead, readEpochMs: readEpoch,
      absenceConfirmed: null,
    });
    const block = {
      version: 1, armed: true, clock: 'wall-epoch-ms', nonceSha256: sha(scopeNonce),
      admission: { localProcessObservationVersion: 1, class: 'startup-identity', status: 'established', reason: null, identity: { role: 'invocation', argv: ['invoke-prepared', 'rescue'], entryRealpathSha256: launcherEntryDigest, pid: 60100, ppid: 600, firstWriteEpochMs: 1000, startOriginMs: 1000.1, firstWritePreciseMs: 1100.5, nonceSha256: sha(scopeNonce) }, readStartedEpochMs: 1000, readEpochMs: 1100 },
      presence: observation(60100, 600, 'S-COMPANION', sha(scopeNonce), 1900, 2100, 2300),
      brokerAdmission: { localProcessObservationVersion: 1, class: 'startup-identity', status: 'established', reason: null, identity: { role: 'broker-daemon', entryRealpathSha256: brokerEntryDigest, pid: 60200, ppid: 60100, firstWriteEpochMs: 3000, startOriginMs: 3000.2, firstWritePreciseMs: 3100.6, nonceSha256: sha(scopeNonce) }, readStartedEpochMs: 1900, readEpochMs: 2100 },
      brokerObservation: observation(60200, 60100, 'S-DAEMON', sha(scopeNonce), 3300, 3400, 3500, 3000),
      transportObservation: observation(60300, 60200, 'S-TRANSPORT', sha(transport), 2000, 2200, 2500, 5000),
      ancestryEndpoints: {
        companion: observation(60100, 600, 'S-COMPANION', sha(scopeNonce), 4600, 4650, 4700, 1000),
        daemon: observation(60200, 60100, 'S-DAEMON', sha(scopeNonce), 4600, 4650, 4750, 3000),
        transportMarker: { pid: 60300, ppid: 60200, nonceSha256: sha(transport), markerEpochMs: 4450 },
      },
      ancestryEndpointRefreshes: { companion: null, daemon: null },
      ancestry: { localProcessObservationVersion: 1, class: 'ancestry-join', nonceSha256: sha(scopeNonce), companionToTransportAttributed: true, hops: [
        { hop: 'companion-to-daemon', status: 'established', reason: null },
        { hop: 'daemon-to-transport', status: 'established', reason: null },
      ] },
      duties: { localProcessObservationVersion: 1, class: 'local-duty-verdict', settled: true, duties: [
        { duty: 'invocation-process', status: 'established', reasons: [], identity: { pid: 60100, startIdentity: 'S-COMPANION', nonceSha256: sha(scopeNonce) } },
        { duty: 'broker-daemon', status: 'established', reasons: [], identity: { pid: 60200, startIdentity: 'S-DAEMON', nonceSha256: sha(scopeNonce) } },
        { duty: 'transport-descendant', status: 'established', reasons: [], identity: { pid: 60300, startIdentity: 'S-TRANSPORT', nonceSha256: sha(transport) } },
      ] },
      transportExit: { localProcessObservationVersion: 1, class: 'os-live-observation', status: 'absent', reason: 'no-such-process', observation: null, queried: { pid: 60300, nonceSha256: sha(transport) }, readStartedEpochMs: 5200, identityReadEpochMs: 5250, readEpochMs: 5300, absenceConfirmed: true },
      reads: [{ localProcessObservationVersion: 1, class: 'os-live-observation', status: 'absent', reason: 'no-such-process', observation: null, queried: { pid: 60100, nonceSha256: sha(scopeNonce) }, readStartedEpochMs: 4900, readEpochMs: 5100, absenceConfirmed: true }],
      exit: { localProcessObservationVersion: 1, class: 'exit-absence', status: 'disappeared', reason: null, boundIdentity: { pid: 60100, startIdentity: 'S-COMPANION', nonceSha256: sha(scopeNonce) }, lastVerifiedPresenceEpochMs: 2100, firstVerifiedAbsenceEpochMs: 5100, exitCorroboratedByMeta: false },
      stoppedAt: null, fenceAtMs: null, cutoffAtMs: MEASUREMENT_CUTOFF_AT_MS, cleanupBoundaryAtMs: null, composedAtMs: 6000,
    };
    const record = (over = {}) => ({
      status: 'executed', case: 'rescue-interrupt', executedAt: '2026-10-30T00:00:00.000Z',
      interrupt: { measurementCutoffAtMs: MEASUREMENT_CUTOFF_AT_MS },
      stdoutCaptureDeclaration: {
        preload: 'closure-observe.mjs', preloadSha256: sha('preload-bytes'), maxBytes: 65536,
        gate: { argv: ['invoke-prepared', 'rescue'], declaredEntryRealpathSha256: launcherEntryDigest },
        brokerGate: { declaredBrokerEntryRealpathSha256: brokerEntryDigest },
        identityRecord: { version: 2, roles: { invocation: 'identity.json', brokerDaemon: 'identity-broker.json' } },
        environmentVariables: [],
      },
      observations: {}, child: {},
      localProcess: block,
      ...over,
    });
    return { scopeNonce, transport, block, record };
  };
  const cleanCopy = (base) => JSON.parse(JSON.stringify(base));

  test('F1 (P2) RED → a Companion PID REUSE during the ancestry refresh participates in the exit adjudication: the replacement\'s absence can never validate the original disappearance', async () => {
    const CAPTURE_NONCE = 'c'.repeat(64);
    const TRANSPORT_NONCE = '9'.repeat(64);
    const ENTRY = '/private/tmp/fixture-installed/skills/rescue/launcher.mjs';
    const BROKER_ENTRY = '/private/tmp/fixture-installed/scripts/zcode-broker.mjs';
    const declaration = { captureDirectory: '/private/tmp/fixture-capture-r7', nonce: CAPTURE_NONCE, entryRealpath: ENTRY, brokerEntryRealpath: BROKER_ENTRY };
    const BASE = Math.floor(Date.now() / 1000) * 1000;
    const COMPANION_START = BASE - 4_000;
    const DAEMON_START = BASE - 2_000;
    const MARKER_EPOCH = BASE - 1_000;
    const admissionEstablished = () => ({
      localProcessObservationVersion: 1, class: 'startup-identity', status: 'established', reason: null,
      identity: { role: 'invocation', nonce: CAPTURE_NONCE, entryRealpath: ENTRY, argv: ['invoke-prepared', 'rescue'], pid: 60100, ppid: 600, firstWriteEpochMs: COMPANION_START + 80, startOriginMs: COMPANION_START + 50, firstWritePreciseMs: COMPANION_START + 80.5 },
      readStartedEpochMs: Date.now(), readEpochMs: Date.now(),
    });
    const osEstablished = (pid, ppid, startIdentity, nonce, startInstant) => ({
      localProcessObservationVersion: 1, class: 'os-live-observation', status: 'established', reason: null,
      observation: { pid, ppid, startIdentity, nonce, startInstantEpochMs: startInstant, ppidChangedFromCapture: null },
      queried: { pid, nonce }, readStartedEpochMs: Date.now(), identityReadEpochMs: Date.now(), readEpochMs: Date.now(), absenceConfirmed: null,
    });
    let companionReads = 0;
    let phaseThree = false;
    let transportReads = 0;
    const held = await runHeldHostTurn({
      gatePath: 'unused-gate',
      holdMs: 300_000,
      budgetMs: 10_000_000_000,
      measurementCutoffSchedule: true,
      // The result anchors on the runtime's OWN phase-4 confirmed absence
      // (companion read 3).
      launch: async () => ({
        result: new Promise((resolve) => {
          const anchor = setInterval(() => { if (companionReads >= 3) { clearInterval(anchor); resolve({ code: 0, stdout: '', stderr: '' }); } }, 5);
          anchor.unref?.();
          setTimeout(() => { clearInterval(anchor); resolve({ code: 0, stdout: '', stderr: '' }); }, 10_000).unref?.();
        }),
        terminate: async () => {},
      }),
      waitForGate: async () => {},
      captureProcessIdentity: async () => ({ pid: 60300, ppid: 60200, nonce: TRANSPORT_NONCE, startIdentity: 'S-TRANSPORT', markerEpochMs: MARKER_EPOCH }),
      readProcessIdentity: async () => undefined,
      terminateProcessIdentity: async () => ({ attempted: true, signalled: 'SIGTERM', exited: true, failure: null }),
      waitForProcessExit: async () => {},
      releaseGate: async () => {},
      localObservation: declaration,
      captureLocalObservationIdentity: async () => admissionEstablished(),
      // Call 1: the phase-2 presence; call 2: the ancestry's REFRESHED
      // companion read — the PID WAS REUSED (the NAMED generation-change
      // verdict); calls >= 3: the phase-4 confirmed absences (of the
      // REPLACEMENT) with the real 30 ms recency gap.
      observeLocalObservationIdentity: async () => {
        companionReads += 1;
        if (companionReads === 1) return osEstablished(60100, 600, 'S-COMPANION', CAPTURE_NONCE, COMPANION_START);
        if (companionReads === 2) {
          return {
            localProcessObservationVersion: 1, class: 'os-live-observation', status: 'unestablished', reason: 'start-identity-generation-changed',
            observation: null, queried: { pid: 60100, nonce: CAPTURE_NONCE },
            readStartedEpochMs: Date.now(), identityReadEpochMs: Date.now(), readEpochMs: Date.now(), absenceConfirmed: null,
          };
        }
        return new Promise((resolve) => setTimeout(() => resolve({
          localProcessObservationVersion: 1, class: 'os-live-observation', status: 'absent', reason: 'no-such-process',
          observation: null, queried: { pid: 60100, nonce: CAPTURE_NONCE },
          readStartedEpochMs: Date.now(), readEpochMs: Date.now(), absenceConfirmed: true,
        }), 30));
      },
      captureLocalBrokerObservationIdentity: async () => ({ ...admissionEstablished(), identity: { role: 'broker-daemon', nonce: CAPTURE_NONCE, entryRealpath: BROKER_ENTRY, configRealpathSha256: 'b'.repeat(64), pid: 60200, ppid: 60100, firstWriteEpochMs: DAEMON_START + 70, startOriginMs: DAEMON_START + 45, firstWritePreciseMs: DAEMON_START + 70.5 } }),
      observeLocalBrokerObservationIdentity: async () => osEstablished(60200, 60100, 'S-DAEMON', CAPTURE_NONCE, DAEMON_START),
      observeLocalTransportObservationIdentity: async () => {
        transportReads += 1;
        phaseThree = true;
        if (transportReads === 1) return osEstablished(60300, 60200, 'S-TRANSPORT', TRANSPORT_NONCE, MARKER_EPOCH - 500);
        // Call 2: the runtime's transport-exit read — confirmed absent
        // (pre-fence; the generation-bound exit evidence).
        return new Promise((resolve) => setTimeout(() => resolve({
          localProcessObservationVersion: 1, class: 'os-live-observation', status: 'absent', reason: 'no-such-process',
          observation: null, queried: { pid: 60300, nonce: TRANSPORT_NONCE },
          readStartedEpochMs: Date.now(), readEpochMs: Date.now(), absenceConfirmed: true,
        }), 30));
      },
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5))),
      // The GATED monotonic clock: the hold walk begins at the runtime's
      // phase-3 completion.
      now: (() => { let value = 0; let gated = false; return () => {
        if (!gated) { if (phaseThree) gated = true; else return 0; }
        value += 500;
        return value;
      }; })(),
      processNonce: TRANSPORT_NONCE,
    });
    const block = held.cleanup.localObservation;
    assert.ok(block);
    // The refresh's generation change must LATCH the reuse: the confirmed
    // absence that follows belongs to the REPLACEMENT, never to the bound
    // generation.
    assert.equal(block.exit?.status, 'unestablished', `the reuse latch fires on the refresh evidence (actual ${JSON.stringify(block.exit ?? null)})`);
    assert.equal(block.exit?.reason, 'pid-start-identity-reused');
    // The offline join of the same block refuses the local layer by name.
    const joined = nativeInterruptionGateDInput({
      status: 'executed', case: 'rescue-interrupt',
      // (Review round 28, Finding 1) the harness mirrors the REAL record
      // composer (driver.mjs:1167): the interrupt carries the termination
      // boundary echo exactly when the runtime stamped one — the block and
      // the record are echo-consistent by construction.
      interrupt: {
        measurementCutoffAtMs: held.cleanup.measurementCutoffAtMs,
        ...(typeof held.cleanup.cleanupBoundaryAtMs === 'number' ? { cleanupBoundaryAtMs: held.cleanup.cleanupBoundaryAtMs } : {}),
      },
      stdoutCaptureDeclaration: {
        gate: { argv: ['invoke-prepared', 'rescue'], declaredEntryRealpathSha256: sha(ENTRY) },
        brokerGate: { declaredBrokerEntryRealpathSha256: sha(BROKER_ENTRY) },
      },
      observations: {}, child: {},
      localProcess: block,
    });
    assert.equal(joined.localProcessDuties?.settled, false, 'the local layer never settles on a reused generation');
    assert.ok(joined.localProcessDuties?.refusals.includes('local-exit-unestablished'), JSON.stringify(joined.localProcessDuties?.refusals));
  });

  test('F1 (P2) RED (offline) → a torn record whose PERSISTED companion refresh carries the generation change never settles (the latch consumes the refresh evidence)', () => {
    const g = armRound7();
    const torn = cleanCopy(g.record());
    torn.localProcess.ancestryEndpointRefreshes.companion = {
      localProcessObservationVersion: 1, class: 'os-live-observation', status: 'unestablished', reason: 'start-identity-generation-changed',
      observation: null, queried: { pid: 60100, nonceSha256: sha(g.scopeNonce) },
      readStartedEpochMs: 4900, identityReadEpochMs: 4950, readEpochMs: 5100, absenceConfirmed: null,
    };
    const consolidated = nativeInterruptionGateDInput(torn).localProcessDuties;
    assert.equal(consolidated.settled, false);
    assert.ok(consolidated.refusals.includes('exit-reuse-latched'), JSON.stringify(consolidated.refusals));
  });

  test('F2 (P2) RED → the reparented daemon refresh provides the LIFETIME bound while the persisted capture-time parent link satisfies the ppid hop (both facts replay offline)', async () => {
    const CAPTURE_NONCE = 'c'.repeat(64);
    const TRANSPORT_NONCE = '9'.repeat(64);
    const ENTRY = '/private/tmp/fixture-installed/skills/rescue/launcher.mjs';
    const BROKER_ENTRY = '/private/tmp/fixture-installed/scripts/zcode-broker.mjs';
    const declaration = { captureDirectory: '/private/tmp/fixture-capture-r7b', nonce: CAPTURE_NONCE, entryRealpath: ENTRY, brokerEntryRealpath: BROKER_ENTRY };
    const BASE = Math.floor(Date.now() / 1000) * 1000;
    const COMPANION_START = BASE - 4_000;
    const DAEMON_START = BASE - 2_000;
    const MARKER_EPOCH = BASE - 1_000;
    const admissionEstablished = () => ({
      localProcessObservationVersion: 1, class: 'startup-identity', status: 'established', reason: null,
      identity: { role: 'invocation', nonce: CAPTURE_NONCE, entryRealpath: ENTRY, argv: ['invoke-prepared', 'rescue'], pid: 60100, ppid: 600, firstWriteEpochMs: COMPANION_START + 80, startOriginMs: COMPANION_START + 50, firstWritePreciseMs: COMPANION_START + 80.5 },
      readStartedEpochMs: Date.now(), readEpochMs: Date.now(),
    });
    const osEstablished = (pid, ppid, startIdentity, nonce, startInstant) => ({
      localProcessObservationVersion: 1, class: 'os-live-observation', status: 'established', reason: null,
      observation: { pid, ppid, startIdentity, nonce, startInstantEpochMs: startInstant, ppidChangedFromCapture: null },
      queried: { pid, nonce }, readStartedEpochMs: Date.now(), identityReadEpochMs: Date.now(), readEpochMs: Date.now(), absenceConfirmed: null,
    });
    let companionReads = 0;
    let daemonReads = 0;
    let phaseThree = false;
    let transportReads = 0;
    const held = await runHeldHostTurn({
      gatePath: 'unused-gate',
      holdMs: 300_000,
      budgetMs: 10_000_000_000,
      measurementCutoffSchedule: true,
      launch: async () => ({
        result: new Promise((resolve) => {
          const anchor = setInterval(() => { if (companionReads >= 3) { clearInterval(anchor); resolve({ code: 0, stdout: '', stderr: '' }); } }, 5);
          anchor.unref?.();
          setTimeout(() => { clearInterval(anchor); resolve({ code: 0, stdout: '', stderr: '' }); }, 10_000).unref?.();
        }),
        terminate: async () => {},
      }),
      waitForGate: async () => {},
      captureProcessIdentity: async () => ({ pid: 60300, ppid: 60200, nonce: TRANSPORT_NONCE, startIdentity: 'S-TRANSPORT', markerEpochMs: MARKER_EPOCH }),
      readProcessIdentity: async () => undefined,
      terminateProcessIdentity: async () => ({ attempted: true, signalled: 'SIGTERM', exited: true, failure: null }),
      waitForProcessExit: async () => {},
      releaseGate: async () => {},
      localObservation: declaration,
      captureLocalObservationIdentity: async () => admissionEstablished(),
      observeLocalObservationIdentity: async () => {
        companionReads += 1;
        if (companionReads === 1) return osEstablished(60100, 600, 'S-COMPANION', CAPTURE_NONCE, COMPANION_START);
        if (companionReads === 2) return osEstablished(60100, 600, 'S-COMPANION', CAPTURE_NONCE, COMPANION_START);
        return new Promise((resolve) => setTimeout(() => resolve({
          localProcessObservationVersion: 1, class: 'os-live-observation', status: 'absent', reason: 'no-such-process',
          observation: null, queried: { pid: 60100, nonce: CAPTURE_NONCE },
          readStartedEpochMs: Date.now(), readEpochMs: Date.now(), absenceConfirmed: true,
        }), 30));
      },
      captureLocalBrokerObservationIdentity: async () => ({ ...admissionEstablished(), identity: { role: 'broker-daemon', nonce: CAPTURE_NONCE, entryRealpath: BROKER_ENTRY, configRealpathSha256: 'b'.repeat(64), pid: 60200, ppid: 60100, firstWriteEpochMs: DAEMON_START + 70, startOriginMs: DAEMON_START + 45, firstWritePreciseMs: DAEMON_START + 70.5 } }),
      // Call 1 (the phase-3 capture-time read): the daemon observed BEFORE
      // the transport marker (its read instant precedes markerEpochMs) with
      // the VALID parent link; call 2 (the ancestry's refresh): the SAME
      // daemon generation, reparented to init (ppid 1), read BEYOND the
      // marker (the lifetime coverage).
      observeLocalBrokerObservationIdentity: async () => {
        daemonReads += 1;
        if (daemonReads === 1) {
          const before = osEstablished(60200, 60100, 'S-DAEMON', CAPTURE_NONCE, DAEMON_START);
          before.readStartedEpochMs = MARKER_EPOCH - 600;
          before.identityReadEpochMs = MARKER_EPOCH - 550;
          before.readEpochMs = MARKER_EPOCH - 500;
          return before;
        }
        return osEstablished(60200, 1, 'S-DAEMON', CAPTURE_NONCE, DAEMON_START);
      },
      observeLocalTransportObservationIdentity: async () => {
        transportReads += 1;
        phaseThree = true;
        if (transportReads === 1) return osEstablished(60300, 60200, 'S-TRANSPORT', TRANSPORT_NONCE, MARKER_EPOCH - 500);
        // Call 2: the runtime's transport-exit read — confirmed absent
        // (pre-fence; the generation-bound exit evidence).
        return new Promise((resolve) => setTimeout(() => resolve({
          localProcessObservationVersion: 1, class: 'os-live-observation', status: 'absent', reason: 'no-such-process',
          observation: null, queried: { pid: 60300, nonce: TRANSPORT_NONCE },
          readStartedEpochMs: Date.now(), readEpochMs: Date.now(), absenceConfirmed: true,
        }), 30));
      },
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5))),
      now: (() => { let value = 0; let gated = false; return () => {
        if (!gated) { if (phaseThree) gated = true; else return 0; }
        value += 500;
        return value;
      }; })(),
      processNonce: TRANSPORT_NONCE,
    });
    const block = held.cleanup.localObservation;
    assert.ok(block);
    // The TWO-FACT rule: the refreshed (reparented) endpoint carries the
    // lifetime coverage; the persisted capture-time parent link satisfies
    // the ppid hop.
    assert.equal(block.ancestry?.companionToTransportAttributed, true, JSON.stringify(block.ancestry?.hops ?? []));
    assert.equal(block.duties?.settled, true, `the duties settle on the two-fact ancestry (duties ${JSON.stringify(block.duties?.duties ?? [])})`);
    assert.equal(block.ancestryEndpoints?.daemon?.observation?.ppid, 1, 'the refreshed (reparented) endpoint is the persisted lifetime evidence');
    assert.equal(block.brokerObservation?.observation?.ppid, 60100, 'the capture-time parent link persists');
    // The offline replay applies the SAME two-fact rule: both facts are in
    // the persisted shape, the join credits the hops.
    const joined = nativeInterruptionGateDInput({
      status: 'executed', case: 'rescue-interrupt',
      // (Review round 28, Finding 1) the harness mirrors the REAL record
      // composer (driver.mjs:1167): the interrupt carries the termination
      // boundary echo exactly when the runtime stamped one — the block and
      // the record are echo-consistent by construction.
      interrupt: {
        measurementCutoffAtMs: held.cleanup.measurementCutoffAtMs,
        ...(typeof held.cleanup.cleanupBoundaryAtMs === 'number' ? { cleanupBoundaryAtMs: held.cleanup.cleanupBoundaryAtMs } : {}),
      },
      stdoutCaptureDeclaration: {
        gate: { argv: ['invoke-prepared', 'rescue'], declaredEntryRealpathSha256: sha(ENTRY) },
        brokerGate: { declaredBrokerEntryRealpathSha256: sha(BROKER_ENTRY) },
      },
      observations: {}, child: {},
      localProcess: block,
    });
    assert.deepEqual(joined.localProcessDuties?.refusals, [], JSON.stringify(joined.localProcessDuties?.refusals));
    assert.equal(joined.localProcessDuties?.settled, true);
  });

  test('the join version registers the round-7 replay growth', () => {
    assert.equal(NATIVE_INTERRUPTION_GATE_D_JOIN_VERSION, 37, 'join v18 (2026-10-30 local-settlement Task 3 review round 14): the tied-absence collection continuation, the transport-exit recency/carried-identity re-adjudication and the incomplete-interval start refusals; v17 (round 13): the identity-read containment check, the FROZEN argv selector enforced over mere persisted agreement, and the persisted block-version gate; v16 (round 12) = the collection-interval validity; v15 (round 11) = the invocation-absence strict tie against the walked horizon, the contradictory-duplicate-duty-slot refusal and the selected-endpoint parentage rule covering a failed refresh; v14 (round 10): the transport PID-reuse latch + the strict transport-absence tie rule; v13 (round 9): the transport exit is re-adjudicated like the invocation (the recency and carried-identity generation rules); v12 (round 8): the transport exit conjunct + the refreshed-presence horizon + the record-based capture parentage; v11 (round 7): the persisted ancestry-refresh evidence joins the offline reuse latch (a generation-changing companion refresh latches exactly like any other same-scope read carrying a generation change); v10 (round 6) = the admission entry-digest/argv-selector binding against the persisted capture declarations and the unsupported-duty-slot refusal; v9 (round 5) = the declared-scope binding, the identity-bearing absence reuse latch and the walked presence horizon; v8 (round 4) = the admission-generation re-adjudication + the endpoint pre-fence/lifetime/marker-epoch re-verification');
  });
});

describe('local-settlement task 3 review round 8 (three P2): the transport owes generation-bound PRE-FENCE exit evidence; the replay horizon includes the refreshed presence; the admitted startup record is capture-time parentage', async () => {
  const { nativeInterruptionGateDInput } = await import('../tools/shell-wait-probe/driver.mjs');
  const { createHash } = await import('node:crypto');
  const sha = (v) => createHash('sha256').update(v).digest('hex');
  const MEASUREMENT_CUTOFF_AT_MS = 20_000;

  /** The round-8 offline positive WITHOUT the transport-exit fact (the RED
   * base: everything else honest). */
  const armRound8 = () => {
    const scopeNonce = 'a'.repeat(64);
    const transport = 'f'.repeat(64);
    const launcherEntryDigest = sha('launcher-entry');
    const brokerEntryDigest = sha('broker-entry');
    const observation = (pid, ppid, startIdentity, scope, readStarted, identityRead, readEpoch, startInstant = 1000) => ({
      localProcessObservationVersion: 1, class: 'os-live-observation', status: 'established', reason: null,
      observation: { pid, ppid, startIdentity, startInstantEpochMs: startInstant, ppidChangedFromCapture: null, nonceSha256: scope },
      queried: { pid, nonceSha256: scope },
      readStartedEpochMs: readStarted, identityReadEpochMs: identityRead, readEpochMs: readEpoch,
      absenceConfirmed: null,
    });
    const block = {
      version: 1, armed: true, clock: 'wall-epoch-ms', nonceSha256: sha(scopeNonce),
      admission: { localProcessObservationVersion: 1, class: 'startup-identity', status: 'established', reason: null, identity: { role: 'invocation', argv: ['invoke-prepared', 'rescue'], entryRealpathSha256: launcherEntryDigest, pid: 60100, ppid: 600, firstWriteEpochMs: 1000, startOriginMs: 1000.1, firstWritePreciseMs: 1100.5, nonceSha256: sha(scopeNonce) }, readStartedEpochMs: 1000, readEpochMs: 1100 },
      presence: observation(60100, 600, 'S-COMPANION', sha(scopeNonce), 1900, 2100, 2300),
      brokerAdmission: { localProcessObservationVersion: 1, class: 'startup-identity', status: 'established', reason: null, identity: { role: 'broker-daemon', entryRealpathSha256: brokerEntryDigest, pid: 60200, ppid: 60100, firstWriteEpochMs: 3000, startOriginMs: 3000.2, firstWritePreciseMs: 3100.6, nonceSha256: sha(scopeNonce) }, readStartedEpochMs: 1900, readEpochMs: 2100 },
      brokerObservation: observation(60200, 60100, 'S-DAEMON', sha(scopeNonce), 3300, 3400, 3500, 3000),
      transportObservation: observation(60300, 60200, 'S-TRANSPORT', sha(transport), 2000, 2200, 2500, 5000),
      ancestryEndpoints: {
        companion: observation(60100, 600, 'S-COMPANION', sha(scopeNonce), 4600, 4650, 4700, 1000),
        daemon: observation(60200, 60100, 'S-DAEMON', sha(scopeNonce), 4600, 4650, 4750, 3000),
        transportMarker: { pid: 60300, ppid: 60200, nonceSha256: sha(transport), markerEpochMs: 4450 },
      },
      ancestryEndpointRefreshes: { companion: null, daemon: null },
      ancestry: { localProcessObservationVersion: 1, class: 'ancestry-join', nonceSha256: sha(scopeNonce), companionToTransportAttributed: true, hops: [
        { hop: 'companion-to-daemon', status: 'established', reason: null },
        { hop: 'daemon-to-transport', status: 'established', reason: null },
      ] },
      duties: { localProcessObservationVersion: 1, class: 'local-duty-verdict', settled: true, duties: [
        { duty: 'invocation-process', status: 'established', reasons: [], identity: { pid: 60100, startIdentity: 'S-COMPANION', nonceSha256: sha(scopeNonce) } },
        { duty: 'broker-daemon', status: 'established', reasons: [], identity: { pid: 60200, startIdentity: 'S-DAEMON', nonceSha256: sha(scopeNonce) } },
        { duty: 'transport-descendant', status: 'established', reasons: [], identity: { pid: 60300, startIdentity: 'S-TRANSPORT', nonceSha256: sha(transport) } },
      ] },
      reads: [{ localProcessObservationVersion: 1, class: 'os-live-observation', status: 'absent', reason: 'no-such-process', observation: null, queried: { pid: 60100, nonceSha256: sha(scopeNonce) }, readStartedEpochMs: 4900, readEpochMs: 5100, absenceConfirmed: true }],
      exit: { localProcessObservationVersion: 1, class: 'exit-absence', status: 'disappeared', reason: null, boundIdentity: { pid: 60100, startIdentity: 'S-COMPANION', nonceSha256: sha(scopeNonce) }, lastVerifiedPresenceEpochMs: 2100, firstVerifiedAbsenceEpochMs: 5100, exitCorroboratedByMeta: false },
      stoppedAt: null, fenceAtMs: null, cutoffAtMs: MEASUREMENT_CUTOFF_AT_MS, cleanupBoundaryAtMs: null, composedAtMs: 6000,
    };
    const record = (over = {}) => ({
      status: 'executed', case: 'rescue-interrupt', executedAt: '2026-10-30T00:00:00.000Z',
      interrupt: { measurementCutoffAtMs: MEASUREMENT_CUTOFF_AT_MS },
      stdoutCaptureDeclaration: {
        preload: 'closure-observe.mjs', preloadSha256: sha('preload-bytes'), maxBytes: 65536,
        gate: { argv: ['invoke-prepared', 'rescue'], declaredEntryRealpathSha256: launcherEntryDigest },
        brokerGate: { declaredBrokerEntryRealpathSha256: brokerEntryDigest },
        identityRecord: { version: 2, roles: { invocation: 'identity.json', brokerDaemon: 'identity-broker.json' } },
        environmentVariables: [],
      },
      observations: {}, child: {},
      localProcess: block,
      ...over,
    });
    /** The generation-bound PRE-FENCE transport-exit fact the acceptance owes. */
    const transportExitFact = (over = {}) => ({
      localProcessObservationVersion: 1, class: 'os-live-observation', status: 'absent', reason: 'no-such-process',
      observation: null, queried: { pid: 60300, nonceSha256: sha(transport) },
      readStartedEpochMs: 5200, identityReadEpochMs: 5250, readEpochMs: 5300, absenceConfirmed: true,
      ...over,
    });
    return { scopeNonce, transport, block, record, transportExitFact };
  };
  const cleanCopy = (base) => JSON.parse(JSON.stringify(base));

  test("F1 (P2) RED → a fully-credited local layer WITHOUT the transport's exit evidence never settles (the transport owes generation-bound PRE-FENCE exit facts)", () => {
    const g = armRound8();
    const consolidated = nativeInterruptionGateDInput(g.record()).localProcessDuties;
    assert.equal(consolidated.settled, false, 'the transport contributes its live observation only — the exit is unproven');
    assert.ok(consolidated.refusals.includes('transport-exit-unestablished'), JSON.stringify(consolidated.refusals));
  });

  test('F1 (P2) RED → a transport exit at/after the cutoff credits nothing (the §25.7 fence applies to the transport exit)', () => {
    const g = armRound8();
    const torn = cleanCopy(g.record());
    torn.localProcess.transportExit = g.transportExitFact({ readStartedEpochMs: 19_500, identityReadEpochMs: 20_000, readEpochMs: MEASUREMENT_CUTOFF_AT_MS + 5_000 });
    const consolidated = nativeInterruptionGateDInput(torn).localProcessDuties;
    assert.equal(consolidated.settled, false);
    assert.ok(consolidated.refusals.includes('transport-exit-at-or-after-fence'), JSON.stringify(consolidated.refusals));
  });

  test('F1 keeper → the generation-bound PRE-FENCE confirmed transport exit completes the local layer', () => {
    const g = armRound8();
    const honest = cleanCopy(g.record());
    honest.localProcess.transportExit = g.transportExitFact();
    const consolidated = nativeInterruptionGateDInput(honest).localProcessDuties;
    assert.deepEqual(consolidated.refusals, [], JSON.stringify(consolidated.refusals));
    assert.equal(consolidated.settled, true);
  });

  test('F2 (P2) RED → the SELECTED refreshed presence walks the horizon: a process positively observed alive AFTER the claimed absence cannot be gone', () => {
    const g = armRound8();
    const torn = cleanCopy(g.record());
    // The refreshed same-generation presence RE-READ at 5500-5600 — AFTER
    // the claimed disappearance at 5100: the horizon walks to the refresh
    // and the absence (collected 4900-5100) overlaps it.
    torn.localProcess.ancestryEndpoints.companion.identityReadEpochMs = 5_500;
    torn.localProcess.ancestryEndpoints.companion.readEpochMs = 5_600;
    // The transport exit is proven (this test isolates the horizon rule).
    torn.localProcess.transportExit = g.transportExitFact();
    const consolidated = nativeInterruptionGateDInput(torn).localProcessDuties;
    assert.equal(consolidated.settled, false, 'positively observed alive after the claimed absence → not gone');
    assert.ok(consolidated.refusals.includes('exit-absence-overlaps-presence'), JSON.stringify(consolidated.refusals));
  });
});

describe('local-settlement task 3 review round 8 (runtime): the runtime composes the transport exit fact; the admitted startup record is capture-time parentage', async () => {
  const { runHeldHostTurn, nativeInterruptionGateDInput, NATIVE_INTERRUPTION_GATE_D_JOIN_VERSION } = await import('../tools/shell-wait-probe/driver.mjs');
  const { createHash } = await import('node:crypto');
  const sha = (v) => createHash('sha256').update(v).digest('hex');

  test('F1 (P2) RED (runtime) → a transport still LIVE at the runtime window close keeps the local layer unsettled (the runtime composes the transport exit fact)', async () => {
    const CAPTURE_NONCE = 'c'.repeat(64);
    const TRANSPORT_NONCE = '9'.repeat(64);
    const ENTRY = '/private/tmp/fixture-installed/skills/rescue/launcher.mjs';
    const BROKER_ENTRY = '/private/tmp/fixture-installed/scripts/zcode-broker.mjs';
    const declaration = { captureDirectory: '/private/tmp/fixture-capture-r8', nonce: CAPTURE_NONCE, entryRealpath: ENTRY, brokerEntryRealpath: BROKER_ENTRY };
    const BASE = Math.floor(Date.now() / 1000) * 1000;
    const COMPANION_START = BASE - 4_000;
    const DAEMON_START = BASE - 2_000;
    const MARKER_EPOCH = BASE - 1_000;
    const admissionEstablished = () => ({
      localProcessObservationVersion: 1, class: 'startup-identity', status: 'established', reason: null,
      identity: { role: 'invocation', nonce: CAPTURE_NONCE, entryRealpath: ENTRY, argv: ['invoke-prepared', 'rescue'], pid: 60100, ppid: 600, firstWriteEpochMs: COMPANION_START + 80, startOriginMs: COMPANION_START + 50, firstWritePreciseMs: COMPANION_START + 80.5 },
      readStartedEpochMs: Date.now(), readEpochMs: Date.now(),
    });
    const osEstablished = (pid, ppid, startIdentity, nonce, startInstant) => ({
      localProcessObservationVersion: 1, class: 'os-live-observation', status: 'established', reason: null,
      observation: { pid, ppid, startIdentity, nonce, startInstantEpochMs: startInstant, ppidChangedFromCapture: null },
      queried: { pid, nonce }, readStartedEpochMs: Date.now(), identityReadEpochMs: Date.now(), readEpochMs: Date.now(), absenceConfirmed: null,
    });
    let companionReads = 0;
    let phaseThree = false;
    const held = await runHeldHostTurn({
      gatePath: 'unused-gate',
      holdMs: 300_000,
      budgetMs: 10_000_000_000,
      measurementCutoffSchedule: true,
      launch: async () => ({
        result: new Promise((resolve) => {
          const anchor = setInterval(() => { if (companionReads >= 3) { clearInterval(anchor); resolve({ code: 0, stdout: '', stderr: '' }); } }, 5);
          anchor.unref?.();
          setTimeout(() => { clearInterval(anchor); resolve({ code: 0, stdout: '', stderr: '' }); }, 10_000).unref?.();
        }),
        terminate: async () => {},
      }),
      waitForGate: async () => {},
      captureProcessIdentity: async () => ({ pid: 60300, ppid: 60200, nonce: TRANSPORT_NONCE, startIdentity: 'S-TRANSPORT', markerEpochMs: MARKER_EPOCH }),
      readProcessIdentity: async () => undefined,
      terminateProcessIdentity: async () => ({ attempted: true, signalled: 'SIGTERM', exited: true, failure: null }),
      waitForProcessExit: async () => {},
      releaseGate: async () => {},
      localObservation: declaration,
      captureLocalObservationIdentity: async () => admissionEstablished(),
      observeLocalObservationIdentity: async () => {
        companionReads += 1;
        if (companionReads === 1) return osEstablished(60100, 600, 'S-COMPANION', CAPTURE_NONCE, COMPANION_START);
        if (companionReads === 2) return osEstablished(60100, 600, 'S-COMPANION', CAPTURE_NONCE, COMPANION_START);
        return new Promise((resolve) => setTimeout(() => resolve({
          localProcessObservationVersion: 1, class: 'os-live-observation', status: 'absent', reason: 'no-such-process',
          observation: null, queried: { pid: 60100, nonce: CAPTURE_NONCE },
          readStartedEpochMs: Date.now(), readEpochMs: Date.now(), absenceConfirmed: true,
        }), 30));
      },
      captureLocalBrokerObservationIdentity: async () => ({ ...admissionEstablished(), identity: { role: 'broker-daemon', nonce: CAPTURE_NONCE, entryRealpath: BROKER_ENTRY, configRealpathSha256: 'b'.repeat(64), pid: 60200, ppid: 60100, firstWriteEpochMs: DAEMON_START + 70, startOriginMs: DAEMON_START + 45, firstWritePreciseMs: DAEMON_START + 70.5 } }),
      observeLocalBrokerObservationIdentity: async () => osEstablished(60200, 60100, 'S-DAEMON', CAPTURE_NONCE, DAEMON_START),
      // Call 1: the transport observed ALIVE (its duty fact); call 2 (the
      // runtime's transport-exit read): STILL ALIVE — the transport never
      // exited inside the observation window, so the local layer cannot
      // prove its pre-fence exit and never settles.
      observeLocalTransportObservationIdentity: async () => {
        phaseThree = true;
        phaseThree = true;
        return osEstablished(60300, 60200, 'S-TRANSPORT', TRANSPORT_NONCE, MARKER_EPOCH - 500);
      },
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5))),
      now: (() => { let value = 0; let gated = false; return () => {
        if (!gated) { if (phaseThree) gated = true; else return 0; }
        value += 500;
        return value;
      }; })(),
      processNonce: TRANSPORT_NONCE,
    });
    const block = held.cleanup.localObservation;
    assert.ok(block);
    assert.ok(block.transportExit, 'the runtime composes the transport exit fact with the block');
    assert.equal(block.transportExit?.status, 'established', 'the honest still-live transport fact persists');
    const joined = nativeInterruptionGateDInput({
      status: 'executed', case: 'rescue-interrupt',
      // (Review round 28, Finding 1) the harness mirrors the REAL record
      // composer (driver.mjs:1167): the interrupt carries the termination
      // boundary echo exactly when the runtime stamped one — the block and
      // the record are echo-consistent by construction.
      interrupt: {
        measurementCutoffAtMs: held.cleanup.measurementCutoffAtMs,
        ...(typeof held.cleanup.cleanupBoundaryAtMs === 'number' ? { cleanupBoundaryAtMs: held.cleanup.cleanupBoundaryAtMs } : {}),
      },
      stdoutCaptureDeclaration: {
        gate: { argv: ['invoke-prepared', 'rescue'], declaredEntryRealpathSha256: sha(ENTRY) },
        brokerGate: { declaredBrokerEntryRealpathSha256: sha(BROKER_ENTRY) },
      },
      observations: {}, child: {},
      localProcess: block,
    });
    assert.equal(joined.localProcessDuties?.settled, false, 'a transport never proven exited keeps the local layer unsettled');
    assert.ok(joined.localProcessDuties?.refusals.includes('transport-exit-unestablished'), JSON.stringify(joined.localProcessDuties?.refusals));
  });

  test("F3 (P2) RED → the ADMITTED startup record is capture-time parentage when the FIRST broker OS read is already reparented (the Companion exited before the broker's first read)", async () => {
    const CAPTURE_NONCE = 'c'.repeat(64);
    const TRANSPORT_NONCE = '9'.repeat(64);
    const ENTRY = '/private/tmp/fixture-installed/skills/rescue/launcher.mjs';
    const BROKER_ENTRY = '/private/tmp/fixture-installed/scripts/zcode-broker.mjs';
    const declaration = { captureDirectory: '/private/tmp/fixture-capture-r8b', nonce: CAPTURE_NONCE, entryRealpath: ENTRY, brokerEntryRealpath: BROKER_ENTRY };
    const BASE = Math.floor(Date.now() / 1000) * 1000;
    const COMPANION_START = BASE - 4_000;
    const DAEMON_START = BASE - 2_000;
    const MARKER_EPOCH = BASE - 1_000;
    const admissionEstablished = () => ({
      localProcessObservationVersion: 1, class: 'startup-identity', status: 'established', reason: null,
      identity: { role: 'invocation', nonce: CAPTURE_NONCE, entryRealpath: ENTRY, argv: ['invoke-prepared', 'rescue'], pid: 60100, ppid: 600, firstWriteEpochMs: COMPANION_START + 80, startOriginMs: COMPANION_START + 50, firstWritePreciseMs: COMPANION_START + 80.5 },
      readStartedEpochMs: Date.now(), readEpochMs: Date.now(),
    });
    const osEstablished = (pid, ppid, startIdentity, nonce, startInstant) => ({
      localProcessObservationVersion: 1, class: 'os-live-observation', status: 'established', reason: null,
      observation: { pid, ppid, startIdentity, nonce, startInstantEpochMs: startInstant, ppidChangedFromCapture: null },
      queried: { pid, nonce }, readStartedEpochMs: Date.now(), identityReadEpochMs: Date.now(), readEpochMs: Date.now(), absenceConfirmed: null,
    });
    let companionReads = 0;
    let transportReads = 0;
    let phaseThree = false;
    const held = await runHeldHostTurn({
      gatePath: 'unused-gate',
      holdMs: 300_000,
      budgetMs: 10_000_000_000,
      measurementCutoffSchedule: true,
      launch: async () => ({
        result: new Promise((resolve) => {
          const anchor = setInterval(() => { if (companionReads >= 3) { clearInterval(anchor); resolve({ code: 0, stdout: '', stderr: '' }); } }, 5);
          anchor.unref?.();
          setTimeout(() => { clearInterval(anchor); resolve({ code: 0, stdout: '', stderr: '' }); }, 10_000).unref?.();
        }),
        terminate: async () => {},
      }),
      waitForGate: async () => {},
      captureProcessIdentity: async () => ({ pid: 60300, ppid: 60200, nonce: TRANSPORT_NONCE, startIdentity: 'S-TRANSPORT', markerEpochMs: MARKER_EPOCH }),
      readProcessIdentity: async () => undefined,
      terminateProcessIdentity: async () => ({ attempted: true, signalled: 'SIGTERM', exited: true, failure: null }),
      waitForProcessExit: async () => {},
      releaseGate: async () => {},
      localObservation: declaration,
      captureLocalObservationIdentity: async () => admissionEstablished(),
      observeLocalObservationIdentity: async () => {
        companionReads += 1;
        if (companionReads === 1) return osEstablished(60100, 600, 'S-COMPANION', CAPTURE_NONCE, COMPANION_START);
        if (companionReads === 2) return osEstablished(60100, 600, 'S-COMPANION', CAPTURE_NONCE, COMPANION_START);
        return new Promise((resolve) => setTimeout(() => resolve({
          localProcessObservationVersion: 1, class: 'os-live-observation', status: 'absent', reason: 'no-such-process',
          observation: null, queried: { pid: 60100, nonce: CAPTURE_NONCE },
          readStartedEpochMs: Date.now(), readEpochMs: Date.now(), absenceConfirmed: true,
        }), 30));
      },
      // The broker's ADMITTED record captures the Companion (ppid 60100) at
      // spawn; its FIRST OS read already shows ppid 1 — the Companion exited
      // between its presence observation and the broker's first read.
      captureLocalBrokerObservationIdentity: async () => ({ ...admissionEstablished(), identity: { role: 'broker-daemon', nonce: CAPTURE_NONCE, entryRealpath: BROKER_ENTRY, configRealpathSha256: 'b'.repeat(64), pid: 60200, ppid: 60100, firstWriteEpochMs: DAEMON_START + 70, startOriginMs: DAEMON_START + 45, firstWritePreciseMs: DAEMON_START + 70.5 } }),
      observeLocalBrokerObservationIdentity: async () => osEstablished(60200, 1, 'S-DAEMON', CAPTURE_NONCE, DAEMON_START),
      observeLocalTransportObservationIdentity: async () => {
        transportReads += 1;
        phaseThree = true;
        if (transportReads === 1) return osEstablished(60300, 60200, 'S-TRANSPORT', TRANSPORT_NONCE, MARKER_EPOCH - 500);
        return new Promise((resolve) => setTimeout(() => resolve({
          localProcessObservationVersion: 1, class: 'os-live-observation', status: 'absent', reason: 'no-such-process',
          observation: null, queried: { pid: 60300, nonce: TRANSPORT_NONCE },
          readStartedEpochMs: Date.now(), readEpochMs: Date.now(), absenceConfirmed: true,
        }), 30));
      },
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5))),
      now: (() => { let value = 0; let gated = false; return () => {
        if (!gated) { if (phaseThree) gated = true; else return 0; }
        value += 500;
        return value;
      }; })(),
      processNonce: TRANSPORT_NONCE,
    });
    const block = held.cleanup.localObservation;
    assert.ok(block);
    // The startup RECORD's generation-bound parent link is capture-time
    // evidence: the ancestry attributes and the duties settle.
    assert.equal(block.ancestry?.companionToTransportAttributed, true, JSON.stringify(block.ancestry?.hops ?? []));
    assert.equal(block.duties?.settled, true, `the duties settle (duties ${JSON.stringify(block.duties?.duties ?? [])})`);
    const joined = nativeInterruptionGateDInput({
      status: 'executed', case: 'rescue-interrupt',
      // (Review round 28, Finding 1) the harness mirrors the REAL record
      // composer (driver.mjs:1167): the interrupt carries the termination
      // boundary echo exactly when the runtime stamped one — the block and
      // the record are echo-consistent by construction.
      interrupt: {
        measurementCutoffAtMs: held.cleanup.measurementCutoffAtMs,
        ...(typeof held.cleanup.cleanupBoundaryAtMs === 'number' ? { cleanupBoundaryAtMs: held.cleanup.cleanupBoundaryAtMs } : {}),
      },
      stdoutCaptureDeclaration: {
        gate: { argv: ['invoke-prepared', 'rescue'], declaredEntryRealpathSha256: sha(ENTRY) },
        brokerGate: { declaredBrokerEntryRealpathSha256: sha(BROKER_ENTRY) },
      },
      observations: {}, child: {},
      localProcess: block,
    });
    assert.deepEqual(joined.localProcessDuties?.refusals, [], JSON.stringify(joined.localProcessDuties?.refusals));
    assert.equal(joined.localProcessDuties?.settled, true);
  });

  test('the join version registers the round-8 replay growth', () => {
    assert.equal(NATIVE_INTERRUPTION_GATE_D_JOIN_VERSION, 37, 'join v18 (2026-10-30 local-settlement Task 3 review round 14): the tied-absence collection continuation, the transport-exit recency/carried-identity re-adjudication and the incomplete-interval start refusals; v17 (round 13): the identity-read containment check, the FROZEN argv selector enforced over mere persisted agreement, and the persisted block-version gate; v16 (round 12) = the collection-interval validity; v15 (round 11) = the invocation-absence strict tie against the walked horizon, the contradictory-duplicate-duty-slot refusal and the selected-endpoint parentage rule covering a failed refresh; v14 (round 10): the transport PID-reuse latch + the strict transport-absence tie rule; v13 (round 9): the transport exit is re-adjudicated like the invocation (the recency and carried-identity generation rules); v12 (round 8): the transport owes generation-bound PRE-FENCE exit evidence (the composed transport-exit conjunct), the refreshed presence walks the replay horizon/supersession, and the admitted startup record is capture-time parentage; v11 (round 7) = the persisted ancestry-refresh evidence joining the offline reuse latch; v10 (round 6) = the admission entry-digest/argv-selector binding and the unsupported-duty-slot refusal; v9 (round 5) = the declared-scope binding, the identity-bearing absence reuse latch and the walked presence horizon; v8 (round 4) = the admission-generation re-adjudication + the endpoint pre-fence/lifetime/marker-epoch re-verification');
  });
});

describe('local-settlement task 3 review round 9 (three P2 + one P3): the transport exit is re-adjudicated like the invocation (recency/generation/carried-identity), the transport exit retries until confirmed absence, the null boundIdentity is guarded, and the abort listeners are released', async () => {
  const { runHeldHostTurn, nativeInterruptionGateDInput, NATIVE_INTERRUPTION_GATE_D_JOIN_VERSION } = await import('../tools/shell-wait-probe/driver.mjs');
  const { createHash } = await import('node:crypto');
  const sha = (v) => createHash('sha256').update(v).digest('hex');
  const MEASUREMENT_CUTOFF_AT_MS = 20_000;

  /** The round-9 offline positive (the round-8 keeper + the named-variant
   * arms for the transport-exit re-adjudication). */
  const armRound9 = () => {
    const scopeNonce = 'a'.repeat(64);
    const transport = 'f'.repeat(64);
    const launcherEntryDigest = sha('launcher-entry');
    const brokerEntryDigest = sha('broker-entry');
    const observation = (pid, ppid, startIdentity, scope, readStarted, identityRead, readEpoch, startInstant = 1000) => ({
      localProcessObservationVersion: 1, class: 'os-live-observation', status: 'established', reason: null,
      observation: { pid, ppid, startIdentity, startInstantEpochMs: startInstant, ppidChangedFromCapture: null, nonceSha256: scope },
      queried: { pid, nonceSha256: scope },
      readStartedEpochMs: readStarted, identityReadEpochMs: identityRead, readEpochMs: readEpoch,
      absenceConfirmed: null,
    });
    const block = {
      version: 1, armed: true, clock: 'wall-epoch-ms', nonceSha256: sha(scopeNonce),
      admission: { localProcessObservationVersion: 1, class: 'startup-identity', status: 'established', reason: null, identity: { role: 'invocation', argv: ['invoke-prepared', 'rescue'], entryRealpathSha256: launcherEntryDigest, pid: 60100, ppid: 600, firstWriteEpochMs: 1000, startOriginMs: 1000.1, firstWritePreciseMs: 1100.5, nonceSha256: sha(scopeNonce) }, readStartedEpochMs: 1000, readEpochMs: 1100 },
      presence: observation(60100, 600, 'S-COMPANION', sha(scopeNonce), 1900, 2100, 2300),
      brokerAdmission: { localProcessObservationVersion: 1, class: 'startup-identity', status: 'established', reason: null, identity: { role: 'broker-daemon', entryRealpathSha256: brokerEntryDigest, pid: 60200, ppid: 60100, firstWriteEpochMs: 3000, startOriginMs: 3000.2, firstWritePreciseMs: 3100.6, nonceSha256: sha(scopeNonce) }, readStartedEpochMs: 1900, readEpochMs: 2100 },
      brokerObservation: observation(60200, 60100, 'S-DAEMON', sha(scopeNonce), 3300, 3400, 3500, 3000),
      transportObservation: observation(60300, 60200, 'S-TRANSPORT', sha(transport), 2000, 2200, 2500, 5000),
      ancestryEndpoints: {
        companion: observation(60100, 600, 'S-COMPANION', sha(scopeNonce), 4600, 4650, 4700, 1000),
        daemon: observation(60200, 60100, 'S-DAEMON', sha(scopeNonce), 4600, 4650, 4750, 3000),
        transportMarker: { pid: 60300, ppid: 60200, nonceSha256: sha(transport), markerEpochMs: 4450 },
      },
      ancestryEndpointRefreshes: { companion: null, daemon: null },
      ancestry: { localProcessObservationVersion: 1, class: 'ancestry-join', nonceSha256: sha(scopeNonce), companionToTransportAttributed: true, hops: [
        { hop: 'companion-to-daemon', status: 'established', reason: null },
        { hop: 'daemon-to-transport', status: 'established', reason: null },
      ] },
      duties: { localProcessObservationVersion: 1, class: 'local-duty-verdict', settled: true, duties: [
        { duty: 'invocation-process', status: 'established', reasons: [], identity: { pid: 60100, startIdentity: 'S-COMPANION', nonceSha256: sha(scopeNonce) } },
        { duty: 'broker-daemon', status: 'established', reasons: [], identity: { pid: 60200, startIdentity: 'S-DAEMON', nonceSha256: sha(scopeNonce) } },
        { duty: 'transport-descendant', status: 'established', reasons: [], identity: { pid: 60300, startIdentity: 'S-TRANSPORT', nonceSha256: sha(transport) } },
      ] },
      transportExit: { localProcessObservationVersion: 1, class: 'os-live-observation', status: 'absent', reason: 'no-such-process', observation: null, queried: { pid: 60300, nonceSha256: sha(transport) }, readStartedEpochMs: 5200, identityReadEpochMs: 5250, readEpochMs: 5300, absenceConfirmed: true },
      reads: [{ localProcessObservationVersion: 1, class: 'os-live-observation', status: 'absent', reason: 'no-such-process', observation: null, queried: { pid: 60100, nonceSha256: sha(scopeNonce) }, readStartedEpochMs: 4900, readEpochMs: 5100, absenceConfirmed: true }],
      exit: { localProcessObservationVersion: 1, class: 'exit-absence', status: 'disappeared', reason: null, boundIdentity: { pid: 60100, startIdentity: 'S-COMPANION', nonceSha256: sha(scopeNonce) }, lastVerifiedPresenceEpochMs: 2100, firstVerifiedAbsenceEpochMs: 5100, exitCorroboratedByMeta: false },
      stoppedAt: null, fenceAtMs: null, cutoffAtMs: MEASUREMENT_CUTOFF_AT_MS, cleanupBoundaryAtMs: null, composedAtMs: 6000,
    };
    const record = (over = {}) => ({
      status: 'executed', case: 'rescue-interrupt', executedAt: '2026-10-30T00:00:00.000Z',
      interrupt: { measurementCutoffAtMs: MEASUREMENT_CUTOFF_AT_MS },
      stdoutCaptureDeclaration: {
        preload: 'closure-observe.mjs', preloadSha256: sha('preload-bytes'), maxBytes: 65536,
        gate: { argv: ['invoke-prepared', 'rescue'], declaredEntryRealpathSha256: launcherEntryDigest },
        brokerGate: { declaredBrokerEntryRealpathSha256: brokerEntryDigest },
        identityRecord: { version: 2, roles: { invocation: 'identity.json', brokerDaemon: 'identity-broker.json' } },
        environmentVariables: [],
      },
      observations: {}, child: {},
      localProcess: block,
      ...over,
    });
    return { scopeNonce, transport, block, record };
  };
  const cleanCopy = (base) => JSON.parse(JSON.stringify(base));

  test('F1 (P2) RED → a transport absence whose collection started BEFORE its verified presence never credits (the recency rule applies to the transport exit)', () => {
    const g = armRound9();
    const torn = cleanCopy(g.record());
    torn.localProcess.transportExit.readStartedEpochMs = 2;
    torn.localProcess.transportExit.identityReadEpochMs = 3;
    torn.localProcess.transportExit.readEpochMs = 2_100;
    const consolidated = nativeInterruptionGateDInput(torn).localProcessDuties;
    assert.equal(consolidated.settled, false, 'an absence predating the transport presence proves nothing about what followed it');
    assert.ok(consolidated.refusals.includes('transport-exit-overlaps-presence'), JSON.stringify(consolidated.refusals));
  });

  test('F1 (P2) RED → a transport absence carrying a FOREIGN observed identity is replacement evidence, never this generation\'s death', () => {
    const g = armRound9();
    const torn = cleanCopy(g.record());
    torn.localProcess.transportExit.observedStartIdentity = 'S-TRANSPORT-REUSE';
    const consolidated = nativeInterruptionGateDInput(torn).localProcessDuties;
    assert.equal(consolidated.settled, false);
    assert.ok(consolidated.refusals.includes('transport-exit-generation-foreign'), JSON.stringify(consolidated.refusals));
  });

  test('F2 (P2) RED → the transport exit RETRIES: a still-live first exit read is not final — the later lawful exit inside the window credits', async () => {
    const CAPTURE_NONCE = 'c'.repeat(64);
    const TRANSPORT_NONCE = '9'.repeat(64);
    const ENTRY = '/private/tmp/fixture-installed/skills/rescue/launcher.mjs';
    const BROKER_ENTRY = '/private/tmp/fixture-installed/scripts/zcode-broker.mjs';
    const declaration = { captureDirectory: '/private/tmp/fixture-capture-r9', nonce: CAPTURE_NONCE, entryRealpath: ENTRY, brokerEntryRealpath: BROKER_ENTRY };
    const BASE = Math.floor(Date.now() / 1000) * 1000;
    const COMPANION_START = BASE - 4_000;
    const DAEMON_START = BASE - 2_000;
    const MARKER_EPOCH = BASE - 1_000;
    const admissionEstablished = () => ({
      localProcessObservationVersion: 1, class: 'startup-identity', status: 'established', reason: null,
      identity: { role: 'invocation', nonce: CAPTURE_NONCE, entryRealpath: ENTRY, argv: ['invoke-prepared', 'rescue'], pid: 60100, ppid: 600, firstWriteEpochMs: COMPANION_START + 80, startOriginMs: COMPANION_START + 50, firstWritePreciseMs: COMPANION_START + 80.5 },
      readStartedEpochMs: Date.now(), readEpochMs: Date.now(),
    });
    const osEstablished = (pid, ppid, startIdentity, nonce, startInstant) => ({
      localProcessObservationVersion: 1, class: 'os-live-observation', status: 'established', reason: null,
      observation: { pid, ppid, startIdentity, nonce, startInstantEpochMs: startInstant, ppidChangedFromCapture: null },
      queried: { pid, nonce }, readStartedEpochMs: Date.now(), identityReadEpochMs: Date.now(), readEpochMs: Date.now(), absenceConfirmed: null,
    });
    let companionReads = 0;
    let transportReads = 0;
    let phaseThree = false;
    const held = await runHeldHostTurn({
      gatePath: 'unused-gate',
      holdMs: 300_000,
      budgetMs: 10_000_000_000,
      measurementCutoffSchedule: true,
      launch: async () => ({
        result: new Promise((resolve) => {
          const anchor = setInterval(() => { if (companionReads >= 3) { clearInterval(anchor); resolve({ code: 0, stdout: '', stderr: '' }); } }, 5);
          anchor.unref?.();
          setTimeout(() => { clearInterval(anchor); resolve({ code: 0, stdout: '', stderr: '' }); }, 10_000).unref?.();
        }),
        terminate: async () => {},
      }),
      waitForGate: async () => {},
      captureProcessIdentity: async () => ({ pid: 60300, ppid: 60200, nonce: TRANSPORT_NONCE, startIdentity: 'S-TRANSPORT', markerEpochMs: MARKER_EPOCH }),
      readProcessIdentity: async () => undefined,
      terminateProcessIdentity: async () => ({ attempted: true, signalled: 'SIGTERM', exited: true, failure: null }),
      waitForProcessExit: async () => {},
      releaseGate: async () => {},
      localObservation: declaration,
      captureLocalObservationIdentity: async () => admissionEstablished(),
      observeLocalObservationIdentity: async () => {
        companionReads += 1;
        if (companionReads === 1) return osEstablished(60100, 600, 'S-COMPANION', CAPTURE_NONCE, COMPANION_START);
        if (companionReads === 2) return osEstablished(60100, 600, 'S-COMPANION', CAPTURE_NONCE, COMPANION_START);
        return new Promise((resolve) => setTimeout(() => resolve({
          localProcessObservationVersion: 1, class: 'os-live-observation', status: 'absent', reason: 'no-such-process',
          observation: null, queried: { pid: 60100, nonce: CAPTURE_NONCE },
          readStartedEpochMs: Date.now(), readEpochMs: Date.now(), absenceConfirmed: true,
        }), 30));
      },
      captureLocalBrokerObservationIdentity: async () => ({ ...admissionEstablished(), identity: { role: 'broker-daemon', nonce: CAPTURE_NONCE, entryRealpath: BROKER_ENTRY, configRealpathSha256: 'b'.repeat(64), pid: 60200, ppid: 60100, firstWriteEpochMs: DAEMON_START + 70, startOriginMs: DAEMON_START + 45, firstWritePreciseMs: DAEMON_START + 70.5 } }),
      observeLocalBrokerObservationIdentity: async () => osEstablished(60200, 60100, 'S-DAEMON', CAPTURE_NONCE, DAEMON_START),
      // Call 1: the transport observed ALIVE (its duty fact). Call 2: the
      // FIRST transport-exit read — STILL ALIVE (the transport outlives the
      // Companion). Call 3 (the RETRY): the confirmed absence — the lawful
      // exit inside the collection window.
      observeLocalTransportObservationIdentity: async () => {
        transportReads += 1;
        phaseThree = true;
        if (transportReads === 1) return osEstablished(60300, 60200, 'S-TRANSPORT', TRANSPORT_NONCE, MARKER_EPOCH - 500);
        if (transportReads === 2) return osEstablished(60300, 60200, 'S-TRANSPORT', TRANSPORT_NONCE, MARKER_EPOCH - 500);
        return new Promise((resolve) => setTimeout(() => resolve({
          localProcessObservationVersion: 1, class: 'os-live-observation', status: 'absent', reason: 'no-such-process',
          observation: null, queried: { pid: 60300, nonce: TRANSPORT_NONCE },
          readStartedEpochMs: Date.now(), readEpochMs: Date.now(), absenceConfirmed: true,
        }), 30));
      },
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5))),
      now: (() => { let value = 0; let gated = false; return () => {
        if (!gated) { if (phaseThree) gated = true; else return 0; }
        value += 500;
        return value;
      }; })(),
      processNonce: TRANSPORT_NONCE,
    });
    const block = held.cleanup.localObservation;
    assert.ok(block);
    // The retry observed the lawful exit: the persisted transport exit is
    // the CONFIRMED ABSENCE, never the earlier still-live read.
    assert.equal(block.transportExit?.status, 'absent', `the retried transport exit is the confirmed absence (actual ${JSON.stringify(block.transportExit ?? null)})`);
    assert.equal(block.transportExit?.absenceConfirmed, true);
    const joined = nativeInterruptionGateDInput({
      status: 'executed', case: 'rescue-interrupt',
      // (Review round 28, Finding 1) the harness mirrors the REAL record
      // composer (driver.mjs:1167): the interrupt carries the termination
      // boundary echo exactly when the runtime stamped one — the block and
      // the record are echo-consistent by construction.
      interrupt: {
        measurementCutoffAtMs: held.cleanup.measurementCutoffAtMs,
        ...(typeof held.cleanup.cleanupBoundaryAtMs === 'number' ? { cleanupBoundaryAtMs: held.cleanup.cleanupBoundaryAtMs } : {}),
      },
      stdoutCaptureDeclaration: {
        gate: { argv: ['invoke-prepared', 'rescue'], declaredEntryRealpathSha256: sha(ENTRY) },
        brokerGate: { declaredBrokerEntryRealpathSha256: sha(BROKER_ENTRY) },
      },
      observations: {}, child: {},
      localProcess: block,
    });
    assert.deepEqual(joined.localProcessDuties?.refusals, [], JSON.stringify(joined.localProcessDuties?.refusals));
    assert.equal(joined.localProcessDuties?.settled, true);
  });

  test('F3 (P2) RED → a persisted disappeared verdict with a NULL boundIdentity is the named unsettled verdict, never a TypeError', () => {
    const g = armRound9();
    const torn = cleanCopy(g.record());
    torn.localProcess.exit.boundIdentity = null;
    let consolidated;
    assert.doesNotThrow(() => {
      consolidated = nativeInterruptionGateDInput(torn).localProcessDuties;
    }, 'the replay returns the named unsettled verdict, never a null-dereference TypeError');
    assert.equal(consolidated.settled, false);
    assert.ok(consolidated.refusals.includes('exit-bound-identity-foreign'), JSON.stringify(consolidated.refusals));
  });

  test('the join version registers the round-9 replay growth', () => {
    assert.equal(NATIVE_INTERRUPTION_GATE_D_JOIN_VERSION, 37, 'join v18 (2026-10-30 local-settlement Task 3 review round 14): the tied-absence collection continuation, the transport-exit recency/carried-identity re-adjudication and the incomplete-interval start refusals; v17 (round 13): the identity-read containment check, the FROZEN argv selector enforced over mere persisted agreement, and the persisted block-version gate; v16 (round 12) = the collection-interval validity; v15 (round 11) = the invocation-absence strict tie against the walked horizon, the contradictory-duplicate-duty-slot refusal and the selected-endpoint parentage rule covering a failed refresh; v14 (round 10): the transport PID-reuse latch + the strict transport-absence tie rule; v13 (round 9): the transport exit is re-adjudicated like the invocation (recency against the transport presence, the carried-identity generation rule); v12 (round 8) = the generation-bound PRE-FENCE transport-exit conjunct, the refreshed-presence horizon/supersession and the admitted-record capture-time parentage; v11 (round 7) = the persisted ancestry-refresh evidence joining the offline reuse latch; v10 (round 6) = the admission entry-digest/argv-selector binding and the unsupported-duty-slot refusal; v9 (round 5) = the declared-scope binding, the identity-bearing absence reuse latch and the walked presence horizon; v8 (round 4) = the admission-generation re-adjudication + the endpoint pre-fence/lifetime/marker-epoch re-verification');
  });
});

describe('local-settlement task 3 review round 10 (two P2): a transport PID reuse in the exit retry loop latches terminally (the replacement absence never converts it) and the transport absence tie never credits', async () => {
  const { runHeldHostTurn, nativeInterruptionGateDInput, NATIVE_INTERRUPTION_GATE_D_JOIN_VERSION } = await import('../tools/shell-wait-probe/driver.mjs');
  const { createHash } = await import('node:crypto');
  const sha = (v) => createHash('sha256').update(v).digest('hex');
  const MEASUREMENT_CUTOFF_AT_MS = 20_000;

  const armRound10 = () => {
    const scopeNonce = 'a'.repeat(64);
    const transport = 'f'.repeat(64);
    const launcherEntryDigest = sha('launcher-entry');
    const brokerEntryDigest = sha('broker-entry');
    const observation = (pid, ppid, startIdentity, scope, readStarted, identityRead, readEpoch, startInstant = 1000) => ({
      localProcessObservationVersion: 1, class: 'os-live-observation', status: 'established', reason: null,
      observation: { pid, ppid, startIdentity, startInstantEpochMs: startInstant, ppidChangedFromCapture: null, nonceSha256: scope },
      queried: { pid, nonceSha256: scope },
      readStartedEpochMs: readStarted, identityReadEpochMs: identityRead, readEpochMs: readEpoch,
      absenceConfirmed: null,
    });
    const block = {
      version: 1, armed: true, clock: 'wall-epoch-ms', nonceSha256: sha(scopeNonce),
      admission: { localProcessObservationVersion: 1, class: 'startup-identity', status: 'established', reason: null, identity: { role: 'invocation', argv: ['invoke-prepared', 'rescue'], entryRealpathSha256: launcherEntryDigest, pid: 60100, ppid: 600, firstWriteEpochMs: 1000, startOriginMs: 1000.1, firstWritePreciseMs: 1100.5, nonceSha256: sha(scopeNonce) }, readStartedEpochMs: 1000, readEpochMs: 1100 },
      presence: observation(60100, 600, 'S-COMPANION', sha(scopeNonce), 1900, 2100, 2300),
      brokerAdmission: { localProcessObservationVersion: 1, class: 'startup-identity', status: 'established', reason: null, identity: { role: 'broker-daemon', entryRealpathSha256: brokerEntryDigest, pid: 60200, ppid: 60100, firstWriteEpochMs: 3000, startOriginMs: 3000.2, firstWritePreciseMs: 3100.6, nonceSha256: sha(scopeNonce) }, readStartedEpochMs: 1900, readEpochMs: 2100 },
      brokerObservation: observation(60200, 60100, 'S-DAEMON', sha(scopeNonce), 3300, 3400, 3500, 3000),
      transportObservation: observation(60300, 60200, 'S-TRANSPORT', sha(transport), 2000, 2200, 2500, 5000),
      ancestryEndpoints: {
        companion: observation(60100, 600, 'S-COMPANION', sha(scopeNonce), 4600, 4650, 4700, 1000),
        daemon: observation(60200, 60100, 'S-DAEMON', sha(scopeNonce), 4600, 4650, 4750, 3000),
        transportMarker: { pid: 60300, ppid: 60200, nonceSha256: sha(transport), markerEpochMs: 4450 },
      },
      ancestryEndpointRefreshes: { companion: null, daemon: null },
      ancestry: { localProcessObservationVersion: 1, class: 'ancestry-join', nonceSha256: sha(scopeNonce), companionToTransportAttributed: true, hops: [
        { hop: 'companion-to-daemon', status: 'established', reason: null },
        { hop: 'daemon-to-transport', status: 'established', reason: null },
      ] },
      duties: { localProcessObservationVersion: 1, class: 'local-duty-verdict', settled: true, duties: [
        { duty: 'invocation-process', status: 'established', reasons: [], identity: { pid: 60100, startIdentity: 'S-COMPANION', nonceSha256: sha(scopeNonce) } },
        { duty: 'broker-daemon', status: 'established', reasons: [], identity: { pid: 60200, startIdentity: 'S-DAEMON', nonceSha256: sha(scopeNonce) } },
        { duty: 'transport-descendant', status: 'established', reasons: [], identity: { pid: 60300, startIdentity: 'S-TRANSPORT', nonceSha256: sha(transport) } },
      ] },
      transportExit: { localProcessObservationVersion: 1, class: 'os-live-observation', status: 'absent', reason: 'no-such-process', observation: null, queried: { pid: 60300, nonceSha256: sha(transport) }, readStartedEpochMs: 5200, identityReadEpochMs: 5250, readEpochMs: 5300, absenceConfirmed: true },
      reads: [{ localProcessObservationVersion: 1, class: 'os-live-observation', status: 'absent', reason: 'no-such-process', observation: null, queried: { pid: 60100, nonceSha256: sha(scopeNonce) }, readStartedEpochMs: 4900, readEpochMs: 5100, absenceConfirmed: true }],
      exit: { localProcessObservationVersion: 1, class: 'exit-absence', status: 'disappeared', reason: null, boundIdentity: { pid: 60100, startIdentity: 'S-COMPANION', nonceSha256: sha(scopeNonce) }, lastVerifiedPresenceEpochMs: 2100, firstVerifiedAbsenceEpochMs: 5100, exitCorroboratedByMeta: false },
      stoppedAt: null, fenceAtMs: null, cutoffAtMs: MEASUREMENT_CUTOFF_AT_MS, cleanupBoundaryAtMs: null, composedAtMs: 6000,
    };
    const record = (over = {}) => ({
      status: 'executed', case: 'rescue-interrupt', executedAt: '2026-10-30T00:00:00.000Z',
      interrupt: { measurementCutoffAtMs: MEASUREMENT_CUTOFF_AT_MS },
      stdoutCaptureDeclaration: {
        preload: 'closure-observe.mjs', preloadSha256: sha('preload-bytes'), maxBytes: 65536,
        gate: { argv: ['invoke-prepared', 'rescue'], declaredEntryRealpathSha256: launcherEntryDigest },
        brokerGate: { declaredBrokerEntryRealpathSha256: brokerEntryDigest },
        identityRecord: { version: 2, roles: { invocation: 'identity.json', brokerDaemon: 'identity-broker.json' } },
        environmentVariables: [],
      },
      observations: {}, child: {},
      localProcess: block,
      ...over,
    });
    return { scopeNonce, transport, block, record };
  };
  const cleanCopy = (base) => JSON.parse(JSON.stringify(base));

  test('F2 (P2) RED → a transport absence whose completion TIES with the transport presence instant never credits (the frozen conservative tie rule)', () => {
    const g = armRound10();
    const torn = cleanCopy(g.record());
    // The transport presence identity-read is 2200; the confirmed absence
    // completes at the SAME millisecond — a tie can never manufacture the
    // transport's death.
    torn.localProcess.transportExit.readStartedEpochMs = 2_200;
    torn.localProcess.transportExit.identityReadEpochMs = 2_200;
    torn.localProcess.transportExit.readEpochMs = 2_200;
    const consolidated = nativeInterruptionGateDInput(torn).localProcessDuties;
    assert.equal(consolidated.settled, false, 'a same-millisecond absence can never manufacture the transport\'s death');
    assert.ok(consolidated.refusals.includes('transport-exit-overlaps-presence'), JSON.stringify(consolidated.refusals));
  });

  test('F1 (P2) RED (runtime) → a transport PID REUSE in the exit retry loop latches TERMINALLY: the replacement absence never overwrites the generation-change evidence', async () => {
    const CAPTURE_NONCE = 'c'.repeat(64);
    const TRANSPORT_NONCE = '9'.repeat(64);
    const ENTRY = '/private/tmp/fixture-installed/skills/rescue/launcher.mjs';
    const BROKER_ENTRY = '/private/tmp/fixture-installed/scripts/zcode-broker.mjs';
    const declaration = { captureDirectory: '/private/tmp/fixture-capture-r10', nonce: CAPTURE_NONCE, entryRealpath: ENTRY, brokerEntryRealpath: BROKER_ENTRY };
    const BASE = Math.floor(Date.now() / 1000) * 1000;
    const COMPANION_START = BASE - 4_000;
    const DAEMON_START = BASE - 2_000;
    const MARKER_EPOCH = BASE - 1_000;
    const admissionEstablished = () => ({
      localProcessObservationVersion: 1, class: 'startup-identity', status: 'established', reason: null,
      identity: { role: 'invocation', nonce: CAPTURE_NONCE, entryRealpath: ENTRY, argv: ['invoke-prepared', 'rescue'], pid: 60100, ppid: 600, firstWriteEpochMs: COMPANION_START + 80, startOriginMs: COMPANION_START + 50, firstWritePreciseMs: COMPANION_START + 80.5 },
      readStartedEpochMs: Date.now(), readEpochMs: Date.now(),
    });
    const osEstablished = (pid, ppid, startIdentity, nonce, startInstant) => ({
      localProcessObservationVersion: 1, class: 'os-live-observation', status: 'established', reason: null,
      observation: { pid, ppid, startIdentity, nonce, startInstantEpochMs: startInstant, ppidChangedFromCapture: null },
      queried: { pid, nonce }, readStartedEpochMs: Date.now(), identityReadEpochMs: Date.now(), readEpochMs: Date.now(), absenceConfirmed: null,
    });
    let companionReads = 0;
    let transportReads = 0;
    let phaseThree = false;
    const held = await runHeldHostTurn({
      gatePath: 'unused-gate',
      holdMs: 300_000,
      budgetMs: 10_000_000_000,
      measurementCutoffSchedule: true,
      launch: async () => ({
        result: new Promise((resolve) => {
          const anchor = setInterval(() => { if (companionReads >= 3) { clearInterval(anchor); resolve({ code: 0, stdout: '', stderr: '' }); } }, 5);
          anchor.unref?.();
          setTimeout(() => { clearInterval(anchor); resolve({ code: 0, stdout: '', stderr: '' }); }, 10_000).unref?.();
        }),
        terminate: async () => {},
      }),
      waitForGate: async () => {},
      captureProcessIdentity: async () => ({ pid: 60300, ppid: 60200, nonce: TRANSPORT_NONCE, startIdentity: 'S-TRANSPORT', markerEpochMs: MARKER_EPOCH }),
      readProcessIdentity: async () => undefined,
      terminateProcessIdentity: async () => ({ attempted: true, signalled: 'SIGTERM', exited: true, failure: null }),
      waitForProcessExit: async () => {},
      releaseGate: async () => {},
      localObservation: declaration,
      captureLocalObservationIdentity: async () => admissionEstablished(),
      observeLocalObservationIdentity: async () => {
        companionReads += 1;
        if (companionReads === 1) return osEstablished(60100, 600, 'S-COMPANION', CAPTURE_NONCE, COMPANION_START);
        if (companionReads === 2) return osEstablished(60100, 600, 'S-COMPANION', CAPTURE_NONCE, COMPANION_START);
        return new Promise((resolve) => setTimeout(() => resolve({
          localProcessObservationVersion: 1, class: 'os-live-observation', status: 'absent', reason: 'no-such-process',
          observation: null, queried: { pid: 60100, nonce: CAPTURE_NONCE },
          readStartedEpochMs: Date.now(), readEpochMs: Date.now(), absenceConfirmed: true,
        }), 30));
      },
      captureLocalBrokerObservationIdentity: async () => ({ ...admissionEstablished(), identity: { role: 'broker-daemon', nonce: CAPTURE_NONCE, entryRealpath: BROKER_ENTRY, configRealpathSha256: 'b'.repeat(64), pid: 60200, ppid: 60100, firstWriteEpochMs: DAEMON_START + 70, startOriginMs: DAEMON_START + 45, firstWritePreciseMs: DAEMON_START + 70.5 } }),
      observeLocalBrokerObservationIdentity: async () => osEstablished(60200, 60100, 'S-DAEMON', CAPTURE_NONCE, DAEMON_START),
      // Call 1: the transport observed ALIVE (its duty fact). Call 2: the
      // FIRST transport-exit read — the PID WAS REUSED (the named
      // generation-change verdict). Call 3: the REPLACEMENT's confirmed
      // absence — it must never convert the latched reuse into the original
      // transport's confirmed exit.
      observeLocalTransportObservationIdentity: async () => {
        transportReads += 1;
        phaseThree = true;
        if (transportReads === 1) return osEstablished(60300, 60200, 'S-TRANSPORT', TRANSPORT_NONCE, MARKER_EPOCH - 500);
        if (transportReads === 2) {
          return {
            localProcessObservationVersion: 1, class: 'os-live-observation', status: 'unestablished', reason: 'start-identity-generation-changed',
            observation: null, queried: { pid: 60300, nonce: TRANSPORT_NONCE },
            readStartedEpochMs: Date.now(), identityReadEpochMs: Date.now(), readEpochMs: Date.now(), absenceConfirmed: null,
          };
        }
        return new Promise((resolve) => setTimeout(() => resolve({
          localProcessObservationVersion: 1, class: 'os-live-observation', status: 'absent', reason: 'no-such-process',
          observation: null, queried: { pid: 60300, nonce: TRANSPORT_NONCE },
          readStartedEpochMs: Date.now(), readEpochMs: Date.now(), absenceConfirmed: true,
        }), 30));
      },
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5))),
      now: (() => { let value = 0; let gated = false; return () => {
        if (!gated) { if (phaseThree) gated = true; else return 0; }
        value += 500;
        return value;
      }; })(),
      processNonce: TRANSPORT_NONCE,
    });
    const block = held.cleanup.localObservation;
    assert.ok(block);
    // The generation-change latch is TERMINAL: the persisted transport exit
    // is the LATCHED generation-change verdict, never the replacement's
    // confirmed absence.
    assert.equal(block.transportExit?.reason, 'start-identity-generation-changed', `the latched generation-change evidence persists (actual ${JSON.stringify(block.transportExit ?? null)})`);
    assert.equal(block.transportExitGenerationLatched, true, 'the latch rides the block as the named fact');
    // The offline join refuses the transport's credit by name.
    const joined = nativeInterruptionGateDInput({
      status: 'executed', case: 'rescue-interrupt',
      // (Review round 28, Finding 1) the harness mirrors the REAL record
      // composer (driver.mjs:1167): the interrupt carries the termination
      // boundary echo exactly when the runtime stamped one — the block and
      // the record are echo-consistent by construction.
      interrupt: {
        measurementCutoffAtMs: held.cleanup.measurementCutoffAtMs,
        ...(typeof held.cleanup.cleanupBoundaryAtMs === 'number' ? { cleanupBoundaryAtMs: held.cleanup.cleanupBoundaryAtMs } : {}),
      },
      stdoutCaptureDeclaration: {
        gate: { argv: ['invoke-prepared', 'rescue'], declaredEntryRealpathSha256: sha(ENTRY) },
        brokerGate: { declaredBrokerEntryRealpathSha256: sha(BROKER_ENTRY) },
      },
      observations: {}, child: {},
      localProcess: block,
    });
    assert.equal(joined.localProcessDuties?.settled, false, 'the replacement absence never credits the original transport');
    assert.ok(joined.localProcessDuties?.refusals.includes('transport-exit-generation-foreign'), JSON.stringify(joined.localProcessDuties?.refusals));
  });

  test('the join version registers the round-10 replay growth', () => {
    assert.equal(NATIVE_INTERRUPTION_GATE_D_JOIN_VERSION, 37, 'join v18 (2026-10-30 local-settlement Task 3 review round 14): the tied-absence collection continuation, the transport-exit recency/carried-identity re-adjudication and the incomplete-interval start refusals; v17 (round 13): the identity-read containment check, the FROZEN argv selector enforced over mere persisted agreement, and the persisted block-version gate; v16 (round 12) = the collection-interval validity; v15 (round 11) = the invocation-absence strict tie against the walked horizon, the contradictory-duplicate-duty-slot refusal and the selected-endpoint parentage rule covering a failed refresh; v14 (round 10): the transport PID-reuse latch (a generation-changing transport exit retry latches terminally and the persisted latch refuses by name) and the strict transport-absence tie rule; v13 (round 9) = the transport-exit recency/carried-identity re-adjudication; v12 (round 8) = the generation-bound PRE-FENCE transport-exit conjunct, the refreshed-presence horizon/supersession and the admitted-record capture-time parentage; v11 (round 7) = the persisted ancestry-refresh evidence joining the offline reuse latch; v10 (round 6) = the admission entry-digest/argv-selector binding and the unsupported-duty-slot refusal; v9 (round 5) = the declared-scope binding, the identity-bearing absence reuse latch and the walked presence horizon; v8 (round 4) = the admission-generation re-adjudication + the endpoint pre-fence/lifetime/marker-epoch re-verification');
  });
});

describe('local-settlement task 3 review round 11 (three P2): the invocation absence tie never credits, the selected-endpoint parentage rule covers a failed refresh, and a contradictory duplicate duty slot refuses', async () => {
  const { runHeldHostTurn, nativeInterruptionGateDInput, NATIVE_INTERRUPTION_GATE_D_JOIN_VERSION } = await import('../tools/shell-wait-probe/driver.mjs');
  const { createHash } = await import('node:crypto');
  const sha = (v) => createHash('sha256').update(v).digest('hex');
  const MEASUREMENT_CUTOFF_AT_MS = 20_000;

  const armRound11 = () => {
    const scopeNonce = 'a'.repeat(64);
    const transport = 'f'.repeat(64);
    const launcherEntryDigest = sha('launcher-entry');
    const brokerEntryDigest = sha('broker-entry');
    const observation = (pid, ppid, startIdentity, scope, readStarted, identityRead, readEpoch, startInstant = 1000) => ({
      localProcessObservationVersion: 1, class: 'os-live-observation', status: 'established', reason: null,
      observation: { pid, ppid, startIdentity, startInstantEpochMs: startInstant, ppidChangedFromCapture: null, nonceSha256: scope },
      queried: { pid, nonceSha256: scope },
      readStartedEpochMs: readStarted, identityReadEpochMs: identityRead, readEpochMs: readEpoch,
      absenceConfirmed: null,
    });
    const block = {
      version: 1, armed: true, clock: 'wall-epoch-ms', nonceSha256: sha(scopeNonce),
      admission: { localProcessObservationVersion: 1, class: 'startup-identity', status: 'established', reason: null, identity: { role: 'invocation', argv: ['invoke-prepared', 'rescue'], entryRealpathSha256: launcherEntryDigest, pid: 60100, ppid: 600, firstWriteEpochMs: 1000, startOriginMs: 1000.1, firstWritePreciseMs: 1100.5, nonceSha256: sha(scopeNonce) }, readStartedEpochMs: 1000, readEpochMs: 1100 },
      presence: observation(60100, 600, 'S-COMPANION', sha(scopeNonce), 1900, 2100, 2300),
      brokerAdmission: { localProcessObservationVersion: 1, class: 'startup-identity', status: 'established', reason: null, identity: { role: 'broker-daemon', entryRealpathSha256: brokerEntryDigest, pid: 60200, ppid: 60100, firstWriteEpochMs: 3000, startOriginMs: 3000.2, firstWritePreciseMs: 3100.6, nonceSha256: sha(scopeNonce) }, readStartedEpochMs: 1900, readEpochMs: 2100 },
      brokerObservation: observation(60200, 60100, 'S-DAEMON', sha(scopeNonce), 3300, 3400, 3500, 3000),
      transportObservation: observation(60300, 60200, 'S-TRANSPORT', sha(transport), 2000, 2200, 2500, 5000),
      ancestryEndpoints: {
        companion: observation(60100, 600, 'S-COMPANION', sha(scopeNonce), 4600, 4650, 4700, 1000),
        daemon: observation(60200, 60100, 'S-DAEMON', sha(scopeNonce), 4600, 4650, 4750, 3000),
        transportMarker: { pid: 60300, ppid: 60200, nonceSha256: sha(transport), markerEpochMs: 4450 },
      },
      ancestryEndpointRefreshes: { companion: null, daemon: null },
      ancestry: { localProcessObservationVersion: 1, class: 'ancestry-join', nonceSha256: sha(scopeNonce), companionToTransportAttributed: true, hops: [
        { hop: 'companion-to-daemon', status: 'established', reason: null },
        { hop: 'daemon-to-transport', status: 'established', reason: null },
      ] },
      duties: { localProcessObservationVersion: 1, class: 'local-duty-verdict', settled: true, duties: [
        { duty: 'invocation-process', status: 'established', reasons: [], identity: { pid: 60100, startIdentity: 'S-COMPANION', nonceSha256: sha(scopeNonce) } },
        { duty: 'broker-daemon', status: 'established', reasons: [], identity: { pid: 60200, startIdentity: 'S-DAEMON', nonceSha256: sha(scopeNonce) } },
        { duty: 'transport-descendant', status: 'established', reasons: [], identity: { pid: 60300, startIdentity: 'S-TRANSPORT', nonceSha256: sha(transport) } },
      ] },
      transportExit: { localProcessObservationVersion: 1, class: 'os-live-observation', status: 'absent', reason: 'no-such-process', observation: null, queried: { pid: 60300, nonceSha256: sha(transport) }, readStartedEpochMs: 5200, identityReadEpochMs: 5250, readEpochMs: 5300, absenceConfirmed: true },
      reads: [{ localProcessObservationVersion: 1, class: 'os-live-observation', status: 'absent', reason: 'no-such-process', observation: null, queried: { pid: 60100, nonceSha256: sha(scopeNonce) }, readStartedEpochMs: 4900, readEpochMs: 5100, absenceConfirmed: true }],
      exit: { localProcessObservationVersion: 1, class: 'exit-absence', status: 'disappeared', reason: null, boundIdentity: { pid: 60100, startIdentity: 'S-COMPANION', nonceSha256: sha(scopeNonce) }, lastVerifiedPresenceEpochMs: 2100, firstVerifiedAbsenceEpochMs: 5100, exitCorroboratedByMeta: false },
      stoppedAt: null, fenceAtMs: null, cutoffAtMs: MEASUREMENT_CUTOFF_AT_MS, cleanupBoundaryAtMs: null, composedAtMs: 6000,
    };
    const record = (over = {}) => ({
      status: 'executed', case: 'rescue-interrupt', executedAt: '2026-10-30T00:00:00.000Z',
      interrupt: { measurementCutoffAtMs: MEASUREMENT_CUTOFF_AT_MS },
      stdoutCaptureDeclaration: {
        preload: 'closure-observe.mjs', preloadSha256: sha('preload-bytes'), maxBytes: 65536,
        gate: { argv: ['invoke-prepared', 'rescue'], declaredEntryRealpathSha256: launcherEntryDigest },
        brokerGate: { declaredBrokerEntryRealpathSha256: brokerEntryDigest },
        identityRecord: { version: 2, roles: { invocation: 'identity.json', brokerDaemon: 'identity-broker.json' } },
        environmentVariables: [],
      },
      observations: {}, child: {},
      localProcess: block,
      ...over,
    });
    return { scopeNonce, transport, block, record };
  };
  const cleanCopy = (base) => JSON.parse(JSON.stringify(base));

  test('F1 (P2) RED → an invocation absence whose completion TIES with the walked presence horizon never credits (the frozen conservative tie rule mirrored)', () => {
    const g = armRound11();
    const torn = cleanCopy(g.record());
    // A later same-generation presence verifies at 5100 and the confirmed
    // absence's collection START and COMPLETION both sit at the SAME
    // millisecond (5100) — the start check alone passes (equality), so the
    // COMPLETION must also be strictly later than the horizon: a tie can
    // never manufacture the invocation's death.
    torn.localProcess.reads.push({
      localProcessObservationVersion: 1, class: 'os-live-observation', status: 'established', reason: null,
      observation: { pid: 60100, ppid: 600, startIdentity: 'S-COMPANION', startInstantEpochMs: 1000, ppidChangedFromCapture: null, nonceSha256: sha(g.scopeNonce) },
      queried: { pid: 60100, nonceSha256: sha(g.scopeNonce) },
      // The later presence's IDENTITY instant (5100) walks the horizon and
      // sits INSIDE its own collection interval (4900-5200); the confirmed
      // absence's START and COMPLETION both sit at 5100 — the TIE (the
      // completion is not strictly later than the horizon) is the refusing
      // rule here.
      readStartedEpochMs: 4900, identityReadEpochMs: 5100, readEpochMs: 5200, absenceConfirmed: null,
    });
    torn.localProcess.reads[0].readStartedEpochMs = 5100;
    torn.localProcess.reads[0].identityReadEpochMs = 5100;
    torn.localProcess.reads[0].readEpochMs = 5100;
    torn.localProcess.exit.firstVerifiedAbsenceEpochMs = 5100;
    const consolidated = nativeInterruptionGateDInput(torn).localProcessDuties;
    assert.equal(consolidated.settled, false, 'a same-millisecond absence can never manufacture the invocation\'s death');
    assert.ok(consolidated.refusals.includes('exit-absence-overlaps-presence'), JSON.stringify(consolidated.refusals));
  });

  test('F3 (P2) RED → a CONTRADICTORY duplicate duty slot (the valid trio followed by an unestablished invocation entry) refuses, never silently skipped', () => {
    const g = armRound11();
    const torn = cleanCopy(g.record());
    torn.localProcess.duties.duties.push({
      duty: 'invocation-process', status: 'unestablished', reasons: [], identity: null,
    });
    const consolidated = nativeInterruptionGateDInput(torn).localProcessDuties;
    assert.equal(consolidated.settled, false, 'exactly ONE entry per applicable slot — a contradictory duplicate refuses');
    assert.ok(consolidated.refusals.includes('inline-duty-duplicate-slot'), JSON.stringify(consolidated.refusals));
  });

  test("F2 (P2) RED (runtime) → the broker's FIRST OS sample already reparented and its refresh transiently FAILED: the ADMITTED record still supplies the capture-time parent", async () => {
    const CAPTURE_NONCE = 'c'.repeat(64);
    const TRANSPORT_NONCE = '9'.repeat(64);
    const ENTRY = '/private/tmp/fixture-installed/skills/rescue/launcher.mjs';
    const BROKER_ENTRY = '/private/tmp/fixture-installed/scripts/zcode-broker.mjs';
    const declaration = { captureDirectory: '/private/tmp/fixture-capture-r11', nonce: CAPTURE_NONCE, entryRealpath: ENTRY, brokerEntryRealpath: BROKER_ENTRY };
    const BASE = Math.floor(Date.now() / 1000) * 1000;
    const COMPANION_START = BASE - 4_000;
    const DAEMON_START = BASE - 2_000;
    const MARKER_EPOCH = BASE - 1_000;
    const admissionEstablished = () => ({
      localProcessObservationVersion: 1, class: 'startup-identity', status: 'established', reason: null,
      identity: { role: 'invocation', nonce: CAPTURE_NONCE, entryRealpath: ENTRY, argv: ['invoke-prepared', 'rescue'], pid: 60100, ppid: 600, firstWriteEpochMs: COMPANION_START + 80, startOriginMs: COMPANION_START + 50, firstWritePreciseMs: COMPANION_START + 80.5 },
      readStartedEpochMs: Date.now(), readEpochMs: Date.now(),
    });
    const osEstablished = (pid, ppid, startIdentity, nonce, startInstant) => ({
      localProcessObservationVersion: 1, class: 'os-live-observation', status: 'established', reason: null,
      observation: { pid, ppid, startIdentity, nonce, startInstantEpochMs: startInstant, ppidChangedFromCapture: null },
      queried: { pid, nonce }, readStartedEpochMs: Date.now(), identityReadEpochMs: Date.now(), readEpochMs: Date.now(), absenceConfirmed: null,
    });
    let companionReads = 0;
    let brokerReads = 0;
    let transportReads = 0;
    let phaseThree = false;
    const held = await runHeldHostTurn({
      gatePath: 'unused-gate',
      holdMs: 300_000,
      budgetMs: 10_000_000_000,
      measurementCutoffSchedule: true,
      launch: async () => ({
        result: new Promise((resolve) => {
          const anchor = setInterval(() => { if (companionReads >= 3) { clearInterval(anchor); resolve({ code: 0, stdout: '', stderr: '' }); } }, 5);
          anchor.unref?.();
          setTimeout(() => { clearInterval(anchor); resolve({ code: 0, stdout: '', stderr: '' }); }, 10_000).unref?.();
        }),
        terminate: async () => {},
      }),
      waitForGate: async () => {},
      captureProcessIdentity: async () => ({ pid: 60300, ppid: 60200, nonce: TRANSPORT_NONCE, startIdentity: 'S-TRANSPORT', markerEpochMs: MARKER_EPOCH }),
      readProcessIdentity: async () => undefined,
      terminateProcessIdentity: async () => ({ attempted: true, signalled: 'SIGTERM', exited: true, failure: null }),
      waitForProcessExit: async () => {},
      releaseGate: async () => {},
      localObservation: declaration,
      captureLocalObservationIdentity: async () => admissionEstablished(),
      observeLocalObservationIdentity: async () => {
        companionReads += 1;
        if (companionReads === 1) return osEstablished(60100, 600, 'S-COMPANION', CAPTURE_NONCE, COMPANION_START);
        if (companionReads === 2) return osEstablished(60100, 600, 'S-COMPANION', CAPTURE_NONCE, COMPANION_START);
        return new Promise((resolve) => setTimeout(() => resolve({
          localProcessObservationVersion: 1, class: 'os-live-observation', status: 'absent', reason: 'no-such-process',
          observation: null, queried: { pid: 60100, nonce: CAPTURE_NONCE },
          readStartedEpochMs: Date.now(), readEpochMs: Date.now(), absenceConfirmed: true,
        }), 30));
      },
      // The broker's ADMITTED record captures the Companion (ppid 60100);
      // its FIRST OS sample ALREADY shows the reparenting (ppid 1 — the
      // Companion exited before the broker's first read) and its ancestry
      // REFRESH transiently FAILS: the selected (fallback) endpoint still
      // shows the changed parent, so the ADMITTED record must supply the
      // capture-time parent.
      captureLocalBrokerObservationIdentity: async () => ({ ...admissionEstablished(), identity: { role: 'broker-daemon', nonce: CAPTURE_NONCE, entryRealpath: BROKER_ENTRY, configRealpathSha256: 'b'.repeat(64), pid: 60200, ppid: 60100, firstWriteEpochMs: DAEMON_START + 70, startOriginMs: DAEMON_START + 45, firstWritePreciseMs: DAEMON_START + 70.5 } }),
      observeLocalBrokerObservationIdentity: async () => {
        brokerReads += 1;
        if (brokerReads === 1) return osEstablished(60200, 1, 'S-DAEMON', CAPTURE_NONCE, DAEMON_START);
        return null;
      },
      observeLocalTransportObservationIdentity: async () => {
        transportReads += 1;
        phaseThree = true;
        if (transportReads === 1) return osEstablished(60300, 60200, 'S-TRANSPORT', TRANSPORT_NONCE, MARKER_EPOCH - 500);
        return new Promise((resolve) => setTimeout(() => resolve({
          localProcessObservationVersion: 1, class: 'os-live-observation', status: 'absent', reason: 'no-such-process',
          observation: null, queried: { pid: 60300, nonce: TRANSPORT_NONCE },
          readStartedEpochMs: Date.now(), readEpochMs: Date.now(), absenceConfirmed: true,
        }), 30));
      },
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5))),
      now: (() => { let value = 0; let gated = false; return () => {
        if (!gated) { if (phaseThree) gated = true; else return 0; }
        value += 500;
        return value;
      }; })(),
      processNonce: TRANSPORT_NONCE,
    });
    const block = held.cleanup.localObservation;
    assert.ok(block);
    // The admitted startup record's parent link satisfies hop 1 even when
    // the FIRST (and only) OS sample already shows the reparenting.
    assert.equal(block.ancestry?.companionToTransportAttributed, true, JSON.stringify(block.ancestry?.hops ?? []));
    assert.equal(block.duties?.settled, true, `the duties settle (duties ${JSON.stringify(block.duties?.duties ?? [])})`);
    const joined = nativeInterruptionGateDInput({
      status: 'executed', case: 'rescue-interrupt',
      // (Review round 28, Finding 1) the harness mirrors the REAL record
      // composer (driver.mjs:1167): the interrupt carries the termination
      // boundary echo exactly when the runtime stamped one — the block and
      // the record are echo-consistent by construction.
      interrupt: {
        measurementCutoffAtMs: held.cleanup.measurementCutoffAtMs,
        ...(typeof held.cleanup.cleanupBoundaryAtMs === 'number' ? { cleanupBoundaryAtMs: held.cleanup.cleanupBoundaryAtMs } : {}),
      },
      stdoutCaptureDeclaration: {
        gate: { argv: ['invoke-prepared', 'rescue'], declaredEntryRealpathSha256: sha(ENTRY) },
        brokerGate: { declaredBrokerEntryRealpathSha256: sha(BROKER_ENTRY) },
      },
      observations: {}, child: {},
      localProcess: block,
    });
    assert.deepEqual(joined.localProcessDuties?.refusals, [], JSON.stringify(joined.localProcessDuties?.refusals));
    assert.equal(joined.localProcessDuties?.settled, true);
  });

  test('the join version registers the round-11 replay growth', () => {
    assert.equal(NATIVE_INTERRUPTION_GATE_D_JOIN_VERSION, 37, 'join v18 (2026-10-30 local-settlement Task 3 review round 14): the tied-absence collection continuation, the transport-exit recency/carried-identity re-adjudication and the incomplete-interval start refusals; v17 (round 13): the identity-read containment check, the FROZEN argv selector enforced over mere persisted agreement, and the persisted block-version gate; v16 (round 12) = the collection-interval validity; v15 (round 11) = the invocation-absence strict tie against the walked horizon, the contradictory-duplicate-duty-slot refusal, and the selected-endpoint parentage rule covering a failed refresh; v14 (round 10) = the transport PID-reuse latch + the strict transport-absence tie rule; v13 (round 9) = the transport-exit recency/carried-identity re-adjudication; v12 (round 8) = the generation-bound PRE-FENCE transport-exit conjunct, the refreshed-presence horizon/supersession and the admitted-record capture-time parentage; v11 (round 7) = the persisted ancestry-refresh evidence joining the offline reuse latch; v10 (round 6) = the admission entry-digest/argv-selector binding and the unsupported-duty-slot refusal; v9 (round 5) = the declared-scope binding, the identity-bearing absence reuse latch and the walked presence horizon; v8 (round 4) = the admission-generation re-adjudication + the endpoint pre-fence/lifetime/marker-epoch re-verification');
  });
});

describe('local-settlement task 3 review round 12 (two P2): inverted collection intervals refuse fence credit by name, and the executing-helper provenance agrees at rest whatever the materialization state', async () => {
  const { spawnSync } = await import('node:child_process');
  const { nativeInterruptionGateDInput, NATIVE_INTERRUPTION_GATE_D_JOIN_VERSION } = await import('../tools/shell-wait-probe/driver.mjs');
  const { createHash } = await import('node:crypto');
  const { chmod, mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const sha = (v) => createHash('sha256').update(v).digest('hex');
  const MEASUREMENT_CUTOFF_AT_MS = 20_000;

  const armRound12 = () => {
    const scopeNonce = 'a'.repeat(64);
    const transport = 'f'.repeat(64);
    const launcherEntryDigest = sha('launcher-entry');
    const brokerEntryDigest = sha('broker-entry');
    const observation = (pid, ppid, startIdentity, scope, readStarted, identityRead, readEpoch, startInstant = 1000) => ({
      localProcessObservationVersion: 1, class: 'os-live-observation', status: 'established', reason: null,
      observation: { pid, ppid, startIdentity, startInstantEpochMs: startInstant, ppidChangedFromCapture: null, nonceSha256: scope },
      queried: { pid, nonceSha256: scope },
      readStartedEpochMs: readStarted, identityReadEpochMs: identityRead, readEpochMs: readEpoch,
      absenceConfirmed: null,
    });
    const block = {
      version: 1, armed: true, clock: 'wall-epoch-ms', nonceSha256: sha(scopeNonce),
      admission: { localProcessObservationVersion: 1, class: 'startup-identity', status: 'established', reason: null, identity: { role: 'invocation', argv: ['invoke-prepared', 'rescue'], entryRealpathSha256: launcherEntryDigest, pid: 60100, ppid: 600, firstWriteEpochMs: 1000, startOriginMs: 1000.1, firstWritePreciseMs: 1100.5, nonceSha256: sha(scopeNonce) }, readStartedEpochMs: 1000, readEpochMs: 1100 },
      presence: observation(60100, 600, 'S-COMPANION', sha(scopeNonce), 1900, 2100, 2300),
      brokerAdmission: { localProcessObservationVersion: 1, class: 'startup-identity', status: 'established', reason: null, identity: { role: 'broker-daemon', entryRealpathSha256: brokerEntryDigest, pid: 60200, ppid: 60100, firstWriteEpochMs: 3000, startOriginMs: 3000.2, firstWritePreciseMs: 3100.6, nonceSha256: sha(scopeNonce) }, readStartedEpochMs: 1900, readEpochMs: 2100 },
      brokerObservation: observation(60200, 60100, 'S-DAEMON', sha(scopeNonce), 3300, 3400, 3500, 3000),
      transportObservation: observation(60300, 60200, 'S-TRANSPORT', sha(transport), 2000, 2200, 2500, 5000),
      ancestryEndpoints: {
        companion: observation(60100, 600, 'S-COMPANION', sha(scopeNonce), 4600, 4650, 4700, 1000),
        daemon: observation(60200, 60100, 'S-DAEMON', sha(scopeNonce), 4600, 4650, 4750, 3000),
        transportMarker: { pid: 60300, ppid: 60200, nonceSha256: sha(transport), markerEpochMs: 4450 },
      },
      ancestryEndpointRefreshes: { companion: null, daemon: null },
      ancestry: { localProcessObservationVersion: 1, class: 'ancestry-join', nonceSha256: sha(scopeNonce), companionToTransportAttributed: true, hops: [
        { hop: 'companion-to-daemon', status: 'established', reason: null },
        { hop: 'daemon-to-transport', status: 'established', reason: null },
      ] },
      duties: { localProcessObservationVersion: 1, class: 'local-duty-verdict', settled: true, duties: [
        { duty: 'invocation-process', status: 'established', reasons: [], identity: { pid: 60100, startIdentity: 'S-COMPANION', nonceSha256: sha(scopeNonce) } },
        { duty: 'broker-daemon', status: 'established', reasons: [], identity: { pid: 60200, startIdentity: 'S-DAEMON', nonceSha256: sha(scopeNonce) } },
        { duty: 'transport-descendant', status: 'established', reasons: [], identity: { pid: 60300, startIdentity: 'S-TRANSPORT', nonceSha256: sha(transport) } },
      ] },
      transportExit: { localProcessObservationVersion: 1, class: 'os-live-observation', status: 'absent', reason: 'no-such-process', observation: null, queried: { pid: 60300, nonceSha256: sha(transport) }, readStartedEpochMs: 5200, identityReadEpochMs: 5250, readEpochMs: 5300, absenceConfirmed: true },
      reads: [{ localProcessObservationVersion: 1, class: 'os-live-observation', status: 'absent', reason: 'no-such-process', observation: null, queried: { pid: 60100, nonceSha256: sha(scopeNonce) }, readStartedEpochMs: 4900, readEpochMs: 5100, absenceConfirmed: true }],
      exit: { localProcessObservationVersion: 1, class: 'exit-absence', status: 'disappeared', reason: null, boundIdentity: { pid: 60100, startIdentity: 'S-COMPANION', nonceSha256: sha(scopeNonce) }, lastVerifiedPresenceEpochMs: 2100, firstVerifiedAbsenceEpochMs: 5100, exitCorroboratedByMeta: false },
      stoppedAt: null, fenceAtMs: null, cutoffAtMs: MEASUREMENT_CUTOFF_AT_MS, cleanupBoundaryAtMs: null, composedAtMs: 6000,
    };
    const record = (over = {}) => ({
      status: 'executed', case: 'rescue-interrupt', executedAt: '2026-10-30T00:00:00.000Z',
      interrupt: { measurementCutoffAtMs: MEASUREMENT_CUTOFF_AT_MS },
      stdoutCaptureDeclaration: {
        preload: 'closure-observe.mjs', preloadSha256: sha('preload-bytes'), maxBytes: 65536,
        gate: { argv: ['invoke-prepared', 'rescue'], declaredEntryRealpathSha256: launcherEntryDigest },
        brokerGate: { declaredBrokerEntryRealpathSha256: brokerEntryDigest },
        identityRecord: { version: 2, roles: { invocation: 'identity.json', brokerDaemon: 'identity-broker.json' } },
        environmentVariables: [],
      },
      observations: {}, child: {},
      localProcess: block,
      ...over,
    });
    return { scopeNonce, transport, block, record };
  };
  const cleanCopy = (base) => JSON.parse(JSON.stringify(base));

  test('F1 (P2) RED → an INVERTED transport-exit collection interval (started after it claims to have completed) refuses by name', () => {
    const g = armRound12();
    const torn = cleanCopy(g.record());
    // The reviewer's shape: the collection START moved past the termination
    // boundary while the completion still claims a pre-boundary instant —
    // the interval is INVERTED (started > completed) and can never fence.
    torn.localProcess.transportExit.readStartedEpochMs = MEASUREMENT_CUTOFF_AT_MS + 100;
    const consolidated = nativeInterruptionGateDInput(torn).localProcessDuties;
    assert.equal(consolidated.settled, false);
    assert.ok(consolidated.refusals.includes('transport-exit-interval-inverted'), JSON.stringify(consolidated.refusals));
  });

  test('F1 (P2) RED (class-sweep) → an INVERTED admission interval refuses by name', () => {
    const g = armRound12();
    const torn = cleanCopy(g.record());
    torn.localProcess.admission.readStartedEpochMs = 1_500;
    torn.localProcess.admission.readEpochMs = 1_100;
    const consolidated = nativeInterruptionGateDInput(torn).localProcessDuties;
    assert.equal(consolidated.settled, false);
    assert.ok(consolidated.refusals.includes('admission-interval-inverted'), JSON.stringify(consolidated.refusals));
  });

  test('F1 (P2) RED (class-sweep) → an INVERTED observation-echo interval refuses by name (the duty trio and the ancestry endpoints)', () => {
    const g = armRound12();
    const torn = cleanCopy(g.record());
    torn.localProcess.presence.readStartedEpochMs = 2_300;
    torn.localProcess.presence.readEpochMs = 2_100;
    const consolidated = nativeInterruptionGateDInput(torn).localProcessDuties;
    assert.equal(consolidated.settled, false);
    assert.ok(consolidated.refusals.includes('observation-interval-inverted'), JSON.stringify(consolidated.refusals));
    const tornEndpoint = cleanCopy(g.record());
    tornEndpoint.localProcess.ancestryEndpoints.companion.readStartedEpochMs = 4_700;
    tornEndpoint.localProcess.ancestryEndpoints.companion.readEpochMs = 4_600;
    const consolidatedEndpoint = nativeInterruptionGateDInput(tornEndpoint).localProcessDuties;
    assert.equal(consolidatedEndpoint.settled, false);
    assert.ok(consolidatedEndpoint.refusals.includes('observation-interval-inverted'), JSON.stringify(consolidatedEndpoint.refusals));
  });

  test("F2 (P2) RED → the executing-helper provenance agrees at rest whatever the materialization state (a read-only node_modules must NOT fabricate sourcesChangedDuringRun)", async (t) => {
    // A child process imports the driver with node_modules made READ-ONLY:
    // the helper materialization cannot copy the executing helpers, the
    // observer falls back to the production modules, and — pre-fix — the
    // init construction hashed EMPTY strings while the record-time hashed
    // the production helpers: unchanged sources produced DIFFERENT digests
    // (a fabricated sourcesChangedDuringRun).
    const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
    const nodeModules = join(repositoryRoot, 'node_modules');
    const temporary = await mkdtemp(join(tmpdir(), 'provenance-r12-'));
    t.after(() => rm(temporary, { recursive: true, force: true }));
    const childScript = join(temporary, 'provenance-child.mjs');
    const driverUrl = join(repositoryRoot, 'tools', 'shell-wait-probe', 'driver.mjs');
    await writeFile(childScript, [
      'const driver = await import(' + JSON.stringify(driverUrl) + ');',
      'const recordTime = await driver.observerProvenance();',
      "console.log('R12CHILD ' + JSON.stringify({",
      '  init: driver.EXECUTING_OBSERVER_PROVENANCE.digest,',
      '  recordTime: recordTime.digest,',
      '}));',
      'process.exit(0);',
    ].join('\n'), 'utf8');
    await chmod(nodeModules, 0o555);
    try {
      const spawned = spawnSync(process.execPath, [childScript], { encoding: 'utf8', cwd: repositoryRoot, timeout: 60_000 });
      const line = String(spawned.stdout ?? '').split('\n').find((entry) => entry.startsWith('R12CHILD '));
      assert.ok(line, `the child reported its digests (stderr ${String(spawned.stderr ?? '').slice(0, 300)})`);
      const digests = JSON.parse(line.slice('R12CHILD '.length));
      assert.equal(digests.init, digests.recordTime, 'unchanged sources: the init and record-time digests must AGREE whatever the materialization state');
    } finally {
      await chmod(nodeModules, 0o755);
    }
  });

  test('the join version registers the round-12 replay growth', () => {
    assert.equal(NATIVE_INTERRUPTION_GATE_D_JOIN_VERSION, 37, 'join v18 (2026-10-30 local-settlement Task 3 review round 14): the tied-absence collection continuation, the transport-exit recency/carried-identity re-adjudication and the incomplete-interval start refusals; v17 (round 13): the identity-read containment check, the FROZEN argv selector enforced over mere persisted agreement, and the persisted block-version gate; v16 (round 12): every fence-crediting read validates its collection interval (inverted intervals refuse by name for the transport exit, the admissions, the observation echoes and the invocation exit) and the executing-helper provenance falls back consistently when the materialization is unavailable; v15 (round 11) = the invocation-absence strict tie, the contradictory-duplicate-duty-slot refusal and the selected-endpoint parentage rule covering a failed refresh; v14 (round 10) = the transport PID-reuse latch + the strict transport-absence tie rule; v13 (round 9) = the transport-exit recency/carried-identity re-adjudication; v12 (round 8) = the generation-bound PRE-FENCE transport-exit conjunct, the refreshed-presence horizon/supersession and the admitted-record capture-time parentage');
  });
});

describe('local-settlement task 3 review round 13 (four findings): the fence producer floors fractional clocks, identity reads sit inside their intervals, the replay enforces the frozen argv selector, and an unsupported persisted block version refuses', async () => {
  const { runHeldHostTurn, nativeInterruptionGateDInput, NATIVE_INTERRUPTION_GATE_D_JOIN_VERSION } = await import('../tools/shell-wait-probe/driver.mjs');
  const { createHash } = await import('node:crypto');
  const sha = (v) => createHash('sha256').update(v).digest('hex');
  const MEASUREMENT_CUTOFF_AT_MS = 20_000;

  const armRound13 = () => {
    const scopeNonce = 'a'.repeat(64);
    const transport = 'f'.repeat(64);
    const launcherEntryDigest = sha('launcher-entry');
    const brokerEntryDigest = sha('broker-entry');
    const observation = (pid, ppid, startIdentity, scope, readStarted, identityRead, readEpoch, startInstant = 1000) => ({
      localProcessObservationVersion: 1, class: 'os-live-observation', status: 'established', reason: null,
      observation: { pid, ppid, startIdentity, startInstantEpochMs: startInstant, ppidChangedFromCapture: null, nonceSha256: scope },
      queried: { pid, nonceSha256: scope },
      readStartedEpochMs: readStarted, identityReadEpochMs: identityRead, readEpochMs: readEpoch,
      absenceConfirmed: null,
    });
    const block = {
      version: 1, armed: true, clock: 'wall-epoch-ms', nonceSha256: sha(scopeNonce),
      admission: { localProcessObservationVersion: 1, class: 'startup-identity', status: 'established', reason: null, identity: { role: 'invocation', argv: ['invoke-prepared', 'rescue'], entryRealpathSha256: launcherEntryDigest, pid: 60100, ppid: 600, firstWriteEpochMs: 1000, startOriginMs: 1000.1, firstWritePreciseMs: 1100.5, nonceSha256: sha(scopeNonce) }, readStartedEpochMs: 1000, readEpochMs: 1100 },
      presence: observation(60100, 600, 'S-COMPANION', sha(scopeNonce), 1900, 2100, 2300),
      brokerAdmission: { localProcessObservationVersion: 1, class: 'startup-identity', status: 'established', reason: null, identity: { role: 'broker-daemon', entryRealpathSha256: brokerEntryDigest, pid: 60200, ppid: 60100, firstWriteEpochMs: 3000, startOriginMs: 3000.2, firstWritePreciseMs: 3100.6, nonceSha256: sha(scopeNonce) }, readStartedEpochMs: 1900, readEpochMs: 2100 },
      brokerObservation: observation(60200, 60100, 'S-DAEMON', sha(scopeNonce), 3300, 3400, 3500, 3000),
      transportObservation: observation(60300, 60200, 'S-TRANSPORT', sha(transport), 2000, 2200, 2500, 5000),
      ancestryEndpoints: {
        companion: observation(60100, 600, 'S-COMPANION', sha(scopeNonce), 4600, 4650, 4700, 1000),
        daemon: observation(60200, 60100, 'S-DAEMON', sha(scopeNonce), 4600, 4650, 4750, 3000),
        transportMarker: { pid: 60300, ppid: 60200, nonceSha256: sha(transport), markerEpochMs: 4450 },
      },
      ancestryEndpointRefreshes: { companion: null, daemon: null },
      ancestry: { localProcessObservationVersion: 1, class: 'ancestry-join', nonceSha256: sha(scopeNonce), companionToTransportAttributed: true, hops: [
        { hop: 'companion-to-daemon', status: 'established', reason: null },
        { hop: 'daemon-to-transport', status: 'established', reason: null },
      ] },
      duties: { localProcessObservationVersion: 1, class: 'local-duty-verdict', settled: true, duties: [
        { duty: 'invocation-process', status: 'established', reasons: [], identity: { pid: 60100, startIdentity: 'S-COMPANION', nonceSha256: sha(scopeNonce) } },
        { duty: 'broker-daemon', status: 'established', reasons: [], identity: { pid: 60200, startIdentity: 'S-DAEMON', nonceSha256: sha(scopeNonce) } },
        { duty: 'transport-descendant', status: 'established', reasons: [], identity: { pid: 60300, startIdentity: 'S-TRANSPORT', nonceSha256: sha(transport) } },
      ] },
      transportExit: { localProcessObservationVersion: 1, class: 'os-live-observation', status: 'absent', reason: 'no-such-process', observation: null, queried: { pid: 60300, nonceSha256: sha(transport) }, readStartedEpochMs: 5200, identityReadEpochMs: 5250, readEpochMs: 5300, absenceConfirmed: true },
      reads: [{ localProcessObservationVersion: 1, class: 'os-live-observation', status: 'absent', reason: 'no-such-process', observation: null, queried: { pid: 60100, nonceSha256: sha(scopeNonce) }, readStartedEpochMs: 4900, readEpochMs: 5100, absenceConfirmed: true }],
      exit: { localProcessObservationVersion: 1, class: 'exit-absence', status: 'disappeared', reason: null, boundIdentity: { pid: 60100, startIdentity: 'S-COMPANION', nonceSha256: sha(scopeNonce) }, lastVerifiedPresenceEpochMs: 2100, firstVerifiedAbsenceEpochMs: 5100, exitCorroboratedByMeta: false },
      stoppedAt: null, fenceAtMs: null, cutoffAtMs: MEASUREMENT_CUTOFF_AT_MS, cleanupBoundaryAtMs: null, composedAtMs: 6000,
    };
    const record = (over = {}) => ({
      status: 'executed', case: 'rescue-interrupt', executedAt: '2026-10-30T00:00:00.000Z',
      interrupt: { measurementCutoffAtMs: MEASUREMENT_CUTOFF_AT_MS },
      stdoutCaptureDeclaration: {
        preload: 'closure-observe.mjs', preloadSha256: sha('preload-bytes'), maxBytes: 65536,
        gate: { argv: ['invoke-prepared', 'rescue'], declaredEntryRealpathSha256: launcherEntryDigest },
        brokerGate: { declaredBrokerEntryRealpathSha256: brokerEntryDigest },
        identityRecord: { version: 2, roles: { invocation: 'identity.json', brokerDaemon: 'identity-broker.json' } },
        environmentVariables: [],
      },
      observations: {}, child: {},
      localProcess: block,
      ...over,
    });
    return { scopeNonce, transport, block, record };
  };
  const cleanCopy = (base) => JSON.parse(JSON.stringify(base));

  test('F1 (P1) RED → the scheduled measurement cutoff is an INTEGER wall ms (the fractional monotonic arithmetic is floored at the producer)', async () => {
    // The REAL monotonic clock (performance.now()) is fractional: the
    // production arithmetic holdDeadlineWallMs = wallClockNow() +
    // (holdDeadline - now()) inherits the fraction, so the persisted cutoff
    // carried fractional ms and the replay's integer checks refused every
    // scheduled run (local-fence-unestablished).
    const CAPTURE_NONCE = 'c'.repeat(64);
    const TRANSPORT_NONCE = '9'.repeat(64);
    const ENTRY = '/private/tmp/fixture-installed/skills/rescue/launcher.mjs';
    const BROKER_ENTRY = '/private/tmp/fixture-installed/scripts/zcode-broker.mjs';
    const declaration = { captureDirectory: '/private/tmp/fixture-capture-r13', nonce: CAPTURE_NONCE, entryRealpath: ENTRY, brokerEntryRealpath: BROKER_ENTRY };
    const BASE = Math.floor(Date.now() / 1000) * 1000;
    const COMPANION_START = BASE - 4_000;
    const DAEMON_START = BASE - 2_000;
    const MARKER_EPOCH = BASE - 1_000;
    const admissionEstablished = () => ({
      localProcessObservationVersion: 1, class: 'startup-identity', status: 'established', reason: null,
      identity: { role: 'invocation', nonce: CAPTURE_NONCE, entryRealpath: ENTRY, argv: ['invoke-prepared', 'rescue'], pid: 60100, ppid: 600, firstWriteEpochMs: COMPANION_START + 80, startOriginMs: COMPANION_START + 50, firstWritePreciseMs: COMPANION_START + 80.5 },
      readStartedEpochMs: Date.now(), readEpochMs: Date.now(),
    });
    const osEstablished = (pid, ppid, startIdentity, nonce, startInstant) => ({
      localProcessObservationVersion: 1, class: 'os-live-observation', status: 'established', reason: null,
      observation: { pid, ppid, startIdentity, nonce, startInstantEpochMs: startInstant, ppidChangedFromCapture: null },
      queried: { pid, nonce }, readStartedEpochMs: Date.now(), identityReadEpochMs: Date.now(), readEpochMs: Date.now(), absenceConfirmed: null,
    });
    let companionReads = 0;
    let transportReads = 0;
    const held = await runHeldHostTurn({
      gatePath: 'unused-gate',
      // The hold expires on the REAL monotonic clock (1.5 s): the turn ends
      // while the runtime's facts are long since composed, and the fence
      // producer runs its arithmetic against the REAL fractional monotonic —
      // the reviewer's reproduction exactly.
      holdMs: 1_500,
      budgetMs: 10_000_000_000,
      measurementCutoffSchedule: true,
      launch: async () => ({
        result: new Promise((resolve) => {
          const anchor = setInterval(() => { if (companionReads >= 3) { clearInterval(anchor); resolve({ code: 0, stdout: '', stderr: '' }); } }, 5);
          anchor.unref?.();
          setTimeout(() => { clearInterval(anchor); resolve({ code: 0, stdout: '', stderr: '' }); }, 10_000).unref?.();
        }),
        terminate: async () => {},
      }),
      waitForGate: async () => {},
      captureProcessIdentity: async () => ({ pid: 60300, ppid: 60200, nonce: TRANSPORT_NONCE, startIdentity: 'S-TRANSPORT', markerEpochMs: MARKER_EPOCH }),
      readProcessIdentity: async () => undefined,
      terminateProcessIdentity: async () => ({ attempted: true, signalled: 'SIGTERM', exited: true, failure: null }),
      waitForProcessExit: async () => {},
      releaseGate: async () => {},
      localObservation: declaration,
      captureLocalObservationIdentity: async () => admissionEstablished(),
      observeLocalObservationIdentity: async () => {
        companionReads += 1;
        if (companionReads === 1) return osEstablished(60100, 600, 'S-COMPANION', CAPTURE_NONCE, COMPANION_START);
        if (companionReads === 2) return osEstablished(60100, 600, 'S-COMPANION', CAPTURE_NONCE, COMPANION_START);
        return new Promise((resolve) => setTimeout(() => resolve({
          localProcessObservationVersion: 1, class: 'os-live-observation', status: 'absent', reason: 'no-such-process',
          observation: null, queried: { pid: 60100, nonce: CAPTURE_NONCE },
          readStartedEpochMs: Date.now(), readEpochMs: Date.now(), absenceConfirmed: true,
        }), 30));
      },
      captureLocalBrokerObservationIdentity: async () => ({ ...admissionEstablished(), identity: { role: 'broker-daemon', nonce: CAPTURE_NONCE, entryRealpath: BROKER_ENTRY, configRealpathSha256: 'b'.repeat(64), pid: 60200, ppid: 60100, firstWriteEpochMs: DAEMON_START + 70, startOriginMs: DAEMON_START + 45, firstWritePreciseMs: DAEMON_START + 70.5 } }),
      observeLocalBrokerObservationIdentity: async () => osEstablished(60200, 60100, 'S-DAEMON', CAPTURE_NONCE, DAEMON_START),
      observeLocalTransportObservationIdentity: async () => {
        transportReads += 1;

        if (transportReads === 1) return osEstablished(60300, 60200, 'S-TRANSPORT', TRANSPORT_NONCE, MARKER_EPOCH - 500);
        return new Promise((resolve) => setTimeout(() => resolve({
          localProcessObservationVersion: 1, class: 'os-live-observation', status: 'absent', reason: 'no-such-process',
          observation: null, queried: { pid: 60300, nonce: TRANSPORT_NONCE },
          readStartedEpochMs: Date.now(), readEpochMs: Date.now(), absenceConfirmed: true,
        }), 30));
      },
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5))),
      // The REAL monotonic clock: production's arithmetic inherits its
      // fraction exactly as the reviewer reproduced.
      now: () => performance.now(),
      processNonce: TRANSPORT_NONCE,
    });
    const cutoff = held.cleanup.measurementCutoffAtMs;
    assert.ok(Number.isSafeInteger(cutoff), `the persisted measurement cutoff is an integer wall ms (actual ${cutoff})`);
    const block = held.cleanup.localObservation;
    assert.equal(block.cutoffAtMs, cutoff, 'the echoed cutoff agrees with the persisted fence');
  });

  test('F2 (P2) RED → an ancestry endpoint whose IDENTITY read sits OUTSIDE its collection interval never credits post-fence ancestry evidence', () => {
    const g = armRound13();
    const torn = cleanCopy(g.record());
    // The daemon endpoint's completion (4750) is pre-fence, but its IDENTITY
    // read (25000) is post-cutoff — the hop lifetimes would consume the
    // post-fence identity evidence through the earlier completion stamp.
    torn.localProcess.ancestryEndpoints.daemon.identityReadEpochMs = 25_000;
    torn.localProcess.ancestryEndpoints.transportMarker.markerEpochMs = 21_000;
    const consolidated = nativeInterruptionGateDInput(torn).localProcessDuties;
    assert.equal(consolidated.settled, false, 'post-fence identity evidence never credits the ancestry');
    assert.ok(consolidated.refusals.includes('observation-identity-read-outside-interval'), JSON.stringify(consolidated.refusals));
  });

  test("F3 (P2) RED → the replay enforces the FROZEN argv selector: a persisted declaration and admission agreeing on a WRONG selector never settle", () => {
    const g = armRound13();
    const torn = cleanCopy(g.record());
    torn.localProcess.admission.identity.argv = ['status', 'list'];
    torn.stdoutCaptureDeclaration.gate.argv = ['status', 'list'];
    const consolidated = nativeInterruptionGateDInput(torn).localProcessDuties;
    assert.equal(consolidated.settled, false, 'only the frozen selector establishes this invocation role');
    assert.ok(consolidated.refusals.includes('admission-selector-foreign'), JSON.stringify(consolidated.refusals));
  });

  test('F4 (P2) RED → a persisted block with an UNSUPPORTED schema version refuses by name (the join never substitutes its own version)', () => {
    const g = armRound13();
    const torn = cleanCopy(g.record());
    torn.localProcess.version = 999;
    const consolidated = nativeInterruptionGateDInput(torn).localProcessDuties;
    assert.equal(consolidated.settled, false, 'an unsupported block version never composes as the current schema');
    assert.ok(consolidated.refusals.includes('local-process-block-version-unsupported'), JSON.stringify(consolidated.refusals));
    const missing = cleanCopy(g.record());
    delete missing.localProcess.version;
    const consolidatedMissing = nativeInterruptionGateDInput(missing).localProcessDuties;
    assert.equal(consolidatedMissing.settled, false);
    assert.ok(consolidatedMissing.refusals.includes('local-process-block-version-unsupported'), JSON.stringify(consolidatedMissing.refusals));
  });

  test('the join version registers the round-13 replay growth', () => {
    assert.equal(NATIVE_INTERRUPTION_GATE_D_JOIN_VERSION, 37, 'join v18 (2026-10-30 local-settlement Task 3 review round 14): the tied-absence collection continuation, the transport-exit recency/carried-identity re-adjudication and the incomplete-interval start refusals; v17 (round 13): the identity-read containment check, the FROZEN argv selector enforced over mere persisted agreement, and the persisted block-version gate; v16 (round 12) = the collection-interval validity for every fence-crediting read + the consistent materialization-unavailable provenance fallback; v15 (round 11) = the invocation-absence strict tie, the contradictory-duplicate-duty-slot refusal and the selected-endpoint parentage rule covering a failed refresh; v14 (round 10) = the transport PID-reuse latch + the strict transport-absence tie rule; v13 (round 9) = the transport-exit recency/carried-identity re-adjudication; v12 (round 8) = the generation-bound PRE-FENCE transport-exit conjunct, the refreshed-presence horizon/supersession and the admitted-record capture-time parentage');
  });
});

describe('local-settlement task 3 review round 14 (three P2): a tied absence never ends collection (a later strictly-later absence is collectable), the transport exit re-adjudicates recency and carried identity, and incomplete intervals refuse credit by name', async () => {
  const { runHeldHostTurn, nativeInterruptionGateDInput } = await import('../tools/shell-wait-probe/driver.mjs');
  const { createHash } = await import('node:crypto');
  const sha = (v) => createHash('sha256').update(v).digest('hex');
  const MEASUREMENT_CUTOFF_AT_MS = 20_000;

  const armRound14 = () => {
    const scopeNonce = 'a'.repeat(64);
    const transport = 'f'.repeat(64);
    const launcherEntryDigest = sha('launcher-entry');
    const brokerEntryDigest = sha('broker-entry');
    const observation = (pid, ppid, startIdentity, scope, readStarted, identityRead, readEpoch, startInstant = 1000) => ({
      localProcessObservationVersion: 1, class: 'os-live-observation', status: 'established', reason: null,
      observation: { pid, ppid, startIdentity, startInstantEpochMs: startInstant, ppidChangedFromCapture: null, nonceSha256: scope },
      queried: { pid, nonceSha256: scope },
      readStartedEpochMs: readStarted, identityReadEpochMs: identityRead, readEpochMs: readEpoch,
      absenceConfirmed: null,
    });
    const block = {
      version: 1, armed: true, clock: 'wall-epoch-ms', nonceSha256: sha(scopeNonce),
      admission: { localProcessObservationVersion: 1, class: 'startup-identity', status: 'established', reason: null, identity: { role: 'invocation', argv: ['invoke-prepared', 'rescue'], entryRealpathSha256: launcherEntryDigest, pid: 60100, ppid: 600, firstWriteEpochMs: 1000, startOriginMs: 1000.1, firstWritePreciseMs: 1100.5, nonceSha256: sha(scopeNonce) }, readStartedEpochMs: 1000, readEpochMs: 1100 },
      presence: observation(60100, 600, 'S-COMPANION', sha(scopeNonce), 1900, 2100, 2300),
      brokerAdmission: { localProcessObservationVersion: 1, class: 'startup-identity', status: 'established', reason: null, identity: { role: 'broker-daemon', entryRealpathSha256: brokerEntryDigest, pid: 60200, ppid: 60100, firstWriteEpochMs: 3000, startOriginMs: 3000.2, firstWritePreciseMs: 3100.6, nonceSha256: sha(scopeNonce) }, readStartedEpochMs: 1900, readEpochMs: 2100 },
      brokerObservation: observation(60200, 60100, 'S-DAEMON', sha(scopeNonce), 3300, 3400, 3500, 3000),
      transportObservation: observation(60300, 60200, 'S-TRANSPORT', sha(transport), 2000, 2200, 2500, 5000),
      ancestryEndpoints: {
        companion: observation(60100, 600, 'S-COMPANION', sha(scopeNonce), 4600, 4650, 4700, 1000),
        daemon: observation(60200, 60100, 'S-DAEMON', sha(scopeNonce), 4600, 4650, 4750, 3000),
        transportMarker: { pid: 60300, ppid: 60200, nonceSha256: sha(transport), markerEpochMs: 4450 },
      },
      ancestryEndpointRefreshes: { companion: null, daemon: null },
      ancestry: { localProcessObservationVersion: 1, class: 'ancestry-join', nonceSha256: sha(scopeNonce), companionToTransportAttributed: true, hops: [
        { hop: 'companion-to-daemon', status: 'established', reason: null },
        { hop: 'daemon-to-transport', status: 'established', reason: null },
      ] },
      duties: { localProcessObservationVersion: 1, class: 'local-duty-verdict', settled: true, duties: [
        { duty: 'invocation-process', status: 'established', reasons: [], identity: { pid: 60100, startIdentity: 'S-COMPANION', nonceSha256: sha(scopeNonce) } },
        { duty: 'broker-daemon', status: 'established', reasons: [], identity: { pid: 60200, startIdentity: 'S-DAEMON', nonceSha256: sha(scopeNonce) } },
        { duty: 'transport-descendant', status: 'established', reasons: [], identity: { pid: 60300, startIdentity: 'S-TRANSPORT', nonceSha256: sha(transport) } },
      ] },
      transportExit: { localProcessObservationVersion: 1, class: 'os-live-observation', status: 'absent', reason: 'no-such-process', observation: null, queried: { pid: 60300, nonceSha256: sha(transport) }, readStartedEpochMs: 5200, identityReadEpochMs: 5250, readEpochMs: 5300, absenceConfirmed: true },
      reads: [{ localProcessObservationVersion: 1, class: 'os-live-observation', status: 'absent', reason: 'no-such-process', observation: null, queried: { pid: 60100, nonceSha256: sha(scopeNonce) }, readStartedEpochMs: 4900, readEpochMs: 5100, absenceConfirmed: true }],
      exit: { localProcessObservationVersion: 1, class: 'exit-absence', status: 'disappeared', reason: null, boundIdentity: { pid: 60100, startIdentity: 'S-COMPANION', nonceSha256: sha(scopeNonce) }, lastVerifiedPresenceEpochMs: 2100, firstVerifiedAbsenceEpochMs: 5100, exitCorroboratedByMeta: false },
      stoppedAt: null, fenceAtMs: null, cutoffAtMs: MEASUREMENT_CUTOFF_AT_MS, cleanupBoundaryAtMs: null, composedAtMs: 6000,
    };
    const record = (over = {}) => ({
      status: 'executed', case: 'rescue-interrupt', executedAt: '2026-10-30T00:00:00.000Z',
      interrupt: { measurementCutoffAtMs: MEASUREMENT_CUTOFF_AT_MS },
      stdoutCaptureDeclaration: {
        preload: 'closure-observe.mjs', preloadSha256: sha('preload-bytes'), maxBytes: 65536,
        gate: { argv: ['invoke-prepared', 'rescue'], declaredEntryRealpathSha256: launcherEntryDigest },
        brokerGate: { declaredBrokerEntryRealpathSha256: brokerEntryDigest },
        identityRecord: { version: 2, roles: { invocation: 'identity.json', brokerDaemon: 'identity-broker.json' } },
        environmentVariables: [],
      },
      observations: {}, child: {},
      localProcess: block,
      ...over,
    });
    return { scopeNonce, transport, block, record };
  };
  const cleanCopy = (base) => JSON.parse(JSON.stringify(base));

  test('F2 (P2) RED → a transport absence whose collection started BEFORE its verified presence never credits (the recency rule applies to the transport exit)', () => {
    const g = armRound14();
    const torn = cleanCopy(g.record());
    torn.localProcess.transportExit.readStartedEpochMs = 2;
    torn.localProcess.transportExit.identityReadEpochMs = 3;
    torn.localProcess.transportExit.readEpochMs = 2_100;
    const consolidated = nativeInterruptionGateDInput(torn).localProcessDuties;
    assert.equal(consolidated.settled, false, 'an absence predating the transport presence proves nothing about what followed it');
    assert.ok(consolidated.refusals.includes('transport-exit-overlaps-presence'), JSON.stringify(consolidated.refusals));
  });

  test('F2 (P2) RED → a transport absence carrying a FOREIGN observed identity is replacement evidence, never this generation\'s death', () => {
    const g = armRound14();
    const torn = cleanCopy(g.record());
    torn.localProcess.transportExit.observedStartIdentity = 'S-TRANSPORT-REUSE';
    const consolidated = nativeInterruptionGateDInput(torn).localProcessDuties;
    assert.equal(consolidated.settled, false);
    assert.ok(consolidated.refusals.includes('transport-exit-generation-foreign'), JSON.stringify(consolidated.refusals));
  });

  test("F3 (P2) RED → a persisted ADMISSION whose collection START is missing never carries pre-fence credit", () => {
    const g = armRound14();
    const torn = cleanCopy(g.record());
    delete torn.localProcess.admission.readStartedEpochMs;
    const consolidated = nativeInterruptionGateDInput(torn).localProcessDuties;
    assert.equal(consolidated.settled, false, 'incomplete intervals are named-refused, never accepted');
    assert.ok(consolidated.refusals.includes('admission-start-unprovable'), JSON.stringify(consolidated.refusals));
  });

  test('F3 (P2) RED (class-sweep) → a duty observation and an ancestry endpoint with a MISSING collection start refuse by name', () => {
    const g = armRound14();
    const torn = cleanCopy(g.record());
    delete torn.localProcess.presence.readStartedEpochMs;
    delete torn.localProcess.ancestryEndpoints.companion.readStartedEpochMs;
    const consolidated = nativeInterruptionGateDInput(torn).localProcessDuties;
    assert.equal(consolidated.settled, false);
    assert.ok(consolidated.refusals.includes('observation-start-unprovable'), JSON.stringify(consolidated.refusals));
  });

  test('F1 (P2) RED (runtime) → a TIED confirmed absence never ends collection: the later strictly-later absence is collectable within the fence', async () => {
    const CAPTURE_NONCE = 'c'.repeat(64);
    const ENTRY = '/private/tmp/fixture-installed/skills/rescue/launcher.mjs';
    const BROKER_ENTRY = '/private/tmp/fixture-installed/scripts/zcode-broker.mjs';
    const declaration = { captureDirectory: '/private/tmp/fixture-capture-r14', nonce: CAPTURE_NONCE, entryRealpath: ENTRY, brokerEntryRealpath: BROKER_ENTRY };
    const admissionEstablished = () => ({
      localProcessObservationVersion: 1, class: 'startup-identity', status: 'established', reason: null,
      identity: { role: 'invocation', nonce: CAPTURE_NONCE, entryRealpath: ENTRY, argv: ['invoke-prepared', 'rescue'], pid: 60100, ppid: 600, firstWriteEpochMs: 1000, startOriginMs: 1000.1, firstWritePreciseMs: 1100.5 },
      readStartedEpochMs: 1000, readEpochMs: 1100,
    });
    const osEstablished = () => ({
      localProcessObservationVersion: 1, class: 'os-live-observation', status: 'established', reason: null,
      observation: { pid: 60100, ppid: 600, startIdentity: 'S-COMPANION', nonce: CAPTURE_NONCE, startInstantEpochMs: 1000, ppidChangedFromCapture: null },
      queried: { pid: 60100, nonce: CAPTURE_NONCE }, readStartedEpochMs: 1900, identityReadEpochMs: 2100, readEpochMs: 2300, absenceConfirmed: null,
    });
    const absenceRead = (readEpoch) => ({
      localProcessObservationVersion: 1, class: 'os-live-observation', status: 'absent', reason: 'no-such-process',
      observation: null, queried: { pid: 60100, nonce: CAPTURE_NONCE },
      readStartedEpochMs: readEpoch, readEpochMs: readEpoch, absenceConfirmed: true,
    });
    let companionReads = 0;
    const held = await runHeldHostTurn({
      gatePath: 'unused-gate',
      holdMs: 0,
      budgetMs: 60_000,
      launch: async () => ({
        result: new Promise((resolve) => {
          const anchor = setInterval(() => { if (companionReads >= 4) { clearInterval(anchor); resolve({ code: 0, stdout: '', stderr: '' }); } }, 2);
          anchor.unref?.();
          setTimeout(() => { clearInterval(anchor); resolve({ code: 0, stdout: '', stderr: '' }); }, 10_000).unref?.();
        }),
        terminate: async () => {},
      }),
      waitForGate: async () => {},
      captureProcessIdentity: async () => ({ pid: 60300, ppid: 60100, nonce: '9'.repeat(64), startIdentity: 'S-TRANSPORT' }),
      readProcessIdentity: async () => undefined,
      terminateProcessIdentity: async () => ({ attempted: true, signalled: 'SIGTERM', exited: true, failure: null }),
      waitForProcessExit: async () => {},
      releaseGate: async () => {},
      localObservation: declaration,
      captureLocalObservationIdentity: async () => admissionEstablished(),
      observeLocalObservationIdentity: async () => {
        companionReads += 1;
        // Call 1: the phase-2 presence. Call 2: the runtime's ancestry
        // REFRESH (same generation). Call 3: the phase-4's FIRST confirmed
        // absence TIED with the presence instant (2100 = 2100) — it can
        // never manufacture death. Calls 4+: the LATER confirmed absence
        // (strictly after the presence) — collectable within the fence.
        if (companionReads === 1) return osEstablished();
        if (companionReads === 2) return osEstablished();
        if (companionReads === 3) return absenceRead(2_100);
        return absenceRead(5_000);
      },
      captureLocalBrokerObservationIdentity: async () => ({ ...admissionEstablished(), identity: { role: 'broker-daemon', nonce: CAPTURE_NONCE, entryRealpath: BROKER_ENTRY, configRealpathSha256: 'b'.repeat(64), pid: 60200, ppid: 60100, firstWriteEpochMs: 1000, startOriginMs: 1000.2, firstWritePreciseMs: 1100.6 } }),
      observeLocalBrokerObservationIdentity: async () => ({ ...osEstablished(), observation: { pid: 60200, ppid: 60100, startIdentity: 'S-DAEMON', nonce: CAPTURE_NONCE, startInstantEpochMs: 1000, ppidChangedFromCapture: null }, queried: { pid: 60200, nonce: CAPTURE_NONCE } }),
      observeLocalTransportObservationIdentity: async () => ({ ...osEstablished(), observation: { pid: 60300, ppid: 60100, startIdentity: 'S-TRANSPORT', nonce: '9'.repeat(64), startInstantEpochMs: 1000, ppidChangedFromCapture: null }, queried: { pid: 60300, nonce: '9'.repeat(64) } }),
      sleep: async () => {},
      now: (() => { let value = 0; return () => (value += 500); })(),
      processNonce: '9'.repeat(64),
    });
    const block = held.cleanup.localObservation;
    assert.ok(block);
    // PRE-FIX: the loop broke on the tied absence → the exit stayed
    // unestablished (no-absence-read-after-presence). POST-FIX: collection
    // paced past the presence millisecond and the LATER strictly-later
    // absence established the disappearance within the fence.
    assert.equal(block.exit?.status, 'disappeared', `the later strictly-later absence establishes the disappearance (actual ${JSON.stringify(block.exit ?? null)})`);
    assert.equal(block.exit?.firstVerifiedAbsenceEpochMs, 5_000, 'the credited absence is the strictly-later one');
  });
});

describe('local-settlement task 3 review round 15 (three P2): duty observations carry identity-read containment, contradictory invocation absence shapes refuse, and the runtime compares against the LATEST same-generation presence before ending collection', async () => {
  const { nativeInterruptionGateDInput } = await import('../tools/shell-wait-probe/driver.mjs');
  const { createHash } = await import('node:crypto');
  const sha = (v) => createHash('sha256').update(v).digest('hex');
  const MEASUREMENT_CUTOFF_AT_MS = 20_000;

  const armRound15 = () => {
    const scopeNonce = 'a'.repeat(64);
    const transport = 'f'.repeat(64);
    const launcherEntryDigest = sha('launcher-entry');
    const brokerEntryDigest = sha('broker-entry');
    const observation = (pid, ppid, startIdentity, scope, readStarted, identityRead, readEpoch, startInstant = 1000) => ({
      localProcessObservationVersion: 1, class: 'os-live-observation', status: 'established', reason: null,
      observation: { pid, ppid, startIdentity, startInstantEpochMs: startInstant, ppidChangedFromCapture: null, nonceSha256: scope },
      queried: { pid, nonceSha256: scope },
      readStartedEpochMs: readStarted, identityReadEpochMs: identityRead, readEpochMs: readEpoch,
      absenceConfirmed: null,
    });
    const block = {
      version: 1, armed: true, clock: 'wall-epoch-ms', nonceSha256: sha(scopeNonce),
      admission: { localProcessObservationVersion: 1, class: 'startup-identity', status: 'established', reason: null, identity: { role: 'invocation', argv: ['invoke-prepared', 'rescue'], entryRealpathSha256: launcherEntryDigest, pid: 60100, ppid: 600, firstWriteEpochMs: 1000, startOriginMs: 1000.1, firstWritePreciseMs: 1100.5, nonceSha256: sha(scopeNonce) }, readStartedEpochMs: 1000, readEpochMs: 1100 },
      presence: observation(60100, 600, 'S-COMPANION', sha(scopeNonce), 1900, 2100, 2300),
      brokerAdmission: { localProcessObservationVersion: 1, class: 'startup-identity', status: 'established', reason: null, identity: { role: 'broker-daemon', entryRealpathSha256: brokerEntryDigest, pid: 60200, ppid: 60100, firstWriteEpochMs: 3000, startOriginMs: 3000.2, firstWritePreciseMs: 3100.6, nonceSha256: sha(scopeNonce) }, readStartedEpochMs: 1900, readEpochMs: 2100 },
      brokerObservation: observation(60200, 60100, 'S-DAEMON', sha(scopeNonce), 3300, 3400, 3500, 3000),
      transportObservation: observation(60300, 60200, 'S-TRANSPORT', sha(transport), 2000, 2200, 2500, 5000),
      ancestryEndpoints: {
        companion: observation(60100, 600, 'S-COMPANION', sha(scopeNonce), 4600, 4650, 4700, 1000),
        daemon: observation(60200, 60100, 'S-DAEMON', sha(scopeNonce), 4600, 4650, 4750, 3000),
        transportMarker: { pid: 60300, ppid: 60200, nonceSha256: sha(transport), markerEpochMs: 4450 },
      },
      ancestryEndpointRefreshes: { companion: null, daemon: null },
      ancestry: { localProcessObservationVersion: 1, class: 'ancestry-join', nonceSha256: sha(scopeNonce), companionToTransportAttributed: true, hops: [
        { hop: 'companion-to-daemon', status: 'established', reason: null },
        { hop: 'daemon-to-transport', status: 'established', reason: null },
      ] },
      duties: { localProcessObservationVersion: 1, class: 'local-duty-verdict', settled: true, duties: [
        { duty: 'invocation-process', status: 'established', reasons: [], identity: { pid: 60100, startIdentity: 'S-COMPANION', nonceSha256: sha(scopeNonce) } },
        { duty: 'broker-daemon', status: 'established', reasons: [], identity: { pid: 60200, startIdentity: 'S-DAEMON', nonceSha256: sha(scopeNonce) } },
        { duty: 'transport-descendant', status: 'established', reasons: [], identity: { pid: 60300, startIdentity: 'S-TRANSPORT', nonceSha256: sha(transport) } },
      ] },
      transportExit: { localProcessObservationVersion: 1, class: 'os-live-observation', status: 'absent', reason: 'no-such-process', observation: null, queried: { pid: 60300, nonceSha256: sha(transport) }, readStartedEpochMs: 5200, identityReadEpochMs: 5250, readEpochMs: 5300, absenceConfirmed: true },
      reads: [{ localProcessObservationVersion: 1, class: 'os-live-observation', status: 'absent', reason: 'no-such-process', observation: null, queried: { pid: 60100, nonceSha256: sha(scopeNonce) }, readStartedEpochMs: 4900, readEpochMs: 5100, absenceConfirmed: true }],
      exit: { localProcessObservationVersion: 1, class: 'exit-absence', status: 'disappeared', reason: null, boundIdentity: { pid: 60100, startIdentity: 'S-COMPANION', nonceSha256: sha(scopeNonce) }, lastVerifiedPresenceEpochMs: 2100, firstVerifiedAbsenceEpochMs: 5100, exitCorroboratedByMeta: false },
      stoppedAt: null, fenceAtMs: null, cutoffAtMs: MEASUREMENT_CUTOFF_AT_MS, cleanupBoundaryAtMs: null, composedAtMs: 6000,
    };
    const record = (over = {}) => ({
      status: 'executed', case: 'rescue-interrupt', executedAt: '2026-10-30T00:00:00.000Z',
      interrupt: { measurementCutoffAtMs: MEASUREMENT_CUTOFF_AT_MS },
      stdoutCaptureDeclaration: {
        preload: 'closure-observe.mjs', preloadSha256: sha('preload-bytes'), maxBytes: 65536,
        gate: { argv: ['invoke-prepared', 'rescue'], declaredEntryRealpathSha256: launcherEntryDigest },
        brokerGate: { declaredBrokerEntryRealpathSha256: brokerEntryDigest },
        identityRecord: { version: 2, roles: { invocation: 'identity.json', brokerDaemon: 'identity-broker.json' } },
        environmentVariables: [],
      },
      observations: {}, child: {},
      localProcess: block,
      ...over,
    });
    return { scopeNonce, transport, block, record };
  };
  const cleanCopy = (base) => JSON.parse(JSON.stringify(base));

  test('F1 (P2) RED → a DUTY observation whose IDENTITY read sits OUTSIDE its collection interval never establishes the duty', () => {
    const g = armRound15();
    const torn = cleanCopy(g.record());
    torn.localProcess.brokerObservation.identityReadEpochMs = 25_000;
    const consolidated = nativeInterruptionGateDInput(torn).localProcessDuties;
    assert.equal(consolidated.settled, false, 'post-fence identity evidence never establishes a duty');
    assert.ok(consolidated.refusals.includes('observation-identity-read-outside-interval'), JSON.stringify(consolidated.refusals));
  });

  test('F2 (P2) RED → a confirmed invocation absence carrying a NON-NULL live observation is contradictory evidence and refuses by name', () => {
    const g = armRound15();
    const torn = cleanCopy(g.record());
    torn.localProcess.reads[0].observation = { pid: 60100, ppid: 600, startIdentity: 'S-COMPANION', startInstantEpochMs: 1000, ppidChangedFromCapture: null, nonceSha256: sha(g.scopeNonce) };
    const consolidated = nativeInterruptionGateDInput(torn).localProcessDuties;
    assert.equal(consolidated.settled, false, 'a live observation inside a confirmed absence is contradictory, not a death');
    assert.ok(consolidated.refusals.includes('exit-absence-contradictory'), JSON.stringify(consolidated.refusals));
  });
});

describe('local-settlement task 3 review round 15 (runtime): the phase-4 loop compares against the LATEST same-generation presence before ending collection', async () => {
  const { runHeldHostTurn, nativeInterruptionGateDInput } = await import('../tools/shell-wait-probe/driver.mjs');
  const { createHash } = await import('node:crypto');
  const sha = (v) => createHash('sha256').update(v).digest('hex');

  test('F3 (P2) RED (runtime) → the ancestry refresh walks the runtime horizon: a tied absence does not end collection and the later strictly-later absence is collected', async () => {
    const CAPTURE_NONCE = 'c'.repeat(64);
    const TRANSPORT_NONCE = '9'.repeat(64);
    const ENTRY = '/private/tmp/fixture-installed/skills/rescue/launcher.mjs';
    const BROKER_ENTRY = '/private/tmp/fixture-installed/scripts/zcode-broker.mjs';
    const declaration = { captureDirectory: '/private/tmp/fixture-capture-r15b', nonce: CAPTURE_NONCE, entryRealpath: ENTRY, brokerEntryRealpath: BROKER_ENTRY };
    const BASE = Math.floor(Date.now() / 1000) * 1000;
    const COMPANION_START = BASE - 4_000;
    const DAEMON_START = BASE - 2_000;
    const MARKER_EPOCH = BASE - 1_000;
    const admissionEstablished = () => ({
      localProcessObservationVersion: 1, class: 'startup-identity', status: 'established', reason: null,
      identity: { role: 'invocation', nonce: CAPTURE_NONCE, entryRealpath: ENTRY, argv: ['invoke-prepared', 'rescue'], pid: 60100, ppid: 600, firstWriteEpochMs: COMPANION_START + 80, startOriginMs: COMPANION_START + 50, firstWritePreciseMs: COMPANION_START + 80.5 },
      readStartedEpochMs: Date.now(), readEpochMs: Date.now(),
    });
    const osEstablished = (pid, ppid, startIdentity, nonce, startInstant) => ({
      localProcessObservationVersion: 1, class: 'os-live-observation', status: 'established', reason: null,
      observation: { pid, ppid, startIdentity, nonce, startInstantEpochMs: startInstant, ppidChangedFromCapture: null },
      queried: { pid, nonce }, readStartedEpochMs: Date.now(), identityReadEpochMs: Date.now(), readEpochMs: Date.now(), absenceConfirmed: null,
    });
    let companionReads = 0;
    let transportReads = 0;
    let phaseThree = false;
    const held = await runHeldHostTurn({
      gatePath: 'unused-gate',
      holdMs: 300_000,
      budgetMs: 10_000_000_000,
      measurementCutoffSchedule: true,
      // The result anchors on the runtime's OWN phase-4 confirmed absence
      // (companion read 4): the tied absence does not end collection, so the
      // loop continues to the LATER strictly-later absence (read 4).
      launch: async () => ({
        result: new Promise((resolve) => {
          const anchor = setInterval(() => { if (companionReads >= 4) { clearInterval(anchor); resolve({ code: 0, stdout: '', stderr: '' }); } }, 5);
          anchor.unref?.();
          setTimeout(() => { clearInterval(anchor); resolve({ code: 0, stdout: '', stderr: '' }); }, 10_000).unref?.();
        }),
        terminate: async () => {},
      }),
      waitForGate: async () => {},
      captureProcessIdentity: async () => ({ pid: 60300, ppid: 60200, nonce: TRANSPORT_NONCE, startIdentity: 'S-TRANSPORT', markerEpochMs: MARKER_EPOCH }),
      readProcessIdentity: async () => undefined,
      terminateProcessIdentity: async () => ({ attempted: true, signalled: 'SIGTERM', exited: true, failure: null }),
      waitForProcessExit: async () => {},
      releaseGate: async () => {},
      localObservation: declaration,
      captureLocalObservationIdentity: async () => admissionEstablished(),
      observeLocalObservationIdentity: async () => {
        companionReads += 1;
        if (companionReads === 1) return osEstablished(60100, 600, 'S-COMPANION', CAPTURE_NONCE, COMPANION_START);
        if (companionReads === 2) return osEstablished(60100, 600, 'S-COMPANION', CAPTURE_NONCE, COMPANION_START);
        if (companionReads === 3) return new Promise((resolve) => setTimeout(() => resolve({
          localProcessObservationVersion: 1, class: 'os-live-observation', status: 'absent', reason: 'no-such-process',
          observation: null, queried: { pid: 60100, nonce: CAPTURE_NONCE },
          readStartedEpochMs: Date.now(), readEpochMs: Date.now(), absenceConfirmed: true,
        }), 30));
        return new Promise((resolve) => setTimeout(() => resolve({
          localProcessObservationVersion: 1, class: 'os-live-observation', status: 'absent', reason: 'no-such-process',
          observation: null, queried: { pid: 60100, nonce: CAPTURE_NONCE },
          readStartedEpochMs: Date.now(), readEpochMs: Date.now(), absenceConfirmed: true,
        }), 30));
      },
      captureLocalBrokerObservationIdentity: async () => ({ ...admissionEstablished(), identity: { role: 'broker-daemon', nonce: CAPTURE_NONCE, entryRealpath: BROKER_ENTRY, configRealpathSha256: 'b'.repeat(64), pid: 60200, ppid: 60100, firstWriteEpochMs: DAEMON_START + 70, startOriginMs: DAEMON_START + 45, firstWritePreciseMs: DAEMON_START + 70.5 } }),
      observeLocalBrokerObservationIdentity: async () => osEstablished(60200, 60100, 'S-DAEMON', CAPTURE_NONCE, DAEMON_START),
      observeLocalTransportObservationIdentity: async () => {
        transportReads += 1;
        phaseThree = true;
        if (transportReads === 1) return osEstablished(60300, 60200, 'S-TRANSPORT', TRANSPORT_NONCE, MARKER_EPOCH - 500);
        return new Promise((resolve) => setTimeout(() => resolve({
          localProcessObservationVersion: 1, class: 'os-live-observation', status: 'absent', reason: 'no-such-process',
          observation: null, queried: { pid: 60300, nonce: TRANSPORT_NONCE },
          readStartedEpochMs: Date.now(), readEpochMs: Date.now(), absenceConfirmed: true,
        }), 30));
      },
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5))),
      now: (() => { let value = 0; let gated = false; return () => {
        if (!gated) { if (phaseThree) gated = true; else return 0; }
        value += 500;
        return value;
      }; })(),
      processNonce: TRANSPORT_NONCE,
    });
    const block = held.cleanup.localObservation;
    assert.ok(block);
    // The runtime collected PAST the tied absence: the later strictly-later
    // absence establishes the disappearance within the fence.
    assert.equal(block.exit?.status, 'disappeared', `the exit disappears from the strictly-later absence (actual ${JSON.stringify(block.exit ?? null)})`);
    const joined = nativeInterruptionGateDInput({
      status: 'executed', case: 'rescue-interrupt',
      // (Review round 28, Finding 1) the harness mirrors the REAL record
      // composer (driver.mjs:1167): the interrupt carries the termination
      // boundary echo exactly when the runtime stamped one — the block and
      // the record are echo-consistent by construction.
      interrupt: {
        measurementCutoffAtMs: held.cleanup.measurementCutoffAtMs,
        ...(typeof held.cleanup.cleanupBoundaryAtMs === 'number' ? { cleanupBoundaryAtMs: held.cleanup.cleanupBoundaryAtMs } : {}),
      },
      stdoutCaptureDeclaration: {
        gate: { argv: ['invoke-prepared', 'rescue'], declaredEntryRealpathSha256: sha(ENTRY) },
        brokerGate: { declaredBrokerEntryRealpathSha256: sha(BROKER_ENTRY) },
      },
      observations: {}, child: {},
      localProcess: block,
    });
    assert.deepEqual(joined.localProcessDuties?.refusals, [], JSON.stringify(joined.localProcessDuties?.refusals));
    assert.equal(joined.localProcessDuties?.settled, true);
  });
});

describe('local-settlement task 3 review round 16 (two P2): the selected same-generation refresh joins the runtime exit horizon and the replay correlates exactly the adjudicator-admitted absences', async () => {
  const { nativeInterruptionGateDInput } = await import('../tools/shell-wait-probe/driver.mjs');
  const { createHash } = await import('node:crypto');
  const sha = (v) => createHash('sha256').update(v).digest('hex');
  const MEASUREMENT_CUTOFF_AT_MS = 20_000;

  const armRound16 = () => {
    const scopeNonce = 'a'.repeat(64);
    const transport = 'f'.repeat(64);
    const launcherEntryDigest = sha('launcher-entry');
    const brokerEntryDigest = sha('broker-entry');
    const observation = (pid, ppid, startIdentity, scope, readStarted, identityRead, readEpoch, startInstant = 1000) => ({
      localProcessObservationVersion: 1, class: 'os-live-observation', status: 'established', reason: null,
      observation: { pid, ppid, startIdentity, startInstantEpochMs: startInstant, ppidChangedFromCapture: null, nonceSha256: scope },
      queried: { pid, nonceSha256: scope },
      readStartedEpochMs: readStarted, identityReadEpochMs: identityRead, readEpochMs: readEpoch,
      absenceConfirmed: null,
    });
    const block = {
      version: 1, armed: true, clock: 'wall-epoch-ms', nonceSha256: sha(scopeNonce),
      admission: { localProcessObservationVersion: 1, class: 'startup-identity', status: 'established', reason: null, identity: { role: 'invocation', argv: ['invoke-prepared', 'rescue'], entryRealpathSha256: launcherEntryDigest, pid: 60100, ppid: 600, firstWriteEpochMs: 1000, startOriginMs: 1000.1, firstWritePreciseMs: 1100.5, nonceSha256: sha(scopeNonce) }, readStartedEpochMs: 1000, readEpochMs: 1100 },
      presence: observation(60100, 600, 'S-COMPANION', sha(scopeNonce), 1900, 2100, 2300),
      brokerAdmission: { localProcessObservationVersion: 1, class: 'startup-identity', status: 'established', reason: null, identity: { role: 'broker-daemon', entryRealpathSha256: brokerEntryDigest, pid: 60200, ppid: 60100, firstWriteEpochMs: 3000, startOriginMs: 3000.2, firstWritePreciseMs: 3100.6, nonceSha256: sha(scopeNonce) }, readStartedEpochMs: 1900, readEpochMs: 2100 },
      brokerObservation: observation(60200, 60100, 'S-DAEMON', sha(scopeNonce), 3300, 3400, 3500, 3000),
      transportObservation: observation(60300, 60200, 'S-TRANSPORT', sha(transport), 2000, 2200, 2500, 5000),
      ancestryEndpoints: {
        companion: observation(60100, 600, 'S-COMPANION', sha(scopeNonce), 4600, 4650, 4700, 1000),
        daemon: observation(60200, 60100, 'S-DAEMON', sha(scopeNonce), 4600, 4650, 4750, 3000),
        transportMarker: { pid: 60300, ppid: 60200, nonceSha256: sha(transport), markerEpochMs: 4450 },
      },
      ancestryEndpointRefreshes: { companion: null, daemon: null },
      ancestry: { localProcessObservationVersion: 1, class: 'ancestry-join', nonceSha256: sha(scopeNonce), companionToTransportAttributed: true, hops: [
        { hop: 'companion-to-daemon', status: 'established', reason: null },
        { hop: 'daemon-to-transport', status: 'established', reason: null },
      ] },
      duties: { localProcessObservationVersion: 1, class: 'local-duty-verdict', settled: true, duties: [
        { duty: 'invocation-process', status: 'established', reasons: [], identity: { pid: 60100, startIdentity: 'S-COMPANION', nonceSha256: sha(scopeNonce) } },
        { duty: 'broker-daemon', status: 'established', reasons: [], identity: { pid: 60200, startIdentity: 'S-DAEMON', nonceSha256: sha(scopeNonce) } },
        { duty: 'transport-descendant', status: 'established', reasons: [], identity: { pid: 60300, startIdentity: 'S-TRANSPORT', nonceSha256: sha(transport) } },
      ] },
      transportExit: { localProcessObservationVersion: 1, class: 'os-live-observation', status: 'absent', reason: 'no-such-process', observation: null, queried: { pid: 60300, nonceSha256: sha(transport) }, readStartedEpochMs: 5200, identityReadEpochMs: 5250, readEpochMs: 5300, absenceConfirmed: true },
      reads: [
        { localProcessObservationVersion: 1, class: 'os-live-observation', status: 'absent', reason: 'no-such-process', observation: null, queried: { pid: 60100, nonceSha256: sha(scopeNonce) }, readStartedEpochMs: 2100, readEpochMs: 2100, absenceConfirmed: true },
        { localProcessObservationVersion: 1, class: 'os-live-observation', status: 'absent', reason: 'no-such-process', observation: null, queried: { pid: 60100, nonceSha256: sha(scopeNonce) }, readStartedEpochMs: 4900, readEpochMs: 5100, absenceConfirmed: true },
      ],
      exit: { localProcessObservationVersion: 1, class: 'exit-absence', status: 'disappeared', reason: null, boundIdentity: { pid: 60100, startIdentity: 'S-COMPANION', nonceSha256: sha(scopeNonce) }, lastVerifiedPresenceEpochMs: 2100, firstVerifiedAbsenceEpochMs: 5100, exitCorroboratedByMeta: false },
      stoppedAt: null, fenceAtMs: null, cutoffAtMs: MEASUREMENT_CUTOFF_AT_MS, cleanupBoundaryAtMs: null, composedAtMs: 6000,
    };
    const record = (over = {}) => ({
      status: 'executed', case: 'rescue-interrupt', executedAt: '2026-10-30T00:00:00.000Z',
      interrupt: { measurementCutoffAtMs: MEASUREMENT_CUTOFF_AT_MS },
      stdoutCaptureDeclaration: {
        preload: 'closure-observe.mjs', preloadSha256: sha('preload-bytes'), maxBytes: 65536,
        gate: { argv: ['invoke-prepared', 'rescue'], declaredEntryRealpathSha256: launcherEntryDigest },
        brokerGate: { declaredBrokerEntryRealpathSha256: brokerEntryDigest },
        identityRecord: { version: 2, roles: { invocation: 'identity.json', brokerDaemon: 'identity-broker.json' } },
        environmentVariables: [],
      },
      observations: {}, child: {},
      localProcess: block,
      ...over,
    });
    return { scopeNonce, transport, block, record };
  };
  const cleanCopy = (base) => JSON.parse(JSON.stringify(base));

  test('F2 (P2) RED → a TIED absence followed by a strictly-later confirmed absence: the replay correlates exactly the ADMITTED absence (the later one), never the retained tie', () => {
    const g = armRound16();
    // The positive: the runtime collected a tied absence (2100/2100) and the
    // later strictly-later absence (4900-5100); the exit credits 5100.
    // PRE-FIX: the retained tie forces exit-absence-uncorrelated (min(2100,
    // 5100) ≠ 5100) and overlaps, rejecting the otherwise-settled record.
    const consolidated = nativeInterruptionGateDInput(g.record()).localProcessDuties;
    assert.deepEqual(consolidated.refusals, [], `the otherwise-settled record must not be rejected by the retained tie (${JSON.stringify(consolidated.refusals)})`);
    assert.equal(consolidated.settled, true);
    // The negative: with ONLY the tied absence, the disappeared verdict is
    // unsubstantiated (the tie overlaps the walked horizon).
    const tieOnly = cleanCopy(g.record());
    tieOnly.localProcess.reads = [tieOnly.localProcess.reads[0]];
    tieOnly.localProcess.exit = { ...tieOnly.localProcess.exit, firstVerifiedAbsenceEpochMs: 2100 };
    const consolidatedTieOnly = nativeInterruptionGateDInput(tieOnly).localProcessDuties;
    assert.equal(consolidatedTieOnly.settled, false, 'a tied absence alone never substantiates the disappearance');
    assert.ok(consolidatedTieOnly.refusals.includes('exit-absence-overlaps-presence'), JSON.stringify(consolidatedTieOnly.refusals));
  });
});

describe('local-settlement task 3 review round 17 (three P2): the credited transport absence validates its interval and recency, the replay re-verifies the SELECTED daemon endpoint parentage, and a tied transport absence keeps the retry loop sampling', async () => {
  const { nativeInterruptionGateDInput } = await import('../tools/shell-wait-probe/driver.mjs');
  const { createHash } = await import('node:crypto');
  const sha = (v) => createHash('sha256').update(v).digest('hex');
  const MEASUREMENT_CUTOFF_AT_MS = 20_000;

  const armRound17 = () => {
    const scopeNonce = 'a'.repeat(64);
    const transport = 'f'.repeat(64);
    const launcherEntryDigest = sha('launcher-entry');
    const brokerEntryDigest = sha('broker-entry');
    const observation = (pid, ppid, startIdentity, scope, readStarted, identityRead, readEpoch, startInstant = 1000) => ({
      localProcessObservationVersion: 1, class: 'os-live-observation', status: 'established', reason: null,
      observation: { pid, ppid, startIdentity, startInstantEpochMs: startInstant, ppidChangedFromCapture: null, nonceSha256: scope },
      queried: { pid, nonceSha256: scope },
      readStartedEpochMs: readStarted, identityReadEpochMs: identityRead, readEpochMs: readEpoch,
      absenceConfirmed: null,
    });
    const block = {
      version: 1, armed: true, clock: 'wall-epoch-ms', nonceSha256: sha(scopeNonce),
      admission: { localProcessObservationVersion: 1, class: 'startup-identity', status: 'established', reason: null, identity: { role: 'invocation', argv: ['invoke-prepared', 'rescue'], entryRealpathSha256: launcherEntryDigest, pid: 60100, ppid: 600, firstWriteEpochMs: 1000, startOriginMs: 1000.1, firstWritePreciseMs: 1100.5, nonceSha256: sha(scopeNonce) }, readStartedEpochMs: 1000, readEpochMs: 1100 },
      presence: observation(60100, 600, 'S-COMPANION', sha(scopeNonce), 1900, 2100, 2300),
      brokerAdmission: { localProcessObservationVersion: 1, class: 'startup-identity', status: 'established', reason: null, identity: { role: 'broker-daemon', entryRealpathSha256: brokerEntryDigest, pid: 60200, ppid: 60100, firstWriteEpochMs: 3000, startOriginMs: 3000.2, firstWritePreciseMs: 3100.6, nonceSha256: sha(scopeNonce) }, readStartedEpochMs: 1900, readEpochMs: 2100 },
      brokerObservation: observation(60200, 60100, 'S-DAEMON', sha(scopeNonce), 3300, 3400, 3500, 3000),
      transportObservation: observation(60300, 60200, 'S-TRANSPORT', sha(transport), 2000, 2200, 2500, 5000),
      ancestryEndpoints: {
        companion: observation(60100, 600, 'S-COMPANION', sha(scopeNonce), 4600, 4650, 4700, 1000),
        daemon: observation(60200, 60100, 'S-DAEMON', sha(scopeNonce), 4600, 4650, 4750, 3000),
        transportMarker: { pid: 60300, ppid: 60200, nonceSha256: sha(transport), markerEpochMs: 4450 },
      },
      ancestryEndpointRefreshes: { companion: null, daemon: null },
      ancestry: { localProcessObservationVersion: 1, class: 'ancestry-join', nonceSha256: sha(scopeNonce), companionToTransportAttributed: true, hops: [
        { hop: 'companion-to-daemon', status: 'established', reason: null },
        { hop: 'daemon-to-transport', status: 'established', reason: null },
      ] },
      duties: { localProcessObservationVersion: 1, class: 'local-duty-verdict', settled: true, duties: [
        { duty: 'invocation-process', status: 'established', reasons: [], identity: { pid: 60100, startIdentity: 'S-COMPANION', nonceSha256: sha(scopeNonce) } },
        { duty: 'broker-daemon', status: 'established', reasons: [], identity: { pid: 60200, startIdentity: 'S-DAEMON', nonceSha256: sha(scopeNonce) } },
        { duty: 'transport-descendant', status: 'established', reasons: [], identity: { pid: 60300, startIdentity: 'S-TRANSPORT', nonceSha256: sha(transport) } },
      ] },
      transportExit: { localProcessObservationVersion: 1, class: 'os-live-observation', status: 'absent', reason: 'no-such-process', observation: null, queried: { pid: 60300, nonceSha256: sha(transport) }, readStartedEpochMs: 5200, identityReadEpochMs: 5250, readEpochMs: 5300, absenceConfirmed: true },
      reads: [{ localProcessObservationVersion: 1, class: 'os-live-observation', status: 'absent', reason: 'no-such-process', observation: null, queried: { pid: 60100, nonceSha256: sha(scopeNonce) }, readStartedEpochMs: 4900, readEpochMs: 5100, absenceConfirmed: true }],
      exit: { localProcessObservationVersion: 1, class: 'exit-absence', status: 'disappeared', reason: null, boundIdentity: { pid: 60100, startIdentity: 'S-COMPANION', nonceSha256: sha(scopeNonce) }, lastVerifiedPresenceEpochMs: 2100, firstVerifiedAbsenceEpochMs: 5100, exitCorroboratedByMeta: false },
      stoppedAt: null, fenceAtMs: null, cutoffAtMs: MEASUREMENT_CUTOFF_AT_MS, cleanupBoundaryAtMs: null, composedAtMs: 6000,
    };
    const record = (over = {}) => ({
      status: 'executed', case: 'rescue-interrupt', executedAt: '2026-10-30T00:00:00.000Z',
      interrupt: { measurementCutoffAtMs: MEASUREMENT_CUTOFF_AT_MS },
      stdoutCaptureDeclaration: {
        preload: 'closure-observe.mjs', preloadSha256: sha('preload-bytes'), maxBytes: 65536,
        gate: { argv: ['invoke-prepared', 'rescue'], declaredEntryRealpathSha256: launcherEntryDigest },
        brokerGate: { declaredBrokerEntryRealpathSha256: brokerEntryDigest },
        identityRecord: { version: 2, roles: { invocation: 'identity.json', brokerDaemon: 'identity-broker.json' } },
        environmentVariables: [],
      },
      observations: {}, child: {},
      localProcess: block,
      ...over,
    });
    return { scopeNonce, transport, block, record };
  };
  const cleanCopy = (base) => JSON.parse(JSON.stringify(base));

  test('F1 (P2) RED → the CREDITED transport absence with an INVERTED collection interval (started after the boundary, completed before it) refuses', () => {
    const g = armRound17();
    const torn = cleanCopy(g.record());
    torn.localProcess.transportExit.readStartedEpochMs = MEASUREMENT_CUTOFF_AT_MS + 100;
    const consolidated = nativeInterruptionGateDInput(torn).localProcessDuties;
    assert.equal(consolidated.settled, false, 'an inverted interval is torn evidence that never fences');
    assert.ok(consolidated.refusals.includes('transport-exit-interval-inverted'), JSON.stringify(consolidated.refusals));
  });

  test('F2 (P2) RED → the SELECTED daemon endpoint with FOREIGN parentage (ppid 88888) refuses the ancestry chain', () => {
    const g = armRound17();
    const torn = cleanCopy(g.record());
    torn.localProcess.ancestryEndpoints.daemon.observation.ppid = 88888;
    const consolidated = nativeInterruptionGateDInput(torn).localProcessDuties;
    assert.equal(consolidated.settled, false, 'a contradictory selected endpoint never credits the ancestry chain');
    assert.ok(consolidated.refusals.includes('ancestry-ppid-chain-foreign'), JSON.stringify(consolidated.refusals));
  });
});

describe('local-settlement task 3 review round 18 (three P2): the correlated absence validates its interval, the SELECTED endpoint parentage is re-verified, and a tied transport absence keeps the retries sampling', async () => {
  const { runHeldHostTurn, nativeInterruptionGateDInput, NATIVE_INTERRUPTION_GATE_D_JOIN_VERSION } = await import('../tools/shell-wait-probe/driver.mjs');
  const { createHash } = await import('node:crypto');
  const sha = (v) => createHash('sha256').update(v).digest('hex');
  const MEASUREMENT_CUTOFF_AT_MS = 20_000;

  const armRound18 = () => {
    const scopeNonce = 'a'.repeat(64);
    const transport = 'f'.repeat(64);
    const launcherEntryDigest = sha('launcher-entry');
    const brokerEntryDigest = sha('broker-entry');
    const observation = (pid, ppid, startIdentity, scope, readStarted, identityRead, readEpoch, startInstant = 1000) => ({
      localProcessObservationVersion: 1, class: 'os-live-observation', status: 'established', reason: null,
      observation: { pid, ppid, startIdentity, startInstantEpochMs: startInstant, ppidChangedFromCapture: null, nonceSha256: scope },
      queried: { pid, nonceSha256: scope },
      readStartedEpochMs: readStarted, identityReadEpochMs: identityRead, readEpochMs: readEpoch,
      absenceConfirmed: null,
    });
    const block = {
      version: 1, armed: true, clock: 'wall-epoch-ms', nonceSha256: sha(scopeNonce),
      admission: { localProcessObservationVersion: 1, class: 'startup-identity', status: 'established', reason: null, identity: { role: 'invocation', argv: ['invoke-prepared', 'rescue'], entryRealpathSha256: launcherEntryDigest, pid: 60100, ppid: 600, firstWriteEpochMs: 1000, startOriginMs: 1000.1, firstWritePreciseMs: 1100.5, nonceSha256: sha(scopeNonce) }, readStartedEpochMs: 1000, readEpochMs: 1100 },
      presence: observation(60100, 600, 'S-COMPANION', sha(scopeNonce), 1900, 2100, 2300),
      brokerAdmission: { localProcessObservationVersion: 1, class: 'startup-identity', status: 'established', reason: null, identity: { role: 'broker-daemon', entryRealpathSha256: brokerEntryDigest, pid: 60200, ppid: 60100, firstWriteEpochMs: 3000, startOriginMs: 3000.2, firstWritePreciseMs: 3100.6, nonceSha256: sha(scopeNonce) }, readStartedEpochMs: 1900, readEpochMs: 2100 },
      brokerObservation: observation(60200, 60100, 'S-DAEMON', sha(scopeNonce), 3300, 3400, 3500, 3000),
      transportObservation: observation(60300, 60200, 'S-TRANSPORT', sha(transport), 2000, 2200, 2500, 5000),
      ancestryEndpoints: {
        companion: observation(60100, 600, 'S-COMPANION', sha(scopeNonce), 4600, 4650, 4700, 1000),
        daemon: observation(60200, 60100, 'S-DAEMON', sha(scopeNonce), 4600, 4650, 4750, 3000),
        transportMarker: { pid: 60300, ppid: 60200, nonceSha256: sha(transport), markerEpochMs: 4450 },
      },
      ancestryEndpointRefreshes: { companion: null, daemon: null },
      ancestry: { localProcessObservationVersion: 1, class: 'ancestry-join', nonceSha256: sha(scopeNonce), companionToTransportAttributed: true, hops: [
        { hop: 'companion-to-daemon', status: 'established', reason: null },
        { hop: 'daemon-to-transport', status: 'established', reason: null },
      ] },
      duties: { localProcessObservationVersion: 1, class: 'local-duty-verdict', settled: true, duties: [
        { duty: 'invocation-process', status: 'established', reasons: [], identity: { pid: 60100, startIdentity: 'S-COMPANION', nonceSha256: sha(scopeNonce) } },
        { duty: 'broker-daemon', status: 'established', reasons: [], identity: { pid: 60200, startIdentity: 'S-DAEMON', nonceSha256: sha(scopeNonce) } },
        { duty: 'transport-descendant', status: 'established', reasons: [], identity: { pid: 60300, startIdentity: 'S-TRANSPORT', nonceSha256: sha(transport) } },
      ] },
      transportExit: { localProcessObservationVersion: 1, class: 'os-live-observation', status: 'absent', reason: 'no-such-process', observation: null, queried: { pid: 60300, nonceSha256: sha(transport) }, readStartedEpochMs: 5200, identityReadEpochMs: 5250, readEpochMs: 5300, absenceConfirmed: true },
      reads: [{ localProcessObservationVersion: 1, class: 'os-live-observation', status: 'absent', reason: 'no-such-process', observation: null, queried: { pid: 60100, nonceSha256: sha(scopeNonce) }, readStartedEpochMs: 4900, readEpochMs: 5100, absenceConfirmed: true }],
      exit: { localProcessObservationVersion: 1, class: 'exit-absence', status: 'disappeared', reason: null, boundIdentity: { pid: 60100, startIdentity: 'S-COMPANION', nonceSha256: sha(scopeNonce) }, lastVerifiedPresenceEpochMs: 2100, firstVerifiedAbsenceEpochMs: 5100, exitCorroboratedByMeta: false },
      stoppedAt: null, fenceAtMs: null, cutoffAtMs: MEASUREMENT_CUTOFF_AT_MS, cleanupBoundaryAtMs: null, composedAtMs: 6000,
    };
    const record = (over = {}) => ({
      status: 'executed', case: 'rescue-interrupt', executedAt: '2026-10-30T00:00:00.000Z',
      interrupt: { measurementCutoffAtMs: MEASUREMENT_CUTOFF_AT_MS },
      stdoutCaptureDeclaration: {
        preload: 'closure-observe.mjs', preloadSha256: sha('preload-bytes'), maxBytes: 65536,
        gate: { argv: ['invoke-prepared', 'rescue'], declaredEntryRealpathSha256: launcherEntryDigest },
        brokerGate: { declaredBrokerEntryRealpathSha256: brokerEntryDigest },
        identityRecord: { version: 2, roles: { invocation: 'identity.json', brokerDaemon: 'identity-broker.json' } },
        environmentVariables: [],
      },
      observations: {}, child: {},
      localProcess: block,
      ...over,
    });
    return { scopeNonce, transport, block, record };
  };
  const cleanCopy = (base) => JSON.parse(JSON.stringify(base));

  test('F1 (P2) RED → the CREDITED invocation absence with an INVERTED collection interval is torn evidence and never correlates', () => {
    const g = armRound18();
    const torn = cleanCopy(g.record());
    // The reviewer's shape: the credited absence's collection START moved to
    // 21000 (after the cutoff) while the completion still claims 5100 — the
    // admissibility walk admitted the inverted read and correlated it.
    torn.localProcess.reads[0].readStartedEpochMs = 21_000;
    const consolidated = nativeInterruptionGateDInput(torn).localProcessDuties;
    assert.equal(consolidated.settled, false, 'an inverted interval is torn evidence that never correlates');
    assert.ok(consolidated.refusals.includes('exit-absence-interval-inverted'), JSON.stringify(consolidated.refusals));
  });

  test('F3 (P2) RED (runtime) → a TIED transport absence never ends the retry loop: the later strictly-later confirmed absence is collectable', async () => {
    const CAPTURE_NONCE = 'c'.repeat(64);
    const TRANSPORT_NONCE = '9'.repeat(64);
    const ENTRY = '/private/tmp/fixture-installed/skills/rescue/launcher.mjs';
    const BROKER_ENTRY = '/private/tmp/fixture-installed/scripts/zcode-broker.mjs';
    const declaration = { captureDirectory: '/private/tmp/fixture-capture-r18', nonce: CAPTURE_NONCE, entryRealpath: ENTRY, brokerEntryRealpath: BROKER_ENTRY };
    // FIXED, lifetime-consistent stamps: the companion starts at 1000, the
    // daemon at 2000, the marker at 3500 (within [daemonStart + bound,
    // daemonRead]), the transport at 3600; the transport's presence horizon
    // (its identityRead) is 3900; the TIED transport-exit read completes AT
    // 3900 (the tie) and the RETRY at 5000 (strictly later) — the runtime
    // keeps sampling past the tie and the retry is the admissible absence.
    const MARKER_EPOCH = 3_500;
    const TRANSPORT_PRESENCE_HORIZON = 3_900;
    const TIED_EXIT_READ_EPOCH = TRANSPORT_PRESENCE_HORIZON;
    const RETRY_EXIT_READ_EPOCH = TRANSPORT_PRESENCE_HORIZON + 1_100;
    const admissionEstablished = () => ({
      localProcessObservationVersion: 1, class: 'startup-identity', status: 'established', reason: null,
      identity: { role: 'invocation', nonce: CAPTURE_NONCE, entryRealpath: ENTRY, argv: ['invoke-prepared', 'rescue'], pid: 60100, ppid: 600, firstWriteEpochMs: 1000, startOriginMs: 1000.1, firstWritePreciseMs: 1100.5 },
      readStartedEpochMs: 900, readEpochMs: 1_000,
    });
    const osEstablished = (pid, ppid, startIdentity, nonce, startInstant, identityRead, readEpoch) => ({
      localProcessObservationVersion: 1, class: 'os-live-observation', status: 'established', reason: null,
      observation: { pid, ppid, startIdentity, nonce, startInstantEpochMs: startInstant, ppidChangedFromCapture: null },
      queried: { pid, nonce }, readStartedEpochMs: identityRead - 100, identityReadEpochMs: identityRead, readEpochMs: readEpoch, absenceConfirmed: null,
    });
    const confirmedAbsent = (pid, nonce, readEpoch) => ({
      localProcessObservationVersion: 1, class: 'os-live-observation', status: 'absent', reason: 'no-such-process',
      observation: null, queried: { pid, nonce }, readStartedEpochMs: readEpoch, identityReadEpochMs: readEpoch, readEpochMs: readEpoch, absenceConfirmed: true,
    });
    let companionReads = 0;
    let transportReads = 0;
    let phaseThree = false;
    const held = await runHeldHostTurn({
      gatePath: 'unused-gate',
      holdMs: 300_000,
      budgetMs: 10_000_000_000,
      measurementCutoffSchedule: true,
      // The result anchors on the runtime's OWN phase-4 confirmed absence
      // (companion read 3).
      launch: async () => ({
        result: new Promise((resolve) => {
          const anchor = setInterval(() => { if (companionReads >= 3) { clearInterval(anchor); resolve({ code: 0, stdout: '', stderr: '' }); } }, 5);
          anchor.unref?.();
          setTimeout(() => { clearInterval(anchor); resolve({ code: 0, stdout: '', stderr: '' }); }, 10_000).unref?.();
        }),
        terminate: async () => {},
      }),
      waitForGate: async () => {},
      captureProcessIdentity: async () => ({ pid: 60300, ppid: 60200, nonce: TRANSPORT_NONCE, startIdentity: 'S-TRANSPORT', markerEpochMs: MARKER_EPOCH }),
      readProcessIdentity: async () => undefined,
      terminateProcessIdentity: async () => ({ attempted: true, signalled: 'SIGTERM', exited: true, failure: null }),
      waitForProcessExit: async () => {},
      releaseGate: async () => {},
      localObservation: declaration,
      captureLocalObservationIdentity: async () => admissionEstablished(),
      observeLocalObservationIdentity: async () => {
        companionReads += 1;
        if (companionReads === 1) return osEstablished(60100, 600, 'S-COMPANION', CAPTURE_NONCE, 1_000, 2_100, 2_300);
        if (companionReads === 2) return osEstablished(60100, 600, 'S-COMPANION', CAPTURE_NONCE, 1_000, 3_600, 3_700);
        return confirmedAbsent(60100, CAPTURE_NONCE, 5_000);
      },
      captureLocalBrokerObservationIdentity: async () => ({ ...admissionEstablished(), identity: { role: 'broker-daemon', nonce: CAPTURE_NONCE, entryRealpath: BROKER_ENTRY, configRealpathSha256: 'b'.repeat(64), pid: 60200, ppid: 60100, firstWriteEpochMs: 2_000, startOriginMs: 2_000.2, firstWritePreciseMs: 2_100.6 } }),
      observeLocalBrokerObservationIdentity: async () => osEstablished(60200, 60100, 'S-DAEMON', CAPTURE_NONCE, 2_000, 3_750, 3_800),
      // Call 1: the transport observed ALIVE (its duty fact; its identity
      // instant 3900 is the transport presence horizon). Call 2: the FIRST
      // transport-exit read — CONFIRMED ABSENT but TIED with the transport
      // presence instant. Call 3: the RETRY — a strictly later confirmed
      // absence.
      observeLocalTransportObservationIdentity: async () => {
        transportReads += 1;
        phaseThree = true;
        if (transportReads === 1) return osEstablished(60300, 60200, 'S-TRANSPORT', TRANSPORT_NONCE, 3_600, 3_900, 4_000);
        if (transportReads === 2) return confirmedAbsent(60300, TRANSPORT_NONCE, TIED_EXIT_READ_EPOCH);
        return confirmedAbsent(60300, TRANSPORT_NONCE, RETRY_EXIT_READ_EPOCH);
      },
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5))),
      now: (() => { let value = 0; let gated = false; return () => {
        if (!gated) { if (phaseThree) gated = true; else return 0; }
        value += 500;
        return value;
      }; })(),
      processNonce: TRANSPORT_NONCE,
    });
    const block = held.cleanup.localObservation;
    assert.ok(block);
    // The retry loop kept sampling past the tied absence: the persisted
    // transport exit is the STRICTLY LATER confirmed absence, not the tie.
    assert.ok(Number.isSafeInteger(block.transportExit?.readEpochMs) && block.transportExit.readEpochMs > TRANSPORT_PRESENCE_HORIZON,
      `the credited transport exit is the strictly-later retry, not the tie (actual readEpoch ${JSON.stringify(block.transportExit?.readEpochMs ?? null)} vs horizon ${TRANSPORT_PRESENCE_HORIZON})`);
    const joined = nativeInterruptionGateDInput({
      status: 'executed', case: 'rescue-interrupt',
      // (Review round 28, Finding 1) the harness mirrors the REAL record
      // composer (driver.mjs:1167): the interrupt carries the termination
      // boundary echo exactly when the runtime stamped one — the block and
      // the record are echo-consistent by construction.
      interrupt: {
        measurementCutoffAtMs: held.cleanup.measurementCutoffAtMs,
        ...(typeof held.cleanup.cleanupBoundaryAtMs === 'number' ? { cleanupBoundaryAtMs: held.cleanup.cleanupBoundaryAtMs } : {}),
      },
      stdoutCaptureDeclaration: {
        gate: { argv: ['invoke-prepared', 'rescue'], declaredEntryRealpathSha256: sha(ENTRY) },
        brokerGate: { declaredBrokerEntryRealpathSha256: sha(BROKER_ENTRY) },
      },
      observations: {}, child: {},
      localProcess: block,
    });
    assert.deepEqual(joined.localProcessDuties?.refusals, [], JSON.stringify(joined.localProcessDuties?.refusals));
    assert.equal(joined.localProcessDuties?.settled, true);
  });


  test('the join version registers the round-18 replay growth', () => {
    assert.equal(NATIVE_INTERRUPTION_GATE_D_JOIN_VERSION, 37, 'join v21 (2026-10-30 local-settlement Task 3 review rounds 17-18): the correlated absence validates its collection interval (inverted intervals are torn evidence), the SELECTED daemon endpoint re-verifies its parentage against the presence/record rule and a tied transport absence keeps the retry loop sampling; v20 (round 16) = the duty-observation identity-read containment, the contradictory invocation-absence shape refusal and the runtime latest-same-generation-presence tie continuation; v19 (round 15) = the declared-scope binding, the identity-bearing absence reuse latch and the walked presence horizon; v18 (round 14) = the tied-absence collection continuation, the transport-exit recency/carried-identity re-adjudication and the incomplete-interval start refusals; v17 (round 13) = the identity-read containment check, the FROZEN argv selector enforced over mere persisted agreement, and the persisted block-version gate; v16 (round 12) = the collection-interval validity for every fence-crediting read + the consistent materialization-unavailable provenance fallback; v15 (round 11) = the invocation-absence strict tie, the contradictory-duplicate-duty-slot refusal and the selected-endpoint parentage rule covering a failed refresh; v14 (round 10) = the transport PID-reuse latch + the strict transport-absence tie rule; v13 (round 9) = the transport-exit recency/carried-identity re-adjudication; v12 (round 8) = the generation-bound PRE-FENCE transport-exit conjunct, the refreshed-presence horizon/supersession and the admitted-record capture-time parentage');
  });
});

describe('local-settlement task 3 review round 19 (two P2): a live same-generation transport retry advances the presence horizon (and persists for replay), and the exit supersession compares the identity-read instant', async () => {
  const { runHeldHostTurn, nativeInterruptionGateDInput, NATIVE_INTERRUPTION_GATE_D_JOIN_VERSION } = await import('../tools/shell-wait-probe/driver.mjs');
  const { createHash } = await import('node:crypto');
  const sha = (v) => createHash('sha256').update(v).digest('hex');
  const MEASUREMENT_CUTOFF_AT_MS = 20_000;

  const armRound19 = () => {
    const scopeNonce = 'a'.repeat(64);
    const transport = 'f'.repeat(64);
    const launcherEntryDigest = sha('launcher-entry');
    const brokerEntryDigest = sha('broker-entry');
    const observation = (pid, ppid, startIdentity, scope, readStarted, identityRead, readEpoch, startInstant = 1000) => ({
      localProcessObservationVersion: 1, class: 'os-live-observation', status: 'established', reason: null,
      observation: { pid, ppid, startIdentity, startInstantEpochMs: startInstant, ppidChangedFromCapture: null, nonceSha256: scope },
      queried: { pid, nonceSha256: scope },
      readStartedEpochMs: readStarted, identityReadEpochMs: identityRead, readEpochMs: readEpoch,
      absenceConfirmed: null,
    });
    const block = {
      version: 1, armed: true, clock: 'wall-epoch-ms', nonceSha256: sha(scopeNonce),
      admission: { localProcessObservationVersion: 1, class: 'startup-identity', status: 'established', reason: null, identity: { role: 'invocation', argv: ['invoke-prepared', 'rescue'], entryRealpathSha256: launcherEntryDigest, pid: 60100, ppid: 600, firstWriteEpochMs: 1000, startOriginMs: 1000.1, firstWritePreciseMs: 1100.5, nonceSha256: sha(scopeNonce) }, readStartedEpochMs: 1000, readEpochMs: 1100 },
      presence: observation(60100, 600, 'S-COMPANION', sha(scopeNonce), 1900, 2100, 2300),
      brokerAdmission: { localProcessObservationVersion: 1, class: 'startup-identity', status: 'established', reason: null, identity: { role: 'broker-daemon', entryRealpathSha256: brokerEntryDigest, pid: 60200, ppid: 60100, firstWriteEpochMs: 3000, startOriginMs: 3000.2, firstWritePreciseMs: 3100.6, nonceSha256: sha(scopeNonce) }, readStartedEpochMs: 1900, readEpochMs: 2100 },
      brokerObservation: observation(60200, 60100, 'S-DAEMON', sha(scopeNonce), 3300, 3400, 3500, 3000),
      transportObservation: observation(60300, 60200, 'S-TRANSPORT', sha(transport), 3800, 3900, 4000, 3600),
      // (Review round 19, Finding 1) the additive persisted sequence of LIVE
      // same-generation reads the transport-exit retries collected (the
      // horizon evidence the replay must see instead of the overwritten
      // final fact).
      transportPresenceReads: [observation(60300, 60200, 'S-TRANSPORT', sha(transport), 4800, 4900, 5000, 3600)],
      ancestryEndpoints: {
        companion: observation(60100, 600, 'S-COMPANION', sha(scopeNonce), 4600, 4650, 4700, 1000),
        daemon: observation(60200, 60100, 'S-DAEMON', sha(scopeNonce), 4600, 4650, 4750, 3000),
        transportMarker: { pid: 60300, ppid: 60200, nonceSha256: sha(transport), markerEpochMs: 4450 },
      },
      ancestryEndpointRefreshes: { companion: null, daemon: null },
      ancestry: { localProcessObservationVersion: 1, class: 'ancestry-join', nonceSha256: sha(scopeNonce), companionToTransportAttributed: true, hops: [
        { hop: 'companion-to-daemon', status: 'established', reason: null },
        { hop: 'daemon-to-transport', status: 'established', reason: null },
      ] },
      duties: { localProcessObservationVersion: 1, class: 'local-duty-verdict', settled: true, duties: [
        { duty: 'invocation-process', status: 'established', reasons: [], identity: { pid: 60100, startIdentity: 'S-COMPANION', nonceSha256: sha(scopeNonce) } },
        { duty: 'broker-daemon', status: 'established', reasons: [], identity: { pid: 60200, startIdentity: 'S-DAEMON', nonceSha256: sha(scopeNonce) } },
        { duty: 'transport-descendant', status: 'established', reasons: [], identity: { pid: 60300, startIdentity: 'S-TRANSPORT', nonceSha256: sha(transport) } },
      ] },
      transportExit: { localProcessObservationVersion: 1, class: 'os-live-observation', status: 'absent', reason: 'no-such-process', observation: null, queried: { pid: 60300, nonceSha256: sha(transport) }, readStartedEpochMs: 5200, identityReadEpochMs: 5250, readEpochMs: 5300, absenceConfirmed: true },
      reads: [{ localProcessObservationVersion: 1, class: 'os-live-observation', status: 'absent', reason: 'no-such-process', observation: null, queried: { pid: 60100, nonceSha256: sha(scopeNonce) }, readStartedEpochMs: 4900, readEpochMs: 5100, absenceConfirmed: true }],
      exit: { localProcessObservationVersion: 1, class: 'exit-absence', status: 'disappeared', reason: null, boundIdentity: { pid: 60100, startIdentity: 'S-COMPANION', nonceSha256: sha(scopeNonce) }, lastVerifiedPresenceEpochMs: 2100, firstVerifiedAbsenceEpochMs: 5100, exitCorroboratedByMeta: false },
      stoppedAt: null, fenceAtMs: null, cutoffAtMs: MEASUREMENT_CUTOFF_AT_MS, cleanupBoundaryAtMs: null, composedAtMs: 6000,
    };
    const record = (over = {}) => ({
      status: 'executed', case: 'rescue-interrupt', executedAt: '2026-10-30T00:00:00.000Z',
      interrupt: { measurementCutoffAtMs: MEASUREMENT_CUTOFF_AT_MS },
      stdoutCaptureDeclaration: {
        preload: 'closure-observe.mjs', preloadSha256: sha('preload-bytes'), maxBytes: 65536,
        gate: { argv: ['invoke-prepared', 'rescue'], declaredEntryRealpathSha256: launcherEntryDigest },
        brokerGate: { declaredBrokerEntryRealpathSha256: brokerEntryDigest },
        identityRecord: { version: 2, roles: { invocation: 'identity.json', brokerDaemon: 'identity-broker.json' } },
        environmentVariables: [],
      },
      observations: {}, child: {},
      localProcess: block,
      ...over,
    });
    return { scopeNonce, transport, block, record };
  };
  const cleanCopy = (base) => JSON.parse(JSON.stringify(base));

  test('F1 (P2) RED → a live same-generation transport RETRY advances the presence horizon: an absence tying with the RETRY presence never fences', () => {
    const g = armRound19();
    const torn = cleanCopy(g.record());
    // The reviewer's shape: the transport was re-verified ALIVE at 4900
    // (the persisted retry read); the next confirmed absence ties with THAT
    // presence (4900-4900) — against the INITIAL presence (3900) alone it
    // passes the recency walk and fences.
    torn.localProcess.transportExit = { ...torn.localProcess.transportExit, readStartedEpochMs: 4900, identityReadEpochMs: 4900, readEpochMs: 4900 };
    const consolidated = nativeInterruptionGateDInput(torn).localProcessDuties;
    assert.equal(consolidated.settled, false, 'an absence tying with the LATEST verified presence never manufactures death');
    assert.ok(consolidated.refusals.includes('transport-exit-overlaps-presence'), JSON.stringify(consolidated.refusals));
  });

  test('F2 (P2) RED → the exit SUPERSESSION compares the identity-read instant: an async completion after the absence never re-wins the verdict', () => {
    const g = armRound19();
    const torn = cleanCopy(g.record());
    // The reviewer's shape: the refreshed companion endpoint verified the
    // generation alive at 4650 (its identity read) but its ASYNC collection
    // completed at 5200 — after the verified absence (5100). The completion
    // alone supersedes; the verified instant does not.
    torn.localProcess.ancestryEndpoints.companion.readEpochMs = 5200;
    const consolidated = nativeInterruptionGateDInput(torn).localProcessDuties;
    assert.equal(consolidated.settled, true, 'the endpoint verified alive BEFORE the absence (4650 < 5100) — the async completion never re-wins');
    assert.deepEqual(consolidated.refusals, [], JSON.stringify(consolidated.refusals));
  });

  test('F1 (P2) RED (runtime) → a live same-generation transport retry advances the horizon and persists for replay: the later strictly-later absence is the credited exit', async () => {
    const CAPTURE_NONCE = 'c'.repeat(64);
    const TRANSPORT_NONCE = '9'.repeat(64);
    const ENTRY = '/private/tmp/fixture-installed/skills/rescue/launcher.mjs';
    const BROKER_ENTRY = '/private/tmp/fixture-installed/scripts/zcode-broker.mjs';
    const declaration = { captureDirectory: '/private/tmp/fixture-capture-r19', nonce: CAPTURE_NONCE, entryRealpath: ENTRY, brokerEntryRealpath: BROKER_ENTRY };
    // FIXED, lifetime-consistent stamps: the transport's presence horizon is
    // 3900 (its identity read); retry 1 re-verifies the SAME generation
    // ALIVE at 4900; the next confirmed absence ties with THAT retry
    // presence (4900) and must keep sampling; the strictly-later 6000
    // absence is the admissible exit.
    const MARKER_EPOCH = 3_500;
    const RETRY_PRESENCE_INSTANT = 4_900;
    const TIED_EXIT_READ_EPOCH = RETRY_PRESENCE_INSTANT;
    const RETRY_EXIT_READ_EPOCH = 6_000;
    const admissionEstablished = () => ({
      localProcessObservationVersion: 1, class: 'startup-identity', status: 'established', reason: null,
      identity: { role: 'invocation', nonce: CAPTURE_NONCE, entryRealpath: ENTRY, argv: ['invoke-prepared', 'rescue'], pid: 60100, ppid: 600, firstWriteEpochMs: 1000, startOriginMs: 1000.1, firstWritePreciseMs: 1100.5 },
      readStartedEpochMs: 900, readEpochMs: 1_000,
    });
    const osEstablished = (pid, ppid, startIdentity, nonce, startInstant, identityRead, readEpoch) => ({
      localProcessObservationVersion: 1, class: 'os-live-observation', status: 'established', reason: null,
      observation: { pid, ppid, startIdentity, nonce, startInstantEpochMs: startInstant, ppidChangedFromCapture: null },
      queried: { pid, nonce }, readStartedEpochMs: identityRead - 100, identityReadEpochMs: identityRead, readEpochMs: readEpoch, absenceConfirmed: null,
    });
    const confirmedAbsent = (pid, nonce, readEpoch) => ({
      localProcessObservationVersion: 1, class: 'os-live-observation', status: 'absent', reason: 'no-such-process',
      observation: null, queried: { pid, nonce }, readStartedEpochMs: readEpoch, identityReadEpochMs: readEpoch, readEpochMs: readEpoch, absenceConfirmed: true,
    });
    let companionReads = 0;
    let transportReads = 0;
    let phaseThree = false;
    const held = await runHeldHostTurn({
      gatePath: 'unused-gate',
      holdMs: 300_000,
      budgetMs: 10_000_000_000,
      measurementCutoffSchedule: true,
      // The result anchors on the runtime's OWN phase-4 confirmed absence
      // (companion read 3).
      launch: async () => ({
        result: new Promise((resolve) => {
          const anchor = setInterval(() => { if (companionReads >= 3) { clearInterval(anchor); resolve({ code: 0, stdout: '', stderr: '' }); } }, 5);
          anchor.unref?.();
          setTimeout(() => { clearInterval(anchor); resolve({ code: 0, stdout: '', stderr: '' }); }, 10_000).unref?.();
        }),
        terminate: async () => {},
      }),
      waitForGate: async () => {},
      captureProcessIdentity: async () => ({ pid: 60300, ppid: 60200, nonce: TRANSPORT_NONCE, startIdentity: 'S-TRANSPORT', markerEpochMs: MARKER_EPOCH }),
      readProcessIdentity: async () => undefined,
      terminateProcessIdentity: async () => ({ attempted: true, signalled: 'SIGTERM', exited: true, failure: null }),
      waitForProcessExit: async () => {},
      releaseGate: async () => {},
      localObservation: declaration,
      captureLocalObservationIdentity: async () => admissionEstablished(),
      observeLocalObservationIdentity: async () => {
        companionReads += 1;
        if (companionReads === 1) return osEstablished(60100, 600, 'S-COMPANION', CAPTURE_NONCE, 1_000, 2_100, 2_300);
        if (companionReads === 2) return osEstablished(60100, 600, 'S-COMPANION', CAPTURE_NONCE, 1_000, 3_600, 3_700);
        return confirmedAbsent(60100, CAPTURE_NONCE, 5_000);
      },
      captureLocalBrokerObservationIdentity: async () => ({ ...admissionEstablished(), identity: { role: 'broker-daemon', nonce: CAPTURE_NONCE, entryRealpath: BROKER_ENTRY, configRealpathSha256: 'b'.repeat(64), pid: 60200, ppid: 60100, firstWriteEpochMs: 2_000, startOriginMs: 2_000.2, firstWritePreciseMs: 2_100.6 } }),
      observeLocalBrokerObservationIdentity: async () => osEstablished(60200, 60100, 'S-DAEMON', CAPTURE_NONCE, 2_000, 3_750, 3_800),
      // Call 1: the phase-3 transport observation (presence horizon 3900).
      // Call 2: the LIVE same-generation retry (identity read 4900). Call 3:
      // the confirmed absence TIED with the retry presence (4900). Call 4:
      // the strictly-later confirmed absence (6000).
      observeLocalTransportObservationIdentity: async () => {
        transportReads += 1;
        phaseThree = true;
        if (transportReads === 1) return osEstablished(60300, 60200, 'S-TRANSPORT', TRANSPORT_NONCE, 3_600, 3_900, 4_000);
        if (transportReads === 2) return osEstablished(60300, 60200, 'S-TRANSPORT', TRANSPORT_NONCE, 3_600, RETRY_PRESENCE_INSTANT, 5_000);
        if (transportReads === 3) return confirmedAbsent(60300, TRANSPORT_NONCE, TIED_EXIT_READ_EPOCH);
        return confirmedAbsent(60300, TRANSPORT_NONCE, RETRY_EXIT_READ_EPOCH);
      },
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5))),
      now: (() => { let value = 0; let gated = false; return () => {
        if (!gated) { if (phaseThree) gated = true; else return 0; }
        value += 500;
        return value;
      }; })(),
      processNonce: TRANSPORT_NONCE,
    });
    const block = held.cleanup.localObservation;
    assert.ok(block);
    // The live retry persisted its evidence for replay.
    assert.ok(Array.isArray(block.transportPresenceReads) && block.transportPresenceReads.length === 1
      && block.transportPresenceReads[0]?.identityReadEpochMs === RETRY_PRESENCE_INSTANT,
      `the live retry is persisted for replay (actual ${JSON.stringify(block.transportPresenceReads ?? null)})`);
    // The loop kept sampling past the tied absence: the persisted transport
    // exit is the STRICTLY LATER confirmed absence.
    assert.ok(Number.isSafeInteger(block.transportExit?.readEpochMs) && block.transportExit.readEpochMs > RETRY_PRESENCE_INSTANT,
      `the credited transport exit is the strictly-later absence, not the tie (actual readEpoch ${JSON.stringify(block.transportExit?.readEpochMs ?? null)} vs the retry presence ${RETRY_PRESENCE_INSTANT})`);
    const joined = nativeInterruptionGateDInput({
      status: 'executed', case: 'rescue-interrupt',
      // (Review round 28, Finding 1) the harness mirrors the REAL record
      // composer (driver.mjs:1167): the interrupt carries the termination
      // boundary echo exactly when the runtime stamped one — the block and
      // the record are echo-consistent by construction.
      interrupt: {
        measurementCutoffAtMs: held.cleanup.measurementCutoffAtMs,
        ...(typeof held.cleanup.cleanupBoundaryAtMs === 'number' ? { cleanupBoundaryAtMs: held.cleanup.cleanupBoundaryAtMs } : {}),
      },
      stdoutCaptureDeclaration: {
        gate: { argv: ['invoke-prepared', 'rescue'], declaredEntryRealpathSha256: sha(ENTRY) },
        brokerGate: { declaredBrokerEntryRealpathSha256: sha(BROKER_ENTRY) },
      },
      observations: {}, child: {},
      localProcess: block,
    });
    assert.deepEqual(joined.localProcessDuties?.refusals, [], JSON.stringify(joined.localProcessDuties?.refusals));
    assert.equal(joined.localProcessDuties?.settled, true);
  });

  test('the join version registers the round-19 replay growth', () => {
    assert.equal(NATIVE_INTERRUPTION_GATE_D_JOIN_VERSION, 37, 'join v22 (2026-10-30 local-settlement Task 3 review round 19): a live same-generation transport retry advances the presence horizon and persists the full presence sequence for replay, and the exit supersession compares the identity-read instant (an async completion never re-wins); v21 (rounds 17-18): the correlated absence validates its collection interval (inverted intervals are torn evidence), the SELECTED daemon endpoint re-verifies its parentage against the presence/record rule and a tied transport absence keeps the retry loop sampling; v20 (round 16) = the duty-observation identity-read containment, the contradictory invocation-absence shape refusal and the runtime latest-same-generation-presence tie continuation; v19 (round 15) = the declared-scope binding, the identity-bearing absence reuse latch and the walked presence horizon; v18 (round 14) = the tied-absence collection continuation, the transport-exit recency/carried-identity re-adjudication and the incomplete-interval start refusals; v17 (round 13) = the identity-read containment check, the FROZEN argv selector enforced over mere persisted agreement, and the persisted block-version gate; v16 (round 12) = the collection-interval validity for every fence-crediting read + the consistent materialization-unavailable provenance fallback; v15 (round 11) = the invocation-absence strict tie, the contradictory-duplicate-duty-slot refusal and the selected-endpoint parentage rule covering a failed refresh; v14 (round 10) = the transport PID-reuse latch + the strict transport-absence tie rule; v13 (round 9) = the transport-exit recency/carried-identity re-adjudication; v12 (round 8) = the generation-bound PRE-FENCE transport-exit conjunct, the refreshed-presence horizon/supersession and the admitted-record capture-time parentage');
  });
});

describe('local-settlement task 3 review round 20 (two P2): the persisted transport retry sequence latches replacement evidence, and absence timestamps must be safe integers before crediting', async () => {
  const { nativeInterruptionGateDInput, NATIVE_INTERRUPTION_GATE_D_JOIN_VERSION } = await import('../tools/shell-wait-probe/driver.mjs');
  const { createHash } = await import('node:crypto');
  const sha = (v) => createHash('sha256').update(v).digest('hex');
  const MEASUREMENT_CUTOFF_AT_MS = 20_000;

  const armRound20 = () => {
    const scopeNonce = 'a'.repeat(64);
    const transport = 'f'.repeat(64);
    const launcherEntryDigest = sha('launcher-entry');
    const brokerEntryDigest = sha('broker-entry');
    const observation = (pid, ppid, startIdentity, scope, readStarted, identityRead, readEpoch, startInstant = 1000) => ({
      localProcessObservationVersion: 1, class: 'os-live-observation', status: 'established', reason: null,
      observation: { pid, ppid, startIdentity, startInstantEpochMs: startInstant, ppidChangedFromCapture: null, nonceSha256: scope },
      queried: { pid, nonceSha256: scope },
      readStartedEpochMs: readStarted, identityReadEpochMs: identityRead, readEpochMs: readEpoch,
      absenceConfirmed: null,
    });
    const block = {
      version: 1, armed: true, clock: 'wall-epoch-ms', nonceSha256: sha(scopeNonce),
      admission: { localProcessObservationVersion: 1, class: 'startup-identity', status: 'established', reason: null, identity: { role: 'invocation', argv: ['invoke-prepared', 'rescue'], entryRealpathSha256: launcherEntryDigest, pid: 60100, ppid: 600, firstWriteEpochMs: 1000, startOriginMs: 1000.1, firstWritePreciseMs: 1100.5, nonceSha256: sha(scopeNonce) }, readStartedEpochMs: 1000, readEpochMs: 1100 },
      presence: observation(60100, 600, 'S-COMPANION', sha(scopeNonce), 1900, 2100, 2300),
      brokerAdmission: { localProcessObservationVersion: 1, class: 'startup-identity', status: 'established', reason: null, identity: { role: 'broker-daemon', entryRealpathSha256: brokerEntryDigest, pid: 60200, ppid: 60100, firstWriteEpochMs: 3000, startOriginMs: 3000.2, firstWritePreciseMs: 3100.6, nonceSha256: sha(scopeNonce) }, readStartedEpochMs: 1900, readEpochMs: 2100 },
      brokerObservation: observation(60200, 60100, 'S-DAEMON', sha(scopeNonce), 3300, 3400, 3500, 3000),
      transportObservation: observation(60300, 60200, 'S-TRANSPORT', sha(transport), 3800, 3900, 4000, 3600),
      transportPresenceReads: [observation(60300, 60200, 'S-TRANSPORT', sha(transport), 4800, 4900, 5000, 3600)],
      ancestryEndpoints: {
        companion: observation(60100, 600, 'S-COMPANION', sha(scopeNonce), 4600, 4650, 4700, 1000),
        daemon: observation(60200, 60100, 'S-DAEMON', sha(scopeNonce), 4600, 4650, 4750, 3000),
        transportMarker: { pid: 60300, ppid: 60200, nonceSha256: sha(transport), markerEpochMs: 4450 },
      },
      ancestryEndpointRefreshes: { companion: null, daemon: null },
      ancestry: { localProcessObservationVersion: 1, class: 'ancestry-join', nonceSha256: sha(scopeNonce), companionToTransportAttributed: true, hops: [
        { hop: 'companion-to-daemon', status: 'established', reason: null },
        { hop: 'daemon-to-transport', status: 'established', reason: null },
      ] },
      duties: { localProcessObservationVersion: 1, class: 'local-duty-verdict', settled: true, duties: [
        { duty: 'invocation-process', status: 'established', reasons: [], identity: { pid: 60100, startIdentity: 'S-COMPANION', nonceSha256: sha(scopeNonce) } },
        { duty: 'broker-daemon', status: 'established', reasons: [], identity: { pid: 60200, startIdentity: 'S-DAEMON', nonceSha256: sha(scopeNonce) } },
        { duty: 'transport-descendant', status: 'established', reasons: [], identity: { pid: 60300, startIdentity: 'S-TRANSPORT', nonceSha256: sha(transport) } },
      ] },
      transportExit: { localProcessObservationVersion: 1, class: 'os-live-observation', status: 'absent', reason: 'no-such-process', observation: null, queried: { pid: 60300, nonceSha256: sha(transport) }, readStartedEpochMs: 5200, identityReadEpochMs: 5250, readEpochMs: 5300, absenceConfirmed: true },
      reads: [{ localProcessObservationVersion: 1, class: 'os-live-observation', status: 'absent', reason: 'no-such-process', observation: null, queried: { pid: 60100, nonceSha256: sha(scopeNonce) }, readStartedEpochMs: 4900, readEpochMs: 5100, absenceConfirmed: true }],
      exit: { localProcessObservationVersion: 1, class: 'exit-absence', status: 'disappeared', reason: null, boundIdentity: { pid: 60100, startIdentity: 'S-COMPANION', nonceSha256: sha(scopeNonce) }, lastVerifiedPresenceEpochMs: 2100, firstVerifiedAbsenceEpochMs: 5100, exitCorroboratedByMeta: false },
      stoppedAt: null, fenceAtMs: null, cutoffAtMs: MEASUREMENT_CUTOFF_AT_MS, cleanupBoundaryAtMs: null, composedAtMs: 6000,
    };
    const record = (over = {}) => ({
      status: 'executed', case: 'rescue-interrupt', executedAt: '2026-10-30T00:00:00.000Z',
      interrupt: { measurementCutoffAtMs: MEASUREMENT_CUTOFF_AT_MS },
      stdoutCaptureDeclaration: {
        preload: 'closure-observe.mjs', preloadSha256: sha('preload-bytes'), maxBytes: 65536,
        gate: { argv: ['invoke-prepared', 'rescue'], declaredEntryRealpathSha256: launcherEntryDigest },
        brokerGate: { declaredBrokerEntryRealpathSha256: brokerEntryDigest },
        identityRecord: { version: 2, roles: { invocation: 'identity.json', brokerDaemon: 'identity-broker.json' } },
        environmentVariables: [],
      },
      observations: {}, child: {},
      localProcess: block,
      ...over,
    });
    return { scopeNonce, transport, block, record };
  };
  const cleanCopy = (base) => JSON.parse(JSON.stringify(base));

  test('F1 (P2) RED → a persisted transport retry read carrying a DIFFERENT start identity is replacement evidence: the replay latches the reuse', () => {
    const g = armRound20();
    const torn = cleanCopy(g.record());
    // The reviewer's shape: the persisted retry sequence binds to the
    // transport's pid+nonce but observed a DIFFERENT start identity — the
    // positive replacement evidence the runtime would terminally latch.
    torn.localProcess.transportPresenceReads[0].observation.startIdentity = 'S-REPLACEMENT';
    const consolidated = nativeInterruptionGateDInput(torn).localProcessDuties;
    assert.equal(consolidated.settled, false, 'a persisted replacement observation never rides beside the original generation\'s confirmed absence');
    assert.ok(consolidated.refusals.includes('transport-exit-generation-foreign'), JSON.stringify(consolidated.refusals));
  });

  test('F1 sweep → the persisted sequence carrying the NAMED generation-change verdict (or a foreign observedStartIdentity) latches the same reuse refusal', () => {
    const g = armRound20();
    const namedVerdict = cleanCopy(g.record());
    namedVerdict.localProcess.transportPresenceReads[0] = {
      localProcessObservationVersion: 1, class: 'os-live-observation', status: 'unestablished', reason: 'start-identity-generation-changed',
      observation: null, queried: { pid: 60300, nonceSha256: sha(g.transport) },
      readStartedEpochMs: 4800, identityReadEpochMs: 4900, readEpochMs: 5000, absenceConfirmed: null,
    };
    const consolidatedNamed = nativeInterruptionGateDInput(namedVerdict).localProcessDuties;
    assert.equal(consolidatedNamed.settled, false);
    assert.ok(consolidatedNamed.refusals.includes('transport-exit-generation-foreign'), JSON.stringify(consolidatedNamed.refusals));
    const foreignCarried = cleanCopy(g.record());
    foreignCarried.localProcess.transportPresenceReads[0].observedStartIdentity = 'S-REPLACEMENT';
    const consolidatedCarried = nativeInterruptionGateDInput(foreignCarried).localProcessDuties;
    assert.equal(consolidatedCarried.settled, false);
    assert.ok(consolidatedCarried.refusals.includes('transport-exit-generation-foreign'), JSON.stringify(consolidatedCarried.refusals));
  });

  test('F2 (P2) RED → an absence whose collection START is a numeric STRING never credits: timestamps must be safe integers', () => {
    const g = armRound20();
    const torn = cleanCopy(g.record());
    // The reviewer's shape: the absence start moved to the STRING "25000"
    // (after the 20000 cutoff) while the completion claims 5100 — the
    // recency comparisons coerce the string and the torn read correlated.
    torn.localProcess.reads[0].readStartedEpochMs = '25000';
    const consolidated = nativeInterruptionGateDInput(torn).localProcessDuties;
    assert.equal(consolidated.settled, false, 'a nonnumeric instant is torn evidence that never correlates');
    assert.ok(consolidated.refusals.includes('exit-absence-interval-unprovable'), JSON.stringify(consolidated.refusals));
  });

  test('the join version registers the round-20 replay growth', () => {
    assert.equal(NATIVE_INTERRUPTION_GATE_D_JOIN_VERSION, 37, 'join v23 (2026-10-30 local-settlement Task 3 review round 20): the persisted transport retry sequence latches replacement evidence (any generation-bound read carrying a different start identity) and absence timestamps must be safe integers before crediting (nonnumeric instants refuse by name); v22 (round 19): a live same-generation transport retry advances the presence horizon and persists the full presence sequence for replay, and the exit supersession compares the identity-read instant (an async completion never re-wins); v21 (rounds 17-18): the correlated absence validates its collection interval (inverted intervals are torn evidence), the SELECTED daemon endpoint re-verifies its parentage against the presence/record rule and a tied transport absence keeps the retry loop sampling; v20 (round 16) = the duty-observation identity-read containment, the contradictory invocation-absence shape refusal and the runtime latest-same-generation-presence tie continuation; v19 (round 15) = the declared-scope binding, the identity-bearing absence reuse latch and the walked presence horizon; v18 (round 14) = the tied-absence collection continuation, the transport-exit recency/carried-identity re-adjudication and the incomplete-interval start refusals; v17 (round 13) = the identity-read containment check, the FROZEN argv selector enforced over mere persisted agreement, and the persisted block-version gate; v16 (round 12) = the collection-interval validity for every fence-crediting read + the consistent materialization-unavailable provenance fallback; v15 (round 11) = the invocation-absence strict tie, the contradictory-duplicate-duty-slot refusal and the selected-endpoint parentage rule covering a failed refresh; v14 (round 10) = the transport PID-reuse latch + the strict transport-absence tie rule; v13 (round 9) = the transport-exit recency/carried-identity re-adjudication; v12 (round 8) = the generation-bound PRE-FENCE transport-exit conjunct, the refreshed-presence horizon/supersession and the admitted-record capture-time parentage');
  });
});

describe('local-settlement task 3 review round 22 (two P2): every credited observation binds its queried pid/scope, and a malformed supplied identity-read instant refuses instead of falling back', async () => {
  const { nativeInterruptionGateDInput, NATIVE_INTERRUPTION_GATE_D_JOIN_VERSION } = await import('../tools/shell-wait-probe/driver.mjs');
  const { createHash } = await import('node:crypto');
  const sha = (v) => createHash('sha256').update(v).digest('hex');
  const MEASUREMENT_CUTOFF_AT_MS = 20_000;

  const armRound22 = () => {
    const scopeNonce = 'a'.repeat(64);
    const transport = 'f'.repeat(64);
    const launcherEntryDigest = sha('launcher-entry');
    const brokerEntryDigest = sha('broker-entry');
    const observation = (pid, ppid, startIdentity, scope, readStarted, identityRead, readEpoch, startInstant = 1000) => ({
      localProcessObservationVersion: 1, class: 'os-live-observation', status: 'established', reason: null,
      observation: { pid, ppid, startIdentity, startInstantEpochMs: startInstant, ppidChangedFromCapture: null, nonceSha256: scope },
      queried: { pid, nonceSha256: scope },
      readStartedEpochMs: readStarted, identityReadEpochMs: identityRead, readEpochMs: readEpoch,
      absenceConfirmed: null,
    });
    const block = {
      version: 1, armed: true, clock: 'wall-epoch-ms', nonceSha256: sha(scopeNonce),
      admission: { localProcessObservationVersion: 1, class: 'startup-identity', status: 'established', reason: null, identity: { role: 'invocation', argv: ['invoke-prepared', 'rescue'], entryRealpathSha256: launcherEntryDigest, pid: 60100, ppid: 600, firstWriteEpochMs: 1000, startOriginMs: 1000.1, firstWritePreciseMs: 1100.5, nonceSha256: sha(scopeNonce) }, readStartedEpochMs: 1000, readEpochMs: 1100 },
      presence: observation(60100, 600, 'S-COMPANION', sha(scopeNonce), 1900, 2100, 2300),
      brokerAdmission: { localProcessObservationVersion: 1, class: 'startup-identity', status: 'established', reason: null, identity: { role: 'broker-daemon', entryRealpathSha256: brokerEntryDigest, pid: 60200, ppid: 60100, firstWriteEpochMs: 3000, startOriginMs: 3000.2, firstWritePreciseMs: 3100.6, nonceSha256: sha(scopeNonce) }, readStartedEpochMs: 1900, readEpochMs: 2100 },
      brokerObservation: observation(60200, 60100, 'S-DAEMON', sha(scopeNonce), 3300, 3400, 3500, 3000),
      transportObservation: observation(60300, 60200, 'S-TRANSPORT', sha(transport), 3800, 3900, 4000, 3600),
      transportPresenceReads: [observation(60300, 60200, 'S-TRANSPORT', sha(transport), 4800, 4900, 5000, 3600)],
      ancestryEndpoints: {
        companion: observation(60100, 600, 'S-COMPANION', sha(scopeNonce), 4600, 4650, 4700, 1000),
        daemon: observation(60200, 60100, 'S-DAEMON', sha(scopeNonce), 4600, 4650, 4750, 3000),
        transportMarker: { pid: 60300, ppid: 60200, nonceSha256: sha(transport), markerEpochMs: 4450 },
      },
      ancestryEndpointRefreshes: { companion: null, daemon: null },
      ancestry: { localProcessObservationVersion: 1, class: 'ancestry-join', nonceSha256: sha(scopeNonce), companionToTransportAttributed: true, hops: [
        { hop: 'companion-to-daemon', status: 'established', reason: null },
        { hop: 'daemon-to-transport', status: 'established', reason: null },
      ] },
      duties: { localProcessObservationVersion: 1, class: 'local-duty-verdict', settled: true, duties: [
        { duty: 'invocation-process', status: 'established', reasons: [], identity: { pid: 60100, startIdentity: 'S-COMPANION', nonceSha256: sha(scopeNonce) } },
        { duty: 'broker-daemon', status: 'established', reasons: [], identity: { pid: 60200, startIdentity: 'S-DAEMON', nonceSha256: sha(scopeNonce) } },
        { duty: 'transport-descendant', status: 'established', reasons: [], identity: { pid: 60300, startIdentity: 'S-TRANSPORT', nonceSha256: sha(transport) } },
      ] },
      transportExit: { localProcessObservationVersion: 1, class: 'os-live-observation', status: 'absent', reason: 'no-such-process', observation: null, queried: { pid: 60300, nonceSha256: sha(transport) }, readStartedEpochMs: 5200, identityReadEpochMs: 5250, readEpochMs: 5300, absenceConfirmed: true },
      reads: [{ localProcessObservationVersion: 1, class: 'os-live-observation', status: 'absent', reason: 'no-such-process', observation: null, queried: { pid: 60100, nonceSha256: sha(scopeNonce) }, readStartedEpochMs: 4900, readEpochMs: 5100, absenceConfirmed: true }],
      exit: { localProcessObservationVersion: 1, class: 'exit-absence', status: 'disappeared', reason: null, boundIdentity: { pid: 60100, startIdentity: 'S-COMPANION', nonceSha256: sha(scopeNonce) }, lastVerifiedPresenceEpochMs: 2100, firstVerifiedAbsenceEpochMs: 5100, exitCorroboratedByMeta: false },
      stoppedAt: null, fenceAtMs: null, cutoffAtMs: MEASUREMENT_CUTOFF_AT_MS, cleanupBoundaryAtMs: null, composedAtMs: 6000,
    };
    const record = (over = {}) => ({
      status: 'executed', case: 'rescue-interrupt', executedAt: '2026-10-30T00:00:00.000Z',
      interrupt: { measurementCutoffAtMs: MEASUREMENT_CUTOFF_AT_MS },
      stdoutCaptureDeclaration: {
        preload: 'closure-observe.mjs', preloadSha256: sha('preload-bytes'), maxBytes: 65536,
        gate: { argv: ['invoke-prepared', 'rescue'], declaredEntryRealpathSha256: launcherEntryDigest },
        brokerGate: { declaredBrokerEntryRealpathSha256: brokerEntryDigest },
        identityRecord: { version: 2, roles: { invocation: 'identity.json', brokerDaemon: 'identity-broker.json' } },
        environmentVariables: [],
      },
      observations: {}, child: {},
      localProcess: block,
      ...over,
    });
    return { scopeNonce, transport, block, record };
  };
  const cleanCopy = (base) => JSON.parse(JSON.stringify(base));

  test('F1 (P2) RED → a duty observation QUERIED under a FOREIGN pid never credits the duty: the queried identity binds to the observed identity', () => {
    const g = armRound22();
    const torn = cleanCopy(g.record());
    // The reviewer's shape: only presence.queried.pid moved to a foreign
    // pid — the observed identity and every digest binding still agree, so
    // the echo rode straight through and the record settled.
    torn.localProcess.presence.queried.pid = 99999;
    const consolidated = nativeInterruptionGateDInput(torn).localProcessDuties;
    assert.equal(consolidated.settled, false, 'an observation queried under a foreign pid proves nothing about the observed process');
    assert.ok(consolidated.refusals.includes('inline-duty-identity-foreign'), JSON.stringify(consolidated.refusals));
  });

  test('F1 sweep → the queried binding covers the nonce digest, every duty slot and the ancestry endpoints', () => {
    const g = armRound22();
    const scopeTorn = cleanCopy(g.record());
    scopeTorn.localProcess.presence.queried.nonceSha256 = sha('a-foreign-scope');
    const consolidatedScope = nativeInterruptionGateDInput(scopeTorn).localProcessDuties;
    assert.equal(consolidatedScope.settled, false);
    assert.ok(consolidatedScope.refusals.includes('inline-duty-identity-foreign'), JSON.stringify(consolidatedScope.refusals));
    const brokerTorn = cleanCopy(g.record());
    brokerTorn.localProcess.brokerObservation.queried.pid = 99999;
    const consolidatedBroker = nativeInterruptionGateDInput(brokerTorn).localProcessDuties;
    assert.equal(consolidatedBroker.settled, false);
    assert.ok(consolidatedBroker.refusals.includes('inline-duty-identity-foreign'), JSON.stringify(consolidatedBroker.refusals));
    const transportTorn = cleanCopy(g.record());
    transportTorn.localProcess.transportObservation.queried.pid = 99999;
    const consolidatedTransport = nativeInterruptionGateDInput(transportTorn).localProcessDuties;
    assert.equal(consolidatedTransport.settled, false);
    assert.ok(consolidatedTransport.refusals.includes('inline-duty-identity-foreign'), JSON.stringify(consolidatedTransport.refusals));
    const endpointTorn = cleanCopy(g.record());
    endpointTorn.localProcess.ancestryEndpoints.daemon.queried.pid = 99999;
    const consolidatedEndpoint = nativeInterruptionGateDInput(endpointTorn).localProcessDuties;
    assert.equal(consolidatedEndpoint.settled, false, 'an ancestry endpoint queried under a foreign pid is generation-foreign evidence');
    assert.ok(consolidatedEndpoint.refusals.includes('ancestry-endpoint-generation-foreign'), JSON.stringify(consolidatedEndpoint.refusals));
  });

  test('F2 (P2) RED → a PRESENT but malformed identity-read instant refuses by name (the completion never substitutes)', () => {
    const g = armRound22();
    const torn = cleanCopy(g.record());
    // The reviewer's shape: the string "25000" (past the 20000 cutoff)
    // bypassed the containment check as if the instant were MISSING and the
    // earlier completion (2300) substituted — the numeric 25000 refuses.
    torn.localProcess.presence.identityReadEpochMs = '25000';
    const consolidated = nativeInterruptionGateDInput(torn).localProcessDuties;
    assert.equal(consolidated.settled, false, 'a malformed supplied instant is torn evidence, never an absent field');
    assert.ok(consolidated.refusals.includes('observation-identity-read-unprovable'), JSON.stringify(consolidated.refusals));
  });

  test('F2 sweep → the malformed-instant refusal covers every duty echo and the ancestry endpoints', () => {
    const g = armRound22();
    const brokerTorn = cleanCopy(g.record());
    brokerTorn.localProcess.brokerObservation.identityReadEpochMs = '25000';
    const consolidatedBroker = nativeInterruptionGateDInput(brokerTorn).localProcessDuties;
    assert.equal(consolidatedBroker.settled, false);
    assert.ok(consolidatedBroker.refusals.includes('observation-identity-read-unprovable'), JSON.stringify(consolidatedBroker.refusals));
    const endpointTorn = cleanCopy(g.record());
    endpointTorn.localProcess.ancestryEndpoints.companion.identityReadEpochMs = '25000';
    const consolidatedEndpoint = nativeInterruptionGateDInput(endpointTorn).localProcessDuties;
    assert.equal(consolidatedEndpoint.settled, false);
    assert.ok(consolidatedEndpoint.refusals.includes('observation-identity-read-unprovable'), JSON.stringify(consolidatedEndpoint.refusals));
    const transportTorn = cleanCopy(g.record());
    transportTorn.localProcess.transportObservation.identityReadEpochMs = '25000';
    const consolidatedTransport = nativeInterruptionGateDInput(transportTorn).localProcessDuties;
    assert.equal(consolidatedTransport.settled, false);
    assert.ok(consolidatedTransport.refusals.includes('observation-identity-read-unprovable'), JSON.stringify(consolidatedTransport.refusals));
  });

  test('the join version registers the round-22 replay growth', () => {
    assert.equal(NATIVE_INTERRUPTION_GATE_D_JOIN_VERSION, 37, 'join v24 (2026-10-30 local-settlement Task 3 review round 22): every credited observation binds its queried pid/scope digest to the observed identity (the duty echoes and the ancestry endpoints) and a present-but-malformed identity-read instant refuses by name instead of falling back to the completion; v23 (round 20): the persisted transport retry sequence latches replacement evidence (any generation-bound read carrying a different start identity) and absence timestamps must be safe integers before crediting (nonnumeric instants refuse by name); v22 (round 19): a live same-generation transport retry advances the presence horizon and persists the full presence sequence for replay, and the exit supersession compares the identity-read instant (an async completion never re-wins); v21 (rounds 17-18): the correlated absence validates its collection interval (inverted intervals are torn evidence), the SELECTED daemon endpoint re-verifies its parentage against the presence/record rule and a tied transport absence keeps the retry loop sampling; v20 (round 16) = the duty-observation identity-read containment, the contradictory invocation-absence shape refusal and the runtime latest-same-generation-presence tie continuation; v19 (round 15) = the declared-scope binding, the identity-bearing absence reuse latch and the walked presence horizon; v18 (round 14) = the tied-absence collection continuation, the transport-exit recency/carried-identity re-adjudication and the incomplete-interval start refusals; v17 (round 13) = the identity-read containment check, the FROZEN argv selector enforced over mere persisted agreement, and the persisted block-version gate; v16 (round 12) = the collection-interval validity for every fence-crediting read + the consistent materialization-unavailable provenance fallback; v15 (round 11) = the invocation-absence strict tie, the contradictory-duplicate-duty-slot refusal and the selected-endpoint parentage rule covering a failed refresh; v14 (round 10) = the transport PID-reuse latch + the strict transport-absence tie rule; v13 (round 9) = the transport-exit recency/carried-identity re-adjudication; v12 (round 8) = the generation-bound PRE-FENCE transport-exit conjunct, the refreshed-presence horizon/supersession and the admitted-record capture-time parentage');
  });
});

describe('local-settlement task 3 review round 23 (one P2): a supplied carried identity instant outside its read interval is torn replacement evidence — it refuses by name instead of riding the recency filter', async () => {
  const { nativeInterruptionGateDInput, NATIVE_INTERRUPTION_GATE_D_JOIN_VERSION } = await import('../tools/shell-wait-probe/driver.mjs');
  const { createHash } = await import('node:crypto');
  const sha = (v) => createHash('sha256').update(v).digest('hex');
  const MEASUREMENT_CUTOFF_AT_MS = 20_000;

  const armRound23 = () => {
    const scopeNonce = 'a'.repeat(64);
    const transport = 'f'.repeat(64);
    const launcherEntryDigest = sha('launcher-entry');
    const brokerEntryDigest = sha('broker-entry');
    const observation = (pid, ppid, startIdentity, scope, readStarted, identityRead, readEpoch, startInstant = 1000) => ({
      localProcessObservationVersion: 1, class: 'os-live-observation', status: 'established', reason: null,
      observation: { pid, ppid, startIdentity, startInstantEpochMs: startInstant, ppidChangedFromCapture: null, nonceSha256: scope },
      queried: { pid, nonceSha256: scope },
      readStartedEpochMs: readStarted, identityReadEpochMs: identityRead, readEpochMs: readEpoch,
      absenceConfirmed: null,
    });
    const block = {
      version: 1, armed: true, clock: 'wall-epoch-ms', nonceSha256: sha(scopeNonce),
      admission: { localProcessObservationVersion: 1, class: 'startup-identity', status: 'established', reason: null, identity: { role: 'invocation', argv: ['invoke-prepared', 'rescue'], entryRealpathSha256: launcherEntryDigest, pid: 60100, ppid: 600, firstWriteEpochMs: 1000, startOriginMs: 1000.1, firstWritePreciseMs: 1100.5, nonceSha256: sha(scopeNonce) }, readStartedEpochMs: 1000, readEpochMs: 1100 },
      presence: observation(60100, 600, 'S-COMPANION', sha(scopeNonce), 1900, 2100, 2300),
      brokerAdmission: { localProcessObservationVersion: 1, class: 'startup-identity', status: 'established', reason: null, identity: { role: 'broker-daemon', entryRealpathSha256: brokerEntryDigest, pid: 60200, ppid: 60100, firstWriteEpochMs: 3000, startOriginMs: 3000.2, firstWritePreciseMs: 3100.6, nonceSha256: sha(scopeNonce) }, readStartedEpochMs: 1900, readEpochMs: 2100 },
      brokerObservation: observation(60200, 60100, 'S-DAEMON', sha(scopeNonce), 3300, 3400, 3500, 3000),
      transportObservation: observation(60300, 60200, 'S-TRANSPORT', sha(transport), 3800, 3900, 4000, 3600),
      transportPresenceReads: [observation(60300, 60200, 'S-TRANSPORT', sha(transport), 4800, 4900, 5000, 3600)],
      ancestryEndpoints: {
        companion: observation(60100, 600, 'S-COMPANION', sha(scopeNonce), 4600, 4650, 4700, 1000),
        daemon: observation(60200, 60100, 'S-DAEMON', sha(scopeNonce), 4600, 4650, 4750, 3000),
        transportMarker: { pid: 60300, ppid: 60200, nonceSha256: sha(transport), markerEpochMs: 4450 },
      },
      ancestryEndpointRefreshes: { companion: null, daemon: null },
      ancestry: { localProcessObservationVersion: 1, class: 'ancestry-join', nonceSha256: sha(scopeNonce), companionToTransportAttributed: true, hops: [
        { hop: 'companion-to-daemon', status: 'established', reason: null },
        { hop: 'daemon-to-transport', status: 'established', reason: null },
      ] },
      duties: { localProcessObservationVersion: 1, class: 'local-duty-verdict', settled: true, duties: [
        { duty: 'invocation-process', status: 'established', reasons: [], identity: { pid: 60100, startIdentity: 'S-COMPANION', nonceSha256: sha(scopeNonce) } },
        { duty: 'broker-daemon', status: 'established', reasons: [], identity: { pid: 60200, startIdentity: 'S-DAEMON', nonceSha256: sha(scopeNonce) } },
        { duty: 'transport-descendant', status: 'established', reasons: [], identity: { pid: 60300, startIdentity: 'S-TRANSPORT', nonceSha256: sha(transport) } },
      ] },
      transportExit: { localProcessObservationVersion: 1, class: 'os-live-observation', status: 'absent', reason: 'no-such-process', observation: null, queried: { pid: 60300, nonceSha256: sha(transport) }, readStartedEpochMs: 5200, identityReadEpochMs: 5250, readEpochMs: 5300, absenceConfirmed: true },
      reads: [{ localProcessObservationVersion: 1, class: 'os-live-observation', status: 'absent', reason: 'no-such-process', observation: null, queried: { pid: 60100, nonceSha256: sha(scopeNonce) }, readStartedEpochMs: 4900, readEpochMs: 5100, absenceConfirmed: true }],
      exit: { localProcessObservationVersion: 1, class: 'exit-absence', status: 'disappeared', reason: null, boundIdentity: { pid: 60100, startIdentity: 'S-COMPANION', nonceSha256: sha(scopeNonce) }, lastVerifiedPresenceEpochMs: 2100, firstVerifiedAbsenceEpochMs: 5100, exitCorroboratedByMeta: false },
      stoppedAt: null, fenceAtMs: null, cutoffAtMs: MEASUREMENT_CUTOFF_AT_MS, cleanupBoundaryAtMs: null, composedAtMs: 6000,
    };
    const record = (over = {}) => ({
      status: 'executed', case: 'rescue-interrupt', executedAt: '2026-10-30T00:00:00.000Z',
      interrupt: { measurementCutoffAtMs: MEASUREMENT_CUTOFF_AT_MS },
      stdoutCaptureDeclaration: {
        preload: 'closure-observe.mjs', preloadSha256: sha('preload-bytes'), maxBytes: 65536,
        gate: { argv: ['invoke-prepared', 'rescue'], declaredEntryRealpathSha256: launcherEntryDigest },
        brokerGate: { declaredBrokerEntryRealpathSha256: brokerEntryDigest },
        identityRecord: { version: 2, roles: { invocation: 'identity.json', brokerDaemon: 'identity-broker.json' } },
        environmentVariables: [],
      },
      observations: {}, child: {},
      localProcess: block,
      ...over,
    });
    return { scopeNonce, transport, block, record };
  };
  const cleanCopy = (base) => JSON.parse(JSON.stringify(base));

  test('F (P2) RED → a carried identity instant OUTSIDE its read interval is torn replacement evidence: it refuses by name instead of riding the recency filter', () => {
    const g = armRound23();
    const torn = cleanCopy(g.record());
    // The reviewer's shape: the confirmed absence collected over [4900,
    // 5100] carries a replacement observedStartIdentity whose evidence
    // instant is stamped 1000 — OUTSIDE the interval. The latch's recency
    // gate treated the out-of-interval instant as OLD evidence and skipped
    // the read, bypassing the reuse latch entirely.
    torn.localProcess.reads[0].observedStartIdentity = 'S-REPLACEMENT';
    torn.localProcess.reads[0].observedIdentityReadEpochMs = 1000;
    const consolidated = nativeInterruptionGateDInput(torn).localProcessDuties;
    assert.equal(consolidated.settled, false, 'a carried instant outside its read interval is torn evidence — never old evidence');
    assert.ok(consolidated.refusals.includes('exit-reuse-carried-instant-outside-interval'), JSON.stringify(consolidated.refusals));
  });

  test('F sweep → the IN-interval carried instant still latches the reuse, and a malformed supplied instant refuses by the same name', () => {
    const g = armRound23();
    const inInterval = cleanCopy(g.record());
    inInterval.localProcess.reads[0].observedStartIdentity = 'S-REPLACEMENT';
    inInterval.localProcess.reads[0].observedIdentityReadEpochMs = 5000;
    const consolidatedIn = nativeInterruptionGateDInput(inInterval).localProcessDuties;
    assert.equal(consolidatedIn.settled, false, 'the honest in-interval replacement evidence keeps latching the reuse');
    assert.ok(consolidatedIn.refusals.includes('exit-reuse-latched'), JSON.stringify(consolidatedIn.refusals));
    const malformed = cleanCopy(g.record());
    malformed.localProcess.reads[0].observedStartIdentity = 'S-REPLACEMENT';
    malformed.localProcess.reads[0].observedIdentityReadEpochMs = '25000';
    const consolidatedMalformed = nativeInterruptionGateDInput(malformed).localProcessDuties;
    assert.equal(consolidatedMalformed.settled, false);
    assert.ok(consolidatedMalformed.refusals.includes('exit-reuse-carried-instant-outside-interval'), JSON.stringify(consolidatedMalformed.refusals));
  });

  test('the join version registers the round-23 replay growth', () => {
    assert.equal(NATIVE_INTERRUPTION_GATE_D_JOIN_VERSION, 37, 'join v25 (2026-10-30 local-settlement Task 3 review round 23): a supplied carried identity instant is validated against its read collection interval BEFORE the reuse latch recency filtering — an out-of-interval or malformed carried instant is torn replacement evidence refusing by name (exit-reuse-carried-instant-outside-interval), never old evidence; v24 (round 22): every credited observation binds its queried pid/scope digest to the observed identity (the duty echoes and the ancestry endpoints) and a present-but-malformed identity-read instant refuses by name instead of falling back to the completion; v23 (round 20): the persisted transport retry sequence latches replacement evidence (any generation-bound read carrying a different start identity) and absence timestamps must be safe integers before crediting (nonnumeric instants refuse by name); v22 (round 19): a live same-generation transport retry advances the presence horizon and persists the full presence sequence for replay, and the exit supersession compares the identity-read instant (an async completion never re-wins); v21 (rounds 17-18): the correlated absence validates its collection interval (inverted intervals are torn evidence), the SELECTED daemon endpoint re-verifies its parentage against the presence/record rule and a tied transport absence keeps the retry loop sampling; v20 (round 16) = the duty-observation identity-read containment, the contradictory invocation-absence shape refusal and the runtime latest-same-generation-presence tie continuation; v19 (round 15) = the declared-scope binding, the identity-bearing absence reuse latch and the walked presence horizon; v18 (round 14) = the tied-absence collection continuation, the transport-exit recency/carried-identity re-adjudication and the incomplete-interval start refusals; v17 (round 13) = the identity-read containment check, the FROZEN argv selector enforced over mere persisted agreement, and the persisted block-version gate; v16 (round 12) = the collection-interval validity for every fence-crediting read + the consistent materialization-unavailable provenance fallback; v15 (round 11) = the invocation-absence strict tie, the contradictory-duplicate-duty-slot refusal and the selected-endpoint parentage rule covering a failed refresh; v14 (round 10) = the transport PID-reuse latch + the strict transport-absence tie rule; v13 (round 9) = the transport-exit recency/carried-identity re-adjudication; v12 (round 8) = the generation-bound PRE-FENCE transport-exit conjunct, the refreshed-presence horizon/supersession and the admitted-record capture-time parentage');
  });
});

describe('local-settlement task 3 review round 24 (two P2): the retained transport retry reads validate their identity instants, and the captured transport start identity persists and binds the replayed transport observation', async () => {
  const { nativeInterruptionGateDInput, NATIVE_INTERRUPTION_GATE_D_JOIN_VERSION } = await import('../tools/shell-wait-probe/driver.mjs');
  const { createHash } = await import('node:crypto');
  const sha = (v) => createHash('sha256').update(v).digest('hex');
  const MEASUREMENT_CUTOFF_AT_MS = 20_000;

  const armRound24 = () => {
    const scopeNonce = 'a'.repeat(64);
    const transport = 'f'.repeat(64);
    const launcherEntryDigest = sha('launcher-entry');
    const brokerEntryDigest = sha('broker-entry');
    const observation = (pid, ppid, startIdentity, scope, readStarted, identityRead, readEpoch, startInstant = 1000) => ({
      localProcessObservationVersion: 1, class: 'os-live-observation', status: 'established', reason: null,
      observation: { pid, ppid, startIdentity, startInstantEpochMs: startInstant, ppidChangedFromCapture: null, nonceSha256: scope },
      queried: { pid, nonceSha256: scope },
      readStartedEpochMs: readStarted, identityReadEpochMs: identityRead, readEpochMs: readEpoch,
      absenceConfirmed: null,
    });
    const block = {
      version: 1, armed: true, clock: 'wall-epoch-ms', nonceSha256: sha(scopeNonce),
      admission: { localProcessObservationVersion: 1, class: 'startup-identity', status: 'established', reason: null, identity: { role: 'invocation', argv: ['invoke-prepared', 'rescue'], entryRealpathSha256: launcherEntryDigest, pid: 60100, ppid: 600, firstWriteEpochMs: 1000, startOriginMs: 1000.1, firstWritePreciseMs: 1100.5, nonceSha256: sha(scopeNonce) }, readStartedEpochMs: 1000, readEpochMs: 1100 },
      presence: observation(60100, 600, 'S-COMPANION', sha(scopeNonce), 1900, 2100, 2300),
      brokerAdmission: { localProcessObservationVersion: 1, class: 'startup-identity', status: 'established', reason: null, identity: { role: 'broker-daemon', entryRealpathSha256: brokerEntryDigest, pid: 60200, ppid: 60100, firstWriteEpochMs: 3000, startOriginMs: 3000.2, firstWritePreciseMs: 3100.6, nonceSha256: sha(scopeNonce) }, readStartedEpochMs: 1900, readEpochMs: 2100 },
      brokerObservation: observation(60200, 60100, 'S-DAEMON', sha(scopeNonce), 3300, 3400, 3500, 3000),
      transportObservation: observation(60300, 60200, 'S-TRANSPORT', sha(transport), 3800, 3900, 4000, 3600),
      transportPresenceReads: [observation(60300, 60200, 'S-TRANSPORT', sha(transport), 4800, 4900, 5000, 3600)],
      ancestryEndpoints: {
        companion: observation(60100, 600, 'S-COMPANION', sha(scopeNonce), 4600, 4650, 4700, 1000),
        daemon: observation(60200, 60100, 'S-DAEMON', sha(scopeNonce), 4600, 4650, 4750, 3000),
        // (Review round 24, Finding 2) the captured start identity rides the
        // marker (schema-additive, the round-4 markerEpochMs precedent).
        transportMarker: { pid: 60300, ppid: 60200, startIdentity: 'S-TRANSPORT', nonceSha256: sha(transport), markerEpochMs: 4450 },
      },
      ancestryEndpointRefreshes: { companion: null, daemon: null },
      ancestry: { localProcessObservationVersion: 1, class: 'ancestry-join', nonceSha256: sha(scopeNonce), companionToTransportAttributed: true, hops: [
        { hop: 'companion-to-daemon', status: 'established', reason: null },
        { hop: 'daemon-to-transport', status: 'established', reason: null },
      ] },
      duties: { localProcessObservationVersion: 1, class: 'local-duty-verdict', settled: true, duties: [
        { duty: 'invocation-process', status: 'established', reasons: [], identity: { pid: 60100, startIdentity: 'S-COMPANION', nonceSha256: sha(scopeNonce) } },
        { duty: 'broker-daemon', status: 'established', reasons: [], identity: { pid: 60200, startIdentity: 'S-DAEMON', nonceSha256: sha(scopeNonce) } },
        { duty: 'transport-descendant', status: 'established', reasons: [], identity: { pid: 60300, startIdentity: 'S-TRANSPORT', nonceSha256: sha(transport) } },
      ] },
      transportExit: { localProcessObservationVersion: 1, class: 'os-live-observation', status: 'absent', reason: 'no-such-process', observation: null, queried: { pid: 60300, nonceSha256: sha(transport) }, readStartedEpochMs: 5200, identityReadEpochMs: 5250, readEpochMs: 5300, absenceConfirmed: true },
      reads: [{ localProcessObservationVersion: 1, class: 'os-live-observation', status: 'absent', reason: 'no-such-process', observation: null, queried: { pid: 60100, nonceSha256: sha(scopeNonce) }, readStartedEpochMs: 4900, readEpochMs: 5100, absenceConfirmed: true }],
      exit: { localProcessObservationVersion: 1, class: 'exit-absence', status: 'disappeared', reason: null, boundIdentity: { pid: 60100, startIdentity: 'S-COMPANION', nonceSha256: sha(scopeNonce) }, lastVerifiedPresenceEpochMs: 2100, firstVerifiedAbsenceEpochMs: 5100, exitCorroboratedByMeta: false },
      stoppedAt: null, fenceAtMs: null, cutoffAtMs: MEASUREMENT_CUTOFF_AT_MS, cleanupBoundaryAtMs: null, composedAtMs: 6000,
    };
    const record = (over = {}) => ({
      status: 'executed', case: 'rescue-interrupt', executedAt: '2026-10-30T00:00:00.000Z',
      interrupt: { measurementCutoffAtMs: MEASUREMENT_CUTOFF_AT_MS },
      stdoutCaptureDeclaration: {
        preload: 'closure-observe.mjs', preloadSha256: sha('preload-bytes'), maxBytes: 65536,
        gate: { argv: ['invoke-prepared', 'rescue'], declaredEntryRealpathSha256: launcherEntryDigest },
        brokerGate: { declaredBrokerEntryRealpathSha256: brokerEntryDigest },
        identityRecord: { version: 2, roles: { invocation: 'identity.json', brokerDaemon: 'identity-broker.json' } },
        environmentVariables: [],
      },
      observations: {}, child: {},
      localProcess: block,
      ...over,
    });
    return { scopeNonce, transport, block, record };
  };
  const cleanCopy = (base) => JSON.parse(JSON.stringify(base));

  test('F1 (P2) RED → a retained transport retry read with a MALFORMED identity instant refuses by name (the completion never substitutes)', () => {
    const g = armRound24();
    const torn = cleanCopy(g.record());
    // The reviewer's shape: the retained retry instant moved to the STRING
    // "25000" (past the 20000 cutoff) — the horizon walk treated it as
    // missing, substituted the completion, and settled with NO refusals.
    torn.localProcess.transportPresenceReads[0].identityReadEpochMs = '25000';
    const consolidated = nativeInterruptionGateDInput(torn).localProcessDuties;
    assert.equal(consolidated.settled, false, 'a malformed retained instant is torn evidence, never a substituted one');
    assert.ok(consolidated.refusals.includes('observation-identity-read-unprovable'), JSON.stringify(consolidated.refusals));
  });

  test('F1 sweep → an OUT-OF-INTERVAL retained instant refuses, and the honest in-interval retry keeps crediting', () => {
    const g = armRound24();
    const outside = cleanCopy(g.record());
    outside.localProcess.transportPresenceReads[0].identityReadEpochMs = 4700;
    const consolidatedOutside = nativeInterruptionGateDInput(outside).localProcessDuties;
    assert.equal(consolidatedOutside.settled, false);
    assert.ok(consolidatedOutside.refusals.includes('observation-identity-read-outside-interval'), JSON.stringify(consolidatedOutside.refusals));
    const honest = cleanCopy(g.record());
    const consolidatedHonest = nativeInterruptionGateDInput(honest).localProcessDuties;
    assert.equal(consolidatedHonest.settled, true, 'the honest in-interval retry instant keeps crediting the transport exit');
    assert.deepEqual(consolidatedHonest.refusals, [], JSON.stringify(consolidatedHonest.refusals));
  });

  test('F2 (P2) RED → a coherent SUCCESSOR generation replacing the transport observation, duty identity and retries cannot settle the captured transport', () => {
    const g = armRound24();
    const torn = cleanCopy(g.record());
    // The reviewer's shape: the marker bound the replay only by PID+nonce
    // digest — a successor generation under the same pid+nonce with a
    // DIFFERENT start identity could replace the observation, the duty
    // identity and the retry evidence coherently and settle, although the
    // runtime observer would reject that successor against the captured
    // start identity.
    torn.localProcess.transportObservation.observation.startIdentity = 'S-SUCCESSOR';
    torn.localProcess.duties.duties[2].identity.startIdentity = 'S-SUCCESSOR';
    torn.localProcess.transportPresenceReads[0].observation.startIdentity = 'S-SUCCESSOR';
    const consolidated = nativeInterruptionGateDInput(torn).localProcessDuties;
    assert.equal(consolidated.settled, false, 'a replacement generation\'s absence cannot settle the original transport\'s duty');
    assert.ok(consolidated.refusals.includes('ancestry-ppid-chain-foreign'), JSON.stringify(consolidated.refusals));
  });

  test('F2 sweep → the captured start identity binds the observation alone, and the legacy marker shape (no start identity) keeps its tolerance', () => {
    const g = armRound24();
    const observationOnly = cleanCopy(g.record());
    observationOnly.localProcess.transportObservation.observation.startIdentity = 'S-SUCCESSOR';
    const consolidatedObservation = nativeInterruptionGateDInput(observationOnly).localProcessDuties;
    assert.equal(consolidatedObservation.settled, false, 'the captured start identity binds the replayed observation by itself');
    assert.ok(consolidatedObservation.refusals.includes('ancestry-ppid-chain-foreign'), JSON.stringify(consolidatedObservation.refusals));
    const legacyMarker = cleanCopy(g.record());
    delete legacyMarker.localProcess.ancestryEndpoints.transportMarker.startIdentity;
    const consolidatedLegacy = nativeInterruptionGateDInput(legacyMarker).localProcessDuties;
    assert.equal(consolidatedLegacy.settled, true, 'the pre-round-24 marker shape (no persisted start identity) keeps its documented tolerance');
    assert.deepEqual(consolidatedLegacy.refusals, [], JSON.stringify(consolidatedLegacy.refusals));
  });

  test('the join version registers the round-24 replay growth', () => {
    assert.equal(NATIVE_INTERRUPTION_GATE_D_JOIN_VERSION, 37, 'join v26 (2026-10-30 local-settlement Task 3 review round 24): the retained transport retry reads validate their identity instants (the duty-observation/ancestry-endpoint pattern — malformed instants refuse by name, supplied instants must sit inside the validated collection interval) and the captured transport start identity persists with the marker (schema-additive) binding the replayed transport observation — a successor generation cannot settle the original transport duty; v25 (round 23): a supplied carried identity instant is validated against its read collection interval BEFORE the reuse latch recency filtering — an out-of-interval or malformed carried instant is torn replacement evidence refusing by name (exit-reuse-carried-instant-outside-interval), never old evidence; v24 (round 22): every credited observation binds its queried pid/scope digest to the observed identity (the duty echoes and the ancestry endpoints) and a present-but-malformed identity-read instant refuses by name instead of falling back to the completion; v23 (round 20): the persisted transport retry sequence latches replacement evidence (any generation-bound read carrying a different start identity) and absence timestamps must be safe integers before crediting (nonnumeric instants refuse by name); v22 (round 19): a live same-generation transport retry advances the presence horizon and persists the full presence sequence for replay, and the exit supersession compares the identity-read instant (an async completion never re-wins); v21 (rounds 17-18): the correlated absence validates its collection interval (inverted intervals are torn evidence), the SELECTED daemon endpoint re-verifies its parentage against the presence/record rule and a tied transport absence keeps the retry loop sampling; v20 (round 16) = the duty-observation identity-read containment, the contradictory invocation-absence shape refusal and the runtime latest-same-generation-presence tie continuation; v19 (round 15) = the declared-scope binding, the identity-bearing absence reuse latch and the walked presence horizon; v18 (round 14) = the tied-absence collection continuation, the transport-exit recency/carried-identity re-adjudication and the incomplete-interval start refusals; v17 (round 13) = the identity-read containment check, the FROZEN argv selector enforced over mere persisted agreement, and the persisted block-version gate; v16 (round 12) = the collection-interval validity for every fence-crediting read + the consistent materialization-unavailable provenance fallback; v15 (round 11) = the invocation-absence strict tie, the contradictory-duplicate-duty-slot refusal and the selected-endpoint parentage rule covering a failed refresh; v14 (round 10) = the transport PID-reuse latch + the strict transport-absence tie rule; v13 (round 9) = the transport-exit recency/carried-identity re-adjudication; v12 (round 8) = the generation-bound PRE-FENCE transport-exit conjunct, the refreshed-presence horizon/supersession and the admitted-record capture-time parentage');
  });
});

describe('local-settlement task 3 review round 25 (one P2): a retained transport retry read with an INVALID collection interval refuses explicitly instead of being silently discarded', async () => {
  const { nativeInterruptionGateDInput, NATIVE_INTERRUPTION_GATE_D_JOIN_VERSION } = await import('../tools/shell-wait-probe/driver.mjs');
  const { createHash } = await import('node:crypto');
  const sha = (v) => createHash('sha256').update(v).digest('hex');
  const MEASUREMENT_CUTOFF_AT_MS = 20_000;

  const armRound25 = () => {
    const scopeNonce = 'a'.repeat(64);
    const transport = 'f'.repeat(64);
    const launcherEntryDigest = sha('launcher-entry');
    const brokerEntryDigest = sha('broker-entry');
    const observation = (pid, ppid, startIdentity, scope, readStarted, identityRead, readEpoch, startInstant = 1000) => ({
      localProcessObservationVersion: 1, class: 'os-live-observation', status: 'established', reason: null,
      observation: { pid, ppid, startIdentity, startInstantEpochMs: startInstant, ppidChangedFromCapture: null, nonceSha256: scope },
      queried: { pid, nonceSha256: scope },
      readStartedEpochMs: readStarted, identityReadEpochMs: identityRead, readEpochMs: readEpoch,
      absenceConfirmed: null,
    });
    const block = {
      version: 1, armed: true, clock: 'wall-epoch-ms', nonceSha256: sha(scopeNonce),
      admission: { localProcessObservationVersion: 1, class: 'startup-identity', status: 'established', reason: null, identity: { role: 'invocation', argv: ['invoke-prepared', 'rescue'], entryRealpathSha256: launcherEntryDigest, pid: 60100, ppid: 600, firstWriteEpochMs: 1000, startOriginMs: 1000.1, firstWritePreciseMs: 1100.5, nonceSha256: sha(scopeNonce) }, readStartedEpochMs: 1000, readEpochMs: 1100 },
      presence: observation(60100, 600, 'S-COMPANION', sha(scopeNonce), 1900, 2100, 2300),
      brokerAdmission: { localProcessObservationVersion: 1, class: 'startup-identity', status: 'established', reason: null, identity: { role: 'broker-daemon', entryRealpathSha256: brokerEntryDigest, pid: 60200, ppid: 60100, firstWriteEpochMs: 3000, startOriginMs: 3000.2, firstWritePreciseMs: 3100.6, nonceSha256: sha(scopeNonce) }, readStartedEpochMs: 1900, readEpochMs: 2100 },
      brokerObservation: observation(60200, 60100, 'S-DAEMON', sha(scopeNonce), 3300, 3400, 3500, 3000),
      transportObservation: observation(60300, 60200, 'S-TRANSPORT', sha(transport), 3800, 3900, 4000, 3600),
      transportPresenceReads: [observation(60300, 60200, 'S-TRANSPORT', sha(transport), 4800, 4900, 5000, 3600)],
      ancestryEndpoints: {
        companion: observation(60100, 600, 'S-COMPANION', sha(scopeNonce), 4600, 4650, 4700, 1000),
        daemon: observation(60200, 60100, 'S-DAEMON', sha(scopeNonce), 4600, 4650, 4750, 3000),
        transportMarker: { pid: 60300, ppid: 60200, startIdentity: 'S-TRANSPORT', nonceSha256: sha(transport), markerEpochMs: 4450 },
      },
      ancestryEndpointRefreshes: { companion: null, daemon: null },
      ancestry: { localProcessObservationVersion: 1, class: 'ancestry-join', nonceSha256: sha(scopeNonce), companionToTransportAttributed: true, hops: [
        { hop: 'companion-to-daemon', status: 'established', reason: null },
        { hop: 'daemon-to-transport', status: 'established', reason: null },
      ] },
      duties: { localProcessObservationVersion: 1, class: 'local-duty-verdict', settled: true, duties: [
        { duty: 'invocation-process', status: 'established', reasons: [], identity: { pid: 60100, startIdentity: 'S-COMPANION', nonceSha256: sha(scopeNonce) } },
        { duty: 'broker-daemon', status: 'established', reasons: [], identity: { pid: 60200, startIdentity: 'S-DAEMON', nonceSha256: sha(scopeNonce) } },
        { duty: 'transport-descendant', status: 'established', reasons: [], identity: { pid: 60300, startIdentity: 'S-TRANSPORT', nonceSha256: sha(transport) } },
      ] },
      transportExit: { localProcessObservationVersion: 1, class: 'os-live-observation', status: 'absent', reason: 'no-such-process', observation: null, queried: { pid: 60300, nonceSha256: sha(transport) }, readStartedEpochMs: 5200, identityReadEpochMs: 5250, readEpochMs: 5300, absenceConfirmed: true },
      reads: [{ localProcessObservationVersion: 1, class: 'os-live-observation', status: 'absent', reason: 'no-such-process', observation: null, queried: { pid: 60100, nonceSha256: sha(scopeNonce) }, readStartedEpochMs: 4900, readEpochMs: 5100, absenceConfirmed: true }],
      exit: { localProcessObservationVersion: 1, class: 'exit-absence', status: 'disappeared', reason: null, boundIdentity: { pid: 60100, startIdentity: 'S-COMPANION', nonceSha256: sha(scopeNonce) }, lastVerifiedPresenceEpochMs: 2100, firstVerifiedAbsenceEpochMs: 5100, exitCorroboratedByMeta: false },
      stoppedAt: null, fenceAtMs: null, cutoffAtMs: MEASUREMENT_CUTOFF_AT_MS, cleanupBoundaryAtMs: null, composedAtMs: 6000,
    };
    const record = (over = {}) => ({
      status: 'executed', case: 'rescue-interrupt', executedAt: '2026-10-30T00:00:00.000Z',
      interrupt: { measurementCutoffAtMs: MEASUREMENT_CUTOFF_AT_MS },
      stdoutCaptureDeclaration: {
        preload: 'closure-observe.mjs', preloadSha256: sha('preload-bytes'), maxBytes: 65536,
        gate: { argv: ['invoke-prepared', 'rescue'], declaredEntryRealpathSha256: launcherEntryDigest },
        brokerGate: { declaredBrokerEntryRealpathSha256: brokerEntryDigest },
        identityRecord: { version: 2, roles: { invocation: 'identity.json', brokerDaemon: 'identity-broker.json' } },
        environmentVariables: [],
      },
      observations: {}, child: {},
      localProcess: block,
      ...over,
    });
    return { scopeNonce, transport, block, record };
  };
  const cleanCopy = (base) => JSON.parse(JSON.stringify(base));

  test('F (P2) RED → a retained retry read with an INVERTED interval refuses explicitly (torn evidence cannot erase a contradictory replay)', () => {
    const g = armRound25();
    const torn = cleanCopy(g.record());
    // The reviewer's shape: the retained retry's interval inverted to
    // (5600, 5500, 5400) — the guard skipped it, the horizon walk silently
    // discarded the read, and the transport exit at 5300 fenced although the
    // corresponding VALID late presence (4900) correctly prevents
    // settlement.
    torn.localProcess.transportPresenceReads[0].readStartedEpochMs = 5600;
    torn.localProcess.transportPresenceReads[0].identityReadEpochMs = 5500;
    torn.localProcess.transportPresenceReads[0].readEpochMs = 5400;
    const consolidated = nativeInterruptionGateDInput(torn).localProcessDuties;
    assert.equal(consolidated.settled, false, 'a torn retained interval never turns a contradictory replay into a credited layer');
    assert.ok(consolidated.refusals.includes('observation-interval-inverted'), JSON.stringify(consolidated.refusals));
  });

  test('F sweep → a retained retry read MISSING its start timestamp refuses by the established start-unprovable name, and the honest retained read keeps crediting', () => {
    const g = armRound25();
    const missingStart = cleanCopy(g.record());
    missingStart.localProcess.transportPresenceReads[0].readStartedEpochMs = null;
    const consolidatedMissing = nativeInterruptionGateDInput(missingStart).localProcessDuties;
    assert.equal(consolidatedMissing.settled, false, 'a retained read without a start timestamp cannot prove its identity instant');
    assert.ok(consolidatedMissing.refusals.includes('observation-start-unprovable'), JSON.stringify(consolidatedMissing.refusals));
    const honest = cleanCopy(g.record());
    const consolidatedHonest = nativeInterruptionGateDInput(honest).localProcessDuties;
    assert.equal(consolidatedHonest.settled, true, 'the honest retained read keeps crediting the transport exit');
    assert.deepEqual(consolidatedHonest.refusals, [], JSON.stringify(consolidatedHonest.refusals));
  });

  test('the join version registers the round-25 replay growth', () => {
    assert.equal(NATIVE_INTERRUPTION_GATE_D_JOIN_VERSION, 37, 'join v27 (2026-10-30 local-settlement Task 3 review round 25): a retained transport retry read with an INVALID collection interval refuses explicitly (a true inversion is observation-interval-inverted, a missing start when credit depends on it is observation-start-unprovable) — torn evidence cannot turn an otherwise contradictory replay into a credited local-process layer; v26 (round 24): the retained transport retry reads validate their identity instants (the duty-observation/ancestry-endpoint pattern — malformed instants refuse by name, supplied instants must sit inside the validated collection interval) and the captured transport start identity persists with the marker (schema-additive) binding the replayed transport observation — a successor generation cannot settle the original transport duty; v25 (round 23): a supplied carried identity instant is validated against its read collection interval BEFORE the reuse latch recency filtering — an out-of-interval or malformed carried instant is torn replacement evidence refusing by name (exit-reuse-carried-instant-outside-interval), never old evidence; v24 (round 22): every credited observation binds its queried pid/scope digest to the observed identity (the duty echoes and the ancestry endpoints) and a present-but-malformed identity-read instant refuses by name instead of falling back to the completion; v23 (round 20): the persisted transport retry sequence latches replacement evidence (any generation-bound read carrying a different start identity) and absence timestamps must be safe integers before crediting (nonnumeric instants refuse by name); v22 (round 19): a live same-generation transport retry advances the presence horizon and persists the full presence sequence for replay, and the exit supersession compares the identity-read instant (an async completion never re-wins); v21 (rounds 17-18): the correlated absence validates its collection interval (inverted intervals are torn evidence), the SELECTED daemon endpoint re-verifies its parentage against the presence/record rule and a tied transport absence keeps the retry loop sampling; v20 (round 16) = the duty-observation identity-read containment, the contradictory invocation-absence shape refusal and the runtime latest-same-generation-presence tie continuation; v19 (round 15) = the declared-scope binding, the identity-bearing absence reuse latch and the walked presence horizon; v18 (round 14) = the tied-absence collection continuation, the transport-exit recency/carried-identity re-adjudication and the incomplete-interval start refusals; v17 (round 13) = the identity-read containment check, the FROZEN argv selector enforced over mere persisted agreement, and the persisted block-version gate; v16 (round 12) = the collection-interval validity for every fence-crediting read + the consistent materialization-unavailable provenance fallback; v15 (round 11) = the invocation-absence strict tie, the contradictory-duplicate-duty-slot refusal and the selected-endpoint parentage rule covering a failed refresh; v14 (round 10) = the transport PID-reuse latch + the strict transport-absence tie rule; v13 (round 9) = the transport-exit recency/carried-identity re-adjudication; v12 (round 8) = the generation-bound PRE-FENCE transport-exit conjunct, the refreshed-presence horizon/supersession and the admitted-record capture-time parentage');
  });
});

describe('local-settlement task 3 review round 26 (two P2): the retained transport reads validate their completion stamps, and the transport exit validates its supplied carried identity instants', async () => {
  const { nativeInterruptionGateDInput, NATIVE_INTERRUPTION_GATE_D_JOIN_VERSION } = await import('../tools/shell-wait-probe/driver.mjs');
  const { createHash } = await import('node:crypto');
  const sha = (v) => createHash('sha256').update(v).digest('hex');
  const MEASUREMENT_CUTOFF_AT_MS = 20_000;

  const armRound26 = () => {
    const scopeNonce = 'a'.repeat(64);
    const transport = 'f'.repeat(64);
    const launcherEntryDigest = sha('launcher-entry');
    const brokerEntryDigest = sha('broker-entry');
    const observation = (pid, ppid, startIdentity, scope, readStarted, identityRead, readEpoch, startInstant = 1000) => ({
      localProcessObservationVersion: 1, class: 'os-live-observation', status: 'established', reason: null,
      observation: { pid, ppid, startIdentity, startInstantEpochMs: startInstant, ppidChangedFromCapture: null, nonceSha256: scope },
      queried: { pid, nonceSha256: scope },
      readStartedEpochMs: readStarted, identityReadEpochMs: identityRead, readEpochMs: readEpoch,
      absenceConfirmed: null,
    });
    const block = {
      version: 1, armed: true, clock: 'wall-epoch-ms', nonceSha256: sha(scopeNonce),
      admission: { localProcessObservationVersion: 1, class: 'startup-identity', status: 'established', reason: null, identity: { role: 'invocation', argv: ['invoke-prepared', 'rescue'], entryRealpathSha256: launcherEntryDigest, pid: 60100, ppid: 600, firstWriteEpochMs: 1000, startOriginMs: 1000.1, firstWritePreciseMs: 1100.5, nonceSha256: sha(scopeNonce) }, readStartedEpochMs: 1000, readEpochMs: 1100 },
      presence: observation(60100, 600, 'S-COMPANION', sha(scopeNonce), 1900, 2100, 2300),
      brokerAdmission: { localProcessObservationVersion: 1, class: 'startup-identity', status: 'established', reason: null, identity: { role: 'broker-daemon', entryRealpathSha256: brokerEntryDigest, pid: 60200, ppid: 60100, firstWriteEpochMs: 3000, startOriginMs: 3000.2, firstWritePreciseMs: 3100.6, nonceSha256: sha(scopeNonce) }, readStartedEpochMs: 1900, readEpochMs: 2100 },
      brokerObservation: observation(60200, 60100, 'S-DAEMON', sha(scopeNonce), 3300, 3400, 3500, 3000),
      transportObservation: observation(60300, 60200, 'S-TRANSPORT', sha(transport), 3800, 3900, 4000, 3600),
      transportPresenceReads: [observation(60300, 60200, 'S-TRANSPORT', sha(transport), 4800, 4900, 5000, 3600)],
      ancestryEndpoints: {
        companion: observation(60100, 600, 'S-COMPANION', sha(scopeNonce), 4600, 4650, 4700, 1000),
        daemon: observation(60200, 60100, 'S-DAEMON', sha(scopeNonce), 4600, 4650, 4750, 3000),
        transportMarker: { pid: 60300, ppid: 60200, startIdentity: 'S-TRANSPORT', nonceSha256: sha(transport), markerEpochMs: 4450 },
      },
      ancestryEndpointRefreshes: { companion: null, daemon: null },
      ancestry: { localProcessObservationVersion: 1, class: 'ancestry-join', nonceSha256: sha(scopeNonce), companionToTransportAttributed: true, hops: [
        { hop: 'companion-to-daemon', status: 'established', reason: null },
        { hop: 'daemon-to-transport', status: 'established', reason: null },
      ] },
      duties: { localProcessObservationVersion: 1, class: 'local-duty-verdict', settled: true, duties: [
        { duty: 'invocation-process', status: 'established', reasons: [], identity: { pid: 60100, startIdentity: 'S-COMPANION', nonceSha256: sha(scopeNonce) } },
        { duty: 'broker-daemon', status: 'established', reasons: [], identity: { pid: 60200, startIdentity: 'S-DAEMON', nonceSha256: sha(scopeNonce) } },
        { duty: 'transport-descendant', status: 'established', reasons: [], identity: { pid: 60300, startIdentity: 'S-TRANSPORT', nonceSha256: sha(transport) } },
      ] },
      transportExit: { localProcessObservationVersion: 1, class: 'os-live-observation', status: 'absent', reason: 'no-such-process', observation: null, queried: { pid: 60300, nonceSha256: sha(transport) }, readStartedEpochMs: 5200, identityReadEpochMs: 5250, readEpochMs: 5300, absenceConfirmed: true },
      reads: [{ localProcessObservationVersion: 1, class: 'os-live-observation', status: 'absent', reason: 'no-such-process', observation: null, queried: { pid: 60100, nonceSha256: sha(scopeNonce) }, readStartedEpochMs: 4900, readEpochMs: 5100, absenceConfirmed: true }],
      exit: { localProcessObservationVersion: 1, class: 'exit-absence', status: 'disappeared', reason: null, boundIdentity: { pid: 60100, startIdentity: 'S-COMPANION', nonceSha256: sha(scopeNonce) }, lastVerifiedPresenceEpochMs: 2100, firstVerifiedAbsenceEpochMs: 5100, exitCorroboratedByMeta: false },
      stoppedAt: null, fenceAtMs: null, cutoffAtMs: MEASUREMENT_CUTOFF_AT_MS, cleanupBoundaryAtMs: null, composedAtMs: 6000,
    };
    const record = (over = {}) => ({
      status: 'executed', case: 'rescue-interrupt', executedAt: '2026-10-30T00:00:00.000Z',
      interrupt: { measurementCutoffAtMs: MEASUREMENT_CUTOFF_AT_MS },
      stdoutCaptureDeclaration: {
        preload: 'closure-observe.mjs', preloadSha256: sha('preload-bytes'), maxBytes: 65536,
        gate: { argv: ['invoke-prepared', 'rescue'], declaredEntryRealpathSha256: launcherEntryDigest },
        brokerGate: { declaredBrokerEntryRealpathSha256: brokerEntryDigest },
        identityRecord: { version: 2, roles: { invocation: 'identity.json', brokerDaemon: 'identity-broker.json' } },
        environmentVariables: [],
      },
      observations: {}, child: {},
      localProcess: block,
      ...over,
    });
    return { scopeNonce, transport, block, record };
  };
  const cleanCopy = (base) => JSON.parse(JSON.stringify(base));

  test('F1 (P2) RED → a retained transport read with a MISSING completion is torn evidence: it refuses instead of being silently excluded from the horizon', () => {
    const g = armRound26();
    const torn = cleanCopy(g.record());
    // The reviewer's shape: a same-generation presence over [5500, MISSING]
    // with identity read 5700 — the containment check silently EXCLUDED the
    // read from the horizon and the claimed exit at 5300 fenced.
    torn.localProcess.transportPresenceReads.push({
      ...torn.localProcess.transportPresenceReads[0],
      readStartedEpochMs: 5500, identityReadEpochMs: 5700, readEpochMs: undefined,
    });
    const consolidated = nativeInterruptionGateDInput(torn).localProcessDuties;
    assert.equal(consolidated.settled, false, 'a retained read without a completion stamp cannot be silently discarded');
    assert.ok(consolidated.refusals.includes('observation-instant-unprovable'), JSON.stringify(consolidated.refusals));
  });

  test('F1 sweep → a NONNUMERIC completion refuses by the same name, and the VALID late presence still prevents settlement', () => {
    const g = armRound26();
    const nonnumeric = cleanCopy(g.record());
    nonnumeric.localProcess.transportPresenceReads.push({
      ...nonnumeric.localProcess.transportPresenceReads[0],
      readStartedEpochMs: 5500, identityReadEpochMs: 5700, readEpochMs: 'bad',
    });
    const consolidatedNonnumeric = nativeInterruptionGateDInput(nonnumeric).localProcessDuties;
    assert.equal(consolidatedNonnumeric.settled, false);
    assert.ok(consolidatedNonnumeric.refusals.includes('observation-instant-unprovable'), JSON.stringify(consolidatedNonnumeric.refusals));
    const valid = cleanCopy(g.record());
    valid.localProcess.transportPresenceReads.push({
      ...valid.localProcess.transportPresenceReads[0],
      readStartedEpochMs: 5500, identityReadEpochMs: 5700, readEpochMs: 5900,
    });
    const consolidatedValid = nativeInterruptionGateDInput(valid).localProcessDuties;
    assert.equal(consolidatedValid.settled, false, 'the corresponding VALID late presence correctly prevents settlement');
    assert.ok(consolidatedValid.refusals.includes('transport-exit-overlaps-presence'), JSON.stringify(consolidatedValid.refusals));
  });

  test('F2 (P2) RED → a transport exit carrying an identity instant OUTSIDE its interval never supports settlement', () => {
    const g = armRound26();
    const torn = cleanCopy(g.record());
    // The reviewer's shape: the exit over [5200, 5300] (cutoff 20000) gained
    // a same-generation observedStartIdentity with its evidence instant
    // stamped 25000 — identity evidence collected after the claimed
    // completion and past the cutoff rode in unchecked.
    torn.localProcess.transportExit.observedStartIdentity = 'S-TRANSPORT';
    torn.localProcess.transportExit.observedIdentityReadEpochMs = 25000;
    const consolidated = nativeInterruptionGateDInput(torn).localProcessDuties;
    assert.equal(consolidated.settled, false, 'carried identity evidence outside the exit interval is torn evidence');
    assert.ok(consolidated.refusals.includes('transport-exit-carried-instant-outside-interval'), JSON.stringify(consolidated.refusals));
  });

  test('F2 sweep → an IN-interval carried instant keeps crediting, and a MALFORMED one refuses by the same name', () => {
    const g = armRound26();
    const inInterval = cleanCopy(g.record());
    inInterval.localProcess.transportExit.observedStartIdentity = 'S-TRANSPORT';
    inInterval.localProcess.transportExit.observedIdentityReadEpochMs = 5250;
    const consolidatedIn = nativeInterruptionGateDInput(inInterval).localProcessDuties;
    assert.equal(consolidatedIn.settled, true, 'the honest observed-then-gone shape (its instant inside the interval) keeps crediting');
    assert.deepEqual(consolidatedIn.refusals, [], JSON.stringify(consolidatedIn.refusals));
    const malformed = cleanCopy(g.record());
    malformed.localProcess.transportExit.observedStartIdentity = 'S-TRANSPORT';
    malformed.localProcess.transportExit.observedIdentityReadEpochMs = '25000';
    const consolidatedMalformed = nativeInterruptionGateDInput(malformed).localProcessDuties;
    assert.equal(consolidatedMalformed.settled, false);
    assert.ok(consolidatedMalformed.refusals.includes('transport-exit-carried-instant-outside-interval'), JSON.stringify(consolidatedMalformed.refusals));
  });

  test('the join version registers the round-26 replay growth', () => {
    assert.equal(NATIVE_INTERRUPTION_GATE_D_JOIN_VERSION, 37, 'join v28 (2026-10-30 local-settlement Task 3 review round 26): the retained transport reads validate their completion stamps (a missing or nonnumeric completion refuses observation-instant-unprovable — torn evidence is never silently excluded from the presence horizon) and the transport exit validates its supplied carried identity instants (in-interval + safe integer, else transport-exit-carried-instant-outside-interval — the invocation-absence pattern); v27 (round 25): a retained transport retry read with an INVALID collection interval refuses explicitly (a true inversion is observation-interval-inverted, a missing start when credit depends on it is observation-start-unprovable) — torn evidence cannot turn an otherwise contradictory replay into a credited local-process layer; v26 (round 24): the retained transport retry reads validate their identity instants (the duty-observation/ancestry-endpoint pattern — malformed instants refuse by name, supplied instants must sit inside the validated collection interval) and the captured transport start identity persists with the marker (schema-additive) binding the replayed transport observation — a successor generation cannot settle the original transport duty; v25 (round 23): a supplied carried identity instant is validated against its read collection interval BEFORE the reuse latch recency filtering — an out-of-interval or malformed carried instant is torn replacement evidence refusing by name (exit-reuse-carried-instant-outside-interval), never old evidence; v24 (round 22): every credited observation binds its queried pid/scope digest to the observed identity (the duty echoes and the ancestry endpoints) and a present-but-malformed identity-read instant refuses by name instead of falling back to the completion; v23 (round 20): the persisted transport retry sequence latches replacement evidence (any generation-bound read carrying a different start identity) and absence timestamps must be safe integers before crediting (nonnumeric instants refuse by name); v22 (round 19): a live same-generation transport retry advances the presence horizon and persists the full presence sequence for replay, and the exit supersession compares the identity-read instant (an async completion never re-wins); v21 (rounds 17-18): the correlated absence validates its collection interval (inverted intervals are torn evidence), the SELECTED daemon endpoint re-verifies its parentage against the presence/record rule and a tied transport absence keeps the retry loop sampling; v20 (round 16) = the duty-observation identity-read containment, the contradictory invocation-absence shape refusal and the runtime latest-same-generation-presence tie continuation; v19 (round 15) = the declared-scope binding, the identity-bearing absence reuse latch and the walked presence horizon; v18 (round 14) = the tied-absence collection continuation, the transport-exit recency/carried-identity re-adjudication and the incomplete-interval start refusals; v17 (round 13) = the identity-read containment check, the FROZEN argv selector enforced over mere persisted agreement, and the persisted block-version gate; v16 (round 12) = the collection-interval validity for every fence-crediting read + the consistent materialization-unavailable provenance fallback; v15 (round 11) = the invocation-absence strict tie, the contradictory-duplicate-duty-slot refusal and the selected-endpoint parentage rule covering a failed refresh; v14 (round 10) = the transport PID-reuse latch + the strict transport-absence tie rule; v13 (round 9) = the transport-exit recency/carried-identity re-adjudication; v12 (round 8) = the generation-bound PRE-FENCE transport-exit conjunct, the refreshed-presence horizon/supersession and the admitted-record capture-time parentage');
  });
});

describe('local-settlement task 3 review round 27 (two P2): a replacement-claiming invocation read owes a valid completion timestamp, and the preflight parses NODE_OPTIONS into option tokens', async () => {
  const { nativeInterruptionGateDInput, NATIVE_INTERRUPTION_GATE_D_JOIN_VERSION, evaluateLiveLaunchPreflight } = await import('../tools/shell-wait-probe/driver.mjs');
  const { createHash } = await import('node:crypto');
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const sha = (v) => createHash('sha256').update(v).digest('hex');
  const MEASUREMENT_CUTOFF_AT_MS = 20_000;

  const armRound27 = () => {
    const scopeNonce = 'a'.repeat(64);
    const transport = 'f'.repeat(64);
    const launcherEntryDigest = sha('launcher-entry');
    const brokerEntryDigest = sha('broker-entry');
    const observation = (pid, ppid, startIdentity, scope, readStarted, identityRead, readEpoch, startInstant = 1000) => ({
      localProcessObservationVersion: 1, class: 'os-live-observation', status: 'established', reason: null,
      observation: { pid, ppid, startIdentity, startInstantEpochMs: startInstant, ppidChangedFromCapture: null, nonceSha256: scope },
      queried: { pid, nonceSha256: scope },
      readStartedEpochMs: readStarted, identityReadEpochMs: identityRead, readEpochMs: readEpoch,
      absenceConfirmed: null,
    });
    const block = {
      version: 1, armed: true, clock: 'wall-epoch-ms', nonceSha256: sha(scopeNonce),
      admission: { localProcessObservationVersion: 1, class: 'startup-identity', status: 'established', reason: null, identity: { role: 'invocation', argv: ['invoke-prepared', 'rescue'], entryRealpathSha256: launcherEntryDigest, pid: 60100, ppid: 600, firstWriteEpochMs: 1000, startOriginMs: 1000.1, firstWritePreciseMs: 1100.5, nonceSha256: sha(scopeNonce) }, readStartedEpochMs: 1000, readEpochMs: 1100 },
      presence: observation(60100, 600, 'S-COMPANION', sha(scopeNonce), 1900, 2100, 2300),
      brokerAdmission: { localProcessObservationVersion: 1, class: 'startup-identity', status: 'established', reason: null, identity: { role: 'broker-daemon', entryRealpathSha256: brokerEntryDigest, pid: 60200, ppid: 60100, firstWriteEpochMs: 3000, startOriginMs: 3000.2, firstWritePreciseMs: 3100.6, nonceSha256: sha(scopeNonce) }, readStartedEpochMs: 1900, readEpochMs: 2100 },
      brokerObservation: observation(60200, 60100, 'S-DAEMON', sha(scopeNonce), 3300, 3400, 3500, 3000),
      transportObservation: observation(60300, 60200, 'S-TRANSPORT', sha(transport), 3800, 3900, 4000, 3600),
      transportPresenceReads: [observation(60300, 60200, 'S-TRANSPORT', sha(transport), 4800, 4900, 5000, 3600)],
      ancestryEndpoints: {
        companion: observation(60100, 600, 'S-COMPANION', sha(scopeNonce), 4600, 4650, 4700, 1000),
        daemon: observation(60200, 60100, 'S-DAEMON', sha(scopeNonce), 4600, 4650, 4750, 3000),
        transportMarker: { pid: 60300, ppid: 60200, startIdentity: 'S-TRANSPORT', nonceSha256: sha(transport), markerEpochMs: 4450 },
      },
      ancestryEndpointRefreshes: { companion: null, daemon: null },
      ancestry: { localProcessObservationVersion: 1, class: 'ancestry-join', nonceSha256: sha(scopeNonce), companionToTransportAttributed: true, hops: [
        { hop: 'companion-to-daemon', status: 'established', reason: null },
        { hop: 'daemon-to-transport', status: 'established', reason: null },
      ] },
      duties: { localProcessObservationVersion: 1, class: 'local-duty-verdict', settled: true, duties: [
        { duty: 'invocation-process', status: 'established', reasons: [], identity: { pid: 60100, startIdentity: 'S-COMPANION', nonceSha256: sha(scopeNonce) } },
        { duty: 'broker-daemon', status: 'established', reasons: [], identity: { pid: 60200, startIdentity: 'S-DAEMON', nonceSha256: sha(scopeNonce) } },
        { duty: 'transport-descendant', status: 'established', reasons: [], identity: { pid: 60300, startIdentity: 'S-TRANSPORT', nonceSha256: sha(transport) } },
      ] },
      transportExit: { localProcessObservationVersion: 1, class: 'os-live-observation', status: 'absent', reason: 'no-such-process', observation: null, queried: { pid: 60300, nonceSha256: sha(transport) }, readStartedEpochMs: 5200, identityReadEpochMs: 5250, readEpochMs: 5300, absenceConfirmed: true },
      reads: [{ localProcessObservationVersion: 1, class: 'os-live-observation', status: 'absent', reason: 'no-such-process', observation: null, queried: { pid: 60100, nonceSha256: sha(scopeNonce) }, readStartedEpochMs: 4900, readEpochMs: 5100, absenceConfirmed: true }],
      exit: { localProcessObservationVersion: 1, class: 'exit-absence', status: 'disappeared', reason: null, boundIdentity: { pid: 60100, startIdentity: 'S-COMPANION', nonceSha256: sha(scopeNonce) }, lastVerifiedPresenceEpochMs: 2100, firstVerifiedAbsenceEpochMs: 5100, exitCorroboratedByMeta: false },
      stoppedAt: null, fenceAtMs: null, cutoffAtMs: MEASUREMENT_CUTOFF_AT_MS, cleanupBoundaryAtMs: null, composedAtMs: 6000,
    };
    const record = (over = {}) => ({
      status: 'executed', case: 'rescue-interrupt', executedAt: '2026-10-30T00:00:00.000Z',
      interrupt: { measurementCutoffAtMs: MEASUREMENT_CUTOFF_AT_MS },
      stdoutCaptureDeclaration: {
        preload: 'closure-observe.mjs', preloadSha256: sha('preload-bytes'), maxBytes: 65536,
        gate: { argv: ['invoke-prepared', 'rescue'], declaredEntryRealpathSha256: launcherEntryDigest },
        brokerGate: { declaredBrokerEntryRealpathSha256: brokerEntryDigest },
        identityRecord: { version: 2, roles: { invocation: 'identity.json', brokerDaemon: 'identity-broker.json' } },
        environmentVariables: [],
      },
      observations: {}, child: {},
      localProcess: block,
      ...over,
    });
    return { scopeNonce, transport, block, record };
  };
  const cleanCopy = (base) => JSON.parse(JSON.stringify(base));

  test('F1 (P2) RED → a replacement-claiming invocation read WITHOUT a completion timestamp refuses by name (it is never silently discarded by the recency filter)', () => {
    const g = armRound27();
    const torn = cleanCopy(g.record());
    // The reviewer's shape: a same-PID, same-scope read reporting
    // start-identity-generation-changed with NO readEpochMs and NO identity
    // timestamps — adjudicateLocalExit itself rejects reads without a valid
    // completion, but the latch walk's recency filter silently discarded it.
    torn.localProcess.reads.push({
      localProcessObservationVersion: 1, class: 'os-live-observation', status: 'unestablished', reason: 'start-identity-generation-changed',
      observation: null, queried: { pid: 60100, nonceSha256: sha(g.scopeNonce) },
      readStartedEpochMs: 4800, absenceConfirmed: null,
    });
    const consolidated = nativeInterruptionGateDInput(torn).localProcessDuties;
    assert.equal(consolidated.settled, false, 'torn replacement evidence cannot bypass the reuse latch');
    assert.ok(consolidated.refusals.includes('exit-reuse-read-instant-unprovable'), JSON.stringify(consolidated.refusals));
  });

  test('F1 sweep → a MALFORMED completion on a replacement-claiming read refuses by the same name, and the honest replacement read still latches', () => {
    const g = armRound27();
    const malformed = cleanCopy(g.record());
    malformed.localProcess.reads.push({
      localProcessObservationVersion: 1, class: 'os-live-observation', status: 'unestablished', reason: 'start-identity-generation-changed',
      observation: null, queried: { pid: 60100, nonceSha256: sha(g.scopeNonce) },
      readStartedEpochMs: 4800, readEpochMs: 'bad', absenceConfirmed: null,
    });
    const consolidatedMalformed = nativeInterruptionGateDInput(malformed).localProcessDuties;
    assert.equal(consolidatedMalformed.settled, false);
    assert.ok(consolidatedMalformed.refusals.includes('exit-reuse-read-instant-unprovable'), JSON.stringify(consolidatedMalformed.refusals));
    const honest = cleanCopy(g.record());
    honest.localProcess.reads.push({
      localProcessObservationVersion: 1, class: 'os-live-observation', status: 'established', reason: null,
      observation: { pid: 60100, ppid: 600, startIdentity: 'S-REPLACEMENT', startInstantEpochMs: 1000, ppidChangedFromCapture: null, nonceSha256: sha(g.scopeNonce) },
      queried: { pid: 60100, nonceSha256: sha(g.scopeNonce) },
      readStartedEpochMs: 4800, identityReadEpochMs: 4900, readEpochMs: 5000, absenceConfirmed: null,
    });
    const consolidatedHonest = nativeInterruptionGateDInput(honest).localProcessDuties;
    assert.equal(consolidatedHonest.settled, false, 'the honest replacement evidence keeps latching the reuse');
    assert.ok(consolidatedHonest.refusals.includes('exit-reuse-latched'), JSON.stringify(consolidatedHonest.refusals));
  });

  test('F2 (P2) RED → a preload fragment inside ANOTHER option\'s value never counts as loading the preload', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'local-process-r27-preflight-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const workspace = join(root, 'ws');
    const dataRoot = join(root, 'data-root');
    await mkdir(workspace, { mode: 0o700 });
    await mkdir(dataRoot, { mode: 0o700 });
    const preloadPath = join(root, 'closure-stdout-preload.cjs');
    const preloadSha = sha('// the executing preload artifact\n');
    await writeFile(preloadPath, '// the executing preload artifact\n', 'utf8');
    const entryRealpath = '/private/tmp/r27-installed/skills/rescue/launcher.mjs';
    const brokerEntryRealpath = '/private/tmp/r27-installed/scripts/zcode-broker.mjs';
    const handle = {
      preloadPath, preloadSha256: preloadSha,
      captureDirectory: join(root, 'stdout-capture'), nonce: 'a'.repeat(64), maxBytes: 65536,
      entryRealpath, brokerEntryRealpath,
    };
    // (Review round 32, Finding 2) the REAL composer creates the capture
    // directory; the helper mirrors it.
    await mkdir(join(root, 'stdout-capture'), { recursive: true, mode: 0o700 });
    const arming = {
      preload: 'closure-stdout-preload.cjs', preloadSha256: preloadSha, maxBytes: 65536,
      gate: { argv: ['invoke-prepared', 'rescue'], declaredEntryRealpathSha256: sha(entryRealpath) },
      brokerGate: { declaredBrokerEntryRealpathSha256: sha(brokerEntryRealpath) },
      identityRecord: { version: 2, roles: { invocation: 'identity.json', brokerDaemon: 'identity-broker.json' } },
      environmentVariables: [],
    };
    const env = (nodeOptions) => ({
      ZCODE_DATA_ROOT: dataRoot,
      ZCODE_SHELL_WAIT_CAPTURE_DIR: handle.captureDirectory,
      ZCODE_SHELL_WAIT_CAPTURE_NONCE: handle.nonce,
      ZCODE_SHELL_WAIT_CAPTURE_ENTRY_REALPATH: handle.entryRealpath,
      ZCODE_SHELL_WAIT_CAPTURE_MAX_BYTES: String(handle.maxBytes),
      ZCODE_SHELL_WAIT_CAPTURE_BROKER_ENTRY_REALPATH: handle.brokerEntryRealpath,
      NODE_OPTIONS: nodeOptions,
    });
    const verdict = (nodeOptions) => evaluateLiveLaunchPreflight({
      case: 'rescue-interrupt', survivalControlSelector: null,
      fixture: { workspace, stdoutCapture: handle, record: { closureStdoutCapture: arming }, env: env(nodeOptions) },
    });
    // The reviewer's exact shape: the --require fragment hides inside the
    // --title VALUE — Node tokenizes it as the process title and starts
    // WITHOUT requiring the preload (even if the file did not exist).
    const titleFragment = `--title="--require "${preloadPath}""`;
    const refused = await verdict(titleFragment);
    assert.equal(refused.ok, false, 'a fragment inside another option\'s value is not a loaded preload');
    assert.match(String(refused.reason), /does not LOAD the declared preload/u, refused.reason);
    // The composed two-token form keeps passing.
    const composed = await verdict(`--require "${preloadPath.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
    assert.deepEqual(composed, { ok: true, reason: null }, composed.reason);
    // The = form (a real option token whose argument equals the path) counts too.
    const equalsForm = await verdict(`--require="${preloadPath}"`);
    assert.deepEqual(equalsForm, { ok: true, reason: null }, equalsForm.reason);
    // A single-quoted fragment inside another option's value refuses too.
    const singleQuoted = await verdict(`--title='--require ${preloadPath}'`);
    assert.equal(singleQuoted.ok, false);
    assert.match(String(singleQuoted.reason), /does not LOAD the declared preload/u, singleQuoted.reason);
  });

  test('the join version registers the round-27 replay growth', () => {
    assert.equal(NATIVE_INTERRUPTION_GATE_D_JOIN_VERSION, 37, 'join v29 (2026-10-30 local-settlement Task 3 review round 27): a replacement-claiming retained invocation read owes a valid completion timestamp (a missing or malformed one refuses exit-reuse-read-instant-unprovable instead of being silently discarded by the recency filter), and the NODE_OPTIONS preflight parses the string into shell-ish option tokens (a --require fragment inside another option\'s value never counts as loading the declared preload); v28 (round 26): the retained transport reads validate their completion stamps (a missing or nonnumeric completion refuses observation-instant-unprovable — torn evidence is never silently excluded from the presence horizon) and the transport exit validates its supplied carried identity instants (in-interval + safe integer, else transport-exit-carried-instant-outside-interval — the invocation-absence pattern); v27 (round 25): a retained transport retry read with an INVALID collection interval refuses explicitly (a true inversion is observation-interval-inverted, a missing start when credit depends on it is observation-start-unprovable) — torn evidence cannot turn an otherwise contradictory replay into a credited local-process layer; v26 (round 24): the retained transport retry reads validate their identity instants (the duty-observation/ancestry-endpoint pattern — malformed instants refuse by name, supplied instants must sit inside the validated collection interval) and the captured transport start identity persists with the marker (schema-additive) binding the replayed transport observation — a successor generation cannot settle the original transport duty; v25 (round 23): a supplied carried identity instant is validated against its read collection interval BEFORE the reuse latch recency filtering — an out-of-interval or malformed carried instant is torn replacement evidence refusing by name (exit-reuse-carried-instant-outside-interval), never old evidence; v24 (round 22): every credited observation binds its queried pid/scope digest to the observed identity (the duty echoes and the ancestry endpoints) and a present-but-malformed identity-read instant refuses by name instead of falling back to the completion; v23 (round 20): the persisted transport retry sequence latches replacement evidence (any generation-bound read carrying a different start identity) and absence timestamps must be safe integers before crediting (nonnumeric instants refuse by name); v22 (round 19): a live same-generation transport retry advances the presence horizon and persists the full presence sequence for replay, and the exit supersession compares the identity-read instant (an async completion never re-wins); v21 (rounds 17-18): the correlated absence validates its collection interval (inverted intervals are torn evidence), the SELECTED daemon endpoint re-verifies its parentage against the presence/record rule and a tied transport absence keeps the retry loop sampling; v20 (round 16) = the duty-observation identity-read containment, the contradictory invocation-absence shape refusal and the runtime latest-same-generation-presence tie continuation; v19 (round 15) = the declared-scope binding, the identity-bearing absence reuse latch and the walked presence horizon; v18 (round 14) = the tied-absence collection continuation, the transport-exit recency/carried-identity re-adjudication and the incomplete-interval start refusals; v17 (round 13) = the identity-read containment check, the FROZEN argv selector enforced over mere persisted agreement, and the persisted block-version gate; v16 (round 12) = the collection-interval validity for every fence-crediting read + the consistent materialization-unavailable provenance fallback; v15 (round 11) = the invocation-absence strict tie, the contradictory-duplicate-duty-slot refusal and the selected-endpoint parentage rule covering a failed refresh; v14 (round 10) = the transport PID-reuse latch + the strict transport-absence tie rule; v13 (round 9) = the transport-exit recency/carried-identity re-adjudication; v12 (round 8) = the generation-bound PRE-FENCE transport-exit conjunct, the refreshed-presence horizon/supersession and the admitted-record capture-time parentage');
  });
});

describe('local-settlement task 3 review round 28 (two P2): the fence echoes compare symmetrically (missing-vs-present refuses), and the NODE_OPTIONS tokenizer matches Node exactly (apostrophes are ordinary characters)', async () => {
  const { nativeInterruptionGateDInput, NATIVE_INTERRUPTION_GATE_D_JOIN_VERSION, evaluateLiveLaunchPreflight } = await import('../tools/shell-wait-probe/driver.mjs');
  const { createHash } = await import('node:crypto');
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const sha = (v) => createHash('sha256').update(v).digest('hex');
  const MEASUREMENT_CUTOFF_AT_MS = 20_000;

  const armRound28 = () => {
    const scopeNonce = 'a'.repeat(64);
    const transport = 'f'.repeat(64);
    const launcherEntryDigest = sha('launcher-entry');
    const brokerEntryDigest = sha('broker-entry');
    const observation = (pid, ppid, startIdentity, scope, readStarted, identityRead, readEpoch, startInstant = 1000) => ({
      localProcessObservationVersion: 1, class: 'os-live-observation', status: 'established', reason: null,
      observation: { pid, ppid, startIdentity, startInstantEpochMs: startInstant, ppidChangedFromCapture: null, nonceSha256: scope },
      queried: { pid, nonceSha256: scope },
      readStartedEpochMs: readStarted, identityReadEpochMs: identityRead, readEpochMs: readEpoch,
      absenceConfirmed: null,
    });
    const block = {
      version: 1, armed: true, clock: 'wall-epoch-ms', nonceSha256: sha(scopeNonce),
      admission: { localProcessObservationVersion: 1, class: 'startup-identity', status: 'established', reason: null, identity: { role: 'invocation', argv: ['invoke-prepared', 'rescue'], entryRealpathSha256: launcherEntryDigest, pid: 60100, ppid: 600, firstWriteEpochMs: 1000, startOriginMs: 1000.1, firstWritePreciseMs: 1100.5, nonceSha256: sha(scopeNonce) }, readStartedEpochMs: 1000, readEpochMs: 1100 },
      presence: observation(60100, 600, 'S-COMPANION', sha(scopeNonce), 1900, 2100, 2300),
      brokerAdmission: { localProcessObservationVersion: 1, class: 'startup-identity', status: 'established', reason: null, identity: { role: 'broker-daemon', entryRealpathSha256: brokerEntryDigest, pid: 60200, ppid: 60100, firstWriteEpochMs: 3000, startOriginMs: 3000.2, firstWritePreciseMs: 3100.6, nonceSha256: sha(scopeNonce) }, readStartedEpochMs: 1900, readEpochMs: 2100 },
      brokerObservation: observation(60200, 60100, 'S-DAEMON', sha(scopeNonce), 3300, 3400, 3500, 3000),
      transportObservation: observation(60300, 60200, 'S-TRANSPORT', sha(transport), 3800, 3900, 4000, 3600),
      transportPresenceReads: [observation(60300, 60200, 'S-TRANSPORT', sha(transport), 4800, 4900, 5000, 3600)],
      ancestryEndpoints: {
        companion: observation(60100, 600, 'S-COMPANION', sha(scopeNonce), 4600, 4650, 4700, 1000),
        daemon: observation(60200, 60100, 'S-DAEMON', sha(scopeNonce), 4600, 4650, 4750, 3000),
        transportMarker: { pid: 60300, ppid: 60200, startIdentity: 'S-TRANSPORT', nonceSha256: sha(transport), markerEpochMs: 4450 },
      },
      ancestryEndpointRefreshes: { companion: null, daemon: null },
      ancestry: { localProcessObservationVersion: 1, class: 'ancestry-join', nonceSha256: sha(scopeNonce), companionToTransportAttributed: true, hops: [
        { hop: 'companion-to-daemon', status: 'established', reason: null },
        { hop: 'daemon-to-transport', status: 'established', reason: null },
      ] },
      duties: { localProcessObservationVersion: 1, class: 'local-duty-verdict', settled: true, duties: [
        { duty: 'invocation-process', status: 'established', reasons: [], identity: { pid: 60100, startIdentity: 'S-COMPANION', nonceSha256: sha(scopeNonce) } },
        { duty: 'broker-daemon', status: 'established', reasons: [], identity: { pid: 60200, startIdentity: 'S-DAEMON', nonceSha256: sha(scopeNonce) } },
        { duty: 'transport-descendant', status: 'established', reasons: [], identity: { pid: 60300, startIdentity: 'S-TRANSPORT', nonceSha256: sha(transport) } },
      ] },
      transportExit: { localProcessObservationVersion: 1, class: 'os-live-observation', status: 'absent', reason: 'no-such-process', observation: null, queried: { pid: 60300, nonceSha256: sha(transport) }, readStartedEpochMs: 5200, identityReadEpochMs: 5250, readEpochMs: 5300, absenceConfirmed: true },
      reads: [{ localProcessObservationVersion: 1, class: 'os-live-observation', status: 'absent', reason: 'no-such-process', observation: null, queried: { pid: 60100, nonceSha256: sha(scopeNonce) }, readStartedEpochMs: 4900, readEpochMs: 5100, absenceConfirmed: true }],
      exit: { localProcessObservationVersion: 1, class: 'exit-absence', status: 'disappeared', reason: null, boundIdentity: { pid: 60100, startIdentity: 'S-COMPANION', nonceSha256: sha(scopeNonce) }, lastVerifiedPresenceEpochMs: 2100, firstVerifiedAbsenceEpochMs: 5100, exitCorroboratedByMeta: false },
      stoppedAt: null, fenceAtMs: null, cutoffAtMs: MEASUREMENT_CUTOFF_AT_MS, cleanupBoundaryAtMs: null, composedAtMs: 6000,
    };
    const record = (over = {}) => ({
      status: 'executed', case: 'rescue-interrupt', executedAt: '2026-10-30T00:00:00.000Z',
      interrupt: { measurementCutoffAtMs: MEASUREMENT_CUTOFF_AT_MS },
      stdoutCaptureDeclaration: {
        preload: 'closure-observe.mjs', preloadSha256: sha('preload-bytes'), maxBytes: 65536,
        gate: { argv: ['invoke-prepared', 'rescue'], declaredEntryRealpathSha256: launcherEntryDigest },
        brokerGate: { declaredBrokerEntryRealpathSha256: brokerEntryDigest },
        identityRecord: { version: 2, roles: { invocation: 'identity.json', brokerDaemon: 'identity-broker.json' } },
        environmentVariables: [],
      },
      observations: {}, child: {},
      localProcess: block,
      ...over,
    });
    return { scopeNonce, transport, block, record };
  };
  const cleanCopy = (base) => JSON.parse(JSON.stringify(base));

  test('F1 (P2) RED → a block boundary with a MISSING record echo refuses (cleanup-time evidence never credits across the missing echo)', () => {
    const g = armRound28();
    const torn = cleanCopy(g.record());
    // The reviewer's shape: the block persists the EARLIER termination
    // boundary (5000) while the record's echo is missing — the check
    // silently ignored the contradiction and the absences (5100, 5300)
    // fenced against the 20000 cutoff, crediting cleanup-time evidence.
    torn.localProcess.cleanupBoundaryAtMs = 5000;
    delete torn.interrupt.cleanupBoundaryAtMs;
    const consolidated = nativeInterruptionGateDInput(torn).localProcessDuties;
    assert.equal(consolidated.settled, false, 'a missing-versus-present echo contradiction never credits');
    assert.ok(consolidated.refusals.includes('cleanup-boundary-echo-mismatch'), JSON.stringify(consolidated.refusals));
  });

  test('F1 sweep → both symmetric directions and the cutoff echo refuse; the echo-consistent boundary keeps its stricter fence', () => {
    const g = armRound28();
    const echoPresentBlockMissing = cleanCopy(g.record());
    echoPresentBlockMissing.interrupt.cleanupBoundaryAtMs = 5000;
    const consolidatedEcho = nativeInterruptionGateDInput(echoPresentBlockMissing).localProcessDuties;
    assert.equal(consolidatedEcho.settled, false, 'the echo-present/block-missing direction refuses by name too');
    assert.ok(consolidatedEcho.refusals.includes('cleanup-boundary-echo-mismatch'), JSON.stringify(consolidatedEcho.refusals));
    const unequal = cleanCopy(g.record());
    unequal.localProcess.cleanupBoundaryAtMs = 5000;
    unequal.interrupt.cleanupBoundaryAtMs = 6000;
    const consolidatedUnequal = nativeInterruptionGateDInput(unequal).localProcessDuties;
    assert.equal(consolidatedUnequal.settled, false, 'the existing unequal-values rule is preserved');
    assert.ok(consolidatedUnequal.refusals.includes('cleanup-boundary-echo-mismatch'), JSON.stringify(consolidatedUnequal.refusals));
    const equal = cleanCopy(g.record());
    equal.localProcess.cleanupBoundaryAtMs = 5000;
    equal.interrupt.cleanupBoundaryAtMs = 5000;
    const consolidatedEqual = nativeInterruptionGateDInput(equal).localProcessDuties;
    assert.equal(consolidatedEqual.settled, false, 'the echo-consistent boundary keeps its stricter fence (the absences ride post-fence)');
    assert.ok(consolidatedEqual.refusals.includes('local-exit-at-or-after-fence'), JSON.stringify(consolidatedEqual.refusals));
    const cutoffMissing = cleanCopy(g.record());
    cutoffMissing.interrupt = {};
    const consolidatedCutoff = nativeInterruptionGateDInput(cutoffMissing).localProcessDuties;
    assert.equal(consolidatedCutoff.settled, false, 'the cutoff echo carries the same symmetric rule');
    assert.ok(consolidatedCutoff.refusals.includes('cutoff-echo-mismatch'), JSON.stringify(consolidatedCutoff.refusals));
  });

  test('F2 (P2) RED → the NODE_OPTIONS tokenizer matches Node: the it\'s run passes, the apostrophe-quoted path refuses', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'local-process-r28-preflight-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const workspace = join(root, 'ws');
    const dataRoot = join(root, 'data-root');
    await mkdir(workspace, { mode: 0o700 });
    await mkdir(dataRoot, { mode: 0o700 });
    const preloadPath = join(root, 'closure-stdout-preload.cjs');
    const preloadSha = sha('// the executing preload artifact\n');
    await writeFile(preloadPath, '// the executing preload artifact\n', 'utf8');
    const entryRealpath = '/private/tmp/r28-installed/skills/rescue/launcher.mjs';
    const brokerEntryRealpath = '/private/tmp/r28-installed/scripts/zcode-broker.mjs';
    const handle = {
      preloadPath, preloadSha256: preloadSha,
      captureDirectory: join(root, 'stdout-capture'), nonce: 'a'.repeat(64), maxBytes: 65536,
      entryRealpath, brokerEntryRealpath,
    };
    // (Review round 32, Finding 2) the REAL composer creates the capture
    // directory; the helper mirrors it.
    await mkdir(join(root, 'stdout-capture'), { recursive: true, mode: 0o700 });
    const arming = {
      preload: 'closure-stdout-preload.cjs', preloadSha256: preloadSha, maxBytes: 65536,
      gate: { argv: ['invoke-prepared', 'rescue'], declaredEntryRealpathSha256: sha(entryRealpath) },
      brokerGate: { declaredBrokerEntryRealpathSha256: sha(brokerEntryRealpath) },
      identityRecord: { version: 2, roles: { invocation: 'identity.json', brokerDaemon: 'identity-broker.json' } },
      environmentVariables: [],
    };
    const env = (nodeOptions) => ({
      ZCODE_DATA_ROOT: dataRoot,
      ZCODE_SHELL_WAIT_CAPTURE_DIR: handle.captureDirectory,
      ZCODE_SHELL_WAIT_CAPTURE_NONCE: handle.nonce,
      ZCODE_SHELL_WAIT_CAPTURE_ENTRY_REALPATH: handle.entryRealpath,
      ZCODE_SHELL_WAIT_CAPTURE_MAX_BYTES: String(handle.maxBytes),
      ZCODE_SHELL_WAIT_CAPTURE_BROKER_ENTRY_REALPATH: handle.brokerEntryRealpath,
      NODE_OPTIONS: nodeOptions,
    });
    const verdict = (nodeOptions) => evaluateLiveLaunchPreflight({
      case: 'rescue-interrupt', survivalControlSelector: null,
      fixture: { workspace, stdoutCapture: handle, record: { closureStdoutCapture: arming }, env: env(nodeOptions) },
    });
    // Direction 1 (Node verified empirically: the preload LOADS in this
    // shape — the apostrophe is an ordinary character inside the --title
    // token): the armed run must PASS.
    const itsRun = await verdict(`--title=it's --require "${preloadPath}"`);
    assert.deepEqual(itsRun, { ok: true, reason: null }, `the it's run passes (Node loads the preload here): ${itsRun.reason}`);
    // Direction 2 (Node verified empirically: the apostrophes ride the
    // FILENAME — "Cannot find module ''<path>''"): the preflight must REFUSE.
    const quotedPath = await verdict(`--require '${preloadPath}'`);
    assert.equal(quotedPath.ok, false, 'an apostrophe-quoted argument is not the declared path (Node would fail to load it)');
    assert.match(String(quotedPath.reason), /does not LOAD the declared preload/u, quotedPath.reason);
    // The composed two-token form and the = form keep passing; the
    // double-quoted title fragment keeps refusing.
    const composed = await verdict(`--require "${preloadPath.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
    assert.deepEqual(composed, { ok: true, reason: null }, composed.reason);
    const equalsForm = await verdict(`--require="${preloadPath}"`);
    assert.deepEqual(equalsForm, { ok: true, reason: null }, equalsForm.reason);
    const titleFragment = await verdict(`--title="--require "${preloadPath}""`);
    assert.equal(titleFragment.ok, false);
    assert.match(String(titleFragment.reason), /does not LOAD the declared preload/u, titleFragment.reason);
  });

  test('the join version registers the round-28 replay growth', () => {
    assert.equal(NATIVE_INTERRUPTION_GATE_D_JOIN_VERSION, 37, 'join v30 (2026-10-30 local-settlement Task 3 review round 28): the fence echoes compare symmetrically (a missing-versus-present mismatch refuses cleanup-boundary-echo-mismatch / cutoff-echo-mismatch in both directions — cleanup-time evidence never credits across a missing echo) and the NODE_OPTIONS tokenizer matches Node exactly (apostrophes are ordinary characters, backslash escapes only inside double quotes — the it\'s run passes, the apostrophe-quoted path refuses); v29 (round 27): a replacement-claiming retained invocation read owes a valid completion timestamp (a missing or malformed one refuses exit-reuse-read-instant-unprovable instead of being silently discarded by the recency filter), and the NODE_OPTIONS preflight parses the string into shell-ish option tokens (a --require fragment inside another option value never counts as loading the declared preload); v28 (round 26): the retained transport reads validate their completion stamps (a missing or nonnumeric completion refuses observation-instant-unprovable — torn evidence is never silently excluded from the presence horizon) and the transport exit validates its supplied carried identity instants (in-interval + safe integer, else transport-exit-carried-instant-outside-interval — the invocation-absence pattern); v27 (round 25): a retained transport retry read with an INVALID collection interval refuses explicitly (a true inversion is observation-interval-inverted, a missing start when credit depends on it is observation-start-unprovable) — torn evidence cannot turn an otherwise contradictory replay into a credited local-process layer; v26 (round 24): the retained transport retry reads validate their identity instants (the duty-observation/ancestry-endpoint pattern — malformed instants refuse by name, supplied instants must sit inside the validated collection interval) and the captured transport start identity persists with the marker (schema-additive) binding the replayed transport observation — a successor generation cannot settle the original transport duty; v25 (round 23): a supplied carried identity instant is validated against its read collection interval BEFORE the reuse latch recency filtering — an out-of-interval or malformed carried instant is torn replacement evidence refusing by name (exit-reuse-carried-instant-outside-interval), never old evidence; v24 (round 22): every credited observation binds its queried pid/scope digest to the observed identity (the duty echoes and the ancestry endpoints) and a present-but-malformed identity-read instant refuses by name instead of falling back to the completion; v23 (round 20): the persisted transport retry sequence latches replacement evidence (any generation-bound read carrying a different start identity) and absence timestamps must be safe integers before crediting (nonnumeric instants refuse by name); v22 (round 19): a live same-generation transport retry advances the presence horizon and persists the full presence sequence for replay, and the exit supersession compares the identity-read instant (an async completion never re-wins); v21 (rounds 17-18): the correlated absence validates its collection interval (inverted intervals are torn evidence), the SELECTED daemon endpoint re-verifies its parentage against the presence/record rule and a tied transport absence keeps the retry loop sampling; v20 (round 16) = the duty-observation identity-read containment, the contradictory invocation-absence shape refusal and the runtime latest-same-generation-presence tie continuation; v19 (round 15) = the declared-scope binding, the identity-bearing absence reuse latch and the walked presence horizon; v18 (round 14) = the tied-absence collection continuation, the transport-exit recency/carried-identity re-adjudication and the incomplete-interval start refusals; v17 (round 13) = the identity-read containment check, the FROZEN argv selector enforced over mere persisted agreement, and the persisted block-version gate; v16 (round 12) = the collection-interval validity for every fence-crediting read + the consistent materialization-unavailable provenance fallback; v15 (round 11) = the invocation-absence strict tie, the contradictory-duplicate-duty-slot refusal and the selected-endpoint parentage rule covering a failed refresh; v14 (round 10) = the transport PID-reuse latch + the strict transport-absence tie rule; v13 (round 9) = the transport-exit recency/carried-identity re-adjudication; v12 (round 8) = the generation-bound PRE-FENCE transport-exit conjunct, the refreshed-presence horizon/supersession and the admitted-record capture-time parentage');
  });
});

describe('local-settlement task 3 review round 29 (two P2): the Companion baseline must demonstrably predate the interrupt request, and unterminated NODE_OPTIONS quoting refuses before any token acceptance', async () => {
  const { nativeInterruptionGateDInput, NATIVE_INTERRUPTION_GATE_D_JOIN_VERSION, evaluateLiveLaunchPreflight } = await import('../tools/shell-wait-probe/driver.mjs');
  const { createHash } = await import('node:crypto');
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const sha = (v) => createHash('sha256').update(v).digest('hex');
  const MEASUREMENT_CUTOFF_AT_MS = 20_000;

  const armRound29 = () => {
    const scopeNonce = 'a'.repeat(64);
    const transport = 'f'.repeat(64);
    const launcherEntryDigest = sha('launcher-entry');
    const brokerEntryDigest = sha('broker-entry');
    const observation = (pid, ppid, startIdentity, scope, readStarted, identityRead, readEpoch, startInstant = 1000) => ({
      localProcessObservationVersion: 1, class: 'os-live-observation', status: 'established', reason: null,
      observation: { pid, ppid, startIdentity, startInstantEpochMs: startInstant, ppidChangedFromCapture: null, nonceSha256: scope },
      queried: { pid, nonceSha256: scope },
      readStartedEpochMs: readStarted, identityReadEpochMs: identityRead, readEpochMs: readEpoch,
      absenceConfirmed: null,
    });
    const block = {
      version: 1, armed: true, clock: 'wall-epoch-ms', nonceSha256: sha(scopeNonce),
      admission: { localProcessObservationVersion: 1, class: 'startup-identity', status: 'established', reason: null, identity: { role: 'invocation', argv: ['invoke-prepared', 'rescue'], entryRealpathSha256: launcherEntryDigest, pid: 60100, ppid: 600, firstWriteEpochMs: 1000, startOriginMs: 1000.1, firstWritePreciseMs: 1100.5, nonceSha256: sha(scopeNonce) }, readStartedEpochMs: 1000, readEpochMs: 1100 },
      presence: observation(60100, 600, 'S-COMPANION', sha(scopeNonce), 1900, 2100, 2300),
      brokerAdmission: { localProcessObservationVersion: 1, class: 'startup-identity', status: 'established', reason: null, identity: { role: 'broker-daemon', entryRealpathSha256: brokerEntryDigest, pid: 60200, ppid: 60100, firstWriteEpochMs: 3000, startOriginMs: 3000.2, firstWritePreciseMs: 3100.6, nonceSha256: sha(scopeNonce) }, readStartedEpochMs: 1900, readEpochMs: 2100 },
      brokerObservation: observation(60200, 60100, 'S-DAEMON', sha(scopeNonce), 3300, 3400, 3500, 3000),
      transportObservation: observation(60300, 60200, 'S-TRANSPORT', sha(transport), 3800, 3900, 4000, 3600),
      transportPresenceReads: [observation(60300, 60200, 'S-TRANSPORT', sha(transport), 4800, 4900, 5000, 3600)],
      ancestryEndpoints: {
        companion: observation(60100, 600, 'S-COMPANION', sha(scopeNonce), 4600, 4650, 4700, 1000),
        daemon: observation(60200, 60100, 'S-DAEMON', sha(scopeNonce), 4600, 4650, 4750, 3000),
        transportMarker: { pid: 60300, ppid: 60200, startIdentity: 'S-TRANSPORT', nonceSha256: sha(transport), markerEpochMs: 4450 },
      },
      ancestryEndpointRefreshes: { companion: null, daemon: null },
      ancestry: { localProcessObservationVersion: 1, class: 'ancestry-join', nonceSha256: sha(scopeNonce), companionToTransportAttributed: true, hops: [
        { hop: 'companion-to-daemon', status: 'established', reason: null },
        { hop: 'daemon-to-transport', status: 'established', reason: null },
      ] },
      duties: { localProcessObservationVersion: 1, class: 'local-duty-verdict', settled: true, duties: [
        { duty: 'invocation-process', status: 'established', reasons: [], identity: { pid: 60100, startIdentity: 'S-COMPANION', nonceSha256: sha(scopeNonce) } },
        { duty: 'broker-daemon', status: 'established', reasons: [], identity: { pid: 60200, startIdentity: 'S-DAEMON', nonceSha256: sha(scopeNonce) } },
        { duty: 'transport-descendant', status: 'established', reasons: [], identity: { pid: 60300, startIdentity: 'S-TRANSPORT', nonceSha256: sha(transport) } },
      ] },
      transportExit: { localProcessObservationVersion: 1, class: 'os-live-observation', status: 'absent', reason: 'no-such-process', observation: null, queried: { pid: 60300, nonceSha256: sha(transport) }, readStartedEpochMs: 5200, identityReadEpochMs: 5250, readEpochMs: 5300, absenceConfirmed: true },
      reads: [{ localProcessObservationVersion: 1, class: 'os-live-observation', status: 'absent', reason: 'no-such-process', observation: null, queried: { pid: 60100, nonceSha256: sha(scopeNonce) }, readStartedEpochMs: 4900, readEpochMs: 5100, absenceConfirmed: true }],
      exit: { localProcessObservationVersion: 1, class: 'exit-absence', status: 'disappeared', reason: null, boundIdentity: { pid: 60100, startIdentity: 'S-COMPANION', nonceSha256: sha(scopeNonce) }, lastVerifiedPresenceEpochMs: 2100, firstVerifiedAbsenceEpochMs: 5100, exitCorroboratedByMeta: false },
      stoppedAt: null, fenceAtMs: null, cutoffAtMs: MEASUREMENT_CUTOFF_AT_MS, cleanupBoundaryAtMs: null, composedAtMs: 6000,
    };
    const record = (over = {}) => ({
      status: 'executed', case: 'rescue-interrupt', executedAt: '2026-10-30T00:00:00.000Z',
      interrupt: { measurementCutoffAtMs: MEASUREMENT_CUTOFF_AT_MS },
      stdoutCaptureDeclaration: {
        preload: 'closure-observe.mjs', preloadSha256: sha('preload-bytes'), maxBytes: 65536,
        gate: { argv: ['invoke-prepared', 'rescue'], declaredEntryRealpathSha256: launcherEntryDigest },
        brokerGate: { declaredBrokerEntryRealpathSha256: brokerEntryDigest },
        identityRecord: { version: 2, roles: { invocation: 'identity.json', brokerDaemon: 'identity-broker.json' } },
        environmentVariables: [],
      },
      observations: {}, child: {},
      localProcess: block,
      ...over,
    });
    return { scopeNonce, transport, block, record };
  };
  const cleanCopy = (base) => JSON.parse(JSON.stringify(base));

  test('F1 (P2) RED → a Companion starting AFTER the interrupt request never qualifies: the baseline ordering must demonstrably predate the request', () => {
    const g = armRound29();
    const torn = cleanCopy(g.record());
    // The reviewer's shape: the request evidence rides (callAtMs and both
    // bounds = 500) while the Companion's record starts at 1000.1 — the
    // launcher started AFTER the request, yet its subsequent presence and
    // disappearance fenced against the cleanup/cutoff fences alone.
    torn.interrupt.callAtMs = 500;
    torn.interrupt.callNotBeforeMs = 500;
    torn.interrupt.callNotAfterMs = 500;
    const consolidated = nativeInterruptionGateDInput(torn).localProcessDuties;
    assert.equal(consolidated.settled, false, 'a post-request launcher generation is not the pre-interruption Companion');
    assert.ok(consolidated.refusals.includes('companion-baseline-unestablished'), JSON.stringify(consolidated.refusals));
  });

  test('F1 sweep → a straddling window cannot establish the ordering, callAtMs alone binds, the honest early baseline qualifies, and the no-request-evidence shape stays neutral', () => {
    const g = armRound29();
    const straddling = cleanCopy(g.record());
    straddling.interrupt.callNotBeforeMs = 500;
    straddling.interrupt.callNotAfterMs = 1500;
    const consolidatedStraddling = nativeInterruptionGateDInput(straddling).localProcessDuties;
    assert.equal(consolidatedStraddling.settled, false, 'a window the start falls inside cannot establish the ordering');
    assert.ok(consolidatedStraddling.refusals.includes('companion-baseline-unestablished'), JSON.stringify(consolidatedStraddling.refusals));
    const callOnly = cleanCopy(g.record());
    callOnly.interrupt.callAtMs = 500;
    const consolidatedCallOnly = nativeInterruptionGateDInput(callOnly).localProcessDuties;
    assert.equal(consolidatedCallOnly.settled, false);
    assert.ok(consolidatedCallOnly.refusals.includes('companion-baseline-unestablished'), JSON.stringify(consolidatedCallOnly.refusals));
    // The honest early baseline: a coherent generation created in the epoch
    // second 0 (the Darwin containment holds) with the request at 500.
    const honest = cleanCopy(g.record());
    honest.localProcess.admission.identity = { ...honest.localProcess.admission.identity, firstWriteEpochMs: 0, startOriginMs: 0.1, firstWritePreciseMs: 0.5 };
    honest.localProcess.presence.observation.startInstantEpochMs = 0;
    // (Review round 34, Finding 1) the pre-request LIVENESS witness: the
    // presence verified at 200 — after the record write, before the request.
    honest.localProcess.presence.readStartedEpochMs = 100;
    honest.localProcess.presence.identityReadEpochMs = 200;
    honest.localProcess.presence.readEpochMs = 300;
    // (Review round 33, Finding 1) the refreshed companion endpoint's
    // creation instant agrees with its overridden base (the coherent
    // pre-request generation).
    honest.localProcess.ancestryEndpoints.companion.observation.startInstantEpochMs = 0;
    honest.interrupt.callAtMs = 500;
    honest.interrupt.callNotBeforeMs = 500;
    honest.interrupt.callNotAfterMs = 500;
    const consolidatedHonest = nativeInterruptionGateDInput(honest).localProcessDuties;
    assert.equal(consolidatedHonest.settled, true, 'the pre-request generation qualifies (the ordering demonstrably established)');
    assert.deepEqual(consolidatedHonest.refusals, [], JSON.stringify(consolidatedHonest.refusals));
    const noEvidence = cleanCopy(g.record());
    const consolidatedNoEvidence = nativeInterruptionGateDInput(noEvidence).localProcessDuties;
    assert.equal(consolidatedNoEvidence.settled, true, 'without any request evidence the baseline check stays neutral (the legacy shape)');
    assert.deepEqual(consolidatedNoEvidence.refusals, [], JSON.stringify(consolidatedNoEvidence.refusals));
  });

  test('F2 (P2) RED → unterminated NODE_OPTIONS quoting refuses (the host would exit before loading the observer)', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'local-process-r29-preflight-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const workspace = join(root, 'ws');
    const dataRoot = join(root, 'data-root');
    await mkdir(workspace, { mode: 0o700 });
    await mkdir(dataRoot, { mode: 0o700 });
    const preloadPath = join(root, 'closure-stdout-preload.cjs');
    const preloadSha = sha('// the executing preload artifact\n');
    await writeFile(preloadPath, '// the executing preload artifact\n', 'utf8');
    const entryRealpath = '/private/tmp/r29-installed/skills/rescue/launcher.mjs';
    const brokerEntryRealpath = '/private/tmp/r29-installed/scripts/zcode-broker.mjs';
    const handle = {
      preloadPath, preloadSha256: preloadSha,
      captureDirectory: join(root, 'stdout-capture'), nonce: 'a'.repeat(64), maxBytes: 65536,
      entryRealpath, brokerEntryRealpath,
    };
    // (Review round 32, Finding 2) the REAL composer creates the capture
    // directory; the helper mirrors it.
    await mkdir(join(root, 'stdout-capture'), { recursive: true, mode: 0o700 });
    const arming = {
      preload: 'closure-stdout-preload.cjs', preloadSha256: preloadSha, maxBytes: 65536,
      gate: { argv: ['invoke-prepared', 'rescue'], declaredEntryRealpathSha256: sha(entryRealpath) },
      brokerGate: { declaredBrokerEntryRealpathSha256: sha(brokerEntryRealpath) },
      identityRecord: { version: 2, roles: { invocation: 'identity.json', brokerDaemon: 'identity-broker.json' } },
      environmentVariables: [],
    };
    const env = (nodeOptions) => ({
      ZCODE_DATA_ROOT: dataRoot,
      ZCODE_SHELL_WAIT_CAPTURE_DIR: handle.captureDirectory,
      ZCODE_SHELL_WAIT_CAPTURE_NONCE: handle.nonce,
      ZCODE_SHELL_WAIT_CAPTURE_ENTRY_REALPATH: handle.entryRealpath,
      ZCODE_SHELL_WAIT_CAPTURE_MAX_BYTES: String(handle.maxBytes),
      ZCODE_SHELL_WAIT_CAPTURE_BROKER_ENTRY_REALPATH: handle.brokerEntryRealpath,
      NODE_OPTIONS: nodeOptions,
    });
    const verdict = (nodeOptions) => evaluateLiveLaunchPreflight({
      case: 'rescue-interrupt', survivalControlSelector: null,
      fixture: { workspace, stdoutCapture: handle, record: { closureStdoutCapture: arming }, env: env(nodeOptions) },
    });
    // The reviewer's shape: the closing quote is missing — Node itself exits
    // code 9 (invalid value for NODE_OPTIONS, unterminated string) BEFORE
    // loading anything, so the pre-host gate must refuse by name.
    const unterminated = await verdict(`--require="${preloadPath}`);
    assert.equal(unterminated.ok, false, 'an unterminated quote is a configuration already known to lack the observer');
    assert.match(String(unterminated.reason), /unterminated/u, unterminated.reason);
    // The dangling escape inside quotes is the same invalid configuration.
    const danglingEscape = await verdict(`--require="${preloadPath}\\`);
    assert.equal(danglingEscape.ok, false);
    assert.match(String(danglingEscape.reason), /unterminated/u, danglingEscape.reason);
    // The well-formed shapes keep passing.
    const composed = await verdict(`--require "${preloadPath.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
    assert.deepEqual(composed, { ok: true, reason: null }, composed.reason);
    const equalsForm = await verdict(`--require="${preloadPath}"`);
    assert.deepEqual(equalsForm, { ok: true, reason: null }, equalsForm.reason);
  });

  test('the join version registers the round-29 replay growth', () => {
    assert.equal(NATIVE_INTERRUPTION_GATE_D_JOIN_VERSION, 37, 'join v31 (2026-10-30 local-settlement Task 3 review round 29): the observed Companion generation must demonstrably predate the interrupt request (the admitted request timestamp/bounds bind the baseline — ordering that cannot be established refuses companion-baseline-unestablished) and the NODE_OPTIONS tokenizer rejects unfinished quoting states (an unterminated double-quote or a dangling escape refuses by name — the host would exit before loading the observer); v30 (round 28): the fence echoes compare symmetrically (a missing-versus-present mismatch refuses cleanup-boundary-echo-mismatch / cutoff-echo-mismatch in both directions — cleanup-time evidence never credits across a missing echo) and the NODE_OPTIONS tokenizer matches Node exactly (apostrophes are ordinary characters, backslash escapes only inside double quotes — the inherited-apostrophe run passes, the apostrophe-quoted path refuses); v29 (round 27): a replacement-claiming retained invocation read owes a valid completion timestamp (a missing or malformed one refuses exit-reuse-read-instant-unprovable instead of being silently discarded by the recency filter), and the NODE_OPTIONS preflight parses the string into shell-ish option tokens (a --require fragment inside another option value never counts as loading the declared preload); v28 (round 26): the retained transport reads validate their completion stamps (a missing or nonnumeric completion refuses observation-instant-unprovable — torn evidence is never silently excluded from the presence horizon) and the transport exit validates its supplied carried identity instants (in-interval + safe integer, else transport-exit-carried-instant-outside-interval — the invocation-absence pattern); v27 (round 25): a retained transport retry read with an INVALID collection interval refuses explicitly (a true inversion is observation-interval-inverted, a missing start when credit depends on it is observation-start-unprovable) — torn evidence cannot turn an otherwise contradictory replay into a credited local-process layer; v26 (round 24): the retained transport retry reads validate their identity instants (the duty-observation/ancestry-endpoint pattern — malformed instants refuse by name, supplied instants must sit inside the validated collection interval) and the captured transport start identity persists with the marker (schema-additive) binding the replayed transport observation — a successor generation cannot settle the original transport duty; v25 (round 23): a supplied carried identity instant is validated against its read collection interval BEFORE the reuse latch recency filtering — an out-of-interval or malformed carried instant is torn replacement evidence refusing by name (exit-reuse-carried-instant-outside-interval), never old evidence; v24 (round 22): every credited observation binds its queried pid/scope digest to the observed identity (the duty echoes and the ancestry endpoints) and a present-but-malformed identity-read instant refuses by name instead of falling back to the completion; v23 (round 20): the persisted transport retry sequence latches replacement evidence (any generation-bound read carrying a different start identity) and absence timestamps must be safe integers before crediting (nonnumeric instants refuse by name); v22 (round 19): a live same-generation transport retry advances the presence horizon and persists the full presence sequence for replay, and the exit supersession compares the identity-read instant (an async completion never re-wins); v21 (rounds 17-18): the correlated absence validates its collection interval (inverted intervals are torn evidence), the SELECTED daemon endpoint re-verifies its parentage against the presence/record rule and a tied transport absence keeps the retry loop sampling; v20 (round 16) = the duty-observation identity-read containment, the contradictory invocation-absence shape refusal and the runtime latest-same-generation-presence tie continuation; v19 (round 15) = the declared-scope binding, the identity-bearing absence reuse latch and the walked presence horizon; v18 (round 14) = the tied-absence collection continuation, the transport-exit recency/carried-identity re-adjudication and the incomplete-interval start refusals; v17 (round 13) = the identity-read containment check, the FROZEN argv selector enforced over mere persisted agreement, and the persisted block-version gate; v16 (round 12) = the collection-interval validity for every fence-crediting read + the consistent materialization-unavailable provenance fallback; v15 (round 11) = the invocation-absence strict tie, the contradictory-duplicate-duty-slot refusal and the selected-endpoint parentage rule covering a failed refresh; v14 (round 10) = the transport PID-reuse latch + the strict transport-absence tie rule; v13 (round 9) = the transport-exit recency/carried-identity re-adjudication; v12 (round 8) = the generation-bound PRE-FENCE transport-exit conjunct, the refreshed-presence horizon/supersession and the admitted-record capture-time parentage');
  });
});

describe('local-settlement task 3 review round 30 (two P2): the preflight refuses a foreign declared invocation selector before spending a hosted launch, and NODE_OPTIONS tab/newline separators are the known-invalid environment', async () => {
  const { evaluateLiveLaunchPreflight } = await import('../tools/shell-wait-probe/driver.mjs');
  const { createHash } = await import('node:crypto');
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const sha = (v) => createHash('sha256').update(v).digest('hex');

  const armRound30 = async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'local-process-r30-preflight-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const workspace = join(root, 'ws');
    const dataRoot = join(root, 'data-root');
    await mkdir(workspace, { mode: 0o700 });
    await mkdir(dataRoot, { mode: 0o700 });
    const preloadPath = join(root, 'closure-stdout-preload.cjs');
    const preloadSha = sha('// the executing preload artifact\n');
    await writeFile(preloadPath, '// the executing preload artifact\n', 'utf8');
    const entryRealpath = '/private/tmp/r30-installed/skills/rescue/launcher.mjs';
    const brokerEntryRealpath = '/private/tmp/r30-installed/scripts/zcode-broker.mjs';
    const handle = {
      preloadPath, preloadSha256: preloadSha,
      captureDirectory: join(root, 'stdout-capture'), nonce: 'a'.repeat(64), maxBytes: 65536,
      entryRealpath, brokerEntryRealpath,
    };
    // (Review round 32, Finding 2) the REAL composer creates the capture
    // directory; the helper mirrors it.
    await mkdir(join(root, 'stdout-capture'), { recursive: true, mode: 0o700 });
    const composed = `--require "${preloadPath.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    const arming = (gateArgv) => ({
      preload: 'closure-stdout-preload.cjs', preloadSha256: preloadSha, maxBytes: 65536,
      gate: { argv: gateArgv, declaredEntryRealpathSha256: sha(entryRealpath) },
      brokerGate: { declaredBrokerEntryRealpathSha256: sha(brokerEntryRealpath) },
      identityRecord: { version: 2, roles: { invocation: 'identity.json', brokerDaemon: 'identity-broker.json' } },
      environmentVariables: [],
    });
    const env = (nodeOptions) => ({
      ZCODE_DATA_ROOT: dataRoot,
      ZCODE_SHELL_WAIT_CAPTURE_DIR: handle.captureDirectory,
      ZCODE_SHELL_WAIT_CAPTURE_NONCE: handle.nonce,
      ZCODE_SHELL_WAIT_CAPTURE_ENTRY_REALPATH: handle.entryRealpath,
      ZCODE_SHELL_WAIT_CAPTURE_MAX_BYTES: String(handle.maxBytes),
      ZCODE_SHELL_WAIT_CAPTURE_BROKER_ENTRY_REALPATH: handle.brokerEntryRealpath,
      NODE_OPTIONS: nodeOptions,
    });
    const verdict = (gateArgv, nodeOptions) => evaluateLiveLaunchPreflight({
      case: 'rescue-interrupt', survivalControlSelector: null,
      fixture: { workspace, stdoutCapture: handle, record: { closureStdoutCapture: arming(gateArgv) }, env: env(nodeOptions) },
    });
    return { verdict, composed };
  };

  test('F1 (P2) RED → a foreign declared invocation selector refuses BEFORE the hosted launch (the known-unqualifiable instrument)', async (t) => {
    const { verdict, composed } = await armRound30(t);
    // The reviewer's shape: matching entry digests + env values with a
    // declaration recording the WRONG invocation selector (['status','list'])
    // — pre-fix the preflight passed and the hosted launch was spent before
    // the offline join refused admission-selector-foreign.
    const foreign = await verdict(['status', 'list'], composed);
    assert.equal(foreign.ok, false, 'a known-unqualifiable instrument refuses pre-launch');
    assert.match(String(foreign.reason), /selector|unqualifiable/iu, foreign.reason);
    // The frozen selector keeps passing the preflight (the round-13 join
    // gate is mirrored, never replaced): the fully armed shape passes.
    const frozen = await verdict(['invoke-prepared', 'rescue'], composed);
    assert.deepEqual(frozen, { ok: true, reason: null }, `the frozen-selector instrument still qualifies: ${frozen.reason}`);
    // A declaration MISSING the selector argv refuses fail-closed too.
    const missing = await verdict(undefined, composed);
    assert.equal(missing.ok, false);
    assert.match(String(missing.reason), /selector|unqualifiable/iu, missing.reason);
  });

  test('F2 (P2) RED → a tab or newline NODE_OPTIONS separator is the known-invalid environment (Node rejects the variable before loading)', async (t) => {
    const { verdict, composed } = await armRound30(t);
    // Node verified empirically: `--require\t<path>` is rejected with
    // `is not allowed in NODE_OPTIONS` (exit 9) BEFORE loading anything —
    // the tab is an ordinary token character, never a separator.
    const tabShape = await verdict(['invoke-prepared', 'rescue'], '--require\t"/tmp/r30-preload.cjs"');
    assert.equal(tabShape.ok, false, 'the tab separator environment is known-invalid');
    assert.match(String(tabShape.reason), /NODE_OPTIONS is invalid|tab or newline/iu, tabShape.reason);
    const newlineShape = await verdict(['invoke-prepared', 'rescue'], '--require\n"/tmp/r30-preload.cjs"');
    assert.equal(newlineShape.ok, false);
    assert.match(String(newlineShape.reason), /NODE_OPTIONS is invalid|tab or newline/iu, newlineShape.reason);
    // The space shape still tokenizes as the valid require option (the
    // fully armed fixture passes end to end).
    const spaceShape = await verdict(['invoke-prepared', 'rescue'], composed);
    assert.deepEqual(spaceShape, { ok: true, reason: null }, `the space shape still passes: ${spaceShape.reason}`);
  });
});

describe('local-settlement task 3 review round 31 (one P2): the preflight requires the FROZEN preload contract on the capture handle — a handle/env pair agreeing on a foreign limit leaves the observers inert', async () => {
  const { evaluateLiveLaunchPreflight } = await import('../tools/shell-wait-probe/driver.mjs');
  const { STDOUT_CAPTURE_MAX_BYTES } = await import('../tools/shell-wait-probe/closure-preload.mjs');
  const { createHash } = await import('node:crypto');
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const sha = (v) => createHash('sha256').update(v).digest('hex');

  /** The armed preflight fixture with the capture limit PARAMETERIZED: the
   * torn shape (2048 — the handle/env pair agreeing on a foreign limit) and
   * the frozen shape (65536 — the preload's ENV_OK gate) are both
   * constructible. */
  const armRound31 = async (t, { maxBytes = STDOUT_CAPTURE_MAX_BYTES, nonce = 'a'.repeat(64), captureDirectoryRaw = null } = {}) => {
    const root = await mkdtemp(join(tmpdir(), 'local-process-r31-preflight-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const workspace = join(root, 'ws');
    const dataRoot = join(root, 'data-root');
    await mkdir(workspace, { mode: 0o700 });
    await mkdir(dataRoot, { mode: 0o700 });
    const preloadPath = join(root, 'closure-stdout-preload.cjs');
    const preloadSha = sha('// the executing preload artifact\n');
    await writeFile(preloadPath, '// the executing preload artifact\n', 'utf8');
    const entryRealpath = '/private/tmp/r31-installed/skills/rescue/launcher.mjs';
    const brokerEntryRealpath = '/private/tmp/r31-installed/scripts/zcode-broker.mjs';
    const captureDirectory = captureDirectoryRaw ?? join(root, 'stdout-capture');
    // (Review round 32, Finding 2) the REAL composer creates the capture
    // directory; the helper mirrors it (absolute paths only — the relative
    // case stays the known-invalid shape).
    if (captureDirectory.startsWith('/')) await mkdir(captureDirectory, { recursive: true, mode: 0o700 });
    const handle = {
      preloadPath, preloadSha256: preloadSha,
      captureDirectory, nonce, maxBytes,
      entryRealpath, brokerEntryRealpath,
    };
    const arming = {
      preload: 'closure-stdout-preload.cjs', preloadSha256: preloadSha, maxBytes,
      gate: { argv: ['invoke-prepared', 'rescue'], declaredEntryRealpathSha256: sha(entryRealpath) },
      brokerGate: { declaredBrokerEntryRealpathSha256: sha(brokerEntryRealpath) },
      identityRecord: { version: 2, roles: { invocation: 'identity.json', brokerDaemon: 'identity-broker.json' } },
      environmentVariables: [],
    };
    const env = {
      ZCODE_DATA_ROOT: dataRoot,
      ZCODE_SHELL_WAIT_CAPTURE_DIR: handle.captureDirectory,
      ZCODE_SHELL_WAIT_CAPTURE_NONCE: handle.nonce,
      ZCODE_SHELL_WAIT_CAPTURE_ENTRY_REALPATH: handle.entryRealpath,
      ZCODE_SHELL_WAIT_CAPTURE_MAX_BYTES: String(handle.maxBytes),
      ZCODE_SHELL_WAIT_CAPTURE_BROKER_ENTRY_REALPATH: handle.brokerEntryRealpath,
      NODE_OPTIONS: `--require "${preloadPath.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`,
    };
    const verdict = () => evaluateLiveLaunchPreflight({
      case: 'rescue-interrupt', survivalControlSelector: null,
      fixture: { workspace, stdoutCapture: handle, record: { closureStdoutCapture: arming }, env },
    });
    return { verdict };
  };

  test('F (P2) RED → a handle/env pair AGREEING on a foreign capture limit refuses (both identity-record writers would stay inert)', async (t) => {
    const { verdict } = await armRound31(t, { maxBytes: 2_048 });
    // The reviewer's shape: the handle and the environment AGREE on 2048 —
    // the agreement check passed, the genuine preload artifact and its
    // digest matched, yet closure-preload's ENV_OK gate requires the FROZEN
    // limit: both writers stay inert and no identity record is ever written.
    const refused = await verdict();
    assert.equal(refused.ok, false, 'a limit the preload contract rejects is a known-unobservable configuration');
    assert.match(String(refused.reason), /frozen preload contract|inert/iu, refused.reason);
  });

  test('F sweep → the frozen limit passes end to end, and the other frozen-constraint violations refuse by the same name', async (t) => {
    // The frozen shape passes the preflight end to end.
    const frozen = await armRound31(t);
    const frozenVerdict = await frozen.verdict();
    assert.deepEqual(frozenVerdict, { ok: true, reason: null }, `the frozen-limit instrument qualifies: ${frozenVerdict.reason}`);
    // A malformed nonce (not 64-hex) violates the preload's ENV_OK gate.
    const badNonce = await armRound31(t, { nonce: 'zz'.repeat(32) });
    const badNonceVerdict = await badNonce.verdict();
    assert.equal(badNonceVerdict.ok, false);
    assert.match(String(badNonceVerdict.reason), /frozen preload contract|inert/iu, badNonceVerdict.reason);
    // A RELATIVE capture directory violates the ENV_OK gate too (the
    // preload requires an absolute directory).
    const relativeDirectory = await armRound31(t, { captureDirectoryRaw: 'relative-capture-dir' });
    const relativeVerdict = await relativeDirectory.verdict();
    assert.equal(relativeVerdict.ok, false);
    assert.match(String(relativeVerdict.reason), /frozen preload contract|inert/iu, relativeVerdict.reason);
  });
});

describe('local-settlement task 3 review round 32 (two P2): the retained invocation presence reads validate like the transport replay, and the preflight requires a usable capture directory', async () => {
  const { evaluateLiveLaunchPreflight, nativeInterruptionGateDInput } = await import('../tools/shell-wait-probe/driver.mjs');
  const { createHash } = await import('node:crypto');
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const sha = (v) => createHash('sha256').update(v).digest('hex');
  const MEASUREMENT_CUTOFF_AT_MS = 20_000;

  const armRound32 = () => {
    const scopeNonce = 'a'.repeat(64);
    const transport = 'f'.repeat(64);
    const launcherEntryDigest = sha('launcher-entry');
    const brokerEntryDigest = sha('broker-entry');
    const observation = (pid, ppid, startIdentity, scope, readStarted, identityRead, readEpoch, startInstant = 1000) => ({
      localProcessObservationVersion: 1, class: 'os-live-observation', status: 'established', reason: null,
      observation: { pid, ppid, startIdentity, startInstantEpochMs: startInstant, ppidChangedFromCapture: null, nonceSha256: scope },
      queried: { pid, nonceSha256: scope },
      readStartedEpochMs: readStarted, identityReadEpochMs: identityRead, readEpochMs: readEpoch,
      absenceConfirmed: null,
    });
    const block = {
      version: 1, armed: true, clock: 'wall-epoch-ms', nonceSha256: sha(scopeNonce),
      admission: { localProcessObservationVersion: 1, class: 'startup-identity', status: 'established', reason: null, identity: { role: 'invocation', argv: ['invoke-prepared', 'rescue'], entryRealpathSha256: launcherEntryDigest, pid: 60100, ppid: 600, firstWriteEpochMs: 1000, startOriginMs: 1000.1, firstWritePreciseMs: 1100.5, nonceSha256: sha(scopeNonce) }, readStartedEpochMs: 1000, readEpochMs: 1100 },
      presence: observation(60100, 600, 'S-COMPANION', sha(scopeNonce), 1900, 2100, 2300),
      brokerAdmission: { localProcessObservationVersion: 1, class: 'startup-identity', status: 'established', reason: null, identity: { role: 'broker-daemon', entryRealpathSha256: brokerEntryDigest, pid: 60200, ppid: 60100, firstWriteEpochMs: 3000, startOriginMs: 3000.2, firstWritePreciseMs: 3100.6, nonceSha256: sha(scopeNonce) }, readStartedEpochMs: 1900, readEpochMs: 2100 },
      brokerObservation: observation(60200, 60100, 'S-DAEMON', sha(scopeNonce), 3300, 3400, 3500, 3000),
      transportObservation: observation(60300, 60200, 'S-TRANSPORT', sha(transport), 3800, 3900, 4000, 3600),
      transportPresenceReads: [observation(60300, 60200, 'S-TRANSPORT', sha(transport), 4800, 4900, 5000, 3600)],
      ancestryEndpoints: {
        companion: observation(60100, 600, 'S-COMPANION', sha(scopeNonce), 4600, 4650, 4700, 1000),
        daemon: observation(60200, 60100, 'S-DAEMON', sha(scopeNonce), 4600, 4650, 4750, 3000),
        transportMarker: { pid: 60300, ppid: 60200, startIdentity: 'S-TRANSPORT', nonceSha256: sha(transport), markerEpochMs: 4450 },
      },
      ancestryEndpointRefreshes: { companion: null, daemon: null },
      ancestry: { localProcessObservationVersion: 1, class: 'ancestry-join', nonceSha256: sha(scopeNonce), companionToTransportAttributed: true, hops: [
        { hop: 'companion-to-daemon', status: 'established', reason: null },
        { hop: 'daemon-to-transport', status: 'established', reason: null },
      ] },
      duties: { localProcessObservationVersion: 1, class: 'local-duty-verdict', settled: true, duties: [
        { duty: 'invocation-process', status: 'established', reasons: [], identity: { pid: 60100, startIdentity: 'S-COMPANION', nonceSha256: sha(scopeNonce) } },
        { duty: 'broker-daemon', status: 'established', reasons: [], identity: { pid: 60200, startIdentity: 'S-DAEMON', nonceSha256: sha(scopeNonce) } },
        { duty: 'transport-descendant', status: 'established', reasons: [], identity: { pid: 60300, startIdentity: 'S-TRANSPORT', nonceSha256: sha(transport) } },
      ] },
      transportExit: { localProcessObservationVersion: 1, class: 'os-live-observation', status: 'absent', reason: 'no-such-process', observation: null, queried: { pid: 60300, nonceSha256: sha(transport) }, readStartedEpochMs: 5200, identityReadEpochMs: 5250, readEpochMs: 5300, absenceConfirmed: true },
      reads: [{ localProcessObservationVersion: 1, class: 'os-live-observation', status: 'absent', reason: 'no-such-process', observation: null, queried: { pid: 60100, nonceSha256: sha(scopeNonce) }, readStartedEpochMs: 4900, readEpochMs: 5100, absenceConfirmed: true }],
      exit: { localProcessObservationVersion: 1, class: 'exit-absence', status: 'disappeared', reason: null, boundIdentity: { pid: 60100, startIdentity: 'S-COMPANION', nonceSha256: sha(scopeNonce) }, lastVerifiedPresenceEpochMs: 2100, firstVerifiedAbsenceEpochMs: 5100, exitCorroboratedByMeta: false },
      stoppedAt: null, fenceAtMs: null, cutoffAtMs: MEASUREMENT_CUTOFF_AT_MS, cleanupBoundaryAtMs: null, composedAtMs: 6000,
    };
    const record = (over = {}) => ({
      status: 'executed', case: 'rescue-interrupt', executedAt: '2026-10-30T00:00:00.000Z',
      interrupt: { measurementCutoffAtMs: MEASUREMENT_CUTOFF_AT_MS },
      stdoutCaptureDeclaration: {
        preload: 'closure-observe.mjs', preloadSha256: sha('preload-bytes'), maxBytes: 65536,
        gate: { argv: ['invoke-prepared', 'rescue'], declaredEntryRealpathSha256: launcherEntryDigest },
        brokerGate: { declaredBrokerEntryRealpathSha256: brokerEntryDigest },
        identityRecord: { version: 2, roles: { invocation: 'identity.json', brokerDaemon: 'identity-broker.json' } },
        environmentVariables: [],
      },
      observations: {}, child: {},
      localProcess: block,
      ...over,
    });
    return { scopeNonce, transport, block, record };
  };
  const cleanCopy = (base) => JSON.parse(JSON.stringify(base));

  test('F1 (P2) RED → a same-generation presence read with UNPROVABLE timestamps refuses (it is never silently discarded beside the credited absence)', () => {
    const g = armRound32();
    const torn = cleanCopy(g.record());
    // The reviewer's shape: a same-generation live read starting at 6000
    // with NO completion — the horizon and supersession checks silently
    // discarded it and the absence at 5100 fenced, crediting cleanup despite
    // the contradictory later presence evidence.
    torn.localProcess.reads.push({
      localProcessObservationVersion: 1, class: 'os-live-observation', status: 'established', reason: null,
      observation: { pid: 60100, ppid: 600, startIdentity: 'S-COMPANION', startInstantEpochMs: 1000, ppidChangedFromCapture: null, nonceSha256: sha(g.scopeNonce) },
      queried: { pid: 60100, nonceSha256: sha(g.scopeNonce) },
      readStartedEpochMs: 6000, absenceConfirmed: null,
    });
    const consolidated = nativeInterruptionGateDInput(torn).localProcessDuties;
    assert.equal(consolidated.settled, false, 'contradictory later presence evidence with unprovable timestamps is torn evidence');
    assert.ok(consolidated.refusals.includes('observation-instant-unprovable'), JSON.stringify(consolidated.refusals));
  });

  test('F1 sweep → the inverted and start-less shapes refuse by their established names, and the HONEST late presence still prevents settlement', () => {
    const g = armRound32();
    const inverted = cleanCopy(g.record());
    inverted.localProcess.reads.push({
      localProcessObservationVersion: 1, class: 'os-live-observation', status: 'established', reason: null,
      observation: { pid: 60100, ppid: 600, startIdentity: 'S-COMPANION', startInstantEpochMs: 1000, ppidChangedFromCapture: null, nonceSha256: sha(g.scopeNonce) },
      queried: { pid: 60100, nonceSha256: sha(g.scopeNonce) },
      readStartedEpochMs: 6000, identityReadEpochMs: 5950, readEpochMs: 5900, absenceConfirmed: null,
    });
    const consolidatedInverted = nativeInterruptionGateDInput(inverted).localProcessDuties;
    assert.equal(consolidatedInverted.settled, false);
    assert.ok(consolidatedInverted.refusals.includes('observation-interval-inverted'), JSON.stringify(consolidatedInverted.refusals));
    const startLess = cleanCopy(g.record());
    startLess.localProcess.reads.push({
      localProcessObservationVersion: 1, class: 'os-live-observation', status: 'established', reason: null,
      observation: { pid: 60100, ppid: 600, startIdentity: 'S-COMPANION', startInstantEpochMs: 1000, ppidChangedFromCapture: null, nonceSha256: sha(g.scopeNonce) },
      queried: { pid: 60100, nonceSha256: sha(g.scopeNonce) },
      identityReadEpochMs: 6050, readEpochMs: 6100, absenceConfirmed: null,
    });
    const consolidatedStartLess = nativeInterruptionGateDInput(startLess).localProcessDuties;
    assert.equal(consolidatedStartLess.settled, false);
    assert.ok(consolidatedStartLess.refusals.includes('observation-start-unprovable'), JSON.stringify(consolidatedStartLess.refusals));
    // The HONEST late presence raises the horizon: the absence at 5100 no
    // longer correlates (the exit-absence walk refuses the overlap).
    const honest = cleanCopy(g.record());
    honest.localProcess.reads.push({
      localProcessObservationVersion: 1, class: 'os-live-observation', status: 'established', reason: null,
      observation: { pid: 60100, ppid: 600, startIdentity: 'S-COMPANION', startInstantEpochMs: 1000, ppidChangedFromCapture: null, nonceSha256: sha(g.scopeNonce) },
      queried: { pid: 60100, nonceSha256: sha(g.scopeNonce) },
      readStartedEpochMs: 6000, identityReadEpochMs: 6050, readEpochMs: 6100, absenceConfirmed: null,
    });
    const consolidatedHonest = nativeInterruptionGateDInput(honest).localProcessDuties;
    assert.equal(consolidatedHonest.settled, false, 'the valid late presence still prevents settlement (the horizon walk sees it)');
    assert.ok(consolidatedHonest.refusals.includes('exit-absence-overlaps-presence'), JSON.stringify(consolidatedHonest.refusals));
  });

  test('F2 (P2) RED → a MISSING or non-directory capture directory refuses before the launch (the observer is already known unavailable)', async (t) => {
    const buildFixture = async (t, captureDirectory) => {
      const root = await mkdtemp(join(tmpdir(), 'local-process-r32-preflight-'));
      t.after(() => rm(root, { recursive: true, force: true }));
      const workspace = join(root, 'ws');
      const dataRoot = join(root, 'data-root');
      await mkdir(workspace, { mode: 0o700 });
      await mkdir(dataRoot, { mode: 0o700 });
      const preloadPath = join(root, 'closure-stdout-preload.cjs');
      const preloadSha = sha('// the executing preload artifact\n');
      await writeFile(preloadPath, '// the executing preload artifact\n', 'utf8');
      const entryRealpath = '/private/tmp/r32-installed/skills/rescue/launcher.mjs';
      const brokerEntryRealpath = '/private/tmp/r32-installed/scripts/zcode-broker.mjs';
      const handle = {
        preloadPath, preloadSha256: preloadSha,
        captureDirectory, nonce: 'a'.repeat(64), maxBytes: 65536,
        entryRealpath, brokerEntryRealpath,
      };
      const arming = {
        preload: 'closure-stdout-preload.cjs', preloadSha256: preloadSha, maxBytes: 65536,
        gate: { argv: ['invoke-prepared', 'rescue'], declaredEntryRealpathSha256: sha(entryRealpath) },
        brokerGate: { declaredBrokerEntryRealpathSha256: sha(brokerEntryRealpath) },
        identityRecord: { version: 2, roles: { invocation: 'identity.json', brokerDaemon: 'identity-broker.json' } },
        environmentVariables: [],
      };
      const env = {
        ZCODE_DATA_ROOT: dataRoot,
        ZCODE_SHELL_WAIT_CAPTURE_DIR: handle.captureDirectory,
        ZCODE_SHELL_WAIT_CAPTURE_NONCE: handle.nonce,
        ZCODE_SHELL_WAIT_CAPTURE_ENTRY_REALPATH: handle.entryRealpath,
        ZCODE_SHELL_WAIT_CAPTURE_MAX_BYTES: String(handle.maxBytes),
        ZCODE_SHELL_WAIT_CAPTURE_BROKER_ENTRY_REALPATH: handle.brokerEntryRealpath,
        NODE_OPTIONS: `--require "${preloadPath.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`,
      };
      return () => evaluateLiveLaunchPreflight({
        case: 'rescue-interrupt', survivalControlSelector: null,
        fixture: { workspace, stdoutCapture: handle, record: { closureStdoutCapture: arming }, env },
      });
    };
    // A NONEXISTENT directory: the absolute path passes the frozen contract,
    // but the preload never creates the directory and swallows identity-write
    // failures — the hosted case would launch with the observer already known
    // unavailable.
    const missing = await buildFixture(t, join(tmpdir(), `r32-nonexistent-${Date.now()}`, 'stdout-capture'));
    const missingVerdict = await missing();
    assert.equal(missingVerdict.ok, false, 'a missing capture directory is the observer already known unavailable');
    assert.match(String(missingVerdict.reason), /capture directory/iu, missingVerdict.reason);
    // A REGULAR FILE at the declared path is equally unusable.
    const filePath = join(tmpdir(), `r32-regular-file-${Date.now()}`);
    await writeFile(filePath, 'not a directory\n', 'utf8');
    t.after(() => rm(filePath, { force: true }));
    const regularFile = await buildFixture(t, filePath);
    const fileVerdict = await regularFile();
    assert.equal(fileVerdict.ok, false);
    assert.match(String(fileVerdict.reason), /capture directory/iu, fileVerdict.reason);
    // The usable directory passes the preflight end to end.
    const realPath = join(tmpdir(), `r32-real-${Date.now()}`, 'stdout-capture');
    const usable = await buildFixture(t, realPath);
    await mkdir(realPath, { recursive: true, mode: 0o700 });
    t.after(() => rm(realPath, { recursive: true, force: true }));
    const usableVerdict = await usable();
    assert.deepEqual(usableVerdict, { ok: true, reason: null }, `the usable directory qualifies: ${usableVerdict.reason}`);
  });
});

describe('local-settlement task 3 review round 33 (two P2): the refreshed endpoint creation instant must agree with its admission-backed observation, and the preflight requires PRIVATE capture-directory permissions', async () => {
  const { evaluateLiveLaunchPreflight, nativeInterruptionGateDInput } = await import('../tools/shell-wait-probe/driver.mjs');
  const { createHash } = await import('node:crypto');
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const sha = (v) => createHash('sha256').update(v).digest('hex');
  const MEASUREMENT_CUTOFF_AT_MS = 20_000;

  const armRound33 = () => {
    const scopeNonce = 'a'.repeat(64);
    const transport = 'f'.repeat(64);
    const launcherEntryDigest = sha('launcher-entry');
    const brokerEntryDigest = sha('broker-entry');
    const observation = (pid, ppid, startIdentity, scope, readStarted, identityRead, readEpoch, startInstant = 1000) => ({
      localProcessObservationVersion: 1, class: 'os-live-observation', status: 'established', reason: null,
      observation: { pid, ppid, startIdentity, startInstantEpochMs: startInstant, ppidChangedFromCapture: null, nonceSha256: scope },
      queried: { pid, nonceSha256: scope },
      readStartedEpochMs: readStarted, identityReadEpochMs: identityRead, readEpochMs: readEpoch,
      absenceConfirmed: null,
    });
    const block = {
      version: 1, armed: true, clock: 'wall-epoch-ms', nonceSha256: sha(scopeNonce),
      admission: { localProcessObservationVersion: 1, class: 'startup-identity', status: 'established', reason: null, identity: { role: 'invocation', argv: ['invoke-prepared', 'rescue'], entryRealpathSha256: launcherEntryDigest, pid: 60100, ppid: 600, firstWriteEpochMs: 1000, startOriginMs: 1000.1, firstWritePreciseMs: 1100.5, nonceSha256: sha(scopeNonce) }, readStartedEpochMs: 1000, readEpochMs: 1100 },
      presence: observation(60100, 600, 'S-COMPANION', sha(scopeNonce), 1900, 2100, 2300),
      brokerAdmission: { localProcessObservationVersion: 1, class: 'startup-identity', status: 'established', reason: null, identity: { role: 'broker-daemon', entryRealpathSha256: brokerEntryDigest, pid: 60200, ppid: 60100, firstWriteEpochMs: 3000, startOriginMs: 3000.2, firstWritePreciseMs: 3100.6, nonceSha256: sha(scopeNonce) }, readStartedEpochMs: 1900, readEpochMs: 2100 },
      brokerObservation: observation(60200, 60100, 'S-DAEMON', sha(scopeNonce), 3300, 3400, 3500, 3000),
      transportObservation: observation(60300, 60200, 'S-TRANSPORT', sha(transport), 3800, 3900, 4000, 3600),
      transportPresenceReads: [observation(60300, 60200, 'S-TRANSPORT', sha(transport), 4800, 4900, 5000, 3600)],
      ancestryEndpoints: {
        companion: observation(60100, 600, 'S-COMPANION', sha(scopeNonce), 4600, 4650, 4700, 1000),
        daemon: observation(60200, 60100, 'S-DAEMON', sha(scopeNonce), 4600, 4650, 4750, 3000),
        transportMarker: { pid: 60300, ppid: 60200, startIdentity: 'S-TRANSPORT', nonceSha256: sha(transport), markerEpochMs: 4450 },
      },
      ancestryEndpointRefreshes: { companion: null, daemon: null },
      ancestry: { localProcessObservationVersion: 1, class: 'ancestry-join', nonceSha256: sha(scopeNonce), companionToTransportAttributed: true, hops: [
        { hop: 'companion-to-daemon', status: 'established', reason: null },
        { hop: 'daemon-to-transport', status: 'established', reason: null },
      ] },
      duties: { localProcessObservationVersion: 1, class: 'local-duty-verdict', settled: true, duties: [
        { duty: 'invocation-process', status: 'established', reasons: [], identity: { pid: 60100, startIdentity: 'S-COMPANION', nonceSha256: sha(scopeNonce) } },
        { duty: 'broker-daemon', status: 'established', reasons: [], identity: { pid: 60200, startIdentity: 'S-DAEMON', nonceSha256: sha(scopeNonce) } },
        { duty: 'transport-descendant', status: 'established', reasons: [], identity: { pid: 60300, startIdentity: 'S-TRANSPORT', nonceSha256: sha(transport) } },
      ] },
      transportExit: { localProcessObservationVersion: 1, class: 'os-live-observation', status: 'absent', reason: 'no-such-process', observation: null, queried: { pid: 60300, nonceSha256: sha(transport) }, readStartedEpochMs: 5200, identityReadEpochMs: 5250, readEpochMs: 5300, absenceConfirmed: true },
      reads: [{ localProcessObservationVersion: 1, class: 'os-live-observation', status: 'absent', reason: 'no-such-process', observation: null, queried: { pid: 60100, nonceSha256: sha(scopeNonce) }, readStartedEpochMs: 4900, readEpochMs: 5100, absenceConfirmed: true }],
      exit: { localProcessObservationVersion: 1, class: 'exit-absence', status: 'disappeared', reason: null, boundIdentity: { pid: 60100, startIdentity: 'S-COMPANION', nonceSha256: sha(scopeNonce) }, lastVerifiedPresenceEpochMs: 2100, firstVerifiedAbsenceEpochMs: 5100, exitCorroboratedByMeta: false },
      stoppedAt: null, fenceAtMs: null, cutoffAtMs: MEASUREMENT_CUTOFF_AT_MS, cleanupBoundaryAtMs: null, composedAtMs: 6000,
    };
    const record = (over = {}) => ({
      status: 'executed', case: 'rescue-interrupt', executedAt: '2026-10-30T00:00:00.000Z',
      interrupt: { measurementCutoffAtMs: MEASUREMENT_CUTOFF_AT_MS },
      stdoutCaptureDeclaration: {
        preload: 'closure-observe.mjs', preloadSha256: sha('preload-bytes'), maxBytes: 65536,
        gate: { argv: ['invoke-prepared', 'rescue'], declaredEntryRealpathSha256: launcherEntryDigest },
        brokerGate: { declaredBrokerEntryRealpathSha256: brokerEntryDigest },
        identityRecord: { version: 2, roles: { invocation: 'identity.json', brokerDaemon: 'identity-broker.json' } },
        environmentVariables: [],
      },
      observations: {}, child: {},
      localProcess: block,
      ...over,
    });
    return { scopeNonce, transport, block, record };
  };
  const cleanCopy = (base) => JSON.parse(JSON.stringify(base));

  test('F1 (P2) RED → a refreshed endpoint whose creation instant DISAGREES with its admission-backed observation refuses', () => {
    const g = armRound33();
    const torn = cleanCopy(g.record());
    // The reviewer's shape: the same pid/start identity/nonce with a
    // DIFFERENT creation instant — the digest-bound loop accepted it and the
    // lifetime checks trusted the conflicting instant.
    torn.localProcess.ancestryEndpoints.daemon.observation.startInstantEpochMs = 3300;
    const consolidated = nativeInterruptionGateDInput(torn).localProcessDuties;
    assert.equal(consolidated.settled, false, 'contradictory generation facts never credit the ancestry');
    assert.ok(consolidated.refusals.includes('ancestry-endpoint-instant-foreign'), JSON.stringify(consolidated.refusals));
  });

  test('F1 sweep → the companion endpoint binds the same rule, and the coherent fixture stays green', () => {
    const g = armRound33();
    const companionTorn = cleanCopy(g.record());
    companionTorn.localProcess.ancestryEndpoints.companion.observation.startInstantEpochMs = 1100;
    const consolidatedCompanion = nativeInterruptionGateDInput(companionTorn).localProcessDuties;
    assert.equal(consolidatedCompanion.settled, false);
    assert.ok(consolidatedCompanion.refusals.includes('ancestry-endpoint-instant-foreign'), JSON.stringify(consolidatedCompanion.refusals));
    const coherent = nativeInterruptionGateDInput(g.record()).localProcessDuties;
    assert.equal(coherent.settled, true, 'the coherent fixture (endpoints agreeing with their observations) stays green');
    assert.deepEqual(coherent.refusals, [], JSON.stringify(coherent.refusals));
  });

  test('F2 (P2) RED → a capture directory without PRIVATE permissions refuses (the record readers reject every startup record)', async (t) => {
    const buildFixture = async (t, directoryMode) => {
      const root = await mkdtemp(join(tmpdir(), 'local-process-r33-preflight-'));
      t.after(() => rm(root, { recursive: true, force: true }));
      const workspace = join(root, 'ws');
      const dataRoot = join(root, 'data-root');
      await mkdir(workspace, { mode: 0o700 });
      await mkdir(dataRoot, { mode: 0o700 });
      const captureDirectory = join(root, 'stdout-capture');
      await mkdir(captureDirectory, { recursive: true, mode: directoryMode });
      const preloadPath = join(root, 'closure-stdout-preload.cjs');
      const preloadSha = sha('// the executing preload artifact\n');
      await writeFile(preloadPath, '// the executing preload artifact\n', 'utf8');
      const entryRealpath = '/private/tmp/r33-installed/skills/rescue/launcher.mjs';
      const brokerEntryRealpath = '/private/tmp/r33-installed/scripts/zcode-broker.mjs';
      const handle = {
        preloadPath, preloadSha256: preloadSha,
        captureDirectory, nonce: 'a'.repeat(64), maxBytes: 65536,
        entryRealpath, brokerEntryRealpath,
      };
      const arming = {
        preload: 'closure-stdout-preload.cjs', preloadSha256: preloadSha, maxBytes: 65536,
        gate: { argv: ['invoke-prepared', 'rescue'], declaredEntryRealpathSha256: sha(entryRealpath) },
        brokerGate: { declaredBrokerEntryRealpathSha256: sha(brokerEntryRealpath) },
        identityRecord: { version: 2, roles: { invocation: 'identity.json', brokerDaemon: 'identity-broker.json' } },
        environmentVariables: [],
      };
      const env = {
        ZCODE_DATA_ROOT: dataRoot,
        ZCODE_SHELL_WAIT_CAPTURE_DIR: handle.captureDirectory,
        ZCODE_SHELL_WAIT_CAPTURE_NONCE: handle.nonce,
        ZCODE_SHELL_WAIT_CAPTURE_ENTRY_REALPATH: handle.entryRealpath,
        ZCODE_SHELL_WAIT_CAPTURE_MAX_BYTES: String(handle.maxBytes),
        ZCODE_SHELL_WAIT_CAPTURE_BROKER_ENTRY_REALPATH: handle.brokerEntryRealpath,
        NODE_OPTIONS: `--require "${preloadPath.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`,
      };
      return () => evaluateLiveLaunchPreflight({
        case: 'rescue-interrupt', survivalControlSelector: null,
        fixture: { workspace, stdoutCapture: handle, record: { closureStdoutCapture: arming }, env },
      });
    };
    // The reviewer's shapes: an existing directory with 0755 or 0555 — the
    // startup-record readers (requirePrivatePermissions) require EXACTLY
    // 0700, so the host would launch with an observer already known to
    // reject every startup record.
    const groupReadable = await buildFixture(t, 0o755);
    const groupReadableVerdict = await groupReadable();
    assert.equal(groupReadableVerdict.ok, false, 'a world/group-readable capture directory is known-unobservable');
    assert.match(String(groupReadableVerdict.reason), /capture directory|0700|private/iu, groupReadableVerdict.reason);
    const readOnlyFixture = await buildFixture(t, 0o555);
    const readOnlyVerdict = await readOnlyFixture();
    assert.equal(readOnlyVerdict.ok, false);
    assert.match(String(readOnlyVerdict.reason), /capture directory|0700|private/iu, readOnlyVerdict.reason);
    // The private 0700 directory (the real composer's shape) passes.
    const priv = await buildFixture(t, 0o700);
    const privVerdict = await priv();
    assert.deepEqual(privVerdict, { ok: true, reason: null }, `the private directory qualifies: ${privVerdict.reason}`);
  });
});

describe('local-settlement task 3 review round 34 (one P2): the pre-interruption baseline owes a VERIFIED presence witness collected before the request — an earlier start alone never settles', async () => {
  const { nativeInterruptionGateDInput, NATIVE_INTERRUPTION_GATE_D_JOIN_VERSION } = await import('../tools/shell-wait-probe/driver.mjs');
  const { createHash } = await import('node:crypto');
  const sha = (v) => createHash('sha256').update(v).digest('hex');
  const MEASUREMENT_CUTOFF_AT_MS = 20_000;

  const armRound34 = () => {
    const scopeNonce = 'a'.repeat(64);
    const transport = 'f'.repeat(64);
    const launcherEntryDigest = sha('launcher-entry');
    const brokerEntryDigest = sha('broker-entry');
    const observation = (pid, ppid, startIdentity, scope, readStarted, identityRead, readEpoch, startInstant = 1000) => ({
      localProcessObservationVersion: 1, class: 'os-live-observation', status: 'established', reason: null,
      observation: { pid, ppid, startIdentity, startInstantEpochMs: startInstant, ppidChangedFromCapture: null, nonceSha256: scope },
      queried: { pid, nonceSha256: scope },
      readStartedEpochMs: readStarted, identityReadEpochMs: identityRead, readEpochMs: readEpoch,
      absenceConfirmed: null,
    });
    const block = {
      version: 1, armed: true, clock: 'wall-epoch-ms', nonceSha256: sha(scopeNonce),
      admission: { localProcessObservationVersion: 1, class: 'startup-identity', status: 'established', reason: null, identity: { role: 'invocation', argv: ['invoke-prepared', 'rescue'], entryRealpathSha256: launcherEntryDigest, pid: 60100, ppid: 600, firstWriteEpochMs: 1000, startOriginMs: 1000.1, firstWritePreciseMs: 1100.5, nonceSha256: sha(scopeNonce) }, readStartedEpochMs: 1000, readEpochMs: 1100 },
      presence: observation(60100, 600, 'S-COMPANION', sha(scopeNonce), 1900, 2100, 2300),
      brokerAdmission: { localProcessObservationVersion: 1, class: 'startup-identity', status: 'established', reason: null, identity: { role: 'broker-daemon', entryRealpathSha256: brokerEntryDigest, pid: 60200, ppid: 60100, firstWriteEpochMs: 3000, startOriginMs: 3000.2, firstWritePreciseMs: 3100.6, nonceSha256: sha(scopeNonce) }, readStartedEpochMs: 1900, readEpochMs: 2100 },
      brokerObservation: observation(60200, 60100, 'S-DAEMON', sha(scopeNonce), 3300, 3400, 3500, 3000),
      transportObservation: observation(60300, 60200, 'S-TRANSPORT', sha(transport), 3800, 3900, 4000, 3600),
      transportPresenceReads: [observation(60300, 60200, 'S-TRANSPORT', sha(transport), 4800, 4900, 5000, 3600)],
      ancestryEndpoints: {
        companion: observation(60100, 600, 'S-COMPANION', sha(scopeNonce), 4600, 4650, 4700, 1000),
        daemon: observation(60200, 60100, 'S-DAEMON', sha(scopeNonce), 4600, 4650, 4750, 3000),
        transportMarker: { pid: 60300, ppid: 60200, startIdentity: 'S-TRANSPORT', nonceSha256: sha(transport), markerEpochMs: 4450 },
      },
      ancestryEndpointRefreshes: { companion: null, daemon: null },
      ancestry: { localProcessObservationVersion: 1, class: 'ancestry-join', nonceSha256: sha(scopeNonce), companionToTransportAttributed: true, hops: [
        { hop: 'companion-to-daemon', status: 'established', reason: null },
        { hop: 'daemon-to-transport', status: 'established', reason: null },
      ] },
      duties: { localProcessObservationVersion: 1, class: 'local-duty-verdict', settled: true, duties: [
        { duty: 'invocation-process', status: 'established', reasons: [], identity: { pid: 60100, startIdentity: 'S-COMPANION', nonceSha256: sha(scopeNonce) } },
        { duty: 'broker-daemon', status: 'established', reasons: [], identity: { pid: 60200, startIdentity: 'S-DAEMON', nonceSha256: sha(scopeNonce) } },
        { duty: 'transport-descendant', status: 'established', reasons: [], identity: { pid: 60300, startIdentity: 'S-TRANSPORT', nonceSha256: sha(transport) } },
      ] },
      transportExit: { localProcessObservationVersion: 1, class: 'os-live-observation', status: 'absent', reason: 'no-such-process', observation: null, queried: { pid: 60300, nonceSha256: sha(transport) }, readStartedEpochMs: 5200, identityReadEpochMs: 5250, readEpochMs: 5300, absenceConfirmed: true },
      reads: [{ localProcessObservationVersion: 1, class: 'os-live-observation', status: 'absent', reason: 'no-such-process', observation: null, queried: { pid: 60100, nonceSha256: sha(scopeNonce) }, readStartedEpochMs: 4900, readEpochMs: 5100, absenceConfirmed: true }],
      exit: { localProcessObservationVersion: 1, class: 'exit-absence', status: 'disappeared', reason: null, boundIdentity: { pid: 60100, startIdentity: 'S-COMPANION', nonceSha256: sha(scopeNonce) }, lastVerifiedPresenceEpochMs: 2100, firstVerifiedAbsenceEpochMs: 5100, exitCorroboratedByMeta: false },
      stoppedAt: null, fenceAtMs: null, cutoffAtMs: MEASUREMENT_CUTOFF_AT_MS, cleanupBoundaryAtMs: null, composedAtMs: 6000,
    };
    const record = (over = {}) => ({
      status: 'executed', case: 'rescue-interrupt', executedAt: '2026-10-30T00:00:00.000Z',
      interrupt: { measurementCutoffAtMs: MEASUREMENT_CUTOFF_AT_MS },
      stdoutCaptureDeclaration: {
        preload: 'closure-observe.mjs', preloadSha256: sha('preload-bytes'), maxBytes: 65536,
        gate: { argv: ['invoke-prepared', 'rescue'], declaredEntryRealpathSha256: launcherEntryDigest },
        brokerGate: { declaredBrokerEntryRealpathSha256: brokerEntryDigest },
        identityRecord: { version: 2, roles: { invocation: 'identity.json', brokerDaemon: 'identity-broker.json' } },
        environmentVariables: [],
      },
      observations: {}, child: {},
      localProcess: block,
      ...over,
    });
    return { scopeNonce, transport, block, record };
  };
  const cleanCopy = (base) => JSON.parse(JSON.stringify(base));

  test('F (P2) RED → a process started BEFORE the request but first VERIFIED AFTER it never settles: the baseline owes a pre-request presence witness', () => {
    const g = armRound34();
    const torn = cleanCopy(g.record());
    // The reviewer's shape: startOriginMs 1000.1 with the request at 2000
    // (the round-29 start conjunct passes) but the first verified presence
    // at 2100 — AFTER the interrupt: no pre-interruption liveness witness
    // was ever collected, yet the join settled.
    torn.interrupt.callAtMs = 2000;
    const consolidated = nativeInterruptionGateDInput(torn).localProcessDuties;
    assert.equal(consolidated.settled, false, 'an earlier start alone does not establish the pre-interruption liveness witness');
    assert.ok(consolidated.refusals.includes('companion-baseline-unestablished'), JSON.stringify(consolidated.refusals));
  });

  test('F sweep → a pre-request presence witness qualifies, a post-request witness set cannot save an earlier start, and a torn presence is no witness', () => {
    const g = armRound34();
    // The honest shape: the generation started AND was verified alive
    // BEFORE the request (the presence collected at 100-300).
    const honest = cleanCopy(g.record());
    honest.interrupt.callAtMs = 2000;
    // The coherent pre-request generation: the record written at 0.5, the
    // creation observed in epoch second 0 (the Darwin containment), and the
    // presence verified at 200 — after the write, before the request.
    honest.localProcess.admission.identity = { ...honest.localProcess.admission.identity, firstWriteEpochMs: 0, startOriginMs: 0.1, firstWritePreciseMs: 0.5 };
    honest.localProcess.presence.observation.startInstantEpochMs = 0;
    honest.localProcess.presence.readStartedEpochMs = 100;
    honest.localProcess.presence.identityReadEpochMs = 200;
    honest.localProcess.presence.readEpochMs = 300;
    // (Review round 33, Finding 1) the refreshed companion endpoint's
    // creation instant agrees with its overridden base.
    honest.localProcess.ancestryEndpoints.companion.observation.startInstantEpochMs = 0;
    const consolidatedHonest = nativeInterruptionGateDInput(honest).localProcessDuties;
    assert.equal(consolidatedHonest.settled, true, 'the pre-request verified presence is the promised liveness witness');
    assert.deepEqual(consolidatedHonest.refusals, [], JSON.stringify(consolidatedHonest.refusals));
    // A post-request witness set cannot rescue an otherwise-valid start:
    // the only verified presence is collected at 2000-2200.
    const postRequest = cleanCopy(g.record());
    postRequest.interrupt.callAtMs = 2000;
    postRequest.localProcess.presence.readStartedEpochMs = 2000;
    postRequest.localProcess.presence.identityReadEpochMs = 2100;
    postRequest.localProcess.presence.readEpochMs = 2200;
    const consolidatedPost = nativeInterruptionGateDInput(postRequest).localProcessDuties;
    assert.equal(consolidatedPost.settled, false);
    assert.ok(consolidatedPost.refusals.includes('companion-baseline-unestablished'), JSON.stringify(consolidatedPost.refusals));
    // A TORN presence (no completion) is no witness — the conservative rule
    // refuses the unestablishable ordering.
    const tornWitness = cleanCopy(g.record());
    tornWitness.interrupt.callAtMs = 2000;
    tornWitness.localProcess.presence.readStartedEpochMs = 100;
    tornWitness.localProcess.presence.identityReadEpochMs = 200;
    delete tornWitness.localProcess.presence.readEpochMs;
    const consolidatedTorn = nativeInterruptionGateDInput(tornWitness).localProcessDuties;
    assert.equal(consolidatedTorn.settled, false);
    assert.ok(consolidatedTorn.refusals.includes('companion-baseline-unestablished'), JSON.stringify(consolidatedTorn.refusals));
  });

  test('the join version registers the round-34 replay growth', () => {
    assert.equal(NATIVE_INTERRUPTION_GATE_D_JOIN_VERSION, 37, 'join v34 (2026-10-30 local-settlement Task 3 review round 34): the pre-interruption baseline owes a VERIFIED presence witness collected before the admitted request (at least one interval-valid same-generation presence instant strictly earlier than the request — an earlier process start alone never settles; the same conservative-strict ordering refuses companion-baseline-unestablished); v33 (round 33): the refreshed ancestry endpoint creation instant must AGREE with its admission-backed observation (a conflicting instant refuses ancestry-endpoint-instant-foreign) and the preflight requires PRIVATE capture-directory permissions (exactly 0700 on POSIX — the record readers reject every startup record otherwise); v32 (round 32): the retained invocation presence reads validate like the transport replay (the round-24/25 pattern — a torn interval or unprovable timestamps refuse by name before the horizon and supersession walks) and the preflight requires a usable capture directory; v31 (round 29): the observed Companion generation must demonstrably predate the interrupt request (the admitted request timestamp/bounds bind the baseline — ordering that cannot be established refuses companion-baseline-unestablished) and the NODE_OPTIONS tokenizer rejects unfinished quoting states (an unterminated double-quote or a dangling escape refuses by name — the host would exit before loading the observer); v30 (round 28): the fence echoes compare symmetrically (a missing-versus-present mismatch refuses cleanup-boundary-echo-mismatch / cutoff-echo-mismatch in both directions — cleanup-time evidence never credits across a missing echo) and the NODE_OPTIONS tokenizer matches Node exactly (apostrophes are ordinary characters, backslash escapes only inside double quotes — the inherited-apostrophe run passes, the apostrophe-quoted path refuses); v29 (round 27): a replacement-claiming retained invocation read owes a valid completion timestamp (a missing or malformed one refuses exit-reuse-read-instant-unprovable instead of being silently discarded by the recency filter), and the NODE_OPTIONS preflight parses the string into shell-ish option tokens (a --require fragment inside another option value never counts as loading the declared preload); v28 (round 26): the retained transport reads validate their completion stamps (a missing or nonnumeric completion refuses observation-instant-unprovable — torn evidence is never silently excluded from the presence horizon) and the transport exit validates its supplied carried identity instants (in-interval + safe integer, else transport-exit-carried-instant-outside-interval — the invocation-absence pattern); v27 (round 25): a retained transport retry read with an INVALID collection interval refuses explicitly (a true inversion is observation-interval-inverted, a missing start when credit depends on it is observation-start-unprovable) — torn evidence cannot turn an otherwise contradictory replay into a credited local-process layer; v26 (round 24): the retained transport retry reads validate their identity instants (the duty-observation/ancestry-endpoint pattern — malformed instants refuse by name, supplied instants must sit inside the validated collection interval) and the captured transport start identity persists with the marker (schema-additive) binding the replayed transport observation — a successor generation cannot settle the original transport duty; v25 (round 23): a supplied carried identity instant is validated against its read collection interval BEFORE the reuse latch recency filtering — an out-of-interval or malformed carried instant is torn replacement evidence refusing by name (exit-reuse-carried-instant-outside-interval), never old evidence; v24 (round 22): every credited observation binds its queried pid/scope digest to the observed identity (the duty echoes and the ancestry endpoints) and a present-but-malformed identity-read instant refuses by name instead of falling back to the completion; v23 (round 20): the persisted transport retry sequence latches replacement evidence (any generation-bound read carrying a different start identity) and absence timestamps must be safe integers before crediting (nonnumeric instants refuse by name); v22 (round 19): a live same-generation transport retry advances the presence horizon and persists the full presence sequence for replay, and the exit supersession compares the identity-read instant (an async completion never re-wins); v21 (rounds 17-18): the correlated absence validates its collection interval (inverted intervals are torn evidence), the SELECTED daemon endpoint re-verifies its parentage against the presence/record rule and a tied transport absence keeps the retry loop sampling; v20 (round 16) = the duty-observation identity-read containment, the contradictory invocation-absence shape refusal and the runtime latest-same-generation-presence tie continuation; v19 (round 15) = the declared-scope binding, the identity-bearing absence reuse latch and the walked presence horizon; v18 (round 14) = the tied-absence collection continuation, the transport-exit recency/carried-identity re-adjudication and the incomplete-interval start refusals; v17 (round 13) = the identity-read containment check, the FROZEN argv selector enforced over mere persisted agreement, and the persisted block-version gate; v16 (round 12) = the collection-interval validity for every fence-crediting read + the consistent materialization-unavailable provenance fallback; v15 (round 11) = the invocation-absence strict tie, the contradictory-duplicate-duty-slot refusal and the selected-endpoint parentage rule covering a failed refresh; v14 (round 10) = the transport PID-reuse latch + the strict transport-absence tie rule; v13 (round 9) = the transport-exit recency/carried-identity re-adjudication; v12 (round 8) = the generation-bound PRE-FENCE transport-exit conjunct, the refreshed-presence horizon/supersession and the admitted-record capture-time parentage');
  });
});

describe('local-settlement task 3 review round 35 (one P2): a pre-request witness must be the invocation\'s own OS-observed identity — a query addressed to the invocation never witnesses it', async () => {
  const { nativeInterruptionGateDInput, NATIVE_INTERRUPTION_GATE_D_JOIN_VERSION } = await import('../tools/shell-wait-probe/driver.mjs');
  const { createHash } = await import('node:crypto');
  const sha = (v) => createHash('sha256').update(v).digest('hex');
  const MEASUREMENT_CUTOFF_AT_MS = 20_000;

  const armRound35 = () => {
    const scopeNonce = 'a'.repeat(64);
    const transport = 'f'.repeat(64);
    const launcherEntryDigest = sha('launcher-entry');
    const brokerEntryDigest = sha('broker-entry');
    const observation = (pid, ppid, startIdentity, scope, readStarted, identityRead, readEpoch, startInstant = 1000) => ({
      localProcessObservationVersion: 1, class: 'os-live-observation', status: 'established', reason: null,
      observation: { pid, ppid, startIdentity, startInstantEpochMs: startInstant, ppidChangedFromCapture: null, nonceSha256: scope },
      queried: { pid, nonceSha256: scope },
      readStartedEpochMs: readStarted, identityReadEpochMs: identityRead, readEpochMs: readEpoch,
      absenceConfirmed: null,
    });
    const block = {
      version: 1, armed: true, clock: 'wall-epoch-ms', nonceSha256: sha(scopeNonce),
      admission: { localProcessObservationVersion: 1, class: 'startup-identity', status: 'established', reason: null, identity: { role: 'invocation', argv: ['invoke-prepared', 'rescue'], entryRealpathSha256: launcherEntryDigest, pid: 60100, ppid: 600, firstWriteEpochMs: 1000, startOriginMs: 1000.1, firstWritePreciseMs: 1100.5, nonceSha256: sha(scopeNonce) }, readStartedEpochMs: 1000, readEpochMs: 1100 },
      presence: observation(60100, 600, 'S-COMPANION', sha(scopeNonce), 1900, 2100, 2300),
      brokerAdmission: { localProcessObservationVersion: 1, class: 'startup-identity', status: 'established', reason: null, identity: { role: 'broker-daemon', entryRealpathSha256: brokerEntryDigest, pid: 60200, ppid: 60100, firstWriteEpochMs: 3000, startOriginMs: 3000.2, firstWritePreciseMs: 3100.6, nonceSha256: sha(scopeNonce) }, readStartedEpochMs: 1900, readEpochMs: 2100 },
      brokerObservation: observation(60200, 60100, 'S-DAEMON', sha(scopeNonce), 3300, 3400, 3500, 3000),
      transportObservation: observation(60300, 60200, 'S-TRANSPORT', sha(transport), 3800, 3900, 4000, 3600),
      transportPresenceReads: [observation(60300, 60200, 'S-TRANSPORT', sha(transport), 4800, 4900, 5000, 3600)],
      ancestryEndpoints: {
        companion: observation(60100, 600, 'S-COMPANION', sha(scopeNonce), 4600, 4650, 4700, 1000),
        daemon: observation(60200, 60100, 'S-DAEMON', sha(scopeNonce), 4600, 4650, 4750, 3000),
        transportMarker: { pid: 60300, ppid: 60200, startIdentity: 'S-TRANSPORT', nonceSha256: sha(transport), markerEpochMs: 4450 },
      },
      ancestryEndpointRefreshes: { companion: null, daemon: null },
      ancestry: { localProcessObservationVersion: 1, class: 'ancestry-join', nonceSha256: sha(scopeNonce), companionToTransportAttributed: true, hops: [
        { hop: 'companion-to-daemon', status: 'established', reason: null },
        { hop: 'daemon-to-transport', status: 'established', reason: null },
      ] },
      duties: { localProcessObservationVersion: 1, class: 'local-duty-verdict', settled: true, duties: [
        { duty: 'invocation-process', status: 'established', reasons: [], identity: { pid: 60100, startIdentity: 'S-COMPANION', nonceSha256: sha(scopeNonce) } },
        { duty: 'broker-daemon', status: 'established', reasons: [], identity: { pid: 60200, startIdentity: 'S-DAEMON', nonceSha256: sha(scopeNonce) } },
        { duty: 'transport-descendant', status: 'established', reasons: [], identity: { pid: 60300, startIdentity: 'S-TRANSPORT', nonceSha256: sha(transport) } },
      ] },
      transportExit: { localProcessObservationVersion: 1, class: 'os-live-observation', status: 'absent', reason: 'no-such-process', observation: null, queried: { pid: 60300, nonceSha256: sha(transport) }, readStartedEpochMs: 5200, identityReadEpochMs: 5250, readEpochMs: 5300, absenceConfirmed: true },
      reads: [{ localProcessObservationVersion: 1, class: 'os-live-observation', status: 'absent', reason: 'no-such-process', observation: null, queried: { pid: 60100, nonceSha256: sha(scopeNonce) }, readStartedEpochMs: 4900, readEpochMs: 5100, absenceConfirmed: true }],
      exit: { localProcessObservationVersion: 1, class: 'exit-absence', status: 'disappeared', reason: null, boundIdentity: { pid: 60100, startIdentity: 'S-COMPANION', nonceSha256: sha(scopeNonce) }, lastVerifiedPresenceEpochMs: 2100, firstVerifiedAbsenceEpochMs: 5100, exitCorroboratedByMeta: false },
      stoppedAt: null, fenceAtMs: null, cutoffAtMs: MEASUREMENT_CUTOFF_AT_MS, cleanupBoundaryAtMs: null, composedAtMs: 6000,
    };
    const record = (over = {}) => ({
      status: 'executed', case: 'rescue-interrupt', executedAt: '2026-10-30T00:00:00.000Z',
      interrupt: { measurementCutoffAtMs: MEASUREMENT_CUTOFF_AT_MS },
      stdoutCaptureDeclaration: {
        preload: 'closure-observe.mjs', preloadSha256: sha('preload-bytes'), maxBytes: 65536,
        gate: { argv: ['invoke-prepared', 'rescue'], declaredEntryRealpathSha256: launcherEntryDigest },
        brokerGate: { declaredBrokerEntryRealpathSha256: brokerEntryDigest },
        identityRecord: { version: 2, roles: { invocation: 'identity.json', brokerDaemon: 'identity-broker.json' } },
        environmentVariables: [],
      },
      observations: {}, child: {},
      localProcess: block,
      ...over,
    });
    return { scopeNonce, transport, block, record };
  };
  const cleanCopy = (base) => JSON.parse(JSON.stringify(base));

  test('F (P2) RED → a retained read QUERYING the invocation but OBSERVING a foreign identity is no pre-request witness', () => {
    const g = armRound35();
    const torn = cleanCopy(g.record());
    // The reviewer's shape: the round-34 negative (the request at 2000, the
    // only verified presence at 2100) plus a retained read that QUERIES the
    // invocation pid/scope but OBSERVES a foreign pid/nonce with a matching
    // start-identity STRING and pre-request timestamps — the loop credited
    // it as the pre-interruption liveness witness.
    torn.interrupt.callAtMs = 2000;
    torn.localProcess.reads.push({
      localProcessObservationVersion: 1, class: 'os-live-observation', status: 'established', reason: null,
      observation: { pid: 99999, ppid: 600, startIdentity: 'S-COMPANION', startInstantEpochMs: 1000, ppidChangedFromCapture: null, nonceSha256: sha('a-foreign-scope') },
      queried: { pid: 60100, nonceSha256: sha(g.scopeNonce) },
      readStartedEpochMs: 100, identityReadEpochMs: 200, readEpochMs: 300, absenceConfirmed: null,
    });
    const consolidated = nativeInterruptionGateDInput(torn).localProcessDuties;
    assert.equal(consolidated.settled, false, 'a query addressed to the invocation never witnesses it');
    assert.ok(consolidated.refusals.includes('companion-baseline-unestablished'), JSON.stringify(consolidated.refusals));
  });

  test('F sweep → the observed-identity binding covers the nonce digest alone, and the invocation\'s own pre-request presence still witnesses', () => {
    const g = armRound35();
    const foreignNonceOnly = cleanCopy(g.record());
    foreignNonceOnly.interrupt.callAtMs = 2000;
    foreignNonceOnly.localProcess.reads.push({
      localProcessObservationVersion: 1, class: 'os-live-observation', status: 'established', reason: null,
      observation: { pid: 60100, ppid: 600, startIdentity: 'S-COMPANION', startInstantEpochMs: 1000, ppidChangedFromCapture: null, nonceSha256: sha('a-foreign-scope') },
      queried: { pid: 60100, nonceSha256: sha(g.scopeNonce) },
      readStartedEpochMs: 100, identityReadEpochMs: 200, readEpochMs: 300, absenceConfirmed: null,
    });
    const consolidatedNonce = nativeInterruptionGateDInput(foreignNonceOnly).localProcessDuties;
    assert.equal(consolidatedNonce.settled, false, 'an observation carrying a foreign scope digest is no witness');
    assert.ok(consolidatedNonce.refusals.includes('companion-baseline-unestablished'), JSON.stringify(consolidatedNonce.refusals));
    // The invocation's OWN pre-request presence keeps witnessing.
    const honest = cleanCopy(g.record());
    honest.interrupt.callAtMs = 2000;
    honest.localProcess.presence.readStartedEpochMs = 1500;
    honest.localProcess.presence.identityReadEpochMs = 1600;
    honest.localProcess.presence.readEpochMs = 1700;
    const consolidatedHonest = nativeInterruptionGateDInput(honest).localProcessDuties;
    assert.equal(consolidatedHonest.settled, true, 'the invocation\'s own pre-request verified presence witnesses');
    assert.deepEqual(consolidatedHonest.refusals, [], JSON.stringify(consolidatedHonest.refusals));
  });

  test('the join version registers the round-35 replay growth', () => {
    assert.equal(NATIVE_INTERRUPTION_GATE_D_JOIN_VERSION, 37, 'join v35 (2026-10-30 local-settlement Task 3 review round 35): a pre-request baseline witness must be the invocation\'s own OS-observed identity (the observed pid and nonce digest must match the admitted invocation — a query addressed to the invocation never witnesses it, the round-20 queried-binding rule mirrored on the observed side); v34 (round 34): the pre-interruption baseline owes a VERIFIED presence witness collected before the admitted request (at least one interval-valid same-generation presence instant strictly earlier than the request — an earlier process start alone never settles; the same conservative-strict ordering refuses companion-baseline-unestablished); v33 (round 33): the refreshed ancestry endpoint creation instant must AGREE with its admission-backed observation (a conflicting instant refuses ancestry-endpoint-instant-foreign) and the preflight requires PRIVATE capture-directory permissions (exactly 0700 on POSIX — the record readers reject every startup record otherwise); v32 (round 32): the retained invocation presence reads validate like the transport replay (the round-24/25 pattern — a torn interval or unprovable timestamps refuse by name before the horizon and supersession walks) and the preflight requires a usable capture directory; v31 (round 29): the observed Companion generation must demonstrably predate the interrupt request (the admitted request timestamp/bounds bind the baseline — ordering that cannot be established refuses companion-baseline-unestablished) and the NODE_OPTIONS tokenizer rejects unfinished quoting states (an unterminated double-quote or a dangling escape refuses by name — the host would exit before loading the observer); v30 (round 28): the fence echoes compare symmetrically (a missing-versus-present mismatch refuses cleanup-boundary-echo-mismatch / cutoff-echo-mismatch in both directions — cleanup-time evidence never credits across a missing echo) and the NODE_OPTIONS tokenizer matches Node exactly (apostrophes are ordinary characters, backslash escapes only inside double quotes — the inherited-apostrophe run passes, the apostrophe-quoted path refuses); v29 (round 27): a replacement-claiming retained invocation read owes a valid completion timestamp (a missing or malformed one refuses exit-reuse-read-instant-unprovable instead of being silently discarded by the recency filter), and the NODE_OPTIONS preflight parses the string into shell-ish option tokens (a --require fragment inside another option value never counts as loading the declared preload); v28 (round 26): the retained transport reads validate their completion stamps (a missing or nonnumeric completion refuses observation-instant-unprovable — torn evidence is never silently excluded from the presence horizon) and the transport exit validates its supplied carried identity instants (in-interval + safe integer, else transport-exit-carried-instant-outside-interval — the invocation-absence pattern); v27 (round 25): a retained transport retry read with an INVALID collection interval refuses explicitly (a true inversion is observation-interval-inverted, a missing start when credit depends on it is observation-start-unprovable) — torn evidence cannot turn an otherwise contradictory replay into a credited local-process layer; v26 (round 24): the retained transport retry reads validate their identity instants (the duty-observation/ancestry-endpoint pattern — malformed instants refuse by name, supplied instants must sit inside the validated collection interval) and the captured transport start identity persists with the marker (schema-additive) binding the replayed transport observation — a successor generation cannot settle the original transport duty; v25 (round 23): a supplied carried identity instant is validated against its read collection interval BEFORE the reuse latch recency filtering — an out-of-interval or malformed carried instant is torn replacement evidence refusing by name (exit-reuse-carried-instant-outside-interval), never old evidence; v24 (round 22): every credited observation binds its queried pid/scope digest to the observed identity (the duty echoes and the ancestry endpoints) and a present-but-malformed identity-read instant refuses by name instead of falling back to the completion; v23 (round 20): the persisted transport retry sequence latches replacement evidence (any generation-bound read carrying a different start identity) and absence timestamps must be safe integers before crediting (nonnumeric instants refuse by name); v22 (round 19): a live same-generation transport retry advances the presence horizon and persists the full presence sequence for replay, and the exit supersession compares the identity-read instant (an async completion never re-wins); v21 (rounds 17-18): the correlated absence validates its collection interval (inverted intervals are torn evidence), the SELECTED daemon endpoint re-verifies its parentage against the presence/record rule and a tied transport absence keeps the retry loop sampling; v20 (round 16) = the duty-observation identity-read containment, the contradictory invocation-absence shape refusal and the runtime latest-same-generation-presence tie continuation; v19 (round 15) = the declared-scope binding, the identity-bearing absence reuse latch and the walked presence horizon; v18 (round 14) = the tied-absence collection continuation, the transport-exit recency/carried-identity re-adjudication and the incomplete-interval start refusals; v17 (round 13) = the identity-read containment check, the FROZEN argv selector enforced over mere persisted agreement, and the persisted block-version gate; v16 (round 12) = the collection-interval validity for every fence-crediting read + the consistent materialization-unavailable provenance fallback; v15 (round 11) = the invocation-absence strict tie, the contradictory-duplicate-duty-slot refusal and the selected-endpoint parentage rule covering a failed refresh; v14 (round 10) = the transport PID-reuse latch + the strict transport-absence tie rule; v13 (round 9) = the transport-exit recency/carried-identity re-adjudication; v12 (round 8) = the generation-bound PRE-FENCE transport-exit conjunct, the refreshed-presence horizon/supersession and the admitted-record capture-time parentage');
  });
});

describe('local-settlement task 3 review round 36 (one P2): a pre-request witness must postdate the admitted generation start — temporally impossible cached evidence is no witness', async () => {
  const { nativeInterruptionGateDInput } = await import('../tools/shell-wait-probe/driver.mjs');
  const { createHash } = await import('node:crypto');
  const sha = (v) => createHash('sha256').update(v).digest('hex');
  const MEASUREMENT_CUTOFF_AT_MS = 20_000;

  const armRound36 = () => {
    const scopeNonce = 'a'.repeat(64);
    const transport = 'f'.repeat(64);
    const launcherEntryDigest = sha('launcher-entry');
    const brokerEntryDigest = sha('broker-entry');
    const observation = (pid, ppid, startIdentity, scope, readStarted, identityRead, readEpoch, startInstant = 1000) => ({
      localProcessObservationVersion: 1, class: 'os-live-observation', status: 'established', reason: null,
      observation: { pid, ppid, startIdentity, startInstantEpochMs: startInstant, ppidChangedFromCapture: null, nonceSha256: scope },
      queried: { pid, nonceSha256: scope },
      readStartedEpochMs: readStarted, identityReadEpochMs: identityRead, readEpochMs: readEpoch,
      absenceConfirmed: null,
    });
    const block = {
      version: 1, armed: true, clock: 'wall-epoch-ms', nonceSha256: sha(scopeNonce),
      admission: { localProcessObservationVersion: 1, class: 'startup-identity', status: 'established', reason: null, identity: { role: 'invocation', argv: ['invoke-prepared', 'rescue'], entryRealpathSha256: launcherEntryDigest, pid: 60100, ppid: 600, firstWriteEpochMs: 1000, startOriginMs: 1000.1, firstWritePreciseMs: 1100.5, nonceSha256: sha(scopeNonce) }, readStartedEpochMs: 1000, readEpochMs: 1100 },
      presence: observation(60100, 600, 'S-COMPANION', sha(scopeNonce), 1900, 2100, 2300),
      brokerAdmission: { localProcessObservationVersion: 1, class: 'startup-identity', status: 'established', reason: null, identity: { role: 'broker-daemon', entryRealpathSha256: brokerEntryDigest, pid: 60200, ppid: 60100, firstWriteEpochMs: 3000, startOriginMs: 3000.2, firstWritePreciseMs: 3100.6, nonceSha256: sha(scopeNonce) }, readStartedEpochMs: 1900, readEpochMs: 2100 },
      brokerObservation: observation(60200, 60100, 'S-DAEMON', sha(scopeNonce), 3300, 3400, 3500, 3000),
      transportObservation: observation(60300, 60200, 'S-TRANSPORT', sha(transport), 3800, 3900, 4000, 3600),
      transportPresenceReads: [observation(60300, 60200, 'S-TRANSPORT', sha(transport), 4800, 4900, 5000, 3600)],
      ancestryEndpoints: {
        companion: observation(60100, 600, 'S-COMPANION', sha(scopeNonce), 4600, 4650, 4700, 1000),
        daemon: observation(60200, 60100, 'S-DAEMON', sha(scopeNonce), 4600, 4650, 4750, 3000),
        transportMarker: { pid: 60300, ppid: 60200, startIdentity: 'S-TRANSPORT', nonceSha256: sha(transport), markerEpochMs: 4450 },
      },
      ancestryEndpointRefreshes: { companion: null, daemon: null },
      ancestry: { localProcessObservationVersion: 1, class: 'ancestry-join', nonceSha256: sha(scopeNonce), companionToTransportAttributed: true, hops: [
        { hop: 'companion-to-daemon', status: 'established', reason: null },
        { hop: 'daemon-to-transport', status: 'established', reason: null },
      ] },
      duties: { localProcessObservationVersion: 1, class: 'local-duty-verdict', settled: true, duties: [
        { duty: 'invocation-process', status: 'established', reasons: [], identity: { pid: 60100, startIdentity: 'S-COMPANION', nonceSha256: sha(scopeNonce) } },
        { duty: 'broker-daemon', status: 'established', reasons: [], identity: { pid: 60200, startIdentity: 'S-DAEMON', nonceSha256: sha(scopeNonce) } },
        { duty: 'transport-descendant', status: 'established', reasons: [], identity: { pid: 60300, startIdentity: 'S-TRANSPORT', nonceSha256: sha(transport) } },
      ] },
      transportExit: { localProcessObservationVersion: 1, class: 'os-live-observation', status: 'absent', reason: 'no-such-process', observation: null, queried: { pid: 60300, nonceSha256: sha(transport) }, readStartedEpochMs: 5200, identityReadEpochMs: 5250, readEpochMs: 5300, absenceConfirmed: true },
      reads: [{ localProcessObservationVersion: 1, class: 'os-live-observation', status: 'absent', reason: 'no-such-process', observation: null, queried: { pid: 60100, nonceSha256: sha(scopeNonce) }, readStartedEpochMs: 4900, readEpochMs: 5100, absenceConfirmed: true }],
      exit: { localProcessObservationVersion: 1, class: 'exit-absence', status: 'disappeared', reason: null, boundIdentity: { pid: 60100, startIdentity: 'S-COMPANION', nonceSha256: sha(scopeNonce) }, lastVerifiedPresenceEpochMs: 2100, firstVerifiedAbsenceEpochMs: 5100, exitCorroboratedByMeta: false },
      stoppedAt: null, fenceAtMs: null, cutoffAtMs: MEASUREMENT_CUTOFF_AT_MS, cleanupBoundaryAtMs: null, composedAtMs: 6000,
    };
    const record = (over = {}) => ({
      status: 'executed', case: 'rescue-interrupt', executedAt: '2026-10-30T00:00:00.000Z',
      interrupt: { measurementCutoffAtMs: MEASUREMENT_CUTOFF_AT_MS },
      stdoutCaptureDeclaration: {
        preload: 'closure-observe.mjs', preloadSha256: sha('preload-bytes'), maxBytes: 65536,
        gate: { argv: ['invoke-prepared', 'rescue'], declaredEntryRealpathSha256: launcherEntryDigest },
        brokerGate: { declaredBrokerEntryRealpathSha256: brokerEntryDigest },
        identityRecord: { version: 2, roles: { invocation: 'identity.json', brokerDaemon: 'identity-broker.json' } },
        environmentVariables: [],
      },
      observations: {}, child: {},
      localProcess: block,
      ...over,
    });
    return { scopeNonce, transport, block, record };
  };
  const cleanCopy = (base) => JSON.parse(JSON.stringify(base));

  test('F (P2) RED → a witness instant BEFORE the admitted generation start is temporally impossible cached evidence', () => {
    const g = armRound36();
    const torn = cleanCopy(g.record());
    // The reviewer's shape: the request at 2000 with the invocation starting
    // at 1000.1, plus a retained presence over [100, 300] with its identity
    // instant at 200 — BEFORE the process existed: the round-34 witness rule
    // credited it (200 < 2000) and flipped the negative fixture to settled.
    torn.interrupt.callAtMs = 2000;
    torn.localProcess.reads.push({
      localProcessObservationVersion: 1, class: 'os-live-observation', status: 'established', reason: null,
      observation: { pid: 60100, ppid: 600, startIdentity: 'S-COMPANION', startInstantEpochMs: 1000, ppidChangedFromCapture: null, nonceSha256: sha(g.scopeNonce) },
      queried: { pid: 60100, nonceSha256: sha(g.scopeNonce) },
      readStartedEpochMs: 100, identityReadEpochMs: 200, readEpochMs: 300, absenceConfirmed: null,
    });
    const consolidated = nativeInterruptionGateDInput(torn).localProcessDuties;
    assert.equal(consolidated.settled, false, 'impossible cached evidence cannot satisfy the pre-interruption baseline');
    assert.ok(consolidated.refusals.includes('companion-baseline-unestablished'), JSON.stringify(consolidated.refusals));
  });

  test('F sweep → a witness AT the generation start is fresh, a witness after it witnesses, and the pre-start shape is the only refusal', () => {
    const g = armRound36();
    // The witness instant AT/AFTER the admitted generation start (1000.1)
    // and before the request (2000): fresh pre-interruption liveness.
    const fresh = cleanCopy(g.record());
    fresh.interrupt.callAtMs = 2000;
    fresh.localProcess.reads.push({
      localProcessObservationVersion: 1, class: 'os-live-observation', status: 'established', reason: null,
      observation: { pid: 60100, ppid: 600, startIdentity: 'S-COMPANION', startInstantEpochMs: 1000, ppidChangedFromCapture: null, nonceSha256: sha(g.scopeNonce) },
      queried: { pid: 60100, nonceSha256: sha(g.scopeNonce) },
      readStartedEpochMs: 1100, identityReadEpochMs: 1500, readEpochMs: 1600, absenceConfirmed: null,
    });
    const consolidatedFresh = nativeInterruptionGateDInput(fresh).localProcessDuties;
    assert.equal(consolidatedFresh.settled, true, 'the fresh pre-request witness establishes the baseline');
    assert.deepEqual(consolidatedFresh.refusals, [], JSON.stringify(consolidatedFresh.refusals));
  });
});

describe('local-settlement task 3 review round 37 (one P2): a pre-request witness owes the §25.7 completion fence — post-fence or unprovable-completion evidence is no witness', async () => {
  const { nativeInterruptionGateDInput } = await import('../tools/shell-wait-probe/driver.mjs');
  const { createHash } = await import('node:crypto');
  const sha = (v) => createHash('sha256').update(v).digest('hex');
  const MEASUREMENT_CUTOFF_AT_MS = 20_000;

  const armRound37 = () => {
    const scopeNonce = 'a'.repeat(64);
    const transport = 'f'.repeat(64);
    const launcherEntryDigest = sha('launcher-entry');
    const brokerEntryDigest = sha('broker-entry');
    const observation = (pid, ppid, startIdentity, scope, readStarted, identityRead, readEpoch, startInstant = 1000) => ({
      localProcessObservationVersion: 1, class: 'os-live-observation', status: 'established', reason: null,
      observation: { pid, ppid, startIdentity, startInstantEpochMs: startInstant, ppidChangedFromCapture: null, nonceSha256: scope },
      queried: { pid, nonceSha256: scope },
      readStartedEpochMs: readStarted, identityReadEpochMs: identityRead, readEpochMs: readEpoch,
      absenceConfirmed: null,
    });
    const block = {
      version: 1, armed: true, clock: 'wall-epoch-ms', nonceSha256: sha(scopeNonce),
      admission: { localProcessObservationVersion: 1, class: 'startup-identity', status: 'established', reason: null, identity: { role: 'invocation', argv: ['invoke-prepared', 'rescue'], entryRealpathSha256: launcherEntryDigest, pid: 60100, ppid: 600, firstWriteEpochMs: 1000, startOriginMs: 1000.1, firstWritePreciseMs: 1100.5, nonceSha256: sha(scopeNonce) }, readStartedEpochMs: 1000, readEpochMs: 1100 },
      presence: observation(60100, 600, 'S-COMPANION', sha(scopeNonce), 1900, 2100, 2300),
      brokerAdmission: { localProcessObservationVersion: 1, class: 'startup-identity', status: 'established', reason: null, identity: { role: 'broker-daemon', entryRealpathSha256: brokerEntryDigest, pid: 60200, ppid: 60100, firstWriteEpochMs: 3000, startOriginMs: 3000.2, firstWritePreciseMs: 3100.6, nonceSha256: sha(scopeNonce) }, readStartedEpochMs: 1900, readEpochMs: 2100 },
      brokerObservation: observation(60200, 60100, 'S-DAEMON', sha(scopeNonce), 3300, 3400, 3500, 3000),
      transportObservation: observation(60300, 60200, 'S-TRANSPORT', sha(transport), 3800, 3900, 4000, 3600),
      transportPresenceReads: [observation(60300, 60200, 'S-TRANSPORT', sha(transport), 4800, 4900, 5000, 3600)],
      ancestryEndpoints: {
        companion: observation(60100, 600, 'S-COMPANION', sha(scopeNonce), 4600, 4650, 4700, 1000),
        daemon: observation(60200, 60100, 'S-DAEMON', sha(scopeNonce), 4600, 4650, 4750, 3000),
        transportMarker: { pid: 60300, ppid: 60200, startIdentity: 'S-TRANSPORT', nonceSha256: sha(transport), markerEpochMs: 4450 },
      },
      ancestryEndpointRefreshes: { companion: null, daemon: null },
      ancestry: { localProcessObservationVersion: 1, class: 'ancestry-join', nonceSha256: sha(scopeNonce), companionToTransportAttributed: true, hops: [
        { hop: 'companion-to-daemon', status: 'established', reason: null },
        { hop: 'daemon-to-transport', status: 'established', reason: null },
      ] },
      duties: { localProcessObservationVersion: 1, class: 'local-duty-verdict', settled: true, duties: [
        { duty: 'invocation-process', status: 'established', reasons: [], identity: { pid: 60100, startIdentity: 'S-COMPANION', nonceSha256: sha(scopeNonce) } },
        { duty: 'broker-daemon', status: 'established', reasons: [], identity: { pid: 60200, startIdentity: 'S-DAEMON', nonceSha256: sha(scopeNonce) } },
        { duty: 'transport-descendant', status: 'established', reasons: [], identity: { pid: 60300, startIdentity: 'S-TRANSPORT', nonceSha256: sha(transport) } },
      ] },
      transportExit: { localProcessObservationVersion: 1, class: 'os-live-observation', status: 'absent', reason: 'no-such-process', observation: null, queried: { pid: 60300, nonceSha256: sha(transport) }, readStartedEpochMs: 5200, identityReadEpochMs: 5250, readEpochMs: 5300, absenceConfirmed: true },
      reads: [{ localProcessObservationVersion: 1, class: 'os-live-observation', status: 'absent', reason: 'no-such-process', observation: null, queried: { pid: 60100, nonceSha256: sha(scopeNonce) }, readStartedEpochMs: 4900, readEpochMs: 5100, absenceConfirmed: true }],
      exit: { localProcessObservationVersion: 1, class: 'exit-absence', status: 'disappeared', reason: null, boundIdentity: { pid: 60100, startIdentity: 'S-COMPANION', nonceSha256: sha(scopeNonce) }, lastVerifiedPresenceEpochMs: 2100, firstVerifiedAbsenceEpochMs: 5100, exitCorroboratedByMeta: false },
      stoppedAt: null, fenceAtMs: null, cutoffAtMs: MEASUREMENT_CUTOFF_AT_MS, cleanupBoundaryAtMs: null, composedAtMs: 6000,
    };
    const record = (over = {}) => ({
      status: 'executed', case: 'rescue-interrupt', executedAt: '2026-10-30T00:00:00.000Z',
      interrupt: { measurementCutoffAtMs: MEASUREMENT_CUTOFF_AT_MS },
      stdoutCaptureDeclaration: {
        preload: 'closure-observe.mjs', preloadSha256: sha('preload-bytes'), maxBytes: 65536,
        gate: { argv: ['invoke-prepared', 'rescue'], declaredEntryRealpathSha256: launcherEntryDigest },
        brokerGate: { declaredBrokerEntryRealpathSha256: brokerEntryDigest },
        identityRecord: { version: 2, roles: { invocation: 'identity.json', brokerDaemon: 'identity-broker.json' } },
        environmentVariables: [],
      },
      observations: {}, child: {},
      localProcess: block,
      ...over,
    });
    return { scopeNonce, transport, block, record };
  };
  const cleanCopy = (base) => JSON.parse(JSON.stringify(base));

  test('F (P2) RED → explicitly post-fence evidence supplies no pre-request baseline', () => {
    const g = armRound37();
    const torn = cleanCopy(g.record());
    // The reviewer's shape: the request at 2000 and the cutoff at 20000 with
    // a same-generation read whose identity instant is 1600 (fresh, before
    // the request) but whose collection completes at 25000 — AFTER the
    // fence — and the runtime's own postFence naming riding: the round-36
    // rule credited it and flipped the negative fixture to settled.
    torn.interrupt.callAtMs = 2000;
    torn.localProcess.reads.push({
      localProcessObservationVersion: 1, class: 'os-live-observation', status: 'established', reason: null,
      observation: { pid: 60100, ppid: 600, startIdentity: 'S-COMPANION', startInstantEpochMs: 1000, ppidChangedFromCapture: null, nonceSha256: sha(g.scopeNonce) },
      queried: { pid: 60100, nonceSha256: sha(g.scopeNonce) },
      readStartedEpochMs: 1500, identityReadEpochMs: 1600, readEpochMs: 25000, absenceConfirmed: null, postFence: true,
    });
    const consolidated = nativeInterruptionGateDInput(torn).localProcessDuties;
    assert.equal(consolidated.settled, false, 'explicitly post-fence evidence is no pre-interruption witness');
    assert.ok(consolidated.refusals.includes('companion-baseline-unestablished'), JSON.stringify(consolidated.refusals));
  });

  test('F sweep → the pre-fence witness still witnesses, and an unprovable completion is no witness either', () => {
    const g = armRound37();
    // The §25.7-clean witness: the collection completes strictly before the
    // fence (1600 < 20000) — the promised liveness witness stands.
    const clean = cleanCopy(g.record());
    clean.interrupt.callAtMs = 2000;
    clean.localProcess.reads.push({
      localProcessObservationVersion: 1, class: 'os-live-observation', status: 'established', reason: null,
      observation: { pid: 60100, ppid: 600, startIdentity: 'S-COMPANION', startInstantEpochMs: 1000, ppidChangedFromCapture: null, nonceSha256: sha(g.scopeNonce) },
      queried: { pid: 60100, nonceSha256: sha(g.scopeNonce) },
      readStartedEpochMs: 1500, identityReadEpochMs: 1600, readEpochMs: 1700, absenceConfirmed: null,
    });
    const consolidatedClean = nativeInterruptionGateDInput(clean).localProcessDuties;
    assert.equal(consolidatedClean.settled, true, 'the pre-fence pre-request witness establishes the baseline');
    assert.deepEqual(consolidatedClean.refusals, [], JSON.stringify(consolidatedClean.refusals));
    // An UNPROVABLE completion (missing) is no witness either — the same
    // conservative fence discipline.
    const unprovable = cleanCopy(g.record());
    unprovable.interrupt.callAtMs = 2000;
    unprovable.localProcess.reads.push({
      localProcessObservationVersion: 1, class: 'os-live-observation', status: 'established', reason: null,
      observation: { pid: 60100, ppid: 600, startIdentity: 'S-COMPANION', startInstantEpochMs: 1000, ppidChangedFromCapture: null, nonceSha256: sha(g.scopeNonce) },
      queried: { pid: 60100, nonceSha256: sha(g.scopeNonce) },
      readStartedEpochMs: 1500, identityReadEpochMs: 1600, absenceConfirmed: null,
    });
    const consolidatedUnprovable = nativeInterruptionGateDInput(unprovable).localProcessDuties;
    assert.equal(consolidatedUnprovable.settled, false);
    assert.ok(consolidatedUnprovable.refusals.includes('companion-baseline-unestablished'), JSON.stringify(consolidatedUnprovable.refusals));
  });
});
