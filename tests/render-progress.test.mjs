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
          'ZCode started a tool call.',
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
    assert.match(output, /Progress:\n {2}- ZCode started the delegated turn\.\n {2}- ZCode started a tool call\.\n {2}- ZCode is retrying the model request\.\n {2}- \\\*\\\*ZCode completed a tool call\.\\\*\\\*/);
    assert.match(output, /Model policy: default=quick; aliases=quick/);
    assert.doesNotMatch(output, / {2}- \*\*ZCode/);
  } finally {
    Date.now = originalNow;
  }
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

test('JSON output remains structurally unchanged and redacted', () => {
  const value = {
    job: { id, status: 'running', phase: 'running', progressPreview: ['safe'] },
    permissionSnapshot: { mode: 'workspace-write' },
    nested: { executionCapability: 'secret', visible: true },
  };
  assert.deepEqual(JSON.parse(renderOutput(value, { json: true })), {
    job: { id, status: 'running', phase: 'running', progressPreview: ['safe'] },
    nested: { visible: true },
  });
});
