// @ts-nocheck
import assert from 'node:assert/strict';
import test from 'node:test';

import { PluginError } from '../scripts/lib/errors.mjs';
import { createRescueLifecycleReconciler } from '../scripts/lib/rescue-lifecycle.mjs';

const authority = { ownerSessionId: 'owner-session' };
const workspace = '/workspace/repo';
const REQUESTED_AT = '2026-09-02T00:00:00.000Z';
const HOST_STATES = ['active', 'idle', 'notLoaded', 'systemError', 'absent'];

/**
 * In-memory Host/ZCode adapters for one joined Rescue lifecycle view. The
 * returned object is itself the adapters record, so it can be passed straight
 * to createRescueLifecycleReconciler, and also exposes `adapters` (itself),
 * `events`, and a live `stopCalls` counter for fixture-style assertions.
 *
 * `remote` selects the post-stop reread evidence ('unreadable', 'pending',
 * 'running' = still active/attributable, or a terminal classification).
 * `loadRemote` selects the initial joined evidence ('none', 'unavailable',
 * 'unreadable', 'idle-empty' = inactive pending, 'unattributable' = active but
 * not attributable, 'running' = active/attributable, or a terminal
 * classification).
 *
 * @param {{ events?: string[], host?: string, placement?: 'foreground'|'background', receipt?: 'matching'|'older'|null,
 *   remote?: 'succeeded'|'failed'|'interrupted'|'pending'|'unreadable'|'running',
 *   loadRemote?: 'none'|'unavailable'|'unreadable'|'succeeded'|'failed'|'interrupted'|'idle-empty'|'unattributable'|'running',
 *   stopAcknowledged?: boolean, jobStatus?: 'queued'|'running'|'cancelling', persistedStopCause?: string,
 *   winner?: 'succeeded'|'failed'|'cancelled', winnerStopCause?: string, staleAt?: 'revalidate', staleWinner?: string,
 *   persistConflict?: string, archiveOutcome?: 'failed', hostOwned?: boolean, acceptedSession?: boolean,
 *   bindingCurrent?: boolean, permissionMatch?: boolean }} [overrides]
 */
