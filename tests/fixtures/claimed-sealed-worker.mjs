import { writeFile } from 'node:fs/promises';

import { acknowledgeBackgroundStartup } from '../../scripts/lib/background-worker.mjs';
import { readInternalEnvelope, runCompanion } from '../../scripts/zcode-companion.mjs';

const command = process.argv[2]; const jobId = process.argv[3]; const marker = process.env.ZCODE_TEST_CLAIM_MARKER;
if (command !== 'run-reserved-job' || !jobId || !marker) throw new Error('claimed worker fixture input is missing');
const authorization = await readInternalEnvelope(3); let acknowledged = false;
const acknowledge = async () => { if (acknowledged) return; acknowledged = true; await acknowledgeBackgroundStartup(); };
await runCompanion(['run-reserved-job', jobId], {
  authorization,
  startupAck: acknowledge,
  dependencies: { testOnlyAfterExecutionClaim: async () => {
    await writeFile(marker, `${JSON.stringify({ pid: process.pid, jobId })}\n`, { mode: 0o600 });
    await acknowledge();
    await new Promise(() => { setInterval(() => {}, 1_000); });
  } },
});
