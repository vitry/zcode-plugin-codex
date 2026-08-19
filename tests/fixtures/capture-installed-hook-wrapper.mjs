#!/usr/bin/env node
// @ts-nocheck
import { spawn } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const MAX_STDIN_BYTES = 1024 * 1024;
const MAX_ARTIFACT_FILES = 4096;
const MAX_ARTIFACT_BYTES = 32 * 1024 * 1024;

const wrapperPath = fileURLToPath(import.meta.url);
const production = join(dirname(wrapperPath), basename(wrapperPath, '.mjs') + '-production.mjs');
const captureDirectory = process.env.ZCODE_TEST_HOOK_CAPTURE_DIRECTORY;
const privateDataRoot = process.env.ZCODE_TEST_PRIVATE_DATA_ROOT;
if (!captureDirectory || !privateDataRoot) {
  process.stderr.write('installed hook capture wrapper is not configured\n');
  process.exit(97);
}

const chunks = [];
let stdinBytes = 0;
for await (const chunk of process.stdin) {
  const bytes = Buffer.from(chunk);
  stdinBytes += bytes.length;
  if (stdinBytes > MAX_STDIN_BYTES) {
    process.stderr.write('installed hook capture stdin exceeded its bound\n');
    process.exit(98);
  }
  chunks.push(bytes);
}
const stdin = Buffer.concat(chunks);
await mkdir(captureDirectory, { recursive: true, mode: 0o700 });
const allocationLock = join(captureDirectory, '.allocation-lock');
await acquireAllocationLock(allocationLock);
try {
  const sequencePath = join(captureDirectory, 'sequence');
  let sequence = 0;
  try { sequence = Number.parseInt(await readFile(sequencePath, 'utf8'), 10); } catch { /* first capture */ }
  if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error('installed hook capture sequence is invalid');
  sequence += 1;
  await writeFile(sequencePath, `${sequence}\n`, { mode: 0o600 });
  const artifacts = await snapshotFiles(privateDataRoot);
  const capture = { version: 1, sequence, entry: basename(production).replace('-production.mjs', '.mjs'), stdinBase64: stdin.toString('base64'), artifacts };
  await writeFile(join(captureDirectory, `${String(sequence).padStart(6, '0')}-${process.pid}.json`), `${JSON.stringify(capture)}\n`, { mode: 0o600, flag: 'wx' });
} finally { await rm(allocationLock, { recursive: true, force: true }); }

const child = spawn(process.execPath, [production, ...process.argv.slice(2)], {
  cwd: process.cwd(), env: process.env, stdio: ['pipe', 'pipe', 'pipe'],
});
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
child.stdin.end(stdin);
const result = await new Promise((resolveResult, reject) => {
  child.once('error', reject);
  child.once('exit', (code, signal) => resolveResult({ code, signal }));
});
if (result.signal) process.kill(process.pid, result.signal);
process.exitCode = result.code ?? 1;

async function snapshotFiles(root) {
  const canonicalRoot = resolve(root);
  const pending = [canonicalRoot];
  const files = [];
  let totalBytes = 0;
  while (pending.length > 0) {
    const directory = pending.pop();
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { continue; }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) {
        const metadata = await lstat(path);
        totalBytes += metadata.size;
        if (files.length >= MAX_ARTIFACT_FILES || totalBytes > MAX_ARTIFACT_BYTES) {
          throw new Error('installed hook private artifact snapshot exceeded its bound');
        }
        files.push({ path: relative(canonicalRoot, path), bytesBase64: (await readFile(path)).toString('base64') });
      }
    }
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

async function acquireAllocationLock(path) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    try { await mkdir(path, { mode: 0o700 }); return; } catch (error) { if (error?.code !== 'EEXIST') throw error; }
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error('installed hook capture allocation lock timed out');
}
