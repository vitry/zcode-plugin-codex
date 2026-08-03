#!/usr/bin/env node
// @ts-nocheck
import { appendFile } from 'node:fs/promises';
import process from 'node:process';
import readline from 'node:readline';

if (process.argv.includes('--version')) {
  process.stdout.write(`${process.env.FAKE_ZCODE_VERSION ?? '0.16.1'}\n`);
  process.exit(0);
}
if (process.env.FAKE_ZCODE_STDERR_BYTES) process.stderr.write('sensitive-stderr'.repeat(Math.ceil(Number(process.env.FAKE_ZCODE_STDERR_BYTES) / 16)));

const sessions = new Map();
const input = readline.createInterface({ input: process.stdin });
let permissionId = 9000;
let sendCount = 0;
let resumeCount = 0;

const defaultModel = { providerId: 'fake', modelId: 'model' };
function settings(model = defaultModel) { return { appliedProviderRevision: 'provider-revision-1', model: { current: model, available: [{ ref: model, label: 'Fixture model', reasoning: { enabled: true, levels: [{ value: 'low', label: 'Low' }, { value: 'HIGH', label: 'High' }] } }, { ref: { providerId: 'fake2', modelId: 'other' }, label: 'Other model', reasoning: { enabled: true, levels: [{ value: 'XHIGH', label: 'Extreme' }] } }] }, thoughtLevel: { enabled: true, current: 'low', defaultLevel: 'low', available: [{ value: 'low', label: 'Low' }, { value: 'HIGH', label: 'High' }] }, mode: { current: 'build' }, permission: { mode: 'build', rulesRevision: 1 } }; }
function sessionInfo(sessionId, workspacePath = '/repo') { return { sessionId, workspace: { workspacePath, workspaceKey: workspacePath }, sessionKind: 'interactive', title: 'Fixture session', titleSource: 'generated', mode: 'build', status: 'idle', model: defaultModel, createdAt: 1, updatedAt: 1 }; }
function messages(sessionId, model = defaultModel) { return [{ info: { messageId: 'message-user-1', sessionId, role: 'user', time: { created: 1, completed: 2 }, agent: 'build', model, synthetic: false, visibility: 'user-visible' }, parts: [{ partId: 'part-user-1', sessionId, messageId: 'message-user-1', type: 'text', text: 'hello' }] }, { info: { messageId: 'message-assistant-1', sessionId, role: 'assistant', time: { created: 2, completed: 3 }, parentMessageId: 'message-user-1', agent: 'build', model, path: { cwd: '/repo', root: '/repo' }, cost: 0, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }, finish: 'stop' }, parts: [{ partId: 'part-assistant-1', sessionId, messageId: 'message-assistant-1', type: 'reasoning', text: 'done' }] }]; }
function snapshot(sessionId, value = sessions.get(sessionId)) { const valueSettings = value?.settings ?? settings(); return { protocol: { name: 'ZCode Protocol', version: 1 }, session: { ...sessionInfo(sessionId, value?.workspacePath), model: valueSettings.model.current }, settings: valueSettings, projection: { sessionId, status: 'idle', mode: 'build', turnCount: 0, totalTokenCount: 0, contextUsed: 0, contextWindow: 128000, pendingPermissions: [], activeToolCalls: [], backgroundJobs: [] }, runtime: { eventSeq: 0, stateRevision: 0, pendingRequestIds: [] }, messages: value?.messages?.length ? value.messages : messages(sessionId, valueSettings.model.current), goalStats: { timeUsedSeconds: 0, tokensUsed: 0, tokenBudget: null, contextUsed: 0, contextWindow: 128000, toolCallCount: 0, iterationCount: 0 }, todos: [{ content: 'Verify', status: 'pending', priority: 'high' }], todoGroups: [{ id: 'todo-group-1', source: 'session', todos: [] }], slashCommands: [{ name: 'review', description: 'Review code', source: 'builtin' }] }; }

async function record(message) {
  if (process.env.FAKE_ZCODE_RECORD) {
    await appendFile(process.env.FAKE_ZCODE_RECORD, `${JSON.stringify(message)}\n`);
  }
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}
function sendBatch(messages) { process.stdout.write(messages.map((message) => JSON.stringify(message)).join('\n') + '\n'); }

