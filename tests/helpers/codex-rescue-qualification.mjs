// @ts-nocheck
const MAX_EXEC_FRAMES = 2_048;
const MAX_ROLLOUTS = 64;
const MAX_EVENTS_PER_ROLLOUT = 8_192;
const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_ROLLOUT_BYTES = 16 * 1024 * 1024;
const MAX_EXEC_AGENT_MESSAGES = 256;
const GENERIC_HIDDEN_SCHEMA_VERSIONS = new Set(['0.147.0']);
const EXEC_ENVELOPE_KEYS = new Set(['cmd', 'workdir', 'yield_time_ms', 'max_output_tokens']);

export class CodexRescueUnqualifiedError extends Error {
  constructor(code, message, evidence) { super(message); this.name = 'CodexRescueUnqualifiedError'; this.code = code; this.evidence = evidence; }
}

export class CodexRescueEvidenceMismatchError extends Error {
  constructor(code, message) { super(message); this.name = 'CodexRescueEvidenceMismatchError'; this.code = code; }
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
  if (spawnArgs.task_name !== options.expectedTaskName || spawnArgs.fork_turns !== 'none') {
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
  if (agentPath !== options.expectedAgentPath) mismatch('agent-path-mismatch', 'The started child path does not match the fixed Rescue task name.');

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
    route = 'generic-schema-hidden'; agentType = null; expectedSpawnMessage = options.expectedGenericSpawnMessage;
  }

  const spawnIndex = parent.indexOf(spawns[0]);
  const startIndex = parent.indexOf(starts[0]);
  if (spawnIndex >= startIndex) mismatch('spawn-start-order', 'The linked child start must follow its spawn call.');
  assertParentPreflight(parent, spawnIndex, startIndex, options);

  const childCalls = child.filter((event) => event?.type === 'response_item' && event.payload?.type === 'custom_tool_call');
  const childExecCalls = childCalls.filter((event) => event.payload.name === 'exec');
  if (childCalls.length === 0) {
    const unsupportedCalls = child.filter((event) => event?.type === 'response_item'
      && event.payload?.type === 'function_call'
      && ['exec', 'exec_command'].includes(event.payload.name));
    if (unsupportedCalls.length > 0) mismatch('child-command-shape-mismatch', 'The child command used a tool-call shape not captured for Codex 0.147.');
    mismatch('child-command-unavailable', 'The child rollout did not expose structured tool-call evidence.');
  }
  if (childCalls.length !== 1 || childExecCalls.length !== 1) mismatch('child-command-count', 'The child must execute exactly one tool call and it must be exec.');
  const childEnvelope = parseCapturedExecEnvelope(childExecCalls[0].payload.input);
  assertExecEnvelope(childEnvelope, options.expectedCommand, options.expectedWorkspace, 'child-exec-envelope-mismatch');

  const childOutputs = child.filter((event) => event?.type === 'response_item' && event.payload?.type === 'custom_tool_call_output');
  if (childOutputs.length === 0) mismatch('child-output-count', 'The child rollout has no structured exec output.');
  if (childOutputs.length !== 1) mismatch('child-output-count', 'The child rollout must have exactly one structured exec output.');
  if (childOutputs[0].payload.call_id !== childExecCalls[0].payload.call_id) mismatch('child-output-link', 'The child exec output does not link to its unique call.');
  if (child.indexOf(childExecCalls[0]) >= child.indexOf(childOutputs[0])) mismatch('child-output-order', 'The linked child output must follow its exec call.');
  assertTerminalSentinel(childOutputs[0].payload.output, options.expectedPublicOutput);
  const childFinalIndex = child.findIndex((event) => event?.type === 'event_msg' && event.payload?.type === 'agent_message' && event.payload.phase === 'final_answer');
  if (childFinalIndex <= child.indexOf(childOutputs[0])) mismatch('child-terminal-order', 'The child final message must follow its linked exec output.');

  assertParentIsolation(parent, options.expectedPreflightCommand, options.forbiddenParentText ?? []);

  const childReturnIndex = parent.findIndex((event) => event?.type === 'response_item' && event.payload?.type === 'agent_message' && event.payload.author === agentPath && event.payload.recipient === '/root');
  const parentFinalIndex = parent.findIndex((event) => event?.type === 'event_msg' && event.payload?.type === 'agent_message' && event.payload.phase === 'final_answer');
  if (childReturnIndex < startIndex || parentFinalIndex <= childReturnIndex) mismatch('parent-terminal-order', 'The linked child return and parent final message are out of order.');

