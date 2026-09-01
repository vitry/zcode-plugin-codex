import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readdir, realpath } from 'node:fs/promises';

import { PluginError } from './errors.mjs';
import { isBoundedPublicIdentifier, isSafeIdentifier } from './identifier.mjs';
import { closeProtocolUntil, connectZCodeBroker, DEFAULT_MAX_FRAME_BYTES, MAX_DRAIN_TIMEOUT_MS, spawnZCodeProtocol } from './zcode-protocol.mjs';
import { validCreateSnapshot, validSessionInfo, validSettingsSnapshot, validSetupAuthProbeSnapshot, validSnapshot as snapshotValid } from './zcode-schema.mjs';
import { brokerEndpointFor, brokerIdentityNameForWireOptions, ensureZCodeBroker, inspectBrokerIdentity, MAX_BROKER_IDLE_TIMEOUT_MS, MIN_BROKER_IDLE_TIMEOUT_MS, prioritizeBrokerOwnership } from '../zcode-broker.mjs';
import { resolveWorkspaceStorage } from './workspace.mjs';

const THOUGHT_LEVELS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);
const RUNTIME_PROVIDER_KINDS = new Set(['anthropic', 'openai', 'openai-compatible']);
const RUNTIME_API_FORMATS = new Set(['anthropic-messages', 'openai-chat-completions', 'openai-responses']);
const RUNTIME_CREDENTIAL_FIELDS = new Map([['credential', 'key'], ['env', 'name'], ['server-config', 'key'], ['inline', 'value']]);
const RUNTIME_PROVIDER_SOURCES = new Set(['builtin', 'models-dev', 'custom', 'user', 'workspace', 'ephemeral']);
const RUNTIME_MAX_TEXT_BYTES = 4_096;
const RUNTIME_MAX_ENTRIES = 256;
const RUNTIME_MAX_REASONING_LEVELS = 32;
const RUNTIME_MAX_VALUE_DEPTH = 8;
const RUNTIME_MAX_VALUE_NODES = 2_048;
const RUNTIME_MAX_WIRE_BYTES = Math.floor(DEFAULT_MAX_FRAME_BYTES / 2);
const RUNTIME_MAX_WIRE_NODES = 65_536;
const RUNTIME_MAX_WIRE_DEPTH = 16;
const RUNTIME_DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const OWNER_CLEANUP_BUDGET_MS = 1_800;
const OWNER_CLEANUP_MAX_BATCHES = 32;
const OWNER_CLEANUP_LEGACY_ACTIVE_MAX = 64;
const OWNER_CLEANUP_LEGACY_BATCH_SIZE = 8;
export const IMPORTED_HISTORY_SOURCE = 'claudeCode';

export class ZCodeClient {
  /** @param {import('./zcode-protocol.mjs').ZCodeProtocolClient} protocol @param {string} [workspace] @param {boolean} [workspaceBound] */
  constructor(protocol, workspace, workspaceBound = false) { this.protocol = protocol; this.defaultWorkspace = workspace === undefined ? null : resolve(workspace); this.workspaceBound = workspaceBound; this.sessionCatalogs = new Map(); this.sessionWorkspaces = new Map(); this.initialEmptySessions = new Set(); }

  /** @param {{workspace:string,sessionId?:string,model?:{providerId:string,modelId:string,variant?:string},importedHistory?:{title?:string,createdAt?:number,updatedAt?:number,messages:Array<{role:'user'|'assistant',content:string,timestamp?:number}>}}} input */
  async createSession(input) {
    return this.createSessionValidated(input, validCreateSnapshot);
  }

  /** @param {{workspace:string,sessionId?:string,model?:{providerId:string,modelId:string,variant?:string},importedHistory?:{title?:string,createdAt?:number,updatedAt?:number,messages:Array<{role:'user'|'assistant',content:string,timestamp?:number}>}}} input Setup-only compatibility probe; formal runtime callers must use createSession(). */
  async createSessionForSetupAuthProbe(input) {
    return this.createSessionValidated(input, validSetupAuthProbeSnapshot);
  }

  /** @param {{workspace:string,sessionId?:string,model?:{providerId:string,modelId:string,variant?:string},importedHistory?:{title?:string,createdAt?:number,updatedAt?:number,messages:Array<{role:'user'|'assistant',content:string,timestamp?:number}>}}} input @param {(value:any,sessionId:string,workspace:string)=>boolean} validator */
  async createSessionValidated(input, validator) {
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
    if (!validator(result, result.session.sessionId, workspacePath)) throw outputError('session/create');
    this.sessionWorkspaces.set(result.session.sessionId, workspacePath);
    if (snapshotValid(result, result.session.sessionId, workspacePath)) this.initialEmptySessions.delete(result.session.sessionId);
    else this.initialEmptySessions.add(result.session.sessionId);
    if (plainObject(result.settings?.model) && Array.isArray(result.settings.model.available)) this.sessionCatalogs.set(result.session.sessionId, result.settings.model);
    return result;
  }

