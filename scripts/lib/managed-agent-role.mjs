import { createHash } from 'node:crypto';
import { lstat, readFile, realpath, unlink } from 'node:fs/promises';
import { join, posix, resolve, win32 } from 'node:path';

import { PluginError } from './errors.mjs';
import { atomicWriteJson, atomicWritePrivateFile, withFileLock } from './fs.mjs';
import { escapeRescueLauncherCommandForToml, renderRescueLauncherCommand } from './rescue-launcher-command.mjs';

export const MANAGED_ROLE_NAME = 'zcode-rescue';
export const MANAGED_ROLE_SCHEMA_VERSION = 1;
export const MANAGED_ROLE_RECEIPT_SCHEMA_VERSION = '1.0.0';
export const MANAGED_ROLE_DESCRIPTION = 'Runs the fixed ZCode Rescue forwarder in an isolated Codex subagent.';

const PLACEHOLDER = '{{RESCUE_LAUNCHER_COMMAND}}';
const MANAGED_SETUP_LEAF_PATHS = new Set(['features.hooks', 'hooks.state']);
const MAX_ADDITIONAL_LEAVES = MANAGED_SETUP_LEAF_PATHS.size;

/** @typedef {Record<string, any>} AnyRecord */
/** @typedef {'prepared'|'role-written'|'config-written'|'receipt-prepared'} ManagedRoleJournalPhase */
/** @typedef {{schemaVersion:'1.0.0',roleName:string,plugin:{identity:string,version:string,root:string},configTarget:{filePath:string},role:{path:string,schemaVersion:1,sha256:string},mutatedAt:string}} ManagedRoleReceipt */
/** @typedef {{schemaVersion:1|2,phase:ManagedRoleJournalPhase,rolePath:string,intendedSha256:string,roleExisted:boolean,previousRoleBase64?:string,receiptExisted:boolean,previousReceiptBase64?:string,previousRegistration:AnyRecord,deletesLegacyMetadata?:boolean,previousMetadata?:AnyRecord,previousAdditional?:AnyRecord[],desiredAdditional?:AnyRecord[],configVersion?:string,intendedReceiptSha256?:string,intendedReceiptBase64?:string}} ManagedRoleJournal */

/** @param {string} dataRoot */
export function managedRolePaths(dataRoot) {
  const directory = join(resolve(dataRoot), 'agent-roles');
  return {
    rolePath: join(directory, `${MANAGED_ROLE_NAME}.toml`),
    receiptPath: join(directory, `${MANAGED_ROLE_NAME}.receipt.json`),
    transactionPath: join(directory, `${MANAGED_ROLE_NAME}.transaction.json`),
    lockPath: join(directory, 'lock'),
  };
}

/** @param {{template:string,pluginRoot:string}} input */
export function renderManagedRescueRole({ template, pluginRoot }) {
  if (typeof pluginRoot !== 'string' || !pluginRoot || hasControl(pluginRoot)
    || !posix.isAbsolute(pluginRoot) && !win32.isAbsolute(pluginRoot)) {
    throw roleError('MANAGED_ROLE_ROOT_INVALID', 'The managed Role plugin root must be an absolute control-free path.');
  }
  if (typeof template !== 'string' || !template.trim()
    || (template.match(/\{\{RESCUE_LAUNCHER_COMMAND\}\}/g) ?? []).length !== 4
    || /\{\{(?!RESCUE_LAUNCHER_COMMAND\}\})[^}]+\}\}/.test(template)) {
    throw roleError('MANAGED_ROLE_TEMPLATE_INVALID', 'The managed Role template contains unsupported placeholders.');
  }
  const windows = win32.isAbsolute(pluginRoot) && !posix.isAbsolute(pluginRoot);
  let command;
  try {
    const launcherPath = windows ? win32.join(pluginRoot, 'skills', 'rescue', 'launcher.mjs') : posix.join(pluginRoot, 'skills', 'rescue', 'launcher.mjs');
    command = renderRescueLauncherCommand(launcherPath, { platform: windows ? 'win32' : 'linux' });
  } catch (cause) {
    throw roleError('MANAGED_ROLE_ROOT_INVALID', 'The managed Role plugin root cannot produce a safe launcher command.', {}, cause);
  }
  return template.replaceAll(PLACEHOLDER, escapeRescueLauncherCommandForToml(command, { platform: windows ? 'win32' : 'linux' }));
}

/** @param {any} input */
export async function inspectManagedRescueRole(input) {
  const prepared = await prepare(input, false);
  if (!prepared.safe) return result('unsupported', prepared.paths.rolePath, prepared.reason);
  return inspectPrepared(prepared, input.config);
}

