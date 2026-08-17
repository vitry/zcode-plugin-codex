# Rescue Live Progress Relay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make real ZCode semantic progress visible in the Rescue child and as bounded coarse liveness updates in `/root`, while preserving the original foreground handle, final stdout, and terminal-exit authority.

**Architecture:** Relax only the observational conversation-frame layer so unknown rows and sequence gaps cannot permanently silence known safe activity. Add a deep relay-wire module that converts already-validated progress into fixed, content-free records; the foreground child relays only those records and may query one hook-bound status sidecar. Keep detailed stderr, durable preview, final stdout, and completion as separate sinks with separate authority.

**Tech Stack:** Node.js ESM, `node:test`, JSON-RPC over stdio, Codex collaboration tools, TOML Agent Role templates, GitHub Actions.

---

## File and Responsibility Map

- `scripts/lib/conversation-progress.mjs`: validate and interpret untrusted conversation frames; ignore unsupported rows without weakening envelope bounds.
- `scripts/lib/progress.mjs`: schedule semantic events, durable preview, child stderr, heartbeat, and the new coarse relay callback.
- `scripts/lib/rescue-progress-relay.mjs`: own the versioned content-free relay record, fixed code/message maps, serialization, and validation.
- `scripts/zcode-companion.mjs`: expose the exact `invoke-status rescue` direct entry and write relay records to stderr.
- `scripts/lib/job-control.mjs`: select and render only the job bound to the trusted Rescue executor.
- `agents/zcode-rescue.toml.template`: define same-handle polling, exact relay forwarding, and exact no-argument status intents for the managed Role.
- `skills/rescue/SKILL.md`: define the identical generic route and parent acceptance contract.
- `tests/helpers/rescue-skill-contract.mjs`: keep named and generic route text/authority assertions in one anchored parser.
- `tests/helpers/codex-rescue-qualification.mjs`: qualify original-handle progress relay and terminal evidence without treating progress as completion.
- `tests/fixtures/fake-zcode-cli.mjs`: deterministic real-shape incompatibility, relay, status, delay, and completion gates.
- `marketplace/plugins/zcode/**`: exact generated mirrors of every changed runtime, skill, Role, and documentation file.

### Task 1: Make Conversation Progress Compatible With Observed Frames

**Files:**
- Modify: `scripts/lib/conversation-progress.mjs`
- Modify: `tests/conversation-progress.test.mjs`
- Modify: `tests/fixtures/fake-zcode-cli.mjs`
- Modify: `tests/integration/companion.test.mjs`
- Mirror: `marketplace/plugins/zcode/scripts/lib/conversation-progress.mjs`

- [ ] **Step 1: Add the observed-traffic RED fixture**

Add a sanitized frame sequence containing a valid subscription/topic, a known turn row, unsupported row kinds interleaved with known tool rows, duplicate/stale delivery, and a logical sequence gap. Assert that unsupported rows remain private and later known rows still emit progress:

```js
test('observed unknown rows and sequence gaps do not silence later known progress', async () => {
  const describer = await createConversationProgressDescriber({
    sessionId: 'session-observed',
    subscriptionId: 'subscription-observed',
    workspace,
  });

  assert.equal((await describer.observe(frame({ ordinal: 1, fromSeq: 1, toSeq: 1,
    deltas: [unknownRow('PRIVATE_UNKNOWN_ROW')] }), observedAt)).disposition, 'accepted');
  const gap = await describer.observe(frame({ ordinal: 4, fromSeq: 4, toSeq: 4,
    deltas: [toolRow({ toolCallId: 'tool-safe', toolName: 'Read', status: 'running' })] }), observedAt);
  const later = await describer.observe(frame({ ordinal: 5, fromSeq: 5, toSeq: 5,
    deltas: [toolRow({ toolCallId: 'tool-safe', toolName: 'Read', status: 'success' })] }), observedAt);

  assert.equal(gap.reason, 'sequence');
  assert.deepEqual(later.events.map((event) => event.message), ['Tool Read completed.']);
  assert.doesNotMatch(JSON.stringify([gap, later]), /PRIVATE_UNKNOWN_ROW/);
});
```

