// @ts-nocheck
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { isDeepStrictEqual } from 'node:util';
import { parseRescueProgressRelay, RESCUE_RELAY_MESSAGES, RESCUE_RELAY_PREFIX } from '../../scripts/lib/rescue-progress-relay.mjs';
import { parseRescueBindingAuthority, parseRescueBindingPartition, rescueBindingAuthorityView } from '../../scripts/lib/rescue-binding.mjs';
import { createRescuePreparationStore, readRescuePreparation } from '../../scripts/lib/rescue-preparation.mjs';
import { sanitizeCodexThreadSpawnChild } from '../../scripts/lib/codex-app-server.mjs';
import { createStateStore } from '../../scripts/lib/state.mjs';
import { expectedGenericRescueMessage, expectedNamedRescueMessage } from './rescue-skill-contract.mjs';

const MAX_EXEC_FRAMES = 2_048;
const MAX_ROLLOUTS = 64;
const MAX_EVENTS_PER_ROLLOUT = 8_192;
const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_ROLLOUT_BYTES = 16 * 1024 * 1024;
const MAX_EXEC_AGENT_MESSAGES = 256;
const MAX_CHILD_POLLS = 64;
const MAX_RESCUE_TASK_NAME_BYTES = 64;
const MAX_RESCUE_TASK_BYTES = 64 * 1024;
const MAX_RESCUE_ENVELOPE_BYTES = MAX_RESCUE_TASK_BYTES + 4096;
const MAX_RESCUE_MODEL_BYTES = 512;
const MAX_LEGACY_JSON_DEPTH = 8;
const MAX_LEGACY_JSON_CANDIDATES = 256;
const MAX_LEGACY_JSON_DECODE_BYTES = 4 * MAX_TEXT_BYTES;
const MAX_PREPARATION_JSON_DEPTH = 256;
const RESCUE_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);
const RESCUE_TASK_NAME_PATTERN = /^zcode_rescue_[a-z][a-z0-9]{0,15}(?:_[a-z][a-z0-9]{0,15}){0,2}(?:_(?:[2-9]|[1-9][0-9]{1,3}))?$/u;
const GENERIC_HIDDEN_SCHEMA_VERSIONS = new Set(['0.147.0']);
const EXEC_ENVELOPE_KEYS = new Set(['cmd', 'workdir', 'yield_time_ms', 'max_output_tokens']);
const PREPARATION_READY_LINE = `${JSON.stringify({ type: 'preparation-input-ready', command: 'rescue' })}\n`;
const PUBLIC_JOB_STATUSES = new Set(['queued', 'running', 'cancelling', 'succeeded', 'failed', 'cancelled']);
const PUBLIC_PROGRESS_PHASES = new Set(['starting', 'running', 'waiting', 'finalizing']);
const TERMINAL_JOB_STATUSES = new Set(['succeeded', 'failed', 'cancelled']);
const MAX_PUBLIC_PROGRESS_LINE_BYTES = 256;

export class CodexRescueUnqualifiedError extends Error {
  constructor(code, message, evidence) { super(message); this.name = 'CodexRescueUnqualifiedError'; this.code = code; this.evidence = evidence; }
}

export class CodexRescueEvidenceMismatchError extends Error {
  constructor(code, message) { super(message); this.name = 'CodexRescueEvidenceMismatchError'; this.code = code; }
}

export function assertCodexRescueDisplayName(evidence) {
  const taskName = boundedString(evidence?.taskName);
  if (!taskName || Buffer.byteLength(taskName, 'utf8') > MAX_RESCUE_TASK_NAME_BYTES || !RESCUE_TASK_NAME_PATTERN.test(taskName)) {
    mismatch('display-task-name-contract', 'The Rescue display task name does not match the bounded naming contract.');
  }
  const agentPath = boundedString(evidence?.agentPath);
  if (agentPath !== `/root/${taskName}`) {
    mismatch('display-agent-path-contract', 'The Rescue display agent path does not exactly match its task name.');
  }
  return { taskName, agentPath, displayNameConforms: true };
}

export function parseCodexRolloutJsonl(value) {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAX_ROLLOUT_BYTES) {
    mismatch('rollout-file-oversize', 'A rollout file is absent or exceeds the qualification bound.');
  }
  const lines = value.split('\n').filter((line) => line.length > 0);
  if (lines.length > MAX_EVENTS_PER_ROLLOUT) mismatch('rollout-event-count', 'A rollout contains too many events.');
  return lines.map((line) => {
    if (Buffer.byteLength(line, 'utf8') > MAX_TEXT_BYTES) mismatch('rollout-line-oversize', 'A rollout record exceeds the qualification bound.');
    try { return JSON.parse(line); } catch { mismatch('rollout-json-invalid', 'A rollout record is not valid JSON.'); }
  });
}

export function qualifyCodexRescueEvidence(input, options) {
  return qualifyCodexRescueEvidenceCore(input, options, false);
}

/**
 * Qualify bounded raw host, hook, persisted authority, and fake-peer captures
 * for a clear proactive continuation. Every reported count is derived here;
 * caller-authored normalized verdicts are deliberately outside this contract.
 */
export async function qualifyCodexRescuePreparedContinuationEvidence(input, options) {
  const optionKeys = options && typeof options === 'object' && !Array.isArray(options) ? Object.keys(options) : [];
  if (options !== undefined && (!options || typeof options !== 'object' || Array.isArray(options)
    || optionKeys.some((key) => key !== 'requireLongLifecycle')
    || Object.hasOwn(options, 'requireLongLifecycle') && typeof options.requireLongLifecycle !== 'boolean')) {
    mismatch('continuation-raw-contract', 'Prepared continuation qualification options are invalid.');
  }
  const requireLongLifecycle = options?.requireLongLifecycle === true;
  if (!input || !['named', 'generic'].includes(input.route) || !['foreground', 'background'].includes(input.execution)
    || typeof input.parentRolloutJson !== 'string' || typeof input.childRolloutJson !== 'string'
    || typeof input.hookLifecycleJson !== 'string' || typeof input.executorRecordBytes !== 'string'
    || typeof input.activeTurnRecordBytes !== 'string' || typeof input.bindingAuthorityBytes !== 'string'
    || typeof input.bindingPreReservationBytes !== 'string' || typeof input.bindingPartitionBytes !== 'string'
    || typeof input.jobRecordBytesJson !== 'string' || typeof input.fakePeerJson !== 'string'
    || typeof input.execFramesJson !== 'string'
    || !input.expected) {
    mismatch('continuation-raw-contract', 'Prepared continuation qualification requires bounded raw captured artifacts.');
  }
  const expected = input.expected; const parentSessionId = boundedString(expected.parentSessionId); const childThreadId = boundedString(expected.childThreadId);
  const originalParentTurnId = boundedString(expected.originalParentTurnId);
  const continuationParentTurnId = boundedString(expected.continuationParentTurnId);
  if (!parentSessionId || !childThreadId || !originalParentTurnId || continuationParentTurnId !== originalParentTurnId) mismatch('continuation-identity', 'Prepared continuation must remain in the exact active parent turn.');
  const parseArray = (text, code) => { if (Buffer.byteLength(text) > MAX_ROLLOUT_BYTES) mismatch(code, 'Captured evidence exceeds its byte bound.'); let value; try { value = JSON.parse(text); } catch { mismatch(code, 'Captured evidence is malformed.'); } return boundedArray(value, MAX_EVENTS_PER_ROLLOUT, code); };
  const parent = parseArray(input.parentRolloutJson, 'continuation-parent-events'); const child = parseArray(input.childRolloutJson, 'continuation-child-events');
  const hooks = parseArray(input.hookLifecycleJson, 'continuation-hook-events'); const jobBytes = parseArray(input.jobRecordBytesJson, 'continuation-jobs'); const peer = parseArray(input.fakePeerJson, 'continuation-peer-events');
  const execFrames = parseArray(input.execFramesJson, 'continuation-exec-frames');
  const rawCapture = validateLiveRawContinuationCapture(input, { parent, child, hooks, peer, expected });
  const spawns = namedCalls(parent, 'spawn_agent'); const followups = namedCalls(parent, 'followup_task');
  const parentExecs = parent.filter((event) => event?.payload?.type === 'custom_tool_call' && event.payload.name === 'exec');
  const parentOutputs = parent.filter((event) => ['custom_tool_call_output', 'function_call_output'].includes(event?.payload?.type));
  const starts = parent.filter((event) => event?.payload?.type === 'sub_agent_activity' && event.payload.kind === 'started');
  const stops = parent.filter((event) => event?.payload?.type === 'sub_agent_activity' && event.payload.kind === 'stopped');
  if (spawns.length !== 1) mismatch('continuation-spawn-count', 'Captured continuation must contain one original spawn only.');
  if (starts.length !== 1) mismatch('continuation-start-count', 'Captured continuation must contain one original SubagentStart only.');
  if (stops.length !== 1) mismatch('continuation-stop-count', 'Captured continuation must contain one SubagentStop only.');
  if (followups.length !== 1) mismatch('continuation-followup-count', 'Captured continuation must contain one follow-up only.');
  const parentMeta = sessionMeta(parent);
  if (parentMeta?.id !== parentSessionId || parentMeta?.session_id !== parentSessionId || parentMeta?.thread_source !== 'user'
    || parentMeta?.source !== 'exec' || Object.hasOwn(parentMeta ?? {}, 'parent_thread_id')) mismatch('continuation-parent-metadata', 'Raw parent session metadata is invalid.');
  assertGlobalCallOwnership(parent, child);
  const preparations = parentExecs.filter((event) => parseCapturedHostCall(event.payload.input).envelope.get('cmd')?.endsWith('/skills/rescue/launcher.mjs" prepare rescue'));
  if (preparations.length !== 2 || preparations.some((call) => parentOutputs.filter((output) => output.payload.type === 'custom_tool_call_output' && output.payload.call_id === call.payload.call_id).length !== 1)) mismatch('continuation-preparation-count', 'Captured continuation must contain two linked raw parent preparations.');
  const parentCalls = parent.filter((event) => ['custom_tool_call', 'function_call'].includes(event?.payload?.type));
  const preparationWrites = parentExecs.filter((event) => parseCapturedHostCall(event.payload.input).kind === 'write_stdin');
  if (parentCalls.length !== 6 || preparationWrites.length !== 2
    || parentCalls.some((event) => event.payload.type === 'function_call' && !['spawn_agent', 'followup_task'].includes(event.payload.name))) mismatch('continuation-parent-events', 'Raw parent rollout contains an unaccounted host call.');
  const spawn = parseObject(spawns[0].payload.arguments, 'continuation-spawn-arguments'); const followup = parseObject(followups[0].payload.arguments, 'continuation-followup-arguments');
  const expectedMessage = input.route === 'named' ? expectedNamedRescueMessage : expectedGenericRescueMessage;
  const spawnKeys = input.route === 'named' ? ['agent_type', 'fork_turns', 'message', 'task_name'] : ['fork_turns', 'message', 'task_name'];
  assertExactKeys(spawn, spawnKeys, 'continuation-spawn-contract');
  if (spawn.fork_turns !== 'none' || input.route === 'named' && spawn.agent_type !== 'zcode-rescue'
    || input.route === 'generic' && Object.hasOwn(spawn, 'agent_type')) mismatch('continuation-spawn-contract', 'Raw spawn route contract is invalid.');
  const spawnOutput = parentOutputs.find((output) => output.payload.call_id === spawns[0].payload.call_id);
  let spawnResult; try { spawnResult = JSON.parse(spawnOutput?.payload?.output); } catch { mismatch('continuation-target-lifecycle', 'The spawn output is not a valid exact child handle.'); }
  const linkedStarts = starts.filter((event) => event.payload.event_id === spawns[0].payload.call_id
    && event.payload.agent_thread_id === spawnResult?.agent_id);
  if (linkedStarts.length !== 1 || spawnResult?.agent_id !== childThreadId) mismatch('continuation-target-lifecycle', 'Spawn output and started activity do not form one exact linked child handle.');
  if (starts[0].payload.event_id !== spawns[0].payload.call_id || starts[0].payload.agent_thread_id !== childThreadId
    || stops[0].payload.agent_thread_id !== childThreadId || starts[0].payload.parent_turn_id !== originalParentTurnId
    || stops[0].payload.parent_turn_id !== originalParentTurnId) mismatch('continuation-start-count', 'Captured lifecycle does not link the exact original child.');
  if (followup.message !== expectedMessage || spawn.message !== expectedMessage) mismatch('continuation-followup-message', 'Captured assignments are not the route-specific exact original message.');
  const preparationTimes = preparations.map(eventTimestamp).sort();
  if (!(preparationTimes[0] < eventTimestamp(spawns[0]) && eventTimestamp(spawns[0]) < eventTimestamp(starts[0])
    && eventTimestamp(starts[0]) < eventTimestamp(stops[0]) && eventTimestamp(stops[0]) < preparationTimes[1]
    && preparationTimes[1] < eventTimestamp(followups[0]))) mismatch('continuation-event-order', 'Captured lifecycle chronology is invalid.');
  if (!(parent.indexOf(preparations[0]) < parent.indexOf(spawns[0]) && parent.indexOf(spawns[0]) < parent.indexOf(starts[0])
    && parent.indexOf(starts[0]) < parent.indexOf(stops[0]) && parent.indexOf(stops[0]) < parent.indexOf(preparations[1])
    && parent.indexOf(preparations[1]) < parent.indexOf(followups[0]))) mismatch('continuation-event-order', 'Captured raw parent event order is invalid.');
  const parentTurnEvents = [preparations[0], spawns[0], starts[0], stops[0], preparations[1], followups[0]];
  if (parentTurnEvents.some((event) => event?.turn_id !== originalParentTurnId)) mismatch('continuation-parent-turns', 'Raw parent events do not prove one exact active parent turn.');
  const activeTurn = validateContinuationActiveTurn(input.activeTurnRecordBytes, { ...expected, originalParentTurnId });
  const workspaceAuthority = activeTurn.version === 3
    ? await validateContinuationWorkspaceBinding(input, { ...expected, childTurnId: executorChildTurnId(input.executorRecordBytes), originalParentTurnId }, activeTurn)
    : { originWorkspace: expected.workspace, executionWorkspace: expected.workspace, generationId: undefined, checked: false };
  const preparationRecords = await validateContinuationPreparations(parent, input.preparationRecordBytesJson, { ...expected, childThreadId, originalParentTurnId, continuationParentTurnId, execution: input.execution, route: input.route }, activeTurn, requireLongLifecycle);
  const observedAgentPath = boundedString(starts[0].payload.agent_path); const observedTaskName = boundedString(spawn.task_name);
  if (!observedTaskName || !observedAgentPath || observedAgentPath !== `/root/${observedTaskName}`
    || stops[0].payload.agent_path !== observedAgentPath) mismatch('continuation-presentation', 'Captured child presentation is internally inconsistent.');
  const followupOutput = parentOutputs.find((output) => output.payload.call_id === followups[0].payload.call_id);
  let followupResult; try { followupResult = JSON.parse(followupOutput.payload.output); } catch { mismatch('continuation-call-linkage', 'Parent lifecycle outputs are malformed.'); }
  if (followup.target !== observedAgentPath || followupResult?.accepted !== true || followupResult?.target !== observedAgentPath) {
    mismatch('continuation-followup-target', 'Captured follow-up does not use the plugin-prescribed exact route path.');
  }
  const executor = parseObject(input.executorRecordBytes, 'continuation-executor-provenance');
  const exactExecutorKeys = activeTurn.version === 3
    ? ['active', 'agentId', 'agentType', 'childTurnId', 'createdAt', 'kind', 'originWorkspace', 'parentGenerationId', 'parentPermissionMode', 'parentSessionId', 'parentTurnId', 'workspace']
    : ['active', 'agentId', 'agentType', 'childTurnId', 'createdAt', 'kind', 'parentPermissionMode', 'parentSessionId', 'parentTurnId', 'workspace'];
  assertExactKeys(executor, exactExecutorKeys, 'continuation-executor-provenance');
  if (executor.kind !== 'subagent-executor' || executor.active !== false || executor.agentId !== childThreadId || executor.parentSessionId !== parentSessionId
    || executor.parentTurnId !== originalParentTurnId || executor.parentPermissionMode !== expected.permissionMode || executor.workspace !== workspaceAuthority.executionWorkspace
    || activeTurn.version === 3 && (executor.parentGenerationId !== activeTurn.generationId || executor.originWorkspace !== workspaceAuthority.originWorkspace)
    || executor.agentType !== (input.route === 'named' ? 'zcode-rescue' : 'default')) mismatch('continuation-executor-provenance', 'Raw stopped executor provenance is invalid.');
  if (!Number.isFinite(Date.parse(executor.createdAt))) mismatch('continuation-executor-provenance', 'Raw executor creation time is invalid.');
  const startHooks = hooks.filter((event) => event?.hook_event_name === 'SubagentStart'); const stopHooks = hooks.filter((event) => event?.hook_event_name === 'SubagentStop');
  const promptHooks = hooks.filter((event) => event?.hook_event_name === 'UserPromptSubmit');
  if (startHooks.length !== 1 || stopHooks.length !== 1 || promptHooks.length !== 1 || promptHooks[0].turn_id !== originalParentTurnId
    || startHooks[0].agent_id !== childThreadId || stopHooks[0].agent_id !== childThreadId
    || startHooks[0].session_id !== parentSessionId || stopHooks[0].session_id !== parentSessionId
    || promptHooks[0].session_id !== parentSessionId || startHooks[0].turn_id !== executor.childTurnId || stopHooks[0].turn_id !== executor.childTurnId
    || startHooks[0].parent_turn_id !== undefined && startHooks[0].parent_turn_id !== originalParentTurnId
    || stopHooks[0].parent_turn_id !== undefined && stopHooks[0].parent_turn_id !== originalParentTurnId
    || startHooks[0].agent_type !== executor.agentType || stopHooks[0].agent_type !== executor.agentType
    || startHooks[0].permission_mode !== expected.permissionMode || stopHooks[0].permission_mode !== expected.permissionMode
    || promptHooks[0].permission_mode !== expected.permissionMode || startHooks[0].cwd !== workspaceAuthority.originWorkspace
    || stopHooks[0].cwd !== workspaceAuthority.originWorkspace || promptHooks[0].cwd !== workspaceAuthority.originWorkspace) mismatch('continuation-hook-lifecycle', 'Raw hook lifecycle does not prove one prompt and one Start/Stop in the same parent turn.');
  if (!(hooks.indexOf(promptHooks[0]) < hooks.indexOf(startHooks[0]) && hooks.indexOf(startHooks[0]) < hooks.indexOf(stopHooks[0]))) mismatch('continuation-hook-lifecycle', 'Raw hook lifecycle order is invalid.');
  let authority; let prePartition; let partition; try { authority = parseRescueBindingAuthority(input.bindingAuthorityBytes, { parentSessionId, workspace: expected.workspace }); prePartition = parseRescueBindingPartition(input.bindingPreReservationBytes, { parentSessionId, workspace: expected.workspace }); partition = parseRescueBindingPartition(input.bindingPartitionBytes, { parentSessionId, workspace: expected.workspace }); } catch { mismatch('continuation-binding-invalid', 'Raw Rescue binding files are invalid.'); }
  if (authority.key !== partition.key || authority.key !== prePartition.key || prePartition.records.length < 1
    || partition.records.length !== prePartition.records.length || partition.records.length > 64) mismatch('continuation-binding-invalid', 'Raw Rescue binding authority and partitions do not match.');
  const selectBinding = (records) => records.filter((record) => rescueBindingAuthorityView(record).childAgentId === childThreadId);
  const preMatches = selectBinding(prePartition.records); const matches = selectBinding(partition.records);
  if (preMatches.length !== 1 || matches.length !== 1) mismatch('continuation-binding-invalid', 'Raw Rescue bindings do not contain one exact selected child.');
  const [preBinding] = preMatches;
  const [binding] = matches;
  const preChildAuthority = rescueBindingAuthorityView(preBinding); const childAuthority = rescueBindingAuthorityView(binding);
  if (childAuthority.kind !== 'subagent-start' || childAuthority.childAgentId !== childThreadId || childAuthority.childAgentType !== executor.agentType
    || childAuthority.parentTurnId !== originalParentTurnId || childAuthority.parentPermissionMode !== expected.permissionMode
    || binding.permissionMode !== expected.permissionMode || binding.state !== 'active' || preBinding.key !== binding.key
    || !isDeepStrictEqual(preChildAuthority, childAuthority) || preBinding.permissionMode !== binding.permissionMode
    || preBinding.operationId !== binding.operationId || preBinding.anchorJobId !== binding.anchorJobId) mismatch('continuation-binding-identity', 'Raw Rescue binding identity is invalid.');
  if (preBinding.state !== 'active' || preBinding.currentJobId !== preBinding.anchorJobId
    || binding.currentJobId === preBinding.currentJobId) mismatch('continuation-current-job-stale', 'Raw current job binding does not prove the exact pre-reservation CAS transition.');
  if (workspaceAuthority.checked) await validateContinuationArtifactLocations(input, { ...workspaceAuthority, route: workspaceAuthority.route });
  const jobs = await parseRawJobsWithProduction(jobBytes, expected, input.installedDataRoot);
  if (jobs.length < 2 || jobs.length > 128 || new Set(jobs.map((job) => job?.id)).size !== jobs.length) mismatch('continuation-job-identity', 'Raw job evidence contains extra or duplicate identities.');
  const anchor = jobs.find((job) => job?.id === binding.anchorJobId); const current = jobs.find((job) => job?.id === binding.currentJobId);
  if (!current) mismatch('continuation-current-job-stale', 'Raw current job evidence is absent.');
  if (!anchor || anchor.status === 'cancelled' || !boundedString(anchor.zcodeSessionId)) mismatch('continuation-anchor-invalid', 'Raw anchor job is not resumable.');
  const referencedJobIds = new Set(partition.records.flatMap((record) => [record.anchorJobId, record.currentJobId]));
  if (jobs.length !== referencedJobIds.size || jobs.some((job) => !referencedJobIds.has(job.id))) {
    mismatch('continuation-job-identity', 'Raw job evidence is not the exact closure of the captured binding partition.');
  }
  const reactivation = preparationRecords[1].activation;
  if (reactivation.bindingKey !== preBinding.key || reactivation.operationId !== preBinding.operationId
    || reactivation.anchorJobId !== preBinding.anchorJobId || reactivation.currentJobId !== preBinding.currentJobId
    || reactivation.bindingUpdatedAt !== preBinding.updatedAt || reactivation.zcodeSessionId !== anchor.zcodeSessionId) mismatch('continuation-preparation-records', 'Consumed continuation preparation is not bound to the exact resumable operation.');
  if (anchor.ownerTurnId !== originalParentTurnId || current.ownerTurnId !== originalParentTurnId) mismatch('continuation-job-record', 'Raw job owner turns do not match the active parent turn.');
  if (Date.parse(anchor.createdAt) > Date.parse(stops[0].timestamp) || Date.parse(preBinding.updatedAt) > Date.parse(preparationRecords[1].createdAt)
    || Date.parse(current.createdAt) < Date.parse(preparationRecords[1].createdAt) || Date.parse(binding.updatedAt) < Date.parse(current.createdAt)) mismatch('continuation-job-record', 'Raw binding and job timestamps do not match the long-running lifecycle transition.');
  if (!['queued', 'running', 'cancelling', 'succeeded', 'failed', 'cancelled'].includes(current.status)) mismatch('continuation-current-job-stale', 'Raw current job status is invalid.');
  let backgroundObserver;
  if (input.execution === 'background') { try { backgroundObserver = parseObject(input.backgroundObserverJson, 'continuation-background-evidence'); } catch { mismatch('continuation-background-evidence', 'Background continuation lacks raw private observer evidence.'); }
    assertExactKeys(backgroundObserver, ['executionCapability', 'jobId'], 'continuation-background-evidence');
    if (!boundedString(backgroundObserver.executionCapability) || Buffer.byteLength(backgroundObserver.executionCapability) > 4096
      || backgroundObserver.jobId !== current.id || current.status !== 'queued' || !Number.isSafeInteger(current.childPid) || current.childPid <= 0
      || !/^[a-f0-9]{64}$/u.test(current.workerLeaseId)) mismatch('continuation-background-evidence', 'Background continuation lacks raw capability, job, and worker evidence.'); }
  const creates = peer.filter((event) => event?.method === 'session/create'); const resumes = peer.filter((event) => event?.method === 'session/resume'); const turns = peer.filter((event) => event?.method === 'session/send');
  if (peer.length !== 4) mismatch('continuation-peer-method', 'Raw fake peer contains an unaccounted method.');
  if (peer.some((event) => !event || Object.keys(event).sort().join('\0') !== ['id', 'method', 'params'].sort().join('\0')
    || !Number.isSafeInteger(event.id) || !event.params || typeof event.params !== 'object' || Array.isArray(event.params))) mismatch('continuation-peer-method', 'Raw fake peer is not an exact inbound JSON-RPC request capture.');
  // Initial and resumed turns use two independently spawned peer processes, so
  // JSON-RPC IDs may restart. They must remain unique inside each captured peer
  // lifecycle, where create/send and resume/send are the two exact pairs.
  if (creates[0]?.id === turns[0]?.id || resumes[0]?.id === turns[1]?.id) mismatch('continuation-peer-method', 'Raw fake-peer request IDs collide inside one peer lifecycle.');
  const createParams = creates[0]?.params ?? {}; const createKeys = Object.keys(createParams);
  if (!createKeys.includes('workspace') || createKeys.some((key) => !['workspace', 'sessionId', 'model', 'importedHistory'].includes(key))
    || Object.keys(createParams.workspace ?? {}).sort().join('\0') !== ['workspaceKey', 'workspacePath'].sort().join('\0')
    || createParams.workspace.workspacePath !== expected.workspace || createParams.workspace.workspaceKey !== expected.workspace
    || createParams.sessionId !== undefined && !boundedString(createParams.sessionId)
    || createParams.model !== undefined && !validCapturedPeerModel(createParams.model)
    || createParams.importedHistory !== undefined && !validCapturedImportedHistory(createParams.importedHistory)
    || resumes.some((event) => Object.keys(event?.params ?? {}).join('\0') !== 'sessionId')
    || turns.some((event) => Object.keys(event?.params ?? {}).sort().join('\0') !== ['content', 'inputId', 'queryId', 'sessionId'].sort().join('\0'))
    || turns.some((event) => !boundedString(event.params.sessionId) || !boundedString(event.params.inputId)
      || event.params.inputId !== event.params.queryId || !boundedString(event.params.content))) {
    mismatch('continuation-peer-method', 'Raw fake-peer request parameters are not exact or target another workspace.');
  }
  if (creates.length !== 1 || resumes.length !== 1 || turns[0]?.params?.sessionId !== anchor.zcodeSessionId || resumes[0]?.params?.sessionId !== anchor.zcodeSessionId) mismatch('continuation-session-mismatch', 'Raw fake peer did not resume the exact created session inferred from its first send.');
  if (turns.length !== 2 || turns.some((turn) => turn?.params?.sessionId !== anchor.zcodeSessionId)) mismatch('continuation-peer-turn-count', 'Raw fake peer does not contain one initial and one resumed turn.');
  if (!(peer.indexOf(creates[0]) < peer.indexOf(turns[0]) && peer.indexOf(turns[0]) < peer.indexOf(resumes[0])
    && peer.indexOf(resumes[0]) < peer.indexOf(turns[1]))) mismatch('continuation-peer-order', 'Raw fake-peer create, initial turn, resume, and new turn chronology is invalid.');
  const childMeta = sessionMeta(child); const calls = child.filter((event) => event?.payload?.type === 'custom_tool_call'); const outputs = child.filter((event) => event?.payload?.type === 'custom_tool_call_output');
  const childCommands = calls.map((call) => parseCapturedHostCall(call.payload.input).envelope.get('cmd'));
  const childSpawn = childMeta?.source?.subagent?.thread_spawn;
  if (childMeta?.id !== childThreadId || childMeta?.session_id !== parentSessionId || childMeta?.parent_thread_id !== parentSessionId
    || childMeta?.thread_source !== 'subagent' || childSpawn?.parent_thread_id !== parentSessionId || childSpawn?.agent_path !== observedAgentPath
    || childSpawn?.agent_role !== (input.route === 'named' ? 'zcode-rescue' : null)) mismatch('continuation-child-metadata', 'Raw child session metadata is invalid.');
  if (calls.length !== 2 || outputs.length !== 2
    || childCommands.some((command) => typeof command !== 'string' || !command.endsWith('/skills/rescue/launcher.mjs" invoke-prepared rescue'))
    || new Set(childCommands).size !== 1
    || calls.some((call) => outputs.filter((output) => output.payload.call_id === call.payload.call_id).length !== 1)) mismatch('continuation-child-invocations', 'Raw child rollout does not prove two exact linked invoke-prepared turns.');
  for (const call of calls) {
    assertExecEnvelope(parseCapturedHostCall(call.payload.input).envelope, childCommands[0], workspaceAuthority.originWorkspace,
      'continuation-child-exec-envelope-mismatch');
  }
  const childTurns = calls.map((call) => boundedString(call.turn_id));
  if (childTurns.some((turnId) => !turnId) || new Set(childTurns).size !== 2
    || calls.some((call) => outputs.find((output) => output.payload.call_id === call.payload.call_id)?.turn_id !== call.turn_id)) mismatch('continuation-child-turns', 'Raw child rollout does not prove one exact invocation in each of two turns.');
  const firstOutput = outputs.find((output) => output.payload.call_id === calls[0].payload.call_id); const secondOutput = outputs.find((output) => output.payload.call_id === calls[1].payload.call_id);
  if (!(child.indexOf(calls[0]) < child.indexOf(firstOutput) && child.indexOf(firstOutput) < child.indexOf(calls[1]) && child.indexOf(calls[1]) < child.indexOf(secondOutput)
    && eventTimestamp(calls[0]) < eventTimestamp(firstOutput) && eventTimestamp(firstOutput) < eventTimestamp(calls[1]) && eventTimestamp(calls[1]) < eventTimestamp(secondOutput))) mismatch('continuation-child-order', 'Raw child invocation chronology is invalid.');
  if (!(eventTimestamp(starts[0]) < eventTimestamp(calls[0]) && eventTimestamp(firstOutput) < eventTimestamp(stops[0])
    && eventTimestamp(followups[0]) < eventTimestamp(calls[1]))) mismatch('continuation-child-order', 'Cross-rollout child chronology is invalid.');
  assertMandatoryContinuationPublicSurfaces(parent, child, jobs, observedAgentPath, execFrames, childThreadId);
  const privateValues = [activeTurn.key, binding.key, binding.operationId, binding.anchorJobId, binding.currentJobId, anchor.zcodeSessionId,
    activeTurn.generationId, backgroundObserver?.executionCapability, current.workerLeaseId, executor.childTurnId].filter((value) => typeof value === 'string' && value);
  if (privateValues.length < 6) mismatch('continuation-private-sentinels', 'Raw artifacts do not provide mandatory private sentinels.');
  const publicText = JSON.stringify({ parent: redactValidatedPreparationInputs(parent), child, execFrames, rawCapture: rawCapture?.publicEvidence });
  if (privateValues.some((value) => publicText.includes(value)) || publicText.includes('continuationTarget')) mismatch('continuation-private-leak', 'A public or host surface leaks a private identifier.');
  return {
    route: input.route, parentSessionId, childThreadId, agentPath: observedAgentPath, originalParentTurnId, continuationParentTurnId,
    ...(workspaceAuthority.checked ? { originWorkspace: workspaceAuthority.originWorkspace, executionWorkspace: workspaceAuthority.executionWorkspace,
      generationId: workspaceAuthority.generationId, workspaceBindingChecked: true } : {}),
    spawnCount: 1, startCount: 1, stopCount: 1, followupCount: 1, continuationSpawnCount: 0,
    childInvocationCount: 2, peerResumeChecked: true, activeTurnLifecycleChecked: true,
    longLifecycleChecked: requireLongLifecycle, execution: input.execution,
  };
}