  /** @param {string} sessionId @param {string} content @param {Record<string,never>} [options] */
  async send(sessionId, content, options = {}) {
    requireSessionId(sessionId); if (typeof content !== 'string') throw inputError(); requireExactObject(options, [], []);
    this.initialEmptySessions.delete(sessionId);
    this.protocol.beginTurn(sessionId);
    const inputId = randomUUID();
    let result;
    try { result = await this.protocol.request('session/send', { sessionId, inputId, queryId: inputId, content }); } catch (error) { this.protocol.abortTurn(sessionId); throw error; }
    if (!plainObject(result) || result.accepted !== true || result.sessionId !== sessionId || !Number.isSafeInteger(result.stateRevision) || result.stateRevision < 0 || result.modelRuntimeRevision !== undefined && !nonEmpty(result.modelRuntimeRevision)) { this.protocol.abortTurn(sessionId); throw outputError('session/send'); }
    this.protocol.armTurn(sessionId, result.stateRevision, inputId);
    return { ...result, inputId };
  }

  /** @param {string} sessionId */ async readSession(sessionId) { requireSessionId(sessionId); const result = await this.protocol.request('session/read', { sessionId }); validateSnapshot(result, sessionId, this.expectedWorkspace(sessionId), 'session/read'); this.sessionCatalogs.set(sessionId, result.settings.model); return result; }
  /** @param {string} sessionId */ async resumeSession(sessionId) { requireSessionId(sessionId); this.initialEmptySessions.delete(sessionId); const result = await this.protocol.request('session/resume', { sessionId }); validateSnapshot(result, sessionId, this.expectedWorkspace(sessionId), 'session/resume'); this.sessionCatalogs.set(sessionId, result.settings.model); this.sessionWorkspaces.set(sessionId, result.session.workspace.workspacePath); return result; }
  /** @param {number} [timeoutMs] */ async listSessions(timeoutMs) { const result = requireObjectResult(await this.protocol.request('session/list', {}, timeoutMs), 'session/list'); if (!Array.isArray(result.sessions) || !result.sessions.every(validSessionInfo)) throw outputError('session/list'); return result; }
  /** @param {string} sessionId @param {number} [timeoutMs] */ async stopSession(sessionId, timeoutMs) { requireSessionId(sessionId); this.initialEmptySessions.delete(sessionId); const result = await this.protocol.request('session/stop', { sessionId }, timeoutMs); if (!boundedUpstreamObject(result)) throw outputError('session/stop'); if (!this.protocol.acceptBrokerControl) this.protocol.cancelTurn(sessionId); return {}; }
  /** @param {number} [timeoutMs] */ async brokerCapabilities(timeoutMs) { const result = await requestBrokerHealth(this, timeoutMs); return { releaseOwnerExclusions: result.capabilities?.releaseOwnerExclusions === true }; }
  /** @param {string[]} [excludeSessionIds] @param {number} [timeoutMs] */
  async releaseOwner(excludeSessionIds, timeoutMs) { if (excludeSessionIds !== undefined && (!Array.isArray(excludeSessionIds) || excludeSessionIds.length > 1_000 || new Set(excludeSessionIds).size !== excludeSessionIds.length || !excludeSessionIds.every((sessionId) => isSafeIdentifier(sessionId)))) throw inputError(); const result = await this.protocol.request('broker/releaseOwner', excludeSessionIds === undefined ? {} : { excludeSessionIds }, timeoutMs); if (!plainObject(result) || !Array.isArray(result.releasedSessionIds) || !Array.isArray(result.failedSessionIds) || !result.releasedSessionIds.every((sessionId) => isSafeIdentifier(sessionId)) || !result.failedSessionIds.every((sessionId) => isSafeIdentifier(sessionId)) || !Number.isSafeInteger(result.deferredSessionCount) || result.deferredSessionCount < 0) throw outputError('broker/releaseOwner'); return result; }

  /** @param {string} sessionId @param {{providerId:string,modelId:string,variant?:string}} model */
  async setModel(sessionId, model) {
    requireSessionId(sessionId); validateModel(model);
    const result = await this.protocol.request('session/setModel', { sessionId, model: copyModel(model), persistAsWorkspaceLastUsed: false });
    validateSettingsResult(result, sessionId, this.expectedWorkspace(sessionId), 'session/setModel', this.initialEmptySessions.has(sessionId));
    if (!validAppliedModel(result.settings.model.current) || !sameModel(result.settings.model.current, model)) throw new PluginError('ZCODE_MODEL_APPLY_MISMATCH', 'ZCode did not apply the exact requested model.', { category: 'protocol', remedy: 'Retry with a model tuple advertised by ZCode.' });
    this.sessionCatalogs.set(sessionId, result.settings.model); return result;
  }

