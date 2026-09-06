import { RECEIPT_ABORT_BUDGET_MS, RECEIPT_SCAN_ABORT_BUDGET_MS, createHostLifecycleStore as createProductionHostLifecycleStore } from '../../scripts/lib/host-lifecycle.mjs';
import { scaleTestTimeout } from './test-timeouts.mjs';

/** @returns {number} */
export const scaledAbortBudget = () => scaleTestTimeout(RECEIPT_ABORT_BUDGET_MS);

/**
 * The ceiling-scan budget gets an extra factor beyond the suite multiplier:
 * a ceiling-scale scan reads every receipt file sequentially, and shared
 * Windows runners (Defender-scanned, cold caches, parallel load) have been
 * observed to exceed even the production budget scaled by the multiplier
 * alone. Only the upper abort bound grows — deadline-behavior tests pin
 * their exact bounds explicitly and are unaffected.
 * @returns {number}
 */
export const scaledScanBudget = () => scaleTestTimeout(RECEIPT_SCAN_ABORT_BUDGET_MS) * 2;

/**
 * Creates a Host lifecycle store with continuous-integration-tolerant
 * receipt budgets by default: every store in a suite driving real receipt
 * filesystem work through fixture data roots inherits the scaled
 * per-operation and ceiling-scan budgets, because a single
 * publish/settle/prune routinely exceeds the production 500 ms bound on a
 * loaded runner. A test that deliberately exercises exact deadline behavior
 * passes its exact production or lowered bound through the same
 * testOnlyAbortBudgetMs/testOnlyScanBudgetMs options, which always win.
 * @param {{ dataRoot: string, now?: () => string, testOnlyAfterStorageValidation?: () => void|Promise<void>, testOnlyReceiptsDirectoryMaxEntries?: number, testOnlyAbortBudgetMs?: number, testOnlyScanBudgetMs?: number }} options
 */
export function createHostLifecycleStore(options) {
  return createProductionHostLifecycleStore({
    ...options,
    ...(options.testOnlyAbortBudgetMs === undefined ? { testOnlyAbortBudgetMs: scaledAbortBudget() } : {}),
    ...(options.testOnlyScanBudgetMs === undefined ? { testOnlyScanBudgetMs: scaledScanBudget() } : {}),
  });
}
