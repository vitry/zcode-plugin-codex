#!/usr/bin/env node
// @ts-nocheck
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import process from 'node:process';
import readline from 'node:readline';

if (process.argv.includes('--version')) {
  process.stdout.write(`${process.env.FAKE_ZCODE_VERSION ?? '0.16.1'}\n`);
  process.exit(0);
}
if (process.env.FAKE_ZCODE_PROCESS_FILE) await writeFile(process.env.FAKE_ZCODE_PROCESS_FILE, JSON.stringify({ pid: process.pid, ppid: process.ppid }));
if (process.env.FAKE_ZCODE_STDERR_BYTES) process.stderr.write((process.env.FAKE_ZCODE_STDERR_TEXT ?? 'sensitive-stderr').repeat(Math.ceil(Number(process.env.FAKE_ZCODE_STDERR_BYTES) / (process.env.FAKE_ZCODE_STDERR_TEXT ?? 'sensitive-stderr').length)));

const sessions = new Map();
const input = readline.createInterface({ input: process.stdin });
let permissionId = 9000;
let sendCount = 0;
let conversationSubscribeCount = 0;
let conversationUnsubscribeCount = 0;
let resumeCount = 0;
let listCount = 0;
let stopCount = 0;
let pendingRuntimePreferencesCreate;
let pendingConcurrentCreateResponse;
let pendingConcurrentSubscribeResponse;
let pendingConcurrentStopResponse;
const pendingCompletionTimers = new Map();
const conversationSubscriptions = new Map();
const conversationSubscriptionCounts = new Map();

const defaultModel = { providerId: 'fake', modelId: 'model' };
function settings(model = defaultModel) { return { appliedProviderRevision: 'provider-revision-1', model: { current: model, available: [{ ref: model, label: 'Fixture model', reasoning: { enabled: true, levels: [{ value: 'low', label: 'Low' }, { value: 'HIGH', label: 'High' }] } }, { ref: { providerId: 'fake2', modelId: 'other' }, label: 'Other model', reasoning: { enabled: true, levels: [{ value: 'XHIGH', label: 'Extreme' }] } }] }, thoughtLevel: { enabled: true, current: 'low', defaultLevel: 'low', available: [{ value: 'low', label: 'Low' }, { value: 'HIGH', label: 'High' }] }, mode: { current: 'build' }, permission: { mode: 'build', rulesRevision: 1 } }; }
function sessionInfo(sessionId, workspacePath = '/repo', status = 'idle') { return { sessionId, workspace: { workspacePath, workspaceKey: workspacePath }, sessionKind: 'interactive', title: 'Fixture session', titleSource: 'generated', mode: 'build', status, model: defaultModel, createdAt: 1, updatedAt: 1 }; }
function messages(sessionId, model = defaultModel) { return resultMessages(sessionId, model, false, 'history', 'text', undefined, 'historical-result-must-not-win'); }
function resultMessages(sessionId, model, review, suffix = 'current', selectedMode, inputMessageId, resultText) {
  const mode = selectedMode ?? process.env.FAKE_ZCODE_RESULT_MODE ?? 'text';
  const structured = review ? mode === 'invalid-structured' ? { findings: [{ severity: 'bogus' }] } : { findings: [] } : undefined;
  const assistantId = `message-assistant-${suffix}`; const userId = inputMessageId ?? `message-user-${suffix}`;
  const base = { partId: `part-assistant-${suffix}`, sessionId, messageId: assistantId };
  const gateText = process.env.FAKE_ZCODE_GATE_RESULT;
  const parts = mode === 'reasoning-only' ? [{ ...base, type: 'reasoning', text: 'private reasoning' }]
    : mode === 'mixed' ? [{ ...base, partId: 'reasoning', type: 'reasoning', text: 'private reasoning' }, { ...base, partId: 'ignored', type: 'text', text: 'ignored', ignored: true }, { ...base, partId: 'visible', type: 'text', text: review ? JSON.stringify({ findings: [] }) : 'done' }]
      : [{ ...base, type: 'text', text: gateText === '__EMPTY__' ? '' : gateText ?? (review ? JSON.stringify({ findings: [] }) : resultText ?? 'done') }];
  return [{ info: { messageId: userId, sessionId, role: 'user', time: { created: 1, completed: 2 }, agent: 'build', model, synthetic: false, visibility: 'user-visible' }, parts: [{ partId: `part-user-${suffix}`, sessionId, messageId: userId, type: 'text', text: 'hello' }] }, { info: { messageId: assistantId, sessionId, role: 'assistant', time: { created: 2, completed: 3 }, parentMessageId: userId, agent: 'build', model, path: { cwd: '/repo', root: '/repo' }, cost: 0, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }, finish: 'stop', ...(structured === undefined ? {} : { structured }) }, parts }];
}
function snapshot(sessionId, value = sessions.get(sessionId)) { const valueSettings = value?.settings ?? settings(); const status = value?.projectionStatus ?? 'idle'; const empty = process.env.FAKE_ZCODE_EMPTY_SESSION === '1'; const emptyVariant = process.env.FAKE_ZCODE_EMPTY_SESSION_VARIANT; const projectionSessionId = empty ? emptyVariant === 'conflict' ? 'other-session' : 'unknown' : sessionId; const projectionStatus = empty && emptyVariant === 'non-idle' ? 'running' : status; const runtimeEventSeq = empty && emptyVariant === 'event-seq' ? 1 : 0; const emptyMessages = empty && emptyVariant !== 'messages'; return { protocol: { name: 'ZCode Protocol', version: 1 }, session: { ...sessionInfo(sessionId, value?.workspacePath ?? process.env.FAKE_ZCODE_WORKSPACE ?? process.cwd(), status), model: valueSettings.model.current }, settings: valueSettings, projection: { sessionId: projectionSessionId, status: projectionStatus, mode: 'build', turnCount: 0, totalTokenCount: 0, contextUsed: 0, contextWindow: 128000, pendingPermissions: [], activeToolCalls: [], backgroundJobs: [], ...(empty && emptyVariant === 'target' ? { target: { sessionId: 'other-session', targetId: 'target-1', objective: 'foreign', summaryTitle: null, status: 'active', tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 1 } } : {}) }, runtime: { eventSeq: runtimeEventSeq, stateRevision: value?.stateRevision ?? 0, pendingRequestIds: [] }, messages: emptyMessages ? [] : value?.messages?.length ? value.messages : value?.pendingResult ? [] : messages(sessionId, valueSettings.model.current), goalStats: { timeUsedSeconds: 0, tokensUsed: 0, tokenBudget: null, contextUsed: 0, contextWindow: 128000, toolCallCount: 0, iterationCount: 0 }, todos: [{ content: 'Verify', status: 'pending', priority: 'high' }], todoGroups: [{ id: 'todo-group-1', source: 'session', todos: [] }], slashCommands: [{ name: 'review', description: 'Review code', source: 'builtin' }] }; }