  /** @param {string} sessionId @param {any} runtimeModel */
  async updateRuntimeModelConfig(sessionId, runtimeModel) {
    requireSessionId(sessionId);
    const copiedRuntimeModel = copyRuntimeModel(runtimeModel);
    const result = await this.protocol.request('session/updateRuntimeModelConfig', { sessionId, runtimeModel: copiedRuntimeModel, applyModelSelection: true });
    if (!boundedUpstreamObject(result)
      || result.sessionId !== sessionId || result.appliedModelRuntimeRevision !== copiedRuntimeModel.revision
      || typeof result.changed !== 'boolean') throw outputError('session/updateRuntimeModelConfig');
    return { sessionId: result.sessionId, appliedModelRuntimeRevision: result.appliedModelRuntimeRevision, changed: result.changed };
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
    validateSettingsResult(result, sessionId, this.expectedWorkspace(sessionId), 'session/setThoughtLevel', this.initialEmptySessions.has(sessionId));
    if (typeof result.settings.thoughtLevel.current !== 'string' || result.settings.thoughtLevel.current.toLowerCase() !== actual.toLowerCase()) throw new PluginError('ZCODE_THOUGHT_LEVEL_APPLY_MISMATCH', 'ZCode did not apply the exact requested thought level.', { category: 'protocol', remedy: 'Retry with a thought level advertised by the selected model.' });
    this.sessionCatalogs.set(sessionId, result.settings.model); return result;
  }

