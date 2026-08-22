// @ts-nocheck
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, open, readlink, readdir, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { atomicWriteJson, ensurePrivateDirectory, readBoundedJsonFile, readJsonFile, readPrivateDirectory, withFileLock } from '../../scripts/lib/fs.mjs';
import { PluginError } from '../../scripts/lib/errors.mjs';
import { createIdentityStore, PERMISSION_MODES } from '../../scripts/lib/identity.mjs';
import { RESCUE_UNREAD_JOB_LIMIT } from '../../scripts/lib/rescue-launcher-command.mjs';
import { resolveWorkspaceStorage } from '../../scripts/lib/workspace.mjs';

const exec = promisify(execFile);
const terminal = new Set(['succeeded', 'failed', 'cancelled']);
const MAX_UNTRACKED_FILES = 10_000;
const MAX_UNTRACKED_BYTES = 256 * 1024 * 1024;
const MAX_SYMLINK_TARGET_BYTES = 64 * 1024;
const EXECUTOR_LIFETIME_MS = 30 * 60_000;
const MAX_EXECUTOR_BYTES = 16 * 1024;
const MAX_EXECUTOR_ROUTE_BYTES = 16 * 1024;
const MAX_HOOK_STATE_RECORDS = 2_048;
const FORWARDING_PENDING_LIFETIME_MS = 30_000;
const EXECUTOR_KEYS = ['active', 'agentId', 'agentType', 'childTurnId', 'createdAt', 'kind', 'originWorkspace', 'parentGenerationId', 'parentPermissionMode', 'parentSessionId', 'parentTurnId', 'workspace'];
const LEGACY_EXECUTOR_KEYS = ['active', 'agentId', 'agentType', 'childTurnId', 'createdAt', 'kind', 'parentPermissionMode', 'parentSessionId', 'parentTurnId', 'workspace'];
const EXECUTOR_ROUTE_KEYS = ['agentId', 'agentType', 'childTurnId', 'createdAt', 'kind', 'originWorkspace', 'parentGenerationId', 'parentPermissionMode', 'parentSessionId', 'parentTurnId', 'state', 'targetWorkspace', 'updatedAt', 'version'];
const FORWARDING_KEYS = ['active', 'agentId', 'generationId', 'kind', 'sessionId', 'targetWorkspace', 'turnId', 'updatedAt'];
const LEGACY_FORWARDING_KEYS = ['active', 'agentId', 'kind', 'sessionId', 'turnId', 'updatedAt'];

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
export async function markForwarding(dataRoot, input, parentCaller, options = {}) {
  const publicationSeam = options.publicationSeam;
  if (publicationSeam !== undefined && typeof publicationSeam !== 'function') throw executorError('EXECUTOR_ROUTE_INVALID', 'The private executor route publication seam is invalid.');
  const origin = await paths(dataRoot, input.cwd); const id = key('forward', input.session_id, input.turn_id); const active = input.hook_event_name === 'SubagentStart';
  if (active) {
    const generationId = parentCaller?.generationId ?? null;
    const callerOrigin = parentCaller?.originWorkspace ?? parentCaller?.workspace;
    if (parentCaller?.sessionId !== input.session_id || callerOrigin !== origin.workspacePath
      || typeof parentCaller?.workspace !== 'string') throw executorError('EXECUTOR_PARENT_TURN_MISMATCH', 'SubagentStart is not linked to the exact active parent turn.');
    const target = await paths(dataRoot, parentCaller.workspace); const createdAt = new Date().toISOString();
    let route = { version: 1, kind: 'executor-route', agentId: input.agent_id, agentType: input.agent_type, parentSessionId: input.session_id, parentGenerationId: generationId, parentTurnId: parentCaller.turnId, parentPermissionMode: parentCaller.permissionMode, childTurnId: input.turn_id, originWorkspace: origin.workspacePath, targetWorkspace: target.workspacePath, state: 'pending', createdAt, updatedAt: createdAt };
    await withFileLock(origin.lock, async () => {
      const existing = await readExecutorRoute(routePath(origin, input.session_id, input.turn_id), origin.directory).catch((error) => error?.code === 'ENOENT' || error?.cause?.code === 'ENOENT' ? null : Promise.reject(error));
      if (existing !== null) {
        if (!validExecutorRoute(existing, origin.workspacePath, input) || existing.parentGenerationId !== generationId || existing.parentTurnId !== parentCaller.turnId || existing.parentPermissionMode !== parentCaller.permissionMode || existing.targetWorkspace !== target.workspacePath) throw executorError('EXECUTOR_ROUTE_INVALID', 'SubagentStart found a conflicting exact executor route.');
        if (existing.state === 'stopped') throw executorError('EXECUTOR_ROUTE_INVALID', 'SubagentStart cannot replay an exact stopped executor route.');
        route = existing;
        if (route.state === 'pending') {
          const updatedAt = new Date().toISOString(); route = { ...route, updatedAt };
          await atomicWriteJson(routePath(origin, input.session_id, input.turn_id), route);
          await atomicWriteJson(join(origin.directory, `forward-${id}.json`), { kind: 'forwarding', sessionId: input.session_id, generationId, turnId: input.turn_id, agentId: input.agent_id, active: true, targetWorkspace: target.workspacePath, updatedAt });
        }
      } else {
        await atomicWriteJson(join(origin.directory, `forward-${id}.json`), { kind: 'forwarding', sessionId: input.session_id, generationId, turnId: input.turn_id, agentId: input.agent_id, active: true, targetWorkspace: target.workspacePath, updatedAt: createdAt });
        await atomicWriteJson(routePath(origin, input.session_id, input.turn_id), route);
      }
    });
    await publicationSeam?.('after-route-pending');
    const executor = { kind: 'subagent-executor', agentId: input.agent_id, agentType: input.agent_type, parentSessionId: input.session_id, parentGenerationId: generationId, parentTurnId: parentCaller.turnId, parentPermissionMode: parentCaller.permissionMode, childTurnId: input.turn_id, originWorkspace: origin.workspacePath, workspace: target.workspacePath, active: true, createdAt: route.createdAt };
    let finalState = 'failed'; let finalError = null;
    try {
      await withFileLock(target.lock, async () => {
        await atomicWriteJson(join(target.directory, `executor-${key('executor', input.agent_id)}.json`), executor);
        await publicationSeam?.('after-executor-persisted');
      });
      await publicationSeam?.('after-executor-write');
      await withFileLock(origin.lock, async () => {
        let current;
        try { current = await readExecutorRoute(routePath(origin, input.session_id, input.turn_id), origin.directory); }
        catch (cause) { throw executorError('EXECUTOR_ROUTE_INVALID', 'SubagentStart could not finalize its exact executor route.', cause); }
        const exactRoute = validExecutorRoute(current, origin.workspacePath, input) && current.parentGenerationId === generationId
          && current.parentTurnId === parentCaller.turnId && current.parentPermissionMode === parentCaller.permissionMode && current.targetWorkspace === target.workspacePath;
        if (!exactRoute) { finalError = executorError('EXECUTOR_ROUTE_INVALID', 'SubagentStart lost its exact executor route.'); return; }
        const authority = await routeAuthorityExists(dataRoot, origin.workspacePath, current);
        if (!authority) {
          const updatedAt = new Date().toISOString();
          await atomicWriteJson(routePath(origin, input.session_id, input.turn_id), { ...current, state: 'stopped', updatedAt });
          await atomicWriteJson(join(origin.directory, `forward-${id}.json`), { kind: 'forwarding', sessionId: input.session_id, generationId, turnId: input.turn_id, agentId: input.agent_id, active: false, targetWorkspace: target.workspacePath, updatedAt });
          finalState = 'stopped'; finalError = executorError('EXECUTOR_PARENT_TURN_MISMATCH', 'SubagentStart parent authority ended before executor publication.'); return;
        }
        if (current.state === 'pending') {
          const updatedAt = new Date().toISOString();
          await atomicWriteJson(routePath(origin, input.session_id, input.turn_id), { ...current, state: 'active', updatedAt });
          await atomicWriteJson(join(origin.directory, `forward-${id}.json`), { kind: 'forwarding', sessionId: input.session_id, generationId, turnId: input.turn_id, agentId: input.agent_id, active: true, targetWorkspace: target.workspacePath, updatedAt });
          finalState = 'active'; return;
        }
        finalState = current.state;
      });
    } catch (error) {
      finalError = error instanceof PluginError && `${error.code}`.startsWith('EXECUTOR_')
        ? error : executorError('EXECUTOR_ROUTE_INVALID', 'SubagentStart could not finalize its exact executor route.', error);
    } finally {
      if (finalState !== 'active') await deactivateExactExecutor(target, input.agent_id, route);
    }
    if (finalError !== null) throw finalError;
    return;
  }

  let route;
  await withFileLock(origin.lock, async () => {
    route = await readExecutorRoute(routePath(origin, input.session_id, input.turn_id), origin.directory).catch((error) => {
      if (error?.code === 'ENOENT' || error?.cause?.code === 'ENOENT') return null;
      throw executorError('EXECUTOR_ROUTE_INVALID', 'SubagentStop found an invalid exact executor route.', error);
    });
    if (route !== null && !validExecutorRoute(route, origin.workspacePath, input)) throw executorError('EXECUTOR_ROUTE_INVALID', 'SubagentStop found an invalid exact executor route.');
    const updatedAt = new Date().toISOString();
    if (route !== null && route.state !== 'stopped') { route = { ...route, state: 'stopped', updatedAt }; await atomicWriteJson(routePath(origin, input.session_id, input.turn_id), route); }
    await atomicWriteJson(join(origin.directory, `forward-${id}.json`), { kind: 'forwarding', sessionId: input.session_id, generationId: route?.parentGenerationId ?? null, turnId: input.turn_id, agentId: input.agent_id, active: false, targetWorkspace: route?.targetWorkspace ?? origin.workspacePath, updatedAt });
  });
  const target = route === null ? origin : await paths(dataRoot, route.targetWorkspace);
  const executorPath = join(target.directory, `executor-${key('executor', input.agent_id)}.json`);
  await withFileLock(target.lock, async () => {
    let current; try { current = await readBoundedExecutor(executorPath); } catch (error) { if (error?.code === 'ENOENT') return; throw error; }
    if (!validExecutorRecord(current, target.workspacePath)) throw executorError('EXECUTOR_IDENTITY_INVALID', 'SubagentStop found an invalid exact executor record.');
    if (route === null && (!isLegacyExecutorRecord(current, target.workspacePath)
      || !await legacyExecutorAuthorityExists(dataRoot, target.workspacePath, current))) throw executorError('EXECUTOR_ROUTE_INVALID', 'SubagentStop requires the exact executor route for this executor.');
    if (current.agentId === input.agent_id && current.parentSessionId === input.session_id && current.childTurnId === input.turn_id && current.agentType === input.agent_type
      && (route === null || executorMatchesRoute(current, route))) await atomicWriteJson(executorPath, { ...current, active: false });
  });
}