function corruptSnapshot(result, variant) {
  if (variant === 'missing-workspace') delete result.session.workspace;
  if (variant === 'wrong-workspace') result.session.workspace.workspacePath = '/wrong-workspace';
  if (variant === 'wrong-workspace-key') result.session.workspace.workspaceKey = '/wrong-workspace-key';
  if (variant === 'wrong-projection-session') result.projection.sessionId = 'wrong-projection-session';
  if (variant === 'wrong-session-target') result.session.target = { sessionId: 'wrong-session-target', targetId: 'target-1', objective: 'Verify snapshot identity', summaryTitle: null, status: 'active', tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 1 };
  if (variant === 'wrong-projection-target') result.projection.target = { sessionId: 'wrong-projection-target', targetId: 'target-2', objective: 'Verify projection identity', summaryTitle: null, status: 'active', tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 1 };
  if (variant === 'wrong-message-session') result.messages[0].info.sessionId = 'wrong-message-session';
  if (variant === 'wrong-part-session') result.messages[0].parts[0].sessionId = 'wrong-part-session';
  if (variant === 'wrong-part-message') result.messages[0].parts[0].messageId = 'wrong-part-message';
  if (variant === 'empty-message') result.messages = [{}];
  if (variant === 'invented-session-kind') result.session.sessionKind = 'main';
  if (variant === 'invented-subagent-kind') result.session.sessionKind = 'subagent';
  if (variant === 'bad-protocol') result.protocol = { name: 'zcode', version: '0.16.1' };
  if (variant === 'missing-model-label') delete result.settings.model.available[0].label;
  if (variant === 'string-message-model') result.messages[0].info.model = 'fake/model';
  if (variant === 'bad-goal-stats') result.goalStats.tokensUsed = -1;
  if (variant === 'bad-permission-origin') result.projection.pendingPermissions = [{ requestId: 'request-1', toolCallId: 'tool-1', toolName: 'write', reason: 'test', riskLevel: 'low', origin: {}, options: [{ optionId: 'deny', kind: 'deny', name: 'Deny', response: { decision: 'deny' } }], requestedAt: 1 }];
  if (variant === 'bad-runtime-cache') result.runtime.contextUsage = { used: 0, size: 1, cache: { inputTokens: -1 } };
  if (variant === 'bad-timeline-trigger') result.messages[0].parts = [{ partId: 'part-timeline-1', sessionId: result.session.sessionId, messageId: 'message-user-1', type: 'timeline', timelineType: 'context_compaction', display: 'separator', trigger: 'invented' }];
  if (variant === 'bad-provider-options') result.settings.model.available[0].reasoning.providerOptionsByLevel = { low: 3 };
  return result;
}

