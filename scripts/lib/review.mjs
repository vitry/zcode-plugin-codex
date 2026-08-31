import { constants } from 'node:fs';
import { open, rename, chmod, lstat, realpath, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

import { PluginError } from './errors.mjs';
import { resolveModel } from './args.mjs';
import { ensurePrivateDirectory, withFileLock } from './fs.mjs';
import { collectGitFacts } from './git.mjs';
import { createJobController, revalidateBoundRescueStop, withJobCancellationLock } from './job-control.mjs';
import { isBoundedPublicIdentifier } from './identifier.mjs';
import { openRuntimeJobLog } from './job-log-runtime.mjs';
import { createProgressReporter, waitForCompletionOrAbort } from './progress.mjs';
import { createDeferredConversationProgressObserver } from './conversation-progress.mjs';
import { createSessionProgressDescriber } from './session-progress.mjs';
import { awaitCurrentTurnTerminal, selectCurrentTurnAssistant } from './turn-terminal.mjs';
import { publicErrorMessage } from './public-text.mjs';
import { buildPrompt } from './prompts.mjs';
import { loadReviewOutputSchema, validateJsonSchema } from './review-schema.mjs';
import { resolveWorkspaceStorage } from './workspace.mjs';
import { isCorrelatedZCodeResponseError } from './zcode-protocol.mjs';

const READ_TOOLS = /^(read|inspect|search|list|find|glob|grep|git(?:[-_ ]?(?:status|diff|log|show))?)$/i;
const MUTATING_TOOLS = /(write|edit|patch|delete|remove|create|exec|shell|command|install|move|rename|commit|push)/i;
const OPTIONAL_PROGRESS_FENCE_MS = 250;
const SUBSCRIPTION_BASELINE_FENCE_MS = 100;
const REVIEW_OUTPUT_SCHEMA = await loadReviewOutputSchema();

/** @param {any} request @param {any} permissionSnapshot @param {string} command */
export function decidePermission(request, permissionSnapshot, command) {
  const offered = Array.isArray(request?.options) ? request.options.map((/** @type {any} */ option) => option?.response).filter(validResponse) : [];
  const allow = offered.find((/** @type {any} */ response) => response.decision === 'allow');
  const deny = offered.find((/** @type {any} */ response) => response.decision === 'deny');
  const risk = typeof request?.riskLevel === 'string' ? request.riskLevel.toLowerCase() : 'unknown';
  let permitted = false;
  if (command === 'review' || command === 'adversarial-review') permitted = risk === 'low' && READ_TOOLS.test(request?.toolName ?? '') && !MUTATING_TOOLS.test(request?.toolName ?? '');
  else if (command === 'rescue') permitted = ['low', 'medium'].includes(risk) || ['high', 'critical'].includes(risk) && permissionSnapshot?.permissionMode === 'bypassPermissions';
  if (permitted && allow) return allow;
  if (deny) return deny;
  throw new PluginError('PERMISSION_DENY_UNAVAILABLE', 'ZCode did not offer a deny response for a request that cannot be allowed.', { category: 'authorization', remedy: 'Reject the incompatible permission request and upgrade or restart ZCode.' });
}

/**
 * @param {{job:any,workspace:string,dataRoot:string,store:any,client:any,scope?:string,base?:string,focus?:string,task?:string,model?:any,modelRequest?:string,modelAliases?:Record<string,unknown>,resolveRuntimeRecoveryConfig?:(model:{providerId:string,modelId:string}|undefined)=>Promise<any>,effort?:string,resumeSessionId?:string,onBeforeResume?:(job:any)=>Promise<void>,onResumeRpcSucceeded?:()=>void,onRunningPersisted?:()=>void,onResumeFailure?:(error:unknown)=>Promise<any>,childPid?:number,workerLeaseId?:string,onBoundaryPersisted?:(job:any)=>Promise<void>,syncDirectory?:(path:string)=>Promise<void>,progressWriter?:(line:string)=>void,progressRelayWriter?:(record:{sequence:number,phase:string,code:string,observedAt:string})=>void|Promise<void>,progressDependencies?:{now?:()=>string,setInterval?:(callback:()=>void,milliseconds:number)=>any,clearInterval?:(timer:any)=>void},signal?:AbortSignal}} input
 */
export async function executeJob(input) {
  const { job, client, workspace, dataRoot } = input;
  let running = job;
  /** @type {string|undefined} */
  let sessionId;
  let sendAttempted = false; let remoteTerminalProven = false;
  let sendAdmissionUnknown = false;
  let admissionBoundaryUnpublished = false;
  let admissionTargetStale = false;
  /** @type {any} */
  let reporter;
  /** @type {any} */ let conversationObserver;
  let unsubscribeNotifications = () => {}; let unsubscribeConversation = async () => {};
  /** @type {unknown} */
  let primaryError;
  /** @type {any} */
  let output;
  let appliedFinalization = false;
  let progressCleaned = false;
  /** @type {any} */ let jobLog;
  let jobLogCleaned = false;
  /** @type {any} */ let observedBoundStop;
  let initialBoundStopGuardComplete = false;
  const cleanupJobLog = async () => {
    if (jobLogCleaned) return;
    jobLogCleaned = true;
    await jobLog?.close(Date.now() + OPTIONAL_PROGRESS_FENCE_MS);
  };
  /** @param {string|undefined} [confirmedTerminalKind] */
  const cleanupProgress = async (confirmedTerminalKind) => {
    if (progressCleaned) return;
    progressCleaned = true;
    try { reporter?.stopAccepting(); } catch { /* progress-only */ }
    try { unsubscribeNotifications(); } catch { reporter?.diagnose('conversation-unsubscribe-failed'); }
    let remoteCleanup = Promise.resolve();
    try { remoteCleanup = Promise.resolve(unsubscribeConversation()).catch(() => { reporter?.diagnose('conversation-unsubscribe-failed'); }); }
    catch { reporter?.diagnose('conversation-unsubscribe-failed'); }
    const deadline = Date.now() + OPTIONAL_PROGRESS_FENCE_MS;
    const initialDrain = Promise.resolve().then(() => reporter?.flush(deadline)).catch(() => {});
    const remoteDrain = remoteCleanup.then(() => Promise.resolve()).then(() => reporter?.flush(deadline)).catch(() => {});
    const aggregateSettled = await waitForOptionalProgress(Promise.all([initialDrain, remoteDrain]), deadline);
    if (!aggregateSettled) {
      reporter?.diagnose('progress-flush-timeout');
      const timeoutDrain = Promise.resolve().then(() => reporter?.flush(deadline)).catch(() => {});
      await waitForOptionalProgress(timeoutDrain, deadline);
    }
    if (confirmedTerminalKind) {
      try { reporter?.confirmTerminal(confirmedTerminalKind); } catch { /* progress-only */ }
      await waitForOptionalProgress(Promise.resolve().then(() => reporter?.flush(deadline)).catch(() => {}), deadline);
    }
    try { conversationObserver?.markTerminal(); } catch { /* progress-only */ }
    try { reporter?.close(); } catch { /* progress-only */ }
  };
  try {
    observedBoundStop = await revalidateBoundRescueStop(input.store, workspace, job);
    initialBoundStopGuardComplete = true;
    jobLog = await openRuntimeJobLog({
      dataRoot, workspace, job, store: input.store, attach: 'always', fenceMs: OPTIONAL_PROGRESS_FENCE_MS,
      writeDiagnostic: input.progressWriter,
    });
    if (jobLog.attachedJob) running = jobLog.attachedJob;
    let prompt;
    if (job.command === 'review' || job.command === 'adversarial-review') {
      const gitFacts = await collectGitFacts({ workspace, scope: input.scope, base: input.base });
      prompt = await buildPrompt({ command: job.command, focus: input.focus, gitFacts });
    } else prompt = await buildPrompt({ command: 'rescue', task: input.task });
    const promptArtifact = await writeArtifact({ dataRoot, workspace, directory: 'prompts', jobId: job.id, contents: prompt }, { syncDirectory: input.syncDirectory });
    let snapshot;
    input.signal?.throwIfAborted();
    if (input.resumeSessionId) {
      await input.onBeforeResume?.(job);
      input.signal?.throwIfAborted();
      sessionId = input.resumeSessionId;
      snapshot = await boundedStep(() => client.resumeSession(input.resumeSessionId), input.signal);
      input.onResumeRpcSucceeded?.();
    } else snapshot = await boundedStep(async () => {
      const created = await client.createSession({ workspace, ...(input.model ? { model: input.model } : {}) });
      sessionId = created?.session?.sessionId;
      return created;
    }, input.signal);
    const activeSessionId = /** @type {string} */ (sessionId ?? snapshot.session.sessionId);
    sessionId = activeSessionId;
    const selectedModel = input.modelRequest ? resolveModel(input.modelRequest, input.modelAliases, snapshot.settings.model.available) : input.model;
    const runtimeRecoveryRequired = input.resumeSessionId !== undefined && snapshot.projection?.lastError?.type === 'ZCODE_RUNTIME_MODEL_UNAVAILABLE';
    if (runtimeRecoveryRequired) {
      const resolveRuntimeRecoveryConfig = input.resolveRuntimeRecoveryConfig;
      if (!resolveRuntimeRecoveryConfig) throw runtimeModelUnavailable(snapshot);
      let runtimeModel;
      try { runtimeModel = await boundedStep(() => resolveRuntimeRecoveryConfig(selectedModel), input.signal); }
      catch { input.signal?.throwIfAborted(); throw runtimeModelUnavailable(snapshot); }
      await boundedStep(() => client.updateRuntimeModelConfig(activeSessionId, runtimeModel), input.signal);
      snapshot = await boundedStep(() => client.readSession(activeSessionId), input.signal);
      if (!sameModel(snapshot.settings?.model?.current, runtimeModel?.model)
        || snapshot.projection?.lastError?.type === 'ZCODE_RUNTIME_MODEL_UNAVAILABLE') throw runtimeModelUnavailable(snapshot);
    }
    else if (!runtimeRecoveryRequired && selectedModel && !sameModel(snapshot.settings.model.current, selectedModel)) snapshot = await boundedStep(() => client.setModel(activeSessionId, selectedModel), input.signal);
    if (input.effort) snapshot = await boundedStep(() => client.setThoughtLevel(activeSessionId, input.effort), input.signal);
    conversationObserver = createDeferredConversationProgressObserver({ sessionId: activeSessionId, workspace });
    reporter = createProgressReporter({
      sessionId: activeSessionId,
      deferred: true,
      ...(input.progressWriter ? { write: input.progressWriter } : {}),
      ...(input.progressRelayWriter ? { relay: input.progressRelayWriter } : {}),
      persist: (event) => input.store.updateJobProgress(workspace, job.id, event),
      archive: (event) => jobLog.archiveEvent(event.message),
      persistProbe: (probe) => input.store.updateJobProgressProbe(workspace, job.id, probe),
      describeNotification: conversationObserver.observe,
      onDescriptorOverflow: conversationObserver.markGap,
      ...input.progressDependencies,
    });
    try { unsubscribeNotifications = client.subscribe(reporter.observe); } catch { unsubscribeNotifications = () => {}; }
    if (typeof client.subscribeConversation === 'function') {
      try {
        const conversationSubscription = await client.subscribeConversation(activeSessionId, { connectionId: `companion-${randomBytes(12).toString('hex')}`, clientMode: 'desktop-continuous' });
        if (!conversationSubscription || !isBoundedPublicIdentifier(conversationSubscription.subscriptionId) || typeof conversationSubscription.unsubscribe !== 'function') throw new Error('invalid conversation subscription');
        // Register cleanup before binding can perform any asynchronous work.
        unsubscribeConversation = conversationSubscription.unsubscribe;
        reporter.markConversationSubscribed();
        await conversationObserver.bind(conversationSubscription.subscriptionId);
      } catch { conversationObserver.fail(); reporter.diagnose('conversation-subscribe-failed'); }
    } else conversationObserver.fail();
    client.setPermissionHandler((/** @type {any} */ request) => decidePermission(request, job.permissionSnapshot, job.command));
    const now = new Date().toISOString();
    running = await input.store.transitionJob(workspace, job.id, ['queued'], 'running', {
      startedAt: now, zcodeSessionId: activeSessionId, promptArtifact,
      ...(input.childPid ? { childPid: input.childPid } : {}),
      ...(input.workerLeaseId ? { workerLeaseId: input.workerLeaseId } : {}),
      ...(selectedModel ? { model: selectedModel } : {}), ...(input.effort ? { effort: input.effort } : {}),
    });
    if (input.resumeSessionId) input.onRunningPersisted?.();
    input.signal?.throwIfAborted();
    const beforeMessageIds = [...snapshotMessageIds(snapshot)];
    // Drain only frames already delivered around the subscribe acknowledgement;
    // the bounded progress fence cannot wait indefinitely for a late initial.
    await reporter.flush(Date.now() + SUBSCRIPTION_BASELINE_FENCE_MS);
    // Confirm the subscription's historical baseline. If it is unavailable, v4
    // authority stays disabled and the coordinator uses snapshot reconciliation.
    conversationObserver.confirmBaseline();
    // Arm immediately before send. A fast v4 terminal may resolve now, but cannot
    // be consumed until the accepted input boundary below is durable.
    const admission = await withJobCancellationLock({ dataRoot, workspace, jobId: job.id }, async () => {
      const current = await input.store.readJob(workspace, job.id);
      if (current.status !== 'running' || current.zcodeSessionId !== activeSessionId
        || current.workerLeaseId !== running.workerLeaseId) throw statusPublicationError(job.id, current.status, ['running']);
      const admissionStop = await revalidateBoundRescueStop(input.store, workspace, current, observedBoundStop?.guard, activeSessionId);
      if (admissionStop?.kind === 'stale') {
        admissionTargetStale = true;
        throw statusPublicationError(job.id, admissionStop.job?.status ?? 'stale', ['running']);
      }
      input.signal?.throwIfAborted();
      conversationObserver.waitForTurnTerminal();
      conversationObserver.beginTurnBoundary();
      let sent;
      try {
        sent = await boundedStep(() => { sendAttempted = true; return client.send(activeSessionId, prompt); }, input.signal);
      } catch (error) { if (sendAttempted && !isCorrelatedZCodeResponseError(error)) sendAdmissionUnknown = true; throw error; }
      try {
        const accepted = await input.store.transitionJob(workspace, job.id, ['running'], 'running', { inputId: sent.inputId, startRevision: sent.stateRevision, beforeMessageIds });
        return { running: accepted, sent };
      } catch (boundaryError) {
        const winner = await input.store.readJob(workspace, job.id).catch(() => null);
        if (sameAcceptedBoundary(winner, sent, beforeMessageIds)) return { running: winner, sent };
        admissionBoundaryUnpublished = true;
        if (winner?.status === 'running' && winner.zcodeSessionId === activeSessionId) {
          try {
            const finalStop = await revalidateBoundRescueStop(input.store, workspace, winner, admissionStop?.guard, activeSessionId);
            if (finalStop?.kind !== 'stale') await client.stopSession(activeSessionId);
          } catch (compensationError) {
            await input.store.transitionJob(workspace, job.id, ['running'], 'running', { lastCancelError: safeError(compensationError).message }).catch(() => {});
          }
        }
        throw boundaryError;
      }
    });
    running = admission.running; const sent = admission.sent;
    await input.onBoundaryPersisted?.(running);
    const turnBoundary = { beforeMessageIds: new Set(beforeMessageIds), ...sent };
    try {
      const sessionDescriber = await createSessionProgressDescriber({ workspace, turnBoundary });
      reporter.activateAcceptedBoundary({ readSnapshot: () => client.readSession(activeSessionId), describer: sessionDescriber });
    } catch { reporter.activateAcceptedBoundary({}); }
    reporter.activate({ method: 'state.updated', params: { scope: 'session', sessionId: activeSessionId, reason: 'prompt_started' } });
    const observeLegacyCompletion = typeof client.observeCompletion === 'function'
      ? client.observeCompletion.bind(client)
      : client.waitForCompletion.bind(client);
    const legacyWake = waitForCompletionOrAbort(observeLegacyCompletion(activeSessionId), input.signal);
    const terminal = await awaitCurrentTurnTerminal({
      legacyWake, conversationObserver, readSnapshot: () => client.readSession(activeSessionId), turnBoundary, signal: input.signal,
    });
    await cleanupProgress(terminal.kind);
    const finalSnapshot = terminal.snapshot;
    remoteTerminalProven = true;
    if (terminal.kind === 'interrupted') {
      const winner = await settleRemoteInterruption({ input, job, workspace, dataRoot });
      if (winner.status === 'succeeded') output = { job: winner, result: await readResultArtifact({ dataRoot, workspace, artifact: winner.resultArtifact }) };
      else throw new PluginError('ZCODE_TURN_INTERRUPTED', 'ZCode interrupted the delegated turn.', { category: 'runtime', remedy: 'Retry the task when the session is ready.' });
    } else {
      if (terminal.kind === 'failed' && finalSnapshot?.projection?.status !== 'error') {
        const message = publicErrorMessage(selectCurrentTurnAssistant(finalSnapshot, turnBoundary)?.info?.error?.message) ?? 'ZCode reported a terminal error.';
        throw new PluginError('ZCODE_TURN_FAILED', message, { category: 'runtime', remedy: 'Inspect the stored ZCode job status/result and retry after resolving the reported provider or runtime failure.' });
      }
      const finalStatus = terminalSnapshotStatus(finalSnapshot, turnBoundary);
      const result = extractTerminalResultForStatus(finalSnapshot, job.command, turnBoundary, finalStatus);
      const publication = await publishSuccessfulResult({
        input, job, workspace, dataRoot, result,
        appendAssistant: () => jobLog.appendBlock('Assistant message', result, Date.now() + OPTIONAL_PROGRESS_FENCE_MS),
      });
      output = { job: publication.job, result: publication.result };
      appliedFinalization = publication.appliedFinalization;
    }
  } catch (error) {
    primaryError = error instanceof SuccessfulResultFinalizationError ? error.cause : error;
    let current = initialBoundStopGuardComplete ? await input.store.readJob(workspace, job.id).catch(() => running) : null;
    let resumeFailureSettlementRejected = false;
    if (input.resumeSessionId && current?.status === 'queued' && input.onResumeFailure) {
      try {
        const settled = await input.onResumeFailure(primaryError);
        try { current = await input.store.readJob(workspace, job.id); }
        catch (readError) {
          if (settled?.id === job.id && settled.workspace === running.workspace
            && ['running', 'failed', 'cancelled'].includes(settled.status)) current = settled;
          else throw readError;
        }
      } catch (rollbackError) {
        primaryError = new ResumeFailureSettlementError(primaryError, rollbackError);
        resumeFailureSettlementRejected = true;
      }
    }
    if (!resumeFailureSettlementRejected && error instanceof SuccessfulResultFinalizationError) {
      if (current?.status === 'succeeded' && current.resultArtifact === error.resultArtifact) {
        try { output = { job: current, result: await readResultArtifact({ dataRoot, workspace, artifact: error.resultArtifact }) }; primaryError = undefined; }
        catch (artifactError) { primaryError = artifactError; }
      }
      else if (current && ['failed', 'cancelled', 'succeeded'].includes(current.status) && current.resultArtifact !== error.resultArtifact) await removeResultArtifact({ dataRoot, workspace, jobId: job.id, artifact: error.resultArtifact }).catch(() => {});
      /* Otherwise recovery owns the durable running job and retained result artifact. */
    }
    else if (!resumeFailureSettlementRejected && isInterruption(error) && current && !['failed', 'succeeded', 'cancelled'].includes(current.status)) {
      if (current.status === 'queued' && sessionId) {
        let stopped = false;
        const finalStop = await revalidateBoundRescueStop(input.store, workspace, current, observedBoundStop?.guard, sessionId);
        if (finalStop?.kind !== 'stale') try { await client.stopSession(sessionId); stopped = true; } catch { /* retain the writable guard when remote stop is unacknowledged */ }
        if (stopped) try { await input.store.finishJob(workspace, job.id, ['queued'], 'cancelled', { exitCode: null }); } catch (finalizeError) { primaryError = finalizeError; }
      } else if (current.status === 'running' && !sendAttempted && sessionId) {
        try {
          await withJobCancellationLock({ dataRoot, workspace, jobId: job.id }, async () => {
            const candidate = await input.store.readJob(workspace, job.id);
            if (candidate.status !== 'running' || candidate.zcodeSessionId !== sessionId) return;
            const finalStop = await revalidateBoundRescueStop(input.store, workspace, candidate, observedBoundStop?.guard, sessionId);
            if (finalStop?.kind === 'stale') return;
            await client.stopSession(sessionId);
            await input.store.transitionJob(workspace, job.id, ['running'], 'cancelling');
            await input.store.finishJob(workspace, job.id, ['cancelling'], 'cancelled', { exitCode: null });
          });
        } catch { /* retain the writable guard when the known no-send session cannot be stopped */ }
      } else {
        let cancellationPublicationApplied = false;
        const cancellation = createJobController({
          store: input.store, dataRoot,
          stopSession: (id) => client.stopSession(id),
          readSession: (id) => client.readSession(id),
          publishSucceededSnapshot: async ({ job: cancelling, snapshot, turnBoundary }) => {
            const result = extractFinalResult(snapshot, cancelling.command, turnBoundary);
            const publication = await publishSuccessfulResultWithLockHeld({
              input, job: cancelling, workspace, dataRoot, result, expectedStatuses: ['cancelling'],
              returnTerminalWinner: true,
              appendAssistant: () => jobLog.appendBlock('Assistant message', result, Date.now() + OPTIONAL_PROGRESS_FENCE_MS),
            });
            cancellationPublicationApplied = publication.appliedFinalization;
            return publication.job;
          },
        });
        const cancellationWinner = await cancellation.cancel(workspace, job.id, job.ownerSessionId).catch(() => null);
        if (cancellationWinner?.status === 'succeeded' && cancellationWinner.resultArtifact) {
          try {
            output = { job: cancellationWinner, result: await readResultArtifact({ dataRoot, workspace, artifact: cancellationWinner.resultArtifact }) };
            appliedFinalization = cancellationPublicationApplied; primaryError = undefined;
          } catch (artifactError) { primaryError = artifactError; }
        }
      }
    } else if (!resumeFailureSettlementRejected && current && !['failed', 'succeeded', 'cancelled', 'cancelling'].includes(current.status)) {
      let canFail = !sendAdmissionUnknown && !admissionBoundaryUnpublished && !admissionTargetStale;
      if (current.status === 'running' && sendAttempted && sessionId && !remoteTerminalProven && !admissionBoundaryUnpublished) {
        try {
          const finalStop = await revalidateBoundRescueStop(input.store, workspace, current, observedBoundStop?.guard, sessionId);
          if (finalStop?.kind === 'stale') canFail = false;
          else await client.stopSession(sessionId);
        } catch (cleanupError) {
          await input.store.transitionJob(workspace, job.id, ['running'], 'running', { lastCancelError: safeError(cleanupError).message }).catch(() => {});
          canFail = false;
        }
      }
      if (canFail) try { await input.store.finishJob(workspace, job.id, [current.status], 'failed', { error: safeError(error), exitCode: 1 }); } catch (finalizeError) { primaryError = finalizeError; }
    }
  }
  // Cleanup order is part of the progress lifecycle contract.
  await cleanupProgress();
  try {
    if (sessionId && typeof client.releaseTurn === 'function') client.releaseTurn(sessionId);
  } catch (cleanupError) {
    if (!primaryError && output?.job?.status !== 'succeeded') primaryError = cleanupError;
  }
  await client.close().catch(() => {});
  if (!primaryError && appliedFinalization && output?.job?.status === 'succeeded' && typeof output.result === 'string') {
    await jobLog?.appendBlock('Final output', output.result, Date.now() + OPTIONAL_PROGRESS_FENCE_MS);
  }
  await cleanupJobLog();
  if (primaryError) throw primaryError;
  return output;
}

/** @param {Promise<unknown>} operation @param {number} deadline */
async function waitForOptionalProgress(operation, deadline) {
  let completed = false;
  const tracked = operation.then(() => { completed = true; }).catch(() => { completed = true; });
  /** @type {ReturnType<typeof setTimeout>|undefined} */ let timer;
  try {
    const timeoutMs = Math.max(0, deadline - Date.now());
    if (timeoutMs > 0) await Promise.race([tracked, new Promise((resolvePromise) => { timer = setTimeout(resolvePromise, timeoutMs); })]);
    for (let phase = 0; phase < 2 && !completed; phase += 1) {
      await new Promise((resolvePromise) => setImmediate(resolvePromise)); await Promise.resolve();
    }
  }
  catch { /* optional progress cleanup */ }
  finally { if (timer !== undefined) clearTimeout(timer); }
  return completed;
}

/** @param {any} job @param {{inputId:string,stateRevision:number}} sent @param {string[]} beforeMessageIds */
function sameAcceptedBoundary(job, sent, beforeMessageIds) {
  return job?.status === 'running' && job.inputId === sent.inputId && job.startRevision === sent.stateRevision
    && Array.isArray(job.beforeMessageIds) && JSON.stringify(job.beforeMessageIds) === JSON.stringify(beforeMessageIds);
}

/** Serialize executor terminal publication with cancellation and lifecycle maintenance. @param {{input:any,job:any,workspace:string,dataRoot:string,result:string,appendAssistant:()=>Promise<unknown>}} publication */
async function publishSuccessfulResult({ input, job, workspace, dataRoot, result, appendAssistant }) {
  return withJobCancellationLock({ dataRoot, workspace, jobId: job.id }, () => publishSuccessfulResultWithLockHeld({
    input, job, workspace, dataRoot, result, appendAssistant, expectedStatuses: ['running'],
  }));
}

/**
 * Publish a coherent successful snapshot while the caller already owns the job cancellation lock.
 * @param {{input:any,job:any,workspace:string,dataRoot:string,result:string,appendAssistant?:()=>Promise<unknown>,expectedStatuses?:string[],returnTerminalWinner?:boolean}} publication
 */
export async function publishSuccessfulResultWithLockHeld({ input, job, workspace, dataRoot, result, appendAssistant = async () => {}, expectedStatuses = ['running'], returnTerminalWinner = false }) {
  const current = await input.store.readJob(workspace, job.id);
  if (current.status === 'succeeded') return { job: current, result: await readResultArtifact({ dataRoot, workspace, artifact: current.resultArtifact }), appliedFinalization: false };
  if (['failed', 'cancelled'].includes(current.status)) {
    if (returnTerminalWinner) return { job: current, result: undefined, appliedFinalization: false };
    throw terminalPublicationError(job.id, current.status);
  }
  if (!expectedStatuses.includes(current.status)) throw statusPublicationError(job.id, current.status, expectedStatuses);
  await appendAssistant();
  const resultArtifact = await writeResultArtifact({ dataRoot, workspace, jobId: job.id, contents: result }, { syncDirectory: input.syncDirectory });
  try {
    const succeeded = await input.store.finishJob(workspace, job.id, [current.status], 'succeeded', { resultArtifact, exitCode: 0 });
    return { job: succeeded, result, appliedFinalization: true };
  } catch (error) {
    const winner = await input.store.readJob(workspace, job.id).catch(() => null);
    if (winner?.status === 'succeeded' && winner.resultArtifact === resultArtifact) return { job: winner, result: await readResultArtifact({ dataRoot, workspace, artifact: resultArtifact }), appliedFinalization: true };
    if ((winner && expectedStatuses.includes(winner.status)) || !winner) throw new SuccessfulResultFinalizationError(error, resultArtifact);
    if (winner.resultArtifact !== resultArtifact) await removeResultArtifact({ dataRoot, workspace, jobId: job.id, artifact: resultArtifact }).catch(() => {});
    if (returnTerminalWinner && ['succeeded', 'failed', 'cancelled'].includes(winner.status)) return { job: winner, result: undefined, appliedFinalization: false };
    throw error;
  }
}

/** Settle v4-proven remote interruption without requiring another stop acknowledgement. @param {{input:any,job:any,workspace:string,dataRoot:string}} settlement */
async function settleRemoteInterruption({ input, job, workspace, dataRoot }) {
  return withJobCancellationLock({ dataRoot, workspace, jobId: job.id }, async () => {
    let current = await input.store.readJob(workspace, job.id);
    if (['cancelled', 'failed', 'succeeded'].includes(current.status)) return current;
    if (current.status === 'queued') return settleInterruptedFinish(input.store, workspace, job.id, ['queued']);
    if (current.status === 'running') {
      try { current = await input.store.transitionJob(workspace, job.id, ['running'], 'cancelling', { lastCancelError: null }); }
      catch (error) {
        const winner = await input.store.readJob(workspace, job.id).catch(() => null);
        if (winner && winner.status !== 'running') current = winner; else throw error;
      }
    }
    if (current.status === 'cancelling') return settleInterruptedFinish(input.store, workspace, job.id, ['cancelling']);
    return current;
  });
}

/** @param {any} store @param {string} workspace @param {string} jobId @param {string[]} expected */
async function settleInterruptedFinish(store, workspace, jobId, expected) {
  try { return await store.finishJob(workspace, jobId, expected, 'cancelled', { exitCode: null }); }
  catch (error) {
    const winner = await store.readJob(workspace, jobId).catch(() => null);
    if (winner?.status === 'cancelled') return winner;
    throw error;
  }
}

export class SuccessfulResultFinalizationError extends Error {
  /** @param {unknown} cause @param {string} resultArtifact */
  constructor(cause, resultArtifact) { super('Successful result could not be finalized.', { cause }); this.name = 'SuccessfulResultFinalizationError'; this.resultArtifact = resultArtifact; }
}

export class ResumeFailureSettlementError extends Error {
  /** @param {unknown} executionError @param {unknown} settlementError */
  constructor(executionError, settlementError) {
    super('Resume failure settlement could not be proven.', { cause: settlementError });
    this.name = 'ResumeFailureSettlementError';
    this.executionError = executionError;
    this.settlementError = settlementError;
  }
}

/** @param {string} jobId @param {string} status */
function terminalPublicationError(jobId, status) {
  return new PluginError('JOB_TERMINAL', `Job ${jobId} is already terminal.`, { category: 'state', remedy: 'Create a new job instead of changing a terminal job.', details: { jobId, status } });
}

/** @param {string} jobId @param {string} status @param {string[]} expectedStatuses */
function statusPublicationError(jobId, status, expectedStatuses) {
  return new PluginError('JOB_STATUS_CONFLICT', `Job ${jobId} changed status unexpectedly.`, { category: 'state', remedy: 'Reload the job and retry from its current status.', details: { actualStatus: status, expectedStatuses: [...expectedStatuses], jobId } });
}

/** @template T @param {()=>Promise<T>} operation @param {AbortSignal|undefined} signal */
async function boundedStep(operation, signal) {
  signal?.throwIfAborted();
  try { const value = await operation(); signal?.throwIfAborted(); return value; }
  catch (error) { signal?.throwIfAborted(); throw error; }
}

/** @param {{dataRoot:string,workspace:string,artifact:string}} input */
export async function readResultArtifact({ dataRoot, workspace, artifact }) {
  const storage = await resolveWorkspaceStorage({ dataRoot, workspace });
  const pieces = artifact.split(/[\\/]/); if (pieces.length !== 2 || pieces[0] !== 'results' || !pieces[1]) throw artifactError();
  try {
    return await withFileLock(join(storage.directory, '.artifacts.lock'), async () => {
      const root = await secureArtifactRoot(storage.directory, 'results', false); const path = join(root, pieces[1]);
      const pathInfo = await lstat(path); if (pathInfo.isSymbolicLink() || !pathInfo.isFile()) throw artifactError();
      if (await realpath(dirname(path)) !== root) throw artifactError();
      const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const before = await handle.stat(); const contents = await handle.readFile('utf8'); const handleAfter = await handle.stat();
        const after = await lstat(path); if (after.isSymbolicLink() || !after.isFile() || await realpath(dirname(path)) !== root) throw artifactError();
        const pathHandle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try {
          const pathAfter = await pathHandle.stat();
          if (!sameFileIdentity(before, handleAfter) || !sameFileIdentity(before, pathAfter)) throw artifactError();
        }
        finally { await pathHandle.close(); }
        return contents;
      }
      finally { await handle.close(); }
    });
  } catch (error) { throw new PluginError('RESULT_READ_FAILED', 'Could not safely read the result artifact.', { category: 'storage', remedy: 'Inspect the private workspace result store.', cause: error }); }
}

