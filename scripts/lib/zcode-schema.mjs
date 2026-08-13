// ZCode CLI 0.16.1 response contracts, transcribed from the bundled Zod schemas
// in /Applications/ZCode.app/Contents/Resources/glm/zcode.cjs (`--version` = 0.16.1):
// Kne (snapshot), ZNe (session), XHt (settings), GNe/UXn/LXn/BXn (messages),
// VNe (parts), nto (projection), and cHt (runtime) in glm/zcode.cjs.

import { isSafeIdentifier } from './identifier.mjs';

const MODES = ['plan', 'build', 'edit', 'yolo', 'auto'];
const STATUSES = ['idle', 'running', 'waiting', 'paused', 'completed', 'error'];
const SESSION_KINDS = ['interactive', 'fork', 'selection_side_chat', 'workflow_parent', 'workflow_child', 'subagent_child', 'nested_workflow_child'];
const TITLE_SOURCES = ['default', 'first_input', 'generated', 'custom'];
const MESSAGE_SOURCES = ['background_task', 'fork', 'goal_state_change', 'goal-continuation', 'rewind', 'selection_side_chat', 'subagent', 'subagent_message', 'todo_reminder'];
const MESSAGE_VISIBILITY = ['user-visible', 'model-only'];

/** @param {unknown} value @returns {value is Record<string,any>} */
export function plainObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
/** @param {unknown} value */
function text(value) { return typeof value === 'string' && value.trim().length > 0; }
/** @param {unknown} value */
function string(value) { return typeof value === 'string'; }
/** @param {unknown} value */
function uint(value) { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }
/** @param {unknown} value */
function positiveInt(value) { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0; }
/** @param {unknown} value */
function nonnegativeNumber(value) { return typeof value === 'number' && Number.isFinite(value) && value >= 0; }
/** @param {unknown} value @param {string[]} required @param {string[]} optional */
function exact(value, required, optional = []) { void optional; return plainObject(value) && required.every((key) => Object.hasOwn(value, key)); }
/** @param {unknown} value */
function record(value) { return plainObject(value); }
/** @param {unknown} value @param {(item:any)=>boolean} validator */
function arrayOf(value, validator) { return Array.isArray(value) && value.every(validator); }
/** @param {unknown} value @param {(item:any)=>boolean} validator */
function optional(value, validator) { return value === undefined || validator(value); }

/** vl */
export function validModelRef(/** @type {any} */ value) { return exact(value, ['providerId', 'modelId'], ['variant']) && text(value.providerId) && text(value.modelId) && optional(value.variant, text); }
/** vi */
function validWorkspace(/** @type {any} */ value) { return exact(value, ['workspacePath', 'workspaceKey'], ['workspaceIdentity', 'remoteSessionId']) && text(value.workspacePath) && text(value.workspaceKey) && optional(value.workspaceIdentity, text) && optional(value.remoteSessionId, text); }

/** qNe */
function validTarget(/** @type {any} */ value) { return exact(value, ['sessionId', 'targetId', 'objective', 'summaryTitle', 'status', 'tokenBudget', 'tokensUsed', 'timeUsedSeconds', 'createdAt', 'updatedAt'], ['activeInputId', 'activeRunStartedAtMs', 'activeRunLastSeenAtMs']) && isSafeIdentifier(value.sessionId) && text(value.targetId) && text(value.objective) && (value.summaryTitle === null || text(value.summaryTitle)) && ['active', 'paused', 'budget_limited', 'complete'].includes(value.status) && (value.tokenBudget === null || positiveInt(value.tokenBudget)) && uint(value.tokensUsed) && uint(value.timeUsedSeconds) && uint(value.createdAt) && uint(value.updatedAt) && optional(value.activeInputId, (item) => item === null || text(item)) && optional(value.activeRunStartedAtMs, (item) => item === null || uint(item)) && optional(value.activeRunLastSeenAtMs, (item) => item === null || uint(item)); }