function snapshotForMethod(method, sessionId, value = sessions.get(sessionId)) {
  const result = snapshot(sessionId, value);
  if (process.env.FAKE_ZCODE_BAD_SNAPSHOT_METHOD === method) corruptSnapshot(result, process.env.FAKE_ZCODE_BAD_SNAPSHOT);
  return result;
}

async function recoveryMode() { if (!process.env.FAKE_ZCODE_RECOVERY_CONTROL) return null; try { const value = JSON.parse(await readFile(process.env.FAKE_ZCODE_RECOVERY_CONTROL, 'utf8')); return ['active', 'completed', 'stopped', 'missing'].includes(value.mode) ? value.mode : 'active'; } catch { return 'active'; } }
function applyRecoveryMode(session, mode) {
  if (!session || !mode) return;
  session.projectionStatus = mode === 'completed' ? 'completed' : mode === 'stopped' ? 'paused' : 'running';
  if (mode === 'completed' && session.pendingResult && !session.resultApplied) {
    const pending = session.pendingResult; session.messages.push(...resultMessages(session.sessionId, session.settings.model.current, pending.review, pending.suffix, undefined, pending.inputId));
    session.resultApplied = true;
    session.stateRevision = Math.max(session.stateRevision ?? 0, 2);
  }
}

async function record(message) {
  if (process.env.FAKE_ZCODE_RECORD) {
    await appendFile(process.env.FAKE_ZCODE_RECORD, `${JSON.stringify(message)}\n`);
  }
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}
async function scheduleCompletion(sessionId, completion) {
  const reachedDelayMs = Number(process.env.FAKE_ZCODE_COMPLETION_GATE_REACHED_DELAY_MS ?? 0);
  if (Number.isSafeInteger(reachedDelayMs) && reachedDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, reachedDelayMs));
  if (process.env.FAKE_ZCODE_COMPLETION_GATE_REACHED) await writeFile(process.env.FAKE_ZCODE_COMPLETION_GATE_REACHED, 'blocked');
  /** @type {NodeJS.Timeout} */ let timer;
  const deliver = async () => {
    if (pendingCompletionTimers.get(sessionId) !== timer) return;
    if (process.env.FAKE_ZCODE_COMPLETION_GATE) {
      const state = await readFile(process.env.FAKE_ZCODE_COMPLETION_GATE, 'utf8').catch(() => '');
      if (state.trim() !== 'release') { timer = setTimeout(() => { void deliver(); }, 5); pendingCompletionTimers.set(sessionId, timer); return; }
    }
    pendingCompletionTimers.delete(sessionId); send(completion);
  };
  timer = setTimeout(() => { void deliver(); }, 5); pendingCompletionTimers.set(sessionId, timer);
}
function sendBatch(messages) { process.stdout.write(messages.map((message) => JSON.stringify(message)).join('\n') + '\n'); }
function flushConcurrentCreateSubscribe() {
  if (!pendingConcurrentCreateResponse || !pendingConcurrentSubscribeResponse) return;
  sendBatch(process.env.FAKE_ZCODE_CONCURRENT_CREATE_SUBSCRIBE_REVERSE_BATCH === '1'
    ? [pendingConcurrentCreateResponse, pendingConcurrentSubscribeResponse]
    : [pendingConcurrentSubscribeResponse, pendingConcurrentCreateResponse]);
  pendingConcurrentCreateResponse = undefined; pendingConcurrentSubscribeResponse = undefined;
}
function flushConcurrentStopSubscribe() {
  if (!pendingConcurrentStopResponse || !pendingConcurrentSubscribeResponse) return;
  sendBatch([pendingConcurrentSubscribeResponse, pendingConcurrentStopResponse]);
  pendingConcurrentStopResponse = undefined; pendingConcurrentSubscribeResponse = undefined;
}
function conversationNotification({ sessionId, subscriptionId, deliveryKind, ordinal, deltas, topic = `conversation/${sessionId}` }) {
  return { method: 'v4/conversation/frame', params: { wireVersion: 3, kind: 'complete', deliveryKind, logicalFrameId: `frame-${ordinal}`, logicalFrameOrdinal: ordinal, topic, subscriptionId, frame: { topic, subscriptionId, fromSeq: ordinal, toSeq: ordinal, sentAt: 1_786_233_600_000, payload: { kind: 'deltas', deltas } } } };
}

