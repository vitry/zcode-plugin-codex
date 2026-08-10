// @ts-nocheck
import assert from 'node:assert/strict';
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { buildMarketplaceSnapshot } from '../../scripts/build-marketplace-snapshot.mjs';
import { runProcess } from '../../scripts/lib/process.mjs';
import { withWorkerLease } from '../../scripts/lib/recovery.mjs';
import { codexLaunch, npmLaunch } from '../../scripts/lib/tool-launch.mjs';
import { resolveWorkspaceStorage } from '../../scripts/lib/workspace.mjs';
import {
  CodexRescueEvidenceMismatchError,
  CodexRescueUnqualifiedError,
  parseCodexRolloutJsonl,
  qualifyCodexRescueBackgroundEvidence,
  qualifyCodexRescueChoiceEvidence,
  qualifyCodexRescueEvidence,
} from '../helpers/codex-rescue-qualification.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const fakeZCode = fileURLToPath(new URL('../fixtures/fake-zcode-cli.mjs', import.meta.url));
const qualificationRequired = process.env.ZCODE_REQUIRE_QUALIFIED === '1';
const optInSkip = process.env.ZCODE_CODEX_SKILLS_E2E === '1' || qualificationRequired ? false : unqualified('opt-in-required', 'Set ZCODE_CODEX_SKILLS_E2E=1 to spend authenticated Codex credits.');
const rescueOptInSkip = process.env.ZCODE_CODEX_RESCUE_E2E === '1' || qualificationRequired ? false : unqualified('opt-in-required', 'Set ZCODE_CODEX_RESCUE_E2E=1 to qualify the runtime-observed native Rescue route.');

test('installed marketplace skill crosses a real ephemeral Codex turn into ZCode', { skip: optInSkip, timeout: 240_000 }, async (t) => {
  if (process.env.ZCODE_CODEX_SKILLS_E2E !== '1') assert.fail(unqualified('opt-in-required', 'Required qualification needs ZCODE_CODEX_SKILLS_E2E=1.'));
  const temporary = await mkdtemp(join(tmpdir(), 'zcode-codex-skills-e2e-')); t.after(() => rm(temporary, { recursive: true, force: true }));
  const codexHome = join(temporary, 'codex-home'); const home = join(temporary, 'home'); const marketplace = join(temporary, 'marketplace'); const workspace = join(temporary, 'workspace'); const zcodeRecord = join(temporary, 'zcode.jsonl');
  await Promise.all([mkdir(codexHome, { recursive: true, mode: 0o700 }), mkdir(home, { recursive: true, mode: 0o700 }), mkdir(workspace, { recursive: true }), writeFile(zcodeRecord, '')]);
  const sourceCodexHome = process.env.CODEX_HOME ?? join(homedir(), '.codex');
  try { await stat(join(sourceCodexHome, 'auth.json')); await cp(join(sourceCodexHome, 'auth.json'), join(codexHome, 'auth.json')); await chmod(join(codexHome, 'auth.json'), 0o600); }
  catch { markUnqualified(t, unqualified('auth-required', 'No transferable Codex auth.json was found.')); return; }
  const env = { ...process.env, CODEX_HOME: codexHome, HOME: home, USERPROFILE: home, ZCODE_PATH: fakeZCode, FAKE_ZCODE_RECORD: zcodeRecord, PATH: process.env.PATH ?? '' };
  const auth = await codex(['login', 'status'], temporary, env, 30_000); if (auth.code !== 0) { markUnqualified(t, unqualified('auth-required', 'The isolated Codex home is not authenticated.')); return; }
  await buildMarketplaceSnapshot({ root, output: marketplace, sourceRef: 'qualified-e2e', sourceSha: '0'.repeat(40), npmExecPath: process.env.NPM_CLI_JS ?? npmLaunch([]).args[0], env });
  for (const args of [['plugin', 'marketplace', 'add', marketplace, '--json'], ['plugin', 'add', 'zcode@vitry', '--json']]) { const result = await codex(args, temporary, env); assert.equal(result.code, 0, result.stderr || result.stdout); }
  await git(['init', '-q'], workspace); await writeFile(join(workspace, 'tracked.txt'), 'base\n'); await git(['add', 'tracked.txt'], workspace); await git(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'base'], workspace); await writeFile(join(workspace, 'tracked.txt'), 'changed\n');
  const prompt = 'Use the installed $zcode:review --wait skill exactly once now. Return only its final result.';
  const result = await codex(['exec', '--ephemeral', '--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', '--dangerously-bypass-hook-trust', '--enable', 'hooks', '-c', 'shell_environment_policy.inherit=all', '-C', workspace, prompt], workspace, env, 180_000);
  const failureOutput = `${result.stdout}\n${result.stderr}`;
  if (result.code !== 0 && /unauthorized|authentication|not logged in|login required|\b401\b/i.test(failureOutput)) { markUnqualified(t, unqualified('auth-required', 'Codex authentication expired or was rejected after preflight.')); return; }
  if (result.code !== 0 && /credit|usage limit|quota|rate.?limit|insufficient/i.test(failureOutput)) { markUnqualified(t, unqualified('credits-unavailable', 'The authenticated account has no credits available for this qualification run.')); return; }
  assert.equal(result.code, 0, `codex exec failed\n${result.stdout}\n${result.stderr}`);
  const frames = result.stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)); assert.ok(frames.length > 0, 'codex exec --json must emit events');
  const zcodeCalls = (await readFile(zcodeRecord, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  assert.ok(zcodeCalls.some((call) => call.method === 'session/send'), 'installed hook plus direct companion must reach ZCode');
});

