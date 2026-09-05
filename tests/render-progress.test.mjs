import assert from 'node:assert/strict';
import test from 'node:test';

import { renderOutput } from '../scripts/lib/render.mjs';

const id = 'a'.repeat(64);

test('renders a bounded detailed active-job progress report with elapsed time', () => {
  const originalNow = Date.now;
  Date.now = () => Date.parse('2026-08-08T00:05:00.000Z');
  try {
    const output = renderOutput({
      job: {
        id,
        command: 'rescue',
        status: 'running',
        phase: 'waiting',
        createdAt: '2026-08-07T23:59:00.000Z',
        startedAt: '2026-08-08T00:00:00.000Z',
        updatedAt: '2026-08-08T00:04:30.000Z',
        lastActivityAt: '2026-08-08T00:04:00.000Z',
        progressPreview: [
          'ZCode started the delegated turn.',
          'Running command: npm test.',
          'ZCode is retrying the model request.',
          '**ZCode completed a tool call.**',
        ],
      },
      modelPolicy: { defaultModel: 'quick', aliases: ['quick'] },
    });

    assert.match(output, new RegExp(`Job: ${id}`));
    assert.match(output, /Command: rescue/);
    assert.match(output, /Status: running/);
    assert.match(output, /Phase: waiting/);
    assert.match(output, /Created: 2026-08-07T23:59:00\.000Z/);
    assert.match(output, /Started: 2026-08-08T00:00:00\.000Z/);
    assert.match(output, /Finished: —/);
    assert.match(output, /Elapsed: 5m 0s/);
    assert.match(output, /Last activity: 2026-08-08T00:04:00\.000Z/);
    assert.match(output, /Progress:\n {2}- ZCode started the delegated turn\.\n {2}- Running command: npm test\.\n {2}- ZCode is retrying the model request\.\n {2}- \\\*\\\*ZCode completed a tool call\.\\\*\\\*/);
    assert.match(output, /Model policy: default=quick; aliases=quick/);
    assert.doesNotMatch(output, / {2}- \*\*ZCode/);
    assert.doesNotMatch(output, /Last cancellation error:/);
  } finally {
    Date.now = originalNow;
  }
});

test('detailed status renders one safe bounded absolute log path after timing and before progress', () => {
  const logFile = `/private/zcode/jobs/${id}.log`;
  const output = renderOutput({
    job: {
      id, command: 'review', status: 'running', createdAt: '2026-08-08T00:00:00.000Z',
      logFile, progressPreview: ['working'], owned: true, owner: 'same-owner',
    },
  });
  assert.equal(output.split('\n').filter((/** @type {string} */ line) => line.startsWith('Log: ')).length, 1);
  const elapsedAt = output.indexOf('Elapsed: ');
  const logAt = output.indexOf(`Log: ${logFile}`);
  const progressAt = output.indexOf('Progress:');
  assert.ok(elapsedAt >= 0 && logAt > elapsedAt && progressAt > logAt);

  const bounded = renderOutput({ job: { id, command: 'review', status: 'running', logFile: `/${'a'.repeat(6_000)}`, owned: true, owner: 'same-owner' } });
  const logLine = bounded.split('\n').find((/** @type {string} */ line) => line.startsWith('Log: '));
  assert.ok(logLine);
  assert.ok(Buffer.byteLength(logLine.slice('Log: '.length)) <= 4_096);
  assert.match(logLine, /\.\.\.$/);
});

test('detailed status bounds the rendered log path after Markdown escaping', () => {
  const output = renderOutput({
    job: {
      id, command: 'review', status: 'running', owned: true, owner: 'same-owner',
      logFile: `/${'*'.repeat(3_000)}.log`,
    },
  });
  const lines = output.split('\n').filter((/** @type {string} */ line) => line.startsWith('Log: '));
  assert.equal(lines.length, 1);
  const renderedPath = lines[0].slice('Log: '.length);
  assert.ok(Buffer.byteLength(renderedPath) <= 4_096);
  assert.match(renderedPath, /^\/\\\*/u);
  assert.match(renderedPath, /\.\.\.$/u);
  const trailingBackslashes = renderedPath.slice(0, -3).match(/\\+$/u)?.[0].length ?? 0;
  assert.equal(trailingBackslashes % 2, 0);
});