  const childFinal = finalRolloutMessage(child, 'child-terminal-unavailable');
  const childReturn = childReturnPayload(parent, agentPath);
  const parentFinal = finalRolloutMessage(parent, 'parent-terminal-unavailable');
  const execFinal = finalExecMessage(execFrames, options.expectedPublicOutput, parentThreadId);
  for (const actual of [childFinal, childReturn, parentFinal, execFinal]) {
    if (actual !== options.expectedPublicOutput) mismatch('public-output-mismatch', 'Child and parent terminal public output must equal the expected sentinel byte-for-byte.');
  }
  const evidence = { parentThreadId, childThreadId, agentPath, taskName: spawnArgs.task_name, agentType, route, publicOutput: execFinal };
  if (!spawnMessage) mismatch('spawn-message-unavailable', 'The structured spawn metadata does not expose a bounded message field.');
  if (/^gAAAA[A-Za-z0-9_-]{40,}={0,2}$/u.test(spawnMessage)) {
    unqualified('spawn-message-encrypted', 'Codex 0.147 persisted the spawn message as ciphertext, so its exact runtime value cannot be qualified.', evidence);
  }
  if (spawnMessage !== expectedSpawnMessage) mismatch('spawn-message-mismatch', 'The runtime spawn message differs from the fixed Rescue forwarder contract.');

  return evidence;
}

