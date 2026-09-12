import { realpath } from 'node:fs/promises';
import { join } from 'node:path';

import { listCodexThreadSpawnChildren, readCodexRescueChildTurnEvidence } from './codex-app-server.mjs';
import { PluginError } from './errors.mjs';
import { createHostLifecycleStore, hostLifecycleEpoch } from './host-lifecycle.mjs';
import { createIdentityStore } from './identity.mjs';
import { resolvePartiallyStoppedForwardingExecutor, resolveRecordedSessionStart, resolveRoutedForwardingExecutor, settleExactForwardingStop } from '../../hooks/lib/hook-state.mjs';
import { settleRescueChildOwnedJob, TERMINAL } from './recovery.mjs';
import { readRescueBindingPartitionFile, rescueBindingPartitionKey, validHostLifecycleRecord } from './rescue-binding.mjs';
import { classifyRescueChildHost, MAX_RESCUE_CHILDREN, validateRescueChildren, validRescueSelectionRequest } from './rescue-route-planner.mjs';
import { createStateStore } from './state.mjs';
import { resolveWorkspaceStorage } from './workspace.mjs';
import { createExistingManagedZCodeClient } from './zcode-client.mjs';

/**
 * The bounded Rescue child loss recovery coordinator joins trusted Host
 * evidence, the exact binding and its current job, and the shared conditional
 * Hook-state stop primitive so one terminated Rescue child's stale active
 * records can be reconciled before preparation planning reruns. It is the
 * prepare-branch counterpart of the SubagentStop coordination-loss settlement:
 * SubagentStop remains the normal fast path, and this coordinator only covers
 * resume or already-resolved continuation requests whose child died without
 * one (a usage limit, a crash, or a missing lifecycle hook — never a Host
 * SessionEnd Boundary, which keeps its own receipt precedence).
 *
 * The pipeline is exactly the specified one:
 *
 *   select exact candidate -> capture tuple -> read Host proof
 *   -> existing business reconciliation
 *   -> require terminal outcome and discharged execution obligations
 *   -> second Host proof -> validate unchanged binding/caller
 *   -> conditional stop-state update -> stopped lookup
 *
 * Business settlement is delegated to the existing Rescue Lifecycle Reconciler
 * through the recovery adapters (`settleRescueChildOwnedJob`) — never a second
 * stop state machine. Fresh requests skip recovery entirely, ambiguity and
 * identity mismatches are never recovered, and every failure is thrown: the
 * caller must never prepare anyway. Bounds: one child settled per call, at
 * most two exact Host reads and one business reconciliation, all inside one
 * shared five-second budget that every stage (probe iteration included)
 * draws from and that any shorter upstream signal truncates. A BUDGET expiry
 * lands on the stage's specified bounded outcome —
 * `RESCUE_CHILD_EVIDENCE_UNAVAILABLE` before the business settlement,
 * `RESCUE_CHILD_RECOVERY_PENDING` once settlement work has begun — and never
 * escapes as a raw interruption or abort reason; only a genuinely upstream
 * abort (`input.signal` itself) propagates the caller's own reason.
 *
 * Errors:
 * - `RESCUE_CHILD_EVIDENCE_UNAVAILABLE` — termination was not proven (unknown
 *   or uncorrelatable Host evidence, evidence whose identity diverges from the
 *   binding, records whose authorization cannot be joined exactly, or a
 *   budget expiry before settlement); no recovery write happened.
 * - `RESCUE_CHILD_RECOVERY_PENDING` — settlement is not (yet) terminal, an
 *   obligation is outstanding, the second Host proof failed, the binding
 *   could not be revalidated, or the stop writes stayed partial; retry may
 *   finish the same tuple.
 * - `RESCUE_CHILD_RECOVERY_SUPERSEDED` — a successor was observed (changed
 *   identity or parent epoch across the executor/binding/job join, an
 *   advanced binding, a re-resolved caller whose generation, permission, or
 *   lifecycle epoch no longer matches the captured authority, or an
 *   adapter-contract-violating newer child turn); do not continue.
 * - `RESCUE_BINDING_INVALID` — every binding-resolution failure is wrapped
 *   into the planner's canonical code (with the original failure as cause),
 *   so the caller sees one canonical code whether the planner or this
 *   coordinator surfaced it.
 * Interruptions from the caller's signal propagate untouched, and preserved
 * planner errors (`RESCUE_CHILD_AMBIGUOUS`, discovery) surface exactly as the
 * planner would raise them.
 * @param {{dataRoot:string,caller:any,envelope:any,appServerOptions?:any,signal?:AbortSignal,dependencies?:any}} input
 * @returns {Promise<{kind:'not-needed'}|{kind:'reconciled',executionWorkspace:string}>}
 */
