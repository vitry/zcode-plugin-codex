import process from 'node:process';

import { PluginError } from './errors.mjs';

const SIGNAL_EXIT_CODES = Object.freeze({ SIGINT: 130, SIGTERM: 143 });

/**
 * @param {{process?:{on:(event:string,listener:()=>void)=>unknown,removeListener:(event:string,listener:()=>void)=>unknown,exitCode?:string|number|null},foreground?:boolean}} [options]
 */
export function createForegroundSignalController(options = {}) {
  const processLike = options.process ?? process;
  const controller = new AbortController();
  let cleaned = false;
  const handlers = Object.fromEntries(Object.entries(SIGNAL_EXIT_CODES).map(([signal, exitCode]) => [signal, () => {
    if (controller.signal.aborted) return;
    processLike.exitCode = exitCode;
    controller.abort(new PluginError('JOB_INTERRUPTED', `Foreground ZCode job interrupted by ${signal}.`, {
      category: 'interruption',
      remedy: 'Retry the command when you are ready.',
      details: { signal, exitCode },
    }));
  }]));
  if (options.foreground !== false) for (const [signal, handler] of Object.entries(handlers)) processLike.on(signal, handler);
  return {
    signal: controller.signal,
    cleanup() {
      if (cleaned) return;
      cleaned = true;
      if (options.foreground !== false) for (const [signal, handler] of Object.entries(handlers)) processLike.removeListener(signal, handler);
    },
  };
}
