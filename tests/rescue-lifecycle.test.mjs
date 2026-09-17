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
 * 'running' = still active/attributable, 'idle-empty' = inactive pending (the
 * unfinished current turn with no final report), 'unattributable' = readable
 * but not attributable to the current turn (runtime/session identity
 * mismatch), or a terminal classification).
 * `loadRemote` selects the initial joined evidence ('none', 'unavailable',
 * 'unreadable', 'idle-empty' = inactive pending, 'unattributable' = active but
 * not attributable, 'running' = active/attributable, or a terminal
 * classification).
 * `stopUpstream` selects the upstream protocol generation the stop response
 * attests: 'same' = the qualified exact-runtime acknowledgement (the pre-stop
 * read, stop, and reread share one upstream generation with no runtime
 * reconstruction), 'replaced' = the same session ID answered over a replaced
 * upstream generation, and undefined = today's bare acknowledgement carrying
 * no continuity proof at all.
 * `terminateRunner` additionally accepts the retention duty outcomes
 * ('pending', 'unproven', 'budget-expired') so worker cleanup evidence stays a
 * separate fixture input from the stop response and the remote state.
 * `stopFailureReread` selects the evidence one bounded same-attempt reread
 * observes AFTER A FAILED STOP — independent terminal evidence attributable
 * to the current turn (spec 4.2): 'interrupted' = a terminal interrupted
 * snapshot, the only permitted substitute for the failed stop's
 * acknowledgement; 'failed' = a terminal engine failure snapshot, which may
 * NOT substitute (a failed stop cannot claim the natural failure as its
 * stop-caused race winner); undefined = no independent post-failure evidence
 * was obtained. It is its own evidence dimension: the acknowledged-stop
 * reread (`remote`) never reports it, and the two are never merged into one
 * boolean.
 *
 * `companionExecution` selects the joined Companion-execution dimension the
 * real adapters derive from the durable record: 'foreground' = no valid
 * detached runner evidence (attached observation), 'background' = a valid new
 * runner-format marker (detached child-exit semantics).
 *
 * @param {{ events?: string[], host?: string, placement?: 'foreground'|'background', companionExecution?: 'foreground'|'background', receipt?: 'matching'|'older'|null,
 *   remote?: 'succeeded'|'failed'|'interrupted'|'pending'|'unreadable'|'idle-empty'|'unattributable'|'running',
 *   loadRemote?: 'none'|'unavailable'|'unreadable'|'succeeded'|'failed'|'interrupted'|'idle-empty'|'unattributable'|'running',
 *   stopAcknowledged?: boolean, stopUpstream?: 'same'|'replaced', stopFailureReread?: 'interrupted'|'failed',
 *   jobStatus?: 'queued'|'running'|'cancelling', persistedStopCause?: string,
 *   winner?: 'succeeded'|'failed'|'cancelled', winnerStopCause?: string, staleAt?: 'revalidate', staleWinner?: string,
 *   persistConflict?: string, archiveOutcome?: 'failed', hostOwned?: boolean, acceptedSession?: boolean,
 *   bindingCurrent?: boolean, permissionMatch?: boolean,
 *   terminateRunner?: 'record'|'throws'|'pending'|'unproven'|'budget-expired', abortController?: AbortController, rereadAbort?: boolean }} [overrides]
 */
