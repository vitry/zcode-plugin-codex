# Rescue Dynamic Agent Naming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each Rescue child a bounded task-specific native name while keeping display naming completely independent from Rescue identity, authorization, and same-child continuation.

**Architecture:** Treat the spawned task name and observed agent path as opaque presentation evidence during Rescue identity qualification. Put the exact display grammar behind a separate assertion interface used only by qualification and contract tests; production hooks and the companion never consume it. Update the installed skill to choose one safe dynamic name after readiness preflight and reuse the exact child ID for all waits and choices.

**Tech Stack:** Node.js 22.13, ECMAScript modules, native `node:test`, Codex plugin Markdown skills, existing marketplace snapshot tooling, GitHub CLI.

---

## File Map

- `tests/helpers/codex-rescue-qualification.mjs` — keep identity qualification name-agnostic and expose the separate display-name conformance assertion.
- `tests/codex-rescue-qualification.test.mjs` — prove both directions of identity/name independence, exact grammar bounds, and dynamic choice evidence.
- `skills/rescue/SKILL.md` — instruct the top-level agent to select one bounded dynamic presentation name without relaying private task material.
- `marketplace/plugins/zcode/skills/rescue/SKILL.md` — exact checked-in marketplace mirror of the canonical Rescue skill.
- `tests/skills-contracts.test.mjs` — enforce the installed instruction grammar, privacy constraints, identity disclaimer, collision behavior, and canonical/mirror parity.
- `tests/e2e/codex-skills-e2e.test.mjs` — qualify the actual dynamic task name independently from trusted Rescue execution and same-child choice evidence.
- `README.md`, `README.zh-CN.md` — explain how dynamic Rescue names appear in `/agent` or `/subagents` and that they are display-only.
- `marketplace/plugins/zcode/README.md`, `marketplace/plugins/zcode/README.zh-CN.md` — exact documentation mirrors.
- `CHANGELOG.md`, `marketplace/plugins/zcode/CHANGELOG.md` — record the new naming behavior and identity invariant.

### Task 1: Separate Rescue Identity Qualification from Display Conformance

**Files:**
- Modify: `tests/helpers/codex-rescue-qualification.mjs`
- Modify: `tests/codex-rescue-qualification.test.mjs`

- [ ] **Step 1: Add RED tests for the independent display assertion**

Import the new interface and change the canonical fixture to a dynamic name:

```js
import {
  assertCodexRescueDisplayName,
  CodexRescueEvidenceMismatchError,
  qualifyCodexRescueChoiceEvidence,
  qualifyCodexRescueEvidence,
} from './helpers/codex-rescue-qualification.mjs';

const taskName = 'zcode_rescue_fix_progress';
const agentPath = `/root/${taskName}`;
```

Add a helper that updates every presentation surface consistently without changing Role, child ID, parent linkage, command, or hook evidence:

```js
function setPresentation(input, nextTaskName, nextAgentPath) {
  const parent = input.rollouts.find((events) => events.some((event) => event.payload?.id === parentId));
  const child = input.rollouts.find((events) => events.some((event) => event.payload?.id === childId));
  const spawn = parent.find((event) => event.payload?.name === 'spawn_agent');
  const spawnArgs = JSON.parse(spawn.payload.arguments);
  spawn.payload.arguments = JSON.stringify({ ...spawnArgs, task_name: nextTaskName });
  parent.find((event) => event.payload?.kind === 'started').payload.agent_path = nextAgentPath;
  parent.find((event) => event.payload?.type === 'agent_message' && event.payload.author === agentPath).payload.author = nextAgentPath;
  child[0].payload.source.subagent.thread_spawn.agent_path = nextAgentPath;
}
```

Add tests with these exact assertions:

