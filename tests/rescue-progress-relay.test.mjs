import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_RESCUE_RELAY_BYTES,
  MAX_RESCUE_RELAY_SEQUENCE,
  RESCUE_RELAY_MESSAGES,
  RESCUE_RELAY_PREFIX,
  parseRescueProgressRelay,
  serializeRescueProgressRelay,
} from '../scripts/lib/rescue-progress-relay.mjs';

const observedAt = '2026-08-17T00:00:00.000Z';

test('relay records contain fixed coarse facts only', () => {
  const line = serializeRescueProgressRelay({ sequence: 1, phase: 'investigating', code: 'tool-active', observedAt });
  assert.equal(line, `${RESCUE_RELAY_PREFIX}{"version":1,"sequence":1,"phase":"investigating","code":"tool-active","observedAt":"${observedAt}"}\n`);
  assert.deepEqual(parseRescueProgressRelay(line), {
    version: 1, sequence: 1, phase: 'investigating', code: 'tool-active', observedAt,
  });
  assert.equal(RESCUE_RELAY_MESSAGES['tool-active'], 'ZCode is working with a tool.');
  assert.throws(() => parseRescueProgressRelay(line.replace(/}\n$/, ',"message":"PRIVATE"}\n')));
});

test('parser accepts one complete bounded line and returns a fresh exact-shape object', () => {
  const line = serializeRescueProgressRelay({ sequence: MAX_RESCUE_RELAY_SEQUENCE, phase: 'waiting', code: 'waiting', observedAt });
  const first = parseRescueProgressRelay(line);
  const second = parseRescueProgressRelay(line);
  assert.notEqual(first, second);
  first.phase = 'starting';
  assert.equal(second.phase, 'waiting');
  for (const candidate of [line.slice(0, -1), `${line}\n`, `${line}${line}`, `noise${line}`, `${RESCUE_RELAY_PREFIX}{}`]) {
    assert.throws(() => parseRescueProgressRelay(candidate));
  }
  assert.ok(Buffer.byteLength(line) <= MAX_RESCUE_RELAY_BYTES);
});

test('relay wire rejects unknown keys, mismatched pairs, unsafe bounds, and private exception text', () => {
  const valid = { sequence: 1, phase: 'starting', code: 'started', observedAt };
  const invalid = [
    { ...valid, version: 1 },
    { ...valid, message: 'PRIVATE' },
    { ...valid, sequence: 0 },
    { ...valid, sequence: MAX_RESCUE_RELAY_SEQUENCE + 1 },
    { ...valid, sequence: 1.5 },
    { ...valid, phase: 'running', code: 'tool-active' },
    { ...valid, phase: 'PRIVATE', code: 'started' },
    { ...valid, observedAt: '2026-08-17' },
  ];
  for (const value of invalid) {
    let caught;
    try { serializeRescueProgressRelay(value); } catch (error) { caught = error; }
    assert.ok(caught instanceof Error);
    assert.doesNotMatch(caught.message, /PRIVATE/);
  }
  const huge = `${RESCUE_RELAY_PREFIX}${' '.repeat(MAX_RESCUE_RELAY_BYTES)}\n`;
  assert.throws(() => parseRescueProgressRelay(huge));
});

test('all fixed phase and code pairs map to companion-owned messages', () => {
  const pairs = [
    ['starting', 'started', 'ZCode Rescue started.'],
    ['running', 'model-active', 'ZCode is generating a response.'],
    ['investigating', 'tool-active', 'ZCode is working with a tool.'],
    ['editing', 'editing', 'ZCode is applying workspace changes.'],
    ['verifying', 'verifying', 'ZCode is verifying the work.'],
    ['waiting', 'waiting', 'ZCode Rescue is still running.'],
    ['finalizing', 'finalizing', 'ZCode Rescue is finalizing.'],
  ];
  assert.deepEqual(Object.entries(RESCUE_RELAY_MESSAGES), pairs.map(([, code, message]) => [code, message]));
  for (const [phase, code] of pairs) {
    assert.equal(parseRescueProgressRelay(serializeRescueProgressRelay({ sequence: 1, phase, code, observedAt })).phase, phase);
  }
});
