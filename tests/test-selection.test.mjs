import assert from 'node:assert/strict';
import test from 'node:test';

import { discoverTestEntries, isNodeTestEntry, selectTestEntries } from '../tools/run-test-suite.mjs';

const researchEntries = [
  'tests/direct-mcp-probe.test.mjs',
  'tests/e2e/codex-direct-mcp-feasibility.test.mjs',
  'tests/e2e/codex-mcp-context-e2e.test.mjs',
  'tests/mcp-context-probe.test.mjs',
];

test('routine selection excludes only the four MCP research tests', async () => {
  const discovered = await discoverTestEntries();
  const routine = selectTestEntries(discovered, 'routine');
  const research = selectTestEntries(discovered, 'mcp-research');

  assert.deepEqual(research, researchEntries);
  assert.deepEqual(routine, discovered.filter((entry) => !researchEntries.includes(entry)));
  for (const entry of ['tests/mcp-result.test.mjs', 'tests/mcp-lifecycle-controller.test.mjs', 'tests/plugin-contracts.test.mjs']) {
    assert.ok(routine.includes(entry), `${entry} must remain in routine tests`);
  }
  assert.ok(routine.includes('tests/helpers/test-timeouts.mjs'), 'Node-discovered test-* files must remain in routine tests');
  assert.equal(new Set([...routine, ...research]).size, discovered.length);
});

test('test selection fails closed for missing or duplicate research entries', () => {
  const ordinary = 'tests/mcp-result.test.mjs';
  const complete = [...researchEntries, ordinary];
  assert.throws(() => selectTestEntries(complete.slice(1), 'routine'), /missing MCP research test/i);
  assert.throws(() => selectTestEntries([...complete, researchEntries[0]], 'routine'), /duplicate test entry/i);
  assert.throws(() => selectTestEntries(complete, 'unknown'), /unknown test suite/i);
});

test('discovery recognizes Node test filenames without selecting ordinary fixtures', () => {
  for (const entry of ['tests/example.test.mjs', 'tests/example-test.js', 'tests/example_test.cjs', 'tests/test-example.mjs', 'tests/test.mjs', 'tests/test/helper.mjs']) {
    assert.equal(isNodeTestEntry(entry), true, entry);
  }
  for (const entry of ['tests/helpers/fixture.mjs', 'tests/helpers/test-data.json', 'tests/example.spec.mjs']) {
    assert.equal(isNodeTestEntry(entry), false, entry);
  }
});
