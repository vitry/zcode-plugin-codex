// @ts-nocheck
/**
 * SessionEnd's shared budget constants and the remote-stage cap arithmetic.
 *
 * The whole hook runs under ONE shared deadline (sessionEndBudgetMs) that keeps
 * a hard margin before the native three-second SessionEnd limit; every stage's
 * per-stage cap is min(cap, remaining), so the phase budgets never sum against
 * the deadline — the deadline is the only hard stop.
 *
 * The marked-runner local-termination budget is RESERVED INSIDE that total:
 * the remote settlement stage caps at (hookDeadline − reserve), so a remote
 * timeout or unavailable abort can never starve the independent remaining local
 * cleanup budget (the cleanup helpers bound themselves by the absolute hook
 * deadline, never by the remote signal). The reserve matches the termination
 * helper's 750ms cap; the total stays under the native three-second limit, and
 * uncontended passes never wait for it. The arithmetic lives here (not inline
 * in the hook script) so tests can pin it directly: deleting the reserve term
 * must fail the budget tests in tests/session-end.test.mjs.
 */

/** Total SessionEnd hook budget in milliseconds; the deadline is the only hard stop. */
export const sessionEndBudgetMs = 2_750;
/** Per-stage cap of the remote settlement stage: min(this, hookDeadline − reserve − now). */
export const remoteSettlementBudgetMs = 1_750;
/** Milliseconds reserved inside the total budget for marked-runner local termination. */
export const localTerminationReserveMs = 750;

/**
 * Remote-stage budget: min(remoteSettlementBudgetMs, hookDeadline − reserve − now),
 * clamped at zero. A stage timer armed with this value fires no later than
 * (hookDeadline − localTerminationReserveMs), leaving exactly the reserve for
 * the remaining local cleanup.
 * @param {number} hookDeadlineMs absolute shared hook deadline in epoch milliseconds
 * @param {number} nowMs current time in epoch milliseconds
 * @returns {number}
 */
export function remoteRemainingBudgetFor(hookDeadlineMs, nowMs) {
  return Math.max(0, Math.min(remoteSettlementBudgetMs, hookDeadlineMs - localTerminationReserveMs - nowMs));
}
