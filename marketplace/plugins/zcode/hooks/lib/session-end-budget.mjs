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
 * deadline, never by the remote signal). The reserve is PLATFORM-SPLIT and
 * matches the termination helper's per-platform cap (see
 * scripts/lib/job-control.mjs runnerTerminationBudgetCapMs): POSIX terminates
 * with one in-process group dispatch (750ms), while Windows must launch
 * graceful + forced taskkill processes (0.1-1s each) — a 750ms reserve there
 * starves the kill into a no-op, so the Windows pass FAILS FAST to the
 * recorded-pid kill and the descendant sweep honestly defers to the next
 * bounded pass (the durable pending receipt is the compensation authority on
 * every platform). The total stays under the native three-second limit on both
 * platforms, and uncontended passes never wait for the reserve. The arithmetic
 * lives here (not inline in the hook script) so tests can pin it directly:
 * deleting the reserve term must fail the budget tests in
 * tests/session-end.test.mjs.
 */

/** Total SessionEnd hook budget in milliseconds; the deadline is the only hard stop. */
export const sessionEndBudgetMs = 2_750;
/** Per-stage cap of the remote settlement stage: min(this, hookDeadline − reserve − now). */
export const remoteSettlementBudgetMs = 1_750;
/** Milliseconds reserved inside the total budget for marked-runner local termination (POSIX). */
export const localTerminationReserveMs = 750;
/** Milliseconds reserved inside the total budget for marked-runner local termination (Windows). */
export const windowsLocalTerminationReserveMs = 1_500;

/**
 * The platform's local-termination reserve.
 * @param {string} [platform] defaults to the running platform
 * @returns {number}
 */
export function localTerminationReserveFor(platform = process.platform) {
  return platform === 'win32' ? windowsLocalTerminationReserveMs : localTerminationReserveMs;
}

/**
 * Remote-stage budget: min(remoteSettlementBudgetMs, hookDeadline − reserve − now),
 * clamped at zero, with the reserve split by platform. A stage timer armed with
 * this value fires no later than (hookDeadline − localTerminationReserve),
 * leaving exactly the reserve for the remaining local cleanup.
 * @param {number} hookDeadlineMs absolute shared hook deadline in epoch milliseconds
 * @param {number} nowMs current time in epoch milliseconds
 * @param {string} [platform] defaults to the running platform
 * @returns {number}
 */
export function remoteRemainingBudgetFor(hookDeadlineMs, nowMs, platform = process.platform) {
  return Math.max(0, Math.min(remoteSettlementBudgetMs, hookDeadlineMs - localTerminationReserveFor(platform) - nowMs));
}