function isUnsupportedRuntimePreferencesResponse(message, pending) {
  return Object.keys(message).length === 2
    && message.id === pending.runtimePreferencesId
    && !Object.hasOwn(message, 'method')
    && !Object.hasOwn(message, 'result')
    && message.error !== null
    && typeof message.error === 'object'
    && !Array.isArray(message.error)
    && message.error.code === -32601
    && typeof message.error.message === 'string';
}

function completeCreate(message, respond = send) {
  const p = message.params ?? {};
  const sessionId = process.env.FAKE_ZCODE_SESSION_ID ?? p.sessionId ?? `session-${sessions.size + 1}`;
  sessions.set(sessionId, { sessionId, workspacePath: p.workspace?.workspacePath ?? '/repo', settings: settings(p.model ?? defaultModel), messages: [] });
  const result = snapshotForMethod('session/create', sessionId);
  if (process.env.FAKE_ZCODE_FUTURE_FIELDS === '1') { result.futureEnvelope = { ignored: true }; result.protocol.futureProtocolField = 'ignored'; result.projection.futureProjectionField = 'new'; result.settings.model.available[0].futureCatalogField = 42; }
  if (process.env.FAKE_ZCODE_PROTOCOL_VERSION) result.protocol.version = Number(process.env.FAKE_ZCODE_PROTOCOL_VERSION);
  if (process.env.FAKE_ZCODE_BAD_SNAPSHOT_METHOD === undefined) corruptSnapshot(result, process.env.FAKE_ZCODE_BAD_SNAPSHOT);
  const response = { id: message.id, result }; respond(response); return response;
}

