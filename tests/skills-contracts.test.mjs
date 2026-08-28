// @ts-nocheck
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  assertExactChildContinuationContract,
  assertRescueLauncherGate,
  assertRescueRouteContract,
  expectedGenericRescueMessage,
  expectedNamedRescueMessage,
} from './helpers/rescue-skill-contract.mjs';

const root = new URL('../', import.meta.url);
const rootPath = fileURLToPath(root);
const expected = ['adversarial-review', 'cancel', 'rescue', 'result', 'review', 'setup', 'status', 'transfer'];
const hints = {
  review: '[--wait | --background] [--base <git-ref>] [--scope auto|working-tree|branch]',
  'adversarial-review': '[--wait | --background] [--base <git-ref>] [--scope auto|working-tree|branch] [review focus...]',
  rescue: '[--background | --wait] [--resume | --fresh] [--model <provider/model|alias>] [--effort none|minimal|low|medium|high|xhigh] <task...>',
  transfer: '[--source <codex-thread-id>]',
  status: '[job-id] [--wait] [--timeout-ms <milliseconds>] [--all]',
  result: '[job-id]',
  cancel: '[job-id]',
  setup: '[--enable-review-gate | --disable-review-gate]',
};
const directJobSkillContracts = {
  status: {
    usage: 'Invoke as `$zcode:status [job-id] [--wait] [--timeout-ms <milliseconds>] [--all]`. Require an explicit job ID with `--wait`; accept a timeout only with `--wait`. The native prompt hook has already recorded the exact arguments.',
    invocation: 'Resolve the plugin root as the directory two directories above this `SKILL.md`; use its absolute canonical plugin root. With the available terminal tool, run exactly the constant command `node "<plugin-root>/scripts/zcode-companion.mjs" invoke status` over ordinary stdio. Do not add arguments, job IDs, credentials, or private descriptors.',
  },
  result: {
    usage: 'Invoke as `$zcode:result [job-id]`; without an ID, allow the companion to select the latest eligible owned job. The native prompt hook has already recorded the exact arguments.',
    invocation: 'Resolve the plugin root as the directory two directories above this `SKILL.md`; use its absolute canonical plugin root. With the available terminal tool, run exactly the constant command `node "<plugin-root>/scripts/zcode-companion.mjs" invoke result` over ordinary stdio. Do not add arguments, job IDs, credentials, or private descriptors.',
  },
  cancel: {
    usage: 'Invoke as `$zcode:cancel [job-id]`; without an ID, allow the companion to select the latest eligible owned job. The native prompt hook has already recorded the exact arguments.',
    invocation: 'Resolve the plugin root as the directory two directories above this `SKILL.md`; use its absolute canonical plugin root. With the available terminal tool, run exactly the constant command `node "<plugin-root>/scripts/zcode-companion.mjs" invoke cancel` over ordinary stdio. Do not add arguments, job IDs, credentials, or private descriptors.',
  },
};
const directJobPartitionContract = 'Invocation from either the eligible origin workspace or its exact bound execution target resolves to the same selected target partition, which the companion preserves privately across later turns as the one lifecycle-authoritative current job partition. Never scan or merge workspace partitions. An explicit job ID cannot cross-partition or expand owner authority.';
function skill(name) {
  return readFileSync(new URL(`skills/${name}/SKILL.md`, root), 'utf8');
}

function assertDirectJobSkillPublicContract(source, name) {
  const contract = directJobSkillContracts[name];
  const lines = source.split('\n');
  assert.deepEqual(lines.filter((line) => line.startsWith('Invoke as ')), [contract.usage]);
  assert.deepEqual(lines.filter((line) => line.includes('run exactly the constant command')), [contract.invocation]);
}

function assertRescueNamingContract(source) {
  const { naming } = assertRescueRouteContract(source);
  const namingText = naming.text;
  assert.match(namingText, /prepared[^\n]+route[^\n]+action[^\n]+followup[\s\S]+exact[^\n]+target/i);
  assert.match(namingText, /prepared[^\n]+route[^\n]+action[^\n]+spawn[\s\S]+exact[^\n]+taskName/i);
  assert.match(namingText, /malformed[^\n]+extra key[^\n]+wrong action[^\n]+unsafe[^\n]+path[^\n]+invalid assignment[^\n]+invalid task name/i);
  assert.match(namingText, /exactly one child-producing activation/i);
  assert.match(namingText, /must not[^\n]+collision[^\n]+fallback/i);
  assert.match(namingText, /version 2[^\n]+follow-up route[\s\S]+exact task-free `assignment`/i);
  assert.match(namingText, /`zcode-rescue`[^\n]+named assignment[\s\S]+`default`[^\n]+complete fixed generic message/i);
  assert.match(namingText, /missing[^\n]+ambiguous[^\n]+mismatched[^\n]+unknown assignment[^\n]+fail closed/i);
  assert.match(namingText, /do not consult retained historical spawn provenance/i);
  assert.doesNotMatch(namingText, /Root chooses[^\n]+rescueTaskName/i);
}

function assertRescueSpawnContracts(source) {
  const { namedSpawn, genericMessage } = assertRescueRouteContract(source);
  const namedMessages = [...namedSpawn.text.matchAll(/\bmessage:\s*'([^'\n]*)'/g)].map((match) => match[1]);
  assert.deepEqual(namedMessages, [expectedNamedRescueMessage]);
  assert.equal(genericMessage.text, expectedGenericRescueMessage);
}

