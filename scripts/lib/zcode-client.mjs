import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';

import { PluginError } from './errors.mjs';
import { isSafeIdentifier } from './identifier.mjs';
import { connectZCodeBroker, spawnZCodeProtocol } from './zcode-protocol.mjs';
import { validSessionInfo, validSnapshot as snapshotValid } from './zcode-schema.mjs';
import { ensureZCodeBroker, readHealthyBrokerIdentity } from '../zcode-broker.mjs';
import { resolveWorkspaceStorage } from './workspace.mjs';

const THOUGHT_LEVELS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);
export const IMPORTED_HISTORY_SOURCE = 'claudeCode';

export class ZCodeClient {
  /** @param {import('./zcode-protocol.mjs').ZCodeProtocolClient} protocol */
  constructor(protocol) { this.protocol = protocol; this.sessionCatalogs = new Map(); }

  /** @param {{workspace:string,sessionId?:string,model?:{providerId:string,modelId:string,variant?:string},importedHistory?:{title?:string,createdAt?:number,updatedAt?:number,messages:Array<{role:'user'|'assistant',content:string,timestamp?:number}>}}} input */
  async createSession(input) {
    requireExactObject(input, ['workspace'], ['sessionId', 'model', 'importedHistory']);
    requireString(input.workspace);
    if (input.sessionId !== undefined) requireSessionId(input.sessionId);
    if (input.model !== undefined) validateModel(input.model);
    const workspacePath = resolve(input.workspace);
    /** @type {any} */
    const params = { workspace: { workspacePath, workspaceKey: workspacePath } };
    if (input.sessionId !== undefined) params.sessionId = input.sessionId;
    if (input.model !== undefined) params.model = copyModel(input.model);
    if (input.importedHistory !== undefined) params.importedHistory = normalizeImportedHistory(input.importedHistory);
    const result = await this.protocol.request('session/create', params);
    if (!plainObject(result) || !plainObject(result.session) || !isSafeIdentifier(result.session.sessionId) || input.sessionId && result.session.sessionId !== input.sessionId) throw outputError('session/create');
    validateSnapshot(result, result.session.sessionId, 'session/create');
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

  /** @param {string} sessionId */ async readSession(sessionId) { requireSessionId(sessionId); const result = await this.protocol.request('session/read', { sessionId }); validateSnapshot(result, sessionId, 'session/read'); this.sessionCatalogs.set(sessionId, result.settings.model); return result; }
  /** @param {string} sessionId */ async resumeSession(sessionId) { requireSessionId(sessionId); const result = await this.protocol.request('session/resume', { sessionId }); validateSnapshot(result, sessionId, 'session/resume'); this.sessionCatalogs.set(sessionId, result.settings.model); return result; }
  async listSessions() { const result = requireObjectResult(await this.protocol.request('session/list', {}), 'session/list'); if (!Array.isArray(result.sessions) || !result.sessions.every(validSessionInfo)) throw outputError('session/list'); return result; }
  /** @param {string} sessionId */ async stopSession(sessionId) { requireSessionId(sessionId); const result = await this.protocol.request('session/stop', { sessionId }); if (!plainObject(result)) throw outputError('session/stop'); this.protocol.cancelTurn(sessionId); return result; }
  async releaseOwner() { const result = await this.protocol.request('broker/releaseOwner', {}); if (!plainObject(result) || !Array.isArray(result.releasedSessionIds) || !Array.isArray(result.failedSessionIds) || !result.releasedSessionIds.every((sessionId) => isSafeIdentifier(sessionId)) || !result.failedSessionIds.every((sessionId) => isSafeIdentifier(sessionId)) || !Number.isSafeInteger(result.deferredSessionCount) || result.deferredSessionCount < 0) throw outputError('broker/releaseOwner'); return result; }

  /** @param {string} sessionId @param {{providerId:string,modelId:string,variant?:string}} model */
  async setModel(sessionId, model) {
    requireSessionId(sessionId); validateModel(model);
    const result = await this.protocol.request('session/setModel', { sessionId, model: copyModel(model), persistAsWorkspaceLastUsed: false });
    validateSnapshot(result, sessionId, 'session/setModel'); this.sessionCatalogs.set(sessionId, result.settings.model); return result;
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
    validateSnapshot(result, sessionId, 'session/setThoughtLevel'); this.sessionCatalogs.set(sessionId, result.settings.model); return result;
  }

  /** @param {string} sessionId @param {number} [timeoutMs] */ waitForCompletion(sessionId, timeoutMs) { return this.protocol.waitForCompletion(sessionId, timeoutMs); }
  /** @param {(message:any)=>void} handler */ subscribe(handler) { return this.protocol.subscribe(handler); }
  /** @param {(request:any,signal:AbortSignal)=>Promise<any>|any} handler */ setPermissionHandler(handler) { this.protocol.setPermissionHandler(handler); }
  close() { return this.protocol.close(); }
}

/** @param {{workspace:string,launch?:{command:string,args:string[],target?:string},brokerEndpoint?:string,brokerToken?:string,ownerId?:string,env?:NodeJS.ProcessEnv,requestTimeoutMs?:number,completionTimeoutMs?:number,maxFrameBytes?:number,maxOutboundBytes?:number}} options */
export async function createZCodeClient(options) {
  if (!plainObject(options) || !nonEmpty(options.workspace)
    || (options.brokerEndpoint === undefined) === (options.launch === undefined)
    || options.brokerEndpoint !== undefined && (!nonEmpty(options.brokerEndpoint) || !nonEmpty(options.brokerToken) || options.brokerToken.length < 32 || !nonEmpty(options.ownerId) || options.ownerId.length < 16)
    || options.launch !== undefined && !plainObject(options.launch)) throw inputError();
  const protocolOptions = {
    cwd: options.workspace, env: options.env, requestTimeoutMs: options.requestTimeoutMs,
    completionTimeoutMs: options.completionTimeoutMs, maxFrameBytes: options.maxFrameBytes, maxOutboundBytes: options.maxOutboundBytes,
  };
  const protocol = options.brokerEndpoint
    ? await connectZCodeBroker(options.brokerEndpoint, { ...protocolOptions, brokerToken: /** @type {string} */ (options.brokerToken), ownerId: /** @type {string} */ (options.ownerId) })
    : await spawnZCodeProtocol(/** @type {{command:string,args:string[],target?:string}} */ (options.launch), protocolOptions);
  return new ZCodeClient(protocol);
}

/** @param {{dataRoot:string,workspace:string,launch:{command:string,args:string[],target?:string},ownerId:string,env?:NodeJS.ProcessEnv,requestTimeoutMs?:number,completionTimeoutMs?:number,maxFrameBytes?:number,maxOutboundBytes?:number}} options */
export async function createManagedZCodeClient(options) {
  if (!plainObject(options) || !nonEmpty(options.dataRoot) || !nonEmpty(options.workspace) || !plainObject(options.launch) || !nonEmpty(options.ownerId) || options.ownerId.length < 16
    || !boundedWireOption(options.maxFrameBytes, 16 * 1024 * 1024) || !boundedWireOption(options.maxOutboundBytes, 64 * 1024 * 1024)) throw inputError();
  const identity = await ensureZCodeBroker(options);
  return createZCodeClient({ workspace: options.workspace, brokerEndpoint: identity.endpoint, brokerToken: identity.brokerToken, ownerId: options.ownerId, requestTimeoutMs: options.requestTimeoutMs, completionTimeoutMs: options.completionTimeoutMs, maxFrameBytes: options.maxFrameBytes, maxOutboundBytes: options.maxOutboundBytes });
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
  const identities = await Promise.all(names.filter((name) => /^identity(?:-[a-f0-9]{16})?\.json$/.test(name)).slice(0, 32).map((name) => readHealthyBrokerIdentity(resolve(brokerDirectory, name))));
  /** @type {string[]} */
  const released = [];
  /** @type {string[]} */
  const failed = [];
  let deferredSessionCount = 0;
  await Promise.all(identities.filter(Boolean).map(async (identity) => {
    let client;
    try { client = await createZCodeClient({ workspace: storage.workspacePath, brokerEndpoint: identity.endpoint, brokerToken: identity.brokerToken, ownerId: options.ownerId, requestTimeoutMs: options.requestTimeoutMs ?? 750 }); const result = await client.releaseOwner(); released.push(...result.releasedSessionIds); failed.push(...result.failedSessionIds); deferredSessionCount += result.deferredSessionCount; }
    catch { /* SessionEnd cleanup is advisory and continues across profiles. */ }
    finally { await client?.close().catch(() => {}); }
  }));
  return { releasedSessionIds: released.slice(0, 1_000), failedSessionIds: failed.slice(0, 1_000), deferredSessionCount };
}

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
/** @param {any} value @param {string} sessionId @param {string} method */
function validateSnapshot(value, sessionId, method) { if (!snapshotValid(value, sessionId)) throw outputError(method); }
/** @param {string} method */
function outputError(method) { return new PluginError('ZCODE_OUTPUT_INVALID', `ZCode returned an invalid ${method} result.`, { category: 'protocol', remedy: 'Upgrade or restart ZCode and retry.', details: { method } }); }
