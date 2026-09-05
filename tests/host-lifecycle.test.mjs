import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { PluginError } from '../scripts/lib/errors.mjs';
import { withFileLock } from '../scripts/lib/fs.mjs';
import { createHostLifecycleStore, hostLifecycleEpoch, raceAbort, raceAbortHeldWrite } from '../scripts/lib/host-lifecycle.mjs';

const START = '2026-09-02T00:00:00.000Z';
const END = '2026-09-02T02:00:00.000Z';
const LATER = '2026-09-02T03:00:00.000Z';
const RETENTION_MS = 30 * 24 * 60 * 60_000;
const SETTLED_CAP = 512;
const RECEIPTS_CEILING = 4_096;

/** @param {number} [initialTimeMs] */
async function fixture(initialTimeMs = Date.parse('2026-09-02T04:00:00.000Z')) {
  const root = await mkdtemp(join(tmpdir(), 'zcode-host-lifecycle-'));
  const clock = { nowMs: initialTimeMs };
  return {
    root,
    dataRoot: join(root, 'plugin-data'),
    now: () => new Date(clock.nowMs).toISOString(),
    clock,
    workspace: join(root, 'workspace-a'),
    otherWorkspace: join(root, 'workspace-b'),
    /** @param {number} ms */
    advance: (ms) => { clock.nowMs += ms; },
  };
}

/**
 * Installs receipts directly as fixture setup so ceiling-scale scans stay
 * fast; every assertion still runs through the public store interface.
 * @param {{ dataRoot: string }} fixtureState
 * @param {number} count
 * @param {'pending'|'settled'} state
 */
async function installBulkReceipts(fixtureState, count, state) {
  const receiptsRoot = join(fixtureState.dataRoot, 'host-lifecycle', 'receipts');
  await mkdir(receiptsRoot, { recursive: true, mode: 0o700 });
  await chmod(receiptsRoot, 0o700);
  const baseMs = Date.parse('2026-09-01T00:00:00.000Z');
  const epochs = /** @type {string[]} */ (Array.from({ length: count }));
  for (let offset = 0; offset < count; offset += 1_024) {
    await Promise.all(Array.from({ length: Math.min(1_024, count - offset) }, (_, index) => {
      const receiptIndex = offset + index;
      const markAt = new Date(baseMs + receiptIndex).toISOString();
      const sessionId = `session-bulk-${receiptIndex}`;
      const epoch = hostLifecycleEpoch(sessionId, START);
      const receipt = {
        version: 1,
        kind: 'host-session-end',
        sessionId,
        sessionStartedAt: START,
        endedAt: END,
        epoch,
        origin: 'session-end-hook',
        workspaceHints: [],
        state,
        publishedAt: markAt,
        updatedAt: markAt,
        ...(state === 'settled' ? { settledAt: markAt } : {}),
      };
      epochs[receiptIndex] = epoch;
      const path = join(receiptsRoot, `${createHash('sha256').update(epoch).digest('hex')}.json`);
      return writePrivateReceiptFile(path, `${JSON.stringify(receipt, null, 2)}\n`);
    }));
  }
  return epochs;
}

/** Writes fixture receipt files with the private permissions the store enforces. @param {string} path @param {string} contents */
async function writePrivateReceiptFile(path, contents) {
  await writeFile(path, contents, { mode: 0o600 });
  await chmod(path, 0o600);
}

/**
 * Holds an advisory lock deterministically: `acquired` resolves only once the
 * lock is genuinely held, so contended callers cannot win a start-up race.
 * @param {string} lockPath
 */
function holdAdvisoryLock(lockPath) {
  /** @type {() => void} */
  let release = () => {};
  /** @type {() => void} */
  let signalAcquired = () => {};
  const acquired = new Promise((resolve) => { signalAcquired = () => resolve(undefined); });
  const done = withFileLock(lockPath, () => new Promise((resolve) => {
    signalAcquired();
    release = () => resolve(undefined);
  }));
  return { acquired, done, release: () => { release(); } };
}

test('one Host load produces a stable epoch and resume produces a distinct epoch', () => {
  assert.equal(hostLifecycleEpoch('session-a', '2026-09-02T00:00:00.000Z'), hostLifecycleEpoch('session-a', '2026-09-02T00:00:00.000Z'));
  assert.notEqual(hostLifecycleEpoch('session-a', '2026-09-02T00:00:00.000Z'), hostLifecycleEpoch('session-a', '2026-09-02T01:00:00.000Z'));
});

test('the epoch is the specified bounded digest of the domain, session, and start time', () => {
  assert.equal(
    hostLifecycleEpoch('session-a', '2026-09-02T00:00:00.000Z'),
    '37cd729db86dc7591621edfdc5cf360a8e9d5497061d12d1550850a77ddc1aff',
  );
  assert.equal(hostLifecycleEpoch('session-a', START).length, 64);
});

test('epoch derivation rejects invalid session identifiers and timestamps', () => {
  for (const input of [
    ['', START],
    ['session-a', 'not-a-timestamp'],
    ['session-a', '2026-09-02T00:00:00Z'],
    ['has\ncontrol', START],
  ]) assert.throws(() => hostLifecycleEpoch(input[0], input[1]), PluginError);
});

test('receipt creation is first-writer-wins and repeated publication only merges bounded hints', async () => {
  const fixtureState = await fixture();
  const store = createHostLifecycleStore({ dataRoot: fixtureState.dataRoot, now: fixtureState.now });
  const first = await store.publishSessionEnd({ sessionId: 'session-a', sessionStartedAt: START, endedAt: END, origin: 'session-end-hook', workspaceHints: [fixtureState.workspace] });
  const repeated = await store.publishSessionEnd({ sessionId: 'session-a', sessionStartedAt: START, endedAt: LATER, origin: 'resume-compensation', workspaceHints: [fixtureState.otherWorkspace] });
  assert.equal(repeated.endedAt, first.endedAt);
  assert.equal(repeated.origin, 'session-end-hook');
  assert.deepEqual(repeated.workspaceHints, [fixtureState.otherWorkspace, fixtureState.workspace].sort());
});

test('publication is idempotent for an identical repeat and persists the private receipt', async () => {
  const fixtureState = await fixture();
  const store = createHostLifecycleStore({ dataRoot: fixtureState.dataRoot, now: fixtureState.now });
  const input = { sessionId: 'session-a', sessionStartedAt: START, endedAt: END, origin: 'session-end-hook', workspaceHints: [fixtureState.workspace, fixtureState.workspace] };
  const first = await store.publishSessionEnd(input);
  const repeated = await store.publishSessionEnd(input);
  assert.equal(repeated.endedAt, first.endedAt);
  assert.equal(repeated.origin, first.origin);
  assert.deepEqual(repeated.workspaceHints, [fixtureState.workspace]);
  assert.equal(repeated.state, 'pending');
  const persisted = await store.readReceipt(hostLifecycleEpoch('session-a', START));
  assert.equal(persisted.epoch, hostLifecycleEpoch('session-a', START));
  assert.equal(persisted.version, 1);
  assert.equal(persisted.kind, 'host-session-end');
  const stored = JSON.parse(await readFile(persisted.path, 'utf8'));
  assert.equal(stored.state, 'pending');
});

test('publication rejects unknown keys, invalid origins, and malformed timestamps', async () => {
  const fixtureState = await fixture();
  const store = createHostLifecycleStore({ dataRoot: fixtureState.dataRoot, now: fixtureState.now });
  for (const input of [
    { sessionId: 'session-a', sessionStartedAt: START, endedAt: END, origin: 'session-end-hook', workspaceHints: [], unexpected: true },
    { sessionId: 'session-a', sessionStartedAt: START, endedAt: END, origin: 'unknown-origin' },
    { sessionId: 'session-a', sessionStartedAt: START, endedAt: 'yesterday', origin: 'session-end-hook' },
    { sessionStartedAt: START, endedAt: END, origin: 'session-end-hook' },
  ]) await assert.rejects(store.publishSessionEnd(input), PluginError);
});