/** Qualify a resumed parent that lazily reloads one exact persisted Rescue child. */
export async function qualifyCodexRescueRestoredChildEvidence(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) mismatch('restored-child-contract', 'Restored-child evidence is absent.');
  const expectedKeys = ['appServerTranscriptJson', 'childRolloutJson', 'executorRecordBytes', 'expected', 'fakePeerJson', 'hookLifecycleJson', 'parentRolloutJson', 'preparationRecordBytes'];
  if (Object.keys(input).sort().join('\0') !== expectedKeys.sort().join('\0')) mismatch('restored-child-contract', 'Restored-child evidence has an invalid shape.');
  const expected = input.expected;
  const expectedFields = ['agentPath', 'childThreadId', 'executionWorkspace', 'launcherCommand', 'originalParentTurnId', 'originWorkspace', 'parentSessionId', 'permissionMode', 'publicOutput', 'resumedParentTurnId', 'zcodeSessionId'];
  if (!expected || Object.keys(expected).sort().join('\0') !== expectedFields.sort().join('\0')) mismatch('restored-child-contract', 'Restored-child expectations have an invalid shape.');
  const ids = ['parentSessionId', 'childThreadId', 'originalParentTurnId', 'resumedParentTurnId'].map((key) => boundedString(expected[key]));
  if (ids.some((value) => !value) || expected.originalParentTurnId === expected.resumedParentTurnId
    || !/^\/root\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/u.test(boundedString(expected.agentPath) ?? '') || !boundedString(expected.launcherCommand)
    || !boundedString(expected.originWorkspace) || !boundedString(expected.executionWorkspace)
    || !boundedString(expected.permissionMode) || !boundedString(expected.publicOutput) || !boundedString(expected.zcodeSessionId)) mismatch('restored-child-identity', 'Restored-child identity is invalid.');
  const parseArray = (text, code) => { if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_ROLLOUT_BYTES) mismatch(code, 'Captured evidence is absent or oversized.');
    let value; try { value = JSON.parse(text); } catch { mismatch(code, 'Captured evidence is malformed.'); }
    return boundedArray(value, MAX_EVENTS_PER_ROLLOUT, code); };
  const parent = parseArray(input.parentRolloutJson, 'restored-child-parent'); const child = parseArray(input.childRolloutJson, 'restored-child-child');
  const transcript = parseArray(input.appServerTranscriptJson, 'restored-child-app-server'); const hooks = parseArray(input.hookLifecycleJson, 'restored-child-hooks'); const peer = parseArray(input.fakePeerJson, 'restored-child-peer');
  const calls = namedCalls(parent, 'followup_task'); const spawns = namedCalls(parent, 'spawn_agent');
  const parentMeta = parent.filter((event) => event?.type === 'session_meta');
  if (parentMeta.length !== 1 || parentMeta[0].payload?.id !== expected.parentSessionId) mismatch('restored-child-one-action', 'The resumed parent identity is invalid.');

  const original = parent.filter((event) => event?.turn_id === expected.originalParentTurnId);
  const originalSpawns = namedCalls(original, 'spawn_agent'); const originalOutputs = original.filter((event) => event?.payload?.type === 'function_call_output');
  const starts = original.filter((event) => event?.payload?.type === 'sub_agent_activity' && event.payload.kind === 'started');
  const stops = original.filter((event) => event?.payload?.type === 'sub_agent_activity' && event.payload.kind === 'stopped');
  if (originalSpawns.length !== 1 || originalOutputs.length !== 1 || starts.length !== 1 || stops.length !== 1 || original.length !== 4) mismatch('restored-child-history', 'Historical spawn provenance must contain one exact spawn, output, start, and stop.');
  const originalSpawn = originalSpawns[0]; const spawnArgs = parseObject(originalSpawn.payload.arguments, 'restored-child-history');
  const taskName = expected.agentPath.slice('/root/'.length); const namedKeys = ['agent_type', 'fork_turns', 'message', 'task_name']; const genericKeys = ['fork_turns', 'message', 'task_name'];
  const route = Object.keys(spawnArgs).sort().join('\0') === namedKeys.sort().join('\0') && spawnArgs.agent_type === 'zcode-rescue' ? 'named'
    : Object.keys(spawnArgs).sort().join('\0') === genericKeys.sort().join('\0') ? 'generic' : null;
  const historicalAssignment = route === 'named' ? expectedNamedRescueMessage
    : route === 'generic' ? expectedGenericRescueMessage.replaceAll('<rescue-launcher-command>', expected.launcherCommand) : null;
  let spawnResult; try { spawnResult = JSON.parse(originalOutputs[0].payload.output); } catch { mismatch('restored-child-history', 'Historical spawn output is malformed.'); }
  const historicalTimes = [originalSpawn, originalOutputs[0], starts[0], stops[0]].map(eventTimestamp);
  if (!route || spawnArgs.fork_turns !== 'none' || spawnArgs.task_name !== taskName || spawnArgs.message !== historicalAssignment
    || Object.keys(spawnResult ?? {}).join('\0') !== 'agent_id' || spawnResult.agent_id !== expected.childThreadId
    || originalOutputs[0].payload.call_id !== originalSpawn.payload.call_id || starts[0].payload.event_id !== originalSpawn.payload.call_id
    || starts[0].payload.agent_thread_id !== expected.childThreadId || stops[0].payload.agent_thread_id !== expected.childThreadId
    || starts[0].payload.agent_path !== expected.agentPath || stops[0].payload.agent_path !== expected.agentPath
    || starts[0].payload.parent_turn_id !== expected.originalParentTurnId || stops[0].payload.parent_turn_id !== expected.originalParentTurnId
    || historicalTimes.some((value) => value === undefined) || !(historicalTimes[0] < historicalTimes[1] && historicalTimes[0] < historicalTimes[2]
      && historicalTimes[1] < historicalTimes[3] && historicalTimes[2] < historicalTimes[3])
    || !(parent.indexOf(originalSpawn) < parent.indexOf(originalOutputs[0]) && parent.indexOf(originalSpawn) < parent.indexOf(starts[0])
      && parent.indexOf(originalOutputs[0]) < parent.indexOf(stops[0]) && parent.indexOf(starts[0]) < parent.indexOf(stops[0]))) {
    mismatch('restored-child-history', 'Historical spawn assignment, child linkage, or chronology is invalid.');
  }

  const current = parent.filter((event) => event?.turn_id === expected.resumedParentTurnId);
  const currentCustomCalls = current.filter((event) => event?.payload?.type === 'custom_tool_call'); const currentCustomOutputs = current.filter((event) => event?.payload?.type === 'custom_tool_call_output');
  const currentFunctions = current.filter((event) => event?.payload?.type === 'function_call'); const currentFunctionOutputs = current.filter((event) => event?.payload?.type === 'function_call_output');
  if (parent.length !== 13 || current.length !== 8 || currentCustomCalls.length !== 3 || currentCustomOutputs.length !== 3 || currentFunctions.length !== 1 || currentFunctionOutputs.length !== 1
    || currentFunctions[0].payload.name !== 'followup_task' || current.some((event) => event?.payload?.type === 'sub_agent_activity') || calls.length !== 1 || spawns.length !== 1) {
    mismatch('restored-child-current-events', 'The resumed phase must contain only Role readiness, one TTY prepare, one follow-up, and their exact outputs.');
  }
  const allCalls = [...originalSpawns, ...currentCustomCalls, ...currentFunctions, ...child.filter((event) => event?.payload?.type === 'custom_tool_call')];
  const allOutputs = [...originalOutputs, ...currentCustomOutputs, ...currentFunctionOutputs, ...child.filter((event) => event?.payload?.type === 'custom_tool_call_output')];
  const callIds = allCalls.map((event) => boundedString(event.payload.call_id));
  if (callIds.some((id) => !id) || new Set(callIds).size !== callIds.length || allCalls.length !== allOutputs.length
    || allCalls.some((call) => allOutputs.filter((output) => output.payload.call_id === call.payload.call_id).length !== 1)
    || allOutputs.some((output) => allCalls.filter((call) => call.payload.call_id === output.payload.call_id).length !== 1)) mismatch('restored-child-call-linkage', 'Restored host calls and outputs require global one-to-one call ownership.');

  const parsedCurrent = currentCustomCalls.map((event) => ({ event, host: parseCapturedHostCall(event.payload.input) }));
  const roleCall = parsedCurrent.find(({ host }) => host.kind === 'exec_command' && host.envelope.get('cmd') === `${expected.launcherCommand} role-status rescue`);
  const prepareCall = parsedCurrent.find(({ host }) => host.kind === 'exec_command' && host.envelope.get('cmd') === `${expected.launcherCommand} prepare rescue`);
  const writeCall = parsedCurrent.find(({ host }) => host.kind === 'write_stdin');
  if (!roleCall || !prepareCall || !writeCall || parsedCurrent.some(({ host }) => ![roleCall.host, prepareCall.host, writeCall.host].includes(host))
    || Object.keys(Object.fromEntries(roleCall.host.envelope)).sort().join('\0') !== ['cmd', 'workdir'].join('\0') || roleCall.host.envelope.get('workdir') !== expected.executionWorkspace
    || Object.keys(Object.fromEntries(prepareCall.host.envelope)).sort().join('\0') !== ['cmd', 'tty', 'workdir'].join('\0') || prepareCall.host.envelope.get('tty') !== true || prepareCall.host.envelope.get('workdir') !== expected.executionWorkspace
    || Object.keys(Object.fromEntries(writeCall.host.envelope)).sort().join('\0') !== ['chars', 'session_id'].join('\0')) mismatch('restored-child-current-events', 'Restored Role and prepare host calls are not exact.');
  const outputFor = (call) => currentCustomOutputs.find((output) => output.payload.call_id === call.event.payload.call_id);
  const roleOutput = parseCapturedHostResult(outputFor(roleCall)?.payload?.output); const readyOutput = parseCapturedHostResult(outputFor(prepareCall)?.payload?.output); const preparedOutput = parseCapturedHostResult(outputFor(writeCall)?.payload?.output);
  if (roleOutput.output !== `${JSON.stringify({ type: 'role-status', role: 'zcode-rescue', status: 'ready' })}\n` || roleOutput.exit_code !== 0 || Object.hasOwn(roleOutput, 'session_id')
    || readyOutput.output !== PREPARATION_READY_LINE || !Number.isSafeInteger(readyOutput.session_id) || Object.hasOwn(readyOutput, 'exit_code')
    || writeCall.host.envelope.get('session_id') !== readyOutput.session_id || preparedOutput.exit_code !== 0 || Object.hasOwn(preparedOutput, 'session_id')) mismatch('restored-child-directive', 'Restored Role readiness or TTY prepare handshake is invalid.');
  const chars = writeCall.host.envelope.get('chars'); let preparationEnvelope;
  try { preparationEnvelope = await readRescuePreparation(Readable.from([chars])); } catch { mismatch('restored-child-directive', 'Restored TTY write does not contain one production-valid preparation envelope.'); }
  const exactPreparedLine = `${JSON.stringify({ type: 'prepared', command: 'rescue', route: { version: 2, action: 'followup', target: expected.agentPath,
    assignment: Object.hasOwn(spawnArgs, 'agent_type') ? 'zcode-rescue' : 'default' } })}\n`;
  if (preparedOutput.output !== exactPreparedLine) mismatch('restored-child-directive', 'Prepared follow-up directive is not linked to the exact original path.');
  if (preparationEnvelope.version !== 2 || !isDeepStrictEqual(preparationEnvelope.continuationTarget,
    { childId: expected.childThreadId, agentPath: expected.agentPath })) {
    mismatch('restored-child-target', 'Restored preparation does not carry the exact retained lifecycle pair.');
  }

  const followupCall = currentFunctions[0]; const followup = parseObject(followupCall.payload.arguments, 'restored-child-followup');
  assertExactKeys(followup, ['message', 'target'], 'restored-child-followup');
  let followupResult; try { followupResult = JSON.parse(currentFunctionOutputs[0].payload.output); } catch { mismatch('restored-child-followup', 'Restored follow-up output is malformed.'); }
  if (followup.target !== expected.agentPath || followup.message !== spawnArgs.message || currentFunctionOutputs[0].payload.call_id !== followupCall.payload.call_id
    || !isDeepStrictEqual(followupResult, { accepted: true, target: expected.agentPath })) mismatch('restored-child-followup', 'The parent did not follow up the exact original child path with its exact historical assignment.');
  if (transcript.length !== 4) mismatch('restored-child-app-server', 'Installed app-server capture must contain one list and one read request/response pair.');
  const [listRequest, listResponse, readRequest, readResponse] = transcript;
  const listParams = { sourceKinds: ['subAgentThreadSpawn'], limit: 100, sortKey: 'created_at', sortDirection: 'desc' };
  const frameKeys = transcript.map((frame) => Object.keys(frame ?? {}).sort().join('\0'));
  if (frameKeys[0] !== ['direction', 'id', 'method', 'observedAt', 'params'].sort().join('\0')
    || frameKeys[1] !== ['direction', 'id', 'observedAt', 'result'].sort().join('\0')
    || frameKeys[2] !== ['direction', 'id', 'method', 'observedAt', 'params'].sort().join('\0')
    || frameKeys[3] !== ['direction', 'id', 'observedAt', 'result'].sort().join('\0')
    || !isDeepStrictEqual({ direction: listRequest.direction, id: listRequest.id, method: listRequest.method, params: listRequest.params }, { direction: 'request', id: 1, method: 'thread/list', params: listParams })
    || listResponse?.direction !== 'response' || listResponse?.id !== 1 || !Array.isArray(listResponse?.result?.data)
    || listResponse.result.data.length < 1 || listResponse.result.data.length > 64
    || listResponse.result.nextCursor !== null || listResponse.result.backwardsCursor !== null
    || !isDeepStrictEqual({ direction: readRequest.direction, id: readRequest.id, method: readRequest.method, params: readRequest.params }, { direction: 'request', id: 2, method: 'thread/read', params: { threadId: expected.childThreadId, includeTurns: false } })
    || readResponse?.direction !== 'response' || readResponse?.id !== 2 || !readResponse?.result?.thread) mismatch('restored-child-app-server', 'Installed app-server capture is missing or changed its exact list/read protocol.');
  let hosts; let host; let reread;
  try {
    hosts = listResponse.result.data.map((raw) => sanitizeCodexThreadSpawnChild(raw, expected.parentSessionId));
    if (new Set(hosts.map((candidate) => candidate.id)).size !== hosts.length
      || new Set(hosts.map((candidate) => candidate.agentPath)).size !== hosts.length) throw new Error('ambiguous child metadata');
    const matches = hosts.filter((candidate) => candidate.id === expected.childThreadId && candidate.agentPath === expected.agentPath);
    if (matches.length !== 1) throw new Error('missing exact target');
    [host] = matches;
    reread = sanitizeCodexThreadSpawnChild(readResponse.result.thread, expected.parentSessionId, expected.childThreadId);
  }
  catch { mismatch('restored-child-host', 'Raw installed app-server child metadata is invalid.'); }
  const immutableIdentity = (child, raw) => ({ id: child.id, parentThreadId: child.parentThreadId, agentPath: child.agentPath,
    agentRole: child.agentRole, cwd: child.cwd, createdAt: child.createdAt, source: {
      parentThreadId: raw.source.subAgent.thread_spawn.parent_thread_id, depth: raw.source.subAgent.thread_spawn.depth,
      agentPath: raw.source.subAgent.thread_spawn.agent_path, agentRole: raw.source.subAgent.thread_spawn.agent_role,
    } });
  const rawHost = listResponse.result.data.find((candidate) => candidate.id === host.id && candidate.source?.subAgent?.thread_spawn?.agent_path === host.agentPath);
  if (!isDeepStrictEqual(immutableIdentity(host, rawHost), immutableIdentity(reread, readResponse.result.thread))) {
    mismatch('restored-child-host', 'List and read captures changed immutable child identity or spawn provenance.');
  }
  if (host?.id !== expected.childThreadId || host?.parentThreadId !== expected.parentSessionId || host?.agentPath !== expected.agentPath
    || host?.cwd !== expected.originWorkspace || host?.status?.type !== 'notLoaded' || reread?.status?.type !== 'active') mismatch('restored-child-host', 'Host discovery did not preserve the exact unloaded child identity and its lazy activation.');
  const appServerTimes = transcript.map((frame) => eventTimestamp({ timestamp: frame.observedAt }));
  const canonicalMillisecondObservation = (value) => { try { return typeof value === 'string' && new Date(value).toISOString() === value; } catch { return false; } };
  if (transcript.some((frame) => !canonicalMillisecondObservation(frame.observedAt)) || appServerTimes.some((value) => value === undefined)
    || appServerTimes.some((value, index) => index > 0 && value <= appServerTimes[index - 1])
    || !(eventTimestamp(prepareCall.event) < appServerTimes[0] && appServerTimes[1] < eventTimestamp(outputFor(prepareCall)))) {
    mismatch('restored-child-app-server', 'App-server discovery and lazy read are not causally ordered around preparation and accepted follow-up.');
  }
  if ([input.executorRecordBytes, input.preparationRecordBytes].some((bytes) => typeof bytes !== 'string' || Buffer.byteLength(bytes) > MAX_TEXT_BYTES)) mismatch('restored-child-private', 'Private restored-child records are absent or oversized.');
  if (!input.executorRecordBytes.endsWith('\n') || !input.preparationRecordBytes.endsWith('\n')) mismatch('restored-child-private', 'Private restored-child records are not exact file bytes.');
  let executor; let preparation; try { executor = JSON.parse(input.executorRecordBytes); preparation = JSON.parse(input.preparationRecordBytes); } catch { mismatch('restored-child-private', 'Private restored-child records are malformed.'); }
  const executorKeys = ['active', 'agentId', 'agentType', 'childTurnId', 'createdAt', 'kind', 'originWorkspace', 'parentGenerationId', 'parentPermissionMode', 'parentSessionId', 'parentTurnId', 'workspace'];
  const expectedAgentType = route === 'named' ? 'zcode-rescue' : 'default'; const expectedRole = route === 'named' ? 'zcode-rescue' : null;
  const hookKeys = ['agent_id', 'agent_type', 'cwd', 'hook_event_name', 'parent_turn_id', 'permission_mode', 'session_id', 'turn_id'];
  if (hooks.length !== 2 || hooks.some((hook) => Object.keys(hook ?? {}).sort().join('\0') !== hookKeys.sort().join('\0'))
    || hooks[0].hook_event_name !== 'SubagentStart' || hooks[1].hook_event_name !== 'SubagentStop'
    || !boundedString(hooks[0].turn_id) || hooks[1].turn_id !== hooks[0].turn_id
    || hooks.some((hook) => hook.session_id !== expected.parentSessionId || hook.parent_turn_id !== expected.originalParentTurnId
      || hook.agent_id !== expected.childThreadId || hook.agent_type !== expectedAgentType || hook.cwd !== expected.originWorkspace || hook.permission_mode !== expected.permissionMode)) {
    mismatch('restored-child-hooks', 'Raw hook Start/Stop evidence does not identify one exact original child turn.');
  }
  const executorCreated = eventTimestamp({ timestamp: executor?.createdAt });
  if (Object.keys(executor ?? {}).sort().join('\0') !== executorKeys.sort().join('\0') || executor.kind !== 'subagent-executor' || host.agentRole !== expectedRole
    || executor.agentType !== expectedAgentType || executor.agentId !== expected.childThreadId || executor.parentSessionId !== expected.parentSessionId
    || executor.parentTurnId !== expected.originalParentTurnId || executor.parentPermissionMode !== expected.permissionMode || executor.childTurnId !== hooks[0].turn_id
    || executor.active !== false || executor.workspace !== expected.executionWorkspace || executor.originWorkspace !== expected.originWorkspace
    || !/^[a-f0-9]{64}$/u.test(executor.parentGenerationId) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(executor.createdAt)
    || executorCreated === undefined || executorCreated < historicalTimes[0] || executorCreated > historicalTimes[3]
    || executorCreated >= eventTimestamp(roleCall.event)) mismatch('restored-child-executor', 'Stopped executor provenance does not match the production schema and original child lifecycle.');
  const preparationKeys = ['activation', 'consumedAt', 'createdAt', 'envelope', 'executorAgentId', 'expiresAt', 'generation', 'key', 'permissionMode', 'requiredExecutorAgentId', 'sessionId', 'source', 'turnId', 'version', 'workspace'];
  const expectedPreparationKey = createHash('sha256').update(JSON.stringify([expected.parentSessionId, expected.resumedParentTurnId, expected.executionWorkspace, 'rescue'])).digest('hex');
  const activationKeys = ['agentPathDigest', 'executorAgentId', 'kind'];
  const preparationCreated = eventTimestamp({ timestamp: preparation?.createdAt }); const preparationExpires = eventTimestamp({ timestamp: preparation?.expiresAt }); const preparationConsumed = eventTimestamp({ timestamp: preparation?.consumedAt });
  if (Object.keys(preparation ?? {}).sort().join('\0') !== preparationKeys.sort().join('\0') || preparation.version !== 3 || preparation.key !== expectedPreparationKey
    || preparation.sessionId !== expected.parentSessionId || preparation.turnId !== expected.resumedParentTurnId || preparation.workspace !== expected.executionWorkspace
    || preparation.permissionMode !== expected.permissionMode || preparation.source !== 'proactive' || !isDeepStrictEqual(preparation.envelope, preparationEnvelope)
    || preparationEnvelope.source !== preparation.source || preparationEnvelope.options.execution !== 'foreground' || preparationEnvelope.options.resume !== 'resume'
    || preparation.generation !== 1 || preparation.requiredExecutorAgentId !== null || Object.keys(preparation.activation ?? {}).sort().join('\0') !== activationKeys.sort().join('\0')
    || preparation.activation.kind !== 'reactivate' || preparation.activation.executorAgentId !== expected.childThreadId
    || preparation.activation.agentPathDigest !== createHash('sha256').update(expected.agentPath).digest('hex') || preparation.executorAgentId !== expected.childThreadId
    || [preparationCreated, preparationExpires, preparationConsumed].some((value) => value === undefined) || preparationExpires - preparationCreated !== 30n * 60n * 1_000_000_000n
    || preparationConsumed < preparationCreated || preparationConsumed >= preparationExpires) mismatch('restored-child-activation', 'Generation-one preparation is not a full exact linked v3 reactivate record.');
  await assertRestoredPreparationWithProduction(preparation, expected);

  const childCalls = child.filter((event) => event?.payload?.type === 'custom_tool_call'); const childOutputs = child.filter((event) => event?.payload?.type === 'custom_tool_call_output');
  if (child.length !== 2 || childCalls.length !== 1 || childOutputs.length !== 1 || childCalls[0].thread_id !== expected.childThreadId || childOutputs[0].thread_id !== expected.childThreadId) mismatch('restored-child-invocation', 'The restored child capture contains an extra or missing host event.');
  const childHost = parseCapturedHostCall(childCalls[0].payload.input); const childResult = parseCapturedHostResult(childOutputs[0].payload.output);
  const childCallTime = eventTimestamp(childCalls[0]); const childOutputTime = eventTimestamp(childOutputs[0]);
  const currentTimes = [roleCall.event, outputFor(roleCall), prepareCall.event, outputFor(prepareCall), writeCall.event, outputFor(writeCall), followupCall, currentFunctionOutputs[0], childCalls[0], childOutputs[0]].map(eventTimestamp);
  if (currentTimes.some((value) => value === undefined) || currentTimes.some((value, index) => index > 0 && value <= currentTimes[index - 1])
    || childHost.kind !== 'exec_command' || Object.keys(Object.fromEntries(childHost.envelope)).sort().join('\0') !== ['cmd', 'workdir'].join('\0')
    || childHost.envelope.get('cmd') !== `${expected.launcherCommand} invoke-prepared rescue` || childHost.envelope.get('workdir') !== expected.originWorkspace
    || childResult.output !== expected.publicOutput || childResult.exit_code !== 0 || Object.hasOwn(childResult, 'session_id')
    || !(preparationCreated > eventTimestamp(writeCall.event) && preparationCreated < eventTimestamp(outputFor(writeCall))
      && eventTimestamp(currentFunctionOutputs[0]) < childCallTime && childCallTime < appServerTimes[2]
      // Both the app-server capture and preparation store use Date#toISOString.
      // Equal millisecond stamps can still preserve response-before-consume program order.
      && appServerTimes[3] <= preparationConsumed && preparationConsumed < childOutputTime)) mismatch('restored-child-invocation', 'Restored Role, prepare, follow-up, host read proof, consumption, and child execution chronology is invalid.');
  assertParentPreparationTaskExclusivity(parent, writeCall.event, preparationEnvelope.task, parsedCurrent, currentCustomOutputs.map((event) => ({ event })));
  if ([child, transcript, hooks, peer].some((surface) => stringLeafContains(surface, preparationEnvelope.task))) mismatch('restored-child-private-task', 'The private preparation task escaped its authorized write or private record.');
  if ([child, hooks, peer].some((surface) => JSON.stringify(surface).includes('continuationTarget'))) mismatch('restored-child-private-target', 'The serialized continuation target escaped its private preparation boundary.');
  if (peer.length !== 2 || peer[0]?.method !== 'session/resume' || peer[0]?.params?.sessionId !== expected.zcodeSessionId
    || peer[0]?.params?.workspace?.workspacePath !== expected.executionWorkspace || peer[1]?.method !== 'session/send'
    || peer[1]?.params?.sessionId !== expected.zcodeSessionId || peer[1]?.params?.response !== expected.publicOutput) mismatch('restored-child-peer', 'Fake ZCode evidence does not resume the exact original session in the immutable target worktree.');
  if (expected.originWorkspace !== expected.executionWorkspace) await validateCanonicalGitLineage(expected.originWorkspace, expected.executionWorkspace);
  return { route, parentSessionId: expected.parentSessionId, childThreadId: expected.childThreadId, agentPath: expected.agentPath,
    originalParentTurnId: expected.originalParentTurnId, resumedParentTurnId: expected.resumedParentTurnId,
    originWorkspace: expected.originWorkspace, executionWorkspace: expected.executionWorkspace,
    followupCount: 1, spawnCount: 0, childInvocationCount: 1, restoredInitiallyUnloaded: true, collisionCount: 0 };
}

