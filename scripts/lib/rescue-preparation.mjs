import { createHash } from 'node:crypto';
import { constants, lstatSync, unlinkSync } from 'node:fs';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import { isAbsolute, join, normalize, relative } from 'node:path';

import { PluginError } from './errors.mjs';
import {
  atomicWriteJson,
  ensurePrivateDirectoryWithin,
  readBoundedJsonFile,
  readPrivateDirectory,
  samePathHandleFileSnapshot,
  withFileLock,
} from './fs.mjs';
import { PERMISSION_MODES } from './identity.mjs';
import { resolveWorkspaceStorage } from './workspace.mjs';

export const RESCUE_PREPARATION_VERSION = 1;
export const RESCUE_TASK_MAX_BYTES = 64 * 1024;
export const RESCUE_ENVELOPE_MAX_BYTES = RESCUE_TASK_MAX_BYTES + 4096;

const RESCUE_PREPARATION_RECORD_VERSION = 3;
const SOURCES = new Set(['explicit', 'proactive']);
const EXECUTIONS = new Set(['foreground', 'background']);
const RESUMES = new Set(['fresh', 'resume']);
const EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);
const ENVELOPE_KEYS = ['options', 'source', 'task', 'version'];
const OPTION_KEYS = new Set(['effort', 'execution', 'model', 'resume']);
const PREPARATION_LIFETIME_MS = 30 * 60_000;
const PREPARATION_SCAN_MAX_RECORDS = 1024;
const PREPARATION_RECORD_MAX_BYTES = 2 * 1024 * 1024;
const V1_RECORD_KEYS = Object.freeze([
  'consumedAt', 'createdAt', 'envelope', 'executorAgentId', 'expiresAt', 'key',
  'permissionMode', 'sessionId', 'source', 'turnId', 'version', 'workspace',
]);
const V2_RECORD_KEYS = Object.freeze([
  'consumedAt', 'createdAt', 'envelope', 'executorAgentId', 'expiresAt', 'generation', 'key',
  'permissionMode', 'requiredExecutorAgentId', 'sessionId', 'source', 'turnId', 'version', 'workspace',
]);
const PENDING_FRESH_V2_RECORD_KEYS = Object.freeze([...V2_RECORD_KEYS, 'pendingFreshProvenance']);
const PENDING_FRESH_PROVENANCE_KEYS = Object.freeze(['executorAgentId', 'originatingTurnId']);
const V3_RECORD_KEYS = Object.freeze([
  'activation', 'consumedAt', 'createdAt', 'envelope', 'executorAgentId', 'expiresAt',
  'generation', 'key', 'permissionMode', 'requiredExecutorAgentId', 'sessionId', 'source',
  'turnId', 'version', 'workspace',
]);
const SPAWN_ACTIVATION_KEYS = Object.freeze(['agentPathDigest', 'kind', 'taskName']);
const REACTIVATE_ACTIVATION_KEYS = Object.freeze(['agentPathDigest', 'executorAgentId', 'kind']);
const REACTIVATE_PROOF_KEYS = Object.freeze(['agentPathDigest', 'kind']);
const LEGACY_ADOPT_ACTIVATION_KEYS = Object.freeze(['agentPathDigest', 'childThreadId', 'kind']);
const LEGACY_BOUND_ACTIVATION_KEYS = Object.freeze(['agentPathDigest', 'bindingKey', 'childThreadId', 'kind']);
const consumedLegacyActivationAuthorities = new WeakMap();
const brandedLegacyChildAuthorities = new WeakMap();
const issuedLegacyChildAuthorities = new WeakMap();
const consumedLegacyChildAuthorities = new WeakSet();
const LEGACY_AUTHORITY_FACTORY_KEYS = Object.freeze(['authorizingParentGenerationId', 'executionWorkspace', 'originWorkspace']);

/** @param {NodeJS.ReadableStream} stream */
export async function readRescuePreparation(stream) {
  if (stream === null || typeof stream !== 'object' || !(Symbol.asyncIterator in stream)) {
    throw invalidPreparation();
  }
  const buffer = Buffer.allocUnsafe(RESCUE_ENVELOPE_MAX_BYTES);
  let length = 0;
  try {
    for await (const chunk of stream) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (bytes.length === 0) continue;
      if (length + bytes.length > RESCUE_ENVELOPE_MAX_BYTES) throw invalidPreparation();
      bytes.copy(buffer, length); length += bytes.length;
    }
  } catch { throw invalidPreparation(); }
  const bytes = buffer.subarray(0, length);
  if (bytes.length === 0 || bytes.at(-1) !== 0x0a || bytes.subarray(0, -1).includes(0x0a)) {
    throw invalidPreparation();
  }
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, -1)); }
  catch { throw invalidPreparation(); }
  rejectDuplicateObjectKeys(text);
  let value;
  try { value = JSON.parse(text); } catch { throw invalidPreparation(); }
  return validateRescuePreparation(value);
}

/** @param {unknown} value */
export function validateRescuePreparation(value) {
  if (!plain(value) || !sameKeys(value, ENVELOPE_KEYS)
    || value.version !== RESCUE_PREPARATION_VERSION
    || !SOURCES.has(value.source)
    || typeof value.task !== 'string' || value.task.trim().length === 0
    || Buffer.byteLength(value.task) > RESCUE_TASK_MAX_BYTES
    || !plain(value.options)) throw invalidPreparation();
  for (const key of Object.keys(value.options)) {
    if (!OPTION_KEYS.has(key) || value.options[key] === null) throw invalidPreparation();
  }
  if (value.options.execution !== undefined && !EXECUTIONS.has(value.options.execution)) throw invalidPreparation();
  if (value.options.resume !== undefined && !RESUMES.has(value.options.resume)) throw invalidPreparation();
  if (value.options.effort !== undefined && !EFFORTS.has(value.options.effort)) throw invalidPreparation();
  if (value.options.model !== undefined && !validModel(value.options.model)) throw invalidPreparation();
  return {
    version: value.version,
    source: value.source,
    task: value.task,
    options: { ...value.options },
  };
}