function fixtureAdapters(overrides = {}) {
  const options = {
    host: 'active', placement: 'foreground', companionExecution: 'foreground', receipt: null, remote: 'interrupted',
    stopAcknowledged: true, jobStatus: 'running', hostOwned: true, ...overrides,
  };
  const events = overrides.events ?? [];
  const retainedErrors = [];
  let stopCalls = 0;
  let lastStopAcknowledged = null;
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
        companionExecution: options.companionExecution,
        hostOwned: options.hostOwned,
        sessionEndReceipt: options.receipt,
        stopIntent: persistedIntent ?? null,
        resumableEvidence: {
          acceptedSession: options.acceptedSession ?? options.jobStatus !== 'queued',
          bindingCurrent: options.bindingCurrent ?? true,
          permissionMatch: options.permissionMatch ?? true,
        },
        remote: loadEvidence(),
        guard: options.postStopEvidence ? 'post-stop-evidence' : null,
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
      if (!options.stopAcknowledged) {
        lastStopAcknowledged = false;
        return { acknowledged: false, error: new Error('stop not acknowledged') };
      }
      lastStopAcknowledged = true;
      // The upstream-generation attestation rides on the stop response: only
      // 'same' is the qualified exact-runtime acknowledgement; 'replaced' and
      // the absent default carry no qualifying continuity proof.
      return { acknowledged: true, ...(options.stopUpstream ? { upstreamGeneration: options.stopUpstream } : {}) };
    },
    rereadRemote: async () => {
      events.push('reread-remote');
      if (options.rereadAbort) {
        const reason = new Error('the remote-control budget expired during the reread');
        options.abortController?.abort(reason);
        throw reason;
      }
      // Independent terminal evidence after a FAILED stop is its own
      // dimension: the reread reports it only for the failed-stop attempt.
      // 'interrupted' substitutes for the acknowledgement; 'failed' is the
      // natural engine failure the failed stop may never claim as its own
      // race winner — the two are never merged into the acknowledged-stop
      // reread mode below.
      if (lastStopAcknowledged === false && (options.stopFailureReread === 'interrupted' || options.stopFailureReread === 'failed')) {
        return { kind: 'evidence', classification: options.stopFailureReread, active: false, attributable: true };
      }
      if (options.remote === 'unreadable') return { kind: 'unreadable', error: new Error('remote state could not be reread') };
      if (options.remote === 'pending') return { kind: 'evidence', classification: 'pending', active: true, attributable: true };
      if (options.remote === 'idle-empty') return { kind: 'evidence', classification: 'pending', active: false, attributable: true };
      if (options.remote === 'unattributable') return { kind: 'evidence', classification: 'pending', active: false, attributable: false };
      return { kind: 'evidence', classification: options.remote, active: false, attributable: true };
    },
    publishWinner: async (joined, specification) => {
      events.push(`publish-${specification.status}`);
      return { status: specification.status, ...(specification.status === 'cancelled' ? { stopCause: specification.stopCause } : {}) };
    },
    retainUnresolved: async (joined, evidence) => {
      events.push('retain-unresolved');
      retainedErrors.push(evidence?.error);
      return joined.job;
    },
    settleUnavailableExecutor: async (joined) => {
      events.push('settle-unavailable');
      return options.archiveOutcome === 'failed' ? { status: 'failed' } : joined.job;
    },
  };

  // The optional marked-runner cleanup adapter (Task 7): present only when the
  // fixture selects it, proving callers without the seam keep today's behavior.
  // The adapter returns the duty's OUTCOME CONTRACT: `settled` names the
  // completed-clean same-pass descendant sweep that is the only marked-claim
  // settlement authority; a thrown duty maps to `not-proven` retention.
  if (options.terminateRunner) {
    adapters.terminateMarkedRunner = async () => {
      events.push('terminate-marked-runner');
      if (options.terminateRunner === 'throws') throw new Error('injected runner cleanup failure');
      // 'record' names the completed-clean sweep; every other configured value
      // is that exact retention duty outcome, so cleanup evidence stays a
      // separate fixture input from the stop response and the remote state.
      return { kind: options.terminateRunner === 'record' ? 'settled' : options.terminateRunner };
    };
  }

  Object.defineProperties(adapters, {
    adapters: { value: adapters },
    events: { value: events },
    retainedErrors: { value: retainedErrors },
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

test('host coordination loss requires the attached foreground combination on both placement dimensions', async () => {
  // Host loss without a matching SessionEnd receipt: only the attached
  // foreground combination keeps coordination-loss authority. A valid detached
  // runner record (Companion background) makes child exit after the accepted
  // enqueue expected handoff completion — never a coordination loss, even
  // though the actual Host placement is foreground.
  const expected = [
    ['foreground', 'foreground', 'host-coordination-loss'],
    ['background', 'foreground', null],
    ['foreground', 'background', null],
    ['background', 'background', null],
  ];
  for (const [placement, companionExecution, cause] of expected) {
    const fixture = fixtureAdapters({ host: 'absent', placement, companionExecution, receipt: null, remote: 'interrupted' });
    const outcome = await createRescueLifecycleReconciler(fixture.adapters).reconcile({ intent: { kind: 'observe' }, authority, workspace });
    const label = `${placement}/${companionExecution}`;
    if (cause === null) {
      assert.deepEqual(outcome, { kind: 'wait-current', status: 'running' }, label);
      assert.equal(fixture.stopCalls, 0, label);
      assert.equal(fixture.events.includes('persist-stop-intent'), false, label);
      assert.equal(fixture.events.includes('publish-cancelled'), false, label);
    } else {
      assert.deepEqual(outcome, { kind: 'settled-terminal', status: 'cancelled', stopCause: cause, resumable: true }, label);
      assert.equal(fixture.stopCalls, 1, label);
    }
  }
});

test('an explicit coordination-loss intent is gated on the attached foreground combination too', async () => {
  const fixture = fixtureAdapters({ host: 'absent', placement: 'foreground', companionExecution: 'background', receipt: null, remote: 'interrupted' });
  const outcome = await createRescueLifecycleReconciler(fixture.adapters).reconcile({ intent: { kind: 'stop', cause: 'host-coordination-loss' }, authority, workspace });
  assert.deepEqual(outcome, { kind: 'wait-current', status: 'running' },
    'a detached Companion-background child exit is expected handoff completion, never a coordination loss');
  assert.equal(fixture.stopCalls, 0);
  assert.equal(fixture.events.includes('persist-stop-intent'), false);
});

test('normal SubagentStop of a detached child neither stops the session, cancels, nor terminates the runner', async () => {
  for (const jobStatus of ['running', 'queued']) {
    const events = [];
    const fixture = fixtureAdapters({ events, host: 'absent', placement: 'foreground', companionExecution: 'background',
      receipt: null, remote: 'running', terminateRunner: 'record', jobStatus });
    const outcome = await createRescueLifecycleReconciler(fixture.adapters).reconcile({ intent: { kind: 'observe' }, authority, workspace });
    assert.deepEqual(outcome, { kind: 'wait-current', status: jobStatus }, jobStatus);
    assert.equal(fixture.stopCalls, 0, jobStatus);
    assert.deepEqual(fixture.events, [], `${jobStatus}: observation performs no session stop, no stop intent, no cancel, and no runner kill`);
  }
});

test('a detached child lost before the enqueue settles through the existing failure rules without a duplicate runner', async () => {
  // Pre-start failure settlement: the observed engine terminal failure keeps
  // its own semantics — published failed with no stop, no stop intent, and no
  // runner termination or relaunch — never reclassified as attached foreground
  // coordination loss.
  const events = [];
  const fixture = fixtureAdapters({ events, host: 'absent', placement: 'foreground', companionExecution: 'background',
    receipt: null, loadRemote: 'failed', remote: 'interrupted', terminateRunner: 'record' });
  const outcome = await createRescueLifecycleReconciler(fixture.adapters).reconcile({ intent: { kind: 'observe' }, authority, workspace });
  assert.deepEqual(outcome, { kind: 'settled-terminal', status: 'failed', resumable: true });
  assert.deepEqual(fixture.events, ['publish-failed']);
  assert.equal(fixture.stopCalls, 0);
});

test('matching SessionEnd receipts and explicit user cancellation stay authoritative for every placement combination', async () => {
  for (const placement of ['foreground', 'background']) {
    for (const companionExecution of ['foreground', 'background']) {
      const label = `${placement}/${companionExecution}`;
      const receiptFixture = fixtureAdapters({ host: 'absent', placement, companionExecution, receipt: 'matching', remote: 'interrupted' });
      const receiptOutcome = await createRescueLifecycleReconciler(receiptFixture.adapters).reconcile({ intent: { kind: 'observe' }, authority, workspace });
      assert.deepEqual(receiptOutcome, { kind: 'settled-terminal', status: 'cancelled', stopCause: 'session-end', resumable: true }, label);
      assert.equal(receiptFixture.stopCalls, 1, label);
      const cancelFixture = fixtureAdapters({ host: 'absent', placement, companionExecution, receipt: null, remote: 'interrupted' });
      const cancelOutcome = await createRescueLifecycleReconciler(cancelFixture.adapters).reconcile({ intent: { kind: 'stop', cause: 'user' }, authority, workspace });
      assert.deepEqual(cancelOutcome, { kind: 'settled-terminal', status: 'cancelled', stopCause: 'user', resumable: true }, label);
      assert.equal(cancelFixture.stopCalls, 1, label);
    }
  }
});

test('a failed observation on a merely-authorized cancelling record publishes failed', async () => {
  // A persisted stop intent is authorization, not evidence that a stop
  // occurred: with no durable stop-attempt marker, a failed remote snapshot
  // keeps its engine-failure semantics instead of being claimed as cancelled.
  const events = [];
  const fixture = fixtureAdapters({ events, host: 'active', placement: 'foreground', loadRemote: 'failed', jobStatus: 'cancelling', persistedStopCause: 'user', postStopEvidence: true });
  const outcome = await createRescueLifecycleReconciler(fixture.adapters).reconcile({ intent: { kind: 'observe' }, authority, workspace });
  assert.deepEqual(outcome, { kind: 'settled-terminal', status: 'failed', resumable: true },
    'failed observed without proof of an acknowledged stop publishes the engine failure');
  assert.equal(fixture.events.includes('publish-failed'), true);
  assert.equal(fixture.events.some((event) => event.startsWith('stop-')), false, 'no stop is issued for an already-terminal turn');
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

test('an unattributable or absent remote turn under a stop intent retains the guard without stopping', async () => {
  for (const loadRemote of ['unattributable', 'none']) {
    const fixture = fixtureAdapters({ loadRemote, remote: 'interrupted' });
    const outcome = await createRescueLifecycleReconciler(fixture.adapters).reconcile({ intent: { kind: 'stop', cause: 'session-end' }, authority, workspace });
    assert.equal(outcome.kind, 'unresolved-stop', loadRemote);
    assert.equal(fixture.stopCalls, 0, loadRemote);
    assert.deepEqual(fixture.events, ['persist-stop-intent', 'retain-unresolved'], loadRemote);
  }
});

test('an attributable idle-unfinished turn under a stop intent stops and settles without a report', async () => {
  // spec 4.2 requires "at least one valid pre-stop snapshot attributable to
  // the current turn under persistedTurnBoundary" — ATTRIBUTION, never the
  // active projection. The attributable idle/completed snapshot with an
  // unfinished assistant is exactly the no-report shape a retry pass must
  // proceed on: revalidate, the same-generation exact stop, one bounded
  // reread, verified cleanup, cancelled. A pass that retained here instead
  // would leave the shape cancelling indefinitely.
  const events = [];
  const fixture = fixtureAdapters({ events, loadRemote: 'idle-empty', remote: 'idle-empty',
    stopUpstream: 'same', terminateRunner: 'record', jobStatus: 'cancelling', persistedStopCause: 'session-end',
    host: 'absent', placement: 'background', receipt: null });
  const outcome = await createRescueLifecycleReconciler(fixture.adapters).reconcile({ intent: { kind: 'stop', cause: 'session-end' }, authority, workspace });
  assert.deepEqual(outcome, { kind: 'settled-terminal', status: 'cancelled', stopCause: 'session-end', resumable: true },
    'the attributable idle pre-stop snapshot qualifies; the exact stop settles the no-report shape');
  assert.deepEqual(fixture.events,
    ['revalidate-generation', 'stop-exact-turn', 'reread-remote', 'terminate-marked-runner', 'publish-cancelled'],
    'the pass proceeded through the full mandated order with exactly one exact stop');
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

// ---------------------------------------------------------------------------
// Task 7 joined-state order: receipt/stop intent -> generation revalidation ->
// remote stop/reread -> marked runner identity revalidation -> bounded local
// termination -> exact lease acquisition and re-read -> winner or retained
// guard. The cleanup adapter is the reconciler-driven seam; the adapter
// implementations (recovery/job-control) own the marker/identity/lease probes.
// ---------------------------------------------------------------------------

test('an active stop terminates the marked runner between the reread and the cancelled winner', async () => {
  const events = [];
  const fixture = fixtureAdapters({ events, terminateRunner: 'record', host: 'absent', placement: 'background', receipt: 'matching', remote: 'interrupted' });
  const outcome = await createRescueLifecycleReconciler(fixture.adapters).reconcile({ intent: { kind: 'observe' }, authority, workspace });
  assert.deepEqual(outcome, { kind: 'settled-terminal', status: 'cancelled', stopCause: 'session-end', resumable: true });
  assert.deepEqual(events, ['persist-stop-intent', 'revalidate-generation', 'stop-exact-turn', 'reread-remote', 'terminate-marked-runner', 'publish-cancelled']);
});

test('a remote timeout keeps the local cleanup budget and ends in the retained guard', async () => {
  const events = [];
  const controller = new AbortController();
  const fixture = fixtureAdapters({ events, terminateRunner: 'record', host: 'absent', placement: 'background', receipt: 'matching', abortController: controller, rereadAbort: true });
  const outcome = await createRescueLifecycleReconciler(fixture.adapters).reconcile({ intent: { kind: 'observe' }, authority, workspace, signal: controller.signal });
  // The expired remote-control signal never skips the local termination duty:
  // cleanup runs with its own remaining budget and the unresolved remote state
  // keeps the guard — never a terminal claim.
  assert.deepEqual(outcome, { kind: 'unresolved-stop', status: 'cancelling' });
  assert.deepEqual(events, ['persist-stop-intent', 'revalidate-generation', 'stop-exact-turn', 'reread-remote', 'terminate-marked-runner']);
  assert.equal(events.some((event) => event.startsWith('publish-')), false);
});

test('natural success publishes the durable winner only behind the completed-clean sweep', async () => {
  const events = [];
  const fixture = fixtureAdapters({ events, terminateRunner: 'record', host: 'absent', placement: 'background', receipt: 'matching', remote: 'succeeded' });
  const outcome = await createRescueLifecycleReconciler(fixture.adapters).reconcile({ intent: { kind: 'observe' }, authority, workspace });
  assert.deepEqual(outcome, { kind: 'settled-terminal', status: 'succeeded', resumable: true });
  assert.deepEqual(events, ['persist-stop-intent', 'revalidate-generation', 'stop-exact-turn', 'reread-remote', 'terminate-marked-runner', 'publish-succeeded'],
    'the cleanup duty (kill decision plus the completed-clean sweep) gates the publication: a remote terminal winner never terminalizes over an unproven sweep');
});

test('a claimed queued runner is terminated after the durable stop intent and before the lease-acquiring cancel', async () => {
  const events = [];
  const fixture = fixtureAdapters({ events, terminateRunner: 'record', jobStatus: 'queued', remote: 'interrupted' });
  const outcome = await createRescueLifecycleReconciler(fixture.adapters).reconcile({ intent: { kind: 'stop', cause: 'user' }, authority, workspace });
  assert.deepEqual(outcome, { kind: 'settled-terminal', status: 'cancelled', stopCause: 'user', resumable: false });
  // queued live claim -> queued stopIntent -> kill -> acquire lease -> cancelled
  assert.deepEqual(events, ['persist-stop-intent', 'terminate-marked-runner', 'publish-cancelled']);
});

test('the unavailable remote-control exit terminates the marked runner before the executor-absence decision', async () => {
  const events = [];
  const fixture = fixtureAdapters({ events, terminateRunner: 'record', host: 'absent', placement: 'background', receipt: 'matching', loadRemote: 'unavailable', archiveOutcome: 'failed' });
  const outcome = await createRescueLifecycleReconciler(fixture.adapters).reconcile({ intent: { kind: 'observe' }, authority, workspace });
  assert.deepEqual(outcome, { kind: 'settled-terminal', status: 'failed', resumable: true });
  assert.deepEqual(events, ['persist-stop-intent', 'terminate-marked-runner', 'settle-unavailable']);
});

test('an unacknowledged stop still terminates the marked runner and settles the confirmed interruption', async () => {
  // A receipt-authorized pass (observe intent) holds stop authority: its
  // failed stop performs the ONE bounded probe reread, and the default remote
  // shape here is the independently confirmed current-turn interruption — the
  // only evidence that substitutes for the acknowledgement (spec 4.2;
  // SessionEnd and child-loss use the same rules). The marked runner still
  // terminates before the cancelled publication, exactly as before.
  const events = [];
  const fixture = fixtureAdapters({ events, terminateRunner: 'record', host: 'absent', placement: 'background', receipt: 'matching', stopAcknowledged: false });
  const outcome = await createRescueLifecycleReconciler(fixture.adapters).reconcile({ intent: { kind: 'observe' }, authority, workspace });
  assert.deepEqual(outcome, { kind: 'settled-terminal', status: 'cancelled', stopCause: 'session-end', resumable: true });
  assert.deepEqual(events, ['persist-stop-intent', 'revalidate-generation', 'stop-exact-turn', 'reread-remote', 'terminate-marked-runner', 'publish-cancelled']);
  assert.equal(fixture.stopCalls, 1);
});

test('the terminal early return keeps the marked-runner cleanup duty under stop authority', async () => {
  const stopEvents = [];
  const stopFixture = fixtureAdapters({ events: stopEvents, terminateRunner: 'record', winner: 'succeeded', host: 'absent', placement: 'background', receipt: 'matching' });
  const stopOutcome = await createRescueLifecycleReconciler(stopFixture.adapters).reconcile({ intent: { kind: 'observe' }, authority, workspace });
  assert.deepEqual(stopOutcome, { kind: 'settled-terminal', status: 'succeeded', resumable: true });
  assert.deepEqual(stopEvents, ['terminate-marked-runner'], 'a raced terminal winner never drops the still-held runner cleanup duty on an authorized pass');

  const observeEvents = [];
  const observeFixture = fixtureAdapters({ events: observeEvents, terminateRunner: 'record', winner: 'succeeded', host: 'active', placement: 'foreground', receipt: null });
  const observeOutcome = await createRescueLifecycleReconciler(observeFixture.adapters).reconcile({ intent: { kind: 'wait' }, authority, workspace });
  assert.deepEqual(observeOutcome, { kind: 'settled-terminal', status: 'succeeded', resumable: true });
  assert.deepEqual(observeEvents, [], 'a mere view of a terminal record performs no process kill');
});

test('passes without a remote-control attempt or stop authority never terminate the runner', async () => {
  // Management persist-before-control first pass: remote 'none' retains without
  // any local termination — the exact remote stop owns the boundary this pass.
  const noneEvents = [];
  const noneFixture = fixtureAdapters({ events: noneEvents, terminateRunner: 'record', loadRemote: 'none', remote: 'interrupted' });
  assert.deepEqual(await createRescueLifecycleReconciler(noneFixture.adapters).reconcile({ intent: { kind: 'stop', cause: 'user' }, authority, workspace }), { kind: 'unresolved-stop', status: 'cancelling' });
  assert.deepEqual(noneEvents, ['persist-stop-intent', 'retain-unresolved']);

  // Ordinary background observation after child exit: no kill, no stop.
  const observeEvents = [];
  const observeFixture = fixtureAdapters({ events: observeEvents, terminateRunner: 'record', host: 'absent', placement: 'background', receipt: null, remote: 'running' });
  assert.deepEqual(await createRescueLifecycleReconciler(observeFixture.adapters).reconcile({ intent: { kind: 'observe' }, authority, workspace }), { kind: 'wait-current', status: 'running' });
  assert.deepEqual(observeEvents, []);

  // An older-epoch receipt grants neither stop nor cleanup authority.
  const olderEvents = [];
  const olderFixture = fixtureAdapters({ events: olderEvents, terminateRunner: 'record', host: 'absent', placement: 'background', receipt: 'older', remote: 'running' });
  assert.deepEqual(await createRescueLifecycleReconciler(olderFixture.adapters).reconcile({ intent: { kind: 'observe' }, authority, workspace }), { kind: 'wait-current', status: 'running' });
  assert.deepEqual(olderEvents, []);
});

test('a persisted cancelling stop intent replays the runner cleanup without minting a new intent', async () => {
  const events = [];
  const fixture = fixtureAdapters({ events, terminateRunner: 'record', jobStatus: 'cancelling', persistedStopCause: 'session-end', host: 'absent', placement: 'background', receipt: null, remote: 'pending' });
  const outcome = await createRescueLifecycleReconciler(fixture.adapters).reconcile({ intent: { kind: 'observe' }, authority, workspace });
  // A receipt-less observation of a durable cancelling record still retries the
  // cleanup duty — durable cancelling-job evidence is the retry authority.
  assert.deepEqual(outcome, { kind: 'unresolved-stop', status: 'cancelling' });
  assert.equal(events.includes('persist-stop-intent'), false);
  assert.deepEqual(events, ['revalidate-generation', 'stop-exact-turn', 'reread-remote', 'terminate-marked-runner', 'retain-unresolved']);
});

test('a cleanup adapter failure never replaces the settlement outcome', async () => {
  const events = [];
  const fixture = fixtureAdapters({ events, terminateRunner: 'throws', jobStatus: 'queued', remote: 'interrupted' });
  const outcome = await createRescueLifecycleReconciler(fixture.adapters).reconcile({ intent: { kind: 'stop', cause: 'user' }, authority, workspace });
  // A thrown duty is `not-proven` — RETENTION under the settlement invariant:
  // the claimed queued record keeps its durable stop intent and its writable
  // exclusion, and the next bounded pass re-arms the duty (no terminal
  // publication over an unproven sweep).
  assert.deepEqual(outcome, { kind: 'unresolved-stop', status: 'queued' });
  assert.deepEqual(events, ['persist-stop-intent', 'terminate-marked-runner']);
  const stored = fixtureAdapters({ events: [], terminateRunner: 'record', jobStatus: 'queued', remote: 'interrupted' });
  const settled = await createRescueLifecycleReconciler(stored.adapters).reconcile({ intent: { kind: 'stop', cause: 'user' }, authority, workspace });
  assert.deepEqual(settled, { kind: 'settled-terminal', status: 'cancelled', stopCause: 'user', resumable: false },
    'the completed-clean sweep on the retried pass settles the same queued stop');
  assert.deepEqual(stored.events, ['persist-stop-intent', 'terminate-marked-runner', 'publish-cancelled']);
});

test('a stop without any durable decision still propagates an expired budget before cleanup is due', async () => {
  // An abort that outruns the durable stop intent propagates: no authorized
  // cleanup duty exists before the decision is durable.
  const events = [];
  const controller = new AbortController();
  controller.abort(new Error('caller interrupted before the decision'));
  const fixture = fixtureAdapters({ events, terminateRunner: 'record', remote: 'interrupted' });
  await assert.rejects(createRescueLifecycleReconciler(fixture.adapters).reconcile(
    { intent: { kind: 'stop', cause: 'user' }, authority, workspace, signal: controller.signal }),
  (error) => error === controller.signal.reason);
  assert.deepEqual(events, []);
});

test('the cleanup seam stays optional and must be a function when supplied', async () => {
  const fixture = fixtureAdapters({ remote: 'interrupted' });
  assert.equal('terminateMarkedRunner' in fixture.adapters, false);
  const outcome = await createRescueLifecycleReconciler(fixture.adapters).reconcile({ intent: { kind: 'stop', cause: 'user' }, authority, workspace });
  assert.deepEqual(outcome, { kind: 'settled-terminal', status: 'cancelled', stopCause: 'user', resumable: true }, 'callers without the seam keep the pre-Task-7 settlement exactly');
  assert.throws(() => createRescueLifecycleReconciler({ ...fixtureAdapters(), terminateMarkedRunner: 'not-a-function' }),
    (error) => error instanceof PluginError && error.code === 'RESCUE_LIFECYCLE_ADAPTERS_INVALID');
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

// ---------------------------------------------------------------------------
// Interrupt cancellation settlement (spec 2026-09-14, sections 4.2-4.4): an
// explicitly cancelled Host-managed writable Rescue may settle to `cancelled`
// after a QUALIFIED exact-runtime stop acknowledgement plus verified executor
// cleanup, WITHOUT a final assistant report. Qualification needs a valid
// pre-stop current-turn snapshot from this attempt, the stop and reread over
// the same upstream protocol generation without runtime reconstruction, and
// successful cleanup. Every failure or uncertainty path below stays
// `cancelling` with the writable guard retained.
// ---------------------------------------------------------------------------

test('a qualified exact-runtime stop acknowledgement settles cancelled without a final report', async () => {
  const events = [];
  // Valid pre-stop current-turn snapshot (the joined read shows the current
  // turn active and attributable), stop acknowledged {} over the same upstream
  // generation, one reread showing the unfinished current turn with no final
  // report, and the completed-clean marked-runner sweep.
  const fixture = fixtureAdapters({ events, loadRemote: 'running', remote: 'idle-empty',
    stopUpstream: 'same', terminateRunner: 'record' });
  const outcome = await createRescueLifecycleReconciler(fixture.adapters).reconcile({ intent: { kind: 'stop', cause: 'user' }, authority, workspace });
  assert.deepEqual(outcome, { kind: 'settled-terminal', status: 'cancelled', stopCause: 'user', resumable: true },
    'acknowledgement plus verified cleanup settles the cancellation procedure without a final assistant report');
  assert.equal(fixture.stopCalls, 1);
  assert.equal(events.filter((event) => event === 'reread-remote').length, 1, 'exactly one bounded reread after the stop');
  assert.deepEqual(events, ['persist-stop-intent', 'revalidate-generation', 'stop-exact-turn', 'reread-remote', 'terminate-marked-runner', 'publish-cancelled']);
  assert.ok(events.indexOf('terminate-marked-runner') < events.indexOf('publish-cancelled'),
    'verified executor cleanup precedes the cancelled publication');
  assert.equal(events.includes('publish-succeeded'), false);
  // The decision-level fixture has no session-send/resume/create seam to
  // observe; the real no-send/no-resume pin lives at the Task 3 composition
  // seam in tests/job-control.test.mjs.
});

test('a persisted cancelling job settles through a qualified stop acknowledgement on the status retry', async () => {
  const events = [];
  const fixture = fixtureAdapters({ events, jobStatus: 'cancelling', persistedStopCause: 'user',
    host: 'active', placement: 'foreground', receipt: null, loadRemote: 'running', remote: 'idle-empty',
    stopUpstream: 'same', terminateRunner: 'record' });
  const outcome = await createRescueLifecycleReconciler(fixture.adapters).reconcile({ intent: { kind: 'observe' }, authority, workspace });
  assert.deepEqual(outcome, { kind: 'settled-terminal', status: 'cancelled', stopCause: 'user', resumable: true });
  assert.equal(fixture.stopCalls, 1);
  assert.deepEqual(events, ['revalidate-generation', 'stop-exact-turn', 'reread-remote', 'terminate-marked-runner', 'publish-cancelled']);
  assert.equal(events.includes('persist-stop-intent'), false, 'the replayed durable intent mints no new one');
});

test('a failed stop stays cancelling even after verified executor cleanup leaves the remote outcome unknown', async () => {
  const events = [];
  const fixture = fixtureAdapters({ events, loadRemote: 'running', remote: 'idle-empty',
    stopUpstream: 'same', terminateRunner: 'record', stopAcknowledged: false });
  const outcome = await createRescueLifecycleReconciler(fixture.adapters).reconcile({ intent: { kind: 'stop', cause: 'user' }, authority, workspace });
  assert.deepEqual(outcome, { kind: 'unresolved-stop', status: 'cancelling' },
    'worker exit and a clean local sweep are not substitutes for the stop acknowledgement');
  assert.equal(fixture.stopCalls, 1);
  assert.equal(events.some((event) => event.startsWith('publish-')), false);
  assert.ok(events.includes('terminate-marked-runner') && events.includes('retain-unresolved'));
});

test('independently confirmed current-turn interruption settles cancelled despite a failed stop', async () => {
  const events = [];
  // The stop itself fails, but one bounded same-attempt reread independently
  // observes the terminal interrupted snapshot attributable to the current
  // turn — the only evidence that may substitute for the stop acknowledgement
  // (spec 4.2), and still only behind the completed-clean sweep.
  const fixture = fixtureAdapters({ events, loadRemote: 'running', stopAcknowledged: false,
    stopFailureReread: 'interrupted', terminateRunner: 'record' });
  const outcome = await createRescueLifecycleReconciler(fixture.adapters).reconcile({ intent: { kind: 'stop', cause: 'user' }, authority, workspace });
  assert.deepEqual(outcome, { kind: 'settled-terminal', status: 'cancelled', stopCause: 'user', resumable: true },
    'independent terminal interruption evidence substitutes for the failed stop acknowledgement');
  assert.equal(fixture.stopCalls, 1);
  assert.equal(events.filter((event) => event === 'reread-remote').length, 1,
    'one bounded reread observes the interruption despite the failed stop');
  assert.deepEqual(events, ['persist-stop-intent', 'revalidate-generation', 'stop-exact-turn', 'reread-remote', 'terminate-marked-runner', 'publish-cancelled']);
  assert.ok(events.indexOf('terminate-marked-runner') < events.indexOf('publish-cancelled'),
    'the required cleanup still precedes the cancelled publication');
});

test('a receipt-authorized observation pass probes its failed stop and settles the confirmed interruption', async () => {
  // SessionEnd receipt-authorized child-loss reconciliation supplies an
  // OBSERVE intent, yet holds STOP AUTHORITY for this exact job — the matching
  // receipt — and its stopExactTurn runs. Spec 4.2 (design lines 104-111):
  // independent interruption evidence substitutes for the failed stop
  // acknowledgement, and SessionEnd and child-loss use the same rules, so the
  // failed-stop probe is gated on that authority — never on the request intent
  // kind. With the interruption confirmed on the probe reread and the cleanup
  // verified, the job settles cancelled in THIS pass.
  const events = [];
  const fixture = fixtureAdapters({ events, receipt: 'matching', stopAcknowledged: false,
    stopFailureReread: 'interrupted', terminateRunner: 'record' });
  const outcome = await createRescueLifecycleReconciler(fixture.adapters).reconcile({ intent: { kind: 'observe' }, authority, workspace });
  assert.deepEqual(outcome, { kind: 'settled-terminal', status: 'cancelled', stopCause: 'session-end', resumable: true },
    'the independently confirmed interruption settles despite the failed stop');
  assert.equal(fixture.stopCalls, 1);
  assert.equal(events.filter((event) => event === 'reread-remote').length, 1, 'one bounded probe reread');
  assert.deepEqual(events, ['persist-stop-intent', 'revalidate-generation', 'stop-exact-turn', 'reread-remote', 'terminate-marked-runner', 'publish-cancelled']);
  assert.ok(events.indexOf('terminate-marked-runner') < events.indexOf('publish-cancelled'),
    'the required cleanup still precedes the cancelled publication');
});

test('a receipt-authorized observation pass with a failed stop and no independent interruption retains', async () => {
  // The counterpart: stop authority alone never manufactures a settlement.
  // With no independently confirmed interruption on the probe reread, the
  // failed stop keeps the retained cancelling guard exactly as before.
  const events = [];
  const fixture = fixtureAdapters({ events, receipt: 'matching', stopAcknowledged: false,
    remote: 'idle-empty', terminateRunner: 'record' });
  const outcome = await createRescueLifecycleReconciler(fixture.adapters).reconcile({ intent: { kind: 'observe' }, authority, workspace });
  assert.deepEqual(outcome, { kind: 'unresolved-stop', status: 'cancelling' },
    'without independent interruption evidence the failed stop keeps the retained guard');
  assert.equal(fixture.stopCalls, 1);
  assert.equal(events.some((event) => event.startsWith('publish-')), false);
  assert.ok(events.includes('terminate-marked-runner') && events.includes('retain-unresolved'));
});

test('a natural engine failure observed after a failed stop is never claimed as the stop-caused race winner', async () => {
  const events = [];
  // The stop itself fails and the one bounded reread observes a terminal
  // ENGINE FAILURE attributable to the current turn. Only independently
  // confirmed INTERRUPTION substitutes for a failed stop's acknowledgement
  // (spec 4.2): the natural failure keeps its own semantics — the next pass
  // publishes it from its initial joined read — and this pass retains the
  // guard behind the cleanup duty.
  const fixture = fixtureAdapters({ events, loadRemote: 'running', stopAcknowledged: false,
    stopFailureReread: 'failed', terminateRunner: 'record' });
  const outcome = await createRescueLifecycleReconciler(fixture.adapters).reconcile({ intent: { kind: 'stop', cause: 'user' }, authority, workspace });
  assert.deepEqual(outcome, { kind: 'unresolved-stop', status: 'cancelling' },
    'a failed stop cannot claim a post-stop engine terminal failure as its stop-caused race winner');
  assert.equal(fixture.stopCalls, 1);
  assert.equal(events.filter((event) => event === 'reread-remote').length, 1,
    'the bounded failed-stop reread still runs and observes the natural failure');
  assert.ok(events.includes('terminate-marked-runner') && events.includes('retain-unresolved'),
    'the cleanup duty still runs before the retained guard');
  assert.equal(events.some((event) => event.startsWith('publish-')), false,
    'the natural failure is published by the next pass from its initial read, never rewritten as cancellation here');
});

test('an acknowledged stop over a replaced upstream or without continuity proof cannot qualify', async () => {
  for (const stopUpstream of [undefined, 'replaced']) {
    const events = [];
    const fixture = fixtureAdapters({ events, loadRemote: 'running', remote: 'idle-empty',
      stopUpstream, terminateRunner: 'record' });
    const outcome = await createRescueLifecycleReconciler(fixture.adapters).reconcile({ intent: { kind: 'stop', cause: 'user' }, authority, workspace });
    assert.deepEqual(outcome, { kind: 'unresolved-stop', status: 'cancelling' },
      `${String(stopUpstream)}: the same session ID on a replaced upstream generation, or a bare acknowledgement with no continuity proof, never settles without a report`);
    assert.equal(fixture.stopCalls, 1, String(stopUpstream));
    assert.equal(events.some((event) => event.startsWith('publish-')), false, String(stopUpstream));
  }
});

test('an acknowledged stop with pending, failed, or unproven cleanup keeps the guard', async () => {
  for (const terminateRunner of ['pending', 'throws', 'unproven', 'budget-expired']) {
    const events = [];
    const fixture = fixtureAdapters({ events, loadRemote: 'running', remote: 'idle-empty',
      stopUpstream: 'same', terminateRunner });
    const outcome = await createRescueLifecycleReconciler(fixture.adapters).reconcile({ intent: { kind: 'stop', cause: 'user' }, authority, workspace });
    assert.deepEqual(outcome, { kind: 'unresolved-stop', status: 'cancelling' },
      `${terminateRunner}: only the completed-clean sweep permits the no-report settlement`);
    assert.equal(fixture.stopCalls, 1, terminateRunner);
    assert.ok(events.includes('terminate-marked-runner'), terminateRunner);
    assert.equal(events.some((event) => event.startsWith('publish-')), false, terminateRunner);
  }
});

test('pending-cleanup retention records a cleanup-specific diagnostic distinct from continued remote activity', async () => {
  // spec section 6: Status must distinguish incomplete executor cleanup from
  // the still-active contrary-evidence retention. The qualified no-report
  // branch's cleanup retention carries its own bounded cleanup diagnostic —
  // never the generic unresolved-stop message the still-active branch keeps.
  const cleanupEvents = [];
  const cleanupFixture = fixtureAdapters({ events: cleanupEvents, loadRemote: 'running', remote: 'idle-empty',
    stopUpstream: 'same', terminateRunner: 'pending' });
  await createRescueLifecycleReconciler(cleanupFixture.adapters).reconcile({ intent: { kind: 'stop', cause: 'user' }, authority, workspace });
  const cleanupMessage = String(cleanupFixture.retainedErrors.at(-1)?.message ?? '');
  assert.match(cleanupMessage, /cleanup did not complete/u,
    'the incomplete-cleanup retention names the cleanup, not the generic unresolved stop');
  const activeEvents = [];
  const activeFixture = fixtureAdapters({ events: activeEvents, loadRemote: 'running', remote: 'pending',
    stopUpstream: 'same', terminateRunner: 'record' });
  await createRescueLifecycleReconciler(activeFixture.adapters).reconcile({ intent: { kind: 'stop', cause: 'user' }, authority, workspace });
  const activeMessage = String(activeFixture.retainedErrors.at(-1)?.message ?? '');
  assert.match(activeMessage, /remains unresolved after the stop acknowledgement/u,
    'the still-active contrary-evidence retention keeps the generic unresolved-stop diagnostic');
  assert.notEqual(cleanupMessage, activeMessage,
    'incomplete cleanup and continued remote activity stay distinguishable (spec section 6)');
});

test('contrary post-stop evidence retains cancelling over the acknowledged stop', async () => {
  for (const [remote, why] of [['pending', 'the reread still shows the current turn executing'],
    ['unattributable', 'the reread is not attributable to the current turn (identity mismatch)']]) {
    const events = [];
    const fixture = fixtureAdapters({ events, loadRemote: 'running', remote, stopUpstream: 'same', terminateRunner: 'record' });
    const outcome = await createRescueLifecycleReconciler(fixture.adapters).reconcile({ intent: { kind: 'stop', cause: 'user' }, authority, workspace });
    assert.deepEqual(outcome, { kind: 'unresolved-stop', status: 'cancelling' },
      `${why}: acknowledgement cannot override contrary evidence`);
    assert.equal(fixture.stopCalls, 1, why);
    assert.equal(events.some((event) => event.startsWith('publish-')), false, why);
  }
});

test('a qualified acknowledgement settles cancelled over an unreadable reread, while a bare acknowledgement retains', async () => {
  // Spec 4.4: a reread READ FAILURE no longer independently vetoes a path
  // that already holds complete qualifying cancellation evidence — the
  // qualified exact-runtime acknowledgement plus the completed-clean sweep
  // publish cancelled without a final report.
  const qualifiedEvents = [];
  const qualified = fixtureAdapters({ events: qualifiedEvents, loadRemote: 'running', remote: 'unreadable',
    stopUpstream: 'same', terminateRunner: 'record' });
  assert.deepEqual(await createRescueLifecycleReconciler(qualified.adapters).reconcile({ intent: { kind: 'stop', cause: 'user' }, authority, workspace }),
    { kind: 'settled-terminal', status: 'cancelled', stopCause: 'user', resumable: true },
    'the completed cancellation procedure is not vetoed by an unreadable reread');
  assert.equal(qualified.stopCalls, 1);
  assert.equal(qualifiedEvents.filter((event) => event === 'reread-remote').length, 1, 'exactly one bounded reread');
  assert.ok(qualifiedEvents.indexOf('terminate-marked-runner') < qualifiedEvents.indexOf('publish-cancelled'),
    'verified executor cleanup still precedes the cancelled publication');

  // Control: the same unreadable reread under a BARE acknowledgement (no
  // continuity proof) keeps today's retention — the relaxation is exactly the
  // qualified evidence, never the read failure itself.
  const bare = fixtureAdapters({ loadRemote: 'running', remote: 'unreadable', terminateRunner: 'record' });
  assert.deepEqual(await createRescueLifecycleReconciler(bare.adapters).reconcile({ intent: { kind: 'stop', cause: 'user' }, authority, workspace }),
    { kind: 'unresolved-stop', status: 'cancelling' },
    'without the qualified acknowledgement the unreadable reread still retains the guard');
  assert.equal(bare.stopCalls, 1);
});

test('a failed initial read still attempts the exact stop, but the empty response cannot qualify', async () => {
  // Spec 5.4: a read failure must not unconditionally skip the stop for a
  // session with exact stop authority — the best-effort stop still runs; it
  // just cannot qualify for the no-report settlement without valid pre-stop
  // current-turn evidence.
  const events = [];
  const fixture = fixtureAdapters({ events, loadRemote: 'unreadable', remote: 'idle-empty',
    stopUpstream: 'same', terminateRunner: 'record' });
  const outcome = await createRescueLifecycleReconciler(fixture.adapters).reconcile({ intent: { kind: 'stop', cause: 'user' }, authority, workspace });
  assert.equal(fixture.stopCalls, 1, 'the authorized exact stop is still attempted after the initial read failure');
  assert.deepEqual(outcome, { kind: 'unresolved-stop', status: 'cancelling' },
    'without a valid pre-stop current-turn snapshot the empty stop response cannot qualify');
  assert.equal(events.some((event) => event.startsWith('publish-')), false);

  // A load that never joined remote evidence at all retains the same way.
  const noneEvents = [];
  const noneFixture = fixtureAdapters({ events: noneEvents, loadRemote: 'none', remote: 'idle-empty',
    stopUpstream: 'same', terminateRunner: 'record' });
  assert.deepEqual(await createRescueLifecycleReconciler(noneFixture.adapters).reconcile({ intent: { kind: 'stop', cause: 'user' }, authority, workspace }),
    { kind: 'unresolved-stop', status: 'cancelling' }, 'none');
  assert.equal(noneEvents.some((event) => event.startsWith('publish-')), false, 'none');
});
