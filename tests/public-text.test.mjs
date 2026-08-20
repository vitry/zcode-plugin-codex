import assert from 'node:assert/strict';
import test from 'node:test';

import { boundUtf8, normalizePublicText } from '../scripts/lib/public-text.mjs';

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
