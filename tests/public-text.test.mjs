import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { boundUtf8, normalizePublicText, publicErrorMessage } from '../scripts/lib/public-text.mjs';

const ENGLISH_RESCUE_COMMAND = '| `$zcode:rescue [--background \\| --wait] [--resume \\| --fresh] [--model <provider/model\\|alias>] [--effort none\\|minimal\\|low\\|medium\\|high\\|xhigh] <task...>` | Delegate investigation or edits; placement is inferred from task complexity, and explicit `--wait` or `--background` remains authoritative. |';
const CHINESE_RESCUE_COMMAND = '| `$zcode:rescue [--background \\| --wait] [--resume \\| --fresh] [--model <provider/model\\|alias>] [--effort none\\|minimal\\|low\\|medium\\|high\\|xhigh] <task...>` | 委派调查或修改；无标志时按任务复杂度推断 placement，显式 `--wait` 或 `--background` 始终权威。 |';

/** @param {string} source */
function assertNoPublicRescueSelector(source) {
  assert.doesNotMatch(source, /--resume(?:=(?:[^\s]+)|\s+--(?:child|session|job|binding|operation|handle)\b|\s+(?:<|\[)(?:child|session|job|binding|operation|handle)[^\s>\]]*(?:>|\]))/i);
}

/** @param {string} source */
function assertNoWritableConcurrencyPromise(source) {
  assert.doesNotMatch(source, /(?=[^\n.!?。！？]{0,300}(?:same canonical workspace|同一 canonical workspace))(?=[^\n.!?。！？]{0,300}(?:(?:multiple|concurrent|多个|并发).{0,80}writable Rescue|writable Rescue.{0,80}(?:multiple|concurrent|多个|并发)))(?=[^\n.!?。！？]{0,300}(?:supports?|supported|allows?|allowed|enables?|enabled|can run|允许|支持|启用|可以运行))[^\n.!?。！？]{1,300}/i);
}

/** @param {string} source */
function assertNoUnconditionalBindingAmbiguity(source) {
  assert.doesNotMatch(source, /(?=[^\n.!?]{0,240}(?:multiple|two).{0,40}usable.{0,40}bindings?)(?=[^\n.!?]{0,240}ambiguous)(?=[^\n.!?]{0,240}(?:always|unconditionally|regardless|even with|for every))[^\n.!?]{1,240}/i);
  assert.doesNotMatch(source, /(?=[^\n。！？]{0,240}(?:多个|两个).{0,40}可用.{0,40}bindings?)(?=[^\n。！？]{0,240}歧义)(?=[^\n。！？]{0,240}(?:始终|无条件|无论|即使))[^\n。！？]{1,240}/i);
}

test('public text normalization removes every bidi control and normalizes C0/C1 whitespace', () => {
  const bidi = [0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069]
    .map((code) => String.fromCodePoint(code)).join('');
  const c0c1 = [...Array.from({ length: 32 }, (_, code) => code), ...Array.from({ length: 33 }, (_, offset) => 0x7f + offset)]
    .map((code) => String.fromCodePoint(code)).join('');
  assert.equal(normalizePublicText(`  A${bidi}B${c0c1}C \n D  `), 'AB C D');
});

test('UTF-8 bounding preserves code points and reserves the truncation suffix', () => {
  assert.equal(boundUtf8('ab界界界', 10), 'ab界...');
  assert.equal(Buffer.byteLength(boundUtf8('ab界界界', 10)), 8);
  assert.equal(boundUtf8('ab界', 5), 'ab界');
  assert.doesNotMatch(boundUtf8('ab界界界', 10), /\uFFFD/u);
});

test('public error projection accepts legacy and object messages without exposing arbitrary fields', () => {
  const value = { message: '  failed\u061c\nwith\u0085 controls  ', code: 'PRIVATE_CODE', details: { token: 'PRIVATE_TOKEN' } };
  assert.equal(publicErrorMessage(value), 'failed with controls');
  assert.equal(publicErrorMessage(value), publicErrorMessage(value.message));
  assert.equal(publicErrorMessage({ ...value, message: 'ab界界界' }, 10), 'ab界...');
  for (const absent of [null, undefined, {}, { message: 42 }, '', ' \n\u0000\u061c\u200e\u202e\u2069 ']) {
    assert.equal(publicErrorMessage(absent), null);
  }
});

