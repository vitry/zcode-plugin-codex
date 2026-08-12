import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveRealZCodeModelEnvironment } from './helpers/real-zcode-model.mjs';

test('real ZCode qualification uses the canonical model environment with a deprecated compatible alias', () => {
  assert.deepEqual(resolveRealZCodeModelEnvironment({}), { model: undefined, deprecatedAliasUsed: false });
  assert.deepEqual(resolveRealZCodeModelEnvironment({ ZCODE_REAL_E2E_MODEL: ' provider/model ' }), {
    model: 'provider/model', deprecatedAliasUsed: false,
  });
  assert.deepEqual(resolveRealZCodeModelEnvironment({ ZCODE_REAL_MODEL: ' provider/model ' }), {
    model: 'provider/model', deprecatedAliasUsed: true,
  });
  assert.deepEqual(resolveRealZCodeModelEnvironment({ ZCODE_REAL_E2E_MODEL: 'provider/model', ZCODE_REAL_MODEL: 'provider/model' }), {
    model: 'provider/model', deprecatedAliasUsed: true,
  });
  assert.throws(
    () => resolveRealZCodeModelEnvironment({ ZCODE_REAL_E2E_MODEL: 'provider/one', ZCODE_REAL_MODEL: 'provider/two' }),
    { code: 'ZCODE_REAL_MODEL_CONFLICT' },
  );
});
