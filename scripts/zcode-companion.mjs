#!/usr/bin/env node
import process from 'node:process';
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { closeSync as closeFdSync, realpathSync } from 'node:fs';
import { Socket } from 'node:net';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { join, resolve, sep } from 'node:path';

import { parseArgs, resolveModel } from './lib/args.mjs';
import { readCodexThread, readCodexThreadSpawnChild, readCodexThreadSpawnChildIdentity, sanitizeCodexThreadSpawnChild } from './lib/codex-app-server.mjs';
import { inspectRescueRoleStatus, runSetup } from './lib/codex-config.mjs';
import { PluginError } from './lib/errors.mjs';
import { atomicWriteJson, readBoundedJsonFile } from './lib/fs.mjs';
import { createIdentityStore } from './lib/identity.mjs';
import { createJobController, durableCancelledWinner, ownerIdForSession, readBoundRescueStatus, resumableJobIndicator, withJobCancellationLock } from './lib/job-control.mjs';
import { resolvePluginDataContext, resolvePluginDataRoot } from './lib/plugin-data.mjs';
import { publicErrorMessage } from './lib/public-text.mjs';
import { discoverZCode } from './lib/zcode-discovery.mjs';
import { createExistingManagedZCodeClient, createManagedZCodeClient } from './lib/zcode-client.mjs';
import { readZCodeCliRuntimeModel } from './lib/zcode-runtime-config.mjs';
import { acknowledgeBackgroundStartup, startBackgroundWorker } from './lib/background-worker.mjs';
import { createInvocationStore, parseRecordedInvocation, requiresExecutionChoice } from './lib/invocation.mjs';
import { canonicalExactReactivateActivation, createRescuePreparationStore, readRescuePreparation, RESCUE_ENVELOPE_MAX_BYTES } from './lib/rescue-preparation.mjs';
import { hostOwnedCancelledPatch, hostOwnedStopIntentPatch, rescueBindingAuthorityView, STOP_CAUSES, validHostLifecycleRecord, validStopIntent } from './lib/rescue-binding.mjs';
import { createRescueLifecycleReconciler } from './lib/rescue-lifecycle.mjs';
import { planRescueActivation, validateRescueRouteDirective } from './lib/rescue-route-planner.mjs';
import { executeJob, extractFinalResult, publishSuccessfulResultWithLockHeld, readResultArtifact, ResumeFailureSettlementError } from './lib/review.mjs';
import { cancelJob as cancelRecoveryJob, completeEndedJob, endedRemoteEvidence, failJob as failRecoveryJob, reconcileOwnedJobs, scavengeWritableJobs, unavailableOrReadableEvidence, withWorkerLease } from './lib/recovery.mjs';
import { errorEnvelope, renderOutput } from './lib/render.mjs';
import { createForegroundSignalController } from './lib/signals.mjs';
import { serializeRescueProgressRelay } from './lib/rescue-progress-relay.mjs';
import { legacyRescueMigrationRollbackFromSpec, parseExactLegacyJobSpecRecord, readQueuedRescueMigrationRollback, resolveQueuedRescueMigrationRollback } from './lib/rescue-migration.mjs';
import { createStateStore, resumableHostOwnedCancellation, validProgressProbe } from './lib/state.mjs';
import { resolveWorkspaceStorage } from './lib/workspace.mjs';
import { readWorkspaceModelConfig, summarizeWorkspaceModelConfig } from './lib/workspace-config.mjs';
import { executeTransfer, resolveTransferSource, TRANSFER_WIRE_LIMITS } from './lib/transfer.mjs';
import { reconcileBrokerOwnership } from './zcode-broker.mjs';
import { assertNoPendingPriorEpochReceipts, claimNotificationForJob, finalizeNotifications, pendingPriorEpochReceipts, priorEpochUnsettledError, recordedSessionStartPair, reconcilePriorEpochReceipts, releaseNotifications, resolveRecordedSessionStart, resolveRoutedForwardingExecutor } from '../hooks/lib/hook-state.mjs';

const backgroundBindings = new WeakMap();
const rescueChoiceRoutes = new WeakMap();
const activeCompanionPath = fileURLToPath(import.meta.url);
const activeRescueLauncherPath = fileURLToPath(new URL('../skills/rescue/launcher.mjs', import.meta.url));
const activePluginRoot = realpathSync(fileURLToPath(new URL('../', import.meta.url)));
const MANAGED_ROLE_STATUSES = new Set(['ready', 'restart-required', 'install-required', 'upgrade-required', 'drift', 'foreign-conflict', 'project-shadowed', 'higher-precedence-conflict', 'unsupported']);
const SOURCE_SESSION_REMEDY = 'Use the instance-bound Rescue launcher from the active lifecycle context; do not run setup from this source checkout.';
const ROLE_REMEDIES = /** @type {Readonly<Record<string,string>>} */ (Object.freeze({
  'source-session-unproven': SOURCE_SESSION_REMEDY,
  'caller-unavailable': 'Retry from an active owned parent turn.',
  'inspection-unavailable': 'Retry Role preflight.',
}));
const SAFE_BOUND_STATUS_ERRORS = new Set([
  'ACTIVE_TURN_EXPIRED', 'ACTIVE_TURN_NOT_FOUND', 'BOUND_RESCUE_STATUS_INPUT_INVALID',
  'BOUND_RESCUE_STATUS_NOT_FOUND', 'BOUND_RESCUE_STATUS_UNAVAILABLE',
  'EXECUTOR_IDENTITY_AMBIGUOUS', 'EXECUTOR_IDENTITY_EXPIRED', 'EXECUTOR_IDENTITY_INVALID',
  'EXECUTOR_IDENTITY_NOT_FOUND', 'EXECUTOR_PARENT_TURN_MISMATCH', 'EXECUTOR_ROLE_UNAPPROVED',
  'EXECUTOR_ROUTE_INVALID', 'EXECUTOR_ROUTE_NOT_FOUND', 'EXECUTOR_STATE_MISMATCH',
]);

/** @param {string[]} argv @param {{cwd?:string,env?:NodeJS.ProcessEnv,authorization?:Record<string,unknown>,dependencies?:any,caller?:any,creatorAuthority?:any,executor?:any,authority?:any,legacyActivation?:boolean,rescueRoute?:any,rescueActivationKind?:string,startupAck?:()=>Promise<void>,originalPrompt?:string,autoLaunchBackground?:boolean,progressWriter?:(line:string)=>void,progressRelayWriter?:(record:{sequence:number,phase:string,code:string,observedAt:string})=>void|Promise<void>,progressDependencies?:any,signal?:AbortSignal}} [runtime] */
export async function runCompanion(argv, runtime = {}) {
  const cwd = runtime.cwd ?? process.cwd(); const env = runtime.env ?? process.env;
  const pluginRoot = activePluginRoot; const parsed = parseArgs(argv); const pluginData = resolvePluginDataContext({ env, pluginRoot, entryPath: invocationEntryPath() }); const { dataRoot } = pluginData;
  if (parsed.command === 'setup') {
    let activeTurn;
    try { activeTurn = await createIdentityStore({ dataRoot }).resolveOnlyActiveTurn({ workspace: cwd }); }
    catch (error) { throw sourceSetupSessionError(error, pluginData.provenance); }
    let session;
    try { session = await resolveRecordedSessionStart(dataRoot, cwd, activeTurn.sessionId); }
    catch (error) { throw sourceSetupRecordedSessionError(error, pluginData.provenance); }
    return runSetup({ pluginRoot, dataRoot, cwd, reviewGate: parsed.options.reviewGate, sessionStartedAt: session.startedAt, env, codex: codexAppServerOptions(env, cwd), dependencies: runtime.dependencies });
  }
  if (parsed.command === 'role-status') {
    let inspection; let inspectionStarted = false; let failure;
    try {
      if (runtime.dependencies?.inspectRescueRoleStatus) { inspectionStarted = true; inspection = await runtime.dependencies.inspectRescueRoleStatus({ pluginRoot, dataRoot, cwd, env }); }
      else {
        if (typeof env.CODEX_THREAD_ID !== 'string' || !env.CODEX_THREAD_ID) throw new PluginError('AMBIENT_THREAD_UNAVAILABLE', 'The ambient Codex thread is unavailable.', { category: 'authorization', remedy: 'Invoke Rescue from one active Codex parent turn.' });
        const installed = pluginData.provenance === 'marketplace';
        const activeTurn = await createIdentityStore({ dataRoot }).resolveActiveTurn({
          sessionId: env.CODEX_THREAD_ID,
          workspace: cwd,
          ...(installed ? { workspaceBinding: 'preview' } : {}),
        });
        const session = await resolveRecordedSessionStart(dataRoot, installed ? activeTurn.originWorkspace ?? cwd : cwd, activeTurn.sessionId);
        inspectionStarted = true;
        inspection = await inspectRescueRoleStatus({ pluginRoot, dataRoot, cwd, sessionStartedAt: session.startedAt, env, codex: codexAppServerOptions(env, cwd) });
      }
    } catch (error) {
      failure = error;
    }
    const status = failure
      ? roleFailureStatus({ error: failure, provenance: pluginData.provenance, inspectionStarted })
      : inspection?.status === 'inspection-unavailable'
        ? 'inspection-unavailable'
        : MANAGED_ROLE_STATUSES.has(inspection?.status) ? inspection.status : 'inspection-unavailable';
    return { type: 'role-status', role: 'zcode-rescue', status, ...(status === 'ready' ? {} : { remedy: ROLE_REMEDIES[status] ?? '$zcode:setup' }) };
  }
  const identity = createIdentityStore({ dataRoot });
  const store = (runtime.dependencies?.createStateStore ?? createStateStore)({ dataRoot });
  if (parsed.command === 'run-reserved-job') return runReserved({ parsed, cwd, env, dataRoot, identity, store, authorization: requireAuthorization(runtime.authorization, ['executionCapability', 'jobId']), startupAck: runtime.startupAck, dependencies: runtime.dependencies, signal: runtime.signal });
  const caller = runtime.caller ?? await identity.consumeCallerContext(requireAuthorization(runtime.authorization, ['callerContext']).callerContext, { workspace: cwd });
  const reconcile = () => reconcileOwnedJobs({ store, dataRoot, workspace: cwd, ownerSessionId: caller.sessionId, createClient: async (/** @type {any} */ job, ownerId) => {
    runtime.signal?.throwIfAborted();
    const launch = await discoverLaunch(env);
    return (runtime.dependencies?.createManagedZCodeClient ?? createManagedZCodeClient)({ dataRoot, workspace: cwd, launch, ownerId, env, ...managedWireOptionsForJob(job) });
  } });
  const reconcileRescueLifecycle = createManagementRescueReconcile({ store, dataRoot, workspace: cwd, ownerSessionId: caller.sessionId,
    // Observe intents are existing-broker-only (design lines 147/341): a
    // read-only Status/Result must never launch ZCode — when the original
    // broker is unavailable the reconciler retains the current guard instead.
    // Stop and wait intents own mutation authority and may use the launch-
    // capable client so a persisted stop can actually be retried.
    createClient: async (/** @type {any} */ job, /** @type {string} */ ownerId, /** @type {any} */ intent) => {
      runtime.signal?.throwIfAborted();
      if (intent?.kind === 'observe') {
        const existing = await (runtime.dependencies?.createExistingManagedZCodeClient ?? createExistingManagedZCodeClient)({ dataRoot, workspace: cwd, ownerId, requestTimeoutMs: existingBrokerRequestTimeoutMs });
        if (existing === null) throw new PluginError('ZCODE_DISCONNECTED', 'The existing ZCode broker is unavailable.', { category: 'runtime', remedy: 'Retry when the original broker is reachable.' });
        return existing;
      }
      const launch = await discoverLaunch(env);
      return (runtime.dependencies?.createManagedZCodeClient ?? createManagedZCodeClient)({ dataRoot, workspace: cwd, launch, ownerId, env, ...managedWireOptionsForJob(job) });
    },
    createRescueLifecycleReconciler: runtime.dependencies?.createRescueLifecycleReconciler ?? createRescueLifecycleReconciler });
  // Selection reconciliations without their own signal (e.g. the cancel
  // election inside the lock) run under the bounded observation budget; wait
  // passes its own deadline-scoped signal through unchanged.
  const controller = createJobController({ store, dataRoot, reconcile: (/** @type {any} */ request) => reconcileRescueLifecycle(request.signal ? request : { ...request, signal: boundedObservationSignal(runtime) }), beforeWaitPoll: reconcile });
  // Resume after SessionEnd: block new Rescue work behind unresolved prior-epoch
  // reconciliation BEFORE any reservation-time recovery can touch the uncertain
  // prior-epoch records. Status, result, and cancel keep their existing recovery
  // behavior and remain available.
  if (parsed.command === 'rescue') await rejectUnsettledPriorEpoch({ dataRoot, caller, cwd, signal: runtime.signal });
  // Management commands drive the same bounded prior-epoch retry (without the
  // hard block): terminalizing an old job through cancel/status recovery must
  // also settle that epoch's pending lifecycle receipt, or future Rescue work
  // stays blocked behind an already-settled obligation.
  if (typeof caller?.sessionId === 'string' && ['status', 'result', 'cancel'].includes(parsed.command)) {
    try { await reconcilePriorEpochReceipts({ dataRoot, sessionId: caller.sessionId, workspace: cwd, signal: boundedObservationSignal(runtime), budgetMs: 1_500 }); }
    catch { /* status/result/cancel remain available even when the retry cannot run */ }
  }
  await reconcile();
  if (parsed.command === 'status') {
    const modelPolicy = summarizeWorkspaceModelConfig(await readWorkspaceModelConfig({ dataRoot, workspace: cwd }));
    if (parsed.options.all) return { jobs: (await store.listJobs(cwd)).map((/** @type {any} */ job) => publicJob(job, caller.sessionId, 'list')), modelPolicy };
    let job = await controller.selectOwned(cwd, caller.sessionId, parsed.positionals[0], 'status', { signal: boundedObservationSignal(runtime) });
    if (parsed.options.wait) job = await controller.wait(cwd, job.id, caller.sessionId, { timeoutMs: parsed.options.timeoutMs, ...(runtime.signal ? { signal: runtime.signal } : {}) });
    return { job: publicJob(job, caller.sessionId, 'detail', caller.permissionMode, await bindingCurrencyEvidence(store, cwd, caller.sessionId, job)), modelPolicy };
  }
  if (parsed.command === 'result') {
    const job = await controller.selectOwned(cwd, caller.sessionId, parsed.positionals[0], 'result', { signal: boundedObservationSignal(runtime) });
    if (MANAGEMENT_TERMINAL_STATUSES.has(job.status)) {
      if (job.status === 'succeeded') {
        if (!job.resultArtifact) throw new PluginError('ZCODE_RESULT_MISSING', `Job ${job.id} succeeded without a stored result artifact.`, { category: 'state', remedy: `Run $zcode:status ${job.id} to inspect the completed job.`, details: { jobId: job.id, status: job.status } });
        return { job: terminalResultJob(job, caller.permissionMode, await bindingCurrencyEvidence(store, cwd, caller.sessionId, job)), result: await readResultArtifact({ dataRoot, workspace: cwd, artifact: job.resultArtifact }) };
      }
      return { job: terminalResultJob(job, caller.permissionMode, await bindingCurrencyEvidence(store, cwd, caller.sessionId, job)) };
    }
    throw new PluginError('JOB_RESULT_UNFINISHED', `Job ${job.id} is ${job.status}.`, { category: 'state', remedy: `Run $zcode:status ${job.id} --wait.`, details: { jobId: job.id, status: job.status } });
  }
  if (parsed.command === 'cancel') {
    const selected = await controller.selectOwned(cwd, caller.sessionId, parsed.positionals[0], 'cancel', { signal: boundedObservationSignal(runtime) });
    if (!['running', 'cancelling'].includes(selected.status)) {
      const job = await controller.cancel(cwd, selected.id, caller.sessionId);
      if (job.command === 'rescue' && job.status === 'cancelled') await store.closeRescueBindingForCancelledJob({ workspace: cwd, parentSessionId: caller.sessionId, jobId: job.id });
      return { job };
    }
    // The control client is created lazily on first remote use, so the
    // durable stop intent is always persisted by reconciliation before any
    // launcher discovery or client acquisition can fail (persist-before-control).
    /** @type {any} */
    let client;
    const ensureClient = async () => {
      if (!client) {
        runtime.signal?.throwIfAborted(); const launch = await discoverLaunch(env);
        client = await (runtime.dependencies?.createManagedZCodeClient ?? createManagedZCodeClient)({ dataRoot, workspace: cwd, launch, ownerId: ownerIdForSession(caller.sessionId), env, ...managedWireOptionsForJob(selected) });
      }
      return client;
    };
    const cancelling = createJobController({ store, dataRoot,
      // The cancel-side reconciliation runs under the bounded observation
      // signal like every other selection, so a stalled control channel can
      // neither outlive the command nor block SIGINT.
      reconcile: (/** @type {any} */ request) => reconcileRescueLifecycle({ ...request, signal: boundedObservationSignal(runtime) }),
      stopSession: async (sessionId) => (await ensureClient()).stopSession(sessionId),
      readSession: async (sessionId) => (await ensureClient()).readSession(sessionId),
      publishSucceededSnapshot: async ({ workspace, job, snapshot, turnBoundary }) => {
        const result = extractFinalResult(snapshot, job.command, turnBoundary);
        return (await publishSuccessfulResultWithLockHeld({
          input: { store }, job, workspace, dataRoot, result, expectedStatuses: ['cancelling'], returnTerminalWinner: true,
        })).job;
      } });
    try {
      const job = await cancelling.cancel(cwd, selected.id, caller.sessionId);
      if (job.command === 'rescue' && job.status === 'cancelled') await store.closeRescueBindingForCancelledJob({ workspace: cwd, parentSessionId: caller.sessionId, jobId: job.id });
      return { job };
    }
    finally { await client?.close().catch(() => {}); }
  }
  return startPublic({ parsed, caller, creatorAuthority: runtime.creatorAuthority, cwd, env, dataRoot, identity, store, controller, executor: runtime.executor, authority: runtime.authority, legacyActivation: runtime.legacyActivation, rescueRoute: runtime.rescueRoute, rescueActivationKind: runtime.rescueActivationKind, dependencies: runtime.dependencies, originalPrompt: runtime.originalPrompt, autoLaunchBackground: runtime.autoLaunchBackground, progressWriter: runtime.progressWriter, progressRelayWriter: runtime.progressRelayWriter, progressDependencies: runtime.progressDependencies, signal: runtime.signal });
}

const MANAGEMENT_TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'cancelled']);

/**
 * Derive the exact binding-currency evidence one terminal management view
 * needs: only a succeeded, failed, or cancelled writable Rescue consults the
 * owner's binding partition, proving the active binding still anchors this
 * exact job — once a continuation advances the binding, the older job is no
 * longer the resume target. Every other view skips the lookup; an unreadable
 * partition fails closed instead of failing the whole view.
 * @param {any} store @param {string} workspace @param {string} ownerSessionId @param {any} job
 * @returns {Promise<boolean|undefined>}
 */