export async function resolveForwardingRoute(dataRoot, originWorkspace, sessionId, childTurnId) {
  const origin = await paths(dataRoot, originWorkspace);
  return withFileLock(origin.lock, async () => {
    let route;
    try { route = await readExecutorRoute(routePath(origin, sessionId, childTurnId), origin.directory); }
    catch (error) { throw executorError(error?.code === 'ENOENT' || error?.cause?.code === 'ENOENT' ? 'EXECUTOR_ROUTE_NOT_FOUND' : 'EXECUTOR_ROUTE_INVALID', 'No exact trusted executor route matches this child.', error); }
    if (!validExecutorRoute(route, origin.workspacePath) || route.parentSessionId !== sessionId || route.childTurnId !== childTurnId) throw executorError('EXECUTOR_ROUTE_INVALID', 'The private executor route is invalid.');
    return { ...route };
  });
}
export async function resolveForwardingExecutor(dataRoot, workspace, agentId, options = {}) {
  const store = await paths(dataRoot, workspace); const canonicalName = `executor-${key('executor', agentId)}.json`;
  const selected = await withFileLock(store.lock, async () => {
    let entries; try { entries = await readPrivateDirectory(store.directory, store.directory, MAX_HOOK_STATE_RECORDS); } catch (error) { throw executorError('EXECUTOR_IDENTITY_AMBIGUOUS', 'Too many private subagent executor records exist.', error); }
    const names = entries.filter((entry) => entry.isFile() && entry.name.startsWith('executor-') && entry.name.endsWith('.json')).map((entry) => entry.name);
    if (names.length > 1_024) throw executorError('EXECUTOR_IDENTITY_AMBIGUOUS', 'Too many private subagent executor records exist.');
    const matches = [];
    for (const name of names) {
      let record; try { record = await readBoundedExecutor(join(store.directory, name)); } catch (error) { throw executorError('EXECUTOR_IDENTITY_INVALID', 'A private subagent executor record is invalid.', error); }
      if (!validExecutorRecord(record, store.workspacePath)) throw executorError('EXECUTOR_IDENTITY_INVALID', 'A private subagent executor record is invalid.');
      if (name === canonicalName) { if (!validExecutorRecord(record, store.workspacePath) || record.agentId !== agentId) throw executorError('EXECUTOR_IDENTITY_INVALID', 'The private subagent executor record is invalid.'); matches.push(record); continue; }
      if (record?.agentId === agentId) throw executorError('EXECUTOR_IDENTITY_AMBIGUOUS', 'More than one private executor record claims this child identity.');
    }
    if (matches.length === 0) throw executorError('EXECUTOR_IDENTITY_NOT_FOUND', 'No trusted SubagentStart record matches this executor.');
    if (matches.length !== 1) throw executorError('EXECUTOR_IDENTITY_AMBIGUOUS', 'More than one trusted SubagentStart record matches this executor.');
    const selected = matches[0];
    if (!['zcode-rescue', 'default'].includes(selected.agentType)) throw executorError('EXECUTOR_ROLE_UNAPPROVED', 'Only the installed zcode-rescue Role or the qualified 0.147 default compatibility route may execute Rescue.');
    const timestamp = options.now === undefined ? Date.now() : new Date(options.now).getTime();
    const selectedAge = timestamp - Date.parse(selected.createdAt);
    if (!Number.isFinite(timestamp) || selectedAge < 0) throw executorError('EXECUTOR_IDENTITY_INVALID', 'The trusted child executor record has a future creation time.');
    if (selectedAge >= EXECUTOR_LIFETIME_MS && options.durableProvenance !== true) throw executorError('EXECUTOR_IDENTITY_EXPIRED', 'The trusted child executor record has expired.');
    if (options.continuation === true) {
      if (selected.active !== false) throw executorError('EXECUTOR_STATE_MISMATCH', 'A pending Rescue choice requires the original child to be stopped.');
      return selected;
    }
    if (options.durableProvenance === true) throw executorError('EXECUTOR_STATE_MISMATCH', 'Durable Rescue provenance is restricted to a stopped executor.');
    if (selected.active !== true) throw executorError('EXECUTOR_IDENTITY_NOT_FOUND', 'No active trusted SubagentStart record matches this executor.');
    const candidates = [];
    for (const name of names) {
      let record; try { record = await readBoundedExecutor(join(store.directory, name)); } catch { continue; }
      const age = timestamp - Date.parse(record.createdAt);
      if (validExecutorRecord(record, store.workspacePath) && record.active && ['zcode-rescue', 'default'].includes(record.agentType) && record.parentSessionId === selected.parentSessionId && record.parentTurnId === selected.parentTurnId && record.parentGenerationId === selected.parentGenerationId) {
        if (age < 0) throw executorError('EXECUTOR_IDENTITY_INVALID', 'A same-turn Rescue executor record has a future creation time.');
        if (age < EXECUTOR_LIFETIME_MS) candidates.push(record);
      }
    }
    if (candidates.length !== 1) throw executorError('EXECUTOR_IDENTITY_AMBIGUOUS', 'The parent turn does not have exactly one active Rescue executor.');
    return selected;
  });
  if (isLegacyExecutorRecord(selected, store.workspacePath)) {
    if (!await legacyExecutorAuthorityExists(dataRoot, store.workspacePath, selected)) throw executorError('EXECUTOR_ROUTE_INVALID', 'Legacy executor routing is unavailable while lifecycle authority exists.');
    return selected;
  }
  const route = await resolveForwardingRoute(dataRoot, selected.originWorkspace, selected.parentSessionId, selected.childTurnId);
  if (!executorMatchesRoute(selected, route)) throw executorError('EXECUTOR_ROUTE_INVALID', 'The private executor route does not match this executor.');
  if (selected.active && route.state !== 'active' || !selected.active && route.state !== 'stopped') throw executorError('EXECUTOR_ROUTE_INVALID', 'The private executor route state does not match this executor.');
  return selected;
}
export async function isForwarding(dataRoot, input, options = {}) {
  const origin = await paths(dataRoot, input.cwd); const id = key('forward', input.session_id, input.turn_id);
  try {
    const snapshot = await withFileLock(origin.lock, async () => {
      const marker = await readBoundedJsonFile(origin.directory, join(origin.directory, `forward-${id}.json`), MAX_EXECUTOR_ROUTE_BYTES);
      if (marker.active !== true) return { kind: 'not-forwarding' };
      let route;
      try { route = await readExecutorRoute(routePath(origin, input.session_id, input.turn_id), origin.directory); }
      catch (error) {
        if (error?.code !== 'ENOENT' && error?.cause?.code !== 'ENOENT') throw error;
        return validLegacyForwarding(marker, input) ? { kind: 'legacy', marker } : { kind: 'not-forwarding' };
      }
      if (!validExecutorRoute(route, origin.workspacePath) || !validForwarding(marker, route, input) || route.state === 'stopped') return { kind: 'not-forwarding' };
      return { kind: route.state, route };
    });
    if (snapshot.kind === 'not-forwarding') return false;
    if (snapshot.kind === 'legacy') {
      const executor = await readBoundedExecutor(join(origin.directory, `executor-${key('executor', snapshot.marker.agentId)}.json`));
      return isLegacyExecutorRecord(executor, origin.workspacePath) && executor.active === true && executor.parentSessionId === input.session_id && executor.childTurnId === input.turn_id
        && await legacyExecutorAuthorityExists(dataRoot, origin.workspacePath, executor, true);
    }
    if (snapshot.kind === 'pending') {
      const now = options.now === undefined ? Date.now() : new Date(options.now).getTime(); const age = now - Date.parse(snapshot.route.updatedAt);
      return Number.isFinite(now) && age >= 0 && age < FORWARDING_PENDING_LIFETIME_MS
        && await routeAuthorityExists(dataRoot, origin.workspacePath, snapshot.route);
    }
    const target = await paths(dataRoot, snapshot.route.targetWorkspace);
    const executor = await withFileLock(target.lock, () => readBoundedExecutor(join(target.directory, `executor-${key('executor', snapshot.route.agentId)}.json`)));
    return validExecutorRecord(executor, target.workspacePath) && executor.active === true && executorMatchesRoute(executor, snapshot.route);
  } catch { return false; }
}
export async function cleanupSession(dataRoot, workspace, sessionId) {
  const store = await paths(dataRoot, workspace);
  await withFileLock(store.lock, async () => {
    let entries; try { entries = await readPrivateDirectory(store.directory, store.directory, MAX_HOOK_STATE_RECORDS); } catch (error) { throw executorError('HOOK_STATE_CAPACITY', 'Private hook state exceeds its cleanup bound.', error); }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!/^(?:session|forward|route|executor|notified)-[a-f0-9]{64}\.json$/u.test(entry.name)) {
        if (entry.name.startsWith('executor-') && entry.name.endsWith('.json')) await unlink(join(store.directory, entry.name)).catch(() => {});
        continue;
      }
      const path = join(store.directory, entry.name);
      try {
        const record = entry.name.startsWith('executor-')
          ? await readBoundedExecutor(path)
          : entry.name.startsWith('route-') ? await readExecutorRoute(path, store.directory) : await readBoundedJsonFile(store.directory, path, MAX_EXECUTOR_ROUTE_BYTES);
        if (record.sessionId === sessionId || (['subagent-executor', 'executor-route'].includes(record.kind) && record.parentSessionId === sessionId)) await unlink(path);
      } catch (error) {
        if (entry.name.startsWith('executor-')) await unlink(path).catch(() => {});
        else throw executorError('HOOK_STATE_INVALID', 'Private hook state is invalid during exact session cleanup.', error);
      }
    }
  });
}
export async function unreadJobs(dataRoot, workspace, sessionId) { const store = await paths(dataRoot, workspace); const jobs = join(store.directory, '..', 'jobs'); let names = []; try { names = await readdir(jobs); } catch { return []; } return withFileLock(store.lock, async () => { const markerPath = join(store.directory, `notified-${key('notified', sessionId)}.json`); let marker = { kind: 'notifications', sessionId, jobIds: [] }; try { marker = await readJsonFile(markerPath); } catch (error) { if (error?.cause?.code !== 'ENOENT') throw error; } const seen = new Set(Array.isArray(marker.jobIds) ? marker.jobIds : []); const found = []; for (const name of names.slice(0, 500)) { if (!name.endsWith('.json')) continue; try { const job = await readJsonFile(join(jobs, name)); if (job.ownerSessionId === sessionId && terminal.has(job.status) && !seen.has(job.id)) found.push({ id: job.id, status: job.status }); } catch { /* state command reports corrupt jobs */ } } const selected = found.slice(-RESCUE_UNREAD_JOB_LIMIT); for (const job of selected) seen.add(job.id); await atomicWriteJson(markerPath, { kind: 'notifications', sessionId, jobIds: [...seen].slice(-500), updatedAt: new Date().toISOString() }); return selected; }); }
export async function writeGateRun(dataRoot, workspace, record) { const store = await paths(dataRoot, workspace); const directory = join(store.directory, '..', 'gate-runs'); await ensurePrivateDirectory(directory); const id = key(record.sessionId, record.turnId, record.before, record.after); const path = join(directory, `${id}.json`); return withFileLock(join(directory, '.lock'), async () => { try { return { duplicate: true, path, record: await readJsonFile(path) }; } catch (error) { if (error?.cause?.code !== 'ENOENT') throw error; } await atomicWriteJson(path, record); return { duplicate: false, path, record }; }); }
export async function finishGateRun(path, record) { await atomicWriteJson(path, record); }
function validExecutorRecord(record, workspace) { return isCurrentExecutorRecord(record, workspace) || isLegacyExecutorRecord(record, workspace); }
function isCurrentExecutorRecord(record, workspace) { return record && typeof record === 'object' && !Array.isArray(record) && Object.keys(record).sort().join('\0') === [...EXECUTOR_KEYS].sort().join('\0') && record.kind === 'subagent-executor' && [record.agentId, record.agentType, record.parentSessionId, record.parentTurnId, record.childTurnId].every((value) => boundedIdentifier(value)) && (record.parentGenerationId === null || /^[a-f0-9]{64}$/u.test(record.parentGenerationId)) && PERMISSION_MODES.includes(record.parentPermissionMode) && boundedWorkspace(record.originWorkspace) && boundedWorkspace(record.workspace) && record.workspace === workspace && typeof record.active === 'boolean' && canonicalTimestamp(record.createdAt); }
function isLegacyExecutorRecord(record, workspace) { return record && typeof record === 'object' && !Array.isArray(record) && Object.keys(record).sort().join('\0') === [...LEGACY_EXECUTOR_KEYS].sort().join('\0') && record.kind === 'subagent-executor' && [record.agentId, record.agentType, record.parentSessionId, record.parentTurnId, record.childTurnId].every((value) => boundedIdentifier(value)) && PERMISSION_MODES.includes(record.parentPermissionMode) && boundedWorkspace(record.workspace) && record.workspace === workspace && typeof record.active === 'boolean' && canonicalTimestamp(record.createdAt); }
function validExecutorRoute(record, originWorkspace, input) { return record && typeof record === 'object' && !Array.isArray(record) && Object.keys(record).sort().join('\0') === [...EXECUTOR_ROUTE_KEYS].sort().join('\0') && record.version === 1 && record.kind === 'executor-route' && [record.agentId, record.agentType, record.parentSessionId, record.parentTurnId, record.childTurnId].every((value) => boundedIdentifier(value)) && (record.parentGenerationId === null || /^[a-f0-9]{64}$/u.test(record.parentGenerationId)) && PERMISSION_MODES.includes(record.parentPermissionMode) && boundedWorkspace(record.originWorkspace) && record.originWorkspace === originWorkspace && boundedWorkspace(record.targetWorkspace) && ['pending', 'active', 'stopped'].includes(record.state) && canonicalTimestamp(record.createdAt) && canonicalTimestamp(record.updatedAt) && Date.parse(record.updatedAt) >= Date.parse(record.createdAt) && (input === undefined || record.parentSessionId === input.session_id && record.childTurnId === input.turn_id && record.agentId === input.agent_id && record.agentType === input.agent_type); }
function executorMatchesRoute(executor, route) { return executor.agentId === route.agentId && executor.agentType === route.agentType && executor.parentSessionId === route.parentSessionId && executor.parentGenerationId === route.parentGenerationId && executor.parentTurnId === route.parentTurnId && executor.childTurnId === route.childTurnId && executor.originWorkspace === route.originWorkspace && executor.workspace === route.targetWorkspace && executor.createdAt === route.createdAt; }
function validForwarding(record, route, input) { return record && typeof record === 'object' && !Array.isArray(record) && Object.keys(record).sort().join('\0') === [...FORWARDING_KEYS].sort().join('\0') && record.kind === 'forwarding' && record.sessionId === input.session_id && record.turnId === input.turn_id && record.agentId === route.agentId && record.generationId === route.parentGenerationId && record.targetWorkspace === route.targetWorkspace && typeof record.active === 'boolean' && canonicalTimestamp(record.updatedAt); }
function validLegacyForwarding(record, input) { return record && typeof record === 'object' && !Array.isArray(record) && Object.keys(record).sort().join('\0') === [...LEGACY_FORWARDING_KEYS].sort().join('\0') && record.kind === 'forwarding' && record.sessionId === input.session_id && record.turnId === input.turn_id && boundedIdentifier(record.agentId) && typeof record.active === 'boolean' && canonicalTimestamp(record.updatedAt); }
async function legacyExecutorAuthorityExists(dataRoot, workspace, executor, requireTurn = false) { try { const caller = await createIdentityStore({ dataRoot }).resolveActiveTurn({ sessionId: executor.parentSessionId, workspace, workspaceBinding: 'execution' }); return caller.generationId === undefined && (!requireTurn || caller.turnId === executor.parentTurnId); } catch { return false; } }
function routePath(store, sessionId, childTurnId) { return join(store.directory, `route-${key('executor-route', sessionId, childTurnId)}.json`); }
async function readBoundedExecutor(path) { return readBoundedJsonFile(dirname(path), path, MAX_EXECUTOR_BYTES); }
async function readExecutorRoute(path, privateRoot) { return readBoundedJsonFile(privateRoot, path, MAX_EXECUTOR_ROUTE_BYTES); }
async function deactivateExactExecutor(target, agentId, route) {
  try {
    await withFileLock(target.lock, async () => {
      const path = join(target.directory, `executor-${key('executor', agentId)}.json`); let current;
      try { current = await readBoundedExecutor(path); } catch { return; }
      if (validExecutorRecord(current, target.workspacePath) && executorMatchesRoute(current, route) && current.active) await atomicWriteJson(path, { ...current, active: false });
    });
  } catch { /* compensation is best-effort and must not replace the fixed finalization error */ }
}
function boundedIdentifier(value) { return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 512 && ![...value].some((character) => { const code = character.charCodeAt(0); return code <= 31 || code === 127; }); }
function boundedWorkspace(value) { return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 4_096 && ![...value].some((character) => ['\0', '\n', '\r'].includes(character)); }
function canonicalTimestamp(value) { return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) && Number.isFinite(Date.parse(value)); }
function executorError(code, message, cause) { return new PluginError(code, message, { category: 'authorization', remedy: 'Retry from the original parent thread after the Rescue child is active.', cause }); }
async function routeAuthorityExists(dataRoot, workspace, route) {
  try {
    const caller = await createIdentityStore({ dataRoot }).resolveActiveTurn({ sessionId: route.parentSessionId, workspace, workspaceBinding: 'execution' });
    const generationMatches = route.parentGenerationId === null ? caller.generationId === undefined : caller.generationId === route.parentGenerationId;
    const originMatches = route.parentGenerationId === null ? caller.originWorkspace === undefined && caller.workspace === route.originWorkspace : caller.originWorkspace === route.originWorkspace;
    return caller.sessionId === route.parentSessionId && caller.turnId === route.parentTurnId && caller.permissionMode === route.parentPermissionMode
      && caller.workspace === route.targetWorkspace && generationMatches && originMatches;
  } catch { return false; }
}