/** @param {any} input */
export async function reconcileManagedRescueRole(input) {
  validateReconcileInput(input);
  const prepared = await prepare(input, true);
  if (!prepared.safe) throw roleError('MANAGED_ROLE_PATH_UNSAFE', prepared.reason ?? 'The managed Role path is unsafe.');
  return withFileLock(prepared.paths.lockPath, async () => {
    const recovered = await recoverInterruptedTransaction(prepared, input);
    let activeInput = input;
    if (recovered) {
      const config = await input.readConfig();
      const expectedVersion = selectedTargetVersion(config, input.configTarget.filePath);
      if (!validConfigRead(config) || expectedVersion === null) {
        throw rollbackError(prepared, input, [input.configTarget.filePath], 'Recovered managed Role state, but the refreshed Codex configuration is invalid.');
      }
      activeInput = { ...input, config, configTarget: { ...input.configTarget, expectedVersion } };
    }
    const inspection = await inspectPrepared(prepared, activeInput.config);
    if (inspection.status === 'ready') return { status: 'ready', changed: false, rolePath: prepared.paths.rolePath };
    if (inspection.status === 'restart-required') return { status: 'restart-required', changed: false, rolePath: prepared.paths.rolePath };
    if (!['install-required', 'upgrade-required'].includes(inspection.status)) {
      const conflicts = inspection.conflicts ?? [];
      throw new PluginError('MANAGED_ROLE_CONFLICT', `Managed Rescue Role reconciliation refused status: ${inspection.status}.`, {
        category: 'configuration',
        remedy: conflicts.length
          ? `Remove or rename the ${MANAGED_ROLE_NAME} definition in ${conflicts.map((conflict) => `${conflict.layerType} layer ${conflict.filePath}`).join(', ')}, then rerun $zcode:setup.`
          : 'Resolve the managed Agent Role conflict and rerun $zcode:setup.',
        details: { status: inspection.status, rolePath: prepared.paths.rolePath, ...(conflicts.length ? { conflicts } : {}) },
      });
    }

    const previousRole = await optionalBytes(prepared.paths.rolePath);
    const previousReceipt = await optionalBytes(prepared.paths.receiptPath);
    const receipt = await optionalJson(prepared.paths.receiptPath);
    const legacyReceipt = isLegacyReceipt(receipt);
    const legacyMetadata = legacyReceipt ? targetMetadata(activeInput.config, activeInput.configTarget.filePath) : { present: false };
    if (legacyReceipt && legacyMetadata.present && legacyMetadata.value !== false) {
      throw new PluginError('MANAGED_ROLE_CONFLICT', 'The proven legacy managed Role metadata leaf has drifted and will not be removed.', {
        category: 'configuration',
        remedy: 'Resolve the legacy spawn-metadata leaf and rerun $zcode:setup.',
        details: { status: 'drift', rolePath: prepared.paths.rolePath },
      });
    }
    const deletesLegacyMetadata = legacyReceipt && legacyMetadata.present;
    const previousRegistration = targetRegistration(activeInput.config, activeInput.configTarget.filePath);
    const previousAdditional = (activeInput.additionalEdits ?? []).map((/** @type {any} */ edit) => ({ keyPath: edit.keyPath, ...targetLeaf(activeInput.config, activeInput.configTarget.filePath, edit.keyPath) }));
    /** @type {ManagedRoleJournal} */
    const journal = {
      schemaVersion: 2,
      phase: 'prepared',
      rolePath: prepared.paths.rolePath,
      intendedSha256: /** @type {string} */ (prepared.digest),
      roleExisted: previousRole !== null,
      ...(previousRole === null ? {} : { previousRoleBase64: (previousRole ?? Buffer.alloc(0)).toString('base64') }),
      receiptExisted: previousReceipt !== null,
      ...(previousReceipt === null ? {} : { previousReceiptBase64: previousReceipt.toString('base64') }),
      previousRegistration,
      deletesLegacyMetadata,
      ...(deletesLegacyMetadata ? { previousMetadata: legacyMetadata } : {}),
      previousAdditional,
      desiredAdditional: (activeInput.additionalEdits ?? []).map((/** @type {any} */ edit) => ({ keyPath: edit.keyPath, value: edit.value })),
    };
    await atomicWriteJson(prepared.paths.transactionPath, journal);
    let configMutated = false;
    try {
      await atomicWritePrivateFile(prepared.paths.rolePath, /** @type {Buffer} */ (prepared.bytes));
      journal.phase = 'role-written';
      await atomicWriteJson(prepared.paths.transactionPath, journal);
      const edits = [
        ...(activeInput.additionalEdits ?? []),
        ...(deletesLegacyMetadata ? [{ keyPath: 'features.multi_agent_v2.hide_spawn_agent_metadata', value: null, mergeStrategy: 'upsert' }] : []),
        { keyPath: `agents.${MANAGED_ROLE_NAME}`, value: expectedRegistration(prepared.paths.rolePath), mergeStrategy: 'upsert' },
      ];
      const writeResult = await activeInput.batchWrite({
        edits,
        filePath: activeInput.configTarget.filePath,
        expectedVersion: activeInput.configTarget.expectedVersion,
        reloadUserConfig: true,
      });
      journal.phase = 'config-written';
      journal.configVersion = typeof writeResult?.version === 'string' && writeResult.version
        ? writeResult.version : activeInput.configTarget.expectedVersion;
      await atomicWriteJson(prepared.paths.transactionPath, journal);
      const current = await activeInput.readConfig();
      const verification = verifyPostWriteConfig(current, prepared.paths.rolePath, activeInput.configTarget.filePath, journal);
      if (verification !== null) throw roleError('MANAGED_ROLE_POST_WRITE_INVALID', verification);
      const selectedVersion = selectedTargetVersion(current, activeInput.configTarget.filePath);
      await activeInput.activate?.({
        config: current,
        writeResult,
        configTarget: activeInput.configTarget,
        selectedVersion,
        rolePath: prepared.paths.rolePath,
      });
      const intendedReceipt = makeReceipt(prepared, activeInput);
      const intendedReceiptBytes = Buffer.from(`${JSON.stringify(intendedReceipt, null, 2)}\n`);
      journal.phase = 'receipt-prepared';
      journal.intendedReceiptSha256 = sha256(intendedReceiptBytes);
      journal.intendedReceiptBase64 = intendedReceiptBytes.toString('base64');
      await atomicWriteJson(prepared.paths.transactionPath, journal);
      await activeInput.beforeReceiptCommit?.(intendedReceiptBytes);
      await atomicWritePrivateFile(prepared.paths.receiptPath, intendedReceiptBytes);
      await unlink(prepared.paths.transactionPath);
      return { status: 'ready', changed: true, rolePath: prepared.paths.rolePath };
    } catch (cause) {
      if (journal.phase !== 'prepared') configMutated = await classifyConfigMutation(activeInput, prepared, journal);
      const recovery = await rollback({ prepared, input: activeInput, journal, configMutated });
      if (!recovery.complete) {
        throw rollbackError(prepared, activeInput, [...recovery.remaining, prepared.paths.transactionPath], 'Managed Rescue Role reconciliation failed and rollback was incomplete.');
      }
      throw roleError('MANAGED_ROLE_RECONCILE_FAILED', 'Managed Rescue Role reconciliation failed and owned changes were rolled back.', {
        rolePath: prepared.paths.rolePath,
      }, cause);
    }
  });
}

