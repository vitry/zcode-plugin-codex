/** @param {string} value */
export function normalizePublicText(value) {
  return [...value].map((character) => {
    const code = /** @type {number} */ (character.codePointAt(0));
    if (isBidiControl(code)) return '';
    return code <= 0x1f || code >= 0x7f && code <= 0x9f ? ' ' : character;
  }).join('').replace(/\s+/gu, ' ').trim();
}

/** @param {string} value @param {number} maxBytes */
export function boundUtf8(value, maxBytes) {
  if (Buffer.byteLength(value) <= maxBytes) return value;
  const suffix = '...'; const budget = maxBytes - Buffer.byteLength(suffix); let result = ''; let bytes = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character);
    if (bytes + size > budget) break;
    result += character; bytes += size;
  }
  return `${result}${suffix}`;
}

/** @param {number} code */
function isBidiControl(code) {
  return code === 0x061c || code === 0x200e || code === 0x200f
    || code >= 0x202a && code <= 0x202e || code >= 0x2066 && code <= 0x2069;
}