async function bindingCurrencyEvidence(store, workspace, ownerSessionId, job) {
  if (!job || job.command !== 'rescue' || job.readOnly !== false || !['succeeded', 'failed', 'cancelled'].includes(job.status)) return undefined;
  try {
    if (await store.rescueBindingPointsAtJob({ workspace, ownerSessionId, jobId: job.id })) return true;
    // Binding history belongs to BOUND candidates: an unbound (legacy) job is
    // never superseded by other children's active or closed bindings —
    // resumeCandidate deliberately retains legacy resume eligibility for it,
    // so the indicator must agree and report resumable for the same job.
    // Missing binding evidence is non-resumable even for legacy/unbound
    // records: fabricated currency could advertise a session without the
    // exact current binding the design requires.
    if (job.rescueReservationKind !== 'bound') return false;
    // A bound candidate's whole truth is the anchor: an active binding still
    // pointing at this exact job proves resumability; anything else — active
    // elsewhere, ambiguous, closed history, or records removed by binding GC —
    // leaves the binding evidence unproven and fails closed.
    return await store.rescueBindingPointsAtJob({ workspace, ownerSessionId, jobId: job.id }).catch(() => false);
  } catch { return false; }
}

/**
 * Bind one exact management caller to the Rescue Lifecycle Reconciler. Status,
 * Result, and status --wait observe through this seam; Cancel persists its
 * durable stop intent here before the cancellation election takes remote
 * control. The seam is writable-Rescue-specific (ADR 0020): read-only Review
 * and Adversarial jobs never enter the Reconciler and keep the existing
 * cancellation election, journal, and owner-recovery semantics. Wired adapters:
 * the exact owned joined state, durable stop-intent persistence, rollback-aware
 * queued settlement, and guard-preserving retention. Deferred adapters
 * (fail-closed defaults): remote stop/reread, generation revalidation, and
 * unavailable-executor settlement stay owned by the existing cancellation
 * election and owner recovery until the lifecycle hooks (Tasks 5-7) publish
 * Host child observation and SessionEnd receipts; the joined Host state
 * therefore stays 'idle' with no receipt evidence, so management observation
 * never authorizes a stop on its own.
 * @param {{store:any,dataRoot:string,workspace:string,ownerSessionId:string,createClient?:(job:any,ownerId:string,intent?:any)=>Promise<any>,createRescueLifecycleReconciler:(adapters:any)=>{reconcile:(request:any)=>Promise<any>}}} input
 */
function createManagementRescueReconcile(input) {
  /** One management reconciliation context: the exact joined job, the on-demand control client, and the revalidation guard. @type {{job:any,client?:any,guard?:any}} */
  const context = { job: undefined };
  const reconciler = input.createRescueLifecycleReconciler({
    loadJoinedState: (/** @type {any} */ request) => loadManagementJoinedState(input, context, request),
    persistStopIntent: (/** @type {any} */ joined, /** @type {string} */ cause, /** @type {any} */ options) => persistManagementStopIntent(input, joined, cause, options),
    revalidateGeneration: async (/** @type {any} */ joined, /** @type {any} */ options) => {
      options?.signal?.throwIfAborted();
      // Mirror the SessionEnd adapter's exact revalidation through the shared
      // StateStore seam; a missing store method can only fail closed as stale.
      const job = joined.job;
      if (job.rescueReservationKind !== 'bound' || typeof input.store.revalidateBoundRescueStop !== 'function') {
        return { kind: 'stale', winner: await input.store.readJob(input.workspace, job.id) };
      }
      const revalidated = await input.store.revalidateBoundRescueStop({ workspace: input.workspace, jobId: job.id,
        ownerSessionId: job.ownerSessionId, status: job.status, zcodeSessionId: job.zcodeSessionId,
        ...(job.workerLeaseId ? { workerLeaseId: job.workerLeaseId } : {}),
        ...(context.guard === undefined || context.guard === null ? {} : { expected: context.guard }) });
      if (revalidated?.kind === 'stale') return { kind: 'stale', winner: revalidated.job };
      context.guard = revalidated?.guard ?? context.guard ?? null;
      context.job = revalidated?.job ?? job;
      return { kind: 'current', job: context.job, guard: context.guard };
    },
    stopExactTurn: async (/** @type {any} */ joined, /** @type {any} */ options) => {
      // Pre-stop read: a turn that already reached a terminal outcome BEFORE
      // this stop keeps its own semantics instead of being misclassified as
      // caused by the stop. The read reuses the already-open control client.
      try {
        const preStop = endedRemoteEvidence(await raceControlOperation(context.client.readSession(joined.job.zcodeSessionId), options?.signal), joined.job);
        if (preStop.kind === 'evidence' && (preStop.classification === 'succeeded' || preStop.classification === 'failed')) {
          return { acknowledged: true, preExistingTerminal: preStop };
        }
      } catch { /* an unreadable pre-stop read never blocks the exact stop */ }
      options?.signal?.throwIfAborted();
      try {
        await raceControlOperation(context.client.stopSession(joined.job.zcodeSessionId), options?.signal);
        options?.signal?.throwIfAborted();
        return { acknowledged: true };
      } catch (error) {
        options?.signal?.throwIfAborted();
        return { acknowledged: false, error };
      }
    },
    rereadRemote: async (/** @type {any} */ joined, /** @type {any} */ options) => {
      options?.signal?.throwIfAborted();
      let snapshot;
      try { snapshot = await raceControlOperation(context.client.readSession(joined.job.zcodeSessionId), options?.signal); }
      catch (error) { options?.signal?.throwIfAborted(); return { kind: 'unreadable', error }; }
      options?.signal?.throwIfAborted();
      return endedRemoteEvidence(snapshot, joined.job);
    },
    publishWinner: (/** @type {any} */ joined, /** @type {any} */ specification, /** @type {any} */ options) => publishManagementWinner(input, joined, specification, options),
    retainUnresolved: async (/** @type {any} */ joined, /** @type {any} */ evidence) => {
      // Persist a bounded retry diagnostic only when an actual remote failure
      // was observed — the first pass of a cancel reaches this adapter before
      // any remote operation (remote none), and writing a failure there would
      // mislabel a later successful cancellation. The durable intent plus this
      // diagnostic are the recovery evidence status/wait convergence reads.
      if (evidence?.error !== undefined) {
        const message = evidence.error instanceof Error ? evidence.error.message.slice(0, 2048)
          : 'The remote stop remains unresolved; reconciliation will retry the persisted stop intent.';
        try {
          await input.store.transitionJob(input.workspace, joined.job.id, ['cancelling'], 'cancelling', { lastCancelError: message });
        } catch { /* the record may have settled concurrently; the reread below is authoritative */ }
      }
      return input.store.readJob(input.workspace, joined.job.id);
    },
    // Executor absence is never provable from the management caller: a live
    // host child may still hold its worker lease, so an unavailable control
    // channel retains the durable guard — while persisting the bounded
    // diagnostic, the same retainUnresolved discipline.
    settleUnavailableExecutor: async (/** @type {any} */ joined, /** @type {any} */ evidence) => {
      const message = 'The ZCode control channel is unavailable; reconciliation will retry the persisted stop intent.';
      try {
        await input.store.transitionJob(input.workspace, joined.job.id, ['cancelling'], 'cancelling', { lastCancelError: evidence?.error instanceof Error ? evidence.error.message.slice(0, 2048) : message });
      } catch { /* the record may have settled concurrently; the reread is authoritative */ }
      return input.store.readJob(input.workspace, joined.job.id);
    },
  });
  return async (/** @type {any} */ request) => {
    // The owned selection itself reports an unreadable or foreign job exactly;
    // reconciliation never widens that miss into a different diagnostic.
    if (request?.workspace !== input.workspace || typeof request.selector?.jobId !== 'string') return null;
    const selected = await input.store.readJob(input.workspace, request.selector.jobId).catch(() => null);
    if (selected === null || selected.ownerSessionId !== input.ownerSessionId) return null;
    // The Rescue Lifecycle Reconciler owns Host-managed writable Rescue only:
    // read-only jobs stay on the legacy election and journal paths, and a
    // pre-upgrade (legacy) record lacks the stop-intent schema the Reconciler
    // reasons over — routing one through it would misclassify an interrupted
    // historical cancellation as an engine failure. Legacy records keep the
    // exact historical status/result/cancel behavior (ADR 0018 lines 11-13).
    if (selected.command !== 'rescue' || selected.readOnly !== false
      || selected.ownerLifecycleEpoch === undefined && selected.stopIntent === undefined) return null;
    context.job = selected; context.guard = undefined;
    const run = async () => {
      try {
        return await reconciler.reconcile(request);
      } finally {
        await context.client?.close().catch(() => {});
        context.client = undefined;
      }
    };
    // Natural-success publication (and any remote observation) is serialized
    // under the job cancellation lock so it cannot race a concurrent
    // terminalization and strand an artifact — EXCEPT the stop intent, whose
    // only caller (the cancel election) already holds that non-reentrant lock.
    if (request.intent?.kind === 'stop') return run();
    return withJobCancellationLock({ dataRoot: input.dataRoot, workspace: input.workspace, jobId: selected.id }, run);
  };
}

const managementObservationBudgetMs = 2_500;
const existingBrokerRequestTimeoutMs = process.platform === 'win32' ? 500 : 250;

/** The caller-scoped signal that distinguishes a genuine command abort (SIGINT)
 * from a stalled local observation: only the caller's own abort reaches the
 * reconciler's request.signal (so its post-load throwIfAborted reflects user
 * cancellation), while each control operation applies its own bounded
 * observation budget inside the reconciler adapters. @param {{signal?:AbortSignal}} runtime */
function boundedObservationSignal(runtime) {
  return runtime.signal;
}

/** Race one remote control operation against its abort signal so a stuck read or stop can never outlive the reconciliation budget; the abandoned operation's late rejection is absorbed. @param {Promise<any>} operation @param {AbortSignal|undefined} signal */
function raceControlOperation(operation, signal) {
  operation.catch(() => {});
  if (signal === undefined) return operation;
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    if (signal.aborted) { onAbort(); return; }
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then((value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
      (error) => { signal.removeEventListener('abort', onAbort); reject(error); });
  });
}

/**
 * Join the exact owned durable record into the bounded lifecycle view. Stop
 * and wait intents on a live accepted Host-owned session additionally create
 * one on-demand control client and join its exact remote-turn evidence — the
 * same read the SessionEnd settlement performs — so a persisted stop intent
 * can be retried even while the live host child holds its worker lease.
 * Observe intents stay client-free: read-only views never spin a broker.
 * @param {{store:any,dataRoot:string,workspace:string,createClient?:(job:any,ownerId:string,intent?:any)=>Promise<any>}} input @param {{job?:any,client?:any}} context @param {any} request
 */
async function loadManagementJoinedState(input, context, request) {
  const job = await input.store.readJob(input.workspace, request.selector.jobId);
  const acceptedSession = typeof job.zcodeSessionId === 'string';
  const remote = await loadManagementRemoteEvidence(input, context, request, job);
  return {
    job,
    winner: MANAGEMENT_TERMINAL_STATUSES.has(job.status) ? job : null,
    hostState: 'idle',
    hostPlacement: job.hostPlacement ?? null,
    hostOwned: job.command === 'rescue' && job.readOnly === false ? validHostLifecycleRecord(job) : false,
    sessionEndReceipt: null,
    stopIntent: job.stopIntent ?? null,
    resumableEvidence: {
      acceptedSession,
      // The exact binding stays current by the Task 2 settlement invariant: a
      // Host-owned cancelled winner with an accepted session preserved its
      // binding, while a historical cancel closed it.
      bindingCurrent: acceptedSession && (job.status !== 'cancelled' || validHostLifecycleRecord(job)),
      // The binding snapshot equals this job's reservation snapshot by construction; the exact current permission mode is proven again at the authorized resume.
      permissionMatch: true,
    },
    remote,
    // A persisted stop intent is durable authorization, NOT evidence that a
    // stop occurred — the joined state never claims post-stop semantics; the
    // reconciler's stopExactTurn pre-stop read owns pre-existing-failure
    // classification within a pass.
    guard: null,
  };
}

/**
 * Create one bounded control client and join the exact remote-turn evidence.
 * Stop and wait intents always join remote evidence — persist-before-control
 * is preserved because the Reconciler persists the durable stop intent before
 * its first remote-control adapter runs; control acquisition only happens
 * here for jobs already carrying that durable authorization or receiving it
 * in this reconciliation. Observe intents stay read-only except for one case:
 * a cancelling job with a PERSISTED stop intent is an unresolved stop, and the
 * documented Status/Result recovery entry points must retry its exact
 * stop/reread rather than retaining it forever. Terminal, queued, and
 * sessionless jobs keep the inert no-remote view.
 * @param {{dataRoot:string,workspace:string,createClient?:(job:any,ownerId:string,intent?:any)=>Promise<any>}} input @param {{client?:any}} context @param {any} request @param {any} job
 */
async function loadManagementRemoteEvidence(input, context, request, job) {
  // Observe intents join exact remote evidence for every live Host-owned
  // session: ordinary Status/Result must read and publish a durable winner
  // that finished while the record stayed nonterminal (e.g. a stalled child
  // still holding its lease), not report the stale nonterminal job forever.
  if (MANAGEMENT_TERMINAL_STATUSES.has(job.status) || job.status === 'queued') return { kind: 'none' };
  if (request.intent?.kind !== 'observe' && request.intent?.kind !== 'stop' && request.intent?.kind !== 'wait') return { kind: 'none' };
  if (request.intent?.kind === 'stop' && job.status === 'running' && !validStopIntent(job.stopIntent)) {
    // Persist-before-control: a stop intent on a not-yet-cancelling job is
    // persisted by persistStopIntent BEFORE any control client is opened, so
    // a hanging discovery/read can never leave the durable authorization
    // unrecorded. Return no remote evidence on this load; the persisted
    // intent drives the stop adapters on the next pass.
    return { kind: 'none' };
  }
  if (typeof job.zcodeSessionId !== 'string' || typeof input.createClient !== 'function') return { kind: 'none' };
  /** @type {any} */ let client;
  try {
    // Bounded acquisition: a stalled broker startup or client creation must
    // observe the reconciliation signal like any other control operation. A
    // client that resolves after abandonment is closed immediately, so
    // repeated timed-out operations never leak broker connections.
    // A per-operation budget composes the caller's signal with a fixed local
    // timeout: a caller abort promptly ends the acquisition, while a local
    // timeout leaving the (unmutated) shared request signal live still lets
    // the reconciler process the unavailable evidence and render the durable
    // job instead of failing the whole command.
    const operationBudget = request.signal ? AbortSignal.any([request.signal, AbortSignal.timeout(managementObservationBudgetMs)]) : AbortSignal.timeout(managementObservationBudgetMs);
    const acquisition = Promise.resolve().then(() => input.createClient?.(job, ownerIdForSession(job.ownerSessionId), request.intent));
    const acquired = raceControlOperation(acquisition, operationBudget);
    // Cleanup keys on RACE abandonment, not the outer signal state: the
    // operation budget can abandon the race while a longer caller budget
    // (e.g. status --wait) keeps the request signal live — the late client
    // must still be closed so repeated polls never leak broker connections.
    let raceAbandoned = false;
    acquired.catch(() => { raceAbandoned = true; });
    acquisition.then((lateClient) => {
      if (raceAbandoned && lateClient) lateClient.close?.().catch(() => {});
    }).catch(() => {});
    client = await acquired;
  } catch (error) {
    return unavailableOrReadableEvidence(error);
  }
  if (!client) return { kind: 'unavailable', error: managementReconcileError('The management control client is unavailable.') };
  context.client = client;
  let snapshot;
  try { snapshot = await raceControlOperation(client.readSession(job.zcodeSessionId), request.signal ? AbortSignal.any([request.signal, AbortSignal.timeout(managementObservationBudgetMs)]) : AbortSignal.timeout(managementObservationBudgetMs)); }
  catch (error) { return unavailableOrReadableEvidence(error); }
  return endedRemoteEvidence(snapshot, job);
}

/** Persist the durable stop intent before any remote control, mirroring the election's own transition order. @param {{store:any,dataRoot:string,workspace:string}} input @param {any} joined @param {string} cause @param {{signal?:AbortSignal}} [options] */
async function persistManagementStopIntent(input, joined, cause, options) {
  options?.signal?.throwIfAborted();
  if (joined.job.status === 'queued') return { kind: 'persisted', job: joined.job };
  const current = await input.store.readJob(input.workspace, joined.job.id);
  if (MANAGEMENT_TERMINAL_STATUSES.has(current.status)) return { kind: 'conflict', winner: current };
  if (current.status === 'cancelling') return { kind: 'persisted', job: current };
  try {
    const cancelling = await input.store.transitionJob(input.workspace, current.id, ['running'], 'cancelling', {
      ...(current.lastCancelError ? { lastCancelError: null } : {}),
      ...hostOwnedStopIntentPatch(current, cause),
    });
    return { kind: 'persisted', job: cancelling };
  } catch (error) {
    const winner = await managementConflictWinner(input, current, error);
    return { kind: 'conflict', winner, resumableEvidence: { acceptedSession: typeof winner.zcodeSessionId === 'string', bindingCurrent: false, permissionMatch: true } };
  }
}

/** Publish only the rollback-aware unclaimed queued stop, exactly as the election's own queued branch; a claimed queued reservation defers to the election's worker-start guard; reconciler-settled queued cancels bypass the cancel-attempt journal/cancellation lock here because durable terminality is authoritative. @param {{store:any,dataRoot:string,workspace:string}} input @param {any} joined @param {any} specification @param {{signal?:AbortSignal}} [options] */
async function publishManagementWinner(input, joined, specification, options) {
  options?.signal?.throwIfAborted();
  // Remote-settled winners publish through the same recovery publication
  // helpers the SessionEnd settlement uses, so a retried stop settles the
  // durable winner even while the live host child holds its worker lease.
  if (joined.job.status !== 'queued') {
    if (specification.status === 'cancelled') return cancelRecoveryJob(input, joined.job, specification.stopCause);
    if (specification.status === 'succeeded') {
      const completed = await completeEndedJob(input, joined.job, specification.snapshot, undefined);
      return completed ?? joined.job; /* completion unproven: uncertainty never publishes a terminal claim */
    }
    return failRecoveryJob(input, joined.job, managementReconcileError(specification.message ?? 'The remote ZCode turn failed during management reconciliation.'));
  }
  if (specification.status !== 'cancelled' || joined.job.workerLeaseId !== undefined) return joined.job;
  const job = joined.job;
  const rollback = await readQueuedRescueMigrationRollback({ dataRoot: input.dataRoot, workspace: input.workspace, job, store: input.store,
    invalid: () => managementReconcileError('Queued migration specification is invalid.') });
  try {
    return rollback
      ? await input.store.finishSessionEndedRescueContinuation(input.workspace, job.id, rollback, 'cancelled', { exitCode: null, ...hostOwnedCancelledPatch(job, specification.stopCause) })
      : await input.store.finishJob(input.workspace, job.id, ['queued'], 'cancelled', { exitCode: null, ...hostOwnedCancelledPatch(job, specification.stopCause) });
  } catch (error) {
    const winner = await input.store.readJob(input.workspace, job.id).catch(() => null);
    if (winner?.status === 'cancelled') return winner;
    throw error;
  }
}