/** ZNe */
export function validSessionInfo(/** @type {any} */ value) {
  if (!exact(value, ['sessionId', 'workspace', 'sessionKind', 'title', 'mode', 'status', 'createdAt', 'updatedAt'], ['parentSessionId', 'traceId', 'titleSource', 'model', 'target', 'archivedAt'])) return false;
  return isSafeIdentifier(value.sessionId) && validWorkspace(value.workspace) && SESSION_KINDS.includes(value.sessionKind) && string(value.title) && MODES.includes(value.mode) && STATUSES.includes(value.status) && uint(value.createdAt) && uint(value.updatedAt)
    && optional(value.parentSessionId, text) && optional(value.traceId, text) && optional(value.titleSource, (item) => TITLE_SOURCES.includes(item)) && optional(value.model, validModelRef)
    && optional(value.target, (item) => item === null || validTarget(item)) && optional(value.archivedAt, uint);
}

/** VHt */
function validThoughtLevel(/** @type {any} */ value) { return exact(value, ['value', 'label'], ['description']) && text(value.value) && text(value.label) && optional(value.description, string); }
/** GHt */
function validReasoning(/** @type {any} */ value) { return exact(value, ['enabled', 'levels'], ['defaultLevel', 'providerOptionsByLevel']) && typeof value.enabled === 'boolean' && arrayOf(value.levels, validThoughtLevel) && optional(value.defaultLevel, text) && optional(value.providerOptionsByLevel, (item) => record(item) && Object.entries(item).every(([key, entry]) => text(key) && record(entry))); }
/** WHt */
function validCatalogEntry(/** @type {any} */ value) {
  const optionalKeys = ['providerLabel', 'providerSource', 'providerLogoUrl', 'description', 'contextWindow', 'maxOutputTokens', 'reasoning', 'supportsImages', 'supportsPdf', 'supportsTools', 'supportsStructuredOutput', 'disabledReason'];
  if (!exact(value, ['ref', 'label'], optionalKeys) || !validModelRef(value.ref) || !text(value.label)) return false;
  if (!['providerLabel', 'providerLogoUrl'].every((key) => optional(value[key], text)) || !['providerSource', 'description', 'disabledReason'].every((key) => optional(value[key], string))) return false;
  if (!['contextWindow', 'maxOutputTokens'].every((key) => optional(value[key], positiveInt)) || !optional(value.reasoning, validReasoning)) return false;
  return ['supportsImages', 'supportsPdf', 'supportsTools', 'supportsStructuredOutput'].every((key) => optional(value[key], (item) => typeof item === 'boolean'));
}
/** XHt */
function validSettings(/** @type {any} */ value) {
  if (!exact(value, ['model', 'thoughtLevel', 'mode'], ['appliedProviderRevision', 'permission']) || !optional(value.appliedProviderRevision, text)) return false;
  const model = value.model; const thought = value.thoughtLevel;
  return exact(model, ['current', 'available'], ['lastUsed']) && validModelRef(model.current) && arrayOf(model.available, validCatalogEntry) && optional(model.lastUsed, validModelRef)
    && exact(thought, ['enabled', 'available'], ['current', 'defaultLevel']) && typeof thought.enabled === 'boolean' && optional(thought.current, text) && optional(thought.defaultLevel, text) && arrayOf(thought.available, validThoughtLevel)
    && exact(value.mode, ['current']) && MODES.includes(value.mode.current)
    && optional(value.permission, (item) => exact(item, [], ['mode', 'rulesRevision']) && optional(item.mode, (mode) => MODES.includes(mode)) && optional(item.rulesRevision, uint));
}

