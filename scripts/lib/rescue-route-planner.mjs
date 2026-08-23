import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';

import { resolveRoutedStoppedForwardingExecutor } from '../../hooks/lib/hook-state.mjs';
import { listCodexThreadSpawnChildren, sanitizeCodexThreadSpawnChild } from './codex-app-server.mjs';
import { PluginError } from './errors.mjs';
import { PERMISSION_MODES } from './identity.mjs';
import { createStateStore } from './state.mjs';

const BASE_TASK_NAME = 'zcode_rescue_task';
const BASE_AGENT_PATH = `/root/${BASE_TASK_NAME}`;
const MAX_CHILDREN = 1024;
const MAX_ORDINAL = 9999;
const MAX_DIRECTIVE_BYTES = 2048;
const TASK_NAME_PATTERN = /^zcode_rescue_[a-z][a-z0-9]{0,15}(?:_[a-z][a-z0-9]{0,15}){0,2}(?:_(?:[2-9]|[1-9][0-9]{1,3}))?$/u;
const AGENT_PATH_PATTERN = /^\/root\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/u;
const STOPPED_PROOF_KEYS = Object.freeze(['executionWorkspace', 'executor']);
const EXECUTOR_KEYS = Object.freeze(['active', 'agentId', 'agentType', 'childTurnId', 'createdAt', 'kind', 'originWorkspace', 'parentGenerationId', 'parentPermissionMode', 'parentSessionId', 'parentTurnId', 'workspace']);
const EXECUTOR_ERROR_CODES = new Set([
  'EXECUTOR_IDENTITY_AMBIGUOUS', 'EXECUTOR_IDENTITY_EXPIRED', 'EXECUTOR_IDENTITY_INVALID',
  'EXECUTOR_ROLE_UNAPPROVED', 'EXECUTOR_ROUTE_INVALID', 'EXECUTOR_STATE_MISMATCH',
]);

/**
 * Join complete Codex child discovery to private stopped-executor provenance
 * and return the only host action that may activate this preparation.
 * @param {any} input
 */
export async function planRescueActivation(input) {
  validatePlannerInput(input);
  const listChildren = input.listChildren ?? ((/** @type {string} */ parentId) => listCodexThreadSpawnChildren(parentId, input.appServerOptions));
  const resolveStoppedExecutor = input.resolveStoppedExecutor ?? resolveRoutedStoppedForwardingExecutor;
  const resolveBinding = input.resolveBinding ?? defaultBindingResolver(input.dataRoot);
  let executionWorkspace; let originWorkspace;
  try {
    [executionWorkspace, originWorkspace] = await Promise.all([
      realpath(input.caller.workspace),
      realpath(input.caller.originWorkspace ?? input.caller.workspace),
    ]);
  } catch { throw plannerError('EXECUTOR_ROUTE_INVALID'); }

  let children;
  try { children = await listChildren(input.caller.sessionId); }
  catch (error) {
    if (error instanceof PluginError && error.code === 'JOB_INTERRUPTED' && error.category === 'interruption') throw error;
    if (/** @type {any} */ (error)?.code === 'CODEX_CHILD_METADATA_INVALID') throw plannerError('CODEX_CHILD_METADATA_INVALID');
    throw plannerError('CODEX_CHILD_DISCOVERY_FAILED');
  }
  if (!Array.isArray(children) || children.length > MAX_CHILDREN) throw plannerError('CODEX_CHILD_DISCOVERY_FAILED');
  const hostChildren = validateChildren(children, input.caller.sessionId);
  const provenCandidates = []; const legacyCandidates = [];
  for (const host of hostChildren) {
    const hostClass = classifyHost(host);
    if (hostClass === 'occupancy') continue;
    let resolved;
    try { resolved = await resolveStoppedExecutor(input.dataRoot, host.cwd, host.id); }
    catch (error) {
      if (/** @type {any} */ (error)?.code === 'EXECUTOR_IDENTITY_NOT_FOUND') {
        if (hostClass === 'generic') continue;
        if (host.status.type !== 'notLoaded') throw plannerError('EXECUTOR_STATE_MISMATCH');
        const binding = await resolveExactBinding(resolveBinding, { caller: input.caller, envelope: input.envelope, host, executionWorkspace });
        if (binding.kind === 'missing') legacyCandidates.push({ binding: null, host });
        else legacyCandidates.push({ binding: validateLegacyBinding(binding.binding, host), host });
        continue;
      }
      throw sanitizeExecutorError(error);
    }
    const candidate = validateCandidate(resolved, host, input.caller, originWorkspace, executionWorkspace);
    provenCandidates.push(candidate);
  }

  const resume = input.envelope.options?.resume === 'resume';
  let selected = null;
  if (resume) {
    const bound = [];
    for (const candidate of provenCandidates) {
      const binding = await resolveExactBinding(resolveBinding, { caller: input.caller, envelope: input.envelope, executor: candidate.executor, host: candidate.host, executionWorkspace });
      if (binding.kind === 'bound') bound.push(candidate);
    }
    for (const candidate of legacyCandidates) if (candidate.binding !== null) bound.push(candidate);
    if (bound.length > 1) throw plannerError('RESCUE_CHILD_AMBIGUOUS');
    selected = bound[0] ?? null;
    if (selected === null) {
      const unboundLegacy = legacyCandidates.filter((candidate) => candidate.binding === null);
      if (unboundLegacy.length > 1) throw plannerError('RESCUE_CHILD_AMBIGUOUS');
      selected = unboundLegacy[0] ?? null;
    }
  } else if (provenCandidates.length > 0) {
    selected = preferredCandidate(provenCandidates);
  } else if (legacyCandidates.length > 0) {
    selected = preferredCandidate(legacyCandidates);
  }

  if (selected !== null) {
    const activation = selected.executor
      ? { kind: 'reactivate', executorAgentId: selected.executor.agentId, agentPathDigest: pathDigest(selected.host.agentPath) }
      : selected.binding
        ? { kind: 'legacy-bound', childThreadId: selected.host.id, agentPathDigest: pathDigest(selected.host.agentPath), bindingKey: selected.binding.key }
        : { kind: 'legacy-adopt', childThreadId: selected.host.id, agentPathDigest: pathDigest(selected.host.agentPath) };
    const assignment = selected.executor?.agentType ?? 'zcode-rescue';
    return { activation, directive: validateRescueRouteDirective({ version: 2, action: 'followup', target: selected.host.agentPath, assignment }) };
  }
  const occupied = new Set(hostChildren.map((host) => host.agentPath));
  const taskName = allocateTaskName(occupied);
  const agentPath = `/root/${taskName}`;
  const activation = { kind: 'spawn', taskName, agentPathDigest: pathDigest(agentPath) };
  return { activation, directive: validateRescueRouteDirective({ version: 1, action: 'spawn', taskName }) };
}