export async function reconcileRescueChildForPreparation(input) {
  validateRecoveryInput(input);
  const caller = input.caller;
  const envelope = input.envelope;
  if (envelope.options.resume === 'fresh') return NOT_NEEDED;
  // Recovery runs ONLY for resume requests or requests already resolved as a
  // continuation target (the design's entry-point restriction): a non-fresh
  // request with neither semantics never reaches discovery or settlement.
  if (envelope.options.resume !== 'resume' && (envelope.continuationTarget ?? null) === null) return NOT_NEEDED;
  const dependencies = resolvedDependencies(input);
  const store = dependencies.store;
  input.signal?.throwIfAborted();
  // One shared five-second recovery budget: every stage draws only what
  // remains of it, and a shorter upstream signal truncates every stage signal.
  const deadline = dependencies.now() + RECOVERY_BUDGET_MS;
  const budgetRemaining = () => deadline - dependencies.now();
  const stageWindow = () => {
    const remaining = Math.max(0, budgetRemaining());
    const budgetSignal = remaining > 0 ? AbortSignal.timeout(remaining) : AbortSignal.abort();
    return {
      signal: input.signal === undefined ? budgetSignal : AbortSignal.any([input.signal, budgetSignal]),
      timeoutMs: remaining,
    };
  };
  /**
   * Run one stage inside its shared-budget window. A BUDGET-caused failure —
   * the window aborted while the upstream signal did not, or the deadline has
   * already passed — maps onto the stage's specified bounded outcome with the
   * original failure as cause; a genuinely upstream abort propagates the
   * caller's own reason; anything else is the stage's genuine failure and is
   * handed to its own mapping. Stages whose seams cannot observe the signal
   * (the StateStore binding lookup, the receipt read) are raced against the
   * window, so the whole recovery stays inside the shared budget even when a
   * seam's lock would wait longer.
   * @param {{signal:AbortSignal,timeoutMs:number}} window
   * @param {() => Promise<any>} operation
   * @param {(error:unknown) => any} mapGenuine
   * @param {(error:unknown) => any} budgetError
   */
  const ranStage = async (window, operation, mapGenuine, budgetError) => {
    // No stage starts past an expired shared budget: a stage whose window was
    // constructed already aborted (the deadline landed exactly on the stage
    // boundary) refuses to run here instead of racing an abort resolver it
    // would never reach. An upstream-aborted caller keeps owning the outcome.
    if (input.signal?.aborted !== true && budgetRemaining() <= 0) throw budgetError(undefined);
    let onAbort = () => {};
    const abortListener = () => onAbort();
    if (!window.signal.aborted) window.signal.addEventListener('abort', abortListener, { once: true });
    /** @type {any} */
    let settled;
    try {
      settled = await Promise.race([
        Promise.resolve().then(operation).then(
          (value) => ({ ok: true, value }),
          (error) => ({ ok: false, error }),
        ),
        new Promise((resolve) => { onAbort = () => resolve(ABORTED); if (window.signal.aborted) onAbort(); }),
      ]);
    } finally { window.signal.removeEventListener('abort', abortListener); }
    if (settled === ABORTED) {
      if (input.signal?.aborted) throw input.signal.reason;
      throw budgetError(undefined);
    }
    if (!settled.ok) {
      if (input.signal?.aborted) throw settled.error;
      if (window.signal.aborted || budgetRemaining() <= 0) throw budgetError(settled.error);
      throw mapGenuine(settled.error);
    }
    return settled.value;
  };

  let originWorkspace; let executionWorkspace;
  try {
    [executionWorkspace, originWorkspace] = await Promise.all([
      realpath(caller.workspace),
      realpath(caller.originWorkspace ?? caller.workspace),
    ]);
  } catch { return NOT_NEEDED; }
  input.signal?.throwIfAborted();

  const discoveryWindow = stageWindow();
  const children = await ranStage(discoveryWindow, () => dependencies.listChildren(caller.sessionId, discoveryWindow),
    (error) => {
      if (/** @type {any} */ (error)?.code === 'CODEX_CHILD_METADATA_INVALID') throw /** @type {any} */ (error);
      return discoveryFailed();
    },
    (error) => evidenceUnavailable(BUDGET_EVIDENCE_MESSAGE, error));
  if (!Array.isArray(children) || children.length > MAX_RESCUE_CHILDREN) throw discoveryFailed();
  const hostChildren = validateRescueChildren(children, caller.sessionId);
  const continuationTarget = envelope.continuationTarget ?? null;
  const candidateChildren = (continuationTarget === null ? hostChildren
    : hostChildren.filter((/** @type {any} */ host) => envelope.version === 3
      ? host.agentPath === continuationTarget.agentPath
      : host.id === continuationTarget.childId && host.agentPath === continuationTarget.agentPath))
    // The planner's own eligibility classification: occupancy children —
    // unmanaged agent paths or unapproved Roles — are never Rescue candidates,
    // so they are never probed, never raise executor errors, and never create
    // false ambiguity.
    .filter((/** @type {any} */ host) => classifyRescueChildHost(host) !== 'occupancy');

  /** The planner's own candidate authorization (`validateCandidate`): the
   * child's execution workspace must be the preparing caller's canonical
   * workspace, the child's cwd the canonical origin, and the executor identity
   * must match the discovered child exactly. A candidate the planner would
   * reject is skipped — recovery never settles a job the planner would refuse
   * to prepare, and the planner owns the canonical public rejection.
   * @param {any} host @param {{executor:any,executionWorkspace:string}} resolved
   * @param {string} canonicalExecutionWorkspace @param {string} canonicalOriginWorkspace @param {any} requestCaller
   * @returns {boolean} */
  const plannerEquivalentCandidate = (host, resolved, canonicalExecutionWorkspace, canonicalOriginWorkspace, requestCaller) => {
    const executor = resolved?.executor;
    return resolved?.executionWorkspace === canonicalExecutionWorkspace
      && executor?.workspace === canonicalExecutionWorkspace
      && executor?.originWorkspace === canonicalOriginWorkspace
      && host?.cwd === canonicalOriginWorkspace
      && executor?.agentId === host?.id
      && executor?.parentSessionId === requestCaller?.sessionId
      && executor?.parentPermissionMode === requestCaller?.permissionMode;
  };

  // Exact candidate selection: only a child whose executor records are stuck
  // ACTIVE needs recovery. A stopped or absent route means the planner flow
  // can proceed untouched; ambiguity and any other identity failure is
  // rejected, never swallowed into a target choice. Every probe iteration
  // draws from the same shared deadline, so scanning the candidates can never
  // outlive the recovery budget, and at most ONE child is ever settled.
  const stuck = [];
  for (const host of candidateChildren) {
    input.signal?.throwIfAborted();
    if (budgetRemaining() <= 0) throw evidenceUnavailable(BUDGET_EVIDENCE_MESSAGE);
    const probeWindow = stageWindow();
    let resolved;
    try {
      resolved = await ranStage(probeWindow, () => dependencies.resolveActiveExecutor(input.dataRoot, host.cwd, host.id, probeWindow),
        (error) => error,
        (error) => evidenceUnavailable(BUDGET_EVIDENCE_MESSAGE, error));
    } catch (error) {
      // A caller cancellation is never mistaken for an absent candidate: the
      // abort reason propagates before any skip classification.
      if (input.signal?.aborted) throw input.signal.reason;
      if (error instanceof PluginError && SKIP_EXECUTOR_CODES.has(error.code)) continue;
      if (error instanceof PluginError && PARTIAL_TRIGGER_CODES.has(error.code)) {
        // The rejection may be THIS recovery's own prior partial pass (stopped
        // route, executor still active). Revalidate an exact partially stopped
        // tuple for this child: when it revalidates, resume the SAME full
        // pipeline below so the retry finishes the partial writes. Any other
        // shape — a fully stopped child, a different tuple's republished
        // records, an unreadable store — keeps the existing skip semantics;
        // only genuine ambiguity is rejected.
        const partialWindow = stageWindow();
        let partial = null;
        try {
          partial = await ranStage(partialWindow,
            () => dependencies.resolvePartialExecutor(input.dataRoot, host.cwd, host.id, partialWindow),
            (partialError) => partialError,
            (partialBudgetError) => evidenceUnavailable(BUDGET_EVIDENCE_MESSAGE, partialBudgetError));
        } catch (partialError) {
          // The caller's abort wins first, a budget expiry stays the specified
          // bounded outcome, and only then may the failure classify the child
          // as an absent candidate.
          if (input.signal?.aborted) throw input.signal.reason;
          if (partialError instanceof PluginError
            && (partialError.message === BUDGET_EVIDENCE_MESSAGE || partialError.message === BUDGET_PENDING_MESSAGE)) throw partialError;
          if (partialError instanceof PluginError && partialError.code === 'EXECUTOR_IDENTITY_AMBIGUOUS') throw partialError;
          partial = null;
        }
        if (partial !== null && plannerEquivalentCandidate(host, partial, executionWorkspace, originWorkspace, caller)) {
          stuck.push({ host, executor: partial.executor, executionWorkspace: partial.executionWorkspace });
        }
        continue;
      }
      throw error;
    }
    if (plannerEquivalentCandidate(host, resolved, executionWorkspace, originWorkspace, caller)) {
      stuck.push({ host, executor: resolved.executor, executionWorkspace: resolved.executionWorkspace });
    }
  }
  if (stuck.length === 0) return NOT_NEEDED;
  if (stuck.length > 1) throw ambiguousChild();
  const candidate = stuck[0];
  const executor = candidate.executor;
  // An exact stop tuple is UNCONSTRUCTIBLE for an epoch-less executor record
  // (pre-lifecycle compat flow with no session record): recovery fails closed
  // instead of ever falling back to a Hook-shaped non-exact tuple.
  if (typeof executor.ownerLifecycleEpoch !== 'string' || typeof executor.ownerLifecycleEpochStartedAt !== 'string') {
    throw evidenceUnavailable('The Rescue child recovery could not prove its authorization epoch.');
  }

  const bindingLookup = () => store.resolveRescueBindingForResume({
    workspace: candidate.executionWorkspace,
    parentSessionId: caller.sessionId,
    executorAgentId: executor.agentId,
    executorAgentPath: candidate.host.agentPath,
    executorAgentType: executor.agentType,
    executorParentTurnId: executor.parentTurnId,
    executorParentPermissionMode: executor.parentPermissionMode,
    permissionMode: caller.permissionMode,
  });
  const bindingWindow = stageWindow();
  const resolvedBinding = await ranStage(bindingWindow, bindingLookup,
    (error) => {
      if (isInterruption(error)) throw error;
      // Match the planner: every binding-resolution failure surfaces as the
      // canonical RESCUE_BINDING_INVALID, with the original failure attached.
      throw invalidRescueBinding(error);
    },
    (error) => evidenceUnavailable(BUDGET_EVIDENCE_MESSAGE, error));
  const binding = resolvedBinding?.binding;
  const job = resolvedBinding?.currentJob;
  if (resolvedBinding?.kind !== 'bound' || binding?.state !== 'active' || job === undefined || job === null) return NOT_NEEDED;
  // The planner never joins the executor tuple, binding, and job; an exact
  // identity or epoch mismatch between them is corruption or succession, and
  // the spec's rule for a changed parent epoch or identity is that the old
  // recovery is invalidated — a superseded caller, never a recovery write.
  if (job.id !== binding.currentJobId || job.command !== 'rescue' || job.readOnly !== false
    || job.ownerSessionId !== caller.sessionId || job.workspace !== candidate.executionWorkspace
    || !validHostLifecycleRecord(job) || job.ownerLifecycleEpoch !== executor.ownerLifecycleEpoch) {
    throw recoverySuperseded('The Rescue child recovery join no longer matches the captured executor, binding, and job identities.');
  }
  const capturedBinding = {
    operationId: binding.operationId,
    currentJobId: binding.currentJobId,
    updatedAt: binding.updatedAt,
    permissionMode: binding.permissionMode,
  };
  // The caller authority this recovery's stop writes are authorized under:
  // the preparing turn's SubagentStart generation, its permission mode, and
  // the Host lifecycle epoch the executor tuple was authorized under. The
  // spec's succession rule is that a new generation, changed permission, or
  // changed parent epoch invalidates the old recovery.
  const capturedAuthority = {
    generationId: caller.generationId ?? null,
    permissionMode: caller.permissionMode,
    epoch: executor.ownerLifecycleEpoch,
  };
  const validateCallerAuthority = async () => {
    let authority;
    try { authority = await dependencies.resolveCallerAuthority(); }
    catch (error) {
      if (isInterruption(error)) throw error;
      // Fail closed: an authority that cannot be re-resolved no longer proves
      // the captured request owns the parent turn.
      throw recoverySuperseded('The caller authority could not be re-resolved during recovery; the captured request no longer proves its turn.', error);
    }
    if (authority?.generationId !== capturedAuthority.generationId
      || authority?.permissionMode !== capturedAuthority.permissionMode
      || authority?.epoch !== capturedAuthority.epoch) {
      throw recoverySuperseded('The caller authority was superseded during recovery; the captured request no longer owns the parent turn.');
    }
  };
  /** Read the captured binding's raw partition record, or null when the partition cannot be read. */
  const readCapturedBindingRecord = async () => {
    try {
      const storage = await resolveWorkspaceStorage({ dataRoot: input.dataRoot, workspace: candidate.executionWorkspace });
      const expected = { parentSessionId: caller.sessionId, workspace: storage.workspacePath };
      const partition = await readRescueBindingPartitionFile(storage.directory, join(storage.directory, `rescue-binding-session-${rescueBindingPartitionKey(expected)}.json`), expected);
      return partition.records.find((/** @type {any} */ record) => record.key === binding.key) ?? null;
    } catch { return null; }
  };

  input.signal?.throwIfAborted();
  const firstWindow = stageWindow();
  const firstProof = await ranStage(firstWindow,
    () => dependencies.readChildTurnEvidence(executor.agentId, caller.sessionId, executor.childTurnId, firstWindow),
    // Any genuine rejection from the evidence adapter means "not proven terminal".
    (error) => evidenceUnavailable(undefined, error),
    (error) => evidenceUnavailable(BUDGET_EVIDENCE_MESSAGE, error));
  if (!proofMatchesBinding(firstProof, candidate.host, executor.agentType, originWorkspace)) {
    throw evidenceUnavailable('Codex child evidence did not match the expected Rescue binding.');
  }

  // The caller authority is revalidated AFTER the first Host proof establishes
  // terminal evidence and BEFORE any business mutation: a superseded caller
  // must never persist a stop intent or stop the remote session. The
  // settlement guard knows the job and the binding, not the preparing caller.
  // (Local durable reads only — the two-Host-read bound is untouched — and the
  // check stays in `validateCurrency` for the pre-stop-write stages.)
  const authorityWindow = stageWindow();
  await ranStage(authorityWindow, validateCallerAuthority,
    (error) => error,
    (error) => recoveryPending(BUDGET_PENDING_MESSAGE, error));

  const receiptWindow = stageWindow();
  // The genuine receipt-read fail-safe — an unreadable receipt grants no
  // session-end authority (fail-safe to 'older') — stays INSIDE the operation,
  // so the stage's bounded budget error surfaces as the documented outcome and
  // is never converted into a fabricated no-receipt path.
  const receipt = await ranStage(receiptWindow,
    () => dependencies.readReceipt(executor.ownerLifecycleEpoch).catch(() => null),
    (error) => error,
    (error) => evidenceUnavailable(BUDGET_EVIDENCE_MESSAGE, error));
  const receiptMatched = receipt !== null;
  input.signal?.throwIfAborted();
  const settlementWindow = stageWindow();
  const settlement = await ranStage(settlementWindow,
    () => dependencies.settleOwnedJob({
      store,
      dataRoot: input.dataRoot,
      workspace: candidate.executionWorkspace,
      ownerSessionId: caller.sessionId,
      epoch: job.ownerLifecycleEpoch,
      hostPlacement: job.hostPlacement ?? null,
      receiptMatched,
      signal: settlementWindow.signal,
      timeoutMs: settlementWindow.timeoutMs,
      createClient: dependencies.createClient,
    }, job.id),
    (error) => {
      if (error instanceof PluginError && error.code === 'LOCK_TIMEOUT') {
        throw recoveryPending('The Rescue child job settlement could not take its state lock inside the shared budget; continuation stays blocked.', error);
      }
      return error;
    },
    (error) => recoveryPending(BUDGET_PENDING_MESSAGE, error));
  if (!TERMINAL_SETTLEMENT_KINDS.has(settlement?.kind)) {
    throw recoveryPending('The Rescue child job settlement remains unresolved; continuation stays blocked.');
  }
  const winnerReadWindow = stageWindow();
  const winner = await ranStage(winnerReadWindow, () => store.readJob(candidate.executionWorkspace, job.id, winnerReadWindow),
    (error) => error,
    (error) => recoveryPending(BUDGET_PENDING_MESSAGE, error));
  if (!TERMINAL.has(winner.status) || winner.rescueExecutionReservation !== undefined) {
    throw recoveryPending('The settled Rescue job retains outstanding execution obligations; continuation stays blocked.');
  }

  input.signal?.throwIfAborted();
  const secondWindow = stageWindow();
  const secondProof = await ranStage(secondWindow,
    () => dependencies.readChildTurnEvidence(executor.agentId, caller.sessionId, executor.childTurnId, secondWindow),
    (error) => recoveryPending('The second Host observation could not re-prove the terminal child turn.', error),
    (error) => recoveryPending(BUDGET_PENDING_MESSAGE, error));
  if (!proofMatchesBinding(secondProof, candidate.host, executor.agentType, originWorkspace)) {
    throw evidenceUnavailable('Codex child evidence did not match the expected Rescue binding.');
  }
  if (secondProof.observedTurnId !== firstProof.observedTurnId || secondProof.terminalStatus !== firstProof.terminalStatus) {
    // Defense-in-depth: the evidence adapter's contract guarantees the latest
    // returned turn always correlates exactly with the expected turn id, so
    // this drift is not producible by the real adapter on a fixed expected
    // tuple — it is here so a seam contract violation can never stop a tuple
    // that a successor may already own.
    throw recoverySuperseded('A newer Rescue child observation no longer matches the captured terminal evidence.');
  }

  // The currency callback runs outside every Hook file lock (and explicitly
  // before the first one) and re-reads ONLY local durable state: the binding
  // must still pin the captured operation, job, permission, and update stamp.
  // A proven advance is a published successor (terminal); an unreadable
  // binding is uncertainty and stays retryable.
  const validateCurrency = async () => {
    input.signal?.throwIfAborted();
    // The CURRENT caller authority is re-resolved from the durable identity
    // and host-lifecycle records at every currency slot (and explicitly before
    // the stop-state settlement): a parent that advanced to another turn or
    // re-authorized under a different permission — or a session whose lifecycle
    // epoch was replaced — supersedes the captured request before any stop
    // write is published.
    const callerWindow = stageWindow();
    await ranStage(callerWindow, validateCallerAuthority,
      (error) => error,
      (error) => recoveryPending(BUDGET_PENDING_MESSAGE, error));
    // The raw partition record distinguishes a PROVEN value change (a changed
    // permission or job the strict lookup would only report as a rejection)
    // from an unreadable partition, which stays retryable uncertainty.
    const recordWindow = stageWindow();
    const record = await ranStage(recordWindow, readCapturedBindingRecord,
      () => null,
      () => recoveryPending(BUDGET_PENDING_MESSAGE));
    if (record !== null && (record.operationId !== capturedBinding.operationId
      || record.currentJobId !== capturedBinding.currentJobId
      || record.permissionMode !== capturedBinding.permissionMode)) {
      throw recoverySuperseded('The Rescue binding advanced to another operation during recovery.');
    }
    const currencyWindow = stageWindow();
    const current = await ranStage(currencyWindow, bindingLookup,
      (error) => {
        if (isInterruption(error)) throw error;
        // A currency revalidation that cannot even read the binding is uncertainty,
        // never a proven advance: it stays retryable for the same tuple.
        throw recoveryPending('The Rescue binding could not be revalidated during recovery.', error);
      },
      (error) => recoveryPending(BUDGET_PENDING_MESSAGE, error));
    const currentBinding = current?.binding;
    if (current?.kind !== 'bound' || currentBinding?.state !== 'active'
      || currentBinding.operationId !== capturedBinding.operationId
      || currentBinding.currentJobId !== capturedBinding.currentJobId
      || currentBinding.updatedAt !== capturedBinding.updatedAt
      || currentBinding.permissionMode !== capturedBinding.permissionMode) {
      throw recoverySuperseded('The Rescue binding advanced to another operation during recovery.');
    }
  };
  await validateCurrency();
  const stopWindow = stageWindow();
  const stopped = await ranStage(stopWindow,
    () => dependencies.settleForwardingStop({
      dataRoot: input.dataRoot,
      sessionId: executor.parentSessionId,
      childTurnId: executor.childTurnId,
      agentId: executor.agentId,
      agentType: executor.agentType,
      originWorkspace: executor.originWorkspace,
      parentGenerationId: executor.parentGenerationId,
      parentTurnId: executor.parentTurnId,
      parentPermissionMode: executor.parentPermissionMode,
      targetWorkspace: executor.workspace,
      createdAt: executor.createdAt,
      ownerLifecycleEpoch: executor.ownerLifecycleEpoch,
      ownerLifecycleEpochStartedAt: executor.ownerLifecycleEpochStartedAt,
      signal: stopWindow.signal,
      timeoutMs: stopWindow.timeoutMs,
    }, validateCurrency),
    (error) => {
      if (error instanceof PluginError && error.code === 'LOCK_TIMEOUT') {
        throw recoveryPending('The Rescue child stop settlement could not take its hook-state lock inside the shared budget; a retry may finish the same tuple.', error);
      }
      return error;
    },
    (error) => recoveryPending(BUDGET_PENDING_MESSAGE, error));
  if (stopped?.outcome === 'superseded') {
    throw recoverySuperseded('A successor owns the Rescue child records; recovery must not continue.');
  }
  if (stopped?.outcome !== 'reconciled') {
    throw recoveryPending('The Rescue child stop settlement stayed partial; a retry may finish the same tuple.');
  }
  return { kind: 'reconciled', executionWorkspace: candidate.executionWorkspace };
}

