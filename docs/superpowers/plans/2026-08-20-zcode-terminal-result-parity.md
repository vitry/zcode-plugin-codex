# ZCode Terminal Result Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve and expose authoritative ZCode terminal failures, make every finished job queryable, and normalize natural-language no-ID result invocations without weakening explicit argument validation.

**Architecture:** Add one foreground terminal-snapshot classifier at the boundary between the authoritative final `session/read` and existing success extraction. Keep persisted job records as the sole result/status read source, broaden implicit result selection to all terminal states, and reuse the existing safe job renderer for error-only results. Adapt Codex recorded prompts to the sibling plugin's optional `[job-id]` contract while retaining strict parsing for command-form invocations.

**Tech Stack:** Node.js ESM, `node:test`, durable JSON job state, ZCode Protocol snapshots, ESLint, TypeScript check mode.

---

## File map

- `scripts/lib/review.mjs`: classify the authoritative foreground terminal snapshot before success-result extraction.
- `scripts/lib/invocation.mjs`: distinguish direct command-form arguments from natural-language Skill references.
- `scripts/lib/job-control.mjs`: select the latest terminal owned job for implicit result lookup.
- `scripts/zcode-companion.mjs`: return stored failed/cancelled job reports while retaining immutable artifacts for successful jobs.
- `scripts/lib/render.mjs`: render bounded, control-safe persisted terminal errors.
- `tests/permissions.test.mjs`: focused terminal-snapshot classification coverage.
- `tests/invocation.test.mjs`: focused recorded-prompt normalization coverage.
- `tests/job-control.test.mjs`: terminal result-selection coverage.
- `tests/render-progress.test.mjs`: safe terminal-error rendering coverage.
- `tests/integration/companion.test.mjs`: result/status lifecycle and owner/workspace integration coverage.
- `CHANGELOG.md`: user-visible repair summary.

### Task 1: Classify foreground terminal failures

**Files:**
- Modify: `tests/permissions.test.mjs`
- Modify: `scripts/lib/review.mjs:141-146,335-375`

- [ ] **Step 1: Write failing terminal-classification tests**

Import `extractTerminalResult` beside `extractFinalResult`, then add:

```js
test('terminal extraction preserves an explicit ZCode failure before assistant extraction', () => {
  const snapshot = {
    projection: { status: 'error', lastError: { message: 'Network connection failed for the provider request.' } },
    messages: [assistant([{ type: 'text', text: 'partial output must not win' }])],
  };
  assert.throws(
    () => extractTerminalResult(snapshot, 'rescue'),
    (error) => error?.code === 'ZCODE_TURN_FAILED'
      && error.message === 'Network connection failed for the provider request.',
  );
});

test('terminal extraction fails closed for an ambiguous post-wait status', () => {
  assert.throws(
    () => extractTerminalResult({ projection: { status: 'running' }, messages: [] }, 'rescue'),
    { code: 'ZCODE_TERMINAL_STATE_INVALID' },
  );
});

test('terminal extraction delegates completed snapshots to current result extraction', () => {
  const snapshot = { projection: { status: 'completed' }, messages: [assistant([{ type: 'text', text: 'done' }])] };
  assert.equal(extractTerminalResult(snapshot, 'rescue'), 'done');
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test tests/permissions.test.mjs`

Expected: FAIL because `extractTerminalResult` is not exported.

- [ ] **Step 3: Implement the terminal boundary**

Add this public wrapper immediately before `extractFinalResult`:

```js
/** @param {any} snapshot @param {string} command @param {{beforeMessageIds?:Set<string>,inputId?:string,stateRevision?:number}} [turnBoundary] */
export function extractTerminalResult(snapshot, command, turnBoundary = {}) {
  const status = snapshot?.projection?.status;
  if (status === 'error') {
    const message = typeof snapshot?.projection?.lastError?.message === 'string'
      && snapshot.projection.lastError.message.trim()
      ? snapshot.projection.lastError.message
      : 'ZCode reported a terminal error.';
    throw new PluginError('ZCODE_TURN_FAILED', message, {
      category: 'runtime',
      remedy: 'Inspect the stored ZCode job status/result and retry after resolving the reported provider or runtime failure.',
    });
  }
  if (!['completed', 'idle'].includes(status)) {
    throw new PluginError('ZCODE_TERMINAL_STATE_INVALID', 'ZCode completion did not produce a success-compatible terminal state.', {
      category: 'protocol',
      remedy: 'Inspect the stored job status and retry.',
    });
  }
  return extractFinalResult(snapshot, command, turnBoundary);
}
```

