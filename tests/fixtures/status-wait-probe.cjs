'use strict';

const { writeFileSync } = require('node:fs');
const process = require('node:process');

const marker = process.env.ZCODE_STATUS_WAIT_PROBE;
if (marker) {
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = function setTimeout(callback, milliseconds, ...args) {
    if (milliseconds === 50 && new Error().stack.includes('job-control.mjs')) writeFileSync(marker, 'waiting');
    return Reflect.apply(originalSetTimeout, this, [callback, milliseconds, ...args]);
  };
}
