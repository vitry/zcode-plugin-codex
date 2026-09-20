import { PluginError } from './errors.mjs';
import { errorEnvelope, renderOutput } from './render.mjs';

/**
 * The transport-neutral classification of one direct invocation outcome.
 * `terminal` is every completed invocation that is not a control handoff;
 * `needs-choice` and `parent-replan` are the two control handoffs the shell
 * CLI already special-cases; `error` is every failure rendered by this
 * formatter — ordinary errors through the bounded error envelope and the
 * domain JOB_INTERRUPTED settlement with its interruption text/stderr/exit
 * code. Lifecycle delivery/discard decisions for any transport belong to the
 * lifecycle owner, never to this formatter.
 * @typedef {'terminal'|'needs-choice'|'parent-replan'|'error'} DirectInvocationOutcome
 */

/**
 * The one result shape every transport renders from: `text` is the exact
 * stdout bytes the shell CLI writes, `stderr` carries the bounded
 * interruption notice when one exists, `exitCode` is the shell exit code,
 * and `outcome`/`isError` classify the invocation for machine transports.
 * @typedef {{text: string, stderr: string, exitCode: number, outcome: DirectInvocationOutcome, isError: boolean}} DirectInvocationResult
 */

/**
 * Format one completed direct-invocation output. `text` is exactly the
 * rendered output the shell CLI writes to stdout, so shell and MCP render
 * identical bytes. Only the two control handoffs are classified specially;
 * every other completed invocation is `terminal` and exits zero.
 * @param {any} output @returns {DirectInvocationResult}
 */
export function formatDirectInvocationSuccess(output) {
  const outcome = output?.type === 'needs-choice' ? 'needs-choice'
    : output?.type === 'parent-replan' ? 'parent-replan' : 'terminal';
  return { text: renderOutput(output), stderr: '', exitCode: outcome === 'needs-choice' ? 3 : 0, outcome, isError: false };
}

/**
 * Format one failed direct invocation. Ordinary errors render the bounded
 * error envelope exactly as the shell CLI stdout does. The domain
 * interruption classifies as `error` too, but keeps the shell behavior —
 * empty stdout, the bounded `Interrupted by <signal>.` stderr notice, and
 * the signal exit code from the interruption details (zero when the
 * interruption carries no signal exit code, where the shell leaves the exit
 * code untouched).
 * @param {unknown} error @returns {DirectInvocationResult}
 */
export function formatDirectInvocationError(error) {
  if (error instanceof PluginError && error.code === 'JOB_INTERRUPTED') {
    return {
      text: '',
      stderr: `Interrupted by ${typeof error.details.signal === 'string' ? error.details.signal : 'signal'}.\n`,
      exitCode: typeof error.details.exitCode === 'number' ? error.details.exitCode : 0,
      outcome: 'error',
      isError: true,
    };
  }
  return {
    text: renderOutput(errorEnvelope(error), { json: true }),
    stderr: '',
    exitCode: error instanceof PluginError && error.category === 'validation' ? 2 : 1,
    outcome: 'error',
    isError: true,
  };
}
