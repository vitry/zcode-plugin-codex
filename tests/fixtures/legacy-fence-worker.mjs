import { readFile, writeFile } from 'node:fs/promises';

import { createStateStore } from '../../scripts/lib/state.mjs';
import { readInternalEnvelope, runCompanion } from '../../scripts/zcode-companion.mjs';

const command = process.argv[2]; const jobId = process.argv[3];
const { ZCODE_TEST_DATA_ROOT: dataRoot, ZCODE_TEST_FENCE_REACHED: reached,
  ZCODE_TEST_FENCE_RELEASE: release } = process.env;
if (command !== 'run-reserved-job' || !jobId || !dataRoot) throw new Error('legacy fence worker fixture input is missing');

const authorization = await readInternalEnvelope(3);
const store = createStateStore({ dataRoot });
const gated = !reached || !release ? store : {
  ...store,
  claimJobWorkerForExecution: async (/** @type {string} */ workspace, /** @type {string} */ id,
    /** @type {any} */ worker, /** @type {any} */ rollback, /** @type {any} */ execution,
    /** @type {string} */ inspection) => {
    await writeFile(reached, `${JSON.stringify({ pid: process.pid, jobId: id, workerLeaseId: worker.workerLeaseId })}\n`, { mode: 0o600 });
    while (await readFile(release, 'utf8').catch(() => '') !== 'release\n') {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return store.claimJobWorkerForExecution(workspace, id, worker, rollback, execution, inspection);
  },
};

await runCompanion(['run-reserved-job', jobId], {
  authorization,
  dependencies: { createStateStore: () => gated },
});