/** @param {string} prompt */
export function hasRecordedRescueMarker(prompt) {
  return typeof prompt === 'string' && /(?:^|\s)\$zcode:rescue(?=$|\s)/u.test(prompt);
}

/** Derive authority only from the exact validated receipt returned by consume(). @param {unknown} value */
export function deriveConsumedLegacyActivationAuthorityId(value) {
  let domain;
  try { domain = consumedLegacyActivationAuthorities.get(/** @type {object} */ (value)); }
  catch { throw invalidPreparation(); }
  if (domain === undefined) throw invalidPreparation();
  return createHash('sha256').update(JSON.stringify(domain)).digest('hex');
}

/** Create an unforgeable in-process authority from one genuine consumed legacy receipt. @param {unknown} receipt @param {unknown} input */
export function createConsumedLegacyChildAuthority(receipt, input) {
  let domain;
  try { domain = consumedLegacyActivationAuthorities.get(/** @type {object} */ (receipt)); }
  catch { throw invalidPreparation(); }
  if (domain === undefined || !plain(input) || !sameKeys(input, LEGACY_AUTHORITY_FACTORY_KEYS)
    || !digest(input.authorizingParentGenerationId) || !canonicalWorkspace(input.originWorkspace)
    || !canonicalWorkspace(input.executionWorkspace)) throw invalidPreparation();
  const consumed = /** @type {any} */ (receipt); const activation = consumed.activation;
  if (!plain(activation) || !['legacy-adopt', 'legacy-bound'].includes(activation.kind)
    || consumed.workspace !== input.executionWorkspace || !safeIdentifier(consumed.executorAgentId)
    || !safeIdentifier(consumed.sessionId, 4096) || !safeIdentifier(consumed.turnId, 4096)
    || !PERMISSION_MODES.includes(consumed.permissionMode)) throw invalidPreparation();
  const issued = issuedLegacyChildAuthorities.get(/** @type {object} */ (receipt));
  if (issued !== undefined) {
    if (issued.authorizingParentGenerationId !== input.authorizingParentGenerationId
      || issued.originWorkspace !== input.originWorkspace || issued.executionWorkspace !== input.executionWorkspace) throw invalidPreparation();
    return issued;
  }
  const authorityId = createHash('sha256').update(JSON.stringify(domain)).digest('hex');
  const stable = {
    ...(activation.kind === 'legacy-adopt'
      ? { kind: 'codex-legacy-adoption', authorityId }
      : { kind: 'codex-legacy-continuation', preparationAuthorityId: authorityId, bindingKey: activation.bindingKey }),
    childAgentId: consumed.executorAgentId,
    childAgentType: 'zcode-rescue',
    authorizingParentTurnId: consumed.turnId,
    authorizingParentGenerationId: input.authorizingParentGenerationId,
    authorizingPermissionMode: consumed.permissionMode,
    originWorkspace: input.originWorkspace,
    executionWorkspace: input.executionWorkspace,
    agentPathDigest: activation.agentPathDigest,
  };
  const authority = Object.freeze(stable);
  brandedLegacyChildAuthorities.set(authority, Object.freeze({ authority, parentSessionId: consumed.sessionId }));
  issuedLegacyChildAuthorities.set(/** @type {object} */ (receipt), authority);
  return authority;
}

/** Read one authority only if it retains the exact factory-issued object identity. @param {unknown} value */
export function readConsumedLegacyChildAuthority(value) {
  return readConsumedLegacyChildAuthorityContext(value).authority;
}

/** Read the private parent session retained outside the persisted authority schema. @param {unknown} value */
export function readConsumedLegacyChildAuthorityContext(value) {
  let context;
  try { context = brandedLegacyChildAuthorities.get(/** @type {object} */ (value)); }
  catch { throw invalidPreparation(); }
  if (context === undefined) throw invalidPreparation();
  return context;
}

/** Consume one issued authority exactly once before any StateStore publication. @param {unknown} value */
export function consumeConsumedLegacyChildAuthority(value) {
  return consumeConsumedLegacyChildAuthorityContext(value).authority;
}

/** Consume one private branded context exactly once. @param {unknown} value */
export function consumeConsumedLegacyChildAuthorityContext(value) {
  const context = readConsumedLegacyChildAuthorityContext(value);
  if (consumedLegacyChildAuthorities.has(context.authority)) throw invalidPreparation();
  consumedLegacyChildAuthorities.add(context.authority);
  return context;
}

