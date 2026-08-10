import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readdir, realpath } from 'node:fs/promises';

import { PluginError } from './errors.mjs';
import { isBoundedPublicIdentifier, isSafeIdentifier } from './identifier.mjs';
import { connectZCodeBroker, MAX_DRAIN_TIMEOUT_MS, spawnZCodeProtocol } from './zcode-protocol.mjs';
import { validSessionInfo, validSnapshot as snapshotValid } from './zcode-schema.mjs';
import { brokerIdentityNameForWireOptions, ensureZCodeBroker, prioritizeBrokerOwnership, probeBrokerHealth, readHealthyBrokerIdentity } from '../zcode-broker.mjs';
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
  /** @param {string} sessionId @param {number} [timeoutMs] */ async stopSession(sessionId, timeoutMs) { requireSessionId(sessionId); const result = await this.protocol.request('session/stop', { sessionId }, timeoutMs); if (!plainObject(result)) throw outputError('session/stop'); this.protocol.cancelTurn(sessionId); return result; }
  /** @param {number} [timeoutMs] */ async brokerCapabilities(timeoutMs) { const result = await this.protocol.request('broker/health', {}, timeoutMs); if (!plainObject(result) || result.ok !== true) throw outputError('broker/health'); return { releaseOwnerExclusions: result.capabilities?.releaseOwnerExclusions === true }; }
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

/** @param {{dataRoot:string,workspace:string,launch:{command:string,args:string[],target?:string},ownerId:string,env?:NodeJS.ProcessEnv,requestTimeoutMs?:number,completionTimeoutMs?:number,maxFrameBytes?:number,maxOutboundBytes?:number,drainTimeoutMs?:number}} options */
export async function createManagedZCodeClient(options) {
  if (!plainObject(options) || !nonEmpty(options.dataRoot) || !nonEmpty(options.workspace) || !plainObject(options.launch) || !nonEmpty(options.ownerId) || options.ownerId.length < 16
    || !boundedWireOption(options.maxFrameBytes, 16 * 1024 * 1024) || !boundedWireOption(options.maxOutboundBytes, 64 * 1024 * 1024) || !boundedDrainOption(options.drainTimeoutMs)) throw inputError();
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
  const identity = await readHealthyBrokerIdentity(resolve(storage.directory, 'broker', identityName), {
    healthProbe: (record) => probeBrokerHealth(record, options.requestTimeoutMs),
  });
  if (!identity) return null;
  try {
    return await createZCodeClient({ workspace: storage.workspacePath, brokerEndpoint: identity.endpoint, brokerToken: identity.brokerToken, ownerId: options.ownerId, existingProtocolOnly: true, requestTimeoutMs: options.requestTimeoutMs, maxFrameBytes: options.maxFrameBytes, maxOutboundBytes: options.maxOutboundBytes, drainTimeoutMs: options.drainTimeoutMs });
  } catch { return null; }
}

/**
 * Releases an exact lifecycle owner from brokers that already exist. This
 * function never calls ensureZCodeBroker and therefore cannot start ZCode from
 * a SessionEnd hook.
 * @param {{dataRoot:string,workspace:string,ownerId:string,requestTimeoutMs?:number}} options
 */
