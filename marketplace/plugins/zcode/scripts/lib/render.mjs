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
  if (value?.jobs) return `${value.jobs.map(renderCompactJob).join('\n')}\n${renderModelPolicy(value.modelPolicy)}`;
  if (value?.result !== undefined) return `${value.result}\n`;
  if (value?.job) return `${renderJob(value.job)}${renderModelPolicy(value.modelPolicy)}`;
  return `${JSON.stringify(redact(value))}\n`;
}

/** @param {any} job */
function renderCompactJob(job) {
  if (job.hasOwner === true && job.owned === undefined) {
    return [
      job.id,
      job.status,
      'owner=redacted',
      `created=${safeInline(job.createdAt)}`,
      `started=${safeInline(job.startedAt)}`,
      `finished=${safeInline(job.finishedAt)}`,
      `activity=${safeInline(job.lastActivityAt)}`,
    ].map((value) => typeof value === 'string' && value.includes('=') ? value : safeInline(value)).join(' ');
  }
  const fields = [job.id, job.status, job.command, job.owner].map((value) => safeInline(value));
  fields.push(`phase=${safeInline(job.phase)}`);
  fields.push(`activity=${safeInline(job.lastActivityAt)}`);
  const latest = Array.isArray(job.progressPreview) ? job.progressPreview.at(-1) : undefined;
  if (typeof latest === 'string') fields.push(`latest=${safeProgress(latest)}`);
  return fields.join(' ');
}

/** @param {any} job */
function renderJob(job) {
  const terminal = ['succeeded', 'failed', 'cancelled'].includes(job.status);
  const startedAt = validTimestamp(job.startedAt) ? job.startedAt
    : validTimestamp(job.createdAt) ? job.createdAt : undefined;
  const finishedAt = validTimestamp(job.finishedAt) ? job.finishedAt : undefined;
  const end = terminal ? finishedAt : new Date(Date.now()).toISOString();
  const timingLabel = terminal ? 'Duration' : 'Elapsed';
  const timing = startedAt && end ? formatDuration(Date.parse(end) - Date.parse(startedAt)) : '—';
  const previews = Array.isArray(job.progressPreview)
    ? job.progressPreview.filter((/** @type {unknown} */ message) => typeof message === 'string').slice(-4)
    : [];
  const lastCancellationError = renderCancellationError(job.lastCancelError);
  const lines = [
    `Job: ${safeInline(job.id)}`,
    `Command: ${safeInline(job.command)}`,
    `Status: ${safeInline(job.status)}`,
    `Phase: ${safeInline(job.phase)}`,
    `Created: ${safeInline(job.createdAt)}`,
    `Started: ${safeInline(job.startedAt)}`,
    `Finished: ${safeInline(job.finishedAt)}`,
    `${timingLabel}: ${timing}`,
    `Last activity: ${safeInline(job.lastActivityAt)}`,
    ...(lastCancellationError === null
      ? [] : [`Last cancellation error: ${lastCancellationError}`]),
    'Progress:',
    ...(previews.length > 0
      ? previews.map((/** @type {string} */ message) => `  - ${safeProgress(message)}`)
      : ['  - none']),
  ];
  return `${lines.join('\n')}\n`;
}

/** @param {unknown} value */
function renderCancellationError(value) {
  const message = typeof value === 'string' ? value
    : value && typeof value === 'object' && 'message' in value
      && typeof value.message === 'string' ? value.message : null;
  if (message === null || message.trim().length === 0) return null;
  return boundUtf8(safeInline(message), 2_048);
}

/** @param {unknown} value */
function safeInline(value) {
  if (typeof value !== 'string' || value.length === 0) return '—';
  const controlFree = [...value].map((character) => {
    const code = /** @type {number} */ (character.codePointAt(0));
    if (isBidiControl(code)) return '';
    return code <= 31 || code >= 127 && code <= 159 ? ' ' : character;
  }).join('');
  return escapeMarkdown(controlFree.replace(/\s+/g, ' ').trim());
}

/** @param {string} message */
function safeProgress(message) {
  const bounded = boundUtf8(message, 256);
  return safeInline(bounded);
}

/** @param {string} value */
function escapeMarkdown(value) {
  return value.replace(/([\\`*_{}[\]<>#!|~])/g, '\\$1').replace(/^([-+])/, '\\$1');
}

/** @param {number} code */
function isBidiControl(code) {
  return code === 0x061c || code === 0x200e || code === 0x200f
    || code >= 0x202a && code <= 0x202e || code >= 0x2066 && code <= 0x2069;
}

/** @param {string} value @param {number} maxBytes */
function boundUtf8(value, maxBytes) {
  if (Buffer.byteLength(value) <= maxBytes) return value;
  let result = '';
  for (const character of value) {
    if (Buffer.byteLength(result) + Buffer.byteLength(character) > maxBytes - 3) break;
    result += character;
  }
  return `${result}...`;
}

/** @param {number} milliseconds */
function formatDuration(milliseconds) {
  let seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const days = Math.floor(seconds / 86_400); seconds %= 86_400;
  const hours = Math.floor(seconds / 3_600); seconds %= 3_600;
  const minutes = Math.floor(seconds / 60); seconds %= 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/** @param {unknown} value */
function validTimestamp(value) {
  if (typeof value !== 'string') return false;
  try { return new Date(value).toISOString() === value; } catch { return false; }
}

/** @param {any} policy */
function renderModelPolicy(policy) { return policy ? `Model policy: default=${policy.defaultModel ?? 'ZCode default'}; aliases=${policy.aliases.length ? policy.aliases.join(',') : 'none'}\n` : ''; }

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