function fixtureAdapters(overrides = {}) {
  const options = {
    host: 'active', placement: 'foreground', receipt: null, remote: 'interrupted',
    stopAcknowledged: true, jobStatus: 'running', hostOwned: true, ...overrides,
  };
  const events = overrides.events ?? [];
  let stopCalls = 0;
  const stopIntent = (cause) => ({ version: 1, cause, requestedAt: REQUESTED_AT });
  const persistedIntent = options.persistedStopCause ? stopIntent(options.persistedStopCause) : undefined;

  const loadEvidence = () => {
    const configured = options.loadRemote ?? (options.jobStatus === 'queued' ? 'none' : 'running');
    if (configured === 'none') return { kind: 'none' };
    if (configured === 'unreadable') return { kind: 'unreadable', error: new Error('remote state could not be read') };
    if (configured === 'unavailable') return { kind: 'unavailable', error: new Error('existing ZCode control channel unavailable') };
    if (['succeeded', 'failed', 'interrupted'].includes(configured)) {
      return { kind: 'evidence', classification: configured, active: false, attributable: true };
    }
    if (configured === 'idle-empty') return { kind: 'evidence', classification: 'pending', active: false, attributable: true };
    if (configured === 'unattributable') return { kind: 'evidence', classification: 'pending', active: true, attributable: false };
    return { kind: 'evidence', classification: 'pending', active: true, attributable: true };
  };

  const adapters = {
    loadJoinedState: async (request) => {
      if (request.workspace !== workspace || request.authority?.ownerSessionId !== authority.ownerSessionId) {
        throw new PluginError('RESCUE_LIFECYCLE_INPUT_INVALID', 'The joined Rescue lifecycle state could not be validated for this caller.');
      }
      return {
        // Private joined evidence; never crosses the outcome seam.
        job: { id: 'job-private-reference', status: options.jobStatus, command: 'rescue', readOnly: false,
          zcodeSessionId: 'zcode-session-private', ...(persistedIntent ? { stopIntent: persistedIntent } : {}) },
        winner: options.winner === undefined ? null
          : { status: options.winner, ...(options.winner === 'cancelled' ? { stopCause: options.winnerStopCause ?? 'user' } : {}) },
        hostState: options.host,
        hostPlacement: options.hostOwned ? options.placement : null,
        hostOwned: options.hostOwned,
        sessionEndReceipt: options.receipt,
        stopIntent: persistedIntent ?? null,
        resumableEvidence: {
          acceptedSession: options.acceptedSession ?? options.jobStatus !== 'queued',
          bindingCurrent: options.bindingCurrent ?? true,
          permissionMatch: options.permissionMatch ?? true,
        },
        remote: loadEvidence(),
        guard: { generation: 1 },
      };
    },
    persistStopIntent: async (joined, cause) => {
      events.push('persist-stop-intent');
      if (options.persistConflict) return { kind: 'conflict', winner: { status: options.persistConflict } };
      if (joined.job.status === 'queued') return { kind: 'persisted', job: { ...joined.job, stopIntent: stopIntent(cause) } };
      if (joined.stopIntent) return { kind: 'persisted', job: joined.job };
      return { kind: 'persisted', job: { ...joined.job, status: 'cancelling', stopIntent: stopIntent(cause) } };
    },
    revalidateGeneration: async (joined) => {
      events.push('revalidate-generation');
      if (options.staleAt === 'revalidate') return {
        kind: 'stale',
        winner: { status: options.staleWinner ?? 'succeeded' },
        ...(options.staleResumableEvidence === undefined ? {} : { resumableEvidence: options.staleResumableEvidence }),
      };
      return { kind: 'current', job: joined.job, guard: { generation: 2 } };
    },
    stopExactTurn: async () => {
      events.push('stop-exact-turn');
      stopCalls += 1;
      return options.stopAcknowledged ? { acknowledged: true } : { acknowledged: false, error: new Error('stop not acknowledged') };
    },
    rereadRemote: async () => {
      events.push('reread-remote');
      if (options.remote === 'unreadable') return { kind: 'unreadable', error: new Error('remote state could not be reread') };
      if (options.remote === 'pending') return { kind: 'evidence', classification: 'pending', active: true, attributable: true };
      return { kind: 'evidence', classification: options.remote, active: false, attributable: true };
    },
    publishWinner: async (joined, specification) => {
      events.push(`publish-${specification.status}`);
      return { status: specification.status, ...(specification.status === 'cancelled' ? { stopCause: specification.stopCause } : {}) };
    },
    retainUnresolved: async (joined) => {
      events.push('retain-unresolved');
      return joined.job;
    },
    settleUnavailableExecutor: async (joined) => {
      events.push('settle-unavailable');
      return options.archiveOutcome === 'failed' ? { status: 'failed' } : joined.job;
    },
  };

  Object.defineProperties(adapters, {
    adapters: { value: adapters },
    events: { value: events },
    stopCalls: { get: () => stopCalls },
  });
  return adapters;
}

test('foreground child loss persists stop intent before exact remote stop', async () => {
  const events = [];
  const reconciler = createRescueLifecycleReconciler(fixtureAdapters({ events, host: 'systemError', placement: 'foreground', remote: 'interrupted' }));
  const outcome = await reconciler.reconcile({ intent: { kind: 'stop', cause: 'host-coordination-loss' }, authority, workspace });
  assert.deepEqual(events.slice(0, 3), ['persist-stop-intent', 'revalidate-generation', 'stop-exact-turn']);
  assert.deepEqual(outcome, { kind: 'settled-terminal', status: 'cancelled', stopCause: 'host-coordination-loss', resumable: true });
});

test('background child loss without matching receipt keeps the remote turn running', async () => {
  const fixture = fixtureAdapters({ host: 'absent', placement: 'background', receipt: null, remote: 'running' });
  const outcome = await createRescueLifecycleReconciler(fixture.adapters).reconcile({ intent: { kind: 'observe' }, authority, workspace });
  assert.equal(outcome.kind, 'wait-current');
  assert.equal(fixture.stopCalls, 0);
});

test('a wait intent observes the same bounded policy without stop authority', async () => {
  const fixture = fixtureAdapters({ host: 'active', placement: 'background', receipt: null });
  const outcome = await createRescueLifecycleReconciler(fixture.adapters).reconcile({ intent: { kind: 'wait' }, authority, workspace });
  assert.deepEqual(outcome, { kind: 'wait-current', status: 'running' });
  assert.equal(fixture.stopCalls, 0);
});

