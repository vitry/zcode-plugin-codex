import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { RESCUE_RUNNER_SUBCOMMAND, spawnRescueRunner } from '../scripts/lib/rescue-runner.mjs';

const COMPANION_ENTRY = '/plugin/zcode-companion.mjs';
const WORKSPACE = '/workspace';
const JOB_ID = 'a'.repeat(64);
const BOUNDED_ENV = { ZCODE_PLUGIN_RUNTIME: 'bounded' };

/**
 * Build one EventEmitter fake child with the detached-runner surface. It has
 * no stdio at all: any fd3/fd4 capability transport or acknowledgement-pipe
 * write would fail the tests outright.
 */
function fakeChild() {
  const child = /** @type {any} */ (new EventEmitter());
  const calls = { unref: 0, kill: 0 };
  child.pid = 4242;
  child.unref = () => { calls.unref += 1; };
  child.kill = () => { calls.kill += 1; return true; };
  return { child, calls };
}

/** Settle the current microtask queue so the adapter reaches its first await. */
function waitTurn() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

test('the private Host-runner subcommand token is the canonical selector', () => {
  assert.equal(RESCUE_RUNNER_SUBCOMMAND, 'run-host-rescue-job');
});

test('spawnRescueRunner launches the installed entry and resolves only on the OS spawn event', async () => {
  const { child, calls } = fakeChild();
  let invocation;
  const spawnChild = /** @type {any} */ ((/** @type {any} */ command, /** @type {any} */ args, /** @type {any} */ options) => {
    invocation = { command, args, options };
    return child;
  });
  const env = { ...BOUNDED_ENV };
  const pending = spawnRescueRunner({ companionPath: COMPANION_ENTRY, workspace: WORKSPACE, jobId: JOB_ID, env, spawnChild });
  const outcome = pending.then(
    (value) => ({ kind: 'fulfilled', value }),
    (error) => ({ kind: 'rejected', error }),
  );
  await waitTurn();
  // Exact launch contract: same installed Node entry, private Host-runner
  // subcommand, only the canonical workspace/job selector, ignored stdio (no
  // fd3/fd4), detached/hidden/unshelled, and the caller's bounded environment
  // passed through untouched with no legacy worker selector invented.
  assert.deepEqual(invocation, {
    command: process.execPath,
    args: [COMPANION_ENTRY, RESCUE_RUNNER_SUBCOMMAND, JOB_ID],
    options: { cwd: WORKSPACE, env, detached: true, windowsHide: true, shell: false, stdio: 'ignore' },
  });
  assert.deepEqual(env, BOUNDED_ENV, 'the caller-owned environment must not be mutated');
  assert.equal(calls.unref, 0, 'the runner must not detach before the OS spawn event');
  // Gated spawn event: the launch promise is still pending and nothing but the
  // OS spawn event is awaited — no ready, claim, or acknowledgement signal.
  assert.equal(await Promise.race([outcome.then(() => 'settled'), Promise.resolve('pending')]), 'pending');
  child.emit('spawn');
  assert.deepEqual(await pending, { pid: 4242 });
  assert.equal(calls.unref, 1, 'the spawned runner must detach from the enqueue process exactly once');
});

test('a late runner error or exit after spawn is swallowed without parent-side terminalization', async () => {
  const { child, calls } = fakeChild();
  const spawnChild = () => { queueMicrotask(() => child.emit('spawn')); return child; };
  const result = await spawnRescueRunner({ companionPath: COMPANION_ENTRY, workspace: WORKSPACE, jobId: JOB_ID, env: { ...BOUNDED_ENV }, spawnChild });
  assert.deepEqual(result, { pid: 4242 });
  // The adapter keeps an error listener after spawn: two late errors must both
  // be swallowed instead of becoming unhandled parent exceptions, and a later
  // exit must trigger nothing parent-side.
  child.emit('error', Object.assign(new Error('late spawn-path failure'), { code: 'EPIPE' }));
  child.emit('error', new Error('a second late failure'));
  child.emit('exit', 1, null);
  child.emit('exit', 0, null);
  assert.equal(calls.kill, 0, 'the OS spawn adapter must never terminate or terminalize the runner');
  assert.equal(calls.unref, 1);
});

test('an OS spawn error before the spawn event rejects with the bounded translated error', async () => {
  const { child, calls } = fakeChild();
  const raw = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT', errno: -2, syscall: 'spawn' });
  const pending = spawnRescueRunner({ companionPath: COMPANION_ENTRY, workspace: WORKSPACE, jobId: JOB_ID, env: { ...BOUNDED_ENV }, spawnChild: () => child });
  queueMicrotask(() => child.emit('error', raw));
  const outcome = /** @type {any} */ (await pending.then(
    (value) => ({ kind: 'fulfilled', value }),
    (caught) => ({ kind: 'rejected', error: caught }),
  ));
  assert.equal(outcome.kind, 'rejected');
  const error = outcome.error;
  assert.equal(error.name, 'PluginError');
  assert.equal(error.code, 'RESCUE_RUNNER_SPAWN_FAILED');
  assert.notEqual(error, raw);
  assert.equal(error.cause, raw);
  assert.equal(calls.unref, 0, 'a failed launch must never detach');
  // A further error after the rejected launch must stay swallowed too.
  child.emit('error', new Error('late error after rejected launch'));
});

test('a synchronous spawnChild failure rejects with the bounded translated error', async () => {
  const raw = new Error('invalid spawn options');
  const spawnChild = () => { throw raw; };
  await assert.rejects(
    spawnRescueRunner({ companionPath: COMPANION_ENTRY, workspace: WORKSPACE, jobId: JOB_ID, env: { ...BOUNDED_ENV }, spawnChild }),
    (/** @type {any} */ error) => error.name === 'PluginError' && error.code === 'RESCUE_RUNNER_SPAWN_FAILED' && error.cause === raw,
  );
});

test('spawnRescueRunner validates absolute entry, absolute workspace, digest job id, and bounded environment', async () => {
  const base = { companionPath: COMPANION_ENTRY, workspace: WORKSPACE, jobId: JOB_ID, env: { ...BOUNDED_ENV } };
  const invalidInputs = [
    { ...base, companionPath: 'zcode-companion.mjs' },
    { ...base, companionPath: '' },
    { ...base, companionPath: undefined },
    { ...base, workspace: 'relative/workspace' },
    { ...base, workspace: '' },
    { ...base, workspace: undefined },
    { ...base, jobId: 'not-a-digest' },
    { ...base, jobId: 'A'.repeat(64) },
    { ...base, jobId: 'g'.repeat(64) },
    { ...base, jobId: `${JOB_ID}0` },
    { ...base, env: undefined },
    { ...base, env: null },
    { ...base, env: 'bounded' },
    { ...base, spawnChild: 'not-a-function' },
  ];
  for (const input of invalidInputs) {
    await assert.rejects(spawnRescueRunner(/** @type {any} */ (input)), { code: 'RESCUE_RUNNER_INPUT_INVALID' });
  }
});
