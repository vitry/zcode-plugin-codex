#!/usr/bin/env node
// @ts-nocheck
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, readFile, unlink } from 'node:fs/promises';
import net from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PluginError } from './lib/errors.mjs';
import { atomicWriteJson, ensurePrivateDirectory, withFileLock } from './lib/fs.mjs';
import { isSafeIdentifier } from './lib/identifier.mjs';
import { spawnDaemon } from './lib/process.mjs';
import { BoundedWriter, connectZCodeBroker, spawnZCodeProtocol } from './lib/zcode-protocol.mjs';
import { resolveWorkspaceStorage } from './lib/workspace.mjs';

const MAX_LOCAL_FRAME_BYTES = 1024 * 1024;
const OWNER_RELEASE_MAX_SESSIONS = 16;
const OWNER_RELEASE_CONCURRENCY = 8;
const OWNER_RELEASE_BUDGET_MS = 600;
const OWNER_RELEASE_REQUEST_MS = 250;
const MAX_PRIORITIZE_LOCK_TIMEOUT_MS = 5_000;

/**
 * Reconciles broker ownership from authorization-bound durable state.
 * `ownedSessionIds` is a trusted-boundary input: callers must populate it only
 * from validated durable job records already bound to the same workspace,
 * session, and consumed caller/execution capability.
 * @param {{dataRoot:string,workspace:string,ownerId:string,ownedSessionIds:string[]}} options
 */
export async function reconcileBrokerOwnership(options) {
  if (!options || typeof options.dataRoot !== 'string' || !options.dataRoot || typeof options.workspace !== 'string' || !options.workspace || typeof options.ownerId !== 'string' || options.ownerId.length < 16 || !Array.isArray(options.ownedSessionIds) || !options.ownedSessionIds.every((sessionId) => typeof sessionId === 'string' && sessionId.length > 0)) throw brokerInputError();
  const storage = await resolveWorkspaceStorage(options); const ownershipPath = join(storage.directory, 'broker', 'session-owners.json');
  return mutateOwnerStore(ownershipPath, true, async (sessions) => {
    for (const sessionId of new Set(options.ownedSessionIds)) {
      if (Object.hasOwn(sessions, sessionId) && sessions[sessionId] !== options.ownerId) throw ownerConflict();
      sessions[sessionId] = options.ownerId;
    }
    await atomicWriteJson(ownershipPath, { version: 1, sessions });
    return { reconciledSessionIds: [...new Set(options.ownedSessionIds)] };
  });
}

/** Moves exact-owner mappings to the front without changing the durable ownership set or values. */
export async function prioritizeBrokerOwnership(options) {
  if (!options || typeof options.dataRoot !== 'string' || !options.dataRoot || typeof options.workspace !== 'string' || !options.workspace || typeof options.identityName !== 'string' || !/^identity(?:-[a-f0-9]{16})?\.json$/.test(options.identityName) || typeof options.ownerId !== 'string' || options.ownerId.length < 16 || !Array.isArray(options.sessionIds) || options.sessionIds.length > 1_000 || !options.sessionIds.every((sessionId) => isSafeIdentifier(sessionId)) || !Number.isSafeInteger(options.lockTimeoutMs) || options.lockTimeoutMs < 0 || options.lockTimeoutMs > MAX_PRIORITIZE_LOCK_TIMEOUT_MS) throw brokerInputError();
  const storage = await resolveWorkspaceStorage(options); const ownershipPath = join(storage.directory, 'broker', options.identityName.replace(/^identity/, 'session-owners'));
  return mutateOwnerStore(ownershipPath, false, async (sessions) => { const prioritizedSessionIds = [...new Set(options.sessionIds)].filter((sessionId) => sessions[sessionId] === options.ownerId); const reordered = Object.create(null); for (const sessionId of prioritizedSessionIds) reordered[sessionId] = sessions[sessionId]; for (const [sessionId, ownerId] of Object.entries(sessions)) if (!Object.hasOwn(reordered, sessionId)) reordered[sessionId] = ownerId; await atomicWriteJson(ownershipPath, { version: 1, sessions: reordered }); return { prioritizedSessionIds }; }, { timeoutMs: options.lockTimeoutMs });
}

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
    protocol = await connectZCodeBroker(record.endpoint, { brokerToken: record.brokerToken, ownerId: `health-${record.instanceId}`, requestTimeoutMs: 1_000 });
    const result = await protocol.request('broker/health', {});
    return result?.ok === true && result.pid === record.pid && result.instanceId === record.instanceId;
  } catch { return false; } finally { await protocol?.close().catch(() => {}); }
}