test('a non-RFC3339 injected clock fails the first publication fast instead of wedging the epoch', async () => {
  const fixtureState = await fixture();
  const broken = createHostLifecycleStore({ dataRoot: fixtureState.dataRoot, now: () => 'not-a-timestamp' });
  await assert.rejects(
    broken.publishSessionEnd({ sessionId: 'session-a', sessionStartedAt: START, endedAt: END, origin: 'session-end-hook' }),
    (error) => error instanceof PluginError && error.code === 'LIFECYCLE_INPUT_INVALID',
  );
  assert.equal(await broken.readReceipt(hostLifecycleEpoch('session-a', START)), null);
  const healthy = createHostLifecycleStore({ dataRoot: fixtureState.dataRoot, now: fixtureState.now });
  const receipt = await healthy.publishSessionEnd({ sessionId: 'session-a', sessionStartedAt: START, endedAt: END, origin: 'session-end-hook' });
  assert.equal((await healthy.readReceipt(receipt.epoch)).state, 'pending');
});

test('a stateful clock that turns invalid after its first call cannot poison the persisted receipt', async () => {
  const fixtureState = await fixture();
  const values = [fixtureState.now(), 'not-a-timestamp'];
  let calls = 0;
  const store = createHostLifecycleStore({ dataRoot: fixtureState.dataRoot, now: () => values[Math.min(calls++, values.length - 1)] });
  const receipt = await store.publishSessionEnd({ sessionId: 'session-a', sessionStartedAt: START, endedAt: END, origin: 'session-end-hook' });
  assert.equal((await store.readReceipt(receipt.epoch)).state, 'pending');
  assert.deepEqual((await store.listPendingReceipts()).map((entry) => entry.epoch), [receipt.epoch]);
});

test('settlement validates the injected clock and refuses to mutate with a non-RFC3339 value', async () => {
  const fixtureState = await fixture();
  const store = createHostLifecycleStore({ dataRoot: fixtureState.dataRoot, now: fixtureState.now });
  const receipt = await store.publishSessionEnd({ sessionId: 'session-a', sessionStartedAt: START, endedAt: END, origin: 'session-end-hook' });
  const broken = createHostLifecycleStore({ dataRoot: fixtureState.dataRoot, now: () => 'not-a-timestamp' });
  await assert.rejects(broken.settleReceipt(receipt.epoch, receipt.updatedAt), (error) => error instanceof PluginError && error.code === 'LIFECYCLE_INPUT_INVALID');
  assert.equal((await store.readReceipt(receipt.epoch)).state, 'pending');
});

test('workspace hints are bounded to 128 canonical entries of at most 4096 UTF-8 bytes', async () => {
  const fixtureState = await fixture();
  const store = createHostLifecycleStore({ dataRoot: fixtureState.dataRoot, now: fixtureState.now });
  await assert.rejects(store.publishSessionEnd({ sessionId: 'session-a', sessionStartedAt: START, endedAt: END, origin: 'session-end-hook', workspaceHints: Array.from({ length: 129 }, (_, index) => join(fixtureState.root, 'w', String(index))) }), PluginError);
  await assert.rejects(store.publishSessionEnd({ sessionId: 'session-a', sessionStartedAt: START, endedAt: END, origin: 'session-end-hook', workspaceHints: [join(fixtureState.root, 'x'.repeat(4_097))] }), PluginError);
  const hintA = join(fixtureState.root, 'w', 'a');
  const hintB = join(fixtureState.root, 'w', 'b');
  const receipt = await store.publishSessionEnd({ sessionId: 'session-a', sessionStartedAt: START, endedAt: END, origin: 'session-end-hook', workspaceHints: [hintB, hintA, hintB] });
  assert.deepEqual(receipt.workspaceHints, [hintA, hintB].sort());
});

test('more than 128 hint entries with duplicates publish while the canonical deduplicated set fits', async () => {
  const fixtureState = await fixture();
  const store = createHostLifecycleStore({ dataRoot: fixtureState.dataRoot, now: fixtureState.now });
  const distinct = Array.from({ length: 100 }, (_, index) => join(fixtureState.root, 'w', String(index).padStart(3, '0')));
  const withDuplicates = [...distinct, ...[...distinct].reverse()];
  const receipt = await store.publishSessionEnd({ sessionId: 'session-a', sessionStartedAt: START, endedAt: END, origin: 'session-end-hook', workspaceHints: withDuplicates });
  assert.deepEqual(receipt.workspaceHints, distinct);
  assert.deepEqual((await store.readReceipt(receipt.epoch)).workspaceHints, distinct);
  await assert.rejects(store.publishSessionEnd({ sessionId: 'session-b', sessionStartedAt: START, endedAt: END, origin: 'session-end-hook', workspaceHints: [...distinct, ...Array.from({ length: 29 }, (_, index) => join(fixtureState.root, 'v', String(index)))] }), PluginError);
});

test('a raw workspace hints array above the hard cap rejects before any traversal or sorting', async () => {
  const fixtureState = await fixture();
  const store = createHostLifecycleStore({ dataRoot: fixtureState.dataRoot, now: fixtureState.now });
  await assert.rejects(
    store.publishSessionEnd({ sessionId: 'session-a', sessionStartedAt: START, endedAt: END, origin: 'session-end-hook', workspaceHints: Array.from({ length: 4_097 }, () => join(fixtureState.root, 'w', 'a')) }),
    (error) => error instanceof PluginError && error.code === 'LIFECYCLE_INPUT_INVALID',
  );
  assert.equal(await store.readReceipt(hostLifecycleEpoch('session-a', START)), null);
});

test('an already-aborted caller with a maximum raw hints array rejects before any storage work', async () => {
  const fixtureState = await fixture();
  const store = createHostLifecycleStore({ dataRoot: fixtureState.dataRoot, now: fixtureState.now });
  const hints = Array.from({ length: 4_096 }, (_, index) => join(fixtureState.root, 'w', String(index % 64)));
  await assert.rejects(
    store.publishSessionEnd({ sessionId: 'session-a', sessionStartedAt: START, endedAt: END, origin: 'session-end-hook', workspaceHints: hints }, { signal: AbortSignal.abort() }),
    /** @type {(error: { name?: string }) => boolean} */ ((error) => error.name === 'AbortError'),
  );
  await assert.rejects(access(join(fixtureState.dataRoot, 'host-lifecycle')), /** @type {(error: { code?: string }) => boolean} */ ((error) => error.code === 'ENOENT'));
});

test('a resume-compensation origin publishes like any other origin', async () => {
  const fixtureState = await fixture();
  const store = createHostLifecycleStore({ dataRoot: fixtureState.dataRoot, now: fixtureState.now });
  const receipt = await store.publishSessionEnd({ sessionId: 'session-b', sessionStartedAt: START, endedAt: END, origin: 'resume-compensation' });
  assert.equal(receipt.origin, 'resume-compensation');
  assert.deepEqual(receipt.workspaceHints, []);
  assert.equal((await store.readReceipt(receipt.epoch)).origin, 'resume-compensation');
});

test('receipts of different lifecycle epochs stay isolated and only pending ones are listed', async () => {
  const fixtureState = await fixture();
  const store = createHostLifecycleStore({ dataRoot: fixtureState.dataRoot, now: fixtureState.now });
  const a = await store.publishSessionEnd({ sessionId: 'session-a', sessionStartedAt: START, endedAt: END, origin: 'session-end-hook' });
  const b = await store.publishSessionEnd({ sessionId: 'session-b', sessionStartedAt: START, endedAt: END, origin: 'session-end-hook' });
  assert.notEqual(a.epoch, b.epoch);
  assert.notEqual(a.path, b.path);
  const epochs = (await store.listPendingReceipts()).map((receipt) => receipt.epoch).sort();
  assert.deepEqual(epochs, [a.epoch, b.epoch].sort());
  fixtureState.advance(1_000);
  const settled = await store.settleReceipt(a.epoch, a.updatedAt);
  assert.equal(settled.state, 'settled');
  assert.equal(settled.settledAt, fixtureState.now());
  assert.deepEqual((await store.listPendingReceipts()).map((receipt) => receipt.epoch), [b.epoch]);
  assert.equal((await store.readReceipt(a.epoch)).state, 'settled');
  assert.equal(await store.readReceipt('f'.repeat(64)), null);
});

