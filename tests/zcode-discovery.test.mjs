// @ts-nocheck
import assert from 'node:assert/strict';
import test from 'node:test';

import { discoverZCode, getPlatformCandidates } from '../scripts/lib/zcode-discovery.mjs';

const okVersion = async () => 'zcode 0.16.1';

test('discovery uses explicit path before PATH and builds JS launcher without a shell', async () => {
  const calls = [];
  const result = await discoverZCode({
    explicitPath: '/custom path/zcode.cjs', platform: 'darwin', env: { PATH: '/bin' },
    which: async () => '/bin/zcode', exists: async (value) => value === '/custom path/zcode.cjs',
    runVersion: async (launch) => { calls.push(launch); return '0.16.2'; }, execPath: '/node',
  });
  assert.deepEqual(result.launch, { command: '/node', args: ['/custom path/zcode.cjs'], target: '/custom path/zcode.cjs' });
  assert.deepEqual(calls, [result.launch]);
});

test('discovery falls through PATH then stable platform candidates in priority order', async () => {
  const visited = [];
  const result = await discoverZCode({
    platform: 'darwin', env: {}, which: async () => null,
    exists: async (value) => { visited.push(value); return value === '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs'; },
    runVersion: okVersion,
  });
  assert.equal(result.path, '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs');
  assert.equal(new Set(getPlatformCandidates('darwin', {})).size, getPlatformCandidates('darwin', {}).length);
  assert.ok(visited.length > 0);
});

test('discovery rejects unsupported versions and absent installations with stable errors', async () => {
  await assert.rejects(discoverZCode({ explicitPath: '/zcode', platform: 'linux', env: {}, which: async () => null, exists: async () => true, runVersion: async () => '0.16.0' }), { code: 'ZCODE_VERSION_UNSUPPORTED' });
  await assert.rejects(discoverZCode({ platform: 'linux', env: {}, which: async () => null, exists: async () => false, runVersion: okVersion }), (error) => error.code === 'ZCODE_NOT_FOUND' && error.remedy.includes('$zcode:setup'));
});

test('discovery treats a prerelease of the minimum release as unsupported SemVer', async () => {
  await assert.rejects(discoverZCode({ explicitPath: '/zcode', platform: 'linux', env: {}, which: async () => null, exists: async () => true, runVersion: async () => '0.16.1-beta.1' }), { code: 'ZCODE_VERSION_UNSUPPORTED' });
});

test('discovery validates injected inputs and output fail closed', async () => {
  await assert.rejects(discoverZCode({ platform: 'plan9' }), { code: 'ZCODE_DISCOVERY_INPUT_INVALID' });
  await assert.rejects(discoverZCode({ explicitPath: '/zcode', platform: 'linux', env: {}, which: async () => null, exists: async () => true, runVersion: async () => ({ version: 'wat' }) }), { code: 'ZCODE_VERSION_INVALID' });
});
