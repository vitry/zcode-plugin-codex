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

test('legacy string terminal errors render and absent public messages are omitted', () => {
  const terminal = { id, command: 'rescue', status: 'cancelled' };
  assert.match(renderOutput({ job: { ...terminal, error: 'legacy `failure`' } }), /\nError: legacy \\`failure\\`\n/u);

  for (const error of [undefined, '', ' \n\t ', '\u061c\u200e\u202e\u2069']) {
    const output = renderOutput({ job: { ...terminal, ...(error === undefined ? {} : { error }) } });
    assert.doesNotMatch(output, /^Error:/mu);
    assert.match(output, /^Status: cancelled$/mu);
  }
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
