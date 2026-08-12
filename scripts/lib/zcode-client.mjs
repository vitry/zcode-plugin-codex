import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readdir, realpath } from 'node:fs/promises';

import { PluginError } from './errors.mjs';
import { isBoundedPublicIdentifier, isSafeIdentifier } from './identifier.mjs';
import { closeProtocolUntil, connectZCodeBroker, MAX_DRAIN_TIMEOUT_MS, spawnZCodeProtocol } from './zcode-protocol.mjs';
import { validSessionInfo, validSnapshot as snapshotValid } from './zcode-schema.mjs';
import { brokerEndpointFor, brokerIdentityNameForWireOptions, ensureZCodeBroker, inspectBrokerIdentity, MAX_BROKER_IDLE_TIMEOUT_MS, MIN_BROKER_IDLE_TIMEOUT_MS, prioritizeBrokerOwnership } from '../zcode-broker.mjs';
import { resolveWorkspaceStorage } from './workspace.mjs';

const THOUGHT_LEVELS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);
const OWNER_CLEANUP_BUDGET_MS = 1_800;
const OWNER_CLEANUP_MAX_BATCHES = 32;
const OWNER_CLEANUP_LEGACY_ACTIVE_MAX = 64;
const OWNER_CLEANUP_LEGACY_BATCH_SIZE = 8;
export const IMPORTED_HISTORY_SOURCE = 'claudeCode';

export class ZCodeClient {
  /** @param {import('./zcode-protocol.mjs').ZCodeProtocolClient} protocol @param {string} [workspace] @param {boolean} [workspaceBound] */
  constructor(protocol, workspace, workspaceBound = false) { this.protocol = protocol; this.defaultWorkspace = workspace === undefined ? null : resolve(workspace); this.workspaceBound = workspaceBound; this.sessionCatalogs = new Map(); this.sessionWorkspaces = new Map(); }

  /** @param {{workspace:string,sessionId?:string,model?:{providerId:string,modelId:string,variant?:string},importedHistory?:{title?:string,createdAt?:number,updatedAt?:number,messages:Array<{role:'user'|'assistant',content:string,timestamp?:number}>}}} input */
  async createSession(input) {
    requireExactObject(input, ['workspace'], ['sessionId', 'model', 'importedHistory']);
    requireString(input.workspace);
    if (input.sessionId !== undefined) requireSessionId(input.sessionId);
    if (input.model !== undefined) validateModel(input.model);
    const suppliedWorkspace = resolve(input.workspace);
    let workspacePath = suppliedWorkspace;
    if (this.workspaceBound) {
      try { workspacePath = await realpath(suppliedWorkspace); } catch { throw inputError(); }
      if (workspacePath !== this.defaultWorkspace) throw inputError();
    }
    /** @type {any} */
    const params = { workspace: { workspacePath, workspaceKey: workspacePath } };
    if (input.sessionId !== undefined) params.sessionId = input.sessionId;
    if (input.model !== undefined) params.model = copyModel(input.model);
    if (input.importedHistory !== undefined) params.importedHistory = normalizeImportedHistory(input.importedHistory);
    const result = await this.protocol.request('session/create', params);
    if (!plainObject(result) || !plainObject(result.session) || !isSafeIdentifier(result.session.sessionId) || input.sessionId && result.session.sessionId !== input.sessionId) throw outputError('session/create');
    validateSnapshot(result, result.session.sessionId, workspacePath, 'session/create');
    this.sessionWorkspaces.set(result.session.sessionId, workspacePath);
    if (plainObject(result.settings?.model) && Array.isArray(result.settings.model.available)) this.sessionCatalogs.set(result.session.sessionId, result.settings.model);
    return result;
  }

  /** @param {string} sessionId @param {string} content @param {Record<string,never>} [options] */
  async send(sessionId, content, options = {}) {
    requireSessionId(sessionId); if (typeof content !== 'string') throw inputError(); requireExactObject(options, [], []);
    this.protocol.beginTurn(sessionId);
    const inputId = randomUUID();
    let result;
    try { result = await this.protocol.request('session/send', { sessionId, inputId, queryId: inputId, content }); } catch (error) { this.protocol.abortTurn(sessionId); throw error; }
    if (!plainObject(result) || result.accepted !== true || result.sessionId !== sessionId || !Number.isSafeInteger(result.stateRevision) || result.stateRevision < 0 || result.modelRuntimeRevision !== undefined && !nonEmpty(result.modelRuntimeRevision)) { this.protocol.abortTurn(sessionId); throw outputError('session/send'); }
    this.protocol.armTurn(sessionId, result.stateRevision, inputId);
    return { ...result, inputId };
  }

