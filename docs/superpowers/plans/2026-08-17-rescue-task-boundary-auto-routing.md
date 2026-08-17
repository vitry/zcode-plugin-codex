# Rescue Task Boundary and Automatic Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a secure prepared-invocation boundary that preserves the normalized Rescue business objective, excludes Root-only policy, and lets Root automatically choose fresh/resume for proactive invocations.

**Architecture:** The top-level Root performs the semantic split, sends one versioned envelope over a parent-owned preparation process's stdin, and stores it in exact turn-bound private state. The existing task-blind Rescue child atomically consumes that record with `invoke-prepared rescue`; explicit candidate choice and proactive automatic routing remain Root policies, while ZCode lifecycle signals remain the only execution authority.

**Tech Stack:** Node.js 22 ESM, `node:test`, filesystem-backed private stores, Codex lifecycle hooks, Markdown/TOML installed plugin contracts.

---

## File Structure

- Create `scripts/lib/rescue-preparation.mjs`: bounded stdin codec, exact envelope validation, marker/source cross-check, and atomic prepared-record store.
- Create `tests/rescue-preparation.test.mjs`: focused codec/store security and lifecycle tests.
- Modify `scripts/zcode-companion.mjs`: dispatch `prepare rescue` and `invoke-prepared rescue`, retire prompt parsing from the installed Rescue route, and reuse existing public execution.
- Modify `scripts/lib/invocation.mjs`: preserve `source` across same-child pending choices and retain legacy compatibility.
- Modify `hooks/user-prompt-hook.mjs`, `hooks/stop-review-gate-hook.mjs`, and `hooks/session-end-hook.mjs`: bounded prepared-record cleanup.
- Modify `tests/integration/skills.test.mjs`, `tests/integration/companion.test.mjs`, `tests/hooks.test.mjs`, and `tests/identity.test.mjs`: runtime and incident regressions.
- Modify `skills/rescue/SKILL.md` and `agents/zcode-rescue.toml.template`: Root preparation/auto-routing policy and constant child forwarder command.
- Modify `tests/helpers/rescue-skill-contract.mjs`, `tests/skills-contracts.test.mjs`, `tests/managed-agent-role.test.mjs`: installed instruction contracts.
- Modify `tests/helpers/installed-rescue-lifecycle-contract.mjs`, `tests/helpers/codex-rescue-qualification.mjs`, `tests/codex-rescue-qualification.test.mjs`, and `tests/e2e/codex-skills-e2e.test.mjs`: captured and optional live route qualification.
- Modify `README.md`, `README.zh-CN.md`, `SECURITY.md`, and `CHANGELOG.md`: public behavior and security boundary.
- Modify `scripts/build-marketplace-snapshot.mjs`, `tests/marketplace-snapshot.test.mjs`, and `tests/integration/marketplace-install.test.mjs`; regenerate `marketplace/plugins/zcode/**`: distributable snapshot parity.

### Task 1: Prepared Rescue Envelope and Private Store

**Files:**
- Create: `scripts/lib/rescue-preparation.mjs`
- Create: `tests/rescue-preparation.test.mjs`
- Test: `tests/identity.test.mjs`

- [ ] **Step 1: Write failing codec tests**

Add tests that exercise the public wished-for API with real byte streams:

```js
import { Readable } from 'node:stream';
import {
  readRescuePreparation,
  createRescuePreparationStore,
} from '../scripts/lib/rescue-preparation.mjs';

const validEnvelope = {
  version: 1,
  source: 'explicit',
  task: 'implement the approved specification',
  options: { execution: 'foreground', resume: 'fresh', effort: 'high' },
};

test('reads exactly one LF-terminated preparation envelope and preserves task bytes', async () => {
  const input = Readable.from([Buffer.from(`${JSON.stringify(validEnvelope)}\n`)]);
  assert.deepEqual(await readRescuePreparation(input), validEnvelope);
});

test('rejects duplicate keys, trailing bytes, malformed UTF-8, and oversized task data', async () => {
  const bad = [
    '{"version":1,"version":1,"source":"explicit","task":"x","options":{}}\n',
    `${JSON.stringify(validEnvelope)}\nextra`,
    Buffer.from([0xc3, 0x28, 0x0a]),
    `${JSON.stringify({ ...validEnvelope, task: 'x'.repeat(64 * 1024 + 1) })}\n`,
  ];
  for (const value of bad) {
    await assert.rejects(readRescuePreparation(Readable.from([value])), {
      code: 'RESCUE_PREPARATION_INVALID',
    });
  }
});
```

