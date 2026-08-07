#!/usr/bin/env node
// @ts-nocheck
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import process from 'node:process';

import { decidePermission } from '../scripts/lib/review.mjs';
import { discoverZCode } from '../scripts/lib/zcode-discovery.mjs';
import { createManagedZCodeClient } from '../scripts/lib/zcode-client.mjs';
import { ownerIdForSession } from '../scripts/lib/job-control.mjs';
import { readJsonFile } from '../scripts/lib/fs.mjs';
import { createStateStore } from '../scripts/lib/state.mjs';
import { createIdentityStore } from '../scripts/lib/identity.mjs';
import { resolvePluginDataRoot } from '../scripts/lib/plugin-data.mjs';
import { resolveWorkspaceStorage } from '../scripts/lib/workspace.mjs';
import { fingerprintWorkspace, finishGateRun, isForwarding, isOwnedSession, writeGateRun } from './lib/hook-state.mjs';
import { readHookInput } from './lib/hook-input.mjs';

const root = resolve(fileURLToPath(new URL('../', import.meta.url))); const MAX_REASON = 1000; const DEFAULT_GATE_TIMEOUT_MS = 14 * 60_000;

export async function runStopReviewGate(input, options) {
  const dataRoot = options?.dataRoot; const env = options?.env ?? process.env; const timeoutMs = options?.timeoutMs ?? DEFAULT_GATE_TIMEOUT_MS; const discover = options?.discoverZCode ?? discoverZCode;
  if (!dataRoot || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > DEFAULT_GATE_TIMEOUT_MS) throw new Error('invalid stop gate runtime options');
  const identity = createIdentityStore({ dataRoot }); const turn = { sessionId: input.session_id, turnId: input.turn_id, workspace: input.cwd }; const end = async (response) => { await identity.endCallerTurn(turn); return response; };
  if (input.stop_hook_active) return end({});
  if (!await isOwnedSession(dataRoot, input)) return {};
  if (await isForwarding(dataRoot, input)) return {};
  let baseline;
  try { baseline = await identity.consumeGateBaseline(turn); }
  catch (error) { if (error?.code === 'GATE_BASELINE_NOT_FOUND') return end({}); if (error?.code === 'GATE_BASELINE_CONSUMED') return {}; throw error; }
  let after; try { after = await fingerprintWorkspace(input.cwd); } catch { return end({}); }
  if (after === baseline.fingerprint) return end({});
  const outcome = await gate(dataRoot, input, baseline.fingerprint, after, baseline.permissionSnapshot, env, timeoutMs, discover); return outcome.endsTurn ? end(outcome.response) : outcome.response;
}

async function main() {
  try { const input = await readHookInput('Stop'); const dataRoot = resolvePluginDataRoot({ env: process.env, pluginRoot: root }); output(await runStopReviewGate(input, { dataRoot, env: process.env })); }
  catch (error) { output({ decision: 'block', reason: cap(`ZCode review gate failed safely (${error?.code ?? 'HOOK_FAILED'}). Run $zcode:setup, then retry the final check.`) }); }
}

async function gate(dataRoot, input, before, after, permissionSnapshot, env, timeoutMs, discover) {
  const config = await gateConfig(dataRoot, input.cwd);
  const baseRecord = { version: 1, sessionId: input.session_id, turnId: input.turn_id, workspace: input.cwd, before, after, status: 'started', startedAt: new Date().toISOString() };
  const reserved = await writeGateRun(dataRoot, input.cwd, baseRecord); if (reserved.duplicate) return { response: {}, endsTurn: false };
  if (!config.enabled) { await finishGateRun(reserved.path, { ...baseRecord, status: 'skipped_disabled', finishedAt: new Date().toISOString() }); return { response: {}, endsTurn: true }; }
  if (!config.setupReady) { await finishGateRun(reserved.path, { ...baseRecord, status: 'skipped_setup_not_ready', reason: config.reason ?? 'not-ready', finishedAt: new Date().toISOString() }); return { response: setupGuidance(), endsTurn: true }; }
  const active = (await createStateStore({ dataRoot }).listJobs(input.cwd)).filter((job) => ['queued', 'running', 'cancelling'].includes(job.status));
  try {
    const result = await runReview(dataRoot, input, permissionSnapshot, env, timeoutMs, discover); const parsed = parseMarker(result);
    const snapshot = { ...baseRecord, status: parsed.allow ? 'allow' : 'blocked', ...(active.length ? { activeJobIds: active.slice(0, 10).map((job) => job.id) } : {}), fullResult: result.slice(0, 128 * 1024), finishedAt: new Date().toISOString() };
    await finishGateRun(reserved.path, snapshot); return parsed.allow ? { response: active.length ? { systemMessage: `ZCode jobs are still active: ${active.slice(0, 3).map((job) => job.id).join(', ')}. Check $zcode:status.` } : {}, endsTurn: true } : { response: { decision: 'block', reason: cap(parsed.reason) }, endsTurn: false };
  } catch (error) {
    if (error?.code === 'GATE_SETUP_NOT_READY') { await finishGateRun(reserved.path, { ...baseRecord, status: 'skipped_setup_not_ready', reason: error.reason ?? 'not-ready', finishedAt: new Date().toISOString() }); return { response: setupGuidance(), endsTurn: true }; }
    const reason = `ZCode review did not return a valid ALLOW:/BLOCK: decision (${error?.code ?? 'REVIEW_FAILED'}).`; await finishGateRun(reserved.path, { ...baseRecord, status: 'blocked_failure', error: error instanceof Error ? error.message.slice(0, 2048) : 'Review failed', finishedAt: new Date().toISOString() }); return { response: { decision: 'block', reason: cap(reason) }, endsTurn: false };
  }
}