/** Resolve the exact durable terminal winner a stop raced with, preserving the initiating error. @param {{store:any,workspace:string}} input @param {any} job @param {unknown} error */
async function managementConflictWinner(input, job, error) {
  try { return await durableCancelledWinner({ store: input.store, workspace: input.workspace, jobId: job.id, ownerSessionId: job.ownerSessionId }, error); }
  catch { if (error instanceof PluginError && ['JOB_TERMINAL', 'JOB_STATUS_CONFLICT'].includes(error.code)) return input.store.readJob(input.workspace, job.id); throw error; }
}

/** Remote-control adapters stay unwired fail-closed defaults for management reconciliation. @param {string} adapter */
/** @param {string} message */
function managementReconcileError(message) {
  return new PluginError('RESCUE_MANAGEMENT_RECONCILE_FAILED', message, { category: 'state', remedy: 'Remote stop and reread stay owned by the cancellation election and owner recovery.' });
}

/** Resolve a hook-recorded active turn and invoke through ordinary stdio without caller-supplied authorization. @param {string[]} argv @param {{cwd?:string,env?:NodeJS.ProcessEnv,input?:NodeJS.ReadableStream,preparationTransport?:{writeReady:(line:string)=>unknown|Promise<unknown>},dependencies?:any,progressWriter?:(line:string)=>void,progressRelayWriter?:(record:{sequence:number,phase:string,code:string,observedAt:string})=>void|Promise<void>,progressDependencies?:any,signal?:AbortSignal}} [runtime] */
export async function runDirectInvocation(argv, runtime = {}) {
  const cwd = runtime.cwd ?? process.cwd(); const env = runtime.env ?? process.env; const dataRoot = resolvePluginDataRoot({ env, pluginRoot: activePluginRoot, entryPath: invocationEntryPath() });
  const [entry, command, choice, ...extra] = argv;
  const statusInvocation = entry === 'invoke-status' && command === 'rescue' && choice === undefined && extra.length === 0;
  const prepareInvocation = entry === 'prepare' && command === 'rescue' && choice === undefined && extra.length === 0;
  const preparedInvocation = entry === 'invoke-prepared' && command === 'rescue' && choice === undefined && extra.length === 0;
  if (!statusInvocation && !prepareInvocation && !preparedInvocation && (!['invoke', 'invoke-choice'].includes(entry) || typeof command !== 'string' || extra.length)) throw new PluginError('INVOCATION_COMMAND_INVALID', 'The direct companion command is invalid.', { category: 'validation', remedy: 'Use the constant command documented by the installed skill.' });
  const ambientThreadId = env.CODEX_THREAD_ID; if (typeof ambientThreadId !== 'string' || !ambientThreadId) throw new PluginError('THREAD_ID_REQUIRED', 'The active Codex thread identity is unavailable.', { category: 'authorization', remedy: 'Invoke this installed skill from an active Codex turn.' });
  const identity = createIdentityStore({ dataRoot });
  if (prepareInvocation) {
    const input = runtime.input ?? process.stdin;
    const transport = openPrivatePreparationTransport(input, runtime.preparationTransport);
    try {
      const caller = await identity.resolveActiveTurn({ sessionId: ambientThreadId, workspace: cwd, workspaceBinding: 'claim' });
      await transport.writeReady();
      const envelope = await readRescuePreparationFrame(input, runtime.signal);
      const planned = validatePlannedRescueActivation(await (runtime.dependencies?.planRescueActivation ?? planRescueActivation)({
        dataRoot, caller, envelope, appServerOptions: codexAppServerOptions(env, caller.originWorkspace ?? caller.workspace, runtime.signal),
      }));
      await createRescuePreparationStore({ dataRoot }).save({ ...caller, recordedPrompt: caller.prompt, envelope, activation: planned.activation, signal: runtime.signal });
      return { type: 'prepared', command: 'rescue', route: planned.directive };
    } finally { transport.close(); }
  }
  if (preparedInvocation) {
    let execution;
    /** @type {any} */ let host;
    try { execution = await resolvePreparedExecutionContext(dataRoot, cwd, ambientThreadId); }
    catch (error) {
      if (!(error instanceof PluginError) || error.code !== 'EXECUTOR_IDENTITY_NOT_FOUND') throw error;
      host = sanitizeCodexThreadSpawnChild(await (runtime.dependencies?.readCodexThreadSpawnChildIdentity ?? readCodexThreadSpawnChildIdentity)(
        ambientThreadId, codexAppServerOptions(env, cwd, runtime.signal),
      ), undefined, ambientThreadId);
      if (host.status.type !== 'notLoaded') throw new PluginError('EXECUTOR_STATE_MISMATCH', 'The persisted Rescue child is not eligible for exact migration.', { category: 'authorization', remedy: 'Return to the active parent turn and prepare Rescue again.' });
      execution = { executor: null, executionWorkspace: cwd };
    }
    let executor = execution.executor;
    let caller;
    caller = await identity.resolveActiveTurn({ sessionId: executor?.parentSessionId ?? host.parentThreadId, workspace: execution.executionWorkspace, workspaceBinding: 'execution' });
    if (executor?.active) assertExecutorMatchesCaller(executor, caller);
    let rescueRoute; const recoveredWithoutExecutor = !executor;
    if (recoveredWithoutExecutor) {
      const state = createStateStore({ dataRoot }); const agentPathDigest = createHash('sha256').update(host.agentPath).digest('hex');
      const proof = await state.readRescueBindingMigrationProof({ workspace: caller.workspace, parentSessionId: caller.sessionId,
        executorAgentId: host.id, childAgentType: host.agentRole ?? 'default', originWorkspace: host.cwd,
        executionWorkspace: caller.workspace, agentPathDigest, agentPath: host.agentPath, permissionMode: caller.permissionMode });
      if (!['bound', 'proof'].includes(proof.kind)) throw new PluginError('RESCUE_BINDING_INVALID', 'The private Rescue operation binding is invalid.', { category: 'authorization', remedy: 'Start a fresh Rescue operation from the active parent turn.' });
      const migrationProof = proof.kind === 'proof' ? proof.migrationProof : undefined;
      const resolved = await state.resolveRescueBindingForResume({ workspace: caller.workspace,
        parentSessionId: caller.sessionId, executorAgentId: host.id, executorAgentPath: host.agentPath,
        permissionMode: caller.permissionMode, ...(migrationProof === undefined ? {} : { migrationProof }) });
      if (resolved.kind !== 'bound') throw new PluginError('RESCUE_BINDING_INVALID', 'The private Rescue operation binding is invalid.', { category: 'authorization', remedy: 'Start a fresh Rescue operation from the active parent turn.' });
      const authority = rescueBindingAuthorityView(resolved.binding);
      executor = { active: false, agentId: host.id, agentType: authority.childAgentType, agentPath: host.agentPath,
        parentSessionId: caller.sessionId,
        parentTurnId: authority.kind === 'subagent-start' ? authority.parentTurnId : caller.turnId,
        parentPermissionMode: authority.kind === 'subagent-start' ? authority.parentPermissionMode : caller.permissionMode,
        originWorkspace: host.cwd, workspace: caller.workspace };
      rescueRoute = { routeKind: 'bound', candidateJobId: resolved.binding.anchorJobId,
        expectedOperationId: resolved.binding.operationId, expectedCurrentJobId: resolved.binding.currentJobId,
        ...(migrationProof === undefined ? {} : { migrationProof }) };
      await afterPreparedBindingResolution(runtime.dependencies);
    }
    const preparations = createRescuePreparationStore({ dataRoot });
    let prepared;
    const beforeConsume = async (/** @type {any} */ record) => {
      const exact = canonicalExactReactivateActivation(record.activation);
      if (!exact) return;
      if (executor && !host) host = sanitizeCodexThreadSpawnChild(await (runtime.dependencies?.readCodexThreadSpawnChild ?? readCodexThreadSpawnChild)(
        ambientThreadId, executor.parentSessionId, codexAppServerOptions(env, executor.originWorkspace, runtime.signal),
      ), executor.parentSessionId, executor.agentId);
      if (executor && host) validateExecutorHostIdentity(host, executor);
      const agentPath = host?.agentPath ?? executor?.agentPath;
      if (!executor || executor.agentId !== record.activation.executorAgentId || typeof agentPath !== 'string'
        || createHash('sha256').update(agentPath).digest('hex') !== record.activation.agentPathDigest) throw rescueRouteInvalid();
      const state = (runtime.dependencies?.createRescueContinuationStateStore ?? createStateStore)({ dataRoot });
      const lookup = { workspace: caller.workspace,
        parentSessionId: caller.sessionId, executorAgentId: executor.agentId, executorAgentType: executor.agentType,
        permissionMode: caller.permissionMode, executorAgentPath: agentPath };
      let migration; let resolved;
      try {
        migration = await state.readRescueBindingMigrationProof({ workspace: caller.workspace,
          parentSessionId: caller.sessionId, executorAgentId: executor.agentId, childAgentType: executor.agentType,
          permissionMode: caller.permissionMode, agentPath, originWorkspace: executor.originWorkspace,
          executionWorkspace: caller.workspace, agentPathDigest: record.activation.agentPathDigest });
        if (!['bound', 'proof'].includes(migration.kind)) throw rescueBindingInvalid();
        const proof = migration.kind === 'proof' ? migration.migrationProof : undefined;
        resolved = await state.resolveRescueBindingForResume({ ...lookup, ...(proof ? { migrationProof: proof } : {}) });
      } catch (error) {
        if (isInterruption(error)) throw error;
        throw rescueBindingInvalid();
      }
      const migrationProof = migration.kind === 'proof' ? migration.migrationProof : undefined;
      if (resolved.kind !== 'bound' || resolved.binding.key !== exact.bindingKey
        || resolved.binding.operationId !== exact.operationId || resolved.binding.anchorJobId !== exact.anchorJobId
        || resolved.binding.currentJobId !== exact.currentJobId || resolved.binding.updatedAt !== exact.bindingUpdatedAt
        || resolved.anchorJob.zcodeSessionId !== exact.zcodeSessionId
        || resolved.currentJob.zcodeSessionId !== exact.zcodeSessionId) throw rescueBindingInvalid();
      rescueRoute = { routeKind: 'bound', candidateJobId: exact.anchorJobId,
        expectedBindingKey: exact.bindingKey, expectedOperationId: exact.operationId,
        expectedAnchorJobId: exact.anchorJobId, expectedCurrentJobId: exact.currentJobId,
        expectedBindingUpdatedAt: exact.bindingUpdatedAt, expectedResumeSessionId: exact.zcodeSessionId,
        ...(migrationProof ? { migrationProof } : {}) };
    };
    try { prepared = await preparations.consume({ ...caller, executorAgentId: ambientThreadId, beforeConsume,
      ...(recoveredWithoutExecutor ? { activationProof: { kind: 'reactivate', agentPathDigest: createHash('sha256').update(host.agentPath).digest('hex') } } : {}) }); }
    catch (error) {
      if (!(error instanceof PluginError) || error.code !== 'RESCUE_PREPARATION_MISMATCH') throw error;
      if (recoveredWithoutExecutor) throw error;
      host ??= sanitizeCodexThreadSpawnChild(await (runtime.dependencies?.readCodexThreadSpawnChild ?? readCodexThreadSpawnChild)(
        ambientThreadId, executor.parentSessionId, codexAppServerOptions(env, executor.originWorkspace, runtime.signal),
      ), executor.parentSessionId, executor.agentId);
      let activationProof = executor ? preparedActivationProof(host, executor) : null;
      try {
        if (activationProof) prepared = await preparations.consume({ ...caller, executorAgentId: ambientThreadId, activationProof, beforeConsume });
        else throw error;
      } catch (proofError) {
        if (!(proofError instanceof PluginError) || proofError.code !== 'RESCUE_PREPARATION_MISMATCH') throw proofError;
        if (executor?.active) {
          activationProof = { kind: 'reactivate', agentPathDigest: createHash('sha256').update(host.agentPath).digest('hex') };
          try { prepared = await preparations.consume({ ...caller, executorAgentId: ambientThreadId, activationProof, beforeConsume }); }
          catch (residentError) {
            if (!(residentError instanceof PluginError) || residentError.code !== 'RESCUE_PREPARATION_MISMATCH') throw residentError;
          }
        }
        if (!prepared) throw proofError;
      }
    }
    if (prepared.envelope.options.resume === 'fresh' && prepared.activation?.kind !== 'spawn') {
      throw new PluginError('RESCUE_PREPARATION_MISMATCH', 'The Rescue preparation activation does not match.', { category: 'authorization', remedy: 'Return to the parent turn and prepare Rescue again.' });
    }
    if (!recoveredWithoutExecutor && canonicalExactReactivateActivation(prepared.activation)) await afterPreparedBindingResolution(runtime.dependencies);
    if (executor && host) {
      validateExecutorHostIdentity(host, executor);
      if (prepared.activation && prepared.activation.kind !== 'spawn'
        && prepared.activation.agentPathDigest !== createHash('sha256').update(host.agentPath).digest('hex')) {
        throw new PluginError('RESCUE_PREPARATION_MISMATCH', 'The Rescue preparation does not match this child.', { category: 'authorization', remedy: 'Return to the parent turn and prepare Rescue again.' });
      }
      executor = { ...executor, agentPath: host.agentPath };
    }
    if (prepared.requiredExecutorAgentId !== null && executor.active) {
      host ??= sanitizeCodexThreadSpawnChild(await (runtime.dependencies?.readCodexThreadSpawnChild ?? readCodexThreadSpawnChild)(
        ambientThreadId, executor.parentSessionId, codexAppServerOptions(env, executor.originWorkspace, runtime.signal),
      ), executor.parentSessionId, executor.agentId);
      validateExecutorHostIdentity(host, executor);
      if (host.status.type !== 'active' || prepared.activation !== null
        && (prepared.activation?.kind !== 'reactivate'
          || prepared.activation.agentPathDigest !== createHash('sha256').update(host.agentPath).digest('hex'))) {
        throw new PluginError('EXECUTOR_STATE_MISMATCH', 'The resident Rescue child no longer matches its prepared continuation.', { category: 'authorization', remedy: 'Return to the parent turn and prepare Rescue again.' });
      }
      executor = { ...executor, agentPath: host.agentPath };
    }
    if (executor && prepared.activation?.kind === 'spawn') {
      const agentPath = `/root/${prepared.activation.taskName}`;
      if (createHash('sha256').update(agentPath).digest('hex') !== prepared.activation.agentPathDigest) throw rescueRouteInvalid();
      executor = { ...executor, agentPath };
    }
    if (!executor.active && rescueRoute === undefined) {
      const state = createStateStore({ dataRoot });
      let lookup = bindingLookup(executor, caller.workspace);
      let migrationProof;
      let resolved;
      try {
        resolved = await state.resolveRescueBinding(lookup);
      } catch (error) {
        if (/** @type {any} */ (error)?.code !== 'RESCUE_BINDING_CLOSED') throw error;
        if (executor) {
          host ??= sanitizeCodexThreadSpawnChild(await (runtime.dependencies?.readCodexThreadSpawnChild ?? readCodexThreadSpawnChild)(
            ambientThreadId, executor.parentSessionId, codexAppServerOptions(env, executor.originWorkspace, runtime.signal),
          ), executor.parentSessionId, executor.agentId);
          validateExecutorHostIdentity(host, executor);
          if (prepared.activation && prepared.activation.kind !== 'spawn'
            && prepared.activation.agentPathDigest !== createHash('sha256').update(host.agentPath).digest('hex')) {
            throw new PluginError('RESCUE_PREPARATION_MISMATCH', 'The Rescue preparation does not match this child.', { category: 'authorization', remedy: 'Return to the parent turn and prepare Rescue again.' });
          }
          executor = { ...executor, agentPath: host.agentPath };
          lookup = bindingLookup(executor, caller.workspace);
        }
        const proof = await state.readRescueBindingMigrationProof({ workspace: caller.workspace,
          parentSessionId: caller.sessionId, executorAgentId: executor.agentId,
          childAgentType: executor.agentType, originWorkspace: host.cwd,
          executionWorkspace: caller.workspace, agentPathDigest: createHash('sha256').update(host.agentPath).digest('hex'),
          ...(executor ? { agentPath: host.agentPath } : {}) });
        if (proof.kind !== 'proof') throw error;
        migrationProof = proof.migrationProof;
        resolved = await state.resolveRescueBindingForResume({ ...lookup,
          ...(prepared.envelope.options.resume === 'resume' ? { permissionMode: caller.permissionMode } : {}), migrationProof });
      }
      if (resolved.kind !== 'bound') throw new PluginError('EXECUTOR_IDENTITY_NOT_FOUND', 'No bound stopped Rescue executor matches this preparation.', { category: 'authorization', remedy: 'Start one new Rescue child for an unbound operation.' });
      rescueRoute = { routeKind: 'bound', candidateJobId: resolved.binding.anchorJobId,
        expectedOperationId: resolved.binding.operationId, expectedCurrentJobId: resolved.binding.currentJobId,
        ...(migrationProof ? { migrationProof } : {}) };
      await afterPreparedBindingResolution(runtime.dependencies);
    }
    const preparedArgv = rescueArgvFromPreparation(prepared.envelope);
    const output = await runCompanion(preparedArgv, { cwd: caller.workspace, env, caller, executor,
      legacyActivation: false, rescueRoute,
      rescueActivationKind: prepared.activation?.kind,
      originalPrompt: undefined, autoLaunchBackground: true, dependencies: runtime.dependencies, progressWriter: runtime.progressWriter, progressRelayWriter: runtime.progressRelayWriter, progressDependencies: runtime.progressDependencies, signal: runtime.signal });
    if (output?.type === 'needs-choice') await saveRescuePendingChoice({ dataRoot, caller, cwd: caller.workspace, source: prepared.envelope.source, executor, argv: preparedArgv, output });
    return output;
  }
  if (statusInvocation) {
    try {
      const { executor, executionWorkspace } = await resolveRoutedForwardingExecutor(dataRoot, cwd, ambientThreadId);
      const caller = await createIdentityStore({ dataRoot }).resolveActiveTurn({ sessionId: executor.parentSessionId, workspace: executionWorkspace, workspaceBinding: 'execution' });
      assertExecutorMatchesCaller(executor, caller);
      return await readBoundRescueStatus({ store: createStateStore({ dataRoot }), workspace: caller.workspace, executor });
    } catch (error) {
      if (error instanceof PluginError && SAFE_BOUND_STATUS_ERRORS.has(error.code)) throw error;
      throw new PluginError('BOUND_RESCUE_STATUS_UNAVAILABLE', 'Bound Rescue status is unavailable.', { category: 'state', remedy: 'Continue waiting on the original Rescue foreground execution.' });
    }
  }
  if (entry === 'invoke' && command === 'rescue') {
    if (choice !== undefined) throw new PluginError('INVOCATION_COMMAND_INVALID', 'The direct companion command is invalid.', { category: 'validation', remedy: 'Use the constant command documented by the installed skill.' });
    throw new PluginError('PREPARED_INVOCATION_REQUIRED', 'Installed Rescue requires a prepared invocation.', { category: 'authorization', remedy: 'Return to the parent turn, run prepare rescue, and start one new Rescue child.' });
  }
  let sessionId = ambientThreadId;
  /** @type {string|undefined} */ let executorAgentId;
  let executor; let executionWorkspace = cwd;
  if (command === 'rescue') {
    const resolved = entry === 'invoke-choice'
      ? await resolvePreparedExecutionContext(dataRoot, cwd, ambientThreadId)
      : await resolveRoutedForwardingExecutor(dataRoot, cwd, ambientThreadId);
    executor = resolved.executor; executionWorkspace = resolved.executionWorkspace; sessionId = executor.parentSessionId; executorAgentId = executor.agentId;
  }
  const jobCommand = ['status', 'result', 'cancel'].includes(command);
  const jobCreator = ['review', 'adversarial-review', 'transfer'].includes(command);
  let caller = await identity.resolveActiveTurn({ sessionId, workspace: executionWorkspace, ...(command === 'rescue' ? { workspaceBinding: 'execution' } : jobCommand ? { workspaceBinding: 'effective' } : jobCreator ? { workspaceBinding: 'preview' } : {}) });
  if (jobCreator && caller.generationId !== undefined) {
    const authority = caller;
    await runtime.dependencies?.testOnlyBeforeJobWorkspaceSelection?.(caller);
    const selected = await identity.selectJobWorkspace({
      sessionId: caller.sessionId, turnId: caller.turnId, generationId: caller.generationId,
      originWorkspace: caller.originWorkspace, workspace: cwd,
    });
    caller = { ...selected, generationId: authority.generationId, originWorkspace: authority.originWorkspace };
  }
  const invocations = createInvocationStore({ dataRoot });
  const invocationWorkspace = command === 'rescue' || jobCommand || jobCreator ? caller.workspace : cwd;
  if (command === 'rescue' && (entry === 'invoke' || entry === 'invoke-choice' && executor?.active)) assertExecutorMatchesCaller(executor, caller);
  /** @type {any} */ let invocation; let executionCaller = caller;
  if (entry === 'invoke-choice') {
    const consume = () => invocations.consumePending({ sessionId, workspace: invocationWorkspace, command, choice,
      ...(executorAgentId === undefined ? {} : { executorAgentId }), ...(command === 'rescue' ? {
        turnId: caller.turnId, permissionMode: caller.permissionMode, parentGenerationId: caller.generationId,
        originWorkspace: caller.originWorkspace, executionWorkspace: caller.workspace,
      } : {}) });
    if (jobCreator) await runtime.dependencies?.testOnlyBeforePendingInvocationConsume?.(caller);
    invocation = jobCreator
      ? await withCreatorPartitionFence(identity, caller, consume)
      : await consume();
    executionCaller = invocation.caller;
    if (command === 'rescue' && invocation.authority) throw new PluginError('PENDING_INVOCATION_INVALID', 'The pending Rescue invocation is invalid.', { category: 'authorization', remedy: 'Return to the active parent turn and prepare Rescue again.' });
    if (command === 'rescue' && choice === 'fresh') {
      await authorizePendingFreshReplan({ dataRoot, caller, executorAgentId, invocation });
      return { type: 'parent-replan', command: 'rescue' };
    }
    if (command === 'rescue' && invocation.route?.routeKind !== 'bound') {
      const refreshed = await resolveRoutedForwardingExecutor(dataRoot, cwd, ambientThreadId, { continuation: true });
      assertSameRoutedExecutionContext({ executor, executionWorkspace }, refreshed); executor = refreshed.executor;
    }
  }
  else {
    if (choice !== undefined) throw new PluginError('INVOCATION_COMMAND_INVALID', 'The direct companion command is invalid.', { category: 'validation', remedy: 'Use the constant command documented by the installed skill.' });
    invocation = parseRecordedInvocation(command, caller.prompt);
    if (requiresExecutionChoice(command, invocation.argv)) {
      const save = () => invocations.savePending({ sessionId, turnId: caller.turnId, workspace: invocationWorkspace, permissionMode: caller.permissionMode, command, spec: { argv: invocation.argv }, ...(command === 'rescue' ? { source: invocation.source ?? 'explicit' } : {}), ...(executorAgentId === undefined ? {} : { executorAgentId }) });
      if (jobCreator) await runtime.dependencies?.testOnlyBeforePendingInvocationWrite?.(caller);
      if (jobCreator) await withCreatorPartitionFence(identity, caller, save);
      else await save();
      return { type: 'needs-choice', choices: ['wait', 'background'] };
    }
  }
  const output = await runCompanion(invocation.argv, { cwd: command === 'rescue' ? executionCaller.workspace : invocationWorkspace, env, caller: executionCaller,
    ...(jobCreator ? { creatorAuthority: caller } : {}), executor,
    legacyActivation: false, rescueRoute: invocation.route, originalPrompt: invocation.implicitText, autoLaunchBackground: true, dependencies: runtime.dependencies,
    progressWriter: runtime.progressWriter, progressRelayWriter: runtime.progressRelayWriter, progressDependencies: runtime.progressDependencies, signal: runtime.signal });
  if (output?.type === 'needs-choice') {
    if (command === 'rescue') await saveRescuePendingChoice({ dataRoot, caller: executionCaller, cwd: executionCaller.workspace, source: invocation.source ?? 'explicit', executor, argv: invocation.argv, output });
    else {
      const save = () => invocations.savePending({ sessionId, turnId: executionCaller.turnId, workspace: invocationWorkspace, permissionMode: executionCaller.permissionMode, command, spec: { argv: invocation.argv } });
      await withCreatorPartitionFence(identity, caller, save);
    }
  }
  return output;
}