test('settling with a stale expectedUpdatedAt fails without weakening the receipt', async () => {
  const fixtureState = await fixture();
  const store = createHostLifecycleStore({ dataRoot: fixtureState.dataRoot, now: fixtureState.now });
  const first = await store.publishSessionEnd({ sessionId: 'session-a', sessionStartedAt: START, endedAt: END, origin: 'session-end-hook' });
  fixtureState.advance(1_000);
  await store.publishSessionEnd({ sessionId: 'session-a', sessionStartedAt: START, endedAt: LATER, origin: 'resume-compensation', workspaceHints: [fixtureState.workspace] });
  await assert.rejects(store.settleReceipt(first.epoch, first.updatedAt), (error) => error instanceof PluginError && error.code === 'RECEIPT_STALE');
  assert.equal((await store.readReceipt(first.epoch)).state, 'pending');
  await assert.rejects(store.settleReceipt('0'.repeat(64), fixtureState.now()), (error) => error instanceof PluginError && error.code === 'RECEIPT_NOT_FOUND');
});

test('pruning removes aged settled receipts but never a pending receipt', async () => {
  const fixtureState = await fixture();
  const store = createHostLifecycleStore({ dataRoot: fixtureState.dataRoot, now: fixtureState.now });
  const oldSettled = await store.publishSessionEnd({ sessionId: 'session-old-settled', sessionStartedAt: START, endedAt: END, origin: 'session-end-hook' });
  await store.settleReceipt(oldSettled.epoch, oldSettled.updatedAt);
  fixtureState.advance(RETENTION_MS + 60_000);
  const fresh = await store.publishSessionEnd({ sessionId: 'session-fresh', sessionStartedAt: START, endedAt: END, origin: 'session-end-hook' });
  await store.settleReceipt(fresh.epoch, fresh.updatedAt);
  const oldPending = await store.publishSessionEnd({ sessionId: 'session-old-pending', sessionStartedAt: START, endedAt: END, origin: 'session-end-hook' });
  await store.pruneSettledReceipts();
  assert.equal((await store.readReceipt(fresh.epoch)).state, 'settled');
  assert.equal(await store.readReceipt(oldSettled.epoch), null);
  assert.equal((await store.readReceipt(oldPending.epoch)).state, 'pending');
});

test('pruning caps settled receipts at the newest 512 while retaining every pending receipt', async (t) => {
  const fixtureState = await fixture();
  t.after(() => rm(fixtureState.root, { recursive: true, force: true }));
  const store = createHostLifecycleStore({ dataRoot: fixtureState.dataRoot, now: fixtureState.now });
  // Settled receipts are installed directly, ascending settledAt in array
  // order, so the test measures the cap itself rather than 514 sequential
  // publication and settlement cycles.
  const total = SETTLED_CAP + 2;
  const settledEpochs = await installBulkReceipts(fixtureState, total, 'settled');
  const pending = await store.publishSessionEnd({ sessionId: 'session-cap-pending', sessionStartedAt: START, endedAt: END, origin: 'session-end-hook' });
  await store.pruneSettledReceipts();
  for (const epoch of settledEpochs.slice(0, total - SETTLED_CAP)) assert.equal(await store.readReceipt(epoch), null, epoch);
  for (const epoch of settledEpochs.slice(total - SETTLED_CAP)) assert.equal((await store.readReceipt(epoch)).state, 'settled', epoch);
  assert.equal((await store.readReceipt(pending.epoch)).state, 'pending');
});

test('publication honors the caller-supplied abort budget', async () => {
  const fixtureState = await fixture();
  const store = createHostLifecycleStore({ dataRoot: fixtureState.dataRoot, now: fixtureState.now });
  const aborted = AbortSignal.abort();
  await assert.rejects(
    store.publishSessionEnd({ sessionId: 'session-a', sessionStartedAt: START, endedAt: END, origin: 'session-end-hook' }, { signal: aborted }),
    () => true,
  );
  await assert.rejects(store.listPendingReceipts({ signal: aborted }), () => true);
  assert.equal(await store.readReceipt(hostLifecycleEpoch('session-a', START)), null);
});

test('an unsafe receipts directory fails closed instead of reporting no receipts', async () => {
  const fixtureState = await fixture();
  await mkdir(join(fixtureState.dataRoot, 'host-lifecycle'), { recursive: true });
  const elsewhere = join(fixtureState.root, 'elsewhere');
  await mkdir(elsewhere);
  await symlink(elsewhere, join(fixtureState.dataRoot, 'host-lifecycle', 'receipts'));
  const store = createHostLifecycleStore({ dataRoot: fixtureState.dataRoot, now: fixtureState.now });
  await assert.rejects(store.listPendingReceipts(), (error) => error instanceof PluginError && error.code === 'PRIVATE_PATH_UNSAFE');
  await assert.rejects(store.pruneSettledReceipts(), (error) => error instanceof PluginError && error.code === 'PRIVATE_PATH_UNSAFE');
});

test('a symlinked data root with no receipts directory fails closed instead of reporting no receipts', async () => {
  const fixtureState = await fixture();
  const outside = join(fixtureState.root, 'outside-root');
  await mkdir(outside, { recursive: true });
  await symlink(outside, fixtureState.dataRoot);
  const store = createHostLifecycleStore({ dataRoot: fixtureState.dataRoot, now: fixtureState.now });
  await assert.rejects(store.listPendingReceipts(), (error) => error instanceof PluginError && error.code === 'PRIVATE_PATH_UNSAFE');
  await assert.rejects(store.pruneSettledReceipts(), (error) => error instanceof PluginError && error.code === 'PRIVATE_PATH_UNSAFE');
  await assert.rejects(store.readReceipt(hostLifecycleEpoch('session-a', START)), (error) => error instanceof PluginError && error.code === 'PRIVATE_PATH_UNSAFE');
});

test('a symlinked host-lifecycle directory fails closed instead of reporting absence', async () => {
  const fixtureState = await fixture();
  await mkdir(fixtureState.dataRoot, { recursive: true });
  const elsewhere = join(fixtureState.root, 'elsewhere-lifecycle');
  await mkdir(elsewhere, { recursive: true });
  await symlink(elsewhere, join(fixtureState.dataRoot, 'host-lifecycle'));
  const store = createHostLifecycleStore({ dataRoot: fixtureState.dataRoot, now: fixtureState.now });
  await assert.rejects(store.readReceipt(hostLifecycleEpoch('session-a', START)), (error) => error instanceof PluginError && error.code === 'PRIVATE_PATH_UNSAFE');
  await assert.rejects(store.listPendingReceipts(), (error) => error instanceof PluginError && error.code === 'PRIVATE_PATH_UNSAFE');
  assert.deepEqual(await readdir(elsewhere), []);
});

test('a host-lifecycle symlink redirecting to a populated in-root directory fails closed', async () => {
  const fixtureState = await fixture();
  // A populated receipts namespace already sits inside the data root, so the
  // redirected scan and read paths see ordinary directories post-traversal
  // and realpath containment still holds.
  const backupStore = createHostLifecycleStore({ dataRoot: join(fixtureState.dataRoot, 'backup'), now: fixtureState.now });
  await backupStore.publishSessionEnd({ sessionId: 'session-a', sessionStartedAt: START, endedAt: END, origin: 'session-end-hook' });
  await symlink(join(fixtureState.dataRoot, 'backup', 'host-lifecycle'), join(fixtureState.dataRoot, 'host-lifecycle'));
  const store = createHostLifecycleStore({ dataRoot: fixtureState.dataRoot, now: fixtureState.now });
  await assert.rejects(store.readReceipt(hostLifecycleEpoch('session-a', START)), (error) => error instanceof PluginError && error.code === 'PRIVATE_PATH_UNSAFE');
  await assert.rejects(store.listPendingReceipts(), (error) => error instanceof PluginError && error.code === 'PRIVATE_PATH_UNSAFE');
  await assert.rejects(store.publishSessionEnd({ sessionId: 'session-b', sessionStartedAt: START, endedAt: END, origin: 'session-end-hook' }), (error) => error instanceof PluginError && error.code === 'PRIVATE_PATH_UNSAFE');
});

