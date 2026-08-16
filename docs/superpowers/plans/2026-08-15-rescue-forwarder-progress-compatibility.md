# Rescue Forwarder and Progress Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make native Rescue child hooks succeed, keep the child attached to one yielded companion execution until exit, and retain safe semantic progress when ZCode conversation frames are silent or incompatible.

**Architecture:** Preserve the existing authoritative send/completion/result path and add compatibility only at observational boundaries. Hook classification short-circuits forwarding-child prompts; forwarder instructions and qualification distinguish a running host handle from a terminal exit; a fixed-result conversation probe drives a bounded reporter state machine; and a focused snapshot describer consumes only schema-validated `session/read` data for the accepted current turn.

**Tech Stack:** Node.js 22 ESM, `node:test`, strict JSON/protocol validation, Codex 0.147 native subagents, ZCode broker/client protocol, GitHub Actions.

---

### Task 1: Accept forwarding-child prompt hooks neutrally (#24)

**Files:**
- Modify: `hooks/lib/hook-input.mjs`
- Modify: `hooks/user-prompt-hook.mjs`
- Modify: `tests/hooks.test.mjs`
- Regenerate: `marketplace/plugins/zcode/hooks/lib/hook-input.mjs`
- Regenerate: `marketplace/plugins/zcode/hooks/user-prompt-hook.mjs`

- [ ] **Step 1: Add failing Codex 0.147 child-prompt tests**

Add a tracer test in `tests/hooks.test.mjs` which starts an owned parent session, records a parent caller turn, seeds an unread completed job, then submits this bounded child shape:

```js
{
  session_id: 'parent', turn_id: 'child-turn', cwd,
  hook_event_name: 'UserPromptSubmit', transcript_path: null,
  model: 'gpt', permission_mode: 'bypassPermissions', prompt: 'forward',
  agent_id: 'rescue-child', agent_type: 'zcode-rescue',
}
```

Assert exit code `0`, exact JSON `{}`, unchanged parent active-turn identity and permission snapshot, no child caller turn or gate baseline, and no unread-job additional context. Add a table for `agent_id`-only, `agent_type`-only, empty/control-bearing/513-byte identifiers, and an extra unknown field; each must exit nonzero with no stdout.

- [ ] **Step 2: Run the hook test and verify RED**

Run: `node --test --test-name-pattern='forwarding-child prompt' tests/hooks.test.mjs`

Expected: the valid child shape fails with `HOOK_INPUT_INVALID`; malformed shapes remain rejected.

- [ ] **Step 3: Extend the exact schema and short-circuit child prompts**

In `EVENTS.UserPromptSubmit`, allow optional `agent_id` and `agent_type`. After general identifier validation, reject half-present identity:

```js
if (actualEvent === 'UserPromptSubmit'
  && Object.hasOwn(input, 'agent_id') !== Object.hasOwn(input, 'agent_type')) throw inputError();
```

In `hooks/user-prompt-hook.mjs`, immediately after `readHookInput()` and before resolving plugin data or calling `isOwnedSession`, return neutral output:

```js
if (input.agent_id !== undefined) {
  process.stdout.write('{}');
  process.exit(0);
}
```

Do not bind an executor here; `SubagentStart` remains the only binding event.

- [ ] **Step 4: Run focused and hook suites and verify GREEN**

Run:

```bash
node --test --test-name-pattern='forwarding-child prompt|subagent hook marks|trusted SubagentStart' tests/hooks.test.mjs
node --test tests/hooks.test.mjs
```

Expected: all selected and full hook tests pass with no warning or secret-bearing output.

- [ ] **Step 5: Regenerate packaged mirrors and verify identity**

Run: `node scripts/build-marketplace-snapshot.mjs`

Then run: `node --test tests/integration/marketplace-snapshot-build.mjs tests/integration/package-install.test.mjs`

Expected: generated mirrors are byte-compatible and both tests pass.

- [ ] **Step 6: Commit the tracer bullet**

```bash
git add hooks tests/hooks.test.mjs marketplace/plugins/zcode/hooks
git commit -m "fix: accept forwarding child prompt hooks"
```

### Task 2: Keep Rescue attached to the yielded execution (#25)