test('foreground observation derives coordination-loss stops only for lost or errored host children', async () => {
  for (const hostState of HOST_STATES) {
    const fixture = fixtureAdapters({ host: hostState, placement: 'foreground', receipt: null, remote: 'interrupted' });
    const outcome = await createRescueLifecycleReconciler(fixture.adapters).reconcile({ intent: { kind: 'observe' }, authority, workspace });
    if (['systemError', 'notLoaded', 'absent'].includes(hostState)) {
      assert.deepEqual(outcome, { kind: 'settled-terminal', status: 'cancelled', stopCause: 'host-coordination-loss', resumable: true }, hostState);
      assert.deepEqual(fixture.events, ['persist-stop-intent', 'revalidate-generation', 'stop-exact-turn', 'reread-remote', 'publish-cancelled'], hostState);
    } else {
      assert.deepEqual(outcome, { kind: 'wait-current', status: 'running' }, hostState);
      assert.deepEqual(fixture.events, [], hostState);
      assert.equal(fixture.stopCalls, 0, hostState);
    }
  }
});

test('background child loss never derives a stop while the owner session is active', async () => {
  for (const hostState of HOST_STATES) {
    const fixture = fixtureAdapters({ host: hostState, placement: 'background', receipt: null, remote: 'interrupted' });
    const outcome = await createRescueLifecycleReconciler(fixture.adapters).reconcile({ intent: { kind: 'observe' }, authority, workspace });
    assert.deepEqual(outcome, { kind: 'wait-current', status: 'running' }, hostState);
    assert.equal(fixture.stopCalls, 0, hostState);
    assert.equal(fixture.events.includes('persist-stop-intent'), false, hostState);
  }
});

test('a matching SessionEnd receipt stops both placements regardless of host liveness', async () => {
  for (const { host, placement } of [{ host: 'absent', placement: 'background' }, { host: 'active', placement: 'foreground' }]) {
    const fixture = fixtureAdapters({ host, placement, receipt: 'matching', remote: 'interrupted' });
    const outcome = await createRescueLifecycleReconciler(fixture.adapters).reconcile({ intent: { kind: 'observe' }, authority, workspace });
    assert.deepEqual(outcome, { kind: 'settled-terminal', status: 'cancelled', stopCause: 'session-end', resumable: true }, `${host}/${placement}`);
    assert.equal(fixture.stopCalls, 1, `${host}/${placement}`);
  }
});

test('an older-epoch receipt grants no stop authority over a post-resume job', async () => {
  for (const { host, placement } of [{ host: 'absent', placement: 'background' }, { host: 'active', placement: 'foreground' }]) {
    const fixture = fixtureAdapters({ host, placement, receipt: 'older', remote: 'interrupted' });
    const outcome = await createRescueLifecycleReconciler(fixture.adapters).reconcile({ intent: { kind: 'observe' }, authority, workspace });
    assert.deepEqual(outcome, { kind: 'wait-current', status: 'running' }, `${host}/${placement}`);
    assert.equal(fixture.stopCalls, 0, `${host}/${placement}`);
    assert.equal(fixture.events.includes('persist-stop-intent'), false, `${host}/${placement}`);
  }
});

test('an older-epoch receipt never masks foreground host coordination loss', async () => {
  for (const hostState of ['systemError', 'absent']) {
    const fixture = fixtureAdapters({ host: hostState, placement: 'foreground', receipt: 'older', remote: 'interrupted' });
    const outcome = await createRescueLifecycleReconciler(fixture.adapters).reconcile({ intent: { kind: 'observe' }, authority, workspace });
    assert.deepEqual(outcome, { kind: 'settled-terminal', status: 'cancelled', stopCause: 'host-coordination-loss', resumable: true }, hostState);
    assert.equal(fixture.stopCalls, 1, hostState);
  }
});

