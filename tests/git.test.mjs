import assert from 'node:assert/strict';
import test from 'node:test';

import { collectGitFacts } from '../scripts/lib/git.mjs';
import { PluginError } from '../scripts/lib/errors.mjs';

test('git base refs reject option-shaped values before invoking git', async () => {
  await assert.rejects(
    collectGitFacts({ workspace: process.cwd(), scope: 'branch', base: '--help' }),
    (error) => error instanceof PluginError && error.code === 'GIT_BASE_INVALID',
  );
});
