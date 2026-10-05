// @ts-check
/**
 * Isolated installed-plugin fixture for the native shell long-wait
 * qualification (research-only). It builds the marketplace from a temporary
 * clean detached source worktree in an isolated clone at the caller's `sourceSha`
 * (owned by this fixture, so uncommitted docs and progress files can never enter
 * or invalidate the snapshot), installs through the EXACT chosen Codex binary
 * into an isolated `CODEX_HOME`, then applies the recorded candidate cap and
 * waiting paragraph to the temporary installed artifacts BEFORE any isolated
 * setup runs. Builder cleanup uses only the clone's Git metadata. Cleanup removes
 * the clone, its exact owned detached registration, the credential homes, and
 * the exact owned processes.
 *
 * The public interface is fixed by the qualification plan:
 *
 * createShellWaitFixture({ sourceRoot, sourceSha, codexBinary, output,
 * variant, capMs }) -> { workspace, codexHome, installedRoot, env, dispose }
 *
 * The returned record additionally carries the fixture-tested provenance
 * (instruction hashes, applied artifact digests and modes, cap placement) and
 * an optional second `dependencies` argument injects fast fakes for the
 * snapshot build, plugin install, credential copy, and owned-worktree removal
 * in instrument tests.
 * Nothing here launches anything at import time, and a fixture trust bypass is
 * a fixture control — never persisted production-trust qualification.
 */
import { createHash, randomUUID } from 'node:crypto';
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildMarketplaceSnapshot } from '../../scripts/build-marketplace-snapshot.mjs';
import { renderManagedRescueRole } from '../../scripts/lib/managed-agent-role.mjs';
import { runProcess } from '../../scripts/lib/process.mjs';
import { codexLaunch, npmLaunch } from '../../scripts/lib/tool-launch.mjs';

const FAKE_ZCODE_PATH = fileURLToPath(new URL('../../tests/fixtures/fake-zcode-cli.mjs', import.meta.url));
/** The fixed harmless public sentinel the fake ZCode returns as its terminal result. */
export const PUBLIC_RESULT_SENTINEL = 'ZCODE_RESCUE_PUBLIC_SENTINEL_7C9C';
const CAP_CONFIGURATION_KEY = 'background_terminal_max_timeout';

/** The exact installed waiting-policy paragraph this instrument is allowed to change. */
const ORIGINAL_WAITING_PARAGRAPH = 'Observe only the original running process handle. Start the constant command once with the longest initial exec_command yield, up to 30000 ms. If it returns a live process handle, observe only that handle with empty-input write_stdin calls using yield_time_ms: 60000. Send no characters, do not start another process, and do not replace terminal observation with Status polling or sleep. This applies identically to Rescue\'s named and generic Role assignments; the initial launcher yield is 30000, subsequent same-handle observations are 60000.';

/**
 * The candidate waiting policy: only the inner observation request changes
 * (directive-led single long window); every authority, fixed command, initial
 * and choice assignment literal, and terminal rule stays byte-identical.
 * @param {number} pollYieldMs
 */
function candidateWaitingParagraph(pollYieldMs) {
  const requested = String(pollYieldMs);
  return 'Observe only the original running process handle. Start the constant command once with the longest initial exec_command yield, up to 30000 ms. If it returns a live process handle, observe only that handle with empty-input write_stdin calls requesting a single observation window of ' + requested + ' ms: emit exactly one directive line `// @exec: {"yield_time_ms": ' + requested + '}` immediately before the call, and pass yield_time_ms: ' + requested + ' on that same empty-input call. Send no characters, do not start another process, and do not replace terminal observation with Status polling or sleep. This applies identically to Rescue\'s named and generic Role assignments; the initial launcher yield is 30000, and every subsequent same-handle observation requests the ' + requested + ' ms window with its leading directive.';
}

/** @param {string} message @returns {TypeError} */
function invalidFixtureInput(message) {
  return new TypeError(`Invalid shell wait fixture input: ${message}`);
}

/** @param {string} value */
function hasControlCharacter(value) {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 31 || code === 127;
  });
}

/**
 * `git worktree list` canonicalizes paths (macOS reports /private/var/... for a
 * /var/... registration), so registration comparison must be canonical too —
 * including when the worktree directory itself was already removed.
 * @param {string} linePath @param {string} ownedPath
 */
export function sameRegisteredPath(linePath, ownedPath) {
  /** @param {string} value */
  const withoutPrivateSegment = (value) => value.replace(/^\/private(?=\/)/u, '');
  return withoutPrivateSegment(linePath) === withoutPrivateSegment(ownedPath);
}

/** @param {string} output */
export function registeredWorktreePaths(output) {
  return output.split('\n').filter((line) => line.startsWith('worktree ')).map((line) => line.slice('worktree '.length));
}

/**
 * Git's local overrides include repository/worktree/common/index/object paths,
 * graft/shallow/replace state and config injection (including numbered keys).
 * Clear the entire inherited GIT_* namespace, also covering GIT_NAMESPACE,
 * discovery controls and future overrides, at every fixture process boundary.
 * @returns {NodeJS.ProcessEnv}
 */
function isolatedGitEnvironment() {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
}

/** @param {string} cwd @param {string[]} args @param {number} [timeoutMs] @param {number} [maxOutputBytes] */
async function runGit(cwd, args, timeoutMs = 30_000, maxOutputBytes = 1024 * 1024) {
  return runProcess({ command: 'git', args: [] }, { cwd, args, env: isolatedGitEnvironment(), timeoutMs, maxOutputBytes });
}