/** @param {{dataRoot:string,workspace:string,jobId:string,contents:string}} input @param {{syncDirectory?:(path:string)=>Promise<void>}} [dependencies] */
export function writeResultArtifact(input, dependencies = {}) { return writeArtifact({ ...input, directory: 'results' }, dependencies); }

/** @param {{dataRoot:string,workspace:string,jobId:string,artifact:string}} input */
export async function removeResultArtifact(input) {
  const storage = await resolveWorkspaceStorage(input); const expected = `results/${input.jobId}.md`;
  if (input.artifact !== expected) throw artifactError();
  await withFileLock(join(storage.directory, '.artifacts.lock'), async () => {
    const root = await secureArtifactRoot(storage.directory, 'results', false); const path = join(root, `${input.jobId}.md`);
    const info = await lstat(path); if (info.isSymbolicLink() || !info.isFile() || await realpath(dirname(path)) !== root) throw artifactError();
    await unlink(path); await defaultSyncDirectory(root);
  });
}

/** @param {{dataRoot:string,workspace:string,directory:string,jobId:string,contents:string}} input @param {{syncDirectory?:(path:string)=>Promise<void>}} [dependencies] */
async function writeArtifact({ dataRoot, workspace, directory, jobId, contents }, dependencies = {}) {
  const storage = await resolveWorkspaceStorage({ dataRoot, workspace }); const syncDirectory = dependencies.syncDirectory ?? defaultSyncDirectory;
  const relative = `${directory}/${jobId}.md`; let temporary; /** @type {import('node:fs/promises').FileHandle|undefined} */ let handle;
  try {
    return await withFileLock(join(storage.directory, '.artifacts.lock'), async () => {
      const targetDirectory = await secureArtifactRoot(storage.directory, directory, true); const path = join(targetDirectory, `${jobId}.md`);
      try { if ((await lstat(path)).isSymbolicLink()) throw artifactError(); } catch (error) { if (errorCode(error) !== 'ENOENT') throw error; }
      temporary = join(targetDirectory, `.${basename(path)}.${randomBytes(8).toString('hex')}.tmp`);
      handle = await open(temporary, 'wx', 0o600); await handle.writeFile(contents, 'utf8'); await handle.sync();
      // Compare the temporary and final files through FileHandle.stat on both
      // sides. Node 22.13 Windows uses different libuv stat paths for lstat
      // and fstat, so a path-stat comparison rejects a valid rename. Keeping
      // both identities handle-bound preserves the replacement check.
      const sourceInfo = await handle.stat(); await handle.close(); handle = undefined;
      if (await realpath(targetDirectory) !== targetDirectory) throw artifactError();
      await rename(temporary, path); temporary = undefined; const finalInfo = await lstat(path);
      if (finalInfo.isSymbolicLink() || !finalInfo.isFile() || await realpath(dirname(path)) !== targetDirectory) throw artifactError();
      const finalHandle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try { if (!sameFileIdentity(sourceInfo, await finalHandle.stat())) throw artifactError(); }
      finally { await finalHandle.close(); }
      await chmod(path, 0o600); await syncDirectory(targetDirectory); return relative;
    });
  } catch (error) { await closeFileHandle(handle); if (temporary) await unlink(temporary).catch(() => {}); throw new PluginError('ARTIFACT_WRITE_FAILED', 'Could not durably write the private artifact.', { category: 'storage', remedy: 'Check plugin data storage and retry.', cause: error }); }
}