Include separate assertions for unknown/missing/null option fields, invalid enum values, no LF, more than one line, controls in model/effort, and envelope overhead bounds.

- [ ] **Step 2: Run the codec tests and verify RED**

Run: `node --test tests/rescue-preparation.test.mjs`

Expected: FAIL because `scripts/lib/rescue-preparation.mjs` does not exist.

- [ ] **Step 3: Implement the bounded exact codec**

Create a focused module implementing this exact interface:

```ts
export const RESCUE_PREPARATION_VERSION: 1;
export const RESCUE_TASK_MAX_BYTES: 65536;
export const RESCUE_ENVELOPE_MAX_BYTES: 69632;
export function readRescuePreparation(stream: NodeJS.ReadableStream): Promise<RescuePreparation>;
export function validateRescuePreparation(value: unknown): RescuePreparation;
export function hasRecordedRescueMarker(prompt: string): boolean;
```

Use `TextDecoder('utf-8', { fatal: true })`, a byte counter that destroys/rejects above `RESCUE_ENVELOPE_MAX_BYTES`, exactly one final LF, and a small JSON lexical scanner that rejects duplicate object keys before `JSON.parse`. Do not evaluate escapes or shell syntax outside JSON decoding. Accept only:

```js
const sources = new Set(['explicit', 'proactive']);
const executions = new Set(['foreground', 'background']);
const resumes = new Set(['fresh', 'resume']);
const efforts = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);
const envelopeKeys = ['options', 'source', 'task', 'version'];
const optionKeys = ['effort', 'execution', 'model', 'resume'];
```

`model` follows the existing non-empty 512-byte, no-control constraint; missing optional keys remain absent.

- [ ] **Step 4: Write failing prepared-store tests**

Exercise exact source/marker/turn/workspace/permission/executor binding:

```js
const prepared = createRescuePreparationStore({ dataRoot });
await prepared.save({
  sessionId: 'parent', turnId: 'turn-a', workspace,
  permissionMode: 'workspace-write', recordedPrompt: '$zcode:rescue develop feature',
  envelope: validEnvelope, now,
});
const consumed = await prepared.consume({
  sessionId: 'parent', turnId: 'turn-a', workspace,
  permissionMode: 'workspace-write', executorAgentId: 'rescue-child', now,
});
assert.deepEqual(consumed.envelope, validEnvelope);
await assert.rejects(prepared.consume({
  sessionId: 'parent', turnId: 'turn-a', workspace,
  permissionMode: 'workspace-write', executorAgentId: 'rescue-child', now,
}), { code: 'RESCUE_PREPARATION_CONSUMED' });
```

Add independent tests for a second prepare, explicit-without-marker, proactive-with-marker, stale turn, permission mismatch, wrong workspace/session/executor, 30-minute expiry, record/file count bounds, `cleanupTurn`, `cleanupOlderTurns`, and `cleanupSession`. Assert private mode via `stat` on POSIX and assert task text never appears outside the prepared file.

- [ ] **Step 5: Run store tests and verify RED**

Run: `node --test tests/rescue-preparation.test.mjs tests/identity.test.mjs`

Expected: FAIL because the store API is missing.

- [ ] **Step 6: Implement the store minimally**

Implement this exact store interface:

```ts
export interface RescuePreparationStore {
  save(input: SavePreparedRescueInput): Promise<void>;
  consume(input: ConsumePreparedRescueInput): Promise<PreparedRescueRecord>;
  cleanupTurn(input: TurnIdentity): Promise<void>;
  cleanupOlderTurns(input: TurnIdentity): Promise<void>;
  cleanupSession(input: SessionIdentity): Promise<void>;
}

export function createRescuePreparationStore(input: {
  dataRoot: string;
}): RescuePreparationStore;
```

Store records under `<workspace-storage>/invocations/prepared/`, hash `[sessionId, turnId, canonicalWorkspace, 'rescue']`, lock with the existing `withFileLock`, write with `atomicWriteJson`, retain `consumedAt` and `executorAgentId` tombstones, cap scanned files, and never include task text in an error.