const ABORTED = Symbol('recovery-budget-aborted');

/**
 * Whether one Host child proof matches the exact binding identity: agent path,
 * role, and cwd equality with the captured planner candidate — the comparison
 * the evidence adapter deliberately leaves to its caller.
 * @param {any} proof @param {any} host @param {string} agentType @param {string} originWorkspace
 */
function proofMatchesBinding(proof, host, agentType, originWorkspace) {
  const expectedRole = agentType === 'zcode-rescue' ? 'zcode-rescue' : null;
  return proof?.child?.agentPath === host.agentPath && proof?.child?.agentRole === expectedRole
    && proof?.child?.cwd === originWorkspace;
}

/**
 * Strict input validation for the recovery request. The caller/envelope core
 * is the planner's own shared validator; this adds only the recovery-specific
 * signal, app-server, and dependency seams.
 * @param {any} input
 */
function validateRecoveryInput(input) {
  if (!validRescueSelectionRequest(input)
    || input.appServerOptions !== undefined && !plain(input.appServerOptions)
    || input.signal !== undefined && !(typeof AbortSignal === 'function' && input.signal instanceof AbortSignal)
    || input.dependencies !== undefined && !plain(input.dependencies)
    || input.dependencies !== undefined && Object.keys(input.dependencies).some((key) => !DEPENDENCY_KEYS.includes(key))
    || input.dependencies !== undefined && input.dependencies.store !== undefined && !plain(input.dependencies.store)
    || input.dependencies !== undefined && DEPENDENCY_KEYS.filter((key) => key !== 'store')
      .some((key) => input.dependencies[key] !== undefined && typeof input.dependencies[key] !== 'function')) {
    throw new PluginError('RESCUE_ROUTE_INVALID', 'The Rescue route directive is invalid.', {
      category: 'validation', remedy: 'Prepare the Rescue request again.',
    });
  }
}