test('a maximum-size valid receipt with escaping-heavy hints remains readable', async () => {
  const fixtureState = await fixture();
  const store = createHostLifecycleStore({ dataRoot: fixtureState.dataRoot, now: fixtureState.now });
  const escapingHint = join(fixtureState.root, '"'.repeat(3_950));
  const hints = Array.from({ length: 128 }, (_, index) => `${escapingHint}-${index}`);
  const receipt = await store.publishSessionEnd({ sessionId: 'session-wide', sessionStartedAt: START, endedAt: END, origin: 'session-end-hook', workspaceHints: hints });
  const read = await store.readReceipt(receipt.epoch);
  assert.equal(read.workspaceHints.length, 128);
  const pending = await store.listPendingReceipts();
  assert.deepEqual(pending.map((entry) => entry.epoch), [receipt.epoch]);
});

test('repeated publication caps merged hints at the bounded maximum', async () => {
  const fixtureState = await fixture();
  const store = createHostLifecycleStore({ dataRoot: fixtureState.dataRoot, now: fixtureState.now });
  const firstHints = Array.from({ length: 128 }, (_, index) => join(fixtureState.root, 'first', String(index)));
  const secondHints = Array.from({ length: 128 }, (_, index) => join(fixtureState.root, 'second', String(index)));
  await store.publishSessionEnd({ sessionId: 'session-a', sessionStartedAt: START, endedAt: END, origin: 'session-end-hook', workspaceHints: firstHints });
  const merged = await store.publishSessionEnd({ sessionId: 'session-a', sessionStartedAt: START, endedAt: LATER, origin: 'resume-compensation', workspaceHints: secondHints });
  const canonicalUnion = [...new Set([...firstHints, ...secondHints])].sort();
  assert.equal(merged.workspaceHints.length, 128);
  assert.deepEqual(merged.workspaceHints, canonicalUnion.slice(0, 128));
  assert.deepEqual((await store.readReceipt(merged.epoch)).workspaceHints, canonicalUnion.slice(0, 128));
});

test('persisted receipts with non-canonical hints are rejected as corrupt', async () => {
  const fixtureState = await fixture();
  const store = createHostLifecycleStore({ dataRoot: fixtureState.dataRoot, now: fixtureState.now });
  const receipt = await store.publishSessionEnd({ sessionId: 'session-a', sessionStartedAt: START, endedAt: END, origin: 'session-end-hook', workspaceHints: [join(fixtureState.root, 'w', 'a')] });
  for (const hints of [['ok', 'bad\ncontrol'], [''], ['x'.repeat(4_097)]]) {
    const stored = JSON.parse(await readFile(receipt.path, 'utf8'));
    stored.workspaceHints = hints;
    await writeFile(receipt.path, `${JSON.stringify(stored, null, 2)}\n`);
    await assert.rejects(store.readReceipt(receipt.epoch), (error) => error instanceof PluginError && error.code === 'RECEIPT_CORRUPT', JSON.stringify(hints));
  }
});

test('a clean caller signal still receives the bounded local abort budget', async () => {
  const fixtureState = await fixture();
  const store = createHostLifecycleStore({ dataRoot: fixtureState.dataRoot, now: fixtureState.now });
  const receipt = await store.publishSessionEnd({ sessionId: 'session-a', sessionStartedAt: START, endedAt: END, origin: 'session-end-hook' });
  const receiptsRoot = dirname(receipt.path);
  const lockDirectory = (await readdir(receiptsRoot, { withFileTypes: true }))
    .find((entry) => entry.isDirectory() && entry.name.endsWith('.lock'));
  assert.notEqual(lockDirectory, undefined);
  const held = holdAdvisoryLock(join(receiptsRoot, /** @type {string} */ (lockDirectory?.name)));
  await held.acquired;
  const startedAt = Date.now();
  await assert.rejects(store.publishSessionEnd(
    { sessionId: 'session-a', sessionStartedAt: START, endedAt: LATER, origin: 'resume-compensation' },
    { signal: new AbortController().signal },
  ));
  assert.equal(Date.now() - startedAt < 3_000, true);
  held.release();
  await held.done;
});

test('settlement honors a caller-supplied abort signal during lock contention', async () => {
  const fixtureState = await fixture();
  const store = createHostLifecycleStore({ dataRoot: fixtureState.dataRoot, now: fixtureState.now });
  const receipt = await store.publishSessionEnd({ sessionId: 'session-a', sessionStartedAt: START, endedAt: END, origin: 'session-end-hook' });
  const lockDirectory = (await readdir(dirname(receipt.path), { withFileTypes: true }))
    .find((entry) => entry.isDirectory() && entry.name.endsWith('.lock'));
  assert.notEqual(lockDirectory, undefined);
  const held = holdAdvisoryLock(join(dirname(receipt.path), /** @type {string} */ (lockDirectory?.name)));
  await held.acquired;
  const controller = new AbortController();
  const reason = new Error('session-end budget exhausted');
  setTimeout(() => controller.abort(reason), 50);
  const startedAt = Date.now();
  await assert.rejects(
    store.settleReceipt(receipt.epoch, receipt.updatedAt, { signal: controller.signal }),
    (error) => error === reason,
  );
  assert.equal(Date.now() - startedAt < 400, true, 'settlement must reject at the caller deadline, well inside the local 500ms budget');
  held.release();
  await held.done;
});

test('the settlement token changes on every mutation even within one millisecond', async () => {
  const fixtureState = await fixture();
  const store = createHostLifecycleStore({ dataRoot: fixtureState.dataRoot, now: fixtureState.now });
  const first = await store.publishSessionEnd({ sessionId: 'session-a', sessionStartedAt: START, endedAt: END, origin: 'session-end-hook', workspaceHints: [join(fixtureState.root, 'w', 'a')] });
  const merged = await store.publishSessionEnd({ sessionId: 'session-a', sessionStartedAt: START, endedAt: LATER, origin: 'resume-compensation', workspaceHints: [join(fixtureState.root, 'w', 'b')] });
  assert.notEqual(merged.updatedAt, first.updatedAt);
  await assert.rejects(store.settleReceipt(merged.epoch, first.updatedAt), (error) => error instanceof PluginError && error.code === 'RECEIPT_STALE');
  const settled = await store.settleReceipt(merged.epoch, merged.updatedAt);
  assert.equal(settled.state, 'settled');
  assert.equal((await store.readReceipt(merged.epoch)).state, 'settled');
});

test('retained lock directories cannot exhaust receipt enumeration', async (t) => {
  const fixtureState = await fixture();
  t.after(() => rm(fixtureState.root, { recursive: true, force: true }));
  const store = createHostLifecycleStore({ dataRoot: fixtureState.dataRoot, now: fixtureState.now });
  const receipt = await store.publishSessionEnd({ sessionId: 'session-a', sessionStartedAt: START, endedAt: END, origin: 'session-end-hook' });
  const receiptsRoot = dirname(receipt.path);
  for (let index = 0; index < 4_200; index += 1) {
    await mkdir(join(receiptsRoot, `${index.toString(16)}.lock`));
  }
  assert.deepEqual((await store.listPendingReceipts()).map((entry) => entry.epoch), [receipt.epoch]);
  assert.deepEqual(await store.pruneSettledReceipts(), { pruned: 0 });
  assert.equal((await store.readReceipt(receipt.epoch)).state, 'pending');
});

