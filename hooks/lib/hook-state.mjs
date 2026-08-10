// @ts-nocheck
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, open, readlink, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { atomicWriteJson, ensurePrivateDirectory, readJsonFile, withFileLock } from '../../scripts/lib/fs.mjs';
import { PluginError } from '../../scripts/lib/errors.mjs';
import { resolveWorkspaceStorage } from '../../scripts/lib/workspace.mjs';

const exec = promisify(execFile);
const terminal = new Set(['succeeded', 'failed', 'cancelled']);
const MAX_UNTRACKED_FILES = 10_000;
const MAX_UNTRACKED_BYTES = 256 * 1024 * 1024;
const MAX_SYMLINK_TARGET_BYTES = 64 * 1024;

async function paths(dataRoot, workspace) {
  const storage = await resolveWorkspaceStorage({ dataRoot, workspace }); const directory = join(storage.directory, 'hook-state');
  await ensurePrivateDirectory(directory); return { ...storage, directory, lock: join(directory, '.lock') };
}
function key(...values) { return createHash('sha256').update(JSON.stringify(values)).digest('hex'); }

export async function fingerprintWorkspace(workspace) {
  const result = await exec('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: workspace, encoding: 'buffer', timeout: 8_000, maxBuffer: 4 * 1024 * 1024, shell: false });
  let hasHead = true; try { await exec('git', ['rev-parse', '--verify', 'HEAD'], { cwd: workspace, timeout: 2_000, maxBuffer: 64 * 1024, shell: false }); } catch { hasHead = false; }
  const diffArgs = hasHead ? [['diff', '--no-ext-diff', '--binary', 'HEAD', '--']] : [['diff', '--no-ext-diff', '--binary', '--cached', '--'], ['diff', '--no-ext-diff', '--binary', '--']];
  const diffs = await Promise.all(diffArgs.map((args) => exec('git', args, { cwd: workspace, encoding: 'buffer', timeout: 8_000, maxBuffer: 8 * 1024 * 1024, shell: false })));
  const hash = createHash('sha256').update(result.stdout); for (const diff of diffs) hash.update(diff.stdout); const entries = result.stdout.toString('utf8').split('\0').filter((line) => line.startsWith('?? ')).map((line) => line.slice(3)).sort();
  if (entries.length > MAX_UNTRACKED_FILES) throw new Error('Git fingerprint exceeded the untracked file limit.'); let totalBytes = 0;
  for (const relative of entries) { const path = join(workspace, relative); const stat = await lstat(path).catch(() => null); hash.update(JSON.stringify(relative)); if (stat?.isSymbolicLink()) { let target; try { target = await readlink(path, { encoding: 'buffer' }); } catch (error) { hash.update(`symlink-unreadable:${error?.code ?? 'unknown'}:`); continue; } if (target.length > MAX_SYMLINK_TARGET_BYTES) throw new Error('Git fingerprint exceeded the symlink target limit.'); totalBytes += target.length; if (totalBytes > MAX_UNTRACKED_BYTES) throw new Error('Git fingerprint exceeded the untracked byte limit.'); hash.update(`symlink:${stat.mode}:${target.length}:`).update(target); } else if (stat?.isFile()) { totalBytes += stat.size; if (totalBytes > MAX_UNTRACKED_BYTES) throw new Error('Git fingerprint exceeded the untracked byte limit.'); hash.update(`size:${stat.size}:`); const handle = await open(path, 'r'); try { const buffer = Buffer.alloc(64 * 1024); let position = 0; while (true) { const { bytesRead } = await handle.read(buffer, 0, buffer.length, position); if (!bytesRead) break; position += bytesRead; hash.update(buffer.subarray(0, bytesRead)); if (position > stat.size || totalBytes - stat.size + position > MAX_UNTRACKED_BYTES) throw new Error('Git fingerprint changed beyond its byte limit.'); } } finally { await handle.close(); } } else hash.update(`:${stat?.mode ?? 'missing'}:`); }
  hash.update(`count:${entries.length}`); return hash.digest('hex');
}

export async function recordSession(dataRoot, input) {
  const store = await paths(dataRoot, input.cwd); const id = key('session', input.session_id);
  const recordPath = join(store.directory, `session-${id}.json`); const source = input.source ?? 'startup';
  await withFileLock(store.lock, async () => {
    if (source === 'compact') {
      try {
        const existing = await readJsonFile(recordPath);
        if (existing.kind === 'session' && existing.sessionId === input.session_id && existing.workspace === store.workspacePath
          && ['startup', 'resume', 'clear'].includes(existing.source) && Number.isFinite(Date.parse(existing.createdAt))) return;
      } catch (error) { if (error?.cause?.code !== 'ENOENT') throw error; }
    }
    await atomicWriteJson(recordPath, { kind: 'session', sessionId: input.session_id, workspace: store.workspacePath, source, createdAt: new Date().toISOString() });
  });
}
export async function resolveRecordedSessionStart(dataRoot, workspace, sessionId) {
  const store = await paths(dataRoot, workspace); const id = key('session', sessionId);
  try {
    const record = await readJsonFile(join(store.directory, `session-${id}.json`));
    if (record.kind !== 'session' || record.sessionId !== sessionId || record.workspace !== store.workspacePath
      || !['startup', 'resume', 'clear'].includes(record.source) || !Number.isFinite(Date.parse(record.createdAt))) throw new Error('invalid session record');
    return { startedAt: record.createdAt, source: record.source };
  } catch (cause) {
    throw Object.assign(new Error('Setup could not prove the active Codex SessionStart record.'), {
      code: 'SETUP_SESSION_UNPROVEN', category: 'authorization', remedy: 'Restart Codex, then run $zcode:setup from one active session.', cause,
    });
  }
}
export async function isOwnedSession(dataRoot, input) { const store = await paths(dataRoot, input.cwd); const id = key('session', input.session_id); try { const record = await readJsonFile(join(store.directory, `session-${id}.json`)); return record.kind === 'session' && record.sessionId === input.session_id && record.workspace === store.workspacePath; } catch { return false; } }
export async function markForwarding(dataRoot, input) {
  const store = await paths(dataRoot, input.cwd); const id = key('forward', input.session_id, input.turn_id); const executorPath = join(store.directory, `executor-${key('executor', input.agent_id)}.json`); const active = input.hook_event_name === 'SubagentStart';
  await withFileLock(store.lock, async () => {
    await atomicWriteJson(join(store.directory, `forward-${id}.json`), { kind: 'forwarding', sessionId: input.session_id, turnId: input.turn_id, agentId: input.agent_id, active, updatedAt: new Date().toISOString() });
    if (active) await atomicWriteJson(executorPath, { kind: 'subagent-executor', agentId: input.agent_id, agentType: input.agent_type, parentSessionId: input.session_id, childTurnId: input.turn_id, workspace: store.workspacePath, active: true, updatedAt: new Date().toISOString() });
    else {
      let current; try { current = await readJsonFile(executorPath); } catch (error) { if (error?.cause?.code === 'ENOENT') return; throw error; }
      if (validExecutorRecord(current, store.workspacePath) && current.agentId === input.agent_id && current.parentSessionId === input.session_id && current.childTurnId === input.turn_id) await atomicWriteJson(executorPath, { ...current, active: false, updatedAt: new Date().toISOString() });
    }
  });
}
export async function resolveForwardingExecutor(dataRoot, workspace, agentId) {
  const store = await paths(dataRoot, workspace); const canonicalName = `executor-${key('executor', agentId)}.json`;
  return withFileLock(store.lock, async () => {
    const names = (await readdir(store.directory)).filter((name) => name.startsWith('executor-') && name.endsWith('.json'));
    if (names.length > 1_024) throw executorError('EXECUTOR_IDENTITY_AMBIGUOUS', 'Too many private subagent executor records exist.');
    const matches = [];
    for (const name of names) {
      let record; try { record = await readJsonFile(join(store.directory, name)); } catch (error) { if (name === canonicalName) throw executorError('EXECUTOR_IDENTITY_INVALID', 'The private subagent executor record is invalid.', error); continue; }
      if (record?.agentId !== agentId) continue;
      if (name !== canonicalName) throw executorError('EXECUTOR_IDENTITY_AMBIGUOUS', 'More than one private executor record claims this child identity.');
      if (!validExecutorRecord(record, store.workspacePath)) throw executorError('EXECUTOR_IDENTITY_INVALID', 'The private subagent executor record is invalid.');
      matches.push(record);
    }
    if (matches.length === 0 || matches[0].active !== true) throw executorError('EXECUTOR_IDENTITY_NOT_FOUND', 'No active trusted SubagentStart record matches this executor.');
    if (matches.length !== 1) throw executorError('EXECUTOR_IDENTITY_AMBIGUOUS', 'More than one trusted SubagentStart record matches this executor.');
    return matches[0];
  });
}
export async function isForwarding(dataRoot, input) { const store = await paths(dataRoot, input.cwd); const id = key('forward', input.session_id, input.turn_id); try { return (await readJsonFile(join(store.directory, `forward-${id}.json`))).active === true; } catch { return false; } }
export async function cleanupSession(dataRoot, workspace, sessionId) { const store = await paths(dataRoot, workspace); await withFileLock(store.lock, async () => { for (const name of await readdir(store.directory)) { if (!name.endsWith('.json')) continue; const path = join(store.directory, name); try { const record = await readJsonFile(path); if (record.sessionId === sessionId || (record.kind === 'subagent-executor' && record.parentSessionId === sessionId)) await unlink(path); } catch { /* bounded advisory cleanup */ } } }); }
export async function unreadJobs(dataRoot, workspace, sessionId) { const store = await paths(dataRoot, workspace); const jobs = join(store.directory, '..', 'jobs'); let names = []; try { names = await readdir(jobs); } catch { return []; } return withFileLock(store.lock, async () => { const markerPath = join(store.directory, `notified-${key('notified', sessionId)}.json`); let marker = { kind: 'notifications', sessionId, jobIds: [] }; try { marker = await readJsonFile(markerPath); } catch (error) { if (error?.cause?.code !== 'ENOENT') throw error; } const seen = new Set(Array.isArray(marker.jobIds) ? marker.jobIds : []); const found = []; for (const name of names.slice(0, 500)) { if (!name.endsWith('.json')) continue; try { const job = await readJsonFile(join(jobs, name)); if (job.ownerSessionId === sessionId && terminal.has(job.status) && !seen.has(job.id)) found.push({ id: job.id, status: job.status }); } catch { /* state command reports corrupt jobs */ } } const selected = found.slice(-5); for (const job of selected) seen.add(job.id); await atomicWriteJson(markerPath, { kind: 'notifications', sessionId, jobIds: [...seen].slice(-500), updatedAt: new Date().toISOString() }); return selected; }); }
export async function writeGateRun(dataRoot, workspace, record) { const store = await paths(dataRoot, workspace); const directory = join(store.directory, '..', 'gate-runs'); await ensurePrivateDirectory(directory); const id = key(record.sessionId, record.turnId, record.before, record.after); const path = join(directory, `${id}.json`); return withFileLock(join(directory, '.lock'), async () => { try { return { duplicate: true, path, record: await readJsonFile(path) }; } catch (error) { if (error?.cause?.code !== 'ENOENT') throw error; } await atomicWriteJson(path, record); return { duplicate: false, path, record }; }); }
export async function finishGateRun(path, record) { await atomicWriteJson(path, record); }
function validExecutorRecord(record, workspace) { return record?.kind === 'subagent-executor' && typeof record.agentId === 'string' && record.agentId.length > 0 && typeof record.agentType === 'string' && record.agentType.length > 0 && typeof record.parentSessionId === 'string' && record.parentSessionId.length > 0 && typeof record.childTurnId === 'string' && record.childTurnId.length > 0 && record.workspace === workspace && typeof record.active === 'boolean' && Number.isFinite(Date.parse(record.updatedAt)); }
function executorError(code, message, cause) { return new PluginError(code, message, { category: 'authorization', remedy: 'Retry from the original parent thread after the Rescue child is active.', cause }); }