/** @param {string} dataRoot @param {string} ambientWorkspace @param {string} agentId */
async function resolvePreparedExecutionContext(dataRoot, ambientWorkspace, agentId) {
  try { return await resolveRoutedForwardingExecutor(dataRoot, ambientWorkspace, agentId); }
  catch (error) {
    if (!(error instanceof PluginError) || !['EXECUTOR_IDENTITY_NOT_FOUND', 'EXECUTOR_IDENTITY_EXPIRED', 'EXECUTOR_STATE_MISMATCH'].includes(error.code)) throw error;
    return resolveRoutedForwardingExecutor(dataRoot, ambientWorkspace, agentId, { continuation: true, durableProvenance: true });
  }
}

/** @param {unknown} value */
function validatePlannedRescueActivation(value) {
  if (!exactPlainObject(value, ['activation', 'directive'])) throw rescueRouteInvalid();
  const plan = /** @type {Record<string,any>} */ (value);
  const directive = validateRescueRouteDirective(plan.directive);
  const activation = plan.activation;
  if (directive.action === 'spawn') {
    const digest = createHash('sha256').update(`/root/${directive.taskName}`).digest('hex');
    if (!exactPlainObject(activation, ['agentPathDigest', 'kind', 'taskName']) || activation.kind !== 'spawn'
      || activation.taskName !== directive.taskName || activation.agentPathDigest !== digest) throw rescueRouteInvalid();
    return { activation: { kind: 'spawn', taskName: activation.taskName, agentPathDigest: activation.agentPathDigest }, directive };
  }
  const digest = createHash('sha256').update(directive.target).digest('hex');
  if (activation?.kind === 'reactivate') {
    const bareKeys = ['agentPathDigest', 'executorAgentId', 'kind'];
    const exact = canonicalExactReactivateActivation(activation);
    if (!exact && !exactPlainObject(activation, bareKeys)
      || !safeCompanionIdentifier(activation.executorAgentId) || activation.agentPathDigest !== digest) throw rescueRouteInvalid();
    return { activation: exact ?? { kind: 'reactivate', executorAgentId: activation.executorAgentId,
      agentPathDigest: activation.agentPathDigest }, directive };
  }
  throw rescueRouteInvalid();
}

/** @param {unknown} value @param {string[]} keys */
function exactPlainObject(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}
/** @param {unknown} value @param {number} [maxBytes] */
function safeCompanionIdentifier(value, maxBytes = 512) {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= maxBytes
    && ![...value].some((character) => { const code = /** @type {number} */ (character.codePointAt(0)); return code <= 31 || code === 127; });
}
function rescueRouteInvalid() { return new PluginError('RESCUE_ROUTE_INVALID', 'The Rescue activation route is invalid.', { category: 'authorization', remedy: 'Return to the parent turn and prepare Rescue again.' }); }
function rescueBindingInvalid() { return new PluginError('RESCUE_BINDING_INVALID', 'The private Rescue operation binding is invalid.', { category: 'authorization', remedy: 'Start a fresh Rescue operation from the active parent turn.' }); }

/** @param {any} host @param {any} executor */
function preparedActivationProof(host, executor) {
  validateExecutorHostIdentity(host, executor);
  const agentPathDigest = createHash('sha256').update(host.agentPath).digest('hex');
  if (executor.active) {
    if (!host.agentPath.startsWith('/root/')) throw new PluginError('EXECUTOR_IDENTITY_INVALID', 'The Rescue child host identity does not match its executor provenance.', { category: 'authorization', remedy: 'Return to the parent turn and prepare Rescue again.' });
    return { kind: 'spawn', taskName: host.agentPath.slice('/root/'.length), agentPathDigest };
  }
  return { kind: 'reactivate', agentPathDigest };
}

/** @param {any} host @param {any} executor */
function validateExecutorHostIdentity(host, executor) {
  const expectedRole = executor.agentType === 'zcode-rescue' ? 'zcode-rescue' : executor.agentType === 'default' ? null : undefined;
  if (!host || host.id !== executor.agentId || host.parentThreadId !== executor.parentSessionId
    || host.agentRole !== expectedRole || host.cwd !== executor.originWorkspace) {
    throw new PluginError('EXECUTOR_IDENTITY_INVALID', 'The Rescue child host identity does not match its executor provenance.', { category: 'authorization', remedy: 'Return to the parent turn and prepare Rescue again.' });
  }
}

/** @param {{dataRoot:string,caller:any,cwd:string,source:'explicit'|'proactive',executor:any,argv:string[],output:any}} input */
async function saveRescuePendingChoice({ dataRoot, caller, cwd, source, executor, argv, output }) {
  const route = rescueChoiceRoutes.get(output);
  if (!route) throw new PluginError('RESCUE_CHOICE_ROUTE_INVALID', 'The private Rescue choice route is unavailable.', { category: 'authorization', remedy: 'Repeat the Rescue command.' });
  const executorAgentId = executor?.agentId;
  if (!executorAgentId) throw new PluginError('RESCUE_CHOICE_ROUTE_INVALID', 'The private Rescue choice route is unavailable.', { category: 'authorization', remedy: 'Repeat the Rescue command.' });
  await createInvocationStore({ dataRoot }).savePending({ sessionId: caller.sessionId, turnId: caller.turnId, workspace: cwd, permissionMode: caller.permissionMode,
    command: 'rescue', source, executorAgentId, spec: { argv }, ...route });
}

/** @param {{dataRoot:string,caller:any,executorAgentId:string|undefined,invocation:any}} input */
async function authorizePendingFreshReplan({ dataRoot, caller, executorAgentId, invocation }) {
  if (!executorAgentId || invocation?.source === undefined) throw new PluginError(
    'PENDING_INVOCATION_INVALID', 'The pending invocation is invalid.',
    { category: 'authorization', remedy: 'Repeat the original command in this Codex thread.' },
  );
  const parsed = parseArgs(invocation.argv);
  const options = { ...parsed.options }; delete options.resume;
  const envelope = { version: 1, source: invocation.source, task: parsed.positionals.join(' '), options };
  const preparations = createRescuePreparationStore({ dataRoot });
  await preparations.save({
    ...caller,
    recordedPrompt: invocation.source === 'explicit' ? '$zcode:rescue' : '',
    envelope,
    pendingFreshProvenance: {
      executorAgentId,
      originatingTurnId: invocation.caller.turnId,
    },
  });
  await preparations.consume({ ...caller, executorAgentId });
}

/** @param {any} executor @param {any} caller */
function assertExecutorMatchesCaller(executor, caller) {
  if (executor.parentTurnId !== caller.turnId || executor.parentPermissionMode !== caller.permissionMode
    || executor.parentGenerationId !== null && executor.parentGenerationId !== undefined && executor.parentGenerationId !== caller.generationId) throw new PluginError('EXECUTOR_PARENT_TURN_MISMATCH', 'The Rescue child is not bound to the active parent turn.', { category: 'authorization', remedy: 'Retry from the original parent thread with one newly started Rescue child.' });
}

/** @param {{executor:any,executionWorkspace:string}} expected @param {{executor:any,executionWorkspace:string}} actual */
function assertSameRoutedExecutionContext(expected, actual) {
  if (expected.executionWorkspace !== actual.executionWorkspace || expected.executor.agentId !== actual.executor.agentId
    || expected.executor.agentType !== actual.executor.agentType || expected.executor.parentSessionId !== actual.executor.parentSessionId
    || expected.executor.parentGenerationId !== actual.executor.parentGenerationId || expected.executor.parentTurnId !== actual.executor.parentTurnId
    || expected.executor.parentPermissionMode !== actual.executor.parentPermissionMode || expected.executor.childTurnId !== actual.executor.childTurnId
    || expected.executor.originWorkspace !== actual.executor.originWorkspace || expected.executor.workspace !== actual.executor.workspace
    || expected.executor.active !== actual.executor.active || expected.executor.createdAt !== actual.executor.createdAt) {
    throw new PluginError('RESCUE_CHOICE_ROUTE_INVALID', 'The private Rescue choice route changed during execution.', { category: 'authorization', remedy: 'Repeat the Rescue command.' });
  }
}

/** @param {any} dependencies */
async function afterPreparedBindingResolution(dependencies) {
  const callback = dependencies?.testOnlyAfterPreparedBindingResolution;
  if (callback === undefined) return;
  if (typeof callback !== 'function') throw new PluginError('DIRECT_INVOCATION_DEPENDENCY_INVALID', 'A private direct-invocation dependency is invalid.', { category: 'validation', remedy: 'Retry without private test dependencies.' });
  try { await callback(); }
  catch { throw new PluginError('PREPARED_BINDING_TEST_FAULT', 'The test-only prepared-binding fault was injected.', { category: 'state', remedy: 'Retry without the test-only prepared-binding callback.' }); }
}

/** @param {{task:string,options:{execution?:string,resume?:string,model?:string,effort?:string}}} envelope */
function rescueArgvFromPreparation(envelope) {
  const argv = ['rescue'];
  if (envelope.options.execution === 'background') argv.push('--background');
  if (envelope.options.resume) argv.push(`--${envelope.options.resume}`);
  if (envelope.options.model) argv.push('--model', envelope.options.model);
  if (envelope.options.effort) argv.push('--effort', envelope.options.effort);
  argv.push('--', envelope.task);
  return argv;
}

