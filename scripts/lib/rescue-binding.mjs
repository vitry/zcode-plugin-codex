import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, normalize, relative, sep } from 'node:path';

import { PluginError } from './errors.mjs';
import { samePathHandleFileSnapshot } from './fs.mjs';
import { PERMISSION_MODES } from './identity.mjs';

export const RESCUE_BINDING_VERSION = 1;
export const RESCUE_BINDING_MAX_BYTES = 16 * 1024;
export const RESCUE_BINDING_MAX_RECORDS = 1024;
export const RESCUE_BINDING_PARTITION_MAX_BYTES = 16 * 1024 * 1024;
export const RESCUE_BINDING_PARTITION_VERSION = 1;
export const RESCUE_BINDING_AUTHORITY_MAX_BYTES = 16 * 1024;

const KEYS = [
  'anchorJobId', 'closeReason', 'closedAt', 'createdAt', 'currentJobId',
  'executorAgentId', 'executorAgentType', 'key', 'operationId', 'parentSessionId', 'permissionMode',
  'state', 'updatedAt', 'version', 'workspace',
];
const CLOSE_REASONS = new Set(['fresh', 'session-ended', 'invalidated']);
const EXECUTOR_AGENT_TYPES = new Set(['zcode-rescue', 'default']);

/** @param {{parentSessionId:string,executorAgentId:string,workspace:string}} input */
export function rescueBindingKey(input) {
  validateIdentity(input);
  return createHash('sha256').update(JSON.stringify([
    `rescue-binding-v${RESCUE_BINDING_VERSION}`,
    input.parentSessionId,
    input.executorAgentId,
    input.workspace,
  ])).digest('hex');
}

/** @param {{parentSessionId:string,workspace:string}} input */
export function rescueBindingPartitionKey(input) {
  validatePartitionIdentity(input);
  return createHash('sha256').update(JSON.stringify(['rescue-binding-session-v1', input.parentSessionId, input.workspace])).digest('hex');
}

/** @param {any} input */
export function createRescueBinding(input) {
  validateIdentity(input);
  if (!PERMISSION_MODES.includes(input.permissionMode) || !EXECUTOR_AGENT_TYPES.has(input.executorAgentType) || !digest(input.anchorJobId) || !digest(input.currentJobId) || !digest(input.operationId)) throw invalidBinding();
  const now = timestamp(input.now);
  return {
    version: RESCUE_BINDING_VERSION,
    key: rescueBindingKey(input),
    operationId: input.operationId,
    state: 'active',
    parentSessionId: input.parentSessionId,
    executorAgentId: input.executorAgentId,
    executorAgentType: input.executorAgentType,
    workspace: input.workspace,
    permissionMode: input.permissionMode,
    anchorJobId: input.anchorJobId,
    currentJobId: input.currentJobId,
    createdAt: now,
    updatedAt: now,
    closedAt: null,
    closeReason: null,
  };
}

/** @param {any} record @param {{operationId:string,reason:string,now?:Date|number|string}} input */
export function closeRescueBinding(record, input) {
  const active = validateRescueBinding(record);
  if (active.state !== 'active' || input?.operationId !== active.operationId) throw staleBinding();
  if (!CLOSE_REASONS.has(input.reason)) throw invalidBinding();
  const now = timestamp(input.now);
  if (Date.parse(now) < Date.parse(active.updatedAt)) throw invalidBinding();
  return { ...active, state: 'closed', updatedAt: now, closedAt: now, closeReason: input.reason };
}

/** @param {{parentSessionId:string,workspace:string,records:any[]}} input */
export function createRescueBindingPartition(input) {
  validatePartitionIdentity(input);
  if (!Array.isArray(input.records) || input.records.length > RESCUE_BINDING_MAX_RECORDS) throw invalidBinding();
  const records = []; const keys = new Set(); const executors = new Set();
  for (const candidate of input.records) {
    const record = validateRescueBinding(candidate);
    if (record.parentSessionId !== input.parentSessionId || record.workspace !== input.workspace || keys.has(record.key) || executors.has(record.executorAgentId)) throw invalidBinding();
    keys.add(record.key); executors.add(record.executorAgentId); records.push(record);
  }
  records.sort((left, right) => left.key.localeCompare(right.key));
  const partition = { version: RESCUE_BINDING_PARTITION_VERSION, key: rescueBindingPartitionKey(input), parentSessionId: input.parentSessionId, workspace: input.workspace, records };
  if (persistedBytes(partition) > RESCUE_BINDING_PARTITION_MAX_BYTES) throw invalidBinding();
  return structuredClone(partition);
}

