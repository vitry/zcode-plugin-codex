import { appendJobLogBlock, createJobLogSink } from './job-log.mjs';

export const JOB_LOG_DISABLED_LINE = '[zcode] ZCode job log was disabled.\n';

/**
 * Runtime-only lifecycle around the observational job-log sink.
 * @param {{dataRoot:string,workspace:string,job:any,store:any,attach:'always'|'if-missing',writeDiagnostic?:(line:string)=>unknown,fenceMs:number}} input
 */
export async function openRuntimeJobLog(input) {
  /** @type {any} */ let sink;
  let disabled = false;
  let closed = false;
  /** @type {any} */ let attachedJob;
  const disable = () => {
    if (disabled) return;
    disabled = true;
    try { input.writeDiagnostic?.(JOB_LOG_DISABLED_LINE); } catch { /* diagnostics are observational */ }
  };
  const deadline = () => Date.now() + input.fenceMs;

  try { sink = await createJobLogSink({ dataRoot: input.dataRoot, workspace: input.workspace, jobId: input.job.id }); }
  catch { disable(); }
  if (!sink?.logFile) disable();
  else if (input.attach === 'always' || !input.job.logFile) {
    try { attachedJob = await input.store.attachJobLog(input.workspace, input.job.id, sink.logFile); }
    catch { disable(); await closeSink(deadline()); sink = undefined; }
  }

  return {
    get attachedJob() { return attachedJob; },
    get disabled() { return disabled; },
    /** @param {unknown} event */
    async archiveEvent(event) {
      if (!sink || disabled || closed) return false;
      try { await sink.appendEvent(event); if (sink.disabled) disable(); }
      catch { disable(); }
      return !disabled;
    },
    /** @param {string} title @param {string} body @param {number} [absoluteDeadline] */
    async appendBlock(title, body, absoluteDeadline = deadline()) {
      if (!sink || disabled || closed) return false;
      const completed = await waitForOptionalJobLog(Promise.resolve().then(() => sink.appendBlock(title, body)), absoluteDeadline);
      if (!completed || sink.disabled) disable();
      return !disabled;
    },
    /** Recovery may finish after its observational sink cleanup has begun. @param {string} title @param {string} body @param {number} [absoluteDeadline] */
    async appendCanonicalBlock(title, body, absoluteDeadline = deadline()) {
      if (disabled) return false;
      const completed = await waitForOptionalJobLog(appendJobLogBlock({
        dataRoot: input.dataRoot, workspace: input.workspace, jobId: input.job.id, title, body,
      }), absoluteDeadline);
      if (!completed) disable();
      return !disabled;
    },
    async close(absoluteDeadline = deadline()) {
      if (closed) return;
      closed = true;
      await closeSink(absoluteDeadline);
    },
  };

  /** @param {number} absoluteDeadline */
  async function closeSink(absoluteDeadline) {
    if (!sink) return;
    const flushed = await waitForOptionalJobLog(Promise.resolve().then(() => sink.flush()), absoluteDeadline);
    const closedSink = await waitForOptionalJobLog(Promise.resolve().then(() => sink.close()), absoluteDeadline);
    if (!flushed || !closedSink || sink.disabled) disable();
  }
}

/** @param {Promise<unknown>} operation @param {number} deadline */
export async function waitForOptionalJobLog(operation, deadline) {
  let completed = false;
  let succeeded = false;
  const tracked = operation.then(() => { completed = true; succeeded = true; }).catch(() => { completed = true; });
  /** @type {ReturnType<typeof setTimeout>|undefined} */ let timer;
  try {
    const timeoutMs = Math.max(0, deadline - Date.now());
    if (timeoutMs > 0) await Promise.race([tracked, new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs); })]);
    for (let phase = 0; phase < 2 && !completed; phase += 1) {
      await new Promise((resolve) => setImmediate(resolve)); await Promise.resolve();
    }
  } catch { /* log-only */ }
  finally { if (timer !== undefined) clearTimeout(timer); }
  return completed && succeeded;
}
