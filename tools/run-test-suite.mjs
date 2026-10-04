import { spawnSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const researchEntries = Object.freeze([
  'tests/direct-mcp-probe.test.mjs',
  'tests/e2e/codex-direct-mcp-feasibility.test.mjs',
  'tests/e2e/codex-mcp-context-e2e.test.mjs',
  'tests/mcp-context-probe.test.mjs',
  'tests/wait-route-probe.test.mjs',
]);
const researchSet = new Set(researchEntries);
const testExtension = /\.(?:cjs|mjs|js)$/;
const testFileName = /(?:\.test|[-_]test)\.(?:cjs|mjs|js)$|^test(?:-.*)?\.(?:cjs|mjs|js)$/;

/** @param {string} relativePath */
export function isNodeTestEntry(relativePath) {
  const segments = relativePath.split('/');
  const fileName = segments.at(-1) ?? '';
  return testFileName.test(fileName) || segments.includes('test') && testExtension.test(fileName);
}

/** Return repository-relative Node test entries in stable order. */
export async function discoverTestEntries() {
  /** @type {string[]} */
  const entries = [];
  /** @param {string} relativeDirectory @returns {Promise<void>} */
  async function visit(relativeDirectory) {
    for (const item of await readdir(join(repositoryRoot, relativeDirectory), { withFileTypes: true })) {
      const relativePath = `${relativeDirectory}/${item.name}`;
      if (item.isDirectory()) await visit(relativePath);
      else if (item.isFile() && isNodeTestEntry(relativePath)) entries.push(relativePath);
    }
  }
  await visit('tests');
  return entries.sort();
}

/** Select routine or MCP research tests without ever silently losing a research entry.
 * @param {string[]} entries
 * @param {string} suite
 */
export function selectTestEntries(entries, suite) {
  if (suite !== 'routine' && suite !== 'mcp-research') throw new Error(`Unknown test suite: ${suite}`);
  if (!Array.isArray(entries) || entries.some((entry) => typeof entry !== 'string') || new Set(entries).size !== entries.length) {
    throw new Error('Duplicate test entry or invalid test list');
  }
  for (const entry of researchEntries) {
    if (!entries.includes(entry)) throw new Error(`Missing MCP research test: ${entry}`);
  }
  return entries.filter((entry) => suite === 'routine' ? !researchSet.has(entry) : researchSet.has(entry)).sort();
}

async function main() {
  if (process.argv.length !== 3) throw new Error('Expected one test suite: routine or mcp-research');
  const suite = process.argv[2];
  const entries = selectTestEntries(await discoverTestEntries(), suite);
  if (entries.length === 0) throw new Error(`No tests selected for ${suite}`);
  const child = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...entries], {
    cwd: repositoryRoot,
    stdio: 'inherit',
  });
  if (child.error) throw child.error;
  process.exitCode = child.status ?? 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