/** @param {{dataRoot:string,testOnlyBeforeSaveLockOpen?:()=>Promise<void>}} options */
export function createRescuePreparationStore({ dataRoot, testOnlyBeforeSaveLockOpen }) {
  if (typeof dataRoot !== 'string' || dataRoot.length === 0) throw preparationError(
    'RESCUE_PREPARATION_INVALID', 'A plugin data root is required.',
  );
  if (testOnlyBeforeSaveLockOpen !== undefined && typeof testOnlyBeforeSaveLockOpen !== 'function') {
    throw invalidPreparation();
  }
  const beforeSaveLockOpen = testOnlyBeforeSaveLockOpen === undefined ? undefined : async () => {
    try { await testOnlyBeforeSaveLockOpen(); } catch { throw invalidPreparation(); }
  };
  return {
    /** @param {any} input */
    async save(input) {
      validateSaveInput(input);
      const envelope = validateRescuePreparation(input.envelope);
      const storage = await preparationStorage(dataRoot, input.workspace);
      const key = preparationKey(input.sessionId, input.turnId, storage.workspacePath);
      const path = join(storage.directory, `${key}.json`);
      const cancellation = lockCancellation(input.signal);
      try {
        await withPreparationLock(storage, async () => {
          const createdAt = timestamp(input.now);
          const names = await boundedRecordNames(storage);
          const occupied = names.includes(`${key}.json`) || await exists(path);
          if (!occupied && names.length === PREPARATION_SCAN_MAX_RECORDS) throw preparationError(
            'RESCUE_PREPARATION_SCAN_LIMIT', 'The Rescue preparation record scan limit was exceeded.',
          );
          let generation = 1;
          let requiredExecutorAgentId = null;
          let activation = null;
          let recordVersion = RESCUE_PREPARATION_RECORD_VERSION;
          if (occupied) {
            const current = await readPreparedRecord(storage, path, key, false);
            const kind = recordKind(current);
            const sameConsumedTurn = current.sessionId === input.sessionId
              && current.turnId === input.turnId
              && current.workspace === storage.workspacePath
              && current.permissionMode === input.permissionMode
              && current.consumedAt !== null
              && safeIdentifier(current.executorAgentId)
              && createdAt >= Date.parse(current.consumedAt);
            const boundResume = envelope.source === 'proactive'
              && envelope.options.resume === 'resume'
              && sameConsumedTurn;
            const freshReplan = envelope.options.resume === 'fresh'
              && kind === 'pending-fresh'
              && exactPendingFreshEnvelope(current.envelope, envelope)
              && sameConsumedTurn;
            if (!boundResume && !freshReplan) throw preparationError(
              'RESCUE_PREPARATION_EXISTS', 'A Rescue preparation already exists for this turn.',
            );
            if (freshReplan) {
              if (input.activation === undefined) throw invalidPreparation();
              activation = validateActivation(input.activation);
              if (activation.kind !== 'spawn') throw invalidPreparation();
            } else {
              generation = kind === 'legacy' ? 2 : current.generation + 1;
              if (!Number.isSafeInteger(generation)) throw invalidPreparation();
              requiredExecutorAgentId = current.executorAgentId;
              if (input.activation !== undefined) {
                activation = validateActivation(input.activation);
                const legacyActivation = /** @type {any} */ (activation);
                if (activation.kind === 'legacy-bound') {
                  if (legacyActivation.childThreadId !== requiredExecutorAgentId) throw invalidPreparation();
                } else {
                  if (activation.kind === 'legacy-adopt') throw invalidPreparation();
                  activation = null;
                }
              }
            }
          } else {
            if (input.activation === undefined) recordVersion = 2;
            else {
              activation = validateActivation(input.activation);
              if (activation.kind === 'legacy-bound') {
                requiredExecutorAgentId = /** @type {any} */ (activation).childThreadId;
              }
            }
            const marker = hasRecordedRescueMarker(input.recordedPrompt);
            if ((envelope.source === 'explicit') !== marker) throw preparationError(
              'RESCUE_PREPARATION_SOURCE_MISMATCH',
              'The Rescue preparation source does not match the recorded prompt.',
            );
          }
          const record = {
            version: recordVersion,
            key,
            sessionId: input.sessionId,
            turnId: input.turnId,
            workspace: storage.workspacePath,
            permissionMode: input.permissionMode,
            source: envelope.source,
            envelope,
            ...(recordVersion === 2 && input.pendingFreshProvenance !== undefined
              ? { pendingFreshProvenance: { ...input.pendingFreshProvenance } }
              : {}),
            ...(recordVersion === RESCUE_PREPARATION_RECORD_VERSION ? { activation } : {}),
            generation,
            requiredExecutorAgentId,
            createdAt: new Date(createdAt).toISOString(),
            expiresAt: new Date(createdAt + PREPARATION_LIFETIME_MS).toISOString(),
            consumedAt: null,
            executorAgentId: null,
          };
          if (Buffer.byteLength(`${JSON.stringify(record, null, 2)}\n`) > PREPARATION_RECORD_MAX_BYTES) {
            throw invalidPreparation();
          }
          cancellation.linearize();
          await atomicWriteJson(path, record, { privateRoot: storage.privateRoot });
        }, { beforeLockOpen: beforeSaveLockOpen, signal: cancellation.signal });
      } finally { cancellation.detach(); }
    },

    /** @param {any} input */
    async consume(input) {
      validateConsumeInput(input);
      const storage = await preparationStorage(dataRoot, input.workspace);
      const key = preparationKey(input.sessionId, input.turnId, storage.workspacePath);
      const path = join(storage.directory, `${key}.json`);
      return withPreparationLock(storage, async () => {
        const record = await readPreparedRecord(storage, path, key, true);
        const kind = recordKind(record);
        if (record.sessionId !== input.sessionId || record.turnId !== input.turnId
          || record.workspace !== storage.workspacePath || record.permissionMode !== input.permissionMode) {
          throw preparationError('RESCUE_PREPARATION_MISMATCH', 'The Rescue preparation identity does not match.');
        }
        if (record.consumedAt !== null) {
          if (record.executorAgentId !== input.executorAgentId) throw preparationError(
            'RESCUE_PREPARATION_MISMATCH', 'The Rescue preparation executor does not match.',
          );
          throw preparationError('RESCUE_PREPARATION_CONSUMED', 'The Rescue preparation has already been consumed.');
        }
        if (kind !== 'legacy' && record.requiredExecutorAgentId !== null
          && record.requiredExecutorAgentId !== input.executorAgentId) {
          throw preparationError(
            'RESCUE_PREPARATION_MISMATCH', 'The Rescue preparation executor does not match.',
          );
        }
        if (kind === 'current' && record.activation !== null
          && !activationProofMatches(record.activation, input.activationProof, input.executorAgentId)) {
          throw preparationError(
            'RESCUE_PREPARATION_MISMATCH', 'The Rescue preparation activation does not match.',
          );
        }
        if (kind === 'current' && ['legacy-adopt', 'legacy-bound'].includes(record.activation?.kind)
          && input.beforeLegacyConsume !== undefined) await input.beforeLegacyConsume();
        const consumedAt = timestamp(input.now);
        if (consumedAt < Date.parse(record.createdAt)) throw invalidPreparation();
        if (consumedAt >= Date.parse(record.expiresAt)) throw preparationError(
          'RESCUE_PREPARATION_EXPIRED', 'The Rescue preparation has expired.',
        );
        const consumed = {
          ...record,
          envelope: validateRescuePreparation(record.envelope),
          consumedAt: new Date(consumedAt).toISOString(),
          executorAgentId: input.executorAgentId,
        };
        await atomicWriteJson(path, consumed, { privateRoot: storage.privateRoot });
        let receipt = cloneRecord(consumed);
        if (kind === 'current' && ['legacy-adopt', 'legacy-bound'].includes(record.activation?.kind)) {
          const domain = record.activation.kind === 'legacy-adopt'
            ? ['rescue-legacy-adoption-authority-v1', consumed.key, consumed.executorAgentId, consumed.generation, consumed.createdAt]
            : ['rescue-legacy-bound-authority-v1', consumed.key, consumed.executorAgentId, consumed.generation, consumed.createdAt, record.activation.bindingKey];
          receipt = freezeLegacyReceipt(receipt);
          consumedLegacyActivationAuthorities.set(receipt, Object.freeze(domain));
        }
        return receipt;
      });
    },

    /** @param {any} input */
    async cleanupTurn(input) {
      validateTurnInput(input);
      const storage = await preparationStorage(dataRoot, input.workspace);
      const key = preparationKey(input.sessionId, input.turnId, storage.workspacePath);
      const path = join(storage.directory, `${key}.json`);
      await withPreparationLock(storage, async () => {
        if (!await exists(path)) return;
        const record = await readPreparedRecord(storage, path, key, false);
        if (record.sessionId !== input.sessionId || record.turnId !== input.turnId) throw invalidRecord();
        await unlinkPreparedRecord(storage, path);
      });
    },

    /** @param {any} input */
    async cleanupOlderTurns(input) {
      validateTurnInput(input);
      const storage = await preparationStorage(dataRoot, input.workspace);
      await cleanupMatching(storage, (record) => (
        record.sessionId === input.sessionId && record.turnId !== input.turnId
      ));
    },

    /** @param {any} input */
    async cleanupSession(input) {
      validateSessionInput(input);
      const storage = await preparationStorage(dataRoot, input.workspace);
      await cleanupMatching(storage, (record) => record.sessionId === input.sessionId);
    },
  };
}