```js
test('display naming is neither sufficient nor necessary Rescue identity evidence', () => {
  const trusted = fixture();
  setPresentation(trusted, 'ordinary_child', '/root/ordinary_child');
  const trustedEvidence = qualifyCodexRescueEvidence(trusted, options());
  assert.equal(trustedEvidence.agentType, 'zcode-rescue');
  assert.throws(
    () => assertCodexRescueDisplayName(trustedEvidence),
    (error) => error instanceof CodexRescueEvidenceMismatchError
      && error.code === 'display-task-name-contract',
  );

  const spoofed = fixture();
  childMeta(spoofed).payload.source.subagent.thread_spawn.agent_role = 'default';
  assert.throws(
    () => qualifyCodexRescueEvidence(spoofed, options()),
    (error) => error instanceof CodexRescueEvidenceMismatchError
      && error.code === 'agent-role-mismatch',
  );
});

test('display conformance validates only the bounded grammar and host path relationship', () => {
  const evidence = qualifyCodexRescueEvidence(fixture(), options());
  assert.deepEqual(assertCodexRescueDisplayName(evidence), {
    taskName,
    agentPath,
    displayNameConforms: true,
  });

  const hostMismatch = fixture();
  setPresentation(hostMismatch, taskName, '/root/host_selected_label');
  const hostMismatchEvidence = qualifyCodexRescueEvidence(hostMismatch, options());
  assert.equal(hostMismatchEvidence.agentType, 'zcode-rescue');
  assert.throws(
    () => assertCodexRescueDisplayName(hostMismatchEvidence),
    (error) => error instanceof CodexRescueEvidenceMismatchError
      && error.code === 'display-agent-path-contract',
  );
});
```

Cover `zcode_rescue_task`, one-to-three semantic words, optional ordinals `2` and `9999`, invalid characters, four semantic words, 65-byte names, ordinal `01`, ordinal `1`, and a valid name paired with the wrong path leaf.

- [ ] **Step 2: Run the focused test and capture RED**

Run:

```bash
node --test tests/codex-rescue-qualification.test.mjs
```

Expected: FAIL because `assertCodexRescueDisplayName` is not exported and identity qualification still requires the fixed expected task name/path.

- [ ] **Step 3: Implement the separate display-name assertion**

Add a small presentation-only interface in `tests/helpers/codex-rescue-qualification.mjs`:

```js
const MAX_RESCUE_TASK_NAME_BYTES = 64;
const RESCUE_TASK_NAME_PATTERN = /^zcode_rescue_[a-z][a-z0-9]{0,15}(?:_[a-z][a-z0-9]{0,15}){0,2}(?:_(?:[2-9]|[1-9][0-9]{1,3}))?$/u;

export function assertCodexRescueDisplayName(evidence) {
  const taskName = boundedString(evidence?.taskName);
  const agentPath = boundedString(evidence?.agentPath);
  if (!taskName
    || Buffer.byteLength(taskName, 'utf8') > MAX_RESCUE_TASK_NAME_BYTES
    || !RESCUE_TASK_NAME_PATTERN.test(taskName)) {
    mismatch('display-task-name-contract', 'The Rescue display task name does not match the bounded naming convention.');
  }
  if (agentPath !== `/root/${taskName}`) {
    mismatch('display-agent-path-contract', 'The native agent path does not present the spawned Rescue task name.');
  }
  return { taskName, agentPath, displayNameConforms: true };
}
```

This helper must remain in test qualification code. Do not import it from `scripts/`, hooks, state, the companion, or any production runtime module.

- [ ] **Step 4: Make identity qualification treat names and paths as opaque linked evidence**

Replace fixed-name checks in initial and choice qualification with bounded-presence checks:

```js
const taskName = boundedString(spawnArgs.task_name);
if (!taskName || spawnArgs.fork_turns !== 'none') {
  mismatch('spawn-contract-mismatch', 'The native spawn task or context mode differs from the Rescue contract.');
}
```

Capture `agentPath` from the linked start event, then continue using that exact observed value in `validateParentChildRoute`, child-return lookup, wait/list evidence, and choice evidence. Remove `expectedTaskName` and `expectedAgentPath` from option objects. Do not derive Role, route, authorization, or child ID from either value.

Ensure initial, background, and choice evidence returns the observed presentation fields:

```js
return {
  parentThreadId,
  childThreadId,
  agentPath,
  taskName,
  agentType,
  route,
  // existing evidence fields remain unchanged
};
```

- [ ] **Step 5: Run qualification tests GREEN**

Run:

