#!/usr/bin/env node
// @ts-nocheck
import { writeInternalResponse } from '../../scripts/zcode-companion.mjs';

const mode = process.argv[2];
try {
  await writeInternalResponse({ payload: 'x'.repeat(900_000) }, 4, { timeoutMs: mode === 'slow-read' ? 1_000 : 100 });
  process.stdout.write('ok\n');
} catch (error) {
  process.stdout.write(`${error?.code ?? 'unknown'}\n`);
}