test('public Rescue text rejects adoption, same-child fresh, fallback selection, and automatic resend claims', () => {
  const root = new URL('../', import.meta.url);
  for (const path of ['README.md', 'README.zh-CN.md', 'SECURITY.md', 'CHANGELOG.md']) {
    const source = readFileSync(new URL(path, root), 'utf8');
    assert.doesNotMatch(source, /jobs-only state may adopt|jobs-only 状态只会采用/i);
    assert.doesNotMatch(source, /same-child fresh replacement (?:may|retains)|同 child fresh 替换(?:可以|会)/i);
    assert.doesNotMatch(source, /(?:managed base|受管 base).{0,160}(?:newest|最新)/is);
    assert.doesNotMatch(source, /response loss.{0,120}(?:automatically resends|may resend|resends the prompt)|响应丢失.{0,120}(?:会自动重发|可以重发)/is);
    assert.doesNotMatch(source, /atomic stop|原子 stop/i);
  }
});

test('public Rescue text does not expose a continuation selector or concurrent-writer promise', () => {
  const root = new URL('../', import.meta.url);
  for (const path of ['README.md', 'README.zh-CN.md', 'SECURITY.md', 'CHANGELOG.md']) {
    const source = readFileSync(new URL(path, root), 'utf8');
    assertNoPublicRescueSelector(source);
    assertNoWritableConcurrencyPromise(source);
  }
});

test('public Rescue text never makes multiple-binding ambiguity unconditional', () => {
  const root = new URL('../', import.meta.url);
  for (const path of ['README.md', 'README.zh-CN.md', 'SECURITY.md', 'CHANGELOG.md']) {
    const source = readFileSync(new URL(path, root), 'utf8');
    assertNoUnconditionalBindingAmbiguity(source);
  }
});

test('README command tables pin the argument-free Rescue syntax exactly', () => {
  const root = new URL('../', import.meta.url);
  const english = readFileSync(new URL('README.md', root), 'utf8').split('\n');
  const chinese = readFileSync(new URL('README.zh-CN.md', root), 'utf8').split('\n');
  assert.equal(english.filter((line) => line.startsWith('| `$zcode:rescue ')).length, 1);
  assert.equal(chinese.filter((line) => line.startsWith('| `$zcode:rescue ')).length, 1);
  assert.ok(english.includes(ENGLISH_RESCUE_COMMAND));
  assert.ok(chinese.includes(CHINESE_RESCUE_COMMAND));
});

test('public-text guards reject representative selectors, concurrency promises, and unconditional ambiguity', () => {
  for (const unsafe of [
    '$zcode:rescue --resume --child child-1 repair',
    '$zcode:rescue --resume --session session-1 repair',
    '$zcode:rescue --resume --handle handle-1 repair',
    '$zcode:rescue --resume=<handle> repair',
    '$zcode:rescue --resume=<session-id> repair',
    '$zcode:rescue --resume <child-id> repair',
    '$zcode:rescue --resume <session-id> repair',
    '$zcode:rescue --resume <handle> repair',
  ]) assert.throws(() => assertNoPublicRescueSelector(unsafe));

  for (const unsafe of [
    'The same canonical workspace now supports concurrent active writable Rescue jobs.',
    'Concurrent writable Rescue jobs are enabled in the same canonical workspace.',
    '同一 canonical workspace 现在允许并发 writable Rescue。',
  ]) assert.throws(() => assertNoWritableConcurrencyPromise(unsafe));

  for (const unsafe of [
    'Multiple usable bindings are always ambiguous.',
    'Two usable bindings remain ambiguous even with an exact private selector.',
    '多个可用 binding 始终属于歧义。',
  ]) assert.throws(() => assertNoUnconditionalBindingAmbiguity(unsafe));
});