/** @param {AnyRecord} prepared @param {AnyRecord} config */
async function inspectPrepared(prepared, config) {
  if (!validConfigRead(config)) return result('unsupported', prepared.paths.rolePath, 'Codex configuration layers are unavailable or contain Role load errors.');
  if (await exists(prepared.paths.transactionPath)) return result('restart-required', prepared.paths.rolePath, 'An interrupted managed Role transaction requires recovery.');
  const definitions = roleDefinitions(config);
  const projectDefinitions = definitions.filter((item) => item.type === 'project');
  if (projectDefinitions.length) return result('project-shadowed', prepared.paths.rolePath, undefined, conflictSources(config, projectDefinitions, prepared.configTarget.filePath));

  const effective = config?.config?.agents?.[MANAGED_ROLE_NAME];
  const receipt = await optionalJson(prepared.paths.receiptPath);
  const roleBytes = await optionalBytes(prepared.paths.rolePath);
  if (effective === undefined && receipt === null && roleBytes === null) return result('install-required', prepared.paths.rolePath);
  if (receipt !== null && receipt.configTarget?.filePath !== prepared.configTarget.filePath) return result('drift', prepared.paths.rolePath);
  const collision = nonTargetCollision(config, definitions, prepared.configTarget.filePath);
  if (collision !== null) return result(collision.status, prepared.paths.rolePath, undefined, collision.conflicts);
  if (receipt === null) {
    if (sameEffectiveRegistration(effective, prepared.paths.rolePath) || roleBytes !== null) return result('drift', prepared.paths.rolePath);
    return result('foreign-conflict', prepared.paths.rolePath);
  }
  if (!validReceiptBase(receipt, prepared.paths.rolePath, prepared.input.pluginIdentity)) return result('drift', prepared.paths.rolePath);
  const selectedRegistration = targetRegistration(config, prepared.configTarget.filePath);
  if (!selectedRegistration.present || !sameExactRegistration(selectedRegistration.value, prepared.paths.rolePath)) return result('drift', prepared.paths.rolePath);
  if (!sameEffectiveRegistration(effective, prepared.paths.rolePath)) return result('drift', prepared.paths.rolePath);
  if (roleBytes === null || sha256(roleBytes) !== receipt.role.sha256) return result('drift', prepared.paths.rolePath);
  if (isLegacyReceipt(receipt)) {
    const metadata = targetMetadata(config, prepared.configTarget.filePath);
    if (metadata.present && metadata.value !== false) return result('drift', prepared.paths.rolePath);
    return result('upgrade-required', prepared.paths.rolePath);
  }
  if (receipt.plugin.version !== prepared.input.pluginVersion
    || receipt.plugin.root !== prepared.pluginRoot
    || receipt.role.schemaVersion !== MANAGED_ROLE_SCHEMA_VERSION
    || receipt.role.sha256 !== prepared.digest) return result('upgrade-required', prepared.paths.rolePath);
  return result('ready', prepared.paths.rolePath);
}

/** @param {AnyRecord} input @param {boolean} requireSafe */
async function prepare(input, requireSafe) {
  validateCommonInput(input);
  const dataRoot = await canonicalExisting(input.dataRoot);
  const pluginRoot = await canonicalExisting(input.pluginRoot);
  const paths = managedRolePaths(dataRoot);
  const safety = await pathSafety(dataRoot, paths);
  if (requireSafe && !safety.safe) return { safe: false, reason: safety.reason, paths };
  const rendered = renderManagedRescueRole({ template: input.template, pluginRoot });
  const bytes = Buffer.from(rendered, 'utf8');
  return { safe: safety.safe, reason: safety.reason, paths, pluginRoot, bytes, digest: sha256(bytes), input, configTarget: input.configTarget };
}

/** @param {string} dataRoot @param {AnyRecord} paths */
async function pathSafety(dataRoot, paths) {
  try {
    // These checks reject static path confusion and cooperating lock/advisory
    // races. The 0700 plugin-data boundary assumes no hostile same-UID process;
    // Node and the bundled native module expose no cross-platform dirfd-relative
    // create/rename primitive that could bind every later write to this inode.
    const rootStats = await lstat(dataRoot);
    if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) return { safe: false, reason: 'The plugin data root is not a real directory.' };
    const roleDirectory = join(dataRoot, 'agent-roles');
    try {
      const directoryStats = await lstat(roleDirectory);
      if (directoryStats.isSymbolicLink() || !directoryStats.isDirectory()) return { safe: false, reason: 'The managed Role directory is a symlink or non-directory.' };
      if (await realpath(roleDirectory) !== roleDirectory) return { safe: false, reason: 'The managed Role directory escapes its canonical root.' };
    } catch (error) {
      if (!isCode(error, 'ENOENT')) throw error;
    }
    for (const path of [paths.rolePath, paths.receiptPath, paths.transactionPath]) {
      try { if ((await lstat(path)).isSymbolicLink()) return { safe: false, reason: `Managed Role path is a symlink: ${path}` }; }
      catch (error) { if (!isCode(error, 'ENOENT')) throw error; }
    }
    try {
      const lockStats = await lstat(paths.lockPath);
      if (lockStats.isSymbolicLink() || !lockStats.isDirectory()) return { safe: false, reason: `Managed Role lock path is unsafe: ${paths.lockPath}` };
      if (await realpath(paths.lockPath) !== paths.lockPath) return { safe: false, reason: `Managed Role lock path escapes its canonical root: ${paths.lockPath}` };
      const advisoryPath = join(paths.lockPath, 'advisory.lock');
      try { if ((await lstat(advisoryPath)).isSymbolicLink()) return { safe: false, reason: `Managed Role advisory lock is a symlink: ${advisoryPath}` }; }
      catch (error) { if (!isCode(error, 'ENOENT')) throw error; }
    } catch (error) {
      if (!isCode(error, 'ENOENT')) throw error;
    }
    return { safe: true };
  } catch (error) {
    return { safe: false, reason: `Could not validate managed Role paths: ${error instanceof Error ? error.message : 'unknown error'}` };
  }
}