const DEPENDENCY_KEYS = Object.freeze([
  'store', 'now', 'listChildren', 'readChildTurnEvidence', 'resolveActiveExecutor', 'resolvePartialExecutor',
  'resolveCallerAuthority', 'settleOwnedJob', 'settleForwardingStop', 'createClient', 'readReceipt',
]);

/**
 * Encapsulate the production dependencies: the real StateStore, the real Host
 * discovery and evidence adapters, the real conditional stop primitive, the
 * real business settlement adapter, and the existing-broker-only control
 * client that can never launch ZCode.
 * @param {any} input
 */
function resolvedDependencies(input) {
  const injected = input.dependencies ?? {};
  const caller = input.caller;
  const store = injected.store ?? createStateStore({ dataRoot: input.dataRoot });
  const appServerOptions = input.appServerOptions ?? {};
  return {
    store,
    now: injected.now ?? Date.now,
    listChildren: injected.listChildren ?? ((/** @type {string} */ parentId, /** @type {{signal?:AbortSignal}} */ window) =>
      listCodexThreadSpawnChildren(parentId, { ...appServerOptions, ...(window?.signal === undefined ? {} : { signal: window.signal }) })),
    readChildTurnEvidence: injected.readChildTurnEvidence ?? ((/** @type {string} */ childId, /** @type {string} */ parentId, /** @type {string} */ expectedTurnId, /** @type {any} */ window) =>
      readCodexRescueChildTurnEvidence(childId, parentId, expectedTurnId, { ...appServerOptions, ...(window?.signal === undefined ? {} : { signal: window.signal }) })),
    resolveActiveExecutor: injected.resolveActiveExecutor ?? ((/** @type {string} */ dataRoot, /** @type {string} */ ambientWorkspace, /** @type {string} */ agentId, /** @type {{signal?:AbortSignal,timeoutMs?:number}|undefined} */ window) =>
      resolveRoutedForwardingExecutor(dataRoot, ambientWorkspace, agentId, window)),
    resolvePartialExecutor: injected.resolvePartialExecutor ?? ((/** @type {string} */ dataRoot, /** @type {string} */ ambientWorkspace, /** @type {string} */ agentId, /** @type {{signal?:AbortSignal,timeoutMs?:number}|undefined} */ window) =>
      resolvePartiallyStoppedForwardingExecutor(dataRoot, ambientWorkspace, agentId, window)),
    resolveCallerAuthority: injected.resolveCallerAuthority ?? (async () => {
      // The active-turn and generation lookup uses the SAME workspace the
      // prepare caller itself resolved (the invocation cwd, persisted as
      // `caller.workspace`), while SessionStart/Host-lifecycle records live in
      // the session's ORIGIN workspace — the workspace the child's executor
      // epoch pair was derived from — so a linked-worktree caller reads its
      // epoch evidence there.
      const resolved = await createIdentityStore({ dataRoot: input.dataRoot })
        .resolveActiveTurn({ sessionId: caller.sessionId, workspace: caller.workspace, workspaceBinding: 'claim' });
      const sessionRecord = await resolveRecordedSessionStart(input.dataRoot, caller.originWorkspace ?? caller.workspace, caller.sessionId);
      return {
        generationId: resolved.generationId ?? null,
        permissionMode: resolved.permissionMode,
        epoch: hostLifecycleEpoch(caller.sessionId, sessionRecord.startedAt),
      };
    }),
    settleOwnedJob: injected.settleOwnedJob ?? settleRescueChildOwnedJob,
    settleForwardingStop: injected.settleForwardingStop ?? settleExactForwardingStop,
    createClient: injected.createClient ?? ((/** @type {any} */ owned, /** @type {string} */ ownerId) =>
      createExistingManagedZCodeClient({ dataRoot: input.dataRoot, workspace: owned.workspace, ownerId, requestTimeoutMs: EXISTING_BROKER_REQUEST_TIMEOUT_MS })),
    readReceipt: injected.readReceipt ?? ((/** @type {string} */ epoch) => createHostLifecycleStore({ dataRoot: input.dataRoot }).readReceipt(epoch)),
  };
}

