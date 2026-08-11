/**
 * Resolve the release-qualification model environment without silently
 * choosing between two conflicting operator inputs.
 *
 * @param {NodeJS.ProcessEnv|Record<string,string|undefined>} env
 */
export function resolveRealZCodeModelEnvironment(env) {
  const canonical = env.ZCODE_REAL_E2E_MODEL?.trim() || undefined;
  const alias = env.ZCODE_REAL_MODEL?.trim() || undefined;
  if (canonical && alias && canonical !== alias) {
    throw Object.assign(new Error('ZCODE_REAL_E2E_MODEL conflicts with deprecated ZCODE_REAL_MODEL. Remove the alias or set both to the exact same model.'), {
      code: 'ZCODE_REAL_MODEL_CONFLICT',
    });
  }
  return { model: canonical ?? alias, deprecatedAliasUsed: alias !== undefined };
}