/** @param {AnyRecord} prepared @param {AnyRecord} input */
async function recoverInterruptedTransaction(prepared, input) {
  const journal = await optionalJson(prepared.paths.transactionPath);
  if (journal === null) return false;
  if (!isManagedRoleJournal(journal, prepared.paths.rolePath, input.pluginIdentity, input.configTarget.filePath)) {
    throw rollbackError(prepared, input, [prepared.paths.transactionPath], 'The managed Role transaction journal is invalid and cannot prove rollback ownership.');
  }
  const currentRole = await optionalBytes(prepared.paths.rolePath);
  if (!roleBytesProven(currentRole, journal)) {
    throw rollbackError(prepared, input, [prepared.paths.rolePath, prepared.paths.transactionPath], 'The interrupted Role bytes are not proven to be owned.');
  }
  const configMutated = journal.phase === 'prepared' ? false : await classifyConfigMutation(input, prepared, journal);
  const recovery = await rollback({ prepared, input, journal, configMutated });
  if (!recovery.complete) throw rollbackError(prepared, input, [...recovery.remaining, prepared.paths.transactionPath], 'Could not recover the interrupted managed Role transaction.');
  return true;
}

/** @param {{prepared:AnyRecord,input:AnyRecord,journal:ManagedRoleJournal,configMutated:boolean}} input */
async function rollback({ prepared, input, journal, configMutated }) {
  const remaining = [];
  if (configMutated) {
    try {
      const currentConfig = await input.readConfig();
      if (!configLeavesOwned(currentConfig, input.configTarget.filePath, prepared.paths.rolePath, journal)) throw new Error('config leaves are not owned');
      const expectedVersion = selectedTargetVersion(currentConfig, input.configTarget.filePath);
      if (expectedVersion === null) throw new Error('current config version is unavailable');
      const writeResult = await input.batchWrite({
        edits: [
          ...(journal.previousAdditional ?? []).map((/** @type {any} */ entry) => ({ keyPath: entry.keyPath, value: entry.present ? entry.value : null, mergeStrategy: 'upsert' })),
          { keyPath: `agents.${MANAGED_ROLE_NAME}`, value: journal.previousRegistration.present ? journal.previousRegistration.value : null, mergeStrategy: 'upsert' },
          ...(journalOwnsMetadata(journal) ? [{
            keyPath: 'features.multi_agent_v2.hide_spawn_agent_metadata',
            value: journal.previousMetadata?.present ? journal.previousMetadata.value : null,
            mergeStrategy: 'upsert',
          }] : []),
        ],
        filePath: input.configTarget.filePath,
        expectedVersion,
        reloadUserConfig: true,
      });
      if (typeof writeResult?.version !== 'string' || !writeResult.version
        || typeof writeResult.filePath === 'string' && writeResult.filePath !== input.configTarget.filePath) throw new Error('rollback result is invalid');
      const restoredConfig = await input.readConfig();
      if (!validConfigRead(restoredConfig)
        || selectedTargetVersion(restoredConfig, input.configTarget.filePath) !== writeResult.version
        || !configLeavesMatchPrevious(restoredConfig, input.configTarget.filePath, journal)) throw new Error('rollback state is unproven');
    } catch {
      return {
        complete: false,
        remaining: [input.configTarget.filePath, prepared.paths.rolePath, prepared.paths.receiptPath],
      };
    }
  }
  try {
    const current = await optionalBytes(prepared.paths.rolePath);
    if (!roleBytesProven(current, journal)) throw new Error('unowned bytes');
    if (journal.roleExisted) await atomicWritePrivateFile(prepared.paths.rolePath, Buffer.from(/** @type {string} */ (journal.previousRoleBase64), 'base64'));
    else if (current !== null) await unlink(prepared.paths.rolePath);
  } catch { remaining.push(prepared.paths.rolePath); }
  try {
    const currentReceipt = await optionalBytes(prepared.paths.receiptPath);
    if (!receiptBytesProven(currentReceipt, journal)) throw new Error('unowned receipt');
    if (journal.receiptExisted) await atomicWritePrivateFile(prepared.paths.receiptPath, Buffer.from(/** @type {string} */ (journal.previousReceiptBase64), 'base64'));
    else await unlink(prepared.paths.receiptPath).catch((error) => { if (!isCode(error, 'ENOENT')) throw error; });
  } catch { remaining.push(prepared.paths.receiptPath); }
  if (!remaining.length) await unlink(prepared.paths.transactionPath).catch((error) => { if (!isCode(error, 'ENOENT')) throw error; });
  return { complete: remaining.length === 0, remaining };
}

/** @param {AnyRecord} input @param {AnyRecord} prepared @param {ManagedRoleJournal} journal */
async function detectAppliedConfig(input, prepared, journal) {
  let currentConfig;
  try { currentConfig = await input.readConfig(); } catch { return { state: 'incomplete', expectedVersion: null }; }
  if (!validConfigRead(currentConfig)) return { state: 'incomplete', expectedVersion: null };
  if (configLeavesOwned(currentConfig, input.configTarget.filePath, prepared.paths.rolePath, journal)) {
    const expectedVersion = selectedTargetVersion(currentConfig, input.configTarget.filePath);
    return expectedVersion === null ? { state: 'incomplete', expectedVersion: null } : { state: 'applied-exact', expectedVersion };
  }
  if (configLeavesMatchPrevious(currentConfig, input.configTarget.filePath, journal)) return { state: 'not-applied', expectedVersion: null };
  return { state: 'incomplete', expectedVersion: null };
}