**Files:**
- Modify: `agents/zcode-rescue.toml.template`
- Modify: `skills/rescue/SKILL.md`
- Modify: `tests/skills-contracts.test.mjs`
- Modify: `tests/integration/skills.test.mjs`
- Modify: `tests/helpers/codex-rescue-qualification.mjs`
- Modify: `tests/codex-rescue-qualification.test.mjs`
- Modify: `tests/e2e/codex-skills-e2e.test.mjs`
- Modify as required for the long fixture: `tests/fixtures/fake-zcode-cli.mjs`
- Regenerate: `marketplace/plugins/zcode/agents/zcode-rescue.toml.template`
- Regenerate: `marketplace/plugins/zcode/skills/rescue/SKILL.md`

- [ ] **Step 1: Add failing instruction-contract tests**

Require named and generic forwarders to state all of these exact semantics:

```text
A companion result containing an exit code is terminal. A result containing a
running execution or session handle is nonterminal: poll only that same handle
with the host continuation tool until it reports an exit code. Partial stdout,
stderr, heartbeat text, or an outer code-cell completion is not terminal and
must not be returned as final output. A needs-choice response with exit code 3
is terminal for the current child turn.
```

Assert the contract still forbids a second `exec_command`, retry, cancellation, branch choice, or independent code inspection.

- [ ] **Step 2: Run instruction tests and verify RED**

Run: `node --test --test-name-pattern='yielded|terminal companion|needs-choice' tests/skills-contracts.test.mjs tests/integration/skills.test.mjs`

Expected: assertions fail because the current Role and generic instructions treat only the outer command call as a unit and do not define same-handle polling.

- [ ] **Step 3: Update named and generic forwarder instructions**

Add the same terminal contract to `agents/zcode-rescue.toml.template` and the generic block of `skills/rescue/SKILL.md`. Keep the three constant commands, fixed assignments, one-child routing, stdout/stderr behavior, and choice wording unchanged. Clarify that “exactly one command” means one `exec_command` companion process; continuation calls only observe its original running handle.

- [ ] **Step 4: Add failing qualification fixtures for yielded execution**

Extend the captured-event fixtures so a valid child timeline contains:

```js
[
  { tool: 'exec_command', result: { output: '[zcode] started\n', session_id: 41 } },
  { tool: 'write_stdin', args: { session_id: 41, chars: '' }, result: { output: '[zcode] heartbeat\n', session_id: 41 } },
  { tool: 'write_stdin', args: { session_id: 41, chars: '' }, result: { output: 'public result\n', exit_code: 0 } },
]
```

Add adversarial fixtures for a second `exec_command`, changed handle, continuation with nonempty input, missing terminal exit code, child final before terminal output, parent terminal before child, and polling after exit. Preserve existing `needs-choice` exit-code-3 and same-child continuation fixtures.

- [ ] **Step 5: Run qualification tests and verify RED**

Run: `node --test tests/codex-rescue-qualification.test.mjs`

Expected: valid yielded named/generic routes fail under the current single-tool-call parser while existing one-shot cases still pass.

- [ ] **Step 6: Teach qualification to validate one execution plus bounded same-handle polls**

Refactor `parseCapturedExecEnvelope()` into strict host-tool envelope classification that recognizes the captured Codex 0.147 `tools.exec_command` and continuation (`tools.write_stdin`) shapes. Track:

```js
{
  execCount: 1,
  handle: validatedPositiveSafeInteger,
  pollCount: boundedCount,
  terminalExitCode: validatedInteger,
  terminalEventIndex: validatedIndex,
}
```

Require the first running result to establish the handle, every continuation to use exactly that handle with empty observation input, and exactly one final result containing an exit code. Keep stdout binding and child/parent ordering checks; never inspect output contents other than the existing public sentinel/choice contract.

- [ ] **Step 7: Verify qualification GREEN and regenerate mirrors**

Run:

```bash
node --test tests/codex-rescue-qualification.test.mjs tests/skills-contracts.test.mjs tests/integration/skills.test.mjs
node scripts/build-marketplace-snapshot.mjs
node --test tests/integration/marketplace-snapshot-build.mjs
```

Expected: valid one-shot and yielded routes pass; every changed-handle/second-command/early-final fixture fails closed.

- [ ] **Step 8: Extend installed long-running qualification**

Use the existing fake completion delay/gate and process marker so the installed foreground Rescue exceeds the host initial yield. Assert one companion invocation/session send, selected-child terminal ordering after the original handle’s exit code, and no live orphan process after child completion. Keep the opt-in environment and credential cleanup contracts unchanged.

