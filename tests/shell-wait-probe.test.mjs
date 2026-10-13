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

    test('the record carries an observer provenance block computed from the actual instrument, separate from the fixture sourceSha', async (t) => {
      const temporary = await mkdtemp(join(tmpdir(), 'shell-wait-case-observer-'));
      t.after(() => rm(temporary, { recursive: true, force: true }));
      const output = join(temporary, 'output');
      await mkdir(output, { mode: 0o700 });
      const secondOutput = join(temporary, 'second-output');
      await mkdir(secondOutput, { mode: 0o700 });
      const fakeFixture = {
        workspace: join(temporary, 'fixture', 'workspace'),
        codexHome: join(temporary, 'fixture', 'codex-home'),
        installedRoot: join(temporary, 'fixture', 'installed'),
        env: { CODEX_HOME: join(temporary, 'fixture', 'codex-home') },
        record: { variant: 'baseline', capMs: null, pollMs: 60_000, appliedArtifacts: [] },
        dispose: async () => {},
      };
      const record = await runShellWaitCase(caseInput({ output }), {
        createFixture: async () => fakeFixture,
        executeLiveCase: async () => emptyLiveFacts(),
      });
      const observer = record.provenance.observer;
      assert.ok(observer, 'the observer provenance block must exist in the case record');
      assert.equal(observer.revision, 'working-tree-uncommitted', 'the executing observer revision marker must name the uncommitted working tree');
      assert.match(observer.digest, /^[a-f0-9]{64}$/u, 'the observer digest must be a sha256 hex digest');
      assert.notEqual(observer.digest, record.provenance.sourceSha, 'the observer digest is a separate fact from the fixture source SHA');
      assert.equal(observer.model, null, 'the model is not observable in this instrument and stays unknown');
      assert.equal(observer.reachableToolFamily, null, 'the runtime-reachable tool family is not established and stays unknown');
      // The digest is derived from the ACTUAL working-tree instrument modules.
      const evidenceSource = await readFile(fileURLToPath(new URL('../tools/shell-wait-probe/evidence.mjs', import.meta.url)));
      const driverSource = await readFile(fileURLToPath(new URL('../tools/shell-wait-probe/driver.mjs', import.meta.url)));
      const expectedDigest = createHash('sha256')
        .update('zcode-shell-wait-observer-v1\0')
        .update(evidenceSource)
        .update('\0')
        .update(driverSource)
        .digest('hex');
      assert.equal(observer.digest, expectedDigest, 'the digest must hash the actual evidence.mjs + driver.mjs working-tree contents');
      // Stability: two records built from the same tree carry the same digest.
      const second = await runShellWaitCase(caseInput({ output: secondOutput }), {
        createFixture: async () => fakeFixture,
        executeLiveCase: async () => emptyLiveFacts(),
      });
      assert.equal(second.provenance.observer.digest, observer.digest, 'the observer digest must be stable across two builds of the same tree');
      const written = JSON.parse(await readFile(join(output, 'rescue-baseline.record.json'), 'utf8'));
      assert.equal(written.provenance.observer.digest, expectedDigest, 'the observer digest must persist into the written record');
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
      // The diagnostic command body is unclassified content: the excerpt keeps
      // its projected length, never the body.
      assert.equal(result.facts.companion.preLaunchDiagnostics.excerpts[0].truncated, false);
      assert.match(result.facts.companion.preLaunchDiagnostics.excerpts[0].text, /"length":\d{4}/u);
      assert.equal(result.facts.companion.preLaunchDiagnostics.excerpts[0].text.includes('xxxxx'), false, 'the diagnostic command body must be withheld');
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
        { type: 'input_text', text: 'running\nWall time 120.0 seconds\nOutput:\n' },
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

    // The exact wrapper shape observed live in the retained noise/repeat2
    // records (report §§7.4/8.2, field-presence inspection only): the sanctioned
    // preparation write carries an optional bounded `yield_time_ms` BETWEEN the
    // `+"\n"` segment and `max_output_tokens`. The committed grammar rejected it
    // as `unsupported-call-shape`, blocking unrelated measurements.
    function observedPreparationCall(sessionId = HANDLE, yieldMs = 1000, callId = 'prep-1', envelope = preparationEnvelope()) {
      return { type: 'response_item', payload: {
        type: 'custom_tool_call', name: 'exec', call_id: callId,
        input: `text(await tools.write_stdin({session_id:${sessionId},chars:JSON.stringify(${JSON.stringify(envelope)})+"\\n",yield_time_ms:${yieldMs},max_output_tokens:1000}));\n`,
      } };
    }

    test('the live-observed preparation write with the optional yield_time_ms argument is the sanctioned one-shot preparation', () => {
      const canaryEnvelope = { ...preparationEnvelope(), task: 'CANARY-prep-task-body' };
      const rollouts = fullRollouts();
      rollouts[1].splice(3, 0,
        observedPreparationCall(HANDLE, 1000, 'prep-1', canaryEnvelope),
        callOutput('prep-1', completedOutput({ output: 'frame accepted', session_id: HANDLE })),
      );
      const result = inspectShellWaitEvidence(evidenceInput({ rollouts }));
      assert.equal(result.status, 'supported', `the observed legal shape must parse as supported, got: ${result.status === 'inconclusive' ? result.inconclusive.reason : 'supported'}`);
      assert.equal(result.facts.handle.preparationFrameWrites, 1, 'the observed shape must receive the one-shot preparation admission');
      assert.equal(result.facts.handle.pollCount, 1, 'the preparation write is a write, never an empty terminal poll');
      assert.equal(result.facts.completion.qualified, true, 'the observed legal shape must not block an otherwise qualified completion');
      // Sanitized structural facts stay visible on the supported path: the
      // validated yield fact survives, the private frame never does.
      const prepExcerpt = result.facts.collection.excerpts
        .map((excerpt) => excerpt.text)
        .find((text) => text.includes('"write_stdin"') && text.includes('1000'));
      assert.ok(prepExcerpt, 'the prepared write must retain a projected excerpt');
      const projected = JSON.parse(prepExcerpt);
      assert.equal(projected.arguments.yield_time_ms, 1000, 'the validated directive fact stays a supported-path structural fact');
      assert.equal(projected.arguments.chars, '<private-input>', 'the private frame content stays suppressed');
      assert.doesNotMatch(prepExcerpt, /CANARY-prep-task-body/u, 'the private task body never enters the excerpt');
    });

    test('the observed shape still requires production v5 validation, the original handle, and one-shot admission', () => {
      const invalidEnvelope = { ...preparationEnvelope(), source: 'unknown' };
      const invalid = fullRollouts();
      invalid[1].splice(3, 0,
        observedPreparationCall(HANDLE, 1000, 'prep-1', invalidEnvelope),
        callOutput('prep-1', completedOutput({ output: '', session_id: HANDLE })),
      );
      const invalidResult = inspectShellWaitEvidence(evidenceInput({ rollouts: invalid }));
      assert.equal(invalidResult.facts.completion.qualified, false, 'an invalid envelope with the observed optional argument must still block');
      assert.match(invalidResult.facts.completion.reason, /invalid or unexpected v5 envelope/u);
      const second = fullRollouts();
      second[1].splice(3, 0,
        observedPreparationCall(),
        callOutput('prep-1', completedOutput({ output: 'frame accepted', session_id: HANDLE })),
      );
      second[1].splice(5, 0,
        observedPreparationCall(HANDLE, 1000, 'prep-2'),
        callOutput('prep-2', completedOutput({ output: '', session_id: HANDLE })),
      );
      assert.match(inspectShellWaitEvidence(evidenceInput({ rollouts: second })).facts.completion.reason, /second private preparation frame/u, 'the observed shape stays one-shot');
      const foreign = fullRollouts();
      foreign[1].splice(3, 0,
        observedPreparationCall(999),
        callOutput('prep-1', completedOutput({ output: '', session_id: 999 })),
      );
      assert.match(inspectShellWaitEvidence(evidenceInput({ rollouts: foreign })).facts.completion.reason, /foreign handle/u, 'the observed shape stays bound to the original handle');
    });

    test('the observed shape keeps the trailing-input and unresolved/overlap negatives', () => {
      // Trailing input after the envelope wrapper is outside the exact observed
      // shape: fail closed as unsupported, never parsed as a sanctioned write.
      const trailing = fullRollouts();
      trailing[1].splice(3, 0,
        { type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'prep-1', input: `text(await tools.write_stdin({session_id:${HANDLE},chars:JSON.stringify(${JSON.stringify(preparationEnvelope())})+"\\n",yield_time_ms:1000})); text("trailing");\n` } },
        callOutput('prep-1', completedOutput({ output: '', session_id: HANDLE })),
      );
      const trailingResult = inspectShellWaitEvidence(evidenceInput({ rollouts: trailing }));
      assert.equal(trailingResult.status, 'inconclusive');
      assert.equal(trailingResult.inconclusive.reason, 'unsupported-call-shape');
      // A missing preparation response stays unresolved and makes the later
      // terminal poll an overlap; the write is never treated as a poll.
      const delayed = fullRollouts();
      delayed[1].splice(3, 0, observedPreparationCall());
      delayed[1].push(callOutput('prep-1', completedOutput({ output: '', session_id: HANDLE })));
      const delayedResult = inspectShellWaitEvidence(evidenceInput({ rollouts: delayed }));
      assert.equal(delayedResult.facts.completion.qualified, false);
      assert.equal(delayedResult.facts.handle.overlappingInnerPolls, 1);
      assert.equal(delayedResult.facts.handle.preparationFrameWrites, 1);
      assert.equal(delayedResult.facts.handle.pollCount, 1);
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
      // R1 timing correction: the observer no longer derives a poll-start
      // remaining lifetime from workerDurationMs - decisiveWallMs (that
      // arithmetic measures observation duration, not poll-start lifetime).
      // Only the driver's measured hold-clock timeline may supply the value.
      assert.equal(result.facts.observations.remainingLifetimeMs, null);
      assert.equal(result.facts.observations.remainingLifetimeBasis, 'unavailable');
    });

    test('a truncated direct function-call shape is inconclusive, never silently zero', () => {
      const rollouts = fullRollouts();
      rollouts[1][1] = { type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'launch-1', arguments: '{"cmd": "trunc' } };
      const privatePath = '/private/var/folders/ww/shell-wait-fixture-secret/codex-home';
      const result = inspectShellWaitEvidence(evidenceInput({ rollouts, redactions: [privatePath] }));
      assert.equal(result.status, 'inconclusive');
      assert.match(result.inconclusive.reason, /unsupported|truncated/i);
      assert.match(result.inconclusive.excerpt.text, /exec_command/u, 'the payload-declared tool name stays a structural fact');
      assert.equal(result.inconclusive.excerpt.text.includes('trunc'), false, 'the unparsable argument body is withheld, not merely path-scrubbed');
      assert.doesNotMatch(result.inconclusive.excerpt.text, new RegExp(escapeRegExp(privatePath)));
    });

    test('the direct-exec header form feeds decisiveWallMs from the pinned header prefix, never stdout', () => {
      // Exact pinned unified-exec framing (67727e7c, context.rs response_header
      // + response_text): the FIRST input_text item is the header — an optional
      // `Chunk ID:` line, the `Wall time: <seconds> seconds` line, optional
      // process/token lines, then the `Output:` delimiter — with companion
      // stdout appended IN THE SAME ITEM after `Output:`. Stdout is excluded
      // from timing extraction entirely.
      const directCases = [
        // minimal pinned header, empty stdout
        { text: 'Wall time: 31.0000 seconds\nOutput:\n', expectedMs: 31_000 },
        // stdout appended in the same item, carrying a timing-shaped decoy that
        // must NEVER be scanned
        { text: 'Wall time: 31.0000 seconds\nOutput:\ndecoy Wall time: 99.0000 seconds\n', expectedMs: 31_000, decoy: '99.0000' },
        // optional chunk/status/token lines around the wall-time line
        { text: 'Chunk ID: chunk-9\nWall time: 31.0000 seconds\nProcess exited with code 0\nOriginal token count: 42\nOutput:\n', expectedMs: 31_000 },
      ];
      for (const directCase of directCases) {
        const rollouts = fullRollouts();
        // The native host emits ONE text body: response_header() + "\n" +
        // stdout (context.rs to_response_item → function_tool_response) — no
        // separate JSON result item.
        rollouts[1][4] = callOutput('poll-1', [
          { type: 'input_text', text: directCase.text },
        ]);
        const result = inspectShellWaitEvidence(evidenceInput({ rollouts, workerStillAliveAfterObservation: true, workerDurationMs: 420_000 }));
        assert.equal(result.status, 'supported');
        assert.equal(result.facts.completion.decisiveWallMs, directCase.expectedMs, `case [${directCase.text.replace(/\n/g, '\\n')}] must supply the decisive wall time`);
        assert.equal(result.facts.observations.decisiveWallMs, directCase.expectedMs);
        assert.equal(result.facts.observations.remainingLifetimeMs, null, 'the retired worker-duration arithmetic never supplies a poll-start lifetime');
        assert.equal(result.facts.observations.remainingLifetimeBasis, 'unavailable');
        if (directCase.decoy) {
          assert.notEqual(result.facts.completion.decisiveWallMs, 99_000, 'stdout content is never scanned for timing');
        }
      }
      // A standalone `Wall time: N seconds` line WITHOUT the pinned `Output:`
      // delimiter is not the real header framing and stays untrusted.
      const standaloneRollouts = fullRollouts();
      standaloneRollouts[1][4] = callOutput('poll-1', [
        { type: 'input_text', text: 'Wall time: 31.0000 seconds\n' },
        { type: 'input_text', text: JSON.stringify({ output: '', session_id: HANDLE }) },
      ]);
      const standaloneResult = inspectShellWaitEvidence(evidenceInput({ rollouts: standaloneRollouts, workerStillAliveAfterObservation: true, workerDurationMs: 420_000 }));
      assert.equal(standaloneResult.facts.completion.decisiveWallMs, null, 'an unframed wall-time line is not a trusted header');
    });

    test('native pending code-mode string responses keep exact-cell linkage and qualify', async () => {
      // At the pin (67727e7c, code_mode/mod.rs format_script_status +
      // output.rs CodeModeToolOutput::new/set_handler_duration_ms): a poll
      // that yields before printing has EMPTY content items, and the
      // singleton header serializes as a PLAIN STRING
      // "Script running with cell ID <id>\nWall time <n>[ (code-mode …
      // overhead …)] seconds\nOutput:\n". The string branch must decode this
      // pending shape (cell id only) before direct-response decoding, so the
      // exact-cell continuation linkage works on the native persisted form.
      const { parseCodexRolloutJsonl } = await import('../tests/helpers/codex-rescue-qualification.mjs');
      const nativeOutput = (callId, body) => ({ type: 'response_item', payload: { type: 'function_call_output', call_id: callId, output: body } });
      const nativePending = (cellId, suffix = '') => `Script running with cell ID ${cellId}\nWall time 0.1 seconds${suffix}\nOutput:\n`;
      const pendingFlowPair = (pendingBody, waits) => [[
        sessionMeta(PARENT),
        fnCall('spawn_agent', 'spawn-1', { task_name: 'zcode_rescue_task_1', fork_turns: 'none', agent_type: 'zcode-rescue', message: 'Run the installed prepared ZCode Rescue forwarder now. Return its public stdout verbatim.' }),
        startedEvent(),
        fnCall('wait_agent', 'root-wait-1', { timeout_ms: 600000 }),
      ], [
        childMeta(),
        wrappedCall('exec_command', 'launch-1', { cmd: LAUNCHER, workdir: '/installed/workspace' }),
        nativeOutput('launch-1', 'Wall time: 0.2500 seconds\nProcess running with session ID 91\nOutput:\n'),
        wrappedCall('write_stdin', 'poll-1', { session_id: HANDLE, chars: '', yield_time_ms: 60000 }),
        nativeOutput('poll-1', pendingBody),
        ...waits.flatMap(([callId, body]) => [fnCall('wait', callId, { cell_id: 'cell-9' }), nativeOutput(callId, body)]),
      ]];
      const throughPersistence = (pair) => parseCodexRolloutJsonl(pair.map((event) => JSON.stringify(event)).join('\n'));
      // The terminal continuation's native body: the pinned direct framing
      // carrying the exit code and the sentinel in its stdout part.
      const terminalBody = `Wall time: 31.0000 seconds\nProcess exited with code 0\nOutput:\n${SENTINEL}\n`;
      // (a) yielded poll (native string pending) + exact-cell continuation
      // whose terminal response carries exit code and sentinel → qualified.
      const qualifiedPair = pendingFlowPair(nativePending('cell-9'), [['wait-1', terminalBody]]);
      const qualifiedResult = inspectShellWaitEvidence(evidenceInput({ rollouts: throughPersistence(qualifiedPair), workerStillAliveAfterObservation: true, workerDurationMs: 420_000 }));
      assert.equal(qualifiedResult.status, 'supported');
      assert.equal(qualifiedResult.facts.completion.qualified, true, 'the native pending string must keep the exact-cell linkage');
      assert.equal(qualifiedResult.facts.observations.pendingInnerAtEnd, false);
      assert.equal(qualifiedResult.facts.observations.outerReturns, 1);
      assert.equal(qualifiedResult.facts.completion.processExit, 0);
      assert.equal(qualifiedResult.facts.completion.publicResultMatched, true, 'the sentinel decodes from the continuation stdout');
      assert.equal(qualifiedResult.facts.completion.decisiveWallMs, 31_000);
      // (b) repeated pending waits (native strings) then terminal completion →
      // qualified.
      const repeatedPair = pendingFlowPair(nativePending('cell-9'), [
        ['wait-1', nativePending('cell-9')],
        ['wait-2', terminalBody],
      ]);
      const repeatedResult = inspectShellWaitEvidence(evidenceInput({ rollouts: throughPersistence(repeatedPair), workerStillAliveAfterObservation: true, workerDurationMs: 420_000 }));
      assert.equal(repeatedResult.status, 'supported');
      assert.equal(repeatedResult.facts.completion.qualified, true, 'repeated pending waits for the same cell stay valid evidence');
      assert.equal(repeatedResult.facts.observations.outerReturns, 2);
      // (c) overhead-header variants of the pending string → qualified with
      // cell linkage (zero and negative overhead, per the pinned grammar).
      for (const suffix of [' (code-mode 0.000 seconds; overhead 0.100 seconds)', ' (code-mode 0.101 seconds; overhead -0.001 seconds)']) {
        const overheadPair = pendingFlowPair(nativePending('cell-9', suffix), [['wait-1', terminalBody]]);
        const overheadResult = inspectShellWaitEvidence(evidenceInput({ rollouts: throughPersistence(overheadPair), workerStillAliveAfterObservation: true, workerDurationMs: 420_000 }));
        assert.equal(overheadResult.facts.completion.qualified, true, `the overhead pending variant (${suffix.trim()}) must stay qualified`);
      }
      // (d) exact-cell linkage is unchanged: a pending string naming a FOREIGN
      // cell keeps blocking the exact-cell continuation.
      const foreignPair = pendingFlowPair(nativePending('cell-8'), [['wait-1', terminalBody]]);
      const foreignResult = inspectShellWaitEvidence(evidenceInput({ rollouts: throughPersistence(foreignPair), workerStillAliveAfterObservation: true, workerDurationMs: 420_000 }));
      assert.equal(foreignResult.status, 'supported');
      assert.equal(foreignResult.facts.completion.qualified, false, 'a foreign-cell pending string still blocks qualification');
      assert.equal(foreignResult.facts.observations.pendingInnerAtEnd, true, 'the foreign cell stays pending');
    });

    test('native direct responses with duplicate process metadata fail closed, never first-match', async () => {
      // The pinned response_header() emits each process/status line at most
      // once; repeated exit-code or session-id lines mean a malformed or
      // mixed response — the decode must fail closed (null), never decode the
      // first match into completion evidence.
      const { parseCodexRolloutJsonl } = await import('../tests/helpers/codex-rescue-qualification.mjs');
      const nativeOutput = (callId, body) => ({ type: 'response_item', payload: { type: 'function_call_output', call_id: callId, output: body } });
      const pollPair = (pollBody, launchBody = 'Wall time: 0.2500 seconds\nProcess running with session ID 91\nOutput:\n') => [[
        sessionMeta(PARENT),
        fnCall('spawn_agent', 'spawn-1', { task_name: 'zcode_rescue_task_1', fork_turns: 'none', agent_type: 'zcode-rescue', message: 'Run the installed prepared ZCode Rescue forwarder now. Return its public stdout verbatim.' }),
        startedEvent(),
        fnCall('wait_agent', 'root-wait-1', { timeout_ms: 600000 }),
      ], [
        childMeta(),
        wrappedCall('exec_command', 'launch-1', { cmd: LAUNCHER, workdir: '/installed/workspace' }),
        nativeOutput('launch-1', launchBody),
        wrappedCall('write_stdin', 'poll-1', { session_id: HANDLE, chars: '', yield_time_ms: 60000 }),
        nativeOutput('poll-1', pollBody),
      ]];
      const throughPersistence = (pair) => parseCodexRolloutJsonl(pair.map((event) => JSON.stringify(event)).join('\n'));
      // (a) duplicate conflicting exit codes: fail closed, never first-match —
      // the sentinel in stdout must not turn the malformed body into
      // completion evidence.
      const persistedDupExit = throughPersistence(pollPair(`Wall time: 31.0000 seconds\nProcess exited with code 0\nProcess exited with code 1\nOutput:\n${SENTINEL}\n`));
      const dupExitResult = inspectShellWaitEvidence(evidenceInput({ rollouts: persistedDupExit, workerStillAliveAfterObservation: true, workerDurationMs: 420_000 }));
      assert.equal(dupExitResult.status, 'supported');
      assert.equal(dupExitResult.facts.completion.qualified, false, 'a duplicated exit code blocks qualification');
      assert.equal(dupExitResult.facts.completion.processExit, null, 'no exit-code value may be decoded from a duplicated field');
      assert.equal(dupExitResult.facts.completion.publicResultMatched, false, 'the malformed response yields no completion evidence');
      assert.equal(dupExitResult.facts.observations.pendingInnerAtEnd, true, 'the malformed poll stays unresolved');
      // (b) duplicate session-id lines on the LAUNCH: fail closed — no handle
      // is decoded, so the completion evidence never links.
      const persistedDupSession = throughPersistence(pollPair(
        `Wall time: 31.0000 seconds\nProcess exited with code 0\nOutput:\n${SENTINEL}\n`,
        'Wall time: 0.2500 seconds\nProcess running with session ID 91\nProcess running with session ID 92\nOutput:\n',
      ));
      const dupSessionResult = inspectShellWaitEvidence(evidenceInput({ rollouts: persistedDupSession, workerStillAliveAfterObservation: true, workerDurationMs: 420_000 }));
      assert.equal(dupSessionResult.status, 'supported');
      assert.equal(dupSessionResult.facts.handle.originalHandleId, null, 'a duplicated session-id field decodes no handle');
      assert.equal(dupSessionResult.facts.companion.launchCount, 1);
      assert.equal(dupSessionResult.facts.completion.qualified, false);
      // (c) any other duplicated status line (token count) fails closed too.
      const persistedDupTokens = throughPersistence(pollPair('Wall time: 31.0000 seconds\nOriginal token count: 7\nOriginal token count: 8\nOutput:\n'));
      const dupTokensResult = inspectShellWaitEvidence(evidenceInput({ rollouts: persistedDupTokens, workerStillAliveAfterObservation: true, workerDurationMs: 420_000 }));
      assert.equal(dupTokensResult.facts.observations.pendingInnerAtEnd, true, 'a duplicated token-count line stays unresolved');
      assert.equal(dupTokensResult.facts.completion.qualified, false);
      // Supported single-line forms stay qualified (positive control).
      const persistedSingle = throughPersistence(pollPair(`Wall time: 31.0000 seconds\nProcess exited with code 0\nOutput:\n${SENTINEL}\n`));
      const singleResult = inspectShellWaitEvidence(evidenceInput({ rollouts: persistedSingle, workerStillAliveAfterObservation: true, workerDurationMs: 420_000 }));
      assert.equal(singleResult.facts.completion.qualified, true, 'the single-line native form still qualifies');
    });

    test('native unified-exec direct responses qualify launch, cap return, and terminal completion', async () => {
      // The pinned host serializes a direct exec response as ONE text body:
      // response_header() + "\n" + stdout (context.rs to_response_item →
      // function_tool_response → FunctionCallOutputBody::Text), and
      // protocol/src/models.rs serializes that variant as a PLAIN STRING in
      // the persisted rollout — the output item is a bare string, not an
      // input_text array. The regressions therefore replay the responses
      // through the REAL persistence path (parseCodexRolloutJsonl), not
      // through hand-built event arrays.
      const { parseCodexRolloutJsonl } = await import('../tests/helpers/codex-rescue-qualification.mjs');
      const nativeOutput = (callId, body) => ({ type: 'response_item', payload: { type: 'function_call_output', call_id: callId, output: body } });
      const nativePair = (pollBody) => [[
        sessionMeta(PARENT),
        fnCall('spawn_agent', 'spawn-1', { task_name: 'zcode_rescue_task_1', fork_turns: 'none', agent_type: 'zcode-rescue', message: 'Run the installed prepared ZCode Rescue forwarder now. Return its public stdout verbatim.' }),
        startedEvent(),
        fnCall('wait_agent', 'root-wait-1', { timeout_ms: 600000 }),
      ], [
        childMeta(),
        wrappedCall('exec_command', 'launch-1', { cmd: LAUNCHER, workdir: '/installed/workspace' }),
        nativeOutput('launch-1', 'Wall time: 0.2500 seconds\nProcess running with session ID 91\nOutput:\n'),
        wrappedCall('write_stdin', 'poll-1', { session_id: HANDLE, chars: '', yield_time_ms: 60000 }),
        { type: 'response_item', payload: { type: 'function_call_output', call_id: 'poll-1', output: pollBody } },
      ]];
      // Replay through the real persistence path: JSONL text in, events out.
      const throughPersistence = (pair) => parseCodexRolloutJsonl(pair.map((event) => JSON.stringify(event)).join('\n'));
      // (1) LAUNCH: the handle decodes from the header's session-id line; a
      // headerless native string (plain stdout, no pinned framing) stays
      // unresolved and pending.
      const persistedLaunch = throughPersistence(nativePair('early partial stdout without header\n'));
      const launchResult = inspectShellWaitEvidence(evidenceInput({ rollouts: persistedLaunch, workerStillAliveAfterObservation: true, workerDurationMs: 420_000 }));
      assert.equal(launchResult.status, 'supported');
      assert.equal(launchResult.facts.handle.originalHandleId, HANDLE, 'the session id decodes from the native header');
      assert.equal(launchResult.facts.companion.launchCount, 1);
      assert.equal(launchResult.facts.observations.pendingInnerAtEnd, true, 'the unresolved native poll stays pending');
      // (2) CAP RETURN: a yield header with no exit line — timing survives,
      // the poll resolves, and completion stays unqualified.
      const persistedCap = throughPersistence(nativePair('Wall time: 31.0000 seconds\nProcess running with session ID 91\nOutput:\n'));
      const capResult = inspectShellWaitEvidence(evidenceInput({ rollouts: persistedCap, workerStillAliveAfterObservation: true, workerDurationMs: 420_000 }));
      assert.equal(capResult.status, 'supported');
      assert.equal(capResult.facts.completion.decisiveWallMs, 31_000, 'the native cap-return header keeps its wall time');
      assert.equal(capResult.facts.completion.processExit, null, 'no exit line means no exit code');
      assert.equal(capResult.facts.completion.decisiveEnd, 'yield-expiry');
      assert.equal(capResult.facts.observations.pendingInnerAtEnd, false, 'the native poll output resolves');
      // (3) TERMINAL COMPLETION: exit code and sentinel decode from the
      // single string body — stdout carries the sentinel.
      const persistedTerminal = throughPersistence(nativePair(`Wall time: 31.0000 seconds\nProcess exited with code 0\nOutput:\n${SENTINEL}\n`));
      const terminalResult = inspectShellWaitEvidence(evidenceInput({ rollouts: persistedTerminal, workerStillAliveAfterObservation: true, workerDurationMs: 420_000 }));
      assert.equal(terminalResult.status, 'supported');
      assert.equal(terminalResult.facts.completion.qualified, true, 'a native terminal response must qualify completion');
      assert.equal(terminalResult.facts.completion.processExit, 0);
      assert.equal(terminalResult.facts.completion.publicResultMatched, true, 'the sentinel decodes from the stdout part');
      assert.equal(terminalResult.facts.completion.decisiveWallMs, 31_000);
      // Other non-string shapes stay rejected/fail-closed: a number or an
      // object output never decodes into a supported response.
      for (const hostileOutput of [91, { output: SENTINEL, exit_code: 0 }]) {
        const persistedHostile = throughPersistence((() => {
          const pair = nativePair('Wall time: 31.0000 seconds\nOutput:\n');
          pair[1][4].payload.output = hostileOutput;
          return pair;
        })());
        const hostileResult = inspectShellWaitEvidence(evidenceInput({ rollouts: persistedHostile, workerStillAliveAfterObservation: true, workerDurationMs: 420_000 }));
        assert.equal(hostileResult.facts.observations.pendingInnerAtEnd, true, `a ${typeof hostileOutput} output stays rejected`);
        assert.equal(hostileResult.facts.completion.qualified, false);
      }
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
      assert.equal(result.facts.observations.remainingLifetimeMs, null, 'the retired worker-duration arithmetic never supplies a poll-start lifetime');
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

    test('unavailable parent linkage keeps rootJoins unknown (null), never a fabricated zero', () => {
      // No parent rollout is collected at all, yet the CHILD rollout carries a
      // wait_agent call: the join count is unknown (null), not zero.
      const rollouts = [[
        childMeta(),
        wrappedCall('exec_command', 'launch-1', { cmd: LAUNCHER, workdir: '/installed/workspace' }),
        callOutput('launch-1', completedOutput({ output: '', session_id: HANDLE })),
        wrappedCall('write_stdin', 'poll-1', { session_id: HANDLE, chars: '', yield_time_ms: 60000 }),
        callOutput('poll-1', completedOutput({ output: SENTINEL, exit_code: 0, session_id: HANDLE })),
        fnCall('wait_agent', 'child-wait-1', { timeout_ms: 600000 }),
      ]];
      const result = inspectShellWaitEvidence(evidenceInput({ rollouts }));
      assert.equal(result.status, 'supported');
      assert.equal(result.facts.linkage.exact, false, 'without a parent rollout the Rescue linkage cannot be exact');
      assert.equal(result.facts.observations.rootJoins, null, 'a missing parent rollout is unknown, never a zero count');
      assert.equal(result.facts.completion.qualified, false);
    });

    test('an ambiguous parent (several spawn rollouts) keeps rootJoins unknown too', () => {
      const rollouts = fullRollouts();
      rollouts.push([sessionMeta('parent-thread-2'), fnCall('spawn_agent', 'spawn-2', { task_name: 't2' }), fnCall('wait_agent', 'root-wait-9', { timeout_ms: 600000 })]);
      const result = inspectShellWaitEvidence(evidenceInput({ rollouts }));
      assert.equal(result.facts.observations.rootJoins, null, 'an ambiguous parent rollout cannot ground even a zero count');
    });

    test('a positively identified parent rollout with no wait_agent counts rootJoins as an exact zero', () => {
      const rollouts = fullRollouts();
      rollouts[0] = rollouts[0].filter((event) => event?.payload?.name !== 'wait_agent');
      const result = inspectShellWaitEvidence(evidenceInput({ rollouts }));
      assert.equal(result.facts.linkage.exact, true);
      assert.equal(result.facts.observations.rootJoins, 0, 'zero requires the identified parent rollout, and is then exact');
    });

    test('rescue linkage: an identified parent rollout without session metadata cannot be papered over by a null parent_thread_id (R2 binding tightening)', () => {
      // The parent rollout is uniquely identified by its spawn_agent call but
      // carries no session_meta, and the child's own metadata carries
      // parent_thread_id: null. Without the metadata-binding requirement the
      // null-vs-null comparison fabricated an exact binding; the tightened
      // contract keeps the linkage inexact and the parent id null.
      const rollouts = fullRollouts();
      rollouts[0] = rollouts[0].filter((event) => event?.type !== 'session_meta');
      rollouts[1][0] = childMeta({ parent_thread_id: null });
      const result = inspectShellWaitEvidence(evidenceInput({ rollouts }));
      assert.equal(result.facts.linkage.exact, false, 'an unbound parent rollout cannot ground an exact child linkage');
      assert.equal(result.facts.linkage.parentThreadId, null, 'the unavailable parent session id stays null, never a guess');
      assert.match(result.facts.linkage.reason, /session metadata to bind/u);
      assert.equal(result.facts.completion.qualified, false);
    });

    test('missing rollout metadata is inconclusive rather than zero', () => {
      const result = inspectShellWaitEvidence(evidenceInput({ rollouts: [[quotedMessage()]] }));
      assert.equal(result.status, 'inconclusive');
      assert.match(result.inconclusive.reason, /session_meta|rollout/i);
      const empty = inspectShellWaitEvidence(evidenceInput({ rollouts: [] }));
      assert.equal(empty.status, 'inconclusive');
    });

    test('unsupported-path excerpts suppress the raw body and stay structurally bounded', () => {
      const rollouts = fullRollouts();
      rollouts[1][1] = { type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'launch-1', input: `const r = await tools.exec_command(${JSON.stringify({ cmd: 'x'.repeat(5000) })}); text(` } };
      const result = inspectShellWaitEvidence(evidenceInput({ rollouts }));
      assert.equal(result.status, 'inconclusive');
      // The 5000-character unclassifiable body is suppressed, so the excerpt
      // stays structurally small instead of carrying truncated content.
      assert.equal(result.inconclusive.excerpt.text.includes('xxxxx'), false, 'the unclassifiable body must be withheld');
      assert.match(result.inconclusive.excerpt.text, /"inputBytes":\d{4,}/u, 'the withheld body keeps only its byte length');
      assert.match(result.inconclusive.excerpt.text, /exec_command/u, 'the nearest tool name stays visible');
      assert.ok(result.inconclusive.excerpt.text.length < 2048);
      assert.equal(result.inconclusive.excerpt.truncated, false);
    });
  });

  describe('root-family observer contract (R2)', async () => {
    const { inspectShellWaitEvidence } = await import('../tools/shell-wait-probe/evidence.mjs');
    const { mapShellWaitLiveFacts, renderCompanionCommand, runShellWaitCase, shellWaitEvidenceRequest, SHELL_WAIT_CASE_SPECS } = await import('../tools/shell-wait-probe/driver.mjs');

    // The documented root-family command surface (driver CASE_SPECS + the
    // installed review/adversarial-review/status Skills): the constant
    // Companion command is the rendered `node "<plugin-root>/scripts/zcode-
    // companion.mjs" invoke <command>` string, rendered through the same
    // production-side seam the live executor uses.
    const COMPANION_SCRIPT = '/installed/zcode/scripts/zcode-companion.mjs';
    const companionCommandFor = (subcommand) => `${renderCompanionCommand(COMPANION_SCRIPT)} ${subcommand}`;
    const REVIEW_COMMAND = companionCommandFor('invoke review');
    const ADVERSARIAL_REVIEW_COMMAND = companionCommandFor('invoke adversarial-review');
    const STATUS_COMMAND = companionCommandFor('invoke status');

    // The command-specific rendered success results, built here from the real
    // renderers' documented output shapes (scripts/lib/render.mjs renderOutput/
    // renderJob), NOT from the observer under test:
    //  - review/adversarial-review: renderOutput returns `${value.result}\n…`
    //    — the stored final result presented verbatim. Under the fixture the
    //    fake peer's final public result is the documented sentinel, so the
    //    rendered review output carries that sentinel (a NARROWER check; full
    //    rendered-output equality is not claimed).
    //  - status: a single-job status view is renderJob's fixed field lines —
    //    `Job: `, `Command: `, `Status: `, … `Progress:` (also narrower).
    const SENTINEL = 'ZCODE_RESCUE_PUBLIC_SENTINEL_7C9C';
    const REVIEW_MARKERS = [SENTINEL];
    const STATUS_JOB_ID = 'aa11bb22cc33dd44ee55ff66aa11bb22cc33dd44ee55ff66aa11bb22cc33dd44ee';
    const renderedStatusOutput = [
      `Job: ${STATUS_JOB_ID}`,
      'Command: review',
      'Status: succeeded',
      'Phase: finished',
      'Created: 2026-10-06T00:00:00.000Z',
      'Started: 2026-10-06T00:00:01.000Z',
      'Finished: 2026-10-06T00:02:01.000Z',
      'Duration: 2m 0s',
      'Last activity: 2026-10-06T00:02:01.000Z',
      'Progress:',
      '  - none',
    ].join('\n') + '\n';
    const STATUS_MARKERS = ['Job: ', 'Command: ', 'Status: ', 'Progress:'];
    const CASE_CONTRACTS = {
      'review-wait': { command: REVIEW_COMMAND, terminalOutput: `${SENTINEL}\n`, markers: REVIEW_MARKERS, outerReturns: 1 },
      'adversarial-review-wait': { command: ADVERSARIAL_REVIEW_COMMAND, terminalOutput: `${SENTINEL}\n`, markers: REVIEW_MARKERS, outerReturns: 1 },
      'status-wait': { command: STATUS_COMMAND, terminalOutput: renderedStatusOutput, markers: STATUS_MARKERS, outerReturns: 2 },
    };

    const ROOT_THREAD = 'root-thread-1';
    const ROOT_HANDLE = 87;
    const rootMeta = () => ({ type: 'session_meta', payload: { id: ROOT_THREAD } });
    const fnCall = (name, callId, args) => ({ type: 'response_item', payload: { type: 'function_call', name, call_id: callId, arguments: JSON.stringify(args) } });
    const fnOutput = (callId, output) => ({ type: 'response_item', payload: { type: 'function_call_output', call_id: callId, output } });
    const wrappedCall = (kind, callId, value) => ({ type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: callId, input: `const r = await tools.${kind}(${JSON.stringify(value)}); text(JSON.stringify(r))\n` } });
    const callOutput = (callId, output) => ({ type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: callId, output } });
    const completedOutput = (result) => [{ type: 'input_text', text: 'Script completed\n' }, { type: 'input_text', text: JSON.stringify(result) }];
    const pendingOutput = (cellId) => [{ type: 'input_text', text: `Script running with cell ID ${cellId}\n` }];
    const quotedMessage = (text) => ({ type: 'event_msg', payload: { type: 'agent_message', message: text } });

    /**
     * One root-family observation rollout: the ROOT host turn itself launches
     * the constant Companion command, polls the returned handle with
     * empty-input write_stdin calls, and continues the yielded cell through
     * its own outer `wait` continuations until the terminal exit. There is NO
     * spawn_agent, NO SubAgentActivity start, and NO child rollout anywhere.
     * Launch/poll use the observed installed const-r wrapper shapes; the outer
     * continuations use the sanctioned direct `wait` function-call shape (the
     * same supported shapes the Rescue observer already accepts).
     */
    function rootRollout(label, { cellId = 'cell-root-1', secondContinuation = false, mutations = (events) => events } = {}) {
      const contract = CASE_CONTRACTS[label];
      const events = [
        rootMeta(),
        // The assistant's own text quotes the command; the quote must never
        // substitute for the observed invocation.
        quotedMessage(`I will now run ${contract.command} and wait for it to finish.`),
        wrappedCall('exec_command', 'launch-1', { cmd: contract.command, workdir: '/installed/workspace' }),
        callOutput('launch-1', completedOutput({ output: '', session_id: ROOT_HANDLE })),
        wrappedCall('write_stdin', 'poll-1', { session_id: ROOT_HANDLE, chars: '', yield_time_ms: 3_600_000 }),
        callOutput('poll-1', pendingOutput(cellId)),
        fnCall('wait', 'outer-1', { cell_id: cellId }),
      ];
      if (secondContinuation) {
        events.push(fnOutput('outer-1', pendingOutput(cellId)));
        events.push(fnCall('wait', 'outer-2', { cell_id: cellId }));
        events.push(fnOutput('outer-2', completedOutput({ output: contract.terminalOutput, exit_code: 0, session_id: ROOT_HANDLE })));
      } else {
        events.push(fnOutput('outer-1', completedOutput({ output: contract.terminalOutput, exit_code: 0, session_id: ROOT_HANDLE })));
      }
      return [mutations(events)];
    }

    const rootEvidenceInput = (label, { rollout = {}, input = {}, rollouts } = {}) => ({
      rollouts: rollouts ?? rootRollout(label, rollout),
      zcodeCalls: [{ id: 1, method: 'session/create', params: {} }, { id: 2, method: 'session/send', params: { sessionId: 'fake-session' } }],
      command: CASE_CONTRACTS[label].command,
      mode: 'root',
      publicResultMarkers: CASE_CONTRACTS[label].markers,
      requestedPollMs: 3_600_000,
      workerStillAliveAfterObservation: false,
      redactions: [],
      ...input,
    });

    // Mapping/record fixtures for the driver seam (same shapes as the
    // established mapping tests above).
    const RESCUE_COMMAND_PLACEHOLDER = 'node "/installed/zcode/skills/rescue/launcher.mjs" invoke-prepared rescue';
    const rootMappingInput = {
      case: 'review-wait', codexBinary: '/bin/x', sourceSha: 'a'.repeat(40), output: '/o',
      workerDurationMs: 130_000, capMs: null, pollMs: 3_600_000, budgetMs: 360_000,
    };
    const rootMappingFixture = {
      workspace: '/private/tmp/root-ws', codexHome: '/private/tmp/root-home',
      installedRoot: '/private/tmp/root-installed', env: { HOME: '/private/tmp/root-home' },
      record: { variant: 'candidate', capMs: null, pollMs: 3_600_000, appliedArtifacts: [] },
    };
    const executedHeld = {
      endedBeforeGate: false, budgetExpired: false, identity: {}, processAliveWhileHeld: true,
      result: { code: 0, stdout: '', stderr: '' },
      cleanup: { label: 'observation', releasedGate: true, verifiedProcessTerminated: true, codexTerminated: true, nativeInterruptionClaimed: false, errors: [] },
      timeline: null,
    };
    /** @param {string} label @param {Record<string, unknown>} overrides */
    const caseInputFor = (label, overrides = {}) => ({
      case: label, codexBinary: process.execPath, sourceSha: 'a'.repeat(40), output: '/o',
      workerDurationMs: 130_000, capMs: null, pollMs: 3_600_000, budgetMs: 360_000,
      ...overrides,
    });

    for (const [label, contract] of Object.entries(CASE_CONTRACTS)) {
      test(`${label}: qualifies on the exact Root invocation, handle, settled outer continuations, terminal exit and the command-specific rendered result — with NO Rescue Child`, () => {
        const secondContinuation = contract.outerReturns === 2;
        const result = inspectShellWaitEvidence(rootEvidenceInput(label, { rollout: { secondContinuation } }));
        assert.equal(result.status, 'supported', JSON.stringify(result.inconclusive));
        assert.equal(result.inconclusive, null);
        // Root identification binds the Root host turn itself — no Rescue
        // Child exists and none is required.
        assert.equal(result.facts.linkage.mode, 'root');
        assert.equal(result.facts.linkage.checked, true);
        assert.equal(result.facts.linkage.exact, true, 'the single rollout exposing the exact command with session metadata is the identified Root');
        assert.equal(result.facts.linkage.rootThreadId, ROOT_THREAD);
        // The exact validated Companion invocation.
        assert.equal(result.facts.companion.launchCount, 1);
        assert.equal(result.facts.companion.duplicateLaunch, false);
        // The exact Root process handle and the observation discipline keyed
        // to it.
        assert.equal(result.facts.handle.originalHandleId, ROOT_HANDLE, 'the launched host turn IS the Root-side process handle');
        assert.equal(result.facts.handle.pollCount, 1);
        assert.equal(result.facts.handle.foreignHandlePolls, 0);
        assert.equal(result.facts.handle.overlappingInnerPolls, 0);
        assert.equal(result.facts.handle.originalHandleChecked, true);
        // Settled outer-cell continuations and the Root observation cadence.
        assert.equal(result.facts.observations.pendingInnerAtEnd, false);
        assert.equal(result.facts.observations.outerReturns, contract.outerReturns, 'the Root case cadence counts its own outer continuations');
        assert.equal(result.facts.observations.rootJoins, null, 'Rescue Child joins are not the Root-case metric and stay unknown/null');
        // Terminal exit + the command-specific rendered result.
        assert.equal(result.facts.completion.processExit, 0);
        assert.equal(result.facts.completion.publicResultMatched, true);
        assert.equal(result.facts.completion.resultCheck, 'command-rendered-result-markers', 'the Root verdict checks the command-specific rendered result, not the bare Rescue sentinel');
        assert.equal(result.facts.completion.qualified, true);
        assert.equal(result.facts.completion.decisiveEnd, 'process-exit');
        // The ABSENT Rescue Child must not disqualify the legitimate Root case.
        assert.doesNotMatch(result.facts.completion.reason ?? '', /child linkage/u);
      });
    }

    test('review-wait: a foreign-handle poll never qualifies the Root case', () => {
      const rollouts = rootRollout('review-wait', { mutations: (events) => {
        events.splice(4, 0,
          wrappedCall('write_stdin', 'foreign-1', { session_id: 42, chars: '' }),
          callOutput('foreign-1', completedOutput({ output: '', session_id: 42 })));
        return events;
      } });
      const result = inspectShellWaitEvidence(rootEvidenceInput('review-wait', { rollouts }));
      assert.equal(result.status, 'supported');
      assert.equal(result.facts.handle.foreignHandlePolls, 1);
      assert.equal(result.facts.handle.originalHandleChecked, false);
      assert.equal(result.facts.completion.qualified, false);
      assert.match(result.facts.completion.reason, /original-handle observation discipline/u);
    });

    test('review-wait: a foreign-cell terminal result never qualifies the Root case', () => {
      const rollouts = rootRollout('review-wait', { mutations: (events) => {
        // The outer continuation references the pending cell, but its response
        // returns a pending header naming a DIFFERENT cell — contradictory
        // continuation evidence that can never be attributed to this handle.
        events.pop();
        events.push(fnOutput('outer-1', pendingOutput('cell-root-999')));
        return events;
      } });
      const result = inspectShellWaitEvidence(rootEvidenceInput('review-wait', { rollouts }));
      assert.equal(result.status, 'supported');
      assert.equal(result.facts.completion.qualified, false);
      assert.match(result.facts.completion.reason, /different cell|pending inner observation/u,
        'the foreign-cell result must block qualification');
    });

    test('review-wait: a quoted invocation (command present only inside assistant text) never qualifies', () => {
      const command = CASE_CONTRACTS['review-wait'].command;
      const rollouts = [[rootMeta(), quotedMessage(`I ran ${command} and it completed with exit 0 and the full review output.`)]];
      const result = inspectShellWaitEvidence(rootEvidenceInput('review-wait', { rollouts }));
      assert.equal(result.status, 'supported', 'an assistant claim is evidence to adjudicate, never an unclassifiable failure');
      assert.equal(result.facts.linkage.exact, false, 'no rollout exposes the exact command as a call');
      assert.equal(result.facts.companion.launchCount, null);
      assert.equal(result.facts.completion.qualified, false);
      assert.match(result.facts.completion.reason, /no identified root rollout|companion command/u);
    });

    test('review-wait: an unresolved pending cell at the end never qualifies', () => {
      const rollouts = rootRollout('review-wait', { mutations: (events) => {
        // The poll yielded a pending cell; no outer continuation ever resolves it.
        return events.slice(0, 6);
      } });
      const result = inspectShellWaitEvidence(rootEvidenceInput('review-wait', { rollouts }));
      assert.equal(result.status, 'supported');
      assert.equal(result.facts.observations.pendingInnerAtEnd, true);
      assert.equal(result.facts.completion.qualified, false);
    });

    test('review-wait: an overlapping same-handle poll never qualifies', () => {
      const contract = CASE_CONTRACTS['review-wait'];
      // A second same-handle poll is issued BEFORE the first poll's own
      // response event arrives — the overlapping-inner-polls violation.
      const rollouts = [[
        rootMeta(),
        wrappedCall('exec_command', 'launch-1', { cmd: contract.command, workdir: '/installed/workspace' }),
        callOutput('launch-1', completedOutput({ output: '', session_id: ROOT_HANDLE })),
        wrappedCall('write_stdin', 'poll-1', { session_id: ROOT_HANDLE, chars: '', yield_time_ms: 3_600_000 }),
        wrappedCall('write_stdin', 'poll-2', { session_id: ROOT_HANDLE, chars: '', yield_time_ms: 3_600_000 }),
        callOutput('poll-1', pendingOutput('cell-root-1')),
        callOutput('poll-2', completedOutput({ output: contract.terminalOutput, exit_code: 0, session_id: ROOT_HANDLE })),
      ]];
      const result = inspectShellWaitEvidence(rootEvidenceInput('review-wait', { rollouts }));
      assert.equal(result.status, 'supported');
      assert.equal(result.facts.handle.overlappingInnerPolls, 1, 'the second poll was issued while the first observation was still outstanding');
      assert.equal(result.facts.completion.qualified, false);
    });

    test('review-wait: a duplicated process launch never qualifies', () => {
      const rollouts = rootRollout('review-wait', { mutations: (events) => {
        events.splice(4, 0,
          wrappedCall('exec_command', 'launch-2', { cmd: CASE_CONTRACTS['review-wait'].command, workdir: '/installed/workspace' }),
          callOutput('launch-2', completedOutput({ output: '', session_id: 43 })));
        return events;
      } });
      const result = inspectShellWaitEvidence(rootEvidenceInput('review-wait', { rollouts }));
      assert.equal(result.status, 'supported');
      assert.equal(result.facts.companion.launchCount, 2);
      assert.equal(result.facts.companion.duplicateLaunch, true);
      assert.equal(result.facts.completion.qualified, false);
      assert.match(result.facts.completion.reason, /additional exec_command process launch|observed 2 times/u);
    });

    test('review-wait: truncated evidence is inconclusive, never qualified', () => {
      const rollouts = [[rootMeta(),
        { type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'trunc-1',
          input: `const r = await tools.exec_command({cmd:${JSON.stringify(CASE_CONTRACTS['review-wait'].command)}` } }]];
      const result = inspectShellWaitEvidence(rootEvidenceInput('review-wait', { rollouts }));
      assert.equal(result.status, 'inconclusive');
      assert.equal(result.inconclusive.reason, 'unsupported-call-shape');
      assert.equal(result.inconclusive.manualAdjudicationRequired, true);
    });

    test('status-wait: a renderer mismatch (output lacking the rendered job-status lines) never qualifies and withholds the body', () => {
      const rollouts = rootRollout('status-wait', { mutations: (events) => {
        // The terminal output carries the bare Rescue sentinel instead of the
        // rendered job-status view — a renderer mismatch for the Status case.
        events.pop();
        events.push(callOutput('outer-1', completedOutput({ output: `${SENTINEL}\n`, exit_code: 0, session_id: ROOT_HANDLE })));
        return events;
      } });
      const result = inspectShellWaitEvidence(rootEvidenceInput('status-wait', { rollouts }));
      assert.equal(result.status, 'supported');
      assert.equal(result.facts.completion.processExit, 0, 'the process exit alone does not qualify the command');
      assert.equal(result.facts.completion.publicResultMatched, false);
      assert.equal(result.facts.completion.qualified, false);
      assert.match(result.facts.completion.reason, /command-specific|did not match|terminal public result/u);
      assert.equal(result.facts.completion.terminalStdoutExcerpt.kind, 'terminal-stdout-mismatch');
      assert.equal(result.facts.completion.terminalStdoutExcerpt.sentinelPresent, false);
      assert.ok(result.facts.completion.terminalStdoutExcerpt.outputChars > 0, 'the mismatched body size is recorded');
      assert.equal(JSON.stringify(result.facts.completion.terminalStdoutExcerpt).includes(SENTINEL), false, 'the mismatched output body is withheld');
    });

    test('a Root delay script (a spawned sleep instead of the Companion command) never qualifies, even with an assistant success claim', () => {
      const rollouts = [[
        rootMeta(),
        quotedMessage(`I ran ${CASE_CONTRACTS['review-wait'].command} to completion; the review output follows.`),
        wrappedCall('exec_command', 'delay-1', { cmd: 'sleep 90', workdir: '/installed/workspace' }),
        callOutput('delay-1', completedOutput({ output: `${SENTINEL}\n`, exit_code: 0, session_id: 44 })),
      ]];
      const result = inspectShellWaitEvidence(rootEvidenceInput('review-wait', { rollouts }));
      assert.equal(result.status, 'supported');
      assert.equal(result.facts.linkage.exact, false, 'the delay script is not the constant Companion command');
      assert.equal(result.facts.completion.qualified, false);
    });

    test('a Rescue-shaped private preparation frame in a root case is input injection, never sanctioned', () => {
      const rollouts = rootRollout('review-wait', { mutations: (events) => {
        events.splice(4, 0, wrappedCall('write_stdin', 'prep-1', {
          session_id: ROOT_HANDLE,
          chars: `${JSON.stringify({ version: 5, source: 'explicit', task: 'rescue-shaped' })}\n`,
        }));
        return events;
      } });
      const result = inspectShellWaitEvidence(rootEvidenceInput('review-wait', { rollouts }));
      assert.equal(result.status, 'supported');
      assert.equal(result.facts.handle.preparationFrameWrites, 0, 'the Rescue preparation sanction does not exist in root mode');
      assert.equal(result.facts.completion.qualified, false);
      assert.match(result.facts.completion.reason, /nonempty input|input injection/u);
    });

    test('an unknown observer mode fails closed instead of silently assuming Rescue', () => {
      assert.throws(() => inspectShellWaitEvidence(rootEvidenceInput('review-wait', { input: { mode: 'Child' } })), /mode/u);
    });

    // --- Slice B: the driver's case-spec and live-facts mapping seams. ---

    test('the driver case specs bind the documented root-family command surface and the narrower rendered-result checks', () => {
      assert.equal(SHELL_WAIT_CASE_SPECS['review-wait'].family, 'root');
      assert.equal(SHELL_WAIT_CASE_SPECS['review-wait'].companionCommand, 'invoke review');
      assert.equal(SHELL_WAIT_CASE_SPECS['adversarial-review-wait'].family, 'root');
      assert.equal(SHELL_WAIT_CASE_SPECS['adversarial-review-wait'].companionCommand, 'invoke adversarial-review');
      assert.equal(SHELL_WAIT_CASE_SPECS['status-wait'].family, 'root');
      assert.equal(SHELL_WAIT_CASE_SPECS['status-wait'].companionCommand, 'invoke status');
      // The command-specific rendered-result checks carry their narrower basis
      // label; the Status markers are the stable renderJob field lines.
      assert.deepEqual(SHELL_WAIT_CASE_SPECS['status-wait'].resultMarkers, STATUS_MARKERS);
      assert.match(SHELL_WAIT_CASE_SPECS['status-wait'].resultCheckLabel, /narrower/i);
      assert.deepEqual(SHELL_WAIT_CASE_SPECS['review-wait'].resultMarkers, REVIEW_MARKERS);
      assert.match(SHELL_WAIT_CASE_SPECS['review-wait'].resultCheckLabel, /narrower/i);
      // The Rescue family keeps its own contract unchanged.
      assert.equal(SHELL_WAIT_CASE_SPECS['rescue-long'].family, 'rescue');
      assert.equal(SHELL_WAIT_CASE_SPECS['rescue-long'].companionCommand, undefined);
    });

    test('the live evidence request selects the Root contract for root-family cases and the Rescue sentinel for Rescue cases', () => {
      const rootRequest = shellWaitEvidenceRequest({
        case: 'review-wait', command: REVIEW_COMMAND, rollouts: [], zcodeCalls: [],
        workerDurationMs: 130_000, pollMs: 3_600_000, workerStillAliveAfterObservation: false,
      });
      assert.equal(rootRequest.mode, 'root');
      assert.deepEqual(rootRequest.publicResultMarkers, REVIEW_MARKERS);
      assert.equal(rootRequest.publicResult, undefined, 'the Rescue sentinel is not the root-family result contract');
      const statusRequest = shellWaitEvidenceRequest({
        case: 'status-wait', command: STATUS_COMMAND, rollouts: [], zcodeCalls: [],
        workerDurationMs: 130_000, pollMs: 3_600_000, workerStillAliveAfterObservation: false,
      });
      assert.equal(statusRequest.mode, 'root');
      assert.deepEqual(statusRequest.publicResultMarkers, STATUS_MARKERS);
      const rescueRequest = shellWaitEvidenceRequest({
        case: 'rescue-long', command: RESCUE_COMMAND_PLACEHOLDER, rollouts: [], zcodeCalls: [],
        workerDurationMs: 420_000, pollMs: 3_600_000, workerStillAliveAfterObservation: false,
      });
      assert.equal(rescueRequest.mode, undefined, 'Rescue keeps its pre-R2 contract implicitly');
      assert.equal(rescueRequest.publicResult, 'ZCODE_RESCUE_PUBLIC_SENTINEL_7C9C');
      assert.equal(rescueRequest.publicResultMarkers, undefined);
    });

    test('the driver maps a qualified root-family evidence result with root linkage facts, no child route, and the labeled command-specific result check', () => {
      const result = inspectShellWaitEvidence(rootEvidenceInput('review-wait'));
      assert.equal(result.facts.completion.qualified, true);
      const facts = mapShellWaitLiveFacts(rootMappingInput, executedHeld, result, '0.160.1', null, rootMappingFixture, [], []);
      assert.equal(facts.route.requested, 'review-wait');
      assert.equal(facts.route.actual, null, 'a root-family case has no named/generic agent route');
      assert.equal(facts.linkage.mode, 'root');
      assert.equal(facts.linkage.checked, true);
      assert.equal(facts.linkage.rootThreadId, ROOT_THREAD, 'the identified Root host turn id is bound in the mapped facts');
      assert.equal(facts.linkage.childThreadId, null, 'no Rescue Child exists for a root-family case');
      assert.equal(facts.observations.outerReturns, 1);
      assert.equal(facts.observations.rootJoins, null);
      assert.equal(facts.hostResult.companionProcessExit, 0);
      assert.equal(facts.hostResult.sentinelMatched, true);
      assert.equal(facts.hostResult.resultCheck, 'command-rendered-result-markers');
      assert.match(facts.hostResult.resultCheckLabel, /narrower/i);
      assert.equal(facts.inconclusive, null);
    });

    test('the written root-family record carries the root linkage mode, root thread id, and the labeled result check', async (t) => {
      const temporary = await mkdtemp(join(tmpdir(), 'shell-wait-root-record-'));
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
      const record = await runShellWaitCase(caseInputFor('review-wait', { output }), {
        createFixture: async () => fakeFixture,
        executeLiveCase: async () => {
          const evidence = inspectShellWaitEvidence(rootEvidenceInput('review-wait'));
          return mapShellWaitLiveFacts(rootMappingInput, executedHeld, evidence, '0.160.1', null, fakeFixture, [], []);
        },
      });
      assert.equal(record.status, 'executed');
      assert.equal(record.linkage.mode, 'root');
      assert.equal(record.linkage.rootThreadId, ROOT_THREAD);
      assert.equal(record.linkage.childThreadId, null);
      assert.equal(record.result.resultCheck, 'command-rendered-result-markers');
      assert.match(record.result.resultCheckLabel, /narrower/i);
    });
  });

  describe('root-family candidate-policy delivery seam (R2)', async () => {
    const { createShellWaitFixture } = await import('../tools/shell-wait-probe/fixture.mjs');
    const { runShellWaitCase } = await import('../tools/shell-wait-probe/driver.mjs');
    const repositorySha = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
    const realSkills = {
      review: await readFile(join(repositoryRoot, 'skills', 'review', 'SKILL.md'), 'utf8'),
      'adversarial-review': await readFile(join(repositoryRoot, 'skills', 'adversarial-review', 'SKILL.md'), 'utf8'),
      status: await readFile(join(repositoryRoot, 'skills', 'status', 'SKILL.md'), 'utf8'),
    };
    // Independent sources of truth: the constant-command sentence lines are
    // taken verbatim from the repository Skills, so the delivery test asserts
    // that commands/arguments/placement stay unchanged while only the waiting
    // paragraph moves.
    const commandSentences = {
      review: realSkills.review.split('\n').find((line) => line.includes('invoke review` over ordinary stdio')),
      'adversarial-review': realSkills['adversarial-review'].split('\n').find((line) => line.includes('invoke adversarial-review` over ordinary stdio')),
      status: realSkills.status.split('\n').find((line) => line.includes('invoke status` over ordinary stdio')),
    };
    const SKILL_ROLES = [['review', 'review-skill'], ['adversarial-review', 'adversarial-review-skill'], ['status', 'status-skill']];

    /**
     * Fast installer that mirrors the real install layout for the artifacts
     * the fixture touches (the managed Role template and the four Skills).
     */
    async function fakeInstallPlugin({ codexHome, cleanSource }) {
      const installedRoot = join(codexHome, 'plugins', 'cache', 'vitry', 'zcode', '0.1.0');
      await mkdir(join(installedRoot, 'agents'), { recursive: true });
      await cp(join(cleanSource, 'agents', 'zcode-rescue.toml.template'), join(installedRoot, 'agents', 'zcode-rescue.toml.template'));
      for (const skill of ['rescue', 'review', 'adversarial-review', 'status']) {
        await mkdir(join(installedRoot, 'skills', skill), { recursive: true });
        await cp(join(cleanSource, 'skills', skill, 'SKILL.md'), join(installedRoot, 'skills', skill, 'SKILL.md'));
      }
      await writeFile(join(codexHome, 'config.toml'), '[marketplaces.vitry]\nsource_type = "local"\n\n[plugins."zcode@vitry"]\nenabled = true\n', { encoding: 'utf8' });
      return { pluginVersion: '0.1.0' };
    }

    async function fakeBuildSnapshot({ output, sourceSha }) {
      await mkdir(join(output, '.agents', 'plugins'), { recursive: true });
      await writeFile(join(output, '.agents', 'plugins', 'provenance.json'), `${JSON.stringify({ sourceSha })}\n`, 'utf8');
    }

    const deliveryDependencies = () => ({
      buildSnapshot: fakeBuildSnapshot,
      installPlugin: fakeInstallPlugin,
      runSetup: async (context) => Promise.resolve({ sessionEstablished: true, launcherDescriptorPublished: true, setupAttempts: 1, roleStatus: 'ready', capVerified: context.capMs === null ? null : true }),
    });

    async function createDeliveryFixture(t, overrides = {}, dependencies = deliveryDependencies()) {
      const temporary = await mkdtemp(join(tmpdir(), 'shell-wait-delivery-'));
      t.after(() => rm(temporary, { recursive: true, force: true }));
      const output = join(temporary, 'output');
      await mkdir(output, { mode: 0o700 });
      const fixture = await createShellWaitFixture({
        sourceRoot: repositoryRoot,
        sourceSha: repositorySha,
        codexBinary: process.execPath,
        output,
        variant: 'baseline',
        capMs: null,
        ...overrides,
      }, dependencies);
      t.after(() => fixture.dispose());
      return fixture;
    }

    test('candidate root-family fixture delivers the candidate waiting paragraph to the installed Review/Adversarial Review/Status Skills and records the hashes', async (t) => {
      const fixture = await createDeliveryFixture(t, { variant: 'candidate', commandSkillVariant: 'candidate' });
      assert.equal(fixture.record.pollMs, 3_600_000);
      for (const [skillDirectory, role] of SKILL_ROLES) {
        const installed = await readFile(join(fixture.installedRoot, 'skills', skillDirectory, 'SKILL.md'), 'utf8');
        assert.equal(installed.includes('yield_time_ms: 60000'), false, `${role}: the installed 60000 policy must be replaced by the delivered candidate paragraph`);
        assert.match(installed, /yield_time_ms: 3600000/, `${role}: the candidate inner observation request must name the candidate window`);
        assert.equal((installed.match(/\/\/ @exec: \{"yield_time_ms": 3600000\}/gu) ?? []).length, 1,
          `${role}: exactly one directive-led candidate waiting instruction is delivered`);
        assert.equal(installed.includes(commandSentences[skillDirectory]), true,
          `${role}: the constant command sentence stays byte-identical — only the waiting instructions changed`);
      }
      const delivery = fixture.record.commandSkillVariants;
      assert.equal(delivery.variant, 'candidate');
      assert.deepEqual(delivery.appliedArtifacts.map((artifact) => artifact.role).sort(),
        ['adversarial-review-skill', 'review-skill', 'status-skill'], 'exactly the three command Skills are recorded');
      for (const artifact of delivery.appliedArtifacts) {
        assert.notEqual(artifact.beforeSha256, artifact.afterSha256, `${artifact.role}: the delivered change is hashed`);
        assert.match(artifact.mode, /^0o0?[0-7]{2,4}$/u, `${artifact.role}: the file mode is recorded`);
      }
      assert.equal(delivery.differences.length, 3, 'the sanitized waiting-paragraph differences are retained for all three Skills');
      assert.match(delivery.deliveryProofNote, /Skill text/, 'the record documents that the delivered Skill text is the proof');
      assert.match(delivery.deliveryProofNote, /--poll-ms/, 'the record documents that a raised cap or --poll-ms alone is NOT delivery proof');
      // The Rescue candidate artifacts are still applied alongside (the
      // candidate variant keeps its Rescue edits).
      assert.equal(fixture.record.appliedArtifacts.length, 2, 'the named Role template and generic assignment skill keep their candidate edits');
    });

    test('baseline root-family fixture keeps the installed command Skills byte-identical (hashes recorded, no candidate paragraph)', async (t) => {
      const fixture = await createDeliveryFixture(t, { variant: 'baseline' });
      for (const [skillDirectory] of SKILL_ROLES) {
        const installed = await readFile(join(fixture.installedRoot, 'skills', skillDirectory, 'SKILL.md'), 'utf8');
        assert.equal(installed, realSkills[skillDirectory], `${skillDirectory}: the baseline fixture must not touch the installed command Skill`);
      }
      const delivery = fixture.record.commandSkillVariants;
      assert.equal(delivery.variant, 'baseline');
      assert.deepEqual(delivery.appliedArtifacts.map((artifact) => artifact.role).sort(),
        ['adversarial-review-skill', 'review-skill', 'status-skill']);
      for (const artifact of delivery.appliedArtifacts) {
        assert.equal(artifact.beforeSha256, artifact.afterSha256, `${artifact.role}: baseline records the identical hash`);
      }
      assert.deepEqual(delivery.differences, []);
    });

    test('the candidate command-skill seam is refused for a baseline variant (fail-closed combination)', async (t) => {
      await assert.rejects(
        createDeliveryFixture(t, { variant: 'baseline', commandSkillVariant: 'candidate' }),
        /commandSkillVariant/u,
      );
    });

    test('a broken installed command Skill (no waiting paragraph) fails the candidate fixture closed', async (t) => {
      const mutatedDependencies = deliveryDependencies();
      const originalInstall = mutatedDependencies.installPlugin;
      mutatedDependencies.installPlugin = async (context) => {
        const record = await originalInstall(context);
        // Mutate ONE installed command Skill so its waiting paragraph is gone.
        const statusPath = join(context.codexHome, 'plugins', 'cache', 'vitry', 'zcode', '0.1.0', 'skills', 'status', 'SKILL.md');
        const mutated = (await readFile(statusPath, 'utf8')).replace(/Start the constant command once[\s\S]*?Status polling or sleep\./u, 'Observe with a 90000 ms window.');
        await writeFile(statusPath, mutated, 'utf8');
        return record;
      };
      await assert.rejects(
        createDeliveryFixture(t, { variant: 'candidate', commandSkillVariant: 'candidate' }, mutatedDependencies),
        /exactly one command waiting-policy paragraph/u,
      );
    });

    test('runShellWaitCase requests the candidate command-skill delivery exactly for root-family candidate cases', async (t) => {
      const caseInput = (label, overrides = {}) => ({
        case: label, codexBinary: process.execPath, sourceSha: 'a'.repeat(40), output: '/o',
        workerDurationMs: 130_000, capMs: null, pollMs: 3_600_000, budgetMs: 360_000,
        ...overrides,
      });
      const captured = [];
      const fakeFixture = (root) => ({
        workspace: join(root, 'fixture', 'workspace'),
        codexHome: join(root, 'fixture', 'codex-home'),
        installedRoot: join(root, 'fixture', 'installed'),
        env: { CODEX_HOME: join(root, 'fixture', 'codex-home') },
        record: { variant: 'candidate', capMs: null, pollMs: 3_600_000, appliedArtifacts: [] },
        dispose: async () => {},
      });
      for (const label of ['review-wait', 'status-wait', 'rescue-long', 'rescue-baseline']) {
        const temporary = await mkdtemp(join(tmpdir(), 'shell-wait-delivery-case-'));
        t.after(() => rm(temporary, { recursive: true, force: true }));
        const output = join(temporary, 'output');
        await mkdir(output, { mode: 0o700 });
        const fixture = fakeFixture(temporary);
        await runShellWaitCase(caseInput(label, { output }), {
          createFixture: async (fixtureInput) => {
            captured.push({ label, fixtureInput });
            return fixture;
          },
          executeLiveCase: async () => ({
            codexVersion: null,
            route: { requested: 'review-wait', actual: null },
            hostResult: { exitCode: null, companionProcessExit: null, sentinelMatched: null, terminalStdoutChecked: null },
            linkage: { checked: null, childThreadId: null, parentThreadId: null, companionLaunchCount: null, companionSendCount: null, originalHandleChecked: null },
            observations: { outerReturns: null, modelCalls: null, rootJoins: null, decisiveWallMs: null, remainingLifetimeMs: null, pendingInnerAtEnd: null },
            interrupt: { requested: false, delivered: null, settled: null, missingPrerequisite: null },
            held: { endedBeforeGate: null, cleanupLabel: null, gateReleased: null, cleanupErrors: { count: 0, reasons: [] }, processTermination: { verifiedTerminated: null, codexTerminated: null } },
            excerpts: [],
            inconclusive: null,
          }),
        });
      }
      const byLabel = Object.fromEntries(captured.map((entry) => [entry.label, entry.fixtureInput]));
      assert.equal(byLabel['review-wait'].variant, 'candidate');
      assert.equal(byLabel['review-wait'].commandSkillVariant, 'candidate', 'a root-family candidate case delivers the candidate command-Skill paragraph');
      assert.equal(byLabel['status-wait'].commandSkillVariant, 'candidate');
      assert.equal(byLabel['rescue-long'].commandSkillVariant, 'baseline', 'Rescue cases do not touch the command Skills');
      assert.equal(byLabel['rescue-baseline'].variant, 'baseline');
      assert.equal(byLabel['rescue-baseline'].commandSkillVariant, 'baseline');
    });
  });

  describe('unsupported-call and final-message preparation privacy (R0 canaries)', async () => {
    const { inspectShellWaitEvidence } = await import('../tools/shell-wait-probe/evidence.mjs');
    const { mapShellWaitLiveFacts, runShellWaitCase } = await import('../tools/shell-wait-probe/driver.mjs');

    const PARENT = 'privacy-parent';
    const CHILD = 'privacy-child';
    const AGENT_PATH = '/root/privacy_task_1';
    const LAUNCHER = 'node "/installed/privacy/skills/rescue/launcher.mjs" invoke-prepared rescue';
    const SENTINEL = 'ZCODE_RESCUE_PUBLIC_SENTINEL_7C9C';
    const HANDLE = 93;
    // Synthetic canaries invented for these regressions. They deliberately do
    // not match any real production text, so ANY occurrence in the returned
    // evidence object or a persisted record is a privacy leak by construction.
    const CANARY_TASK = 'CANARY-TASK-BODY-7Q2X';
    const CANARY_ENVELOPE = 'CANARY-PREP-ENVELOPE-3M8K';
    const CANARY_CAPABILITY = 'CANARY-CAPABILITY-9V4D';
    const CANARY_ECHO = 'CANARY-ECHO-5B7N';
    // A private numeric embedded in TASK TEXT (the reviewer's exact repro): an
    // allowlisted field NAME occurring inside private string content must not
    // cause the number to be retained as a protocol argument.
    const CANARY_PIN = '74923411';

    const meta = (id, extra = {}) => ({ type: 'session_meta', payload: { id, ...extra } });
    const childMeta = () => meta(CHILD, { parent_thread_id: PARENT, source: { subagent: { thread_spawn: { agent_path: AGENT_PATH } } } });
    const fnCall = (name, callId, args) => ({ type: 'response_item', payload: { type: 'function_call', name, call_id: callId, arguments: JSON.stringify(args) } });
    const wrappedCall = (kind, callId, value) => ({ type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: callId, input: `const r = await tools.${kind}(${JSON.stringify(value)}); text(JSON.stringify(r))\n` } });
    const callOutput = (callId, output) => ({ type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: callId, output } });
    const fnOutput = (callId, output) => ({ type: 'response_item', payload: { type: 'function_call_output', call_id: callId, output } });
    const completedOutput = (result) => [{ type: 'input_text', text: 'Script completed\n' }, { type: 'input_text', text: JSON.stringify(result) }];
    const pendingOutput = (cellId) => [{ type: 'input_text', text: `Script running with cell ID ${cellId}\n` }];
    const startedEvent = () => ({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'SubAgentActivity', kind: 'started', agent_thread_id: CHILD, agent_path: AGENT_PATH } } });

    function qualifiedPrivacyRollouts() {
      return [
        [meta(PARENT),
          fnCall('spawn_agent', 'spawn-1', { task_name: 'privacy_task_1', fork_turns: 'none', agent_type: 'zcode-rescue', message: 'Run the installed prepared ZCode Rescue forwarder now. Return its public stdout verbatim.' }),
          startedEvent(),
          fnCall('wait_agent', 'root-wait-1', { timeout_ms: 600000 })],
        [childMeta(),
          wrappedCall('exec_command', 'launch-1', { cmd: LAUNCHER, workdir: '/installed/workspace' }),
          callOutput('launch-1', completedOutput({ output: '', session_id: HANDLE })),
          wrappedCall('write_stdin', 'poll-1', { session_id: HANDLE, chars: '', yield_time_ms: 60000 }),
          callOutput('poll-1', completedOutput({ output: SENTINEL, exit_code: 0, session_id: HANDLE }))],
      ];
    }

    // The exact observed live preparation shape (report §§7.4/8.2): a
    // PRODUCTION-VALID v5 envelope (it passes validateRescuePreparation's
    // exact-key schema; the canary lives only in the sanctioned task-content
    // field) whose write carries the optional `yield_time_ms:1000` argument.
    // R1 correction: PREPARATION_PATTERN now accepts that observed optional
    // argument, so this shape takes the SUPPORTED one-shot preparation path —
    // the private frame must stay suppressed there too.
    const canaryPreparationCall = () => ({ type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'prep-1',
      input: 'text(await tools.write_stdin({session_id:93,chars:JSON.stringify({version:5,source:"explicit",task:"'
        + `${CANARY_TASK} Run exactly npm test. Authorization PIN max_output_tokens: ${CANARY_PIN}.",`
        + 'options:{hostPlacement:"foreground",companionExecution:"foreground",foregroundAdapter:"shell",resume:"fresh"},continuationTarget:null})+"\\n",yield_time_ms:1000}));\n' } });
    // A genuinely UNSUPPORTED cell carrying the same canaries: the legal
    // preparation statement is followed by a trailing unsupported statement,
    // which rejects the entire cell fail-closed (R1's trailing-input negative).
    const unsupportedCanaryCell = () => ({ type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'prep-1',
      input: `${canaryPreparationCall().payload.input}text(${JSON.stringify(`${CANARY_ECHO} trailing`)});\n` } });

    const evidenceInput = (rollouts, overrides = {}) => ({
      rollouts,
      zcodeCalls: [{ method: 'session/send', params: { sessionId: 'fake-session' } }],
      command: LAUNCHER,
      publicResult: SENTINEL,
      workerStillAliveAfterObservation: false,
      redactions: [],
      ...overrides,
    });

    const mappingInput = {
      case: 'rescue-noise', codexBinary: '/bin/x', sourceSha: 'a'.repeat(40), output: '/o',
      workerDurationMs: 130_000, capMs: null, pollMs: 3_600_000, budgetMs: 360_000,
    };
    const mappingFixture = {
      workspace: '/private/tmp/privacy-ws', codexHome: '/private/tmp/privacy-home',
      installedRoot: '/private/tmp/privacy-installed', env: { HOME: '/private/tmp/privacy-home' },
      record: { variant: 'candidate', capMs: null, pollMs: 3_600_000, appliedArtifacts: [] },
    };
    const earlyExitHeld = {
      endedBeforeGate: true, budgetExpired: false, identity: undefined, processAliveWhileHeld: null,
      result: { code: 0, stdout: '', stderr: '' },
      cleanup: { label: 'early-exit', releasedGate: true, verifiedProcessTerminated: true, codexTerminated: true, nativeInterruptionClaimed: false, errors: [] },
    };

    test('preparation privacy: a valid v5 preparation write with yield_time_ms:1000 suppresses its canary envelope and task body', () => {
      const rollouts = qualifiedPrivacyRollouts();
      rollouts[1].splice(3, 0, canaryPreparationCall());
      const result = inspectShellWaitEvidence(evidenceInput(rollouts));
      // R1 correction: the observed legal shape is now the SUPPORTED sanctioned
      // one-shot preparation — and the private frame stays suppressed on the
      // supported path too (projected excerpt, never the raw body).
      assert.equal(result.status, 'supported');
      assert.equal(result.facts.handle.preparationFrameWrites, 1);
      const prepExcerpt = result.facts.collection.excerpts.map((excerpt) => excerpt.text)
        .find((text) => text.includes('"write_stdin"'));
      assert.ok(prepExcerpt, 'the sanctioned write keeps a projected supported-path excerpt');
      assert.match(prepExcerpt, /"yield_time_ms":1000/u, 'the validated yield fact survives on the supported path');
      assert.match(prepExcerpt, /"<private-input>"/u, 'the private chars stay suppressed');
      // Neither the returned evidence object nor the mapped facts that feed
      // the persisted record may contain any canary substring. The fixture
      // carries the task canary and the embedded numeric PIN.
      const serializedEvidence = JSON.stringify(result);
      const facts = mapShellWaitLiveFacts(mappingInput, earlyExitHeld, result, null, null, mappingFixture, rollouts, []);
      const serializedFacts = JSON.stringify(facts);
      for (const canary of [CANARY_TASK, CANARY_PIN]) {
        assert.equal(serializedEvidence.includes(canary), false, `the private canary ${canary} must never survive into the returned evidence`);
        assert.equal(serializedFacts.includes(canary), false, `the private canary ${canary} must never survive into the mapped record facts`);
      }
    });

    test('preparation privacy: truncated direct function-call arguments suppress canary task content', () => {
      const rollouts = [[meta(PARENT)], [childMeta(),
        { type: 'response_item', payload: { type: 'function_call', name: 'write_stdin', call_id: 'trunc-1', arguments: `{"session_id":${HANDLE},"chars":"${CANARY_TASK}","trunc` } }]];
      const result = inspectShellWaitEvidence(evidenceInput(rollouts));
      assert.equal(result.status, 'inconclusive');
      assert.equal(result.inconclusive.reason, 'unsupported-call-shape');
      assert.match(result.inconclusive.detail, /truncated or unparsable/u);
      assert.equal(result.inconclusive.manualAdjudicationRequired, true);
      assert.match(result.inconclusive.excerpt.text, /write_stdin/u, 'the payload-declared tool name stays a structural fact');
      assert.equal(JSON.stringify(result).includes(CANARY_TASK), false, 'the truncated argument body must be withheld');
      // The non-object direct-argument sub-path (parsed JSON that is not a
      // plain object, e.g. an array or string carrying canary content) is
      // suppressed by the same structural rule.
      const nonObjectRollouts = [[meta(PARENT)], [childMeta(),
        { type: 'response_item', payload: { type: 'function_call', name: 'write_stdin', call_id: 'array-1', arguments: JSON.stringify([{ chars: CANARY_TASK }]) } }]];
      const nonObjectResult = inspectShellWaitEvidence(evidenceInput(nonObjectRollouts));
      assert.equal(nonObjectResult.status, 'inconclusive');
      assert.equal(nonObjectResult.inconclusive.reason, 'unsupported-call-shape');
      assert.match(nonObjectResult.inconclusive.detail, /unsupported shape/u);
      assert.equal(nonObjectResult.inconclusive.manualAdjudicationRequired, true);
      assert.match(nonObjectResult.inconclusive.excerpt.text, /write_stdin/u, 'the payload-declared tool name stays a structural fact');
      assert.match(nonObjectResult.inconclusive.excerpt.text, /unsupported-direct-argument-shape/u, 'the failure classification stays visible');
      assert.equal(JSON.stringify(nonObjectResult).includes(CANARY_TASK), false, 'non-object argument content must be withheld');
    });

    test('preparation privacy: an unsupported wrapper tail suppresses canary capability content', () => {
      const rollouts = [[meta(PARENT)], [childMeta(),
        { type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'bad-1',
          input: `const r = await tools.exec_command({cmd:"cat installed/skills/rescue/SKILL.md"}); text(r); console.log("${CANARY_CAPABILITY}");\n` } }]];
      const result = inspectShellWaitEvidence(evidenceInput(rollouts));
      assert.equal(result.status, 'inconclusive');
      assert.equal(result.inconclusive.reason, 'unsupported-call-shape');
      assert.equal(result.inconclusive.manualAdjudicationRequired, true);
      assert.match(result.inconclusive.excerpt.text, /exec_command/u, 'the structural excerpt must retain the allowlisted nearest tool name');
      assert.equal(JSON.stringify(result).includes(CANARY_CAPABILITY), false, 'the unclassifiable script body must be withheld');
      // A quoted `tools.<name>`-shaped fragment in the body is NOT a public
      // tool name: only fixed allowlisted names are retained, and unknown
      // identifiers are withheld behind a null tool fact.
      const quotedToolRollouts = [[meta(PARENT)], [childMeta(),
        { type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'bad-2',
          input: `console.log("see tools.CANARY_CAPABILITY_9V4D output");\n` } }]];
      const quotedToolResult = inspectShellWaitEvidence(evidenceInput(quotedToolRollouts));
      assert.equal(quotedToolResult.status, 'inconclusive');
      assert.equal(quotedToolResult.inconclusive.reason, 'unsupported-call-shape');
      const quotedToolSerialized = JSON.stringify(quotedToolResult);
      assert.equal(quotedToolSerialized.includes('CANARY_CAPABILITY_9V4D'), false, 'a tools-prefixed private identifier must be withheld');
      assert.match(quotedToolResult.inconclusive.excerpt.text, /"tool":null/u, 'an unknown tools-like name is withheld, not retained');
    });

    test('preparation privacy: an unsupported multi-statement cell suppresses canary task and capability content', () => {
      const input = `text(await tools.exec_command({cmd:"cat installed/skills/rescue/SKILL.md"}));\nconsole.log("${CANARY_TASK} ${CANARY_CAPABILITY}");\n`;
      const rollouts = [[meta(PARENT)], [childMeta(),
        { type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'cell-1', input } }]];
      const result = inspectShellWaitEvidence(evidenceInput(rollouts));
      assert.equal(result.status, 'inconclusive');
      assert.equal(result.inconclusive.reason, 'unsupported-call-shape');
      assert.match(result.inconclusive.excerpt.text, /exec_command/u, 'the supported first statement keeps its tool shape visible');
      const serializedEvidence = JSON.stringify(result);
      assert.equal(serializedEvidence.includes(CANARY_TASK), false, 'the rejected cell body must be withheld');
      assert.equal(serializedEvidence.includes(CANARY_CAPABILITY), false, 'the rejected cell body must be withheld');
      // Hostile directive-KEY position: even an IDENTIFIER-SHAPED private
      // string used as a directive key name is withheld — only the fixed
      // allowlist of public protocol key names survives; everything else
      // degrades to a withheld count.
      const hostileDirectiveInput = `// @exec: {"${CANARY_ENVELOPE}":1,"window":3}\nconsole.log("${CANARY_TASK}");\n`;
      const hostileRollouts = [[meta(PARENT)], [childMeta(),
        { type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'cell-2', input: hostileDirectiveInput } }]];
      const hostileResult = inspectShellWaitEvidence(evidenceInput(hostileRollouts));
      assert.equal(hostileResult.status, 'inconclusive');
      assert.equal(hostileResult.inconclusive.reason, 'unsupported-call-shape');
      const hostileSerialized = JSON.stringify(hostileResult);
      assert.equal(hostileSerialized.includes(CANARY_ENVELOPE), false, 'an identifier-shaped private directive KEY name must be withheld');
      assert.equal(hostileSerialized.includes(CANARY_TASK), false, 'the unsupported line body must be withheld');
      assert.match(hostileResult.inconclusive.excerpt.text, /"directiveKeys":\["window"\]/u, 'allowlisted public key names stay visible');
      assert.match(hostileResult.inconclusive.excerpt.text, /"withheldDirectiveKeys":1/u, 'unknown key names degrade to a withheld count');
    });

    test('preparation privacy: the final-agent-message early-exit excerpt suppresses canary echo content', () => {
      const rollouts = qualifiedPrivacyRollouts();
      rollouts[0].push({ type: 'event_msg', payload: { type: 'agent_message', message: `The fixture task ${CANARY_ECHO} could not finish; retry from an owned parent turn.` } });
      const result = inspectShellWaitEvidence(evidenceInput(rollouts));
      assert.equal(result.status, 'supported', 'the echo regression needs the supported mapping branch');
      const facts = mapShellWaitLiveFacts(mappingInput, earlyExitHeld, result, '0.160.1', null, mappingFixture, rollouts, []);
      const serializedFacts = JSON.stringify(facts);
      assert.equal(serializedFacts.includes(CANARY_ECHO), false, 'the assistant echo of the private task must be withheld from the record facts');
      const excerpt = facts.excerpts.find((entry) => entry.kind === 'final-agent-message');
      assert.ok(excerpt, 'the early-exit adjudication keeps a structural final-message marker');
      assert.equal(excerpt.suppressed, true, 'the marker must be explicit about the suppression');
      assert.equal(excerpt.text, undefined, 'no assistant text may be persisted');
      assert.ok(excerpt.messageChars > 0, 'the withheld message keeps only its length');
    });

    test('preparation privacy: input-injection reasons never quote the injected canary chars', () => {
      const rollouts = qualifiedPrivacyRollouts();
      rollouts[1].push(fnCall('write_stdin', 'inject-1', { session_id: HANDLE, chars: CANARY_TASK }));
      const result = inspectShellWaitEvidence(evidenceInput(rollouts));
      assert.equal(result.status, 'supported');
      assert.equal(result.facts.completion.qualified, false, 'the injection must still block qualification');
      const reason = String(result.facts.completion.reason);
      assert.match(reason, /instead of empty input/u, 'the structural violation stays');
      assert.equal(reason.includes(CANARY_TASK), false, 'the injected input content must never be quoted into a reason');
      const facts = mapShellWaitLiveFacts(mappingInput, earlyExitHeld, result, '0.160.1', null, mappingFixture, rollouts, []);
      assert.equal(JSON.stringify(facts).includes(CANARY_TASK), false, 'the injected input content must never reach the mapped record facts');
    });

    test('preparation privacy: an extra private field on a sanctioned poll is rejected and suppressed end to end', async (t) => {
      const root = await mkdtemp(join(tmpdir(), 'shell-wait-preparation-privacy-'));
      t.after(() => rm(root, { recursive: true, force: true }));
      const rollouts = qualifiedPrivacyRollouts();
      rollouts[1][3] = wrappedCall('write_stdin', 'poll-1', { session_id: HANDLE, chars: '', yield_time_ms: 60000, task: CANARY_TASK });
      const result = inspectShellWaitEvidence(evidenceInput(rollouts));
      assert.equal(result.status, 'supported');
      // Correctness: an argument outside the sanctioned poll shape can no
      // longer qualify completion even when the sentinel matches.
      assert.equal(result.facts.completion.qualified, false, 'an extra unclassified field must block qualification');
      assert.match(String(result.facts.completion.reason), /unclassified argument field/u, 'the structural shape violation stays');
      // Privacy: neither the returned evidence, nor the mapped facts, nor the
      // persisted record may contain the canary from the extra field.
      const serializedEvidence = JSON.stringify(result);
      const facts = mapShellWaitLiveFacts(mappingInput, earlyExitHeld, result, '0.160.1', null, mappingFixture, rollouts, []);
      const serializedFacts = JSON.stringify(facts);
      assert.equal(serializedEvidence.includes(CANARY_TASK), false, 'the extra field content must be withheld from evidence');
      assert.equal(serializedFacts.includes(CANARY_TASK), false, 'the extra field content must be withheld from the mapped facts');
      const record = await runShellWaitCase({ ...mappingInput, codexBinary: process.execPath, output: root }, {
        createFixture: async () => ({ ...mappingFixture, dispose: async () => {} }),
        executeLiveCase: async () => facts,
      });
      assert.equal(JSON.stringify(record).includes(CANARY_TASK), false, 'the extra field content must be withheld from the persisted record');
      const written = JSON.parse(await readFile(join(root, 'rescue-noise.record.json'), 'utf8'));
      assert.equal(JSON.stringify(written).includes(CANARY_TASK), false, 'the written record must never contain the canary');
      assert.equal(written.inconclusive !== null && written.inconclusive !== undefined, true, 'the rejected poll keeps an explicit inconclusive reason');
    });

    test('preparation privacy: a terminal error echo suppresses canary output in the mismatch excerpt and record', async (t) => {
      const root = await mkdtemp(join(tmpdir(), 'shell-wait-preparation-privacy-'));
      t.after(() => rm(root, { recursive: true, force: true }));
      const rollouts = qualifiedPrivacyRollouts();
      rollouts[1][4] = callOutput('poll-1', completedOutput({ output: `ERROR: rejected task ${CANARY_CAPABILITY} for budget`, exit_code: 1, session_id: HANDLE }));
      const result = inspectShellWaitEvidence(evidenceInput(rollouts));
      assert.equal(result.status, 'supported');
      assert.equal(result.facts.completion.qualified, false, 'the sentinel mismatch still blocks qualification');
      assert.equal(result.facts.completion.processExit, 1, 'the error exit status stays a structural fact');
      assert.equal(result.facts.completion.publicResultMatched, false, 'the sentinel-presence computation is unchanged');
      const excerpt = result.facts.completion.terminalStdoutExcerpt;
      assert.ok(excerpt, 'the mismatch marker must survive');
      assert.equal(excerpt.suppressed, true, 'the unclassified output body is withheld');
      assert.equal(excerpt.text, undefined, 'no terminal output text may be persisted');
      assert.equal(excerpt.processExit, 1, 'the exit status stays on the marker');
      assert.equal(excerpt.sentinelPresent, false, 'the sentinel-absent boolean stays');
      assert.ok(excerpt.outputBytes > 0, 'the withheld output keeps only its size');
      const serializedEvidence = JSON.stringify(result);
      const facts = mapShellWaitLiveFacts(mappingInput, earlyExitHeld, result, '0.160.1', null, mappingFixture, rollouts, []);
      const serializedFacts = JSON.stringify(facts);
      assert.equal(serializedEvidence.includes(CANARY_CAPABILITY), false, 'the terminal error echo must be withheld from evidence');
      assert.equal(serializedFacts.includes(CANARY_CAPABILITY), false, 'the terminal error echo must be withheld from the mapped facts');
      const record = await runShellWaitCase({ ...mappingInput, codexBinary: process.execPath, output: root }, {
        createFixture: async () => ({ ...mappingFixture, dispose: async () => {} }),
        executeLiveCase: async () => facts,
      });
      assert.equal(JSON.stringify(record).includes(CANARY_CAPABILITY), false, 'the terminal error echo must be withheld from the persisted record');
      const written = JSON.parse(await readFile(join(root, 'rescue-noise.record.json'), 'utf8'));
      assert.equal(JSON.stringify(written).includes(CANARY_CAPABILITY), false, 'the written record must never contain the canary');
    });

    test('preparation privacy: workdir and foreign cell_id values never reach excerpts, mapping, or the record', async (t) => {
      const root = await mkdtemp(join(tmpdir(), 'shell-wait-preparation-privacy-'));
      t.after(() => rm(root, { recursive: true, force: true }));
      const canaryPathSuffix = `${CANARY_TASK}_PRIVATE_7492`;
      const redactionRoot = '/private/tmp/privacy-fixture-root';
      // (a) a launch workdir suffix under a redacted fixture root: string type
      // is not authorization — only a validated fixture-location marker is
      // retained, never the path or its tail.
      const workdirRollouts = qualifiedPrivacyRollouts();
      workdirRollouts[1][1] = wrappedCall('exec_command', 'launch-1', { cmd: LAUNCHER, workdir: `${redactionRoot}/${canaryPathSuffix}` });
      const workdirResult = inspectShellWaitEvidence(evidenceInput(workdirRollouts, { redactions: [redactionRoot] }));
      assert.equal(workdirResult.status, 'supported');
      assert.equal(workdirResult.facts.completion.qualified, true, 'a workdir suffix alone must not change the verdict');
      const workdirSerialized = JSON.stringify(workdirResult);
      assert.equal(workdirSerialized.includes(canaryPathSuffix), false, 'the workdir suffix must be withheld from evidence');
      assert.match(workdirSerialized, /<fixture-root>/u, 'a validated fixture-location marker is retained instead');
      const unclassifiedResult = inspectShellWaitEvidence(evidenceInput(workdirRollouts));
      const unclassifiedSerialized = JSON.stringify(unclassifiedResult);
      assert.equal(unclassifiedSerialized.includes(canaryPathSuffix), false, 'an unrecognized workdir tail must still be withheld');
      assert.match(unclassifiedSerialized, /<unclassified-path>/u, 'an unrecognized workdir degrades to a fixed marker');
      // (b) a short foreign cell_id carrying the canary: only its length is a
      // safe fact.
      const foreignRollouts = qualifiedPrivacyRollouts();
      foreignRollouts[1][4] = callOutput('poll-1', pendingOutput('cell-7'));
      foreignRollouts[1].push(fnCall('wait', 'outer-1', { session_id: HANDLE, cell_id: `${CANARY_CAPABILITY}-FOREIGN` }));
      foreignRollouts[1].push(fnOutput('outer-1', completedOutput({ output: SENTINEL, exit_code: 0 })));
      const foreignResult = inspectShellWaitEvidence(evidenceInput(foreignRollouts));
      assert.equal(foreignResult.status, 'supported');
      assert.equal(foreignResult.facts.completion.qualified, false, 'the foreign reference still blocks qualification');
      const foreignSerialized = JSON.stringify(foreignResult);
      assert.equal(foreignSerialized.includes(CANARY_CAPABILITY), false, 'the foreign cell reference value must be withheld from evidence');
      assert.match(foreignSerialized, /cell_id\\?":\{\\?"length\\?":\d+\}/u, 'only the reference length is retained');
      const facts = mapShellWaitLiveFacts(mappingInput, earlyExitHeld, foreignResult, '0.160.1', null, mappingFixture, foreignRollouts, []);
      assert.equal(JSON.stringify(facts).includes(CANARY_CAPABILITY), false, 'the reference value must be withheld from the mapped facts');
      const record = await runShellWaitCase({ ...mappingInput, codexBinary: process.execPath, output: root }, {
        createFixture: async () => ({ ...mappingFixture, dispose: async () => {} }),
        executeLiveCase: async () => facts,
      });
      assert.equal(JSON.stringify(record).includes(CANARY_CAPABILITY), false, 'the reference value must be withheld from the persisted record');
      const written = JSON.parse(await readFile(join(root, 'rescue-noise.record.json'), 'utf8'));
      assert.equal(JSON.stringify(written).includes(CANARY_CAPABILITY), false, 'the written record must never contain the canary');
    });

    test('preparation privacy: overlong canonical and conflicting alias references leak no values through reasons or the record', async (t) => {
      const root = await mkdtemp(join(tmpdir(), 'shell-wait-preparation-privacy-'));
      t.after(() => rm(root, { recursive: true, force: true }));
      // (a) an overlong foreign canonical cell_id carrying the canary: the
      // linkage violation keeps only the length classification, and this path
      // bypasses both the excerpt bound and path scrubbing.
      const overlongRollouts = qualifiedPrivacyRollouts();
      overlongRollouts[1][4] = callOutput('poll-1', pendingOutput('cell-7'));
      overlongRollouts[1].push(fnCall('wait', 'outer-1', { session_id: HANDLE, cell_id: `${'x'.repeat(140)} ${CANARY_TASK}` }));
      overlongRollouts[1].push(fnOutput('outer-1', completedOutput({ output: SENTINEL, exit_code: 0 })));
      const overlongResult = inspectShellWaitEvidence(evidenceInput(overlongRollouts));
      assert.equal(overlongResult.status, 'supported');
      assert.equal(overlongResult.facts.completion.qualified, false, 'the foreign canonical still blocks qualification');
      const overlongReason = String(overlongResult.facts.completion.reason);
      assert.match(overlongReason, /canonical cell_id withheld: 1\d\d character/u, 'the length classification stays');
      assert.equal(overlongReason.includes(CANARY_TASK), false, 'the overlong reference value must never be quoted into a reason');
      assert.equal(JSON.stringify(overlongResult).includes(CANARY_TASK), false, 'the overlong reference value must be withheld from evidence');
      // (b) a conflicting id alias carrying the canary while the canonical
      // matches: the conflict reason keeps field names and lengths only.
      const aliasRollouts = qualifiedPrivacyRollouts();
      aliasRollouts[1][4] = callOutput('poll-1', pendingOutput('cell-7'));
      aliasRollouts[1].push(fnCall('wait', 'outer-1', { session_id: HANDLE, cell_id: 'cell-7', id: `ALIAS ${CANARY_TASK}` }));
      aliasRollouts[1].push(fnOutput('outer-1', completedOutput({ output: SENTINEL, exit_code: 0 })));
      const aliasResult = inspectShellWaitEvidence(evidenceInput(aliasRollouts));
      assert.equal(aliasResult.status, 'supported');
      assert.equal(aliasResult.facts.completion.qualified, false, 'the conflicting alias still blocks qualification');
      const aliasReason = String(aliasResult.facts.completion.reason);
      assert.match(aliasReason, /withheld a non-matching value of \d+ character/u, 'the alias length classification stays');
      assert.equal(aliasReason.includes(CANARY_TASK), false, 'the alias value must never be quoted into a reason');
      assert.equal(JSON.stringify(aliasResult).includes(CANARY_TASK), false, 'the alias value must be withheld from evidence');
      const facts = mapShellWaitLiveFacts(mappingInput, earlyExitHeld, aliasResult, '0.160.1', null, mappingFixture, aliasRollouts, []);
      assert.equal(JSON.stringify(facts).includes(CANARY_TASK), false, 'the alias value must be withheld from mapped reasons');
      const record = await runShellWaitCase({ ...mappingInput, codexBinary: process.execPath, output: root }, {
        createFixture: async () => ({ ...mappingFixture, dispose: async () => {} }),
        executeLiveCase: async () => facts,
      });
      assert.equal(JSON.stringify(record).includes(CANARY_TASK), false, 'the alias value must be withheld from the persisted record');
      const written = JSON.parse(await readFile(join(root, 'rescue-noise.record.json'), 'utf8'));
      assert.equal(JSON.stringify(written).includes(CANARY_TASK), false, 'the written record must never contain the canary');
    });

    test('preparation privacy: out-of-schema and unknown-tool numeric values never reach excerpts, mapping, or the record', async (t) => {
      const root = await mkdtemp(join(tmpdir(), 'shell-wait-preparation-privacy-'));
      t.after(() => rm(root, { recursive: true, force: true }));
      // (a) an UNKNOWN tool carrying a schema-shaped numeric field: unknown
      // tools project nothing — structural counts only.
      const unknownRollouts = qualifiedPrivacyRollouts();
      unknownRollouts[1].push(fnCall('shell', 'unknown-1', { max_output_tokens: 74923411 }));
      const unknownResult = inspectShellWaitEvidence(evidenceInput(unknownRollouts));
      assert.equal(unknownResult.status, 'supported');
      assert.equal(unknownResult.facts.completion.qualified, false, 'the unknown tool call still blocks qualification');
      const unknownSerialized = JSON.stringify(unknownResult);
      assert.equal(unknownSerialized.includes('74923411'), false, 'the unknown-tool numeric value must be withheld from evidence');
      assert.match(unknownSerialized, /withheldArgumentFields\\?":1/u, 'the dropped field is counted');
      // (b) the EXACT launcher launch carrying an out-of-schema numeric field:
      // per-tool schema gates projection before any value is copied.
      const launchRollouts = qualifiedPrivacyRollouts();
      launchRollouts[1][1] = wrappedCall('exec_command', 'launch-1', { cmd: LAUNCHER, workdir: '/installed/workspace', session_id: 74923411 });
      const launchResult = inspectShellWaitEvidence(evidenceInput(launchRollouts));
      assert.equal(launchResult.status, 'supported');
      assert.equal(launchResult.facts.completion.qualified, false, 'the out-of-schema launch field still blocks qualification');
      const launchSerialized = JSON.stringify(launchResult);
      assert.equal(launchSerialized.includes('74923411'), false, 'the out-of-schema numeric value must be withheld from evidence');
      assert.match(launchSerialized, /withheldArgumentFields\\?":1/u, 'the out-of-schema field is counted');
      // end to end for (b): mapping and the persisted record
      const facts = mapShellWaitLiveFacts(mappingInput, earlyExitHeld, launchResult, '0.160.1', null, mappingFixture, launchRollouts, []);
      assert.equal(JSON.stringify(facts).includes('74923411'), false, 'the out-of-schema numeric value must be withheld from the mapped facts');
      const record = await runShellWaitCase({ ...mappingInput, codexBinary: process.execPath, output: root }, {
        createFixture: async () => ({ ...mappingFixture, dispose: async () => {} }),
        executeLiveCase: async () => facts,
      });
      assert.equal(JSON.stringify(record).includes('74923411'), false, 'the out-of-schema numeric value must be withheld from the persisted record');
      const written = JSON.parse(await readFile(join(root, 'rescue-noise.record.json'), 'utf8'));
      assert.equal(JSON.stringify(written).includes('74923411'), false, 'the written record must never contain the canary');
    });

    test('preparation privacy: wall time is extracted only from trusted host headers, never withheld stdout', () => {
      // (a) no header at all: a terminal error whose result body carries
      // timing-shaped private text must produce no wall time and no retention.
      const noHeaderRollouts = qualifiedPrivacyRollouts();
      noHeaderRollouts[1][4] = callOutput('poll-1', completedOutput({ output: `ERROR: rejected task ${CANARY_CAPABILITY} Wall time: ${CANARY_PIN} seconds`, exit_code: 1, session_id: HANDLE }));
      const noHeaderResult = inspectShellWaitEvidence(evidenceInput(noHeaderRollouts));
      assert.equal(noHeaderResult.status, 'supported');
      assert.equal(noHeaderResult.facts.completion.decisiveWallMs, null, 'no trusted header means no wall time');
      assert.equal(noHeaderResult.facts.observations.decisiveWallMs, null, 'the fabricated duration must not feed the observations');
      assert.equal(JSON.stringify(noHeaderResult).includes('74923411'), false, 'the private timing-shaped number must be withheld');
      // (b) a timing-shaped FIRST item that matches neither pinned framing
      // (no colon form, no status/Output: framing) is untrusted.
      const malformedRollouts = qualifiedPrivacyRollouts();
      malformedRollouts[1][4] = callOutput('poll-1', [
        { type: 'input_text', text: `Wall time ${CANARY_PIN} seconds\n` },
        { type: 'input_text', text: JSON.stringify({ output: SENTINEL, exit_code: 0, session_id: HANDLE }) },
      ]);
      const malformedResult = inspectShellWaitEvidence(evidenceInput(malformedRollouts));
      assert.equal(malformedResult.facts.completion.decisiveWallMs, null, 'an unframed timing line is not a trusted header');
      assert.equal(JSON.stringify(malformedResult).includes('74923411'), false, 'the unframed timing number must be withheld');
    });

    test('preparation privacy: inherited schema property names as tool names stay structural and never crash adjudication', () => {
      // `SANCTIONED_CALL_FIELDS` is a lookup table keyed by tool name; a
      // hostile call NAMED like an inherited Object.prototype property
      // (constructor/__proto__/toString/hasOwnProperty) must resolve no
      // schema, keep the structural unsupported-tool fact, withhold its
      // arguments, and complete adjudication — never throw.
      for (const hostileTool of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
        const rollouts = qualifiedPrivacyRollouts();
        rollouts[1].push(fnCall(hostileTool, `hostile-${hostileTool}`, { max_output_tokens: 74923411 }));
        const result = inspectShellWaitEvidence(evidenceInput(rollouts));
        assert.equal(result.status, 'supported', `a ${hostileTool}-named call must be adjudicated, not abort`);
        assert.equal(result.facts.completion.qualified, false, 'the unsupported tool call still blocks qualification');
        const reason = String(result.facts.completion.reason);
        assert.match(reason, /unsupported tool call\(s\) in the child rollout with withheld unclassified tool name\(s\)/u, 'the structural unsupported-tool fact stays');
        assert.equal(reason.includes(hostileTool), false, 'the hostile tool name itself stays withheld');
        const serialized = JSON.stringify(result);
        assert.equal(serialized.includes('74923411'), false, 'the hostile call arguments must be withheld');
        assert.match(serialized, /withheldArgumentFields\\?":1/u, 'the unknown-tool projection counts its fields');
      }
    });

    test('preparation privacy: deeply nested non-string bodies degrade to structural facts without aborting', () => {
      // A ~10,001-level-deep object: JSON.stringify throws RangeError on it,
      // and serialization used to run OUTSIDE the suppression helper's try —
      // aborting adjudication instead of producing structural facts.
      let deep = { pin: 74923411 };
      for (let depth = 0; depth < 10_000; depth += 1) deep = { nested: deep };
      // (a) non-string custom_tool_call input
      const cellRollouts = [[meta(PARENT)], [childMeta(),
        { type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'deep-1', input: deep } }]];
      const cellResult = inspectShellWaitEvidence(evidenceInput(cellRollouts));
      assert.equal(cellResult.status, 'inconclusive', 'the malformed body stays inconclusive without aborting');
      assert.equal(cellResult.inconclusive.reason, 'unsupported-call-shape');
      assert.equal(cellResult.inconclusive.manualAdjudicationRequired, true);
      assert.match(cellResult.inconclusive.excerpt.text, /"bodyType":"object"/u, 'a non-string body keeps a fixed type classification');
      assert.match(cellResult.inconclusive.excerpt.text, /"inputBytes":null/u, 'no size fact exists without serialization');
      assert.equal(cellResult.inconclusive.excerpt.text.includes('nested'), false, 'no structural walk of the withheld body');
      assert.equal(JSON.stringify(cellResult).includes('74923411'), false, 'the deep value must be withheld');
      // (b) non-string direct function-call arguments (the JSON.parse
      // coercion path reaches the same structural helper).
      const argsRollouts = [[meta(PARENT)], [childMeta(),
        { type: 'response_item', payload: { type: 'function_call', name: 'write_stdin', call_id: 'deep-2', arguments: deep } }]];
      const argsResult = inspectShellWaitEvidence(evidenceInput(argsRollouts));
      assert.equal(argsResult.status, 'inconclusive', 'the malformed arguments stay inconclusive without aborting');
      assert.equal(argsResult.inconclusive.reason, 'unsupported-call-shape');
      assert.match(argsResult.inconclusive.detail, /non-string/u, 'a non-string arguments object takes the non-string classification');
      assert.match(argsResult.inconclusive.excerpt.text, /"bodyType":"object"/u);
      assert.match(argsResult.inconclusive.excerpt.text, /"inputBytes":null/u);
      assert.equal(JSON.stringify(argsResult).includes('74923411'), false, 'the deep value must be withheld');
    });

    test('preparation privacy: non-string function-call arguments are structurally suppressed, never coerced', () => {
      // JSON.parse coerces arrays via toString: a single-element (or nested)
      // array of JSON text used to parse into a SUPPORTED call and even
      // qualify completion with its numeric payload retained.
      const innerJson = JSON.stringify({ session_id: HANDLE, chars: '', max_output_tokens: 74923411 });
      const hostileArgumentBodies = [[innerJson], [[innerJson]]];
      for (const argumentBody of hostileArgumentBodies) {
        const rollouts = [[meta(PARENT)], [childMeta(),
          { type: 'response_item', payload: { type: 'function_call', name: 'write_stdin', call_id: 'coerce-1', arguments: argumentBody } }]];
        const result = inspectShellWaitEvidence(evidenceInput(rollouts));
        assert.equal(result.status, 'inconclusive', 'a non-string arguments body must stay inconclusive, never coerced');
        assert.equal(result.inconclusive.reason, 'unsupported-call-shape');
        assert.match(result.inconclusive.detail, /non-string/u, 'the type violation keeps its own classification');
        assert.equal(result.inconclusive.manualAdjudicationRequired, true);
        assert.match(result.inconclusive.excerpt.text, /"bodyType":"array"/u, 'the body keeps only its type classification');
        assert.equal(result.inconclusive.excerpt.text.includes('session_id'), false, 'no coercion into supported arguments');
        assert.equal(JSON.stringify(result).includes('74923411'), false, 'the coerced numeric payload must be withheld');
        assert.equal(JSON.stringify(result).includes('"session_id"'), false, 'no supported-argument values may survive coercion');
      }
    });

    test('preparation privacy: sanctioned native wait options keep linked continuations qualified', () => {
      // Verified at the pinned source (67727e7c, codex-rs/core/src/tools/
      // code_mode/wait_spec.rs): the native wait tool accepts max_tokens
      // (number) and terminate (boolean — true stops the running cell)
      // alongside cell_id/yield_time_ms, so correctly linked continuations
      // carrying them must stay qualified and keep the terminate value
      // visible as a structural fact.
      for (const [extra, terminate] of [[{ max_tokens: 1000 }, null], [{ terminate: false }, false], [{ terminate: true }, true]]) {
        const rollouts = qualifiedPrivacyRollouts();
        rollouts[1][4] = callOutput('poll-1', pendingOutput('cell-7'));
        rollouts[1].push(fnCall('wait', 'outer-1', { session_id: HANDLE, cell_id: 'cell-7', ...extra }));
        rollouts[1].push(fnOutput('outer-1', completedOutput({ output: SENTINEL, exit_code: 0, session_id: HANDLE })));
        const result = inspectShellWaitEvidence(evidenceInput(rollouts));
        assert.equal(result.status, 'supported');
        assert.equal(result.facts.completion.qualified, true, `a linked continuation with ${JSON.stringify(extra)} must stay qualified`);
        const serialized = JSON.stringify(result);
        assert.equal(serialized.includes('unclassified argument field'), false, 'a sanctioned option is not an unclassified field');
        if ('max_tokens' in extra) assert.match(serialized, /max_tokens\\?":1000/u, 'the sanctioned numeric option stays visible');
        if (terminate !== null) {
          assert.match(serialized, new RegExp(`terminate\\\\?":${terminate}`), 'the terminate value stays a visible structural fact');
        }
      }
    });

    test('preparation privacy: native exec options keep launches qualified and stay structurally projected', () => {
      // Verified at the pinned source (67727e7c, codex-rs/core/src/tools/
      // handlers/shell_spec.rs + handlers/unified_exec/exec_command.rs): the
      // native exec schema carries tty/login (booleans), shell (a shell-binary
      // path string), environment_id, and timeout_ms alongside
      // cmd/workdir/yield_time_ms/max_output_tokens.
      const nativeOptions = { workdir: '/installed/workspace', tty: false, login: false, shell: '/bin/bash' };
      for (const [label, launch] of [
        ['direct', fnCall('exec_command', 'launch-1', { cmd: LAUNCHER, ...nativeOptions })],
        ['wrapped', wrappedCall('exec_command', 'launch-1', { cmd: LAUNCHER, ...nativeOptions })],
      ]) {
        const rollouts = qualifiedPrivacyRollouts();
        rollouts[1][1] = launch;
        const result = inspectShellWaitEvidence(evidenceInput(rollouts));
        assert.equal(result.status, 'supported');
        assert.equal(result.facts.completion.qualified, true, `a launch with native exec options (${label}) must stay qualified`);
        const serialized = JSON.stringify(result);
        assert.equal(serialized.includes('unclassified argument field'), false, 'a sanctioned native option is not an unclassified field');
        assert.match(serialized, /tty\\?":false/u, 'the carried boolean option stays a visible structural fact');
        assert.match(serialized, /login\\?":false/u, 'the carried boolean option stays a visible structural fact');
        assert.equal(serialized.includes('/bin/bash'), false, 'the shell path content must be withheld');
        assert.match(serialized, /shell\\?":\{\\?"suppressed/u, 'the shell path keeps only its suppression marker and length');
      }
    });

    test('preparation privacy: pinned code-mode overhead headers keep the decisive wall time', () => {
      // Verified at the pinned source (67727e7c, output_tests.rs): when
      // experimental_show_cell_overhead is enabled the code-mode header
      // appends ` (code-mode N seconds; overhead N seconds)` — overhead may
      // be zero or negative. Only the total wall time is retained.
      const headerWith = (suffix) => `running\nWall time 1.250 seconds${suffix}\nOutput:\n`;
      for (const [suffix, expectedMs] of [
        [' (code-mode 0.750 seconds; overhead 0.500 seconds)', 1250],
        [' (code-mode 0.000 seconds; overhead 1.250 seconds)', 1250],
        [' (code-mode 1.251 seconds; overhead -0.001 seconds)', 1250],
        ['', 1250],
      ]) {
        const rollouts = qualifiedPrivacyRollouts();
        rollouts[1][4] = callOutput('poll-1', [
          { type: 'input_text', text: headerWith(suffix) },
          { type: 'input_text', text: JSON.stringify({ output: SENTINEL, exit_code: 0, session_id: HANDLE }) },
        ]);
        const result = inspectShellWaitEvidence(evidenceInput(rollouts, { workerStillAliveAfterObservation: true, workerDurationMs: 130_000 }));
        assert.equal(result.status, 'supported');
        assert.equal(result.facts.completion.decisiveWallMs, expectedMs, `the pinned header${suffix || ' without suffix'} must keep its total wall time`);
        assert.equal(result.facts.observations.decisiveWallMs, expectedMs);
        assert.equal(result.facts.observations.remainingLifetimeMs, null, 'the retired worker-duration arithmetic never supplies a poll-start lifetime');
      }
    });

    test('preparation privacy: the persisted case record contains no canary on the supported preparation path or the unsupported path', async (t) => {
      const root = await mkdtemp(join(tmpdir(), 'shell-wait-preparation-privacy-'));
      t.after(() => rm(root, { recursive: true, force: true }));
      // SUPPORTED path (R1): the legal observed shape is now the sanctioned
      // one-shot preparation; its private task body must still never reach the
      // persisted record.
      const rollouts = qualifiedPrivacyRollouts();
      rollouts[1].splice(3, 0, canaryPreparationCall());
      const evidence = inspectShellWaitEvidence(evidenceInput(rollouts));
      assert.equal(evidence.status, 'supported');
      const facts = mapShellWaitLiveFacts(mappingInput, earlyExitHeld, evidence, null, null, mappingFixture, rollouts, []);
      const record = await runShellWaitCase({ ...mappingInput, codexBinary: process.execPath, output: root }, {
        createFixture: async () => ({ ...mappingFixture, dispose: async () => {} }),
        executeLiveCase: async () => facts,
      });
      const serializedRecord = JSON.stringify(record);
      for (const canary of [CANARY_TASK, CANARY_PIN, CANARY_ENVELOPE, CANARY_CAPABILITY, CANARY_ECHO]) {
        assert.equal(serializedRecord.includes(canary), false, `the persisted record must never contain ${canary}`);
      }
      const written = JSON.parse(await readFile(join(root, 'rescue-noise.record.json'), 'utf8'));
      assert.equal(written.status, 'executed');
      assert.equal(JSON.stringify(written).includes(CANARY_TASK), false, 'the written record must never contain the canary task body');
      assert.equal(JSON.stringify(written).includes(CANARY_PIN), false, 'the written record must never contain the numeric PIN from task text');
      assert.ok(written.evidence.excerpts.some((entry) => entry.kind === 'rollout-tool-call'
        && JSON.stringify(entry).includes('<private-input>')), 'the supported-path projected excerpt reaches the record with the private frame suppressed');
      // UNSUPPORTED path: a genuinely unclassifiable cell carrying the same
      // canaries still degrades to structural facts only.
      const unsupportedRollouts = [[meta(PARENT)], [childMeta(), unsupportedCanaryCell()]];
      const unsupportedEvidence = inspectShellWaitEvidence(evidenceInput(unsupportedRollouts));
      assert.equal(unsupportedEvidence.status, 'inconclusive');
      assert.equal(unsupportedEvidence.inconclusive.reason, 'unsupported-call-shape');
      const unsupportedFacts = mapShellWaitLiveFacts(mappingInput, earlyExitHeld, unsupportedEvidence, null, null, mappingFixture, unsupportedRollouts, []);
      const unsupportedSerialized = JSON.stringify({ evidence: unsupportedEvidence, facts: unsupportedFacts });
      for (const canary of [CANARY_TASK, CANARY_PIN, CANARY_ECHO]) {
        assert.equal(unsupportedSerialized.includes(canary), false, `the unsupported path must never retain ${canary}`);
      }
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
     * table headers, and every Skill directory the fixture's variant
     * application touches), without launching any host.
     */
    async function fakeInstallPlugin({ codexHome, cleanSource }) {
      const installedRoot = join(codexHome, 'plugins', 'cache', 'vitry', 'zcode', '0.1.0');
      await mkdir(join(installedRoot, 'agents'), { recursive: true });
      await cp(join(cleanSource, 'agents', 'zcode-rescue.toml.template'), join(installedRoot, 'agents', 'zcode-rescue.toml.template'));
      for (const skill of ['rescue', 'review', 'adversarial-review', 'status']) {
        await mkdir(join(installedRoot, 'skills', skill), { recursive: true });
        await cp(join(cleanSource, 'skills', skill, 'SKILL.md'), join(installedRoot, 'skills', skill, 'SKILL.md'));
      }
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

    test('the held turn records its actual timeline on a documented monotonic clock, including a late poll start', async () => {
      // Real short timings on the turn's own monotonic clock (Date.now-based):
      // the launcher is observed at ~60 ms and the poll's first observation at
      // ~180 ms of a hold deadline at observation + 300 ms.
      let resolveResult;
      const result = new Promise((resolve) => { resolveResult = resolve; });
      const realSleep = (ms) => new Promise((resolve2) => setTimeout(resolve2, ms));
      const held = await runHeldHostTurn({
        launch: async () => ({ result, terminate: async () => {} }),
        waitForGate: async () => realSleep(20),
        waitForObservation: async () => realSleep(40),
        // The model calls the tool LATE in the hold: the poll's first
        // observation is detected well after the launcher observation.
        waitForPollStart: async () => realSleep(120),
        captureProcessIdentity: async () => ({ pid: 66126, ppid: 75, nonce: TEST_NONCE, startIdentity: 'start-a' }),
        readProcessIdentity: async () => ({ pid: 66126, ppid: 75, nonce: TEST_NONCE, startIdentity: 'start-a' }),
        waitForProcessExit: async () => {},
        releaseGate: async () => { resolveResult({ code: 0, stdout: 'sentinel', stderr: '' }); },
        holdMs: 300,
        budgetMs: 60_000,
      });
      assert.equal(held.endedBeforeGate, false);
      const timeline = held.timeline;
      assert.ok(timeline, 'the held record must carry its timeline');
      assert.equal(timeline.clock, 'held-turn-monotonic-elapsed-ms', 'the timeline names its documented comparable clock');
      assert.ok(Number.isSafeInteger(timeline.launchedAtElapsedMs) && timeline.launchedAtElapsedMs >= 0, 'the host launch time is measured');
      assert.ok(timeline.observationDetectedAtElapsedMs >= 15, 'the launcher observation is measured after the gate held');
      // The hold deadline is observation-relative on the same clock; the two
      // adjacent clock reads may round up to 1 ms apart on the fractional
      // monotonic source.
      assert.ok(Math.abs(timeline.holdDeadlineElapsedMs - (timeline.observationDetectedAtElapsedMs + 300)) <= 1,
        'the hold deadline is observation-relative on the same clock');
      assert.ok(timeline.pollStartedAtElapsedMs >= 100
        && timeline.pollStartedAtElapsedMs <= timeline.holdDeadlineElapsedMs,
      'the poll start is measured INSIDE the hold, never derived from a wall-time difference');
      assert.ok(typeof timeline.endedAtElapsedMs === 'number' && timeline.endedAtElapsedMs >= timeline.holdDeadlineElapsedMs, 'the turn end is recorded at or after the hold deadline');
    });

    test('an early host exit records the reached timeline points and leaves the hold facts null', async () => {
      const held = await runHeldHostTurn({
        launch: async () => ({ result: Promise.resolve({ code: 1, stdout: '', stderr: 'early exit' }) }),
        waitForGate: async () => {},
        releaseGate: async () => {},
        sleep: async () => {},
        now: (() => { let value = 0; return () => (value += 500); })(),
        holdMs: 5_000,
        budgetMs: 60_000,
      });
      assert.equal(held.endedBeforeGate, true);
      assert.equal(held.timeline.clock, 'held-turn-monotonic-elapsed-ms');
      assert.equal(held.timeline.launchedAtElapsedMs, 500, 'the launch time is known');
      assert.equal(held.timeline.observationDetectedAtElapsedMs, null, 'the launcher was never observed');
      assert.equal(held.timeline.holdDeadlineElapsedMs, null, 'the hold never started');
      assert.equal(held.timeline.pollStartedAtElapsedMs, null);
      assert.equal(typeof held.timeline.endedAtElapsedMs, 'number');
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

    test('Task 4 terminal mismatch withholds the unclassified stdout body and records its size', () => {
      const rollouts = qualifiedRollouts();
      rollouts[1][4].payload.output[1].text = JSON.stringify({ output: '/private/tmp/secret-home\u0000' + 'x'.repeat(3000), exit_code: 0 });
      const facts = mappedEvidence(rollouts);
      assert.equal(facts.hostResult.sentinelMatched, false);
      const excerpt = facts.excerpts.find((entry) => entry.kind === 'terminal-stdout-mismatch');
      assert.ok(excerpt, 'terminal mismatch marker must survive mapping');
      assert.equal(excerpt.suppressed, true, 'the unclassified terminal output body is withheld');
      assert.equal(excerpt.text, undefined, 'no terminal output text may be persisted');
      assert.equal(excerpt.processExit, 0, 'the exit status stays on the marker');
      assert.equal(excerpt.sentinelPresent, false, 'the sentinel-absent boolean stays on the marker');
      assert.ok(excerpt.outputBytes > 3000, 'the withheld output keeps only its size');
      assert.doesNotMatch(JSON.stringify(facts), /secret-home|host JSONL/u);
      assert.equal(JSON.stringify(facts).includes('\u0000'), false);
    });

    test('Task 4 altered sentinel bytes fail even when quoted messages contain the original', () => {
      const rollouts = qualifiedRollouts();
      rollouts[1][4].payload.output[1].text = JSON.stringify({ output: SENTINEL.toLowerCase() + '\n', exit_code: 0 });
      rollouts[1].push({ type: 'event_msg', payload: { type: 'agent_message', message: SENTINEL } });
      const facts = mappedEvidence(rollouts);
      assert.equal(facts.hostResult.sentinelMatched, false);
      assert.match(facts.inconclusive.reason, /byte-for-byte/u);
      const excerpt = facts.excerpts.find((entry) => entry.kind === 'terminal-stdout-mismatch');
      assert.ok(excerpt, 'terminal mismatch marker must survive mapping');
      assert.equal(excerpt.sentinelPresent, false, 'the byte-exact presence outcome is preserved as a boolean');
      assert.equal(excerpt.text, undefined, 'the near-miss output body is withheld, not retained');
      assert.equal(excerpt.outputChars, SENTINEL.toLowerCase().length + 1, 'the withheld output keeps only its length');
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

    test('remaining lifetime is hold-deadline-relative at the measured poll start, never worker-duration minus decisive wall time', () => {
      // DELAYED MODEL START: the launcher is observed at elapsed 29000 and the
      // poll's first observation at elapsed 149000 of a 229000 hold deadline.
      // The decisive observation's own tool wall time is only 30000, so the old
      // arithmetic (workerDuration 200000 - decisiveWall 30000 = 170000) would
      // overstate the remaining lifetime by more than the whole true margin.
      const evidence = inspectShellWaitEvidence({
        rollouts: qualifiedRollouts(), zcodeCalls: [{ id: 1, method: 'session/send', params: {} }],
        command: LAUNCHER, publicResult: SENTINEL, workerStillAliveAfterObservation: true,
        observedWallMs: 30_000, workerDurationMs: 200_000, redactions: [],
      });
      const held = {
        ...completedHeld,
        timeline: {
          clock: 'held-turn-monotonic-elapsed-ms',
          launchedAtElapsedMs: 4_000,
          observationDetectedAtElapsedMs: 29_000,
          pollStartedAtElapsedMs: 149_000,
          holdDeadlineElapsedMs: 229_000,
          endedAtElapsedMs: 229_000,
        },
      };
      const facts = mapShellWaitLiveFacts(mappingInput, held, evidence, '0.160.1', null, mappingFixture);
      assert.equal(facts.observations.pollStartedAtElapsedMs, 149_000, 'the measured poll-start elapsed time must be threaded into the record');
      assert.equal(facts.observations.holdDeadlineElapsedMs, 229_000);
      assert.equal(facts.observations.remainingLifetimeMs, 80_000, 'remaining lifetime is the hold deadline minus the measured poll start');
      assert.equal(facts.observations.remainingLifetimeBasis, 'hold-deadline-at-poll-start');
      assert.notEqual(facts.observations.remainingLifetimeMs, 200_000 - 30_000, 'the old worker-duration minus decisive-wall arithmetic must not resurface as poll-start lifetime');
    });

    test('when the poll-start timing cannot be established, remaining lifetime stays null with an unavailable basis', () => {
      const evidence = inspectShellWaitEvidence({
        rollouts: qualifiedRollouts(), zcodeCalls: [{ id: 1, method: 'session/send', params: {} }],
        command: LAUNCHER, publicResult: SENTINEL, workerStillAliveAfterObservation: true,
        observedWallMs: 30_000, workerDurationMs: 200_000, redactions: [],
      });
      const held = {
        ...completedHeld,
        timeline: {
          clock: 'held-turn-monotonic-elapsed-ms',
          launchedAtElapsedMs: 4_000,
          observationDetectedAtElapsedMs: 29_000,
          pollStartedAtElapsedMs: null,
          holdDeadlineElapsedMs: 229_000,
          endedAtElapsedMs: 229_000,
        },
      };
      const facts = mapShellWaitLiveFacts(mappingInput, held, evidence, '0.160.1', null, mappingFixture);
      assert.equal(facts.observations.remainingLifetimeMs, null, 'no measured poll start means no remaining-lifetime claim');
      assert.equal(facts.observations.remainingLifetimeBasis, 'unavailable');
      assert.equal(facts.observations.decisiveWallMs, 30_000, 'the tool-reported decisive wall time stays a separate fact');
    });

    test('the written record persists the hold-deadline-relative timing facts and the unavailable basis', async (t) => {
      const { runShellWaitCase } = await import('../tools/shell-wait-probe/driver.mjs');
      const temporary = await mkdtemp(join(tmpdir(), 'shell-wait-case-timing-'));
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
      const timingLiveFacts = {
        codexVersion: '0.160.1',
        collection: { rolloutCount: 2, childToolCallCount: 2, truncated: false },
        route: { requested: 'rescue-foreground', actual: 'named' },
        hostResult: { exitCode: 0, companionProcessExit: 0, sentinelMatched: true, terminalStdoutChecked: true },
        linkage: { checked: true, childThreadId: 'c', parentThreadId: 'p', companionLaunchCount: 1, companionSendCount: 1, originalHandleChecked: true },
        observations: {
          outerReturns: 0, modelCalls: 2, rootJoins: 1, decisiveWallMs: 30_000,
          pollStartedAtElapsedMs: 149_000, holdDeadlineElapsedMs: 229_000,
          remainingLifetimeMs: 80_000, remainingLifetimeBasis: 'hold-deadline-at-poll-start',
          pendingInnerAtEnd: false,
        },
        interrupt: { requested: false, delivered: null, settled: null, missingPrerequisite: null },
        held: { endedBeforeGate: false, cleanupLabel: 'observation', gateReleased: true },
        excerpts: [],
        inconclusive: null,
      };
      const record = await runShellWaitCase({ ...mappingInput, codexBinary: process.execPath, output }, {
        createFixture: async () => fakeFixture,
        executeLiveCase: async () => timingLiveFacts,
      });
      assert.equal(record.observations.pollStartedAtElapsedMs, 149_000);
      assert.equal(record.observations.holdDeadlineElapsedMs, 229_000);
      assert.equal(record.observations.remainingLifetimeMs, 80_000);
      assert.equal(record.observations.remainingLifetimeBasis, 'hold-deadline-at-poll-start');
      const written = JSON.parse(await readFile(join(output, 'rescue-baseline.record.json'), 'utf8'));
      assert.equal(written.observations.remainingLifetimeBasis, 'hold-deadline-at-poll-start');
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

    test('an early host exit withholds the final-agent-message text and keeps a structural marker', async () => {
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
        rollouts: qualifiedRollouts(), zcodeCalls: [{ id: 1, method: 'session/send' }],
        command: LAUNCHER, publicResult: SENTINEL, workerStillAliveAfterObservation: false, redactions: [],
      });
      const facts = mapShellWaitLiveFacts(mappingInput, earlyHeld, evidence, '0.160.1', null, mappingFixture, rollouts, ['/private/tmp/secret-home']);
      const excerpt = facts.excerpts.find((entry) => entry.kind === 'final-agent-message');
      assert.ok(excerpt, 'the early-exit record must keep the structural final-message marker for adjudication');
      assert.equal(excerpt.suppressed, true, 'assistant text is withheld, never persisted');
      assert.equal(excerpt.text, undefined, 'no assistant text may enter the record');
      assert.ok(excerpt.messageChars > 0, 'the withheld message keeps only its length');
      assert.doesNotMatch(JSON.stringify(facts), /secret-home|unavailable at/u, 'neither the fixture path nor the message body may survive mapping');
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

  describe('status-wait owned-job setup and query-deadline separation (R3)', async () => {
    const { randomUUID } = await import('node:crypto');
    const { realpathSync } = await import('node:fs');
    const { createIdentityStore } = await import('../scripts/lib/identity.mjs');
    const { createStateStore } = await import('../scripts/lib/state.mjs');
    const { parseArgs } = await import('../scripts/lib/args.mjs');
    const { runChild } = await import('./helpers/run-child.mjs');
    const { createShellWaitFixture, reserveOwnedStatusJob } = await import('../tools/shell-wait-probe/fixture.mjs');
    const {
      CODEX_EXEC_COMMON_ARGUMENTS, composeHostLaunchArguments, extractStatusLaunchAcknowledgement, extractStatusQueryJobId,
      parseShellWaitArguments, renderExecResumeLaunch, runShellWaitCase, SHELL_WAIT_CASE_SPECS, shellWaitCaseDefaults,
      statusWaitInvocation, validateStatusWaitFlow,
    } = await import('../tools/shell-wait-probe/driver.mjs');

    const repositorySha = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
    const companionEntry = join(repositoryRoot, 'scripts', 'zcode-companion.mjs');
    const identityModule = join(repositoryRoot, 'scripts', 'lib', 'identity.mjs');
    const QUERY_TIMEOUT_MS = 240_000; // the real Status command contract default (parseStatus)
    const SETUP_TURN_ID = 'r3-status-setup-turn';
    const ACK_JOB_ID = 'aa11bb22cc33dd44ee55ff66aa11bb22cc33dd44ee55ff66aa11bb22cc33dd44';
    const OTHER_JOB_ID = 'bb22cc33dd44ee55ff66aa11bb22cc33dd44ee55ff66aa11bb22cc33dd44ee11';

    /** One rollout whose completed tool output carries `text` (the observed stdout fact). */
    function ackRolloutWithOutput(text, sessionId = 'live-session') {
      return [[
        { type: 'session_meta', payload: { id: sessionId } },
        { type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'ack-1', input: 'const r = await tools.exec_command({"cmd":"node companion"}); text(JSON.stringify(r))\n' } },
        { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'ack-1', output: [{ type: 'input_text', text: 'Script completed\n' }, { type: 'input_text', text: JSON.stringify({ output: text, exit_code: 0, session_id: 7 }) } ] } },
      ]];
    }

    /** The minimal live-facts shape an injected executeLiveCase may return. */
    function liveCaseFactsStub() {
      return {
        codexVersion: null,
        route: { requested: 'status-wait', actual: null },
        hostResult: { exitCode: null, companionProcessExit: null, sentinelMatched: null, terminalStdoutChecked: null, resultCheck: null, resultCheckLabel: null },
        linkage: { checked: null, mode: 'root', rootThreadId: null, childThreadId: null, parentThreadId: null, companionLaunchCount: null, companionSendCount: null, originalHandleChecked: null },
        observations: { outerReturns: null, modelCalls: null, rootJoins: null, decisiveWallMs: null, remainingLifetimeMs: null, pendingInnerAtEnd: null },
        interrupt: { requested: false, delivered: null, settled: null, missingPrerequisite: null },
        held: { endedBeforeGate: null, cleanupLabel: null, gateReleased: null, cleanupErrors: { count: 0, reasons: [] }, processTermination: { verifiedTerminated: null, codexTerminated: null } },
        excerpts: [],
        inconclusive: null,
      };
    }

    /** @param {string} label @param {Record<string, unknown>} overrides */
    function caseInputFor(label, overrides = {}) {
      return {
        case: label, codexBinary: process.execPath, sourceSha: repositorySha, output: '/o',
        workerDurationMs: 130_000, capMs: null, pollMs: 3_600_000, budgetMs: 360_000,
        ...overrides,
      };
    }

    /**
     * The owning-session environment: a real isolated data root and workspace
     * whose caller turn is established by the REAL production SessionStart and
     * UserPromptSubmit hooks (the same entries runIsolatedProductionSetup
     * runs). Nothing here writes binding, authority, or job records by hand.
     */
    async function owningSessionEnvironment(t, { runHooks = true } = {}) {
      const temporary = await mkdtemp(join(tmpdir(), 'shell-wait-status-setup-'));
      t.after(() => rm(temporary, { recursive: true, force: true }));
      const dataRoot = join(temporary, 'data-root');
      const workspace = join(temporary, 'workspace');
      await mkdir(dataRoot, { mode: 0o700 });
      await mkdir(workspace, { recursive: true });
      const canonicalWorkspace = realpathSync.native(workspace);
      const env = { ...process.env, ZCODE_DATA_ROOT: dataRoot };
      const sessionId = randomUUID();
      if (runHooks) {
        const hookInput = (extra) => ({ session_id: sessionId, cwd: workspace, transcript_path: null, model: 'gpt', permission_mode: 'acceptEdits', ...extra });
        for (const [script, extra] of [
          ['session-lifecycle-hook.mjs', { hook_event_name: 'SessionStart', source: 'startup' }],
          ['user-prompt-hook.mjs', { hook_event_name: 'UserPromptSubmit', turn_id: SETUP_TURN_ID, prompt: 'status setup' }],
        ]) {
          const hook = await runChild(process.execPath, [join(repositoryRoot, 'hooks', script)], {
            cwd: canonicalWorkspace, env, ordinaryInput: true, input: hookInput(extra), timeoutMs: 60_000,
          });
          assert.equal(hook.code, 0, `${script} must establish the owning session: ${hook.stderr.slice(0, 300)}`);
        }
      }
      return { temporary, dataRoot, workspace, canonicalWorkspace, env, sessionId };
    }

    test('the setup reserves one actually owned queued job through the production command path and retains its returned ID', async (t) => {
      const context = await owningSessionEnvironment(t);
      const reserved = await reserveOwnedStatusJob({
        companionEntry, identityModule, dataRoot: context.dataRoot, workspace: context.canonicalWorkspace,
        env: context.env, sessionId: context.sessionId, turnId: SETUP_TURN_ID, permissionMode: 'acceptEdits',
        queryTimeoutMs: QUERY_TIMEOUT_MS, task: 'shell-wait-probe-fixture-task',
      });
      // A real reserved identifier shape, never a guessed or manufactured one.
      assert.match(reserved.jobId, /^[a-f0-9]{64}$/u, 'the reservation must return the production job identifier shape');
      assert.equal(reserved.status, 'queued');
      assert.equal(reserved.ownerSessionId, context.sessionId, 'the reservation must name the owning session');
      // The durable record lives in the PRODUCTION store under the fixture's
      // isolated data root, owned by the owning session.
      const store = createStateStore({ dataRoot: context.dataRoot });
      const durable = await store.readJob(context.canonicalWorkspace, reserved.jobId);
      assert.equal(durable.status, 'queued', 'the reserved job must be the held (never claimed) queued record');
      assert.equal(durable.ownerSessionId, context.sessionId, 'the durable record must be owned by the owning session');
      // The job remains held through a bounded observation window: nothing in
      // the setup claims, starts, or settles it.
      await new Promise((resolve) => setTimeout(resolve, 250));
      const after = await store.readJob(context.canonicalWorkspace, reserved.jobId);
      assert.equal(after.status, 'queued', 'the job must remain held (queued) across the observation window');
    });

    test('the Status query deadline expires independently of job completion and the job stays held', async (t) => {
      const context = await owningSessionEnvironment(t);
      const reserved = await reserveOwnedStatusJob({
        companionEntry, identityModule, dataRoot: context.dataRoot, workspace: context.canonicalWorkspace,
        env: context.env, sessionId: context.sessionId, turnId: SETUP_TURN_ID, permissionMode: 'acceptEdits',
        queryTimeoutMs: QUERY_TIMEOUT_MS, task: 'shell-wait-probe-fixture-task',
      });
      const identity = createIdentityStore({ dataRoot: context.dataRoot });
      const token = await identity.createCallerContext({
        sessionId: context.sessionId, turnId: SETUP_TURN_ID, workspace: context.canonicalWorkspace, permissionMode: 'acceptEdits',
      });
      const { runCompanion } = await import('../scripts/zcode-companion.mjs');
      // The REAL Status command contract: --wait with an explicit --timeout-ms
      // expires at the query deadline while the job is not terminal, and the
      // expiry never cancels or settles the job.
      await assert.rejects(
        runCompanion(['status', reserved.jobId, '--wait', '--timeout-ms', '50'], {
          cwd: context.canonicalWorkspace, env: context.env, authorization: { callerContext: token },
        }),
        (error) => error?.code === 'JOB_WAIT_TIMEOUT' && error?.details?.status === 'queued',
        'the production Status wait must reject with its query-timeout error while the job stays non-terminal',
      );
      const store = createStateStore({ dataRoot: context.dataRoot });
      const after = await store.readJob(context.canonicalWorkspace, reserved.jobId);
      assert.equal(after.status, 'queued', 'an expired Status query deadline must leave the job held');
    });

    test('missing ownership fails the setup closed', async (t) => {
      const context = await owningSessionEnvironment(t, { runHooks: false });
      await assert.rejects(
        reserveOwnedStatusJob({
          companionEntry, identityModule, dataRoot: context.dataRoot, workspace: context.canonicalWorkspace,
          env: context.env, sessionId: context.sessionId, turnId: SETUP_TURN_ID, permissionMode: 'acceptEdits',
          queryTimeoutMs: QUERY_TIMEOUT_MS, task: 'shell-wait-probe-fixture-task',
        }),
        /active turn|ownership|caller/i,
        'a session with no recorded owning turn must fail the reservation closed',
      );
      const store = createStateStore({ dataRoot: context.dataRoot });
      const jobs = await store.listJobs(context.canonicalWorkspace).catch(() => []);
      assert.equal(jobs.length, 0, 'a failed ownership setup must have created no job target at all');
    });

    test('a reservation that returns no job target fails the setup closed', async (t) => {
      const context = await owningSessionEnvironment(t);
      // A companion entry that exits cleanly but returns no background
      // acknowledgement: the setup must reject rather than guess an ID.
      const stub = join(context.temporary, 'no-target-companion.mjs');
      await writeFile(stub, 'process.exit(0);\n', 'utf8');
      await assert.rejects(
        reserveOwnedStatusJob({
          companionEntry: stub, identityModule, dataRoot: context.dataRoot, workspace: context.canonicalWorkspace,
          env: context.env, sessionId: context.sessionId, turnId: SETUP_TURN_ID, permissionMode: 'acceptEdits',
          queryTimeoutMs: QUERY_TIMEOUT_MS, task: 'shell-wait-probe-fixture-task',
        }),
        /target|acknowledgement|background/i,
      );
      await assert.rejects(
        reserveOwnedStatusJob({
          companionEntry: join(context.temporary, 'missing-companion.mjs'), identityModule,
          dataRoot: context.dataRoot, workspace: context.canonicalWorkspace, env: context.env,
          sessionId: context.sessionId, turnId: SETUP_TURN_ID, permissionMode: 'acceptEdits',
          queryTimeoutMs: QUERY_TIMEOUT_MS, task: 'shell-wait-probe-fixture-task',
        }),
        /companion|target|reservation/i,
        'a missing production companion entry must fail the setup closed',
      );
    });

    test('the fixture-level owning-session reservation stays an instrument-only test setup, and the live path never requests it', async (t) => {
      const reservationCalls = [];
      const dependencies = () => ({
        buildSnapshot: async ({ output, sourceSha }) => {
          await mkdir(join(output, '.agents', 'plugins'), { recursive: true });
          await writeFile(join(output, '.agents', 'plugins', 'provenance.json'), `${JSON.stringify({ sourceSha })}\n`, 'utf8');
        },
        installPlugin: async ({ codexHome, cleanSource }) => {
          const installedRoot = join(codexHome, 'plugins', 'cache', 'vitry', 'zcode', '0.1.0');
          await mkdir(join(installedRoot, 'agents'), { recursive: true });
          await cp(join(cleanSource, 'agents', 'zcode-rescue.toml.template'), join(installedRoot, 'agents', 'zcode-rescue.toml.template'));
          for (const skill of ['rescue', 'review', 'adversarial-review', 'status']) {
            await mkdir(join(installedRoot, 'skills', skill), { recursive: true });
            await cp(join(cleanSource, 'skills', skill, 'SKILL.md'), join(installedRoot, 'skills', skill, 'SKILL.md'));
          }
          await writeFile(join(codexHome, 'config.toml'), '[plugins."zcode@vitry"]\nenabled = true\n', 'utf8');
          return { pluginVersion: '0.1.0' };
        },
        runSetup: async () => ({ sessionEstablished: true, launcherDescriptorPublished: true, setupAttempts: 1, roleStatus: 'ready', capVerified: null, owningSessionId: 'fixture-owning-session' }),
        reserveStatusJob: async (context) => {
          reservationCalls.push(context);
          return { jobId: 'bb22cc33dd44ee55ff66aa11bb22cc33dd44ee55ff66aa11bb22cc33dd44ee11', status: 'queued', ownerSessionId: context.sessionId };
        },
      });
      const temporary = await mkdtemp(join(tmpdir(), 'shell-wait-status-fixture-'));
      t.after(() => rm(temporary, { recursive: true, force: true }));
      const output = join(temporary, 'output');
      await mkdir(output, { mode: 0o700 });
      const fixture = await createShellWaitFixture({
        sourceRoot: repositoryRoot, sourceSha: repositorySha, codexBinary: process.execPath, output,
        variant: 'candidate', capMs: null, reserveStatusJob: true, statusQueryTimeoutMs: QUERY_TIMEOUT_MS,
      }, dependencies());
      t.after(() => fixture.dispose());
      assert.equal(reservationCalls.length, 1, 'the instrument-level seam must reserve exactly one owned job in the OWNING session');
      assert.equal(reservationCalls[0].sessionId, 'fixture-owning-session', 'the reservation must run in the isolated setup\'s owning session');
      assert.equal(reservationCalls[0].queryTimeoutMs, QUERY_TIMEOUT_MS, 'the reservation context carries the explicit query timeout');
      assert.equal(fixture.statusJob.jobId, 'bb22cc33dd44ee55ff66aa11bb22cc33dd44ee55ff66aa11bb22cc33dd44ee11');
      assert.equal(fixture.record.ownedStatusJob.reserved, true);
      assert.equal(fixture.record.ownedStatusJob.queryTimeoutMs, QUERY_TIMEOUT_MS);
      assert.match(fixture.record.ownedStatusJob.reservedVia, /owning session/i,
        'the record must label the reservation as the owning-session instrument setup, never the live flow');
      assert.match(fixture.record.ownedStatusJob.setupScope, /instrument|test/i,
        'the record must scope the reservation to instrument-level test setup: the LIVE case creates its job inside the live host session');

      // Without the request the seam never runs and no job facts are recorded.
      const reservationCallsBefore = reservationCalls.length;
      const plainOutput = join(temporary, 'output-plain');
      await mkdir(plainOutput, { mode: 0o700 });
      const plain = await createShellWaitFixture({
        sourceRoot: repositoryRoot, sourceSha: repositorySha, codexBinary: process.execPath, output: plainOutput,
        variant: 'baseline', capMs: null,
      }, dependencies());
      t.after(() => plain.dispose());
      assert.equal(reservationCalls.length, reservationCallsBefore, 'a fixture without reserveStatusJob must not reserve any job');
      assert.equal(plain.record.ownedStatusJob ?? null, null);
      assert.equal(plain.statusJob ?? null, null);

      // The request without the explicit timeout is a fail-closed combination.
      const missingTimeoutOutput = join(temporary, 'output-missing-timeout');
      await mkdir(missingTimeoutOutput, { mode: 0o700 });
      await assert.rejects(
        createShellWaitFixture({
          sourceRoot: repositoryRoot, sourceSha: repositorySha, codexBinary: process.execPath, output: missingTimeoutOutput,
          variant: 'candidate', capMs: null, reserveStatusJob: true,
        }, dependencies()),
        /statusQueryTimeoutMs|query timeout/i,
      );
    });

    test('the live status-wait case never requests the fixture reservation: the job is created inside the live host session', async (t) => {
      const temporary = await mkdtemp(join(tmpdir(), 'shell-wait-status-live-'));
      t.after(() => rm(temporary, { recursive: true, force: true }));
      const output = join(temporary, 'output');
      await mkdir(output, { mode: 0o700 });
      const captured = [];
      await runShellWaitCase(caseInputFor('status-wait', { output }), {
        createFixture: async (fixtureInput) => {
          captured.push(fixtureInput);
          return {
            workspace: join(temporary, 'workspace'), codexHome: join(temporary, 'codex-home'),
            installedRoot: join(temporary, 'installed'), env: { HOME: temporary },
            record: { variant: 'candidate', capMs: null, pollMs: 3_600_000, appliedArtifacts: [] },
            dispose: async () => {},
          };
        },
        executeLiveCase: async () => liveCaseFactsStub(),
      });
      assert.equal(captured.length, 1);
      assert.notEqual(captured[0].reserveStatusJob, true,
        'the LIVE path must not use the owning-session fixture reservation: the queried job is created inside the live host session (a fixture-setup session could never own what the live session queries)');
    });

    test('the status-wait case prompt launches the background job inside the live session; the query prompt is built only from the observed acknowledgement', () => {
      const spec = SHELL_WAIT_CASE_SPECS['status-wait'];
      // Turn 1 (recorded launch): the in-session production creator whose
      // acknowledgement carries the job ID (the documented enqueue-only
      // background surface, reachable in the live session).
      assert.match(spec.prompt, /\$zcode:review --background/u,
        'the live session must launch the held job through its own recorded production command');
      assert.match(spec.prompt, /acknowledgement/u, 'the case asks for the exact reserved-job acknowledgement');
      assert.doesNotMatch(spec.prompt, /\$zcode:status/u,
        'turn 1 must not ask for a Status query: the query prompt is built from the OBSERVED acknowledgement ID');
      assert.doesNotMatch(spec.prompt, /[a-f0-9]{64}/u, 'no pre-known job ID may exist in the launch prompt');
      // Turn 2 (built from the observed acknowledgement) stays explicit and fail-closed.
      const jobId = 'aa11bb22cc33dd44ee55ff66aa11bb22cc33dd44ee55ff66aa11bb22cc33dd44';
      const queryPrompt = statusWaitInvocation({ jobId, queryTimeoutMs: 240_000 }).prompt;
      assert.match(queryPrompt, new RegExp(`\\$zcode:status ${jobId} --wait --timeout-ms 240000`));
      assert.doesNotMatch(queryPrompt, /cancel the job|stop the job|terminate the job|\$zcode:cancel/i);
      assert.match(queryPrompt, /without cancelling/i);
    });

    test('the launch acknowledgement job ID is extracted from the observed tool output as a validated fact', async () => {
      const { renderOutput } = await import('../scripts/lib/render.mjs');
      const acknowledgementText = renderOutput({ type: 'background', job: { id: ACK_JOB_ID } });
      assert.match(acknowledgementText, new RegExp(`^Reserved background job ${ACK_JOB_ID}\\.$`, 'm'),
        'the extraction must key on the REAL production acknowledgement render shape');
      const rolloutWithAck = [[
        { type: 'session_meta', payload: { id: 'live-session-1' } },
        { type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'ack-1', input: `const r = await tools.exec_command(${JSON.stringify({ cmd: 'node companion invoke review' })}); text(JSON.stringify(r))\n` } },
        { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'ack-1', output: [{ type: 'input_text', text: 'Script completed\n' }, { type: 'input_text', text: JSON.stringify({ output: acknowledgementText, exit_code: 0, session_id: 7 }) } ] } },
      ]];
      const extracted = extractStatusLaunchAcknowledgement(rolloutWithAck);
      assert.equal(extracted.jobId, ACK_JOB_ID);
      assert.equal(extracted.distinctJobIdCount, 1);
      assert.equal(extracted.launchSessionId, 'live-session-1', 'the acknowledgement-bearing rollout names the launch session');
      // Confirmed absence is null, never a guess.
      assert.deepEqual(extractStatusLaunchAcknowledgement([[{ type: 'session_meta', payload: { id: 's' } }]]),
        { jobId: null, distinctJobIdCount: 0, launchSessionId: null });
      // Two distinct acknowledgement IDs are ambiguous and never resolved by pick-one.
      const ambiguous = extractStatusLaunchAcknowledgement([rolloutWithAck[0], rolloutWithAck[0].map((event, index) => index === 2
        ? { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'ack-2', output: [{ type: 'input_text', text: 'Script completed\n' }, { type: 'input_text', text: JSON.stringify({ output: renderOutput({ type: 'background', job: { id: OTHER_JOB_ID } }), exit_code: 0, session_id: 8 }) } ] } }
        : event)]);
      assert.equal(ambiguous.jobId, null, 'an ambiguous launch acknowledgement must not be resolved by picking one');
      assert.equal(ambiguous.distinctJobIdCount, 2);
      // The acknowledgement inside assistant MESSAGE text is never evidence:
      // message content is suppressed (R0) and must not become an extracted fact.
      const quotedOnly = extractStatusLaunchAcknowledgement([[
        { type: 'session_meta', payload: { id: 's' } },
        { type: 'event_msg', payload: { type: 'agent_message', message: `I ran it: ${acknowledgementText}` } },
      ]]);
      assert.equal(quotedOnly.jobId, null, 'a message-quoted acknowledgement is not an observed tool-output fact');
      // The rescue queued-acknowledgement shape (render.mjs line 25) extracts too.
      const rescueShape = extractStatusLaunchAcknowledgement(ackRolloutWithOutput(`Rescue job ${ACK_JOB_ID} queued for background execution.\nCheck progress with $zcode:status ${ACK_JOB_ID}; read the final result with $zcode:result ${ACK_JOB_ID}.\n`));
      assert.equal(rescueShape.jobId, ACK_JOB_ID);
    });

    test('the queried job ID is extracted from the observed Status terminal output', async () => {
      const statusOutput = [
        `Job: ${ACK_JOB_ID}`,
        'Command: review',
        'Status: succeeded',
        'Progress:',
        '  - none',
      ].join('\n') + '\n';
      const extracted = extractStatusQueryJobId(ackRolloutWithOutput(statusOutput, 'query-session'));
      assert.equal(extracted.jobId, ACK_JOB_ID);
      assert.equal(extracted.distinctJobIdCount, 1);
      assert.equal(extracted.querySessionId, 'query-session');
      assert.deepEqual(extractStatusQueryJobId([[{ type: 'session_meta', payload: { id: 's' } }]]),
        { jobId: null, distinctJobIdCount: 0, querySessionId: null });
      const ambiguous = extractStatusQueryJobId([
        ...ackRolloutWithOutput(statusOutput, 'query-session'),
        ...ackRolloutWithOutput(`Job: ${OTHER_JOB_ID}\nCommand: review\n`, 'query-session'),
      ]);
      assert.equal(ambiguous.jobId, null, 'two distinct queried job IDs are ambiguous and never resolved by picking one');
      assert.equal(ambiguous.distinctJobIdCount, 2);
    });

    test('the live-flow validation binds the query to the launch: same session, exact ID match, explicit timeout', () => {
      const valid = validateStatusWaitFlow({
        launchSessionId: 'live-session', querySessionId: 'live-session',
        acknowledgementJobId: ACK_JOB_ID, acknowledgementDistinctJobIdCount: 1,
        queriedJobId: ACK_JOB_ID, queriedDistinctJobIdCount: 1, queryTimeoutMs: 240_000,
      });
      assert.equal(valid.valid, true);
      assert.equal(valid.reason, null);
      const rejections = [
        [{ launchSessionId: 'live-session', querySessionId: 'live-session', acknowledgementJobId: null, acknowledgementDistinctJobIdCount: 0, queriedJobId: ACK_JOB_ID, queriedDistinctJobIdCount: 1, queryTimeoutMs: 240_000 }, /no launch acknowledgement|acknowledgement/i],
        [{ launchSessionId: 'live-session', querySessionId: 'live-session', acknowledgementJobId: ACK_JOB_ID, acknowledgementDistinctJobIdCount: 2, queriedJobId: ACK_JOB_ID, queriedDistinctJobIdCount: 1, queryTimeoutMs: 240_000 }, /ambiguous/i],
        [{ launchSessionId: 'live-session', querySessionId: 'live-session', acknowledgementJobId: ACK_JOB_ID, acknowledgementDistinctJobIdCount: 1, queriedJobId: null, queriedDistinctJobIdCount: 0, queryTimeoutMs: 240_000 }, /no queried job|queried/i],
        [{ launchSessionId: 'live-session', querySessionId: 'live-session', acknowledgementJobId: ACK_JOB_ID, acknowledgementDistinctJobIdCount: 1, queriedJobId: OTHER_JOB_ID, queriedDistinctJobIdCount: 1, queryTimeoutMs: 240_000 }, /mismatch|different job/i],
        [{ launchSessionId: 'live-session', querySessionId: 'another-session', acknowledgementJobId: ACK_JOB_ID, acknowledgementDistinctJobIdCount: 1, queriedJobId: ACK_JOB_ID, queriedDistinctJobIdCount: 1, queryTimeoutMs: 240_000 }, /different session|ownership/i],
        [{ launchSessionId: null, querySessionId: 'live-session', acknowledgementJobId: ACK_JOB_ID, acknowledgementDistinctJobIdCount: 1, queriedJobId: ACK_JOB_ID, queriedDistinctJobIdCount: 1, queryTimeoutMs: 240_000 }, /launch session/i],
        [{ launchSessionId: 'live-session', querySessionId: null, acknowledgementJobId: ACK_JOB_ID, acknowledgementDistinctJobIdCount: 1, queriedJobId: ACK_JOB_ID, queriedDistinctJobIdCount: 1, queryTimeoutMs: 240_000 }, /query session/i],
        [{ launchSessionId: 'live-session', querySessionId: 'live-session', acknowledgementJobId: ACK_JOB_ID, acknowledgementDistinctJobIdCount: 1, queriedJobId: ACK_JOB_ID, queriedDistinctJobIdCount: 1, queryTimeoutMs: undefined }, /timeout/i],
      ];
      for (const [input, pattern] of rejections) {
        const result = validateStatusWaitFlow(input);
        assert.equal(result.valid, false, `expected rejection for ${JSON.stringify(input)}`);
        assert.match(result.reason, pattern);
      }
    });

    test('the second turn resumes the SAME observed launch session with the validated invocation', () => {
      const jobId = 'aa11bb22cc33dd44ee55ff66aa11bb22cc33dd44ee55ff66aa11bb22cc33dd44';
      const resume = renderExecResumeLaunch('live-session', statusWaitInvocation({ jobId, queryTimeoutMs: 240_000 }).prompt);
      assert.deepEqual(resume.args.slice(-3), ['resume', 'live-session',
        `The --timeout-ms value in this invocation is the Status query deadline only: if it expires, `
        + `present the timeout output verbatim and end the wait without cancelling, stopping, or re-preparing the job. `
        + `Use the installed skill exactly once now and return only its final public output for the explicitly owned job `
        + `identified in this invocation: $zcode:status ${jobId} --wait --timeout-ms 240000`],
        'the resume argv must name the observed launch session and carry the explicit query invocation');
      assert.throws(() => renderExecResumeLaunch('', 'prompt'), /session/i, 'a missing launch session must be refused');
      assert.throws(() => renderExecResumeLaunch('live-session', undefined), /prompt|invocation/i);
    });

    test('the turn-2 argv composes the resume subcommand into the common exec argv EXACTLY once (every token asserted)', () => {
      const jobId = 'aa11bb22cc33dd44ee55ff66aa11bb22cc33dd44ee55ff66aa11bb22cc33dd44';
      const queryPrompt = statusWaitInvocation({ jobId, queryTimeoutMs: 240_000 }).prompt;
      const resume = renderExecResumeLaunch('live-session', queryPrompt);
      // The resume arguments carry ONLY the subcommand tokens: runTurn already
      // supplies the common exec argv, so any duplication here would produce
      // `codex exec … exec … resume …` and the subcommand could never parse.
      assert.deepEqual(resume.args, ['resume', 'live-session', queryPrompt]);
      // The FULL turn-2 argv through runTurn's composition shape, every token.
      const composed = composeHostLaunchArguments(resume.args, '/live/workspace');
      assert.deepEqual(composed, [...CODEX_EXEC_COMMON_ARGUMENTS, '-C', '/live/workspace', 'resume', 'live-session', queryPrompt]);
      assert.equal(composed.filter((token) => token === 'exec').length, 1,
        'the exec subcommand must appear exactly once: a second literal `exec` consumes the PROMPT positional and `resume` is never reached');
      assert.equal(composed.indexOf('resume'), composed.indexOf('-C') + 2,
        'the resume subcommand must be the first token after the common flags and workspace so clap matches it');
      assert.throws(() => composeHostLaunchArguments('resume', '/ws'), /prompt arguments/i);
      assert.throws(() => composeHostLaunchArguments(['p'], ''), /workspace/i);
    });

    test('an invalid observed status-wait flow is inconclusive and the statusQuery facts land in the persisted record', async (t) => {
      const { mapShellWaitLiveFacts } = await import('../tools/shell-wait-probe/driver.mjs');
      const { renderOutput } = await import('../scripts/lib/render.mjs');
      const qualifiedRootEvidence = {
        status: 'supported',
        facts: {
          completion: { qualified: true, processExit: 0, publicResultMatched: true, decisiveEnd: 'process-exit' },
          linkage: { checked: true, exact: true, agentType: null },
          collection: { rolloutCount: 2, childToolCallCount: 0, truncated: false, excerpts: [] },
          companion: { launchCount: 1, sendCount: 1, duplicateLaunch: false, preLaunchDiagnostics: { excerpts: [], truncated: false } },
          handle: { originalHandleChecked: true },
          observations: { outerReturns: 2, modelCalls: 3, rootJoins: null, decisiveWallMs: 5, pendingInnerAtEnd: false },
        },
      };
      const held = {
        endedBeforeGate: false, budgetExpired: false, identity: {}, processAliveWhileHeld: true,
        result: { code: 0, stdout: '', stderr: '' },
        cleanup: { label: 'observation', releasedGate: true, verifiedProcessTerminated: true, codexTerminated: true, nativeInterruptionClaimed: false, errors: [] },
        timeline: null,
      };
      const mappingFixtureLike = () => ({
        workspace: '/private/tmp/r3-status-ws', codexHome: '/private/tmp/r3-status-home',
        installedRoot: '/private/tmp/r3-status-installed', env: { HOME: '/private/tmp/r3-status-home' },
        record: { variant: 'candidate', capMs: null, pollMs: 3_600_000, appliedArtifacts: [] },
      });
      // The observed flow launched ACK_JOB_ID but the Status output carries a
      // DIFFERENT job: the exact-match validation must reject it and the
      // mapping must record the full fact set with an inconclusive verdict.
      const observedRollouts = [
        ...ackRolloutWithOutput(renderOutput({ type: 'background', job: { id: ACK_JOB_ID } }), 'live-session'),
        ...ackRolloutWithOutput([`Job: ${OTHER_JOB_ID}`, 'Command: review', 'Status: succeeded', 'Progress:', '  - none'].join('\n') + '\n', 'live-session'),
      ];
      const facts = mapShellWaitLiveFacts(
        { case: 'status-wait', statusQueryTimeoutMs: 240_000 }, held, qualifiedRootEvidence, null, null, mappingFixtureLike(), observedRollouts, [],
      );
      assert.equal(facts.statusQuery.acknowledgementJobId, ACK_JOB_ID);
      assert.equal(facts.statusQuery.queriedJobId, OTHER_JOB_ID);
      assert.equal(facts.statusQuery.launchSessionId, 'live-session');
      assert.equal(facts.statusQuery.querySessionId, 'live-session');
      assert.equal(facts.statusQuery.queryTimeoutMs, 240_000);
      assert.equal(facts.statusQuery.validation.valid, false);
      assert.match(facts.statusQuery.validation.reason, /different job/i);
      assert.match(facts.inconclusive.reason, /failed its live-session validation/u);
      assert.match(facts.inconclusive.reason, /different job/i);
      // A matching observed flow with the same evidence is NOT inconclusive.
      const matchingRollouts = [
        ...ackRolloutWithOutput(renderOutput({ type: 'background', job: { id: ACK_JOB_ID } }), 'live-session'),
        ...ackRolloutWithOutput([`Job: ${ACK_JOB_ID}`, 'Command: review', 'Status: succeeded', 'Progress:', '  - none'].join('\n') + '\n', 'live-session'),
      ];
      const validFacts = mapShellWaitLiveFacts(
        { case: 'status-wait', statusQueryTimeoutMs: 240_000 }, held, qualifiedRootEvidence, null, null, mappingFixtureLike(), matchingRollouts, [],
      );
      assert.equal(validFacts.statusQuery.validation.valid, true);
      assert.equal(validFacts.inconclusive, null);
      // The mapped facts persist through the case record.
      const temporary = await mkdtemp(join(tmpdir(), 'shell-wait-status-record-'));
      t.after(() => rm(temporary, { recursive: true, force: true }));
      const output = join(temporary, 'output');
      await mkdir(output, { mode: 0o700 });
      const record = await runShellWaitCase(caseInputFor('status-wait', { output }), {
        createFixture: async () => ({
          workspace: join(temporary, 'workspace'), codexHome: join(temporary, 'codex-home'),
          installedRoot: join(temporary, 'installed'), env: { HOME: temporary },
          record: { variant: 'candidate', capMs: null, pollMs: 3_600_000, appliedArtifacts: [] },
          dispose: async () => {},
        }),
        executeLiveCase: async () => facts,
      });
      assert.equal(record.status, 'executed');
      assert.equal(record.statusQuery.acknowledgementJobId, ACK_JOB_ID);
      assert.equal(record.statusQuery.queriedJobId, OTHER_JOB_ID);
      assert.equal(record.statusQuery.validation.valid, false);
      assert.match(record.inconclusive.reason, /failed its live-session validation/u);
    });

    test('the rendered Status invocation embeds the reserved ID and an explicit query timeout, and refuses guessed or missing targets', () => {
      const jobId = 'aa11bb22cc33dd44ee55ff66aa11bb22cc33dd44ee55ff66aa11bb22cc33dd44';
      const rendered = statusWaitInvocation({ jobId, queryTimeoutMs: QUERY_TIMEOUT_MS });
      assert.match(rendered.prompt, new RegExp(`\\$zcode:status ${jobId} --wait --timeout-ms ${QUERY_TIMEOUT_MS}`),
        'the rendered invocation must carry the real owned job ID and the explicit query timeout');
      assert.doesNotMatch(rendered.prompt, /--background|queued/u,
        'the Status invocation never borrows background or queued semantics');
      assert.doesNotMatch(rendered.prompt, /cancel the job|stop the job|terminate the job|\$zcode:cancel/i,
        'the Status invocation is observation-only: it must not instruct any cancellation');
      assert.match(rendered.prompt, /without cancelling/i,
        'the invocation carries the explicit no-cancel rule for an expired query deadline');
      for (const bad of [undefined, '', 'deadbeef', jobId.slice(1), 'A'.repeat(64), `${jobId} `]) {
        assert.throws(() => statusWaitInvocation({ jobId: bad, queryTimeoutMs: QUERY_TIMEOUT_MS }),
          { name: 'TypeError' }, `a guessed or missing job ID (${JSON.stringify(bad)}) must be refused`);
      }
      for (const bad of [undefined, 0, -1, '240000', Number.NaN]) {
        assert.throws(() => statusWaitInvocation({ jobId, queryTimeoutMs: bad }),
          { name: 'TypeError' }, `a missing or invalid query timeout (${String(bad)}) must be refused`);
      }
    });

    test('the Status query prompt is built only from the OBSERVED acknowledgement; the query timeout is independent of the held windows', () => {
      const jobId = 'aa11bb22cc33dd44ee55ff66aa11bb22cc33dd44ee55ff66aa11bb22cc33dd44';
      // The turn-1 launch prompt is the case's constant prompt; the QUERY
      // prompt exists only as the runtime render from the observed
      // acknowledgement ID (statusWaitInvocation) — no pre-known target.
      const launchPrompt = SHELL_WAIT_CASE_SPECS['status-wait'].prompt;
      assert.doesNotMatch(launchPrompt, /[a-f0-9]{64}/u, 'the launch prompt carries no job ID');
      // The explicit Status query deadline is the real command contract default
      // and is independent of the held-turn worker/budget windows. The
      // contract probe itself also proves the explicit-ID requirement: bare
      // `--wait` is rejected by the real parser.
      assert.throws(() => parseArgs(['status', '--wait']), /--wait requires an explicit job ID/u);
      assert.equal(shellWaitCaseDefaults('status-wait').statusQueryTimeoutMs,
        parseArgs(['status', 'a'.repeat(64), '--wait']).options.timeoutMs,
        'the case default query timeout must equal the real Status command contract default');
      const longWindows = statusWaitInvocation({ jobId, queryTimeoutMs: shellWaitCaseDefaults('status-wait').statusQueryTimeoutMs });
      assert.match(longWindows.prompt, /--timeout-ms 240000/u,
        'a long shell observation window must not change the rendered query deadline');
      assert.doesNotMatch(longWindows.prompt, /--timeout-ms 130000|--timeout-ms 360000/u,
        'neither workerDurationMs nor budgetMs may leak into the Status query deadline');
      const explicit = statusWaitInvocation({ jobId, queryTimeoutMs: 5_000 });
      assert.match(explicit.prompt, /--timeout-ms 5000/u, 'an explicit caller query timeout renders verbatim');
      assert.doesNotMatch(explicit.prompt, /240000/u);
    });

    test('the driver accepts an explicit status query timeout option, defaults it to the contract value, and refuses it elsewhere', () => {
      const base = ['--case', 'status-wait', '--codex', process.execPath, '--source-sha', repositorySha, '--output', '/tmp'];
      const defaulted = parseShellWaitArguments(base);
      assert.equal(defaulted.statusQueryTimeoutMs, 240_000);
      const explicit = parseShellWaitArguments([...base, '--status-query-timeout-ms', '5000']);
      assert.equal(explicit.statusQueryTimeoutMs, 5_000);
      for (const invalid of ['0', '-5', 'x', '1.5']) {
        assert.throws(() => parseShellWaitArguments([...base, '--status-query-timeout-ms', invalid]), /status query timeout|positive integer/i);
      }
      assert.throws(
        () => parseShellWaitArguments(['--case', 'rescue-long', '--codex', process.execPath, '--source-sha', repositorySha, '--output', '/tmp', '--status-query-timeout-ms', '5000']),
        /status-wait|status query timeout/i,
        'the Status query timeout option is refused for non-Status cases',
      );
      assert.equal(SHELL_WAIT_CASE_SPECS['status-wait'].companionCommand, 'invoke status',
        'the constant Companion command stays argument-free: the owned ID travels in the recorded invocation, never in the command');
    });

    test('review-wait and adversarial-review-wait stay runnable: no status query timeout is defaulted, and an explicit one is still refused', async () => {
      const previousGate = process.env.ZCODE_SHELL_WAIT_E2E;
      delete process.env.ZCODE_SHELL_WAIT_E2E;
      try {
        for (const label of ['review-wait', 'adversarial-review-wait']) {
          const base = ['--case', label, '--codex', process.execPath, '--source-sha', repositorySha, '--output', '/tmp'];
          // Regression (R2/R3): parsing WITHOUT --status-query-timeout-ms must
          // succeed and must NOT manufacture a statusQueryTimeoutMs — the
          // field is a status-wait-only fact, so a defaulted value trips the
          // fail-closed validation and makes the case unrunnable.
          const parsed = parseShellWaitArguments(base);
          assert.equal(parsed.case, label);
          assert.equal(parsed.workerDurationMs, 130_000);
          assert.equal(parsed.budgetMs, 360_000);
          assert.equal(parsed.statusQueryTimeoutMs, undefined,
            `${label} must default to NO statusQueryTimeoutMs (status-wait-only fact)`);
          // The parsed defaults must be VALID case input: fail-closed
          // validation accepts them and the live gate refuses (never a
          // 'statusQueryTimeoutMs is only valid for the status-wait case' TypeError).
          const record = await runShellWaitCase(parsed, {});
          assert.equal(record.status, 'refused');
          assert.match(String(record.reason), /ZCODE_SHELL_WAIT_E2E=1/);
          // An explicit --status-query-timeout-ms stays rejected fail-closed.
          assert.throws(
            () => parseShellWaitArguments([...base, '--status-query-timeout-ms', '5000']),
            /--status-query-timeout-ms is only valid for the status-wait case/,
            `${label} must still refuse an explicit --status-query-timeout-ms`,
          );
        }
      } finally {
        if (previousGate === undefined) delete process.env.ZCODE_SHELL_WAIT_E2E;
        else process.env.ZCODE_SHELL_WAIT_E2E = previousGate;
      }
      // The status-wait contract default is untouched: 240000, rendered verbatim.
      assert.equal(shellWaitCaseDefaults('status-wait').statusQueryTimeoutMs, 240_000);
      const statusJobId = 'aa11bb22cc33dd44ee55ff66aa11bb22cc33dd44ee55ff66aa11bb22cc33dd44';
      const rendered = statusWaitInvocation({ jobId: statusJobId, queryTimeoutMs: shellWaitCaseDefaults('status-wait').statusQueryTimeoutMs });
      assert.match(rendered.prompt, /--timeout-ms 240000/u, 'the rendered status-wait invocation default stays 240000');
    });
  });

  describe('background placement flow and child-settlement lifecycle (R3)', async () => {
    const { runHeldHostTurn, mapShellWaitLiveFacts, waitForChildSettlementObservation, SHELL_WAIT_CASE_SPECS } = await import('../tools/shell-wait-probe/driver.mjs');

    const TEST_NONCE = 'e'.repeat(64);
    const identity = { pid: 70123, ppid: 91, nonce: TEST_NONCE, startIdentity: 'start-r3' };
    const backgroundMappingInput = {
      case: 'background', codexBinary: '/bin/x', sourceSha: 'a'.repeat(40), output: '/o',
      workerDurationMs: 120_000, capMs: null, pollMs: 3_600_000, budgetMs: 300_000,
    };
    const rescueMappingInput = { ...backgroundMappingInput, case: 'rescue-long' };
    const mappingFixture = {
      workspace: '/private/tmp/r3-ws', codexHome: '/private/tmp/r3-home',
      installedRoot: '/private/tmp/r3-installed', env: { HOME: '/private/tmp/r3-home' },
      record: { variant: 'candidate', capMs: null, pollMs: 3_600_000, appliedArtifacts: [] },
    };
    const qualifiedRescueEvidence = {
      status: 'supported',
      facts: {
        completion: { qualified: true, processExit: 0, publicResultMatched: true, decisiveEnd: 'process-exit' },
        linkage: { checked: true, exact: true, agentType: 'zcode-rescue', childThreadId: 'child-1', parentThreadId: 'parent-1' },
        collection: { rolloutCount: 2, childToolCallCount: 4, truncated: false, excerpts: [] },
        companion: { launchCount: 1, sendCount: 1, duplicateLaunch: false, preLaunchDiagnostics: { excerpts: [], truncated: false } },
        handle: { originalHandleChecked: true },
        // rootJoins 0 (P2-1 round-6): the background no-join contract requires
        // an observed ZERO join count before a settled acknowledgement may
        // drop the early-exit inconclusive.
        observations: { outerReturns: 1, modelCalls: 2, rootJoins: 0, decisiveWallMs: 5, pendingInnerAtEnd: false },
      },
    };

    test('the explicit --background prompt asks for the exact launched-Child acknowledgement, never a queued marker, and Root does not join', () => {
      const spec = SHELL_WAIT_CASE_SPECS.background;
      assert.match(spec.prompt, /--background/u, 'the case must keep the explicit background flag');
      assert.doesNotMatch(spec.prompt, /queued acknowledgement|return only the queued/u,
        'the prompt must not request a queued acknowledgement: queued is the Companion-background branch, not the Host-background branch');
      assert.match(spec.prompt, /launched/u, 'the prompt must request the exact launched-Child acknowledgement');
      assert.match(spec.prompt, /nothing about Companion work|never that Companion work/i,
        'the acknowledgement must claim nothing about Companion work being queued, accepted, started, or completed');
      assert.equal(spec.rootJoinsChild, false, 'a Host-background Root performs no join of the Child');
      assert.doesNotMatch(spec.prompt, /wait for the child|join the child|wait_agent\(/iu,
        'the Root prompt must not instruct a Child join (its wait_agent mention is the negative instruction, never an ask)');
      assert.match(spec.prompt, /[Cc]hild/u);
      assert.match(spec.prompt, /[Ff]oreground Companion|Companion process/u, 'the Child observes its FOREGROUND Companion (the explicit --background mapping), not a detached runner');
      assert.match(spec.prompt, /terminal/u, 'the Child observes the Companion until terminal');
      assert.equal(spec.backgroundFlow, true, 'only the background case drives the child-settlement lifecycle');
    });

    test('the other case placements stay distinct from the background flow', () => {
      for (const label of ['rescue-baseline', 'rescue-long', 'rescue-repeat', 'rescue-noise', 'rescue-interrupt']) {
        const spec = SHELL_WAIT_CASE_SPECS[label];
        assert.equal(spec.rootJoinsChild, true, `${label}: Host-foreground Root joins the exact Child`);
        assert.notEqual(spec.backgroundFlow, true, `${label}: the foreground contract never runs the background settlement lifecycle`);
        assert.match(spec.prompt, /final public result/u, `${label}: the foreground join waits for the terminal public result`);
      }
      for (const label of ['review-wait', 'adversarial-review-wait', 'status-wait']) {
        const spec = SHELL_WAIT_CASE_SPECS[label];
        assert.notEqual(spec.backgroundFlow, true, `${label}: the root-family command cases never inherit the background flow`);
        assert.equal(spec.rootJoinsChild, undefined, `${label}: Root-join accounting is not a command-case fact`);
      }
    });

    test('a Root acknowledgement does not end the held turn: the Child-settlement watch runs first and its facts are captured', async () => {
      const events = [];
      const held = await runHeldHostTurn({
        launch: async () => ({ result: new Promise((resolve) => setTimeout(() => resolve({ code: 0, stdout: 'launched acknowledgement', stderr: '' }), 10)) }),
        // Round-15 lifecycle: worker readiness (the gate-reached marker)
        // arrives shortly after the acknowledgement and precedes the hold
        // (holdMs 0 here); the result still wins the boundary race.
        waitForGate: async () => { await new Promise((resolve) => setTimeout(resolve, 50)); },
        gatePath: 'unused-gate',
        captureProcessIdentity: async () => identity,
        readProcessIdentity: async () => identity,
        terminateProcessIdentity: async () => { events.push('terminated'); return { attempted: true, signalled: 'SIGTERM', exited: true, failure: null }; },
        releaseGate: async () => { events.push('gate-released'); },
        sleep: async () => {},
        now: (() => { let value = 0; return () => (value += 500); })(),
        holdMs: 0,
        budgetMs: 60_000,
        waitForChildSettlement: async () => { events.push('settlement-watch'); return { observed: true, basis: 'exact-command-launch-then-completed-exit-code-output' }; },
      });
      assert.equal(held.endedBeforeGate, true, 'the host did factually end at the Root acknowledgement');
      assert.equal(held.rootAcknowledged, true, 'the early boundary must be recorded as the Root acknowledgement, not a plain early exit');
      assert.deepEqual(events, ['gate-released', 'settlement-watch', 'terminated'],
        'the held turn must open the Child completion path, watch the Child settle, and only then run settlement cleanup');
      assert.equal(held.childSettlement.observed, true, 'the Child-side settlement facts must be captured');
      assert.equal(held.cleanup.label, 'child-settlement-observed');
      assert.equal(typeof held.timeline.rootAcknowledgementAtElapsedMs, 'number');
      assert.ok(held.timeline.rootAcknowledgementAtElapsedMs >= held.timeline.launchedAtElapsedMs,
        'the Root acknowledgement is recorded after the launch on the held clock');
      assert.notEqual(held.timeline.childSettlementDetectedAtElapsedMs, null);
      assert.notEqual(held.timeline.endedAtElapsedMs, null);
    });

    test('an unobserved Child settlement stays honest: the watch may end without facts and is never fabricated', async () => {
      const held = await runHeldHostTurn({
        launch: async () => ({ result: Promise.resolve({ code: 0, stdout: 'ack', stderr: '' }) }),
        // Round-15 lifecycle: worker readiness arrives after the
        // acknowledgement and precedes the hold.
        waitForGate: async () => { await new Promise((resolve) => setTimeout(resolve, 50)); },
        gatePath: 'unused-gate',
        captureProcessIdentity: async () => identity,
        readProcessIdentity: async () => identity,
        terminateProcessIdentity: async () => ({ attempted: true, signalled: 'SIGTERM', exited: true, failure: null }),
        releaseGate: async () => {},
        sleep: async () => {},
        now: () => 1_000,
        holdMs: 0,
        budgetMs: 60_000,
        waitForChildSettlement: async () => ({ observed: false, basis: null }),
      });
      assert.equal(held.rootAcknowledged, true);
      assert.deepEqual(held.childSettlement, { observed: false, basis: null });
      assert.equal(held.cleanup.label, 'child-settlement-unobserved', 'an ended watch without facts must not be labelled as settlement');
    });

    test('the experiment budget bounds the settlement watch; expiry is budget cleanup, never a settlement claim', async () => {
      const held = await runHeldHostTurn({
        launch: async () => ({ result: new Promise(() => {}), terminate: async () => {} }),
        waitForGate: async () => new Promise(() => {}),
        gatePath: 'unused-gate',
        captureProcessIdentity: async () => identity,
        readProcessIdentity: async () => identity,
        terminateProcessIdentity: async () => ({ attempted: true, signalled: 'SIGTERM', exited: true, failure: null }),
        releaseGate: async () => {},
        sleep: async () => {},
        now: (() => { let value = 0; return () => (value += 60_000); })(),
        holdMs: 0,
        budgetMs: 100,
        waitForChildSettlement: async (signal) => {
          await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
          return { observed: true, basis: 'never' };
        },
      });
      assert.equal(held.budgetExpired, true);
      assert.equal(held.cleanup.label, 'budget-cleanup');
      assert.equal(held.childSettlement ?? null, null, 'a budget-expired watch must not record settlement facts');
    });

    test('the mapping records the Child-settlement facts and a settled background acknowledgement is not the generic early-exit inconclusive', () => {
      const held = {
        endedBeforeGate: true, rootAcknowledged: true, budgetExpired: false, identity: undefined, processAliveWhileHeld: null,
        childSettlement: { observed: true, basis: 'exact-command-launch-then-completed-exit-code-output' },
        // Round-18: the acknowledgement contract requires a SUCCESSFUL
        // observed acknowledgement (exit 0 + the reserved-job output).
        result: { code: 0, stdout: 'The Host Rescue child was launched.', stderr: '' },
        cleanup: { label: 'child-settlement-observed', releasedGate: true, verifiedProcessTerminated: true, codexTerminated: true, nativeInterruptionClaimed: false, errors: [] },
        timeline: { clock: 'held-turn-monotonic-elapsed-ms', launchedAtElapsedMs: 10, observationDetectedAtElapsedMs: 20, pollStartedAtElapsedMs: null, holdDeadlineElapsedMs: null, rootAcknowledgementAtElapsedMs: 30, childSettlementDetectedAtElapsedMs: 40, endedAtElapsedMs: 50 },
      };
      const facts = mapShellWaitLiveFacts(backgroundMappingInput, held, qualifiedRescueEvidence, null, null, mappingFixture, [[{ type: 'session_meta', payload: { id: 'parent-1' } }, { payload: { type: 'agent_message', message: 'The Host Rescue child was launched.' } }]], []);
      assert.deepEqual(facts.child.settlement, { observed: true, basis: 'exact-command-launch-then-completed-exit-code-output' });
      assert.equal(facts.child.rootAcknowledgementAtElapsedMs, 30);
      assert.equal(facts.child.settlementDetectedAtElapsedMs, 40);
      assert.equal(facts.inconclusive, null,
        'an observed Child settlement behind the Root acknowledgement is the background contract, not the generic early-exit inconclusive');
      // The same held shape in a FOREGROUND case keeps the strict early-exit
      // adjudication: a Root-side exit is never excused there.
      const rescueFacts = mapShellWaitLiveFacts(rescueMappingInput, held, qualifiedRescueEvidence, null, null, mappingFixture, [], []);
      assert.equal(rescueFacts.child.settlement.observed, true, 'the measured child facts stay on the record');
      assert.match(rescueFacts.inconclusive.reason, /ended before the held completion boundary/u,
        'a foreground case keeps the early-exit inconclusive even when a settlement watch resolved');
    });

    test('the child-settlement watch resolves on the exact child command followed by a completed exit-code output', async () => {
      const command = 'node "/installed/zcode/skills/rescue/launcher.mjs" invoke-prepared rescue';
      // Real topology: the launch's own output grounds the original handle;
      // the settlement is the LINKED observation's exit code (round-3 P2-3:
      // the launch output itself is the handshake, never the settlement).
      const childRollout = [
        { type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c1', input: `const r = await tools.exec_command(${JSON.stringify({ cmd: command })}); text(JSON.stringify(r))\n` } },
        { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c1', output: [{ type: 'input_text', text: 'Script completed\n' }, { type: 'input_text', text: JSON.stringify({ output: '', exit_code: 0, session_id: 5 }) }] } },
        { type: 'response_item', payload: { type: 'function_call', name: 'write_stdin', call_id: 'poll-1', arguments: JSON.stringify({ session_id: 5, chars: '', yield_time_ms: 60_000 }) } },
        { type: 'response_item', payload: { type: 'function_call_output', call_id: 'poll-1', output: [{ type: 'input_text', text: 'Script running with cell ID cell-1\n' }] } },
        { type: 'response_item', payload: { type: 'function_call', name: 'wait', call_id: 'outer-1', arguments: JSON.stringify({ cell_id: 'cell-1' }) } },
        { type: 'response_item', payload: { type: 'function_call_output', call_id: 'outer-1', output: [{ type: 'input_text', text: 'Script completed\n' }, { type: 'input_text', text: JSON.stringify({ output: 'sentinel', exit_code: 0, session_id: 5 }) }] } },
      ];
      let polls = 0;
      const settlement = await waitForChildSettlementObservation('/codex-home', command, { aborted: false, addEventListener() {} }, {
        loadRollouts: async () => {
          polls += 1;
          return polls >= 2 ? [childRollout] : [];
        },
        sleep: async () => {},
      });
      assert.equal(settlement.observed, true);
      assert.equal(settlement.basis, 'exact-launch-handle-linked-completed-exit-code-output');
      // A pending (non-exit) output never settles the watch: the watch keeps
      // polling until its signal aborts, and the abort is an unobserved
      // settlement, never a fabricated one.
      const pendingRollout = [childRollout[0], { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c1', output: [{ type: 'input_text', text: 'Script running with cell ID cell-9\n' }] } }];
      const controller = new AbortController();
      let pendingPolls = 0;
      await assert.rejects(
        waitForChildSettlementObservation('/codex-home', command, controller.signal, {
          loadRollouts: async () => {
            pendingPolls += 1;
            if (pendingPolls >= 3) controller.abort();
            return [pendingRollout];
          },
          sleep: async () => {},
        }),
        /aborted/u,
        'a pending Child observation must not be counted as settlement',
      );
      assert.equal(pendingPolls >= 3, true);
    });

    test('the background case wires the settlement watch only through the declared background flow', () => {
      // The lifecycle is driven by the declared spec fact, so a future case
      // cannot silently inherit it.
      for (const [label, spec] of Object.entries(SHELL_WAIT_CASE_SPECS)) {
        if (label === 'background') assert.equal(spec.backgroundFlow, true);
        else assert.notEqual(spec.backgroundFlow, true, `${label} must not inherit the background settlement lifecycle`);
      }
    });
  });

  describe('native interrupt interaction recording and Root Status-observation cancellation (R4)', async () => {
    const { extractInterruptInteraction } = await import('../tools/shell-wait-probe/evidence.mjs');
    const { mapShellWaitLiveFacts, runShellWaitCase, SHELL_WAIT_CASE_SPECS } = await import('../tools/shell-wait-probe/driver.mjs');

    // Exact pending Child identity: a UUID-shaped agent id (the shape the V2
    // spawn acknowledgement carries), plus a foreign id for wrong-target cases.
    const CHILD_THREAD = 'a445b927-1e4d-4f11-9a34-2b6ac19b7d51';
    const FOREIGN_THREAD = 'ffffffff-ffff-4fff-8fff-fffffffffff0';

    const interruptMappingInput = {
      case: 'rescue-interrupt', codexBinary: '/bin/x', sourceSha: 'a'.repeat(40), output: '/o',
      workerDurationMs: 420_000, capMs: null, pollMs: 3_600_000, budgetMs: 720_000,
    };
    const interruptMappingFixture = {
      workspace: '/private/tmp/r4-ws', codexHome: '/private/tmp/r4-home',
      installedRoot: '/private/tmp/r4-installed', env: { HOME: '/private/tmp/r4-home' },
      record: { variant: 'candidate', capMs: null, pollMs: 3_600_000, appliedArtifacts: [] },
    };

    /** Event with an optional ISO rollout timestamp (real RolloutLine shape). */
    const stamped = (timestamp, event) => ({ timestamp, ...event });
    const fnCall = (name, callId, args, timestamp = null) => ({
      ...(timestamp ? stamped(timestamp, {}) : {}),
      type: 'response_item', payload: { type: 'function_call', name, call_id: callId, arguments: JSON.stringify(args) },
    });
    const fnOutput = (callId, output, timestamp = null) => ({
      ...(timestamp ? stamped(timestamp, {}) : {}),
      type: 'response_item', payload: { type: 'function_call_output', call_id: callId, output },
    });
    const interruptCall = (callId, target, timestamp = null) => fnCall('interrupt_agent', callId, { target }, timestamp);
    const interruptSuccess = (callId, previousStatus, timestamp = null) => fnOutput(callId, JSON.stringify({ previous_status: previousStatus }), timestamp);
    const interruptError = (callId, message, timestamp = null) => fnOutput(callId, JSON.stringify({ error: message }), timestamp);
    const completedOutputBody = (result) => [
      { type: 'input_text', text: 'Script completed\n' },
      { type: 'input_text', text: JSON.stringify(result) },
    ];
    const pendingOutputBody = (cellId) => [{ type: 'input_text', text: `Script running with cell ID ${cellId}\n` }];

    /**
     * The pending observation → exact delivery → settlement rollout shape:
     * a child rollout confirms the yielded pending cell, the ROOT rollout
     * delivers the exact interrupt, and (optionally) the child's inner
     * observation settles through a later terminal output.
     */
    function interruptRollouts({ childTerminal = null, childTimestamps = false, target = CHILD_THREAD, withInterrupt = true } = {}) {
      const childEvents = [
        { type: 'session_meta', payload: { id: CHILD_THREAD } },
        fnCall('exec_command', 'launch-1', { cmd: 'node launcher' }, childTimestamps ? '2026-10-06T00:00:00.000Z' : null),
        fnOutput('launch-1', completedOutputBody({ output: '', exit_code: 0, session_id: 5 }), childTimestamps ? '2026-10-06T00:00:01.000Z' : null),
        fnCall('write_stdin', 'poll-1', { session_id: 5, chars: '', yield_time_ms: 60_000 }, childTimestamps ? '2026-10-06T00:00:05.000Z' : null),
        fnOutput('poll-1', pendingOutputBody('cell-1'), childTimestamps ? '2026-10-06T00:00:05.500Z' : null),
        ...(childTerminal
          ? [fnCall('wait', 'outer-1', { cell_id: 'cell-1' }, childTimestamps ? '2026-10-06T00:00:11.000Z' : null),
             fnOutput('outer-1', completedOutputBody(childTerminal), childTimestamps ? '2026-10-06T00:00:12.000Z' : null)]
          : []),
      ];
      const rootEvents = [
        { type: 'session_meta', payload: { id: 'root-thread-1' } },
        ...(withInterrupt
          ? [interruptCall('int-1', target, childTimestamps ? '2026-10-06T00:00:07.000Z' : null),
             interruptSuccess('int-1', 'running', childTimestamps ? '2026-10-06T00:00:07.200Z' : null)]
          : []),
      ];
      return [rootEvents, childEvents];
    }

    const interruptEvidence = ({ qualified = false, pendingInnerAtEnd = true, structuralViolationCount = 0, companionOverrides = {} } = {}) => ({
      status: 'supported',
      facts: {
        completion: { qualified, processExit: qualified ? 0 : null, publicResultMatched: qualified ? true : null, decisiveEnd: qualified ? 'process-exit' : null, structuralViolationCount },
        linkage: { checked: true, exact: true, agentType: 'zcode-rescue', childThreadId: CHILD_THREAD, parentThreadId: 'parent-1' },
        collection: { rolloutCount: 2, childToolCallCount: 4, truncated: false, excerpts: [] },
        companion: { launchCount: 1, sendCount: 1, sendCountKnown: true, duplicateLaunch: false, preLaunchDiagnostics: { excerpts: [], truncated: false }, ...companionOverrides },
        handle: { originalHandleChecked: true },
        observations: { outerReturns: 1, modelCalls: 2, rootJoins: 1, decisiveWallMs: 5, pendingInnerAtEnd },
      },
    });

    test('the extractor reports unsent intent: no interrupt-shaped call keeps delivery unknown, never fabricated', () => {
      const interaction = extractInterruptInteraction(interruptRollouts({ withInterrupt: false }), []);
      assert.equal(interaction.attempted, false);
      assert.equal(interaction.family, null);
      assert.equal(interaction.delivered, null, 'an unattempted delivery stays unknown (null), never a fabricated false');
      assert.equal(interaction.previousStatus, null);
      assert.equal(interaction.rejection, null);
      assert.deepEqual(interaction.target, { kind: null, value: null, suppressed: false, chars: null });
    });

    test('the extractor parses the exact V2 delivery: target, success output and previous status', () => {
      // The ordering facts are bound to the EXACT Child's observation (the
      // child rollout is resolved through its session metadata id and the
      // exact launcher command), so the extractor receives the binding.
      const interaction = extractInterruptInteraction(interruptRollouts({ childTimestamps: true }), [], { childThreadId: CHILD_THREAD, command: 'node launcher' });
      assert.equal(interaction.attempted, true);
      assert.equal(interaction.family, 'v2');
      assert.equal(interaction.callCount, 1);
      assert.equal(interaction.delivered, true);
      assert.equal(interaction.previousStatus, 'running');
      assert.deepEqual(interaction.target, { kind: 'agent-id', value: CHILD_THREAD, suppressed: false, chars: CHILD_THREAD.length });
      assert.equal(interaction.pendingBeforeCall.observed, true, 'the yielded pending cell is the confirmed pending observation');
    });

    test('the extractor classifies the V1 send_input interrupt flag, and never without it', () => {
      // The pinned V1 handler returns `{ submission_id: ... }` on successful
      // delivery — NOT the V2 `{ previous_status: ... }` shape. The decoding
      // is family-specific, so the fixture uses the real V1 response.
      const v1Rollouts = [[
        { type: 'session_meta', payload: { id: 'root-thread-1' } },
        fnCall('multi_agent_v1.send_input', 'si-1', { target: CHILD_THREAD, interrupt: true }),
        fnOutput('si-1', JSON.stringify({ submission_id: 'sub-abc123' })),
      ]];
      const v1 = extractInterruptInteraction(v1Rollouts, []);
      assert.equal(v1.attempted, true);
      assert.equal(v1.family, 'v1');
      assert.equal(v1.delivered, true);
      assert.equal(v1.previousStatus, null, 'the V1 tool does not return previous_status; the fact stays null');
      const queuedRollouts = [[
        { type: 'session_meta', payload: { id: 'root-thread-1' } },
        fnCall('send_input', 'si-2', { target: CHILD_THREAD, message: 'status?' }),
        fnOutput('si-2', JSON.stringify({ ok: true })),
      ]];
      const queued = extractInterruptInteraction(queuedRollouts, []);
      assert.equal(queued.attempted, false, 'a plain send_input without interrupt:true is not an interrupt delivery');
    });

    test('the extractor records rejections structurally: unknown, root, self, and unparseable outputs', () => {
      const unknown = extractInterruptInteraction([[
        interruptCall('i1', FOREIGN_THREAD), interruptError('i1', 'unknown agent: no such thread'),
      ]], []);
      assert.equal(unknown.delivered, false);
      assert.equal(unknown.rejection, 'target-unknown');
      const root = extractInterruptInteraction([[
        interruptCall('i2', 'root'), interruptError('i2', 'root is not a spawned agent'),
      ]], []);
      assert.equal(root.delivered, false);
      assert.equal(root.rejection, 'target-root');
      const self = extractInterruptInteraction([[
        interruptCall('i3', CHILD_THREAD), interruptError('i3', 'an agent cannot interrupt itself'),
      ]], []);
      assert.equal(self.delivered, false);
      assert.equal(self.rejection, 'target-self');
      const unparseable = extractInterruptInteraction([[
        interruptCall('i4', CHILD_THREAD),
        { type: 'response_item', payload: { type: 'function_call_output', call_id: 'i4', output: [{ type: 'input_text', text: 'unclassifiable body' }] } },
      ]], []);
      assert.equal(unparseable.delivered, null, 'an unparseable output keeps delivery unknown');
      assert.equal(unparseable.rejection, 'output-unparseable');
    });

    test('the extractor keeps private target content suppressed: shape only, canary never emitted', () => {
      const canary = '/private/tmp/canary-r4-secret-workspace';
      const interaction = extractInterruptInteraction([[
        interruptCall('i1', `${canary}/task`),
        interruptError('i1', `rejected at ${canary}: unknown agent`),
      ]], [canary]);
      assert.equal(interaction.attempted, true);
      assert.equal(interaction.target.kind, 'unknown');
      assert.equal(interaction.target.suppressed, true, 'a non-id, non-fixture target value is suppressed');
      assert.equal(interaction.target.value, null);
      assert.equal(interaction.target.chars, `${canary}/task`.length, 'only the structural length is recorded');
      assert.equal(JSON.stringify(interaction).includes('canary-r4-secret'), false, 'the canary path must never enter the extracted facts');
      assert.equal(interaction.rejection, 'target-unknown', 'the rejection KIND is structural, never the raw message');
    });

    test('exact delivery to the pending Child settles: measured target match, pending interval and delivery-to-settlement latency', () => {
      const held = {
        endedBeforeGate: true, budgetExpired: false, identity: undefined, processAliveWhileHeld: null,
        result: { code: 0, stdout: '', stderr: '' },
        cleanup: { label: 'observation', releasedGate: true, verifiedProcessTerminated: true, codexTerminated: true, nativeInterruptionClaimed: false, errors: [] },
        timeline: { clock: 'held-turn-monotonic-elapsed-ms', launchedAtElapsedMs: 10, observationDetectedAtElapsedMs: 20, pollStartedAtElapsedMs: 30, holdDeadlineElapsedMs: 420_000, rootAcknowledgementAtElapsedMs: null, childSettlementDetectedAtElapsedMs: null, endedAtElapsedMs: 50 },
      };
      const facts = mapShellWaitLiveFacts(
        interruptMappingInput,
        held,
        interruptEvidence({ qualified: true, pendingInnerAtEnd: false }),
        null, null, interruptMappingFixture,
        interruptRollouts({ childTerminal: { output: 'done', exit_code: 0, session_id: 5 }, childTimestamps: true }),
        [], 'node launcher',
      );
      assert.equal(facts.interrupt.requested, true);
      assert.equal(facts.interrupt.attempted, true);
      assert.equal(facts.interrupt.family, 'v2');
      assert.equal(facts.interrupt.delivered, true, 'the delivery carries the measured fact, not a permanent null');
      assert.equal(facts.interrupt.exactTargetMatch, true, 'the target is bound to the observed exact Child thread id');
      assert.equal(facts.interrupt.settled, true);
      assert.match(facts.interrupt.settledBasis, /terminal.*after.*delivery|after.*delivery/i);
      assert.equal(facts.interrupt.pendingIntervalMs, 1500, 'pending cell at 00:00:05.500 to delivery at 00:00:07.000');
      assert.equal(facts.interrupt.deliveryToSettlementMs, 5000, 'delivery at 00:00:07.000 to terminal at 00:00:12.000');
      assert.equal(facts.interrupt.timingBasis, 'rollout-event-timestamps');
      assert.equal(facts.interrupt.missingPrerequisite, null, 'a recorded delivery needs no prerequisite placeholder');
      assert.equal(facts.inconclusive, null, 'a delivered exact interaction is the interrupt case contract, not a failure');
    });

    test('turn interruption without inner-poll settlement is recorded precisely: the yielded cell survives, settlement is not established', () => {
      const held = {
        endedBeforeGate: true, budgetExpired: false, identity: undefined, processAliveWhileHeld: null,
        result: { code: 0, stdout: '', stderr: '' },
        cleanup: { label: 'observation', releasedGate: true, verifiedProcessTerminated: true, codexTerminated: true, nativeInterruptionClaimed: false, errors: [] },
        timeline: { clock: 'held-turn-monotonic-elapsed-ms', launchedAtElapsedMs: 10, observationDetectedAtElapsedMs: 20, pollStartedAtElapsedMs: 30, holdDeadlineElapsedMs: 420_000, rootAcknowledgementAtElapsedMs: null, childSettlementDetectedAtElapsedMs: null, endedAtElapsedMs: 50 },
      };
      // The pending-window delivery must be CONFIRMABLE: the child rollout is
      // stamped so the pending cell demonstrably precedes the delivery.
      const facts = mapShellWaitLiveFacts(
        interruptMappingInput, held, interruptEvidence({ qualified: false, pendingInnerAtEnd: true }),
        null, null, interruptMappingFixture,
        interruptRollouts({ childTimestamps: true }), [], 'node launcher',
      );
      assert.equal(facts.interrupt.delivered, true);
      assert.equal(facts.interrupt.exactTargetMatch, true);
      assert.equal(facts.interrupt.orderingBound, true, 'the exact-Child ordering binding is recorded');
      assert.equal(facts.interrupt.settled, false, 'turn interruption alone never establishes inner settlement');
      assert.match(facts.interrupt.settledBasis, /pending.*(survives|unresolved)|survives/i);
      assert.equal(facts.interrupt.deliveryToSettlementMs, null, 'no settlement means no delivery-to-settlement latency');
      assert.equal(facts.interrupt.missingPrerequisite, null);
      assert.equal(facts.inconclusive, null, 'the precise recorded outcome is the measured result of this case');
    });

    test('a delivery without a confirmable pending window keeps the generic early-exit adjudication (no exemption)', () => {
      const held = {
        endedBeforeGate: true, budgetExpired: false, identity: undefined, processAliveWhileHeld: null,
        result: { code: 0, stdout: '', stderr: '' },
        cleanup: { label: 'observation', releasedGate: true, verifiedProcessTerminated: true, codexTerminated: true, nativeInterruptionClaimed: false, errors: [] },
        timeline: { clock: 'held-turn-monotonic-elapsed-ms', launchedAtElapsedMs: 10, observationDetectedAtElapsedMs: 20, pollStartedAtElapsedMs: 30, holdDeadlineElapsedMs: 420_000, rootAcknowledgementAtElapsedMs: null, childSettlementDetectedAtElapsedMs: null, endedAtElapsedMs: 50 },
      };
      // The SAME shape without rollout timestamps: the pending window cannot
      // be confirmed, so the interrupt exemption must not fire.
      const facts = mapShellWaitLiveFacts(
        interruptMappingInput, held, interruptEvidence({ qualified: false, pendingInnerAtEnd: true }),
        null, null, interruptMappingFixture,
        interruptRollouts(), [], 'node launcher',
      );
      assert.equal(facts.interrupt.delivered, true);
      assert.equal(facts.interrupt.exactTargetMatch, true);
      assert.notEqual(facts.inconclusive, null, 'an unconfirmable pending window cannot earn the interrupt exemption');
      assert.match(facts.inconclusive.reason, /ended before the held completion boundary/u);
    });

    test('unsent intent keeps delivery null with an explicit investigated-surface reason, never the retired Task 5 placeholder', () => {
      const held = {
        endedBeforeGate: false, budgetExpired: false, identity: {}, processAliveWhileHeld: true,
        result: { code: 0, stdout: '', stderr: '' },
        cleanup: { label: 'observation', releasedGate: true, verifiedProcessTerminated: true, codexTerminated: true, nativeInterruptionClaimed: false, errors: [] },
        timeline: { clock: 'held-turn-monotonic-elapsed-ms', launchedAtElapsedMs: 10, observationDetectedAtElapsedMs: 20, pollStartedAtElapsedMs: 30, holdDeadlineElapsedMs: 420_000, rootAcknowledgementAtElapsedMs: null, childSettlementDetectedAtElapsedMs: null, endedAtElapsedMs: 50 },
      };
      const facts = mapShellWaitLiveFacts(
        interruptMappingInput, held, interruptEvidence({ qualified: true, pendingInnerAtEnd: false }),
        null, null, interruptMappingFixture, [[{ type: 'session_meta', payload: { id: 'root-thread-1' } }]], [],
      );
      assert.equal(facts.interrupt.attempted, false);
      assert.equal(facts.interrupt.delivered, null, 'an unattempted delivery stays null');
      assert.match(facts.interrupt.missingPrerequisite, /no interrupt-shaped tool call was observed/i);
      assert.match(facts.interrupt.missingPrerequisite, /interrupt_agent|send_input/i, 'the reason names the investigated surface');
      assert.doesNotMatch(facts.interrupt.missingPrerequisite, /Task 5/i, 'the retired placeholder reason must be gone');
    });

    test('a wrong target is a recorded rejection and leaves the observation unaffected', () => {
      const held = {
        endedBeforeGate: false, budgetExpired: false, identity: {}, processAliveWhileHeld: true,
        result: { code: 0, stdout: '', stderr: '' },
        cleanup: { label: 'observation', releasedGate: true, verifiedProcessTerminated: true, codexTerminated: true, nativeInterruptionClaimed: false, errors: [] },
        timeline: { clock: 'held-turn-monotonic-elapsed-ms', launchedAtElapsedMs: 10, observationDetectedAtElapsedMs: 20, pollStartedAtElapsedMs: 30, holdDeadlineElapsedMs: 420_000, rootAcknowledgementAtElapsedMs: null, childSettlementDetectedAtElapsedMs: null, endedAtElapsedMs: 50 },
      };
      const rollouts = [[
        { type: 'session_meta', payload: { id: 'root-thread-1' } },
        interruptCall('int-1', FOREIGN_THREAD),
        interruptError('int-1', 'unknown agent: no such thread'),
      ]];
      const facts = mapShellWaitLiveFacts(
        interruptMappingInput, held, interruptEvidence({ qualified: true, pendingInnerAtEnd: false }),
        null, null, interruptMappingFixture, rollouts, [],
      );
      assert.equal(facts.interrupt.attempted, true);
      assert.equal(facts.interrupt.delivered, false, 'the rejection is recorded, not hidden');
      assert.equal(facts.interrupt.rejection, 'target-unknown');
      assert.equal(facts.interrupt.exactTargetMatch, false, 'the foreign target is not the exact Child');
      assert.equal(facts.interrupt.settled, null, 'a rejected delivery claims no settlement');
      // P2-3 round-7: a rejected delivery keeps the interrupt trial
      // inconclusive with its recorded reason, even with qualified completion.
      assert.notEqual(facts.inconclusive, null, 'a rejected delivery keeps the trial inconclusive');
      assert.match(facts.inconclusive.reason, /requires one observed exact-target delivery/i);
      assert.match(facts.inconclusive.reason, /rejected \(target-unknown\)/u);
    });

    test('a post-completion delivery attempt is recorded but never attributed as the interrupt settlement', () => {
      const held = {
        endedBeforeGate: false, budgetExpired: false, identity: {}, processAliveWhileHeld: true,
        result: { code: 0, stdout: '', stderr: '' },
        cleanup: { label: 'observation', releasedGate: true, verifiedProcessTerminated: true, codexTerminated: true, nativeInterruptionClaimed: false, errors: [] },
        timeline: { clock: 'held-turn-monotonic-elapsed-ms', launchedAtElapsedMs: 10, observationDetectedAtElapsedMs: 20, pollStartedAtElapsedMs: 30, holdDeadlineElapsedMs: 420_000, rootAcknowledgementAtElapsedMs: null, childSettlementDetectedAtElapsedMs: null, endedAtElapsedMs: 50 },
      };
      // Real topology: the Child's own poll settles BEFORE the delivery, so
      // the post-completion ordering is observable through the bound
      // original-handle events (rollout timestamps).
      const rollouts = [
        [
          { type: 'session_meta', payload: { id: 'root-thread-1' } },
          stamped('2026-10-06T00:00:07.000Z', interruptCall('int-1', CHILD_THREAD)),
          stamped('2026-10-06T00:00:07.200Z', interruptSuccess('int-1', 'completed')),
        ],
        [
          { type: 'session_meta', payload: { id: CHILD_THREAD } },
          stamped('2026-10-06T00:00:00.000Z', fnCall('exec_command', 'launch-1', { cmd: 'node launcher' })),
          stamped('2026-10-06T00:00:01.000Z', fnOutput('launch-1', completedOutputBody({ output: '', exit_code: 0, session_id: 5 }))),
          stamped('2026-10-06T00:00:05.000Z', fnCall('write_stdin', 'poll-1', { session_id: 5, chars: '', yield_time_ms: 60_000 })),
          stamped('2026-10-06T00:00:06.000Z', fnOutput('poll-1', completedOutputBody({ output: 'done', exit_code: 0, session_id: 5 }))),
        ],
      ];
      const facts = mapShellWaitLiveFacts(
        interruptMappingInput, held, interruptEvidence({ qualified: true, pendingInnerAtEnd: false }),
        null, null, interruptMappingFixture, rollouts, [], 'node launcher',
      );
      assert.equal(facts.interrupt.attempted, true);
      assert.equal(facts.interrupt.delivered, true);
      assert.equal(facts.interrupt.orderingBound, true);
      assert.equal(facts.interrupt.settled, null, 'a post-completion delivery is never attributed as interrupt settlement');
      assert.match(facts.interrupt.settledBasis, /post-completion|after.*completion|completed/i);
      // P2-3 round-7: a post-completion delivery keeps the trial inconclusive
      // with its recorded reason — chronological ordering never qualifies it.
      assert.notEqual(facts.inconclusive, null, 'a post-completion delivery keeps the trial inconclusive');
      assert.match(facts.inconclusive.reason, /followed the Child completion/i);
    });

    test('a late-only (post-completion) delivery keeps the generic early-exit adjudication instead of the interrupt exemption', () => {
      const held = {
        endedBeforeGate: true, budgetExpired: false, identity: undefined, processAliveWhileHeld: null,
        result: { code: 0, stdout: '', stderr: '' },
        cleanup: { label: 'observation', releasedGate: true, verifiedProcessTerminated: true, codexTerminated: true, nativeInterruptionClaimed: false, errors: [] },
        timeline: { clock: 'held-turn-monotonic-elapsed-ms', launchedAtElapsedMs: 10, observationDetectedAtElapsedMs: 20, pollStartedAtElapsedMs: 30, holdDeadlineElapsedMs: 420_000, rootAcknowledgementAtElapsedMs: null, childSettlementDetectedAtElapsedMs: null, endedAtElapsedMs: 50 },
      };
      // Real topology, bound ordering: the Child's own poll settled BEFORE
      // the delivery (stamped), so the delivery is demonstrably late and the
      // confirmed pending window is absent — the exemption must not fire.
      const rollouts = [
        [
          { type: 'session_meta', payload: { id: 'root-thread-1' } },
          stamped('2026-10-06T00:00:07.000Z', interruptCall('int-1', CHILD_THREAD)),
          stamped('2026-10-06T00:00:07.200Z', interruptSuccess('int-1', 'completed')),
        ],
        [
          { type: 'session_meta', payload: { id: CHILD_THREAD } },
          stamped('2026-10-06T00:00:00.000Z', fnCall('exec_command', 'launch-1', { cmd: 'node launcher' })),
          stamped('2026-10-06T00:00:01.000Z', fnOutput('launch-1', completedOutputBody({ output: '', exit_code: 0, session_id: 5 }))),
          stamped('2026-10-06T00:00:05.000Z', fnCall('write_stdin', 'poll-1', { session_id: 5, chars: '', yield_time_ms: 60_000 })),
          stamped('2026-10-06T00:00:06.000Z', fnOutput('poll-1', completedOutputBody({ output: 'done', exit_code: 0, session_id: 5 }))),
        ],
      ];
      const facts = mapShellWaitLiveFacts(
        interruptMappingInput, held, interruptEvidence({ qualified: false, pendingInnerAtEnd: false }),
        null, null, interruptMappingFixture, rollouts, [], 'node launcher',
      );
      assert.equal(facts.interrupt.delivered, true, 'the late delivery stays recorded');
      assert.equal(facts.interrupt.exactTargetMatch, true);
      assert.equal(facts.interrupt.orderingBound, true);
      assert.match(facts.interrupt.settledBasis, /post-completion/i);
      assert.match(facts.inconclusive.reason, /ended before the held completion boundary/u,
        'a late-only delivery must not earn the pending-window interrupt exemption: the early-exit inconclusive stays');
    });

    test('an external budget kill stays budget cleanup and is never recorded as native interruption', () => {
      const held = {
        endedBeforeGate: false, budgetExpired: true, identity: {}, processAliveWhileHeld: null,
        result: undefined,
        cleanup: { label: 'budget-cleanup', releasedGate: true, verifiedProcessTerminated: true, codexTerminated: true, nativeInterruptionClaimed: false, errors: [] },
        timeline: { clock: 'held-turn-monotonic-elapsed-ms', launchedAtElapsedMs: 10, observationDetectedAtElapsedMs: 20, pollStartedAtElapsedMs: 30, holdDeadlineElapsedMs: 420_000, rootAcknowledgementAtElapsedMs: null, childSettlementDetectedAtElapsedMs: null, endedAtElapsedMs: 50 },
      };
      const facts = mapShellWaitLiveFacts(
        interruptMappingInput, held, interruptEvidence({ qualified: false, pendingInnerAtEnd: true }),
        null, null, interruptMappingFixture, [[{ type: 'session_meta', payload: { id: 'root-thread-1' } }]], [],
      );
      assert.equal(facts.interrupt.attempted, false);
      assert.equal(facts.interrupt.delivered, null);
      assert.match(facts.interrupt.missingPrerequisite, /budget expired.*never native interruption|never native interruption/i,
        'the budget kill is labeled as budget cleanup inside the interrupt facts too');
      assert.equal(facts.held.cleanupLabel, 'budget-cleanup');
    });

    test('the rescue-interrupt prompt wires the exact owning-session interrupt directive; other cases stay untouched', () => {
      const spec = SHELL_WAIT_CASE_SPECS['rescue-interrupt'];
      assert.match(spec.prompt, /interrupt_agent/u, 'the prompt must wire the investigated installed V2 surface');
      assert.match(spec.prompt, /exact agent id|exact spawned agent id|spawn acknowledgement returned/i, 'the target must be the exact spawn acknowledgement id');
      assert.match(spec.prompt, /exactly one|only one/i, 'the delivery must be bounded to one attempt');
      assert.match(spec.prompt, /do not interrupt any other agent/i, 'collateral interruption must be explicitly forbidden');
      assert.match(spec.prompt, /pending|before.*result/i, 'the delivery waits for the confirmed pending observation');
      for (const label of ['rescue-baseline', 'rescue-long', 'rescue-repeat', 'rescue-noise']) {
        assert.doesNotMatch(SHELL_WAIT_CASE_SPECS[label].prompt, /interrupt_agent/i, `${label} must not carry the interrupt directive`);
      }
    });

    test('the written record persists the measured interrupt interaction fields end to end', async (t) => {
      const temporary = await mkdtemp(join(tmpdir(), 'shell-wait-r4-record-'));
      t.after(() => rm(temporary, { recursive: true, force: true }));
      const output = join(temporary, 'output');
      await mkdir(output, { mode: 0o700 });
      const record = await runShellWaitCase(
        { case: 'rescue-interrupt', codexBinary: process.execPath, sourceSha: 'a'.repeat(40), output, workerDurationMs: 1000, capMs: null, pollMs: 3_600_000, budgetMs: 2000 },
        {
          createFixture: async () => ({
            workspace: join(temporary, 'ws'), codexHome: join(temporary, 'home'),
            installedRoot: join(temporary, 'installed'), env: { CODEX_HOME: join(temporary, 'home') },
            record: { variant: 'candidate', capMs: null, pollMs: 3_600_000, appliedArtifacts: [] },
            dispose: async () => {},
          }),
          executeLiveCase: async () => ({
            codexVersion: null,
            route: { requested: 'named', actual: null },
            hostResult: { exitCode: 0, companionProcessExit: null, sentinelMatched: null, terminalStdoutChecked: null, resultCheck: null, resultCheckLabel: null },
            linkage: { checked: true, mode: 'rescue', rootThreadId: null, childThreadId: CHILD_THREAD, parentThreadId: 'parent-1', companionLaunchCount: 1, companionSendCount: 1, originalHandleChecked: true },
            observations: { outerReturns: 1, modelCalls: 2, rootJoins: 1, decisiveWallMs: null, pendingInnerAtEnd: false },
            interrupt: {
              requested: true, attempted: true, family: 'v2', delivered: true, rejection: null, previousStatus: 'running',
              target: { kind: 'agent-id', value: CHILD_THREAD, suppressed: false, chars: CHILD_THREAD.length },
              exactTargetMatch: true, settled: true, settledBasis: 'terminal-observation-after-delivery',
              pendingIntervalMs: 1500, deliveryToSettlementMs: 5000, timingBasis: 'rollout-event-timestamps',
              missingPrerequisite: null,
            },
            held: { endedBeforeGate: true, cleanupLabel: 'observation', gateReleased: true, cleanupErrors: { count: 0, reasons: [] }, processTermination: { verifiedTerminated: true, codexTerminated: true }, cleanupComplete: true },
            child: { settlement: null, rootAcknowledgementAtElapsedMs: null, settlementDetectedAtElapsedMs: null },
            statusQuery: null,
            excerpts: [],
            inconclusive: null,
          }),
        },
      );
      assert.equal(record.status, 'executed');
      assert.equal(record.interrupt.attempted, true);
      assert.equal(record.interrupt.delivered, true);
      assert.equal(record.interrupt.exactTargetMatch, true);
      assert.equal(record.interrupt.settled, true);
      assert.equal(record.interrupt.pendingIntervalMs, 1500);
      assert.equal(record.interrupt.deliveryToSettlementMs, 5000);
      assert.equal(record.interrupt.missingPrerequisite, null);
      const written = JSON.parse(await readFile(join(output, 'rescue-interrupt.record.json'), 'utf8'));
      assert.equal(written.interrupt.delivered, true, 'the persisted record carries the measured delivery');
      assert.equal(written.cleanup.nativeInterruptionClaimed, false, 'the cleanup contract keeps the explicit never-claimed marker');
    });

    test('cancelling the Root Status observation leaves both held jobs running: no stop or cancel request is caused', async (t) => {
      const { randomUUID } = await import('node:crypto');
      const { realpathSync } = await import('node:fs');
      const { createIdentityStore } = await import('../scripts/lib/identity.mjs');
      const { createStateStore } = await import('../scripts/lib/state.mjs');
      const { runChild } = await import('./helpers/run-child.mjs');
      const { reserveOwnedStatusJob } = await import('../tools/shell-wait-probe/fixture.mjs');
      const { runCompanion } = await import('../scripts/zcode-companion.mjs');

      const temporary = await mkdtemp(join(tmpdir(), 'shell-wait-r4-status-cancel-'));
      t.after(() => rm(temporary, { recursive: true, force: true }));
      const dataRoot = join(temporary, 'data-root');
      const identityModule = join(repositoryRoot, 'scripts', 'lib', 'identity.mjs');
      const companionEntry = join(repositoryRoot, 'scripts', 'zcode-companion.mjs');
      // Production admits ONE active writable Rescue job per workspace, so the
      // UNRELATED harmless job lives in its own workspace under its own owning
      // session: the cancellation of session A's observation must not touch
      // session B's held job either.
      const owningWorkspace = async (label) => {
        const workspace = join(temporary, `workspace-${label}`);
        await mkdir(workspace, { recursive: true });
        const canonicalWorkspace = realpathSync.native(workspace);
        const env = { ...process.env, ZCODE_DATA_ROOT: dataRoot };
        const sessionId = randomUUID();
        const turnId = `r4-status-cancel-turn-${label}`;
        const hookInput = (extra) => ({ session_id: sessionId, cwd: workspace, transcript_path: null, model: 'gpt', permission_mode: 'acceptEdits', ...extra });
        for (const [script, extra] of [
          ['session-lifecycle-hook.mjs', { hook_event_name: 'SessionStart', source: 'startup' }],
          ['user-prompt-hook.mjs', { hook_event_name: 'UserPromptSubmit', turn_id: turnId, prompt: 'status setup' }],
        ]) {
          const hook = await runChild(process.execPath, [join(repositoryRoot, 'hooks', script)], {
            cwd: canonicalWorkspace, env, ordinaryInput: true, input: hookInput(extra), timeoutMs: 60_000,
          });
          assert.equal(hook.code, 0, `${script} must establish the owning session: ${hook.stderr.slice(0, 300)}`);
        }
        return { canonicalWorkspace, env, sessionId, turnId };
      };
      const observed = await owningWorkspace('observed');
      const unrelated = await owningWorkspace('unrelated');
      // Both held jobs through the production reservation path: the observed
      // one, and the UNRELATED harmless job that must survive the cancellation.
      const observedJob = await reserveOwnedStatusJob({
        companionEntry, identityModule, dataRoot, workspace: observed.canonicalWorkspace, env: observed.env,
        sessionId: observed.sessionId, turnId: observed.turnId, permissionMode: 'acceptEdits', queryTimeoutMs: 240_000, task: 'shell-wait-probe-fixture-task',
      });
      const unrelatedJob = await reserveOwnedStatusJob({
        companionEntry, identityModule, dataRoot, workspace: unrelated.canonicalWorkspace, env: unrelated.env,
        sessionId: unrelated.sessionId, turnId: unrelated.turnId, permissionMode: 'acceptEdits', queryTimeoutMs: 240_000, task: 'shell-wait-probe-fixture-task',
      });
      const identity = createIdentityStore({ dataRoot });
      const token = await identity.createCallerContext({
        sessionId: observed.sessionId, turnId: observed.turnId, workspace: observed.canonicalWorkspace, permissionMode: 'acceptEdits',
      });
      // The REAL production Status wait against the observed job, cancelled
      // mid-flight through the wait's own external observation signal — well
      // before its query deadline.
      const controller = new AbortController();
      const cancelReason = new Error('the Root Status observation was cancelled');
      const pending = runCompanion(['status', observedJob.jobId, '--wait', '--timeout-ms', '240000'], {
        cwd: observed.canonicalWorkspace, env: observed.env, authorization: { callerContext: token }, signal: controller.signal,
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      controller.abort(cancelReason);
      await assert.rejects(pending, (error) => error === cancelReason,
        'the observation cancellation must end the WAIT itself, never run to its query deadline');
      // Both jobs stay held through the PRODUCTION state store, with NO stop
      // intent recorded: ending the observation caused no job stop/cancel.
      const store = createStateStore({ dataRoot });
      const observedAfter = await store.readJob(observed.canonicalWorkspace, observedJob.jobId);
      assert.equal(observedAfter.status, 'queued', 'the observed job must remain held after its observation was cancelled');
      assert.equal(observedAfter.stopIntent ?? undefined, undefined, 'the cancelled observation must record no stop intent on the job');
      const unrelatedAfter = await store.readJob(unrelated.canonicalWorkspace, unrelatedJob.jobId);
      assert.equal(unrelatedAfter.status, 'queued', 'the unrelated harmless job must survive untouched');
      assert.equal(unrelatedAfter.stopIntent ?? undefined, undefined, 'the unrelated job must carry no stop intent either');
    });
  });

  describe('review adjudication fixes: interrupt ordering binding, exemption narrowing, Root identification and root-control calls', async () => {
    const { inspectShellWaitEvidence, extractInterruptInteraction } = await import('../tools/shell-wait-probe/evidence.mjs');
    const { mapShellWaitLiveFacts, runShellWaitCase, renderCompanionCommand } = await import('../tools/shell-wait-probe/driver.mjs');

    const CHILD_THREAD = 'b81d4f0a-2c25-4e6a-9a34-5f1e7c9d0b12';
    const ROOT_THREAD = 'review-root-thread-1';
    const PARENT_THREAD = 'review-parent-thread-1';
    const LAUNCHER = 'node "/installed/zcode/skills/rescue/launcher.mjs" invoke-prepared rescue';
    const SENTINEL = 'ZCODE_RESCUE_PUBLIC_SENTINEL_7C9C';
    const HANDLE = 5;

    const stamped = (timestamp, event) => ({ timestamp, ...event });
    const fnCall = (name, callId, args, timestamp = null) => ({
      ...(timestamp ? stamped(timestamp, {}) : {}),
      type: 'response_item', payload: { type: 'function_call', name, call_id: callId, arguments: JSON.stringify(args) },
    });
    const fnOutput = (callId, output, timestamp = null) => ({
      ...(timestamp ? stamped(timestamp, {}) : {}),
      type: 'response_item', payload: { type: 'function_call_output', call_id: callId, output },
    });
    const interruptCall = (callId, target, timestamp = null) => fnCall('interrupt_agent', callId, { target }, timestamp);
    const interruptSuccess = (callId, previousStatus, timestamp = null) => fnOutput(callId, JSON.stringify({ previous_status: previousStatus }), timestamp);
    const completedOutputBody = (result) => [
      { type: 'input_text', text: 'Script completed\n' },
      { type: 'input_text', text: JSON.stringify(result) },
    ];
    /** A completed body whose first item carries the pinned code-mode wall-time header. */
    const headerCompletedOutputBody = (seconds, result) => [
      { type: 'input_text', text: `Script completed\nWall time ${seconds} seconds\nOutput:\n` },
      { type: 'input_text', text: JSON.stringify(result) },
    ];
    const pendingOutputBody = (cellId) => [{ type: 'input_text', text: `Script running with cell ID ${cellId}\n` }];
    const wrapperCell = (callId, input) => ({ type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: callId, input } });
    const wrapperOutput = (callId, output) => ({ type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: callId, output } });

    /** The exact-Child binding options the driver derives from the supported evidence facts. */
    const binding = { childThreadId: CHILD_THREAD, command: LAUNCHER };

    const at = (second) => `2026-10-06T00:00:${String(second).padStart(2, '0')}Z`;

    /** Child rollout: launch + one pending empty-input poll (+ optional bound terminal). */
    function childRollout({ terminal = null, timestamps = true } = {}) {
      const stamp = (second, event) => (timestamps ? stamped(at(second), event) : event);
      return [
        { type: 'session_meta', payload: { id: CHILD_THREAD } },
        stamp(0, fnCall('exec_command', 'launch-1', { cmd: LAUNCHER })),
        stamp(1, fnOutput('launch-1', completedOutputBody({ output: '', exit_code: 0, session_id: HANDLE }))),
        stamp(5, fnCall('write_stdin', 'poll-1', { session_id: HANDLE, chars: '', yield_time_ms: 3_600_000 })),
        stamp('05.5', fnOutput('poll-1', pendingOutputBody('cell-1'))),
        ...(terminal
          ? [stamp(11, fnCall('wait', 'outer-1', { cell_id: 'cell-1' })),
            stamp(12, fnOutput('outer-1', completedOutputBody(terminal)))]
          : []),
      ];
    }

    /** Root rollout carrying the interrupt delivery (+ optional unrelated Root-side commands). */
    function rootRollout({ extraBefore = [], extraAfter = [] } = {}) {
      return [
        { type: 'session_meta', payload: { id: ROOT_THREAD } },
        ...extraBefore,
        stamped(at(7), interruptCall('int-1', CHILD_THREAD)),
        stamped(at('07.2'), interruptSuccess('int-1', 'running')),
        ...extraAfter,
      ];
    }

    // --- P2-6: the interrupt attempt grammar is an anchored awaited-call form ---

    test('a printed interrupt expression inside a quoted string is never an attempted delivery', () => {
      const rollouts = [[
        { type: 'session_meta', payload: { id: ROOT_THREAD } },
        wrapperCell('print-1', `text('tools.interrupt_agent({"target":"${CHILD_THREAD}"})');`),
        wrapperOutput('print-1', [{ type: 'input_text', text: 'Script completed\n' }, { type: 'input_text', text: JSON.stringify({ output: 'printed' }) }]),
      ]];
      const interaction = extractInterruptInteraction(rollouts, []);
      assert.equal(interaction.attempted, false, 'a quoted print of a tool expression is not a tool call');
      assert.equal(interaction.family, null);
      assert.equal(interaction.callCount, 0);
    });

    test('the anchored awaited interrupt wrapper form is recognized as an attempt', () => {
      const rollouts = [[
        { type: 'session_meta', payload: { id: ROOT_THREAD } },
        wrapperCell('int-1', `text(await tools.interrupt_agent({"target":"${CHILD_THREAD}"}));`),
        wrapperOutput('int-1', JSON.stringify({ previous_status: 'running' })),
      ]];
      const interaction = extractInterruptInteraction(rollouts, [], binding);
      assert.equal(interaction.attempted, true, 'the awaited-call statement form is the attempt grammar');
      assert.equal(interaction.family, 'v2');
      assert.equal(interaction.delivered, true);
    });

    // --- P2-7: family-specific success decoding ---

    test('V1 success decoding is family-specific: submission_id delivers, a V2-shaped body does not', () => {
      const v1 = extractInterruptInteraction([[
        fnCall('multi_agent_v1.send_input', 'si-1', { target: CHILD_THREAD, interrupt: true }),
        fnOutput('si-1', JSON.stringify({ submission_id: 'sub-abc123' })),
      ]], []);
      assert.equal(v1.delivered, true, 'the pinned V1 handler returns {submission_id}; its presence is the delivery');
      assert.equal(v1.previousStatus, null, 'the V1 tool does not return previous_status');
      const v1WrongShape = extractInterruptInteraction([[
        fnCall('multi_agent_v1.send_input', 'si-2', { target: CHILD_THREAD, interrupt: true }),
        fnOutput('si-2', JSON.stringify({ previous_status: 'running' })),
      ]], []);
      assert.equal(v1WrongShape.delivered, null, 'a V2-shaped response is not V1 delivery evidence');
      assert.equal(v1WrongShape.rejection, 'output-unparseable');
      const v2WrongShape = extractInterruptInteraction([[
        fnCall('interrupt_agent', 'i-1', { target: CHILD_THREAD }),
        fnOutput('i-1', JSON.stringify({ submission_id: 'sub-abc123' })),
      ]], []);
      assert.equal(v2WrongShape.delivered, null, 'a V1-shaped response is not V2 delivery evidence');
      assert.equal(v2WrongShape.rejection, 'output-unparseable');
    });

    // --- P2-3: ordering binds to the EXACT Child's original handle and continuations ---

    test('interrupt ordering binds to the exact Child observation: a Root-side completed command is not Child completion', () => {
      const rollouts = [
        rootRollout({
          extraBefore: [
            stamped(at(2), fnCall('exec_command', 'cat-1', { cmd: 'cat notes.txt' })),
            stamped(at(3), fnOutput('cat-1', completedOutputBody({ output: 'notes', exit_code: 0 }))),
          ],
        }),
        childRollout({}),
      ];
      const interaction = extractInterruptInteraction(rollouts, [], binding);
      assert.equal(interaction.orderingBound, true, 'the exact-Child binding resolved');
      assert.equal(interaction.sameRolloutCompletedBeforeCall, false, 'the Root-side cat is not the Child completion');
      assert.equal(interaction.pendingBeforeCall.observed, true, 'the bound Child pending cell is observed before the call');
      assert.equal(interaction.completedAfterCall.atMs, null, 'unrelated Root-side outputs never supply settlement timing');
    });

    test('settlement latency comes only from the bound Child terminal, never an unrelated Root-side output', () => {
      const rollouts = [
        rootRollout({
          extraAfter: [
            stamped(at(9), fnCall('exec_command', 'cat-2', { cmd: 'cat other.txt' })),
            stamped(at(10), fnOutput('cat-2', completedOutputBody({ output: 'other', exit_code: 0 }))),
          ],
        }),
        childRollout({ terminal: { output: SENTINEL, exit_code: 0, session_id: HANDLE } }),
      ];
      const interaction = extractInterruptInteraction(rollouts, [], binding);
      assert.equal(interaction.completedAfterCall.atMs, Date.parse(at(12)), 'only the bound Child terminal supplies delivery-to-settlement timing');
    });

    test('without a resolvable exact-Child binding the ordering facts fail closed instead of guessing', () => {
      const rollouts = [[
        { type: 'session_meta', payload: { id: 'unrelated-thread' } },
        stamped(at(1), fnCall('exec_command', 'launch-1', { cmd: LAUNCHER })),
        stamped(at(2), fnOutput('launch-1', completedOutputBody({ output: '', exit_code: 0, session_id: HANDLE }))),
        stamped(at(5), fnCall('write_stdin', 'poll-1', { session_id: HANDLE, chars: '', yield_time_ms: 3_600_000 })),
        stamped(at('05'), fnOutput('poll-1', pendingOutputBody('cell-1'))),
        stamped(at(7), interruptCall('int-1', CHILD_THREAD)),
        stamped(at('07'), interruptSuccess('int-1', 'running')),
      ]];
      const interaction = extractInterruptInteraction(rollouts, []);
      assert.equal(interaction.orderingBound, false);
      assert.equal(interaction.pendingBeforeCall.observed, false, 'an unresolvable binding cannot confirm the pending window');
      assert.equal(interaction.sameRolloutCompletedBeforeCall, null, 'ordering stays unknown, never a guessed boolean');
      assert.equal(interaction.completedAfterCall.atMs, null);
    });

    // --- P2-2: the exemption requires the confirmed pending window and retains the structural checks ---

    const interruptHeld = {
      endedBeforeGate: true, budgetExpired: false, identity: undefined, processAliveWhileHeld: null,
      result: { code: 0, stdout: '', stderr: '' },
      cleanup: { label: 'observation', releasedGate: true, verifiedProcessTerminated: true, codexTerminated: true, nativeInterruptionClaimed: false, errors: [] },
      timeline: { clock: 'held-turn-monotonic-elapsed-ms', launchedAtElapsedMs: 10, observationDetectedAtElapsedMs: 20, pollStartedAtElapsedMs: 30, holdDeadlineElapsedMs: 420_000, rootAcknowledgementAtElapsedMs: null, childSettlementDetectedAtElapsedMs: null, endedAtElapsedMs: 50 },
    };
    const mappingInput = {
      case: 'rescue-interrupt', codexBinary: '/bin/x', sourceSha: 'a'.repeat(40), output: '/o',
      workerDurationMs: 420_000, capMs: null, pollMs: 3_600_000, budgetMs: 720_000,
    };
    const mappingFixture = {
      workspace: '/private/tmp/review-ws', codexHome: '/private/tmp/review-home',
      installedRoot: '/private/tmp/review-installed', env: { HOME: '/private/tmp/review-home' },
      record: { variant: 'candidate', capMs: null, pollMs: 3_600_000, appliedArtifacts: [] },
    };

    test('a delivered pending-window exact interrupt cannot exempt structural completion failures (two launches, two sends)', () => {
      const evidence = {
        status: 'supported',
        facts: {
          completion: {
            qualified: false, processExit: null, publicResultMatched: null, decisiveEnd: null,
            structuralViolationCount: 2,
            reason: 'completion cannot be qualified: the exact launcher command was observed 2 times; the fake peer observed 2 session sends instead of exactly one.',
          },
          linkage: { checked: true, exact: true, agentType: 'zcode-rescue', childThreadId: CHILD_THREAD, parentThreadId: PARENT_THREAD },
          collection: { rolloutCount: 2, childToolCallCount: 5, truncated: false, excerpts: [] },
          companion: { launchCount: 2, sendCount: 2, sendCountKnown: true, duplicateLaunch: true, preLaunchDiagnostics: { excerpts: [], truncated: false } },
          handle: { originalHandleChecked: true },
          observations: { outerReturns: 0, modelCalls: 5, rootJoins: 1, decisiveWallMs: null, pendingInnerAtEnd: false },
        },
      };
      const held = { ...interruptHeld, endedBeforeGate: false };
      const facts = mapShellWaitLiveFacts(
        mappingInput, held, evidence, null, null, mappingFixture,
        [rootRollout({}), childRollout({})], [], LAUNCHER,
      );
      assert.equal(facts.interrupt.delivered, true, 'the delivery stays recorded');
      assert.equal(facts.interrupt.exactTargetMatch, true);
      assert.notEqual(facts.inconclusive, null, 'structural completion failures keep the case inconclusive even with a delivered exact pending-window interrupt');
      assert.match(facts.inconclusive.reason, /2 times|2 session sends/u, 'the structural reason is retained, never suppressed by the interrupt exemption');
    });

    // --- P2-4: Root identification rejects subagent rollouts ---

    test('a subagent rollout exposing the exact companion command is rejected for Root identification', () => {
      const command = `${renderCompanionCommand('/installed/zcode/scripts/zcode-companion.mjs')} invoke review`;
      const subagentRollout = [[
        { type: 'session_meta', payload: { id: 'sub-thread-1', parent_thread_id: PARENT_THREAD, source: { subagent: { thread_spawn: { agent_path: '/root/task' } } } } },
        wrapperCell('launch-1', `const r = await tools.exec_command(${JSON.stringify({ cmd: command, workdir: '/installed/workspace' })}); text(JSON.stringify(r))\n`),
        wrapperOutput('launch-1', completedOutputBody({ output: '', session_id: 87 })),
        wrapperCell('poll-1', `const r = await tools.write_stdin(${JSON.stringify({ session_id: 87, chars: '', yield_time_ms: 3_600_000 })}); text(JSON.stringify(r))\n`),
        wrapperOutput('poll-1', pendingOutputBody('cell-1')),
        fnCall('wait', 'outer-1', { cell_id: 'cell-1' }),
        fnOutput('outer-1', completedOutputBody({ output: `${SENTINEL}\n`, exit_code: 0, session_id: 87 })),
      ]];
      const result = inspectShellWaitEvidence({
        rollouts: subagentRollout,
        zcodeCalls: [{ method: 'session/send', params: { sessionId: 'fake-session' } }],
        command,
        mode: 'root',
        publicResultMarkers: [SENTINEL],
        workerStillAliveAfterObservation: false,
        redactions: [],
      });
      assert.equal(result.status, 'supported', JSON.stringify(result.inconclusive));
      assert.equal(result.facts.linkage.exact, false, 'a rollout carrying parent/subagent metadata is not the launched Root session');
      assert.match(result.facts.linkage.reason, /subagent|parent thread/i);
      assert.equal(result.facts.completion.qualified, false, 'the subagent rollout cannot carry Root qualification');
    });

    // --- P2-5 + child-sequence discipline: the narrow root-control-call path ---

    function rescueRollouts({ childMutation = null, parentMutation = null } = {}) {
      const parentEvents = [
        { type: 'session_meta', payload: { id: PARENT_THREAD } },
        fnCall('spawn_agent', 'spawn-1', { task_name: 'zcode_rescue_task_1', agent_type: 'zcode-rescue' }),
        { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'SubAgentActivity', kind: 'started', agent_thread_id: CHILD_THREAD, agent_path: '/root/zcode_rescue_task_1' } } },
        fnCall('wait_agent', 'root-wait-1', { timeout_ms: 600000 }),
      ];
      const childEvents = [
        { type: 'session_meta', payload: { id: CHILD_THREAD, parent_thread_id: PARENT_THREAD, source: { subagent: { thread_spawn: { agent_path: '/root/zcode_rescue_task_1' } } } } },
        wrapperCell('launch-1', `const r = await tools.exec_command(${JSON.stringify({ cmd: LAUNCHER, workdir: '/installed/workspace' })}); text(JSON.stringify(r))\n`),
        wrapperOutput('launch-1', completedOutputBody({ output: '', session_id: HANDLE })),
        wrapperCell('poll-1', `const r = await tools.write_stdin(${JSON.stringify({ session_id: HANDLE, chars: '', yield_time_ms: 60000 })}); text(JSON.stringify(r))\n`),
        wrapperOutput('poll-1', completedOutputBody({ output: SENTINEL, exit_code: 0, session_id: HANDLE })),
      ];
      return [parentMutation ? parentMutation(parentEvents) : parentEvents, childMutation ? childMutation(childEvents) : childEvents];
    }

    test('a Root-side interrupt_agent wrapper cell does not fail the whole case: the Child evidence still adjudicates', () => {
      const rollouts = rescueRollouts({
        parentMutation: (events) => [
          ...events,
          wrapperCell('int-1', `text(await tools.interrupt_agent({"target":"${CHILD_THREAD}"}));`),
          wrapperOutput('int-1', JSON.stringify({ previous_status: 'running' })),
        ],
      });
      const result = inspectShellWaitEvidence({
        rollouts,
        zcodeCalls: [{ method: 'session/send', params: { sessionId: 'fake-session' } }],
        command: LAUNCHER,
        publicResult: SENTINEL,
        workerStillAliveAfterObservation: false,
        redactions: [],
      });
      assert.equal(result.status, 'supported', `the root-control call must not fail the scan: ${JSON.stringify(result.inconclusive)}`);
      assert.equal(result.facts.completion.qualified, true, 'the Root-side control call is not a Child-sequence failure');
    });

    test('a root-control call inside the Child rollout stays a Child discipline violation, never sanctioned', () => {
      const canary = '/private/tmp/review-canary-secret-task';
      const rollouts = rescueRollouts({
        childMutation: (events) => [
          ...events,
          wrapperCell('int-child-1', `text(await tools.interrupt_agent({"target":"${canary}"}));`),
          wrapperOutput('int-child-1', JSON.stringify({ previous_status: 'running' })),
        ],
      });
      const result = inspectShellWaitEvidence({
        rollouts,
        zcodeCalls: [{ method: 'session/send', params: { sessionId: 'fake-session' } }],
        command: LAUNCHER,
        publicResult: SENTINEL,
        workerStillAliveAfterObservation: false,
        redactions: [canary],
      });
      assert.equal(result.status, 'supported', JSON.stringify(result.inconclusive));
      assert.equal(result.facts.completion.qualified, false, 'the Child observational sequence stays closed to root-control calls');
      assert.match(result.facts.completion.reason, /unsupported tool call/i);
      assert.equal(JSON.stringify(result.facts).includes(canary), false, 'the private target never enters the facts');
    });

    // --- P2-1(c): per-poll wall times are retained in facts ---

    test('per-poll wall times are retained in facts: each poll owns its own header value, in event order', () => {
      const parentEvents = [
        { type: 'session_meta', payload: { id: PARENT_THREAD } },
        fnCall('spawn_agent', 'spawn-1', { task_name: 'zcode_rescue_task_1', agent_type: 'zcode-rescue' }),
        { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'SubAgentActivity', kind: 'started', agent_thread_id: CHILD_THREAD, agent_path: '/root/t' } } },
      ];
      const childEvents = [
        { type: 'session_meta', payload: { id: CHILD_THREAD, parent_thread_id: PARENT_THREAD, source: { subagent: { thread_spawn: { agent_path: '/root/t' } } } } },
        wrapperCell('launch-1', `const r = await tools.exec_command(${JSON.stringify({ cmd: LAUNCHER, workdir: '/w' })}); text(JSON.stringify(r))\n`),
        wrapperOutput('launch-1', completedOutputBody({ output: '', session_id: HANDLE })),
        // First poll: the 85000 ms cap-limited return (completed, nonterminal).
        wrapperCell('poll-1', `const r = await tools.write_stdin(${JSON.stringify({ session_id: HANDLE, chars: '', yield_time_ms: 3_600_000 })}); text(JSON.stringify(r))\n`),
        wrapperOutput('poll-1', headerCompletedOutputBody('85.0', { output: '', session_id: HANDLE })),
        // Second poll: the terminal observation at 302.6 s.
        wrapperCell('poll-2', `const r = await tools.write_stdin(${JSON.stringify({ session_id: HANDLE, chars: '', yield_time_ms: 3_600_000 })}); text(JSON.stringify(r))\n`),
        wrapperOutput('poll-2', headerCompletedOutputBody('302.6', { output: SENTINEL, exit_code: 0, session_id: HANDLE })),
      ];
      const result = inspectShellWaitEvidence({
        rollouts: [parentEvents, childEvents],
        zcodeCalls: [{ method: 'session/send', params: { sessionId: 'fake-session' } }],
        command: LAUNCHER,
        publicResult: SENTINEL,
        workerStillAliveAfterObservation: false,
        redactions: [],
      });
      assert.equal(result.status, 'supported', JSON.stringify(result.inconclusive));
      assert.deepEqual(result.facts.observations.pollWallTimesMs, [85000, 302600],
        'each completed poll retains its OWN wall-time header so a cap return is never conflated with the terminal observation');
      assert.deepEqual(result.facts.handle.pollWallTimesMs, [85000, 302600]);
    });

    test('the mapped live facts and the persisted record carry the per-poll wall times', async (t) => {
      const held = {
        endedBeforeGate: false, budgetExpired: false, identity: {}, processAliveWhileHeld: true,
        result: { code: 0, stdout: '', stderr: '' },
        cleanup: { label: 'observation', releasedGate: true, verifiedProcessTerminated: true, codexTerminated: true, nativeInterruptionClaimed: false, errors: [] },
        timeline: null,
      };
      const evidence = {
        status: 'supported',
        facts: {
          completion: { qualified: true, processExit: 0, publicResultMatched: true, decisiveEnd: 'process-exit', structuralViolationCount: 0 },
          linkage: { checked: true, exact: true, agentType: 'zcode-rescue', childThreadId: CHILD_THREAD, parentThreadId: PARENT_THREAD },
          collection: { rolloutCount: 1, childToolCallCount: 3, truncated: false, excerpts: [] },
          companion: { launchCount: 1, sendCount: 1, sendCountKnown: true, duplicateLaunch: false, preLaunchDiagnostics: { excerpts: [], truncated: false } },
          handle: { originalHandleChecked: true },
          observations: { outerReturns: 0, modelCalls: 3, rootJoins: 1, decisiveWallMs: 302600, pendingInnerAtEnd: false, pollWallTimesMs: [85000, 302600] },
        },
      };
      const liveFacts = mapShellWaitLiveFacts(
        { case: 'rescue-long', codexBinary: '/bin/x', sourceSha: 'a'.repeat(40), output: '/o', workerDurationMs: 420_000, capMs: null, pollMs: 3_600_000, budgetMs: 720_000 },
        held, evidence, null, null, mappingFixture, [], [], LAUNCHER,
      );
      assert.deepEqual(liveFacts.observations.pollWallTimesMs, [85000, 302600], 'the mapping carries the per-poll wall times');
      const { mkdtemp, mkdir, rm, readFile } = await import('node:fs/promises');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const temporary = await mkdtemp(join(tmpdir(), 'shell-wait-review-polls-'));
      t.after(() => rm(temporary, { recursive: true, force: true }));
      const output = join(temporary, 'output');
      await mkdir(output, { mode: 0o700 });
      const record = await runShellWaitCase(
        { case: 'rescue-long', codexBinary: process.execPath, sourceSha: 'a'.repeat(40), output, workerDurationMs: 1000, capMs: null, pollMs: 3_600_000, budgetMs: 2000 },
        {
          createFixture: async () => ({
            workspace: join(temporary, 'ws'), codexHome: join(temporary, 'home'),
            installedRoot: join(temporary, 'installed'), env: { CODEX_HOME: join(temporary, 'home') },
            record: { variant: 'candidate', capMs: null, pollMs: 3_600_000, appliedArtifacts: [] },
            dispose: async () => {},
          }),
          executeLiveCase: async () => liveFacts,
        },
      );
      assert.equal(record.status, 'executed');
      const written = JSON.parse(await readFile(join(output, 'rescue-long.record.json'), 'utf8'));
      assert.deepEqual(written.observations.pollWallTimesMs, [85000, 302600], 'the persisted record retains the per-poll wall times for future M re-adjudication');
    });
  });

  describe('review round 2 refinements: exact-target settlement attribution, exactly-one-delivery, preparation-aligned poll timing', async () => {
    const { inspectShellWaitEvidence, extractInterruptInteraction } = await import('../tools/shell-wait-probe/evidence.mjs');
    const { mapShellWaitLiveFacts, runShellWaitCase } = await import('../tools/shell-wait-probe/driver.mjs');

    const CHILD_THREAD = 'c2e7a510-93f4-4b8a-8c1d-6b0f2e4d9a77';
    const FOREIGN_THREAD = 'ffffffff-ffff-4fff-8fff-fffffffffff0';
    const ROOT_THREAD = 'review2-root-thread-1';
    const PARENT_THREAD = 'review2-parent-thread-1';
    const LAUNCHER = 'node "/installed/zcode/skills/rescue/launcher.mjs" invoke-prepared rescue';
    const SENTINEL = 'ZCODE_RESCUE_PUBLIC_SENTINEL_7C9C';
    const HANDLE = 5;

    const at = (second) => `2026-10-06T01:00:${String(second).padStart(2, '0')}Z`;
    const stamped = (timestamp, event) => ({ timestamp, ...event });
    const fnCall = (name, callId, args, timestamp = null) => ({
      ...(timestamp ? stamped(timestamp, {}) : {}),
      type: 'response_item', payload: { type: 'function_call', name, call_id: callId, arguments: JSON.stringify(args) },
    });
    const fnOutput = (callId, output, timestamp = null) => ({
      ...(timestamp ? stamped(timestamp, {}) : {}),
      type: 'response_item', payload: { type: 'function_call_output', call_id: callId, output },
    });
    const interruptCall = (callId, target, timestamp = null) => fnCall('interrupt_agent', callId, { target }, timestamp);
    const interruptSuccess = (callId, previousStatus, timestamp = null) => fnOutput(callId, JSON.stringify({ previous_status: previousStatus }), timestamp);
    const interruptError = (callId, message, timestamp = null) => fnOutput(callId, JSON.stringify({ error: message }), timestamp);
    const completedOutputBody = (result) => [
      { type: 'input_text', text: 'Script completed\n' },
      { type: 'input_text', text: JSON.stringify(result) },
    ];
    const headerCompletedOutputBody = (seconds, result) => [
      { type: 'input_text', text: `Script completed\nWall time ${seconds} seconds\nOutput:\n` },
      { type: 'input_text', text: JSON.stringify(result) },
    ];
    const pendingOutputBody = (cellId) => [{ type: 'input_text', text: `Script running with cell ID ${cellId}\n` }];
    const wrapperCell = (callId, input) => ({ type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: callId, input } });
    const wrapperOutput = (callId, output) => ({ type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: callId, output } });
    const binding = { childThreadId: CHILD_THREAD, command: LAUNCHER };

    /** Child: launch + pending poll (+ optional terminal AFTER the interrupt call). */
    function childRollout({ terminal = null } = {}) {
      return [
        { type: 'session_meta', payload: { id: CHILD_THREAD } },
        stamped(at(0), fnCall('exec_command', 'launch-1', { cmd: LAUNCHER })),
        stamped(at(1), fnOutput('launch-1', completedOutputBody({ output: '', exit_code: 0, session_id: HANDLE }))),
        stamped(at(5), fnCall('write_stdin', 'poll-1', { session_id: HANDLE, chars: '', yield_time_ms: 3_600_000 })),
        stamped(at('05.5'), fnOutput('poll-1', pendingOutputBody('cell-1'))),
        ...(terminal
          ? [stamped(at(11), fnCall('wait', 'outer-1', { cell_id: 'cell-1' })),
            stamped(at(12), fnOutput('outer-1', completedOutputBody(terminal)))]
          : []),
      ];
    }

    const interruptHeld = {
      endedBeforeGate: true, budgetExpired: false, identity: undefined, processAliveWhileHeld: null,
      result: { code: 0, stdout: '', stderr: '' },
      cleanup: { label: 'observation', releasedGate: true, verifiedProcessTerminated: true, codexTerminated: true, nativeInterruptionClaimed: false, errors: [] },
      timeline: { clock: 'held-turn-monotonic-elapsed-ms', launchedAtElapsedMs: 10, observationDetectedAtElapsedMs: 20, pollStartedAtElapsedMs: 30, holdDeadlineElapsedMs: 420_000, rootAcknowledgementAtElapsedMs: null, childSettlementDetectedAtElapsedMs: null, endedAtElapsedMs: 50 },
    };
    const mappingInput = {
      case: 'rescue-interrupt', codexBinary: '/bin/x', sourceSha: 'a'.repeat(40), output: '/o',
      workerDurationMs: 420_000, capMs: null, pollMs: 3_600_000, budgetMs: 720_000,
    };
    const mappingFixture = {
      workspace: '/private/tmp/review2-ws', codexHome: '/private/tmp/review2-home',
      installedRoot: '/private/tmp/review2-installed', env: { HOME: '/private/tmp/review2-home' },
      record: { variant: 'candidate', capMs: null, pollMs: 3_600_000, appliedArtifacts: [] },
    };
    const qualifiedEvidence = (overrides = {}) => ({
      status: 'supported',
      facts: {
        completion: { qualified: true, processExit: 0, publicResultMatched: true, decisiveEnd: 'process-exit', structuralViolationCount: 0 },
        linkage: { checked: true, exact: true, agentType: 'zcode-rescue', childThreadId: CHILD_THREAD, parentThreadId: PARENT_THREAD },
        collection: { rolloutCount: 2, childToolCallCount: 4, truncated: false, excerpts: [] },
        companion: { launchCount: 1, sendCount: 1, sendCountKnown: true, duplicateLaunch: false, preLaunchDiagnostics: { excerpts: [], truncated: false } },
        handle: { originalHandleChecked: true },
        observations: { outerReturns: 1, modelCalls: 4, rootJoins: 1, decisiveWallMs: 302600, pendingInnerAtEnd: false },
        ...overrides,
      },
    });

    // --- P2-1: chronological ordering alone never establishes interruption ---

    test('a delivered interrupt targeting ANOTHER agent never claims the Child settlement or its latency', () => {
      const rollouts = [
        [
          { type: 'session_meta', payload: { id: ROOT_THREAD } },
          stamped(at(7), interruptCall('int-1', FOREIGN_THREAD)),
          stamped(at('07.2'), interruptSuccess('int-1', 'running')),
        ],
        childRollout({ terminal: { output: SENTINEL, exit_code: 0, session_id: HANDLE } }),
      ];
      // The Child completed normally, so the held boundary was reached: no
      // early-exit shape exists for the exemption to be about.
      const held = { ...interruptHeld, endedBeforeGate: false };
      const facts = mapShellWaitLiveFacts(
        mappingInput, held, qualifiedEvidence(),
        null, null, mappingFixture, rollouts, [], LAUNCHER,
      );
      assert.equal(facts.interrupt.attempted, true);
      assert.equal(facts.interrupt.delivered, true, 'the successful foreign delivery stays recorded');
      assert.equal(facts.interrupt.exactTargetMatch, false, 'the target is NOT the observed Child');
      assert.equal(facts.interrupt.callCount, 1);
      assert.equal(facts.interrupt.settled, null, 'a foreign delivery is never the Child settlement');
      assert.match(facts.interrupt.settledBasis, /target-unmatched|unmatched/i,
        'the Child completing normally after an unrelated delivery is not an interruption settlement');
      assert.equal(facts.interrupt.deliveryToSettlementMs, null, 'an unrelated completion supplies no delivery-to-settlement latency');
      assert.equal(facts.interrupt.pendingIntervalMs, 1500, 'the pending-window chronology stays recorded');
      // P2-3 round-7: a foreign-target delivery keeps the interrupt trial
      // inconclusive even when the Child completes normally.
      assert.notEqual(facts.inconclusive, null, 'a foreign-target delivery keeps the trial inconclusive');
      assert.match(facts.inconclusive.reason, /targeted another agent|target-unmatched/i);
    });

    // --- P2-2: exactly-one-delivery contract ---

    test('two interrupt attempts are counted and the last call wins the retained facts', () => {
      const rollouts = [
        [
          { type: 'session_meta', payload: { id: ROOT_THREAD } },
          interruptCall('int-1', FOREIGN_THREAD),
          interruptError('int-1', 'unknown agent: no such thread'),
          stamped(at(7), interruptCall('int-2', CHILD_THREAD)),
          stamped(at('07.2'), interruptSuccess('int-2', 'running')),
        ],
        childRollout({}),
      ];
      const interaction = extractInterruptInteraction(rollouts, [], binding);
      assert.equal(interaction.attempted, true);
      assert.equal(interaction.callCount, 2, 'both interrupt-shaped calls are counted');
      assert.equal(interaction.delivered, true, 'the LAST call\'s delivery outcome is retained');
      assert.deepEqual(interaction.target.value, CHILD_THREAD);
    });

    test('collateral interruption fails the exactly-one-delivery contract: no exemption, ambiguous settlement, count persisted', () => {
      const rollouts = [
        [
          { type: 'session_meta', payload: { id: ROOT_THREAD } },
          stamped(at(6), interruptCall('int-1', FOREIGN_THREAD)),
          stamped(at('06.2'), interruptError('int-1', 'unknown agent: no such thread')),
          stamped(at(7), interruptCall('int-2', CHILD_THREAD)),
          stamped(at('07.2'), interruptSuccess('int-2', 'running')),
        ],
        childRollout({}),
      ];
      const evidence = qualifiedEvidence({
        completion: { qualified: false, processExit: null, publicResultMatched: null, decisiveEnd: null, structuralViolationCount: 0 },
        observations: { outerReturns: 1, modelCalls: 4, rootJoins: 1, decisiveWallMs: null, pendingInnerAtEnd: true },
      });
      const facts = mapShellWaitLiveFacts(
        mappingInput, interruptHeld, evidence,
        null, null, mappingFixture, rollouts, [], LAUNCHER,
      );
      assert.equal(facts.interrupt.callCount, 2, 'the interaction count is persisted in the interrupt facts');
      assert.equal(facts.interrupt.delivered, true, 'the final exact delivery stays recorded');
      assert.equal(facts.interrupt.exactTargetMatch, true);
      assert.equal(facts.interrupt.settled, null, 'two deliveries never attribute settlement');
      assert.match(facts.interrupt.settledBasis, /multiple/i, 'the ambiguity is the recorded reason');
      assert.notEqual(facts.inconclusive, null, 'the exactly-one-delivery contract blocks the interrupt exemption');
      assert.match(facts.inconclusive.reason, /ended before the held completion boundary/u);
    });

    test('the persisted record carries the interrupt interaction count', async (t) => {
      const { mkdtemp, mkdir, rm, readFile } = await import('node:fs/promises');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const temporary = await mkdtemp(join(tmpdir(), 'shell-wait-review2-count-'));
      t.after(() => rm(temporary, { recursive: true, force: true }));
      const output = join(temporary, 'output');
      await mkdir(output, { mode: 0o700 });
      const record = await runShellWaitCase(
        { case: 'rescue-interrupt', codexBinary: process.execPath, sourceSha: 'a'.repeat(40), output, workerDurationMs: 1000, capMs: null, pollMs: 3_600_000, budgetMs: 2000 },
        {
          createFixture: async () => ({
            workspace: join(temporary, 'ws'), codexHome: join(temporary, 'home'),
            installedRoot: join(temporary, 'installed'), env: { CODEX_HOME: join(temporary, 'home') },
            record: { variant: 'candidate', capMs: null, pollMs: 3_600_000, appliedArtifacts: [] },
            dispose: async () => {},
          }),
          executeLiveCase: async () => ({
            codexVersion: null,
            route: { requested: 'named', actual: null },
            hostResult: { exitCode: 0, companionProcessExit: null, sentinelMatched: null, terminalStdoutChecked: null, resultCheck: null, resultCheckLabel: null },
            linkage: { checked: true, mode: 'rescue', rootThreadId: null, childThreadId: CHILD_THREAD, parentThreadId: 'parent-1', companionLaunchCount: 1, companionSendCount: 1, originalHandleChecked: true },
            observations: { outerReturns: 1, modelCalls: 2, rootJoins: 1, decisiveWallMs: null, pendingInnerAtEnd: false },
            interrupt: {
              requested: true, attempted: true, family: 'v2', delivered: true, rejection: null, previousStatus: 'running', callCount: 2,
              target: { kind: 'agent-id', value: CHILD_THREAD, suppressed: false, chars: CHILD_THREAD.length },
              exactTargetMatch: true, settled: null, settledBasis: 'multiple-delivery-attempts-not-attributed',
              pendingIntervalMs: 1500, deliveryToSettlementMs: null, timingBasis: 'rollout-event-timestamps',
              missingPrerequisite: null,
            },
            held: { endedBeforeGate: true, cleanupLabel: 'observation', gateReleased: true, cleanupErrors: { count: 0, reasons: [] }, processTermination: { verifiedTerminated: true, codexTerminated: true }, cleanupComplete: true },
            child: { settlement: null, rootAcknowledgementAtElapsedMs: null, settlementDetectedAtElapsedMs: null },
            statusQuery: null,
            excerpts: [],
            inconclusive: null,
          }),
        },
      );
      assert.equal(record.status, 'executed');
      assert.equal(record.interrupt.callCount, 2);
      const written = JSON.parse(await readFile(join(output, 'rescue-interrupt.record.json'), 'utf8'));
      assert.equal(written.interrupt.callCount, 2, 'the persisted record carries the interaction count');
    });

    // --- P2-3: pollWallTimesMs stays 1:1 with polls (preparation exempt) ---

    test('a preparation continuation never enters pollWallTimesMs: the array stays aligned with polls', () => {
      const preparationEnvelope = {
        version: 5, source: 'explicit', task: 't',
        options: { hostPlacement: 'foreground', companionExecution: 'foreground', foregroundAdapter: 'shell', resume: 'fresh' },
        continuationTarget: null,
      };
      const parentEvents = [
        { type: 'session_meta', payload: { id: PARENT_THREAD } },
        fnCall('spawn_agent', 'spawn-1', { task_name: 'zcode_rescue_task_1', agent_type: 'zcode-rescue' }),
        { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'SubAgentActivity', kind: 'started', agent_thread_id: CHILD_THREAD, agent_path: '/root/t' } } },
      ];
      const childEvents = [
        { type: 'session_meta', payload: { id: CHILD_THREAD, parent_thread_id: PARENT_THREAD, source: { subagent: { thread_spawn: { agent_path: '/root/t' } } } } },
        wrapperCell('launch-1', `const r = await tools.exec_command(${JSON.stringify({ cmd: LAUNCHER, workdir: '/w' })}); text(JSON.stringify(r))\n`),
        wrapperOutput('launch-1', completedOutputBody({ output: '', session_id: HANDLE })),
        // The sanctioned one-shot v5 preparation write: yields, then settles
        // through its linked outer continuation (wall-time header 2.0 s).
        wrapperCell('prep-1', `text(await tools.write_stdin({session_id:${HANDLE},chars:JSON.stringify(${JSON.stringify(preparationEnvelope)})+"\\n"}));\n`),
        wrapperOutput('prep-1', pendingOutputBody('prep-cell')),
        fnCall('wait', 'prep-wait', { cell_id: 'prep-cell' }),
        fnOutput('prep-wait', headerCompletedOutputBody('2.0', { output: '', session_id: HANDLE })),
        // The ONE actual poll: the cap-limited-style terminal observation.
        wrapperCell('poll-1', `const r = await tools.write_stdin(${JSON.stringify({ session_id: HANDLE, chars: '', yield_time_ms: 3_600_000 })}); text(JSON.stringify(r))\n`),
        wrapperOutput('poll-1', pendingOutputBody('cell-1')),
        fnCall('wait', 'outer-1', { cell_id: 'cell-1' }),
        fnOutput('outer-1', headerCompletedOutputBody('30.0', { output: SENTINEL, exit_code: 0, session_id: HANDLE })),
      ];
      const result = inspectShellWaitEvidence({
        rollouts: [parentEvents, childEvents],
        zcodeCalls: [{ method: 'session/send', params: { sessionId: 'fake-session' } }],
        command: LAUNCHER,
        publicResult: SENTINEL,
        workerStillAliveAfterObservation: false,
        redactions: [],
      });
      assert.equal(result.status, 'supported', JSON.stringify(result.inconclusive));
      assert.equal(result.facts.completion.qualified, true);
      assert.equal(result.facts.handle.preparationFrameWrites, 1);
      assert.equal(result.facts.handle.pollCount, 1);
      // The terminal poll yielded and was resolved by its continuation, so
      // its own duration is UNKNOWN (round-3 P2-5: the continuation header
      // measures the wait request, never the inner poll) — the preparation
      // continuation is exempt AND the poll's duration stays null, keeping
      // the array 1:1 with polls.
      assert.deepEqual(result.facts.handle.pollWallTimesMs, [null],
        'pollWallTimesMs contains ONLY actual poll durations — the preparation continuation is exempt, the yielded poll stays unknown');
      assert.deepEqual(result.facts.observations.pollWallTimesMs, [null]);
    });
  });

  describe('review round 3 refinements: scoped exemption, resolved pending state, handle-bound watches, poll-owned timing', async () => {
    const { inspectShellWaitEvidence, extractInterruptInteraction } = await import('../tools/shell-wait-probe/evidence.mjs');
    const { mapShellWaitLiveFacts, runHeldHostTurn, waitForChildSettlementObservation, waitForPollObservation } = await import('../tools/shell-wait-probe/driver.mjs');

    const CHILD_THREAD = 'd4a1c2b3-11aa-4c5d-9e2f-7a8b9c0d1e2f';
    const ROOT_THREAD = 'review3-root-thread-1';
    const PARENT_THREAD = 'review3-parent-thread-1';
    const LAUNCHER = 'node "/installed/zcode/skills/rescue/launcher.mjs" invoke-prepared rescue';
    const SENTINEL = 'ZCODE_RESCUE_PUBLIC_SENTINEL_7C9C';
    const HANDLE = 5;

    const at = (second) => `2026-10-06T02:00:${String(second).padStart(2, '0')}Z`;
    const stamped = (timestamp, event) => ({ timestamp, ...event });
    const fnCall = (name, callId, args, timestamp = null) => ({
      ...(timestamp ? stamped(timestamp, {}) : {}),
      type: 'response_item', payload: { type: 'function_call', name, call_id: callId, arguments: JSON.stringify(args) },
    });
    const fnOutput = (callId, output, timestamp = null) => ({
      ...(timestamp ? stamped(timestamp, {}) : {}),
      type: 'response_item', payload: { type: 'function_call_output', call_id: callId, output },
    });
    const interruptCall = (callId, target, timestamp = null) => fnCall('interrupt_agent', callId, { target }, timestamp);
    const interruptSuccess = (callId, previousStatus, timestamp = null) => fnOutput(callId, JSON.stringify({ previous_status: previousStatus }), timestamp);
    const completedOutputBody = (result) => [
      { type: 'input_text', text: 'Script completed\n' },
      { type: 'input_text', text: JSON.stringify(result) },
    ];
    const headerCompletedOutputBody = (seconds, result) => [
      { type: 'input_text', text: `Script completed\nWall time ${seconds} seconds\nOutput:\n` },
      { type: 'input_text', text: JSON.stringify(result) },
    ];
    const pendingOutputBody = (cellId) => [{ type: 'input_text', text: `Script running with cell ID ${cellId}\n` }];
    const wrapperCell = (callId, input) => ({ type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: callId, input } });
    const wrapperOutput = (callId, output) => ({ type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: callId, output } });

    /** Child: launch + poll pending at 05.5 (+ a NONTERMINAL completed resolution at 06.5, + optional terminal). */
    function childRollout({ resolvedRunning = false, terminal = null } = {}) {
      return [
        { type: 'session_meta', payload: { id: CHILD_THREAD } },
        stamped(at(0), fnCall('exec_command', 'launch-1', { cmd: LAUNCHER })),
        stamped(at(1), fnOutput('launch-1', completedOutputBody({ output: '', exit_code: 0, session_id: HANDLE }))),
        stamped(at(5), fnCall('write_stdin', 'poll-1', { session_id: HANDLE, chars: '', yield_time_ms: 3_600_000 })),
        stamped(at('05.5'), fnOutput('poll-1', pendingOutputBody('cell-1'))),
        ...(resolvedRunning
          ? [stamped(at(6), fnCall('write_stdin', 'poll-2', { session_id: HANDLE, chars: '', yield_time_ms: 60_000 })),
            stamped(at('06.5'), fnOutput('poll-2', completedOutputBody({ output: '', session_id: HANDLE })))]
          : []),
        ...(terminal
          ? [stamped(at(11), fnCall('wait', 'outer-1', { cell_id: 'cell-1' })),
            stamped(at(12), fnOutput('outer-1', completedOutputBody(terminal)))]
          : []),
      ];
    }
    const rootWithInterrupt = (target = CHILD_THREAD, second = '07') => [
      { type: 'session_meta', payload: { id: ROOT_THREAD } },
      stamped(at(second), interruptCall('int-1', target)),
      stamped(at('07.2'), interruptSuccess('int-1', 'running')),
    ];
    const mappingFixture = {
      workspace: '/private/tmp/review3-ws', codexHome: '/private/tmp/review3-home',
      installedRoot: '/private/tmp/review3-installed', env: { HOME: '/private/tmp/review3-home' },
      record: { variant: 'candidate', capMs: null, pollMs: 3_600_000, appliedArtifacts: [] },
    };
    const interruptHeld = {
      endedBeforeGate: true, budgetExpired: false, identity: undefined, processAliveWhileHeld: null,
      result: { code: 0, stdout: '', stderr: '' },
      cleanup: { label: 'observation', releasedGate: true, verifiedProcessTerminated: true, codexTerminated: true, nativeInterruptionClaimed: false, errors: [] },
      timeline: { clock: 'held-turn-monotonic-elapsed-ms', launchedAtElapsedMs: 10, observationDetectedAtElapsedMs: 20, pollStartedAtElapsedMs: 30, holdDeadlineElapsedMs: 420_000, rootAcknowledgementAtElapsedMs: null, childSettlementDetectedAtElapsedMs: null, endedAtElapsedMs: 50 },
    };
    const unqualifiedEvidence = (overrides = {}) => ({
      status: 'supported',
      facts: {
        completion: { qualified: false, processExit: null, publicResultMatched: null, decisiveEnd: null, structuralViolationCount: 0 },
        linkage: { checked: true, exact: true, agentType: 'zcode-rescue', childThreadId: CHILD_THREAD, parentThreadId: PARENT_THREAD },
        collection: { rolloutCount: 2, childToolCallCount: 4, truncated: false, excerpts: [] },
        companion: { launchCount: 1, sendCount: 1, sendCountKnown: true, duplicateLaunch: false, preLaunchDiagnostics: { excerpts: [], truncated: false } },
        handle: { originalHandleChecked: true },
        observations: { outerReturns: 0, modelCalls: 3, rootJoins: 1, decisiveWallMs: null, pendingInnerAtEnd: true },
        ...overrides,
      },
    });

    // --- P2-1: the exemption is the rescue-interrupt case's own contract ---

    test('the completion exemption never fires outside the rescue-interrupt case', () => {
      // A structurally-valid rescue-long rollout: pending observation, no
      // exit, no sentinel — plus an unexpected interrupt delivery. The
      // interrupt facts stay recorded, but the completion failure stands.
      const input = { case: 'rescue-long', codexBinary: '/bin/x', sourceSha: 'a'.repeat(40), output: '/o', workerDurationMs: 420_000, capMs: null, pollMs: 3_600_000, budgetMs: 720_000 };
      const facts = mapShellWaitLiveFacts(
        input, interruptHeld, unqualifiedEvidence(),
        null, null, mappingFixture,
        [rootWithInterrupt(), childRollout()], [], LAUNCHER,
      );
      assert.equal(facts.interrupt.delivered, true, 'the unexpected delivery stays recorded');
      assert.equal(facts.interrupt.exactTargetMatch, true);
      assert.equal(facts.interrupt.callCount, 1);
      assert.notEqual(facts.inconclusive, null, 'an interrupt during another case never excuses its terminal-completion failures');
      assert.match(facts.inconclusive.reason, /ended before the held completion boundary/u);
    });

    // --- P2-2: a resolved pending observation is no longer pending ---

    test('a nonterminal completed response resolves the pending state: no pending window at the call', () => {
      const rollouts = [rootWithInterrupt(), childRollout({ resolvedRunning: true })];
      const interaction = extractInterruptInteraction(rollouts, [], { childThreadId: CHILD_THREAD, command: LAUNCHER });
      assert.equal(interaction.orderingBound, true);
      assert.equal(interaction.pendingBeforeCall.observed, false,
        'the poll resolved to a still-running state at 06.5 — the historical 05.5 pending header is not a pending observation at 07');
    });

    test('an interrupt outside any outstanding pending observation earns no exemption and no timing', () => {
      const facts = mapShellWaitLiveFacts(
        { case: 'rescue-interrupt', codexBinary: '/bin/x', sourceSha: 'a'.repeat(40), output: '/o', workerDurationMs: 420_000, capMs: null, pollMs: 3_600_000, budgetMs: 720_000 },
        interruptHeld, unqualifiedEvidence(),
        null, null, mappingFixture,
        [rootWithInterrupt(), childRollout({ resolvedRunning: true })], [], LAUNCHER,
      );
      assert.equal(facts.interrupt.delivered, true);
      assert.equal(facts.interrupt.exactTargetMatch, true);
      assert.equal(facts.interrupt.orderingBound, true);
      assert.equal(facts.interrupt.pendingIntervalMs, null, 'no outstanding pending observation means no pending interval');
      assert.equal(facts.interrupt.deliveryToSettlementMs, null);
      assert.equal(facts.interrupt.timingBasis, 'unavailable');
      assert.notEqual(facts.inconclusive, null, 'without a confirmed pending window the exemption cannot fire');
    });

    // --- P2-3: the settlement watch binds to the launch handle + linked observations ---

    test('the settlement watch resolves only through the launch handle and its linked polls/continuations', async () => {
      const realRollout = [
        { type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c1', input: `const r = await tools.exec_command(${JSON.stringify({ cmd: LAUNCHER })}); text(JSON.stringify(r))\n` } },
        { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c1', output: completedOutputBody({ output: '', exit_code: 0, session_id: HANDLE }) } },
        // An UNRELATED later command whose output carries an exit code: never
        // the Companion settlement.
        { type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'cat-1', arguments: JSON.stringify({ cmd: 'cat notes.txt' }) } },
        { type: 'response_item', payload: { type: 'function_call_output', call_id: 'cat-1', output: completedOutputBody({ output: 'notes', exit_code: 0 }) } },
        // A FOREIGN-handle poll with an exit-code output: not this handle.
        { type: 'response_item', payload: { type: 'function_call', name: 'write_stdin', call_id: 'foreign-poll', arguments: JSON.stringify({ session_id: 9, chars: '', yield_time_ms: 60_000 }) } },
        { type: 'response_item', payload: { type: 'function_call_output', call_id: 'foreign-poll', output: completedOutputBody({ output: 'x', exit_code: 0, session_id: 9 }) } },
        // The REAL settlement: a poll on the ORIGINAL handle, then its linked
        // continuation completing with the exit code.
        { type: 'response_item', payload: { type: 'function_call', name: 'write_stdin', call_id: 'poll-1', arguments: JSON.stringify({ session_id: HANDLE, chars: '', yield_time_ms: 60_000 }) } },
        { type: 'response_item', payload: { type: 'function_call_output', call_id: 'poll-1', output: pendingOutputBody('cell-1') } },
        { type: 'response_item', payload: { type: 'function_call', name: 'wait', call_id: 'outer-1', arguments: JSON.stringify({ cell_id: 'cell-1' }) } },
        { type: 'response_item', payload: { type: 'function_call_output', call_id: 'outer-1', output: completedOutputBody({ output: SENTINEL, exit_code: 0, session_id: HANDLE }) } },
      ];
      let loads = 0;
      const settlement = await waitForChildSettlementObservation('/codex-home', LAUNCHER, { aborted: false, addEventListener() {} }, {
        loadRollouts: async () => {
          loads += 1;
          return loads >= 2 ? [realRollout] : [];
        },
        sleep: async () => {},
      });
      assert.equal(settlement.observed, true);
      assert.equal(settlement.basis, 'exact-launch-handle-linked-completed-exit-code-output');
    });

    test('unrelated exit-code outputs never settle the watch while the Companion stays pending', async () => {
      const pendingRollout = [
        { type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c1', input: `const r = await tools.exec_command(${JSON.stringify({ cmd: LAUNCHER })}); text(JSON.stringify(r))\n` } },
        { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c1', output: completedOutputBody({ output: '', exit_code: 0, session_id: HANDLE }) } },
        { type: 'response_item', payload: { type: 'function_call', name: 'write_stdin', call_id: 'poll-1', arguments: JSON.stringify({ session_id: HANDLE, chars: '', yield_time_ms: 60_000 }) } },
        { type: 'response_item', payload: { type: 'function_call_output', call_id: 'poll-1', output: pendingOutputBody('cell-1') } },
        // Unrelated commands finishing with exit codes while the Companion is
        // still pending: NOT settlement.
        { type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'cat-1', arguments: JSON.stringify({ cmd: 'cat notes.txt' }) } },
        { type: 'response_item', payload: { type: 'function_call_output', call_id: 'cat-1', output: completedOutputBody({ output: 'notes', exit_code: 0 }) } },
        { type: 'response_item', payload: { type: 'function_call', name: 'write_stdin', call_id: 'foreign-poll', arguments: JSON.stringify({ session_id: 9, chars: '', yield_time_ms: 60_000 }) } },
        { type: 'response_item', payload: { type: 'function_call_output', call_id: 'foreign-poll', output: completedOutputBody({ output: 'x', exit_code: 0, session_id: 9 }) } },
      ];
      const controller = new AbortController();
      let loads = 0;
      await assert.rejects(
        waitForChildSettlementObservation('/codex-home', LAUNCHER, controller.signal, {
          loadRollouts: async () => {
            loads += 1;
            if (loads >= 3) controller.abort();
            return [pendingRollout];
          },
          sleep: async () => {},
        }),
        /aborted/u,
        'an unrelated or foreign-handle exit-code output must never be counted as Child settlement',
      );
    });

    // --- P2-4: the poll-start watch binds to the selected rollout + the original handle ---

    test('the poll-start watch fires only on an empty-input poll to the exact launch handle', async () => {
      const observedRollout = [
        { type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c1', input: `const r = await tools.exec_command(${JSON.stringify({ cmd: LAUNCHER })}); text(JSON.stringify(r))\n` } },
        { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c1', output: completedOutputBody({ output: '', exit_code: 0, session_id: HANDLE }) } },
        // A foreign-handle poll and a NONEMPTY write never trigger.
        { type: 'response_item', payload: { type: 'function_call', name: 'write_stdin', call_id: 'foreign-poll', arguments: JSON.stringify({ session_id: 9, chars: '', yield_time_ms: 60_000 }) } },
        { type: 'response_item', payload: { type: 'function_call', name: 'write_stdin', call_id: 'nonempty', arguments: JSON.stringify({ session_id: HANDLE, chars: 'x', yield_time_ms: 60_000 }) } },
        // THE measured poll start: empty-input write_stdin to the launch handle.
        { type: 'response_item', payload: { type: 'function_call', name: 'write_stdin', call_id: 'poll-1', arguments: JSON.stringify({ session_id: HANDLE, chars: '', yield_time_ms: 60_000 }) } },
      ];
      let loads = 0;
      const observed = await waitForPollObservation('/codex-home', LAUNCHER, { aborted: false, addEventListener() {} }, {
        loadRollouts: async () => {
          loads += 1;
          return loads >= 2 ? [observedRollout] : [];
        },
        sleep: async () => {},
      });
      assert.equal(observed, undefined, 'the watch resolves on the measured original-handle poll start');
    });

    test('an empty-input write_stdin without the exact launch or on a foreign handle never triggers the poll-start watch', async () => {
      const unboundRollout = [
        // An empty-input poll in a rollout with NO exact launch: never the
        // measured poll start.
        { type: 'response_item', payload: { type: 'function_call', name: 'write_stdin', call_id: 'pre-poll', arguments: JSON.stringify({ session_id: 7, chars: '', yield_time_ms: 60_000 }) } },
      ];
      const foreignHandleRollout = [
        { type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c1', input: `const r = await tools.exec_command(${JSON.stringify({ cmd: LAUNCHER })}); text(JSON.stringify(r))\n` } },
        { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c1', output: completedOutputBody({ output: '', exit_code: 0, session_id: HANDLE }) } },
        { type: 'response_item', payload: { type: 'function_call', name: 'write_stdin', call_id: 'foreign-poll', arguments: JSON.stringify({ session_id: 9, chars: '', yield_time_ms: 60_000 }) } },
      ];
      const controller = new AbortController();
      let loads = 0;
      await assert.rejects(
        waitForPollObservation('/codex-home', LAUNCHER, controller.signal, {
          loadRollouts: async () => {
            loads += 1;
            if (loads >= 4) controller.abort();
            return loads % 2 === 0 ? [unboundRollout] : [foreignHandleRollout];
          },
          sleep: async () => {},
        }),
        /aborted/u,
        'a foreign-handle or launch-less empty poll must never be the measured poll start',
      );
    });

    // --- P2-5: pollWallTimesMs carries the INNER POLL's own timing ---

    test('a continuation-resolved poll keeps an UNKNOWN duration, never the final wait response duration', () => {
      const parentEvents = [
        { type: 'session_meta', payload: { id: PARENT_THREAD } },
        fnCall('spawn_agent', 'spawn-1', { task_name: 'zcode_rescue_task_1', agent_type: 'zcode-rescue' }),
        { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'SubAgentActivity', kind: 'started', agent_thread_id: CHILD_THREAD, agent_path: '/root/t' } } },
      ];
      const childEvents = [
        { type: 'session_meta', payload: { id: CHILD_THREAD, parent_thread_id: PARENT_THREAD, source: { subagent: { thread_spawn: { agent_path: '/root/t' } } } } },
        wrapperCell('launch-1', `const r = await tools.exec_command(${JSON.stringify({ cmd: LAUNCHER, workdir: '/w' })}); text(JSON.stringify(r))\n`),
        wrapperOutput('launch-1', completedOutputBody({ output: '', session_id: HANDLE })),
        // The poll yields (its own response carries no timing), then the
        // linked continuation completes with ITS OWN 5-second wait header.
        wrapperCell('poll-1', `const r = await tools.write_stdin(${JSON.stringify({ session_id: HANDLE, chars: '', yield_time_ms: 3_600_000 })}); text(JSON.stringify(r))\n`),
        wrapperOutput('poll-1', pendingOutputBody('cell-1')),
        fnCall('wait', 'outer-1', { cell_id: 'cell-1' }),
        fnOutput('outer-1', headerCompletedOutputBody('5.0', { output: SENTINEL, exit_code: 0, session_id: HANDLE })),
      ];
      const result = inspectShellWaitEvidence({
        rollouts: [parentEvents, childEvents],
        zcodeCalls: [{ method: 'session/send', params: { sessionId: 'fake-session' } }],
        command: LAUNCHER,
        publicResult: SENTINEL,
        workerStillAliveAfterObservation: false,
        redactions: [],
      });
      assert.equal(result.status, 'supported', JSON.stringify(result.inconclusive));
      assert.deepEqual(result.facts.handle.pollWallTimesMs, [null],
        'the continuation header measures the wait request, never the inner poll: the duration stays unknown');
      assert.deepEqual(result.facts.observations.pollWallTimesMs, [null]);
      assert.equal(result.facts.completion.decisiveWallMs, 5000, 'the terminal observation keeps its own header as the decisive wall time');
    });

    // --- P2-6: the poll-start watch compares on one clock origin ---

    test('a poll-start detection after the hold deadline leaves the poll-start fact unknown', async () => {
      let resolveResult;
      const result = new Promise((resolve) => { resolveResult = resolve; });
      // A long-lived process clock (large monotonic origin) with 10 ms ticks:
      // the hold deadline sits at origin+~110 while the poll-start watch
      // resolves at origin+5000 — AFTER the deadline. The old comparison
      // mixed clocks (relative elapsed vs absolute deadline: always true),
      // recording a post-hold detection as the poll start.
      let tick = 1_000_000;
      const now = () => (tick += 10);
      const held = await runHeldHostTurn({
        launch: async () => ({ result, terminate: async () => {} }),
        waitForGate: async () => {},
        waitForObservation: async () => {},
        waitForPollStart: async () => { tick += 5000; },
        captureProcessIdentity: async () => ({ pid: 77101, ppid: 75, nonce: 'n3', startIdentity: 'start-a' }),
        readProcessIdentity: async () => ({ pid: 77101, ppid: 75, nonce: 'n3', startIdentity: 'start-a' }),
        waitForProcessExit: async () => {},
        releaseGate: async () => { resolveResult({ code: 0, stdout: 'sentinel', stderr: '' }); },
        sleep: async () => { tick += 1000; },
        now,
        holdMs: 100,
        budgetMs: 60_000,
      });
      assert.equal(held.endedBeforeGate, false);
      assert.equal(held.timeline.pollStartedAtElapsedMs, null,
        'a detection after the hold deadline is never recorded as the poll start');
    });
  });

  describe('review round 4 refinements: literal interrupt wrappers and the Status query-turn scope', async () => {
    const { inspectShellWaitEvidence, extractInterruptInteraction } = await import('../tools/shell-wait-probe/evidence.mjs');
    const { shellWaitEvidenceRequest, findStatusSetupTurnBoundary } = await import('../tools/shell-wait-probe/driver.mjs');

    const CHILD_THREAD = 'e5b2d3c4-22bb-4d6e-8f3a-8b9c0d1e2f3a';
    const ROOT_THREAD = 'review4-root-thread-1';
    const LAUNCHER = 'node "/installed/zcode/skills/rescue/launcher.mjs" invoke-prepared rescue';
    const SESSION = 'sess-status-two-turn';
    const COMPANION = 'node "/installed/zcode/scripts/zcode-companion.mjs"';
    const REVIEW_COMMAND = `${COMPANION} invoke review --background`;
    const STATUS_COMMAND = `${COMPANION} invoke status`;
    const STATUS_JOB_ID = 'bb22cc33dd44ee55ff66aa11bb22cc33dd44ee55ff66aa11bb22cc33dd44ee55';
    const statusTerminalOutput = [
      `Job: ${STATUS_JOB_ID}`,
      'Command: review',
      'Status: succeeded',
      'Progress:',
      '  - none',
    ].join('\n') + '\n';
    const STATUS_MARKERS = ['Job: ', 'Status: '];

    const stamped = (timestamp, event) => ({ timestamp, ...event });
    const fnCall = (name, callId, args, timestamp = null) => ({
      ...(timestamp ? stamped(timestamp, {}) : {}),
      type: 'response_item', payload: { type: 'function_call', name, call_id: callId, arguments: JSON.stringify(args) },
    });
    const fnOutput = (callId, output, timestamp = null) => ({
      ...(timestamp ? stamped(timestamp, {}) : {}),
      type: 'response_item', payload: { type: 'function_call_output', call_id: callId, output },
    });
    const completedOutputBody = (result) => [
      { type: 'input_text', text: 'Script completed\n' },
      { type: 'input_text', text: JSON.stringify(result) },
    ];
    const pendingOutputBody = (cellId) => [{ type: 'input_text', text: `Script running with cell ID ${cellId}\n` }];
    const wrapperCell = (callId, input) => ({ type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: callId, input } });
    const wrapperOutput = (callId, output) => ({ type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: callId, output } });

    // --- P2-1: the interrupt wrapper decodes with the supported literal parser ---

    test('a JS-literal interrupt wrapper (unquoted key) decodes like the supported-call path', () => {
      const rollouts = [[
        { type: 'session_meta', payload: { id: ROOT_THREAD } },
        // The observed installed emission shape: an unquoted JS object key.
        wrapperCell('int-1', `text(await tools.interrupt_agent({target:"${CHILD_THREAD}"}));`),
        wrapperOutput('int-1', JSON.stringify({ previous_status: 'running' })),
      ]];
      const interaction = extractInterruptInteraction(rollouts, []);
      assert.equal(interaction.attempted, true, 'the literal form is the same call parseCallStatements recognizes');
      assert.equal(interaction.family, 'v2');
      assert.equal(interaction.delivered, true);
      assert.deepEqual(interaction.target, { kind: 'agent-id', value: CHILD_THREAD, suppressed: false, chars: CHILD_THREAD.length });
    });

    test('a JS-literal V1 send_input wrapper with the interrupt flag decodes too', () => {
      const rollouts = [[
        { type: 'session_meta', payload: { id: ROOT_THREAD } },
        wrapperCell('si-1', `text(await tools.send_input({target:"${CHILD_THREAD}", interrupt:true}));`),
        wrapperOutput('si-1', JSON.stringify({ submission_id: 'sub-1' })),
      ]];
      const interaction = extractInterruptInteraction(rollouts, []);
      assert.equal(interaction.attempted, true);
      assert.equal(interaction.family, 'v1');
      assert.equal(interaction.delivered, true);
      assert.equal(interaction.previousStatus, null);
    });

    test('a literal wrapper with a private target stays suppressed (R0 rules apply to the literal path)', () => {
      const canary = '/private/tmp/review4-canary-secret';
      const rollouts = [[
        { type: 'session_meta', payload: { id: ROOT_THREAD } },
        wrapperCell('int-1', `text(await tools.interrupt_agent({target:"${canary}"}));`),
        wrapperOutput('int-1', JSON.stringify({ previous_status: 'running' })),
      ]];
      const interaction = extractInterruptInteraction(rollouts, [canary]);
      assert.equal(interaction.attempted, true);
      assert.equal(interaction.target.kind, 'unknown');
      assert.equal(interaction.target.value, null, 'the private target never enters the facts through the literal path');
      assert.equal(interaction.target.chars, canary.length);
      assert.equal(JSON.stringify(interaction).includes('review4-canary-secret'), false);
    });

    // --- P2-2: the Status query turn is measured alone when the boundary holds ---

    function twoTurnStatusRollout() {
      return [
        { type: 'session_meta', payload: { id: SESSION } },
        // SETUP TURN (turn 1): the background Review launch, its handle, one
        // legitimate empty-input poll, and its settled continuation.
        wrapperCell('setup-launch', `const r = await tools.exec_command(${JSON.stringify({ cmd: REVIEW_COMMAND, workdir: '/w' })}); text(JSON.stringify(r))\n`),
        wrapperOutput('setup-launch', completedOutputBody({ output: '', session_id: 9 })),
        wrapperCell('setup-poll', `const r = await tools.write_stdin(${JSON.stringify({ session_id: 9, chars: '', yield_time_ms: 60_000 })}); text(JSON.stringify(r))\n`),
        wrapperOutput('setup-poll', pendingOutputBody('cell-1')),
        fnCall('wait', 'setup-wait', { cell_id: 'cell-1' }),
        fnOutput('setup-wait', completedOutputBody({ output: 'review running in background', exit_code: 0, session_id: 9 })),
        // QUERY TURN (turn 2, the resumed session): the exact Status command.
        wrapperCell('query-launch', `const r = await tools.exec_command(${JSON.stringify({ cmd: STATUS_COMMAND, workdir: '/w' })}); text(JSON.stringify(r))\n`),
        wrapperOutput('query-launch', completedOutputBody({ output: '', session_id: 8 })),
        wrapperCell('query-poll', `const r = await tools.write_stdin(${JSON.stringify({ session_id: 8, chars: '', yield_time_ms: 3_600_000 })}); text(JSON.stringify(r))\n`),
        wrapperOutput('query-poll', pendingOutputBody('cell-2')),
        fnCall('wait', 'query-wait', { cell_id: 'cell-2' }),
        fnOutput('query-wait', completedOutputBody({ output: statusTerminalOutput, exit_code: 0, session_id: 8 })),
      ];
    }
    const statusEvidenceInput = (input = {}) => ({
      rollouts: [twoTurnStatusRollout()],
      zcodeCalls: [{ method: 'session/send', params: { sessionId: 'fake-session' } }],
      command: STATUS_COMMAND,
      mode: /** @type {const} */ ('root'),
      publicResultMarkers: STATUS_MARKERS,
      workerStillAliveAfterObservation: false,
      redactions: [],
      ...input,
    });

    test('without a boundary the setup turn keeps the Status case unqualified (fail closed)', () => {
      const result = inspectShellWaitEvidence(statusEvidenceInput());
      assert.equal(result.status, 'supported', JSON.stringify(result.inconclusive));
      assert.equal(result.facts.completion.qualified, false, 'the unbounded analysis counts the setup poll as a foreign-handle observation');
      assert.equal(result.facts.handle.foreignHandlePolls >= 1, true);
    });

    test('the established query-turn boundary scopes the analysis to the measured turn', () => {
      const result = inspectShellWaitEvidence(statusEvidenceInput({
        rootQueryTurn: { sessionId: SESSION, setupEventCount: 7 },
      }));
      assert.equal(result.status, 'supported', JSON.stringify(result.inconclusive));
      assert.equal(result.facts.completion.qualified, true, 'the legitimate setup poll neither counts as foreign-handle polling nor as an overlap');
      assert.equal(result.facts.handle.originalHandleId, 8);
      assert.equal(result.facts.handle.pollCount, 1);
      assert.equal(result.facts.handle.foreignHandlePolls, 0);
      assert.equal(result.facts.handle.originalHandleChecked, true);
      assert.equal(result.facts.linkage.queryTurnScoped, true, 'the applied boundary is recorded');
    });

    test('a boundary that does not match the identified Root session fails closed', () => {
      const result = inspectShellWaitEvidence(statusEvidenceInput({
        rootQueryTurn: { sessionId: 'sess-other', setupEventCount: 7 },
      }));
      assert.equal(result.status, 'supported', JSON.stringify(result.inconclusive));
      assert.equal(result.facts.completion.qualified, false, 'an unestablishable boundary never excuses the setup observations');
      assert.equal(result.facts.linkage.queryTurnScoped, false);
    });

    test('the driver evidence request carries the query-turn boundary for Status only', () => {
      const queryTurn = { sessionId: SESSION, setupEventCount: 7 };
      const statusRequest = shellWaitEvidenceRequest({
        case: 'status-wait', command: STATUS_COMMAND, rollouts: [], zcodeCalls: [],
        workerDurationMs: 130_000, pollMs: 3_600_000, workerStillAliveAfterObservation: false, queryTurn,
      });
      assert.deepEqual(statusRequest.rootQueryTurn, queryTurn, 'the Status request carries the boundary');
      const reviewRequest = shellWaitEvidenceRequest({
        case: 'review-wait', command: REVIEW_COMMAND, rollouts: [], zcodeCalls: [],
        workerDurationMs: 130_000, pollMs: 3_600_000, workerStillAliveAfterObservation: false, queryTurn,
      });
      assert.equal(reviewRequest.rootQueryTurn, undefined, 'single-turn root cases never carry a boundary');
      const rescueRequest = shellWaitEvidenceRequest({
        case: 'rescue-long', command: LAUNCHER, rollouts: [], zcodeCalls: [],
        workerDurationMs: 420_000, pollMs: 3_600_000, workerStillAliveAfterObservation: false, queryTurn,
      });
      assert.equal(rescueRequest.rootQueryTurn, undefined);
    });

    test('the setup-turn boundary derives from the observed launch session rollout, and fails closed without it', () => {
      const launchRollouts = [
        [{ type: 'session_meta', payload: { id: 'unrelated' } }],
        twoTurnStatusRollout().slice(0, 7),
      ];
      assert.deepEqual(
        findStatusSetupTurnBoundary(launchRollouts, SESSION),
        { sessionId: SESSION, setupEventCount: 7 },
      );
      assert.equal(findStatusSetupTurnBoundary(launchRollouts, 'sess-missing'), null);
      assert.equal(findStatusSetupTurnBoundary([], SESSION), null);
    });
  });

  describe('review round 5 refinements: per-statement interrupt counting and held-ordering settlement', async () => {
    const { extractInterruptInteraction } = await import('../tools/shell-wait-probe/evidence.mjs');
    const { mapShellWaitLiveFacts, runHeldHostTurn } = await import('../tools/shell-wait-probe/driver.mjs');

    const CHILD_THREAD = 'f6c3e4d5-33cc-4e7f-9a4b-9c0d1e2f3a4b';
    const FOREIGN_THREAD = 'ffffffff-ffff-4fff-8fff-fffffffffff0';
    const ROOT_THREAD = 'review5-root-thread-1';
    const LAUNCHER = 'node "/installed/zcode/skills/rescue/launcher.mjs" invoke-prepared rescue';

    const at = (second) => `2026-10-06T03:00:${String(second).padStart(2, '0')}Z`;
    const stamped = (timestamp, event) => ({ timestamp, ...event });
    const fnOutput = (callId, output, timestamp = null) => ({
      ...(timestamp ? stamped(timestamp, {}) : {}),
      type: 'response_item', payload: { type: 'function_call_output', call_id: callId, output },
    });
    const completedOutputBody = (result) => [
      { type: 'input_text', text: 'Script completed\n' },
      { type: 'input_text', text: JSON.stringify(result) },
    ];
    const pendingOutputBody = (cellId) => [{ type: 'input_text', text: `Script running with cell ID ${cellId}\n` }];
    const wrapperCell = (callId, input) => ({ type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: callId, input } });
    const wrapperOutput = (callId, output) => ({ type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: callId, output } });
    const binding = { childThreadId: CHILD_THREAD, command: LAUNCHER };

    /** Child: launch + pending poll (stamped, for the confirmed pending window). */
    const childRollout = [
      { type: 'session_meta', payload: { id: CHILD_THREAD } },
      stamped(at(0), { type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'launch-1', arguments: JSON.stringify({ cmd: LAUNCHER }) } }),
      stamped(at(1), fnOutput('launch-1', completedOutputBody({ output: '', exit_code: 0, session_id: 5 }))),
      stamped(at(5), { type: 'response_item', payload: { type: 'function_call', name: 'write_stdin', call_id: 'poll-1', arguments: JSON.stringify({ session_id: 5, chars: '', yield_time_ms: 3_600_000 }) } }),
      stamped(at('05.5'), fnOutput('poll-1', pendingOutputBody('cell-1'))),
    ];

    // --- P2-1: interrupts are counted per supported statement, not per whole cell ---

    test('a collateral interrupt inside a supported multi-statement cell counts: two deliveries, not one', () => {
      const rollouts = [
        [
          { type: 'session_meta', payload: { id: ROOT_THREAD } },
          // A SUPPORTED cell: an exec_command statement followed by a
          // collateral interrupt statement — the whole-cell regex never saw
          // the interrupt.
          wrapperCell('cell-1', `const r = await tools.exec_command(${JSON.stringify({ cmd: 'cat notes.txt' })}); text(JSON.stringify(r))\ntext(await tools.interrupt_agent({target:"${FOREIGN_THREAD}"}));\n`),
          wrapperOutput('cell-1', completedOutputBody({ output: 'notes', exit_code: 0 })),
          // The separate exact-target interrupt.
          wrapperCell('cell-2', `text(await tools.interrupt_agent({target:"${CHILD_THREAD}"}));\n`),
          wrapperOutput('cell-2', JSON.stringify({ previous_status: 'running' })),
        ],
        childRollout,
      ];
      const interaction = extractInterruptInteraction(rollouts, [], binding);
      assert.equal(interaction.orderingBound, true);
      assert.equal(interaction.callCount, 2, 'BOTH interrupt statements count — the collateral one is never silently dropped');
      assert.equal(interaction.attempted, true);
      assert.equal(interaction.delivered, true, 'the last (exact) delivery stays the retained outcome');
      assert.deepEqual(interaction.target.value, CHILD_THREAD);
    });

    test('a directive-prefixed interrupt cell counts too', () => {
      const rollouts = [[
        { type: 'session_meta', payload: { id: ROOT_THREAD } },
        wrapperCell('cell-1', `// @exec: {"yield_time_ms":1000}\ntext(await tools.interrupt_agent({target:"${CHILD_THREAD}"}));\n`),
        wrapperOutput('cell-1', JSON.stringify({ previous_status: 'running' })),
      ]];
      const interaction = extractInterruptInteraction(rollouts, [], binding);
      assert.equal(interaction.attempted, true, 'the directive prefix never hides the interrupt statement');
      assert.equal(interaction.family, 'v2');
      assert.equal(interaction.callCount, 1);
      assert.equal(interaction.delivered, true);
    });

    test('a cell plus a separate interrupt fails the exactly-one-delivery contract in the driver', () => {
      const rollouts = [
        [
          { type: 'session_meta', payload: { id: ROOT_THREAD } },
          stamped(at(7), wrapperCell('cell-1', `const r = await tools.exec_command(${JSON.stringify({ cmd: 'cat notes.txt' })}); text(JSON.stringify(r))\ntext(await tools.interrupt_agent({target:"${FOREIGN_THREAD}"}));\n`)),
          stamped(at('07.1'), wrapperOutput('cell-1', completedOutputBody({ output: 'notes', exit_code: 0 }))),
          stamped(at(8), wrapperCell('cell-2', `text(await tools.interrupt_agent({target:"${CHILD_THREAD}"}));\n`)),
          stamped(at('08.2'), wrapperOutput('cell-2', JSON.stringify({ previous_status: 'running' }))),
        ],
        childRollout,
      ];
      const held = {
        endedBeforeGate: true, budgetExpired: false, identity: undefined, processAliveWhileHeld: null,
        result: { code: 0, stdout: '', stderr: '' },
        cleanup: { label: 'observation', releasedGate: true, verifiedProcessTerminated: true, codexTerminated: true, nativeInterruptionClaimed: false, errors: [] },
        timeline: { clock: 'held-turn-monotonic-elapsed-ms', launchedAtElapsedMs: 10, observationDetectedAtElapsedMs: 20, pollStartedAtElapsedMs: 30, holdDeadlineElapsedMs: 420_000, rootAcknowledgementAtElapsedMs: null, childSettlementDetectedAtElapsedMs: null, endedAtElapsedMs: 50 },
      };
      const evidence = {
        status: 'supported',
        facts: {
          completion: { qualified: false, processExit: null, publicResultMatched: null, decisiveEnd: null, structuralViolationCount: 0 },
          linkage: { checked: true, exact: true, agentType: 'zcode-rescue', childThreadId: CHILD_THREAD, parentThreadId: 'parent-1' },
          collection: { rolloutCount: 2, childToolCallCount: 4, truncated: false, excerpts: [] },
          companion: { launchCount: 1, sendCount: 1, sendCountKnown: true, duplicateLaunch: false, preLaunchDiagnostics: { excerpts: [], truncated: false } },
          handle: { originalHandleChecked: true },
          observations: { outerReturns: 0, modelCalls: 3, rootJoins: 1, decisiveWallMs: null, pendingInnerAtEnd: true },
        },
      };
      const facts = mapShellWaitLiveFacts(
        { case: 'rescue-interrupt', codexBinary: '/bin/x', sourceSha: 'a'.repeat(40), output: '/o', workerDurationMs: 420_000, capMs: null, pollMs: 3_600_000, budgetMs: 720_000 },
        held, evidence, null, null,
        { workspace: '/w', codexHome: '/h', installedRoot: '/i', env: {}, record: { variant: 'candidate', capMs: null, pollMs: 3_600_000, appliedArtifacts: [] } },
        rollouts, [], LAUNCHER,
      );
      assert.equal(facts.interrupt.callCount, 2, 'both deliveries are counted');
      assert.equal(facts.interrupt.settled, null);
      assert.match(facts.interrupt.settledBasis, /multiple/i, 'two deliveries fail the exactly-one-delivery contract');
      assert.notEqual(facts.inconclusive, null, 'the exemption cannot fire over a hidden collateral interruption');
    });

    // --- P2-2: Child settlement runs for EITHER gate/acknowledgement ordering ---

    test('the held-ordering background run still observes Child settlement before disposal', async () => {
      let resolveResult;
      const result = new Promise((resolve) => { resolveResult = resolve; });
      const held = await runHeldHostTurn({
        launch: async () => ({ result, terminate: async () => {} }),
        // The GATE wins the race: the fake peer reaches its gate BEFORE Root
        // returns its acknowledgement, so the held branch runs.
        waitForGate: async () => {},
        waitForObservation: async () => {},
        captureProcessIdentity: async () => ({ pid: 88111, ppid: 70, nonce: 'n5', startIdentity: 'start-a' }),
        readProcessIdentity: async () => undefined,
        waitForProcessExit: async () => {},
        releaseGate: async () => { resolveResult({ code: 0, stdout: 'ack', stderr: '' }); },
        waitForChildSettlement: async () => ({ observed: true, basis: 'test-basis' }),
        holdMs: 10,
        budgetMs: 60_000,
      });
      assert.equal(held.endedBeforeGate, false);
      assert.equal(held.rootAcknowledged, true, 'the Root result was consumed before settlement');
      assert.equal(held.childSettlement?.observed, true, 'the Child-settlement watch runs even when the gate won the race');
      assert.equal(held.cleanup.label, 'child-settlement-observed');
      assert.equal(typeof held.timeline.childSettlementDetectedAtElapsedMs, 'number');
    });
  });

  describe('review round 6 refinements: background no-join, native rejection texts, statement-bound results, tagged statuses', async () => {
    const { extractInterruptInteraction } = await import('../tools/shell-wait-probe/evidence.mjs');
    const { mapShellWaitLiveFacts } = await import('../tools/shell-wait-probe/driver.mjs');

    const CHILD_THREAD = 'a7b8c9d0-44dd-4f0a-8b5c-0d1e2f3a4b5c';
    const ROOT_THREAD = 'review6-root-thread-1';

    const stamped = (timestamp, event) => ({ timestamp, ...event });
    const fnOutput = (callId, output, timestamp = null) => ({
      ...(timestamp ? stamped(timestamp, {}) : {}),
      type: 'response_item', payload: { type: 'function_call_output', call_id: callId, output },
    });
    const interruptCall = (callId, target, timestamp = null) => ({
      ...(timestamp ? stamped(timestamp, {}) : {}),
      type: 'response_item', payload: { type: 'function_call', name: 'interrupt_agent', call_id: callId, arguments: JSON.stringify({ target }) },
    });
    const wrapperCell = (callId, input) => ({ type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: callId, input } });
    const wrapperOutput = (callId, output) => ({ type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: callId, output } });

    /** Pinned plain-text failure responses: ToolRuntime::failure_response emits FunctionCallOutputBody::Text (67727e7c tools/parallel.rs). */
    const plainRejection = (message) => [{ type: 'input_text', text: message }];

    // --- P2-1: the background no-join contract gates the settlement exemption ---

    test('a Root join before the background acknowledgement forfeits the settlement exemption', () => {
      const held = {
        endedBeforeGate: true, budgetExpired: false, identity: undefined, processAliveWhileHeld: null,
        // Round-18: the acknowledgement contract requires a SUCCESSFUL
        // observed acknowledgement (exit 0 + the reserved-job output).
        result: { code: 0, stdout: 'The Host Rescue child was launched.', stderr: '' },
        childSettlement: { observed: true, basis: 'exact-launch-handle-linked-completed-exit-code-output' },
        cleanup: { label: 'child-settlement-observed', releasedGate: true, verifiedProcessTerminated: true, codexTerminated: true, nativeInterruptionClaimed: false, errors: [] },
        timeline: { clock: 'held-turn-monotonic-elapsed-ms', launchedAtElapsedMs: 10, observationDetectedAtElapsedMs: 20, pollStartedAtElapsedMs: 30, holdDeadlineElapsedMs: 120_000, rootAcknowledgementAtElapsedMs: 40, childSettlementDetectedAtElapsedMs: 50, endedAtElapsedMs: 60 },
      };
      const evidence = (rootJoins) => ({
        status: 'supported',
        facts: {
          completion: { qualified: true, processExit: 0, publicResultMatched: true, decisiveEnd: 'process-exit', structuralViolationCount: 0 },
          linkage: { checked: true, exact: true, agentType: 'zcode-rescue', childThreadId: CHILD_THREAD, parentThreadId: 'parent-1' },
          collection: { rolloutCount: 2, childToolCallCount: 4, truncated: false, excerpts: [] },
          companion: { launchCount: 1, sendCount: 1, sendCountKnown: true, duplicateLaunch: false, preLaunchDiagnostics: { excerpts: [], truncated: false } },
          handle: { originalHandleChecked: true },
          observations: { outerReturns: 0, modelCalls: 3, rootJoins, decisiveWallMs: null, pendingInnerAtEnd: false },
        },
      });
      const joined = mapShellWaitLiveFacts(
        { case: 'background', codexBinary: '/bin/x', sourceSha: 'a'.repeat(40), output: '/o', workerDurationMs: 120_000, capMs: null, pollMs: 3_600_000, budgetMs: 240_000 },
        held, evidence(1), null, null,
        { workspace: '/w', codexHome: '/h', installedRoot: '/i', env: {}, record: { variant: 'candidate', capMs: null, pollMs: 3_600_000, appliedArtifacts: [] } },
        [[{ type: 'session_meta', payload: { id: 'parent-1' } }, { payload: { type: 'agent_message', message: 'The Host Rescue child was launched.' } }]], [],
      );
      assert.notEqual(joined.inconclusive, null, 'a placement regression (Root joined despite the background no-join prompt) cannot qualify');
      assert.match(joined.inconclusive.reason, /ended before the held completion boundary/u);
      const noJoin = mapShellWaitLiveFacts(
        { case: 'background', codexBinary: '/bin/x', sourceSha: 'a'.repeat(40), output: '/o', workerDurationMs: 120_000, capMs: null, pollMs: 3_600_000, budgetMs: 240_000 },
        held, evidence(0), null, null,
        { workspace: '/w', codexHome: '/h', installedRoot: '/i', env: {}, record: { variant: 'candidate', capMs: null, pollMs: 3_600_000, appliedArtifacts: [] } },
        [[{ type: 'session_meta', payload: { id: 'parent-1' } }, { payload: { type: 'agent_message', message: 'The Host Rescue child was launched.' } }]], [],
      );
      assert.equal(noJoin.inconclusive, null, 'an observed ZERO join count keeps the settled background exemption');
    });

    // --- P2-2: native plain-text failure responses decode structurally ---

    test('a native plain-text rejection decodes to its structural kind, raw text suppressed', () => {
      const root = extractInterruptInteraction([[
        interruptCall('i1', 'root'), fnOutput('i1', plainRejection('root is not a spawned agent')),
      ]], []);
      assert.equal(root.delivered, false, 'the pinned plain-text failure response is the rejection');
      assert.equal(root.rejection, 'target-root');
      const self = extractInterruptInteraction([[
        interruptCall('i2', CHILD_THREAD), fnOutput('i2', plainRejection('an agent cannot interrupt itself; return your result and let the parent interrupt you if needed')),
      ]], []);
      assert.equal(self.delivered, false);
      assert.equal(self.rejection, 'target-self');
      assert.equal(JSON.stringify(self).includes('return your result'), false, 'the raw message never enters the facts');
      const unknown = extractInterruptInteraction([[
        interruptCall('i3', CHILD_THREAD), fnOutput('i3', plainRejection('thread not found for id')),
      ]], []);
      assert.equal(unknown.delivered, false);
      assert.equal(unknown.rejection, 'target-unknown');
    });

    test('unknown plain-text failure text stays output-unparseable (fail closed)', () => {
      const interaction = extractInterruptInteraction([[
        interruptCall('i1', CHILD_THREAD), fnOutput('i1', plainRejection('some totally unrelated host failure text')),
      ]], []);
      assert.equal(interaction.delivered, null, 'only the KNOWN rejection kinds decode from plain text');
      assert.equal(interaction.rejection, 'output-unparseable');
    });

    // --- P2-3: a wrapped interrupt's result is its OWN statement's output ---

    test('a supported cell correlates the interrupt result to its own statement position', () => {
      const rollouts = [[
        { type: 'session_meta', payload: { id: ROOT_THREAD } },
        wrapperCell('cell-1', `const r = await tools.exec_command(${JSON.stringify({ cmd: 'cat notes.txt' })}); text(JSON.stringify(r))\ntext(await tools.interrupt_agent({target:"${CHILD_THREAD}"}));\n`),
        // One JSON result per completed statement, in order: the exec's
        // result FIRST, the interrupt's SECOND.
        wrapperOutput('cell-1', [
          { type: 'input_text', text: JSON.stringify({ output: 'notes' }) },
          { type: 'input_text', text: JSON.stringify({ previous_status: 'running' }) },
        ]),
      ]];
      const interaction = extractInterruptInteraction(rollouts, []);
      assert.equal(interaction.attempted, true);
      assert.equal(interaction.callCount, 1);
      assert.equal(interaction.delivered, true, 'the interrupt statement\'s own result is the delivery outcome');
      assert.equal(interaction.previousStatus, 'running');
    });

    test('a wrapped interrupt whose own statement has no result stays unresolved', () => {
      const rollouts = [[
        { type: 'session_meta', payload: { id: ROOT_THREAD } },
        wrapperCell('cell-1', `const r = await tools.exec_command(${JSON.stringify({ cmd: 'cat notes.txt' })}); text(JSON.stringify(r))\ntext(await tools.interrupt_agent({target:"${CHILD_THREAD}"}));\n`),
        // Only the exec's result completed; the interrupt statement's own
        // result is absent.
        wrapperOutput('cell-1', [
          { type: 'input_text', text: JSON.stringify({ output: 'notes' }) },
        ]),
      ]];
      const interaction = extractInterruptInteraction(rollouts, []);
      assert.equal(interaction.attempted, true);
      assert.equal(interaction.delivered, null, 'a foreign statement result is never the interrupt delivery');
      assert.equal(interaction.rejection, 'output-unparseable');
    });

    // --- P2-4: tagged native AgentStatus values decode to their labels ---

    test('tagged native agent statuses decode to their labels with the payload suppressed', () => {
      const completed = extractInterruptInteraction([[
        interruptCall('i1', CHILD_THREAD),
        fnOutput('i1', JSON.stringify({ previous_status: { completed: 'the final answer text' } })),
      ]], []);
      assert.equal(completed.delivered, true, 'the pinned AgentStatus enum serializes completed as a tagged object');
      assert.equal(completed.previousStatus, 'completed', 'only the status label is retained');
      assert.equal(JSON.stringify(completed).includes('final answer text'), false, 'the embedded message is suppressed');
      const errored = extractInterruptInteraction([[
        interruptCall('i2', CHILD_THREAD),
        fnOutput('i2', JSON.stringify({ previous_status: { errored: 'the child blew up' } })),
      ]], []);
      assert.equal(errored.delivered, true);
      assert.equal(errored.previousStatus, 'errored');
      assert.equal(JSON.stringify(errored).includes('blew up'), false);
    });

    test('string statuses and unsupported tagged keys keep their prior fail-closed behavior', () => {
      const running = extractInterruptInteraction([[
        interruptCall('i1', CHILD_THREAD), fnOutput('i1', JSON.stringify({ previous_status: 'running' })),
      ]], []);
      assert.equal(running.delivered, true);
      assert.equal(running.previousStatus, 'running');
      const foreignKey = extractInterruptInteraction([[
        interruptCall('i2', CHILD_THREAD), fnOutput('i2', JSON.stringify({ previous_status: { finished: 'secret payload' } })),
      ]], []);
      assert.equal(foreignKey.delivered, null, 'a key outside the pinned AgentStatus enum is not a decoded status');
      assert.equal(foreignKey.rejection, 'output-unparseable');
      assert.equal(JSON.stringify(foreignKey).includes('secret payload'), false);
    });
  });

  describe('review round 7 refinements: Status deadline lifecycle, background placement in both orderings, interrupt qualification, enum statuses', async () => {
    const { inspectShellWaitEvidence, extractInterruptInteraction } = await import('../tools/shell-wait-probe/evidence.mjs');
    const { mapShellWaitLiveFacts, runHeldHostTurn, renderCompanionCommand } = await import('../tools/shell-wait-probe/driver.mjs');

    const CHILD_THREAD = 'b9c0d1e2-55ee-4a1b-9c6d-1e2f3a4b5c6d';
    const ROOT_THREAD = 'review7-root-thread-1';
    const STATUS_JOB_ID = 'cc33dd44ee55ff66aa11bb22cc33dd44ee55ff66aa11bb22cc33dd44ee55ff66';
    const STATUS_COMMAND = `${renderCompanionCommand('/installed/zcode/scripts/zcode-companion.mjs')} invoke status`;
    // The PRODUCTION query-deadline framing (scripts/lib/job-control.mjs
    // waitTimeout → PluginError rendered through errorEnvelope as JSON).
    const statusTimeoutOutput = JSON.stringify({
      error: {
        code: 'JOB_WAIT_TIMEOUT',
        category: 'timeout',
        message: `Timed out waiting for job ${STATUS_JOB_ID}.`,
        remedy: `Retry $zcode:status ${STATUS_JOB_ID} --wait.`,
        details: { jobId: STATUS_JOB_ID, status: 'queued', timeoutMs: 120000 },
      },
    }) + '\n';
    const statusDeadlineMarkers = ['"code":"JOB_WAIT_TIMEOUT"', '"category":"timeout"', 'Timed out waiting for job '];

    const fnOutput = (callId, output) => ({
      type: 'response_item', payload: { type: 'function_call_output', call_id: callId, output },
    });
    const completedOutputBody = (result) => [
      { type: 'input_text', text: 'Script completed\n' },
      { type: 'input_text', text: JSON.stringify(result) },
    ];
    const pendingOutputBody = (cellId) => [{ type: 'input_text', text: `Script running with cell ID ${cellId}\n` }];
    const wrapperCell = (callId, input) => ({ type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: callId, input } });
    const wrapperOutput = (callId, output) => ({ type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: callId, output } });

    // --- P2-1: the Status deadline trial has an observation-only lifecycle and result contract ---

    test('the Status deadline flow labels the result boundary as the expected terminal, not an early exit', async () => {
      let resolveResult;
      const result = new Promise((resolve) => { resolveResult = resolve; });
      const held = await runHeldHostTurn({
        // The host process ends on its own at the query deadline (the Status
        // wait returns JOB_WAIT_TIMEOUT and the turn exits).
        launch: async () => {
          setTimeout(() => resolveResult({ code: 0, stdout: statusTimeoutOutput, stderr: '' }), 30);
          return { result, terminate: async () => {} };
        },
        // The fake peer never launches for a Status deadline trial: the gate
        // is never reached.
        waitForGate: () => new Promise(() => {}),
        captureProcessIdentity: async () => { const error = new Error('marker absent'); /** @type {any} */ (error).code = 'ZCODE_SHELL_WAIT_MARKER_ABSENT'; throw error; },
        waitForProcessExit: async () => {},
        releaseGate: async () => {},
        statusDeadlineFlow: true,
        holdMs: 60_000,
        budgetMs: 120_000,
      });
      assert.equal(held.endedBeforeGate, false, 'the query deadline is the EXPECTED terminal, not an early exit');
      assert.equal(held.statusDeadlineReached, true, 'the confirmed deadline boundary is recorded');
      assert.equal(held.cleanup.label, 'status-query-deadline');
      assert.equal(held.cleanup.releasedGate, true);
    });

    test('the confirmed production JOB_WAIT_TIMEOUT framing satisfies the Status result contract', () => {
      const rollouts = [[
        { type: 'session_meta', payload: { id: 'root-thread-1' } },
        wrapperCell('launch-1', `const r = await tools.exec_command(${JSON.stringify({ cmd: STATUS_COMMAND, workdir: '/w' })}); text(JSON.stringify(r))\n`),
        wrapperOutput('launch-1', completedOutputBody({ output: '', session_id: 87 })),
        wrapperCell('poll-1', `const r = await tools.write_stdin(${JSON.stringify({ session_id: 87, chars: '', yield_time_ms: 3_600_000 })}); text(JSON.stringify(r))\n`),
        wrapperOutput('poll-1', pendingOutputBody('cell-1')),
        { type: 'response_item', payload: { type: 'function_call', name: 'wait', call_id: 'outer-1', arguments: JSON.stringify({ cell_id: 'cell-1' }) } },
        fnOutput('outer-1', completedOutputBody({ output: statusTimeoutOutput, exit_code: 0, session_id: 87 })),
      ]];
      const result = inspectShellWaitEvidence({
        rollouts,
        zcodeCalls: [{ method: 'session/send', params: { sessionId: 'fake-session' } }],
        command: STATUS_COMMAND,
        mode: /** @type {const} */ ('root'),
        publicResultMarkers: ['Job: ', 'Command: ', 'Status: ', 'Progress:'],
        publicResultAlternativeMarkers: statusDeadlineMarkers,
        workerStillAliveAfterObservation: false,
        redactions: [],
      });
      assert.equal(result.status, 'supported', JSON.stringify(result.inconclusive));
      assert.equal(result.facts.completion.qualified, true, 'the deadline expiry IS the expected observation outcome for the deadline-measurement trial');
      assert.equal(result.facts.completion.resultMarkerSetMatched, 'query-deadline');
      // Fail-closed: an output without the production framing never decodes.
      const foreign = inspectShellWaitEvidence({
        rollouts: [rollouts[0].slice(0, 5).concat([
          { type: 'response_item', payload: { type: 'function_call', name: 'wait', call_id: 'outer-1', arguments: JSON.stringify({ cell_id: 'cell-1' }) } },
          fnOutput('outer-1', completedOutputBody({ output: 'some unrelated host failure', exit_code: 0, session_id: 87 })),
        ])],
        zcodeCalls: [{ method: 'session/send', params: { sessionId: 'fake-session' } }],
        command: STATUS_COMMAND,
        mode: /** @type {const} */ ('root'),
        publicResultMarkers: ['Job: ', 'Command: ', 'Status: ', 'Progress:'],
        publicResultAlternativeMarkers: statusDeadlineMarkers,
        workerStillAliveAfterObservation: false,
        redactions: [],
      });
      assert.equal(foreign.facts.completion.qualified, false, 'an unconfirmable timeout output fails closed');
    });

    test('an adherent Status trial with a confirmed deadline expiry is conclusive', () => {
      const held = {
        endedBeforeGate: false, statusDeadlineReached: true, budgetExpired: false, identity: undefined, processAliveWhileHeld: null,
        result: { code: 0, stdout: statusTimeoutOutput, stderr: '' },
        cleanup: { label: 'status-query-deadline', releasedGate: true, verifiedProcessTerminated: false, codexTerminated: true, nativeInterruptionClaimed: false, errors: [] },
        timeline: { clock: 'held-turn-monotonic-elapsed-ms', launchedAtElapsedMs: 10, observationDetectedAtElapsedMs: 20, pollStartedAtElapsedMs: 30, holdDeadlineElapsedMs: 130_000, rootAcknowledgementAtElapsedMs: null, childSettlementDetectedAtElapsedMs: null, endedAtElapsedMs: 140_000 },
      };
      const evidence = {
        status: 'supported',
        facts: {
          completion: { qualified: true, processExit: 0, publicResultMatched: true, decisiveEnd: 'process-exit', structuralViolationCount: 0, resultMarkerSetMatched: 'query-deadline' },
          linkage: { checked: true, exact: true, mode: 'root', rootThreadId: 'root-thread-1', commandRolloutCount: 1, queryTurnScoped: false, queryTurnSetupEventCount: null },
          collection: { rolloutCount: 1, childToolCallCount: 4, truncated: false, excerpts: [] },
          companion: { launchCount: 1, sendCount: 1, sendCountKnown: true, duplicateLaunch: false, preLaunchDiagnostics: { excerpts: [], truncated: false } },
          handle: { originalHandleChecked: true },
          observations: { outerReturns: 1, modelCalls: 4, rootJoins: null, decisiveWallMs: null, pendingInnerAtEnd: false },
        },
      };
      const facts = mapShellWaitLiveFacts(
        { case: 'status-wait', codexBinary: '/bin/x', sourceSha: 'a'.repeat(40), output: '/o', workerDurationMs: 130_000, capMs: null, pollMs: 3_600_000, budgetMs: 360_000, statusQueryTimeoutMs: 120_000 },
        held, evidence, null, null,
        { workspace: '/w', codexHome: '/h', installedRoot: '/i', env: {}, record: { variant: 'candidate', capMs: null, pollMs: 3_600_000, appliedArtifacts: [] } },
        // The two-turn statusQuery facts: valid, matching, explicit timeout.
        [[
          { type: 'session_meta', payload: { id: 'root-thread-1' } },
          { type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'launch-1', arguments: JSON.stringify({ cmd: 'review --background' }) } },
          fnOutput('launch-1', completedOutputBody({ output: `Reserved background job ${STATUS_JOB_ID}.`, exit_code: 0, session_id: 8 })),
          { type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'query-1', arguments: JSON.stringify({ cmd: `status ${STATUS_JOB_ID} --wait --timeout-ms 120000` }) } },
          fnOutput('query-1', completedOutputBody({ output: statusTimeoutOutput, exit_code: 0, session_id: 8 })),
        ]],
        [],
      );
      assert.equal(facts.statusQuery?.validation?.valid, true, 'the two-turn flow validates');
      assert.equal(facts.inconclusive, null, 'an adherent Status deadline trial is the measured result, not an inconclusive');
      assert.equal(facts.held.statusDeadlineReached, true);
    });

    // --- P2-2: background placement holds for BOTH gate orderings ---

    test('a background trial with a Root join fails placement in the gate-wins ordering too', () => {
      const held = {
        endedBeforeGate: false, rootAcknowledged: true, budgetExpired: false, identity: {}, processAliveWhileHeld: true,
        childSettlement: { observed: true, basis: 'exact-launch-handle-linked-completed-exit-code-output' },
        // Round-18: the acknowledgement contract requires a SUCCESSFUL
        // observed acknowledgement (exit 0 + the reserved-job output).
        result: { code: 0, stdout: 'The Host Rescue child was launched.', stderr: '' },
        cleanup: { label: 'child-settlement-observed', releasedGate: true, verifiedProcessTerminated: true, codexTerminated: true, nativeInterruptionClaimed: false, errors: [] },
        timeline: { clock: 'held-turn-monotonic-elapsed-ms', launchedAtElapsedMs: 10, observationDetectedAtElapsedMs: 20, pollStartedAtElapsedMs: 30, holdDeadlineElapsedMs: 120_000, rootAcknowledgementAtElapsedMs: 40, childSettlementDetectedAtElapsedMs: 50, endedAtElapsedMs: 60 },
      };
      const evidence = (rootJoins) => ({
        status: 'supported',
        facts: {
          completion: { qualified: true, processExit: 0, publicResultMatched: true, decisiveEnd: 'process-exit', structuralViolationCount: 0 },
          linkage: { checked: true, exact: true, agentType: 'zcode-rescue', childThreadId: CHILD_THREAD, parentThreadId: 'parent-1' },
          collection: { rolloutCount: 2, childToolCallCount: 4, truncated: false, excerpts: [] },
          companion: { launchCount: 1, sendCount: 1, sendCountKnown: true, duplicateLaunch: false, preLaunchDiagnostics: { excerpts: [], truncated: false } },
          handle: { originalHandleChecked: true },
          observations: { outerReturns: 0, modelCalls: 3, rootJoins, decisiveWallMs: null, pendingInnerAtEnd: false },
        },
      });
      const joined = mapShellWaitLiveFacts(
        { case: 'background', codexBinary: '/bin/x', sourceSha: 'a'.repeat(40), output: '/o', workerDurationMs: 120_000, capMs: null, pollMs: 3_600_000, budgetMs: 240_000 },
        held, evidence(1), null, null,
        { workspace: '/w', codexHome: '/h', installedRoot: '/i', env: {}, record: { variant: 'candidate', capMs: null, pollMs: 3_600_000, appliedArtifacts: [] } },
        [[{ type: 'session_meta', payload: { id: 'parent-1' } }, { payload: { type: 'agent_message', message: 'The Host Rescue child was launched.' } }]], [],
      );
      assert.notEqual(joined.inconclusive, null, 'the placement contract holds regardless of which boundary won');
      assert.match(joined.inconclusive.reason, /background placement contract|join/i);
      const clean = mapShellWaitLiveFacts(
        { case: 'background', codexBinary: '/bin/x', sourceSha: 'a'.repeat(40), output: '/o', workerDurationMs: 120_000, capMs: null, pollMs: 3_600_000, budgetMs: 240_000 },
        held, evidence(0), null, null,
        { workspace: '/w', codexHome: '/h', installedRoot: '/i', env: {}, record: { variant: 'candidate', capMs: null, pollMs: 3_600_000, appliedArtifacts: [] } },
        [[{ type: 'session_meta', payload: { id: 'parent-1' } }, { payload: { type: 'agent_message', message: 'The Host Rescue child was launched.' } }]], [],
      );
      assert.equal(clean.inconclusive, null, 'zero joins with observed settlement stays the qualifying background shape');
    });

    // --- P2-3: qualifying an interrupt trial requires the pending-window exact delivery ---

    test('an interrupt trial whose delivery never happened is inconclusive even when completion qualifies', () => {
      const held = {
        endedBeforeGate: false, budgetExpired: false, identity: {}, processAliveWhileHeld: true,
        result: { code: 0, stdout: '', stderr: '' },
        cleanup: { label: 'observation', releasedGate: true, verifiedProcessTerminated: true, codexTerminated: true, nativeInterruptionClaimed: false, errors: [] },
        timeline: { clock: 'held-turn-monotonic-elapsed-ms', launchedAtElapsedMs: 10, observationDetectedAtElapsedMs: 20, pollStartedAtElapsedMs: 30, holdDeadlineElapsedMs: 420_000, rootAcknowledgementAtElapsedMs: null, childSettlementDetectedAtElapsedMs: null, endedAtElapsedMs: 50 },
      };
      const evidence = {
        status: 'supported',
        facts: {
          completion: { qualified: true, processExit: 0, publicResultMatched: true, decisiveEnd: 'process-exit', structuralViolationCount: 0 },
          linkage: { checked: true, exact: true, agentType: 'zcode-rescue', childThreadId: CHILD_THREAD, parentThreadId: 'parent-1' },
          collection: { rolloutCount: 2, childToolCallCount: 4, truncated: false, excerpts: [] },
          companion: { launchCount: 1, sendCount: 1, sendCountKnown: true, duplicateLaunch: false, preLaunchDiagnostics: { excerpts: [], truncated: false } },
          handle: { originalHandleChecked: true },
          observations: { outerReturns: 0, modelCalls: 2, rootJoins: 1, decisiveWallMs: null, pendingInnerAtEnd: false },
        },
      };
      const facts = mapShellWaitLiveFacts(
        { case: 'rescue-interrupt', codexBinary: '/bin/x', sourceSha: 'a'.repeat(40), output: '/o', workerDurationMs: 420_000, capMs: null, pollMs: 3_600_000, budgetMs: 720_000 },
        held, evidence, null, null,
        { workspace: '/w', codexHome: '/h', installedRoot: '/i', env: {}, record: { variant: 'candidate', capMs: null, pollMs: 3_600_000, appliedArtifacts: [] } },
        [[{ type: 'session_meta', payload: { id: 'root-thread-1' } }]], [],
      );
      assert.equal(facts.interrupt.attempted, false);
      assert.notEqual(facts.inconclusive, null, 'ordinary terminal completion never qualifies an interrupt trial without the delivery');
      assert.match(facts.inconclusive.reason, /requires one observed exact-target delivery/i);
      assert.match(facts.inconclusive.reason, /delivery was not attempted/i, 'the recorded reason surfaces');
    });

    test('rejected and post-completion deliveries keep the interrupt trial inconclusive with their reasons', () => {
      const held = {
        endedBeforeGate: false, budgetExpired: false, identity: {}, processAliveWhileHeld: true,
        result: { code: 0, stdout: '', stderr: '' },
        cleanup: { label: 'observation', releasedGate: true, verifiedProcessTerminated: true, codexTerminated: true, nativeInterruptionClaimed: false, errors: [] },
        timeline: { clock: 'held-turn-monotonic-elapsed-ms', launchedAtElapsedMs: 10, observationDetectedAtElapsedMs: 20, pollStartedAtElapsedMs: 30, holdDeadlineElapsedMs: 420_000, rootAcknowledgementAtElapsedMs: null, childSettlementDetectedAtElapsedMs: null, endedAtElapsedMs: 50 },
      };
      const evidence = {
        status: 'supported',
        facts: {
          completion: { qualified: true, processExit: 0, publicResultMatched: true, decisiveEnd: 'process-exit', structuralViolationCount: 0 },
          linkage: { checked: true, exact: true, agentType: 'zcode-rescue', childThreadId: CHILD_THREAD, parentThreadId: 'parent-1' },
          collection: { rolloutCount: 1, childToolCallCount: 2, truncated: false, excerpts: [] },
          companion: { launchCount: 1, sendCount: 1, sendCountKnown: true, duplicateLaunch: false, preLaunchDiagnostics: { excerpts: [], truncated: false } },
          handle: { originalHandleChecked: true },
          observations: { outerReturns: 0, modelCalls: 2, rootJoins: 0, decisiveWallMs: null, pendingInnerAtEnd: false },
        },
      };
      const rejected = mapShellWaitLiveFacts(
        { case: 'rescue-interrupt', codexBinary: '/bin/x', sourceSha: 'a'.repeat(40), output: '/o', workerDurationMs: 420_000, capMs: null, pollMs: 3_600_000, budgetMs: 720_000 },
        held, evidence, null, null,
        { workspace: '/w', codexHome: '/h', installedRoot: '/i', env: {}, record: { variant: 'candidate', capMs: null, pollMs: 3_600_000, appliedArtifacts: [] } },
        [[
          { type: 'session_meta', payload: { id: ROOT_THREAD } },
          { type: 'response_item', payload: { type: 'function_call', name: 'interrupt_agent', call_id: 'int-1', arguments: JSON.stringify({ target: 'root' }) } },
          fnOutput('int-1', JSON.stringify({ error: 'root is not a spawned agent' })),
        ]], [],
      );
      assert.equal(rejected.interrupt.delivered, false);
      assert.notEqual(rejected.inconclusive, null, 'a rejected delivery keeps the trial inconclusive');
      assert.match(rejected.inconclusive.reason, /rejected|target-root/i);
    });

    // --- P2-4: string statuses are validated against the pinned enum ---

    test('an arbitrary string previous_status is output-unparseable and never retained', () => {
      const interaction = extractInterruptInteraction([[
        { type: 'response_item', payload: { type: 'function_call', name: 'interrupt_agent', call_id: 'i1', arguments: JSON.stringify({ target: CHILD_THREAD }) } },
        fnOutput('i1', JSON.stringify({ previous_status: 'private_task_canary' })),
      ]], []);
      assert.equal(interaction.delivered, null, 'a string outside the pinned AgentStatus enum is not a decoded status');
      assert.equal(interaction.rejection, 'output-unparseable');
      assert.equal(interaction.previousStatus, null);
      assert.equal(JSON.stringify(interaction).includes('private_task_canary'), false, 'the unsupported text is never retained');
      const pinned = extractInterruptInteraction([[
        { type: 'response_item', payload: { type: 'function_call', name: 'interrupt_agent', call_id: 'i2', arguments: JSON.stringify({ target: CHILD_THREAD }) } },
        fnOutput('i2', JSON.stringify({ previous_status: 'interrupted' })),
      ]], []);
      assert.equal(pinned.delivered, true, 'a pinned enum string still decodes');
      assert.equal(pinned.previousStatus, 'interrupted');
    });
  });

  describe('review round 8 refinements: guaranteed disposal, latency attribution guards, drained reservation responses', async () => {
    const { runShellWaitCase, mapShellWaitLiveFacts } = await import('../tools/shell-wait-probe/driver.mjs');
    const { defaultCompanionChildSpawn } = await import('../tools/shell-wait-probe/fixture.mjs');

    const CHILD_THREAD = 'c0d1e2f3-66ff-4b2c-8d7e-2f3a4b5c6d7e';
    const fnOutput8 = (callId, output) => ({
      type: 'response_item', payload: { type: 'function_call_output', call_id: callId, output },
    });

    // --- P2-1: provenance collection never bypasses fixture disposal ---

    test('a provenance failure during a live trial still disposes the fixture and is recorded', async (t) => {
      const { mkdtemp, mkdir, rm, readFile } = await import('node:fs/promises');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const temporary = await mkdtemp(join(tmpdir(), 'shell-wait-r8-provenance-'));
      t.after(() => rm(temporary, { recursive: true, force: true }));
      const output = join(temporary, 'output');
      await mkdir(output, { mode: 0o700 });
      let disposed = false;
      const record = await runShellWaitCase(
        { case: 'rescue-long', codexBinary: process.execPath, sourceSha: 'a'.repeat(40), output, workerDurationMs: 1000, capMs: null, pollMs: 3_600_000, budgetMs: 2000 },
        {
          createFixture: async () => ({
            workspace: join(temporary, 'ws'), codexHome: join(temporary, 'home'),
            installedRoot: join(temporary, 'installed'), env: { CODEX_HOME: join(temporary, 'home') },
            record: { variant: 'candidate', capMs: null, pollMs: 3_600_000, appliedArtifacts: [] },
            dispose: async () => { disposed = true; },
          }),
          executeLiveCase: async () => ({
            codexVersion: null,
            route: { requested: 'named', actual: null },
            hostResult: { exitCode: 0, companionProcessExit: 0, sentinelMatched: true, terminalStdoutChecked: true, resultCheck: null, resultCheckLabel: null },
            linkage: { checked: true, mode: 'rescue', rootThreadId: null, childThreadId: CHILD_THREAD, parentThreadId: 'parent-1', companionLaunchCount: 1, companionSendCount: 1, originalHandleChecked: true },
            observations: { outerReturns: 0, modelCalls: 2, rootJoins: 1, decisiveWallMs: null, pendingInnerAtEnd: false },
            interrupt: { requested: false, delivered: null, settled: null, missingPrerequisite: null },
            held: { endedBeforeGate: false, cleanupLabel: 'observation', gateReleased: true, cleanupErrors: { count: 0, reasons: [] }, processTermination: { verifiedTerminated: true, codexTerminated: true }, cleanupComplete: true },
            child: { settlement: null, rootAcknowledgementAtElapsedMs: null, settlementDetectedAtElapsedMs: null },
            statusQuery: null,
            excerpts: [],
            inconclusive: null,
          }),
          observerProvenance: async () => { throw new Error('the observer source became unreadable mid-trial'); },
        },
      );
      assert.equal(record.status, 'executed');
      assert.equal(disposed, true, 'disposal runs even when provenance collection rejects');
      assert.equal(record.cleanup.fixtureDisposed, true, 'the disposal guarantee is not bypassed by a provenance failure');
      assert.equal(record.provenance.observer?.digest ?? null, null, 'the digest is null, never a fabricated value');
      assert.match(String(record.provenance.observer?.revision), /collection-failed|unavailable/i);
      assert.match(String(record.inconclusive?.reason), /observer provenance could not be collected/i, 'the provenance failure is an inconclusive reason');
      const written = JSON.parse(await readFile(join(output, 'rescue-long.record.json'), 'utf8'));
      assert.equal(written.cleanup.fixtureDisposed, true);
      assert.match(String(written.inconclusive?.reason), /observer provenance/i);
    });

    test('a provenance failure on the failed-record path still disposes the fixture', async (t) => {
      const { mkdtemp, mkdir, rm, readFile } = await import('node:fs/promises');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const temporary = await mkdtemp(join(tmpdir(), 'shell-wait-r8-provenance-fail-'));
      t.after(() => rm(temporary, { recursive: true, force: true }));
      const output = join(temporary, 'output');
      await mkdir(output, { mode: 0o700 });
      let disposed = false;
      const failure = new Error('the held observation failed');
      await assert.rejects(
        runShellWaitCase(
          { case: 'rescue-long', codexBinary: process.execPath, sourceSha: 'a'.repeat(40), output, workerDurationMs: 1000, capMs: null, pollMs: 3_600_000, budgetMs: 2000 },
          {
            createFixture: async () => ({
              workspace: join(temporary, 'ws'), codexHome: join(temporary, 'home'),
              installedRoot: join(temporary, 'installed'), env: { CODEX_HOME: join(temporary, 'home') },
              record: { variant: 'candidate', capMs: null, pollMs: 3_600_000, appliedArtifacts: [] },
              dispose: async () => { disposed = true; },
            }),
            executeLiveCase: async () => { throw Object.assign(failure, { liveFacts: { codexVersion: null, route: { requested: 'rescue-foreground', actual: null }, hostResult: { exitCode: 1 }, linkage: {}, observations: {}, interrupt: { requested: false }, held: {}, child: {}, statusQuery: null, excerpts: [], inconclusive: { reason: 'the held observation failed' } } }); },
            observerProvenance: async () => { throw new Error('the observer source became unreadable mid-trial'); },
          },
        ),
        (error) => error === failure,
      );
      assert.equal(disposed, true, 'disposal runs on the failed path even when provenance collection rejects');
      const written = JSON.parse(await readFile(join(output, 'rescue-long.record.json'), 'utf8'));
      assert.equal(written.status, 'failed');
      assert.equal(written.cleanup.fixtureDisposed, true);
      assert.match(String(written.inconclusive?.reason), /observer provenance/i);
    });

    // --- P2-2: the latency field carries the same attribution guards as settlement ---

    test('ambiguous deliveries produce no delivery-to-settlement measurement', () => {
      const at2 = (second) => `2026-10-06T05:00:${String(second).padStart(2, '0')}.000Z`;
      const stamped = (timestamp, event) => ({ timestamp, ...event });
      const held = {
        endedBeforeGate: true, budgetExpired: false, identity: undefined, processAliveWhileHeld: null,
        result: { code: 0, stdout: '', stderr: '' },
        cleanup: { label: 'observation', releasedGate: true, verifiedProcessTerminated: true, codexTerminated: true, nativeInterruptionClaimed: false, errors: [] },
        timeline: { clock: 'held-turn-monotonic-elapsed-ms', launchedAtElapsedMs: 10, observationDetectedAtElapsedMs: 20, pollStartedAtElapsedMs: 30, holdDeadlineElapsedMs: 420_000, rootAcknowledgementAtElapsedMs: null, childSettlementDetectedAtElapsedMs: null, endedAtElapsedMs: 50 },
      };
      const rollouts = [
        [
          { type: 'session_meta', payload: { id: 'root-thread-1' } },
          stamped(at2(6), { type: 'response_item', payload: { type: 'function_call', name: 'interrupt_agent', call_id: 'int-1', arguments: JSON.stringify({ target: 'ffffffff-ffff-4fff-8fff-fffffffffff0' }) } }),
          stamped(at2('06.2'), fnOutput8('int-1', JSON.stringify({ error: 'unknown agent: no such thread' }))),
          stamped(at2(7), { type: 'response_item', payload: { type: 'function_call', name: 'interrupt_agent', call_id: 'int-2', arguments: JSON.stringify({ target: CHILD_THREAD }) } }),
          stamped(at2('07.2'), fnOutput8('int-2', JSON.stringify({ previous_status: 'running' }))),
        ],
        [
          { type: 'session_meta', payload: { id: CHILD_THREAD } },
          stamped(at2(0), { type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'launch-1', arguments: JSON.stringify({ cmd: 'node launcher' }) } }),
          stamped(at2(1), fnOutput8('launch-1', [{ type: 'input_text', text: 'Script completed\n' }, { type: 'input_text', text: JSON.stringify({ output: '', exit_code: 0, session_id: 5 }) }])),
          stamped(at2(5), { type: 'response_item', payload: { type: 'function_call', name: 'write_stdin', call_id: 'poll-1', arguments: JSON.stringify({ session_id: 5, chars: '', yield_time_ms: 3_600_000 }) } }),
          stamped(at2('05.5'), fnOutput8('poll-1', [{ type: 'input_text', text: 'Script running with cell ID cell-1\n' }])),
          stamped(at2(11), { type: 'response_item', payload: { type: 'function_call', name: 'wait', call_id: 'outer-1', arguments: JSON.stringify({ cell_id: 'cell-1' }) } }),
          stamped(at2(12), fnOutput8('outer-1', [{ type: 'input_text', text: 'Script completed\n' }, { type: 'input_text', text: JSON.stringify({ output: 'sentinel', exit_code: 0, session_id: 5 }) }])),
        ],
      ];
      const evidence = {
        status: 'supported',
        facts: {
          completion: { qualified: false, processExit: null, publicResultMatched: null, decisiveEnd: null, structuralViolationCount: 0 },
          linkage: { checked: true, exact: true, agentType: 'zcode-rescue', childThreadId: CHILD_THREAD, parentThreadId: 'parent-1' },
          collection: { rolloutCount: 2, childToolCallCount: 5, truncated: false, excerpts: [] },
          companion: { launchCount: 1, sendCount: 1, sendCountKnown: true, duplicateLaunch: false, preLaunchDiagnostics: { excerpts: [], truncated: false } },
          handle: { originalHandleChecked: true },
          observations: { outerReturns: 1, modelCalls: 5, rootJoins: 1, decisiveWallMs: null, pendingInnerAtEnd: true },
        },
      };
      const facts = mapShellWaitLiveFacts(
        { case: 'rescue-interrupt', codexBinary: '/bin/x', sourceSha: 'a'.repeat(40), output: '/o', workerDurationMs: 420_000, capMs: null, pollMs: 3_600_000, budgetMs: 720_000 },
        held, evidence, null, null,
        { workspace: '/w', codexHome: '/h', installedRoot: '/i', env: {}, record: { variant: 'candidate', capMs: null, pollMs: 3_600_000, appliedArtifacts: [] } },
        rollouts, [], 'node launcher',
      );
      assert.equal(facts.interrupt.delivered, true, 'the last (exact) delivery stays recorded');
      assert.equal(facts.interrupt.settled, null);
      assert.match(facts.interrupt.settledBasis, /multiple/i);
      assert.equal(facts.interrupt.deliveryToSettlementMs, null, 'an ambiguous delivery produces no responsiveness measurement');
    });

    // --- P2-3: the reservation outcome waits for bounded stdio drainage ---

    test('the reservation child outcome drains the buffered internal response before resolving', async () => {
      const jobId = 'dd44ee55ff66aa11bb22cc33dd44ee55ff66aa11bb22cc33dd44ee55ff66aa11b'.slice(0, 64);
      // P2-3 round-9 fix: the payload is generated INSIDE the child from a
      // small size argument — a single argument is capped at 128 KiB on
      // Linux (4 KiB pages, MAX_ARG_STRLEN), so a >300 KiB argv fails E2BIG
      // on Linux CI before the drainage behavior is ever exercised. The
      // parent retains the expected value only to compare.
      const payloadBytes = 300 * 1024;
      const envelopeHead = JSON.stringify({ type: 'background', job: { id: jobId, status: 'queued' } }).slice(0, -1) + ',"pad":"';
      const childScript = [
        'const fs = require("node:fs");',
        `const head = process.argv[1];`,
        `const payloadBytes = Number(process.argv[2]);`,
        'let off = 0; const write4 = (s) => { let o = 0; while (o < s.length) { o += fs.writeSync(4, s.slice(o)); } };',
        'const chunk = "x".repeat(64 * 1024);',
        'write4(head);',
        'let written = 0;',
        'while (payloadBytes - written >= chunk.length) { write4(chunk); written += chunk.length; }',
        'if (payloadBytes - written > 0) { write4(chunk.slice(0, payloadBytes - written)); }',
        'write4(String.fromCharCode(34, 125, 10));',
        'process.exit(0);',
      ].join('\n');
      const expected = `${envelopeHead}${'x'.repeat(payloadBytes)}"}\n`;
      const outcome = await defaultCompanionChildSpawn({
        command: process.execPath,
        args: ['-e', childScript, envelopeHead, String(payloadBytes)],
        cwd: process.cwd(),
        env: process.env,
        callerEnvelope: { callerContext: 'test' },
        timeoutMs: 30_000,
      });
      assert.equal(outcome.code, 0);
      assert.equal(
        outcome.internalResponse, expected,
        'the exit event does not guarantee stdio drained: the buffered internal response must be collected before the outcome resolves',
      );
    });
  });

  describe('review round 9 refinements: active-poll pending windows, drained snapshots, child-generated payloads', async () => {
    const { extractInterruptInteraction } = await import('../tools/shell-wait-probe/evidence.mjs');
    const { mapShellWaitLiveFacts } = await import('../tools/shell-wait-probe/driver.mjs');
    const { defaultCompanionChildSpawn } = await import('../tools/shell-wait-probe/fixture.mjs');

    const CHILD_THREAD = 'd1e2f3a4-7700-4c3d-8e9f-3a4b5c6d7e8f';
    const LAUNCHER = 'node "/installed/zcode/skills/rescue/launcher.mjs" invoke-prepared rescue';
    const SENTINEL = 'ZCODE_RESCUE_PUBLIC_SENTINEL_7C9C';
    const HANDLE = 5;

    const at2 = (second) => `2026-10-06T06:00:${String(second).padStart(2, '0')}Z`;
    const stamped = (timestamp, event) => ({ timestamp, ...event });
    const fnCall = (name, callId, args, timestamp = null) => ({
      ...(timestamp ? stamped(timestamp, {}) : {}),
      type: 'response_item', payload: { type: 'function_call', name, call_id: callId, arguments: JSON.stringify(args) },
    });
    const fnOutput = (callId, output, timestamp = null) => ({
      ...(timestamp ? stamped(timestamp, {}) : {}),
      type: 'response_item', payload: { type: 'function_call_output', call_id: callId, output },
    });
    const completedOutputBody = (result) => [
      { type: 'input_text', text: 'Script completed\n' },
      { type: 'input_text', text: JSON.stringify(result) },
    ];
    const pendingOutputBody = (cellId) => [{ type: 'input_text', text: `Script running with cell ID ${cellId}\n` }];
    const binding = { childThreadId: CHILD_THREAD, command: LAUNCHER };

    // --- P2-1: a poll's call-to-response interval is pending-state evidence ---

    test('an interrupt inside the ACTIVE poll interval observes the pending window', () => {
      const rollouts = [
        [
          { type: 'session_meta', payload: { id: 'root-thread-1' } },
          stamped(at2(7), fnCall('interrupt_agent', 'int-1', { target: CHILD_THREAD })),
          stamped(at2('07.2'), fnOutput('int-1', JSON.stringify({ previous_status: 'running' }))),
        ],
        [
          { type: 'session_meta', payload: { id: CHILD_THREAD } },
          stamped(at2(0), fnCall('exec_command', 'launch-1', { cmd: LAUNCHER })),
          stamped(at2(1), fnOutput('launch-1', completedOutputBody({ output: '', exit_code: 0, session_id: HANDLE }))),
          // The poll is ISSUED at 05 and its yield output arrives at 09:
          // the interrupt at 07 lands INSIDE the active poll interval.
          stamped(at2(5), fnCall('write_stdin', 'poll-1', { session_id: HANDLE, chars: '', yield_time_ms: 3_600_000 })),
          stamped(at2(9), fnOutput('poll-1', pendingOutputBody('cell-1'))),
        ],
      ];
      const interaction = extractInterruptInteraction(rollouts, [], binding);
      assert.equal(interaction.orderingBound, true);
      assert.equal(interaction.pendingBeforeCall.observed, true,
        'a poll whose call is recorded and whose response has not arrived is an outstanding observation');
    });

    test('an active-poll interruption with a following terminal observation is not post-completion', () => {
      const held = {
        endedBeforeGate: true, budgetExpired: false, identity: undefined, processAliveWhileHeld: null,
        result: { code: 0, stdout: '', stderr: '' },
        cleanup: { label: 'observation', releasedGate: true, verifiedProcessTerminated: true, codexTerminated: true, nativeInterruptionClaimed: false, errors: [] },
        timeline: { clock: 'held-turn-monotonic-elapsed-ms', launchedAtElapsedMs: 10, observationDetectedAtElapsedMs: 20, pollStartedAtElapsedMs: 30, holdDeadlineElapsedMs: 420_000, rootAcknowledgementAtElapsedMs: null, childSettlementDetectedAtElapsedMs: null, endedAtElapsedMs: 50 },
      };
      const evidence = {
        status: 'supported',
        facts: {
          completion: { qualified: false, processExit: null, publicResultMatched: null, decisiveEnd: null, structuralViolationCount: 0 },
          linkage: { checked: true, exact: true, agentType: 'zcode-rescue', childThreadId: CHILD_THREAD, parentThreadId: 'parent-1' },
          collection: { rolloutCount: 2, childToolCallCount: 5, truncated: false, excerpts: [] },
          companion: { launchCount: 1, sendCount: 1, sendCountKnown: true, duplicateLaunch: false, preLaunchDiagnostics: { excerpts: [], truncated: false } },
          handle: { originalHandleChecked: true },
          observations: { outerReturns: 1, modelCalls: 5, rootJoins: 1, decisiveWallMs: null, pendingInnerAtEnd: true },
        },
      };
      const rollouts = [
        [
          { type: 'session_meta', payload: { id: 'root-thread-1' } },
          stamped(at2(7), fnCall('interrupt_agent', 'int-1', { target: CHILD_THREAD })),
          stamped(at2('07.2'), fnOutput('int-1', JSON.stringify({ previous_status: 'running' }))),
        ],
        [
          { type: 'session_meta', payload: { id: CHILD_THREAD } },
          stamped(at2(0), fnCall('exec_command', 'launch-1', { cmd: LAUNCHER })),
          stamped(at2(1), fnOutput('launch-1', completedOutputBody({ output: '', exit_code: 0, session_id: HANDLE }))),
          stamped(at2(5), fnCall('write_stdin', 'poll-1', { session_id: HANDLE, chars: '', yield_time_ms: 3_600_000 })),
          stamped(at2(9), fnOutput('poll-1', pendingOutputBody('cell-1'))),
          stamped(at2(11), fnCall('wait', 'outer-1', { cell_id: 'cell-1' })),
          stamped(at2(12), fnOutput('outer-1', completedOutputBody({ output: SENTINEL, exit_code: 0, session_id: HANDLE }))),
        ],
      ];
      const facts = mapShellWaitLiveFacts(
        { case: 'rescue-interrupt', codexBinary: '/bin/x', sourceSha: 'a'.repeat(40), output: '/o', workerDurationMs: 420_000, capMs: null, pollMs: 3_600_000, budgetMs: 720_000 },
        held, evidence, null, null,
        { workspace: '/w', codexHome: '/h', installedRoot: '/i', env: {}, record: { variant: 'candidate', capMs: null, pollMs: 3_600_000, appliedArtifacts: [] } },
        rollouts, [], LAUNCHER,
      );
      assert.equal(facts.interrupt.pendingIntervalMs, 2000, 'the pending interval is measured from the poll call to the delivery');
      assert.equal((facts.interrupt.settledBasis ?? '').includes('post-completion'), false, 'an in-interval interruption is never post-completion');
      assert.equal(facts.inconclusive, null, 'a valid pending-window interruption inside the active poll is the case contract');
    });

    // --- P2-2: the drained outcome is constructed after drainage completes ---

    test('late-arriving bytes after the exit event are captured in the drained outcome', async () => {
      // A GRANDCHILD inherits the child's fd4 (spawn accepts integer fds in
      // stdio) and writes the second half AFTER the child exited: the child's
      // own exit event fires at ~t=0 while the grandchild's bytes land at
      // ~t=300ms. The outcome must be constructed AFTER drainage completes —
      // a snapshot taken at exit loses the late half.
      const grandchildScript = 'const fs=require("node:fs");setTimeout(()=>{let o=0;const part=process.argv[1];while(o<part.length){o+=fs.writeSync(4,part.slice(o));}},300);';
      const childScript = [
        'const fs = require("node:fs");',
        'const { spawn } = require("node:child_process");',
        `const part = process.argv[1];`,
        'let off = 0; while (off < part.length) { off += fs.writeSync(4, part.slice(off)); }',
        `const late = spawn(process.execPath, ["-e", ${JSON.stringify(grandchildScript)}, part], { stdio: ["ignore", "ignore", "ignore", "ignore", 4, "ignore"], detached: true });`,
        'late.unref();',
        'process.exit(0);',
      ].join('\n');
      const part = JSON.stringify({ type: 'background', job: { id: 'e', status: 'queued' }, pad: 'y'.repeat(64 * 1024) });
      const outcome = await defaultCompanionChildSpawn({
        command: process.execPath,
        args: ['-e', childScript, part],
        cwd: process.cwd(),
        env: process.env,
        callerEnvelope: { callerContext: 'test' },
        timeoutMs: 30_000,
      });
      assert.equal(outcome.code, 0);
      const parts = outcome.internalResponse.split(part);
      assert.equal(parts.length - 1, 2, `both halves must be captured (got ${parts.length - 1}): the outcome must be constructed AFTER drainage completes, not snapshotted at exit`);
    });

    // --- P2-3: the drainage payload is generated inside the child ---

    test('the large drainage payload is generated inside the child, never a giant argv', async () => {
      // Structure contract (P2-3 round-9): the drainage child receives a
      // SIZE argument and generates the payload itself — the suite must run
      // on Linux CI where a >128 KiB single argument fails E2BIG.
      const { readFile } = await import('node:fs/promises');
      const source = await readFile(new URL('./shell-wait-probe.test.mjs', import.meta.url), 'utf8');
      // The drain test's CHILD SCRIPT body: from the unique script-builder
      // line to the run invocation. The asserted literal must not appear
      // inside it (checking the whole file would self-match this test's own
      // assertion source).
      const bodyStart = source.indexOf('payloadBytes = 300 * 1024');
      const bodyEnd = source.indexOf("timeoutMs: 30_000,\n      });", bodyStart);
      const childBody = source.slice(bodyStart, bodyEnd);
      assert.equal(childBody.includes("pad: 'x'.repeat(300 * 1024)"), false, 'the payload must not be built in the parent');
      assert.match(childBody, /payloadBytes/u, 'the child generates the payload from a size argument');
      assert.match(childBody, /chunk = "x"\.repeat/u, 'the payload is written in bounded chunks from inside the child');
    });
  });

  describe('review round 10 refinements: cross-rollout ordering, host-output suppression, released pipes', async () => {
    const { extractInterruptInteraction } = await import('../tools/shell-wait-probe/evidence.mjs');
    const { defaultCompanionChildSpawn } = await import('../tools/shell-wait-probe/fixture.mjs');

    const CHILD_THREAD = 'e2f3a4b5-8811-4d4e-9f0a-4b5c6d7e8f9a';
    const LAUNCHER = 'node "/installed/zcode/skills/rescue/launcher.mjs" invoke-prepared rescue';
    const HANDLE = 5;

    const at2 = (second) => `2026-10-06T07:00:${String(second).padStart(2, '0')}Z`;
    const stamped = (timestamp, event) => ({ timestamp, ...event });
    const fnCall = (name, callId, args, timestamp = null) => ({
      ...(timestamp ? stamped(timestamp, {}) : {}),
      type: 'response_item', payload: { type: 'function_call', name, call_id: callId, arguments: JSON.stringify(args) },
    });
    const fnOutput = (callId, output, timestamp = null) => ({
      ...(timestamp ? stamped(timestamp, {}) : {}),
      type: 'response_item', payload: { type: 'function_call_output', call_id: callId, output },
    });
    const completedOutputBody = (result) => [
      { type: 'input_text', text: 'Script completed\n' },
      { type: 'input_text', text: JSON.stringify(result) },
    ];
    const pendingOutputBody = (cellId) => [{ type: 'input_text', text: `Script running with cell ID ${cellId}\n` }];
    const binding = { childThreadId: CHILD_THREAD, command: LAUNCHER };

    /** Child: launch + ACTIVE poll (call at 05, response at 09). */
    const activePollChild = [
      { type: 'session_meta', payload: { id: CHILD_THREAD } },
      stamped(at2(0), fnCall('exec_command', 'launch-1', { cmd: LAUNCHER })),
      stamped(at2(1), fnOutput('launch-1', completedOutputBody({ output: '', exit_code: 0, session_id: HANDLE }))),
      stamped(at2(5), fnCall('write_stdin', 'poll-1', { session_id: HANDLE, chars: '', yield_time_ms: 3_600_000 })),
      stamped(at2(9), fnOutput('poll-1', pendingOutputBody('cell-1'))),
    ];

    // --- P2-1: index comparisons never cross rollout boundaries ---

    test('cross-rollout ordering uses timestamps: unrelated Root events cannot flip the pending window', () => {
      // The interrupt (07) sits inside the child poll interval (05→09) by
      // TIMESTAMP. Pre-fix, the interval comparisons ran cross-rollout INDEX
      // arithmetic (child indices vs lastCall's ROOT index), so appending
      // unrelated Root events moved lastCall's index across the child's
      // response index and flipped observed from true to false — identical
      // timestamps, opposite verdicts.
      const diag = (n) => [
        stamped(at2(1 + n * 0.001), fnCall('exec_command', `d${n}`, { cmd: `cat ${n}.txt` })),
        stamped(at2(1 + n * 0.001 + 0.0005), fnOutput(`d${n}`, completedOutputBody({ output: 'x', exit_code: 0 }))),
      ];
      const buildRoot = (preEvents) => [
        { type: 'session_meta', payload: { id: 'root-thread-1' } },
        ...preEvents,
        stamped(at2(7), fnCall('interrupt_agent', 'int-1', { target: CHILD_THREAD })),
        stamped(at2('07.2'), fnOutput('int-1', JSON.stringify({ previous_status: 'running' }))),
      ];
      const one = extractInterruptInteraction([buildRoot([...diag(1)]), activePollChild], [], binding);
      const three = extractInterruptInteraction([buildRoot([...diag(1), ...diag(2), ...diag(3)]), activePollChild], [], binding);
      assert.equal(one.orderingBound, true);
      assert.equal(one.pendingBeforeCall.observed, true);
      assert.equal(three.orderingBound, true);
      assert.equal(three.pendingBeforeCall.observed, true, 'unrelated Root events cannot flip a timestamp-proven pending window');
    });

    test('an interrupt BEFORE the poll call is not pending-window evidence', () => {
      // Timestamps alone: the interrupt at 03 precedes the poll call at 05 —
      // no pending window (pre-fix, cross-rollout index order could admit it).
      const earlyRoot = [
        { type: 'session_meta', payload: { id: 'root-thread-1' } },
        stamped(at2(3), fnCall('interrupt_agent', 'int-1', { target: CHILD_THREAD })),
        stamped(at2('03.2'), fnOutput('int-1', JSON.stringify({ previous_status: 'running' }))),
      ];
      const interaction = extractInterruptInteraction([[earlyRoot[0], ...earlyRoot.slice(1)], activePollChild], [], binding);
      assert.equal(interaction.orderingBound, true);
      assert.equal(interaction.pendingBeforeCall.observed, false, 'a pre-poll delivery is not a pending-window interruption');
    });

    // --- P2-2: the launch-failure record never carries raw host output ---

    test('a failed Status setup turn records structural facts, never raw stderr/stdout', async () => {
      // P2-2 round-10: the launch-failure message is built by the live
      // executor body from the turn outcome — the raw stream must never be
      // copied into the failure. This test pins the CONTRACT: the fixed
      // branch keeps only structural facts (exit code, stream, byte size),
      // the canary never survives, and the failed-record path still maps the
      // mapped facts end to end.
      const canary = 'private_task_canary_r10_secret';
      const launchTurn = { code: 1, stderr: `assistant echo: ${canary}`, stdout: `{"task":"${canary}"}\n` };
      // The PRE-FIX message shape (raw stream embedded) — asserted to be the
      // shape the fix replaced, then the FIXED shape is validated against
      // the deployed driver branch through the exported source.
      const { readFile } = await import('node:fs/promises');
      const driverSource = await readFile(new URL('../tools/shell-wait-probe/driver.mjs', import.meta.url), 'utf8');
      assert.equal(driverSource.includes('background job launch failed (${String(launchTurn.code)}): ${redactPrivatePaths(launchTurn.stderr || launchTurn.stdout, fixture)}'), false,
        'the launch-failure message must not embed raw host output (the pre-fix shape is gone)');
      assert.match(driverSource, /background job launch failed: exit code \$\{String\(launchTurn\.code\)\}, \$\{errorStream\} \$\{String\(errorBytes\)\} bytes \(content withheld\)/u,
        'the fixed branch retains only the exit code, the stream, and its byte size');
      // And the suppression contract end to end: the structural message
      // carries no canary for either stream.
      const errorStream = launchTurn.stderr && launchTurn.stderr.length > 0 ? 'stderr' : 'stdout';
      const errorBytes = Buffer.byteLength((errorStream === 'stderr' ? launchTurn.stderr : launchTurn.stdout) ?? '', 'utf8');
      const fixedMessage = `the live session's background job launch failed: exit code ${String(launchTurn.code)}, ${errorStream} ${String(errorBytes)} bytes (content withheld)`;
      assert.match(fixedMessage, /exit code [0-9]+, (stderr|stdout) [0-9]+ bytes \(content withheld\)/u);
      assert.equal(fixedMessage.includes(canary), false, 'the private content is withheld');
    });

    // --- P2-3: the drainage deadline releases the captured pipes ---

    test('the drainage bound releases held pipes so the process can exit', async () => {
      // The child spawns a DETACHED grandchild holding fd4's write end open,
      // then exits: the drain wait resolves via the 1 s bound, and the
      // captured streams must be DESTROYED — pre-fix each such run leaked one
      // live pipe socket (the descriptor-holding descendant kept the event
      // loop alive despite the advertised bound).
      const sockets = () => process._getActiveHandles().filter((handle) => handle?.constructor?.name === 'Socket').length;
      const leakChild = async () => {
        await defaultCompanionChildSpawn({
          command: process.execPath,
          args: ['-e', [
            'const fs = require("node:fs");',
            'const { spawn } = require("node:child_process");',
            'const part = process.argv[1];',
            'let off = 0; while (off < part.length) { off += fs.writeSync(4, part.slice(off)); }',
            'const holder = spawn(process.execPath, ["-e", "setTimeout(() => process.exit(0), 15000);"], { stdio: ["ignore", "ignore", "ignore", "ignore", 4, "ignore"], detached: true });',
            'holder.unref();',
            'process.exit(0);',
          ].join('\n'), '{"type":"background","job":{"id":"f"}}'],
          cwd: process.cwd(),
          env: process.env,
          callerEnvelope: { callerContext: 'test' },
          timeoutMs: 30_000,
        });
      };
      // Warm-up run settles the runner's own socket baseline.
      await leakChild();
      const before = sockets();
      await leakChild();
      const after = sockets();
      assert.equal(after, before, 'the drainage bound must destroy the captured streams: no pipe socket may leak per held-descriptor run');
    });
  });

  describe('review round 11 refinements: preparation-exclusive interruption binding, verified deadline outcomes', async () => {
    const { extractInterruptInteraction } = await import('../tools/shell-wait-probe/evidence.mjs');
    const { mapShellWaitLiveFacts, runHeldHostTurn } = await import('../tools/shell-wait-probe/driver.mjs');

    const CHILD_THREAD = 'f3a4b5c6-9922-4e5f-8a1b-5c6d7e8f9a0b';
    const LAUNCHER = 'node "/installed/zcode/skills/rescue/launcher.mjs" invoke-prepared rescue';
    const HANDLE = 5;
    const STATUS_JOB_ID = 'dd44ee55ff66aa11bb22cc33dd44ee55ff66aa11bb22cc33dd44ee55ff66aa11';

    const at3 = (second) => `2026-10-06T08:00:${String(second).padStart(2, '0')}Z`;
    const stamped = (timestamp, event) => ({ timestamp, ...event });
    const fnCall = (name, callId, args, timestamp = null) => ({
      ...(timestamp ? stamped(timestamp, {}) : {}),
      type: 'response_item', payload: { type: 'function_call', name, call_id: callId, arguments: JSON.stringify(args) },
    });
    const fnOutput = (callId, output, timestamp = null) => ({
      ...(timestamp ? stamped(timestamp, {}) : {}),
      type: 'response_item', payload: { type: 'function_call_output', call_id: callId, output },
    });
    const completedOutputBody = (result) => [
      { type: 'input_text', text: 'Script completed\n' },
      { type: 'input_text', text: JSON.stringify(result) },
    ];
    const pendingOutputBody = (cellId) => [{ type: 'input_text', text: `Script running with cell ID ${cellId}\n` }];
    const wrapperCell = (callId, input) => ({ type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: callId, input } });
    const wrapperOutput = (callId, output) => ({ type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: callId, output } });
    const binding = { childThreadId: CHILD_THREAD, command: LAUNCHER };
    const preparationEnvelope = {
      version: 5, source: 'explicit', task: 't',
      options: { hostPlacement: 'foreground', companionExecution: 'foreground', foregroundAdapter: 'shell', resume: 'fresh' },
      continuationTarget: null,
    };
    const prepWriteInput = `text(await tools.write_stdin({session_id:${HANDLE},chars:JSON.stringify(${JSON.stringify(preparationEnvelope)})+"\\n"}));\n`;

    // --- P2-1: interruption binds only to TERMINAL polls, never the preparation ---

    test('an interrupt during the preparation write is not observation-binding evidence', () => {
      // The rollout contains ONLY the sanctioned preparation write (its call
      // at 05, response at 06) plus the interrupt at 05.5 — the preparation
      // write is NOT a terminal poll, so no pending observation is bound.
      const rollouts = [
        [
          { type: 'session_meta', payload: { id: 'root-thread-1' } },
          stamped(at3(7), fnCall('interrupt_agent', 'int-1', { target: CHILD_THREAD })),
          stamped(at3('07.2'), fnOutput('int-1', JSON.stringify({ previous_status: 'running' }))),
        ],
        [
          { type: 'session_meta', payload: { id: CHILD_THREAD } },
          stamped(at3(0), fnCall('exec_command', 'launch-1', { cmd: LAUNCHER })),
          stamped(at3(1), fnOutput('launch-1', completedOutputBody({ output: '', exit_code: 0, session_id: HANDLE }))),
          stamped(at3(5), wrapperCell('prep-1', prepWriteInput)),
          stamped(at3(6), wrapperOutput('prep-1', pendingOutputBody('prep-cell'))),
        ],
      ];
      const interaction = extractInterruptInteraction(rollouts, [], binding);
      assert.equal(interaction.orderingBound, false, 'a preparation-only rollout binds no interruption evidence (attributable call set excludes preparation)');
      assert.equal(interaction.pendingBeforeCall.observed, false, 'the pending preparation write is never the observed long poll');
    });

    test('an interrupt during a preparation continuation is not observation-binding evidence either', () => {
      // The preparation write settles through its linked outer continuation
      // (the wait at 07) — still no terminal poll exists, so the interrupt at
      // 07.5 binds nothing.
      const rollouts = [
        [
          { type: 'session_meta', payload: { id: 'root-thread-1' } },
          stamped(at3('07.5'), fnCall('interrupt_agent', 'int-1', { target: CHILD_THREAD })),
          stamped(at3('07.7'), fnOutput('int-1', JSON.stringify({ previous_status: 'running' }))),
        ],
        [
          { type: 'session_meta', payload: { id: CHILD_THREAD } },
          stamped(at3(0), fnCall('exec_command', 'launch-1', { cmd: LAUNCHER })),
          stamped(at3(1), fnOutput('launch-1', completedOutputBody({ output: '', exit_code: 0, session_id: HANDLE }))),
          stamped(at3(5), wrapperCell('prep-1', prepWriteInput)),
          stamped(at3(6), wrapperOutput('prep-1', pendingOutputBody('prep-cell'))),
          stamped(at3(7), fnCall('wait', 'prep-wait', { cell_id: 'prep-cell' })),
          stamped(at3('07.2'), fnOutput('prep-wait', completedOutputBody({ output: '', session_id: HANDLE }))),
        ],
      ];
      const interaction = extractInterruptInteraction(rollouts, [], binding);
      assert.equal(interaction.orderingBound, false, 'preparation continuations are not attributable interruption evidence either');
      assert.equal(interaction.pendingBeforeCall.observed, false);
    });

    test('a preparation-only rollout with an interrupt stays inconclusive (no pollCount to map)', () => {
      const held = {
        endedBeforeGate: true, budgetExpired: false, identity: undefined, processAliveWhileHeld: null,
        result: { code: 0, stdout: '', stderr: '' },
        cleanup: { label: 'observation', releasedGate: true, verifiedProcessTerminated: true, codexTerminated: true, nativeInterruptionClaimed: false, errors: [] },
        timeline: { clock: 'held-turn-monotonic-elapsed-ms', launchedAtElapsedMs: 10, observationDetectedAtElapsedMs: 20, pollStartedAtElapsedMs: 30, holdDeadlineElapsedMs: 420_000, rootAcknowledgementAtElapsedMs: null, childSettlementDetectedAtElapsedMs: null, endedAtElapsedMs: 50 },
      };
      const evidence = {
        status: 'supported',
        facts: {
          completion: { qualified: false, processExit: null, publicResultMatched: null, decisiveEnd: null, structuralViolationCount: 0 },
          linkage: { checked: true, exact: true, agentType: 'zcode-rescue', childThreadId: CHILD_THREAD, parentThreadId: 'parent-1' },
          collection: { rolloutCount: 2, childToolCallCount: 3, truncated: false, excerpts: [] },
          companion: { launchCount: 1, sendCount: 1, sendCountKnown: true, duplicateLaunch: false, preLaunchDiagnostics: { excerpts: [], truncated: false } },
          handle: { originalHandleChecked: true, pollCount: 0, preparationFrameWrites: 1 },
          observations: { outerReturns: 0, modelCalls: 3, rootJoins: 1, decisiveWallMs: null, pendingInnerAtEnd: true },
        },
      };
      const rollouts = [
        [
          { type: 'session_meta', payload: { id: 'root-thread-1' } },
          stamped(at3(7), fnCall('interrupt_agent', 'int-1', { target: CHILD_THREAD })),
          stamped(at3('07.2'), fnOutput('int-1', JSON.stringify({ previous_status: 'running' }))),
        ],
        [
          { type: 'session_meta', payload: { id: CHILD_THREAD } },
          stamped(at3(0), fnCall('exec_command', 'launch-1', { cmd: LAUNCHER })),
          stamped(at3(1), fnOutput('launch-1', completedOutputBody({ output: '', exit_code: 0, session_id: HANDLE }))),
          stamped(at3(5), wrapperCell('prep-1', prepWriteInput)),
          stamped(at3(6), wrapperOutput('prep-1', pendingOutputBody('prep-cell'))),
        ],
      ];
      const facts = mapShellWaitLiveFacts(
        { case: 'rescue-interrupt', codexBinary: '/bin/x', sourceSha: 'a'.repeat(40), output: '/o', workerDurationMs: 420_000, capMs: null, pollMs: 3_600_000, budgetMs: 720_000 },
        held, evidence, null, null,
        { workspace: '/w', codexHome: '/h', installedRoot: '/i', env: {}, record: { variant: 'candidate', capMs: null, pollMs: 3_600_000, appliedArtifacts: [] } },
        rollouts, [], LAUNCHER,
      );
      assert.equal(facts.interrupt.orderingBound, false, 'the interruption binding excludes preparation');
      assert.notEqual(facts.inconclusive, null, 'a valid preparation-only rollout never claims interruption during a pending observation');
    });

    // --- P2-2: the deadline outcome derives from the VERIFIED timeout result ---

    test('an early host exit in the Status flow keeps its honest early-exit classification', async () => {
      let resolveResult;
      const result = new Promise((resolve) => { resolveResult = resolve; });
      const held = await runHeldHostTurn({
        launch: async () => {
          setTimeout(() => resolveResult({ code: 1, stdout: '', stderr: 'status command failed immediately' }), 30);
          return { result, terminate: async () => {} };
        },
        waitForGate: () => new Promise(() => {}),
        captureProcessIdentity: async () => { const error = new Error('marker absent'); /** @type {any} */ (error).code = 'ZCODE_SHELL_WAIT_MARKER_ABSENT'; throw error; },
        waitForProcessExit: async () => {},
        releaseGate: async () => {},
        statusDeadlineFlow: true,
        holdMs: 60_000,
        budgetMs: 120_000,
      });
      assert.equal(held.statusDeadlineReached ?? false, false, 'a nonzero early exit is never a verified deadline expiry');
      assert.equal(held.endedBeforeGate, true, 'the honest early-exit classification stands');
      assert.equal(held.cleanup.label, 'early-exit');
    });

    test('the verified production deadline framing is required before statusDeadlineReached', async () => {
      const { readFile } = await import('node:fs/promises');
      const timeoutOutput = JSON.stringify({
        error: {
          code: 'JOB_WAIT_TIMEOUT', category: 'timeout',
          message: `Timed out waiting for job ${STATUS_JOB_ID}.`,
          remedy: `Retry $zcode:status ${STATUS_JOB_ID} --wait.`,
          details: { jobId: STATUS_JOB_ID, status: 'queued', timeoutMs: 120000 },
        },
      }) + '\n';
      const deadlineMarkers = ['"code":"JOB_WAIT_TIMEOUT"', '"category":"timeout"', 'Timed out waiting for job '];
      const isVerifiedDeadline = (outcome) => outcome.code === 0 && typeof outcome.stdout === 'string'
        && deadlineMarkers.every((marker) => outcome.stdout.includes(marker));
      // The verified expiry: exit 0 with the production framing.
      assert.equal(isVerifiedDeadline({ code: 0, stdout: timeoutOutput, stderr: '' }), true);
      // An immediate command failure: nonzero exit, no framing.
      assert.equal(isVerifiedDeadline({ code: 1, stdout: '', stderr: 'status command failed immediately' }), false);
      // A nonzero exit that HAPPENS to echo timeout-shaped text is still not verified.
      assert.equal(isVerifiedDeadline({ code: 1, stdout: `x "code":"JOB_WAIT_TIMEOUT" x`, stderr: '' }), false);
      // And the deployed branch verifies the framing before marking the deadline reached.
      const driverSource = await readFile(new URL('../tools/shell-wait-probe/driver.mjs', import.meta.url), 'utf8');
      assert.match(driverSource, /statusDeadlineVerified/u, 'the deadline outcome is derived from the verified JOB_WAIT_TIMEOUT result');
    });
  });

  describe('review round 12 refinements: decoded Status deadline evidence, unproven cross-rollout windows', async () => {
    const { extractInterruptInteraction } = await import('../tools/shell-wait-probe/evidence.mjs');
    const { runHeldHostTurn, extractDeadlineEvidenceFromHostOutput } = await import('../tools/shell-wait-probe/driver.mjs');

    const CHILD_THREAD = 'a5b6c7d8-0033-4f6a-8b1c-6d7e8f9a0b1c';
    const LAUNCHER = 'node "/installed/zcode/skills/rescue/launcher.mjs" invoke-prepared rescue';
    const SENTINEL = 'ZCODE_RESCUE_PUBLIC_SENTINEL_7C9C';
    const STATUS_JOB_ID = 'ee55ff66aa11bb22cc33dd44ee55ff66aa11bb22cc33dd44ee55ff66aa11bb22cc';
    const HANDLE = 5;

    const at4 = (second) => `2026-10-06T09:00:${String(second).padStart(2, '0')}Z`;
    const stamped = (timestamp, event) => ({ timestamp, ...event });
    const fnCall = (name, callId, args, timestamp = null) => ({
      ...(timestamp ? stamped(timestamp, {}) : {}),
      type: 'response_item', payload: { type: 'function_call', name, call_id: callId, arguments: JSON.stringify(args) },
    });
    const fnOutput = (callId, output, timestamp = null) => ({
      ...(timestamp ? stamped(timestamp, {}) : {}),
      type: 'response_item', payload: { type: 'function_call_output', call_id: callId, output },
    });
    const completedOutputBody = (result) => [
      { type: 'input_text', text: 'Script completed\n' },
      { type: 'input_text', text: JSON.stringify(result) },
    ];
    const pendingOutputBody = (cellId) => [{ type: 'input_text', text: `Script running with cell ID ${cellId}\n` }];

    // --- P2-1: the deadline evidence is decoded from the host JSON transport ---

    test('a realistic --json host response carries the deadline inside escaped JSON fields', () => {
      // The real transport: codex exec --json wraps the Companion output in
      // an item.completed JSON line whose string fields ESCAPE the quotes.
      const companionEnvelope = JSON.stringify({
        error: {
          code: 'JOB_WAIT_TIMEOUT', category: 'timeout',
          message: `Timed out waiting for job ${STATUS_JOB_ID}.`,
          remedy: `Retry $zcode:status ${STATUS_JOB_ID} --wait.`,
          details: { jobId: STATUS_JOB_ID, status: 'queued', timeoutMs: 120000 },
        },
      });
      const hostLine = JSON.stringify({
        type: 'item.completed',
        item: { type: 'function_call_output', call_id: 'query-1', output: [
          { type: 'input_text', text: 'Script completed\n' },
          { type: 'input_text', text: companionEnvelope },
        ] },
      });
      const hostStdout = `${hostLine}\n`;
      // Raw stdout does NOT contain the unescaped marker shape.
      assert.equal(hostStdout.includes('"code":"JOB_WAIT_TIMEOUT"'), false, 'the raw transport escapes the markers (pre-fix verification could never match)');
      // The decoded evidence DOES.
      assert.equal(extractDeadlineEvidenceFromHostOutput({ code: 0, stdout: hostStdout, stderr: '' }), true,
        'the deadline evidence is validated against the DECODED linked tool output');
    });

    test('the deadline lifecycle verifies the decoded evidence before marking the deadline', async () => {
      let resolveResult;
      const result = new Promise((resolve) => { resolveResult = resolve; });
      const companionEnvelope = JSON.stringify({
        error: {
          code: 'JOB_WAIT_TIMEOUT', category: 'timeout',
          message: `Timed out waiting for job ${STATUS_JOB_ID}.`,
          remedy: `Retry $zcode:status ${STATUS_JOB_ID} --wait.`,
          details: { jobId: STATUS_JOB_ID, status: 'queued', timeoutMs: 120000 },
        },
      });
      const hostLine = JSON.stringify({
        type: 'item.completed',
        item: { type: 'function_call_output', call_id: 'query-1', output: [
          { type: 'input_text', text: 'Script completed\n' },
          { type: 'input_text', text: companionEnvelope },
        ] },
      });
      const held = await runHeldHostTurn({
        launch: async () => {
          setTimeout(() => resolveResult({ code: 0, stdout: `${hostLine}\n`, stderr: '' }), 30);
          return { result, terminate: async () => {} };
        },
        waitForGate: () => new Promise(() => {}),
        captureProcessIdentity: async () => { const error = new Error('marker absent'); /** @type {any} */ (error).code = 'ZCODE_SHELL_WAIT_MARKER_ABSENT'; throw error; },
        waitForProcessExit: async () => {},
        releaseGate: async () => {},
        statusDeadlineFlow: true,
        holdMs: 60_000,
        budgetMs: 120_000,
      });
      assert.equal(held.statusDeadlineReached, true, 'the realistic host-transport deadline response marks the deadline reached');
      assert.equal(held.cleanup.label, 'status-query-deadline');
    });

    // --- P2-2: an untimed cross-rollout response leaves the window unestablished ---

    test('an untimed completed poll response never claims a pending window across rollouts', () => {
      // The interrupt (root rollout, 07) follows the poll call, but the
      // completed child poll response carries NO timestamp: it could have
      // arrived before the interrupt — the window is unestablished.
      const root = [
        { type: 'session_meta', payload: { id: 'root-thread-1' } },
        stamped(at4(7), fnCall('interrupt_agent', 'int-1', { target: CHILD_THREAD })),
        stamped(at4('07.2'), fnOutput('int-1', JSON.stringify({ previous_status: 'running' }))),
      ];
      const child = [
        { type: 'session_meta', payload: { id: CHILD_THREAD } },
        stamped(at4(0), fnCall('exec_command', 'launch-1', { cmd: LAUNCHER })),
        stamped(at4(1), fnOutput('launch-1', completedOutputBody({ output: '', exit_code: 0, session_id: HANDLE }))),
        stamped(at4(5), fnCall('write_stdin', 'poll-1', { session_id: HANDLE, chars: '', yield_time_ms: 3_600_000 })),
        // The completed (terminal) response — deliberately UNTIMED.
        fnOutput('poll-1', completedOutputBody({ output: SENTINEL, exit_code: 0, session_id: HANDLE })),
      ];
      const interaction = extractInterruptInteraction([root, child], [], { childThreadId: CHILD_THREAD, command: LAUNCHER });
      assert.equal(interaction.orderingBound, true);
      assert.equal(interaction.pendingBeforeCall.observed, false, 'an untimed cross-rollout response leaves the pending window unestablished');
    });

    test('a timestamped response after the interrupt keeps the window established', () => {
      const root = [
        { type: 'session_meta', payload: { id: 'root-thread-1' } },
        stamped(at4(7), fnCall('interrupt_agent', 'int-1', { target: CHILD_THREAD })),
        stamped(at4('07.2'), fnOutput('int-1', JSON.stringify({ previous_status: 'running' }))),
      ];
      const child = [
        { type: 'session_meta', payload: { id: CHILD_THREAD } },
        stamped(at4(0), fnCall('exec_command', 'launch-1', { cmd: LAUNCHER })),
        stamped(at4(1), fnOutput('launch-1', completedOutputBody({ output: '', exit_code: 0, session_id: HANDLE }))),
        stamped(at4(5), fnCall('write_stdin', 'poll-1', { session_id: HANDLE, chars: '', yield_time_ms: 3_600_000 })),
        stamped(at4(9), fnOutput('poll-1', pendingOutputBody('cell-1'))),
      ];
      const interaction = extractInterruptInteraction([root, child], [], { childThreadId: CHILD_THREAD, command: LAUNCHER });
      assert.equal(interaction.orderingBound, true);
      assert.equal(interaction.pendingBeforeCall.observed, true, 'the response provably follows the interrupt: the window stands');
    });
  });

  describe('review round 13 refinements: real exec item schema, unestablished continuation windows, statement-granular preparation', async () => {
    const { extractInterruptInteraction } = await import('../tools/shell-wait-probe/evidence.mjs');
    const { extractDeadlineEvidenceFromHostOutput, runHeldHostTurn } = await import('../tools/shell-wait-probe/driver.mjs');

    const CHILD_THREAD = 'b7c8d9e0-1144-4f7b-8a2d-7e8f9a0b1c2d';
    const LAUNCHER = 'node "/installed/zcode/skills/rescue/launcher.mjs" invoke-prepared rescue';
    const SENTINEL = 'ZCODE_RESCUE_PUBLIC_SENTINEL_7C9C';
    const STATUS_JOB_ID = 'ff66aa11bb22cc33dd44ee55ff66aa11bb22cc33dd44ee55ff66aa11bb22cc33dd';
    const HANDLE = 5;

    const at5 = (second) => `2026-10-06T10:00:${String(second).padStart(2, '0')}Z`;
    const stamped = (timestamp, event) => ({ timestamp, ...event });
    const fnCall = (name, callId, args, timestamp = null) => ({
      ...(timestamp ? stamped(timestamp, {}) : {}),
      type: 'response_item', payload: { type: 'function_call', name, call_id: callId, arguments: JSON.stringify(args) },
    });
    const fnOutput = (callId, output, timestamp = null) => ({
      ...(timestamp ? stamped(timestamp, {}) : {}),
      type: 'response_item', payload: { type: 'function_call_output', call_id: callId, output },
    });
    const completedOutputBody = (result) => [
      { type: 'input_text', text: 'Script completed\n' },
      { type: 'input_text', text: JSON.stringify(result) },
    ];
    const pendingOutputBody = (cellId) => [{ type: 'input_text', text: `Script running with cell ID ${cellId}\n` }];
    const wrapperCell = (callId, input) => ({ type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: callId, input } });
    const wrapperOutput = (callId, output) => ({ type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: callId, output } });

    /** The REAL `codex exec --json` item.completed shape: item.type
     * `command_execution` with `aggregated_output` (exec_events.rs
     * CommandExecutionItem, snake_case, at pin 67727e7c). */
    const execItemLine = (companionEnvelope) => JSON.stringify({
      type: 'item.completed',
      item: {
        type: 'command_execution',
        command: 'status --wait --timeout-ms 120000',
        aggregated_output: `${companionEnvelope}\n`,
        exit_code: 0,
        status: 'completed',
      },
    });

    // --- P2-1: the deadline evidence reads the REAL exec item schema ---

    test('a realistic --json command_execution item carries the deadline evidence', () => {
      const companionEnvelope = JSON.stringify({
        error: {
          code: 'JOB_WAIT_TIMEOUT', category: 'timeout',
          message: `Timed out waiting for job ${STATUS_JOB_ID}.`,
          remedy: `Retry $zcode:status ${STATUS_JOB_ID} --wait.`,
          details: { jobId: STATUS_JOB_ID, status: 'queued', timeoutMs: 120000 },
        },
      });
      const hostStdout = `${execItemLine(companionEnvelope)}\n`;
      // Raw stdout contains only ESCAPED quotes — the raw marker check fails.
      assert.equal(hostStdout.includes('"code":"JOB_WAIT_TIMEOUT"'), false);
      assert.equal(extractDeadlineEvidenceFromHostOutput({ code: 0, stdout: hostStdout, stderr: '' }), true,
        'the REAL exec item schema (command_execution/aggregated_output) supplies the deadline evidence');
    });

    test('the deadline lifecycle marks the deadline from the real exec item schema', async () => {
      const companionEnvelope = JSON.stringify({
        error: {
          code: 'JOB_WAIT_TIMEOUT', category: 'timeout',
          message: `Timed out waiting for job ${STATUS_JOB_ID}.`,
          remedy: `Retry $zcode:status ${STATUS_JOB_ID} --wait.`,
          details: { jobId: STATUS_JOB_ID, status: 'queued', timeoutMs: 120000 },
        },
      });
      const held = await runHeldHostTurn({
        launch: async () => {
          const result = new Promise((resolve) => {
            setTimeout(() => resolve({ code: 0, stdout: `${execItemLine(companionEnvelope)}\n`, stderr: '' }), 30);
          });
          return { result, terminate: async () => {} };
        },
        waitForGate: () => new Promise(() => {}),
        captureProcessIdentity: async () => { const error = new Error('marker absent'); /** @type {any} */ (error).code = 'ZCODE_SHELL_WAIT_MARKER_ABSENT'; throw error; },
        waitForProcessExit: async () => {},
        releaseGate: async () => {},
        statusDeadlineFlow: true,
        holdMs: 60_000,
        budgetMs: 120_000,
      });
      assert.equal(held.statusDeadlineReached, true, 'the real exec item schema marks the deadline reached');
      assert.equal(held.cleanup.label, 'status-query-deadline');
    });

    // --- P2-2: an untimed continuation leaves the pending window unestablished ---

    test('an untimed accepted continuation after the interrupt cannot confirm the pending window', () => {
      // The Child pending header at 05 is timestamped, but the ACCEPTED
      // CONTINUATION (root rollout — wait call + response) that completed it
      // is UNTIMED: it could have completed before the interrupt. The window
      // stays unestablished.
      const root = [
        { type: 'session_meta', payload: { id: 'root-thread-1' } },
        stamped(at5(7), fnCall('interrupt_agent', 'int-1', { target: CHILD_THREAD })),
        stamped(at5('07.2'), fnOutput('int-1', JSON.stringify({ previous_status: 'running' }))),
      ];
      const child = [
        { type: 'session_meta', payload: { id: CHILD_THREAD } },
        stamped(at5(0), fnCall('exec_command', 'launch-1', { cmd: LAUNCHER })),
        stamped(at5(1), fnOutput('launch-1', completedOutputBody({ output: '', exit_code: 0, session_id: HANDLE }))),
        stamped(at5(5), fnCall('write_stdin', 'poll-1', { session_id: HANDLE, chars: '', yield_time_ms: 3_600_000 })),
        stamped(at5('05.5'), fnOutput('poll-1', pendingOutputBody('cell-1'))),
        // The accepted continuation — deliberately UNTIMED on both sides.
        fnCall('wait', 'outer-1', { cell_id: 'cell-1' }),
        fnOutput('outer-1', completedOutputBody({ output: SENTINEL, exit_code: 0, session_id: HANDLE })),
      ];
      const interaction = extractInterruptInteraction([root, child], [], { childThreadId: CHILD_THREAD, command: LAUNCHER });
      assert.equal(interaction.orderingBound, true);
      assert.equal(interaction.pendingBeforeCall.observed, false, 'an untimed continuation leaves the pending window unestablished');
    });

    // --- P2-3: preparation ownership is tracked per STATEMENT ---

    test('a preparation write shares its cell with a poll: only the statement is preparation', () => {
      // A supported TWO-statement cell: the validated preparation write
      // followed by the real empty-input poll. Both statements share the
      // event's call id — the poll must remain attributable.
      const cellInput = [
        prepWriteInputFor(),
        `const r = await tools.write_stdin(${JSON.stringify({ session_id: HANDLE, chars: '', yield_time_ms: 3_600_000 })}); text(JSON.stringify(r))\n`,
      ].join('\n');
      const root = [
        { type: 'session_meta', payload: { id: 'root-thread-1' } },
        stamped(at5(7), fnCall('interrupt_agent', 'int-1', { target: CHILD_THREAD })),
        stamped(at5('07.2'), fnOutput('int-1', JSON.stringify({ previous_status: 'running' }))),
      ];
      const child = [
        { type: 'session_meta', payload: { id: CHILD_THREAD } },
        stamped(at5(0), fnCall('exec_command', 'launch-1', { cmd: LAUNCHER })),
        stamped(at5(1), fnOutput('launch-1', completedOutputBody({ output: '', exit_code: 0, session_id: HANDLE }))),
        wrapperCell('cell-1', cellInput),
        // One JSON result per statement: prep result, then poll pending state.
        wrapperOutput('cell-1', [
          { type: 'input_text', text: JSON.stringify({ output: '', session_id: HANDLE }) },
          { type: 'input_text', text: 'Script running with cell ID cell-1\n' },
        ]),
      ];
      const interaction = extractInterruptInteraction([root, child], [], { childThreadId: CHILD_THREAD, command: LAUNCHER });
      assert.equal(interaction.orderingBound, true,
        'the poll sharing the preparation cell stays attributable (main observer: 1 prep, 1 poll, 0 violations)');
      assert.equal(interaction.pendingBeforeCall.observed, false, 'the poll had no response yet — the window is unestablished, not binding');
    });

    function prepWriteInputFor() {
      const preparationEnvelope = {
        version: 5, source: 'explicit', task: 't',
        options: { hostPlacement: 'foreground', companionExecution: 'foreground', foregroundAdapter: 'shell', resume: 'fresh' },
        continuationTarget: null,
      };
      return `text(await tools.write_stdin({session_id:${HANDLE},chars:JSON.stringify(${JSON.stringify(preparationEnvelope)})+"\\n"}));\n`;
    }
  });

  describe('review round 14 refinements: statement-start evidence, acknowledgement-independent holds', async () => {
    const { extractInterruptInteraction } = await import('../tools/shell-wait-probe/evidence.mjs');
    const { mapShellWaitLiveFacts, runHeldHostTurn, waitForPollObservation } = await import('../tools/shell-wait-probe/driver.mjs');

    const CHILD_THREAD = 'c8d9e0f1-2255-4a8c-9b3d-8f9a0b1c2d3e';
    const LAUNCHER = 'node "/installed/zcode/skills/rescue/launcher.mjs" invoke-prepared rescue';
    const HANDLE = 5;

    const at6 = (second) => `2026-10-06T11:00:${String(second).padStart(2, '0')}Z`;
    const stamped = (timestamp, event) => ({ timestamp, ...event });
    const fnCall = (name, callId, args, timestamp = null) => ({
      ...(timestamp ? stamped(timestamp, {}) : {}),
      type: 'response_item', payload: { type: 'function_call', name, call_id: callId, arguments: JSON.stringify(args) },
    });
    const fnOutput = (callId, output, timestamp = null) => ({
      ...(timestamp ? stamped(timestamp, {}) : {}),
      type: 'response_item', payload: { type: 'function_call_output', call_id: callId, output },
    });
    const completedOutputBody = (result) => [
      { type: 'input_text', text: 'Script completed\n' },
      { type: 'input_text', text: JSON.stringify(result) },
    ];
    const wrapperCell = (callId, input) => ({ type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: callId, input } });
    const wrapperOutput = (callId, output) => ({ type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: callId, output } });
    const binding = { childThreadId: CHILD_THREAD, command: LAUNCHER };

    // The P2-1 shared fixture: the validated preparation write and the real
    // empty-input poll share ONE supported cell whose SUBMISSION is stamped
    // (at 05) BEFORE the Root interrupt (at 07). The submission timestamps the
    // whole cell, never the later poll statement's start.
    const preparationEnvelope = {
      version: 5, source: 'explicit', task: 't',
      options: { hostPlacement: 'foreground', companionExecution: 'foreground', foregroundAdapter: 'shell', resume: 'fresh' },
      continuationTarget: null,
    };
    const sharedCellInput = [
      `text(await tools.write_stdin({session_id:${HANDLE},chars:JSON.stringify(${JSON.stringify(preparationEnvelope)})+"\\n"}));`,
      `const r = await tools.write_stdin(${JSON.stringify({ session_id: HANDLE, chars: '', yield_time_ms: 3_600_000 })}); text(JSON.stringify(r))\n`,
    ].join('\n');
    const rootRollout = [
      { type: 'session_meta', payload: { id: 'root-thread-1' } },
      stamped(at6(7), fnCall('interrupt_agent', 'int-1', { target: CHILD_THREAD })),
      stamped(at6('07.2'), fnOutput('int-1', JSON.stringify({ previous_status: 'running' }))),
    ];
    const childBase = [
      { type: 'session_meta', payload: { id: CHILD_THREAD } },
      stamped(at6(0), fnCall('exec_command', 'launch-1', { cmd: LAUNCHER })),
      stamped(at6(1), fnOutput('launch-1', completedOutputBody({ output: '', exit_code: 0, session_id: HANDLE }))),
    ];
    const sharedCellSubmitted = stamped(at6(5), wrapperCell('cell-1', sharedCellInput));
    // The supported yielded-cell output shape: the pending header leads, the
    // completed preparation result follows (parseStatementOutputs resolves the
    // completed prefix and leaves the poll statement pending).
    const sharedCellYield = wrapperOutput('cell-1', [
      { type: 'input_text', text: 'Script running with cell ID cell-1\n' },
      { type: 'input_text', text: JSON.stringify({ output: '', session_id: HANDLE }) },
    ]);

    // --- P2-1: a later statement's start needs preceding-completion evidence ---

    test('a shared-cell submission never anchors the later poll: an untimed yield leaves the window unestablished', () => {
      const child = [...childBase, sharedCellSubmitted, sharedCellYield];
      const interaction = extractInterruptInteraction([rootRollout, child], [], binding);
      assert.equal(interaction.orderingBound, true);
      assert.equal(interaction.pendingBeforeCall.observed, false,
        'the cell submission timestamp is not the poll start: the preparation completion carries no timestamp');
      assert.equal(interaction.pendingBeforeCall.atMs, null, 'an unestablished poll start records no pending anchor');
    });

    test('a shared-cell submission never anchors the later poll: a missing cell response leaves the poll start unknown', () => {
      const child = [...childBase, sharedCellSubmitted];
      const interaction = extractInterruptInteraction([rootRollout, child], [], binding);
      assert.equal(interaction.orderingBound, true);
      assert.equal(interaction.pendingBeforeCall.observed, false,
        'without the preparation completion evidence the later poll never started, so no window can stand');
      assert.equal(interaction.pendingBeforeCall.atMs, null);
    });

    test('a timestamped shared-cell response proving the preparation finished anchors the poll honestly', () => {
      const child = [...childBase, sharedCellSubmitted, stamped(at6(6), sharedCellYield)];
      const interaction = extractInterruptInteraction([rootRollout, child], [], binding);
      assert.equal(interaction.orderingBound, true);
      assert.equal(interaction.pendingBeforeCall.observed, true, 'the poll demonstrably ran (pending header at 06) and stood at the 07 interrupt');
      assert.equal(interaction.pendingBeforeCall.atMs, Date.parse(at6(6)), 'the anchor is the completion-evidence timestamp, never the cell submission');
    });

    test('the mapping keeps the interrupt case inconclusive when the poll start was never established', () => {
      const child = [...childBase, sharedCellSubmitted, sharedCellYield];
      const held = {
        endedBeforeGate: true, budgetExpired: false, identity: undefined, processAliveWhileHeld: null,
        result: { code: 0, stdout: '', stderr: '' },
        cleanup: { label: 'observation', releasedGate: true, verifiedProcessTerminated: true, codexTerminated: true, nativeInterruptionClaimed: false, errors: [] },
        timeline: { clock: 'held-turn-monotonic-elapsed-ms', launchedAtElapsedMs: 10, observationDetectedAtElapsedMs: 20, pollStartedAtElapsedMs: 30, holdDeadlineElapsedMs: 420_000, rootAcknowledgementAtElapsedMs: null, childSettlementDetectedAtElapsedMs: null, endedAtElapsedMs: 50 },
      };
      const evidence = {
        status: 'supported',
        facts: {
          completion: { qualified: false, processExit: null, publicResultMatched: null, decisiveEnd: null, structuralViolationCount: 0 },
          linkage: { checked: true, exact: true, agentType: 'zcode-rescue', childThreadId: CHILD_THREAD, parentThreadId: 'parent-1' },
          collection: { rolloutCount: 2, childToolCallCount: 4, truncated: false, excerpts: [] },
          companion: { launchCount: 1, sendCount: 1, sendCountKnown: true, duplicateLaunch: false, preLaunchDiagnostics: { excerpts: [], truncated: false } },
          handle: { originalHandleChecked: true },
          observations: { outerReturns: 1, modelCalls: 4, rootJoins: 1, decisiveWallMs: null, pendingInnerAtEnd: true },
        },
      };
      const facts = mapShellWaitLiveFacts(
        { case: 'rescue-interrupt', codexBinary: '/bin/x', sourceSha: 'a'.repeat(40), output: '/o', workerDurationMs: 420_000, capMs: null, pollMs: 3_600_000, budgetMs: 720_000 },
        held, evidence, null, null,
        { workspace: '/w', codexHome: '/h', installedRoot: '/i', env: {}, record: { variant: 'candidate', capMs: null, pollMs: 3_600_000, appliedArtifacts: [] } },
        [rootRollout, child], [], LAUNCHER,
      );
      assert.equal(facts.interrupt.pendingIntervalMs, null, 'a poll start that was never established is never a pending interval');
      assert.notEqual(facts.inconclusive, null, 'an interrupt that arrived while the preparation still ran is not a confirmed pending-window delivery');
    });

    // --- P2-1: the poll-start watch applies the same completion-evidence rule ---

    test('the poll-start watch fires on a shared-cell poll only once the preparation completion is evidenced', async () => {
      const submittedOnly = [...childBase, sharedCellSubmitted];
      const withYield = [...childBase, sharedCellSubmitted, sharedCellYield];
      const controller = new AbortController();
      let loads = 0;
      const outcome = await waitForPollObservation('/codex-home', LAUNCHER, controller.signal, {
        loadRollouts: async () => {
          loads += 1;
          if (loads >= 6) controller.abort();
          return loads >= 3 ? [withYield] : loads === 2 ? [submittedOnly] : [];
        },
        sleep: async () => {},
      }).then(() => 'resolved', () => 'aborted');
      assert.equal(outcome, 'resolved', 'the watch must resolve from the response-evidenced poll start, never from the bare cell submission');
    });

    test('a submitted shared cell whose preparation has not finished never triggers the poll-start watch', async () => {
      const submittedOnly = [...childBase, sharedCellSubmitted];
      const controller = new AbortController();
      let loads = 0;
      await assert.rejects(
        waitForPollObservation('/codex-home', LAUNCHER, controller.signal, {
          loadRollouts: async () => {
            loads += 1;
            if (loads >= 4) controller.abort();
            return [submittedOnly];
          },
          sleep: async () => {},
        }),
        /aborted/u,
        'a cell submission alone is never the measured poll start: the later poll has not started',
      );
    });

    // --- P2-2: the hold continues independently of a winning acknowledgement ---

    test('a winning acknowledgement never skips the hold: the completion gate releases only after holdMs', async () => {
      const clockStart = 1000;
      let clock = 0;
      const now = () => (clock += 1000);
      let releasedAtElapsedMs = null;
      const identity = { pid: 424242, ppid: 70, nonce: 'r14', startIdentity: 'start-r14' };
      const held = await runHeldHostTurn({
        launch: async () => ({ result: new Promise((resolve) => setTimeout(() => resolve({ code: 0, stdout: 'launched acknowledgement', stderr: '' }), 10)), terminate: async () => {} }),
        // Round-15 lifecycle: the worker reaches its gate (readiness) shortly
        // AFTER the acknowledgement — readiness precedes the hold, which the
        // result-first boundary still runs.
        waitForGate: async () => { await new Promise((resolve) => setTimeout(resolve, 50)); },
        gatePath: 'unused-gate',
        captureProcessIdentity: async () => identity,
        readProcessIdentity: async () => identity,
        terminateProcessIdentity: async () => ({ attempted: true, signalled: 'SIGTERM', exited: true, failure: null }),
        releaseGate: async () => { releasedAtElapsedMs = clock - clockStart; },
        sleep: async () => {},
        now,
        holdMs: 5000,
        budgetMs: 600_000,
        waitForChildSettlement: async () => ({ observed: true, basis: 'test-basis' }),
      });
      assert.equal(held.rootAcknowledged, true);
      assert.notEqual(held.timeline.holdDeadlineElapsedMs, null, 'the hold is applied even when the acknowledgement wins the boundary race');
      assert.notEqual(releasedAtElapsedMs, null);
      assert.ok(releasedAtElapsedMs >= /** @type {number} */ (held.timeline.holdDeadlineElapsedMs),
        `the completion gate released at elapsed ${String(releasedAtElapsedMs)} ms, before the recorded hold deadline ${String(held.timeline.holdDeadlineElapsedMs)} ms: the ack-first run must hold for the requested duration`);
    });
  });

  describe('review round 15 refinements: statement-owned interrupt timing, readiness-first holds, shared experiment budget', async () => {
    const { extractInterruptInteraction } = await import('../tools/shell-wait-probe/evidence.mjs');
    const { mapShellWaitLiveFacts, runHeldHostTurn } = await import('../tools/shell-wait-probe/driver.mjs');

    const CHILD_THREAD = 'd9e0f1a2-3366-4b9d-8c4e-9a0b1c2d3e4f';
    const LAUNCHER = 'node "/installed/zcode/skills/rescue/launcher.mjs" invoke-prepared rescue';
    const SENTINEL = 'ZCODE_RESCUE_PUBLIC_SENTINEL_7C9C';
    const HANDLE = 5;

    const at7 = (second) => `2026-10-06T12:00:${String(second).padStart(2, '0')}Z`;
    const stamped = (timestamp, event) => ({ timestamp, ...event });
    const fnCall = (name, callId, args, timestamp = null) => ({
      ...(timestamp ? stamped(timestamp, {}) : {}),
      type: 'response_item', payload: { type: 'function_call', name, call_id: callId, arguments: JSON.stringify(args) },
    });
    const fnOutput = (callId, output, timestamp = null) => ({
      ...(timestamp ? stamped(timestamp, {}) : {}),
      type: 'response_item', payload: { type: 'function_call_output', call_id: callId, output },
    });
    const completedOutputBody = (result) => [
      { type: 'input_text', text: 'Script completed\n' },
      { type: 'input_text', text: JSON.stringify(result) },
    ];
    const pendingOutputBody = (cellId) => [{ type: 'input_text', text: `Script running with cell ID ${cellId}\n` }];
    const wrapperCell = (callId, input) => ({ type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: callId, input } });
    const wrapperOutput = (callId, output) => ({ type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: callId, output } });
    const binding = { childThreadId: CHILD_THREAD, command: LAUNCHER };

    // The P2-1 repro fixture: the owning cell is SUBMITTED at 07 and its
    // FIRST statement awaits a command until 17; the Child completes at 12;
    // the interrupt statement only runs at the end (its result is in the 17
    // response). The cell submission timestamp (07) is never the interrupt
    // statement's execution time.
    const interruptCellInput = [
      `const r = await tools.exec_command(${JSON.stringify({ cmd: 'analyze --deep', yield_time_ms: 60_000 })}); text(JSON.stringify(r))\n`,
      `text(await tools.interrupt_agent({target:${JSON.stringify(CHILD_THREAD)}}));\n`,
    ].join('\n');
    const interruptCellSubmitted = stamped(at7(7), wrapperCell('own-1', interruptCellInput));
    const rootRollout = [
      { type: 'session_meta', payload: { id: 'root-thread-1' } },
      interruptCellSubmitted,
      stamped(at7(17), wrapperOutput('own-1', [
        { type: 'input_text', text: JSON.stringify({ output: 'analysis done', exit_code: 0 }) },
        { type: 'input_text', text: JSON.stringify({ previous_status: 'running' }) },
      ])),
    ];
    const childRollout = [
      { type: 'session_meta', payload: { id: CHILD_THREAD } },
      stamped(at7(0), fnCall('exec_command', 'launch-1', { cmd: LAUNCHER })),
      stamped(at7(1), fnOutput('launch-1', completedOutputBody({ output: '', exit_code: 0, session_id: HANDLE }))),
      stamped(at7(5), fnCall('write_stdin', 'poll-1', { session_id: HANDLE, chars: '', yield_time_ms: 3_600_000 })),
      stamped(at7('05.5'), fnOutput('poll-1', pendingOutputBody('cell-1'))),
      stamped(at7(9), fnCall('wait', 'outer-1', { cell_id: 'cell-1' })),
      stamped(at7(12), fnOutput('outer-1', completedOutputBody({ output: SENTINEL, exit_code: 0, session_id: HANDLE }))),
    ];

    test('a wrapped interrupt keeps bounded timing: the response is only the upper bound', () => {
      // Round-16 correction: the cell response ALSO covers statements after
      // the interrupt, so its timestamp is only notAfter — the exact
      // execution time stays unknown and the bounds are recorded.
      const interaction = extractInterruptInteraction([rootRollout, childRollout], [], binding);
      assert.equal(interaction.attempted, true);
      assert.equal(interaction.delivered, true);
      assert.equal(interaction.callAtMs, null, 'the cell response timestamp is an upper bound, never the exact execution time');
      assert.equal(interaction.callNotBeforeMs, Date.parse(at7(7)), 'notBefore is the cell submission');
      assert.equal(interaction.callNotAfterMs, Date.parse(at7(17)), 'notAfter is the completion-evidencing cell response');
    });

    test('a wrapped interrupt whose cell response proves nothing leaves the ordering unproven', () => {
      const untimedRoot = [
        { type: 'session_meta', payload: { id: 'root-thread-1' } },
        interruptCellSubmitted,
        wrapperOutput('own-1', [
          { type: 'input_text', text: JSON.stringify({ output: 'analysis done', exit_code: 0 }) },
          { type: 'input_text', text: JSON.stringify({ previous_status: 'running' }) },
        ]),
      ];
      const interaction = extractInterruptInteraction([untimedRoot, childRollout], [], binding);
      assert.equal(interaction.attempted, true);
      assert.equal(interaction.callAtMs, null, 'without a timestamped completion-evidencing response the interrupt ordering is unproven');
      assert.equal(interaction.pendingBeforeCall.observed, false, 'an unproven interrupt time never confirms a pending window');
    });

    test('the mapping keeps the overlapping completion conservative: unproven window, never a pending-window delivery', () => {
      // Round-16 correction: the Child completion (12) sits INSIDE the
      // interrupt statement's execution bounds [7, 17] — the ordering is
      // UNPROVEN, so neither a pending window nor a post-completion
      // classification is claimed.
      const held = {
        endedBeforeGate: true, budgetExpired: false, identity: undefined, processAliveWhileHeld: null,
        result: { code: 0, stdout: '', stderr: '' },
        cleanup: { label: 'observation', releasedGate: true, verifiedProcessTerminated: true, codexTerminated: true, nativeInterruptionClaimed: false, errors: [] },
        timeline: { clock: 'held-turn-monotonic-elapsed-ms', launchedAtElapsedMs: 10, observationDetectedAtElapsedMs: 20, pollStartedAtElapsedMs: 30, holdDeadlineElapsedMs: 420_000, rootAcknowledgementAtElapsedMs: null, childSettlementDetectedAtElapsedMs: null, endedAtElapsedMs: 50 },
      };
      const evidence = {
        status: 'supported',
        facts: {
          completion: { qualified: false, processExit: null, publicResultMatched: null, decisiveEnd: null, structuralViolationCount: 0 },
          linkage: { checked: true, exact: true, agentType: 'zcode-rescue', childThreadId: CHILD_THREAD, parentThreadId: 'parent-1' },
          collection: { rolloutCount: 2, childToolCallCount: 6, truncated: false, excerpts: [] },
          companion: { launchCount: 1, sendCount: 1, sendCountKnown: true, duplicateLaunch: false, preLaunchDiagnostics: { excerpts: [], truncated: false } },
          handle: { originalHandleChecked: true },
          observations: { outerReturns: 1, modelCalls: 6, rootJoins: 1, decisiveWallMs: null, pendingInnerAtEnd: false },
        },
      };
      const facts = mapShellWaitLiveFacts(
        { case: 'rescue-interrupt', codexBinary: '/bin/x', sourceSha: 'a'.repeat(40), output: '/o', workerDurationMs: 420_000, capMs: null, pollMs: 3_600_000, budgetMs: 720_000 },
        held, evidence, null, null,
        { workspace: '/w', codexHome: '/h', installedRoot: '/i', env: {}, record: { variant: 'candidate', capMs: null, pollMs: 3_600_000, appliedArtifacts: [] } },
        [rootRollout, childRollout], [], LAUNCHER,
      );
      assert.equal(facts.interrupt.pendingIntervalMs, null, 'a completion inside the execution bounds leaves the window unproven: no pending interval');
      assert.equal(facts.interrupt.settled, null, 'an unproven-window delivery is never settlement');
      assert.doesNotMatch(String(facts.interrupt.settledBasis), /post-completion/u, 'bounds overlap is unproven, never a claimed post-completion');
      assert.notEqual(facts.inconclusive, null, 'an interrupt with an unproven window keeps the case inconclusive');
    });

    // --- P2-2: the hold starts at worker readiness, not at the acknowledgement ---

    test('the hold starts only at worker readiness: a delayed gate-reached marker precedes the hold', async () => {
      let gateReached = false;
      let releasedAfterGateReached = null;
      const clockStart = 1000;
      let clock = 0;
      const now = () => (clock += 1000);
      let releasedAtElapsedMs = null;
      const identity = { pid: 525252, ppid: 70, nonce: 'r15', startIdentity: 'start-r15' };
      const held = await runHeldHostTurn({
        launch: async () => ({ result: new Promise((resolve) => setTimeout(() => resolve({ code: 0, stdout: 'launched acknowledgement', stderr: '' }), 5)), terminate: async () => {} }),
        // The worker reaches its gate LONG after the acknowledgement — and,
        // deliberately, long after the pre-fix hold (injected clock, bounded
        // real sleeps) would have released: only a readiness-first hold can
        // observe this marker before releasing.
        waitForGate: async () => { await new Promise((resolve) => setTimeout(resolve, 1000)); gateReached = true; },
        gatePath: 'unused-gate',
        captureProcessIdentity: async () => identity,
        readProcessIdentity: async () => identity,
        terminateProcessIdentity: async () => ({ attempted: true, signalled: 'SIGTERM', exited: true, failure: null }),
        releaseGate: async () => { releasedAfterGateReached = gateReached; releasedAtElapsedMs = clock - clockStart; },
        sleep: async () => {},
        now,
        holdMs: 3000,
        budgetMs: 600_000,
        waitForChildSettlement: async () => ({ observed: true, basis: 'test-basis' }),
      });
      assert.equal(held.rootAcknowledged, true);
      assert.equal(releasedAfterGateReached, true, 'the hold waits for the worker gate: the completion gate never opens before worker readiness');
      assert.notEqual(held.timeline.holdDeadlineElapsedMs, null);
      assert.ok(releasedAtElapsedMs >= /** @type {number} */ (held.timeline.holdDeadlineElapsedMs), 'the full hold still runs after readiness');
    });

    // --- P2-3: the experiment budget is shared across both Status turns ---

    test('the launch context shares the budget signal and remaining deadline, and expiry is honored mid-launch', async () => {
      /** @type {{ signal: AbortSignal, remainingMs: () => number } | null} */
      let observedContext = null;
      const held = await runHeldHostTurn({
        launch: async (budgetContext) => {
          observedContext = /** @type {{ signal: AbortSignal, remainingMs: () => number }} */ (budgetContext);
          assert.equal(typeof observedContext.remainingMs, 'function', 'the launch closure receives the experiment remaining deadline');
          assert.equal(observedContext.signal.aborted, false, 'the shared signal starts unaborted');
          assert.ok(observedContext.remainingMs() <= 500, 'the remaining deadline is bounded by the experiment budget');
          // The budget expires WHILE this launch closure runs (the sleep
          // deliberately outlasts the 500 ms budget): the shared signal and
          // remaining deadline must reflect it.
          await new Promise((resolve) => setTimeout(resolve, 800));
          return {
            result: Promise.resolve({ code: 0, stdout: `expired:${String(observedContext.signal.aborted)} remaining:${String(observedContext.remainingMs())}`, stderr: '' }),
            terminate: async () => {},
          };
        },
        waitForGate: () => new Promise(() => {}),
        gatePath: 'unused-gate',
        captureProcessIdentity: async () => { const error = new Error('marker absent'); /** @type {any} */ (error).code = 'ZCODE_SHELL_WAIT_MARKER_ABSENT'; throw error; },
        waitForProcessExit: async () => {},
        releaseGate: async () => {},
        holdMs: 0,
        budgetMs: 500,
      });
      assert.equal(held.budgetExpired, true);
      assert.equal(held.cleanup.label, 'budget-cleanup', 'a budget that expired during the launch closure is budget cleanup, never an early exit');
      assert.match(String(observedContext?.signal.aborted), /true/u, 'the shared signal carries the budget abort to the launch closure');
    });

    test('the Status query turn shares the remaining deadline and never resumes after expiry', async () => {
      const { readFile } = await import('node:fs/promises');
      const driverSource = await readFile(new URL('../tools/shell-wait-probe/driver.mjs', import.meta.url), 'utf8');
      assert.match(driverSource, /control = await input\.launch\(\{\s*signal: budgetController\.signal,\s*remainingMs/u,
        'the held turn passes the shared experiment cancellation signal and remaining deadline into the launch closure');
      assert.match(driverSource, /const budgetOutcome = new Promise[\s\S]{0,200}budgetController\.signal\.addEventListener[\s\S]{0,120}\);?\s*[\s\S]{0,40}control = await input\.launch/u,
          'the budget-abort listener is installed BEFORE the launch closure runs, so an already-fired abort is honored');
      assert.match(driverSource, /the experiment budget expired before the Status query turn/u,
        'the executor refuses to resume the query turn after budget expiry');
      assert.match(driverSource, /timeoutMs: .*?remaining/u, 'every turn runs on the REMAINING experiment deadline, never a fresh full budget');
      assert.match(driverSource, /budgetSignal\.addEventListener\('abort', \(\) => controller\.abort\(\)/u,
        'the turn controllers share the experiment cancellation signal');
    });
  });

  describe('review round 16 refinements: bounded interrupt timing, malformed-response windows', async () => {
    const { extractInterruptInteraction } = await import('../tools/shell-wait-probe/evidence.mjs');
    const { mapShellWaitLiveFacts } = await import('../tools/shell-wait-probe/driver.mjs');

    const CHILD_THREAD = 'e0f1a2b3-4477-4cbe-9d5f-ab1c2d3e4f60';
    const LAUNCHER = 'node "/installed/zcode/skills/rescue/launcher.mjs" invoke-prepared rescue';
    const SENTINEL = 'ZCODE_RESCUE_PUBLIC_SENTINEL_7C9C';
    const HANDLE = 5;

    const at8 = (second) => `2026-10-06T13:00:${String(second).padStart(2, '0')}Z`;
    const stamped = (timestamp, event) => ({ timestamp, ...event });
    const fnCall = (name, callId, args, timestamp = null) => ({
      ...(timestamp ? stamped(timestamp, {}) : {}),
      type: 'response_item', payload: { type: 'function_call', name, call_id: callId, arguments: JSON.stringify(args) },
    });
    const fnOutput = (callId, output, timestamp = null) => ({
      ...(timestamp ? stamped(timestamp, {}) : {}),
      type: 'response_item', payload: { type: 'function_call_output', call_id: callId, output },
    });
    const completedOutputBody = (result) => [
      { type: 'input_text', text: 'Script completed\n' },
      { type: 'input_text', text: JSON.stringify(result) },
    ];
    const pendingOutputBody = (cellId) => [{ type: 'input_text', text: `Script running with cell ID ${cellId}\n` }];
    const wrapperCell = (callId, input) => ({ type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: callId, input } });
    const wrapperOutput = (callId, output) => ({ type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: callId, output } });
    const binding = { childThreadId: CHILD_THREAD, command: LAUNCHER };

    // The P2-1 repro: the owning cell is submitted at 07; the interrupt
    // statement (statement 1, after a quick diagnostic) runs at ~07; the cell
    // then AWAITS a follow-up command until the response at 17. The Child
    // finishes at 12 — INSIDE the interrupt statement's execution bounds.
    const boundedCellInput = [
      `text(await tools.exec_command(${JSON.stringify({ cmd: 'cat notes.txt' })}));\n`,
      `text(await tools.interrupt_agent({target:${JSON.stringify(CHILD_THREAD)}}));\n`,
      `const r = await tools.exec_command(${JSON.stringify({ cmd: 'followup --wait', yield_time_ms: 60_000 })}); text(JSON.stringify(r))\n`,
    ].join('\n');
    const rootRollout = [
      { type: 'session_meta', payload: { id: 'root-thread-1' } },
      stamped(at8(7), wrapperCell('own-1', boundedCellInput)),
      stamped(at8(17), wrapperOutput('own-1', [
        { type: 'input_text', text: JSON.stringify({ output: 'notes', exit_code: 0 }) },
        { type: 'input_text', text: JSON.stringify({ previous_status: 'running' }) },
        { type: 'input_text', text: JSON.stringify({ output: 'followup done', exit_code: 0 }) },
      ])),
    ];
    const childRollout = (completionSecond) => [
      { type: 'session_meta', payload: { id: CHILD_THREAD } },
      stamped(at8(0), fnCall('exec_command', 'launch-1', { cmd: LAUNCHER })),
      stamped(at8(1), fnOutput('launch-1', completedOutputBody({ output: '', exit_code: 0, session_id: HANDLE }))),
      stamped(at8(5), fnCall('write_stdin', 'poll-1', { session_id: HANDLE, chars: '', yield_time_ms: 3_600_000 })),
      stamped(at8('05.5'), fnOutput('poll-1', pendingOutputBody('cell-1'))),
      stamped(at8(9), fnCall('wait', 'outer-1', { cell_id: 'cell-1' })),
      stamped(at8(completionSecond), fnOutput('outer-1', completedOutputBody({ output: SENTINEL, exit_code: 0, session_id: HANDLE }))),
    ];

    // --- P2-1: bounds, never an exact response-time claim ---

    test('a completion inside the interrupt bounds is unproven: neither pending window nor post-completion', () => {
      const interaction = extractInterruptInteraction([rootRollout, childRollout(12)], [], binding);
      assert.equal(interaction.attempted, true);
      assert.equal(interaction.delivered, true);
      assert.equal(interaction.callAtMs, null, 'the exact execution time is unknown: the response timestamp is only an upper bound');
      assert.equal(interaction.callNotBeforeMs, Date.parse(at8(7)));
      assert.equal(interaction.callNotAfterMs, Date.parse(at8(17)));
      assert.equal(interaction.pendingBeforeCall.observed, false, 'a completion inside the bounds overlaps the window: unproven');
      assert.equal(interaction.completedBeforeCall.atMs, null, 'a completion inside the bounds is never claimed post-completion');
    });

    test('a completion provably after the bounds keeps the window established', () => {
      const interaction = extractInterruptInteraction([rootRollout, childRollout(20)], [], binding);
      assert.equal(interaction.callAtMs, null);
      assert.equal(interaction.pendingBeforeCall.observed, true, 'the window provably spans the whole bounds: the observation stands');
      assert.equal(interaction.pendingBeforeCall.atMs, Date.parse(at8('05.5')));
      assert.equal(interaction.completedBeforeCall.atMs, null, 'a completion after the bounds is never claimed pre-delivery');
    });

    test('a completion provably before the bounds is honestly post-completion', () => {
      const interaction = extractInterruptInteraction([rootRollout, childRollout(6)], [], binding);
      assert.equal(interaction.pendingBeforeCall.observed, false, 'the window closed before the earliest possible execution');
      assert.equal(interaction.completedBeforeCall.atMs, Date.parse(at8(6)), 'a completion before notBefore is provably pre-delivery');
    });

    test('the mapping keeps bounds-overlap deliveries unsettled and inconclusive', () => {
      const held = {
        endedBeforeGate: true, budgetExpired: false, identity: undefined, processAliveWhileHeld: null,
        result: { code: 0, stdout: '', stderr: '' },
        cleanup: { label: 'observation', releasedGate: true, verifiedProcessTerminated: true, codexTerminated: true, nativeInterruptionClaimed: false, errors: [] },
        timeline: { clock: 'held-turn-monotonic-elapsed-ms', launchedAtElapsedMs: 10, observationDetectedAtElapsedMs: 20, pollStartedAtElapsedMs: 30, holdDeadlineElapsedMs: 420_000, rootAcknowledgementAtElapsedMs: null, childSettlementDetectedAtElapsedMs: null, endedAtElapsedMs: 50 },
      };
      const evidence = {
        status: 'supported',
        facts: {
          completion: { qualified: false, processExit: null, publicResultMatched: null, decisiveEnd: null, structuralViolationCount: 0 },
          linkage: { checked: true, exact: true, agentType: 'zcode-rescue', childThreadId: CHILD_THREAD, parentThreadId: 'parent-1' },
          collection: { rolloutCount: 2, childToolCallCount: 6, truncated: false, excerpts: [] },
          companion: { launchCount: 1, sendCount: 1, sendCountKnown: true, duplicateLaunch: false, preLaunchDiagnostics: { excerpts: [], truncated: false } },
          handle: { originalHandleChecked: true },
          observations: { outerReturns: 1, modelCalls: 6, rootJoins: 1, decisiveWallMs: null, pendingInnerAtEnd: false },
        },
      };
      const facts = mapShellWaitLiveFacts(
        { case: 'rescue-interrupt', codexBinary: '/bin/x', sourceSha: 'a'.repeat(40), output: '/o', workerDurationMs: 420_000, capMs: null, pollMs: 3_600_000, budgetMs: 720_000 },
        held, evidence, null, null,
        { workspace: '/w', codexHome: '/h', installedRoot: '/i', env: {}, record: { variant: 'candidate', capMs: null, pollMs: 3_600_000, appliedArtifacts: [] } },
        [rootRollout, childRollout(12)], [], LAUNCHER,
      );
      assert.equal(facts.interrupt.pendingIntervalMs, null, 'a bounds-overlap window is unproven: no pending interval');
      assert.equal(facts.interrupt.settled, null);
      assert.doesNotMatch(String(facts.interrupt.settledBasis), /post-completion/u, 'bounds overlap is unproven, never claimed post-completion');
      assert.notEqual(facts.inconclusive, null, 'an unproven-window delivery keeps the interrupt case inconclusive');
    });

    // --- P2-2: a malformed poll response is never an absent response ---

    const malformedPollChild = [
      { type: 'session_meta', payload: { id: CHILD_THREAD } },
      stamped(at8(0), fnCall('exec_command', 'launch-1', { cmd: LAUNCHER })),
      stamped(at8(1), fnOutput('launch-1', completedOutputBody({ output: '', exit_code: 0, session_id: HANDLE }))),
      // The poll is submitted at 10 and its response OBSERVED at 11 — but the
      // body is unparseable: the response boundary is KNOWN-BROKEN, never
      // absent.
      stamped(at8(10), fnCall('write_stdin', 'poll-1', { session_id: HANDLE, chars: '', yield_time_ms: 3_600_000 })),
      stamped(at8(11), fnOutput('poll-1', '~~malformed-not-a-response-body~~')),
    ];

    test('a poll with an observed but unparseable response never establishes a pending window', () => {
      const root = [
        { type: 'session_meta', payload: { id: 'root-thread-1' } },
        stamped(at8(12), fnCall('interrupt_agent', 'int-1', { target: CHILD_THREAD })),
        stamped(at8('12.2'), fnOutput('int-1', JSON.stringify({ previous_status: 'running' }))),
      ];
      const interaction = extractInterruptInteraction([[root[0], ...root.slice(1)], malformedPollChild], [], binding);
      assert.equal(interaction.attempted, true);
      assert.equal(interaction.orderingBound, true);
      assert.equal(interaction.pendingBeforeCall.observed, false,
        'an observed-but-broken response boundary is unestablished: only a genuinely absent response is outstanding');
    });

    test('the mapping cannot qualify an interrupt whose only window evidence is a malformed response', () => {
      const root = [
        { type: 'session_meta', payload: { id: 'root-thread-1' } },
        stamped(at8(12), fnCall('interrupt_agent', 'int-1', { target: CHILD_THREAD })),
        stamped(at8('12.2'), fnOutput('int-1', JSON.stringify({ previous_status: 'running' }))),
      ];
      const held = {
        endedBeforeGate: true, budgetExpired: false, identity: undefined, processAliveWhileHeld: null,
        result: { code: 0, stdout: '', stderr: '' },
        cleanup: { label: 'observation', releasedGate: true, verifiedProcessTerminated: true, codexTerminated: true, nativeInterruptionClaimed: false, errors: [] },
        timeline: { clock: 'held-turn-monotonic-elapsed-ms', launchedAtElapsedMs: 10, observationDetectedAtElapsedMs: 20, pollStartedAtElapsedMs: 30, holdDeadlineElapsedMs: 420_000, rootAcknowledgementAtElapsedMs: null, childSettlementDetectedAtElapsedMs: null, endedAtElapsedMs: 50 },
      };
      const evidence = {
        status: 'supported',
        facts: {
          completion: { qualified: false, processExit: null, publicResultMatched: null, decisiveEnd: null, structuralViolationCount: 0 },
          linkage: { checked: true, exact: true, agentType: 'zcode-rescue', childThreadId: CHILD_THREAD, parentThreadId: 'parent-1' },
          collection: { rolloutCount: 2, childToolCallCount: 2, truncated: false, excerpts: [] },
          companion: { launchCount: 1, sendCount: 1, sendCountKnown: true, duplicateLaunch: false, preLaunchDiagnostics: { excerpts: [], truncated: false } },
          handle: { originalHandleChecked: true },
          observations: { outerReturns: 0, modelCalls: 4, rootJoins: 1, decisiveWallMs: null, pendingInnerAtEnd: true },
        },
      };
      const facts = mapShellWaitLiveFacts(
        { case: 'rescue-interrupt', codexBinary: '/bin/x', sourceSha: 'a'.repeat(40), output: '/o', workerDurationMs: 420_000, capMs: null, pollMs: 3_600_000, budgetMs: 720_000 },
        held, evidence, null, null,
        { workspace: '/w', codexHome: '/h', installedRoot: '/i', env: {}, record: { variant: 'candidate', capMs: null, pollMs: 3_600_000, appliedArtifacts: [] } },
        [[root[0], ...root.slice(1)], malformedPollChild], [], LAUNCHER,
      );
      assert.equal(facts.interrupt.pendingIntervalMs, null, 'a malformed response boundary is unestablished: no pending interval');
      assert.notEqual(facts.inconclusive, null, 'the interrupt exemption cannot qualify a malformed-response window');
    });
  });

  describe('review round 17 refinements: production-parsable Status prompts, gate-won deadlines, bounded outstanding intervals', async () => {
    const { extractInterruptInteraction } = await import('../tools/shell-wait-probe/evidence.mjs');
    const { mapShellWaitLiveFacts, runHeldHostTurn, SHELL_WAIT_CASE_SPECS, statusWaitInvocation } = await import('../tools/shell-wait-probe/driver.mjs');
    const { parseRecordedInvocation } = await import('../scripts/lib/invocation.mjs');
    const { parseArgs } = await import('../scripts/lib/args.mjs');

    const CHILD_THREAD = 'f1a2b3c4-5588-4dcf-8e60-bc2d3e4f6071';
    const LAUNCHER = 'node "/installed/zcode/skills/rescue/launcher.mjs" invoke-prepared rescue';
    const SENTINEL = 'ZCODE_RESCUE_PUBLIC_SENTINEL_7C9C';
    const HANDLE = 5;
    // A REAL 64-hex production identifier: the query prompt is validated
    // through statusWaitInvocation and the real parsers (round-17).
    const STATUS_JOB_ID = 'ab'.repeat(32);

    const at9 = (second) => `2026-10-06T14:00:${String(second).padStart(2, '0')}Z`;
    const stamped = (timestamp, event) => ({ timestamp, ...event });
    const fnCall = (name, callId, args, timestamp = null) => ({
      ...(timestamp ? stamped(timestamp, {}) : {}),
      type: 'response_item', payload: { type: 'function_call', name, call_id: callId, arguments: JSON.stringify(args) },
    });
    const fnOutput = (callId, output, timestamp = null) => ({
      ...(timestamp ? stamped(timestamp, {}) : {}),
      type: 'response_item', payload: { type: 'function_call_output', call_id: callId, output },
    });
    const completedOutputBody = (result) => [
      { type: 'input_text', text: 'Script completed\n' },
      { type: 'input_text', text: JSON.stringify(result) },
    ];
    const wrapperCell = (callId, input) => ({ type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: callId, input } });
    const wrapperOutput = (callId, output) => ({ type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: callId, output } });
    const binding = { childThreadId: CHILD_THREAD, command: LAUNCHER };

    // --- P2-1: both Status prompts must parse through the REAL production parsers ---

    test('the status-wait launch prompt parses through parseRecordedInvocation and parseArgs', () => {
      const { argv, explicit } = parseRecordedInvocation('review', SHELL_WAIT_CASE_SPECS['status-wait'].prompt);
      assert.equal(explicit, true, 'the prompt carries an explicit skill invocation');
      assert.deepEqual(argv, ['review', '--background'], 'nothing may follow the skill marker: the prose precedes the invocation');
      const parsed = parseArgs(argv);
      assert.equal(parsed.options.execution, 'background', 'the real production parser must accept the rendered launch invocation');
    });

    test('the rendered Status query prompt parses through parseRecordedInvocation and parseArgs', () => {
      const { prompt } = statusWaitInvocation({ jobId: STATUS_JOB_ID, queryTimeoutMs: 240_000 });
      const { argv, explicit } = parseRecordedInvocation('status', prompt);
      assert.equal(explicit, true, 'the prompt carries an explicit skill invocation');
      assert.deepEqual(argv, ['status', STATUS_JOB_ID, '--wait', '--timeout-ms', '240000'],
        'nothing may follow the skill marker: the explanatory prose (which itself names --timeout-ms) precedes the invocation');
      const parsed = parseArgs(argv);
      assert.equal(parsed.options.wait, true);
      assert.equal(parsed.options.timeoutMs, 240_000, 'the real production parser must accept the rendered query invocation');
      assert.deepEqual(parsed.positionals, [STATUS_JOB_ID]);
    });

    // --- P2-2: the Status deadline is honored when the worker gate wins ---

    test('a Status query result that arrives during the held-worker phase still marks the deadline', async () => {
      // Production `invoke review --background` starts a real worker, so the
      // worker gate can win the boundary race while the query turn has ALREADY
      // finished at its deadline: the result must be handled independently of
      // which boundary won (10 ms result vs 200 ms hold vs 80 ms budget).
      const timeoutStdout = `${JSON.stringify({
        error: {
          code: 'JOB_WAIT_TIMEOUT', category: 'timeout',
          message: `Timed out waiting for job ${STATUS_JOB_ID}.`,
          remedy: `Retry $zcode:status ${STATUS_JOB_ID} --wait.`,
          details: { jobId: STATUS_JOB_ID, status: 'queued', timeoutMs: 120_000 },
        },
      })}\n`;
      const held = await runHeldHostTurn({
        launch: async () => ({ result: new Promise((resolve) => setTimeout(() => resolve({ code: 0, stdout: timeoutStdout, stderr: '' }), 10)), terminate: async () => {} }),
        // The worker gate WINS the race: readiness resolves immediately.
        waitForGate: async () => {},
        captureProcessIdentity: async () => ({ pid: 636363, ppid: 70, nonce: 'r17', startIdentity: 'start-r17' }),
        readProcessIdentity: async () => undefined,
        waitForProcessExit: async () => {},
        releaseGate: async () => {},
        holdMs: 200,
        budgetMs: 80,
        statusDeadlineFlow: true,
      });
      assert.equal(held.statusDeadlineReached, true, 'the verified deadline framing is honored even when the worker gate won');
      assert.equal(held.endedBeforeGate, false);
      assert.equal(held.budgetExpired, false, 'the deadline never waits out the budget');
      assert.equal(held.cleanup.label, 'status-query-deadline');
    });

    // --- P2-3: bounds ordering applies to OUTSTANDING poll intervals ---

    test('a bounded interrupt observes an outstanding poll interval that spans its bounds', () => {
      // The interrupt is a later statement of a supported Root cell: the cell
      // is submitted at 10, the response (evidencing the preceding statement)
      // arrives at 20 — bounds [10, 20], exact time unknown. The Child poll's
      // call-to-response interval (2 → 50) provably spans the whole bounds.
      const boundedCellInput = [
        `text(await tools.exec_command(${JSON.stringify({ cmd: 'cat notes.txt' })}));\n`,
        `text(await tools.interrupt_agent({target:${JSON.stringify(CHILD_THREAD)}}));\n`,
      ].join('\n');
      const root = [
        { type: 'session_meta', payload: { id: 'root-thread-1' } },
        stamped(at9(10), wrapperCell('own-1', boundedCellInput)),
        stamped(at9(20), wrapperOutput('own-1', [
          { type: 'input_text', text: JSON.stringify({ output: 'notes', exit_code: 0 }) },
          { type: 'input_text', text: JSON.stringify({ previous_status: 'running' }) },
        ])),
      ];
      const child = [
        { type: 'session_meta', payload: { id: CHILD_THREAD } },
        stamped(at9(0), fnCall('exec_command', 'launch-1', { cmd: LAUNCHER })),
        stamped(at9(1), fnOutput('launch-1', completedOutputBody({ output: '', exit_code: 0, session_id: HANDLE }))),
        stamped(at9(2), fnCall('write_stdin', 'poll-1', { session_id: HANDLE, chars: '', yield_time_ms: 3_600_000 })),
        stamped(at9(50), fnOutput('poll-1', completedOutputBody({ output: SENTINEL, exit_code: 0, session_id: HANDLE }))),
      ];
      const interaction = extractInterruptInteraction([root, child], [], binding);
      assert.equal(interaction.attempted, true);
      assert.equal(interaction.delivered, true);
      assert.equal(interaction.orderingBound, true);
      assert.equal(interaction.callAtMs, null, 'the interrupt keeps its bounded (unknown exact) timing');
      assert.equal(interaction.callNotBeforeMs, Date.parse(at9(10)));
      assert.equal(interaction.callNotAfterMs, Date.parse(at9(20)));
      assert.equal(interaction.pendingBeforeCall.observed, true,
        'the outstanding poll interval [2, 50] provably spans the execution bounds [10, 20]: the pending window stands');
      assert.equal(interaction.pendingBeforeCall.atMs, Date.parse(at9(2)), 'the interval anchor is the poll call');
    });

    test('the mapping qualifies a bounded interrupt whose outstanding interval spans the bounds', () => {
      const boundedCellInput = [
        `text(await tools.exec_command(${JSON.stringify({ cmd: 'cat notes.txt' })}));\n`,
        `text(await tools.interrupt_agent({target:${JSON.stringify(CHILD_THREAD)}}));\n`,
      ].join('\n');
      const root = [
        { type: 'session_meta', payload: { id: 'root-thread-1' } },
        stamped(at9(10), wrapperCell('own-1', boundedCellInput)),
        stamped(at9(20), wrapperOutput('own-1', [
          { type: 'input_text', text: JSON.stringify({ output: 'notes', exit_code: 0 }) },
          { type: 'input_text', text: JSON.stringify({ previous_status: 'running' }) },
        ])),
      ];
      const child = [
        { type: 'session_meta', payload: { id: CHILD_THREAD } },
        stamped(at9(0), fnCall('exec_command', 'launch-1', { cmd: LAUNCHER })),
        stamped(at9(1), fnOutput('launch-1', completedOutputBody({ output: '', exit_code: 0, session_id: HANDLE }))),
        stamped(at9(2), fnCall('write_stdin', 'poll-1', { session_id: HANDLE, chars: '', yield_time_ms: 3_600_000 })),
        stamped(at9(50), fnOutput('poll-1', completedOutputBody({ output: SENTINEL, exit_code: 0, session_id: HANDLE }))),
      ];
      const held = {
        endedBeforeGate: true, budgetExpired: false, identity: undefined, processAliveWhileHeld: null,
        result: { code: 0, stdout: '', stderr: '' },
        cleanup: { label: 'observation', releasedGate: true, verifiedProcessTerminated: true, codexTerminated: true, nativeInterruptionClaimed: false, errors: [] },
        timeline: { clock: 'held-turn-monotonic-elapsed-ms', launchedAtElapsedMs: 10, observationDetectedAtElapsedMs: 20, pollStartedAtElapsedMs: 30, holdDeadlineElapsedMs: 420_000, rootAcknowledgementAtElapsedMs: null, childSettlementDetectedAtElapsedMs: null, endedAtElapsedMs: 50 },
      };
      const evidence = {
        status: 'supported',
        facts: {
          completion: { qualified: false, processExit: null, publicResultMatched: null, decisiveEnd: null, structuralViolationCount: 0 },
          linkage: { checked: true, exact: true, agentType: 'zcode-rescue', childThreadId: CHILD_THREAD, parentThreadId: 'parent-1' },
          collection: { rolloutCount: 2, childToolCallCount: 4, truncated: false, excerpts: [] },
          companion: { launchCount: 1, sendCount: 1, sendCountKnown: true, duplicateLaunch: false, preLaunchDiagnostics: { excerpts: [], truncated: false } },
          handle: { originalHandleChecked: true },
          observations: { outerReturns: 1, modelCalls: 4, rootJoins: 1, decisiveWallMs: null, pendingInnerAtEnd: false },
        },
      };
      const facts = mapShellWaitLiveFacts(
        { case: 'rescue-interrupt', codexBinary: '/bin/x', sourceSha: 'a'.repeat(40), output: '/o', workerDurationMs: 420_000, capMs: null, pollMs: 3_600_000, budgetMs: 720_000 },
        held, evidence, null, null,
        { workspace: '/w', codexHome: '/h', installedRoot: '/i', env: {}, record: { variant: 'candidate', capMs: null, pollMs: 3_600_000, appliedArtifacts: [] } },
        [root, child], [], LAUNCHER,
      );
      assert.equal(facts.inconclusive, null, 'a valid bounded-interrupt pending-window delivery is the case contract');
    });
  });

  describe('review round 18 refinements: effective budget during held status races, observed acknowledgements, resolution-time stamps', async () => {
    const { mapShellWaitLiveFacts, runHeldHostTurn } = await import('../tools/shell-wait-probe/driver.mjs');
    const LAUNCHER_CONSTANT = 'node "/installed/zcode/skills/rescue/launcher.mjs" invoke-prepared rescue';

    const ACK_STDOUT = 'The Host Rescue child was launched.';

    const heldFixtures = {
      identity: { pid: 818181, ppid: 70, nonce: 'r18', startIdentity: 'start-r18' },
    };

    // --- P2-1: budget cancellation stays effective during held status races ---

    test('an unverified early Status result never starves the budget during the held phase', async () => {
      const held = await runHeldHostTurn({
        launch: async () => ({ result: new Promise((resolve) => setTimeout(() => resolve({ code: 0, stdout: 'plain output without any deadline framing', stderr: '' }), 10)), terminate: async () => {} }),
        waitForGate: async () => {},
        captureProcessIdentity: async () => heldFixtures.identity,
        readProcessIdentity: async () => undefined,
        waitForProcessExit: async () => {},
        releaseGate: async () => {},
        holdMs: 150,
        budgetMs: 50,
        statusDeadlineFlow: true,
      });
      assert.equal(held.budgetExpired, true, 'budget cancellation must remain effective: a settled result never starves the budget timer');
      assert.equal(held.cleanup.label, 'budget-cleanup');
    });

    // --- P2-2: a successful observed Root acknowledgement is required ---

    const backgroundMappingFixture = (result, endedBeforeGate) => {
      const held = {
        endedBeforeGate, budgetExpired: false, identity: undefined, processAliveWhileHeld: null,
        result,
        childSettlement: { observed: true, basis: 'exact-launch-handle-linked-completed-exit-code-output' },
        cleanup: { label: 'child-settlement-observed', releasedGate: true, verifiedProcessTerminated: true, codexTerminated: true, nativeInterruptionClaimed: false, errors: [] },
        timeline: { clock: 'held-turn-monotonic-elapsed-ms', launchedAtElapsedMs: 10, observationDetectedAtElapsedMs: 20, pollStartedAtElapsedMs: 30, holdDeadlineElapsedMs: 420_000, rootAcknowledgementAtElapsedMs: 40, childSettlementDetectedAtElapsedMs: 50, endedAtElapsedMs: 60 },
      };
      const evidence = {
        status: 'supported',
        facts: {
          completion: { qualified: true, processExit: 0, publicResultMatched: true, decisiveEnd: 'process-exit', structuralViolationCount: 0 },
          linkage: { checked: true, exact: true, agentType: 'zcode-rescue', childThreadId: 'b1c2d3e4-6600-4da1-8f72-cd3e4f607182', parentThreadId: 'parent-1' },
          collection: { rolloutCount: 2, childToolCallCount: 4, truncated: false, excerpts: [] },
          companion: { launchCount: 1, sendCount: 1, sendCountKnown: true, duplicateLaunch: false, preLaunchDiagnostics: { excerpts: [], truncated: false } },
          handle: { originalHandleChecked: true },
          observations: { outerReturns: 0, modelCalls: 4, rootJoins: 0, decisiveWallMs: null, pendingInnerAtEnd: false },
        },
      };
      return { held, evidence };
    };

    test('a failed Root turn never qualifies background placement, even with an unjoined settled Child', () => {
      // The repro: the host exits 1 with NO acknowledgement output while the
      // Child completes without joins — Child completion alone does not
      // establish the acknowledgement contract (acknowledgement-first
      // ordering: endedBeforeGate true).
      const { held, evidence } = backgroundMappingFixture({ code: 1, stdout: '', stderr: 'the background command failed' }, true);
      const facts = mapShellWaitLiveFacts(
        { case: 'background', codexBinary: '/bin/x', sourceSha: 'a'.repeat(40), output: '/o', workerDurationMs: 420_000, capMs: null, pollMs: 3_600_000, budgetMs: 720_000 },
        held, evidence, null, null,
        { workspace: '/w', codexHome: '/h', installedRoot: '/i', env: {}, record: { variant: 'candidate', capMs: null, pollMs: 3_600_000, appliedArtifacts: [] } },
        [], [], LAUNCHER_CONSTANT,
      );
      assert.notEqual(facts.inconclusive, null, 'a failed Root turn is never a settled background acknowledgement');
      assert.match(String(facts.inconclusive?.reason ?? ''), /host ended before the held completion boundary/u,
        'the ack-first ordering keeps its honest incomplete-lifecycle reason');
    });

    test('the same acknowledgement requirement holds when the worker gate wins the race', () => {
      // Gate-first ordering: endedBeforeGate false — the placement contract
      // must still demand the successful observed acknowledgement.
      const { held, evidence } = backgroundMappingFixture({ code: 1, stdout: '', stderr: 'the background command failed' }, false);
      const facts = mapShellWaitLiveFacts(
        { case: 'background', codexBinary: '/bin/x', sourceSha: 'a'.repeat(40), output: '/o', workerDurationMs: 420_000, capMs: null, pollMs: 3_600_000, budgetMs: 720_000 },
        held, evidence, null, null,
        { workspace: '/w', codexHome: '/h', installedRoot: '/i', env: {}, record: { variant: 'candidate', capMs: null, pollMs: 3_600_000, appliedArtifacts: [] } },
        [], [], LAUNCHER_CONSTANT,
      );
      assert.match(String(facts.inconclusive?.reason ?? ''), /acknowledgement/u,
        'the placement contract fails on the missing successful acknowledgement');
    });

    test('a successful observed acknowledgement keeps the settled background exemption', () => {
      const { held, evidence } = backgroundMappingFixture({ code: 0, stdout: ACK_STDOUT, stderr: '' }, true);
      const facts = mapShellWaitLiveFacts(
        { case: 'background', codexBinary: '/bin/x', sourceSha: 'a'.repeat(40), output: '/o', workerDurationMs: 420_000, capMs: null, pollMs: 3_600_000, budgetMs: 720_000 },
        held, evidence, null, null,
        { workspace: '/w', codexHome: '/h', installedRoot: '/i', env: {}, record: { variant: 'candidate', capMs: null, pollMs: 3_600_000, appliedArtifacts: [] } },
        [[{ type: 'session_meta', payload: { id: 'parent-1' } }, { payload: { type: 'agent_message', message: 'The Host Rescue child was launched.' } }]], [], LAUNCHER_CONSTANT,
      );
      assert.equal(facts.inconclusive, null, 'a successful acknowledgement with zero joins and observed settlement qualifies');
    });

    // --- P2-3: the acknowledgement timestamp is the result-resolution time ---

    test('the Root acknowledgement timestamp is captured when the result resolves, not after the hold', async () => {
      const held = await runHeldHostTurn({
        launch: async () => ({ result: new Promise((resolve) => setTimeout(() => resolve({ code: 0, stdout: ACK_STDOUT, stderr: '' }), 10)), terminate: async () => {} }),
        // The worker gate WINS: the Root acknowledges (result resolves at
        // ~10 ms) DURING the 150 ms hold.
        waitForGate: async () => {},
        captureProcessIdentity: async () => heldFixtures.identity,
        readProcessIdentity: async () => undefined,
        waitForProcessExit: async () => {},
        releaseGate: async () => {},
        holdMs: 150,
        budgetMs: 60_000,
      });
      assert.equal(held.endedBeforeGate, false);
      assert.notEqual(held.timeline.rootAcknowledgementAtElapsedMs, null);
      assert.ok(/** @type {number} */ (held.timeline.rootAcknowledgementAtElapsedMs) < 50,
        `the acknowledgement (result at ~10 ms) was recorded at ${String(held.timeline.rootAcknowledgementAtElapsedMs)} ms: the timestamp must be captured at result resolution, not after the hold`);
      assert.ok(/** @type {number} */ (held.timeline.rootAcknowledgementAtElapsedMs) >= /** @type {number} */ (held.timeline.launchedAtElapsedMs),
        'the acknowledgement is never recorded before the launch');
    });
  });

  describe('review round 19 refinements: launched-Child acknowledgements, linked-statement settlement, executed-poll attribution', async () => {
    const { extractInterruptInteraction } = await import('../tools/shell-wait-probe/evidence.mjs');
    const { mapShellWaitLiveFacts, waitForChildSettlementObservation } = await import('../tools/shell-wait-probe/driver.mjs');

    const CHILD_THREAD = 'a2b3c4d5-6699-4eb2-8f83-de4f60718293';
    const LAUNCHER = 'node "/installed/zcode/skills/rescue/launcher.mjs" invoke-prepared rescue';
    const SENTINEL = 'ZCODE_RESCUE_PUBLIC_SENTINEL_7C9C';
    const HANDLE = 5;
    const LAUNCHED_ACK = 'The Host Rescue child was launched.';

    const at10 = (second) => `2026-10-06T15:00:${String(second).padStart(2, '0')}Z`;
    const stamped = (timestamp, event) => ({ timestamp, ...event });
    const fnCall = (name, callId, args, timestamp = null) => ({
      ...(timestamp ? stamped(timestamp, {}) : {}),
      type: 'response_item', payload: { type: 'function_call', name, call_id: callId, arguments: JSON.stringify(args) },
    });
    const fnOutput = (callId, output, timestamp = null) => ({
      ...(timestamp ? stamped(timestamp, {}) : {}),
      type: 'response_item', payload: { type: 'function_call_output', call_id: callId, output },
    });
    const completedOutputBody = (result) => [
      { type: 'input_text', text: 'Script completed\n' },
      { type: 'input_text', text: JSON.stringify(result) },
    ];
    const pendingOutputBody = (cellId) => [{ type: 'input_text', text: `Script running with cell ID ${cellId}\n` }];
    const wrapperCell = (callId, input) => ({ type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: callId, input } });
    const wrapperOutput = (callId, output) => ({ type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: callId, output } });
    const binding = { childThreadId: CHILD_THREAD, command: LAUNCHER };

    const preparationEnvelope = {
      version: 5, source: 'explicit', task: 't',
      options: { hostPlacement: 'foreground', companionExecution: 'foreground', foregroundAdapter: 'shell', resume: 'fresh' },
      continuationTarget: null,
    };

    // --- P2-1: the Host-child LAUNCH acknowledgement, never a job reservation ---

    const backgroundMapping = (stdout, endedBeforeGate) => {
      const held = {
        endedBeforeGate, budgetExpired: false, identity: undefined, processAliveWhileHeld: null,
        result: { code: 0, stdout, stderr: '' },
        childSettlement: { observed: true, basis: 'exact-launch-handle-linked-completed-exit-code-output' },
        cleanup: { label: 'child-settlement-observed', releasedGate: true, verifiedProcessTerminated: true, codexTerminated: true, nativeInterruptionClaimed: false, errors: [] },
        timeline: { clock: 'held-turn-monotonic-elapsed-ms', launchedAtElapsedMs: 10, observationDetectedAtElapsedMs: 20, pollStartedAtElapsedMs: 30, holdDeadlineElapsedMs: 420_000, rootAcknowledgementAtElapsedMs: 40, childSettlementDetectedAtElapsedMs: 50, endedAtElapsedMs: 60 },
      };
      const evidence = {
        status: 'supported',
        facts: {
          completion: { qualified: true, processExit: 0, publicResultMatched: true, decisiveEnd: 'process-exit', structuralViolationCount: 0 },
          linkage: { checked: true, exact: true, agentType: 'zcode-rescue', childThreadId: CHILD_THREAD, parentThreadId: 'parent-1' },
          collection: { rolloutCount: 2, childToolCallCount: 4, truncated: false, excerpts: [] },
          companion: { launchCount: 1, sendCount: 1, sendCountKnown: true, duplicateLaunch: false, preLaunchDiagnostics: { excerpts: [], truncated: false } },
          handle: { originalHandleChecked: true },
          observations: { outerReturns: 0, modelCalls: 4, rootJoins: 0, decisiveWallMs: null, pendingInnerAtEnd: false },
        },
      };
      return { held, evidence };
    };

    test('a launched-Child acknowledgement qualifies the settled background run', () => {
      // The compliant background acknowledgement claims ONLY that the Host
      // child was launched (skills/rescue/SKILL.md background branch): with
      // zero joins and observed Child settlement it qualifies.
      const { held, evidence } = backgroundMapping(LAUNCHED_ACK, true);
      const facts = mapShellWaitLiveFacts(
        { case: 'background', codexBinary: '/bin/x', sourceSha: 'a'.repeat(40), output: '/o', workerDurationMs: 420_000, capMs: null, pollMs: 3_600_000, budgetMs: 720_000 },
        held, evidence, null, null,
        { workspace: '/w', codexHome: '/h', installedRoot: '/i', env: {}, record: { variant: 'candidate', capMs: null, pollMs: 3_600_000, appliedArtifacts: [] } },
        [[{ type: 'session_meta', payload: { id: 'parent-1' } }, { payload: { type: 'agent_message', message: 'The Host Rescue child was launched.' } }]], [], LAUNCHER,
      );
      assert.equal(facts.inconclusive, null, 'the launched-Child acknowledgement is the correct background contract');
    });

    test('a job-reservation output is the WRONG acknowledgement contract and never qualifies background', () => {
      // The reservation wording belongs to the R3 status flow (a different
      // case): a background Root acknowledging a job reservation is claiming
      // the forbidden Companion-background semantics. The gate-first ordering
      // routes the failure through the placement contract's acknowledgement
      // cause.
      const { held, evidence } = backgroundMapping('Reserved background job ab12cd34ab12cd34ab12cd34ab12cd34ab12cd34ab12cd34ab12cd34ab12cd34.', false);
      const facts = mapShellWaitLiveFacts(
        { case: 'background', codexBinary: '/bin/x', sourceSha: 'a'.repeat(40), output: '/o', workerDurationMs: 420_000, capMs: null, pollMs: 3_600_000, budgetMs: 720_000 },
        held, evidence, null, null,
        { workspace: '/w', codexHome: '/h', installedRoot: '/i', env: {}, record: { variant: 'candidate', capMs: null, pollMs: 3_600_000, appliedArtifacts: [] } },
        [], [], LAUNCHER,
      );
      assert.match(String(facts.inconclusive?.reason ?? ''), /acknowledgement/u,
        'the reservation wording is not the launched-Child acknowledgement the background prompt asks for');
    });

    // --- P2-2: settlement resolves from the LINKED statement's own output ---

    const sharedCellRollout = (cellResults) => [
      { type: 'session_meta', payload: { id: CHILD_THREAD } },
      wrapperCell('launch-1', `const r = await tools.exec_command(${JSON.stringify({ cmd: LAUNCHER })}); text(JSON.stringify(r))\n`),
      wrapperOutput('launch-1', completedOutputBody({ output: '', exit_code: 0, session_id: HANDLE })),
      // A supported cell: the original-handle poll FIRST, then an unrelated
      // awaited command. Both statements share the call id.
      wrapperCell('cell-1', [
        `const r = await tools.write_stdin(${JSON.stringify({ session_id: HANDLE, chars: '', yield_time_ms: 3_600_000 })}); text(JSON.stringify(r))\n`,
        `const r = await tools.exec_command(${JSON.stringify({ cmd: 'true' })}); text(JSON.stringify(r))\n`,
      ].join('\n')),
      wrapperOutput('cell-1', cellResults),
    ];

    test('an unrelated command exit code in a shared cell never settles the Child observation', async () => {
      // The cell output carries ONLY the unrelated command's result: the
      // still-running poll's own result is absent, so the shared call id's
      // whole-body decode must never be read as Child settlement.
      const controller = new AbortController();
      let loads = 0;
      await assert.rejects(
        waitForChildSettlementObservation('/codex-home', LAUNCHER, controller.signal, {
          loadRollouts: async () => {
            loads += 1;
            if (loads >= 4) controller.abort();
            return [sharedCellRollout([{ type: 'input_text', text: JSON.stringify({ output: 'done', exit_code: 0 }) }])];
          },
          sleep: async () => {},
        }),
        /aborted/u,
        'the unrelated command exit code is never Child settlement',
      );
    });

    test('the linked poll statement own completed result settles the watch', async () => {
      let loads = 0;
      const settlement = await waitForChildSettlementObservation('/codex-home', LAUNCHER, { aborted: false, addEventListener() {} }, {
        loadRollouts: async () => {
          loads += 1;
          return loads >= 2 ? [sharedCellRollout([
            { type: 'input_text', text: JSON.stringify({ output: SENTINEL, exit_code: 0, session_id: HANDLE }) },
            { type: 'input_text', text: JSON.stringify({ output: 'done', exit_code: 0 }) },
          ])] : [];
        },
        sleep: async () => {},
      });
      assert.equal(settlement.observed, true, "the LINKED poll statement's own exit code is the settlement evidence");
      assert.equal(settlement.basis, 'exact-launch-handle-linked-completed-exit-code-output');
    });

    // --- P2-3: a shared call id is attributable only once the poll executed ---

    test('a cell still yielding its preparation never attributes its pending header to the unexecuted poll', () => {
      // The shared cell [preparation, poll] yields while the PREPARATION is
      // still pending (no completed prefix): the poll never executed, so the
      // cell's pending header is not interruption evidence.
      const cellInput = [
        `text(await tools.write_stdin({session_id:${HANDLE},chars:JSON.stringify(${JSON.stringify(preparationEnvelope)})+"\\n"}));`,
        `const r = await tools.write_stdin(${JSON.stringify({ session_id: HANDLE, chars: '', yield_time_ms: 3_600_000 })}); text(JSON.stringify(r))\n`,
      ].join('\n');
      const root = [
        { type: 'session_meta', payload: { id: 'root-thread-1' } },
        stamped(at10(7), fnCall('interrupt_agent', 'int-1', { target: CHILD_THREAD })),
        stamped(at10('07.2'), fnOutput('int-1', JSON.stringify({ previous_status: 'running' }))),
      ];
      const child = [
        { type: 'session_meta', payload: { id: CHILD_THREAD } },
        stamped(at10(0), fnCall('exec_command', 'launch-1', { cmd: LAUNCHER })),
        stamped(at10(1), fnOutput('launch-1', completedOutputBody({ output: '', exit_code: 0, session_id: HANDLE }))),
        stamped(at10(5), wrapperCell('cell-1', cellInput)),
        stamped(at10('05.5'), wrapperOutput('cell-1', pendingOutputBody('cell-1'))),
      ];
      const interaction = extractInterruptInteraction([root, child], [], binding);
      assert.equal(interaction.orderingBound, false, 'an unexecuted poll never binds interruption ordering');
      assert.equal(interaction.pendingBeforeCall.observed, false, 'a pending preparation is never a pending-window observation');
    });

    test('the mapping records no pending interval for an unexecuted shared-cell poll', () => {
      const cellInput = [
        `text(await tools.write_stdin({session_id:${HANDLE},chars:JSON.stringify(${JSON.stringify(preparationEnvelope)})+"\\n"}));`,
        `const r = await tools.write_stdin(${JSON.stringify({ session_id: HANDLE, chars: '', yield_time_ms: 3_600_000 })}); text(JSON.stringify(r))\n`,
      ].join('\n');
      const root = [
        { type: 'session_meta', payload: { id: 'root-thread-1' } },
        stamped(at10(7), fnCall('interrupt_agent', 'int-1', { target: CHILD_THREAD })),
        stamped(at10('07.2'), fnOutput('int-1', JSON.stringify({ previous_status: 'running' }))),
      ];
      const child = [
        { type: 'session_meta', payload: { id: CHILD_THREAD } },
        stamped(at10(0), fnCall('exec_command', 'launch-1', { cmd: LAUNCHER })),
        stamped(at10(1), fnOutput('launch-1', completedOutputBody({ output: '', exit_code: 0, session_id: HANDLE }))),
        stamped(at10(5), wrapperCell('cell-1', cellInput)),
        stamped(at10('05.5'), wrapperOutput('cell-1', pendingOutputBody('cell-1'))),
      ];
      const held = {
        endedBeforeGate: true, budgetExpired: false, identity: undefined, processAliveWhileHeld: null,
        result: { code: 0, stdout: '', stderr: '' },
        cleanup: { label: 'observation', releasedGate: true, verifiedProcessTerminated: true, codexTerminated: true, nativeInterruptionClaimed: false, errors: [] },
        timeline: { clock: 'held-turn-monotonic-elapsed-ms', launchedAtElapsedMs: 10, observationDetectedAtElapsedMs: 20, pollStartedAtElapsedMs: 30, holdDeadlineElapsedMs: 420_000, rootAcknowledgementAtElapsedMs: null, childSettlementDetectedAtElapsedMs: null, endedAtElapsedMs: 50 },
      };
      const evidence = {
        status: 'supported',
        facts: {
          completion: { qualified: true, processExit: 0, publicResultMatched: true, decisiveEnd: 'process-exit', structuralViolationCount: 0 },
          linkage: { checked: true, exact: true, agentType: 'zcode-rescue', childThreadId: CHILD_THREAD, parentThreadId: 'parent-1' },
          collection: { rolloutCount: 2, childToolCallCount: 4, truncated: false, excerpts: [] },
          companion: { launchCount: 1, sendCount: 1, sendCountKnown: true, duplicateLaunch: false, preLaunchDiagnostics: { excerpts: [], truncated: false } },
          handle: { originalHandleChecked: true },
          observations: { outerReturns: 1, modelCalls: 4, rootJoins: 1, decisiveWallMs: null, pendingInnerAtEnd: true },
        },
      };
      const facts = mapShellWaitLiveFacts(
        { case: 'rescue-interrupt', codexBinary: '/bin/x', sourceSha: 'a'.repeat(40), output: '/o', workerDurationMs: 420_000, capMs: null, pollMs: 3_600_000, budgetMs: 720_000 },
        held, evidence, null, null,
        { workspace: '/w', codexHome: '/h', installedRoot: '/i', env: {}, record: { variant: 'candidate', capMs: null, pollMs: 3_600_000, appliedArtifacts: [] } },
        [root, child], [], LAUNCHER,
      );
      assert.equal(facts.interrupt.pendingIntervalMs, null, 'an unexecuted poll never dates a pending interval');
      assert.notEqual(facts.inconclusive, null, 'an interrupt during the preparation keeps the case inconclusive');
    });
  });

  describe('review round 20 refinements: decoded final-reply acknowledgements, terminal previous statuses', async () => {
    const { mapShellWaitLiveFacts } = await import('../tools/shell-wait-probe/driver.mjs');

    const CHILD_THREAD = 'b3c4d5e6-7700-4fc3-8a94-ef5061728394';
    const LAUNCHER = 'node "/installed/zcode/skills/rescue/launcher.mjs" invoke-prepared rescue';
    const HANDLE = 5;

    const at11 = (second) => `2026-10-06T16:00:${String(second).padStart(2, '0')}Z`;
    const stamped = (timestamp, event) => ({ timestamp, ...event });
    const fnCall = (name, callId, args, timestamp = null) => ({
      ...(timestamp ? stamped(timestamp, {}) : {}),
      type: 'response_item', payload: { type: 'function_call', name, call_id: callId, arguments: JSON.stringify(args) },
    });
    const fnOutput = (callId, output, timestamp = null) => ({
      ...(timestamp ? stamped(timestamp, {}) : {}),
      type: 'response_item', payload: { type: 'function_call_output', call_id: callId, output },
    });
    const completedOutputBody = (result) => [
      { type: 'input_text', text: 'Script completed\n' },
      { type: 'input_text', text: JSON.stringify(result) },
    ];
    const pendingOutputBody = (cellId) => [{ type: 'input_text', text: `Script running with cell ID ${cellId}\n` }];

    // --- P2-1: the acknowledgement contract is validated on the DECODED final reply ---

    const backgroundMapping = (rollouts) => {
      const held = {
        endedBeforeGate: false, budgetExpired: false, identity: undefined, processAliveWhileHeld: null,
        result: { code: 0, stdout: 'echo launched', stderr: '' },
        childSettlement: { observed: true, basis: 'exact-launch-handle-linked-completed-exit-code-output' },
        cleanup: { label: 'child-settlement-observed', releasedGate: true, verifiedProcessTerminated: true, codexTerminated: true, nativeInterruptionClaimed: false, errors: [] },
        timeline: { clock: 'held-turn-monotonic-elapsed-ms', launchedAtElapsedMs: 10, observationDetectedAtElapsedMs: 20, pollStartedAtElapsedMs: 30, holdDeadlineElapsedMs: 420_000, rootAcknowledgementAtElapsedMs: 40, childSettlementDetectedAtElapsedMs: 50, endedAtElapsedMs: 60 },
      };
      const evidence = {
        status: 'supported',
        facts: {
          completion: { qualified: true, processExit: 0, publicResultMatched: true, decisiveEnd: 'process-exit', structuralViolationCount: 0 },
          linkage: { checked: true, exact: true, agentType: 'zcode-rescue', childThreadId: CHILD_THREAD, parentThreadId: 'parent-1' },
          collection: { rolloutCount: rollouts.length, childToolCallCount: 4, truncated: false, excerpts: [] },
          companion: { launchCount: 1, sendCount: 1, sendCountKnown: true, duplicateLaunch: false, preLaunchDiagnostics: { excerpts: [], truncated: false } },
          handle: { originalHandleChecked: true },
          observations: { outerReturns: 0, modelCalls: 4, rootJoins: 0, decisiveWallMs: null, pendingInnerAtEnd: false },
        },
      };
      return { held, evidence };
    };
    const launchedReplyRollout = (message) => [[{ type: 'session_meta', payload: { id: 'parent-1' } }, { payload: { type: 'agent_message', message } }]];

    test('command telemetry containing launched never qualifies: the DECODED final reply is validated', () => {
      // `codex exec --json` interleaves command telemetry with the final
      // reply: a stdout substring search accepted `echo launched` even when
      // the final reply acknowledged a queued job.
      const replyRollout = launchedReplyRollout('The background job was reserved: Reserved background job ab12cd34ab12cd34ab12cd34ab12cd34ab12cd34ab12cd34ab12cd34ab12cd34.');
      const { held, evidence } = backgroundMapping(replyRollout);
      const facts = mapShellWaitLiveFacts(
        { case: 'background', codexBinary: '/bin/x', sourceSha: 'a'.repeat(40), output: '/o', workerDurationMs: 420_000, capMs: null, pollMs: 3_600_000, budgetMs: 720_000 },
        held, evidence, null, null,
        { workspace: '/w', codexHome: '/h', installedRoot: '/i', env: {}, record: { variant: 'candidate', capMs: null, pollMs: 3_600_000, appliedArtifacts: [] } },
        replyRollout, [], LAUNCHER,
      );
      assert.match(String(facts.inconclusive?.reason ?? ''), /acknowledgement/u,
        'telemetry occurrences are not the acknowledgement: the DECODED final reply must carry the launched claim');
    });

    test('a negated launch reply (NOT launched) never qualifies the background run', () => {
      const replyRollout = launchedReplyRollout('The Host child was NOT launched.');
      const { held, evidence } = backgroundMapping(replyRollout);
      const facts = mapShellWaitLiveFacts(
        { case: 'background', codexBinary: '/bin/x', sourceSha: 'a'.repeat(40), output: '/o', workerDurationMs: 420_000, capMs: null, pollMs: 3_600_000, budgetMs: 720_000 },
        held, evidence, null, null,
        { workspace: '/w', codexHome: '/h', installedRoot: '/i', env: {}, record: { variant: 'candidate', capMs: null, pollMs: 3_600_000, appliedArtifacts: [] } },
        replyRollout, [], LAUNCHER,
      );
      assert.match(String(facts.inconclusive?.reason ?? ''), /acknowledgement/u,
        'a negated launch claim is not a launch claim');
    });

    test('a decoded final reply claiming the launch qualifies the settled background run', () => {
      const replyRollout = launchedReplyRollout('The Host Rescue child was launched.');
      const { held, evidence } = backgroundMapping(replyRollout);
      const facts = mapShellWaitLiveFacts(
        { case: 'background', codexBinary: '/bin/x', sourceSha: 'a'.repeat(40), output: '/o', workerDurationMs: 420_000, capMs: null, pollMs: 3_600_000, budgetMs: 720_000 },
        held, evidence, null, null,
        { workspace: '/w', codexHome: '/h', installedRoot: '/i', env: {}, record: { variant: 'candidate', capMs: null, pollMs: 3_600_000, appliedArtifacts: [] } },
        replyRollout, [], LAUNCHER,
      );
      assert.equal(facts.inconclusive, null, 'the decoded launched-Child acknowledgement is the background contract');
    });

    // --- P2-2: terminal previous statuses never qualify an interruption ---

    const terminalInterruptMapping = (previousStatus) => {
      const root = [
        { type: 'session_meta', payload: { id: 'root-thread-1' } },
        stamped(at11(7), fnCall('interrupt_agent', 'int-1', { target: CHILD_THREAD })),
        stamped(at11('07.5'), fnOutput('int-1', JSON.stringify({ previous_status: previousStatus }))),
      ];
      const child = [
        { type: 'session_meta', payload: { id: CHILD_THREAD } },
        stamped(at11(0), fnCall('exec_command', 'launch-1', { cmd: LAUNCHER })),
        stamped(at11(1), fnOutput('launch-1', completedOutputBody({ output: '', exit_code: 0, session_id: HANDLE }))),
        stamped(at11(5), fnCall('write_stdin', 'poll-1', { session_id: HANDLE, chars: '', yield_time_ms: 3_600_000 })),
        stamped(at11(9), fnOutput('poll-1', pendingOutputBody('cell-1'))),
      ];
      const held = {
        endedBeforeGate: false, budgetExpired: false, identity: undefined, processAliveWhileHeld: null,
        result: { code: 0, stdout: '', stderr: '' },
        cleanup: { label: 'observation', releasedGate: true, verifiedProcessTerminated: true, codexTerminated: true, nativeInterruptionClaimed: false, errors: [] },
        timeline: { clock: 'held-turn-monotonic-elapsed-ms', launchedAtElapsedMs: 10, observationDetectedAtElapsedMs: 20, pollStartedAtElapsedMs: 30, holdDeadlineElapsedMs: 420_000, rootAcknowledgementAtElapsedMs: null, childSettlementDetectedAtElapsedMs: null, endedAtElapsedMs: 50 },
      };
      const evidence = {
        status: 'supported',
        facts: {
          completion: { qualified: true, processExit: 0, publicResultMatched: true, decisiveEnd: 'process-exit', structuralViolationCount: 0 },
          linkage: { checked: true, exact: true, agentType: 'zcode-rescue', childThreadId: CHILD_THREAD, parentThreadId: 'parent-1' },
          collection: { rolloutCount: 2, childToolCallCount: 3, truncated: false, excerpts: [] },
          companion: { launchCount: 1, sendCount: 1, sendCountKnown: true, duplicateLaunch: false, preLaunchDiagnostics: { excerpts: [], truncated: false } },
          handle: { originalHandleChecked: true },
          observations: { outerReturns: 1, modelCalls: 5, rootJoins: 1, decisiveWallMs: null, pendingInnerAtEnd: true },
        },
      };
      return { held, evidence, rollouts: [root, child] };
    };

    for (const terminalStatus of [{ completed: 'the child finished earlier' }, 'shutdown', 'not_found']) {
      test(`a terminal previous status (${typeof terminalStatus === 'string' ? terminalStatus : Object.keys(terminalStatus)[0]}) keeps the interrupt trial inconclusive and unsettled`, () => {
        const { held, evidence, rollouts } = terminalInterruptMapping(terminalStatus);
        const facts = mapShellWaitLiveFacts(
          { case: 'rescue-interrupt', codexBinary: '/bin/x', sourceSha: 'a'.repeat(40), output: '/o', workerDurationMs: 420_000, capMs: null, pollMs: 3_600_000, budgetMs: 720_000 },
          held, evidence, null, null,
          { workspace: '/w', codexHome: '/h', installedRoot: '/i', env: {}, record: { variant: 'candidate', capMs: null, pollMs: 3_600_000, appliedArtifacts: [] } },
          rollouts, [], LAUNCHER,
        );
        assert.match(String(facts.inconclusive?.reason ?? ''), /not an active turn/u,
          'the interrupt landed on a non-active (terminal) Child: the honest inconclusive reason is recorded');
        assert.equal(facts.interrupt.settled, null, 'a terminal previous status is never an interrupted-turn outcome');
        assert.match(String(facts.interrupt.settledBasis ?? ''), /previous-status-terminal/u);
        assert.equal(facts.interrupt.previousStatusTerminal, true);
      });
    }

    test('a running previous status keeps the pending-window interruption qualifying (control)', () => {
      const { held, evidence, rollouts } = terminalInterruptMapping('running');
      const facts = mapShellWaitLiveFacts(
        { case: 'rescue-interrupt', codexBinary: '/bin/x', sourceSha: 'a'.repeat(40), output: '/o', workerDurationMs: 420_000, capMs: null, pollMs: 3_600_000, budgetMs: 720_000 },
        held, evidence, null, null,
        { workspace: '/w', codexHome: '/h', installedRoot: '/i', env: {}, record: { variant: 'candidate', capMs: null, pollMs: 3_600_000, appliedArtifacts: [] } },
        rollouts, [], LAUNCHER,
      );
      assert.equal(facts.inconclusive, null, 'a delivery to a RUNNING child with an observed pending window is the case contract');
    });
  });

  describe('review round 21 refinements: parent-rollout acknowledgement selection, errored terminal status', async () => {
    const { mapShellWaitLiveFacts } = await import('../tools/shell-wait-probe/driver.mjs');

    const stampedP21 = (timestamp, event) => ({ timestamp, ...event });
    const fnCallP21 = (name, callId, args, timestamp = null) => ({
      ...(timestamp ? stampedP21(timestamp, {}) : {}),
      type: 'response_item', payload: { type: 'function_call', name, call_id: callId, arguments: JSON.stringify(args) },
    });
    const fnOutputP21 = (callId, output, timestamp = null) => ({
      ...(timestamp ? stampedP21(timestamp, {}) : {}),
      type: 'response_item', payload: { type: 'function_call_output', call_id: callId, output },
    });

    const CHILD_THREAD = 'c4d5e6f7-8811-40d4-9ba5-f061728394a5';
    const PARENT_THREAD = 'parent-1';
    const LAUNCHER = 'node "/installed/zcode/skills/rescue/launcher.mjs" invoke-prepared rescue';
    const SENTINEL = 'ZCODE_RESCUE_PUBLIC_SENTINEL_7C9C';

    // The parent rollout (its session meta carries the linkage's parent
    // thread id) ends with the launched-Child acknowledgement; the Child
    // rollout ends with its own sentinel reply.
    const parentRollout = [
      { type: 'session_meta', payload: { id: PARENT_THREAD } },
      { payload: { type: 'agent_message', message: 'The Host Rescue child was launched.' } },
    ];
    const childRollout = [
      { type: 'session_meta', payload: { id: CHILD_THREAD } },
      { payload: { type: 'agent_message', message: SENTINEL } },
    ];

    const backgroundMapping = (rollouts) => {
      const held = {
        endedBeforeGate: false, budgetExpired: false, identity: undefined, processAliveWhileHeld: null,
        result: { code: 0, stdout: 'The Host Rescue child was launched.', stderr: '' },
        childSettlement: { observed: true, basis: 'exact-launch-handle-linked-completed-exit-code-output' },
        cleanup: { label: 'child-settlement-observed', releasedGate: true, verifiedProcessTerminated: true, codexTerminated: true, nativeInterruptionClaimed: false, errors: [] },
        timeline: { clock: 'held-turn-monotonic-elapsed-ms', launchedAtElapsedMs: 10, observationDetectedAtElapsedMs: 20, pollStartedAtElapsedMs: 30, holdDeadlineElapsedMs: 420_000, rootAcknowledgementAtElapsedMs: 40, childSettlementDetectedAtElapsedMs: 50, endedAtElapsedMs: 60 },
      };
      const evidence = {
        status: 'supported',
        facts: {
          completion: { qualified: true, processExit: 0, publicResultMatched: true, decisiveEnd: 'process-exit', structuralViolationCount: 0 },
          linkage: { checked: true, exact: true, agentType: 'zcode-rescue', childThreadId: CHILD_THREAD, parentThreadId: PARENT_THREAD },
          collection: { rolloutCount: rollouts.length, childToolCallCount: 4, truncated: false, excerpts: [] },
          companion: { launchCount: 1, sendCount: 1, sendCountKnown: true, duplicateLaunch: false, preLaunchDiagnostics: { excerpts: [], truncated: false } },
          handle: { originalHandleChecked: true },
          observations: { outerReturns: 0, modelCalls: 4, rootJoins: 0, decisiveWallMs: null, pendingInnerAtEnd: false },
        },
      };
      return mapShellWaitLiveFacts(
        { case: 'background', codexBinary: '/bin/x', sourceSha: 'a'.repeat(40), output: '/o', workerDurationMs: 420_000, capMs: null, pollMs: 3_600_000, budgetMs: 720_000 },
        held, evidence, null, null,
        { workspace: '/w', codexHome: '/h', installedRoot: '/i', env: {}, record: { variant: 'candidate', capMs: null, pollMs: 3_600_000, appliedArtifacts: [] } },
        rollouts, [], LAUNCHER,
      );
    };

    // --- P2-1: the acknowledgement comes from the PARENT rollout, order-independently ---

    test('the acknowledgement is read from the parent rollout regardless of collection order (parent first)', () => {
      const facts = backgroundMapping([parentRollout, childRollout]);
      assert.equal(facts.inconclusive, null, 'the parent rollout precedes the Child: Root\'s launched acknowledgement qualifies');
    });

    test('the acknowledgement is read from the parent rollout regardless of collection order (child first)', () => {
      // Pre-fix, this ordering yielded the CHILD's sentinel as the final
      // message and rejected a valid background run (order-dependent
      // verdicts).
      const facts = backgroundMapping([childRollout, parentRollout]);
      assert.equal(facts.inconclusive, null, 'reversing the rollout arrays must not change the verdict');
    });

    test('a parent rollout that does not claim the launch stays unacknowledged in both orders', () => {
      const negatedParent = [
        { type: 'session_meta', payload: { id: PARENT_THREAD } },
        { payload: { type: 'agent_message', message: 'The Host child was NOT launched.' } },
      ];
      const first = backgroundMapping([negatedParent, childRollout]);
      const second = backgroundMapping([childRollout, negatedParent]);
      assert.match(String(first.inconclusive?.reason ?? ''), /acknowledgement/u);
      assert.match(String(second.inconclusive?.reason ?? ''), /acknowledgement/u,
        'the order flip cannot smuggle an acknowledgement from another rollout');
    });

    // --- P2-2: errored previous statuses are terminal ---

    const erroredInterruptMapping = () => {
      const root = [
        { type: 'session_meta', payload: { id: 'root-thread-1' } },
        stampedP21(7, fnCallP21('interrupt_agent', 'int-1', { target: CHILD_THREAD })),
        stampedP21('07.5', fnOutputP21('int-1', JSON.stringify({ previous_status: { errored: 'the child failed earlier' } }))),
      ];
      const child = [
        { type: 'session_meta', payload: { id: CHILD_THREAD } },
        stampedP21(0, fnCallP21('exec_command', 'launch-1', { cmd: LAUNCHER })),
        stampedP21(1, fnOutputP21('launch-1', [
          { type: 'input_text', text: 'Script completed\n' },
          { type: 'input_text', text: JSON.stringify({ output: '', exit_code: 0, session_id: 5 }) },
        ])),
        stampedP21(5, fnCallP21('write_stdin', 'poll-1', { session_id: 5, chars: '', yield_time_ms: 3_600_000 })),
        stampedP21(9, fnOutputP21('poll-1', [{ type: 'input_text', text: 'Script running with cell ID cell-1\n' }])),
      ];
      const held = {
        endedBeforeGate: false, budgetExpired: false, identity: undefined, processAliveWhileHeld: null,
        result: { code: 0, stdout: '', stderr: '' },
        cleanup: { label: 'observation', releasedGate: true, verifiedProcessTerminated: true, codexTerminated: true, nativeInterruptionClaimed: false, errors: [] },
        timeline: { clock: 'held-turn-monotonic-elapsed-ms', launchedAtElapsedMs: 10, observationDetectedAtElapsedMs: 20, pollStartedAtElapsedMs: 30, holdDeadlineElapsedMs: 420_000, rootAcknowledgementAtElapsedMs: null, childSettlementDetectedAtElapsedMs: null, endedAtElapsedMs: 50 },
      };
      const evidence = {
        status: 'supported',
        facts: {
          completion: { qualified: true, processExit: 0, publicResultMatched: true, decisiveEnd: 'process-exit', structuralViolationCount: 0 },
          linkage: { checked: true, exact: true, agentType: 'zcode-rescue', childThreadId: CHILD_THREAD, parentThreadId: 'root-thread-1' },
          collection: { rolloutCount: 2, childToolCallCount: 3, truncated: false, excerpts: [] },
          companion: { launchCount: 1, sendCount: 1, sendCountKnown: true, duplicateLaunch: false, preLaunchDiagnostics: { excerpts: [], truncated: false } },
          handle: { originalHandleChecked: true },
          observations: { outerReturns: 1, modelCalls: 5, rootJoins: 1, decisiveWallMs: null, pendingInnerAtEnd: true },
        },
      };
      return mapShellWaitLiveFacts(
        { case: 'rescue-interrupt', codexBinary: '/bin/x', sourceSha: 'a'.repeat(40), output: '/o', workerDurationMs: 420_000, capMs: null, pollMs: 3_600_000, budgetMs: 720_000 },
        held, evidence, null, null,
        { workspace: '/w', codexHome: '/h', installedRoot: '/i', env: {}, record: { variant: 'candidate', capMs: null, pollMs: 3_600_000, appliedArtifacts: [] } },
        [root, child], [], LAUNCHER,
      );
    };

    test('an errored previous status is terminal: the interrupt never claims a surviving-turn outcome', () => {
      // The pinned agent/status.rs::is_final() includes Errored: the already-
      // FAILED Child is exactly as non-interruptible as a completed one — a
      // delivered interrupt with a surviving pending observation must not
      // qualify an active-turn interruption.
      const facts = erroredInterruptMapping();
      assert.match(String(facts.inconclusive?.reason ?? ''), /not an active turn/u,
        'the interrupt landed on a non-active (errored) Child: the honest reason is recorded');
      assert.equal(facts.interrupt.settled, null, 'an errored Child is never an interrupted-turn outcome');
      assert.match(String(facts.interrupt.settledBasis ?? ''), /previous-status-terminal/u);
      assert.equal(facts.interrupt.previousStatusTerminal, true);
      assert.equal(facts.interrupt.previousStatus, 'errored');
    });
  });

  describe('review round 22 refinements: already-interrupted turns, launch-only acknowledgements', async () => {
    const { mapShellWaitLiveFacts } = await import('../tools/shell-wait-probe/driver.mjs');

    const CHILD_THREAD = 'd5e6f7a8-9922-41e5-8cb6-0161728394a6';
    const LAUNCHER = 'node "/installed/zcode/skills/rescue/launcher.mjs" invoke-prepared rescue';

    const at12 = (second) => `2026-10-06T17:00:${String(second).padStart(2, '0')}Z`;
    const stamped = (timestamp, event) => ({ timestamp, ...event });
    const fnCall = (name, callId, args, timestamp = null) => ({
      ...(timestamp ? stamped(timestamp, {}) : {}),
      type: 'response_item', payload: { type: 'function_call', name, call_id: callId, arguments: JSON.stringify(args) },
    });
    const fnOutput = (callId, output, timestamp = null) => ({
      ...(timestamp ? stamped(timestamp, {}) : {}),
      type: 'response_item', payload: { type: 'function_call_output', call_id: callId, output },
    });

    // --- P2-1: an already-interrupted previous status is not an active turn ---

    const interruptedVariantMapping = () => {
      const root = [
        { type: 'session_meta', payload: { id: 'root-thread-1' } },
        stamped(at12(7), fnCall('interrupt_agent', 'int-1', { target: CHILD_THREAD })),
        stamped(at12('07.5'), fnOutput('int-1', JSON.stringify({ previous_status: 'interrupted' }))),
      ];
      const child = [
        { type: 'session_meta', payload: { id: CHILD_THREAD } },
        stamped(at12(0), fnCall('exec_command', 'launch-1', { cmd: LAUNCHER })),
        stamped(at12(1), fnOutput('launch-1', [
          { type: 'input_text', text: 'Script completed\n' },
          { type: 'input_text', text: JSON.stringify({ output: '', exit_code: 0, session_id: 5 }) },
        ])),
        stamped(at12(5), fnCall('write_stdin', 'poll-1', { session_id: 5, chars: '', yield_time_ms: 3_600_000 })),
        stamped(at12(9), fnOutput('poll-1', [{ type: 'input_text', text: 'Script running with cell ID cell-1\n' }])),
      ];
      const held = {
        endedBeforeGate: false, budgetExpired: false, identity: undefined, processAliveWhileHeld: null,
        result: { code: 0, stdout: '', stderr: '' },
        cleanup: { label: 'observation', releasedGate: true, verifiedProcessTerminated: true, codexTerminated: true, nativeInterruptionClaimed: false, errors: [] },
        timeline: { clock: 'held-turn-monotonic-elapsed-ms', launchedAtElapsedMs: 10, observationDetectedAtElapsedMs: 20, pollStartedAtElapsedMs: 30, holdDeadlineElapsedMs: 420_000, rootAcknowledgementAtElapsedMs: null, childSettlementDetectedAtElapsedMs: null, endedAtElapsedMs: 50 },
      };
      const evidence = {
        status: 'supported',
        facts: {
          completion: { qualified: true, processExit: 0, publicResultMatched: true, decisiveEnd: 'process-exit', structuralViolationCount: 0 },
          linkage: { checked: true, exact: true, agentType: 'zcode-rescue', childThreadId: CHILD_THREAD, parentThreadId: 'root-thread-1' },
          collection: { rolloutCount: 2, childToolCallCount: 3, truncated: false, excerpts: [] },
          companion: { launchCount: 1, sendCount: 1, sendCountKnown: true, duplicateLaunch: false, preLaunchDiagnostics: { excerpts: [], truncated: false } },
          handle: { originalHandleChecked: true },
          observations: { outerReturns: 1, modelCalls: 5, rootJoins: 1, decisiveWallMs: null, pendingInnerAtEnd: true },
        },
      };
      return mapShellWaitLiveFacts(
        { case: 'rescue-interrupt', codexBinary: '/bin/x', sourceSha: 'a'.repeat(40), output: '/o', workerDurationMs: 420_000, capMs: null, pollMs: 3_600_000, budgetMs: 720_000 },
        held, evidence, null, null,
        { workspace: '/w', codexHome: '/h', installedRoot: '/i', env: {}, record: { variant: 'candidate', capMs: null, pollMs: 3_600_000, appliedArtifacts: [] } },
        [root, child], [], LAUNCHER,
      );
    };

    test('an already-interrupted previous status never qualifies an active-turn interruption', () => {
      // The pinned enum's Interrupted variant is an ALREADY-INTERRUPTED turn:
      // another interrupt_agent call can succeed for it without interrupting
      // an active turn, and its resumability does not establish active
      // execution.
      const facts = interruptedVariantMapping();
      assert.match(String(facts.inconclusive?.reason ?? ''), /not an active turn/u,
        'the honest reason records the non-active previous status');
      assert.equal(facts.interrupt.settled, null, 'an already-interrupted Child is never an interrupted-turn outcome');
      assert.equal(facts.interrupt.previousStatusTerminal, true, 'the non-active previous status is recorded');
      assert.equal(facts.interrupt.previousStatus, 'interrupted');
    });

    // --- P2-2: the acknowledgement must be POSITIVE and LAUNCH-ONLY ---

    const backgroundMapping = (finalReply) => {
      const held = {
        endedBeforeGate: false, budgetExpired: false, identity: undefined, processAliveWhileHeld: null,
        result: { code: 0, stdout: finalReply, stderr: '' },
        childSettlement: { observed: true, basis: 'exact-launch-handle-linked-completed-exit-code-output' },
        cleanup: { label: 'child-settlement-observed', releasedGate: true, verifiedProcessTerminated: true, codexTerminated: true, nativeInterruptionClaimed: false, errors: [] },
        timeline: { clock: 'held-turn-monotonic-elapsed-ms', launchedAtElapsedMs: 10, observationDetectedAtElapsedMs: 20, pollStartedAtElapsedMs: 30, holdDeadlineElapsedMs: 420_000, rootAcknowledgementAtElapsedMs: 40, childSettlementDetectedAtElapsedMs: 50, endedAtElapsedMs: 60 },
      };
      const evidence = {
        status: 'supported',
        facts: {
          completion: { qualified: true, processExit: 0, publicResultMatched: true, decisiveEnd: 'process-exit', structuralViolationCount: 0 },
          linkage: { checked: true, exact: true, agentType: 'zcode-rescue', childThreadId: CHILD_THREAD, parentThreadId: 'parent-1' },
          collection: { rolloutCount: 1, childToolCallCount: 4, truncated: false, excerpts: [] },
          companion: { launchCount: 1, sendCount: 1, sendCountKnown: true, duplicateLaunch: false, preLaunchDiagnostics: { excerpts: [], truncated: false } },
          handle: { originalHandleChecked: true },
          observations: { outerReturns: 0, modelCalls: 4, rootJoins: 0, decisiveWallMs: null, pendingInnerAtEnd: false },
        },
      };
      const rollouts = [
        [{ type: 'session_meta', payload: { id: 'parent-1' } }, { payload: { type: 'agent_message', message: finalReply } }],
      ];
      return mapShellWaitLiveFacts(
        { case: 'background', codexBinary: '/bin/x', sourceSha: 'a'.repeat(40), output: '/o', workerDurationMs: 420_000, capMs: null, pollMs: 3_600_000, budgetMs: 720_000 },
        held, evidence, null, null,
        { workspace: '/w', codexHome: '/h', installedRoot: '/i', env: {}, record: { variant: 'candidate', capMs: null, pollMs: 3_600_000, appliedArtifacts: [] } },
        rollouts, [], LAUNCHER,
      );
    };

    test('a never-launched reply is a negation, not an acknowledgement', () => {
      const facts = backgroundMapping('The Host child was never launched.');
      assert.match(String(facts.inconclusive?.reason ?? ''), /acknowledgement/u,
        'a negated launch claim is not an acknowledgement');
    });

    test('a reply carrying forbidden work-status claims is not a launch-only acknowledgement', () => {
      const facts = backgroundMapping('The Host child was launched and Companion work was accepted and started.');
      assert.match(String(facts.inconclusive?.reason ?? ''), /acknowledgement/u,
        'work-status claims (queued/accepted/started/completed) violate the launch-only contract');
    });

    test('a positive launch-only acknowledgement qualifies the settled background run (control)', () => {
      const facts = backgroundMapping('The Host Rescue child was launched.');
      assert.equal(facts.inconclusive, null, 'the compliant positive launch-only acknowledgement is the contract');
    });
  });

  describe('review round 23 refinements: supported affirmative launch statements only', async () => {
    const { mapShellWaitLiveFacts } = await import('../tools/shell-wait-probe/driver.mjs');

    const CHILD_THREAD = 'e6f7a8b9-0033-42f6-9dc7-12728394a5b6';
    const LAUNCHER = 'node "/installed/zcode/skills/rescue/launcher.mjs" invoke-prepared rescue';

    const backgroundMapping = (finalReply) => {
      const held = {
        endedBeforeGate: false, budgetExpired: false, identity: undefined, processAliveWhileHeld: null,
        result: { code: 0, stdout: finalReply, stderr: '' },
        childSettlement: { observed: true, basis: 'exact-launch-handle-linked-completed-exit-code-output' },
        cleanup: { label: 'child-settlement-observed', releasedGate: true, verifiedProcessTerminated: true, codexTerminated: true, nativeInterruptionClaimed: false, errors: [] },
        timeline: { clock: 'held-turn-monotonic-elapsed-ms', launchedAtElapsedMs: 10, observationDetectedAtElapsedMs: 20, pollStartedAtElapsedMs: 30, holdDeadlineElapsedMs: 420_000, rootAcknowledgementAtElapsedMs: 40, childSettlementDetectedAtElapsedMs: 50, endedAtElapsedMs: 60 },
      };
      const evidence = {
        status: 'supported',
        facts: {
          completion: { qualified: true, processExit: 0, publicResultMatched: true, decisiveEnd: 'process-exit', structuralViolationCount: 0 },
          linkage: { checked: true, exact: true, agentType: 'zcode-rescue', childThreadId: CHILD_THREAD, parentThreadId: 'parent-1' },
          collection: { rolloutCount: 1, childToolCallCount: 4, truncated: false, excerpts: [] },
          companion: { launchCount: 1, sendCount: 1, sendCountKnown: true, duplicateLaunch: false, preLaunchDiagnostics: { excerpts: [], truncated: false } },
          handle: { originalHandleChecked: true },
          observations: { outerReturns: 0, modelCalls: 4, rootJoins: 0, decisiveWallMs: null, pendingInnerAtEnd: false },
        },
      };
      const rollouts = [
        [{ type: 'session_meta', payload: { id: 'parent-1' } }, { payload: { type: 'agent_message', message: finalReply } }],
      ];
      return mapShellWaitLiveFacts(
        { case: 'background', codexBinary: '/bin/x', sourceSha: 'a'.repeat(40), output: '/o', workerDurationMs: 420_000, capMs: null, pollMs: 3_600_000, budgetMs: 720_000 },
        held, evidence, null, null,
        { workspace: '/w', codexHome: '/h', installedRoot: '/i', env: {}, record: { variant: 'candidate', capMs: null, pollMs: 3_600_000, appliedArtifacts: [] } },
        rollouts, [], LAUNCHER,
      );
    };

    test("a contraction negation (wasn't launched) is never an acknowledgement", () => {
      const facts = backgroundMapping("The Host Rescue child wasn't launched.");
      assert.match(String(facts.inconclusive?.reason ?? ''), /acknowledgement/u,
        'contraction negations fail closed');
    });

    test('a hypothetical launch statement (should be launched) is never an acknowledgement', () => {
      const facts = backgroundMapping('Only one child should be launched.');
      assert.match(String(facts.inconclusive?.reason ?? ''), /acknowledgement/u,
        'hypothetical wording fails closed');
    });

    test('the supported affirmative launch statement qualifies (control)', () => {
      const facts = backgroundMapping('The Host Rescue child was launched.');
      assert.equal(facts.inconclusive, null, 'the SKILL.md affirmative production phrasing is the contract');
    });
  });

  describe('review round 24 refinements: linked-statement interrupt ordering', async () => {
    const { extractInterruptInteraction } = await import('../tools/shell-wait-probe/evidence.mjs');

    const CHILD_THREAD = 'f7a8b9c0-1144-4307-8ed8-2394a5b6c7d8';
    const LAUNCHER = 'node "/installed/zcode/skills/rescue/launcher.mjs" invoke-prepared rescue';
    const HANDLE = 5;

    const at13 = (second) => `2026-10-06T18:00:${String(second).padStart(2, '0')}Z`;
    const stamped = (timestamp, event) => ({ timestamp, ...event });
    const fnCall = (name, callId, args, timestamp = null) => ({
      ...(timestamp ? stamped(timestamp, {}) : {}),
      type: 'response_item', payload: { type: 'function_call', name, call_id: callId, arguments: JSON.stringify(args) },
    });
    const fnOutput = (callId, output, timestamp = null) => ({
      ...(timestamp ? stamped(timestamp, {}) : {}),
      type: 'response_item', payload: { type: 'function_call_output', call_id: callId, output },
    });
    const completedOutputBody = (result) => [
      { type: 'input_text', text: 'Script completed\n' },
      { type: 'input_text', text: JSON.stringify(result) },
    ];

    // A supported cell: the original-handle poll FIRST, then an unrelated
    // awaited command. Both statements share the call id; the cell response
    // carries ONLY the unrelated command's completed result (the poll is
    // still running — its own result is absent).
    const sharedCellRollout = (responseSecond) => {
      const root = [
        { type: 'session_meta', payload: { id: 'root-thread-1' } },
        stamped(at13(7), fnCall('interrupt_agent', 'int-1', { target: CHILD_THREAD })),
        stamped(at13('07.2'), fnOutput('int-1', JSON.stringify({ previous_status: 'running' }))),
      ];
      const child = [
        { type: 'session_meta', payload: { id: CHILD_THREAD } },
        stamped(at13(0), fnCall('exec_command', 'launch-1', { cmd: LAUNCHER })),
        stamped(at13(1), fnOutput('launch-1', completedOutputBody({ output: '', exit_code: 0, session_id: HANDLE }))),
        stamped(at13(5), wrapperCellP24('cell-1', [
          `const r = await tools.write_stdin(${JSON.stringify({ session_id: HANDLE, chars: '', yield_time_ms: 3_600_000 })}); text(JSON.stringify(r))\n`,
          `const r = await tools.exec_command(${JSON.stringify({ cmd: 'true' })}); text(JSON.stringify(r))\n`,
        ].join('\n'))),
        stamped(at13(responseSecond), fnOutputP24('cell-1', [
          { type: 'input_text', text: JSON.stringify({ output: 'done', exit_code: 0 }) },
        ])),
      ];
      return [root, child];
    };
    function wrapperCellP24(callId, input) {
      return { type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: callId, input } };
    }
    function fnOutputP24(callId, output) {
      return { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: callId, output } };
    }

    test('an unrelated command exit AFTER the interrupt is never the Child completedAfterCall', () => {
      const interaction = extractInterruptInteraction(sharedCellRollout(9), [], { childThreadId: CHILD_THREAD, command: LAUNCHER });
      assert.equal(interaction.attempted, true);
      assert.equal(interaction.orderingBound, true);
      assert.equal(interaction.completedAfterCall.atMs, null,
        'the unrelated command exit (09) is not the Child completion: no post-delivery latency may be recorded');
      assert.equal(interaction.completedBeforeCall.atMs, null);
    });

    test('an unrelated command exit BEFORE the interrupt is never the Child completedBeforeCall', () => {
      const interaction = extractInterruptInteraction(sharedCellRollout(6), [], { childThreadId: CHILD_THREAD, command: LAUNCHER });
      assert.equal(interaction.attempted, true);
      assert.equal(interaction.orderingBound, true);
      assert.equal(interaction.completedBeforeCall.atMs, null,
        'the unrelated command exit (06) is not the Child completion: no pre-delivery completion may be recorded');
      assert.equal(interaction.completedAfterCall.atMs, null);
      assert.equal(interaction.sameRolloutCompletedBeforeCall, false,
        'no completed Child event exists in the interrupt rollout before the call');
    });
  });

  describe('review round 25 refinements: complete acknowledgement sentences, confirmed-window survival, fd3 destruction', async () => {
    const { mapShellWaitLiveFacts } = await import('../tools/shell-wait-probe/driver.mjs');
    const { defaultCompanionChildSpawn } = await import('../tools/shell-wait-probe/fixture.mjs');

    const CHILD_THREAD = 'a8b9c0d1-2244-43e7-9ec8-238394a5b6c7';
    const LAUNCHER = 'node "/installed/zcode/skills/rescue/launcher.mjs" invoke-prepared rescue';

    const at14 = (second) => `2026-10-06T19:00:${String(second).padStart(2, '0')}Z`;
    const stamped = (timestamp, event) => ({ timestamp, ...event });
    const fnCall = (name, callId, args, timestamp = null) => ({
      ...(timestamp ? stamped(timestamp, {}) : {}),
      type: 'response_item', payload: { type: 'function_call', name, call_id: callId, arguments: JSON.stringify(args) },
    });
    const fnOutput = (callId, output, timestamp = null) => ({
      ...(timestamp ? stamped(timestamp, {}) : {}),
      type: 'response_item', payload: { type: 'function_call_output', call_id: callId, output },
    });

    // --- P2-1: the affirmative claim must be a COMPLETE supported sentence ---

    const backgroundMapping = (finalReply) => {
      const held = {
        endedBeforeGate: false, budgetExpired: false, identity: undefined, processAliveWhileHeld: null,
        result: { code: 0, stdout: finalReply, stderr: '' },
        childSettlement: { observed: true, basis: 'exact-launch-handle-linked-completed-exit-code-output' },
        cleanup: { label: 'child-settlement-observed', releasedGate: true, verifiedProcessTerminated: true, codexTerminated: true, nativeInterruptionClaimed: false, errors: [] },
        timeline: { clock: 'held-turn-monotonic-elapsed-ms', launchedAtElapsedMs: 10, observationDetectedAtElapsedMs: 20, pollStartedAtElapsedMs: 30, holdDeadlineElapsedMs: 420_000, rootAcknowledgementAtElapsedMs: 40, childSettlementDetectedAtElapsedMs: 50, endedAtElapsedMs: 60 },
      };
      const evidence = {
        status: 'supported',
        facts: {
          completion: { qualified: true, processExit: 0, publicResultMatched: true, decisiveEnd: 'process-exit', structuralViolationCount: 0 },
          linkage: { checked: true, exact: true, agentType: 'zcode-rescue', childThreadId: CHILD_THREAD, parentThreadId: 'parent-1' },
          collection: { rolloutCount: 1, childToolCallCount: 4, truncated: false, excerpts: [] },
          companion: { launchCount: 1, sendCount: 1, sendCountKnown: true, duplicateLaunch: false, preLaunchDiagnostics: { excerpts: [], truncated: false } },
          handle: { originalHandleChecked: true },
          observations: { outerReturns: 0, modelCalls: 4, rootJoins: 0, decisiveWallMs: null, pendingInnerAtEnd: false },
        },
      };
      const rollouts = [
        [{ type: 'session_meta', payload: { id: 'parent-1' } }, { payload: { type: 'agent_message', message: finalReply } }],
      ];
      return mapShellWaitLiveFacts(
        { case: 'background', codexBinary: '/bin/x', sourceSha: 'a'.repeat(40), output: '/o', workerDurationMs: 420_000, capMs: null, pollMs: 3_600_000, budgetMs: 720_000 },
        held, evidence, null, null,
        { workspace: '/w', codexHome: '/h', installedRoot: '/i', env: {}, record: { variant: 'candidate', capMs: null, pollMs: 3_600_000, appliedArtifacts: [] } },
        rollouts, [], LAUNCHER,
      );
    };

    test('an uncertain reply embedding the launch phrase is never an acknowledgement', () => {
      const facts = backgroundMapping('I cannot confirm that the Host Rescue child was launched.');
      assert.match(String(facts.inconclusive?.reason ?? ''), /acknowledgement/u,
        'a launch phrase embedded in uncertain prose is not an acknowledgement');
    });

    test('the complete supported affirmative sentence qualifies (control)', () => {
      const facts = backgroundMapping('The Host Rescue child was launched.');
      assert.equal(facts.inconclusive, null, 'the statement-start anchored affirmative sentence is the contract');
    });

    // --- P2-2: survival requires a CONFIRMED pending window ---

    test('an interrupt that precedes the first poll never claims a surviving-turn outcome', () => {
      const root = [
        { type: 'session_meta', payload: { id: 'root-thread-1' } },
        stamped(at14(3), fnCall('interrupt_agent', 'int-1', { target: CHILD_THREAD })),
        stamped(at14('03.2'), fnOutput('int-1', JSON.stringify({ previous_status: 'running' }))),
      ];
      const child = [
        { type: 'session_meta', payload: { id: CHILD_THREAD } },
        stamped(at14(0), fnCall('exec_command', 'launch-1', { cmd: LAUNCHER })),
        stamped(at14(1), fnOutput('launch-1', [
          { type: 'input_text', text: 'Script completed\n' },
          { type: 'input_text', text: JSON.stringify({ output: '', exit_code: 0, session_id: 5 }) },
        ])),
        stamped(at14(5), fnCall('write_stdin', 'poll-1', { session_id: 5, chars: '', yield_time_ms: 3_600_000 })),
        stamped(at14(9), fnOutput('poll-1', [{ type: 'input_text', text: 'Script running with cell ID cell-1\n' }])),
      ];
      const held = {
        endedBeforeGate: false, budgetExpired: false, identity: undefined, processAliveWhileHeld: null,
        result: { code: 0, stdout: '', stderr: '' },
        cleanup: { label: 'observation', releasedGate: true, verifiedProcessTerminated: true, codexTerminated: true, nativeInterruptionClaimed: false, errors: [] },
        timeline: { clock: 'held-turn-monotonic-elapsed-ms', launchedAtElapsedMs: 10, observationDetectedAtElapsedMs: 20, pollStartedAtElapsedMs: 30, holdDeadlineElapsedMs: 420_000, rootAcknowledgementAtElapsedMs: null, childSettlementDetectedAtElapsedMs: null, endedAtElapsedMs: 50 },
      };
      const evidence = {
        status: 'supported',
        facts: {
          completion: { qualified: false, processExit: null, publicResultMatched: null, decisiveEnd: null, structuralViolationCount: 0 },
          linkage: { checked: true, exact: true, agentType: 'zcode-rescue', childThreadId: CHILD_THREAD, parentThreadId: 'root-thread-1' },
          collection: { rolloutCount: 2, childToolCallCount: 3, truncated: false, excerpts: [] },
          companion: { launchCount: 1, sendCount: 1, sendCountKnown: true, duplicateLaunch: false, preLaunchDiagnostics: { excerpts: [], truncated: false } },
          handle: { originalHandleChecked: true },
          observations: { outerReturns: 1, modelCalls: 5, rootJoins: 1, decisiveWallMs: null, pendingInnerAtEnd: true },
        },
      };
      const facts = mapShellWaitLiveFacts(
        { case: 'rescue-interrupt', codexBinary: '/bin/x', sourceSha: 'a'.repeat(40), output: '/o', workerDurationMs: 420_000, capMs: null, pollMs: 3_600_000, budgetMs: 720_000 },
        held, evidence, null, null,
        { workspace: '/w', codexHome: '/h', installedRoot: '/i', env: {}, record: { variant: 'candidate', capMs: null, pollMs: 3_600_000, appliedArtifacts: [] } },
        [root, child], [], LAUNCHER,
      );
      assert.equal(facts.interrupt.pendingIntervalMs, null, 'the interrupt preceded the first poll: no pending window exists');
      assert.equal(facts.interrupt.settled, null, 'survival is attributed only for a CONFIRMED pending window: the outcome stays unknown');
      assert.equal(facts.interrupt.settledBasis, 'settlement-unavailable', 'the honest basis records the unavailable settlement');
      assert.notEqual(facts.inconclusive, null);
    });

    // --- P2-3: fd3 is destroyed when the spawn finishes ---

    test('the caller pipe (fd3) is destroyed when the spawn finishes, even with a descendant holder', async () => {
      const sockets = () => process._getActiveHandles().filter((handle) => handle?.constructor?.name === 'Socket').length;
      const leakChild = async () => {
        await defaultCompanionChildSpawn({
          command: process.execPath,
          args: ['-e', [
            'const { spawn } = require("node:child_process");',
            'const holder = spawn(process.execPath, ["-e", "setTimeout(() => process.exit(0), 15000);"], { stdio: ["ignore", "ignore", "ignore", 3, "ignore"], detached: true });',
            'holder.unref();',
            'setTimeout(() => process.exit(0), 50);',
          ].join('\n'),
          '{"type":"background","job":{"id":"g"}}',
        ],
          cwd: process.cwd(),
          env: process.env,
          callerEnvelope: { callerContext: 'test' },
          timeoutMs: 30_000,
        });
      };
      const settle = () => new Promise((resolve) => setTimeout(resolve, 100));
      await leakChild();
      await settle();
      const before = sockets();
      await leakChild();
      await settle();
      const after = sockets();
      assert.equal(after, before, 'the caller pipe (fd3) must be destroyed when the spawn finishes: a descendant holding fd3 cannot keep a socket active');
    });
  });

  describe('review round 26 refinements: blocking unparseable continuations, exclusive process statuses', async () => {
    const { extractInterruptInteraction, parseToolOutput } = await import('../tools/shell-wait-probe/evidence.mjs');
    const { mapShellWaitLiveFacts } = await import('../tools/shell-wait-probe/driver.mjs');

    const CHILD_THREAD = 'b9c0d1e2-3377-44f8-8ad9-34a5b6c7d8e9';
    const LAUNCHER = 'node "/installed/zcode/skills/rescue/launcher.mjs" invoke-prepared rescue';
    const SENTINEL = 'ZCODE_RESCUE_PUBLIC_SENTINEL_7C9C';
    const HANDLE = 5;

    const at15 = (second) => `2026-10-06T20:00:${String(second).padStart(2, '0')}Z`;
    const stamped = (timestamp, event) => ({ timestamp, ...event });
    const fnCall = (name, callId, args, timestamp = null) => ({
      ...(timestamp ? stamped(timestamp, {}) : {}),
      type: 'response_item', payload: { type: 'function_call', name, call_id: callId, arguments: JSON.stringify(args) },
    });
    const fnOutput = (callId, output, timestamp = null) => ({
      ...(timestamp ? stamped(timestamp, {}) : {}),
      type: 'response_item', payload: { type: 'function_call_output', call_id: callId, output },
    });
    const completedOutputBody = (result) => [
      { type: 'input_text', text: 'Script completed\n' },
      { type: 'input_text', text: JSON.stringify(result) },
    ];
    const pendingOutputBody = (cellId) => [{ type: 'input_text', text: `Script running with cell ID ${cellId}\n` }];
    const binding = { childThreadId: CHILD_THREAD, command: LAUNCHER };

    // --- P2-1: an unparseable continuation response BLOCKS the window ---

    test('an unparseable continuation response before the interrupt blocks pending-window qualification', () => {
      // The linked wait demonstrably RECEIVED a response (unreadable) before
      // the interrupt: the continuation could already have completed or
      // terminated the cell — the original poll interval is never "absent-
      // response outstanding".
      const root = [
        { type: 'session_meta', payload: { id: 'root-thread-1' } },
        stamped(at15(8), fnCall('interrupt_agent', 'int-1', { target: CHILD_THREAD })),
        stamped(at15('08.2'), fnOutput('int-1', JSON.stringify({ previous_status: 'running' }))),
      ];
      const child = [
        { type: 'session_meta', payload: { id: CHILD_THREAD } },
        stamped(at15(0), fnCall('exec_command', 'launch-1', { cmd: LAUNCHER })),
        stamped(at15(1), fnOutput('launch-1', completedOutputBody({ output: '', exit_code: 0, session_id: HANDLE }))),
        stamped(at15(5), fnCall('write_stdin', 'poll-1', { session_id: HANDLE, chars: '', yield_time_ms: 3_600_000 })),
        stamped(at15('05.5'), fnOutput('poll-1', pendingOutputBody('cell-1'))),
        stamped(at15(6), fnCall('wait', 'wait-1', { cell_id: 'cell-1' })),
        stamped(at15('06.5'), fnOutput('wait-1', '~~unparseable-continuation-response~~')),
      ];
      const interaction = extractInterruptInteraction([root, child], [], binding);
      assert.equal(interaction.attempted, true);
      assert.equal(interaction.orderingBound, true);
      assert.equal(interaction.pendingBeforeCall.observed, false,
        'the unparseable continuation response blocks the window: it is never an absent response');
    });

    test('the mapping keeps an unparseable-continuation trial inconclusive without a pending interval', () => {
      const root = [
        { type: 'session_meta', payload: { id: 'root-thread-1' } },
        stamped(at15(8), fnCall('interrupt_agent', 'int-1', { target: CHILD_THREAD })),
        stamped(at15('08.2'), fnOutput('int-1', JSON.stringify({ previous_status: 'running' }))),
      ];
      const child = [
        { type: 'session_meta', payload: { id: CHILD_THREAD } },
        stamped(at15(0), fnCall('exec_command', 'launch-1', { cmd: LAUNCHER })),
        stamped(at15(1), fnOutput('launch-1', completedOutputBody({ output: '', exit_code: 0, session_id: HANDLE }))),
        stamped(at15(5), fnCall('write_stdin', 'poll-1', { session_id: HANDLE, chars: '', yield_time_ms: 3_600_000 })),
        stamped(at15('05.5'), fnOutput('poll-1', pendingOutputBody('cell-1'))),
        stamped(at15(6), fnCall('wait', 'wait-1', { cell_id: 'cell-1' })),
        stamped(at15('06.5'), fnOutput('wait-1', '~~unparseable-continuation-response~~')),
      ];
      const held = {
        endedBeforeGate: true, budgetExpired: false, identity: undefined, processAliveWhileHeld: null,
        result: { code: 0, stdout: '', stderr: '' },
        cleanup: { label: 'observation', releasedGate: true, verifiedProcessTerminated: true, codexTerminated: true, nativeInterruptionClaimed: false, errors: [] },
        timeline: { clock: 'held-turn-monotonic-elapsed-ms', launchedAtElapsedMs: 10, observationDetectedAtElapsedMs: 20, pollStartedAtElapsedMs: 30, holdDeadlineElapsedMs: 420_000, rootAcknowledgementAtElapsedMs: null, childSettlementDetectedAtElapsedMs: null, endedAtElapsedMs: 50 },
      };
      const evidence = {
        status: 'supported',
        facts: {
          completion: { qualified: true, processExit: 0, publicResultMatched: true, decisiveEnd: 'process-exit', structuralViolationCount: 0 },
          linkage: { checked: true, exact: true, agentType: 'zcode-rescue', childThreadId: CHILD_THREAD, parentThreadId: 'parent-1' },
          collection: { rolloutCount: 2, childToolCallCount: 4, truncated: false, excerpts: [] },
          companion: { launchCount: 1, sendCount: 1, sendCountKnown: true, duplicateLaunch: false, preLaunchDiagnostics: { excerpts: [], truncated: false } },
          handle: { originalHandleChecked: true },
          observations: { outerReturns: 1, modelCalls: 4, rootJoins: 1, decisiveWallMs: null, pendingInnerAtEnd: false },
        },
      };
      const facts = mapShellWaitLiveFacts(
        { case: 'rescue-interrupt', codexBinary: '/bin/x', sourceSha: 'a'.repeat(40), output: '/o', workerDurationMs: 420_000, capMs: null, pollMs: 3_600_000, budgetMs: 720_000 },
        held, evidence, null, null,
        { workspace: '/w', codexHome: '/h', installedRoot: '/i', env: {}, record: { variant: 'candidate', capMs: null, pollMs: 3_600_000, appliedArtifacts: [] } },
        [root, child], [], LAUNCHER,
      );
      assert.equal(facts.interrupt.pendingIntervalMs, null, 'a blocked window is never a pending interval');
      assert.notEqual(facts.inconclusive, null, 'an unproven window keeps the interrupt case inconclusive');
    });

    // --- P2-2: exited and running statuses are mutually exclusive ---

    test('a native header combining exited and running statuses fails the decode closed', () => {
      // Neither field repeats (the cardinality guard alone passes it), but the
      // two process statuses are mutually exclusive: the mixed response can
      // never supply terminal-completion evidence.
      const mixed = 'Wall time: 31.0000 seconds\nProcess exited with code 0\nProcess running with session ID 5\nOutput:\n' + SENTINEL + '\n';
      assert.equal(parseToolOutput(mixed), null, 'the contradictory mixed header fails the decode closed');
    });

    test('a mixed-header poll with the expected sentinel never qualifies completion', () => {
      const root = [
        { type: 'session_meta', payload: { id: 'root-thread-1' } },
        stamped(at15(0), fnCall('spawn_agent', 'spawn-1', { task_name: 'zcode_rescue_task_1', agent_type: 'zcode-rescue' })),
      ];
      const child = [
        { type: 'session_meta', payload: { id: CHILD_THREAD } },
        stamped(at15(0), fnCall('exec_command', 'launch-1', { cmd: LAUNCHER })),
        stamped(at15(1), fnOutput('launch-1', completedOutputBody({ output: '', exit_code: 0, session_id: HANDLE }))),
        stamped(at15(5), fnCall('write_stdin', 'poll-1', { session_id: HANDLE, chars: '', yield_time_ms: 60_000 })),
        stamped(at15(9), fnOutput('poll-1', 'Wall time: 31.0000 seconds\nProcess exited with code 0\nProcess running with session ID 5\nOutput:\n' + SENTINEL + '\n')),
      ];
      const held = {
        endedBeforeGate: false, budgetExpired: false, identity: undefined, processAliveWhileHeld: null,
        result: { code: 0, stdout: '', stderr: '' },
        cleanup: { label: 'observation', releasedGate: true, verifiedProcessTerminated: true, codexTerminated: true, nativeInterruptionClaimed: false, errors: [] },
        timeline: { clock: 'held-turn-monotonic-elapsed-ms', launchedAtElapsedMs: 10, observationDetectedAtElapsedMs: 20, pollStartedAtElapsedMs: 30, holdDeadlineElapsedMs: 420_000, rootAcknowledgementAtElapsedMs: null, childSettlementDetectedAtElapsedMs: null, endedAtElapsedMs: 50 },
      };
      const evidence = {
        status: 'supported',
        facts: {
          completion: { qualified: false, processExit: null, publicResultMatched: null, decisiveEnd: null, structuralViolationCount: 0 },
          linkage: { checked: true, exact: true, agentType: 'zcode-rescue', childThreadId: CHILD_THREAD, parentThreadId: 'parent-1' },
          collection: { rolloutCount: 2, childToolCallCount: 3, truncated: false, excerpts: [] },
          companion: { launchCount: 1, sendCount: 1, sendCountKnown: true, duplicateLaunch: false, preLaunchDiagnostics: { excerpts: [], truncated: false } },
          handle: { originalHandleChecked: true },
          observations: { outerReturns: 1, modelCalls: 5, rootJoins: 1, decisiveWallMs: null, pendingInnerAtEnd: false },
        },
      };
      const facts = mapShellWaitLiveFacts(
        { case: 'rescue-interrupt', codexBinary: '/bin/x', sourceSha: 'a'.repeat(40), output: '/o', workerDurationMs: 420_000, capMs: null, pollMs: 3_600_000, budgetMs: 720_000 },
        held, evidence, null, null,
        { workspace: '/w', codexHome: '/h', installedRoot: '/i', env: {}, record: { variant: 'candidate', capMs: null, pollMs: 3_600_000, appliedArtifacts: [] } },
        [root, child], [], LAUNCHER,
      );
      assert.notEqual(facts.inconclusive, null, 'a contradictory mixed-header response never supplies terminal-completion evidence');
    });
  });

  describe('review round 27 refinements: unreadable continuations block the exemption', async () => {
    const { mapShellWaitLiveFacts } = await import('../tools/shell-wait-probe/driver.mjs');

    const CHILD_THREAD = 'c0d1e2f3-4455-4408-9fe9-34a5b6c7d8e9';
    const LAUNCHER = 'node "/installed/zcode/skills/rescue/launcher.mjs" invoke-prepared rescue';

    const at16 = (second) => `2026-10-06T21:00:${String(second).padStart(2, '0')}Z`;
    const stamped = (timestamp, event) => ({ timestamp, ...event });
    const fnCall = (name, callId, args, timestamp = null) => ({
      ...(timestamp ? stamped(timestamp, {}) : {}),
      type: 'response_item', payload: { type: 'function_call', name, call_id: callId, arguments: JSON.stringify(args) },
    });
    const fnOutput = (callId, output, timestamp = null) => ({
      ...(timestamp ? stamped(timestamp, {}) : {}),
      type: 'response_item', payload: { type: 'function_call_output', call_id: callId, output },
    });

    test('an unreadable post-interrupt wait response blocks the exemption: settlement stays unknown', () => {
      // A yielded poll is interrupted successfully (running) and its linked
      // wait SUBSEQUENTLY returns an UNPARSEABLE response: that response could
      // itself represent COMPLETION or TERMINATION, so survival is unknown —
      // the exemption must not fire and the trial stays inconclusive.
      const root = [
        { type: 'session_meta', payload: { id: 'root-thread-1' } },
        stamped(at16(7), fnCall('interrupt_agent', 'int-1', { target: CHILD_THREAD })),
        stamped(at16('07.2'), fnOutput('int-1', JSON.stringify({ previous_status: 'running' }))),
      ];
      const child = [
        { type: 'session_meta', payload: { id: CHILD_THREAD } },
        stamped(at16(0), fnCall('exec_command', 'launch-1', { cmd: LAUNCHER })),
        stamped(at16(1), fnOutput('launch-1', [
          { type: 'input_text', text: 'Script completed\n' },
          { type: 'input_text', text: JSON.stringify({ output: '', exit_code: 0, session_id: 5 }) },
        ])),
        stamped(at16(5), fnCall('write_stdin', 'poll-1', { session_id: 5, chars: '', yield_time_ms: 3_600_000 })),
        stamped(at16('05.5'), fnOutput('poll-1', [{ type: 'input_text', text: 'Script running with cell ID cell-1\n' }])),
        stamped(at16(9), fnCall('wait', 'wait-1', { cell_id: 'cell-1' })),
        stamped(at16('09.5'), fnOutput('wait-1', '~~unparseable-continuation-response~~')),
      ];
      const held = {
        endedBeforeGate: false, budgetExpired: false, identity: undefined, processAliveWhileHeld: null,
        result: { code: 0, stdout: '', stderr: '' },
        cleanup: { label: 'observation', releasedGate: true, verifiedProcessTerminated: true, codexTerminated: true, nativeInterruptionClaimed: false, errors: [] },
        timeline: { clock: 'held-turn-monotonic-elapsed-ms', launchedAtElapsedMs: 10, observationDetectedAtElapsedMs: 20, pollStartedAtElapsedMs: 30, holdDeadlineElapsedMs: 420_000, rootAcknowledgementAtElapsedMs: null, childSettlementDetectedAtElapsedMs: null, endedAtElapsedMs: 50 },
      };
      const evidence = {
        status: 'supported',
        facts: {
          completion: { qualified: true, processExit: 0, publicResultMatched: true, decisiveEnd: 'process-exit', structuralViolationCount: 0 },
          linkage: { checked: true, exact: true, agentType: 'zcode-rescue', childThreadId: CHILD_THREAD, parentThreadId: 'root-thread-1' },
          collection: { rolloutCount: 2, childToolCallCount: 4, truncated: false, excerpts: [] },
          companion: { launchCount: 1, sendCount: 1, sendCountKnown: true, duplicateLaunch: false, preLaunchDiagnostics: { excerpts: [], truncated: false } },
          handle: { originalHandleChecked: true },
          observations: { outerReturns: 1, modelCalls: 4, rootJoins: 1, decisiveWallMs: null, pendingInnerAtEnd: true },
        },
      };
      const facts = mapShellWaitLiveFacts(
        { case: 'rescue-interrupt', codexBinary: '/bin/x', sourceSha: 'a'.repeat(40), output: '/o', workerDurationMs: 420_000, capMs: null, pollMs: 3_600_000, budgetMs: 720_000 },
        held, evidence, null, null,
        { workspace: '/w', codexHome: '/h', installedRoot: '/i', env: {}, record: { variant: 'candidate', capMs: null, pollMs: 3_600_000, appliedArtifacts: [] } },
        [root, child], [], LAUNCHER,
      );
      assert.match(String(facts.inconclusive?.reason ?? ''), /unreadable continuation/u,
        'an unreadable post-interrupt continuation response blocks the interruption exemption');
      assert.equal(facts.interrupt.settled, null, 'settlement stays UNKNOWN: the unreadable response could represent completion or termination');
      assert.equal(facts.interrupt.settledBasis, 'unparseable-continuation-settlement-unknown', 'the explicit unknown basis is recorded');
      assert.equal(facts.interrupt.unreadableContinuationObserved, true);
    });
  });

  describe('review round 28 refinements: the observer digest binds to the executing revision', async () => {
    const { runShellWaitCase } = await import('../tools/shell-wait-probe/driver.mjs');
    const { mkdtemp, mkdir, rm, readFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');

    /** The minimal round-8 harness: injected fixture + executor + reader. */
    const provenanceHarness = async (t, reader) => {
      const temporary = await mkdtemp(join(tmpdir(), 'shell-wait-r28-provenance-'));
      t.after(() => rm(temporary, { recursive: true, force: true }));
      const output = join(temporary, 'output');
      await mkdir(output, { mode: 0o700 });
      const provenanceReads = [];
      const record = await runShellWaitCase(
        { case: 'rescue-long', codexBinary: process.execPath, sourceSha: 'a'.repeat(40), output, workerDurationMs: 1000, capMs: null, pollMs: 3_600_000, budgetMs: 2000 },
        {
          createFixture: async () => ({
            workspace: join(temporary, 'ws'), codexHome: join(temporary, 'home'),
            installedRoot: join(temporary, 'installed'), env: { CODEX_HOME: join(temporary, 'home') },
            record: { variant: 'candidate', capMs: null, pollMs: 3_600_000, appliedArtifacts: [] },
            dispose: async () => {},
          }),
          executeLiveCase: async () => ({
            codexVersion: null,
            route: { requested: 'named', actual: null },
            hostResult: { exitCode: 0, companionProcessExit: 0, sentinelMatched: true, terminalStdoutChecked: true, resultCheck: null, resultCheckLabel: null },
            linkage: { checked: true, mode: 'rescue', rootThreadId: null, childThreadId: 'c0d1e2f3-66ff-4b2c-8d7e-2f3a4b5c6d7e', parentThreadId: 'parent-1', companionLaunchCount: 1, companionSendCount: 1, originalHandleChecked: true },
            observations: { outerReturns: 0, modelCalls: 2, rootJoins: 1, decisiveWallMs: null, pendingInnerAtEnd: false },
            interrupt: { requested: false, delivered: null, settled: null, missingPrerequisite: null },
            held: { endedBeforeGate: false, cleanupLabel: 'observation', gateReleased: true, cleanupErrors: { count: 0, reasons: [] }, processTermination: { verifiedTerminated: true, codexTerminated: true }, cleanupComplete: true },
            child: { settlement: null, rootAcknowledgementAtElapsedMs: null, settlementDetectedAtElapsedMs: null },
            statusQuery: null,
            excerpts: [],
            inconclusive: null,
          }),
          observerProvenance: async () => {
            const value = await reader(provenanceReads.length);
            provenanceReads.push(value);
            return value;
          },
        },
      );
      return { record, provenanceReads, written: JSON.parse(await readFile(join(output, 'rescue-long.record.json'), 'utf8')) };
    };

    const provenanceValue = (digest) => ({
      revision: 'working-tree-uncommitted', digest, digestInput: 'test || evidence.mjs || driver.mjs', model: null, reachableToolFamily: null,
    });

    test('a mid-run observer source change is recorded and the run stays attributed to the case-start revision', async (t) => {
      const digestA = 'a'.repeat(64);
      const digestB = 'b'.repeat(64);
      const reads = [provenanceValue(digestA), provenanceValue(digestB)];
      const { record } = await provenanceHarness(t, async (index) => {
        if (reads[index] === undefined) throw new Error('unexpected third provenance read');
        return reads[index];
      });
      assert.equal(record.provenance.observer?.digest, digestA,
        'the run is attributed to the CASE-START revision (the executing observer), never to newer bytes');
      assert.equal(record.provenance.observer?.sourcesChangedDuringRun, true,
        'the mid-run source change is recorded as an explicit fact');
      assert.equal(record.provenance.observer?.recordTimeDigest, digestB,
        'the record-time digest is retained for transparency');
      assert.equal(record.inconclusive, null);
    });

    test('a case-start read failure keeps the null-digest collection-failed provenance', async (t) => {
      let calls = 0;
      const { record } = await provenanceHarness(t, async () => {
        calls += 1;
        if (calls === 1) throw new Error('the observer source became unreadable at case start');
        return provenanceValue('c'.repeat(64));
      });
      assert.equal(record.provenance.observer?.digest ?? null, null,
        'without a trustworthy case-start digest there is no attribution');
      assert.match(String(record.provenance.observer?.revision), /collection-failed/i);
      assert.match(String(record.inconclusive?.reason), /observer provenance could not be collected/i);
    });

    test('a record-time read failure fails closed: null digest, never a partial attribution', async (t) => {
      const digestA = 'd'.repeat(64);
      let calls = 0;
      const { record } = await provenanceHarness(t, async () => {
        calls += 1;
        if (calls === 2) throw new Error('the observer source became unreadable at record time');
        return provenanceValue(digestA);
      });
      assert.equal(record.provenance.observer?.digest ?? null, null,
        'a read failure keeps the R8 null-digest rule: no attribution without both reads');
      assert.match(String(record.provenance.observer?.revision), /collection-failed/i);
      assert.match(String(record.inconclusive?.reason), /observer provenance could not be collected/i,
        'the record-time failure is still recorded as an inconclusive reason');
    });
  });

  describe('review round 29 refinements: watches agree with the observer, executing-source provenance', async () => {
    const { waitForChildSettlementObservation, waitForPollObservation, EXECUTING_OBSERVER_PROVENANCE, runShellWaitCase } = await import('../tools/shell-wait-probe/driver.mjs');

    const CHILD_THREAD = 'c1d2e3f4-8800-4409-8fea-45b6c7d8e9f0';
    const fnCall = (name, callId, args) => ({
      type: 'response_item', payload: { type: 'function_call', name, call_id: callId, arguments: JSON.stringify(args) },
    });
    const LAUNCHER = 'node "/installed/zcode/skills/rescue/launcher.mjs" invoke-prepared rescue';
    const SENTINEL = 'ZCODE_RESCUE_PUBLIC_SENTINEL_7C9C';
    const HANDLE = 5;

    const nativeOutput = (callId, body) => ({ type: 'response_item', payload: { type: 'function_call_output', call_id: callId, output: body } });

    // A supported cell: the exact launch FIRST, then one original-handle
    // empty-input poll. BOTH statements share the call id AND the response.
    const sharedLaunchPollRollout = (pollResultBody) => [[
      { type: 'session_meta', payload: { id: 'root-thread-1' } },
      fnCall('spawn_agent', 'spawn-1', { task_name: 'zcode_rescue_task_1', fork_turns: 'none', agent_type: 'zcode-rescue', message: 'Run the installed prepared ZCode Rescue forwarder now. Return its public stdout verbatim.' }),
      fnCall('wait_agent', 'root-wait-1', { timeout_ms: 600000 }),
    ], [
      { type: 'session_meta', payload: { id: CHILD_THREAD } },
      { type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'cell-1', input: [
        `const r = await tools.exec_command(${JSON.stringify({ cmd: LAUNCHER, workdir: '/installed/workspace' })}); text(JSON.stringify(r))\n`,
        `const r = await tools.write_stdin(${JSON.stringify({ session_id: HANDLE, chars: '', yield_time_ms: 60000 })}); text(JSON.stringify(r))\n`,
      ].join('\n') } },
      nativeOutput('cell-1', pollResultBody),
    ]];
    // The completed shared-cell response: per-statement JSON results — the
    // LAUNCH result first, then the poll's terminal result (exit + sentinel).
    const completedSharedResponse = [
      { type: 'input_text', text: JSON.stringify({ output: '', exit_code: 0, session_id: HANDLE }) },
      { type: 'input_text', text: JSON.stringify({ output: SENTINEL, exit_code: 0, session_id: HANDLE }) },
    ];

    // --- P2-1: the watches agree with what the observer adjudicates ---

    test('the settlement watch settles a shared launch+poll cell from the poll own result', async () => {
      let loads = 0;
      const settlement = await waitForChildSettlementObservation('/codex-home', LAUNCHER, { aborted: false, addEventListener() {} }, {
        loadRollouts: async () => {
          loads += 1;
          return loads >= 2 ? sharedLaunchPollRollout(completedSharedResponse) : [];
        },
        sleep: async () => {},
      });
      assert.equal(settlement.observed, true, 'the linked poll own completed result settles the shared-cell watch');
      assert.equal(settlement.basis, 'exact-launch-handle-linked-completed-exit-code-output');
    });

    test('a shared launch+poll cell whose poll is still running never settles the watch', async () => {
      const controller = new AbortController();
      let loads = 0;
      await assert.rejects(
        waitForChildSettlementObservation('/codex-home', LAUNCHER, controller.signal, {
          loadRollouts: async () => {
            loads += 1;
            if (loads >= 4) controller.abort();
            return sharedLaunchPollRollout([
              { type: 'input_text', text: JSON.stringify({ output: '', exit_code: 0, session_id: HANDLE }) },
              { type: 'input_text', text: 'Script running with cell ID cell-2\n' },
            ]);
          },
          sleep: async () => {},
        }),
        /aborted/u,
        'a still-running shared-cell poll never settles the Child observation',
      );
    });

    test('the poll-start watch fires for a poll sharing the launch cell', async () => {
      // The completed shared response evidences the launch completion AND the
      // poll start (preceding statement completed, poll reached).
      let loads = 0;
      const controller = new AbortController();
      const outcome = await waitForPollObservation('/codex-home', LAUNCHER, controller.signal, {
        loadRollouts: async () => {
          loads += 1;
          if (loads >= 4) controller.abort();
          return loads >= 2 ? sharedLaunchPollRollout(completedSharedResponse) : [];
        },
        sleep: async () => {},
      }).then(() => 'resolved', () => 'aborted');
      assert.equal(outcome, 'resolved', 'the poll start is recorded for the shared-cell poll once its execution is evidenced');
    });

    // --- P2-2: the provenance digest binds to the EXECUTING source snapshot ---

    test('the default provenance is the module-init executing-source snapshot', async (t) => {
      const { mkdtemp, mkdir, rm } = await import('node:fs/promises');
      const { tmpdir } = await import('node:os');
      const temporary = await mkdtemp(join(tmpdir(), 'shell-wait-r29-provenance-'));
      t.after(() => rm(temporary, { recursive: true, force: true }));
      const output = join(temporary, 'output');
      await mkdir(output, { mode: 0o700 });
      const record = await runShellWaitCase(
        { case: 'rescue-long', codexBinary: process.execPath, sourceSha: 'a'.repeat(40), output, workerDurationMs: 1000, capMs: null, pollMs: 3_600_000, budgetMs: 2000 },
        {
          createFixture: async () => ({
            workspace: join(temporary, 'ws'), codexHome: join(temporary, 'home'),
            installedRoot: join(temporary, 'installed'), env: { CODEX_HOME: join(temporary, 'home') },
            record: { variant: 'candidate', capMs: null, pollMs: 3_600_000, appliedArtifacts: [] },
            dispose: async () => {},
          }),
          executeLiveCase: async () => ({
            codexVersion: null,
            route: { requested: 'named', actual: null },
            hostResult: { exitCode: 0, companionProcessExit: 0, sentinelMatched: true, terminalStdoutChecked: true, resultCheck: null, resultCheckLabel: null },
            linkage: { checked: true, mode: 'rescue', rootThreadId: null, childThreadId: 'c1d2e3f4-8800-4409-8fea-45b6c7d8e9f0', parentThreadId: 'parent-1', companionLaunchCount: 1, companionSendCount: 1, originalHandleChecked: true },
            observations: { outerReturns: 0, modelCalls: 2, rootJoins: 1, decisiveWallMs: null, pendingInnerAtEnd: false },
            interrupt: { requested: false, delivered: null, settled: null, missingPrerequisite: null },
            held: { endedBeforeGate: false, cleanupLabel: 'observation', gateReleased: true, cleanupErrors: { count: 0, reasons: [] }, processTermination: { verifiedTerminated: true, codexTerminated: true }, cleanupComplete: true },
            child: { settlement: null, rootAcknowledgementAtElapsedMs: null, settlementDetectedAtElapsedMs: null },
            statusQuery: null,
            excerpts: [],
            inconclusive: null,
          }),
          // NO injected reader: the default case-start capture is the
          // module-init executing-source snapshot.
        },
      );
      assert.equal(record.provenance.observer?.digest, EXECUTING_OBSERVER_PROVENANCE.digest,
        'the digest describes the EXECUTING source snapshot, not post-setup disk bytes');
      assert.match(String(record.provenance.observer?.digestInput ?? ''), /executing module-init snapshot/u);
      assert.equal(record.provenance.observer?.sourcesChangedDuringRun, false,
        'an unchanged executing source records no mid-run change');
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