/** @param {NodeJS.ReadableStream} input @param {AbortSignal|undefined} signal @returns {Promise<any>} */
function readRescuePreparationAbortable(input, signal) {
  if (!signal) return readRescuePreparation(input);
  return new Promise((resolvePromise, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    /** @param {unknown} error @param {any} [value] */
    const finish = (error, value) => {
      if (settled) return; settled = true; cleanup();
      if (error) reject(error); else resolvePromise(value);
    };
    const onAbort = () => {
      const reason = signal.reason instanceof PluginError && signal.reason.code === 'JOB_INTERRUPTED'
        ? signal.reason
        : new PluginError('JOB_INTERRUPTED', 'Rescue preparation was interrupted.', { category: 'interruption', remedy: 'Retry the command when you are ready.' });
      try { /** @type {{destroy?:()=>void}} */ (input).destroy?.(); } catch { /* best effort input release */ }
      finish(reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) { onAbort(); return; }
    readRescuePreparation(input).then((value) => finish(undefined, value), (error) => finish(error));
  });
}

/** @param {NodeJS.ReadableStream} input @param {{writeReady:(line:string)=>unknown|Promise<unknown>}|undefined} transport */
function openPrivatePreparationTransport(input, transport) {
  if (!transport) return { writeReady: async () => {}, close: () => {} };
  if (typeof transport.writeReady !== 'function') throw new PluginError('DIRECT_INVOCATION_DEPENDENCY_INVALID', 'A private direct-invocation dependency is invalid.', { category: 'validation', remedy: 'Retry without private test dependencies.' });
  const tty = /** @type {NodeJS.ReadableStream & {isTTY?:boolean,setRawMode?:(enabled:boolean)=>unknown}} */ (input);
  if (tty.isTTY !== true || typeof tty.setRawMode !== 'function') throw new PluginError('PREPARATION_TTY_REQUIRED', 'Private Rescue preparation requires a raw-capable terminal.', { category: 'authorization', remedy: 'Run prepare rescue through its installed private PTY transport.' });
  tty.setRawMode(true);
  return {
    writeReady: () => transport.writeReady('{"type":"preparation-input-ready","command":"rescue"}\n'),
    close: () => { try { tty.setRawMode?.(false); } catch { /* process exit restores terminal state */ } },
  };
}

/** @param {NodeJS.ReadableStream} input @param {AbortSignal|undefined} signal @returns {Promise<any>} */
function readRescuePreparationFrame(input, signal) {
  if (typeof input?.on !== 'function' || typeof input?.removeListener !== 'function') return readRescuePreparationAbortable(input, signal);
  return new Promise((resolvePromise, reject) => {
    /** @type {Buffer[]} */ let chunks = []; let bytes = 0; let settled = false;
    const cleanup = () => {
      input.removeListener('data', onData); input.removeListener('end', onEnd); input.removeListener('error', onError); signal?.removeEventListener('abort', onAbort);
      try { input.pause?.(); } catch { /* best effort flow stop */ }
      try { /** @type {NodeJS.ReadableStream & {unref?:()=>unknown}} */ (input).unref?.(); } catch { /* allow the private process to exit without stdin EOF */ }
    };
    /** @param {Buffer} captured */
    const validate = (captured) => {
      if (settled) return; settled = true; cleanup();
      readRescuePreparation(Readable.from([captured])).then(resolvePromise, reject);
    };
    /** @param {Buffer|string|Uint8Array} chunk */
    const onData = (chunk) => {
      if (settled) return;
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (bytes + value.length > RESCUE_ENVELOPE_MAX_BYTES) { validate(Buffer.alloc(RESCUE_ENVELOPE_MAX_BYTES + 1)); return; }
      chunks.push(value); bytes += value.length;
      if (value.includes(0x0a)) validate(Buffer.concat(chunks, bytes));
    };
    const onEnd = () => validate(Buffer.concat(chunks, bytes));
    const onError = () => validate(Buffer.alloc(0));
    const onAbort = () => {
      if (settled || !signal) return; settled = true; cleanup();
      reject(rescuePreparationInterruption(signal));
    };
    input.on('data', onData); input.once('end', onEnd); input.once('error', onError); signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

/** @param {AbortSignal} signal */
function rescuePreparationInterruption(signal) {
  return signal.reason instanceof PluginError && signal.reason.code === 'JOB_INTERRUPTED'
    ? signal.reason
    : new PluginError('JOB_INTERRUPTED', 'Rescue preparation was interrupted.', { category: 'interruption', remedy: 'Retry the command when you are ready.' });
}

/** @param {any} context */
async function startPublic(context) {
  const { parsed, caller, cwd, dataRoot, identity, store, controller } = context;
  const childAuthorized = Boolean(context.executor || context.authority);
  /** @type {any} */ let candidate = null; /** @type {any} */ let binding = null;
  if (parsed.command === 'rescue') {
    if (childAuthorized && parsed.options.resume === 'fresh' && context.rescueActivationKind !== 'spawn') {
      throw new PluginError('RESCUE_PREPARATION_MISMATCH', 'The Rescue preparation activation does not match.', { category: 'authorization', remedy: 'Return to the parent turn and prepare Rescue again.' });
    }
    if (childAuthorized) {
      if (context.rescueRoute?.routeKind === 'legacy') throw new PluginError('RESCUE_BINDING_INVALID', 'The private Rescue operation binding is invalid.', { category: 'authorization', remedy: 'Start a fresh Rescue operation from the active parent turn.' });
      if (parsed.options.resume !== 'fresh') {
        const lookup = {
          ...(context.legacyActivation
            ? authorityBindingLookup(context.authority ?? { childAgentId: context.executor.agentId }, caller, cwd)
            : context.executor ? bindingLookup(context.executor, cwd) : authorityBindingLookup(context.authority, caller, cwd)),
          ...(parsed.options.resume === 'resume' ? { permissionMode: caller.permissionMode } : {}),
        };
        const migrationProof = parsed.options.resume === 'resume' ? context.rescueRoute?.migrationProof : undefined;
        const resolved = migrationProof ? await store.resolveRescueBindingForResume({ ...lookup, migrationProof }) : await store.resolveRescueBinding(lookup);
        binding = resolved.kind === 'bound' ? resolved.binding : null;
        if (context.rescueRoute?.routeKind === 'bound' && !binding) throw new PluginError('RESCUE_BINDING_INVALID', 'The private Rescue operation binding is invalid.', { category: 'authorization', remedy: 'Start a fresh Rescue operation from the active parent turn.' });
      }
      if (!parsed.options.resume && binding) return boundNeedsChoice(binding);
    } else candidate = await controller.resumeCandidate(cwd, caller.sessionId, caller.permissionMode);
    if (!childAuthorized && !parsed.options.resume && candidate) return { type: 'needs-choice', candidate, choices: ['--resume', '--fresh'] };
    if (parsed.options.resume === 'resume' && !binding && !candidate) throw new PluginError('RESUME_CANDIDATE_NOT_FOUND', 'No eligible rescue session can be resumed.', { category: 'state', remedy: 'Use --fresh to start a new ZCode session.' });
  }
  const permissionSnapshot = Object.freeze({ permissionMode: caller.permissionMode });
  const transferSource = parsed.command === 'transfer' ? resolveTransferSource(parsed.options, caller) : undefined;
  const reservation = { workspace: cwd, ownerSessionId: caller.sessionId, ownerTurnId: caller.turnId, command: parsed.command, readOnly: parsed.command !== 'rescue', permissionSnapshot, ...(transferSource ? { codexThreadId: transferSource } : {}) };
  /** @type {any} */ let job;
  if (parsed.command === 'rescue' && childAuthorized) {
    let reserved;
    const childProof = context.executor ? { executor: context.executor } : { authority: context.authority };
    // Every child-authorized Rescue reservation carries the Host-managed
    // lifecycle (ADR 0018): the epoch binds the job to the SessionStart epoch
    // that authorized it, `host-child` names the execution owner, and the
    // placement drives Host Coordination Loss policy. Fresh reservations and
    // bound continuations are alike here — a child-authorized record without
    // the trio would fall back to the detached execution path the design
    // removed for new Rescue. The epoch proof is the SessionStart record of
    // the session's ORIGIN workspace, even when the child executes in a linked
    // execution workspace.
    const epochWorkspace = context.executor?.originWorkspace ?? context.authority?.originWorkspace ?? cwd;
    // The AUTHORIZING epoch is the one that proved this child's work at the
    // moment the caller/executor authorized it — NOT whichever epoch is
    // current when this line executes. A same-session resume replacing the
    // SessionStart record in between must not re-brand pre-boundary work into
    // the successor epoch (that would let it escape its own settled receipt),
    // Durable authorization-epoch evidence (codex, Task 8): when the child's
    // executor record carries the epoch captured at its SubagentStart, THAT is
    // the authorizing epoch — a same-session resume replacing the session
    // record afterwards can never re-brand this work into the successor epoch.
    // Records without the evidence (frozen/legacy manifests) fall back to the
    // current-record derivation.
    const epochPair = typeof context.executor?.ownerLifecycleEpoch === 'string'
      ? { epoch: context.executor.ownerLifecycleEpoch }
      : await recordedSessionStartPair(dataRoot, epochWorkspace, caller.sessionId);
    const lifecycle = {
      ownerLifecycleEpoch: epochPair.epoch,
      executionOwner: 'host-child',
      hostPlacement: parsed.options.execution === 'background' ? 'background' : 'foreground',
    };
    const beforePersist = reservationEpochGate(context, epochPair.epoch);
    if (parsed.options.resume === 'fresh' || !binding && context.rescueActivationKind === 'spawn') reserved = await reservePublicRescueJob(context, () => store.reserveFreshRescueJob({ workspace: cwd, reservation, ...childProof, lifecycle, ...(context.rescueRoute?.routeKind === 'bound' ? { expectedOperationId: context.rescueRoute.expectedOperationId, expectedCurrentJobId: context.rescueRoute.expectedCurrentJobId, expectedAnchorJobId: context.rescueRoute.candidateJobId } : {}) }, { beforePersist }));
    else if (binding) {
      const previewMigrationProof = binding.state === 'closed' ? context.rescueRoute?.migrationProof : undefined;
      const resolved = await store.resolveRescueBindingForResume({ ...(context.legacyActivation
        ? authorityBindingLookup(context.authority ?? { childAgentId: context.executor.agentId }, caller, cwd)
        : context.executor ? bindingLookup(context.executor, cwd) : authorityBindingLookup(context.authority, caller, cwd)),
      permissionMode: caller.permissionMode, ...(previewMigrationProof ? { migrationProof: previewMigrationProof } : {}) });
      const migrationProof = previewMigrationProof;
      reserved = await reservePublicRescueJob(context, () => store.reserveBoundRescueContinuation({ workspace: cwd, reservation, ...childProof, lifecycle, operationId: context.rescueRoute?.expectedOperationId ?? resolved.operationId, ...(migrationProof ? { migrationProof } : {}), ...(context.rescueRoute?.expectedCurrentJobId ? {
        expectedCurrentJobId: context.rescueRoute.expectedCurrentJobId,
        expectedAnchorJobId: context.rescueRoute.expectedAnchorJobId ?? context.rescueRoute.candidateJobId,
        ...(context.rescueRoute.expectedBindingKey ? { expectedBindingKey: context.rescueRoute.expectedBindingKey } : {}),
        ...(context.rescueRoute.expectedBindingUpdatedAt ? { expectedBindingUpdatedAt: context.rescueRoute.expectedBindingUpdatedAt } : {}),
        ...(context.rescueRoute.expectedResumeSessionId ? { expectedResumeSessionId: context.rescueRoute.expectedResumeSessionId } : {}),
      } : {}) }, { beforePersist }));
      candidate = reserved.anchorJob;
    } else throw new PluginError('RESCUE_BINDING_INVALID', 'The private Rescue operation binding is invalid.', { category: 'authorization', remedy: 'Start a fresh Rescue operation from the active parent turn.' });
    job = reserved.job;
  } else if (parsed.command === 'rescue' && parsed.options.resume === 'resume' && candidate) {
    // A standalone --resume of any bound selected candidate (cancelled,
    // succeeded, or failed) advances the exact binding through the
    // continuation CAS (reserveBoundRescueContinuation): the CAS makes the new
    // job the binding's currentJobId, so the superseded candidate stops
    // advertising resumability (exactly one continuation) and the next resume
    // selection can find the new job. The caller has no executor identity, so
    // the binding is resolved by the exact job it anchors and its recorded
    // child authority is replayed for the reservation.
    const prior = await store.rescueBindingForJob({ workspace: cwd, ownerSessionId: caller.sessionId, jobId: candidate.id });
    if (prior === null && candidate.rescueReservationKind === 'bound') {
      // A bound candidate whose anchor disappeared between selection and this
      // lookup (a competing continuation advanced or closed it) fails closed:
      // resuming the superseded session would bypass the exactly-one
      // continuation CAS.
      throw new PluginError('RESUME_CANDIDATE_INVALID', 'The bound rescue candidate is no longer eligible.', { category: 'authorization', remedy: 'Reserve a fresh rescue job.' });
    }
    if (prior !== null) {
      const authority = rescueBindingAuthorityView(prior);
      // The executor fields follow the durable authority kind: a subagent-start
      // view carries parentTurnId/parentPermissionMode, while a codex-legacy-
      // adoption record carries authorizingParentTurnId/authorizingPermissionMode.
      // The executor replays the durable authority, EXCEPT the authorizing
      // turn: reserveBoundRescueContinuation validates the adoption authority
      // against the CURRENT reservation's ownerTurnId and permission snapshot,
      // so a legacy-adoption continuation is authorized by this turn — the
      // historical authorizingParentTurnId stays durable provenance only.
      const executor = authority.kind === 'codex-legacy-adoption'
        ? { parentSessionId: prior.parentSessionId, parentTurnId: caller.turnId, agentId: authority.childAgentId, agentType: authority.childAgentType,
            workspace: prior.workspace, parentPermissionMode: caller.permissionMode }
        : { parentSessionId: prior.parentSessionId, parentTurnId: authority.parentTurnId, agentId: authority.childAgentId, agentType: authority.childAgentType,
            ...(authority.agentPath !== undefined ? { agentPath: authority.agentPath } : {}), workspace: prior.workspace, parentPermissionMode: authority.parentPermissionMode };
      // A standalone resume continues a HOST-OWNED operation: ADR 0018 makes
      // the ZCode parent session the Host, and this caller turn IS that
      // session's authorized turn, so the continuation inherits the Host-
      // managed lifecycle — otherwise the next cancellation would close the
      // binding instead of preserving it, breaking resumability. The epoch
      // derives from the CURRENT recorded session start (fail closed when the
      // record is missing — reusing the superseded record's epoch would let a
      // prior ended epoch's receipt stop the new work), and the placement
      // honors this turn's execution choice. A missing record surfaces as the
      // stable RESUME_EPOCH_UNPROVEN PluginError, never a raw INTERNAL_ERROR.
      let epochPair;
      try { epochPair = await recordedSessionStartPair(dataRoot, cwd, caller.sessionId); }
      catch (/** @type {any} */ typedError) {
        if (typedError?.code === 'SETUP_SESSION_UNPROVEN') {
          throw new PluginError('RESUME_EPOCH_UNPROVEN', 'The current Host session record is missing, so the lifecycle epoch cannot be derived.', { category: 'authorization', remedy: 'Restart the Codex session or resume from a session with a recorded start.', cause: typedError });
        }
        throw typedError;
      }
      const lifecycle = {
        ownerLifecycleEpoch: epochPair.epoch,
        executionOwner: 'host-child',
        hostPlacement: parsed.options.execution === 'background' ? 'background' : 'foreground',
      };
      const reserved = await reservePublicRescueJob(context, () => store.reserveBoundRescueContinuation({ workspace: cwd, reservation, executor,
        operationId: prior.operationId, expectedCurrentJobId: candidate.id, expectedAnchorJobId: prior.anchorJobId, lifecycle }, { beforePersist: reservationEpochGate(context, epochPair.epoch) }));
      job = reserved.job;
      candidate = reserved.anchorJob;
    } else {
      // An unbound (legacy) candidate has no binding to advance: it keeps the
      // generic reservation path and its legacy resume semantics unchanged.
      job = await reservePublicJob(context, reservation);
    }
  } else job = await reservePublicJob(context, reservation);
  if (parsed.command === 'transfer') {
    return executeTransfer({ job, workspace: job.workspace, dataRoot, store, sourceThreadId: /** @type {string} */ (transferSource), signal: context.signal, progressWriter: context.progressWriter, resolveLaunch: () => discoverLaunch(context.env),
      readThread: () => (context.dependencies?.readCodexThread ?? readCodexThread)(transferSource, codexAppServerOptions(context.env, job.workspace, context.signal)),
      createClient: (launch) => (context.dependencies?.createManagedZCodeClient ?? createManagedZCodeClient)({ dataRoot, workspace: job.workspace, launch, ownerId: ownerIdForSession(caller.sessionId), env: context.env, ...managedWireOptionsForJob(job) }),
    });
  }
  const spec = normalizeSpec({ command: parsed.command, scope: parsed.options.scope, base: parsed.options.base, focus: parsed.positionals.join(' ') || context.originalPrompt, task: parsed.positionals.join(' ') || context.originalPrompt, model: parsed.options.model, effort: parsed.options.effort, resumeSessionId: parsed.options.resume === 'resume' ? candidate?.zcodeSessionId : undefined, candidateJobId: parsed.options.resume === 'resume' ? candidate?.id : undefined });
  if (parsed.options.execution === 'background' && validHostLifecycleRecord(job)) {
    // A Host-owned background continuation executes ATTACHED in this process
    // (ADR 0018: new Host-owned Rescue never launches a detached worker). The
    // reservation keeps the caller's session-bound execution alive until the
    // turn settles; the reserved background contract surfaces only after the
    // durable terminal winner exists.
    let terminal;
    try {
      terminal = await executeWithWorkerLease({ ...context, job, spec });
    } catch (executionError) {
      // A failed/cancelled durable winner still owes the bounded completion
      // notice: reread the durable terminal job, emit the notice with the
      // failure summary / stop cause, then rethrow the original execution
      // error so the CLI surfaces it.
      let reread = null;
      try { reread = await store.readJob(cwd, job.id); } catch { reread = null; }
      // Only a run whose remote session was ACCEPTED owes the failure notice:
      // resume/setup failures before acceptance roll back exactly as foreground
      // does (rejection), per the Engine Terminal Failure semantics.
      if (reread !== null && typeof reread.zcodeSessionId !== 'string') { reread = null; }
      // An EXTERNAL cancel/steer keeps its interrupted-turn contract (the
      // child surfaces ZCODE_SESSION_STOPPED with a nonzero exit); only an
      // engine/model terminal failure emits the bounded failure notice.
      const typedExecutionError = /** @type {any} */ (executionError);
      const interruptedTurn = typedExecutionError?.code === 'JOB_INTERRUPTED'
        || typedExecutionError?.code === 'ZCODE_SESSION_STOPPED'
        || /ZCODE_SESSION_STOPPED/.test(String(typedExecutionError?.message ?? ''));
      if (reread !== null && interruptedTurn) { reread = null; }
      if (reread !== null && ['failed', 'cancelled'].includes(reread.status)) {
        // Route through the normal claimed delivery path WITHOUT pre-claiming:
        // the CLI's claimNotificationForJob is the single ownership point —
        // pre-claiming here would make the CLI lose to its own live claim and
        // silently drop the failure notice.
        const bindingCurrent = await bindingCurrencyEvidence(store, cwd, caller.sessionId, reread).catch(() => false);
        return { type: 'background-terminal', noticeTarget: { dataRoot, workspace: cwd, sessionId: caller.sessionId }, job: terminalResultJob(reread, caller.permissionMode, bindingCurrent), resultCommand: '$zcode:result' };
      }
      throw executionError;
    }
    // The Host Completion Notice is bounded by design 319: job ID, terminal
    // status, bounded stop cause / failure summary, resumability, and the
    // Result command — no session IDs, private paths, or raw job internals.
    let settledJob = terminal?.job ?? terminal;
    const bindingCurrent = await bindingCurrencyEvidence(store, cwd, caller.sessionId, settledJob);
    // Acknowledgement happens at the delivery-success boundary in
    // runCompanionCli (after the notice is rendered to stdout), not here.
    return { type: 'background-terminal', noticeTarget: { dataRoot, workspace: cwd, sessionId: caller.sessionId }, job: terminalResultJob(settledJob, caller.permissionMode, bindingCurrent), resultCommand: '$zcode:result' };
  }
  if (parsed.options.execution === 'background') {
    const binding = { jobId: job.id, ownerSessionId: caller.sessionId, workspace: cwd, operation: 'run-reserved-job', jobSpecFormat: 'sealed-v2' };
    let capability;
    try {
      context.signal?.throwIfAborted();
      capability = await (context.dependencies?.createExecutionCapability ?? ((/** @type {any} */ input) => identity.createExecutionCapability(input)))({ ...binding, permissionSnapshot });
      context.signal?.throwIfAborted();
      const record = sealJobSpec(job, spec, capability);
      const executionReservation = {
        version: 1, capabilityDigest: createHash('sha256').update(capability).digest('hex'),
        reservationId: createHash('sha256').update('zcode-execution-reservation-v1\0').update(capability).digest('hex'),
        jobId: job.id, ownerSessionId: job.ownerSessionId, workspace: job.workspace,
        operation: 'run-reserved-job', jobSpecFormat: 'sealed-v2',
      };
      job = await store.publishJobSpecCommitment(cwd, job.id, record.commitment, executionReservation);
      await context.dependencies?.testOnlyAfterJobSpecCommitment?.(job);
      await (context.dependencies?.writeJobSpec ?? writeJobSpec)(dataRoot, cwd, job, record);
      if (context.autoLaunchBackground) {
        context.signal?.throwIfAborted();
        await (context.dependencies?.startBackgroundWorker ?? startBackgroundWorker)({ companionPath: fileURLToPath(import.meta.url), jobId: job.id, executionCapability: capability, cwd, env: context.env });
        return { type: 'background', job: publicReservedJob(job) };
      }
      const output = (context.dependencies?.buildBackgroundOutput ?? ((/** @type {any} */ value) => value))({ type: 'background', job: publicReservedJob(job), privateInvocation: ['run-reserved-job', job.id], executionCapability: capability });
      backgroundBindings.set(output, { identity, store, capability, binding });
      return output;
    } catch (error) {
      if (capability) await identity.revokeExecutionCapability(capability, binding).catch(() => {});
      await failQueuedJob(store, cwd, job.id, error);
      throw error;
    }
  }
  return executeWithWorkerLease({ ...context, job, spec });
}

/** @param {any} binding */
function boundNeedsChoice(binding) { const output = { type: 'needs-choice', choices: ['--resume', '--fresh'] }; rescueChoiceRoutes.set(output, { routeKind: 'bound', candidateJobId: binding.anchorJobId, expectedOperationId: binding.operationId, expectedCurrentJobId: binding.currentJobId }); return output; }

/** @param {any} executor @param {string} workspace */
function bindingLookup(executor, workspace) {
  return { workspace, parentSessionId: executor.parentSessionId, executorAgentId: executor.agentId, executorAgentType: executor.agentType,
    executorParentTurnId: executor.parentTurnId, executorParentPermissionMode: executor.parentPermissionMode,
    ...(executor.agentPath ? { executorAgentPath: executor.agentPath } : {}) };
}

/** @param {any} authority @param {any} caller @param {string} workspace */
function authorityBindingLookup(authority, caller, workspace) {
  return { workspace, parentSessionId: caller.sessionId, executorAgentId: authority.childAgentId };
}

/**
 * Derive the Host lifecycle epoch of one session from its CURRENT recorded
 * SessionStart. Fails closed when the record is missing: reusing a superseded
 * record's epoch would let a prior ended epoch's receipt stop the new work, and
 * reserving without an epoch would recreate the untracked legacy records the
 * Host-managed lifecycle replaces (ADR 0018).
 * @param {string} dataRoot @param {string} workspace @param {string} sessionId
 */
/** Derive the Host lifecycle epoch of one session from its CURRENT recorded SessionStart (fail-closed on a missing record).
 * @param {string} dataRoot @param {string} workspace @param {string} sessionId */

/** @param {any} context @param {()=>Promise<any>} reserve */
async function reservePublicRescueJob(context, reserve) {
  context.signal?.throwIfAborted();
  await rejectUnsettledPriorEpoch(context);
  try { return await reserve(); }
  catch (error) {
    if (!(error instanceof PluginError) || error.code !== 'WRITABLE_JOB_EXISTS') throw error;
    context.signal?.throwIfAborted();
    await scavengeWritableJobs({ store: context.store, dataRoot: context.dataRoot, workspace: context.cwd, signal: context.signal, createClient: async (job) => {
      context.signal?.throwIfAborted();
      const launch = await discoverLaunch(context.env, context.dependencies);
      context.signal?.throwIfAborted();
      return (context.dependencies?.createManagedZCodeClient ?? createManagedZCodeClient)({ dataRoot: context.dataRoot, workspace: job.workspace, launch, ownerId: ownerIdForSession(job.ownerSessionId), env: context.env, ...managedWireOptionsForJob(job) });
    } });
    context.signal?.throwIfAborted();
    return reserve();
  }
}

// One bounded budget for the prompt-time reconciliation retry at reservation time;
// remote control uses only an existing broker client, never a lazy spawn.
const PRIOR_EPOCH_RECONCILIATION_BUDGET_MS = 1_500;

/**
 * The atomic epoch fence passed as the reservation's own `beforePersist` gate:
 * it runs INSIDE the reservation's `withFileLock` critical section immediately
 * before any record is written, so a SessionEnd receipt published between the
 * prompt-time checks and the persist can no longer interleave — the waiter
 * either entered before the boundary's final scan (and gets delegated) or is
 * rejected here with PRIOR_EPOCH_UNSETTLED. The scan is read-only and bounded;
 * it never reconciles (reconciliation takes job locks).
 * @param {any} context @param {string=} epochPair The reservation's derived lifecycle epoch, so a receipt for this exact epoch (ANY state) and a superseded-anchor revalidation fence the reservation.
 */
function reservationEpochGate(context, epochPair = undefined) {
  return async () => {
    const sessionId = context.caller?.sessionId;
    if (typeof sessionId !== 'string' || sessionId.length === 0) return;
    // The current epoch is proved against the session's origin workspace, the
    // same record the reservation's lifecycle epoch derived from.
    const workspace = context.executor?.originWorkspace ?? context.authority?.originWorkspace ?? context.cwd;
    let epoch = epochPair;
    if (epoch === undefined) {
      // Generic (non-trio) reservations derive their caller's current epoch
      // lazily, raced against the same bounded budget the fence advertises
      // (the unbounded read runs while reserveJob holds the job lock). Only a
      // PROVEN absence (ENOENT) tolerates an undefined epoch; corruption,
      // contention, or a budget loss fails closed — the reservation is
      // rejected instead of being admitted without anchor evidence.
      const derivationSignal = AbortSignal.timeout(PRIOR_EPOCH_RECONCILIATION_BUDGET_MS);
      try {
        epoch = (await Promise.race([
          recordedSessionStartPair(context.dataRoot, workspace, sessionId),
          new Promise((resolve, reject) => {
            if (derivationSignal.aborted) { reject(derivationSignal.reason); return; }
            derivationSignal.addEventListener('abort', () => reject(derivationSignal.reason), { once: true });
          }),
        ])).epoch;
      } catch (error) {
        const typedError = /** @type {any} */ (error);
        const absent = typedError?.code === 'SETUP_SESSION_UNPROVEN'
          && (typedError?.cause?.cause?.code === 'ENOENT' || typedError?.cause?.code === 'ENOENT');
        if (!absent) throw error;
        epoch = undefined;
      }
    }
    await assertNoPendingPriorEpochReceipts({ dataRoot: context.dataRoot, sessionId, workspace, ownerLifecycleEpoch: epoch, signal: context.signal });
  };
}

/**
 * Resume after SessionEnd: while this session's previous lifecycle epoch still
 * has unresolved pending receipts, new writable Rescue work stays blocked behind
 * the pending compensation authority (design 'Resume after SessionEnd'). The
 * gate first retries the same bounded reconciliation the UserPromptSubmit hook
 * runs, then fails closed with one stable error when receipts remain pending.
 * Status, result, and cancel never enter this path and stay available. This is
 * the PROMPT-TIME gate; the reservation's own locked critical section repeats
 * the fail-closed check through reservationEpochGate, which closes the
 * publish-between-check-and-persist window this pre-lock pass cannot.
 * @param {any} context
 */
async function rejectUnsettledPriorEpoch(context) {
  const sessionId = context.caller?.sessionId;
  if (typeof sessionId !== 'string' || sessionId.length === 0) return;
  const signal = context.signal === undefined
    ? AbortSignal.timeout(PRIOR_EPOCH_RECONCILIATION_BUDGET_MS)
    : AbortSignal.any([context.signal, AbortSignal.timeout(PRIOR_EPOCH_RECONCILIATION_BUDGET_MS)]);
  const callerAborted = () => context.signal?.aborted === true;
  let pending = [];
  try { pending = await pendingPriorEpochReceipts(context.dataRoot, sessionId, context.cwd, { signal }); }
  catch {
    // An already-aborted caller keeps its own interrupt semantics: swallowing
    // lets the reservation's claim path raise the interruption where the
    // cancel-before-discovery contract expects it. Any OTHER unreadable scan
    // (contention, corruption, an unsafe path) is an unresolved reconciliation
    // and must BLOCK new writable Rescue work instead of admitting it blind.
    if (callerAborted()) return;
    throw priorEpochUnsettledError(0);
  }
  if (pending.length === 0) return;
  try { await reconcilePriorEpochReceipts({ dataRoot: context.dataRoot, sessionId, workspace: context.cwd, signal }); }
  catch { /* the block decision reads the durable receipts below */ }
  try { pending = await pendingPriorEpochReceipts(context.dataRoot, sessionId, context.cwd, { signal }); }
  catch {
    // Pending receipts were OBSERVED before reconciliation: an unreadable
    // decision re-read (budget spent, contention) is uncertainty, and
    // uncertainty must BLOCK new writable work — never admit it.
    if (callerAborted()) return;
    throw priorEpochUnsettledError(pending.length);
  }
  if (pending.length === 0) return;
  throw priorEpochUnsettledError(pending.length);
}

/** @param {any} context @param {any} reservation */
async function reservePublicJob(context, reservation) {
  // Direct (non-child-authorized) new Rescue reserves here: the same unsettled
  // prior-epoch block applies to every writable Rescue reservation path. The
  // gate must not surface an already-aborted caller signal — the invocation's
  // own interrupt semantics own that decision after the claim. The prompt-time
  // check below is the reconciliation retry; the reservation's OWN locked
  // critical section repeats the fail-closed check via beforePersist.
  const creator = ['review', 'adversarial-review', 'transfer'].includes(reservation.command);
  if (creator) await context.dependencies?.testOnlyBeforeJobReservation?.(context.caller);
  if (!reservation.readOnly) await rejectUnsettledPriorEpoch(context);
  const gate = reservationEpochGate(context);
  const reserve = () => reservation.readOnly
    ? context.store.reserveJob(reservation)
    : context.store.reserveJob(reservation, { beforePersist: gate });
  const reserveDurably = () => creator
    ? withCreatorPartitionFence(context.identity, context.creatorAuthority ?? context.caller, reserve)
    : reserve();
  try { return await reserveDurably(); }
  catch (error) {
    if (reservation.readOnly || !(error instanceof PluginError) || error.code !== 'WRITABLE_JOB_EXISTS') throw error;
    context.signal?.throwIfAborted();
    await scavengeWritableJobs({
      store: context.store,
      dataRoot: context.dataRoot,
      workspace: context.cwd,
      signal: context.signal,
      createClient: async (job) => {
        context.signal?.throwIfAborted();
        const launch = await discoverLaunch(context.env, context.dependencies);
        context.signal?.throwIfAborted();
        return (context.dependencies?.createManagedZCodeClient ?? createManagedZCodeClient)({ dataRoot: context.dataRoot, workspace: job.workspace, launch, ownerId: ownerIdForSession(job.ownerSessionId), env: context.env, ...managedWireOptionsForJob(job) });
      },
    });
    context.signal?.throwIfAborted();
    return reserveDurably();
  }
}

/** Fence one v3 creator's short durable partition write; legacy callers retain their historical behavior. @param {any} identity @param {any} caller @param {()=>Promise<any>} operation */
function withCreatorPartitionFence(identity, caller, operation) {
  if (caller.generationId === undefined) return operation();
  return identity.withSelectedJobWorkspace({
    sessionId: caller.sessionId, turnId: caller.turnId, generationId: caller.generationId,
    originWorkspace: caller.originWorkspace, workspace: caller.workspace,
  }, operation);
}

/** @param {any} job */
function managedWireOptionsForJob(job) { return job?.command === 'transfer' ? { maxFrameBytes: TRANSFER_WIRE_LIMITS.maxFrameBytes, maxOutboundBytes: TRANSFER_WIRE_LIMITS.maxOutboundBytes, drainTimeoutMs: TRANSFER_WIRE_LIMITS.drainTimeoutMs } : {}; }

/** @param {NodeJS.ProcessEnv} env @param {string} cwd @param {AbortSignal} [signal] */
function codexAppServerOptions(env, cwd, signal) {
  let args;
  if (env.CODEX_APP_SERVER_ARGS_JSON !== undefined) {
    try { args = JSON.parse(env.CODEX_APP_SERVER_ARGS_JSON); } catch (cause) { throw new PluginError('CODEX_APP_SERVER_CONFIG_INVALID', 'Codex app-server arguments are invalid.', { category: 'configuration', remedy: 'Run $zcode:setup and repair the Codex app-server launcher.', cause }); }
    if (!Array.isArray(args) || args.some((value) => typeof value !== 'string')) throw new PluginError('CODEX_APP_SERVER_CONFIG_INVALID', 'Codex app-server arguments are invalid.', { category: 'configuration', remedy: 'Run $zcode:setup and repair the Codex app-server launcher.' });
  }
  return { ...(env.CODEX_APP_SERVER_PATH ? { executable: env.CODEX_APP_SERVER_PATH } : {}), ...(args ? { args } : {}), cwd, env, ...(signal ? { signal } : {}) };
}

/** @param {any} input */
async function runReserved({ parsed, cwd, env, dataRoot, identity, store, authorization, startupAck, dependencies, signal }) {
  const jobId = parsed.positionals[0]; const job = await store.readJob(cwd, jobId);
  if (authorization.jobId !== jobId) throw authorizationInputError();
  // The detached worker path is retained only for historical detached Rescue
  // and read-only commands (ADR 0018). A record carrying the host-managed
  // lifecycle trio executes attached under its Host child, so even a valid
  // historical-style sealed spec plus capability must never pull it back into
  // detached execution. The refusal precedes any spec read or capability use.
  if (validHostLifecycleRecord(job)) throw new PluginError('RESCUE_DETACHED_EXECUTION_FORBIDDEN', 'A Host-owned Rescue executes attached; the detached worker path is historical only.', { category: 'authorization', remedy: 'Wait on the original Host-managed Rescue execution.' });
  const record = await readJobSpec(dataRoot, cwd, jobId);
  let spec; let loadSpecAfterClaim; let capabilityBinding; let executionAuthorization; let legacySpecDigest; let legacyReservationProof;
  if (record?.version === 2) {
    const sealed = verifySealedJobSpec(record, job, authorization.executionCapability);
    spec = { command: job.command };
    loadSpecAfterClaim = () => openSealedJobSpec(sealed, authorization.executionCapability);
    capabilityBinding = { jobSpecFormat: 'sealed-v2' };
    executionAuthorization = { sealedCommitment: sealed.commitment };
  } else if (record?.version === 1) {
    spec = normalizeSpec(parseExactLegacyJobSpecRecord(record, job, jobSpecTampered));
    const specDigest = digestSpec(spec);
    if (record.digest !== specDigest || record.jobId !== job.id || record.ownerSessionId !== job.ownerSessionId || record.workspace !== job.workspace) throw jobSpecTampered();
    capabilityBinding = { specDigest };
    legacySpecDigest = specDigest;
    legacyReservationProof = legacyClasslessProof(spec);
  } else throw jobSpecTampered();
  const capabilityExpected = { jobId, ownerSessionId: job.ownerSessionId, workspace: cwd, operation: 'run-reserved-job', ...capabilityBinding };
  const capabilityReservationId = createHash('sha256').update('zcode-execution-reservation-v1\0')
    .update(authorization.executionCapability).digest('hex');
  const executionReservation = {
    version: 1, capabilityDigest: createHash('sha256').update(authorization.executionCapability).digest('hex'),
    reservationId: capabilityReservationId, jobId: job.id, ownerSessionId: job.ownerSessionId,
    workspace: job.workspace, operation: 'run-reserved-job',
    ...(record.version === 2 ? { jobSpecFormat: 'sealed-v2' }
      : { jobSpecFormat: 'legacy-v1', specDigest: legacySpecDigest }),
  };
  const inspected = await identity.inspectExecutionCapability(authorization.executionCapability, capabilityExpected, capabilityReservationId);
  if (record.version === 1 && inspected.jobSpecFormat !== undefined) throw jobSpecTampered();
  if (!sameJson(inspected.permissionSnapshot, job.permissionSnapshot)) throw new PluginError('EXECUTION_SNAPSHOT_MISMATCH', 'Execution capability permission snapshot does not match the reserved job.', { category: 'authorization', remedy: 'Issue a new capability from the exact reserved job.' });
  if (job.status !== 'queued') {
    if (['cancelled', 'failed', 'succeeded'].includes(job.status)) {
      if (job.rescueExecutionReservation !== undefined) await store.cleanupTerminalExecutionReservation(cwd, job.id, identity);
      else await identity.releaseExecutionCapability(authorization.executionCapability, capabilityExpected, capabilityReservationId);
    }
    throw new PluginError('RESERVED_JOB_NOT_QUEUED', `Reserved job ${jobId} is ${job.status}.`, { category: 'state', remedy: 'Generate a new execution capability only for a queued job.' });
  }
  return executeWithWorkerLease({ parsed, cwd, env, dataRoot, identity, store, job, spec, loadSpecAfterClaim,
    executionAuthorization, legacySpecDigest, legacyReservationProof, executionCapability: authorization.executionCapability,
    capabilityExpected, capabilityReservationId, executionReservation,
    caller: { sessionId: job.ownerSessionId }, dependencies, signal, ...(startupAck ? { onBoundaryPersisted: async () => startupAck() } : {}) });
}

/** @param {any} context */
async function executeWithWorkerLease(context) {
  let migrationRollback; let markerlessMigration = false;
  try {
    const migration = await migrationRollbackForExecution(context.store, context.cwd, context.spec, context.job,
      context.legacySpecDigest);
    migrationRollback = migration.rollback; markerlessMigration = migration.markerless;
  }
  catch (error) {
    if (error instanceof PluginError && error.code === 'RESCUE_BINDING_NOT_RUNNABLE') {
      await context.store.finishJob(context.cwd, context.job.id, ['queued'], 'failed', { error: { message: error.message }, exitCode: 1 });
    }
    throw error;
  }
  const executionAuthorization = context.executionAuthorization ?? (context.legacySpecDigest === undefined ? undefined : markerlessMigration
    ? { legacyProof: 'markerless-migration', specDigest: context.legacySpecDigest }
    : { legacyProof: context.legacyReservationProof });
  await context.dependencies?.testOnlyBeforeExecutionInspection?.();
  const initialExecutionInspection = await context.store.inspectJobWorkerExecution(
    context.cwd, context.job.id, migrationRollback, executionAuthorization);
  const workerLeaseId = randomBytes(32).toString('hex');
  return withWorkerLease({ dataRoot: context.dataRoot, workspace: context.cwd, jobId: context.job.id, workerLeaseId }, async () => {
    let job; let spec = context.spec;
    let capabilityCommitted = context.executionCapability === undefined;
    try {
      await context.dependencies?.testOnlyBeforeExecutionClaim?.();
      let executionInspection;
      if (context.executionCapability !== undefined) {
        await context.dependencies?.testOnlyBeforeExecutionFence?.({
          inspection: initialExecutionInspection, workerLeaseId,
        });
        const fenced = await context.store.fenceJobWorkerExecution(context.cwd, context.job.id,
          { childPid: process.pid, workerLeaseId }, migrationRollback, executionAuthorization,
          initialExecutionInspection, context.executionReservation);
        executionInspection = fenced.inspection;
        await context.dependencies?.testOnlyAfterExecutionFence?.({
          inspection: executionInspection, workerLeaseId,
        });
        await context.identity.reserveExecutionCapability(context.executionCapability,
          context.capabilityExpected, context.capabilityReservationId, workerLeaseId);
      } else executionInspection = await context.store.inspectJobWorkerExecution(context.cwd, context.job.id,
        migrationRollback, executionAuthorization);
      job = await context.store.claimJobWorkerForExecution(context.cwd, context.job.id,
        { childPid: process.pid, workerLeaseId }, migrationRollback,
        executionAuthorization, executionInspection);
      await context.dependencies?.testOnlyAfterStateClaimBeforeCapabilityCommit?.();
      if (context.executionCapability !== undefined) {
        await context.identity.commitExecutionCapability(context.executionCapability, context.capabilityExpected,
          context.capabilityReservationId, workerLeaseId);
        capabilityCommitted = true;
      }
      await context.dependencies?.testOnlyAfterExecutionClaim?.();
      if (context.loadSpecAfterClaim) spec = await context.loadSpecAfterClaim();
    } catch (error) {
      const reconciliation = await context.store.finishJobAfterExecutionClaimFailure(context.cwd, context.job.id, workerLeaseId, {
        error: { message: error instanceof Error ? error.message.slice(0, 2048) : 'Execution authorization failed' }, exitCode: 1,
      }).catch(() => undefined);
      if (!capabilityCommitted && context.executionCapability !== undefined && reconciliation?.kind === 'settled') {
        if (context.executionReservation !== undefined) {
          await context.store.cleanupTerminalExecutionReservation(context.cwd, context.job.id, context.identity).catch(() => {});
        } else {
          await context.identity.releaseExecutionCapability(context.executionCapability,
            context.capabilityExpected, context.capabilityReservationId, workerLeaseId).catch(() => {});
        }
      }
      throw error;
    }
    let result;
    try {
      result = await executeReserved({ ...context, job, spec, migrationRollback, childPid: process.pid, workerLeaseId });
    } catch (error) {
      if (context.executionReservation !== undefined) {
        await context.store.cleanupTerminalExecutionReservation(context.cwd, context.job.id, context.identity).catch(() => {});
      }
      throw error;
    }
    if (context.executionReservation === undefined) return result;
    const cleaned = await context.store.cleanupTerminalExecutionReservation(
      context.cwd, context.job.id, context.identity).catch(() => undefined);
    return cleaned === undefined || result?.job === undefined ? result : { ...result, job: cleaned };
  });
}

/** @param {any} context */
async function executeReserved(context) {
  const { cwd, env, dataRoot, store, job, spec } = context;
  let client; let executeJobEntered = false; let resumeRpcSucceeded = false; let runningPersisted = false;
  const migrationRollback = context.migrationRollback;
  const activeContinuationProof = job.rescueContinuationOrigin?.kind === 'active-continuation'
    ? job.rescueContinuationOrigin : undefined;
  const finishResumeFailure = activeContinuationProof
    ? (/** @type {unknown} */ error) => store.finishActiveRescueContinuationFailure(cwd, job.id, context.workerLeaseId,
      activeContinuationProof, 'failed', {
      error: { message: error instanceof Error ? error.message.slice(0, 2048) : 'ZCode resume failed' }, exitCode: 1,
    })
    : migrationRollback ? (/** @type {unknown} */ error) => store.finishSessionEndedRescueContinuation(cwd, job.id, migrationRollback, 'failed', {
      error: { message: error instanceof Error ? error.message.slice(0, 2048) : 'ZCode resume failed' }, exitCode: 1,
    }) : undefined;
  const activeRollbackAllowed = (/** @type {unknown} */ error) => !runningPersisted && !isInterruption(error)
    && (!(error instanceof PluginError) || error.code !== 'RESCUE_BINDING_STALE');
  const convergeResumeFailure = async (/** @type {unknown} */ error) => {
    if (!finishResumeFailure) return undefined;
    if (activeContinuationProof) {
      if (!activeRollbackAllowed(error)) return undefined;
      try { return await finishResumeFailure(error); }
      catch (settlementError) {
        try { return await finishResumeFailure(error); }
        catch { throw settlementError; }
      }
    }
    if (!migrationRollback) return undefined;
    if (!resumeRpcSucceeded) return finishResumeFailure(error);
    return undefined;
  };
  try {
    context.signal?.throwIfAborted();
    const launch = await discoverLaunch(env, context.dependencies); const ownerId = ownerIdForSession(job.ownerSessionId);
    context.signal?.throwIfAborted();
    client = await createManagedZCodeClient({ dataRoot, workspace: cwd, launch, ownerId, env });
    const modelConfig = await readWorkspaceModelConfig({ dataRoot, workspace: cwd }); const modelRequest = spec.model ?? modelConfig.defaultModel;
    const preResolvedModel = modelRequest && (modelRequest.includes('/') || Object.hasOwn(modelConfig.models, modelRequest)) ? resolveModel(modelRequest, modelConfig.models, []) : undefined;
    const executionClient = client; client = undefined;
    executeJobEntered = true;
    return await executeJob({ job, workspace: cwd, dataRoot, store, client: executionClient, scope: spec.scope, base: spec.base, focus: spec.focus, task: spec.task, model: preResolvedModel, modelRequest: preResolvedModel ? undefined : modelRequest, modelAliases: modelConfig.models, resolveRuntimeRecoveryConfig: (model) => readZCodeCliRuntimeModel({ env, ...(model ? { model } : {}) }), effort: spec.effort, resumeSessionId: spec.resumeSessionId, childPid: context.childPid, workerLeaseId: context.workerLeaseId, onBoundaryPersisted: context.onBoundaryPersisted, progressWriter: context.progressWriter, progressRelayWriter: context.progressRelayWriter, progressDependencies: context.progressDependencies, signal: context.signal, onBeforeResume: async () => { await validateResumeCandidate(store, cwd, job.ownerSessionId, spec); await (context.dependencies?.reconcileBrokerOwnership ?? reconcileBrokerOwnership)({ dataRoot, workspace: cwd, ownerId, ownedSessionIds: [spec.resumeSessionId] }); if (job.rescueContinuationOrigin || job.rescueMigrationRollback) await store.validateReservedRescueContinuation({ workspace: cwd, parentSessionId: job.ownerSessionId, jobId: job.id, candidateJobId: spec.candidateJobId, resumeSessionId: spec.resumeSessionId }); }, onResumeRpcSucceeded: () => { resumeRpcSucceeded = true; }, onRunningPersisted: () => { runningPersisted = true; }, ...(finishResumeFailure ? { onResumeFailure: convergeResumeFailure } : {}) });
  } catch (error) {
    await client?.close().catch(() => {});
    const executionError = error instanceof ResumeFailureSettlementError ? error.executionError : error;
    const current = await store.readJob(cwd, job.id).catch(() => null);
    const settlementRequired = migrationRollback && !resumeRpcSucceeded
      || activeContinuationProof && activeRollbackAllowed(executionError);
    if (finishResumeFailure && settlementRequired
      && (current?.status === 'queued' || current === null
        && (activeContinuationProof && !executeJobEntered || error instanceof ResumeFailureSettlementError))) {
      await convergeResumeFailure(executionError);
    } else if (isInterruption(executionError) && current?.status === 'queued') {
      if (current.workerLeaseId === context.workerLeaseId) await cancelClaimedQueuedInterruption(context).catch(() => {});
      else await createJobController({ store, dataRoot }).cancel(cwd, job.id, job.ownerSessionId).catch(() => {});
    } else if (!isInterruption(executionError) && current?.status === 'queued') {
      await store.finishJob(cwd, job.id, ['queued'], 'failed', { error: { message: executionError instanceof Error ? executionError.message.slice(0, 2048) : 'Execution failed' }, exitCode: 1 });
    }
    throw executionError;
  }
}

/** @param {NodeJS.ProcessEnv} env */
/** @param {NodeJS.ProcessEnv} env @param {any} [dependencies] */
async function discoverLaunch(env, dependencies = {}) {
  if (dependencies?.discoverLaunch) return dependencies.discoverLaunch(env);
  return (await discoverZCode({ explicitPath: env.ZCODE_PATH, env })).launch;
}

/** @param {any} job @param {Record<string,string>} spec @param {string} capability */
function sealJobSpec(job, spec, capability) {
  const plaintext = Buffer.from(JSON.stringify(spec));
  const commitment = createHmac('sha256', jobSpecKey('commitment', capability)).update(plaintext).digest('hex');
  const identity = { version: 2, jobId: job.id, ownerSessionId: job.ownerSessionId, workspace: job.workspace, commitment };
  const aad = Buffer.from(JSON.stringify(identity)); const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', jobSpecKey('encryption', capability), iv); cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]); const tag = cipher.getAuthTag();
  const mac = jobSpecMac(jobSpecKey('authentication', capability), aad, iv, tag, ciphertext);
  return { ...identity, sealedSpec: { algorithm: 'aes-256-gcm', iv: iv.toString('base64url'), ciphertext: ciphertext.toString('base64url'), tag: tag.toString('base64url'), mac: mac.toString('base64url') } };
}

/** @param {'encryption'|'authentication'|'commitment'} purpose @param {string} capability */
function jobSpecKey(purpose, capability) { return createHash('sha256').update(`zcode-job-spec-${purpose}-v2\0`).update(capability).digest(); }
/** @param {Buffer} key @param {Buffer} aad @param {Buffer} iv @param {Buffer} tag @param {Buffer} ciphertext */
function jobSpecMac(key, aad, iv, tag, ciphertext) { return createHmac('sha256', key).update(aad).update(iv).update(tag).update(ciphertext).digest(); }
/** @param {unknown} value @param {number|undefined} exactBytes */
function decodeJobSpecBase64(value, exactBytes) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/u.test(value)) throw jobSpecTampered();
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.toString('base64url') !== value || (exactBytes !== undefined && decoded.length !== exactBytes)) throw jobSpecTampered();
  return decoded;
}
/** @param {any} record @param {any} job @param {string} capability */
function verifySealedJobSpec(record, job, capability) {
  const outerKeys = ['version', 'jobId', 'ownerSessionId', 'workspace', 'commitment', 'sealedSpec'];
  const sealedKeys = ['algorithm', 'iv', 'ciphertext', 'tag', 'mac'];
  if (!record || typeof record !== 'object' || Array.isArray(record) || Object.keys(record).length !== outerKeys.length || outerKeys.some((key) => !Object.hasOwn(record, key))
    || record.version !== 2 || record.jobId !== job.id || record.ownerSessionId !== job.ownerSessionId || record.workspace !== job.workspace || !/^[a-f0-9]{64}$/u.test(record.commitment)
    || !record.sealedSpec || typeof record.sealedSpec !== 'object' || Array.isArray(record.sealedSpec) || Object.keys(record.sealedSpec).length !== sealedKeys.length || sealedKeys.some((key) => !Object.hasOwn(record.sealedSpec, key))
    || record.sealedSpec.algorithm !== 'aes-256-gcm') throw jobSpecTampered();
  const identity = { version: 2, jobId: record.jobId, ownerSessionId: record.ownerSessionId, workspace: record.workspace, commitment: record.commitment };
  const aad = Buffer.from(JSON.stringify(identity)); const iv = decodeJobSpecBase64(record.sealedSpec.iv, 12);
  const ciphertext = decodeJobSpecBase64(record.sealedSpec.ciphertext, undefined); const tag = decodeJobSpecBase64(record.sealedSpec.tag, 16); const mac = decodeJobSpecBase64(record.sealedSpec.mac, 32);
  if (ciphertext.length === 0 || ciphertext.length > 512 * 1024) throw jobSpecTampered();
  const expected = jobSpecMac(jobSpecKey('authentication', capability), aad, iv, tag, ciphertext);
  if (!timingSafeEqual(mac, expected)) throw jobSpecTampered();
  return { commitment: record.commitment, aad, iv, ciphertext, tag };
}
/** @param {{commitment:string,aad:Buffer,iv:Buffer,ciphertext:Buffer,tag:Buffer}} sealed @param {string} capability */
function openSealedJobSpec(sealed, capability) {
  try {
    const decipher = createDecipheriv('aes-256-gcm', jobSpecKey('encryption', capability), sealed.iv); decipher.setAAD(sealed.aad); decipher.setAuthTag(sealed.tag);
    const plaintext = Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]);
    const spec = normalizeSpec(JSON.parse(plaintext.toString('utf8')));
    const commitment = createHmac('sha256', jobSpecKey('commitment', capability)).update(Buffer.from(JSON.stringify(spec))).digest('hex');
    if (!timingSafeEqual(Buffer.from(commitment, 'hex'), Buffer.from(sealed.commitment, 'hex'))) throw jobSpecTampered();
    return spec;
  } catch (error) {
    if (error instanceof PluginError) throw error;
    throw jobSpecTampered();
  }
}
function jobSpecTampered() { return new PluginError('JOB_SPEC_TAMPERED', 'Reserved job specification failed its immutable binding.', { category: 'authorization', remedy: 'Reserve a new background job.' }); }
/** @param {string} dataRoot @param {string} workspace @param {any} job @param {any} record */
async function writeJobSpec(dataRoot, workspace, job, record) {
  const storage = await resolveWorkspaceStorage({ dataRoot, workspace }); await atomicWriteJson(join(storage.directory, 'job-specs', `${job.id}.json`), record);
}
/** @param {string} dataRoot @param {string} workspace @param {string} jobId */
async function readJobSpec(dataRoot, workspace, jobId) {
  const storage = await resolveWorkspaceStorage({ dataRoot, workspace }); const root = resolve(storage.directory, 'job-specs'); const path = resolve(root, `${jobId}.json`);
  if (!path.startsWith(`${root}${sep}`)) throw new PluginError('JOB_SPEC_INVALID', 'Job specification path is invalid.', { category: 'storage', remedy: 'Reserve a new background job.' });
  return readBoundedJsonFile(storage.directory, path, 512 * 1024, { requirePrivatePermissions: true });
}
/** @param {unknown} left @param {unknown} right */
function sameJson(left, right) { return JSON.stringify(left) === JSON.stringify(right); }
/** @param {unknown} error */
function isInterruption(error) { return error instanceof PluginError && error.code === 'JOB_INTERRUPTED'; }
/** @param {any} context */
async function cancelClaimedQueuedInterruption(context) {
  return withJobCancellationLock({ dataRoot: context.dataRoot, workspace: context.cwd, jobId: context.job.id }, async () => {
    const current = await context.store.readJob(context.cwd, context.job.id);
    if (current.status !== 'queued' || current.workerLeaseId !== context.workerLeaseId) return current;
    // A queued pre-session interruption on a Host-owned Rescue publishes its
    // stop-intent fields atomically with the cancellation — the strict schema
    // requires them on every cancelled Host-owned winner, and the pre-session
    // cause is host-coordination-loss (this attached companion was
    // interrupted; no explicit user cancel occurred). Non-Rescue and legacy
    // records keep their bare cancellation shape.
    const hostOwned = validHostLifecycleRecord(current);
    const stopCause = current.stopIntent?.cause ?? 'host-coordination-loss';
    return context.store.finishJob(context.cwd, current.id, ['queued'], 'cancelled', hostOwned ? {
      exitCode: null,
      stopIntent: current.stopIntent ?? { version: 1, cause: stopCause, requestedAt: new Date().toISOString() },
      stopCause,
    } : { exitCode: null });
  });
}

