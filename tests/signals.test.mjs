import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { PluginError } from '../scripts/lib/errors.mjs';
import { waitForCompletionOrAbort } from '../scripts/lib/progress.mjs';
import { createForegroundSignalController } from '../scripts/lib/signals.mjs';

test('foreground signal controller aborts once without setting the process exit code and cleans up', () => {
  /** @type {Array<[string,number]>} */
  const cases = [['SIGINT', 130], ['SIGTERM', 143]];
  for (const [name, exitCode] of cases) {
    const processLike = /** @type {EventEmitter & {exitCode?:number}} */ (new EventEmitter());
    const controller = createForegroundSignalController({ process: processLike });
    assert.equal(processLike.listenerCount('SIGINT'), 1);
    assert.equal(processLike.listenerCount('SIGTERM'), 1);

    processLike.emit(name);
    const reason = controller.signal.reason;
    assert.ok(reason instanceof PluginError);
    assert.equal(reason.code, 'JOB_INTERRUPTED');
    assert.equal(reason.details.signal, name);
    assert.equal(reason.details.exitCode, exitCode);
    assert.equal(processLike.exitCode, undefined);

    processLike.emit(name === 'SIGINT' ? 'SIGTERM' : 'SIGINT');
    assert.equal(controller.signal.reason, reason);
    assert.equal(processLike.exitCode, undefined);
    controller.cleanup();
    controller.cleanup();
    assert.equal(processLike.listenerCount('SIGINT'), 0);
    assert.equal(processLike.listenerCount('SIGTERM'), 0);
  }
});

test('background signal controller installs no process handlers', () => {
  const processLike = /** @type {EventEmitter & {exitCode?:number}} */ (new EventEmitter());
  const controller = createForegroundSignalController({ process: processLike, foreground: false });
  assert.equal(processLike.listenerCount('SIGINT'), 0);
  assert.equal(processLike.listenerCount('SIGTERM'), 0);
  assert.equal(controller.signal.aborted, false);
  controller.cleanup();
});

test('completion or abort returns the winner and handles a later losing rejection', async () => {
  const completed = new AbortController();
  assert.equal(await waitForCompletionOrAbort(Promise.resolve('done'), completed.signal), 'done');
  completed.abort(new PluginError('JOB_INTERRUPTED', 'late'));

  const interrupted = new AbortController();
  let rejectCompletion = (/** @type {unknown} */ error) => { void error; };
  const completion = new Promise((resolve, reject) => { rejectCompletion = reject; });
  const raced = waitForCompletionOrAbort(completion, interrupted.signal);
  const reason = new PluginError('JOB_INTERRUPTED', 'interrupted');
  interrupted.abort(reason);
  await assert.rejects(raced, (error) => error === reason);
  rejectCompletion(new Error('late completion failure'));
  await new Promise((resolve) => setImmediate(resolve));
});
