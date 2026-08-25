import { readFile, writeFile } from 'node:fs/promises';

import { createStateStore } from '../../scripts/lib/state.mjs';
import { readInternalEnvelope, runCompanion } from '../../scripts/zcode-companion.mjs';

const command = process.argv[2]; const jobId = process.argv[3];
const { ZCODE_TEST_DATA_ROOT: dataRoot, ZCODE_TEST_FENCE_REACHED: reached,
  ZCODE_TEST_FENCE_RELEASE: release, ZCODE_TEST_FENCE_STAGE: configuredStage = 'before-claim' } = process.env;
if (command !== 'run-reserved-job' || !jobId || !dataRoot) throw new Error('legacy fence worker fixture input is missing');

const authorization = await readInternalEnvelope(3);
const store = createStateStore({ dataRoot });
/** @param {string} stage @param {any} [evidence] */
async function gate(stage, evidence = {}) {
  if (!reached || !release || configuredStage !== stage) return;
  await writeFile(reached, `${JSON.stringify({ pid: process.pid, jobId, stage, ...evidence })}\n`, { mode: 0o600 });
  while (await readFile(release, 'utf8').catch(() => '') !== 'release\n') {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
const gated = configuredStage !== 'before-claim' || !reached || !release ? store : {
  ...store,
  claimJobWorkerForExecution: async (/** @type {string} */ workspace, /** @type {string} */ id,
    /** @type {any} */ worker, /** @type {any} */ rollback, /** @type {any} */ execution,
    /** @type {string} */ inspection) => {
    await gate('before-claim', { jobId: id, workerLeaseId: worker.workerLeaseId });
    return store.claimJobWorkerForExecution(workspace, id, worker, rollback, execution, inspection);
  },
};

await runCompanion(['run-reserved-job', jobId], {
  authorization,
  dependencies: {
    createStateStore: () => gated,
    testOnlyBeforeExecutionFence: (/** @type {any} */ evidence) => gate('before-fence', evidence),
    testOnlyAfterExecutionFence: (/** @type {any} */ evidence) => gate('after-fence', evidence),
  },
});