async function assertRestoredPreparationWithProduction(record, expected) {
  const dataRoot = await mkdtemp(join(tmpdir(), 'zcode-restored-preparation-'));
  try {
    const store = createRescuePreparationStore({ dataRoot });
    const identity = { sessionId: expected.parentSessionId, turnId: expected.resumedParentTurnId,
      workspace: expected.executionWorkspace, permissionMode: expected.permissionMode };
    await store.save({ ...identity, envelope: record.envelope, activation: record.activation,
      recordedPrompt: 'proactive restored qualification', now: record.createdAt });
    const consumed = await store.consume({ ...identity, executorAgentId: expected.childThreadId,
      activationProof: { kind: 'reactivate', agentPathDigest: record.activation.agentPathDigest }, now: record.consumedAt });
    if (!isDeepStrictEqual(consumed, record)) mismatch('restored-child-activation', 'Production preparation storage did not reproduce the exact consumed reactivate record.');
  } catch (error) {
    if (error instanceof CodexRescueEvidenceMismatchError) throw error;
    mismatch('restored-child-activation', 'Production preparation storage rejected the restored reactivate record.');
  } finally { await rm(dataRoot, { recursive: true, force: true }); }
}

function validateLiveRawContinuationCapture(input, core) {
  const fields = ['rawParentRolloutJson', 'rawChildRolloutJson', 'rawHookLifecycleJson', 'rawFakePeerJson', 'artifactHistoryJson'];
  if (fields.every((field) => input[field] === undefined)) return null;
  if (fields.some((field) => typeof input[field] !== 'string')) mismatch('continuation-raw-capture', 'Live continuation evidence must include every complete raw capture.');
  const parse = (field) => { if (Buffer.byteLength(input[field]) > MAX_ROLLOUT_BYTES) mismatch('continuation-raw-capture', `Live ${field} exceeds its byte bound.`); let value; try { value = JSON.parse(input[field]); } catch { mismatch('continuation-raw-capture', `Live ${field} is malformed.`); }
    if (!Array.isArray(value) || value.length > MAX_EVENTS_PER_ROLLOUT || value.some((event) => Buffer.byteLength(JSON.stringify(event)) > MAX_TEXT_BYTES)) mismatch('continuation-raw-capture', `Live ${field} exceeds its bound.`); return value; };
  const rawParent = parse('rawParentRolloutJson'); const rawChild = parse('rawChildRolloutJson'); const rawHooks = parse('rawHookLifecycleJson'); const rawPeer = parse('rawFakePeerJson'); const history = parse('artifactHistoryJson');
  assertRawSubset(core.parent, rawParent, 'parent'); assertRawSubset(core.child, rawChild, 'child'); assertRawSubset(core.hooks, rawHooks, 'hooks'); assertRawSubset(core.peer, rawPeer, 'peer');
  const parentFunctions = rawParent.filter((event) => event?.payload?.type === 'function_call');
  if (parentFunctions.filter((event) => event.payload.name === 'spawn_agent').length !== 1 || parentFunctions.filter((event) => event.payload.name === 'followup_task').length !== 1
    || parentFunctions.some((event) => !['spawn_agent', 'followup_task'].includes(event.payload.name))) mismatch('continuation-raw-parent-events', 'Complete parent capture contains an extra orchestration call.');
  assertAllowedRawHostCalls(rawParent, 'parent'); assertAllowedRawHostCalls(rawChild, 'child');
  const rawParentCommands = rawParent.filter((event) => event?.payload?.type === 'custom_tool_call').map((event) => parseCapturedHostCall(event.payload.input));
  if (rawParentCommands.filter((host) => host.envelope.get('cmd')?.endsWith('/skills/rescue/launcher.mjs" prepare rescue')).length !== 2
    || rawParentCommands.filter((host) => host.kind === 'write_stdin').length !== 2
    || rawParent.filter((event) => event?.payload?.type === 'sub_agent_activity' && event.payload.kind === 'started').length !== 1
    || rawParent.filter((event) => event?.payload?.type === 'sub_agent_activity' && event.payload.kind === 'stopped').length !== 1) mismatch('continuation-raw-parent-events', 'Complete parent capture duplicates or omits a required lifecycle event.');
  const rawChildCommands = rawChild.filter((event) => event?.payload?.type === 'custom_tool_call').map((event) => parseCapturedHostCall(event.payload.input));
  if (rawChildCommands.filter((host) => host.envelope.get('cmd')?.endsWith('/skills/rescue/launcher.mjs" invoke-prepared rescue')).length !== 2
    || rawChildCommands.filter((host) => host.kind === 'write_stdin').length > MAX_CHILD_POLLS) mismatch('continuation-raw-child-events', 'Complete child capture duplicates or omits invoke-prepared evidence.');
  const consumedChildWriteIds = new Set();
  for (const invoke of rawChild.filter((event) => event?.payload?.type === 'custom_tool_call' && parseCapturedHostCall(event.payload.input).envelope.get('cmd')?.endsWith('/skills/rescue/launcher.mjs" invoke-prepared rescue'))) {
    const calls = rawChild.filter((event) => event?.turn_id === invoke.turn_id && event?.payload?.type === 'custom_tool_call'
      && (event === invoke || parseCapturedHostCall(event.payload.input).kind === 'write_stdin'));
    for (const call of calls.filter((event) => parseCapturedHostCall(event.payload.input).kind === 'write_stdin')) {
      if (consumedChildWriteIds.has(call.payload.call_id)) mismatch('continuation-raw-child-events', 'A child poll belongs to more than one invoke segment.'); consumedChildWriteIds.add(call.payload.call_id);
    }
    const ids = new Set(calls.map((event) => event.payload.call_id)); const outputs = rawChild.filter((event) => event?.turn_id === invoke.turn_id && event?.payload?.type === 'custom_tool_call_output' && ids.has(event.payload.call_id));
    validateChildExecution(rawChild, calls, outputs, parseCapturedHostCall(invoke.payload.input).envelope.get('cmd'), core.expected.originWorkspace ?? core.expected.workspace, { codePrefix: 'continuation-raw-child', expectedExitCode: 0 });
  }
  const allChildWriteIds = rawChild.filter((event) => event?.payload?.type === 'custom_tool_call' && parseCapturedHostCall(event.payload.input).kind === 'write_stdin').map((event) => event.payload.call_id);
  if (allChildWriteIds.length !== consumedChildWriteIds.size || allChildWriteIds.some((id) => !consumedChildWriteIds.has(id))) mismatch('continuation-raw-child-events', 'A raw child poll is not owned by exactly one invoke segment.');
  const starts = rawHooks.filter((event) => event?.hook_event_name === 'SubagentStart'); const stops = rawHooks.filter((event) => event?.hook_event_name === 'SubagentStop');
  const prompts = rawHooks.filter((event) => event?.hook_event_name === 'UserPromptSubmit');
  if (starts.length !== 1 || stops.length !== 1 || prompts.length !== 1 || prompts[0].turn_id !== core.expected.originalParentTurnId
    || rawHooks.some((event) => !['SubagentStart', 'SubagentStop', 'UserPromptSubmit'].includes(event?.hook_event_name))
    || !(rawHooks.indexOf(prompts[0]) < rawHooks.indexOf(starts[0]) && rawHooks.indexOf(starts[0]) < rawHooks.indexOf(stops[0]))) mismatch('continuation-raw-hook-events', 'Complete hook capture contains duplicates, extras, or invalid order.');
  if (rawPeer.length !== 4 || rawPeer.filter((event) => event?.method === 'session/create').length !== 1 || rawPeer.filter((event) => event?.method === 'session/resume').length !== 1
    || rawPeer.filter((event) => event?.method === 'session/send').length !== 2) mismatch('continuation-raw-peer-events', 'Complete fake-peer capture contains an extra or missing request.');
  validateImmutableArtifactHistory(history, input);
  return { publicEvidence: { parent: redactValidatedPreparationInputs(rawParent), child: rawChild } };
}

function assertRawSubset(projected, raw, label) {
  const counts = new Map(); for (const event of raw) { const key = JSON.stringify(event); counts.set(key, (counts.get(key) ?? 0) + 1); }
  for (const event of projected) { const key = JSON.stringify(event); const remaining = counts.get(key) ?? 0; if (remaining < 1) mismatch('continuation-raw-capture', `Projected ${label} evidence was not captured raw.`); counts.set(key, remaining - 1); }
}

function assertAllowedRawHostCalls(events, role) {
  const calls = events.filter((event) => event?.payload?.type === 'custom_tool_call');
  for (const call of calls) {
    const host = parseCapturedHostCall(call.payload.input); const command = host.envelope.get('cmd');
    const allowed = role === 'parent'
      ? host.kind === 'write_stdin' || typeof command === 'string' && (command.endsWith('/skills/rescue/launcher.mjs" prepare rescue') || command.endsWith('/skills/rescue/launcher.mjs" role-status rescue') || command.endsWith('/skills/rescue/launcher.mjs" invoke-status rescue'))
      : host.kind === 'write_stdin' || typeof command === 'string' && (command.endsWith('/skills/rescue/launcher.mjs" invoke-prepared rescue') || command.endsWith('/skills/rescue/launcher.mjs" invoke-status rescue'));
    if (!allowed) mismatch(`continuation-raw-${role}-events`, `Complete ${role} capture contains an extra host call.`);
  }
  const allCalls = events.filter((event) => ['custom_tool_call', 'function_call'].includes(event?.payload?.type));
  const outputs = events.filter((event) => ['custom_tool_call_output', 'function_call_output'].includes(event?.payload?.type));
  const callIds = allCalls.map((event) => event.payload.call_id);
  if (new Set(callIds).size !== callIds.length || allCalls.some((call) => outputs.filter((output) => output.payload.call_id === call.payload.call_id).length !== 1)
    || outputs.some((output) => allCalls.filter((call) => call.payload.call_id === output.payload.call_id).length !== 1)) mismatch(`continuation-raw-${role}-events`, `Complete ${role} capture contains an orphan or duplicate host result.`);
}

function validateImmutableArtifactHistory(history, input) {
  const immutable = new Map(); const preparationHistory = new Map(); const executorHistory = new Map(); const bindingHistory = new Map(); const jobHistory = new Map();
  let previousSequence = 0;
  for (const artifact of history) {
    if (!artifact || typeof artifact.path !== 'string' || Buffer.byteLength(artifact.path) > 4096 || typeof artifact.bytes !== 'string' || Buffer.byteLength(artifact.bytes) > MAX_ROLLOUT_BYTES
      || artifact.sequence !== null && (!Number.isSafeInteger(artifact.sequence) || artifact.sequence < previousSequence)) mismatch('continuation-artifact-history', 'Raw artifact history is malformed.');
    if (artifact.sequence !== null) previousSequence = artifact.sequence;
    let value; try { value = JSON.parse(artifact.bytes); } catch { continue; }
    let identity;
    if (artifact.path.includes('invocations/prepared/') && value?.consumedAt) appendHistory(preparationHistory, artifact.path, value);
    else if (artifact.path.includes('rescue-binding-authority-')) identity = `authority-path:${artifact.path}`;
    if (identity) { const previous = immutable.get(identity); if (previous !== undefined && previous !== artifact.bytes) mismatch('continuation-artifact-history', 'An immutable captured artifact changed across phases.');
      immutable.set(identity, artifact.bytes); }
    if (artifact.path.includes('hook-state/executor-') && value?.agentId) appendHistory(executorHistory, value.agentId, value);
    if (artifact.path.includes('rescue-binding-session-') && Array.isArray(value?.records)) for (const record of value.records) appendHistory(bindingHistory, record.key, record);
    if (artifact.path.startsWith('jobs/') && value?.id) appendHistory(jobHistory, value.id, value);
  }
  if (immutable.size < 1 || preparationHistory.size !== 1 || executorHistory.size !== 1 || bindingHistory.size !== 1 || jobHistory.size !== 2) mismatch('continuation-artifact-history', 'Complete artifact history is missing mandatory authority records.');
  let preparations; let jobs; try { preparations = JSON.parse(input.preparationRecordBytesJson); jobs = JSON.parse(input.jobRecordBytesJson); } catch { mismatch('continuation-artifact-history', 'Selected artifact bytes are malformed.'); }
  let activeTurn; let executor; let authority; let prePartition; let partition; try { activeTurn = JSON.parse(input.activeTurnRecordBytes); executor = JSON.parse(input.executorRecordBytes); authority = JSON.parse(input.bindingAuthorityBytes); prePartition = JSON.parse(input.bindingPreReservationBytes); partition = JSON.parse(input.bindingPartitionBytes); } catch { mismatch('continuation-artifact-history', 'Selected authority bytes are malformed.'); }
  const executorKey = createHash('sha256').update(JSON.stringify(['executor', executor.agentId])).digest('hex');
  const expectedArtifacts = [
    [`identity/active-turns/${activeTurn.key}.json`, input.activeTurnRecordBytes],
    [`hook-state/executor-${executorKey}.json`, input.executorRecordBytes],
    [`rescue-binding-authority-${authority.key}.json`, input.bindingAuthorityBytes],
    [`rescue-binding-session-${prePartition.key}.json`, input.bindingPreReservationBytes],
    [`rescue-binding-session-${partition.key}.json`, input.bindingPartitionBytes],
    ...preparations.map((bytes) => [`invocations/prepared/${JSON.parse(bytes).key}.json`, bytes]),
    ...jobs.map((bytes) => [`jobs/${JSON.parse(bytes).id}.json`, bytes]),
  ];
  const corePath = /^(?:hook-state\/executor-[a-f0-9]{64}|rescue-binding-(?:authority|session)-[a-f0-9]{64}|invocations\/prepared\/[a-f0-9]{64}|jobs\/[a-f0-9]{64})\.json$/u;
  for (const artifact of history) {
    const safe = artifact.path.length > 0 && !artifact.path.startsWith('/') && !artifact.path.includes('\\') && !artifact.path.includes('//')
      && artifact.path.split('/').every((segment) => segment && segment !== '.' && segment !== '..' && /^[A-Za-z0-9._-]+$/u.test(segment));
    const coreNearMiss = /^(?:hook-state\/executor-|rescue-binding-(?:authority|session)-|invocations\/prepared\/[a-f0-9]+\.json$|jobs\/[a-f0-9]+\.json$)/u.test(artifact.path);
    if (!safe || coreNearMiss && !corePath.test(artifact.path)) mismatch('continuation-artifact-history', 'Raw artifact history contains an unsafe or malformed authority path.');
  }
  for (const [path, bytes] of expectedArtifacts) if (!history.some((artifact) => artifact.path === path && artifact.bytes === bytes)) mismatch('continuation-artifact-history', 'Selected authority bytes are absent from their exact captured path.');
  for (const versions of preparationHistory.values()) {
    if (versions.length !== 2 || versions[0].version !== 3 || versions[0].generation !== 1 || versions[0].requiredExecutorAgentId !== null
      || versions[0].activation?.kind !== 'spawn' || versions[1].version !== 3 || versions[1].generation !== 2
      || versions[1].activation?.kind !== 'reactivate' || versions[1].activation.executorAgentId !== versions[0].executorAgentId
      || versions[1].requiredExecutorAgentId !== versions[0].executorAgentId
      || versions.some((record) => record.consumedAt === null || record.executorAgentId !== versions[0].executorAgentId)
      || JSON.stringify(Object.fromEntries(Object.entries(versions[0]).filter(([key]) => !['activation', 'createdAt', 'expiresAt', 'consumedAt', 'envelope', 'generation', 'requiredExecutorAgentId', 'source'].includes(key))))
        !== JSON.stringify(Object.fromEntries(Object.entries(versions[1]).filter(([key]) => !['activation', 'createdAt', 'expiresAt', 'consumedAt', 'envelope', 'generation', 'requiredExecutorAgentId', 'source'].includes(key))))) {
      mismatch('continuation-artifact-history', 'Preparation history is not the sole legal consumed generation 1 to consumed generation 2 replacement.');
    }
  }
  for (const versions of executorHistory.values()) assertStableVersions(versions, ['active'], 'executor');
  for (const versions of bindingHistory.values()) assertStableVersions(versions, ['currentJobId', 'permissionMode', 'updatedAt'], 'binding');
  for (const versions of jobHistory.values()) assertStableFields(versions, ['id', 'workspace', 'ownerSessionId', 'ownerTurnId', 'command', 'readOnly', 'permissionSnapshot'], 'job');
}

function appendHistory(map, key, value) { const versions = map.get(key) ?? []; versions.push(value); map.set(key, versions); }
function assertStableVersions(versions, mutableKeys, label) {
  const stable = (value) => Object.fromEntries(Object.entries(value).filter(([key]) => !mutableKeys.includes(key)));
  const expected = JSON.stringify(stable(versions[0]));
  if (versions.some((value) => JSON.stringify(stable(value)) !== expected)) mismatch('continuation-artifact-history', `Captured ${label} authority was rewritten across phases.`);
}
function assertStableFields(versions, keys, label) {
  const expected = JSON.stringify(Object.fromEntries(keys.map((key) => [key, versions[0]?.[key]])));
  if (versions.some((value) => JSON.stringify(Object.fromEntries(keys.map((key) => [key, value?.[key]]))) !== expected)) mismatch('continuation-artifact-history', `Captured ${label} identity was rewritten across phases.`);
}

function validCapturedPeerModel(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value); return keys.includes('providerId') && keys.includes('modelId')
    && keys.every((key) => ['providerId', 'modelId', 'variant'].includes(key))
    && Boolean(boundedString(value.providerId)) && Boolean(boundedString(value.modelId))
    && (value.variant === undefined || Boolean(boundedString(value.variant)));
}

function validCapturedImportedHistory(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value); if (!keys.includes('messages') || value.source !== 'claudeCode' || keys.some((key) => !['source', 'title', 'createdAt', 'updatedAt', 'messages'].includes(key))
    || !Array.isArray(value.messages) || value.messages.length === 0 || value.messages.length > 10_000) return false;
  if (value.title !== undefined && !boundedString(value.title)) return false;
  if ([value.createdAt, value.updatedAt].some((entry) => entry !== undefined && (!Number.isSafeInteger(entry) || entry < 0))) return false;
  return value.messages.every((message) => message && typeof message === 'object' && !Array.isArray(message)
    && Object.keys(message).every((key) => ['role', 'content', 'timestamp'].includes(key))
    && ['user', 'assistant'].includes(message.role) && Boolean(boundedString(message.content))
    && (message.timestamp === undefined || Number.isSafeInteger(message.timestamp) && message.timestamp >= 0));
}

