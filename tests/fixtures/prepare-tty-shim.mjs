import { appendFileSync } from 'node:fs';

Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
/** @param {boolean} enabled */
process.stdin.setRawMode = (enabled) => {
  if (process.env.ZCODE_PREPARE_TTY_RECORD) appendFileSync(process.env.ZCODE_PREPARE_TTY_RECORD, `${enabled}\n`);
  return process.stdin;
};