  /** @param {string} sessionId */ async readSession(sessionId) { requireSessionId(sessionId); const result = await this.protocol.request('session/read', { sessionId }); validateSnapshot(result, sessionId, this.expectedWorkspace(sessionId), 'session/read'); this.sessionCatalogs.set(sessionId, result.settings.model); return result; }
  /** @param {string} sessionId */ async resumeSession(sessionId) { requireSessionId(sessionId); const result = await this.protocol.request('session/resume', { sessionId }); validateSnapshot(result, sessionId, this.expectedWorkspace(sessionId), 'session/resume'); this.sessionCatalogs.set(sessionId, result.settings.model); this.sessionWorkspaces.set(sessionId, result.session.workspace.workspacePath); return result; }
  /** @param {number} [timeoutMs] */ async listSessions(timeoutMs) { const result = requireObjectResult(await this.protocol.request('session/list', {}, timeoutMs), 'session/list'); if (!Array.isArray(result.sessions) || !result.sessions.every(validSessionInfo)) throw outputError('session/list'); return result; }
  /** @param {string} sessionId @param {number} [timeoutMs] */ async stopSession(sessionId, timeoutMs) { requireSessionId(sessionId); const result = await this.protocol.request('session/stop', { sessionId }, timeoutMs); if (!plainObject(result)) throw outputError('session/stop'); if (!this.protocol.acceptBrokerControl) this.protocol.cancelTurn(sessionId); return result; }
  /** @param {number} [timeoutMs] */ async brokerCapabilities(timeoutMs) { const { releaseOwnerExclusions } = await readBrokerHealth(this, timeoutMs); return { releaseOwnerExclusions }; }
  /** @param {string[]} [excludeSessionIds] @param {number} [timeoutMs] */
  async releaseOwner(excludeSessionIds, timeoutMs) { if (excludeSessionIds !== undefined && (!Array.isArray(excludeSessionIds) || excludeSessionIds.length > 1_000 || new Set(excludeSessionIds).size !== excludeSessionIds.length || !excludeSessionIds.every((sessionId) => isSafeIdentifier(sessionId)))) throw inputError(); const result = await this.protocol.request('broker/releaseOwner', excludeSessionIds === undefined ? {} : { excludeSessionIds }, timeoutMs); if (!plainObject(result) || !Array.isArray(result.releasedSessionIds) || !Array.isArray(result.failedSessionIds) || !result.releasedSessionIds.every((sessionId) => isSafeIdentifier(sessionId)) || !result.failedSessionIds.every((sessionId) => isSafeIdentifier(sessionId)) || !Number.isSafeInteger(result.deferredSessionCount) || result.deferredSessionCount < 0) throw outputError('broker/releaseOwner'); return result; }

  /** @param {string} sessionId @param {{providerId:string,modelId:string,variant?:string}} model */
  async setModel(sessionId, model) {
    requireSessionId(sessionId); validateModel(model);
    const result = await this.protocol.request('session/setModel', { sessionId, model: copyModel(model), persistAsWorkspaceLastUsed: false });
    validateSnapshot(result, sessionId, this.expectedWorkspace(sessionId), 'session/setModel');
    if (!exactModel(result.settings.model.current) || !sameModel(result.settings.model.current, model)) throw new PluginError('ZCODE_MODEL_APPLY_MISMATCH', 'ZCode did not apply the exact requested model.', { category: 'protocol', remedy: 'Retry with a model tuple advertised by ZCode.' });
    this.sessionCatalogs.set(sessionId, result.settings.model); return result;
  }