/** @param {string|Buffer} bytes @param {{parentSessionId:string,workspace:string}} expected */
export function parseRescueBindingPartition(bytes, expected) {
  let text;
  try { text = Buffer.isBuffer(bytes) ? new TextDecoder('utf-8', { fatal: true }).decode(bytes) : bytes; } catch { throw invalidBinding(); }
  if (typeof text !== 'string' || !text.endsWith('\n') || Buffer.byteLength(text) > RESCUE_BINDING_PARTITION_MAX_BYTES) throw invalidBinding();
  rejectDuplicateObjectKeys(text);
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw invalidBinding(); }
  validatePartitionIdentity(expected);
  if (!plain(parsed) || Object.keys(parsed).sort().join('\0') !== ['key', 'parentSessionId', 'records', 'version', 'workspace'].sort().join('\0')
    || parsed.version !== RESCUE_BINDING_PARTITION_VERSION || parsed.parentSessionId !== expected.parentSessionId
    || parsed.workspace !== expected.workspace || parsed.key !== rescueBindingPartitionKey(expected) || !Array.isArray(parsed.records)) throw invalidBinding();
  const entries = /** @type {any[]} */ (parsed.records);
  if (entries.length > RESCUE_BINDING_MAX_RECORDS) throw invalidBinding();
  if (entries.some((record, index) => index > 0 && entries[index - 1]?.key >= record?.key)) throw invalidBinding();
  return createRescueBindingPartition({ parentSessionId: parsed.parentSessionId, workspace: parsed.workspace,
    records: entries });
}

/** @param {{parentSessionId:string,workspace:string,createdAt?:string}} input */
export function createRescueBindingAuthority(input) {
  validatePartitionIdentity(input); const createdAt = timestamp(input.createdAt);
  const authority = { version: RESCUE_BINDING_PARTITION_VERSION, key: rescueBindingPartitionKey(input), parentSessionId: input.parentSessionId, workspace: input.workspace, createdAt };
  if (persistedBytes(authority) > RESCUE_BINDING_AUTHORITY_MAX_BYTES) throw invalidBinding();
  return authority;
}

/** @param {string|Buffer} bytes @param {{parentSessionId:string,workspace:string}} expected */
export function parseRescueBindingAuthority(bytes, expected) {
  let text; try { text = Buffer.isBuffer(bytes) ? new TextDecoder('utf-8', { fatal: true }).decode(bytes) : bytes; } catch { throw invalidBinding(); }
  if (typeof text !== 'string' || !text.endsWith('\n') || Buffer.byteLength(text) > RESCUE_BINDING_AUTHORITY_MAX_BYTES) throw invalidBinding(); rejectDuplicateObjectKeys(text);
  let parsed; try { parsed = JSON.parse(text); } catch { throw invalidBinding(); }
  validatePartitionIdentity(expected);
  if (!plain(parsed) || Object.keys(parsed).sort().join('\0') !== ['createdAt', 'key', 'parentSessionId', 'version', 'workspace'].sort().join('\0')
    || parsed.version !== RESCUE_BINDING_PARTITION_VERSION || parsed.key !== rescueBindingPartitionKey(expected)
    || parsed.parentSessionId !== expected.parentSessionId || parsed.workspace !== expected.workspace
    || !canonicalTimestamp(parsed.createdAt)) throw invalidBinding();
  return { ...parsed };
}

/** @param {string|Buffer} bytes @param {{parentSessionId:string,executorAgentId:string,executorAgentType?:string,workspace:string,permissionMode?:string}} [expected] */
export function parseRescueBinding(bytes, expected) {
  let text;
  try { text = Buffer.isBuffer(bytes) ? new TextDecoder('utf-8', { fatal: true }).decode(bytes) : bytes; } catch { throw invalidBinding(); }
  if (typeof text !== 'string' || Buffer.byteLength(text) > RESCUE_BINDING_MAX_BYTES) throw invalidBinding();
  rejectDuplicateObjectKeys(text);
  let record;
  try { record = JSON.parse(text); } catch { throw invalidBinding(); }
  const valid = validateRescueBinding(record);
  const identity = expected ?? valid;
  validateIdentity(identity);
  if (valid.key !== rescueBindingKey(identity)
    || valid.parentSessionId !== identity.parentSessionId
    || valid.executorAgentId !== identity.executorAgentId
    || identity.executorAgentType !== undefined && valid.executorAgentType !== identity.executorAgentType
    || valid.workspace !== identity.workspace
    || identity.permissionMode !== undefined && valid.permissionMode !== identity.permissionMode) throw invalidBinding();
  return { ...valid };
}

