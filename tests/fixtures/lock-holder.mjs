// @ts-nocheck
import process from 'node:process';

import { withFileLock } from '../../scripts/lib/fs.mjs';

const lockPath = process.argv[2];
if (!lockPath) throw new Error('lock path required');

try {
  await withFileLock(lockPath, async () => {
    process.stdout.write('acquired\n');
    await new Promise((resolve) => process.stdin.once('data', resolve));
  }, { pollIntervalMs: 5, timeoutMs: 1_000 });
  process.stdout.write('released\n');
} catch (error) {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exitCode = 1;
}
