// Instrument tests for the shell wait probe research suite (research-only;
// this entry is excluded from the routine suite by tools/run-test-suite.mjs
// and selected only through the dedicated shell-research suite). Task 2 keeps
// this file to the suite-selection contract: it never launches a Codex host,
// a ZCode task, or any authenticated trial, and it never imports another test
// entry because that would trigger the entry's test registrations.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { discoverTestEntries, selectTestEntries } from '../tools/run-test-suite.mjs';

const suiteCliPath = fileURLToPath(new URL('../tools/run-test-suite.mjs', import.meta.url));
const shellEntry = 'tests/shell-wait-probe.test.mjs';
// Re-entry guard: the positive contract test below spawns the suite CLI with
// this variable set, so the CLI's child run of this very file registers only
// the guarded marker test and never spawns the CLI again (nesting stays
// bounded at one level).
const selfTestGuard = 'ZCODE_SHELL_WAIT_PROBE_SELF_TEST';

/**
 * Split a NODE_OPTIONS value into arguments with the same quoting and
 * escaping rules as Node's own parser, established empirically against
 * v22.13.0, v22.23.1 and v24.14.0: only U+0020 separates arguments (tab and
 * newline are ordinary characters); a double quote outside quotes opens a
 * quoted segment and the next double quote closes it, so quoted segments may
 * wrap whole flags or values and adjacent segments concatenate into one
 * argument; inside quotes a backslash escapes the following character, while
 * outside quotes a backslash is literal; single quotes have no special
 * meaning; an unterminated quote makes node reject the whole value, which is
 * preserved byte-for-byte rather than repaired here. Each argument carries
 * its raw source slice so unrelated arguments round-trip exactly, plus the
 * logical value node will actually use (quotes removed, escapes resolved).
 * @param {string} nodeOptions
 * @returns {{ raw: string, logical: string }[]}
 */
function parseNodeOptionsArguments(nodeOptions) {
  /** @type {{ raw: string, logical: string }[]} */
  const parsedArguments = [];
  let raw = '';
  let logical = '';
  let started = false;
  let quote = null;
  let escaped = false;
  for (const character of nodeOptions) {
    if (quote !== null) {
      if (escaped) {
        raw += character;
        logical += character;
        escaped = false;
      } else if (character === '\\') {
        raw += character;
        escaped = true;
      } else if (character === '"') {
        quote = null;
        raw += character;
      } else {
        raw += character;
        logical += character;
      }
      continue;
    }
    if (character === '"') {
      quote = '"';
      raw += character;
      started = true;
    } else if (character === ' ') {
      if (started) {
        parsedArguments.push({ raw, logical });
        raw = '';
        logical = '';
        started = false;
      }
    } else {
      raw += character;
      logical += character;
      started = true;
    }
  }
  if (started) parsedArguments.push({ raw, logical });
  return parsedArguments;
}

/**
 * Remove any test-runner reporter selection from a NODE_OPTIONS value.
 * `--test-reporter` is an array option whose occurrences must match the
 * occurrences of `--test-reporter-destination`, so pinning the spec reporter
 * below must replace (never join) an existing reporter choice, quoted or
 * not, together with its destination, while preserving every unrelated
 * argument byte-for-byte. Node normalizes every underscore in an option name
 * to a hyphen (verified against v22.13.0, v22.23.1 and v24.14.0, including
 * mixed-separator spellings and `--test_reporter_destination`), so matching
 * runs on the underscore-normalized logical value; no other aliasing exists.
 * @param {string|undefined} nodeOptions
 * @returns {string}
 */
function withoutTestReporterFlags(nodeOptions) {
  const parsedArguments = parseNodeOptionsArguments(nodeOptions ?? '');
  /** @type {string[]} */
  const kept = [];
  for (let index = 0; index < parsedArguments.length; index += 1) {
    const argument = parsedArguments[index];
    const normalizedLogical = argument.logical.replaceAll('_', '-');
    if (!/^--test-reporter(-destination)?(?:=|$)/.test(normalizedLogical)) {
      kept.push(argument.raw);
      continue;
    }
    if (!normalizedLogical.includes('=')) index += 1; // also drop the flag's space-separated value argument
  }
  return kept.join(' ');
}

/**
 * Environment for an intentional bounded CLI run: the node:test runner's
 * re-entry marker is removed (a nested `node --test` underneath a test file
 * otherwise skips running entirely) and the spec reporter is pinned because
 * the captured nested output arrives through a pipe, which Node 22 reports
 * as TAP by default; any existing reporter selection is replaced while every
 * other NODE_OPTIONS argument is preserved byte-for-byte.
 * @returns {NodeJS.ProcessEnv}
 */
function suiteChildEnv() {
  /** @type {NodeJS.ProcessEnv} */
  const childEnv = { ...process.env, [selfTestGuard]: '1' };
  delete childEnv.NODE_TEST_CONTEXT;
  const preservedOptions = withoutTestReporterFlags(childEnv.NODE_OPTIONS);
  childEnv.NODE_OPTIONS = preservedOptions
    ? `${preservedOptions} --test-reporter=spec`
    : '--test-reporter=spec';
  return childEnv;
}