- [ ] **Step 2: Run the focused RED tests**

Run:

```bash
node --test tests/conversation-progress.test.mjs tests/integration/companion.test.mjs
```

Expected: the new test fails because an unsupported row rejects the complete frame or the gap leaves `needsRecovery` latched and later known activity is ignored.

- [ ] **Step 3: Implement tolerant observational row processing**

Keep envelope validation strict, but classify unsupported rows as ignored and make gaps diagnostic rather than a permanent semantic blockade. Use per-row lifecycle deduplication as the safety boundary:

```js
function classifyDelta(delta) {
  if (!plainObject(delta) || !SUPPORTED_OPS.has(delta.op)) return rejected('row-shape');
  if (delta.row === undefined) return acceptedDelta(null);
  if (!plainObject(delta.row) || !safeRowEnvelope(delta.row)) return rejected('row-shape');
  if (!SUPPORTED_ROW_KINDS.has(delta.row.kind)) return acceptedDelta(null);
  return validateKnownRow(delta.row);
}

function noteSequence(frame) {
  const stale = lastOrdinal !== undefined && frame.ordinal <= lastOrdinal;
  if (stale) return 'stale';
  const gap = lastOrdinal !== undefined
    && (frame.ordinal !== lastOrdinal + 1 || frame.fromSeq !== lastSeq + 1);
  lastOrdinal = frame.ordinal;
  lastSeq = Math.max(lastSeq ?? frame.toSeq, frame.toSeq);
  return gap ? 'gap' : 'next';
}
```

Do not render unknown row content. Keep unsafe IDs, oversized fields, foreign topic/subscription, invalid timestamps, malformed known rows, and collection overflow fail-closed.

- [ ] **Step 4: Verify GREEN and regression privacy**

Run:

```bash
node --test tests/conversation-progress.test.mjs tests/progress.test.mjs tests/integration/companion.test.mjs
```

Expected: all tests pass; the observed-traffic case emits later known progress and no private sentinel.

- [ ] **Step 5: Sync the runtime mirror and commit**

Run:

```bash
cp scripts/lib/conversation-progress.mjs marketplace/plugins/zcode/scripts/lib/conversation-progress.mjs
cmp scripts/lib/conversation-progress.mjs marketplace/plugins/zcode/scripts/lib/conversation-progress.mjs
git add scripts/lib/conversation-progress.mjs marketplace/plugins/zcode/scripts/lib/conversation-progress.mjs tests/conversation-progress.test.mjs tests/fixtures/fake-zcode-cli.mjs tests/integration/companion.test.mjs
git commit -m "fix: tolerate observed ZCode progress frames"
```

Expected: `cmp` exits 0 and the commit contains only Task 1 files.

### Task 2: Add a Content-Free Parent Relay Wire

**Files:**
- Create: `scripts/lib/rescue-progress-relay.mjs`
- Create: `tests/rescue-progress-relay.test.mjs`
- Modify: `scripts/lib/progress.mjs`
- Modify: `scripts/lib/review.mjs`
- Modify: `scripts/zcode-companion.mjs`
- Modify: `tests/progress.test.mjs`
- Modify: `tests/job-control.test.mjs`
- Mirror: `marketplace/plugins/zcode/scripts/lib/rescue-progress-relay.mjs`
- Mirror: `marketplace/plugins/zcode/scripts/lib/progress.mjs`
- Mirror: `marketplace/plugins/zcode/scripts/lib/review.mjs`
- Mirror: `marketplace/plugins/zcode/scripts/zcode-companion.mjs`

- [ ] **Step 1: Add relay-wire RED tests**

Specify exact codes and reject all additional content:

```js
test('relay records contain fixed coarse facts only', () => {
  const line = serializeRescueProgressRelay({
    sequence: 1,
    phase: 'investigating',
    code: 'tool-active',
    observedAt: '2026-08-17T00:00:00.000Z',
  });
  assert.deepEqual(parseRescueProgressRelay(line), {
    version: 1,
    sequence: 1,
    phase: 'investigating',
    code: 'tool-active',
    observedAt: '2026-08-17T00:00:00.000Z',
  });
  assert.throws(() => parseRescueProgressRelay(line.replace(/}\n$/, ',"message":"PRIVATE"}\n')));
});
```