function qualifyCodexRescueEvidenceCore(input, options, deferEncryptedSpawnUnqualified) {
  const execFrames = boundedArray(input?.execFrames, MAX_EXEC_FRAMES, 'exec-frames');
  const rollouts = boundedArray(input?.rollouts, MAX_ROLLOUTS, 'rollouts');
  for (const rollout of rollouts) boundedArray(rollout, MAX_EVENTS_PER_ROLLOUT, 'rollout-events');

  const parentThreadIds = unique(execFrames
    .filter((frame) => frame?.type === 'thread.started')
    .map((frame) => boundedString(frame.thread_id))
    .filter(Boolean));
  if (parentThreadIds.length === 0) mismatch('parent-thread-unavailable', 'Codex exec JSON did not expose a parent thread ID.');
  if (parentThreadIds.length !== 1) mismatch('parent-thread-ambiguous', 'Codex exec JSON exposed conflicting parent thread IDs.');
  const parentThreadId = parentThreadIds[0];

  const parentCandidates = rollouts.filter((events) => {
    const meta = sessionMeta(events);
    return meta?.id === parentThreadId;
  });
  if (parentCandidates.length === 0) mismatch('parent-rollout-unavailable', 'No rollout contains the exec parent session metadata.');
  if (parentCandidates.length !== 1) mismatch('parent-rollout-ambiguous', 'Multiple rollouts claim the exec parent thread ID.');
  const parent = parentCandidates[0];
  const parentMeta = sessionMeta(parent);
  if (parentMeta.session_id !== parentThreadId
    || Object.hasOwn(parentMeta, 'parent_thread_id')
    || parentMeta.thread_source !== 'user'
    || parentMeta.source !== 'exec') {
    mismatch('parent-session-mismatch', 'Parent session metadata does not describe a top-level user thread.');
  }

  const spawns = parent.filter((event) => event?.type === 'response_item' && event.payload?.type === 'function_call' && event.payload.name === 'spawn_agent');
  if (spawns.length === 0) mismatch('spawn-metadata-unavailable', 'The parent rollout did not expose spawn_agent metadata.');
  if (spawns.length !== 1) mismatch('spawn-count', 'The parent rollout contains more than one spawn_agent call.');
  const spawn = spawns[0].payload;
  const spawnArgs = parseObject(spawn.arguments, 'spawn-arguments');
  const spawnMessage = boundedString(spawnArgs.message);
  const taskName = boundedString(spawnArgs.task_name);
  if (!taskName || spawnArgs.fork_turns !== 'none') {
    mismatch('spawn-contract-mismatch', 'The native spawn task or context mode differs from the Rescue contract.');
  }

  const starts = parent.filter((event) => event?.type === 'event_msg'
    && event.payload?.type === 'sub_agent_activity'
    && event.payload.kind === 'started');
  if (starts.length === 0) mismatch('child-start-unavailable', 'The parent rollout did not expose a child start event.');
  if (starts.length !== 1) mismatch('child-start-count', 'The parent rollout contains more than one child start event.');
  const start = starts[0].payload;
  const childThreadId = boundedString(start.agent_thread_id);
  const agentPath = boundedString(start.agent_path);
  if (!childThreadId || !agentPath) mismatch('child-identity-unavailable', 'The child start event omits its thread ID or agent path.');
  if (start.event_id !== spawn.call_id) mismatch('spawn-start-link-mismatch', 'The child start event does not link to the spawn call.');

  const childCandidates = rollouts.filter((events) => sessionMeta(events)?.id === childThreadId);
  if (childCandidates.length === 0) {
    const linkedChildren = rollouts.filter((events) => {
      const meta = sessionMeta(events);
      return meta?.thread_source === 'subagent'
        && (meta.parent_thread_id === parentThreadId || meta.source?.subagent?.thread_spawn?.parent_thread_id === parentThreadId);
    });
    if (linkedChildren.length > 0) mismatch('child-rollout-id-mismatch', 'A child rollout links to the parent but not to the observed child start ID.');
    mismatch('child-rollout-unavailable', 'No rollout contains the started child thread metadata.');
  }
  if (childCandidates.length !== 1) mismatch('child-rollout-ambiguous', 'Multiple rollouts claim the started child thread ID.');
  const child = childCandidates[0];
  const childMeta = sessionMeta(child);
  const threadSpawn = childMeta.source?.subagent?.thread_spawn;
  validateParentChildRoute({ parentMeta, parentThreadId, start, childMeta, childThreadId, agentPath, codePrefix: '' });
  validateForwarderChildEvents(child, options);

  let route;
  let agentType;
  let expectedSpawnMessage;
  if (Object.hasOwn(spawnArgs, 'agent_type')) {
    assertExactKeys(spawnArgs, ['agent_type', 'fork_turns', 'message', 'task_name'], 'spawn-keys-mismatch');
    if (spawnArgs.agent_type !== options.expectedAgentType) mismatch('agent-type-mismatch', 'Named spawn metadata does not select the managed Rescue Role.');
    if (threadSpawn.agent_role !== options.expectedAgentType) mismatch('agent-role-mismatch', 'Child session metadata does not report the managed Rescue Role.');
    route = 'named'; agentType = options.expectedAgentType; expectedSpawnMessage = options.expectedNamedSpawnMessage;
  } else {
    assertExactKeys(spawnArgs, ['fork_turns', 'message', 'task_name'], 'spawn-keys-mismatch');
    if (!GENERIC_HIDDEN_SCHEMA_VERSIONS.has(parentMeta.cli_version)) mismatch('generic-schema-version-unqualified', 'The observed Codex version is not qualified for a schema-hidden generic route.');
    if (threadSpawn.agent_role !== null) mismatch('generic-agent-role-mismatch', 'A schema-hidden generic child must report a null agent_role.');
    route = 'generic-schema-hidden'; agentType = 'default'; expectedSpawnMessage = options.expectedGenericSpawnMessage;
  }

  const spawnIndex = parent.indexOf(spawns[0]);
  const startIndex = parent.indexOf(starts[0]);
  if (spawnIndex >= startIndex) mismatch('spawn-start-order', 'The linked child start must follow its spawn call.');
  assertParentPreparation(parent, spawnIndex, startIndex, { ...options, expectedTaskName: taskName });

  const allChildCalls = child.filter((event) => event?.type === 'response_item' && event.payload?.type === 'custom_tool_call');
  const allChildOutputs = child.filter((event) => event?.type === 'response_item' && event.payload?.type === 'custom_tool_call_output');
  if (options.requireProgressRelay) {
    const relayCalls = child.filter((event) => event?.type === 'response_item' && event.payload?.type === 'function_call');
    const relayOutputs = child.filter((event) => event?.type === 'response_item' && event.payload?.type === 'function_call_output');
    validateCallOutputOwnership(relayCalls, relayOutputs, 'progress-relay-call-id');
  }
  if (options.requireStatusSidecar) {
    const allHostCalls = child.filter((event) => event?.type === 'response_item'
      && ['custom_tool_call', 'function_call'].includes(event.payload?.type));
    const ids = allHostCalls.map((event) => boundedString(event.payload.call_id));
    if (ids.some((id) => !id) || new Set(ids).size !== ids.length) {
      mismatch('status-sidecar-call-id', 'The status sidecar requires a globally unique call ID.');
    }
  }
  if (options.requireProgressRelay || options.requireStatusSidecar) {
    const calls = child.filter((event) => event?.type === 'response_item'
      && ['custom_tool_call', 'function_call'].includes(event.payload?.type));
    const outputs = child.filter((event) => event?.type === 'response_item'
      && ['custom_tool_call_output', 'function_call_output'].includes(event.payload?.type));
    validateCallOutputOwnership(calls, outputs, options.requireStatusSidecar ? 'status-sidecar-call-id' : 'progress-relay-call-id');
  }
  const { statusCalls, statusOutputs, executionCalls, executionOutputs } = splitStatusSidecars(
    allChildCalls, allChildOutputs, options,
  );
  const childCalls = executionCalls;
  if (childCalls.length === 0) {
    const unsupportedCalls = child.filter((event) => event?.type === 'response_item'
      && event.payload?.type === 'function_call'
      && ['exec', 'exec_command'].includes(event.payload.name));
    if (unsupportedCalls.length > 0) mismatch('child-command-shape-mismatch', 'The child command used a tool-call shape not captured for Codex 0.147.');
    mismatch('child-command-unavailable', 'The child rollout did not expose structured tool-call evidence.');
  }
  const childOutputs = executionOutputs;
  if (childOutputs.length === 0) mismatch('child-output-count', 'The child rollout has no structured exec output.');
  const execution = validateChildExecution(child, childCalls, childOutputs, options.expectedCommand, options.expectedWorkspace, {
    expectedExitCode: 0, allowLegacyWithoutExit: true,
  });
  const relay = validateProgressRelays({ child, parent, execution, agentPath, startIndex, options });
  const statusSidecarChecked = validateStatusSidecars({ child, statusCalls, statusOutputs, execution, options });
  if (options.requireStatusSidecar && !statusSidecarChecked) mismatch('status-sidecar-count', 'Required status evidence must contain one linked status sidecar.');
  assertSemanticProgress(execution.output, options.expectedSemanticProgress);
  assertTerminalSentinel(execution.output, options.expectedPublicOutput);
  const childFinalIndex = child.findIndex((event) => event?.type === 'event_msg' && event.payload?.type === 'agent_message' && event.payload.phase === 'final_answer');
  if (childFinalIndex <= execution.terminalEventIndex) mismatch('child-terminal-order', 'The child final message must follow its terminal companion output.');

  assertParentIsolation(parent, options, options.forbiddenParentText ?? []);
  validateParentCallOwnership(parent, 'parent-call-id');

  const childReturnIndex = parent.findIndex((event) => event?.type === 'response_item' && event.payload?.type === 'agent_message'
    && event.payload.author === agentPath && event.payload.recipient === '/root'
    && event.payload.content?.some((item) => item?.type === 'input_text' && item.text?.startsWith('Message Type: FINAL_ANSWER\n')));
  const parentFinalIndex = parent.findIndex((event) => event?.type === 'event_msg' && event.payload?.type === 'agent_message' && event.payload.phase === 'final_answer');
  if (childReturnIndex < startIndex || parentFinalIndex <= childReturnIndex) mismatch('parent-terminal-order', 'The linked child return and parent final message are out of order.');
  const terminalTimeline = [execution.terminalEvent, child[childFinalIndex], parent[childReturnIndex], parent[parentFinalIndex]].map(eventTimestamp);
  if (terminalTimeline.some((value) => value === undefined) || terminalTimeline.some((value, index) => index > 0 && value <= terminalTimeline[index - 1])) {
    mismatch('parent-terminal-timeline', 'Trusted timestamps do not prove child exit before child final, parent return, and parent final.');
  }

  const childFinal = finalRolloutMessage(child, 'child-terminal-unavailable');
  const childReturn = childReturnPayload(parent, agentPath);
  const parentFinal = finalRolloutMessage(parent, 'parent-terminal-unavailable');
  const execFinal = finalExecMessage(execFrames, options.expectedPublicOutput, parentThreadId);
  for (const actual of [childFinal, childReturn, parentFinal, execFinal]) {
    if (actual !== options.expectedPublicOutput) mismatch('public-output-mismatch', 'Child and parent terminal public output must equal the expected sentinel byte-for-byte.');
  }
  if (options.requireYieldedExecution && (execution.originalHandle === undefined || execution.pollCount < 1 || !Number.isSafeInteger(execution.terminalExitCode))) {
    mismatch('child-yielded-execution-required', 'Required native evidence does not contain a running handle, same-handle poll, and terminal exit code.');
  }
  const evidence = { parentThreadId, childThreadId, agentPath, taskName, agentType, route, publicOutput: execFinal,
    ...(options.expectedSemanticProgress === undefined ? {} : { semanticProgressChecked: true }),
    ...(options.requireProgressRelay ? { progressRelayChecked: relay.checked } : {}),
    ...(options.requireStatusSidecar ? { statusSidecarChecked } : {}),
    ...(options.requireYieldedExecution ? { yieldedExecution: {
      execCommandCount: execution.execCommandCount, pollCount: execution.pollCount,
      sameHandleChecked: true, terminalExitCode: execution.terminalExitCode,
    } } : {}) };
  if (!spawnMessage) mismatch('spawn-message-unavailable', 'The structured spawn metadata does not expose a bounded message field.');
  const spawnMessageEncrypted = encrypted(spawnMessage);
  if (!spawnMessageEncrypted && spawnMessage !== expectedSpawnMessage) mismatch('spawn-message-mismatch', 'The runtime spawn message differs from the fixed Rescue forwarder contract.');
  if (spawnMessageEncrypted && !deferEncryptedSpawnUnqualified) unqualified('spawn-message-encrypted', 'Codex 0.147 persisted the spawn message field as ciphertext, so its exact runtime value cannot be qualified.', evidence);

  return evidence;
}

function splitStatusSidecars(calls, outputs, options, codePrefix = '') {
  const code = (suffix) => codePrefix ? `${codePrefix}-${suffix}` : suffix;
  if (!options.expectedStatusCommand) {
    if (options.requireStatusSidecar) mismatch(code('status-sidecar-count'), 'Required status evidence has no fixed status command contract.');
    return { statusCalls: [], statusOutputs: [], executionCalls: calls, executionOutputs: outputs };
  }
  const parsed = calls.map((event) => ({ event, host: parseCapturedHostCall(event.payload.input) }));
  const execCommands = parsed.filter(({ host }) => host.kind === 'exec_command');
  const foreground = execCommands.filter(({ host }) => host.envelope.get('cmd') === options.expectedCommand);
  if (foreground.length !== 1) mismatch(codePrefix ? 'choice-command-count' : 'child-command-count', 'Required evidence does not identify one exact foreground Rescue execution.');
  const statusCalls = execCommands.filter(({ event }) => event !== foreground[0].event).map(({ event }) => event);
  if (statusCalls.length > 1 || (options.requireStatusSidecar && statusCalls.length !== 1)) {
    mismatch(code('status-sidecar-count'), 'Status evidence must contain at most one status sidecar beside the foreground execution.');
  }
  const statusIds = new Set(statusCalls.map((event) => event.payload.call_id));
  return {
    statusCalls,
    statusOutputs: outputs.filter((event) => statusIds.has(event.payload.call_id)),
    executionCalls: calls.filter((event) => !statusIds.has(event.payload.call_id)),
    executionOutputs: outputs.filter((event) => !statusIds.has(event.payload.call_id)),
  };
}

function validateStatusSidecars({ child, statusCalls, statusOutputs, execution, options, codePrefix = '' }) {
  const code = (suffix) => codePrefix ? `${codePrefix}-${suffix}` : suffix;
  if (statusCalls.length === 0 && statusOutputs.length === 0) return false;
  if (statusCalls.length !== 1 || statusOutputs.length !== 1) mismatch(code('status-sidecar-count'), 'Status evidence must contain one linked status sidecar.');
  const [call] = statusCalls; const [output] = statusOutputs;
  const allCalls = child.filter((event) => event?.type === 'response_item'
    && ['custom_tool_call', 'function_call'].includes(event.payload?.type));
  const ids = allCalls.map((event) => boundedString(event.payload.call_id));
  if (!call.payload.call_id || new Set(ids).size !== ids.length || output.payload.call_id !== call.payload.call_id) {
    mismatch(code('status-sidecar-call-id'), 'The status sidecar requires a globally unique linked call ID.');
  }
  const host = parseCapturedHostCall(call.payload.input);
  if (host.kind !== 'exec_command') mismatch(code('status-sidecar-command'), 'The status sidecar must be one constant direct command.');
  assertExecEnvelope(host.envelope, options.expectedStatusCommand, options.expectedWorkspace, code('status-sidecar-command'));
  const callIndex = child.indexOf(call); const outputIndex = child.indexOf(output);
  const firstRunningIndex = child.indexOf(execution.execEvent) + 1;
  if (callIndex <= firstRunningIndex || outputIndex <= callIndex || outputIndex >= execution.terminalEventIndex) {
    mismatch(code('status-sidecar-order'), 'The status sidecar must run between polls while the original handle remains live.');
  }
  const result = parseCapturedHostResult(output.payload.output);
  if (result.exit_code !== 0 || Object.hasOwn(result, 'session_id')) mismatch(code('status-sidecar-output'), 'The status sidecar must exit independently without a running handle.');
  let snapshot;
  try { snapshot = JSON.parse(result.output.trim()); } catch { mismatch(code('status-sidecar-output'), 'The status sidecar output is not the bounded public projection.'); }
  assertExactKeys(snapshot, ['lastActivityAt', 'phase', 'progressPreview', 'status', 'terminal', 'type'], code('status-sidecar-output'));
  const status = boundedString(snapshot.status); const phase = snapshot.phase === null ? null : boundedString(snapshot.phase);
  const canaries = Array.isArray(options.statusPrivacyCanaries) ? options.statusPrivacyCanaries.filter((value) => boundedString(value)) : [];
  if (snapshot.type !== 'rescue-status' || !PUBLIC_JOB_STATUSES.has(status)
    || !(phase === null || PUBLIC_PROGRESS_PHASES.has(phase))
    || !(snapshot.lastActivityAt === null || eventTimestamp({ timestamp: snapshot.lastActivityAt }) !== undefined)
    || !Array.isArray(snapshot.progressPreview)
    || snapshot.progressPreview.length > 4 || snapshot.progressPreview.some((line) => !safePublicProgressLine(line)
      || canaries.some((canary) => line.includes(canary)))
    || typeof snapshot.terminal !== 'boolean' || snapshot.terminal !== TERMINAL_JOB_STATUSES.has(status)) {
    mismatch(code('status-sidecar-output'), 'The status sidecar output is not the bounded public projection.');
  }
  return true;
}

function validateProgressRelays({ child, parent, execution, agentPath, options, codePrefix = '', identitySets }) {
  const code = (suffix) => codePrefix ? `${codePrefix}-${suffix}` : suffix;
  if (!options.requireProgressRelay) return { checked: false };
  const sourceCallIds = new Set(execution.callIds);
  const records = [];
  for (const event of child) {
    if (event?.payload?.type !== 'custom_tool_call_output' || !sourceCallIds.has(event.payload.call_id)) continue;
    const result = parseCapturedHostResult(event.payload.output);
    for (const completeLine of result.output.match(/[^\n]*\n/gu) ?? []) {
      if (!completeLine.startsWith(RESCUE_RELAY_PREFIX)) continue;
      let record;
      try { record = parseRescueProgressRelay(completeLine); } catch { mismatch(code('progress-relay-record'), 'A Rescue relay line failed strict wire validation.'); }
      records.push({ record, eventIndex: child.indexOf(event) });
    }
  }
  if (records.length === 0) mismatch(code('progress-relay-missing'), 'Required progress relay evidence is absent.');
  for (let index = 0; index < records.length; index += 1) {
    if (records[index].record.sequence !== index + 1) mismatch(code('progress-relay-sequence'), 'Rescue relay sequences must be strictly increasing from one.');
  }
  const calls = child.filter((event) => event?.type === 'response_item' && event.payload?.type === 'function_call');
  if (calls.length !== records.length || calls.some((event) => event.payload.name !== 'send_message')) {
    mismatch(code('progress-relay-count'), 'Each validated relay requires exactly one native send_message call.');
  }
  const outputs = child.filter((event) => event?.type === 'response_item' && event.payload?.type === 'function_call_output');
  validateCallOutputOwnership(calls, outputs, code('progress-relay-call-id'));
  const childMessages = [];
  for (let index = 0; index < calls.length; index += 1) {
    const call = calls[index]; const linked = outputs.find((event) => event.payload.call_id === call.payload.call_id);
    const args = parseObject(call.payload.arguments, code('progress-relay-arguments'));
    assertExactKeys(args, ['message', 'target'], code('progress-relay-keys'));
    if (args.target !== '/root') mismatch(code('progress-relay-target'), 'A Rescue progress relay may target only /root.');
    const expectedMessage = RESCUE_RELAY_MESSAGES[records[index].record.code];
    if (args.message !== expectedMessage) mismatch(code('progress-relay-content'), 'A Rescue progress relay must use the fixed code-to-message map.');
    if (linked.payload.output !== '') mismatch(code('progress-relay-output'), 'A Rescue relay tool output must remain empty.');
    const callIndex = child.indexOf(call); const outputIndex = child.indexOf(linked);
    if (callIndex <= records[index].eventIndex || outputIndex <= callIndex || outputIndex >= execution.terminalEventIndex) {
      mismatch(code(index > 0 && callIndex > execution.terminalEventIndex ? 'progress-relay-after-terminal' : 'progress-relay-order'), 'A Rescue relay must follow its validated line and precede terminal exit.');
    }
    childMessages.push(expectedMessage);
  }
  const parentMessages = parent.filter((event) => event?.type === 'response_item' && event.payload?.type === 'agent_message'
    && !event.payload.content?.some((item) => item?.type === 'input_text' && item.text?.startsWith('Message Type: FINAL_ANSWER\n')));
  if (parentMessages.length !== childMessages.length) mismatch(code('progress-relay-parent-count'), 'The parent must observe exactly the linked Rescue relay messages.');
  const messageIds = identitySets?.messageIds ?? new Set();
  const turnAssociations = identitySets?.turnAssociations ?? new Set();
  let segmentTurnId;
  for (let index = 0; index < parentMessages.length; index += 1) {
    const message = parentMessages[index];
    if (message.payload.author !== agentPath) mismatch(code('progress-relay-author'), 'Parent relay evidence must originate from the exact Rescue child.');
    const turnId = validateEncryptedParentRelay(message.payload, agentPath, messageIds, codePrefix);
    if (segmentTurnId === undefined) {
      if (turnAssociations.has(turnId)) mismatch(code('progress-relay-turn-association'), 'A Rescue logical child turn reused a foreign or prior turn association.');
      segmentTurnId = turnId; turnAssociations.add(turnId);
    } else if (turnId !== segmentTurnId) {
      mismatch(code('progress-relay-turn-association'), 'Every Rescue relay in one logical child turn must retain the same turn association.');
    }
    const messageIndex = parent.indexOf(message); const wait = parent[messageIndex + 1]; const waitOutput = parent[messageIndex + 2];
    if (wait?.payload?.type !== 'function_call' || wait.payload.name !== 'wait_agent'
      || waitOutput?.payload?.type !== 'function_call_output' || waitOutput.payload.call_id !== wait.payload.call_id) {
      mismatch(code('progress-relay-parent-wait'), 'Each parent relay update must be followed by a linked wait on the same Rescue child.');
    }
    const waitArgs = parseObject(wait.payload.arguments, code('progress-relay-parent-wait'));
    assertExactKeys(waitArgs, ['timeout_ms'], code('progress-relay-parent-wait'));
    if (waitArgs.timeout_ms !== 30000 || !boundedString(waitOutput.payload.output)) {
      mismatch(code('progress-relay-parent-wait'), 'Each parent relay update must be followed by the fixed bounded wait.');
    }
  }
  return { checked: true };
}

function validateEncryptedParentRelay(payload, agentPath, messageIds, codePrefix = '') {
  const code = (suffix) => codePrefix ? `${codePrefix}-${suffix}` : suffix;
  assertExactKeys(payload, ['author', 'content', 'id', 'internal_chat_message_metadata_passthrough', 'recipient', 'type'], code('progress-relay-parent-content'));
  if (payload.type !== 'agent_message' || payload.recipient !== '/root') mismatch(code('progress-relay-target'), 'Parent relay evidence must target only /root.');
  const id = boundedString(payload.id); const metadata = payload.internal_chat_message_metadata_passthrough;
  if (!id || !/^amsg_[A-Za-z0-9-]{16,96}$/u.test(id) || messageIds.has(id)) mismatch(code('progress-relay-call-id'), 'Parent relay message identity is absent, malformed, or reused.');
  messageIds.add(id);
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) mismatch(code('progress-relay-call-id'), 'Parent relay turn linkage is absent.');
  assertExactKeys(metadata, ['turn_id'], code('progress-relay-call-id'));
  const turnId = boundedString(metadata.turn_id);
  if (!turnId || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(turnId)) {
    mismatch(code('progress-relay-turn-association'), 'Parent relay turn association is malformed.');
  }
  if (!Array.isArray(payload.content) || payload.content.length !== 2) {
    mismatch(Array.isArray(payload.content) && !payload.content.some((item) => item?.type === 'encrypted_content')
      ? code('progress-relay-encrypted') : code('progress-relay-parent-content'), 'Parent relay evidence must contain only its route envelope and encrypted payload.');
  }
  const [envelope, encryptedPayload] = payload.content;
  assertExactKeys(envelope, ['text', 'type'], code('progress-relay-envelope'));
  if (envelope.type !== 'input_text'
    || envelope.text !== `Message Type: MESSAGE\nTask name: /root\nSender: ${agentPath}\nPayload:\n`) {
    mismatch(code('progress-relay-envelope'), 'Parent relay evidence has the wrong anchored route envelope.');
  }
  assertExactKeys(encryptedPayload, ['encrypted_content', 'type'], code('progress-relay-encrypted'));
  if (encryptedPayload.type !== 'encrypted_content' || !encrypted(encryptedPayload.encrypted_content)
    || Buffer.byteLength(encryptedPayload.encrypted_content, 'utf8') > MAX_TEXT_BYTES) {
    mismatch(code('progress-relay-encrypted'), 'Parent relay evidence lacks one bounded opaque encrypted payload.');
  }
  return turnId;
}

function safePublicProgressLine(value) {
  return typeof value === 'string' && value.length > 0
    && Buffer.byteLength(value, 'utf8') <= MAX_PUBLIC_PROGRESS_LINE_BYTES
    && !Array.from(value).some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
    });
}

function validateChildExecution(child, calls, outputs, expectedCommand, expectedWorkspace, options = {}) {
  const code = (suffix) => options.codePrefix ? `${options.codePrefix}-${suffix}` : `child-${suffix}`;
  const commandCountCode = options.commandCountCode ?? code('command-count');
  if (calls.length === 0 || calls.length > MAX_CHILD_POLLS + 1) {
    mismatch(commandCountCode, 'The child must use one exec_command and only bounded continuation polls.');
  }
  if (calls.some((call) => call.payload.name !== 'exec')) mismatch(code('tool-name'), 'Every captured child host wrapper must use the exact exec tool name.');
  const parsedCalls = calls.map((call) => parseCapturedHostCall(call.payload.input));
  if (parsedCalls.filter((call) => call.kind === 'exec_command').length !== 1) mismatch(commandCountCode, 'The child started more than one companion process.');
  if (outputs.length !== calls.length) mismatch(code('output-count'), 'Every child host call must have exactly one linked structured output.');
  const callIds = validateCallOutputOwnership(calls, outputs, code('call-id'));
  let execCount = 0; let handle; let terminalEventIndex = -1; let terminalCount = 0; let terminalExitCode; const normalized = []; const pollHandles = [];
  for (let index = 0; index < calls.length; index += 1) {
    const call = calls[index];
    const linked = outputs.filter((event) => event.payload.call_id === call.payload.call_id);
    if (linked.length !== 1) mismatch(code('output-link'), 'Every child host call must have exactly one linked output.');
    const outputEvent = linked[0];
    const callIndex = child.indexOf(call); const outputIndex = child.indexOf(outputEvent);
    if (callIndex >= outputIndex) mismatch(code('output-order'), 'A linked child host output must follow its call.');
    if (index > 0) {
      const previousOutput = outputs.find((event) => event.payload.call_id === calls[index - 1].payload.call_id);
      if (child.indexOf(previousOutput) >= callIndex) mismatch(code('output-order'), 'Each continuation call must follow the preceding host result.');
    }
    if (terminalCount > 0) mismatch(code('poll-after-terminal'), 'The child polled after the companion process exited.');
    const host = parsedCalls[index];
    if (host.kind === 'exec_command') {
      execCount += 1;
      if (execCount !== 1 || index !== 0) mismatch(commandCountCode, 'The child started more than one companion process.');
      if (options.commandMismatchCode && host.envelope.get('cmd') !== expectedCommand) mismatch(options.commandMismatchCode, 'The child continuation command differs from the selected constant command.');
      assertExecEnvelope(host.envelope, expectedCommand, expectedWorkspace, code('exec-envelope-mismatch'));
    } else {
      if (execCount !== 1 || handle === undefined) mismatch(code('handle-mismatch'), 'A continuation poll did not follow the original running handle.');
      assertPollEnvelope(host.envelope, handle, code);
      pollHandles.push(host.envelope.get('session_id'));
    }
    if (host.legacy) {
      if (calls.length !== 1) mismatch(code('terminal-exit-missing'), 'A multi-call child execution must expose structured host results.');
      if (!Array.isArray(outputEvent.payload.output) || outputEvent.payload.output.length < 1 || outputEvent.payload.output.length > 8
        || outputEvent.payload.output.some((item) => item?.type !== 'input_text' || boundedString(item.text) === undefined)) mismatch(code('terminal-exit-missing'), 'The one-shot captured result is not terminal.');
      normalized.push(...outputEvent.payload.output); terminalCount += 1; terminalEventIndex = outputIndex;
      continue;
    }
    const result = parseCapturedHostResult(outputEvent.payload.output);
    normalized.push({ type: 'input_text', text: result.output });
    const hasHandle = Object.hasOwn(result, 'session_id'); const hasExit = Object.hasOwn(result, 'exit_code');
    if (hasHandle === hasExit) mismatch(code('terminal-exit-missing'), 'A captured host result must expose either one running handle or one exit code.');
    if (hasHandle) {
      if (!Number.isSafeInteger(result.session_id) || result.session_id <= 0) mismatch(code('handle-invalid'), 'The running execution handle is not a positive safe integer.');
      if (handle === undefined) handle = result.session_id;
      else if (result.session_id !== handle) mismatch(code('handle-mismatch'), 'A continuation result changed the original running handle.');
    } else {
      if (!Number.isSafeInteger(result.exit_code)) mismatch(code('terminal-exit-invalid'), 'The terminal exit code is not a safe integer.');
      terminalCount += 1; terminalEventIndex = outputIndex; terminalExitCode = result.exit_code;
      if (options.expectedExitCode !== undefined && result.exit_code !== options.expectedExitCode) mismatch(options.expectedExitCodeMismatchCode ?? code('terminal-exit-invalid'), 'The terminal exit code differs from the required child-turn contract.');
    }
  }
  if (execCount !== 1) mismatch(commandCountCode, 'The child must start exactly one companion process.');
  if (terminalCount !== 1 || terminalEventIndex < 0) mismatch(code('terminal-exit-missing'), 'The original companion process has no unique terminal exit code.');
  if (options.expectedExitCode !== undefined && parsedCalls[0].legacy && !options.allowLegacyWithoutExit) mismatch(code('terminal-exit-missing'), 'This child turn requires an observed terminal exit code.');
  return {
    callIds, execCommandCount: execCount, execEvent: calls[0], originalHandle: handle, output: normalized, pollCount: pollHandles.length,
    pollHandles, terminalEventIndex, terminalEvent: child[terminalEventIndex], terminalExitCode,
  };
}

function validateCallOutputOwnership(calls, outputs, errorCode) {
  const callIds = calls.map((event) => boundedString(event?.payload?.call_id));
  const outputIds = outputs.map((event) => boundedString(event?.payload?.call_id));
  if (callIds.some((id) => !id) || outputIds.some((id) => !id)
    || new Set(callIds).size !== callIds.length || new Set(outputIds).size !== outputIds.length
    || callIds.length !== outputIds.length || callIds.some((id) => !outputIds.includes(id))) {
    mismatch(errorCode, 'Host calls and outputs require nonempty, bounded, globally unique, one-to-one call IDs.');
  }
  return callIds;
}