test('a durable terminal winner is returned without any new lifecycle mutation', async () => {
  for (const winner of ['succeeded', 'failed', 'cancelled']) {
    for (const intent of [{ kind: 'observe' }, { kind: 'stop', cause: 'user' }]) {
      const fixture = fixtureAdapters({ winner, winnerStopCause: 'user', remote: 'interrupted' });
      const outcome = await createRescueLifecycleReconciler(fixture.adapters).reconcile({ intent, authority, workspace });
      assert.deepEqual(outcome, { kind: 'settled-terminal', status: winner,
        ...(winner === 'cancelled' ? { stopCause: 'user' } : {}), resumable: true }, `${winner}/${intent.kind}`);
      assert.deepEqual(fixture.events, [], `${winner}/${intent.kind}`);
      assert.equal(fixture.stopCalls, 0, `${winner}/${intent.kind}`);
    }
  }
});

test('explicit user cancellation settles cancelled with the user stop cause on both placements', async () => {
  for (const placement of ['foreground', 'background']) {
    const fixture = fixtureAdapters({ host: 'active', placement, receipt: null, remote: 'interrupted' });
    const outcome = await createRescueLifecycleReconciler(fixture.adapters).reconcile({ intent: { kind: 'stop', cause: 'user' }, authority, workspace });
    assert.deepEqual(outcome, { kind: 'settled-terminal', status: 'cancelled', stopCause: 'user', resumable: true }, placement);
    assert.equal(fixture.stopCalls, 1, placement);
  }
});

test('explicit coordination-loss stop authority is foreground-only', async () => {
  const fixture = fixtureAdapters({ host: 'absent', placement: 'background', receipt: null, remote: 'interrupted' });
  const outcome = await createRescueLifecycleReconciler(fixture.adapters).reconcile({ intent: { kind: 'stop', cause: 'host-coordination-loss' }, authority, workspace });
  assert.deepEqual(outcome, { kind: 'wait-current', status: 'running' });
  assert.equal(fixture.stopCalls, 0);
  assert.equal(fixture.events.includes('persist-stop-intent'), false);
});

test('a queued Host-owned run cancels durably without any remote stop', async () => {
  const fixture = fixtureAdapters({ jobStatus: 'queued', remote: 'interrupted' });
  const outcome = await createRescueLifecycleReconciler(fixture.adapters).reconcile({ intent: { kind: 'stop', cause: 'user' }, authority, workspace });
  assert.deepEqual(outcome, { kind: 'settled-terminal', status: 'cancelled', stopCause: 'user', resumable: false });
  assert.deepEqual(fixture.events, ['persist-stop-intent', 'publish-cancelled']);
  assert.equal(fixture.stopCalls, 0);
});

test('a stale generation performs zero stops and returns the current winner', async () => {
  const fixture = fixtureAdapters({ staleAt: 'revalidate', staleWinner: 'succeeded', remote: 'interrupted' });
  const outcome = await createRescueLifecycleReconciler(fixture.adapters).reconcile({ intent: { kind: 'stop', cause: 'session-end' }, authority, workspace });
  assert.deepEqual(outcome, { kind: 'settled-terminal', status: 'succeeded', resumable: false });
  assert.deepEqual(fixture.events, ['persist-stop-intent', 'revalidate-generation']);
  assert.equal(fixture.stopCalls, 0);
});

test('a stale-generation race projects resumability from refreshed post-race evidence', async () => {
  for (const [evidence, resumable] of [
    [{ acceptedSession: true, bindingCurrent: false, permissionMatch: true }, false],
    [{ acceptedSession: true, bindingCurrent: true, permissionMatch: false }, false],
    [{ acceptedSession: false, bindingCurrent: true, permissionMatch: true }, false],
    [{ acceptedSession: true, bindingCurrent: true, permissionMatch: true }, true],
    [undefined, false],
  ]) {
    const fixture = fixtureAdapters({ staleAt: 'revalidate', staleWinner: 'succeeded', staleResumableEvidence: evidence, remote: 'interrupted' });
    const outcome = await createRescueLifecycleReconciler(fixture.adapters).reconcile({ intent: { kind: 'stop', cause: 'session-end' }, authority, workspace });
    assert.deepEqual(outcome, { kind: 'settled-terminal', status: 'succeeded', resumable }, JSON.stringify(evidence));
    assert.deepEqual(fixture.events, ['persist-stop-intent', 'revalidate-generation'], JSON.stringify(evidence));
    assert.equal(fixture.stopCalls, 0, JSON.stringify(evidence));
  }
});