/** @param {unknown} value */
export function validateRescueRouteDirective(value) {
  if (!plain(value)) throw plannerError('RESCUE_ROUTE_INVALID');
  const object = /** @type {Record<string,any>} */ (value);
  let directive;
  if (object.version === 2 && object.action === 'followup' && sameKeys(object, ['action', 'assignment', 'target', 'version'])
    && validAgentPath(object.target) && ['zcode-rescue', 'default'].includes(object.assignment)) {
    directive = { version: 2, action: 'followup', target: object.target, assignment: object.assignment };
  } else if (object.version === 1 && object.action === 'spawn' && sameKeys(object, ['action', 'taskName', 'version']) && validTaskName(object.taskName)) {
    directive = { version: 1, action: 'spawn', taskName: object.taskName };
  } else throw plannerError('RESCUE_ROUTE_INVALID');
  if (Buffer.byteLength(JSON.stringify(directive)) > MAX_DIRECTIVE_BYTES) throw plannerError('RESCUE_ROUTE_INVALID');
  return directive;
}

/** @param {any} input */
function validatePlannerInput(input) {
  const caller = input?.caller;
  if (!plain(input) || typeof input.dataRoot !== 'string' || input.dataRoot.length === 0 || !plain(caller)
    || !safeId(caller.sessionId) || !safeId(caller.turnId) || typeof caller.workspace !== 'string' || caller.workspace.length === 0
    || caller.originWorkspace !== undefined && (typeof caller.originWorkspace !== 'string' || caller.originWorkspace.length === 0)
    || !PERMISSION_MODES.includes(caller.permissionMode) || !plain(input.envelope) || !plain(input.envelope.options)
    || input.envelope.options.resume !== undefined && !['fresh', 'resume'].includes(input.envelope.options.resume)
    || input.listChildren !== undefined && typeof input.listChildren !== 'function'
    || input.resolveStoppedExecutor !== undefined && typeof input.resolveStoppedExecutor !== 'function'
    || input.resolveBinding !== undefined && typeof input.resolveBinding !== 'function'
    || input.appServerOptions !== undefined && !plain(input.appServerOptions)) throw plannerError('RESCUE_ROUTE_INVALID');
}

