import assert from 'node:assert/strict';
import test from 'node:test';

import { discoverTestEntries, isNodeTestEntry, selectTestEntries } from '../tools/run-test-suite.mjs';

const researchEntries = [
  'tests/direct-mcp-probe.test.mjs',
  'tests/e2e/codex-direct-mcp-feasibility.test.mjs',
  'tests/e2e/codex-mcp-context-e2e.test.mjs',
  'tests/mcp-context-probe.test.mjs',
  'tests/wait-route-probe.test.mjs',
];

test('routine selection excludes only the five MCP research tests and the shell probe', async () => {
  const discovered = await discoverTestEntries();
  const routine = selectTestEntries(discovered, 'routine');
  const research = selectTestEntries(discovered, 'mcp-research');
  const shell = selectTestEntries(discovered, 'shell-research');

  assert.deepEqual(research, researchEntries);
  assert.deepEqual(shell, ['tests/shell-wait-probe.test.mjs']);
  assert.deepEqual(routine, discovered.filter((entry) => !researchEntries.includes(entry) && entry !== 'tests/shell-wait-probe.test.mjs'));
  for (const entry of ['tests/mcp-result.test.mjs', 'tests/mcp-lifecycle-controller.test.mjs', 'tests/plugin-contracts.test.mjs']) {
    assert.ok(routine.includes(entry), `${entry} must remain in routine tests`);
  }
  assert.ok(routine.includes('tests/helpers/test-timeouts.mjs'), 'Node-discovered test-* files must remain in routine tests');
  assert.equal(new Set([...routine, ...research, ...shell]).size, discovered.length);
});

test('test selection fails closed for missing or duplicate research entries', () => {
  const ordinary = 'tests/mcp-result.test.mjs';
  const shellEntry = 'tests/shell-wait-probe.test.mjs';
  const complete = [...researchEntries, shellEntry, ordinary];
  assert.throws(() => selectTestEntries(complete.slice(1), 'routine'), /missing MCP research test/i);
  assert.throws(() => selectTestEntries([...complete, researchEntries[0]], 'routine'), /duplicate test entry/i);
  assert.throws(() => selectTestEntries(complete, 'unknown'), /unknown test suite/i);
  assert.throws(() => selectTestEntries(complete.filter((entry) => entry !== shellEntry), 'shell-research'), /missing shell research test/i);
  assert.throws(() => selectTestEntries(complete.filter((entry) => entry !== shellEntry), 'routine'), /missing shell research test/i);
});

test('the wait-route probe research test stays out of routine selection', async () => {
  const entries = await discoverTestEntries();
  assert.equal(selectTestEntries(entries, 'routine').includes('tests/wait-route-probe.test.mjs'), false);
  assert.equal(selectTestEntries(entries, 'mcp-research').includes('tests/wait-route-probe.test.mjs'), true);
});

test('shell research stays disjoint from the MCP research suite', async () => {
  const entries = await discoverTestEntries();
  const mcp = selectTestEntries(entries, 'mcp-research');
  const shell = selectTestEntries(entries, 'shell-research');
  assert.equal(shell.filter((entry) => mcp.includes(entry)).length, 0, 'no test entry may belong to both research suites');
});

test('shell qualification is separate from routine and unchanged MCP research', async () => {
  const entries = await discoverTestEntries();
  const shell = selectTestEntries(entries, 'shell-research');
  const mcp = selectTestEntries(entries, 'mcp-research');
  const routine = selectTestEntries(entries, 'routine');
  assert.deepEqual(shell, ['tests/shell-wait-probe.test.mjs']);
  assert.deepEqual(mcp, researchEntries); // existing five-entry MCP list
  assert.deepEqual(routine, entries.filter((entry) => !shell.includes(entry) && !mcp.includes(entry)));
  assert.equal(new Set([...routine, ...mcp, ...shell]).size, entries.length);
  for (const entry of ['tests/mcp-result.test.mjs', 'tests/mcp-lifecycle-controller.test.mjs', 'tests/plugin-contracts.test.mjs']) {
    assert.ok(routine.includes(entry));
  }
});

test('discovery recognizes Node test filenames without selecting ordinary fixtures', () => {
  for (const entry of ['tests/example.test.mjs', 'tests/example-test.js', 'tests/example_test.cjs', 'tests/test-example.mjs', 'tests/test.mjs', 'tests/test/helper.mjs']) {
    assert.equal(isNodeTestEntry(entry), true, entry);
  }
  for (const entry of ['tests/helpers/fixture.mjs', 'tests/helpers/test-data.json', 'tests/example.spec.mjs']) {
    assert.equal(isNodeTestEntry(entry), false, entry);
  }
});