/** Read one exact binding without following symlinks or accepting replacement races. @param {string} root @param {string} path @param {any} [expected] */
export async function readRescueBindingFile(root, path, expected) {
  return parseRescueBinding(await readExactPrivateFile(root, path, RESCUE_BINDING_MAX_BYTES), expected);
}

/** @param {string} root @param {string} path @param {{parentSessionId:string,workspace:string}} expected */
export async function readRescueBindingPartitionFile(root, path, expected) {
  return parseRescueBindingPartition(await readExactPrivateFile(root, path, RESCUE_BINDING_PARTITION_MAX_BYTES), expected);
}

/** @param {string} root @param {string} path @param {{parentSessionId:string,workspace:string}} expected */
export async function readRescueBindingAuthorityFile(root, path, expected) {
  return parseRescueBindingAuthority(await readExactPrivateFile(root, path, RESCUE_BINDING_AUTHORITY_MAX_BYTES), expected);
}

/** @param {string} root @param {string} path @param {number} maximumBytes */
async function readExactPrivateFile(root, path, maximumBytes) {
  const parent = dirname(path);
  const [canonicalRoot, canonicalParent, rootBefore, parentBefore, pathBefore] = await Promise.all([
    realpath(root), realpath(parent), lstat(root, { bigint: true }), lstat(parent, { bigint: true }), lstat(path, { bigint: true }),
  ]);
  const descendant = relative(canonicalRoot, canonicalParent);
  if (!rootBefore.isDirectory() || !parentBefore.isDirectory() || pathBefore.isSymbolicLink() || !pathBefore.isFile()
    || pathBefore.size > BigInt(maximumBytes) || descendant === '..' || descendant.startsWith(`..${sep}`) || isAbsolute(descendant)) throw invalidBinding();
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const handleBefore = await handle.stat({ bigint: true });
    if (!handleBefore.isFile() || handleBefore.size > BigInt(maximumBytes)
      || !samePathHandleFileSnapshot(pathBefore, handleBefore)) throw invalidBinding();
    const bytes = Buffer.alloc(maximumBytes + 1); let offset = 0;
    while (offset < bytes.length) { const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset); if (!bytesRead) break; offset += bytesRead; }
    const [handleAfter, pathAfter, parentAfter, rootAfter] = await Promise.all([
      handle.stat({ bigint: true }), lstat(path, { bigint: true }), lstat(parent, { bigint: true }), lstat(root, { bigint: true }),
    ]);
    if (offset > maximumBytes || pathAfter.isSymbolicLink() || !pathAfter.isFile()
      || !sameSnapshot(handleBefore, handleAfter) || !sameSnapshot(pathBefore, pathAfter)
      || !samePathHandleFileSnapshot(pathAfter, handleAfter) || !sameDirectory(rootBefore, rootAfter) || !sameDirectory(parentBefore, parentAfter)) throw invalidBinding();
    return bytes.subarray(0, offset);
  } finally { await handle?.close().catch(() => {}); }
}

/** @param {any} record */
export function validateRescueBinding(record) {
  if (!plain(record) || Object.keys(record).sort().join('\0') !== [...KEYS].sort().join('\0')
    || record.version !== RESCUE_BINDING_VERSION || !digest(record.key) || !digest(record.operationId)
    || !EXECUTOR_AGENT_TYPES.has(record.executorAgentType)
    || !PERMISSION_MODES.includes(record.permissionMode)
    || !['active', 'closed'].includes(record.state) || !digest(record.anchorJobId) || !digest(record.currentJobId)
    || !canonicalTimestamp(record.createdAt) || !canonicalTimestamp(record.updatedAt)
    || Date.parse(record.updatedAt) < Date.parse(record.createdAt)) throw invalidBinding();
  validateIdentity(record);
  if (record.key !== rescueBindingKey(record)) throw invalidBinding();
  if (record.state === 'active' ? record.closedAt !== null || record.closeReason !== null
    : !canonicalTimestamp(record.closedAt) || !CLOSE_REASONS.has(record.closeReason)
      || Date.parse(record.closedAt) !== Date.parse(record.updatedAt)) throw invalidBinding();
  return { ...record };
}

