#!/usr/bin/env node
// @ts-nocheck
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, readFile, unlink } from 'node:fs/promises';
import net from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PluginError } from './lib/errors.mjs';
import { atomicWriteJson, ensurePrivateDirectory, withFileLock } from './lib/fs.mjs';
import { spawnDaemon } from './lib/process.mjs';
import { connectZCodeBroker, spawnZCodeProtocol } from './lib/zcode-protocol.mjs';
import { resolveWorkspaceStorage } from './lib/workspace.mjs';

const MAX_LOCAL_FRAME_BYTES = 1024 * 1024;

/** @param {{platform?:string,dataRoot:string,workspace:string,identity?:string}} options */
export function brokerEndpointFor(options) {
  if (!options || typeof options.dataRoot !== 'string' || !options.dataRoot || typeof options.workspace !== 'string' || !options.workspace) throw brokerInputError();
  const platform = options.platform ?? process.platform;
  const digest = createHash('sha256').update(JSON.stringify([options.dataRoot, options.workspace, options.identity ?? 'shared'])).digest('hex').slice(0, 32);
  if (platform === 'win32') return `\\\\.\\pipe\\zcode-${digest}`;
  if (platform !== 'darwin' && platform !== 'linux') throw brokerInputError();
  return join('/tmp', `zcode-${typeof process.getuid === 'function' ? process.getuid() : 'user'}`, `${digest}.sock`);
}

/** @param {string} path @param {{endpoint:string,pid?:number,instanceId?:string,brokerToken?:string}} input */
export async function writeBrokerIdentity(path, input) {
  if (!input || typeof input.endpoint !== 'string') throw brokerInputError();
  const record = { version: 1, endpoint: input.endpoint, pid: input.pid ?? process.pid, instanceId: input.instanceId ?? randomBytes(24).toString('hex'), brokerToken: input.brokerToken ?? randomBytes(32).toString('hex'), createdAt: new Date().toISOString() };
  await ensurePrivateDirectory(dirname(path));
  await atomicWriteJson(path, record);
  return record;
}

/** @param {string} path @param {{isProcessAlive?:(pid:number)=>boolean,healthProbe?:(record:any)=>Promise<boolean>}} [options] */
export async function readHealthyBrokerIdentity(path, options = {}) {
  let value;
  try { value = JSON.parse(await readFile(path, 'utf8')); } catch { return null; }
  if (!value || value.version !== 1 || !Number.isSafeInteger(value.pid) || value.pid <= 0 || typeof value.instanceId !== 'string' || value.instanceId.length < 32 || typeof value.brokerToken !== 'string' || value.brokerToken.length < 32 || typeof value.endpoint !== 'string') return null;
  const alive = options.isProcessAlive ?? isProcessAlive;
  if (!alive(value.pid)) return null;
  const healthProbe = options.healthProbe ?? probeBrokerHealth;
  if (!await healthProbe(value)) return null;
  return value;
}

/** @param {{endpoint:string,brokerToken:string,pid:number,instanceId:string}} record */
export async function probeBrokerHealth(record) {
  let protocol;
  try {
    protocol = await connectZCodeBroker(record.endpoint, { brokerToken: record.brokerToken, requestTimeoutMs: 1_000 });
    const result = await protocol.request('broker/health', {});
    return result?.ok === true && result.pid === record.pid && result.instanceId === record.instanceId;
  } catch { return false; } finally { await protocol?.close().catch(() => {}); }
}

/** @param {{dataRoot:string,workspace:string,launch:{command:string,args:string[],target?:string},env?:NodeJS.ProcessEnv,platform?:string,idleTimeoutMs?:number}} options */
export async function ensureZCodeBroker(options) {
  const storage = await resolveWorkspaceStorage(options);
  const brokerDirectory = join(storage.directory, 'broker');
  const identityPath = join(brokerDirectory, 'identity.json');
  await ensurePrivateDirectory(brokerDirectory);
  return withFileLock(join(brokerDirectory, '.lock'), async () => {
    const existing = await readHealthyBrokerIdentity(identityPath);
    if (existing) return existing;
    const instanceId = randomBytes(24).toString('hex');
    const brokerToken = randomBytes(32).toString('hex');
    const endpoint = brokerEndpointFor({ platform: options.platform, dataRoot: options.dataRoot, workspace: storage.workspacePath });
    if ((options.platform ?? process.platform) !== 'win32') await unlink(endpoint).catch(() => {});
    const configPath = join(brokerDirectory, `config-${instanceId}.json`);
    await atomicWriteJson(configPath, { endpoint, instanceId, brokerToken, launch: options.launch, workspace: storage.workspacePath, idleTimeoutMs: options.idleTimeoutMs });
    const child = await spawnDaemon({ command: process.execPath, args: [fileURLToPath(import.meta.url)], target: fileURLToPath(import.meta.url) }, { args: [configPath], cwd: storage.workspacePath, env: options.env });
    const record = await writeBrokerIdentity(identityPath, { endpoint, pid: child.pid, instanceId, brokerToken });
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if (await probeBrokerHealth(record)) return record;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    try { process.kill(child.pid, 'SIGTERM'); } catch { /* already exited */ }
    throw new PluginError('ZCODE_BROKER_START_FAILED', 'The ZCode broker failed its startup health probe.', { category: 'runtime', remedy: 'Retry or run $zcode:setup.' });
  });
}

