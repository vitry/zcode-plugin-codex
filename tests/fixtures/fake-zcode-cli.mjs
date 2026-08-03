#!/usr/bin/env node
// @ts-nocheck
import { appendFile } from 'node:fs/promises';
import process from 'node:process';
import readline from 'node:readline';

if (process.argv.includes('--version')) {
  process.stdout.write(`${process.env.FAKE_ZCODE_VERSION ?? '0.16.1'}\n`);
  process.exit(0);
}

const sessions = new Map();
const input = readline.createInterface({ input: process.stdin });
let permissionId = 9000;

async function record(message) {
  if (process.env.FAKE_ZCODE_RECORD) {
    await appendFile(process.env.FAKE_ZCODE_RECORD, `${JSON.stringify(message)}\n`);
  }
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

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
      sessions.set(sessionId, { sessionId, settings: { model: { current: p.model ?? { providerId: 'fake', modelId: 'model' }, available: [{ ref: p.model ?? { providerId: 'fake', modelId: 'model' }, reasoning: { enabled: true, levels: [{ value: 'low', label: 'Low' }, { value: 'HIGH', label: 'High' }] } }, { ref: { providerId: 'fake2', modelId: 'other' }, reasoning: { enabled: true, levels: [{ value: 'XHIGH', label: 'Extreme' }] } }] } }, messages: [] });
      send({ id: message.id, result: { session: { sessionId }, settings: sessions.get(sessionId).settings, messages: [] } });
      break;
    }
    case 'session/send': {
      const stateRevision = process.env.FAKE_ZCODE_BARRIER === '1' ? 1000 : 1;
      if (process.env.FAKE_ZCODE_BARRIER === '1') send({ method: 'state.updated', params: { type: 'state.updated', scope: 'session', sessionId: p.sessionId, revision: 999, reason: 'prompt_completed', patch: { status: 'idle' } } });
      send({ id: message.id, result: { sessionId: p.sessionId, accepted: true, stateRevision } });
      if (process.env.FAKE_ZCODE_PERMISSION === '1') {
        const id = permissionId++;
        const params = { requestId: `permission-${id}`, sessionId: p.sessionId, toolCallId: 'tool-1', toolName: 'write', reason: 'fixture', riskLevel: 'medium', input: { secret: 'never-log-me' }, options: [{ optionId: 'allow', kind: 'allow', name: 'Allow', response: { decision: 'allow' } }, { optionId: 'deny', kind: 'deny', name: 'Deny', response: { decision: 'deny' } }] };
        if (process.env.FAKE_ZCODE_PERMISSION_MALFORMED === '1') delete params.options[0].optionId;
        send({ id, method: 'interaction/requestPermission', params });
        if (process.env.FAKE_ZCODE_PERMISSION_REPLAY === '1') send({ id: permissionId++, method: 'interaction/requestPermission', params });
      }
      const notificationSession = process.env.FAKE_ZCODE_CROSS_SESSION ?? p.sessionId;
      const complete = () => send({ method: 'state.updated', params: { type: 'state.updated', scope: 'session', sessionId: notificationSession, revision: stateRevision + 1, reason: 'prompt_completed', patch: { status: 'idle' } } });
      if (process.env.FAKE_ZCODE_SYNC_COMPLETE === '1') complete(); else setTimeout(complete, 5);
      break;
    }
    case 'session/read':
      send({ id: message.id, result: { session: { sessionId: p.sessionId }, settings: sessions.get(p.sessionId)?.settings ?? { model: { current: { providerId: 'fake', modelId: 'model' }, available: [] } }, messages: sessions.get(p.sessionId)?.messages ?? [] } });
      break;
    case 'session/resume':
      send({ id: message.id, result: { session: { sessionId: p.sessionId }, settings: sessions.get(p.sessionId)?.settings ?? { model: { current: { providerId: 'fake', modelId: 'model' }, available: [] } }, messages: [] } });
      break;
    case 'session/list':
      send({ id: message.id, result: { sessions: [...sessions.values()].map(({ sessionId }) => ({ sessionId })) } });
      break;
    case 'session/stop':
      send({ id: message.id, result: {} });
      break;
    case 'session/setModel':
      sessions.get(p.sessionId).settings.model.current = p.model;
      send({ id: message.id, result: { session: { sessionId: p.sessionId }, settings: sessions.get(p.sessionId).settings, messages: [] } });
      break;
    case 'session/setThoughtLevel':
      send({ id: message.id, result: { session: { sessionId: p.sessionId }, settings: sessions.get(p.sessionId)?.settings ?? {}, messages: [] } });
      break;
    default:
      send({ id: message.id, error: { code: -32601, message: `unknown ${message.method}` } });
  }
});
