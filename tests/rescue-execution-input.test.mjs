import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EFFORT_LEVELS,
  RESCUE_EXECUTION_INPUT_MAX_BYTES,
  RESCUE_EXECUTION_MODEL_MAX_BYTES,
  RESCUE_RUNNER_VERSION,
  validateRescueExecutionInput,
} from '../scripts/lib/rescue-execution-input.mjs';
import { RESCUE_TASK_MAX_BYTES } from '../scripts/lib/rescue-preparation.mjs';

test('runner input constants keep the bounded private execution envelope', () => {
  assert.equal(RESCUE_RUNNER_VERSION, 1);
  assert.equal(RESCUE_EXECUTION_INPUT_MAX_BYTES, 512 * 1024);
  assert.equal(RESCUE_EXECUTION_MODEL_MAX_BYTES, 4 * 1024);
  assert.deepEqual([...EFFORT_LEVELS], ['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);
  assert.equal(Object.isFrozen(EFFORT_LEVELS), true);
});

test('validateRescueExecutionInput returns a fresh exact copy of the closed schema', () => {
  assert.deepEqual(validateRescueExecutionInput({ version: 1, task: 'repair' }),
    { version: 1, task: 'repair' });
  assert.deepEqual(validateRescueExecutionInput({ version: 1, task: 'repair', model: 'gpt-5.3' }),
    { version: 1, task: 'repair', model: 'gpt-5.3' });
  assert.deepEqual(validateRescueExecutionInput({ version: 1, task: 'repair', effort: 'high' }),
    { version: 1, task: 'repair', effort: 'high' });
  assert.deepEqual(validateRescueExecutionInput({ effort: 'xhigh', model: 'm', version: 1, task: 't' }),
    { version: 1, task: 't', model: 'm', effort: 'xhigh' });
  for (const effort of EFFORT_LEVELS) {
    assert.deepEqual(validateRescueExecutionInput({ version: 1, task: 't', effort }),
      { version: 1, task: 't', effort });
  }
  // The returned copy never aliases the caller's objects.
  const requested = { version: 1, task: 'repair', model: 'gpt-5.3' };
  const validated = validateRescueExecutionInput(requested);
  assert.notEqual(validated, requested);
  validated.task = 'mutated';
  assert.equal(requested.task, 'repair');
});

test('validateRescueExecutionInput enforces the plan contract rejections', () => {
  for (const value of [null, [], { version: 2, task: 'repair' },
    { version: 1, task: ' ' }, { version: 1, task: 'repair', scope: 'auto' },
    { version: 1, task: 'x'.repeat(RESCUE_TASK_MAX_BYTES + 1) },
    { version: 1, task: 'repair', model: 'x'.repeat(4097) }]) {
    assert.throws(() => validateRescueExecutionInput(value));
  }
});

test('validateRescueExecutionInput rejects unknown keys, arrays, prototypes, and coercion', () => {
  const valid = { version: 1, task: 'repair' };
  for (const value of /** @type {any[]} */ ([
    undefined, 'repair', 1, true,
    { ...valid, extra: true },
    { ...valid, version: '1' },
    { ...valid, version: null },
    { task: 'repair' },
    { version: 1 },
    { ...valid, task: 5 },
    { ...valid, task: null },
    { ...valid, task: ['repair'] },
    { ...valid, task: '' },
    { ...valid, task: '\t\n ' },
    { ...valid, model: '' },
    { ...valid, model: '   ' },
    { ...valid, model: 7 },
    { ...valid, model: ['gpt-5.3'] },
    { ...valid, model: null },
    { ...valid, effort: 'maximum' },
    { ...valid, effort: 'HIGH' },
    { ...valid, effort: null },
    { ...valid, effort: 3 },
    Object.assign(Object.create({ inherited: true }), valid),
  ])) {
    assertInputRejected(value, JSON.stringify(value)?.slice(0, 80));
  }
});

/** @param {unknown} value @param {string} [message] */
function assertInputRejected(value, message) {
  let threw = false;
  try { validateRescueExecutionInput(value); } catch { threw = true; }
  assert.equal(threw, true, message);
}

test('validateRescueExecutionInput keeps the existing task and model validation conventions', () => {
  // Task keeps the exact existing 64 KiB UTF-8 bound, counting bytes not characters.
  assert.deepEqual(validateRescueExecutionInput({ version: 1, task: '€'.repeat(RESCUE_TASK_MAX_BYTES / 3) }),
    { version: 1, task: '€'.repeat(RESCUE_TASK_MAX_BYTES / 3) });
  assert.throws(() => validateRescueExecutionInput(
    { version: 1, task: '€'.repeat(RESCUE_TASK_MAX_BYTES / 3 + 1) },
  ));
  // Model follows the existing bounded plain-string conventions and rejects control characters.
  assert.deepEqual(validateRescueExecutionInput({ version: 1, task: 't', model: '€'.repeat(RESCUE_EXECUTION_MODEL_MAX_BYTES / 3) }),
    { version: 1, task: 't', model: '€'.repeat(RESCUE_EXECUTION_MODEL_MAX_BYTES / 3) });
  for (const model of ['gpt\u00005', 'gpt-5\u001f', 'gpt\u007f-5', 'gpt-5\u009f', 'x'.repeat(RESCUE_EXECUTION_MODEL_MAX_BYTES + 1)]) {
    assertInputRejected({ version: 1, task: 't', model }, JSON.stringify(model)?.slice(0, 40));
  }
});

test('validateRescueExecutionInput rejects accessor-backed fields and decides from one snapshot', () => {
  // A getter that shows validation a valid task and the returned copy a blank
  // one must never yield an accepted input that would be persisted as an
  // unreadable queued job.
  let reads = 0;
  const flipping = { version: 1 };
  Object.defineProperty(flipping, 'task', {
    configurable: true, enumerable: true,
    get() { reads += 1; return reads <= 2 ? 'repair' : ''; },
  });
  assertInputRejected(flipping, 'an accessor-backed task that flips between validation and the copy');
  assert.equal(reads <= 1, true, `the codec must decide from a single snapshot observation (observed ${reads} reads)`);
  // Own accessor descriptors are rejected outright even when they always
  // return the valid value.
  let stableReads = 0;
  const stable = { version: 1 };
  Object.defineProperty(stable, 'task', {
    configurable: true, enumerable: true,
    get() { stableReads += 1; return 'repair'; },
  });
  assertInputRejected(stable, 'an accessor-backed task that always returns a valid value');
  assert.equal(stableReads <= 1, true, `the accessor must be rejected from one snapshot (observed ${stableReads} reads)`);
  // A setter-only own property is equally an accessor descriptor.
  const setterOnly = { version: 1, task: 'repair' };
  Object.defineProperty(setterOnly, 'effort', { configurable: true, enumerable: true, set() {} });
  assertInputRejected(setterOnly, 'a setter-only own property');
});

test('validateRescueExecutionInput bounds unknown key names in error details', () => {
  const sensitive = 'SK-SECRET-9f41c2';
  const oversized = 'k'.repeat(64 * 1024);
  for (const key of [sensitive, `${sensitive}-${oversized}`]) {
    const thrown = /** @type {any} */ (rejectedExecutionInput({ version: 1, task: 'repair', [key]: 'value' }));
    assert.equal(thrown instanceof Error, true, 'the unknown key must be rejected');
    const serialized = JSON.stringify(thrown);
    assert.equal(serialized.includes(sensitive), false, 'the caller-controlled key text must never be echoed');
    assert.ok(Buffer.byteLength(serialized) <= 1024, 'the serialized error must stay bounded');
    assert.deepEqual(thrown.details.invalidFields, ['unknown']);
  }
  // Bounded output does not depend on the number of unknown keys either.
  const many = /** @type {Record<string, unknown>} */ ({ version: 1, task: 'repair' });
  for (let index = 0; index < 5_000; index += 1) many[`n${index}`] = index;
  const thrownForMany = /** @type {any} */ (rejectedExecutionInput(many));
  assert.equal(thrownForMany instanceof Error, true);
  assert.deepEqual(thrownForMany.details.invalidFields, ['unknown']);
  assert.ok(Buffer.byteLength(JSON.stringify(thrownForMany)) <= 1024);
});

/** @param {unknown} value @returns {unknown} the rejection thrown for the invalid value */
function rejectedExecutionInput(value) {
  try { validateRescueExecutionInput(value); } catch (error) { return error; }
  return undefined;
}

test('validateRescueExecutionInput rejects unknown shapes before traversing their values', () => {
  // A deeply self-similar value under an unknown key must reach the bounded
  // plugin rejection — never overflow the validator stack with a RangeError.
  let deep = /** @type {unknown} */ ('leaf');
  for (let index = 0; index < 100_000; index += 1) deep = [deep];
  const thrownForUnknownKey = /** @type {any} */ (
    rejectedExecutionInput({ version: 1, task: 'repair', nested: deep }));
  assert.equal(thrownForUnknownKey instanceof Error, true, 'the deeply nested unknown value must be rejected');
  assert.notEqual(thrownForUnknownKey.name, 'RangeError', 'the rejection must stay on the bounded error path');
  assert.equal(thrownForUnknownKey.code, 'RESCUE_EXECUTION_INPUT_INVALID');
  assert.deepEqual(thrownForUnknownKey.details.invalidFields, ['unknown']);
  // The same stability holds when the deep value hides under an allowed key.
  const thrownForAllowedKey = /** @type {any} */ (
    rejectedExecutionInput({ version: deep, task: 'repair' }));
  assert.equal(thrownForAllowedKey instanceof Error, true, 'the deeply nested allowed-field value must be rejected');
  assert.notEqual(thrownForAllowedKey.name, 'RangeError', 'the rejection must stay on the bounded error path');
  assert.equal(thrownForAllowedKey.code, 'RESCUE_EXECUTION_INPUT_INVALID');
  // The top-level key set decides alone: nested accessors under unknown keys
  // are never observed by validation.
  let nestedReads = 0;
  const getterCarrier = {};
  Object.defineProperty(getterCarrier, 'inner', { enumerable: true, get() { nestedReads += 1; return 'observed'; } });
  const thrownForGetter = /** @type {any} */ (
    rejectedExecutionInput({ version: 1, task: 'repair', nested: getterCarrier }));
  assert.equal(thrownForGetter.code, 'RESCUE_EXECUTION_INPUT_INVALID');
  assert.equal(nestedReads, 0, `nested accessors under unknown keys must never be read (saw ${nestedReads} reads)`);
});

test('validateRescueExecutionInput bounds the serialized JSON envelope and never echoes the task', () => {
  const task = `private-escape-probe ${'\t'.repeat(RESCUE_TASK_MAX_BYTES / 6)}`;
  const validated = validateRescueExecutionInput({ version: 1, task, model: 'm'.repeat(RESCUE_EXECUTION_MODEL_MAX_BYTES / 2) });
  assert.equal(Buffer.byteLength(JSON.stringify(validated)) <= RESCUE_EXECUTION_INPUT_MAX_BYTES, true);
  // Error hygiene: field names only, never the rejected task value.
  const secret = 'do-not-leak-secret-task';
  for (const value of [
    null,
    { version: 1, task: secret, scope: 'auto' },
    { version: 1, task: `${secret}${'x'.repeat(RESCUE_TASK_MAX_BYTES)}` },
    { version: 1, task: secret, effort: 'maximum' },
  ]) {
    let thrown;
    try { validateRescueExecutionInput(value); } catch (error) { thrown = error; }
    assert.ok(thrown instanceof Error);
    assert.equal(JSON.stringify(thrown).includes(secret), false);
    assert.equal(JSON.stringify(thrown).includes(RESCUE_TASK_MAX_BYTES.toString()), false);
  }
});