/** @param {any} storage @param {(record:any)=>boolean} predicate */
async function cleanupMatching(storage, predicate) {
  await withPreparationLock(storage, async () => {
    const names = await boundedRecordNames(storage);
    const targets = [];
    for (const name of names) {
      const key = name.slice(0, -5);
      const path = join(storage.directory, name);
      let record;
      try { record = await readPreparedRecord(storage, path, key, false); }
      catch (error) {
        if (error instanceof PluginError && error.code === 'RESCUE_PREPARATION_RECORD_INVALID') continue;
        throw error;
      }
      if (predicate(record)) targets.push(path);
    }
    for (const path of targets) await unlinkPreparedRecord(storage, path);
  });
}

/** @param {any} storage */
async function boundedRecordNames(storage) {
  let entries;
  try {
    entries = await readPrivateDirectory(
      storage.privateRoot, storage.directory, PREPARATION_SCAN_MAX_RECORDS,
    );
  } catch (error) {
    if (await hasActualEntryOverflow(storage)) throw preparationError(
      'RESCUE_PREPARATION_SCAN_LIMIT', 'The Rescue preparation record scan limit was exceeded.',
    );
    if (error instanceof PluginError && error.code === 'PRIVATE_PATH_UNSAFE') throw invalidRecord();
    throw storageError();
  }
  if (entries.some((entry) => !entry.isFile() || !/^[a-f0-9]{64}\.json$/u.test(entry.name))) throw invalidRecord();
  return entries.map((entry) => entry.name);
}

/** @param {any} storage @param {string} path @param {string} key @param {boolean} missingIsNotFound */
async function readPreparedRecord(storage, path, key, missingIsNotFound) {
  let record;
  try { record = await readPrivatePreparationJson(storage, path); }
  catch (error) {
    if (missingIsNotFound && (/** @type {any} */ (error)?.code === 'ENOENT'
      || error instanceof PluginError && error.code === 'JSON_READ_FAILED'
      && /** @type {any} */ (error.cause)?.code === 'ENOENT')) {
      throw preparationError('RESCUE_PREPARATION_NOT_FOUND', 'No Rescue preparation matches this turn.');
    }
    if (recordCorruptionError(error)) throw invalidRecord();
    throw storageError();
  }
  if (!validRecord(record, key, storage.workspacePath)) throw invalidRecord();
  return record;
}