/** @param {string} sourceRoot @param {string} sourceSha */
async function assertGitSource(sourceRoot, sourceSha) {
  if (typeof sourceRoot !== 'string' || sourceRoot.length === 0 || hasControlCharacter(sourceRoot) || !isAbsolute(sourceRoot)) {
    throw invalidFixtureInput('sourceRoot must be an absolute path.');
  }
  const metadata = await lstat(sourceRoot).catch(() => null);
  if (!metadata?.isDirectory()) throw invalidFixtureInput('sourceRoot must be a directory.');
  const gitDir = await runGit(sourceRoot, ['rev-parse', '--git-dir']);
  if (gitDir.code !== 0) throw invalidFixtureInput('sourceRoot must be a git repository.');
  if (typeof sourceSha !== 'string' || !/^[a-f0-9]{40}$/u.test(sourceSha)) {
    throw invalidFixtureInput('sourceSha must be a 40-character lowercase hexadecimal commit SHA.');
  }
  const resolved = await runGit(sourceRoot, ['rev-parse', '--verify', '--quiet', `${sourceSha}^{commit}`]);
  if (resolved.code !== 0) throw invalidFixtureInput('sourceSha must be resolvable in the source repository.');
}

/** @param {string} codexBinary */
async function assertCodexBinary(codexBinary) {
  if (typeof codexBinary !== 'string' || codexBinary.length === 0 || hasControlCharacter(codexBinary)
    || !isAbsolute(codexBinary) || /\.(?:cmd|bat)$/i.test(codexBinary)) {
    throw invalidFixtureInput('codexBinary must be an absolute native executable path.');
  }
  const metadata = await lstat(codexBinary).catch((error) => {
    throw invalidFixtureInput(`codexBinary does not exist (${/** @type {NodeJS.ErrnoException} */ (error).code}).`);
  });
  if (!metadata.isFile()) throw invalidFixtureInput('codexBinary must be a regular file.');
}

/** @param {string} output */
async function assertPrivateEmptyOutput(output) {
  if (typeof output !== 'string' || output.length === 0 || hasControlCharacter(output) || !isAbsolute(output)) {
    throw invalidFixtureInput('output must be an absolute path.');
  }
  const metadata = await lstat(output).catch(() => {
    throw invalidFixtureInput('output must exist.');
  });
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw invalidFixtureInput('output must be a real directory, not a symlink.');
  if ((metadata.mode & 0o077) !== 0) throw invalidFixtureInput('output must be private (no group or other access).');
  const entries = await readdir(output);
  if (entries.length !== 0) throw invalidFixtureInput('output must be empty.');
}

/**
 * Validate and normalize the fixture input before any filesystem side effect.
 * @param {ShellWaitFixtureInput} input
 * @returns {{ sourceRoot: string, sourceSha: string, codexBinary: string, output: string, variant: 'baseline'|'candidate', capMs: number|null, pollMs: number, authSource: string }}
 */
function validateFixtureInput(input) {
  if (!input || typeof input !== 'object') throw invalidFixtureInput('the fixture input must be an object.');
  if (input.variant !== 'baseline' && input.variant !== 'candidate') {
    throw invalidFixtureInput('variant must be exactly "baseline" or "candidate".');
  }
  if (input.capMs !== null && input.capMs !== undefined && (!Number.isSafeInteger(input.capMs) || input.capMs <= 0)) {
    throw invalidFixtureInput('capMs must be a positive integer or null (unraised).');
  }
  const pollMs = input.pollMs ?? input.capMs ?? 3_600_000;
  if (!Number.isSafeInteger(pollMs) || pollMs <= 0) throw invalidFixtureInput('pollMs must be a positive integer.');
  return {
    sourceRoot: /** @type {string} */ (input.sourceRoot),
    sourceSha: /** @type {string} */ (input.sourceSha),
    codexBinary: /** @type {string} */ (input.codexBinary),
    output: /** @type {string} */ (input.output),
    variant: input.variant,
    capMs: input.capMs ?? null,
    pollMs,
    authSource: typeof input.authSource === 'string' && input.authSource.length > 0
      ? input.authSource
      : (process.env.CODEX_HOME ?? join(homedir(), '.codex')),
  };
}

/**
 * Extract the complete fixed generic message fence from the installed skill.
 * @param {string} source
 */
function extractGenericMessage(source) {
  const marker = source.indexOf('For the generic route, substitute only the already-bound immutable');
  const fenceStart = marker >= 0 ? source.indexOf('```text\n', marker) : -1;
  const fenceEnd = fenceStart >= 0 ? source.indexOf('\n```', fenceStart + 8) : -1;
  if (marker < 0 || fenceStart < 0 || fenceEnd < 0) {
    throw new Error('The installed skill must retain exactly one fixed generic message fence.');
  }
  return source.slice(fenceStart + '```text\n'.length, fenceEnd + 1);
}

/** @param {string} value */
function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** @param {import('node:fs').Stats} metadata */
function fileMode(metadata) {
  return `0o${(metadata.mode & 0o777).toString(8)}`;
}

/**
 * Build the isolated fixture. See the module documentation.
 * @param {ShellWaitFixtureInput} input
 * @param {Partial<ShellWaitFixtureDependencies>} [dependencies]
 * @returns {Promise<ShellWaitFixtureHandle>}
 */
