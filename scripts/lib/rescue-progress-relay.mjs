export const RESCUE_RELAY_PREFIX = '[zcode-relay] ';
export const MAX_RESCUE_RELAY_BYTES = 256;
export const MAX_RESCUE_RELAY_SEQUENCE = 2_147_483_647;

export const RESCUE_RELAY_MESSAGES = Object.freeze({
  started: 'ZCode Rescue started.',
  'model-active': 'ZCode is generating a response.',
  'tool-active': 'ZCode is working with a tool.',
  editing: 'ZCode is applying workspace changes.',
  verifying: 'ZCode is verifying the work.',
  waiting: 'ZCode Rescue is still running.',
  finalizing: 'ZCode Rescue is finalizing.',
});

/** @type {Readonly<Record<string,string>>} */
const PHASE_BY_CODE = Object.freeze({
  started: 'starting',
  'model-active': 'running',
  'tool-active': 'investigating',
  editing: 'editing',
  verifying: 'verifying',
  waiting: 'waiting',
  finalizing: 'finalizing',
});
const INPUT_KEYS = Object.freeze(['code', 'observedAt', 'phase', 'sequence']);
const WIRE_KEYS = Object.freeze(['code', 'observedAt', 'phase', 'sequence', 'version']);
const INVALID_RELAY = 'Invalid Rescue progress relay.';

/** @param {{sequence:number,phase:string,code:string,observedAt:string}} record */
export function serializeRescueProgressRelay(record) {
  try {
    const value = validateRecord(record, false);
    const line = `${RESCUE_RELAY_PREFIX}${JSON.stringify({ version: 1, ...value })}\n`;
    if (Buffer.byteLength(line) > MAX_RESCUE_RELAY_BYTES) throw invalidRelay();
    return line;
  } catch { throw invalidRelay(); }
}

/** @param {unknown} line */
export function parseRescueProgressRelay(line) {
  try {
    if (typeof line !== 'string' || Buffer.byteLength(line) > MAX_RESCUE_RELAY_BYTES
      || !line.startsWith(RESCUE_RELAY_PREFIX) || !line.endsWith('\n') || line.slice(0, -1).includes('\n')) throw invalidRelay();
    const parsed = JSON.parse(line.slice(RESCUE_RELAY_PREFIX.length, -1));
    const value = validateRecord(parsed, true);
    return { version: 1, sequence: value.sequence, phase: value.phase, code: value.code, observedAt: value.observedAt };
  } catch { throw invalidRelay(); }
}

/** @param {unknown} record @param {boolean} wire */
function validateRecord(record, wire) {
  if (!plainObject(record)) throw invalidRelay();
  const keys = Object.keys(record).sort();
  const expected = wire ? WIRE_KEYS : INPUT_KEYS;
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) throw invalidRelay();
  if (wire && record.version !== 1) throw invalidRelay();
  if (!Number.isSafeInteger(record.sequence) || record.sequence < 1 || record.sequence > MAX_RESCUE_RELAY_SEQUENCE) throw invalidRelay();
  if (typeof record.code !== 'string' || typeof record.phase !== 'string' || PHASE_BY_CODE[record.code] !== record.phase) throw invalidRelay();
  if (!validRfc3339(record.observedAt)) throw invalidRelay();
  return { sequence: record.sequence, phase: record.phase, code: record.code, observedAt: record.observedAt };
}

/** @param {unknown} value */
function validRfc3339(value) {
  if (typeof value !== 'string' || Buffer.byteLength(value) > 40) return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , , , offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText); const month = Number(monthText); const day = Number(dayText);
  const hour = Number(hourText); const minute = Number(minuteText); const second = Number(secondText);
  const offsetHour = offsetHourText === undefined ? 0 : Number(offsetHourText);
  const offsetMinute = offsetMinuteText === undefined ? 0 : Number(offsetMinuteText);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)
    || hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59) return false;
  return Number.isFinite(Date.parse(value));
}

/** @param {number} year @param {number} month */
function daysInMonth(year, month) {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** @param {unknown} value @returns {value is Record<string,any>} */
function plainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function invalidRelay() { return new Error(INVALID_RELAY); }