function assertPollEnvelope(envelope, expectedHandle, code = (suffix) => `child-${suffix}`) {
  const keys = [...envelope.keys()];
  if (keys.some((key) => !['chars', 'max_output_tokens', 'session_id', 'yield_time_ms'].includes(key))) mismatch(code('poll-envelope'), 'The continuation poll contains a forbidden field.');
  if (envelope.get('session_id') !== expectedHandle) mismatch(code('handle-mismatch'), 'The continuation poll changed the original running handle.');
  if (envelope.get('chars') !== '') mismatch(code('poll-input'), 'The continuation poll supplied nonempty input.');
  if (envelope.has('yield_time_ms') && (!Number.isInteger(envelope.get('yield_time_ms')) || envelope.get('yield_time_ms') < 250 || envelope.get('yield_time_ms') > 300_000)) mismatch(code('poll-envelope'), 'The continuation yield bound is unsafe.');
  if (envelope.has('max_output_tokens') && (!Number.isInteger(envelope.get('max_output_tokens')) || envelope.get('max_output_tokens') < 1 || envelope.get('max_output_tokens') > 100_000)) mismatch(code('poll-envelope'), 'The continuation output bound is unsafe.');
}

function parseCapturedHostResult(output) {
  if (!Array.isArray(output) || output.length !== 2 || output[0]?.type !== 'input_text' || output[1]?.type !== 'input_text'
    || !boundedString(output[0].text)?.startsWith('Script completed\n')) mismatch('child-result-shape', 'The host result does not match the captured Codex 0.147 output shape.');
  const text = boundedString(output[1].text); let result;
  try { result = JSON.parse(text); } catch { mismatch('child-result-shape', 'The captured host result is not exact JSON.'); }
  if (!result || typeof result !== 'object' || Array.isArray(result)) mismatch('child-result-shape', 'The captured host result is not an object.');
  const allowed = new Set(['chunk_id', 'exit_code', 'original_token_count', 'output', 'session_id', 'wall_time_seconds']);
  if (Object.keys(result).some((key) => !allowed.has(key)) || typeof result.output !== 'string' || boundedString(result.output) === undefined) mismatch('child-result-shape', 'The captured host result differs from the Codex 0.147 contract.');
  if (Object.hasOwn(result, 'chunk_id') && !boundedString(result.chunk_id)
    || Object.hasOwn(result, 'original_token_count') && (!Number.isSafeInteger(result.original_token_count) || result.original_token_count < 0)
    || Object.hasOwn(result, 'wall_time_seconds') && (!Number.isFinite(result.wall_time_seconds) || result.wall_time_seconds < 0)) {
    mismatch('child-result-shape', 'The captured host result fields exceed their safe bounds.');
  }
  return result;
}

export function qualifyCodexRescueBackgroundEvidence(input, options) {
  const jobId = boundedString(options?.expectedJobId);
  if (!jobId || !/^[a-f0-9]{64}$/u.test(jobId)) mismatch('background-job-id', 'Background qualification requires one exact canonical queued job ID.');
  const publicOutput = `Reserved background job ${jobId}.`;
  const publicLogs = options?.publicLogs === undefined ? [] : boundedArray(options.publicLogs, 64, 'background-public-logs');
  if (publicLogs.some((entry) => boundedString(entry) === undefined)) mismatch('background-public-logs', 'Background public logs exceed their count or text bound.');
  const capability = boundedString(options?.privateExecutionCapability);
  if (!capability) mismatch('background-capability-evidence', 'The private execution capability evidence is absent or unbounded.');
  const visible = boundedJson({ execFrames: input?.execFrames, rollouts: input?.rollouts, publicLogs });
  if (visible.includes(capability)) mismatch('background-capability-leak', 'The private execution capability entered model-visible or public evidence.');
  const evidence = qualifyCodexRescueEvidenceCore(input, { ...options, expectedPublicOutput: publicOutput }, true);
  const child = input.rollouts.find((events) => sessionMeta(events)?.id === evidence.childThreadId);
  const outputs = child.filter((event) => event?.type === 'response_item' && event.payload?.type === 'custom_tool_call_output');
  if (!Array.isArray(outputs[0]?.payload?.output) || outputs[0].payload.output.length !== 1) mismatch('background-child-stdout', 'The linked child command must expose one exact structured queued stdout item.');
  const exactStdout = terminalOutputText(outputs[0]?.payload?.output, 'background-child-stdout');
  if (exactStdout !== publicOutput && exactStdout !== `${publicOutput}\n`) mismatch('background-child-stdout', 'The linked child command output is not only the exact queued stdout.');
  const result = { ...evidence, jobId, capabilityChecked: true };
  const parent = input.rollouts.find((events) => sessionMeta(events)?.id === evidence.parentThreadId);
  const spawn = parent.find((event) => event?.type === 'response_item' && event.payload?.type === 'function_call' && event.payload.name === 'spawn_agent');
  if (encrypted(parseObject(spawn.payload.arguments, 'background-spawn-arguments').message)) unqualified('spawn-message-encrypted', 'Codex 0.147 persisted the spawn message field as ciphertext, so its exact runtime value cannot be qualified.', result);
  return result;
}

export function qualifyCodexRescueChoiceEvidence(input, options) {
  if (options?.expectedChoice !== 'resume') mismatch('choice-fresh-requires-parent-replan', 'Fresh cannot be qualified as a same-child follow-up; it must return to the parent planner and spawn a new child.');
  const rollouts = boundedArray(input?.rollouts, MAX_ROLLOUTS, 'choice-rollouts');
  for (const rollout of rollouts) boundedArray(rollout, MAX_EVENTS_PER_ROLLOUT, 'choice-rollout-events');
  if (!['resume', 'fresh'].includes(options?.expectedChoice)) mismatch('choice-invalid', 'The expected Rescue choice is invalid.');

  const parentCandidates = rollouts.filter((events) => sessionMeta(events)?.id === options.expectedParentThreadId);
  if (parentCandidates.length !== 1) mismatch('choice-parent-count', 'Choice evidence must contain exactly one parent rollout.');
  const parent = parentCandidates[0];
  const parentMeta = sessionMeta(parent);
  validateParentCallOwnership(parent, 'choice-parent-call-id');
  const spawns = namedCalls(parent, 'spawn_agent');
  if (spawns.length !== 1) mismatch('choice-spawn-count', 'Choice continuation must retain exactly one initial spawn.');
  const spawnArgs = parseObject(spawns[0].payload.arguments, 'choice-spawn-arguments');
  const taskName = boundedString(spawnArgs.task_name);
  const spawnMessageEncrypted = encrypted(spawnArgs.message);
  let expectedSpawnMessage;
  if (Object.hasOwn(spawnArgs, 'agent_type')) {
    assertExactKeys(spawnArgs, ['agent_type', 'fork_turns', 'message', 'task_name'], 'choice-spawn-keys');
    if (spawnArgs.agent_type !== options.expectedAgentType) mismatch('choice-agent-type', 'The choice-flow spawn does not select the managed Rescue Role.');
    expectedSpawnMessage = options.expectedNamedSpawnMessage;
  } else {
    assertExactKeys(spawnArgs, ['fork_turns', 'message', 'task_name'], 'choice-spawn-keys');
    if (!GENERIC_HIDDEN_SCHEMA_VERSIONS.has(sessionMeta(parent)?.cli_version)) mismatch('choice-generic-version', 'The choice-flow generic spawn is not qualified for this Codex version.');
    expectedSpawnMessage = options.expectedGenericSpawnMessage;
  }
  if (!taskName || spawnArgs.fork_turns !== 'none') mismatch('choice-spawn-contract', 'The choice-flow spawn task or context mode differs from the Rescue contract.');
  if (!spawnMessageEncrypted && spawnArgs.message !== expectedSpawnMessage) mismatch('choice-spawn-message', 'The choice-flow spawn message differs from its fixed contract.');
  const spawnIndex = parent.indexOf(spawns[0]);
  const starts = parent.filter((event) => event?.type === 'event_msg' && event.payload?.type === 'sub_agent_activity' && event.payload.kind === 'started');
  if (starts.length !== 1) mismatch('choice-start-count', 'Choice continuation must expose exactly one child start.');
  const start = starts[0];
  const childThreadId = boundedString(start.payload.agent_thread_id);
  const agentPath = boundedString(start.payload.agent_path);
  if (!childThreadId || !agentPath || start.payload.event_id !== spawns[0].payload.call_id) {
    mismatch('choice-child-identity', 'The choice flow does not link one exact child ID to the initial spawn.');
  }
  const startIndex = parent.indexOf(start);
  if (spawnIndex >= startIndex) mismatch('choice-start-order', 'The child start must follow its unique spawn.');
  assertParentPreparation(parent, spawnIndex, startIndex, {
    expectedPreflightCommand: options.expectedPreflightCommand,
    expectedPreparationCommand: options.expectedPreparationCommand,
    expectedPreparationPayload: options.expectedPreparationPayload,
    expectedWorkspace: options.expectedWorkspace,
    expectedTaskName: taskName,
  });

  const childCandidates = rollouts.filter((events) => sessionMeta(events)?.id === childThreadId);
  if (childCandidates.length !== 1) mismatch('choice-child-count', 'Choice evidence must contain exactly one rollout for the retained child ID.');
  const child = childCandidates[0];
  const meta = sessionMeta(child);
  const childSessionMeta = child.filter((event) => event?.type === 'session_meta');
  if (childSessionMeta.length !== 1 || child.indexOf(childSessionMeta[0]) !== 0) mismatch('choice-child-execution-boundary', 'The child rollout must begin with exactly one session_meta record.');
  const spawnMeta = meta?.source?.subagent?.thread_spawn;
  validateParentChildRoute({ parentMeta, parentThreadId: options.expectedParentThreadId, start: start.payload, childMeta: meta, childThreadId, agentPath, codePrefix: 'choice-' });
  validateForwarderChildEvents(child, options);
  if (Object.hasOwn(spawnArgs, 'agent_type') ? spawnMeta.agent_role !== options.expectedAgentType : spawnMeta.agent_role !== null) {
    mismatch('choice-agent-role', 'The retained child Role metadata differs from the selected route.');
  }

  const followups = namedCalls(parent, 'followup_task');
  if (followups.length !== 1) mismatch('choice-followup-count', 'Choice continuation must contain exactly one followup_task.');
  const followup = parseObject(followups[0].payload.arguments, 'choice-followup-arguments');
  const followupMessageEncrypted = encrypted(followup.message);
  assertExactKeys(followup, ['message', 'target'], 'choice-followup-keys');
  if (followup.target !== childThreadId) mismatch('choice-followup-target', 'The continuation target differs from the original child ID.');
  if (!followupMessageEncrypted && followup.message !== options.expectedFollowupMessage) mismatch('choice-followup-message', 'The continuation message differs from the fixed choice contract.');
  const followupOutputs = parent.filter((event) => event?.type === 'response_item' && event.payload?.type === 'function_call_output' && event.payload.call_id === followups[0].payload.call_id);
  if (followupOutputs.length !== 1) mismatch('choice-followup-output-link', 'The follow-up must have exactly one linked host output.');
  if (parent.indexOf(followups[0]) >= parent.indexOf(followupOutputs[0])) mismatch('choice-followup-output-order', 'The linked follow-up host output must follow its call.');
  if (boundedString(followupOutputs[0].payload.output) === undefined) mismatch('choice-followup-output-shape', 'The linked follow-up host output is not a bounded string.');

  const waits = namedCalls(parent, 'wait_agent');
  if (waits.length < 2) mismatch('choice-wait-count', 'The choice flow must expose waits before and after the same-child follow-up.');
  const timedOutWaitIndexes = []; const waitEvidence = [];
  for (const wait of waits) {
    const args = parseObject(wait.payload.arguments, 'choice-wait-arguments');
    assertExactKeys(args, ['timeout_ms'], 'choice-wait-keys');
    if (!Number.isSafeInteger(args.timeout_ms) || args.timeout_ms < 10_000 || args.timeout_ms > 3_600_000) mismatch('choice-wait-bound', 'A choice wait timeout is outside the supported bound.');
    const linked = parent.filter((event) => event?.type === 'response_item' && event.payload?.type === 'function_call_output' && event.payload.call_id === wait.payload.call_id);
    if (linked.length !== 1 || parent.indexOf(wait) >= parent.indexOf(linked[0])) mismatch('choice-wait-output-link', 'Each wait must have one later linked host output.');
    const result = parseObject(linked[0].payload.output, 'choice-wait-output-shape');
    assertExactKeys(result, ['message', 'timed_out'], 'choice-wait-output-shape');
    if (typeof result.timed_out !== 'boolean' || result.message !== (result.timed_out ? 'Wait timed out.' : 'Wait completed.')) mismatch('choice-wait-output-shape', 'A wait result differs from the observed host contract.');
    if (result.timed_out) timedOutWaitIndexes.push(parent.indexOf(linked[0]));
    waitEvidence.push({ callIndex: parent.indexOf(wait), outputIndex: parent.indexOf(linked[0]), timedOut: result.timed_out });
  }
  if (timedOutWaitIndexes.length > 0) {
    const lists = namedCalls(parent, 'list_agents');
    if (lists.length !== 1) mismatch('choice-child-state-count', 'Timeout recovery must inspect the retained child exactly once.');
    assertExactKeys(parseObject(lists[0].payload.arguments, 'choice-child-state-shape'), [], 'choice-child-state-shape');
    const linked = parent.filter((event) => event?.type === 'response_item' && event.payload?.type === 'function_call_output' && event.payload.call_id === lists[0].payload.call_id);
    if (linked.length !== 1 || parent.indexOf(lists[0]) >= parent.indexOf(linked[0])) mismatch('choice-child-state-link', 'The child-state output must link after list_agents.');
    const state = parseObject(linked[0].payload.output, 'choice-child-state-shape');
    assertExactKeys(state, ['agents'], 'choice-child-state-shape');
    if (!Array.isArray(state.agents) || state.agents.length !== 1) mismatch('choice-child-state-shape', 'Child-state evidence must contain only the retained child.');
    assertExactKeys(state.agents[0], ['agent_name', 'agent_status'], 'choice-child-state-shape');
    if (state.agents[0].agent_name !== agentPath || state.agents[0].agent_status !== 'running') mismatch('choice-child-state-mismatch', 'Timeout recovery did not observe the retained child running.');
    const firstReturnIndex = parent.findIndex((event) => isTerminalChildReturn(event, agentPath));
    const nextWaitIndex = waitEvidence.find(({ callIndex }) => callIndex > parent.indexOf(linked[0]))?.callIndex ?? -1;
    if (!(timedOutWaitIndexes[0] < parent.indexOf(lists[0]) && parent.indexOf(linked[0]) < nextWaitIndex && nextWaitIndex < firstReturnIndex)) mismatch('choice-child-state-order', 'Timeout recovery state inspection is out of order.');
  }

  const childFinals = child.filter((event) => event?.type === 'event_msg' && event.payload?.type === 'agent_message' && event.payload.phase === 'final_answer');
  if (childFinals.length !== 2) mismatch('choice-child-terminal-sequence', 'The retained child must finalize exactly two turns.');
  const firstFinalIndex = child.indexOf(childFinals[0]); const secondFinalIndex = child.indexOf(childFinals[1]);
  const outsideHostEvents = child.filter((event, index) => isChildHostEvent(event)
    && !(index > 0 && index < firstFinalIndex || index > firstFinalIndex && index < secondFinalIndex));
  if (outsideHostEvents.length > 0) mismatch('choice-child-execution-boundary', 'Every child host call and output must belong to exactly one logical execution before its final.');
  const initialEvents = child.slice(1, firstFinalIndex); const continuationEvents = child.slice(firstFinalIndex + 1, secondFinalIndex);
  const callsIn = (events) => events.filter((event) => event?.type === 'response_item' && event.payload?.type === 'custom_tool_call');
  const outputsIn = (events) => events.filter((event) => event?.type === 'response_item' && event.payload?.type === 'custom_tool_call_output');
  const segmentOptions = (expectedCommand) => ({ ...options, expectedCommand, requireStatusSidecar: false });
  const qualifySegment = (events, expectedCommand, codePrefix, executionOptions) => {
    const firstHost = events.find((event) => isChildHostEvent(event));
    if (firstHost?.payload?.type !== 'custom_tool_call'
      || parseCapturedHostCall(firstHost.payload.input).kind !== 'exec_command') {
      mismatch('choice-child-execution-boundary', 'Each logical child turn must begin by starting its one foreground execution.');
    }
    const customCalls = callsIn(events); const customOutputs = outputsIn(events);
    const parts = splitStatusSidecars(customCalls, customOutputs, segmentOptions(expectedCommand), codePrefix);
    const hasRelayHostEvent = events.some((event) => event?.type === 'response_item'
      && ['function_call', 'function_call_output'].includes(event.payload?.type));
    if (hasRelayHostEvent) validateChildHostCallOwnership(events, parts.statusCalls, codePrefix);
    const execution = validateChildExecution(events, parts.executionCalls, parts.executionOutputs, expectedCommand, options.expectedWorkspace, executionOptions);
    if (!hasRelayHostEvent) validateChildHostCallOwnership(events, parts.statusCalls, codePrefix);
    const statusChecked = validateStatusSidecars({ child: events, statusCalls: parts.statusCalls, statusOutputs: parts.statusOutputs,
      execution, options: segmentOptions(expectedCommand), codePrefix });
    return { execution, statusChecked };
  };
  const initial = qualifySegment(initialEvents, options.expectedInitialCommand, 'choice-initial', { codePrefix: 'choice-initial', commandCountCode: 'choice-command-count', expectedExitCode: 3, expectedExitCodeMismatchCode: 'choice-needs-choice-exit' });
  const continuation = qualifySegment(continuationEvents, options.expectedChoiceCommand, 'choice-continuation', { codePrefix: 'choice-continuation', commandCountCode: 'choice-command-count', commandMismatchCode: 'choice-command-mismatch', expectedExitCode: 0 });
  const initialExecution = initial.execution; const continuationExecution = continuation.execution;
  assertNoChoiceCallIdReuse(initialEvents, continuationEvents, options);

  const returns = parent.filter((event) => isTerminalChildReturn(event, agentPath));
  if (returns.length !== 2) mismatch('choice-child-return-count', 'The parent must receive needs-choice and terminal results from the same child.');
  const initialParent = parent.slice(startIndex + 1, parent.indexOf(returns[0]));
  const continuationParent = parent.slice(parent.indexOf(followupOutputs[0]) + 1, parent.indexOf(returns[1]));
  const relayIdentitySets = { messageIds: new Set(), turnAssociations: new Set() };
  const initialRelay = validateProgressRelays({ child: initialEvents, parent: initialParent, execution: initialExecution, agentPath,
    options: segmentOptions(options.expectedInitialCommand), codePrefix: 'choice-initial', identitySets: relayIdentitySets });
  const continuationRelay = validateProgressRelays({ child: continuationEvents, parent: continuationParent, execution: continuationExecution, agentPath,
    options: segmentOptions(options.expectedChoiceCommand), codePrefix: 'choice-continuation', identitySets: relayIdentitySets });
  const statusSidecarChecked = initial.statusChecked || continuation.statusChecked;
  if (options.requireStatusSidecar && !statusSidecarChecked) mismatch('choice-status-sidecar-count', 'Required choice evidence lacks a status sidecar in both logical segments.');
  const needsChoiceText = terminalOutputText(initialExecution.output, 'choice-needs-choice-output');
  let needsChoice;
  try { needsChoice = JSON.parse(needsChoiceText); } catch { mismatch('choice-needs-choice-output', 'The first child output is not exact needs-choice JSON.'); }
  assertExactKeys(needsChoice, ['candidate', 'choices', 'type'], 'choice-needs-choice-output');
  if (needsChoice.type !== 'needs-choice' || JSON.stringify(needsChoice.choices) !== JSON.stringify(['--resume', '--fresh'])) {
    mismatch('choice-needs-choice-output', 'The first child output is not the fixed needs-choice response.');
  }
  boundedJson(needsChoice.candidate);
  assertTerminalSentinel(continuationExecution.output, options.expectedPublicOutput);
  if (childFinals.length !== 2 || childFinals[0].payload.message !== needsChoiceText || childFinals[1].payload.message !== options.expectedPublicOutput
    || child.indexOf(initialExecution.terminalEvent) >= firstFinalIndex || firstFinalIndex >= child.indexOf(continuationExecution.execEvent)
    || child.indexOf(continuationExecution.terminalEvent) >= secondFinalIndex) mismatch('choice-child-terminal-sequence', 'The same child must finalize each exact stdout after its linked command output.');

  const returnPayloads = returns.map((event) => childReturnText(event, agentPath));
  if (returnPayloads[0] !== needsChoiceText || returnPayloads[1] !== options.expectedPublicOutput) mismatch('choice-child-return-output', 'Same-child return payloads are not exact public stdout.');
  const waitBoundaries = [startIndex, parent.indexOf(followupOutputs[0])];
  for (let index = 0; index < returns.length; index += 1) {
    const returnIndex = parent.indexOf(returns[index]);
    if (!waitEvidence.some(({ callIndex, outputIndex, timedOut }) => !timedOut && waitBoundaries[index] < callIndex && callIndex < outputIndex && outputIndex < returnIndex)) mismatch('choice-wait-return-order', 'Each child return must follow its corresponding linked completed wait output.');
  }
  const parentFinals = parent.filter((event) => event?.type === 'event_msg' && event.payload?.type === 'agent_message' && event.payload.phase === 'final_answer');
  if (parentFinals.length !== 2
    || parentFinals[0].payload.message !== `${needsChoiceText}Choose resume or fresh.`
    || parentFinals[1].payload.message !== options.expectedPublicOutput) {
    mismatch('choice-parent-output', 'The parent must ask once after verbatim needs-choice stdout, then return exact terminal stdout.');
  }
  const followupIndex = parent.indexOf(followups[0]);
  if (!(parent.indexOf(returns[0]) < parent.indexOf(parentFinals[0]) && parent.indexOf(parentFinals[0]) < followupIndex && followupIndex < parent.indexOf(returns[1]) && parent.indexOf(returns[1]) < parent.indexOf(parentFinals[1]))) mismatch('choice-followup-order', 'The unique ask and follow-up must separate the two linked child returns.');
  const waitIndexes = waits.map((event) => parent.indexOf(event));
  if (!waitIndexes.some((index) => startIndex < index && index < parent.indexOf(returns[0]))
    || !waitIndexes.some((index) => followupIndex < index && index < parent.indexOf(returns[1]))) {
    mismatch('choice-wait-order', 'Wait evidence does not bracket the two same-child turns.');
  }

  const timeline = [initialExecution.execEvent, initialExecution.terminalEvent, childFinals[0], returns[0], parentFinals[0], followups[0], followupOutputs[0], continuationExecution.execEvent, continuationExecution.terminalEvent, childFinals[1], returns[1], parentFinals[1]].map(eventTimestamp);
  if (timeline.some((value) => value === undefined) || timeline.some((value, index) => index > 0 && value <= timeline[index - 1])) {
    mismatch('choice-terminal-timeline', 'The observable timestamps do not prove the complete initial-exec through terminal-parent sequence.');
  }

  assertParentIsolation(parent, options, options.forbiddenParentText ?? []);
  const evidence = {
    parentThreadId: options.expectedParentThreadId, childThreadId, agentPath, taskName, choice: options.expectedChoice,
    ...(options.requireProgressRelay ? { progressRelayChecked: initialRelay.checked && continuationRelay.checked } : {}),
    ...(options.requireStatusSidecar ? { statusSidecarChecked } : {}),
    ...(options.includeExecutionFacts ? { executions: {
      initial: { execCommandCount: initialExecution.execCommandCount },
      continuation: { execCommandCount: continuationExecution.execCommandCount },
    } } : {}),
  };
  if (spawnMessageEncrypted) unqualified('choice-spawn-encrypted', 'Codex encrypted only the spawn message field, so its exact runtime value cannot be qualified.', evidence);
  if (followupMessageEncrypted) unqualified('choice-followup-encrypted', 'Codex encrypted only the continuation message field, so its exact runtime value cannot be qualified.', evidence);
  return evidence;
}

function validateForwarderChildEvents(child, options) {
  for (let index = 0; index < child.length; index += 1) {
    const event = child[index];
    if (event?.type === 'session_meta') {
      if (index !== 0) mismatch('child-event-accounting', 'The forwarder child session metadata is out of order.');
      continue;
    }
    if (event?.type === 'event_msg' && event.payload?.type === 'agent_message'
      && event.payload.phase === 'final_answer') continue;
    if (event?.type === 'response_item' && event.payload?.type === 'custom_tool_call') continue;
    if (event?.type === 'response_item' && event.payload?.type === 'custom_tool_call_output') continue;
    if (options.requireProgressRelay && event?.type === 'response_item' && event.payload?.type === 'function_call'
      && event.payload.name === 'send_message') continue;
    if (event?.type === 'response_item' && event.payload?.type === 'function_call'
      && ['exec', 'exec_command'].includes(event.payload.name)) {
      mismatch('child-command-shape-mismatch', 'The child command used a tool-call shape not captured for Codex 0.147.');
    }
    if (options.requireProgressRelay && event?.type === 'response_item' && event.payload?.type === 'function_call_output') continue;
    mismatch('child-event-accounting', 'The forwarder child rollout contains an unaccounted event.');
  }
}

function isChildHostEvent(event) {
  return event?.type === 'response_item' && ['custom_tool_call', 'custom_tool_call_output', 'function_call', 'function_call_output'].includes(event.payload?.type);
}

function isTerminalChildReturn(event, agentPath) {
  return event?.type === 'response_item' && event.payload?.type === 'agent_message'
    && event.payload.author === agentPath && event.payload.recipient === '/root'
    && event.payload.content?.some((item) => item?.type === 'input_text' && item.text?.startsWith('Message Type: FINAL_ANSWER\n'));
}

function validateChildHostCallOwnership(events, statusCalls, codePrefix) {
  const calls = events.filter((event) => event?.type === 'response_item' && ['custom_tool_call', 'function_call'].includes(event.payload?.type));
  const outputs = events.filter((event) => event?.type === 'response_item' && ['custom_tool_call_output', 'function_call_output'].includes(event.payload?.type));
  const callIds = calls.map((event) => boundedString(event.payload.call_id));
  const outputIds = outputs.map((event) => boundedString(event.payload.call_id));
  const statusIds = new Set(statusCalls.map((event) => event.payload.call_id));
  const relayPresent = calls.some((event) => event.payload.type === 'function_call') || outputs.some((event) => event.payload.type === 'function_call_output');
  const errorCode = relayPresent ? `${codePrefix}-progress-relay-call-id`
    : statusIds.size > 0 ? `${codePrefix}-status-sidecar-call-id` : `${codePrefix}-call-id`;
  if (callIds.some((id) => !id) || outputIds.some((id) => !id)
    || new Set(callIds).size !== callIds.length || new Set(outputIds).size !== outputIds.length
    || callIds.length !== outputIds.length) mismatch(errorCode, 'Child host calls and outputs require unique one-to-one identities.');
  for (const call of calls) {
    const expectedType = call.payload.type === 'function_call' ? 'function_call_output' : 'custom_tool_call_output';
    if (outputs.filter((output) => output.payload.call_id === call.payload.call_id && output.payload.type === expectedType).length !== 1) {
      mismatch(call.payload.type === 'function_call' ? `${codePrefix}-progress-relay-call-id`
        : statusIds.has(call.payload.call_id) ? `${codePrefix}-status-sidecar-call-id` : `${codePrefix}-call-id`,
      'Each child host output must retain the call family and exact call identity.');
    }
  }
  if (outputs.some((output) => !calls.some((call) => call.payload.call_id === output.payload.call_id
    && output.payload.type === (call.payload.type === 'function_call' ? 'function_call_output' : 'custom_tool_call_output')))) {
    mismatch(errorCode, 'Orphan or cross-family child host output is not qualified.');
  }
}