function validTime(/** @type {any} */ value) { return exact(value, ['created'], ['completed']) && uint(value.created) && optional(value.completed, uint); }
function validTokens(/** @type {any} */ value) { return exact(value, ['input', 'output', 'reasoning', 'cache'], ['total']) && optional(value.total, uint) && uint(value.input) && uint(value.output) && uint(value.reasoning) && exact(value.cache, ['read', 'write']) && uint(value.cache.read) && uint(value.cache.write); }
function validSemantics(/** @type {any} */ value) { return exact(value, ['origin', 'kind', 'uiVisibility', 'providerVisibility', 'transcriptVisibility'], ['source', 'commandName']) && ['real_user', 'agent_runtime', 'system', 'migration'].includes(value.origin) && ['user_prompt', 'slash_command', 'system_reminder', 'background_notification', 'subagent_notification', 'todo_reminder', 'rewind_notice', 'fork_notice', 'timeline_event', 'compact_summary', 'assistant_response'].includes(value.kind) && optional(value.source, string) && optional(value.commandName, string) && ['visible', 'hidden', 'debug'].includes(value.uiVisibility) && ['visible', 'hidden'].includes(value.providerVisibility) && ['visible', 'hidden'].includes(value.transcriptVisibility); }
/** LXn/BXn */
function validMessageInfo(/** @type {any} */ value) {
  if (!plainObject(value) || !validTime(value.time) || !validModelRef(value.model)) return false;
  if (value.role === 'user') return exact(value, ['messageId', 'sessionId', 'role', 'time', 'agent', 'model'], ['system', 'tools', 'synthetic', 'source', 'visibility', 'semantics', 'metadata']) && text(value.messageId) && isSafeIdentifier(value.sessionId) && text(value.agent) && optional(value.system, string) && optional(value.tools, (item) => record(item) && Object.values(item).every((entry) => typeof entry === 'boolean')) && optional(value.synthetic, (item) => typeof item === 'boolean') && optional(value.source, (item) => MESSAGE_SOURCES.includes(item)) && optional(value.visibility, (item) => MESSAGE_VISIBILITY.includes(item)) && optional(value.semantics, validSemantics) && optional(value.metadata, record);
  return value.role === 'assistant' && exact(value, ['messageId', 'sessionId', 'role', 'time', 'parentMessageId', 'agent', 'model', 'path', 'cost', 'tokens'], ['finish', 'error', 'semantics', 'structured']) && text(value.messageId) && isSafeIdentifier(value.sessionId) && text(value.parentMessageId) && text(value.agent) && exact(value.path, ['cwd', 'root']) && text(value.path.cwd) && text(value.path.root) && nonnegativeNumber(value.cost) && validTokens(value.tokens) && optional(value.finish, string) && optional(value.error, record) && optional(value.semantics, validSemantics);
}

