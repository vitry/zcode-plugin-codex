#!/usr/bin/env node
// @ts-check
import process from 'node:process';
import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { runProcess } from './lib/process.mjs';
import { npmLaunch } from './lib/tool-launch.mjs';

const moduleRoot = fileURLToPath(new URL('..', import.meta.url));

export const REQUIRED_RESCUE_PAYLOAD = Object.freeze([
  'agents/zcode-rescue.toml.template',
  'skills/rescue/SKILL.md',
  'skills/rescue/launcher.mjs',
  'scripts/zcode-companion.mjs',
  'scripts/lib/invocation.mjs',
  'scripts/lib/job-control.mjs',
  'scripts/lib/public-text.mjs',
  'scripts/lib/rescue-binding.mjs',
  'scripts/lib/rescue-preparation.mjs',
  'scripts/lib/state.mjs',
  'scripts/lib/conversation-progress.mjs',
  'scripts/lib/managed-agent-role.mjs',
  'scripts/lib/plugin-data.mjs',
  'scripts/lib/rescue-launcher-command.mjs',
  'scripts/lib/progress.mjs',
  'hooks/subagent-hook.mjs',
  'hooks/lib/hook-state.mjs',
  'hooks/session-lifecycle-hook.mjs',
  'hooks/user-prompt-hook.mjs',
  'hooks/session-end-hook.mjs',
  'hooks/stop-review-gate-hook.mjs',
  'CHANGELOG.md',
  'README.md',
  'README.zh-CN.md',
  'SECURITY.md',
  'docs/adr/0013-bind-rescue-child-to-zcode-session.md',
]);

/** @param {{packageVersion:string,pluginVersion:string,sourceRef:string,sourceSha:string,releaseTag?:string,dependencyLock:{file:string,sha256:string}}} input */
export function validateReleaseIdentity(input) {
  const values = input && typeof input === 'object' ? input : /** @type {any} */ ({});
  const version = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
  const safeRef = typeof values.sourceRef === 'string' && values.sourceRef.length <= 512 && values.sourceRef.length > 0 && !hasControl(values.sourceRef);
  const dependencyLock = values.dependencyLock;
  if (!version.test(values.packageVersion) || values.pluginVersion !== values.packageVersion || !safeRef
    || typeof values.sourceSha !== 'string' || !/^[a-f0-9]{40}$/.test(values.sourceSha)
    || values.releaseTag !== undefined && values.releaseTag !== `v${values.packageVersion}`
    || !dependencyLock || !['npm-shrinkwrap.json', 'package-lock.json'].includes(dependencyLock.file)
    || typeof dependencyLock.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(dependencyLock.sha256)) {
    throw new Error('Invalid marketplace release identity.');
  }
  return {
    packageVersion: values.packageVersion,
    pluginVersion: values.pluginVersion,
    sourceRef: values.sourceRef,
    sourceSha: values.sourceSha,
    ...(values.releaseTag === undefined ? {} : { releaseTag: values.releaseTag }),
    dependencyLock: { file: dependencyLock.file, sha256: dependencyLock.sha256 },
  };
}

/** @param {{sourceRef:string,sourceSha:string,headSha:string,refSha:string}} input */
export function validateResolvedSource(input) {
  if (!input || typeof input !== 'object' || typeof input.sourceRef !== 'string' || !input.sourceRef
    || !/^[a-f0-9]{40}$/.test(input.sourceSha) || input.headSha !== input.sourceSha || input.refSha !== input.sourceSha) throw new Error('Invalid resolved marketplace source ref or SHA.');
  return { sourceRef: input.sourceRef, sourceSha: input.sourceSha };
}