test('ships exactly the eight namespaced ZCode skills', () => {
  assert.deepEqual(readdirSync(new URL('skills/', root), { withFileTypes: true })
    .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort(), expected);
  for (const name of expected) {
    const source = skill(name).replaceAll('\r\n', '\n');
    assert.match(source, new RegExp(`^---\\nname: ${name}\\n`));
    assert.match(source, /^description: Use when /m);
    assert.match(source, new RegExp(`\\$zcode:${name.replace('-', '\\-')}`));
    assert.match(source, new RegExp(hints[name].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.equal(existsSync(new URL(`skills/${name}/agents/openai.yaml`, root)), true);
  }
});

test('setup documents one-run Role reconciliation without owning host spawn metadata', () => {
  const source = skill('setup');
  assert.match(source, /one setup|one `?\$zcode:setup/i);
  assert.match(source, /numeric-v1/i);
  assert.match(source, /Codex host.{0,120}owns.{0,120}collaboration tool schema/is);
  assert.match(source, /does not own.{0,120}hide_spawn_agent_metadata/is);
  assert.match(source, /writable.{0,80}root.{0,160}restart-required/is);
  assert.doesNotMatch(source, /Role install.{0,160}(?:restart|required)/is);
  assert.equal(expected.includes('uninstall'), false);
  assert.equal(existsSync(new URL('skills/uninstall/', root)), false);
});

test('skills use their fixed installed entrypoint without exposing private protocols', () => {
  for (const name of expected) {
    const source = skill(name);
    if (name === 'rescue') {
      assertRescueLauncherGate(source);
      assert.match(source, /<rescue-launcher-command> invoke-prepared rescue/);
    } else {
      assert.match(source, /two directories above this `SKILL\.md`/);
      assert.match(source, /absolute canonical plugin root/);
    }
    if (name === 'setup') assert.match(source, /preserve (?:the )?raw argument vector unchanged/i);
    else {
      if (name !== 'rescue') assert.match(source, new RegExp(`scripts/zcode-companion\\.mjs" invoke ${name}`));
      assert.match(source, /available terminal tool/i);
      assert.doesNotMatch(source, /without a shell/i);
      assert.doesNotMatch(source, /raw argument vector|<raw-arguments>|protected descriptor|FD3|FD4/i);
    }
    assert.match(source, /present.*output.*verbatim/is);
    assert.doesNotMatch(source, /session\/(?:create|send|read|resume|stop|list|setModel|setThoughtLevel)|interaction\/requestPermission/);
  }
});

test('direct job Skills preserve one lifecycle-authoritative job partition without changing invocation syntax', () => {
  for (const name of ['status', 'result', 'cancel']) {
    const source = skill(name);
    assert.deepEqual(source.split('\n').filter((line) => line.includes('same selected target partition')), [directJobPartitionContract]);
    assert.throws(() => {
      const split = source.replace('resolves to the same selected target partition', 'may resolve to different partitions');
      assert.deepEqual(split.split('\n').filter((line) => line.includes('same selected target partition')), [directJobPartitionContract]);
    });
    assertDirectJobSkillPublicContract(source, name);

    const { usage, invocation } = directJobSkillContracts[name];
    assert.throws(() => assertDirectJobSkillPublicContract(source.replace(usage, `${usage} --foreign`), name));
    assert.throws(() => assertDirectJobSkillPublicContract(source.replace(invocation, `${invocation} --foreign`), name));
    assert.throws(() => assertDirectJobSkillPublicContract(`${source}\n${usage}\n`, name));
    assert.throws(() => assertDirectJobSkillPublicContract(`${source}\n${invocation}\n`, name));
  }
});

test('public skills enforce authorization and do not expose removed flags', () => {
  for (const name of expected) {
    const source = skill(name);
    assert.doesNotMatch(source, /(?:^|\s)(?:spark|--force|--prompt-file|--write)(?:\s|$|`)/m);
    if (name === 'setup') {
      assert.doesNotMatch(source, /ZCODE_CALLER_CONTEXT|caller-context|caller context/i);
    } else assert.doesNotMatch(source, /ZCODE_CALLER_CONTEXT|caller-context|caller context|execution capability/i);
  }
});

test('review skills are read-only and Rescue is foreground by default', () => {
  for (const name of ['review', 'adversarial-review']) {
    const source = skill(name);
    assert.match(source, /always read-only/i);
    assert.match(source, /do not (?:edit|modify|apply|fix)/i);
  }
  const source = skill('rescue');
  assertRescueLauncherGate(source);
  assert.match(source, /defaults? to foreground/i);
  assert.match(source, /role-status rescue/);
  assertRescueNamingContract(source);
  assertRescueSpawnContracts(source);
  assert.doesNotMatch(source, /task_name:\s*['"]zcode_rescue['"]/);
  assert.match(source, /fork_turns:\s*['"]none['"]/);
  assert.match(source, /agent_type:\s*['"]zcode-rescue['"]/);
  assert.match(source, /Run the installed prepared ZCode Rescue forwarder now\. Return its public stdout verbatim\./);
  assert.match(source, /schema (?:omits|hides|does not expose) `agent_type`/i);
  assert.match(source, /unsupported\/reserved/i);
  assert.match(source, /unknown\/unavailable\/invalid (?:value|Role value) `zcode-rescue`[\s\S]+\$zcode:setup/i);
  assert.match(source, /wait[\s\S]+same child/i);
  assert.doesNotMatch(source, /parent[^\n]{0,120}(?:run|execute)[^\n]{0,120}invoke rescue/i);
});

test('Rescue uses only its machine-bound launcher and treats root diagnostics as terminal', () => {
  const source = skill('rescue');
  const { block } = assertRescueLauncherGate(source);
  assert.doesNotMatch(source, /node\s+"<[^"]*(?:plugin-root|canonical-plugin-root)[^"]*>\/scripts\/zcode-companion\.mjs"/i);
  assert.doesNotMatch(source, /node\s+scripts\/zcode-companion\.mjs/i);
  assert.match(source, /<rescueLauncherCommand> role-status rescue/);
  assert.match(source, /<rescueLauncherCommand> prepare rescue/);
  assert.match(source, /`source-session-unproven`[\s\S]+terminal[\s\S]+exact remedy/i);
  assert.match(source, /`caller-unavailable`[^\n]+active owned parent turn[^\n]+never run setup/i);
  assert.match(source, /`inspection-unavailable`[^\n]+retry Role preflight[^\n]+never prepare, spawn, or mutate setup/i);
  assert.match(source, /managed install\/upgrade\/drift\/conflict\/unsupported[^\n]+fixed `\$zcode:setup` remedy/i);
  const sourceFailure = /`source-session-unproven`[\s\S]+?(?=\n\n|$)/i.exec(source)?.[0] ?? '';
  assert.match(sourceFailure, /(?:do not|never)[^\n]+\$zcode:setup[\s\S]+prepare[\s\S]+follow[ -]?up[\s\S]+spawn/i);
  assert.doesNotMatch(block, /two directories above|<plugin-root>|canonical plugin root/i);
});

test('Rescue directive clauses cannot be relocated outside the preflight-to-route section', () => {
  const source = skill('rescue');
  const section = /Strictly parse the terminal prepared route object[\s\S]+?(?=\nWhen `prepared\.route\.action` is exactly `spawn`)/.exec(source)?.[0];
  assert.ok(section);
  const misplaced = source.replace(section, '').concat(`\n${section}\n`);
  assert.throws(() => assertRescueNamingContract(misplaced));
});

test('Rescue collision safety cannot be relocated outside the directive section', () => {
  const source = skill('rescue');
  const { naming } = assertRescueRouteContract(source);
  const stripped = naming.text.replace(/collision/giu, 'occupied-path');
  const misplaced = `${source.slice(0, naming.start)}${stripped}${source.slice(naming.end)}\nCollision fallback is forbidden.\n`;
  assert.throws(() => assertRescueNamingContract(misplaced));
});

test('Rescue prescribed task names must remain in their own instructions', () => {
  const source = skill('rescue');
  const namedMisplaced = source.replace('  task_name: prepared.route.taskName,', '  task_name: wrongTaskName,').concat('\ntask_name: prepared.route.taskName\n');
  const genericMisplaced = source.replace('with `task_name: prepared.route.taskName`,', 'with `task_name: wrongTaskName`,').concat('\ntask_name: prepared.route.taskName\n');
  assert.throws(() => assertRescueSpawnContracts(namedMisplaced));
  assert.throws(() => assertRescueSpawnContracts(genericMisplaced));
});

test('Rescue fixed messages cannot be repaired by duplicate prose elsewhere', () => {
  const source = skill('rescue');
  const named = 'Run the installed prepared ZCode Rescue forwarder now. Return its public stdout verbatim.';
  const namedMutated = source.replace(`message: '${named}'`, "message: 'Run an altered forwarder.'").concat(`\nmessage: '${named}'\n`);
  const genericLine = 'Preserve stderr and return public stdout verbatim.';
  const genericMutated = source.replace(genericLine, 'Preserve altered output.').concat(`\n${genericLine}\n`);
  assert.throws(() => assertRescueSpawnContracts(namedMutated));
  assert.throws(() => assertRescueSpawnContracts(genericMutated));
});

test('Rescue routing stays single-hop and ordinary subagents fall back transparently', () => {
  const source = skill('rescue');
  const ordinaryGuard = source.indexOf('If you are already an ordinary spawned subagent');
  const readinessPreflight = source.indexOf('role-status rescue');
  const namedSpawn = source.indexOf('spawn_agent({');
  const genericSpawn = source.indexOf('then call `spawn_agent`');
  const ordinaryFallbackRule = source.split('\n').find((line) => line.startsWith('- If you are already an ordinary spawned subagent')) ?? '';
  assert.match(source, /must be invoked by the top-level user-facing Codex agent, not by an ordinary spawned subagent/i);
  assert.match(source, /always collapse `top-level Codex agent -> ordinary subagent -> Rescue subagent` into `top-level Codex agent -> Rescue subagent`/i);
  assert.match(source, /already an ordinary spawned subagent[\s\S]+do not run the readiness preflight[\s\S]+do not spawn another child[\s\S]+do not run any companion command/i);
  assert.match(source, /complete the assigned task yourself using only your existing tools and authorization/i);
  assert.match(source, /final response[\s\S]+ZCode Rescue was not invoked because this task was already running in an ordinary subagent\./i);
  assert.match(ordinaryFallbackRule, /final response[\s\S]+ZCode Rescue was not invoked because this task was already running in an ordinary subagent\.[\s\S]+Parent\/top-level agent:[\s\S]+relay[\s\S]+user-facing final response[\s\S]+verbatim/i);
  assert.match(source, /ordinary subagent reports that exact sentence[\s\S]+top-level agent[\s\S]+user-facing final response[\s\S]+verbatim/i);
  assert.match(source, /never present your work or output as ZCode output/i);
  assert.match(source, /dedicated `zcode-rescue` child[\s\S]+fixed generic compatibility forwarder[\s\S]+exempt from the ordinary-subagent rule/i);
  assert.ok(ordinaryGuard >= 0, 'ordinary-subagent guard must exist');
  for (const [label, position] of [['readiness preflight', readinessPreflight], ['named spawn', namedSpawn], ['generic spawn', genericSpawn]]) {
    assert.ok(position >= 0, `${label} instruction must exist`);
    assert.ok(ordinaryGuard < position, `ordinary-subagent guard must precede ${label}`);
  }
});

test('Root automatic Rescue routing normalizes an explicit or proactive business objective', () => {
  const source = skill('rescue');
  assert.match(source, /literal(?:ly)?[^\n]+`\$zcode:rescue`[^\n]+`explicit`/i);
  assert.match(source, /otherwise[^\n]+(?:automatically|proactively)[^\n]+`proactive`/i);
  assert.match(source, /complete request semantics[\s\S]+non-empty business objective/i);
  assert.match(source, /exclude[\s\S]+host-only[\s\S]+stop[\s\S]+report[\s\S]+review[\s\S]+wait[\s\S]+routing policy/i);
  assert.match(source, /never mechanically (?:slice|take|extract)[^\n]+(?:before|after)[^\n]+marker/i);
  assert.match(source, /no `--auto` flag/i);
});

test('active Rescue child rejoin is the first and exclusive Root action', () => {
  const source = skill('rescue');
  const active = source.indexOf('rescueChildPath');
  const preflight = source.indexOf('role-status rescue');
  const prepare = source.indexOf('prepare rescue');
  const spawn = source.indexOf('spawn_agent({');
  assert.ok(active >= 0 && active < preflight && preflight < prepare && prepare < spawn);
  const activeBlock = source.slice(active, preflight);
  assert.match(activeBlock, /highest priority[\s\S]+(?:rejoin|wait|poll)[\s\S]+exact[^\n]+child/i);
  assert.match(activeBlock, /existing live handle/i);
  assert.match(activeBlock, /Never call `followup_task`/i);
  assert.doesNotMatch(activeBlock, /followup_task\s*\(/i);
  assert.match(source.slice(active, preflight), /(?:must not|never)[\s\S]+preflight[\s\S]+prepare[\s\S]+spawn[\s\S]+invoke/i);
});

test('Root routes active, stopped same-operation, and fresh Rescue child states without session substitution', () => {
  const source = skill('rescue');
  const { block } = assertExactChildContinuationContract(source);
  assert.match(block, /without a second `SubagentStart`|no second `SubagentStart`|does not emit a second `SubagentStart`/i);
  assert.match(block, /reuse[^\n]+`invoke-prepared rescue`/i);
  assert.match(block, /invalid[^\n]+binding[\s\S]+fail closed/i);
  assert.match(block, /permission[^\n]+change[\s\S]+fresh/i);
  assert.match(block, /companion discovers host children[\s\S]+private stopped-executor provenance[\s\S]+exact persisted child/i);
  assert.match(source, /named assignment is exactly `Run the installed prepared ZCode Rescue forwarder now/i);
  assert.match(source, /Preparation authorizes exactly one child-producing activation[^\n]+follow-up[^\n]+spawn[^\n]+never both/i);
});

test('stale spawn-only prose cannot contradict stopped-child continuation', () => {
  const source = skill('rescue');
  for (const stale of [
    'Preparation authorizes exactly one named or generic spawn.',
    'An explicit continuation proceeds through prepare and spawn.',
  ]) {
    assert.throws(() => assertExactChildContinuationContract(`${source}\n${stale}\n`));
  }
});

test('Root prepares exactly one private Rescue envelope before one selected followup or spawn', () => {
  const source = skill('rescue');
  assert.match(source, /<rescueLauncherCommand> prepare rescue/);
  assert.match(source, /raw-capable TTY[\s\S]+setRawMode\(true\)/i);
  assert.match(source, /\{"type":"preparation-input-ready","command":"rescue"\}/);
  assert.match(source, /readiness[\s\S]+nonterminal[\s\S]+only after[\s\S]+write_stdin[\s\S]+exactly one JSON line[\s\S]+LF/i);
  assert.match(source, /(?:do not|never)[^\n]+U\+0004[^\n]+EOF/i);
  assert.match(source, /restore raw mode/i);
  assert.match(source, /non-TTY[\s\S]+raw mode failure[\s\S]+stop[\s\S]+(?:must not|do not|never) spawn/i);
  assert.match(source, /tool output[\s\S]+(?:must not|never)[^\n]+payload/i);
  assert.match(source, /keys are `type`, `command`, and `route`[\s\S]+`type` is `prepared`[\s\S]+`command` is `rescue`/i);
  assert.match(source, /zero exit/i);
  assert.match(source, /(?:signal|failed prepare)[\s\S]+stop[\s\S]+(?:must not|do not|never) spawn/i);
  assert.match(source, /exact version-3 envelope[\s\S]+`version`[\s\S]+`source`[\s\S]+`task`[\s\S]+`options`[\s\S]+`continuationTarget`/i);
  assert.match(source, /new (?:flows|preparations)[^\n]+(?:always )?emit version 3/i);
  assert.match(source, /versions? 1 and 2[^\n]+compatibility/i);
  assert.match(source, /options[\s\S]+`execution`[\s\S]+`resume`[\s\S]+`model`[\s\S]+`effort`/i);
  assert.match(source, /omit[^\n]+absent[^\n]+(?:never|not)[^\n]+null/i);
});

test('Root retains returned task_name and keeps child ID internal', () => {
  const source = skill('rescue');
  assert.match(source, /successful `spawn_agent` call[\s\S]+exact[^\n]+(?:returned|result)[^\n]+`task_name`/i);
  assert.match(source, /returned `task_name`[^\n]+active logical handle[^\n]+canonical continuation path/i);
  assert.doesNotMatch(source, /returned active collaboration handle|rescueChildId/i);
  assert.match(source, /retain[^\n]+unchanged[^\n]+(?:canonical )?(?:agent )?path[\s\S]+stop[\s\S]+restor[\s\S]+follow-up/i);
  assert.match(source, /child ID[^\n]+internal/i);
  assert.doesNotMatch(source, /spawn\.output\.agent_id|started\.event_id/i);
  assert.match(source, /never ask the user for a child ID/i);
  assert.match(source, /(?:must not|never)[^\n]+(?:synthesize|manufacture|derive)[^\n]+(?:agent )?path[^\n]+`taskName`/i);
  assert.match(source, /if[^\n]+intended operation[^\n]+(?:unavailable|ambiguous)|if[^\n]+(?:canonical )?path[^\n]+unavailable/i);
  assert.match(source, /ask[^\n]+user[^\n]+clarif/i);
  assert.match(source, /(?:must not|never)[^\n]+(?:prepare|invoke)[^\n]+(?:guess|without that clarification)/i);
  assert.match(source, /followup_task[\s\S]+prepared\.route\.target/i);
  assert.match(source, /(?:must not|never)[^\n]+follow[^\n]+retained (?:path|target|handle)/i);
});

test('Root never depends on internal activity correlation', () => {
  const source = skill('rescue');
  assert.match(source, /Root[^\n]+does not[^\n]+(?:read|inspect|depend on)[^\n]+(?:internal )?activity/i);
  assert.match(source, /(?:must not|never)[^\n]+(?:guess|derive|synthesize)[^\n]+path[^\n]+`taskName`/i);
  assert.doesNotMatch(source, /started\.(?:event_id|agent_thread_id)|spawn\.(?:output|result)\.agent_id/i);
});

test('new Rescue preparation frames carry only a private exact continuation target', () => {
  const source = skill('rescue');
  assert.match(source, /`continuationTarget`[^\n]+either `null`[^\n]+exact[^\n]+agentPath/i);
  assert.doesNotMatch(source, /`continuationTarget`[^\n]+`childId`/i);
  assert.match(source, /fresh[\s\S]+continuationTarget[^\n]+`null`/i);
  assert.match(source, /exact resume[\s\S]+continuationTarget[^\n]+retained[^\n]+(?:canonical )?path/i);
  assert.match(source, /only[^\n]+single[^\n]+post-readiness[^\n]+`write_stdin`[^\n]+frame/i);
  assert.match(source, /serialized (?:selector|target)[\s\S]+never[\s\S]+argv[\s\S]+environment[\s\S]+assignment[\s\S]+output[\s\S]+child transcript[\s\S]+relay[\s\S]+status[\s\S]+result[\s\S]+ZCode/i);
  const { namedSpawn, genericMessage } = assertRescueRouteContract(source);
  for (const fixture of [namedSpawn.text, genericMessage.text]) assert.doesNotMatch(fixture, /continuationTarget|childId/);
});

test('routing precedence materializes only authoritative fresh or resume choices', () => {
  const source = skill('rescue');
  assert.match(source, /explicit `--fresh` or `--resume`[^\n]+authoritative/i);
  assert.match(source, /explicit request with no choice \(neither `--fresh` nor `--resume`\)/i);
  assert.match(source, /count[^\n]+retained stopped operations[^\n]+(?:could|that) match[^\n]+(?:request|complete request)[^\n]+semantics/i);
  assert.match(source, /zero semantic candidates[\s\S]+fresh[\s\S]+(?:do not|without)[^\n]+ask/i);
  assert.match(source, /one semantic candidate[\s\S]+targetless[\s\S]+same-child `needs-choice`[\s\S]+ask exactly once/i);
  assert.match(source, /explicit[\s\S]+no choice[\s\S]+more than one semantic candidate[\s\S]+ask exactly once[\s\S]+before[\s\S]+prepare[\s\S]+followup[\s\S]+spawn/i);
  assert.match(source, /one answer[\s\S]+(?:both|simultaneously)[\s\S]+operation[\s\S]+`resume` or `fresh`/i);
  assert.match(source, /answer[^\n]+resume[^\n]+exact[^\n]+(?:canonical )?path[\s\S]+answer[^\n]+fresh[^\n]+continuationTarget[^\n]+null/i);
  assert.match(source, /proactive[\s\S]+clear continuation[\s\S]+prepare[\s\S]+`resume`/i);
  assert.match(source, /clear independent[\s\S]+prepare[\s\S]+`fresh`/i);
  assert.match(source, /proactive genuinely ambiguous[\s\S]+ask exactly once[\s\S]+before[\s\S]+prepare[\s\S]+spawn/i);
  assert.doesNotMatch(source, /For a genuinely ambiguous route/i);
  assert.doesNotMatch(source, /no choice \(`--fresh` or `--resume`\)/i);
  assert.doesNotMatch(source, /explicit[\s\S]+no route[\s\S]+omit[^\n]+`resume`/i);
  assert.match(source, /proactive[\s\S]+must include[\s\S]+(?:`fresh` or `resume`|`fresh` or `resume`)/i);
});

test('semantic candidate triage is explicit-only and proactive continuation never falls back to fresh', () => {
  const sources = [skill('rescue')];
  for (const source of sources) {
    assert.match(source, /(?:zero|0)[^\n]+(?:one|1)[^\n]+(?:more than one|>1)[^\n]+(?:triage|branches)[^\n]+(?:only|entirely)[^\n]+explicit no-choice/i);
    assert.match(source, /proactive clear continuation[\s\S]+exact retained canonical path[^\n]+unavailable[^\n]+(?:clarif|fail)[^\n]+never[^\n]+fresh(?:\/null| fallback)?/i);
  }
});

test('targetless choice requires one total stopped operation as well as one semantic candidate', () => {
  const sources = [skill('rescue')];
  for (const source of sources) {
    assert.match(source, /targetless[\s\S]+only when[^\n]+total retained stopped operations[^\n]+(?:exactly|==) one[^\n]+sole semantic candidate/i);
    assert.match(source, /one semantic candidate[^\n]+total retained stopped operations[^\n]+(?:more than one|>1)[\s\S]+asks? exactly once[^\n]+before[^\n]+prepare/i);
    assert.match(source, /(?:resume\s+(?:answer|choice)|(?:answer|choice)[^\n]+resume)[\s\S]+(?:candidate(?:'s)? )?exact retained canonical path[\s\S]+(?:fresh\s+(?:answer|choice)|(?:answer|choice)[^\n]+fresh)[\s\S]+(?:continuationTarget[^\n]+null|null target)/i);
    assert.match(source, /Root[^\n]+(?:does not|never)[^\n]+(?:read|inspect|decide)[^\n]+private binding validity/i);
  }
});

test('private task envelope is confined to the parent write_stdin rollout', () => {
  const source = skill('rescue');
  assert.match(source, /task[\s\S]+source[\s\S]+options[\s\S]+only[\s\S]+parent[^\n]+`write_stdin` payload/i);
  assert.match(source, /never[\s\S]+argv[\s\S]+environment[\s\S]+spawn message[\s\S]+output[\s\S]+relay[\s\S]+status/i);
  const { namedSpawn, genericMessage } = assertRescueRouteContract(source);
  for (const fixture of [namedSpawn.text, genericMessage.text]) {
    assert.doesNotMatch(fixture, /business objective|"task"|"source"|"options"|--auto/);
  }
});

test('Rescue accepts only the plugin-prescribed task-free route after readiness', () => {
  const source = skill('rescue');
  const readiness = source.indexOf('For every other status that is not `ready`');
  const naming = source.indexOf('Strictly parse the terminal prepared route object');
  const namedSpawn = source.indexOf('spawn_agent({');
  assert.ok(readiness >= 0, 'readiness preflight outcome must exist');
  assert.ok(naming > readiness, 'route parsing must follow successful readiness preflight');
  assert.ok(namedSpawn > naming, 'route parsing must precede the prescribed spawn');
});

test('Rescue generic fallback is fixed, fresh, setup-gated, and contains no task or authorization material', () => {
  const source = skill('rescue');
  assert.match(source, /Only after the preflight returned `ready`/);
  assert.match(source, /Act only as the installed ZCode Rescue forwarder\./);
  assert.match(source, /<rescue-launcher-command> invoke-prepared rescue/);
  assert.match(source, /Preserve stderr and return public stdout verbatim\./);
  assert.match(source, /Do not inspect or modify code independently, interpret results, retry, cancel, choose a pending branch, or request\/print\/persist authorization material\./);
  assert.match(source, /never issue a second spawn/i);
  assert.match(source, /unknown\/unrecognized\/unsupported\/reserved (?:field\/key\/parameter|field, key, or parameter) `agent_type`/i);
  assert.match(source, /no agent ID, start event, or activity/i);
  assert.match(source, /unknown\/unavailable\/invalid (?:value|Role value) `zcode-rescue`/i);
  assert.match(source, /timeout[\s\S]+ambiguous[\s\S]+never generic fallback/i);
  assert.match(source, /may have created a child[\s\S]+same child/i);
  assert.match(source, /one prepared `spawn` directive[^\n]+one child-producing activation/i);
  assert.match(source, /pre-child schema rejection[^\n]+schema negotiation[\s\S]+one generic child-producing call/i);
  assert.match(source, /collision[\s\S]+runtime[\s\S]+ambiguity[\s\S]+terminal/i);
  assert.doesNotMatch(source, /If spawning fails[^\n]+no queued job or authorization artifact/i);
  assert.doesNotMatch(source, /spawn[^\n]*(?:task text|job ID|capability|permission snapshot)/i);
});

test('managed Rescue role is a fixed TOML forwarder without capability or task material', () => {
  assert.equal(existsSync(new URL('agents/zcode-rescue.md', root)), false);
  const source = readFileSync(new URL('agents/zcode-rescue.toml.template', root), 'utf8');
  const generic = /```text\n(Act only as the installed ZCode Rescue forwarder\.[\s\S]+?)\n```/.exec(skill('rescue'))?.[1];
  assert.ok(generic);
  for (const name of expected.filter((value) => value !== 'setup')) assert.doesNotMatch(skill(name), /zcode:zcode-rescue|forwarding subagent|one-time execution capability/i);
  assert.match(source, /^developer_instructions = """[\s\S]+"""\n$/);
  assert.equal((source.match(/^developer_instructions\s*=/gm) ?? []).length, 1);
  assert.match(source, /invoke-prepared rescue/);
  assert.match(source, /\{\{RESCUE_LAUNCHER_COMMAND\}\} invoke-prepared rescue/);
  assert.doesNotMatch(source, /node[^\n]+scripts\/zcode-companion\.mjs/);
  assert.match(source, /invoke-choice rescue resume/);
  assert.match(source, /invoke-choice rescue fresh/);
  assert.match(source, /same exact prepared assignment[\s\S]+initial turn[\s\S]+stopped same-child prepared continuation/i);
  assert.match(source, /one-command-per-turn rule applies to both/i);
  assert.doesNotMatch(source, /--prompt-file|--write|spark|--force|\{\{(?:TASK|ARGS|JOB|SESSION|PERMISSION|CAPABILITY)[^}]*\}\}/i);
  assert.match(source, /return public stdout verbatim/i);
  assert.match(source, /preserve stderr/i);
  assert.match(source, /(?:Do not|Never) inspect or modify code independently/i);
  for (const forwarder of [source, generic]) {
    assert.match(forwarder, /task-blind/i);
    assert.match(forwarder, /capability-free/i);
  }
});

test('named and generic Rescue forwarders keep yielded executions attached through a real exit code', () => {
  const role = readFileSync(new URL('agents/zcode-rescue.toml.template', root), 'utf8');
  const source = skill('rescue');
  const generic = /```text\n(Act only as the installed ZCode Rescue forwarder\.[\s\S]+?)\n```/.exec(source)?.[1];
  assert.ok(generic, 'generic forwarder fixture must be present');
  for (const forwarder of [role, generic]) {
    assert.match(forwarder, /result containing an exit code is terminal/i);
    assert.match(forwarder, /running execution or session handle is nonterminal/i);
    assert.match(forwarder, /poll only that same handle with the host continuation tool until it reports an exit code/i);
    assert.match(forwarder, /Partial stdout, stderr, heartbeat text, or an outer code-cell completion is not terminal/i);
    assert.match(forwarder, /needs-choice response with exit code 3 is terminal for the current child turn/i);
    assert.match(forwarder, /each exact assignment and child turn[\s\S]+at most one mapped foreground `exec_command`/i);
    assert.match(forwarder, /same-turn continuation calls only observe[^.]+original running handle/i);
    assert.match(forwarder, /never start concurrent or retry foreground executions for the same assignment/i);
    assert.match(forwarder, /initial needs-choice terminal[\s\S]+next exact parent continuation assignment[\s\S]+one new exact `invoke-choice` foreground handle/i);
    assert.match(forwarder, /(?:do not|never)[^.]*retry/i);
    assert.match(forwarder, /(?:do not|never)[^.]*cancel/i);
    assert.match(forwarder, /(?:do not|never)[^.]*choose/i);
    assert.match(forwarder, /(?:do not|never)[^.]*inspect or modify code independently/i);
  }
});

test('named and generic Rescue forwarders relay only validated coarse liveness and keep status observational', () => {
  const role = readFileSync(new URL('agents/zcode-rescue.toml.template', root), 'utf8');
  const source = skill('rescue');
  const generic = /```text\n(Act only as the installed ZCode Rescue forwarder\.[\s\S]+?)\n```/.exec(source)?.[1];
  assert.ok(generic, 'generic forwarder fixture must be present');
  for (const forwarder of [role, generic]) {
    assert.match(forwarder, /parse only complete dedicated `?\[zcode-relay\]`? lines/i);
    assert.match(forwarder, /exact keys[\s\S]+version[\s\S]+sequence[\s\S]+phase[\s\S]+code[\s\S]+observedAt/i);
    assert.match(forwarder, /strictly increasing sequence/i);
    assert.match(forwarder, /phase\/code pairs are exactly[\s\S]+`starting`\s*\/\s*`started`[\s\S]+`running`\s*\/\s*`model-active`[\s\S]+`investigating`\s*\/\s*`tool-active`[\s\S]+`finalizing`\s*\/\s*`finalizing`/i);
    assert.match(forwarder, /send_message[\s\S]+only to (?:the exact target )?`?\/root`?/i);
    assert.match(forwarder, /fixed (?:allowlisted )?code-to-message map/i);
    assert.match(forwarder, /never relay[\s\S]+detailed `?\[zcode\]`?[\s\S]+stderr[\s\S]+stdout/i);
    assert.match(forwarder, /relay[\s\S]+liveness only[\s\S]+never completion/i);
    assert.match(forwarder, /exact trimmed[\s\S]+`zcode status`[\s\S]+`\$zcode:status`[\s\S]+`\/zcode:status`/i);
    assert.match(forwarder, /invoke-status rescue/);
    assert.match(forwarder, /no arguments/i);
    assert.match(forwarder, /status[\s\S]+does not (?:replace|complete)[\s\S]+original[\s\S]+handle/i);
    assert.match(forwarder, /return only[\s\S]+original[\s\S]+terminal[\s\S]+public stdout/i);
  }
  assert.match(source, /update from the exact `rescueChildPath`[\s\S]+liveness only[\s\S]+wait|rejoin/i);
  assert.match(source, /progress update[\s\S]+never[\s\S]+completion[\s\S]+spawn/i);
});

test('native Rescue forwarders request explicit background through the same capability-free constant invocation', () => {
  const source = skill('rescue'); const role = readFileSync(new URL('agents/zcode-rescue.toml.template', root), 'utf8');
  const generic = /```text\n(Act only as the installed ZCode Rescue forwarder\.[\s\S]+?)\n```/.exec(source)?.[1];
  assert.ok(generic, 'generic forwarder fixture must be present');
  for (const forwarder of [role, generic]) {
    assert.equal(forwarder.match(/invoke-prepared rescue/g)?.length, 1);
    assert.doesNotMatch(forwarder, /run-reserved-job|executionCapability|callerContext|privateInvocation|FD3|FD4|--background/);
  }
  assert.match(source, /before the child starts, the parent must prepare the exact private Rescue envelope/i);
  assert.match(source, /Never place user text, command arguments, job or session identity, permissions, credentials, or authorization material in a process command or agent message\./);
});

test('forwarders treat project command failures as non-authoritative while the ZCode turn is active', () => {
  const source = skill('rescue');
  const role = readFileSync(new URL('agents/zcode-rescue.toml.template', root), 'utf8');
  const generic = /```text\n(Act only as the installed ZCode Rescue forwarder\.[\s\S]+?)\n```/.exec(source)?.[1];
  assert.ok(generic);
  for (const forwarder of [role, generic]) {
    assert.match(forwarder, /project tool, test, build, lint[\s\S]+failure[\s\S]+not a Rescue failure/i);
    assert.match(forwarder, /keep polling[\s\S]+exact original handle/i);
    assert.match(forwarder, /only[\s\S]+companion[\s\S]+ZCode[\s\S]+terminal result[\s\S]+authoritative/i);
    assert.match(forwarder, /do not hard-code project commands or parse their output/i);
  }
});

test('Rescue choice continuation reuses one child with exact fixed messages and commands', () => {
  const source = skill('rescue');
  const role = readFileSync(new URL('agents/zcode-rescue.toml.template', root), 'utf8');
  const resume = 'Continue the pending ZCode Rescue with resume. Run only the installed resume forwarder command and return its public stdout verbatim.';
  const fresh = 'Continue the pending ZCode Rescue with fresh. Run only the installed fresh forwarder command and return its public stdout verbatim.';
  for (const message of [resume, fresh]) {
    assert.equal(source.split(message).length - 1, 2, `parent and generic child fixture must contain only the exact continuation: ${message}`);
    assert.equal(role.split(message).length - 1, 1, `Role must accept the exact continuation once: ${message}`);
  }
  assert.match(source, /ask the user exactly once/i);
  assert.match(source, /resume[\s\S]+same-child choice continuation/i);
  assert.match(source, /followup_task\(\{\s*target:\s*rescueChildPath,\s*message:\s*continuationMessage,?\s*\}\)/s);
  assert.match(source, /wait_agent\(\{\s*timeout_ms:\s*30000\s*\}\)/);
  assert.match(source, /select only the result or status belonging to `rescueChildPath`/);
  assert.match(source, /timeout[\s\S]+early return[\s\S]+steering[\s\S]+same `rescueChildPath`/i);
  assert.doesNotMatch(source, /followup_task\([\s\S]{0,160}(?:spawn_agent|invoke rescue)/);
  assert.match(role, new RegExp(`${escapeRegExp(resume)}[\\s\\S]+invoke-choice rescue resume`));
  assert.match(role, new RegExp(`${escapeRegExp(fresh)}[\\s\\S]+invoke-choice rescue fresh`));
  assert.match(role, /return a `needs-choice` response byte-for-byte and stop without selecting/i);
  const generic = /```text\n(Act only as the installed ZCode Rescue forwarder\.[\s\S]+?)\n```/.exec(source)?.[1];
  assert.ok(generic, 'generic forwarder fixture must be present');
  for (const fixture of [role, generic]) {
    assert.match(fixture, new RegExp(`${escapeRegExp(resume)}[\\s\\S]+invoke-choice rescue resume`));
    assert.match(fixture, new RegExp(`${escapeRegExp(fresh)}[\\s\\S]+invoke-choice rescue fresh`));
  }
  assert.match(source, /`parent-replan`[\s\S]+parent[\s\S]+prepare[\s\S]+new[\s\S]+spawn/i);
  assert.match(source, /fresh[\s\S]+old child[\s\S]+no ZCode|old child[\s\S]+no ZCode[\s\S]+fresh/i);
  assert.doesNotMatch(source, /Present success stdout verbatim[\s\S]+never recover by spawning or executing again\./i);
});

test('fresh Rescue routing treats every persisted child as occupancy and always prescribes a new child', () => {
  const source = skill('rescue');
  assert.match(source, /Fresh or independent operation[\s\S]+all existing[\s\S]+occupied[\s\S]+collision-free[\s\S]+spawn/i);
  assert.match(source, /never[\s\S]+follow[\s\S]+reactivate[\s\S]+adopt[\s\S]+existing/i);
  assert.doesNotMatch(source, /companion may reactivate and follow up a qualified stopped Rescue child/i);
  assert.doesNotMatch(source, /prefers the managed base child/i);
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test('agents metadata uses quoted strings and namespaced default prompts', () => {
  for (const name of expected) {
    const yaml = readFileSync(new URL(`skills/${name}/agents/openai.yaml`, root), 'utf8');
    const short = yaml.match(/^ {2}short_description: "([^"]+)"$/m)?.[1];
    assert.ok(short && short.length >= 25 && short.length <= 64, `${name} short_description length`);
    assert.match(yaml, /^ {2}display_name: "[^"]+"$/m);
    assert.match(yaml, new RegExp(`^ {2}default_prompt: ".*\\$zcode:${name.replace('-', '\\-')}.*"$`, 'm'));
    assert.doesNotMatch(yaml, /^\s+[^#\n:]+:\s+[^"\n][^\n]*$/m);
  }
});

test('contract fixtures are rooted in this checkout', () => {
  assert.equal(isAbsolute(rootPath), true);
  assert.equal(existsSync(new URL('package.json', root)), true);
});

test('opt-in installed Rescue E2E requires real yielded execution and privacy-safe facts', () => {
  const source = readFileSync(new URL('tests/e2e/codex-skills-e2e.test.mjs', root), 'utf8');
  const installed = /test\('installed Rescue uses one isolated native child[\s\S]+?\n\}\);/.exec(source)?.[0];
  assert.ok(installed, 'opt-in installed native Rescue test must exist');
  assert.match(installed, /FAKE_ZCODE_COMPLETION_GATE/);
  assert.match(installed, /FAKE_ZCODE_COMPLETION_GATE_REACHED/);
  assert.match(installed, /FAKE_ZCODE_PROCESS_FILE/);
  assert.match(installed, /requireYieldedExecution:\s*true/);
  assert.match(installed, /yieldedExecution\.execCommandCount/);
  assert.match(installed, /yieldedExecution\.pollCount/);
  assert.match(installed, /yieldedExecution\.sameHandleChecked/);
  assert.doesNotMatch(installed, /yieldedExecution\.(?:pollHandles|originalHandle)/);
  assert.match(installed, /yieldedExecution\.terminalExitCode/);
  assert.match(installed, /executions\.initial\.execCommandCount/);
  assert.match(installed, /executions\.continuation\.execCommandCount/);
  assert.match(installed, /snapshotFallback:\s*'\[zcode\] ZCode conversation frames were unavailable; using bounded session progress\.'/);
  assert.match(installed, /lifecycleOnly:\s*'\[zcode\] ZCode semantic progress is unavailable; lifecycle updates will continue\.'/);
  const forbiddenBlocks = [...installed.matchAll(/forbiddenParentText:\s*\[([\s\S]*?)\]/g)].map((match) => match[1]);
  assert.ok(forbiddenBlocks.length >= 3, 'installed Rescue must check foreground, choice, and background parent isolation');
  for (const block of forbiddenBlocks) {
    assert.match(block, /ZCode conversation frames were unavailable; using bounded session progress\./);
    assert.match(block, /ZCode semantic progress is unavailable; lifecycle updates will continue\./);
  }
});
