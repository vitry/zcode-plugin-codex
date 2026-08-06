export class PluginError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {{ category?: string, remedy?: string, cause?: unknown, details?: Record<string, unknown> }} [options]
   */
  constructor(code, message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'PluginError';
    this.code = code;
    this.category = options.category ?? 'plugin';
    this.remedy = options.remedy ?? 'Retry the operation or inspect the underlying cause.';
    this.details = options.details ?? {};
  }
}

/**
 * @param {unknown} error
 * @param {string} code
 * @param {string} message
 * @param {{ category?: string, remedy?: string, details?: Record<string, unknown> }} [options]
 */
export function wrapError(error, code, message, options = {}) {
  if (error instanceof PluginError) return error;
  return new PluginError(code, message, { ...options, cause: error });
}