export function qualifyCodexRescueChoiceEvidence(input, options) {
  const rollouts = boundedArray(input?.rollouts, MAX_ROLLOUTS, 'choice-rollouts');
  for (const rollout of rollouts) boundedArray(rollout, MAX_EVENTS_PER_ROLLOUT, 'choice-rollout-events');
  if (!['resume', 'fresh'].includes(options?.expectedChoice)) mismatch('choice-invalid', 'The expected Rescue choice is invalid.');

  const parentCandidates = rollouts.filter((events) => sessionMeta(events)?.id === options.expectedParentThreadId);
  if (parentCandidates.length !== 1) mismatch('choice-parent-count', 'Choice evidence must contain exactly one parent rollout.');
  const parent = parentCandidates[0];
  const parentMeta = sessionMeta(parent);
  const spawns = namedCalls(parent, 'spawn_agent');
  if (spawns.length !== 1) mismatch('choice-spawn-count', 'Choice continuation must retain exactly one initial spawn.');
  const spawnArgs = parseObject(spawns[0].payload.arguments, 'choice-spawn-arguments');
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
  if (spawnArgs.task_name !== options.expectedTaskName || spawnArgs.fork_turns !== 'none') mismatch('choice-spawn-contract', 'The choice-flow spawn task or context mode differs from the Rescue contract.');
  if (!spawnMessageEncrypted && spawnArgs.message !== expectedSpawnMessage) mismatch('choice-spawn-message', 'The choice-flow spawn message differs from its fixed contract.');
  const spawnIndex = parent.indexOf(spawns[0]);
  const starts = parent.filter((event) => event?.type === 'event_msg' && event.payload?.type === 'sub_agent_activity' && event.payload.kind === 'started');
  if (starts.length !== 1) mismatch('choice-start-count', 'Choice continuation must expose exactly one child start.');
  const start = starts[0];
  const childThreadId = boundedString(start.payload.agent_thread_id);
  const agentPath = boundedString(start.payload.agent_path);
  if (!childThreadId || agentPath !== options.expectedAgentPath || start.payload.event_id !== spawns[0].payload.call_id) {
    mismatch('choice-child-identity', 'The choice flow does not link one exact child ID to the initial spawn.');
  }
  const startIndex = parent.indexOf(start);
  if (spawnIndex >= startIndex) mismatch('choice-start-order', 'The child start must follow its unique spawn.');
  assertParentPreflight(parent, spawnIndex, startIndex, {
    expectedPreflightCommand: options.expectedPreflightCommand,
    expectedWorkspace: options.expectedWorkspace,
  });

  const childCandidates = rollouts.filter((events) => sessionMeta(events)?.id === childThreadId);
  if (childCandidates.length !== 1) mismatch('choice-child-count', 'Choice evidence must contain exactly one rollout for the retained child ID.');
  const child = childCandidates[0];
  const meta = sessionMeta(child);
  const spawnMeta = meta?.source?.subagent?.thread_spawn;
  validateParentChildRoute({ parentMeta, parentThreadId: options.expectedParentThreadId, start: start.payload, childMeta: meta, childThreadId, agentPath, codePrefix: 'choice-' });
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

  const waits = namedCalls(parent, 'wait_agent');
  if (waits.length < 2) mismatch('choice-wait-count', 'The choice flow must expose waits before and after the same-child follow-up.');
  const timedOutWaitIndexes = [];
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
    const firstReturnIndex = parent.findIndex((event) => event?.type === 'response_item' && event.payload?.type === 'agent_message' && event.payload.author === agentPath);
    if (!(timedOutWaitIndexes[0] < parent.indexOf(lists[0]) && parent.indexOf(linked[0]) < firstReturnIndex)) mismatch('choice-child-state-order', 'Timeout recovery state inspection is out of order.');
  }

  const childCalls = child.filter((event) => event?.type === 'response_item' && event.payload?.type === 'custom_tool_call');
  const childExecs = childCalls.filter((event) => event.payload.name === 'exec');
  if (childCalls.length !== 2 || childExecs.length !== 2) mismatch('choice-command-count', 'The retained child must run exactly the initial and selected continuation commands.');
  assertExecEnvelope(parseCapturedExecEnvelope(childExecs[0].payload.input), options.expectedInitialCommand, options.expectedWorkspace, 'choice-initial-envelope');
  const choiceEnvelope = parseCapturedExecEnvelope(childExecs[1].payload.input);
  if (choiceEnvelope.get('cmd') !== options.expectedChoiceCommand) mismatch('choice-command-mismatch', 'The child continuation command differs from the selected constant command.');
  assertExecEnvelope(choiceEnvelope, options.expectedChoiceCommand, options.expectedWorkspace, 'choice-command-envelope');
  if (child.indexOf(childExecs[0]) >= child.indexOf(childExecs[1])) mismatch('choice-command-order', 'The continuation command must follow the initial command in the same child.');

  const outputs = child.filter((event) => event?.type === 'response_item' && event.payload?.type === 'custom_tool_call_output');
  if (outputs.length !== 2) mismatch('choice-output-count', 'The same-child flow must expose exactly two linked command outputs.');
  for (let index = 0; index < 2; index += 1) {
    if (outputs[index].payload.call_id !== childExecs[index].payload.call_id || child.indexOf(childExecs[index]) >= child.indexOf(outputs[index])) {
      mismatch('choice-output-link', 'A choice output is not linked after its command.');
    }
  }
  const needsChoiceText = terminalOutputText(outputs[0].payload.output, 'choice-needs-choice-output');
  let needsChoice;
  try { needsChoice = JSON.parse(needsChoiceText); } catch { mismatch('choice-needs-choice-output', 'The first child output is not exact needs-choice JSON.'); }
  assertExactKeys(needsChoice, ['candidate', 'choices', 'type'], 'choice-needs-choice-output');
  if (needsChoice.type !== 'needs-choice' || JSON.stringify(needsChoice.choices) !== JSON.stringify(['--resume', '--fresh'])) {
    mismatch('choice-needs-choice-output', 'The first child output is not the fixed needs-choice response.');
  }
  boundedJson(needsChoice.candidate);
  assertTerminalSentinel(outputs[1].payload.output, options.expectedPublicOutput);
  const childFinals = child.filter((event) => event?.type === 'event_msg' && event.payload?.type === 'agent_message' && event.payload.phase === 'final_answer');
  if (childFinals.length !== 2 || childFinals[0].payload.message !== needsChoiceText || childFinals[1].payload.message !== options.expectedPublicOutput
    || child.indexOf(outputs[0]) >= child.indexOf(childFinals[0]) || child.indexOf(childFinals[0]) >= child.indexOf(childExecs[1])
    || child.indexOf(outputs[1]) >= child.indexOf(childFinals[1])) mismatch('choice-child-terminal-sequence', 'The same child must finalize each exact stdout after its linked command output.');

  const returns = parent.filter((event) => event?.type === 'response_item' && event.payload?.type === 'agent_message' && event.payload.author === agentPath && event.payload.recipient === '/root');
  if (returns.length !== 2) mismatch('choice-child-return-count', 'The parent must receive needs-choice and terminal results from the same child.');
  const returnPayloads = returns.map((event) => childReturnText(event, agentPath));
  if (returnPayloads[0] !== needsChoiceText || returnPayloads[1] !== options.expectedPublicOutput) mismatch('choice-child-return-output', 'Same-child return payloads are not exact public stdout.');
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

  const timeline = [childExecs[0], outputs[0], childFinals[0], returns[0], parentFinals[0], followups[0], childExecs[1], outputs[1], childFinals[1], returns[1], parentFinals[1]].map(eventTimestamp);
  if (timeline.some((value) => value === undefined) || timeline.some((value, index) => index > 0 && value <= timeline[index - 1])) {
    mismatch('choice-terminal-timeline', 'The observable timestamps do not prove the complete initial-exec through terminal-parent sequence.');
  }

  assertParentIsolation(parent, options.expectedPreflightCommand, options.forbiddenParentText ?? []);
  const evidence = { parentThreadId: options.expectedParentThreadId, childThreadId, agentPath, choice: options.expectedChoice };
  if (spawnMessageEncrypted) unqualified('choice-spawn-encrypted', 'Codex encrypted only the spawn message field, so its exact runtime value cannot be qualified.', evidence);
  if (followupMessageEncrypted) unqualified('choice-followup-encrypted', 'Codex encrypted only the continuation message field, so its exact runtime value cannot be qualified.', evidence);
  return evidence;
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
  const parsed = value === undefined ? Number.NaN : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
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