Replace the foreground call with:

```js
const result = extractTerminalResult(finalSnapshot, job.command, turnBoundary);
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `node --test tests/permissions.test.mjs`

Expected: PASS, including the pre-existing partial/hidden-result rejection tests.

- [ ] **Step 5: Commit the terminal-classification slice**

```bash
git add scripts/lib/review.mjs tests/permissions.test.mjs
git commit -m "fix: preserve zcode terminal failures"
```

### Task 2: Normalize natural-language optional job IDs

**Files:**
- Create: `tests/invocation.test.mjs`
- Modify: `scripts/lib/invocation.mjs:17-27`

- [ ] **Step 1: Write failing parser tests**

Create `tests/invocation.test.mjs`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';

import { parseRecordedInvocation } from '../scripts/lib/invocation.mjs';

const id = 'a'.repeat(64);

test('embedded natural-language result reference becomes a no-ID lookup', () => {
  assert.deepEqual(parseRecordedInvocation('result', '通过 $zcode:result 可以查到结果吗').argv, ['result']);
});

test('embedded result reference accepts an immediately following exact ID', () => {
  assert.deepEqual(parseRecordedInvocation('result', `请查 $zcode:result ${id} 的结果`).argv, ['result', id]);
});

test('command-form result keeps strict malformed argument parsing', () => {
  assert.deepEqual(parseRecordedInvocation('result', '$zcode:result not-an-id').argv, ['result', 'not-an-id']);
});

test('status retains its existing option grammar', () => {
  assert.deepEqual(parseRecordedInvocation('status', '$zcode:status --wait --timeout-ms 1000').argv,
    ['status', '--wait', '--timeout-ms', '1000']);
});
```

- [ ] **Step 2: Run the parser test and verify RED**

Run: `node --test tests/invocation.test.mjs`

Expected: the Chinese no-ID case FAILS with trailing prose in `argv`.

- [ ] **Step 3: Implement host-specific optional-ID normalization**

Replace the marker branch with:

```js
if (match) {
  const rest = prompt.slice(match.index + match[0].length).trim();
  const commandForm = prompt.trimStart().startsWith(marker);
  if (commandForm || !['result', 'cancel'].includes(command)) {
    return { argv: [command, ...tokenize(rest)], explicit: true };
  }
  if (rest.startsWith('-') || rest.startsWith('$zcode:')) {
    return { argv: [command, ...tokenize(rest)], explicit: true };
  }
  const exactId = /^([a-f0-9]{64})(?=$|\s)/u.exec(rest)?.[1];
  return { argv: exactId ? [command, exactId] : [command], explicit: true };
}
```

- [ ] **Step 4: Run parser and argument tests and verify GREEN**

Run: `node --test tests/invocation.test.mjs tests/args.test.mjs`

Expected: PASS; strict command-form malformed IDs still reach ordinary argument validation.

- [ ] **Step 5: Commit the invocation slice**

```bash
git add scripts/lib/invocation.mjs tests/invocation.test.mjs
git commit -m "fix: normalize natural-language result lookup"
```

### Task 3: Make every terminal job result-eligible

**Files:**
- Modify: `tests/job-control.test.mjs:100-116`
- Modify: `scripts/lib/job-control.mjs:256-260`
- Modify: `tests/integration/companion.test.mjs`
- Modify: `scripts/zcode-companion.mjs:96-101`

- [ ] **Step 1: Write the failing selector assertion**

Extend the existing command-specific eligibility test with a newer cancelled job and assert terminal recency:

```js
const cancelled = await store.reserveJob({ workspace, ...reservation, readOnly: true, ownerTurnId: 'cancelled' });
await store.transitionJob(workspace, cancelled.id, ['queued'], 'cancelled');
await new Promise((resolve) => setTimeout(resolve, 2));
const active = await store.reserveJob({ workspace, ...reservation, readOnly: true, ownerTurnId: 'active' });

assert.equal((await controller.selectOwned(workspace, 'session-a', undefined, 'result')).id, cancelled.id);
```