  /** @param {string} sessionId @param {string} thoughtLevel */
  async setThoughtLevel(sessionId, thoughtLevel) {
    requireSessionId(sessionId);
    if (!nonEmpty(thoughtLevel)) throw inputError();
    const normalized = thoughtLevel.toLowerCase();
    if (!THOUGHT_LEVELS.has(normalized)) throw new PluginError('ZCODE_THOUGHT_LEVEL_INVALID', 'The requested thought level is invalid.', { category: 'validation', remedy: 'Use none, minimal, low, medium, high, or xhigh.' });
    const catalog = this.sessionCatalogs.get(sessionId);
    const selected = catalog?.available?.find((/** @type {any} */ entry) => sameModel(entry?.ref, catalog.current));
    const advertised = advertisedThoughtLevels(selected);
    const actual = advertised.find((value) => value.toLowerCase() === normalized);
    if (!actual) throw new PluginError('ZCODE_THOUGHT_LEVEL_UNSUPPORTED', 'The selected model does not advertise this thought level.', { category: 'configuration', remedy: 'Choose a thought level advertised by the selected model.', details: { thoughtLevel: normalized } });
    const result = await this.protocol.request('session/setThoughtLevel', { sessionId, thoughtLevel: actual, persistAsWorkspaceLastUsed: false });
    validateSnapshot(result, sessionId, this.expectedWorkspace(sessionId), 'session/setThoughtLevel');
    if (typeof result.settings.thoughtLevel.current !== 'string' || result.settings.thoughtLevel.current.toLowerCase() !== actual.toLowerCase()) throw new PluginError('ZCODE_THOUGHT_LEVEL_APPLY_MISMATCH', 'ZCode did not apply the exact requested thought level.', { category: 'protocol', remedy: 'Retry with a thought level advertised by the selected model.' });
    this.sessionCatalogs.set(sessionId, result.settings.model); return result;
  }

  /** @param {string} sessionId @param {number} [timeoutMs] */ waitForCompletion(sessionId, timeoutMs) { return this.protocol.waitForCompletion(sessionId, timeoutMs); }
  /** Exact local protocol invariant used to prove whether this client owns an active turn. @param {string} sessionId */ turnState(sessionId) { requireSessionId(sessionId); return this.protocol.turnState(sessionId); }
  /** @param {string} sessionId @param {{connectionId:string,clientMode:'desktop-continuous'|'web-remote-replayable'}} options */
  async subscribeConversation(sessionId, options) {
    requireSessionId(sessionId);
    requireExactObject(options, ['connectionId', 'clientMode'], []);
    if (!isBoundedPublicIdentifier(options.connectionId) || !['desktop-continuous', 'web-remote-replayable'].includes(options.clientMode)) throw inputError();
    const result = requireObjectResult(await this.protocol.request('v4/conversation/subscribe', {
      topic: `conversation/${sessionId}`,
      connectionId: options.connectionId,
      clientMode: options.clientMode,
    }), 'v4/conversation/subscribe');
    const ack = result.ack;
    if (!exactObjectKeys(result, ['ack']) || !plainObject(ack) || !exactObjectKeys(ack, ['subscriptionId', 'mode', 'logEpoch'])
      || !isBoundedPublicIdentifier(ack.subscriptionId) || !['snapshot', 'resume'].includes(ack.mode) || !isBoundedPublicIdentifier(ack.logEpoch)) throw outputError('v4/conversation/subscribe');
    let unsubscribed = false;
    return {
      subscriptionId: ack.subscriptionId,
      unsubscribe: async () => {
        if (unsubscribed) return;
        unsubscribed = true;
        const response = await this.protocol.request('v4/conversation/unsubscribe', { topic: `conversation/${sessionId}`, subscriptionId: ack.subscriptionId, connectionId: options.connectionId });
        if (!plainObject(response) || Object.keys(response).length !== 0) throw outputError('v4/conversation/unsubscribe');
      },
    };
  }
  /** @param {(message:any)=>void} handler */ subscribe(handler) { return this.protocol.subscribe(handler); }
  /** @param {(request:any,signal:AbortSignal)=>Promise<any>|any} handler */ setPermissionHandler(handler) { this.protocol.setPermissionHandler(handler); }
  /** @param {string} sessionId */ expectedWorkspace(sessionId) { const workspace = this.sessionWorkspaces.get(sessionId) ?? this.defaultWorkspace; if (workspace === null) throw inputError(); return workspace; }
  close() { return this.protocol.close(); }
}

