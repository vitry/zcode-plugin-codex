'use strict';

const { writeFileSync } = require('node:fs');
const process = require('node:process');

const marker = process.env.ZCODE_SIGNAL_HANDLER_PROBE;
if (marker) {
  const originalOn = process.on;
  const originalRemoveListener = process.removeListener;
  const wrappers = new WeakMap();
  process.on = function on(event, listener) {
    if (event !== 'SIGINT') return originalOn.call(this, event, listener);
    const wrapped = function wrapped(...args) {
      writeFileSync(marker, 'handled');
      return Reflect.apply(listener, this, args);
    };
    wrappers.set(listener, wrapped);
    const result = originalOn.call(this, event, wrapped);
    writeFileSync(marker, 'ready');
    return result;
  };
  process.removeListener = function removeListener(event, listener) {
    return originalRemoveListener.call(this, event, wrappers.get(listener) ?? listener);
  };
}