/**
 * Spawn the suite CLI exactly like the positive contract test while
 * `process.env.NODE_OPTIONS` is temporarily preset, restoring it afterwards.
 * @param {string} presetNodeOptions
 * @returns {import('node:child_process').SpawnSyncReturns<string>}
 */
function spawnSuiteWithPresetNodeOptions(presetNodeOptions) {
  const previousNodeOptions = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = presetNodeOptions;
  try {
    return spawnSync(process.execPath, [suiteCliPath, 'shell-research'], {
      encoding: 'utf8',
      env: suiteChildEnv(),
    });
  } finally {
    if (previousNodeOptions === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = previousNodeOptions;
  }
}

if (process.env[selfTestGuard] === '1') {
  test('guarded re-entry: the suite selected exactly this shell research entry', async () => {
    assert.equal(process.env[selfTestGuard], '1');
    assert.deepEqual(selectTestEntries(await discoverTestEntries(), 'shell-research'), [shellEntry]);
  });
} else {
  test('the shell-research suite selects exactly the shell wait probe entry and exits zero', () => {
    const result = spawnSync(process.execPath, [suiteCliPath, 'shell-research'], {
      encoding: 'utf8',
      env: suiteChildEnv(),
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    // Exactly one selected test ran, it passed, and it is this file's guarded
    // marker: a wrong selection (extra entries or none) breaks these counts.
    assert.match(result.stdout, /guarded re-entry: the suite selected exactly this shell research entry/);
    assert.match(result.stdout, /ℹ tests 1\r?\n/);
    assert.match(result.stdout, /ℹ pass 1\r?\n/);
    assert.match(result.stdout, /ℹ fail 0\r?\n/);
  });

  test('a whole-token quoted reporter flag is replaced instead of duplicated', () => {
    const result = spawnSuiteWithPresetNodeOptions('"--test-reporter=tap"');
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /ℹ tests 1\r?\n/);
    assert.match(result.stdout, /ℹ pass 1\r?\n/);
    assert.match(result.stdout, /ℹ fail 0\r?\n/);
  });

  test('a quoted destination value containing spaces is stripped completely', () => {
    const result = spawnSuiteWithPresetNodeOptions(`--test-reporter-destination="${join(tmpdir(), 'test reports.txt')}" --test-reporter=tap`);
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /ℹ tests 1\r?\n/);
    assert.match(result.stdout, /ℹ pass 1\r?\n/);
    assert.match(result.stdout, /ℹ fail 0\r?\n/);
  });

  test('an unrelated quoted value containing spaces survives byte-for-byte', async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'nopt-probe-'));
    try {
      // Two spaces inside the quoted value: whitespace-collapsing preservation
      // would rewrite the path and the module would not load.
      const spacedDirectory = join(temporaryRoot, 'spaced  dir');
      await mkdir(spacedDirectory);
      const probePath = join(spacedDirectory, 'probe.js');
      await writeFile(probePath, 'process.stderr.write(\'NOPT_PRESERVED\\n\');\n', 'utf8');
      const result = spawnSuiteWithPresetNodeOptions(`--require="${probePath}" --test-reporter=tap`);
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /ℹ tests 1\r?\n/);
      // The required module ran, proving the quoted value reached the child
      // byte-for-byte; the suite still selected exactly this entry.
      assert.match(result.stderr, /NOPT_PRESERVED/);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test('an underscore alias of the reporter flag is replaced', () => {
    const result = spawnSuiteWithPresetNodeOptions('--test_reporter=tap');
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /ℹ tests 1\r?\n/);
    assert.match(result.stdout, /ℹ pass 1\r?\n/);
    assert.match(result.stdout, /ℹ fail 0\r?\n/);
  });

  test('a space-separated underscore reporter alias is replaced with its value', () => {
    const result = spawnSuiteWithPresetNodeOptions('--test_reporter tap');
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /ℹ tests 1\r?\n/);
    assert.match(result.stdout, /ℹ pass 1\r?\n/);
    assert.match(result.stdout, /ℹ fail 0\r?\n/);
  });

  test('a quoted underscore reporter alias is replaced', () => {
    const result = spawnSuiteWithPresetNodeOptions('"--test_reporter=tap"');
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /ℹ tests 1\r?\n/);
    assert.match(result.stdout, /ℹ pass 1\r?\n/);
    assert.match(result.stdout, /ℹ fail 0\r?\n/);
  });

  test('an underscore destination alias with a quoted spaced value is stripped', () => {
    const result = spawnSuiteWithPresetNodeOptions(`--test_reporter_destination="${join(tmpdir(), 'test reports.txt')}" --test_reporter=tap`);
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /ℹ tests 1\r?\n/);
    assert.match(result.stdout, /ℹ pass 1\r?\n/);
    assert.match(result.stdout, /ℹ fail 0\r?\n/);
  });

  test('an unknown suite still fails closed with the existing message', () => {
    const result = spawnSync(process.execPath, [suiteCliPath, 'not-a-suite'], { encoding: 'utf8' });
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /Unknown test suite: not-a-suite/);
  });
}