test('a persist conflict returns the raced winner without remote control', async () => {
  const fixture = fixtureAdapters({ persistConflict: 'failed', remote: 'interrupted' });
  const outcome = await createRescueLifecycleReconciler(fixture.adapters).reconcile({ intent: { kind: 'stop', cause: 'session-end' }, authority, workspace });
  assert.deepEqual(outcome, { kind: 'settled-terminal', status: 'failed', resumable: false });
  assert.deepEqual(fixture.events, ['persist-stop-intent']);
  assert.equal(fixture.stopCalls, 0);
});

test('an unacknowledged stop retains the guard without a terminal claim', async () => {
  const fixture = fixtureAdapters({ stopAcknowledged: false, remote: 'interrupted' });
  const outcome = await createRescueLifecycleReconciler(fixture.adapters).reconcile({ intent: { kind: 'stop', cause: 'user' }, authority, workspace });
  assert.deepEqual(outcome, { kind: 'unresolved-stop', status: 'cancelling' });
  assert.deepEqual(fixture.events, ['persist-stop-intent', 'revalidate-generation', 'stop-exact-turn', 'retain-unresolved']);
  assert.equal(fixture.events.some((event) => event.startsWith('publish-')), false);
});

test('an acknowledged stop with ambiguous reread never becomes terminal', async () => {
  const fixture = fixtureAdapters({ remote: 'pending' });
  const outcome = await createRescueLifecycleReconciler(fixture.adapters).reconcile({ intent: { kind: 'stop', cause: 'session-end' }, authority, workspace });
  assert.deepEqual(outcome, { kind: 'unresolved-stop', status: 'cancelling' });
  assert.deepEqual(fixture.events, ['persist-stop-intent', 'revalidate-generation', 'stop-exact-turn', 'reread-remote', 'retain-unresolved']);
});

test('an acknowledged stop with an unreadable reread keeps the job cancelling', async () => {
  const fixture = fixtureAdapters({ remote: 'unreadable' });
  const outcome = await createRescueLifecycleReconciler(fixture.adapters).reconcile({ intent: { kind: 'stop', cause: 'user' }, authority, workspace });
  assert.deepEqual(outcome, { kind: 'unresolved-stop', status: 'cancelling' });
  assert.equal(fixture.events.some((event) => event.startsWith('publish-')), false);
});

test('natural success wins the stop race and publishes the authoritative result', async () => {
  const fixture = fixtureAdapters({ remote: 'succeeded' });
  const outcome = await createRescueLifecycleReconciler(fixture.adapters).reconcile({ intent: { kind: 'stop', cause: 'session-end' }, authority, workspace });
  assert.deepEqual(outcome, { kind: 'settled-terminal', status: 'succeeded', resumable: true });
  assert.deepEqual(fixture.events, ['persist-stop-intent', 'revalidate-generation', 'stop-exact-turn', 'reread-remote', 'publish-succeeded']);
});

test('an already-terminal remote turn under an explicit stop settles without a second stop', async () => {
  for (const loadRemote of ['interrupted', 'succeeded', 'failed']) {
    const fixture = fixtureAdapters({ loadRemote, remote: 'interrupted' });
    const outcome = await createRescueLifecycleReconciler(fixture.adapters).reconcile({ intent: { kind: 'stop', cause: 'session-end' }, authority, workspace });
    const expected = loadRemote === 'succeeded' ? 'succeeded' : loadRemote === 'failed' ? 'failed' : 'cancelled';
    assert.deepEqual(outcome, { kind: 'settled-terminal', status: expected,
      ...(expected === 'cancelled' ? { stopCause: 'session-end' } : {}), resumable: true }, loadRemote);
    assert.equal(fixture.stopCalls, 0, loadRemote);
    assert.deepEqual(fixture.events, ['persist-stop-intent', `publish-${expected}`], loadRemote);
  }
});