- [ ] **Step 7: Verify GREEN, refactor, and commit**

Run:

```bash
node --test tests/rescue-preparation.test.mjs tests/identity.test.mjs
npm run lint
npm run typecheck
```

Expected: all pass with no warnings.

Commit: `feat: add private Rescue preparation store`

### Task 2: Companion Prepared Route and Lifecycle Cleanup

**Files:**
- Modify: `scripts/zcode-companion.mjs`
- Modify: `scripts/lib/invocation.mjs`
- Modify: `hooks/user-prompt-hook.mjs`
- Modify: `hooks/stop-review-gate-hook.mjs`
- Modify: `hooks/session-end-hook.mjs`
- Modify: `tests/integration/skills.test.mjs`
- Modify: `tests/integration/companion.test.mjs`
- Modify: `tests/hooks.test.mjs`
- Modify: `tests/identity.test.mjs`

- [ ] **Step 1: Write failing direct-route tests**

Add helpers that start `prepare rescue`, send exactly `JSON.stringify(envelope) + '\n'`, close stdin, and then start a hook-bound child with `invoke-prepared rescue`. Assert:

```js
assert.deepEqual(JSON.parse(prepared.stdout), { type: 'prepared', command: 'rescue' });
assert.equal(invoked.code, 0);
assert.match(fakePeerPrompt, /AUTHORIZED RESCUE OBJECTIVE/);
assert.match(fakePeerPrompt, /implement the approved specification/);
assert.doesNotMatch(fakePeerPrompt, /if rescue fails, stop and report/i);
```

The incident fixture's recorded parent prompt must put the development task before an embedded marker and the Root-only policy after it; the envelope task contains only the normalized development objective. Add proactive source coverage, explicit/proactive marker mismatch, old `invoke rescue` rejection, unprepared/replayed consumption, parent/sibling/ordinary-child consume rejection, stale parent turn, and wrong workspace.

- [ ] **Step 2: Run focused integration tests and verify RED**

Run:

```bash
node --test tests/integration/skills.test.mjs tests/integration/companion.test.mjs
```

Expected: FAIL because `prepare` and `invoke-prepared` are not recognized.

- [ ] **Step 3: Implement the private companion entries**

In `runDirectInvocation()` add exact dispatch with no public `parseArgs()` surface:

```js
if (entry === 'prepare' && command === 'rescue' && choice === undefined && extra.length === 0) {
  const parentSessionId = requireAmbientThreadId(env);
  const caller = await identity.resolveActiveTurn({ sessionId: parentSessionId, workspace: cwd });
  const envelope = await readRescuePreparation(runtime.input ?? process.stdin);
  await preparations.save({ ...caller, recordedPrompt: caller.prompt, envelope });
  return { type: 'prepared', command: 'rescue' };
}

if (entry === 'invoke-prepared' && command === 'rescue' && choice === undefined && extra.length === 0) {
  const executor = await resolveForwardingExecutor(dataRoot, cwd, ambientThreadId);
  const caller = await identity.resolveActiveTurn({ sessionId: executor.parentSessionId, workspace: cwd });
  assertExecutorMatchesCaller(executor, caller);
  const prepared = await preparations.consume({ ...caller, executorAgentId: executor.agentId });
  const argv = rescueArgvFromPreparation(prepared.envelope);
  return runCompanion(argv, { ...runtime, cwd, env, caller, originalPrompt: undefined, autoLaunchBackground: true });
}
```

Keep direct public `rescue ...` working. Make legacy child `invoke rescue` fail with `PREPARED_INVOCATION_REQUIRED`; other direct commands retain current parsing. Extend `main()` direct/protected/progress classification and allow injection of `runtime.input` for tests. Ensure preparation output and errors never echo envelope fields.

- [ ] **Step 4: Preserve source across explicit same-child choice**

Version the pending Rescue record and save `source` with its exact normalized argv. `invoke-choice` must return that source internally while building the existing `--resume`/`--fresh` argv. Consume legacy executor-bound pending records without source as `explicit`; continue rejecting older records without executor binding.

- [ ] **Step 5: Write failing cleanup tests**

In hook tests, prepare a record and prove:

- a new top-level prompt removes older-turn records only for that session/workspace;
- an allowed/disabled/setup-not-ready Root Stop removes the exact current record;
- a forwarding child Stop leaves the parent record untouched;
- SessionEnd removes all records for its exact session without touching siblings.