test('installed Rescue uses one isolated native child for initial and choice continuations', { skip: rescueOptInSkip, timeout: 1_200_000 }, async (t) => {
  if (process.env.ZCODE_CODEX_RESCUE_E2E !== '1') assert.fail(unqualified('opt-in-required', 'Required qualification needs ZCODE_CODEX_RESCUE_E2E=1.'));
  const temporary = await mkdtemp(join(tmpdir(), 'zcode-codex-rescue-e2e-')); let preserveTemporary = false; t.after(() => preserveTemporary ? t.diagnostic(`preserved active background evidence at ${temporary}`) : rm(temporary, { recursive: true, force: true }));
  const codexHome = join(temporary, 'codex-home'); const home = join(temporary, 'home'); const marketplace = join(temporary, 'marketplace'); const workspace = join(temporary, 'workspace'); const zcodeRecord = join(temporary, 'zcode.jsonl');
  await Promise.all([mkdir(codexHome, { recursive: true, mode: 0o700 }), mkdir(home, { recursive: true, mode: 0o700 }), mkdir(workspace, { recursive: true }), writeFile(zcodeRecord, '')]);
  const sourceCodexHome = process.env.CODEX_HOME ?? join(homedir(), '.codex');
  try { await stat(join(sourceCodexHome, 'auth.json')); await cp(join(sourceCodexHome, 'auth.json'), join(codexHome, 'auth.json')); await chmod(join(codexHome, 'auth.json'), 0o600); }
  catch { markUnqualified(t, unqualified('auth-required', 'No transferable Codex auth.json was found.')); return; }
  const env = { ...process.env, CODEX_HOME: codexHome, HOME: home, USERPROFILE: home, ZCODE_PATH: fakeZCode, FAKE_ZCODE_RECORD: zcodeRecord, FAKE_ZCODE_CONVERSATION_PROGRESS: '1', FAKE_ZCODE_GATE_RESULT: 'ZCODE_RESCUE_PUBLIC_SENTINEL_7C9C', PATH: process.env.PATH ?? '' };
  const auth = await codex(['login', 'status'], temporary, env, 30_000); if (auth.code !== 0) { markUnqualified(t, unqualified('auth-required', 'The isolated Codex home is not authenticated.')); return; }
  await buildMarketplaceSnapshot({ root, output: marketplace, sourceRef: 'qualified-rescue-e2e', sourceSha: '0'.repeat(40), npmExecPath: process.env.NPM_CLI_JS ?? npmLaunch([]).args[0], env });
  for (const args of [['plugin', 'marketplace', 'add', marketplace, '--json'], ['plugin', 'add', 'zcode@vitry', '--json']]) { const result = await codex(args, temporary, env); assert.equal(result.code, 0, result.stderr || result.stdout); }
  const installedPluginRoot = await findInstalledPluginRoot(codexHome);
  await git(['init', '-q'], workspace); await writeFile(join(workspace, 'tracked.txt'), 'base\n'); await git(['add', 'tracked.txt'], workspace); await git(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'base'], workspace); await writeFile(join(workspace, 'tracked.txt'), 'changed\n');
  const commonArgs = ['exec', '--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', '--dangerously-bypass-hook-trust', '--enable', 'hooks', '-c', 'shell_environment_policy.inherit=all', '-C', workspace];
  let setupReady = false;
  for (let attempt = 0; attempt < 4 && !setupReady; attempt += 1) {
    const setup = await codex([...commonArgs, 'Use the installed $zcode:setup skill exactly once now. Return only its public output.'], workspace, env, 180_000);
    if (skipExternalFailure(t, setup)) return;
    assert.equal(setup.code, 0, `codex setup failed\n${setup.stdout}\n${setup.stderr}`);
    setupReady = /status\\?"?\s*:\s*\\?"ready\\?"/.test(setup.stdout);
  }
  assert.equal(setupReady, true, 'four successful setup turns did not establish a fresh-session ready Rescue Role');
  await writeFile(zcodeRecord, '');
  const rescue = await codex([...commonArgs, 'Use the installed $zcode:rescue --fresh --wait repair the fixture skill exactly once now. Return only its final public result.'], workspace, env, 240_000);
  if (skipExternalFailure(t, rescue)) return;
  assert.equal(rescue.code, 0, `codex Rescue failed\n${rescue.stdout}\n${rescue.stderr}`);
  const frames = rescue.stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const expectedCommand = `node "${installedPluginRoot}/scripts/zcode-companion.mjs" invoke rescue`;
  const expectedPreflightCommand = `node "${installedPluginRoot}/scripts/zcode-companion.mjs" role-status rescue`;
  const expectedNamedSpawnMessage = 'Run the installed ZCode Rescue forwarder now. Return its public stdout verbatim.';
  const expectedGenericSpawnMessage = `Act only as the installed ZCode Rescue forwarder. In the current workspace run exactly:\n${expectedCommand}\nPreserve stderr and return public stdout verbatim. Do not inspect or modify code independently, interpret results, retry, poll, cancel, choose a pending branch, or request/print/persist authorization material.\nIf that command returned a needs-choice response, stop. Only after the parent sends exactly \`Continue the pending ZCode Rescue with resume. Run only the installed resume forwarder command and return its public stdout verbatim.\` run exactly:\nnode "${installedPluginRoot}/scripts/zcode-companion.mjs" invoke-choice rescue resume\nOnly after the parent sends exactly \`Continue the pending ZCode Rescue with fresh. Run only the installed fresh forwarder command and return its public stdout verbatim.\` run exactly:\nnode "${installedPluginRoot}/scripts/zcode-companion.mjs" invoke-choice rescue fresh`;
  const canonicalWorkspace = await realpath(workspace);
  const zcodeCalls = (await readFile(zcodeRecord, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  assert.equal(zcodeCalls.filter((call) => call.method === 'session/send').length, 1, 'one ZCode send after one native child spawn');
  try {
    const evidence = qualifyCodexRescueEvidence(
      { execFrames: frames, rollouts: await loadCodexRollouts(codexHome) },
      {
        expectedTaskName: 'zcode_rescue',
        expectedAgentPath: '/root/zcode_rescue',
        expectedAgentType: 'zcode-rescue',
        expectedWorkspace: canonicalWorkspace,
        expectedCommand,
        expectedPreflightCommand,
        expectedNamedSpawnMessage,
        expectedGenericSpawnMessage,
        expectedPublicOutput: 'ZCODE_RESCUE_PUBLIC_SENTINEL_7C9C',
        forbiddenParentText: [
          'Running command: npm test.',
          'Command completed: npm test (25ms).',
          'raw output must stay private',
          'reasoning must stay private',
          'capability must stay private',
          'v4/conversation/frame',
        ],
      },
    );
    assert.ok(['named', 'generic-schema-hidden'].includes(evidence.route), 'qualification must record an automatically observed native route');
    t.diagnostic(`qualified native Rescue route: ${evidence.route}`);
  } catch (error) {
    if (error instanceof CodexRescueUnqualifiedError && error.code === 'spawn-message-encrypted') {
      assert.ok(['named', 'generic-schema-hidden'].includes(error.evidence?.route), 'encrypted-message evidence must record the automatically observed native route');
      const detail = `Observed route ${error.evidence.route}. ${error.message}`;
      markUnqualified(t, unqualified(error.code, detail)); return;
    }
    throw error;
  }

  for (const choice of ['resume', 'fresh']) {
    await writeFile(zcodeRecord, '');
    const pending = await codex([...commonArgs, 'Use the installed $zcode:rescue --wait continue repairing the fixture skill exactly once now. If its child returns needs-choice, follow the installed skill, ask once, and stop without choosing.'], workspace, env, 240_000);
    if (skipExternalFailure(t, pending)) return;
    assert.equal(pending.code, 0, `codex pending Rescue failed\n${pending.stdout}\n${pending.stderr}`);
    const pendingFrames = pending.stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    const parentIds = [...new Set(pendingFrames.filter((frame) => frame?.type === 'thread.started').map((frame) => frame.thread_id))];
    assert.equal(parentIds.length, 1, 'pending Rescue must expose exactly one resumable parent thread ID');
    const answer = await codex([
      'exec', 'resume', '--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox',
      '--dangerously-bypass-hook-trust', '--enable', 'hooks', '-c', 'shell_environment_policy.inherit=all',
      parentIds[0], choice,
    ], workspace, env, 240_000);
    if (skipExternalFailure(t, answer)) return;
    assert.equal(answer.code, 0, `codex ${choice} continuation failed\n${answer.stdout}\n${answer.stderr}`);
    const choiceCommand = `node "${installedPluginRoot}/scripts/zcode-companion.mjs" invoke-choice rescue ${choice}`;
    const followupMessage = `Continue the pending ZCode Rescue with ${choice}. Run only the installed ${choice} forwarder command and return its public stdout verbatim.`;
    try {
      const evidence = qualifyCodexRescueChoiceEvidence(
        { rollouts: await loadCodexRollouts(codexHome) },
        {
          expectedChoice: choice,
          expectedParentThreadId: parentIds[0],
          expectedAgentPath: '/root/zcode_rescue',
          expectedAgentType: 'zcode-rescue',
          expectedWorkspace: canonicalWorkspace,
          expectedInitialCommand: expectedCommand,
          expectedNamedSpawnMessage,
          expectedGenericSpawnMessage,
          expectedTaskName: 'zcode_rescue',
          expectedChoiceCommand: choiceCommand,
          expectedFollowupMessage: followupMessage,
          expectedPreflightCommand,
          expectedPublicOutput: 'ZCODE_RESCUE_PUBLIC_SENTINEL_7C9C',
          forbiddenParentText: [
            'Running command: npm test.', 'Command completed: npm test (25ms).', 'raw output must stay private',
            'reasoning must stay private', 'capability must stay private', 'v4/conversation/frame',
          ],
        },
      );
      assert.equal(evidence.choice, choice);
      t.diagnostic(`qualified same-child Rescue ${choice}: ${evidence.childThreadId}`);
    } catch (error) {
      if (error instanceof CodexRescueUnqualifiedError && ['choice-followup-encrypted', 'choice-spawn-encrypted'].includes(error.code)) {
        markUnqualified(t, unqualified(error.code, error.message)); return;
      }
      throw error;
    }
    const choiceCalls = (await readFile(zcodeRecord, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
    assert.equal(choiceCalls.filter((call) => call.method === 'session/send').length, 1, `${choice} choice must execute exactly one ZCode turn`);
  }

  await writeFile(zcodeRecord, '');
  const backgroundGate = join(temporary, 'background-completion.gate'); const backgroundGateReached = join(temporary, 'background-completion.reached');
  const backgroundDataRoot = join(codexHome, 'plugins', 'data', 'zcode-vitry'); const backgroundStorage = await resolveWorkspaceStorage({ dataRoot: backgroundDataRoot, workspace: canonicalWorkspace });
  const backgroundJobsDirectory = join(backgroundStorage.directory, 'jobs'); const baselineJobIds = await canonicalJobIds(backgroundJobsDirectory);
  await writeFile(backgroundGate, 'hold'); let backgroundIdentity; let backgroundJobId; let backgroundJobPath;
  preserveTemporary = true;
  try {
    const background = await codex([...commonArgs, 'Use the installed $zcode:rescue --fresh --background repair the fixture in background skill exactly once now. Return only its public queued result.'], workspace, { ...env, FAKE_ZCODE_COMPLETION_GATE: backgroundGate, FAKE_ZCODE_COMPLETION_GATE_REACHED: backgroundGateReached, FAKE_ZCODE_COMPLETION_GATE_REACHED_DELAY_MS: '100' }, 240_000);
    backgroundJobId = /Reserved background job ([a-f0-9]{64})\./.exec(background.stdout)?.[1];
    if (backgroundJobId && !baselineJobIds.has(backgroundJobId)) backgroundJobPath = join(backgroundJobsDirectory, `${backgroundJobId}.json`);
    if (skipExternalFailure(t, background)) return;
    assert.equal(background.code, 0, `codex background Rescue failed\n${background.stdout}\n${background.stderr}`);
    const jobId = backgroundJobId;
    assert.ok(jobId, 'native Rescue child must return one canonical public queued job ID');
    assert.equal(baselineJobIds.has(jobId), false, 'background stdout must identify a job created by this exact invocation');
    const jobPath = backgroundJobPath;
    assert.ok(jobPath, 'the exact invocation job path must be derived from its canonical public ID');
    let job = await waitForValue(() => readExactJob(jobPath, jobId), 30_000, 'exact installed background job record was not found');
    backgroundIdentity = exactWorkerIdentity(job);
    await waitUntil(async () => await readFile(backgroundGateReached, 'utf8').catch(() => '') === 'blocked', 5_000, 'background worker did not reach the explicit post-ack completion gate');
    assert.equal(job.status, 'running'); assert.equal(await exactWorkerLeaseAvailable(backgroundDataRoot, canonicalWorkspace, jobId, backgroundIdentity.workerLeaseId), false);
    const backgroundFrames = background.stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    try {
      const evidence = qualifyCodexRescueBackgroundEvidence(
        { execFrames: backgroundFrames, rollouts: await loadCodexRollouts(codexHome) },
        {
          expectedJobId: jobId,
          expectedTaskName: 'zcode_rescue', expectedAgentPath: '/root/zcode_rescue', expectedAgentType: 'zcode-rescue', expectedWorkspace: canonicalWorkspace,
          expectedCommand, expectedPreflightCommand, expectedNamedSpawnMessage, expectedGenericSpawnMessage,
          publicLogs: [background.stdout, background.stderr],
          forbiddenParentText: ['Running command: npm test.', 'Command completed: npm test (25ms).', 'raw output must stay private', 'reasoning must stay private', 'capability must stay private', 'v4/conversation/frame'],
        },
      );
      assert.equal(evidence.jobId, jobId); assert.ok(['named', 'generic-schema-hidden'].includes(evidence.route));
    } catch (error) {
      if (error instanceof CodexRescueUnqualifiedError && error.code === 'spawn-message-encrypted') { markUnqualified(t, unqualified(error.code, error.message)); return; }
      throw error;
    }
    await writeFile(backgroundGate, 'release');
    await waitUntil(async () => { job = await readExactJob(jobPath, jobId); return job?.status === 'succeeded' && await exactWorkerLeaseAvailable(backgroundDataRoot, canonicalWorkspace, jobId, backgroundIdentity.workerLeaseId); }, 30_000, 'exact background job or detached worker did not reach terminal cleanup');
    assert.ok(typeof job.resultArtifact === 'string' && job.resultArtifact.length > 0, 'terminal background job must retain its result artifact');
    const result = await readFile(join(dirname(dirname(jobPath)), job.resultArtifact), 'utf8');
    assert.equal(result, 'ZCODE_RESCUE_PUBLIC_SENTINEL_7C9C'); assert.doesNotMatch(result, new RegExp(`${escapeRegExp(backgroundGate)}|${escapeRegExp(backgroundGateReached)}`));
    const backgroundCalls = (await readFile(zcodeRecord, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
    assert.equal(backgroundCalls.filter((call) => call.method === 'session/send').length, 1, 'background Rescue must execute exactly one ZCode turn');
  } finally {
    await writeFile(backgroundGate, 'release').catch(() => {});
    const discovered = await discoverNewJobIds(backgroundJobsDirectory, baselineJobIds, 2_000);
    for (const jobId of discovered) await cleanupExactJobNaturally(backgroundDataRoot, canonicalWorkspace, join(backgroundJobsDirectory, `${jobId}.json`), jobId, jobId === backgroundJobId ? backgroundIdentity : undefined);
    assert.ok(discovered.length <= 1, `background invocation created ${discovered.length} jobs instead of at most one`);
    if (backgroundJobId) assert.deepEqual(discovered, [backgroundJobId], 'public background job ID must match the exact newly created durable job');
    if (backgroundJobId && discovered.length === 1) preserveTemporary = false;
  }
});

async function codex(args, cwd, env, timeoutMs = 60_000) { return runProcess(codexLaunch(args, { root, env }), { cwd, env, timeoutMs, maxOutputBytes: 16 * 1024 * 1024 }); }
async function git(args, cwd) { const result = await runProcess({ command: 'git', args, options: { shell: false } }, { cwd, timeoutMs: 30_000 }); assert.equal(result.code, 0, result.stderr); }
async function waitUntil(predicate, timeoutMs, message) { const deadline = Date.now() + timeoutMs; while (Date.now() < deadline) { if (await predicate()) return; await new Promise((resolve) => setTimeout(resolve, 50)); } assert.fail(message); }
async function waitForValue(read, timeoutMs, message) { let value; await waitUntil(async () => { value = await read(); return value !== undefined; }, timeoutMs, message); return value; }
async function canonicalJobIds(jobsDirectory) { try { return new Set((await readdir(jobsDirectory, { withFileTypes: true })).filter((entry) => entry.isFile() && /^[a-f0-9]{64}\.json$/u.test(entry.name)).map((entry) => entry.name.slice(0, -5))); } catch (error) { if (error?.code === 'ENOENT') return new Set(); throw error; } }
async function discoverNewJobIds(jobsDirectory, baselineJobIds, timeoutMs) { const deadline = Date.now() + timeoutMs; let discovered = []; do { discovered = [...await canonicalJobIds(jobsDirectory)].filter((jobId) => !baselineJobIds.has(jobId)); if (discovered.length > 0) break; await new Promise((resolve) => setTimeout(resolve, 50)); } while (Date.now() < deadline); return discovered.sort(); }
async function readExactJob(jobPath, jobId) { try { const job = JSON.parse(await readFile(jobPath, 'utf8')); return job?.id === jobId ? job : undefined; } catch { return undefined; } }
function exactWorkerIdentity(job) { assert.ok(Number.isSafeInteger(job?.childPid) && job.childPid > 0); assert.ok(typeof job.workerLeaseId === 'string' && /^[a-f0-9]{64}$/u.test(job.workerLeaseId)); return { pid: job.childPid, workerLeaseId: job.workerLeaseId }; }
async function exactWorkerLeaseAvailable(dataRoot, workspace, jobId, workerLeaseId) { try { await withWorkerLease({ dataRoot, workspace, jobId, workerLeaseId, timeoutMs: 0 }, async () => {}); return true; } catch (error) { if (error?.code === 'LOCK_TIMEOUT') return false; throw error; } }
async function cleanupExactJobNaturally(dataRoot, workspace, jobPath, jobId, identity) { let job = await waitForValue(() => readExactJob(jobPath, jobId), 2_000, 'exact background job was not persisted before teardown'); const exact = identity ?? (job.workerLeaseId ? exactWorkerIdentity(job) : null); await waitUntil(async () => { job = await readExactJob(jobPath, jobId); return job && ['succeeded', 'failed', 'cancelled'].includes(job.status) && (!exact || job.workerLeaseId === exact.workerLeaseId && await exactWorkerLeaseAvailable(dataRoot, workspace, jobId, exact.workerLeaseId)); }, 30_000, `exact background job ${jobId} did not naturally reach terminal state and release its worker lease`); }
function escapeRegExp(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function unqualified(code, detail) { return `codex-skills-unqualified ${JSON.stringify({ qualified: false, code, detail })}`; }
function markUnqualified(t, message) { if (qualificationRequired) assert.fail(message); t.skip(message); }
function skipExternalFailure(t, result) {
  const output = `${result.stdout}\n${result.stderr}`;
  if (result.code !== 0 && /unauthorized|authentication|not logged in|login required|\b401\b/i.test(output)) { markUnqualified(t, unqualified('auth-required', 'Codex authentication expired or was rejected.')); return true; }
  if (result.code !== 0 && /credit|usage limit|quota|rate.?limit|insufficient/i.test(output)) { markUnqualified(t, unqualified('credits-unavailable', 'The authenticated account has no credits available for qualification.')); return true; }
  return false;
}

async function findInstalledPluginRoot(codexHome) {
  const cacheRoot = join(codexHome, 'plugins', 'cache', 'vitry', 'zcode');
  const entries = await readdir(cacheRoot, { withFileTypes: true });
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = join(cacheRoot, entry.name);
    try { await stat(join(candidate, 'skills', 'rescue', 'SKILL.md')); candidates.push(await realpath(candidate)); } catch { continue; }
  }
  assert.equal(candidates.length, 1, 'isolated Codex home must contain exactly one installed ZCode plugin root');
  return candidates[0];
}

async function loadCodexRollouts(codexHome) {
  const pending = [{ path: join(codexHome, 'sessions'), depth: 0 }];
  const files = [];
  while (pending.length > 0) {
    const current = pending.pop();
    let entries;
    try { entries = await readdir(current.path, { withFileTypes: true }); }
    catch (error) { throw new CodexRescueEvidenceMismatchError('rollouts-unavailable', `Codex session rollouts are unavailable: ${error.code ?? 'read-failed'}.`); }
    for (const entry of entries) {
      const path = join(current.path, entry.name);
      if (entry.isDirectory() && current.depth < 6) pending.push({ path, depth: current.depth + 1 });
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(path);
      if (files.length > 64 || pending.length > 256) throw new CodexRescueEvidenceMismatchError('rollouts-overflow', 'Codex rollout discovery exceeded its qualification bound.');
    }
  }
  if (files.length === 0) throw new CodexRescueEvidenceMismatchError('rollouts-unavailable', 'Codex produced no persisted rollout files.');
  return Promise.all(files.map(async (path) => {
    const metadata = await stat(path);
    if (metadata.size > 16 * 1024 * 1024) throw new CodexRescueEvidenceMismatchError('rollout-file-oversize', 'A Codex rollout exceeds the qualification bound.');
    return parseCodexRolloutJsonl(await readFile(path, 'utf8'));
  }));
}
