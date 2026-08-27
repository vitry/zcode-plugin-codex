const TIMEOUT_MULTIPLIER_ENV = 'ZCODE_TEST_TIMEOUT_MULTIPLIER';

/** @param {NodeJS.ProcessEnv|Record<string,string|undefined>} [env] */
export function testTimeoutMultiplier(env = process.env) {
  const value = env[TIMEOUT_MULTIPLIER_ENV];
  if (value === undefined || value === '') return 1;
  if (!/^[1-3]$/u.test(value)) throw new Error(`${TIMEOUT_MULTIPLIER_ENV} must be an integer from 1 through 3.`);
  return Number(value);
}

/** @param {number} timeoutMs @param {NodeJS.ProcessEnv|Record<string,string|undefined>} [env] */
export function scaleTestTimeout(timeoutMs, env = process.env) {
  return timeoutMs * testTimeoutMultiplier(env);
}
