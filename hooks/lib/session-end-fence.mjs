// @ts-nocheck
/**
 * SessionEnd's final obligation-discharge fence (the hook's stage 5b).
 *
 * The fence re-scans the ending session's obligations right before the broker
 * owner release and discharges everything the stage-(5) reconcile raced: first
 * the durable stop-intent delegation, then — for a record that still carries
 * the exact marked-runner claim (a bare terminal status, or a late `cancelling`
 * guard whose stop intent is only stop AUTHORITY for the duty, never cleanup
 * proof) — one bounded re-run of the local settlement duty. Every state touch
 * draws a bounded slice of the ONE shared
 * absolute hook deadline, the loop STOPS once that deadline is spent (an
 * unprocessed obligation keeps its workspace release-unsafe and the receipt
 * pending for the next pass), and no per-obligation settlement deadline is
 * ever minted beyond the shared bound, so any number of late job records can
 * never push the hook past its native three-second limit. On WINDOWS this
 * fence (and every SessionEnd settlement stage) is deliberately fail-fast:
 * one cold process-table sweep alone can exceed the whole three-second hook
 * budget, so a Windows pass retains the durable stop evidence, defers, and
 * leaves the receipt pending — the non-hook reconcile path
 * (`$zcode:status <job> --wait`, whose marked-runner duty runs at
 * WINDOWS_RUNNER_DUTY_FALLBACK_MS with no native hook limit) is the Windows
 * convergence driver that finishes what a deferred hook pass retained. The
 * discovery/delegation/settlement primitives are injectable so tests can pin
 * the budget contract directly (the same reason the budget arithmetic lives in
 * ./session-end-budget.mjs).
 */
import { delegateEndedStopIntent, discoverSessionEndObligations, endedObligationSettled, isMarkedRunnerClaim, settleEndedRescueJob } from '../../scripts/lib/recovery.mjs';

/** Per-obligation cap every fence state touch draws from the shared hook deadline. */
const fenceSliceCapMs = 250;

/** The bounded fence slice: min(cap, deadline − now), floored at 1ms so an
 * AbortSignal is always armed for the state touch that is about to run.
 * @param {() => number} now @param {number} hookDeadline */
function fenceSlice(now, hookDeadline) {
  return Math.max(1, Math.min(fenceSliceCapMs, hookDeadline - now()));
}

/**
 * Run the final obligation-discharge fence against the shared hook deadline.
 *
 * Returns `{ clean, deferredWorkspaces }` on a completed scan (clean only when
 * every late obligation discharged) and `{ clean: false, deferredWorkspaces,
 * failedScan: true, error }` when the scan ITSELF failed: a failed scan cannot
 * name the workspace it could not prove, so EVERY known workspace defers.
 * @param {{store:any,dataRoot:string,knownWorkspaces:readonly string[],ownerSessionId:string,epoch:string|null,endedAt:string|null,hookDeadline:number,createClient:(workspace:string)=>any,discover?:any,delegate?:any,settle?:any,now?:() => number}} input
 * @returns {Promise<{clean:boolean,deferredWorkspaces:Set<string>,failedScan?:boolean,error?:any}>}
 */
