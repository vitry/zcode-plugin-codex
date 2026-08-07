#!/usr/bin/env node
// @ts-nocheck
import { appendFileSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import process from 'node:process';
import readline from 'node:readline';

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

async function record(value) {
  if (process.env.FAKE_CODEX_RECORD) await appendFile(process.env.FAKE_CODEX_RECORD, `${JSON.stringify(value)}\n`);
}
function recordLifecycle(signal) {
  if (process.env.FAKE_CODEX_RECORD) appendFileSync(process.env.FAKE_CODEX_RECORD, `${JSON.stringify({ lifecycle: signal })}\n`);
}
const keepAlive = setInterval(() => {}, 60_000);

let outputQueue = Promise.resolve();
function write(value) {
  const frame = `${JSON.stringify(value)}${process.env.FAKE_CODEX_CRLF === '1' ? '\r\n' : '\n'}`;
  outputQueue = outputQueue.then(async () => {
    if (process.env.FAKE_CODEX_PARTIAL === '1') {
      const middle = Math.floor(frame.length / 2);
      process.stdout.write(frame.slice(0, middle));
      await new Promise((resolve) => setTimeout(resolve, 2));
      process.stdout.write(frame.slice(middle));
    } else process.stdout.write(frame);
  });
}

function writeDeepFrame(prefix, depth, suffix) {
  process.stdout.write(`${prefix}${'{"value":'.repeat(depth)}null${'}'.repeat(depth)}${suffix}\n`);
}

if (process.env.FAKE_CODEX_STDERR_BYTES) {
  const text = process.env.FAKE_CODEX_STDERR_TEXT ?? 'diagnostic';
  process.stderr.write(text.repeat(Math.ceil(Number(process.env.FAKE_CODEX_STDERR_BYTES) / text.length)));
}

for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
  clearInterval(keepAlive);
  recordLifecycle(signal);
  process.exit(0);
});
process.on('exit', () => { if (process.env.FAKE_CODEX_EXIT_MARKER) process.stderr.write(process.env.FAKE_CODEX_EXIT_MARKER); });

let inputQueue = Promise.resolve();
let configReadIndex = 0;
input.on('line', (line) => { inputQueue = inputQueue.then(() => handleLine(line)); });

async function handleLine(line) {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  await record(request);
  if (!request.method || process.env.FAKE_CODEX_HANG === request.method) return;
  if (process.env.FAKE_CODEX_NOTIFICATION === '1') write({ method: 'thread/status/changed', params: { threadId: 'unrelated' } });
  if (process.env.FAKE_CODEX_OTHER_ID === '1') write({ id: 999, result: { ignored: true } });
  if (process.env.FAKE_CODEX_MALFORMED === request.method) { process.stdout.write('{not-json}\n'); return; }
  if (process.env.FAKE_CODEX_OVERSIZE === request.method) { process.stdout.write(`${'x'.repeat(Number(process.env.FAKE_CODEX_OVERSIZE_BYTES ?? 4096))}\n`); return; }
  if (process.env.FAKE_CODEX_ERROR === request.method) { write({ id: request.id, error: { code: -32001, message: 'thread unavailable', data: { secret: 'do-not-copy' } } }); return; }
  if (process.env.FAKE_CODEX_AMBIGUOUS === request.method) { write({ id: request.id, result: {}, error: { code: -32001, message: 'ambiguous' } }); return; }
  if (request.method === 'initialize') {
    write({ id: request.id, result: { userAgent: 'fake-codex' } });
    return;
  }
  if (request.method === 'thread/read') {
    if (process.env.FAKE_CODEX_DEEP_NOTIFICATION_DEPTH) writeDeepFrame('{"method":"thread/status/changed","params":', Number(process.env.FAKE_CODEX_DEEP_NOTIFICATION_DEPTH), '}');
    if (process.env.FAKE_CODEX_DEEP_RESPONSE_DEPTH) { writeDeepFrame(`{"id":${request.id},"result":{"thread":`, Number(process.env.FAKE_CODEX_DEEP_RESPONSE_DEPTH), '}}'); return; }
    let thread;
    if (process.env.FAKE_CODEX_GENERATED_MESSAGE_BYTES) {
      const count = Number(process.env.FAKE_CODEX_GENERATED_MESSAGE_COUNT ?? 1); const bytes = Number(process.env.FAKE_CODEX_GENERATED_MESSAGE_BYTES);
      thread = { id: request.params.threadId, ephemeral: false, turns: Array.from({ length: count }, (_, index) => ({ startedAt: 1_725_000_000 + index, items: [{ type: index % 2 ? 'agentMessage' : 'userMessage', ...(index % 2 ? { text: 'x'.repeat(bytes) } : { content: [{ type: 'text', text: 'x'.repeat(bytes) }] }) }] })) };
    } else try { thread = JSON.parse(process.env.FAKE_CODEX_THREAD_JSON ?? '{}'); } catch { thread = null; }
    write({ id: request.id, result: { thread } });
    return;
  }
  if (request.method === 'config/read') {
    const results = process.env.FAKE_CODEX_CONFIG_RESULTS_JSON ? JSON.parse(process.env.FAKE_CODEX_CONFIG_RESULTS_JSON) : null;
    const result = Array.isArray(results) ? results[Math.min(configReadIndex++, results.length - 1)] : JSON.parse(process.env.FAKE_CODEX_CONFIG_RESULT ?? '{"config":{},"origins":{},"layers":[]}');
    write({ id: request.id, result }); return;
  }
  if (request.method === 'hooks/list') { write({ id: request.id, result: JSON.parse(process.env.FAKE_CODEX_HOOKS_RESULT ?? '{"data":[]}') }); return; }
  if (request.method === 'config/batchWrite') { write({ id: request.id, result: { filePath: process.env.FAKE_CODEX_CONFIG_PATH ?? '/tmp/config.toml', status: 'ok', version: 'version-2' } }); }
}
