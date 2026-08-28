import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { PluginError } from './errors.mjs';
import { readBoundedJsonFile } from './fs.mjs';

const DEFAULT_MAX_BYTES = 64 * 1024;
const MAX_TEXT_BYTES = 4096;
const MAX_PROVIDERS = 64;
const MAX_MODELS = 256;
const MAX_RECORD_ENTRIES = 256;
const MAX_REASONING_LEVELS = 32;
const MAX_VALUE_DEPTH = 8;
const MAX_VALUE_NODES = 2048;
const PROVIDER_KINDS = new Set(['anthropic', 'openai', 'openai-compatible']);
const API_FORMATS = new Set(['anthropic-messages', 'openai-chat-completions', 'openai-responses']);
const PROVIDER_SOURCES = new Set(['builtin', 'models-dev', 'custom', 'user', 'workspace', 'ephemeral']);
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

/**
 * @param {{env?:NodeJS.ProcessEnv,home?:string,maxBytes?:number}} [input]
 * @returns {Promise<{providerId:string,modelId:string}>}
 */
export async function readZCodeCliMainModel(input = {}) {
  try {
    return parseMainModel(await readEffectiveConfig(input));
  } catch {
    throw runtimeModelConfigError();
  }
}

/**
 * @param {{env?:NodeJS.ProcessEnv,home?:string,maxBytes?:number,now?:()=>number,revision?:()=>string,model?:{providerId:string,modelId:string}}} [input]
 */
export async function readZCodeCliRuntimeModel(input = {}) {
  try {
    const config = await readEffectiveConfig(input);
    const model = input.model === undefined ? parseMainModel(config) : normalizeModelRef(input.model);
    const providers = boundedRecord(config.provider, MAX_PROVIDERS, 1);
    const rawProvider = own(providers, model.providerId);
    if (!plain(rawProvider)) throw runtimeModelConfigError();
    const provider = normalizeProvider(rawProvider, model.providerId, model.modelId);
    const revision = (input.revision ?? defaultRevision)();
    const generatedAt = (input.now ?? Date.now)();
    if (!boundedText(revision) || !nonnegativeSafeInteger(generatedAt)) throw runtimeModelConfigError();
    return { revision, generatedAt, model, provider };
  } catch {
    throw runtimeModelConfigError();
  }
}

/** @param {{env?:NodeJS.ProcessEnv,home?:string,maxBytes?:number}} input @returns {Promise<Record<string,any>>} */
async function readEffectiveConfig(input) {
  const env = input.env ?? process.env;
  const home = input.home ?? (env.HOME || env.USERPROFILE || homedir());
  const maxBytes = input.maxBytes ?? DEFAULT_MAX_BYTES;
  if (!boundedText(home) || !Number.isSafeInteger(maxBytes) || maxBytes < 1) throw runtimeModelConfigError();
  const value = await readBoundedJsonFile(home, join(home, '.zcode', 'cli', 'config.json'), maxBytes);
  if (!plain(value)) throw runtimeModelConfigError();
  return value;
}

/** @param {Record<string,any>} config */
function parseMainModel(config) {
  const main = plain(config.model) ? config.model.main : undefined;
  if (!boundedText(main)) throw runtimeModelConfigError();
  const slash = main.indexOf('/');
  if (slash < 1) throw runtimeModelConfigError();
  return normalizeModelRef({ providerId: main.slice(0, slash), modelId: main.slice(slash + 1) });
}

/** @param {unknown} value */
function normalizeModelRef(value) {
  if (!plain(value) || !boundedText(value.providerId) || !boundedText(value.modelId)) throw runtimeModelConfigError();
  return { providerId: value.providerId, modelId: value.modelId };
}

