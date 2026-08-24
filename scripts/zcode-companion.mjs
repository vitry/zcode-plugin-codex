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
import { createJobController, ownerIdForSession, readBoundRescueStatus, withJobCancellationLock } from './lib/job-control.mjs';
import { resolvePluginDataContext, resolvePluginDataRoot } from './lib/plugin-data.mjs';
import { publicErrorMessage } from './lib/public-text.mjs';
import { discoverZCode } from './lib/zcode-discovery.mjs';
import { createManagedZCodeClient } from './lib/zcode-client.mjs';
import { acknowledgeBackgroundStartup, startBackgroundWorker } from './lib/background-worker.mjs';
import { createInvocationStore, parseRecordedInvocation, requiresExecutionChoice } from './lib/invocation.mjs';
import { createConsumedLegacyChildAuthority, createRescuePreparationStore, readRescuePreparation, RESCUE_ENVELOPE_MAX_BYTES } from './lib/rescue-preparation.mjs';
import { rescueBindingAuthorityView } from './lib/rescue-binding.mjs';
import { planRescueActivation, validateRescueRouteDirective } from './lib/rescue-route-planner.mjs';
import { executeJob, readResultArtifact } from './lib/review.mjs';
import { reconcileOwnedJobs, scavengeWritableJobs, withWorkerLease } from './lib/recovery.mjs';
import { errorEnvelope, renderOutput } from './lib/render.mjs';
import { createForegroundSignalController } from './lib/signals.mjs';
import { serializeRescueProgressRelay } from './lib/rescue-progress-relay.mjs';
import { legacyRescueMigrationRollbackFromSpec, parseExactLegacyJobSpecRecord, resolveQueuedRescueMigrationRollback } from './lib/rescue-migration.mjs';
import { createStateStore, validProgressProbe } from './lib/state.mjs';
import { resolveWorkspaceStorage } from './lib/workspace.mjs';
import { readWorkspaceModelConfig, summarizeWorkspaceModelConfig } from './lib/workspace-config.mjs';
import { executeTransfer, resolveTransferSource, TRANSFER_WIRE_LIMITS } from './lib/transfer.mjs';
import { reconcileBrokerOwnership } from './zcode-broker.mjs';
import { resolveRecordedSessionStart, resolveRoutedForwardingExecutor } from '../hooks/lib/hook-state.mjs';

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

