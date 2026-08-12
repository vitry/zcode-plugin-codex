#!/usr/bin/env node
// @ts-check
import { spawnSync } from 'node:child_process';
import { closeSync, lstatSync, openSync, readlinkSync, readSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const MAX_TRACKED_FILES = 100_000;
const NUL = 0x00;
const CRLF_ALLOWLIST = new Set();

/** @param {string} message @returns {never} */
const fail = (message) => {
  throw new Error(`LINE_ENDING_CHECK_FAILED: ${message}`);
};

/** @param {unknown} error */
const errorCode = (error) => error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
  ? error.code
  : 'io-error';

/** @param {string} path */
export const normalizeTrackedPath = (path) => path.replaceAll('\\', '/');

/** @param {string[]} argv */
const parseArguments = (argv) => {
  if (argv.length === 0) return process.cwd();
  if (argv.length !== 2 || argv[0] !== '--root' || !argv[1]) fail('usage: check-line-endings.mjs [--root <repository>]');
  return argv[1];
};

/** @param {string} repositoryRoot */
const listTrackedFiles = (repositoryRoot) => {
  const result = spawnSync(
    'git',
    ['-C', repositoryRoot, 'ls-files', '--cached', '-z'],
    { encoding: null, maxBuffer: 4 * 1024 * 1024, shell: false },
  );
  if (result.error) fail(`cannot list tracked files (${errorCode(result.error)})`);
  if (result.status !== 0) fail(`git ls-files exited ${result.status}`);
  const output = result.stdout;
  if (!Buffer.isBuffer(output)) fail('git ls-files returned malformed output');
  if (output.length > 0 && output.at(-1) !== NUL) fail('git ls-files output is not NUL terminated');
  let decoded = '';
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(output.length === 0 ? output : output.subarray(0, -1));
  } catch {
    fail('git ls-files returned non-UTF-8 paths');
  }
  const fields = decoded.length === 0 ? [] : decoded.split('\0');
  if (fields.length > MAX_TRACKED_FILES) fail(`tracked file count exceeds ${MAX_TRACKED_FILES}`);
  return fields;
};

/** @param {string} repositoryRoot @param {string} gitPath */
const resolveTrackedFile = (repositoryRoot, gitPath) => {
  const displayPath = normalizeTrackedPath(gitPath);
  if (!displayPath || displayPath.includes('\0') || isAbsolute(displayPath)) fail('Git returned an unsafe tracked path');
  const target = resolve(repositoryRoot, ...gitPath.split('/'));
  const escaped = relative(repositoryRoot, target);
  if (!escaped || escaped === '..' || escaped.startsWith('../') || escaped.startsWith('..\\') || isAbsolute(escaped)) {
    fail(`Git returned an unsafe tracked path: ${displayPath}`);
  }
  return { displayPath, target };
};

/**
 * @param {string} target
 * @param {string} displayPath
 * @param {(bytesRead:number) => void} accountBytes
 */
const inspectRegularFile = (target, displayPath, accountBytes) => {
  /** @type {number | undefined} */
  let descriptor;
  try {
    descriptor = openSync(target, 'r');
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let fileBytes = 0;
    let containsNul = false;
    let containsCrlf = false;
    let previousWasCr = false;
    while (true) {
      const bytesRead = readSync(descriptor, chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      fileBytes += bytesRead;
      if (fileBytes > MAX_FILE_BYTES) fail(`tracked file exceeds ${MAX_FILE_BYTES} bytes: ${displayPath}`);
      accountBytes(bytesRead);
      for (let index = 0; index < bytesRead; index += 1) {
        const byte = chunk[index];
        if (byte === NUL) containsNul = true;
        if (previousWasCr && byte === 0x0a) containsCrlf = true;
        previousWasCr = byte === 0x0d;
      }
    }
    return { containsCrlf, containsNul };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('LINE_ENDING_CHECK_FAILED:')) throw error;
    fail(`cannot read tracked file (${errorCode(error)}): ${displayPath}`);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
};

/** @param {string} rootPath */
export const checkLineEndings = (rootPath) => {
  const repositoryRoot = realpathSync(rootPath);
  const trackedFiles = listTrackedFiles(repositoryRoot);
  const violations = [];
  let totalBytes = 0;
  /** @param {number} bytesRead */
  const accountBytes = (bytesRead) => {
    totalBytes += bytesRead;
    if (totalBytes > MAX_TOTAL_BYTES) fail(`tracked input exceeds ${MAX_TOTAL_BYTES} bytes`);
  };
  for (const gitPath of trackedFiles) {
    const { displayPath, target } = resolveTrackedFile(repositoryRoot, gitPath);
    /** @type {import('node:fs').Stats | undefined} */
    let stats;
    try {
      stats = lstatSync(target);
    } catch (error) {
      fail(`cannot inspect tracked file (${errorCode(error)}): ${displayPath}`);
    }
    if (!stats) fail(`cannot inspect tracked file: ${displayPath}`);
    /** @type {{containsCrlf:boolean, containsNul:boolean} | undefined} */
    let inspection;
    if (stats.isSymbolicLink()) {
      const contents = readlinkSync(target, { encoding: 'buffer' });
      accountBytes(contents.length);
      inspection = {
        containsCrlf: contents.includes(Buffer.from([0x0d, 0x0a])),
        containsNul: contents.includes(NUL),
      };
    } else if (stats.isFile()) inspection = inspectRegularFile(target, displayPath, accountBytes);
    else fail(`tracked path is not a regular file or symlink: ${displayPath}`);
    if (!inspection) fail(`cannot inspect tracked file: ${displayPath}`);
    if (!inspection.containsNul && inspection.containsCrlf && !CRLF_ALLOWLIST.has(displayPath)) violations.push(displayPath);
  }
  if (violations.length > 0) fail(`CRLF is forbidden in tracked text files:\n${violations.join('\n')}`);
  return { fileCount: trackedFiles.length, totalBytes };
};

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  try {
    const result = checkLineEndings(parseArguments(process.argv.slice(2)));
    process.stdout.write(`LF line endings verified in ${result.fileCount} tracked files.\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