export async function createShellWaitFixture(input, dependencies = {}) {
  const prepared = validateFixtureInput(input);
  // Validate every caller input and resolvability BEFORE any side effect.
  await assertGitSource(prepared.sourceRoot, prepared.sourceSha);
  await assertCodexBinary(prepared.codexBinary);
  await assertPrivateEmptyOutput(prepared.output);

  const temporary = await mkdtemp(join(tmpdir(), 'zcode-shell-wait-fixture-'));
  await chmod(temporary, 0o700);
  const workspace = join(temporary, 'workspace');
  const codexHome = join(temporary, 'codex-home');
  const isolatedHome = join(temporary, 'home');
  const sourceClone = join(temporary, 'source-repository');
  const cleanSource = join(temporary, 'clean-source');
  const marketplace = join(temporary, 'marketplace');
  const zcodeRecord = join(temporary, 'zcode.jsonl');
  await Promise.all([
    mkdir(codexHome, { recursive: true, mode: 0o700 }),
    mkdir(isolatedHome, { recursive: true, mode: 0o700 }),
    mkdir(workspace, { recursive: true }),
    writeFile(zcodeRecord, '', { mode: 0o600 }),
  ]);

  /** @param {string[]} args */
  const gitInit = async (args) => runGit(workspace, args);
  const initialized = await gitInit(['init', '-q']);
  if (initialized.code !== 0) throw new Error(`the fixture workspace could not be initialized: ${initialized.stderr}`);
  await writeFile(join(workspace, 'tracked.txt'), 'base\n', 'utf8');
  await gitInit(['add', 'tracked.txt']);
  const committed = await gitInit(['-c', 'user.name=Shell Wait Fixture', '-c', 'user.email=fixture@invalid', 'commit', '-qm', 'base']);
  if (committed.code !== 0) throw new Error(`the fixture workspace could not be committed: ${committed.stderr}`);

  // Share only read-only objects with the caller, never Git metadata or worktree
  // registrations. Even the production builder's failure-path prune is confined
  // to this disposable clone. The detached source excludes uncommitted files.
  const cloned = await runGit(prepared.sourceRoot, ['clone', '--shared', '--no-checkout', '--', prepared.sourceRoot, sourceClone], 120_000);
  if (cloned.code !== 0) {
    await rm(temporary, { recursive: true, force: true }).catch(() => {});
    throw new Error(`the isolated source clone could not be created: ${cloned.stderr}`);
  }
  const added = await runGit(sourceClone, ['worktree', 'add', '--detach', cleanSource, prepared.sourceSha], 120_000);
  if (added.code !== 0) {
    await rm(temporary, { recursive: true, force: true }).catch(() => {});
    throw new Error(`the owned clean detached source worktree could not be created: ${added.stderr}`);
  }

  let disposed = false;
  /**
   * Remove ONLY the exact owned registration. A failed targeted removal is
   * surfaced to the caller (who still removes the credential home); a failed
   * registration listing is treated as an unknown/failure state, never as
   * successful disposal. No repository-wide prune runs here: pruning could
   * remove unrelated unlocked registrations. All operations use clone metadata;
   * removing the temporary root also destroys that metadata on failure.
   * @returns {Promise<void>}
   */
  const removeOwnedWorktreeImpl = async () => {
    const removed = await runGit(sourceClone, ['worktree', 'remove', '--force', cleanSource], 120_000);
    const listed = await runGit(sourceClone, ['worktree', 'list', '--porcelain'], 30_000, 1024 * 1024);
    if (listed.code !== 0) {
      throw new Error('could not verify the owned detached worktree registration removal (registration listing failed)');
    }
    const stillRegistered = registeredWorktreePaths(listed.stdout).some((path) => sameRegisteredPath(path, cleanSource));
    if (stillRegistered) {
      throw new Error(`could not remove the owned detached worktree registration${removed.code !== 0 ? `: ${removed.stderr.slice(0, 256)}` : ''}`);
    }
  };

  // The data-root override is inherited from the caller's environment by
  // production resolution, so it MUST be pointed at a fixture-owned directory:
  // otherwise fixture hooks/preparations/jobs would land in EXTERNAL plugin
  // storage that disposal never removes.
  const dataRoot = join(temporary, 'data-root');
  await mkdir(dataRoot, { recursive: true, mode: 0o700 });

  const env = {
    ...isolatedGitEnvironment(),
    CODEX_BINARY: prepared.codexBinary,
    CODEX_HOME: codexHome,
    HOME: isolatedHome,
    USERPROFILE: isolatedHome,
    ZCODE_DATA_ROOT: dataRoot,
    ZCODE_PATH: FAKE_ZCODE_PATH,
    FAKE_ZCODE_RECORD: zcodeRecord,
    FAKE_ZCODE_GATE_RESULT: PUBLIC_RESULT_SENTINEL,
    PATH: process.env.PATH ?? '',
  };

  try {
    const buildSnapshot = dependencies.buildSnapshot ?? (async (context) => {
      await buildMarketplaceSnapshot({
        root: context.cleanSource,
        output: context.output,
        sourceRef: context.sourceSha,
        sourceSha: context.sourceSha,
        npmExecPath: npmLaunch([], { env: context.env }).args[0],
        env: context.env,
      });
    });
    await buildSnapshot({ cleanSource, output: marketplace, sourceSha: prepared.sourceSha, env });
    const marketplaceMetadata = await lstat(marketplace).catch(() => null);
    if (!marketplaceMetadata?.isDirectory()) throw new Error('the marketplace snapshot was not produced.');

    const installPlugin = dependencies.installPlugin ?? (async (context) => {
      for (const args of [['plugin', 'marketplace', 'add', context.marketplace, '--json'], ['plugin', 'add', 'zcode@vitry', '--json']]) {
        const result = await runProcess(codexLaunch(args, { env: context.env }), { cwd: context.codexHome, env: context.env, timeoutMs: 120_000, maxOutputBytes: 4 * 1024 * 1024 });
        if (result.code !== 0) throw new Error(`the exact chosen binary failed to install the plugin: ${(result.stderr || result.stdout).slice(0, 512)}`);
      }
      return {};
    });
    const installRecord = await installPlugin({ marketplace, codexHome, cleanSource, env, codexBinary: prepared.codexBinary }) ?? {};
    const installedRoot = await findInstalledPluginRoot(codexHome);

    // Copy the caller-provided credential source into the isolated home (a
    // fixture control); cleanup removes it even when evidence is preserved.
    let credentialsCopied = false;
    const copyCredentials = dependencies.copyCredentials ?? (async (context) => {
      const sourceAuth = join(context.authSource, 'auth.json');
      const metadata = await lstat(sourceAuth).catch(() => null);
      if (!metadata?.isFile()) return { copied: false };
      const target = join(context.codexHome, 'auth.json');
      await cp(sourceAuth, target);
      await chmod(target, 0o600);
      return { copied: true };
    });
    const copyRecord = await copyCredentials({ codexHome, authSource: prepared.authSource });
    credentialsCopied = copyRecord !== undefined && copyRecord !== null && /** @type {any} */ (copyRecord).copied === true;

    const record = await applyVariantArtifacts({ installedRoot, codexHome, prepared, installRecord, credentialsCopied });
    record.ownedCleanSourceWorktree = /** @type {any} */ (cleanSource);

    // The isolated production setup stands in for a real user's completed
    // `$zcode:setup` installation: without the managed Role registration the
    // constant preflight is `install-required` and Root correctly stops
    // without spawning (observed live, Task 4 Case 0). The candidate/baseline
    // artifacts above are applied BEFORE setup so the rendered managed Role
    // carries the variant waiting policy.
    const runSetupStep = dependencies.runSetup ?? runIsolatedProductionSetup;
    record.isolatedSetup = await runSetupStep({
      installedRoot, codexHome, dataRoot, workspace, temporary,
      env, codexBinary: prepared.codexBinary, capMs: prepared.capMs,
    });

    return {
      workspace,
      codexHome,
      installedRoot,
      env,
      dispose: async () => {
        if (disposed) return;
        disposed = true;
        // Both cleanup outcomes are attempted regardless of the other's result:
        // the credential home (the whole fixture temporary root) is removed even
        // when the owned worktree registration removal fails, and both failures
        // are surfaced to the caller.
        let worktreeError;
        let removalError;
        try {
          await (dependencies.removeOwnedWorktree ?? removeOwnedWorktreeImpl)();
        } catch (error) { worktreeError = error; }
        try {
          await rm(temporary, { recursive: true, force: true });
        } catch (error) { removalError = error; }
        if (worktreeError !== undefined || removalError !== undefined) {
          const failures = [worktreeError, removalError].filter((error) => error !== undefined);
          throw failures.length === 1 ? failures[0] : new AggregateError(failures, 'Shell wait fixture cleanup failed; credential-home removal and owned worktree removal outcomes are both surfaced.');
        }
      },
      record,
    };
  } catch (error) {
    disposed = true;
    // The owned registration is released BEFORE the directory removal: this
    // git rejects `worktree remove --force` once the working tree is already
    // gone ("is not a working tree"), so the previous rm-first order leaked
    // the registration on every creation failure (observed live, Task 4).
    try {
      await (dependencies.removeOwnedWorktree ?? removeOwnedWorktreeImpl)();
    } catch { /* the original failure is reported */ }
    await rm(temporary, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

/**
 * Find the single installed ZCode plugin root inside the isolated home.
 * @param {string} codexHome
 */
async function findInstalledPluginRoot(codexHome) {
  const cacheRoot = join(codexHome, 'plugins', 'cache', 'vitry', 'zcode');
  const entries = await readdir(cacheRoot, { withFileTypes: true }).catch((error) => {
    throw new Error(`the plugin cache is unavailable in the isolated home (${/** @type {NodeJS.ErrnoException} */ (error).code}).`);
  });
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = join(cacheRoot, entry.name);
    const marker = await lstat(join(candidate, 'skills', 'rescue', 'SKILL.md')).then(() => true, () => false);
    if (marker) candidates.push(await realpath(candidate));
  }
  if (candidates.length !== 1) throw new Error(`the isolated home must contain exactly one installed ZCode plugin root (found ${String(candidates.length)}).`);
  return candidates[0];
}

/**
 * Spawn one installed entry with its standard input read from a fixture-owned
 * file: hook entries read bounded JSON events from stdin, and the shared
 * runner's stdio pipe never ends, so the entry's stdin must be a real at-EOF
 * file. The `exec` keeps the spawned PID on the exact entry process.
 * @param {{ command: string, args: string[] }} launch
 * @param {string} inputFile
 */
function stdinFileLaunch(launch, inputFile) {
  return {
    command: '/bin/sh',
    args: ['-c', 'exec "$0" "$@" <"$ZCODE_FIXTURE_STDIN_FILE"', launch.command, ...launch.args],
    env: { ZCODE_FIXTURE_STDIN_FILE: inputFile },
  };
}

/** @param {string} text @param {number} limit */
function boundedErrorText(text, limit = 512) {
  const value = String(text ?? '').trim();
  return value.length > limit ? `${value.slice(0, limit)}<truncated>` : value;
}

/**
 * The isolated production setup: establish the fixture's own caller turn
 * through the production SessionStart and UserPromptSubmit hooks, run the
 * installed plugin's OWN production setup entry (which reconciles the managed
 * Rescue Role through the exact chosen binary's app-server — the module's
 * trusted-root gate requires the installed copy, never this repository's),
 * then verify the constant Role preflight exactly as Root runs it, and that a
 * requested cap configuration survived setup's configuration writes. Every
 * spawned command is the installed copy's own entry point; nothing is
 * hand-manufactured. Failure is fail-closed: the fixture creation rejects and
 * the caller's error path disposes the whole fixture.
 * @param {{ installedRoot: string, codexHome: string, dataRoot: string, workspace: string, temporary: string, env: NodeJS.ProcessEnv, codexBinary: string, capMs: number | null }} context
 * @returns {Promise<Record<string, unknown>>}
 */
async function runIsolatedProductionSetup(context) {
  const { installedRoot, codexHome, workspace, temporary, env, codexBinary, capMs } = context;
  const sessionId = randomUUID();
  const inputsDirectory = join(temporary, 'setup-inputs');
  await mkdir(inputsDirectory, { recursive: true, mode: 0o700 });
  const sessionInputPath = join(inputsDirectory, 'session-start.json');
  const promptInputPath = join(inputsDirectory, 'user-prompt.json');
  await writeFile(sessionInputPath, `${JSON.stringify({ session_id: sessionId, cwd: workspace, hook_event_name: 'SessionStart', transcript_path: null, model: 'gpt', permission_mode: 'acceptEdits', source: 'startup' })}\n`, { mode: 0o600 });
  await writeFile(promptInputPath, `${JSON.stringify({ session_id: sessionId, turn_id: 'fixture-setup-turn', cwd: workspace, hook_event_name: 'UserPromptSubmit', transcript_path: null, model: 'gpt', permission_mode: 'acceptEdits', prompt: 'shell wait fixture isolated setup' })}\n`, { mode: 0o600 });
  const hookEntry = (/** @type {string} */ script, /** @type {string} */ inputPath) => stdinFileLaunch({ command: process.execPath, args: [join(installedRoot, 'hooks', script)] }, inputPath);
  const sessionHook = await runProcess({ command: hookEntry('session-lifecycle-hook.mjs', sessionInputPath).command, args: hookEntry('session-lifecycle-hook.mjs', sessionInputPath).args }, { cwd: workspace, env: { ...env, ...hookEntry('session-lifecycle-hook.mjs', sessionInputPath).env }, timeoutMs: 30_000, maxOutputBytes: 1024 * 1024 });
  if (sessionHook.code !== 0) throw new Error(`the isolated SessionStart hook failed (${sessionHook.code}): ${boundedErrorText(sessionHook.stderr || sessionHook.stdout)}`);
  const promptHookEntry = hookEntry('user-prompt-hook.mjs', promptInputPath);
  const promptHook = await runProcess({ command: promptHookEntry.command, args: promptHookEntry.args }, { cwd: workspace, env: { ...env, ...promptHookEntry.env }, timeoutMs: 30_000, maxOutputBytes: 1024 * 1024 });
  if (promptHook.code !== 0) throw new Error(`the isolated UserPromptSubmit hook failed (${promptHook.code}): ${boundedErrorText(promptHook.stderr || promptHook.stdout)}`);
  const launcherDescriptorPublished = /zcode-rescue-launcher/u.test(promptHook.stdout);

  const setupEntry = { command: process.execPath, args: [join(installedRoot, 'scripts', 'zcode-companion.mjs'), 'setup'] };
  // FAKE_ZCODE_EMPTY_SESSION satisfies the setup auth probe's snapshot
  // contract against the fake peer for THIS invocation only; the live case
  // environment below never sets it, so the observed companion runs against
  // the fake's ordinary behavior.
  const setupEnvironment = { ...env, CODEX_APP_SERVER_PATH: codexBinary, FAKE_ZCODE_EMPTY_SESSION: '1' };
  let setupRun = await runProcess(setupEntry, { cwd: workspace, env: setupEnvironment, timeoutMs: 180_000, maxOutputBytes: 1024 * 1024 });
  let setupAttempts = 1;
  // The production data-root bootstrap writes the writable root and reports
  // restart-required; a real user restarts Codex and reruns setup, and the
  // fixture's deterministic equivalent is one bounded re-run.
  if (setupRun.code === 0 && /restart-required/u.test(setupRun.stdout) && /plugin-data-root-added/u.test(setupRun.stdout)) {
    setupRun = await runProcess(setupEntry, { cwd: workspace, env: setupEnvironment, timeoutMs: 180_000, maxOutputBytes: 1024 * 1024 });
    setupAttempts = 2;
  }
  if (setupRun.code !== 0) {
    throw new Error(`the isolated production setup failed (${setupRun.code}): ${boundedErrorText(setupRun.stderr || setupRun.stdout)}`);
  }

  const roleStatusRun = await runProcess({ command: process.execPath, args: [join(installedRoot, 'skills', 'rescue', 'launcher.mjs'), 'role-status', 'rescue'] }, { cwd: workspace, env: { ...env, CODEX_THREAD_ID: sessionId }, timeoutMs: 60_000, maxOutputBytes: 256 * 1024 });
  if (roleStatusRun.code !== 0) throw new Error(`the isolated Role preflight failed (${roleStatusRun.code}): ${boundedErrorText(roleStatusRun.stderr || roleStatusRun.stdout)}`);
  const observedRoleStatus = /"status"\s*:\s*"([a-z-]+)"/u.exec(roleStatusRun.stdout)?.[1] ?? null;
  if (observedRoleStatus !== 'ready') throw new Error(`the isolated Role preflight did not reach ready (observed ${String(observedRoleStatus)}): ${boundedErrorText(roleStatusRun.stdout, 256)}`);

  let capVerified = null;
  if (capMs !== null) {
    const configAfterSetup = await readFile(join(codexHome, 'config.toml'), 'utf8');
    capVerified = new RegExp(`^background_terminal_max_timeout = ${String(capMs)}$`, 'mu').test(configAfterSetup);
    if (!capVerified) throw new Error(`the requested cap configuration (${String(capMs)}) did not survive the isolated production setup's configuration writes`);
  }
  return { sessionEstablished: true, launcherDescriptorPublished, setupAttempts, roleStatus: observedRoleStatus, capVerified };
}

/**
 * Apply the requested variant to the temporary installed artifacts and record
 * the provenance. Baseline keeps the installed instruction artifacts
 * byte-identical; candidate changes only the one waiting-policy paragraph in
 * the temporary named Role template and generic assignment skill.
 * @param {{ installedRoot: string, codexHome: string, prepared: ReturnType<typeof validateFixtureInput>, installRecord: Record<string, unknown>, credentialsCopied: boolean }} context
 */
async function applyVariantArtifacts({ installedRoot, codexHome, prepared, installRecord, credentialsCopied = false }) {
  const templatePath = join(installedRoot, 'agents', 'zcode-rescue.toml.template');
  const skillPath = join(installedRoot, 'skills', 'rescue', 'SKILL.md');
  /** @type {{ path: string, role: string, beforeSha256: string, afterSha256: string, mode: string }[]} */
  const appliedArtifacts = [];
  /** @type {{ path: string, label: string, before: string, after: string }[]} */
  const differences = [];

  /**
   * @param {string} path @param {string} role @param {string} label
   * @param {(source: string) => string} transform
   */
  const applyTo = async (path, role, label, transform) => {
    const before = await readFile(path, 'utf8');
    const metadata = await lstat(path);
    const after = transform(before);
    if (after !== before) await writeFile(path, after, 'utf8');
    appliedArtifacts.push({ path: role, role, beforeSha256: sha256(before), afterSha256: sha256(after), mode: fileMode(metadata) });
    if (before !== after) differences.push({ path: role, label, before: 'one waiting-policy paragraph', after: 'the candidate waiting-policy paragraph' });
    return { before, after };
  };

  /** @param {string} source */
  const candidateTransform = (source) => {
    const occurrences = source.split(ORIGINAL_WAITING_PARAGRAPH).length - 1;
    if (occurrences !== 1) {
      throw new Error(`The installed artifact must contain exactly one waiting-policy paragraph to change (found ${String(occurrences)}).`);
    }
    return source.replace(ORIGINAL_WAITING_PARAGRAPH, candidateWaitingParagraph(prepared.pollMs));
  };

  const templateApplied = await applyTo(templatePath, 'named-role-template', 'named Role template', prepared.variant === 'candidate' ? candidateTransform : (source) => source);
  const skillApplied = await applyTo(skillPath, 'generic-skill', 'generic assignment skill', prepared.variant === 'candidate' ? candidateTransform : (source) => source);

  let capConfiguration = null;
  if (prepared.capMs !== null) {
    const configPath = join(codexHome, 'config.toml');
    const before = await readFile(configPath, 'utf8').catch(() => '');
    // Top-level TOML keys must precede the first table header, so the cap is
    // prepended rather than appended.
    const after = `${CAP_CONFIGURATION_KEY} = ${String(prepared.capMs)}\n${before}`;
    await writeFile(configPath, after, { mode: 0o600 });
    capConfiguration = {
      capMs: prepared.capMs,
      placement: 'prepended top-level key in the fixture CODEX_HOME config.toml',
      beforeSha256: sha256(before),
      afterSha256: sha256(after),
    };
  }

  const renderedRole = renderManagedRescueRole({ template: templateApplied.after, pluginRoot: installedRoot });
  const baselineRole = renderManagedRescueRole({ template: templateApplied.before, pluginRoot: installedRoot });
  const genericMessage = extractGenericMessage(skillApplied.after);
  const baselineGenericMessage = extractGenericMessage(skillApplied.before);

  return {
    variant: prepared.variant,
    pollMs: prepared.pollMs,
    sourceSha: prepared.sourceSha,
    pluginVersion: typeof installRecord.pluginVersion === 'string' && installRecord.pluginVersion.length > 0
      ? installRecord.pluginVersion
      : basename(installedRoot),
    ownedCleanSourceWorktree: null,
    credentialsCopied,
    isolatedSetup: /** @type {Record<string, unknown> | null} */ (null),
    appliedArtifacts,
    differences,
    capConfiguration,
    renderedNamedRoleSha256: sha256(renderedRole),
    baselineNamedRoleSha256: sha256(baselineRole),
    genericMessageSha256: sha256(genericMessage),
    baselineGenericMessageSha256: sha256(baselineGenericMessage),
  };
}

/**
 * Exact process-identity discipline reused by the driver's bounded host
 * lifecycle: a process is signalled only after its PID, parent PID, start
 * identity, and fake-ZCode nonce environment marker were all re-verified. A
 * stale, reparented, restarted, or nonce-mismatched PID is never signalled.
 */
const FAKE_ZCODE_NONCE_VARIABLE = 'FAKE_ZCODE_PROCESS_NONCE';

/** @param {string} nonce */
export function validateProcessNonce(nonce) {
  if (typeof nonce !== 'string' || !/^[a-f0-9]{64}$/u.test(nonce)) throw new Error('the exact fake-ZCode process nonce mismatch');
}

/**
 * Validate one fake-ZCode process marker file record.
 * @param {unknown} marker @param {string} expectedNonce
 * @returns {{ pid: number, ppid: number, nonce: string }}
 */
export function validateProcessMarker(marker, expectedNonce) {
  validateProcessNonce(expectedNonce);
  if (!marker || typeof marker !== 'object'
    || !Number.isSafeInteger(/** @type {any} */ (marker).pid) || /** @type {any} */ (marker).pid <= 0
    || !Number.isSafeInteger(/** @type {any} */ (marker).ppid) || /** @type {any} */ (marker).ppid <= 0
    || /** @type {any} */ (marker).nonce !== expectedNonce) {
    // Marker CORRUPTION (malformed PID or mismatched nonce) is distinct from a
    // confirmed absence: corruption is recorded as incomplete cleanup and the
    // unverified PID is never signalled.
    /** @type {any} */ const corruption = new Error('the exact fake-ZCode process marker identity is invalid');
    corruption.code = 'ZCODE_SHELL_WAIT_MARKER_INVALID';
    throw corruption;
  }
  return { pid: /** @type {any} */ (marker).pid, ppid: /** @type {any} */ (marker).ppid, nonce: expectedNonce };
}

/** @param {number} pid */
async function readMacProcessStart(pid) {
  const result = await runProcess({ command: 'ps', args: ['-o', 'pid=', '-o', 'ppid=', '-o', 'lstart=', '-p', String(pid)] }, { timeoutMs: 2_000, maxOutputBytes: 4 * 1024 });
  if (result.code !== 0 || !result.stdout.trim()) return undefined;
  const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/u.exec(result.stdout);
  if (!match || Number(match[1]) !== pid || !Number.isSafeInteger(Number(match[2])) || Number(match[2]) <= 0) {
    throw new Error('the exact fake-ZCode process identity could not be parsed');
  }
  return { pid, ppid: Number(match[2]), startIdentity: match[3] };
}

/** @param {number} pid */
async function readLinuxProcessStart(pid) {
  const { readFile: read } = await import('node:fs/promises');
  let statText;
  try { statText = await read(`/proc/${pid}/stat`, 'utf8'); } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return undefined;
    throw error;
  }
  const close = statText.lastIndexOf(')');
  const fields = close < 0 ? [] : statText.slice(close + 2).trim().split(/\s+/u);
  const observedPid = Number(statText.slice(0, statText.indexOf(' ')));
  const ppid = Number(fields[1]);
  const startTicks = fields[19];
  if (observedPid !== pid || !Number.isSafeInteger(ppid) || ppid <= 0 || !/^\d+$/u.test(startTicks ?? '')) {
    throw new Error('the exact fake-ZCode process identity could not be parsed');
  }
  return { pid: observedPid, ppid, startIdentity: `proc:${startTicks}` };
}

/**
 * Read one process environment marker. Returns 'gone' when the process no
 * longer exists, 'mismatch' when a live process does not carry the expected
 * nonce (an identity change, never silently accepted), and 'present' on an
 * exact nonce match.
 * @param {number} pid @param {string} expectedNonce @param {string} nonceVariable
 * @returns {Promise<'present' | 'mismatch' | 'gone'>}
 */
async function readProcessEnvironmentMarker(pid, expectedNonce, nonceVariable) {
  if (process.platform === 'linux') {
    const { readFile: read } = await import('node:fs/promises');
    let environ;
    try { environ = await read(`/proc/${pid}/environ`, 'utf8'); } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return 'gone';
      throw error;
    }
    return environ.split('\0').includes(`${nonceVariable}=${expectedNonce}`) ? 'present' : 'mismatch';
  }
  const command = await runProcess({ command: 'ps', args: ['eww', '-o', 'command=', '-p', String(pid)] }, { timeoutMs: 2_000, maxOutputBytes: 64 * 1024 });
  if (command.code !== 0 || !command.stdout.trim()) return 'gone';
  return command.stdout.split(/\s+/u).includes(`${nonceVariable}=${expectedNonce}`) ? 'present' : 'mismatch';
}