test('detailed status preserves consecutive ordinary spaces in a canonical log path', () => {
  const logFile = `/private/zcode data  root/jobs/${id}.log`;
  const output = renderOutput({
    job: { id, command: 'review', status: 'running', owned: true, owner: 'same-owner', logFile },
  });
  assert.match(output, new RegExp(`^Log: ${logFile}$`, 'mu'));
});

test('invalid log paths never render and compact lists omit logs', () => {
  for (const logFile of [undefined, '', 'relative/job.log', '/safe/job.log\nforged', '/safe/job.log\u2028forged', '/safe/job.log\u2029forged', 42]) {
    const job = { id, command: 'review', status: 'running', owned: true, owner: 'same-owner', ...(logFile === undefined ? {} : { logFile }) };
    assert.doesNotMatch(renderOutput({ job }), /^Log:/mu);
  }
  assert.doesNotMatch(renderOutput({ job: { id, command: 'review', status: 'running', hasOwner: true, logFile: `/private/${id}.log` } }), /^Log:/mu);
  assert.doesNotMatch(renderOutput({
    jobs: [{ id, command: 'review', status: 'running', owner: 'same-owner', logFile: `/private/${id}.log` }],
  }), /Log:|\.log/u);
});

test('detailed status safely renders a bounded last cancellation error', () => {
  const job = {
    id,
    command: 'rescue',
    status: 'running',
    createdAt: '2026-08-08T00:00:00.000Z',
    updatedAt: '2026-08-08T00:00:01.000Z',
    lastCancelError: 'stop\u061c **refused**\u200e\nretry \u202Esoon\u200F ~~later~~\u0000\u0085',
  };
  const output = renderOutput({ job });
  assert.match(output, /Last cancellation error: stop \\\*\\\*refused\\\*\\\* retry soon \\~\\~later\\~\\~/);
  assert.doesNotMatch(output, /[\u061C\u200E\u200F\u202E]|\nretry/u);

  const raw = renderOutput({ job: { ...job, lastCancelError: 'x'.repeat(3_000) } });
  const line = raw.split('\n').find((/** @type {string} */ entry) => entry.startsWith('Last cancellation error: '));
  assert.ok(line);
  const renderedError = line.slice('Last cancellation error: '.length);
  assert.ok(Buffer.byteLength(renderedError) <= 2_048);
  assert.match(renderedError, /\.\.\.$/);
});

test('renders terminal duration and keeps result rendering unchanged', () => {
  const job = {
    id,
    command: 'review',
    status: 'succeeded',
    phase: 'finalizing',
    createdAt: '2026-08-08T00:00:00.000Z',
    startedAt: '2026-08-08T00:00:01.000Z',
    finishedAt: '2026-08-08T00:01:03.000Z',
    updatedAt: '2026-08-08T00:01:03.000Z',
    lastActivityAt: '2026-08-08T00:01:02.000Z',
    progressPreview: ['ZCode completed the delegated turn.'],
  };
  const output = renderOutput({ job });
  assert.match(output, /Finished: 2026-08-08T00:01:03\.000Z/);
  assert.match(output, /Duration: 1m 2s/);
  assert.doesNotMatch(output, /Elapsed:/);
  assert.equal(renderOutput({ job, result: 'unchanged result' }), 'unchanged result\n');
});

test('failed terminal jobs render one safe bounded object error message', () => {
  const output = renderOutput({
    job: {
      id,
      command: 'review',
      status: 'failed',
      error: {
        message: `failure\u061c **unsafe**\u200e\nnext \u202Eline\u200F ~~later~~\u0000\u0085 ${'界'.repeat(800)}`,
        code: 'PRIVATE_CODE',
        details: { token: 'PRIVATE_TOKEN' },
      },
    },
  });
  const errorLines = output.split('\n').filter((/** @type {string} */ entry) => entry.startsWith('Error: '));
  assert.equal(errorLines.length, 1);
  const message = errorLines[0].slice('Error: '.length);
  assert.match(message, /^failure \\\*\\\*unsafe\\\*\\\* next line \\~\\~later\\~\\~ /u);
  assert.match(message, /\.\.\.$/u);
  assert.ok(Buffer.byteLength(message) <= 2_048);
  assert.equal([...message].some((character) => {
    const code = character.codePointAt(0);
    return code <= 0x1f || code >= 0x7f && code <= 0x9f || code === 0x061c || code === 0x200e || code === 0x200f
      || code >= 0x202a && code <= 0x202e || code >= 0x2066 && code <= 0x2069 || code === 0xfffd;
  }), false);
  assert.doesNotMatch(output, /PRIVATE_CODE|PRIVATE_TOKEN|details|token/u);
});

