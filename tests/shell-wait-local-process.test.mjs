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
      'LOCAL_OBSERVER_DIGEST_TAG',
      'LOCAL_PROCESS_OBSERVATION_VERSION',
      'adjudicateLocalDuties',
      'adjudicateLocalExit',
      'admitStartupIdentityRecord',
      'captureVerifiedProcessIdentity',
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