/** @param {any[]} children @param {string} parentId */
function validateChildren(children, parentId) {
  const ids = new Set(); const paths = new Set(); const result = [];
  for (const value of children) {
    let child;
    try { child = sanitizeCodexThreadSpawnChild(value, parentId); }
    catch { throw plannerError('CODEX_CHILD_METADATA_INVALID'); }
    if (ids.has(child.id) || paths.has(child.agentPath)) throw plannerError('RESCUE_CHILD_AMBIGUOUS');
    ids.add(child.id); paths.add(child.agentPath); result.push(child);
  }
  return result;
}

/** @param {any} host */
function classifyHost(host) {
  if (!directManagedPath(host.agentPath)) return 'occupancy';
  if (host.agentRole === 'zcode-rescue') return 'named';
  if (host.agentRole === null) return 'generic';
  return 'occupancy';
}

/** @param {any[]} candidates */
function preferredCandidate(candidates) {
  return candidates.find((candidate) => candidate.host.agentPath === BASE_AGENT_PATH) ?? [...candidates].sort(compareNewest)[0];
}

/** @param {Function} resolveBinding @param {any} input */
async function resolveExactBinding(resolveBinding, input) {
  let binding;
  try { binding = await resolveBinding(input); }
  catch { throw plannerError('RESCUE_BINDING_INVALID'); }
  if (!binding || !['missing', 'bound'].includes(binding.kind)
    || binding.kind === 'missing' && !sameKeys(binding, ['kind'])
    || binding.kind === 'bound' && !plain(binding.binding)) throw plannerError('RESCUE_BINDING_INVALID');
  return binding;
}

/** @param {any} binding @param {any} host */
function validateLegacyBinding(binding, host) {
  if (!plain(binding) || !digest(binding.key) || !plain(binding.childAuthority)
    || binding.childAuthority.kind !== 'codex-legacy-adoption' || binding.childAuthority.childAgentId !== host.id) {
    throw plannerError('RESCUE_BINDING_INVALID');
  }
  return binding;
}

/** @param {any} resolved @param {any} host @param {any} caller @param {string} originWorkspace @param {string} executionWorkspace */
function validateCandidate(resolved, host, caller, originWorkspace, executionWorkspace) {
  const found = resolved?.executor;
  if (!plain(resolved) || !sameKeys(resolved, STOPPED_PROOF_KEYS) || !validStoppedExecutor(found)) throw plannerError('EXECUTOR_IDENTITY_INVALID');
  if (resolved.executionWorkspace !== executionWorkspace || found.workspace !== executionWorkspace
    || found.originWorkspace !== originWorkspace || host.cwd !== originWorkspace || found.agentId !== host.id
    || found.parentSessionId !== caller.sessionId || found.parentPermissionMode !== caller.permissionMode) {
    throw plannerError(resolved?.executionWorkspace !== executionWorkspace || found?.workspace !== executionWorkspace
      || found?.originWorkspace !== originWorkspace || host.cwd !== originWorkspace ? 'EXECUTOR_ROUTE_INVALID' : 'EXECUTOR_IDENTITY_INVALID');
  }
  const roleMatches = found.agentType === 'zcode-rescue' && host.agentRole === 'zcode-rescue'
    || found.agentType === 'default' && host.agentRole === null;
  if (!roleMatches) throw plannerError('EXECUTOR_ROLE_UNAPPROVED');
  return { executor: { ...found }, host };
}

/** @param {string} dataRoot */
function defaultBindingResolver(dataRoot) {
  const store = createStateStore({ dataRoot });
  return (/** @type {any} */ { caller, executor, host, executionWorkspace }) => store.resolveRescueBindingForResume({
    workspace: executionWorkspace,
    parentSessionId: caller.sessionId,
    executorAgentId: executor?.agentId ?? host.id,
    ...(executor ? {
      executorAgentType: executor.agentType,
      executorParentTurnId: executor.parentTurnId,
      executorParentPermissionMode: executor.parentPermissionMode,
    } : {}),
    permissionMode: caller.permissionMode,
  });
}

/** @param {Set<string>} occupied */
function allocateTaskName(occupied) {
  if (!occupied.has(BASE_AGENT_PATH)) return BASE_TASK_NAME;
  for (let ordinal = 2; ordinal <= MAX_ORDINAL; ordinal += 1) {
    const taskName = `${BASE_TASK_NAME}_${ordinal}`;
    if (!occupied.has(`/root/${taskName}`)) return taskName;
  }
  throw plannerError('RESCUE_CHILD_AMBIGUOUS');
}

