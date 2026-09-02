import { isAbsolute } from 'node:path';

import { PluginError } from './errors.mjs';
import { boundUtf8, normalizePublicText, publicErrorMessage } from './public-text.mjs';
import { validProgressProbe } from './state.mjs';

/** @param {unknown} error */
export function errorEnvelope(error) {
  const value = error instanceof PluginError ? error : new PluginError('INTERNAL_ERROR', 'The companion command failed.', { category: 'runtime', remedy: 'Inspect stderr and retry.', cause: error });
  return { error: { code: value.code, category: value.category, message: value.message, remedy: value.remedy, details: redact(value.details) } };
}

/** @param {any} value @param {{json?:boolean}} [options] */
export function renderOutput(value, options = {}) {
  if (options.json) return `${JSON.stringify(redact(value, exactOwnerJob(value)))}\n`;
  if (value?.type === 'transfer' && typeof value.result === 'string') return value.result.endsWith('\n') ? value.result : `${value.result}\n`;
  if (value?.type === 'background') return `Reserved background job ${value.job.id}.\n`;
  if (value?.jobs) return `${value.jobs.map(renderCompactJob).join('\n')}\n${renderModelPolicy(value.modelPolicy)}`;
  if (value?.result !== undefined) {
    // A succeeded terminal view renders the stored result AND the derived
    // Resumability Indicator (both polarities, per ADR 0018); only the
    // user-level resume hint is conditional on a true value.
    const job = value?.job;
    const indicator = job?.resumable === true || job?.resumable === false
      ? `Resumable: ${job.resumable ? 'yes' : 'no'}\n` : '';
    const hint = job?.resumable === true
      ? 'Rescue hint: run $zcode:rescue --resume to continue this session\n' : '';
    return `${value.result}\n${indicator}${hint}`;
  }
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
  const storedError = ['failed', 'cancelled'].includes(job.status) ? renderStoredError(job.error) : null;
  const lastCancellationError = renderStoredError(job.lastCancelError);
  // Terminal Rescue views carry their derived Stop Cause and Resumability
  // Indicator; the projection decides presence, rendering never derives them,
  // and the internal ZCode session ID never crosses this seam.
  const stopCause = typeof job.stopCause === 'string' && job.stopCause.length > 0 ? safeInline(job.stopCause) : null;
  const resumable = typeof job.resumable === 'boolean' ? job.resumable : null;
  const logFile = safePath(job.owned === true && job.owner === 'same-owner' ? job.logFile : undefined);
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
    ...(logFile === null ? [] : [`Log: ${logFile}`]),
    ...(storedError === null ? [] : [`Error: ${storedError}`]),
    ...(stopCause === null ? [] : [`Stop cause: ${stopCause}`]),
    ...(lastCancellationError === null
      ? [] : [`Last cancellation error: ${lastCancellationError}`]),
    ...(resumable === null ? [] : [`Resumable: ${resumable ? 'yes' : 'no'}`]),
    ...(resumable === true ? ['Rescue hint: run $zcode:rescue --resume to continue this session'] : []),
    'Progress:',
    ...(previews.length > 0
      ? previews.map((/** @type {string} */ message) => `  - ${safeProgress(message)}`)
      : ['  - none']),
  ];
  return `${lines.join('\n')}\n`;
}

/** @param {unknown} value */
function renderStoredError(value) {
  const message = publicErrorMessage(value);
  if (message === null) return null;
  return boundMarkdown(escapeMarkdown(message), 2_048);
}

/** @param {string} value @param {number} maxBytes */
function boundMarkdown(value, maxBytes) {
  if (Buffer.byteLength(value) <= maxBytes) return value;
  const bounded = boundUtf8(value, maxBytes);
  const prefix = bounded.slice(0, -3);
  const trailingBackslashes = prefix.match(/\\+$/u)?.[0].length ?? 0;
  return trailingBackslashes % 2 === 0 ? bounded : `${prefix.slice(0, -1)}...`;
}

/** @param {unknown} value */
function safeInline(value) {
  if (typeof value !== 'string' || value.length === 0) return '—';
  return escapeMarkdown(normalizePublicText(value));
}

/** @param {string} message */
function safeProgress(message) {
  return escapeMarkdown(boundUtf8(normalizePublicText(message), 256));
}

/** @param {unknown} value */
function safePath(value) {
  if (typeof value !== 'string' || !isAbsolute(value) || [...value].some(unsafePathCharacter)) return null;
  return boundMarkdown(escapeMarkdown(value), 4_096);
}

/** @param {string} character */
function unsafePathCharacter(character) {
  const code = /** @type {number} */ (character.codePointAt(0));
  return code <= 0x1f || code >= 0x7f && code <= 0x9f
    || code === 0x061c || code === 0x200e || code === 0x200f
    || code === 0x2028 || code === 0x2029 || code >= 0x202a && code <= 0x202e
    || code >= 0x2066 && code <= 0x2069;
}

/** @param {string} value */
function escapeMarkdown(value) {
  return value.replace(/([\\`*_{}[\]<>#!|~])/g, '\\$1').replace(/^([-+])/, '\\$1');
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

/** @param {any} value @returns {any|null} */
function exactOwnerJob(value) {
  return value && typeof value === 'object' && !Array.isArray(value) && !Object.hasOwn(value, 'jobs')
    && value.job && typeof value.job === 'object' && !Array.isArray(value.job)
    && value.job.owned === true && value.job.owner === 'same-owner'
    ? value.job : null;
}

/** @param {any} value @param {any|null} [progressProbeOwner] @returns {any} */
function redact(value, progressProbeOwner = null) {
  if (Array.isArray(value)) return value.map((entry) => redact(entry, progressProbeOwner));
  if (!value || typeof value !== 'object') return value;
  /** @type {Record<string,any>} */ const result = {};
  for (const [key, entry] of Object.entries(value)) {
    if (/token|capability|executionCommitted|permissionSnapshot|privateInvocation|rescueMigrationRollback|rescueContinuationOrigin|rescueExecutionClaim|rescueExecutionReservation|rescueReservationKind|rescueJobSpecCommitment|rescueLegacyJobSpecProof|ownerLifecycleEpoch|executionOwner|hostPlacement|stopIntent|childPid|workerLeaseId|zcodeSessionId/i.test(key)) continue;
    if (/progressProbe/i.test(key) && (value !== progressProbeOwner || key !== 'progressProbe' || !validProgressProbe(entry))) continue;
    if (key === 'logFile' && value !== progressProbeOwner) continue;
    result[key] = redact(entry, progressProbeOwner);
  }
  return result;
}
