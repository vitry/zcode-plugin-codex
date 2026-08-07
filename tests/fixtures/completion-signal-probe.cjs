'use strict';

const process = require('node:process');

if (process.env.ZCODE_COMPLETION_SIGNAL_PROBE === '1') {
  const write = process.stdout.write;
  let emitted = false;
  process.stdout.write = function completionSignalWrite(chunk, ...args) {
    if (!emitted && String(chunk).length > 0) {
      emitted = true;
      process.emit('SIGINT');
    }
    return Reflect.apply(write, this, [chunk, ...args]);
  };
}
