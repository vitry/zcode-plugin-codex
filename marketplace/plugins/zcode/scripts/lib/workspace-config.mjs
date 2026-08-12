import { open } from 'node:fs/promises';
import { join } from 'node:path';

import { PluginError } from './errors.mjs';
import { atomicWriteJson } from './fs.mjs';
import { resolveWorkspaceStorage } from './workspace.mjs';

const MAX_ALIASES = 128;
const MAX_NAME_BYTES = 128;
const MAX_VALUE_BYTES = 512;
const MAX_CONFIG_BYTES = 1024 * 1024;

/** @param {{dataRoot:string,workspace:string}} input */
export async function readWorkspaceModelConfig(input) {
  const path = await configPath(input); let handle;
  try { handle = await open(path, 'r'); }
  catch (error) {
    if ((/** @type {NodeJS.ErrnoException} */ (error)).code === 'ENOENT') return { version: 1, models: {} };
    throw configError('Workspace model configuration could not be read.', error);
  }
  let contents;
  try { const info = await handle.stat(); if (!info.isFile() || info.size > MAX_CONFIG_BYTES) throw configError('Workspace model configuration exceeds its size limit.'); contents = await handle.readFile('utf8'); }
  finally { await handle.close().catch(() => {}); }
  let value;
  try { value = JSON.parse(contents); } catch (error) { throw configError('Workspace model configuration is invalid JSON.', error); }
  return validateConfig(value);
}

/** @param {{dataRoot:string,workspace:string,config:unknown}} input */
export async function writeWorkspaceModelConfig(input) {
  const config = validateConfig(input.config); const path = await configPath(input);
  await atomicWriteJson(path, config); return config;
}

/** @param {{version:number,defaultModel?:string,models:Record<string,unknown>}} config */
export function summarizeWorkspaceModelConfig(config) { return { configured: config.defaultModel !== undefined || Object.keys(config.models).length > 0, ...(config.defaultModel === undefined ? {} : { defaultModel: config.defaultModel }), aliases: Object.keys(config.models).sort() }; }

/** @param {{dataRoot:string,workspace:string}} input */
async function configPath(input) {
  const storage = await resolveWorkspaceStorage(input); return join(storage.directory, 'config', 'models.json');
}

/** @param {unknown} value */
function validateConfig(value) {
  if (!plain(value)) throw configError();
  const record = /** @type {Record<string,any>} */ (value);
  if (!exactKeys(record, ['version', 'models'], ['defaultModel']) || record.version !== 1 || !plain(record.models)) throw configError();
  if (record.defaultModel !== undefined && !boundedText(record.defaultModel, MAX_VALUE_BYTES)) throw configError();
  const entries = Object.entries(record.models); if (entries.length > MAX_ALIASES) throw configError();
  /** @type {Record<string,{providerId:string,modelId:string,variant?:string}>} */ const models = {};
  for (const [alias, model] of entries) {
    if (!safeAlias(alias) || !plain(model) || !exactKeys(model, ['providerId', 'modelId'], ['variant']) || !boundedText(model.providerId, MAX_VALUE_BYTES) || !boundedText(model.modelId, MAX_VALUE_BYTES) || model.variant !== undefined && !boundedText(model.variant, MAX_VALUE_BYTES)) throw configError();
    models[alias] = { providerId: model.providerId, modelId: model.modelId, ...(model.variant === undefined ? {} : { variant: model.variant }) };
  }
  return { version: 1, ...(record.defaultModel === undefined ? {} : { defaultModel: record.defaultModel }), models };
}

/** @param {unknown} value @param {string[]} required @param {string[]} optional */
function exactKeys(value, required, optional) { const keys = Object.keys(/** @type {Record<string,unknown>} */ (value)); return required.every((key) => keys.includes(key)) && keys.every((key) => required.includes(key) || optional.includes(key)); }
/** @param {unknown} value */
function plain(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
/** @param {unknown} value @param {number} maximum */
function boundedText(value, maximum) { return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= maximum && ![...value].some((character) => { const code = /** @type {number} */ (character.codePointAt(0)); return code <= 31 || code === 127; }); }
/** @param {string} value */
function safeAlias(value) { return Buffer.byteLength(value) <= MAX_NAME_BYTES && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) && !['__proto__', 'prototype', 'constructor'].includes(value); }
/** @param {string} [message] @param {unknown} [cause] */
function configError(message = 'Workspace model configuration failed schema validation.', cause) { return new PluginError('WORKSPACE_MODEL_CONFIG_INVALID', message, { category: 'configuration', remedy: 'Run $zcode:setup with a valid bounded model policy.', ...(cause ? { cause } : {}) }); }
