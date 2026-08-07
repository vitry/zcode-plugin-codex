import process from 'node:process';

import { PluginError } from '../../scripts/lib/errors.mjs';
import { readInternalEnvelope } from '../../scripts/zcode-companion.mjs';

const controller = new AbortController();
const interruption = new PluginError('JOB_INTERRUPTED', 'reader interrupted');
const reading = readInternalEnvelope(3, { signal: controller.signal });
setImmediate(() => controller.abort(interruption));
try {
  await reading;
  throw new Error('read unexpectedly completed');
} catch (error) {
  if (error !== interruption) throw error;
  process.stdout.write('rejected-original\n');
}