/** @param {Record<string,any>} raw @param {string} providerId @param {string} selectedModelId */
function normalizeProvider(raw, providerId, selectedModelId) {
  const kind = raw.kind;
  const label = optionalText(raw.name);
  const source = raw.source ?? 'user';
  if (!PROVIDER_KINDS.has(kind) || !PROVIDER_SOURCES.has(source)) throw runtimeModelConfigError();
  const options = raw.options === undefined ? {} : raw.options;
  if (!plain(options)) throw runtimeModelConfigError();
  const models = boundedRecord(raw.models, MAX_MODELS, 1);
  if (!own(models, selectedModelId)) throw runtimeModelConfigError();
  const normalizedModels = Object.entries(models).map(([modelId, model]) => normalizeModel(modelId, model));
  if (normalizedModels.length < 1) throw runtimeModelConfigError();

  const apiFormat = optionalEnum(options.apiFormat, API_FORMATS);
  const baseURL = optionalText(options.baseURL);
  const apiKey = optionalText(options.apiKey);
  const apiKeyRequired = optionalBoolean(options.apiKeyRequired);
  const headers = optionalStringRecord(options.headers);
  const providerOptions = optionalJsonRecord(options.providerOptions);
  const logoUrl = optionalText(options.logoUrl);
  const modelsDevProviderId = optionalText(options.modelsDevProviderId);
  if (apiKeyRequired === true && apiKey === undefined) throw runtimeModelConfigError();

  return {
    providerId, kind, source,
    ...(label === undefined ? {} : { label }),
    ...(apiFormat === undefined ? {} : { apiFormat }),
    ...(baseURL === undefined ? {} : { baseURL }),
    ...(apiKey === undefined ? {} : { apiKey: { source: 'inline', value: apiKey } }),
    ...(apiKeyRequired === undefined ? {} : { apiKeyRequired }),
    ...(headers === undefined ? {} : { headers }),
    ...(providerOptions === undefined ? {} : { providerOptions }),
    ...(logoUrl === undefined ? {} : { logoUrl }),
    ...(modelsDevProviderId === undefined ? {} : { modelsDevProviderId }),
    models: normalizedModels,
  };
}

/** @param {string} modelId @param {unknown} raw */
function normalizeModel(modelId, raw) {
  if (!boundedText(modelId) || !plain(raw)) throw runtimeModelConfigError();
  const label = optionalText(raw.name);
  const description = optionalText(raw.description);
  const contextWindow = optionalPositiveInteger(raw.contextWindow);
  const maxOutputTokens = optionalPositiveInteger(raw.maxOutputTokens);
  const reasoning = optionalReasoning(raw.reasoning);
  const supportsImages = optionalBoolean(raw.supportsImages);
  const supportsPdf = optionalBoolean(raw.supportsPdf);
  const supportsTools = optionalBoolean(raw.supportsTools);
  const supportsStructuredOutput = optionalBoolean(raw.supportsStructuredOutput);
  const providerOptions = optionalJsonRecord(raw.providerOptions);
  const disabledReason = optionalText(raw.disabledReason);
  return {
    modelId,
    ...(label === undefined ? {} : { label }),
    ...(description === undefined ? {} : { description }),
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    ...(reasoning === undefined ? {} : { reasoning }),
    ...(supportsImages === undefined ? {} : { supportsImages }),
    ...(supportsPdf === undefined ? {} : { supportsPdf }),
    ...(supportsTools === undefined ? {} : { supportsTools }),
    ...(supportsStructuredOutput === undefined ? {} : { supportsStructuredOutput }),
    ...(providerOptions === undefined ? {} : { providerOptions }),
    ...(disabledReason === undefined ? {} : { disabledReason }),
  };
}

/** @param {unknown} value */
function optionalReasoning(value) {
  if (value === undefined) return undefined;
  if (!plain(value) || typeof value.enabled !== 'boolean' || !Array.isArray(value.levels)
    || value.levels.length > MAX_REASONING_LEVELS) throw runtimeModelConfigError();
  const levels = value.levels.map((level) => {
    if (!plain(level) || !boundedText(level.value) || !boundedText(level.label)) throw runtimeModelConfigError();
    const description = optionalText(level.description);
    return { value: level.value, label: level.label, ...(description === undefined ? {} : { description }) };
  });
  const defaultLevel = optionalText(value.defaultLevel);
  const providerOptionsByLevel = optionalJsonRecordMap(value.providerOptionsByLevel, MAX_REASONING_LEVELS);
  return {
    enabled: value.enabled, levels,
    ...(defaultLevel === undefined ? {} : { defaultLevel }),
    ...(providerOptionsByLevel === undefined ? {} : { providerOptionsByLevel }),
  };
}