input.on('line', async (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  await record(message);
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
    send({ id: message.id, error: { code: -32099, message: 'fixture request failed' } });
    return;
  }
  if (process.env.FAKE_ZCODE_BAD_RESULT === message.method) {
    send({ id: message.id, result: 'invalid-result' });
    return;
  }
  const p = message.params ?? {};
  switch (message.method) {
    case 'session/create': {
      const sessionId = p.sessionId ?? `session-${sessions.size + 1}`;
      sessions.set(sessionId, { sessionId, workspacePath: p.workspace?.workspacePath ?? '/repo', settings: settings(p.model ?? defaultModel), messages: [] });
      const result = snapshot(sessionId);
      if (process.env.FAKE_ZCODE_BAD_SNAPSHOT === 'missing-workspace') delete result.session.workspace;
      if (process.env.FAKE_ZCODE_BAD_SNAPSHOT === 'empty-message') result.messages = [{}];
      if (process.env.FAKE_ZCODE_BAD_SNAPSHOT === 'invented-session-kind') result.session.sessionKind = 'main';
      if (process.env.FAKE_ZCODE_BAD_SNAPSHOT === 'invented-subagent-kind') result.session.sessionKind = 'subagent';
      if (process.env.FAKE_ZCODE_BAD_SNAPSHOT === 'bad-protocol') result.protocol = { name: 'zcode', version: '0.16.1' };
      if (process.env.FAKE_ZCODE_BAD_SNAPSHOT === 'missing-model-label') delete result.settings.model.available[0].label;
      if (process.env.FAKE_ZCODE_BAD_SNAPSHOT === 'string-message-model') result.messages[0].info.model = 'fake/model';
      if (process.env.FAKE_ZCODE_BAD_SNAPSHOT === 'bad-goal-stats') result.goalStats.tokensUsed = -1;
      if (process.env.FAKE_ZCODE_BAD_SNAPSHOT === 'bad-permission-origin') result.projection.pendingPermissions = [{ requestId: 'request-1', toolCallId: 'tool-1', toolName: 'write', reason: 'test', riskLevel: 'low', origin: {}, options: [{ optionId: 'deny', kind: 'deny', name: 'Deny', response: { decision: 'deny' } }], requestedAt: 1 }];
      if (process.env.FAKE_ZCODE_BAD_SNAPSHOT === 'bad-runtime-cache') result.runtime.contextUsage = { used: 0, size: 1, cache: { inputTokens: -1 } };
      if (process.env.FAKE_ZCODE_BAD_SNAPSHOT === 'bad-timeline-trigger') result.messages[0].parts = [{ partId: 'part-timeline-1', sessionId, messageId: 'message-user-1', type: 'timeline', timelineType: 'context_compaction', display: 'separator', trigger: 'invented' }];
      if (process.env.FAKE_ZCODE_BAD_SNAPSHOT === 'bad-provider-options') result.settings.model.available[0].reasoning.providerOptionsByLevel = { low: 3 };
      send({ id: message.id, result });
      break;
    }
    case 'session/send': {
      sendCount += 1;
      const stateRevision = process.env.FAKE_ZCODE_BARRIER === '1' ? 1000 : 1;
      if (process.env.FAKE_ZCODE_BARRIER === '1') send({ method: 'state.updated', params: { type: 'state.updated', scope: 'session', sessionId: p.sessionId, revision: 999, reason: 'prompt_completed', patch: { status: 'idle' } } });
      const response = { id: message.id, result: { sessionId: p.sessionId, accepted: true, stateRevision } };
      if (process.env.FAKE_ZCODE_SYNC_BATCH !== 'stale-valid') send(response);
      if (process.env.FAKE_ZCODE_PERMISSION === '1') {
        const id = permissionId++;
        const params = { requestId: `permission-${id}`, sessionId: p.sessionId, toolCallId: 'tool-1', toolName: 'write', reason: 'fixture', riskLevel: 'medium', input: { secret: 'never-log-me' }, options: [{ optionId: 'allow', kind: 'allow', name: 'Allow', response: { decision: 'allow' } }, { optionId: 'deny', kind: 'deny', name: 'Deny', response: { decision: 'deny' } }] };
        if (process.env.FAKE_ZCODE_PERMISSION_MALFORMED === '1') delete params.options[0].optionId;
        send({ id, method: 'interaction/requestPermission', params });
        if (process.env.FAKE_ZCODE_PERMISSION_REPLAY === '1') send({ id: permissionId++, method: 'interaction/requestPermission', params });
      }
      const notificationSession = process.env.FAKE_ZCODE_CROSS_SESSION ?? p.sessionId;
      const completion = { method: 'state.updated', params: { type: 'state.updated', scope: 'session', sessionId: notificationSession, revision: stateRevision + 1, reason: 'prompt_completed', patch: { status: 'idle' } } };
      if (process.env.FAKE_ZCODE_SYNC_BATCH === 'stale-valid') sendBatch([response, { method: 'state.updated', params: { ...completion.params, revision: stateRevision } }, completion]);
      else if (process.env.FAKE_ZCODE_SYNC_COMPLETE === '1') send(completion);
      else if (!(process.env.FAKE_ZCODE_SUPPRESS_FIRST_COMPLETION === '1' && sendCount === 1)) setTimeout(() => send(completion), 5);
      break;
    }
    case 'session/read':
      send({ id: message.id, result: snapshot(p.sessionId) });
      break;
    case 'session/resume':
      resumeCount += 1;
      if (process.env.FAKE_ZCODE_RESUME_ABA === '1' && resumeCount === 1) { await new Promise((resolve) => setTimeout(resolve, 40)); send({ id: message.id, error: { code: -32099, message: 'late resume failure' } }); break; }
      if (!sessions.has(p.sessionId)) sessions.set(p.sessionId, { sessionId: p.sessionId, workspacePath: '/repo', settings: settings(), messages: [] });
      send({ id: message.id, result: snapshot(p.sessionId) });
      break;
    case 'session/list':
      send({ id: message.id, result: { sessions: process.env.FAKE_ZCODE_BAD_LIST === 'session-id-only' ? [...sessions.values()].map(({ sessionId }) => ({ sessionId })) : [...sessions.values()].map(({ sessionId, workspacePath }) => sessionInfo(sessionId, workspacePath)) } });
      break;
    case 'session/stop':
      send({ id: message.id, result: process.env.FAKE_ZCODE_BAD_STOP_EXTRA === '1' ? { stopped: true } : {} });
      break;
    case 'session/setModel':
      sessions.get(p.sessionId).settings.model.current = p.model;
      send({ id: message.id, result: snapshot(p.sessionId) });
      break;
    case 'session/setThoughtLevel':
      send({ id: message.id, result: snapshot(p.sessionId) });
      break;
    default:
      send({ id: message.id, error: { code: -32601, message: `unknown ${message.method}` } });
  }
});
