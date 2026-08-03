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
      sessions.set(sessionId, { sessionId, settings: { model: { current: p.model ?? { providerId: 'fake', modelId: 'model' }, available: [{ ref: p.model ?? { providerId: 'fake', modelId: 'model' }, reasoning: { enabled: true, levels: [{ value: 'low', label: 'Low' }, { value: 'HIGH', label: 'High' }] } }] } }, messages: [] });
      send({ id: message.id, result: { session: { sessionId }, settings: sessions.get(sessionId).settings, messages: [] } });
      break;
    }
    case 'session/send': {
      send({ id: message.id, result: { sessionId: p.sessionId, accepted: true, stateRevision: 1 } });
      if (process.env.FAKE_ZCODE_PERMISSION === '1') {
        const id = permissionId++;
        send({ id, method: 'interaction/requestPermission', params: { requestId: `permission-${id}`, sessionId: p.sessionId, toolCallId: 'tool-1', toolName: 'write', reason: 'fixture', riskLevel: 'medium', input: { secret: 'never-log-me' }, options: [{ optionId: 'allow', kind: 'allow', name: 'Allow', response: { decision: 'allow' } }, { optionId: 'deny', kind: 'deny', name: 'Deny', response: { decision: 'deny' } }] } });
      }
      const notificationSession = process.env.FAKE_ZCODE_CROSS_SESSION ?? p.sessionId;
      setTimeout(() => send({ method: 'state.updated', params: { type: 'state.updated', scope: 'session', sessionId: notificationSession, revision: 2, reason: 'prompt_completed', patch: { status: 'idle' } } }), 5);
      break;
    }
    case 'session/read':
      send({ id: message.id, result: sessions.get(p.sessionId) ?? { sessionId: p.sessionId, messages: [] } });
      break;
    case 'session/resume':
      send({ id: message.id, result: { session: { sessionId: p.sessionId }, messages: [] } });
      break;
    case 'session/list':
      send({ id: message.id, result: { sessions: [...sessions.values()].map(({ sessionId }) => ({ sessionId })) } });
      break;
    case 'session/stop':
      send({ id: message.id, result: { sessionId: p.sessionId } });
      break;
    case 'session/setModel':
    case 'session/setThoughtLevel':
      send({ id: message.id, result: { sessionId: p.sessionId, ...p } });
      break;
    default:
      send({ id: message.id, error: { code: -32601, message: `unknown ${message.method}` } });
  }
});
