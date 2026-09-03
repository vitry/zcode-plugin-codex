#!/usr/bin/env node
// @ts-nocheck
import process from 'node:process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createIdentityStore } from '../scripts/lib/identity.mjs';
import { createRescuePreparationStore } from '../scripts/lib/rescue-preparation.mjs';
import { ownerIdForSession } from '../scripts/lib/job-control.mjs';
import { resolvePluginDataRoot } from '../scripts/lib/plugin-data.mjs';
import { createHostLifecycleStore } from '../scripts/lib/host-lifecycle.mjs';
import { activeForeignEpochWorkspaces, delegateEndedStopIntent, discoverSessionEndObligations, endedObligationSettled, settleEndedReadOnlyDetachedJob, settleEndedRescueJob } from '../scripts/lib/recovery.mjs';
import { createStateStore, isJobNotFound } from '../scripts/lib/state.mjs';
import { withFileLock } from '../scripts/lib/fs.mjs';
import { resolveWorkspaceStorage } from '../scripts/lib/workspace.mjs';
import { createExistingManagedZCodeClient, releaseManagedZCodeOwner } from '../scripts/lib/zcode-client.mjs';
import { cleanupSession, resolveRecordedSessionStart } from './lib/hook-state.mjs';
import { readHookInput } from './lib/hook-input.mjs';

const existingBrokerRequestTimeoutMs = process.platform === 'win32' ? 500 : 250;
const ownerReleaseRequestTimeoutMs = process.platform === 'win32' ? 1_000 : 500;
const ownerReleaseMaximumBudgetMs = 1_800;
// The whole hook runs under one shared deadline that keeps a hard margin before
// the native three-second SessionEnd limit. Every stage below draws from this
// single budget: its per-stage cap is min(cap, remaining), so the phase budgets
// (500 + 600 + 1750 + 1400 + 500 = 4750ms) never sum against the deadline; the
// deadline is the only hard stop, leaving >= 250ms before the native limit.
const sessionEndBudgetMs = 2_750;
const receiptPublicationBudgetMs = 500;
const identityCleanupBudgetMs = 600;
const remoteSettlementBudgetMs = 1_750;
const ownerReleaseBudgetMs = 1_400;
const receiptSettlementBudgetMs = 500;

const hookDeadline = Date.now() + sessionEndBudgetMs;

// One derived signal per stage: the caller's budget plus the shared global
// deadline. A stage that would exceed the deadline fails immediately instead of
// running past the native hook limit.
function stageSignal(budgetMs) {
  const remaining = hookDeadline - Date.now();
  const budget = Math.max(0, Math.min(budgetMs, remaining));
  return AbortSignal.timeout(budget);
}
function budgetExhausted() {
  return hookDeadline - Date.now() <= 0;
}