- [ ] **Step 9: Run installed qualification harness in deterministic mode**

Run: `node --test tests/e2e/codex-skills-e2e.test.mjs`

Expected: deterministic tests pass and authenticated-credit cases report the repository’s explicit opt-in skip unless the environment enables them.

- [ ] **Step 10: Commit the tracer bullet**

```bash
git add agents skills tests marketplace/plugins/zcode/agents marketplace/plugins/zcode/skills
git commit -m "fix: keep rescue attached through execution exit"
```

### Task 3: Probe conversation compatibility structurally (#26)

**Files:**
- Modify: `scripts/lib/conversation-progress.mjs`
- Modify: `scripts/lib/progress.mjs`
- Modify: `scripts/lib/review.mjs`
- Modify: `scripts/lib/state.mjs`
- Modify: `tests/conversation-progress.test.mjs`
- Modify: `tests/progress.test.mjs`
- Modify: `tests/state.test.mjs`
- Modify: `tests/render-progress.test.mjs`
- Modify: `tests/job-control.test.mjs`
- Modify: `tests/integration/companion.test.mjs`
- Modify: `tests/fixtures/fake-zcode-cli.mjs`
- Regenerate corresponding files under: `marketplace/plugins/zcode/`

- [ ] **Step 1: Add failing fixed-classification protocol tests**

Change the wished-for describer API so `observe()` resolves a structural result:

```js
{
  disposition: 'accepted',
  deliveryKind: 'online',
  events: [],
}
```

or:

```js
{
  disposition: 'rejected',
  reason: 'wire-version',
  events: [],
}
```

Test fixed rejection reasons `wire-version`, `envelope-shape`, `sequence`, `topic`, `row-kind`, and `row-shape`. Verify `JSON.stringify(result)` never contains raw frame values, commands, paths, output, exception text, credentials, or identifiers copied from frame content. Initial frames may be structurally accepted but must report `deliveryKind: 'initial'`; recovery frames must not count as online.

- [ ] **Step 2: Run conversation tests and verify RED**

Run: `node --test tests/conversation-progress.test.mjs`

Expected: current `[]`/`null` rejection behavior cannot satisfy fixed structural results.

- [ ] **Step 3: Implement fixed structural validation results**

Make validation return only normalized, allowlisted frame data or a fixed reason. Preserve exact schema checks, sequence/gap recovery, terminal fencing, row/tool caps, pending-observation caps, path containment, and public 256-byte messages. A valid online frame counts as accepted even if deduplication produces zero public events.

- [ ] **Step 4: Add failing reporter state/probe tests**

Exercise the wished-for reporter state:

```js
{
  state: 'probing' | 'online' | 'snapshot-fallback' | 'lifecycle-only',
  subscriptionAcknowledged: boolean,
  framesReceived: number,
  acceptedInitial: number,
  acceptedOnline: number,
  acceptedRecovery: number,
  rejected: { 'wire-version': number, 'envelope-shape': number, sequence: number, topic: number, 'row-kind': number, 'row-shape': number },
  snapshotFallbackActive: boolean,
  snapshotFallbackUnavailable: boolean,
}
```

Counters must saturate at a fixed safe integer bound, fixed keys must be exact, generic `state.updated` events must not set `online`, a valid zero-event online frame must set `online`, and diagnostics/state changes after terminal must be ignored.

- [ ] **Step 5: Run reporter/state tests and verify RED**

Run: `node --test tests/progress.test.mjs tests/state.test.mjs tests/render-progress.test.mjs`

Expected: no compatibility state or owner-scoped probe persistence exists yet.

- [ ] **Step 6: Implement the bounded reporter probe and durable owner facts**

Add an observational callback from the conversation describer into `createProgressReporter()`. Store only exact enums, booleans, saturated counters, and fixed rejection keys. Add a state-store method dedicated to atomically updating `progressProbe` on the exact running job; queued or terminal jobs are no-ops. Exact owner status JSON may include `progressProbe`; text rendering and foreign/all-job views must not expose it. Probe persistence failure must be swallowed like progress preview failure.

- [ ] **Step 7: Wire subscription acknowledgement and compatibility state**

In `executeJob()`, mark acknowledgement only after `subscribeConversation()` validates its result. Keep subscribe failure observational. Ensure all probe hooks are stopped/fenced inside existing optional progress cleanup and cannot affect `primaryError`, completion, result extraction, cancellation, or exit status.