/** @param {any} storage */
async function hasActualEntryOverflow(storage) {
  let handle;
  try {
    const [rootBefore, directoryBefore, canonicalRoot, canonicalDirectory] = await Promise.all([
      lstat(storage.privateRoot, { bigint: true }),
      lstat(storage.directory, { bigint: true }),
      realpath(storage.privateRoot),
      realpath(storage.directory),
    ]);
    const descendant = relative(canonicalRoot, canonicalDirectory);
    if (!rootBefore.isDirectory() || !directoryBefore.isDirectory()
      || descendant === '..' || descendant.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
      || isAbsolute(descendant)) return false;
    handle = await opendir(storage.directory); let count = 0;
    for await (const entry of handle) {
      void entry; count += 1;
      if (count > PREPARATION_SCAN_MAX_RECORDS) break;
    }
    const [rootAfter, directoryAfter] = await Promise.all([
      lstat(storage.privateRoot, { bigint: true }), lstat(storage.directory, { bigint: true }),
    ]);
    return count > PREPARATION_SCAN_MAX_RECORDS
      && sameDirectoryIdentity(rootBefore, rootAfter)
      && sameDirectoryIdentity(directoryBefore, directoryAfter);
  } catch { return false; }
  finally { await handle?.close().catch(() => {}); }
}

/** @param {unknown} error */
function recordCorruptionError(error) {
  return error instanceof SyntaxError
    || error instanceof PluginError && [
      'PRIVATE_PATH_UNSAFE', 'RESCUE_PREPARATION_RECORD_INVALID',
    ].includes(error.code)
    || ['EISDIR', 'ELOOP', 'ENOTDIR'].includes(/** @type {any} */ (error)?.code);
}

/** @param {any} storage @param {string} path */
async function readPrivatePreparationJson(storage, path) {
  const trusted = await readBoundedJsonFile(
    storage.privateRoot, path, PREPARATION_RECORD_MAX_BYTES,
  );
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(PREPARATION_RECORD_MAX_BYTES)) throw invalidRecord();
    const bytes = Buffer.allocUnsafe(Number(before.size)); let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    if (offset !== bytes.length) throw invalidRecord();
    const [after, current] = await Promise.all([
      handle.stat({ bigint: true }), lstat(path, { bigint: true }),
    ]);
    if (current.isSymbolicLink() || !current.isFile()
      || !sameFileIdentity(before, after)
      || !samePathHandleFileSnapshot(current, before)) throw invalidRecord();
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw invalidRecord(); }
    try {
      rejectDuplicateObjectKeys(text);
      const parsed = JSON.parse(text);
      if (JSON.stringify(parsed) !== JSON.stringify(trusted)) throw invalidRecord();
      await assertStorageIdentity(storage);
      return trusted;
    } catch { throw invalidRecord(); }
  } finally { await handle?.close().catch(() => {}); }
}

/** @param {import('node:fs').BigIntStats} left @param {import('node:fs').BigIntStats} right */
function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

/** @param {any} record @param {string} key @param {string} workspace */
function validRecord(record, key, workspace) {
  const kind = recordKind(record);
  if (kind === null || record.key !== key
    || !/^[a-f0-9]{64}$/u.test(record.key) || record.workspace !== workspace
    || !nonempty(record.sessionId) || !nonempty(record.turnId)
    || !PERMISSION_MODES.includes(record.permissionMode)
    || !SOURCES.has(record.source) || !validDate(record.createdAt) || !validDate(record.expiresAt)
    || Date.parse(record.expiresAt) - Date.parse(record.createdAt) !== PREPARATION_LIFETIME_MS
    || preparationKey(record.sessionId, record.turnId, record.workspace) !== record.key) return false;
  let envelope;
  try { envelope = validateRescuePreparation(record.envelope); } catch { return false; }
  if (envelope.source !== record.source) return false;
  if (record.consumedAt === null) return record.executorAgentId === null;
  return validDate(record.consumedAt) && safeIdentifier(record.executorAgentId)
    && Date.parse(record.consumedAt) >= Date.parse(record.createdAt)
    && Date.parse(record.consumedAt) < Date.parse(record.expiresAt)
    && (kind === 'legacy' || record.requiredExecutorAgentId === null
      || record.executorAgentId === record.requiredExecutorAgentId)
    && (kind !== 'pending-fresh'
      || record.executorAgentId === record.pendingFreshProvenance.executorAgentId)
    && (kind !== 'current' || record.activation === null
      || record.activation.kind === 'reactivate' && record.executorAgentId === record.activation.executorAgentId
      || ['legacy-adopt', 'legacy-bound'].includes(record.activation.kind)
        && record.executorAgentId === record.activation.childThreadId
      || !['reactivate', 'legacy-adopt', 'legacy-bound'].includes(record.activation.kind));
}

/** @param {any} record @returns {'legacy'|'v2'|'pending-fresh'|'current'|null} */
function recordKind(record) {
  if (!plain(record)) return null;
  if (record.version === RESCUE_PREPARATION_VERSION && sameKeys(record, V1_RECORD_KEYS)) return 'legacy';
  if (record.version === 2) {
    if (!validGenerationBinding(record)) return null;
    if (sameKeys(record, V2_RECORD_KEYS)) return 'v2';
    if (sameKeys(record, PENDING_FRESH_V2_RECORD_KEYS)
      && validPendingFreshProvenance(record.pendingFreshProvenance, record.turnId)) return 'pending-fresh';
    return null;
  }
  if (record.version !== RESCUE_PREPARATION_RECORD_VERSION || !sameKeys(record, V3_RECORD_KEYS)
    || !validActivationForGeneration(record)) return null;
  return 'current';
}