try {
  const input = await readHookInput('SessionEnd');
  const dataRoot = resolvePluginDataRoot({ env: process.env, pluginRoot: resolve(fileURLToPath(new URL('../', import.meta.url))) });
  const ownerSessionId = input.session_id;
  const ownerId = ownerIdForSession(ownerSessionId);
  const store = createStateStore({ dataRoot });
  const lifecycle = createHostLifecycleStore({ dataRoot });

  // (1)-(2) Persist the epoch-scoped SessionEnd receipt as the FIRST durable
  // mutation, before any contended identity cleanup, broker release, worker
  // termination, or remote control. The epoch is derived only from a proven
  // SessionStart record; an absent record is not an error, it simply means there
  // is no authoritative epoch to publish and the legacy settle path still runs.
  let sessionStartedAt = null;
  try {
    sessionStartedAt = (await resolveRecordedSessionStart(dataRoot, input.cwd, ownerSessionId)).startedAt;
  } catch (error) {
    if (!isMissingSessionRecord(error)) throw error;
  }
  let receipt = null;
  if (sessionStartedAt !== null) {
    receipt = await lifecycle.publishSessionEnd({
      sessionId: ownerSessionId,
      sessionStartedAt,
      endedAt: new Date().toISOString(),
      origin: 'session-end-hook',
      workspaceHints: [input.cwd],
    }, { signal: stageSignal(receiptPublicationBudgetMs) });
  }

  // (3) Enumerate the session's complete workspace scope NON-destructively —
  // identity state is only tombstoned at stage (9), AFTER every obligation is
  // durably delegated, so a crash between the two never loses linked-workspace
  // coverage: the pending receipt's scope decision and the delegated stop intents
  // both outlive the kill.
  const identityScope = await boundedSessionScope(dataRoot, input.cwd, ownerSessionId, sessionStartedAt);
  const identityScopeComplete = identityScope.status === 'complete' || identityScope.status === 'legacy';
  const knownWorkspaces = identityScope.knownWorkspaces;
  // Persist the enumerated scope into the receipt's durable workspace hints right
  // away: if this run later stays pending (or is killed mid-flow), the compensation
  // reader re-enumerates the full linked-workspace scope from the receipt itself —
  // not just the ambient cwd — before the stage (9) tombstone can reset the ledger.
  // The durable hints ARE the scope evidence a later reconciliation reads: if
  // this merge fails, the complete workspace list must not be treated as
  // persisted, and the destructive identity cleanup defers below.
  let hintsPersisted = true;
  if (receipt !== null && identityScopeComplete) {
    try {
      // Adopt the merged record's CAS token: the stage-(8) settlement must present
      // the receipt's CURRENT updatedAt, not the pre-merge stage-(1) one.
      const merged = await lifecycle.publishSessionEnd({
        sessionId: ownerSessionId, sessionStartedAt: /** @type {string} */ (sessionStartedAt),
        endedAt: receipt.endedAt, origin: receipt.origin, workspaceHints: knownWorkspaces,
      }, { signal: stageSignal(receiptPublicationBudgetMs) });
      if (merged) receipt = merged;
    } catch (error) {
      hintsPersisted = false;
      process.stderr.write(`ZCode SessionEnd receipt scope hints merge deferred: ${error?.code ?? 'UNKNOWN'}\n`);
    }
  }

  const remoteController = new AbortController();
  const remoteTimer = setTimeout(() => remoteController.abort(new Error('SessionEnd remote cleanup reached its deadline.')), remoteRemainingBudget());
  remoteTimer.unref?.();
  let obligations = [];
  let allDelegated = true;
  // Owner release is deferred per workspace whenever durable state does not prove
  // it safe: an unenumerable identity scope, a foreign active-epoch job (post-resume
  // turn with a live owner), a retained writable Rescue guard, or any broker-stage
  // reconcile failure. This mirrors the pre-receipt ownerReleaseSafe rule so an
  // unacknowledged stop or a post-resume turn is never retried/stopped behind durable
  // state via a second owner-release `session/stop`.
  const releaseUnsafeWorkspaces = new Set();
  if (!identityScopeComplete) {
    // Without the enumerated workspace scope, settling could drop linked obligations
    // and releasing any owner could stop a post-resume run: leave the receipt pending
    // and defer every broker owner release; only attempt best-effort cwd settlement.
    allDelegated = false;
    for (const workspace of knownWorkspaces) releaseUnsafeWorkspaces.add(workspace);
  }
  try {
    // (4) Discover this epoch's writable Rescue obligations across the known
    // workspaces under a bounded lock budget. An unproven epoch (no receipt)
    // disables the epoch filter so the legacy settle path is preserved exactly.
    obligations = await discoverSessionEndObligations({
      store, dataRoot, knownWorkspaces, ownerSessionId,
      epoch: receipt?.epoch ?? null, endedAt: receipt?.endedAt ?? null,
      signal: remoteController.signal,
      timeoutMs: remoteRemainingBudget(),
    });
    // (5) Reconcile stop(session-end) per obligation in bounded parallelism, using
    // only an existing broker; a never-lazily-spawned client is the sole remote
    // dependency. Writable Rescue obligations settle through the Reconciler; active
    // read-only detached runs settle through the existing recovery primitives and a
    // recorded-worker-tree termination, never the writable binding interface.
    const createClient = (workspace) => (job, derivedOwnerId) => createExistingManagedZCodeClient({
      dataRoot, workspace, ownerId: derivedOwnerId, requestTimeoutMs: existingBrokerRequestTimeoutMs,
    });
    await runBounded(obligations, 2, async (obligation) => {
      try {
        const outcome = obligation.readOnly
          ? await settleEndedReadOnlyDetachedJob({
            store, dataRoot, workspace: obligation.workspace, ownerSessionId,
            epoch: receipt?.epoch ?? null, endedAt: receipt?.endedAt ?? null,
            deadlineMs: hookDeadline,
            lockTimeoutMs: 0, requestTimeoutMs: existingBrokerRequestTimeoutMs,
            timeoutMs: remoteRemainingBudget(), signal: remoteController.signal,
            includeSettlementEvidence: true, createClient: createClient(obligation.workspace),
          }, obligation.job.id)
          : await settleEndedRescueJob({
            store, dataRoot, workspace: obligation.workspace, ownerSessionId,
            epoch: receipt?.epoch ?? null, endedAt: receipt?.endedAt ?? null,
            lockTimeoutMs: 0, requestTimeoutMs: existingBrokerRequestTimeoutMs,
            timeoutMs: remoteRemainingBudget(),
            signal: remoteController.signal, includeSettlementEvidence: true,
            createClient: createClient(obligation.workspace),
          }, obligation.job.id);
        if (outcome.kind === 'retained-writable-guard') releaseUnsafeWorkspaces.add(obligation.workspace);
        if (!endedObligationSettled(outcome)) throw new Error('obligation not settled');
      } catch {
        // A reconcile/broker failure leaves durable state uncertain: defer owner
        // release for this workspace and try to durably delegate to a retained
        // exact session-end stop intent — never claim a stopped terminal.
        releaseUnsafeWorkspaces.add(obligation.workspace);
        if (!obligation.readOnly && !remoteController.signal.aborted && !budgetExhausted()) {
          try {
            await delegateEndedStopIntent({
              store, dataRoot, workspace: obligation.workspace, ownerSessionId,
              epoch: receipt?.epoch ?? null, endedAt: receipt?.endedAt ?? null,
              signal: remoteController.signal, timeoutMs: remoteRemainingBudget(),
            }, obligation.job.id);
          } catch { /* delegation is best-effort; the pending receipt remains authority */ }
        }
        const reread = { discharged: false };
        try {
          const job = await store.readJob(obligation.workspace, obligation.job.id, { signal: remoteController.signal, timeoutMs: remoteRemainingBudget() });
          reread.discharged = endedObligationSettled({ kind: null, job });
        } catch (error) {
          // Only a PROVEN missing job discharges the obligation; corruption, a
          // permission/unsafe read, or a lock-contention failure must keep it pending.
          reread.discharged = isJobNotFound(error);
        }
        if (!reread.discharged) allDelegated = false;
      }
      if (remoteController.signal.aborted) allDelegated = false;
    }, () => remoteController.signal.aborted || budgetExhausted());
    // (6) A workspace still hosting an ACTIVE job from a different (newer) epoch
    // keeps its broker owner: releasing this ending owner would stop the post-resume
    // turn, which this old receipt has no authority over. Discovery already saw these
    // jobs (it enumerates then filters by epoch), so reuse that visibility.
    if (identityScopeComplete) {
      const foreignWorkspaces = await activeForeignEpochWorkspaces({
        store, knownWorkspaces, ownerSessionId,
        epoch: receipt?.epoch ?? null, endedAt: receipt?.endedAt ?? null,
        signal: remoteController.signal, timeoutMs: remoteRemainingBudget(),
      });
      for (const workspace of foreignWorkspaces) releaseUnsafeWorkspaces.add(workspace);
    }
    await runBounded(knownWorkspaces.filter((workspace) => !releaseUnsafeWorkspaces.has(workspace)), 2, async (workspace) => {
      if (remoteController.signal.aborted || budgetExhausted()) return;
      try {
        const storage = await resolveWorkspaceStorage({ dataRoot, workspace });
        // FENCE: the foreign-epoch check and this release run under the same
        // job-state lock every reservation takes, so a concurrent resume's new
        // job (same session-derived owner id!) cannot be published between the
        // check and the release — the release re-verifies durably, then runs,
        // while any post-resume reservation waits for the lock and starts its
        // own broker session only after this owner is gone.
        await withFileLock(join(storage.directory, '.state.lock'), async () => {
          if (identityScopeComplete) {
            // The re-check is purely local: it gets its own fresh small budget
            // rather than the remote-stage signal, whose expiry would abort the
            // listing and conservatively (but wrongly) defer every release.
            const localSignal = AbortSignal.timeout(Math.max(1, Math.min(250, hookDeadline - Date.now())));
            const foreignNow = await activeForeignEpochWorkspaces({
              store, knownWorkspaces: [workspace], ownerSessionId, lockFree: true,
              epoch: receipt?.epoch ?? null, endedAt: receipt?.endedAt ?? null,
              signal: localSignal, timeoutMs: Math.min(250, Math.max(1, hookDeadline - Date.now())),
            });
            if (foreignNow.size > 0) return;
          }
          await releaseManagedZCodeOwner({
            dataRoot, workspace, ownerId,
            requestTimeoutMs: Math.min(ownerReleaseRequestTimeoutMs, ownerRemainingBudget()),
            cleanupBudgetMs: Math.min(ownerReleaseMaximumBudgetMs, ownerRemainingBudget()),
          });
        }, { signal: AbortSignal.timeout(Math.max(1, hookDeadline - Date.now())), timeoutMs: Math.min(ownerReleaseMaximumBudgetMs, Math.max(1, hookDeadline - Date.now())) });
      } catch (error) {
        const statusCounts = error?.details?.identityStatusCounts; const reasonCounts = error?.details?.identityReasonCounts;
        process.stderr.write(`ZCode SessionEnd broker owner release deferred: ${error?.code ?? 'UNKNOWN'}:${JSON.stringify({ statusCounts: statusCounts ?? {}, reasonCounts: reasonCounts ?? {} })}\n`);
      }
    }, () => remoteController.signal.aborted || budgetExhausted());
  } catch (error) {
    // A discovery-stage failure leaves durable state uncertain: leave the receipt
    // pending as the compensation authority and skip owner release (the release
    // loop above only runs on the non-throwing path), never claiming a stopped
    // terminal. A sanitized stage/code distinguishes a durable guard from an
    // unavailable broker cleanup.
    process.stderr.write(`ZCode SessionEnd owner cleanup deferred: ${error?.code ?? 'UNKNOWN'}\n`);
    allDelegated = false;
  } finally { clearTimeout(remoteTimer); }

  // (8) Settle the receipt only when every exact obligation is terminal or durably
  // delegated; otherwise leave it pending as the durable compensation authority.
  // Pending receipts are consumed by the Task 6 prompt-time reconciliation
  // (UserPromptSubmit retries matching pending receipts through
  // lifecycle.listPendingReceipts/readReceipt before new Rescue work — design
  // 'Resume after SessionEnd'), so an unsettled boundary is never orphaned.
  if (receipt !== null && allDelegated) {
    try {
      await lifecycle.settleReceipt(receipt.epoch, receipt.updatedAt, { signal: stageSignal(receiptSettlementBudgetMs) });
    } catch (error) {
      process.stderr.write(`ZCode SessionEnd receipt settlement deferred: ${error?.code ?? 'UNKNOWN'}\n`);
    }
  }

  // (9) Generic identity, preparation, and hook-state cleanup with remaining budget.
  // Every remaining lock waits no longer than the shared deadline (the native
  // three-second limit is never exceeded by an unbounded default lock wait).
  // The destructive identity cleanup runs LAST by design: the scope enumeration
  // (stage 3) and the durable delegation (stages 4-8) have already outlived it.
  // It is called against the ambient origin workspace, which owns the global
  // session ledger; the cleanup itself sweeps every known workspace's identity
  // storage. Contention or failure here is an advisory deferral, never a boundary
  // failure — the settled/pending receipt already records the shutdown decision.
  // When the workspace scope was never proven (enumeration contention that may
  // clear later), the destructive identity cleanup must NOT run: discovery and
  // receipt hints only covered the ambient cwd, and tombstoning the ledger here
  // would erase the linked-workspace evidence a later reconciliation needs.
  if (receipt !== null && (!identityScopeComplete || !hintsPersisted)) {
    process.stderr.write(`ZCode SessionEnd identity cleanup deferred: ${hintsPersisted ? 'SCOPE_UNPROVEN' : 'HINTS_UNPERSISTED'}\n`);
  } else {
    try {
      await createIdentityStore({ dataRoot }).cleanupSession(input.cwd, ownerSessionId, {
        signal: AbortSignal.timeout(Math.max(1, hookDeadline - Date.now())),
        timeoutMs: Math.min(identityCleanupBudgetMs, Math.max(1, hookDeadline - Date.now())),
        ...(sessionStartedAt === null ? {} : { sessionStartedAt }),
        ...(receipt === null ? {} : { endedAt: receipt.endedAt }),
      });
    } catch (error) {
      // IDENTITY_SESSION_SCOPE_SUCCESSOR is an expected deferral when a resume
      // reinstalled the ledger between enumeration and cleanup: the successor's
      // identity state must survive this boundary.
      process.stderr.write(`ZCode SessionEnd identity cleanup deferred: ${error?.code ?? 'UNKNOWN'}\n`);
    }
  }
  await runBounded(knownWorkspaces, 4, async (workspace) => {
    const remaining = () => Math.max(0, hookDeadline - Date.now());
    const finalSignal = () => AbortSignal.timeout(Math.max(1, remaining()));
    await Promise.allSettled([
      // Both generic cleanups carry the ending boundary: a resumed successor
      // reusing this session id must keep its own records.
      cleanupSession(dataRoot, workspace, ownerSessionId, { signal: finalSignal(), timeoutMs: Math.min(500, Math.max(1, remaining())), ...(receipt === null ? {} : { endedAt: receipt.endedAt }) }),
      createRescuePreparationStore({ dataRoot }).cleanupSession({ sessionId: ownerSessionId, workspace }, { signal: finalSignal(), timeoutMs: Math.min(500, Math.max(1, remaining())), ...(receipt === null ? {} : { endedAt: receipt.endedAt }) }),
    ]);
  });
} catch (error) {
  process.stderr.write(`ZCode session cleanup advisory failed: ${error?.code ?? 'HOOK_FAILED'}\n`);
  process.exitCode = 1;
}

