#!/usr/bin/env node
// @ts-nocheck
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { chmod, readFile, unlink } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PluginError } from './lib/errors.mjs';
import { atomicWriteJson, ensurePrivateDirectory, withFileLock } from './lib/fs.mjs';
import { isBoundedPublicIdentifier, isSafeIdentifier } from './lib/identifier.mjs';
import { spawnDaemon } from './lib/process.mjs';
import { validCreateSnapshot } from './lib/zcode-schema.mjs';
import { BoundedWriter, closeProtocolUntil, connectZCodeBroker, MAX_DRAIN_TIMEOUT_MS, spawnZCodeProtocol } from './lib/zcode-protocol.mjs';
import { resolveWorkspaceStorage } from './lib/workspace.mjs';

const MAX_LOCAL_FRAME_BYTES = 1024 * 1024;
const OWNER_RELEASE_MAX_SESSIONS = 16;
const OWNER_RELEASE_CONCURRENCY = 8;
const OWNER_RELEASE_BUDGET_MS = 600;
const OWNER_RELEASE_REQUEST_MS = 250;
const OWNER_RELEASE_STOP_REQUEST_MS = 500;
const MAX_PRIORITIZE_LOCK_TIMEOUT_MS = 5_000;
const MAX_CONVERSATION_SUBSCRIPTIONS = 256;
const MAX_PENDING_CONVERSATION_TOPICS = 64;
const MAX_PENDING_CONVERSATION_FRAMES = 16;
const MAX_PENDING_CONVERSATION_BYTES = 1024 * 1024;
const MAX_CONVERSATION_FRAME_BYTES = 64 * 1024;
const MAX_OWNER_OPERATION_LEASES = 256;
const MAX_CONCURRENT_OWNER_RELEASES = 16;
const MAX_TERMINAL_WINNER_EVIDENCE = 256;
const RAW_ENDPOINT_PROBE_MS = 100;
export const MIN_BROKER_IDLE_TIMEOUT_MS = 1_000;
export const MAX_BROKER_IDLE_TIMEOUT_MS = 3_600_000;
const LOCAL_BROKER_METHODS = new Set(['session/create', 'session/send', 'session/read', 'session/resume', 'session/list', 'session/stop', 'session/setModel', 'session/updateRuntimeModelConfig', 'session/setThoughtLevel', 'v4/conversation/subscribe', 'v4/conversation/unsubscribe', 'broker/health', 'broker/releaseOwner']);
const OWNER_SCOPED_SESSION_METHODS = new Set(['session/read', 'session/resume', 'session/setModel', 'session/updateRuntimeModelConfig', 'session/setThoughtLevel']);
const EXCLUSIVE_SESSION_METHODS = new Set(['session/create', 'session/send', 'session/stop', 'v4/conversation/subscribe', 'v4/conversation/unsubscribe', 'broker/releaseSession']);

// One admission authority owns every transient broker fence. Durable ownership
// remains in sessionOwners, so a store reload cannot erase in-flight claims.
class BrokerAdmission {
  constructor(getDurableOwner, onChange) { this.getDurableOwner = getDurableOwner; this.onChange = onChange; this.ownerStates = new Map(); this.sessionLeases = new Map(); this.sessionClaims = new Map(); this.activeSessionCount = 0; this.activeOperationCount = 0; this.activeReleaseCount = 0; this.preflightGeneration = 0; }

  beginOwnerRequest(method, ownerId) {
    if (!['session/create', 'broker/releaseOwner'].includes(method)) return null;
    let state = this.ownerStates.get(ownerId);
    if (method === 'session/create') {
      if (state?.release) throw turnActiveError('The broker owner is being released.'); const token = randomBytes(16).toString('hex'); this.reserveOperation();
      if (!state) { state = { epoch: 0, creates: new Map(), preflights: new Map(), release: null }; this.ownerStates.set(ownerId, state); }
      const lease = { kind: 'create', ownerId, token, epoch: state.epoch, sessionId: null }; state.creates.set(lease.token, lease); this.onChange(); return lease;
    }
    if (state?.release) throw turnActiveError('The broker owner is already being released.'); if (this.activeReleaseCount >= MAX_CONCURRENT_OWNER_RELEASES) throw turnActiveError('The broker has too many active owner releases.'); const token = randomBytes(16).toString('hex'); this.activeReleaseCount += 1;
    if (!state) { state = { epoch: 0, creates: new Map(), preflights: new Map(), release: null }; this.ownerStates.set(ownerId, state); }
    else for (const preflight of state.preflights.values()) preflight.retired = true;
    const lease = { kind: 'release', ownerId, token, epoch: state.epoch, grandfatheredCreates: new Map([...state.creates].map(([createToken, create]) => [createToken, create.sessionId])) }; state.release = lease; this.onChange(); return lease;
  }

  ownerRequestCurrent(lease) { const state = this.ownerStates.get(lease?.ownerId); return lease?.kind === 'create' ? state?.creates.get(lease.token) === lease && state.epoch === lease.epoch : lease?.kind === 'release' && state?.release === lease; }
  finishOwnerRequest(lease) { if (!lease) return; const state = this.ownerStates.get(lease.ownerId); if (!state) return; if (lease.kind === 'create' && state.creates.get(lease.token) === lease) { state.creates.delete(lease.token); this.activeOperationCount -= 1; } else if (lease.kind === 'release' && state.release === lease) { state.release = null; this.activeReleaseCount -= 1; } else return; if (!state.release && !state.creates.size && !state.preflights.size) this.ownerStates.delete(lease.ownerId); this.onChange(); }

  beginOwnershipPreflight(ownerId, sessionId) { let state = this.ownerStates.get(ownerId); if (state?.release) throw turnActiveError('The broker owner is being released.'); const token = randomBytes(16).toString('hex'); this.reserveOperation(); this.preflightGeneration += 1; if (!state) { state = { epoch: 0, creates: new Map(), preflights: new Map(), release: null }; this.ownerStates.set(ownerId, state); } const lease = { kind: 'ownership-preflight', ownerId, sessionId, token, generation: this.preflightGeneration }; state.preflights.set(token, lease); this.onChange(); return lease; }
  ownershipPreflightStored(lease) { const stored = lease?.kind === 'ownership-preflight' ? this.ownerStates.get(lease.ownerId)?.preflights.get(lease.token) : null; return stored === lease && stored.generation === lease.generation; }
  ownershipPreflightCurrent(lease) { return this.ownershipPreflightStored(lease) && !lease.retired; }
  finishOwnershipPreflight(lease) { if (!this.ownershipPreflightStored(lease)) return; const state = this.ownerStates.get(lease.ownerId); state.preflights.delete(lease.token); this.activeOperationCount -= 1; if (!state.release && !state.creates.size && !state.preflights.size) this.ownerStates.delete(lease.ownerId); this.onChange(); }

  beginSessionRequest(method, sessionId, ownerId, socket, ownerRequest = null, ownershipPreflight = null) {
    const mode = OWNER_SCOPED_SESSION_METHODS.has(method) ? 'shared' : EXCLUSIVE_SESSION_METHODS.has(method) ? 'exclusive' : null;
    if (!mode) return null;
    if (method === 'session/create' && sessionId === undefined) return null;
    const ownerState = this.ownerStates.get(ownerId); const grandfatheredCreate = method === 'session/create' && ownerRequest?.kind === 'create' && ownerState?.creates.get(ownerRequest.token) === ownerRequest && ownerState.release?.grandfatheredCreates.has(ownerRequest.token);
    if (method !== 'broker/releaseSession' && ownerState?.release && !grandfatheredCreate) throw turnActiveError('The broker owner is being released.');
    if (!isSafeIdentifier(sessionId)) throw turnActiveError('The session has a conflicting owner operation.');
    let leases = this.sessionLeases.get(sessionId);
    if (leases?.size && (mode === 'exclusive' || [...leases.values()].some((lease) => lease.mode === 'exclusive'))) throw turnActiveError('The session has a conflicting owner operation.');
    const pairedOwnerRequest = method === 'session/create' && this.ownerRequestCurrent(ownerRequest); const transferredPreflight = !pairedOwnerRequest && ownershipPreflight?.ownerId === ownerId && ownershipPreflight?.sessionId === sessionId && this.ownershipPreflightCurrent(ownershipPreflight); if (ownershipPreflight && !transferredPreflight) throw turnActiveError('The session ownership preflight is no longer active.'); const token = randomBytes(16).toString('hex'); if (!pairedOwnerRequest && !transferredPreflight) this.reserveOperation();
    if (!leases) { leases = new Map(); this.sessionLeases.set(sessionId, leases); }
    const lease = { token, sessionId, ownerId, socket, method, mode, protocol: null, ownerRequestToken: method === 'session/create' ? ownerRequest?.token ?? null : null, countsOperation: !pairedOwnerRequest }; leases.set(lease.token, lease); this.activeSessionCount += 1;
    if (transferredPreflight) { const state = this.ownerStates.get(ownerId); state.preflights.delete(ownershipPreflight.token); if (!state.release && !state.creates.size && !state.preflights.size) this.ownerStates.delete(ownerId); }
    this.onChange(); return lease;
  }

  claimSession(lease) { const state = this.ownerStates.get(lease?.ownerId); const create = state?.creates.get(lease?.ownerRequestToken); if (!lease || lease.method !== 'session/create' || !this.sessionLeaseStored(lease, null) || !create || create.sessionId !== null && create.sessionId !== lease.sessionId || this.sessionClaims.has(lease.sessionId)) throw turnActiveError('The session ownership claim is already active.'); create.sessionId = lease.sessionId; if (state.release?.grandfatheredCreates.has(create.token)) state.release.grandfatheredCreates.set(create.token, lease.sessionId); const claim = { token: lease.token, sessionId: lease.sessionId, ownerId: lease.ownerId, socket: lease.socket }; this.sessionClaims.set(lease.sessionId, claim); return claim; }
  bindSessionProtocol(lease, protocol) { if (!this.sessionRequestCurrent(lease, null)) throw brokerInputError(); lease.protocol = protocol; }
  sessionLeaseStored(lease, protocol) { return Boolean(lease && this.sessionLeases.get(lease.sessionId)?.get(lease.token) === lease && lease.protocol === protocol); }
  sessionRequestCurrent(lease, protocol) { if (!this.sessionLeaseStored(lease, protocol)) return false; if (lease.method === 'session/create') return this.sessionClaims.get(lease.sessionId)?.token === lease.token; return this.getDurableOwner(lease.sessionId) === lease.ownerId; }
  finishSessionRequest(lease) { if (!lease) return; const leases = this.sessionLeases.get(lease.sessionId); if (leases?.get(lease.token) !== lease) return; leases.delete(lease.token); this.activeSessionCount -= 1; if (lease.countsOperation) this.activeOperationCount -= 1; if (!leases.size) this.sessionLeases.delete(lease.sessionId); if (this.sessionClaims.get(lease.sessionId)?.token === lease.token) this.sessionClaims.delete(lease.sessionId); this.onChange(); }
  hasSessionAuthority(sessionId) { return this.getDurableOwner(sessionId) !== undefined || this.sessionClaims.has(sessionId) || this.sessionLeases.has(sessionId); }
  hasForeignSessionAuthority(sessionId, ownerId) { const durableOwner = this.getDurableOwner(sessionId); if (durableOwner !== undefined && durableOwner !== ownerId) return true; const claim = this.sessionClaims.get(sessionId); if (claim && claim.ownerId !== ownerId) return true; return [...(this.sessionLeases.get(sessionId)?.values() ?? [])].some((lease) => lease.ownerId !== ownerId); }
  reserveOperation() { if (this.activeOperationCount >= MAX_OWNER_OPERATION_LEASES) throw turnActiveError('The broker has too many active owner operations.'); this.activeOperationCount += 1; }
  get activeCount() { return this.activeOperationCount + this.activeReleaseCount; }
}

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
  const digest = createHash('sha256').update(JSON.stringify([canonicalEndpointPath(options.dataRoot), canonicalEndpointPath(options.workspace), options.identity ?? 'shared'])).digest('hex').slice(0, 32);
  if (platform === 'win32') return `\\\\.\\pipe\\zcode-${digest}`;
  if (platform !== 'darwin' && platform !== 'linux') throw brokerInputError();
  return join('/tmp', `zcode-${typeof process.getuid === 'function' ? process.getuid() : 'user'}`, `${digest}.sock`);
}

