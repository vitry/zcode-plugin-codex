import { PluginError } from './errors.mjs';

/** @param {unknown} error */
export function errorEnvelope(error) {
  const value = error instanceof PluginError ? error : new PluginError('INTERNAL_ERROR', 'The companion command failed.', { category: 'runtime', remedy: 'Inspect stderr and retry.', cause: error });
  return { error: { code: value.code, category: value.category, message: value.message, remedy: value.remedy, details: redact(value.details) } };
}

/** @param {any} value @param {{json?:boolean}} [options] */
export function renderOutput(value, options = {}) {
  if (options.json) return `${JSON.stringify(redact(value))}\n`;
  if (value?.type === 'transfer' && typeof value.result === 'string') return value.result.endsWith('\n') ? value.result : `${value.result}\n`;
  if (value?.type === 'background') return `Reserved background job ${value.job.id}.\n`;
  if (value?.jobs) return `${value.jobs.map((/** @type {any} */ job) => `${job.id} ${job.status} ${job.command} ${job.owner}`).join('\n')}\n`;
  if (value?.result !== undefined) return `${value.result}\n`;
  if (value?.job) return `${value.job.id} ${value.job.status}\n`;
  return `${JSON.stringify(redact(value))}\n`;
}

/** Internal machine transport. Never use for user-facing rendering. @param {unknown} value */
export function renderInternalOutput(value) { return `${JSON.stringify(value)}\n`; }

/** @param {any} value @returns {any} */
function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== 'object') return value;
  /** @type {Record<string,any>} */ const result = {};
  for (const [key, entry] of Object.entries(value)) {
    if (/token|capability|permissionSnapshot|privateInvocation/i.test(key)) continue;
    result[key] = redact(entry);
  }
  return result;
}
