import { writeFile } from 'node:fs/promises';

import { createStateStore } from '../../scripts/lib/state.mjs';
import { readInternalEnvelope, runCompanion } from '../../scripts/zcode-companion.mjs';

const command = process.argv[2]; const jobId = process.argv[3];
const { ZCODE_TEST_DATA_ROOT: dataRoot, ZCODE_TEST_CLAIM_MARKER: marker } = process.env;
if (command !== 'run-reserved-job' || !jobId || !dataRoot || !marker) {
  throw new Error('ambiguous claim worker fixture input is missing');
}
const authorization = await readInternalEnvelope(3);
let stage = 'startup';
const persisted = createStateStore({ dataRoot, testOnlyExecutionClaimWriteOptions: {
  testOnlyAfterRename: async () => {
    stage = 'post-rename';
    await writeFile(marker, `${JSON.stringify({ pid: process.pid, jobId })}\n`, { mode: 0o600 });
    throw new Error('injected post-rename execution claim failure');
  },
} });
const unreadable = {
  ...persisted,
  bindJobExecutionReservationLease: async (/** @type {string} */ workspace, /** @type {string} */ id, /** @type {any} */ input) => {
    stage = 'binding-lease'; const result = await persisted.bindJobExecutionReservationLease(workspace, id, input);
    stage = 'lease-bound'; return result;
  },
  claimJobWorkerForExecution: async (/** @type {string} */ workspace, /** @type {string} */ id,
    /** @type {any} */ worker, /** @type {any} */ rollback, /** @type {any} */ execution,
    /** @type {string} */ inspection) => {
    stage = 'claiming'; return persisted.claimJobWorkerForExecution(workspace, id, worker, rollback, execution, inspection);
  },
  finishJobAfterExecutionClaimFailure: async () => {
    throw new Error('injected unreadable ambiguous reconciliation');
  },
};
try {
  await runCompanion(['run-reserved-job', jobId], {
    authorization,
    dependencies: { createStateStore: () => unreadable },
  });
} catch (error) {
  await writeFile(marker, `${JSON.stringify({
    pid: process.pid, jobId, error: error instanceof Error ? error.message : String(error),
    code: error && typeof error === 'object' ? /** @type {any} */ (error).code : undefined, stage,
  })}\n`, { mode: 0o600 });
  throw error;
}