/**
 * Inspect one exact process identity (double-read so a racing exit or restart
 * is detected, never silently accepted). The returned shape carries the nonce
 * under the single canonical `nonce` field shared by capture, re-verification,
 * and termination.
 * @param {number} pid @param {string} expectedNonce @param {string} [nonceVariable]
 * @returns {Promise<{ pid: number, ppid: number, startIdentity: string, nonce: string } | undefined>}
 */
export async function inspectVerifiedProcessIdentity(pid, expectedNonce, nonceVariable = FAKE_ZCODE_NONCE_VARIABLE) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('the exact fake-ZCode PID is invalid');
  validateProcessNonce(expectedNonce);
  if (typeof nonceVariable !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/u.test(nonceVariable)) {
    throw new Error('the exact fake-ZCode process nonce marker is invalid');
  }
  const readStart = process.platform === 'linux' ? readLinuxProcessStart : readMacProcessStart;
  const before = await readStart(pid);
  if (!before) return undefined;
  const markerState = await readProcessEnvironmentMarker(pid, expectedNonce, nonceVariable);
  if (markerState === 'mismatch') throw new Error('the exact fake-ZCode process identity changed');
  if (markerState === 'gone') return undefined;
  const after = await readStart(pid);
  if (!after) return undefined;
  if (before.ppid !== after.ppid || before.startIdentity !== after.startIdentity) {
    throw new Error('the exact fake-ZCode process identity changed');
  }
  return { ...after, nonce: expectedNonce };
}

