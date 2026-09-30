// @ts-nocheck
/**
 * Disposable Codex plugin hook observer for the real-Host qualification
 * fixture. Codex invokes this script for each registered hook event with one
 * bounded JSON payload on stdin. The observer salts the hook authority
 * namespace fields (session_id, turn_id, agent_id) with the per-run nonce and
 * appends one durable hook-observed event through the same locked observer
 * the probe server uses. It never records raw ids, cwd, prompt, task, or
 * transcript paths, and never writes result.json. Without the probe
 * environment variables it is a silent no-op success, so the fixture hook can
 * never disturb a non-probe Host session.
 */
import process from 'node:process';

import { appendProbeEvent, hashProbeValue } from './observer.mjs';
import { probeObserverFromEnv } from './server.mjs';

const MAX_HOOK_INPUT_BYTES = 64 * 1024;
const HOOK_INPUT_DEADLINE_MS = 2_000;

/** Maps Codex hook event names to the closed durable hook vocabulary. */
const EVENT_NAMES = Object.freeze({
  SessionStart: 'session-start',
  UserPromptSubmit: 'user-prompt-submit',
  SubagentStart: 'subagent-start',
  SubagentStop: 'subagent-stop',
  Stop: 'stop',
  SessionEnd: 'session-end',
});

/** Bounded identifier: nonempty, at most 512 bytes, no control characters. */
function boundedIdentifier(value) {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 512
    && ![...value].some((character) => character.codePointAt(0) <= 31 || character.codePointAt(0) === 127);
}

/** Reads the whole hook payload within a hard deadline, like the production hooks. */
function readBoundedInput(stream, maxBytes, deadlineMs) {
  return new Promise((resolve) => {
    const chunks = [];
    let bytes = 0;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stream.removeAllListeners?.('data');
      stream.removeAllListeners?.('end');
      stream.removeAllListeners?.('error');
      resolve(Buffer.concat(chunks).subarray(0, maxBytes).toString('utf8'));
    };
    const timer = setTimeout(finish, deadlineMs);
    timer.unref?.();
    stream.on('data', (chunk) => {
      bytes += Buffer.byteLength(chunk);
      chunks.push(Buffer.from(chunk));
      if (bytes >= maxBytes) finish();
    });
    stream.once('end', finish);
    stream.once('error', finish);
  });
}

/**
 * Runs one hook observation: reads the bounded stdin payload, maps the event
 * name onto the closed vocabulary, salts the authority namespace fields, and
 * appends one durable hook-observed event. Never throws for missing probe
 * environment or malformed host payloads — a misbehaving hook must not
 * disturb the characterized Host session.
 */
export async function runHookObserver({ stdin = process.stdin } = {}) {
  try {
    const observer = probeObserverFromEnv();
    const raw = await readBoundedInput(stdin, MAX_HOOK_INPUT_BYTES, HOOK_INPUT_DEADLINE_MS);
    let input;
    try { input = JSON.parse(raw); } catch { return; }
    const hook = EVENT_NAMES[input?.hook_event_name];
    if (!hook) return;
    // Salt the authority namespace fields immediately; raw values are never
    // retained or persisted. Absent fields stay null in the closed schema.
    const salt = (value) => (boundedIdentifier(value) ? hashProbeValue(observer.runNonce, value) : null);
    await appendProbeEvent({
      runDirectory: observer.runDirectory,
      runNonce: observer.runNonce,
      event: {
        kind: 'hook-observed',
        hook,
        sessionHash: salt(input.session_id),
        turnHash: salt(input.turn_id),
        agentHash: salt(input.agent_id),
      },
    });
  } catch {
    // Redacted no-op: probe env missing, observer rejected the append, or the
    // payload was malformed. The hook always exits successfully so the
    // characterized Host session continues undisturbed.
  }
}