/** @param {{workspace:string,launch?:{command:string,args:string[],target?:string},brokerEndpoint?:string,brokerToken?:string,ownerId?:string,existingProtocolOnly?:boolean,env?:NodeJS.ProcessEnv,requestTimeoutMs?:number,completionTimeoutMs?:number,maxFrameBytes?:number,maxOutboundBytes?:number,drainTimeoutMs?:number}} options */
export async function createZCodeClient(options) {
  if (!plainObject(options) || !nonEmpty(options.workspace)
    || (options.brokerEndpoint === undefined) === (options.launch === undefined)
    || options.brokerEndpoint !== undefined && (!nonEmpty(options.brokerEndpoint) || !nonEmpty(options.brokerToken) || options.brokerToken.length < 32 || !nonEmpty(options.ownerId) || options.ownerId.length < 16)
    || options.existingProtocolOnly !== undefined && (options.brokerEndpoint === undefined || typeof options.existingProtocolOnly !== 'boolean')
    || options.launch !== undefined && !plainObject(options.launch)) throw inputError();
  let workspacePath = resolve(options.workspace);
  if (options.brokerEndpoint !== undefined) { try { workspacePath = await realpath(workspacePath); } catch { throw inputError(); } }
  const protocolOptions = {
    cwd: workspacePath, env: options.env, requestTimeoutMs: options.requestTimeoutMs,
    completionTimeoutMs: options.completionTimeoutMs, maxFrameBytes: options.maxFrameBytes, maxOutboundBytes: options.maxOutboundBytes, drainTimeoutMs: options.drainTimeoutMs,
  };
  const protocol = options.brokerEndpoint
    ? await connectZCodeBroker(options.brokerEndpoint, { ...protocolOptions, brokerToken: /** @type {string} */ (options.brokerToken), ownerId: /** @type {string} */ (options.ownerId), ...(options.existingProtocolOnly === undefined ? {} : { existingProtocolOnly: options.existingProtocolOnly }) })
    : await spawnZCodeProtocol(/** @type {{command:string,args:string[],target?:string}} */ (options.launch), protocolOptions);
  return new ZCodeClient(protocol, workspacePath, options.brokerEndpoint !== undefined);
}

/** @param {{dataRoot:string,workspace:string,launch:{command:string,args:string[],target?:string},ownerId:string,env?:NodeJS.ProcessEnv,requestTimeoutMs?:number,completionTimeoutMs?:number,idleTimeoutMs?:number,maxFrameBytes?:number,maxOutboundBytes?:number,drainTimeoutMs?:number}} options */
export async function createManagedZCodeClient(options) {
  if (!plainObject(options) || !nonEmpty(options.dataRoot) || !nonEmpty(options.workspace) || !plainObject(options.launch) || !nonEmpty(options.ownerId) || options.ownerId.length < 16
    || !boundedIdleTimeoutOption(options.idleTimeoutMs) || !boundedWireOption(options.maxFrameBytes, 16 * 1024 * 1024) || !boundedWireOption(options.maxOutboundBytes, 64 * 1024 * 1024) || !boundedDrainOption(options.drainTimeoutMs)) throw inputError();
  const storage = await resolveWorkspaceStorage(options);
  const identity = await ensureZCodeBroker({ ...options, workspace: storage.workspacePath });
  return createZCodeClient({ workspace: storage.workspacePath, brokerEndpoint: identity.endpoint, brokerToken: identity.brokerToken, ownerId: options.ownerId, requestTimeoutMs: options.requestTimeoutMs, completionTimeoutMs: options.completionTimeoutMs, maxFrameBytes: options.maxFrameBytes, maxOutboundBytes: options.maxOutboundBytes, drainTimeoutMs: options.drainTimeoutMs });
}

/** @param {{dataRoot:string,workspace:string,ownerId:string,requestTimeoutMs?:number,maxFrameBytes?:number,maxOutboundBytes?:number,drainTimeoutMs?:number}} options */
export async function createExistingManagedZCodeClient(options) {
  requireExactObject(options, ['dataRoot', 'workspace', 'ownerId'], ['requestTimeoutMs', 'maxFrameBytes', 'maxOutboundBytes', 'drainTimeoutMs']);
  if (!nonEmpty(options.dataRoot) || !nonEmpty(options.workspace) || !nonEmpty(options.ownerId) || options.ownerId.length < 16
    || !boundedRequestOption(options.requestTimeoutMs) || !boundedWireOption(options.maxFrameBytes, 16 * 1024 * 1024) || !boundedWireOption(options.maxOutboundBytes, 64 * 1024 * 1024) || !boundedDrainOption(options.drainTimeoutMs)) throw inputError();
  const storage = await resolveWorkspaceStorage(options);
  const identityName = brokerIdentityNameForWireOptions(options);
  const inspected = await inspectBrokerIdentity(resolve(storage.directory, 'broker', identityName), {
    expectedEndpoint: expectedBrokerEndpoint(options.dataRoot, storage.workspacePath, identityName),
    healthProbe: async () => true,
  });
  if (inspected.status !== 'healthy') return null;
  const deadline = Date.now() + (options.requestTimeoutMs ?? 30_000);
  try {
    const client = await createZCodeClient({ workspace: storage.workspacePath, brokerEndpoint: inspected.record.endpoint, brokerToken: inspected.record.brokerToken, ownerId: options.ownerId, existingProtocolOnly: true, requestTimeoutMs: requiredCleanupTimeout(deadline, options.requestTimeoutMs ?? 30_000), maxFrameBytes: options.maxFrameBytes, maxOutboundBytes: options.maxOutboundBytes, drainTimeoutMs: options.drainTimeoutMs });
    try { await verifyBrokerIdentity(client, inspected.record, deadline, options.requestTimeoutMs ?? 30_000); return client; } catch (error) { await closeProtocolUntil(client, deadline); throw error; }
  } catch { return null; }
}

