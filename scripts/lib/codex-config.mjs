// @ts-nocheck
import { spawn } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { PluginError } from './errors.mjs';
import { atomicWriteJson } from './fs.mjs';
import { discoverZCode } from './zcode-discovery.mjs';
import { createZCodeClient } from './zcode-client.mjs';
import { resolveWorkspaceStorage } from './workspace.mjs';

const EXPECTED_EVENTS = new Set(['sessionStart', 'userPromptSubmit', 'subagentStart', 'subagentStop', 'stop', 'sessionEnd']);
const EXPECTED_COMMANDS = new Map([['sessionStart', 'node "$PLUGIN_ROOT/hooks/session-lifecycle-hook.mjs"'], ['userPromptSubmit', 'node "$PLUGIN_ROOT/hooks/user-prompt-hook.mjs"'], ['subagentStart', 'node "$PLUGIN_ROOT/hooks/subagent-hook.mjs"'], ['subagentStop', 'node "$PLUGIN_ROOT/hooks/subagent-hook.mjs"'], ['stop', 'node "$PLUGIN_ROOT/hooks/stop-review-gate-hook.mjs"'], ['sessionEnd', 'node "$PLUGIN_ROOT/hooks/session-end-hook.mjs"']]);

export async function runSetup(input) {
  validateSetupInput(input); const pluginRoot = await trustedRoot(input.pluginRoot); const cwd = await realpath(input.cwd); const hooksPath = await realpath(join(pluginRoot, 'hooks', 'hooks.json'));
  let discovery;
  try { discovery = await (input.dependencies?.discoverZCode ?? discoverZCode)({ explicitPath: input.env.ZCODE_PATH, env: input.env }); }
  catch (error) { if (error?.code === 'ZCODE_NOT_FOUND' || error?.code === 'ZCODE_VERSION_UNSUPPORTED') return reportAndPersist(input, { path: null, version: null }, { ready: false }, error.code === 'ZCODE_NOT_FOUND' ? 'missing' : 'outdated', error.message, false); throw error; }
  let client;
  try {
    client = await startClient({ ...input.codex, cwd, env: input.env }); const config = await client.request('config/read', { cwd, includeLayers: true }); const hooks = await client.request('hooks/list', { cwds: [cwd] }); const inspected = await validateHooks(hooks, cwd, pluginRoot, hooksPath);
    if (!inspected.ok) return reportAndPersist(input, discovery, { ready: false }, 'untrusted', inspected.reason, false);
    const auth = await probeAuth(input, discovery, cwd); if (!auth.ready) return reportAndPersist(input, discovery, auth, 'unauthenticated', 'ZCode model authentication is unavailable.', false);
    const edits = []; if (config?.config?.features?.hooks !== true) edits.push({ keyPath: 'features.hooks', value: true, mergeStrategy: 'upsert' }); const trust = {}; for (const hook of inspected.hooks) if (!['trusted', 'managed'].includes(hook.trustStatus)) trust[hook.key] = { trusted_hash: hook.currentHash }; if (Object.keys(trust).length) edits.push({ keyPath: 'hooks.state', value: trust, mergeStrategy: 'upsert' });
    let status = 'ready'; if (edits.length) { await client.request('config/batchWrite', { edits, expectedVersion: userVersion(config), reloadUserConfig: true }); status = 'restart-required'; }
    return reportAndPersist(input, discovery, auth, status, null, true);
  } finally { await client?.close().catch(() => {}); }
}

async function reportAndPersist(input, discovery, auth, status, reason, setupReady) {
  const storage = await resolveWorkspaceStorage({ dataRoot: input.dataRoot, workspace: input.cwd }); const enabled = input.reviewGate ?? await priorGateEnabled(storage.directory); const gate = { version: 1, enabled, setupReady, status }; await atomicWriteJson(join(storage.directory, 'config', 'review-gate.json'), gate);
  return { status, ...(reason ? { reason } : {}), zcode: { path: discovery.path, version: discovery.version }, auth, hooks: { ready: setupReady }, reviewGate: { enabled } };
}
async function priorGateEnabled(workspaceDirectory) { try { const { readJsonFile } = await import('./fs.mjs'); return (await readJsonFile(join(workspaceDirectory, 'config', 'review-gate.json'))).enabled === true; } catch { return false; } }

