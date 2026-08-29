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
const PROVIDER_OPTION_NAMESPACES = ['anthropic', 'openai', 'openaiCompatible', 'openai-compatible'];
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
    const selected = provider.models.find((entry) => entry.modelId === model.modelId);
    const thoughtLevel = selected?.reasoning === undefined ? undefined
      : effectiveThoughtLevel(selected.reasoning);
    return { revision, generatedAt, model, provider, ...(thoughtLevel === undefined ? {} : { thoughtLevel }) };
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
  const main = typeof config.model === 'string' ? config.model
    : plain(config.model) ? config.model.main : undefined;
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
  if (!PROVIDER_KINDS.has(kind)) throw runtimeModelConfigError();
  const options = raw.options === undefined ? {} : raw.options;
  if (!plain(options)) throw runtimeModelConfigError();
  const models = raw.models === undefined ? {} : boundedRecord(raw.models, MAX_MODELS);
  const selectedEntry = own(models, selectedModelId) ? [selectedModelId, models[selectedModelId]]
    : Object.entries(models).find(([, model]) => plain(model) && model.id === selectedModelId);
  const selectedModel = selectedEntry === undefined ? normalizeModel(selectedModelId, {}, kind)
    : normalizeModel(selectedEntry[0], selectedEntry[1], kind);
  const normalizedModels = [selectedModel, ...Object.entries(models)
    .filter(([modelId]) => modelId !== selectedEntry?.[0])
    .map(([modelId, model]) => normalizeModel(modelId, model, kind))];
  if (new Set(normalizedModels.map((model) => model.modelId)).size !== normalizedModels.length) {
    throw runtimeModelConfigError();
  }

  const baseURL = optionalText(options.baseURL);
  const apiKey = optionalText(options.apiKey);
  const apiKeyRequired = optionalBoolean(options.apiKeyRequired);
  const rawSelectedModel = selectedEntry?.[1];
  const headers = mergeStringRecords(raw.headers, options.headers,
    plain(rawSelectedModel) ? rawSelectedModel.headers : undefined);

  return {
    providerId, kind, source: 'user',
    ...(label === undefined ? {} : { label }),
    ...(baseURL === undefined ? {} : { baseURL }),
    ...(apiKey === undefined ? {} : { apiKey: { source: 'inline', value: apiKey } }),
    ...(apiKeyRequired === undefined ? {} : { apiKeyRequired }),
    ...(headers === undefined ? {} : { headers }),
    models: normalizedModels,
  };
}

/** @param {string} configuredModelId @param {unknown} raw @param {string} kind */
function normalizeModel(configuredModelId, raw, kind) {
  const modelId = plain(raw) && raw.id !== undefined ? optionalText(raw.id) : configuredModelId;
  if (!boundedText(modelId) || !plain(raw)) throw runtimeModelConfigError();
  const label = optionalText(raw.name);
  const limit = raw.limit === undefined ? {} : raw.limit;
  const modalities = raw.modalities === undefined ? {} : raw.modalities;
  if (!plain(limit) || !plain(modalities)) throw runtimeModelConfigError();
  const inputModalities = modalities.input === undefined ? [] : modalities.input;
  if (!Array.isArray(inputModalities) || inputModalities.length > MAX_RECORD_ENTRIES
    || inputModalities.some((entry) => !boundedText(entry))) throw runtimeModelConfigError();
  const contextWindow = optionalPositiveInteger(raw.contextWindow ?? limit.context);
  const maxOutputTokens = optionalPositiveInteger(limit.output ?? modelOptionMaxTokens(raw.options)
    ?? raw.maxOutputTokens);
  const reasoning = normalizeReasoning(raw.reasoning, kind);
  const supportsImages = optionalBoolean(raw.supportsImages ?? raw.attachment
    ?? (inputModalities.includes('image') || undefined));
  const supportsPdf = optionalBoolean(raw.supportsPdf ?? (inputModalities.includes('pdf') || undefined));
  const supportsTools = optionalBoolean(raw.supportsToolCall ?? raw.tool_call);
  const supportsStructuredOutput = optionalBoolean(raw.supportsStructuredOutput ?? raw.structured_output);
  const providerOptions = wrapProviderOptions(raw.options, kind);
  return {
    modelId,
    ...(label === undefined ? {} : { label }),
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    ...(reasoning === undefined ? {} : { reasoning }),
    ...(supportsImages === undefined ? {} : { supportsImages }),
    ...(supportsPdf === undefined ? {} : { supportsPdf }),
    ...(supportsTools === undefined ? {} : { supportsTools }),
    ...(supportsStructuredOutput === undefined ? {} : { supportsStructuredOutput }),
    ...(providerOptions === undefined ? {} : { providerOptions }),
  };
}

