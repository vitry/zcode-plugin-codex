import { homedir } from 'node:os';
import { join } from 'node:path';

import { PluginError } from './errors.mjs';
import { readBoundedJsonFile } from './fs.mjs';

/**
 * @param {{env?:NodeJS.ProcessEnv,home?:string,maxBytes?:number}} [input]
 * @returns {Promise<{providerId:string,modelId:string}>}
 */
export async function readZCodeCliMainModel(input = {}) {
  const env = input.env ?? process.env;
  const home = input.home ?? (env.HOME || env.USERPROFILE || homedir());
  const maxBytes = input.maxBytes ?? 64 * 1024;
  try {
    const value = await readBoundedJsonFile(home, join(home, '.zcode', 'cli', 'config.json'), maxBytes);
    const main = plain(value) && plain(value.model) ? value.model.main : undefined;
    if (!boundedText(main)) throw runtimeModelConfigError();
    const slash = main.indexOf('/');
    const providerId = main.slice(0, slash); const modelId = main.slice(slash + 1);
    if (slash < 1 || !boundedText(providerId) || !boundedText(modelId)) throw runtimeModelConfigError();
    return { providerId, modelId };
  } catch {
    throw runtimeModelConfigError();
  }
}

/** @param {unknown} value */
function plain(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
/** @param {unknown} value */
function boundedText(value) {
  return typeof value === 'string' && value.trim().length > 0 && Buffer.byteLength(value) <= 4096
    && ![...value].some((character) => { const code = /** @type {number} */ (character.codePointAt(0)); return code <= 31 || code === 127; });
}
function runtimeModelConfigError() {
  return new PluginError('ZCODE_RUNTIME_MODEL_CONFIG_INVALID', 'ZCode runtime model configuration is unavailable.', {
    category: 'configuration', remedy: 'Configure model.main in the ZCode CLI configuration and retry.',
  });
}