test('a pre-stop engine terminal failure is never rewritten as cancellation', async () => {
  const preStop = fixtureAdapters({ loadRemote: 'failed', remote: 'interrupted' });
  const preStopOutcome = await createRescueLifecycleReconciler(preStop.adapters).reconcile({ intent: { kind: 'stop', cause: 'session-end' }, authority, workspace });
  assert.deepEqual(preStopOutcome, { kind: 'settled-terminal', status: 'failed', resumable: true });
  assert.equal(preStop.stopCalls, 0);
  assert.deepEqual(preStop.events, ['persist-stop-intent', 'publish-failed']);

  const postStop = fixtureAdapters({ remote: 'failed' });
  const postStopOutcome = await createRescueLifecycleReconciler(postStop.adapters).reconcile({ intent: { kind: 'stop', cause: 'session-end' }, authority, workspace });
  assert.deepEqual(postStopOutcome, { kind: 'settled-terminal', status: 'cancelled', stopCause: 'session-end', resumable: true });
  assert.equal(postStop.stopCalls, 1);
  assert.deepEqual(postStop.events, ['persist-stop-intent', 'revalidate-generation', 'stop-exact-turn', 'reread-remote', 'publish-cancelled']);
});

test('an observation budget that expires during the joined load never publishes afterwards', async () => {
  const controller = new AbortController();
  const reason = Object.freeze({ phase: 'load' });
  const fixture = fixtureAdapters({ host: 'absent', placement: 'background', receipt: null, loadRemote: 'succeeded' });
  const adapters = { ...fixture.adapters,
    loadJoinedState: async (request) => { controller.abort(reason); return fixture.adapters.loadJoinedState(request); } };
  await assert.rejects(createRescueLifecycleReconciler(adapters).reconcile(
    { intent: { kind: 'observe' }, authority, workspace, signal: controller.signal }), (error) => error === reason);
  assert.deepEqual(fixture.events, []);
  assert.equal(fixture.stopCalls, 0);
});

test('an observed engine terminal failure publishes failed without stopping', async () => {
  const fixture = fixtureAdapters({ host: 'absent', placement: 'background', receipt: null, loadRemote: 'failed' });
  const outcome = await createRescueLifecycleReconciler(fixture.adapters).reconcile({ intent: { kind: 'observe' }, authority, workspace });
  assert.deepEqual(outcome, { kind: 'settled-terminal', status: 'failed', resumable: true });
  assert.deepEqual(fixture.events, ['publish-failed']);
  assert.equal(fixture.stopCalls, 0);
});

test('observed natural success settles succeeded for a background run without a live host child', async () => {
  const fixture = fixtureAdapters({ host: 'absent', placement: 'background', receipt: null, loadRemote: 'succeeded' });
  const outcome = await createRescueLifecycleReconciler(fixture.adapters).reconcile({ intent: { kind: 'observe' }, authority, workspace });
  assert.deepEqual(outcome, { kind: 'settled-terminal', status: 'succeeded', resumable: true });
  assert.deepEqual(fixture.events, ['publish-succeeded']);
  assert.equal(fixture.stopCalls, 0);
});

test('an unattributable or idle remote turn under a stop intent retains the guard without stopping', async () => {
  for (const loadRemote of ['idle-empty', 'unattributable', 'none']) {
    const fixture = fixtureAdapters({ loadRemote, remote: 'interrupted' });
    const outcome = await createRescueLifecycleReconciler(fixture.adapters).reconcile({ intent: { kind: 'stop', cause: 'session-end' }, authority, workspace });
    assert.equal(outcome.kind, 'unresolved-stop', loadRemote);
    assert.equal(fixture.stopCalls, 0, loadRemote);
    assert.deepEqual(fixture.events, ['persist-stop-intent', 'retain-unresolved'], loadRemote);
  }
});

test('a cancelling job replays its persisted stop intent without minting a new one', async () => {
  const fixture = fixtureAdapters({ jobStatus: 'cancelling', persistedStopCause: 'user', host: 'active', placement: 'foreground', receipt: null, remote: 'interrupted' });
  const outcome = await createRescueLifecycleReconciler(fixture.adapters).reconcile({ intent: { kind: 'observe' }, authority, workspace });
  assert.deepEqual(outcome, { kind: 'settled-terminal', status: 'cancelled', stopCause: 'user', resumable: true });
  assert.equal(fixture.events.includes('persist-stop-intent'), false);
  assert.deepEqual(fixture.events, ['revalidate-generation', 'stop-exact-turn', 'reread-remote', 'publish-cancelled']);
});

