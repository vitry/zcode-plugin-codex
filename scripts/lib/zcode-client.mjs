import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import { PluginError } from './errors.mjs';
import { connectZCodeBroker, spawnZCodeProtocol } from './zcode-protocol.mjs';
import { ensureZCodeBroker } from '../zcode-broker.mjs';

const THOUGHT_LEVELS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);

export class ZCodeClient {
  /** @param {import('./zcode-protocol.mjs').ZCodeProtocolClient} protocol */
  constructor(protocol) { this.protocol = protocol; this.sessionCatalogs = new Map(); }

  /** @param {{workspace:string,sessionId?:string,model?:{providerId:string,modelId:string,variant?:string},importedHistory?:{title?:string,createdAt?:number,updatedAt?:number,messages:Array<{role:'user'|'assistant',content:string,timestamp?:number}>}}} input */
  async createSession(input) {
    requireExactObject(input, ['workspace'], ['sessionId', 'model', 'importedHistory']);
    requireString(input.workspace);
    if (input.sessionId !== undefined) requireString(input.sessionId);
    if (input.model !== undefined) validateModel(input.model);
    const workspacePath = resolve(input.workspace);
    /** @type {any} */
    const params = { workspace: { workspacePath, workspaceKey: workspacePath } };
    if (input.sessionId !== undefined) params.sessionId = input.sessionId;
    if (input.model !== undefined) params.model = copyModel(input.model);
    if (input.importedHistory !== undefined) params.importedHistory = normalizeImportedHistory(input.importedHistory);
    const result = await this.protocol.request('session/create', params);
    if (!plainObject(result) || !plainObject(result.session) || !nonEmpty(result.session.sessionId) || input.sessionId && result.session.sessionId !== input.sessionId) throw outputError('session/create');
    validateSnapshot(result, result.session.sessionId, 'session/create');
    if (plainObject(result.settings?.model) && Array.isArray(result.settings.model.available)) this.sessionCatalogs.set(result.session.sessionId, result.settings.model);
    return result;
  }

  /** @param {string} sessionId @param {string} content @param {Record<string,never>} [options] */
  async send(sessionId, content, options = {}) {
    requireString(sessionId); if (typeof content !== 'string') throw inputError(); requireExactObject(options, [], []);
    this.protocol.beginTurn(sessionId);
    const inputId = randomUUID();
    let result;
    try { result = await this.protocol.request('session/send', { sessionId, inputId, queryId: inputId, content }); } catch (error) { this.protocol.abortTurn(sessionId); throw error; }
    if (!plainObject(result) || Object.keys(result).some((key) => !['sessionId', 'accepted', 'stateRevision', 'modelRuntimeRevision'].includes(key)) || result.accepted !== true || result.sessionId !== sessionId || !Number.isSafeInteger(result.stateRevision) || result.stateRevision < 0 || result.modelRuntimeRevision !== undefined && !nonEmpty(result.modelRuntimeRevision)) { this.protocol.abortTurn(sessionId); throw outputError('session/send'); }
    this.protocol.armTurn(sessionId, result.stateRevision, inputId);
    return result;
  }

  /** @param {string} sessionId */ async readSession(sessionId) { requireString(sessionId); const result = await this.protocol.request('session/read', { sessionId }); validateSnapshot(result, sessionId, 'session/read'); this.sessionCatalogs.set(sessionId, result.settings.model); return result; }
  /** @param {string} sessionId */ async resumeSession(sessionId) { requireString(sessionId); const result = await this.protocol.request('session/resume', { sessionId }); validateSnapshot(result, sessionId, 'session/resume'); this.sessionCatalogs.set(sessionId, result.settings.model); return result; }
  async listSessions() { const result = requireObjectResult(await this.protocol.request('session/list', {}), 'session/list'); if (!exactKeys(result, ['sessions'], []) || !Array.isArray(result.sessions) || !result.sessions.every(validSessionInfo)) throw outputError('session/list'); return result; }
  /** @param {string} sessionId */ async stopSession(sessionId) { requireString(sessionId); const result = await this.protocol.request('session/stop', { sessionId }); if (!plainObject(result) || Object.keys(result).length !== 0) throw outputError('session/stop'); this.protocol.cancelTurn(sessionId); return result; }

  /** @param {string} sessionId @param {{providerId:string,modelId:string,variant?:string}} model */
  async setModel(sessionId, model) {
    requireString(sessionId); validateModel(model);
    const result = await this.protocol.request('session/setModel', { sessionId, model: copyModel(model), persistAsWorkspaceLastUsed: false });
    validateSnapshot(result, sessionId, 'session/setModel'); this.sessionCatalogs.set(sessionId, result.settings.model); return result;
  }