test('persisted hints must already be canonical when read back', async () => {
  const fixtureState = await fixture();
  const store = createHostLifecycleStore({ dataRoot: fixtureState.dataRoot, now: fixtureState.now });
  const hintA = join(fixtureState.root, 'w', 'a');
  const hintB = join(fixtureState.root, 'w', 'b');
  const receipt = await store.publishSessionEnd({ sessionId: 'session-a', sessionStartedAt: START, endedAt: END, origin: 'session-end-hook', workspaceHints: [hintA] });
  for (const hints of [[hintB, hintA], [hintA, hintA]]) {
    const stored = JSON.parse(await readFile(receipt.path, 'utf8'));
    stored.workspaceHints = hints;
    await writeFile(receipt.path, `${JSON.stringify(stored, null, 2)}\n`);
    await assert.rejects(store.readReceipt(receipt.epoch), (error) => error instanceof PluginError && error.code === 'RECEIPT_CORRUPT', JSON.stringify(hints));
  }
});

test('pruning recovers a receipts directory above the bounded receipt ceiling', async (t) => {
  const fixtureState = await fixture();
  t.after(() => rm(fixtureState.root, { recursive: true, force: true }));
  const store = createHostLifecycleStore({ dataRoot: fixtureState.dataRoot, now: fixtureState.now });
  const epochs = await installBulkReceipts(fixtureState, RECEIPTS_CEILING + 1, 'settled');
  await assert.rejects(store.listPendingReceipts(), (error) => error instanceof PluginError && error.code === 'RECEIPTS_DIRECTORY_EXHAUSTED');
  // A single prune call's deletion loop is bounded by the scan-level
  // deadline, so recovery drains across repeated maintenance calls whose
  // truthful per-call counts sum up to the full excess.
  let pruned = 0;
  for (;;) {
    const result = await store.pruneSettledReceipts();
    pruned += result.pruned;
    if (result.pruned === 0) break;
  }
  assert.equal(pruned, epochs.length - SETTLED_CAP);
  assert.equal(await store.readReceipt(epochs[0]), null);
  assert.equal((await store.readReceipt(epochs[epochs.length - 1])).state, 'settled');
  assert.deepEqual(await store.listPendingReceipts(), []);
});

test('an abort signal firing mid-scan stops enumeration instead of returning success', async (t) => {
  const fixtureState = await fixture();
  t.after(() => rm(fixtureState.root, { recursive: true, force: true }));
  const store = createHostLifecycleStore({ dataRoot: fixtureState.dataRoot, now: fixtureState.now });
  await installBulkReceipts(fixtureState, RECEIPTS_CEILING + 1, 'settled');
  const controller = new AbortController();
  const reason = new Error('mid-scan budget exhausted');
  setTimeout(() => controller.abort(reason), 50);
  await assert.rejects(store.listPendingReceipts({ signal: controller.signal }), (error) => error === reason);
});

test('pruning skips a contended receipt, removes the others, and stays deletable later', async () => {
  const fixtureState = await fixture();
  const store = createHostLifecycleStore({ dataRoot: fixtureState.dataRoot, now: fixtureState.now });
  const first = await store.publishSessionEnd({ sessionId: 'session-a', sessionStartedAt: START, endedAt: END, origin: 'session-end-hook' });
  await store.settleReceipt(first.epoch, first.updatedAt);
  const second = await store.publishSessionEnd({ sessionId: 'session-b', sessionStartedAt: START, endedAt: END, origin: 'session-end-hook' });
  await store.settleReceipt(second.epoch, second.updatedAt);
  fixtureState.advance(RETENTION_MS + 60_000);
  const lockPath = join(dirname(first.path), `${createHash('sha256').update(first.epoch).digest('hex')}.lock`);
  const held = holdAdvisoryLock(lockPath);
  await held.acquired;
  assert.deepEqual(await store.pruneSettledReceipts(), { pruned: 1 });
  assert.equal((await store.readReceipt(first.epoch)).state, 'settled');
  assert.equal(await store.readReceipt(second.epoch), null);
  held.release();
  await held.done;
  assert.deepEqual(await store.pruneSettledReceipts(), { pruned: 1 });
  assert.equal(await store.readReceipt(first.epoch), null);
});

test('a contended deletion loop yields to the scan-level deadline instead of summing per-file waits', async (t) => {
  const fixtureState = await fixture();
  t.after(() => rm(fixtureState.root, { recursive: true, force: true }));
  const store = createHostLifecycleStore({ dataRoot: fixtureState.dataRoot, now: fixtureState.now, testOnlyPruneScanBudgetMs: 400 });
  const epochs = await installBulkReceipts(fixtureState, 4, 'settled');
  fixtureState.advance(RETENTION_MS + 60_000);
  const receiptsRoot = join(fixtureState.dataRoot, 'host-lifecycle', 'receipts');
  const holders = epochs.map((epoch) => holdAdvisoryLock(join(receiptsRoot, `${createHash('sha256').update(epoch).digest('hex')}.lock`)));
  await Promise.all(holders.map((holder) => holder.acquired));
  const startedAt = Date.now();
  const result = await store.pruneSettledReceipts();
  const elapsed = Date.now() - startedAt;
  assert.deepEqual(result, { pruned: 0 });
  assert.equal(elapsed < 1_200, true, `prune took ${elapsed}ms; the scan-level deadline must bound the contended deletion loop`);
  for (const holder of holders) holder.release();
  await Promise.all(holders.map((holder) => holder.done));
});

test('identical repeated publication is a no-op that preserves the settlement token', async () => {
  const fixtureState = await fixture();
  const store = createHostLifecycleStore({ dataRoot: fixtureState.dataRoot, now: fixtureState.now });
  const hintA = join(fixtureState.root, 'w', 'a');
  const hintB = join(fixtureState.root, 'w', 'b');
  const input = { sessionId: 'session-a', sessionStartedAt: START, endedAt: END, origin: 'session-end-hook', workspaceHints: [hintA, hintB] };
  const first = await store.publishSessionEnd(input);
  const repeated = await store.publishSessionEnd(input);
  assert.equal(repeated.updatedAt, first.updatedAt);
  const subset = await store.publishSessionEnd({ ...input, workspaceHints: [hintA] });
  assert.equal(subset.updatedAt, first.updatedAt);
  assert.deepEqual(subset.workspaceHints, [hintA, hintB]);
  const settled = await store.settleReceipt(first.epoch, first.updatedAt);
  assert.equal(settled.state, 'settled');
});

test('a receipt stored under a mismatched filename is inert', async () => {
  const fixtureState = await fixture();
  const store = createHostLifecycleStore({ dataRoot: fixtureState.dataRoot, now: fixtureState.now });
  const receipt = await store.publishSessionEnd({ sessionId: 'session-a', sessionStartedAt: START, endedAt: END, origin: 'session-end-hook' });
  const stored = await readFile(receipt.path, 'utf8');
  await writePrivateReceiptFile(join(dirname(receipt.path), `${'0'.repeat(64)}.json`), stored);
  assert.deepEqual((await store.listPendingReceipts()).map((entry) => entry.epoch), [receipt.epoch]);
  assert.deepEqual(await store.pruneSettledReceipts(), { pruned: 0 });
  assert.equal((await store.readReceipt(receipt.epoch)).state, 'pending');
});

test('ceiling-scale enumeration observes the abort signal mid-scan', async (t) => {
  const fixtureState = await fixture();
  t.after(() => rm(fixtureState.root, { recursive: true, force: true }));
  const store = createHostLifecycleStore({ dataRoot: fixtureState.dataRoot, now: fixtureState.now, testOnlyReceiptsDirectoryMaxEntries: 4_096 });
  const receiptsRoot = join(fixtureState.dataRoot, 'host-lifecycle', 'receipts');
  await mkdir(receiptsRoot, { recursive: true });
  const total = 20_000;
  for (let offset = 0; offset < total; offset += 1_024) {
    await Promise.all(Array.from({ length: Math.min(1_024, total - offset) }, (_, index) => mkdir(join(receiptsRoot, `e${offset + index}`))));
  }
  const controller = new AbortController();
  const reason = new Error('enumeration budget exhausted');
  setTimeout(() => controller.abort(reason), 5);
  await assert.rejects(store.listPendingReceipts({ signal: controller.signal }), (error) => error === reason);
});