Add reporter tests proving detailed stderr and coarse relay are independent, duplicate phases coalesce, heartbeat has a fixed code, terminal stops relay, and relay failure cannot affect persistence or result.

- [ ] **Step 2: Run relay RED tests**

Run:

```bash
node --test tests/rescue-progress-relay.test.mjs tests/progress.test.mjs tests/job-control.test.mjs
```

Expected: module-not-found or missing relay callback failures occur for the newly specified behavior.

- [ ] **Step 3: Implement the deep relay module**

Use exact object keys, byte bounds, RFC3339 validation, monotonic sequence at the consumer, and fixed messages:

```js
export const RESCUE_RELAY_PREFIX = '[zcode-relay] ';
export const RESCUE_RELAY_MESSAGES = Object.freeze({
  started: 'ZCode Rescue started.',
  'model-active': 'ZCode is generating a response.',
  'tool-active': 'ZCode is working with a tool.',
  editing: 'ZCode is applying workspace changes.',
  verifying: 'ZCode is verifying the work.',
  waiting: 'ZCode Rescue is still running.',
  finalizing: 'ZCode Rescue is finalizing.',
});

export function serializeRescueProgressRelay(record) {
  const value = validateRelayRecord({ version: 1, ...record });
  return `${RESCUE_RELAY_PREFIX}${JSON.stringify(value)}\n`;
}
```

`parseRescueProgressRelay` must accept one complete line only and return a fresh fixed-shape object. It must never preserve unknown keys or exception text.

- [ ] **Step 4: Connect reporter and companion stderr**

Add an optional `relay` sink to `createProgressReporter`. Derive coarse code from the already-validated semantic phase/source, never from rendered text. Wire the direct foreground CLI to emit serialized relay lines on stderr in addition to detailed `[zcode]` lines:

```js
const foregroundProgress = worker ? {} : {
  progressWriter: (line) => process.stderr.write(line),
  progressRelayWriter: (record) => process.stderr.write(serializeRescueProgressRelay(record)),
  progressDependencies: { now: () => new Date().toISOString(), setInterval, clearInterval },
};
```

Relay sink errors must be caught independently. Relay sequence starts at 1 per approved foreground execution and closes before final stdout.

- [ ] **Step 5: Verify GREEN, stdout purity, and failure isolation**

Run:

```bash
node --test tests/rescue-progress-relay.test.mjs tests/progress.test.mjs tests/job-control.test.mjs tests/integration/skills.test.mjs
```

Expected: all tests pass; progress appears only on stderr, final stdout stays byte-identical, and a throwing relay sink does not change success.

- [ ] **Step 6: Sync mirrors and commit**

Copy the four changed runtime files and new relay module into the marketplace mirror, compare each with `cmp`, then run:

```bash
git add scripts/lib/rescue-progress-relay.mjs scripts/lib/progress.mjs scripts/lib/review.mjs scripts/zcode-companion.mjs marketplace/plugins/zcode/scripts/lib/rescue-progress-relay.mjs marketplace/plugins/zcode/scripts/lib/progress.mjs marketplace/plugins/zcode/scripts/lib/review.mjs marketplace/plugins/zcode/scripts/zcode-companion.mjs tests/rescue-progress-relay.test.mjs tests/progress.test.mjs tests/job-control.test.mjs
git commit -m "feat: emit bounded Rescue progress relays"
```

### Task 3: Add the Hook-Bound Rescue Status Sidecar

**Files:**
- Modify: `scripts/zcode-companion.mjs`
- Modify: `scripts/lib/job-control.mjs`
- Modify: `tests/integration/skills.test.mjs`
- Modify: `tests/job-control.test.mjs`
- Mirror: `marketplace/plugins/zcode/scripts/zcode-companion.mjs`
- Mirror: `marketplace/plugins/zcode/scripts/lib/job-control.mjs`