test('bounded terminal error messages do not leave a dangling Markdown escape', () => {
  const output = renderOutput({
    job: { id, command: 'review', status: 'failed', error: { message: `${'a'.repeat(2_044)}*tail` } },
  });
  const line = output.split('\n').find((/** @type {string} */ entry) => entry.startsWith('Error: '));
  assert.ok(line);
  const message = line.slice('Error: '.length);
  assert.ok(Buffer.byteLength(message) <= 2_048);
  assert.equal(message.endsWith('...'), true);
  const trailingBackslashes = message.slice(0, -3).match(/\\+$/u)?.[0].length ?? 0;
  assert.equal(trailingBackslashes % 2, 0);

  const pairedOutput = renderOutput({
    job: { id, command: 'review', status: 'failed', error: { message: `${'a'.repeat(2_043)}\\tail` } },
  });
  const pairedLine = pairedOutput.split('\n').find((/** @type {string} */ entry) => entry.startsWith('Error: '));
  assert.ok(pairedLine);
  const pairedMessage = pairedLine.slice('Error: '.length);
  assert.ok(Buffer.byteLength(pairedMessage) <= 2_048);
  assert.equal(pairedMessage.endsWith('\\\\...'), true);
});

test('legacy string terminal errors render and absent public messages are omitted', () => {
  const terminal = { id, command: 'rescue', status: 'cancelled' };
  assert.match(renderOutput({ job: { ...terminal, error: 'legacy `failure`' } }), /\nError: legacy \\`failure\\`\n/u);

  for (const error of [undefined, '', ' \n\t ', '\u061c\u200e\u202e\u2069']) {
    const output = renderOutput({ job: { ...terminal, ...(error === undefined ? {} : { error }) } });
    assert.doesNotMatch(output, /^Error:/mu);
    assert.match(output, /^Status: cancelled$/mu);
  }
});

test('terminal views expose resumable and Stop Cause without a ZCode session id', () => {
  const cancelled = {
    id,
    command: 'rescue',
    status: 'cancelled',
    createdAt: '2026-09-02T00:00:00.000Z',
    startedAt: '2026-09-02T00:00:01.000Z',
    finishedAt: '2026-09-02T00:01:00.000Z',
    lastActivityAt: '2026-09-02T00:00:59.000Z',
    error: { message: 'stopped at the Host SessionEnd Boundary' },
    zcodeSessionId: 'private-zcode-session',
  };
  const output = renderOutput({ type: 'job', job: { ...cancelled, resumable: true, stopCause: 'session-end' } });
  assert.match(output, /Resumable: yes/);
  assert.match(output, /Rescue hint: run \$zcode:rescue --resume to continue this session/);
  const cancelJson = renderOutput({ type: 'job', job: { ...cancelled, resumable: true } }, { json: true });
  assert.doesNotMatch(cancelJson, /private-zcode-session/);
  const resultOutput = renderOutput({ result: 'resumable result', job: { ...cancelled, resumable: true } });
  assert.match(resultOutput, /Resumable: yes/);
  assert.match(resultOutput, /Rescue hint: run \$zcode:rescue --resume to continue this session/);
  assert.doesNotMatch(resultOutput, /Error:/);
  assert.match(output, /Stop cause: session-end/);
  assert.doesNotMatch(output, /zcodeSessionId/);

  const blocked = renderOutput({ type: 'job', job: { ...cancelled, resumable: false } });
  assert.match(blocked, /Resumable: no/);
  assert.match(renderOutput({ type: 'job', job: { ...cancelled, resumable: true, stopCause: 'host-coordination-loss' } }), /Stop cause: host-coordination-loss/);
  assert.doesNotMatch(renderOutput({ type: 'job', job: cancelled }), /Resumable:|Stop cause:/u);
});

test('successful result rendering wins over terminal job error rendering', () => {
  assert.equal(renderOutput({
    result: 'exact successful result',
    job: { id, command: 'review', status: 'failed', error: { message: 'do not render' } },
  }), 'exact successful result\n');
});

test('compact job lists include phase and only the latest safe preview', () => {
  const output = renderOutput({
    jobs: [{
      id,
      status: 'running',
      command: 'rescue',
      owner: 'same-owner',
      phase: 'running',
      lastActivityAt: '2026-08-08T00:04:00.000Z',
      progressPreview: ['old preview', 'latest `preview`\nforged \u202Eline ~~strike~~'],
    }],
  });

  assert.doesNotMatch(output, /old preview/);
  assert.match(output, /phase=running/);
  assert.match(output, /activity=2026-08-08T00:04:00\.000Z/);
  assert.match(output, /latest=latest \\`preview\\` forged line \\~\\~strike\\~\\~/);
  assert.doesNotMatch(output, /\u202E/);
  assert.equal(output.trim().split('\n').length, 1);
});