test('a second stop request with a different cause never overrides the persisted stop intent', async () => {
  const fixture = fixtureAdapters({ jobStatus: 'cancelling', persistedStopCause: 'session-end', host: 'active', placement: 'foreground', receipt: null, remote: 'interrupted' });
  const outcome = await createRescueLifecycleReconciler(fixture.adapters).reconcile({ intent: { kind: 'stop', cause: 'user' }, authority, workspace });
  assert.deepEqual(outcome, { kind: 'settled-terminal', status: 'cancelled', stopCause: 'session-end', resumable: true });
  assert.equal(fixture.events.includes('persist-stop-intent'), false);
});

test('unavailable remote control stays unresolved until executor absence is safely proven', async () => {
  const retained = fixtureAdapters({ loadRemote: 'unavailable', remote: 'interrupted' });
  assert.deepEqual(await createRescueLifecycleReconciler(retained.adapters).reconcile({ intent: { kind: 'stop', cause: 'session-end' }, authority, workspace }), { kind: 'unresolved-stop', status: 'cancelling' });
  assert.equal(retained.stopCalls, 0);

  const archived = fixtureAdapters({ loadRemote: 'unavailable', archiveOutcome: 'failed', remote: 'interrupted' });
  assert.deepEqual(await createRescueLifecycleReconciler(archived.adapters).reconcile({ intent: { kind: 'stop', cause: 'session-end' }, authority, workspace }), { kind: 'settled-terminal', status: 'failed', resumable: true });
  assert.equal(archived.stopCalls, 0);
  assert.deepEqual(archived.events, ['persist-stop-intent', 'settle-unavailable']);
});

test('resumability follows accepted session, binding, and permission evidence', async () => {
  for (const [overrides, resumable] of [
    [{ remote: 'interrupted', acceptedSession: false }, false],
    [{ remote: 'interrupted', bindingCurrent: false }, false],
    [{ remote: 'interrupted', permissionMatch: false }, false],
    [{ remote: 'interrupted' }, true],
  ]) {
    const fixture = fixtureAdapters(overrides);
    const outcome = await createRescueLifecycleReconciler(fixture.adapters).reconcile({ intent: { kind: 'stop', cause: 'user' }, authority, workspace });
    assert.deepEqual(outcome, { kind: 'settled-terminal', status: 'cancelled', stopCause: 'user', resumable });
  }
});

test('the reconciler validates its adapters and request shape', async () => {
  for (const invalid of [null, {}, { loadJoinedState: async () => null }, ...['persistStopIntent', 'revalidateGeneration', 'stopExactTurn',
    'rereadRemote', 'publishWinner', 'retainUnresolved', 'settleUnavailableExecutor'].map((missing) => {
    const adapters = fixtureAdapters();
    const stripped = { ...adapters };
    delete stripped[missing];
    return stripped;
  })]) {
    assert.throws(() => createRescueLifecycleReconciler(invalid), (error) => error instanceof PluginError && error.code === 'RESCUE_LIFECYCLE_ADAPTERS_INVALID');
  }

  const reconciler = createRescueLifecycleReconciler(fixtureAdapters());
  for (const invalid of [
    null, {},
    { intent: { kind: 'restart' }, authority, workspace },
    { intent: { kind: 'stop' }, authority, workspace },
    { intent: { kind: 'stop', cause: 'timeout' }, authority, workspace },
    { intent: { kind: 'stop', cause: 'user', requestedAt: REQUESTED_AT }, authority, workspace },
    { intent: { kind: 'observe' }, workspace },
    { intent: { kind: 'observe' }, authority },
    { intent: { kind: 'observe' }, authority, workspace: '' },
    { intent: { kind: 'observe' }, authority, workspace, signal: 'later' },
    { intent: { kind: 'observe' }, authority, workspace, unexpected: true },
  ]) {
    await assert.rejects(reconciler.reconcile(invalid), (error) => error instanceof PluginError && error.code === 'RESCUE_LIFECYCLE_INPUT_INVALID');
  }
});

test('joined-state validation failures reject before any lifecycle mutation', async () => {
  const fixture = fixtureAdapters({ host: 'systemError', placement: 'foreground', remote: 'interrupted' });
  const reconciler = createRescueLifecycleReconciler(fixture.adapters);
  await assert.rejects(reconciler.reconcile({ intent: { kind: 'stop', cause: 'host-coordination-loss' }, authority, workspace: '/workspace/other' }),
    (error) => error instanceof PluginError && error.code === 'RESCUE_LIFECYCLE_INPUT_INVALID');
  assert.deepEqual(fixture.events, []);
  assert.equal(fixture.stopCalls, 0);
});