test('a later publication never evicts an already-persisted hint', async () => {
  const fixtureState = await fixture();
  const store = createHostLifecycleStore({ dataRoot: fixtureState.dataRoot, now: fixtureState.now });
  const full = Array.from({ length: 128 }, (_, index) => join(fixtureState.root, 'w', String(index).padStart(3, '0')));
  await store.publishSessionEnd({ sessionId: 'session-a', sessionStartedAt: START, endedAt: END, origin: 'session-end-hook', workspaceHints: full });
  const merged = await store.publishSessionEnd({ sessionId: 'session-a', sessionStartedAt: START, endedAt: LATER, origin: 'resume-compensation', workspaceHints: [join(fixtureState.root, 'w', '0000')] });
  assert.deepEqual(merged.workspaceHints, full);
  assert.deepEqual((await store.readReceipt(merged.epoch)).workspaceHints, full);
  const partial = Array.from({ length: 127 }, (_, index) => join(fixtureState.root, 'v', String(index).padStart(3, '0')));
  await store.publishSessionEnd({ sessionId: 'session-b', sessionStartedAt: START, endedAt: END, origin: 'session-end-hook', workspaceHints: partial });
  const newHint = join(fixtureState.root, 'v', 'new');
  const grown = await store.publishSessionEnd({ sessionId: 'session-b', sessionStartedAt: START, endedAt: LATER, origin: 'resume-compensation', workspaceHints: [newHint] });
  assert.deepEqual(grown.workspaceHints, [...partial, newHint].sort());
});

test('only digest-shaped receipt filenames are parsed; corrupt correctly-named files still fail closed', async () => {
  const fixtureState = await fixture();
  const store = createHostLifecycleStore({ dataRoot: fixtureState.dataRoot, now: fixtureState.now });
  const receipt = await store.publishSessionEnd({ sessionId: 'session-a', sessionStartedAt: START, endedAt: END, origin: 'session-end-hook' });
  const receiptsRoot = dirname(receipt.path);
  await writeFile(join(receiptsRoot, 'not-a-digest.json'), '{ this is not json');
  assert.deepEqual((await store.listPendingReceipts()).map((entry) => entry.epoch), [receipt.epoch]);
  const correctName = `${createHash('sha256').update(hostLifecycleEpoch('session-bad', START)).digest('hex')}.json`;
  await writePrivateReceiptFile(join(receiptsRoot, correctName), `${JSON.stringify({ version: 1 })}\n`);
  await assert.rejects(store.listPendingReceipts(), (error) => error instanceof PluginError && error.code === 'RECEIPT_CORRUPT');
});

test('workspace hints must be canonical absolute normalized paths', async () => {
  const fixtureState = await fixture();
  const store = createHostLifecycleStore({ dataRoot: fixtureState.dataRoot, now: fixtureState.now });
  for (const hints of [['relative/path'], ['/w/../a'], ['/w/./a'], ['/w//a'], ['/w/a/'], ['.', '..']]) {
    await assert.rejects(store.publishSessionEnd({ sessionId: 'session-a', sessionStartedAt: START, endedAt: END, origin: 'session-end-hook', workspaceHints: hints }), PluginError, JSON.stringify(hints));
  }
  const receipt = await store.publishSessionEnd({ sessionId: 'session-a', sessionStartedAt: START, endedAt: END, origin: 'session-end-hook', workspaceHints: [fixtureState.workspace] });
  const stored = JSON.parse(await readFile(receipt.path, 'utf8'));
  stored.workspaceHints = [fixtureState.workspace, 'relative/path'];
  await writeFile(receipt.path, `${JSON.stringify(stored, null, 2)}\n`);
  await assert.rejects(store.readReceipt(receipt.epoch), (error) => error instanceof PluginError && error.code === 'RECEIPT_CORRUPT');
});

test('endedAt cannot precede sessionStartedAt', async () => {
  const fixtureState = await fixture();
  const store = createHostLifecycleStore({ dataRoot: fixtureState.dataRoot, now: fixtureState.now });
  await assert.rejects(store.publishSessionEnd({ sessionId: 'session-a', sessionStartedAt: START, endedAt: '2026-09-01T00:00:00.000Z', origin: 'session-end-hook' }), PluginError);
  const receipt = await store.publishSessionEnd({ sessionId: 'session-b', sessionStartedAt: START, endedAt: END, origin: 'session-end-hook' });
  const stored = JSON.parse(await readFile(receipt.path, 'utf8'));
  stored.endedAt = '2026-09-01T00:00:00.000Z';
  await writeFile(receipt.path, `${JSON.stringify(stored, null, 2)}\n`);
  await assert.rejects(store.readReceipt(receipt.epoch), (error) => error instanceof PluginError && error.code === 'RECEIPT_CORRUPT');
});

test('pending receipts stay discoverable and settleable above the settled ceiling', async (t) => {
  const fixtureState = await fixture();
  t.after(() => rm(fixtureState.root, { recursive: true, force: true }));
  const store = createHostLifecycleStore({ dataRoot: fixtureState.dataRoot, now: fixtureState.now });
  await installBulkReceipts(fixtureState, RECEIPTS_CEILING + 1, 'pending');
  const pending = await store.listPendingReceipts();
  assert.equal(pending.length, RECEIPTS_CEILING + 1);
  const settled = await store.settleReceipt(pending[0].epoch, pending[0].updatedAt);
  assert.equal(settled.state, 'settled');
  assert.equal((await store.listPendingReceipts()).length, RECEIPTS_CEILING);
});

test('a symlinked receipts directory fails before any mutation outside the private root', async () => {
  const fixtureState = await fixture();
  await mkdir(join(fixtureState.dataRoot, 'host-lifecycle'), { recursive: true });
  const outside = join(fixtureState.root, 'outside');
  await mkdir(outside);
  await symlink(outside, join(fixtureState.dataRoot, 'host-lifecycle', 'receipts'));
  const store = createHostLifecycleStore({ dataRoot: fixtureState.dataRoot, now: fixtureState.now });
  await assert.rejects(store.publishSessionEnd({ sessionId: 'session-a', sessionStartedAt: START, endedAt: END, origin: 'session-end-hook' }), (error) => error instanceof PluginError && error.code === 'PRIVATE_PATH_UNSAFE');
  assert.deepEqual(await readdir(outside), []);
});

test('receipt files with drifted permissions are rejected on read', async () => {
  const fixtureState = await fixture();
  const store = createHostLifecycleStore({ dataRoot: fixtureState.dataRoot, now: fixtureState.now });
  const receipt = await store.publishSessionEnd({ sessionId: 'session-a', sessionStartedAt: START, endedAt: END, origin: 'session-end-hook' });
  await chmod(receipt.path, 0o644);
  await assert.rejects(store.readReceipt(receipt.epoch), (error) => error instanceof PluginError && error.code === 'PRIVATE_PATH_UNSAFE');
  await assert.rejects(store.listPendingReceipts(), (error) => error instanceof PluginError && error.code === 'PRIVATE_PATH_UNSAFE');
});

test('a receipts directory swapped for a symlink after validation fails before any outside mutation', async () => {
  const fixtureState = await fixture();
  const outside = join(fixtureState.root, 'outside');
  await mkdir(outside);
  const store = createHostLifecycleStore({
    dataRoot: fixtureState.dataRoot,
    now: fixtureState.now,
    testOnlyAfterStorageValidation: async () => {
      const receiptsRoot = join(fixtureState.dataRoot, 'host-lifecycle', 'receipts');
      await rename(receiptsRoot, join(fixtureState.root, 'receipts-moved'));
      await symlink(outside, receiptsRoot);
    },
  });
  await assert.rejects(store.publishSessionEnd({ sessionId: 'session-a', sessionStartedAt: START, endedAt: END, origin: 'session-end-hook' }), (error) => error instanceof PluginError && error.code === 'PRIVATE_PATH_UNSAFE');
  assert.deepEqual(await readdir(outside), []);
});

