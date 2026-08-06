import { createHash } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { PluginError } from './errors.mjs';
import { atomicWriteJson, ensurePrivateDirectory, readJsonFile, withFileLock } from './fs.mjs';
import { PERMISSION_MODES } from './identity.mjs';
import { resolveWorkspaceStorage } from './workspace.mjs';

const PUBLIC_COMMANDS = new Set(['review', 'adversarial-review', 'rescue', 'transfer', 'status', 'result', 'cancel']);
const PENDING_LIFETIME_MS = 30 * 60_000;

/** Parse arguments from the recorded prompt without evaluating any shell syntax. @param {string} command @param {string} prompt */
export function parseRecordedInvocation(command, prompt) {
  validateCommand(command); if (typeof prompt !== 'string' || Buffer.byteLength(prompt) > 64 * 1024) throw invocationError('RECORDED_PROMPT_INVALID', 'The recorded prompt is invalid.');
  const marker = `$zcode:${command}`; const match = new RegExp(`(?:^|\\s)${escapeRegExp(marker)}(?=$|\\s)`).exec(prompt);
  if (match) {
    const rest = prompt.slice(match.index + match[0].length).trim();
    return { argv: [command, ...tokenize(rest)], explicit: true };
  }
  if (command === 'rescue') return { argv: [command, prompt], explicit: false };
  if (command === 'adversarial-review') return { argv: [command, prompt], explicit: false };
  return { argv: [command], explicit: false, ...(command === 'review' ? { implicitText: prompt } : {}) };
}

/** @param {{dataRoot:string}} options */
export function createInvocationStore({ dataRoot }) {
  if (typeof dataRoot !== 'string' || !dataRoot) throw invocationError('DATA_ROOT_REQUIRED', 'A plugin data root is required.');
  return {
    /** @param {{sessionId:string,turnId:string,workspace:string,permissionMode:string,command:string,spec:{argv:string[]},now?:Date|number|string}} input */
    async savePending(input) {
      validatePendingInput(input); const storage = await pendingStorage(dataRoot, input.workspace); const key = pendingKey(input.sessionId, storage.workspacePath, input.command); const createdAt = timestamp(input.now);
      await withFileLock(storage.lockPath, () => atomicWriteJson(join(storage.directory, `${key}.json`), { key, sessionId: input.sessionId, originatingTurnId: input.turnId, workspace: storage.workspacePath, permissionMode: input.permissionMode, command: input.command, spec: normalizeSpec(input.spec), createdAt: new Date(createdAt).toISOString(), expiresAt: new Date(createdAt + PENDING_LIFETIME_MS).toISOString() }));
    },
    /** @param {{sessionId:string,workspace:string,command:string,choice:string,now?:Date|number|string}} input */
    async consumePending(input) {
      validateChoiceInput(input); const storage = await pendingStorage(dataRoot, input.workspace); const key = pendingKey(input.sessionId, storage.workspacePath, input.command); const path = join(storage.directory, `${key}.json`);
      return withFileLock(storage.lockPath, async () => {
        let record; try { record = await readJsonFile(path); } catch (error) { if (error instanceof PluginError && error.code === 'JSON_READ_FAILED' && /** @type {any} */ (error.cause)?.code === 'ENOENT') throw pendingNotFound(error); throw error; }
        if (!validPending(record) || record.key !== key || record.sessionId !== input.sessionId || record.workspace !== storage.workspacePath || record.command !== input.command) throw pendingNotFound();
        if (timestamp(input.now) >= Date.parse(record.expiresAt)) { await unlink(path).catch(() => {}); throw invocationError('PENDING_INVOCATION_EXPIRED', 'The pending invocation has expired.'); }
        await unlink(path);
        return {
          argv: [record.command, `--${input.choice}`, ...record.spec.argv.slice(1)],
          caller: { sessionId: record.sessionId, turnId: record.originatingTurnId, workspace: record.workspace, permissionMode: record.permissionMode },
        };
      });
    },
  };
}

/** @param {string} command @param {string[]} argv */
export function requiresExecutionChoice(command, argv) { return ['review', 'adversarial-review'].includes(command) && !argv.includes('--wait') && !argv.includes('--background'); }

