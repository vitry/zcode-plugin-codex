import { writeFile } from 'node:fs/promises';

import { runCompanion } from '../../scripts/zcode-companion.mjs';

const { ZCODE_TEST_DATA_ROOT: dataRoot, ZCODE_TEST_WORKSPACE: workspace, ZCODE_TEST_MARKER: marker,
  ZCODE_TEST_OWNER: ownerSessionId, ZCODE_TEST_TASK: task } = process.env;
if (!dataRoot || !workspace || !marker || !ownerSessionId || !task) throw new Error('publication crash fixture input is missing');

await runCompanion(['rescue', '--background', '--fresh', task], {
  cwd: workspace,
  env: process.env,
  caller: { sessionId: ownerSessionId, turnId: 'publication-crash-turn', workspace, permissionMode: 'workspace-write' },
  dependencies: { testOnlyAfterJobSpecCommitment: async (/** @type {any} */ job) => {
    await writeFile(marker, `${JSON.stringify({ pid: process.pid, jobId: job.id })}\n`, { mode: 0o600 });
    await new Promise(() => { setInterval(() => {}, 1_000); });
  } },
});