/** @param {AnyRecord} input @param {AnyRecord} prepared @param {ManagedRoleJournal} journal */
async function classifyConfigMutation(input, prepared, journal) {
  const detected = await detectAppliedConfig(input, prepared, journal);
  if (detected.state === 'incomplete') throw incompleteAppliedConfigError(prepared, input);
  return detected.state === 'applied-exact';
}

/** @param {AnyRecord} config @param {string} filePath @param {ManagedRoleJournal} journal */
function configLeavesMatchPrevious(config, filePath, journal) {
  return leafMatches(targetRegistration(config, filePath), journal.previousRegistration)
    && (!journalOwnsMetadata(journal) || leafMatches(targetMetadata(config, filePath), /** @type {AnyRecord} */ (journal.previousMetadata)))
    && (journal.previousAdditional ?? []).every((entry) => leafMatches(targetLeaf(config, filePath, entry.keyPath), entry));
}

/** @param {AnyRecord} current @param {AnyRecord} expected */
function leafMatches(current, expected) {
  if (typeof expected?.present !== 'boolean' || current.present !== expected.present) return false;
  if (!expected.present) return true;
  if (!Object.hasOwn(expected, 'value') || expected.value === undefined) return false;
  return JSON.stringify(current.value) === JSON.stringify(expected.value);
}

/** @param {AnyRecord} prepared @param {AnyRecord} input */
function incompleteAppliedConfigError(prepared, input) {
  return rollbackError(prepared, input, [
    prepared.paths.rolePath,
    prepared.paths.receiptPath,
    input.configTarget.filePath,
    prepared.paths.transactionPath,
  ], 'Managed Rescue Role config state is mixed or unprovable; recovery evidence was preserved.');
}

/** @param {AnyRecord} config @param {string} filePath */
function selectedTargetVersion(config, filePath) {
  const version = (config.layers ?? []).find((/** @type {any} */ layer) => layer?.name?.file === filePath)?.version;
  return typeof version === 'string' && version ? version : null;
}

/** @param {AnyRecord} config @param {string} rolePath @param {string} targetFile */
function verifyEffectiveConfig(config, rolePath, targetFile) {
  if (!validConfigRead(config)) return 'Codex returned Role configuration errors after installation.';
  if (!sameEffectiveRegistration(config.config?.agents?.[MANAGED_ROLE_NAME], rolePath)) return 'The managed Role registration is overridden after installation.';
  const definitions = roleDefinitions(config);
  if (definitions.some((item) => item.type === 'project')) return 'A project Role shadows the managed Role.';
  if (definitions.some((item) => item.file !== targetFile)) return 'A higher-precedence Role overrides the managed Role.';
  return null;
}

/** @param {AnyRecord} config @param {string} rolePath @param {string} targetFile @param {ManagedRoleJournal} journal */
function verifyPostWriteConfig(config, rolePath, targetFile, journal) {
  const effectiveError = verifyEffectiveConfig(config, rolePath, targetFile);
  if (effectiveError !== null) return effectiveError;
  if (!configLeavesOwned(config, targetFile, rolePath, journal)) {
    return 'Codex did not persist every intended managed Role configuration leaf.';
  }
  return null;
}

/** @param {AnyRecord} prepared @param {AnyRecord} input @returns {ManagedRoleReceipt} */
function makeReceipt(prepared, input) {
  return {
    schemaVersion: MANAGED_ROLE_RECEIPT_SCHEMA_VERSION,
    roleName: MANAGED_ROLE_NAME,
    plugin: { identity: input.pluginIdentity, version: input.pluginVersion, root: prepared.pluginRoot },
    configTarget: { filePath: input.configTarget.filePath },
    role: { path: prepared.paths.rolePath, schemaVersion: MANAGED_ROLE_SCHEMA_VERSION, sha256: prepared.digest },
    mutatedAt: new Date(typeof input.now === 'function' ? input.now() : input.now ?? Date.now()).toISOString(),
  };
}

/** @param {AnyRecord} config */
function roleDefinitions(config) {
  const output = [];
  for (const [index, layer] of (config.layers ?? []).entries()) {
    const value = layer?.config?.agents?.[MANAGED_ROLE_NAME];
    if (value === undefined) continue;
    output.push({ type: layer?.name?.type, file: layer?.name?.file ?? null, value, index });
  }
  return output;
}

/** @param {AnyRecord} config @param {any[]} definitions @param {string} targetFile */
function nonTargetCollision(config, definitions, targetFile) {
  const foreign = definitions.filter((item) => item.file !== targetFile);
  if (!foreign.length) return null;
  const targetIndex = (config.layers ?? []).findIndex((/** @type {any} */ layer) => layer?.name?.file === targetFile);
  return {
    status: targetIndex >= 0 && foreign.some((item) => item.index > targetIndex) ? 'higher-precedence-conflict' : 'foreign-conflict',
    conflicts: conflictSources(config, foreign, targetFile),
  };
}

/** @param {AnyRecord} config @param {AnyRecord[]} definitions @param {string} targetFile */
function conflictSources(config, definitions, targetFile) {
  const targetIndex = (config.layers ?? []).findIndex((/** @type {any} */ layer) => layer?.name?.file === targetFile);
  return definitions.slice(0, 16).map((definition) => ({
    layerType: boundedLabel(definition.type, 'unknown'),
    filePath: boundedLabel(definition.file, 'unknown'),
    precedence: targetIndex >= 0 && definition.index < targetIndex ? 'lower' : 'higher',
  }));
}

