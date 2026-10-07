// @ts-nocheck
// Instrument tests for the shell wait probe research suite (research-only;
// this entry is excluded from the routine suite by tools/run-test-suite.mjs
// and selected only through the dedicated shell-research suite). Task 2 keeps
// this file to the suite-selection contract: it never launches a Codex host,
// a ZCode task, or any authenticated trial, and it never imports another test
// entry because that would trigger the entry's test registrations.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { after, before, describe, test } from 'node:test';

import { discoverTestEntries, selectTestEntries } from '../tools/run-test-suite.mjs';

const suiteCliPath = fileURLToPath(new URL('../tools/run-test-suite.mjs', import.meta.url));
const shellEntry = 'tests/shell-wait-probe.test.mjs';
const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

/** @param {string} value */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

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

  // ---------------------------------------------------------------------------
  // Shell wait probe instrument (Task 3): public research interfaces.
  // Fast fixture/instrument regressions only; no authenticated Codex trial runs
  // in this file, and every live-run path stays behind ZCODE_SHELL_WAIT_E2E=1.
  // ---------------------------------------------------------------------------

  // Suite-wide ownership canary: an unrelated prunable worktree registration
  // created before every shell-research test and verified alive after ALL of
  // them. Any global prune or unowned cleanup anywhere in the suite destroys it
  // and fails the run. Removed surgically (admin entry) afterwards; registered
  // only in this un-guarded branch so the guarded re-entry child stays pure.
  const suiteCanary = { directory: '', canaryPath: '', created: false, sharedRegistrations: '' };
  before(async () => {
    const listed = spawnSync('git', ['worktree', 'list', '--porcelain'], { encoding: 'utf8' });
    assert.equal(listed.status, 0, listed.stderr);
    suiteCanary.sharedRegistrations = listed.stdout;
    suiteCanary.directory = await mkdtemp(join(tmpdir(), 'shell-wait-suite-canary-'));
    suiteCanary.canaryPath = join(suiteCanary.directory, 'canary-worktree');
    const added = spawnSync('git', ['worktree', 'add', '--detach', suiteCanary.canaryPath, 'HEAD'], { encoding: 'utf8' });
    if (added.status !== 0) return;
    await rm(suiteCanary.canaryPath, { recursive: true, force: true });
    suiteCanary.created = true;
  });
  after(async () => {
    try {
      if (suiteCanary.created) {
        const listed = spawnSync('git', ['worktree', 'list', '--porcelain'], { encoding: 'utf8' }).stdout
          .split('\n').filter((line) => line.startsWith('worktree ')).map((line) => line.slice('worktree '.length))
          .map((value) => value.startsWith('/private/') ? value.slice('/private'.length) : value);
        assert.ok(listed.includes(suiteCanary.canaryPath),
          'the suite destroyed an unrelated worktree registration; every cleanup must stay owned');
      }
    } finally {
      const commonDir = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).stdout.trim();
      const adminRoot = join(commonDir, 'worktrees');
      for (const entry of await readdir(adminRoot).catch(() => [])) {
        const pointer = (await readFile(join(adminRoot, entry, 'gitdir'), 'utf8').catch(() => '')).trim();
        if (pointer.replace(/\/.git$/u, '').replace(/^\/private(?=\/)/u, '') === suiteCanary.canaryPath) {
          await rm(join(adminRoot, entry), { recursive: true, force: true });
        }
      }
      await rm(suiteCanary.directory, { recursive: true, force: true });
    }
    const listed = spawnSync('git', ['worktree', 'list', '--porcelain'], { encoding: 'utf8' });
    assert.equal(listed.status, 0, listed.stderr);
    assert.equal(listed.stdout, suiteCanary.sharedRegistrations, 'the entire suite must leave every shared repository registration untouched');
  });

  describe('shell wait probe module shape and import purity', () => {
    const fixtureModule = fileURLToPath(new URL('../tools/shell-wait-probe/fixture.mjs', import.meta.url));
    const driverModule = fileURLToPath(new URL('../tools/shell-wait-probe/driver.mjs', import.meta.url));
    const evidenceModule = fileURLToPath(new URL('../tools/shell-wait-probe/evidence.mjs', import.meta.url));

    test('importing the three research modules launches nothing and exposes the planned interfaces', async () => {
      // The child imports all three modules with a poisoned launch environment:
      // any import-time host launch, fixture build, or clock wait would make the
      // child fail or hang; a clean synchronous import prints the shape marker.
      const child = spawnSync(process.execPath, ['--input-type=module', '--eval', `
        const [{ createShellWaitFixture }, driver, { inspectShellWaitEvidence }] = await Promise.all([
          import(${JSON.stringify(pathToFileURL(fixtureModule).href)}),
          import(${JSON.stringify(pathToFileURL(driverModule).href)}),
          import(${JSON.stringify(pathToFileURL(evidenceModule).href)}),
        ]);
        if (typeof createShellWaitFixture !== 'function') throw new Error('fixture export missing');
        if (typeof driver.parseShellWaitArguments !== 'function') throw new Error('driver parse export missing');
        if (typeof driver.runShellWaitCase !== 'function') throw new Error('driver run export missing');
        if (typeof inspectShellWaitEvidence !== 'function') throw new Error('evidence export missing');
        const cases = driver.SHELL_WAIT_CASES;
        if (!Array.isArray(cases) || Object.isFrozen(cases) !== true) throw new Error('case list must be a frozen array');
        console.log(JSON.stringify({ marker: 'SHELL_WAIT_MODULES_PURE', cases }));
      `], { encoding: 'utf8', env: { ...process.env, CODEX_BINARY: 'this value must never be launched at import time', ZCODE_SHELL_WAIT_E2E: '1' }, timeout: 30_000 });
      assert.equal(child.status, 0, `module import was not pure or shape failed:\n${child.stdout}\n${child.stderr}`);
      const payload = JSON.parse(child.stdout);
      assert.equal(payload.marker, 'SHELL_WAIT_MODULES_PURE');
      assert.deepEqual(payload.cases, [
        'rescue-baseline', 'rescue-long', 'rescue-repeat', 'rescue-noise', 'rescue-interrupt',
        'review-wait', 'adversarial-review-wait', 'status-wait', 'background',
      ]);
    });
  });

  describe('parseShellWaitArguments', async () => {
    const { parseShellWaitArguments, SHELL_WAIT_CASES } = await import('../tools/shell-wait-probe/driver.mjs');
    const codexBinary = process.execPath;
    const output = '/private/tmp/unused-shell-wait-output';
    const baseArguments = ['--case', 'rescue-baseline', '--codex', codexBinary, '--source-sha', 'a'.repeat(40), '--output', output];

    test('parses a closed case with the documented shared arguments and per-case defaults', () => {
      const parsed = parseShellWaitArguments(baseArguments);
      assert.equal(parsed.case, 'rescue-baseline');
      assert.equal(parsed.codexBinary, codexBinary);
      assert.equal(parsed.sourceSha, 'a'.repeat(40));
      assert.equal(parsed.output, output);
      assert.equal(parsed.workerDurationMs, 420_000);
      assert.equal(parsed.capMs, null, 'an omitted cap must stay unraised (null), never zero');
      assert.equal(parsed.pollMs, 60_000, 'rescue-baseline preserves the plain 60000 observation');
      assert.equal(parsed.budgetMs, 720_000);
    });

    test('candidate foreground cases default to the documented long candidate policy', () => {
      const parsed = parseShellWaitArguments(['--case', 'rescue-long', '--codex', codexBinary, '--source-sha', 'b'.repeat(40), '--output', output]);
      assert.equal(parsed.pollMs, 3_600_000);
      const review = parseShellWaitArguments(['--case', 'review-wait', '--codex', codexBinary, '--source-sha', 'c'.repeat(40), '--output', output]);
      assert.equal(review.pollMs, 3_600_000);
      assert.equal(review.workerDurationMs, 130_000);
    });

    test('the background compatibility case keeps its own short default shape', () => {
      const parsed = parseShellWaitArguments(['--case', 'background', '--codex', codexBinary, '--source-sha', 'd'.repeat(40), '--output', output]);
      assert.equal(parsed.workerDurationMs, 120_000);
      assert.equal(parsed.capMs, null);
      assert.equal(parsed.pollMs, 3_600_000);
      assert.equal(parsed.budgetMs, 300_000);
    });

    test('explicit values override per-case defaults and an explicit cap is kept', () => {
      const parsed = parseShellWaitArguments([...baseArguments, '--worker-duration-ms', '130000', '--cap-ms', '3600000', '--poll-ms', '60000', '--budget-ms', '360000']);
      assert.equal(parsed.workerDurationMs, 130_000);
      assert.equal(parsed.capMs, 3_600_000);
      assert.equal(parsed.pollMs, 60_000);
      assert.equal(parsed.budgetMs, 360_000);
    });

    test('rejects unknown cases, unknown options, and duplicate options', () => {
      assert.throws(() => parseShellWaitArguments(['--case', 'not-a-case', '--codex', codexBinary, '--source-sha', 'a'.repeat(40), '--output', output]), /unknown case/i);
      assert.throws(() => parseShellWaitArguments([...baseArguments, '--worker', '1']), /unknown option/i);
      assert.throws(() => parseShellWaitArguments([...baseArguments, '--output', output]), /duplicate/i);
      assert.throws(() => parseShellWaitArguments([...baseArguments, 'stray-token']), /unknown option|unexpected argument/i);
      assert.equal(SHELL_WAIT_CASES.includes('rescue-baseline'), true);
    });

    test('rejects a relative or shimmed executable, a malformed source SHA, and non-integer durations', () => {
      const relative = ['--case', 'rescue-baseline', '--codex', 'codex', '--source-sha', 'a'.repeat(40), '--output', output];
      assert.throws(() => parseShellWaitArguments(relative), /absolute/i);
      const shimmed = ['--case', 'rescue-baseline', '--codex', join(output, 'codex.cmd'), '--source-sha', 'a'.repeat(40), '--output', output];
      assert.throws(() => parseShellWaitArguments(shimmed), /absolute native executable/i);
      assert.throws(() => parseShellWaitArguments([...baseArguments, '--case', 'rescue-baseline']), /duplicate/i);
      assert.throws(() => parseShellWaitArguments(['--case', 'rescue-baseline', '--codex', codexBinary, '--source-sha', 'zz', '--output', output]), /40-character/i);
      assert.throws(() => parseShellWaitArguments([...baseArguments, '--budget-ms', '0']), /positive/i);
      assert.throws(() => parseShellWaitArguments([...baseArguments, '--worker-duration-ms', '130000.5']), /positive integer/i);
    });

    test('rejects missing required arguments and a contradictory baseline poll request', () => {
      assert.throws(() => parseShellWaitArguments(['--codex', codexBinary, '--source-sha', 'a'.repeat(40), '--output', output]), /--case/i);
      assert.throws(() => parseShellWaitArguments(['--case', 'rescue-baseline', '--source-sha', 'a'.repeat(40), '--output', output]), /--codex/i);
      assert.throws(() => parseShellWaitArguments([...baseArguments, '--poll-ms', '3600000']), /baseline preserves the plain 60000 observation/i);
    });

    test('a relative output path is rejected; --help prints nothing and launches nothing', () => {
      assert.throws(() => parseShellWaitArguments(['--case', 'rescue-baseline', '--codex', codexBinary, '--source-sha', 'a'.repeat(40), '--output', 'relative-out']), /absolute/i);
      const help = parseShellWaitArguments(['--help']);
      assert.deepEqual(help, { help: true });
    });
  });

  describe('runShellWaitCase', async () => {
    const { runShellWaitCase } = await import('../tools/shell-wait-probe/driver.mjs');
    const { createShellWaitFixture } = await import('../tools/shell-wait-probe/fixture.mjs');
    const codexBinary = process.execPath;

    function emptyLiveFacts() {
      return {
        codexVersion: null,
        route: { requested: 'rescue-foreground', actual: null },
        hostResult: { exitCode: null, sentinelMatched: null, terminalStdoutChecked: null },
        linkage: { checked: null, childThreadId: null, parentThreadId: null, companionLaunchCount: null, companionSendCount: null, originalHandleChecked: null },
        observations: { outerReturns: null, modelCalls: null, rootJoins: null, decisiveWallMs: null, remainingLifetimeMs: null, pendingInnerAtEnd: null },
        interrupt: { requested: false, delivered: null, settled: null, missingPrerequisite: null },
        held: { endedBeforeGate: null, cleanupLabel: null, gateReleased: null },
        excerpts: [],
        inconclusive: { reason: 'instrument smoke execution; no live observation was performed' },
      };
    }

    /** @param {Record<string, unknown>} [overrides] */
    function caseInput(overrides = {}) {
      return {
        case: 'rescue-baseline',
        codexBinary,
        sourceSha: 'a'.repeat(40),
        output: '/private/tmp/unused-shell-wait-output',
        workerDurationMs: 1000,
        capMs: null,
        pollMs: 60_000,
        budgetMs: 2000,
        ...overrides,
      };
    }

    test('refuses fail-closed without the opt-in environment and without an injected live executor', async () => {
      const previousGate = process.env.ZCODE_SHELL_WAIT_E2E;
      delete process.env.ZCODE_SHELL_WAIT_E2E;
      let fixtureCreated = false;
      try {
        const record = await runShellWaitCase(caseInput({ codexBinary: '/nonexistent/codex' }), {
          createFixture: async () => { fixtureCreated = true; throw new Error('fixture must not be created'); },
        });
        assert.equal(record.status, 'refused');
        assert.match(String(record.reason), /ZCODE_SHELL_WAIT_E2E=1/);
        assert.equal(fixtureCreated, false, 'a refused case must not create a fixture');
      } finally {
        if (previousGate === undefined) delete process.env.ZCODE_SHELL_WAIT_E2E;
        else process.env.ZCODE_SHELL_WAIT_E2E = previousGate;
      }
    });

    test('an injected live executor produces an executed redacted record written outside fixture homes', async (t) => {
      const temporary = await mkdtemp(join(tmpdir(), 'shell-wait-case-'));
      t.after(() => rm(temporary, { recursive: true, force: true }));
      const output = join(temporary, 'output');
      await mkdir(output, { mode: 0o700 });
      let disposed = false;
      const fakeFixture = {
        workspace: join(temporary, 'fixture', 'workspace'),
        codexHome: join(temporary, 'fixture', 'codex-home'),
        installedRoot: join(temporary, 'fixture', 'installed'),
        env: { CODEX_HOME: join(temporary, 'fixture', 'codex-home') },
        record: { variant: 'baseline', capMs: null, pollMs: 60_000, appliedArtifacts: [] },
        dispose: async () => { disposed = true; },
      };
      const record = await runShellWaitCase(caseInput({ output }), {
        createFixture: async () => fakeFixture,
        executeLiveCase: async () => ({
          codexVersion: '0.160.0',
          route: { requested: 'named', actual: null },
          hostResult: { exitCode: 0, sentinelMatched: null, terminalStdoutChecked: null },
          linkage: { checked: null, childThreadId: null, parentThreadId: null, companionLaunchCount: null, companionSendCount: null, originalHandleChecked: null },
          observations: { outerReturns: null, modelCalls: null, rootJoins: null, decisiveWallMs: null, remainingLifetimeMs: null, pendingInnerAtEnd: null },
          interrupt: { requested: false, delivered: null, settled: null, missingPrerequisite: null },
          held: { endedBeforeGate: null, cleanupLabel: 'observation', gateReleased: null },
          excerpts: [],
          inconclusive: { reason: 'instrument smoke execution; no live observation was performed' },
        }),
      });
      assert.equal(record.status, 'executed');
      assert.equal(disposed, true, 'the fixture must be disposed after the case');
      assert.equal(record.case, 'rescue-baseline');
      assert.deepEqual(record.provenance.requestedCapMs, null);
      assert.equal(record.inconclusive.reason, 'instrument smoke execution; no live observation was performed');
      const written = JSON.parse(await readFile(join(output, 'rescue-baseline.record.json'), 'utf8'));
      assert.equal(written.status, 'executed');
      // Redaction: no fixture-private absolute path may enter the record.
      assert.doesNotMatch(JSON.stringify(written), /shell-wait-case-/u);
      assert.doesNotMatch(JSON.stringify(written), new RegExp(escapeRegExp(temporary)), 'the private temporary root must never enter the record');
      // The redacted evidence outlives the removed credential homes.
      assert.equal(await stat(join(output, 'rescue-baseline.record.json')).then((metadata) => metadata.isFile(), () => false), true);
    });

    test('an input whose executable does not exist is rejected before any fixture work when the gate is open', async () => {
      const previousGate = process.env.ZCODE_SHELL_WAIT_E2E;
      process.env.ZCODE_SHELL_WAIT_E2E = '1';
      try {
        await assert.rejects(runShellWaitCase(caseInput({ codexBinary: join(tmpdir(), 'missing-shell-wait-codex') })), /exact Codex executable.*does not exist|does not exist/i);
      } finally {
        if (previousGate === undefined) delete process.env.ZCODE_SHELL_WAIT_E2E;
        else process.env.ZCODE_SHELL_WAIT_E2E = previousGate;
      }
    });

    test('rejects an input that was not produced by the parser (unknown case or missing fields)', async () => {
      await assert.rejects(runShellWaitCase({ ...caseInput(), case: 'not-a-case' }), /unknown case/i);
      await assert.rejects(runShellWaitCase({ case: 'rescue-long' }), /codexBinary|Invalid shell wait case input/i);
      await assert.rejects(runShellWaitCase(caseInput({ sourceSha: 'short' })), /40-character/i);
      assert.equal(typeof createShellWaitFixture, 'function', 'the fixture interface stays the plan shape');
    });

    test('a live executor failure still disposes the fixture (credentials and owned registration removed)', async (t) => {
      const temporary = await mkdtemp(join(tmpdir(), 'shell-wait-case-leak-'));
      t.after(() => rm(temporary, { recursive: true, force: true }));
      const output = join(temporary, 'output');
      await mkdir(output, { mode: 0o700 });
      let disposeCount = 0;
      const fakeFixture = {
        workspace: join(temporary, 'fixture', 'workspace'),
        codexHome: join(temporary, 'fixture', 'codex-home'),
        installedRoot: join(temporary, 'fixture', 'installed'),
        env: { CODEX_HOME: join(temporary, 'fixture', 'codex-home') },
        record: { variant: 'candidate', capMs: null, pollMs: 3_600_000, appliedArtifacts: [] },
        dispose: async () => { disposeCount += 1; },
      };
      await assert.rejects(runShellWaitCase(caseInput({ output }), {
        createFixture: async () => fakeFixture,
        executeLiveCase: async () => { throw new Error('the held observation failed'); },
      }), /the held observation failed/);
      assert.equal(disposeCount, 1, 'the fixture must be disposed even when the live executor throws');
    });

    test('a failed observation with failed termination persists a failed record with cleanup facts', async (t) => {
      const temporary = await mkdtemp(join(tmpdir(), 'shell-wait-case-failed-'));
      t.after(() => rm(temporary, { recursive: true, force: true }));
      const output = join(temporary, 'output');
      await mkdir(output, { mode: 0o700 });
      const fakeFixture = {
        workspace: join(temporary, 'fixture', 'workspace'),
        codexHome: join(temporary, 'fixture', 'codex-home'),
        installedRoot: join(temporary, 'fixture', 'installed'),
        env: { CODEX_HOME: join(temporary, 'fixture', 'codex-home') },
        record: { variant: 'candidate', capMs: null, pollMs: 3_600_000, appliedArtifacts: [] },
        dispose: async () => {},
      };
      const liveFacts = {
        codexVersion: '0.160.0',
        route: { requested: 'rescue-foreground', actual: null },
        hostResult: { exitCode: null, sentinelMatched: null, terminalStdoutChecked: null },
        linkage: { checked: null, childThreadId: null, parentThreadId: null, companionLaunchCount: null, companionSendCount: null, originalHandleChecked: null },
        observations: { outerReturns: null, modelCalls: null, rootJoins: null, decisiveWallMs: null, remainingLifetimeMs: null, pendingInnerAtEnd: null },
        interrupt: { requested: false, delivered: null, settled: null, missingPrerequisite: null },
        held: {
          endedBeforeGate: false, cleanupLabel: 'failure', gateReleased: true, cleanupComplete: false,
          cleanupErrors: { count: 1, reasons: ['SIGTERM could not be signalled (EPERM) and the exact fake-ZCode process remains live'] },
          processTermination: { verifiedTerminated: false, codexTerminated: true },
        },
        excerpts: [],
        inconclusive: { reason: 'rollout collection failed (the rollout record is not valid JSON); the case is inconclusive rather than zero.; the held cleanup reported 1 error(s) after observation: SIGTERM could not be signalled (EPERM) and the exact fake-ZCode process remains live' },
      };
      await assert.rejects(runShellWaitCase(caseInput({ output }), {
        createFixture: async () => fakeFixture,
        executeLiveCase: async () => {
          throw Object.assign(new Error('rollout parse failed'), { liveFacts });
        },
      }), /rollout parse failed/);
      const written = JSON.parse(await readFile(join(output, 'rescue-baseline.record.json'), 'utf8'));
      assert.equal(written.status, 'failed', 'the failed case must persist its record');
      assert.deepEqual(written.held.processTermination, { verifiedTerminated: false, codexTerminated: true }, 'the surviving-process outcome must survive fixture deletion');
      assert.equal(written.held.cleanupErrors.count, 1);
      assert.match(written.held.cleanupErrors.reasons.join(' '), /remains live/);
      assert.equal(written.cleanup.cleanupComplete, false);
      assert.match(written.inconclusive.reason, /rollout parse failed|rollout collection failed/);
    });

    test('the written record keeps the companion exit separate from the host exit', async (t) => {
      const temporary = await mkdtemp(join(tmpdir(), 'shell-wait-case-exits-'));
      t.after(() => rm(temporary, { recursive: true, force: true }));
      const output = join(temporary, 'output');
      await mkdir(output, { mode: 0o700 });
      const fakeFixture = {
        workspace: join(temporary, 'fixture', 'workspace'),
        codexHome: join(temporary, 'fixture', 'codex-home'),
        installedRoot: join(temporary, 'fixture', 'installed'),
        env: { CODEX_HOME: join(temporary, 'fixture', 'codex-home') },
        record: { variant: 'baseline', capMs: null, pollMs: 60_000, appliedArtifacts: [] },
        dispose: async () => {},
      };
      await runShellWaitCase(caseInput({ output }), {
        createFixture: async () => fakeFixture,
        executeLiveCase: async () => ({
          codexVersion: '0.160.0',
          route: { requested: 'rescue-foreground', actual: 'named' },
          hostResult: { exitCode: 0, companionProcessExit: 17, sentinelMatched: true, terminalStdoutChecked: true },
          linkage: { checked: true, childThreadId: 'c', parentThreadId: 'p', companionLaunchCount: 1, companionSendCount: 1, originalHandleChecked: true },
          observations: { outerReturns: 0, modelCalls: 2, rootJoins: 1, decisiveWallMs: 5000, remainingLifetimeMs: null, pendingInnerAtEnd: false },
          interrupt: { requested: false, delivered: null, settled: null, missingPrerequisite: null },
          held: {
            endedBeforeGate: false, cleanupLabel: 'observation', gateReleased: true, cleanupComplete: true,
            cleanupErrors: { count: 0, reasons: [] },
            processTermination: { verifiedTerminated: true, codexTerminated: true },
          },
          excerpts: [],
          inconclusive: null,
        }),
      });
      const written = JSON.parse(await readFile(join(output, 'rescue-baseline.record.json'), 'utf8'));
      assert.equal(written.result.processExit, 17, 'the observed companion exit must be persisted');
      assert.equal(written.result.hostExit, 0, 'the host exit must be persisted separately');
    });

    test('the written record persists the fixture-rendered named-role digest', async (t) => {
      const temporary = await mkdtemp(join(tmpdir(), 'shell-wait-case-rolehash-'));
      t.after(() => rm(temporary, { recursive: true, force: true }));
      const output = join(temporary, 'output');
      await mkdir(output, { mode: 0o700 });
      const renderedNamedRoleSha256 = 'e'.repeat(64);
      const genericMessageSha256 = 'f'.repeat(64);
      const fakeFixture = {
        workspace: join(temporary, 'fixture', 'workspace'),
        codexHome: join(temporary, 'fixture', 'codex-home'),
        installedRoot: join(temporary, 'fixture', 'installed'),
        env: { CODEX_HOME: join(temporary, 'fixture', 'codex-home') },
        record: {
          variant: 'baseline', capMs: null, pollMs: 60_000, appliedArtifacts: [],
          renderedNamedRoleSha256, genericMessageSha256,
        },
        dispose: async () => {},
      };
      await runShellWaitCase(caseInput({ output }), {
        createFixture: async () => fakeFixture,
        executeLiveCase: async () => emptyLiveFacts(),
      });
      const written = JSON.parse(await readFile(join(output, 'rescue-baseline.record.json'), 'utf8'));
      assert.equal(written.provenance.instructionVariants.namedRoleSha256, renderedNamedRoleSha256, 'the rendered named-role digest must survive into the persisted record');
      assert.equal(written.provenance.instructionVariants.genericMessageSha256, genericMessageSha256);
    });

    test('the written record persists the mapped cleanup summary and termination outcomes', async (t) => {
      const temporary = await mkdtemp(join(tmpdir(), 'shell-wait-case-persist-'));
      t.after(() => rm(temporary, { recursive: true, force: true }));
      const output = join(temporary, 'output');
      await mkdir(output, { mode: 0o700 });
      const fakeFixture = {
        workspace: join(temporary, 'fixture', 'workspace'),
        codexHome: join(temporary, 'fixture', 'codex-home'),
        installedRoot: join(temporary, 'fixture', 'installed'),
        env: { CODEX_HOME: join(temporary, 'fixture', 'codex-home') },
        record: { variant: 'baseline', capMs: null, pollMs: 60_000, appliedArtifacts: [] },
        dispose: async () => {},
      };
      await runShellWaitCase(caseInput({ output }), {
        createFixture: async () => fakeFixture,
        executeLiveCase: async () => ({
          codexVersion: '0.160.0',
          route: { requested: 'rescue-foreground', actual: null },
          hostResult: { exitCode: 1, sentinelMatched: null, terminalStdoutChecked: null },
          linkage: { checked: null, childThreadId: null, parentThreadId: null, companionLaunchCount: null, companionSendCount: null, originalHandleChecked: null },
          observations: { outerReturns: null, modelCalls: null, rootJoins: null, decisiveWallMs: null, remainingLifetimeMs: null, pendingInnerAtEnd: null },
          interrupt: { requested: false, delivered: null, settled: null, missingPrerequisite: null },
          held: {
            endedBeforeGate: true, cleanupLabel: 'early-exit', gateReleased: true, cleanupComplete: false,
            cleanupErrors: { count: 1, reasons: ['SIGTERM could not be signalled (EPERM) and the exact fake-ZCode process remains live'] },
            processTermination: { verifiedTerminated: false, codexTerminated: true },
          },
          excerpts: [],
          inconclusive: { reason: 'the held cleanup reported 1 error(s) after observation' },
        }),
      });
      const written = JSON.parse(await readFile(join(output, 'rescue-baseline.record.json'), 'utf8'));
      assert.deepEqual(written.held.processTermination, { verifiedTerminated: false, codexTerminated: true }, 'the mapped termination outcomes must survive serialization');
      assert.equal(written.held.cleanupErrors.count, 1);
      assert.match(written.held.cleanupErrors.reasons.join(' '), /SIGTERM/);
      assert.equal(written.cleanup.cleanupComplete, false);
    });

    test('a disposal failure is recorded as fixtureDisposed false and never claimed as disposed', async (t) => {
      const temporary = await mkdtemp(join(tmpdir(), 'shell-wait-case-dispose-'));
      t.after(() => rm(temporary, { recursive: true, force: true }));
      const output = join(temporary, 'output');
      const privateTempRoot = join(temporary, 'fixture-root-secret');
      await mkdir(output, { mode: 0o700 });
      const fakeFixture = {
        workspace: join(privateTempRoot, 'workspace'),
        codexHome: join(privateTempRoot, 'codex-home'),
        installedRoot: join(privateTempRoot, 'installed'),
        env: { CODEX_HOME: join(privateTempRoot, 'codex-home') },
        record: { variant: 'baseline', capMs: null, pollMs: 60_000, appliedArtifacts: [] },
        dispose: async () => { throw new Error(`could not remove ${join(privateTempRoot, 'codex-home')}`); },
      };
      const record = await runShellWaitCase(caseInput({ output }), {
        createFixture: async () => fakeFixture,
        executeLiveCase: async () => emptyLiveFacts(),
      });
      assert.equal(record.cleanup.fixtureDisposed, false);
      assert.equal(typeof record.cleanup.disposalError, 'string');
      assert.doesNotMatch(record.cleanup.disposalError, new RegExp(escapeRegExp(privateTempRoot)), 'the disposal error must be scrubbed of private paths');
      const written = JSON.parse(await readFile(join(output, 'rescue-baseline.record.json'), 'utf8'));
      assert.equal(written.cleanup.fixtureDisposed, false, 'the persisted record must carry the actual disposal outcome');
    });
  });

  describe('inspectShellWaitEvidence', async () => {
    const { inspectShellWaitEvidence, parseCallEvent } = await import('../tools/shell-wait-probe/evidence.mjs');
    const { mapShellWaitLiveFacts } = await import('../tools/shell-wait-probe/driver.mjs');

    const PARENT = 'parent-thread-1';
    const CHILD = 'child-thread-1';
    const AGENT_PATH = '/root/zcode_rescue_task_1';
    const LAUNCHER = 'node "/installed/zcode/skills/rescue/launcher.mjs" invoke-prepared rescue';
    const SENTINEL = 'ZCODE_RESCUE_PUBLIC_SENTINEL_7C9C';
    const HANDLE = 91;

    function sessionMeta(id, extra = {}) { return { type: 'session_meta', payload: { id, ...extra } }; }
    function childMeta(overrides = {}) {
      return sessionMeta(CHILD, { parent_thread_id: PARENT, source: { subagent: { thread_spawn: { agent_path: AGENT_PATH } } }, ...overrides });
    }
    function fnCall(name, callId, args) { return { type: 'response_item', payload: { type: 'function_call', name, call_id: callId, arguments: JSON.stringify(args) } }; }
    function fnOutput(callId, output) { return { type: 'response_item', payload: { type: 'function_call_output', call_id: callId, output } }; }
    function completedOutput(result) {
      return [{ type: 'input_text', text: 'Script completed\n' }, { type: 'input_text', text: JSON.stringify(result) }];
    }
    function pendingOutput(cellId) { return [{ type: 'input_text', text: `Script running with cell ID ${cellId}\n` }]; }
    function wrappedCall(kind, callId, value, callType = 'custom_tool_call') {
      const input = `const r = await tools.${kind}(${JSON.stringify(value)}); text(JSON.stringify(r))\n`;
      return callType === 'custom_tool_call'
        ? { type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: callId, input } }
        : { type: 'response_item', payload: { type: 'function_call', name: kind, call_id: callId, arguments: JSON.stringify(value) } };
    }
    function callOutput(callId, output) {
      return { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: callId, output } };
    }
    function startedEvent() {
      return { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'SubAgentActivity', kind: 'started', agent_thread_id: CHILD, agent_path: AGENT_PATH } } };
    }
    function quotedMessage() {
      return { type: 'event_msg', payload: { type: 'agent_message', message: `I will now run ${LAUNCHER} to observe the companion.` } };
    }
    function fullRollouts() {
      return [
        [
          sessionMeta(PARENT),
          fnCall('spawn_agent', 'spawn-1', { task_name: 'zcode_rescue_task_1', fork_turns: 'none', agent_type: 'zcode-rescue', message: 'Run the installed prepared ZCode Rescue forwarder now. Return its public stdout verbatim.' }),
          startedEvent(),
          fnCall('wait_agent', 'root-wait-1', { timeout_ms: 600000 }),
        ],
        [
          childMeta(),
          wrappedCall('exec_command', 'launch-1', { cmd: LAUNCHER, workdir: '/installed/workspace' }),
          callOutput('launch-1', completedOutput({ output: '', session_id: HANDLE })),
          wrappedCall('write_stdin', 'poll-1', { session_id: HANDLE, chars: '', yield_time_ms: 60000 }),
          callOutput('poll-1', completedOutput({ output: SENTINEL, exit_code: 0, session_id: HANDLE })),
        ],
      ];
    }
    const evidenceInput = (overrides = {}) => ({
      rollouts: fullRollouts(),
      zcodeCalls: [{ method: 'session/send', params: { sessionId: 'fake-session' } }],
      command: LAUNCHER,
      publicResult: SENTINEL,
      requestedPollMs: 60_000,
      workerStillAliveAfterObservation: false,
      redactions: [],
      ...overrides,
    });

    test('the supported direct and wrapper call shapes qualify an exact completion', () => {
      const result = inspectShellWaitEvidence(evidenceInput());
      assert.equal(result.status, 'supported');
      assert.equal(result.inconclusive, null);
      assert.equal(result.facts.linkage.exact, true);
      assert.equal(result.facts.linkage.childThreadId, CHILD);
      assert.equal(result.facts.linkage.parentThreadId, PARENT);
      assert.equal(result.facts.companion.launchCount, 1);
      assert.equal(result.facts.companion.sendCount, 1);
      assert.equal(result.facts.handle.originalHandleId, HANDLE);
      assert.equal(result.facts.handle.pollCount, 1);
      assert.equal(result.facts.handle.foreignHandlePolls, 0);
      assert.equal(result.facts.handle.overlappingInnerPolls, 0);
      assert.equal(result.facts.observations.outerReturns, 0);
      assert.equal(result.facts.observations.rootJoins, 1);
      assert.equal(result.facts.completion.qualified, true);
      assert.equal(result.facts.completion.processExit, 0);
      assert.equal(result.facts.completion.publicResultMatched, true);
      assert.equal(result.facts.completion.decisiveEnd, 'process-exit');
    });

    test('call-ID ownership rejects a launcher and poll sharing one terminal response', () => {
      const rollouts = fullRollouts();
      rollouts[1] = [childMeta(),
        wrappedCall('exec_command', 'shared', { cmd: LAUNCHER }),
        wrappedCall('write_stdin', 'shared', { session_id: HANDLE, chars: '' }),
        callOutput('shared', completedOutput({ output: SENTINEL, exit_code: 0, session_id: HANDLE }))];
      const result = inspectShellWaitEvidence(evidenceInput({ rollouts }));
      assert.notEqual(result.facts?.completion.qualified, true);
      assert.equal(result.status, 'inconclusive');
      assert.equal(result.inconclusive.reason, 'ambiguous-call-linkage');
    });

    for (const callType of ['custom_tool_call', 'function_call']) {
      for (const callId of [undefined, null, '', 91, ['poll-1']]) {
        test(`call-ID ownership rejects ${callType} ID ${JSON.stringify(callId)}`, () => {
          const rollouts = fullRollouts();
          rollouts[1][3] = wrappedCall('write_stdin', callId, { session_id: HANDLE, chars: '' }, callType);
          rollouts[1][4].payload.call_id = callId;
          const result = inspectShellWaitEvidence(evidenceInput({ rollouts }));
          assert.notEqual(result.facts?.completion.qualified, true);
          assert.equal(result.status, 'inconclusive');
          assert.equal(result.inconclusive.reason, 'ambiguous-call-linkage');
        });
      }
    }

    for (const corruption of ['duplicate response', 'missing response ID', 'orphan response', 'response before call']) {
      test(`call-ID ownership rejects ${corruption}`, () => {
        const rollouts = fullRollouts();
        const child = rollouts[1];
        if (corruption === 'duplicate response') child.push(fnOutput('poll-1', completedOutput({ output: SENTINEL, exit_code: 0, session_id: HANDLE })));
        if (corruption === 'missing response ID') delete child[4].payload.call_id;
        if (corruption === 'orphan response') child.push(callOutput('orphan', completedOutput({ exit_code: 0 })));
        if (corruption === 'response before call') child.splice(3, 0, child.splice(4, 1)[0]);
        const result = inspectShellWaitEvidence(evidenceInput({ rollouts }));
        assert.notEqual(result.facts?.completion.qualified, true);
        assert.equal(result.status, 'inconclusive');
        assert.equal(result.inconclusive.reason, 'ambiguous-call-linkage');
      });
    }

    test('the installed inline wrapper shape with a JavaScript object literal parses as a supported call', () => {
      // The exact shape observed live on 0.160.1 (Task 4 first Case 0 attempt):
      // `text(await tools.exec_command({...}));` with unquoted keys.
      const catInput = 'text(await tools.exec_command({cmd:"cat /installed/skills/rescue/SKILL.md",max_output_tokens:20000}));\n';
      const rollouts = [[
        sessionMeta(PARENT),
        { type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'cat-1', input: catInput } },
        callOutput('cat-1', completedOutput({ output: 'skill text', session_id: null })),
      ]];
      const result = inspectShellWaitEvidence({ ...evidenceInput(), rollouts });
      assert.equal(result.status, 'supported', 'the observed inline wrapper must be a supported shape, not manual adjudication');
    });

    function statementCell(callId, lines) {
      return { type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: callId, input: `${lines.join('\n')}\n` } };
    }
    const inlineStatement = (kind, value) => `text(await tools.${kind}(${JSON.stringify(value)}));`;
    function cellOutput(callId, results) {
      return callOutput(callId, [{ type: 'input_text', text: 'Script completed\n' },
        ...results.map((result) => ({ type: 'input_text', text: JSON.stringify(result) }))]);
    }

    test('boundary regression: the exact second live Case 0 const-r launch parses', () => {
      // Verbatim sanitized excerpt from shell-wait-t4-case0b.bJLmLH/rescue-long.record.json.
      const input = `const r = await tools.exec_command({cmd:'node "/private<redacted>/codex-home/plugins/cache/vitry/zcode/0.1.0/skills/rescue/launcher.mjs" invoke-prepared rescue',yield_time_ms:30000});text(r);\n`;
      const event = statementCell('launch-1', []);
      event.payload.input = input;
      const command = 'node "/private<redacted>/codex-home/plugins/cache/vitry/zcode/0.1.0/skills/rescue/launcher.mjs" invoke-prepared rescue';
      assert.deepEqual(parseCallEvent(event), {
        kind: 'exec_command', value: { cmd: command, yield_time_ms: 30000 }, directive: null, wrapped: true,
      });
      const rollouts = fullRollouts();
      rollouts[1][1] = event;
      const result = inspectShellWaitEvidence(evidenceInput({ rollouts, command }));
      assert.equal(result.status, 'supported');
      assert.equal(result.facts.companion.launchCount, 1);
      assert.equal(result.facts.completion.qualified, true);
    });

    for (const separator of ['', ' \t  ', '\n']) {
      test(`boundary regression: const-r exact tails allow separator ${JSON.stringify(separator)}`, () => {
        for (const tail of ['text(r)', 'text(JSON.stringify(r))', 'text(r);', 'text(JSON.stringify(r));']) {
          const event = statementCell('poll', []);
          event.payload.input = `const r = await tools.write_stdin({session_id:91,chars:''});${separator}${tail}\n`;
          assert.deepEqual(parseCallEvent(event), {
            kind: 'write_stdin', value: { session_id: HANDLE, chars: '' }, directive: null, wrapped: true,
          });
        }
      });
    }

    test('boundary regression: the compact inline form already supports the no-space tail', () => {
      const event = statementCell('launch-1', [inlineStatement('exec_command', { cmd: LAUNCHER })]);
      assert.deepEqual(parseCallEvent(event), {
        kind: 'exec_command', value: { cmd: LAUNCHER }, directive: null, wrapped: true,
      });
    });

    test('boundary regression: padded multi-statement lines preserve sequential linkage', () => {
      const rollouts = fullRollouts();
      rollouts[1].splice(3, 2, statementCell('observe', [
        ` \t${preparationCall().payload.input.trimEnd()}  `,
        `  ${wrappedCall('write_stdin', 'unused', { session_id: HANDLE, chars: '' }).payload.input.trimEnd().replace('; text(', ';\t  text(')} \t`,
      ]), cellOutput('observe', [{ output: '', session_id: HANDLE }, { output: SENTINEL, session_id: HANDLE, exit_code: 0 }]));
      const result = inspectShellWaitEvidence(evidenceInput({ rollouts }));
      assert.equal(result.status, 'supported');
      assert.equal(result.facts.handle.preparationFrameWrites, 1);
      assert.equal(result.facts.handle.pollCount, 1);
      assert.equal(result.facts.completion.qualified, true);
    });

    for (const badLine of ['text(x)', '', 'text(r);console.log("extra");', 'text(r);;']) {
      test(`boundary regression: a different const-r tail fails closed ${JSON.stringify(badLine)}`, () => {
        const event = statementCell('bad', [`const r = await tools.exec_command({cmd:"cat skill.md"});${badLine}`]);
        assert.equal(parseCallEvent(event), null);
        const rollouts = fullRollouts();
        rollouts[1].splice(1, 0, event);
        const result = inspectShellWaitEvidence(evidenceInput({ rollouts }));
        assert.equal(result.status, 'inconclusive');
        assert.equal(result.inconclusive.reason, 'unsupported-call-shape');
      });
    }

    for (const badLine of [' \t ', '  console.log("extra");  ', '  text(await tools.exec_command({cmd: @broken}));  ']) {
      test(`boundary regression: padded cells reject every unsupported line ${JSON.stringify(badLine)}`, () => {
        const rollouts = fullRollouts();
        rollouts[1].splice(1, 0, statementCell('bad', [` \t${inlineStatement('exec_command', { cmd: 'cat skill.md' })}  `, badLine]));
        const result = inspectShellWaitEvidence(evidenceInput({ rollouts }));
        assert.equal(result.status, 'inconclusive');
        assert.equal(result.inconclusive.reason, 'unsupported-call-shape');
      });
    }

    test('multi-statement live cat and role-status diagnostics qualify before the exact launcher', () => {
      const rollouts = fullRollouts();
      rollouts[1].splice(1, 0, statementCell('diagnostics', [
        inlineStatement('exec_command', { cmd: 'cat /private/skill.md' }),
        inlineStatement('exec_command', { cmd: 'node /private/launcher.mjs role-status rescue' }),
      ]), cellOutput('diagnostics', [{ output: 'skill', exit_code: 0 }, { output: 'ready', exit_code: 0 }]));
      const result = inspectShellWaitEvidence(evidenceInput({ rollouts, redactions: ['/private'] }));
      assert.equal(result.status, 'supported');
      assert.equal(result.facts.completion.qualified, true);
      assert.equal(result.facts.companion.launchCount, 1);
      assert.equal(result.facts.companion.preLaunchDiagnostics.count, 2);
      assert.equal(result.facts.companion.preLaunchDiagnostics.excerpts.length, 2);
      assert.doesNotMatch(JSON.stringify(result.facts.companion.preLaunchDiagnostics), /\/private/);
    });

    test('separate direct pre-launch diagnostics qualify and retain bounded excerpts', () => {
      const rollouts = fullRollouts();
      rollouts[1].splice(1, 0, fnCall('exec_command', 'cat', { cmd: `cat /private/${'x'.repeat(2500)}` }),
        fnOutput('cat', completedOutput({ output: '', exit_code: 0 })));
      const result = inspectShellWaitEvidence(evidenceInput({ rollouts, redactions: ['/private'] }));
      assert.equal(result.facts.completion.qualified, true);
      assert.equal(result.facts.companion.preLaunchDiagnostics.count, 1);
      assert.equal(result.facts.companion.preLaunchDiagnostics.excerpts[0].truncated, true);
      assert.doesNotMatch(result.facts.companion.preLaunchDiagnostics.excerpts[0].text, /\/private/);
    });

    test('multi-statement preparation and const-r poll preserve sequential result linkage', () => {
      const rollouts = fullRollouts();
      rollouts[1].splice(3, 2, statementCell('observe', [
        preparationCall().payload.input.trimEnd(),
        wrappedCall('write_stdin', 'unused', { session_id: HANDLE, chars: '' }).payload.input.trimEnd(),
      ]), cellOutput('observe', [{ output: '', session_id: HANDLE }, { output: SENTINEL, session_id: HANDLE, exit_code: 0 }]));
      const result = inspectShellWaitEvidence(evidenceInput({ rollouts }));
      assert.equal(result.status, 'supported');
      assert.equal(result.facts.handle.preparationFrameWrites, 1);
      assert.equal(result.facts.handle.pollCount, 1);
      assert.equal(result.facts.handle.overlappingInnerPolls, 0);
      assert.equal(result.facts.completion.qualified, true);
    });

    test('multi-statement launcher and terminal poll keep their own ordered outputs', () => {
      const rollouts = fullRollouts();
      rollouts[1] = [childMeta(), statementCell('launch-observe', [
        inlineStatement('exec_command', { cmd: LAUNCHER }),
        inlineStatement('write_stdin', { session_id: HANDLE, chars: '' }),
      ]), cellOutput('launch-observe', [{ output: '', session_id: HANDLE }, { output: SENTINEL, session_id: HANDLE, exit_code: 0 }])];
      const result = inspectShellWaitEvidence(evidenceInput({ rollouts }));
      assert.equal(result.status, 'supported');
      assert.equal(result.facts.completion.qualified, true);
      assert.equal(result.facts.handle.originalHandleId, HANDLE);
    });

    test('multi-statement last pending observation requires an exact outer continuation', () => {
      const rollouts = fullRollouts();
      rollouts[1].splice(3, 2, statementCell('observe', [preparationCall().payload.input.trimEnd(),
        inlineStatement('write_stdin', { session_id: HANDLE, chars: '' })]),
      callOutput('observe', [...pendingOutput('multi-cell'), { type: 'input_text', text: JSON.stringify({ output: '', session_id: HANDLE }) }]),
      fnCall('wait', 'continue', { cell_id: 'multi-cell' }),
      fnOutput('continue', completedOutput({ output: SENTINEL, session_id: HANDLE, exit_code: 0 })));
      const result = inspectShellWaitEvidence(evidenceInput({ rollouts }));
      assert.equal(result.status, 'supported');
      assert.equal(result.facts.completion.qualified, true);
      rollouts[1][5].payload.arguments = JSON.stringify({ cell_id: 'foreign-cell' });
      assert.equal(inspectShellWaitEvidence(evidenceInput({ rollouts })).facts.completion.qualified, false);
    });

    test('multi-statement missing result never borrows a later terminal result', () => {
      const rollouts = fullRollouts();
      rollouts[1].splice(3, 2, statementCell('observe', [preparationCall().payload.input.trimEnd(),
        inlineStatement('write_stdin', { session_id: HANDLE, chars: '' })]),
      cellOutput('observe', [{ output: SENTINEL, session_id: HANDLE, exit_code: 0 }]));
      const result = inspectShellWaitEvidence(evidenceInput({ rollouts }));
      assert.equal(result.status, 'supported');
      assert.equal(result.facts.completion.qualified, false);
    });

    test('a pending multi-statement cell with every result present stays unresolved', () => {
      const rollouts = fullRollouts();
      const output = [
        { type: 'input_text', text: 'Script running with cell ID live-cell\n' },
        { type: 'input_text', text: JSON.stringify({ output: '', session_id: HANDLE }) },
        { type: 'input_text', text: JSON.stringify({ output: SENTINEL, session_id: HANDLE, exit_code: 0 }) },
      ];
      rollouts[1] = [childMeta(),
        wrappedCall('exec_command', 'launch-1', { cmd: LAUNCHER, workdir: '/installed/workspace' }),
        callOutput('launch-1', completedOutput({ output: '', session_id: HANDLE })),
        statementCell('observe', [
          inlineStatement('write_stdin', { session_id: HANDLE, chars: '' }),
          inlineStatement('write_stdin', { session_id: HANDLE, chars: '' }),
        ]), callOutput('observe', output)];
      const result = inspectShellWaitEvidence(evidenceInput({ rollouts }));
      assert.equal(result.status, 'supported');
      assert.equal(result.facts.completion.qualified, false,
        'a cell that reports every result while its pending header stands must never qualify');
      assert.equal(result.facts.observations.pendingInnerAtEnd, true);
    });

    test('whole-cell wall time is recorded separately, never as one observation duration', () => {
      const rollouts = fullRollouts();
      const output = [
        { type: 'input_text', text: 'Wall time 120.0 seconds\n' },
        { type: 'input_text', text: JSON.stringify({ output: '', session_id: HANDLE }) },
        { type: 'input_text', text: JSON.stringify({ output: SENTINEL, session_id: HANDLE, exit_code: 0 }) },
      ];
      rollouts[1] = [childMeta(),
        wrappedCall('exec_command', 'launch-1', { cmd: LAUNCHER, workdir: '/installed/workspace' }),
        callOutput('launch-1', completedOutput({ output: '', session_id: HANDLE })),
        statementCell('observe', [
          inlineStatement('write_stdin', { session_id: HANDLE, chars: '', yield_time_ms: 60000 }),
          inlineStatement('write_stdin', { session_id: HANDLE, chars: '', yield_time_ms: 60000 }),
        ]), callOutput('observe', output)];
      const result = inspectShellWaitEvidence(evidenceInput({ rollouts }));
      assert.equal(result.status, 'supported');
      assert.equal(result.facts.completion.qualified, false);
      assert.match(result.facts.completion.reason, /batching.*terminal observation discipline/i);
      assert.equal(result.facts.observations.decisiveWallMs, null,
        'two 60000-ms polls in one 120-second cell must not report a 120-second observation');
      assert.equal(result.facts.observations.cellWallTimeMs, 120000);
    });

    test('two sequential 60000-ms empty-input polls in one cell violate the batching discipline', () => {
      const rollouts = fullRollouts();
      rollouts[1].splice(3, 2, statementCell('batched-polls', [
        inlineStatement('write_stdin', { session_id: HANDLE, chars: '', yield_time_ms: 60000 }),
        inlineStatement('write_stdin', { session_id: HANDLE, chars: '', yield_time_ms: 60000 }),
      ]), cellOutput('batched-polls', [
        { output: '', session_id: HANDLE },
        { output: SENTINEL, session_id: HANDLE, exit_code: 0 },
      ]));
      const result = inspectShellWaitEvidence(evidenceInput({ rollouts }));
      assert.equal(result.status, 'supported');
      assert.equal(result.facts.completion.qualified, false);
      assert.match(result.facts.completion.reason, /batching.*terminal observation discipline/i);
      assert.equal(result.facts.handle.pollCount, 2);
      assert.equal(result.facts.handle.overlappingInnerPolls, 0);
      assert.equal(result.facts.observations.outerReturns, 0);
      assert.equal(result.facts.observations.decisiveWallMs, null);
      const mapped = mapShellWaitLiveFacts({ case: 'rescue-baseline' }, {
        endedBeforeGate: false, budgetExpired: false, result: { code: 0 },
        cleanup: { releasedGate: true, errors: [] },
      }, result, '0.160.1');
      assert.match(mapped.inconclusive.reason, /batching.*terminal observation discipline/i);
    });

    test('batched polls completed through one outer continuation violate the batching discipline', () => {
      const rollouts = fullRollouts();
      rollouts[1].splice(3, 2, statementCell('batched-polls', [
        inlineStatement('write_stdin', { session_id: HANDLE, chars: '', yield_time_ms: 60000 }),
        inlineStatement('write_stdin', { session_id: HANDLE, chars: '', yield_time_ms: 60000 }),
      ]), callOutput('batched-polls', [...pendingOutput('batched-cell'),
        { type: 'input_text', text: JSON.stringify({ output: '', session_id: HANDLE }) },
      ]), fnCall('wait', 'continue', { cell_id: 'batched-cell' }),
      fnOutput('continue', completedOutput({ output: SENTINEL, session_id: HANDLE, exit_code: 0 })));
      const result = inspectShellWaitEvidence(evidenceInput({ rollouts }));
      assert.equal(result.status, 'supported');
      assert.equal(result.facts.handle.pollCount, 2);
      assert.equal(result.facts.handle.overlappingInnerPolls, 0);
      assert.equal(result.facts.observations.outerReturns, 1);
      assert.equal(result.facts.observations.pendingInnerAtEnd, false);
      assert.equal(result.facts.completion.qualified, false);
      assert.match(result.facts.completion.reason, /batching.*terminal observation discipline/i);
      const mapped = mapShellWaitLiveFacts({ case: 'rescue-baseline' }, {
        endedBeforeGate: false, budgetExpired: false, result: { code: 0 },
        cleanup: { releasedGate: true, errors: [] },
      }, result, '0.160.1');
      assert.match(mapped.inconclusive.reason, /batching.*terminal observation discipline/i);
    });

    test('a yielded single poll resolved by an exact-cell continuation still qualifies', () => {
      const rollouts = fullRollouts();
      rollouts[1][4] = callOutput('poll-1', pendingOutput('single-cell'));
      rollouts[1].push(fnCall('wait', 'continue', { cell_id: 'single-cell' }),
        fnOutput('continue', completedOutput({ output: SENTINEL, session_id: HANDLE, exit_code: 0 })));
      const result = inspectShellWaitEvidence(evidenceInput({ rollouts }));
      assert.equal(result.status, 'supported');
      assert.equal(result.facts.handle.pollCount, 1);
      assert.equal(result.facts.handle.overlappingInnerPolls, 0);
      assert.equal(result.facts.observations.outerReturns, 1);
      assert.equal(result.facts.observations.pendingInnerAtEnd, false);
      assert.equal(result.facts.completion.qualified, true);
      assert.equal(result.facts.completion.reason, null);
    });

    for (const badLine of ['console.log("extra");', 'text(await tools.exec_command({cmd: @broken}));', '']) {
      test(`multi-statement cell fails closed for unsupported line ${JSON.stringify(badLine)}`, () => {
        const rollouts = fullRollouts();
        rollouts[1].splice(1, 0, statementCell('bad', [inlineStatement('exec_command', { cmd: 'cat skill.md' }), badLine]));
        const result = inspectShellWaitEvidence(evidenceInput({ rollouts }));
        assert.equal(result.status, 'inconclusive');
        assert.equal(result.inconclusive.reason, 'unsupported-call-shape');
      });
    }

    test('multi-statement cell supports exactly 16 statements and rejects 17', () => {
      for (const count of [16, 17]) {
        const rollouts = fullRollouts();
        rollouts[1].splice(1, 0, statementCell('diagnostics', Array.from({ length: count }, () => inlineStatement('exec_command', { cmd: 'cat skill.md' }))),
          cellOutput('diagnostics', Array.from({ length: count }, () => ({ output: '', exit_code: 0 }))));
        const result = inspectShellWaitEvidence(evidenceInput({ rollouts }));
        assert.equal(result.status, count === 16 ? 'supported' : 'inconclusive');
        if (count === 16) assert.equal(result.facts.completion.qualified, true);
      }
    });

    test('duplicate launcher in a multi-statement cell violates the single launch rule', () => {
      const rollouts = fullRollouts();
      rollouts[1].splice(1, 2, statementCell('duplicates', [inlineStatement('exec_command', { cmd: LAUNCHER }), inlineStatement('exec_command', { cmd: LAUNCHER })]),
        cellOutput('duplicates', [{ output: '', session_id: HANDLE }, { output: '', session_id: 92 }]));
      const result = inspectShellWaitEvidence(evidenceInput({ rollouts }));
      assert.equal(result.status, 'supported');
      assert.equal(result.facts.companion.launchCount, 2);
      assert.equal(result.facts.completion.qualified, false);
      assert.match(result.facts.completion.reason, /additional|2 times/);
    });

    test('post-launch unrelated exec in the same cell remains a violation', () => {
      const rollouts = fullRollouts();
      rollouts[1].splice(1, 2, statementCell('pollution', [inlineStatement('exec_command', { cmd: LAUNCHER }), inlineStatement('exec_command', { cmd: 'npm test' })]),
        cellOutput('pollution', [{ output: '', session_id: HANDLE }, { output: 'ok', exit_code: 0 }]));
      const result = inspectShellWaitEvidence(evidenceInput({ rollouts }));
      assert.equal(result.status, 'supported');
      assert.equal(result.facts.completion.qualified, false);
      assert.match(result.facts.completion.reason, /additional/);
    });

    test('pre-launch diagnostic whose response overlaps the launcher remains a violation', () => {
      const rollouts = fullRollouts();
      rollouts[1].splice(1, 0, fnCall('exec_command', 'diagnostic', { cmd: 'cat skill.md' }));
      rollouts[1].push(fnOutput('diagnostic', completedOutput({ output: '', exit_code: 0 })));
      const result = inspectShellWaitEvidence(evidenceInput({ rollouts }));
      assert.equal(result.facts.completion.qualified, false);
      assert.match(result.facts.completion.reason, /overlap/);
    });

    test('an inline directive-led single-quoted write_stdin poll parses through the literal fallback', () => {
      const pollInput = '// @exec: {"yield_time_ms": 3600000}\ntext(await tools.write_stdin({session_id:91,chars:\'\',yield_time_ms:3600000}));\n';
      const rollouts = [fullRollouts()[0], [
        childMeta(),
        { type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'launch-1', input: `text(await tools.exec_command({cmd:${JSON.stringify(LAUNCHER)},workdir:"/installed/workspace"}));\n` } },
        callOutput('launch-1', completedOutput({ output: '', session_id: HANDLE })),
        { type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'poll-1', input: pollInput } },
        callOutput('poll-1', completedOutput({ output: SENTINEL, exit_code: 0, session_id: HANDLE })),
      ]];
      const result = inspectShellWaitEvidence(evidenceInput({ rollouts }));
      assert.equal(result.status, 'supported');
      assert.equal(result.facts.handle.pollCount, 1, 'the inline single-quoted empty-input poll must count as the observation');
      assert.equal(result.facts.completion.qualified, true);
    });

    test('a corrupted inline wrapper literal stays inconclusive with manual adjudication', () => {
      const rollouts = [[
        sessionMeta(PARENT),
        { type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'bad-1', input: 'text(await tools.exec_command({cmd: @broken}));\n' } },
      ]];
      const result = inspectShellWaitEvidence({ ...evidenceInput(), rollouts });
      assert.equal(result.status, 'inconclusive');
      assert.equal(result.inconclusive.reason, 'unsupported-call-shape');
      assert.equal(result.inconclusive.manualAdjudicationRequired, true);
    });

    test('the sanctioned private v5 preparation frame is a supported one-shot write, not input injection', () => {
      // The exact wrapped shape observed live in the CHILD rollout (Task 4 Case 0).
      const preparationInput = 'text(await tools.write_stdin({session_id:91,chars:JSON.stringify({version:5,source:"explicit",task:"Perform shell-wait-probe-fixture-task. Run exactly `npm test` as the safe deterministic fixture action.",options:{hostPlacement:"foreground",companionExecution:"foreground",foregroundAdapter:"shell",resume:"fresh"},continuationTarget:null})+"\\n",max_output_tokens:1000}));\n';
      const rollouts = [fullRollouts()[0], [
        childMeta(),
        wrappedCall('exec_command', 'launch-1', { cmd: LAUNCHER, workdir: '/installed/workspace' }),
        callOutput('launch-1', completedOutput({ output: '', session_id: HANDLE })),
        { type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'prep-1', input: preparationInput } },
        callOutput('prep-1', completedOutput({ output: 'frame accepted', session_id: HANDLE })),
        wrappedCall('write_stdin', 'poll-1', { session_id: HANDLE, chars: '', yield_time_ms: 60000 }),
        callOutput('poll-1', completedOutput({ output: SENTINEL, exit_code: 0, session_id: HANDLE })),
      ]];
      const result = inspectShellWaitEvidence(evidenceInput({ rollouts }));
      assert.equal(result.status, 'supported', 'the sanctioned v5 preparation frame must parse as a supported shape');
      assert.equal(result.facts.handle.preparationFrameWrites, 1);
      assert.equal(result.facts.handle.pollCount, 1, 'the preparation frame is a write, not a poll');
      assert.equal(result.facts.completion.qualified, true, 'the one-shot preparation frame must not block a qualified completion');
    });

    function preparationEnvelope() {
      return {
        version: 5, source: 'explicit', task: 't',
        options: { hostPlacement: 'foreground', companionExecution: 'foreground', foregroundAdapter: 'shell', resume: 'fresh' },
        continuationTarget: null,
      };
    }
    function preparationCall(envelope = preparationEnvelope(), suffix = '\\n') {
      return { type: 'response_item', payload: {
        type: 'custom_tool_call', name: 'exec', call_id: 'prep-1',
        input: `text(await tools.write_stdin({session_id:${HANDLE},chars:JSON.stringify(${JSON.stringify(envelope)})+"${suffix}"}));\n`,
      } };
    }
    function inspectPreparationWrite(call, afterObservation = false) {
      const rollouts = fullRollouts();
      rollouts[1].splice(afterObservation ? 5 : 3, 0,
        call, callOutput('prep-1', completedOutput({ output: '', session_id: HANDLE })),
      );
      return inspectShellWaitEvidence(evidenceInput({ rollouts }));
    }
    function assertPreparationRejected(result) {
      assert.notEqual(result.facts?.completion.qualified, true, 'an invalid preparation write must never qualify completion');
      if (result.status === 'supported') assert.equal(result.facts.handle.preparationFrameWrites, 0);
      else assert.equal(result.inconclusive.reason, 'unsupported-call-shape');
    }

    test('a missing preparation response remains unresolved through a later terminal poll', () => {
      const rollouts = fullRollouts();
      rollouts[1].splice(3, 0, preparationCall());
      const result = inspectShellWaitEvidence(evidenceInput({ rollouts }));
      assert.equal(result.facts.completion.qualified, false);
      assert.equal(result.facts.handle.preparationFrameWrites, 1);
      assert.equal(result.facts.handle.pollCount, 1);
      assert.equal(result.facts.handle.overlappingInnerPolls, 1);
      assert.equal(result.facts.observations.pendingInnerAtEnd, true);
    });

    test('a pending preparation response prevents terminal qualification', () => {
      const rollouts = fullRollouts();
      rollouts[1].splice(3, 0, preparationCall(), callOutput('prep-1', pendingOutput('prep-cell')));
      const result = inspectShellWaitEvidence(evidenceInput({ rollouts }));
      assert.equal(result.facts.completion.qualified, false);
      assert.equal(result.facts.handle.pollCount, 1);
      assert.equal(result.facts.handle.overlappingInnerPolls, 1);
      // Without a later poll, the preparation itself must remain pending.
      rollouts[1].splice(5);
      const pending = inspectShellWaitEvidence(evidenceInput({ rollouts }));
      assert.equal(pending.facts.observations.pendingInnerAtEnd, true);
      assert.equal(pending.facts.handle.pollCount, 0);
    });

    test('a delayed preparation response records an overlapping terminal poll', () => {
      const rollouts = fullRollouts();
      rollouts[1].splice(3, 0, preparationCall());
      rollouts[1].push(callOutput('prep-1', completedOutput({ output: '', session_id: HANDLE })));
      const result = inspectShellWaitEvidence(evidenceInput({ rollouts }));
      assert.equal(result.facts.completion.qualified, false);
      assert.equal(result.facts.handle.overlappingInnerPolls, 1);
      assert.equal(result.facts.handle.pollCount, 1);
    });

    test('a correctly linked continuation settles a pending preparation before polling', () => {
      const rollouts = fullRollouts();
      rollouts[1].splice(3, 0,
        preparationCall(), callOutput('prep-1', pendingOutput('prep-cell')),
        fnCall('wait', 'prep-wait', { cell_id: 'prep-cell' }),
        fnOutput('prep-wait', completedOutput({ output: '', session_id: HANDLE })),
      );
      const result = inspectShellWaitEvidence(evidenceInput({ rollouts }));
      assert.equal(result.facts.completion.qualified, true);
      assert.equal(result.facts.observations.pendingInnerAtEnd, false);
      assert.equal(result.facts.handle.overlappingInnerPolls, 0);
      assert.equal(result.facts.handle.pollCount, 1);
      assert.equal(result.facts.handle.preparationFrameWrites, 1);
    });

    for (const [name, replace] of [
      ['top-level version', (json) => json.replace('"version":5', '"version":4,"version":5')],
      ['nested option', (json) => json.replace('"resume":"fresh"', '"resume":"resume","resume":"fresh"')],
      ['escaped nested option', (json) => json.replace('"resume":"fresh"', '"resume":"resume","resu\\u006de":"fresh"')],
    ]) {
      test(`raw preparation frames reject duplicate ${name} keys like the production reader`, async () => {
        const { Readable } = await import('node:stream');
        const { readRescuePreparation } = await import('../scripts/lib/rescue-preparation.mjs');
        const chars = `${replace(JSON.stringify(preparationEnvelope()))}\n`;
        await assert.rejects(readRescuePreparation(Readable.from([chars])), { code: 'RESCUE_PREPARATION_INVALID' });
        assertPreparationRejected(inspectPreparationWrite(fnCall('write_stdin', 'prep-1', { session_id: HANDLE, chars })));
      });
    }

    test('preparation exception rejects an incomplete version 5 envelope', () => {
      assertPreparationRejected(inspectPreparationWrite(preparationCall({ version: 5 })));
    });

    test('preparation exception rejects a valid envelope followed by literal newline BAD newline', () => {
      assertPreparationRejected(inspectPreparationWrite(preparationCall(preparationEnvelope(), '\nBAD\n')));
    });

    test('preparation exception rejects object-valued chars with caller-supplied preparation true', () => {
      const result = inspectPreparationWrite(fnCall('write_stdin', 'prep-1', {
        session_id: HANDLE, chars: preparationEnvelope(), preparation: true,
      }));
      assertPreparationRejected(result);
      assert.equal(result.facts.handle.pollCount, 2, 'caller arguments cannot hide an observation from the count');
    });

    test('preparation exception rejects an envelope written after a terminal observation', () => {
      const result = inspectPreparationWrite(preparationCall(), true);
      assertPreparationRejected(result);
      assert.match(result.facts.completion.reason, /preparation.*after.*observation/u);
    });

    test('preparation exception rejects an envelope written after a nonterminal observation', () => {
      const rollouts = fullRollouts();
      rollouts[1].splice(3, 0,
        wrappedCall('write_stdin', 'early-poll', { session_id: HANDLE, chars: '' }),
        callOutput('early-poll', completedOutput({ output: '', session_id: HANDLE })),
        preparationCall(), callOutput('prep-1', completedOutput({ output: '', session_id: HANDLE })),
      );
      const result = inspectShellWaitEvidence(evidenceInput({ rollouts }));
      assertPreparationRejected(result);
      assert.match(result.facts.completion.reason, /preparation.*after.*observation/u);
    });

    test('preparation exception validates the production envelope fields and option constraints', () => {
      const valid = preparationEnvelope();
      const invalid = [
        { ...valid, source: 'unknown' }, { ...valid, task: 1 }, { ...valid, task: ' ' },
        { ...valid, task: 't'.repeat(64 * 1024 + 1) }, { ...valid, extra: true },
        { ...valid, options: [] }, { ...valid, continuationTarget: {} },
        { ...valid, continuationTarget: { agentPath: AGENT_PATH } },
        ...['hostPlacement', 'companionExecution', 'foregroundAdapter'].map((key) => {
          const options = { ...valid.options }; delete options[key];
          return { ...valid, options };
        }),
        ...[
          { hostPlacement: true }, { companionExecution: 'unknown' }, { foregroundAdapter: 5 },
          { hostPlacement: 'background', companionExecution: 'background' },
          { resume: false }, { effort: 'unknown' }, { model: null }, { model: 'bad\nmodel' }, { extra: true },
        ].map((options) => ({ ...valid, options: { ...valid.options, ...options } })),
      ];
      for (const envelope of invalid) {
        assertPreparationRejected(inspectPreparationWrite(fnCall('write_stdin', 'prep-1', {
          session_id: HANDLE, chars: `${JSON.stringify(envelope)}\n`,
        })));
      }
    });

    test('preparation exception requires exactly one terminating LF on direct writes', () => {
      const json = JSON.stringify(preparationEnvelope());
      for (const chars of [json, `${json}\n\n`, `${json}\nBAD\n`, `${json}\r\n`, `${json}\n `]) {
        assertPreparationRejected(inspectPreparationWrite(fnCall('write_stdin', 'prep-1', { session_id: HANDLE, chars })));
      }
      const result = inspectPreparationWrite(fnCall('write_stdin', 'prep-1', { session_id: HANDLE, chars: `${json}\n` }));
      assert.equal(result.facts.completion.qualified, true);
      assert.equal(result.facts.handle.preparationFrameWrites, 1);
      assert.equal(result.facts.handle.pollCount, 1);
    });

    test('a second preparation frame, a foreign-handle frame, or a wrong envelope is a violation', () => {
      const preparationInput = (sessionId, version) => `text(await tools.write_stdin({session_id:${sessionId},chars:JSON.stringify(${JSON.stringify({ ...preparationEnvelope(), version })})+"\\n"}));\n`;
      // The base already carries the ONE sanctioned v5 frame on the original handle.
      const base = () => [fullRollouts()[0], [
        childMeta(),
        wrappedCall('exec_command', 'launch-1', { cmd: LAUNCHER, workdir: '/installed/workspace' }),
        callOutput('launch-1', completedOutput({ output: '', session_id: HANDLE })),
        { type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'prep-1', input: preparationInput(HANDLE, 5) } },
        callOutput('prep-1', completedOutput({ output: 'frame accepted', session_id: HANDLE })),
        wrappedCall('write_stdin', 'poll-1', { session_id: HANDLE, chars: '', yield_time_ms: 60000 }),
        callOutput('poll-1', completedOutput({ output: SENTINEL, exit_code: 0, session_id: HANDLE })),
      ]];
      const qualifiedBase = inspectShellWaitEvidence(evidenceInput({ rollouts: base() }));
      assert.equal(qualifiedBase.facts.completion.qualified, true, 'the base with the one sanctioned frame must qualify');
      const duplicate = base();
      duplicate[1].splice(5, 0,
        { type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'prep-2', input: preparationInput(HANDLE, 5) } },
        callOutput('prep-2', completedOutput({ output: '', session_id: HANDLE })),
      );
      assert.match(inspectShellWaitEvidence(evidenceInput({ rollouts: duplicate })).facts.completion.reason, /second private preparation frame/u);
      const foreign = base();
      foreign[1].splice(5, 0,
        { type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'prep-3', input: preparationInput(999, 5) } },
        callOutput('prep-3', completedOutput({ output: '', session_id: 999 })),
      );
      assert.match(inspectShellWaitEvidence(evidenceInput({ rollouts: foreign })).facts.completion.reason, /second private preparation frame/u, 'a later frame is a duplicate even when its handle is also foreign');
      const foreignFirst = base();
      foreignFirst[1].splice(3, 2); // remove the sanctioned frame and its response
      foreignFirst[1].splice(3, 0,
        { type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'prep-3', input: preparationInput(999, 5) } },
        callOutput('prep-3', completedOutput({ output: '', session_id: 999 })),
      );
      assert.match(inspectShellWaitEvidence(evidenceInput({ rollouts: foreignFirst })).facts.completion.reason, /foreign handle/u);
      const wrongVersion = base();
      wrongVersion[1].splice(5, 0,
        { type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'prep-4', input: preparationInput(HANDLE, 4) } },
        callOutput('prep-4', completedOutput({ output: '', session_id: HANDLE })),
      );
      const wrongVersionResult = inspectShellWaitEvidence(evidenceInput({ rollouts: wrongVersion }));
      assert.equal(wrongVersionResult.facts.completion.qualified, false, 'a second preparation frame must block qualification even with a wrong envelope');
      assert.match(wrongVersionResult.facts.completion.reason, /second private preparation frame/u);
    });

    test('a direct function-call rollout shape is observed identically to the wrapper shape', () => {
      const rollouts = fullRollouts();
      const child = rollouts[1];
      child[1] = wrappedCall('exec_command', 'launch-1', { cmd: LAUNCHER }, 'function_call');
      child[2] = fnOutput('launch-1', completedOutput({ output: '', session_id: HANDLE }));
      child[3] = wrappedCall('write_stdin', 'poll-1', { session_id: HANDLE, chars: '', yield_time_ms: 60000 }, 'function_call');
      child[4] = fnOutput('poll-1', completedOutput({ output: SENTINEL, exit_code: 0 }));
      const result = inspectShellWaitEvidence(evidenceInput({ rollouts }));
      assert.equal(result.facts.completion.qualified, true);
    });

    test('an incomplete child start event cannot qualify the Rescue linkage', () => {
      const rollouts = fullRollouts();
      rollouts[0] = rollouts[0].filter((event) => event !== rollouts[0][2]);
      const result = inspectShellWaitEvidence(evidenceInput({ rollouts }));
      assert.equal(result.facts.linkage.exact, false);
      assert.match(result.facts.linkage.reason, /start/i);
      assert.equal(result.facts.completion.qualified, false);
    });

    test('a wrong child parent linkage cannot qualify the Rescue linkage', () => {
      const rollouts = fullRollouts();
      rollouts[1][0] = childMeta({ parent_thread_id: 'other-parent' });
      const result = inspectShellWaitEvidence(evidenceInput({ rollouts }));
      assert.equal(result.facts.linkage.exact, false);
      assert.match(result.facts.linkage.reason, /parent/i);
      assert.equal(result.facts.completion.qualified, false);
    });

    test('a duplicate companion launch is a violation and cannot qualify completion', () => {
      const rollouts = fullRollouts();
      rollouts[1].push(wrappedCall('exec_command', 'launch-2', { cmd: LAUNCHER }));
      rollouts[1].push(callOutput('launch-2', completedOutput({ output: '', session_id: 92 })));
      const result = inspectShellWaitEvidence(evidenceInput({ rollouts }));
      assert.equal(result.facts.companion.launchCount, 2);
      assert.equal(result.facts.companion.duplicateLaunch, true);
      assert.equal(result.facts.completion.qualified, false);
    });

    test('an overlapping inner poll while one is pending is a violation', () => {
      const rollouts = fullRollouts();
      rollouts[1].splice(4, 1); // keep poll-1 pending
      rollouts[1].push(wrappedCall('write_stdin', 'poll-2', { session_id: HANDLE, chars: '', yield_time_ms: 60000 }));
      rollouts[1].push(callOutput('poll-2', completedOutput({ output: SENTINEL, exit_code: 0 })));
      const result = inspectShellWaitEvidence(evidenceInput({ rollouts }));
      assert.ok(result.facts.handle.overlappingInnerPolls >= 1);
      assert.equal(result.facts.completion.qualified, false);
    });

    test('a live pending cell at the end cannot qualify completion', () => {
      const rollouts = fullRollouts();
      rollouts[1][4] = callOutput('poll-1', pendingOutput('cell-7'));
      const result = inspectShellWaitEvidence(evidenceInput({ rollouts }));
      assert.equal(result.facts.observations.pendingInnerAtEnd, true);
      assert.equal(result.facts.completion.qualified, false);
      assert.equal(result.facts.completion.decisiveEnd, 'cell-pending');
    });

    test('a cap return while the worker remains alive cannot qualify completion', () => {
      const rollouts = fullRollouts();
      rollouts[1][4] = callOutput('poll-1', completedOutput({ output: '', session_id: HANDLE }));
      const result = inspectShellWaitEvidence(evidenceInput({ rollouts, workerStillAliveAfterObservation: true, observedWallMs: 31_000, workerDurationMs: 420_000 }));
      assert.equal(result.facts.completion.qualified, false);
      assert.equal(result.facts.completion.decisiveEnd, 'yield-expiry');
      assert.equal(result.facts.observations.decisiveWallMs, 31_000);
      assert.equal(result.facts.observations.remainingLifetimeMs, 389_000);
    });

    test('a truncated direct function-call shape is inconclusive, never silently zero', () => {
      const rollouts = fullRollouts();
      rollouts[1][1] = { type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'launch-1', arguments: '{"cmd": "trunc' } };
      const privatePath = '/private/var/folders/ww/shell-wait-fixture-secret/codex-home';
      const result = inspectShellWaitEvidence(evidenceInput({ rollouts, redactions: [privatePath] }));
      assert.equal(result.status, 'inconclusive');
      assert.match(result.inconclusive.reason, /unsupported|truncated/i);
      assert.match(result.inconclusive.excerpt.text, /cmd/);
      assert.doesNotMatch(result.inconclusive.excerpt.text, new RegExp(escapeRegExp(privatePath)));
    });

    test('the direct-exec header form (Wall time: N seconds) feeds decisiveWallMs without a harness override', () => {
      const rollouts = fullRollouts();
      rollouts[1][4] = callOutput('poll-1', [
        { type: 'input_text', text: 'Wall time: 31.0000 seconds\n' },
        { type: 'input_text', text: JSON.stringify({ output: '', session_id: HANDLE }) },
      ]);
      const result = inspectShellWaitEvidence(evidenceInput({ rollouts, workerStillAliveAfterObservation: true, workerDurationMs: 420_000 }));
      assert.equal(result.status, 'supported');
      assert.equal(result.facts.observations.decisiveWallMs, 31_000);
      assert.equal(result.facts.observations.remainingLifetimeMs, 389_000);
      assert.equal(result.facts.completion.qualified, false);
      assert.equal(result.facts.completion.decisiveEnd, 'yield-expiry');
    });

    test('the code-mode wrapper/cell header form (Wall time N seconds, no colon) feeds decisiveWallMs too', () => {
      const rollouts = fullRollouts();
      rollouts[1][4] = callOutput('poll-1', [
        { type: 'input_text', text: 'running\nWall time 384.6 seconds\nOutput:\n' },
        { type: 'input_text', text: JSON.stringify({ output: '', session_id: HANDLE }) },
      ]);
      const result = inspectShellWaitEvidence(evidenceInput({ rollouts, workerStillAliveAfterObservation: true, workerDurationMs: 420_000 }));
      assert.equal(result.status, 'supported');
      assert.equal(result.facts.observations.decisiveWallMs, 384_600);
      assert.equal(result.facts.observations.remainingLifetimeMs, 35_400);
      assert.equal(result.facts.completion.qualified, false);
      assert.equal(result.facts.completion.decisiveEnd, 'yield-expiry');
    });

    test('an unknown or truncated call shape is inconclusive with a sanitized excerpt, not a zero count', () => {
      const rollouts = fullRollouts();
      rollouts[1][1] = { type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'launch-1', input: 'const r = await tools.' } };
      const privatePath = '/private/var/folders/ww/shell-wait-fixture-secret/codex-home';
      const result = inspectShellWaitEvidence(evidenceInput({ rollouts, redactions: [privatePath] }));
      assert.equal(result.status, 'inconclusive');
      assert.match(result.inconclusive.reason, /unsupported|truncated/i);
      assert.equal(result.inconclusive.manualAdjudicationRequired, true);
      assert.ok(result.inconclusive.excerpt.text.length > 0);
      assert.doesNotMatch(result.inconclusive.excerpt.text, new RegExp(escapeRegExp(privatePath)), 'the excerpt must be scrubbed');
    });

    test('an invocation quoted inside a message is never inferred as a call', () => {
      const rollouts = fullRollouts();
      rollouts[1] = [childMeta(), quotedMessage()];
      const result = inspectShellWaitEvidence(evidenceInput({ rollouts, zcodeCalls: null }));
      assert.equal(result.status, 'supported');
      assert.equal(result.facts.companion.launchCount, 0);
      assert.equal(result.facts.completion.qualified, false);
      assert.equal(result.facts.companion.sendCount, null, 'an unavailable fake-peer record stays unknown, not zero');
    });

    test('an outer continuation must reference the pending cell of the original handle to count', () => {
      const rollouts = fullRollouts();
      rollouts[1][4] = callOutput('poll-1', pendingOutput('cell-7'));
      // A foreign cell reference returning the sentinel must NOT fabricate terminal linkage.
      rollouts[1].push(fnCall('wait', 'outer-1', { session_id: HANDLE, cell_id: 'cell-999' }));
      rollouts[1].push(fnOutput('outer-1', completedOutput({ output: SENTINEL, exit_code: 0 })));
      const result = inspectShellWaitEvidence(evidenceInput({ rollouts }));
      assert.equal(result.status, 'supported');
      assert.equal(result.facts.completion.qualified, false, 'a foreign-cell continuation cannot qualify completion');
      assert.match(result.facts.completion.reason, /linkage/i);
      assert.equal(result.facts.observations.pendingInnerAtEnd, true, 'the original cell remains pending');
    });

    test('a conflicting alias reference cannot qualify a foreign wait result', () => {
      const rollouts = fullRollouts();
      rollouts[1][4] = callOutput('poll-1', pendingOutput('owned-cell'));
      rollouts[1].push(fnCall('wait', 'outer-1', { session_id: HANDLE, cell_id: 'foreign-cell', id: 'owned-cell' }));
      rollouts[1].push(fnOutput('outer-1', completedOutput({ output: SENTINEL, exit_code: 0 })));
      const result = inspectShellWaitEvidence(evidenceInput({ rollouts }));
      assert.equal(result.facts.completion.qualified, false, 'a foreign cell_id with a matching alias is still a conflicting linkage');
      assert.equal(result.facts.observations.pendingInnerAtEnd, true, 'the original cell remains pending');
    });

    test('a non-string canonical cell_id is a malformed reference, never coerced', () => {
      const rollouts = fullRollouts();
      rollouts[1][4] = callOutput('poll-1', pendingOutput('cell-7'));
      rollouts[1].push(fnCall('wait', 'outer-1', { session_id: HANDLE, cell_id: ['cell-7'] }));
      rollouts[1].push(fnOutput('outer-1', completedOutput({ output: SENTINEL, exit_code: 0 })));
      const result = inspectShellWaitEvidence(evidenceInput({ rollouts }));
      assert.equal(result.facts.completion.qualified, false, 'an array cell_id must not be string-coerced into a match');
      assert.equal(result.facts.observations.pendingInnerAtEnd, true);
    });

    test('non-string alias values are malformed references even when they stringify to the pending cell', () => {
      for (const aliasValue of [['cell-7'], { cell: 'cell-7' }]) {
        const rollouts = fullRollouts();
        rollouts[1][4] = callOutput('poll-1', pendingOutput('cell-7'));
        rollouts[1].push(fnCall('wait', 'outer-1', { session_id: HANDLE, cell_id: 'cell-7', id: aliasValue }));
        rollouts[1].push(fnOutput('outer-1', completedOutput({ output: SENTINEL, exit_code: 0 })));
        const result = inspectShellWaitEvidence(evidenceInput({ rollouts }));
        assert.equal(result.facts.completion.qualified, false, `a ${typeof aliasValue} alias must not be coerced into a match`);
        assert.equal(result.facts.observations.pendingInnerAtEnd, true);
      }
    });

    test('an alias-only reference without the canonical cell_id is not sufficient', () => {
      const rollouts = fullRollouts();
      rollouts[1][4] = callOutput('poll-1', pendingOutput('cell-7'));
      rollouts[1].push(fnCall('wait', 'outer-1', { session_id: HANDLE, id: 'cell-7' }));
      rollouts[1].push(fnOutput('outer-1', completedOutput({ output: SENTINEL, exit_code: 0 })));
      const result = inspectShellWaitEvidence(evidenceInput({ rollouts }));
      assert.equal(result.facts.completion.qualified, false, 'an alias without the canonical cell_id cannot resolve the pending cell');
      assert.equal(result.facts.observations.pendingInnerAtEnd, true);
    });

    test('an outer continuation with missing linkage is rejected, never accepted as terminal', () => {
      const rollouts = fullRollouts();
      rollouts[1][4] = callOutput('poll-1', pendingOutput('cell-7'));
      rollouts[1].push(fnCall('wait', 'outer-1', {}));
      rollouts[1].push(fnOutput('outer-1', completedOutput({ output: SENTINEL, exit_code: 0 })));
      const result = inspectShellWaitEvidence(evidenceInput({ rollouts }));
      assert.equal(result.facts.completion.qualified, false);
      assert.equal(result.facts.observations.pendingInnerAtEnd, true);
    });

    test('a linked outer continuation resolving the exact pending original-handle cell qualifies', () => {
      const rollouts = fullRollouts();
      rollouts[1][4] = callOutput('poll-1', pendingOutput('cell-7'));
      rollouts[1].push(fnCall('wait', 'outer-1', { session_id: HANDLE, cell_id: 'cell-7' }));
      rollouts[1].push(fnOutput('outer-1', completedOutput({ output: SENTINEL, exit_code: 0 })));
      const result = inspectShellWaitEvidence(evidenceInput({ rollouts }));
      assert.equal(result.facts.completion.qualified, true);
      assert.equal(result.facts.observations.pendingInnerAtEnd, false);
      assert.equal(result.facts.completion.processExit, 0);
    });

    test('an intervening same-handle poll before the first response is an overlap in event order', () => {
      const rollouts = fullRollouts();
      // Event order: launch, poll1, poll2, poll1Output(live), poll2Output(sentinel).
      const child = rollouts[1];
      const poll1Call = child[3];
      const poll1Output = child[4];
      const poll2Call = wrappedCall('write_stdin', 'poll-2', { session_id: HANDLE, chars: '', yield_time_ms: 60000 });
      const poll2Output = callOutput('poll-2', completedOutput({ output: SENTINEL, exit_code: 0 }));
      rollouts[1] = [child[0], child[1], child[2], poll1Call, poll2Call, poll1Output, poll2Output];
      const result = inspectShellWaitEvidence(evidenceInput({ rollouts }));
      assert.equal(result.status, 'supported');
      assert.ok(result.facts.handle.overlappingInnerPolls >= 1, 'poll2 must be recognized as overlapping the outstanding poll1');
      assert.equal(result.facts.completion.qualified, false);
      assert.match(result.facts.completion.reason, /discipline|overlap|original-handle/i);
    });

    test('an unparseable poll response keeps blocking qualification through a later successful poll', () => {
      const rollouts = fullRollouts();
      // Event order: poll1 -> unparseable output [] -> poll2 -> terminal sentinel.
      rollouts[1] = [
        childMeta(),
        wrappedCall('exec_command', 'launch-1', { cmd: LAUNCHER }),
        callOutput('launch-1', completedOutput({ output: '', session_id: HANDLE })),
        wrappedCall('write_stdin', 'poll-1', { session_id: HANDLE, chars: '', yield_time_ms: 60000 }),
        callOutput('poll-1', []),
        wrappedCall('write_stdin', 'poll-2', { session_id: HANDLE, chars: '', yield_time_ms: 60000 }),
        callOutput('poll-2', completedOutput({ output: SENTINEL, exit_code: 0 })),
      ];
      const result = inspectShellWaitEvidence(evidenceInput({ rollouts }));
      assert.equal(result.status, 'supported');
      assert.equal(result.facts.completion.qualified, false, 'the unparseable response cannot be established as settled');
      const blocked = result.facts.handle.overlappingInnerPolls >= 1 || result.facts.observations.pendingInnerAtEnd === true;
      assert.equal(blocked, true, 'the ambiguity must remain blocking (overlap or unresolved tail)');
      assert.match(result.facts.completion.reason, /unresolved|overlap|pending|original-handle/i);
    });

    test('sequential same-handle polls resolved in event order stay qualified', () => {
      // Benign ordering: launch, poll1, poll1Output(live), poll2, poll2Output(sentinel).
      const rollouts = fullRollouts();
      const result = inspectShellWaitEvidence(evidenceInput({ rollouts }));
      assert.equal(result.status, 'supported');
      assert.equal(result.facts.handle.overlappingInnerPolls, 0, 'the benign event order must not be flagged as overlapping');
      assert.equal(result.facts.completion.qualified, true);
    });

    test('an exact-cell wait resolves the outstanding observation for the next poll', () => {
      // Sequential trace: poll1 -> pending cell -> exact-cell wait -> completed
      // nonterminal result -> poll2 -> terminal sentinel. The wait's own
      // response resolves poll1, so poll2 must not be flagged as overlapping.
      const rollouts = fullRollouts();
      const poll2Call = wrappedCall('write_stdin', 'poll-2', { session_id: HANDLE, chars: '', yield_time_ms: 60000 });
      const poll2Output = callOutput('poll-2', completedOutput({ output: SENTINEL, exit_code: 0 }));
      const waitCall = fnCall('wait', 'wait-1', { session_id: HANDLE, cell_id: 'cell-9' });
      const waitOutput = fnOutput('wait-1', completedOutput({ output: '', session_id: HANDLE }));
      rollouts[1] = [
        childMeta(),
        wrappedCall('exec_command', 'launch-1', { cmd: LAUNCHER }),
        callOutput('launch-1', completedOutput({ output: '', session_id: HANDLE })),
        wrappedCall('write_stdin', 'poll-1', { session_id: HANDLE, chars: '', yield_time_ms: 60000 }),
        callOutput('poll-1', pendingOutput('cell-9')),
        waitCall,
        waitOutput,
        poll2Call,
        poll2Output,
      ];
      const result = inspectShellWaitEvidence(evidenceInput({ rollouts }));
      assert.equal(result.status, 'supported');
      assert.equal(result.facts.handle.overlappingInnerPolls, 0, 'the exact-cell wait resolved poll1 before poll2 was issued');
      assert.equal(result.facts.completion.qualified, true);
    });

    test('a missing accepted-wait response latches as unresolved evidence', () => {
      const rollouts = fullRollouts();
      // poll1 -> pending cell -> exact-cell wait with NO response -> second
      // exact-cell wait returning the terminal sentinel.
      rollouts[1] = [
        childMeta(),
        wrappedCall('exec_command', 'launch-1', { cmd: LAUNCHER }),
        callOutput('launch-1', completedOutput({ output: '', session_id: HANDLE })),
        wrappedCall('write_stdin', 'poll-1', { session_id: HANDLE, chars: '', yield_time_ms: 60000 }),
        callOutput('poll-1', pendingOutput('cell-9')),
        fnCall('wait', 'wait-1', { session_id: HANDLE, cell_id: 'cell-9' }),
        fnCall('wait', 'wait-2', { session_id: HANDLE, cell_id: 'cell-9' }),
        fnOutput('wait-2', completedOutput({ output: SENTINEL, exit_code: 0 })),
      ];
      const result = inspectShellWaitEvidence(evidenceInput({ rollouts }));
      assert.equal(result.facts.completion.qualified, false, 'the first continuation response is missing; the sentinel cannot be attributed');
      assert.match(result.facts.completion.reason, /continuation|response/i);
    });

    test('an unparseable accepted-wait response latches as unresolved evidence', () => {
      const rollouts = fullRollouts();
      rollouts[1] = [
        childMeta(),
        wrappedCall('exec_command', 'launch-1', { cmd: LAUNCHER }),
        callOutput('launch-1', completedOutput({ output: '', session_id: HANDLE })),
        wrappedCall('write_stdin', 'poll-1', { session_id: HANDLE, chars: '', yield_time_ms: 60000 }),
        callOutput('poll-1', pendingOutput('cell-9')),
        fnCall('wait', 'wait-1', { session_id: HANDLE, cell_id: 'cell-9' }),
        fnOutput('wait-1', []),
        fnCall('wait', 'wait-2', { session_id: HANDLE, cell_id: 'cell-9' }),
        fnOutput('wait-2', completedOutput({ output: SENTINEL, exit_code: 0 })),
      ];
      const result = inspectShellWaitEvidence(evidenceInput({ rollouts }));
      assert.equal(result.facts.completion.qualified, false);
      assert.match(result.facts.completion.reason, /continuation|response/i);
    });

    test('a pending continuation response naming a different cell is contradictory evidence', () => {
      const rollouts = fullRollouts();
      // wait-1 (for cell-9) returns a pending response naming cell-FOREIGN;
      // wait-2 then resolves cell-9 with the terminal sentinel.
      rollouts[1] = [
        childMeta(),
        wrappedCall('exec_command', 'launch-1', { cmd: LAUNCHER }),
        callOutput('launch-1', completedOutput({ output: '', session_id: HANDLE })),
        wrappedCall('write_stdin', 'poll-1', { session_id: HANDLE, chars: '', yield_time_ms: 60000 }),
        callOutput('poll-1', pendingOutput('cell-9')),
        fnCall('wait', 'wait-1', { session_id: HANDLE, cell_id: 'cell-9' }),
        fnOutput('wait-1', pendingOutput('cell-FOREIGN')),
        fnCall('wait', 'wait-2', { session_id: HANDLE, cell_id: 'cell-9' }),
        fnOutput('wait-2', completedOutput({ output: SENTINEL, exit_code: 0 })),
      ];
      const result = inspectShellWaitEvidence(evidenceInput({ rollouts }));
      assert.equal(result.facts.completion.qualified, false, 'contradictory continuation evidence cannot qualify');
      assert.match(result.facts.completion.reason, /different cell|contradict/i);
    });

    test('a parsed pending continuation response is valid evidence and stays qualified-eligible', () => {
      const rollouts = fullRollouts();
      // wait-1 returns a VALID pending continuation for cell-9; wait-2 resolves
      // that exact cell with the terminal sentinel.
      rollouts[1] = [
        childMeta(),
        wrappedCall('exec_command', 'launch-1', { cmd: LAUNCHER }),
        callOutput('launch-1', completedOutput({ output: '', session_id: HANDLE })),
        wrappedCall('write_stdin', 'poll-1', { session_id: HANDLE, chars: '', yield_time_ms: 60000 }),
        callOutput('poll-1', pendingOutput('cell-9')),
        fnCall('wait', 'wait-1', { session_id: HANDLE, cell_id: 'cell-9' }),
        fnOutput('wait-1', pendingOutput('cell-9')),
        fnCall('wait', 'wait-2', { session_id: HANDLE, cell_id: 'cell-9' }),
        fnOutput('wait-2', completedOutput({ output: SENTINEL, exit_code: 0 })),
      ];
      const result = inspectShellWaitEvidence(evidenceInput({ rollouts }));
      assert.equal(result.status, 'supported');
      assert.equal(result.facts.completion.qualified, true, 'a valid pending continuation must not latch a continuation gap');
      assert.equal(result.facts.completion.reason, null);
    });

    test('repeated pending waits without any response stay eligible, never continuation-violations', () => {
      const rollouts = fullRollouts();
      rollouts[1] = [
        childMeta(),
        wrappedCall('exec_command', 'launch-1', { cmd: LAUNCHER }),
        callOutput('launch-1', completedOutput({ output: '', session_id: HANDLE })),
        wrappedCall('write_stdin', 'poll-1', { session_id: HANDLE, chars: '', yield_time_ms: 60000 }),
        callOutput('poll-1', pendingOutput('cell-9')),
        fnCall('wait', 'wait-1', { session_id: HANDLE, cell_id: 'cell-9' }),
        fnCall('wait', 'wait-2', { session_id: HANDLE, cell_id: 'cell-9' }),
      ];
      const result = inspectShellWaitEvidence(evidenceInput({ rollouts }));
      assert.equal(result.status, 'supported');
      assert.equal(result.facts.completion.qualified, false, 'the unresolved cell still blocks completion');
      assert.doesNotMatch(result.facts.completion.reason, /continuation response/i, 'a repeated wait without any response is not a missing-response violation');
      assert.equal(result.facts.observations.pendingInnerAtEnd, true);
    });

    test('a non-empty chars write on the original handle is input injection, not observation', () => {
      const rollouts = fullRollouts();
      rollouts[1][3] = wrappedCall('write_stdin', 'poll-1', { session_id: HANDLE, chars: '\u0003', yield_time_ms: 60000 });
      const result = inspectShellWaitEvidence(evidenceInput({ rollouts }));
      assert.equal(result.status, 'supported');
      assert.equal(result.facts.completion.qualified, false, 'a Control-C injection violates the empty-input observation discipline');
      assert.match(result.facts.completion.reason, /empty input|injection/i);
    });

    test('a malformed chars value on the original handle blocks qualification', () => {
      const rollouts = fullRollouts();
      rollouts[1][3] = wrappedCall('write_stdin', 'poll-1', { session_id: HANDLE, chars: 3, yield_time_ms: 60000 });
      const result = inspectShellWaitEvidence(evidenceInput({ rollouts }));
      assert.equal(result.facts.completion.qualified, false);
      assert.match(result.facts.completion.reason, /chars|malformed/i);
    });

    test('a truncated unsupported direct call is inconclusive, never silently discarded', () => {
      const rollouts = fullRollouts();
      rollouts[1].push({ type: 'response_item', payload: { type: 'function_call', name: 'sleep', call_id: 'sleep-1', arguments: '{"ms":' } });
      const result = inspectShellWaitEvidence(evidenceInput({ rollouts }));
      assert.equal(result.status, 'inconclusive', 'a truncated direct call must fail closed, not vanish');
      assert.match(result.inconclusive.reason, /unsupported-call-shape|truncated/i);
      assert.equal(result.inconclusive.manualAdjudicationRequired, true);
    });

    test('a non-object unsupported direct call is inconclusive, never silently discarded', () => {
      const rollouts = fullRollouts();
      rollouts[1].push({ type: 'response_item', payload: { type: 'function_call', name: 'sleep', call_id: 'sleep-1', arguments: '[10]' } });
      const result = inspectShellWaitEvidence(evidenceInput({ rollouts }));
      assert.equal(result.status, 'inconclusive', 'a non-object direct payload must fail closed, not vanish');
      assert.match(result.inconclusive.reason, /unsupported-call-shape|unsupported shape/i);
      assert.equal(result.inconclusive.manualAdjudicationRequired, true);
    });

    test('an unsupported direct tool call in the child rollout blocks completion', () => {
      const rollouts = fullRollouts();
      rollouts[1].push({ type: 'response_item', payload: { type: 'function_call', name: 'sleep', call_id: 'sleep-1', arguments: JSON.stringify({ ms: 5000 }) } });
      rollouts[1].push({ type: 'response_item', payload: { type: 'function_call_output', call_id: 'sleep-1', output: completedOutput({ output: 'slept' }) } });
      const result = inspectShellWaitEvidence(evidenceInput({ rollouts }));
      assert.equal(result.facts.completion.qualified, false, 'a forbidden sleep between the authorized calls cannot qualify');
      assert.match(result.facts.completion.reason, /unsupported tool/i);
    });

    test('an additional exec_command beyond the single authorized launch blocks completion', () => {
      const rollouts = fullRollouts();
      rollouts[1].push(wrappedCall('exec_command', 'launch-2', { cmd: 'npm test' }));
      rollouts[1].push(callOutput('launch-2', completedOutput({ output: 'ok', exit_code: 0 })));
      const result = inspectShellWaitEvidence(evidenceInput({ rollouts }));
      assert.equal(result.facts.completion.qualified, false, 'an unrelated process launch cannot qualify');
      assert.match(result.facts.completion.reason, /additional|beyond/i);
    });

    test('a pending or unresolved tail after the terminal record blocks completion', () => {
      const pendingTail = fullRollouts();
      pendingTail[1].push(wrappedCall('write_stdin', 'poll-2', { session_id: HANDLE, chars: '', yield_time_ms: 60000 }));
      pendingTail[1].push(callOutput('poll-2', pendingOutput('cell-8')));
      const pendingResult = inspectShellWaitEvidence(evidenceInput({ rollouts: pendingTail }));
      assert.equal(pendingResult.facts.observations.pendingInnerAtEnd, true);
      assert.equal(pendingResult.facts.completion.qualified, false, 'a pending tail after the terminal record cannot qualify');
      assert.match(pendingResult.facts.completion.reason, /after the terminal record|pending/i);

      const unresolvedTail = fullRollouts();
      unresolvedTail[1].push(wrappedCall('write_stdin', 'poll-3', { session_id: HANDLE, chars: '', yield_time_ms: 60000 }));
      const unresolvedResult = inspectShellWaitEvidence(evidenceInput({ rollouts: unresolvedTail }));
      assert.equal(unresolvedResult.facts.completion.qualified, false, 'an unresolved observation tail after the terminal record cannot qualify');
      assert.match(unresolvedResult.facts.completion.reason, /after the terminal record|pending/i);
    });

    test('an unavailable fake-peer record blocks qualification instead of skipping the send check', () => {
      const result = inspectShellWaitEvidence(evidenceInput({ zcodeCalls: null }));
      assert.equal(result.status, 'supported');
      assert.equal(result.facts.completion.qualified, false, 'an unknown send count cannot qualify completion');
      assert.match(result.facts.completion.reason, /send/i);
      assert.equal(result.facts.companion.sendCountKnown, false);
    });

    test('a malformed fake-peer record blocks qualification like a missing record', () => {
      const result = inspectShellWaitEvidence(evidenceInput({ zcodeCalls: [{ notAMethod: true }, 'garbage-line', null] }));
      assert.equal(result.facts.completion.qualified, false, 'a malformed peer record yields zero attributable sends, which cannot qualify');
      assert.match(result.facts.completion.reason, /send/i);
      assert.equal(result.facts.companion.sendCount, 0);
    });

    test('malformed peer entries mixed with one valid send still block qualification', () => {
      const result = inspectShellWaitEvidence(evidenceInput({
        zcodeCalls: [null, 'a string', 42, { method: 'session/send', params: { sessionId: 'fake-session' } }, { noMethodHere: true }, { method: '' }, { method: 7 }],
      }));
      assert.equal(result.facts.companion.sendCountKnown, false, 'any malformed entry makes the whole peer record unknown');
      assert.equal(result.facts.completion.qualified, false);
      assert.match(result.facts.completion.reason, /send|peer/i);
    });

    test('legitimate companion request entries keep the peer record known', () => {
      const result = inspectShellWaitEvidence(evidenceInput({
        zcodeCalls: [
          { id: 1, method: 'session/create', params: {} },
          { id: 2, method: 'session/send', params: { sessionId: 'fake-session' } },
          { id: 3, method: 'v4/conversation/subscribe', params: { topic: 'conversation/fake-session' } },
          { id: 4, method: 'session/read', params: {} },
        ],
      }));
      assert.equal(result.facts.companion.sendCountKnown, true, 'legitimate request shapes must not be rejected as malformed');
      assert.equal(result.facts.companion.sendCount, 1);
    });

    test('root joins are counted separately from child outer returns', () => {
      const rollouts = fullRollouts();
      rollouts[0].push(fnCall('wait_agent', 'root-wait-2', { timeout_ms: 600000 }));
      rollouts[1].push(fnCall('wait', 'outer-1', {}));
      rollouts[1].push(fnOutput('outer-1', completedOutput({ output: SENTINEL, exit_code: 0 })));
      const result = inspectShellWaitEvidence(evidenceInput({ rollouts }));
      assert.equal(result.facts.observations.rootJoins, 2);
      assert.equal(result.facts.observations.outerReturns, 1);
    });

    test('missing rollout metadata is inconclusive rather than zero', () => {
      const result = inspectShellWaitEvidence(evidenceInput({ rollouts: [[quotedMessage()]] }));
      assert.equal(result.status, 'inconclusive');
      assert.match(result.inconclusive.reason, /session_meta|rollout/i);
      const empty = inspectShellWaitEvidence(evidenceInput({ rollouts: [] }));
      assert.equal(empty.status, 'inconclusive');
    });

    test('excerpts are bounded and their truncation is explicitly recorded', () => {
      const rollouts = fullRollouts();
      rollouts[1][1] = { type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'launch-1', input: `const r = await tools.exec_command(${JSON.stringify({ cmd: 'x'.repeat(5000) })}); text(` } };
      const result = inspectShellWaitEvidence(evidenceInput({ rollouts }));
      assert.equal(result.status, 'inconclusive');
      assert.equal(result.inconclusive.excerpt.text.length <= 2048 + 16, true);
      assert.equal(result.inconclusive.excerpt.truncated, true);
    });
  });

  describe('createShellWaitFixture validation', async () => {
    const { createShellWaitFixture } = await import('../tools/shell-wait-probe/fixture.mjs');
    const repositorySha = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();

    function fixtureInput(overrides = {}) {
      return {
        sourceRoot: repositoryRoot,
        sourceSha: repositorySha,
        codexBinary: process.execPath,
        output: '/private/tmp/unused-shell-wait-fixture-output',
        variant: 'baseline',
        capMs: null,
        ...overrides,
      };
    }

    test('rejects every invalid input before doing any work', async (t) => {
      const temporary = await mkdtemp(join(tmpdir(), 'shell-wait-invalid-'));
      t.after(() => rm(temporary, { recursive: true, force: true }));
      const nonEmpty = join(temporary, 'non-empty-private');
      await mkdir(nonEmpty, { mode: 0o700 });
      await writeFile(join(nonEmpty, 'occupied'), 'x', 'utf8');
      const cases = [
        [{ ...fixtureInput(), variant: 'improved' }, /variant/i],
        [{ ...fixtureInput(), capMs: 0 }, /capMs/i],
        [{ ...fixtureInput(), capMs: 3600000.5 }, /capMs/i],
        [{ ...fixtureInput(), capMs: -1 }, /capMs/i],
        [{ ...fixtureInput(), codexBinary: 'codex' }, /absolute native executable/i],
        [{ ...fixtureInput(), codexBinary: join(temporary, 'codex.cmd') }, /absolute native executable/i],
        [{ ...fixtureInput(), codexBinary: join(temporary, 'missing-codex') }, /does not exist|regular file/i],
        [{ ...fixtureInput(), sourceSha: 'short' }, /40-character/i],
        [{ ...fixtureInput(), sourceSha: 'z'.repeat(40) }, /resolvable|40-character/i],
        [{ ...fixtureInput(), sourceRoot: join(temporary, 'not-a-repo') }, /git repository|resolvable|must be a directory/i],
        [{ ...fixtureInput(), output: join(temporary, 'missing-output') }, /output/i],
        [{ ...fixtureInput(), output: nonEmpty }, /empty/i],
      ];
      for (const [input, pattern] of cases) {
        await assert.rejects(createShellWaitFixture(input), pattern, JSON.stringify(input).slice(0, 120));
      }
    });

    test('rejects a symlinked or group-accessible output directory', async (t) => {
      const temporary = await mkdtemp(join(tmpdir(), 'shell-wait-output-'));
      t.after(() => rm(temporary, { recursive: true, force: true }));
      const realDirectory = join(temporary, 'real-output');
      const linked = join(temporary, 'linked-output');
      await mkdir(realDirectory, { mode: 0o700 });
      await symlink(realDirectory, linked);
      await assert.rejects(createShellWaitFixture(fixtureInput({ output: linked })), /real|symlink/i);
      const open = join(temporary, 'open-output');
      await mkdir(open, { mode: 0o755 });
      await assert.rejects(createShellWaitFixture(fixtureInput({ output: open })), /private/i);
    });
  });

  describe('createShellWaitFixture fast path and owned cleanup', async () => {
    const { createShellWaitFixture } = await import('../tools/shell-wait-probe/fixture.mjs');
    const repositorySha = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
    const realTemplate = await readFile(join(repositoryRoot, 'agents', 'zcode-rescue.toml.template'), 'utf8');
    const realSkill = await readFile(join(repositoryRoot, 'skills', 'rescue', 'SKILL.md'), 'utf8');
    const ORIGINAL_WAITING_PARAGRAPH = realTemplate.split('\n').find((line) => line.includes('subsequent same-handle observations are 60000'));
    const fakeZCodePath = fileURLToPath(new URL('./fixtures/fake-zcode-cli.mjs', import.meta.url));

    /**
     * Seam-injected fast installer that materializes the installed plugin the
     * way the real `codex plugin add` does (including a config.toml with TOML
     * table headers), without launching any host.
     */
    async function fakeInstallPlugin({ codexHome, cleanSource }) {
      const installedRoot = join(codexHome, 'plugins', 'cache', 'vitry', 'zcode', '0.1.0');
      await mkdir(join(installedRoot, 'agents'), { recursive: true });
      await mkdir(join(installedRoot, 'skills', 'rescue'), { recursive: true });
      await cp(join(cleanSource, 'agents', 'zcode-rescue.toml.template'), join(installedRoot, 'agents', 'zcode-rescue.toml.template'));
      await cp(join(cleanSource, 'skills', 'rescue', 'SKILL.md'), join(installedRoot, 'skills', 'rescue', 'SKILL.md'));
      await writeFile(join(codexHome, 'config.toml'), '[marketplaces.vitry]\nsource_type = "local"\n\n[plugins."zcode@vitry"]\nenabled = true\n', { encoding: 'utf8' });
      return { pluginVersion: '0.1.0' };
    }

    async function fakeBuildSnapshot({ output, sourceSha }) {
      await mkdir(join(output, '.agents', 'plugins'), { recursive: true });
      await writeFile(join(output, '.agents', 'plugins', 'provenance.json'), `${JSON.stringify({ sourceSha })}\n`, 'utf8');
    }

    function fastDependencies() {
      return { buildSnapshot: fakeBuildSnapshot, installPlugin: fakeInstallPlugin, runSetup: fakeIsolatedSetup };
    }

    /** The injected isolated production setup: a fast ready outcome. */
    function fakeIsolatedSetup(context) {
      return Promise.resolve({ sessionEstablished: true, launcherDescriptorPublished: true, setupAttempts: 1, roleStatus: 'ready', capVerified: context.capMs === null ? null : true });
    }

    /** Fixture with an inherited external ZCODE_DATA_ROOT in process.env. */
    async function createFastFixtureWithEnv(t) {
      const fixtureTemporary = await mkdtemp(join(tmpdir(), 'shell-wait-dataroot-fixture-'));
      t.after(() => rm(fixtureTemporary, { recursive: true, force: true }));
      const output = join(fixtureTemporary, 'output');
      await mkdir(output, { mode: 0o700 });
      const fixture = await createShellWaitFixture({
        sourceRoot: repositoryRoot, sourceSha: repositorySha, codexBinary: process.execPath,
        output, variant: 'baseline', capMs: null,
      }, fastDependencies());
      t.after(() => fixture.dispose());
      return { fixture, fixtureTemporary };
    }

    async function createFastFixture(t, overrides = {}, dependencies = fastDependencies()) {
      const temporary = await mkdtemp(join(tmpdir(), 'shell-wait-fixture-'));
      t.after(() => rm(temporary, { recursive: true, force: true }));
      const output = join(temporary, 'output');
      await mkdir(output, { mode: 0o700 });
      const authSource = join(temporary, 'auth-source');
      await mkdir(authSource, { recursive: true, mode: 0o700 });
      await writeFile(join(authSource, 'auth.json'), '{"fixture credential":"must not leak"}\n', { mode: 0o600 });
      const fixture = await createShellWaitFixture({
        sourceRoot: repositoryRoot,
        sourceSha: repositorySha,
        codexBinary: process.execPath,
        output,
        variant: 'baseline',
        capMs: null,
        authSource,
        ...overrides,
      }, dependencies);
      t.after(() => fixture.dispose());
      return { fixture, temporary, output };
    }

    test('hostile inherited Git overrides cannot touch an unrelated repository or its canary', async (t) => {
      const temporary = await mkdtemp(join(tmpdir(), 'shell-wait-git-overrides-'));
      t.after(() => rm(temporary, { recursive: true, force: true }));
      const unrelated = join(temporary, 'unrelated');
      const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
      const git = (args) => {
        const result = spawnSync('git', args, { cwd: unrelated, env: cleanEnv, encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
        return result.stdout;
      };
      const cloned = spawnSync('git', ['clone', '--shared', repositoryRoot, unrelated], { env: cleanEnv, encoding: 'utf8' });
      assert.equal(cloned.status, 0, cloned.stderr);
      const canary = join(temporary, 'canary-worktree');
      git(['worktree', 'add', '--detach', canary, 'HEAD']);
      await rm(canary, { recursive: true, force: true });
      await writeFile(join(unrelated, 'staged-canary.txt'), 'must remain staged, never committed\n');
      git(['add', 'staged-canary.txt']);
      const registrationsBefore = git(['worktree', 'list', '--porcelain']);
      const headBefore = git(['rev-parse', 'HEAD']);
      const indexBefore = await readFile(join(unrelated, '.git', 'index'));
      // Snapshot every byte, including refs, reflogs, config, objects and the
      // unrelated prunable registration; checking HEAD alone misses writes.
      async function snapshot(directory, prefix = '') {
        const entries = [];
        for (const name of (await readdir(directory)).sort()) {
          const path = join(directory, name);
          if ((await stat(path)).isDirectory()) entries.push(...await snapshot(path, `${prefix}${name}/`));
          else entries.push([`${prefix}${name}`, createHash('sha256').update(await readFile(path)).digest('hex')]);
        }
        return entries;
      }
      const before = await snapshot(unrelated);
      const output = join(temporary, 'output');
      await mkdir(output, { mode: 0o700 });
      const metadata = join(unrelated, '.git');
      const hostileEnv = {
        ...cleanEnv,
        GIT_DIR: metadata,
        GIT_WORK_TREE: unrelated,
        GIT_COMMON_DIR: metadata,
        GIT_INDEX_FILE: join(metadata, 'index'),
        GIT_OBJECT_DIRECTORY: join(metadata, 'objects'),
        GIT_ALTERNATE_OBJECT_DIRECTORIES: join(metadata, 'objects'),
        GIT_NAMESPACE: 'hostile',
        GIT_IMPLICIT_WORK_TREE: '1',
        GIT_PREFIX: 'hostile/',
        GIT_CONFIG: join(metadata, 'config'),
        GIT_CONFIG_PARAMETERS: "'core.worktree=unrelated'",
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'core.worktree',
        GIT_CONFIG_VALUE_0: unrelated,
        GIT_CONFIG_GLOBAL: join(metadata, 'config'),
        GIT_CONFIG_SYSTEM: join(metadata, 'config'),
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_GRAFT_FILE: join(temporary, 'missing-grafts'),
        GIT_SHALLOW_FILE: join(temporary, 'missing-shallow'),
        GIT_NO_REPLACE_OBJECTS: '1',
        GIT_REPLACE_REF_BASE: 'refs/hostile/',
        GIT_CEILING_DIRECTORIES: temporary,
        GIT_DISCOVERY_ACROSS_FILESYSTEM: '0',
        GIT_FUTURE_REPOSITORY_OVERRIDE: unrelated,
        TMPDIR: temporary,
      };
      // A separate process inherits the hostile environment; parent test Git
      // and after-hooks never inherit it, even on the RED path.
      const script = `
        import assert from 'node:assert/strict';
        import { cp, mkdir, writeFile } from 'node:fs/promises';
        import { join } from 'node:path';
        import { spawnSync } from 'node:child_process';
        import { createShellWaitFixture } from ${JSON.stringify(pathToFileURL(join(repositoryRoot, 'tools/shell-wait-probe/fixture.mjs')).href)};
        const fakeInstallPlugin = ${fakeInstallPlugin.toString()};
        const fakeBuildSnapshot = ${fakeBuildSnapshot.toString()};
        let fixture;
        try {
          fixture = await createShellWaitFixture(${JSON.stringify({
            sourceRoot: repositoryRoot, sourceSha: repositorySha, codexBinary: process.execPath,
            output, variant: 'baseline', capMs: null, authSource: join(temporary, 'no-auth'),
          })}, {
            buildSnapshot: async (context) => {
              assert.deepEqual(Object.keys(context.env).filter(key => key.toUpperCase().startsWith('GIT_')), [], 'builder must receive no inherited Git overrides');
              const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: context.cleanSource, env: context.env, encoding: 'utf8' });
              assert.equal(result.status, 0, result.stderr);
              assert.equal(result.stdout.trim(), context.sourceSha);
              await fakeBuildSnapshot(context);
            },
            installPlugin: fakeInstallPlugin,
            runSetup: ${fakeIsolatedSetup.toString()},
          });
          assert.deepEqual(Object.keys(fixture.env).filter(key => key.toUpperCase().startsWith('GIT_')), []);
          assert.equal(spawnSync('git', ['log', '-1', '--format=%s'], { cwd: fixture.workspace, env: fixture.env, encoding: 'utf8' }).stdout.trim(), 'base');
        } finally { await fixture?.dispose(); }
      `;
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: hostileEnv, encoding: 'utf8', timeout: 30_000 });
      const after = await snapshot(unrelated);
      const beforeMap = new Map(before);
      const afterMap = new Map(after);
      const changed = [...new Set([...beforeMap.keys(), ...afterMap.keys()])].filter(key => beforeMap.get(key) !== afterMap.get(key));
      assert.deepEqual(changed, [], 'the unrelated repository must remain byte-for-byte untouched');
      assert.deepEqual(await readFile(join(metadata, 'index')), indexBefore, 'pre-existing staged changes must survive');
      assert.equal(git(['rev-parse', 'HEAD']), headBefore);
      assert.equal(git(['worktree', 'list', '--porcelain']), registrationsBefore, 'the unrelated repository canary must survive creation and disposal');
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, `fixture creation with hostile Git overrides failed:\n${result.stdout}\n${result.stderr}`);
    });

    test('a baseline fixture installs unmodified artifacts into an isolated private home', async (t) => {
      // Pin the baseline waiting-policy paragraph: it must be a unique single
      // line in both canonical artifacts so the candidate replacement target is
      // exactly one paragraph.
      assert.equal(realSkill.split('\n').filter((line) => line === ORIGINAL_WAITING_PARAGRAPH).length, 1);
      const { fixture, output } = await createFastFixture(t);
      const { codexHome, installedRoot, env, workspace } = fixture;
      assert.equal(await readFile(join(installedRoot, 'agents', 'zcode-rescue.toml.template'), 'utf8'), realTemplate, 'the baseline installed template must stay byte-identical');
      assert.equal(await readFile(join(installedRoot, 'skills', 'rescue', 'SKILL.md'), 'utf8'), realSkill, 'the baseline installed skill must stay byte-identical');
      assert.equal(await readFile(join(codexHome, 'config.toml'), 'utf8').then((value) => value.includes('background_terminal_max_timeout'), () => false), false, 'an unraised cap writes no configuration key');
      // Isolation: every credential home lives inside the fixture's private
      // temporary root, never in the user's real configuration.
      assert.equal(env.CODEX_HOME, codexHome);
      assert.equal(env.ZCODE_PATH, fakeZCodePath);
      assert.ok(!codexHome.startsWith(repositoryRoot), 'the isolated home must not live inside the repository');
      assert.ok(env.HOME && !env.HOME.startsWith(repositoryRoot));
      const workspaceMarker = join(workspace, 'tracked.txt');
      assert.equal(await readFile(workspaceMarker, 'utf8'), 'base\n');
      // The isolated home received the copied fixture credential.
      assert.equal((await readFile(join(codexHome, 'auth.json'), 'utf8')).includes('fixture credential'), true);
      // Provenance: the caller's uncommitted files never enter the snapshot.
      assert.equal(fixture.record.sourceSha, repositorySha);
      assert.equal(fixture.record.variant, 'baseline');
      assert.deepEqual(fixture.record.renderedNamedRoleSha256 !== null, true);
      const recordInOutput = join(output, 'unused');
      assert.equal(await stat(recordInOutput).then(() => true, () => false), false, 'the fixture writes nothing into the output directory itself');
    });

    test('a candidate fixture changes only the waiting policy in the temporary installed artifacts', async (t) => {
      const { fixture } = await createFastFixture(t, { variant: 'candidate', capMs: 3_600_000, pollMs: 3_600_000 });
      const { installedRoot, codexHome } = fixture;
      const template = await readFile(join(installedRoot, 'agents', 'zcode-rescue.toml.template'), 'utf8');
      const skill = await readFile(join(installedRoot, 'skills', 'rescue', 'SKILL.md'), 'utf8');
      for (const [label, modified] of [['named Role template', template], ['generic assignment skill', skill]]) {
        const originalLines = (label === 'named Role template' ? realTemplate : realSkill).split('\n');
        const modifiedLines = modified.split('\n');
        assert.equal(modifiedLines.length, originalLines.length, `${label} must not add or remove lines`);
        const changed = originalLines.flatMap((line, index) => line === modifiedLines[index] ? [] : [index]);
        assert.deepEqual(changed.length, 1, `${label} must change exactly one line`);
        assert.match(originalLines[changed[0]], /subsequent same-handle observations are 60000/, `${label} must change only the waiting-policy paragraph`);
        assert.match(modifiedLines[changed[0]], /yield_time_ms.: 3600000/, `${label} must request the candidate long window`);
        assert.doesNotMatch(modifiedLines[changed[0]], /yield_time_ms: 60000/, `${label} must not retain the plain 60000 request`);
        assert.doesNotMatch(modifiedLines[changed[0]], /observations are 60000/, `${label} must not retain the plain 60000 summary`);
        // Authority, fixed command, and initial/choice assignment literals are preserved byte-for-byte.
        for (const preserved of [
          'invoke-prepared rescue',
          'invoke-status rescue',
          'invoke-choice rescue resume',
          'invoke-choice rescue fresh',
          'Run the installed prepared ZCode Rescue forwarder now. Return its public stdout verbatim.',
          'Continue the pending ZCode Rescue with resume. Run only the installed resume forwarder command and return its public stdout verbatim.',
          'Continue the pending ZCode Rescue with fresh. Run only the installed fresh forwarder command and return its public stdout verbatim.',
        ]) {
          assert.equal(originalLines.filter((line) => line.includes(preserved)).length > 0, true, `${label} must contain ${preserved}`);
          assert.equal(modifiedLines.filter((line) => line.includes(preserved)).length, originalLines.filter((line) => line.includes(preserved)).length, `${label} must preserve ${preserved}`);
        }
      }
      assert.doesNotMatch(template, /background_terminal_max_timeout/u, 'the cap must never enter the Role template');
      const config = await readFile(join(codexHome, 'config.toml'), 'utf8');
      assert.match(config, /^background_terminal_max_timeout = 3600000\n/u, 'the cap must be prepended as a top-level TOML key before any table header');
      // Rendered instruction hashes are captured, not assumed from repository text.
      assert.notEqual(fixture.record.renderedNamedRoleSha256, fixture.record.baselineNamedRoleSha256 ?? null);
      assert.notEqual(fixture.record.genericMessageSha256, fixture.record.baselineGenericMessageSha256 ?? null);
      assert.equal(fixture.record.appliedArtifacts.length, 2);
      for (const artifact of fixture.record.appliedArtifacts) {
        assert.match(artifact.role, /named-role|generic-skill/);
        assert.match(artifact.beforeSha256, /^[a-f0-9]{64}$/);
        assert.match(artifact.afterSha256, /^[a-f0-9]{64}$/);
        assert.notEqual(artifact.beforeSha256, artifact.afterSha256);
        assert.match(artifact.mode, /^0o[0-7]{3,4}$/);
      }
    });

    test('a candidate fixture with an unraised cap keeps the long request but writes no cap (Case 0 shape)', async (t) => {
      const { fixture } = await createFastFixture(t, { variant: 'candidate', capMs: null, pollMs: 3_600_000 });
      const config = await readFile(join(fixture.codexHome, 'config.toml'), 'utf8').catch(() => '');
      assert.doesNotMatch(config, /background_terminal_max_timeout/u);
      const template = await readFile(join(fixture.installedRoot, 'agents', 'zcode-rescue.toml.template'), 'utf8');
      assert.match(template, /yield_time_ms.: 3600000/u);
    });

    test('the isolated production setup runs after variant application with the exact context', async (t) => {
      const setupCalls = [];
      const { fixture } = await createFastFixture(t, { variant: 'candidate', capMs: 3_600_000, pollMs: 3_600_000 }, {
        ...fastDependencies(),
        runSetup: async (context) => {
          setupCalls.push(context);
          // Ordering: the setup step must see the ALREADY applied candidate
          // template, because setup renders the managed Role from it.
          const template = await readFile(join(context.installedRoot, 'agents', 'zcode-rescue.toml.template'), 'utf8');
          assert.match(template, /yield_time_ms.: 3600000/u, 'the candidate waiting policy must be applied before setup renders the Role');
          return { sessionEstablished: true, launcherDescriptorPublished: true, setupAttempts: 2, roleStatus: 'ready', capVerified: true };
        },
      });
      assert.equal(setupCalls.length, 1, 'the setup step must run exactly once');
      assert.equal(setupCalls[0].codexBinary, process.execPath);
      assert.equal(setupCalls[0].capMs, 3_600_000);
      assert.equal(typeof setupCalls[0].dataRoot, 'string');
      assert.equal(typeof setupCalls[0].env.ZCODE_DATA_ROOT, 'string');
      assert.deepEqual(fixture.record.isolatedSetup, { sessionEstablished: true, launcherDescriptorPublished: true, setupAttempts: 2, roleStatus: 'ready', capVerified: true });
    });

    test('a failing isolated production setup rejects fixture creation and still removes the owned registration', async (t) => {
      const temporary = await mkdtemp(join(tmpdir(), 'shell-wait-setup-fail-'));
      t.after(() => rm(temporary, { recursive: true, force: true }));
      const output = join(temporary, 'output');
      await mkdir(output, { mode: 0o700 });
      // Count-based canary: the registered path lives under the fixture's own
      // random temporary root, so a name-based assertion cannot see a leak
      // (the first draft of this test was vacuous for exactly that reason).
      const ownedRegistrations = () => spawnSync('git', ['worktree', 'list', '--porcelain'], { encoding: 'utf8' }).stdout
        .split('\n').filter((line) => line.startsWith('worktree ') && line.includes('zcode-shell-wait-fixture-')).length;
      const registrationsBefore = ownedRegistrations();
      let creationError;
      try {
        await createShellWaitFixture({
          sourceRoot: repositoryRoot, sourceSha: repositorySha, codexBinary: process.execPath,
          output, variant: 'baseline', capMs: null,
        }, { ...fastDependencies(), runSetup: async () => { throw new Error('the isolated Role preflight did not reach ready (observed install-required)'); } });
      } catch (error) { creationError = error; }
      assert.ok(creationError, 'a failed isolated setup must reject fixture creation');
      assert.match(creationError?.message ?? '', /ready/);
      assert.equal(ownedRegistrations(), registrationsBefore, 'the owned registration must be removed on the setup failure path (count-based canary)');
    });

    test('dispose removes the owned worktree registration, credential homes, and nothing else', async (t) => {
      const { fixture, output } = await createFastFixture(t);
      const worktreePath = fixture.record.ownedCleanSourceWorktree;
      assert.equal(typeof worktreePath, 'string');
      const sourceClone = join(fixture.codexHome, '..', 'source-repository');
      const sharedBefore = spawnSync('git', ['worktree', 'list', '--porcelain'], { encoding: 'utf8' }).stdout;
      assert.doesNotMatch(sharedBefore, new RegExp(escapeRegExp(worktreePath)), 'the shared repository must never register the fixture source');
      const listed = spawnSync('git', ['worktree', 'list', '--porcelain'], { cwd: sourceClone, encoding: 'utf8' });
      assert.equal(listed.status, 0, listed.stderr);
      const registrationsBefore = listed.stdout;
      assert.match(registrationsBefore, new RegExp(escapeRegExp(worktreePath)), 'the fixture-owned worktree must be registered before dispose');
      // The caller keeps redacted evidence outside the fixture homes.
      const preservedEvidence = join(output, 'kept.record.json');
      await writeFile(preservedEvidence, '{"redacted":true}\n', { mode: 0o600 });
      await fixture.dispose();
      const registrationsAfter = spawnSync('git', ['worktree', 'list', '--porcelain'], { encoding: 'utf8' }).stdout;
      assert.equal(registrationsAfter, sharedBefore, 'shared registrations must remain untouched');
      assert.equal(await stat(sourceClone).then(() => true, () => false), false, 'the clone root and all its Git metadata must be removed');
      assert.equal(await stat(join(fixture.codexHome, 'auth.json')).then(() => true, () => false), false, 'copied credentials must be removed');
      assert.equal(await stat(join(fixture.codexHome)).then(() => true, () => false), false, 'the isolated home must be removed');
      assert.equal(await stat(preservedEvidence).then(() => true, () => false), true, 'redacted evidence outside the homes must survive');
      assert.equal(await stat(join(fixture.codexHome, '..')).then(() => true, () => false), false, 'the fixture temporary root must be removed');
      await fixture.dispose(); // idempotent
    });

    test('dispose removes the credential home even when the owned worktree removal fails, surfacing both outcomes', async (t) => {
      const sharedBefore = spawnSync('git', ['worktree', 'list', '--porcelain'], { encoding: 'utf8' }).stdout;
      const { fixture } = await createFastFixture(t, {}, {
        ...fastDependencies(),
        removeOwnedWorktree: async () => { throw new Error('could not remove the owned detached worktree registration'); },
      });
      let disposeError;
      try {
        await fixture.dispose();
      } catch (error) { disposeError = error; }
      assert.ok(disposeError, 'dispose must surface the worktree-removal failure');
      assert.match(disposeError?.message ?? '', /worktree registration/i);
      assert.equal(await stat(join(fixture.codexHome, 'auth.json')).then(() => true, () => false), false, 'credentials must be removed regardless of the worktree outcome');
      assert.equal(await stat(join(fixture.codexHome, '..')).then(() => true, () => false), false, 'the fixture temporary root must still be removed');
      // The clone metadata is inside the removed root, so even an injected
      // removal failure leaves no shared registration to repair.
      const registrations = spawnSync('git', ['worktree', 'list', '--porcelain'], { encoding: 'utf8' }).stdout;
      assert.equal(registrations, sharedBefore, 'the shared registrations must remain untouched on cleanup failure');
    });

    test('a failed targeted worktree removal surfaces failure and never prunes unrelated registrations', async (t) => {
      // git canonicalizes registration paths (/var/... is listed as
      // /private/var/... on macOS), so every comparison below is canonical.
      const canonicalize = (value) => value.startsWith('/private/') ? value.slice('/private'.length) : value;
      const unrelatedBase = await mkdtemp(join(tmpdir(), 'shell-wait-unrelated-'));
      t.after(() => rm(unrelatedBase, { recursive: true, force: true }));
      const sharedSource = join(unrelatedBase, 'shared-source');
      const cloned = spawnSync('git', ['clone', '--shared', repositoryRoot, sharedSource], { encoding: 'utf8' });
      assert.equal(cloned.status, 0, cloned.stderr);
      const registeredPaths = () => spawnSync('git', ['worktree', 'list', '--porcelain'], { cwd: sharedSource, encoding: 'utf8' }).stdout
        .split('\n').filter((line) => line.startsWith('worktree ')).map((line) => canonicalize(line.slice('worktree '.length)));
      const removeRegistration = async (registeredPath) => {
        const commonDir = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: sharedSource, encoding: 'utf8' }).stdout.trim();
        const adminRoot = join(commonDir, 'worktrees');
        for (const entry of await readdir(adminRoot).catch(() => [])) {
          const pointer = (await readFile(join(adminRoot, entry, 'gitdir'), 'utf8').catch(() => '')).trim();
          if (canonicalize(pointer.replace(/\/.git$/u, '')) === canonicalize(registeredPath)) {
            await rm(join(adminRoot, entry), { recursive: true, force: true });
          }
        }
      };

      const { fixture } = await createFastFixture(t, { sourceRoot: sharedSource });
      // An unrelated prunable registration (unlocked, directory missing) that a
      // repository-wide prune would destroy.
      const unrelatedPath = join(unrelatedBase, 'unrelated-worktree');
      const add = spawnSync('git', ['worktree', 'add', '--detach', unrelatedPath, 'HEAD'], { cwd: sharedSource, encoding: 'utf8' });
      assert.equal(add.status, 0, add.stderr);
      await rm(unrelatedPath, { recursive: true, force: true });
      // A locked owned worktree makes the targeted removal fail deterministically
      // (git refuses to remove a locked working tree) while its registration stays.
      const ownedPath = fixture.record.ownedCleanSourceWorktree;
      const lock = spawnSync('git', ['worktree', 'lock', ownedPath], { cwd: ownedPath, encoding: 'utf8' });
      assert.equal(lock.status, 0, lock.stderr);
      try {
        await assert.rejects(fixture.dispose(), /worktree/i, 'a failed targeted removal must surface a failure instead of pruning');
        assert.equal(registeredPaths().includes(canonicalize(unrelatedPath)), true, 'an unrelated prunable registration must survive the fixture cleanup');
        assert.equal(await stat(join(fixture.codexHome, 'auth.json')).then(() => true, () => false), false, 'the credential home must still be removed when the worktree removal fails');
      } finally {
        // Disposal deleted the clone and its locked registration. Remove only
        // the test's unrelated shared registration; never prune the source.
        await removeRegistration(unrelatedPath);
        const remaining = registeredPaths();
        assert.equal(remaining.includes(canonicalize(ownedPath)), false, 'the test must not leave the owned registration behind');
        assert.equal(remaining.includes(canonicalize(unrelatedPath)), false, 'the test must not leave the unrelated registration behind');
      }
    });

    test('an inherited external ZCODE_DATA_ROOT never receives fixture traffic', async (t) => {
      const temporary = await mkdtemp(join(tmpdir(), 'shell-wait-data-root-'));
      t.after(() => rm(temporary, { recursive: true, force: true }));
      const externalDataRoot = join(temporary, 'external-data-root');
      await mkdir(join(externalDataRoot, 'existing'), { recursive: true });
      const entriesBefore = (await readdir(externalDataRoot)).sort().join(',');
      const previousDataRoot = process.env.ZCODE_DATA_ROOT;
      process.env.ZCODE_DATA_ROOT = externalDataRoot;
      try {
        const { fixture } = await createFastFixtureWithEnv(t);
        // The fixture module root is the parent of the isolated codexHome.
        const fixtureRoot = join(fixture.codexHome, '..');
        assert.ok(String(fixture.env.ZCODE_DATA_ROOT).startsWith(fixtureRoot), 'the fixture must own its data root inside the fixture root');
        assert.notEqual(fixture.env.ZCODE_DATA_ROOT, externalDataRoot);
        await fixture.dispose();
      } finally {
        if (previousDataRoot === undefined) delete process.env.ZCODE_DATA_ROOT;
        else process.env.ZCODE_DATA_ROOT = previousDataRoot;
      }
      const entriesAfter = (await readdir(externalDataRoot)).sort().join(',');
      assert.equal(entriesAfter, entriesBefore, 'the external data root must remain untouched after execution and disposal');
    });

    test('the real builder failure-path prune stays inside clone metadata and preserves shared registrations', { timeout: 300_000 }, async (t) => {
      const { sameRegisteredPath, registeredWorktreePaths } = await import('../tools/shell-wait-probe/fixture.mjs');
      const temporary = await mkdtemp(join(tmpdir(), 'shell-wait-builder-failure-'));
      t.after(() => rm(temporary, { recursive: true, force: true }));
      const output = join(temporary, 'output');
      const bin = join(temporary, 'bin');
      const log = join(temporary, 'git-cleanup.jsonl');
      await mkdir(output, { mode: 0o700 });
      await mkdir(bin);
      const realGit = spawnSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
      // A disposable shared source repository lets RED exercise the destructive
      // prune itself without endangering the caller's existing registrations.
      const sharedSource = join(temporary, 'shared-source');
      const cloned = spawnSync(realGit, ['clone', '--shared', '--no-checkout', repositoryRoot, sharedSource], { encoding: 'utf8' });
      assert.equal(cloned.status, 0, cloned.stderr);
      const checkedOut = spawnSync(realGit, ['checkout', '--detach', repositorySha], { cwd: sharedSource, encoding: 'utf8' });
      assert.equal(checkedOut.status, 0, checkedOut.stderr);
      const sharedCommon = spawnSync(realGit, ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: sharedSource, encoding: 'utf8' }).stdout.trim();
      const unrelated = join(temporary, 'unrelated-worktree');
      const added = spawnSync(realGit, ['worktree', 'add', '--detach', unrelated, repositorySha], { cwd: sharedSource, encoding: 'utf8' });
      assert.equal(added.status, 0, added.stderr);
      const unrelatedAdmin = spawnSync(realGit, ['rev-parse', '--absolute-git-dir'], { cwd: unrelated, encoding: 'utf8' }).stdout.trim();
      t.after(() => rm(unrelatedAdmin, { recursive: true, force: true }));
      await rm(unrelated, { recursive: true, force: true });
      const sharedList = () => spawnSync(realGit, ['worktree', 'list', '--porcelain'], { cwd: sharedSource, encoding: 'utf8' }).stdout;
      const registrationsBefore = sharedList();
      assert.ok(registeredWorktreePaths(registrationsBefore).some((path) => sameRegisteredPath(path, unrelated)));

      // Run the real builder, failing only its own targeted staging removal.
      // The shared source is disposable, so RED may safely prune its canary.
      await writeFile(join(bin, 'git'), `#!${process.execPath}
const { spawnSync } = require('node:child_process');
const { appendFileSync } = require('node:fs');
const args = process.argv.slice(2);
const realGit = ${JSON.stringify(realGit)};
const cleanup = args[0] === 'worktree' && (args[1] === 'remove' || args[1] === 'prune');
if (cleanup) {
  const common = spawnSync(realGit, ['rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).stdout.trim();
  appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, common, cwd: process.cwd() }) + '\\n');
  if (args[1] === 'remove' && args.at(-1).endsWith('/exact source')) process.exit(1);
}
const result = spawnSync(realGit, args, { stdio: 'inherit' });
process.exit(result.status ?? 1);
`, { mode: 0o700 });
      const previousPath = process.env.PATH;
      let fixture;
      let buildError;
      try {
        process.env.PATH = `${bin}:${previousPath ?? ''}`;
        fixture = await createShellWaitFixture({
          sourceRoot: sharedSource, sourceSha: repositorySha, codexBinary: process.execPath,
          output, variant: 'baseline', capMs: null,
        }, { ...fastDependencies(), buildSnapshot: undefined });
      } catch (error) { buildError = error; }
      finally {
        if (previousPath === undefined) delete process.env.PATH;
        else process.env.PATH = previousPath;
      }
      if (fixture) t.after(() => fixture.dispose());
      const calls = (await readFile(log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
      const failedRemovals = calls.filter((call) => call.args[1] === 'remove' && call.args.at(-1).endsWith('/exact source'));
      const prunes = calls.filter((call) => call.args[1] === 'prune');
      assert.ok(failedRemovals.length > 0, 'the builder targeted removal must be fault-injected');
      assert.ok(prunes.length > 0, 'the real builder failure-path prune must actually run');
      for (const call of [...failedRemovals, ...prunes]) {
        assert.equal(sameRegisteredPath(call.common, sharedCommon), false, 'builder cleanup must use isolated clone metadata; prune must never escape into the shared repository');
        assert.ok(sameRegisteredPath(call.common, join(call.cwd, '..', 'source-repository', '.git')), 'builder metadata must belong to the fixture-owned source clone');
      }
      assert.equal(buildError, undefined, 'the clone-internal prune must recover the injected removal failure');
      assert.equal(sharedList(), registrationsBefore, 'every shared registration, including the unrelated prunable entry, must survive untouched');
      const cloneList = spawnSync(realGit, ['worktree', 'list', '--porcelain'], { cwd: fixture.record.ownedCleanSourceWorktree, encoding: 'utf8' });
      assert.equal(cloneList.status, 0, cloneList.stderr);
      assert.equal(registeredWorktreePaths(cloneList.stdout).length, 2, 'only the clone and fixture clean source may remain after the builder staging prune');
      assert.ok(registeredWorktreePaths(cloneList.stdout).every((path) => !failedRemovals.some((call) => sameRegisteredPath(path, call.args.at(-1)))), 'the clone-internal prune must remove the builder staging registration');
    });

    test('the real marketplace build and plugin install path yields an installable isolated fixture', { timeout: 300_000 }, async (t) => {
      const temporary = await mkdtemp(join(tmpdir(), 'shell-wait-real-fixture-'));
      t.after(() => rm(temporary, { recursive: true, force: true }));
      const output = join(temporary, 'output');
      await mkdir(output, { mode: 0o700 });
      const codexBinary = join(repositoryRoot, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
      const fixture = await createShellWaitFixture({
        sourceRoot: repositoryRoot,
        sourceSha: repositorySha,
        codexBinary,
        output,
        variant: 'candidate',
        capMs: 3_600_000,
        pollMs: 3_600_000,
      }, { runSetup: fakeIsolatedSetup });
      t.after(() => fixture.dispose());
      const marketplacePath = join(fixture.codexHome, '..', 'marketplace');
      const provenance = JSON.parse(await readFile(join(marketplacePath, '.agents', 'plugins', 'provenance.json'), 'utf8'));
      assert.equal(provenance.sourceSha, repositorySha);
      assert.equal(await readFile(join(fixture.installedRoot, 'agents', 'zcode-rescue.toml.template'), 'utf8').then((value) => /yield_time_ms.: 3600000/u.test(value), () => false), true);
      assert.match(await readFile(join(fixture.codexHome, 'config.toml'), 'utf8'), /^background_terminal_max_timeout = 3600000\n/u);
      assert.equal(fixture.record.pluginVersion, '0.1.0');
    });
  });

  describe('process identity discipline and bounded held-run lifecycle', async () => {
    const { inspectVerifiedProcessIdentity, terminateVerifiedProcess, releaseCompletionGate } = await import('../tools/shell-wait-probe/fixture.mjs');
    const { runHeldHostTurn, mapShellWaitLiveFacts } = await import('../tools/shell-wait-probe/driver.mjs');
    const { spawn } = await import('node:child_process');

    const TEST_NONCE = 'c'.repeat(64);
    const OTHER_NONCE = 'd'.repeat(64);

    test('inspectVerifiedProcessIdentity resolves a live exact process and rejects a nonce mismatch', async (t) => {
      const child = spawn(process.execPath, ['--input-type=module', '--eval', 'await new Promise((resolve) => setTimeout(resolve, 10_000));'], {
        env: { ...process.env, FAKE_ZCODE_PROCESS_NONCE: TEST_NONCE }, stdio: 'ignore',
      });
      t.after(() => { try { child.kill('SIGKILL'); } catch { /* already exited */ } });
      await assert.rejects(inspectVerifiedProcessIdentity(child.pid, OTHER_NONCE), /identity/i);
      const identity = await inspectVerifiedProcessIdentity(child.pid, TEST_NONCE);
      assert.equal(identity?.pid, child.pid);
      assert.equal(identity?.nonce, TEST_NONCE);
      assert.equal(typeof identity?.ppid, 'number');
      assert.ok(identity?.startIdentity);
      child.kill('SIGKILL');
      await new Promise((resolve) => child.once('exit', resolve));
      assert.equal(await inspectVerifiedProcessIdentity(child.pid, TEST_NONCE), undefined, 'an exited process must report undefined, never an identity');
    });

    test('the default capture, re-verification, and termination chain accepts the inspector identity shape', async (t) => {
      const { spawn: spawnNode } = await import('node:child_process');
      const child = spawnNode(process.execPath, ['--input-type=module', '--eval', 'await new Promise((resolve) => setTimeout(resolve, 30_000));'], {
        env: { ...process.env, FAKE_ZCODE_PROCESS_NONCE: TEST_NONCE }, stdio: 'ignore',
      });
      t.after(() => { try { child.kill('SIGKILL'); } catch { /* already exited */ } });
      const temporary = await mkdtemp(join(tmpdir(), 'shell-wait-chain-'));
      t.after(() => rm(temporary, { recursive: true, force: true }));
      const processPath = join(temporary, 'process.json');
      await writeFile(processPath, `${JSON.stringify({ pid: child.pid, ppid: process.pid, nonce: TEST_NONCE })}\n`, 'utf8');

      // Part A: default capture and default re-verification (processAliveWhileHeld) with the
      // inspector's actual return shape.
      let resolveResult;
      const gatePath = join(temporary, 'gate');
      await writeFile(gatePath, 'hold', 'utf8');
      const heldA = await runHeldHostTurn({
        launch: async () => ({ result: new Promise((resolve) => { resolveResult = resolve; }) }),
        waitForGate: async () => {},
        gatePath,
        processPath,
        processNonce: TEST_NONCE,
        holdMs: 0,
        budgetMs: 60_000,
        releaseGate: async (releasedPath) => {
          await releaseCompletionGate(releasedPath);
          resolveResult({ code: 0, stdout: '', stderr: '' });
          child.kill('SIGKILL');
          await new Promise((resolve) => child.once('exit', resolve));
        },
        now: (() => { let value = 0; return () => (value += 1000); })(),
        waitForProcessExit: async () => {},
      });
      assert.equal(heldA.processAliveWhileHeld, true, 'the default re-verification must accept the captured inspector identity shape');
      assert.equal(heldA.endedBeforeGate, false);

      // Part B: default termination of the same shape under budget expiry.
      const childB = spawnNode(process.execPath, ['--input-type=module', '--eval', 'await new Promise((resolve) => setTimeout(resolve, 30_000));'], {
        env: { ...process.env, FAKE_ZCODE_PROCESS_NONCE: TEST_NONCE }, stdio: 'ignore',
      });
      t.after(() => { try { childB.kill('SIGKILL'); } catch { /* already exited */ } });
      const processPathB = join(temporary, 'process-b.json');
      await writeFile(processPathB, `${JSON.stringify({ pid: childB.pid, ppid: process.pid, nonce: TEST_NONCE })}\n`, 'utf8');
      const gatePathB = join(temporary, 'gate-b');
      await writeFile(gatePathB, 'hold', 'utf8');
      const heldB = await runHeldHostTurn({
        launch: async () => ({ result: new Promise(() => {}), terminate: async () => {} }),
        waitForGate: async () => new Promise(() => {}),
        gatePath: gatePathB,
        processPath: processPathB,
        processNonce: TEST_NONCE,
        holdMs: 5_000,
        budgetMs: 100,
      });
      assert.equal(heldB.budgetExpired, true);
      assert.equal(heldB.cleanup.verifiedProcessTerminated, true, 'the default termination must accept the captured inspector identity shape');
      // The turn's budget cleanup may already have reaped childB (its 'exit'
      // event is single-shot), so only wait when it is still running.
      if (childB.exitCode === null && childB.signalCode === null) {
        await new Promise((resolve) => childB.once('exit', resolve));
      }
      assert.equal(childB.killed || childB.exitCode !== null || childB.signalCode !== null, true);
    });

    test('terminateVerifiedProcess returns explicit outcomes and never reports a failed signal as success', async () => {
      const liveIdentity = { pid: 66200, ppid: 84, nonce: TEST_NONCE, startIdentity: 'start-a' };
      // SIGTERM rejected (EPERM) while the identity stays live: not a success.
      const epermOutcome = await terminateVerifiedProcess(liveIdentity, {
        readIdentity: async () => ({ ...liveIdentity }),
        kill: () => { throw new Error('EPERM'); },
        waitForExit: async () => {},
      });
      assert.equal(epermOutcome.attempted, true);
      assert.equal(epermOutcome.exited, false, 'a thrown signal with a still-live process is not a successful termination');
      assert.match(epermOutcome.failure, /SIGTERM|signal/i);

      // SIGTERM window expires, SIGKILL is delivered, exit is verified.
      const escalated = await terminateVerifiedProcess(liveIdentity, {
        readIdentity: (() => { let calls = 0; return async () => { calls += 1; return calls <= 3 ? { ...liveIdentity } : undefined; }; })(),
        kill: (pid, signal) => signal === 'SIGKILL',
        // The SIGTERM window expires (throw), the SIGKILL phase verifies exit.
        waitForExit: async (expected, phase) => { if (phase === 'terminate') throw new Error('the exact verified process remained alive during terminate'); },
      });
      assert.equal(escalated.attempted, true);
      assert.equal(escalated.signalled, 'SIGKILL');
      assert.equal(escalated.exited, true, 'exit must be verified after escalation');
      assert.equal(escalated.failure, null);

      // SIGKILL thrown while the process is still live: failure, not silence.
      const killFailure = await terminateVerifiedProcess(liveIdentity, {
        readIdentity: async () => ({ ...liveIdentity }),
        kill: (pid, signal) => { if (signal === 'SIGKILL') throw new Error('EPERM'); return true; },
        waitForExit: async (_expected, phase) => { if (phase === 'terminate') throw new Error('remained alive during terminate'); },
      });
      assert.equal(killFailure.exited, false);
      assert.match(killFailure.failure, /SIGKILL|alive/i);

      // A process that is already gone needs no signal and reports exit.
      const gone = await terminateVerifiedProcess(liveIdentity, {
        readIdentity: async () => undefined,
        kill: () => { throw new Error('must not signal'); },
        waitForExit: async () => {},
      });
      assert.equal(gone.attempted, false);
      assert.equal(gone.exited, true);
      assert.equal(gone.failure, null);
    });

    test('the held lifecycle attaches its structured cleanup record to the thrown failure', async () => {
      const failure = await runHeldHostTurn({
        launch: async () => ({ result: Promise.reject(new Error('rollout parse failed')), terminate: async () => {} }),
        waitForGate: async () => new Promise(() => {}),
        captureProcessIdentity: async () => ({ pid: 68100, ppid: 91, nonce: TEST_NONCE, startIdentity: 'start-a' }),
        readProcessIdentity: async () => ({ pid: 68100, ppid: 91, nonce: TEST_NONCE, startIdentity: 'start-a' }),
        terminateProcessIdentity: async () => ({ attempted: true, signalled: 'SIGTERM', exited: false, failure: 'SIGTERM could not be signalled (EPERM) and the exact fake-ZCode process remains live' }),
        releaseGate: async () => {},
        sleep: async () => {},
        now: () => 0,
        holdMs: 0,
        budgetMs: 60_000,
      }).catch((error) => error);
      assert.match(failure?.message, /rollout parse failed/);
      assert.ok(failure?.heldTurn, 'the thrown failure must carry the structured held-turn record');
      assert.equal(failure.heldTurn.cleanup.verifiedProcessTerminated, false);
      assert.equal(failure.heldTurn.cleanup.errors.length, 1, 'the failed termination must be among the recorded cleanup errors');
      assert.match(String(failure.heldTurn.cleanup.errors[0]), /remains live/);
    });

    test('a failed signal through the held lifecycle surfaces as a cleanup error, not completed cleanup', async () => {
      const held = await runHeldHostTurn({
        launch: async () => ({ result: new Promise(() => {}), terminate: async () => {} }),
        waitForGate: async () => new Promise(() => {}),
        captureProcessIdentity: async () => ({ pid: 66201, ppid: 85, nonce: TEST_NONCE, startIdentity: 'start-a' }),
        readProcessIdentity: async () => ({ pid: 66201, ppid: 85, nonce: TEST_NONCE, startIdentity: 'start-a' }),
        terminateProcessIdentity: async () => ({ attempted: true, signalled: 'SIGTERM', exited: false, failure: 'SIGTERM could not be signalled (EPERM) and the exact fake-ZCode process remains live' }),
        releaseGate: async () => {},
        sleep: async () => {},
        now: (() => { let value = 0; return () => (value += 120_000); })(),
        holdMs: 5_000,
        budgetMs: 100,
      });
      assert.equal(held.budgetExpired, true);
      assert.equal(held.cleanup.verifiedProcessTerminated, false, 'a failed signal must not be reported as completed termination');
      assert.ok(held.cleanup.errors.length >= 1, 'the signal failure must be recorded as a cleanup error');
    });

    test('terminateVerifiedProcess signals only the exact verified identity', async () => {
      const identity = { pid: 65123, ppid: 81, nonce: TEST_NONCE, startIdentity: 'start-a' };
      const kills = [];
      const kill = (pid, signal) => { kills.push([pid, signal]); return true; };
      await terminateVerifiedProcess(identity, {
        readIdentity: async (expected) => (expected.pid === identity.pid && expected.nonce === identity.nonce ? { ...identity } : undefined),
        kill,
        waitForExit: async () => {},
      });
      assert.deepEqual(kills, [[identity.pid, 'SIGTERM']]);
    });

    test('terminateVerifiedProcess never signals a stale, reparented, or nonce-mismatched PID', async () => {
      const identity = { pid: 65124, ppid: 82, nonce: TEST_NONCE, startIdentity: 'start-a' };
      for (const readIdentity of [
        async () => undefined, // already exited
        async () => ({ pid: identity.pid, ppid: 1, nonce: identity.nonce, startIdentity: 'start-a' }), // reparented
        async () => ({ pid: identity.pid, ppid: identity.ppid, nonce: OTHER_NONCE, startIdentity: 'start-a' }), // nonce changed
        async () => ({ pid: identity.pid, ppid: identity.ppid, nonce: identity.nonce, startIdentity: 'start-b' }), // restarted
      ]) {
        const kills = [];
        await terminateVerifiedProcess(identity, {
          readIdentity,
          kill: (pid, signal) => { kills.push([pid, signal]); return true; },
          waitForExit: async () => {},
        });
        assert.deepEqual(kills, [], 'an unverified identity must never be signalled');
      }
    });

    test('runHeldHostTurn completes a held observation and labels its cleanup as observation', async () => {
      const events = [];
      let resolveResult;
      const held = await runHeldHostTurn({
        launch: async () => ({ result: new Promise((resolve) => { resolveResult = resolve; }) }),
        waitForGate: async () => { events.push('gate-held'); },
        captureProcessIdentity: async () => ({ pid: 66123, ppid: 71, nonce: TEST_NONCE, startIdentity: 'start-a' }),
        readProcessIdentity: async () => ({ pid: 66123, ppid: 71, nonce: TEST_NONCE, startIdentity: 'start-a' }),
        waitForProcessExit: async () => { events.push('exit'); },
        sleep: async () => { events.push('held'); },
        releaseGate: async () => { events.push('gate-released'); resolveResult({ code: 0, stdout: 'sentinel', stderr: '' }); },
        now: (() => { let value = 0; return () => (value += 1000); })(),
        holdMs: 0,
        budgetMs: 60_000,
      });
      assert.equal(held.endedBeforeGate, false);
      assert.equal(held.budgetExpired, false);
      assert.equal(held.cleanup.label, 'observation');
      assert.equal(held.cleanup.nativeInterruptionClaimed, false);
      assert.equal(held.processAliveWhileHeld, true);
    });

    test('budget expiry bounds the whole run, releases the gate, and is labelled budget cleanup', async () => {
      const events = [];
      const held = await runHeldHostTurn({
        launch: async () => ({ result: new Promise(() => {}), terminate: async () => { events.push('codex-terminated'); } }),
        waitForGate: async () => new Promise(() => {}),
        captureProcessIdentity: async () => ({ pid: 66124, ppid: 72, nonce: TEST_NONCE, startIdentity: 'start-a' }),
        readProcessIdentity: async () => ({ pid: 66124, ppid: 72, nonce: TEST_NONCE, startIdentity: 'start-a' }),
        terminateProcessIdentity: async () => { events.push('exact-process-terminated'); },
        waitForProcessExit: async () => {},
        releaseGate: async () => { events.push('gate-released'); },
        sleep: async () => {},
        now: (() => { let value = 0; return () => (value += 60_000); })(),
        holdMs: 5_000,
        budgetMs: 120_000,
      });
      assert.equal(held.endedBeforeGate, false);
      assert.equal(held.budgetExpired, true);
      assert.equal(held.cleanup.label, 'budget-cleanup');
      assert.equal(held.cleanup.nativeInterruptionClaimed, false, 'budget cleanup must never be labelled native interruption');
      assert.deepEqual(events, ['gate-released', 'exact-process-terminated', 'codex-terminated']);
    });

    test('budget cleanup never signals an identity it could not verify', async () => {
      const events = [];
      const held = await runHeldHostTurn({
        launch: async () => ({ result: new Promise(() => {}), terminate: async () => { events.push('codex-terminated'); } }),
        waitForGate: async () => new Promise(() => {}),
        captureProcessIdentity: async () => { throw new Error('process marker unavailable'); },
        releaseGate: async () => { events.push('gate-released'); },
        sleep: async () => {},
        now: (() => { let value = 0; return () => (value += 60_000); })(),
        holdMs: 5_000,
        budgetMs: 120_000,
      });
      assert.equal(held.budgetExpired, true);
      assert.equal(held.cleanup.label, 'budget-cleanup');
      assert.deepEqual(events, ['gate-released', 'codex-terminated'], 'without a verified identity no exact process is signalled');
      assert.equal(held.cleanup.verifiedProcessTerminated, false);
    });

    test('an early host result settles outstanding cancellable polling loops before returning', async () => {
      const events = [];
      let pollIterations = 0;
      let pollSettled = false;
      const cancellableGatePoll = async (signal) => {
        for (;;) {
          if (signal.aborted) { pollSettled = true; throw new Error('gate poll aborted'); }
          pollIterations += 1;
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      };
      const held = await runHeldHostTurn({
        launch: async () => ({ result: Promise.resolve({ code: 1, stdout: '', stderr: 'early exit' }), terminate: async () => { events.push('codex-terminated'); } }),
        waitForGate: cancellableGatePoll,
        captureProcessIdentity: async () => ({ pid: 66125, ppid: 73, nonce: TEST_NONCE, startIdentity: 'start-a' }),
        readProcessIdentity: async () => ({ pid: 66125, ppid: 73, nonce: TEST_NONCE, startIdentity: 'start-a' }),
        terminateProcessIdentity: async () => { events.push('exact-process-terminated'); },
        waitForProcessExit: async () => {},
        releaseGate: async () => { events.push('gate-released'); },
        sleep: async () => {},
        now: () => 0,
        holdMs: 5_000,
        budgetMs: 60_000,
      });
      assert.equal(held.endedBeforeGate, true);
      assert.equal(held.cleanup.label, 'early-exit');
      assert.deepEqual(events, ['gate-released', 'exact-process-terminated', 'codex-terminated']);
      const before = pollIterations;
      await new Promise((resolve) => setTimeout(resolve, 60));
      assert.equal(pollSettled, true, 'the cancellable gate poll must have observed the abort');
      assert.equal(pollIterations, before, 'the gate poll must stop iterating after the early exit');
    });

    test('a never-written empty marker classifies as absence, not corruption', async (t) => {
      const { captureVerifiedProcessIdentity } = await import('../tools/shell-wait-probe/fixture.mjs');
      const temporary = await mkdtemp(join(tmpdir(), 'shell-wait-empty-marker-'));
      t.after(() => rm(temporary, { recursive: true, force: true }));
      const emptyMarker = join(temporary, 'process.json');
      await writeFile(emptyMarker, '', 'utf8');
      const failure = await captureVerifiedProcessIdentity(emptyMarker, TEST_NONCE).catch((error) => error);
      assert.equal(failure?.code, 'ZCODE_SHELL_WAIT_MARKER_ABSENT', 'an empty precreated marker means no fake process ever launched');
    });

    test('the clone registration comparator matches canonical forms and rejects different paths', async () => {
      const fixtureModule = await import('../tools/shell-wait-probe/fixture.mjs');
      const { sameRegisteredPath, registeredWorktreePaths } = fixtureModule;
      assert.equal(sameRegisteredPath('/private/var/folders/T/zcode-shell-wait-fixture-x/clean-source', '/var/folders/T/zcode-shell-wait-fixture-x/clean-source'), true, 'git-reported /private/var must match the registered /var path');
      assert.equal(sameRegisteredPath('/var/folders/T/zcode-shell-wait-fixture-x/clean-source', '/var/folders/T/zcode-shell-wait-fixture-x/clean-source'), true, 'identical paths must match');
      assert.equal(sameRegisteredPath('/var/folders/T/other-fixture/clean-source', '/var/folders/T/zcode-shell-wait-fixture-x/clean-source'), false, 'a different path must never match');
      assert.equal(sameRegisteredPath('/var/folders/T/zcode-shell-wait-fixture-x/clean-source-sibling', '/var/folders/T/zcode-shell-wait-fixture-x/clean-source'), false, 'a prefix-sharing sibling path must never match');
      const listed = [
        'worktree /private/var/folders/T/zcode-shell-wait-fixture-x/source-repository',
        'branch refs/heads/docs/rescue-shell-long-wait',
        '',
        'worktree /private/var/folders/T/zcode-shell-wait-fixture-x/clean-source',
        'HEAD detached',
        '',
        'worktree /private/var/folders/T/zcode-marketplace-build-x/exact source',
        'HEAD detached',
      ].join('\n');
      assert.deepEqual(registeredWorktreePaths(listed), [
        '/private/var/folders/T/zcode-shell-wait-fixture-x/source-repository',
        '/private/var/folders/T/zcode-shell-wait-fixture-x/clean-source',
        '/private/var/folders/T/zcode-marketplace-build-x/exact source',
      ]);
    });

    test('a rejecting host result aborts the cancellable gate poll before the rejection propagates', async () => {
      let pollIterations = 0;
      let pollSettled = false;
      const cancellableGatePoll = async (signal) => {
        for (;;) {
          if (signal.aborted) { pollSettled = true; throw new Error('gate poll aborted'); }
          pollIterations += 1;
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      };
      await assert.rejects(runHeldHostTurn({
        launch: async () => ({ result: Promise.reject(new Error('the host result rejected')), terminate: async () => {} }),
        waitForGate: cancellableGatePoll,
        gatePath: join(tmpdir(), 'unused-shell-wait-reject-gate'),
        releaseGate: async () => {},
        captureProcessIdentity: async () => ({ pid: 67123, ppid: 74, nonce: TEST_NONCE, startIdentity: 'start-a' }),
        readProcessIdentity: async () => undefined,
        holdMs: 0,
        budgetMs: 120_000,
        now: () => 0,
      }), /the host result rejected/);
      const before = pollIterations;
      await new Promise((resolve) => setTimeout(resolve, 60));
      assert.equal(pollSettled, true, 'the cancellable gate poll must observe the abort on the rejection path');
      assert.equal(pollIterations, before, 'the gate poll must stop iterating after the rejection');
    });

    test('an invalid identity marker is recorded as incomplete cleanup and never signalled', async () => {
      const events = [];
      const invalidMarkerError = Object.assign(new Error('the exact fake-ZCode process marker identity is invalid'), { code: 'ZCODE_SHELL_WAIT_MARKER_INVALID' });
      const held = await runHeldHostTurn({
        launch: async () => ({ result: new Promise(() => {}), terminate: async () => { events.push('codex-terminated'); } }),
        waitForGate: async () => new Promise(() => {}),
        captureProcessIdentity: async () => { throw invalidMarkerError; },
        releaseGate: async () => { events.push('gate-released'); },
        sleep: async () => {},
        now: (() => { let value = 0; return () => (value += 120_000); })(),
        holdMs: 5_000,
        budgetMs: 100,
      });
      assert.equal(held.budgetExpired, true);
      assert.equal(held.cleanup.verifiedProcessTerminated, false, 'an unverified process must not receive a successful cleanup verdict');
      assert.ok(held.cleanup.errors.some((error) => String(error?.code ?? '') === 'ZCODE_SHELL_WAIT_MARKER_INVALID' || /invalid/i.test(error instanceof Error ? error.message : String(error))), 'marker corruption must be recorded as a cleanup error');
      assert.deepEqual(events, ['gate-released', 'codex-terminated'], 'the unverified PID must never be signalled');
      const facts = mapShellWaitLiveFacts(
        { case: 'rescue-long', codexBinary: '/bin/x', sourceSha: 'a'.repeat(40), output: '/o', workerDurationMs: 1000, capMs: null, pollMs: 60000, budgetMs: 2000 },
        held, { status: 'inconclusive', inconclusive: { reason: 'r', detail: 'd' }, facts: null }, null, null,
        { workspace: '/w', codexHome: '/h', installedRoot: '/i', env: {} },
      );
      assert.equal(facts.held.cleanupComplete, false, 'marker corruption must map to an incomplete cleanup');
    });

    test('releaseCompletionGate writes the exact release token', async (t) => {
      const temporary = await mkdtemp(join(tmpdir(), 'shell-wait-gate-'));
      t.after(() => rm(temporary, { recursive: true, force: true }));
      const gatePath = join(temporary, 'gate');
      await writeFile(gatePath, 'hold', 'utf8');
      await releaseCompletionGate(gatePath);
      assert.equal(await readFile(gatePath, 'utf8'), 'release');
    });
  });

  describe('shell wait observation poll and record redaction', async () => {
    const { waitForLauncherObservation, redactPrivatePaths, mapShellWaitLiveFacts } = await import('../tools/shell-wait-probe/driver.mjs');
    const { inspectShellWaitEvidence } = await import('../tools/shell-wait-probe/evidence.mjs');

    const PARENT = 'p'; const CHILD = 'c'; const AGENT_PATH = '/root/t1'; const HANDLE = 91;
    const LAUNCHER = 'node "/i/l.mjs" invoke-prepared rescue';
    const SENTINEL = 'ZCODE_RESCUE_PUBLIC_SENTINEL_7C9C';
    function qualifiedRollouts(companionExitCode = 0) {
      const meta = (id, extra = {}) => ({ type: 'session_meta', payload: { id, ...extra } });
      const childMeta = meta(CHILD, { parent_thread_id: PARENT, source: { subagent: { thread_spawn: { agent_path: AGENT_PATH } } } });
      const fnCall = (name, callId, args) => ({ type: 'response_item', payload: { type: 'function_call', name, call_id: callId, arguments: JSON.stringify(args) } });
      const wrapped = (kind, callId, value) => ({ type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: callId, input: `const r = await tools.${kind}(${JSON.stringify(value)}); text(JSON.stringify(r))\n` } });
      const out = (callId, output) => ({ type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: callId, output } });
      const completed = (result) => [{ type: 'input_text', text: 'Script completed\n' }, { type: 'input_text', text: JSON.stringify(result) }];
      const started = () => ({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'SubAgentActivity', kind: 'started', agent_thread_id: CHILD, agent_path: AGENT_PATH } } });
      return [
        [meta(PARENT), fnCall('spawn_agent', 's1', { task_name: 't1' }), started(), fnCall('wait_agent', 'w1', { timeout_ms: 600000 })],
        [childMeta, wrapped('exec_command', 'l1', { cmd: LAUNCHER }), out('l1', completed({ output: '', session_id: HANDLE })),
         wrapped('write_stdin', 'p1', { session_id: HANDLE, chars: '', yield_time_ms: 60000 }),
         out('p1', completed({ output: SENTINEL, exit_code: companionExitCode }))],
      ];
    }
    const mappingInput = {
      case: 'rescue-baseline', codexBinary: '/bin/x', sourceSha: 'a'.repeat(40), output: '/o',
      workerDurationMs: 1000, capMs: null, pollMs: 60000, budgetMs: 2000,
    };
    const mappingFixture = {
      workspace: '/private/tmp/secret-ws', codexHome: '/private/tmp/secret-home', installedRoot: '/private/tmp/secret-installed', env: { HOME: '/private/tmp/secret-home' },
      record: { variant: 'baseline', capMs: null, pollMs: 60000, appliedArtifacts: [] },
    };

    const completedHeld = {
      endedBeforeGate: false, budgetExpired: false, processAliveWhileHeld: true,
      result: { code: 0, stdout: 'host JSONL is not companion stdout', stderr: '' },
      cleanup: { label: 'observation', releasedGate: true, errors: [] },
    };
    function mappedEvidence(rollouts, overrides = {}) {
      const evidence = inspectShellWaitEvidence({
        rollouts, zcodeCalls: [{ method: 'session/send' }], command: LAUNCHER,
        publicResult: SENTINEL, redactions: ['/private/tmp/secret-home'], ...overrides,
      });
      return mapShellWaitLiveFacts(mappingInput, completedHeld, evidence, '0.160.1', null, mappingFixture, rollouts, ['/private/tmp/secret-home']);
    }

    test('Task 4 retains successful rollout calls and pre-launch diagnostics in the case record', async (t) => {
      const rollouts = qualifiedRollouts();
      rollouts[1].splice(1, 0,
        { type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'd1', arguments: JSON.stringify({ cmd: 'cat /private/tmp/secret-home/skill' }) } },
        { type: 'response_item', payload: { type: 'function_call_output', call_id: 'd1', output: [{ type: 'input_text', text: JSON.stringify({ output: 'skill', exit_code: 0 }) }] } });
      const facts = mappedEvidence(rollouts);
      assert.ok(facts.collection, 'collection counts must survive mapping');
      assert.equal(facts.collection.rolloutCount, 2);
      assert.equal(facts.collection.childToolCallCount, 3);
      assert.equal(facts.collection.truncated, false);
      assert.equal(facts.excerpts.filter((entry) => entry.kind === 'rollout-tool-call').length, 2);
      assert.equal(facts.excerpts.filter((entry) => entry.kind === 'pre-launch-diagnostic').length, 1);
      assert.doesNotMatch(JSON.stringify(facts.excerpts), /\/private\/tmp\/secret-home/u);
      const { runShellWaitCase } = await import('../tools/shell-wait-probe/driver.mjs');
      const root = await mkdtemp(join(tmpdir(), 'shell-wait-retention-'));
      t.after(() => rm(root, { recursive: true, force: true }));
      const record = await runShellWaitCase({ ...mappingInput, codexBinary: process.execPath, output: root }, {
        createFixture: async () => ({ ...mappingFixture, dispose: async () => {} }),
        executeLiveCase: async () => facts,
      });
      assert.equal(record.evidence.rolloutCount, 2);
      assert.equal(record.evidence.childToolCallCount, 3);
      assert.equal(record.evidence.count, 3, 'count continues to mean retained excerpts');
      assert.deepEqual(JSON.parse(await readFile(join(root, 'rescue-baseline.record.json'), 'utf8')).evidence, record.evidence);
    });

    test('Task 4 caps call excerpts without truncating the collection count', () => {
      const rollouts = qualifiedRollouts();
      for (let n = 0; n < 70; n += 1) rollouts[1].push({ type: 'response_item', payload: {
        type: 'function_call', name: 'wait', call_id: `extra-${n}`, arguments: JSON.stringify({ cell_id: `cell-${n}` }),
      } });
      const facts = mappedEvidence(rollouts);
      assert.ok(facts.collection, 'collection counts must survive mapping');
      assert.equal(facts.collection.childToolCallCount, 72);
      assert.equal(facts.collection.truncated, true);
      assert.equal(facts.excerpts.filter((entry) => entry.kind === 'rollout-tool-call').length, 64);
    });

    test('Task 4 unavailable rollouts stay inconclusive with unknown collection counts', () => {
      const facts = mappedEvidence([]);
      assert.match(facts.inconclusive.reason, /rollouts-unavailable/u);
      assert.ok(facts.collection, 'unavailable counts must be explicit unknowns');
      assert.equal(facts.collection.rolloutCount, null);
      assert.equal(facts.collection.childToolCallCount, null);
      assert.equal(facts.linkage.companionLaunchCount, null);
    });

    test('Task 4 loads dated rollout files and matches thread metadata rather than filenames or session ids', async (t) => {
      const { loadShellWaitRollouts } = await import('../tools/shell-wait-probe/driver.mjs');
      const root = await mkdtemp(join(tmpdir(), 'shell-wait-layout-'));
      t.after(() => rm(root, { recursive: true, force: true }));
      const dated = join(root, 'sessions', '2026', '10', '06');
      await mkdir(dated, { recursive: true });
      const rollouts = qualifiedRollouts();
      const ids = ['01a111a2-66f2-7b53-8101-7c784edce02e', '01a111a3-0ef3-7892-930f-58d3775f6e3b'];
      rollouts[0][0].payload.id = ids[0]; rollouts[0][0].payload.session_id = 'different-parent-session';
      rollouts[0][2].payload.item.agent_thread_id = ids[1];
      rollouts[1][0].payload.id = ids[1]; rollouts[1][0].payload.session_id = 'different-child-session';
      rollouts[1][0].payload.parent_thread_id = ids[0];
      for (const [index, events] of rollouts.entries()) await writeFile(join(dated, `rollout-2026-10-06T22-41-43-${ids[index]}_other-rollout-id.jsonl`), events.map((event) => JSON.stringify(event)).join('\n') + '\n');
      const facts = mappedEvidence(await loadShellWaitRollouts(root));
      assert.equal(facts.linkage.childThreadId, ids[1]);
      assert.equal(facts.linkage.parentThreadId, ids[0]);
      assert.equal(facts.linkage.companionLaunchCount, 1);
      assert.equal(facts.inconclusive, null);
    });

    test('Task 4 layout or parse failures never qualify as silent zero', async (t) => {
      const { loadShellWaitRollouts } = await import('../tools/shell-wait-probe/driver.mjs');
      const root = await mkdtemp(join(tmpdir(), 'shell-wait-unavailable-'));
      t.after(() => rm(root, { recursive: true, force: true }));
      assert.match(mappedEvidence(await loadShellWaitRollouts(root)).inconclusive.reason, /rollouts-unavailable/u);
      await mkdir(join(root, 'sessions'));
      await writeFile(join(root, 'sessions', 'rollout-broken.jsonl'), '{broken\n');
      await assert.rejects(loadShellWaitRollouts(root), /JSON/u);
      const evidence = inspectShellWaitEvidence({ rollouts: [], command: LAUNCHER });
      const facts = mapShellWaitLiveFacts(mappingInput, completedHeld, evidence, '0.160.1', 'invalid JSON', mappingFixture);
      assert.match(facts.inconclusive.reason, /rollouts-unavailable.*invalid JSON/u);
      assert.equal(facts.collection.childToolCallCount, null);
    });

    test('Task 4 sentinel bytes survive production terminal rendering', async () => {
      const { formatDirectInvocationSuccess } = await import('../scripts/lib/direct-invocation-result.mjs');
      const rendered = formatDirectInvocationSuccess({ result: SENTINEL, job: { resumable: true } }).text;
      const rollouts = qualifiedRollouts();
      rollouts[1][4].payload.output[1].text = JSON.stringify({ output: rendered, exit_code: 0 });
      const facts = mappedEvidence(rollouts);
      assert.equal(facts.hostResult.sentinelMatched, true);
      assert.equal(facts.inconclusive, null);
      assert.equal(facts.excerpts.some((entry) => entry.kind === 'terminal-stdout-mismatch'), false);
      assert.equal(JSON.parse(rollouts[1][4].payload.output[1].text).output, rendered, 'the observer must preserve stdout unchanged');
    });

    test('Task 4 terminal mismatch retains bounded scrubbed stdout rather than host stdout', () => {
      const rollouts = qualifiedRollouts();
      rollouts[1][4].payload.output[1].text = JSON.stringify({ output: '/private/tmp/secret-home\u0000' + 'x'.repeat(3000), exit_code: 0 });
      const facts = mappedEvidence(rollouts);
      assert.equal(facts.hostResult.sentinelMatched, false);
      const excerpt = facts.excerpts.find((entry) => entry.kind === 'terminal-stdout-mismatch');
      assert.ok(excerpt, 'terminal mismatch excerpt must survive mapping');
      assert.equal(excerpt.truncated, true);
      assert.ok(excerpt.text.startsWith('<redacted> '));
      assert.ok(excerpt.text.length <= 2048 + '<truncated>'.length);
      assert.doesNotMatch(excerpt.text, /secret-home|host JSONL/u);
      assert.equal(excerpt.text.includes('\u0000'), false);
    });

    test('Task 4 altered sentinel bytes fail even when quoted messages contain the original', () => {
      const rollouts = qualifiedRollouts();
      rollouts[1][4].payload.output[1].text = JSON.stringify({ output: SENTINEL.toLowerCase() + '\n', exit_code: 0 });
      rollouts[1].push({ type: 'event_msg', payload: { type: 'agent_message', message: SENTINEL } });
      const facts = mappedEvidence(rollouts);
      assert.equal(facts.hostResult.sentinelMatched, false);
      assert.match(facts.inconclusive.reason, /byte-for-byte/u);
      const excerpt = facts.excerpts.find((entry) => entry.kind === 'terminal-stdout-mismatch');
      assert.ok(excerpt, 'terminal mismatch excerpt must survive mapping');
      assert.equal(excerpt.text, SENTINEL.toLowerCase() + '\n');
    });

    test('the companion process exit is mapped separately from the host exit', () => {
      const evidence = inspectShellWaitEvidence({
        rollouts: qualifiedRollouts(17), zcodeCalls: [{ id: 1, method: 'session/send', params: {} }],
        command: LAUNCHER, publicResult: SENTINEL, workerStillAliveAfterObservation: false, redactions: [],
      });
      const held = {
        endedBeforeGate: false, budgetExpired: false, identity: { pid: 1, ppid: 2, nonce: 'e'.repeat(64), startIdentity: 's' },
        processAliveWhileHeld: true, result: { code: 0, stdout: SENTINEL, stderr: '' },
        cleanup: { label: 'observation', releasedGate: true, verifiedProcessTerminated: true, codexTerminated: true, nativeInterruptionClaimed: false, errors: [] },
      };
      const facts = mapShellWaitLiveFacts(mappingInput, held, evidence, '0.160.0', null, mappingFixture);
      assert.equal(facts.hostResult.companionProcessExit, 17, 'the observed companion exit must be mapped from the evidence');
      assert.equal(facts.hostResult.exitCode, 0, 'the host exit stays a separate fact');
    });

    test('cleanup failures and termination outcomes persist on the early-exit mapping branch', () => {
      const evidence = inspectShellWaitEvidence({
        rollouts: qualifiedRollouts(), zcodeCalls: [{ id: 1, method: 'session/send', params: {} }],
        command: LAUNCHER, publicResult: SENTINEL, workerStillAliveAfterObservation: false, redactions: [],
      });
      const held = {
        endedBeforeGate: true, budgetExpired: false, identity: { pid: 1, ppid: 2, nonce: 'e'.repeat(64), startIdentity: 's' },
        processAliveWhileHeld: null, result: { code: 1, stdout: '', stderr: '' },
        cleanup: {
          label: 'early-exit', releasedGate: true, verifiedProcessTerminated: false, codexTerminated: true,
          nativeInterruptionClaimed: false,
          errors: [new Error('could not remove /private/tmp/secret-home/sessions: EPERM')],
        },
      };
      const facts = mapShellWaitLiveFacts(mappingInput, held, evidence, '0.160.0', null, mappingFixture);
      assert.equal(facts.held.cleanupErrors.count, 1, 'cleanup errors must reach the mapped facts');
      assert.doesNotMatch(facts.held.cleanupErrors.reasons.join(' '), /secret/);
      assert.equal(facts.held.processTermination.verifiedTerminated, false);
      assert.equal(facts.held.processTermination.codexTerminated, true);
      assert.equal(facts.held.cleanupComplete, false, 'an incomplete cleanup must be explicit');
      assert.match(String(facts.inconclusive?.reason), /cleanup/i);
    });

    test('cleanup failures persist on the budget mapping branch too', () => {
      const held = {
        endedBeforeGate: false, budgetExpired: true, identity: undefined, processAliveWhileHeld: null, result: undefined,
        cleanup: {
          label: 'budget-cleanup', releasedGate: true, verifiedProcessTerminated: false, codexTerminated: false,
          nativeInterruptionClaimed: false,
          errors: [new Error('the exact fake-ZCode process remained alive during terminate'), new Error('release failed')],
        },
      };
      const facts = mapShellWaitLiveFacts(mappingInput, held, { status: 'inconclusive', inconclusive: { reason: 'r', detail: 'd' }, facts: null }, null, null, mappingFixture);
      assert.equal(facts.held.cleanupErrors.count, 2);
      assert.equal(facts.held.processTermination.verifiedTerminated, false);
      assert.equal(facts.held.cleanupComplete, false);
      assert.match(String(facts.inconclusive?.reason), /cleanup/i);
    });

    test('a complete cleanup maps as complete with persisted outcomes', () => {
      const evidence = inspectShellWaitEvidence({
        rollouts: qualifiedRollouts(), zcodeCalls: [{ id: 1, method: 'session/send', params: {} }],
        command: LAUNCHER, publicResult: SENTINEL, workerStillAliveAfterObservation: false, redactions: [],
      });
      const held = {
        endedBeforeGate: false, budgetExpired: false, identity: { pid: 1, ppid: 2, nonce: 'e'.repeat(64), startIdentity: 's' },
        processAliveWhileHeld: true, result: { code: 0, stdout: SENTINEL, stderr: '' },
        cleanup: {
          label: 'observation', releasedGate: true, verifiedProcessTerminated: true, codexTerminated: true,
          nativeInterruptionClaimed: false, errors: [],
        },
      };
      const facts = mapShellWaitLiveFacts(mappingInput, held, evidence, '0.160.0', null, mappingFixture);
      assert.equal(facts.held.cleanupErrors.count, 0);
      assert.equal(facts.held.cleanupComplete, true);
      assert.equal(facts.held.processTermination.verifiedTerminated, true);
    });

    test('the observation poll retries transient rollout read/parse failures instead of aborting', async () => {
      const command = 'node "/i/l.mjs" invoke-prepared rescue';
      let attempts = 0;
      const transientLoader = async () => {
        attempts += 1;
        if (attempts <= 2) throw new Error('rollout record is not valid JSON');
        return [[
          { type: 'session_meta', payload: { id: 'p' } },
          { type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'l1', input: `const r = await tools.exec_command(${JSON.stringify({ cmd: command })}); text(JSON.stringify(r))\n` } },
        ]];
      };
      await waitForLauncherObservation('/unused/codex-home', command, new AbortController().signal, { loadRollouts: transientLoader });
      assert.equal(attempts, 3, 'the poll must retry transient loader failures and succeed afterwards');
    });

    test('a direct exec_command launcher call resolves the observation gate', async () => {
      const PARENT = 'p';
      const command = 'node "/i/l.mjs" invoke-prepared rescue';
      let attempts = 0;
      const directLoader = async () => {
        attempts += 1;
        if (attempts <= 2) return [];
        return [[
          { type: 'session_meta', payload: { id: PARENT } },
          { type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'l1', arguments: JSON.stringify({ cmd: command }) } },
        ]];
      };
      // The abort timeout bounds the RED case: an unrecognized direct call
      // currently polls until cancellation instead of resolving.
      await waitForLauncherObservation('/unused/codex-home', command, AbortSignal.timeout(3_000), { loadRollouts: directLoader });
      assert.equal(attempts, 3);
    });

    for (const [label, input] of [
      ['const-r', `const r = await tools.exec_command({cmd:'node "/i/l.mjs" invoke-prepared rescue'}); text(r)\n`],
      ['inline', `text(await tools.exec_command({cmd:'node "/i/l.mjs" invoke-prepared rescue'}));\n`],
    ]) {
      test(`a single-quoted ${label} launcher wrapper resolves the observation gate`, async () => {
        const controller = new AbortController();
        const event = { type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'l1', input } };
        await waitForLauncherObservation('/unused/codex-home', 'node "/i/l.mjs" invoke-prepared rescue', controller.signal, {
          loadRollouts: async () => [[event]],
          sleep: async () => { controller.abort(); },
        });
        assert.equal(controller.signal.aborted, false, 'a supported exact launcher must open the gate on the first read');
      });
    }

    test('the observation gate recognizes the launcher inside a multi-statement cell', async () => {
      const input = `text(await tools.exec_command({cmd:'node "/i/l.mjs" invoke-prepared rescue'}));\ntext(await tools.write_stdin({session_id:9,chars:''}));\n`;
      const event = { type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'l1', input } };
      const controller = new AbortController();
      await waitForLauncherObservation('/unused/codex-home', 'node "/i/l.mjs" invoke-prepared rescue', controller.signal, {
        loadRollouts: async () => [[event]],
        sleep: async () => { controller.abort(); },
      });
      assert.equal(controller.signal.aborted, false, 'the multi-statement launcher cell must open the gate on the first read');
    });

    test('the root-family companion command renders safely without the launcher leaf', async () => {
      const { renderCompanionCommand } = await import('../tools/shell-wait-probe/driver.mjs');
      const installedRoot = '/private/var/folders/x/T/zcode-shell-wait-fixture-abc123/installed';
      assert.equal(
        renderCompanionCommand(`${installedRoot}/scripts/zcode-companion.mjs`),
        `node "${installedRoot}/scripts/zcode-companion.mjs"`,
        'the root-family cases render their own script path, not the Rescue launcher leaf',
      );
      for (const bad of [
        `${installedRoot}/skills/rescue/launcher.mjs`,
        `${installedRoot}/scripts/zcode-companion.mjs; rm -rf /`,
        `${installedRoot}/scripts/zcode-companion.mjs "$HOME"`,
        'relative/scripts/zcode-companion.mjs',
      ]) {
        assert.throws(() => renderCompanionCommand(bad), /cannot be rendered safely/u, JSON.stringify(bad));
      }
    });

    test('the observation gate rejects quoted command text outside an exact supported exec cmd', async () => {
      const command = 'node "/i/l.mjs" invoke-prepared rescue';
      for (const input of [
        `const r = await tools.exec_command(${JSON.stringify({ cmd: 'other', note: command })}); text(r)\n`,
        `const r = await tools.exec_command(${JSON.stringify({ cmd: `${command} extra` })}); text(r)\n`,
        `text(await tools.write_stdin(${JSON.stringify({ chars: command })}));\n`,
        `text(${JSON.stringify(command)});\n`,
        `const r = await tools.exec_command(${JSON.stringify({ cmd: command })}); text(r)\ntext("extra");\n`,
      ]) {
        const controller = new AbortController();
        await assert.rejects(waitForLauncherObservation('/unused/codex-home', command, controller.signal, {
          loadRollouts: async () => [[{ type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', input } }]],
          sleep: async () => { controller.abort(); },
        }), /aborted/, input);
      }
    });

    test('the observation poll rethrows a persistently failing loader after its bounded retries', async () => {
      const alwaysFailing = async () => { throw new Error('rollout discovery exceeded its bound'); };
      await assert.rejects(
        waitForLauncherObservation('/unused/codex-home', 'node "/i/l.mjs" invoke-prepared rescue', new AbortController().signal, { loadRollouts: alwaysFailing }),
        /exceeded its bound/,
      );
    });

    test('an early host exit carries a scrubbed final-agent-message adjudication excerpt', async () => {
      const { mapShellWaitLiveFacts, extractFinalAgentMessage } = await import('../tools/shell-wait-probe/driver.mjs');
      const rollouts = [[
        { type: 'session_meta', payload: { id: 'p' } },
        { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'intermediate assistant message' }] } },
        { type: 'event_msg', payload: { type: 'agent_message', message: 'ZCode Rescue launcher context is unavailable at /private/tmp/secret-home; retry from an owned parent turn.' } },
      ]];
      assert.equal(extractFinalAgentMessage(rollouts), 'ZCode Rescue launcher context is unavailable at /private/tmp/secret-home; retry from an owned parent turn.', 'the last observed assistant message must win');
      assert.equal(extractFinalAgentMessage([]), null);
      const earlyHeld = {
        endedBeforeGate: true, budgetExpired: false, identity: undefined, processAliveWhileHeld: null,
        result: { code: 0, stdout: '', stderr: '' },
        cleanup: { label: 'early-exit', releasedGate: true, verifiedProcessTerminated: false, codexTerminated: true, nativeInterruptionClaimed: false, errors: [] },
      };
      const evidence = inspectShellWaitEvidence({
        rollouts: qualifiedRollouts(), zcodeCalls: [{ id: 1, method: 'session/send', params: {} }],
        command: LAUNCHER, publicResult: SENTINEL, workerStillAliveAfterObservation: false, redactions: [],
      });
      const facts = mapShellWaitLiveFacts(mappingInput, earlyHeld, evidence, '0.160.1', null, mappingFixture, rollouts, ['/private/tmp/secret-home']);
      const excerpt = facts.excerpts.find((entry) => entry.kind === 'final-agent-message');
      assert.ok(excerpt, 'the early-exit record must carry the final agent message for adjudication');
      assert.doesNotMatch(excerpt.text, /secret-home/);
      assert.match(excerpt.text, /<redacted>/);
      const completeFacts = mapShellWaitLiveFacts(mappingInput, { ...earlyHeld, endedBeforeGate: false }, evidence, '0.160.1', null, mappingFixture, rollouts, []);
      assert.equal(completeFacts.excerpts.some((entry) => entry.kind === 'final-agent-message'), false, 'no adjudication excerpt without an early exit');
      assert.equal(mapShellWaitLiveFacts(mappingInput, earlyHeld, evidence, '0.160.1', null, mappingFixture, [], []).excerpts.some((entry) => entry.kind === 'final-agent-message'), false, 'a missing message adds no excerpt');
    });

    test('redactPrivatePaths scrubs fixture-private paths before any reason enters the record', async () => {
      const fixture = {
        workspace: '/private/tmp/secret-root/workspace',
        codexHome: '/private/tmp/secret-root/codex-home',
        installedRoot: '/private/tmp/secret-root/installed',
        env: { HOME: '/private/tmp/secret-root/home' },
      };
      const scrubbed = redactPrivatePaths('rollout collection failed (ENOENT: /private/tmp/secret-root/codex-home/sessions missing)', fixture);
      assert.doesNotMatch(scrubbed, /secret-root/);
      assert.match(scrubbed, /<redacted>/);
    });
  });

  describe('held-host stdin closure (installed 0.160.1 exec reads stdin to EOF)', async () => {
    const { closeStdinLaunch } = await import('../tools/shell-wait-probe/driver.mjs');
    const { spawn } = await import('node:child_process');

    test('closeStdinLaunch wraps the exact host argv in an exec sh whose stdin is /dev/null', () => {
      const wrapped = closeStdinLaunch({ command: '/usr/local/bin/codex', args: ['exec', '--json', 'prompt'] });
      assert.equal(wrapped.command, '/bin/sh', 'the wrapper must be the POSIX shell');
      assert.deepEqual(
        wrapped.args,
        ['-c', 'exec "$0" "$@" </dev/null', '/usr/local/bin/codex', 'exec', '--json', 'prompt'],
        'the wrapped argv must exec the exact host command with its exact arguments',
      );
    });

    test('a wrapped read-stdin-to-EOF process finishes at EOF while the open-pipe shape stays blocked', async () => {
      // The reader mimics the installed host's prompt resolution: read stdin to
      // EOF, then report how many bytes arrived. With the shared runner's
      // never-ending pipe this blocks forever (the live Case 0 failure); the
      // wrapper must hand the child an already-at-EOF stdin.
      const reader = 'let n=0;for(;;){const c=require("fs").readSync(0,Buffer.alloc(4096));if(!c.length)break;n+=c.length;}process.stdout.write(`bytes:${n}`)';
      const unwrapped = spawn(process.execPath, ['-e', reader], { stdio: ['pipe', 'pipe', 'pipe'] });
      const unwrappedOutcome = await Promise.race([
        new Promise((resolve) => unwrapped.once('exit', () => resolve('exited'))),
        new Promise((resolve) => setTimeout(() => resolve('running'), 1_200)),
      ]);
      unwrapped.kill('SIGKILL');
      assert.equal(unwrappedOutcome, 'running', 'the open-pipe shape must still block (regression premise)');
      const wrapped = closeStdinLaunch({ command: process.execPath, args: ['-e', reader] });
      const child = spawn(wrapped.command, wrapped.args, { stdio: ['pipe', 'pipe', 'pipe'] });
      const output = await new Promise((resolve, reject) => {
        let text = '';
        const timer = setTimeout(() => reject(new Error('the wrapped reader still blocked on the open parent pipe')), 5_000);
        child.stdout.on('data', (chunk) => { text += String(chunk); });
        child.once('exit', () => { clearTimeout(timer); resolve(text); });
        child.once('error', (error) => { clearTimeout(timer); reject(error); });
      });
      assert.equal(output, 'bytes:0', 'the wrapper must give the held host an at-EOF stdin (0 bytes read)');
    });
  });

  describe('shell wait driver CLI', async () => {
    const driverCli = fileURLToPath(new URL('../tools/shell-wait-probe/driver.mjs', import.meta.url));
    const { runShellWaitCase } = await import('../tools/shell-wait-probe/driver.mjs');

    test('a pre-turn setup failure persists a failed record with unknown held facts', async (t) => {
      const temporary = await mkdtemp(join(tmpdir(), 'shell-wait-setup-fail-'));
      t.after(() => rm(temporary, { recursive: true, force: true }));
      const output = join(temporary, 'output');
      await mkdir(output, { mode: 0o700 });
      // codexHome lives UNDER a regular file, so the executor's gate-directory
      // creation (`mkdir(codexHome/../gates)`) fails with ENOTDIR before any
      // held lifecycle runs.
      const blocker = join(temporary, 'blocker');
      await writeFile(blocker, 'not a directory', 'utf8');
      const blockedHome = join(blocker, 'home');
      const previousGate = process.env.ZCODE_SHELL_WAIT_E2E;
      process.env.ZCODE_SHELL_WAIT_E2E = '1';
      try {
      await assert.rejects(runShellWaitCase({
        case: 'rescue-baseline', codexBinary: process.execPath, sourceSha: 'a'.repeat(40),
        output, workerDurationMs: 1000, capMs: null, pollMs: 60000, budgetMs: 2000,
      }, {
        createFixture: async () => ({
          workspace: join(temporary, 'workspace'), codexHome: blockedHome, installedRoot: join(temporary, 'installed'),
          env: { CODEX_BINARY: process.execPath, HOME: temporary }, record: { variant: 'baseline', capMs: null, pollMs: 60000, appliedArtifacts: [] },
          dispose: async () => {},
        }),
      }), /gates|directory/i);
      } finally {
        if (previousGate === undefined) delete process.env.ZCODE_SHELL_WAIT_E2E;
        else process.env.ZCODE_SHELL_WAIT_E2E = previousGate;
      }
      const written = JSON.parse(await readFile(join(output, 'rescue-baseline.record.json'), 'utf8'));
      assert.equal(written.status, 'failed');
      assert.equal(written.held.endedBeforeGate, null, 'a pre-turn failure has no held-turn record');
      assert.equal(written.cleanup.cleanupComplete, null, 'no cleanup ran, so completeness stays unknown');
      assert.match(written.inconclusive.reason, /failed before evidence collection|directory|gates/i);
    });

    test('an early host exit with a never-written marker keeps cleanup complete', async (t) => {
      const temporary = await mkdtemp(join(tmpdir(), 'shell-wait-early-exit-'));
      t.after(() => rm(temporary, { recursive: true, force: true }));
      const output = join(temporary, 'output');
      await mkdir(output, { mode: 0o700 });
      const previousGate = process.env.ZCODE_SHELL_WAIT_E2E;
      process.env.ZCODE_SHELL_WAIT_E2E = '1';
      let record;
      try {
      record = await runShellWaitCase({
        case: 'rescue-baseline', codexBinary: process.execPath, sourceSha: 'a'.repeat(40),
        output, workerDurationMs: 1000, capMs: null, pollMs: 60000, budgetMs: 2000,
      }, {
        createFixture: async () => {
          const workspace = join(temporary, 'workspace');
          await (await import('node:fs/promises')).mkdir(workspace, { recursive: true });
          return {
          workspace, codexHome: join(temporary, 'codex-home'), installedRoot: join(temporary, 'installed'),
          env: { CODEX_BINARY: process.execPath, HOME: temporary }, record: { variant: 'baseline', capMs: null, pollMs: 60000, appliedArtifacts: [] },
          dispose: async () => {},
          };
        },
      });
      } finally {
        if (previousGate === undefined) delete process.env.ZCODE_SHELL_WAIT_E2E;
        else process.env.ZCODE_SHELL_WAIT_E2E = previousGate;
      }
      assert.equal(record.status, 'executed');
      assert.equal(record.cleanup.cleanupComplete, true, 'an early host exit with no fake process is a complete cleanup, not marker corruption');
      assert.equal(record.held.cleanupErrors.count, 0);
      assert.equal(record.held.processTermination.verifiedTerminated, false);
      assert.equal(record.held.endedBeforeGate, true);
    });

    test('gated dispatch reaches the live executor without a TDZ failure or an authenticated host launch', async (t) => {
      const temporary = await mkdtemp(join(tmpdir(), 'shell-wait-cli-dispatch-'));
      t.after(() => rm(temporary, { recursive: true, force: true }));
      const output = join(temporary, 'output');
      await mkdir(output, { mode: 0o700 });
      const script = `
        const { join } = await import('node:path');
        const { runShellWaitCase } = await import(${JSON.stringify(pathToFileURL(driverCli).href)});
        const record = await runShellWaitCase({
          case: 'rescue-baseline', codexBinary: process.execPath, sourceSha: ${JSON.stringify(spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim())},
          output: ${JSON.stringify(output)}, workerDurationMs: 1000, capMs: null, pollMs: 60000, budgetMs: 2000,
        }, {
          createFixture: async () => {
            const root = ${JSON.stringify(temporary)};
            const workspace = join(root, 'workspace');
            await (await import('node:fs/promises')).mkdir(workspace, { recursive: true });
            return {
            workspace, codexHome: join(root, 'codex-home'),
            installedRoot: join(root, 'installed'), env: { CODEX_BINARY: process.execPath, HOME: root },
            record: { variant: 'baseline', capMs: null, pollMs: 60000, appliedArtifacts: [] },
            dispose: async () => {},
            };
          },
        });
        console.log('DISPATCH:' + record.status);
      `;
      const child = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
        encoding: 'utf8', env: { ...process.env, ZCODE_SHELL_WAIT_E2E: '1' }, timeout: 60_000,
      });
      assert.equal(child.status, 0, `gated dispatch failed:\n${child.stdout}\n${child.stderr}`);
      assert.match(child.stdout, /DISPATCH:executed/);
      assert.doesNotMatch(child.stderr, /before initialization/i, 'the live executor must be initialized before the CLI dispatches');
    });

    test('--help prints usage, exits zero, and never launches a host', () => {
      const result = spawnSync(process.execPath, [driverCli, '--help'], {
        encoding: 'utf8',
        env: { ...process.env, CODEX_BINARY: 'never-launched', ZCODE_SHELL_WAIT_E2E: '1' },
        timeout: 30_000,
      });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /usage: node tools\/shell-wait-probe\/driver.mjs/);
      assert.match(result.stdout, /rescue-baseline/);
    });

    test('an unknown case, unknown option, or relative executable fails closed with exit one', () => {
      const sourceSha = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
      const invalidArgumentSets = [
        ['--case', 'not-a-case', '--codex', process.execPath, '--source-sha', sourceSha, '--output', '/tmp'],
        ['--case', 'rescue-long', '--codex', process.execPath, '--source-sha', sourceSha, '--output', '/tmp', '--worker', '1'],
        ['--case', 'rescue-long', '--codex', 'relative/codex', '--source-sha', sourceSha, '--output', '/tmp'],
      ];
      for (const arguments_ of invalidArgumentSets) {
        const result = spawnSync(process.execPath, [driverCli, ...arguments_], { encoding: 'utf8', timeout: 30_000 });
        assert.equal(result.status, 1, `expected exit 1 for ${arguments_.join(' ')}`);
        assert.match(result.stderr, /Invalid shell wait case input|usage:/);
      }
    });
  });
}
