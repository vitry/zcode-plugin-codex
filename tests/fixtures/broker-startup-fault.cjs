'use strict';

const fs = require('node:fs');
const net = require('node:net');
const process = require('node:process');

const mode = process.env.FAKE_BROKER_STARTUP_FAULT;
const marker = process.env.FAKE_BROKER_STARTUP_MARKER;

if (mode === 'before-main-exit') {
  const gate = process.env.FAKE_BROKER_STARTUP_GATE;
  if (marker) fs.writeFileSync(marker, JSON.stringify({ pid: process.pid }));
  const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
  while (!gate || !fs.existsSync(gate)) Atomics.wait(waitBuffer, 0, 0, 10);
  process.exit(23);
}

if (mode === 'before-publish') {
  const listen = net.Server.prototype.listen;
  net.Server.prototype.listen = function delayedListenCallback(...args) {
    const callbackIndex = args.findLastIndex((value) => typeof value === 'function');
    if (callbackIndex !== -1) {
      args[callbackIndex] = () => {
        if (marker) fs.writeFileSync(marker, JSON.stringify({ pid: process.pid }));
      };
    }
    return listen.apply(this, args);
  };
}

if (mode === 'after-publish') {
  const emit = net.Server.prototype.emit;
  const heldSockets = [];
  net.Server.prototype.emit = function holdStartupHealth(event, ...args) {
    if (event === 'connection') { heldSockets.push(args[0]); return true; }
    return emit.call(this, event, ...args);
  };
}

if (mode === 'stale-listener') {
  const endpoint = process.env.FAKE_BROKER_STARTUP_ENDPOINT;
  const server = net.createServer();
  server.listen(endpoint, () => {
    if (marker) fs.writeFileSync(marker, JSON.stringify({ pid: process.pid }));
  });
}