export function brokerIdentityNameForWireOptions(options = {}) {
  const profile = options.maxFrameBytes === undefined
    && options.maxOutboundBytes === undefined
    && options.drainTimeoutMs === undefined
    ? null
    : createHash('sha256').update(JSON.stringify([
      options.maxFrameBytes ?? null,
      options.maxOutboundBytes ?? null,
      options.drainTimeoutMs ?? null,
    ])).digest('hex').slice(0, 16);
  return profile ? `identity-${profile}.json` : 'identity.json';
}

/** @param {string} path @param {{endpoint:string,pid?:number,instanceId?:string,brokerToken?:string}} input */
export async function writeBrokerIdentity(path, input) {
  if (!input || typeof input.endpoint !== 'string') throw brokerInputError();
  const record = { version: 1, endpoint: input.endpoint, pid: input.pid ?? process.pid, instanceId: input.instanceId ?? randomBytes(24).toString('hex'), brokerToken: input.brokerToken ?? randomBytes(32).toString('hex'), createdAt: new Date().toISOString() };
  await ensurePrivateDirectory(dirname(path));
  await atomicWriteJson(path, record);
  return record;
}

/** @param {string} path @param {{expectedEndpoint?:string,isProcessAlive?:(pid:number)=>boolean,healthProbe?:(record:any)=>Promise<boolean>}} [options] */
export async function readHealthyBrokerIdentity(path, options = {}) {
  const inspected = await inspectBrokerIdentity(path, options);
  return inspected.status === 'healthy' ? inspected.record : null;
}

export async function inspectBrokerIdentity(path, options = {}) {
  let value;
  try { value = JSON.parse(await readFile(path, 'utf8')); } catch (error) { return { status: error?.code === 'ENOENT' ? 'missing' : 'invalid', record: null, reason: 'read' }; }
  if (!value || value.version !== 1 || !Number.isSafeInteger(value.pid) || value.pid <= 0 || typeof value.instanceId !== 'string' || value.instanceId.length < 32 || typeof value.brokerToken !== 'string' || value.brokerToken.length < 32 || typeof value.endpoint !== 'string') return { status: 'invalid', record: null, reason: 'schema' };
  if (options.expectedEndpoint !== undefined && value.endpoint !== options.expectedEndpoint) return { status: 'invalid', record: null, reason: 'endpoint' };
  const alive = options.isProcessAlive ?? isProcessAlive;
  if (!alive(value.pid)) return { status: 'dead', record: value };
  const healthProbe = options.healthProbe ?? probeBrokerHealth;
  if (!await healthProbe(value)) return { status: 'unhealthy', record: value };
  return { status: 'healthy', record: value };
}

/** @param {{endpoint:string,brokerToken:string,pid:number,instanceId:string}} record @param {number} [requestTimeoutMs] */
export async function probeBrokerHealth(record, requestTimeoutMs = 1_000) {
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 3_600_000) throw brokerInputError();
  const deadline = Date.now() + requestTimeoutMs;
  let protocol;
  try {
    protocol = await connectZCodeBroker(record.endpoint, { brokerToken: record.brokerToken, ownerId: `health-${record.instanceId}`, requestTimeoutMs });
    const remainingMs = deadline - Date.now(); if (remainingMs <= 0) return false;
    const result = await protocol.request('broker/health', {}, Math.min(requestTimeoutMs, remainingMs));
    return result?.ok === true && result.pid === record.pid && result.instanceId === record.instanceId;
  } catch { return false; } finally { await closeProtocolUntil(protocol, deadline); }
}