- [ ] **Step 1: Add direct status RED tests**

Create a trusted parent/child executor and jobs that differ by parent turn,
workspace, command, and sibling child. Invoke only the fixed direct command:

```js
const status = await runChild(process.execPath, [cli, 'invoke-status', 'rescue'], {
  cwd: ctx.workspace,
  env: { ...ctx.env, CODEX_THREAD_ID: 'bound-rescue-child' },
});
assert.equal(status.code, 0, status.stderr);
assert.deepEqual(Object.keys(JSON.parse(status.stdout)), ['type', 'status', 'phase', 'lastActivityAt', 'progressPreview', 'terminal']);
assert.doesNotMatch(status.stdout, /job-|session-|workspace|worker|artifact|PRIVATE/);
```

Add failures for extra argv, missing executor, sibling executor, wrong parent turn, two matching jobs, foreign workspace, and non-Rescue job. Assert no fake ZCode protocol call is recorded.

- [ ] **Step 2: Run status RED tests**

Run:

```bash
node --test tests/job-control.test.mjs tests/integration/skills.test.mjs
```

Expected: `invoke-status` is rejected as an invalid direct command.

- [ ] **Step 3: Implement exact bound-job selection**

Add a helper that receives trusted executor facts and selects exactly one job:

```js
export async function readBoundRescueStatus({ store, workspace, executor }) {
  const jobs = await store.listJobs(workspace);
  const matches = jobs.filter((job) =>
    job.ownerSessionId === executor.parentSessionId
    && job.ownerTurnId === executor.parentTurnId
    && job.command === 'rescue');
  if (matches.length !== 1) throw boundStatusError(matches.length);
  return projectBoundRescueStatus(matches[0]);
}
```

Use the store's existing bounded listing/ownership APIs rather than unbounded filesystem traversal. `projectBoundRescueStatus` returns exact keys only and clones at most four already-safe preview strings.

- [ ] **Step 4: Add the direct route without ZCode startup**

In `runDirectInvocation`, accept only `['invoke-status', 'rescue']`, resolve `CODEX_THREAD_ID` through `resolveForwardingExecutor`, verify the exact parent active turn/workspace, read the bound snapshot, and return it. Do not call `discoverLaunch`, `createManagedZCodeClient`, `startPublic`, or `executeJob`.

- [ ] **Step 5: Verify GREEN and foreground independence**

Run:

```bash
node --test tests/job-control.test.mjs tests/integration/skills.test.mjs tests/recovery.test.mjs
```

Expected: all tests pass; a status sidecar leaves the original foreground process and durable job unchanged.

- [ ] **Step 6: Sync mirrors and commit**

Run exact `cmp` checks for companion and job-control mirrors, then:

```bash
git add scripts/zcode-companion.mjs scripts/lib/job-control.mjs marketplace/plugins/zcode/scripts/zcode-companion.mjs marketplace/plugins/zcode/scripts/lib/job-control.mjs tests/integration/skills.test.mjs tests/job-control.test.mjs
git commit -m "feat: add bound Rescue status inspection"
```

### Task 4: Teach Named and Generic Forwarders to Relay Safely

**Files:**
- Modify: `agents/zcode-rescue.toml.template`
- Modify: `skills/rescue/SKILL.md`
- Modify: `tests/helpers/rescue-skill-contract.mjs`
- Modify: `tests/managed-agent-role.test.mjs`
- Modify: `tests/skills-contracts.test.mjs`
- Modify: `tests/helpers/codex-rescue-qualification.mjs`
- Modify: `tests/codex-rescue-qualification.test.mjs`
- Mirror: `marketplace/plugins/zcode/agents/zcode-rescue.toml.template`
- Mirror: `marketplace/plugins/zcode/skills/rescue/SKILL.md`

- [ ] **Step 1: Add Role and skill contract RED tests**

Require named and generic routes to define the same rules:

```js
assert.match(forwarder, /parse only complete \[zcode-relay\] records/i);
assert.match(forwarder, /send_message.*target.*\/root/i);
assert.match(forwarder, /never relay detailed \[zcode\].*stderr.*stdout/i);
assert.match(forwarder, /invoke-status rescue/);
assert.match(forwarder, /zcode status.*\$zcode:status.*\/zcode:status/i);
assert.match(forwarder, /status.*does not complete.*original.*handle/i);
```

Mutation cases must fail if relay occurs before validation, targets a sibling,
includes arbitrary text, treats relay as terminal, replaces `write_stdin`, runs a
second Rescue invoke, accepts status args, or returns status as final while the
foreground handle is live.

- [ ] **Step 2: Add qualification RED fixtures**

Extend captured rollout fixtures with original exec, same-handle polls, one
valid child `send_message` relay, optional exact status sidecar, and terminal
exit. Require call/output ownership and ordering:

```js
const evidence = qualifyCodexRescueEvidence(input, options({ requireProgressRelay: true }));
assert.equal(evidence.progressRelayChecked, true);
assert.equal(evidence.statusSidecarChecked, true);
assert.equal(evidence.yieldedExecution.sameHandleChecked, true);
assert.equal(evidence.yieldedExecution.terminalExitCode, 0);
```

Add adversarial fixtures for raw stderr relay, private text, wrong author/target,
duplicate/out-of-order relay, relay after final, status with argv, status from a
sibling, and a status output substituted for terminal stdout.

- [ ] **Step 3: Run contract RED tests**

Run:

```bash
node --test tests/managed-agent-role.test.mjs tests/skills-contracts.test.mjs tests/codex-rescue-qualification.test.mjs
```

Expected: new route and qualification assertions fail because current forwarders prohibit parent progress and all status calls.

- [ ] **Step 4: Update the managed Role and generic route**

Use fixed prose, not generated task text. The operative algorithm must be explicit:

```text
1. Start one foreground companion exec_command.
2. For each yielded result, parse only complete dedicated relay records.
3. Validate version, exact keys, sequence, phase, code, and timestamp.
4. Map code through the fixed message table and send_message only to /root.
5. Never relay any other output; poll only the original handle.
6. Exact no-argument status intents may run the constant sidecar between polls;
   status never replaces or completes the original handle.
7. Return only original terminal public stdout.
```

Update the parent section so an update from the exact `rescueChildId` is
liveness only and triggers another wait/rejoin, never completion or another
spawn.

- [ ] **Step 5: Update qualification and verify GREEN**

Implement strict function/custom call-ID ownership for `send_message`, status
exec, and their outputs. Preserve the independent identity/display-name checks,
choice linkage, private canaries, one foreground execution, same-handle polls,
terminal exit, and stdout equality.

Run:

```bash
node --test tests/managed-agent-role.test.mjs tests/skills-contracts.test.mjs tests/codex-rescue-qualification.test.mjs
```

Expected: all route, mutation, privacy, and qualification tests pass.

- [ ] **Step 6: Sync mirrors and commit**

Run `cmp` for both canonical/mirror pairs, then:

```bash
git add agents/zcode-rescue.toml.template skills/rescue/SKILL.md marketplace/plugins/zcode/agents/zcode-rescue.toml.template marketplace/plugins/zcode/skills/rescue/SKILL.md tests/helpers/rescue-skill-contract.mjs tests/managed-agent-role.test.mjs tests/skills-contracts.test.mjs tests/helpers/codex-rescue-qualification.mjs tests/codex-rescue-qualification.test.mjs
git commit -m "feat: relay Rescue progress to the parent"
```

### Task 5: Installed Qualification, Documentation, and Release Verification

**Files:**
- Modify: `tests/e2e/codex-skills-e2e.test.mjs`
- Modify: `tests/release-contracts.test.mjs`
- Modify: `tests/integration/marketplace-install.test.mjs`
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `CHANGELOG.md`
- Mirror: `marketplace/plugins/zcode/README.md`
- Mirror: `marketplace/plugins/zcode/README.zh-CN.md`
- Mirror: `marketplace/plugins/zcode/CHANGELOG.md`

- [ ] **Step 1: Add installed source/E2E RED coverage**