/**
 * Capture one exact process identity from a fake-ZCode process marker file:
 * the single shared entry point for the held-run lifecycle so capture,
 * re-verification, and termination all speak the same nonce-bearing shape.
 * @param {string} processPath @param {string} processNonce
 * @returns {Promise<{ pid: number, ppid: number, startIdentity: string, nonce: string }>}
 */
export async function captureVerifiedProcessIdentity(processPath, processNonce) {
  const { readFile: read } = await import('node:fs/promises');
  /** @param {string} code @param {string} message @returns {Error} */
  const coded = (code, message) => /** @type {any} */ (Object.assign(new Error(message), { code }));
  let markerBytes;
  try {
    markerBytes = await read(processPath, 'utf8');
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') {
      throw coded('ZCODE_SHELL_WAIT_MARKER_ABSENT', 'the exact fake-ZCode process marker never appeared (confirmed absence; nothing to signal)');
    }
    throw coded('ZCODE_SHELL_WAIT_MARKER_INVALID', `the exact fake-ZCode process marker could not be read: ${/** @type {Error} */ (error).message}`);
  }
  // The marker invariant: the file exists WITH its JSON payload only after fake
  // ZCode actually launched. A zero-byte marker (e.g. pre-created empty by the
  // harness before the host launched, then the host exited early) is a
  // CONFIRMED ABSENCE — no fake process ever wrote its identity — never
  // marker corruption.
  if (markerBytes.trim() === '') {
    throw coded('ZCODE_SHELL_WAIT_MARKER_ABSENT', 'the exact fake-ZCode process marker is empty: no fake process ever launched (confirmed absence; nothing to signal)');
  }
  let marker;
  try {
    marker = validateProcessMarker(JSON.parse(markerBytes), processNonce);
  } catch (error) {
    throw /** @type {any} */ (error)?.code === 'ZCODE_SHELL_WAIT_MARKER_INVALID'
      ? error
      : coded('ZCODE_SHELL_WAIT_MARKER_INVALID', `the exact fake-ZCode process marker is corrupt: ${error instanceof Error ? error.message : String(error)}`);
  }
  const observed = await inspectVerifiedProcessIdentity(marker.pid, processNonce);
  if (!observed) throw coded('ZCODE_SHELL_WAIT_MARKER_ABSENT', 'the exact fake-ZCode process exited before identity capture');
  if (observed.ppid !== marker.ppid) throw coded('ZCODE_SHELL_WAIT_MARKER_INVALID', 'the exact fake-ZCode parent identity mismatch');
  return observed;
}