/** @param {unknown} value @param {string} fallback */
function boundedLabel(value, fallback) { return typeof value === 'string' && value ? value.slice(0, 4096) : fallback; }

/** @param {AnyRecord} config @param {string} filePath */
function targetRegistration(config, filePath) {
  const layer = (config.layers ?? []).find((/** @type {any} */ item) => item?.name?.file === filePath);
  const agents = layer?.config?.agents;
  return agents && Object.hasOwn(agents, MANAGED_ROLE_NAME) ? { present: true, value: agents[MANAGED_ROLE_NAME] } : { present: false };
}

/** @param {AnyRecord} config @param {string} filePath */
function targetMetadata(config, filePath) {
  const layer = (config.layers ?? []).find((/** @type {any} */ item) => item?.name?.file === filePath);
  const parent = layer?.config?.features?.multi_agent_v2;
  return parent && Object.hasOwn(parent, 'hide_spawn_agent_metadata') ? { present: true, value: parent.hide_spawn_agent_metadata } : { present: false };
}

/** @param {AnyRecord} config @param {string} filePath @param {string} keyPath */
function targetLeaf(config, filePath, keyPath) {
  const layer = (config.layers ?? []).find((/** @type {any} */ item) => item?.name?.file === filePath);
  let cursor = layer?.config;
  for (const part of keyPath.split('.')) {
    if (!cursor || typeof cursor !== 'object' || !Object.hasOwn(cursor, part)) return { present: false };
    cursor = cursor[part];
  }
  return { present: true, value: cursor };
}

/** @param {AnyRecord} config @param {string} filePath @param {string} rolePath @param {ManagedRoleJournal} journal */
function configLeavesOwned(config, filePath, rolePath, journal) {
  const registration = targetRegistration(config, filePath);
  if (!registration.present || !sameExactRegistration(registration.value, rolePath)) return false;
  if (journalOwnsMetadata(journal)) {
    const metadata = targetMetadata(config, filePath);
    if (Object.hasOwn(journal, 'deletesLegacyMetadata')) {
      if (metadata.present) return false;
    } else if (!metadata.present || metadata.value !== false) return false;
  }
  return (journal.desiredAdditional ?? []).every((entry) => {
    const current = targetLeaf(config, filePath, entry.keyPath);
    return current.present && JSON.stringify(current.value) === JSON.stringify(entry.value);
  });
}

/** @param {Buffer|null} current @param {AnyRecord} journal */
function roleBytesProven(current, journal) {
  if (current === null) return true;
  if (sha256(current) === journal.intendedSha256) return true;
  if (!journal.roleExisted || typeof journal.previousRoleBase64 !== 'string') return false;
  return current.equals(Buffer.from(journal.previousRoleBase64, 'base64'));
}

/** @param {Buffer|null} current @param {AnyRecord} journal */
function receiptBytesProven(current, journal) {
  if (current === null) return true;
  if (typeof journal.intendedReceiptSha256 === 'string' && sha256(current) === journal.intendedReceiptSha256) return true;
  if (!journal.receiptExisted || typeof journal.previousReceiptBase64 !== 'string') return false;
  return current.equals(Buffer.from(journal.previousReceiptBase64, 'base64'));
}

/** @param {unknown} value @param {string} rolePath @param {string} pluginIdentity @param {string} configFilePath @returns {value is ManagedRoleJournal} */
function isManagedRoleJournal(value, rolePath, pluginIdentity, configFilePath) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const journal = /** @type {AnyRecord} */ (value);
  if (![1, 2].includes(journal.schemaVersion) || !['prepared', 'role-written', 'config-written', 'receipt-prepared'].includes(journal.phase)
    || journal.rolePath !== rolePath || !isSha256(journal.intendedSha256)
    || typeof journal.roleExisted !== 'boolean' || typeof journal.receiptExisted !== 'boolean'
    || journal.roleExisted && typeof journal.previousRoleBase64 !== 'string'
    || journal.receiptExisted && typeof journal.previousReceiptBase64 !== 'string'
    || !validLeafJournalEntry(journal.previousRegistration)
    || !validAdditionalJournalEntries(journal.previousAdditional, journal.desiredAdditional)) return false;
  if (journal.schemaVersion === 1) {
    if (Object.hasOwn(journal, 'deletesLegacyMetadata') || !validLeafJournalEntry(journal.previousMetadata)) return false;
  } else {
    if (typeof journal.deletesLegacyMetadata !== 'boolean') return false;
    if (journal.deletesLegacyMetadata) {
      if (!sameExactFalseLeaf(journal.previousMetadata)
        || !validLegacyMetadataAuthority(journal, rolePath, pluginIdentity, configFilePath)) return false;
    } else if (Object.hasOwn(journal, 'previousMetadata')) return false;
  }
  if (['config-written', 'receipt-prepared'].includes(journal.phase) && (typeof journal.configVersion !== 'string' || !journal.configVersion)) return false;
  if (journal.phase === 'receipt-prepared') {
    if (!isSha256(journal.intendedReceiptSha256) || typeof journal.intendedReceiptBase64 !== 'string') return false;
    try { if (sha256(Buffer.from(journal.intendedReceiptBase64, 'base64')) !== journal.intendedReceiptSha256) return false; } catch { return false; }
  }
  return true;
}

/** @param {unknown} value */
function sameExactFalseLeaf(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && sameKeys(Object.keys(/** @type {AnyRecord} */ (value)).sort(), ['present', 'value'])
    && /** @type {AnyRecord} */ (value).present === true
    && /** @type {AnyRecord} */ (value).value === false);
}

