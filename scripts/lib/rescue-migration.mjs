import { createHash } from 'node:crypto';
import { resolve, sep } from 'node:path';

import { readBoundedJsonFile } from './fs.mjs';
import { resolveWorkspaceStorage } from './workspace.mjs';

const LEGACY_KEYS = ['migrationParentSessionId', 'migrationChildAgentId', 'migrationOperationId',
  'migrationPriorCurrentJobId', 'migrationPriorUpdatedAt', 'migrationPriorClosedAt', 'migrationPriorVersion'];

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

/** Prefer the durable marker and read legacy job-spec evidence only for pre-marker in-flight jobs. @param {{dataRoot:string,workspace:string,job:any,invalid:()=>Error}} input */
export async function readQueuedRescueMigrationRollback(input) {
  if (input.job.rescueMigrationRollback !== undefined) return input.job.rescueMigrationRollback;
  const storage = await resolveWorkspaceStorage({ dataRoot: input.dataRoot, workspace: input.workspace });
  const root = resolve(storage.directory, 'job-specs'); const path = resolve(root, `${input.job.id}.json`);
  if (!path.startsWith(`${root}${sep}`)) throw input.invalid();
  let record;
  try { record = await readBoundedJsonFile(storage.directory, path, 512 * 1024, { requirePrivatePermissions: true }); }
  catch (error) { if (/** @type {any} */ (error)?.code === 'ENOENT') return undefined; throw error; }
  const spec = record?.spec;
  const digest = spec && typeof spec === 'object' && !Array.isArray(spec)
    ? createHash('sha256').update(JSON.stringify(spec, Object.keys(spec).sort())).digest('hex') : null;
  if (record?.version !== 1 || record.jobId !== input.job.id || record.ownerSessionId !== input.job.ownerSessionId
    || record.workspace !== input.job.workspace || record.digest !== digest) throw input.invalid();
  return legacyRescueMigrationRollbackFromSpec(spec, input.job, input.invalid);
}