/**
 * Terminate one exact process after re-verifying its identity; escalate to
 * SIGKILL only while the identity still matches, verify exit after every
 * signal within a bounded deadline, and return an explicit outcome: a thrown
 * signal is never a success while the process is still live, and a process
 * that survives SIGKILL verification is reported as a failure for the caller
 * to record.
 * @param {{ pid: number, ppid: number, nonce: string, startIdentity: string }} identity
 * @param {{ readIdentity?: (expected: unknown) => Promise<unknown>, kill?: (pid: number, signal: NodeJS.Signals) => boolean, waitForExit?: (identity: unknown, phase: 'terminate' | 'kill') => Promise<void> }} [dependencies]
 * @returns {Promise<TerminationOutcome>}
 */
export async function terminateVerifiedProcess(identity, dependencies = {}) {
  const readIdentity = dependencies.readIdentity ?? (async (expected) => inspectVerifiedProcessIdentity(/** @type {any} */ (expected).pid, /** @type {any} */ (expected).nonce));
  const kill = dependencies.kill ?? ((pid, signal) => process.kill(pid, signal));
  const waitForExit = dependencies.waitForExit ?? (async (expected, phase) => {
    const deadline = Date.now() + (phase === 'kill' ? 5_000 : 2_000);
    while (Date.now() < deadline) {
      if (await readIdentity(expected) === undefined) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`the exact verified process remained alive during ${phase}`);
  });
  /** @type {TerminationOutcome} */
  const outcome = { attempted: false, signalled: null, exited: false, failure: null };
  // A disappeared target needs no signal and counts as exited; a live target
  // whose identity changed is never signalled and is reported as a failure.
  if (await readIdentity(identity) === undefined) {
    outcome.exited = true;
    return outcome;
  }
  if (!await verifyUnchanged(identity, readIdentity)) {
    outcome.failure = 'the exact fake-ZCode process identity changed before signalling';
    return outcome;
  }
  outcome.attempted = true;
  try {
    kill(identity.pid, 'SIGTERM');
    outcome.signalled = 'SIGTERM';
  } catch (error) {
    // A thrown signal is not a success while the process is still live.
    if (await readIdentity(identity) === undefined) {
      outcome.exited = true;
      return outcome;
    }
    outcome.failure = `SIGTERM could not be signalled (${error instanceof Error ? error.message : String(error)}) and the exact fake-ZCode process remains live`;
    return outcome;
  }
  try {
    await waitForExit(identity, 'terminate');
    outcome.exited = true;
    return outcome;
  } catch { /* escalate only the still-matching PID */ }
  if (!await verifyUnchanged(identity, readIdentity)) {
    const gone = await readIdentity(identity) === undefined;
    outcome.exited = gone;
    if (!gone) outcome.failure = 'the exact fake-ZCode process identity changed during termination';
    return outcome;
  }
  try {
    kill(identity.pid, 'SIGKILL');
    outcome.signalled = 'SIGKILL';
  } catch (error) {
    if (await readIdentity(identity) === undefined) {
      outcome.exited = true;
      return outcome;
    }
    outcome.failure = `SIGKILL could not be signalled (${error instanceof Error ? error.message : String(error)}) and the exact fake-ZCode process remains live`;
    return outcome;
  }
  try {
    await waitForExit(identity, 'kill');
    outcome.exited = true;
    return outcome;
  } catch {
    outcome.failure = 'the exact fake-ZCode process remained alive after SIGKILL exit verification';
    return outcome;
  }
}