  /** @param {string} sessionId @param {string} thoughtLevel */
  async setThoughtLevel(sessionId, thoughtLevel) {
    requireString(sessionId);
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
  /** @param {(request:any)=>Promise<any>|any} handler */ setPermissionHandler(handler) { this.protocol.setPermissionHandler(handler); }
  close() { return this.protocol.close(); }
}

/** @param {{workspace:string,launch?:{command:string,args:string[],target?:string},brokerEndpoint?:string,brokerToken?:string,ownerId?:string,env?:NodeJS.ProcessEnv,requestTimeoutMs?:number,completionTimeoutMs?:number,maxFrameBytes?:number,maxOutboundBytes?:number}} options */
export async function createZCodeClient(options) {
  if (!plainObject(options) || !nonEmpty(options.workspace)
    || (options.brokerEndpoint === undefined) === (options.launch === undefined)
    || options.brokerEndpoint !== undefined && (!nonEmpty(options.brokerEndpoint) || !nonEmpty(options.brokerToken) || options.brokerToken.length < 32)
    || options.launch !== undefined && !plainObject(options.launch)) throw inputError();
  const protocolOptions = {
    cwd: options.workspace, env: options.env, requestTimeoutMs: options.requestTimeoutMs,
    completionTimeoutMs: options.completionTimeoutMs, maxFrameBytes: options.maxFrameBytes, maxOutboundBytes: options.maxOutboundBytes,
  };
  const protocol = options.brokerEndpoint
    ? await connectZCodeBroker(options.brokerEndpoint, { ...protocolOptions, brokerToken: /** @type {string} */ (options.brokerToken), ownerId: options.ownerId ?? randomUUID() })
    : await spawnZCodeProtocol(/** @type {{command:string,args:string[],target?:string}} */ (options.launch), protocolOptions);
  return new ZCodeClient(protocol);
}

/** @param {{dataRoot:string,workspace:string,launch:{command:string,args:string[],target?:string},ownerId?:string,env?:NodeJS.ProcessEnv,requestTimeoutMs?:number,completionTimeoutMs?:number,maxFrameBytes?:number}} options */
export async function createManagedZCodeClient(options) {
  if (!plainObject(options) || !nonEmpty(options.dataRoot) || !nonEmpty(options.workspace) || !plainObject(options.launch)) throw inputError();
  const identity = await ensureZCodeBroker(options);
  return createZCodeClient({ workspace: options.workspace, brokerEndpoint: identity.endpoint, brokerToken: identity.brokerToken, ownerId: options.ownerId ?? randomUUID(), requestTimeoutMs: options.requestTimeoutMs, completionTimeoutMs: options.completionTimeoutMs, maxFrameBytes: options.maxFrameBytes });
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
  return { source: 'claudeCode', ...(history.title === undefined ? {} : { title: history.title }), ...(history.createdAt === undefined ? {} : { createdAt: history.createdAt }), ...(history.updatedAt === undefined ? {} : { updatedAt: history.updatedAt }), messages };
}

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
function validateSnapshot(value, sessionId, method) { if (!exactKeys(value, ['protocol', 'session', 'settings', 'projection', 'runtime', 'messages'], []) || !validProtocol(value.protocol) || !validSessionInfo(value.session) || value.session.sessionId !== sessionId || !validSettings(value.settings) || !plainObject(value.projection) || !plainObject(value.runtime) || !Array.isArray(value.messages) || !value.messages.every(validMessage)) throw outputError(method); }
/** @param {unknown} value @param {string[]} required @param {string[]} optional */
function exactKeys(value, required, optional) { return plainObject(value) && required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => required.includes(key) || optional.includes(key)); }
/** @param {any} value */
function validProtocol(value) { return exactKeys(value, ['name', 'version'], []) && nonEmpty(value.name) && nonEmpty(value.version); }
/** @param {any} value */
function validWorkspace(value) { return exactKeys(value, ['workspacePath', 'workspaceKey'], ['workspaceIdentity', 'remoteSessionId']) && nonEmpty(value.workspacePath) && nonEmpty(value.workspaceKey) && ['workspaceIdentity', 'remoteSessionId'].every((key) => value[key] === undefined || nonEmpty(value[key])); }
/** @param {any} value */
function validSessionInfo(value) { return exactKeys(value, ['sessionId', 'workspace', 'sessionKind', 'title', 'mode', 'status', 'createdAt', 'updatedAt'], ['parentSessionId', 'traceId', 'titleSource', 'model', 'target', 'archivedAt']) && nonEmpty(value.sessionId) && validWorkspace(value.workspace) && ['main', 'subagent'].includes(value.sessionKind) && typeof value.title === 'string' && ['plan', 'build', 'edit', 'yolo', 'auto'].includes(value.mode) && ['idle', 'running', 'waiting', 'paused', 'completed', 'error'].includes(value.status) && ['createdAt', 'updatedAt'].every((key) => Number.isSafeInteger(value[key]) && value[key] >= 0) && (value.archivedAt === undefined || Number.isSafeInteger(value.archivedAt) && value.archivedAt >= 0); }
/** @param {any} value */
function validSettings(value) { return exactKeys(value, ['model', 'thoughtLevel', 'mode'], ['permission']) && validCatalog(value.model) && exactKeys(value.thoughtLevel, ['enabled', 'available'], ['current', 'defaultLevel']) && typeof value.thoughtLevel.enabled === 'boolean' && Array.isArray(value.thoughtLevel.available) && value.thoughtLevel.available.every(validThoughtLevel) && (value.thoughtLevel.current === undefined || nonEmpty(value.thoughtLevel.current)) && (value.thoughtLevel.defaultLevel === undefined || nonEmpty(value.thoughtLevel.defaultLevel)) && exactKeys(value.mode, ['current'], []) && ['plan', 'build', 'edit', 'yolo', 'auto'].includes(value.mode.current) && (value.permission === undefined || plainObject(value.permission)); }
/** @param {any} value */
function validThoughtLevel(value) { return exactKeys(value, ['value', 'label'], ['description']) && nonEmpty(value.value) && nonEmpty(value.label) && (value.description === undefined || typeof value.description === 'string'); }
/** @param {any} value */
function validMessage(value) { if (!exactKeys(value, ['info', 'parts'], [] ) || !plainObject(value.info) || !Array.isArray(value.parts) || !value.parts.every((/** @type {any} */ part) => plainObject(part) && nonEmpty(part.type))) return false; const info = value.info; const validTime = exactKeys(info.time, ['created'], ['completed']) && Number.isSafeInteger(info.time.created) && (info.time.completed === undefined || Number.isSafeInteger(info.time.completed)); if (info.role === 'user') return ['messageId', 'sessionId', 'agent', 'model'].every((key) => nonEmpty(info[key])) && validTime; if (info.role === 'assistant') return ['messageId', 'sessionId', 'parentMessageId', 'agent', 'model'].every((key) => nonEmpty(info[key])) && validTime && exactKeys(info.path, ['cwd', 'root'], []) && nonEmpty(info.path.cwd) && nonEmpty(info.path.root) && typeof info.cost === 'number' && validTokens(info.tokens); return false; }
/** @param {any} value */
function validTokens(value) { return plainObject(value) && ['input', 'output', 'reasoning'].every((key) => Number.isSafeInteger(value[key]) && value[key] >= 0) && exactKeys(value.cache, ['read', 'write'], []) && Number.isSafeInteger(value.cache.read) && Number.isSafeInteger(value.cache.write) && (value.total === undefined || Number.isSafeInteger(value.total)); }
/** @param {unknown} catalog */
function validCatalog(catalog) { if (!plainObject(catalog) || !exactKeys(catalog, ['current', 'available'], ['lastUsed']) || !validWireModel(catalog.current) || catalog.lastUsed !== undefined && !validWireModel(catalog.lastUsed) || !Array.isArray(catalog.available)) return false; return catalog.available.every((/** @type {any} */ entry) => plainObject(entry) && validWireModel(entry.ref) && (entry.reasoning === undefined || plainObject(entry.reasoning) && typeof entry.reasoning.enabled === 'boolean' && Array.isArray(entry.reasoning.levels) && entry.reasoning.levels.every(validThoughtLevel))); }
/** @param {unknown} model */
function validWireModel(model) { return plainObject(model) && Object.keys(model).every((key) => ['providerId', 'modelId', 'variant'].includes(key)) && nonEmpty(model.providerId) && nonEmpty(model.modelId) && (model.variant === undefined || nonEmpty(model.variant)); }
/** @param {string} method */
function outputError(method) { return new PluginError('ZCODE_OUTPUT_INVALID', `ZCode returned an invalid ${method} result.`, { category: 'protocol', remedy: 'Upgrade or restart ZCode and retry.', details: { method } }); }