/** @param {any} record */
function validActivationForGeneration(record) {
  if (!Number.isSafeInteger(record.generation) || record.generation < 1
    || record.requiredExecutorAgentId !== null && !safeIdentifier(record.requiredExecutorAgentId)) return false;
  if (record.generation === 1) {
    if (!validActivation(record.activation)) return false;
    if (record.activation.kind === 'legacy-bound') {
      return record.requiredExecutorAgentId === record.activation.childThreadId;
    }
    return record.requiredExecutorAgentId === null;
  }
  return record.requiredExecutorAgentId !== null
    && (record.activation === null || validActivation(record.activation)
      && record.activation.kind === 'legacy-bound'
      && record.activation.childThreadId === record.requiredExecutorAgentId);
}

/** @param {any} record */
function validGenerationBinding(record) {
  return Number.isSafeInteger(record.generation) && record.generation > 0
    && (record.requiredExecutorAgentId === null || safeIdentifier(record.requiredExecutorAgentId))
    && (record.generation === 1
      ? record.requiredExecutorAgentId === null
      : record.requiredExecutorAgentId !== null);
}

/** @param {unknown} value @param {string} turnId */
function validPendingFreshProvenance(value, turnId) {
  return plain(value) && sameKeys(value, PENDING_FRESH_PROVENANCE_KEYS)
    && safeIdentifier(value.executorAgentId) && nonempty(value.originatingTurnId)
    && value.originatingTurnId !== turnId;
}

/** @param {any} original @param {any} replanned */
function exactPendingFreshEnvelope(original, replanned) {
  if (original.version !== replanned.version || original.source !== replanned.source
    || original.task !== replanned.task || original.options.resume !== undefined
    || replanned.options.resume !== 'fresh') return false;
  const originalKeys = Object.keys(original.options);
  const replannedKeys = Object.keys(replanned.options);
  return replannedKeys.length === originalKeys.length + 1
    && originalKeys.every((key) => Object.hasOwn(replanned.options, key)
      && replanned.options[key] === original.options[key]);
}

/** @param {any} input */
function validateSaveInput(input) {
  if (!plain(input) || !nonempty(input.sessionId) || !nonempty(input.turnId)
    || !nonempty(input.workspace) || !PERMISSION_MODES.includes(input.permissionMode)
    || typeof input.recordedPrompt !== 'string' || Buffer.byteLength(input.recordedPrompt) > RESCUE_TASK_MAX_BYTES
    || input.signal !== undefined && !(input.signal instanceof AbortSignal)
    || input.pendingFreshProvenance !== undefined
      && (input.activation !== undefined
        || !validPendingFreshProvenance(input.pendingFreshProvenance, input.turnId))) {
    throw invalidPreparation();
  }
  timestamp(input.now);
}

/** @param {any} input */
function validateConsumeInput(input) {
  validateTurnInput(input);
  if (!PERMISSION_MODES.includes(input.permissionMode) || !safeIdentifier(input.executorAgentId)
    || input.beforeLegacyConsume !== undefined && typeof input.beforeLegacyConsume !== 'function') {
    throw invalidPreparation();
  }
  timestamp(input.now);
}

/** @param {unknown} value */
function validateActivation(value) {
  if (!validActivation(value)) throw invalidPreparation();
  const activation = /** @type {any} */ (value);
  if (activation.kind === 'spawn') return {
    kind: activation.kind, taskName: activation.taskName, agentPathDigest: activation.agentPathDigest,
  };
  if (activation.kind === 'reactivate') return {
      kind: activation.kind,
      executorAgentId: activation.executorAgentId,
      agentPathDigest: activation.agentPathDigest,
  };
  return {
    kind: activation.kind,
    childThreadId: activation.childThreadId,
    agentPathDigest: activation.agentPathDigest,
    ...(activation.kind === 'legacy-bound' ? { bindingKey: activation.bindingKey } : {}),
  };
}

/** @param {unknown} value */
function validActivation(value) {
  if (!plain(value) || !/^[a-f0-9]{64}$/u.test(value.agentPathDigest)) return false;
  if (value.kind === 'spawn') {
    return sameKeys(value, SPAWN_ACTIVATION_KEYS) && safeIdentifier(value.taskName);
  }
  if (value.kind === 'reactivate') {
    return sameKeys(value, REACTIVATE_ACTIVATION_KEYS) && safeIdentifier(value.executorAgentId);
  }
  if (value.kind === 'legacy-adopt') {
    return sameKeys(value, LEGACY_ADOPT_ACTIVATION_KEYS) && safeIdentifier(value.childThreadId);
  }
  if (value.kind === 'legacy-bound') {
    return sameKeys(value, LEGACY_BOUND_ACTIVATION_KEYS) && safeIdentifier(value.childThreadId)
      && /^[a-f0-9]{64}$/u.test(value.bindingKey);
  }
  return false;
}