/**
 * Re-verify one captured identity before any signal. Even when the injected
 * reader does not throw, a returned observation that differs in any field
 * (reparented, restarted, nonce changed) blocks the signal.
 * @param {{ pid: number, ppid: number, nonce: string, startIdentity: string }} identity
 * @param {(expected: unknown) => Promise<unknown>} readIdentity
 * @returns {Promise<boolean>} true only when the exact identity is still live
 */
async function verifyUnchanged(identity, readIdentity) {
  const observed = await readIdentity(identity);
  if (observed === undefined || observed === null) return false;
  const record = /** @type {any} */ (observed);
  if (record.pid !== identity.pid || record.ppid !== identity.ppid) return false;
  if (record.startIdentity !== identity.startIdentity) return false;
  if (record.nonce !== identity.nonce) return false;
  return true;
}

/**
 * Explicit termination outcome returned by terminateVerifiedProcess so the
 * caller can record exactly which cleanup obligation failed.
 * @typedef {{
 *   attempted: boolean,
 *   signalled: 'SIGTERM' | 'SIGKILL' | null,
 *   exited: boolean,
 *   failure: string | null,
 * }} TerminationOutcome
 */

/** Release one fake-ZCode completion gate. @param {string} gatePath */
export async function releaseCompletionGate(gatePath) {
  await writeFile(gatePath, 'release', 'utf8');
}

