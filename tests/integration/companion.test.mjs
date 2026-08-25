import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { createCipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { PassThrough } from 'node:stream';

import { startBackgroundWorker } from '../../scripts/lib/background-worker.mjs';
import { scavengeWritableJobs } from '../../scripts/lib/recovery.mjs';
import { createIdentityStore } from '../../scripts/lib/identity.mjs';
import { PluginError } from '../../scripts/lib/errors.mjs';
import { atomicWriteJson } from '../../scripts/lib/fs.mjs';
import { createJobController, ownerIdForSession } from '../../scripts/lib/job-control.mjs';
import { managedRolePaths, MANAGED_ROLE_DESCRIPTION, renderManagedRescueRole } from '../../scripts/lib/managed-agent-role.mjs';
import { createRescuePreparationStore } from '../../scripts/lib/rescue-preparation.mjs';
import { createRescueBindingPartition } from '../../scripts/lib/rescue-binding.mjs';
import { planRescueActivation } from '../../scripts/lib/rescue-route-planner.mjs';
import { createStateStore } from '../../scripts/lib/state.mjs';
import { TRANSFER_WIRE_LIMITS } from '../../scripts/lib/transfer.mjs';
import { writeResultArtifact } from '../../scripts/lib/review.mjs';
import { createManagedZCodeClient, releaseManagedZCodeOwner } from '../../scripts/lib/zcode-client.mjs';
import { resolveWorkspaceStorage } from '../../scripts/lib/workspace.mjs';
import { renderOutput } from '../../scripts/lib/render.mjs';
import { withWorkerLease } from '../../scripts/lib/recovery.mjs';
import { runCompanion, runDirectInvocation } from '../../scripts/zcode-companion.mjs';
import { markForwarding, recordSession, resolveRecordedSessionStart } from '../../hooks/lib/hook-state.mjs';
import { runChild } from '../helpers/run-child.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const cli = join(root, 'scripts', 'zcode-companion.mjs');
const rescueLauncher = join(root, 'skills', 'rescue', 'launcher.mjs');
const fake = join(root, 'tests', 'fixtures', 'fake-zcode-cli.mjs');
const fakeCodex = join(root, 'tests', 'fixtures', 'fake-codex-app-server.mjs');
const completionSignalProbe = join(root, 'tests', 'fixtures', 'completion-signal-probe.cjs');
const signalHandlerProbe = join(root, 'tests', 'fixtures', 'signal-handler-probe.cjs');
const statusWaitProbe = join(root, 'tests', 'fixtures', 'status-wait-probe.cjs');
const sessionEndHook = join(root, 'hooks', 'session-end-hook.mjs');
const lockHolder = join(root, 'tests', 'fixtures', 'lock-holder.mjs');
const claimedSealedWorker = join(root, 'tests', 'fixtures', 'claimed-sealed-worker.mjs');
const ambiguousClaimWorker = join(root, 'tests', 'fixtures', 'ambiguous-claim-worker.mjs');
const legacyFenceWorker = join(root, 'tests', 'fixtures', 'legacy-fence-worker.mjs');
const commitmentPublicationCrash = join(root, 'tests', 'fixtures', 'commitment-publication-crash.mjs');
const prepareTtyShim = new URL('../fixtures/prepare-tty-shim.mjs', import.meta.url).href;
const dependencyNodeModules = dirname(dirname(createRequire(import.meta.url).resolve('fs-native-extensions/package.json')));
const windowsRealSignalSkip = process.platform === 'win32' ? 'Node child.kill cannot emulate Windows console control events' : false;

/** Produce a cryptographically valid replacement with the bearer capability, without using production sealing code.
 * @param {any} job @param {any} spec @param {string} capability */
function resealJobSpecForTest(job, spec, capability) {
  /** @param {string} purpose */
  const key = (purpose) => createHash('sha256').update(`zcode-job-spec-${purpose}-v2\0`).update(capability).digest();
  const plaintext = Buffer.from(JSON.stringify(spec));
  const commitment = createHmac('sha256', key('commitment')).update(plaintext).digest('hex');
  const identity = { version: 2, jobId: job.id, ownerSessionId: job.ownerSessionId, workspace: job.workspace, commitment };
  const aad = Buffer.from(JSON.stringify(identity)); const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key('encryption'), iv); cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]); const tag = cipher.getAuthTag();
  const mac = createHmac('sha256', key('authentication')).update(aad).update(iv).update(tag).update(ciphertext).digest();
  return { ...identity, sealedSpec: { algorithm: 'aes-256-gcm', iv: iv.toString('base64url'),
    ciphertext: ciphertext.toString('base64url'), tag: tag.toString('base64url'), mac: mac.toString('base64url') } };
}

/** Publish a modern sealed-v2 fixture through the same StateStore commitment boundary as production.
 * @param {any} context @param {any} store @param {string} workspace @param {any} job @param {any} spec */
async function publishSealedSpecForTest(context, store, workspace, job, spec) {
  const capability = await context.identity.createExecutionCapability({ jobId: job.id,
    ownerSessionId: job.ownerSessionId, workspace, operation: 'run-reserved-job', jobSpecFormat: 'sealed-v2',
    permissionSnapshot: job.permissionSnapshot });
  const record = resealJobSpecForTest(job, spec, capability);
  await store.publishJobSpecCommitment(workspace, job.id, record.commitment);
  const storage = await resolveWorkspaceStorage({ dataRoot: context.dataRoot, workspace });
  await atomicWriteJson(join(storage.directory, 'job-specs', `${job.id}.json`), record);
  return { capability, storage };
}

/** Persist an exact pre-format-discriminator execution capability without using the production issuer.
 * @param {any} context @param {any} job @param {string} specDigest */
async function writeLegacyExecutionCapabilityFixture(context, job, specDigest) {
  const token = randomBytes(32).toString('base64url'); const digest = createHash('sha256').update(token).digest('hex');
  const storage = await resolveWorkspaceStorage({ dataRoot: context.dataRoot, workspace: job.workspace });
  const directory = join(storage.directory, 'identity', 'capabilities'); await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${digest}.json`);
  await atomicWriteJson(path, { digest, jobId: job.id, ownerSessionId: job.ownerSessionId, workspace: job.workspace,
    operation: 'run-reserved-job', permissionSnapshot: job.permissionSnapshot, specDigest,
    createdAt: new Date().toISOString(), consumedAt: null });
  return { token, path };
}

/** Replace one production-issued capability with its exact pre-format historical record.
 * @param {any} context @param {any} job @param {string} specDigest @param {string} token */
async function rewriteLegacyExecutionCapabilityFixture(context, job, specDigest, token) {
  const digest = createHash('sha256').update(token).digest('hex');
  const storage = await resolveWorkspaceStorage({ dataRoot: context.dataRoot, workspace: job.workspace });
  const path = join(storage.directory, 'identity', 'capabilities', `${digest}.json`);
  await atomicWriteJson(path, { digest, jobId: job.id, ownerSessionId: job.ownerSessionId, workspace: job.workspace,
    operation: 'run-reserved-job', permissionSnapshot: job.permissionSnapshot, specDigest,
    createdAt: new Date().toISOString(), consumedAt: null });
  return path;
}
const legacyPreparedRoute = Object.freeze({ type: 'prepared', command: 'rescue', route: { version: 1, action: 'spawn', taskName: 'zcode_rescue_task' } });
const baseAgentPathDigest = createHash('sha256').update('/root/zcode_rescue_task').digest('hex');
const legacyPreparationDependencies = Object.freeze({
  planRescueActivation: async () => ({ activation: { kind: 'spawn', taskName: 'zcode_rescue_task', agentPathDigest: baseAgentPathDigest }, directive: legacyPreparedRoute.route }),
});
/** @param {string} executorAgentId */
const reactivationDependencies = (executorAgentId) => ({ planRescueActivation: async () => ({
  activation: { kind: 'reactivate', executorAgentId, agentPathDigest: baseAgentPathDigest },
  directive: { version: 2, action: 'followup', target: '/root/zcode_rescue_task', assignment: 'zcode-rescue' },
}) });

/** @param {any} binding */
function legacyMigrationProofForTest(binding) {
  return { parentSessionId: binding.parentSessionId, childAgentId: binding.childAuthority.childAgentId,
    childAgentType: binding.childAuthority.childAgentType, operationId: binding.operationId,
    originWorkspace: binding.childAuthority.originWorkspace, executionWorkspace: binding.childAuthority.executionWorkspace,
    agentPathDigest: binding.childAuthority.agentPathDigest,
    bindingDigest: createHash('sha256').update(JSON.stringify(binding)).digest('hex') };
}

/** @param {{id:string,parentThreadId:string,cwd:string,agentRole?:string|null,agentPath?:string,status?:Record<string,unknown>}} input */
function rawCodexChild({ id, parentThreadId, cwd, agentRole = 'zcode-rescue', agentPath = '/root/zcode_rescue_task', status = { type: 'active', activeFlags: [] } }) {
  return {
    id, sessionId: parentThreadId, parentThreadId, ephemeral: false, preview: '', projectId: null,
    historyMode: 'legacy', modelProvider: 'openai', createdAt: 1, updatedAt: 2, recencyAt: 2,
    status, path: null, cwd,
    source: { subAgent: { thread_spawn: { parent_thread_id: parentThreadId, depth: 1, agent_path: agentPath, agent_nickname: null, agent_role: agentRole } } },
    canAcceptDirectInput: null, threadSource: null, agentNickname: null, agentRole, gitInfo: null, name: null, turns: [],
  };
}
/** @param {any} host */
function activatedLegacyHost(host) {
  return { ...host, status: { type: 'active', activeFlags: [] }, updatedAt: host.updatedAt + 1 };
}
/** @typedef {(pid:number,signal?:number|string)=>boolean} KillFn */

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-companion-'));
  const workspace = join(directory, 'repo'); const dataRoot = join(directory, 'data');
  await mkdir(workspace); await writeFile(join(workspace, 'tracked.txt'), 'base\n');
  await run('git', ['init', '-q'], { cwd: workspace });
  await run('git', ['add', 'tracked.txt'], { cwd: workspace });
  await run('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'base'], { cwd: workspace });
  await writeFile(join(workspace, 'tracked.txt'), 'changed\n');
  const identity = createIdentityStore({ dataRoot });
  const caller = await identity.createCallerContext({ sessionId: 'codex-session', turnId: 'turn-1', workspace, permissionMode: 'workspace-write' });
  const env = {
    ...process.env, ZCODE_DATA_ROOT: dataRoot, ZCODE_PATH: fake,
    CODEX_APP_SERVER_PATH: process.execPath,
    CODEX_APP_SERVER_ARGS_JSON: JSON.stringify([fakeCodex]),
    FAKE_CODEX_THREAD_LIST_RESULTS_JSON: JSON.stringify({ data: [], nextCursor: null, backwardsCursor: null }),
  };
  return { caller, dataRoot, directory, env, identity, workspace };
}

/** @param {string} workspace @param {string} directory @param {string} [name] */
async function addLinkedWorktree(workspace, directory, name = 'late-bind-companion-target') {
  const target = join(directory, 'linked-worktree');
  const result = await run('git', ['worktree', 'add', '-q', '-b', name, target], { cwd: workspace });
  assert.equal(result.code, 0, result.stderr);
  return target;
}

/** @param {any} context @param {{sessionId:string,turnId:string,permissionMode:string,prompt:string}} input */
async function recordRealParentTurn(context, input) {
  const hookEnv = { ...context.env, PLUGIN_ROOT: root };
  const started = await runChild(process.execPath, [join(root, 'hooks', 'session-lifecycle-hook.mjs')], {
    cwd: context.workspace, env: hookEnv, ordinaryInput: true,
    input: { session_id: input.sessionId, cwd: context.workspace, hook_event_name: 'SessionStart', transcript_path: null, model: 'gpt', permission_mode: input.permissionMode, source: 'startup' },
  });
  assert.equal(started.code, 0, started.stderr || started.stdout);
  const prompted = await runChild(process.execPath, [join(root, 'hooks', 'user-prompt-hook.mjs')], {
    cwd: context.workspace, env: hookEnv, ordinaryInput: true,
    input: { session_id: input.sessionId, turn_id: input.turnId, cwd: context.workspace, hook_event_name: 'UserPromptSubmit', transcript_path: null, model: 'gpt', permission_mode: input.permissionMode, prompt: input.prompt },
  });
  assert.equal(prompted.code, 0, prompted.stderr || prompted.stdout);
}

/** @param {string} command @param {string[]} args @param {{cwd?:string,env?:NodeJS.ProcessEnv,input?:unknown,rawInput?:string}} [options] */
function run(command, args, options = {}) {
  const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'], shell: false });
  return new Promise((resolvePromise, reject) => {
    let stdout = ''; let stderr = ''; let internal = '';
    child.stdout?.on('data', (chunk) => { stdout += chunk; }); child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.stdio[4]?.on('data', (chunk) => { internal += chunk; });
    child.stdio[3]?.on('error', consumePipeError); child.stdio[4]?.on('error', consumePipeError);
    /** @type {import('node:stream').Writable} */ (child.stdio[3]).end(options.rawInput ?? `${JSON.stringify(options.input ?? {})}\n`);
    child.once('error', reject); child.once('exit', (code) => resolvePromise({ code, stdout, stderr, internal }));
  });
}

/** Launch one real private execution worker and retain only its process/exit handles.
 * @param {any} context @param {string} jobId @param {string} executionCapability @param {NodeJS.ProcessEnv} [extraEnv] */
function spawnLegacyFenceWorker(context, jobId, executionCapability, extraEnv = {}) {
  const child = spawn(process.execPath, [legacyFenceWorker, 'run-reserved-job', jobId], {
    cwd: context.workspace, env: { ...context.env, ZCODE_TEST_DATA_ROOT: context.dataRoot, ...extraEnv },
    detached: true, stdio: ['ignore', 'ignore', 'pipe', 'pipe'], shell: false,
  });
  let stderr = ''; child.stderr?.on('data', (chunk) => { stderr += chunk; });
  /** @type {import('node:stream').Writable} */ (child.stdio[3]).end(`${JSON.stringify({ executionCapability, jobId })}\n`);
  const exit = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal, stderr }));
  });
  return { child, exit };
}

function consumePipeError() {}

/** @param {number} pid @param {KillFn} [killFn] */
function processAlive(pid, killFn = process.kill) {
  try { killFn(pid, 0); return true; }
  catch (error) { if ((/** @type {NodeJS.ErrnoException} */ (error))?.code === 'ESRCH') return false; throw error; }
}

/** @param {number} pid @param {number} [timeoutMs] @param {KillFn} [killFn] */
async function waitForProcessExit(pid, timeoutMs = 1_000, killFn = process.kill) {
  const deadline = Date.now() + timeoutMs;
  while (processAlive(pid, killFn) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  return !processAlive(pid, killFn);
}

/** @param {number} pid @param {KillFn} [killFn] */
async function terminateOwnedProcess(pid, killFn = process.kill) {
  if (!processAlive(pid, killFn)) return;
  killFn(pid, 'SIGTERM');
  if (await waitForProcessExit(pid, 1_000, killFn)) return;
  killFn(pid, 'SIGKILL');
  assert.equal(await waitForProcessExit(pid, 1_000, killFn), true, `owned process ${pid} was not reaped`);
}

/** @param {unknown} value @param {number} selfPid */
function validRecordedPid(value, selfPid) { return Number.isSafeInteger(value) && Number(value) > 1 && value !== selfPid; }

/** @param {any} brokerIdentity @param {any} workerIdentity @param {number} selfPid */
function validateRecordedProcessIdentities(brokerIdentity, workerIdentity, selfPid) {
  if (brokerIdentity === null && workerIdentity === null) return null;
  if (!brokerIdentity || typeof brokerIdentity !== 'object' || Array.isArray(brokerIdentity) || !validRecordedPid(brokerIdentity.pid, selfPid)) throw new Error('child-loss broker identity has an unsafe pid');
  if (workerIdentity !== null && (!workerIdentity || typeof workerIdentity !== 'object' || Array.isArray(workerIdentity)
    || !validRecordedPid(workerIdentity.pid, selfPid) || workerIdentity.pid === brokerIdentity.pid
    || !validRecordedPid(workerIdentity.ppid, selfPid) || workerIdentity.ppid !== brokerIdentity.pid)) throw new Error('child-loss worker identity has an unsafe pid');
  return { brokerPid: brokerIdentity.pid, workerPid: workerIdentity?.pid ?? null };
}

/** @param {any} input */
async function terminateRecordedOwnedProcesses(input) {
  const recorded = validateRecordedProcessIdentities(input.brokerIdentity, input.workerIdentity, input.selfPid ?? process.pid);
  const current = validateRecordedProcessIdentities(input.currentIdentity, null, input.selfPid ?? process.pid);
  if (!recorded || !current || input.currentIdentity.pid !== input.brokerIdentity.pid || input.currentIdentity.instanceId !== input.brokerIdentity.instanceId || input.currentIdentity.endpoint !== input.brokerIdentity.endpoint) return recorded;
  await terminateOwnedProcess(recorded.brokerPid, input.killFn);
  if (recorded.workerPid !== null) await terminateOwnedProcess(recorded.workerPid, input.killFn);
  return recorded;
}

/** @param {any} input */
async function cleanupChildLossProcesses(input) {
  let cleanupError;
  try {
    const brokerIdentity = await readFile(input.identityPath, 'utf8').then(JSON.parse).catch(() => null);
    const workerIdentity = await readFile(input.workerProcess, 'utf8').then(JSON.parse).catch(() => null);
    const recorded = validateRecordedProcessIdentities(brokerIdentity, workerIdentity, process.pid);
    if (!input.childExited()) { input.child.kill('SIGKILL'); await input.childExit.catch(() => {}); }
    let releaseError;
    try {
      const released = await releaseManagedZCodeOwner({ dataRoot: input.context.dataRoot, workspace: input.context.workspace, ownerId: input.ownerId, requestTimeoutMs: 750 });
      const sessionId = input.sessionId();
      if (sessionId) { assert.equal(released.releasedSessionIds.includes(sessionId), true); assert.equal(released.failedSessionIds.includes(sessionId), false); }
    }
    catch (error) { releaseError = error; }
    const currentIdentity = await readFile(input.identityPath, 'utf8').then(JSON.parse).catch(() => null);
    await terminateRecordedOwnedProcesses({ brokerIdentity, currentIdentity, workerIdentity });
    if (recorded) assert.equal(processAlive(recorded.brokerPid), false);
    if (recorded && recorded.workerPid !== null) assert.equal(processAlive(recorded.workerPid), false);
    if (brokerIdentity) await assert.rejects(stat(brokerIdentity.endpoint), { code: 'ENOENT' });
    await assert.rejects(stat(input.identityPath), { code: 'ENOENT' });
    if (releaseError) throw releaseError;
  }
  catch (error) { cleanupError = error; }
  finally { await rm(input.context.directory, { recursive: true, force: true }); }
  await assert.rejects(stat(input.context.directory), { code: 'ENOENT' });
  if (cleanupError) throw cleanupError;
}

/** @param {any} context @param {string[]} args @param {NodeJS.ProcessEnv} [extraEnv] @param {Record<string,unknown>} [authorization] */
async function companion(context, args, extraEnv = {}, authorization = { callerContext: context.caller }) {
  const result = await run(process.execPath, [cli, ...args], { cwd: context.workspace, env: { ...context.env, ...extraEnv }, input: authorization });
  return { ...result, json: result.internal ? JSON.parse(result.internal) : null };
}

/** @param {any} context @param {string[]} args */
async function companionWithArchiveHandshake(context, args) {
  const nonce = randomBytes(32).toString('hex');
  const gate = join(context.directory, `${nonce}-archive-progress-gate.json`);
  const reached = join(context.directory, `${nonce}-archive-progress-reached.json`);
  const expected = [
    'ZCode is generating a response.', 'ZCode started a tool call.', 'ZCode is retrying the model request.',
    'ZCode tool work is still running.', 'ZCode completed a tool call.',
  ];
  await atomicWriteJson(gate, { version: 1, nonce, acknowledged: 0 });
  const execution = companion(context, args, {
    FAKE_ZCODE_ARCHIVE_PROGRESS: '1', FAKE_ZCODE_ARCHIVE_PROGRESS_GATE: gate,
    FAKE_ZCODE_ARCHIVE_PROGRESS_GATE_NONCE: nonce, FAKE_ZCODE_ARCHIVE_PROGRESS_GATE_REACHED: reached,
  });
  let result;
  try {
    const storage = await resolveWorkspaceStorage(context);
    for (const [index, message] of expected.entries()) {
      await waitFor(async () => {
        const names = await readdir(join(storage.directory, 'jobs')).catch(() => []);
        for (const name of names.filter((candidate) => candidate.endsWith('.log'))) {
          if ((await readFile(join(storage.directory, 'jobs', name), 'utf8').catch(() => '')).includes(message)) return true;
        }
        return false;
      }, `archive did not durably append semantic event ${index + 1}`);
      await atomicWriteJson(gate, { version: 1, nonce, acknowledged: index + 1 });
    }
    result = await execution;
    assert.deepEqual(JSON.parse(await readFile(reached, 'utf8')), { version: 1, nonce, sequence: expected.length });
  } finally {
    await atomicWriteJson(gate, { version: 1, nonce, acknowledged: expected.length }).catch(() => {});
    if (!result) await execution.catch(() => {});
    await Promise.all([unlink(gate).catch(() => {}), unlink(reached).catch(() => {})]);
  }
  await Promise.all([
    assert.rejects(stat(gate), { code: 'ENOENT' }),
    assert.rejects(stat(reached), { code: 'ENOENT' }),
  ]);
  return result;
}

/** @param {any} context @param {'initial-only'|'zero-online'|'rejection-burst'|'sequence-gap'|'observed-traffic'|'exclusive-ranges'} scenario @param {{heartbeat?:boolean,env?:NodeJS.ProcessEnv,completionAfterProgressLine?:string}} [options] */
async function deterministicConversationScenario(context, scenario, options = {}) {
  const record = join(context.directory, `${scenario}-conversation-requests.jsonl`);
  const owner = caller(`conversation-${scenario}`); const lines = /** @type {string[]} */ ([]);
  const heartbeatDiagnostic = '[zcode] ZCode conversation frames were unavailable; using bounded session progress.\n';
  const completionAfterProgressLine = options.completionAfterProgressLine ?? (options.heartbeat ? heartbeatDiagnostic : undefined);
  const gateNonce = completionAfterProgressLine ? randomBytes(32).toString('hex') : undefined;
  const gatePath = gateNonce ? join(context.directory, `${scenario}-${gateNonce}-progress-dispatch-gate.json`) : undefined;
  let gateTimedOut = false; let gateWriteError; let observedExpectedLine = false; let gateDeadline;
  /** @type {()=>void} */ let heartbeat = () => { throw new Error('heartbeat was not assigned'); };
  let heartbeatAssigned = false; let signalHeartbeatAssigned = () => {};
  const heartbeatReady = new Promise((resolvePromise) => { signalHeartbeatAssigned = () => resolvePromise(undefined); });
  const releaseGate = async () => {
    if (!gatePath || !gateNonce) return;
    try { await writeFile(gatePath, JSON.stringify({ version: 1, nonce: gateNonce, state: 'release' }), { mode: 0o600 }); }
    catch (error) { gateWriteError ??= error; }
  };
  if (gatePath && gateNonce) await writeFile(gatePath, JSON.stringify({ version: 1, nonce: gateNonce, state: 'held' }), { mode: 0o600 });
  let output;
  try {
    if (gatePath) {
      gateDeadline = setTimeout(() => { gateTimedOut = true; void releaseGate(); }, 15_000);
      gateDeadline.unref?.();
    }
    const execution = runCompanion(['rescue', '--fresh', `${scenario} conversation compatibility`], {
      cwd: context.workspace,
      env: {
        ...context.env, ...options.env, FAKE_ZCODE_CONVERSATION_SCENARIO: scenario, FAKE_ZCODE_RECORD: record,
        ...(gatePath && gateNonce ? { FAKE_ZCODE_PROGRESS_DISPATCH_GATE: gatePath, FAKE_ZCODE_PROGRESS_DISPATCH_GATE_NONCE: gateNonce } : {}),
      },
      caller: owner,
      progressWriter: (line) => {
        lines.push(line);
        if (line === completionAfterProgressLine) { observedExpectedLine = true; void releaseGate(); }
      },
      ...(options.heartbeat ? { progressDependencies: {
        now: () => new Date().toISOString(),
        setInterval: (/** @type {()=>void} */ callback) => { heartbeat = callback; heartbeatAssigned = true; signalHeartbeatAssigned(); return { unref() {} }; },
        clearInterval: () => {},
      } } : {}),
    });
    if (options.heartbeat) {
      await heartbeatReady;
      await waitForConversationProbeBoundary(context, record, scenario);
      assert.equal(heartbeatAssigned, true);
      heartbeat();
    }
    output = await execution;
  } finally {
    if (gateDeadline) clearTimeout(gateDeadline);
    await releaseGate();
  }
  if (gateTimedOut || !observedExpectedLine && completionAfterProgressLine) throw new Error(`expected public progress line was not dispatched: ${completionAfterProgressLine}`);
  if (gateWriteError) throw gateWriteError;
  const status = await runCompanion(['status', output.job.id], { cwd: context.workspace, env: context.env, caller: owner });
  const stored = await createStateStore({ dataRoot: context.dataRoot }).readJob(context.workspace, output.job.id);
  const requests = (await readFile(record, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  return { lines, output, requests, status, stored };
}

/** @param {any} context @param {string} record @param {string} scenario */
async function waitForConversationProbeBoundary(context, record, scenario) {
  const storage = await resolveWorkspaceStorage(context);
  await waitFor(async () => {
    const requests = await readFile(record, 'utf8').then((contents) => contents.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))).catch(() => []);
    if (!requests.some((frame) => frame.method === 'session/send')) return false;
    const names = await readdir(join(storage.directory, 'jobs')).catch(() => []);
    for (const name of names) {
      if (!/^[a-f0-9]{64}\.json$/u.test(name)) continue;
      const job = await readFile(join(storage.directory, 'jobs', name), 'utf8').then(JSON.parse).catch(() => null);
      if (typeof job?.inputId !== 'string' || !Number.isSafeInteger(job?.startRevision)) continue;
      if (scenario === 'zero-online' ? job.progressProbe?.acceptedOnline > 0 : job.progressProbe?.acceptedInitial > 0) return true;
    }
    return false;
  }, `conversation ${scenario} frame was not observed after the accepted boundary`);
}

/** @param {()=>Promise<boolean>} predicate @param {string} message @param {number} [timeoutMs] */
async function waitFor(predicate, message, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(message);
}

/** @param {any} context @param {()=>Promise<any[]>} recorded @param {string} message @param {number} [timeoutMs] */
async function waitForAcceptedBoundary(context, recorded, message, timeoutMs = 5_000) {
  const storage = await resolveWorkspaceStorage(context);
  await waitFor(async () => {
    if (!(await recorded()).some((frame) => frame.method === 'session/send')) return false;
    const names = await readdir(join(storage.directory, 'jobs')).catch(() => []);
    for (const name of names) {
      if (!/^[a-f0-9]{64}\.json$/u.test(name)) continue;
      const job = await readFile(join(storage.directory, 'jobs', name), 'utf8').then(JSON.parse).catch(() => null);
      if (typeof job?.inputId === 'string' && Number.isSafeInteger(job?.startRevision)) return true;
    }
    return false;
  }, message, timeoutMs);
}

/** @param {any} context @param {{ownerSessionId?:string,ownerTurnId?:string,workerLeaseId?:string,zcodeSessionId?:string}} [options] */
async function reserveOrphan(context, options = {}) {
  const store = createStateStore({ dataRoot: context.dataRoot });
  const ownerSessionId = options.ownerSessionId ?? 'departed-owner';
  const queued = await store.reserveJob({ workspace: context.workspace, ownerSessionId, ownerTurnId: options.ownerTurnId ?? 'departed-turn', command: 'rescue', readOnly: false, permissionSnapshot: { permissionMode: 'workspace-write' } });
  const workerLeaseId = options.workerLeaseId ?? 'd'.repeat(64);
  let running = await startWritableRescueForTest(store, context.workspace, queued, {
    childPid: 999999, workerLeaseId, startedAt: new Date().toISOString(),
    zcodeSessionId: options.zcodeSessionId ?? 'orphan-session',
  });
  running = await store.transitionJob(context.workspace, queued.id, ['running'], 'running', { inputId: 'accepted-input', startRevision: 7, beforeMessageIds: ['historical'] });
  return { job: running, store, workerLeaseId };
}

/** @param {any} store @param {string} workspace @param {any} job @param {Record<string,unknown>} [patch] */
async function startWritableRescueForTest(store, workspace, job, patch = {}) {
  const childPid = patch.childPid ?? 999_999_999; const workerLeaseId = patch.workerLeaseId ?? job.id;
  const claimed = await store.claimJobWorkerForExecution(workspace, job.id, { childPid, workerLeaseId });
  return store.transitionJob(workspace, job.id, ['queued'], 'running', {
    ...patch, childPid: claimed.childPid, workerLeaseId: claimed.workerLeaseId,
  });
}

/** @param {any} context @param {string} jobId @param {1|2} [bindingVersion] */
async function downgradeCompanionReservationToOwnerV1(context, jobId, bindingVersion) {
  const storage = await resolveWorkspaceStorage(context);
  const jobPath = join(storage.directory, 'jobs', `${jobId}.json`);
  const job = JSON.parse(await readFile(jobPath, 'utf8')); delete job.rescueReservationKind;
  await atomicWriteJson(jobPath, job);
  const ownerRoot = join(storage.directory, 'job-owners'); let ownerBindingPath;
  for (const entry of await readdir(ownerRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[a-f0-9]{64}$/u.test(entry.name)) continue;
    const candidate = join(ownerRoot, entry.name, `${jobId}.json`);
    try { await readFile(candidate); ownerBindingPath = candidate; break; }
    catch (error) { if ((/** @type {NodeJS.ErrnoException} */ (error))?.code !== 'ENOENT') throw error; }
  }
  assert.ok(ownerBindingPath);
  await atomicWriteJson(ownerBindingPath, { jobId, ownerSessionId: job.ownerSessionId, version: 1 });
  if (bindingVersion === undefined) return;
  const [partitionName] = (await readdir(storage.directory)).filter((name) => name.startsWith('rescue-binding-session-'));
  const partitionPath = join(storage.directory, partitionName); const partition = JSON.parse(await readFile(partitionPath, 'utf8'));
  const current = partition.records.find((/** @type {any} */ record) => record.currentJobId === jobId); assert.ok(current);
  const v2 = { ...current, version: 2, childAuthority: { ...current.childAuthority } };
  delete v2.superseded; delete v2.childAuthority.agentPath;
  await atomicWriteJson(partitionPath, createRescueBindingPartition({
    parentSessionId: job.ownerSessionId, workspace: job.workspace, records: [v2],
  }));
}

/** Publish a production background job, then restore an exact pre-format v1 on-disk fixture.
 * @param {any} context @param {string} task @param {string} ownerSessionId */
async function historicalV1BackgroundFixture(context, task, ownerSessionId) {
  const record = join(context.directory, `${ownerSessionId}.jsonl`); await writeFile(record, '');
  const reserved = await runCompanion(['rescue', '--background', '--fresh', task], {
    cwd: context.workspace, env: { ...context.env, FAKE_ZCODE_RECORD: record }, caller: caller(ownerSessionId),
  });
  const storage = await resolveWorkspaceStorage(context); const jobPath = join(storage.directory, 'jobs', `${reserved.job.id}.json`);
  const job = JSON.parse(await readFile(jobPath, 'utf8'));
  delete job.rescueReservationKind; delete job.rescueExecutionReservation; delete job.rescueJobSpecCommitment;
  await atomicWriteJson(jobPath, job); await downgradeCompanionReservationToOwnerV1(context, job.id);
  const spec = { command: 'rescue', focus: task, task };
  const digest = createHash('sha256').update(JSON.stringify(spec, Object.keys(spec).sort())).digest('hex');
  await atomicWriteJson(join(storage.directory, 'job-specs', `${job.id}.json`), {
    version: 1, jobId: job.id, ownerSessionId: job.ownerSessionId, workspace: job.workspace, digest, spec,
  });
  const capabilityPath = await rewriteLegacyExecutionCapabilityFixture(context, job, digest, reserved.executionCapability);
  return { ...reserved, job, record, capabilityPath };
}

/** @param {any} context */
async function onlyQueuedJobId(context) {
  const storage = await resolveWorkspaceStorage(context); const queued = [];
  for (const name of await readdir(join(storage.directory, 'jobs'))) {
    if (!/^[a-f0-9]{64}\.json$/u.test(name)) continue;
    const job = JSON.parse(await readFile(join(storage.directory, 'jobs', name), 'utf8'));
    if (job.status === 'queued') queued.push(job.id);
  }
  assert.equal(queued.length, 1); return queued[0];
}

/** @param {string} sessionId @param {string} [turnId] */
function caller(sessionId, turnId = `${sessionId}-turn`) { return { sessionId, turnId, permissionMode: 'workspace-write' }; }

/** @param {any} context @param {{parentSessionId:string,parentTurnId:string,childId:string,childTurnId:string,prompt:string}} input */
async function prepareDirectRescueChild(context, input) {
  const parent = { sessionId: input.parentSessionId, turnId: input.parentTurnId, workspace: context.workspace, permissionMode: 'workspace-write', prompt: input.prompt };
  const identity = createIdentityStore({ dataRoot: context.dataRoot });
  const callerContext = await identity.beginCallerTurn(parent);
  const active = await identity.resolveActiveTurn({ sessionId: input.parentSessionId, workspace: context.workspace });
  await markForwarding(context.dataRoot, {
    session_id: input.parentSessionId,
    turn_id: input.childTurnId,
    cwd: context.workspace,
    hook_event_name: 'SubagentStart',
    agent_id: input.childId,
    agent_type: 'zcode-rescue',
  }, active);
  context.env.FAKE_CODEX_THREAD_JSON = JSON.stringify(rawCodexChild({ id: input.childId, parentThreadId: input.parentSessionId, cwd: await realpath(context.workspace) }));
  const preparation = new PassThrough(); preparation.end(`${JSON.stringify({ version: 1, source: 'explicit', task: input.prompt.replace(/^\$zcode:rescue(?:\s+--(?:fresh|resume|wait|background))*\s*/u, ''), options: { execution: 'foreground', resume: 'fresh' } })}\n`);
  assert.deepEqual(await runDirectInvocation(['prepare', 'rescue'], { cwd: context.workspace, env: { ...context.env, CODEX_THREAD_ID: input.parentSessionId }, input: preparation, dependencies: legacyPreparationDependencies }), legacyPreparedRoute);
  return { callerContext, parent };
}

/** @param {any} context @param {{parentSessionId:string,source:'explicit'|'proactive',task:string,options:Record<string,string>}} input */
async function prepareRescueInCurrentTurn(context, input) {
  const preparation = new PassThrough();
  preparation.end(`${JSON.stringify({ version: 1, source: input.source, task: input.task, options: input.options })}\n`);
  return runDirectInvocation(['prepare', 'rescue'], {
    cwd: context.workspace,
    env: { ...context.env, CODEX_THREAD_ID: input.parentSessionId },
    input: preparation,
    dependencies: legacyPreparationDependencies,
  });
}

test('reactivates the exact persisted stopped Rescue child into a fresh linked-worktree ZCode response', async () => {
  const context = await fixture();
  const origin = await realpath(context.workspace);
  const target = await realpath(await addLinkedWorktree(context.workspace, context.directory, 'persisted-child-target'));
  const record = join(context.directory, 'persisted-child-reactivation.jsonl');
  await writeFile(record, '');
  const parentSessionId = 'persisted-parent';
  const childId = 'persisted-child';
  const agentPath = '/root/zcode_rescue_task';
  const identity = createIdentityStore({ dataRoot: context.dataRoot });
  await identity.beginCallerTurn({
    sessionId: parentSessionId, turnId: 'old-parent-turn', workspace: origin,
    permissionMode: 'workspace-write', prompt: '$zcode:rescue --fresh --wait old task',
    sessionStartedAt: '2026-08-23T00:00:00.000Z', sessionSource: 'startup', lifecycleResult: true,
  });
  const routedParent = await identity.resolveActiveTurn({ sessionId: parentSessionId, workspace: target, workspaceBinding: 'claim' });
  await markForwarding(context.dataRoot, {
    session_id: parentSessionId, turn_id: 'persisted-child-turn', cwd: origin,
    hook_event_name: 'SubagentStart', agent_id: childId, agent_type: 'zcode-rescue',
  }, routedParent);
  await markForwarding(context.dataRoot, {
    session_id: parentSessionId, turn_id: 'persisted-child-turn', cwd: origin,
    hook_event_name: 'SubagentStop', agent_id: childId, agent_type: 'zcode-rescue',
  });
  await identity.beginCallerTurn({
    sessionId: parentSessionId, turnId: 'resumed-parent-turn', workspace: target,
    permissionMode: 'workspace-write', prompt: '$zcode:rescue --fresh --wait recovered task',
  });
  const host = {
    id: childId, parentThreadId: parentSessionId, agentPath, agentRole: 'zcode-rescue',
    cwd: origin, status: { type: 'notLoaded' }, createdAt: 1, updatedAt: 2,
  };
  const prepared = await runDirectInvocation(['prepare', 'rescue'], {
    cwd: target, env: { ...context.env, CODEX_THREAD_ID: parentSessionId },
    input: PassThrough.from([`${JSON.stringify({ version: 1, source: 'explicit', task: 'recovered task', options: { execution: 'foreground', resume: 'fresh' } })}\n`]),
    dependencies: {
      planRescueActivation: (/** @type {any} */ input) => planRescueActivation({ ...input, listChildren: async () => [host] }),
    },
  });
  assert.deepEqual(prepared, {
    type: 'prepared', command: 'rescue',
    route: { version: 2, action: 'followup', target: agentPath, assignment: 'zcode-rescue' },
  });

  /** @param {string} ambientChildId @param {()=>Promise<any>} readHost @param {string} code */
  const assertRejectedBeforePipeline = async (ambientChildId, readHost, code) => {
    const callsBefore = await readFile(record, 'utf8');
    const jobsBefore = await createStateStore({ dataRoot: context.dataRoot }).listJobs(target);
    await assert.rejects(runDirectInvocation(['invoke-prepared', 'rescue'], {
      cwd: origin,
      env: { ...context.env, CODEX_THREAD_ID: ambientChildId, FAKE_ZCODE_RECORD: record },
      dependencies: { readCodexThreadSpawnChild: readHost },
    }), { code });
    assert.equal(await readFile(record, 'utf8'), callsBefore);
    assert.deepEqual(await createStateStore({ dataRoot: context.dataRoot }).listJobs(target), jobsBefore);
  };
  const routedStorage = await resolveWorkspaceStorage({ dataRoot: context.dataRoot, workspace: target });
  const [executorName] = (await readdir(join(routedStorage.directory, 'hook-state'))).filter((name) => name.startsWith('executor-'));
  const executorPath = join(routedStorage.directory, 'hook-state', executorName); const executorBytes = await readFile(executorPath);
  const removedExecutorPath = `${executorPath}.removed`; await rename(executorPath, removedExecutorPath);
  await assertRejectedBeforePipeline(childId, async () => host, 'EXECUTOR_ROUTE_INVALID');
  await assert.rejects(stat(executorPath), { code: 'ENOENT' });
  await rename(removedExecutorPath, executorPath);
  await writeFile(executorPath, '{}\n'); const corruptExecutorBytes = await readFile(executorPath);
  await assertRejectedBeforePipeline(childId, async () => host, 'EXECUTOR_ROUTE_INVALID');
  assert.deepEqual(await readFile(executorPath), corruptExecutorBytes);
  await writeFile(executorPath, executorBytes);
  await assertRejectedBeforePipeline('persisted-sibling', async () => host, 'CODEX_CHILD_METADATA_INVALID');
  /** @type {Array<[Record<string,unknown>,string]>} */
  const hostMutations = [
    [{ agentPath: '/root/zcode_rescue_task_2' }, 'RESCUE_PREPARATION_MISMATCH'],
    [{ parentThreadId: 'other-parent' }, 'CODEX_CHILD_METADATA_INVALID'],
    [{ agentRole: null }, 'EXECUTOR_IDENTITY_INVALID'],
    [{ cwd: target }, 'EXECUTOR_IDENTITY_INVALID'],
  ];
  for (const [mutation, code] of hostMutations) await assertRejectedBeforePipeline(childId, async () => ({ ...host, ...mutation }), code);
  const storage = routedStorage;
  const [preparationName] = (await readdir(join(storage.directory, 'invocations', 'prepared'))).filter((name) => name.endsWith('.json'));
  const preparationPath = join(storage.directory, 'invocations', 'prepared', preparationName);
  const preparationBytes = await readFile(preparationPath);
  const preparationRecord = JSON.parse(preparationBytes.toString('utf8'));
  await writeFile(preparationPath, `${JSON.stringify({ ...preparationRecord, permissionMode: 'read-only' }, null, 2)}\n`);
  await assertRejectedBeforePipeline(childId, async () => host, 'RESCUE_PREPARATION_MISMATCH');
  await writeFile(preparationPath, preparationBytes);
  const expiredCreatedAt = new Date(Date.now() - 60 * 60_000).toISOString();
  const expiredAt = new Date(Date.parse(expiredCreatedAt) + 30 * 60_000).toISOString();
  await writeFile(preparationPath, `${JSON.stringify({ ...preparationRecord, createdAt: expiredCreatedAt, expiresAt: expiredAt }, null, 2)}\n`);
  await assertRejectedBeforePipeline(childId, async () => host, 'RESCUE_PREPARATION_EXPIRED');
  await writeFile(preparationPath, preparationBytes);

  const output = await runDirectInvocation(['invoke-prepared', 'rescue'], {
    cwd: origin,
    env: { ...context.env, CODEX_THREAD_ID: childId, FAKE_ZCODE_RECORD: record },
    dependencies: { readCodexThreadSpawnChild: async () => host },
  });
  assert.equal(output.job.status, 'succeeded');
  assert.equal(output.result, 'done');
  const calls = (await readFile(record, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(calls.filter((frame) => frame.method === 'session/create').length, 1);
  assert.equal(calls.filter((frame) => frame.method === 'session/send').length, 1);
  assert.equal(calls.find((frame) => frame.method === 'session/create').params.workspace.workspacePath, target);
  assert.equal((await createStateStore({ dataRoot: context.dataRoot }).listJobs(target)).length, 1);
  await assertRejectedBeforePipeline(childId, async () => host, 'RESCUE_PREPARATION_CONSUMED');
});

test('adopts an exact persisted host-only Rescue child into its linked-worktree ZCode response', async () => {
  const context = await fixture(); const origin = await realpath(context.workspace);
  const target = await realpath(await addLinkedWorktree(context.workspace, context.directory, 'legacy-host-only-target'));
  const record = join(context.directory, 'legacy-host-only.jsonl'); await writeFile(record, '');
  const appServerRecord = join(context.directory, 'legacy-host-only-app-server.jsonl'); await writeFile(appServerRecord, '');
  const parentSessionId = 'legacy-host-parent'; const childId = 'legacy-host-child'; const agentPath = '/root/zcode_rescue_task';
  const identity = createIdentityStore({ dataRoot: context.dataRoot });
  await identity.beginCallerTurn({
    sessionId: parentSessionId, turnId: 'legacy-host-turn', workspace: origin,
    permissionMode: 'workspace-write', prompt: '$zcode:rescue --fresh --wait recover legacy child',
    sessionStartedAt: '2026-08-23T00:00:00.000Z', sessionSource: 'startup', lifecycleResult: true,
  });
  await identity.resolveActiveTurn({ sessionId: parentSessionId, workspace: target, workspaceBinding: 'claim' });
  const rawHost = rawCodexChild({ id: childId, parentThreadId: parentSessionId, cwd: origin, status: { type: 'notLoaded' } });
  const activeRawHost = rawCodexChild({ id: childId, parentThreadId: parentSessionId, cwd: origin });
  const prepared = await runDirectInvocation(['prepare', 'rescue'], {
    cwd: target, env: { ...context.env, CODEX_THREAD_ID: parentSessionId, FAKE_CODEX_RECORD: appServerRecord,
      FAKE_CODEX_THREAD_SPAWN_GRAPH_JSON: JSON.stringify([rawHost]) },
    input: PassThrough.from([`${JSON.stringify({ version: 1, source: 'explicit', task: 'recover legacy child', options: { execution: 'foreground', resume: 'fresh' } })}\n`]),
  });
  assert.deepEqual(prepared, { type: 'prepared', command: 'rescue', route: { version: 2, action: 'followup', target: agentPath, assignment: 'zcode-rescue' } });

  const output = await runDirectInvocation(['invoke-prepared', 'rescue'], {
    cwd: origin, env: { ...context.env, CODEX_THREAD_ID: childId, FAKE_ZCODE_RECORD: record,
      FAKE_CODEX_RECORD: appServerRecord, FAKE_CODEX_THREAD_JSON: JSON.stringify(activeRawHost) },
  });
  assert.equal(output.job.status, 'succeeded'); assert.equal(output.result, 'done');
  const jobs = await createStateStore({ dataRoot: context.dataRoot }).listJobs(target); assert.equal(jobs.length, 1);
  const binding = await createStateStore({ dataRoot: context.dataRoot }).resolveRescueBinding({
    workspace: target, parentSessionId, executorAgentId: childId, permissionMode: 'workspace-write',
  });
  assert.equal(binding.kind, 'bound'); assert.equal(binding.binding.version, 3);
  assert.equal(binding.binding.childAuthority.kind, 'codex-legacy-adoption');
  assert.equal(binding.binding.childAuthority.childAgentId, childId);
  assert.equal(binding.binding.childAuthority.originWorkspace, origin);
  assert.equal(binding.binding.childAuthority.executionWorkspace, target);
  const calls = (await readFile(record, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(calls.filter((frame) => frame.method === 'session/create').length, 1);
  assert.equal(calls.filter((frame) => frame.method === 'session/send').length, 1);
  assert.equal(calls.find((frame) => frame.method === 'session/create').params.workspace.workspacePath, target);
  const codexCalls = (await readFile(appServerRecord, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.deepEqual(codexCalls.filter((frame) => ['thread/list', 'thread/read'].includes(frame.method)).map((frame) => frame.method), ['thread/list', 'thread/read']);
  assert.equal(codexCalls.find((frame) => frame.method === 'thread/list').params.parentThreadId, parentSessionId);
  assert.equal(codexCalls.find((frame) => frame.method === 'thread/read').params.threadId, childId);
  const storage = await resolveWorkspaceStorage({ dataRoot: context.dataRoot, workspace: target });
  assert.deepEqual((await readdir(join(storage.directory, 'hook-state')).catch((error) => error.code === 'ENOENT' ? [] : Promise.reject(error)))
    .filter((name) => name.startsWith('executor-') || name.startsWith('route-')), []);
  const [preparationName] = (await readdir(join(storage.directory, 'invocations', 'prepared'))).filter((name) => name.endsWith('.json'));
  assert.notEqual(JSON.parse(await readFile(join(storage.directory, 'invocations', 'prepared', preparationName), 'utf8')).consumedAt, null);
});

for (const scenario of ['explicit-resume', 'choice-resume', 'choice-fresh']) test(`first host-only adoption ${scenario} adopts the exact existing candidate`, async () => {
  const context = await fixture(); const workspace = await realpath(context.workspace); const store = createStateStore({ dataRoot: context.dataRoot });
  const record = join(context.directory, `legacy-first-candidate-${scenario}.jsonl`); await writeFile(record, '');
  const parentSessionId = `legacy-first-${scenario}-parent`; const childId = `legacy-first-${scenario}-child`; const zcodeSessionId = `legacy-session-${scenario}`;
  const candidate = await store.reserveJob({ workspace, ownerSessionId: parentSessionId, ownerTurnId: 'candidate-turn', command: 'rescue', readOnly: false,
    permissionSnapshot: { permissionMode: 'workspace-write' } });
  await startWritableRescueForTest(store, workspace, candidate, { startedAt: new Date().toISOString(), zcodeSessionId });
  await store.finishJob(workspace, candidate.id, ['running'], 'succeeded');
  const identity = createIdentityStore({ dataRoot: context.dataRoot });
  await identity.beginCallerTurn({ sessionId: parentSessionId, turnId: 'turn-a', workspace, permissionMode: 'workspace-write',
    prompt: '$zcode:rescue recover candidate', sessionStartedAt: '2026-08-23T00:00:00.000Z', sessionSource: 'startup', lifecycleResult: true });
  const host = { id: childId, parentThreadId: parentSessionId, agentPath: '/root/zcode_rescue_task', agentRole: 'zcode-rescue',
    cwd: workspace, status: { type: 'notLoaded' }, createdAt: 1, updatedAt: 2 };
  await runDirectInvocation(['prepare', 'rescue'], { cwd: workspace, env: { ...context.env, CODEX_THREAD_ID: parentSessionId },
    input: PassThrough.from([`${JSON.stringify({ version: 1, source: 'explicit', task: 'recover candidate',
      options: { execution: 'foreground', ...(scenario === 'explicit-resume' ? { resume: 'resume' } : {}) } })}\n`]),
    dependencies: { planRescueActivation: (/** @type {any} */ input) => planRescueActivation({ ...input, listChildren: async () => [host] }) } });
  // A persisted candidate exists outside the fake peer's in-memory session map.
  // Windows intentionally launches that peer from tmpdir, so the fixture must
  // state the candidate's durable workspace instead of inheriting process.cwd().
  const childRuntime = { cwd: workspace, env: { ...context.env, CODEX_THREAD_ID: childId,
    FAKE_ZCODE_RECORD: record, FAKE_ZCODE_WORKSPACE: workspace },
    dependencies: { readCodexThreadSpawnChildIdentity: async () => activatedLegacyHost(host) } };
  let output = await runDirectInvocation(['invoke-prepared', 'rescue'], childRuntime);
  if (scenario !== 'explicit-resume') {
    assert.deepEqual(output, { type: 'needs-choice', choices: ['--resume', '--fresh'] });
    const choice = scenario === 'choice-resume' ? 'resume' : 'fresh';
    output = await runDirectInvocation(['invoke-choice', 'rescue', choice], childRuntime);
    await assert.rejects(runDirectInvocation(['invoke-choice', 'rescue', choice], childRuntime), { code: 'PENDING_INVOCATION_NOT_FOUND' });
  }
  assert.equal(output.job.status, 'succeeded');
  if (scenario === 'choice-fresh') assert.notEqual(output.job.zcodeSessionId, zcodeSessionId);
  else assert.equal(output.job.zcodeSessionId, zcodeSessionId);
  const binding = await store.resolveRescueBinding({ workspace, parentSessionId, executorAgentId: childId, permissionMode: 'workspace-write' });
  assert.equal(binding.kind, 'bound'); assert.equal(binding.binding.version, 3);
  assert.equal(binding.binding.anchorJobId, scenario === 'choice-fresh' ? output.job.id : candidate.id);
  assert.equal(binding.binding.childAuthority.kind, 'codex-legacy-adoption');
  const calls = (await readFile(record, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(calls.filter((frame) => frame.method === 'session/create').length, scenario === 'choice-fresh' ? 1 : 0);
  assert.equal(calls.filter((frame) => frame.method === 'session/resume').length, scenario === 'choice-fresh' ? 0 : 1);
  assert.equal(calls.filter((frame) => frame.method === 'session/send').length, 1);
  const storage = await resolveWorkspaceStorage({ dataRoot: context.dataRoot, workspace });
  assert.deepEqual((await readdir(join(storage.directory, 'hook-state')).catch((error) => error.code === 'ENOENT' ? [] : Promise.reject(error)))
    .filter((name) => name.startsWith('executor-') || name.startsWith('route-')), []);
});

test('legacy adoption continues in same-turn generation two and later-parent generation one', async () => {
  const context = await fixture(); const workspace = await realpath(context.workspace);
  const record = join(context.directory, 'legacy-generations.jsonl'); await writeFile(record, '');
  const parentSessionId = 'legacy-generation-parent'; const childId = 'legacy-generation-child';
  const identity = createIdentityStore({ dataRoot: context.dataRoot });
  await identity.beginCallerTurn({ sessionId: parentSessionId, turnId: 'turn-a', workspace,
    permissionMode: 'workspace-write', prompt: '$zcode:rescue --fresh --wait first legacy task',
    sessionStartedAt: '2026-08-23T00:00:00.000Z', sessionSource: 'startup', lifecycleResult: true });
  const host = { id: childId, parentThreadId: parentSessionId, agentPath: '/root/zcode_rescue_task',
    agentRole: 'zcode-rescue', cwd: workspace, status: { type: 'notLoaded' }, createdAt: 1, updatedAt: 2 };
  /** @param {'explicit'|'proactive'} source @param {string} task */
  const prepare = (source, task) => runDirectInvocation(['prepare', 'rescue'], {
    cwd: workspace, env: { ...context.env, CODEX_THREAD_ID: parentSessionId },
    input: PassThrough.from([`${JSON.stringify({ version: 1, source, task, options: { execution: 'foreground', resume: source === 'explicit' && task === 'first legacy task' ? 'fresh' : 'resume' } })}\n`]),
    dependencies: { planRescueActivation: (/** @type {any} */ input) => planRescueActivation({ ...input, listChildren: async () => [host] }) },
  });
  const invoke = () => runDirectInvocation(['invoke-prepared', 'rescue'], { cwd: workspace,
    env: { ...context.env, CODEX_THREAD_ID: childId, FAKE_ZCODE_RECORD: record },
    dependencies: { readCodexThreadSpawnChildIdentity: async () => activatedLegacyHost(host) } });

  await prepare('explicit', 'first legacy task'); assert.equal((await invoke()).job.status, 'succeeded');
  await prepare('proactive', 'same turn continuation'); assert.equal((await invoke()).job.status, 'succeeded');
  assert.equal((await createStateStore({ dataRoot: context.dataRoot }).listJobs(workspace)).length, 2);
  const preHookStorage = await resolveWorkspaceStorage({ dataRoot: context.dataRoot, workspace });
  assert.deepEqual((await readdir(join(preHookStorage.directory, 'hook-state')).catch((error) => error.code === 'ENOENT' ? [] : Promise.reject(error)))
    .filter((name) => name.startsWith('executor-') || name.startsWith('route-')), []);
  await identity.beginCallerTurn({ sessionId: parentSessionId, turnId: 'turn-b', workspace,
    permissionMode: 'workspace-write', prompt: '$zcode:rescue --resume --wait later turn continuation',
    sessionStartedAt: '2026-08-23T00:00:00.000Z', sessionSource: 'startup', lifecycleResult: true });
  await prepare('explicit', 'later turn continuation');
  const active = await identity.resolveActiveTurn({ sessionId: parentSessionId, workspace, workspaceBinding: 'execution' });
  await markForwarding(context.dataRoot, { session_id: parentSessionId, turn_id: 'turn-b-child-turn', cwd: workspace,
    hook_event_name: 'SubagentStart', agent_id: childId, agent_type: 'zcode-rescue' }, active);
  const hookOutput = await runDirectInvocation(['invoke-prepared', 'rescue'], { cwd: workspace,
    env: { ...context.env, CODEX_THREAD_ID: childId, FAKE_ZCODE_RECORD: record },
    dependencies: { readCodexThreadSpawnChild: async () => ({ ...host, status: { type: 'active', activeFlags: [] }, updatedAt: 3 }) } });
  assert.equal(hookOutput.job.status, 'succeeded');

  const jobs = await createStateStore({ dataRoot: context.dataRoot }).listJobs(workspace); assert.equal(jobs.length, 3);
  const binding = await createStateStore({ dataRoot: context.dataRoot }).resolveRescueBinding({ workspace,
    parentSessionId, executorAgentId: childId, permissionMode: 'workspace-write' });
  assert.equal(binding.kind, 'bound'); assert.equal(binding.binding.currentJobId, jobs.at(-1).id);
  assert.equal(binding.binding.childAuthority.kind, 'codex-legacy-adoption');
  assert.equal(JSON.stringify(binding.binding).includes('codex-legacy-continuation'), false);
});

test('first legacy adoption resumes on a new parent-turn generation one without Hook fabrication', async () => {
  const context = await fixture(); const workspace = await realpath(context.workspace);
  const record = join(context.directory, 'legacy-new-parent.jsonl'); await writeFile(record, '');
  const parentSessionId = 'legacy-new-parent'; const childId = 'legacy-new-parent-child';
  const identity = createIdentityStore({ dataRoot: context.dataRoot });
  await identity.beginCallerTurn({ sessionId: parentSessionId, turnId: 'turn-a', workspace,
    permissionMode: 'workspace-write', prompt: '$zcode:rescue --fresh --wait first',
    sessionStartedAt: '2026-08-23T00:00:00.000Z', sessionSource: 'startup', lifecycleResult: true });
  const host = { id: childId, parentThreadId: parentSessionId, agentPath: '/root/zcode_rescue_task',
    agentRole: 'zcode-rescue', cwd: workspace, status: { type: 'notLoaded' }, createdAt: 1, updatedAt: 2 };
  /** @param {string} task @param {'fresh'|'resume'} resume */
  const prepare = (task, resume) => runDirectInvocation(['prepare', 'rescue'], { cwd: workspace,
    env: { ...context.env, CODEX_THREAD_ID: parentSessionId },
    input: PassThrough.from([`${JSON.stringify({ version: 1, source: 'explicit', task, options: { execution: 'foreground', resume } })}\n`]),
    dependencies: { planRescueActivation: (/** @type {any} */ input) => planRescueActivation({ ...input, listChildren: async () => [host] }) } });
  const invoke = () => runDirectInvocation(['invoke-prepared', 'rescue'], { cwd: workspace,
    env: { ...context.env, CODEX_THREAD_ID: childId, FAKE_ZCODE_RECORD: record },
    dependencies: { readCodexThreadSpawnChildIdentity: async () => activatedLegacyHost(host) } });
  await prepare('first', 'fresh'); const first = await invoke(); assert.equal(first.job.status, 'succeeded');
  const initialBinding = await createStateStore({ dataRoot: context.dataRoot }).resolveRescueBinding({ workspace,
    parentSessionId, executorAgentId: childId, permissionMode: 'workspace-write' });
  assert.equal(initialBinding.kind, 'bound'); const operationId = initialBinding.binding.operationId;
  await createStateStore({ dataRoot: context.dataRoot }).closeRescueBindingForChild({ workspace, parentSessionId, executorAgentId: childId, operationId, reason: 'session-ended' });
  await identity.beginCallerTurn({ sessionId: parentSessionId, turnId: 'turn-b', workspace,
    permissionMode: 'workspace-write', prompt: '$zcode:rescue --resume --wait second',
    sessionStartedAt: '2026-08-23T00:00:00.000Z', sessionSource: 'startup', lifecycleResult: true });
  await prepare('second', 'resume'); const resumed = await invoke(); assert.equal(resumed.job.status, 'succeeded');
  assert.equal(resumed.job.zcodeSessionId, first.job.zcodeSessionId);
  const jobs = await createStateStore({ dataRoot: context.dataRoot }).listJobs(workspace); assert.equal(jobs.length, 2);
  const storage = await resolveWorkspaceStorage({ dataRoot: context.dataRoot, workspace });
  assert.deepEqual((await readdir(join(storage.directory, 'hook-state')).catch((error) => error.code === 'ENOENT' ? [] : Promise.reject(error)))
    .filter((name) => name.startsWith('executor-') || name.startsWith('route-')), []);
  const binding = await createStateStore({ dataRoot: context.dataRoot }).resolveRescueBinding({ workspace,
    parentSessionId, executorAgentId: childId, permissionMode: 'workspace-write' });
  assert.equal(binding.kind, 'bound'); assert.equal(binding.binding.operationId, operationId);
  assert.equal(binding.binding.childAuthority.kind, 'codex-legacy-adoption');
});

test('legacy session-ended migration rolls back its tombstone when exact remote resume is rejected', async () => {
  const context = await fixture(); const workspace = await realpath(context.workspace);
  const badResumeEnv = { ...context.env, FAKE_ZCODE_BAD_SNAPSHOT_METHOD: 'session/resume', FAKE_ZCODE_BAD_SNAPSHOT: 'wrong-workspace' };
  const parentSessionId = 'legacy-resume-rejected-parent'; const childId = 'legacy-resume-rejected-child';
  const identity = createIdentityStore({ dataRoot: context.dataRoot });
  await identity.beginCallerTurn({ sessionId: parentSessionId, turnId: 'turn-a', workspace,
    permissionMode: 'workspace-write', prompt: '$zcode:rescue --fresh --wait first', lifecycleResult: true,
    sessionStartedAt: '2026-08-23T00:00:00.000Z', sessionSource: 'startup' });
  const host = { id: childId, parentThreadId: parentSessionId, agentPath: '/root/zcode_rescue_task',
    agentRole: 'zcode-rescue', cwd: workspace, status: { type: 'notLoaded' }, createdAt: 1, updatedAt: 2 };
  /** @param {string} task @param {'fresh'|'resume'} resume */
  const prepare = (task, resume) => runDirectInvocation(['prepare', 'rescue'], { cwd: workspace,
    env: { ...context.env, CODEX_THREAD_ID: parentSessionId },
    input: PassThrough.from([`${JSON.stringify({ version: 1, source: 'explicit', task, options: { execution: 'foreground', resume } })}\n`]),
    dependencies: { planRescueActivation: (/** @type {any} */ input) => planRescueActivation({ ...input, listChildren: async () => [host] }) } });
  const invoke = (env = badResumeEnv) => runDirectInvocation(['invoke-prepared', 'rescue'], { cwd: workspace,
    env: { ...env, CODEX_THREAD_ID: childId }, dependencies: { readCodexThreadSpawnChildIdentity: async () => activatedLegacyHost(host) } });
  await prepare('first', 'fresh'); const first = await invoke();
  const store = createStateStore({ dataRoot: context.dataRoot });
  const initial = await store.resolveRescueBinding({ workspace, parentSessionId, executorAgentId: childId, permissionMode: 'workspace-write' });
  assert.equal(initial.kind, 'bound');
  const closed = await store.closeRescueBindingForChild({ workspace, parentSessionId, executorAgentId: childId,
    operationId: initial.binding.operationId, reason: 'session-ended' });
  await identity.beginCallerTurn({ sessionId: parentSessionId, turnId: 'turn-b', workspace,
    permissionMode: 'workspace-write', prompt: '$zcode:rescue --resume --wait second', lifecycleResult: true,
    sessionStartedAt: '2026-08-23T00:00:00.000Z', sessionSource: 'startup' });
  await prepare('second', 'resume');
  await assert.rejects(invoke());
  await assert.rejects(store.resolveRescueBinding({ workspace, parentSessionId, executorAgentId: childId }), { code: 'RESCUE_BINDING_CLOSED' });
  const jobs = await store.listJobs(workspace); assert.equal(jobs.length, 2);
  assert.equal(jobs[0].zcodeSessionId, first.job.zcodeSessionId); assert.equal(jobs[1].status, 'failed');
  const proof = await store.resolveRescueBindingForResume({ workspace, parentSessionId, executorAgentId: childId,
    permissionMode: 'workspace-write', migrationProof: legacyMigrationProofForTest(closed.binding) });
  assert.equal(proof.kind, 'bound'); assert.deepEqual(proof.binding, closed.binding);
});

test('reserved execution rejects an old unadvanced adoption before prompt or ZCode mutation', async () => {
  const context = await fixture(); const workspace = await realpath(context.workspace);
  const parentSessionId = 'old-adoption-execution-parent'; const childId = 'old-adoption-execution-child';
  /** @param {string} turn */
  const reservation = (turn) => ({ workspace, ownerSessionId: parentSessionId, ownerTurnId: turn,
    command: 'rescue', readOnly: false, permissionSnapshot: { permissionMode: 'workspace-write' } });
  const store = createStateStore({ dataRoot: context.dataRoot }); const candidate = await store.reserveJob(reservation('candidate'));
  const runningCandidate = await startWritableRescueForTest(store, workspace, candidate, {
    startedAt: new Date().toISOString(), zcodeSessionId: 'old-adoption-zcode-session',
  });
  const completedCandidate = await store.finishJob(workspace, runningCandidate.id, ['running'], 'succeeded');
  const executor = { parentSessionId, parentTurnId: 'adopt', agentId: childId, agentType: 'zcode-rescue',
    agentPath: '/root/zcode_rescue_task', workspace, parentPermissionMode: 'workspace-write' };
  const faulted = createStateStore({ dataRoot: context.dataRoot, testOnlyPublicationHook: async (seam) => {
    if (seam === 'adopt:current-advance') throw new Error('old publisher crashed before current advance');
  } });
  await assert.rejects(faulted.adoptRescueCandidate({ workspace, reservation: reservation('adopt'), executor,
    candidateJobId: candidate.id }), { code: 'RESCUE_PUBLICATION_TEST_FAULT' });
  const adoption = (await store.listJobs(workspace)).find((job) => job.id !== candidate.id);
  const storage = await resolveWorkspaceStorage({ dataRoot: context.dataRoot, workspace });
  const jobPath = join(storage.directory, 'jobs', `${adoption.id}.json`); const oldJob = JSON.parse(await readFile(jobPath, 'utf8'));
  oldJob.rescueContinuationOrigin = { kind: 'legacy-adoption', binding: oldJob.rescueContinuationOrigin.binding };
  delete oldJob.rescueReservationKind; await atomicWriteJson(jobPath, oldJob);
  const ownerRoot = join(storage.directory, 'job-owners'); let ownerBindingPath;
  for (const entry of await readdir(ownerRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[a-f0-9]{64}$/u.test(entry.name)) continue;
    const path = join(ownerRoot, entry.name, `${adoption.id}.json`);
    try { await readFile(path); ownerBindingPath = path; break; } catch (error) { if (/** @type {any} */ (error)?.code !== 'ENOENT') throw error; }
  }
  assert.ok(ownerBindingPath); await atomicWriteJson(ownerBindingPath, {
    jobId: adoption.id, ownerSessionId: parentSessionId, version: 1,
  });
  const spec = { command: 'rescue', task: 'must never reach ZCode', model: 'fake2/other', effort: 'high',
    resumeSessionId: completedCandidate.zcodeSessionId, candidateJobId: candidate.id };
  const digest = createHash('sha256').update(JSON.stringify(spec, Object.keys(spec).sort())).digest('hex');
  await atomicWriteJson(join(storage.directory, 'job-specs', `${adoption.id}.json`), {
    version: 1, jobId: adoption.id, ownerSessionId: parentSessionId, workspace, digest, spec,
  });
  const legacyCapability = await writeLegacyExecutionCapabilityFixture(context, oldJob, digest);
  const rejectedJobBytes = await readFile(jobPath); const rejectedCapabilityBytes = await readFile(legacyCapability.path);
  const record = join(context.directory, 'old-adoption-execution.jsonl'); await writeFile(record, '');
  await assert.rejects(runCompanion(['run-reserved-job', adoption.id], {
    cwd: workspace, env: { ...context.env, FAKE_ZCODE_RECORD: record },
    authorization: { executionCapability: legacyCapability.token, jobId: adoption.id },
  }), { code: 'JOB_SPEC_INVALID' });
  assert.equal(JSON.parse(await readFile(legacyCapability.path, 'utf8')).consumedAt, null);
  assert.deepEqual(await readFile(jobPath), rejectedJobBytes);
  assert.deepEqual(await readFile(legacyCapability.path), rejectedCapabilityBytes);
  await assert.rejects(runCompanion(['run-reserved-job', adoption.id], {
    cwd: workspace, env: { ...context.env, FAKE_ZCODE_RECORD: record },
    authorization: { executionCapability: legacyCapability.token, jobId: adoption.id },
  }), { code: 'JOB_SPEC_INVALID' });
  assert.equal(JSON.parse(await readFile(legacyCapability.path, 'utf8')).consumedAt, null);
  const failed = await store.readJob(workspace, adoption.id); assert.equal(failed.status, 'queued');
  assert.equal(failed.promptArtifact, undefined); assert.equal(failed.logFile, undefined); assert.equal(failed.workerLeaseId, undefined);
  await assert.rejects(stat(join(storage.directory, 'prompts', `${adoption.id}.md`)), { code: 'ENOENT' });
  const rawRequests = (await readFile(record, 'utf8')).trim(); const requests = rawRequests === '' ? [] : rawRequests.split('\n').map((line) => JSON.parse(line));
  assert.equal(requests.some((request) => ['session/resume', 'session/setModel', 'session/setThoughtLevel'].includes(request.method)), false);
});

for (const loneField of ['resumeSessionId', 'candidateJobId']) test(`historical v1 execution rejects lone ${loneField} before capability proof with zero persistent mutation`, async () => {
  const context = await fixture(); const workspace = await realpath(context.workspace);
  const store = createStateStore({ dataRoot: context.dataRoot });
  const job = await store.reserveJob({ workspace, ownerSessionId: `partial-${loneField}-owner`, ownerTurnId: 'turn',
    command: 'rescue', readOnly: false, permissionSnapshot: { permissionMode: 'workspace-write' } });
  await downgradeCompanionReservationToOwnerV1({ dataRoot: context.dataRoot, workspace }, job.id);
  const spec = { command: 'rescue', task: 'must remain private', [loneField]: loneField === 'resumeSessionId' ? 'partial-session' : 'a'.repeat(64) };
  const digest = createHash('sha256').update(JSON.stringify(spec, Object.keys(spec).sort())).digest('hex');
  const storage = await resolveWorkspaceStorage({ dataRoot: context.dataRoot, workspace });
  const jobPath = join(storage.directory, 'jobs', `${job.id}.json`); const jobBefore = await readFile(jobPath);
  const specPath = join(storage.directory, 'job-specs', `${job.id}.json`); await mkdir(dirname(specPath), { recursive: true, mode: 0o700 });
  await atomicWriteJson(specPath, { version: 1, jobId: job.id, ownerSessionId: job.ownerSessionId, workspace, digest, spec });
  const specBefore = await readFile(specPath); const nonexistentCapability = randomBytes(32).toString('base64url');
  await assert.rejects(runCompanion(['run-reserved-job', job.id], {
    cwd: workspace, env: context.env,
    authorization: { executionCapability: nonexistentCapability, jobId: job.id },
  }), { code: 'JOB_SPEC_INVALID' });
  assert.deepEqual(await readFile(jobPath), jobBefore); assert.deepEqual(await readFile(specPath), specBefore);
  const capabilityPath = join(storage.directory, 'identity', 'capabilities',
    `${createHash('sha256').update(nonexistentCapability).digest('hex')}.json`);
  await assert.rejects(stat(capabilityPath), { code: 'ENOENT' });
});

test('concurrent same-capability loser cannot terminalize the winner claimed queued job', async () => {
  const context = await fixture(); const record = join(context.directory, 'same-capability-race.jsonl'); await writeFile(record, '');
  const reserved = await runCompanion(['rescue', '--background', '--fresh', 'single winning execution'], {
    cwd: context.workspace, env: { ...context.env, FAKE_ZCODE_RECORD: record }, caller: caller('same-capability-owner'),
  });
  /** @type {()=>void} */ let releaseWinnerClaim = () => {}; /** @type {()=>void} */ let releaseLoserClaim = () => {};
  /** @type {()=>void} */ let releaseWinnerCommit = () => {}; /** @type {()=>void} */ let winnerReady = () => {};
  /** @type {()=>void} */ let loserReady = () => {}; /** @type {()=>void} */ let winnerClaimed = () => {};
  const allowWinnerClaim = new Promise((resolve) => { releaseWinnerClaim = () => resolve(undefined); });
  const allowLoserClaim = new Promise((resolve) => { releaseLoserClaim = () => resolve(undefined); });
  const allowWinnerCommit = new Promise((resolve) => { releaseWinnerCommit = () => resolve(undefined); });
  const winnerAtClaim = new Promise((resolve) => { winnerReady = () => resolve(undefined); });
  const loserAtClaim = new Promise((resolve) => { loserReady = () => resolve(undefined); });
  const winnerHasClaim = new Promise((resolve) => { winnerClaimed = () => resolve(undefined); });
  const invocation = { cwd: context.workspace, env: { ...context.env, FAKE_ZCODE_RECORD: record },
    authorization: { executionCapability: reserved.executionCapability, jobId: reserved.job.id } };
  const winner = runCompanion(reserved.privateInvocation, { ...invocation, dependencies: {
    testOnlyBeforeExecutionClaim: async () => { winnerReady(); await allowWinnerClaim; },
    testOnlyAfterStateClaimBeforeCapabilityCommit: async () => { winnerClaimed(); await allowWinnerCommit; },
  } });
  const loser = runCompanion(reserved.privateInvocation, { ...invocation, dependencies: {
    testOnlyBeforeExecutionClaim: async () => { loserReady(); await allowLoserClaim; },
  } });
  await Promise.all([winnerAtClaim, loserAtClaim]); releaseWinnerClaim();
  try {
    await Promise.race([winnerHasClaim, new Promise((_, reject) => setTimeout(() => reject(new Error('winner did not pause after StateStore claim')), 2_000))]);
    releaseLoserClaim();
    await assert.rejects(loser, { code: 'WORKER_LEASE_CONFLICT' });
    const claimed = await createStateStore({ dataRoot: context.dataRoot }).readJob(context.workspace, reserved.job.id);
    assert.equal(claimed.status, 'queued'); assert.ok(claimed.workerLeaseId); assert.ok(claimed.rescueExecutionClaim);
  } finally { releaseLoserClaim(); releaseWinnerCommit(); }
  const result = await winner; assert.equal(result.job.status, 'succeeded');
  const requests = (await readFile(record, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(requests.filter((request) => request.method === 'session/create').length, 1);
  assert.equal(requests.filter((request) => request.method === 'session/send').length, 1);
});

test('same-capability loser keeps the winner reservation when failure reconciliation cannot read State', async () => {
  const context = await fixture(); const record = join(context.directory, 'same-capability-read-failure.jsonl'); await writeFile(record, '');
  const reserved = await runCompanion(['rescue', '--background', '--fresh', 'winner survives reconciliation read failure'], {
    cwd: context.workspace, env: { ...context.env, FAKE_ZCODE_RECORD: record }, caller: caller('same-capability-read-failure-owner'),
  });
  const baseStore = createStateStore({ dataRoot: context.dataRoot }); let reconciliationReads = 0; let ordinaryReads = 0;
  const readFailure = new Error('injected reconciliation read failure');
  const unreadableStore = { ...baseStore, finishJobAfterExecutionClaimFailure: async () => {
    reconciliationReads += 1; throw readFailure;
  }, readJob: async (/** @type {string} */ workspace, /** @type {string} */ jobId) => {
    ordinaryReads += 1;
    if (ordinaryReads === 1) return baseStore.readJob(workspace, jobId);
    reconciliationReads += 1; throw readFailure;
  } };
  /** @type {()=>void} */ let releaseWinnerClaim = () => {}; /** @type {()=>void} */ let releaseLoserClaim = () => {};
  /** @type {()=>void} */ let releaseWinnerCommit = () => {}; /** @type {()=>void} */ let winnerReady = () => {};
  /** @type {()=>void} */ let loserReady = () => {}; /** @type {()=>void} */ let winnerClaimed = () => {};
  const allowWinnerClaim = new Promise((resolve) => { releaseWinnerClaim = () => resolve(undefined); });
  const allowLoserClaim = new Promise((resolve) => { releaseLoserClaim = () => resolve(undefined); });
  const allowWinnerCommit = new Promise((resolve) => { releaseWinnerCommit = () => resolve(undefined); });
  const winnerAtClaim = new Promise((resolve) => { winnerReady = () => resolve(undefined); });
  const loserAtClaim = new Promise((resolve) => { loserReady = () => resolve(undefined); });
  const winnerHasClaim = new Promise((resolve) => { winnerClaimed = () => resolve(undefined); });
  const invocation = { cwd: context.workspace, env: { ...context.env, FAKE_ZCODE_RECORD: record },
    authorization: { executionCapability: reserved.executionCapability, jobId: reserved.job.id } };
  const winner = runCompanion(reserved.privateInvocation, { ...invocation, dependencies: {
    testOnlyBeforeExecutionClaim: async () => { winnerReady(); await allowWinnerClaim; },
    testOnlyAfterStateClaimBeforeCapabilityCommit: async () => { winnerClaimed(); await allowWinnerCommit; },
  } });
  const loser = runCompanion(reserved.privateInvocation, { ...invocation, dependencies: {
    createStateStore: () => unreadableStore,
    testOnlyBeforeExecutionClaim: async () => { loserReady(); await allowLoserClaim; },
  } });
  await Promise.all([winnerAtClaim, loserAtClaim]); releaseWinnerClaim();
  try {
    await winnerHasClaim; releaseLoserClaim();
    await assert.rejects(loser, { code: 'WORKER_LEASE_CONFLICT' }); assert.ok(reconciliationReads >= 1);
    const storage = await resolveWorkspaceStorage({ dataRoot: context.dataRoot, workspace: context.workspace });
    const capabilityPath = join(storage.directory, 'identity', 'capabilities',
      `${createHash('sha256').update(reserved.executionCapability).digest('hex')}.json`);
    const capability = JSON.parse(await readFile(capabilityPath, 'utf8'));
    assert.equal(capability.consumedAt, null); assert.ok(capability.executionReservationId);
  } finally { releaseLoserClaim(); releaseWinnerCommit(); }
  const result = await winner; assert.equal(result.job.status, 'succeeded');
});

test('post-rename execution claim failure reconciles its persisted lease and releases capability reservation', async () => {
  const context = await fixture(); const record = join(context.directory, 'claim-post-rename-failure.jsonl'); await writeFile(record, '');
  const reserved = await runCompanion(['rescue', '--background', '--fresh', 'must not execute after ambiguous claim commit'], {
    cwd: context.workspace, env: { ...context.env, FAKE_ZCODE_RECORD: record }, caller: caller('claim-post-rename-owner'),
  });
  const injected = new Error('injected chmod/fsync failure after claim rename'); let injectedWrites = 0;
  const faultedStore = createStateStore({ dataRoot: context.dataRoot, testOnlyExecutionClaimWriteOptions: {
    testOnlyAfterRename: async () => { injectedWrites += 1; throw injected; },
  } });
  await assert.rejects(runCompanion(reserved.privateInvocation, {
    cwd: context.workspace, env: { ...context.env, FAKE_ZCODE_RECORD: record },
    authorization: { executionCapability: reserved.executionCapability, jobId: reserved.job.id },
    dependencies: { createStateStore: () => faultedStore },
  }), { code: 'ATOMIC_WRITE_FAILED' });
  assert.equal(injectedWrites, 1); assert.equal((await readFile(record, 'utf8')).trim(), '');
  const store = createStateStore({ dataRoot: context.dataRoot }); const terminal = await store.readJob(context.workspace, reserved.job.id);
  assert.equal(terminal.status, 'failed'); assert.equal(terminal.rescueExecutionClaim, undefined);
  const storage = await resolveWorkspaceStorage({ dataRoot: context.dataRoot, workspace: context.workspace });
  const capabilityPath = join(storage.directory, 'identity', 'capabilities',
    `${createHash('sha256').update(reserved.executionCapability).digest('hex')}.json`);
  const capability = JSON.parse(await readFile(capabilityPath, 'utf8'));
  assert.equal(capability.consumedAt, null); assert.equal(capability.executionReservationId, undefined);
  await context.identity.revokeExecutionCapability(reserved.executionCapability, { jobId: reserved.job.id,
    ownerSessionId: reserved.job.ownerSessionId, workspace: context.workspace, operation: 'run-reserved-job', jobSpecFormat: 'sealed-v2' });
});

test('unreadable ambiguous own claim remains reserved until terminal recovery and retry release it', async () => {
  const context = await fixture(); const record = join(context.directory, 'claim-unreadable-recovery.jsonl'); await writeFile(record, '');
  const reserved = await runCompanion(['rescue', '--background', '--fresh', 'recover ambiguous own claim'], {
    cwd: context.workspace, env: { ...context.env, FAKE_ZCODE_RECORD: record }, caller: caller('claim-unreadable-recovery-owner'),
  });
  const injected = new Error('injected post-rename failure'); const unreadable = new Error('injected reconciliation read failure');
  const faultedBase = createStateStore({ dataRoot: context.dataRoot, testOnlyExecutionClaimWriteOptions: {
    testOnlyAfterRename: async () => { throw injected; },
  } });
  const faultedStore = { ...faultedBase, finishJobAfterExecutionClaimFailure: async () => { throw unreadable; } };
  await assert.rejects(runCompanion(reserved.privateInvocation, {
    cwd: context.workspace, env: { ...context.env, FAKE_ZCODE_RECORD: record },
    authorization: { executionCapability: reserved.executionCapability, jobId: reserved.job.id },
    dependencies: { createStateStore: () => faultedStore },
  }), { code: 'ATOMIC_WRITE_FAILED' });
  const store = createStateStore({ dataRoot: context.dataRoot }); const claimed = await store.readJob(context.workspace, reserved.job.id);
  assert.equal(claimed.status, 'queued'); assert.ok(claimed.rescueExecutionClaim);
  const storage = await resolveWorkspaceStorage({ dataRoot: context.dataRoot, workspace: context.workspace });
  const capabilityPath = join(storage.directory, 'identity', 'capabilities',
    `${createHash('sha256').update(reserved.executionCapability).digest('hex')}.json`);
  assert.ok(JSON.parse(await readFile(capabilityPath, 'utf8')).executionReservationId);
  await store.finishJob(context.workspace, reserved.job.id, ['queued'], 'failed', { error: { message: 'orphan recovery' }, exitCode: 1 });
  await assert.rejects(runCompanion(reserved.privateInvocation, {
    cwd: context.workspace, env: context.env,
    authorization: { executionCapability: reserved.executionCapability, jobId: reserved.job.id },
  }), { code: 'RESERVED_JOB_NOT_QUEUED' });
  assert.equal(JSON.parse(await readFile(capabilityPath, 'utf8')).executionReservationId, undefined);
  await context.identity.revokeExecutionCapability(reserved.executionCapability, { jobId: reserved.job.id,
    ownerSessionId: reserved.job.ownerSessionId, workspace: context.workspace, operation: 'run-reserved-job', jobSpecFormat: 'sealed-v2' });
});

test('detached ambiguous claim recovery releases its reservation without retaining the bearer token', {
  skip: process.platform === 'win32' ? 'real detached worker failure evidence is required' : false,
}, async () => {
  const context = await fixture(); const workspace = await realpath(context.workspace);
  const marker = join(context.directory, 'ambiguous-detached-claim.json');
  await assert.rejects(runCompanion(['rescue', '--background', '--fresh', 'detached reservation cleanup'], {
    cwd: workspace, env: { ...context.env, ZCODE_TEST_DATA_ROOT: context.dataRoot, ZCODE_TEST_CLAIM_MARKER: marker },
    caller: caller('ambiguous-detached-owner'), autoLaunchBackground: true,
    dependencies: { startBackgroundWorker: (/** @type {any} */ input) => startBackgroundWorker({
      ...input, companionPath: ambiguousClaimWorker, timeoutMs: 5_000,
    }) },
  }), { code: 'BACKGROUND_WORKER_START_FAILED' });
  const published = JSON.parse(await readFile(marker, 'utf8'));
  assert.equal(published.code, 'ATOMIC_WRITE_FAILED', `${published.stage}: ${published.error}`);
  const store = createStateStore({ dataRoot: context.dataRoot });
  const failed = await store.readJob(workspace, published.jobId);
  assert.equal(failed.status, 'failed'); assert.match(failed.workerLeaseId, /^[a-f0-9]{64}$/u);
  assert.equal(failed.rescueExecutionReservation.workerLeaseId, failed.workerLeaseId);
  const rendered = renderOutput({ job: { ...failed, owned: true, owner: 'same-owner' } }, { json: true });
  assert.doesNotMatch(rendered, /rescueExecutionReservation|capabilityDigest|reservationId/u);
  const storage = await resolveWorkspaceStorage({ dataRoot: context.dataRoot, workspace });
  const capabilityNames = (await readdir(join(storage.directory, 'identity', 'capabilities')))
    .filter((name) => /^[a-f0-9]{64}\.json$/u.test(name));
  assert.equal(capabilityNames.length, 1);
  const capabilityPath = join(storage.directory, 'identity', 'capabilities', capabilityNames[0]);
  const stranded = JSON.parse(await readFile(capabilityPath, 'utf8'));
  assert.ok(stranded.executionReservationId); assert.equal(stranded.consumedAt, null);
  await scavengeWritableJobs({ store, dataRoot: context.dataRoot, workspace,
    createClient: async () => { throw new Error('terminal reservation cleanup must not start ZCode'); } });
  const released = JSON.parse(await readFile(capabilityPath, 'utf8'));
  assert.equal(released.executionReservationId, undefined); assert.equal(released.consumedAt, null);
  const recovered = await store.readJob(workspace, published.jobId);
  assert.equal(recovered.status, 'failed'); assert.equal(recovered.rescueExecutionReservation, undefined);
});

test('reserved execution losing revoke race before its atomic claim has no prompt or ZCode side effects', async () => {
  const context = await fixture(); const workspace = await realpath(context.workspace);
  const parentSessionId = 'execution-claim-race-parent'; const childId = 'execution-claim-race-child';
  /** @param {string} turn */
  const reservation = (turn) => ({ workspace, ownerSessionId: parentSessionId, ownerTurnId: turn,
    command: 'rescue', readOnly: false, permissionSnapshot: { permissionMode: 'workspace-write' } });
  const executor = { parentSessionId, parentTurnId: 'origin', agentId: childId, agentType: 'zcode-rescue',
    agentPath: '/root/zcode_rescue_task', workspace, parentPermissionMode: 'workspace-write' };
  const store = createStateStore({ dataRoot: context.dataRoot });
  const first = await store.reserveFreshRescueJob({ workspace, reservation: reservation('first'), executor });
  await startWritableRescueForTest(store, workspace, first.job, {
    startedAt: new Date().toISOString(), zcodeSessionId: 'execution-claim-race-session',
  });
  await store.finishJob(workspace, first.job.id, ['running'], 'succeeded');
  const continuation = await store.reserveBoundRescueContinuation({ workspace, reservation: reservation('second'),
    executor, operationId: first.binding.operationId });
  const spec = { command: 'rescue', task: 'must not cross revoked claim', model: 'fake2/other', effort: 'high',
    resumeSessionId: 'execution-claim-race-session', candidateJobId: first.job.id };
  const { capability, storage } = await publishSealedSpecForTest(context, store, workspace, continuation.job, spec);
  const record = join(context.directory, 'execution-claim-race.jsonl'); await writeFile(record, '');
  let revoked = false;
  await assert.rejects(runCompanion(['run-reserved-job', continuation.job.id], {
    cwd: workspace, env: { ...context.env, FAKE_ZCODE_RECORD: record },
    authorization: { executionCapability: capability, jobId: continuation.job.id },
    dependencies: { testOnlyBeforeExecutionClaim: async () => {
      revoked = true;
      await store.closeRescueBindingForChild({ workspace, parentSessionId, executorAgentId: childId,
        operationId: continuation.binding.operationId, reason: 'invalidated' });
    } },
  }), { code: 'RESCUE_BINDING_INVALID' });
  assert.equal(revoked, true);
  const failed = await store.readJob(workspace, continuation.job.id);
  assert.equal(failed.status, 'failed'); assert.equal(failed.workerLeaseId, undefined);
  assert.equal(failed.promptArtifact, undefined); assert.equal(failed.logFile, undefined);
  await assert.rejects(stat(join(storage.directory, 'prompts', `${continuation.job.id}.md`)), { code: 'ENOENT' });
  const rawRequests = (await readFile(record, 'utf8')).trim();
  const requests = rawRequests === '' ? [] : rawRequests.split('\n').map((line) => JSON.parse(line));
  assert.equal(requests.some((request) => ['session/create', 'session/resume', 'session/setModel',
    'session/setThoughtLevel', 'session/send'].includes(request.method)), false);
  const capabilityPath = join(storage.directory, 'identity', 'capabilities',
    `${createHash('sha256').update(capability).digest('hex')}.json`);
  const reusableCapability = JSON.parse(await readFile(capabilityPath, 'utf8'));
  assert.equal(reusableCapability.consumedAt, null); assert.equal(reusableCapability.executionReservationId, undefined);
});

test('reserved execution winning its atomic claim remains authorized across a later binding revoke', async () => {
  const context = await fixture(); const workspace = await realpath(context.workspace);
  const parentSessionId = 'execution-claim-winner-parent'; const childId = 'execution-claim-winner-child';
  /** @param {string} turn */
  const reservation = (turn) => ({ workspace, ownerSessionId: parentSessionId, ownerTurnId: turn,
    command: 'rescue', readOnly: false, permissionSnapshot: { permissionMode: 'workspace-write' } });
  const executor = { parentSessionId, parentTurnId: 'origin', agentId: childId, agentType: 'zcode-rescue',
    agentPath: '/root/zcode_rescue_task', workspace, parentPermissionMode: 'workspace-write' };
  const store = createStateStore({ dataRoot: context.dataRoot });
  const first = await store.reserveFreshRescueJob({ workspace, reservation: reservation('first'), executor });
  await startWritableRescueForTest(store, workspace, first.job, {
    startedAt: new Date().toISOString(), zcodeSessionId: 'execution-claim-winner-session',
  });
  await store.finishJob(workspace, first.job.id, ['running'], 'succeeded');
  const continuation = await store.reserveBoundRescueContinuation({ workspace, reservation: reservation('second'),
    executor, operationId: first.binding.operationId });
  const spec = { command: 'rescue', task: 'claim winner remains bounded', model: 'fake2/other', effort: 'xhigh',
    resumeSessionId: 'execution-claim-winner-session', candidateJobId: first.job.id };
  const { capability } = await publishSealedSpecForTest(context, store, workspace, continuation.job, spec);
  const record = join(context.directory, 'execution-claim-winner.jsonl'); await writeFile(record, '');
  let revoked = false;
  const result = await runCompanion(['run-reserved-job', continuation.job.id], {
    cwd: workspace, env: { ...context.env, FAKE_ZCODE_RECORD: record, FAKE_ZCODE_RESULT: 'claim winner result' },
    authorization: { executionCapability: capability, jobId: continuation.job.id },
    dependencies: { testOnlyAfterExecutionClaim: async () => {
      revoked = true;
      await store.closeRescueBindingForChild({ workspace, parentSessionId, executorAgentId: childId,
        operationId: continuation.binding.operationId, reason: 'invalidated' });
    } },
  });
  assert.equal(revoked, true); assert.equal(result.job.status, 'succeeded');
  assert.equal(result.job.rescueExecutionClaim, undefined);
  const requests = (await readFile(record, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(requests.filter((request) => request.method === 'session/resume').length, 1);
  assert.equal(requests.filter((request) => request.method === 'session/send').length, 1);
  await assert.rejects(store.resolveRescueBinding({ workspace, parentSessionId, executorAgentId: childId }),
    { code: 'RESCUE_BINDING_CLOSED' });
});

test('background revoke-first persists no plaintext task or focus before its execution claim', async () => {
  const context = await fixture(); const workspace = await realpath(context.workspace);
  const parentSessionId = 'sealed-revoke-parent'; const childId = 'sealed-revoke-child';
  const executor = { parentSessionId, parentTurnId: 'origin', agentId: childId, agentType: 'zcode-rescue',
    agentPath: '/root/zcode_rescue_task', workspace, parentPermissionMode: 'workspace-write' };
  const secretTask = 'REVOKE_FIRST_PRIVATE_TASK_7f194c';
  const reserved = await runCompanion(['rescue', '--background', '--fresh', secretTask], {
    cwd: workspace, env: context.env, caller: caller(parentSessionId), executor,
  });
  assert.doesNotMatch(JSON.stringify(reserved), /rescueExecutionReservation|rescueJobSpecCommitment|rescueLegacyJobSpecProof/u);
  const storage = await resolveWorkspaceStorage({ dataRoot: context.dataRoot, workspace });
  const specPath = join(storage.directory, 'job-specs', `${reserved.job.id}.json`);
  const beforeClaim = await readFile(specPath, 'utf8');
  assert.doesNotMatch(beforeClaim, new RegExp(secretTask)); assert.doesNotMatch(beforeClaim, /"(?:task|focus)"/u);
  const binding = await createStateStore({ dataRoot: context.dataRoot }).resolveRescueBinding({
    workspace, parentSessionId, executorAgentId: childId,
  });
  assert.equal(binding.kind, 'bound');
  const record = join(context.directory, 'sealed-revoke-first.jsonl'); await writeFile(record, '');
  await assert.rejects(runCompanion(reserved.privateInvocation, {
    cwd: workspace, env: { ...context.env, FAKE_ZCODE_RECORD: record },
    authorization: { executionCapability: reserved.executionCapability, jobId: reserved.job.id },
    dependencies: { testOnlyBeforeExecutionClaim: async () => {
      await createStateStore({ dataRoot: context.dataRoot }).closeRescueBindingForChild({ workspace, parentSessionId,
        executorAgentId: childId, operationId: binding.binding.operationId, reason: 'invalidated' });
    } },
  }), { code: 'RESCUE_BINDING_INVALID' });
  const denied = await createStateStore({ dataRoot: context.dataRoot }).readJob(workspace, reserved.job.id);
  assert.equal(denied.status, 'failed'); assert.equal(denied.rescueExecutionClaim, undefined); assert.equal(denied.promptArtifact, undefined);
  assert.equal((await readFile(record, 'utf8')).trim(), '');
  await assert.rejects(stat(join(storage.directory, 'prompts', `${reserved.job.id}.md`)), { code: 'ENOENT' });
});

test('background claim-first opens its private task only after claim and executes it exactly', async () => {
  const context = await fixture(); const secretTask = 'CLAIM_FIRST_PRIVATE_TASK_903e2a';
  const record = join(context.directory, 'sealed-claim-first.jsonl'); await writeFile(record, '');
  const reserved = await runCompanion(['rescue', '--background', '--fresh', secretTask], {
    cwd: context.workspace, env: { ...context.env, FAKE_ZCODE_RECORD: record }, caller: caller('sealed-claim-owner'),
  });
  const storage = await resolveWorkspaceStorage(context); const specPath = join(storage.directory, 'job-specs', `${reserved.job.id}.json`);
  const beforeClaim = await readFile(specPath, 'utf8');
  assert.doesNotMatch(beforeClaim, new RegExp(secretTask)); assert.doesNotMatch(beforeClaim, /"(?:task|focus)"/u);
  let claimed = false;
  const result = await runCompanion(reserved.privateInvocation, {
    cwd: context.workspace, env: { ...context.env, FAKE_ZCODE_RECORD: record },
    authorization: { executionCapability: reserved.executionCapability, jobId: reserved.job.id },
    dependencies: { testOnlyAfterExecutionClaim: async () => { claimed = true; } },
  });
  assert.equal(claimed, true); assert.equal(result.job.status, 'succeeded');
  assert.doesNotMatch(await readFile(specPath, 'utf8'), new RegExp(secretTask));
  const requests = (await readFile(record, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.match(JSON.stringify(requests.find((request) => request.method === 'session/send')), new RegExp(secretTask));
});

test('claimed background crash terminalizes without exposing its sealed task', async () => {
  const context = await fixture(); const secretTask = 'CLAIMED_CRASH_PRIVATE_TASK_55d681';
  const reserved = await runCompanion(['rescue', '--background', '--fresh', secretTask], {
    cwd: context.workspace, env: context.env, caller: caller('sealed-crash-owner'),
  });
  const crash = new Error('injected crash after claim');
  await assert.rejects(runCompanion(reserved.privateInvocation, {
    cwd: context.workspace, env: context.env,
    authorization: { executionCapability: reserved.executionCapability, jobId: reserved.job.id },
    dependencies: { testOnlyAfterExecutionClaim: async () => { throw crash; } },
  }), (error) => error === crash);
  const store = createStateStore({ dataRoot: context.dataRoot }); const failed = await store.readJob(context.workspace, reserved.job.id);
  assert.equal(failed.status, 'failed'); assert.equal(failed.rescueExecutionClaim, undefined);
  const storage = await resolveWorkspaceStorage(context);
  assert.doesNotMatch(await readFile(join(storage.directory, 'job-specs', `${reserved.job.id}.json`), 'utf8'), new RegExp(secretTask));
});

test('background resume with model remains sealed and revoke-first performs no RPC', async () => {
  const context = await fixture(); const workspace = await realpath(context.workspace);
  const parentSessionId = 'sealed-resume-parent'; const childId = 'sealed-resume-child';
  const executor = { parentSessionId, parentTurnId: 'origin', agentId: childId, agentType: 'zcode-rescue',
    agentPath: '/root/zcode_rescue_task', workspace, parentPermissionMode: 'workspace-write' };
  const record = join(context.directory, 'sealed-resume-model.jsonl'); await writeFile(record, '');
  const first = await runCompanion(['rescue', '--fresh', 'establish sealed resume'], {
    cwd: workspace, env: { ...context.env, FAKE_ZCODE_RECORD: record }, caller: caller(parentSessionId), executor,
  });
  await writeFile(record, '');
  const task = 'PRIVATE_RESUME_TASK_21af7d'; const model = 'fake2/other';
  const reserved = await runCompanion(['rescue', '--background', '--resume', '--model', model, task], {
    cwd: workspace, env: { ...context.env, FAKE_ZCODE_RECORD: record }, caller: caller(parentSessionId), executor,
  });
  const storage = await resolveWorkspaceStorage({ dataRoot: context.dataRoot, workspace });
  const specPath = join(storage.directory, 'job-specs', `${reserved.job.id}.json`); const raw = await readFile(specPath, 'utf8');
  const envelope = JSON.parse(raw); const normalized = { command: 'rescue', focus: task, task, model,
    resumeSessionId: first.job.zcodeSessionId, candidateJobId: first.job.id };
  const plaintextDigest = createHash('sha256').update(JSON.stringify(normalized, Object.keys(normalized).sort())).digest('hex');
  assert.match(envelope.commitment, /^[a-f0-9]{64}$/u); assert.notEqual(envelope.commitment, plaintextDigest);
  assert.doesNotMatch(raw, new RegExp(task)); assert.doesNotMatch(raw, new RegExp(model.replace('/', '\\/')));
  assert.doesNotMatch(raw, new RegExp(first.job.zcodeSessionId)); assert.doesNotMatch(raw, /"(?:task|focus|model|resumeSessionId|candidateJobId|digest)"/u);
  const active = await createStateStore({ dataRoot: context.dataRoot }).resolveRescueBinding({ workspace, parentSessionId, executorAgentId: childId });
  assert.equal(active.kind, 'bound');
  await assert.rejects(runCompanion(reserved.privateInvocation, {
    cwd: workspace, env: { ...context.env, FAKE_ZCODE_RECORD: record },
    authorization: { executionCapability: reserved.executionCapability, jobId: reserved.job.id },
    dependencies: { testOnlyBeforeExecutionClaim: async () => {
      await createStateStore({ dataRoot: context.dataRoot }).closeRescueBindingForChild({ workspace, parentSessionId,
        executorAgentId: childId, operationId: active.binding.operationId, reason: 'invalidated' });
    } },
  }), { code: 'RESCUE_BINDING_INVALID' });
  assert.equal((await readFile(record, 'utf8')).trim(), '');
  await assert.rejects(stat(join(storage.directory, 'prompts', `${reserved.job.id}.md`)), { code: 'ENOENT' });
});

test('bearer cannot re-seal a valid replacement task model effort resume and candidate with the same capability', async () => {
  const context = await fixture(); const workspace = await realpath(context.workspace);
  const parentSessionId = 'reseal-parent'; const childId = 'reseal-child';
  const executor = { parentSessionId, parentTurnId: 'origin', agentId: childId, agentType: 'zcode-rescue',
    agentPath: '/root/zcode_rescue_task', workspace, parentPermissionMode: 'workspace-write' };
  const record = join(context.directory, 'reseal-rpc.jsonl'); await writeFile(record, '');
  const anchor = await runCompanion(['rescue', '--fresh', 'establish exact anchor'], {
    cwd: workspace, env: { ...context.env, FAKE_ZCODE_RECORD: record }, caller: caller(parentSessionId), executor,
  });
  const store = createStateStore({ dataRoot: context.dataRoot });
  const foreignCandidate = await store.reserveJob({ workspace, ownerSessionId: parentSessionId, ownerTurnId: 'foreign-candidate',
    command: 'rescue', readOnly: false, permissionSnapshot: { permissionMode: 'workspace-write' } });
  const foreignRunning = await startWritableRescueForTest(store, workspace, foreignCandidate, {
    startedAt: new Date().toISOString(), zcodeSessionId: 'reseal-foreign-session',
  });
  await store.finishJob(workspace, foreignRunning.id, ['running'], 'succeeded');
  await writeFile(record, '');
  const reserved = await runCompanion(['rescue', '--background', '--resume', 'original sealed continuation'], {
    cwd: workspace, env: { ...context.env, FAKE_ZCODE_RECORD: record }, caller: caller(parentSessionId), executor,
  });
  assert.equal(anchor.job.zcodeSessionId === foreignRunning.zcodeSessionId, false);
  const replacement = { command: 'rescue', focus: 'FORGED_RESEALED_TASK', task: 'FORGED_RESEALED_TASK',
    model: 'fake2/other', effort: 'xhigh', resumeSessionId: foreignRunning.zcodeSessionId, candidateJobId: foreignRunning.id };
  const storage = await resolveWorkspaceStorage({ dataRoot: context.dataRoot, workspace });
  await atomicWriteJson(join(storage.directory, 'job-specs', `${reserved.job.id}.json`),
    resealJobSpecForTest(reserved.job, replacement, reserved.executionCapability));
  await assert.rejects(runCompanion(reserved.privateInvocation, {
    cwd: workspace, env: { ...context.env, FAKE_ZCODE_RECORD: record },
    authorization: { executionCapability: reserved.executionCapability, jobId: reserved.job.id },
  }), { code: 'RESCUE_BINDING_INVALID' });
  const denied = await store.readJob(workspace, reserved.job.id);
  assert.equal(denied.status, 'queued'); assert.equal(denied.rescueExecutionClaim, undefined); assert.equal(denied.promptArtifact, undefined);
  assert.equal((await readFile(record, 'utf8')).trim(), '');
});

test('legacy-v1 execution capability cannot be newly issued for a modern reservation', async () => {
  const context = await fixture(); const reserved = await runCompanion(['rescue', '--background', '--fresh', 'modern sealed task'], {
    cwd: context.workspace, env: context.env, caller: caller('legacy-label-owner'),
  });
  await assert.rejects(context.identity.createExecutionCapability(/** @type {any} */ ({ jobId: reserved.job.id,
    ownerSessionId: reserved.job.ownerSessionId, workspace: context.workspace, operation: 'run-reserved-job',
    jobSpecFormat: 'legacy-v1', specDigest: 'a'.repeat(64), permissionSnapshot: reserved.job.permissionSnapshot })),
  { code: 'IDENTITY_INPUT_INVALID' });
});

for (const mutation of ['unknown-version', 'sealed-to-v1', 'v1-extra-field']) test(`background ${mutation} job-spec mutation fails closed before execution`, async () => {
  const context = await fixture(); const task = `PRIVATE_${mutation.toUpperCase().replaceAll('-', '_')}_TASK`;
  const record = join(context.directory, `${mutation}.jsonl`); await writeFile(record, '');
  const reserved = await runCompanion(['rescue', '--background', '--fresh', task], {
    cwd: context.workspace, env: { ...context.env, FAKE_ZCODE_RECORD: record }, caller: caller(`${mutation}-owner`),
  });
  const storage = await resolveWorkspaceStorage(context); const path = join(storage.directory, 'job-specs', `${reserved.job.id}.json`);
  const originalRecord = JSON.parse(await readFile(path, 'utf8'));
  const spec = { command: 'rescue', focus: task, task };
  const digest = createHash('sha256').update(JSON.stringify(spec, Object.keys(spec).sort())).digest('hex');
  await atomicWriteJson(path, { version: mutation === 'unknown-version' ? 99 : 1, jobId: reserved.job.id,
    ownerSessionId: reserved.job.ownerSessionId, workspace: await realpath(context.workspace), digest, spec,
    ...(mutation === 'v1-extra-field' ? { unexpected: true } : {}) });
  await assert.rejects(runCompanion(reserved.privateInvocation, {
    cwd: context.workspace, env: { ...context.env, FAKE_ZCODE_RECORD: record },
    authorization: { executionCapability: reserved.executionCapability, jobId: reserved.job.id },
  }), (error) => ['JOB_SPEC_TAMPERED', 'EXECUTION_CAPABILITY_MISMATCH'].includes(/** @type {any} */ (error)?.code));
  const denied = await createStateStore({ dataRoot: context.dataRoot }).readJob(context.workspace, reserved.job.id);
  assert.equal(denied.status, 'queued'); assert.equal(denied.rescueExecutionClaim, undefined); assert.equal(denied.promptArtifact, undefined);
  assert.equal((await readFile(record, 'utf8')).trim(), '');
  if (mutation === 'sealed-to-v1') {
    await atomicWriteJson(path, originalRecord);
    const recovered = await runCompanion(reserved.privateInvocation, {
      cwd: context.workspace, env: { ...context.env, FAKE_ZCODE_RECORD: record },
      authorization: { executionCapability: reserved.executionCapability, jobId: reserved.job.id },
    });
    assert.equal(recovered.job.status, 'succeeded');
  }
});

test('historical untyped capability cannot downgrade a modern sealed reservation to v1', async () => {
  const context = await fixture(); const task = 'PRIVATE_UNTYPED_DOWNGRADE_TASK';
  const record = join(context.directory, 'untyped-downgrade.jsonl'); await writeFile(record, '');
  const reserved = await runCompanion(['rescue', '--background', '--fresh', task], {
    cwd: context.workspace, env: { ...context.env, FAKE_ZCODE_RECORD: record }, caller: caller('untyped-downgrade-owner'),
  });
  const spec = { command: 'rescue', focus: task, task };
  const digest = createHash('sha256').update(JSON.stringify(spec, Object.keys(spec).sort())).digest('hex');
  const oldCapability = await writeLegacyExecutionCapabilityFixture(context, reserved.job, digest);
  const storage = await resolveWorkspaceStorage(context); await atomicWriteJson(join(storage.directory, 'job-specs', `${reserved.job.id}.json`), {
    version: 1, jobId: reserved.job.id, ownerSessionId: reserved.job.ownerSessionId,
    workspace: await realpath(context.workspace), digest, spec,
  });
  await assert.rejects(runCompanion(reserved.privateInvocation, {
    cwd: context.workspace, env: { ...context.env, FAKE_ZCODE_RECORD: record },
    authorization: { executionCapability: oldCapability.token, jobId: reserved.job.id },
  }), { code: 'RESCUE_BINDING_INVALID' });
  const denied = await createStateStore({ dataRoot: context.dataRoot }).readJob(context.workspace, reserved.job.id);
  assert.equal(denied.status, 'queued'); assert.equal(denied.rescueExecutionClaim, undefined); assert.equal(denied.promptArtifact, undefined);
  assert.equal((await readFile(record, 'utf8')).trim(), '');
});

for (const settlement of ['controller', 'orphan recovery']) test(`hard crash after commitment and before job-spec publication is safely terminalized by ${settlement}`, {
  skip: process.platform === 'win32' ? 'POSIX SIGKILL evidence is required' : false,
}, async (t) => {
  const context = await fixture(); const workspace = await realpath(context.workspace);
  const ownerSessionId = `commitment-crash-${settlement.replace(' ', '-')}`; const task = `PRIVATE_COMMITMENT_CRASH_${settlement.replace(' ', '_')}`;
  const marker = join(context.directory, `commitment-crash-${settlement.replace(' ', '-')}.json`);
  const child = spawn(process.execPath, [commitmentPublicationCrash], { cwd: workspace,
    env: { ...context.env, ZCODE_TEST_DATA_ROOT: context.dataRoot, ZCODE_TEST_WORKSPACE: workspace,
      ZCODE_TEST_MARKER: marker, ZCODE_TEST_OWNER: ownerSessionId, ZCODE_TEST_TASK: task },
    stdio: ['ignore', 'pipe', 'pipe'], shell: false });
  let exited = false; const childExit = new Promise((resolve, reject) => {
    child.once('error', reject); child.once('exit', (code, signal) => { exited = true; resolve({ code, signal }); });
  });
  t.after(async () => { if (!exited) child.kill('SIGKILL'); await childExit.catch(() => {}); });
  await waitFor(async () => { try { return Boolean(JSON.parse(await readFile(marker, 'utf8')).jobId); } catch { return false; } },
    'publisher did not reach the commitment-before-spec crash seam');
  const published = JSON.parse(await readFile(marker, 'utf8'));
  child.kill('SIGKILL'); const exit = await childExit; assert.equal(exit.signal, 'SIGKILL');
  const store = createStateStore({ dataRoot: context.dataRoot }); const queued = await store.readJob(workspace, published.jobId);
  assert.equal(queued.status, 'queued'); assert.match(queued.rescueJobSpecCommitment, /^[a-f0-9]{64}$/u);
  assert.doesNotMatch(JSON.stringify(queued), new RegExp(task)); assert.equal(queued.promptArtifact, undefined);
  const storage = await resolveWorkspaceStorage({ dataRoot: context.dataRoot, workspace });
  await assert.rejects(stat(join(storage.directory, 'job-specs', `${queued.id}.json`)), { code: 'ENOENT' });
  await assert.rejects(stat(join(storage.directory, 'prompts', `${queued.id}.md`)), { code: 'ENOENT' });
  const terminal = settlement === 'controller'
    ? await createJobController({ store, dataRoot: context.dataRoot }).cancel(workspace, queued.id, ownerSessionId)
    : (await scavengeWritableJobs({ store, dataRoot: context.dataRoot, workspace,
      now: () => Date.parse(queued.createdAt) + 6 * 60_000, createClient: async () => { throw new Error('must not start ZCode'); } })).at(-1);
  assert.ok(['cancelled', 'failed'].includes(terminal.status));
  const persisted = await store.readJob(workspace, queued.id);
  assert.equal(persisted.rescueJobSpecCommitment, undefined); assert.equal(persisted.rescueExecutionClaim, undefined);
  assert.equal(persisted.promptArtifact, undefined); assert.doesNotMatch(JSON.stringify(persisted), new RegExp(task));
});

test('detached worker death after claim and before decrypt is recovered without task execution', { skip: process.platform === 'win32' ? 'POSIX SIGKILL evidence is required' : false }, async (t) => {
  const context = await fixture(); const workspace = await realpath(context.workspace); const ownerSessionId = 'sealed-kill-owner';
  const task = 'DETACHED_PRIVATE_TASK_5f7a92'; const rpcRecord = join(context.directory, 'sealed-kill-rpc.jsonl'); await writeFile(rpcRecord, '');
  const reserved = await runCompanion(['rescue', '--background', '--fresh', task], {
    cwd: workspace, env: { ...context.env, FAKE_ZCODE_RECORD: rpcRecord }, caller: caller(ownerSessionId),
  });
  const marker = join(context.directory, 'sealed-worker-claimed.json');
  const started = await startBackgroundWorker({ companionPath: claimedSealedWorker, jobId: reserved.job.id,
    executionCapability: reserved.executionCapability, cwd: workspace,
    env: { ...context.env, FAKE_ZCODE_RECORD: rpcRecord, ZCODE_TEST_CLAIM_MARKER: marker } });
  assert.ok(started.pid); const workerPid = started.pid;
  let exited = false; t.after(async () => { if (!exited && processAlive(workerPid)) try { process.kill(workerPid, 'SIGKILL'); } catch { /* exited */ } });
  await waitFor(async () => { try { return JSON.parse(await readFile(marker, 'utf8')).pid === workerPid; } catch { return false; } }, 'detached worker did not persist its post-claim marker');
  const store = createStateStore({ dataRoot: context.dataRoot }); const claimed = await store.readJob(workspace, reserved.job.id);
  assert.equal(claimed.status, 'queued'); assert.equal(claimed.childPid, workerPid); assert.ok(claimed.rescueExecutionClaim);
  process.kill(workerPid, 'SIGKILL'); exited = await waitForProcessExit(workerPid, 2_000); assert.equal(exited, true);
  let clients = 0; await scavengeWritableJobs({ store, dataRoot: context.dataRoot, workspace,
    createClient: async () => { clients += 1; throw new Error('claimed queued recovery must not start ZCode'); } });
  const recovered = await store.readJob(workspace, reserved.job.id);
  assert.equal(recovered.status, 'failed'); assert.equal(recovered.rescueExecutionClaim, undefined); assert.equal(recovered.promptArtifact, undefined);
  assert.equal(clients, 0); assert.equal((await readFile(rpcRecord, 'utf8')).trim(), '');
  const storage = await resolveWorkspaceStorage({ dataRoot: context.dataRoot, workspace });
  const rawSpec = await readFile(join(storage.directory, 'job-specs', `${reserved.job.id}.json`), 'utf8'); assert.doesNotMatch(rawSpec, new RegExp(task));
  await assert.rejects(stat(join(storage.directory, 'prompts', `${reserved.job.id}.md`)), { code: 'ENOENT' });
});

test('foreground production execution claims an exact owner-v1 classless unbound Rescue', async () => {
  const context = await fixture(); const record = join(context.directory, 'legacy-classless-foreground.jsonl');
  await writeFile(record, ''); let downgradedJobId;
  const result = await runCompanion(['rescue', '--fresh', 'legacy foreground claim'], {
    cwd: context.workspace, env: { ...context.env, FAKE_ZCODE_RECORD: record }, caller: caller('legacy-foreground'),
    dependencies: { testOnlyBeforeExecutionInspection: async () => {
      downgradedJobId = await onlyQueuedJobId(context);
      await downgradeCompanionReservationToOwnerV1(context, downgradedJobId);
    } },
  });
  assert.equal(result.job.id, downgradedJobId); assert.equal(result.job.status, 'succeeded');
  assert.equal(result.job.rescueExecutionClaim, undefined); assert.equal(result.job.rescueReservationKind, undefined);
  const requests = (await readFile(record, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(requests.filter((request) => request.method === 'session/create').length, 1);
  assert.equal(requests.filter((request) => request.method === 'session/send').length, 1);
});

test('background production execution claims an exact owner-v1 classless v2-bound Rescue', async () => {
  const context = await fixture(); const workspace = await realpath(context.workspace);
  const parentSessionId = 'legacy-background-parent'; const childId = 'legacy-background-child';
  const executor = { parentSessionId, parentTurnId: 'origin', agentId: childId, agentType: 'zcode-rescue',
    agentPath: '/root/zcode_rescue_task', workspace, parentPermissionMode: 'workspace-write' };
  const record = join(context.directory, 'legacy-classless-background.jsonl'); await writeFile(record, '');
  const reserved = await runCompanion(['rescue', '--background', '--fresh', 'legacy background claim'], {
    cwd: workspace, env: { ...context.env, FAKE_ZCODE_RECORD: record }, caller: caller(parentSessionId), executor,
  });
  await downgradeCompanionReservationToOwnerV1(context, reserved.job.id, 2);
  const result = await runCompanion(reserved.privateInvocation, {
    cwd: workspace, env: { ...context.env, FAKE_ZCODE_RECORD: record },
    authorization: { executionCapability: reserved.executionCapability, jobId: reserved.job.id },
  });
  assert.equal(result.job.id, reserved.job.id); assert.equal(result.job.status, 'succeeded');
  assert.equal(result.job.rescueExecutionClaim, undefined); assert.equal(result.job.rescueReservationKind, undefined);
  const requests = (await readFile(record, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(requests.filter((request) => request.method === 'session/create').length, 1);
  assert.equal(requests.filter((request) => request.method === 'session/send').length, 1);
});

test('two real historical-v1 workers with the same inspection elect one State-fence winner', async (t) => {
  const context = await fixture(); const historical = await historicalV1BackgroundFixture(
    context, 'historical v1 concurrent fence', 'legacy-v1-fence-race');
  const reachedA = join(context.directory, 'legacy-v1-a-reached.json'); const releaseA = join(context.directory, 'legacy-v1-a-release');
  const reachedB = join(context.directory, 'legacy-v1-b-reached.json'); const releaseB = join(context.directory, 'legacy-v1-b-release');
  const workerA = spawnLegacyFenceWorker(context, historical.job.id, historical.executionCapability, {
    ZCODE_TEST_FENCE_STAGE: 'before-fence', ZCODE_TEST_FENCE_REACHED: reachedA,
    ZCODE_TEST_FENCE_RELEASE: releaseA, FAKE_ZCODE_RECORD: historical.record,
  });
  const workerB = spawnLegacyFenceWorker(context, historical.job.id, historical.executionCapability, {
    ZCODE_TEST_FENCE_STAGE: 'before-fence', ZCODE_TEST_FENCE_REACHED: reachedB,
    ZCODE_TEST_FENCE_RELEASE: releaseB, FAKE_ZCODE_RECORD: historical.record,
  });
  let aExited = false; let bExited = false; void workerA.exit.then(() => { aExited = true; });
  void workerB.exit.then(() => { bExited = true; });
  t.after(() => { if (!aExited) workerA.child.kill('SIGKILL'); if (!bExited) workerB.child.kill('SIGKILL'); });
  await Promise.all([
    waitFor(() => stat(reachedA).then(() => true).catch(() => false), 'worker A did not reach its pre-fence gate'),
    waitFor(() => stat(reachedB).then(() => true).catch(() => false), 'worker B did not reach its pre-fence gate'),
  ]);
  const [markerA, markerB] = await Promise.all([readFile(reachedA, 'utf8').then(JSON.parse), readFile(reachedB, 'utf8').then(JSON.parse)]);
  assert.equal(markerA.inspection, markerB.inspection); assert.notEqual(markerA.workerLeaseId, markerB.workerLeaseId);
  const store = createStateStore({ dataRoot: context.dataRoot }); const inspected = await store.readJob(context.workspace, historical.job.id);
  const inspectedOutput = renderOutput({ job: { ...inspected, owned: true, owner: 'same-owner' } }, { json: true });
  assert.doesNotMatch(inspectedOutput, /rescueExecutionReservation|capabilityDigest|reservationId|workerLeaseId|specDigest/u);
  await Promise.all([writeFile(releaseA, 'release\n'), writeFile(releaseB, 'release\n')]);
  const exits = await Promise.all([workerA.exit, workerB.exit]); aExited = true; bExited = true;
  const [winner] = exits.filter((result) => result.code === 0); const [loser] = exits.filter((result) => result.code !== 0);
  assert.ok(winner); assert.ok(loser); assert.match(loser.stderr, /(?:WORKER_LEASE_CONFLICT|RESCUE_BINDING_INVALID)/u);
  const succeeded = await store.readJob(context.workspace, historical.job.id);
  assert.equal(succeeded.status, 'succeeded'); assert.equal(succeeded.rescueExecutionReservation, undefined);
  const capability = JSON.parse(await readFile(historical.capabilityPath, 'utf8')); assert.ok(capability.consumedAt);
  const requests = (await readFile(historical.record, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(requests.filter((request) => request.method === 'session/create').length, 1);
  assert.equal(requests.filter((request) => request.method === 'session/send').length, 1);
});

test('live pre-Identity historical-v1 fence survives grace then SIGKILL is bearerlessly scavenged twice', {
  skip: process.platform === 'win32' ? 'real detached SIGKILL evidence is required' : false,
}, async (t) => {
  const context = await fixture(); const historical = await historicalV1BackgroundFixture(
    context, 'historical v1 crash fence', 'legacy-v1-fence-crash');
  const reached = join(context.directory, 'legacy-v1-crash-reached.json'); const release = join(context.directory, 'legacy-v1-crash-release');
  let bearer = historical.executionCapability;
  const worker = spawnLegacyFenceWorker(context, historical.job.id, bearer, {
    ZCODE_TEST_FENCE_STAGE: 'after-fence', ZCODE_TEST_FENCE_REACHED: reached,
    ZCODE_TEST_FENCE_RELEASE: release, FAKE_ZCODE_RECORD: historical.record,
  });
  bearer = undefined; delete historical.executionCapability;
  let exited = false; void worker.exit.then(() => { exited = true; });
  t.after(() => { if (!exited) worker.child.kill('SIGKILL'); });
  await waitFor(() => stat(reached).then(() => true).catch(() => false), 'crash worker did not reach its post-fence pre-Identity gate');
  const marker = JSON.parse(await readFile(reached, 'utf8')); const store = createStateStore({ dataRoot: context.dataRoot });
  const fenced = await store.readJob(context.workspace, historical.job.id);
  assert.equal(fenced.rescueExecutionReservation.workerLeaseId, marker.workerLeaseId);
  assert.equal(JSON.parse(await readFile(historical.capabilityPath, 'utf8')).executionReservationId, undefined);
  const rendered = renderOutput({ job: { ...fenced, owned: true, owner: 'same-owner' } }, { json: true });
  assert.doesNotMatch(rendered, /rescueExecutionReservation|capabilityDigest|reservationId|workerLeaseId|specDigest/u);
  const recover = () => scavengeWritableJobs({ store, dataRoot: context.dataRoot, workspace: context.workspace,
    now: () => Date.now() + 10 * 60_000,
    createClient: async () => { throw new Error('queued v1 fence recovery must not start ZCode'); } });
  await recover();
  const retained = await store.readJob(context.workspace, historical.job.id);
  assert.equal(retained.status, 'queued'); assert.equal(retained.rescueExecutionReservation.workerLeaseId, marker.workerLeaseId);
  assert.equal(JSON.parse(await readFile(historical.capabilityPath, 'utf8')).executionReservationId, undefined);
  worker.child.kill('SIGKILL'); await worker.exit; exited = true;
  await recover(); await recover();
  const terminal = await store.readJob(context.workspace, historical.job.id);
  assert.equal(terminal.status, 'failed'); assert.equal(terminal.rescueExecutionReservation, undefined);
  const capability = JSON.parse(await readFile(historical.capabilityPath, 'utf8'));
  assert.equal(capability.consumedAt, null); assert.equal(capability.executionReservationId, undefined);
  assert.equal((await readFile(historical.record, 'utf8')).trim(), '');
  assert.equal(bearer, undefined);
});

test('background interruption after claim preserves the binding revoke and terminalizes without ZCode RPC', async () => {
  const context = await fixture(); const workspace = await realpath(context.workspace);
  const parentSessionId = 'execution-claim-cancel-parent'; const childId = 'execution-claim-cancel-child';
  /** @param {string} turn */
  const reservation = (turn) => ({ workspace, ownerSessionId: parentSessionId, ownerTurnId: turn,
    command: 'rescue', readOnly: false, permissionSnapshot: { permissionMode: 'workspace-write' } });
  const executor = { parentSessionId, parentTurnId: 'origin', agentId: childId, agentType: 'zcode-rescue',
    agentPath: '/root/zcode_rescue_task', workspace, parentPermissionMode: 'workspace-write' };
  const store = createStateStore({ dataRoot: context.dataRoot });
  const first = await store.reserveFreshRescueJob({ workspace, reservation: reservation('first'), executor });
  const firstClaim = await store.claimJobWorkerForExecution(workspace, first.job.id, {
    childPid: 999_999_999, workerLeaseId: '7'.repeat(64),
  });
  await store.transitionJob(workspace, first.job.id, ['queued'], 'running', {
    startedAt: new Date().toISOString(), zcodeSessionId: 'execution-claim-cancel-session',
    childPid: firstClaim.childPid, workerLeaseId: firstClaim.workerLeaseId,
  });
  await store.finishJob(workspace, first.job.id, ['running'], 'succeeded');
  const continuation = await store.reserveBoundRescueContinuation({ workspace, reservation: reservation('second'),
    executor, operationId: first.binding.operationId });
  const spec = { command: 'rescue', task: 'cancel after claim', model: 'fake2/other', effort: 'xhigh',
    resumeSessionId: 'execution-claim-cancel-session', candidateJobId: first.job.id };
  const { capability } = await publishSealedSpecForTest(context, store, workspace, continuation.job, spec);
  const controller = new AbortController(); const interruption = new PluginError('JOB_INTERRUPTED', 'cancel after claim');
  const record = join(context.directory, 'execution-claim-cancel.jsonl'); await writeFile(record, '');
  const observed = /** @type {{closed:any}} */ ({ closed: null });
  await assert.rejects(runCompanion(['run-reserved-job', continuation.job.id], {
    cwd: workspace, env: { ...context.env, FAKE_ZCODE_RECORD: record }, signal: controller.signal,
    authorization: { executionCapability: capability, jobId: continuation.job.id },
    dependencies: { testOnlyAfterExecutionClaim: async () => {
      observed.closed = await store.closeRescueBindingForChild({ workspace, parentSessionId, executorAgentId: childId,
        operationId: continuation.binding.operationId, reason: 'invalidated' });
      controller.abort(interruption);
    } },
  }), (error) => error === interruption);
  const cancelled = await store.readJob(workspace, continuation.job.id);
  assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.rescueExecutionClaim, undefined);
  assert.ok(observed.closed);
  const repeated = await store.closeRescueBindingForChild({ workspace, parentSessionId, executorAgentId: childId,
    operationId: continuation.binding.operationId, reason: 'invalidated' });
  assert.deepEqual(repeated.binding, observed.closed.binding);
  assert.equal((await readFile(record, 'utf8')).trim(), '');
});

for (const failurePoint of ['spec write', 'capability write', 'worker launch', 'worker crash', 'legacy worker execution', 'durable marker v1 downgrade', 'legacy recovery', 'corrupt legacy worker execution', 'missing legacy worker evidence', 'missing legacy worker evidence and binding']) test(['corrupt legacy worker execution', 'missing legacy worker evidence', 'missing legacy worker evidence and binding'].includes(failurePoint)
  ? `background execution rejects ${failurePoint === 'corrupt legacy worker execution' ? 'corrupt markerless legacy rollback metadata' : failurePoint === 'missing legacy worker evidence' ? 'missing markerless legacy rollback evidence' : 'missing markerless rollback evidence and binding'} without terminalizing its queued job`
  : `background session-ended migration restores its closed tombstone when ${failurePoint} fails`, async () => {
  const context = await fixture(); const workspace = await realpath(context.workspace);
  const record = join(context.directory, `background-migration-${failurePoint.replace(' ', '-')}.jsonl`); await writeFile(record, '');
  const parentSessionId = `background-migration-${failurePoint.replace(' ', '-')}-parent`;
  const childId = `background-migration-${failurePoint.replace(' ', '-')}-child`; const childTurnId = `${childId}-turn`;
  await prepareDirectRescueChild(context, {
    parentSessionId, parentTurnId: 'turn-a', childId, childTurnId,
    prompt: '$zcode:rescue --fresh --wait establish background migration',
  });
  const childEnv = { ...context.env, CODEX_THREAD_ID: childId, FAKE_ZCODE_RECORD: record };
  const first = await runDirectInvocation(['invoke-prepared', 'rescue'], { cwd: workspace, env: childEnv });
  assert.equal(first.job.status, 'succeeded');
  await markForwarding(context.dataRoot, {
    session_id: parentSessionId, turn_id: childTurnId, cwd: workspace,
    hook_event_name: 'SubagentStop', agent_id: childId, agent_type: 'zcode-rescue',
  });
  const identity = createIdentityStore({ dataRoot: context.dataRoot }); const store = createStateStore({ dataRoot: context.dataRoot });
  const active = await store.resolveRescueBinding({ workspace, parentSessionId, executorAgentId: childId });
  assert.equal(active.kind, 'bound');
  const closed = await store.closeRescueBindingForChild({ workspace, parentSessionId, executorAgentId: childId,
    operationId: active.binding.operationId, reason: 'session-ended' });
  assert.equal(closed.kind, 'closed');
  const storage = await resolveWorkspaceStorage({ dataRoot: context.dataRoot, workspace });
  const [partitionName] = (await readdir(storage.directory)).filter((name) => name.startsWith('rescue-binding-session-'));
  const partitionPath = join(storage.directory, partitionName);
  const historicalMarkerless = ['legacy worker execution', 'legacy recovery', 'corrupt legacy worker execution',
    'missing legacy worker evidence', 'missing legacy worker evidence and binding'].includes(failurePoint);
  if (historicalMarkerless) {
    const partition = JSON.parse(await readFile(partitionPath, 'utf8')); const current = partition.records[0];
    const v2 = { ...current, version: 2, childAuthority: { ...current.childAuthority } };
    delete v2.superseded; delete v2.childAuthority.agentPath;
    await atomicWriteJson(partitionPath, createRescueBindingPartition({ parentSessionId, workspace, records: [v2] }));
  }
  const closedTombstoneBytes = await readFile(partitionPath);
  await identity.beginCallerTurn({ sessionId: parentSessionId, turnId: 'turn-b', workspace, permissionMode: 'workspace-write',
    prompt: '$zcode:rescue --background --resume continue after SessionEnd' });
  const host = { id: childId, parentThreadId: parentSessionId, agentPath: '/root/zcode_rescue_task', agentRole: 'zcode-rescue',
    cwd: workspace, status: { type: 'notLoaded' }, createdAt: 1, updatedAt: 5 };
  /** @param {'foreground'|'background'} execution */
  const prepare = (execution) => runDirectInvocation(['prepare', 'rescue'], {
    cwd: workspace, env: { ...context.env, CODEX_THREAD_ID: parentSessionId },
    input: PassThrough.from([`${JSON.stringify({ version: 1, source: 'explicit', task: 'continue after SessionEnd', options: { execution, resume: 'resume' } })}\n`]),
    dependencies: { planRescueActivation: (/** @type {any} */ input) => planRescueActivation({ ...input, listChildren: async () => [host] }) },
  });
  assert.deepEqual(await prepare('background'), { type: 'prepared', command: 'rescue',
    route: { version: 2, action: 'followup', target: host.agentPath, assignment: 'zcode-rescue' } });
  const failure = new Error(`${failurePoint} failed before resume`);
  const failureDependency = failurePoint === 'spec write'
    ? { writeJobSpec: async () => { throw failure; } }
    : failurePoint === 'capability write'
      ? { createExecutionCapability: async () => { throw failure; } }
      : failurePoint === 'worker launch'
        ? { startBackgroundWorker: async () => { throw failure; } }
      : { startBackgroundWorker: async (/** @type {any} */ { jobId }) => {
        if (['worker crash', 'legacy recovery'].includes(failurePoint)) {
          const current = await store.readJob(workspace, jobId); const workerLeaseId = '9'.repeat(64);
          await store.bindJobExecutionReservationLease(workspace, jobId, {
            capabilityDigest: current.rescueExecutionReservation.capabilityDigest,
            reservationId: current.rescueExecutionReservation.reservationId, workerLeaseId,
          });
          await store.claimJobWorker(workspace, jobId, { childPid: 999_999_999, workerLeaseId });
        }
      } };
  const attempt = runDirectInvocation(['invoke-prepared', 'rescue'], {
    cwd: workspace, env: childEnv,
    dependencies: { readCodexThreadSpawnChild: async () => host, ...failureDependency },
  });
  if (['worker crash', 'legacy worker execution', 'durable marker v1 downgrade', 'legacy recovery', 'corrupt legacy worker execution', 'missing legacy worker evidence', 'missing legacy worker evidence and binding'].includes(failurePoint)) {
    const queued = await attempt; assert.equal(queued.type, 'background');
    assert.doesNotMatch(JSON.stringify(queued), /rescueMigrationRollback|rescueReservationKind|priorCurrentJobId|priorClosedAt/u);
    if (failurePoint === 'worker crash') {
      const status = await runCompanion(['status', '--all'], { cwd: workspace, env: childEnv,
        caller: { sessionId: parentSessionId, turnId: 'turn-b', permissionMode: 'workspace-write' } });
      assert.doesNotMatch(JSON.stringify(status), /rescueMigrationRollback|migrationPrior|priorCurrentJobId|priorClosedAt/u);
    }
    const specPath = join(storage.directory, 'job-specs', `${(await store.listJobs(workspace))[1].id}.json`);
    let specRecord = JSON.parse(await readFile(specPath, 'utf8'));
    const queuedJobPath = join(storage.directory, 'jobs', `${queued.job.id}.json`);
    const queuedJob = JSON.parse(await readFile(queuedJobPath, 'utf8'));
    if (failurePoint === 'worker crash') {
      assert.equal(specRecord.version, 2); assert.equal(specRecord.spec, undefined);
      assert.doesNotMatch(JSON.stringify(specRecord), /continue after SessionEnd/u);
      await scavengeWritableJobs({ store, dataRoot: context.dataRoot, workspace, createClient: async () => { throw failure; } });
    } else {
      const rollback = queuedJob.rescueMigrationRollback; assert.ok(rollback);
      const legacySpec = { command: 'rescue', focus: 'continue after SessionEnd', task: 'continue after SessionEnd',
        resumeSessionId: first.job.zcodeSessionId, candidateJobId: first.job.id };
      specRecord = { version: 1, jobId: queued.job.id, ownerSessionId: parentSessionId, workspace, spec: legacySpec };
      if (!failurePoint.startsWith('missing legacy worker evidence')) Object.assign(specRecord.spec, {
          migrationParentSessionId: rollback.parentSessionId, migrationChildAgentId: rollback.childAgentId,
          migrationOperationId: rollback.operationId, migrationPriorCurrentJobId: failurePoint === 'corrupt legacy worker execution' ? 'f'.repeat(64) : rollback.priorCurrentJobId,
          migrationPriorUpdatedAt: rollback.priorUpdatedAt, migrationPriorClosedAt: rollback.priorClosedAt,
          migrationPriorVersion: String(rollback.priorVersion),
        });
      specRecord.digest = createHash('sha256').update(JSON.stringify(specRecord.spec, Object.keys(specRecord.spec).sort())).digest('hex');
      await atomicWriteJson(specPath, specRecord);
      if (failurePoint !== 'durable marker v1 downgrade') {
        delete queuedJob.rescueMigrationRollback;
        delete queuedJob.rescueExecutionReservation;
        delete queuedJob.rescueJobSpecCommitment;
      }
      await atomicWriteJson(queuedJobPath, queuedJob);
      if (historicalMarkerless) await downgradeCompanionReservationToOwnerV1({ dataRoot: context.dataRoot, workspace }, queued.job.id);
      if (failurePoint === 'missing legacy worker evidence and binding') {
        for (const name of await readdir(storage.directory)) if (/^rescue-binding-(?:authority|session)-[a-f0-9]{64}\.json$/u.test(name)) await unlink(join(storage.directory, name));
      }
      if (failurePoint === 'legacy recovery') {
        await scavengeWritableJobs({ store, dataRoot: context.dataRoot, workspace, createClient: async () => { throw failure; } });
      } else {
        const capability = await writeLegacyExecutionCapabilityFixture({ dataRoot: context.dataRoot }, queuedJob, specRecord.digest);
        await releaseManagedZCodeOwner({ dataRoot: context.dataRoot, workspace, ownerId: ownerIdForSession(parentSessionId), requestTimeoutMs: 500 });
        /** @type {any} */ let executionError;
        await assert.rejects(runCompanion(['run-reserved-job', queued.job.id], {
          cwd: workspace, env: { ...childEnv, FAKE_ZCODE_BAD_SNAPSHOT_METHOD: 'session/resume', FAKE_ZCODE_BAD_SNAPSHOT: 'wrong-workspace' },
          authorization: { executionCapability: capability.token, jobId: queued.job.id },
        }), (error) => { executionError = error; return failurePoint === 'durable marker v1 downgrade'
          ? /** @type {any} */ (error)?.code === 'JOB_SPEC_INVALID'
          : failurePoint === 'missing legacy worker evidence and binding'
            ? /** @type {any} */ (error)?.code === 'RESCUE_BINDING_INVALID'
          : ['corrupt legacy worker execution', 'missing legacy worker evidence', 'missing legacy worker evidence and binding'].includes(failurePoint)
            ? /** @type {any} */ (error)?.code === 'JOB_SPEC_INVALID' : true; });
        const executionJob = await store.readJob(workspace, queued.job.id);
        assert.equal(executionJob.status, ['durable marker v1 downgrade', 'corrupt legacy worker execution', 'missing legacy worker evidence', 'missing legacy worker evidence and binding'].includes(failurePoint) ? 'queued' : 'failed',
          `legacy execution left ${executionError?.code ?? 'error'}: ${executionError?.message ?? executionError}`);
        if (['durable marker v1 downgrade', 'corrupt legacy worker execution', 'missing legacy worker evidence', 'missing legacy worker evidence and binding'].includes(failurePoint)) {
          if (failurePoint === 'missing legacy worker evidence and binding') return;
          const activeAfterRejection = await store.resolveRescueBinding({ workspace, parentSessionId, executorAgentId: childId });
          assert.equal(activeAfterRejection.kind, 'bound'); assert.equal(activeAfterRejection.binding.currentJobId, queued.job.id);
          return;
        }
      }
    }
  } else await assert.rejects(attempt, (error) => error === failure);
  if (historicalMarkerless) assert.deepEqual(JSON.parse(await readFile(partitionPath, 'utf8')), JSON.parse(closedTombstoneBytes.toString('utf8')));
  else assert.deepEqual(await readFile(partitionPath), closedTombstoneBytes);
  await assert.rejects(store.resolveRescueBinding({ workspace, parentSessionId, executorAgentId: childId }), { code: 'RESCUE_BINDING_CLOSED' });
  const failedJobs = await store.listJobs(workspace); assert.equal(failedJobs.length, 2); assert.equal(failedJobs[1].status, 'failed');
  const callsAfterFailure = (await readFile(record, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(callsAfterFailure.filter((frame) => frame.method === 'session/resume').length, failurePoint === 'legacy worker execution' ? 1 : 0);

  if (['worker launch', 'worker crash'].includes(failurePoint)) {
    await identity.beginCallerTurn({ sessionId: parentSessionId, turnId: 'turn-c', workspace, permissionMode: 'workspace-write',
      prompt: '$zcode:rescue --resume --wait retry recoverable migration' });
    await prepare('foreground');
    const retried = await runDirectInvocation(['invoke-prepared', 'rescue'], {
      cwd: workspace, env: childEnv, dependencies: { readCodexThreadSpawnChild: async () => host },
    });
    assert.equal(retried.job.status, 'succeeded'); assert.equal(retried.job.zcodeSessionId, first.job.zcodeSessionId);
  }
});

test('explicit fresh replaces a closed session-ended same-child binding with a new operation and session', async () => {
  const context = await fixture(); const workspace = await realpath(context.workspace);
  const record = join(context.directory, 'closed-session-ended-fresh.jsonl'); await writeFile(record, '');
  const parentSessionId = 'closed-session-ended-fresh-parent'; const childId = 'closed-session-ended-fresh-child'; const childTurnId = `${childId}-turn`;
  await prepareDirectRescueChild(context, {
    parentSessionId, parentTurnId: 'turn-a', childId, childTurnId,
    prompt: '$zcode:rescue --fresh --wait establish replaceable operation',
  });
  const childEnv = { ...context.env, CODEX_THREAD_ID: childId, FAKE_ZCODE_RECORD: record };
  const first = await runDirectInvocation(['invoke-prepared', 'rescue'], { cwd: workspace, env: childEnv });
  assert.equal(first.job.status, 'succeeded');
  await markForwarding(context.dataRoot, {
    session_id: parentSessionId, turn_id: childTurnId, cwd: workspace,
    hook_event_name: 'SubagentStop', agent_id: childId, agent_type: 'zcode-rescue',
  });
  const identity = createIdentityStore({ dataRoot: context.dataRoot }); const store = createStateStore({ dataRoot: context.dataRoot });
  const initial = await store.resolveRescueBinding({ workspace, parentSessionId, executorAgentId: childId });
  assert.equal(initial.kind, 'bound');
  const closed = await store.closeRescueBindingForChild({ workspace, parentSessionId, executorAgentId: childId,
    operationId: initial.binding.operationId, reason: 'session-ended' });
  assert.equal(closed.kind, 'closed');
  const storage = await resolveWorkspaceStorage({ dataRoot: context.dataRoot, workspace });
  const hookState = join(storage.directory, 'hook-state');
  for (const name of await readdir(hookState)) if (name.startsWith('executor-') || name.startsWith('route-')) await unlink(join(hookState, name));
  await identity.beginCallerTurn({ sessionId: parentSessionId, turnId: 'turn-b', workspace, permissionMode: 'workspace-write',
    prompt: '$zcode:rescue --fresh --wait replace closed operation', lifecycleResult: true,
    sessionStartedAt: '2026-08-23T00:00:00.000Z', sessionSource: 'resume' });
  const host = { id: childId, parentThreadId: parentSessionId, agentPath: '/root/zcode_rescue_task', agentRole: 'zcode-rescue',
    cwd: workspace, status: { type: 'notLoaded' }, createdAt: 1, updatedAt: 5 };
  const prepared = await runDirectInvocation(['prepare', 'rescue'], {
    cwd: workspace, env: { ...context.env, CODEX_THREAD_ID: parentSessionId },
    input: PassThrough.from([`${JSON.stringify({ version: 1, source: 'explicit', task: 'replace closed operation', options: { execution: 'foreground', resume: 'fresh' } })}\n`]),
    dependencies: { planRescueActivation: (/** @type {any} */ input) => planRescueActivation({ ...input, listChildren: async () => [host] }) },
  });
  assert.deepEqual(prepared, { type: 'prepared', command: 'rescue',
    route: { version: 2, action: 'followup', target: host.agentPath, assignment: 'zcode-rescue' } });
  const replacement = await runDirectInvocation(['invoke-prepared', 'rescue'], {
    cwd: workspace, env: childEnv, dependencies: { readCodexThreadSpawnChildIdentity: async () => activatedLegacyHost(host) },
  });
  assert.equal(replacement.job.status, 'succeeded'); assert.notEqual(replacement.job.zcodeSessionId, first.job.zcodeSessionId);
  const current = await store.resolveRescueBinding({ workspace, parentSessionId, executorAgentId: childId });
  assert.equal(current.kind, 'bound'); assert.notEqual(current.binding.operationId, closed.binding.operationId);
  assert.equal(current.binding.currentJobId, replacement.job.id);
  await store.closeRescueBindingForChild({ workspace, parentSessionId, executorAgentId: childId,
    operationId: current.binding.operationId, reason: 'session-ended' });
  await identity.beginCallerTurn({ sessionId: parentSessionId, turnId: 'turn-c', workspace, permissionMode: 'workspace-write',
    prompt: '$zcode:rescue --resume --wait continue route-less replacement', lifecycleResult: true,
    sessionStartedAt: '2026-08-23T00:00:00.000Z', sessionSource: 'resume' });
  const resumePrepared = await runDirectInvocation(['prepare', 'rescue'], {
    cwd: workspace, env: { ...context.env, CODEX_THREAD_ID: parentSessionId },
    input: PassThrough.from([`${JSON.stringify({ version: 1, source: 'explicit', task: 'continue route-less replacement', options: { execution: 'foreground', resume: 'resume' } })}\n`]),
    dependencies: { planRescueActivation: (/** @type {any} */ input) => planRescueActivation({ ...input, listChildren: async () => [host] }) },
  });
  assert.equal(resumePrepared.route.action, 'followup');
  const resumed = await runDirectInvocation(['invoke-prepared', 'rescue'], {
    cwd: workspace, env: childEnv, dependencies: { readCodexThreadSpawnChildIdentity: async () => activatedLegacyHost(host) },
  });
  assert.equal(resumed.job.status, 'succeeded'); assert.equal(resumed.job.zcodeSessionId, replacement.job.zcodeSessionId);
  const calls = (await readFile(record, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(calls.filter((frame) => frame.method === 'session/create').length, 2);
  assert.equal(calls.filter((frame) => frame.method === 'session/resume').length, 1);
});

test('legacy-bound fresh replaces only the binding permission while resume rejects before reservation', async () => {
  const context = await fixture(); const workspace = await realpath(context.workspace);
  const record = join(context.directory, 'legacy-permission-replacement.jsonl'); await writeFile(record, '');
  const parentSessionId = 'legacy-permission-parent'; const childId = 'legacy-permission-child';
  const identity = createIdentityStore({ dataRoot: context.dataRoot }); const store = createStateStore({ dataRoot: context.dataRoot });
  const stoppedHost = { id: childId, parentThreadId: parentSessionId, agentPath: '/root/zcode_rescue_task',
    agentRole: 'zcode-rescue', cwd: workspace, status: { type: 'notLoaded' }, createdAt: 1, updatedAt: 2 };
  const activeHost = { ...stoppedHost, status: { type: 'active', activeFlags: [] }, updatedAt: 3 };
  /** @param {'fresh'|'resume'} resume */
  const prepare = (resume) => runDirectInvocation(['prepare', 'rescue'], { cwd: workspace,
    env: { ...context.env, CODEX_THREAD_ID: parentSessionId },
    input: PassThrough.from([`${JSON.stringify({ version: 1, source: 'explicit', task: `${resume} with current permission`,
      options: { execution: 'foreground', resume } })}\n`]),
    dependencies: { planRescueActivation: (/** @type {any} */ input) => planRescueActivation({ ...input, listChildren: async () => [stoppedHost] }) } });
  const invoke = () => runDirectInvocation(['invoke-prepared', 'rescue'], { cwd: workspace,
    env: { ...context.env, CODEX_THREAD_ID: childId, FAKE_ZCODE_RECORD: record },
    dependencies: { readCodexThreadSpawnChildIdentity: async () => activeHost } });

  await identity.beginCallerTurn({ sessionId: parentSessionId, turnId: 'turn-a', workspace, permissionMode: 'workspace-write',
    prompt: '$zcode:rescue --fresh establish adoption', sessionStartedAt: '2026-08-23T00:00:00.000Z', sessionSource: 'startup', lifecycleResult: true });
  await prepare('fresh'); assert.equal((await invoke()).job.status, 'succeeded');
  const before = await store.resolveRescueBinding({ workspace, parentSessionId, executorAgentId: childId, permissionMode: 'workspace-write' });
  assert.equal(before.kind, 'bound'); const authorityBytes = JSON.stringify(before.binding.childAuthority);

  await identity.beginCallerTurn({ sessionId: parentSessionId, turnId: 'turn-b', workspace, permissionMode: 'read-only',
    prompt: '$zcode:rescue replace permission', sessionStartedAt: '2026-08-23T00:00:00.000Z', sessionSource: 'startup', lifecycleResult: true });
  const jobsBeforeResume = await store.listJobs(workspace); const rpcBeforeResume = await readFile(record, 'utf8');
  await assert.rejects(prepare('resume'), { code: 'RESCUE_BINDING_INVALID' });
  assert.deepEqual(await store.listJobs(workspace), jobsBeforeResume); assert.equal(await readFile(record, 'utf8'), rpcBeforeResume);

  await prepare('fresh'); const replaced = await invoke(); assert.equal(replaced.job.status, 'succeeded');
  const after = await store.resolveRescueBinding({ workspace, parentSessionId, executorAgentId: childId, permissionMode: 'read-only' });
  assert.equal(after.kind, 'bound'); assert.equal(after.binding.permissionMode, 'read-only');
  assert.equal(JSON.stringify(after.binding.childAuthority), authorityBytes);
});

for (const choice of ['resume', 'fresh']) test(`host-only legacy-bound omission preserves the adopted child through ${choice} choice`, async () => {
  const context = await fixture(); const workspace = await realpath(context.workspace);
  const record = join(context.directory, `legacy-choice-${choice}.jsonl`); await writeFile(record, '');
  const parentSessionId = `legacy-choice-${choice}-parent`; const childId = `legacy-choice-${choice}-child`;
  const identity = createIdentityStore({ dataRoot: context.dataRoot });
  const host = { id: childId, parentThreadId: parentSessionId, agentPath: '/root/zcode_rescue_task',
    agentRole: 'zcode-rescue', cwd: workspace, status: { type: 'notLoaded' }, createdAt: 1, updatedAt: 2 };
  /** @param {string} task @param {Record<string,string>} options */
  const prepare = (task, options) => runDirectInvocation(['prepare', 'rescue'], { cwd: workspace,
    env: { ...context.env, CODEX_THREAD_ID: parentSessionId },
    input: PassThrough.from([`${JSON.stringify({ version: 1, source: 'explicit', task, options: { execution: 'foreground', ...options } })}\n`]),
    dependencies: { planRescueActivation: (/** @type {any} */ input) => planRescueActivation({ ...input, listChildren: async () => [host] }) } });
  const invokePrepared = () => runDirectInvocation(['invoke-prepared', 'rescue'], { cwd: workspace,
    env: { ...context.env, CODEX_THREAD_ID: childId, FAKE_ZCODE_RECORD: record },
    dependencies: { readCodexThreadSpawnChildIdentity: async () => activatedLegacyHost(host) } });

  await identity.beginCallerTurn({ sessionId: parentSessionId, turnId: 'turn-a', workspace,
    permissionMode: 'workspace-write', prompt: '$zcode:rescue --fresh --wait establish adopted binding',
    sessionStartedAt: '2026-08-23T00:00:00.000Z', sessionSource: 'startup', lifecycleResult: true });
  await prepare('establish adopted binding', { resume: 'fresh' });
  const initial = await invokePrepared(); assert.equal(initial.job.status, 'succeeded');
  await identity.beginCallerTurn({ sessionId: parentSessionId, turnId: 'turn-b', workspace,
    permissionMode: 'workspace-write', prompt: '$zcode:rescue choose on the same adopted child',
    sessionStartedAt: '2026-08-23T00:00:00.000Z', sessionSource: 'startup', lifecycleResult: true });
  await prepare('choose on the same adopted child', {});
  assert.deepEqual(await invokePrepared(), { type: 'needs-choice', choices: ['--resume', '--fresh'] });

  if (choice === 'resume') {
    const callsBefore = await readFile(record, 'utf8'); const jobsBefore = await createStateStore({ dataRoot: context.dataRoot }).listJobs(workspace);
    const unrelated = await realpath(await addLinkedWorktree(context.workspace, context.directory, 'legacy-choice-unrelated'));
    for (const attempt of [
      { cwd: workspace, child: 'legacy-choice-sibling', host: { ...host, id: 'legacy-choice-sibling' } },
      { cwd: workspace, child: childId, host: { ...host, parentThreadId: 'other-parent' } },
      { cwd: unrelated, child: childId, host },
    ]) {
      await assert.rejects(runDirectInvocation(['invoke-choice', 'rescue', choice], { cwd: attempt.cwd,
        env: { ...context.env, CODEX_THREAD_ID: attempt.child, FAKE_ZCODE_RECORD: record },
        dependencies: { readCodexThreadSpawnChildIdentity: async () => activatedLegacyHost(attempt.host) } }));
      assert.equal(await readFile(record, 'utf8'), callsBefore);
      assert.deepEqual(await createStateStore({ dataRoot: context.dataRoot }).listJobs(workspace), jobsBefore);
    }
  }

  const chosen = await runDirectInvocation(['invoke-choice', 'rescue', choice], { cwd: workspace,
    env: { ...context.env, CODEX_THREAD_ID: childId, FAKE_ZCODE_RECORD: record },
    dependencies: { readCodexThreadSpawnChildIdentity: async () => activatedLegacyHost(host) } });
  assert.equal(chosen.job.status, 'succeeded');
  if (choice === 'resume') assert.equal(chosen.job.zcodeSessionId, initial.job.zcodeSessionId);
  else assert.notEqual(chosen.job.zcodeSessionId, initial.job.zcodeSessionId);
  await assert.rejects(runDirectInvocation(['invoke-choice', 'rescue', choice], { cwd: workspace,
    env: { ...context.env, CODEX_THREAD_ID: childId }, dependencies: { readCodexThreadSpawnChildIdentity: async () => activatedLegacyHost(host) } }),
  { code: 'PENDING_INVOCATION_NOT_FOUND' });
  const storage = await resolveWorkspaceStorage({ dataRoot: context.dataRoot, workspace });
  assert.deepEqual((await readdir(join(storage.directory, 'hook-state')).catch((error) => error.code === 'ENOENT' ? [] : Promise.reject(error)))
    .filter((name) => name.startsWith('executor-') || name.startsWith('route-')), []);
  const calls = (await readFile(record, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(calls.filter((frame) => frame.method === 'session/create').length, choice === 'resume' ? 1 : 2);
  assert.equal(calls.filter((frame) => frame.method === 'session/send').length, 2);
});

for (const choice of ['resume', 'fresh']) test(`v3 legacy ${choice} choice prefers a newly active exact Hook without replacing durable adoption authority`, async () => {
  const context = await fixture(); const workspace = await realpath(context.workspace);
  const record = join(context.directory, `legacy-choice-active-hook-${choice}.jsonl`); await writeFile(record, '');
  const parentSessionId = `legacy-choice-active-${choice}-parent`; const childId = `legacy-choice-active-${choice}-child`;
  const identity = createIdentityStore({ dataRoot: context.dataRoot }); const store = createStateStore({ dataRoot: context.dataRoot });
  const host = { id: childId, parentThreadId: parentSessionId, agentPath: '/root/zcode_rescue_task', agentRole: 'zcode-rescue',
    cwd: workspace, status: { type: 'notLoaded' }, createdAt: 1, updatedAt: 2 };
  /** @param {string} task @param {Record<string,string>} options */
  const prepare = (task, options) => runDirectInvocation(['prepare', 'rescue'], { cwd: workspace,
    env: { ...context.env, CODEX_THREAD_ID: parentSessionId },
    input: PassThrough.from([`${JSON.stringify({ version: 1, source: 'explicit', task, options: { execution: 'foreground', ...options } })}\n`]),
    dependencies: { planRescueActivation: (/** @type {any} */ input) => planRescueActivation({ ...input, listChildren: async () => [host] }) } });
  const invokePrepared = () => runDirectInvocation(['invoke-prepared', 'rescue'], { cwd: workspace,
    env: { ...context.env, CODEX_THREAD_ID: childId, FAKE_ZCODE_RECORD: record },
    dependencies: { readCodexThreadSpawnChildIdentity: async () => activatedLegacyHost(host) } });
  await identity.beginCallerTurn({ sessionId: parentSessionId, turnId: 'turn-a', workspace, permissionMode: 'workspace-write',
    prompt: '$zcode:rescue --fresh --wait establish adoption', sessionStartedAt: '2026-08-23T00:00:00.000Z', sessionSource: 'startup', lifecycleResult: true });
  await prepare('establish adoption', { resume: 'fresh' }); const initial = await invokePrepared(); assert.equal(initial.job.status, 'succeeded');
  const bindingBefore = await store.resolveRescueBinding({ workspace, parentSessionId, executorAgentId: childId, permissionMode: 'workspace-write' });
  assert.equal(bindingBefore.kind, 'bound'); const durableAuthorityBytes = JSON.stringify(bindingBefore.binding.childAuthority);
  await identity.beginCallerTurn({ sessionId: parentSessionId, turnId: 'turn-b', workspace, permissionMode: 'workspace-write',
    prompt: '$zcode:rescue choose after Hook', sessionStartedAt: '2026-08-23T00:00:00.000Z', sessionSource: 'startup', lifecycleResult: true });
  await prepare('choose after Hook', {}); assert.deepEqual(await invokePrepared(), { type: 'needs-choice', choices: ['--resume', '--fresh'] });
  const active = await identity.resolveActiveTurn({ sessionId: parentSessionId, workspace, workspaceBinding: 'execution' });
  await markForwarding(context.dataRoot, { session_id: parentSessionId, turn_id: 'active-choice-child-turn', cwd: workspace,
    hook_event_name: 'SubagentStart', agent_id: childId, agent_type: 'zcode-rescue' }, active);
  const storage = await resolveWorkspaceStorage({ dataRoot: context.dataRoot, workspace }); const names = await readdir(join(storage.directory, 'hook-state'));
  const executorName = names.find((name) => name.startsWith('executor-')); const routeName = names.find((name) => name.startsWith('route-'));
  assert.ok(executorName); assert.ok(routeName);
  const executorPath = join(storage.directory, 'hook-state', executorName);
  const routePath = join(storage.directory, 'hook-state', routeName);
  const executorBytes = await readFile(executorPath); const routeBytes = await readFile(routePath);
  const executorRecord = JSON.parse(executorBytes.toString('utf8')); const routeRecord = JSON.parse(routeBytes.toString('utf8'));
  const jobsBefore = await store.listJobs(workspace); const rpcBefore = await readFile(record, 'utf8');
  for (const mutation of [
    { parentTurnId: 'wrong-turn' }, { parentGenerationId: '9'.repeat(64) }, { parentPermissionMode: 'read-only' },
    { originWorkspace: context.directory }, { workspace: context.directory, targetWorkspace: context.directory },
  ]) {
    await writeFile(executorPath, `${JSON.stringify({ ...executorRecord, ...mutation }, null, 2)}\n`);
    await writeFile(routePath, `${JSON.stringify({ ...routeRecord, ...mutation }, null, 2)}\n`);
    await assert.rejects(runDirectInvocation(['invoke-choice', 'rescue', choice], { cwd: workspace,
      env: { ...context.env, CODEX_THREAD_ID: childId, FAKE_ZCODE_RECORD: record } }));
    assert.deepEqual(await store.listJobs(workspace), jobsBefore); assert.equal(await readFile(record, 'utf8'), rpcBefore);
    await writeFile(executorPath, executorBytes); await writeFile(routePath, routeBytes);
  }
  const resumed = await runDirectInvocation(['invoke-choice', 'rescue', choice], { cwd: workspace,
    env: { ...context.env, CODEX_THREAD_ID: childId, FAKE_ZCODE_RECORD: record } });
  assert.equal(resumed.job.status, 'succeeded');
  if (choice === 'resume') assert.equal(resumed.job.zcodeSessionId, initial.job.zcodeSessionId);
  else assert.notEqual(resumed.job.zcodeSessionId, initial.job.zcodeSessionId);
  const bindingAfter = await store.resolveRescueBinding({ workspace, parentSessionId, executorAgentId: childId, permissionMode: 'workspace-write' });
  assert.equal(bindingAfter.kind, 'bound'); assert.equal(JSON.stringify(bindingAfter.binding.childAuthority), durableAuthorityBytes);
  await assert.rejects(runDirectInvocation(['invoke-choice', 'rescue', choice], { cwd: workspace,
    env: { ...context.env, CODEX_THREAD_ID: childId } }), { code: 'PENDING_INVOCATION_NOT_FOUND' });
});

test('legacy adoption rejects host mismatches and admits exactly one concurrent consumer before side effects', async () => {
  const context = await fixture(); const workspace = await realpath(context.workspace);
  const record = join(context.directory, 'legacy-concurrency.jsonl'); await writeFile(record, '');
  const parentSessionId = 'legacy-race-parent'; const childId = 'legacy-race-child';
  const identity = createIdentityStore({ dataRoot: context.dataRoot });
  await identity.beginCallerTurn({ sessionId: parentSessionId, turnId: 'legacy-race-turn', workspace,
    permissionMode: 'workspace-write', prompt: '$zcode:rescue --fresh --wait race legacy task',
    sessionStartedAt: '2026-08-23T00:00:00.000Z', sessionSource: 'startup', lifecycleResult: true });
  const stoppedHost = { id: childId, parentThreadId: parentSessionId, agentPath: '/root/zcode_rescue_task',
    agentRole: 'zcode-rescue', cwd: workspace, status: { type: 'notLoaded' }, createdAt: 1, updatedAt: 2 };
  const activeHost = { ...stoppedHost, status: { type: 'active', activeFlags: [] }, updatedAt: 3 };
  await runDirectInvocation(['prepare', 'rescue'], { cwd: workspace, env: { ...context.env, CODEX_THREAD_ID: parentSessionId },
    input: PassThrough.from([`${JSON.stringify({ version: 1, source: 'explicit', task: 'race legacy task', options: { execution: 'foreground', resume: 'fresh' } })}\n`]),
    dependencies: { planRescueActivation: (/** @type {any} */ input) => planRescueActivation({ ...input, listChildren: async () => [stoppedHost] }) } });
  const before = await readFile(record, 'utf8');
  for (const mutation of [
    { id: 'other-child' }, { parentThreadId: 'other-parent' }, { agentRole: null },
    { agentPath: '/root/zcode_rescue_task_2' }, { cwd: context.directory }, { status: { type: 'notLoaded' } },
    { status: { type: 'idle' } }, { status: { type: 'systemError' } },
  ]) {
    await assert.rejects(runDirectInvocation(['invoke-prepared', 'rescue'], { cwd: workspace,
      env: { ...context.env, CODEX_THREAD_ID: childId, FAKE_ZCODE_RECORD: record },
      dependencies: { readCodexThreadSpawnChildIdentity: async () => ({ ...activeHost, ...mutation }) } }));
    assert.equal(await readFile(record, 'utf8'), before);
    assert.deepEqual(await createStateStore({ dataRoot: context.dataRoot }).listJobs(workspace), []);
  }
  const invoke = () => runDirectInvocation(['invoke-prepared', 'rescue'], { cwd: workspace,
    env: { ...context.env, CODEX_THREAD_ID: childId, FAKE_ZCODE_RECORD: record },
    dependencies: { readCodexThreadSpawnChildIdentity: async () => activeHost } });
  const outcomes = await Promise.allSettled([invoke(), invoke()]);
  assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter((outcome) => outcome.status === 'rejected' && outcome.reason?.code === 'RESCUE_PREPARATION_CONSUMED').length, 1);
  assert.equal((await createStateStore({ dataRoot: context.dataRoot }).listJobs(workspace)).length, 1);
  const calls = (await readFile(record, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(calls.filter((frame) => frame.method === 'session/create').length, 1);
  assert.equal(calls.filter((frame) => frame.method === 'session/send').length, 1);
});

test('a matching Hook executor emitted after legacy planning supersedes first-adoption persistence', async () => {
  const context = await fixture(); const workspace = await realpath(context.workspace);
  const parentSessionId = 'legacy-hook-parent'; const childId = 'legacy-hook-child';
  const identity = createIdentityStore({ dataRoot: context.dataRoot });
  await identity.beginCallerTurn({ sessionId: parentSessionId, turnId: 'legacy-hook-turn', workspace,
    permissionMode: 'workspace-write', prompt: '$zcode:rescue --fresh --wait hook wins',
    sessionStartedAt: '2026-08-23T00:00:00.000Z', sessionSource: 'startup', lifecycleResult: true });
  const stoppedHost = { id: childId, parentThreadId: parentSessionId, agentPath: '/root/zcode_rescue_task',
    agentRole: 'zcode-rescue', cwd: workspace, status: { type: 'notLoaded' }, createdAt: 1, updatedAt: 2 };
  await runDirectInvocation(['prepare', 'rescue'], { cwd: workspace, env: { ...context.env, CODEX_THREAD_ID: parentSessionId },
    input: PassThrough.from([`${JSON.stringify({ version: 1, source: 'explicit', task: 'hook wins', options: { execution: 'foreground', resume: 'fresh' } })}\n`]),
    dependencies: { planRescueActivation: (/** @type {any} */ input) => planRescueActivation({ ...input, listChildren: async () => [stoppedHost] }) } });
  const active = await identity.resolveActiveTurn({ sessionId: parentSessionId, workspace, workspaceBinding: 'execution' });
  await markForwarding(context.dataRoot, { session_id: parentSessionId, turn_id: 'legacy-hook-child-turn', cwd: workspace,
    hook_event_name: 'SubagentStart', agent_id: childId, agent_type: 'zcode-rescue' }, active);
  const activeHost = { ...stoppedHost, status: { type: 'active', activeFlags: [] }, updatedAt: 3 };
  const output = await runDirectInvocation(['invoke-prepared', 'rescue'], { cwd: workspace,
    env: { ...context.env, CODEX_THREAD_ID: childId }, dependencies: { readCodexThreadSpawnChild: async () => activeHost } });
  assert.equal(output.job.status, 'succeeded');
  const binding = await createStateStore({ dataRoot: context.dataRoot }).resolveRescueBinding({ workspace,
    parentSessionId, executorAgentId: childId, executorAgentType: 'zcode-rescue',
    executorParentTurnId: 'legacy-hook-turn', executorParentPermissionMode: 'workspace-write' });
  assert.equal(binding.kind, 'bound');
  assert.deepEqual(binding.binding.childAuthority, { kind: 'subagent-start', childAgentId: childId,
    childAgentType: 'zcode-rescue', parentTurnId: 'legacy-hook-turn', parentPermissionMode: 'workspace-write',
    agentPath: activeHost.agentPath });
});

for (const kind of ['legacy-adopt', 'legacy-bound']) test(`${kind} Hook mismatch rejects before consuming its preparation`, async () => {
  const context = await fixture(); const workspace = await realpath(context.workspace);
  const record = join(context.directory, `${kind}-hook-order.jsonl`); await writeFile(record, '');
  const parentSessionId = `${kind}-hook-order-parent`; const childId = `${kind}-hook-order-child`;
  const identity = createIdentityStore({ dataRoot: context.dataRoot });
  const stoppedHost = { id: childId, parentThreadId: parentSessionId, agentPath: '/root/zcode_rescue_task',
    agentRole: 'zcode-rescue', cwd: workspace, status: { type: 'notLoaded' }, createdAt: 1, updatedAt: 2 };
  /** @param {string} turnId @param {string} task @param {string} resume */
  const prepare = (turnId, task, resume) => runDirectInvocation(['prepare', 'rescue'], { cwd: workspace,
    env: { ...context.env, CODEX_THREAD_ID: parentSessionId },
    input: PassThrough.from([`${JSON.stringify({ version: 1, source: 'explicit', task, options: { execution: 'foreground', resume } })}\n`]),
    dependencies: { planRescueActivation: (/** @type {any} */ input) => planRescueActivation({ ...input, listChildren: async () => [stoppedHost] }) } });
  await identity.beginCallerTurn({ sessionId: parentSessionId, turnId: 'turn-a', workspace,
    permissionMode: 'workspace-write', prompt: '$zcode:rescue legacy hook order',
    sessionStartedAt: '2026-08-23T00:00:00.000Z', sessionSource: 'startup', lifecycleResult: true });
  if (kind === 'legacy-bound') {
    await prepare('turn-a', 'establish adoption', 'fresh');
    assert.equal((await runDirectInvocation(['invoke-prepared', 'rescue'], { cwd: workspace,
      env: { ...context.env, CODEX_THREAD_ID: childId, FAKE_ZCODE_RECORD: record },
      dependencies: { readCodexThreadSpawnChildIdentity: async () => activatedLegacyHost(stoppedHost) } })).job.status, 'succeeded');
    await identity.beginCallerTurn({ sessionId: parentSessionId, turnId: 'turn-b', workspace,
      permissionMode: 'workspace-write', prompt: '$zcode:rescue --resume legacy hook order',
      sessionStartedAt: '2026-08-23T00:00:00.000Z', sessionSource: 'startup', lifecycleResult: true });
  }
  await prepare(kind === 'legacy-bound' ? 'turn-b' : 'turn-a', 'guard hook convergence', kind === 'legacy-bound' ? 'resume' : 'fresh');
  const active = await identity.resolveActiveTurn({ sessionId: parentSessionId, workspace, workspaceBinding: 'execution' });
  await markForwarding(context.dataRoot, { session_id: parentSessionId, turn_id: `${kind}-child-turn`, cwd: workspace,
    hook_event_name: 'SubagentStart', agent_id: childId, agent_type: 'zcode-rescue' }, active);
  const activeHost = { ...stoppedHost, status: { type: 'active', activeFlags: [] }, updatedAt: 3 };
  const jobsBefore = await createStateStore({ dataRoot: context.dataRoot }).listJobs(workspace);
  const rpcBefore = await readFile(record, 'utf8');
  await assert.rejects(runDirectInvocation(['invoke-prepared', 'rescue'], { cwd: workspace,
    env: { ...context.env, CODEX_THREAD_ID: childId, FAKE_ZCODE_RECORD: record },
    dependencies: { readCodexThreadSpawnChild: async () => ({ ...activeHost, cwd: context.directory }) } }),
  { code: 'EXECUTOR_IDENTITY_INVALID' });
  assert.deepEqual(await createStateStore({ dataRoot: context.dataRoot }).listJobs(workspace), jobsBefore);
  assert.equal(await readFile(record, 'utf8'), rpcBefore);
  const output = await runDirectInvocation(['invoke-prepared', 'rescue'], { cwd: workspace,
    env: { ...context.env, CODEX_THREAD_ID: childId, FAKE_ZCODE_RECORD: record },
    dependencies: { readCodexThreadSpawnChild: async () => activeHost } });
  assert.equal(output.job.status, 'succeeded');
});

test('spawn-route preparation binds the newly active child path before ZCode execution', async () => {
  const context = await fixture();
  const parentSessionId = 'spawn-route-parent'; const childId = 'spawn-route-child';
  const agentPath = '/root/zcode_rescue_task'; const taskName = 'zcode_rescue_task';
  const identity = createIdentityStore({ dataRoot: context.dataRoot });
  await identity.beginCallerTurn({
    sessionId: parentSessionId, turnId: 'spawn-route-parent-turn', workspace: context.workspace,
    permissionMode: 'workspace-write', prompt: '$zcode:rescue --fresh --wait spawn route task',
  });
  const preparation = PassThrough.from([`${JSON.stringify({ version: 1, source: 'explicit', task: 'spawn route task', options: { execution: 'foreground', resume: 'fresh' } })}\n`]);
  const route = { version: 1, action: 'spawn', taskName };
  const prepared = await runDirectInvocation(['prepare', 'rescue'], {
    cwd: context.workspace, env: { ...context.env, CODEX_THREAD_ID: parentSessionId }, input: preparation,
    dependencies: { planRescueActivation: async () => ({
      directive: route,
      activation: { kind: 'spawn', taskName, agentPathDigest: createHash('sha256').update(agentPath).digest('hex') },
    }) },
  });
  assert.deepEqual(prepared, { type: 'prepared', command: 'rescue', route });
  const caller = await identity.resolveActiveTurn({ sessionId: parentSessionId, workspace: context.workspace });
  await markForwarding(context.dataRoot, {
    session_id: parentSessionId, turn_id: 'spawn-route-child-turn', cwd: context.workspace,
    hook_event_name: 'SubagentStart', agent_id: childId, agent_type: 'zcode-rescue',
  }, caller);
  const host = {
    id: childId, parentThreadId: parentSessionId, agentPath, agentRole: 'zcode-rescue',
    cwd: await realpath(context.workspace), status: { type: 'active', activeFlags: [] }, createdAt: 3, updatedAt: 4,
  };
  /** @param {()=>Promise<any>} reader @param {string} code */
  const assertSpawnRejected = async (reader, code) => {
    const jobsBefore = await createStateStore({ dataRoot: context.dataRoot }).listJobs(context.workspace);
    await assert.rejects(runDirectInvocation(['invoke-prepared', 'rescue'], {
      cwd: context.workspace, env: { ...context.env, CODEX_THREAD_ID: childId },
      dependencies: { readCodexThreadSpawnChild: reader },
    }), { code });
    assert.deepEqual(await createStateStore({ dataRoot: context.dataRoot }).listJobs(context.workspace), jobsBefore);
  };
  const missingStatus = { ...host }; delete /** @type {any} */ (missingStatus).status;
  for (const malformed of [
    { ...host, extra: true }, missingStatus, [], { ...host, id: 'x'.repeat(513) },
    { ...host, status: { type: 'unknown' } },
    { ...host, status: { type: 'active', activeFlags: ['waitingOnApproval', 'waitingOnApproval'] } },
    { ...host, agentPath: '/root/task/../escape' }, { ...host, agentPath: 'root/task' },
    { ...host, cwd: 'relative/repo' }, { ...host, createdAt: -1 },
  ]) await assertSpawnRejected(async () => malformed, 'CODEX_CHILD_METADATA_INVALID');
  await assertSpawnRejected(async () => ({ ...host, agentPath: '/root/zcode_rescue_task_2' }), 'RESCUE_PREPARATION_MISMATCH');
  await assertSpawnRejected(async () => ({ ...host, agentRole: null }), 'EXECUTOR_IDENTITY_INVALID');
  await assertSpawnRejected(async () => { throw new PluginError('CODEX_APP_SERVER_FAILED', 'reader failed', { category: 'protocol', remedy: 'retry' }); }, 'CODEX_APP_SERVER_FAILED');
  const output = await runDirectInvocation(['invoke-prepared', 'rescue'], {
    cwd: context.workspace, env: { ...context.env, CODEX_THREAD_ID: childId },
    dependencies: { readCodexThreadSpawnChild: async () => host },
  });
  assert.equal(output.job.status, 'succeeded'); assert.equal(output.result, 'done');
});

test('prepare rejects malformed or inconsistent planner authority before saving', async () => {
  const context = await fixture(); const identity = createIdentityStore({ dataRoot: context.dataRoot });
  const digest = createHash('sha256').update('/root/zcode_rescue_task').digest('hex');
  const cases = [
    {},
    { activation: { kind: 'spawn', taskName: 'zcode_rescue_task', agentPathDigest: digest } },
    { directive: { version: 1, action: 'spawn', taskName: 'zcode_rescue_task' } },
    { activation: { kind: 'spawn', taskName: 'zcode_rescue_task', agentPathDigest: digest }, directive: { version: 1, action: 'spawn', taskName: 'zcode_rescue_task' }, extra: true },
    { activation: { kind: 'reactivate', executorAgentId: 'child', agentPathDigest: digest }, directive: { version: 1, action: 'spawn', taskName: 'zcode_rescue_task' } },
    { activation: { kind: 'spawn', taskName: 'zcode_rescue_task_2', agentPathDigest: digest }, directive: { version: 1, action: 'spawn', taskName: 'zcode_rescue_task' } },
    { activation: { kind: 'spawn', taskName: 'zcode_rescue_task', agentPathDigest: 'f'.repeat(64) }, directive: { version: 1, action: 'spawn', taskName: 'zcode_rescue_task' } },
  ];
  for (const [index, planned] of cases.entries()) {
    const sessionId = `invalid-plan-parent-${index}`;
    await identity.beginCallerTurn({ sessionId, turnId: `invalid-plan-turn-${index}`, workspace: context.workspace, permissionMode: 'workspace-write', prompt: '$zcode:rescue invalid plan task' });
    await assert.rejects(runDirectInvocation(['prepare', 'rescue'], {
      cwd: context.workspace, env: { ...context.env, CODEX_THREAD_ID: sessionId },
      input: PassThrough.from([`${JSON.stringify({ version: 1, source: 'explicit', task: 'invalid plan task', options: { resume: 'fresh' } })}\n`]),
      dependencies: { planRescueActivation: async () => planned },
    }), { code: 'RESCUE_ROUTE_INVALID' });
  }
  const storage = await resolveWorkspaceStorage(context);
  assert.deepEqual(await readdir(join(storage.directory, 'invocations', 'prepared')).catch((error) => error.code === 'ENOENT' ? [] : Promise.reject(error)), []);
});

test('cross-parent resume reactivates only the exact persisted child binding and ZCode session', async () => {
  const context = await fixture(); const record = join(context.directory, 'persisted-resume.jsonl'); await writeFile(record, '');
  const parentSessionId = 'persisted-resume-parent'; const childId = 'persisted-resume-child';
  const childTurnId = 'persisted-resume-child-turn'; const agentPath = '/root/zcode_rescue_task';
  await prepareDirectRescueChild(context, {
    parentSessionId, parentTurnId: 'old-resume-parent-turn', childId, childTurnId,
    prompt: '$zcode:rescue --fresh --wait establish persisted resume',
  });
  const childEnv = { ...context.env, CODEX_THREAD_ID: childId, FAKE_ZCODE_RECORD: record };
  const first = await runDirectInvocation(['invoke-prepared', 'rescue'], { cwd: context.workspace, env: childEnv });
  assert.equal(first.job.status, 'succeeded');
  await markForwarding(context.dataRoot, {
    session_id: parentSessionId, turn_id: childTurnId, cwd: context.workspace,
    hook_event_name: 'SubagentStop', agent_id: childId, agent_type: 'zcode-rescue',
  });
  const competingChildId = 'persisted-resume-competing-child'; const competingTurnId = 'persisted-resume-competing-turn';
  const oldParent = await createIdentityStore({ dataRoot: context.dataRoot }).resolveActiveTurn({ sessionId: parentSessionId, workspace: context.workspace });
  await markForwarding(context.dataRoot, {
    session_id: parentSessionId, turn_id: competingTurnId, cwd: context.workspace,
    hook_event_name: 'SubagentStart', agent_id: competingChildId, agent_type: 'zcode-rescue',
  }, oldParent);
  await markForwarding(context.dataRoot, {
    session_id: parentSessionId, turn_id: competingTurnId, cwd: context.workspace,
    hook_event_name: 'SubagentStop', agent_id: competingChildId, agent_type: 'zcode-rescue',
  });
  const identity = createIdentityStore({ dataRoot: context.dataRoot });
  await identity.beginCallerTurn({
    sessionId: parentSessionId, turnId: 'resumed-parent-turn', workspace: context.workspace,
    permissionMode: 'workspace-write', prompt: '$zcode:rescue --resume --wait continue persisted resume',
  });
  const host = {
    id: childId, parentThreadId: parentSessionId, agentPath, agentRole: 'zcode-rescue',
    cwd: await realpath(context.workspace), status: { type: 'notLoaded' }, createdAt: 1, updatedAt: 5,
  };
  const competingHost = { ...host, id: competingChildId, agentPath: '/root/zcode_rescue_task_2', createdAt: 2, updatedAt: 6 };
  const input = PassThrough.from([`${JSON.stringify({ version: 1, source: 'explicit', task: 'continue persisted resume', options: { execution: 'foreground', resume: 'resume' } })}\n`]);
  const prepared = await runDirectInvocation(['prepare', 'rescue'], {
    cwd: context.workspace, env: { ...context.env, CODEX_THREAD_ID: parentSessionId }, input,
    dependencies: { planRescueActivation: (/** @type {any} */ plannerInput) => planRescueActivation({ ...plannerInput, listChildren: async () => [competingHost, host] }) },
  });
  assert.deepEqual(prepared, { type: 'prepared', command: 'rescue', route: { version: 2, action: 'followup', target: agentPath, assignment: 'zcode-rescue' } });
  const callsBeforeCompeting = await readFile(record, 'utf8'); const jobsBeforeCompeting = await createStateStore({ dataRoot: context.dataRoot }).listJobs(context.workspace);
  await assert.rejects(runDirectInvocation(['invoke-prepared', 'rescue'], {
    cwd: context.workspace, env: { ...context.env, CODEX_THREAD_ID: competingChildId, FAKE_ZCODE_RECORD: record },
    dependencies: { readCodexThreadSpawnChild: async () => competingHost },
  }), { code: 'RESCUE_PREPARATION_MISMATCH' });
  assert.equal(await readFile(record, 'utf8'), callsBeforeCompeting);
  assert.deepEqual(await createStateStore({ dataRoot: context.dataRoot }).listJobs(context.workspace), jobsBeforeCompeting);
  const second = await runDirectInvocation(['invoke-prepared', 'rescue'], {
    cwd: context.workspace, env: childEnv, dependencies: { readCodexThreadSpawnChild: async () => host },
  });
  assert.equal(second.job.status, 'succeeded'); assert.equal(second.job.zcodeSessionId, first.job.zcodeSessionId);
  const calls = (await readFile(record, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(calls.filter((frame) => frame.method === 'session/create').length, 1);
  assert.equal(calls.filter((frame) => frame.method === 'session/send').length, 2);
});

test('modern and historical v1 session-ended bindings rejoin the exact persisted child and ZCode session', async () => {
  const context = await fixture(); const record = join(context.directory, 'modern-session-ended-resume.jsonl'); await writeFile(record, '');
  const parentSessionId = 'modern-session-ended-parent'; const childId = 'modern-session-ended-child';
  const childTurnId = 'modern-session-ended-child-turn'; const agentPath = '/root/zcode_rescue_task';
  await prepareDirectRescueChild(context, {
    parentSessionId, parentTurnId: 'old-parent-turn', childId, childTurnId,
    prompt: '$zcode:rescue --fresh --wait establish modern binding',
  });
  const childEnv = { ...context.env, CODEX_THREAD_ID: childId, FAKE_ZCODE_RECORD: record };
  const first = await runDirectInvocation(['invoke-prepared', 'rescue'], { cwd: context.workspace, env: childEnv });
  assert.equal(first.job.status, 'succeeded');
  await markForwarding(context.dataRoot, {
    session_id: parentSessionId, turn_id: childTurnId, cwd: context.workspace,
    hook_event_name: 'SubagentStop', agent_id: childId, agent_type: 'zcode-rescue',
  });
  const store = createStateStore({ dataRoot: context.dataRoot });
  const active = await store.resolveRescueBinding({ workspace: context.workspace, parentSessionId, executorAgentId: childId });
  assert.equal(active.kind, 'bound');
  const closed = await store.closeRescueBindingForChild({ workspace: context.workspace, parentSessionId, executorAgentId: childId,
    operationId: active.binding.operationId, reason: 'session-ended' });
  assert.equal(closed.kind, 'closed');
  await assert.rejects(store.resolveRescueBinding({ workspace: context.workspace, parentSessionId, executorAgentId: childId }),
    { code: 'RESCUE_BINDING_CLOSED' });
  await createIdentityStore({ dataRoot: context.dataRoot }).beginCallerTurn({
    sessionId: parentSessionId, turnId: 'resumed-parent-turn', workspace: context.workspace,
    permissionMode: 'workspace-write', prompt: '$zcode:rescue --resume --wait continue modern binding',
  });
  const host = { id: childId, parentThreadId: parentSessionId, agentPath, agentRole: 'zcode-rescue',
    cwd: await realpath(context.workspace), status: { type: 'notLoaded' }, createdAt: 1, updatedAt: 5 };
  const prepared = await runDirectInvocation(['prepare', 'rescue'], {
    cwd: context.workspace, env: { ...context.env, CODEX_THREAD_ID: parentSessionId },
    input: PassThrough.from([`${JSON.stringify({ version: 1, source: 'explicit', task: 'continue modern binding', options: { execution: 'foreground', resume: 'resume' } })}\n`]),
    dependencies: { planRescueActivation: (/** @type {any} */ input) => planRescueActivation({ ...input, listChildren: async () => [host] }) },
  });
  assert.deepEqual(prepared, { type: 'prepared', command: 'rescue', route: { version: 2, action: 'followup', target: agentPath, assignment: 'zcode-rescue' } });
  const second = await runDirectInvocation(['invoke-prepared', 'rescue'], {
    cwd: context.workspace, env: childEnv, dependencies: { readCodexThreadSpawnChild: async () => host },
  });
  assert.equal(second.job.status, 'succeeded'); assert.equal(second.job.zcodeSessionId, first.job.zcodeSessionId);

  const migrated = await store.resolveRescueBinding({ workspace: context.workspace, parentSessionId, executorAgentId: childId });
  assert.equal(migrated.kind, 'bound'); assert.equal(migrated.binding.version, 3);
  const storage = await resolveWorkspaceStorage({ dataRoot: context.dataRoot, workspace: context.workspace });
  const [partitionName] = (await readdir(storage.directory)).filter((name) => name.startsWith('rescue-binding-session-'));
  const partitionPath = join(storage.directory, partitionName); const partition = JSON.parse(await readFile(partitionPath, 'utf8'));
  const current = partition.records[0]; const authority = current.childAuthority;
  partition.records[0] = { version: 1, key: current.key, operationId: current.operationId, state: current.state,
    parentSessionId: current.parentSessionId, executorAgentId: authority.childAgentId, executorAgentType: authority.childAgentType,
    executorParentTurnId: authority.parentTurnId, executorParentPermissionMode: authority.parentPermissionMode,
    workspace: current.workspace, permissionMode: current.permissionMode, anchorJobId: current.anchorJobId,
    currentJobId: current.currentJobId, createdAt: current.createdAt, updatedAt: current.updatedAt,
    closedAt: current.closedAt, closeReason: current.closeReason };
  await writeFile(partitionPath, `${JSON.stringify(partition, null, 2)}\n`);
  const historical = await store.closeRescueBindingForChild({ workspace: context.workspace, parentSessionId,
    executorAgentId: childId, operationId: current.operationId, reason: 'session-ended' });
  assert.equal(historical.kind, 'closed'); assert.equal(historical.binding.version, 1);
  await createIdentityStore({ dataRoot: context.dataRoot }).beginCallerTurn({
    sessionId: parentSessionId, turnId: 'historical-resumed-parent-turn', workspace: context.workspace,
    permissionMode: 'workspace-write', prompt: '$zcode:rescue --resume --wait continue historical binding',
  });
  const historicalHost = { ...host, updatedAt: 6 };
  await runDirectInvocation(['prepare', 'rescue'], {
    cwd: context.workspace, env: { ...context.env, CODEX_THREAD_ID: parentSessionId },
    input: PassThrough.from([`${JSON.stringify({ version: 1, source: 'explicit', task: 'continue historical binding', options: { execution: 'foreground', resume: 'resume' } })}\n`]),
    dependencies: { planRescueActivation: (/** @type {any} */ input) => planRescueActivation({ ...input, listChildren: async () => [historicalHost] }) },
  });
  const third = await runDirectInvocation(['invoke-prepared', 'rescue'], {
    cwd: context.workspace, env: childEnv, dependencies: { readCodexThreadSpawnChild: async () => historicalHost },
  });
  assert.equal(third.job.status, 'succeeded'); assert.equal(third.job.zcodeSessionId, first.job.zcodeSessionId);
  const calls = (await readFile(record, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(calls.filter((frame) => frame.method === 'session/create').length, 1);
  assert.equal(calls.filter((frame) => frame.method === 'session/resume').length, 2);
  assert.equal(calls.filter((frame) => frame.method === 'session/send').length, 3);
});

/** @param {any} context @param {{name:string}} input */
async function preparedSameTurnBoundContinuation(context, input) {
  const record = join(context.directory, `${input.name}.jsonl`); await writeFile(record, '');
  const parentSessionId = `${input.name}-parent`; const parentTurnId = `${input.name}-parent-turn`; const childId = `${input.name}-child`; const childTurnId = `${input.name}-child-turn`;
  await prepareDirectRescueChild(context, {
    parentSessionId, parentTurnId, childId, childTurnId,
    prompt: '$zcode:rescue --fresh --wait establish guarded continuation',
  });
  const env = { ...context.env, CODEX_THREAD_ID: childId, FAKE_ZCODE_RECORD: record };
  const first = await runDirectInvocation(['invoke-prepared', 'rescue'], { cwd: context.workspace, env });
  assert.equal(first.job.status, 'succeeded');
  await markForwarding(context.dataRoot, {
    session_id: parentSessionId, turn_id: childTurnId, cwd: context.workspace, hook_event_name: 'SubagentStop',
    agent_id: childId, agent_type: 'zcode-rescue',
  });
  assert.deepEqual(await prepareRescueInCurrentTurn(context, {
    parentSessionId, source: 'proactive', task: 'exercise exact reservation guards',
    options: { execution: 'foreground', resume: 'resume' },
  }), legacyPreparedRoute);
  await writeFile(record, '');
  return {
    record, parentSessionId, parentTurnId, childId, env, first,
    executor: { agentId: childId, agentType: 'zcode-rescue', agentPath: '/root/zcode_rescue_task', parentSessionId, parentTurnId, parentPermissionMode: 'workspace-write', workspace: context.workspace },
  };
}

/** @param {any} context @param {string} record @param {number} expectedJobs */
async function assertNoPreparedReservationSideEffects(context, record, expectedJobs) {
  assert.equal((await createStateStore({ dataRoot: context.dataRoot }).listJobs(context.workspace)).length, expectedJobs);
  const calls = (await readFile(record, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(calls.filter((frame) => ['session/create', 'session/send', 'session/stop'].includes(frame.method)).length, 0);
}

test('role-status rescue is bounded and returns before caller consumption, reconciliation, discovery, or reservation', async () => {
  const context = await fixture();
  const forbidden = () => { throw new Error('role-status crossed the read-only preflight boundary'); };
  const output = await runCompanion(['role-status', 'rescue'], {
    cwd: context.workspace,
    env: context.env,
    authorization: { callerContext: 'must-not-be-consumed' },
    dependencies: {
      inspectRescueRoleStatus: async (/** @type {any} */ input) => {
        assert.equal(input.cwd, context.workspace);
        assert.equal(input.pluginRoot, await realpath(root));
        return { status: 'ready', rolePath: '/private/path/must-not-render' };
      },
      reconcileOwnedJobs: forbidden,
      discoverLaunch: forbidden,
      reserveJob: forbidden,
    },
  });
  assert.deepEqual(output, { type: 'role-status', role: 'zcode-rescue', status: 'ready' });
  assert.equal(renderOutput(output), '{"type":"role-status","role":"zcode-rescue","status":"ready"}\n');
});

test('linked worktree Role preview stays read-only and private prepare binds after TTY capability but before readiness', async () => {
  const context = await fixture();
  const sessionId = 'late-bind-companion-parent';
  await recordRealParentTurn(context, {
    sessionId, turnId: 'late-bind-companion-turn', permissionMode: 'acceptEdits',
    prompt: '$zcode:rescue --fresh --wait repair the linked worktree',
  });
  const linked = await addLinkedWorktree(context.workspace, context.directory);
  const identity = createIdentityStore({ dataRoot: context.dataRoot });

  const codexHome = join(context.directory, 'installed-late-bind-codex-home');
  const installed = join(codexHome, 'plugins', 'cache', 'vitry', 'zcode', '0.1.0');
  await mkdir(installed, { recursive: true });
  for (const name of ['agents', 'hooks', 'schemas', 'scripts']) await cp(join(root, name), join(installed, name), { recursive: true });
  await cp(join(root, 'package.json'), join(installed, 'package.json'));
  await symlink(dependencyNodeModules, join(installed, 'node_modules'), 'dir');
  const canonicalDataRoot = await realpath(context.dataRoot);
  const configFile = join(canonicalDataRoot, 'config.toml');
  const rolePaths = managedRolePaths(canonicalDataRoot);
  const installedRoot = await realpath(installed);
  const roleBytes = Buffer.from(renderManagedRescueRole({ template: await readFile(join(installed, 'agents', 'zcode-rescue.toml.template'), 'utf8'), pluginRoot: installedRoot }));
  await mkdir(dirname(rolePaths.rolePath), { recursive: true });
  await writeFile(rolePaths.rolePath, roleBytes);
  await writeFile(rolePaths.receiptPath, `${JSON.stringify({
    schemaVersion: '1.0.0', roleName: 'zcode-rescue',
    plugin: { identity: 'zcode@vitry', version: '0.1.0', root: installedRoot },
    configTarget: { filePath: configFile },
    role: { path: rolePaths.rolePath, schemaVersion: 1, sha256: createHash('sha256').update(roleBytes).digest('hex') },
    mutatedAt: new Date().toISOString(),
  }, null, 2)}\n`);
  const registration = { description: MANAGED_ROLE_DESCRIPTION, config_file: rolePaths.rolePath };
  const configured = { features: { multi_agent_v2: { hide_spawn_agent_metadata: false } }, agents: { 'zcode-rescue': registration } };
  const config = { config: configured, origins: {}, layers: [{ name: { type: 'user', file: configFile }, version: 'version-1', config: configured }] };
  const [activeName] = await readdir(join(context.dataRoot, 'identity-lifecycle', 'active-turns'));
  assert.ok(activeName);
  const activePath = join(context.dataRoot, 'identity-lifecycle', 'active-turns', activeName);
  const activeBytesBeforeRole = await readFile(activePath);
  const activeStatBeforeRole = await stat(activePath);
  const workspacePartitionsBeforeRole = (await readdir(join(context.dataRoot, 'workspaces'))).sort();
  /** @param {string} cwd @param {string} [threadId] */
  const installedRole = (cwd, threadId = sessionId) => run(process.execPath, [join(installed, 'scripts', 'zcode-companion.mjs'), 'role-status', 'rescue'], {
    cwd,
    env: {
      ...context.env, CODEX_HOME: codexHome,
      CODEX_APP_SERVER_PATH: process.execPath,
      CODEX_APP_SERVER_ARGS_JSON: JSON.stringify([fakeCodex]),
      FAKE_CODEX_CONFIG_RESULT: JSON.stringify(config),
      CODEX_THREAD_ID: threadId,
    },
  });
  const roleResult = await installedRole(linked);
  assert.equal(roleResult.code, 0, roleResult.stderr || roleResult.stdout);
  const roleOutput = JSON.parse(roleResult.stdout);
  assert.deepEqual(roleOutput, { type: 'role-status', role: 'zcode-rescue', status: 'ready' });
  assert.deepEqual(await readFile(activePath), activeBytesBeforeRole);
  assert.equal((await stat(activePath)).mtimeMs, activeStatBeforeRole.mtimeMs);
  assert.deepEqual((await readdir(join(context.dataRoot, 'workspaces'))).sort(), workspacePartitionsBeforeRole);
  assert.equal((await identity.resolveActiveTurn({ sessionId, workspace: linked, workspaceBinding: 'preview' })).executionWorkspace, null);

  const unrelated = join(context.directory, 'unrelated-repo');
  const nonGit = join(context.directory, 'non-git-directory');
  await mkdir(unrelated); await mkdir(nonGit);
  assert.equal((await run('git', ['init', '-q'], { cwd: unrelated })).code, 0);
  for (const [name, result] of [
    ['unrelated', await installedRole(unrelated)],
    ['non-git', await installedRole(nonGit)],
    ['child ambient', await installedRole(linked, 'late-bind-child-thread')],
  ]) {
    assert.equal(result.code, 0, `${name}: ${result.stderr || result.stdout}`);
    assert.deepEqual(JSON.parse(result.stdout), { type: 'role-status', role: 'zcode-rescue', status: 'caller-unavailable', remedy: 'Retry from an active owned parent turn.' }, name);
    assert.ok(Buffer.byteLength(result.stdout) < 1024, name);
    assert.doesNotMatch(result.stdout, /late-bind|linked-worktree|unrelated-repo|non-git-directory|repair the linked worktree|ACTIVE_TURN/u, name);
  }
  for (const [name, workspace, threadId, code] of [
    ['unrelated', unrelated, sessionId, 'ACTIVE_TURN_WORKSPACE_INELIGIBLE'],
    ['non-git', nonGit, sessionId, 'ACTIVE_TURN_WORKSPACE_INELIGIBLE'],
    ['child ambient', linked, 'late-bind-child-thread', 'ACTIVE_TURN_NOT_FOUND'],
  ]) {
    let reads = 0;
    const input = { async *[Symbol.asyncIterator]() { reads += 1; yield Buffer.from('{"private":"must-not-read"}\n'); } };
    await assert.rejects(runDirectInvocation(['prepare', 'rescue'], {
      cwd: workspace, env: { ...context.env, CODEX_THREAD_ID: threadId }, input: /** @type {any} */ (input),
    }), { code }, name);
    assert.equal(reads, 0, `${name} prepare must reject before private input reads`);
  }
  assert.equal((await identity.resolveActiveTurn({ sessionId, workspace: linked, workspaceBinding: 'preview' })).executionWorkspace, null);

  const privateFrame = `${JSON.stringify({ version: 1, source: 'explicit', task: 'repair the linked worktree', options: { execution: 'foreground', resume: 'fresh' } })}\n`;
  const nonTty = new PassThrough(); nonTty.end(privateFrame); const nonTtyBytes = nonTty.readableLength;
  await assert.rejects(runDirectInvocation(['prepare', 'rescue'], {
    cwd: linked, env: { ...context.env, CODEX_THREAD_ID: sessionId }, input: nonTty,
    preparationTransport: { writeReady: async () => { throw new Error('must not write readiness'); } },
  }), { code: 'PREPARATION_TTY_REQUIRED' });
  assert.equal(nonTty.readableLength, nonTtyBytes, 'TTY capability rejection must not read private task bytes');
  assert.equal((await identity.resolveActiveTurn({ sessionId, workspace: linked, workspaceBinding: 'preview' })).executionWorkspace, null);

  const rawFailure = new PassThrough(); rawFailure.end(privateFrame); const rawFailureBytes = rawFailure.readableLength;
  const rawFailureTty = /** @type {PassThrough & {isTTY:boolean,setRawMode:(enabled:boolean)=>void}} */ (rawFailure);
  rawFailureTty.isTTY = true; rawFailureTty.setRawMode = () => { throw new Error('raw mode unavailable'); };
  await assert.rejects(runDirectInvocation(['prepare', 'rescue'], {
    cwd: linked, env: { ...context.env, CODEX_THREAD_ID: sessionId }, input: rawFailure,
    preparationTransport: { writeReady: async () => { throw new Error('must not write readiness'); } },
  }), /raw mode unavailable/u);
  assert.equal(rawFailure.readableLength, rawFailureBytes, 'raw-mode rejection must not read private task bytes');
  assert.equal((await identity.resolveActiveTurn({ sessionId, workspace: linked, workspaceBinding: 'preview' })).executionWorkspace, null);

  const readyFailure = new PassThrough(); readyFailure.end(privateFrame); const readyFailureBytes = readyFailure.readableLength;
  const readyFailureTty = /** @type {PassThrough & {isTTY:boolean,setRawMode:(enabled:boolean)=>void}} */ (readyFailure);
  /** @type {boolean[]} */ const failedReadyRawModes = [];
  readyFailureTty.isTTY = true; readyFailureTty.setRawMode = (enabled) => { failedReadyRawModes.push(enabled); };
  await assert.rejects(runDirectInvocation(['prepare', 'rescue'], {
    cwd: linked, env: { ...context.env, CODEX_THREAD_ID: sessionId }, input: readyFailure,
    preparationTransport: { writeReady: async () => { throw new Error('private readiness channel closed'); } },
  }), /private readiness channel closed/u);
  assert.equal(readyFailure.readableLength, readyFailureBytes, 'failed readiness must not read private task bytes');
  assert.deepEqual(failedReadyRawModes, [true, false]);
  assert.equal((await identity.resolveActiveTurn({ sessionId, workspace: linked, workspaceBinding: 'execution' })).workspace, await realpath(linked));
  await assert.rejects(createRescuePreparationStore({ dataRoot: context.dataRoot }).consume({
    sessionId, turnId: 'late-bind-companion-turn', workspace: linked,
    permissionMode: 'acceptEdits', executorAgentId: 'failed-ready-child',
  }), { code: 'RESCUE_PREPARATION_NOT_FOUND' });

  const preparation = new PassThrough();
  const ttyPreparation = /** @type {PassThrough & {isTTY:boolean,setRawMode:(enabled:boolean)=>void}} */ (preparation);
  ttyPreparation.isTTY = true;
  /** @type {boolean[]} */ const rawModes = [];
  ttyPreparation.setRawMode = (enabled) => { rawModes.push(enabled); };
  preparation.end(privateFrame);
  let readyCount = 0;
  const prepared = await runDirectInvocation(['prepare', 'rescue'], {
    cwd: linked, env: { ...context.env, CODEX_THREAD_ID: sessionId }, input: preparation,
    preparationTransport: { writeReady: async () => {
      readyCount += 1;
      const bound = await identity.resolveActiveTurn({ sessionId, workspace: linked, workspaceBinding: 'execution' });
      assert.equal(bound.workspace, await realpath(linked));
      assert.equal(bound.executionWorkspace, await realpath(linked));
    } },
    dependencies: legacyPreparationDependencies,
  });
  assert.deepEqual(prepared, legacyPreparedRoute);
  assert.equal(readyCount, 1);
  assert.deepEqual(rawModes, [true, false]);

  const linkedB = join(context.directory, 'linked-worktree-b');
  assert.equal((await run('git', ['worktree', 'add', '-q', '-b', 'late-bind-companion-target-b', linkedB], { cwd: context.workspace })).code, 0);
  const boundBytesBeforeLoser = await readFile(activePath);
  const loserRole = await installedRole(linkedB);
  assert.deepEqual(JSON.parse(loserRole.stdout), { type: 'role-status', role: 'zcode-rescue', status: 'caller-unavailable', remedy: 'Retry from an active owned parent turn.' });
  let loserReads = 0;
  const loserInput = { async *[Symbol.asyncIterator]() { loserReads += 1; yield Buffer.from(privateFrame); } };
  await assert.rejects(runDirectInvocation(['prepare', 'rescue'], {
    cwd: linkedB, env: { ...context.env, CODEX_THREAD_ID: sessionId }, input: /** @type {any} */ (loserInput),
  }), { code: 'ACTIVE_TURN_WORKSPACE_INELIGIBLE' });
  assert.equal(loserReads, 0, 'second-target prepare must reject before private input reads');
  assert.deepEqual(await readFile(activePath), boundBytesBeforeLoser);
  const winnerRole = await installedRole(linked);
  assert.deepEqual(JSON.parse(winnerRole.stdout), { type: 'role-status', role: 'zcode-rescue', status: 'ready' });
  assert.equal((await identity.resolveActiveTurn({ sessionId, workspace: linked, workspaceBinding: 'execution' })).workspace, await realpath(linked));
  assert.equal((await createRescuePreparationStore({ dataRoot: context.dataRoot }).consume({
    sessionId, turnId: 'late-bind-companion-turn', workspace: linked,
    permissionMode: 'acceptEdits', executorAgentId: 'late-bind-test-child',
    activationProof: { kind: 'spawn', taskName: 'zcode_rescue_task', agentPathDigest: baseAgentPathDigest },
  })).workspace, await realpath(linked));
});

test('installed Role and prepare use legacy exact-workspace state only when lifecycle files are truly absent', async () => {
  const context = await fixture(); const identity = createIdentityStore({ dataRoot: context.dataRoot });
  const codexHome = join(context.directory, 'installed-legacy-codex-home');
  const installed = join(codexHome, 'plugins', 'cache', 'vitry', 'zcode', '0.1.0');
  await mkdir(installed, { recursive: true });
  for (const name of ['agents', 'hooks', 'schemas', 'scripts']) await cp(join(root, name), join(installed, name), { recursive: true });
  await cp(join(root, 'package.json'), join(installed, 'package.json')); await symlink(dependencyNodeModules, join(installed, 'node_modules'), 'dir');
  const configFile = join(context.dataRoot, 'legacy-config.toml');
  const config = { config: {}, origins: {}, layers: [{ name: { type: 'user', file: configFile }, version: 'version-1', config: {} }] };
  /** @param {string} sessionId */
  const role = (sessionId) => run(process.execPath, [join(installed, 'scripts', 'zcode-companion.mjs'), 'role-status', 'rescue'], {
    cwd: context.workspace,
    env: {
      ...context.env, CODEX_HOME: codexHome, CODEX_THREAD_ID: sessionId,
      CODEX_APP_SERVER_PATH: process.execPath, CODEX_APP_SERVER_ARGS_JSON: JSON.stringify([fakeCodex]),
      FAKE_CODEX_CONFIG_RESULT: JSON.stringify(config),
    },
  });

  const legacySession = 'installed-legacy-parent';
  await recordSession(context.dataRoot, { session_id: legacySession, cwd: context.workspace, source: 'startup' });
  await identity.beginCallerTurn({ sessionId: legacySession, turnId: 'installed-legacy-turn', workspace: context.workspace, permissionMode: 'acceptEdits', prompt: '$zcode:rescue legacy exact task' });
  const legacyRole = await role(legacySession);
  assert.deepEqual(JSON.parse(legacyRole.stdout), { type: 'role-status', role: 'zcode-rescue', status: 'install-required', remedy: '$zcode:setup' });
  const legacyInput = new PassThrough(); legacyInput.end(`${JSON.stringify({ version: 1, source: 'explicit', task: 'legacy exact task', options: {} })}\n`);
  assert.deepEqual(await runDirectInvocation(['prepare', 'rescue'], {
    cwd: context.workspace, env: { ...context.env, CODEX_THREAD_ID: legacySession }, input: legacyInput, dependencies: legacyPreparationDependencies,
  }), legacyPreparedRoute);

  const corruptSession = 'installed-corrupt-lifecycle-parent';
  await recordSession(context.dataRoot, { session_id: corruptSession, cwd: context.workspace, source: 'startup' });
  await identity.beginCallerTurn({ sessionId: corruptSession, turnId: 'stale-v2-turn', workspace: context.workspace, permissionMode: 'acceptEdits', prompt: '$zcode:rescue private stale sentinel' });
  const session = await resolveRecordedSessionStart(context.dataRoot, context.workspace, corruptSession);
  await identity.beginCallerTurn({
    sessionId: corruptSession, turnId: 'proved-turn', workspace: context.workspace, permissionMode: 'acceptEdits', prompt: '$zcode:rescue private lifecycle sentinel',
    sessionStartedAt: session.startedAt, sessionSource: session.source,
  });
  const activeNames = await readdir(join(context.dataRoot, 'identity-lifecycle', 'active-turns'));
  assert.equal(activeNames.length, 1); await writeFile(join(context.dataRoot, 'identity-lifecycle', 'active-turns', activeNames[0]), '{}\n');
  const corruptRole = await role(corruptSession); const corruptPublic = JSON.parse(corruptRole.stdout);
  assert.deepEqual(corruptPublic, { type: 'role-status', role: 'zcode-rescue', status: 'caller-unavailable', remedy: 'Retry from an active owned parent turn.' });
  assert.ok(Buffer.byteLength(corruptRole.stdout) < 1024); assert.doesNotMatch(corruptRole.stdout, /private|lifecycle|stale-v2|AUTHORIZATION/u);
  let corruptReads = 0;
  const corruptInput = { async *[Symbol.asyncIterator]() { corruptReads += 1; yield Buffer.from('{"private":"sentinel"}\n'); } };
  await assert.rejects(runDirectInvocation(['prepare', 'rescue'], {
    cwd: context.workspace, env: { ...context.env, CODEX_THREAD_ID: corruptSession }, input: /** @type {any} */ (corruptInput),
  }), { code: 'AUTHORIZATION_RECORD_INVALID' });
  assert.equal(corruptReads, 0, 'malformed lifecycle authority must reject before private input reads');
});

test('role-status rescue maps every non-ready managed state to the exact setup remedy', async () => {
  const context = await fixture();
  for (const status of ['restart-required', 'install-required', 'upgrade-required', 'drift', 'foreign-conflict', 'project-shadowed', 'higher-precedence-conflict', 'unsupported']) {
    const output = await runCompanion(['role-status', 'rescue'], { cwd: context.workspace, env: context.env, dependencies: { inspectRescueRoleStatus: async () => ({ status }) } });
    assert.deepEqual(output, { type: 'role-status', role: 'zcode-rescue', status, remedy: '$zcode:setup' });
    assert.ok(Buffer.byteLength(renderOutput(output)) < 256);
  }
  const invalid = await runCompanion(['role-status', 'rescue'], { cwd: context.workspace, env: context.env, dependencies: { inspectRescueRoleStatus: async () => ({ status: 'secret'.repeat(10_000) }) } });
  assert.deepEqual(invalid, { type: 'role-status', role: 'zcode-rescue', status: 'inspection-unavailable', remedy: 'Retry Role preflight.' });
  const privateError = 'PRIVATE_PATH_SENTINEL /private/config/layer.toml private-thread-id';
  const failed = await runCompanion(['role-status', 'rescue'], { cwd: context.workspace, env: context.env, dependencies: { inspectRescueRoleStatus: async () => { throw new Error(privateError); } } });
  assert.deepEqual(failed, { type: 'role-status', role: 'zcode-rescue', status: 'inspection-unavailable', remedy: 'Retry Role preflight.' });
  for (const output of [invalid, failed]) {
    const rendered = renderOutput(output);
    assert.ok(Buffer.byteLength(rendered) < 256);
    assert.doesNotMatch(rendered, /PRIVATE_PATH_SENTINEL|private-thread-id|private\/config|configuration layer|Error:|at runCompanion/);
  }
});

test('source role-status reports only exact pre-inspection session proof failures without leaking private input', async () => {
  const context = await fixture();
  const privateThread = 'private-session-that-must-not-render';
  const output = await runCompanion(['role-status', 'rescue'], {
    cwd: context.workspace,
    env: { ...context.env, CODEX_THREAD_ID: privateThread },
  });
  assert.deepEqual(output, {
    type: 'role-status', role: 'zcode-rescue', status: 'source-session-unproven',
    remedy: 'Use the instance-bound Rescue launcher from the active lifecycle context; do not run setup from this source checkout.',
  });
  const rendered = renderOutput(output);
  assert.doesNotMatch(rendered, new RegExp(privateThread));
  assert.doesNotMatch(rendered, new RegExp(context.workspace.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(rendered, /\$zcode:setup/);
});

test('source role-status without an ambient thread fails with the fixed terminal diagnostic', async () => {
  const context = await fixture(); const env = /** @type {NodeJS.ProcessEnv} */ ({ ...context.env }); delete env.CODEX_THREAD_ID;
  assert.deepEqual(await runCompanion(['role-status', 'rescue'], { cwd: context.workspace, env }), {
    type: 'role-status', role: 'zcode-rescue', status: 'source-session-unproven',
    remedy: 'Use the instance-bound Rescue launcher from the active lifecycle context; do not run setup from this source checkout.',
  });
});

test('source role-status maps only a missing SessionStart record after an active turn', async () => {
  const context = await fixture(); const sessionId = 'source-role-missing-start';
  await context.identity.beginCallerTurn({
    sessionId, turnId: 'source-role-missing-start-turn', workspace: context.workspace,
    permissionMode: 'workspace-write', prompt: 'Check the source Rescue role.',
  });
  assert.deepEqual(await runCompanion(['role-status', 'rescue'], {
    cwd: context.workspace, env: { ...context.env, CODEX_THREAD_ID: sessionId },
  }), {
    type: 'role-status', role: 'zcode-rescue', status: 'source-session-unproven',
    remedy: 'Use the instance-bound Rescue launcher from the active lifecycle context; do not run setup from this source checkout.',
  });
});

test('source role-status does not relabel a corrupt SessionStart record as a wrong root', async () => {
  const context = await fixture(); const sessionId = 'source-role-corrupt-start';
  await recordSession(context.dataRoot, { session_id: sessionId, cwd: context.workspace });
  await context.identity.beginCallerTurn({
    sessionId, turnId: 'source-role-corrupt-start-turn', workspace: context.workspace,
    permissionMode: 'workspace-write', prompt: 'Check the source Rescue role.',
  });
  const storage = await resolveWorkspaceStorage(context); const hookState = join(storage.directory, 'hook-state');
  const [sessionRecord] = (await readdir(hookState)).filter((name) => name.startsWith('session-'));
  assert.ok(sessionRecord); await writeFile(join(hookState, sessionRecord), '{}\n');
  assert.deepEqual(await runCompanion(['role-status', 'rescue'], {
    cwd: context.workspace, env: { ...context.env, CODEX_THREAD_ID: sessionId },
  }), { type: 'role-status', role: 'zcode-rescue', status: 'caller-unavailable', remedy: 'Retry from an active owned parent turn.' });
});

test('installed companion missing-turn behavior reports caller unavailable without crossing into source diagnostics', async (t) => {
  const context = await fixture(); const codexHome = join(context.directory, 'installed-codex-home');
  const installed = join(codexHome, 'plugins', 'cache', 'vitry', 'zcode', '0.1.0');
  await mkdir(installed, { recursive: true });
  await cp(join(root, 'scripts'), join(installed, 'scripts'), { recursive: true });
  await cp(join(root, 'hooks'), join(installed, 'hooks'), { recursive: true });
  await cp(join(root, 'schemas'), join(installed, 'schemas'), { recursive: true });
  await symlink(dependencyNodeModules, join(installed, 'node_modules'), 'dir');
  const result = await run(process.execPath, [join(installed, 'scripts', 'zcode-companion.mjs'), 'role-status', 'rescue'], {
    cwd: context.workspace,
    env: { ...context.env, CODEX_HOME: codexHome, CODEX_THREAD_ID: 'installed-missing-turn' },
  });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { type: 'role-status', role: 'zcode-rescue', status: 'caller-unavailable', remedy: 'Retry from an active owned parent turn.' });
  t.diagnostic('Installed provenance returns a bounded caller failure and never reads the isolated source namespace.');
});

test('symlinked marketplace hook renders its lexical launcher and the real launcher preserves installed provenance', async (t) => {
  const context = await fixture(); const codexHome = join(context.directory, 'symlink-installed-codex-home');
  const installed = join(codexHome, 'plugins', 'cache', 'vitry', 'zcode', '0.1.0');
  await mkdir(dirname(installed), { recursive: true }); await symlink(root, installed, 'dir');
  const installedData = join(codexHome, 'plugins', 'data', 'zcode-vitry'); await mkdir(installedData, { recursive: true });
  const hookEnv = { ...process.env, CODEX_HOME: codexHome, ZCODE_DATA_ROOT: installedData, PLUGIN_ROOT: installed };
  const sessionId = 'symlink-installed-parent';
  const started = await runChild(process.execPath, [join(installed, 'hooks', 'session-lifecycle-hook.mjs')], {
    cwd: context.workspace, env: hookEnv, ordinaryInput: true,
    input: { session_id: sessionId, cwd: context.workspace, hook_event_name: 'SessionStart', transcript_path: null, model: 'gpt', permission_mode: 'acceptEdits', source: 'startup' },
  });
  assert.equal(started.code, 0, started.stderr || started.stdout);
  const prompted = await runChild(process.execPath, [join(installed, 'hooks', 'user-prompt-hook.mjs')], {
    cwd: context.workspace, env: hookEnv, ordinaryInput: true,
    input: { session_id: sessionId, turn_id: 'symlink-installed-turn', cwd: context.workspace, hook_event_name: 'UserPromptSubmit', transcript_path: null, model: 'gpt', permission_mode: 'acceptEdits', prompt: '$zcode:rescue inspect symlink provenance' },
  });
  assert.equal(prompted.code, 0, prompted.stderr || prompted.stdout);
  const promptContext = JSON.parse(prompted.stdout).hookSpecificOutput.additionalContext;
  assert.equal(JSON.parse(promptContext.slice(promptContext.indexOf('{'))).launcherCommand, `node "${join(installed, 'skills', 'rescue', 'launcher.mjs')}"`);
  const linked = await addLinkedWorktree(context.workspace, context.directory, 'symlink-installed-target');
  const configFile = join(installedData, 'config.toml');
  const config = { config: {}, origins: {}, layers: [{ name: { type: 'user', file: configFile }, version: 'version-1', config: {} }] };
  const installedLauncher = join(installed, 'skills', 'rescue', 'launcher.mjs');
  const result = await run(process.execPath, [installedLauncher, 'role-status', 'rescue'], {
    cwd: linked,
    env: {
      ...process.env, CODEX_HOME: codexHome, CODEX_THREAD_ID: sessionId,
      CODEX_APP_SERVER_PATH: process.execPath, CODEX_APP_SERVER_ARGS_JSON: JSON.stringify([fakeCodex]),
      FAKE_CODEX_CONFIG_RESULT: JSON.stringify(config),
    },
  });
  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.deepEqual(JSON.parse(result.stdout), { type: 'role-status', role: 'zcode-rescue', status: 'install-required', remedy: '$zcode:setup' });
  assert.ok((await readdir(join(installedData, 'identity-lifecycle', 'active-turns'))).length === 1);

  const ttyRecord = join(context.directory, 'symlink-installed-prepare-tty.txt'); await writeFile(ttyRecord, '');
  const appServerRecord = join(context.directory, 'symlink-installed-prepare-app-server.jsonl'); await writeFile(appServerRecord, '');
  const child = spawn(process.execPath, [installedLauncher, 'prepare', 'rescue'], {
    cwd: linked,
    env: {
      ...process.env, CODEX_HOME: codexHome, CODEX_THREAD_ID: sessionId,
      CODEX_APP_SERVER_PATH: process.execPath, CODEX_APP_SERVER_ARGS_JSON: JSON.stringify([fakeCodex]),
      FAKE_CODEX_THREAD_LIST_RESULTS_JSON: JSON.stringify({ data: [], nextCursor: null, backwardsCursor: null }),
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${prepareTtyShim}`.trim(), ZCODE_PREPARE_TTY_RECORD: ttyRecord,
      FAKE_CODEX_RECORD: appServerRecord,
    },
    stdio: ['pipe', 'pipe', 'pipe'], shell: false,
  });
  let stdout = ''; let stderr = ''; let exited = false;
  child.stdout?.on('data', (chunk) => { stdout += chunk; }); child.stderr?.on('data', (chunk) => { stderr += chunk; });
  const exit = new Promise((resolveExit, reject) => child.once('error', reject).once('exit', (code, signal) => { exited = true; resolveExit({ code, signal }); }));
  t.after(() => { if (!exited) child.kill('SIGKILL'); });
  await waitFor(async () => stdout.includes('preparation-input-ready'), 'symlinked installed launcher did not reach preparation readiness');
  child.stdin?.end(`${JSON.stringify({ version: 1, source: 'explicit', task: 'symlink installed task', options: {} })}\n`);
  assert.deepEqual(await exit, { code: 0, signal: null }, stderr || stdout); assert.equal(stderr, '');
  assert.equal(stdout, '{"type":"preparation-input-ready","command":"rescue"}\n{"type":"prepared","command":"rescue","route":{"version":1,"action":"spawn","taskName":"zcode_rescue_task"}}\n');
  const appServerRequests = (await readFile(appServerRecord, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.ok(appServerRequests.some((request) => request.method === 'thread/list'), 'prepare must use the injected fake Codex app-server');
  assert.equal((await createRescuePreparationStore({ dataRoot: installedData }).consume({
    sessionId, turnId: 'symlink-installed-turn', workspace: linked, permissionMode: 'acceptEdits', executorAgentId: 'symlink-installed-child',
    activationProof: { kind: 'spawn', taskName: 'zcode_rescue_task', agentPathDigest: createHash('sha256').update('/root/zcode_rescue_task').digest('hex') },
  })).envelope.task, 'symlink installed task');
});

test('installed prepare fails closed when exact-parent discovery finds an active host-only Rescue child', async (t) => {
  const context = await fixture(); const codexHome = join(context.directory, 'collision-installed-codex-home');
  const installed = join(codexHome, 'plugins', 'cache', 'vitry', 'zcode', '0.1.0');
  await mkdir(dirname(installed), { recursive: true }); await symlink(root, installed, 'dir');
  const installedData = join(codexHome, 'plugins', 'data', 'zcode-vitry'); await mkdir(installedData, { recursive: true });
  const sessionId = 'empty-preview-collision-parent'; const turnId = 'empty-preview-collision-turn';
  const hookEnv = { ...process.env, CODEX_HOME: codexHome, ZCODE_DATA_ROOT: installedData, PLUGIN_ROOT: installed };
  const started = await runChild(process.execPath, [join(installed, 'hooks', 'session-lifecycle-hook.mjs')], {
    cwd: context.workspace, env: hookEnv, ordinaryInput: true,
    input: { session_id: sessionId, cwd: context.workspace, hook_event_name: 'SessionStart', transcript_path: null, model: 'gpt', permission_mode: 'acceptEdits', source: 'resume' },
  });
  assert.equal(started.code, 0, started.stderr || started.stdout);
  const prompted = await runChild(process.execPath, [join(installed, 'hooks', 'user-prompt-hook.mjs')], {
    cwd: context.workspace, env: hookEnv, ordinaryInput: true,
    input: { session_id: sessionId, turn_id: turnId, cwd: context.workspace, hook_event_name: 'UserPromptSubmit', transcript_path: null, model: 'gpt', permission_mode: 'acceptEdits', prompt: '$zcode:rescue continue restored work' },
  });
  assert.equal(prompted.code, 0, prompted.stderr || prompted.stdout);

  const linked = await addLinkedWorktree(context.workspace, context.directory, 'empty-preview-collision-target');
  const appServerRecord = join(context.directory, 'collision-app-server.jsonl'); await writeFile(appServerRecord, '');
  const zcodeRecord = join(context.directory, 'collision-zcode.jsonl'); await writeFile(zcodeRecord, '');
  const ttyRecord = join(context.directory, 'collision-prepare-tty.txt'); await writeFile(ttyRecord, '');
  const privateTask = 'private collision task must never be public';
  const hostOnlyChild = rawCodexChild({
    id: 'empty-preview-host-only-child', parentThreadId: sessionId, cwd: context.workspace,
  });
  assert.equal(hostOnlyChild.preview, '', 'incident fixture must model Codex global-list omission');
  const child = spawn(process.execPath, [join(installed, 'skills', 'rescue', 'launcher.mjs'), 'prepare', 'rescue'], {
    cwd: linked,
    env: {
      ...process.env, CODEX_HOME: codexHome, CODEX_THREAD_ID: sessionId,
      CODEX_APP_SERVER_PATH: process.execPath, CODEX_APP_SERVER_ARGS_JSON: JSON.stringify([fakeCodex]),
      FAKE_CODEX_THREAD_SPAWN_GRAPH_JSON: JSON.stringify([hostOnlyChild]), FAKE_CODEX_RECORD: appServerRecord,
      FAKE_ZCODE_RECORD: zcodeRecord,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${prepareTtyShim}`.trim(), ZCODE_PREPARE_TTY_RECORD: ttyRecord,
    },
    stdio: ['pipe', 'pipe', 'pipe'], shell: false,
  });
  let stdout = ''; let stderr = ''; let exited = false;
  child.stdout?.on('data', (chunk) => { stdout += chunk; }); child.stderr?.on('data', (chunk) => { stderr += chunk; });
  const exit = new Promise((resolveExit, reject) => child.once('error', reject).once('exit', (code, signal) => { exited = true; resolveExit({ code, signal }); }));
  t.after(() => { if (!exited) child.kill('SIGKILL'); });
  await waitFor(async () => stdout.includes('preparation-input-ready'), 'collision prepare did not reach input readiness');
  child.stdin?.end(`${JSON.stringify({ version: 1, source: 'explicit', task: privateTask, options: {} })}\n`);
  assert.deepEqual(await exit, { code: 1, signal: null }, stderr || stdout);
  assert.equal(stderr, '');
  assert.match(stdout, /^\{"type":"preparation-input-ready","command":"rescue"\}\n\{"error":\{"code":"EXECUTOR_STATE_MISMATCH"/u);

  const requests = (await readFile(appServerRecord, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const listRequests = requests.filter((request) => request.method === 'thread/list');
  assert.equal(listRequests.length, 1, 'prepare must issue exactly one collision-discovery request without retrying');
  assert.equal(listRequests[0].params.parentThreadId, sessionId, 'collision discovery must query the exact parent relationship');
  assert.equal(requests.filter((request) => request.method === 'thread/read').length, 0, 'planner must not add a second app-server child read');
  assert.equal(await readFile(zcodeRecord, 'utf8'), '', 'prepare must not invoke ZCode');
  const storage = await resolveWorkspaceStorage({ dataRoot: installedData, workspace: linked });
  const preparations = (await readdir(join(storage.directory, 'invocations', 'prepared')).catch((error) => error.code === 'ENOENT' ? [] : Promise.reject(error))).filter((name) => name.endsWith('.json'));
  assert.equal(preparations.length, 0, 'active host mismatch must fail before saving a preparation');
  assert.doesNotMatch(`${stdout}${stderr}${await readFile(appServerRecord, 'utf8')}`, new RegExp(privateTask));
});

test('source role-status does not relabel inspection and configuration failures', async () => {
  const context = await fixture();
  for (const error of [
    new PluginError('ROLE_CONFIG_INVALID', 'private role detail', { category: 'configuration' }),
    new Error('private unknown detail'),
  ]) {
    const output = await runCompanion(['role-status', 'rescue'], {
      cwd: context.workspace,
      env: context.env,
      dependencies: { inspectRescueRoleStatus: async () => { throw error; } },
    });
    assert.deepEqual(output, { type: 'role-status', role: 'zcode-rescue', status: 'inspection-unavailable', remedy: 'Retry Role preflight.' });
  }
  const forged = await runCompanion(['role-status', 'rescue'], {
    cwd: context.workspace, env: context.env,
    dependencies: { inspectRescueRoleStatus: async () => ({ status: 'source-session-unproven' }) },
  });
  assert.deepEqual(forged, { type: 'role-status', role: 'zcode-rescue', status: 'inspection-unavailable', remedy: 'Retry Role preflight.' });
});

/** @param {any[]} [calls] */
function missingRemoteDependencies(calls = []) {
  return {
    discoverLaunch: async () => { calls.push('discover'); return { command: process.execPath, args: [fake], target: fake }; },
    createManagedZCodeClient: async (/** @type {any} */ options) => {
      assert.equal(Object.hasOwn(options, 'completionTimeoutMs'), false, 'ordinary recovery clients must not receive a completion deadline');
      calls.push({ type: 'client', ownerId: options.ownerId });
      return { listSessions: async () => { calls.push('list'); return { sessions: [] }; }, close: async () => { calls.push('close'); } };
    },
  };
}

async function recoverForeignCompletion() {
  const context = await fixture(); const ownerA = caller('departed-owner', 'owner-a-turn'); const ownerB = caller('new-owner', 'owner-b-turn');
  const { job: orphan, store } = await reserveOrphan(context, { ownerSessionId: ownerA.sessionId, ownerTurnId: ownerA.turnId });
  const dependencies = {
    discoverLaunch: async () => ({ command: process.execPath, args: [fake], target: fake }),
    createManagedZCodeClient: async (/** @type {any} */ options) => {
      assert.equal(options.ownerId, ownerIdForSession(ownerA.sessionId));
      return {
        listSessions: async () => ({ sessions: [{ sessionId: orphan.zcodeSessionId }] }),
        readSession: async () => ({ projection: { status: 'completed' }, runtime: { stateRevision: 8 }, messages: [{ info: { role: 'assistant', messageId: 'recovered-answer', parentMessageId: orphan.inputId }, parts: [{ type: 'text', text: 'owner A recovered result' }] }] }),
        close: async () => {},
      };
    },
  };
  const started = await runCompanion(['rescue', '--background', '--fresh', 'new owner work'], { cwd: context.workspace, env: context.env, caller: ownerB, dependencies });
  assert.equal(started.type, 'background'); assert.doesNotMatch(JSON.stringify(started), new RegExp(orphan.id));
  const recovered = await store.readJob(context.workspace, orphan.id); assert.equal(recovered.status, 'succeeded'); assert.equal(recovered.ownerSessionId, ownerA.sessionId);
  return { context, orphan, ownerA, ownerB };
}

test('module import has no CLI side effects', async () => {
  const result = await run(process.execPath, ['--input-type=module', '--eval', `await import(${JSON.stringify(new URL('../../scripts/zcode-companion.mjs', import.meta.url).href)}); process.stdout.write('imported')`]);
  assert.deepEqual({ code: result.code, stdout: result.stdout, stderr: result.stderr }, { code: 0, stdout: 'imported', stderr: '' });
});

test('child-loss teardown rejects unsafe recorded pids before probing or signaling', async () => {
  const selfPid = 424_240; const broker = { endpoint: '/test/broker.sock', instanceId: 'instance', pid: 424_241 }; const worker = { pid: 424_242, ppid: broker.pid };
  /** @type {any[]} */
  const variants = [
    { broker: null, worker },
    { broker: { ...broker, pid: 'malformed' }, worker },
    ...[0, 1, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, selfPid].map((pid) => ({ broker: { ...broker, pid }, worker: { ...worker, ppid: pid } })),
    { broker, worker: [] },
    { broker, worker: { pid: 'malformed', ppid: broker.pid } },
    ...[0, 1, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, selfPid, broker.pid].map((pid) => ({ broker, worker: { ...worker, pid } })),
    ...[0, 1, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, selfPid, broker.pid + 9].map((ppid) => ({ broker, worker: { ...worker, ppid } })),
    { broker, current: { ...broker, pid: 0 }, worker },
  ];
  for (const variant of variants) {
    let killCalls = 0;
    const currentIdentity = variant.current ?? { ...variant.broker };
    await assert.rejects(terminateRecordedOwnedProcesses({
      brokerIdentity: variant.broker, currentIdentity, workerIdentity: variant.worker, selfPid,
      killFn: () => { killCalls += 1; const error = /** @type {NodeJS.ErrnoException} */ (new Error('unexpected kill')); error.code = 'ESRCH'; throw error; },
    }), /unsafe pid/);
    assert.equal(killCalls, 0);
  }
});

test('an already-aborted foreground invocation cancels its reservation before launcher discovery', async () => {
  const context = await fixture(); const controller = new AbortController(); const interruption = new PluginError('JOB_INTERRUPTED', 'before discovery'); controller.abort(interruption); let discoveries = 0; let claimed = false;
  await assert.rejects(runCompanion(['rescue', '--fresh', 'task'], { cwd: context.workspace, env: context.env, caller: { sessionId: 'codex-session', turnId: 'turn-1', permissionMode: 'workspace-write' }, signal: controller.signal, dependencies: {
    testOnlyAfterExecutionClaim: async () => { claimed = true; },
    discoverLaunch: async () => { discoveries += 1; throw new Error('must not discover'); },
  } }), (error) => error === interruption);
  assert.equal(claimed, true); assert.equal(discoveries, 0);
  const jobs = await createStateStore({ dataRoot: context.dataRoot }).listJobs(context.workspace);
  assert.equal(jobs.length, 1); assert.equal(jobs[0].status, 'cancelled'); assert.equal(jobs[0].rescueExecutionClaim, undefined);
});

test('real CLI runs foreground review/adversarial/rescue and persists private artifacts', async () => {
  const context = await fixture();
  for (const args of [
    ['review'],
    ['adversarial-review', 'focus on auth'],
    ['rescue', '--fresh', '--model', 'model', '--effort', 'HIGH', 'repair tests'],
  ]) {
    const result = await companion(context, args);
    assert.equal(result.code, 0, `${result.stderr}${result.stdout}`); assert.equal(result.json.job.status, 'succeeded');
    assert.equal(args[0] === 'rescue' ? result.json.result : JSON.parse(result.json.result).findings.length, args[0] === 'rescue' ? 'done' : 0);
  }
  const storage = await resolveWorkspaceStorage(context);
  const owners = JSON.parse(await readFile(join(storage.directory, 'broker', 'session-owners.json'), 'utf8'));
  assert.ok(Object.values(owners.sessions).every((owner) => owner === ownerIdForSession('codex-session')));
  for (const directory of ['prompts', 'results']) {
    const entries = await readdir(join(storage.directory, directory)); assert.ok(entries.length >= 3);
    for (const entry of entries) { const entryStat = await stat(join(storage.directory, directory, entry)); if (process.platform === 'win32') assert.equal(entryStat.isFile(), true); else assert.equal(entryStat.mode & 0o777, 0o600); }
  }
  const allText = (await Promise.all((await readdir(join(storage.directory, 'prompts'))).map((name) => readFile(join(storage.directory, 'prompts', name), 'utf8')))).join('\n');
  assert.match(allText, /UNTRUSTED GIT DATA/); assert.match(allText, /focus on auth/); assert.doesNotMatch(allText, new RegExp(context.caller));
});

test('rescue task semantics reach the fake peer as the authorized objective', async () => {
  const context = await fixture(); const task = 'repair auth and preserve the literal marker TASK-7'; const record = join(context.directory, 'authorized-objective.jsonl');
  const result = await companion(context, ['rescue', '--fresh', '--wait', ...task.split(' ')], { FAKE_ZCODE_RESULT_FROM_AUTHORIZED_OBJECTIVE: '1', FAKE_ZCODE_RECORD: record });
  assert.equal(result.code, 0, `${result.stderr}${result.stdout}`);
  assert.equal(result.json.result, `authorized:${task}`);
  const sent = (await readFile(record, 'utf8')).trim().split('\n').map((line) => JSON.parse(line)).find((frame) => frame.method === 'session/send');
  assert.match(sent.params.content, /AUTHORIZED RESCUE OBJECTIVE/);
  assert.match(sent.params.content, /UNTRUSTED GIT DATA/);
});

test('foreground rescue streams safe progress to stderr and durably exposes it through status', async () => {
  const context = await fixture();
  const result = await companionWithArchiveHandshake(context, ['rescue', '--fresh', 'surface progress']);
  assert.equal(result.code, 0, `${result.stderr}${result.stdout}`); assert.equal(result.stdout, 'done\n');
  assert.match(result.stderr, /\[zcode\] ZCode started the delegated turn\./);
  assert.match(result.stderr, /\[zcode\] ZCode is generating a response\./);
  assert.match(result.stderr, /\[zcode\] ZCode started a tool call\./);
  assert.match(result.stderr, /\[zcode\] ZCode completed a tool call\./);
  const status = await companion(context, ['status', result.json.job.id]);
  assert.equal(status.code, 0, `${status.stderr}${status.stdout}`);
  assert.equal(status.json.job.phase, 'finalizing');
  assert.ok(Date.parse(status.json.job.lastActivityAt));
  assert.deepEqual(status.json.job.progressPreview, [
    'ZCode is retrying the model request.',
    'ZCode tool work is still running.',
    'ZCode completed a tool call.',
    'ZCode completed the delegated turn.',
  ]);
  const log = await readFile(status.json.job.logFile, 'utf8');
  const archivedMessages = [
    'ZCode started the delegated turn.', 'ZCode is generating a response.', 'ZCode started a tool call.',
    'ZCode is retrying the model request.', 'ZCode tool work is still running.', 'ZCode completed a tool call.',
    'ZCode completed the delegated turn.',
  ];
  let previousIndex = -1;
  for (const message of archivedMessages) {
    const index = log.indexOf(message); assert.ok(index > previousIndex, `${message} must be archived in receive order`); previousIndex = index;
  }
  assert.match(log, /Assistant message\ndone\n/);
  assert.match(log, /Final output\ndone\n/);
  assert.doesNotMatch(log, /RAW_TOOL_OUTPUT|PRIVATE_REASONING|CAPABILITY_TOKEN/);
});

test('conversation online progress reaches stderr and preview while initial and foreign frames stay private', async () => {
  const context = await fixture(); const record = join(context.directory, 'conversation-progress-requests.jsonl');
  const result = await companion(context, ['rescue', '--fresh', 'surface conversation progress'], { FAKE_ZCODE_CONVERSATION_PROGRESS: '1', FAKE_ZCODE_RECORD: record });
  assert.equal(result.code, 0, `${result.stderr}${result.stdout}`); assert.equal(result.json.result, 'done');
  assert.match(result.stderr, /\[zcode\] Running command: npm test\./);
  assert.match(result.stderr, /\[zcode\] Command completed: npm test \(25ms\)\./);
  assert.doesNotMatch(result.stderr, /INITIAL_SECRET|FOREIGN_SECRET|raw output|reasoning/);
  const status = await companion(context, ['status', result.json.job.id]);
  assert.match(JSON.stringify(status.json.job.progressPreview), /Running command: npm test/);
  assert.doesNotMatch(JSON.stringify(status.json.job.progressPreview), /INITIAL_SECRET|FOREIGN_SECRET/);
  assert.equal(status.json.job.progressProbe.state, 'online');
  assert.equal(status.json.job.progressProbe.acceptedOnline, 2);
  const requests = (await readFile(record, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(requests.filter((request) => request.method === 'session/read').length, 1, 'Task 3 progress must not add snapshot reads');
});

test('observed unknown conversation rows and a sequence gap preserve later safe progress', async () => {
  const context = await fixture();
  const scenario = await deterministicConversationScenario(context, 'observed-traffic');
  const visible = `${scenario.lines.join('')}${renderOutput(scenario.output, { json: true })}${JSON.stringify(scenario.status)}`;
  assert.match(visible, /ZCode turn started\./);
  assert.match(visible, /Read completed \(25ms\)\./);
  assert.doesNotMatch(visible, /PRIVATE_OBSERVED_(?:UNKNOWN|STALE|INTERLEAVED)/);
  assert.equal(scenario.output.result, 'done');
  assert.equal(scenario.stored.progressProbe.state, 'online');
  assert.equal(scenario.stored.progressProbe.acceptedOnline, 2);
  assert.equal(scenario.stored.progressProbe.rejected.sequence, 1);
  assert.deepEqual(scenario.status.job.progressProbe, scenario.stored.progressProbe);
  assert.equal(scenario.requests.filter((request) => request.method === 'session/read').length, 1);
});

test('exclusive-baseline conversation ranges emit each known lifecycle once', async () => {
  const context = await fixture();
  const scenario = await deterministicConversationScenario(context, 'exclusive-ranges');
  const visible = `${scenario.lines.join('')}${renderOutput(scenario.output, { json: true })}${JSON.stringify(scenario.status)}`;
  assert.equal(scenario.lines.filter((line) => line === '[zcode] ZCode turn started.\n').length, 1);
  assert.equal(scenario.lines.filter((line) => line === '[zcode] Running tool: Read.\n').length, 1);
  assert.equal(scenario.lines.filter((line) => line === '[zcode] Read completed (25ms).\n').length, 1);
  assert.doesNotMatch(visible, /PRIVATE_CUMULATIVE_ROW/);
  assert.equal(scenario.output.result, 'done');
  assert.equal(scenario.stored.progressProbe.state, 'online');
  assert.equal(scenario.stored.progressProbe.acceptedOnline, 4);
  assert.equal(scenario.stored.progressProbe.rejected.sequence, 0);
  assert.deepEqual(scenario.status.job.progressProbe, scenario.stored.progressProbe);
  assert.equal(scenario.requests.filter((request) => request.method === 'session/read').length, 1);
});

test('initial-only conversation frames deterministically degrade on heartbeat without leaking frame material', async () => {
  const context = await fixture(); const scenario = await deterministicConversationScenario(context, 'initial-only', { heartbeat: true });
  const diagnostic = '[zcode] ZCode conversation frames were unavailable; using bounded session progress.\n';
  assert.equal(scenario.lines.filter((line) => line === diagnostic).length, 1);
  assert.equal(scenario.output.result, 'done'); assert.equal(scenario.output.job.status, 'succeeded'); assert.equal(scenario.output.job.exitCode, 0);
  assert.equal(scenario.stored.progressProbe.state, 'snapshot-fallback');
  assert.equal(scenario.stored.progressProbe.acceptedInitial, 1); assert.equal(scenario.stored.progressProbe.acceptedOnline, 0);
  assert.deepEqual(scenario.status.job.progressProbe, scenario.stored.progressProbe);
  const visible = `${scenario.lines.join('')}${renderOutput(scenario.output, { json: true })}${JSON.stringify(scenario.status)}`;
  assert.doesNotMatch(visible, /PRIVATE_INITIAL_(?:FRAME_ID|TURN_ID|TOOL_ID|COMMAND|REASONING)/);
  assert.equal(scenario.requests.filter((request) => request.method === 'session/read').length, 2, 'one progress read remains separate from the final authoritative read');
});

test('initial-only frames fall back to safe current-turn session tool progress without changing the final result', async () => {
  const context = await fixture();
  const pathSentinel = 'CONTAINED_SNAPSHOT_PATH_SENTINEL.txt';
  const scenario = await deterministicConversationScenario(context, 'initial-only', {
    heartbeat: true, completionAfterProgressLine: '[zcode] Running tool: Read.\n', env: {
      FAKE_ZCODE_SESSION_PROGRESS: 'running',
      FAKE_ZCODE_SESSION_PROGRESS_TOOL: 'Read', FAKE_ZCODE_SESSION_PROGRESS_PATH: join(context.workspace, pathSentinel),
    },
  });
  const visible = `${scenario.lines.join('')}${renderOutput(scenario.output, { json: true })}${JSON.stringify(scenario.status)}`;
  assert.match(visible, /ZCode conversation frames were unavailable; using bounded session progress\./);
  assert.match(visible, /Running tool: Read\./);
  assert.doesNotMatch(scenario.lines.join(''), new RegExp(pathSentinel));
  assert.doesNotMatch(JSON.stringify(scenario.status.job.progressPreview), new RegExp(pathSentinel));
  assert.doesNotMatch(visible, /PRIVATE_SNAPSHOT_(?:PROSE|REASONING|COMMAND|OUTPUT|ERROR|METADATA|FILE|PATCH|CALL|CAPABILITY)/);
  assert.equal(scenario.output.result, 'done'); assert.equal(scenario.output.job.status, 'succeeded'); assert.equal(scenario.output.job.exitCode, 0);
  assert.equal(scenario.requests.filter((request) => request.method === 'session/read').length, 2);
});

test('snapshot fallback emits a terminal-only safe event when the call first appears terminal', async () => {
  const context = await fixture();
  const scenario = await deterministicConversationScenario(context, 'initial-only', {
    heartbeat: true, completionAfterProgressLine: '[zcode] Bash completed (10ms).\n',
    env: { FAKE_ZCODE_SESSION_PROGRESS: 'terminal' },
  });
  const visible = `${scenario.lines.join('')}${renderOutput(scenario.output, { json: true })}${JSON.stringify(scenario.status)}`;
  assert.match(visible, /Bash completed \(10ms\)\./); assert.doesNotMatch(visible, /Running tool: Bash\./);
  assert.doesNotMatch(visible, /PRIVATE_SNAPSHOT_/);
  assert.equal(scenario.output.result, 'done'); assert.equal(scenario.requests.filter((request) => request.method === 'session/read').length, 2);
});

test('snapshot read rejection degrades once to lifecycle-only and preserves authoritative completion', async () => {
  const context = await fixture();
  const scenario = await deterministicConversationScenario(context, 'initial-only', {
    heartbeat: true, completionAfterProgressLine: '[zcode] ZCode semantic progress is unavailable; lifecycle updates will continue.\n',
    env: { FAKE_ZCODE_SESSION_PROGRESS_READ_FAIL: '1' },
  });
  const fallback = '[zcode] ZCode conversation frames were unavailable; using bounded session progress.\n';
  const degraded = '[zcode] ZCode semantic progress is unavailable; lifecycle updates will continue.\n';
  assert.equal(scenario.lines.filter((line) => line === fallback).length, 1);
  assert.equal(scenario.lines.filter((line) => line === degraded).length, 1);
  assert.equal(scenario.stored.progressProbe.state, 'lifecycle-only');
  assert.equal(scenario.output.result, 'done'); assert.equal(scenario.output.job.status, 'succeeded'); assert.equal(scenario.output.job.exitCode, 0);
  assert.doesNotMatch(scenario.lines.join(''), /PRIVATE_SNAPSHOT_READ_REJECTION/);
  assert.equal(scenario.requests.filter((request) => request.method === 'session/read').length, 2);
});

test('later accepted online recovery stops snapshot reads and discards a delayed old result', async () => {
  const context = await fixture();
  const scenario = await deterministicConversationScenario(context, 'initial-only', {
    heartbeat: true, completionAfterProgressLine: '[zcode] ZCode turn started.\n',
    env: { FAKE_ZCODE_SESSION_PROGRESS_RECOVERY: '1', FAKE_ZCODE_WAIT_FOR_PROGRESS_READ: '1' },
  });
  const visible = `${scenario.lines.join('')}${renderOutput(scenario.output, { json: true })}${JSON.stringify(scenario.status)}`;
  assert.equal(scenario.stored.progressProbe.state, 'online'); assert.equal(scenario.stored.progressProbe.acceptedOnline, 1);
  assert.match(scenario.lines.join(''), /ZCode turn started\./, 'a production-shape turnHeader supplies semantic health');
  assert.doesNotMatch(visible, /PRIVATE_LATE_SNAPSHOT|Running tool: Bash\./);
  assert.equal(scenario.output.result, 'done'); assert.equal(scenario.output.job.status, 'succeeded'); assert.equal(scenario.output.job.exitCode, 0);
  assert.equal(scenario.requests.filter((request) => request.method === 'session/read').length, 2, 'one late progress read plus one final authoritative read');
});

test('accepted zero-event online conversation frame remains eligible for deterministic heartbeat fallback', async () => {
  const context = await fixture(); const scenario = await deterministicConversationScenario(context, 'zero-online', { heartbeat: true });
  assert.equal(scenario.output.result, 'done'); assert.equal(scenario.output.job.status, 'succeeded'); assert.equal(scenario.output.job.exitCode, 0);
  assert.equal(scenario.stored.progressProbe.state, 'snapshot-fallback'); assert.equal(scenario.stored.progressProbe.acceptedOnline, 1);
  assert.equal(scenario.lines.filter((line) => /ZCode conversation frames were unavailable/.test(line)).length, 1);
  assert.deepEqual(scenario.status.job.progressProbe, scenario.stored.progressProbe);
  assert.equal(scenario.requests.filter((request) => request.method === 'session/read').length, 2, 'one fallback progress read remains separate from the final authoritative read');
});

test('malformed conversation rejection burst degrades once without leaking rejected payloads or changing completion', async () => {
  const context = await fixture(); const scenario = await deterministicConversationScenario(context, 'rejection-burst');
  const diagnostic = '[zcode] ZCode conversation frames were unavailable; using bounded session progress.\n';
  assert.equal(scenario.lines.filter((line) => line === diagnostic).length, 1);
  assert.equal(scenario.output.result, 'done'); assert.equal(scenario.output.job.status, 'succeeded'); assert.equal(scenario.output.job.exitCode, 0);
  assert.equal(scenario.stored.progressProbe.state, 'snapshot-fallback'); assert.equal(scenario.stored.progressProbe.rejected['row-shape'], 4);
  assert.deepEqual(scenario.status.job.progressProbe, scenario.stored.progressProbe);
  const visible = `${scenario.lines.join('')}${renderOutput(scenario.output, { json: true })}${JSON.stringify(scenario.status)}`;
  assert.doesNotMatch(visible, /PRIVATE_REJECTED_(?:FRAME|ROW|COMMAND|REASONING)/);
  assert.equal(scenario.requests.filter((request) => request.method === 'session/read').length, 2, 'one progress read remains separate from the final authoritative read');
});

test('one sequence gap restores continuity without treating an empty online frame as semantic health', async () => {
  const context = await fixture(); const scenario = await deterministicConversationScenario(context, 'sequence-gap');
  assert.equal(scenario.output.result, 'done'); assert.equal(scenario.stored.progressProbe.rejected.sequence, 1);
  assert.equal(scenario.stored.progressProbe.acceptedOnline, 1);
  assert.equal(scenario.stored.progressProbe.state, 'probing');
  assert.deepEqual(scenario.status.job.progressProbe, scenario.stored.progressProbe);
  assert.equal(scenario.lines.filter((line) => /conversation frames were unavailable/.test(line)).length, 0);
  const visible = `${scenario.lines.join('')}${JSON.stringify(scenario.status)}`;
  assert.doesNotMatch(visible, /PRIVATE_SEQUENCE_FRAME|logicalFrame|ordinal|fromSeq|toSeq/);
});

test('conversation online progress sent before the subscribe response is buffered until the subscription binds', async () => {
  const context = await fixture();
  const result = await companion(context, ['rescue', '--fresh', 'prebind conversation progress'], { FAKE_ZCODE_CONVERSATION_PREBIND_ONLINE: '1' });
  assert.equal(result.code, 0, `${result.stderr}${result.stdout}`); assert.equal(result.json.result, 'done');
  assert.match(result.stderr, /Running command: echo prebind\./);
  const status = await companion(context, ['status', result.json.job.id]);
  assert.match(JSON.stringify(status.json.job.progressPreview), /Running command: echo prebind/);
});

test('conversation subscribe failure is observational, durable, and preserves the exact result', async () => {
  const context = await fixture();
  const result = await companion(context, ['rescue', '--fresh', 'subscribe failure'], { FAKE_ZCODE_CONVERSATION_SUBSCRIBE_FAIL: '1' });
  assert.equal(result.code, 0, `${result.stderr}${result.stdout}`);
  assert.equal(result.json.result, 'done'); assert.equal(result.json.job.status, 'succeeded');
  assert.match(result.stderr, /^\[zcode\] ZCode started the delegated turn\.\n\[zcode\] ZCode conversation progress is unavailable\.\n\[zcode\] ZCode completed the delegated turn\.\n(?:\[zcode\] ZCode progress cleanup reached its time limit\.\n)?$/u);
  assert.doesNotMatch(`${result.stderr}${result.stdout}${result.internal}`, /unsupported conversation subscription|-32601/);
  const status = await companion(context, ['status', result.json.job.id]);
  assert.equal(status.json.job.status, 'succeeded');
  if (!result.stderr.includes('progress cleanup reached its time limit')) assert.match(JSON.stringify(status.json.job.progressPreview), /conversation progress is unavailable/);
});

test('conversation unsubscribe failure is observational and preserves the exact result', async () => {
  const context = await fixture();
  const result = await companion(context, ['rescue', '--fresh', 'unsubscribe failure'], { FAKE_ZCODE_CONVERSATION_UNSUBSCRIBE_FAIL: '1' });
  assert.equal(result.code, 0, `${result.stderr}${result.stdout}`);
  assert.equal(result.json.result, 'done'); assert.equal(result.json.job.status, 'succeeded');
  assert.match(result.stderr, /^\[zcode\] ZCode started the delegated turn\.\n\[zcode\] ZCode completed the delegated turn\.\n\[zcode\] ZCode conversation progress cleanup was incomplete\.\n(?:\[zcode\] ZCode progress cleanup reached its time limit\.\n\[zcode\] ZCode progress archive was disabled\.\n)?$/u);
  assert.doesNotMatch(`${result.stderr}${result.stdout}${result.internal}`, /unsubscribe failed|-32099/);
  const status = await companion(context, ['status', result.json.job.id]);
  assert.equal(status.json.job.status, 'succeeded');
});

test('foreground SIGINT stops the accepted ZCode session, exits 130, and leaves no running job', { skip: windowsRealSignalSkip }, async (t) => {
  const context = await fixture(); const record = join(context.directory, 'interrupt.jsonl'); await writeFile(record, '');
  const child = spawn(process.execPath, [cli, 'rescue', '--fresh', 'interrupt me'], {
    cwd: context.workspace,
    env: { ...context.env, FAKE_ZCODE_RECORD: record, FAKE_ZCODE_SUPPRESS_FIRST_COMPLETION: '1' },
    stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'],
    shell: false,
  });
  let stdout = ''; let stderr = ''; let internal = ''; let exited = false;
  child.stdout?.on('data', (chunk) => { stdout += chunk; }); child.stderr?.on('data', (chunk) => { stderr += chunk; }); child.stdio[4]?.on('data', (chunk) => { internal += chunk; });
  child.stdio[3]?.on('error', consumePipeError); child.stdio[4]?.on('error', consumePipeError);
  /** @type {import('node:stream').Writable} */ (child.stdio[3]).end(`${JSON.stringify({ callerContext: context.caller })}\n`);
  t.after(() => { if (!exited) child.kill('SIGKILL'); });

  const recorded = async () => (await readFile(record, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  await waitFor(async () => (await recorded()).some((frame) => frame.method === 'session/send'), 'foreground send was not accepted');
  child.kill('SIGINT');
  const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => { exited = true; resolve({ code, signal }); }); });
  assert.deepEqual(exit, { code: 130, signal: null });
  const calls = await recorded(); const sentSession = calls.find((frame) => frame.method === 'session/send').params.sessionId;
  assert.equal(calls.filter((frame) => frame.method === 'session/stop' && frame.params.sessionId === sentSession).length, 1);
  const jobs = await createStateStore({ dataRoot: context.dataRoot }).listJobs(context.workspace);
  assert.equal(jobs.length, 1); assert.equal(jobs[0].status, 'cancelled'); assert.ok(jobs[0].finishedAt); assert.equal(jobs[0].resultArtifact, undefined);
  assert.equal(stdout, ''); assert.equal(internal, ''); assert.match(stderr, /Interrupted by SIGINT\./); assert.doesNotMatch(stderr, /JOB_INTERRUPTED|"error"/);
});

test('instance-bound launcher preserves prepare raw TTY and SIGTERM exit while stdin remains open', { skip: windowsRealSignalSkip }, async (t) => {
  const context = await fixture(); const ttyRecord = join(context.directory, 'prepare-signal-tty.txt'); await writeFile(ttyRecord, ''); await context.identity.beginCallerTurn({ sessionId: 'prepare-signal-parent', turnId: 'prepare-signal-turn', workspace: context.workspace, permissionMode: 'workspace-write', prompt: 'proactive signal objective' });
  const child = spawn(process.execPath, [rescueLauncher, 'prepare', 'rescue'], { cwd: context.workspace, env: { ...context.env, CODEX_THREAD_ID: 'prepare-signal-parent', NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${prepareTtyShim}`.trim(), ZCODE_PREPARE_TTY_RECORD: ttyRecord }, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
  let stdout = ''; let stderr = ''; let exited = false;
  child.stdout?.on('data', (chunk) => { stdout += chunk; }); child.stderr?.on('data', (chunk) => { stderr += chunk; });
  const exit = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => { exited = true; resolve({ code, signal }); }); });
  t.after(() => { if (!exited) child.kill('SIGKILL'); });
  const readiness = '{"type":"preparation-input-ready","command":"rescue"}\n';
  await waitFor(async () => stdout === readiness, 'private preparation readiness was not emitted');
  child.kill('SIGTERM');
  const bounded = await Promise.race([exit, new Promise((_, reject) => setTimeout(() => reject(new Error('prepare did not exit after SIGTERM')), 1_000))]);
  assert.deepEqual(bounded, { code: 143, signal: null }); assert.equal(stdout, readiness); assert.match(stderr, /Interrupted by SIGTERM\./); assert.doesNotMatch(stderr, /proactive signal objective|prepare-signal/); assert.equal(await readFile(ttyRecord, 'utf8'), 'true\nfalse\n');
});

test('main prepare rejects piped stdin before task input and emits no readiness', async () => {
  const context = await fixture(); await context.identity.beginCallerTurn({ sessionId: 'pipe-parent', turnId: 'pipe-turn', workspace: context.workspace, permissionMode: 'workspace-write', prompt: '$zcode:rescue private piped task' });
  const result = await runChild(process.execPath, [cli, 'prepare', 'rescue'], { cwd: context.workspace, env: { ...context.env, CODEX_THREAD_ID: 'pipe-parent' }, ordinaryInput: true, input: { version: 1, source: 'explicit', task: 'private piped task', options: {} } });
  assert.notEqual(result.code, 0); assert.match(result.stdout, /PREPARATION_TTY_REQUIRED/); assert.doesNotMatch(`${result.stdout}${result.stderr}`, /private piped task|preparation-input-ready/);
});

test('instance-bound launcher preserves prepare stdin/stdout and exits without stdin EOF', async (t) => {
  const context = await fixture(); const ttyRecord = join(context.directory, 'prepare-frame-tty.txt'); await writeFile(ttyRecord, ''); await context.identity.beginCallerTurn({ sessionId: 'frame-parent', turnId: 'frame-turn', workspace: context.workspace, permissionMode: 'workspace-write', prompt: 'proactive frame objective' });
  const child = spawn(process.execPath, [rescueLauncher, 'prepare', 'rescue'], { cwd: context.workspace, env: { ...context.env, CODEX_THREAD_ID: 'frame-parent', NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${prepareTtyShim}`.trim(), ZCODE_PREPARE_TTY_RECORD: ttyRecord }, stdio: ['pipe', 'pipe', 'pipe'], shell: false }); let stdout = ''; let stderr = ''; let exited = false;
  child.stdout?.on('data', (chunk) => { stdout += chunk; }); child.stderr?.on('data', (chunk) => { stderr += chunk; }); const exit = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => { exited = true; resolve({ code, signal }); }); });
  t.after(() => { if (!exited) child.kill('SIGKILL'); }); await waitFor(async () => stdout.includes('preparation-input-ready'), 'private preparation readiness was not emitted');
  child.stdin?.write(`${JSON.stringify({ version: 1, source: 'proactive', task: 'frame objective', options: {} })}\n`);
  assert.deepEqual(await Promise.race([exit, new Promise((_, reject) => setTimeout(() => reject(new Error('prepare waited for EOF after one LF frame')), 1_000))]), { code: 0, signal: null });
  assert.equal(stdout, '{"type":"preparation-input-ready","command":"rescue"}\n{"type":"prepared","command":"rescue","route":{"version":1,"action":"spawn","taskName":"zcode_rescue_task"}}\n'); assert.equal(stderr, ''); assert.equal(await readFile(ttyRecord, 'utf8'), 'true\nfalse\n');
});

test('prepare Rescue exits on SIGTERM after readiness and frame delivery while the save lock is held', { skip: windowsRealSignalSkip }, async (t) => {
  const context = await fixture(); const ttyRecord = join(context.directory, 'prepare-save-tty.txt'); await writeFile(ttyRecord, ''); await context.identity.beginCallerTurn({ sessionId: 'prepare-save-parent', turnId: 'prepare-save-turn', workspace: context.workspace, permissionMode: 'workspace-write', prompt: 'proactive locked objective' });
  const storage = await resolveWorkspaceStorage(context); const holder = spawn(process.execPath, [lockHolder, join(storage.directory, '.rescue-preparation-lock')], { stdio: ['pipe', 'pipe', 'pipe'], shell: false }); let holderStdout = ''; let holderExited = false;
  holder.stdout?.on('data', (chunk) => { holderStdout += chunk; }); const holderExit = new Promise((resolve, reject) => { holder.once('error', reject); holder.once('exit', (code) => { holderExited = true; resolve(code); }); });
  await waitFor(async () => holderStdout.includes('acquired\n'), 'preparation lock holder did not acquire the lock');
  const child = spawn(process.execPath, [cli, 'prepare', 'rescue'], { cwd: context.workspace, env: { ...context.env, CODEX_THREAD_ID: 'prepare-save-parent', NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${prepareTtyShim}`.trim(), ZCODE_PREPARE_TTY_RECORD: ttyRecord }, stdio: ['pipe', 'pipe', 'pipe'], shell: false }); let stdout = ''; let stderr = ''; let exited = false;
  child.stdout?.on('data', (chunk) => { stdout += chunk; }); child.stderr?.on('data', (chunk) => { stderr += chunk; });
  const exit = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => { exited = true; resolve({ code, signal }); }); });
  t.after(() => { if (!exited) child.kill('SIGKILL'); if (!holderExited) holder.kill('SIGKILL'); });
  const readiness = '{"type":"preparation-input-ready","command":"rescue"}\n';
  await waitFor(async () => stdout === readiness, 'contended preparation readiness was not emitted');
  const frame = `${JSON.stringify({ version: 1, source: 'proactive', task: 'locked objective', options: {} })}\n`;
  await new Promise((resolve, reject) => child.stdin?.write(frame, (error) => error ? reject(error) : resolve(undefined)));
  child.kill('SIGTERM');
  const bounded = await Promise.race([exit, new Promise((_, reject) => setTimeout(() => reject(new Error('contended prepare did not exit after SIGTERM')), 1_000))]);
  assert.deepEqual(bounded, { code: 143, signal: null }); assert.equal(stdout, readiness); assert.match(stderr, /Interrupted by SIGTERM\./); assert.doesNotMatch(stderr, /locked objective|prepare-save/); assert.equal(await readFile(ttyRecord, 'utf8'), 'true\nfalse\n');
  holder.stdin?.end('release\n'); assert.equal(await holderExit, 0);
  await assert.rejects(createRescuePreparationStore({ dataRoot: context.dataRoot }).consume({ sessionId: 'prepare-save-parent', turnId: 'prepare-save-turn', workspace: context.workspace, permissionMode: 'workspace-write', executorAgentId: 'child' }), { code: 'RESCUE_PREPARATION_NOT_FOUND' });
});

test('prepare Rescue SIGTERM cancels a hung Codex child list and reaps app-server without saving', { skip: windowsRealSignalSkip }, async (t) => {
  const context = await fixture(); const appRecord = join(context.directory, 'hung-list-app-server.jsonl'); await writeFile(appRecord, '');
  await context.identity.beginCallerTurn({ sessionId: 'hung-list-parent', turnId: 'hung-list-turn', workspace: context.workspace, permissionMode: 'workspace-write', prompt: '$zcode:rescue --fresh hung list task' });
  const ttyRecord = join(context.directory, 'hung-list-tty.txt'); await writeFile(ttyRecord, '');
  const child = spawn(process.execPath, [cli, 'prepare', 'rescue'], {
    cwd: context.workspace,
    env: { ...context.env, CODEX_THREAD_ID: 'hung-list-parent', FAKE_CODEX_RECORD: appRecord, FAKE_CODEX_HANG: 'thread/list', NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${prepareTtyShim}`.trim(), ZCODE_PREPARE_TTY_RECORD: ttyRecord },
    stdio: ['pipe', 'pipe', 'pipe'], shell: false,
  });
  let stdout = ''; let stderr = ''; let exited = false; child.stdout?.on('data', (chunk) => { stdout += chunk; }); child.stderr?.on('data', (chunk) => { stderr += chunk; });
  const exit = new Promise((resolveExit, reject) => child.once('error', reject).once('exit', (code, signal) => { exited = true; resolveExit({ code, signal }); }));
  t.after(() => { if (!exited) child.kill('SIGKILL'); });
  await waitFor(async () => stdout.includes('preparation-input-ready'), 'hung-list prepare did not publish readiness');
  child.stdin?.write(`${JSON.stringify({ version: 1, source: 'explicit', task: 'hung list task', options: { resume: 'fresh' } })}\n`);
  await waitFor(async () => (await readFile(appRecord, 'utf8')).includes('thread/list'), 'hung-list app-server request was not observed');
  const startedAt = Date.now(); child.kill('SIGTERM');
  const exitedResult = await exit;
  assert.deepEqual(exitedResult, { code: 143, signal: null }, `${stdout}${stderr}`); assert.ok(Date.now() - startedAt < 1_000);
  assert.equal(stdout, '{"type":"preparation-input-ready","command":"rescue"}\n'); assert.match(stderr, /Interrupted by SIGTERM\./);
  const frames = (await readFile(appRecord, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(frames.some((frame) => frame.lifecycle === 'SIGTERM'), true);
  await assert.rejects(createRescuePreparationStore({ dataRoot: context.dataRoot }).consume({ sessionId: 'hung-list-parent', turnId: 'hung-list-turn', workspace: context.workspace, permissionMode: 'workspace-write', executorAgentId: 'child' }), { code: 'RESCUE_PREPARATION_NOT_FOUND' });
});

test('invoke-prepared SIGINT cancels a hung Codex child read before consuming or starting ZCode', { skip: windowsRealSignalSkip }, async (t) => {
  const context = await fixture(); const parentSessionId = 'hung-read-parent'; const childId = 'hung-read-child';
  await prepareDirectRescueChild(context, { parentSessionId, parentTurnId: 'hung-read-parent-turn', childId, childTurnId: 'hung-read-child-turn', prompt: '$zcode:rescue --fresh --wait hung read task' });
  const appRecord = join(context.directory, 'hung-read-app-server.jsonl'); await writeFile(appRecord, '');
  const child = spawn(process.execPath, [cli, 'invoke-prepared', 'rescue'], {
    cwd: context.workspace, env: { ...context.env, CODEX_THREAD_ID: childId, FAKE_CODEX_RECORD: appRecord, FAKE_CODEX_HANG: 'thread/read' },
    stdio: ['ignore', 'pipe', 'pipe'], shell: false,
  });
  let stdout = ''; let stderr = ''; let exited = false; child.stdout?.on('data', (chunk) => { stdout += chunk; }); child.stderr?.on('data', (chunk) => { stderr += chunk; });
  const exit = new Promise((resolveExit, reject) => child.once('error', reject).once('exit', (code, signal) => { exited = true; resolveExit({ code, signal }); }));
  t.after(() => { if (!exited) child.kill('SIGKILL'); });
  await waitFor(async () => (await readFile(appRecord, 'utf8')).includes('thread/read'), 'hung-read app-server request was not observed');
  const startedAt = Date.now(); child.kill('SIGINT');
  assert.deepEqual(await exit, { code: 130, signal: null }); assert.ok(Date.now() - startedAt < 1_000);
  assert.equal(stdout, ''); assert.match(stderr, /Interrupted by SIGINT\./);
  const frames = (await readFile(appRecord, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(frames.some((frame) => frame.lifecycle === 'SIGTERM'), true);
  assert.equal(frames.some((frame) => ['session/create', 'session/send'].includes(frame.method)), false);
  assert.deepEqual(await createStateStore({ dataRoot: context.dataRoot }).listJobs(context.workspace), []);
  const storage = await resolveWorkspaceStorage(context); const [name] = (await readdir(join(storage.directory, 'invocations', 'prepared'))).filter((entry) => entry.endsWith('.json'));
  assert.equal(JSON.parse(await readFile(join(storage.directory, 'invocations', 'prepared', name), 'utf8')).consumedAt, null);
});

test('isolated Rescue child SIGTERM after accepted send stops once and keeps the parent thread as durable owner', { skip: windowsRealSignalSkip }, async (t) => {
  const context = await fixture(); const record = join(context.directory, 'isolated-child-sigterm.jsonl'); await writeFile(record, '');
  const parentSessionId = 'isolated-parent'; const parentTurnId = 'isolated-parent-turn'; const childId = 'isolated-rescue-child';
  await prepareDirectRescueChild(context, {
    parentSessionId, parentTurnId, childId, childTurnId: 'isolated-child-turn',
    prompt: '$zcode:rescue --fresh --wait repair after isolated SIGTERM',
  });
  const child = spawn(process.execPath, [cli, 'invoke-prepared', 'rescue'], {
    cwd: context.workspace,
    env: { ...context.env, CODEX_THREAD_ID: childId, FAKE_ZCODE_RECORD: record, FAKE_ZCODE_SUPPRESS_FIRST_COMPLETION: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
  });
  let stdout = ''; let stderr = ''; let exited = false;
  child.stdout?.on('data', (chunk) => { stdout += chunk; }); child.stderr?.on('data', (chunk) => { stderr += chunk; });
  t.after(() => { if (!exited) child.kill('SIGKILL'); });
  const recorded = async () => (await readFile(record, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  await waitForAcceptedBoundary(context, recorded, 'isolated child send boundary was not durably accepted');
  child.kill('SIGTERM');
  const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => { exited = true; resolve({ code, signal }); }); });

  assert.deepEqual(exit, { code: 143, signal: null });
  const calls = await recorded(); const sentSession = calls.find((frame) => frame.method === 'session/send').params.sessionId;
  assert.equal(calls.filter((frame) => frame.method === 'session/send').length, 1);
  assert.equal(calls.filter((frame) => frame.method === 'session/stop' && frame.params.sessionId === sentSession).length, 1);
  const jobs = await createStateStore({ dataRoot: context.dataRoot }).listJobs(context.workspace);
  assert.equal(jobs.length, 1); assert.equal(jobs[0].ownerSessionId, parentSessionId); assert.equal(jobs[0].ownerTurnId, parentTurnId);
  assert.equal(jobs[0].status, 'cancelled'); assert.equal(jobs[0].resultArtifact, undefined);
  assert.equal(stdout, ''); assert.match(stderr, /Interrupted by SIGTERM\./);
});

test('unacknowledged parent SessionEnd retains the durable guard without a second owner-release stop', { skip: windowsRealSignalSkip }, async (t) => {
  const context = await fixture(); const record = join(context.directory, 'session-end-unacknowledged.jsonl'); const recovery = join(context.directory, 'session-end-recovery.json');
  await Promise.all([writeFile(record, ''), writeFile(recovery, JSON.stringify({ mode: 'active' }))]);
  const parentSessionId = 'session-end-parent'; const childId = 'session-end-rescue-child';
  await prepareDirectRescueChild(context, {
    parentSessionId, parentTurnId: 'session-end-parent-turn', childId, childTurnId: 'session-end-child-turn',
    prompt: '$zcode:rescue --fresh --wait preserve the unacknowledged guard',
  });
  const env = {
    ...context.env,
    CODEX_THREAD_ID: childId,
    FAKE_ZCODE_RECORD: record,
    FAKE_ZCODE_RECOVERY_CONTROL: recovery,
    FAKE_ZCODE_SUPPRESS_FIRST_COMPLETION: '1',
    FAKE_ZCODE_STOP_ERROR_ONCE: '1',
  };
  const child = spawn(process.execPath, [cli, 'invoke-prepared', 'rescue'], { cwd: context.workspace, env, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
  let exited = false; child.stdout?.resume(); child.stderr?.resume();
  t.after(() => { if (!exited) child.kill('SIGKILL'); });
  const recorded = async () => (await readFile(record, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  await waitForAcceptedBoundary(context, recorded, 'isolated child send boundary was not durably accepted before SessionEnd');
  child.kill('SIGKILL');
  await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', () => { exited = true; resolve(undefined); }); });

  const hookInput = {
    session_id: parentSessionId,
    cwd: context.workspace,
    hook_event_name: 'SessionEnd',
    transcript_path: null,
    reason: 'other',
  };
  try {
    const first = await runChild(process.execPath, [sessionEndHook], { cwd: context.workspace, env, ordinaryInput: true, input: hookInput });
    assert.equal(first.code, 0, first.stderr || first.stdout);
    const calls = await recorded();
    assert.equal(calls.filter((frame) => frame.method === 'session/send').length, 1);
    assert.equal(calls.filter((frame) => frame.method === 'session/stop').length, 1, 'owner release must not retry an unacknowledged SessionEnd stop behind durable state');
    const [job] = await createStateStore({ dataRoot: context.dataRoot }).listJobs(context.workspace);
    assert.equal(job.ownerSessionId, parentSessionId); assert.equal(job.status, 'running'); assert.equal(job.finishedAt, undefined);
    assert.match(job.lastCancelError, /fixture first stop failed/);
    await assert.rejects(createStateStore({ dataRoot: context.dataRoot }).reserveJob({
      workspace: context.workspace, ownerSessionId: 'later-owner', ownerTurnId: 'later-turn', command: 'rescue', readOnly: false,
      permissionSnapshot: { permissionMode: 'workspace-write' },
    }), { code: 'WRITABLE_JOB_EXISTS' });
  } finally {
    await runChild(process.execPath, [sessionEndHook], { cwd: context.workspace, env, ordinaryInput: true, input: hookInput }).catch(() => {});
  }
});

test('parent steering leaves one isolated Rescue child running with zero cancel or duplicate send', async (t) => {
  const context = await fixture(); const record = join(context.directory, 'steering.jsonl'); const gate = join(context.directory, 'steering.gate');
  await Promise.all([writeFile(record, ''), writeFile(gate, 'hold')]);
  const parentSessionId = 'steering-parent'; const originalTurnId = 'steering-origin'; const childId = 'steering-rescue-child';
  await prepareDirectRescueChild(context, {
    parentSessionId, parentTurnId: originalTurnId, childId, childTurnId: 'steering-child-turn',
    prompt: '$zcode:rescue --fresh --wait keep using the same child',
  });
  const env = { ...context.env, CODEX_THREAD_ID: childId, FAKE_ZCODE_RECORD: record, FAKE_ZCODE_COMPLETION_GATE: gate };
  const child = spawn(process.execPath, [cli, 'invoke-prepared', 'rescue'], { cwd: context.workspace, env, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
  let stdout = ''; let stderr = ''; let exited = false;
  child.stdout?.on('data', (chunk) => { stdout += chunk; }); child.stderr?.on('data', (chunk) => { stderr += chunk; });
  t.after(() => { if (!exited) child.kill('SIGKILL'); });
  const recorded = async () => (await readFile(record, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  await waitForAcceptedBoundary(context, recorded, 'steered child send boundary was not durably accepted', 15_000);

  await createIdentityStore({ dataRoot: context.dataRoot }).beginCallerTurn({
    sessionId: parentSessionId, turnId: 'steering-later-turn', workspace: context.workspace,
    permissionMode: 'workspace-write', prompt: 'ordinary steering that must not cancel or respawn Rescue',
  });
  await writeFile(gate, 'release');
  const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => { exited = true; resolve({ code, signal }); }); });

  assert.deepEqual(exit, { code: 0, signal: null }); assert.equal(stdout, 'done\n'); assert.equal(stderr.includes('Interrupted by'), false);
  const calls = await recorded(); assert.equal(calls.filter((frame) => frame.method === 'session/send').length, 1); assert.equal(calls.filter((frame) => frame.method === 'session/stop').length, 0);
  const jobs = await createStateStore({ dataRoot: context.dataRoot }).listJobs(context.workspace);
  assert.equal(jobs.length, 1); assert.equal(jobs[0].ownerSessionId, parentSessionId); assert.equal(jobs[0].ownerTurnId, originalTurnId); assert.equal(jobs[0].status, 'succeeded');
});

test('prepared Rescue canonicalizes a resolvable cwd alias before exact binding reservation', async () => {
  const context = await fixture(); const childId = 'aliased-rescue-child';
  await mkdir(join(context.workspace, 'nested'));
  await prepareDirectRescueChild(context, {
    parentSessionId: 'aliased-parent', parentTurnId: 'aliased-origin', childId, childTurnId: 'aliased-child-turn',
    prompt: '$zcode:rescue --fresh --wait preserve canonical workspace identity',
  });
  const aliasedWorkspace = `${context.workspace}${sep}nested${sep}..`;
  const canonicalWorkspace = (await resolveWorkspaceStorage(context)).workspacePath;
  assert.notEqual(aliasedWorkspace, canonicalWorkspace);
  const output = await runDirectInvocation(['invoke-prepared', 'rescue'], {
    cwd: aliasedWorkspace, env: { ...context.env, CODEX_THREAD_ID: childId },
  });
  assert.equal(output.job.status, 'succeeded');
  assert.equal(output.job.workspace, canonicalWorkspace);
});

test('bound Rescue choice canonicalizes the persisted caller workspace before reservation', async () => {
  const context = await fixture(); const parentSessionId = 'aliased-choice-parent'; const childId = 'aliased-choice-child'; const childTurnId = 'aliased-choice-turn';
  await mkdir(join(context.workspace, 'nested'));
  await prepareDirectRescueChild(context, {
    parentSessionId, parentTurnId: 'aliased-choice-origin', childId, childTurnId,
    prompt: '$zcode:rescue --fresh --wait establish exact session',
  });
  const initial = await runDirectInvocation(['invoke-prepared', 'rescue'], { cwd: context.workspace, env: { ...context.env, CODEX_THREAD_ID: childId } });
  assert.equal(initial.job.status, 'succeeded');
  await markForwarding(context.dataRoot, {
    session_id: parentSessionId, turn_id: childTurnId, cwd: context.workspace, hook_event_name: 'SubagentStop',
    agent_id: childId, agent_type: 'zcode-rescue',
  });
  const identity = createIdentityStore({ dataRoot: context.dataRoot });
  await identity.beginCallerTurn({ sessionId: parentSessionId, turnId: 'aliased-choice-next', workspace: context.workspace, permissionMode: 'workspace-write', prompt: '$zcode:rescue continue exact session' });
  const preparation = new PassThrough(); preparation.end(`${JSON.stringify({ version: 1, source: 'explicit', task: 'continue exact session', options: { execution: 'foreground' } })}\n`);
  await runDirectInvocation(['prepare', 'rescue'], { cwd: context.workspace, env: { ...context.env, CODEX_THREAD_ID: parentSessionId }, input: preparation, dependencies: reactivationDependencies(childId) });
  // Launcher-allowed entries are direct commands: run() still supplies fd3 and captures fd4, proving this route does not use the protected public-command transport.
  const undecided = await run(process.execPath, [rescueLauncher, 'invoke-prepared', 'rescue'], { cwd: context.workspace, env: { ...context.env, CODEX_THREAD_ID: childId } });
  assert.equal(undecided.code, 3); assert.equal(JSON.parse(undecided.stdout).type, 'needs-choice'); assert.equal(undecided.internal, '');
  const aliasedWorkspace = `${context.workspace}${sep}nested${sep}..`;
  const resumed = await runDirectInvocation(['invoke-choice', 'rescue', 'resume'], { cwd: aliasedWorkspace, env: { ...context.env, CODEX_THREAD_ID: childId } });
  assert.equal(resumed.job.status, 'succeeded');
  assert.equal(resumed.job.zcodeSessionId, initial.job.zcodeSessionId);
});

test('isolated child loss recovers the accepted parent-owned turn without another session send', { skip: windowsRealSignalSkip }, async (t) => {
  const context = await fixture(); const record = join(context.directory, 'child-loss-recovery.jsonl'); const recovery = join(context.directory, 'child-loss-recovery.json'); const workerProcess = join(context.directory, 'child-loss-worker.json');
  await Promise.all([writeFile(record, ''), writeFile(recovery, JSON.stringify({ mode: 'active' }))]);
  const parentSessionId = 'recovery-parent'; const childId = 'recovery-rescue-child';
  const prepared = await prepareDirectRescueChild(context, {
    parentSessionId, parentTurnId: 'recovery-parent-turn', childId, childTurnId: 'recovery-child-turn',
    prompt: '$zcode:rescue --fresh --wait recover this accepted child turn',
  });
  const env = { ...context.env, CODEX_THREAD_ID: childId, FAKE_ZCODE_PROCESS_FILE: workerProcess, FAKE_ZCODE_RECORD: record, FAKE_ZCODE_RECOVERY_CONTROL: recovery, FAKE_ZCODE_SUPPRESS_FIRST_COMPLETION: '1' };
  const storage = await resolveWorkspaceStorage(context); const identityPath = join(storage.directory, 'broker', 'identity.json');
  /** @type {string|undefined} */ let ownedSessionId;
  const child = spawn(process.execPath, [cli, 'invoke-prepared', 'rescue'], { cwd: context.workspace, env, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
  let exited = false; child.stdout?.resume(); child.stderr?.resume();
  const childExit = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', () => { exited = true; resolve(undefined); }); });
  t.after(() => cleanupChildLossProcesses({ child, childExit, childExited: () => exited, context, identityPath, ownerId: ownerIdForSession(parentSessionId), sessionId: () => ownedSessionId, workerProcess }));
  const recorded = async () => (await readFile(record, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const store = createStateStore({ dataRoot: context.dataRoot });
  await waitForAcceptedBoundary(context, recorded, 'recoverable child send boundary was not durably accepted');
  [ownedSessionId] = (await store.listJobs(context.workspace)).map((job) => job.zcodeSessionId);
  child.kill('SIGKILL');
  await childExit;
  await writeFile(recovery, JSON.stringify({ mode: 'completed' }));

  const status = await companion(context, ['status'], { FAKE_ZCODE_RECORD: record, FAKE_ZCODE_RECOVERY_CONTROL: recovery }, { callerContext: prepared.callerContext });
  assert.equal(status.code, 0, status.stderr || status.stdout); assert.equal(status.json.job.status, 'succeeded', JSON.stringify(status.json.job));
  const result = await companion(context, ['result', status.json.job.id], { FAKE_ZCODE_RECORD: record, FAKE_ZCODE_RECOVERY_CONTROL: recovery }, { callerContext: prepared.callerContext });
  assert.equal(result.code, 0, result.stderr || result.stdout); assert.equal(result.json.result, 'done');
  const calls = await recorded(); assert.equal(calls.filter((frame) => frame.method === 'session/send').length, 1); assert.equal(calls.filter((frame) => frame.method === 'session/stop').length, 0);
  const jobs = await store.listJobs(context.workspace);
  assert.equal(jobs.length, 1); assert.equal(jobs[0].ownerSessionId, parentSessionId); assert.equal(jobs[0].status, 'succeeded');
});

test('sibling child rejection happens before reservation, session send, or stop', async () => {
  const context = await fixture(); const record = join(context.directory, 'sibling-rejection.jsonl'); await writeFile(record, '');
  await prepareDirectRescueChild(context, {
    parentSessionId: 'sibling-parent', parentTurnId: 'sibling-parent-turn', childId: 'approved-rescue-child', childTurnId: 'approved-child-turn',
    prompt: '$zcode:rescue --fresh --wait reject every sibling',
  });
  const sibling = await run(process.execPath, [cli, 'invoke-prepared', 'rescue'], {
    cwd: context.workspace,
    env: { ...context.env, CODEX_THREAD_ID: 'ordinary-sibling-child', FAKE_ZCODE_RECORD: record },
  });
  assert.notEqual(sibling.code, 0); assert.match(sibling.stdout, /(?:EXECUTOR_IDENTITY_NOT_FOUND|CODEX_CHILD_METADATA_INVALID)/);
  assert.equal(await readFile(record, 'utf8'), '');
  assert.deepEqual(await createStateStore({ dataRoot: context.dataRoot }).listJobs(context.workspace), []);
});

test('same-parent-turn stopped Rescue child resumes its exact session in the next preparation generation', async () => {
  const context = await fixture(); const record = join(context.directory, 'same-parent-turn.jsonl'); await writeFile(record, '');
  const parentSessionId = 'same-turn-parent'; const parentTurnId = 'same-turn-parent-turn'; const childId = 'same-turn-rescue-child'; const childTurnId = 'same-turn-child-turn';
  await prepareDirectRescueChild(context, {
    parentSessionId, parentTurnId, childId, childTurnId,
    prompt: '$zcode:rescue --fresh --wait establish same-turn session',
  });
  const env = { ...context.env, CODEX_THREAD_ID: childId, FAKE_ZCODE_RECORD: record };
  const first = await runDirectInvocation(['invoke-prepared', 'rescue'], { cwd: context.workspace, env });
  assert.equal(first.job.status, 'succeeded');
  await markForwarding(context.dataRoot, {
    session_id: parentSessionId, turn_id: childTurnId, cwd: context.workspace, hook_event_name: 'SubagentStop',
    agent_id: childId, agent_type: 'zcode-rescue',
  });

  const prepared = await prepareRescueInCurrentTurn(context, {
    parentSessionId, source: 'proactive', task: 'continue in the same parent turn',
    options: { execution: 'foreground', resume: 'resume' },
  });
  assert.deepEqual(prepared, legacyPreparedRoute);
  const second = await runDirectInvocation(['invoke-prepared', 'rescue'], { cwd: context.workspace, env });
  assert.equal(second.job.status, 'succeeded');
  assert.equal(second.job.zcodeSessionId, first.job.zcodeSessionId);

  const calls = (await readFile(record, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(calls.filter((frame) => frame.method === 'session/create').length, 1);
  assert.equal(calls.filter((frame) => frame.method === 'session/send').length, 2);
  const jobs = await createStateStore({ dataRoot: context.dataRoot }).listJobs(context.workspace);
  assert.equal(jobs.length, 2);
  const binding = await createStateStore({ dataRoot: context.dataRoot }).resolveRescueBinding({
    workspace: context.workspace, parentSessionId, executorAgentId: childId, executorAgentType: 'zcode-rescue',
    executorParentTurnId: parentTurnId, executorParentPermissionMode: 'workspace-write', permissionMode: 'workspace-write',
  });
  assert.equal(binding.kind, 'bound');
  assert.equal(binding.binding.anchorJobId, first.job.id);
  assert.equal(binding.binding.currentJobId, second.job.id);
  assert.equal(jobs.every((job) => job.operationId === jobs[0].operationId), true);
  const storage = await resolveWorkspaceStorage(context);
  const preparedNames = (await readdir(join(storage.directory, 'invocations', 'prepared'))).filter((name) => name.endsWith('.json'));
  assert.equal(preparedNames.length, 1);
  const consumed = JSON.parse(await readFile(join(storage.directory, 'invocations', 'prepared', preparedNames[0]), 'utf8'));
  assert.equal(consumed.generation, 2);
  assert.equal(consumed.requiredExecutorAgentId, childId);
  assert.equal(consumed.executorAgentId, childId);
  assert.ok(consumed.consumedAt);
  const callsBeforeDuplicate = await readFile(record, 'utf8'); const jobsBeforeDuplicate = await createStateStore({ dataRoot: context.dataRoot }).listJobs(context.workspace);
  await assert.rejects(runDirectInvocation(['invoke-prepared', 'rescue'], { cwd: context.workspace, env }), { code: 'RESCUE_PREPARATION_CONSUMED' });
  assert.equal(await readFile(record, 'utf8'), callsBeforeDuplicate);
  assert.deepEqual(await createStateStore({ dataRoot: context.dataRoot }).listJobs(context.workspace), jobsBeforeDuplicate);
});

test('same-parent-turn continuation follows up its resident exact Rescue child', async () => {
  const context = await fixture(); const record = join(context.directory, 'same-parent-turn-active.jsonl'); await writeFile(record, '');
  const parentSessionId = 'same-turn-active-parent'; const childId = 'same-turn-active-child';
  await prepareDirectRescueChild(context, {
    parentSessionId, parentTurnId: 'same-turn-active-parent-turn', childId, childTurnId: 'same-turn-active-child-turn',
    prompt: '$zcode:rescue --fresh --wait establish active-child session',
  });
  const env = { ...context.env, CODEX_THREAD_ID: childId, FAKE_ZCODE_RECORD: record };
  const first = await runDirectInvocation(['invoke-prepared', 'rescue'], { cwd: context.workspace, env });
  assert.equal(first.job.status, 'succeeded');
  const preparation = PassThrough.from([`${JSON.stringify({ version: 1, source: 'proactive', task: 'continue through the resident exact child',
    options: { execution: 'foreground', resume: 'resume' } })}\n`]);
  assert.deepEqual(await runDirectInvocation(['prepare', 'rescue'], {
    cwd: context.workspace, env: { ...context.env, CODEX_THREAD_ID: parentSessionId }, input: preparation,
    dependencies: reactivationDependencies(childId),
  }), { type: 'prepared', command: 'rescue',
    route: { version: 2, action: 'followup', target: '/root/zcode_rescue_task', assignment: 'zcode-rescue' } });
  const residentHost = { id: childId, parentThreadId: parentSessionId, agentPath: '/root/zcode_rescue_task', agentRole: 'zcode-rescue',
    cwd: await realpath(context.workspace), status: { type: 'active', activeFlags: [] }, createdAt: 1, updatedAt: 2 };
  const followedUp = await runDirectInvocation(['invoke-prepared', 'rescue'], { cwd: context.workspace, env,
    dependencies: { readCodexThreadSpawnChild: async () => residentHost } });
  assert.equal(followedUp.job.status, 'succeeded'); assert.equal(followedUp.job.zcodeSessionId, first.job.zcodeSessionId);
  const jobs = await createStateStore({ dataRoot: context.dataRoot }).listJobs(context.workspace);
  assert.equal(jobs.length, 2); assert.equal(jobs.every((job) => job.operationId === jobs[0].operationId), true);
  const calls = (await readFile(record, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(calls.filter((frame) => frame.method === 'session/create').length, 1);
  assert.equal(calls.filter((frame) => frame.method === 'session/send').length, 2);
  const storage = await resolveWorkspaceStorage(context);
  const [preparedName] = (await readdir(join(storage.directory, 'invocations', 'prepared'))).filter((name) => name.endsWith('.json'));
  const consumed = JSON.parse(await readFile(join(storage.directory, 'invocations', 'prepared', preparedName), 'utf8'));
  assert.equal(consumed.generation, 2); assert.equal(consumed.executorAgentId, childId); assert.ok(consumed.consumedAt);
});

test('same-parent-turn bound continuation rejects a stale current job at its reservation guard', async () => {
  const context = await fixture(); const prepared = await preparedSameTurnBoundContinuation(context, { name: 'same-turn-stale-current' });
  let jobsAfterMutation = 0;
  await assert.rejects(runDirectInvocation(['invoke-prepared', 'rescue'], {
    cwd: context.workspace, env: prepared.env, dependencies: {
      testOnlyAfterPreparedBindingResolution: async () => {
        const store = createStateStore({ dataRoot: context.dataRoot });
        const resolved = await store.resolveRescueBinding({
          workspace: context.workspace, parentSessionId: prepared.parentSessionId, executorAgentId: prepared.childId,
          executorAgentType: 'zcode-rescue', executorParentTurnId: prepared.parentTurnId,
          executorParentPermissionMode: 'workspace-write', permissionMode: 'workspace-write',
        });
        assert.equal(resolved.kind, 'bound');
        await store.reserveBoundRescueContinuation({
          workspace: context.workspace,
          reservation: { workspace: context.workspace, ownerSessionId: prepared.parentSessionId, ownerTurnId: prepared.parentTurnId, command: 'rescue', readOnly: false, permissionSnapshot: { permissionMode: 'workspace-write' } },
          executor: prepared.executor, operationId: resolved.binding.operationId,
        });
        jobsAfterMutation = (await store.listJobs(context.workspace)).length;
      },
    },
  }), { code: 'RESCUE_BINDING_STALE' });
  assert.equal(jobsAfterMutation, 2);
  await assertNoPreparedReservationSideEffects(context, prepared.record, jobsAfterMutation);
});

test('same-parent-turn bound continuation rejects a replaced operation and anchor at its reservation guard', async () => {
  const context = await fixture(); const prepared = await preparedSameTurnBoundContinuation(context, { name: 'same-turn-stale-operation' });
  let jobsAfterMutation = 0;
  await assert.rejects(runDirectInvocation(['invoke-prepared', 'rescue'], {
    cwd: context.workspace, env: prepared.env, dependencies: {
      testOnlyAfterPreparedBindingResolution: async () => {
        const store = createStateStore({ dataRoot: context.dataRoot });
        const replacement = await store.reserveFreshRescueJob({
          workspace: context.workspace,
          reservation: { workspace: context.workspace, ownerSessionId: prepared.parentSessionId, ownerTurnId: prepared.parentTurnId, command: 'rescue', readOnly: false, permissionSnapshot: { permissionMode: 'workspace-write' } },
          executor: prepared.executor,
        });
        await startWritableRescueForTest(store, context.workspace, replacement.job, { startedAt: new Date().toISOString(), zcodeSessionId: 'replacement-session' });
        await store.finishJob(context.workspace, replacement.job.id, ['running'], 'succeeded');
        jobsAfterMutation = (await store.listJobs(context.workspace)).length;
      },
    },
  }), { code: 'RESCUE_BINDING_STALE' });
  assert.equal(jobsAfterMutation, 2);
  await assertNoPreparedReservationSideEffects(context, prepared.record, jobsAfterMutation);
});

test('same-parent-turn bound continuation rejects an exact permission mismatch before reservation or RPC', async () => {
  const context = await fixture(); const prepared = await preparedSameTurnBoundContinuation(context, { name: 'same-turn-wrong-permission' });
  let jobsAfterMutation = 0;
  await assert.rejects(runDirectInvocation(['invoke-prepared', 'rescue'], {
    cwd: context.workspace, env: prepared.env, dependencies: {
      testOnlyAfterPreparedBindingResolution: async () => {
        const store = createStateStore({ dataRoot: context.dataRoot });
        await store.reserveFreshRescueJob({
          workspace: context.workspace,
          reservation: { workspace: context.workspace, ownerSessionId: prepared.parentSessionId, ownerTurnId: prepared.parentTurnId, command: 'rescue', readOnly: false, permissionSnapshot: { permissionMode: 'read-only' } },
          executor: prepared.executor,
        });
        jobsAfterMutation = (await store.listJobs(context.workspace)).length;
      },
    },
  }), { code: 'RESCUE_BINDING_INVALID' });
  assert.equal(jobsAfterMutation, 2);
  await assertNoPreparedReservationSideEffects(context, prepared.record, jobsAfterMutation);
});

test('same-parent-turn stopped Rescue child rejects a missing durable binding before reservation or RPC', async () => {
  const context = await fixture(); const record = join(context.directory, 'same-parent-turn-unbound.jsonl'); await writeFile(record, '');
  const parentSessionId = 'same-turn-unbound-parent'; const childId = 'same-turn-unbound-child'; const childTurnId = 'same-turn-unbound-child-turn';
  await prepareDirectRescueChild(context, {
    parentSessionId, parentTurnId: 'same-turn-unbound-parent-turn', childId, childTurnId,
    prompt: '$zcode:rescue --fresh --wait establish binding before loss',
  });
  const env = { ...context.env, CODEX_THREAD_ID: childId, FAKE_ZCODE_RECORD: record };
  assert.equal((await runDirectInvocation(['invoke-prepared', 'rescue'], { cwd: context.workspace, env })).job.status, 'succeeded');
  await markForwarding(context.dataRoot, {
    session_id: parentSessionId, turn_id: childTurnId, cwd: context.workspace, hook_event_name: 'SubagentStop',
    agent_id: childId, agent_type: 'zcode-rescue',
  });
  assert.deepEqual(await prepareRescueInCurrentTurn(context, {
    parentSessionId, source: 'proactive', task: 'reject missing durable binding',
    options: { execution: 'foreground', resume: 'resume' },
  }), legacyPreparedRoute);
  const storage = await resolveWorkspaceStorage(context);
  const bindingNames = (await readdir(storage.directory)).filter((name) => name.startsWith('rescue-binding-session-') && name.endsWith('.json'));
  assert.equal(bindingNames.length, 1);
  await unlink(join(storage.directory, bindingNames[0]));
  const callsBefore = await readFile(record, 'utf8'); const jobsBefore = await createStateStore({ dataRoot: context.dataRoot }).listJobs(context.workspace);

  await assert.rejects(runDirectInvocation(['invoke-prepared', 'rescue'], { cwd: context.workspace, env }), { code: 'RESCUE_BINDING_INVALID' });
  assert.equal(await readFile(record, 'utf8'), callsBefore);
  assert.deepEqual(await createStateStore({ dataRoot: context.dataRoot }).listJobs(context.workspace), jobsBefore);
});

test('same-parent-turn continuation rejects a sibling child before reservation or RPC', async () => {
  const context = await fixture(); const record = join(context.directory, 'same-parent-turn-sibling.jsonl'); await writeFile(record, '');
  const parentSessionId = 'same-turn-sibling-parent'; const parentTurnId = 'same-turn-sibling-parent-turn'; const childId = 'same-turn-required-child'; const childTurnId = 'same-turn-required-child-turn';
  await prepareDirectRescueChild(context, {
    parentSessionId, parentTurnId, childId, childTurnId,
    prompt: '$zcode:rescue --fresh --wait bind the required child',
  });
  const requiredEnv = { ...context.env, CODEX_THREAD_ID: childId, FAKE_ZCODE_RECORD: record };
  assert.equal((await runDirectInvocation(['invoke-prepared', 'rescue'], { cwd: context.workspace, env: requiredEnv })).job.status, 'succeeded');
  await markForwarding(context.dataRoot, {
    session_id: parentSessionId, turn_id: childTurnId, cwd: context.workspace, hook_event_name: 'SubagentStop',
    agent_id: childId, agent_type: 'zcode-rescue',
  });
  assert.deepEqual(await prepareRescueInCurrentTurn(context, {
    parentSessionId, source: 'proactive', task: 'reject the sibling continuation',
    options: { execution: 'foreground', resume: 'resume' },
  }), legacyPreparedRoute);
  const active = await createIdentityStore({ dataRoot: context.dataRoot }).resolveActiveTurn({ sessionId: parentSessionId, workspace: context.workspace });
  await markForwarding(context.dataRoot, {
    session_id: parentSessionId, turn_id: 'same-turn-sibling-child-turn', cwd: context.workspace, hook_event_name: 'SubagentStart',
    agent_id: 'same-turn-sibling-child', agent_type: 'zcode-rescue',
  }, active);
  const callsBefore = await readFile(record, 'utf8'); const jobsBefore = await createStateStore({ dataRoot: context.dataRoot }).listJobs(context.workspace);

  await assert.rejects(runDirectInvocation(['invoke-prepared', 'rescue'], {
    cwd: context.workspace,
    env: { ...context.env, CODEX_THREAD_ID: 'same-turn-sibling-child', FAKE_ZCODE_RECORD: record },
    dependencies: { readCodexThreadSpawnChild: async () => ({
      id: 'same-turn-sibling-child', parentThreadId: parentSessionId, agentPath: '/root/zcode_rescue_task_2', agentRole: 'zcode-rescue',
      cwd: await realpath(context.workspace), status: { type: 'active', activeFlags: [] }, createdAt: 1, updatedAt: 2,
    }) },
  }), { code: 'RESCUE_PREPARATION_MISMATCH' });
  assert.equal(await readFile(record, 'utf8'), callsBefore);
  assert.deepEqual(await createStateStore({ dataRoot: context.dataRoot }).listJobs(context.workspace), jobsBefore);
});

test('real CLI completion that wins before SIGINT remains succeeded with exit zero', async () => {
  const context = await fixture();
  const result = await run(process.execPath, ['--require', completionSignalProbe, cli, 'rescue', '--fresh', 'completion wins'], {
    cwd: context.workspace,
    env: { ...context.env, ZCODE_COMPLETION_SIGNAL_PROBE: '1' },
    input: { callerContext: context.caller },
  });
  assert.equal(result.code, 0, `${result.stderr}${result.stdout}`);
  assert.equal(result.stdout, 'done\n'); assert.doesNotMatch(result.stderr, /Interrupted by SIGINT|JOB_INTERRUPTED/);
  assert.equal(JSON.parse(result.internal).job.status, 'succeeded');
  const jobs = await createStateStore({ dataRoot: context.dataRoot }).listJobs(context.workspace);
  assert.equal(jobs.length, 1); assert.equal(jobs[0].status, 'succeeded'); assert.equal(jobs[0].exitCode, 0);
});

test('real CLI successful status is not flipped by SIGINT during output', async () => {
  const context = await fixture(); const completed = await companion(context, ['review']);
  assert.equal(completed.code, 0, `${completed.stderr}${completed.stdout}`);
  const result = await run(process.execPath, ['--require', completionSignalProbe, cli, 'status', completed.json.job.id], {
    cwd: context.workspace,
    env: { ...context.env, ZCODE_COMPLETION_SIGNAL_PROBE: '1' },
    input: { callerContext: context.caller },
  });
  assert.equal(result.code, 0, `${result.stderr}${result.stdout}`);
  assert.match(result.stdout, /^Job: /); assert.doesNotMatch(result.stderr, /Interrupted by SIGINT|JOB_INTERRUPTED/);
  assert.equal(JSON.parse(result.internal).job.status, 'succeeded');
});

test('signal probe marks handled only after the wrapped handler returns', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-signal-probe-')); const marker = join(directory, 'marker.txt');
  const script = `
    const { readFileSync } = require('node:fs');
    const keepAlive = setInterval(() => {}, 1000);
    process.on('SIGINT', () => {
      process.stdout.write(readFileSync(process.env.ZCODE_SIGNAL_HANDLER_PROBE, 'utf8'));
      clearInterval(keepAlive);
      setImmediate(() => process.exit(0));
    });
    setImmediate(() => process.emit('SIGINT'));
  `;
  const child = spawn(process.execPath, ['--require', signalHandlerProbe, '--eval', script], {
    env: { ...process.env, ZCODE_SIGNAL_HANDLER_PROBE: marker }, stdio: ['ignore', 'pipe', 'pipe'], shell: false,
  });
  let stdout = ''; let exited = false; child.stdout?.on('data', (chunk) => { stdout += chunk; });
  t.after(() => { if (!exited) child.kill('SIGKILL'); });
  const exitPromise = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => { exited = true; resolve({ code, signal }); }); });
  assert.deepEqual(await exitPromise, { code: 0, signal: null });
  assert.equal(stdout, 'ready');
  assert.equal(await readFile(marker, 'utf8'), 'handled');
});

test('foreground SIGINT wins while the protected authorization envelope is incomplete', { skip: windowsRealSignalSkip }, async (t) => {
  const context = await fixture(); const marker = join(context.directory, 'signal-handler.txt');
  const child = spawn(process.execPath, ['--require', signalHandlerProbe, cli, 'rescue', '--fresh', 'interrupt authorization'], {
    cwd: context.workspace,
    env: { ...context.env, ZCODE_SIGNAL_HANDLER_PROBE: marker },
    stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'],
    shell: false,
  });
  let stdout = ''; let stderr = ''; let internal = ''; let exited = false;
  child.stdout?.on('data', (chunk) => { stdout += chunk; }); child.stderr?.on('data', (chunk) => { stderr += chunk; }); child.stdio[4]?.on('data', (chunk) => { internal += chunk; });
  child.stdio[3]?.on('error', consumePipeError); child.stdio[4]?.on('error', consumePipeError);
  t.after(() => { if (!exited) child.kill('SIGKILL'); });
  const exitPromise = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => { exited = true; resolve({ code, signal }); }); });

  await waitFor(async () => await readFile(marker, 'utf8').catch(() => '') === 'ready', 'foreground signal handler was not installed');
  /** @type {import('node:stream').Writable} */ (child.stdio[3]).write('{');
  child.kill('SIGINT');
  await waitFor(async () => await readFile(marker, 'utf8').catch(() => '') === 'handled', 'SIGINT did not enter the installed handler');
  /** @type {NodeJS.Timeout|undefined} */
  let exitTimer;
  const exit = await Promise.race([exitPromise, new Promise((resolve, reject) => { void resolve; exitTimer = setTimeout(() => reject(new Error('foreground process retained incomplete fd3 after SIGINT')), 5_000); })]).finally(() => clearTimeout(exitTimer));

  assert.deepEqual(exit, { code: 130, signal: null });
  assert.equal(stdout, ''); assert.equal(internal, '');
  assert.match(stderr, /Interrupted by SIGINT\./); assert.doesNotMatch(stderr, /INTERNAL_AUTHORIZATION_INVALID|"error"/);
});

test('background reservation exposes one private invocation, which is single-use', async () => {
  const context = await fixture();
  const reserved = await companion(context, ['review', '--background']);
  assert.equal(reserved.code, 0, reserved.stderr); assert.equal(reserved.json.type, 'background');
  assert.deepEqual(reserved.json.privateInvocation.slice(0, 2), ['run-reserved-job', reserved.json.job.id]);
  const capability = reserved.json.executionCapability; assert.ok(capability); assert.deepEqual(reserved.json.privateInvocation, ['run-reserved-job', reserved.json.job.id]); assert.doesNotMatch(JSON.stringify(reserved.json.job), new RegExp(capability));
  assert.doesNotMatch(renderOutput(reserved.json, { json: true }), new RegExp(capability));
  assert.doesNotMatch(`${reserved.stdout}${reserved.stderr}`, new RegExp(capability));
  const privateAuth = { executionCapability: capability, jobId: reserved.json.job.id };
  const first = await companion(context, reserved.json.privateInvocation, {}, privateAuth);
  assert.equal(first.code, 0, first.stderr); assert.equal(first.json.job.status, 'succeeded');
  const terminalResult = first.json.result;
  assert.deepEqual(JSON.parse(terminalResult), { findings: [] });
  const storage = await resolveWorkspaceStorage(context);
  assert.equal(await readFile(join(storage.directory, first.json.job.resultArtifact), 'utf8'), terminalResult);
  const backgroundLog = await readFile(first.json.job.logFile, 'utf8');
  const assistantBlock = `Assistant message\n${terminalResult}\n`;
  const finalBlock = `Final output\n${terminalResult}\n`;
  assert.equal(backgroundLog.split(assistantBlock).length - 1, 1);
  assert.equal((backgroundLog.match(/Assistant message/g) ?? []).length, 1);
  // The final block is an observational mirror written after durable success;
  // its bounded append may time out under filesystem load (notably on Windows).
  const finalMirrorCount = backgroundLog.split(finalBlock).length - 1;
  assert.ok([0, 1].includes(finalMirrorCount));
  assert.equal((backgroundLog.match(/Final output/g) ?? []).length, finalMirrorCount);
  assert.doesNotMatch(backgroundLog, /PRIVATE_REASONING|RAW_TOOL_OUTPUT|CAPABILITY_TOKEN/);
  const replay = await companion(context, reserved.json.privateInvocation, {}, privateAuth);
  assert.notEqual(replay.code, 0); assert.equal(replay.json.error.code, 'EXECUTION_CAPABILITY_CONSUMED');
});

test('one production background admission mints and transports its exact capability only through fd3', async (t) => {
  const context = await fixture(); t.after(() => rm(context.directory, { force: true, recursive: true }));
  const authorization = new PassThrough(); const acknowledgements = new PassThrough(); const child = /** @type {any} */ (new EventEmitter());
  let envelope = ''; const captures = /** @type {{invocation?:any,workerInput?:any}} */ ({}); let unrefCount = 0;
  authorization.setEncoding('utf8'); authorization.on('data', (chunk) => { envelope += chunk; });
  child.pid = 42_424; child.stdio = [null, null, null, authorization, acknowledgements]; child.unref = () => { unrefCount += 1; };
  const progressLines = /** @type {string[]} */ ([]);
  const output = await runCompanion(['rescue', '--background', '--fresh', 'production chain'], {
    cwd: context.workspace, env: { ...context.env, CHAIN_PUBLIC_SETTING: 'visible' }, caller: caller('production-chain'), autoLaunchBackground: true,
    progressWriter: (line) => { progressLines.push(line); },
    dependencies: {
      startBackgroundWorker: async (/** @type {any} */ input) => {
        captures.workerInput = input;
        return startBackgroundWorker({ ...input, dependencies: { spawn: (command, args, options) => { captures.invocation = { command, args, options }; queueMicrotask(() => acknowledgements.end('ready\n')); return child; } } });
      },
    },
  });
  assert.ok(captures.workerInput); assert.ok(captures.invocation);
  const capturedWorkerInput = captures.workerInput; const capturedInvocation = captures.invocation;
  const protectedEnvelope = JSON.parse(envelope);
  const capability = protectedEnvelope.executionCapability;
  assert.ok(typeof capability === 'string' && capability.length >= 32); assert.equal(protectedEnvelope.jobId, output.job.id); assert.equal(capturedWorkerInput.executionCapability, capability);
  assert.equal(envelope, `${JSON.stringify({ executionCapability: capability, jobId: output.job.id })}\n`); assert.deepEqual(Object.keys(protectedEnvelope).sort(), ['executionCapability', 'jobId']);
  assert.deepEqual(capturedInvocation.args, [cli, 'run-reserved-job', output.job.id]); assert.deepEqual(capturedInvocation.options.stdio, ['ignore', 'ignore', 'ignore', 'pipe', 'pipe']);
  assert.equal(capturedInvocation.options.env.ZCODE_BACKGROUND_WORKER, '1'); assert.equal(capturedInvocation.options.env.CHAIN_PUBLIC_SETTING, 'visible'); assert.equal(unrefCount, 1);
  assert.doesNotMatch(JSON.stringify(capturedInvocation), new RegExp(capability)); assert.doesNotMatch(JSON.stringify(capturedWorkerInput.env), new RegExp(capability));
  const role = await readFile(join(root, 'agents', 'zcode-rescue.toml.template'), 'utf8'); const rescueSkill = await readFile(join(root, 'skills', 'rescue', 'SKILL.md'), 'utf8');
  const publicOutput = renderOutput(output); const modelVisibleEvidence = JSON.stringify({ output, publicOutput, stderr: '', progressLines, role, rescueSkill });
  assert.equal(publicOutput, `Reserved background job ${output.job.id}.\n`); assert.doesNotMatch(modelVisibleEvidence, new RegExp(capability));
});

test('a non-worker reserved-job invocation receives the foreground abort signal', async () => {
  const context = await fixture(); const reserved = await companion(context, ['review', '--background']);
  const controller = new AbortController(); const interruption = new PluginError('JOB_INTERRUPTED', 'reserved foreground'); controller.abort(interruption); let discoveries = 0;
  await assert.rejects(runCompanion(reserved.json.privateInvocation, {
    cwd: context.workspace,
    env: context.env,
    authorization: { executionCapability: reserved.json.executionCapability, jobId: reserved.json.job.id },
    signal: controller.signal,
    dependencies: { discoverLaunch: async () => { discoveries += 1; throw new Error('must not discover'); } },
  }), (error) => error === interruption);
  assert.equal(discoveries, 0);
  assert.equal((await createStateStore({ dataRoot: context.dataRoot }).readJob(context.workspace, reserved.json.job.id)).status, 'cancelled');
});

test('production background launch failure revokes its capability and fails the queued job', async () => {
  const context = await fixture(); const failure = new Error('simulated descriptor launch failure');
  await assert.rejects(runCompanion(['rescue', '--background', '--fresh', 'repair'], {
    cwd: context.workspace, env: context.env, caller: caller('background-owner'), autoLaunchBackground: true,
    dependencies: { startBackgroundWorker: async () => { throw failure; } },
  }), (error) => error === failure);

  const store = createStateStore({ dataRoot: context.dataRoot }); const [job] = await store.listJobs(context.workspace);
  assert.equal(job.status, 'failed'); assert.equal(job.error.message, failure.message);
  const storage = await resolveWorkspaceStorage({ dataRoot: context.dataRoot, workspace: context.workspace });
  const capabilityFiles = await readdir(join(storage.directory, 'identity', 'capabilities'));
  assert.equal(capabilityFiles.length, 1);
  const record = JSON.parse(await readFile(join(storage.directory, 'identity', 'capabilities', capabilityFiles[0]), 'utf8'));
  assert.equal(record.operation, 'run-reserved-job'); assert.equal(record.jobId, job.id); assert.equal(record.consumedAt, null); assert.ok(Date.parse(record.revokedAt));
});

test('status/list/result and queued cancellation enforce owned job semantics', async () => {
  const context = await fixture();
  const reserved = await companion(context, ['rescue', '--background', '--fresh', 'task']);
  assert.equal(reserved.code, 0, `${reserved.stderr}${reserved.stdout}`);
  const id = reserved.json.job.id;
  const listed = await companion(context, ['status', '--all']);
  assert.equal(listed.code, 0); assert.equal(listed.json.jobs.length, 1); assert.equal(listed.json.jobs[0].id, id);
  const unfinished = await companion(context, ['result', id]);
  assert.notEqual(unfinished.code, 0); assert.match(unfinished.json.error.remedy, new RegExp(`\\$zcode:status ${id} --wait`));
  const cancelled = await companion(context, ['cancel', id], { FAKE_ZCODE_VERSION: '0.1.0' });
  assert.equal(cancelled.code, 0, `${cancelled.stderr}${cancelled.stdout}`); assert.equal(cancelled.json.job.status, 'cancelled');
  const status = await companion(context, ['status', id, '--wait', '--timeout-ms', '10']);
  assert.equal(status.code, 0); assert.equal(status.json.job.status, 'cancelled');
});

test('result exposes owned terminal outcomes, skips active jobs, and preserves successful artifacts', async () => {
  const context = await fixture(); const store = createStateStore({ dataRoot: context.dataRoot });
  /** @param {string} ownerTurnId */
  const reserve = (ownerTurnId) => store.reserveJob({
    workspace: context.workspace, ownerSessionId: 'codex-session', ownerTurnId,
    command: 'review', readOnly: true, permissionSnapshot: { permissionMode: 'read-only' },
  });
  const failed = await reserve('failed-result');
  const startedAt = new Date(Math.max(Date.now(), Date.parse(failed.createdAt))).toISOString();
  await store.transitionJob(context.workspace, failed.id, ['queued'], 'running', {
    childPid: 424242, workerLeaseId: 'a'.repeat(64), zcodeSessionId: 'private-zcode-session', startedAt,
    model: { providerId: 'private-provider', modelId: 'private-model' }, effort: 'xhigh', promptArtifact: 'artifacts/private-prompt.md',
  });
  await store.transitionJob(context.workspace, failed.id, ['running'], 'running', {
    inputId: 'private-input', startRevision: 77, beforeMessageIds: ['private-before-message'],
  });
  await store.transitionJob(context.workspace, failed.id, ['running'], 'running', { lastCancelError: {
    message: `Retry\u061c **stop**\u200e\u202e\nwith\u200f\tcontrols\u0000 ${'界'.repeat(800)}`,
    code: 'PRIVATE_CANCEL_CODE', secretMarker: 'PRIVATE_CANCEL_SECRET', details: { token: 'PRIVATE_CANCEL_TOKEN' },
  } });
  await store.updateJobProgress(context.workspace, failed.id, { phase: 'running', message: 'PRIVATE_PROGRESS_PREVIEW', observedAt: startedAt });
  await store.updateJobProgressProbe(context.workspace, failed.id, {
    state: 'online', subscriptionAcknowledged: true, framesReceived: 99,
    acceptedInitial: 1, acceptedOnline: 2, acceptedRecovery: 3,
    rejected: { 'wire-version': 4, 'envelope-shape': 5, sequence: 6, topic: 7, 'row-kind': 8, 'row-shape': 9 },
    snapshotFallbackActive: false, snapshotFallbackUnavailable: false,
  });
  const storedError = {
    message: `Public\u061c **failure**\u200e\u202e\nwith\u200f\tcontrols\u0000 ${'界'.repeat(800)}`,
    code: 'PRIVATE_ERROR_CODE', secretMarker: 'PRIVATE_ERROR_SECRET', details: { token: 'PRIVATE_ERROR_TOKEN' },
  };
  await store.finishJob(context.workspace, failed.id, ['running'], 'failed', { error: storedError, exitCode: 7 });
  const failedResult = await companion(context, ['result', failed.id]);
  assert.equal(failedResult.code, 0, `${failedResult.stderr}${failedResult.stdout}`);
  assert.deepEqual(Object.keys(failedResult.json.job).sort(), [
    'command', 'createdAt', 'error', 'finishedAt', 'id', 'lastActivityAt', 'owner', 'owned', 'phase', 'startedAt', 'status',
  ].sort());
  assert.deepEqual(Object.keys(failedResult.json.job.error), ['message']);
  assert.match(failedResult.json.job.error.message, /^Public \*\*failure\*\* with controls /u);
  assert.match(failedResult.json.job.error.message, /\.\.\.$/u);
  assert.ok(Buffer.byteLength(failedResult.json.job.error.message) <= 2_048);
  assert.equal([...failedResult.json.job.error.message].some((character) => {
    const code = character.codePointAt(0);
    return code <= 0x1f || code >= 0x7f && code <= 0x9f || code === 0x061c || code === 0x200e || code === 0x200f
      || code >= 0x202a && code <= 0x202e || code >= 0x2066 && code <= 0x2069;
  }), false);
  assert.doesNotMatch(JSON.stringify(failedResult.json), /PRIVATE_|private-|ownerSessionId|ownerTurnId|permissionSnapshot|promptArtifact|resultArtifact|workerLeaseId|childPid|zcodeSessionId|inputId|startRevision|beforeMessageIds|model|effort|progressProbe|progressPreview|lastCancelError|exitCode|secretMarker|details/u);
  const failedStatus = await companion(context, ['status', failed.id]);
  assert.equal(failedStatus.code, 0, `${failedStatus.stderr}${failedStatus.stdout}`);
  assert.deepEqual(failedStatus.json.job.error, failedResult.json.job.error);
  assert.deepEqual(Object.keys(failedStatus.json.job.lastCancelError), ['message']);
  assert.match(failedStatus.json.job.lastCancelError.message, /^Retry \*\*stop\*\* with controls /u);
  assert.match(failedStatus.json.job.lastCancelError.message, /\.\.\.$/u);
  assert.ok(Buffer.byteLength(failedStatus.json.job.lastCancelError.message) <= 2_048);
  assert.equal([...failedStatus.json.job.lastCancelError.message].some((character) => {
    const code = character.codePointAt(0);
    return code <= 0x1f || code >= 0x7f && code <= 0x9f || code === 0x061c || code === 0x200e || code === 0x200f
      || code >= 0x202a && code <= 0x202e || code >= 0x2066 && code <= 0x2069;
  }), false);
  assert.doesNotMatch(JSON.stringify({ error: failedStatus.json.job.error, lastCancelError: failedStatus.json.job.lastCancelError }), /PRIVATE_|secretMarker|details|PRIVATE_CANCEL_CODE|PRIVATE_ERROR_CODE/u);
  const failedResultError = failedResult.stdout.split('\n').find((/** @type {string} */ line) => line.startsWith('Error: '));
  const failedStatusError = failedStatus.stdout.split('\n').find((/** @type {string} */ line) => line.startsWith('Error: '));
  assert.ok(failedResultError); assert.equal(failedStatusError, failedResultError);
  assert.match(failedStatusError, /^Error: Public \\\*\\\*failure\\\*\\\* with controls /u);
  const lastCancelLine = failedStatus.stdout.split('\n').find((/** @type {string} */ line) => line.startsWith('Last cancellation error: '));
  assert.ok(lastCancelLine); assert.ok(Buffer.byteLength(lastCancelLine.slice('Last cancellation error: '.length)) <= 2_048);
  assert.match(lastCancelLine, /^Last cancellation error: Retry \\\*\\\*stop\\\*\\\* with controls /u);
  assert.doesNotMatch(lastCancelLine, /PRIVATE_|[\u061C\u200E\u200F\u202E]/u);

  await new Promise((resolve) => setTimeout(resolve, 2));
  const succeeded = await reserve('succeeded-result'); const successfulContents = 'exact immutable result\n';
  const resultArtifact = await writeResultArtifact({ dataRoot: context.dataRoot, workspace: context.workspace, jobId: succeeded.id, contents: successfulContents });
  await store.transitionJob(context.workspace, succeeded.id, ['queued'], 'running');
  await store.finishJob(context.workspace, succeeded.id, ['running'], 'succeeded', { resultArtifact, exitCode: 0 });
  await new Promise((resolve) => setTimeout(resolve, 2));
  const cancelledWithReason = await reserve('cancelled-result-with-reason');
  await store.finishJob(context.workspace, cancelledWithReason.id, ['queued'], 'cancelled', {
    error: 'legacy `cancelled`\nreason \u202ewith controls', exitCode: null,
  });
  const cancelledResult = await companion(context, ['result', cancelledWithReason.id]);
  const cancelledStatus = await companion(context, ['status', cancelledWithReason.id]);
  const cancelledResultError = cancelledResult.stdout.split('\n').find((/** @type {string} */ line) => line.startsWith('Error: '));
  const cancelledStatusError = cancelledStatus.stdout.split('\n').find((/** @type {string} */ line) => line.startsWith('Error: '));
  assert.equal(cancelledResultError, 'Error: legacy \\`cancelled\\` reason with controls');
  assert.equal(cancelledStatusError, cancelledResultError);

  await new Promise((resolve) => setTimeout(resolve, 2));
  const cancelled = await reserve('cancelled-result');
  await store.finishJob(context.workspace, cancelled.id, ['queued'], 'cancelled', { exitCode: null });
  await new Promise((resolve) => setTimeout(resolve, 2));
  const active = await reserve('active-result');

  const implicit = await companion(context, ['result']);
  assert.equal(implicit.code, 0, `${implicit.stderr}${implicit.stdout}`);
  assert.equal(implicit.json.job.id, cancelled.id); assert.equal(implicit.json.job.status, 'cancelled');
  assert.equal(Object.hasOwn(implicit.json.job, 'error'), false);

  const successful = await companion(context, ['result', succeeded.id]);
  assert.equal(successful.code, 0, `${successful.stderr}${successful.stdout}`);
  assert.equal(successful.json.result, successfulContents);

  const unfinished = await companion(context, ['result', active.id]);
  assert.notEqual(unfinished.code, 0); assert.equal(unfinished.json.error.code, 'JOB_RESULT_UNFINISHED');

  const missing = await reserve('missing-result');
  await store.transitionJob(context.workspace, missing.id, ['queued'], 'running');
  await store.finishJob(context.workspace, missing.id, ['running'], 'succeeded', { exitCode: 0 });
  const missingResult = await companion(context, ['result', missing.id]);
  assert.notEqual(missingResult.code, 0); assert.equal(missingResult.json.error.code, 'ZCODE_RESULT_MISSING');
  assert.match(missingResult.json.error.remedy, new RegExp(`\\$zcode:status ${missing.id}`));

  const controlOnly = await reserve('control-only-result');
  await store.finishJob(context.workspace, controlOnly.id, ['queued'], 'failed', {
    error: { message: ' \n\u0000\u0085\u061c\u200e\u200f\u202e\u2069 ', code: 'PRIVATE_EMPTY_CODE' }, exitCode: 1,
  });
  for (const command of ['status', 'result']) {
    const output = await companion(context, [command, controlOnly.id]);
    assert.equal(output.code, 0, `${output.stderr}${output.stdout}`);
    assert.equal(Object.hasOwn(output.json.job, 'error'), false);
    assert.doesNotMatch(output.stdout, /^Error:/mu);
    assert.doesNotMatch(`${output.internal}${output.stdout}`, /PRIVATE_EMPTY_CODE/u);
  }

  const legacyCancel = await reserve('legacy-cancel-error');
  await store.transitionJob(context.workspace, legacyCancel.id, ['queued'], 'running');
  await store.transitionJob(context.workspace, legacyCancel.id, ['running'], 'running', {
    lastCancelError: ' Legacy\u061c cancel\nreason\u0085 ',
  });
  const legacyStatus = await companion(context, ['status', legacyCancel.id]);
  assert.equal(legacyStatus.json.job.lastCancelError, 'Legacy cancel reason');
  assert.match(legacyStatus.stdout, /^Last cancellation error: Legacy cancel reason$/mu);

  const emptyCancel = await reserve('empty-cancel-error');
  await store.transitionJob(context.workspace, emptyCancel.id, ['queued'], 'running');
  await store.transitionJob(context.workspace, emptyCancel.id, ['running'], 'running', {
    lastCancelError: { message: ' \n\u0000\u0085\u061c\u200e\u200f\u202e\u2069 ', code: 'PRIVATE_EMPTY_CANCEL' },
  });
  const emptyCancelStatus = await companion(context, ['status', emptyCancel.id]);
  assert.equal(Object.hasOwn(emptyCancelStatus.json.job, 'lastCancelError'), false);
  assert.doesNotMatch(emptyCancelStatus.stdout, /^Last cancellation error:/mu);
  assert.doesNotMatch(emptyCancelStatus.internal, /PRIVATE_EMPTY_CANCEL/u);
});

test('a new owner scavenges one orphan blocker and retries writable reservation exactly once', async () => {
  const context = await fixture(); const { job: orphan, store } = await reserveOrphan(context);
  /** @type {any[]} */
  const calls = [];
  const output = await runCompanion(['rescue', '--background', '--fresh', 'repair after crash'], { cwd: context.workspace, env: context.env, caller: caller('new-owner'), dependencies: missingRemoteDependencies(calls) });
  assert.equal(output.type, 'background'); assert.notEqual(output.job.id, orphan.id);
  assert.equal((await store.readJob(context.workspace, orphan.id)).status, 'failed');
  const jobs = await store.listJobs(context.workspace); assert.equal(jobs.filter((job) => ['queued', 'running', 'cancelling'].includes(job.status) && !job.readOnly).length, 1);
  assert.equal(calls.filter((entry) => entry === 'list').length, 1); assert.doesNotMatch(JSON.stringify(output), new RegExp(orphan.id));
});

test('a new owner archives a historical orphan when its managed control channel is unavailable', async () => {
  const context = await fixture(); const { job: orphan, store } = await reserveOrphan(context); let discoveries = 0; let clients = 0;
  const output = await runCompanion(['rescue', '--background', '--fresh', 'repair after lost broker'], {
    cwd: context.workspace,
    env: context.env,
    caller: caller('new-owner'),
    dependencies: {
      discoverLaunch: async () => { discoveries += 1; return { command: process.execPath, args: [fake], target: fake }; },
      createManagedZCodeClient: async () => { clients += 1; throw new PluginError('ZCODE_DISCONNECTED', 'endpoint=/secret.sock token=secret owner=secret session=secret', { category: 'runtime', remedy: 'Restart the operation.' }); },
    },
  });
  const archived = await store.readJob(context.workspace, orphan.id);
  assert.equal(archived.status, 'failed'); assert.equal(archived.error.message, 'Reservation-time recovery could not establish the managed ZCode control channel; the orphan was archived.'); assert.doesNotMatch(archived.error.message, /secret/);
  assert.equal(output.type, 'background'); assert.notEqual(output.job.id, orphan.id); assert.equal(output.job.ownerSessionId, 'new-owner');
  assert.equal(discoveries, 1); assert.equal(clients, 1);
});

test('a pre-aborted writable conflict propagates its reason before broker reconciliation', async () => {
  const context = await fixture(); const { job: orphan, store } = await reserveOrphan(context); const controller = new AbortController(); const interruption = new PluginError('JOB_INTERRUPTED', 'abort before scavenging'); controller.abort(interruption); let discoveries = 0; let clients = 0;
  await assert.rejects(
    runCompanion(['rescue', '--background', '--fresh', 'do not scavenge'], { cwd: context.workspace, env: context.env, caller: caller('new-owner'), signal: controller.signal, dependencies: { discoverLaunch: async () => { discoveries += 1; throw new Error('must not discover'); }, createManagedZCodeClient: async () => { clients += 1; throw new Error('must not create'); } } }),
    (error) => error === interruption,
  );
  const storage = await resolveWorkspaceStorage({ dataRoot: context.dataRoot, workspace: context.workspace });
  await assert.rejects(readFile(join(storage.directory, 'broker', 'session-owners.json')), { code: 'ENOENT' });
  assert.equal(discoveries, 0); assert.equal(clients, 0); assert.deepEqual(await store.readJob(context.workspace, orphan.id), orphan);
});

test('an abort during writable-conflict scavenging propagates its reason before final reserve', async () => {
  const context = await fixture(); const { job: orphan, store } = await reserveOrphan(context); const controller = new AbortController(); const interruption = new PluginError('JOB_INTERRUPTED', 'abort during scavenging'); let clients = 0;
  await assert.rejects(
    runCompanion(['rescue', '--background', '--fresh', 'stop before retry'], { cwd: context.workspace, env: context.env, caller: caller('new-owner'), signal: controller.signal, dependencies: { discoverLaunch: async () => { controller.abort(interruption); return { command: process.execPath, args: [fake], target: fake }; }, createManagedZCodeClient: async () => { clients += 1; throw new Error('must not create after abort'); } } }),
    (error) => error === interruption,
  );
  assert.equal(clients, 0); const jobs = await store.listJobs(context.workspace); assert.equal(jobs.length, 1); assert.equal(jobs[0].id, orphan.id); assert.equal(jobs[0].status, 'running');
});

test('an executor-bound background conflict aborts after discovery with zero publication side effects', async () => {
  const context = await fixture(); const { job: orphan, store } = await reserveOrphan(context); const controller = new AbortController();
  const interruption = new PluginError('JOB_INTERRUPTED', 'bound abort after discovery'); const effects = { clients: 0, specs: 0, capabilities: 0, workers: 0 };
  const boundCaller = caller('bound-new-owner', 'bound-origin');
  const executor = { agentId: 'bound-child', agentType: 'zcode-rescue', parentSessionId: boundCaller.sessionId, parentTurnId: boundCaller.turnId, parentPermissionMode: boundCaller.permissionMode, workspace: context.workspace };
  await assert.rejects(runCompanion(['rescue', '--background', '--fresh', 'stop bound retry'], {
    cwd: context.workspace, env: context.env, caller: boundCaller, executor, signal: controller.signal,
    dependencies: {
      discoverLaunch: async () => { controller.abort(interruption); return { command: process.execPath, args: [fake], target: fake }; },
      createManagedZCodeClient: async () => { effects.clients += 1; throw new Error('must not create'); },
      writeJobSpec: async () => { effects.specs += 1; }, createExecutionCapability: async () => { effects.capabilities += 1; }, startBackgroundWorker: async () => { effects.workers += 1; },
    },
  }), (error) => error === interruption);
  assert.deepEqual(effects, { clients: 0, specs: 0, capabilities: 0, workers: 0 });
  assert.deepEqual(await store.listJobs(context.workspace), [orphan]);
  const storage = await resolveWorkspaceStorage({ dataRoot: context.dataRoot, workspace: context.workspace });
  assert.equal((await readdir(storage.directory)).filter((name) => name.startsWith('rescue-binding-')).length, 0);
});

test('a live exact worker lease keeps a new owner blocked without remote inspection', async () => {
  const context = await fixture(); const { job: orphan, store, workerLeaseId } = await reserveOrphan(context); let discoveries = 0; let clients = 0;
  await withWorkerLease({ dataRoot: context.dataRoot, workspace: context.workspace, jobId: orphan.id, workerLeaseId }, async () => {
    await assert.rejects(
      runCompanion(['rescue', '--background', '--fresh', 'must wait'], { cwd: context.workspace, env: context.env, caller: caller('new-owner'), dependencies: { discoverLaunch: async () => { discoveries += 1; throw new Error('must not inspect'); }, createManagedZCodeClient: async () => { clients += 1; throw new Error('must not create'); } } }),
      (error) => error instanceof PluginError && error.code === 'WRITABLE_JOB_EXISTS',
    );
  });
  assert.equal(discoveries, 0); assert.equal(clients, 0); assert.deepEqual(await store.readJob(context.workspace, orphan.id), orphan);
});

test('an unacknowledged orphan stop preserves WRITABLE_JOB_EXISTS with an honest remedy', async () => {
  const context = await fixture(); const { job: orphan, store } = await reserveOrphan(context); let stops = 0;
  const dependencies = {
    discoverLaunch: async () => ({ command: process.execPath, args: [fake], target: fake }),
    createManagedZCodeClient: async () => ({
      listSessions: async () => ({ sessions: [{ sessionId: orphan.zcodeSessionId }] }),
      readSession: async () => ({ projection: { status: 'running' }, runtime: { stateRevision: 8 }, messages: [] }),
      stopSession: async () => { stops += 1; throw new Error('stop not acknowledged'); },
      close: async () => {},
    }),
  };
  await assert.rejects(
    runCompanion(['rescue', '--background', '--fresh', 'must remain blocked'], { cwd: context.workspace, env: context.env, caller: caller('new-owner'), dependencies }),
    (error) => error instanceof PluginError && error.code === 'WRITABLE_JOB_EXISTS' && error.remedy === 'Retry later or inspect the redacted workspace list with $zcode:status --all.',
  );
  const retained = await store.readJob(context.workspace, orphan.id); assert.equal(stops, 1); assert.equal(retained.status, 'running'); assert.match(retained.lastCancelError, /stop not acknowledged/);
});

test('two new owners racing through scavenging admit at most one writable rescue', async () => {
  const context = await fixture(); const { job: orphan, store } = await reserveOrphan(context);
  /** @type {any[]} */
  const calls = [];
  const attempts = await Promise.allSettled(['new-owner-b', 'new-owner-c'].map((sessionId) => runCompanion(['rescue', '--background', '--fresh', `repair by ${sessionId}`], { cwd: context.workspace, env: context.env, caller: caller(sessionId), dependencies: missingRemoteDependencies(calls) })));
  assert.equal(attempts.filter((attempt) => attempt.status === 'fulfilled').length, 1);
  const rejected = attempts.find((attempt) => attempt.status === 'rejected'); assert.ok(rejected && rejected.status === 'rejected'); assert.equal(rejected.reason.code, 'WRITABLE_JOB_EXISTS');
  assert.equal((await store.readJob(context.workspace, orphan.id)).status, 'failed');
  const activeWritable = (await store.listJobs(context.workspace)).filter((/** @type {any} */ job) => ['queued', 'running', 'cancelling'].includes(job.status) && !job.readOnly);
  assert.equal(activeWritable.length, 1); assert.ok(['new-owner-b', 'new-owner-c'].includes(activeWritable[0].ownerSessionId));
});

test('the owner that triggers scavenging cannot status result cancel or resume the recovered job', async () => {
  const { context, orphan, ownerB } = await recoverForeignCompletion();
  for (const argv of [['status', orphan.id], ['result', orphan.id], ['cancel', orphan.id]]) {
    await assert.rejects(runCompanion(argv, { cwd: context.workspace, env: context.env, caller: ownerB }), (error) => error instanceof PluginError && error.code === 'OWNED_JOB_NOT_FOUND');
  }
  await assert.rejects(runCompanion(['rescue', '--resume', 'adopt foreign session'], { cwd: context.workspace, env: context.env, caller: ownerB }), (error) => error instanceof PluginError && error.code === 'RESUME_CANDIDATE_NOT_FOUND');
});

test('status --all reports a scavenged foreign job only through redacted other-owner metadata', async () => {
  const { context, orphan, ownerB } = await recoverForeignCompletion();
  const listed = await runCompanion(['status', '--all'], { cwd: context.workspace, env: context.env, caller: ownerB });
  const foreign = listed.jobs.find((/** @type {any} */ job) => job.id === orphan.id); assert.ok(foreign); assert.equal(foreign.hasOwner, true);
  assert.deepEqual(Object.keys(foreign).sort(), ['createdAt', 'finishedAt', 'hasOwner', 'id', 'startedAt', 'status'].sort());
});

test('status --all preserves same-owner detail but allowlists foreign job metadata', async () => {
  const context = await fixture(); const store = createStateStore({ dataRoot: context.dataRoot });
  const mine = await store.reserveJob({ workspace: context.workspace, ownerSessionId: 'owner-a', ownerTurnId: 'owner-a-turn', command: 'review', readOnly: true, permissionSnapshot: { permissionMode: 'read-only' } });
  const startedAt = new Date().toISOString();
  await store.transitionJob(context.workspace, mine.id, ['queued'], 'running', { startedAt });
  const probe = {
    state: 'online', subscriptionAcknowledged: true, framesReceived: 1,
    acceptedInitial: 0, acceptedOnline: 1, acceptedRecovery: 0,
    rejected: { 'wire-version': 0, 'envelope-shape': 0, sequence: 0, topic: 0, 'row-kind': 0, 'row-shape': 0 },
    snapshotFallbackActive: false, snapshotFallbackUnavailable: false,
  };
  await store.updateJobProgressProbe(context.workspace, mine.id, probe);
  await store.finishJob(context.workspace, mine.id, ['running'], 'failed', { error: { message: 'fixture terminal' }, exitCode: 1 });
  const foreignQueued = await store.reserveJob({ workspace: context.workspace, ownerSessionId: 'owner-b-secret-session', ownerTurnId: 'owner-b-secret-turn', command: 'rescue', readOnly: true, permissionSnapshot: { permissionMode: 'bypassPermissions', secret: 'permission-secret' } });
  const foreignStartedAt = new Date().toISOString();
  const foreign = await store.transitionJob(context.workspace, foreignQueued.id, ['queued'], 'running', {
    childPid: 424242, workerLeaseId: 'a'.repeat(64), effort: 'xhigh',
    model: { providerId: 'secret-provider', modelId: 'secret-model' },
    promptArtifact: 'artifacts/secret-prompt.json', startedAt: foreignStartedAt, zcodeSessionId: 'secret-zcode-session',
  });
  await store.transitionJob(context.workspace, foreign.id, ['running'], 'running', { inputId: 'secret-input', startRevision: 42, beforeMessageIds: ['secret-message'] });
  await store.updateJobProgress(context.workspace, foreign.id, { phase: 'running', message: 'foreign preview secret', observedAt: foreignStartedAt });

  const listed = await runCompanion(['status', '--all'], { cwd: context.workspace, env: context.env, caller: caller('owner-a') });
  const sameOwner = listed.jobs.find((/** @type {any} */ job) => job.id === mine.id);
  const otherOwner = listed.jobs.find((/** @type {any} */ job) => job.id === foreign.id);
  assert.equal(sameOwner.command, 'review'); assert.equal(sameOwner.readOnly, true); assert.equal(sameOwner.owner, 'same-owner');
  assert.equal(Object.hasOwn(sameOwner, 'progressProbe'), false);
  assert.deepEqual(Object.keys(otherOwner).sort(), ['createdAt', 'hasOwner', 'id', 'lastActivityAt', 'startedAt', 'status'].sort());
  assert.equal(otherOwner.hasOwner, true);
  const rendered = renderOutput(listed);
  assert.doesNotMatch(`${JSON.stringify(otherOwner)}\n${rendered}`, /owner-b|secret|xhigh|424242|latest=|result|internal/i);

  const detailed = await runCompanion(['status', mine.id], { cwd: context.workspace, env: context.env, caller: caller('owner-a') });
  assert.deepEqual(detailed.job.progressProbe, probe);
  assert.doesNotMatch(renderOutput(detailed), /progressProbe|framesReceived|acceptedOnline/);

  await assert.rejects(runCompanion(['status', foreign.id], { cwd: context.workspace, env: context.env, caller: caller('owner-a') }), { code: 'OWNED_JOB_NOT_FOUND' });
});

test('a recovered foreign completion remains readable only by its original owner', async () => {
  const { context, orphan, ownerA, ownerB } = await recoverForeignCompletion();
  await assert.rejects(runCompanion(['result', orphan.id], { cwd: context.workspace, env: context.env, caller: ownerB }), (error) => error instanceof PluginError && error.code === 'OWNED_JOB_NOT_FOUND');
  const result = await runCompanion(['result', orphan.id], { cwd: context.workspace, env: context.env, caller: ownerA }); assert.equal(result.result, 'owner A recovered result');
});

test('caller context is mandatory and diagnostics do not leak tokens or fake permission secrets', async () => {
  const context = await fixture();
  const missing = await companion(context, ['review'], { ZCODE_CALLER_CONTEXT: context.caller }, {});
  assert.notEqual(missing.code, 0); assert.equal(missing.json.error.code, 'INTERNAL_AUTHORIZATION_INVALID');
  const permitted = await companion(context, ['review'], { FAKE_ZCODE_PERMISSION: '1' });
  assert.equal(permitted.code, 0, permitted.stderr);
  assert.doesNotMatch(`${permitted.stdout}${permitted.stderr}`, /never-log-me/);
  assert.doesNotMatch(`${permitted.stdout}${permitted.stderr}`, new RegExp(context.caller));
});

test('internal authorization channel rejects malformed and oversized envelopes', async () => {
  const context = await fixture();
  for (const rawInput of ['{not-json}\n', `${JSON.stringify({ callerContext: 'x'.repeat(70 * 1024) })}\n`]) {
    const result = await run(process.execPath, [cli, 'review'], { cwd: context.workspace, env: context.env, rawInput });
    assert.notEqual(result.code, 0); assert.equal(JSON.parse(result.internal).error.code, 'INTERNAL_AUTHORIZATION_INVALID');
  }
});

test('caller authorization is absent from the running process command line and public streams', async () => {
  const context = await fixture(); const reserved = await companion(context, ['review', '--background']);
  const caller = await context.identity.createCallerContext({ sessionId: 'codex-session', turnId: 'turn-ps', workspace: context.workspace, permissionMode: 'workspace-write' });
  const child = spawn(process.execPath, [cli, 'status', reserved.json.job.id, '--wait', '--timeout-ms', '500'], { cwd: context.workspace, env: context.env, stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'], shell: false });
  let stdout = ''; let stderr = ''; let internal = ''; child.stdout?.on('data', (chunk) => { stdout += chunk; }); child.stderr?.on('data', (chunk) => { stderr += chunk; }); child.stdio[3]?.on('error', consumePipeError); child.stdio[4]?.on('error', consumePipeError); child.stdio[4]?.on('data', (chunk) => { internal += chunk; }); /** @type {import('node:stream').Writable} */ (child.stdio[3]).end(`${JSON.stringify({ callerContext: caller })}\n`);
  // `ps -p` is not a portable process-inspection primitive; Windows stream and
  // internal-channel assertions below still cover the no-leakage contract.
  if (process.platform !== 'win32') {
    const inspected = await run('ps', ['-p', String(child.pid), '-o', 'command=']);
    assert.equal(inspected.code, 0); assert.doesNotMatch(inspected.stdout, new RegExp(caller));
  }
  const code = await new Promise((resolvePromise, reject) => { child.once('error', reject); child.once('exit', resolvePromise); });
  assert.notEqual(code, 0); assert.doesNotMatch(`${stdout}${stderr}`, new RegExp(caller)); assert.equal(JSON.parse(internal).error.code, 'JOB_WAIT_TIMEOUT');
});

test('result refuses a symlink even when a persisted artifact path is scoped', async () => {
  const context = await fixture();
  const completed = await companion(context, ['review']);
  assert.equal(completed.code, 0, `${completed.stderr}${completed.stdout}`);
  const artifact = completed.json.job.resultArtifact;
  const storage = await resolveWorkspaceStorage(context);
  const artifactPath = join(storage.directory, artifact);
  await unlink(artifactPath); await symlink(join(context.workspace, 'tracked.txt'), artifactPath);
  const result = await companion(context, ['result', completed.json.job.id]);
  assert.notEqual(result.code, 0); assert.equal(result.json.error.code, 'RESULT_READ_FAILED');
});

test('artifact read and write reject intermediate directory symlinks', async () => {
  const writeContext = await fixture(); const writeStorage = await resolveWorkspaceStorage(writeContext); const writeEscape = join(writeContext.directory, 'write-escape');
  await mkdir(writeEscape); await symlink(writeEscape, join(writeStorage.directory, 'prompts'));
  const writeResult = await companion(writeContext, ['review']);
  assert.notEqual(writeResult.code, 0); assert.equal((await readdir(writeEscape)).length, 0);

  const readContext = await fixture(); const completed = await companion(readContext, ['review']); const readStorage = await resolveWorkspaceStorage(readContext);
  const resultsRoot = join(readStorage.directory, 'results'); const readEscape = join(readContext.directory, 'read-escape'); await mkdir(readEscape);
  const name = basename(completed.json.job.resultArtifact); await rename(join(resultsRoot, name), join(readEscape, name)); await rm(resultsRoot, { recursive: true }); await symlink(readEscape, resultsRoot);
  const readResult = await companion(readContext, ['result', completed.json.job.id]);
  assert.notEqual(readResult.code, 0); assert.equal(readResult.json.error.code, 'RESULT_READ_FAILED');
});

test('artifact writes reject an existing final symlink without replacing its target', async () => {
  const context = await fixture(); const reserved = await companion(context, ['review', '--background']); const storage = await resolveWorkspaceStorage(context);
  const prompts = join(storage.directory, 'prompts'); const escape = join(context.directory, 'prompt-escape'); await mkdir(prompts); await writeFile(escape, 'outside');
  const finalPath = join(prompts, `${reserved.json.job.id}.md`); await symlink(escape, finalPath);
  const result = await companion(context, reserved.json.privateInvocation, {}, { executionCapability: reserved.json.executionCapability, jobId: reserved.json.job.id });
  assert.notEqual(result.code, 0); assert.equal(await readFile(escape, 'utf8'), 'outside'); assert.equal((await stat(finalPath)).isFile(), true);
  assert.equal((await createStateStore({ dataRoot: context.dataRoot }).readJob(context.workspace, reserved.json.job.id)).status, 'failed');
});

test('real CLI cancellation waits for stop acknowledgement and reports stop failure', async () => {
  for (const stopFails of [false, true]) {
    const context = await fixture();
    const launch = { command: process.execPath, args: [fake], target: fake };
    const client = await createManagedZCodeClient({ dataRoot: context.dataRoot, workspace: context.workspace, launch, ownerId: ownerIdForSession('codex-session'), env: { ...context.env, ...(stopFails ? { FAKE_ZCODE_ERROR: 'session/stop' } : {}) } });
    const created = await client.createSession({ workspace: context.workspace }); await client.close();
    const store = createStateStore({ dataRoot: context.dataRoot });
    const queued = await store.reserveJob({ workspace: context.workspace, ownerSessionId: 'codex-session', ownerTurnId: 'turn-1', command: 'rescue', readOnly: false, permissionSnapshot: { permissionMode: 'workspace-write' } });
    await startWritableRescueForTest(store, context.workspace, queued, { zcodeSessionId: created.session.sessionId });
    const cancelled = await companion(context, ['cancel', queued.id]);
    if (stopFails) {
      assert.notEqual(cancelled.code, 0); assert.equal(cancelled.json.error.code, 'JOB_CANCEL_FAILED');
      assert.equal((await store.readJob(context.workspace, queued.id)).status, 'running');
    } else {
      assert.equal(cancelled.code, 0, `${cancelled.stderr}${cancelled.stdout}`); assert.equal(cancelled.json.job.status, 'cancelled');
    }
  }
});

test('real CLI cancellation stops sessions owned by the Transfer broker profile', async () => {
  const context = await fixture(); const launch = { command: process.execPath, args: [fake], target: fake };
  const client = await createManagedZCodeClient({ dataRoot: context.dataRoot, workspace: context.workspace, launch, ownerId: ownerIdForSession('codex-session'), env: context.env, maxFrameBytes: TRANSFER_WIRE_LIMITS.maxFrameBytes, maxOutboundBytes: TRANSFER_WIRE_LIMITS.maxOutboundBytes, drainTimeoutMs: TRANSFER_WIRE_LIMITS.drainTimeoutMs });
  const created = await client.createSession({ workspace: context.workspace, importedHistory: { messages: [{ role: 'user', content: 'history' }] } }); await client.close();
  const store = createStateStore({ dataRoot: context.dataRoot }); const queued = await store.reserveJob({ workspace: context.workspace, ownerSessionId: 'codex-session', ownerTurnId: 'turn-1', command: 'transfer', codexThreadId: 'codex-session', readOnly: true, permissionSnapshot: { permissionMode: 'workspace-write' } });
  await store.transitionJob(context.workspace, queued.id, ['queued'], 'running', { zcodeSessionId: created.session.sessionId });
  const cancelled = await companion(context, ['cancel', queued.id]);
  assert.equal(cancelled.code, 0, `${cancelled.stderr}${cancelled.stdout}`); assert.equal(cancelled.json.job.status, 'cancelled');
});

test('rescue requires an explicit choice when an owned resumable session exists', async () => {
  const context = await fixture();
  const fresh = await companion(context, ['rescue', '--fresh', 'first task']);
  assert.equal(fresh.code, 0, `${fresh.stderr}${fresh.stdout}`);
  const undecided = await companion(context, ['rescue', 'next task']);
  assert.equal(undecided.code, 3); assert.equal(undecided.json.type, 'needs-choice');
  assert.deepEqual(undecided.json.choices, ['--resume', '--fresh']);
  const resumed = await companion(context, ['rescue', '--resume', 'next task']);
  assert.equal(resumed.code, 0, `${resumed.stderr}${resumed.stdout}`);
  assert.equal(resumed.json.job.zcodeSessionId, fresh.json.job.zcodeSessionId);
  const resumeLog = await readFile(resumed.json.job.logFile, 'utf8');
  assert.match(resumeLog, /Assistant message\ndone\n/); assert.match(resumeLog, /Final output\ndone\n/);
  assert.equal((resumeLog.match(/Assistant message/g) ?? []).length, 1);
  assert.equal((resumeLog.match(/Final output/g) ?? []).length, 1);
  assert.doesNotMatch(resumeLog, /PRIVATE_REASONING|RAW_TOOL_OUTPUT|CAPABILITY_TOKEN/);
});

test('trusted bound routing keeps choice identity private and permits only fresh permission replacement', async () => {
  const context = await fixture(); const executor = { agentId: 'bound-child', agentType: 'zcode-rescue', agentPath: '/root/zcode_rescue_task', parentSessionId: 'bound-parent', parentTurnId: 'turn-a', parentPermissionMode: 'workspace-write', workspace: context.workspace };
  const initial = await runCompanion(['rescue', '--fresh', 'bound first'], { cwd: context.workspace, env: context.env, caller: caller('bound-parent', 'turn-a'), executor });
  assert.equal(initial.job.status, 'succeeded');
  const choice = await runCompanion(['rescue', 'bound next'], { cwd: context.workspace, env: context.env, caller: caller('bound-parent', 'turn-b'), executor });
  assert.deepEqual(choice, { type: 'needs-choice', choices: ['--resume', '--fresh'] });
  assert.doesNotMatch(JSON.stringify(choice), /bound-child|bound-parent|[a-f0-9]{64}/u);
  const changedCaller = { ...caller('bound-parent', 'turn-c'), permissionMode: 'read-only' };
  await assert.rejects(runCompanion(['rescue', '--resume', 'wrong permission'], { cwd: context.workspace, env: context.env, caller: changedCaller, executor }), { code: 'RESCUE_BINDING_INVALID' });
  const replaced = await runCompanion(['rescue', '--fresh', 'authorized replacement'], { cwd: context.workspace, env: context.env, caller: changedCaller, executor });
  assert.equal(replaced.job.status, 'succeeded'); assert.notEqual(replaced.job.zcodeSessionId, initial.job.zcodeSessionId);
  assert.equal((await createStateStore({ dataRoot: context.dataRoot }).resolveRescueBinding({ workspace: context.workspace, parentSessionId: 'bound-parent', executorAgentId: 'bound-child', executorAgentType: 'zcode-rescue', executorParentTurnId: 'turn-a', executorParentPermissionMode: 'workspace-write', permissionMode: 'read-only' })).kind, 'bound');
});

test('resumed rescue cannot reuse a historical visible result when the current turn is hidden', async () => {
  const context = await fixture(); const fresh = await companion(context, ['rescue', '--fresh', 'historical visible']);
  assert.equal(fresh.code, 0, `${fresh.stderr}${fresh.stdout}`);
  const resumed = await companion(context, ['rescue', '--resume', 'current hidden']);
  assert.notEqual(resumed.code, 0); assert.equal(resumed.json.error.code, 'ZCODE_RESULT_MISSING');
  const jobs = await createStateStore({ dataRoot: context.dataRoot }).listJobs(context.workspace);
  assert.equal(jobs.filter((/** @type {any} */ job) => job.status === 'failed').length, 1);
});

test('resumed rescue rejects an unrelated-only new assistant result', async () => {
  const context = await fixture(); const fresh = await companion(context, ['rescue', '--fresh', 'historical visible']);
  assert.equal(fresh.code, 0, `${fresh.stderr}${fresh.stdout}`);
  const resumed = await companion(context, ['rescue', '--resume', 'current unrelated']);
  assert.notEqual(resumed.code, 0); assert.equal(resumed.json.error.code, 'ZCODE_RESULT_MISSING');
  const jobs = await createStateStore({ dataRoot: context.dataRoot }).listJobs(context.workspace);
  assert.equal(jobs.filter((/** @type {any} */ job) => job.status === 'failed').length, 1);
});

test('foreground rescue accepts a 0.16.3 result linked through a distinct user message id', async () => {
  const context = await fixture(); const linkageRecord = join(context.directory, 'distinct-linkage.json');
  const result = await companion(context, ['rescue', '--fresh', 'current distinct id'], { FAKE_ZCODE_VERSION: '0.16.3', FAKE_ZCODE_GATE_RESULT: 'distinct-id result', FAKE_ZCODE_LINKAGE_RECORD: linkageRecord });
  assert.equal(result.code, 0, `${result.stderr}${result.stdout}`); assert.equal(result.json.job.status, 'succeeded'); assert.equal(result.json.result, 'distinct-id result');
  const linkage = JSON.parse(await readFile(linkageRecord, 'utf8'));
  assert.notEqual(linkage.inputId, linkage.userMessageId); assert.equal(linkage.assistantParentMessageId, linkage.userMessageId);
});

test('foreground launch failure durably fails its reserved job', async () => {
  const context = await fixture();
  const failed = await companion(context, ['review'], { FAKE_ZCODE_VERSION: '0.1.0' });
  assert.notEqual(failed.code, 0);
  const jobs = await createStateStore({ dataRoot: context.dataRoot }).listJobs(context.workspace);
  assert.equal(jobs.length, 1); assert.equal(jobs[0].status, 'failed'); assert.equal(jobs[0].exitCode, 1);
});

test('private execution rejects a permission snapshot mismatch', async () => {
  const context = await fixture();
  const reserved = await companion(context, ['review', '--background']);
  const storage = await resolveWorkspaceStorage(context);
  const jobPath = join(storage.directory, 'jobs', `${reserved.json.job.id}.json`);
  const job = JSON.parse(await readFile(jobPath, 'utf8')); job.permissionSnapshot = { permissionMode: 'bypassPermissions' };
  await atomicWriteJson(jobPath, job);
  const result = await companion(context, reserved.json.privateInvocation, {}, { executionCapability: reserved.json.executionCapability, jobId: reserved.json.job.id });
  assert.notEqual(result.code, 0); assert.equal(result.json.error.code, 'EXECUTION_SNAPSHOT_MISMATCH');
});

test('tampered background spec is rejected before consuming its capability', async () => {
  const context = await fixture();
  const reserved = await companion(context, ['rescue', '--background', '--fresh', 'original task']);
  const storage = await resolveWorkspaceStorage(context);
  const path = join(storage.directory, 'job-specs', `${reserved.json.job.id}.json`);
  const original = JSON.parse(await readFile(path, 'utf8')); const tampered = structuredClone(original);
  tampered.sealedSpec.ciphertext = `${tampered.sealedSpec.ciphertext[0] === 'A' ? 'B' : 'A'}${tampered.sealedSpec.ciphertext.slice(1)}`;
  await atomicWriteJson(path, tampered);
  const authorization = { executionCapability: reserved.json.executionCapability, jobId: reserved.json.job.id };
  const denied = await companion(context, reserved.json.privateInvocation, {}, authorization);
  assert.notEqual(denied.code, 0); assert.equal(denied.json.error.code, 'JOB_SPEC_TAMPERED');
  await atomicWriteJson(path, original);
  const retried = await companion(context, reserved.json.privateInvocation, {}, authorization);
  assert.equal(retried.code, 0, `${retried.stderr}${retried.stdout}`);
});

test('background resume revalidates the bound candidate immediately before resuming', async () => {
  const context = await fixture();
  const completed = await companion(context, ['rescue', '--fresh', 'first task']);
  const reserved = await companion(context, ['rescue', '--resume', '--background', 'second task']);
  const storage = await resolveWorkspaceStorage(context);
  const candidatePath = join(storage.directory, 'jobs', `${completed.json.job.id}.json`);
  const candidate = JSON.parse(await readFile(candidatePath, 'utf8')); candidate.zcodeSessionId = 'substituted-session';
  await atomicWriteJson(candidatePath, candidate);
  const result = await companion(context, reserved.json.privateInvocation, {}, { executionCapability: reserved.json.executionCapability, jobId: reserved.json.job.id });
  assert.notEqual(result.code, 0); assert.equal(result.json.error.code, 'RESUME_CANDIDATE_INVALID');
  assert.equal((await createStateStore({ dataRoot: context.dataRoot }).readJob(context.workspace, reserved.json.job.id)).status, 'failed');
});

test('model selection is applied at create time when resolvable and after live catalog or resume otherwise', async () => {
  const context = await fixture(); const recordPath = join(context.directory, 'requests.jsonl');
  const readRequests = async () => (await readFile(recordPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  const storage = await resolveWorkspaceStorage(context);
  await atomicWriteJson(join(storage.directory, 'config', 'models.json'), { version: 1, defaultModel: 'quick', models: { quick: { providerId: 'fake2', modelId: 'other' } } });

  await companion(context, ['rescue', '--fresh', '--model', 'fake/model', 'qualified'], { FAKE_ZCODE_RECORD: recordPath });
  let requests = await readRequests();
  assert.deepEqual(requests.find((request) => request.method === 'session/create').params.model, { providerId: 'fake', modelId: 'model' }, 'explicit model beats persisted default');

  await writeFile(recordPath, '');
  const defaultRun = await companion(context, ['rescue', '--fresh', 'workspace default'], { FAKE_ZCODE_RECORD: recordPath });
  requests = await readRequests();
  assert.deepEqual(requests.find((request) => request.method === 'session/create').params.model, { providerId: 'fake2', modelId: 'other' }, 'persisted default beats ZCode default');
  const status = await companion(context, ['status', defaultRun.json.job.id]);
  assert.deepEqual(status.json.modelPolicy, { configured: true, defaultModel: 'quick', aliases: ['quick'] });
  assert.match(renderOutput(status.json), /Model policy: default=quick; aliases=quick/);

  await writeFile(recordPath, '');
  const ignoredLegacy = await companion(context, ['rescue', '--fresh', '--model', 'legacy', 'ignored'], { FAKE_ZCODE_RECORD: recordPath, ZCODE_MODEL_ALIASES: JSON.stringify({ legacy: { providerId: 'fake2', modelId: 'other' } }) });
  assert.notEqual(ignoredLegacy.code, 0); assert.equal(ignoredLegacy.json.error.code, 'MODEL_NOT_FOUND');

  await writeFile(recordPath, '');
  await companion(context, ['rescue', '--fresh', '--model', 'other', 'catalog'], { FAKE_ZCODE_RECORD: recordPath });
  requests = await readRequests();
  assert.equal(requests.find((request) => request.method === 'session/create').params.model, undefined);
  assert.deepEqual(requests.find((request) => request.method === 'session/setModel').params.model, { providerId: 'fake2', modelId: 'other' });

  await writeFile(recordPath, '');
  const resumed = await companion(context, ['rescue', '--resume', '--model', 'fake/model', 'resume'], { FAKE_ZCODE_RECORD: recordPath });
  assert.equal(resumed.code, 0, `${resumed.stderr}${resumed.stdout}`);
  requests = await readRequests();
  assert.ok(requests.some((request) => request.method === 'session/resume'));
  assert.ok(requests.some((request) => request.method === 'session/setModel' && request.params.model.providerId === 'fake'));
});

test('result extraction accepts mixed visible output and rejects reasoning-only or invalid structured output', async () => {
  const mixedContext = await fixture(); const mixed = await companion(mixedContext, ['review'], { FAKE_ZCODE_RESULT_MODE: 'mixed' });
  assert.equal(mixed.code, 0, `${mixed.stderr}${mixed.stdout}`); assert.deepEqual(JSON.parse(mixed.json.result), { findings: [] }); assert.doesNotMatch(mixed.json.result, /private reasoning|ignored/);
  for (const mode of ['reasoning-only', 'invalid-structured']) {
    const context = await fixture(); const result = await companion(context, ['review'], { FAKE_ZCODE_RESULT_MODE: mode });
    assert.notEqual(result.code, 0); assert.doesNotMatch(`${result.stdout}${result.stderr}${result.internal}`, /private reasoning/);
    const jobs = await createStateStore({ dataRoot: context.dataRoot }).listJobs(context.workspace);
    assert.equal(jobs[0].status, 'failed'); assert.equal(jobs[0].resultArtifact, undefined);
  }
});

test('status --all reports every workspace job with isolated ownership projections', async () => {
  const context = await fixture();
  await companion(context, ['review', '--background']);
  await companion(context, ['adversarial-review', '--background', 'focus']);
  const otherCaller = await context.identity.createCallerContext({ sessionId: 'other-session', turnId: 'other-turn', workspace: context.workspace, permissionMode: 'read-only' });
  await companion(context, ['review', '--background'], {}, { callerContext: otherCaller });
  const listed = await companion(context, ['status', '--all']);
  assert.equal(listed.json.jobs.length, 3);
  assert.equal(listed.json.jobs.filter((/** @type {any} */ job) => job.owned).length, 2);
  const foreign = listed.json.jobs.find((/** @type {any} */ job) => job.hasOwner === true);
  assert.deepEqual(Object.keys(foreign).sort(), ['createdAt', 'hasOwner', 'id', 'status'].sort());
  assert.ok(listed.json.jobs.every((/** @type {any} */ job) => !('ownerSessionId' in job) && !('ownerTurnId' in job) && !('permissionSnapshot' in job)));
  const lines = listed.stdout.trim().split('\n');
  assert.equal(lines.pop(), 'Model policy: default=ZCode default; aliases=none');
  assert.deepEqual(lines, listed.json.jobs.map((/** @type {any} */ job) => job.hasOwner === true
    ? `${job.id} ${job.status} owner=redacted created=${job.createdAt} started=— finished=— activity=—`
    : `${job.id} ${job.status} ${job.command} ${job.owner} phase=— activity=—`));
  assert.doesNotMatch(listed.stdout, /codex-session|other-session/);
});

test('real CLI status wait stays alive until its timeout', async () => {
  const context = await fixture();
  const reserved = await companion(context, ['review', '--background']);
  const waited = await companion(context, ['status', reserved.json.job.id, '--wait', '--timeout-ms', '20']);
  assert.equal(waited.code, 1); assert.equal(waited.json.error.code, 'JOB_WAIT_TIMEOUT');
});

test('real CLI status wait exits immediately without protocol output on SIGINT', { skip: windowsRealSignalSkip }, async (t) => {
  const context = await fixture(); const marker = join(context.directory, 'status-wait.txt');
  const store = createStateStore({ dataRoot: context.dataRoot });
  const queued = await store.reserveJob({ workspace: context.workspace, ownerSessionId: 'codex-session', ownerTurnId: 'turn-1', command: 'review', readOnly: true, permissionSnapshot: { permissionMode: 'workspace-write' } });
  await store.transitionJob(context.workspace, queued.id, ['queued'], 'running', { childPid: process.pid, zcodeSessionId: 'status-wait-session' });
  const child = spawn(process.execPath, ['--require', statusWaitProbe, cli, 'status', queued.id, '--wait', '--timeout-ms', '10000'], {
    cwd: context.workspace,
    env: { ...context.env, ZCODE_STATUS_WAIT_PROBE: marker },
    stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'], shell: false,
  });
  let stdout = ''; let stderr = ''; let internal = ''; let exited = false;
  child.stdout?.on('data', (chunk) => { stdout += chunk; }); child.stderr?.on('data', (chunk) => { stderr += chunk; }); child.stdio[4]?.on('data', (chunk) => { internal += chunk; });
  child.stdio[3]?.on('error', consumePipeError); child.stdio[4]?.on('error', consumePipeError);
  /** @type {import('node:stream').Writable} */ (child.stdio[3]).end(`${JSON.stringify({ callerContext: context.caller })}\n`);
  t.after(() => { if (!exited) child.kill('SIGKILL'); });
  const exitPromise = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => { exited = true; resolve({ code, signal }); }); });

  await waitFor(async () => await readFile(marker, 'utf8').catch(() => '') === 'waiting', 'status command did not enter its polling wait');
  child.kill('SIGINT');
  /** @type {NodeJS.Timeout|undefined} */ let deadline;
  const exit = await Promise.race([exitPromise, new Promise((resolve, reject) => { void resolve; deadline = setTimeout(() => { if (!exited) child.kill('SIGKILL'); reject(new Error('status wait did not exit promptly after SIGINT')); }, 1_000); })]).finally(() => clearTimeout(deadline));

  assert.deepEqual(exit, { code: 130, signal: null });
  assert.equal(stdout, ''); assert.equal(internal, '');
  assert.match(stderr, /Interrupted by SIGINT\./); assert.doesNotMatch(stderr, /JOB_INTERRUPTED|JOB_WAIT_TIMEOUT|"error"/);
  assert.equal((await store.readJob(context.workspace, queued.id)).status, 'running');
});

test('foreground Transfer observes SIGTERM after its bounded create RPC and exits 143', { skip: windowsRealSignalSkip }, async (t) => {
  const context = await fixture(); const zcodeRecord = join(context.directory, 'transfer-interrupt.jsonl'); await writeFile(zcodeRecord, '');
  const sourceThread = { id: 'codex-session', ephemeral: false, turns: [{ startedAt: 1_725_000_000, items: [{ type: 'agentMessage', text: 'visible response' }] }] };
  const child = spawn(process.execPath, [cli, 'transfer'], {
    cwd: context.workspace,
    env: { ...context.env, CODEX_APP_SERVER_PATH: process.execPath, CODEX_APP_SERVER_ARGS_JSON: JSON.stringify([fakeCodex]), FAKE_CODEX_THREAD_JSON: JSON.stringify(sourceThread), FAKE_ZCODE_RECORD: zcodeRecord, FAKE_ZCODE_DELAY_MS: '200' },
    stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'], shell: false,
  });
  let stdout = ''; let stderr = ''; let internal = ''; let exited = false;
  child.stdout?.on('data', (chunk) => { stdout += chunk; }); child.stderr?.on('data', (chunk) => { stderr += chunk; }); child.stdio[4]?.on('data', (chunk) => { internal += chunk; });
  child.stdio[3]?.on('error', consumePipeError); child.stdio[4]?.on('error', consumePipeError); /** @type {import('node:stream').Writable} */ (child.stdio[3]).end(`${JSON.stringify({ callerContext: context.caller })}\n`);
  t.after(() => { if (!exited) child.kill('SIGKILL'); });
  const exitPromise = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => { exited = true; resolve({ code, signal }); }); });
  const recorded = async () => (await readFile(zcodeRecord, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  await waitFor(async () => (await recorded()).some((frame) => frame.method === 'session/create'), 'Transfer create RPC did not start'); child.kill('SIGTERM');
  const exit = await exitPromise; assert.deepEqual(exit, { code: 143, signal: null });
  const calls = await recorded(); const sessionId = calls.find((frame) => frame.method === 'session/stop')?.params?.sessionId;
  assert.equal(typeof sessionId, 'string'); assert.equal(calls.filter((frame) => frame.method === 'session/stop' && frame.params.sessionId === sessionId).length, 1);
  const jobs = await createStateStore({ dataRoot: context.dataRoot }).listJobs(context.workspace); assert.equal(jobs.length, 1); assert.equal(jobs[0].status, 'cancelled'); assert.equal(jobs[0].zcodeSessionId, sessionId); assert.equal(jobs[0].resultArtifact, undefined);
  assert.equal(stdout, ''); assert.equal(internal, ''); assert.match(stderr, /Interrupted by SIGTERM\./); assert.doesNotMatch(stderr, /JOB_INTERRUPTED|"error"/);
});

test('real Transfer imports current Codex history into a resumable ZCode session without leaking caller authorization', async () => {
  const context = await fixture(); const codexRecord = join(context.directory, 'codex.jsonl'); const zcodeRecord = join(context.directory, 'zcode.jsonl');
  await writeFile(codexRecord, ''); await writeFile(zcodeRecord, '');
  const sourceThread = { id: 'codex-session', ephemeral: false, turns: [{ id: 'private-turn-id', startedAt: 1_725_000_000, completedAt: 1_725_000_001, items: [
    { type: 'userMessage', id: 'private-user-id', content: [{ type: 'text', text: 'visible request' }] },
    { type: 'reasoning', summary: ['hidden reasoning'] },
    { type: 'agentMessage', id: 'private-agent-id', text: 'visible response' },
  ] }] };
  const transferred = await companion(context, ['transfer'], {
    CODEX_APP_SERVER_PATH: process.execPath,
    CODEX_APP_SERVER_ARGS_JSON: JSON.stringify([fakeCodex]),
    FAKE_CODEX_RECORD: codexRecord,
    FAKE_CODEX_THREAD_JSON: JSON.stringify(sourceThread),
    FAKE_ZCODE_RECORD: zcodeRecord,
  });
  assert.equal(transferred.code, 0, `${transferred.stderr}${transferred.stdout}`); assert.equal(transferred.json.type, 'transfer'); assert.equal(transferred.json.job.status, 'succeeded');
  assert.match(transferred.stdout, /Imported from Codex/); assert.match(transferred.stdout, /ZCode session ID: session-1/); assert.match(transferred.stdout, /--resume session-1/);
  const codexCalls = (await readFile(codexRecord, 'utf8')).trim().split('\n').map((line) => JSON.parse(line)).filter((entry) => entry.method);
  assert.deepEqual(codexCalls.map((entry) => entry.method), ['initialize', 'initialized', 'thread/read']); assert.equal(codexCalls[2].params.threadId, 'codex-session');
  const zcodeCalls = (await readFile(zcodeRecord, 'utf8')).trim().split('\n').map((line) => JSON.parse(line)); const create = zcodeCalls.find((entry) => entry.method === 'session/create');
  assert.deepEqual(create.params.importedHistory, { source: 'claudeCode', messages: [{ role: 'user', content: 'visible request', timestamp: 1_725_000_000_000 }, { role: 'assistant', content: 'visible response', timestamp: 1_725_000_000_000 }] });
  assert.equal(zcodeCalls.some((entry) => entry.method === 'session/send'), false);
  const client = await createManagedZCodeClient({ dataRoot: context.dataRoot, workspace: context.workspace, launch: { command: process.execPath, args: [fake], target: fake }, ownerId: ownerIdForSession('codex-session'), env: context.env, maxFrameBytes: TRANSFER_WIRE_LIMITS.maxFrameBytes, maxOutboundBytes: TRANSFER_WIRE_LIMITS.maxOutboundBytes, drainTimeoutMs: TRANSFER_WIRE_LIMITS.drainTimeoutMs });
  try { assert.equal((await client.resumeSession(transferred.json.zcodeSessionId)).session.sessionId, transferred.json.zcodeSessionId); } finally { await client.close(); }
  const storage = await resolveWorkspaceStorage(context); const artifact = await readFile(join(storage.directory, transferred.json.job.resultArtifact), 'utf8');
  const exposed = `${transferred.stdout}${transferred.stderr}${await readFile(codexRecord, 'utf8')}${await readFile(zcodeRecord, 'utf8')}${artifact}`;
  assert.doesNotMatch(exposed, new RegExp(context.caller)); assert.doesNotMatch(exposed, /hidden reasoning|private-turn-id|private-user-id|private-agent-id|transcript_path/);
});

test('public Transfer reports one fixed safe diagnostic when its attached job log becomes unwritable', async () => {
  const context = await fixture();
  /** @type {string[]} */
  const diagnostics = [];
  const sourceThread = { id: 'codex-session', ephemeral: false, turns: [{ startedAt: 1_725_000_000, items: [{ type: 'agentMessage', text: 'visible response' }] }] };
  const output = await runCompanion(['transfer'], {
    cwd: context.workspace,
    env: context.env,
    caller: caller('codex-session'),
    progressWriter: (line) => { diagnostics.push(line); },
    dependencies: {
      readCodexThread: async () => {
        const jobs = await createStateStore({ dataRoot: context.dataRoot }).listJobs(context.workspace);
        assert.equal(jobs.length, 1); assert.equal(typeof jobs[0].logFile, 'string');
        await rm(jobs[0].logFile); await mkdir(jobs[0].logFile);
        return sourceThread;
      },
      createManagedZCodeClient: async (/** @type {any} */ options) => {
        assert.equal(Object.hasOwn(options, 'completionTimeoutMs'), false, 'ordinary foreground clients must not receive a completion deadline');
        return { createSession: async () => ({ session: { sessionId: 'session-log-diagnostic' } }), close: async () => {} };
      },
    },
  });
  assert.equal(output.job.status, 'succeeded'); assert.equal(output.zcodeSessionId, 'session-log-diagnostic');
  assert.deepEqual(diagnostics, ['[zcode] ZCode job log was disabled.\n']);
  assert.doesNotMatch(diagnostics.join(''), new RegExp(context.directory.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(diagnostics.join(''), /EISDIR|job-log|\.log/);
});

test('Transfer launcher configuration failure terminalizes its reserved job', async () => {
  const context = await fixture();
  const result = await companion(context, ['transfer'], { CODEX_APP_SERVER_ARGS_JSON: '{bad-json' });
  assert.notEqual(result.code, 0); assert.equal(result.json.error.code, 'CODEX_APP_SERVER_CONFIG_INVALID');
  const jobs = await createStateStore({ dataRoot: context.dataRoot }).listJobs(context.workspace);
  assert.equal(jobs.length, 1); assert.equal(jobs[0].command, 'transfer'); assert.equal(jobs[0].status, 'failed');
});

test('Transfer rejects hostile ZCode session IDs before artifacts or public/internal output can contain them', async () => {
  for (const sessionId of ['injected\nSUCCESS', '\u001b[31mSUCCESS', 'x'.repeat(513)]) {
    const context = await fixture();
    const result = await companion(context, ['transfer'], { CODEX_APP_SERVER_PATH: process.execPath, CODEX_APP_SERVER_ARGS_JSON: JSON.stringify([fakeCodex]), FAKE_CODEX_THREAD_JSON: JSON.stringify({ id: 'codex-session', ephemeral: false, turns: [{ startedAt: 1_725_000_000, items: [{ type: 'agentMessage', text: 'answer' }] }] }), FAKE_ZCODE_SESSION_ID: sessionId });
    assert.notEqual(result.code, 0); assert.equal(result.json.error.code, 'ZCODE_OUTPUT_INVALID'); assert.doesNotMatch(`${result.stdout}${result.stderr}${result.internal}`, new RegExp(sessionId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    const jobs = await createStateStore({ dataRoot: context.dataRoot }).listJobs(context.workspace); assert.equal(jobs[0].status, 'failed'); assert.equal(jobs[0].zcodeSessionId, undefined); assert.equal(jobs[0].resultArtifact, undefined);
  }
});

test('Transfer carries five maximum-size messages through the managed broker without enlarging ordinary defaults', async () => {
  const context = await fixture();
  const transferred = await companion(context, ['transfer'], {
    CODEX_APP_SERVER_PATH: process.execPath,
    CODEX_APP_SERVER_ARGS_JSON: JSON.stringify([fakeCodex]),
    FAKE_CODEX_GENERATED_MESSAGE_BYTES: String(1024 * 1024),
    FAKE_CODEX_GENERATED_MESSAGE_COUNT: '5',
  });
  assert.equal(transferred.code, 0, `${transferred.stderr}${transferred.stdout}`);
  assert.equal(transferred.json.job.status, 'succeeded'); assert.equal(transferred.json.zcodeSessionId, 'session-1');
  const reviewed = await companion(context, ['review']); assert.equal(reviewed.code, 0, `${reviewed.stderr}${reviewed.stdout}`);
  const storage = await resolveWorkspaceStorage(context); const identities = (await readdir(join(storage.directory, 'broker'))).filter((name) => /^identity(?:-[a-f0-9]+)?\.json$/.test(name));
  assert.equal(identities.length, 2); assert.ok(identities.includes('identity.json'));
});