/** @param {any} activation @param {unknown} proof @param {string} executorAgentId */
function activationProofMatches(activation, proof, executorAgentId) {
  if (!plain(proof) || proof.kind !== activation.kind
    || proof.agentPathDigest !== activation.agentPathDigest) return false;
  if (activation.kind === 'spawn') {
    return sameKeys(proof, SPAWN_ACTIVATION_KEYS) && proof.taskName === activation.taskName;
  }
  if (activation.kind === 'reactivate') {
    return sameKeys(proof, REACTIVATE_PROOF_KEYS) && executorAgentId === activation.executorAgentId;
  }
  const keys = activation.kind === 'legacy-adopt'
    ? LEGACY_ADOPT_ACTIVATION_KEYS : LEGACY_BOUND_ACTIVATION_KEYS;
  return sameKeys(proof, keys) && executorAgentId === activation.childThreadId
    && proof.childThreadId === activation.childThreadId
    && (activation.kind !== 'legacy-bound' || proof.bindingKey === activation.bindingKey);
}

/** @param {any} input */
function validateTurnInput(input) {
  if (!plain(input) || !nonempty(input.sessionId) || !nonempty(input.turnId) || !nonempty(input.workspace)) {
    throw invalidPreparation();
  }
}

/** @param {any} input */
function validateSessionInput(input) {
  if (!plain(input) || !nonempty(input.sessionId) || !nonempty(input.workspace)) throw invalidPreparation();
}

/** @param {string} dataRoot @param {string} workspace */
async function preparationStorage(dataRoot, workspace) {
  const storage = await resolveWorkspaceStorage({ dataRoot, workspace });
  const invocationsDirectory = join(storage.directory, 'invocations');
  const directory = join(invocationsDirectory, 'prepared');
  await ensurePrivateDirectoryWithin(storage.directory, invocationsDirectory);
  await ensurePrivateDirectoryWithin(storage.directory, directory);
  const lockPath = join(storage.directory, '.rescue-preparation-lock');
  const lockIdentity = await preparationLockIdentity(lockPath);
  return {
    ...storage,
    privateRoot: storage.directory,
    invocationsDirectory,
    directory,
    lockPath,
    lockDirectoryIdentity: lockIdentity.directory,
    lockFileIdentity: lockIdentity.file,
    invocationsIdentity: await lstat(invocationsDirectory, { bigint: true }),
    directoryIdentity: await lstat(directory, { bigint: true }),
  };
}

/** @template T @param {any} storage @param {()=>Promise<T>} operation @param {{beforeLockOpen?:()=>Promise<void>,signal?:AbortSignal}} [options] @returns {Promise<T>} */
async function withPreparationLock(storage, operation, options = {}) {
  return withFileLock(storage.lockPath, async () => {
    assertLockIdentity(storage);
    await assertStorageIdentity(storage);
    try {
      const result = await operation();
      assertLockIdentity(storage);
      await assertStorageIdentity(storage);
      return result;
    } catch (error) {
      assertLockIdentity(storage);
      await assertStorageIdentity(storage);
      throw error;
    }
  }, options);
}

/** @param {AbortSignal|undefined} signal */
function lockCancellation(signal) {
  if (signal === undefined) return {
    signal: undefined,
    detach() {},
    linearize() {},
  };
  signal.throwIfAborted();
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(signal.reason);
  signal.addEventListener('abort', forwardAbort, { once: true });
  let attached = true;
  const detach = () => {
    if (!attached) return;
    attached = false;
    signal.removeEventListener('abort', forwardAbort);
  };
  return {
    signal: controller.signal,
    detach,
    linearize() {
      signal.throwIfAborted();
      detach();
    },
  };
}

/** @param {string} lockPath */
async function preparationLockIdentity(lockPath) {
  try { return currentLockIdentity(lockPath); }
  catch (error) {
    if (/** @type {any} */ (error)?.code !== 'ENOENT') throw error;
    await withFileLock(lockPath, async () => {});
    return currentLockIdentity(lockPath);
  }
}

/** @param {string} lockPath */
function currentLockIdentity(lockPath) {
  const directory = lstatSync(lockPath, { bigint: true });
  const file = lstatSync(join(lockPath, 'advisory.lock'), { bigint: true });
  if (!directory.isDirectory() || !file.isFile()) throw invalidRecord();
  return { directory, file };
}

/** @param {any} storage */
function assertLockIdentity(storage) {
  const current = currentLockIdentity(storage.lockPath);
  if (!sameDirectoryIdentity(storage.lockDirectoryIdentity, current.directory)
    || !sameDirectoryIdentity(storage.lockFileIdentity, current.file)) throw invalidRecord();
}

/** @param {any} storage @param {string} path */
async function unlinkPreparedRecord(storage, path) {
  await assertStorageIdentity(storage);
  assertLockIdentity(storage);
  const invocations = lstatSync(storage.invocationsDirectory, { bigint: true });
  const directory = lstatSync(storage.directory, { bigint: true });
  const record = lstatSync(path, { bigint: true });
  if (!record.isFile()
    || !sameDirectoryIdentity(storage.invocationsIdentity, invocations)
    || !sameDirectoryIdentity(storage.directoryIdentity, directory)) throw invalidRecord();
  unlinkSync(path);
}

/** @param {any} storage */
async function assertStorageIdentity(storage) {
  await ensurePrivateDirectoryWithin(storage.privateRoot, storage.invocationsDirectory);
  await ensurePrivateDirectoryWithin(storage.privateRoot, storage.directory);
  const [invocations, directory] = await Promise.all([
    lstat(storage.invocationsDirectory, { bigint: true }),
    lstat(storage.directory, { bigint: true }),
  ]);
  if (!invocations.isDirectory() || !directory.isDirectory()
    || !sameDirectoryIdentity(storage.invocationsIdentity, invocations)
    || !sameDirectoryIdentity(storage.directoryIdentity, directory)) throw invalidRecord();
}

