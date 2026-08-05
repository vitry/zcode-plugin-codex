import { PluginError } from './errors.mjs';

const PUBLIC_COMMANDS = new Set(['review', 'adversarial-review', 'rescue', 'status', 'result', 'cancel']);
const SCOPES = new Set(['auto', 'working-tree', 'branch']);
const EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);
const JOB_ID = /^[a-f0-9]{64}$/;

/** @param {string[]} argv @returns {any} */
export function parseArgs(argv) {
  if (!Array.isArray(argv) || argv.some((value) => typeof value !== 'string') || argv.length === 0) throw argumentError('A supported command is required.');
  const [command, ...tokens] = argv;
  if (!PUBLIC_COMMANDS.has(command) && command !== 'run-reserved-job') throw argumentError(`Unknown command: ${command}`);
  if (command === 'run-reserved-job') return parsePrivate(tokens);
  /** @type {any} */
  const parsed = command === 'review' || command === 'adversarial-review'
    ? parseReview(command, tokens)
    : command === 'rescue' ? parseRescue(tokens)
      : command === 'status' ? parseStatus(tokens) : parseJobLookup(command, tokens);
  if (!parsed.options.callerContext) throw new PluginError('CALLER_CONTEXT_REQUIRED', 'A caller context is required.', { category: 'authorization', remedy: 'Run $zcode:setup and invoke this command through its installed skill.' });
  return { command, ...parsed };
}

/** @param {string} value @param {Record<string,unknown>} aliases @param {any[]} catalog */
export function resolveModel(value, aliases = {}, catalog = []) {
  if (value === 'spark') throw new PluginError('MODEL_SPARK_FORBIDDEN', 'The public spark model is not supported.', { category: 'validation', remedy: 'Choose a configured model alias or provider/model.' });
  if (typeof value !== 'string' || !value) throw modelNotFound(value);
  if (value.includes('/')) {
    const slash = value.indexOf('/'); const providerId = value.slice(0, slash); const modelId = value.slice(slash + 1);
    if (!providerId || !modelId) throw modelNotFound(value);
    return { providerId, modelId };
  }
  const alias = aliases[value];
  if (validModel(alias)) return copyModel(alias);
  const matches = catalog.map((item) => item?.ref ?? item).filter((model) => validModel(model) && model.modelId === value);
  if (matches.length === 1) return copyModel(matches[0]);
  throw modelNotFound(value);
}

/** @param {string} command @param {string[]} tokens @returns {any} */
function parseReview(command, tokens) {
  /** @type {any} */ const options = { execution: 'foreground', scope: 'auto' };
  /** @type {string[]} */ const positionals = [];
  parseTokens(tokens, {
    boolean: {
      '--wait': () => setExecution(options, 'wait'),
      '--background': () => setExecution(options, 'background'),
    },
    scalar: {
      '--base': (value) => { options.base = value; },
      '--scope': (value) => { if (!SCOPES.has(value)) throw argumentError('Invalid review scope.'); options.scope = value; },
      '--caller-context': (value) => { options.callerContext = value; },
    },
    positionals,
  });
  if (command === 'review' && positionals.length) throw argumentError('Review does not accept focus text.');
  return { options, positionals };
}

/** @param {string[]} tokens @returns {any} */
function parseRescue(tokens) {
  /** @type {any} */ const options = { execution: 'foreground' };
  /** @type {string[]} */ const positionals = [];
  parseTokens(tokens, {
    boolean: {
      '--wait': () => setExecution(options, 'wait'), '--background': () => setExecution(options, 'background'),
      '--resume': () => setResume(options, 'resume'), '--fresh': () => setResume(options, 'fresh'),
    },
    scalar: {
      '--model': (value) => { if (value === 'spark') throw new PluginError('MODEL_SPARK_FORBIDDEN', 'The public spark model is not supported.', { category: 'validation', remedy: 'Choose a configured model alias or provider/model.' }); options.model = value; },
      '--effort': (value) => { const normalized = value.toLowerCase(); if (!EFFORTS.has(normalized)) throw argumentError('Invalid effort level.'); options.effort = normalized; },
      '--caller-context': (value) => { options.callerContext = value; },
    }, positionals,
  });
  if (!positionals.some((value) => value.trim())) throw argumentError('Rescue requires a task.');
  return { options, positionals };
}