test('an aborted caller performs no storage setup mutations', async () => {
  const fixtureState = await fixture();
  const store = createHostLifecycleStore({ dataRoot: fixtureState.dataRoot, now: fixtureState.now });
  await assert.rejects(store.publishSessionEnd({ sessionId: 'session-a', sessionStartedAt: START, endedAt: END, origin: 'session-end-hook' }, { signal: AbortSignal.abort() }), () => true);
  await assert.rejects(access(join(fixtureState.dataRoot, 'host-lifecycle')), /** @type {(error: { code?: string }) => boolean} */ ((error) => error.code === 'ENOENT'));
});

test('a receipt restored under another epoch digest is rejected for that epoch', async () => {
  const fixtureState = await fixture();
  const store = createHostLifecycleStore({ dataRoot: fixtureState.dataRoot, now: fixtureState.now });
  const a = await store.publishSessionEnd({ sessionId: 'session-a', sessionStartedAt: START, endedAt: END, origin: 'session-end-hook' });
  const epochB = hostLifecycleEpoch('session-b', START);
  const misplacedPath = join(dirname(a.path), `${createHash('sha256').update(epochB).digest('hex')}.json`);
  await writePrivateReceiptFile(misplacedPath, await readFile(a.path, 'utf8'));
  await assert.rejects(store.readReceipt(epochB), (error) => error instanceof PluginError && error.code === 'RECEIPT_CORRUPT');
  await assert.rejects(store.settleReceipt(epochB, a.updatedAt), (error) => error instanceof PluginError && error.code === 'RECEIPT_CORRUPT');
  await assert.rejects(store.publishSessionEnd({ sessionId: 'session-b', sessionStartedAt: START, endedAt: END, origin: 'session-end-hook' }), (error) => error instanceof PluginError && error.code === 'RECEIPT_CORRUPT');
  assert.equal((await store.readReceipt(a.epoch)).state, 'pending');
  assert.deepEqual((await store.listPendingReceipts()).map((entry) => entry.epoch), [a.epoch]);
});

test('malformed receipt JSON fails closed as a bounded corrupt error', async () => {
  const fixtureState = await fixture();
  const store = createHostLifecycleStore({ dataRoot: fixtureState.dataRoot, now: fixtureState.now });
  const receipt = await store.publishSessionEnd({ sessionId: 'session-a', sessionStartedAt: START, endedAt: END, origin: 'session-end-hook' });
  await writeFile(receipt.path, '{"version": 1, "kind":');
  await assert.rejects(store.readReceipt(receipt.epoch), (error) => error instanceof PluginError && error.code === 'RECEIPT_CORRUPT');
  await assert.rejects(store.listPendingReceipts(), (error) => error instanceof PluginError && error.code === 'RECEIPT_CORRUPT');
});

test('settled receipts must carry trustworthy settled timestamps', async () => {
  const fixtureState = await fixture();
  const store = createHostLifecycleStore({ dataRoot: fixtureState.dataRoot, now: fixtureState.now });
  const receipt = await store.publishSessionEnd({ sessionId: 'session-a', sessionStartedAt: START, endedAt: END, origin: 'session-end-hook' });
  fixtureState.advance(1_000);
  await store.settleReceipt(receipt.epoch, receipt.updatedAt);
  /** @type {((stored: { settledAt: string, updatedAt: string }) => void)[]} */
  const mutations = [
    // settledAt before publishedAt breaks the lower bound.
    (stored) => { stored.settledAt = '2026-08-01T00:00:00.000Z'; stored.updatedAt = '2026-08-01T00:00:00.000Z'; },
    // settledAt after updatedAt breaks the upper bound; settledAt < updatedAt
    // is the legitimate post-merge shape and must stay readable.
    (stored) => { stored.settledAt = '2026-09-02T06:00:00.000Z'; },
  ];
  for (const mutate of mutations) {
    const stored = JSON.parse(await readFile(receipt.path, 'utf8'));
    mutate(stored);
    await writeFile(receipt.path, `${JSON.stringify(stored, null, 2)}\n`);
    await assert.rejects(store.readReceipt(receipt.epoch), (error) => error instanceof PluginError && error.code === 'RECEIPT_CORRUPT');
  }
});

test('republishing a settled receipt with a new hint preserves the original settledAt', async () => {
  const fixtureState = await fixture();
  const store = createHostLifecycleStore({ dataRoot: fixtureState.dataRoot, now: fixtureState.now });
  const hintA = join(fixtureState.root, 'w', 'a');
  const hintB = join(fixtureState.root, 'w', 'b');
  const receipt = await store.publishSessionEnd({ sessionId: 'session-a', sessionStartedAt: START, endedAt: END, origin: 'session-end-hook', workspaceHints: [hintA] });
  fixtureState.advance(1_000);
  const settled = await store.settleReceipt(receipt.epoch, receipt.updatedAt);
  fixtureState.advance(1_000);
  const merged = await store.publishSessionEnd({ sessionId: 'session-a', sessionStartedAt: START, endedAt: LATER, origin: 'resume-compensation', workspaceHints: [hintB] });
  assert.equal(merged.state, 'settled');
  assert.equal(merged.settledAt, settled.settledAt, 'the original settlement timestamp must be preserved');
  assert.equal(Date.parse(merged.updatedAt) > Date.parse(settled.updatedAt), true, 'only the CAS token advances');
  assert.deepEqual(merged.workspaceHints, [hintA, hintB]);
  const read = await store.readReceipt(merged.epoch);
  assert.equal(read.state, 'settled');
  assert.equal(read.settledAt, settled.settledAt);
  assert.deepEqual(await store.listPendingReceipts(), []);
  assert.deepEqual(await store.pruneSettledReceipts(), { pruned: 0 });
});

test('an aged settled receipt republished with a new hint is still pruned as aged', async () => {
  const fixtureState = await fixture();
  const store = createHostLifecycleStore({ dataRoot: fixtureState.dataRoot, now: fixtureState.now });
  const hintA = join(fixtureState.root, 'w', 'a');
  const hintB = join(fixtureState.root, 'w', 'b');
  const receipt = await store.publishSessionEnd({ sessionId: 'session-aged', sessionStartedAt: START, endedAt: END, origin: 'session-end-hook', workspaceHints: [hintA] });
  const settled = await store.settleReceipt(receipt.epoch, receipt.updatedAt);
  // Age the receipt past retention, then merge a new hint "today": the merge
  // advances updatedAt but must not restart the retention window, which keys
  // on the original settlement.
  fixtureState.advance(RETENTION_MS + 60_000);
  const merged = await store.publishSessionEnd({ sessionId: 'session-aged', sessionStartedAt: START, endedAt: LATER, origin: 'resume-compensation', workspaceHints: [hintB] });
  assert.equal(merged.settledAt, settled.settledAt);
  assert.equal(Date.parse(merged.updatedAt) > Date.parse(merged.settledAt), true);
  await store.pruneSettledReceipts();
  assert.equal(await store.readReceipt(receipt.epoch), null);
});

test('a symlinked data root fails before mutating its target', async () => {
  const fixtureState = await fixture();
  const outside = join(fixtureState.root, 'outside-root');
  await mkdir(outside);
  await symlink(outside, fixtureState.dataRoot);
  const store = createHostLifecycleStore({ dataRoot: fixtureState.dataRoot, now: fixtureState.now });
  await assert.rejects(store.publishSessionEnd({ sessionId: 'session-a', sessionStartedAt: START, endedAt: END, origin: 'session-end-hook' }), (error) => error instanceof PluginError && error.code === 'PRIVATE_PATH_UNSAFE');
  const stats = await stat(outside);
  assert.equal(stats.mode & 0o777, 0o755);
  assert.deepEqual(await readdir(outside), []);
});