/**
 * Releases an exact lifecycle owner from brokers that already exist. This
 * function never calls ensureZCodeBroker and therefore cannot start ZCode from
 * a SessionEnd hook.
 * @param {{dataRoot:string,workspace:string,ownerId:string,requestTimeoutMs?:number,cleanupBudgetMs?:number}} options
 */
export async function releaseManagedZCodeOwner(options) {
  if (!plainObject(options) || !nonEmpty(options.dataRoot) || !nonEmpty(options.workspace) || !nonEmpty(options.ownerId) || options.ownerId.length < 16
    || options.cleanupBudgetMs !== undefined && (!Number.isSafeInteger(options.cleanupBudgetMs) || options.cleanupBudgetMs < 1 || options.cleanupBudgetMs > OWNER_CLEANUP_BUDGET_MS)) throw inputError();
  const storage = await resolveWorkspaceStorage(options); const brokerDirectory = resolve(storage.directory, 'broker'); let names;
  try { names = await readdir(brokerDirectory); } catch (error) { if ((/** @type {NodeJS.ErrnoException} */ (error))?.code === 'ENOENT') return { releasedSessionIds: [], failedSessionIds: [], deferredSessionCount: 0 }; throw error; }
  const matchingNames = names.filter((name) => /^identity(?:-[a-f0-9]{16})?\.json$/.test(name)).sort(); const selectedNames = matchingNames.slice(0, 32); const truncatedProfileCount = matchingNames.length - selectedNames.length; const cleanupDeadline = Date.now() + (options.cleanupBudgetMs ?? OWNER_CLEANUP_BUDGET_MS); const requestTimeoutMs = options.requestTimeoutMs ?? 750;
  const candidates = await Promise.all(selectedNames.map(async (identityName) => {
    const identityPath = resolve(brokerDirectory, identityName); const expectedEndpoint = expectedBrokerEndpoint(options.dataRoot, storage.workspacePath, identityName); const inspected = await inspectBrokerIdentity(identityPath, { expectedEndpoint, healthProbe: async () => true });
    if (inspected.status !== 'healthy') return { identity: null, identityName, status: inspected.status, unavailable: true, client: null, capabilities: null };
    let client = null;
    try { client = await createZCodeClient({ workspace: storage.workspacePath, brokerEndpoint: inspected.record.endpoint, brokerToken: inspected.record.brokerToken, ownerId: options.ownerId, requestTimeoutMs: requiredCleanupTimeout(cleanupDeadline, requestTimeoutMs) }); const capabilities = await verifyBrokerIdentity(client, inspected.record, cleanupDeadline, requestTimeoutMs); return { identity: inspected.record, identityName, status: 'healthy', unavailable: false, client, capabilities }; }
    catch { await closeProtocolUntil(client, cleanupDeadline); return { identity: null, identityName, status: 'unhealthy', unavailable: true, client: null, capabilities: null }; }
  }));
  const unavailableProfiles = candidates.filter((profile) => profile.unavailable); const unavailableProfileCount = unavailableProfiles.length; const identityStatusCounts = boundedIdentityStatusCounts(unavailableProfiles.map((profile) => profile.status)); const profiles = candidates.filter((profile) => profile.identity);
  const outcomes = await Promise.all(profiles.map(async ({ identityName, client, capabilities }) => {
    const verifiedClient = /** @type {ZCodeClient} */ (client); const verifiedCapabilities = /** @type {{releaseOwnerExclusions:boolean}} */ (capabilities);
    /** @type {Set<string>} */ const released = new Set(); /** @type {Set<string>} */ const failed = new Set();
    let profileDeferred = 0; let profileError = null; let releaseProof = false;
    try {
      const deadline = cleanupDeadline; const attempted = new Set();
      let legacyFallback = false;
      for (let batch = 0; batch < OWNER_CLEANUP_MAX_BATCHES && Date.now() < deadline; batch += 1) {
        const result = await releaseOwnerWithBusyRetry(verifiedClient, verifiedCapabilities.releaseOwnerExclusions ? [...attempted] : undefined, deadline, requestTimeoutMs); releaseProof = true; profileDeferred = result.deferredSessionCount;
        for (const sessionId of result.releasedSessionIds) { attempted.add(sessionId); released.add(sessionId); failed.delete(sessionId); }
        for (const sessionId of result.failedSessionIds) { attempted.add(sessionId); if (!released.has(sessionId)) failed.add(sessionId); }
        if (!profileDeferred || result.releasedSessionIds.length + result.failedSessionIds.length === 0) break;
        if (!verifiedCapabilities.releaseOwnerExclusions && (result.failedSessionIds.length || !result.releasedSessionIds.length)) { legacyFallback = true; break; }
      }
      if (!verifiedCapabilities.releaseOwnerExclusions && legacyFallback && profileDeferred > 0 && Date.now() < deadline) {
        const listed = await verifiedClient.listSessions(boundedCleanupTimeout(deadline, requestTimeoutMs)); const candidates = listed.sessions.map((/** @type {any} */ session) => session.sessionId).filter((/** @type {string} */ sessionId) => !attempted.has(sessionId)).slice(0, OWNER_CLEANUP_LEGACY_ACTIVE_MAX);
        for (let offset = 0; offset < candidates.length && Date.now() < deadline; offset += OWNER_CLEANUP_LEGACY_BATCH_SIZE) {
          const batch = candidates.slice(offset, offset + OWNER_CLEANUP_LEGACY_BATCH_SIZE); const prioritized = await prioritizeBrokerOwnership({ dataRoot: options.dataRoot, workspace: storage.workspacePath, identityName, ownerId: options.ownerId, sessionIds: batch, lockTimeoutMs: remainingCleanupTimeout(deadline) }); if (!prioritized.prioritizedSessionIds.length) continue;
          const result = await releaseOwnerWithBusyRetry(verifiedClient, undefined, deadline, requestTimeoutMs); releaseProof = true; profileDeferred = result.deferredSessionCount; for (const sessionId of result.releasedSessionIds) { attempted.add(sessionId); released.add(sessionId); failed.delete(sessionId); } for (const sessionId of result.failedSessionIds) { attempted.add(sessionId); if (!released.has(sessionId)) failed.add(sessionId); }
        }
      }
      if (!releaseProof) throw ownerReleaseIncomplete({ releaseProofMissingProfileCount: 1 });
    }
    catch (error) { profileError = error; }
    finally { await closeProtocolUntil(verifiedClient, cleanupDeadline); }
    return { releasedSessionIds: [...released], failedSessionIds: [...failed], deferredSessionCount: profileDeferred, releaseProof, error: profileError };
  }));
  const released = outcomes.flatMap((outcome) => outcome.releasedSessionIds); const failed = outcomes.flatMap((outcome) => outcome.failedSessionIds); const deferredSessionCount = outcomes.reduce((total, outcome) => total + outcome.deferredSessionCount, 0);
  const errorOutcomes = outcomes.filter((outcome) => outcome.error); const releaseProofMissingProfileCount = outcomes.filter((outcome) => !outcome.releaseProof).length; const proofOnlyFailureCount = outcomes.filter((outcome) => !outcome.releaseProof && !outcome.error).length; const causeCodeCounts = boundedCauseCodeCounts(errorOutcomes.map((outcome) => outcome.error)); const resultTruncated = released.length > 1_000 || failed.length > 1_000; const failedProfileCount = unavailableProfileCount + errorOutcomes.length + proofOnlyFailureCount + truncatedProfileCount; if (failedProfileCount || resultTruncated) throw ownerReleaseIncomplete({ failedProfileCount, completedProfileCount: outcomes.length - errorOutcomes.length - proofOnlyFailureCount, releasedSessionCount: released.length, failedSessionCount: failed.length, deferredSessionCount, releaseProofMissingProfileCount, truncatedProfileCount, resultTruncated, identityStatusCounts, causeCodeCounts });
  return { releasedSessionIds: released.slice(0, 1_000), failedSessionIds: failed.slice(0, 1_000), deferredSessionCount };
}