test('compact legacy and queued jobs show explicit missing progress placeholders', () => {
  assert.equal(renderOutput({
    jobs: [{ id, status: 'queued', command: 'review', owner: 'same-owner' }],
  }), `${id} queued review same-owner phase=— activity=—\n`);
});

test('JSON redaction strips internal Host lifecycle execution-ownership proof', () => {
  const job = {
    id, command: 'rescue', status: 'cancelled', owned: true, owner: 'same-owner',
    ownerLifecycleEpoch: 'd'.repeat(64), executionOwner: 'host-child', hostPlacement: 'background',
    stopIntent: { version: 1, cause: 'session-end', requestedAt: '2026-09-02T00:00:00.000Z' },
    stopCause: 'session-end', resumable: true,
  };
  const rendered = renderOutput({ job }, { json: true });
  assert.doesNotMatch(rendered, /ownerLifecycleEpoch|executionOwner|hostPlacement|stopIntent/u);
  assert.match(rendered, /"stopCause":"session-end"/u);
  assert.match(rendered, /"resumable":true/u);
  assert.equal(JSON.parse(rendered).job.id, id);
});

test('JSON exposes only a valid exact-owner single-job probe while every other view redacts it', () => {
  const progressProbe = {
    state: 'online', subscriptionAcknowledged: true, framesReceived: 1,
    acceptedInitial: 0, acceptedOnline: 1, acceptedRecovery: 0,
    rejected: { 'wire-version': 0, 'envelope-shape': 0, sequence: 0, topic: 0, 'row-kind': 0, 'row-shape': 0 },
    snapshotFallbackActive: false, snapshotFallbackUnavailable: false,
  };
  const value = {
    job: {
      id, status: 'running', phase: 'running', progressPreview: ['safe'], owned: true, owner: 'same-owner', progressProbe,
    },
    permissionSnapshot: { mode: 'workspace-write' },
    rescueJobSpecCommitment: 'a'.repeat(64),
    rescueLegacyJobSpecProof: { version: 1, kind: 'markerless-migration', specDigest: 'b'.repeat(64) },
    nested: { executionCapability: 'secret', visible: true },
  };
  assert.deepEqual(JSON.parse(renderOutput(value, { json: true })), {
    job: { id, status: 'running', phase: 'running', progressPreview: ['safe'], owned: true, owner: 'same-owner', progressProbe },
    nested: { visible: true },
  });
  assert.doesNotMatch(renderOutput(value), /progressProbe|subscriptionAcknowledged|framesReceived/);

  const invalid = { ...value, job: { ...value.job, progressProbe: { ...progressProbe, marker: 'PROBE_INTERNAL' } } };
  assert.equal(Object.hasOwn(JSON.parse(renderOutput(invalid, { json: true })).job, 'progressProbe'), false);
  assert.doesNotMatch(renderOutput(invalid, { json: true }), /PROBE_INTERNAL/);

  for (const hidden of [
    { job: { ...value.job, owned: undefined, owner: undefined } },
    { jobs: [value.job] },
    { job: { ...value.job, owned: undefined, owner: undefined, hasOwner: true } },
  ]) assert.equal(Object.hasOwn((JSON.parse(renderOutput(hidden, { json: true })).job ?? JSON.parse(renderOutput(hidden, { json: true })).jobs[0]), 'progressProbe'), false);
});

test('JSON exposes logFile only for an exact-owner single-job projection', () => {
  const logFile = `/private/zcode/jobs/${id}.log`;
  const exact = { job: { id, status: 'running', owned: true, owner: 'same-owner', logFile } };
  assert.equal(JSON.parse(renderOutput(exact, { json: true })).job.logFile, logFile);
  for (const hidden of [
    { job: { ...exact.job, owned: undefined, owner: undefined } },
    { job: { ...exact.job, owned: undefined, owner: undefined, hasOwner: true } },
    { jobs: [exact.job] },
    { type: 'rescue-status', status: 'running', logFile },
  ]) assert.doesNotMatch(renderOutput(hidden, { json: true }), /logFile|\.log/u);
});