/** @param {any} left @param {any} right */
function compareNewest(left, right) { return right.host.createdAt - left.host.createdAt || right.host.id.localeCompare(left.host.id); }
/** @param {string} value */
function pathDigest(value) { return createHash('sha256').update(value).digest('hex'); }
/** @param {unknown} value */
function plain(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
/** @param {Record<string,unknown>} value @param {readonly string[]} keys */
function sameKeys(value, keys) { return Object.keys(value).sort().join('\0') === [...keys].sort().join('\0'); }
/** @param {unknown} value */
function safeId(value, maxBytes = 4096) {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= maxBytes
    && [...value].every((character) => character.charCodeAt(0) > 31 && character.charCodeAt(0) !== 127);
}
/** @param {unknown} value */
function boundedIdentifier(value) { return safeId(value, 512); }
/** @param {unknown} value */
function validAgentPath(value) { return typeof value === 'string' && Buffer.byteLength(value) <= 1024 && AGENT_PATH_PATTERN.test(value); }
/** @param {unknown} value */
function validTaskName(value) { return typeof value === 'string' && Buffer.byteLength(value) <= 64 && TASK_NAME_PATTERN.test(value); }
/** @param {unknown} value */
function directManagedPath(value) { return typeof value === 'string' && value.startsWith('/root/') && validTaskName(value.slice('/root/'.length)); }
/** @param {unknown} value */
function digest(value) { return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value); }
/** @param {unknown} value */
function boundedWorkspace(value) {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 4096
    && ![...value].some((character) => ['\0', '\n', '\r'].includes(character));
}
/** @param {unknown} value */
function canonicalTimestamp(value) { return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) && Number.isFinite(Date.parse(value)); }
/** @param {unknown} value */
function validStoppedExecutor(value) {
  if (!plain(value)) return false;
  const executor = /** @type {Record<string,any>} */ (value);
  return sameKeys(executor, EXECUTOR_KEYS) && executor.kind === 'subagent-executor' && executor.active === false
    && [executor.agentId, executor.agentType, executor.parentSessionId, executor.parentTurnId, executor.childTurnId].every(boundedIdentifier)
    && (executor.parentGenerationId === null || typeof executor.parentGenerationId === 'string' && /^[a-f0-9]{64}$/u.test(executor.parentGenerationId))
    && PERMISSION_MODES.includes(executor.parentPermissionMode) && boundedWorkspace(executor.originWorkspace) && boundedWorkspace(executor.workspace)
    && canonicalTimestamp(executor.createdAt);
}

/** @param {any} error */
function sanitizeExecutorError(error) { return plannerError(EXECUTOR_ERROR_CODES.has(error?.code) ? error.code : 'EXECUTOR_ROUTE_INVALID'); }
/** @param {string} code */
function plannerError(code) {
  /** @type {Record<string,[string,string,string]>} */ const errors = {
    CODEX_CHILD_DISCOVERY_FAILED: ['Codex persisted child discovery failed.', 'Restart or upgrade Codex, then retry the Rescue request.', 'runtime'],
    CODEX_CHILD_METADATA_INVALID: ['Codex returned invalid persisted child metadata.', 'Restart or upgrade Codex, then retry the Rescue request.', 'protocol'],
    RESCUE_CHILD_AMBIGUOUS: ['The persisted Rescue child route is ambiguous.', 'Resolve the conflicting child state before retrying Rescue.', 'authorization'],
    RESCUE_ROUTE_INVALID: ['The Rescue route directive is invalid.', 'Prepare the Rescue request again.', 'validation'],
    RESCUE_BINDING_INVALID: ['The private Rescue operation binding is invalid.', 'Start a fresh Rescue operation from the active parent turn.', 'authorization'],
    EXECUTOR_ROLE_UNAPPROVED: ['The persisted child Role is not approved for Rescue.', 'Use the installed Rescue Role or its qualified compatibility route.', 'authorization'],
    EXECUTOR_STATE_MISMATCH: ['The persisted Rescue executor is not stopped.', 'Wait for the existing Rescue child before preparing another route.', 'authorization'],
    EXECUTOR_IDENTITY_AMBIGUOUS: ['The private Rescue executor identity is ambiguous.', 'Resolve the conflicting executor state before retrying Rescue.', 'authorization'],
    EXECUTOR_IDENTITY_EXPIRED: ['The private Rescue executor identity is unavailable.', 'Prepare the Rescue request again.', 'authorization'],
    EXECUTOR_IDENTITY_INVALID: ['The private Rescue executor identity is invalid.', 'Prepare the Rescue request again.', 'authorization'],
    EXECUTOR_ROUTE_INVALID: ['The private Rescue executor route is invalid.', 'Prepare the Rescue request again.', 'authorization'],
  };
  const [message, remedy, category] = errors[code] ?? errors.EXECUTOR_ROUTE_INVALID;
  return new PluginError(code, message, { category, remedy });
}