/** @param {string[]} argv @param {{cwd?:string,env?:NodeJS.ProcessEnv,authorization?:Record<string,unknown>,dependencies?:any,caller?:any,executor?:any,authority?:any,legacyActivation?:boolean,rescueRoute?:any,startupAck?:()=>Promise<void>,originalPrompt?:string,autoLaunchBackground?:boolean,progressWriter?:(line:string)=>void,progressRelayWriter?:(record:{sequence:number,phase:string,code:string,observedAt:string})=>void|Promise<void>,progressDependencies?:any,signal?:AbortSignal}} [runtime] */
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
  const controller = createJobController({ store, dataRoot, beforeWaitPoll: reconcile });
  await reconcile();
  if (parsed.command === 'status') {
    const modelPolicy = summarizeWorkspaceModelConfig(await readWorkspaceModelConfig({ dataRoot, workspace: cwd }));
    if (parsed.options.all) return { jobs: (await store.listJobs(cwd)).map((/** @type {any} */ job) => publicJob(job, caller.sessionId, 'list')), modelPolicy };
    let job = await controller.selectOwned(cwd, caller.sessionId, parsed.positionals[0]);
    if (parsed.options.wait) job = await controller.wait(cwd, job.id, parsed.options.timeoutMs, runtime.signal);
    return { job: publicJob(job, caller.sessionId, 'detail'), modelPolicy };
  }
  if (parsed.command === 'result') {
    const job = await controller.selectOwned(cwd, caller.sessionId, parsed.positionals[0], 'result');
    if (job.status === 'succeeded') {
      if (!job.resultArtifact) throw new PluginError('ZCODE_RESULT_MISSING', `Job ${job.id} succeeded without a stored result artifact.`, { category: 'state', remedy: `Run $zcode:status ${job.id} to inspect the completed job.`, details: { jobId: job.id, status: job.status } });
      return { job, result: await readResultArtifact({ dataRoot, workspace: cwd, artifact: job.resultArtifact }) };
    }
    if (job.status === 'failed' || job.status === 'cancelled') return { job: terminalResultJob(job) };
    throw new PluginError('JOB_RESULT_UNFINISHED', `Job ${job.id} is ${job.status}.`, { category: 'state', remedy: `Run $zcode:status ${job.id} --wait.`, details: { jobId: job.id, status: job.status } });
  }
  if (parsed.command === 'cancel') {
    const selected = await controller.selectOwned(cwd, caller.sessionId, parsed.positionals[0], 'cancel');
    if (!['running', 'cancelling'].includes(selected.status)) {
      const job = await controller.cancel(cwd, selected.id, caller.sessionId);
      if (job.command === 'rescue' && job.status === 'cancelled') await store.closeRescueBindingForCancelledJob({ workspace: cwd, parentSessionId: caller.sessionId, jobId: job.id });
      return { job };
    }
    runtime.signal?.throwIfAborted(); const launch = await discoverLaunch(env);
    const client = await createManagedZCodeClient({ dataRoot, workspace: cwd, launch, ownerId: ownerIdForSession(caller.sessionId), env, ...managedWireOptionsForJob(selected) });
    const cancelling = createJobController({ store, dataRoot, stopSession: (sessionId) => client.stopSession(sessionId) });
    try {
      const job = await cancelling.cancel(cwd, selected.id, caller.sessionId);
      if (job.command === 'rescue' && job.status === 'cancelled') await store.closeRescueBindingForCancelledJob({ workspace: cwd, parentSessionId: caller.sessionId, jobId: job.id });
      return { job };
    }
    finally { await client.close().catch(() => {}); }
  }
  return startPublic({ parsed, caller, cwd, env, dataRoot, identity, store, controller, executor: runtime.executor, authority: runtime.authority, legacyActivation: runtime.legacyActivation, rescueRoute: runtime.rescueRoute, dependencies: runtime.dependencies, originalPrompt: runtime.originalPrompt, autoLaunchBackground: runtime.autoLaunchBackground, progressWriter: runtime.progressWriter, progressRelayWriter: runtime.progressRelayWriter, progressDependencies: runtime.progressDependencies, signal: runtime.signal });
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
    const execution = await resolvePreparedExecutionContext(dataRoot, cwd, ambientThreadId);
    let executor = execution.executor;
    let caller;
    /** @type {any} */
    let host;
    if (executor) {
      caller = await identity.resolveActiveTurn({ sessionId: executor.parentSessionId, workspace: execution.executionWorkspace, workspaceBinding: 'execution' });
      if (executor.active) assertExecutorMatchesCaller(executor, caller);
    } else {
      host = await readLegacyAmbientChild(runtime.dependencies, ambientThreadId, env, cwd, runtime.signal);
      caller = await identity.resolveActiveTurn({ sessionId: host.parentThreadId, workspace: cwd, workspaceBinding: 'execution' });
      validateLegacyAmbientChild(host, caller, ambientThreadId);
    }
    const preparations = createRescuePreparationStore({ dataRoot });
    let prepared;
    let recoveredRescueRoute;
    try { prepared = await preparations.consume({ ...caller, executorAgentId: ambientThreadId }); }
    catch (error) {
      if (!(error instanceof PluginError) || error.code !== 'RESCUE_PREPARATION_MISMATCH') throw error;
      host ??= sanitizeCodexThreadSpawnChild(await (runtime.dependencies?.readCodexThreadSpawnChild ?? readCodexThreadSpawnChild)(
        ambientThreadId, executor.parentSessionId, codexAppServerOptions(env, executor.originWorkspace, runtime.signal),
      ), executor.parentSessionId, executor.agentId);
      let activationProof = executor ? preparedActivationProof(host, executor) : null;
      try {
        if (activationProof) prepared = await preparations.consume({ ...caller, executorAgentId: ambientThreadId, activationProof });
        else throw error;
      } catch (proofError) {
        if (!(proofError instanceof PluginError) || proofError.code !== 'RESCUE_PREPARATION_MISMATCH') throw proofError;
        if (executor?.active) {
          activationProof = { kind: 'reactivate', agentPathDigest: createHash('sha256').update(host.agentPath).digest('hex') };
          try { prepared = await preparations.consume({ ...caller, executorAgentId: ambientThreadId, activationProof }); }
          catch (residentError) {
            if (!(residentError instanceof PluginError) || residentError.code !== 'RESCUE_PREPARATION_MISMATCH') throw residentError;
          }
        }
        if (!prepared) {
          const originalExecutor = executor;
          const recovered = await legacyActivationContext({ dataRoot, caller, host });
          activationProof = recovered.activationProof;
          if (recovered.executor) executor = recovered.executor;
          recoveredRescueRoute = recovered.rescueRoute;
          prepared = await preparations.consume({ ...caller, executorAgentId: ambientThreadId, activationProof,
            ...(originalExecutor && ['legacy-adopt', 'legacy-bound'].includes(activationProof.kind)
              ? { beforeLegacyConsume: () => validateLegacyConvergedChild(host, originalExecutor, caller) } : {}) });
        }
      }
    }
    if (['legacy-adopt', 'legacy-bound'].includes(prepared.activation?.kind) && executor) validateLegacyConvergedChild(host, executor, caller);
    if (executor && host) {
      validateExecutorHostIdentity(host, executor);
      if (prepared.activation && prepared.activation.kind !== 'spawn'
        && prepared.activation.agentPathDigest !== createHash('sha256').update(host.agentPath).digest('hex')) {
        throw new PluginError('RESCUE_PREPARATION_MISMATCH', 'The Rescue preparation does not match this child.', { category: 'authorization', remedy: 'Return to the parent turn and prepare Rescue again.' });
      }
      executor = { ...executor, agentPath: host.agentPath };
    }
    if (prepared.requiredExecutorAgentId !== null && executor?.active
      && !['legacy-adopt', 'legacy-bound'].includes(prepared.activation?.kind)) {
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
    const reactivatedFresh = prepared.generation === 1
      && prepared.activation?.kind === 'reactivate'
      && prepared.envelope.options.resume === 'fresh';
    let rescueRoute = recoveredRescueRoute;
    let authority;
    if (['legacy-adopt', 'legacy-bound'].includes(prepared.activation?.kind) && !executor) {
      authority = createConsumedLegacyChildAuthority(prepared, {
        authorizingParentGenerationId: caller.generationId,
        originWorkspace: caller.originWorkspace,
        executionWorkspace: caller.workspace,
      });
    }
    if ((!executor || !executor.active) && !reactivatedFresh && prepared.activation?.kind !== 'legacy-adopt') {
      const state = createStateStore({ dataRoot });
      let lookup = executor ? bindingLookup(executor, caller.workspace) : legacyBindingLookup(host, caller);
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
          parentSessionId: caller.sessionId, executorAgentId: executor?.agentId ?? host.id,
          childAgentType: executor?.agentType ?? host.agentRole, originWorkspace: host.cwd,
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
    const output = await runCompanion(preparedArgv, { cwd: caller.workspace, env, caller, executor, authority,
      legacyActivation: ['legacy-adopt', 'legacy-bound'].includes(prepared.activation?.kind), rescueRoute,
      originalPrompt: undefined, autoLaunchBackground: true, dependencies: runtime.dependencies, progressWriter: runtime.progressWriter, progressRelayWriter: runtime.progressRelayWriter, progressDependencies: runtime.progressDependencies, signal: runtime.signal });
    if (output?.type === 'needs-choice') await saveRescuePendingChoice({ dataRoot, caller, cwd: caller.workspace, source: prepared.envelope.source, executor, authority, argv: preparedArgv, output });
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
  let sessionId = ambientThreadId; let executorAgentId; let executor; let authority; let legacyChoiceFallback = false; let executionWorkspace = cwd;
  if (command === 'rescue') {
    const resolved = entry === 'invoke-choice'
      ? await resolvePreparedExecutionContext(dataRoot, cwd, ambientThreadId)
      : await resolveRoutedForwardingExecutor(dataRoot, cwd, ambientThreadId);
    if (resolved.executor) {
      executor = resolved.executor; executionWorkspace = resolved.executionWorkspace; sessionId = executor.parentSessionId; executorAgentId = executor.agentId;
    } else {
      const host = await readLegacyAmbientChild(runtime.dependencies, ambientThreadId, env, cwd, runtime.signal);
      const legacyCaller = await identity.resolveActiveTurn({ sessionId: host.parentThreadId, workspace: cwd, workspaceBinding: 'execution' });
      validateLegacyAmbientChild(host, legacyCaller, ambientThreadId);
      executionWorkspace = legacyCaller.workspace; sessionId = legacyCaller.sessionId; executorAgentId = host.id; legacyChoiceFallback = true;
    }
  }
  const caller = await identity.resolveActiveTurn({ sessionId, workspace: executionWorkspace, ...(command === 'rescue' ? { workspaceBinding: 'execution' } : {}) }); const invocations = createInvocationStore({ dataRoot });
  if (command === 'rescue' && (entry === 'invoke' || entry === 'invoke-choice' && executor?.active)) assertExecutorMatchesCaller(executor, caller);
  /** @type {any} */ let invocation; let executionCaller = caller;
  if (entry === 'invoke-choice') {
    invocation = await invocations.consumePending({ sessionId, workspace: command === 'rescue' ? caller.workspace : cwd, command, choice,
      ...(executorAgentId === undefined ? {} : { executorAgentId }), ...(command === 'rescue' ? {
        turnId: caller.turnId, permissionMode: caller.permissionMode, parentGenerationId: caller.generationId,
        originWorkspace: caller.originWorkspace, executionWorkspace: caller.workspace, ...(legacyChoiceFallback ? { requireLegacyAuthority: true } : {}),
      } : {}) }); executionCaller = invocation.caller; authority = invocation.authority;
    if (command === 'rescue' && invocation.route?.routeKind !== 'bound' && !authority) {
      const refreshed = await resolveRoutedForwardingExecutor(dataRoot, cwd, ambientThreadId, { continuation: true });
      assertSameRoutedExecutionContext({ executor, executionWorkspace }, refreshed); executor = refreshed.executor;
    }
  }
  else {
    if (choice !== undefined) throw new PluginError('INVOCATION_COMMAND_INVALID', 'The direct companion command is invalid.', { category: 'validation', remedy: 'Use the constant command documented by the installed skill.' });
    invocation = parseRecordedInvocation(command, caller.prompt);
    if (requiresExecutionChoice(command, invocation.argv)) {
      await invocations.savePending({ sessionId, turnId: caller.turnId, workspace: command === 'rescue' ? caller.workspace : cwd, permissionMode: caller.permissionMode, command, spec: { argv: invocation.argv }, ...(command === 'rescue' ? { source: invocation.source ?? 'explicit' } : {}), ...(executorAgentId === undefined ? {} : { executorAgentId }) });
      return { type: 'needs-choice', choices: ['wait', 'background'] };
    }
  }
  const output = await runCompanion(invocation.argv, { cwd: command === 'rescue' ? executionCaller.workspace : cwd, env, caller: executionCaller, executor, authority,
    legacyActivation: Boolean(authority), rescueRoute: invocation.route, originalPrompt: invocation.implicitText, autoLaunchBackground: true, dependencies: runtime.dependencies,
    progressWriter: runtime.progressWriter, progressRelayWriter: runtime.progressRelayWriter, progressDependencies: runtime.progressDependencies, signal: runtime.signal });
  if (output?.type === 'needs-choice') {
    if (command === 'rescue') await saveRescuePendingChoice({ dataRoot, caller: executionCaller, cwd: executionCaller.workspace, source: invocation.source ?? 'explicit', executor, authority, argv: invocation.argv, output });
    else await invocations.savePending({ sessionId, turnId: executionCaller.turnId, workspace: cwd, permissionMode: executionCaller.permissionMode, command, spec: { argv: invocation.argv } });
  }
  return output;
}

/** @param {string} dataRoot @param {string} ambientWorkspace @param {string} agentId */
async function resolvePreparedExecutionContext(dataRoot, ambientWorkspace, agentId) {
  try { return await resolveRoutedForwardingExecutor(dataRoot, ambientWorkspace, agentId); }
  catch (error) {
    if (!(error instanceof PluginError) || !['EXECUTOR_IDENTITY_NOT_FOUND', 'EXECUTOR_IDENTITY_EXPIRED', 'EXECUTOR_STATE_MISMATCH'].includes(error.code)) throw error;
    try { return await resolveRoutedForwardingExecutor(dataRoot, ambientWorkspace, agentId, { continuation: true, durableProvenance: true }); }
    catch (continuationError) {
      if (!(continuationError instanceof PluginError) || continuationError.code !== 'EXECUTOR_IDENTITY_NOT_FOUND') throw continuationError;
      return { executor: null, executionWorkspace: ambientWorkspace };
    }
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
    if (!exactPlainObject(activation, ['agentPathDigest', 'executorAgentId', 'kind'])
      || !safeCompanionIdentifier(activation.executorAgentId) || activation.agentPathDigest !== digest) throw rescueRouteInvalid();
    return { activation: { kind: 'reactivate', executorAgentId: activation.executorAgentId, agentPathDigest: activation.agentPathDigest }, directive };
  }
  const keys = activation?.kind === 'legacy-bound'
    ? ['agentPathDigest', 'bindingKey', 'childThreadId', 'kind']
    : ['agentPathDigest', 'childThreadId', 'kind'];
  if (!['legacy-adopt', 'legacy-bound'].includes(activation?.kind) || !exactPlainObject(activation, keys)
    || !safeCompanionIdentifier(activation.childThreadId) || activation.agentPathDigest !== digest
    || activation.kind === 'legacy-bound' && !/^[a-f0-9]{64}$/u.test(activation.bindingKey)) throw rescueRouteInvalid();
  return { activation: { kind: activation.kind, childThreadId: activation.childThreadId, agentPathDigest: activation.agentPathDigest,
    ...(activation.kind === 'legacy-bound' ? { bindingKey: activation.bindingKey } : {}) }, directive };
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

/** @param {any} dependencies @param {string} childId @param {NodeJS.ProcessEnv} env @param {string} cwd @param {AbortSignal|undefined} signal */
async function readLegacyAmbientChild(dependencies, childId, env, cwd, signal) {
  const read = dependencies?.readCodexThreadSpawnChildIdentity ?? readCodexThreadSpawnChildIdentity;
  return sanitizeCodexThreadSpawnChild(await read(childId, codexAppServerOptions(env, cwd, signal)), undefined, childId);
}

/** @param {any} host @param {any} caller @param {string} childId */
function validateLegacyAmbientChild(host, caller, childId) {
  const managed = /^\/root\/zcode_rescue_task(?:_(?:[2-9]|[1-9][0-9]{1,3}))?$/u.test(host.agentPath);
  if (host.id !== childId || host.parentThreadId !== caller.sessionId || host.agentRole !== 'zcode-rescue'
    || host.status.type !== 'active' || !managed || host.cwd !== caller.originWorkspace
    || caller.executionWorkspace !== caller.workspace || !/^[a-f0-9]{64}$/u.test(caller.generationId)) {
    throw new PluginError('EXECUTOR_IDENTITY_INVALID', 'The persisted Rescue child identity is not eligible for legacy adoption.', { category: 'authorization', remedy: 'Return to the active parent turn and prepare Rescue again.' });
  }
}

/** @param {{dataRoot:string,caller:any,host:any}} input */
async function legacyActivationContext({ dataRoot, caller, host }) {
  const agentPathDigest = createHash('sha256').update(host.agentPath).digest('hex');
  const store = createStateStore({ dataRoot });
  const lookup = legacyBindingLookup(host, caller);
  const proof = await store.readRescueBindingMigrationProof({ ...lookup, childAgentType: host.agentRole,
    originWorkspace: host.cwd, executionWorkspace: caller.workspace, agentPathDigest, agentPath: host.agentPath });
  const binding = await store.resolveRescueBindingForResume({ ...lookup,
    ...(proof.kind === 'proof' ? { migrationProof: proof.migrationProof } : {}) });
  if (binding.kind !== 'bound') return { activationProof: { kind: 'legacy-adopt', childThreadId: host.id, agentPathDigest }, executor: null, rescueRoute: undefined };
  const authority = rescueBindingAuthorityView(binding.binding);
  if (authority.kind === 'subagent-start') return {
    activationProof: { kind: 'reactivate', agentPathDigest },
    executor: { active: true, agentId: authority.childAgentId, agentType: authority.childAgentType,
      parentSessionId: binding.binding.parentSessionId, parentTurnId: authority.parentTurnId,
      parentPermissionMode: authority.parentPermissionMode, originWorkspace: host.cwd,
      workspace: caller.workspace, agentPath: host.agentPath },
    rescueRoute: { routeKind: 'bound', candidateJobId: binding.binding.anchorJobId,
      expectedOperationId: binding.binding.operationId, expectedCurrentJobId: binding.binding.currentJobId,
      ...(proof.kind === 'proof' ? { migrationProof: proof.migrationProof } : {}) },
  };
  return { activationProof: { kind: 'legacy-bound', childThreadId: host.id, agentPathDigest, bindingKey: binding.binding.key }, executor: null, rescueRoute: undefined };
}

/** @param {any} host @param {any} executor @param {any} caller */
function validateLegacyConvergedChild(host, executor, caller) {
  const managed = /^\/root\/zcode_rescue_task(?:_(?:[2-9]|[1-9][0-9]{1,3}))?$/u.test(host.agentPath);
  if (host.id !== executor.agentId || host.parentThreadId !== caller.sessionId || host.agentRole !== 'zcode-rescue'
    || !managed || host.cwd !== caller.originWorkspace || executor.parentSessionId !== caller.sessionId
    || executor.originWorkspace !== host.cwd || executor.workspace !== caller.workspace
    || executor.parentTurnId !== caller.turnId || executor.parentPermissionMode !== caller.permissionMode) {
    throw new PluginError('EXECUTOR_IDENTITY_INVALID', 'The Rescue child host identity does not match its executor provenance.', { category: 'authorization', remedy: 'Return to the parent turn and prepare Rescue again.' });
  }
}

/** @param {any} host @param {any} caller */
function legacyBindingLookup(host, caller) {
  return { workspace: caller.workspace, parentSessionId: caller.sessionId, executorAgentId: host.id };
}

/** @param {{dataRoot:string,caller:any,cwd:string,source:'explicit'|'proactive',executor:any,authority?:any,argv:string[],output:any}} input */
async function saveRescuePendingChoice({ dataRoot, caller, cwd, source, executor, authority, argv, output }) {
  const route = rescueChoiceRoutes.get(output);
  if (!route) throw new PluginError('RESCUE_CHOICE_ROUTE_INVALID', 'The private Rescue choice route is unavailable.', { category: 'authorization', remedy: 'Repeat the Rescue command.' });
  const executorAgentId = executor?.agentId ?? authority?.childAgentId;
  if (!executorAgentId) throw new PluginError('RESCUE_CHOICE_ROUTE_INVALID', 'The private Rescue choice route is unavailable.', { category: 'authorization', remedy: 'Repeat the Rescue command.' });
  await createInvocationStore({ dataRoot }).savePending({ sessionId: caller.sessionId, turnId: caller.turnId, workspace: cwd, permissionMode: caller.permissionMode,
    command: 'rescue', source, executorAgentId, spec: { argv }, ...route, ...(authority ? { legacyAuthority: authority } : {}) });
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
    if (childAuthorized) {
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
        if (context.rescueRoute?.routeKind === 'legacy' && binding) throw new PluginError('RESCUE_BINDING_STALE', 'The Rescue operation generation changed.', { category: 'state', remedy: 'Repeat the Rescue choice.' });
      }
      if (!parsed.options.resume && binding) return boundNeedsChoice(binding);
      if (!binding && parsed.options.resume !== 'fresh') candidate = context.rescueRoute?.candidateJobId ? await store.readJob(cwd, context.rescueRoute.candidateJobId) : await controller.resumeCandidate(cwd, caller.sessionId);
      if (!parsed.options.resume && candidate) return legacyNeedsChoice(candidate, childAuthorized);
    } else candidate = await controller.resumeCandidate(cwd, caller.sessionId);
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
    if (parsed.options.resume === 'fresh' || !binding && !candidate) reserved = await reservePublicRescueJob(context, () => store.reserveFreshRescueJob({ workspace: cwd, reservation, ...childProof, ...(context.rescueRoute?.routeKind === 'bound' ? { expectedOperationId: context.rescueRoute.expectedOperationId, expectedCurrentJobId: context.rescueRoute.expectedCurrentJobId, expectedAnchorJobId: context.rescueRoute.candidateJobId } : {}) }));
    else if (binding) {
      const previewMigrationProof = binding.state === 'closed' ? context.rescueRoute?.migrationProof : undefined;
      const resolved = await store.resolveRescueBindingForResume({ ...(context.legacyActivation
        ? authorityBindingLookup(context.authority ?? { childAgentId: context.executor.agentId }, caller, cwd)
        : context.executor ? bindingLookup(context.executor, cwd) : authorityBindingLookup(context.authority, caller, cwd)),
      permissionMode: caller.permissionMode, ...(previewMigrationProof ? { migrationProof: previewMigrationProof } : {}) });
      const migrationProof = previewMigrationProof;
      reserved = await reservePublicRescueJob(context, () => store.reserveBoundRescueContinuation({ workspace: cwd, reservation, ...childProof, operationId: context.rescueRoute?.expectedOperationId ?? resolved.operationId, ...(migrationProof ? { migrationProof } : {}), ...(context.rescueRoute?.expectedCurrentJobId ? { expectedCurrentJobId: context.rescueRoute.expectedCurrentJobId, expectedAnchorJobId: context.rescueRoute.candidateJobId } : {}) }));
      candidate = reserved.anchorJob;
    } else {
      reserved = await reservePublicRescueJob(context, () => store.adoptRescueCandidate({ workspace: cwd, reservation, ...childProof, candidateJobId: candidate.id })); candidate = reserved.anchorJob;
    }
    job = reserved.job;
  } else job = await reservePublicJob(context, reservation);
  if (parsed.command === 'transfer') {
    return executeTransfer({ job, workspace: job.workspace, dataRoot, store, sourceThreadId: /** @type {string} */ (transferSource), signal: context.signal, progressWriter: context.progressWriter, resolveLaunch: () => discoverLaunch(context.env),
      readThread: () => (context.dependencies?.readCodexThread ?? readCodexThread)(transferSource, codexAppServerOptions(context.env, job.workspace, context.signal)),
      createClient: (launch) => (context.dependencies?.createManagedZCodeClient ?? createManagedZCodeClient)({ dataRoot, workspace: job.workspace, launch, ownerId: ownerIdForSession(caller.sessionId), env: context.env, ...managedWireOptionsForJob(job) }),
    });
  }
  const spec = normalizeSpec({ command: parsed.command, scope: parsed.options.scope, base: parsed.options.base, focus: parsed.positionals.join(' ') || context.originalPrompt, task: parsed.positionals.join(' ') || context.originalPrompt, model: parsed.options.model, effort: parsed.options.effort, resumeSessionId: parsed.options.resume === 'resume' ? candidate?.zcodeSessionId : undefined, candidateJobId: parsed.options.resume === 'resume' ? candidate?.id : undefined });
  if (parsed.options.execution === 'background') {
    const binding = { jobId: job.id, ownerSessionId: caller.sessionId, workspace: cwd, operation: 'run-reserved-job', jobSpecFormat: 'sealed-v2' };
    let capability;
    try {
      context.signal?.throwIfAborted();
      capability = await (context.dependencies?.createExecutionCapability ?? ((/** @type {any} */ input) => identity.createExecutionCapability(input)))({ ...binding, permissionSnapshot });
      context.signal?.throwIfAborted();
      const record = sealJobSpec(job, spec, capability);
      job = await store.publishJobSpecCommitment(cwd, job.id, record.commitment);
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
/** @param {any} candidate @param {boolean} privateRoute */
function legacyNeedsChoice(candidate, privateRoute) { const output = { type: 'needs-choice', ...(privateRoute ? {} : { candidate }), choices: ['--resume', '--fresh'] }; if (privateRoute) rescueChoiceRoutes.set(output, { routeKind: 'legacy', candidateJobId: candidate.id }); return output; }

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

/** @param {any} context @param {()=>Promise<any>} reserve */
async function reservePublicRescueJob(context, reserve) {
  context.signal?.throwIfAborted();
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

/** @param {any} context @param {any} reservation */
async function reservePublicJob(context, reservation) {
  try { return await context.store.reserveJob(reservation); }
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
    return context.store.reserveJob(reservation);
  }
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
  const inspected = await identity.inspectExecutionCapability(authorization.executionCapability, capabilityExpected, capabilityReservationId);
  if (record.version === 1 && inspected.jobSpecFormat !== undefined) throw jobSpecTampered();
  if (!sameJson(inspected.permissionSnapshot, job.permissionSnapshot)) throw new PluginError('EXECUTION_SNAPSHOT_MISMATCH', 'Execution capability permission snapshot does not match the reserved job.', { category: 'authorization', remedy: 'Issue a new capability from the exact reserved job.' });
  if (job.status !== 'queued') {
    if (['cancelled', 'failed', 'succeeded'].includes(job.status)) await identity.releaseExecutionCapability(
      authorization.executionCapability, capabilityExpected, capabilityReservationId);
    throw new PluginError('RESERVED_JOB_NOT_QUEUED', `Reserved job ${jobId} is ${job.status}.`, { category: 'state', remedy: 'Generate a new execution capability only for a queued job.' });
  }
  return executeWithWorkerLease({ parsed, cwd, env, dataRoot, identity, store, job, spec, loadSpecAfterClaim,
    executionAuthorization, legacySpecDigest, legacyReservationProof, executionCapability: authorization.executionCapability,
    capabilityExpected, capabilityReservationId,
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
  await context.dependencies?.testOnlyBeforeExecutionInspection?.();
  const executionInspection = await context.store.inspectJobWorkerExecution(context.cwd, context.job.id, migrationRollback,
    context.executionAuthorization ?? (context.legacySpecDigest === undefined ? undefined : markerlessMigration
      ? { legacyProof: 'markerless-migration', specDigest: context.legacySpecDigest }
      : { legacyProof: context.legacyReservationProof }));
  if (context.executionCapability !== undefined) await context.identity.reserveExecutionCapability(
    context.executionCapability, context.capabilityExpected, context.capabilityReservationId);
  await context.dependencies?.testOnlyBeforeExecutionClaim?.();
  const workerLeaseId = randomBytes(32).toString('hex');
  return withWorkerLease({ dataRoot: context.dataRoot, workspace: context.cwd, jobId: context.job.id, workerLeaseId }, async () => {
    let job; let spec = context.spec;
    let capabilityCommitted = context.executionCapability === undefined;
    try {
      const executionAuthorization = context.executionAuthorization ?? (context.legacySpecDigest === undefined ? undefined : markerlessMigration
        ? { legacyProof: 'markerless-migration', specDigest: context.legacySpecDigest }
        : { legacyProof: context.legacyReservationProof });
      job = await context.store.claimJobWorkerForExecution(context.cwd, context.job.id,
        { childPid: process.pid, workerLeaseId }, migrationRollback,
        executionAuthorization, executionInspection);
      await context.dependencies?.testOnlyAfterStateClaimBeforeCapabilityCommit?.();
      if (context.executionCapability !== undefined) {
        await context.identity.commitExecutionCapability(context.executionCapability, context.capabilityExpected, context.capabilityReservationId);
        capabilityCommitted = true;
      }
      await context.dependencies?.testOnlyAfterExecutionClaim?.();
      if (context.loadSpecAfterClaim) spec = await context.loadSpecAfterClaim();
    } catch (error) {
      const reconciliation = await context.store.finishJobAfterExecutionClaimFailure(context.cwd, context.job.id, workerLeaseId, {
        error: { message: error instanceof Error ? error.message.slice(0, 2048) : 'Execution authorization failed' }, exitCode: 1,
      }).catch(() => undefined);
      if (!capabilityCommitted && context.executionCapability !== undefined && reconciliation?.kind === 'settled') {
        await context.identity.releaseExecutionCapability(context.executionCapability,
          context.capabilityExpected, context.capabilityReservationId).catch(() => {});
      }
      throw error;
    }
    return executeReserved({ ...context, job, spec, migrationRollback, childPid: process.pid, workerLeaseId });
  });
}

/** @param {any} context */
async function executeReserved(context) {
  const { cwd, env, dataRoot, store, job, spec } = context;
  let client; let resumeSucceeded = false;
  const migrationRollback = context.migrationRollback;
  try {
    context.signal?.throwIfAborted();
    const launch = await discoverLaunch(env, context.dependencies); const ownerId = ownerIdForSession(job.ownerSessionId);
    context.signal?.throwIfAborted();
    client = await createManagedZCodeClient({ dataRoot, workspace: cwd, launch, ownerId, env });
    const modelConfig = await readWorkspaceModelConfig({ dataRoot, workspace: cwd }); const modelRequest = spec.model ?? modelConfig.defaultModel;
    const preResolvedModel = modelRequest && (modelRequest.includes('/') || Object.hasOwn(modelConfig.models, modelRequest)) ? resolveModel(modelRequest, modelConfig.models, []) : undefined;
    const executionClient = client; client = undefined;
    return await executeJob({ job, workspace: cwd, dataRoot, store, client: executionClient, scope: spec.scope, base: spec.base, focus: spec.focus, task: spec.task, model: preResolvedModel, modelRequest: preResolvedModel ? undefined : modelRequest, modelAliases: modelConfig.models, effort: spec.effort, resumeSessionId: spec.resumeSessionId, childPid: context.childPid, workerLeaseId: context.workerLeaseId, onBoundaryPersisted: context.onBoundaryPersisted, progressWriter: context.progressWriter, progressRelayWriter: context.progressRelayWriter, progressDependencies: context.progressDependencies, signal: context.signal, onBeforeResume: async () => { await validateResumeCandidate(store, cwd, job.ownerSessionId, spec); await reconcileBrokerOwnership({ dataRoot, workspace: cwd, ownerId, ownedSessionIds: [spec.resumeSessionId] }); }, onResumeSucceeded: () => { resumeSucceeded = true; }, ...(migrationRollback ? { onResumeFailure: async (error) => {
      if (resumeSucceeded) return;
      await store.finishSessionEndedRescueContinuation(cwd, job.id, migrationRollback, 'failed', { error: { message: error instanceof Error ? error.message.slice(0, 2048) : 'ZCode resume failed' }, exitCode: 1 });
    } } : {}) });
  } catch (error) {
    await client?.close().catch(() => {});
    const current = await store.readJob(cwd, job.id).catch(() => null);
    if (migrationRollback && !resumeSucceeded && current?.status === 'queued') {
      await store.finishSessionEndedRescueContinuation(cwd, job.id, migrationRollback, 'failed', { error: { message: error instanceof Error ? error.message.slice(0, 2048) : 'ZCode resume failed' }, exitCode: 1 });
    } else if (isInterruption(error) && current?.status === 'queued') {
      if (current.workerLeaseId === context.workerLeaseId) await cancelClaimedQueuedInterruption(context).catch(() => {});
      else await createJobController({ store, dataRoot }).cancel(cwd, job.id, job.ownerSessionId).catch(() => {});
    } else if (!isInterruption(error) && current?.status === 'queued') {
      await store.finishJob(cwd, job.id, ['queued'], 'failed', { error: { message: error instanceof Error ? error.message.slice(0, 2048) : 'Execution failed' }, exitCode: 1 });
    }
    throw error;
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
    return context.store.finishJob(context.cwd, current.id, ['queued'], 'cancelled', { exitCode: null });
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
/** @param {any} job @param {string} ownerSessionId @param {'list'|'detail'} projection */
function publicJob(job, ownerSessionId, projection) {
  if (job.ownerSessionId !== ownerSessionId) {
    return {
      id: job.id,
      status: job.status,
      createdAt: job.createdAt,
      ...copyOptionalFields(job, ['startedAt', 'finishedAt', 'lastActivityAt']),
      hasOwner: true,
    };
  }
  const visible = { ...job }; delete visible.ownerSessionId; delete visible.ownerTurnId; delete visible.permissionSnapshot; delete visible.progressProbe; delete visible.rescueMigrationRollback; delete visible.rescueContinuationOrigin; delete visible.rescueExecutionClaim; delete visible.rescueReservationKind; delete visible.rescueJobSpecCommitment; delete visible.rescueLegacyJobSpecProof;
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
  return { ...visible, owned: true, owner: 'same-owner' };
}
/** @param {any} job */
function publicReservedJob(job) { const visible = { ...job }; delete visible.rescueMigrationRollback; delete visible.rescueContinuationOrigin; delete visible.rescueExecutionClaim; delete visible.rescueReservationKind; delete visible.rescueJobSpecCommitment; delete visible.rescueLegacyJobSpecProof; return visible; }
/** @param {any} job */
function terminalResultJob(job) {
  const visible = {
    id: job.id,
    command: job.command,
    status: job.status,
    ...copyOptionalStringFields(job, ['phase', 'createdAt', 'startedAt', 'finishedAt', 'lastActivityAt']),
    owned: true,
    owner: 'same-owner',
  };
  const message = publicErrorMessage(job.error);
  return message ? { ...visible, error: { message } } : visible;
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
async function validateResumeCandidate(store, workspace, ownerSessionId, spec) {
  if (!spec.resumeSessionId) return;
  const candidate = await store.readJob(workspace, spec.candidateJobId);
  if (candidate.ownerSessionId !== ownerSessionId || candidate.command !== 'rescue' || candidate.zcodeSessionId !== spec.resumeSessionId || !['running', 'succeeded', 'failed'].includes(candidate.status)) throw new PluginError('RESUME_CANDIDATE_INVALID', 'The bound rescue candidate is no longer eligible.', { category: 'authorization', remedy: 'Reserve a fresh rescue job.' });
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

export async function runCompanionCli(argv = process.argv.slice(2)) {
  let output; const entry = argv[0]; const setup = entry === 'setup'; const roleStatus = entry === 'role-status'; const direct = ['prepare', 'invoke-prepared', 'invoke', 'invoke-choice', 'invoke-status'].includes(entry); const worker = process.env.ZCODE_BACKGROUND_WORKER === '1';
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
    if (!setup && !roleStatus && !direct && !worker) await writeInternalResponse(output); if (!worker) process.stdout.write(renderOutput(output)); if (output?.type === 'needs-choice') process.exitCode = 3;
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