function validToolState(/** @type {any} */ value) {
  if (!plainObject(value) || !['pending', 'running', 'completed', 'error'].includes(value.status)) return false;
  if (value.status === 'pending') return exact(value, ['status', 'input', 'raw']) && record(value.input) && string(value.raw);
  if (value.status === 'running') return exact(value, ['status', 'input', 'startedAt'], ['title', 'metadata']) && record(value.input) && uint(value.startedAt) && optional(value.title, string) && optional(value.metadata, record);
  if (value.status === 'completed') return exact(value, ['status', 'input', 'output', 'title', 'metadata', 'startedAt', 'completedAt']) && record(value.input) && string(value.output) && string(value.title) && record(value.metadata) && uint(value.startedAt) && uint(value.completedAt);
  return exact(value, ['status', 'input', 'error', 'startedAt', 'completedAt'], ['metadata']) && record(value.input) && string(value.error) && uint(value.startedAt) && uint(value.completedAt) && optional(value.metadata, record);
}
function basePart(/** @type {any} */ value, /** @type {string[]} */ required, /** @type {string[]} */ optionalKeys = []) { return exact(value, ['partId', 'sessionId', 'messageId', 'type', ...required], optionalKeys) && text(value.partId) && isSafeIdentifier(value.sessionId) && text(value.messageId); }
/** VNe */
function validPart(/** @type {any} */ value) {
  if (!plainObject(value)) return false;
  if (value.type === 'text') return basePart(value, ['text'], ['synthetic', 'ignored', 'metadata']) && string(value.text) && optional(value.synthetic, (item) => typeof item === 'boolean') && optional(value.ignored, (item) => typeof item === 'boolean') && optional(value.metadata, record);
  if (value.type === 'reasoning') return basePart(value, ['text'], ['metadata']) && string(value.text) && optional(value.metadata, record);
  if (value.type === 'file') return basePart(value, ['mime', 'url'], ['filename', 'metadata']) && text(value.mime) && text(value.url) && optional(value.filename, string) && optional(value.metadata, record);
  if (value.type === 'tool') return basePart(value, ['callId', 'tool', 'state'], ['metadata']) && text(value.callId) && text(value.tool) && validToolState(value.state) && optional(value.metadata, record);
  if (value.type === 'step-start') return basePart(value, [], ['snapshot']) && optional(value.snapshot, string);
  if (value.type === 'step-finish') return basePart(value, ['reason', 'cost', 'tokens'], ['snapshot']) && string(value.reason) && optional(value.snapshot, string) && nonnegativeNumber(value.cost) && validTokens(value.tokens);
  if (value.type === 'snapshot') return basePart(value, ['snapshot']) && string(value.snapshot);
  if (value.type === 'patch') return basePart(value, ['hash', 'files']) && text(value.hash) && arrayOf(value.files, string);
  if (value.type === 'compaction') return basePart(value, ['auto'], ['reason', 'summaryMessageId', 'metadata']) && typeof value.auto === 'boolean' && optional(value.reason, string) && optional(value.summaryMessageId, text) && optional(value.metadata, record);
  if (value.type === 'subagent') return basePart(value, ['prompt', 'description', 'agent'], ['model', 'command']) && string(value.prompt) && string(value.description) && text(value.agent) && optional(value.model, validModelRef) && optional(value.command, string);
  if (value.type === 'agent') return basePart(value, ['name']) && text(value.name);
  if (value.type === 'retry') return basePart(value, ['attempt', 'error']) && uint(value.attempt) && record(value.error);
  if (value.type === 'timeline') return validTimelinePart(value);
  return false;
}
function validTimelinePart(/** @type {any} */ value) {
  const optionalKeys = ['status', 'anchorMessageId', 'anchorTurnId', 'time', 'operationId', 'trigger', 'phase', 'compactReason', 'boundaryId', 'summaryMessageId', 'preCompactTokenCount', 'postCompactTokenCount', 'truePostCompactTokenCount', 'attempt', 'maxAttempts', 'reason', 'targetId', 'verificationId', 'goalIteration', 'verification', 'parentSessionId', 'targetMessageId', 'targetCheckpointId', 'restoredFileCount', 'fromModel', 'toModel'];
  if (!basePart(value, ['timelineType', 'display'], optionalKeys) || !['context_compaction', 'goal_verification', 'session_fork', 'model_change'].includes(value.timelineType) || !['separator', 'worklog'].includes(value.display)) return false;
  if (!['status', 'operationId', 'compactReason', 'boundaryId', 'summaryMessageId', 'reason', 'targetId', 'verificationId', 'parentSessionId', 'targetMessageId', 'targetCheckpointId'].every((key) => optional(value[key], string))) return false;
  if (!['preCompactTokenCount', 'postCompactTokenCount', 'truePostCompactTokenCount', 'attempt', 'maxAttempts', 'goalIteration', 'restoredFileCount'].every((key) => optional(value[key], uint))) return false;
  return optional(value.anchorMessageId, text) && optional(value.anchorTurnId, text) && optional(value.summaryMessageId, text) && optional(value.parentSessionId, text) && optional(value.targetMessageId, text)
    && optional(value.trigger, (item) => ['manual', 'auto', 'partial', 'reactive', 'session_memory'].includes(item)) && optional(value.phase, (item) => ['standalone_turn', 'pre_request', 'mid_turn', 'reactive'].includes(item))
    && optional(value.time, (item) => exact(item, [], ['start', 'end']) && optional(item.start, uint) && optional(item.end, uint)) && optional(value.verification, validVerification)
    && optional(value.fromModel, (item) => exact(item, ['providerId', 'modelId'], ['variant', 'label']) && validModelRef({ providerId: item.providerId, modelId: item.modelId, ...(item.variant === undefined ? {} : { variant: item.variant }) }) && optional(item.label, string))
    && optional(value.toModel, (item) => exact(item, ['providerId', 'modelId', 'label'], ['variant']) && validModelRef({ providerId: item.providerId, modelId: item.modelId, ...(item.variant === undefined ? {} : { variant: item.variant }) }) && text(item.label));
}
/** GNe */
function validMessage(/** @type {any} */ value) { return exact(value, ['info', 'parts']) && validMessageInfo(value.info) && arrayOf(value.parts, validPart); }