/** @param {unknown} value @param {string[]} keys @returns {any} */
function requireAuthorization(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw authorizationInputError();
  const record = /** @type {Record<string,unknown>} */ (value);
  if (Object.keys(record).length !== keys.length || keys.some((key) => typeof record[key] !== 'string' || !record[key])) throw authorizationInputError();
  return value;
}
function authorizationInputError() { return new PluginError('INTERNAL_AUTHORIZATION_INVALID', 'The internal authorization envelope is invalid.', { category: 'authorization', remedy: 'Invoke this command through its installed skill using the protected internal channel.' }); }
/** @param {any} job @param {string} ownerSessionId @param {'list'|'detail'} projection @param {string} [viewingPermissionMode] @param {boolean} [bindingCurrent] */
function publicJob(job, ownerSessionId, projection, viewingPermissionMode, bindingCurrent) {
  if (job.ownerSessionId !== ownerSessionId) {
    return {
      id: job.id,
      status: job.status,
      createdAt: job.createdAt,
      ...copyOptionalFields(job, ['startedAt', 'finishedAt', 'lastActivityAt']),
      hasOwner: true,
    };
  }
  const visible = { ...job }; delete visible.ownerSessionId; delete visible.ownerTurnId; delete visible.permissionSnapshot; delete visible.progressProbe; delete visible.rescueMigrationRollback; delete visible.rescueContinuationOrigin; delete visible.rescueExecutionClaim; delete visible.rescueExecutionReservation; delete visible.rescueReservationKind; delete visible.rescueJobSpecCommitment; delete visible.rescueLegacyJobSpecProof; delete visible.ownerLifecycleEpoch; delete visible.executionOwner; delete visible.hostPlacement; delete visible.stopIntent; delete visible.zcodeSessionId; delete visible.childPid; delete visible.workerLeaseId;
  if (projection !== 'detail') delete visible.logFile;
  if (Object.hasOwn(visible, 'error')) {
    const message = publicErrorMessage(visible.error);
    if (message === null) delete visible.error; else visible.error = { message };
  }
  if (Object.hasOwn(visible, 'lastCancelError')) {
    const message = publicErrorMessage(visible.lastCancelError);
    if (message === null) delete visible.lastCancelError;
    else visible.lastCancelError = typeof visible.lastCancelError === 'string' ? message : { message };
  }
  if (projection === 'detail' && validProgressProbe(job.progressProbe)) visible.progressProbe = { ...job.progressProbe, rejected: { ...job.progressProbe.rejected } };
  // The Resumability Indicator is derived at projection time from the exact
  // durable record, the viewing turn's permission mode, and binding-currency
  // evidence — never persisted — and never carries the session ID.
  const resumable = resumableJobIndicator(job, viewingPermissionMode, bindingCurrent);
  if (projection === 'detail' && resumable !== null) visible.resumable = resumable;
  return { ...visible, owned: true, owner: 'same-owner' };
}
/** @param {any} job */
function publicReservedJob(job) { const visible = { ...job }; delete visible.rescueMigrationRollback; delete visible.rescueContinuationOrigin; delete visible.rescueExecutionClaim; delete visible.rescueExecutionReservation; delete visible.rescueReservationKind; delete visible.rescueJobSpecCommitment; delete visible.rescueLegacyJobSpecProof; return visible; }
/** @param {any} job @param {string} [viewingPermissionMode] @param {boolean} [bindingCurrent] */
function terminalResultJob(job, viewingPermissionMode, bindingCurrent) {
  const visible = {
    id: job.id,
    command: job.command,
    status: job.status,
    ...copyOptionalStringFields(job, ['phase', 'createdAt', 'startedAt', 'finishedAt', 'lastActivityAt']),
    owned: true,
    owner: 'same-owner',
  };
  const message = publicErrorMessage(job.error);
  const resumable = resumableJobIndicator(job, viewingPermissionMode, bindingCurrent);
  const terminal = {
    ...visible,
    ...(resumable === null ? {} : { resumable }),
    ...(typeof job.stopCause === 'string' ? { stopCause: job.stopCause } : {}),
  };
  return message ? { ...terminal, error: { message } } : terminal;
}
/** @param {Record<string,any>} source @param {string[]} fields */
function copyOptionalStringFields(source, fields) {
  const result = /** @type {Record<string,string>} */ ({});
  for (const field of fields) if (typeof source[field] === 'string') result[field] = source[field];
  return result;
}
/** @param {Record<string,any>} source @param {string[]} fields */
function copyOptionalFields(source, fields) {
  const result = /** @type {Record<string,any>} */ ({});
  for (const field of fields) if (Object.hasOwn(source, field)) result[field] = source[field];
  return result;
}
/** @param {any} input */
function normalizeSpec(input) {
  const allowed = ['command', 'scope', 'base', 'focus', 'task', 'model', 'effort', 'resumeSessionId', 'candidateJobId',
    'migrationParentSessionId', 'migrationChildAgentId', 'migrationOperationId', 'migrationPriorCurrentJobId', 'migrationPriorUpdatedAt', 'migrationPriorClosedAt', 'migrationPriorVersion'];
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !allowed.includes(key)) || typeof input.command !== 'string') throw new PluginError('JOB_SPEC_INVALID', 'Job specification is invalid.', { category: 'validation', remedy: 'Reserve a new background job.' });
  /** @type {Record<string,string>} */ const output = {};
  for (const key of allowed) if (input[key] !== undefined) { if (typeof input[key] !== 'string') throw new PluginError('JOB_SPEC_INVALID', 'Job specification is invalid.', { category: 'validation', remedy: 'Reserve a new background job.' }); output[key] = input[key]; }
  return output;
}
/** @param {Record<string,string>} spec @param {any} job */
function migrationRollbackFromSpec(spec, job) {
  return legacyRescueMigrationRollbackFromSpec(spec, job,
    () => new PluginError('JOB_SPEC_INVALID', 'Job specification is invalid.', { category: 'validation', remedy: 'Reserve a new background job.' }));
}
/** Prefer the state-validated queued marker; old specs remain readable only for in-flight upgrade compatibility. @param {any} store @param {string} workspace @param {Record<string,string>} spec @param {any} job @param {string|undefined} [legacySpecDigest] */
async function migrationRollbackForExecution(store, workspace, spec, job, legacySpecDigest) {
  const legacy = migrationRollbackFromSpec(spec, job);
  const rollback = await resolveQueuedRescueMigrationRollback({ store, workspace, job, mode: 'execution',
    invalid: () => new PluginError('JOB_SPEC_INVALID', 'Job specification is invalid.', { category: 'validation', remedy: 'Reserve a new background job.' }) }, legacy,
  legacy === undefined ? undefined : legacySpecDigest);
  return { rollback, markerless: legacy !== undefined };
}
/** Historical v1 continuations must retain one exact v1/v2 child binding; they cannot degrade to unbound. @param {Record<string,string>} spec */
function legacyClasslessProof(spec) {
  const hasResume = spec.resumeSessionId !== undefined; const hasCandidate = spec.candidateJobId !== undefined;
  if (hasResume !== hasCandidate) throw new PluginError('JOB_SPEC_INVALID', 'Job specification is invalid.', {
    category: 'validation', remedy: 'Reserve a new background job.',
  });
  return hasResume ? 'classless-owner-v1-bound' : 'classless-owner-v1';
}
/** @param {any} spec */
function digestSpec(spec) { return createHash('sha256').update(JSON.stringify(spec, Object.keys(spec).sort())).digest('hex'); }
/** @param {any} store @param {string} workspace @param {string} ownerSessionId @param {Record<string,string>} spec */
/**
 * Revalidate the exact resume candidate immediately before the session/resume
 * RPC. A cancelled candidate passes only through the full durable predicate —
 * state.mjs's resumableHostOwnedCancellation (Host-owned trio plus accepted
 * session), its confirmed durable stop cause, the caller turn's permission
 * mode equaling the binding snapshot, and the active binding partition still
 * anchoring that exact job — so historical closed/cancel records, superseded
 * winners, and permission changes stay rejected exactly as before.
 * @param {any} store @param {string} workspace @param {string} ownerSessionId @param {{resumeSessionId?:string,candidateJobId?:string}} spec @param {string} [permissionMode] The reserving caller turn's permission mode; required for a cancelled candidate, whose binding snapshot it must equal. Absent on the worker-side revalidation, where the parent's selection already enforced it.
 */