/** @param {{root?:string,output:string,sourceRef:string,sourceSha:string,releaseTag?:string,npmExecPath?:string,env?:NodeJS.ProcessEnv}} input */
export async function buildMarketplaceSnapshot(input) {
  const root = await realpath(input.root ?? moduleRoot);
  const output = resolve(input.output);
  assertSeparatePaths(root, output);
  const npmExecPath = input.npmExecPath ?? input.env?.npm_execpath ?? process.env.npm_execpath ?? npmLaunch([], { env: input.env }).args[0];
  if (typeof npmExecPath !== 'string' || !isAbsolute(npmExecPath) || !/npm-cli\.js$/i.test(npmExecPath) || hasControl(npmExecPath)) throw new Error('A validated absolute npm CLI JavaScript path is required.');
  const publication = await preparePublication(root, output);
  let temporary;
  let sourceWorktree;
  let worktreeAttempted = false;
  try {
    await verifyCleanExactSource(root, input.sourceRef, input.sourceSha, input.env);
    temporary = await mkdtemp(join(tmpdir(), 'zcode-marketplace-build-'));
    sourceWorktree = join(temporary, 'exact source');
    worktreeAttempted = true;
    const added = await runGit(root, ['worktree', 'add', '--detach', sourceWorktree, input.sourceSha], input.env, 120_000);
    if (added.code !== 0) throw new Error(`git worktree add failed: ${added.stderr}`);
    await verifyIsolatedSource(sourceWorktree, input.sourceSha, input.env);
    const packages = join(temporary, 'packages'); const consumer = join(temporary, 'consumer');
    await Promise.all([mkdir(packages), mkdir(consumer)]);
    const npmTool = npmLaunch([], { env: { ...input.env, npm_execpath: npmExecPath } });
    const npmDescriptor = { command: npmTool.command, args: npmTool.args, target: npmExecPath };
    const locked = await readDependencyLock(sourceWorktree);
    const installedDependencies = await runProcess(npmDescriptor, { cwd: sourceWorktree, env: input.env, args: ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], timeoutMs: 300_000, maxOutputBytes: 4 * 1024 * 1024 });
    if (installedDependencies.code !== 0) throw new Error(`npm ci failed: ${installedDependencies.stderr}`);
    await verifyIsolatedSource(sourceWorktree, input.sourceSha, input.env);
    const packageJson = JSON.parse(await readFile(join(sourceWorktree, 'package.json'), 'utf8'));
    const pluginJson = JSON.parse(await readFile(join(sourceWorktree, '.codex-plugin', 'plugin.json'), 'utf8'));
    if (pluginJson.name !== 'zcode' || packageJson.name !== 'zcode-plugin-codex') throw new Error('Invalid marketplace plugin identity.');
    const identity = validateReleaseIdentity({
      packageVersion: packageJson.version,
      pluginVersion: pluginJson.version,
      sourceRef: input.sourceRef,
      sourceSha: input.sourceSha,
      releaseTag: input.releaseTag,
      dependencyLock: locked.provenance,
    });
    const packed = await runProcess(npmDescriptor, { cwd: sourceWorktree, env: input.env, args: ['pack', '--json', '--pack-destination', packages], timeoutMs: 120_000, maxOutputBytes: 2 * 1024 * 1024 });
    if (packed.code !== 0) throw new Error(`npm pack failed: ${packed.stderr}`);
    const records = JSON.parse(packed.stdout); const filename = records?.[0]?.filename;
    if (typeof filename !== 'string' || !filename.endsWith('.tgz')) throw new Error('npm pack did not return one package filename.');
    await writeFile(join(consumer, 'package.json'), JSON.stringify({ name: 'zcode-marketplace-snapshot-builder', private: true }), { mode: 0o600 });
    const installed = await runProcess(npmDescriptor, { cwd: consumer, env: input.env, args: ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', join(packages, filename)], timeoutMs: 120_000, maxOutputBytes: 2 * 1024 * 1024 });
    if (installed.code !== 0) throw new Error(`production package install failed: ${installed.stderr}`);
    const installedPluginRoot = join(consumer, 'node_modules', packageJson.name);
    await verifyQualifiedRescuePayload(installedPluginRoot);
    await verifyLockedRuntimePayload(installedPluginRoot, locked.json);
    await mkdir(join(publication.staging, '.agents', 'plugins'), { recursive: true });
    await cp(join(sourceWorktree, 'marketplace', '.agents', 'plugins', 'marketplace.json'), join(publication.staging, '.agents', 'plugins', 'marketplace.json'));
    await writeFile(join(publication.staging, '.agents', 'plugins', 'provenance.json'), `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o644 });
    await mkdir(join(publication.staging, 'plugins'), { recursive: true });
    await cp(installedPluginRoot, join(publication.staging, 'plugins', pluginJson.name), { recursive: true });
    await removeIsolatedWorktree(root, sourceWorktree, input.env);
    worktreeAttempted = false;
    await rm(temporary, { recursive: true, force: true });
    temporary = undefined;
    await publication.publish();
    return { output, plugin: join(output, 'plugins', pluginJson.name), identity };
  } catch (error) {
    let cleanupError;
    if (worktreeAttempted && sourceWorktree) {
      try { await removeIsolatedWorktree(root, sourceWorktree, input.env); }
      catch (failure) { cleanupError = failure; }
    }
    if (temporary) await rm(temporary, { recursive: true, force: true }).catch((failure) => { cleanupError ??= failure; });
    await publication.cleanup().catch((failure) => { cleanupError ??= failure; });
    if (cleanupError) throw new AggregateError([error, cleanupError], 'Marketplace build and isolated staging cleanup failed.');
    throw error;
  }
}

/** @param {string} root @param {string} sourceRef @param {string} sourceSha @param {NodeJS.ProcessEnv|undefined} env */
async function verifyCleanExactSource(root, sourceRef, sourceSha, env) {
  const [head, ref, status] = await Promise.all([
    runGit(root, ['rev-parse', 'HEAD'], env),
    runGit(root, ['rev-parse', '--verify', '--end-of-options', `${sourceRef}^{commit}`], env),
    runGit(root, ['status', '--porcelain=v1', '--untracked-files=all'], env, 30_000, 1024 * 1024),
  ]);
  if (head.code !== 0 || ref.code !== 0) throw new Error('Could not resolve marketplace source ref and SHA.');
  validateResolvedSource({ sourceRef, sourceSha, headSha: head.stdout.trim(), refSha: ref.stdout.trim() });
  if (status.code !== 0) throw new Error('Could not verify that the marketplace source tree is clean.');
  if (status.stdout.length !== 0) throw new Error('Marketplace source tree must be clean, including tracked and untracked files.');
}

/** @param {string} sourceWorktree @param {string} sourceSha @param {NodeJS.ProcessEnv|undefined} env */
async function verifyIsolatedSource(sourceWorktree, sourceSha, env) {
  const [head, status] = await Promise.all([
    runGit(sourceWorktree, ['rev-parse', 'HEAD'], env),
    runGit(sourceWorktree, ['status', '--porcelain=v1', '--untracked-files=all'], env),
  ]);
  if (head.code !== 0 || head.stdout.trim() !== sourceSha || status.code !== 0 || status.stdout.length !== 0) throw new Error('Detached marketplace source staging did not match the exact clean source SHA.');
}

/** @param {string} sourceWorktree */
async function readDependencyLock(sourceWorktree) {
  for (const file of ['npm-shrinkwrap.json', 'package-lock.json']) {
    const path = join(sourceWorktree, file);
    const metadata = await lstat(path).catch((error) => { if (error?.code === 'ENOENT') return null; throw error; });
    if (!metadata) continue;
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('Dependency lock must be a regular file in the exact source checkout.');
    const bytes = await readFile(path);
    return {
      json: JSON.parse(bytes.toString('utf8')),
      provenance: { file, sha256: createHash('sha256').update(bytes).digest('hex') },
    };
  }
  throw new Error('The exact marketplace source is missing npm-shrinkwrap.json or package-lock.json.');
}

/** @param {string} pluginRoot @param {any} lock */
async function verifyLockedRuntimePayload(pluginRoot, lock) {
  const packages = lock?.packages;
  const rootDependencies = packages?.['']?.dependencies;
  if (!packages || !rootDependencies || !Object.hasOwn(rootDependencies, 'fs-native-extensions')) throw new Error('Dependency lock is missing required fs-native-extensions runtime metadata.');
  const pending = ['fs-native-extensions']; const checked = new Set();
  while (pending.length > 0) {
    const name = /** @type {string} */ (pending.shift());
    if (checked.has(name)) continue;
    checked.add(name);
    const locked = packages[`node_modules/${name}`];
    if (!locked || typeof locked.version !== 'string') throw new Error(`Dependency lock is missing an exact runtime entry for ${name}.`);
    const directory = join(pluginRoot, 'node_modules', name);
    const directoryMetadata = await lstat(directory).catch(() => null);
    const packagePath = join(directory, 'package.json');
    const packageMetadata = await lstat(packagePath).catch(() => null);
    if (!directoryMetadata?.isDirectory() || directoryMetadata.isSymbolicLink() || !packageMetadata?.isFile() || packageMetadata.isSymbolicLink()) throw new Error(`Marketplace payload is missing locked bundled runtime package: ${name}`);
    const installed = JSON.parse(await readFile(packagePath, 'utf8'));
    if (installed.name !== name || installed.version !== locked.version) throw new Error(`Marketplace bundled runtime package does not match the dependency lock: ${name}`);
    for (const dependency of Object.keys(locked.dependencies ?? {})) pending.push(dependency);
  }
}

/** @param {string} root @param {string} sourceWorktree @param {NodeJS.ProcessEnv|undefined} env */
async function removeIsolatedWorktree(root, sourceWorktree, env) {
  const removed = await runGit(root, ['worktree', 'remove', '--force', sourceWorktree], env, 120_000, 1024 * 1024);
  if (removed.code !== 0) {
    await rm(sourceWorktree, { recursive: true, force: true });
    await runGit(root, ['worktree', 'prune', '--expire=now'], env, 120_000, 1024 * 1024);
  }
  const listed = await runGit(root, ['worktree', 'list', '--porcelain'], env, 30_000, 1024 * 1024);
  if (listed.code !== 0 || registeredWorktreePaths(listed.stdout).some((path) => resolve(path) === resolve(sourceWorktree))) throw new Error('Could not remove detached marketplace source worktree registration.');
}

/** @param {string} output */
function registeredWorktreePaths(output) {
  return output.split(/\r?\n/).filter((line) => line.startsWith('worktree ')).map((line) => line.slice('worktree '.length));
}

/** @param {string} cwd @param {string[]} args @param {NodeJS.ProcessEnv|undefined} env @param {number} [timeoutMs] @param {number} [maxOutputBytes] */
function runGit(cwd, args, env, timeoutMs = 10_000, maxOutputBytes = 4096) {
  return runProcess({ command: 'git', args: [] }, { cwd, env, args, timeoutMs, maxOutputBytes });
}

/** @param {string} root @param {string} output */
async function preparePublication(root, output) {
  const parent = dirname(output); const missing = []; let nearest = parent;
  while (true) {
    const metadata = await lstat(nearest).catch((error) => { if (error?.code === 'ENOENT') return null; throw error; });
    if (metadata) {
      if (metadata.isSymbolicLink()) throw new Error('Marketplace snapshot output ancestor must not be a symlink; canonical output must remain outside the source root.');
      if (!metadata.isDirectory()) throw new Error('Marketplace snapshot output parent must be a directory.');
      break;
    }
    const next = dirname(nearest);
    if (next === nearest) throw new Error('Marketplace snapshot output has no existing parent directory.');
    missing.unshift(basename(nearest)); nearest = next;
  }
  const canonicalNearest = await realpath(nearest);
  const canonicalOutput = join(canonicalNearest, ...missing, basename(output));
  assertSeparatePaths(root, canonicalOutput);
  let createdParent = canonicalNearest;
  for (const segment of missing) {
    createdParent = join(createdParent, segment);
    await mkdir(createdParent);
    const metadata = await lstat(createdParent);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error('Marketplace snapshot output ancestor must be a real directory.');
  }
  const canonicalParent = await realpath(createdParent);
  assertSeparatePaths(root, join(canonicalParent, basename(output)));
  await assertAbsentOutput(output);
  const staging = await mkdtemp(join(canonicalParent, '.zcode-marketplace-staging-'));
  let published = false;
  return {
    staging,
    async publish() {
      const currentParent = await realpath(parent);
      if (currentParent !== canonicalParent) throw new Error('Marketplace snapshot output parent changed during build.');
      const metadata = await lstat(parent);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error('Marketplace snapshot output ancestor changed during build.');
      assertSeparatePaths(root, join(currentParent, basename(output)));
      await assertAbsentOutput(output);
      await rename(staging, output); published = true;
    },
    async cleanup() { if (!published) await rm(staging, { recursive: true, force: true }); },
  };
}

/** @param {string} output */
async function assertAbsentOutput(output) {
  const metadata = await lstat(output).catch((error) => { if (error?.code === 'ENOENT') return null; throw error; });
  if (metadata?.isSymbolicLink()) throw new Error('Marketplace snapshot output leaf must not be a symlink.');
  if (metadata) throw new Error('Marketplace snapshot output must not already exist.');
}

/** @param {string} root @param {string} output */
function assertSeparatePaths(root, output) {
  if (contains(relative(root, output)) || contains(relative(output, root))) throw new Error('Marketplace snapshot output must be outside the source root.');
}

/** @param {string} value */
function contains(value) { return value === '' || value !== '..' && !value.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(value); }

/** @param {string} pluginRoot */
async function verifyQualifiedRescuePayload(pluginRoot) {
  for (const relativePath of REQUIRED_RESCUE_PAYLOAD) {
    const metadata = await lstat(join(pluginRoot, relativePath)).catch(() => null);
    if (!metadata?.isFile() || metadata.isSymbolicLink()) throw new Error(`Marketplace payload is missing required file: ${relativePath}`);
  }
  const template = await readFile(join(pluginRoot, REQUIRED_RESCUE_PAYLOAD[0]), 'utf8');
  if (!template.startsWith('developer_instructions = """')) throw new Error('Marketplace payload has an invalid Rescue Role template.');
  const obsoletePath = join(pluginRoot, 'agents', 'zcode-rescue.md');
  const obsolete = await lstat(obsoletePath).then(() => true, (error) => {
    if (error?.code === 'ENOENT') return false;
    throw error;
  });
  if (obsolete) throw new Error('Marketplace payload contains the obsolete Markdown Rescue forwarder.');
}

/** @param {string[]} argv */
function parseCli(argv) {
  /** @type {Record<string,string>} */ const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]; const value = argv[index + 1];
    if (!['--output', '--source-ref', '--source-sha', '--release-tag'].includes(key) || value === undefined || Object.hasOwn(values, key)) throw new Error('Invalid marketplace snapshot arguments.');
    values[key] = value;
  }
  if (!values['--output'] || !values['--source-ref'] || !values['--source-sha']) throw new Error('Marketplace snapshot output, source ref, and source SHA are required.');
  return { output: values['--output'], sourceRef: values['--source-ref'], sourceSha: values['--source-sha'], ...(values['--release-tag'] ? { releaseTag: values['--release-tag'] } : {}) };
}

/** @param {string} value */
function hasControl(value) { return [...value].some((character) => { const code = character.codePointAt(0) ?? 0; return code <= 31 || code === 127; }); }

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await buildMarketplaceSnapshot({ ...parseCli(process.argv.slice(2)), env: process.env });
}