const BUDGET_EVIDENCE_MESSAGE = 'The bounded Rescue child recovery budget expired before exact Host evidence could be proven.';
const BUDGET_PENDING_MESSAGE = 'The bounded Rescue child recovery budget expired before settlement could be proven.';

function discoveryFailed() {
  return new PluginError('CODEX_CHILD_DISCOVERY_FAILED', 'Codex persisted child discovery failed.', {
    category: 'runtime', remedy: 'Restart or upgrade Codex, then retry the Rescue request.',
  });
}
function ambiguousChild() {
  return new PluginError('RESCUE_CHILD_AMBIGUOUS', 'The persisted Rescue child route is ambiguous.', {
    category: 'authorization', remedy: 'Resolve the conflicting child state before retrying Rescue.',
  });
}
/** @param {string} [message] @param {unknown} [cause] */
function evidenceUnavailable(message = 'Codex could not serve exact terminal-turn evidence for the Rescue child.', cause = undefined) {
  return new PluginError('RESCUE_CHILD_EVIDENCE_UNAVAILABLE', message, {
    category: 'protocol',
    remedy: 'Treat the Rescue child as not proven terminal and do not recover without exact Host evidence.',
    ...(cause === undefined ? {} : { cause }),
  });
}
/** @param {string} message @param {unknown} [cause] */
function recoveryPending(message, cause = undefined) {
  return new PluginError('RESCUE_CHILD_RECOVERY_PENDING', message, {
    category: 'state',
    remedy: 'Retry the Rescue request; the bounded recovery will finish or keep blocking until settlement is proven.',
    ...(cause === undefined ? {} : { cause }),
  });
}
/** @param {string} message @param {unknown} [cause] */
function recoverySuperseded(message, cause = undefined) {
  return new PluginError('RESCUE_CHILD_RECOVERY_SUPERSEDED', message, {
    category: 'authorization',
    remedy: 'Start a fresh Rescue operation from the active parent turn.',
    ...(cause === undefined ? {} : { cause }),
  });
}
/** The planner's canonical binding error, with the original failure attached. @param {unknown} cause */
function invalidRescueBinding(cause) {
  return new PluginError('RESCUE_BINDING_INVALID', 'The private Rescue operation binding is invalid.', {
    category: 'authorization', remedy: 'Start a fresh Rescue operation from the active parent turn.',
    cause,
  });
}