/**
 * @typedef {{
 *   sourceRoot: string,
 *   sourceSha: string,
 *   codexBinary: string,
 *   output: string,
 *   variant: 'baseline'|'candidate',
 *   capMs?: number | null,
 *   pollMs?: number,
 *   authSource?: string,
 * }} ShellWaitFixtureInput
 * @typedef {{
 *   buildSnapshot?: (context: { cleanSource: string, output: string, sourceSha: string, env: NodeJS.ProcessEnv }) => Promise<unknown>,
 *   installPlugin?: (context: { marketplace: string, codexHome: string, cleanSource: string, env: NodeJS.ProcessEnv, codexBinary: string }) => Promise<{ pluginVersion?: string } | void>,
 *   copyCredentials?: (context: { codexHome: string, authSource: string }) => Promise<{ copied?: boolean } | void>,
 *   removeOwnedWorktree?: () => Promise<void>,
 *   runSetup?: (context: { installedRoot: string, codexHome: string, dataRoot: string, workspace: string, temporary: string, env: NodeJS.ProcessEnv, codexBinary: string, capMs: number | null }) => Promise<Record<string, unknown>>,
 * }} ShellWaitFixtureDependencies
 * @typedef {{
 *   workspace: string,
 *   codexHome: string,
 *   installedRoot: string,
 *   env: NodeJS.ProcessEnv,
 *   dispose: () => Promise<void>,
 *   record: Record<string, unknown>,
 * }} ShellWaitFixtureHandle
 */