- [ ] **Step 8: Add fake-protocol and companion integration coverage**

Extend the fake ZCode fixture with deterministic modes for no frames, accepted initial-only frames, accepted online zero-event frames, and bounded malformed bursts. Assert owner status contains only fixed probe facts, public stderr contains only fixed messages, and embedded raw secrets never appear in stdout/stderr/job JSON.

- [ ] **Step 9: Verify the complete structural probe**

Run:

```bash
node --test tests/conversation-progress.test.mjs tests/progress.test.mjs tests/state.test.mjs tests/render-progress.test.mjs tests/job-control.test.mjs tests/integration/companion.test.mjs
node scripts/build-marketplace-snapshot.mjs
node --test tests/integration/marketplace-snapshot-build.mjs
```

Expected: all structural states and privacy assertions pass; existing result/cancellation/subscription cleanup tests remain green.

- [ ] **Step 10: Commit the tracer bullet**

```bash
git add scripts tests marketplace/plugins/zcode
git commit -m "feat: observe conversation progress compatibility"
```

### Task 4: Fall back to bounded current-turn session progress (#27)

**Files:**
- Create: `scripts/lib/session-progress.mjs`
- Modify: `scripts/lib/conversation-progress.mjs`
- Modify: `scripts/lib/progress.mjs`
- Modify: `scripts/lib/review.mjs`
- Modify: `tests/session-progress.test.mjs`
- Modify: `tests/conversation-progress.test.mjs`
- Modify: `tests/progress.test.mjs`
- Modify: `tests/job-control.test.mjs`
- Modify: `tests/integration/companion.test.mjs`
- Modify: `tests/fixtures/fake-zcode-cli.mjs`
- Modify: `tests/helpers/codex-rescue-qualification.mjs`
- Modify: `tests/codex-rescue-qualification.test.mjs`
- Modify: `tests/e2e/codex-skills-e2e.test.mjs`
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `CHANGELOG.md`
- Regenerate corresponding files under: `marketplace/plugins/zcode/`

- [ ] **Step 1: Add failing snapshot-describer privacy and boundary tests**

Define the wished-for interface:

```js
const describer = createSessionProgressDescriber({
  workspace,
  turnBoundary: { inputId, stateRevision, beforeMessageIds: new Set(historyIds) },
});
const events = await describer.observe(validatedSnapshot, observedAt);
```

Test `runtime.stateRevision >= stateRevision`, exclusion of every historical ID, selection of only the direct accepted input root (or exactly one visible non-synthetic current user root), and only linked assistant `parts[type === 'tool']`. Reasoning, text, files, patches, arbitrary input/output/error/metadata, sibling roots, hidden assistant prose, and raw paths must never enter returned events or serialized state. Deduplicate by `callId`, cap at 256 identities, and emit terminal-only when a call first appears completed/error.

- [ ] **Step 2: Run snapshot tests and verify RED**

Run: `node --test tests/session-progress.test.mjs`

Expected: module import fails because the bounded snapshot describer does not exist.

- [ ] **Step 3: Implement the focused snapshot describer**

Create `scripts/lib/session-progress.mjs`. Consume only snapshots already validated by `ZCodeClient.readSession()`. Reuse or extract the existing allowlisted tool-name/start/terminal formatter and contained-path resolver from `conversation-progress.mjs`; do not synthesize v4 frames. Track only bounded call state and safe formatter output. Treat malformed boundary relationships as no events, not as permission to scan more history.

- [ ] **Step 4: Add failing heartbeat/fallback scheduling tests**

Inject controlled interval ticks and deferred `readSnapshot` promises into `createProgressReporter()`. Prove:

```text
no read before accepted boundary
first heartbeat with zero accepted online frames starts fallback
rejection threshold may start fallback before that boundary
at most one read per heartbeat and one read in flight
accepted online recovery stops new reads and discards a late read result
read/normalization failure emits the fixed lifecycle-only diagnostic once
terminal cleanup never waits unboundedly for a read
```

The first heartbeat decision must occur even when generic lifecycle activity suppresses the visible “Still waiting” line.

- [ ] **Step 5: Run scheduling tests and verify RED**

Run: `node --test --test-name-pattern='snapshot|fallback|online recovery|heartbeat boundary' tests/progress.test.mjs tests/job-control.test.mjs`

Expected: reporter has no accepted-boundary snapshot reader or fallback state transitions.