/** @param {{dataRoot:string,workspace:string,launch:{command:string,args:string[],target?:string},env?:NodeJS.ProcessEnv,platform?:string,idleTimeoutMs?:number,maxFrameBytes?:number,maxOutboundBytes?:number}} options */
export async function ensureZCodeBroker(options) {
  if (!validWireOption(options?.maxFrameBytes, 16 * 1024 * 1024) || !validWireOption(options?.maxOutboundBytes, 64 * 1024 * 1024)) throw brokerInputError();
  const storage = await resolveWorkspaceStorage(options);
  const brokerDirectory = join(storage.directory, 'broker');
  const profile = options.maxFrameBytes === undefined && options.maxOutboundBytes === undefined ? null : createHash('sha256').update(JSON.stringify([options.maxFrameBytes ?? null, options.maxOutboundBytes ?? null])).digest('hex').slice(0, 16);
  const identityPath = join(brokerDirectory, profile ? `identity-${profile}.json` : 'identity.json');
  await ensurePrivateDirectory(brokerDirectory);
  return withFileLock(join(brokerDirectory, '.lock'), async () => {
    const existing = await readHealthyBrokerIdentity(identityPath);
    if (existing) return existing;
    const instanceId = randomBytes(24).toString('hex');
    const brokerToken = randomBytes(32).toString('hex');
    const endpoint = brokerEndpointFor({ platform: options.platform, dataRoot: options.dataRoot, workspace: storage.workspacePath, ...(profile ? { identity: profile } : {}) });
    if ((options.platform ?? process.platform) !== 'win32') await unlink(endpoint).catch(() => {});
    const configPath = join(brokerDirectory, `config-${instanceId}.json`);
    await atomicWriteJson(configPath, { endpoint, instanceId, brokerToken, launch: options.launch, workspace: storage.workspacePath, idleTimeoutMs: options.idleTimeoutMs, maxFrameBytes: options.maxFrameBytes, maxOutboundBytes: options.maxOutboundBytes, ownershipPath: join(brokerDirectory, profile ? `session-owners-${profile}.json` : 'session-owners.json'), identityPath });
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
  /** @param {{endpoint:string,brokerToken:string,launch:{command:string,args:string[],target?:string},workspace:string,env?:NodeJS.ProcessEnv,idleTimeoutMs?:number,maxFrameBytes?:number,maxOutboundBytes?:number,instanceId?:string}} options */
  constructor(options) { if (typeof options?.brokerToken !== 'string' || options.brokerToken.length < 32) throw brokerInputError(); this.options = options; this.ownershipPath = options.ownershipPath ?? `${options.endpoint}.owners.json`; this.ownershipStoreEstablished = false; this.server = null; this.protocol = null; this.protocolPromise = null; this.sockets = new Set(); this.socketWriters = new WeakMap(); this.authenticated = new WeakSet(); this.socketOwnerIds = new WeakMap(); this.sessionOwners = new Map(); this.permissionPending = new Map(); this.localTasks = new Set(); this.nextPermissionId = 1_000_000_000; this.owners = 0; this.activeSessions = new Set(); this.fastIdleRequested = false; this.idleTimer = null; this.closing = false; this.closePromise = null; }

  async start() {
    if (this.server) return this;
    await this.loadOwnership();
    if (process.platform !== 'win32') await ensurePrivateDirectory(dirname(this.options.endpoint));
    this.server = net.createServer((socket) => this.accept(socket));
    await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(this.options.endpoint, resolve); });
    if (process.platform !== 'win32') await chmod(this.options.endpoint, 0o600);
    return this;
  }

  accept(socket) {
    this.sockets.add(socket); socket.zcodeWriter = new BoundedWriter(socket, { maxQueuedBytes: this.options.maxOutboundBytes, onFailure: () => socket.destroy() }); this.socketWriters.set(socket, socket.zcodeWriter); socket.setEncoding('utf8'); let buffer = '';
    const authTimer = setTimeout(() => { if (!this.authenticated.has(socket)) socket.destroy(); }, 1_000); authTimer.unref?.();
    socket.authTimer = authTimer;
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > (this.options.maxFrameBytes ?? MAX_LOCAL_FRAME_BYTES) && !buffer.includes('\n')) { socket.destroy(); return; }
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); newline = buffer.indexOf('\n');
        if (Buffer.byteLength(line) > (this.options.maxFrameBytes ?? MAX_LOCAL_FRAME_BYTES)) { socket.destroy(); return; }
        const task = this.handleLocal(socket, line); this.localTasks.add(task); void task.then(() => { this.localTasks.delete(task); this.scheduleIdleShutdown(); }, () => { this.localTasks.delete(task); socket.destroy(); this.scheduleIdleShutdown(); });
      }
    });
    socket.once('close', () => { clearTimeout(authTimer); this.socketWriters.get(socket)?.close(); this.sockets.delete(socket); for (const [id, pending] of this.permissionPending) if (pending.socket === socket) { clearTimeout(pending.timer); this.permissionPending.delete(id); pending.resolve(offeredDeny(pending.request)); } for (const owner of this.sessionOwners.values()) if (owner.socket === socket) owner.socket = null; if (this.authenticated.has(socket)) this.owners -= 1; this.scheduleIdleShutdown(); });
  }

  async handleLocal(socket, line) {
    let frame;
    try { frame = JSON.parse(line); } catch { socket.destroy(); return; }
    if (!this.authenticated.has(socket)) {
      if (!frame || !Number.isSafeInteger(frame.id) || frame.method !== 'broker/auth'
        || typeof frame.params?.token !== 'string' || !safeTokenEqual(frame.params.token, this.options.brokerToken) || typeof frame.params.ownerId !== 'string' || frame.params.ownerId.length < 16) {
        writeLocal(socket, { id: Number.isSafeInteger(frame?.id) ? frame.id : 0, error: { code: -32040, message: 'Broker authentication failed.' } });
        socket.end(); return;
      }
      clearTimeout(socket.authTimer); this.authenticated.add(socket); this.socketOwnerIds.set(socket, frame.params.ownerId); this.owners += 1; this.cancelIdleShutdown(); writeLocal(socket, { id: frame.id, result: { authenticated: true } }); return;
    }
    if (frame && Number.isSafeInteger(frame.id) && !frame.method && (Object.hasOwn(frame, 'result') || Object.hasOwn(frame, 'error'))) {
      const pending = this.permissionPending.get(frame.id);
      if (!pending || pending.socket !== socket) { socket.destroy(); return; }
      this.permissionPending.delete(frame.id); clearTimeout(pending.timer);
      if (frame.error) pending.reject(new Error('Permission handler failed.')); else pending.resolve(frame.result);
      return;
    }
    if (!frame || !Number.isSafeInteger(frame.id) || typeof frame.method !== 'string' || !frame.params || typeof frame.params !== 'object') { socket.destroy(); return; }
    if (frame.method === 'broker/health') { writeLocal(socket, { id: frame.id, result: { ok: true, pid: process.pid, instanceId: this.options.instanceId, capabilities: { releaseOwnerExclusions: true } } }); return; }
    try { await this.reloadOwnership(); } catch (error) { writeRequestError(socket, frame.id, error); return; }
    if (frame.method === 'broker/releaseOwner') {
      try { const excluded = frame.params.excludeSessionIds ?? []; if (Object.keys(frame.params).some((key) => key !== 'excludeSessionIds') || !Array.isArray(excluded) || excluded.length > 1_000 || new Set(excluded).size !== excluded.length || !excluded.every((sessionId) => isSafeIdentifier(sessionId))) throw brokerInputError(); writeLocal(socket, { id: frame.id, result: await this.releaseOwner(socket, this.socketOwnerIds.get(socket), excluded) }); this.fastIdleRequested = true; }
      catch (error) { writeRequestError(socket, frame.id, error); }
      return;
    }
    const requestedSessionId = frame.params.sessionId;
    const ownerId = this.socketOwnerIds.get(socket); const existingOwner = typeof requestedSessionId === 'string' ? this.sessionOwners.get(requestedSessionId) : null;
    const claimMethod = frame.method === 'session/create';
    if (existingOwner && existingOwner.ownerId !== ownerId || typeof requestedSessionId === 'string' && !existingOwner && !claimMethod) {
      writeLocal(socket, { id: frame.id, error: { code: -32041, message: 'Session is not owned by this broker client.' } }); return;
    }
    let claimToken = null; const previousOwner = existingOwner ? { ...existingOwner } : null;
    if (typeof requestedSessionId === 'string' && claimMethod) { claimToken = randomBytes(16).toString('hex'); this.sessionOwners.set(requestedSessionId, { ownerId, socket, claimToken }); } else if (existingOwner?.ownerId === ownerId) existingOwner.socket = socket;
    try {
      const protocol = await this.getProtocol();
      if (frame.method === 'session/send') protocol.beginTurn(frame.params.sessionId);
      let result;
      try {
        result = await protocol.request(frame.method, frame.params);
        if (frame.method === 'session/send') { validateSendResult(result, frame.params.sessionId); this.activeSessions.add(frame.params.sessionId); protocol.armTurn(frame.params.sessionId, result.stateRevision, frame.params.inputId); }
      } catch (error) { if (frame.method === 'session/send') { protocol.abortTurn(frame.params.sessionId); this.activeSessions.delete(frame.params.sessionId); this.scheduleIdleShutdown(); } throw error; }
      if (frame.method === 'session/create' && result?.session?.sessionId) { await this.persistOwnership(result.session.sessionId, ownerId); this.sessionOwners.set(result.session.sessionId, { ownerId, socket, claimToken: null }); }
      else if (claimToken && this.sessionOwners.get(requestedSessionId)?.claimToken === claimToken) this.sessionOwners.get(requestedSessionId).claimToken = null;
      if (frame.method === 'session/stop' && frame.params.sessionId) { protocol.cancelTurn(frame.params.sessionId); this.activeSessions.delete(frame.params.sessionId); this.scheduleIdleShutdown(); }
      if (frame.method === 'session/list' && Array.isArray(result?.sessions)) result = { ...result, sessions: result.sessions.filter((session) => this.sessionOwners.get(session.sessionId)?.ownerId === ownerId) };
      writeLocal(socket, { id: frame.id, result });
    } catch (error) {
      if (claimToken && this.sessionOwners.get(requestedSessionId)?.claimToken === claimToken) { if (previousOwner) this.sessionOwners.set(requestedSessionId, previousOwner); else this.sessionOwners.delete(requestedSessionId); }
      const pluginError = error instanceof PluginError ? { code: error.code, category: error.category, remedy: error.remedy, details: error.details } : null;
      writeLocal(socket, { id: frame.id, error: { code: -32000, message: error instanceof Error ? error.message : 'Broker request failed', ...(pluginError ? { data: { pluginError } } : {}) } });
    }
  }

  cancelIdleShutdown() { clearTimeout(this.idleTimer); this.idleTimer = null; }
  scheduleIdleShutdown() { this.cancelIdleShutdown(); if (this.closing || this.owners || this.activeSessions.size || this.permissionPending.size || this.localTasks.size || this.protocolPromise && !this.protocol) return; this.idleTimer = setTimeout(() => { this.idleTimer = null; if (!this.owners && !this.activeSessions.size && !this.permissionPending.size && !this.localTasks.size && !(this.protocolPromise && !this.protocol)) void this.close().catch(() => {}); }, this.fastIdleRequested ? 0 : this.options.idleTimeoutMs ?? 30_000); this.idleTimer.unref?.(); }

  async releaseOwner(socket, ownerId, excludeSessionIds = []) {
    const excluded = new Set(excludeSessionIds); const allOwnerEntries = [...this.sessionOwners].filter(([, owner]) => owner.ownerId === ownerId); const stableOwned = allOwnerEntries.filter(([, owner]) => !owner.claimToken).map(([sessionId]) => sessionId); const eligible = stableOwned.filter((sessionId) => !excluded.has(sessionId)); const inFlightClaims = allOwnerEntries.length - stableOwned.length; const owned = eligible.slice(0, OWNER_RELEASE_MAX_SESSIONS);
    if (!owned.length) return { releasedSessionIds: [], failedSessionIds: [], deferredSessionCount: inFlightClaims };
    const released = []; const failed = [];
    if (!this.protocol) {
      if (this.protocolPromise) failed.push(...owned);
      else released.push(...owned);
    } else {
      const protocol = this.protocol; const deadline = Date.now() + OWNER_RELEASE_BUDGET_MS;
      for (let offset = 0; offset < owned.length; offset += OWNER_RELEASE_CONCURRENCY) {
        const batch = owned.slice(offset, offset + OWNER_RELEASE_CONCURRENCY); const remainingMs = deadline - Date.now();
        if (socket.destroyed || remainingMs <= 0 || this.protocol !== protocol) { failed.push(...owned.slice(offset)); break; }
        const outcomes = await Promise.allSettled(batch.map((sessionId) => protocol.request('session/stop', { sessionId }, Math.max(1, Math.min(OWNER_RELEASE_REQUEST_MS, remainingMs)))));
        for (let index = 0; index < batch.length; index += 1) {
          const sessionId = batch[index]; if (outcomes[index].status === 'fulfilled') { protocol.cancelTurn(sessionId); this.activeSessions.delete(sessionId); released.push(sessionId); } else failed.push(sessionId);
        }
      }
    }
    if (released.length) {
      const remaining = await mutateOwnerStore(this.ownershipPath, false, async (sessions) => {
        for (const sessionId of released) if (sessions[sessionId] === ownerId) delete sessions[sessionId];
        await atomicWriteJson(this.ownershipPath, { version: 1, sessions }); return sessions;
      });
      this.applyOwnership(remaining);
    }
    this.scheduleIdleShutdown();
    return { releasedSessionIds: released, failedSessionIds: failed, deferredSessionCount: eligible.length - owned.length + inFlightClaims };
  }

  async getProtocol() {
    if (this.protocol) return this.protocol;
    if (!this.protocolPromise) this.protocolPromise = spawnZCodeProtocol(this.options.launch, { cwd: this.options.workspace, env: this.options.env, maxFrameBytes: this.options.maxFrameBytes, maxOutboundBytes: this.options.maxOutboundBytes });
    const attempt = this.protocolPromise;
    try { const protocol = await attempt; if (this.closing) { await protocol.close(); throw new PluginError('ZCODE_BROKER_CLOSING', 'The ZCode broker is closing.', { category: 'state', remedy: 'Reconnect to a healthy broker.' }); } this.protocol = protocol; } catch (error) { if (this.protocolPromise === attempt) this.protocolPromise = null; this.protocol = null; this.scheduleIdleShutdown(); throw error; }
    this.protocol.subscribe((message) => {
      const sessionOwner = message.params?.sessionId ? this.sessionOwners.get(message.params.sessionId)?.socket : null;
      if (message.params?.sessionId) { if (sessionOwner) writeLocal(sessionOwner, message); }
      else for (const socket of this.sockets) if (this.authenticated.has(socket)) writeLocal(socket, message);
    });
    this.protocol.setPermissionHandler((request) => this.requestPermission(request));
    this.protocol.consumeTerminalsWith((params) => { this.activeSessions.delete(params.sessionId); this.scheduleIdleShutdown(); });
    this.protocol.setCloseHandler(() => { this.activeSessions.clear(); for (const pending of this.permissionPending.values()) { clearTimeout(pending.timer); pending.resolve(offeredDeny(pending.request)); } this.permissionPending.clear(); this.protocol = null; this.protocolPromise = null; this.scheduleIdleShutdown(); });
    return this.protocol;
  }

  async requestPermission(request) {
    const socket = this.sessionOwners.get(request.sessionId)?.socket;
    if (!socket?.writable) return offeredDeny(request);
    const id = this.nextPermissionId++;
    if (this.permissionPending.size >= 256) return offeredDeny(request);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.permissionPending.delete(id); resolve(offeredDeny(request)); }, 30_000);
      timer.unref?.(); this.permissionPending.set(id, { socket, resolve, reject, timer, request }); this.cancelIdleShutdown();
      writeLocal(socket, { id, method: 'interaction/requestPermission', params: request });
    });
  }

  close() {
    if (!this.closePromise) { this.closing = true; this.closePromise = this.closeOnce(); }
    return this.closePromise;
  }

  async closeOnce() {
    this.cancelIdleShutdown(); for (const pending of this.permissionPending.values()) { clearTimeout(pending.timer); pending.resolve(offeredDeny(pending.request)); } this.permissionPending.clear(); for (const socket of this.sockets) socket.destroy(); this.sockets.clear();
    const startingProtocol = this.protocolPromise; await this.protocol?.close().catch(() => {}); if (!this.protocol && startingProtocol) { const spawned = await startingProtocol.catch(() => null); await spawned?.close().catch(() => {}); } this.protocol = null; this.protocolPromise = null;
    await Promise.allSettled([...this.localTasks]);
    if (this.server) await new Promise((resolve) => this.server.close(() => resolve()));
    this.server = null;
    await this.removeIdentityIfOwned();
  }

  async loadOwnership() {
    const loaded = await readOwnerStore(this.ownershipPath, true); if (!loaded.exists) return; this.applyOwnership(loaded.sessions); this.ownershipStoreEstablished = true;
  }

  async persistOwnership(sessionId, ownerId) {
    await mutateOwnerStore(this.ownershipPath, !this.ownershipStoreEstablished, async (sessions) => { if (Object.hasOwn(sessions, sessionId) && sessions[sessionId] !== ownerId) throw ownerConflict(); sessions[sessionId] = ownerId; await atomicWriteJson(this.ownershipPath, { version: 1, sessions }); }); this.ownershipStoreEstablished = true;
  }

  async reloadOwnership() { const loaded = await readOwnerStore(this.ownershipPath, !this.ownershipStoreEstablished); if (!loaded.exists) return; for (const [sessionId, current] of this.sessionOwners) if (!current.claimToken && (!Object.hasOwn(loaded.sessions, sessionId) || loaded.sessions[sessionId] !== current.ownerId)) throw ownerStoreInvalid(); this.applyOwnership(loaded.sessions); this.ownershipStoreEstablished = true; }

  applyOwnership(sessions) { const next = new Map(); for (const [sessionId, ownerId] of Object.entries(sessions)) { const current = this.sessionOwners.get(sessionId); next.set(sessionId, { ownerId, socket: current?.ownerId === ownerId ? current.socket : null, claimToken: null }); } for (const [sessionId, current] of this.sessionOwners) if (current.claimToken && !next.has(sessionId)) next.set(sessionId, current); this.sessionOwners = next; }

  async removeIdentityIfOwned() {
    if (!this.options.identityPath || !this.options.instanceId) return;
    const identityPath = this.options.identityPath;
    await withFileLock(join(dirname(identityPath), '.lock'), async () => {
      let contents;
      try { contents = await readFile(identityPath, 'utf8'); }
      catch (error) { if (error?.code === 'ENOENT') return; throw identityCleanupError(identityPath, error); }
      let value;
      try { value = JSON.parse(contents); }
      catch (error) { throw identityCleanupError(identityPath, error); }
      if (!value || typeof value !== 'object' || typeof value.instanceId !== 'string') throw identityCleanupError(identityPath);
      if (value.instanceId !== this.options.instanceId) return;
      try { await unlink(identityPath); }
      catch (error) { throw identityCleanupError(identityPath, error); }
    });
  }
}

