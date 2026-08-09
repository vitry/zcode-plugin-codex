// @ts-nocheck
const MAX_EXEC_FRAMES = 2_048;
const MAX_ROLLOUTS = 64;
const MAX_EVENTS_PER_ROLLOUT = 8_192;
const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_ROLLOUT_BYTES = 16 * 1024 * 1024;

export class CodexRescueUnqualifiedError extends Error {
  constructor(code, message, evidence) { super(message); this.name = 'CodexRescueUnqualifiedError'; this.code = code; this.evidence = evidence; }
}

export class CodexRescueEvidenceMismatchError extends Error {
  constructor(code, message) { super(message); this.name = 'CodexRescueEvidenceMismatchError'; this.code = code; }
}

export function parseCodexRolloutJsonl(value) {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAX_ROLLOUT_BYTES) {
    unqualified('rollout-file-oversize', 'A rollout file is absent or exceeds the qualification bound.');
  }
  const lines = value.split('\n').filter((line) => line.length > 0);
  if (lines.length > MAX_EVENTS_PER_ROLLOUT) unqualified('rollout-event-count', 'A rollout contains too many events.');
  return lines.map((line) => {
    if (Buffer.byteLength(line, 'utf8') > MAX_TEXT_BYTES) unqualified('rollout-line-oversize', 'A rollout record exceeds the qualification bound.');
    try { return JSON.parse(line); } catch { unqualified('rollout-json-invalid', 'A rollout record is not valid JSON.'); }
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
  if (parentThreadIds.length === 0) unqualified('parent-thread-unavailable', 'Codex exec JSON did not expose a parent thread ID.');
  if (parentThreadIds.length !== 1) mismatch('parent-thread-ambiguous', 'Codex exec JSON exposed conflicting parent thread IDs.');
  const parentThreadId = parentThreadIds[0];

  const parentCandidates = rollouts.filter((events) => {
    const meta = sessionMeta(events);
    return meta?.id === parentThreadId;
  });
  if (parentCandidates.length === 0) unqualified('parent-rollout-unavailable', 'No rollout contains the exec parent session metadata.');
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
  if (spawns.length === 0) unqualified('spawn-metadata-unavailable', 'The parent rollout did not expose spawn_agent metadata.');
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
  if (starts.length === 0) unqualified('child-start-unavailable', 'The parent rollout did not expose a child start event.');
  if (starts.length !== 1) mismatch('child-start-count', 'The parent rollout contains more than one child start event.');
  const start = starts[0].payload;
  const childThreadId = boundedString(start.agent_thread_id);
  const agentPath = boundedString(start.agent_path);
  if (!childThreadId || !agentPath) unqualified('child-identity-unavailable', 'The child start event omits its thread ID or agent path.');
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
    unqualified('child-rollout-unavailable', 'No rollout contains the started child thread metadata.');
  }
  if (childCandidates.length !== 1) mismatch('child-rollout-ambiguous', 'Multiple rollouts claim the started child thread ID.');
  const child = childCandidates[0];
  const childMeta = sessionMeta(child);
  const threadSpawn = childMeta.source?.subagent?.thread_spawn;
  if (!threadSpawn || typeof threadSpawn !== 'object') unqualified('thread-spawn-unavailable', 'The child rollout omits thread_spawn metadata.');
  if (childMeta.session_id !== parentThreadId
    || childMeta.parent_thread_id !== parentThreadId
    || childMeta.thread_source !== 'subagent'
    || threadSpawn.parent_thread_id !== parentThreadId
    || threadSpawn.depth !== 1
    || threadSpawn.agent_path !== agentPath) {
    mismatch('child-link-mismatch', 'Child session metadata does not link exactly to the observed parent and start event.');
  }

  let route;
  let agentType;
  if (options.schemaMode === 'named') {
    if (spawnArgs.agent_type !== options.expectedAgentType) mismatch('agent-type-mismatch', 'Named spawn metadata does not select the managed Rescue Role.');
    if (threadSpawn.agent_role !== options.expectedAgentType) mismatch('agent-role-mismatch', 'Child session metadata does not report the managed Rescue Role.');
    route = 'named'; agentType = options.expectedAgentType;
  } else if (options.schemaMode === 'generic-hidden') {
    if (Object.hasOwn(spawnArgs, 'agent_type')) mismatch('generic-agent-type-present', 'A schema-hidden generic spawn must omit agent_type.');
    if (threadSpawn.agent_role !== null) mismatch('generic-agent-role-mismatch', 'A schema-hidden generic child must report a null agent_role.');
    route = 'generic-schema-hidden'; agentType = null;
  } else {
    unqualified('schema-mode-unavailable', 'The harness did not explicitly qualify named or schema-hidden routing.');
  }

  const childCalls = child.filter((event) => event?.type === 'response_item' && event.payload?.type === 'custom_tool_call');
  const childExecCalls = childCalls.filter((event) => event.payload.name === 'exec');
  if (childCalls.length === 0) {
    const unsupportedCalls = child.filter((event) => event?.type === 'response_item'
      && event.payload?.type === 'function_call'
      && ['exec', 'exec_command'].includes(event.payload.name));
    if (unsupportedCalls.length > 0) mismatch('child-command-shape-mismatch', 'The child command used a tool-call shape not captured for Codex 0.147.');
    unqualified('child-command-unavailable', 'The child rollout did not expose structured tool-call evidence.');
  }
  if (childCalls.length !== 1 || childExecCalls.length !== 1) mismatch('child-command-count', 'The child must execute exactly one tool call and it must be exec.');
  const commands = extractCommands(childExecCalls[0].payload.input);
  if (commands.length !== 1 || commands[0] !== options.expectedCommand) mismatch('child-command-mismatch', 'The child exec command is absent, ambiguous, or not the constant Rescue command.');

  assertParentIsolation(parent, options.expectedCommand, options.forbiddenParentText ?? []);

  const childFinal = finalRolloutMessage(child, 'child-terminal-unavailable');
  const childReturn = childReturnPayload(parent, agentPath);
  const parentFinal = finalRolloutMessage(parent, 'parent-terminal-unavailable');
  const execFinal = finalExecMessage(execFrames);
  for (const actual of [childFinal, childReturn, parentFinal, execFinal]) {
    if (actual !== options.expectedPublicOutput) mismatch('public-output-mismatch', 'Child and parent terminal public output must equal the expected sentinel byte-for-byte.');
  }
  const evidence = { parentThreadId, childThreadId, agentPath, taskName: spawnArgs.task_name, agentType, route, publicOutput: execFinal };
  if (!spawnMessage) unqualified('spawn-message-unavailable', 'The structured spawn metadata does not expose a bounded message field.');
  if (/^gAAAA[A-Za-z0-9_-]{40,}={0,2}$/u.test(spawnMessage)) {
    unqualified('spawn-message-encrypted', 'Codex 0.147 persisted the spawn message as ciphertext, so its exact runtime value cannot be qualified.', evidence);
  }
  if (spawnMessage !== options.expectedSpawnMessage) mismatch('spawn-message-mismatch', 'The runtime spawn message differs from the fixed Rescue forwarder contract.');

  return evidence;
}