function assertNoChoiceCallIdReuse(initialEvents, continuationEvents, options) {
  const calls = (events) => events.filter((event) => event?.type === 'response_item' && ['custom_tool_call', 'function_call'].includes(event.payload?.type));
  const initialIds = new Set(calls(initialEvents).map((event) => event.payload.call_id));
  const reused = calls(continuationEvents).find((event) => initialIds.has(event.payload.call_id));
  if (!reused) return;
  if (reused.payload.type === 'function_call') mismatch('choice-continuation-progress-relay-call-id', 'The continuation relay reused an earlier host call ID.');
  const host = parseCapturedHostCall(reused.payload.input);
  if (options.expectedStatusCommand && host.kind === 'exec_command' && host.envelope.get('cmd') !== options.expectedChoiceCommand) {
    mismatch('choice-continuation-status-sidecar-call-id', 'The continuation status sidecar reused an earlier host call ID.');
  }
  mismatch('choice-child-call-id-reused', 'The two logical executions reused a host call ID.');
}

function validateParentCallOwnership(parent, code) {
  const calls = parent.filter((event) => event?.type === 'response_item' && ['function_call', 'custom_tool_call'].includes(event.payload?.type));
  const outputs = parent.filter((event) => event?.type === 'response_item' && ['function_call_output', 'custom_tool_call_output'].includes(event.payload?.type));
  const callIds = calls.map((event) => boundedString(event.payload.call_id));
  const outputIds = outputs.map((event) => boundedString(event.payload.call_id));
  if (callIds.some((id) => !id) || outputIds.some((id) => !id) || new Set(callIds).size !== callIds.length || new Set(outputIds).size !== outputIds.length) {
    mismatch(code, 'Parent calls and outputs require nonempty bounded unique call IDs.');
  }
  const outputOwningCalls = calls.filter((event) => !(event.payload.type === 'function_call' && event.payload.name === 'spawn_agent'));
  const linkedOutput = (call) => outputs.filter((output) => output.payload.call_id === call.payload.call_id
    && output.payload.type === (call.payload.type === 'custom_tool_call' ? 'custom_tool_call_output' : 'function_call_output'));
  if (outputOwningCalls.length !== outputs.length || outputOwningCalls.some((call) => linkedOutput(call).length !== 1)
    || outputs.some((output) => !outputOwningCalls.some((call) => linkedOutput(call).includes(output)))) {
    mismatch(code, 'Every parent host output must belong one-to-one to one non-spawn call.');
  }
}

function validateParentChildRoute({ parentMeta, parentThreadId, start, childMeta, childThreadId, agentPath, codePrefix }) {
  const code = codePrefix ? 'choice-child-link' : 'child-link-mismatch';
  if (parentMeta?.session_id !== parentThreadId || parentMeta?.id !== parentThreadId
    || Object.hasOwn(parentMeta ?? {}, 'parent_thread_id') || parentMeta?.thread_source !== 'user' || parentMeta?.source !== 'exec') {
    mismatch(codePrefix ? 'choice-parent-link' : 'parent-session-mismatch', 'Parent session metadata does not describe the exact top-level exec thread.');
  }
  if (start?.agent_thread_id !== childThreadId || start?.agent_path !== agentPath) mismatch(codePrefix ? 'choice-child-identity' : 'child-identity-unavailable', 'The start event does not identify the exact child route.');
  const spawnMeta = childMeta?.source?.subagent?.thread_spawn;
  if (!spawnMeta || typeof spawnMeta !== 'object') mismatch(codePrefix ? code : 'thread-spawn-unavailable', 'The child rollout omits thread_spawn metadata.');
  if (childMeta?.id !== childThreadId || childMeta?.session_id !== parentThreadId
    || childMeta?.parent_thread_id !== parentThreadId || childMeta?.thread_source !== 'subagent'
    || spawnMeta.parent_thread_id !== parentThreadId || spawnMeta.depth !== 1 || spawnMeta.agent_path !== agentPath) {
    mismatch(code, 'Child session metadata does not link exactly to the observed parent and start event.');
  }
}

function namedCalls(events, name) {
  return events.filter((event) => event?.type === 'response_item' && event.payload?.type === 'function_call' && event.payload.name === name);
}

function assertGlobalCallOwnership(...rollouts) {
  const events = rollouts.flat(); const calls = events.filter((event) => ['custom_tool_call', 'function_call'].includes(event?.payload?.type));
  const outputs = events.filter((event) => ['custom_tool_call_output', 'function_call_output'].includes(event?.payload?.type));
  const ids = calls.map((event) => boundedString(event.payload.call_id));
  if (ids.some((id) => !id) || new Set(ids).size !== ids.length || outputs.length !== calls.length
    || outputs.some((output) => calls.filter((call) => call.payload.call_id === output.payload.call_id).length !== 1)
    || calls.some((call) => outputs.filter((output) => output.payload.call_id === call.payload.call_id).length !== 1)
    || [...calls, ...outputs].some((event) => event.type !== 'response_item')
    || calls.some((call) => outputs.find((output) => output.payload.call_id === call.payload.call_id)?.payload.type
      !== (call.payload.type === 'function_call' ? 'function_call_output' : 'custom_tool_call_output'))) {
    mismatch('continuation-call-linkage', 'Raw host calls and outputs do not have global one-to-one ownership.');
  }
}

async function parseRawJobsWithProduction(jobBytes, expected, installedDataRoot) {
  if (!Array.isArray(jobBytes) || jobBytes.length < 2 || jobBytes.length > 128) mismatch('continuation-job-identity', 'Raw persisted job file count is outside the qualification bound.');
  if (jobBytes.some((bytes) => typeof bytes !== 'string' || !bytes.endsWith('\n'))) mismatch('continuation-job-record', 'Raw persisted job file bytes are invalid.');
  const routed = jobBytes.map((bytes) => { let value; try { value = JSON.parse(bytes); } catch { mismatch('continuation-job-record', 'Raw persisted job bytes are malformed.'); } if (!/^[a-f0-9]{64}$/u.test(value?.id)) mismatch('continuation-job-record', 'Raw persisted job identity is invalid.'); return { bytes, id: value.id, value }; });
  const suppliedRoot = typeof installedDataRoot === 'string' && installedDataRoot.length > 0 ? installedDataRoot : undefined;
  if (suppliedRoot !== undefined) {
    const installedStorage = await resolveReadonlyQualificationStorage(suppliedRoot, expected.workspace).catch(() => mismatch('continuation-job-record', 'Observed installed job storage is unsafe or absent.'));
    const installedJobs = join(installedStorage.directory, 'jobs');
    for (const { bytes, id, value } of routed) {
      if (await readFile(join(installedJobs, `${id}.json`), 'utf8').catch(() => null) !== bytes) mismatch('continuation-job-record', 'Observed installed job bytes do not match their persisted source files.');
      if (Object.hasOwn(value, 'logFile') && value.logFile !== join(installedJobs, `${id}.log`)) mismatch('continuation-job-record', 'Observed installed job log path does not match its persisted workspace partition.');
    }
  }
  const dataRoot = await mkdtemp(join(tmpdir(), 'zcode-qualification-state-'));
  try {
    const workspacePath = await realpath(resolve(expected.workspace));
    const workspaceKey = createHash('sha256').update(workspacePath).digest('hex');
    const jobsDirectory = join(dataRoot, 'workspaces', workspaceKey, 'jobs'); await mkdir(jobsDirectory, { recursive: true });
    await Promise.all(routed.map(({ bytes, id, value }) => {
      if (suppliedRoot === undefined || !Object.hasOwn(value, 'logFile')) return writeFile(join(jobsDirectory, `${id}.json`), bytes);
      const portable = { ...value }; delete portable.logFile;
      return writeFile(join(jobsDirectory, `${id}.json`), `${JSON.stringify(portable)}\n`);
    }));
    const store = createStateStore({ dataRoot });
    const jobs = []; for (const { id } of routed) { try { jobs.push(await store.readJob(expected.workspace, id)); } catch { mismatch('continuation-job-record', 'Production StateStore rejected raw persisted job bytes.'); } }
    for (const job of jobs) if (job.ownerSessionId !== expected.parentSessionId || job.workspace !== expected.workspace || job.command !== 'rescue'
      || job.readOnly !== false || job.permissionSnapshot?.permissionMode !== expected.permissionMode) mismatch('continuation-job-record', 'Production job authority does not match the continuation.');
    return jobs;
  } finally { await rm(dataRoot, { recursive: true, force: true }); }
}

function validateContinuationActiveTurn(rawBytes, expected) {
  let record; try { record = JSON.parse(rawBytes); } catch { mismatch('continuation-active-turn', 'Raw active-turn bytes are malformed.'); }
  const legacyKeys = ['createdAt', 'key', 'kind', 'permissionMode', 'prompt', 'sessionId', 'turnId', 'version', 'workspace'];
  const currentKeys = ['createdAt', 'executionWorkspace', 'generationId', 'key', 'kind', 'originWorkspace', 'permissionMode', 'prompt', 'sessionId', 'status', 'turnId', 'version'];
  const legacyKey = createHash('sha256').update(JSON.stringify([expected.parentSessionId, expected.workspace])).digest('hex');
  const globalKey = createHash('sha256').update(JSON.stringify([expected.parentSessionId])).digest('hex');
  const legacy = record?.version === 2 && Object.keys(record).sort().join('\0') === legacyKeys.sort().join('\0')
    && record.key === legacyKey && record.workspace === expected.workspace;
  const current = record?.version === 3 && Object.keys(record).sort().join('\0') === currentKeys.sort().join('\0')
    && record.key === globalKey && /^[a-f0-9]{64}$/u.test(record.generationId)
    && record.originWorkspace === (expected.originWorkspace ?? expected.workspace)
    && record.executionWorkspace === (expected.executionWorkspace ?? expected.workspace) && record.status === 'active';
  if (!rawBytes.endsWith('\n') || !(legacy || current)
    || record.kind !== 'active-turn' || record.sessionId !== expected.parentSessionId || record.turnId !== expected.originalParentTurnId
    || record.permissionMode !== expected.permissionMode || typeof record.prompt !== 'string' || !Number.isFinite(Date.parse(record.createdAt))) {
    mismatch('continuation-active-turn', 'Raw lifecycle-bound active-turn authority is invalid.');
  }
  return record;
}

async function validateContinuationWorkspaceBinding(input, expected, active) {
  const originWorkspace = boundedString(expected.originWorkspace);
  const executionWorkspace = boundedString(expected.executionWorkspace);
  if (!originWorkspace || !executionWorkspace || expected.workspace !== executionWorkspace) {
    mismatch('continuation-workspace-lineage', 'Workspace-binding evidence does not distinguish its canonical origin and execution target.');
  }
  const parseBytes = (value, code) => {
    if (typeof value !== 'string' || !value.endsWith('\n') || Buffer.byteLength(value) > MAX_TEXT_BYTES) mismatch(code, 'Raw workspace authority bytes are absent or oversized.');
    try { return JSON.parse(value); } catch { mismatch(code, 'Raw workspace authority bytes are malformed.'); }
  };
  let transitions;
  if (typeof input.authorityTransitionBytesJson !== 'string' || Buffer.byteLength(input.authorityTransitionBytesJson) > MAX_ROLLOUT_BYTES) mismatch('continuation-authority-transition', 'Raw authority transitions are absent or oversized.');
  try { transitions = JSON.parse(input.authorityTransitionBytesJson); } catch { mismatch('continuation-authority-transition', 'Raw authority transitions are absent or malformed.'); }
  if (!Array.isArray(transitions) || transitions.length !== 4) mismatch('continuation-authority-transition', 'Raw authority transitions must contain pending, active-unbound, preview, and active-bound snapshots.');
  const [pending, unbound, preview, bound] = transitions.map((bytes) => parseBytes(bytes, 'continuation-authority-transition'));
  const activeKeys = ['createdAt', 'executionWorkspace', 'generationId', 'key', 'kind', 'originWorkspace', 'permissionMode', 'prompt', 'sessionId', 'status', 'turnId', 'version'].sort().join('\0');
  if ([pending, unbound, preview, bound].some((record) => Object.keys(record ?? {}).sort().join('\0') !== activeKeys)) mismatch('continuation-authority-transition', 'Raw authority transition records do not use the exact v3 schema.');
  const stableKeys = ['version', 'kind', 'key', 'sessionId', 'generationId', 'turnId', 'originWorkspace', 'permissionMode', 'prompt', 'createdAt'];
  const stable = (record) => JSON.stringify(Object.fromEntries(stableKeys.map((key) => [key, record?.[key]])));
  if (transitions.some((bytes) => typeof bytes !== 'string' || !bytes.endsWith('\n'))
    || [pending, unbound, bound].some((record) => stable(record) !== stable(active))) {
    mismatch('continuation-authority-transition', 'Workspace authority identity changed across publication, preview, or claim.');
  }
  if (JSON.stringify(preview) !== JSON.stringify(unbound)) mismatch('continuation-role-mutation', 'Role preview changed active-turn authority.');
  let roleStatus;
  if (typeof input.roleStatusEvidenceJson !== 'string' || Buffer.byteLength(input.roleStatusEvidenceJson) > MAX_TEXT_BYTES) mismatch('continuation-role-preview', 'Raw Role preflight evidence is absent or oversized.');
  try { roleStatus = JSON.parse(input.roleStatusEvidenceJson); } catch { mismatch('continuation-role-preview', 'Raw Role preflight evidence is absent or malformed.'); }
  if (Object.keys(roleStatus ?? {}).sort().join('\0') !== ['activeBytesAfter', 'activeBytesBefore', 'command', 'mtimeAfter', 'mtimeBefore', 'result', 'workspace'].sort().join('\0')
    || roleStatus.command !== 'role-status rescue' || roleStatus.workspace !== executionWorkspace
    || roleStatus.activeBytesBefore !== transitions[1] || roleStatus.activeBytesAfter !== transitions[2]
    || roleStatus.activeBytesAfter !== roleStatus.activeBytesBefore
    || !Number.isFinite(roleStatus.mtimeBefore) || roleStatus.mtimeAfter !== roleStatus.mtimeBefore
    || JSON.stringify(roleStatus.result) !== JSON.stringify({ type: 'role-status', role: 'zcode-rescue', status: 'ready' })) {
    mismatch('continuation-role-preview', 'Raw Role preflight did not inspect the exact execution workspace.');
  }
  if (pending.status !== 'pending' || pending.executionWorkspace !== null
    || unbound.status !== 'active' || unbound.executionWorkspace !== null) {
    mismatch(pending.executionWorkspace !== null ? 'continuation-authority-order' : 'continuation-authority-transition', 'Workspace authority publication order is invalid.');
  }
  if (bound.status !== 'active' || bound.executionWorkspace === null) mismatch('continuation-workspace-claim', 'Private prepare did not claim an execution workspace.');
  if (bound.executionWorkspace !== executionWorkspace || JSON.stringify(bound) !== JSON.stringify(active)) mismatch('continuation-second-target', 'Active-turn authority was rebound to another target.');

  const index = parseBytes(input.originIndexRecordBytes, 'continuation-origin-index');
  const indexKeys = ['generationId', 'globalKey', 'key', 'kind', 'originWorkspace', 'sessionId', 'version'];
  const expectedIndexKey = createHash('sha256').update(JSON.stringify([expected.parentSessionId, originWorkspace])).digest('hex');
  if (Object.keys(index ?? {}).sort().join('\0') !== indexKeys.sort().join('\0') || index.version !== 1 || index.kind !== 'active-turn-index'
    || index.key !== expectedIndexKey || index.globalKey !== active.key || index.sessionId !== expected.parentSessionId
    || index.generationId !== active.generationId || index.originWorkspace !== originWorkspace) mismatch('continuation-origin-index', 'Raw origin index does not name the exact active generation.');

  const route = parseBytes(input.executorRouteRecordBytes, 'continuation-executor-route');
  const routedExecutor = parseObject(input.executorRecordBytes, 'continuation-executor-route');
  const routeKeys = ['agentId', 'agentType', 'childTurnId', 'createdAt', 'kind', 'originWorkspace', 'parentGenerationId', 'parentPermissionMode', 'parentSessionId', 'parentTurnId', 'state', 'targetWorkspace', 'updatedAt', 'version'];
  if (Object.keys(route ?? {}).sort().join('\0') !== routeKeys.sort().join('\0') || route.version !== 1 || route.kind !== 'executor-route'
    || route.agentId !== expected.childThreadId || route.parentSessionId !== expected.parentSessionId || route.parentTurnId !== expected.originalParentTurnId
    || route.parentGenerationId !== active.generationId || route.parentPermissionMode !== expected.permissionMode
    || route.agentType !== (input.route === 'named' ? 'zcode-rescue' : 'default') || route.childTurnId !== expected.childTurnId
    || route.originWorkspace !== originWorkspace || route.targetWorkspace !== executionWorkspace || route.state !== 'stopped'
    || !Number.isFinite(Date.parse(route.createdAt)) || !Number.isFinite(Date.parse(route.updatedAt))
    || Date.parse(route.updatedAt) < Date.parse(route.createdAt)
    || route.agentType !== routedExecutor.agentType || route.childTurnId !== routedExecutor.childTurnId
    || route.createdAt !== routedExecutor.createdAt || routedExecutor.active !== false) {
    mismatch('continuation-executor-route', 'Raw executor route does not fence the exact workspace-bound generation.');
  }

  let lifecycle;
  if (typeof input.authorityLifecycleJson !== 'string' || Buffer.byteLength(input.authorityLifecycleJson) > MAX_ROLLOUT_BYTES) mismatch('continuation-authority-order', 'Raw authority lifecycle is absent or oversized.');
  try { lifecycle = JSON.parse(input.authorityLifecycleJson); } catch { mismatch('continuation-authority-order', 'Raw authority lifecycle is absent or malformed.'); }
  const phases = ['session-start', 'user-prompt', 'pending', 'active-unbound', 'role-preview', 'prepare', 'active-bound', 'subagent-start', 'peer-create', 'authority-revoked', 'target-cleanup'];
  if (!Array.isArray(lifecycle) || lifecycle.length !== phases.length || lifecycle.some((event, index) => event?.phase !== phases[index]
    || Object.keys(event).some((key) => !['at', 'generationId', 'phase', 'workspace'].includes(key))
    || !Number.isFinite(Date.parse(event.at)) || index > 0 && Date.parse(event.at) <= Date.parse(lifecycle[index - 1].at))) {
    mismatch('continuation-authority-order', 'Raw workspace authority lifecycle is reordered or incomplete.');
  }
  if (lifecycle.slice(2).some((event) => event.generationId !== active.generationId)
    || lifecycle.slice(0, 4).some((event) => event.workspace !== originWorkspace)
    || lifecycle.slice(4, 7).some((event) => event.workspace !== executionWorkspace)
    || lifecycle[7].workspace !== originWorkspace || lifecycle[8].workspace !== executionWorkspace
    || lifecycle[9].workspace !== originWorkspace || lifecycle[10].workspace !== executionWorkspace) {
    mismatch('continuation-authority-order', 'Raw workspace authority lifecycle targets the wrong generation or workspace.');
  }
  if (originWorkspace !== executionWorkspace) await validateCanonicalGitLineage(originWorkspace, executionWorkspace);
  return { originWorkspace, executionWorkspace, generationId: active.generationId, route, checked: true };
}

async function validateContinuationArtifactLocations(input, evidence) {
  if (typeof input.artifactLocationsJson !== 'string' || Buffer.byteLength(input.artifactLocationsJson) > MAX_ROLLOUT_BYTES) {
    mismatch('continuation-artifact-location', 'Workspace-bound artifact locations are absent or oversized.');
  }
  let artifacts; try { artifacts = JSON.parse(input.artifactLocationsJson); } catch { mismatch('continuation-artifact-location', 'Workspace-bound artifact locations are malformed.'); }
  if (!Array.isArray(artifacts) || artifacts.length !== 8 || artifacts.some((artifact) => !artifact || typeof artifact !== 'object' || Array.isArray(artifact)
    || Object.keys(artifact).sort().join('\0') !== ['bytes', 'path', 'role'].join('\0') || !boundedString(artifact.role)
    || !boundedString(artifact.path) || Buffer.byteLength(artifact.path) > 4096 || artifact.path.includes('\\')
    || typeof artifact.bytes !== 'string' || Buffer.byteLength(artifact.bytes) > MAX_ROLLOUT_BYTES)) {
    mismatch('continuation-artifact-location', 'Workspace-bound artifact location evidence has an invalid shape.');
  }
  let originKey = createHash('sha256').update(evidence.originWorkspace).digest('hex');
  let executionKey = createHash('sha256').update(evidence.executionWorkspace).digest('hex');
  if (boundedString(input.installedDataRoot)) {
    let originStorage; let executionStorage;
    try { [originStorage, executionStorage] = await Promise.all([
      resolveReadonlyQualificationStorage(input.installedDataRoot, evidence.originWorkspace),
      resolveReadonlyQualificationStorage(input.installedDataRoot, evidence.executionWorkspace),
    ]); } catch { mismatch('continuation-artifact-location', 'Workspace-bound artifact storage could not be resolved canonically.'); }
    if (originStorage.workspacePath !== evidence.originWorkspace || executionStorage.workspacePath !== evidence.executionWorkspace) {
      mismatch('continuation-artifact-location', 'Workspace-bound artifact storage resolved to another workspace.');
    }
    originKey = originStorage.workspaceKey; executionKey = executionStorage.workspaceKey;
  }
  let executor; let authority; let prePartition; let partition;
  try {
    executor = JSON.parse(input.executorRecordBytes); authority = JSON.parse(input.bindingAuthorityBytes);
    prePartition = JSON.parse(input.bindingPreReservationBytes); partition = JSON.parse(input.bindingPartitionBytes);
  } catch { mismatch('continuation-artifact-location', 'Authority location bytes are malformed.'); }
  const prefix = (workspaceKey, suffix) => `workspaces/${workspaceKey}/${suffix}`;
  const routeKey = createHash('sha256').update(JSON.stringify(['executor-route', evidence.route.parentSessionId, evidence.route.childTurnId])).digest('hex');
  const forwardKey = createHash('sha256').update(JSON.stringify(['forward', evidence.route.parentSessionId, evidence.route.childTurnId])).digest('hex');
  const executorKey = createHash('sha256').update(JSON.stringify(['executor', executor.agentId])).digest('hex');
  let preparationBytes; try { preparationBytes = JSON.parse(input.preparationRecordBytesJson); } catch { mismatch('continuation-artifact-location', 'Preparation location bytes are malformed.'); }
  const preparations = preparationBytes.map((bytes) => { try { return { bytes, value: JSON.parse(bytes) }; } catch { mismatch('continuation-artifact-location', 'Preparation location bytes are malformed.'); } });
  const expected = [
    { role: 'executor-route', path: prefix(originKey, `hook-state/route-${routeKey}.json`), bytes: input.executorRouteRecordBytes },
    { role: 'executor', path: prefix(executionKey, `hook-state/executor-${executorKey}.json`), bytes: input.executorRecordBytes },
    { role: 'binding-authority', path: prefix(executionKey, `rescue-binding-authority-${authority.key}.json`), bytes: input.bindingAuthorityBytes },
    { role: 'binding-partition', path: prefix(executionKey, `rescue-binding-session-${prePartition.key}.json`), bytes: input.bindingPreReservationBytes },
    { role: 'binding-partition', path: prefix(executionKey, `rescue-binding-session-${partition.key}.json`), bytes: input.bindingPartitionBytes },
    ...preparations.map(({ bytes, value }) => ({ role: 'preparation', path: prefix(executionKey, `invocations/prepared/${value.key}.json`), bytes })),
  ];
  const forwardPath = prefix(originKey, `hook-state/forward-${forwardKey}.json`);
  const forwards = artifacts.filter((artifact) => artifact.role === 'forwarding' && artifact.path === forwardPath);
  if (forwards.length !== 1) mismatch('continuation-artifact-location', 'Forwarding evidence is absent, duplicated, or stored outside the origin partition.');
  let forward; try { forward = JSON.parse(forwards[0].bytes); } catch { mismatch('continuation-artifact-location', 'Forwarding evidence bytes are malformed.'); }
  const forwardKeys = ['active', 'agentId', 'generationId', 'kind', 'sessionId', 'targetWorkspace', 'turnId', 'updatedAt'];
  if (Object.keys(forward ?? {}).sort().join('\0') !== forwardKeys.sort().join('\0') || forward.kind !== 'forwarding' || forward.active !== false
    || forward.agentId !== evidence.route.agentId || forward.generationId !== evidence.route.parentGenerationId
    || forward.sessionId !== evidence.route.parentSessionId || forward.turnId !== evidence.route.childTurnId
    || forward.targetWorkspace !== evidence.executionWorkspace || !Number.isFinite(Date.parse(forward.updatedAt))) {
    mismatch('continuation-artifact-location', 'Forwarding evidence does not match the exact stopped route.');
  }
  const remaining = artifacts.filter((artifact) => artifact !== forwards[0]);
  for (const artifact of expected) {
    const matches = remaining.filter((candidate) => candidate.role === artifact.role && candidate.path === artifact.path && candidate.bytes === artifact.bytes);
    if (matches.length !== 1) mismatch('continuation-artifact-location', 'An authority artifact is missing, duplicated, substituted, or stored in another workspace partition.');
    remaining.splice(remaining.indexOf(matches[0]), 1);
  }
  if (remaining.length !== 0) mismatch('continuation-artifact-location', 'Workspace-bound artifact evidence contains an unaccounted duplicate or substitute.');
}

async function resolveReadonlyQualificationStorage(dataRoot, workspace) {
  const workspacePath = await realpath(resolve(workspace)); const dataRootPath = await realpath(resolve(dataRoot));
  const workspaceKey = createHash('sha256').update(workspacePath).digest('hex');
  const workspacesDirectory = join(dataRootPath, 'workspaces'); const directory = join(workspacesDirectory, workspaceKey);
  for (const path of [dataRootPath, workspacesDirectory, directory]) {
    const stats = await lstat(path);
    if (!stats.isDirectory() || stats.isSymbolicLink() || (process.platform !== 'win32' && (stats.mode & 0o077) !== 0) || await realpath(path) !== path) {
      throw new Error('unsafe qualification storage');
    }
  }
  return { dataRootPath, directory, workspaceKey, workspacePath };
}

