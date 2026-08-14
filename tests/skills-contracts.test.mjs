// @ts-nocheck
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

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

function skill(name) {
  return readFileSync(new URL(`skills/${name}/SKILL.md`, root), 'utf8');
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

test('skills resolve the installed plugin root and use constant direct companion commands', () => {
  for (const name of expected) {
    const source = skill(name);
    assert.match(source, /two directories above this `SKILL\.md`/);
    assert.match(source, /absolute canonical plugin root/);
    if (name === 'setup') assert.match(source, /preserve (?:the )?raw argument vector unchanged/i);
    else {
      assert.match(source, new RegExp(`scripts/zcode-companion\\.mjs" invoke ${name}`));
      assert.match(source, /available terminal tool/i);
      assert.doesNotMatch(source, /without a shell/i);
      assert.doesNotMatch(source, /raw argument vector|<raw-arguments>|protected descriptor|FD3|FD4/i);
    }
    assert.match(source, /present.*output.*verbatim/is);
    assert.doesNotMatch(source, /session\/(?:create|send|read|resume|stop|list|setModel|setThoughtLevel)|interaction\/requestPermission/);
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
  assert.match(source, /defaults? to foreground/i);
  assert.match(source, /role-status rescue/);
  assert.match(source, /task_name:\s*['"]zcode_rescue['"]/);
  assert.match(source, /fork_turns:\s*['"]none['"]/);
  assert.match(source, /agent_type:\s*['"]zcode-rescue['"]/);
  assert.match(source, /Run the installed ZCode Rescue forwarder now\. Return its public stdout verbatim\./);
  assert.match(source, /schema (?:omits|hides|does not expose) `agent_type`/i);
  assert.match(source, /unsupported\/reserved/i);
  assert.match(source, /unknown\/unavailable\/invalid (?:value|Role value) `zcode-rescue`[\s\S]+\$zcode:setup/i);
  assert.match(source, /wait[\s\S]+same child/i);
  assert.doesNotMatch(source, /parent[^\n]{0,120}(?:run|execute)[^\n]{0,120}invoke rescue/i);
});

test('Rescue routing stays single-hop and ordinary subagents fall back transparently', () => {
  const source = skill('rescue');
  assert.match(source, /must be invoked by the top-level user-facing Codex agent, not by an ordinary spawned subagent/i);
  assert.match(source, /always collapse `top-level Codex agent -> ordinary subagent -> Rescue subagent` into `top-level Codex agent -> Rescue subagent`/i);
  assert.match(source, /already an ordinary spawned subagent[\s\S]+do not run the readiness preflight[\s\S]+do not spawn another child[\s\S]+do not run any companion command/i);
  assert.match(source, /complete the assigned task yourself using only your existing tools and authorization/i);
  assert.match(source, /final response[\s\S]+ZCode Rescue was not invoked because this task was already running in an ordinary subagent\./i);
  assert.match(source, /never present your work or output as ZCode output/i);
  assert.match(source, /dedicated `zcode-rescue` child[\s\S]+fixed generic compatibility forwarder[\s\S]+exempt from the ordinary-subagent rule/i);
});

test('Rescue generic fallback is fixed, fresh, setup-gated, and contains no task or authorization material', () => {
  const source = skill('rescue');
  assert.match(source, /Only after the preflight returned `ready`/);
  assert.match(source, /Act only as the installed ZCode Rescue forwarder\./);
  assert.match(source, /node "<canonical-plugin-root>\/scripts\/zcode-companion\.mjs" invoke rescue/);
  assert.match(source, /Preserve stderr and return public stdout verbatim\./);
  assert.match(source, /Do not inspect or modify code independently, interpret results, retry, poll, cancel, choose a pending branch, or request\/print\/persist authorization material\./);
  assert.match(source, /never issue a second spawn/i);
  assert.match(source, /unknown\/unrecognized\/unsupported\/reserved (?:field\/key\/parameter|field, key, or parameter) `agent_type`/i);
  assert.match(source, /no agent ID, start event, or activity/i);
  assert.match(source, /unknown\/unavailable\/invalid (?:value|Role value) `zcode-rescue`/i);
  assert.match(source, /timeout[\s\S]+ambiguous[\s\S]+never generic fallback/i);
  assert.match(source, /may have created a child[\s\S]+same child/i);
  assert.doesNotMatch(source, /If spawning fails[^\n]+no queued job or authorization artifact/i);
  assert.doesNotMatch(source, /spawn[^\n]*(?:task text|job ID|capability|permission snapshot)/i);
});

test('managed Rescue role is a fixed TOML forwarder without capability or task material', () => {
  assert.equal(existsSync(new URL('agents/zcode-rescue.md', root)), false);
  const source = readFileSync(new URL('agents/zcode-rescue.toml.template', root), 'utf8');
  for (const name of expected.filter((value) => value !== 'setup')) assert.doesNotMatch(skill(name), /zcode:zcode-rescue|forwarding subagent|one-time execution capability/i);
  assert.match(source, /^developer_instructions = """[\s\S]+"""\n$/);
  assert.equal((source.match(/^developer_instructions\s*=/gm) ?? []).length, 1);
  assert.match(source, /invoke rescue/);
  assert.match(source, /invoke-choice rescue resume/);
  assert.match(source, /invoke-choice rescue fresh/);
  assert.doesNotMatch(source, /--prompt-file|--write|spark|--force|\{\{(?:TASK|ARGS|JOB|SESSION|PERMISSION|CAPABILITY)[^}]*\}\}/i);
  assert.match(source, /return public stdout verbatim/i);
  assert.match(source, /preserve stderr/i);
  assert.match(source, /(?:Do not|Never) inspect or modify code independently/i);
});

test('native Rescue forwarders request explicit background through the same capability-free constant invocation', () => {
  const source = skill('rescue'); const role = readFileSync(new URL('agents/zcode-rescue.toml.template', root), 'utf8');
  const generic = /```text\n(Act only as the installed ZCode Rescue forwarder\.[\s\S]+?)\n```/.exec(source)?.[1];
  assert.ok(generic, 'generic forwarder fixture must be present');
  for (const forwarder of [role, generic]) {
    assert.equal(forwarder.match(/invoke rescue/g)?.length, 1);
    assert.doesNotMatch(forwarder, /run-reserved-job|executionCapability|callerContext|privateInvocation|FD3|FD4|--background/);
  }
  assert.match(source, /native prompt hook has already recorded the exact arguments and task text/i);
  assert.match(source, /Never place user text, command arguments, job or session identity, permissions, credentials, or authorization material in a process command or agent message\./);
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
  assert.match(source, /named and generic[\s\S]+same-child choice continuation/i);
  assert.match(source, /followup_task\(\{\s*target:\s*rescueChildId,\s*message:\s*continuationMessage,?\s*\}\)/s);
  assert.match(source, /wait_agent\(\{\s*timeout_ms:\s*30000\s*\}\)/);
  assert.match(source, /select only the result or status belonging to `rescueChildId`/);
  assert.match(source, /timeout[\s\S]+early return[\s\S]+steering[\s\S]+same `rescueChildId`/i);
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