async function trustedRoot(value) { let actual; let supplied; try { actual = await realpath(resolve(new URL('../..', import.meta.url).pathname)); supplied = await realpath(value); } catch (cause) { throw rootError(cause); } if (actual !== supplied) throw rootError(); return actual; }
function rootError(cause) { return new PluginError('PLUGIN_ROOT_UNTRUSTED', 'PLUGIN_ROOT does not identify this active plugin installation.', { category: 'authorization', remedy: 'Invoke setup from the installed ZCode plugin.', ...(cause ? { cause } : {}) }); }
async function validateHooks(result, cwd, pluginRoot, hooksPath) {
  const entry = Array.isArray(result?.data) ? result.data.find((item) => item?.cwd === cwd) : null; if (!entry || !Array.isArray(entry.hooks) || entry.errors?.length) return { ok: false, reason: 'missing-or-invalid-hooks' };
  const ownHooks = [];
  for (const hook of entry.hooks) {
    if (hook?.source !== 'plugin') continue;
    let sourcePath; try { sourcePath = await realpath(hook.sourcePath); } catch { continue; }
    if (sourcePath === hooksPath && sourcePath.startsWith(`${pluginRoot}/`) && typeof hook.pluginId === 'string' && /^zcode-plugin-codex@[A-Za-z0-9_-]+$/.test(hook.pluginId)) ownHooks.push({ ...hook, sourcePath });
  }
  if (ownHooks.length !== EXPECTED_EVENTS.size) return { ok: false, reason: 'missing-or-invalid-hooks' };
  const seen = new Set();
  for (const hook of ownHooks) { if (hook.handlerType !== 'command' || hook.command !== EXPECTED_COMMANDS.get(hook.eventName) || !hook.enabled || !EXPECTED_EVENTS.has(hook.eventName) || seen.has(hook.eventName) || typeof hook.key !== 'string' || !hook.key || control(hook.key) || typeof hook.currentHash !== 'string' || !/^[a-f0-9]{64}$/.test(hook.currentHash) || !['managed', 'untrusted', 'trusted', 'modified'].includes(hook.trustStatus)) return { ok: false, reason: 'foreign-or-outdated-hooks' }; seen.add(hook.eventName); }
  return { ok: seen.size === EXPECTED_EVENTS.size, hooks: ownHooks };
}
function userVersion(config) { const layer = Array.isArray(config?.layers) ? config.layers.find((item) => item?.name?.type === 'user') : null; if (typeof layer?.version !== 'string' || !layer.version) throw new PluginError('CODEX_CONFIG_VERSION_MISSING', 'Codex user config version is unavailable.', { category: 'protocol', remedy: 'Restart Codex and rerun $zcode:setup.' }); return layer.version; }
async function probeAuth(input, discovery, cwd) { let client; let sessionId; try { client = await createZCodeClient({ workspace: cwd, launch: discovery.launch, env: input.env, requestTimeoutMs: 2_000 }); const snapshot = await client.createSession({ workspace: cwd }); sessionId = snapshot.session.sessionId; return { ready: true }; } catch { return { ready: false }; } finally { if (sessionId) await client?.stopSession(sessionId).catch(() => {}); await client?.close().catch(() => {}); } }