```bash
node --test tests/codex-rescue-qualification.test.mjs
if rg -n 'assertCodexRescueDisplayName|RESCUE_TASK_NAME_PATTERN' scripts hooks; then exit 1; fi
```

Expected: all tests pass, including the explicit spoofed-name, real-Rescue/nonconforming-name, and host-path-mismatch cases; the production-source search emits no matches.

- [ ] **Step 6: Commit the qualification seam**

```bash
git add tests/helpers/codex-rescue-qualification.mjs tests/codex-rescue-qualification.test.mjs
git commit -m "test: separate rescue identity from display naming"
```

### Task 2: Define Dynamic Naming in the Installed Rescue Skill

**Files:**
- Modify: `tests/skills-contracts.test.mjs`
- Modify: `skills/rescue/SKILL.md`
- Modify: `marketplace/plugins/zcode/skills/rescue/SKILL.md`

- [ ] **Step 1: Replace the fixed-name contract with RED dynamic-name assertions**

Replace the assertion for literal `task_name: 'zcode_rescue'` with checks for one selected variable and the identity disclaimer:

```js
assert.match(source, /rescueTaskName/);
assert.match(source, /zcode_rescue_<semantic_slug>\[_<ordinal>\]/);
assert.match(source, /after the readiness preflight succeeds[\s\S]+before spawn/i);
assert.match(source, /neither sufficient nor necessary[\s\S]+Rescue/i);
assert.match(source, /must not (?:classify|authorize|route)[\s\S]+task(?: name|_name)/i);
assert.match(source, /task_name:\s*rescueTaskName/);
assert.match(source, /smallest available ordinal/i);
assert.match(source, /zcode_rescue_task/);
assert.doesNotMatch(source, /task_name:\s*['"]zcode_rescue['"]/);
```

Add source assertions that the slug must not copy task text, prompt fragments, paths, names, issue/job/session IDs, hashes, credentials, capability material, or authorization data. Retain all existing single-hop, fixed-message, one-spawn, one-exec, and same-child continuation assertions.

- [ ] **Step 2: Run the skills contract and capture RED**

Run:

```bash
node --test tests/skills-contracts.test.mjs
```

Expected: FAIL because the canonical skill still hard-codes `zcode_rescue`.

- [ ] **Step 3: Add the display-only naming instructions after readiness preflight**

Add this contract to `skills/rescue/SKILL.md` after the `ready` preflight rule and before route selection:

```text
After the readiness preflight succeeds and before spawning, choose `rescueTaskName` once as display metadata only. Its form is exactly `zcode_rescue_<semantic_slug>[_<ordinal>]`: use one to three lowercase ASCII semantic words, each beginning with a letter and containing at most 16 lowercase letters or digits; the complete name is at most 64 UTF-8 bytes. Choose a generic description of the objective, never a copy or mechanical transformation of task text. Never include prompt fragments, repository or filesystem paths, personal names, issue/job/session identifiers, hashes, credentials, capabilities, or authorization material. If no safe semantic description is available, use `zcode_rescue_task`. If that sibling name is already occupied, append the smallest available ordinal from 2 through 9999 before the single spawn.

`task_name` and `agent_path` are presentation metadata. Matching this convention is neither sufficient nor necessary evidence that a child is Rescue. Never classify, authorize, route, reject, downgrade, or recover a Rescue child from its name or path. Trusted routing continues to use the named Role where available, exact returned child ID, parent-child linkage, fixed forwarder contract, and hook-bound executor state.
```

Change only the task-name field in both route examples:

```text
task_name: rescueTaskName,
```

Keep `agent_type: 'zcode-rescue'`, the named message, generic message, preflight, and all constant companion commands byte-for-byte unchanged.

- [ ] **Step 4: Update the exact marketplace skill mirror**

Apply the identical textual change to `marketplace/plugins/zcode/skills/rescue/SKILL.md`, then verify:

```bash
cmp skills/rescue/SKILL.md marketplace/plugins/zcode/skills/rescue/SKILL.md
```

Expected: exit 0 with no output.

- [ ] **Step 5: Run skill and qualification contract tests GREEN**

Run:

```bash
node --test tests/skills-contracts.test.mjs tests/codex-rescue-qualification.test.mjs
```

Expected: all tests pass with no fixed-name assertion remaining.

- [ ] **Step 6: Commit the installed naming contract**

```bash
git add skills/rescue/SKILL.md marketplace/plugins/zcode/skills/rescue/SKILL.md tests/skills-contracts.test.mjs
git commit -m "feat: name rescue agents by delegated task"
```

### Task 3: Qualify Installed Dynamic Names and Document the UX

**Files:**
- Modify: `tests/e2e/codex-skills-e2e.test.mjs`
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `marketplace/plugins/zcode/README.md`
- Modify: `marketplace/plugins/zcode/README.zh-CN.md`
- Modify: `CHANGELOG.md`
- Modify: `marketplace/plugins/zcode/CHANGELOG.md`

- [ ] **Step 1: Add RED installed qualification assertions**

Import `assertCodexRescueDisplayName` in `tests/e2e/codex-skills-e2e.test.mjs`. Remove every `expectedTaskName` and `expectedAgentPath` option. Immediately after each foreground, background, choice, or encrypted-message evidence object is available, add:

```js
const display = assertCodexRescueDisplayName(evidence);
assert.equal(display.displayNameConforms, true);
assert.match(display.taskName, /^zcode_rescue_/u);
assert.equal(display.agentPath, `/root/${display.taskName}`);
```

Add fixed private sentinels from the installed prompts to the assertion set and prove none appears in `display.taskName` or `display.agentPath`. Do not require an exact semantic slug from a real model; require only the approved grammar and absence of private source text.

For choice evidence, assert that initial and continuation evidence exposes the same original `taskName`, `agentPath`, and `childThreadId`; the follow-up target remains the child ID.

- [ ] **Step 2: Run deterministic E2E source contracts and capture RED**

Run:

```bash
node --test tests/e2e/codex-skills-e2e.test.mjs tests/skills-contracts.test.mjs
```

Expected: deterministic source checks fail until all installed qualification call sites use the separate display assertion. Authenticated credit-spending cases remain explicit opt-in skips.

- [ ] **Step 3: Update every qualification call site**

For each call to `qualifyCodexRescueEvidence`, `qualifyCodexRescueBackgroundEvidence`, and `qualifyCodexRescueChoiceEvidence`:

```js
const evidence = qualifyCodexRescueEvidence(input, {
  expectedAgentType: 'zcode-rescue',
  expectedWorkspace: canonicalWorkspace,
  expectedCommand,
  expectedPreflightCommand,
  expectedNamedSpawnMessage,
  expectedGenericSpawnMessage,
  expectedPublicOutput,
  // retain existing execution, progress, privacy, and capability options
});
const display = assertCodexRescueDisplayName(evidence);
```

When an encrypted spawn message produces `CodexRescueUnqualifiedError`, apply the same display assertion to `error.evidence` before reporting the encryption limitation. Name conformance must not bypass any existing route, execution, yield, exit, privacy, or parent-isolation checks.

- [ ] **Step 4: Document display-only dynamic names in English and Chinese**

Add a concise paragraph near the existing `/agent` and `/subagents` instructions.

English contract:

```text
Rescue children use a task-specific native display name such as `/root/zcode_rescue_fix_progress`, with a bounded ordinal when a sibling name is already occupied. This name and path are only for navigation: matching the `zcode_rescue_*` convention neither proves that a child is Rescue nor grants Rescue authority, and a different display name does not remove authority from an otherwise trusted Rescue child.
```

Chinese contract:

```text
Rescue child 使用任务相关的原生显示名称，例如 `/root/zcode_rescue_fix_progress`；同级名称冲突时会添加有界序号。名称和路径只用于导航：符合 `zcode_rescue_*` 规范既不能证明 child 是 Rescue，也不会授予 Rescue 权限；显示名称不同也不会移除一个已由可信链路确认的 Rescue child 的权限。
```

Record the same behavior under `Unreleased` in both changelogs. Apply identical English/Chinese and changelog changes to the checked-in marketplace mirrors.

- [ ] **Step 5: Run focused tests and mirror checks GREEN**

Run:

```bash
node --test tests/codex-rescue-qualification.test.mjs tests/skills-contracts.test.mjs tests/e2e/codex-skills-e2e.test.mjs
cmp skills/rescue/SKILL.md marketplace/plugins/zcode/skills/rescue/SKILL.md
cmp README.md marketplace/plugins/zcode/README.md
cmp README.zh-CN.md marketplace/plugins/zcode/README.zh-CN.md
cmp CHANGELOG.md marketplace/plugins/zcode/CHANGELOG.md
```

Expected: focused tests pass, authenticated cases are only the documented opt-in skips, and every comparison exits 0.

- [ ] **Step 6: Commit installed qualification and documentation**

```bash
git add tests/e2e/codex-skills-e2e.test.mjs README.md README.zh-CN.md CHANGELOG.md marketplace/plugins/zcode/README.md marketplace/plugins/zcode/README.zh-CN.md marketplace/plugins/zcode/CHANGELOG.md
git commit -m "test: qualify dynamic rescue agent names"
```

### Task 4: Verify, Review, Submit the Stacked PR, and Follow CI

**Files:**
- Review all changes from `5acea20f20a5696fb1003561b8ff43b991512d54` through feature HEAD.
- Do not add implementation files unless a verified review finding requires them.

- [ ] **Step 1: Run fresh local verification**

Run:

```bash
npm run lint
npm run typecheck
npm run check
git diff --check 5acea20f20a5696fb1003561b8ff43b991512d54...HEAD
git status --short
```

Expected: lint and typecheck exit 0; ordinary, marketplace-build, and qualification suites have zero failures with only documented opt-in skips; diff check has no output; worktree is clean.

- [ ] **Step 2: Perform two-stage independent review**

Dispatch one review subagent for Spec conformance and one review subagent for repository standards/security. Give both the fixed range `5acea20f20a5696fb1003561b8ff43b991512d54...HEAD` and require file/line evidence for every finding.

The Spec review must explicitly verify:

```text
- matching names never qualify or authorize Rescue;
- nonmatching names never disqualify an otherwise trusted Rescue child;
- generic routing does not substitute the prefix for missing Role metadata;
- choice targets the original child ID;
- no prompt/path/identity/capability material enters the name;
- one-spawn and same-handle terminal behavior remain intact.
```

The standards review must check privacy, bounded UTF-8 handling, regex/ordinal edge cases, fixture completeness, mirror parity, and absence of production imports from the test-only display assertion.

- [ ] **Step 3: Resolve and re-review all blocking findings**

For each Critical or Important finding, reproduce it with a failing test, implement the smallest fix, rerun the focused test, and send the exact follow-up commit to the original reviewer. Repeat until both reviewers report no Critical or Important findings.

- [ ] **Step 4: Push and open a separate stacked PR**

Run:

```bash
git push -u origin feat/rescue-dynamic-agent-naming
gh pr create --base fix/rescue-progress-compatibility --head feat/rescue-dynamic-agent-naming --title "Name Rescue agents by delegated task" --body "Stacked on #28 until the Rescue progress compatibility work merges.

## Summary
- choose bounded task-specific display names for native Rescue children
- keep task names and agent paths independent from Rescue identity and authorization
- preserve exact-child waits, yielded execution, and same-child choice continuation

## Verification
- focused qualification, skill contract, and installed E2E suites
- npm run check
- independent Spec and standards review"
```

The PR body must link PR #28 as its temporary base, summarize the display-only invariant, list RED/GREEN evidence and local verification, and state that the branch will be retargeted to `main` after PR #28 merges.

- [ ] **Step 5: Follow required CI to green**

Run:

```bash
gh pr checks --watch
```

Expected: all required Ubuntu, macOS, and Windows Node checks complete successfully. If a check fails, inspect its logs, reproduce locally where possible, add a focused RED/GREEN fix commit, push, and repeat independent review for the changed range before watching CI again.

- [ ] **Step 6: Record final delivery evidence**

Capture the final PR URL, HEAD SHA, required-check conclusions, exact local test totals, documented opt-in skips, reviewer verdicts, and clean worktree status. Delivery is not complete while a required CI check is pending or failing.