function remoteRemainingBudget() {
  return Math.max(0, Math.min(remoteSettlementBudgetMs, hookDeadline - Date.now()));
}
function ownerRemainingBudget() {
  return Math.max(0, Math.min(ownerReleaseBudgetMs, hookDeadline - Date.now()));
}

// Returns { status, knownWorkspaces } where status is 'complete' (the durable
// identity ledger enumerated the full workspace scope), 'legacy' (no global
// identity state existed, so the ambient cwd is the whole scope), or 'unknown'
// (the lifecycle lock was contended, cleanup failed, or a SUCCESSOR epoch's
// ledger was installed — a resume reusing this session id — so the scope, which
// may include linked Worktrees, could not be proven for THIS epoch).
async function boundedSessionScope(dataRoot, workspace, sessionId, sessionStartedAt) {
  // Read-only scope enumeration under a bounded sub-budget: the ledger read
  // itself never mutates, and an unreachable ledger fails to 'unknown' so the
  // caller leaves the receipt pending and defers owner release — the destructive
  // identity cleanup is deferred to stage (9) instead.
  const stageBudgetMs = Math.max(0, Math.min(identityCleanupBudgetMs, hookDeadline - Date.now()));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('SessionEnd identity scope enumeration reached its deadline.')), stageBudgetMs);
  timer.unref?.();
  try {
    const result = await raceControl(Promise.resolve().then(() => createIdentityStore({ dataRoot }).sessionWorkspaces(workspace, sessionId)), controller.signal);
    if (result === null) return { status: 'legacy', knownWorkspaces: [workspace] };
    // A successor epoch's ledger must never widen this boundary's scope: its
    // knownWorkspaces belong to the resumed session, so treat the scope as
    // unprovable — the receipt stays pending and the successor's identity state
    // is left entirely alone (stage (9)'s cleanup re-proves the epoch).
    if (result.sessionStartedAt !== null && sessionStartedAt !== null && result.sessionStartedAt !== sessionStartedAt) {
      process.stderr.write('ZCode SessionEnd identity scope superseded by a newer epoch\n');
      return { status: 'unknown', knownWorkspaces: [workspace] };
    }
    return { status: 'complete', knownWorkspaces: result.knownWorkspaces };
  } catch (error) {
    process.stderr.write(`ZCode SessionEnd identity scope enumeration deferred: ${error?.code ?? 'UNKNOWN'}\n`);
    return { status: 'unknown', knownWorkspaces: [workspace] };
  } finally { clearTimeout(timer); }
}

/** Race one operation against its abort signal; the abandoned operation's late rejection is absorbed. @param {Promise<any>} operation @param {AbortSignal} signal */
function raceControl(operation, signal) {
  operation.catch(() => {});
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    if (signal.aborted) { onAbort(); return; }
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then((value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
      (error) => { signal.removeEventListener('abort', onAbort); reject(error); });
  });
}

// A missing/unproven SessionStart record surfaces as SETUP_SESSION_UNPROVEN whose
// cause is the underlying ENOENT; only that absence is recoverable here, so a
// genuinely corrupt record still fails closed.
function isMissingSessionRecord(error) {
  return error?.code === 'SETUP_SESSION_UNPROVEN' && (error?.cause?.code === 'ENOENT' || error?.cause?.cause?.code === 'ENOENT');
}

async function runBounded(values, concurrency, operation, isAborted = undefined) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (next < values.length) {
      // Once the shared deadline is spent, stop SCHEDULING remaining work:
      // every aborted settlement still costs setup and filesystem effort that
      // can push the hook past the native limit.
      if (isAborted?.()) break;
      const index = next; next += 1;
      await operation(values[index]);
    }
  }));
}