- [ ] **Step 6: Implement bounded fallback scheduling**

Add an accepted-boundary activation method that receives `readSnapshot` and the snapshot describer only after send acknowledgement and durable boundary persistence. On heartbeat or rejection threshold, transition `probing -> snapshot-fallback`, diagnose exactly `ZCode conversation frames were unavailable; using bounded session progress.`, and start at most one read. On read/normalization failure transition to `lifecycle-only` and diagnose exactly `ZCode semantic progress is unavailable; lifecycle updates will continue.` On accepted online recovery transition to `online`, increment an epoch, prevent future reads, and discard any older in-flight result. Snapshot work remains outside the authoritative completion promise and existing 250ms cleanup fence.

- [ ] **Step 7: Wire the exact accepted turn in `executeJob()`**

After `client.send()` is accepted and the job persists `inputId`, `startRevision`, and `beforeMessageIds`, build the snapshot describer with that same boundary and pass `() => client.readSession(activeSessionId)` to the reporter. Keep the final `readSession()` after completion separate and authoritative; never reuse a progress snapshot for result extraction or terminal proof.

- [ ] **Step 8: Add deterministic fake-protocol integration coverage**

Teach the fake peer to return current-turn in-progress and terminal tool parts, delayed reads, read failure, malformed-frame bursts, and later online recovery. Assert lifecycle-only output is fixed, snapshot tool starts/terminals are deduplicated, online recovery stops further `session/read`, final result/exit status are unchanged, and raw assistant/tool input/output/reasoning/file data never appears.

- [ ] **Step 9: Update qualification and installed E2E expectations**

Qualification must accept either safe semantic tool progress or one exact degraded diagnostic, while independently proving the Rescue child remains attached through the original companion exit. The real installed long Rescue must fail if durable preview remains startup-only with neither semantic activity nor an explicit degraded diagnostic.

- [ ] **Step 10: Document compatibility behavior**

Update both READMEs and CHANGELOG to explain: progress is observational; the plugin structurally probes subscription health; fallback reads schema-validated snapshots at heartbeat-bounded frequency for the accepted current turn only; raw ZCode logs are never read; assistant prose/reasoning/tool output/file contents are never emitted; and degraded lifecycle-only reporting does not change task success.

- [ ] **Step 11: Verify fallback, integration, packaging, and privacy**

Run:

```bash
node --test tests/session-progress.test.mjs tests/conversation-progress.test.mjs tests/progress.test.mjs tests/job-control.test.mjs tests/integration/companion.test.mjs tests/codex-rescue-qualification.test.mjs tests/e2e/codex-skills-e2e.test.mjs
node scripts/build-marketplace-snapshot.mjs
npm run check
```

Expected: all deterministic tests and checks pass; authenticated-credit cases use explicit opt-in skips unless enabled; no raw probe/snapshot content appears in public or durable progress.

- [ ] **Step 12: Commit the tracer bullet**

```bash
git add scripts tests README.md README.zh-CN.md CHANGELOG.md marketplace/plugins/zcode
git commit -m "feat: fall back to bounded session progress"
```

### Task 5: Whole-branch qualification and PR delivery

**Files:**
- Review all changes since: `df62cca`
- Modify only files required by review or CI findings

- [ ] **Step 1: Run the complete local gate from a clean tree**

Run:

```bash
git status --short
npm run check
git diff --check df62cca..HEAD
```

Expected: clean worktree, exit code 0 for all checks, no whitespace errors. Opt-in real ZCode/Codex checks may skip only with their explicit repository diagnostics.

- [ ] **Step 2: Perform final independent spec and quality review**

Review the complete diff against `docs/superpowers/specs/2026-08-15-rescue-forwarder-progress-compatibility-design.md` and issues #24–#27. Fix every Critical or Important finding and re-run the affected focused tests plus `npm run check`.

- [ ] **Step 3: Push and open the requested PR**

Push `fix/rescue-progress-compatibility` and create a PR whose body contains `Closes #24`, `Closes #25`, `Closes #26`, and `Closes #27`, plus the exact local verification commands and the explicit opt-in status of installed real qualification.

- [ ] **Step 4: Monitor and repair CI until green**

Use `gh pr checks --watch` and inspect failed job logs. Reproduce each failure locally, add or adjust a regression test first, apply the minimal fix, re-run the focused test and `npm run check`, commit, push, and repeat until every required PR check succeeds.
