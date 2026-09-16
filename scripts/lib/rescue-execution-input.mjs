import { PluginError } from './errors.mjs';
import { validHostLifecycleRecord } from './rescue-binding.mjs';
import { RESCUE_TASK_MAX_BYTES } from './rescue-preparation.mjs';

/**
 * Durable execution-format identity of one SPLIT-schema detached Rescue runner
 * job. Version 2 markers are written only by the split-placement reservations
 * (either recorded Host placement is lifecycle evidence) and admitted by the
 * closed predicate below. The marker is immutable evidence retained through
 * terminal state; unknown versions fail closed.
 */
export const RESCUE_RUNNER_VERSION = 2;

/**
 * The historical runner-format marker of every PRE-split detached Rescue job.
 * Historical records keep their stored interpretation — a v1 marker is valid
 * detached evidence only beside a background Host placement, exactly as the
 * pre-split schema required — and are never migrated or reinterpreted as
 * split evidence.
 */
export const RESCUE_RUNNER_HISTORICAL_VERSION = 1;

/**
 * The private `rescueExecutionInput` envelope version, decided independently
 * of the marker: the bounded execution envelope predates the placement split,
 * keeps version 1 across it, and never rides the marker's format version.
 */
export const RESCUE_EXECUTION_INPUT_VERSION = 1;

/**
 * The closed detached-runner admission predicate of one split-schema Rescue
 * record: complete Host lifecycle authority plus valid detached Companion
 * execution evidence (the exact split marker). The recorded `hostPlacement`
 * is lifecycle evidence of the Host side only — it neither authorizes nor
 * rejects a runner by itself — so admission keys on the complete trio, the
 * writable Rescue command, and the known marker version, and never compares
 * placement.
 * @param {any} record @returns {boolean}
 */
export function validDetachedRescueRunnerRecord(record) {
  return record !== null && typeof record === 'object' && !Array.isArray(record)
    && record.command === 'rescue' && record.readOnly === false
    && record.rescueRunnerVersion === RESCUE_RUNNER_VERSION
    && validHostLifecycleRecord(record);
}

/**
 * The retained historical-format predicate: a pre-split v1 marker record is
 * valid detached evidence exactly as the pre-split schema required — complete
 * Host lifecycle authority AND background Host placement — never reinterpreted
 * for foreground records, which that schema always rejected. Historical
 * records keep their stored interpretation; nothing migrates.
 * @param {any} record @returns {boolean}
 */
export function validHistoricalDetachedRescueRunnerRecord(record) {
  return record !== null && typeof record === 'object' && !Array.isArray(record)
    && record.command === 'rescue' && record.readOnly === false
    && record.rescueRunnerVersion === RESCUE_RUNNER_HISTORICAL_VERSION
    && validHostLifecycleRecord(record) && record.hostPlacement === 'background';
}

/**
 * Every persisted detached-runner format that state validation, runner
 * admission, and detached-semantics selection admit: the split-schema marker
 * with either Host placement, or the historical marker with its stored
 * background-only interpretation. Any other marker shape (unknown versions, a
 * historical version beside a foreground placement) fails closed.
 * @param {any} record @returns {boolean}
 */
export function validDetachedRescueRunnerJob(record) {
  return validDetachedRescueRunnerRecord(record) || validHistoricalDetachedRescueRunnerRecord(record);
}

/**
 * Whether one durable `rescueRunnerVersion` value names a detached-runner
 * marker of a still-claimable format: the claim/lease/stop-fence duties
 * recognize the exact claim of either persisted format (both already passed
 * state validation), so an in-flight historical runner keeps its local
 * cleanup/termination semantics.
 * @param {unknown} value @returns {boolean}
 */
export function markedRescueRunnerVersion(value) {
  return value === RESCUE_RUNNER_HISTORICAL_VERSION || value === RESCUE_RUNNER_VERSION;
}

/** Serialized `rescueExecutionInput` envelope bound, measured as UTF-8 JSON text bytes. */
export const RESCUE_EXECUTION_INPUT_MAX_BYTES = 512 * 1024;

/** Optional `model` field bound, measured as UTF-8 bytes. */
export const RESCUE_EXECUTION_MODEL_MAX_BYTES = 4 * 1024;

/**
 * The existing closed effort enum. This leaf module owns the constant so the
 * codec and the StateStore can share it without an import cycle.
 */
export const EFFORT_LEVELS = Object.freeze(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);

/** The bounded Result command named by the queued acknowledgement. */
export const RESCUE_RESULT_COMMAND = '$zcode:result';

/** The bounded Status command named by the queued acknowledgement. */
export const RESCUE_STATUS_COMMAND = '$zcode:status';

const INPUT_KEY_SETS = Object.freeze([
  'task\0version',
  'model\0task\0version',
  'effort\0task\0version',
  'effort\0model\0task\0version',
]);
const KNOWN_INPUT_KEYS = Object.freeze(['effort', 'model', 'task', 'version']);

/**
 * Validate one private Rescue execution input and return a fresh closed copy.
 * The structure carries execution parameters only — never authorization — and
 * accepts exactly `version`, `task`, and optional `model`/`effort`. There is
 * no coercion, no unknown key, no array, no custom prototype, and the returned
 * copy never aliases caller objects. The own enumerable fields are snapshotted
 * once from their property descriptors before any validation, and own accessor
 * descriptors are rejected outright, so validation and the returned copy can
 * never observe two different values for the same field. The closed top-level
 * key set is decided before any field value is even read: every accepted field
 * is a primitive, so unknown or malformed shapes are rejected through the
 * bounded error without ever traversing caller-controlled nesting (a deeply
 * self-similar value can never overflow the validator stack). Bounds are
 * measured in UTF-8 bytes; the serialized JSON envelope is measured after
 * escaping. Errors name bounded fields only (unknown keys collapse to the
 * fixed token `unknown`) and never echo rejected values or caller-controlled
 * key text.
 * @param {unknown} value @returns {Record<string, string>}
 */
