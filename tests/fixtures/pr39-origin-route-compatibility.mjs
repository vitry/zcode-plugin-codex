import { createHash } from 'node:crypto';
import { join } from 'node:path';

// Frozen compatibility oracle for the raw schemas merged by PR #39. These four
// literals are intentionally independent: a schema edit must be made four times
// and cannot be hidden by changing a shared producer. Runtime instantiation only
// substitutes canonical workspace paths and the hashes transitively derived from
// those paths; it never calls hook, identity, preparation, invocation, or state
// publication code.
export const PR39_ORIGIN_ROUTE_TEMPLATES = Object.freeze({
  prepared: String.raw`{"name":"prepared","sessionId":"pr39-prepared-session","parentTurnId":"pr39-prepared-turn","childTurnId":"pr39-prepared-child-turn","agentId":"pr39-prepared-child","agentType":"zcode-rescue","generationId":"1111111111111111111111111111111111111111111111111111111111111111","routeState":"active","task":"repair from frozen prepared bytes","preparation":{"generation":1,"requiredExecutorAgentId":null,"resume":"fresh"},"operation":null}`,
  status: String.raw`{"name":"status","sessionId":"pr39-status-session","parentTurnId":"pr39-status-turn","childTurnId":"pr39-status-child-turn","agentId":"pr39-status-child","agentType":"zcode-rescue","generationId":"2222222222222222222222222222222222222222222222222222222222222222","routeState":"active","task":"observe frozen foreground status","preparation":null,"operation":{"jobId":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","operationId":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","status":"running","phase":"running","progress":"frozen target progress"}}`,
  choice: String.raw`{"name":"choice","sessionId":"pr39-choice-session","parentTurnId":"pr39-choice-origin-turn","activeTurnId":"pr39-choice-answer-turn","childTurnId":"pr39-choice-child-turn","agentId":"pr39-choice-child","agentType":"zcode-rescue","generationId":"3333333333333333333333333333333333333333333333333333333333333333","routeState":"stopped","task":"continue from frozen pending bytes","preparation":null,"operation":{"jobId":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","operationId":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","status":"succeeded","phase":"finalizing","progress":"frozen choice anchor"},"pending":true}`,
  stopped: String.raw`{"name":"stopped","sessionId":"pr39-stopped-session","parentTurnId":"pr39-stopped-origin-turn","activeTurnId":"pr39-stopped-continuation-turn","childTurnId":"pr39-stopped-child-turn","agentId":"pr39-stopped-child","agentType":"default","generationId":"4444444444444444444444444444444444444444444444444444444444444444","routeState":"stopped","task":"continue from frozen generation two preparation","preparation":{"generation":2,"requiredExecutorAgentId":"pr39-stopped-child","resume":"resume"},"operation":{"jobId":"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee","operationId":"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff","status":"succeeded","phase":"finalizing","progress":"frozen stopped anchor"}}`,
});

export const PR39_FROZEN_NOW = '2026-08-22T00:10:00.000Z';
const CREATED_AT = '2026-08-22T00:00:00.000Z';
const UPDATED_AT = '2026-08-22T00:05:00.000Z';
const EXPIRES_AT = '2026-08-22T00:30:00.000Z';

if (process.env.PR39_FROZEN_CLOCK === '1') Date.now = () => Date.parse(PR39_FROZEN_NOW);