input.on('line', async (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  await record(message);
  if (!message.method && pendingRuntimePreferencesCreate) {
    const pending = pendingRuntimePreferencesCreate;
    pendingRuntimePreferencesCreate = undefined;
    if (isUnsupportedRuntimePreferencesResponse(message, pending)) completeCreate(pending.message);
    else send({ id: pending.message.id, error: { code: -32098, message: 'invalid runtime preference response' } });
    return;
  }
  if (!message.method) return;
  if (process.env.FAKE_ZCODE_DISCONNECT === message.method) process.exit(7);
  if (process.env.FAKE_ZCODE_MALFORMED === message.method) {
    process.stdout.write('{not-json}\n');
    return;
  }
  if (process.env.FAKE_ZCODE_OVERSIZE === message.method) {
    process.stdout.write(`${'x'.repeat(Number(process.env.FAKE_ZCODE_OVERSIZE_BYTES ?? 2048))}\n`);
    return;
  }
  const delay = Number(process.env.FAKE_ZCODE_DELAY_MS ?? 0);
  if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
  if (process.env.FAKE_ZCODE_ERROR === message.method) {
    const error = { message: 'fixture request failed' };
    if (process.env.FAKE_ZCODE_ERROR_OMIT_CODE !== '1') error.code = process.env.FAKE_ZCODE_ERROR_CODE_JSON === undefined ? -32099 : JSON.parse(process.env.FAKE_ZCODE_ERROR_CODE_JSON);
    if (process.env.FAKE_ZCODE_ERROR_DATA_CODE !== undefined) {
      error.data = { code: process.env.FAKE_ZCODE_ERROR_DATA_CODE, secret: process.env.FAKE_ZCODE_ERROR_DATA_SECRET ?? 'fixture-secret-must-not-leak' };
    }
    send({ id: message.id, error });
    return;
  }
  if (process.env.FAKE_ZCODE_BAD_RESULT === message.method) {
    send({ id: message.id, result: 'invalid-result' });
    return;
  }
  if (process.env.FAKE_ZCODE_SUPPRESS_METHOD === message.method) return;
  const p = message.params ?? {};
  switch (message.method) {
    case 'session/create': {
      if (process.env.FAKE_ZCODE_RUNTIME_PREFERENCES_ID !== undefined) {
        const runtimePreferencesId = process.env.FAKE_ZCODE_RUNTIME_PREFERENCES_ID;
        pendingRuntimePreferencesCreate = { message, runtimePreferencesId };
        send({ id: runtimePreferencesId, method: 'session/requestRuntimePreferences', params: { sessionId: 'session-1', scope: 'runtime-materialization' } });
        break;
      }
      if (process.env.FAKE_ZCODE_CONCURRENT_CREATE_SUBSCRIBE_BATCH === '1' || process.env.FAKE_ZCODE_CONCURRENT_CREATE_SUBSCRIBE_REVERSE_BATCH === '1') { pendingConcurrentCreateResponse = completeCreate(message, () => {}); flushConcurrentCreateSubscribe(); }
      else completeCreate(message);
      break;
    }
    case 'session/send': {
      sendCount += 1;
      const trustedPrompt = typeof p.content === 'string' ? p.content.split('--- BEGIN UNTRUSTED GIT DATA ---', 1)[0] : '';
      let objectiveResult;
      if (process.env.FAKE_ZCODE_RESULT_FROM_AUTHORIZED_OBJECTIVE === '1') {
        const encoded = /--- BEGIN AUTHORIZED RESCUE OBJECTIVE ---\n([^\n]+)\n--- END AUTHORIZED RESCUE OBJECTIVE ---/.exec(trustedPrompt)?.[1];
        try { objectiveResult = `authorized:${JSON.parse(encoded)}`; } catch { objectiveResult = 'authorized-objective-missing'; }
      }
      const session = sessions.get(p.sessionId); if (session) {
        const review = /ZCODE_REVIEW_OUTPUT_SCHEMA:\s*\{/i.test(trustedPrompt); const suffix = `turn-${sendCount}`;
        const linkageMode = /current unrelated/i.test(p.content) ? 'orphan-assistant' : /current distinct id/i.test(p.content) ? 'distinct-user' : 'direct-input';
        const inputId = linkageMode === 'direct-input' ? p.inputId : undefined;
        if (process.env.FAKE_ZCODE_RECOVERY_CONTROL) { session.messages.push(...messages(p.sessionId, session.settings.model.current)); session.pendingResult = { review, suffix, inputId }; }
        else {
          let turnMessages = resultMessages(p.sessionId, session.settings.model.current, review, suffix, /current hidden/i.test(p.content) ? 'reasoning-only' : undefined, inputId, objectiveResult);
          if (linkageMode === 'orphan-assistant') turnMessages = turnMessages.slice(1);
          if (linkageMode === 'distinct-user') {
            turnMessages[0].info.semantics = { origin: 'real_user', kind: 'user_prompt', uiVisibility: 'visible', providerVisibility: 'visible', transcriptVisibility: 'visible' };
            turnMessages[1].info.semantics = { origin: 'agent_runtime', kind: 'assistant_response', uiVisibility: 'visible', providerVisibility: 'visible', transcriptVisibility: 'visible' };
            if (process.env.FAKE_ZCODE_LINKAGE_RECORD) await writeFile(process.env.FAKE_ZCODE_LINKAGE_RECORD, JSON.stringify({ inputId: p.inputId, userMessageId: turnMessages[0].info.messageId, assistantParentMessageId: turnMessages[1].info.parentMessageId }));
          }
          session.messages.push(...turnMessages);
        }
      }
      const stateRevision = process.env.FAKE_ZCODE_BARRIER === '1' ? 1000 : 1;
      if (session) session.stateRevision = stateRevision;
      if (process.env.FAKE_ZCODE_BARRIER === '1') send({ method: 'state.updated', params: { type: 'state.updated', scope: 'session', sessionId: p.sessionId, revision: 999, reason: 'prompt_completed', patch: { status: 'idle' } } });
      const response = { id: message.id, result: { sessionId: p.sessionId, accepted: true, stateRevision } };
      if (process.env.FAKE_ZCODE_BAD_SEND_ONCE === '1' && sendCount === 1) response.result.stateRevision = 'bad';
      if (process.env.FAKE_ZCODE_SYNC_BATCH !== 'stale-valid') send(response);
      const subscription = conversationSubscriptions.get(p.sessionId);
      if (process.env.FAKE_ZCODE_CONVERSATION_PROGRESS === '1' && subscription) {
        const base = { rowId: 41, turnId: 'turn-1', createdAt: 1_786_233_600_000, createdAtSeq: 41, kind: 'toolCall', toolCallId: 'tool-command-1', toolName: 'Bash', input: { command: 'npm\ttest', reasoning: 'reasoning must stay private', brokerToken: 'capability must stay private' }, inputText: '{"command":"raw output"}', startedAt: 1_786_233_600_000 };
        send(conversationNotification({ sessionId: p.sessionId, subscriptionId: subscription, deliveryKind: 'online', ordinal: 2, deltas: [{ op: 'row.upserted', row: { ...base, status: 'inputStreaming' } }] }));
        send(conversationNotification({ sessionId: p.sessionId, subscriptionId: subscription, deliveryKind: 'online', ordinal: 3, deltas: [{ op: 'row.upserted', row: { ...base, status: 'success', endedAt: 1_786_233_600_025, output: { text: 'raw output must stay private' } } }] }));
        send(conversationNotification({ sessionId: p.sessionId, subscriptionId: 'foreign-subscription', deliveryKind: 'online', ordinal: 4, deltas: [{ op: 'row.upserted', row: { ...base, rowId: 42, toolCallId: 'foreign', input: { command: 'FOREIGN_SECRET' }, status: 'started' } }] }));
      }
      if (process.env.FAKE_ZCODE_PERMISSION === '1') {
        const id = permissionId++;
        const params = { requestId: `permission-${id}`, sessionId: p.sessionId, toolCallId: 'tool-1', toolName: 'write', reason: 'fixture', riskLevel: process.env.FAKE_ZCODE_PERMISSION_RISK ?? 'medium', input: { secret: 'never-log-me' }, options: [{ optionId: 'allow', kind: 'allow', name: 'Allow', response: { decision: 'allow' } }, { optionId: 'deny', kind: 'deny', name: 'Deny', response: { decision: 'deny' } }] };
        if (process.env.FAKE_ZCODE_PERMISSION_MALFORMED === '1') delete params.options[0].optionId;
        send({ id, method: 'interaction/requestPermission', params });
        if (process.env.FAKE_ZCODE_PERMISSION_REPLAY === '1') send({ id: permissionId++, method: 'interaction/requestPermission', params });
      }
      const notificationSession = process.env.FAKE_ZCODE_CROSS_SESSION ?? p.sessionId;
      let notificationRevision = stateRevision;
      if (process.env.FAKE_ZCODE_PROGRESS === '1') {
        for (const reason of ['model_streaming', 'tool_call_started', 'tool_call_result']) {
          notificationRevision += 1;
          send({ method: 'state.updated', params: { type: 'state.updated', scope: 'session', sessionId: notificationSession, revision: notificationRevision, reason, patch: {} } });
        }
      }
      const completion = { method: 'state.updated', params: { type: 'state.updated', scope: 'session', sessionId: notificationSession, revision: notificationRevision + 1, reason: 'prompt_completed', patch: { status: 'idle' } } };
      if (process.env.FAKE_ZCODE_SYNC_BATCH === 'stale-valid') sendBatch([response, { method: 'state.updated', params: { ...completion.params, revision: stateRevision } }, completion]);
      else if (process.env.FAKE_ZCODE_SYNC_COMPLETE === '1') send(completion);
      else if (!(process.env.FAKE_ZCODE_SUPPRESS_FIRST_COMPLETION === '1' && sendCount === 1)
        && Number(process.env.FAKE_ZCODE_SUPPRESS_COMPLETION_AT ?? 0) !== sendCount) {
        const existingTimer = pendingCompletionTimers.get(p.sessionId); if (existingTimer) clearTimeout(existingTimer);
        await scheduleCompletion(p.sessionId, completion);
      }
      break;
    }
    case 'v4/conversation/subscribe': {
      conversationSubscribeCount += 1;
      if (process.env.FAKE_ZCODE_CONVERSATION_SUBSCRIBE_FAIL === '1') { send({ id: message.id, error: { code: -32601, message: 'unsupported conversation subscription' } }); break; }
      const sessionId = typeof p.topic === 'string' && p.topic.startsWith('conversation/') ? p.topic.slice('conversation/'.length) : '';
      let badAcknowledgement = process.env.FAKE_ZCODE_BAD_CONVERSATION_ACK_ONCE === '1' && conversationSubscribeCount === 1;
      const badAckMarker = process.env.FAKE_ZCODE_BAD_CONVERSATION_ACK_MARKER;
      if (badAcknowledgement && badAckMarker) {
        try { await readFile(badAckMarker); badAcknowledgement = false; }
        catch { await writeFile(badAckMarker, 'observed'); }
      }
      const subscriptionCount = (conversationSubscriptionCounts.get(sessionId) ?? 0) + 1; conversationSubscriptionCounts.set(sessionId, subscriptionCount); const subscriptionId = badAcknowledgement ? '' : `subscription-${sessionId}${subscriptionCount === 1 ? '' : `-${subscriptionCount}`}`; conversationSubscriptions.set(sessionId, subscriptionId);
      if (process.env.FAKE_ZCODE_CONVERSATION_PREBIND_ONLINE === '1') send(conversationNotification({ sessionId, subscriptionId, deliveryKind: 'online', ordinal: 1, deltas: [{ op: 'row.upserted', row: { rowId: 39, turnId: 'turn-1', createdAt: 1_786_233_600_000, createdAtSeq: 39, kind: 'toolCall', toolCallId: 'prebind', toolName: 'Bash', status: 'running', inputText: '{"command":"echo prebind"}', input: { command: 'echo prebind' }, startedAt: 1_786_233_600_000 } }] }));
      const response = { id: message.id, result: { ack: { subscriptionId, mode: 'snapshot', logEpoch: 'epoch-1' } } };
      if (process.env.FAKE_ZCODE_CONCURRENT_CREATE_SUBSCRIBE_BATCH === '1' || process.env.FAKE_ZCODE_CONCURRENT_CREATE_SUBSCRIBE_REVERSE_BATCH === '1') { pendingConcurrentSubscribeResponse = response; flushConcurrentCreateSubscribe(); }
      else if (process.env.FAKE_ZCODE_CONCURRENT_STOP_SUBSCRIBE_BATCH === '1') { pendingConcurrentSubscribeResponse = response; flushConcurrentStopSubscribe(); }
      else send(response);
      if (process.env.FAKE_ZCODE_CONVERSATION_PROGRESS === '1') send(conversationNotification({ sessionId, subscriptionId, deliveryKind: 'initial', ordinal: 1, deltas: [{ op: 'row.upserted', row: { rowId: 40, turnId: 'turn-1', createdAt: 1_786_233_600_000, createdAtSeq: 40, kind: 'toolCall', toolCallId: 'initial', toolName: 'Bash', status: 'inputStreaming', inputText: '{"command":"INITIAL_SECRET"}', input: { command: 'INITIAL_SECRET' }, startedAt: 1_786_233_600_000 } }] }));
      break;
    }
    case 'v4/conversation/unsubscribe':
      conversationUnsubscribeCount += 1;
      if (process.env.FAKE_ZCODE_CONVERSATION_UNSUBSCRIBE_FAIL === '1') send({ id: message.id, error: { code: -32099, message: 'unsubscribe failed' } });
      else if (process.env.FAKE_ZCODE_CONVERSATION_UNSUBSCRIBE_MALFORMED === '1' || Number(process.env.FAKE_ZCODE_CONVERSATION_UNSUBSCRIBE_MALFORMED_AFTER) === conversationUnsubscribeCount) send({ id: message.id, result: { malformed: true } });
      else send({ id: message.id, result: {} });
      break;
    case 'session/read': {
      const session = sessions.get(p.sessionId); applyRecoveryMode(session, await recoveryMode());
      send({ id: message.id, result: snapshotForMethod('session/read', p.sessionId, session) });
      break;
    }
    case 'session/resume':
      resumeCount += 1;
      if (process.env.FAKE_ZCODE_RESUME_ABA === '1' && resumeCount === 1) { await new Promise((resolve) => setTimeout(resolve, 40)); send({ id: message.id, error: { code: -32099, message: 'late resume failure' } }); break; }
      if (!sessions.has(p.sessionId)) sessions.set(p.sessionId, { sessionId: p.sessionId, workspacePath: process.env.FAKE_ZCODE_WORKSPACE ?? process.cwd(), settings: settings(), messages: [] });
      send({ id: message.id, result: snapshotForMethod('session/resume', p.sessionId) });
      break;
    case 'session/list': {
      listCount += 1;
      const mode = await recoveryMode(); const listed = mode === 'missing' ? [] : [...sessions.values()];
      for (const session of listed) applyRecoveryMode(session, mode);
      if (process.env.FAKE_ZCODE_LIST_NOTIFICATION_ONCE === '1' && listCount === 1) send({ method: 'fixture/notification', params: { occurrence: 1 } });
      if (process.env.FAKE_ZCODE_LIST_ROUTING_NOTIFICATIONS === '1' && listCount === 1) { send({ method: 'fixture/globalNotification', params: { occurrence: 1 } }); if (listed[0]) send({ method: 'fixture/sessionNotification', params: { sessionId: listed[0].sessionId, occurrence: 1 } }); }
      send({ id: message.id, result: { sessions: process.env.FAKE_ZCODE_BAD_LIST === 'session-id-only' ? listed.map(({ sessionId }) => ({ sessionId })) : listed.map(({ sessionId, workspacePath, projectionStatus }) => sessionInfo(sessionId, workspacePath, projectionStatus)) } });
      break;
    }
    case 'session/stop': {
      stopCount += 1;
      if (process.env.FAKE_ZCODE_STOP_GATE_REACHED) await writeFile(process.env.FAKE_ZCODE_STOP_GATE_REACHED, 'blocked');
      while (process.env.FAKE_ZCODE_STOP_GATE && (await readFile(process.env.FAKE_ZCODE_STOP_GATE, 'utf8').catch(() => '')).trim() !== 'release') await new Promise((resolve) => setTimeout(resolve, 5));
      if (process.env.FAKE_ZCODE_STOP_ERROR_ONCE === '1' && stopCount === 1) { send({ id: message.id, error: { code: -32099, message: 'fixture first stop failed' } }); break; }
      if (process.env.FAKE_ZCODE_STOP_ERROR_PREFIX && p.sessionId.startsWith(process.env.FAKE_ZCODE_STOP_ERROR_PREFIX)) { send({ id: message.id, error: { code: -32099, message: 'fixture stop failed' } }); break; }
      const timer = pendingCompletionTimers.get(p.sessionId); if (timer) { clearTimeout(timer); pendingCompletionTimers.delete(p.sessionId); }
      const response = { id: message.id, result: process.env.FAKE_ZCODE_BAD_STOP_EXTRA === '1' ? { stopped: true } : {} };
      if (process.env.FAKE_ZCODE_CONCURRENT_STOP_SUBSCRIBE_BATCH === '1') { pendingConcurrentStopResponse = response; flushConcurrentStopSubscribe(); }
      else send(response);
      break;
    }
    case 'session/setModel':
      sessions.get(p.sessionId).settings.model.current = process.env.FAKE_ZCODE_SET_MODEL_CURRENT ? JSON.parse(process.env.FAKE_ZCODE_SET_MODEL_CURRENT) : p.model;
      send({ id: message.id, result: snapshotForMethod('session/setModel', p.sessionId) });
      break;
    case 'session/setThoughtLevel':
      sessions.get(p.sessionId).settings.thoughtLevel.current = process.env.FAKE_ZCODE_SET_THOUGHT_CURRENT ?? p.thoughtLevel;
      send({ id: message.id, result: snapshotForMethod('session/setThoughtLevel', p.sessionId) });
      break;
    default:
      send({ id: message.id, error: { code: -32601, message: `unknown ${message.method}` } });
  }
});