export class ZCodeBroker {
  /** @param {{endpoint:string,launch:{command:string,args:string[],target?:string},workspace:string,env?:NodeJS.ProcessEnv,idleTimeoutMs?:number,maxFrameBytes?:number}} options */
  constructor(options) { if (typeof options?.brokerToken !== 'string' || options.brokerToken.length < 32) throw brokerInputError(); this.options = options; this.server = null; this.protocol = null; this.protocolPromise = null; this.sockets = new Set(); this.authenticated = new WeakSet(); this.sessionOwners = new Map(); this.permissionPending = new Map(); this.nextPermissionId = 1_000_000_000; this.owners = 0; this.activeSessions = new Set(); this.idleTimer = null; }

  async start() {
    if (this.server) return this;
    if (process.platform !== 'win32') await ensurePrivateDirectory(dirname(this.options.endpoint));
    this.server = net.createServer((socket) => this.accept(socket));
    await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(this.options.endpoint, resolve); });
    if (process.platform !== 'win32') await chmod(this.options.endpoint, 0o600);
    return this;
  }

  accept(socket) {
    this.sockets.add(socket); this.owners += 1; clearTimeout(this.idleTimer); socket.setEncoding('utf8'); let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > (this.options.maxFrameBytes ?? MAX_LOCAL_FRAME_BYTES) && !buffer.includes('\n')) { socket.destroy(); return; }
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); newline = buffer.indexOf('\n');
        if (Buffer.byteLength(line) > (this.options.maxFrameBytes ?? MAX_LOCAL_FRAME_BYTES)) { socket.destroy(); return; }
        void this.handleLocal(socket, line);
      }
    });
    socket.once('close', () => { this.sockets.delete(socket); for (const [sessionId, owner] of this.sessionOwners) if (owner === socket) this.sessionOwners.delete(sessionId); this.owners -= 1; this.scheduleIdleShutdown(); });
  }

  async handleLocal(socket, line) {
    let frame;
    try { frame = JSON.parse(line); } catch { socket.destroy(); return; }
    if (!this.authenticated.has(socket)) {
      if (!frame || !Number.isSafeInteger(frame.id) || frame.method !== 'broker/auth'
        || typeof frame.params?.token !== 'string' || !safeTokenEqual(frame.params.token, this.options.brokerToken)) {
        writeLocal(socket, { id: Number.isSafeInteger(frame?.id) ? frame.id : 0, error: { code: -32040, message: 'Broker authentication failed.' } });
        socket.end(); return;
      }
      this.authenticated.add(socket); writeLocal(socket, { id: frame.id, result: { authenticated: true } }); return;
    }
    if (frame && Number.isSafeInteger(frame.id) && !frame.method && (Object.hasOwn(frame, 'result') || Object.hasOwn(frame, 'error'))) {
      const pending = this.permissionPending.get(frame.id);
      if (!pending || pending.socket !== socket) { socket.destroy(); return; }
      this.permissionPending.delete(frame.id); clearTimeout(pending.timer);
      if (frame.error) pending.reject(new Error('Permission handler failed.')); else pending.resolve(frame.result);
      return;
    }
    if (!frame || !Number.isSafeInteger(frame.id) || typeof frame.method !== 'string' || !frame.params || typeof frame.params !== 'object') { socket.destroy(); return; }
    if (frame.method === 'broker/health') { writeLocal(socket, { id: frame.id, result: { ok: true, pid: process.pid, instanceId: this.options.instanceId } }); return; }
    const requestedSessionId = frame.params.sessionId;
    const existingOwner = typeof requestedSessionId === 'string' ? this.sessionOwners.get(requestedSessionId) : null;
    if (existingOwner && existingOwner !== socket || typeof requestedSessionId === 'string' && !existingOwner && frame.method !== 'session/resume') {
      writeLocal(socket, { id: frame.id, error: { code: -32041, message: 'Session is not owned by this broker client.' } }); return;
    }
    try {
      const protocol = await this.getProtocol();
      let result = await protocol.request(frame.method, frame.params);
      if (frame.method === 'session/create' && result?.session?.sessionId) this.sessionOwners.set(result.session.sessionId, socket);
      if (['session/resume', 'session/send'].includes(frame.method) && frame.params.sessionId) this.sessionOwners.set(frame.params.sessionId, socket);
      if (frame.method === 'session/send' && frame.params.sessionId) this.activeSessions.add(frame.params.sessionId);
      if (frame.method === 'session/stop' && frame.params.sessionId) this.activeSessions.delete(frame.params.sessionId);
      if (frame.method === 'session/list' && Array.isArray(result?.sessions)) result = { ...result, sessions: result.sessions.filter((session) => this.sessionOwners.get(session.sessionId) === socket) };
      writeLocal(socket, { id: frame.id, result });
    } catch (error) {
      const pluginError = error instanceof PluginError ? { code: error.code, category: error.category, remedy: error.remedy, details: error.details } : null;
      writeLocal(socket, { id: frame.id, error: { code: -32000, message: error instanceof Error ? error.message : 'Broker request failed', ...(pluginError ? { data: { pluginError } } : {}) } });
    }
  }

  scheduleIdleShutdown() { if (this.owners || this.activeSessions.size) return; this.idleTimer = setTimeout(() => void this.close(), this.options.idleTimeoutMs ?? 30_000); this.idleTimer.unref?.(); }

  async getProtocol() {
    if (this.protocol) return this.protocol;
    this.protocolPromise ??= spawnZCodeProtocol(this.options.launch, { cwd: this.options.workspace, env: this.options.env, maxFrameBytes: this.options.maxFrameBytes });
    this.protocol = await this.protocolPromise;
    this.protocol.subscribe((message) => {
      if (message.method === 'state.updated' && message.params?.scope === 'session'
        && ['prompt_completed', 'prompt_cancelled', 'prompt_failed'].includes(message.params.reason)) {
        this.activeSessions.delete(message.params.sessionId);
        this.scheduleIdleShutdown();
      }
      const sessionOwner = message.params?.sessionId ? this.sessionOwners.get(message.params.sessionId) : null;
      if (message.params?.sessionId) { if (sessionOwner) writeLocal(sessionOwner, message); }
      else for (const socket of this.sockets) writeLocal(socket, message);
    });
    this.protocol.setPermissionHandler((request) => this.requestPermission(request));
    return this.protocol;
  }

  async requestPermission(request) {
    const socket = this.sessionOwners.get(request.sessionId);
    if (!socket?.writable) return { decision: 'deny', reason: 'The owning client is unavailable.' };
    const id = this.nextPermissionId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.permissionPending.delete(id); resolve({ decision: 'deny', reason: 'Permission response timed out.' }); }, 30_000);
      timer.unref?.(); this.permissionPending.set(id, { socket, resolve, reject, timer });
      writeLocal(socket, { id, method: 'interaction/requestPermission', params: request });
    });
  }

  async close() {
    clearTimeout(this.idleTimer); for (const pending of this.permissionPending.values()) { clearTimeout(pending.timer); pending.reject(new Error('Broker closed.')); } this.permissionPending.clear(); for (const socket of this.sockets) socket.destroy(); this.sockets.clear();
    if (this.server) await new Promise((resolve) => this.server.close(() => resolve()));
    this.server = null; await this.protocol?.close(); this.protocol = null; this.protocolPromise = null;
  }
}

function writeLocal(socket, value) { if (socket.writable) socket.write(`${JSON.stringify(value)}\n`); }
function isProcessAlive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
function safeTokenEqual(left, right) { const a = Buffer.from(left); const b = Buffer.from(right); return a.length === b.length && timingSafeEqual(a, b); }
function brokerInputError() { return new PluginError('ZCODE_BROKER_INPUT_INVALID', 'ZCode broker input is invalid.', { category: 'validation', remedy: 'Provide a data root, workspace, endpoint, and launch target.' }); }

async function main() {
  const configPath = process.argv[2];
  if (!configPath) throw brokerInputError();
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const broker = await new ZCodeBroker(config).start();
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => void broker.close().finally(() => process.exit(0)));
}

const isEntrypoint = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isEntrypoint) main().catch((error) => { process.stderr.write(`ZCode broker failed: ${error instanceof Error ? error.message : 'unknown error'}\n`); process.exitCode = 1; });