/** @param {ZCodeClient} client @param {string[]|undefined} excludeSessionIds @param {number} deadline @param {number} requestTimeoutMs */
async function releaseOwnerWithBusyRetry(client, excludeSessionIds, deadline, requestTimeoutMs) { let busyError; while (Date.now() < deadline) { try { return await client.releaseOwner(excludeSessionIds, boundedCleanupTimeout(deadline, requestTimeoutMs)); } catch (error) { if ((/** @type {{code?:string}} */ (error))?.code !== 'ZCODE_TURN_ACTIVE') throw error; busyError = error; const remainingMs = deadline - Date.now(); if (remainingMs <= 1) break; await new Promise((resolvePromise) => setTimeout(resolvePromise, Math.min(25, remainingMs - 1))); } } throw busyError ?? ownerReleaseIncomplete({ failedProfileCount: 1 }); }

/** @param {ZCodeClient} client @param {{pid:number,instanceId:string}} identity @param {number} deadline @param {number} requestTimeoutMs */
async function verifyBrokerIdentity(client, identity, deadline, requestTimeoutMs) { const health = await readBrokerHealth(client, boundedCleanupTimeout(deadline, requestTimeoutMs)); if (health.pid !== identity.pid || health.instanceId !== identity.instanceId) throw outputError('broker/health'); return { releaseOwnerExclusions: health.releaseOwnerExclusions }; }

