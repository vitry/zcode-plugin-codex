export const SAFE_IDENTIFIER_MAX_BYTES = 512;

/** @param {unknown} value @param {number} [maxBytes] */
export function isSafeIdentifier(value, maxBytes = SAFE_IDENTIFIER_MAX_BYTES) {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= maxBytes && !hasControl(value);
}

/** @param {string} value */
export function hasControl(value) {
  return [...value].some((character) => {
    const code = /** @type {number} */ (character.codePointAt(0));
    return code <= 31 || code === 127;
  });
}