/** @param {unknown} value @param {number} maximumEntries */
function optionalJsonRecordMap(value, maximumEntries) {
  if (value === undefined) return undefined;
  const record = boundedRecord(value, maximumEntries);
  return Object.fromEntries(Object.entries(record).map(([key, entry]) => {
    if (!plain(entry)) throw runtimeModelConfigError();
    return [key, checkedJsonRecord(entry)];
  }));
}

/** @param {unknown} value */
function optionalJsonRecord(value) {
  if (value === undefined) return undefined;
  if (!plain(value)) throw runtimeModelConfigError();
  return checkedJsonRecord(value);
}

/** @param {Record<string,any>} value */
function checkedJsonRecord(value) {
  const state = { nodes: 0 };
  return /** @type {Record<string,any>} */ (checkedJsonValue(value, 0, state));
}

/** @param {unknown} value @param {number} depth @param {{nodes:number}} state @returns {any} */
function checkedJsonValue(value, depth, state) {
  state.nodes += 1;
  if (state.nodes > MAX_VALUE_NODES || depth > MAX_VALUE_DEPTH) throw runtimeModelConfigError();
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (!boundedText(value)) throw runtimeModelConfigError();
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw runtimeModelConfigError();
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_RECORD_ENTRIES) throw runtimeModelConfigError();
    return value.map((entry) => checkedJsonValue(entry, depth + 1, state));
  }
  if (!plain(value)) throw runtimeModelConfigError();
  const entries = Object.entries(value);
  if (entries.length > MAX_RECORD_ENTRIES) throw runtimeModelConfigError();
  return Object.fromEntries(entries.map(([key, entry]) => {
    if (!safeKey(key)) throw runtimeModelConfigError();
    return [key, checkedJsonValue(entry, depth + 1, state)];
  }));
}

/** @param {unknown} value */
function optionalStringRecord(value) {
  if (value === undefined) return undefined;
  const record = boundedRecord(value, MAX_RECORD_ENTRIES);
  return Object.fromEntries(Object.entries(record).map(([key, entry]) => {
    if (typeof entry !== 'string' || !boundedText(entry)) throw runtimeModelConfigError();
    return [key, entry];
  }));
}

/** @param {unknown} value @param {Set<string>} values @returns {string|undefined} */
function optionalEnum(value, values) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !values.has(value)) throw runtimeModelConfigError();
  return value;
}

/** @param {unknown} value */
function optionalText(value) {
  if (value === undefined) return undefined;
  if (!boundedText(value)) throw runtimeModelConfigError();
  return value;
}

/** @param {unknown} value */
function optionalBoolean(value) {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw runtimeModelConfigError();
  return value;
}

/** @param {unknown} value */
function optionalPositiveInteger(value) {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw runtimeModelConfigError();
  return value;
}

/** @param {unknown} value @param {number} maximumEntries @param {number} [minimumEntries] @returns {Record<string,any>} */
function boundedRecord(value, maximumEntries, minimumEntries = 0) {
  if (!plain(value)) throw runtimeModelConfigError();
  const entries = Object.entries(value);
  if (entries.length < minimumEntries || entries.length > maximumEntries || entries.some(([key]) => !safeKey(key))) throw runtimeModelConfigError();
  return value;
}

/** @param {Record<string,any>} record @param {string} key */
function own(record, key) { return Object.hasOwn(record, key) ? record[key] : undefined; }
/** @param {unknown} value @returns {value is Record<string,any>} */
function plain(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
/** @param {string} value */
function safeKey(value) { return boundedText(value) && !DANGEROUS_KEYS.has(value); }
/** @param {unknown} value @returns {value is string} */
function boundedText(value) {
  return typeof value === 'string' && value.trim().length > 0 && Buffer.byteLength(value) <= MAX_TEXT_BYTES
    && ![...value].some((character) => {
      const code = /** @type {number} */ (character.codePointAt(0));
      return code <= 31 || code >= 127 && code <= 159;
    });
}
/** @param {unknown} value */
function nonnegativeSafeInteger(value) { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }
function defaultRevision() { return `codex-runtime-${randomUUID()}`; }
function runtimeModelConfigError() {
  return new PluginError('ZCODE_RUNTIME_MODEL_CONFIG_INVALID', 'ZCode runtime model configuration is unavailable.', {
    category: 'configuration', remedy: 'Configure model.main in the ZCode CLI configuration and retry.',
  });
}