/** @param {import('node:fs').BigIntStats} left @param {import('node:fs').BigIntStats} right */
function sameDirectoryIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

/** @param {string} sessionId @param {string} turnId @param {string} workspace */
function preparationKey(sessionId, turnId, workspace) {
  return createHash('sha256').update(JSON.stringify([sessionId, turnId, workspace, 'rescue'])).digest('hex');
}

/** @param {any} record */
function cloneRecord(record) {
  return {
    ...record,
    envelope: validateRescuePreparation(record.envelope),
    ...(record.activation === null || record.activation === undefined
      ? {} : { activation: { ...record.activation } }),
  };
}

/** @param {any} receipt */
function freezeLegacyReceipt(receipt) {
  Object.freeze(receipt.envelope.options);
  Object.freeze(receipt.envelope);
  Object.freeze(receipt.activation);
  return Object.freeze(receipt);
}

/** @param {string} path */
async function exists(path) {
  try { await lstat(path); return true; } catch (error) {
    if (/** @type {any} */ (error)?.code === 'ENOENT') return false;
    throw error;
  }
}

/** @param {unknown} value */
function nonempty(value) {
  return typeof value === 'string' && value.trim().length > 0 && Buffer.byteLength(value) <= RESCUE_TASK_MAX_BYTES;
}

/** @param {unknown} value @param {number} [maximumBytes] */
function safeIdentifier(value, maximumBytes = 512) {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= maximumBytes
    && ![...value].some((character) => {
      const code = /** @type {number} */ (character.codePointAt(0));
      return code <= 31 || code === 127;
    });
}

/** @param {unknown} value */
function digest(value) { return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value); }

/** @param {unknown} value */
function canonicalWorkspace(value) {
  return typeof value === 'string' && isAbsolute(value) && normalize(value) === value
    && Buffer.byteLength(value) <= 4096 && !/[\0\r\n]/u.test(value);
}

/** @param {unknown} value */
function validDate(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

/** @param {Date|number|string|undefined} now */
function timestamp(now) {
  const value = now === undefined ? Date.now() : new Date(now).getTime();
  if (!Number.isFinite(value)) throw invalidPreparation();
  return value;
}

function invalidRecord() {
  return preparationError('RESCUE_PREPARATION_RECORD_INVALID', 'A persisted Rescue preparation record is invalid.');
}

function storageError() {
  return preparationError('RESCUE_PREPARATION_STORAGE_FAILED', 'Rescue preparation storage could not be read safely.');
}

/** @param {string} code @param {string} message */
function preparationError(code, message) {
  return new PluginError(code, message, {
    category: 'authorization',
    remedy: 'Prepare Rescue again from the active parent turn.',
  });
}

/** @param {string} text */
function rejectDuplicateObjectKeys(text) {
  let offset = 0;
  const whitespace = () => { while (/\s/u.test(text[offset] ?? '')) offset += 1; };
  const string = () => {
    if (text[offset] !== '"') throw invalidPreparation();
    const start = offset++;
    let escaped = false;
    while (offset < text.length) {
      const character = text[offset++];
      if (escaped) { escaped = false; continue; }
      if (character === '\\') { escaped = true; continue; }
      if (character === '"') {
        try { return JSON.parse(text.slice(start, offset)); } catch { throw invalidPreparation(); }
      }
    }
    throw invalidPreparation();
  };
  const value = () => {
    whitespace();
    if (text[offset] === '{') return object();
    if (text[offset] === '[') return array();
    if (text[offset] === '"') { string(); return; }
    const start = offset;
    while (offset < text.length && !/[\s,\]}]/u.test(text[offset])) offset += 1;
    if (offset === start) throw invalidPreparation();
  };
  const object = () => {
    offset += 1; whitespace();
    const keys = new Set();
    if (text[offset] === '}') { offset += 1; return; }
    while (offset < text.length) {
      whitespace(); const key = string(); whitespace();
      if (keys.has(key)) throw invalidPreparation();
      keys.add(key);
      if (text[offset++] !== ':') throw invalidPreparation();
      value(); whitespace();
      if (text[offset] === '}') { offset += 1; return; }
      if (text[offset++] !== ',') throw invalidPreparation();
    }
    throw invalidPreparation();
  };
  const array = () => {
    offset += 1; whitespace();
    if (text[offset] === ']') { offset += 1; return; }
    while (offset < text.length) {
      value(); whitespace();
      if (text[offset] === ']') { offset += 1; return; }
      if (text[offset++] !== ',') throw invalidPreparation();
    }
    throw invalidPreparation();
  };
  whitespace(); value(); whitespace();
  if (offset !== text.length) throw invalidPreparation();
}

/** @param {unknown} value */
function validModel(value) {
  return typeof value === 'string' && value.trim().length > 0
    && Buffer.byteLength(value) <= 512 && ![...value].some((character) => {
      const codePoint = character.charCodeAt(0);
      return codePoint <= 31 || codePoint >= 127 && codePoint <= 159;
    });
}

/** @param {Record<string, unknown>} value @param {readonly string[]} keys */
function sameKeys(value, keys) {
  return Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}

/** @param {unknown} value @returns {value is Record<string, any>} */
function plain(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function invalidPreparation() {
  return new PluginError('RESCUE_PREPARATION_INVALID', 'The Rescue preparation is invalid.', {
    category: 'authorization',
    remedy: 'Prepare one valid Rescue envelope for the active parent turn.',
  });
}