- [ ] **Step 2: Run the selector test and verify RED**

Run: `node --test --test-name-pattern="implicit cancel and result" tests/job-control.test.mjs`

Expected: FAIL because implicit result still filters to successful artifacts.

- [ ] **Step 3: Broaden implicit result selection**

Change `eligibleImplicit` to:

```js
function eligibleImplicit(job, eligibility) {
  if (eligibility === 'cancel') return ['queued', 'running', 'cancelling'].includes(job.status);
  if (eligibility === 'result') return TERMINAL.has(job.status);
  return true;
}
```

- [ ] **Step 4: Write failing Companion result lifecycle tests**

In `tests/integration/companion.test.mjs`, reserve and finish owned jobs through `createStateStore`, then verify:

```js
test('result returns stored reports for failed and cancelled owned jobs', async () => {
  const context = await fixture();
  const store = createStateStore({ dataRoot: context.dataRoot });
  const failed = await store.reserveJob({ workspace: context.workspace, ownerSessionId: 'codex-session', ownerTurnId: 'failed-turn', command: 'rescue', readOnly: false, permissionSnapshot: { permissionMode: 'workspace-write' } });
  await store.transitionJob(context.workspace, failed.id, ['queued'], 'failed', { error: { code: 'ZCODE_TURN_FAILED', message: 'provider stream terminated' }, exitCode: 1 });
  const failedResult = await companion(context, ['result', failed.id]);
  assert.equal(failedResult.code, 0, `${failedResult.stderr}${failedResult.stdout}`);
  assert.equal(failedResult.json.job.status, 'failed');
  assert.equal(failedResult.json.job.error.message, 'provider stream terminated');

  const cancelled = await store.reserveJob({ workspace: context.workspace, ownerSessionId: 'codex-session', ownerTurnId: 'cancelled-turn', command: 'rescue', readOnly: false, permissionSnapshot: { permissionMode: 'workspace-write' } });
  await store.transitionJob(context.workspace, cancelled.id, ['queued'], 'cancelled', { exitCode: null });
  const latest = await companion(context, ['result']);
  assert.equal(latest.code, 0, `${latest.stderr}${latest.stdout}`);
  assert.equal(latest.json.job.id, cancelled.id);
  assert.equal(latest.json.job.status, 'cancelled');
});
```

- [ ] **Step 5: Run the integration test and verify RED**

Run: `node --test --test-name-pattern="result returns stored reports" tests/integration/companion.test.mjs`

Expected: FAIL with `JOB_RESULT_UNFINISHED`.

- [ ] **Step 6: Implement status-specific result retrieval**

Replace the result branch with:

```js
if (parsed.command === 'result') {
  const job = await controller.selectOwned(cwd, caller.sessionId, parsed.positionals[0], 'result');
  if (job.status === 'succeeded') {
    if (!job.resultArtifact) throw new PluginError('ZCODE_RESULT_MISSING', `Job ${job.id} succeeded without a stored result artifact.`, { category: 'state', remedy: `Run $zcode:status ${job.id}.` });
    return { job, result: await readResultArtifact({ dataRoot, workspace: cwd, artifact: job.resultArtifact }) };
  }
  if (['failed', 'cancelled'].includes(job.status)) return { job: publicJob(job, caller.sessionId, true) };
  throw new PluginError('JOB_RESULT_UNFINISHED', `Job ${job.id} is ${job.status}.`, { category: 'state', remedy: `Run $zcode:status ${job.id} --wait.`, details: { jobId: job.id, status: job.status } });
}
```

- [ ] **Step 7: Run selector and lifecycle tests and verify GREEN**

Run: `node --test tests/job-control.test.mjs tests/integration/companion.test.mjs`

Expected: PASS; successful artifacts remain byte-for-byte unchanged and explicit active jobs remain unfinished.

- [ ] **Step 8: Commit the terminal result slice**

```bash
git add scripts/lib/job-control.mjs scripts/zcode-companion.mjs tests/job-control.test.mjs tests/integration/companion.test.mjs
git commit -m "fix: expose finished zcode job outcomes"
```

### Task 4: Render persisted terminal errors safely

**Files:**
- Modify: `tests/render-progress.test.mjs`
- Modify: `scripts/lib/render.mjs:43-83`