function assertParentIsolation(parent, expectedCommand, forbiddenText) {
  for (const event of parent) {
    if (event?.type === 'response_item' && event.payload?.type === 'custom_tool_call' && event.payload.name === 'exec') {
      if (extractCommands(event.payload.input).includes(expectedCommand)) mismatch('parent-inline-command', 'The parent executed the child Rescue command inline.');
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

function sessionMeta(events) {
  const metas = events.filter((event) => event?.type === 'session_meta').map((event) => event.payload);
  if (metas.length > 1) mismatch('session-meta-count', 'A rollout contains multiple session_meta records.');
  return metas[0];
}

function finalRolloutMessage(events, code) {
  const messages = events
    .filter((event) => event?.type === 'event_msg' && event.payload?.type === 'agent_message' && event.payload.phase === 'final_answer')
    .map((event) => boundedString(event.payload.message));
  if (messages.length === 0 || !messages[0]) unqualified(code, 'A rollout did not expose its final public agent message.');
  if (messages.length !== 1) mismatch('terminal-message-count', 'A rollout contains more than one final public agent message.');
  return messages[0];
}

function childReturnPayload(parent, agentPath) {
  const returns = parent.filter((event) => event?.type === 'response_item'
    && event.payload?.type === 'agent_message'
    && event.payload.author === agentPath
    && event.payload.recipient === '/root');
  if (returns.length === 0) unqualified('child-return-unavailable', 'The parent rollout did not expose the child terminal return.');
  if (returns.length !== 1) mismatch('child-return-count', 'The parent rollout contains more than one child terminal return.');
  const content = returns[0].payload.content;
  if (!Array.isArray(content) || content.length !== 1 || content[0]?.type !== 'input_text') unqualified('child-return-content-unavailable', 'The child terminal return is not available as one structured input_text item.');
  const text = boundedString(content[0].text);
  const prefix = `Message Type: FINAL_ANSWER\nTask name: /root\nSender: ${agentPath}\nPayload:\n`;
  if (!text?.startsWith(prefix)) mismatch('child-return-envelope-mismatch', 'The child terminal return envelope does not match the linked agent.');
  return text.slice(prefix.length);
}

function finalExecMessage(frames) {
  const messages = frames
    .filter((frame) => frame?.type === 'item.completed' && frame.item?.type === 'agent_message')
    .map((frame) => boundedString(frame.item.text));
  if (messages.length === 0 || !messages.at(-1)) unqualified('exec-terminal-unavailable', 'Codex exec JSON did not expose a terminal public message.');
  return messages.at(-1);
}

function extractCommands(input) {
  const source = boundedString(input);
  if (!source) return [];
  const matches = [...source.matchAll(/\bcmd\s*:\s*("(?:[^"\\]|\\.)*")/gu)];
  const commands = [];
  for (const match of matches) {
    try { commands.push(JSON.parse(match[1])); } catch { mismatch('child-command-encoding', 'The structured exec cmd string is malformed.'); }
  }
  return commands;
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
  if (!Array.isArray(value) || value.length > max) unqualified(code, `Evidence ${code} is absent or exceeds its bound.`);
  return value;
}

function boundedString(value) {
  return typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= MAX_TEXT_BYTES ? value : undefined;
}

function boundedJson(value) {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES) unqualified('parent-event-oversize', 'A parent-visible event exceeds the qualification bound.');
  return text;
}

function unique(values) { return [...new Set(values)]; }
function unqualified(code, message, evidence) { throw new CodexRescueUnqualifiedError(code, message, evidence); }
function mismatch(code, message) { throw new CodexRescueEvidenceMismatchError(code, message); }