/** @param {string} text */
function tokenize(text) {
  const tokens = []; let token = ''; let quote = null; let escaped = false; let started = false;
  for (const character of text) {
    if (escaped) { token += character; escaped = false; started = true; continue; }
    if (character === '\\' && quote !== "'") { escaped = true; started = true; continue; }
    if (quote) { if (character === quote) quote = null; else token += character; started = true; continue; }
    if (character === "'" || character === '"') { quote = character; started = true; continue; }
    if (/\s/.test(character)) { if (started) { tokens.push(token); token = ''; started = false; } continue; }
    token += character; started = true;
  }
  if (escaped || quote) throw invocationError('RECORDED_PROMPT_INVALID', 'The recorded invocation contains an incomplete quote or escape.');
  if (started) tokens.push(token); return tokens;
}

/** @param {string} dataRoot @param {string} workspace */
async function pendingStorage(dataRoot, workspace) { const storage = await resolveWorkspaceStorage({ dataRoot, workspace }); const directory = join(storage.directory, 'invocations', 'pending'); await ensurePrivateDirectory(directory); return { ...storage, directory, lockPath: join(storage.directory, 'invocations', '.lock') }; }
/** @param {string} sessionId @param {string} workspace @param {string} command */
function pendingKey(sessionId, workspace, command) { return createHash('sha256').update(JSON.stringify([sessionId, workspace, command])).digest('hex'); }
/** @param {any} input */
function validatePendingInput(input) { if (!plain(input) || !nonempty(input.sessionId) || !nonempty(input.turnId) || !nonempty(input.workspace) || !PERMISSION_MODES.includes(input.permissionMode) || !PUBLIC_COMMANDS.has(input.command)) throw invocationError('PENDING_INVOCATION_INVALID', 'The pending invocation is invalid.'); normalizeSpec(input.spec); }
/** @param {any} input */
function validateChoiceInput(input) { if (!plain(input) || !nonempty(input.sessionId) || !nonempty(input.workspace) || !PUBLIC_COMMANDS.has(input.command) || !allowedChoice(input.command, input.choice)) throw invocationError('INVOCATION_CHOICE_INVALID', 'The invocation choice is invalid.'); }
/** @param {string} command @param {string} choice */
function allowedChoice(command, choice) { return command === 'rescue' ? ['resume', 'fresh'].includes(choice) : ['review', 'adversarial-review'].includes(command) && ['wait', 'background'].includes(choice); }
/** @param {any} spec */
function normalizeSpec(spec) { if (!plain(spec) || Object.keys(spec).length !== 1 || !Array.isArray(spec.argv) || spec.argv.some((/** @type {unknown} */ value) => typeof value !== 'string') || !PUBLIC_COMMANDS.has(spec.argv[0])) throw invocationError('PENDING_INVOCATION_INVALID', 'The pending invocation is invalid.'); return { argv: [...spec.argv] }; }
/** @param {any} value */
function validPending(value) { return plain(value) && /^[a-f0-9]{64}$/.test(value.key) && nonempty(value.sessionId) && nonempty(value.originatingTurnId) && nonempty(value.workspace) && PERMISSION_MODES.includes(value.permissionMode) && PUBLIC_COMMANDS.has(value.command) && validDate(value.createdAt) && validDate(value.expiresAt) && Date.parse(value.expiresAt) > Date.parse(value.createdAt) && (() => { try { normalizeSpec(value.spec); return true; } catch { return false; } })(); }
/** @param {string} command */
function validateCommand(command) { if (!PUBLIC_COMMANDS.has(command)) throw invocationError('INVOCATION_COMMAND_INVALID', 'The direct companion command is invalid.'); }
/** @param {unknown} value */
function nonempty(value) { return typeof value === 'string' && value.trim().length > 0 && Buffer.byteLength(value) <= 64 * 1024; }
/** @param {unknown} value */
function validDate(value) { return typeof value === 'string' && Number.isFinite(Date.parse(value)); }
/** @param {any} value */
function plain(value) { if (!value || typeof value !== 'object' || Array.isArray(value)) return false; const prototype = Object.getPrototypeOf(value); return prototype === Object.prototype || prototype === null; }
/** @param {Date|number|string|undefined} now */
function timestamp(now) { const value = now === undefined ? Date.now() : new Date(now).getTime(); if (!Number.isFinite(value)) throw invocationError('TIME_INVALID', 'The supplied time is invalid.'); return value; }
/** @param {unknown} [cause] */
function pendingNotFound(cause) { return new PluginError('PENDING_INVOCATION_NOT_FOUND', 'No pending invocation matches this session, workspace, and command.', { category: 'authorization', remedy: 'Repeat the original command in this Codex thread.', cause }); }
/** @param {string} code @param {string} message */
function invocationError(code, message) { return new PluginError(code, message, { category: 'authorization', remedy: 'Invoke the installed skill from the active Codex turn.' }); }
/** @param {string} value */
function escapeRegExp(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
