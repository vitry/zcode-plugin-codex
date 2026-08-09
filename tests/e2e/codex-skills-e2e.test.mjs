// @ts-nocheck
import assert from 'node:assert/strict';
import { chmod, cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { buildMarketplaceSnapshot } from '../../scripts/build-marketplace-snapshot.mjs';
import { runProcess } from '../../scripts/lib/process.mjs';
import { codexLaunch, npmLaunch } from '../../scripts/lib/tool-launch.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const fakeZCode = fileURLToPath(new URL('../fixtures/fake-zcode-cli.mjs', import.meta.url));
const optInSkip = process.env.ZCODE_CODEX_SKILLS_E2E === '1' ? false : unqualified('opt-in-required', 'Set ZCODE_CODEX_SKILLS_E2E=1 to spend authenticated Codex credits.');
const rescueOptInSkip = process.env.ZCODE_CODEX_RESCUE_E2E === '1' ? false : unqualified('opt-in-required', 'Set ZCODE_CODEX_RESCUE_E2E=1 to qualify native Rescue routing with authenticated Codex credits.');

test('installed marketplace skill crosses a real ephemeral Codex turn into ZCode', { skip: optInSkip, timeout: 240_000 }, async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), 'zcode-codex-skills-e2e-')); t.after(() => rm(temporary, { recursive: true, force: true }));
  const codexHome = join(temporary, 'codex-home'); const home = join(temporary, 'home'); const marketplace = join(temporary, 'marketplace'); const workspace = join(temporary, 'workspace'); const zcodeRecord = join(temporary, 'zcode.jsonl');
  await Promise.all([mkdir(codexHome, { recursive: true, mode: 0o700 }), mkdir(home, { recursive: true, mode: 0o700 }), mkdir(workspace, { recursive: true }), writeFile(zcodeRecord, '')]);
  const sourceCodexHome = process.env.CODEX_HOME ?? join(homedir(), '.codex');
  try { await stat(join(sourceCodexHome, 'auth.json')); await cp(join(sourceCodexHome, 'auth.json'), join(codexHome, 'auth.json')); await chmod(join(codexHome, 'auth.json'), 0o600); }
  catch { t.skip(unqualified('auth-required', 'No transferable Codex auth.json was found.')); return; }
  const env = { ...process.env, CODEX_HOME: codexHome, HOME: home, USERPROFILE: home, ZCODE_PATH: fakeZCode, FAKE_ZCODE_RECORD: zcodeRecord, PATH: process.env.PATH ?? '' };
  const auth = await codex(['login', 'status'], temporary, env, 30_000); if (auth.code !== 0) { t.skip(unqualified('auth-required', 'The isolated Codex home is not authenticated.')); return; }
  await buildMarketplaceSnapshot({ root, output: marketplace, sourceRef: 'qualified-e2e', sourceSha: '0'.repeat(40), npmExecPath: process.env.NPM_CLI_JS ?? npmLaunch([]).args[0], env });
  for (const args of [['plugin', 'marketplace', 'add', marketplace, '--json'], ['plugin', 'add', 'zcode@vitry', '--json']]) { const result = await codex(args, temporary, env); assert.equal(result.code, 0, result.stderr || result.stdout); }
  await git(['init', '-q'], workspace); await writeFile(join(workspace, 'tracked.txt'), 'base\n'); await git(['add', 'tracked.txt'], workspace); await git(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'base'], workspace); await writeFile(join(workspace, 'tracked.txt'), 'changed\n');
  const prompt = 'Use the installed $zcode:review --wait skill exactly once now. Return only its final result.';
  const result = await codex(['exec', '--ephemeral', '--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', '--dangerously-bypass-hook-trust', '--enable', 'hooks', '-c', 'shell_environment_policy.inherit=all', '-C', workspace, prompt], workspace, env, 180_000);
  const failureOutput = `${result.stdout}\n${result.stderr}`;
  if (result.code !== 0 && /unauthorized|authentication|not logged in|login required|\b401\b/i.test(failureOutput)) { t.skip(unqualified('auth-required', 'Codex authentication expired or was rejected after preflight.')); return; }
  if (result.code !== 0 && /credit|usage limit|quota|rate.?limit|insufficient/i.test(failureOutput)) { t.skip(unqualified('credits-unavailable', 'The authenticated account has no credits available for this qualification run.')); return; }
  assert.equal(result.code, 0, `codex exec failed\n${result.stdout}\n${result.stderr}`);
  const frames = result.stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)); assert.ok(frames.length > 0, 'codex exec --json must emit events');
  const zcodeCalls = (await readFile(zcodeRecord, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  assert.ok(zcodeCalls.some((call) => call.method === 'session/send'), 'installed hook plus direct companion must reach ZCode');
});

