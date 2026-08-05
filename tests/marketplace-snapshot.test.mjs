// @ts-nocheck
import assert from 'node:assert/strict';
import test from 'node:test';

import { validateReleaseIdentity, validateResolvedSource } from '../scripts/build-marketplace-snapshot.mjs';

test('release identity binds package, plugin, source ref, SHA, and exact version tag', () => {
  const sha = 'a'.repeat(40);
  assert.deepEqual(validateReleaseIdentity({ packageVersion: '1.2.3', pluginVersion: '1.2.3', sourceRef: 'v1.2.3', sourceSha: sha, releaseTag: 'v1.2.3' }), {
    packageVersion: '1.2.3', pluginVersion: '1.2.3', sourceRef: 'v1.2.3', sourceSha: sha, releaseTag: 'v1.2.3',
  });
  for (const input of [
    { packageVersion: '1.2.3', pluginVersion: '1.2.4', sourceRef: 'main', sourceSha: sha },
    { packageVersion: '1.2.3', pluginVersion: '1.2.3', sourceRef: 'v1.2.4', sourceSha: sha, releaseTag: 'v1.2.4' },
    { packageVersion: '1.2.3', pluginVersion: '1.2.3', sourceRef: '', sourceSha: sha },
    { packageVersion: '1.2.3', pluginVersion: '1.2.3', sourceRef: 'main', sourceSha: 'not-a-sha' },
  ]) assert.throws(() => validateReleaseIdentity(input), /release identity/i);
});

test('resolved source validation rejects a ref or checkout resolving to another SHA', () => {
  const sha = 'a'.repeat(40);
  assert.deepEqual(validateResolvedSource({ sourceRef: 'main', sourceSha: sha, headSha: sha, refSha: sha }), { sourceRef: 'main', sourceSha: sha });
  assert.throws(() => validateResolvedSource({ sourceRef: 'main', sourceSha: sha, headSha: 'b'.repeat(40), refSha: sha }), /resolved marketplace source/i);
  assert.throws(() => validateResolvedSource({ sourceRef: 'wrong-ref', sourceSha: sha, headSha: sha, refSha: 'c'.repeat(40) }), /resolved marketplace source/i);
});