/** @param {import('node:fs/promises').FileHandle|undefined} handle */
async function closeFileHandle(handle) { await handle?.close().catch(() => {}); }

/** @param {any} left @param {any} right */
function sameFileIdentity(left, right) { return left.dev === right.dev && left.ino === right.ino; }

/** @param {string} storageDirectory @param {string} directory @param {boolean} create */
async function secureArtifactRoot(storageDirectory, directory, create) {
  const storageRoot = await realpath(resolve(storageDirectory)); const lexicalRoot = join(storageDirectory, directory); let info;
  try { info = await lstat(lexicalRoot); } catch (error) { if (!create || errorCode(error) !== 'ENOENT') throw error; await ensurePrivateDirectory(lexicalRoot); info = await lstat(lexicalRoot); }
  if (info.isSymbolicLink() || !info.isDirectory()) throw artifactError();
  const root = await realpath(lexicalRoot); if (await realpath(dirname(root)) !== storageRoot) throw artifactError();
  return root;
}
/** @param {string} path */
async function defaultSyncDirectory(path) {
  const handle = await open(path, 'r');
  try { await handle.sync(); }
  catch (error) { if (!['EINVAL', 'ENOTSUP', 'EPERM'].includes(errorCode(error) ?? '')) throw error; }
  finally { await handle.close(); }
}

