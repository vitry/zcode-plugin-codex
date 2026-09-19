// @ts-nocheck
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import test from 'node:test';

const optInEnabled = process.env.ZCODE_CODEX_MCP_E2E === '1';
const optInSkip = optInEnabled ? false : 'opt-in required: set ZCODE_CODEX_MCP_E2E=1 to assert a real MCP probe result.';

const THREAD_CANDIDATES = ['envelopeThreadId', 'innerSessionId', 'innerThreadId'];
const ROOT_THREAD_AUTHORITIES = ['appServerThreadId', 'hookSessionId'];
const CHILD_THREAD_AUTHORITIES = ['appServerThreadId', 'hookSessionId', 'hookAgentId', 'returnedChildHandle'];
const TURN_AUTHORITIES = ['appServerTurnId', 'hookTurnId'];
const LIFECYCLE_CASES = ['appServerTurnInterrupt', 'cliSigint', 'cliSigkill', 'directConfigToolTimeout', 'pluginToolTimeout'];

const OBSERVATION_ENUMS = {
  hostProcess: /^(running|exited-clean|exited-signal|not-observed|unknown)$/,
  turnTerminalStatus: /^(completed|interrupted|failed|pending|not-observed|unknown)$/,
  toolCallOutcome: /^(completed|failed|timed-out|pending|not-observed|unknown)$/,
  handlerSettlement: /^(signal-abort|transport-close|completed|pending|server-exited|not-observed|unknown)$/,
  transportState: /^(open|stdin-eof|closed|server-exited|not-observed|unknown)$/,
  hookEvent: /^(stop|session-end|none|not-observed|unknown)$/,
  unknownReason: /^(none|ceiling-reached|host-omitted-event|process-exited-first|unsupported)$/,
};

test('the real-Host MCP probe result qualifies context and characterizes lifecycle', { skip: optInSkip, timeout: 60_000 }, async () => {
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
  // The obsolete all-true artifact (eight flat booleans) must never pass.
  if (!result || typeof result !== 'object' || Array.isArray(result)
    || Object.keys(result).length !== 2
    || !Object.hasOwn(result, 'context') || !Object.hasOwn(result, 'lifecycle')) {
    throw new Error('MCP probe result uses the obsolete all-true schema');
  }
  const { context, lifecycle } = result;
  assert.deepEqual(Object.keys(context).sort(), ['assertions', 'authorityFields', 'equalityMatrix']);
  assert.deepEqual(context.assertions, {
    identityFieldsVisible: true,
    identityNamespaceQualified: true,
    laterTurnDistinct: true,
    concurrentChildrenDistinct: true,
    metadataChangesAcrossTurns: true,
    serverLoadedWithConfig: true,
  });
  assert.match(context.authorityFields.rootThread, /^_meta\./);
  assert.match(context.authorityFields.childThread, /^_meta\./);
  assert.match(context.authorityFields.turn, /^_meta\./);
  const equalityKey = (scope, candidate, authority) => `${scope}:${candidate}==${authority}`;
  const expectedKeys = [
    ...THREAD_CANDIDATES.flatMap((candidate) => ROOT_THREAD_AUTHORITIES.map((authority) => equalityKey('root', candidate, authority))),
    ...THREAD_CANDIDATES.flatMap((candidate) => CHILD_THREAD_AUTHORITIES.map((authority) => equalityKey('child', candidate, authority))),
    ...TURN_AUTHORITIES.map((authority) => equalityKey('root', 'innerTurnId', authority)),
    ...TURN_AUTHORITIES.map((authority) => equalityKey('child', 'innerTurnId', authority)),
  ].sort();
  assert.deepEqual(Object.keys(context.equalityMatrix).sort(), expectedKeys);
  for (const value of Object.values(context.equalityMatrix)) assert.equal(typeof value, 'boolean');
  assert.deepEqual(Object.keys(lifecycle).sort(), [...LIFECYCLE_CASES].sort());
  for (const observation of Object.values(lifecycle)) {
    for (const [field, pattern] of Object.entries(OBSERVATION_ENUMS)) {
      assert.match(observation[field], pattern, `${field} must use the closed observation vocabulary`);
    }
  }
  if (process.platform !== 'win32') {
    const { lstat } = await import('node:fs/promises');
    assert.equal((await lstat(resultPath)).mode & 0o777, 0o600);
  }
});