test('installed Rescue uses one isolated native child and returns its public stdout', { skip: rescueOptInSkip, timeout: 600_000 }, async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), 'zcode-codex-rescue-e2e-')); t.after(() => rm(temporary, { recursive: true, force: true }));
  const codexHome = join(temporary, 'codex-home'); const home = join(temporary, 'home'); const marketplace = join(temporary, 'marketplace'); const workspace = join(temporary, 'workspace'); const zcodeRecord = join(temporary, 'zcode.jsonl');
  await Promise.all([mkdir(codexHome, { recursive: true, mode: 0o700 }), mkdir(home, { recursive: true, mode: 0o700 }), mkdir(workspace, { recursive: true }), writeFile(zcodeRecord, '')]);
  const sourceCodexHome = process.env.CODEX_HOME ?? join(homedir(), '.codex');
  try { await stat(join(sourceCodexHome, 'auth.json')); await cp(join(sourceCodexHome, 'auth.json'), join(codexHome, 'auth.json')); await chmod(join(codexHome, 'auth.json'), 0o600); }
  catch { t.skip(unqualified('auth-required', 'No transferable Codex auth.json was found.')); return; }
  const env = { ...process.env, CODEX_HOME: codexHome, HOME: home, USERPROFILE: home, ZCODE_PATH: fakeZCode, FAKE_ZCODE_RECORD: zcodeRecord, FAKE_ZCODE_CONVERSATION_PROGRESS: '1', PATH: process.env.PATH ?? '' };
  const auth = await codex(['login', 'status'], temporary, env, 30_000); if (auth.code !== 0) { t.skip(unqualified('auth-required', 'The isolated Codex home is not authenticated.')); return; }
  await buildMarketplaceSnapshot({ root, output: marketplace, sourceRef: 'qualified-rescue-e2e', sourceSha: '0'.repeat(40), npmExecPath: process.env.NPM_CLI_JS ?? npmLaunch([]).args[0], env });
  for (const args of [['plugin', 'marketplace', 'add', marketplace, '--json'], ['plugin', 'add', 'zcode@vitry', '--json']]) { const result = await codex(args, temporary, env); assert.equal(result.code, 0, result.stderr || result.stdout); }
  await git(['init', '-q'], workspace); await writeFile(join(workspace, 'tracked.txt'), 'base\n'); await git(['add', 'tracked.txt'], workspace); await git(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'base'], workspace); await writeFile(join(workspace, 'tracked.txt'), 'changed\n');
  const commonArgs = ['exec', '--ephemeral', '--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', '--dangerously-bypass-hook-trust', '--enable', 'hooks', '-c', 'shell_environment_policy.inherit=all', '-C', workspace];
  let setupReady = false;
  for (let attempt = 0; attempt < 4 && !setupReady; attempt += 1) {
    const setup = await codex([...commonArgs, 'Use the installed $zcode:setup skill exactly once now. Return only its public output.'], workspace, env, 180_000);
    if (skipExternalFailure(t, setup)) return;
    assert.equal(setup.code, 0, `codex setup failed\n${setup.stdout}\n${setup.stderr}`);
    setupReady = /status\\?"?\s*:\s*\\?"ready\\?"/.test(setup.stdout);
  }
  if (!setupReady) { t.skip(unqualified('setup-observation-unavailable', 'The real Codex transcript did not prove a fresh-session ready Role within four setup turns.')); return; }
  await writeFile(zcodeRecord, '');
  const rescue = await codex([...commonArgs, 'Use the installed $zcode:rescue --fresh --wait repair the fixture skill exactly once now. Return only its final public result.'], workspace, env, 240_000);
  if (skipExternalFailure(t, rescue)) return;
  assert.equal(rescue.code, 0, `codex Rescue failed\n${rescue.stdout}\n${rescue.stderr}`);
  const lines = rescue.stdout.trim().split('\n').filter(Boolean); const frames = lines.map((line) => JSON.parse(line)); const serialized = frames.map((frame) => JSON.stringify(frame));
  const agentOffset = serialized.findIndex((line) => /zcode_rescue|zcode-rescue/.test(line));
  const commandOffset = serialized.findIndex((line) => /scripts\\?\/zcode-companion\.mjs.*invoke rescue/.test(line));
  if (agentOffset < 0 || commandOffset < 0) { t.skip(unqualified('native-agent-observation-unavailable', 'Codex JSON events did not expose both child metadata and the child terminal command.')); return; }
  assert.ok(commandOffset > agentOffset, 'the native child must exist before its constant companion command runs');
  assert.equal(serialized.filter((line) => /scripts\\?\/zcode-companion\.mjs.*invoke rescue/.test(line)).length, 1, 'exactly one child executor command');
  const zcodeCalls = (await readFile(zcodeRecord, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  assert.equal(zcodeCalls.filter((call) => call.method === 'session/send').length, 1, 'one ZCode send after one native child spawn');
  const parentMessages = frames.filter((frame) => /agent_message|item\.completed/.test(String(frame.type)) && !/zcode_rescue|zcode-rescue/.test(JSON.stringify(frame))).map((frame) => JSON.stringify(frame));
  assert.doesNotMatch(parentMessages.join('\n'), /Running command: npm test|raw output must stay private|reasoning must stay private/);
  assert.match(parentMessages.at(-1) ?? '', /done/);
});

async function codex(args, cwd, env, timeoutMs = 60_000) { return runProcess(codexLaunch(args, { root, env }), { cwd, env, timeoutMs, maxOutputBytes: 16 * 1024 * 1024 }); }
async function git(args, cwd) { const result = await runProcess({ command: 'git', args, options: { shell: false } }, { cwd, timeoutMs: 30_000 }); assert.equal(result.code, 0, result.stderr); }
function unqualified(code, detail) { return `codex-skills-unqualified ${JSON.stringify({ qualified: false, code, detail })}`; }
function skipExternalFailure(t, result) {
  const output = `${result.stdout}\n${result.stderr}`;
  if (result.code !== 0 && /unauthorized|authentication|not logged in|login required|\b401\b/i.test(output)) { t.skip(unqualified('auth-required', 'Codex authentication expired or was rejected.')); return true; }
  if (result.code !== 0 && /credit|usage limit|quota|rate.?limit|insufficient/i.test(output)) { t.skip(unqualified('credits-unavailable', 'The authenticated account has no credits available for qualification.')); return true; }
  return false;
}