function writeLocal(socket, value) { if (!socket.writable) return; try { socket.zcodeWriter?.write(`${JSON.stringify(value)}\n`); } catch { socket.destroy(); } }
function validWireOption(value, maximum) { return value === undefined || Number.isSafeInteger(value) && value >= 128 && value <= maximum; }
function isProcessAlive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
function safeTokenEqual(left, right) { const a = Buffer.from(left); const b = Buffer.from(right); return a.length === b.length && timingSafeEqual(a, b); }
function offeredDeny(request) { return request.options?.find((option) => option.response?.decision === 'deny')?.response ?? { decision: 'deny' }; }
function validateSendResult(result, sessionId) { if (!result || typeof result !== 'object' || result.accepted !== true || result.sessionId !== sessionId || !Number.isSafeInteger(result.stateRevision) || result.stateRevision < 0 || result.modelRuntimeRevision !== undefined && (typeof result.modelRuntimeRevision !== 'string' || !result.modelRuntimeRevision)) throw new PluginError('ZCODE_OUTPUT_INVALID', 'ZCode returned an invalid session/send result.', { category: 'protocol', remedy: 'Upgrade or restart ZCode and retry.' }); }
function validOwnerStore(value) { return value && value.version === 1 && value.sessions && typeof value.sessions === 'object' && !Array.isArray(value.sessions) && Object.entries(value.sessions).every(([sessionId, ownerId]) => sessionId && typeof ownerId === 'string' && ownerId.length >= 16); }
async function readOwnerStore(path, allowMissing) { return withFileLock(`${path}.lock`, async () => readOwnerStoreUnlocked(path, allowMissing)); }
async function mutateOwnerStore(path, allowMissing, operation, lockOptions) { return withFileLock(`${path}.lock`, async () => { const loaded = await readOwnerStoreUnlocked(path, allowMissing); return operation(loaded.sessions); }, lockOptions); }
async function readOwnerStoreUnlocked(path, allowMissing) { let value; try { value = JSON.parse(await readFile(path, 'utf8')); } catch (error) { if (error?.code === 'ENOENT' && allowMissing) return { exists: false, sessions: Object.create(null) }; throw ownerStoreInvalid(error); } if (!validOwnerStore(value)) throw ownerStoreInvalid(); const sessions = Object.create(null); for (const [sessionId, ownerId] of Object.entries(value.sessions)) sessions[sessionId] = ownerId; return { exists: true, sessions }; }
function writeRequestError(socket, id, error) { const pluginError = error instanceof PluginError ? { code: error.code, category: error.category, remedy: error.remedy, details: error.details } : null; writeLocal(socket, { id, error: { code: -32000, message: error instanceof Error ? error.message : 'Broker request failed', ...(pluginError ? { data: { pluginError } } : {}) } }); }
function ownerStoreInvalid(cause) { return new PluginError('ZCODE_OWNER_STORE_INVALID', 'The ZCode session owner store is missing or corrupt.', { category: 'storage', remedy: 'Reconcile ownership from validated durable job records before resuming sessions.', ...(cause === undefined ? {} : { cause }) }); }
function ownerConflict() { return new PluginError('ZCODE_SESSION_OWNER_CONFLICT', 'The session already belongs to another broker owner.', { category: 'authorization', remedy: 'Use the original stable owner credential.' }); }
function brokerInputError() { return new PluginError('ZCODE_BROKER_INPUT_INVALID', 'ZCode broker input is invalid.', { category: 'validation', remedy: 'Provide a data root, workspace, endpoint, and launch target.' }); }
function identityCleanupError(path, cause) { return new PluginError('ZCODE_BROKER_IDENTITY_CLEANUP_FAILED', 'The ZCode broker identity could not be safely removed.', { category: 'storage', remedy: 'Inspect the broker identity path and retry cleanup.', ...(cause === undefined ? {} : { cause }), details: { path } }); }

async function main() {
  const configPath = process.argv[2];
  if (!configPath) throw brokerInputError();
  const configContents = await readFile(configPath, 'utf8');
  await unlink(configPath).catch(() => {});
  const config = JSON.parse(configContents);
  const broker = await new ZCodeBroker(config).start();
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void broker.close().then(() => process.exit(0), () => process.exit(1)); });
}

const isEntrypoint = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isEntrypoint) main().catch((error) => { process.stderr.write(`ZCode broker failed: ${error instanceof Error ? error.message : 'unknown error'}\n`); process.exitCode = 1; });