async function validateResumeCandidate(store, workspace, ownerSessionId, spec, permissionMode = undefined) {
  if (!spec.resumeSessionId) return;
  const candidate = await store.readJob(workspace, spec.candidateJobId);
  const permissionEligible = permissionMode === undefined || candidate.permissionSnapshot?.permissionMode === permissionMode;
  const eligible = permissionEligible && (['running', 'succeeded', 'failed'].includes(candidate.status)
    || (candidate.status === 'cancelled' && resumableHostOwnedCancellation(candidate) && STOP_CAUSES.has(candidate.stopCause)));
  if (candidate.ownerSessionId !== ownerSessionId || candidate.command !== 'rescue' || candidate.zcodeSessionId !== spec.resumeSessionId || !eligible) throw new PluginError('RESUME_CANDIDATE_INVALID', 'The bound rescue candidate is no longer eligible.', { category: 'authorization', remedy: 'Reserve a fresh rescue job.' });
}

/** @param {number} [fd] @param {{maxBytes?:number,timeoutMs?:number,signal?:AbortSignal,createStream?:(fd:number)=>any}} [options] */
export function readInternalEnvelope(fd = 3, options = {}) {
  const maxBytes = options.maxBytes ?? 64 * 1024; const timeoutMs = options.timeoutMs ?? 5_000;
  if (!Number.isSafeInteger(fd) || fd < 3 || !Number.isSafeInteger(maxBytes) || maxBytes <= 0 || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw authorizationInputError();
  options.signal?.throwIfAborted();
  return new Promise((resolvePromise, reject) => {
    let stream;
    try { stream = options.createStream?.(fd) ?? new Socket({ fd, readable: true, writable: false }); }
    catch { reject(authorizationInputError()); return; }
    let data = ''; let bytes = 0; let settled = false; let closed = false; let cleaned = false;
    /** @type {{resolve:true,value:any}|{resolve:false,value:unknown}|null} */
    let outcome = null;
    /** @type {NodeJS.Timeout|undefined} */ let timer;
    let removeAbortListener = () => {};
    const cleanup = () => { if (cleaned) return; cleaned = true; if (timer) clearTimeout(timer); removeAbortListener(); };
    const settleAfterClose = () => {
      if (settled || !closed || !outcome) return;
      settled = true; cleanup();
      if (outcome.resolve) resolvePromise(outcome.value); else reject(outcome.value);
    };
    /** @param {boolean} resolve @param {unknown} value */
    const finish = (resolve, value) => {
      if (outcome) return;
      outcome = resolve ? { resolve: true, value } : { resolve: false, value };
      cleanup();
      if (!stream.destroyed) stream.destroy();
      settleAfterClose();
    };
    stream.once('close', () => { closed = true; if (!outcome) outcome = { resolve: false, value: authorizationInputError() }; settleAfterClose(); });
    stream.on('data', (/** @type {Buffer} */ chunk) => { if (outcome) return; bytes += chunk.length; if (bytes > maxBytes) finish(false, authorizationInputError()); else data += chunk.toString('utf8'); });
    stream.once('error', () => finish(false, authorizationInputError()));
    stream.once('end', () => { try { finish(true, JSON.parse(data)); } catch { finish(false, authorizationInputError()); } });
    timer = setTimeout(() => finish(false, authorizationInputError()), timeoutMs);
    if (options.signal) {
      const onAbort = () => finish(false, options.signal?.reason);
      options.signal.addEventListener('abort', onAbort, { once: true });
      removeAbortListener = () => options.signal?.removeEventListener('abort', onAbort);
      if (options.signal.aborted) onAbort();
    }
  });
}
/** @param {unknown} value @param {number} [fd] @param {{maxBytes?:number,timeoutMs?:number,write?:(fd:number,buffer:Buffer,offset:number,length:number,position:null,callback:(error:NodeJS.ErrnoException|null,bytesWritten:number)=>void)=>void|{cancel?:()=>void},close?:(fd:number,callback:(error?:NodeJS.ErrnoException|null)=>void)=>void}} [options] */
export function writeInternalResponse(value, fd = 4, options = {}) {
  const maxBytes = options.maxBytes ?? 1024 * 1024; const timeoutMs = options.timeoutMs ?? 1_000;
  if (!Number.isSafeInteger(fd) || fd < 3 || !Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > 1024 * 1024 || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) return Promise.reject(new PluginError('INTERNAL_RESPONSE_OPTIONS_INVALID', 'Internal response writer options are invalid.', { category: 'validation', remedy: 'Use a protected descriptor, a limit up to 1 MiB, and a positive deadline.' }));
  const data = Buffer.from(`${JSON.stringify(value)}\n`);
  if (data.length > maxBytes) return Promise.reject(new PluginError('INTERNAL_RESPONSE_TOO_LARGE', 'Internal response exceeded its limit.', { category: 'runtime', remedy: 'Inspect the job through status/result.' }));
  /** @type {import('node:net').Socket|null} */
  let socket = null;
  const write = options.write ?? ((_fd, buffer, offset, length, _position, callback) => {
    if (!socket) { socket = new Socket({ fd, readable: false, writable: true }); socket.on('error', () => {}); }
    socket.write(buffer.subarray(offset, offset + length), (error) => callback(error ? /** @type {NodeJS.ErrnoException} */ (error) : null, error ? 0 : length));
    return { cancel: () => socket?.destroy() };
  });
  const close = options.close ?? ((targetFd, callback) => {
    if (socket) { socket.destroy(); callback(); return; }
    try { closeFdSync(targetFd); callback(); } catch (error) { callback(/** @type {NodeJS.ErrnoException} */ (error)); }
  });
  return new Promise((resolvePromise, reject) => {
    let offset = 0; let settled = false; let closing = false;
    /** @type {(()=>void)|null} */
    let cancelPending = null;
    /** @param {unknown} error */
    const dispose = (error) => {
      if (!socket || socket.destroyed) return;
      if (error) socket.destroy(); else socket.unref();
    };
    /** @param {unknown} [error] */
    const finish = (error) => { if (settled) return; settled = true; clearTimeout(timer); dispose(error); if (error) reject(error); else resolvePromise(undefined); };
    /** @param {unknown} cause @param {string} [code] */
    const failure = (cause, code = 'INTERNAL_RESPONSE_WRITE_FAILED') => new PluginError(code, 'Could not deliver the protected internal response.', { category: code.endsWith('TIMEOUT') ? 'timeout' : 'runtime', remedy: 'Retry the command through its installed skill.', cause });
    const timer = setTimeout(() => {
      if (settled || closing) return; closing = true;
      const cancel = cancelPending; cancelPending = null;
      try { cancel?.(); } catch { /* best effort abort */ }
      try { close(fd, () => {}); } catch { /* best effort abort */ }
      finish(failure(new Error('Internal response write timed out.'), 'INTERNAL_RESPONSE_WRITE_TIMEOUT'));
    }, timeoutMs);
    const next = () => {
      if (settled) return;
      let completed = false;
      /** @type {(()=>void)|null} */
      let cancel = null;
      const callback = (/** @type {NodeJS.ErrnoException|null} */ error, /** @type {number} */ bytesWritten) => {
        completed = true;
        if (cancelPending === cancel) cancelPending = null;
        if (settled) return;
        if (error) return finish(failure(error));
        if (!Number.isSafeInteger(bytesWritten) || bytesWritten <= 0) return finish(failure(new Error('Internal response writer made no progress.')));
        offset += bytesWritten;
        if (offset >= data.length) finish(); else queueMicrotask(next);
      };
      const operation = write(fd, data, offset, data.length - offset, null, callback);
      cancel = typeof operation?.cancel === 'function' ? operation.cancel : null;
      if (!completed) cancelPending = cancel;
    };
    next();
  });
}

/** @param {any} output @param {unknown} error */
export async function failBackgroundDelivery(output, error) {
  const record = output && backgroundBindings.get(output); if (!record) return;
  backgroundBindings.delete(output);
  await record.identity.revokeExecutionCapability(record.capability, record.binding).catch(() => {});
  await failQueuedJob(record.store, record.binding.workspace, record.binding.jobId, error);
}

/** @param {any} store @param {string} workspace @param {string} jobId @param {unknown} error */
async function failQueuedJob(store, workspace, jobId, error) {
  await store.finishJob(workspace, jobId, ['queued'], 'failed', { error: { message: error instanceof Error ? error.message.slice(0, 2048) : 'Background preparation failed' }, exitCode: 1 });
}

/** Write the completion notice to stdout, resolving whether the flush was confirmed. @param {string} chunk */
function writeNoticeToStdout(chunk) {
  return new Promise((resolve) => {
    const onError = () => { process.stdout.removeListener('error', onError); resolve(false); };
    process.stdout.once('error', onError);
    process.stdout.write(chunk, (writeError) => { process.stdout.removeListener('error', onError); resolve(!writeError); });
  });
}

/**
 * Deliver the ONE Host completion notice for a terminal background job
 * (design 308-317): win the ownership claim, verify the durable winner is
 * published (the terminal StateStore record, plus the stored result artifact
 * for a succeeded run), emit the bounded notice, and acknowledge the claim
 * only after the flush is CONFIRMED. A lost race, a missing durable winner,
 * or a failed live delivery releases the claim so the job stays unread for
 * the next UserPromptSubmit — never duplicated, never suppressed.
 * @param {any} output @param {string} rendered @param {{readJob?:(workspace:string, jobId:string)=>Promise<any>, write?:(chunk:string)=>Promise<boolean>}} [dependencies]
 */
export async function deliverCompletionNotice(output, rendered, dependencies = {}) {
  if (output?.type !== 'background-terminal' || !output.job?.id || !output.noticeTarget) return false;
  const { dataRoot, workspace, sessionId } = output.noticeTarget;
  const won = await claimNotificationForJob(dataRoot, workspace, sessionId, output.job.id).catch(() => false);
  // Only the process that WON the claim for THIS job delivers the notice; a
  // losing racer stays silent because the winner owns the delivery.
  if (!won) return false;
  const release = () => releaseNotifications(dataRoot, workspace, sessionId, [output.job.id]).catch(() => { /* the claim stays; delivery retried next prompt */ });
  // The notice may only be emitted after BOTH the result artifact write and
  // the terminal StateStore publication: a missing or mismatched durable
  // winner releases the claim and leaves the job unread.
  try {
    const durable = await (dependencies.readJob ?? createStateStore({ dataRoot }).readJob)(workspace, output.job.id);
    const winnerPublished = durable !== null && durable.status === output.job.status
      && (durable.status !== 'succeeded' || typeof durable.resultArtifact === 'string');
    if (!winnerPublished) { await release(); return false; }
  } catch { await release(); return false; }
  let delivered;
  try { delivered = await (dependencies.write ?? writeNoticeToStdout)(rendered); }
  catch (error) { await release(); throw error; }
  if (!delivered) { await release(); return false; }
  try { await finalizeNotifications(dataRoot, workspace, sessionId, [output.job.id]); }
  catch (/** @type {any} */ markerError) { process.stderr.write(`ZCode completion notice finalization deferred: ${markerError?.code ?? 'UNKNOWN'}\n`); }
  return true;
}

export async function runCompanionCli(argv = process.argv.slice(2)) {
  /** @type {any} */ let output; const entry = argv[0]; const setup = entry === 'setup'; const roleStatus = entry === 'role-status'; const direct = ['prepare', 'invoke-prepared', 'invoke', 'invoke-choice', 'invoke-status'].includes(entry); const worker = process.env.ZCODE_BACKGROUND_WORKER === '1';
  const boundStatusDirect = argv.length === 2 && entry === 'invoke-status' && argv[1] === 'rescue';
  const rescueDirect = direct && argv[1] === 'rescue';
  const signalController = !setup && !worker ? createForegroundSignalController({ process }) : null;
  try {
    const authorization = setup || roleStatus || direct ? undefined : await readInternalEnvelope(3, { signal: signalController?.signal });
    const foregroundProgress = worker ? {} : {
      ...(entry === 'prepare' ? { input: process.stdin, preparationTransport: { writeReady: (/** @type {string} */ line) => process.stdout.write(line) } } : {}),
      progressWriter: (/** @type {string} */ line) => process.stderr.write(line),
      ...(rescueDirect ? { progressRelayWriter: (/** @type {{sequence:number,phase:string,code:string,observedAt:string}} */ record) => process.stderr.write(serializeRescueProgressRelay(record)) } : {}),
      progressDependencies: { now: () => new Date().toISOString(), setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval },
      ...(signalController ? { signal: signalController.signal } : {}),
    };
    output = direct ? await runDirectInvocation(argv, foregroundProgress) : await runCompanion(argv, { authorization, ...foregroundProgress, ...(worker ? { startupAck: acknowledgeBackgroundStartup } : {}) });
    if (!setup && !roleStatus && !direct && !worker) await writeInternalResponse(output);
    if (!worker) {
      const rendered = renderOutput(output);
      if (/** @type {any} */ (output)?.type === 'background-terminal' && /** @type {any} */ (output)?.job?.id && /** @type {any} */ (output)?.noticeTarget) {
        // OWNERSHIP-AWARE single-notice delivery (design 308-317): the durable
        // winner is already published by the completion path above, the claim
        // decides single ownership, and the acknowledgement happens only after
        // the notice is CONFIRMED flushed to stdout.
        await deliverCompletionNotice(output, rendered);
      } else {
        process.stdout.write(rendered);
      }
    }
    if (output?.type === 'needs-choice') process.exitCode = 3;
  }
  catch (error) {
    if (error instanceof PluginError && error.code === 'JOB_INTERRUPTED') {
      const signal = typeof error.details.signal === 'string' ? error.details.signal : 'signal';
      process.stderr.write(`Interrupted by ${signal}.\n`);
      if (typeof error.details.exitCode === 'number') process.exitCode = error.details.exitCode;
      return;
    }
    if (output?.type === 'background') await failBackgroundDelivery(output, error); const envelope = errorEnvelope(error); const protectedOutput = !['setup', 'role-status', 'prepare', 'invoke-prepared', 'invoke', 'invoke-choice', 'invoke-status'].includes(entry) && process.env.ZCODE_BACKGROUND_WORKER !== '1'; if (protectedOutput) try { await writeInternalResponse(envelope); } catch { /* no trusted response channel */ } if (process.env.ZCODE_BACKGROUND_WORKER !== '1') process.stdout.write(renderOutput(envelope, { json: true })); if (process.env.ZCODE_DEBUG === '1' && !boundStatusDirect) process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`); process.exitCode = error instanceof PluginError && error.category === 'validation' ? 2 : 1;
  }
  finally { signalController?.cleanup(); }
}

if (process.argv[1] && sameEntryPath(fileURLToPath(import.meta.url), resolve(process.argv[1]))) await runCompanionCli();

/** Return only a lexical executable path whose real target is an owned runtime entry. */
function invocationEntryPath() {
  if (typeof process.argv[1] !== 'string' || !process.argv[1]) return undefined;
  const invoked = resolve(process.argv[1]);
  for (const owned of [activeCompanionPath, activeRescueLauncherPath]) {
    if (invoked === resolve(owned)) return undefined;
    if (sameEntryPath(owned, invoked)) return invoked;
  }
  return undefined;
}

/** Treat marketplace symlink entrypoints as the installed companion itself. @param {string} left @param {string} right */
function sameEntryPath(left, right) {
  try { return realpathSync(left) === realpathSync(right); }
  catch { return left === right; }
}

/** @param {unknown} error @param {'marketplace'|'source'} provenance */
function sourceSetupSessionError(error, provenance) {
  if (provenance !== 'source' || !(error instanceof PluginError) || error.code !== 'SETUP_SESSION_UNPROVEN' || error.details.activeTurnCount !== 0) return error;
  return new PluginError(error.code, error.message, { category: error.category, remedy: SOURCE_SESSION_REMEDY, details: error.details, cause: error });
}

/** @param {unknown} error @param {'marketplace'|'source'} provenance */
function sourceSetupRecordedSessionError(error, provenance) {
  if (provenance !== 'source' || !missingRecordedSessionStart(error)) return error;
  return new PluginError(/** @type {any} */ (error).code, /** @type {any} */ (error).message, {
    category: /** @type {any} */ (error).category, remedy: SOURCE_SESSION_REMEDY, cause: error,
  });
}

/** @param {unknown} error */
function sourceRoleSessionFailure(error) {
  const code = /** @type {any} */ (error)?.code;
  return ['AMBIENT_THREAD_UNAVAILABLE', 'ACTIVE_TURN_NOT_FOUND', 'ACTIVE_TURN_EXPIRED'].includes(code)
    || code === 'SETUP_SESSION_UNPROVEN' && missingRecordedSessionStart(error);
}

/** @param {{error:unknown,provenance:'marketplace'|'source',inspectionStarted:boolean}} input */
function roleFailureStatus({ error, provenance, inspectionStarted }) {
  if (!inspectionStarted && provenance === 'source' && sourceRoleSessionFailure(error)) return 'source-session-unproven';
  if (!inspectionStarted) return 'caller-unavailable';
  return 'inspection-unavailable';
}

/** @param {unknown} error */
function missingRecordedSessionStart(error) {
  const cause = /** @type {any} */ (error)?.cause;
  return /** @type {any} */ (error)?.code === 'SETUP_SESSION_UNPROVEN'
    && cause instanceof PluginError && cause.code === 'JSON_READ_FAILED'
    && /** @type {any} */ (cause.cause)?.code === 'ENOENT';
}