export async function runSessionEndDischargeFence(input) {
  const now = input.now ?? Date.now;
  const slice = () => fenceSlice(now, input.hookDeadline);
  let late;
  try {
    late = await (input.discover ?? discoverSessionEndObligations)({
      store: input.store, dataRoot: input.dataRoot, knownWorkspaces: input.knownWorkspaces, ownerSessionId: input.ownerSessionId,
      epoch: input.epoch, endedAt: input.endedAt,
      signal: AbortSignal.timeout(slice()), timeoutMs: slice(),
    });
  } catch (error) {
    // A FAILED final scan (lock contention, corruption, or the fence slice's
    // own timeout) cannot name the workspace it could not prove — the affected
    // workspace is unknown — so EVERY known workspace is release-unsafe for
    // this pass. This is deliberately distinct from a clean EMPTY scan (no
    // obligations found): that is a success, and releases proceed.
    return { clean: false, deferredWorkspaces: new Set(input.knownWorkspaces), failedScan: true, error };
  }
  let clean = true;
  const deferredWorkspaces = new Set();
  for (let index = 0; index < late.length; index += 1) {
    const obligation = late[index];
    // The shared deadline is the fence's ONLY hard stop: once it is spent, no
    // further obligation is processed — each would otherwise mint a fresh
    // 1ms signal and settlement deadline past the hook's native limit, so any
    // number of late job records could push the SessionEnd hook past its
    // budget. Every unprocessed obligation keeps its workspace release-unsafe
    // for this pass (nothing is released behind unproven durable state), and
    // the unclean fence leaves the receipt pending as the next pass's
    // compensation authority.
    if (input.hookDeadline - now() <= 0) {
      clean = false;
      for (const unprocessed of late.slice(index)) deferredWorkspaces.add(unprocessed.workspace);
      break;
    }
    try {
      const delegated = await (input.delegate ?? delegateEndedStopIntent)({
        store: input.store, dataRoot: input.dataRoot, workspace: obligation.workspace, ownerSessionId: input.ownerSessionId,
        epoch: input.epoch, endedAt: input.endedAt,
        signal: AbortSignal.timeout(slice()), timeoutMs: slice(),
      }, obligation.job.id);
      // Delegation is only discharge evidence when the job actually reached
      // cancelling (with the exact intent) or a terminal: a QUEUED job is
      // returned unchanged, and settlement must stay pending for it.
      // A durably-stopped MARKED runner claim is the one exception: the
      // cancelling guard (or bare terminal status) only delegates stop
      // authority to the local cleanup duty — it does NOT prove the detached
      // runner tree was terminated, and ADR 0021 forbids releasing the broker
      // owner while that tree may still be alive. So the claim must either
      // execute its settlement duty below or, when the shared budget cannot
      // afford the duty, keep its workspace release-unsafe for this pass
      // (a terminal marked claim already fails endedObligationSettled above
      // and reaches the duty unchanged). The claim identity tested here is
      // the recovery duty's own exported condition (isMarkedRunnerClaim).
      const durablyStopped = endedObligationSettled({ kind: null, job: delegated });
      if (durablyStopped && !isMarkedRunnerClaim(delegated)) continue;
      // Delegation itself draws from the shared deadline, so RECHECK it before
      // scheduling any settlement: once spent, the 1ms fence-slice floor would
      // otherwise mint a fresh signal and settlement deadline past the hook's
      // native limit (filesystem operations are not guaranteed to abort at the
      // signal), so the unproven obligation instead keeps its workspace
      // release-unsafe and the receipt pending for the next pass.
      if (input.hookDeadline - now() <= 0) {
        clean = false;
        deferredWorkspaces.add(obligation.workspace);
        continue;
      }
      // A record that still carries the exact marked-runner claim — TERMINAL,
      // or a late `cancelling` guard that delegation just durably stopped —
      // is never discharged by its bare status: the record alone cannot prove
      // the local cleanup converged (the guard only delegates stop authority
      // to the duty). Under the settlement invariant the sweep duty itself is
      // the retry authority, so the fence re-runs the bounded local duty once
      // for the exact claim and only a duty whose descendant sweep completed
      // clean lets the receipt settle; a duty that cannot finish inside the
      // fence slice keeps the receipt pending AND the workspace release-unsafe
      // for the next pass. Unmarked unsettled records (queued, running
      // without the intent) settle through the same bounded call.
      if (!obligation.readOnly) {
        const fenceSliceMs = slice();
        const settled = await (input.settle ?? settleEndedRescueJob)({
          store: input.store, dataRoot: input.dataRoot, workspace: obligation.workspace, ownerSessionId: input.ownerSessionId,
          epoch: input.epoch, endedAt: input.endedAt,
          // Clamped to the shared bound: a sub-millisecond remainder must
          // never round up into a settlement deadline beyond the hook's own
          // deadline (Date.now() + slice could pass it by up to the 1ms
          // floor above).
          deadlineMs: Math.min(input.hookDeadline, now() + fenceSliceMs), lockTimeoutMs: 0, timeoutMs: fenceSliceMs,
          signal: AbortSignal.timeout(fenceSliceMs),
          includeSettlementEvidence: true, createClient: input.createClient(obligation.workspace),
        }, obligation.job.id);
        if (endedObligationSettled(settled)) continue;
      }
      clean = false;
      deferredWorkspaces.add(obligation.workspace);
    } catch { clean = false; deferredWorkspaces.add(obligation.workspace); }
  }
  return { clean, deferredWorkspaces };
}
