import assert from 'node:assert/strict';
import test from 'node:test';

import { formatDirectInvocationError, formatDirectInvocationSuccess } from '../scripts/lib/direct-invocation-result.mjs';
import { PluginError } from '../scripts/lib/errors.mjs';
import { errorEnvelope, renderOutput } from '../scripts/lib/render.mjs';

const jobId = 'a'.repeat(64);
const createdAt = '2026-09-18T00:00:00.000Z';

// One ordinary terminal output: a succeeded review whose stored result renders
// with the derived Resumability Indicator beside it.
const terminal = {
  result: 'done',
  job: {
    id: jobId, command: 'review', status: 'succeeded', phase: 'finalizing',
    createdAt, startedAt: createdAt, finishedAt: createdAt, lastActivityAt: createdAt, exitCode: 0,
  },
};

// One nonterminal Status snapshot: an active Rescue job with bounded progress.
const statusSnapshot = {
  job: {
    id: jobId, command: 'rescue', status: 'running', phase: 'waiting',
    createdAt, startedAt: createdAt, lastActivityAt: createdAt,
    progressPreview: ['ZCode started the delegated turn.'],
  },
};

// One true-background queued acknowledgement with its closed transport literals.
const queued = {
  type: 'background',
  job: { id: jobId, command: 'rescue', status: 'queued', createdAt },
  resultCommand: '$zcode:result',
  statusCommand: '$zcode:status',
};

// One Rescue choice handoff and one parent replan directive.
const needsChoice = { type: 'needs-choice', choices: ['--resume', '--fresh'] };
const parentReplan = { type: 'parent-replan', command: 'rescue' };

// One ordinary PluginError and one domain interruption with its signal exit code.
const pluginError = new PluginError('INVOCATION_COMMAND_INVALID', 'The direct companion command is invalid.', {
  category: 'validation', remedy: 'Use the constant command documented by the installed skill.',
});
const interrupted = new PluginError('JOB_INTERRUPTED', 'Foreground ZCode job interrupted by SIGINT.', {
  category: 'interruption', remedy: 'Retry the command when you are ready.', details: { signal: 'SIGINT', exitCode: 130 },
});

test('success mapping classifies control handoffs and keeps the shell exit code', () => {
  assert.deepEqual(formatDirectInvocationSuccess(needsChoice), {
    text: renderOutput(needsChoice), outcome: 'needs-choice', isError: false, exitCode: 3, stderr: '',
  });
  assert.equal(formatDirectInvocationSuccess(statusSnapshot).outcome, 'terminal');
  assert.equal(formatDirectInvocationSuccess(queued).outcome, 'terminal');
  assert.equal(formatDirectInvocationSuccess(parentReplan).outcome, 'parent-replan');
  assert.equal(formatDirectInvocationSuccess(parentReplan).exitCode, 0);
  assert.equal(formatDirectInvocationSuccess(parentReplan).isError, false);
  assert.equal(formatDirectInvocationSuccess(parentReplan).stderr, '');
});

test('success text equals the CLI stdout bytes for every fixture', () => {
  assert.equal(formatDirectInvocationSuccess(terminal).text, 'done\n');
  assert.equal(formatDirectInvocationSuccess(needsChoice).text, '{"type":"needs-choice","choices":["--resume","--fresh"]}\n');
  assert.equal(formatDirectInvocationSuccess(parentReplan).text, '{"type":"parent-replan","command":"rescue"}\n');
  assert.equal(formatDirectInvocationSuccess(queued).text,
    `Rescue job ${jobId} queued for background execution.\nCheck progress with $zcode:status; read the final result with $zcode:result.\n`);
  // The nonterminal snapshot renders elapsed time, so both sides render under
  // one frozen clock to pin byte-for-byte transport parity deterministically.
  const originalNow = Date.now;
  Date.now = () => Date.parse('2026-09-18T00:05:00.000Z');
  try {
    const formatted = formatDirectInvocationSuccess(statusSnapshot);
    assert.equal(formatted.text, renderOutput(statusSnapshot));
    assert.match(formatted.text, /Status: running/);
    assert.match(formatted.text, /Elapsed: 5m 0s/);
  } finally { Date.now = originalNow; }
});

test('ordinary errors render the bounded envelope with the validation exit code', () => {
  const formatted = formatDirectInvocationError(pluginError);
  assert.equal(formatted.isError, true);
  assert.equal(formatted.outcome, 'error');
  assert.equal(formatted.stderr, '');
  assert.equal(formatted.exitCode, 2);
  assert.equal(formatted.text, renderOutput(errorEnvelope(pluginError), { json: true }));
  assert.equal(formatted.text,
    '{"error":{"code":"INVOCATION_COMMAND_INVALID","category":"validation","message":"The direct companion command is invalid.",'
    + '"remedy":"Use the constant command documented by the installed skill.","details":{}}}\n');
  const runtime = formatDirectInvocationError(new PluginError('ZCODE_REQUEST_FAILED', 'The ZCode request failed.', { category: 'runtime' }));
  assert.equal(runtime.isError, true);
  assert.equal(runtime.outcome, 'error');
  assert.equal(runtime.exitCode, 1);
});

test('the domain interruption keeps empty stdout, bounded stderr, and the signal exit code', () => {
  const formatted = formatDirectInvocationError(interrupted);
  assert.equal(formatted.text, '');
  assert.equal(formatted.stderr, 'Interrupted by SIGINT.\n');
  assert.equal(formatted.exitCode, 130);
  assert.equal(formatted.outcome, 'error');
  assert.equal(formatted.isError, true);
  const unattributed = formatDirectInvocationError(new PluginError('JOB_INTERRUPTED', 'cancel after claim', { category: 'interruption' }));
  assert.equal(unattributed.text, '');
  assert.equal(unattributed.stderr, 'Interrupted by signal.\n');
  assert.equal(unattributed.exitCode, 0);
  assert.equal(unattributed.outcome, 'error');
});