export function validateRescueExecutionInput(value) {
  const fields = snapshotPlainJsonFields(value);
  if (fields === null) throw invalidExecutionInput(['input']);
  const invalidFields = [];
  const keys = [...fields.keys()].sort().join('\0');
  if (!INPUT_KEY_SETS.includes(keys)) {
    if ([...fields.keys()].some((key) => !KNOWN_INPUT_KEYS.includes(key))) invalidFields.push('unknown');
    if (invalidFields.length === 0) invalidFields.push('shape');
    throw invalidExecutionInput(invalidFields);
  }
  const version = fields.get('version');
  const task = fields.get('task');
  const model = fields.get('model');
  const effort = fields.get('effort');
  if (version !== RESCUE_EXECUTION_INPUT_VERSION) invalidFields.push('version');
  if (!isBoundedTask(task)) invalidFields.push('task');
  if (model !== undefined && !isBoundedModel(model)) invalidFields.push('model');
  if (effort !== undefined && !EFFORT_LEVELS.includes(effort)) invalidFields.push('effort');
  if (invalidFields.length > 0) throw invalidExecutionInput(invalidFields);
  const validated = {
    version,
    task,
    ...(model === undefined ? {} : { model }),
    ...(effort === undefined ? {} : { effort }),
  };
  // The envelope copy holds only validated primitives, so serialization is
  // deterministic; the guard keeps any native serialization failure on the
  // bounded rejection path instead of leaking it to callers.
  let serialized;
  try {
    serialized = JSON.stringify(validated);
  } catch {
    throw invalidExecutionInput(['input']);
  }
  if (Buffer.byteLength(serialized) > RESCUE_EXECUTION_INPUT_MAX_BYTES) {
    throw invalidExecutionInput(['input']);
  }
  return validated;
}

/** The task keeps the existing nonblank Rescue preparation bound exactly. @param {unknown} value */
function isBoundedTask(value) {
  return typeof value === 'string' && value.trim().length > 0
    && Buffer.byteLength(value) <= RESCUE_TASK_MAX_BYTES;
}

/** The optional model follows the existing bounded plain-string model conventions. @param {unknown} value */
function isBoundedModel(value) {
  return typeof value === 'string' && value.trim().length > 0
    && Buffer.byteLength(value) <= RESCUE_EXECUTION_MODEL_MAX_BYTES
    && ![...value].some((character) => {
      const codePoint = character.charCodeAt(0);
      return codePoint <= 31 || codePoint >= 127 && codePoint <= 159;
    });
}

/** @param {string[]} invalidFields */
function invalidExecutionInput(invalidFields) {
  return new PluginError('RESCUE_EXECUTION_INPUT_INVALID', 'The private Rescue execution input is invalid.', {
    category: 'authorization',
    remedy: 'Provide one bounded Rescue task with optional validated model and effort.',
    details: { invalidFields },
  });
}

/**
 * Project the bounded public queued acknowledgement of one accepted true-
 * background Rescue reservation. It is a RESERVATION SNAPSHOT, not a current
 * Status read: a fast runner may already be running or terminal when the
 * response arrives, so the projection reads only the reserved identity fields
 * from the job record — never a spread — and reports the queued status the
 * reservation accepted. The closed shape carries no task, execution input,
 * binding, receipt, PID/lease, or ZCode session identifier, and it is not
 * registered in the historical background delivery-rollback machinery: a
 * delivery failure after the successful spawn leaves the accepted job intact
 * for Status/Result/PromptSubmit discovery.
 * @param {unknown} job @returns {{type:'background',job:{id:string,command:'rescue',status:'queued',createdAt:string},resultCommand:string,statusCommand:string}}
 */
export function queuedRescueAcknowledgement(job) {
  const invalidFields = [];
  if (typeof job !== 'object' || job === null || Array.isArray(job)) invalidFields.push('job');
  else {
    const record = /** @type {Record<string,unknown>} */ (job);
    if (typeof record.id !== 'string' || !/^[a-f0-9]{64}$/u.test(record.id)) invalidFields.push('id');
    if (typeof record.createdAt !== 'string' || Number.isNaN(Date.parse(record.createdAt))) invalidFields.push('createdAt');
  }
  if (invalidFields.length > 0) throw invalidQueuedJob(invalidFields);
  const record = /** @type {{id:string,createdAt:string}} */ (job);
  return {
    type: 'background',
    job: { id: record.id, command: 'rescue', status: 'queued', createdAt: record.createdAt },
    resultCommand: RESCUE_RESULT_COMMAND,
    statusCommand: RESCUE_STATUS_COMMAND,
  };
}

/** @param {string[]} invalidFields */
function invalidQueuedJob(invalidFields) {
  return new PluginError('RESCUE_QUEUED_RESPONSE_INVALID', 'The reserved Rescue job cannot be projected as a queued acknowledgement.', {
    category: 'state',
    remedy: 'Inspect the reserved job through Status and Result.',
    details: { invalidFields },
  });
}

/**
 * Snapshot the own enumerable string-keyed fields of one plain JSON object
 * exactly once, reading property descriptors only — never field values. Own
 * accessor descriptors are rejected, so a getter can never show validation one
 * value and the returned copy another; every later check reads only this
 * snapshot, and no caller-controlled value is traversed here.
 * @param {unknown} value @returns {Map<string, any>|null}
 */
function snapshotPlainJsonFields(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) return null;
  const fields = new Map();
  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined) return null;
    fields.set(key, descriptor.value);
  }
  return fields;
}