- [ ] **Step 1: Write a failing bounded error-rendering test**

```js
test('terminal reports safely render their bounded persisted error', () => {
  const output = renderOutput({ job: {
    id, command: 'rescue', status: 'failed', phase: 'finalizing',
    createdAt: '2026-08-08T00:00:00.000Z', finishedAt: '2026-08-08T00:01:00.000Z',
    error: { code: 'ZCODE_TURN_FAILED', message: 'provider **failed**\nretry \u202Esoon' },
  } });
  assert.match(output, /Error: provider \\\*\\\*failed\\\*\\\* retry soon/);
  assert.doesNotMatch(output, /\u202E|\nretry/);

  const bounded = renderOutput({ job: {
    id, command: 'rescue', status: 'failed', createdAt: '2026-08-08T00:00:00.000Z',
    error: { message: 'x'.repeat(3_000) },
  } });
  const line = bounded.split('\n').find((entry) => entry.startsWith('Error: '));
  assert.ok(line);
  assert.ok(Buffer.byteLength(line.slice('Error: '.length)) <= 2_048);
});
```

- [ ] **Step 2: Run the renderer test and verify RED**

Run: `node --test --test-name-pattern="terminal reports" tests/render-progress.test.mjs`

Expected: FAIL because `renderJob` omits `job.error`.

- [ ] **Step 3: Reuse one safe stored-error formatter**

Add `const terminalError = renderStoredError(job.error);`, include:

```js
...(terminalError === null ? [] : [`Error: ${terminalError}`]),
```

and generalize the current cancellation helper:

```js
function renderStoredError(value) {
  const message = typeof value === 'string' ? value
    : value && typeof value === 'object' && 'message' in value
      && typeof value.message === 'string' ? value.message : null;
  if (message === null || message.trim().length === 0) return null;
  return boundUtf8(safeInline(message), 2_048);
}
```

Use `renderStoredError(job.lastCancelError)` for the existing cancellation line as well.

- [ ] **Step 4: Run renderer and Companion lifecycle tests and verify GREEN**

Run: `node --test --test-name-pattern="terminal reports|result returns stored reports" tests/render-progress.test.mjs tests/integration/companion.test.mjs`

Expected: PASS with no bidi controls, forged lines, or unbounded error output.

- [ ] **Step 5: Commit the renderer slice**

```bash
git add scripts/lib/render.mjs tests/render-progress.test.mjs
git commit -m "fix: render stored zcode terminal errors"
```

### Task 5: Document and verify the complete repair

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `docs/superpowers/specs/2026-08-20-zcode-terminal-result-parity-design.md`
- Track: `docs/superpowers/plans/2026-08-20-zcode-terminal-result-parity.md`

- [ ] **Step 1: Add the user-visible changelog entry**

Under `Unreleased`, add:

```markdown
- Fixed terminal ZCode failures being replaced by `ZCODE_RESULT_MISSING`; failed and cancelled jobs are now queryable through `$zcode:result`, stored errors appear in result/status output, and natural-language no-ID result references select the latest finished job in the owning Codex session.
```

- [ ] **Step 2: Run focused regression tests**

Run:

```bash
node --test tests/permissions.test.mjs tests/invocation.test.mjs tests/job-control.test.mjs tests/render-progress.test.mjs tests/integration/companion.test.mjs
```

Expected: PASS.

- [ ] **Step 3: Run repository verification**

Run:

```bash
npm run check:line-endings
npm run lint
npm run typecheck
npm test
```

Expected: all commands PASS. The `npm test` command includes the isolated marketplace snapshot build, so no checked-in generated marketplace tree is expected.

- [ ] **Step 4: Inspect the final diff and ownership boundaries**

Run:

```bash
git diff --check
git diff --stat
git status --short
```

Expected: only the files named by this plan plus the already approved spec/plan are tracked for the repair; investigation files under `log/` and root planning notes remain untracked and uncommitted.

- [ ] **Step 5: Commit documentation and final repair metadata**

```bash
git add CHANGELOG.md docs/superpowers/specs/2026-08-20-zcode-terminal-result-parity-design.md docs/superpowers/plans/2026-08-20-zcode-terminal-result-parity.md
git commit -m "docs: record zcode terminal result repair"
```
