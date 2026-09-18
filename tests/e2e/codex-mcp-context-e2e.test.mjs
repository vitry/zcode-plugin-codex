// @ts-nocheck
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import test from 'node:test';

const RESULT_KEYS = [
  'cancelDelivered', 'concurrentChildrenDistinct', 'connectionLossDelivered',
  'laterTurnDistinct', 'metadataChangesAcrossTurns', 'rootIdentityComplete',
  'serverLoadedWithConfig', 'shortTimeoutSettled',
];

const optInEnabled = process.env.ZCODE_CODEX_MCP_E2E === '1';
const optInSkip = optInEnabled ? false : 'opt-in required: set ZCODE_CODEX_MCP_E2E=1 to assert a real MCP probe result.';

test('the real-Host MCP probe result is the closed all-true boolean record', { skip: optInSkip, timeout: 60_000 }, async () => {
  const resultPath = process.env.ZCODE_MCP_PROBE_RESULT;
  let bytes;
  try {
    if (!resultPath) throw Object.assign(new Error('MCP probe result is unavailable'), { code: 'ENOENT' });
    await stat(resultPath);
    bytes = await readFile(resultPath, 'utf8');
  } catch {
    throw new Error('MCP probe result is unavailable');
  }
  let result;
  try { result = JSON.parse(bytes); } catch {
    throw new Error('MCP probe result is unavailable');
  }
  assert.equal(typeof result, 'object');
  assert.notEqual(result, null);
  assert.deepEqual(Object.keys(result).sort(), RESULT_KEYS);
  for (const value of Object.values(result)) {
    assert.equal(typeof value, 'boolean');
    assert.equal(value, true);
  }
  if (process.platform !== 'win32') {
    const { lstat } = await import('node:fs/promises');
    assert.equal((await lstat(resultPath)).mode & 0o777, 0o600);
  }
});