/** @param {ZCodeClient} client @param {number|undefined} timeoutMs */
async function readBrokerHealth(client, timeoutMs) { const result = await client.protocol.request('broker/health', {}, timeoutMs); if (!plainObject(result) || result.ok !== true || !Number.isSafeInteger(result.pid) || result.pid <= 1 || !isSafeIdentifier(result.instanceId)) throw outputError('broker/health'); return { pid: result.pid, instanceId: result.instanceId, releaseOwnerExclusions: result.capabilities?.releaseOwnerExclusions === true }; }

/** @param {unknown[]} errors */
function boundedCauseCodeCounts(errors) { const counts = /** @type {Record<string,number>} */ ({}); for (const error of errors.slice(0, 32)) { const candidate = (/** @type {{code?:unknown}} */ (error))?.code; const code = typeof candidate === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(candidate) ? candidate : 'UNKNOWN'; counts[code] = (counts[code] ?? 0) + 1; } return counts; }
/** @param {string[]} statuses */
function boundedIdentityStatusCounts(statuses) { const counts = /** @type {Record<string,number>} */ ({}); for (const status of statuses.slice(0, 32)) if (['missing', 'invalid', 'dead', 'unhealthy'].includes(status)) counts[status] = (counts[status] ?? 0) + 1; return counts; }

/** @param {Record<string,unknown>} details */
function ownerReleaseIncomplete(details) { return new PluginError('ZCODE_OWNER_RELEASE_INCOMPLETE', 'ZCode owner cleanup could not confirm every broker profile or bounded result.', { category: 'state', remedy: 'Retry owner cleanup; confirmed releases are idempotent.', details }); }

/** @param {number} deadline @param {number} requestTimeoutMs */
function requiredCleanupTimeout(deadline, requestTimeoutMs) { const remainingMs = deadline - Date.now(); if (remainingMs <= 0) throw ownerReleaseIncomplete({ releaseProofMissingProfileCount: 1 }); return Math.min(requestTimeoutMs, remainingMs); }
/** @param {number} deadline @param {number} requestTimeoutMs */
function boundedCleanupTimeout(deadline, requestTimeoutMs) { return Math.max(1, Math.min(requestTimeoutMs, deadline - Date.now())); }
/** @param {number} deadline */
function remainingCleanupTimeout(deadline) { return Math.max(0, deadline - Date.now()); }
/** @param {string} dataRoot @param {string} workspace @param {string} identityName */
function expectedBrokerEndpoint(dataRoot, workspace, identityName) { const profile = identityName === 'identity.json' ? null : identityName.slice('identity-'.length, -'.json'.length); return brokerEndpointFor({ dataRoot, workspace, ...(profile ? { identity: profile } : {}) }); }