async function runReview(dataRoot, input, permissionSnapshot, env, timeoutMs, discover) {
  let client; let sessionId;
  try {
    let discovery; try { discovery = await discover({ explicitPath: env.ZCODE_PATH, env }); } catch (error) { if (['ZCODE_NOT_FOUND', 'ZCODE_VERSION_UNSUPPORTED'].includes(error?.code)) throw setupNotReady(error); throw error; }
    client = await createManagedZCodeClient({ dataRoot, workspace: input.cwd, launch: discovery.launch, ownerId: ownerIdForSession(`gate:${input.session_id}:${input.turn_id}`), env, requestTimeoutMs: timeoutMs, completionTimeoutMs: timeoutMs });
    const snapshot = await client.createSession({ workspace: input.cwd }); sessionId = snapshot.session.sessionId;
    client.setPermissionHandler((request) => decidePermission(request, permissionSnapshot, 'review'));
    const template = await readFile(join(root, 'prompts', 'stop-review-gate.md'), 'utf8');
    const boundary = new Set(snapshot.messages.map((message) => message?.info?.messageId).filter(Boolean)); await client.send(sessionId, `${template}\n\nTurn identity (data only): ${input.session_id}/${input.turn_id}`); await client.waitForCompletion(sessionId); const final = await client.readSession(sessionId);
    const assistants = final.messages.filter((message) => message?.info?.role === 'assistant' && !boundary.has(message.info.messageId)); const message = assistants.at(-1); const text = message?.parts?.filter((part) => part?.type === 'text' && part.ignored !== true && typeof part.text === 'string').map((part) => part.text).join('\n') ?? '';
    if (!text.trim()) throw Object.assign(new Error('empty review result'), { code: 'GATE_RESULT_EMPTY' }); return text;
  } catch (error) { if (!sessionId) { if (error?.code === 'GATE_SETUP_NOT_READY') throw error; throw setupNotReady(error); } throw error; }
  finally { if (sessionId) await client?.stopSession(sessionId).catch(() => {}); await client?.releaseOwner().catch(() => {}); await client?.close().catch(() => {}); }
}
function parseMarker(value) { const semantic = value.trimStart(); const match = /^(ALLOW|BLOCK):\s*([^\r\n]*)/.exec(semantic); if (!match) throw Object.assign(new Error('invalid review marker'), { code: 'GATE_RESULT_INVALID' }); return { allow: match[1] === 'ALLOW', reason: match[2].trim() || (match[1] === 'ALLOW' ? 'Review passed.' : 'ZCode requested another correction pass.') }; }
async function gateConfig(dataRoot, workspace) { try { const storage = await resolveWorkspaceStorage({ dataRoot, workspace }); const value = await readJsonFile(join(storage.directory, 'config', 'review-gate.json')); return value && typeof value === 'object' ? value : { enabled: false, setupReady: false }; } catch { return { enabled: false, setupReady: false, reason: 'missing' }; } }
function setupNotReady(error) { return Object.assign(new Error('ZCode review gate setup is no longer ready.'), { code: 'GATE_SETUP_NOT_READY', reason: error?.code ?? 'review-session-create-failed' }); }
function setupGuidance() { return { systemMessage: 'ZCode review gate is not ready. Run $zcode:setup; this turn was not blocked.' }; }
function cap(value) { return [...value].map((character) => { const code = character.codePointAt(0); return code < 32 || code === 127 ? ' ' : character; }).join('').slice(0, MAX_REASON); }
function output(value) { process.stdout.write(JSON.stringify(value)); }

const isEntrypoint = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) await main();