async function validateCanonicalGitLineage(originWorkspace, executionWorkspace) {
  const probe = async (workspace) => {
    const { execFile } = await import('node:child_process');
    const result = await new Promise((resolve, reject) => execFile('git', ['rev-parse', '--path-format=absolute', '--is-inside-work-tree', '--show-toplevel', '--git-common-dir'],
      { cwd: workspace, encoding: 'utf8', timeout: 5_000, maxBuffer: 64 * 1024, shell: false }, (error, stdout) => error ? reject(error) : resolve(stdout)));
    const [inside, topLevel, commonDir, ...extra] = result.trimEnd().split(/\r?\n/u);
    if (inside !== 'true' || extra.length > 0 || !topLevel || !commonDir) throw new Error('invalid Git lineage');
    const [canonicalWorkspace, canonicalTopLevel, canonicalCommonDir] = await Promise.all([
      realpath(workspace), realpath(topLevel), realpath(commonDir),
    ]);
    if (canonicalTopLevel !== canonicalWorkspace) throw new Error('invalid Git lineage');
    return canonicalCommonDir;
  };
  let originCommon; let targetCommon;
  try { [originCommon, targetCommon] = await Promise.all([probe(originWorkspace), probe(executionWorkspace)]); } catch { mismatch('continuation-workspace-lineage', 'Origin and execution workspaces are not canonical linked worktrees.'); }
  if (originCommon !== targetCommon) mismatch('continuation-workspace-lineage', 'Origin and execution workspaces do not share one canonical Git common directory.');
}

function executorChildTurnId(rawBytes) {
  try { return boundedString(JSON.parse(rawBytes)?.childTurnId); }
  catch { return undefined; }
}

async function validateContinuationPreparations(parent, rawRecordsJson, expected, activeTurn, requireLongLifecycle) {
  if (typeof rawRecordsJson !== 'string' || Buffer.byteLength(rawRecordsJson) > MAX_ROLLOUT_BYTES) mismatch('continuation-preparation-records', 'Raw consumed preparation records are absent.');
  let recordBytes; try { recordBytes = JSON.parse(rawRecordsJson); } catch { mismatch('continuation-preparation-records', 'Raw consumed preparation records are malformed.'); }
  if (!Array.isArray(recordBytes) || recordBytes.length !== 2 || recordBytes.some((bytes) => typeof bytes !== 'string' || !bytes.endsWith('\n'))) mismatch('continuation-preparation-records', 'Exactly two raw consumed preparation records are required.');
  const specifications = [
    { generation: 1, source: 'explicit', resume: 'fresh', requiredExecutorAgentId: null },
    { generation: 2, source: 'proactive', resume: 'resume', requiredExecutorAgentId: expected.childThreadId },
  ];
  const parsedRecords = recordBytes.map((bytes) => { let value; try { value = JSON.parse(bytes); } catch { mismatch('continuation-preparation-records', 'A raw consumed preparation record is malformed.'); } return value; });
  if (parsedRecords[0]?.key !== parsedRecords[1]?.key) mismatch('continuation-preparation-records', 'Preparation generations must replace one exact turn slot.');
  if (requireLongLifecycle && (Date.parse(parsedRecords[1]?.createdAt) - Date.parse(activeTurn.createdAt) <= 60 * 60_000
    || Date.parse(parsedRecords[1]?.createdAt) - Date.parse(parsedRecords[0]?.consumedAt) <= 60 * 60_000)) mismatch('continuation-active-turn', 'The full continuation lifecycle does not cross both legacy active-turn deadlines after generation 1 was consumed.');
  const turnEvents = parent.map((event, index) => ({ event, index })).filter(({ event }) => event?.turn_id === expected.originalParentTurnId);
  const calls = turnEvents.filter(({ event }) => event?.payload?.type === 'custom_tool_call').map(({ event, index }) => ({ event, index, host: parseCapturedHostCall(event.payload.input) }));
  const outputs = turnEvents.filter(({ event }) => event?.payload?.type === 'custom_tool_call_output');
  const prepares = calls.filter(({ host }) => host.kind === 'exec_command' && host.envelope.get('cmd')?.endsWith('/skills/rescue/launcher.mjs" prepare rescue'));
  const writes = calls.filter(({ host }) => host.kind === 'write_stdin');
  if (prepares.length !== 2 || writes.length !== 2) mismatch('continuation-preparation-protocol', 'The active parent turn must own exactly two prepare/write generations.');
  for (let generationIndex = 0; generationIndex < specifications.length; generationIndex += 1) {
    const specification = specifications[generationIndex]; const prepare = prepares[generationIndex]; const write = writes[generationIndex];
    if (prepare.host.envelope.get('tty') !== true || prepare.host.envelope.get('workdir') !== expected.workspace) mismatch('continuation-preparation-protocol', 'Preparation must use the exact TTY workspace envelope.');
    const readyOutput = outputs.filter(({ event }) => event.payload.call_id === prepare.event.payload.call_id);
    const ackOutput = outputs.filter(({ event }) => event.payload.call_id === write.event.payload.call_id);
    if (readyOutput.length !== 1 || ackOutput.length !== 1) mismatch('continuation-preparation-protocol', 'Preparation outputs are not linked one-to-one.');
    const ready = parseCapturedHostResult(readyOutput[0].event.payload.output); const ack = parseCapturedHostResult(ackOutput[0].event.payload.output);
    const expectedRoute = generationIndex === 0
      ? { version: 1, action: 'spawn', taskName: expected.agentPath.slice('/root/'.length) }
      : { version: 2, action: 'followup', target: expected.agentPath, assignment: expected.route === 'named' ? 'zcode-rescue' : 'default' };
    const expectedAck = `${JSON.stringify({ type: 'prepared', command: 'rescue', route: expectedRoute })}\n`;
    if (ready.output !== PREPARATION_READY_LINE || !Number.isSafeInteger(ready.session_id) || Object.hasOwn(ready, 'exit_code')
      || write.host.envelope.get('session_id') !== ready.session_id || typeof write.host.envelope.get('chars') !== 'string'
      || ack.output !== expectedAck || ack.exit_code !== 0 || Object.hasOwn(ack, 'session_id')
      || !(prepare.index < readyOutput[0].index && readyOutput[0].index < write.index && write.index < ackOutput[0].index)) mismatch('continuation-preparation-protocol', 'TTY readiness, one LF write, or prepared acknowledgement is invalid.');
    const chars = write.host.envelope.get('chars');
    if (!chars.endsWith('\n') || chars.slice(0, -1).includes('\n')) mismatch('continuation-preparation-route', 'Preparation is not one LF-terminated envelope.');
    let envelope; try { envelope = await readRescuePreparation(Readable.from([chars])); } catch { mismatch('continuation-preparation-route', 'Production preparation parser rejected the raw LF envelope.'); }
    if (envelope.source !== specification.source || envelope.options.resume !== specification.resume || (envelope.options.execution ?? 'foreground') !== expected.execution) mismatch('continuation-preparation-route', 'Preparation source or exact route is invalid.');
    const expectedTarget = generationIndex === 0 ? null : { childId: expected.childThreadId, agentPath: expected.agentPath };
    if (envelope.version !== 2 || !isDeepStrictEqual(envelope.continuationTarget, expectedTarget)) {
      mismatch('continuation-target-preparation', 'Preparation does not retain the exact linked lifecycle target.');
    }
    const record = parsedRecords[generationIndex];
    const keys = ['activation', 'consumedAt', 'createdAt', 'envelope', 'executorAgentId', 'expiresAt', 'generation', 'key', 'permissionMode', 'requiredExecutorAgentId', 'sessionId', 'source', 'turnId', 'version', 'workspace'];
    const expectedActivation = generationIndex === 0 ? { kind: 'spawn', taskName: expectedRoute.taskName, agentPathDigest: createHash('sha256').update(expected.agentPath).digest('hex') } : record?.activation;
    const exactReactivation = generationIndex === 0 || expectedActivation?.kind === 'reactivate'
      && Object.keys(expectedActivation).sort().join('\0') === ['agentPathDigest', 'anchorJobId', 'bindingKey', 'bindingUpdatedAt', 'currentJobId', 'executorAgentId', 'kind', 'operationId', 'zcodeSessionId'].sort().join('\0')
      && expectedActivation.executorAgentId === expected.childThreadId
      && expectedActivation.agentPathDigest === createHash('sha256').update(expected.agentPath).digest('hex')
      && ['anchorJobId', 'bindingKey', 'currentJobId', 'operationId'].every((key) => /^[a-f0-9]{64}$/u.test(expectedActivation[key]))
      && boundedString(expectedActivation.zcodeSessionId) && Number.isFinite(Date.parse(expectedActivation.bindingUpdatedAt));
    if (generationIndex === 1 && expectedActivation?.agentPathDigest !== createHash('sha256').update(expected.agentPath).digest('hex')) {
      mismatch('continuation-target-activation', 'Prepared activation does not prove the exact selected route path.');
    }
    if (!record || Object.keys(record).sort().join('\0') !== keys.sort().join('\0') || record.version !== 3 || record.generation !== specification.generation
      || record.requiredExecutorAgentId !== specification.requiredExecutorAgentId || !/^[a-f0-9]{64}$/u.test(record.key)
      || !exactReactivation || !isDeepStrictEqual(record.activation, expectedActivation)
      || record.sessionId !== expected.parentSessionId || record.turnId !== expected.originalParentTurnId || record.workspace !== expected.workspace || record.permissionMode !== expected.permissionMode
      || record.executorAgentId !== expected.childThreadId || record.source !== specification.source || JSON.stringify(record.envelope) !== JSON.stringify(envelope)
      || !Number.isFinite(Date.parse(record.createdAt)) || Date.parse(record.expiresAt) - Date.parse(record.createdAt) !== 30 * 60_000
      || Date.parse(record.createdAt) < Date.parse(prepare.event.timestamp) || Date.parse(record.createdAt) > Date.parse(ackOutput[0].event.timestamp)
      || !Number.isFinite(Date.parse(record.consumedAt)) || Date.parse(record.consumedAt) < Date.parse(record.createdAt)
      || Date.parse(record.consumedAt) >= Date.parse(record.expiresAt)) mismatch('continuation-preparation-records', 'Consumed preparation identity or single-consume state is invalid.');
  }
  await assertPreparationGenerationsWithProduction(parsedRecords, expected);
  return parsedRecords;
}

async function assertPreparationGenerationsWithProduction(records, expected) {
  const dataRoot = await mkdtemp(join(tmpdir(), 'zcode-qualification-preparation-'));
  try {
    const store = createRescuePreparationStore({ dataRoot }); const [first, second] = records;
    const identity = { sessionId: first.sessionId, turnId: first.turnId, workspace: expected.workspace, permissionMode: first.permissionMode };
    await store.save({ ...identity, envelope: first.envelope, activation: first.activation, recordedPrompt: '$zcode:rescue fixture', now: first.createdAt });
    const consumedFirst = await store.consume({ ...identity, executorAgentId: first.executorAgentId,
      activationProof: { kind: 'spawn', taskName: first.activation.taskName, agentPathDigest: first.activation.agentPathDigest }, now: first.consumedAt });
    if (!isDeepStrictEqual(consumedFirst, first)) mismatch('continuation-preparation-records', 'Production preparation store did not reproduce consumed generation 1.');
    await store.save({ ...identity, envelope: second.envelope, activation: second.activation, recordedPrompt: 'proactive fixture', now: second.createdAt });
    const activationProof = { kind: 'reactivate', agentPathDigest: second.activation.agentPathDigest };
    await assertRejectCode(store.consume({ ...identity, executorAgentId: 'sibling-executor', activationProof, now: second.consumedAt }), 'RESCUE_PREPARATION_MISMATCH');
    const consumedSecond = await store.consume({ ...identity, executorAgentId: second.executorAgentId, activationProof, now: second.consumedAt });
    if (!isDeepStrictEqual(consumedSecond, second)) mismatch('continuation-preparation-records', 'Production preparation store did not reproduce the fresh expired-tombstone successor.');
    await assertRejectCode(store.consume({ ...identity, executorAgentId: second.executorAgentId, activationProof, now: second.consumedAt }), 'RESCUE_PREPARATION_CONSUMED');
  } finally { await rm(dataRoot, { recursive: true, force: true }); }
}

async function assertRejectCode(promise, code) {
  try { await promise; } catch (error) { if (error?.code === code) return; }
  mismatch('continuation-preparation-records', 'Production preparation store did not enforce the expected one-shot generation boundary.');
}

function assertMandatoryContinuationPublicSurfaces(parent, child, jobs, agentPath, execFrames, childThreadId) {
  const calls = [...parent, ...child].filter((event) => event?.payload?.type === 'custom_tool_call');
  const hosts = calls.map((event) => parseCapturedHostCall(event.payload.input));
  const argv = hosts.map((host) => host.envelope.get('cmd')).filter((value) => typeof value === 'string');
  const env = hosts.map((host) => host.envelope.get('env')).filter((value) => value && typeof value === 'object' && !Array.isArray(value));
  const rawToolOutputs = [...parent, ...child].filter((event) => event?.payload?.type === 'custom_tool_call_output').map((event) => event.payload.output);
  const toolResults = rawToolOutputs.map((output) => parseCapturedHostResult(output));
  const stdout = toolResults.filter((result) => Object.hasOwn(result, 'output')).map((result) => result.output);
  const stderr = rawToolOutputs.map((output) => output?.[0]?.text).filter((value) => typeof value === 'string');
  const progress = child.filter((event) => event?.payload?.type === 'agent_message').map((event) => event.payload.message);
  const assignment = namedCalls(parent, 'spawn_agent').concat(namedCalls(parent, 'followup_task')).map((event) => parseObject(event.payload.arguments, 'continuation-assignment').message);
  const callMetadata = [...parent, ...child].filter((event) => ['custom_tool_call', 'function_call'].includes(event?.payload?.type)).map((event) => event.payload.call_id);
  const surfaces = { assignment, argv, env, stdout, stderr, progress, status: jobs.map((job) => job.status), agentPath: [agentPath], callMetadata, execFrames };
  if ([assignment, argv, env, stdout, stderr, progress, surfaces.status, surfaces.agentPath, callMetadata].some((values) => values.length === 0)) mismatch('continuation-public-surfaces', 'Mandatory raw public surfaces are absent.');
  if (execFrames.length === 0) mismatch('continuation-public-surfaces', 'Mandatory raw execution frames are absent.');
  if (JSON.stringify({ assignment, argv, env, stdout, stderr, progress, status: surfaces.status, execFrames }).includes(childThreadId)) {
    mismatch('continuation-private-leak', 'A plugin-controlled surface additionally propagates the private child ID.');
  }
}

function redactValidatedPreparationInputs(parent) {
  return structuredClone(parent).map((event) => {
    if (event?.payload?.type !== 'custom_tool_call') return event;
    const host = parseCapturedHostCall(event.payload.input);
    if (host.kind !== 'write_stdin') return event;
    const envelope = Object.fromEntries(host.envelope);
    if (typeof envelope.chars === 'string') envelope.chars = '[private preparation envelope]';
    event.payload.input = JSON.stringify({ kind: host.kind, envelope });
    return event;
  });
}

function eventTimestamp(event) {
  const value = boundedString(event?.timestamp);
  const match = value === undefined ? null : /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/u.exec(value);
  if (!match) return undefined;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const offsetHour = match[10] === undefined ? 0 : Number(match[10]); const offsetMinute = match[11] === undefined ? 0 : Number(match[11]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1]
    || hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59) return undefined;
  const adjustedYear = year - (month <= 2 ? 1 : 0); const era = Math.floor(adjustedYear / 400); const yearOfEra = adjustedYear - era * 400;
  const adjustedMonth = month + (month > 2 ? -3 : 9); const dayOfYear = Math.floor((153 * adjustedMonth + 2) / 5) + day - 1;
  const dayOfEra = yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  const epochDays = era * 146097 + dayOfEra - 719468;
  const offsetSeconds = (offsetHour * 60 + offsetMinute) * 60 * (match[9] === '-' ? -1 : 1);
  const epochSeconds = BigInt(epochDays * 86_400 + hour * 3_600 + minute * 60 + second - offsetSeconds);
  return epochSeconds * 1_000_000_000n + BigInt((match[7] ?? '').padEnd(9, '0'));
}

function childReturnText(event, agentPath) {
  const content = event.payload.content;
  if (!Array.isArray(content) || content.length !== 1 || content[0]?.type !== 'input_text') mismatch('choice-child-return-shape', 'A child return is not one structured input_text item.');
  const text = boundedString(content[0].text);
  const prefix = `Message Type: FINAL_ANSWER\nTask name: /root\nSender: ${agentPath}\nPayload:\n`;
  if (!text?.startsWith(prefix)) mismatch('choice-child-return-shape', 'A child return envelope does not match the retained child.');
  return text.slice(prefix.length);
}

function encrypted(value) { return typeof value === 'string' && /^gAAAA[A-Za-z0-9_-]{40,}={0,2}$/u.test(value); }

function assertParentIsolation(parent, options, forbiddenText) {
  for (const event of parent) {
    if (event?.type === 'response_item' && event.payload?.type === 'custom_tool_call' && event.payload.name === 'exec') {
      const host = parseCapturedHostCall(event.payload.input);
      const command = host.kind === 'exec_command' ? host.envelope.get('cmd') : undefined;
      if (isCompanionCommand(command)
        && command !== options.expectedPreflightCommand
        && command !== options.expectedPreparationCommand) {
        mismatch('parent-inline-command', 'The parent executed a Rescue companion command outside the exact preparation protocol.');
      }
    }
    let visible;
    if (event?.type === 'event_msg' && event.payload?.type === 'agent_message') visible = event.payload.message;
    else if (event?.type === 'response_item' && event.payload?.type === 'custom_tool_call_output') visible = event.payload.output;
    else if (event?.type === 'event_msg' && ['item_started', 'item_completed'].includes(event.payload?.type)) visible = event.payload.item;
    if (visible === undefined) continue;
    const text = boundedJson(visible);
    if (forbiddenText.some((marker) => typeof marker === 'string' && marker.length > 0 && text.includes(marker))) {
      mismatch('parent-isolation-breach', 'Child stderr, progress, or tool output entered a parent-visible event.');
    }
  }
}

function assertParentPreparation(parent, spawnIndex, startIndex, options) {
  if (typeof options.expectedPreparationCommand !== 'string' || !options.expectedPreparationCommand
    || typeof options.expectedPreparationPayload !== 'string' || !options.expectedPreparationPayload) {
    mismatch('preparation-contract-missing', 'The trusted preparation command and private envelope contract are required.');
  }
  const calls = parent
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => event?.type === 'response_item' && event.payload?.type === 'custom_tool_call' && event.payload.name === 'exec')
    .map(({ event, index }) => ({ event, index, host: parseCapturedHostCall(event.payload.input) }));
  const execCalls = calls.filter(({ host }) => host.kind === 'exec_command');
  const writeCalls = calls.filter(({ host }) => host.kind === 'write_stdin');
  const preflights = execCalls.filter(({ host }) => host.envelope.get('cmd') === options.expectedPreflightCommand);
  if (preflights.length === 0) {
    if (execCalls.some(({ host }) => isCompanionCommand(host.envelope.get('cmd'))
      && host.envelope.get('cmd') !== options.expectedPreparationCommand)) mismatch('preflight-command-mismatch', 'The parent companion preflight command is not exact.');
    mismatch('preflight-count', 'The parent rollout must contain exactly one readiness preflight.');
  }
  if (preflights.length !== 1) mismatch('preflight-count', 'The parent rollout must contain exactly one readiness preflight.');
  const preflight = preflights[0];
  assertExecEnvelope(preflight.host.envelope, options.expectedPreflightCommand, options.expectedWorkspace, 'preflight-envelope-mismatch');
  const outputs = parent
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => event?.type === 'response_item' && event.payload?.type === 'custom_tool_call_output');
  const linked = outputs.filter(({ event }) => event.payload.call_id === preflight.event.payload.call_id);
  if (linked.length !== 1) mismatch('preflight-output-link', 'The readiness output does not link exactly once to the preflight call.');
  const preflightResult = parseCapturedHostResult(linked[0].event.payload.output);
  if (preflightResult.exit_code !== 0 || Object.hasOwn(preflightResult, 'session_id')) mismatch('preflight-status-mismatch', 'The readiness preflight must exit exactly zero.');
  const statusText = preflightResult.output.trim();
  let status;
  try { status = JSON.parse(statusText); } catch { mismatch('preflight-status-mismatch', 'The readiness output is not exact bounded JSON.'); }
  assertExactKeys(status, ['role', 'status', 'type'], 'preflight-status-mismatch');
  if (status.type !== 'role-status' || status.role !== 'zcode-rescue' || status.status !== 'ready') {
    mismatch('preflight-status-mismatch', 'The readiness output does not report the Rescue Role ready.');
  }

  const preparations = execCalls.filter(({ host }) => host.envelope.get('cmd') === options.expectedPreparationCommand);
  if (preparations.length !== 1) mismatch('preparation-count', 'The parent rollout must contain exactly one private preparation process.');
  const preparation = preparations[0];
  assertExecEnvelope(preparation.host.envelope, options.expectedPreparationCommand, options.expectedWorkspace, 'preparation-envelope-mismatch', { tty: true });
  const readyOutputs = outputs.filter(({ event }) => event.payload.call_id === preparation.event.payload.call_id);
  if (readyOutputs.length !== 1) mismatch('preparation-ready-count', 'The preparation process must expose exactly one linked raw-input readiness result.');
  const ready = parseCapturedHostResult(readyOutputs[0].event.payload.output);
  if (ready.output.includes(options.expectedPreparationPayload)) mismatch('preparation-payload-echo', 'The preparation tool output echoed the private frame.');
  if (ready.output !== PREPARATION_READY_LINE || !Number.isSafeInteger(ready.session_id) || ready.session_id <= 0
    || Object.hasOwn(ready, 'exit_code')) mismatch('preparation-ready-mismatch', 'The preparation process did not expose the exact nonterminal task-free readiness contract.');

  if (writeCalls.length !== 1) mismatch('preparation-write-count', 'The parent must write exactly one private preparation frame.');
  const write = writeCalls[0];
  assertExactKeys(Object.fromEntries(write.host.envelope), ['chars', 'session_id'], 'preparation-write-envelope');
  const expectedFrame = `${options.expectedPreparationPayload}\n`;
  if (write.host.envelope.get('session_id') !== ready.session_id) mismatch('preparation-write-handle', 'The private preparation frame was not written to the readiness handle.');
  if (write.host.envelope.get('chars') !== expectedFrame || expectedFrame.includes('\u0004')
    || options.expectedPreparationPayload.includes('\n') || !expectedFrame.endsWith('\n') || expectedFrame.endsWith('\n\n')) {
    mismatch('preparation-write-frame', 'The parent write must contain exactly one LF-terminated private JSON frame without EOF.');
  }
  let payload;
  assertExactPreparationJson(options.expectedPreparationPayload);
  try { payload = JSON.parse(options.expectedPreparationPayload); } catch { mismatch('preparation-payload-contract', 'The trusted preparation envelope is not exact JSON.'); }
  const envelopeKeys = payload?.version === 1 ? ['options', 'source', 'task', 'version']
    : payload?.version === 2 ? ['continuationTarget', 'options', 'source', 'task', 'version'] : [];
  assertExactKeys(payload, envelopeKeys, 'preparation-payload-contract');
  if (!payload.options || typeof payload.options !== 'object' || Array.isArray(payload.options)) {
    mismatch('preparation-payload-contract', 'The trusted preparation envelope differs from the bounded Rescue contract.');
  }
  const optionKeys = Object.keys(payload.options);
  const validModel = (value) => typeof value === 'string' && value.trim().length > 0
    && Buffer.byteLength(value, 'utf8') <= MAX_RESCUE_MODEL_BYTES
    && ![...value].some((character) => { const point = character.codePointAt(0); return point <= 31 || point >= 127 && point <= 159; });
  const target = payload.version === 2 ? payload.continuationTarget : null;
  const validTarget = target === null || target && typeof target === 'object' && !Array.isArray(target)
    && Object.keys(target).sort().join('\0') === ['agentPath', 'childId'].sort().join('\0')
    && typeof target.childId === 'string' && target.childId.length > 0 && Buffer.byteLength(target.childId, 'utf8') <= 512
    && typeof target.agentPath === 'string' && Buffer.byteLength(target.agentPath, 'utf8') <= 1024
    && /^\/root\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/u.test(target.agentPath)
    && ![...target.childId].some((character) => { const point = character.codePointAt(0); return point <= 31 || point >= 127 && point <= 159; });
  if (![1, 2].includes(payload.version) || payload.version === 2 && (!validTarget || target !== null && payload.options?.resume !== 'resume') || !['explicit', 'proactive'].includes(payload.source)
    || typeof payload.task !== 'string' || !payload.task.trim() || Buffer.byteLength(payload.task, 'utf8') > MAX_RESCUE_TASK_BYTES
    || optionKeys.some((key) => !['effort', 'execution', 'model', 'resume'].includes(key) || payload.options[key] === null)
    || payload.options.execution !== undefined && !['foreground', 'background'].includes(payload.options.execution)
    || payload.options.resume !== undefined && !['fresh', 'resume'].includes(payload.options.resume)
    || payload.options.effort !== undefined && !RESCUE_EFFORTS.has(payload.options.effort)
    || payload.options.model !== undefined && !validModel(payload.options.model)) {
    mismatch('preparation-payload-contract', 'The trusted preparation envelope differs from the bounded Rescue contract.');
  }
  assertParentPreparationTaskExclusivity(parent, write.event, payload.task, calls, outputs);
  const writeOutputs = outputs.filter(({ event }) => event.payload.call_id === write.event.payload.call_id);
  if (writeOutputs.length !== 1) mismatch('preparation-ack-count', 'The private preparation write must expose exactly one linked terminal acknowledgement.');
  const acknowledged = parseCapturedHostResult(writeOutputs[0].event.payload.output);
  if (acknowledged.output.includes(options.expectedPreparationPayload)) mismatch('preparation-payload-echo', 'The preparation tool output echoed the private frame.');
  const expectedAck = `${JSON.stringify({ type: 'prepared', command: 'rescue', route: { version: 1, action: 'spawn', taskName: options.expectedTaskName } })}\n`;
  if (acknowledged.output !== expectedAck || acknowledged.exit_code !== 0 || Object.hasOwn(acknowledged, 'session_id')) {
    mismatch('preparation-ack-mismatch', 'The preparation acknowledgement must be task-free and exit exactly zero.');
  }
  if (!(preflight.index < linked[0].index && linked[0].index < preparation.index
    && preparation.index < readyOutputs[0].index && readyOutputs[0].index < write.index
    && write.index < writeOutputs[0].index && writeOutputs[0].index < spawnIndex && spawnIndex < startIndex)) {
    mismatch('preparation-order', 'Role readiness, raw readiness, one private write, acknowledgement, spawn, and child start are out of order.');
  }
}