/** @param {any} history */
function normalizeImportedHistory(history) {
  requireExactObject(history, ['messages'], ['title', 'createdAt', 'updatedAt']);
  if (!Array.isArray(history.messages) || history.messages.length === 0) throw inputError();
  const messages = history.messages.map((/** @type {any} */ message) => {
    requireExactObject(message, ['role', 'content'], ['timestamp']);
    if (!['user', 'assistant'].includes(message.role) || typeof message.content !== 'string'
      || message.timestamp !== undefined && (!Number.isSafeInteger(message.timestamp) || message.timestamp < 0)) throw inputError();
    return message.timestamp === undefined ? { role: message.role, content: message.content } : { role: message.role, content: message.content, timestamp: message.timestamp };
  });
  for (const key of ['title']) if (history[key] !== undefined && typeof history[key] !== 'string') throw inputError();
  for (const key of ['createdAt', 'updatedAt']) if (history[key] !== undefined && (!Number.isSafeInteger(history[key]) || history[key] < 0)) throw inputError();
  return { source: IMPORTED_HISTORY_SOURCE, ...(history.title === undefined ? {} : { title: history.title }), ...(history.createdAt === undefined ? {} : { createdAt: history.createdAt }), ...(history.updatedAt === undefined ? {} : { updatedAt: history.updatedAt }), messages };
}

/** @param {unknown} value @param {number} maximum */
function boundedWireOption(value, maximum) { return value === undefined || typeof value === 'number' && Number.isSafeInteger(value) && value >= 128 && value <= maximum; }
/** @param {unknown} value */
function boundedIdleTimeoutOption(value) { return value === undefined || typeof value === 'number' && Number.isSafeInteger(value) && value >= MIN_BROKER_IDLE_TIMEOUT_MS && value <= MAX_BROKER_IDLE_TIMEOUT_MS; }
/** @param {unknown} value */
function boundedDrainOption(value) { return value === undefined || typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= MAX_DRAIN_TIMEOUT_MS; }
/** @param {unknown} value */
function boundedRequestOption(value) { return value === undefined || typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= 3_600_000; }

/** @param {any} model */
function validateModel(model) { requireExactObject(model, ['providerId', 'modelId'], ['variant']); requireString(model.providerId); requireString(model.modelId); if (model.variant !== undefined) requireString(model.variant); }
/** @param {any} model */
function copyModel(model) { return { providerId: model.providerId, modelId: model.modelId, ...(model.variant === undefined ? {} : { variant: model.variant }) }; }
/** @param {any} model @returns {string[]} */
function advertisedThoughtLevels(model) {
  const values = Array.isArray(model.thoughtLevels) ? model.thoughtLevels : Array.isArray(model.reasoning?.levels) ? model.reasoning.levels.map((/** @type {any} */ entry) => entry?.value) : [];
  if (!values.every(nonEmpty)) throw inputError(); return values;
}
/** @param {any} left @param {any} right */
function sameModel(left, right) { return left?.providerId === right?.providerId && left?.modelId === right?.modelId && (left?.variant ?? '') === (right?.variant ?? ''); }
/** @param {unknown} value */
function exactModel(value) { return plainObject(value) && Object.keys(value).every((key) => ['providerId', 'modelId', 'variant'].includes(key)) && Object.hasOwn(value, 'providerId') && Object.hasOwn(value, 'modelId'); }
/** @param {unknown} value */
function requireString(value) { if (!nonEmpty(value)) throw inputError(); }
/** @param {unknown} value */
function requireSessionId(value) { if (!isSafeIdentifier(value)) throw inputError(); }
/** @param {unknown} value @param {string[]} required @param {string[]} optional */
function requireExactObject(value, required, optional) { if (!plainObject(value) || required.some((key) => !(key in value)) || Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))) throw inputError(); }
/** @param {unknown} value @returns {value is Record<string,any>} */
function plainObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
/** @param {unknown} value @returns {value is string} */
function nonEmpty(value) { return typeof value === 'string' && value.length > 0; }
/** @param {Record<string,any>} value @param {string[]} keys */
function exactObjectKeys(value, keys) { const actual = Object.keys(value); return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key)); }
function inputError() { return new PluginError('ZCODE_INPUT_INVALID', 'ZCode client input is invalid.', { category: 'validation', remedy: 'Provide only documented fields with valid runtime types.' }); }
/** @param {unknown} value @param {string} method */
function requireObjectResult(value, method) { if (!plainObject(value)) throw outputError(method); return value; }
/** @param {any} value @param {string} sessionId @param {string} workspace @param {string} method */
function validateSnapshot(value, sessionId, workspace, method) { if (!snapshotValid(value, sessionId, workspace)) throw outputError(method); }
/** @param {string} method */
function outputError(method) { return new PluginError('ZCODE_OUTPUT_INVALID', `ZCode returned an invalid ${method} result.`, { category: 'protocol', remedy: 'Upgrade or restart ZCode and retry.', details: { method } }); }