  /** Wait for a validated terminal notification; no deadline applies unless configured on the client or supplied here. @param {string} sessionId @param {number} [timeoutMs] */ waitForCompletion(sessionId, timeoutMs) { return this.protocol.waitForCompletion(sessionId, timeoutMs); }
  /** Observe a validated terminal notification without consuming the active turn. @param {string} sessionId @param {number} [timeoutMs] */ observeCompletion(sessionId, timeoutMs) { return this.protocol.observeCompletion(sessionId, timeoutMs); }
  /** Locally release an active turn without sending an upstream request. @param {string} sessionId */ releaseTurn(sessionId) { requireSessionId(sessionId); this.protocol.releaseTurn(sessionId); }
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
    if (!boundedUpstreamObject(result) || !runtimePlainObject(ack)
      || !isBoundedPublicIdentifier(ack.subscriptionId) || !['snapshot', 'resume'].includes(ack.mode) || !isBoundedPublicIdentifier(ack.logEpoch)) throw outputError('v4/conversation/subscribe');
    let unsubscribed = false;
    return {
      subscriptionId: ack.subscriptionId,
      unsubscribe: async () => {
        if (unsubscribed) return;
        unsubscribed = true;
        const response = await this.protocol.request('v4/conversation/unsubscribe', { topic: `conversation/${sessionId}`, subscriptionId: ack.subscriptionId, connectionId: options.connectionId });
        if (!boundedUpstreamObject(response)) throw outputError('v4/conversation/unsubscribe');
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
    expectedEndpoint: expectedBrokerEndpoint(storage.dataRootPath, storage.workspacePath, identityName),
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
  const storage = await resolveWorkspaceStorage(options); const cleanupDeadline = Date.now() + (options.cleanupBudgetMs ?? OWNER_CLEANUP_BUDGET_MS); const requestTimeoutMs = options.requestTimeoutMs ?? 750;
  const discovery = await discoverOwnerReleaseProfiles(options, storage, cleanupDeadline, requestTimeoutMs);
  const { candidates, truncatedProfileCount } = discovery;
  const unavailableProfiles = candidates.filter((profile) => profile.unavailable); const unavailableProfileCount = unavailableProfiles.length; const identityStatusCounts = boundedIdentityStatusCounts(unavailableProfiles.map((profile) => profile.status)); const identityReasonCounts = boundedIdentityReasonCounts(unavailableProfiles.map((profile) => profile.reason)); const profiles = candidates.filter((profile) => profile.identity);
  const outcomes = await Promise.all(profiles.map(async ({ identityName, client, capabilities }) => {
    const verifiedClient = /** @type {ZCodeClient} */ (client); const verifiedCapabilities = /** @type {{releaseOwnerExclusions:boolean}} */ (capabilities);
    /** @type {Set<string>} */ const released = new Set(); /** @type {Set<string>} */ const failed = new Set();
    let profileDeferred = 0; let profileError = null; let releaseProof = false;
    try {
      const deadline = cleanupDeadline; const attempted = new Set();
      let legacyFallback = false;
      for (let batch = 0; batch < OWNER_CLEANUP_MAX_BATCHES && Date.now() < deadline; batch += 1) {
        const result = await releaseOwnerWithRetry(verifiedClient, verifiedCapabilities.releaseOwnerExclusions ? [...attempted] : undefined, deadline, requestTimeoutMs); releaseProof = true; profileDeferred = result.deferredSessionCount;
        for (const sessionId of result.releasedSessionIds) { attempted.add(sessionId); released.add(sessionId); failed.delete(sessionId); }
        for (const sessionId of result.failedSessionIds) { attempted.add(sessionId); if (!released.has(sessionId)) failed.add(sessionId); }
        if (!profileDeferred || result.releasedSessionIds.length + result.failedSessionIds.length === 0) break;
        if (!verifiedCapabilities.releaseOwnerExclusions && (result.failedSessionIds.length || !result.releasedSessionIds.length)) { legacyFallback = true; break; }
      }
      if (!verifiedCapabilities.releaseOwnerExclusions && legacyFallback && profileDeferred > 0 && Date.now() < deadline) {
        const listed = await verifiedClient.listSessions(boundedCleanupTimeout(deadline, requestTimeoutMs)); const candidates = listed.sessions.map((/** @type {any} */ session) => session.sessionId).filter((/** @type {string} */ sessionId) => !attempted.has(sessionId)).slice(0, OWNER_CLEANUP_LEGACY_ACTIVE_MAX);
        for (let offset = 0; offset < candidates.length && Date.now() < deadline; offset += OWNER_CLEANUP_LEGACY_BATCH_SIZE) {
          const batch = candidates.slice(offset, offset + OWNER_CLEANUP_LEGACY_BATCH_SIZE); const prioritized = await prioritizeBrokerOwnership({ dataRoot: options.dataRoot, workspace: storage.workspacePath, identityName, ownerId: options.ownerId, sessionIds: batch, lockTimeoutMs: remainingCleanupTimeout(deadline) }); if (!prioritized.prioritizedSessionIds.length) continue;
          const result = await releaseOwnerWithRetry(verifiedClient, undefined, deadline, requestTimeoutMs); releaseProof = true; profileDeferred = result.deferredSessionCount; for (const sessionId of result.releasedSessionIds) { attempted.add(sessionId); released.add(sessionId); failed.delete(sessionId); } for (const sessionId of result.failedSessionIds) { attempted.add(sessionId); if (!released.has(sessionId)) failed.add(sessionId); }
        }
      }
      if (!releaseProof) throw ownerReleaseIncomplete({ releaseProofMissingProfileCount: 1 });
    }
    catch (error) { profileError = error; }
    finally { await closeProtocolUntil(verifiedClient, cleanupDeadline); }
    return { releasedSessionIds: [...released], failedSessionIds: [...failed], deferredSessionCount: profileDeferred, releaseProof, error: profileError };
  }));
  const released = outcomes.flatMap((outcome) => outcome.releasedSessionIds); const failed = outcomes.flatMap((outcome) => outcome.failedSessionIds); const deferredSessionCount = outcomes.reduce((total, outcome) => total + outcome.deferredSessionCount, 0);
  const errorOutcomes = outcomes.filter((outcome) => outcome.error); const releaseProofMissingProfileCount = outcomes.filter((outcome) => !outcome.releaseProof).length; const proofOnlyFailureCount = outcomes.filter((outcome) => !outcome.releaseProof && !outcome.error).length; const causeCodeCounts = boundedCauseCodeCounts(errorOutcomes.map((outcome) => outcome.error)); const resultTruncated = released.length > 1_000 || failed.length > 1_000; const failedProfileCount = unavailableProfileCount + errorOutcomes.length + proofOnlyFailureCount + truncatedProfileCount; if (failedProfileCount || resultTruncated) throw ownerReleaseIncomplete({ failedProfileCount, completedProfileCount: outcomes.length - errorOutcomes.length - proofOnlyFailureCount, releasedSessionCount: released.length, failedSessionCount: failed.length, deferredSessionCount, releaseProofMissingProfileCount, truncatedProfileCount, resultTruncated, identityStatusCounts, identityReasonCounts, causeCodeCounts });
  return { releasedSessionIds: released.slice(0, 1_000), failedSessionIds: failed.slice(0, 1_000), deferredSessionCount };
}

/** @param {any} options @param {any} storage @param {number} cleanupDeadline @param {number} requestTimeoutMs */
async function discoverOwnerReleaseProfiles(options, storage, cleanupDeadline, requestTimeoutMs) {
  const brokerDirectory = resolve(storage.directory, 'broker');
  /** @type {string[]} */
  let names = [];
  try { names = await readdir(brokerDirectory); } catch (error) { if ((/** @type {NodeJS.ErrnoException} */ (error))?.code === 'ENOENT') names = []; else throw error; }
  const matchingNames = names.filter((name) => /^identity(?:-[a-f0-9]{16})?\.json$/.test(name)).sort(); const selectedNames = matchingNames.slice(0, 32); const truncatedProfileCount = matchingNames.length - selectedNames.length;
  const candidates = await Promise.all(selectedNames.map(async (identityName) => {
    const identityPath = resolve(brokerDirectory, identityName); const expectedEndpoint = expectedBrokerEndpoint(storage.dataRootPath, storage.workspacePath, identityName); const inspected = await inspectBrokerIdentity(identityPath, { expectedEndpoint, healthProbe: async () => true });
    if (inspected.status !== 'healthy') return { identity: null, identityName, status: inspected.status, reason: inspected.reason, unavailable: true, client: null, capabilities: null };
    let client = null;
    try { client = await createZCodeClient({ workspace: storage.workspacePath, brokerEndpoint: inspected.record.endpoint, brokerToken: inspected.record.brokerToken, ownerId: options.ownerId, requestTimeoutMs: requiredCleanupTimeout(cleanupDeadline, requestTimeoutMs) }); const capabilities = await verifyBrokerIdentity(client, inspected.record, cleanupDeadline, requestTimeoutMs); return { identity: inspected.record, identityName, status: 'healthy', unavailable: false, client, capabilities }; }
    catch { await closeProtocolUntil(client, cleanupDeadline); return { identity: null, identityName, status: 'unhealthy', unavailable: true, client: null, capabilities: null }; }
  }));
  return { candidates, truncatedProfileCount };
}

/** @param {ZCodeClient} client @param {string[]|undefined} excludeSessionIds @param {number} deadline @param {number} requestTimeoutMs */
async function releaseOwnerWithRetry(client, excludeSessionIds, deadline, requestTimeoutMs) { let retryableError; while (Date.now() < deadline) { try { return await client.releaseOwner(excludeSessionIds, boundedCleanupTimeout(deadline, requestTimeoutMs)); } catch (error) { const code = (/** @type {{code?:string}} */ (error))?.code; if (code !== 'ZCODE_TURN_ACTIVE' && code !== 'ZCODE_OWNER_RELEASE_TIMEOUT') throw error; retryableError = error; const remainingMs = deadline - Date.now(); if (remainingMs <= 1) break; await new Promise((resolvePromise) => setTimeout(resolvePromise, Math.min(25, remainingMs - 1))); } } throw retryableError ?? ownerReleaseIncomplete({ failedProfileCount: 1 }); }

/** @param {ZCodeClient} client @param {{pid:number,instanceId:string}} identity @param {number} deadline @param {number} requestTimeoutMs */
async function verifyBrokerIdentity(client, identity, deadline, requestTimeoutMs) { const health = await requestBrokerHealth(client, boundedCleanupTimeout(deadline, requestTimeoutMs)); if (!Number.isSafeInteger(health.pid) || health.pid <= 1 || !isSafeIdentifier(health.instanceId) || health.pid !== identity.pid || health.instanceId !== identity.instanceId) throw outputError('broker/health'); return { releaseOwnerExclusions: health.capabilities?.releaseOwnerExclusions === true }; }

/** @param {ZCodeClient} client @param {number|undefined} timeoutMs */
async function requestBrokerHealth(client, timeoutMs) { const result = await client.protocol.request('broker/health', {}, timeoutMs); if (!plainObject(result) || result.ok !== true) throw outputError('broker/health'); return result; }

/** @param {unknown[]} errors */
function boundedCauseCodeCounts(errors) { const counts = /** @type {Record<string,number>} */ ({}); for (const error of errors.slice(0, 32)) { const candidate = (/** @type {{code?:unknown}} */ (error))?.code; const code = typeof candidate === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(candidate) ? candidate : 'UNKNOWN'; counts[code] = (counts[code] ?? 0) + 1; } return counts; }
/** @param {string[]} statuses */
function boundedIdentityStatusCounts(statuses) { const counts = /** @type {Record<string,number>} */ ({}); for (const status of statuses.slice(0, 32)) if (['missing', 'invalid', 'dead', 'unhealthy'].includes(status)) counts[status] = (counts[status] ?? 0) + 1; return counts; }
/** @param {unknown[]} reasons */
function boundedIdentityReasonCounts(reasons) { const counts = /** @type {Record<string,number>} */ ({}); for (const reason of reasons.slice(0, 32)) if (['read', 'schema', 'endpoint'].includes(/** @type {string} */ (reason))) counts[/** @type {string} */ (reason)] = (counts[/** @type {string} */ (reason)] ?? 0) + 1; return counts; }

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
/** @param {unknown} value */
function copyRuntimeModel(value) {
  validateRuntimeWireBudget(value);
  if (!runtimeExactObject(value, ['revision', 'generatedAt', 'model', 'provider'], ['thoughtLevel'])
    || !runtimeText(value.revision) || !Number.isSafeInteger(value.generatedAt) || value.generatedAt < 0) throw inputError();
  const model = copyRuntimeModelRef(value.model);
  const provider = copyRuntimeProvider(value.provider, { nodes: 0 });
  const selectedModel = provider.models.find((entry) => entry.modelId === model.modelId);
  if (provider.providerId !== model.providerId || selectedModel === undefined) throw inputError();
  const thoughtLevel = value.thoughtLevel;
  if (thoughtLevel !== undefined && (!runtimeText(thoughtLevel) || !selectedModel.reasoning?.levels.some((level) => level.value === thoughtLevel))) throw inputError();
  return { revision: value.revision, generatedAt: value.generatedAt, model, provider, ...(thoughtLevel === undefined ? {} : { thoughtLevel }) };
}
/** @param {unknown} value */
function copyRuntimeModelRef(value) {
  if (!runtimeExactObject(value, ['providerId', 'modelId'], ['variant']) || !runtimeText(value.providerId) || !runtimeText(value.modelId)
    || value.variant !== undefined && !runtimeText(value.variant)) throw inputError();
  return { providerId: value.providerId, modelId: value.modelId, ...(value.variant === undefined ? {} : { variant: value.variant }) };
}
/** @param {unknown} value @param {{nodes:number}} jsonState */
function copyRuntimeProvider(value, jsonState) {
  const optional = ['apiFormat', 'label', 'baseURL', 'apiKey', 'apiKeyRequired', 'headers', 'providerOptions', 'logoUrl', 'modelsDevProviderId'];
  if (!runtimeExactObject(value, ['providerId', 'kind', 'source', 'models'], optional)
    || !runtimeText(value.providerId) || !RUNTIME_PROVIDER_KINDS.has(value.kind) || !RUNTIME_PROVIDER_SOURCES.has(value.source)
    || value.apiFormat !== undefined && !RUNTIME_API_FORMATS.has(value.apiFormat)
    || !Array.isArray(value.models) || value.models.length < 1 || value.models.length > RUNTIME_MAX_ENTRIES) throw inputError();
  for (const key of ['label', 'baseURL', 'logoUrl', 'modelsDevProviderId']) if (value[key] !== undefined && !runtimeText(value[key])) throw inputError();
  if (value.apiKeyRequired !== undefined && typeof value.apiKeyRequired !== 'boolean') throw inputError();
  const apiKey = value.apiKey === undefined ? undefined : copyRuntimeCredential(value.apiKey);
  const headers = value.headers === undefined ? undefined : copyRuntimeStringRecord(value.headers);
  const providerOptions = value.providerOptions === undefined ? undefined : copyRuntimeJsonRecord(value.providerOptions, jsonState);
  const models = value.models.map((model) => copyRuntimeProviderModel(model, jsonState));
  if (new Set(models.map((model) => model.modelId)).size !== models.length) throw inputError();
  return {
    providerId: value.providerId, kind: value.kind, ...(value.apiFormat === undefined ? {} : { apiFormat: value.apiFormat }),
    ...(value.label === undefined ? {} : { label: value.label }), source: value.source,
    ...(value.baseURL === undefined ? {} : { baseURL: value.baseURL }), ...(apiKey === undefined ? {} : { apiKey }),
    ...(value.apiKeyRequired === undefined ? {} : { apiKeyRequired: value.apiKeyRequired }), ...(headers === undefined ? {} : { headers }),
    ...(providerOptions === undefined ? {} : { providerOptions }), ...(value.logoUrl === undefined ? {} : { logoUrl: value.logoUrl }),
    ...(value.modelsDevProviderId === undefined ? {} : { modelsDevProviderId: value.modelsDevProviderId }), models,
  };
}
/** @param {unknown} value */
function copyRuntimeCredential(value) {
  if (!runtimePlainObject(value) || !runtimeText(value.source)) throw inputError();
  const field = RUNTIME_CREDENTIAL_FIELDS.get(value.source);
  if (field === undefined || !runtimeExactObject(value, ['source', field], []) || !runtimeText(value[field])) throw inputError();
  return { source: value.source, [field]: value[field] };
}
/** @param {unknown} value @param {{nodes:number}} jsonState */
function copyRuntimeProviderModel(value, jsonState) {
  const optional = ['label', 'description', 'contextWindow', 'maxOutputTokens', 'reasoning', 'supportsImages', 'supportsPdf', 'supportsTools', 'supportsStructuredOutput', 'providerOptions', 'disabledReason'];
  if (!runtimeExactObject(value, ['modelId'], optional) || !runtimeText(value.modelId)) throw inputError();
  for (const key of ['label', 'description', 'disabledReason']) if (value[key] !== undefined && !runtimeText(value[key])) throw inputError();
  for (const key of ['contextWindow', 'maxOutputTokens']) if (value[key] !== undefined && (!Number.isSafeInteger(value[key]) || value[key] < 1)) throw inputError();
  for (const key of ['supportsImages', 'supportsPdf', 'supportsTools', 'supportsStructuredOutput']) if (value[key] !== undefined && typeof value[key] !== 'boolean') throw inputError();
  const reasoning = value.reasoning === undefined ? undefined : copyRuntimeReasoning(value.reasoning, jsonState);
  const providerOptions = value.providerOptions === undefined ? undefined : copyRuntimeJsonRecord(value.providerOptions, jsonState);
  return {
    modelId: value.modelId, ...(value.label === undefined ? {} : { label: value.label }), ...(value.description === undefined ? {} : { description: value.description }),
    ...(value.contextWindow === undefined ? {} : { contextWindow: value.contextWindow }), ...(value.maxOutputTokens === undefined ? {} : { maxOutputTokens: value.maxOutputTokens }),
    ...(reasoning === undefined ? {} : { reasoning }), ...(value.supportsImages === undefined ? {} : { supportsImages: value.supportsImages }),
    ...(value.supportsPdf === undefined ? {} : { supportsPdf: value.supportsPdf }), ...(value.supportsTools === undefined ? {} : { supportsTools: value.supportsTools }),
    ...(value.supportsStructuredOutput === undefined ? {} : { supportsStructuredOutput: value.supportsStructuredOutput }), ...(providerOptions === undefined ? {} : { providerOptions }),
    ...(value.disabledReason === undefined ? {} : { disabledReason: value.disabledReason }),
  };
}
/** @param {unknown} value @param {{nodes:number}} jsonState */
function copyRuntimeReasoning(value, jsonState) {
  if (!runtimeExactObject(value, ['enabled', 'levels'], ['defaultLevel', 'providerOptionsByLevel']) || typeof value.enabled !== 'boolean'
    || !Array.isArray(value.levels) || value.levels.length > RUNTIME_MAX_REASONING_LEVELS) throw inputError();
  const levels = value.levels.map((level) => {
    if (!runtimeExactObject(level, ['value', 'label'], []) || !runtimeText(level.value) || !runtimeText(level.label)) throw inputError();
    return { value: level.value, label: level.label };
  });
  const levelValues = new Set(levels.map((level) => level.value));
  if (value.defaultLevel !== undefined && (!runtimeText(value.defaultLevel) || !levelValues.has(value.defaultLevel))) throw inputError();
  let providerOptionsByLevel;
  if (value.providerOptionsByLevel !== undefined) {
    if (!runtimePlainObject(value.providerOptionsByLevel) || Object.keys(value.providerOptionsByLevel).length > RUNTIME_MAX_REASONING_LEVELS) throw inputError();
    providerOptionsByLevel = Object.fromEntries(Object.entries(value.providerOptionsByLevel).map(([level, options]) => {
      if (!runtimeSafeKey(level) || !levelValues.has(level)) throw inputError(); return [level, copyRuntimeJsonRecord(options, jsonState)];
    }));
  }
  return { enabled: value.enabled, levels, ...(value.defaultLevel === undefined ? {} : { defaultLevel: value.defaultLevel }), ...(providerOptionsByLevel === undefined ? {} : { providerOptionsByLevel }) };
}
/** @param {unknown} value */
function copyRuntimeStringRecord(value) {
  if (!runtimePlainObject(value) || Object.keys(value).length > RUNTIME_MAX_ENTRIES) throw inputError();
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => {
    if (!runtimeSafeKey(key) || !runtimeText(entry)) throw inputError(); return [key, entry];
  }));
}
/** @param {unknown} value @param {{nodes:number}} state */
function copyRuntimeJsonRecord(value, state) {
  if (!runtimePlainObject(value)) throw inputError();
  return copyRuntimeJsonValue(value, 0, state);
}
/** @param {unknown} value @param {number} depth @param {{nodes:number}} state @returns {any} */
function copyRuntimeJsonValue(value, depth, state) {
  state.nodes += 1;
  if (state.nodes > RUNTIME_MAX_VALUE_NODES || depth > RUNTIME_MAX_VALUE_DEPTH) throw inputError();
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') { if (!runtimeText(value)) throw inputError(); return value; }
  if (typeof value === 'number') { if (!Number.isFinite(value)) throw inputError(); return value; }
  if (Array.isArray(value)) { if (value.length > RUNTIME_MAX_ENTRIES) throw inputError(); return value.map((entry) => copyRuntimeJsonValue(entry, depth + 1, state)); }
  if (!runtimePlainObject(value) || Object.keys(value).length > RUNTIME_MAX_ENTRIES) throw inputError();
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => {
    if (!runtimeSafeKey(key)) throw inputError(); return [key, copyRuntimeJsonValue(entry, depth + 1, state)];
  }));
}
/** @param {unknown} value @param {string[]} required @param {string[]} optional @returns {value is Record<string,any>} */
function runtimeExactObject(value, required, optional) {
  return runtimePlainObject(value) && required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => runtimeSafeKey(key) && (required.includes(key) || optional.includes(key)));
}
/** @param {unknown} value @returns {value is Record<string,any>} */
function runtimePlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value); return prototype === Object.prototype || prototype === null;
}
/** @param {unknown} value @returns {value is Record<string,any>} */
function boundedUpstreamObject(value) {
  if (!runtimePlainObject(value)) return false;
  try {
    const encoded = JSON.stringify(value); if (typeof encoded !== 'string' || Buffer.byteLength(encoded) > DEFAULT_MAX_FRAME_BYTES) return false;
    const pending = [{ value, depth: 0 }]; const seen = new Set(); let nodes = 0;
    while (pending.length > 0) {
      const current = pending.pop(); if (!current || current.depth > 64 || ++nodes > 65_536) return false;
      const item = current.value;
      if (item === null || typeof item === 'string' || typeof item === 'boolean') continue;
      if (typeof item === 'number') { if (!Number.isFinite(item)) return false; continue; }
      if (typeof item !== 'object' || seen.has(item)) return false;
      if (!Array.isArray(item) && !runtimePlainObject(item)) return false;
      seen.add(item);
      for (const child of Array.isArray(item) ? item : Object.values(item)) pending.push({ value: child, depth: current.depth + 1 });
    }
    return true;
  } catch { return false; }
}
/** @param {unknown} value @returns {value is string} */
function runtimeText(value) {
  return typeof value === 'string' && value.trim().length > 0 && Buffer.byteLength(value) <= RUNTIME_MAX_TEXT_BYTES
    && ![...value].some((character) => { const code = character.codePointAt(0) ?? 0; return code <= 31 || code >= 127 && code <= 159; });
}
/** @param {string} value */
function runtimeSafeKey(value) { return runtimeText(value) && !RUNTIME_DANGEROUS_KEYS.has(value); }
/** @param {unknown} value */
function validateRuntimeWireBudget(value) {
  visitRuntimeWireValue(value, 0, { nodes: 0, bytes: 0, ancestors: new WeakSet() });
}
/** @param {unknown} value @param {number} depth @param {{nodes:number,bytes:number,ancestors:WeakSet<object>}} state */
function visitRuntimeWireValue(value, depth, state) {
  if (depth > RUNTIME_MAX_WIRE_DEPTH) throw inputError();
  if (value === null) { chargeRuntimeWire(state, 4); return; }
  if (typeof value === 'string') { chargeRuntimeWire(state, conservativeRuntimeWireTextBytes(value)); return; }
  if (typeof value === 'number') { chargeRuntimeWire(state, Number.isFinite(value) ? Buffer.byteLength(String(value)) : 4); return; }
  if (typeof value === 'boolean') { chargeRuntimeWire(state, value ? 4 : 5); return; }
  if (typeof value !== 'object') throw inputError();
  if (state.ancestors.has(value)) throw inputError();
  state.ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > RUNTIME_MAX_ENTRIES) throw inputError();
      chargeRuntimeWire(state, 2 + Math.max(0, value.length - 1));
      for (const entry of value) visitRuntimeWireValue(entry, depth + 1, state);
      return;
    }
    if (!runtimePlainObject(value)) throw inputError();
    const entries = Object.entries(value);
    if (entries.length > RUNTIME_MAX_ENTRIES) throw inputError();
    chargeRuntimeWire(state, 2 + Math.max(0, entries.length - 1));
    for (const [key, entry] of entries) {
      if (RUNTIME_DANGEROUS_KEYS.has(key)) throw inputError();
      chargeRuntimeWire(state, conservativeRuntimeWireTextBytes(key) + 1);
      visitRuntimeWireValue(entry, depth + 1, state);
    }
  } finally { state.ancestors.delete(value); }
}
/** @param {{nodes:number,bytes:number}} state @param {number} bytes */
function chargeRuntimeWire(state, bytes) {
  state.nodes += 1; state.bytes += bytes;
  if (state.nodes > RUNTIME_MAX_WIRE_NODES || state.bytes > RUNTIME_MAX_WIRE_BYTES) throw inputError();
}
/** @param {string} value */
function conservativeRuntimeWireTextBytes(value) {
  const bytes = Buffer.byteLength(value);
  if (bytes > RUNTIME_MAX_WIRE_BYTES) throw inputError();
  return 2 + bytes * 2;
}
/** @param {any} model @returns {string[]} */
function advertisedThoughtLevels(model) {
  const values = Array.isArray(model.thoughtLevels) ? model.thoughtLevels : Array.isArray(model.reasoning?.levels) ? model.reasoning.levels.map((/** @type {any} */ entry) => entry?.value) : [];
  if (!values.every(nonEmpty)) throw inputError(); return values;
}
/** @param {any} left @param {any} right */
function sameModel(left, right) { return left?.providerId === right?.providerId && left?.modelId === right?.modelId && (left?.variant ?? '') === (right?.variant ?? ''); }
/** @param {unknown} value */
function validAppliedModel(value) { return runtimePlainObject(value) && Object.hasOwn(value, 'providerId') && Object.hasOwn(value, 'modelId'); }
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
function inputError() { return new PluginError('ZCODE_INPUT_INVALID', 'ZCode client input is invalid.', { category: 'validation', remedy: 'Provide only documented fields with valid runtime types.' }); }
/** @param {unknown} value @param {string} method */
function requireObjectResult(value, method) { if (!plainObject(value)) throw outputError(method); return value; }
/** @param {any} value @param {string} sessionId @param {string} workspace @param {string} method */
function validateSnapshot(value, sessionId, workspace, method) { if (!snapshotValid(value, sessionId, workspace)) throw outputError(method); }
/** @param {any} value @param {string} sessionId @param {string} workspace @param {string} method @param {boolean} allowInitialEmpty */
function validateSettingsResult(value, sessionId, workspace, method, allowInitialEmpty) { if (!(allowInitialEmpty ? validSettingsSnapshot : snapshotValid)(value, sessionId, workspace)) throw outputError(method); }
/** @param {string} method */
function outputError(method) { return new PluginError('ZCODE_OUTPUT_INVALID', `ZCode returned an invalid ${method} result.`, { category: 'protocol', remedy: 'Upgrade or restart ZCode and retry.', details: { method } }); }