async function startClient(options) {
  const executable = options.executable ?? 'codex'; const args = options.args ?? ['app-server']; const child = spawn(executable, args, { cwd: options.cwd, env: options.env, shell: false, stdio: ['pipe', 'pipe', 'pipe'] }); let nextId = 1; const pending = new Map(); let stderr = ''; let closed = false; let stdoutBytes = 0; let buffer = Buffer.alloc(0);
  child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-8192); }); child.stdout.on('data', (chunk) => { if (closed) return; const bytes = Buffer.from(chunk); stdoutBytes += bytes.length; if (stdoutBytes > 8 * 1024 * 1024) return failAll(protocolError('Codex app-server output exceeded its limit.')); buffer = Buffer.concat([buffer, bytes]); if (buffer.length > 2 * 1024 * 1024 && buffer.indexOf(10) < 0) return failAll(protocolError('Codex app-server frame exceeded its limit.')); while (buffer.length) { const newline = buffer.indexOf(10); if (newline < 0) break; const line = buffer.subarray(0, newline); buffer = buffer.subarray(newline + 1); if (!line.length) continue; let value; try { value = JSON.parse(line.toString('utf8')); } catch { failAll(protocolError('Codex app-server emitted malformed JSON.')); return; } if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, 'id')) continue; const request = pending.get(value.id); if (!request) continue; pending.delete(value.id); clearTimeout(request.timer); if (value.error || !value.result || typeof value.result !== 'object' || Array.isArray(value.result)) request.reject(requestError(request.method)); else request.resolve(value.result); } });
  const streamError = () => failAll(protocolError('Codex app-server stream failed.')); child.stdout.once('error', streamError); child.stderr.once('error', streamError); child.stdin.once('error', streamError); child.once('error', (cause) => failAll(new PluginError('CODEX_CONFIG_SPAWN_FAILED', 'Could not start Codex app-server.', { category: 'configuration', remedy: 'Install a compatible Codex CLI.', cause }))); child.once('exit', () => { if (!closed) failAll(protocolError('Codex app-server disconnected.')); });
  const request = (method, params) => new Promise((resolvePromise, reject) => { const id = nextId++; const timer = setTimeout(() => { pending.delete(id); reject(protocolError(`Codex app-server timed out during ${method}.`)); }, options.timeoutMs ?? 15_000); pending.set(id, { method, resolve: resolvePromise, reject, timer }); const frame = `${JSON.stringify({ id, method, params })}\n`; if (Buffer.byteLength(frame) > 1024 * 1024 || !child.stdin.writable) { clearTimeout(timer); pending.delete(id); reject(protocolError('Codex app-server request was not writable.')); return; } child.stdin.write(frame); });
  const close = async () => { if (closed) return; closed = true; failAll(protocolError('Codex app-server closed.')); child.stdin.end(); if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); if (!await waitExit(child, 1_000) && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await waitExit(child, 1_000); child.stdout.removeAllListeners(); child.stderr.removeAllListeners(); child.stdin.removeAllListeners(); };
  try { await request('initialize', { clientInfo: { name: 'zcode-plugin-codex', title: 'ZCode plugin for Codex', version: '0.1.0' }, capabilities: null }); child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`); }
  catch (error) { await close(); throw error; }
  return { request, close, stderr: () => stderr };
  function failAll(error) { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); } pending.clear(); }
}
function waitExit(child, milliseconds) { if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true); return new Promise((resolvePromise) => { const timer = setTimeout(() => { child.off('exit', exited); resolvePromise(false); }, milliseconds); timer.unref?.(); const exited = () => { clearTimeout(timer); resolvePromise(true); }; child.once('exit', exited); }); }
function requestError(method) { return new PluginError('CODEX_CONFIG_REQUEST_FAILED', `Codex app-server ${method} failed.`, { category: 'configuration', remedy: 'Restart Codex and rerun $zcode:setup.' }); }
function protocolError(message) { return new PluginError('CODEX_CONFIG_PROTOCOL_FAILED', message, { category: 'protocol', remedy: 'Restart Codex and rerun $zcode:setup.' }); }
function validateSetupInput(input) { if (!input || typeof input !== 'object' || typeof input.pluginRoot !== 'string' || typeof input.dataRoot !== 'string' || !input.dataRoot || typeof input.cwd !== 'string' || !input.cwd || !input.env || typeof input.env !== 'object' || input.reviewGate !== undefined && typeof input.reviewGate !== 'boolean' || input.dependencies !== undefined && (typeof input.dependencies !== 'object' || input.dependencies === null || input.dependencies.discoverZCode !== undefined && typeof input.dependencies.discoverZCode !== 'function')) throw new PluginError('SETUP_INPUT_INVALID', 'Setup input is invalid.', { category: 'validation', remedy: 'Invoke $zcode:setup from the installed skill.' }); }
function control(value) { return [...value].some((character) => { const code = character.codePointAt(0); return code < 32 || code === 127; }); }