Require foreground named and generic flows to remain alive beyond initial yield,
produce detailed child-local progress, send at least one fixed parent relay,
optionally execute exactly one bound status sidecar, continue the original
handle, exit 0, return exact final stdout, and leave no orphan. Add a source
mutation that moves relay after terminal return and another that accepts raw
stderr; both must fail deterministically even when authenticated tests skip.

- [ ] **Step 2: Run installed RED tests**

Run:

```bash
node --test tests/e2e/codex-skills-e2e.test.mjs tests/integration/marketplace-install.test.mjs tests/release-contracts.test.mjs
```

Expected: deterministic installed/source contracts fail on missing relay and
status wiring; authenticated/credit tests remain explicit opt-in skips.

- [ ] **Step 3: Extend the hermetic fixture and installed assertions**

Use condition/event gates, not correctness sleeps. Hold fake completion until
the harness observes the exact coarse relay; verify invalid/missing nonce cannot
release the gate. Capture the original foreground PID/handle, release safely in
`finally`, and retain exact nonce + pid + ppid + stable-start identity before
every cleanup signal.

- [ ] **Step 4: Update English/Chinese documentation and changelog**

Document these exact user-facing facts:

```text
- Rescue child shows cc-style semantic progress from structured ZCode events.
- Root receives fixed coarse liveness updates, not raw child output.
- Progress and status never prove completion; terminal exit and final stdout do.
- In the selected Rescue child, zcode status / $zcode:status / /zcode:status
  inspect only that child's bound job and accept no job ID or option.
- Raw PTY, tool output, file contents, reasoning, credentials, and capabilities
  are never relayed to root.
```

Copy all three documents to the marketplace mirror and verify byte identity.

- [ ] **Step 5: Run focused verification**

Run:

```bash
node --test tests/conversation-progress.test.mjs tests/rescue-progress-relay.test.mjs tests/progress.test.mjs tests/job-control.test.mjs tests/integration/skills.test.mjs tests/managed-agent-role.test.mjs tests/skills-contracts.test.mjs tests/codex-rescue-qualification.test.mjs tests/e2e/codex-skills-e2e.test.mjs tests/integration/marketplace-install.test.mjs tests/release-contracts.test.mjs
npm run lint
npm run typecheck
git diff --check
```

Expected: zero failures; only documented authenticated/credit opt-in skips.

- [ ] **Step 6: Commit Task 5**

```bash
git add tests/e2e/codex-skills-e2e.test.mjs tests/release-contracts.test.mjs tests/integration/marketplace-install.test.mjs README.md README.zh-CN.md CHANGELOG.md marketplace/plugins/zcode/README.md marketplace/plugins/zcode/README.zh-CN.md marketplace/plugins/zcode/CHANGELOG.md
git commit -m "test: qualify live Rescue progress"
```

- [ ] **Step 7: Run full clean-commit verification**

Run:

```bash
npm run check
git diff --check
git status --short
```

Expected: all default tests pass with only explicitly documented opt-in skips,
marketplace build/qualification suites pass, diff check is empty, and worktree
is clean.

- [ ] **Step 8: Build the exact committed marketplace snapshot**

Run the repository's SHA-pinned marketplace build command with `source-ref` set
to the feature branch and `source-sha` set to `git rev-parse HEAD`. Verify
provenance equals that exact full SHA and compare all changed canonical,
repository-mirror, and built files byte-for-byte.

- [ ] **Step 9: Request whole-branch review and resolve findings**

Review the fixed range from the branch point through `HEAD` along both spec and
standards axes. Every Critical or Important finding gets a RED regression,
minimal fix, focused verification, follow-up commit, and re-review until both
reviewers report Ready.

- [ ] **Step 10: Push, open the PR, and monitor required CI**

Push `fix/rescue-live-progress`, open a PR against `main`, include diagnostic
evidence and local verification in the body, then inspect required checks with
`gh`. For any failing required check, read the exact Actions log, reproduce when
possible, fix through RED→GREEN, push a follow-up commit, and continue monitoring
until every required check succeeds.

The task is complete only after the PR exists and all required CI checks are
green.