/** Instantiate one frozen literal into exact relative filenames and JSON bytes. */
export function instantiatePr39OriginRouteTemplate(rawTemplate, { dataRoot, origin, target }) {
  if (!Object.values(PR39_ORIGIN_ROUTE_TEMPLATES).includes(rawTemplate)) throw new Error('unknown PR39 template');
  const template = JSON.parse(rawTemplate); const activeTurnId = template.activeTurnId ?? template.parentTurnId;
  const workspaceDirectory = (workspace) => join(dataRoot, 'workspaces', hash(workspace));
  const originDirectory = workspaceDirectory(origin); const targetDirectory = workspaceDirectory(target);
  const globalKey = digest(template.sessionId); const originIndexKey = digest(template.sessionId, origin);
  const routeKey = digest('executor-route', template.sessionId, template.childTurnId);
  const forwardKey = digest('forward', template.sessionId, template.childTurnId);
  const executorKey = digest('executor', template.agentId);
  const preparationKey = digest(template.sessionId, activeTurnId, target, 'rescue');
  const pendingKey = digest(template.sessionId, target, 'rescue');
  const bindingPartitionKey = digest('rescue-binding-session-v1', template.sessionId, target);
  const bindingKey = digest('rescue-binding-v1', template.sessionId, template.agentId, target);
  const ownerDirectory = hash(`zcode-owner-index-v1\0${template.sessionId}`);
  const records = [];
  const add = (path, value, classification = 'immutable') => records.push(Object.freeze({ path, bytes: `${JSON.stringify(value, null, 2)}\n`, classification }));
  add(join(dataRoot, 'identity-lifecycle', 'active-turns', `${globalKey}.json`), {
    version: 3, kind: 'active-turn', key: globalKey, sessionId: template.sessionId, generationId: template.generationId,
    turnId: activeTurnId, originWorkspace: origin, executionWorkspace: target, permissionMode: 'workspace-write',
    prompt: template.name === 'choice' ? 'resume' : `$zcode:rescue ${template.task}`, createdAt: CREATED_AT, status: 'active',
  });
  add(join(dataRoot, 'identity-lifecycle', 'sessions', `${globalKey}.json`), {
    version: 1, kind: 'identity-session', key: globalKey, sessionId: template.sessionId, sessionStartedAt: CREATED_AT,
    sessionSource: 'startup', knownWorkspaces: [origin, target], endedAt: null, updatedAt: UPDATED_AT,
  });
  add(join(originDirectory, 'identity', 'active-turn-indexes', `${originIndexKey}.json`), {
    version: 1, kind: 'active-turn-index', key: originIndexKey, sessionId: template.sessionId, generationId: template.generationId,
    globalKey, originWorkspace: origin,
  });
  const targetIndexKey = digest(template.sessionId, target); const callerDigest = hash(`pr39-${template.name}-caller-context`);
  add(join(targetDirectory, 'identity', 'active-turn-indexes', `${targetIndexKey}.json`), {
    version: 1, kind: 'active-turn-index', key: targetIndexKey, sessionId: template.sessionId, generationId: template.generationId,
    globalKey, originWorkspace: origin,
  });
  add(join(targetDirectory, 'identity', 'callers', `${callerDigest}.json`), {
    version: 1, kind: 'caller-context', digest: callerDigest, sessionId: template.sessionId, turnId: activeTurnId,
    workspace: target, permissionMode: 'workspace-write', createdAt: CREATED_AT, expiresAt: EXPIRES_AT, generationId: template.generationId,
  });
  add(join(originDirectory, 'hook-state', `route-${routeKey}.json`), {
    version: 1, kind: 'executor-route', agentId: template.agentId, agentType: template.agentType,
    parentSessionId: template.sessionId, parentGenerationId: template.generationId, parentTurnId: template.parentTurnId,
    parentPermissionMode: 'workspace-write', childTurnId: template.childTurnId, originWorkspace: origin,
    targetWorkspace: target, state: template.routeState, createdAt: CREATED_AT, updatedAt: UPDATED_AT,
  });
  add(join(originDirectory, 'hook-state', `forward-${forwardKey}.json`), {
    kind: 'forwarding', sessionId: template.sessionId, generationId: template.generationId, turnId: template.childTurnId,
    agentId: template.agentId, active: template.routeState === 'active', targetWorkspace: target, updatedAt: UPDATED_AT,
  });
  add(join(targetDirectory, 'hook-state', `executor-${executorKey}.json`), {
    kind: 'subagent-executor', agentId: template.agentId, agentType: template.agentType, parentSessionId: template.sessionId,
    parentGenerationId: template.generationId, parentTurnId: template.parentTurnId, parentPermissionMode: 'workspace-write',
    childTurnId: template.childTurnId, originWorkspace: origin, workspace: target, active: template.routeState === 'active', createdAt: CREATED_AT,
  });
  if (template.preparation) add(join(targetDirectory, 'invocations', 'prepared', `${preparationKey}.json`), {
    version: 2, key: preparationKey, sessionId: template.sessionId, turnId: activeTurnId, workspace: target,
    permissionMode: 'workspace-write', source: 'explicit', envelope: { version: 1, source: 'explicit', task: template.task,
      options: { execution: 'foreground', resume: template.preparation.resume } }, generation: template.preparation.generation,
    requiredExecutorAgentId: template.preparation.requiredExecutorAgentId, createdAt: CREATED_AT, expiresAt: EXPIRES_AT,
    consumedAt: null, executorAgentId: null,
  }, 'one-shot');
  if (template.operation) {
    const job = template.operation; const logFile = join(targetDirectory, 'jobs', `${job.jobId}.log`);
    add(join(targetDirectory, 'jobs', `${job.jobId}.json`), {
      id: job.jobId, workspace: target, ownerSessionId: template.sessionId, ownerTurnId: template.parentTurnId,
      command: 'rescue', readOnly: false, permissionSnapshot: { permissionMode: 'workspace-write' }, status: job.status,
      createdAt: CREATED_AT, updatedAt: UPDATED_AT, logFile, startedAt: CREATED_AT, zcodeSessionId: `pr39-${template.name}-zcode-session`,
      phase: job.phase, lastActivityAt: UPDATED_AT, progressPreview: [job.progress],
      ...(job.status === 'succeeded' ? { exitCode: 0, finishedAt: UPDATED_AT } : {}),
    }, 'operation');
    add(join(targetDirectory, `rescue-binding-authority-${bindingPartitionKey}.json`), {
      version: 1, key: bindingPartitionKey, parentSessionId: template.sessionId, workspace: target, createdAt: CREATED_AT,
    }, 'operation');
    add(join(targetDirectory, `rescue-binding-session-${bindingPartitionKey}.json`), {
      version: 1, key: bindingPartitionKey, parentSessionId: template.sessionId, workspace: target, records: [{
        version: 1, key: bindingKey, operationId: job.operationId, state: 'active', parentSessionId: template.sessionId,
        executorAgentId: template.agentId, executorAgentType: template.agentType, executorParentTurnId: template.parentTurnId,
        executorParentPermissionMode: 'workspace-write', workspace: target, permissionMode: 'workspace-write',
        anchorJobId: job.jobId, currentJobId: job.jobId, createdAt: CREATED_AT, updatedAt: UPDATED_AT, closedAt: null, closeReason: null,
      }],
    }, 'operation');
    add(join(targetDirectory, 'job-owners', ownerDirectory, `${job.jobId}.json`), { jobId: job.jobId, ownerSessionId: template.sessionId, version: 1 }, 'operation');
    const tuple = `${ownerDirectory}/${job.jobId}`;
    add(join(targetDirectory, 'job-owners', 'index.json'), {
      bindingTuples: summary('zcode-owner-index-binding-tuples-v3\0', [tuple]),
      canonicalJobIds: summary('zcode-owner-index-job-ids-v2\0', [job.jobId]), complete: true, version: 3,
    }, 'operation');
    add(join(targetDirectory, 'broker', 'session-owners.json'), {
      version: 1, sessions: { [`pr39-${template.name}-zcode-session`]: digest('zcode-owner-v1', template.sessionId) },
    }, 'operation');
  }
  if (template.pending) add(join(targetDirectory, 'invocations', 'pending', `${pendingKey}.json`), {
    version: 2, key: pendingKey, sessionId: template.sessionId, originatingTurnId: activeTurnId, workspace: target,
    permissionMode: 'workspace-write', command: 'rescue', spec: { argv: ['rescue', template.task] }, source: 'explicit',
    executorAgentId: template.agentId, routeKind: 'bound', candidateJobId: template.operation.jobId,
    expectedOperationId: template.operation.operationId, expectedCurrentJobId: template.operation.jobId,
    createdAt: CREATED_AT, expiresAt: EXPIRES_AT,
  }, 'one-shot');
  return Object.freeze({ ...template, originDirectory, targetDirectory, records: Object.freeze(records) });
}

function digest(...values) { return hash(JSON.stringify(values)); }
function hash(value) { return createHash('sha256').update(value).digest('hex'); }
function summary(prefix, values) { const hasher = createHash('sha256').update(prefix); for (const value of [...values].sort()) hasher.update(value); return { count: values.length, digest: hasher.digest('hex') }; }