/** @param {unknown} error */
function isInterruption(error) {
  return error instanceof PluginError && error.code === 'JOB_INTERRUPTED' && error.category === 'interruption';
}

/** @param {unknown} value */
function plain(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

const RECOVERY_BUDGET_MS = 5_000;
const EXISTING_BROKER_REQUEST_TIMEOUT_MS = process.platform === 'win32' ? 500 : 250;
const TERMINAL_SETTLEMENT_KINDS = new Set(['durable-completion', 'confirmed-cancellation', 'terminal']);
/** @type {{kind:'not-needed'}} */
const NOT_NEEDED = { kind: 'not-needed' };
// A probe observation that proves the child's records are NOT stuck active —
// already stopped, absent, mid-settlement by a concurrent writer, or otherwise
// not an active route — means recovery has nothing to do: the planner's own
// stopped-executor validation owns the caller's error from there. Ambiguity,
// corrupt identity, expiry, and unapproved roles are never skipped; they
// propagate untouched.
const SKIP_EXECUTOR_CODES = new Set(['EXECUTOR_IDENTITY_NOT_FOUND']);
// The stuck-active probe rejects with these codes BOTH for foreign states and
// for THIS recovery's own prior partial pass (its origin stage wrote the
// stopped route and died before deactivating the executor), so each of them
// triggers the exact partial-tuple revalidation before the child is skipped.
const PARTIAL_TRIGGER_CODES = new Set(['EXECUTOR_STATE_MISMATCH', 'EXECUTOR_ROUTE_INVALID', 'EXECUTOR_ROUTE_NOT_FOUND']);