/** @param {any} snapshot @param {string} command @param {{beforeMessageIds?:Set<string>,inputId?:string,stateRevision?:number}} [turnBoundary] */
export function extractTerminalResult(snapshot, command, turnBoundary = {}) {
  return extractTerminalResultForStatus(snapshot, command, turnBoundary, terminalSnapshotStatus(snapshot, turnBoundary));
}

/** @param {any} snapshot @param {{stateRevision?:number}} turnBoundary */
function terminalSnapshotStatus(snapshot, turnBoundary) {
  if (turnBoundary.stateRevision !== undefined) {
    const snapshotRevision = snapshot?.runtime?.stateRevision;
    if (!Number.isSafeInteger(snapshotRevision) || snapshotRevision < turnBoundary.stateRevision) throw invalidTerminalState();
  }
  return snapshot?.projection?.status;
}

/** @param {any} snapshot @param {string} command @param {{beforeMessageIds?:Set<string>,inputId?:string,stateRevision?:number}} turnBoundary @param {unknown} status */
function extractTerminalResultForStatus(snapshot, command, turnBoundary, status) {
  if (status === 'error') {
    const message = publicErrorMessage(snapshot?.projection?.lastError?.message) ?? 'ZCode reported a terminal error.';
    throw new PluginError('ZCODE_TURN_FAILED', message, { category: 'runtime', remedy: 'Inspect the stored ZCode job status/result and retry after resolving the reported provider or runtime failure.' });
  }
  if (status !== 'completed' && status !== 'idle') throw invalidTerminalState();
  return extractFinalResult(snapshot, command, turnBoundary);
}

