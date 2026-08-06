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
    const source = skill(name);
    assert.match(source, new RegExp(`^---\\nname: ${name}\\n`));
    assert.match(source, /^description: Use when /m);
    assert.match(source, new RegExp(`\\$zcode:${name.replace('-', '\\-')}`));
    assert.match(source, new RegExp(hints[name].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.equal(existsSync(new URL(`skills/${name}/agents/openai.yaml`, root)), true);
  }
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
  assert.doesNotMatch(source, /built-in.*subagent|forwarding subagent/i);
});

test('background execution is production-owned and public skills do not forward capabilities', () => {
  const source = readFileSync(new URL('agents/zcode-rescue.md', root), 'utf8');
  for (const name of expected.filter((value) => value !== 'setup')) assert.doesNotMatch(skill(name), /zcode:zcode-rescue|forwarding subagent|one-time execution capability/i);
  assert.ok(source.length > 0);
  assert.doesNotMatch(source, /--prompt-file|--write|spark|--force/);
});

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
