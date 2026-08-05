import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { PluginError } from './errors.mjs';

const exec = promisify(execFile);

/** @param {{workspace:string,scope?:string,base?:string}} input */
export async function collectGitFacts(input) {
  if (!input || typeof input.workspace !== 'string' || !input.workspace) throw gitError('GIT_INPUT_INVALID', 'Git inspection input is invalid.');
  /** @param {...string} args */
  const run = async (...args) => {
    try { return (await exec('git', args, { cwd: input.workspace, encoding: 'utf8', timeout: 10_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true, shell: false })).stdout.trimEnd(); }
    catch (error) { throw gitError('GIT_COMMAND_FAILED', `Git command failed: git ${args.join(' ')}`, error); }
  };
  await run('rev-parse', '--is-inside-work-tree');
  if (input.base) await run('rev-parse', '--verify', `${input.base}^{commit}`);
  const status = await run('status', '--porcelain=v1', '--untracked-files=all');
  const dirty = status.length > 0;
  const scope = input.scope && input.scope !== 'auto' ? input.scope : dirty ? 'working-tree' : 'branch';
  const base = input.base ?? (scope === 'branch' ? await defaultBase(run) : 'HEAD');
  const mergeBase = scope === 'branch' ? await run('merge-base', 'HEAD', base) : 'HEAD';
  const diff = scope === 'working-tree'
    ? await run('diff', '--no-ext-diff', '--binary', 'HEAD')
    : await run('diff', '--no-ext-diff', '--binary', `${mergeBase}...HEAD`);
  const untracked = status.split('\n').filter((line) => line.startsWith('?? ')).map((line) => line.slice(3));
  return { workspace: input.workspace, scope, base, mergeBase, status, diff, untracked };
}

/** @param {(...args:string[])=>Promise<string>} run */
async function defaultBase(run) {
  for (const ref of ['origin/HEAD', 'origin/main', 'origin/master', 'main', 'master']) {
    try { await run('rev-parse', '--verify', `${ref}^{commit}`); return ref; } catch { /* try next */ }
  }
  return 'HEAD';
}

/** @param {string} code @param {string} message @param {unknown} [cause] */
function gitError(code, message, cause) { return new PluginError(code, message, { category: 'git', remedy: 'Run this command from a valid Git working tree and verify the base ref.', ...(cause ? { cause } : {}) }); }