/** @param {{dataRoot:string,workspace:string,launch:{command:string,args:string[],target?:string},env?:NodeJS.ProcessEnv,platform?:string,idleTimeoutMs?:number,maxFrameBytes?:number,maxOutboundBytes?:number,drainTimeoutMs?:number}} options */
export async function ensureZCodeBroker(options) {
  if (!validIdleTimeoutOption(options?.idleTimeoutMs) || !validWireOption(options?.maxFrameBytes, 16 * 1024 * 1024) || !validWireOption(options?.maxOutboundBytes, 64 * 1024 * 1024) || !validDrainOption(options?.drainTimeoutMs)) throw brokerInputError();
  const storage = await resolveWorkspaceStorage(options);
  const brokerDirectory = join(storage.directory, 'broker');
  const identityName = brokerIdentityNameForWireOptions(options);
  const profile = identityName === 'identity.json' ? null : identityName.slice('identity-'.length, -'.json'.length);
  const identityPath = join(brokerDirectory, identityName);
  const endpoint = brokerEndpointFor({ platform: options.platform, dataRoot: storage.dataRootPath, workspace: storage.workspacePath, ...(profile ? { identity: profile } : {}) });
  await ensurePrivateDirectory(brokerDirectory);
  return withFileLock(join(brokerDirectory, '.lock'), async () => {
    const existing = await inspectBrokerIdentity(identityPath, { expectedEndpoint: endpoint });
    if (existing.status === 'healthy') return existing.record;
    if (existing.status === 'unhealthy' || existing.status === 'invalid') throw brokerUnhealthyError();
    if (existing.status === 'dead') {
      if (!await retireDeadBrokerIdentity(identityPath, endpoint, existing.record, options.platform ?? process.platform)) throw brokerUnhealthyError();
    }
    if (existing.status === 'missing') await clearStaleMissingEndpoint(identityPath, endpoint, options.platform ?? process.platform);
    const instanceId = randomBytes(24).toString('hex');
    const brokerToken = randomBytes(32).toString('hex');
    const configPath = join(brokerDirectory, `config-${instanceId}.json`);
    const config = JSON.parse(JSON.stringify({ endpoint, instanceId, brokerToken, launch: options.launch, workspace: storage.workspacePath, launchCwd: (options.platform ?? process.platform) === 'win32' ? tmpdir() : storage.workspacePath, idleTimeoutMs: options.idleTimeoutMs, maxFrameBytes: options.maxFrameBytes, maxOutboundBytes: options.maxOutboundBytes, drainTimeoutMs: options.drainTimeoutMs, ownershipPath: join(brokerDirectory, profile ? `session-owners-${profile}.json` : 'session-owners.json'), identityPath, publishIdentityAfterListen: true }));
    try {
      await atomicWriteJson(configPath, config);
    // Keep the daemon's process cwd outside the workspace. Windows holds the
    // cwd directory open for the lifetime of the process, which otherwise
    // prevents callers from removing short-lived workspace fixtures (and can
    // make a real workspace impossible to rename or delete).
    const child = await spawnDaemon({ command: process.execPath, args: [fileURLToPath(import.meta.url)], target: fileURLToPath(import.meta.url) }, { args: [configPath], cwd: tmpdir(), env: options.env });
    const candidate = { endpoint, pid: child.pid, instanceId, brokerToken };
    const deadline = Date.now() + 5_000;
    let startupConflict = false;
    let candidateDead = false;
    while (Date.now() < deadline) {
      const published = await inspectBrokerIdentity(identityPath, { expectedEndpoint: endpoint });
      if (sameBrokerIdentity(published.record, candidate)) {
        if (published.status === 'healthy') return published.record;
        if (published.status === 'dead') { candidateDead = true; break; }
      } else if (published.status !== 'missing' && !(existing.status === 'dead' && sameBrokerIdentity(published.record, existing.record))) { startupConflict = true; break; }
      if (!isProcessAlive(child.pid)) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    try { process.kill(child.pid, 'SIGTERM'); } catch { /* already exited */ }
    if (candidateDead) await retireDeadBrokerIdentity(identityPath, endpoint, candidate, options.platform ?? process.platform).catch(() => false);
    else if (!isProcessAlive(child.pid)) {
      const published = await inspectBrokerIdentity(identityPath, { expectedEndpoint: endpoint });
      if (sameBrokerIdentity(published.record, candidate) && published.status === 'dead') await retireDeadBrokerIdentity(identityPath, endpoint, candidate, options.platform ?? process.platform).catch(() => false);
      else if (published.status === 'missing') await clearStaleMissingEndpoint(identityPath, endpoint, options.platform ?? process.platform).catch(() => {});
    }
      if (startupConflict) throw brokerUnhealthyError();
      throw new PluginError('ZCODE_BROKER_START_FAILED', 'The ZCode broker failed its startup health probe.', { category: 'runtime', remedy: 'Retry or run $zcode:setup.' });
    } finally { await removeBrokerStartupConfig(configPath, config).catch(() => {}); }
  });
}

export class ZCodeBroker {
  /** @param {{endpoint:string,ownershipPath?:string,brokerToken:string,launch:{command:string,args:string[],target?:string},workspace:string,launchCwd?:string,env?:NodeJS.ProcessEnv,idleTimeoutMs?:number,maxFrameBytes?:number,maxOutboundBytes?:number,drainTimeoutMs?:number,instanceId?:string,identityPath?:string,publishIdentityAfterListen?:boolean}} options */
  constructor(options) { if (typeof options?.brokerToken !== 'string' || options.brokerToken.length < 32 || !validIdleTimeoutOption(options?.idleTimeoutMs) || !validWireOption(options?.maxFrameBytes, 16 * 1024 * 1024) || !validWireOption(options?.maxOutboundBytes, 64 * 1024 * 1024) || !validDrainOption(options?.drainTimeoutMs) || isWindowsNamedPipe(options?.endpoint) && (typeof options?.ownershipPath !== 'string' || !options.ownershipPath)) throw brokerInputError(); let workspace; try { workspace = realpathSync.native(resolve(options.workspace)); } catch { throw brokerInputError(); } this.options = { ...options, workspace }; this.ownershipPath = options.ownershipPath ?? `${options.endpoint}.owners.json`; this.ownershipStoreEstablished = false; this.ownershipRevision = 0; this.uncertainOwnerReleases = new Map(); this.ownerCommitTokens = new Map(); this.server = null; this.protocol = null; this.protocolPromise = null; this.retiredProtocolGeneration = null; this.sockets = new Set(); this.socketWriters = new WeakMap(); this.authenticated = new WeakSet(); this.existingProtocolOnlySockets = new WeakSet(); this.socketOwnerIds = new WeakMap(); this.sessionOwners = new Map(); this.admission = new BrokerAdmission((sessionId) => this.sessionOwners.get(sessionId)?.ownerId, () => this.scheduleIdleShutdown()); this.activeSessionSockets = new Map(); this.terminalWinnerEvidence = new Map(); this.admittingSessions = new Map(); this.stoppingSessions = new Map(); this.conversationSubscriptions = new Map(); this.orphanedConversationSubscriptions = new Map(); this.conversationSubscriptionGeneration = null; this.orphanRetryPromise = null; this.pendingConversationTopics = new Map(); this.permissionPending = new Map(); this.retiredPermissionResponses = new Map(); this.localTasks = new Set(); this.releaseTasks = new Set(); this.nextPermissionId = 1_000_000_000; this.owners = 0; this.activeSessions = new Set(); this.fastIdleRequested = false; this.idleTimer = null; this.closing = false; this.closePromise = null; }

  async start() {
    if (this.server) return this;
    try {
      await this.loadOwnership();
      if (process.platform !== 'win32') await ensurePrivateDirectory(dirname(this.options.endpoint));
      this.server = net.createServer((socket) => this.accept(socket));
      await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(this.options.endpoint, resolve); });
      if (process.platform !== 'win32') await chmod(this.options.endpoint, 0o600);
      if (this.options.publishIdentityAfterListen === true) {
        if (typeof this.options.identityPath !== 'string' || typeof this.options.instanceId !== 'string') throw brokerInputError();
        try { await writeBrokerIdentity(this.options.identityPath, { endpoint: this.options.endpoint, pid: process.pid, instanceId: this.options.instanceId, brokerToken: this.options.brokerToken }); }
        catch (error) { await removeBrokerIdentityInstance(this.options.identityPath, this.options.instanceId).catch(() => {}); throw error; }
      }
      return this;
    } catch (error) {
      if (this.server?.listening) await new Promise((resolvePromise) => this.server.close(() => resolvePromise()));
      this.server = null; throw error;
    }
  }

  accept(socket) {
    if (this.closing) { socket.destroy(); return; }
    this.sockets.add(socket); socket.zcodeWriter = new BoundedWriter(socket, { maxQueuedBytes: this.options.maxOutboundBytes, drainTimeoutMs: this.options.drainTimeoutMs, onFailure: () => socket.destroy() }); this.socketWriters.set(socket, socket.zcodeWriter); socket.setEncoding('utf8'); let buffer = '';
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
    socket.once('close', () => {
      clearTimeout(authTimer); this.socketWriters.get(socket)?.close(); this.sockets.delete(socket); this.existingProtocolOnlySockets.delete(socket);
      for (const [id, pending] of this.permissionPending) if (pending.socket === socket) { clearTimeout(pending.timer); this.permissionPending.delete(id); pending.resolve(offeredDeny(pending.request)); }
      for (const [id, retired] of this.retiredPermissionResponses) if (retired.socket === socket) this.retiredPermissionResponses.delete(id);
      for (const owner of this.sessionOwners.values()) if (owner.socket === socket) owner.socket = null;
      for (const active of this.activeSessionSockets.values()) if (active.socket === socket) active.socket = null;
      const cleanup = this.cleanupSocketSubscriptions(socket); this.localTasks.add(cleanup); void cleanup.finally(() => { this.localTasks.delete(cleanup); this.scheduleIdleShutdown(); });
      for (const [topic, pending] of this.pendingConversationTopics) if (pending.socket === socket) this.pendingConversationTopics.delete(topic);
      if (this.authenticated.has(socket)) this.owners -= 1; this.scheduleIdleShutdown();
    });
  }

  async handleLocal(socket, line) {
    let frame;
    try { frame = JSON.parse(line); } catch { socket.destroy(); return; }
    if (this.closing) { socket.destroy(); return; }
    if (!this.authenticated.has(socket)) {
      if (!frame || !Number.isSafeInteger(frame.id) || frame.method !== 'broker/auth'
        || !frame.params || typeof frame.params !== 'object' || Object.keys(frame.params).some((key) => !['token', 'ownerId', 'existingProtocolOnly'].includes(key))
        || typeof frame.params.token !== 'string' || !safeTokenEqual(frame.params.token, this.options.brokerToken) || typeof frame.params.ownerId !== 'string' || frame.params.ownerId.length < 16
        || frame.params.existingProtocolOnly !== undefined && typeof frame.params.existingProtocolOnly !== 'boolean') {
        writeLocal(socket, { id: Number.isSafeInteger(frame?.id) ? frame.id : 0, error: { code: -32040, message: 'Broker authentication failed.' } });
        socket.end(); return;
      }
      clearTimeout(socket.authTimer); this.authenticated.add(socket); if (frame.params.existingProtocolOnly === true) this.existingProtocolOnlySockets.add(socket); this.socketOwnerIds.set(socket, frame.params.ownerId); this.owners += 1; this.cancelIdleShutdown(); writeLocal(socket, { id: frame.id, result: { authenticated: true, ...(frame.params.existingProtocolOnly === true ? { existingProtocolOnly: true } : {}) } }); return;
    }
    if (frame && Number.isSafeInteger(frame.id) && !frame.method && (Object.hasOwn(frame, 'result') || Object.hasOwn(frame, 'error'))) {
      const pending = this.permissionPending.get(frame.id);
      if (!pending) { const retired = this.retiredPermissionResponses.get(frame.id); if (retired?.socket === socket) { this.retiredPermissionResponses.delete(frame.id); return; } socket.destroy(); return; }
      if (pending.socket !== socket) { socket.destroy(); return; }
      this.permissionPending.delete(frame.id); clearTimeout(pending.timer);
      if (frame.error) pending.reject(new Error('Permission handler failed.')); else pending.resolve(frame.result);
      return;
    }
    if (!frame || !Number.isSafeInteger(frame.id) || typeof frame.method !== 'string' || !frame.params || typeof frame.params !== 'object') { socket.destroy(); return; }
    if (!LOCAL_BROKER_METHODS.has(frame.method)) { writeRequestError(socket, frame.id, brokerInputError()); return; }
    if (frame.method === 'broker/health') { writeLocal(socket, { id: frame.id, result: { ok: this.retiredProtocolGeneration === null, pid: process.pid, instanceId: this.options.instanceId, capabilities: { releaseOwnerExclusions: true } } }); return; }
    if (frame.method === 'session/create' && !validCreateWorkspace(frame.params.workspace, this.options.workspace)) { writeRequestError(socket, frame.id, brokerInputError()); return; }
    const releaseDeadline = frame.method === 'broker/releaseOwner' ? Date.now() + OWNER_RELEASE_BUDGET_MS : undefined; let releaseExcluded;
    if (frame.method === 'broker/releaseOwner') {
      try { releaseExcluded = frame.params.excludeSessionIds ?? []; if (Object.keys(frame.params).some((key) => key !== 'excludeSessionIds') || !Array.isArray(releaseExcluded) || releaseExcluded.length > 1_000 || new Set(releaseExcluded).size !== releaseExcluded.length || !releaseExcluded.every((sessionId) => isSafeIdentifier(sessionId))) throw brokerInputError(); }
      catch (error) { writeRequestError(socket, frame.id, error); return; }
    }
    const conversationSessionId = frame.method === 'broker/releaseOwner' ? null : sessionIdFromConversationRequest(frame);
    if (conversationSessionId === false) { writeRequestError(socket, frame.id, brokerInputError()); return; }
    const requestedSessionId = conversationSessionId ?? frame.params.sessionId;
    const ownerId = this.socketOwnerIds.get(socket); const claimMethod = frame.method === 'session/create'; let ownershipReloaded = false; let ownershipPreflight; let ownerAdmission; let sessionAdmission; let sendToken;
    if (typeof requestedSessionId === 'string' && this.admission.hasForeignSessionAuthority(requestedSessionId, ownerId)) { writeSessionOwnerDenied(socket, frame.id); return; }
    if (typeof requestedSessionId === 'string' && !claimMethod && !this.admission.hasSessionAuthority(requestedSessionId)) {
      try { ownershipPreflight = this.admission.beginOwnershipPreflight(ownerId, requestedSessionId); } catch (error) { writeRequestError(socket, frame.id, error); return; }
      try { await this.reloadOwnership(undefined, null, ownershipPreflight); ownershipReloaded = true; } catch (error) { this.admission.finishOwnershipPreflight(ownershipPreflight); ownershipPreflight = null; writeRequestError(socket, frame.id, error); return; }
      const loadedOwner = this.sessionOwners.get(requestedSessionId); if (!loadedOwner || loadedOwner.ownerId !== ownerId) { this.admission.finishOwnershipPreflight(ownershipPreflight); ownershipPreflight = null; writeSessionOwnerDenied(socket, frame.id); return; }
    }
    try { ownerAdmission = this.admission.beginOwnerRequest(frame.method, ownerId); }
    catch (error) { writeRequestError(socket, frame.id, error); return; }
    try {
      try { sessionAdmission = this.admission.beginSessionRequest(frame.method, requestedSessionId, ownerId, socket, ownerAdmission, ownershipPreflight); if (frame.method === 'session/create' && sessionAdmission) this.admission.claimSession(sessionAdmission); }
      catch (error) { this.admission.finishSessionRequest(sessionAdmission); sessionAdmission = null; writeRequestError(socket, frame.id, error); return; }
      try {
        if (frame.method === 'broker/releaseOwner') {
          const trackedOwnerAdmission = ownerAdmission; ownerAdmission = null;
          try { writeLocal(socket, { id: frame.id, result: await this.releaseOwnerRequest(socket, ownerId, releaseExcluded, releaseDeadline, trackedOwnerAdmission) }); this.fastIdleRequested = true; }
          catch (error) { writeRequestError(socket, frame.id, error); }
          return;
        }
        try { if (!ownershipReloaded) await this.reloadOwnership(); } catch (error) { writeRequestError(socket, frame.id, error); return; }
        const existingOwner = typeof requestedSessionId === 'string' ? this.sessionOwners.get(requestedSessionId) : null;
        if (existingOwner && existingOwner.ownerId !== ownerId || typeof requestedSessionId === 'string' && !existingOwner && !claimMethod) { writeSessionOwnerDenied(socket, frame.id); return; }
        let subscriptionToken; let stopToken; let stoppedGeneration; let ownerCommitToken; let unsubscribeRecord; let protocol;
        if (frame.method === 'session/send') { sendToken = sessionAdmission.token; this.admittingSessions.set(frame.params.sessionId, sendToken); }
        if (frame.method === 'session/stop') { stoppedGeneration = this.activeSessionSockets.get(frame.params.sessionId); stopToken = sessionAdmission.token; this.stoppingSessions.set(frame.params.sessionId, { token: stopToken, activeToken: stoppedGeneration?.token ?? null }); }
        try {
          if (this.existingProtocolOnlySockets.has(socket)) { if (!this.protocol) throw existingProtocolUnavailable(); protocol = this.protocol; }
          else protocol = await this.getProtocol();
          if (sessionAdmission) this.admission.bindSessionProtocol(sessionAdmission, protocol);
          if (frame.method === 'session/create') { if (!this.admission.ownerRequestCurrent(ownerAdmission)) throw brokerInputError(); ownerCommitToken = randomBytes(16).toString('hex'); this.ownerCommitTokens.set(ownerCommitToken, protocol); }
          if (frame.method === 'session/send') { if (this.admittingSessions.get(frame.params.sessionId) !== sendToken) throw brokerInputError(); this.terminalWinnerEvidence.delete(frame.params.sessionId); protocol.beginTurn(frame.params.sessionId); this.activeSessionSockets.set(frame.params.sessionId, { socket, token: sendToken }); }
          if (frame.method === 'v4/conversation/subscribe') {
            await this.retryOrphanedSubscriptions(protocol, OWNER_RELEASE_REQUEST_MS, frame.params.topic);
            if (this.protocol !== protocol || !this.admission.sessionRequestCurrent(sessionAdmission, protocol)) throw brokerInputError();
            const generation = this.conversationGeneration(protocol); const retiredCount = generation?.retiredIds.size ?? 0;
            if (!generation || this.pendingConversationTopics.size >= MAX_PENDING_CONVERSATION_TOPICS || this.conversationSubscriptions.size + this.orphanedConversationSubscriptions.size + this.pendingConversationTopics.size + retiredCount >= MAX_CONVERSATION_SUBSCRIPTIONS || this.pendingConversationTopics.has(frame.params.topic) || [...this.conversationSubscriptions.values(), ...this.orphanedConversationSubscriptions.values()].some((subscription) => subscription.topic === frame.params.topic)) throw brokerInputError();
            subscriptionToken = sessionAdmission.token; this.pendingConversationTopics.set(frame.params.topic, { socket, token: subscriptionToken, protocol, sessionId: requestedSessionId, ownerId, earlySubscriptionId: null, ambiguous: false, frames: [], bytes: 0 });
          }
          if (frame.method === 'v4/conversation/unsubscribe') {
            const key = conversationKey(frame.params.topic, frame.params.subscriptionId); const subscription = this.conversationSubscriptions.get(key);
            if (!subscription || subscription.socket !== socket || subscription.connectionId !== frame.params.connectionId) throw ownerConflict(); unsubscribeRecord = { key, ...subscription };
          }
          let result;
          try {
            result = await protocol.request(frame.method, frame.params);
            if (sessionAdmission && !this.admission.sessionRequestCurrent(sessionAdmission, protocol)) throw brokerInputError();
            if (this.protocol !== protocol) throw brokerInputError();
            if (frame.method === 'session/stop') validateStopResult(result);
            if (frame.method === 'v4/conversation/unsubscribe' && !validConversationUnsubscribeResult(result)) { this.conversationSubscriptions.delete(unsubscribeRecord.key); this.retainOrphanedSubscription(protocol, unsubscribeRecord); this.clearProtocolGeneration(protocol); throw invalidUnsubscribeResult(); }
            if (frame.method === 'session/send') { validateSendResult(result, frame.params.sessionId); const active = this.activeSessionSockets.get(frame.params.sessionId); if (active?.token !== sendToken) throw brokerInputError(); active.baseline = result.stateRevision; active.inputId = frame.params.inputId; this.activeSessions.add(frame.params.sessionId); protocol.armTurn(frame.params.sessionId, result.stateRevision, frame.params.inputId); this.admittingSessions.delete(frame.params.sessionId); }
          } catch (error) { if (frame.method === 'session/send') { protocol.abortTurn(frame.params.sessionId); this.settleTurnPermissions(frame.params.sessionId, sendToken); if (this.activeSessionSockets.get(frame.params.sessionId)?.token === sendToken) this.activeSessionSockets.delete(frame.params.sessionId); if (this.admittingSessions.get(frame.params.sessionId) === sendToken) this.admittingSessions.delete(frame.params.sessionId); this.activeSessions.delete(frame.params.sessionId); this.scheduleIdleShutdown(); } if (subscriptionToken && this.pendingConversationTopics.get(frame.params.topic)?.token === subscriptionToken) this.pendingConversationTopics.delete(frame.params.topic); throw error; }
          if (frame.method === 'session/create') {
            const createdSessionId = result?.session?.sessionId;
            if (!isSafeIdentifier(createdSessionId) || typeof requestedSessionId === 'string' && createdSessionId !== requestedSessionId || !validCreateSnapshot(result, createdSessionId, this.options.workspace)) { this.clearProtocolGeneration(protocol); throw invalidSessionCreateResult(); }
            const anonymousCreate = typeof requestedSessionId !== 'string';
            if (anonymousCreate && this.sessionOwners.has(createdSessionId)) { this.clearProtocolGeneration(protocol); throw invalidSessionCreateResult(); }
            if (!this.admission.ownerRequestCurrent(ownerAdmission)) throw brokerInputError();
            if (!sessionAdmission) { sessionAdmission = this.admission.beginSessionRequest('session/create', createdSessionId, ownerId, socket, ownerAdmission); this.admission.claimSession(sessionAdmission); this.admission.bindSessionProtocol(sessionAdmission, protocol); }
            const commitCurrent = () => this.protocol === protocol && this.ownerCommitTokens.get(ownerCommitToken) === protocol && this.admission.ownerRequestCurrent(ownerAdmission) && this.admission.sessionRequestCurrent(sessionAdmission, protocol);
            let committed;
            try { committed = await this.persistOwnership(createdSessionId, ownerId, socket, commitCurrent, anonymousCreate); }
            catch (error) { if (anonymousCreate && error?.code === 'ZCODE_OUTPUT_INVALID') this.clearProtocolGeneration(protocol); throw error; }
            if (!committed.committed || !commitCurrent()) { if (committed.committed) await this.compensateOwnerCommit(committed, [createdSessionId]); throw brokerInputError(); }
            this.sessionOwners.set(createdSessionId, { ownerId, socket });
          }
          if (frame.method === 'v4/conversation/subscribe') {
            const pending = this.pendingConversationTopics.get(frame.params.topic); const subscriptionId = result?.ack?.subscriptionId; const addressable = isBoundedPublicIdentifier(subscriptionId); const generation = this.conversationGeneration(protocol); const retiredReuse = addressable && generation?.retiredIds.has(subscriptionId); const earlyAmbiguity = Boolean(pending && (pending.ambiguous || pending.earlySubscriptionId !== null && pending.earlySubscriptionId !== subscriptionId)); const stalePending = !pending || pending.token !== subscriptionToken || pending.protocol !== protocol || pending.sessionId !== requestedSessionId || pending.ownerId !== ownerId || this.sessionOwners.get(requestedSessionId)?.ownerId !== ownerId; const duplicate = addressable && [...this.conversationSubscriptions.values(), ...this.orphanedConversationSubscriptions.values()].some((subscription) => subscription.subscriptionId === subscriptionId);
            if (stalePending || !validConversationSubscribeResult(result) || duplicate || retiredReuse || earlyAmbiguity) {
              if (retiredReuse || earlyAmbiguity) this.clearProtocolGeneration(protocol);
              else if (addressable) await this.unsubscribeConversationRecords(protocol, [{ key: conversationKey(frame.params.topic, subscriptionId), socket, topic: frame.params.topic, subscriptionId, connectionId: frame.params.connectionId, sessionId: requestedSessionId, ownerId }], OWNER_RELEASE_REQUEST_MS);
              else this.clearProtocolGeneration(protocol);
              throw brokerInputError();
            }
            this.pendingConversationTopics.delete(frame.params.topic); const key = conversationKey(frame.params.topic, subscriptionId);
            if (this.conversationSubscriptions.has(key)) throw brokerInputError();
            this.conversationSubscriptions.set(key, { socket, topic: frame.params.topic, subscriptionId, connectionId: frame.params.connectionId, sessionId: requestedSessionId, ownerId });
            for (const message of pending.frames) if (conversationKey(message.params.topic, message.params.subscriptionId) === key) writeLocal(socket, message);
          }
          if (frame.method === 'v4/conversation/unsubscribe') { this.conversationSubscriptions.delete(unsubscribeRecord.key); if (!this.retireConversationSubscription(protocol, unsubscribeRecord)) throw brokerInputError(); }
          if (frame.method === 'session/stop' && frame.params.sessionId) { if (this.protocol !== protocol || this.stoppingSessions.get(frame.params.sessionId)?.token !== stopToken || !this.admission.sessionRequestCurrent(sessionAdmission, protocol)) throw brokerInputError(); const stopCommitted = this.settleAcknowledgedStop(frame.params.sessionId, protocol, stoppedGeneration); if (!stopCommitted) throw brokerInputError(); this.consumeTerminalWinner(frame.params.sessionId, protocol, stoppedGeneration); await this.cleanupAcknowledgedStopSubscriptions(protocol, this.detachSessionSubscriptions(frame.params.sessionId), OWNER_RELEASE_REQUEST_MS); if (this.stoppingSessions.get(frame.params.sessionId)?.token === stopToken) this.stoppingSessions.delete(frame.params.sessionId); this.scheduleIdleShutdown(); }
          if (frame.method === 'session/list' && Array.isArray(result?.sessions)) result = { ...result, sessions: result.sessions.filter((session) => this.sessionOwners.get(session.sessionId)?.ownerId === ownerId) };
          if (ownerCommitToken) this.ownerCommitTokens.delete(ownerCommitToken); writeLocal(socket, { id: frame.id, result });
        } catch (error) {
          if (subscriptionToken && this.pendingConversationTopics.get(frame.params.topic)?.token === subscriptionToken) this.pendingConversationTopics.delete(frame.params.topic);
          if (stopToken && this.stoppingSessions.get(frame.params.sessionId)?.token === stopToken) this.stoppingSessions.delete(frame.params.sessionId);
          if (ownerCommitToken && this.ownerCommitTokens.get(ownerCommitToken) === protocol) this.ownerCommitTokens.delete(ownerCommitToken);
          const pluginError = error instanceof PluginError ? { code: error.code, category: error.category, remedy: error.remedy, details: error.details } : null;
          writeLocal(socket, { id: frame.id, error: { code: -32000, message: error instanceof Error ? error.message : 'Broker request failed', ...(pluginError ? { data: { pluginError } } : {}) } });
        }
      } finally { if (sendToken && this.admittingSessions.get(frame.params.sessionId) === sendToken) this.admittingSessions.delete(frame.params.sessionId); this.admission.finishSessionRequest(sessionAdmission); }
    } finally { this.admission.finishOwnerRequest(ownerAdmission); this.admission.finishOwnershipPreflight(ownershipPreflight); }
  }

  cancelIdleShutdown() { clearTimeout(this.idleTimer); this.idleTimer = null; }
  scheduleIdleShutdown() { this.cancelIdleShutdown(); if (this.closing || this.owners || this.activeSessions.size || this.permissionPending.size || this.localTasks.size || this.admission.activeCount || this.retiredProtocolGeneration || this.protocolPromise && !this.protocol) return; this.idleTimer = setTimeout(() => { this.idleTimer = null; if (!this.owners && !this.activeSessions.size && !this.permissionPending.size && !this.localTasks.size && !this.admission.activeCount && !this.retiredProtocolGeneration && !(this.protocolPromise && !this.protocol)) void this.close().catch(() => {}); }, this.fastIdleRequested ? 0 : this.options.idleTimeoutMs ?? 30_000); this.idleTimer.unref?.(); }

  async releaseOwner(socket, ownerId, excludeSessionIds = [], deadline = Date.now() + OWNER_RELEASE_BUDGET_MS, ownerAdmission = null) {
    const admission = ownerAdmission ?? this.admission.beginOwnerRequest('broker/releaseOwner', ownerId);
    return await this.trackOwnerRelease(admission, deadline, () => this.releaseOwnerAdmitted(socket, ownerId, excludeSessionIds, deadline, admission));
  }

  async releaseOwnerRequest(socket, ownerId, excludeSessionIds, deadline, admission) {
    return await this.trackOwnerRelease(admission, deadline, async () => { await this.reloadOwnership(deadline, () => new Set([...admission.grandfatheredCreates.values()].filter((sessionId) => typeof sessionId === 'string'))); if (Date.now() >= deadline) throw ownerReleaseTimeout(); return await this.releaseOwnerAdmitted(socket, ownerId, excludeSessionIds, deadline, admission); });
  }

  async trackOwnerRelease(admission, deadline, continuation) {
    const operation = (async () => { try { return await continuation(); } finally { this.admission.finishOwnerRequest(admission); } })();
    this.releaseTasks.add(operation);
    void operation.then(() => { this.releaseTasks.delete(operation); this.scheduleIdleShutdown(); }, () => { this.releaseTasks.delete(operation); this.scheduleIdleShutdown(); });
    return await settleOwnerReleaseCaller(operation, deadline);
  }

  async releaseOwnerAdmitted(socket, ownerId, excludeSessionIds, deadline, ownerAdmission) {
    const excluded = new Set([...excludeSessionIds, ...[...ownerAdmission.grandfatheredCreates.values()].filter((sessionId) => typeof sessionId === 'string')]); const stableOwned = [...this.sessionOwners].filter(([, owner]) => owner.ownerId === ownerId).map(([sessionId]) => sessionId); const eligible = stableOwned.filter((sessionId) => !excluded.has(sessionId)); const owned = eligible.slice(0, OWNER_RELEASE_MAX_SESSIONS); const inFlightCreates = ownerAdmission.grandfatheredCreates.size;
    if (!owned.length) return { releasedSessionIds: [], failedSessionIds: [], deferredSessionCount: inFlightCreates };
    const released = []; const failed = []; const stoppedFences = new Map(); const releaseSessionAdmissions = new Map(); const authoritativeStops = new Set(); const authoritativeStopEvidence = new Map(); let releaseProtocol = null;
    try {
      if (!this.protocol) {
        if (this.protocolPromise || this.retiredProtocolGeneration) failed.push(...owned);
        else for (const sessionId of owned) {
          let sessionAdmission; try { sessionAdmission = this.admission.beginSessionRequest('broker/releaseSession', sessionId, ownerId, socket); }
          catch { failed.push(sessionId); continue; }
          const stopToken = sessionAdmission.token; this.stoppingSessions.set(sessionId, { token: stopToken, activeToken: null, ownerRelease: true }); stoppedFences.set(sessionId, stopToken); releaseSessionAdmissions.set(sessionId, sessionAdmission); released.push(sessionId);
        }
      } else {
        const protocol = this.protocol; releaseProtocol = protocol;
        for (let offset = 0; offset < owned.length; offset += OWNER_RELEASE_CONCURRENCY) {
          const batch = owned.slice(offset, offset + OWNER_RELEASE_CONCURRENCY); const remainingMs = deadline - Date.now();
          if (socket.destroyed || remainingMs <= 0 || this.protocol !== protocol) { failed.push(...owned.slice(offset)); break; }
          const outcomes = await Promise.allSettled(batch.map(async (sessionId) => {
            let sessionAdmission; let stopToken;
            try { sessionAdmission = this.admission.beginSessionRequest('broker/releaseSession', sessionId, ownerId, socket); this.admission.bindSessionProtocol(sessionAdmission, protocol); const activeSession = this.activeSessionSockets.get(sessionId); stopToken = sessionAdmission.token; this.stoppingSessions.set(sessionId, { token: stopToken, activeToken: activeSession?.token ?? null, ownerRelease: true }); const result = await protocol.request('session/stop', { sessionId }, Math.max(1, Math.min(OWNER_RELEASE_STOP_REQUEST_MS, remainingMs))); validateStopResult(result); if (this.protocol !== protocol || this.stoppingSessions.get(sessionId)?.token !== stopToken || !this.admission.sessionRequestCurrent(sessionAdmission, protocol)) throw brokerInputError(); return { activeSession, result, stopToken, sessionAdmission }; }
            catch (error) { if (stopToken && this.stoppingSessions.get(sessionId)?.token === stopToken) this.stoppingSessions.delete(sessionId); this.admission.finishSessionRequest(sessionAdmission); throw error; }
          }));
          for (let index = 0; index < batch.length; index += 1) if (outcomes[index].status === 'fulfilled') { stoppedFences.set(batch[index], outcomes[index].value.stopToken); releaseSessionAdmissions.set(batch[index], outcomes[index].value.sessionAdmission); }
          const detachedSubscriptions = [];
          for (let index = 0; index < batch.length; index += 1) {
            const sessionId = batch[index]; if (outcomes[index].status === 'fulfilled' && this.protocol === protocol && this.stoppingSessions.get(sessionId)?.token === outcomes[index].value.stopToken && this.admission.sessionRequestCurrent(outcomes[index].value.sessionAdmission, protocol)) { const stopped = outcomes[index].value; const authoritative = this.settleAcknowledgedStop(sessionId, protocol, stopped.activeSession); if (authoritative) { authoritativeStops.add(sessionId); authoritativeStopEvidence.set(sessionId, stopped); released.push(sessionId); detachedSubscriptions.push(...this.detachSessionSubscriptions(sessionId)); } else failed.push(sessionId); } else failed.push(sessionId);
          }
          await this.cleanupAcknowledgedStopSubscriptions(protocol, detachedSubscriptions, Math.max(0, deadline - Date.now()));
          if (this.protocol !== protocol) { for (const sessionId of released.splice(0)) { if (authoritativeStops.has(sessionId)) released.push(sessionId); else if (!failed.includes(sessionId)) failed.push(sessionId); } }
        }
      }
      const releaseSessionCurrent = (sessionId, committed) => {
        if (!releaseProtocol) return true;
        const admission = releaseSessionAdmissions.get(sessionId); const leaseCurrent = committed ? this.admission.sessionLeaseStored(admission, releaseProtocol) : this.admission.sessionRequestCurrent(admission, releaseProtocol);
        return leaseCurrent && (authoritativeStops.has(sessionId) || this.protocol === releaseProtocol && this.stoppingSessions.get(sessionId)?.token === stoppedFences.get(sessionId));
      };
      const failReleasedSessions = (sessionIds) => { const stale = new Set(sessionIds); for (let index = released.length - 1; index >= 0; index -= 1) if (stale.has(released[index])) { const [sessionId] = released.splice(index, 1); if (!failed.includes(sessionId)) failed.push(sessionId); } };
      if (!this.admission.ownerRequestCurrent(ownerAdmission)) failReleasedSessions(released);
      else failReleasedSessions(released.filter((sessionId) => !releaseSessionCurrent(sessionId, false)));
      if (released.length) {
        const releaseCurrent = () => this.admission.ownerRequestCurrent(ownerAdmission) && released.every((sessionId) => releaseSessionCurrent(sessionId, false));
        const commitMutationCurrent = () => this.admission.ownerRequestCurrent(ownerAdmission) && released.every((sessionId) => this.admission.sessionLeaseStored(releaseSessionAdmissions.get(sessionId), releaseProtocol)) && released.filter((sessionId) => authoritativeStops.has(sessionId)).every((sessionId) => releaseSessionCurrent(sessionId, false));
        const restoreStaleRelease = async () => {
          try { await withinOwnerReleaseDeadline(deadline, (signal) => this.restoreReleasedOwnership(released, ownerId, { timeoutMs: Math.max(0, deadline - Date.now()), signal })); }
          catch (error) { for (const sessionId of released) this.setUncertainOwnerRelease(sessionId, ownerId); throw error; }
          for (const sessionId of released.splice(0)) if (!failed.includes(sessionId)) failed.push(sessionId);
        };
        try {
          const commit = await withinOwnerReleaseDeadline(deadline, (signal) => this.commitOwnerMutation(false, commitMutationCurrent, (sessions) => { failReleasedSessions(released.filter((sessionId) => !releaseSessionCurrent(sessionId, false))); for (const sessionId of released) if (sessions[sessionId] === ownerId) delete sessions[sessionId]; }, { timeoutMs: Math.max(0, deadline - Date.now()), signal }, async ({ error, commit: uncertainCommit }) => {
            let winner; try { winner = await this.readOwnerStoreUnlocked(false, { signal }); } catch { throw error; }
            const releaseIds = new Set(released); const outsideIds = new Set([...Object.keys(winner.sessions), ...Object.keys(uncertainCommit.after)].filter((sessionId) => !releaseIds.has(sessionId)));
            if ([...outsideIds].some((sessionId) => !sameOwnerEntry(winner.sessions, uncertainCommit.after, sessionId)) || released.some((sessionId) => releaseSessionCurrent(sessionId, true) ? !sameOwnerEntry(winner.sessions, uncertainCommit.after, sessionId) : !sameOwnerEntry(winner.sessions, uncertainCommit.after, sessionId) && !sameOwnerEntry(winner.sessions, uncertainCommit.before, sessionId))) throw error;
            this.applyOwnership(winner.sessions); uncertainCommit.committed = true; return uncertainCommit;
          }));
          let committed = commit.committed;
          if (committed) {
            const stale = released.filter((sessionId) => !releaseSessionCurrent(sessionId, true)); failReleasedSessions(stale);
            if (stale.length) try { await withinOwnerReleaseDeadline(deadline, (signal) => this.compensateOwnerCommit(commit, stale, { timeoutMs: Math.max(0, deadline - Date.now()), signal }, released)); }
            catch (error) {
              let winner; try { winner = await withinOwnerReleaseDeadline(deadline, (signal) => this.readOwnerStore(false, { timeoutMs: Math.max(0, deadline - Date.now()), signal })); } catch { /* uncertain subsets remain fenced below */ }
              const preserved = winner && released.every((sessionId) => sameOwnerEntry(winner.sessions, commit.after, sessionId)); const compensated = winner && stale.every((sessionId) => sameOwnerEntry(winner.sessions, commit.before, sessionId));
              if (winner) this.applyOwnership(winner.sessions);
              for (const sessionId of [...stale, ...(!preserved ? released : [])]) this.setUncertainOwnerRelease(sessionId, ownerId);
              if (!compensated) for (const sessionId of stale) if (Object.hasOwn(commit.before, sessionId)) this.setSessionOwner(sessionId, { ownerId: commit.before[sessionId], socket: null });
              if (!preserved || !compensated) throw error;
            }
          }
          if (!committed) for (const sessionId of released.splice(0)) if (!failed.includes(sessionId)) failed.push(sessionId);
        } catch (error) {
          if (!releaseCurrent()) {
            try { await restoreStaleRelease(); } catch { throw error; }
          } else {
            let winner;
            try { winner = await withinOwnerReleaseDeadline(deadline, (signal) => this.readOwnerStore(false, { timeoutMs: Math.max(0, deadline - Date.now()), signal })); }
            catch { /* unresolved commit is fenced by the next ownership reload */ }
            if (!releaseCurrent()) {
              try { await restoreStaleRelease(); } catch { throw error; }
            } else if (winner) {
            const durableReleased = released.filter((sessionId) => winner.sessions[sessionId] !== ownerId);
            if (!durableReleased.length) throw error;
            const retained = released.filter((sessionId) => !durableReleased.includes(sessionId)); released.splice(0, released.length, ...durableReleased); for (const sessionId of retained) if (!failed.includes(sessionId)) failed.push(sessionId);
            this.applyOwnership(winner.sessions);
            } else {
              for (const sessionId of released) this.setUncertainOwnerRelease(sessionId, ownerId);
              throw error;
            }
          }
        }
        for (const sessionId of released) { this.uncertainOwnerReleases.delete(sessionId); const stopped = authoritativeStopEvidence.get(sessionId); if (stopped) this.consumeTerminalWinner(sessionId, releaseProtocol, stopped.activeSession); }
      }
      this.scheduleIdleShutdown();
      return { releasedSessionIds: released, failedSessionIds: failed, deferredSessionCount: eligible.length - owned.length + inFlightCreates };
    } finally {
      for (const [sessionId, stopToken] of stoppedFences) if (this.stoppingSessions.get(sessionId)?.token === stopToken) this.stoppingSessions.delete(sessionId);
      for (const sessionAdmission of releaseSessionAdmissions.values()) this.admission.finishSessionRequest(sessionAdmission);
    }
  }

  async getProtocol() {
    if (this.protocol) return this.protocol;
    if (this.retiredProtocolGeneration) throw protocolRetiring();
    if (!this.protocolPromise) this.protocolPromise = this.initializeProtocolGeneration();
    const attempt = this.protocolPromise;
    try { return await attempt; } catch (error) { if (this.protocolPromise === attempt) this.protocolPromise = null; this.scheduleIdleShutdown(); throw error; }
  }

  async initializeProtocolGeneration() {
    const protocol = await spawnZCodeProtocol(this.options.launch, { cwd: this.options.launchCwd ?? this.options.workspace, env: this.options.env, maxFrameBytes: this.options.maxFrameBytes, maxOutboundBytes: this.options.maxOutboundBytes, drainTimeoutMs: this.options.drainTimeoutMs });
    try {
      if (this.closing) throw new PluginError('ZCODE_BROKER_CLOSING', 'The ZCode broker is closing.', { category: 'state', remedy: 'Reconnect to a healthy broker.' });
      if (this.retiredProtocolGeneration) throw protocolRetiring();
      this.protocol = protocol; this.conversationSubscriptionGeneration = { protocol, retiredIds: new Map() };
      protocol.subscribe((message) => {
      if (message.method === 'broker/sessionStopped') return;
      if (message.method === 'v4/conversation/frame') { this.routeConversationFrame(protocol, message); return; }
      if (isTerminalStateNotification(message)) return;
      const active = message.params?.sessionId ? this.activeSessionSockets.get(message.params.sessionId) : null;
      const sessionOwner = message.params?.sessionId ? active?.socket ?? this.sessionOwners.get(message.params.sessionId)?.socket : null;
      if (message.params?.sessionId && sessionOwner) writeLocal(sessionOwner, message);
      });
      protocol.setPermissionHandler((request) => this.requestPermission(request));
      protocol.consumeTerminalsWith((params, turn) => { const active = this.activeSessionSockets.get(params.sessionId); if (active?.baseline === turn.baseline && active.inputId === turn.inputId) { this.recordTerminalWinner(params.sessionId, protocol, active); if (active.socket?.writable) writeLocal(active.socket, { method: 'state.updated', params }); this.settleTurnPermissions(params.sessionId, active.token); this.activeSessionSockets.delete(params.sessionId); this.activeSessions.delete(params.sessionId); this.scheduleIdleShutdown(); } });
      protocol.setCloseHandler(() => this.clearProtocolGeneration(protocol));
      return protocol;
    } catch (error) { if (this.protocol === protocol) this.protocol = null; await protocol.close().catch(() => {}); throw error; }
  }

  clearProtocolGeneration(protocol) {
    if (this.retiredProtocolGeneration?.protocol === protocol) return this.retiredProtocolGeneration;
    if (this.protocol !== protocol) return null;
    // A replacement generation is never admitted while this exact record is
    // pending or failed, so one record is enough to bound all retired state.
    if (this.retiredProtocolGeneration) return this.retiredProtocolGeneration;
    const retired = { protocol, closePromise: null, status: 'pending', error: null, tombstones: new Set() };
    for (const [key, subscription] of this.orphanedConversationSubscriptions) if (subscription.protocol === protocol) retired.tombstones.add(key);
    this.retiredProtocolGeneration = retired;
    for (const [sessionId, active] of this.activeSessionSockets) if (active.socket?.writable) writeLocal(active.socket, { method: 'broker/sessionStopped', params: { sessionId } });
    this.activeSessions.clear(); this.activeSessionSockets.clear(); for (const [sessionId, evidence] of this.terminalWinnerEvidence) if (evidence.protocol === protocol) this.terminalWinnerEvidence.delete(sessionId); this.admittingSessions.clear(); for (const [sessionId, stopping] of this.stoppingSessions) if (!stopping.ownerRelease) this.stoppingSessions.delete(sessionId); this.conversationSubscriptions.clear(); this.orphanRetryPromise = null; this.pendingConversationTopics.clear();
    for (const [id, pending] of this.permissionPending) { clearTimeout(pending.timer); this.retirePermissionResponse(id, pending.socket); pending.resolve(offeredDeny(pending.request)); }
    this.permissionPending.clear(); this.protocol = null; this.protocolPromise = null; this.scheduleIdleShutdown();
    for (const [token, capturedProtocol] of this.ownerCommitTokens) if (capturedProtocol === protocol) this.ownerCommitTokens.delete(token);
    let resolveClose;
    retired.closePromise = new Promise((resolvePromise) => { resolveClose = resolvePromise; });
    let closing;
    try { closing = typeof protocol.close === 'function' ? protocol.close() : undefined; }
    catch (error) { closing = Promise.reject(error); }
    void Promise.resolve(closing).then(
      () => resolveClose(this.settleRetiredProtocolGeneration(retired, null)),
      (error) => resolveClose(this.settleRetiredProtocolGeneration(retired, error)),
    );
    return retired;
  }

  settleRetiredProtocolGeneration(retired, error) {
    if (this.retiredProtocolGeneration !== retired) return retired;
    retired.error = error; retired.status = error ? 'failed' : 'closed';
    if (this.conversationSubscriptionGeneration?.protocol === retired.protocol) this.conversationSubscriptionGeneration = null;
    if (!error) {
      for (const [key, subscription] of this.orphanedConversationSubscriptions) if (subscription.protocol === retired.protocol) this.orphanedConversationSubscriptions.delete(key);
      retired.tombstones.clear(); this.retiredProtocolGeneration = null;
    }
    this.scheduleIdleShutdown(); return retired;
  }

  async requestPermission(request) {
    const activeSession = this.activeSessionSockets.get(request.sessionId);
    const socket = activeSession?.socket;
    if (!socket?.writable) return offeredDeny(request);
    const id = this.nextPermissionId++;
    if (this.permissionPending.size >= 256) return offeredDeny(request);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { const pending = this.permissionPending.get(id); if (pending) { this.permissionPending.delete(id); this.retirePermissionResponse(id, pending.socket); } resolve(offeredDeny(request)); }, 30_000);
      timer.unref?.(); this.permissionPending.set(id, { socket, turnToken: activeSession.token, resolve, reject, timer, request }); this.cancelIdleShutdown();
      writeLocal(socket, { id, method: 'interaction/requestPermission', params: request });
    });
  }

  isExactCurrentTurn(sessionId, activeSession) { return typeof activeSession?.token === 'string' && this.activeSessionSockets.get(sessionId)?.token === activeSession.token; }

  recordTerminalWinner(sessionId, protocol, activeSession) {
    const evidence = { protocol, token: activeSession.token, baseline: activeSession.baseline, inputId: activeSession.inputId };
    activeSession.terminalWinner = evidence;
    this.terminalWinnerEvidence.delete(sessionId); this.terminalWinnerEvidence.set(sessionId, evidence);
    while (this.terminalWinnerEvidence.size > MAX_TERMINAL_WINNER_EVIDENCE) this.terminalWinnerEvidence.delete(this.terminalWinnerEvidence.keys().next().value);
    return evidence;
  }

  isTerminalWinnerForTurn(sessionId, protocol, activeSession) {
    const captured = activeSession?.terminalWinner;
    if (captured?.protocol === protocol && captured.token === activeSession.token && captured.baseline === activeSession.baseline && captured.inputId === activeSession.inputId) return true;
    const evidence = this.terminalWinnerEvidence.get(sessionId);
    return typeof activeSession?.token === 'string' && evidence?.protocol === protocol && evidence.token === activeSession.token && evidence.baseline === activeSession.baseline && evidence.inputId === activeSession.inputId;
  }

  settleAcknowledgedStop(sessionId, protocol, activeSession) {
    const current = this.activeSessionSockets.get(sessionId);
    if (!activeSession) return !current;
    if (current?.token !== activeSession.token) return !current && this.isTerminalWinnerForTurn(sessionId, protocol, activeSession);
    protocol.cancelTurn(sessionId); return this.settleStoppedSession(sessionId, activeSession);
  }

  consumeTerminalWinner(sessionId, protocol, activeSession) {
    const evidence = this.terminalWinnerEvidence.get(sessionId);
    if (evidence?.protocol !== protocol) return false;
    if (!activeSession || typeof activeSession.token === 'string' && evidence.token === activeSession.token && evidence.baseline === activeSession.baseline && evidence.inputId === activeSession.inputId) { this.terminalWinnerEvidence.delete(sessionId); return true; }
    return false;
  }

  settleStoppedSession(sessionId, activeSession) {
    if (!this.isExactCurrentTurn(sessionId, activeSession)) return false;
    this.activeSessionSockets.delete(sessionId); this.activeSessions.delete(sessionId);
    this.settleTurnPermissions(sessionId, activeSession?.token);
    if (activeSession?.socket?.writable) writeLocal(activeSession.socket, { method: 'broker/sessionStopped', params: { sessionId } });
    return true;
  }

  settleTurnPermissions(sessionId, turnToken) {
    if (typeof turnToken !== 'string') return;
    for (const [id, pending] of this.permissionPending) if (pending.request.sessionId === sessionId && pending.turnToken === turnToken) { clearTimeout(pending.timer); this.permissionPending.delete(id); this.retirePermissionResponse(id, pending.socket); pending.resolve(offeredDeny(pending.request)); }
  }

  retirePermissionResponse(id, socket) {
    this.retiredPermissionResponses.set(id, { socket });
    while (this.retiredPermissionResponses.size > 256) this.retiredPermissionResponses.delete(this.retiredPermissionResponses.keys().next().value);
  }

  conversationGeneration(protocol) {
    if (!protocol || this.protocol !== protocol) return null;
    if (this.conversationSubscriptionGeneration?.protocol !== protocol) this.conversationSubscriptionGeneration = { protocol, retiredIds: new Map() };
    return this.conversationSubscriptionGeneration;
  }

  retireConversationSubscription(protocol, subscription) {
    const generation = this.conversationGeneration(protocol); if (!generation) return false;
    if (!generation.retiredIds.has(subscription.subscriptionId)) generation.retiredIds.set(subscription.subscriptionId, { topic: subscription.topic, subscriptionId: subscription.subscriptionId, connectionId: subscription.connectionId, sessionId: subscription.sessionId, ownerId: subscription.ownerId });
    if (generation.retiredIds.size < MAX_CONVERSATION_SUBSCRIPTIONS) return true;
    this.clearProtocolGeneration(protocol); return false;
  }

  routeConversationFrame(protocol, message) {
    if (message === undefined) { message = protocol; protocol = this.protocol; }
    if (!protocol || this.protocol !== protocol) return;
    const topic = message.params?.topic; const subscriptionId = message.params?.subscriptionId;
    if (typeof topic !== 'string' || !isBoundedPublicIdentifier(subscriptionId)) return;
    const generation = this.conversationGeneration(protocol); const pending = this.pendingConversationTopics.get(topic);
    if (generation?.retiredIds.has(subscriptionId)) { if (pending?.protocol === protocol) { pending.ambiguous = true; pending.frames = []; pending.bytes = 0; } return; }
    const subscription = this.conversationSubscriptions.get(conversationKey(topic, subscriptionId));
    const currentOwner = subscription ? this.sessionOwners.get(subscription.sessionId) : null;
    if (subscription && currentOwner?.ownerId === subscription.ownerId && subscription.socket?.writable) { writeLocal(subscription.socket, message); return; }
    if (!pending || pending.protocol !== protocol || this.sessionOwners.get(pending.sessionId)?.ownerId !== pending.ownerId) return;
    if (pending.earlySubscriptionId !== null && pending.earlySubscriptionId !== subscriptionId) { pending.ambiguous = true; pending.frames = []; pending.bytes = 0; return; }
    pending.earlySubscriptionId = subscriptionId; const frameBytes = conversationFrameBytes(message);
    const totalBytes = [...this.pendingConversationTopics.values()].reduce((sum, entry) => sum + entry.bytes, 0);
    if (pending && frameBytes <= MAX_CONVERSATION_FRAME_BYTES && pending.frames.length < MAX_PENDING_CONVERSATION_FRAMES && totalBytes + frameBytes <= MAX_PENDING_CONVERSATION_BYTES) { pending.frames.push(message); pending.bytes += frameBytes; }
  }

  async cleanupAcknowledgedStopSubscriptions(protocol, subscriptions, timeoutMs) {
    try { await this.unsubscribeConversationRecords(protocol, subscriptions, timeoutMs); }
    catch { this.clearProtocolGeneration(protocol); }
  }

  async cleanupSocketSubscriptions(socket) {
    const subscriptions = [...this.conversationSubscriptions].filter(([, subscription]) => subscription.socket === socket);
    for (const [key] of subscriptions) this.conversationSubscriptions.delete(key);
    const protocol = this.protocol;
    await this.unsubscribeConversationRecords(protocol, subscriptions.map(([key, subscription]) => ({ key, ...subscription })), protocol ? OWNER_RELEASE_REQUEST_MS : 0);
  }

  detachSessionSubscriptions(sessionId) {
    this.pendingConversationTopics.delete(`conversation/${sessionId}`);
    const subscriptions = [...this.conversationSubscriptions].filter(([, subscription]) => subscription.sessionId === sessionId);
    for (const [key] of subscriptions) this.conversationSubscriptions.delete(key);
    return subscriptions.map(([key, subscription]) => ({ key, ...subscription }));
  }

  async retryOrphanedSubscriptions(protocol, timeoutMs, topic) {
    if (this.orphanRetryPromise) return this.orphanRetryPromise;
    const now = Date.now(); const candidates = [...this.orphanedConversationSubscriptions.values()].filter((subscription) => subscription.protocol === protocol && subscription.retryAfter <= now).sort((left, right) => Number(right.topic === topic) - Number(left.topic === topic)).slice(0, 8);
    if (!candidates.length) return;
    const retry = this.unsubscribeConversationRecords(protocol, candidates, timeoutMs); this.orphanRetryPromise = retry;
    try { await retry; } finally { if (this.orphanRetryPromise === retry) this.orphanRetryPromise = null; }
  }

  retainOrphanedSubscription(protocol, subscription) {
    const existing = this.orphanedConversationSubscriptions.get(subscription.key); if (existing) { if (this.retiredProtocolGeneration?.protocol === protocol) this.retiredProtocolGeneration.tombstones.add(existing.key); return existing; }
    if (this.orphanedConversationSubscriptions.size >= MAX_CONVERSATION_SUBSCRIPTIONS) throw brokerInputError();
    const entry = { ...subscription, protocol, entryToken: randomBytes(16).toString('hex'), retryAfter: 0 }; this.orphanedConversationSubscriptions.set(entry.key, entry); if (this.retiredProtocolGeneration?.protocol === protocol) this.retiredProtocolGeneration.tombstones.add(entry.key); return entry;
  }

  async unsubscribeConversationRecords(protocol, subscriptions, timeoutMs) {
    if (!subscriptions.length) return;
    const entries = subscriptions.map((subscription) => this.retainOrphanedSubscription(protocol, subscription));
    if (!protocol || timeoutMs <= 0) return;
    const outcomes = await Promise.allSettled(entries.map((subscription) => Promise.resolve().then(() => protocol.request('v4/conversation/unsubscribe', { topic: subscription.topic, subscriptionId: subscription.subscriptionId, connectionId: subscription.connectionId }, timeoutMs))));
    let malformedCurrentGeneration = false;
    for (let index = 0; index < entries.length; index += 1) {
      const subscription = entries[index]; if (this.orphanedConversationSubscriptions.get(subscription.key)?.entryToken !== subscription.entryToken) continue;
      if (outcomes[index].status === 'fulfilled' && validConversationUnsubscribeResult(outcomes[index].value) && this.protocol === protocol && subscription.protocol === protocol) { this.orphanedConversationSubscriptions.delete(subscription.key); if (!this.retireConversationSubscription(protocol, subscription)) malformedCurrentGeneration = true; }
      else { subscription.retryAfter = Date.now() + 50; if (outcomes[index].status === 'fulfilled' && !validConversationUnsubscribeResult(outcomes[index].value) && this.protocol === protocol) malformedCurrentGeneration = true; }
    }
    if (malformedCurrentGeneration) this.clearProtocolGeneration(protocol);
  }

  close() {
    if (!this.closePromise) { this.closing = true; this.closePromise = this.closeOnce(); }
    return this.closePromise;
  }

  async closeOnce() {
    const startingReleaseTasks = [...this.releaseTasks];
    const closingServer = this.server ? new Promise((resolvePromise) => this.server.close(() => resolvePromise())) : Promise.resolve();
    this.cancelIdleShutdown(); for (const pending of this.permissionPending.values()) { clearTimeout(pending.timer); pending.resolve(offeredDeny(pending.request)); } this.permissionPending.clear(); this.retiredPermissionResponses.clear(); for (const socket of this.sockets) socket.destroy(); this.sockets.clear();
    const startingProtocol = this.protocolPromise; let retired = this.protocol ? this.clearProtocolGeneration(this.protocol) : this.retiredProtocolGeneration;
    if (!retired && startingProtocol) { const spawned = await startingProtocol.catch(() => null); if (spawned && this.protocol === spawned) retired = this.clearProtocolGeneration(spawned); else retired = this.retiredProtocolGeneration; }
    if (retired) await retired.closePromise;
    const closeError = retired?.error; this.protocol = null; this.protocolPromise = null;
    const releaseOutcomes = await Promise.allSettled(startingReleaseTasks); const releaseError = releaseOutcomes.find((outcome) => outcome.status === 'rejected')?.reason;
    await Promise.allSettled([...this.localTasks]);
    await closingServer;
    this.server = null;
    await this.removeIdentityIfOwned();
    if (closeError) throw closeError;
    if (releaseError) throw releaseError;
  }

  async loadOwnership() {
    const loaded = await readOwnerStore(this.ownershipPath, true); if (!loaded.exists) return; this.applyOwnership(loaded.sessions); this.ownershipStoreEstablished = true;
  }

  async commitOwnerMutation(allowMissing, isCurrent, update, lockOptions = {}, recoverWriteError = null) {
    return mutateOwnerStore(this.ownershipPath, allowMissing, async (sessions) => {
      const before = cloneOwnerSessions(sessions); const after = cloneOwnerSessions(sessions); update(after); const commit = { committed: false, before, after };
      if (!isCurrent()) return commit;
      let writeError;
      try { await this.writeOwnerStoreRevision(after, { signal: lockOptions.signal }); } catch (error) { writeError = error; }
      if (!isCurrent()) {
        try { await this.writeOwnerStoreRevision(before, { signal: lockOptions.signal }); }
        catch (restoreError) { const winner = await this.readOwnerStoreUnlocked(false, { signal: lockOptions.signal }); if (!sameOwnerSessions(winner.sessions, before)) throw restoreError; }
        this.applyOwnership(before); return commit;
      }
      if (writeError) { if (recoverWriteError) return recoverWriteError({ error: writeError, commit }); throw writeError; }
      this.applyOwnership(after); commit.committed = true; return commit;
    }, lockOptions);
  }

  async compensateOwnerCommit(commit, sessionIds, lockOptions = {}, preserveAfterSessionIds = []) {
    await mutateOwnerStore(this.ownershipPath, false, async (sessions) => {
      if (preserveAfterSessionIds.some((sessionId) => !sameOwnerEntry(sessions, commit.after, sessionId))) throw ownerStoreInvalid();
      let changed = false; let applied = sessions;
      for (const sessionId of sessionIds) {
        if (sameOwnerEntry(sessions, commit.before, sessionId)) continue;
        if (!sameOwnerEntry(sessions, commit.after, sessionId)) throw ownerStoreInvalid();
        if (Object.hasOwn(commit.before, sessionId)) sessions[sessionId] = commit.before[sessionId]; else delete sessions[sessionId]; changed = true;
      }
      if (changed) try { await this.writeOwnerStoreRevision(sessions, { signal: lockOptions.signal }); }
      catch (error) { const winner = await this.readOwnerStoreUnlocked(false, { signal: lockOptions.signal }); if (sessionIds.some((sessionId) => !sameOwnerEntry(winner.sessions, commit.before, sessionId)) || preserveAfterSessionIds.some((sessionId) => !sameOwnerEntry(winner.sessions, commit.after, sessionId))) throw error; applied = winner.sessions; }
      this.applyOwnership(applied);
    }, lockOptions);
  }

  async restoreReleasedOwnership(sessionIds, ownerId, lockOptions = {}) {
    await mutateOwnerStore(this.ownershipPath, false, async (sessions) => {
      let changed = false;
      for (const sessionId of sessionIds) {
        if (sessions[sessionId] === ownerId) continue;
        if (Object.hasOwn(sessions, sessionId)) throw ownerConflict();
        sessions[sessionId] = ownerId; changed = true;
      }
      if (changed) await this.writeOwnerStoreRevision(sessions, { signal: lockOptions.signal });
      this.applyOwnership(sessions);
    }, lockOptions);
  }

  async persistOwnership(sessionId, ownerId, socket, isCurrent, requireNew) {
    const recoverWriteError = async ({ error, commit }) => {
      let winner;
      try { winner = await this.readOwnerStoreUnlocked(false); }
      catch { this.setSessionOwner(sessionId, { ownerId, socket, uncertain: true }); throw error; }
      this.applyOwnership(winner.sessions); this.ownershipStoreEstablished = true;
      if (sameOwnerSessions(winner.sessions, commit.after)) { commit.committed = true; commit.recovered = true; return commit; }
      if (!Object.hasOwn(winner.sessions, sessionId)) this.setSessionOwner(sessionId, { ownerId, socket, uncertain: true });
      throw error;
    };
    const commit = await this.commitOwnerMutation(!this.ownershipStoreEstablished, isCurrent, (sessions) => { if (Object.hasOwn(sessions, sessionId)) { if (requireNew) throw invalidSessionCreateResult(); if (sessions[sessionId] !== ownerId) throw ownerConflict(); } sessions[sessionId] = ownerId; }, {}, recoverWriteError); if (commit.committed) this.ownershipStoreEstablished = true; return commit;
  }

  async reloadOwnership(deadline, preserveSessionIds = null, ownershipPreflight = null) { const revision = this.ownershipRevision; const read = (signal) => this.readOwnerStore(!this.ownershipStoreEstablished, { ...(deadline === undefined ? {} : { timeoutMs: Math.max(0, deadline - Date.now()) }), ...(signal ? { signal } : {}) }); const loaded = deadline === undefined ? await read() : await withinOwnerReleaseDeadline(deadline, read); if (ownershipPreflight && !this.admission.ownershipPreflightCurrent(ownershipPreflight)) throw turnActiveError('The session ownership preflight is no longer active.'); if (this.ownershipRevision !== revision || !loaded.exists) return; const preservedIds = typeof preserveSessionIds === 'function' ? preserveSessionIds() : preserveSessionIds ?? new Set(); const preserved = new Map([...preservedIds].flatMap((sessionId) => { const current = this.sessionOwners.get(sessionId); return current ? [[sessionId, current]] : []; })); for (const [sessionId, current] of this.sessionOwners) if ((!Object.hasOwn(loaded.sessions, sessionId) || loaded.sessions[sessionId] !== current.ownerId) && this.uncertainOwnerReleases.get(sessionId) !== current.ownerId && !preserved.has(sessionId)) throw ownerStoreInvalid(); this.applyOwnership(loaded.sessions); for (const [sessionId, owner] of preserved) this.sessionOwners.set(sessionId, owner); this.uncertainOwnerReleases.clear(); this.ownershipStoreEstablished = true; }

  async readOwnerStore(allowMissing, options = {}) { return readOwnerStore(this.ownershipPath, allowMissing, options); }
  async readOwnerStoreUnlocked(allowMissing, options = {}) { return readOwnerStoreUnlocked(this.ownershipPath, allowMissing, options.signal); }
  async writeOwnerStoreRevision(sessions, options = {}) { try { return await this.writeOwnerStore(sessions, options); } finally { this.ownershipRevision += 1; } }
  async writeOwnerStore(sessions, options = {}) { return atomicWriteJson(this.ownershipPath, { version: 1, sessions }, options); }

  setUncertainOwnerRelease(sessionId, ownerId) { this.uncertainOwnerReleases.set(sessionId, ownerId); this.ownershipRevision += 1; }
  setSessionOwner(sessionId, owner) { this.sessionOwners.set(sessionId, owner); this.ownershipRevision += 1; }
  applyOwnership(sessions) { const next = new Map(); for (const [sessionId, ownerId] of Object.entries(sessions)) { const current = this.sessionOwners.get(sessionId); next.set(sessionId, { ownerId, socket: current?.ownerId === ownerId ? current.socket : null }); } this.sessionOwners = next; this.ownershipRevision += 1; }

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
function sessionIdFromConversationRequest(frame) {
  if (!['v4/conversation/subscribe', 'v4/conversation/unsubscribe'].includes(frame.method)) return null;
  if (typeof frame.params.topic !== 'string' || !frame.params.topic.startsWith('conversation/')) return false;
  const sessionId = frame.params.topic.slice('conversation/'.length);
  return isSafeIdentifier(sessionId) ? sessionId : false;
}
function conversationKey(topic, subscriptionId) { return JSON.stringify([topic, subscriptionId]); }
function conversationFrameBytes(message) { try { return Buffer.byteLength(JSON.stringify(message)); } catch { return Number.POSITIVE_INFINITY; } }
function isTerminalStateNotification(message) { return message.method === 'state.updated' && message.params?.scope === 'session' && ['prompt_completed', 'prompt_failed'].includes(message.params?.reason); }
async function withinOwnerReleaseDeadline(deadline, operation) { const remainingMs = deadline - Date.now(); if (remainingMs <= 0) throw ownerReleaseTimeout(); const controller = new AbortController(); const timer = setTimeout(() => controller.abort(ownerReleaseTimeout()), remainingMs); timer.unref?.(); try { const result = await operation(controller.signal); if (Date.now() >= deadline) throw ownerReleaseTimeout(); return result; } catch (error) { if (controller.signal.aborted) throw controller.signal.reason; if (Date.now() >= deadline) throw ownerReleaseTimeout(); throw error; } finally { clearTimeout(timer); } }
async function settleOwnerReleaseCaller(operation, deadline) { const remainingMs = deadline - Date.now(); if (remainingMs <= 0) throw ownerReleaseTimeout(); let settled = false; void operation.then(() => { settled = true; }, () => { settled = true; }); let timer; let check; try { return await Promise.race([operation, new Promise((_resolvePromise, rejectPromise) => { timer = setTimeout(() => { check = setImmediate(() => { if (!settled) rejectPromise(ownerReleaseTimeout()); }); }, remainingMs); timer.unref?.(); })]); } finally { clearTimeout(timer); clearImmediate(check); } }
function turnActiveError(message) { return new PluginError('ZCODE_TURN_ACTIVE', message, { category: 'state', remedy: 'Wait for the active session operation to finish.' }); }
function validWireOption(value, maximum) { return value === undefined || Number.isSafeInteger(value) && value >= 128 && value <= maximum; }
function validIdleTimeoutOption(value) { return value === undefined || Number.isSafeInteger(value) && value >= MIN_BROKER_IDLE_TIMEOUT_MS && value <= MAX_BROKER_IDLE_TIMEOUT_MS; }
function validDrainOption(value) { return value === undefined || Number.isSafeInteger(value) && value >= 1 && value <= MAX_DRAIN_TIMEOUT_MS; }
function canonicalEndpointPath(path) { try { return realpathSync.native(resolve(path)); } catch { return path; } }
function sameBrokerIdentity(left, right) { return left?.endpoint === right?.endpoint && left?.pid === right?.pid && left?.instanceId === right?.instanceId && left?.brokerToken === right?.brokerToken; }
async function removeBrokerIdentityInstance(path, instanceId) { let value; try { value = JSON.parse(await readFile(path, 'utf8')); } catch (error) { if (error?.code === 'ENOENT') return false; return false; } if (value?.instanceId !== instanceId) return false; try { await unlink(path); return true; } catch (error) { if (error?.code === 'ENOENT') return false; throw error; } }
async function removeBrokerIdentityRecord(path, expected) { let value; try { value = JSON.parse(await readFile(path, 'utf8')); } catch { return false; } if (!sameBrokerIdentity(value, expected)) return false; try { await unlink(path); return true; } catch (error) { if (error?.code === 'ENOENT') return false; throw error; } }
async function removeBrokerStartupConfig(path, expected) { let value; try { value = JSON.parse(await readFile(path, 'utf8')); } catch { return false; } if (JSON.stringify(value) !== JSON.stringify(expected)) return false; try { await unlink(path); return true; } catch (error) { if (error?.code === 'ENOENT') return false; throw error; } }
async function retireDeadBrokerIdentity(identityPath, endpoint, expected, platform) { if (await rawEndpointState(endpoint) !== 'stale') return false; const current = await inspectBrokerIdentity(identityPath, { expectedEndpoint: endpoint }); if (current.status !== 'dead' || !sameBrokerIdentity(current.record, expected) || isProcessAlive(expected.pid) || await rawEndpointState(endpoint) !== 'stale') return false; if (platform !== 'win32') await unlink(endpoint).catch((error) => { if (error?.code !== 'ENOENT') throw error; }); return removeBrokerIdentityRecord(identityPath, expected); }
async function clearStaleMissingEndpoint(identityPath, endpoint, platform) { if (await rawEndpointState(endpoint) !== 'stale') throw brokerUnhealthyError(); const identity = await inspectBrokerIdentity(identityPath, { expectedEndpoint: endpoint }); if (identity.status !== 'missing') throw brokerUnhealthyError(); if (await rawEndpointState(endpoint) !== 'stale') throw brokerUnhealthyError(); if (platform !== 'win32') await unlink(endpoint).catch((error) => { if (error?.code !== 'ENOENT') throw error; }); }
async function rawEndpointState(endpoint) { return new Promise((resolvePromise) => { const socket = net.createConnection(endpoint); let settled = false; const settle = (state) => { if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); resolvePromise(state); }; const timer = setTimeout(() => settle('unknown'), RAW_ENDPOINT_PROBE_MS); timer.unref?.(); socket.once('connect', () => settle('live')); socket.once('error', (error) => settle(['ECONNREFUSED', 'ENOENT'].includes(error?.code) ? 'stale' : 'unknown')); }); }
function isWindowsNamedPipe(endpoint) { return typeof endpoint === 'string' && endpoint.toLowerCase().startsWith('\\\\.\\pipe\\'); }
function isProcessAlive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
function safeTokenEqual(left, right) { const a = Buffer.from(left); const b = Buffer.from(right); return a.length === b.length && timingSafeEqual(a, b); }
function offeredDeny(request) { return request.options?.find((option) => option.response?.decision === 'deny')?.response ?? { decision: 'deny' }; }
function validateSendResult(result, sessionId) { if (!result || typeof result !== 'object' || result.accepted !== true || result.sessionId !== sessionId || !Number.isSafeInteger(result.stateRevision) || result.stateRevision < 0 || result.modelRuntimeRevision !== undefined && (typeof result.modelRuntimeRevision !== 'string' || !result.modelRuntimeRevision)) throw new PluginError('ZCODE_OUTPUT_INVALID', 'ZCode returned an invalid session/send result.', { category: 'protocol', remedy: 'Upgrade or restart ZCode and retry.' }); }
function validateStopResult(result) { if (!plainObject(result)) throw new PluginError('ZCODE_OUTPUT_INVALID', 'ZCode returned an invalid session/stop result.', { category: 'protocol', remedy: 'Upgrade or restart ZCode and retry.' }); }
function writeSessionOwnerDenied(socket, id) { writeLocal(socket, { id, error: { code: -32041, message: 'Session is not owned by this broker client.' } }); }
function invalidSessionCreateResult() { return new PluginError('ZCODE_OUTPUT_INVALID', 'ZCode returned an invalid session/create result.', { category: 'protocol', remedy: 'Upgrade or restart ZCode and retry.' }); }
function validConversationSubscribeResult(result) { const ack = result?.ack; return plainObject(result) && plainObject(ack) && isBoundedPublicIdentifier(ack.subscriptionId) && ['snapshot', 'resume'].includes(ack.mode) && isBoundedPublicIdentifier(ack.logEpoch); }
function validCreateWorkspace(workspace, expectedWorkspace) { return plainObject(workspace) && Object.keys(workspace).every((key) => ['workspacePath', 'workspaceIdentity', 'remoteSessionId', 'workspaceKey'].includes(key)) && workspace.workspacePath === expectedWorkspace && workspace.workspaceKey === expectedWorkspace && optionalPublicText(workspace.workspaceIdentity) && optionalPublicText(workspace.remoteSessionId); }
function optionalPublicText(value) { return value === undefined || typeof value === 'string' && value.trim().length > 0; }
function validConversationUnsubscribeResult(result) { return plainObject(result); }
function invalidUnsubscribeResult() { return new PluginError('ZCODE_OUTPUT_INVALID', 'ZCode returned an invalid conversation unsubscribe result.', { category: 'protocol', remedy: 'Upgrade or restart ZCode and retry.' }); }
function plainObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null); }
function cloneOwnerSessions(sessions) { const cloned = Object.create(null); for (const [sessionId, ownerId] of Object.entries(sessions)) cloned[sessionId] = ownerId; return cloned; }
function sameOwnerEntry(left, right, sessionId) { return Object.hasOwn(left, sessionId) === Object.hasOwn(right, sessionId) && (!Object.hasOwn(left, sessionId) || left[sessionId] === right[sessionId]); }
function sameOwnerSessions(left, right) { const leftKeys = Object.keys(left); return leftKeys.length === Object.keys(right).length && leftKeys.every((sessionId) => sameOwnerEntry(left, right, sessionId)); }
function validOwnerStore(value) { return value && value.version === 1 && value.sessions && typeof value.sessions === 'object' && !Array.isArray(value.sessions) && Object.entries(value.sessions).every(([sessionId, ownerId]) => sessionId && typeof ownerId === 'string' && ownerId.length >= 16); }
async function readOwnerStore(path, allowMissing, lockOptions) { return withFileLock(`${path}.lock`, async () => readOwnerStoreUnlocked(path, allowMissing, lockOptions?.signal), lockOptions); }
async function mutateOwnerStore(path, allowMissing, operation, lockOptions) { return withFileLock(`${path}.lock`, async () => { const loaded = await readOwnerStoreUnlocked(path, allowMissing, lockOptions?.signal); return operation(loaded.sessions); }, lockOptions); }
async function readOwnerStoreUnlocked(path, allowMissing, signal) { let value; try { value = JSON.parse(await readFile(path, { encoding: 'utf8', signal })); } catch (error) { if (signal?.aborted) throw signal.reason; if (error?.code === 'ENOENT' && allowMissing) return { exists: false, sessions: Object.create(null) }; throw ownerStoreInvalid(error); } if (!validOwnerStore(value)) throw ownerStoreInvalid(); const sessions = Object.create(null); for (const [sessionId, ownerId] of Object.entries(value.sessions)) sessions[sessionId] = ownerId; return { exists: true, sessions }; }
function writeRequestError(socket, id, error) { const pluginError = error instanceof PluginError ? { code: error.code, category: error.category, remedy: error.remedy, details: error.details } : null; writeLocal(socket, { id, error: { code: -32000, message: error instanceof Error ? error.message : 'Broker request failed', ...(pluginError ? { data: { pluginError } } : {}) } }); }
function ownerStoreInvalid(cause) { return new PluginError('ZCODE_OWNER_STORE_INVALID', 'The ZCode session owner store is missing or corrupt.', { category: 'storage', remedy: 'Reconcile ownership from validated durable job records before resuming sessions.', ...(cause === undefined ? {} : { cause }) }); }
function ownerConflict() { return new PluginError('ZCODE_SESSION_OWNER_CONFLICT', 'The session already belongs to another broker owner.', { category: 'authorization', remedy: 'Use the original stable owner credential.' }); }
function existingProtocolUnavailable() { return new PluginError('ZCODE_BROKER_PROTOCOL_UNAVAILABLE', 'The existing ZCode protocol is unavailable.', { category: 'state', remedy: 'Retry after an active ZCode broker protocol is available.' }); }
function protocolRetiring() { return new PluginError('ZCODE_PROTOCOL_RETIRING', 'The previous ZCode protocol generation has not closed safely.', { category: 'state', remedy: 'Retry after the retired protocol generation closes.' }); }
function brokerUnhealthyError() { return new PluginError('ZCODE_BROKER_UNHEALTHY', 'The recorded ZCode broker identity cannot be safely replaced after its health check failed.', { category: 'state', remedy: 'Stop or repair the recorded broker process before retrying.' }); }
function brokerInputError() { return new PluginError('ZCODE_BROKER_INPUT_INVALID', 'ZCode broker input is invalid.', { category: 'validation', remedy: 'Provide a data root, workspace, endpoint, and launch target.' }); }
function ownerReleaseTimeout() { return new PluginError('ZCODE_OWNER_RELEASE_TIMEOUT', 'The ZCode owner release exceeded its bounded storage budget.', { category: 'timeout', remedy: 'Retry after the active owner-store operation completes.' }); }
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