function validPermissionResponse(/** @type {any} */ value) { return exact(value, ['decision'], ['reason', 'modifiedInput', 'permissionUpdates']) && ['allow', 'deny', 'escalate', 'modify'].includes(value.decision) && optional(value.reason, string) && optional(value.permissionUpdates, (items) => arrayOf(items, (item) => exact(item, ['type', 'behavior', 'rules']) && item.type === 'addRules' && ['allow', 'deny', 'ask'].includes(item.behavior) && arrayOf(item.rules, (rule) => exact(rule, ['toolName'], ['ruleContent']) && text(rule.toolName) && optional(rule.ruleContent, string)) && item.rules.length > 0)); }
function validOrigin(/** @type {any} */ value) { return exact(value, ['kind', 'agentId', 'agentType', 'childSessionId', 'parentSessionId'], ['childTurnId', 'description', 'parentToolCallId', 'parentTurnId']) && value.kind === 'subagent' && ['agentId', 'agentType', 'childSessionId', 'parentSessionId'].every((key) => text(value[key])) && optional(value.childTurnId, text) && optional(value.description, string) && optional(value.parentToolCallId, text) && optional(value.parentTurnId, text); }
function validPermissionRequest(/** @type {any} */ value) { return exact(value, ['requestId', 'toolCallId', 'toolName', 'reason', 'riskLevel', 'options', 'requestedAt'], ['input', 'origin']) && text(value.requestId) && text(value.toolCallId) && text(value.toolName) && string(value.reason) && ['low', 'medium', 'high', 'critical'].includes(value.riskLevel) && optional(value.origin, validOrigin) && arrayOf(value.options, (item) => exact(item, ['optionId', 'kind', 'name', 'response'], ['description']) && text(item.optionId) && text(item.kind) && text(item.name) && optional(item.description, string) && validPermissionResponse(item.response)) && value.options.length > 0 && uint(value.requestedAt); }
/** nto */
function validProjection(/** @type {any} */ value) { return exact(value, ['sessionId', 'status', 'mode', 'turnCount', 'totalTokenCount', 'contextUsed', 'contextWindow', 'pendingPermissions', 'activeToolCalls', 'backgroundJobs'], ['currentTurnId', 'target', 'lastError']) && isSafeIdentifier(value.sessionId) && STATUSES.includes(value.status) && MODES.includes(value.mode) && ['turnCount', 'totalTokenCount', 'contextUsed', 'contextWindow'].every((key) => uint(value[key])) && optional(value.currentTurnId, text) && arrayOf(value.pendingPermissions, validPermissionRequest) && arrayOf(value.activeToolCalls, (item) => exact(item, ['toolCallId', 'toolName', 'status'], ['startedAt']) && text(item.toolCallId) && text(item.toolName) && ['pending', 'running', 'completed', 'failed', 'denied'].includes(item.status) && optional(item.startedAt, uint)) && arrayOf(value.backgroundJobs, record) && optional(value.target, (item) => item === null || validTarget(item)) && optional(value.lastError, (item) => exact(item, ['type', 'message'], ['code', 'detail']) && text(item.type) && text(item.message) && optional(item.code, text) && optional(item.detail, string)); }
/** cHt */
function validRuntime(/** @type {any} */ value) { return exact(value, ['eventSeq', 'stateRevision', 'pendingRequestIds'], ['deliveryKind', 'activeTurnId', 'activeTurnKind', 'apiRetry', 'contextUsage', 'goalVerifications', 'goalVerificationTimeline']) && uint(value.eventSeq) && uint(value.stateRevision) && optional(value.deliveryKind, (item) => ['desktop-continuous', 'web-remote-replayable'].includes(item)) && optional(value.activeTurnId, text) && optional(value.activeTurnKind, (item) => ['regular', 'compact', 'rewind'].includes(item)) && arrayOf(value.pendingRequestIds, text) && optional(value.apiRetry, (item) => item === null || validApiRetry(item)) && optional(value.contextUsage, validContextUsage) && optional(value.goalVerifications, (items) => arrayOf(items, validVerification)) && optional(value.goalVerificationTimeline, (items) => arrayOf(items, validVerificationTimeline)); }
function validApiRetry(/** @type {any} */ value) { return exact(value, ['kind', 'attempt', 'maxRetries', 'retryDelayMs', 'errorStatus', 'error']) && value.kind === 'api_retry' && positiveInt(value.attempt) && uint(value.maxRetries) && uint(value.retryDelayMs) && (value.errorStatus === null || uint(value.errorStatus)) && string(value.error); }
function validVerification(/** @type {any} */ value) { return exact(value, ['passed', 'reason'], ['nextAction']) && typeof value.passed === 'boolean' && string(value.reason) && optional(value.nextAction, (item) => item === null || string(item)); }
function validCacheUsage(/** @type {any} */ value) { return exact(value, ['inputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'hitRate'], ['latestHitRate', 'hitRateRequestCount', 'totalInputTokens', 'totalCacheReadTokens', 'totalCacheWriteTokens']) && uint(value.inputTokens) && uint(value.cacheReadTokens) && uint(value.cacheWriteTokens) && (value.hitRate === null || nonnegativeNumber(value.hitRate)) && optional(value.latestHitRate, (item) => item === null || nonnegativeNumber(item)) && ['hitRateRequestCount', 'totalInputTokens', 'totalCacheReadTokens', 'totalCacheWriteTokens'].every((key) => optional(value[key], uint)); }
function validContextUsage(/** @type {any} */ value) { return exact(value, ['used', 'size'], ['cost', 'cache', 'breakdown']) && uint(value.used) && positiveInt(value.size) && optional(value.cost, (item) => item === null || exact(item, ['amount', 'currency']) && nonnegativeNumber(item.amount) && text(item.currency)) && optional(value.cache, validCacheUsage) && optional(value.breakdown, (items) => arrayOf(items, (item) => exact(item, ['source', 'chars']) && ['system_prompt', 'meta_user_context', 'skills', 'tool_prompt', 'system_tool_schemas', 'mcp_tool_schemas', 'messages'].includes(item.source) && uint(item.chars))); }
function validVerificationTimeline(/** @type {any} */ value) { return exact(value, ['version', 'kind', 'type', 'display', 'targetId', 'verificationId', 'status'], ['verification', 'goalIteration', 'anchorAssistantMessageId', 'anchorTurnId', 'startedAt', 'updatedAt']) && value.version === 1 && value.kind === 'synthetic' && value.type === 'goal_verification' && value.display === 'separator' && text(value.targetId) && text(value.verificationId) && ['started', 'completed', 'failed_closed', 'cancelled'].includes(value.status) && optional(value.verification, validVerification) && optional(value.goalIteration, positiveInt) && optional(value.anchorAssistantMessageId, text) && optional(value.anchorTurnId, text) && optional(value.startedAt, uint) && optional(value.updatedAt, uint); }

function validGoalStats(/** @type {any} */ value) { return exact(value, ['timeUsedSeconds', 'tokensUsed', 'tokenBudget', 'contextUsed', 'contextWindow', 'toolCallCount', 'iterationCount']) && uint(value.timeUsedSeconds) && uint(value.tokensUsed) && (value.tokenBudget === null || positiveInt(value.tokenBudget)) && uint(value.contextUsed) && uint(value.contextWindow) && uint(value.toolCallCount) && uint(value.iterationCount); }
function validTodo(/** @type {any} */ value) { return exact(value, ['content', 'status', 'priority']) && text(value.content) && ['pending', 'in_progress', 'completed'].includes(value.status) && ['high', 'medium', 'low'].includes(value.priority); }
function validTodoGroup(/** @type {any} */ value) { return exact(value, ['id', 'source', 'todos'], ['goalIteration', 'targetId', 'startedAt', 'updatedAt']) && text(value.id) && ['goal_iteration', 'session'].includes(value.source) && optional(value.goalIteration, positiveInt) && optional(value.targetId, text) && optional(value.startedAt, uint) && optional(value.updatedAt, uint) && arrayOf(value.todos, validTodo); }
function validSlashCommand(/** @type {any} */ value) { return exact(value, ['name', 'description'], ['inputHint', 'source']) && text(value.name) && string(value.description) && optional(value.inputHint, string) && optional(value.source, (item) => ['builtin', 'custom'].includes(item)); }

/** @param {any} value @param {string} sessionId @param {string} workspacePath */
function validSnapshotRelations(value, sessionId, workspacePath) {
  return text(workspacePath) && value.session.workspace.workspacePath === workspacePath && value.session.workspace.workspaceKey === workspacePath
    && value.session.sessionId === sessionId
    && (value.session.target === undefined || value.session.target === null || value.session.target.sessionId === sessionId)
    && value.projection.sessionId === sessionId
    && (value.projection.target === undefined || value.projection.target === null || value.projection.target.sessionId === sessionId)
    && value.messages.every((/** @type {any} */ message) => message.info.sessionId === sessionId && message.parts.every((/** @type {any} */ part) => part.sessionId === sessionId && part.messageId === message.info.messageId));
}

/** Validate a complete runtime snapshot with strict session identity relations. */
function validSnapshotEnvelope(/** @type {any} */ value) {
  return exact(value, ['protocol', 'session', 'settings', 'projection', 'runtime', 'messages'], ['goalStats', 'todos', 'todoGroups', 'slashCommands'])
    && exact(value.protocol, ['name', 'version']) && value.protocol.name === 'ZCode Protocol' && value.protocol.version === 1
    && validSessionInfo(value.session) && validSettings(value.settings) && validProjection(value.projection) && validRuntime(value.runtime) && arrayOf(value.messages, validMessage)
    && optional(value.goalStats, validGoalStats) && optional(value.todos, (items) => arrayOf(items, validTodo)) && optional(value.todoGroups, (items) => arrayOf(items, validTodoGroup)) && optional(value.slashCommands, (items) => arrayOf(items, validSlashCommand));
}

export function validSnapshot(/** @type {any} */ value, /** @type {string} */ sessionId, /** @type {string} */ workspacePath) {
  return validSnapshotEnvelope(value) && validSnapshotRelations(value, sessionId, workspacePath);
}

/**
 * Compatibility validation for ZCode 0.16.1's initial empty projection.
 * The normal validSnapshot relation remains strict for reads and updates.
 * @param {any} value @param {string} sessionId @param {string} workspacePath
 */
function validEmptyCreateSnapshot(value, sessionId, workspacePath) {
  return validSnapshotEnvelope(value)
    && text(sessionId) && value.session.sessionId === sessionId
    && value.session.workspace.workspacePath === workspacePath && value.session.workspace.workspaceKey === workspacePath
    && value.session.status === 'idle'
    && value.projection.sessionId === 'unknown' && value.projection.status === 'idle'
    && (value.session.target === undefined || value.session.target === null)
    && (value.projection.target === undefined || value.projection.target === null)
    && value.projection.currentTurnId === undefined
    && value.projection.turnCount === 0 && value.projection.totalTokenCount === 0 && value.projection.contextUsed === 0
    && value.projection.pendingPermissions.length === 0 && value.projection.activeToolCalls.length === 0 && value.projection.backgroundJobs.length === 0
    && value.projection.lastError === undefined
    && value.runtime.eventSeq === 0 && value.runtime.stateRevision === 0
    && value.runtime.activeTurnId === undefined && value.runtime.activeTurnKind === undefined
    && value.runtime.pendingRequestIds.length === 0
    && (value.runtime.apiRetry === undefined || value.runtime.apiRetry === null)
    && value.runtime.contextUsage === undefined
    && (value.runtime.goalVerifications === undefined || value.runtime.goalVerifications.length === 0)
    && (value.runtime.goalVerificationTimeline === undefined || value.runtime.goalVerificationTimeline.length === 0)
    && value.messages.length === 0;
}

export function validCreateSnapshot(/** @type {any} */ value, /** @type {string} */ sessionId, /** @type {string} */ workspacePath) {
  return validSnapshot(value, sessionId, workspacePath) || validEmptyCreateSnapshot(value, sessionId, workspacePath);
}

export function validSetupAuthProbeSnapshot(/** @type {any} */ value, /** @type {string} */ sessionId, /** @type {string} */ workspacePath) {
  return validEmptyCreateSnapshot(value, sessionId, workspacePath);
}