/** @param {AnyRecord} journal @param {string} rolePath @param {string} pluginIdentity @param {string} configFilePath */
function validLegacyMetadataAuthority(journal, rolePath, pluginIdentity, configFilePath) {
  if (!journal.roleExisted || !journal.receiptExisted
    || typeof journal.previousRoleBase64 !== 'string' || typeof journal.previousReceiptBase64 !== 'string'
    || !journal.previousRegistration?.present
    || !sameExactRegistration(journal.previousRegistration.value, rolePath)) return false;
  const previousRole = decodeBase64(journal.previousRoleBase64);
  const previousReceiptBytes = decodeBase64(journal.previousReceiptBase64);
  if (previousRole === null || previousReceiptBytes === null) return false;
  let receipt;
  try { receipt = JSON.parse(previousReceiptBytes.toString('utf8')); } catch { return false; }
  return isLegacyReceipt(receipt)
    && validReceiptBase(receipt, rolePath, pluginIdentity)
    && receipt.configTarget.filePath === configFilePath
    && receipt.role.sha256 === sha256(previousRole);
}

/** @param {string} value */
function decodeBase64(value) {
  try {
    const bytes = Buffer.from(value, 'base64');
    return bytes.toString('base64') === value ? bytes : null;
  } catch { return null; }
}

/** @param {unknown} value */
function validLeafJournalEntry(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = /** @type {AnyRecord} */ (value);
  if (typeof entry.present !== 'boolean') return false;
  const keys = Object.keys(entry).sort();
  if (!entry.present) return sameKeys(keys, ['present']);
  return sameKeys(keys, ['present', 'value']) && isPersistableJson(entry.value);
}

/** @param {unknown} previousValue @param {unknown} desiredValue */
function validAdditionalJournalEntries(previousValue, desiredValue) {
  const previous = previousValue ?? [];
  const desired = desiredValue ?? [];
  if (!Array.isArray(previous) || !Array.isArray(desired)
    || previous.length > MAX_ADDITIONAL_LEAVES || desired.length > MAX_ADDITIONAL_LEAVES) return false;
  return validUniqueEntries(previous, (entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
      || !MANAGED_SETUP_LEAF_PATHS.has(entry.keyPath) || typeof entry.present !== 'boolean') return false;
    const keys = Object.keys(entry).sort();
    if (!entry.present) return sameKeys(keys, ['keyPath', 'present']);
    return sameKeys(keys, ['keyPath', 'present', 'value']) && isPersistableJson(entry.value);
  }) && validUniqueEntries(desired, (entry) => entry && typeof entry === 'object' && !Array.isArray(entry)
    && MANAGED_SETUP_LEAF_PATHS.has(entry.keyPath)
    && sameKeys(Object.keys(entry).sort(), ['keyPath', 'value']) && isPersistableJson(entry.value));
}

/** @param {AnyRecord[]} entries @param {(entry:AnyRecord)=>boolean} validate */
function validUniqueEntries(entries, validate) {
  const keys = new Set();
  for (const entry of entries) {
    if (!validate(entry) || keys.has(entry.keyPath)) return false;
    keys.add(entry.keyPath);
  }
  return true;
}

/** @param {string[]} actual @param {string[]} expected */
function sameKeys(actual, expected) { return actual.length === expected.length && actual.every((key, index) => key === expected[index]); }

/** @param {unknown} value */
function isPersistableJson(value) {
  let nodes = 0;
  /** @type {(current:unknown,depth:number)=>boolean} */
  const visit = (current, depth) => {
    if (++nodes > 10_000 || depth > 32) return false;
    if (current === null || typeof current === 'string' || typeof current === 'boolean') return true;
    if (typeof current === 'number') return Number.isFinite(current);
    if (Array.isArray(current)) return current.length <= 1_000 && current.every((item) => visit(item, depth + 1));
    if (!current || typeof current !== 'object') return false;
    const prototype = Object.getPrototypeOf(current);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const entries = Object.entries(current);
    return entries.length <= 1_000 && entries.every(([key, item]) => !hasControl(key) && visit(item, depth + 1));
  };
  return visit(value, 0);
}

/** @param {AnyRecord} config */
function validConfigRead(config) {
  return config && typeof config === 'object' && !Array.isArray(config)
    && config.config && typeof config.config === 'object' && Array.isArray(config.layers)
    && (!Array.isArray(config.errors) || config.errors.length === 0)
    && !config.layers.some((/** @type {any} */ layer) => Array.isArray(layer?.errors) && layer.errors.length);
}

/** @param {AnyRecord} receipt @param {string} rolePath @param {string} identity */
function validReceiptBase(receipt, rolePath, identity) {
  const legacy = isLegacyReceipt(receipt);
  const current = receipt?.schemaVersion === MANAGED_ROLE_RECEIPT_SCHEMA_VERSION;
  return (legacy || current) && receipt.roleName === MANAGED_ROLE_NAME
    && receipt.plugin?.identity === identity && typeof receipt.plugin?.version === 'string'
    && typeof receipt.plugin?.root === 'string' && receipt.configTarget && typeof receipt.configTarget.filePath === 'string'
    && receipt.role?.path === rolePath && receipt.role?.schemaVersion === MANAGED_ROLE_SCHEMA_VERSION
    && typeof receipt.role?.sha256 === 'string' && /^[a-f0-9]{64}$/.test(receipt.role.sha256)
    && typeof receipt.mutatedAt === 'string' && Number.isFinite(Date.parse(receipt.mutatedAt))
    && (legacy
      ? !Object.hasOwn(receipt, 'priorSpawnMetadataValue') || typeof receipt.priorSpawnMetadataValue === 'boolean'
      : !Object.hasOwn(receipt, 'priorSpawnMetadataValue'));
}

/** @param {unknown} receipt */
function isLegacyReceipt(receipt) {
  return Boolean(receipt && typeof receipt === 'object' && !Array.isArray(receipt)
    && /** @type {AnyRecord} */ (receipt).schemaVersion === 1);
}

