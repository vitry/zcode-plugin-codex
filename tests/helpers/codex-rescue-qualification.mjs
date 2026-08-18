// @ts-nocheck
import { parseRescueProgressRelay, RESCUE_RELAY_MESSAGES, RESCUE_RELAY_PREFIX } from '../../scripts/lib/rescue-progress-relay.mjs';
import { parseRescueBindingAuthority, parseRescueBindingPartition } from '../../scripts/lib/rescue-binding.mjs';
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
const PREPARED_ACK_LINE = `${JSON.stringify({ type: 'prepared', command: 'rescue' })}\n`;
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
 * Qualify the bounded, privacy-filtered facts captured for a clear proactive
 * continuation. This deliberately consumes normalized host/peer facts rather
 * than private binding files: the installed harness observes lifecycle and
 * protocol effects while the companion remains the binding authority.
 */
export function qualifyCodexRescuePreparedContinuationEvidence(input) {
  if (!input || !['named', 'generic'].includes(input.route) || !['foreground', 'background'].includes(input.execution)
    || typeof input.parentRolloutJson !== 'string' || typeof input.childRolloutJson !== 'string'
    || typeof input.hookLifecycleJson !== 'string' || typeof input.executorRecordBytes !== 'string'
    || typeof input.bindingAuthorityBytes !== 'string' || typeof input.bindingPartitionBytes !== 'string'
    || typeof input.jobsJson !== 'string' || typeof input.fakePeerJson !== 'string' || !input.expected || !input.publicSurfaces) {
    mismatch('continuation-raw-contract', 'Prepared continuation qualification requires bounded raw captured artifacts.');
  }
  const expected = input.expected; const parentSessionId = boundedString(expected.parentSessionId); const childThreadId = boundedString(expected.childThreadId);
  const agentPath = boundedString(expected.agentPath); const originalParentTurnId = boundedString(expected.originalParentTurnId);
  const continuationParentTurnId = boundedString(expected.continuationParentTurnId);
  if (!parentSessionId || !childThreadId || !agentPath || !originalParentTurnId || !continuationParentTurnId || originalParentTurnId === continuationParentTurnId) mismatch('continuation-identity', 'Prepared continuation identity is incomplete.');
  const parseArray = (text, code) => { if (Buffer.byteLength(text) > MAX_ROLLOUT_BYTES) mismatch(code, 'Captured evidence exceeds its byte bound.'); let value; try { value = JSON.parse(text); } catch { mismatch(code, 'Captured evidence is malformed.'); } return boundedArray(value, MAX_EVENTS_PER_ROLLOUT, code); };
  const parent = parseArray(input.parentRolloutJson, 'continuation-parent-events'); const child = parseArray(input.childRolloutJson, 'continuation-child-events');
  const hooks = parseArray(input.hookLifecycleJson, 'continuation-hook-events'); const jobs = parseArray(input.jobsJson, 'continuation-jobs'); const peer = parseArray(input.fakePeerJson, 'continuation-peer-events');
  const spawns = namedCalls(parent, 'spawn_agent'); const followups = namedCalls(parent, 'followup_task');
  const parentExecs = parent.filter((event) => event?.payload?.type === 'custom_tool_call' && event.payload.name === 'exec');
  const parentOutputs = parent.filter((event) => event?.payload?.type === 'custom_tool_call_output');
  const starts = parent.filter((event) => event?.payload?.type === 'sub_agent_activity' && event.payload.kind === 'started');
  const stops = parent.filter((event) => event?.payload?.type === 'sub_agent_activity' && event.payload.kind === 'stopped');
  if (spawns.length !== 1) mismatch('continuation-spawn-count', 'Captured continuation must contain one original spawn only.');
  if (starts.length !== 1) mismatch('continuation-start-count', 'Captured continuation must contain one original SubagentStart only.');
  if (stops.length !== 1) mismatch('continuation-stop-count', 'Captured continuation must contain one SubagentStop only.');
  if (followups.length !== 1) mismatch('continuation-followup-count', 'Captured continuation must contain one follow-up only.');
  const preparations = parentExecs.filter((event) => parseCapturedHostCall(event.payload.input).envelope.get('cmd')?.endsWith('/scripts/zcode-companion.mjs" prepare rescue'));
  if (preparations.length !== 2 || preparations.some((call) => parentOutputs.filter((output) => output.payload.call_id === call.payload.call_id).length !== 1)) mismatch('continuation-preparation-count', 'Captured continuation must contain two linked raw parent preparations.');
  const spawn = parseObject(spawns[0].payload.arguments, 'continuation-spawn-arguments'); const followup = parseObject(followups[0].payload.arguments, 'continuation-followup-arguments');
  const expectedMessage = input.route === 'named' ? expectedNamedRescueMessage : expectedGenericRescueMessage;
  if (starts[0].payload.event_id !== spawns[0].payload.call_id || starts[0].payload.agent_thread_id !== childThreadId
    || stops[0].payload.agent_thread_id !== childThreadId || starts[0].payload.parent_turn_id !== originalParentTurnId
    || stops[0].payload.parent_turn_id !== originalParentTurnId) mismatch('continuation-start-count', 'Captured lifecycle does not link the exact original child.');
  if (followup.target !== childThreadId) mismatch('continuation-followup-target', 'Captured follow-up targets a sibling child.');
  if (followup.message !== expectedMessage || spawn.message !== expectedMessage) mismatch('continuation-followup-message', 'Captured assignments are not the route-specific exact original message.');
  const preparationTimes = preparations.map(eventTimestamp).sort();
  if (!(preparationTimes[0] < eventTimestamp(spawns[0]) && eventTimestamp(spawns[0]) < eventTimestamp(starts[0])
    && eventTimestamp(starts[0]) < eventTimestamp(stops[0]) && eventTimestamp(stops[0]) < preparationTimes[1]
    && preparationTimes[1] < eventTimestamp(followups[0]))) mismatch('continuation-event-order', 'Captured lifecycle chronology is invalid.');
  if (!RESCUE_TASK_NAME_PATTERN.test(spawn.task_name) || starts[0].payload.agent_path !== agentPath || stops[0].payload.agent_path !== agentPath) mismatch('continuation-presentation', 'Captured child presentation uses task-name or path substitution.');
  const executor = parseObject(input.executorRecordBytes, 'continuation-executor-provenance');
  const exactExecutorKeys = ['active', 'agentId', 'agentType', 'childTurnId', 'createdAt', 'kind', 'parentPermissionMode', 'parentSessionId', 'parentTurnId', 'workspace'];
  assertExactKeys(executor, exactExecutorKeys, 'continuation-executor-provenance');
  if (executor.kind !== 'subagent-executor' || executor.active !== false || executor.agentId !== childThreadId || executor.parentSessionId !== parentSessionId
    || executor.parentTurnId !== originalParentTurnId || executor.parentPermissionMode !== expected.permissionMode || executor.workspace !== expected.workspace
    || executor.agentType !== (input.route === 'named' ? 'zcode-rescue' : 'default')) mismatch('continuation-executor-provenance', 'Raw stopped executor provenance is invalid.');
  if (Date.parse(executor.createdAt) > Date.parse('2026-08-10T00:00:00.000Z')) mismatch('continuation-executor-provenance', 'Raw executor creation time is invalid.');
  const startHooks = hooks.filter((event) => event?.hook_event_name === 'SubagentStart'); const stopHooks = hooks.filter((event) => event?.hook_event_name === 'SubagentStop');
  const freshHooks = hooks.filter((event) => event?.hook_event_name === 'UserPromptSubmit');
  if (startHooks.length !== 1 || stopHooks.length !== 1 || freshHooks.length !== 1 || freshHooks[0].turn_id !== continuationParentTurnId
    || startHooks[0].agent_id !== childThreadId || stopHooks[0].agent_id !== childThreadId
    || startHooks[0].session_id !== parentSessionId || stopHooks[0].session_id !== parentSessionId
    || startHooks[0].agent_type !== executor.agentType || stopHooks[0].agent_type !== executor.agentType
    || startHooks[0].permission_mode !== expected.permissionMode || stopHooks[0].permission_mode !== expected.permissionMode
    || freshHooks[0].permission_mode !== expected.permissionMode || startHooks[0].cwd !== expected.workspace
    || stopHooks[0].cwd !== expected.workspace || freshHooks[0].cwd !== expected.workspace) mismatch('continuation-hook-lifecycle', 'Raw hook lifecycle does not prove one Start/Stop and a fresh parent turn.');
  let authority; let partition; try { authority = parseRescueBindingAuthority(input.bindingAuthorityBytes, { parentSessionId, workspace: expected.workspace }); partition = parseRescueBindingPartition(input.bindingPartitionBytes, { parentSessionId, workspace: expected.workspace }); } catch { mismatch('continuation-binding-invalid', 'Raw Rescue binding files are invalid.'); }
  if (authority.key !== partition.key || partition.records.length !== 1) mismatch('continuation-binding-invalid', 'Raw Rescue binding authority and partition do not match.');
  const binding = partition.records[0];
  if (binding.executorAgentId !== childThreadId || binding.executorParentTurnId !== originalParentTurnId || binding.permissionMode !== expected.permissionMode
    || binding.state !== 'active') mismatch('continuation-binding-identity', 'Raw Rescue binding identity is invalid.');
  const anchor = jobs.find((job) => job?.id === binding.anchorJobId); const current = jobs.find((job) => job?.id === binding.currentJobId);
  if (!current) mismatch('continuation-current-job-stale', 'Raw current job evidence is absent.');
  if (!anchor || anchor.status === 'cancelled' || !boundedString(anchor.zcodeSessionId)) mismatch('continuation-anchor-invalid', 'Raw anchor job is not resumable.');
  if (!['queued', 'running', 'cancelling', 'succeeded', 'failed', 'cancelled'].includes(current.status)) mismatch('continuation-current-job-stale', 'Raw current job status is invalid.');
  if (input.execution === 'background' && (!boundedString(current.capabilityId) || !boundedString(current.workerLeaseId) || current.status !== 'queued')) mismatch('continuation-background-evidence', 'Background continuation lacks raw capability, job, and worker evidence.');
  const creates = peer.filter((event) => event?.method === 'session/create'); const resumes = peer.filter((event) => event?.method === 'session/resume'); const turns = peer.filter((event) => event?.method === 'session/turn');
  if (creates.length !== 1 || resumes.length !== 1 || creates[0].sessionId !== anchor.zcodeSessionId || resumes[0].sessionId !== anchor.zcodeSessionId) mismatch('continuation-session-mismatch', 'Raw fake peer did not resume the exact anchor session.');
  if (turns.length !== 1 || turns[0].sessionId !== anchor.zcodeSessionId) mismatch('continuation-peer-turn-count', 'Raw fake peer does not contain exactly one new resumed turn.');
  const childMeta = sessionMeta(child); const calls = child.filter((event) => event?.payload?.type === 'custom_tool_call'); const outputs = child.filter((event) => event?.payload?.type === 'custom_tool_call_output');
  const childCommands = calls.map((call) => parseCapturedHostCall(call.payload.input).envelope.get('cmd'));
  if (childMeta?.id !== childThreadId || childMeta?.parent_thread_id !== parentSessionId || calls.length !== 2 || outputs.length !== 2
    || childCommands.some((command) => typeof command !== 'string' || !command.endsWith('/scripts/zcode-companion.mjs" invoke-prepared rescue'))
    || new Set(childCommands).size !== 1
    || calls.some((call) => outputs.filter((output) => output.payload.call_id === call.payload.call_id).length !== 1)) mismatch('continuation-child-invocations', 'Raw child rollout does not prove two exact linked invoke-prepared turns.');
  const privateValues = [binding.key, binding.operationId, binding.anchorJobId, binding.currentJobId, anchor.zcodeSessionId,
    current.capabilityId, current.workerLeaseId, executor.childTurnId].filter((value) => typeof value === 'string' && value);
  if (privateValues.length < 6) mismatch('continuation-private-sentinels', 'Raw artifacts do not provide mandatory private sentinels.');
  const publicText = JSON.stringify([input.publicSurfaces, parent, child]);
  if (privateValues.some((value) => publicText.includes(value))) mismatch('continuation-private-leak', 'A public or host surface leaks a private identifier.');
  return {
    route: input.route, parentSessionId, childThreadId, agentPath, originalParentTurnId, continuationParentTurnId,
    spawnCount: 1, startCount: 1, stopCount: 1, followupCount: 1, continuationSpawnCount: 0,
    childInvocationCount: 2, peerResumeChecked: true, execution: input.execution,
  };
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
  assertParentPreparation(parent, spawnIndex, startIndex, options);

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
  assertExactKeys(payload, ['options', 'source', 'task', 'version'], 'preparation-payload-contract');
  if (!payload.options || typeof payload.options !== 'object' || Array.isArray(payload.options)) {
    mismatch('preparation-payload-contract', 'The trusted preparation envelope differs from the bounded Rescue contract.');
  }
  const optionKeys = Object.keys(payload.options);
  const validModel = (value) => typeof value === 'string' && value.trim().length > 0
    && Buffer.byteLength(value, 'utf8') <= MAX_RESCUE_MODEL_BYTES
    && ![...value].some((character) => { const point = character.codePointAt(0); return point <= 31 || point >= 127 && point <= 159; });
  if (payload.version !== 1 || !['explicit', 'proactive'].includes(payload.source)
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
  if (acknowledged.output !== PREPARED_ACK_LINE || acknowledged.exit_code !== 0 || Object.hasOwn(acknowledged, 'session_id')) {
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
  return typeof command === 'string' && (command.includes('zcode-companion.mjs') || /(?:^|\s)(?:prepare|invoke(?:-prepared|-choice)?)\s+rescue(?:\s|$)/u.test(command));
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