/** @param {string[]} tokens @returns {any} */
function parseStatus(tokens) {
  /** @type {any} */ const options = { wait: false, timeoutMs: 240000, all: false };
  /** @type {string[]} */ const positionals = [];
  parseTokens(tokens, {
    boolean: { '--wait': () => { options.wait = true; }, '--all': () => { options.all = true; } },
    scalar: {
      '--timeout-ms': (value) => { if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw argumentError('Timeout must be a finite nonnegative safe integer.'); options.timeoutMs = Number(value); options.timeoutSpecified = true; },
      '--caller-context': (value) => { options.callerContext = value; },
    }, positionals,
  });
  validateJobPositionals(positionals);
  if (options.wait && positionals.length !== 1) throw argumentError('Status --wait requires an explicit job ID.');
  if (options.timeoutSpecified && !options.wait) throw argumentError('--timeout-ms requires --wait.');
  if (options.all && (positionals.length || options.wait)) throw argumentError('--all conflicts with job selection and waiting.');
  delete options.timeoutSpecified;
  return { options, positionals };
}

/** @param {string} command @param {string[]} tokens @returns {any} */
function parseJobLookup(command, tokens) {
  /** @type {any} */ const options = {};
  /** @type {string[]} */ const positionals = [];
  parseTokens(tokens, { boolean: {}, scalar: { '--caller-context': (value) => { options.callerContext = value; } }, positionals });
  validateJobPositionals(positionals);
  return { options, positionals };
}

/** @param {string[]} tokens @returns {any} */
function parsePrivate(tokens) {
  /** @type {any} */ const options = {};
  /** @type {string[]} */ const positionals = [];
  parseTokens(tokens, { boolean: {}, scalar: { '--execution-capability': (value) => { options.executionCapability = value; } }, positionals });
  if (positionals.length !== 1 || !JOB_ID.test(positionals[0]) || !options.executionCapability) throw argumentError('Private execution requires one job ID and one execution capability.');
  return { command: 'run-reserved-job', options, positionals };
}

/** @param {string[]} tokens @param {{boolean:Record<string,(value?:string)=>void>,scalar:Record<string,(value:string)=>void>,positionals:string[]}} target */
function parseTokens(tokens, target) {
  const seen = new Set(); const knownFlags = new Set([...Object.keys(target.boolean), ...Object.keys(target.scalar)]); let positionalMode = false;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === '--') { positionalMode = true; continue; }
    if (!positionalMode && token.startsWith('-')) {
      const handler = target.boolean[token] ?? target.scalar[token];
      if (!handler) throw argumentError(`Unknown flag: ${token}`);
      if (seen.has(token)) throw argumentError(`Duplicate flag: ${token}`); seen.add(token);
      if (target.scalar[token]) { const value = tokens[++index]; if (!value || knownFlags.has(value)) throw argumentError(`Missing value for ${token}`); handler(value); }
      else handler();
    } else target.positionals.push(token);
  }
}

/** @param {any} options @param {string} value */
function setExecution(options, value) { if (options.execution !== 'foreground') throw argumentError('--wait and --background are mutually exclusive.'); options.execution = value; }
/** @param {any} options @param {string} value */
function setResume(options, value) { if (options.resume) throw argumentError('--resume and --fresh are mutually exclusive.'); options.resume = value; }
/** @param {string[]} positionals */
function validateJobPositionals(positionals) { if (positionals.length > 1 || positionals.length === 1 && !JOB_ID.test(positionals[0])) throw argumentError('Expected one 64-character job ID.'); }
/** @param {any} value */
function validModel(value) { return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every((key) => ['providerId', 'modelId', 'variant'].includes(key)) && typeof value.providerId === 'string' && value.providerId && typeof value.modelId === 'string' && value.modelId && (value.variant === undefined || typeof value.variant === 'string' && value.variant); }
/** @param {any} value */
function copyModel(value) { return { providerId: value.providerId, modelId: value.modelId, ...(value.variant ? { variant: value.variant } : {}) }; }
/** @param {unknown} value */
function modelNotFound(value) { return new PluginError('MODEL_NOT_FOUND', `Model ${String(value)} could not be resolved.`, { category: 'configuration', remedy: 'Use provider/model, a configured alias, or an exact advertised model ID.' }); }
/** @param {string} message */
function argumentError(message) { return new PluginError('ARGUMENT_INVALID', message, { category: 'validation', remedy: 'Use the documented command arguments.' }); }
