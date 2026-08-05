// @ts-nocheck
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, open, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { atomicWriteJson, ensurePrivateDirectory, readJsonFile, withFileLock } from '../../scripts/lib/fs.mjs';
import { resolveWorkspaceStorage } from '../../scripts/lib/workspace.mjs';

const exec = promisify(execFile);
const terminal = new Set(['succeeded', 'failed', 'cancelled']);

async function paths(dataRoot, workspace) {
  const storage = await resolveWorkspaceStorage({ dataRoot, workspace }); const directory = join(storage.directory, 'hook-state');
  await ensurePrivateDirectory(directory); return { ...storage, directory, lock: join(directory, '.lock') };
}
function key(...values) { return createHash('sha256').update(JSON.stringify(values)).digest('hex'); }

export async function fingerprintWorkspace(workspace) {
  const result = await exec('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: workspace, encoding: 'buffer', timeout: 8_000, maxBuffer: 4 * 1024 * 1024, shell: false });
  const diff = await exec('git', ['diff', '--no-ext-diff', '--binary', 'HEAD', '--'], { cwd: workspace, encoding: 'buffer', timeout: 8_000, maxBuffer: 8 * 1024 * 1024, shell: false });
  const hash = createHash('sha256').update(result.stdout).update(diff.stdout); const entries = result.stdout.toString('utf8').split('\0').filter((line) => line.startsWith('?? ')).map((line) => line.slice(3)).sort();
  for (const relative of entries.slice(0, 2000)) { const path = join(workspace, relative); const stat = await lstat(path).catch(() => null); hash.update(relative); if (stat?.isFile() && !stat.isSymbolicLink()) { hash.update(`size:${stat.size}:`); const handle = await open(path, 'r'); try { const sample = Buffer.alloc(Math.min(stat.size, 128 * 1024)); if (sample.length) { await handle.read(sample, 0, sample.length, 0); hash.update(sample); if (stat.size > sample.length) { await handle.read(sample, 0, sample.length, Math.max(0, stat.size - sample.length)); hash.update(sample); } } } finally { await handle.close(); } } else hash.update(`:${stat?.mode ?? 'missing'}:`); }
  hash.update(`count:${entries.length}`); return hash.digest('hex');
}

export async function recordSession(dataRoot, input) {
  const store = await paths(dataRoot, input.cwd); const id = key('session', input.session_id);
  await withFileLock(store.lock, () => atomicWriteJson(join(store.directory, `session-${id}.json`), { kind: 'session', sessionId: input.session_id, workspace: store.workspacePath, createdAt: new Date().toISOString() }));
}
export async function isOwnedSession(dataRoot, input) { const store = await paths(dataRoot, input.cwd); const id = key('session', input.session_id); try { const record = await readJsonFile(join(store.directory, `session-${id}.json`)); return record.kind === 'session' && record.sessionId === input.session_id && record.workspace === store.workspacePath; } catch { return false; } }
export async function markForwarding(dataRoot, input) { const store = await paths(dataRoot, input.cwd); const id = key('forward', input.session_id, input.turn_id); await withFileLock(store.lock, () => atomicWriteJson(join(store.directory, `forward-${id}.json`), { kind: 'forwarding', sessionId: input.session_id, turnId: input.turn_id, agentId: input.agent_id, active: input.hook_event_name === 'SubagentStart', updatedAt: new Date().toISOString() })); }
export async function isForwarding(dataRoot, input) { const store = await paths(dataRoot, input.cwd); const id = key('forward', input.session_id, input.turn_id); try { return (await readJsonFile(join(store.directory, `forward-${id}.json`))).active === true; } catch { return false; } }
export async function cleanupSession(dataRoot, workspace, sessionId) { const store = await paths(dataRoot, workspace); await withFileLock(store.lock, async () => { for (const name of await readdir(store.directory)) { if (!name.endsWith('.json')) continue; const path = join(store.directory, name); try { if ((await readJsonFile(path)).sessionId === sessionId) await unlink(path); } catch { /* bounded advisory cleanup */ } } }); }
export async function unreadJobs(dataRoot, workspace, sessionId) { const store = await paths(dataRoot, workspace); const jobs = join(store.directory, '..', 'jobs'); let names = []; try { names = await readdir(jobs); } catch { return []; } return withFileLock(store.lock, async () => { const markerPath = join(store.directory, `notified-${key('notified', sessionId)}.json`); let marker = { kind: 'notifications', sessionId, jobIds: [] }; try { marker = await readJsonFile(markerPath); } catch (error) { if (error?.cause?.code !== 'ENOENT') throw error; } const seen = new Set(Array.isArray(marker.jobIds) ? marker.jobIds : []); const found = []; for (const name of names.slice(0, 500)) { if (!name.endsWith('.json')) continue; try { const job = await readJsonFile(join(jobs, name)); if (job.ownerSessionId === sessionId && terminal.has(job.status) && !seen.has(job.id)) found.push({ id: job.id, status: job.status }); } catch { /* state command reports corrupt jobs */ } } const selected = found.slice(-5); for (const job of selected) seen.add(job.id); await atomicWriteJson(markerPath, { kind: 'notifications', sessionId, jobIds: [...seen].slice(-500), updatedAt: new Date().toISOString() }); return selected; }); }
export async function writeGateRun(dataRoot, workspace, record) { const store = await paths(dataRoot, workspace); const directory = join(store.directory, '..', 'gate-runs'); await ensurePrivateDirectory(directory); const id = key(record.sessionId, record.turnId, record.before, record.after); const path = join(directory, `${id}.json`); return withFileLock(join(directory, '.lock'), async () => { try { return { duplicate: true, path, record: await readJsonFile(path) }; } catch (error) { if (error?.cause?.code !== 'ENOENT') throw error; } await atomicWriteJson(path, record); return { duplicate: false, path, record }; }); }
export async function finishGateRun(path, record) { await atomicWriteJson(path, record); }
