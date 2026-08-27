import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { boundUtf8, normalizePublicText, publicErrorMessage } from '../scripts/lib/public-text.mjs';

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
    assert.doesNotMatch(source, /--resume\s+(?:<|\[)(?:child|session|job|binding|operation|handle)/i);
    assert.doesNotMatch(source, /(?:multiple|concurrent|多个|并发).{0,100}(?:active )?writable Rescue.{0,100}(?:same canonical workspace|同一 canonical workspace).{0,80}(?:supported|enabled|允许|支持|启用)/is);
  }
});