/** Numeric-v1 journals omitted the intent because they always wrote metadata=false. @param {AnyRecord} journal */
function journalOwnsMetadata(journal) {
  return journal.schemaVersion === 1 || journal.deletesLegacyMetadata === true;
}

/** @param {string} rolePath */
function expectedRegistration(rolePath) { return { description: MANAGED_ROLE_DESCRIPTION, config_file: rolePath }; }
/** @param {any} value @param {string} rolePath */
function sameExactRegistration(value, rolePath) { return value?.description === MANAGED_ROLE_DESCRIPTION && value?.config_file === rolePath && Object.keys(value).length === 2; }
/** Codex normalizes an effective Agent Role with this nullable default; the selected config layer remains exact. @param {any} value @param {string} rolePath */
function sameEffectiveRegistration(value, rolePath) {
  if (value?.description !== MANAGED_ROLE_DESCRIPTION || value?.config_file !== rolePath) return false;
  const keys = Object.keys(value).sort();
  return sameKeys(keys, ['config_file', 'description'])
    || value.nickname_candidates === null && sameKeys(keys, ['config_file', 'description', 'nickname_candidates']);
}
/** @param {string} status @param {string} rolePath @param {string} [reason] @param {AnyRecord[]} [conflicts] */
function result(status, rolePath, reason, conflicts) { return { status, rolePath, ...(reason ? { reason } : {}), ...(conflicts?.length ? { conflicts } : {}) }; }
/** @param {string|Buffer} bytes */
function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
/** @param {unknown} value */
function isSha256(value) { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value); }
/** @param {string} path */
async function exists(path) { try { await lstat(path); return true; } catch (error) { if (isCode(error, 'ENOENT')) return false; throw error; } }
/** @param {string} path @returns {Promise<Buffer|null>} */
async function optionalBytes(path) { try { return await readFile(path); } catch (error) { if (isCode(error, 'ENOENT')) return null; throw error; } }
/** @param {string} path @returns {Promise<any>} */
async function optionalJson(path) { const bytes = await optionalBytes(path); if (bytes === null) return null; try { return JSON.parse(bytes.toString('utf8')); } catch { return {}; } }
/** @param {string} path */
async function canonicalExisting(path) { try { return await realpath(path); } catch (cause) { throw roleError('MANAGED_ROLE_PATH_INVALID', `Managed Role root does not exist: ${path}`, { path }, cause); } }
/** @param {unknown} error @param {string} code */
function isCode(error, code) { return error instanceof Error && 'code' in error && error.code === code; }
/** @param {string} value */
function hasControl(value) { return [...value].some((character) => { const code = character.codePointAt(0) ?? 0; return code < 32 || code === 127; }); }

/** @param {any} input */
function validateCommonInput(input) {
  if (!input || typeof input !== 'object' || typeof input.dataRoot !== 'string' || typeof input.template !== 'string'
    || typeof input.pluginRoot !== 'string' || typeof input.pluginIdentity !== 'string' || !input.pluginIdentity
    || typeof input.pluginVersion !== 'string' || !input.pluginVersion || !input.configTarget
    || typeof input.configTarget.filePath !== 'string' || !input.configTarget.filePath
    || typeof input.configTarget.expectedVersion !== 'string' || !input.configTarget.expectedVersion
    || typeof input.sessionStartedAt !== 'string' || !Number.isFinite(Date.parse(input.sessionStartedAt))) {
    throw roleError('MANAGED_ROLE_INPUT_INVALID', 'Managed Rescue Role input is invalid.');
  }
}

/** @param {AnyRecord} prepared @param {AnyRecord} input @param {string[]} remaining @param {string} message */
function rollbackError(prepared, input, remaining, message) {
  return new PluginError('MANAGED_ROLE_ROLLBACK_INCOMPLETE', message, {
    category: 'configuration',
    remedy: `Restore only proven owned state at ${prepared.paths.rolePath}, ${prepared.paths.receiptPath}, and ${input.configTarget.filePath}; remove the transaction journal ${prepared.paths.transactionPath}; then rerun $zcode:setup.`,
    details: {
      rolePath: prepared.paths.rolePath,
      receiptPath: prepared.paths.receiptPath,
      configPath: input.configTarget.filePath,
      transactionPath: prepared.paths.transactionPath,
      remaining: [...new Set(remaining)],
    },
  });
}

/** @param {any} input */
function validateReconcileInput(input) {
  validateCommonInput(input);
  if (typeof input.batchWrite !== 'function' || typeof input.readConfig !== 'function'
    || input.activate !== undefined && typeof input.activate !== 'function'
    || input.additionalEdits !== undefined && !Array.isArray(input.additionalEdits)) {
    throw roleError('MANAGED_ROLE_INPUT_INVALID', 'Managed Rescue Role reconciliation dependencies are invalid.');
  }
  const reserved = new Set([`agents.${MANAGED_ROLE_NAME}`, 'features.multi_agent_v2.hide_spawn_agent_metadata']);
  if ((input.additionalEdits ?? []).some((/** @type {any} */ edit) => !edit || typeof edit.keyPath !== 'string' || reserved.has(edit.keyPath) || edit.mergeStrategy !== 'upsert')) {
    throw roleError('MANAGED_ROLE_INPUT_INVALID', 'Managed Rescue Role additional config edits are invalid.');
  }
}

/** @param {string} code @param {string} message @param {AnyRecord} [details] @param {unknown} [cause] */
function roleError(code, message, details, cause) {
  return new PluginError(code, message, {
    category: 'configuration',
    remedy: 'Resolve the managed Agent Role conflict and rerun $zcode:setup.',
    ...(details ? { details } : {}),
    ...(cause ? { cause } : {}),
  });
}