test('adapter misbehavior rejects boundedly instead of throwing raw errors or claiming settlement', async () => {
  const fixture = fixtureAdapters();
  const missingJoinedState = createRescueLifecycleReconciler({ ...fixture.adapters, loadJoinedState: async () => null });
  await assert.rejects(missingJoinedState.reconcile({ intent: { kind: 'observe' }, authority, workspace }),
    (error) => error instanceof PluginError && error.code === 'RESCUE_LIFECYCLE_STATE_INVALID');
  assert.equal(fixture.stopCalls, 0);
  assert.deepEqual(fixture.events, []);

  const joined = await fixture.adapters.loadJoinedState({ intent: { kind: 'observe' }, authority, workspace });
  const nonterminalWinner = createRescueLifecycleReconciler({ ...fixture.adapters,
    loadJoinedState: async () => ({ ...joined, winner: { status: joined.job.status } }) });
  assert.deepEqual(await nonterminalWinner.reconcile({ intent: { kind: 'observe' }, authority, workspace }), { kind: 'fail-closed', status: 'running' });
  assert.equal(fixture.stopCalls, 0);
  assert.deepEqual(fixture.events, []);
});

test('a partial joined state record rejects boundedly before any lifecycle action', async () => {
  const fixture = fixtureAdapters();
  for (const intent of [{ kind: 'observe' }, { kind: 'stop', cause: 'session-end' }]) {
    const partial = createRescueLifecycleReconciler({ ...fixture.adapters, loadJoinedState: async () => ({}) });
    await assert.rejects(partial.reconcile({ intent, authority, workspace }),
      (error) => error instanceof PluginError && error.code === 'RESCUE_LIFECYCLE_STATE_INVALID', intent.kind);
  }
  assert.deepEqual(fixture.events, []);
  assert.equal(fixture.stopCalls, 0);
});

test('an unpersisted stop intent never enables lifecycle control', async () => {
  const incomplete = [
    undefined,
    { kind: 'persisted' },
    { kind: 'persisted', job: { id: 'job-private-reference', status: 'running' } },
  ];
  for (let index = 0; index < incomplete.length; index += 1) {
    const fixture = fixtureAdapters({ remote: 'interrupted' });
    const adapters = { ...fixture.adapters, persistStopIntent: async () => incomplete[index] };
    await assert.rejects(createRescueLifecycleReconciler(adapters).reconcile({ intent: { kind: 'stop', cause: 'user' }, authority, workspace }),
      (error) => error instanceof PluginError && error.code === 'RESCUE_LIFECYCLE_STATE_INVALID', String(index));
    assert.equal(fixture.stopCalls, 0, String(index));
    assert.equal(fixture.events.includes('revalidate-generation'), false, String(index));
    assert.equal(fixture.events.some((event) => event.startsWith('publish-')), false, String(index));
  }
});

test('outcomes never expose private session, binding, capability, or path evidence', async () => {
  const outcomes = [];
  for (const overrides of [
    { host: 'systemError', placement: 'foreground', remote: 'interrupted' },
    { host: 'absent', placement: 'background', receipt: null, remote: 'running' },
    { remote: 'pending' },
    { loadRemote: 'unavailable' },
    { jobStatus: 'queued' },
  ]) {
    const fixture = fixtureAdapters(overrides);
    // A stop cause belongs only to a stop intent; the observe fixture must pass
    // the same strictly bounded intent shape a real caller would.
    const intent = overrides.remote === 'running' ? { kind: 'observe' } : { kind: 'stop', cause: 'session-end' };
    outcomes.push(await createRescueLifecycleReconciler(fixture.adapters).reconcile({ intent, authority, workspace }));
  }
  const serialized = JSON.stringify(outcomes);
  assert.doesNotMatch(serialized, /zcode-session-private/);
  assert.doesNotMatch(serialized, /job-private-reference/);
  assert.doesNotMatch(serialized, /workspace\/repo/);
  assert.doesNotMatch(serialized, /capability/);
});