/** @param {any} snapshot @param {string} command @param {{beforeMessageIds?:Set<string>,inputId?:string,stateRevision?:number}} [turnBoundary] */
export function extractFinalResult(snapshot, command, turnBoundary = {}) {
  const assistant = selectCurrentTurnAssistant(snapshot, turnBoundary);
  const parts = assistant?.parts?.filter((/** @type {any} */ part) => part?.type === 'text' && part.ignored !== true && typeof part.text === 'string' && part.text.length > 0).map((/** @type {any} */ part) => part.text) ?? [];
  if (!parts.length) throw missingResult();
  const text = parts.join('\n');
  if (command !== 'review' && command !== 'adversarial-review') return text;
  let structured = assistant?.info?.structured;
  if (structured === undefined) {
    try { structured = JSON.parse(text); } catch (error) { throw invalidReviewResult(error); }
  }
  if (!validateJsonSchema(structured, REVIEW_OUTPUT_SCHEMA)) throw invalidReviewResult();
  return `${JSON.stringify(structured, null, 2)}\n`;
}
/** @param {any} snapshot */
function snapshotMessageIds(snapshot) { return new Set((Array.isArray(snapshot?.messages) ? snapshot.messages : []).map((/** @type {any} */ message) => message?.info?.messageId).filter((/** @type {unknown} */ value) => typeof value === 'string')); }
function missingResult() { return new PluginError('ZCODE_RESULT_MISSING', 'ZCode completed without a visible result for the current turn.', { category: 'protocol', remedy: 'Inspect the ZCode session and retry.' }); }
function invalidTerminalState() { return new PluginError('ZCODE_TERMINAL_STATE_INVALID', 'ZCode completion did not produce a success-compatible terminal state.', { category: 'protocol', remedy: 'Inspect the stored job status and retry.' }); }
/** @param {unknown} [cause] */
function invalidReviewResult(cause) { return new PluginError('REVIEW_RESULT_INVALID', 'ZCode review output failed the required findings schema.', { category: 'protocol', remedy: 'Retry the review with a compatible ZCode model.', ...(cause ? { cause } : {}) }); }
/** @param {any} response */
function validResponse(response) { return response && typeof response === 'object' && ['allow', 'deny'].includes(response.decision); }
/** @param {unknown} error */
function safeError(error) { return { message: error instanceof Error ? error.message.slice(0, 2048) : 'Unknown execution failure' }; }
/** @param {unknown} error */
function isInterruption(error) { return error instanceof PluginError && error.code === 'JOB_INTERRUPTED'; }
/** @param {unknown} error */
function errorCode(error) { return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : undefined; }
/** @param {any} left @param {any} right */
function sameModel(left, right) { return left?.providerId === right?.providerId && left?.modelId === right?.modelId && (left?.variant ?? '') === (right?.variant ?? ''); }
/** @param {any} snapshot */
function runtimeModelUnavailable(snapshot) {
  const message = publicErrorMessage(snapshot?.projection?.lastError?.message) ?? 'ZCode runtime model is unavailable.';
  return new PluginError('ZCODE_REQUEST_FAILED', `ZCode session/resume failed: ${message}`, {
    category: 'runtime', remedy: 'Configure a supported ZCode CLI model and retry the resume.',
    details: { method: 'session/resume', remoteCode: 'ZCODE_RUNTIME_MODEL_UNAVAILABLE' },
  });
}
function artifactError() { return new PluginError('RESULT_ARTIFACT_INVALID', 'Result artifact path is outside the private result store.', { category: 'storage', remedy: 'Restore the job record with a scoped result artifact.' }); }