function assertParentIsolation(parent, expectedPreflightCommand, forbiddenText) {
  for (const event of parent) {
    if (event?.type === 'response_item' && event.payload?.type === 'custom_tool_call' && event.payload.name === 'exec') {
      const command = parseCapturedExecEnvelope(event.payload.input).get('cmd');
      if (command !== expectedPreflightCommand && isCompanionCommand(command)) mismatch('parent-inline-command', 'The parent executed a Rescue companion command outside the exact preflight.');
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

function assertParentPreflight(parent, spawnIndex, startIndex, options) {
  const calls = parent
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => event?.type === 'response_item' && event.payload?.type === 'custom_tool_call' && event.payload.name === 'exec')
    .map(({ event, index }) => ({ event, index, envelope: parseCapturedExecEnvelope(event.payload.input) }));
  const preflights = calls.filter(({ envelope }) => envelope.get('cmd') === options.expectedPreflightCommand);
  if (preflights.length === 0) {
    if (calls.some(({ envelope }) => isCompanionCommand(envelope.get('cmd')))) mismatch('preflight-command-mismatch', 'The parent companion preflight command is not exact.');
    mismatch('preflight-count', 'The parent rollout must contain exactly one readiness preflight.');
  }
  if (preflights.length !== 1) mismatch('preflight-count', 'The parent rollout must contain exactly one readiness preflight.');
  const preflight = preflights[0];
  assertExecEnvelope(preflight.envelope, options.expectedPreflightCommand, options.expectedWorkspace, 'preflight-envelope-mismatch');
  const outputs = parent
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => event?.type === 'response_item' && event.payload?.type === 'custom_tool_call_output');
  const linked = outputs.filter(({ event }) => event.payload.call_id === preflight.event.payload.call_id);
  if (linked.length !== 1) mismatch('preflight-output-link', 'The readiness output does not link exactly once to the preflight call.');
  if (!(preflight.index < linked[0].index && linked[0].index < spawnIndex && linked[0].index < startIndex)) {
    mismatch('preflight-order', 'The readiness preflight and output must complete before the child spawn.');
  }
  const statusText = terminalOutputText(linked[0].event.payload.output, 'preflight-status-mismatch').trim();
  let status;
  try { status = JSON.parse(statusText); } catch { mismatch('preflight-status-mismatch', 'The readiness output is not exact bounded JSON.'); }
  assertExactKeys(status, ['role', 'status', 'type'], 'preflight-status-mismatch');
  if (status.type !== 'role-status' || status.role !== 'zcode-rescue' || status.status !== 'ready') {
    mismatch('preflight-status-mismatch', 'The readiness output does not report the Rescue Role ready.');
  }
}

function assertExecEnvelope(envelope, expectedCommand, expectedWorkspace, code) {
  if (!envelope || typeof envelope.get !== 'function' || typeof envelope.keys !== 'function') mismatch(code, 'The exec envelope is absent.');
  for (const key of envelope.keys()) if (!EXEC_ENVELOPE_KEYS.has(key)) mismatch(code, `The exec envelope contains forbidden key ${key}.`);
  if (envelope.get('cmd') !== expectedCommand || envelope.get('workdir') !== expectedWorkspace) {
    mismatch(code === 'child-exec-envelope-mismatch' && envelope.get('cmd') !== expectedCommand ? 'child-command-mismatch' : code, 'The exec command or canonical workspace differs from the contract.');
  }
  if (envelope.has('yield_time_ms') && (!Number.isInteger(envelope.get('yield_time_ms')) || envelope.get('yield_time_ms') < 250 || envelope.get('yield_time_ms') > 30_000)) mismatch(code, 'yield_time_ms is outside the captured safe bound.');
  if (envelope.has('max_output_tokens') && (!Number.isInteger(envelope.get('max_output_tokens')) || envelope.get('max_output_tokens') < 1 || envelope.get('max_output_tokens') > 100_000)) mismatch(code, 'max_output_tokens is outside the captured safe bound.');
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
  return typeof command === 'string' && (command.includes('zcode-companion.mjs') || /(?:^|\s)invoke(?:-choice)?\s+rescue(?:\s|$)/u.test(command));
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
    && event.payload.recipient === '/root');
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