/** @param {any} input */
function validateIdentity(input) {
  if (!plain(input) || !safeIdentifier(input.parentSessionId, 4096)
    || !safeIdentifier(input.executorAgentId, 512)
    || typeof input.workspace !== 'string' || !isAbsolute(input.workspace) || normalize(input.workspace) !== input.workspace
    || Buffer.byteLength(input.workspace) > 4096 || /[\0\r\n]/u.test(input.workspace)
    || input.permissionMode !== undefined && !PERMISSION_MODES.includes(input.permissionMode)) throw invalidBinding();
}

/** @param {any} input */
function validatePartitionIdentity(input) {
  if (!plain(input) || !safeIdentifier(input.parentSessionId, 4096)
    || typeof input.workspace !== 'string' || !isAbsolute(input.workspace) || normalize(input.workspace) !== input.workspace
    || Buffer.byteLength(input.workspace) > 4096 || /[\0\r\n]/u.test(input.workspace)) throw invalidBinding();
}

/** @param {unknown} value @param {number} maximumBytes */
function safeIdentifier(value, maximumBytes) {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= maximumBytes
    && ![...value].some((character) => { const code = /** @type {number} */ (character.codePointAt(0)); return code <= 31 || code === 127; });
}
/** @param {unknown} value */
function digest(value) { return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value); }
/** @param {unknown} value */
function canonicalTimestamp(value) { return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value; }
/** @param {unknown} value */
function persistedBytes(value) { return Buffer.byteLength(`${JSON.stringify(value, null, 2)}\n`); }
/** @param {unknown} value */
function plain(value) { if (!value || typeof value !== 'object' || Array.isArray(value)) return false; const prototype = Object.getPrototypeOf(value); return prototype === Object.prototype || prototype === null; }
/** @param {Date|number|string|undefined} value */
function timestamp(value) { const milliseconds = value === undefined ? Date.now() : new Date(value).getTime(); if (!Number.isFinite(milliseconds)) throw invalidBinding(); return new Date(milliseconds).toISOString(); }
/** @param {import('node:fs').BigIntStats} left @param {import('node:fs').BigIntStats} right */
function sameDirectory(left, right) { return left.isDirectory() && right.isDirectory() && left.dev === right.dev && left.ino === right.ino; }
/** @param {import('node:fs').BigIntStats} left @param {import('node:fs').BigIntStats} right */
function sameSnapshot(left, right) { return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs; }

/** @param {string} text */
function rejectDuplicateObjectKeys(text) {
  let offset = 0;
  const whitespace = () => { while (/\s/u.test(text[offset] ?? '')) offset += 1; };
  const string = () => { if (text[offset] !== '"') throw invalidBinding(); const start = offset++; let escaped = false; while (offset < text.length) { const character = text[offset++]; if (escaped) { escaped = false; continue; } if (character === '\\') { escaped = true; continue; } if (character === '"') { try { return JSON.parse(text.slice(start, offset)); } catch { throw invalidBinding(); } } } throw invalidBinding(); };
  const value = () => { whitespace(); if (text[offset] === '{') return object(); if (text[offset] === '[') return array(); if (text[offset] === '"') { string(); return; } const start = offset; while (offset < text.length && !/[\s,\]}]/u.test(text[offset])) offset += 1; if (offset === start) throw invalidBinding(); };
  const object = () => { offset += 1; whitespace(); const keys = new Set(); if (text[offset] === '}') { offset += 1; return; } while (offset < text.length) { whitespace(); const key = string(); whitespace(); if (keys.has(key)) throw invalidBinding(); keys.add(key); if (text[offset++] !== ':') throw invalidBinding(); value(); whitespace(); if (text[offset] === '}') { offset += 1; return; } if (text[offset++] !== ',') throw invalidBinding(); } throw invalidBinding(); };
  const array = () => { offset += 1; whitespace(); if (text[offset] === ']') { offset += 1; return; } while (offset < text.length) { value(); whitespace(); if (text[offset] === ']') { offset += 1; return; } if (text[offset++] !== ',') throw invalidBinding(); } throw invalidBinding(); };
  whitespace(); value(); whitespace(); if (offset !== text.length) throw invalidBinding();
}

function invalidBinding() { return new PluginError('RESCUE_BINDING_INVALID', 'The private Rescue operation binding is invalid.', { category: 'authorization', remedy: 'Start a fresh Rescue operation from the active parent turn.' }); }
function staleBinding() { return new PluginError('RESCUE_BINDING_STALE', 'The Rescue operation generation changed.', { category: 'state', remedy: 'Reload the exact Rescue binding before retrying.' }); }
