import assert from 'node:assert/strict';
import test from 'node:test';

import { codexLaunch, npmLaunch, npxLaunch } from '../scripts/lib/tool-launch.mjs';

const hostileArgs = ['plugin', 'add', 'zcode@vitry', '--label', 'safe & echo injected'];

test('win32 Codex launch uses its JavaScript entry point without a command shim', () => {
  const launch = codexLaunch(hostileArgs, {
    platform: 'win32',
    execPath: 'C:\\Node\\node.exe',
    root: 'C:\\repo',
  });

  assert.equal(launch.command, 'C:\\Node\\node.exe');
  assert.deepEqual(launch.args, [
    'C:\\repo\\node_modules\\@openai\\codex\\bin\\codex.js',
    ...hostileArgs,
  ]);
  assert.deepEqual(launch.options, { shell: false });
  assert.doesNotMatch(launch.command, /\.cmd$/i);
});

test('win32 npm and npx launches preserve argument boundaries without a shell', () => {
  const options = /** @type {const} */ ({
    platform: 'win32',
    execPath: 'C:\\Node\\node.exe',
    env: { npm_execpath: 'C:\\Node\\node_modules\\npm\\bin\\npm-cli.js' },
  });

  const npm = npmLaunch(hostileArgs, options);
  const npx = npxLaunch(hostileArgs, options);

  assert.deepEqual(npm, {
    command: 'C:\\Node\\node.exe',
    args: ['C:\\Node\\node_modules\\npm\\bin\\npm-cli.js', ...hostileArgs],
    options: { shell: false },
  });
  assert.deepEqual(npx, {
    command: 'C:\\Node\\node.exe',
    args: ['C:\\Node\\node_modules\\npm\\bin\\npx-cli.js', ...hostileArgs],
    options: { shell: false },
  });
  assert.equal(npm.args.at(-1), hostileArgs.at(-1));
  assert.equal(npx.args.at(-1), hostileArgs.at(-1));
  assert.doesNotMatch(`${npm.command} ${npx.command}`, /\.cmd(?:\s|$)/i);
});

test('npm entry points are derived from the Node installation when npm_execpath is absent', () => {
  assert.equal(
    npmLaunch([], { platform: 'linux', execPath: '/opt/node/bin/node', env: {} }).args[0],
    '/opt/node/lib/node_modules/npm/bin/npm-cli.js',
  );
  assert.equal(
    npxLaunch([], { platform: 'win32', execPath: 'C:\\Node\\node.exe', env: {} }).args[0],
    'C:\\Node\\node_modules\\npm\\bin\\npx-cli.js',
  );
});

test('external CODEX_BINARY accepts only absolute native or JavaScript tools', () => {
  assert.deepEqual(codexLaunch(['plugin', 'list'], { platform: 'win32', execPath: 'C:\\Node\\node.exe', env: { CODEX_BINARY: 'C:\\Tools\\codex.js' } }), {
    command: 'C:\\Node\\node.exe', args: ['C:\\Tools\\codex.js', 'plugin', 'list'], options: { shell: false },
  });
  assert.deepEqual(codexLaunch(['plugin', 'list'], { platform: 'win32', execPath: 'C:\\Node\\node.exe', env: { CODEX_BINARY: 'C:\\Tools\\codex.exe' } }), {
    command: 'C:\\Tools\\codex.exe', args: ['plugin', 'list'], options: { shell: false },
  });
  assert.throws(() => codexLaunch([], { platform: 'win32', env: { CODEX_BINARY: 'C:\\Tools\\codex.cmd' } }), /absolute native executable/);
  assert.throws(() => codexLaunch([], { platform: 'win32', env: { CODEX_BINARY: 'relative.js' } }), /absolute native executable/);
});