test('the settled ceiling crossing fails fast while receipts are still loading', async (t) => {
  const fixtureState = await fixture();
  t.after(() => rm(fixtureState.root, { recursive: true, force: true }));
  const store = createHostLifecycleStore({ dataRoot: fixtureState.dataRoot, now: fixtureState.now });
  await installBulkReceipts(fixtureState, RECEIPTS_CEILING + 3, 'settled');
  await assert.rejects(store.listPendingReceipts(), (error) => error instanceof PluginError
    && error.code === 'RECEIPTS_DIRECTORY_EXHAUSTED'
    && error.details.settledReceipts === RECEIPTS_CEILING + 1);
});

test('a missing data root under a symlinked ancestor fails before creating outside the namespace', async () => {
  const fixtureState = await fixture();
  const outside = join(fixtureState.root, 'outside-ns');
  await mkdir(join(outside, 'preexisting'), { recursive: true });
  await symlink(outside, join(fixtureState.root, 'link'));
  const store = createHostLifecycleStore({ dataRoot: join(fixtureState.root, 'link', 'plugin-data'), now: fixtureState.now });
  await assert.rejects(store.publishSessionEnd({ sessionId: 'session-a', sessionStartedAt: START, endedAt: END, origin: 'session-end-hook' }), (error) => error instanceof PluginError && error.code === 'PRIVATE_PATH_UNSAFE');
  assert.deepEqual(await readdir(outside), ['preexisting']);
});

test('a symlinked ancestor above an existing directory fails before creating outside the namespace', async () => {
  const fixtureState = await fixture();
  const outside = join(fixtureState.root, 'outside-ns-deep');
  await mkdir(join(outside, 'preexisting'), { recursive: true });
  await symlink(outside, join(fixtureState.root, 'link-deep'));
  const store = createHostLifecycleStore({ dataRoot: join(fixtureState.root, 'link-deep', 'preexisting', 'plugin-data'), now: fixtureState.now });
  await assert.rejects(store.publishSessionEnd({ sessionId: 'session-a', sessionStartedAt: START, endedAt: END, origin: 'session-end-hook' }), (error) => error instanceof PluginError && error.code === 'PRIVATE_PATH_UNSAFE');
  assert.deepEqual(await readdir(join(outside, 'preexisting')), []);
});

test('pending receipts must not carry updatedAt before publishedAt', async () => {
  const fixtureState = await fixture();
  const store = createHostLifecycleStore({ dataRoot: fixtureState.dataRoot, now: fixtureState.now });
  const receipt = await store.publishSessionEnd({ sessionId: 'session-a', sessionStartedAt: START, endedAt: END, origin: 'session-end-hook' });
  const stored = JSON.parse(await readFile(receipt.path, 'utf8'));
  stored.updatedAt = '2026-08-01T00:00:00.000Z';
  await writeFile(receipt.path, `${JSON.stringify(stored, null, 2)}\n`);
  await assert.rejects(store.readReceipt(receipt.epoch), (error) => error instanceof PluginError && error.code === 'RECEIPT_CORRUPT');
  await assert.rejects(store.settleReceipt(receipt.epoch, '2026-08-01T00:00:00.000Z'), (error) => error instanceof PluginError && error.code === 'RECEIPT_CORRUPT');
});

test('raceAbort rejects immediately with the abort reason while the operation stays pending', async () => {
  const controller = new AbortController();
  const reason = new Error('budget exhausted');
  setTimeout(() => controller.abort(reason), 10);
  const startedAt = Date.now();
  await assert.rejects(raceAbort(new Promise(() => {}), controller.signal), (error) => error === reason);
  assert.equal(Date.now() - startedAt < 200, true);
  assert.equal(await raceAbort(Promise.resolve(7), new AbortController().signal), 7);
  const failure = new Error('operation failed');
  await assert.rejects(raceAbort(Promise.reject(failure), new AbortController().signal), (error) => error === failure);
  await assert.rejects(raceAbort(Promise.resolve(7), AbortSignal.abort()), /** @type {(error: { name?: string }) => boolean} */ ((error) => error.name === 'AbortError'));
});

test('raceAbort with an already-aborted signal absorbs an operation that rejects later', async () => {
  /** @type {unknown[]} */
  const unhandled = [];
  /** @param {unknown} error */
  const recordUnhandled = (error) => { unhandled.push(error); };
  process.on('unhandledRejection', recordUnhandled);
  try {
    let rejectOperation = () => {};
    const operation = new Promise((_, reject) => { rejectOperation = () => reject(new Error('late operation failure')); });
    const controller = new AbortController();
    const reason = new Error('budget exhausted');
    controller.abort(reason);
    const startedAt = Date.now();
    await assert.rejects(raceAbort(operation, controller.signal), (error) => error === reason);
    assert.equal(Date.now() - startedAt < 200, true);
    rejectOperation();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', recordUnhandled);
  }
});

test('an aborted mutating write rejects the caller at the deadline while the write is still pending', async () => {
  let releaseWrite = () => {};
  const write = new Promise((resolve) => { releaseWrite = () => resolve(undefined); });
  // Mirrors the store's lock-holding operation, which settles only after the write settles.
  const held = (async () => { await write; })();
  const controller = new AbortController();
  const reason = new Error('budget exhausted');
  setTimeout(() => controller.abort(reason), 10);
  let rejected = false;
  const attempted = raceAbortHeldWrite(held, controller.signal);
  attempted.catch(() => { rejected = true; });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(rejected, true, 'the caller must be rejected at the abort deadline, not after the write settles');
  releaseWrite();
  await assert.rejects(attempted, (error) => error === reason);
  await held;
  assert.equal(await raceAbortHeldWrite(Promise.resolve(7), new AbortController().signal), 7);
});

test('the lock-holding operation settles only after the write settles', async (t) => {
  const fixtureState = await fixture();
  t.after(() => rm(fixtureState.root, { recursive: true, force: true }));
  const lockPath = join(fixtureState.root, 'receipts', 'epoch.lock');
  let releaseWrite = () => {};
  const write = new Promise((resolve) => { releaseWrite = () => resolve(undefined); });
  let signalOperationStarted = () => {};
  const started = new Promise((resolve) => { signalOperationStarted = () => resolve(undefined); });
  const controller = new AbortController();
  const reason = new Error('budget exhausted');
  // Mirrors the store: withFileLock holds the epoch lock while its operation
  // awaits the write, and the caller view is raced at the outer boundary.
  const held = withFileLock(lockPath, async () => { signalOperationStarted(); await write; }, { signal: controller.signal, timeoutMs: 5_000 });
  await started;
  controller.abort(reason);
  let rejected = false;
  const attempted = raceAbortHeldWrite(held, controller.signal);
  attempted.catch(() => { rejected = true; });
  const contender = holdAdvisoryLock(lockPath);
  contender.done.catch(() => {});
  let contenderAcquired = false;
  contender.acquired.then(() => { contenderAcquired = true; });
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(rejected, true, 'the caller is rejected at the deadline while the write is still pending');
  assert.equal(contenderAcquired, false, 'the epoch lock is still held while the write is still pending');
  releaseWrite();
  await assert.rejects(held, (error) => error === reason);
  await contender.acquired;
  contender.release();
  await contender.done;
  await assert.rejects(attempted, (error) => error === reason);
});

test('a write failing after the caller was rejected settles the lock operation without an unhandled rejection', async () => {
  /** @type {unknown[]} */
  const unhandled = [];
  /** @param {unknown} error */
  const recordUnhandled = (error) => { unhandled.push(error); };
  process.on('unhandledRejection', recordUnhandled);
  try {
    let failWrite = () => {};
    const write = new Promise((_, reject) => { failWrite = () => reject(new Error('late write failure')); });
    const held = (async () => { await write; })();
    const controller = new AbortController();
    const reason = new Error('budget exhausted');
    controller.abort(reason);
    let rejected = false;
    const attempted = raceAbortHeldWrite(held, controller.signal);
    attempted.catch(() => { rejected = true; });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(rejected, true, 'the caller is rejected at the deadline even when the signal was already aborted');
    failWrite();
    await assert.rejects(held, (error) => error instanceof Error && error.message === 'late write failure');
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(unhandled, []);
    await assert.rejects(attempted, (error) => error === reason);
  } finally {
    process.off('unhandledRejection', recordUnhandled);
  }
});