/** @param {unknown} value @param {string} kind */
function normalizeReasoning(value, kind) {
  if (value === undefined) return undefined;
  if (typeof value === 'boolean') return { enabled: value, levels: [] };
  if (!plain(value)) throw runtimeModelConfigError();
  const rawLevels = value.levels ?? [];
  if (!Array.isArray(rawLevels) || rawLevels.length > MAX_REASONING_LEVELS
    || rawLevels.some((level) => !boundedText(level))) return undefined;
  const levels = rawLevels.map((level) => ({ value: level, label: level }));
  const enabled = value.enabled === undefined ? levels.length > 0 : optionalBoolean(value.enabled);
  const levelValues = new Set(rawLevels);
  const defaultLevel = levelValues.has(value.defaultLevel) ? value.defaultLevel : undefined;
  const rawProviderOptionsByLevel = optionalJsonRecordMap(value.providerOptionsByLevel, MAX_REASONING_LEVELS, levelValues);
  const providerOptionsByLevel = rawProviderOptionsByLevel === undefined ? undefined
    : Object.fromEntries(Object.entries(rawProviderOptionsByLevel).map(([level, entry]) => [
      level, wrapCheckedProviderOptions(entry, kind),
    ]));
  return {
    enabled, levels,
    ...(defaultLevel === undefined ? {} : { defaultLevel }),
    ...(providerOptionsByLevel === undefined ? {} : { providerOptionsByLevel }),
  };
}

/** @param {{levels:Array<{value:string}>,defaultLevel?:string}} reasoning */
function effectiveThoughtLevel(reasoning) {
  const values = reasoning.levels.map((level) => level.value);
  return reasoning.defaultLevel !== undefined && values.includes(reasoning.defaultLevel)
    ? reasoning.defaultLevel : values[0];
}

/** @param {unknown} value */
function modelOptionMaxTokens(value) {
  return plain(value) ? value.max_tokens : undefined;
}

/** @param {unknown} value @param {string} kind */
function wrapProviderOptions(value, kind) {
  const checked = optionalJsonRecord(value);
  return checked === undefined ? undefined : wrapCheckedProviderOptions(checked, kind);
}

/** @param {Record<string,any>} value @param {string} kind */
function wrapCheckedProviderOptions(value, kind) {
  if (PROVIDER_OPTION_NAMESPACES.some((namespace) => own(value, namespace))) return value;
  const namespace = kind === 'anthropic' ? 'anthropic' : kind === 'openai' ? 'openai' : 'openaiCompatible';
  return { [namespace]: value };
}

/** @param {...unknown} values */
function mergeStringRecords(...values) {
  const merged = Object.assign({}, ...values.filter((value) => value !== undefined)
    .map((value) => optionalStringRecord(value)));
  return Object.keys(merged).length === 0 ? undefined : merged;
}

/** @param {unknown} value @param {number} maximumEntries @param {Set<string>} allowedKeys */
function optionalJsonRecordMap(value, maximumEntries, allowedKeys) {
  if (value === undefined) return undefined;
  const record = boundedRecord(value, maximumEntries);
  return Object.fromEntries(Object.entries(record).filter(([key]) => allowedKeys.has(key)).map(([key, entry]) => {
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