- [ ] **Step 6: Implement hook cleanup**

After `beginCallerTurn()` call `cleanupOlderTurns`. In the Root Stop `end()` path call `cleanupTurn` alongside `identity.endCallerTurn`. Add `cleanupSession` to SessionEnd's existing `Promise.allSettled`. Cleanup failures stay bounded/advisory where the surrounding hook is already fail-safe; corrupt matching records must not be silently treated as valid.

- [ ] **Step 7: Verify GREEN, refactor, and commit**

Run:

```bash
node --test tests/rescue-preparation.test.mjs tests/identity.test.mjs tests/hooks.test.mjs tests/integration/skills.test.mjs tests/integration/companion.test.mjs
npm run lint
npm run typecheck
```

Expected: all pass.

Commit: `feat: execute Rescue from prepared objectives`

### Task 3: Root Automatic Routing and Installed Forwarder Contracts

**Files:**
- Modify: `skills/rescue/SKILL.md`
- Modify: `agents/zcode-rescue.toml.template`
- Modify: `tests/helpers/rescue-skill-contract.mjs`
- Modify: `tests/skills-contracts.test.mjs`
- Modify: `tests/managed-agent-role.test.mjs`
- Modify: `tests/release-contracts.test.mjs`
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `SECURITY.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Write failing instruction-contract tests**

Require the installed Root contract to express this exact precedence:

```text
existing active rescueChildId -> rejoin it
explicit --fresh/--resume -> preserve it
explicit + candidate + no choice -> ask once
proactive clear continuation -> prepare resume
proactive clear independent task -> prepare fresh
genuine proactive ambiguity -> ask once before prepare
```

Assert the parent performs `role-status rescue`, then one constant `prepare rescue` process plus same-handle stdin/EOF, then one spawn. Assert the task/source/options never enter command text, environment, spawn message, relay, status, or output. Assert both named and generic initial child mappings use only `invoke-prepared rescue`; choice/status commands remain unchanged. Retain all one-child, ordinary-subagent prohibition, wait, relay, and liveness assertions.

- [ ] **Step 2: Run contract tests and verify RED**

Run:

```bash
node --test tests/skills-contracts.test.mjs tests/managed-agent-role.test.mjs tests/release-contracts.test.mjs
```

Expected: FAIL on the old prompt-derived route and `invoke rescue` constants.

- [ ] **Step 3: Rewrite the Root orchestration section**

In `skills/rescue/SKILL.md`, specify one executable sequence:

1. If an existing `rescueChildId` belongs to this operation, rejoin; do not preflight, prepare, or spawn.
2. Classify `explicit` only when the user wrote the literal marker; otherwise `proactive`.
3. Normalize a non-empty business objective and omit host-only stop/report/review/routing policy.
4. For proactive entry, choose resume/fresh semantically before preparation; ask only genuine ambiguity.
5. Run the existing constant readiness preflight.
6. Start constant `prepare rescue` with a PTY, send one JSON line through the same handle, then send terminal EOF (`U+0004`); accept only the fixed task-free ack and zero exit.
7. Spawn one fresh named Role or the existing verified generic fallback.
8. Retain exact child ID and accept only its authoritative terminal result.

The skill must explicitly say a project command failure inside an active ZCode turn is not a Rescue failure and cannot terminate Root waiting; do not enumerate commands or parse their output.

- [ ] **Step 4: Update the Role and public documentation**

Change only the initial forwarder mapping to:

```text
node "{{PLUGIN_ROOT}}/scripts/zcode-companion.mjs" invoke-prepared rescue
```

Document the prepared stdin/private-state boundary, explicit/proactive routing, lifecycle authority, required setup upgrade after Role digest drift, and unchanged public CLI in both READMEs, SECURITY, and CHANGELOG. Do not document session/history cleanup as part of this feature.

- [ ] **Step 5: Verify GREEN, refactor, and commit**

Run:

```bash
node --test tests/skills-contracts.test.mjs tests/managed-agent-role.test.mjs tests/release-contracts.test.mjs
npm run lint
```

Expected: all pass.

Commit: `feat: route proactive Rescue automatically`

### Task 4: Qualification, Marketplace Snapshot, and Full Verification

**Files:**
- Modify: `tests/helpers/installed-rescue-lifecycle-contract.mjs`
- Modify: `tests/helpers/codex-rescue-qualification.mjs`
- Modify: `tests/codex-rescue-qualification.test.mjs`
- Modify: `tests/e2e/codex-skills-e2e.test.mjs`
- Modify: `scripts/build-marketplace-snapshot.mjs`
- Modify: `tests/marketplace-snapshot.test.mjs`
- Modify: `tests/integration/marketplace-install.test.mjs`
- Regenerate: `marketplace/plugins/zcode/**`

- [ ] **Step 1: Write failing qualification tests**

Extend captured parent evidence to require the order:

```text
role-status exit 0 -> prepare start -> one JSON line -> EOF -> task-free ack exit 0 -> spawn -> child invoke-prepared
```

Add mutation tests for missing/duplicate preparation, task in argv/env/ack/spawn, malformed/trailing stdin, wrong handle, prepare after spawn, source/marker mismatch, replay, and initial child `invoke rescue`. Keep existing named/generic, foreground/background, explicit same-child choice, relay/status, and terminal-causality coverage.

Add deterministic proactive fixtures for clear fresh and clear resume with no `needs-choice`/followup. Add the original incident fixture and assert the fake peer's `AUTHORIZED RESCUE OBJECTIVE` includes the exact normalized development objective and excludes Root-only stop/report policy.

- [ ] **Step 2: Run qualification tests and verify RED**

Run:

```bash
node --test tests/codex-rescue-qualification.test.mjs tests/e2e/codex-skills-e2e.test.mjs
```

Expected: FAIL because captured fixtures and validators still describe the old route.

- [ ] **Step 3: Update qualification helpers and fixtures minimally**

Treat prepare as an allowed parent companion command only in the exact ordered preparation segment. Validate bounded stdin payload structurally without retaining task content in mismatch messages. Change installed `initialCommand` to `invoke-prepared rescue`, recompute the canonical Role SHA-256 fixture, and keep choice/status command constants intact.

- [ ] **Step 4: Write failing marketplace parity tests**

Require snapshot payloads and installation checks for the new runtime module, Root skill, Role template, hooks, docs, and qualification-relevant files. Assert source and marketplace copies are byte-identical.

- [ ] **Step 5: Regenerate the marketplace snapshot**

Run the repository's existing snapshot builder:

```bash
node scripts/build-marketplace-snapshot.mjs
```

Then verify exact parity with `cmp` for every changed mirrored file; do not hand-edit generated marketplace copies.

- [ ] **Step 6: Run full local verification**

Run:

```bash
npm run check:line-endings
npm run lint
npm run typecheck
npm test
npm run test:qualified
git diff --check
```

Expected: all required non-credentialed checks pass; authenticated opt-in tests may report their documented skip only.

- [ ] **Step 7: Commit**

Commit: `test: qualify prepared Rescue routing`

### Task 5: Independent Review, Pull Request, and Required CI

**Files:**
- Review: all changes since `7680b94`
- Modify only if review or CI finds a demonstrated defect.

- [ ] **Step 1: Run specification-compliance review**

Dispatch a fresh reviewer with the full approved spec and commit range. Require explicit coverage of task/control separation, explicit/proactive precedence, single-hop execution, failure authority, security bindings, compatibility, tests, and non-goals. Fix every gap through a failing regression test first, then re-review.

- [ ] **Step 2: Run code-quality review**

Dispatch a different fresh reviewer after spec approval. Review correctness, replay/concurrency behavior, bounded input, private-data exposure, cleanup, maintainability, and test quality. Fix every important issue test-first, then re-review.

- [ ] **Step 3: Perform fresh final verification**

Run the complete commands from Task 4 again after all review fixes. Record exact exit results and ensure `git status --short` contains only intended tracked changes.

- [ ] **Step 4: Push and open the pull request**

Push `fix/rescue-task-routing`, create a PR against `main`, include the problem, architecture, tests, security implications, setup/Role upgrade note, and manual E2E instructions. Do not merge.

- [ ] **Step 5: Monitor required CI until green**

Inspect all required checks. For any failure, read the failing job log, reproduce locally when possible, add a failing regression test for code defects, fix, re-verify, push, and continue monitoring. Completion requires every required PR check to report success.