export async function releaseManagedZCodeOwner(options) {
  if (!plainObject(options) || !nonEmpty(options.dataRoot) || !nonEmpty(options.workspace) || !nonEmpty(options.ownerId) || options.ownerId.length < 16) throw inputError();
  const storage = await resolveWorkspaceStorage(options); const brokerDirectory = resolve(storage.directory, 'broker'); let names;
  try { names = await readdir(brokerDirectory); } catch (error) { if ((/** @type {NodeJS.ErrnoException} */ (error))?.code === 'ENOENT') return { releasedSessionIds: [], failedSessionIds: [], deferredSessionCount: 0 }; throw error; }
  const profiles = (await Promise.all(names.filter((name) => /^identity(?:-[a-f0-9]{16})?\.json$/.test(name)).slice(0, 32).map(async (name) => ({ identity: await readHealthyBrokerIdentity(resolve(brokerDirectory, name)), identityName: name })))).filter((profile) => profile.identity);
  const outcomes = await Promise.all(profiles.map(async ({ identity, identityName }) => {
    /** @type {Set<string>} */ const released = new Set(); /** @type {Set<string>} */ const failed = new Set();
    /** @type {ZCodeClient|null} */ let client = null;
    let profileDeferred = 0;
    try {
      const requestTimeoutMs = options.requestTimeoutMs ?? 750; client = await createZCodeClient({ workspace: storage.workspacePath, brokerEndpoint: identity.endpoint, brokerToken: identity.brokerToken, ownerId: options.ownerId, requestTimeoutMs }); const attempted = new Set(); const deadline = Date.now() + OWNER_CLEANUP_BUDGET_MS; const capabilities = await client.brokerCapabilities(boundedCleanupTimeout(deadline, requestTimeoutMs));
      let legacyFallback = false;
      for (let batch = 0; batch < OWNER_CLEANUP_MAX_BATCHES && Date.now() < deadline; batch += 1) {
        const result = await client.releaseOwner(capabilities.releaseOwnerExclusions ? [...attempted] : undefined, boundedCleanupTimeout(deadline, requestTimeoutMs)); profileDeferred = result.deferredSessionCount;
        for (const sessionId of result.releasedSessionIds) { attempted.add(sessionId); released.add(sessionId); failed.delete(sessionId); }
        for (const sessionId of result.failedSessionIds) { attempted.add(sessionId); if (!released.has(sessionId)) failed.add(sessionId); }
        if (!profileDeferred || result.releasedSessionIds.length + result.failedSessionIds.length === 0) break;
        if (!capabilities.releaseOwnerExclusions && (result.failedSessionIds.length || !result.releasedSessionIds.length)) { legacyFallback = true; break; }
      }
      if (!capabilities.releaseOwnerExclusions && legacyFallback && profileDeferred > 0 && Date.now() < deadline) {
        const listed = await client.listSessions(boundedCleanupTimeout(deadline, requestTimeoutMs)); const candidates = listed.sessions.map((/** @type {any} */ session) => session.sessionId).filter((/** @type {string} */ sessionId) => !attempted.has(sessionId)).slice(0, OWNER_CLEANUP_LEGACY_ACTIVE_MAX);
        for (let offset = 0; offset < candidates.length && Date.now() < deadline; offset += OWNER_CLEANUP_LEGACY_BATCH_SIZE) {
          const batch = candidates.slice(offset, offset + OWNER_CLEANUP_LEGACY_BATCH_SIZE); const prioritized = await prioritizeBrokerOwnership({ dataRoot: options.dataRoot, workspace: storage.workspacePath, identityName, ownerId: options.ownerId, sessionIds: batch, lockTimeoutMs: remainingCleanupTimeout(deadline) }); if (!prioritized.prioritizedSessionIds.length) continue;
          const result = await client.releaseOwner(undefined, boundedCleanupTimeout(deadline, requestTimeoutMs)); profileDeferred = result.deferredSessionCount; for (const sessionId of result.releasedSessionIds) { attempted.add(sessionId); released.add(sessionId); failed.delete(sessionId); } for (const sessionId of result.failedSessionIds) { attempted.add(sessionId); if (!released.has(sessionId)) failed.add(sessionId); }
        }
      }
    }
    catch { /* SessionEnd cleanup is advisory and continues across profiles. */ }
    finally { await client?.close().catch(() => {}); }
    return { releasedSessionIds: [...released], failedSessionIds: [...failed], deferredSessionCount: profileDeferred };
  }));
  const released = outcomes.flatMap((outcome) => outcome.releasedSessionIds); const failed = outcomes.flatMap((outcome) => outcome.failedSessionIds); const deferredSessionCount = outcomes.reduce((total, outcome) => total + outcome.deferredSessionCount, 0);
  return { releasedSessionIds: released.slice(0, 1_000), failedSessionIds: failed.slice(0, 1_000), deferredSessionCount };
}

/** @param {number} deadline @param {number} requestTimeoutMs */
function boundedCleanupTimeout(deadline, requestTimeoutMs) { return Math.max(1, Math.min(requestTimeoutMs, deadline - Date.now())); }
/** @param {number} deadline */
function remainingCleanupTimeout(deadline) { return Math.max(0, deadline - Date.now()); }

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
