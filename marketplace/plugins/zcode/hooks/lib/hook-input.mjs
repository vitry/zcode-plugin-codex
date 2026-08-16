// @ts-nocheck
import { realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import process from 'node:process';

const MAX_BYTES = 64 * 1024;
const DEADLINE_MS = 2_000;
const PERMISSIONS = new Set(['default', 'acceptEdits', 'plan', 'dontAsk', 'bypassPermissions']);
const COMMON = ['session_id', 'transcript_path', 'cwd', 'hook_event_name'];
const WITH_MODEL = [...COMMON, 'model'];
const EVENTS = Object.freeze({
  SessionStart: { fields: [...WITH_MODEL, 'permission_mode', 'source'], required: ['session_id', 'cwd', 'hook_event_name', 'model', 'permission_mode', 'source'] },
  UserPromptSubmit: { fields: [...WITH_MODEL, 'turn_id', 'permission_mode', 'prompt', 'agent_id', 'agent_type'], required: ['session_id', 'turn_id', 'cwd', 'hook_event_name', 'model', 'permission_mode', 'prompt'] },
  SubagentStart: { fields: [...WITH_MODEL, 'turn_id', 'permission_mode', 'agent_id', 'agent_type'], required: ['session_id', 'turn_id', 'cwd', 'hook_event_name', 'model', 'permission_mode', 'agent_id', 'agent_type'] },
  SubagentStop: { fields: [...WITH_MODEL, 'turn_id', 'permission_mode', 'agent_id', 'agent_type', 'agent_transcript_path', 'stop_hook_active', 'last_assistant_message'], required: ['session_id', 'turn_id', 'cwd', 'hook_event_name', 'model', 'permission_mode', 'agent_id', 'agent_type', 'stop_hook_active'] },
  Stop: { fields: [...WITH_MODEL, 'turn_id', 'permission_mode', 'stop_hook_active', 'last_assistant_message'], required: ['session_id', 'turn_id', 'cwd', 'hook_event_name', 'model', 'permission_mode', 'stop_hook_active'] },
  SessionEnd: { fields: [...COMMON, 'reason'], required: ['session_id', 'cwd', 'hook_event_name', 'reason'] },
});

export async function readHookInput(expectedEvent, options = {}) {
  const expected = Array.isArray(expectedEvent) ? expectedEvent : [expectedEvent];
  if (!expected.length || expected.some((event) => !Object.hasOwn(EVENTS, event))) throw inputError();
  const raw = await readBounded(options.stream ?? process.stdin, options.maxBytes ?? MAX_BYTES, options.deadlineMs ?? DEADLINE_MS);
  let input;
  try { input = JSON.parse(raw); } catch { throw inputError(); }
  if (!plain(input) || !expected.includes(input.hook_event_name)) throw inputError();
  const actualEvent = input.hook_event_name; const contract = EVENTS[actualEvent];
  if (Object.keys(input).some((key) => !contract.fields.includes(key)) || contract.required.some((key) => !Object.hasOwn(input, key))) throw inputError();
  for (const key of ['session_id', 'turn_id', 'model', 'agent_id', 'agent_type']) if (input[key] !== undefined && !identifier(input[key])) throw inputError();
  for (const key of ['prompt', 'last_assistant_message']) if (input[key] !== undefined && input[key] !== null && !boundedString(input[key], 64 * 1024)) throw inputError();
  for (const key of ['transcript_path', 'agent_transcript_path']) if (input[key] !== undefined && input[key] !== null && !boundedString(input[key], 4096)) throw inputError();
  if (!boundedString(input.cwd, 4096) || !isAbsolute(input.cwd) || input.permission_mode !== undefined && !PERMISSIONS.has(input.permission_mode)) throw inputError();
  if (input.stop_hook_active !== undefined && typeof input.stop_hook_active !== 'boolean') throw inputError();
  if (actualEvent === 'UserPromptSubmit' && Object.hasOwn(input, 'agent_id') !== Object.hasOwn(input, 'agent_type')) throw inputError();
  if (actualEvent === 'SessionStart' && !['startup', 'resume', 'clear', 'compact'].includes(input.source)) throw inputError();
  if (actualEvent === 'SessionEnd' && input.reason !== 'other') throw inputError();
  input.cwd = await realpath(input.cwd).catch(() => { throw inputError(); });
  return input;
}

function readBounded(stream, maxBytes, deadlineMs) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_BYTES || !Number.isSafeInteger(deadlineMs) || deadlineMs <= 0 || deadlineMs > 10_000) return Promise.reject(inputError());
  return new Promise((resolve, reject) => {
    let value = ''; let bytes = 0; let done = false;
    const finish = (error) => { if (done) return; done = true; clearTimeout(timer); stream.removeAllListeners('data'); stream.removeAllListeners('end'); stream.removeAllListeners('error'); if (error) reject(error); else resolve(value); };
    const timer = setTimeout(() => finish(inputError()), deadlineMs); timer.unref?.();
    stream.on('data', (chunk) => { bytes += Buffer.byteLength(chunk); if (bytes > maxBytes) finish(inputError()); else value += chunk.toString('utf8'); });
    stream.once('error', () => finish(inputError())); stream.once('end', () => finish());
  });
}
function identifier(value) { return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 512 && ![...value].some((character) => { const code = character.codePointAt(0); return code <= 31 || code === 127; }); }
function boundedString(value, max) { return typeof value === 'string' && Buffer.byteLength(value) <= max && !control(value); }
function control(value) { return [...value].some((character) => { const code = character.codePointAt(0); return code < 32 && ![9, 10, 13].includes(code) || code === 127; }); }
function plain(value) { if (!value || typeof value !== 'object' || Array.isArray(value)) return false; const proto = Object.getPrototypeOf(value); return proto === Object.prototype || proto === null; }
function inputError() { return Object.assign(new Error('Invalid bounded Codex hook input.'), { code: 'HOOK_INPUT_INVALID' }); }
