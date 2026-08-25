import { createHash } from 'node:crypto';
import { resolve, sep } from 'node:path';

import { readBoundedJsonFile } from './fs.mjs';
import { resolveWorkspaceStorage } from './workspace.mjs';

const LEGACY_KEYS = ['migrationParentSessionId', 'migrationChildAgentId', 'migrationOperationId',
  'migrationPriorCurrentJobId', 'migrationPriorUpdatedAt', 'migrationPriorClosedAt', 'migrationPriorVersion'];
const LEGACY_OUTER_KEYS = ['digest', 'jobId', 'ownerSessionId', 'spec', 'version', 'workspace'];

/** Parse one exact pre-sealed job-spec outer record. @param {any} record @param {any} job @param {()=>Error} invalid */
export function parseExactLegacyJobSpecRecord(record, job, invalid) {
  if (!record || typeof record !== 'object' || Array.isArray(record)
    || Object.keys(record).sort().join(',') !== LEGACY_OUTER_KEYS.join(',')
    || record.version !== 1 || record.jobId !== job.id || record.ownerSessionId !== job.ownerSessionId
    || record.workspace !== job.workspace || !record.spec || typeof record.spec !== 'object' || Array.isArray(record.spec)) throw invalid();
  const digest = createHash('sha256').update(JSON.stringify(record.spec, Object.keys(record.spec).sort())).digest('hex');
  if (record.digest !== digest) throw invalid();
  return record.spec;
}

/** Parse the exact rollback fields emitted by the pre-marker job-spec format. @param {any} spec @param {any} job @param {()=>Error} invalid */
export function legacyRescueMigrationRollbackFromSpec(spec, job, invalid) {
  const present = LEGACY_KEYS.filter((key) => spec?.[key] !== undefined);
  if (present.length === 0) return undefined;
  const priorVersion = Number(spec?.migrationPriorVersion);
  if (present.length !== LEGACY_KEYS.length || spec.migrationParentSessionId !== job.ownerSessionId
    || job.command !== 'rescue' || ![1, 2, 3].includes(priorVersion)) throw invalid();
  return { parentSessionId: spec.migrationParentSessionId, childAgentId: spec.migrationChildAgentId,
    operationId: spec.migrationOperationId, priorCurrentJobId: spec.migrationPriorCurrentJobId,
    priorUpdatedAt: spec.migrationPriorUpdatedAt, priorClosedAt: spec.migrationPriorClosedAt, priorVersion };
}

/** Resolve rollback evidence through the StateStore's exact locked binding/job classification. @param {{store:any,workspace:string,job:any,invalid:()=>Error,mode?:'terminal'|'execution'}} input @param {any} legacyRollback @param {string|undefined} [legacySpecDigest] */
export async function resolveQueuedRescueMigrationRollback(input, legacyRollback, legacySpecDigest = undefined) {
  try { return await input.store.resolveQueuedRescueMigrationRollback(input.workspace, input.job.id, legacyRollback, input.mode, legacySpecDigest); }
  catch (error) {
    if (/** @type {any} */ (error)?.code === 'RESCUE_BINDING_INVALID') throw input.invalid();
    throw error;
  }
}

/** Prefer the durable marker and read legacy job-spec evidence only for pre-marker in-flight jobs. @param {{dataRoot:string,workspace:string,job:any,store:any,invalid:()=>Error}} input */
export async function readQueuedRescueMigrationRollback(input) {
  if (input.job.rescueMigrationRollback !== undefined) return resolveQueuedRescueMigrationRollback(input, undefined);
  const storage = await resolveWorkspaceStorage({ dataRoot: input.dataRoot, workspace: input.workspace });
  const root = resolve(storage.directory, 'job-specs'); const path = resolve(root, `${input.job.id}.json`);
  if (!path.startsWith(`${root}${sep}`)) throw input.invalid();
  let record;
  try { record = await readBoundedJsonFile(storage.directory, path, 512 * 1024, { requirePrivatePermissions: true }); }
  catch (error) {
    if (/** @type {any} */ (error)?.code === 'ENOENT') return resolveQueuedRescueMigrationRollback(input, undefined);
    throw error;
  }
  // Current job-specs keep task material in a capability-authenticated sealed payload. Queued
  // terminalization needs only the StateStore's durable marker/binding proof and must not open it.
  if (record?.version === 2) return resolveQueuedRescueMigrationRollback(input, undefined);
  const spec = parseExactLegacyJobSpecRecord(record, input.job, input.invalid);
  return resolveQueuedRescueMigrationRollback(input, legacyRescueMigrationRollbackFromSpec(spec, input.job, input.invalid));
}