function assertParentPreparationTaskExclusivity(parent, writeEvent, task, calls, outputs) {
  for (const event of parent) {
    boundedJson(event);
    if (parentEventStringContainsTask(event, task, writeEvent)) {
      mismatch('preparation-task-exclusivity', 'The private Rescue task escaped the single authorized preparation write.');
    }
  }
  for (const call of calls) {
    const decoded = Object.fromEntries(call.host.envelope);
    if (call.event === writeEvent) delete decoded.chars;
    if (stringLeafContains(decoded, task)) {
      mismatch('preparation-task-exclusivity', 'The private Rescue task escaped the single authorized preparation write.');
    }
  }
  for (const { event } of outputs) {
    const linkedCall = calls.find((call) => call.event.payload.call_id === event.payload.call_id);
    if (linkedCall?.host.legacy) {
      for (const item of event.payload.output ?? []) {
        if (typeof item?.text !== 'string') continue;
        if (boundedOutputContainsTask(item.text, task)) {
          mismatch('preparation-task-exclusivity', 'The private Rescue task escaped the single authorized preparation write.');
        }
      }
      continue;
    }
    let result;
    try { result = parseCapturedHostResult(event.payload.output); } catch { continue; }
    if (boundedStringLeavesContainTask(result, task)) {
      mismatch('preparation-task-exclusivity', 'The private Rescue task escaped the single authorized preparation write.');
    }
  }
  for (const event of parent.filter((candidate) => candidate?.type === 'response_item' && candidate.payload?.type === 'function_call')) {
    let args;
    try { args = parseObject(event.payload.arguments, 'preparation-task-exclusivity'); } catch { continue; }
    if (stringLeafContains(args, task)) {
      mismatch('preparation-task-exclusivity', 'The private Rescue task escaped the single authorized preparation write.');
    }
  }
}

function parentEventStringContainsTask(event, task, writeEvent) {
  const pending = [{ value: event, parent: undefined, key: undefined }];
  while (pending.length > 0) {
    const { value, parent, key } = pending.pop();
    if (typeof value === 'string') {
      const authorizedPreparationInput = event === writeEvent && parent === event.payload && key === 'input';
      const authorizedUserPrompt = event?.type === 'event_msg' && event.payload?.type === 'user_message'
        && parent === event.payload && key === 'message';
      if (!authorizedPreparationInput && !authorizedUserPrompt && value.includes(task)) return true;
      continue;
    }
    if (!value || typeof value !== 'object') continue;
    for (const [childKey, child] of Object.entries(value)) pending.push({ value: child, parent: value, key: childKey });
  }
  return false;
}

function stringLeafContains(value, task) {
  const pending = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current === 'string') {
      if (current.includes(task)) return true;
    } else if (current && typeof current === 'object') {
      pending.push(...Object.values(current));
    }
  }
  return false;
}

function boundedOutputContainsTask(text, task) {
  if (Buffer.byteLength(text, 'utf8') > MAX_LEGACY_JSON_DECODE_BYTES) {
    mismatch('preparation-task-exclusivity', 'The bounded parent output decoding budget was exceeded.');
  }
  const escapedTask = JSON.stringify(task).slice(1, -1);
  const pending = [{ text, depth: 0 }]; const seen = new Set();
  let candidateCount = 0; let decodedBytes = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (current.text.includes(task) || current.text.includes(escapedTask)) return true;
    if (current.depth >= MAX_LEGACY_JSON_DEPTH) {
      for (const candidate of jsonTextCandidates(current.text)) {
        try {
          JSON.parse(candidate);
          mismatch('preparation-task-exclusivity', 'The bounded parent output decoding budget was exceeded.');
        } catch (error) {
          if (error instanceof CodexRescueEvidenceMismatchError) throw error;
        }
      }
      continue;
    }
    const candidates = jsonTextCandidates(current.text);
    for (const candidate of candidates) {
      if (seen.has(candidate)) continue;
      seen.add(candidate); candidateCount += 1; decodedBytes += Buffer.byteLength(candidate, 'utf8');
      if (candidateCount > MAX_LEGACY_JSON_CANDIDATES || decodedBytes > MAX_LEGACY_JSON_DECODE_BYTES) {
        mismatch('preparation-task-exclusivity', 'The bounded parent output decoding budget was exceeded.');
      }
      let decoded;
      try { decoded = JSON.parse(candidate); } catch { continue; }
      if (stringLeafContains(decoded, task)) return true;
      for (const leaf of stringLeaves(decoded)) pending.push({ text: leaf, depth: current.depth + 1 });
    }
  }
  return false;
}

function boundedStringLeavesContainTask(value, task) {
  for (const leaf of stringLeaves(value)) {
    if (boundedOutputContainsTask(leaf, task)) return true;
  }
  return false;
}

function jsonTextCandidates(text) {
  const candidates = new Set();
  const add = (value) => {
    const trimmed = value.trim();
    if (!trimmed || candidates.has(trimmed)) return;
    candidates.add(trimmed);
    if (candidates.size > MAX_LEGACY_JSON_CANDIDATES) {
      mismatch('preparation-task-exclusivity', 'The bounded parent output decoding budget was exceeded.');
    }
  };
  add(text);
  const containers = [];
  let stringStart;
  let escaped = false;
  for (let offset = 0; offset < text.length; offset += 1) {
    const character = text[offset];
    if (stringStart !== undefined) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') {
        add(text.slice(stringStart, offset + 1));
        stringStart = undefined;
      }
      continue;
    }
    if (character === '"') {
      stringStart = offset;
      continue;
    }
    if (character === '{' || character === '[') {
      containers.push({ character, offset });
      if (containers.length > MAX_LEGACY_JSON_CANDIDATES) {
        mismatch('preparation-task-exclusivity', 'The bounded parent output decoding budget was exceeded.');
      }
      continue;
    }
    if (character !== '}' && character !== ']') continue;
    const opening = containers.pop();
    if (!opening) continue;
    if ((opening.character === '{') !== (character === '}')) {
      containers.length = 0;
      continue;
    }
    add(text.slice(opening.offset, offset + 1));
  }
  if (stringStart !== undefined) add(JSON.stringify(decodeJsonStringPrefix(text, stringStart + 1)));
  return candidates;
}

function decodeJsonStringPrefix(text, start) {
  const chunks = [];
  let literalStart = start;
  let offset = start;
  const finish = (end = offset) => {
    if (literalStart < end) chunks.push(text.slice(literalStart, end));
    return chunks.join('');
  };
  while (offset < text.length) {
    const character = text[offset];
    if (character.charCodeAt(0) <= 0x1f) return finish();
    if (character !== '\\') {
      offset += 1;
      continue;
    }
    if (literalStart < offset) chunks.push(text.slice(literalStart, offset));
    offset += 1;
    if (offset >= text.length) return chunks.join('');
    const escapedCharacter = text[offset];
    const decodedEscape = escapedCharacter === '"' || escapedCharacter === '\\' || escapedCharacter === '/'
      ? escapedCharacter
      : { b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' }[escapedCharacter];
    if (decodedEscape !== undefined) {
      chunks.push(decodedEscape);
      offset += 1;
      literalStart = offset;
      continue;
    }
    if (escapedCharacter !== 'u' || offset + 4 >= text.length) return chunks.join('');
    let codeUnit = 0;
    for (let digitOffset = 1; digitOffset <= 4; digitOffset += 1) {
      const digit = Number.parseInt(text[offset + digitOffset], 16);
      if (!Number.isInteger(digit) || !/[0-9a-f]/iu.test(text[offset + digitOffset])) return chunks.join('');
      codeUnit = codeUnit * 16 + digit;
    }
    chunks.push(String.fromCharCode(codeUnit));
    offset += 5;
    literalStart = offset;
  }
  return finish(text.length);
}

function stringLeaves(value) {
  const leaves = []; const pending = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current === 'string') leaves.push(current);
    else if (current && typeof current === 'object') pending.push(...Object.values(current));
  }
  return leaves;
}

function assertExactPreparationJson(text) {
  if (typeof text !== 'string' || Buffer.byteLength(`${text}\n`, 'utf8') > MAX_RESCUE_ENVELOPE_BYTES) {
    mismatch('preparation-payload-contract', 'The trusted preparation envelope differs from the bounded Rescue contract.');
  }
  let offset = 0; let depth = 0;
  const whitespace = () => { while (/\s/u.test(text[offset] ?? '')) offset += 1; };
  const string = () => {
    if (text[offset] !== '"') mismatch('preparation-payload-contract', 'The trusted preparation envelope is not exact JSON.');
    const start = offset++; let escaped = false;
    while (offset < text.length) {
      const character = text[offset++];
      if (escaped) { escaped = false; continue; }
      if (character === '\\') { escaped = true; continue; }
      if (character === '"') {
        try { return JSON.parse(text.slice(start, offset)); } catch { mismatch('preparation-payload-contract', 'The trusted preparation envelope is not exact JSON.'); }
      }
    }
    mismatch('preparation-payload-contract', 'The trusted preparation envelope is not exact JSON.');
  };
  const value = () => {
    whitespace();
    if (text[offset] === '{') { object(); return; }
    if (text[offset] === '[') { array(); return; }
    if (text[offset] === '"') { string(); return; }
    const start = offset;
    while (offset < text.length && !/[\s,\]}]/u.test(text[offset])) offset += 1;
    if (offset === start) mismatch('preparation-payload-contract', 'The trusted preparation envelope is not exact JSON.');
  };
  const object = () => {
    offset += 1; depth += 1;
    if (depth > MAX_PREPARATION_JSON_DEPTH) mismatch('preparation-payload-contract', 'The trusted preparation envelope differs from the bounded Rescue contract.');
    whitespace(); const keys = new Set();
    if (text[offset] === '}') { offset += 1; depth -= 1; return; }
    while (offset < text.length) {
      whitespace(); const key = string(); whitespace();
      if (keys.has(key)) mismatch('preparation-payload-contract', 'The trusted preparation envelope differs from the bounded Rescue contract.');
      keys.add(key);
      if (text[offset++] !== ':') mismatch('preparation-payload-contract', 'The trusted preparation envelope is not exact JSON.');
      value(); whitespace();
      if (text[offset] === '}') { offset += 1; depth -= 1; return; }
      if (text[offset++] !== ',') mismatch('preparation-payload-contract', 'The trusted preparation envelope is not exact JSON.');
    }
    mismatch('preparation-payload-contract', 'The trusted preparation envelope is not exact JSON.');
  };
  const array = () => {
    offset += 1; depth += 1;
    if (depth > MAX_PREPARATION_JSON_DEPTH) mismatch('preparation-payload-contract', 'The trusted preparation envelope differs from the bounded Rescue contract.');
    whitespace();
    if (text[offset] === ']') { offset += 1; depth -= 1; return; }
    while (offset < text.length) {
      value(); whitespace();
      if (text[offset] === ']') { offset += 1; depth -= 1; return; }
      if (text[offset++] !== ',') mismatch('preparation-payload-contract', 'The trusted preparation envelope is not exact JSON.');
    }
    mismatch('preparation-payload-contract', 'The trusted preparation envelope is not exact JSON.');
  };
  whitespace(); value(); whitespace();
  if (offset !== text.length) mismatch('preparation-payload-contract', 'The trusted preparation envelope is not exact JSON.');
}

function assertExecEnvelope(envelope, expectedCommand, expectedWorkspace, code, extensions = {}) {
  if (!envelope || typeof envelope.get !== 'function' || typeof envelope.keys !== 'function') mismatch(code, 'The exec envelope is absent.');
  const allowed = new Set(EXEC_ENVELOPE_KEYS); if (extensions.tty) allowed.add('tty');
  for (const key of envelope.keys()) if (!allowed.has(key)) mismatch(code, 'The exec envelope contains a forbidden field.');
  if (envelope.get('cmd') !== expectedCommand || envelope.get('workdir') !== expectedWorkspace) {
    mismatch(code === 'child-exec-envelope-mismatch' && envelope.get('cmd') !== expectedCommand ? 'child-command-mismatch' : code, 'The exec command or canonical workspace differs from the contract.');
  }
  if (envelope.has('yield_time_ms') && (!Number.isInteger(envelope.get('yield_time_ms')) || envelope.get('yield_time_ms') < 250 || envelope.get('yield_time_ms') > 30_000)) mismatch(code, 'yield_time_ms is outside the captured safe bound.');
  if (envelope.has('max_output_tokens') && (!Number.isInteger(envelope.get('max_output_tokens')) || envelope.get('max_output_tokens') < 1 || envelope.get('max_output_tokens') > 100_000)) mismatch(code, 'max_output_tokens is outside the captured safe bound.');
  if (extensions.tty && envelope.get('tty') !== true) mismatch(code, 'The preparation exec must request a PTY.');
}

function assertTerminalSentinel(output, sentinel) {
  const text = terminalOutputText(output, 'child-output-mismatch');
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const occurrences = output.flatMap((item) => item.text.split('\n')).filter((line) => line === sentinel).length;
  if (lines.at(-1) !== sentinel || occurrences !== 1) {
    mismatch('child-output-mismatch', 'The unique public sentinel is not the terminal child stdout line.');
  }
}

function assertSemanticProgress(output, expected) {
  if (expected === undefined) return;
  assertExactKeys(expected, ['start', 'terminal', 'snapshotFallback', 'lifecycleOnly'], 'semantic-progress-contract');
  const start = boundedString(expected.start); const terminal = boundedString(expected.terminal);
  const snapshotFallback = boundedString(expected.snapshotFallback); const lifecycleOnly = boundedString(expected.lifecycleOnly);
  if (!start || !terminal || !snapshotFallback || !lifecycleOnly
    || ![start, terminal, snapshotFallback, lifecycleOnly].every((line) => line.startsWith('[zcode] '))) mismatch('semantic-progress-contract', 'Semantic progress expectations must be exact bounded allowlisted ZCode lines.');
  terminalOutputText(output, 'semantic-progress-missing');
  const lines = output.flatMap((item) => item.text.split('\n'));
  const startIndexes = lines.map((line, index) => line === start ? index : -1).filter((index) => index >= 0);
  const terminalIndexes = lines.map((line, index) => line === terminal ? index : -1).filter((index) => index >= 0);
  const diagnosticCounts = [snapshotFallback, lifecycleOnly].map((diagnostic) => lines.filter((line) => line === diagnostic).length);
  const hasSemanticPair = startIndexes.length === 1 && terminalIndexes.length === 1 && startIndexes[0] < terminalIndexes[0];
  const hasExactCompatibilityDiagnostic = diagnosticCounts.some((count) => count === 1) && diagnosticCounts.every((count) => count <= 1);
  if (!hasSemanticPair && !hasExactCompatibilityDiagnostic) {
    mismatch('semantic-progress-missing', 'The child transcript lacks one ordered safe semantic progress pair or one exact degraded diagnostic.');
  }
}

function terminalOutputText(output, code) {
  if (!Array.isArray(output) || output.length === 0 || output.length > 8) mismatch(code, 'Structured tool output is absent or exceeds its bound.');
  let total = 0;
  for (const item of output) {
    if (item?.type !== 'input_text' || typeof item.text !== 'string') mismatch(code, 'Structured tool output is not captured input_text.');
    total += Buffer.byteLength(item.text, 'utf8');
  }
  if (total > MAX_TEXT_BYTES) mismatch(code, 'Structured tool output exceeds its bound.');
  return output.at(-1).text;
}

function assertExactKeys(object, expected, code) {
  if (!object || typeof object !== 'object' || Array.isArray(object)) mismatch(code, 'Structured object is absent.');
  const actual = Object.keys(object).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) mismatch(code, 'Structured object keys differ from the captured contract.');
}

function isCompanionCommand(command) {
  return typeof command === 'string' && (command.includes('zcode-companion.mjs')
    || command.includes('skills/rescue/launcher.mjs')
    || /(?:^|\s)(?:role-status|prepare|invoke(?:-prepared|-choice|-status)?)\s+rescue(?:\s|$)/u.test(command));
}

function sessionMeta(events) {
  const metas = events.filter((event) => event?.type === 'session_meta').map((event) => event.payload);
  if (metas.length > 1) mismatch('session-meta-count', 'A rollout contains multiple session_meta records.');
  return metas[0];
}

function finalRolloutMessage(events, code) {
  const messages = events
    .filter((event) => event?.type === 'event_msg' && event.payload?.type === 'agent_message' && event.payload.phase === 'final_answer')
    .map((event) => boundedString(event.payload.message));
  if (messages.length === 0 || !messages[0]) mismatch(code, 'A rollout did not expose its final public agent message.');
  if (messages.length !== 1) mismatch('terminal-message-count', 'A rollout contains more than one final public agent message.');
  return messages[0];
}

function childReturnPayload(parent, agentPath) {
  const returns = parent.filter((event) => event?.type === 'response_item'
    && event.payload?.type === 'agent_message'
    && event.payload.author === agentPath
    && event.payload.recipient === '/root'
    && event.payload.content?.some((item) => item?.type === 'input_text' && item.text?.startsWith('Message Type: FINAL_ANSWER\n')));
  if (returns.length === 0) mismatch('child-return-unavailable', 'The parent rollout did not expose the child terminal return.');
  if (returns.length !== 1) mismatch('child-return-count', 'The parent rollout contains more than one child terminal return.');
  const content = returns[0].payload.content;
  if (!Array.isArray(content) || content.length !== 1 || content[0]?.type !== 'input_text') mismatch('child-return-content-unavailable', 'The child terminal return is not available as one structured input_text item.');
  const text = boundedString(content[0].text);
  const prefix = `Message Type: FINAL_ANSWER\nTask name: /root\nSender: ${agentPath}\nPayload:\n`;
  if (!text?.startsWith(prefix)) mismatch('child-return-envelope-mismatch', 'The child terminal return envelope does not match the linked agent.');
  return text.slice(prefix.length);
}

function finalExecMessage(frames, expectedPublicOutput, parentThreadId) {
  const threadStarts = frames.map((frame, index) => ({ frame, index })).filter(({ frame }) => frame?.type === 'thread.started');
  if (threadStarts.length !== 1) mismatch('exec-thread-start-count', 'Codex exec JSON must expose exactly one thread.started event.');
  assertExactKeys(threadStarts[0].frame, ['thread_id', 'type'], 'exec-thread-start-shape-mismatch');
  if (threadStarts[0].frame.thread_id !== parentThreadId) mismatch('exec-thread-start-shape-mismatch', 'The exec terminal sequence does not belong to the observed parent thread.');

  const turnStarts = frames.map((frame, index) => ({ frame, index })).filter(({ frame }) => frame?.type === 'turn.started');
  if (turnStarts.length !== 1) mismatch('exec-turn-start-count', 'Codex exec JSON must expose exactly one turn.started event.');
  assertExactKeys(turnStarts[0].frame, ['type'], 'exec-turn-start-shape-mismatch');
  if (threadStarts[0].index >= turnStarts[0].index) mismatch('exec-turn-order', 'The observed turn must start after its parent thread.');

  const terminals = frames.map((frame, index) => ({ frame, index })).filter(({ frame }) => ['turn.completed', 'turn.failed'].includes(frame?.type));
  if (terminals.length === 0) mismatch('exec-terminal-unavailable', 'Codex exec JSON did not expose a turn terminal event.');
  if (terminals.length !== 1) mismatch('exec-terminal-count', 'Codex exec JSON exposed more than one turn terminal event.');
  const terminal = terminals[0];
  if (terminal.index !== frames.length - 1) mismatch('exec-terminal-order', 'The turn terminal event must be the final Codex exec JSON frame.');
  if (terminal.frame.type === 'turn.failed') mismatch('exec-turn-failed', 'Codex exec reported a failed turn instead of a successful public result.');
  assertExactKeys(terminal.frame, ['type', 'usage'], 'exec-terminal-shape-mismatch');
  assertExecUsage(terminal.frame.usage);

  const messages = frames
    .map((frame, index) => ({ frame, index }))
    .filter(({ frame }) => frame?.type === 'item.completed' && frame.item?.type === 'agent_message')
    .map(({ frame, index }) => ({ index, text: boundedString(frame.item.text) }));
  if (messages.length === 0) mismatch('exec-public-output-unavailable', 'Codex exec JSON did not expose an agent message.');
  if (messages.length > MAX_EXEC_AGENT_MESSAGES || messages.some(({ text }) => text === undefined)) mismatch('exec-agent-messages-invalid', 'Codex exec agent messages exceed their count or text bound.');
  if (messages.some(({ index }) => index <= turnStarts[0].index || index >= terminal.index)) mismatch('exec-terminal-order', 'Every agent message must occur inside the observed successful turn.');
  const finalMessage = messages.at(-1);
  if (finalMessage.text !== expectedPublicOutput) mismatch('exec-public-output-mismatch', 'The last Codex exec agent message is not the exact public sentinel.');
  if (messages.filter(({ text }) => text === expectedPublicOutput).length !== 1) mismatch('exec-public-output-count', 'The public sentinel must occur in exactly one Codex exec agent message.');
  return finalMessage.text;
}

function assertExecUsage(usage) {
  const keys = ['cache_write_input_tokens', 'cached_input_tokens', 'input_tokens', 'output_tokens', 'reasoning_output_tokens'];
  assertExactKeys(usage, keys, 'exec-terminal-shape-mismatch');
  for (const key of keys) {
    if (!Number.isSafeInteger(usage[key]) || usage[key] < 0) mismatch('exec-terminal-shape-mismatch', 'Codex exec turn usage is not a bounded non-negative integer.');
  }
}

function parseCapturedExecEnvelope(input) {
  const source = boundedString(input);
  if (!source) return [];
  const prefix = 'const r = await tools.exec_command(';
  const suffixes = [
    ');\ntext(r.output);\n',
    '); text(r.output);\n',
    ');\ntext(r.output);\nif (r.session_id) text(`SESSION_ID=${r.session_id}`);\n',
  ];
  const suffix = suffixes.find((candidate) => source.endsWith(candidate));
  if (!source.startsWith(prefix) || !suffix || source.indexOf('tools.exec_command', prefix.length) !== -1) {
    mismatch('child-command-encoding', 'The exec evidence does not match one captured 0.147 wrapper.');
  }
  const objectSource = source.slice(prefix.length, -suffix.length);
  const values = parseTopLevelExecObject(objectSource);
  return values;
}

function parseCapturedHostCall(input) {
  const source = boundedString(input);
  if (!source) mismatch('child-command-encoding', 'The child host-call evidence is absent.');
  const structured = [
    ['exec_command', 'const r = await tools.exec_command('],
    ['write_stdin', 'const r = await tools.write_stdin('],
  ];
  const suffix = '); text(JSON.stringify(r))\n';
  for (const [kind, prefix] of structured) {
    if (!source.startsWith(prefix)) continue;
    if (!source.endsWith(suffix)) continue;
    if (source.indexOf(`tools.${kind}`, prefix.length) !== -1) mismatch('child-command-encoding', 'The child host call does not match the captured Codex 0.147 wrapper.');
    return { kind, envelope: parseTopLevelExecObject(source.slice(prefix.length, -suffix.length)), legacy: false };
  }
  return { kind: 'exec_command', envelope: parseCapturedExecEnvelope(input), legacy: true };
}

function parseTopLevelExecObject(source) {
  let offset = skipWhitespace(source, 0);
  if (source[offset] !== '{') mismatch('child-command-encoding', 'The captured exec argument must be one object literal.');
  offset += 1;
  const values = new Map();
  let propertyExpected = false;
  while (true) {
    offset = skipWhitespace(source, offset);
    if (source[offset] === '}') {
      if (propertyExpected) mismatch('child-command-encoding', 'The captured exec argument has a trailing comma.');
      offset += 1;
      break;
    }
    const keyResult = readObjectKey(source, offset);
    const key = keyResult.value;
    offset = skipWhitespace(source, keyResult.offset);
    if (source[offset] !== ':') mismatch('child-command-encoding', 'The captured exec argument has a malformed property.');
    if (values.has(key)) mismatch('child-command-encoding', 'The captured exec argument has a duplicate property.');
    const valueResult = readJsonValue(source, offset + 1);
    values.set(key, valueResult.value);
    offset = skipWhitespace(source, valueResult.offset);
    if (source[offset] === ',') { offset += 1; propertyExpected = true; continue; }
    propertyExpected = false;
    if (source[offset] !== '}') mismatch('child-command-encoding', 'The captured exec argument has unexpected trailing syntax.');
  }
  if (skipWhitespace(source, offset) !== source.length) mismatch('child-command-encoding', 'The captured exec argument contains more than one value.');
  return values;
}

function readObjectKey(source, offset) {
  if (source[offset] === '"') {
    const token = readJsonStringToken(source, offset);
    let value;
    try { value = JSON.parse(token.value); } catch { mismatch('child-command-encoding', 'The captured exec argument has an invalid quoted property key.'); }
    return { value, offset: token.offset };
  }
  const match = /^[A-Za-z_$][A-Za-z0-9_$]*/u.exec(source.slice(offset));
  if (!match) mismatch('child-command-encoding', 'The captured exec argument has an unsupported property key.');
  return { value: match[0], offset: offset + match[0].length };
}

function readJsonValue(source, offset) {
  const start = skipWhitespace(source, offset);
  const stack = [];
  let inString = false;
  let escaped = false;
  let cursor = start;
  for (; cursor < source.length; cursor += 1) {
    const character = source[cursor];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') { inString = true; continue; }
    if (character === "'" || character === '`') mismatch('child-command-encoding', 'The captured exec argument uses an unsupported value literal.');
    if (character === '{' || character === '[') { stack.push(character); continue; }
    if (character === '}' || character === ']') {
      if (stack.length === 0) {
        if (character === '}') break;
        mismatch('child-command-encoding', 'The captured exec argument has an unmatched delimiter.');
      }
      const opening = stack.pop();
      if ((opening === '{') !== (character === '}')) mismatch('child-command-encoding', 'The captured exec argument has mismatched delimiters.');
      continue;
    }
    if (character === ',' && stack.length === 0) break;
  }
  if (inString || stack.length > 0 || cursor === start) mismatch('child-command-encoding', 'The captured exec argument has an incomplete value.');
  const raw = source.slice(start, cursor).trim();
  let value;
  try { value = JSON.parse(raw); } catch { mismatch('child-command-encoding', 'The captured exec argument value is not JSON.'); }
  return { value, offset: cursor };
}

function readJsonStringToken(source, offset) {
  let escaped = false;
  for (let cursor = offset + 1; cursor < source.length; cursor += 1) {
    const character = source[cursor];
    if (escaped) { escaped = false; continue; }
    if (character === '\\') { escaped = true; continue; }
    if (character === '"') return { value: source.slice(offset, cursor + 1), offset: cursor + 1 };
  }
  mismatch('child-command-encoding', 'The captured exec argument has an unterminated property key.');
}

function skipWhitespace(source, offset) {
  while (offset < source.length && /\s/u.test(source[offset])) offset += 1;
  return offset;
}

function parseObject(value, code) {
  const text = boundedString(value);
  if (!text) mismatch(code, 'Structured JSON arguments are absent.');
  let parsed;
  try { parsed = JSON.parse(text); } catch { mismatch(code, 'Structured JSON arguments are malformed.'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) mismatch(code, 'Structured JSON arguments are not an object.');
  return parsed;
}

function boundedArray(value, max, code) {
  if (!Array.isArray(value) || value.length > max) mismatch(code, `Evidence ${code} is absent or exceeds its bound.`);
  return value;
}

function boundedString(value) {
  return typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= MAX_TEXT_BYTES ? value : undefined;
}

function boundedJson(value) {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES) mismatch('parent-event-oversize', 'A parent-visible event exceeds the qualification bound.');
  return text;
}

function unique(values) { return [...new Set(values)]; }
function unqualified(code, message, evidence) { throw new CodexRescueUnqualifiedError(code, message, evidence); }
function mismatch(code, message) { throw new CodexRescueEvidenceMismatchError(code, message); }
