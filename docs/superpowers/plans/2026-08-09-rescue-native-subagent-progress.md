# Rescue Native Subagent and Semantic Progress Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Install and verify a managed `zcode-rescue` Agent Role, route foreground Rescue through one isolated native child, render safe semantic progress in that child, and qualify the complete lifecycle without merging `main`.

**Architecture:** Setup owns a digest-backed Role artifact under the stable plugin-data root and registers only the required Codex config leaves. The Rescue skill performs a constant read-only readiness preflight, prefers the named Role, permits a generic child only for host `agent_type` schema incompatibility, and never executes the companion in the parent. ZCode conversation frames are converted by a companion-owned allowlist into bounded child stderr and durable preview events, while `state.updated` remains the only revision-guarded completion boundary.

**Tech Stack:** Node.js 22.13+ ESM, `node:test`, JSDoc checked by TypeScript, Codex app-server JSON-RPC/config API, ZCode v4 JSON-RPC, GitHub Actions.

---

## Execution rules

- Work only in `/Users/zhangzikai/Workspace/Codes/github/zcode-plugin-codex/.worktrees/rescue-native-subagent-progress` on `feat/rescue-native-subagent-progress`.
- Execute implementation tasks serially. One fresh implementer subagent owns one task and its commit; no two implementers write concurrently.
- For every task, capture RED output before production edits, then capture focused GREEN output.
- After each implementation commit, dispatch a read-only spec-compliance reviewer, fix all Critical/Important findings with the original implementer, re-review, then dispatch a read-only code-quality/security reviewer and repeat the same gate.
- Never place the user task, command arguments, job ID, session/turn identity, permissions, capability, credential, raw frame, reasoning, tool output, or file content in a spawn prompt or progress record.
- Do not change the authoritative `state.updated` revision guard, durable ownership, acknowledged cancellation, terminal immutability, or production FD3/FD4 background capability model.
- A skipped authenticated qualification is `unqualified`, not passing evidence.
- Completion requires a pushed PR with every required CI check successful. Do not merge `main`.

## File and module map

- `agents/zcode-rescue.toml.template`: packaged canonical child-forwarder Role template; replaces the obsolete capability-forwarder Markdown artifact and contains only `developer_instructions`.
- `scripts/lib/managed-agent-role.mjs`: the sole owner of Role rendering, stable paths, receipt inspection, collision policy, transaction journal, rollback, and readiness classification.
- `scripts/lib/conversation-progress.mjs`: pure stateful allowlist converting untrusted online conversation frames into bounded progress events.
- `scripts/lib/progress.mjs`: combines lifecycle and semantic events and isolates optional sinks from authoritative execution.
- `scripts/lib/zcode-client.mjs`: owns conversation subscribe/unsubscribe RPC mechanics, not presentation policy.
- `scripts/lib/codex-config.mjs`: orchestrates setup and batches only exact config leaves; it does not duplicate Role ownership rules.
- `scripts/zcode-companion.mjs`: exposes the constant read-only `role-status rescue` preflight and existing constant direct invocation entries.
- `skills/rescue/SKILL.md`: parent orchestration contract only; it preflights, spawns, waits, and reuses the same child.
- Existing identity, pending-choice, job-control, recovery, state, and background-worker modules remain the authorities for their current invariants.

### Task 1: Install and verify the managed Agent Role (#10)

**Files:**
- Create: `agents/zcode-rescue.toml.template`
- Create: `scripts/lib/managed-agent-role.mjs`
- Create: `tests/managed-agent-role.test.mjs`
- Modify: `scripts/lib/fs.mjs`
- Modify: `scripts/lib/codex-config.mjs`
- Modify: `scripts/zcode-companion.mjs`
- Modify: `tests/setup.test.mjs`
- Modify: `tests/fixtures/fake-codex-app-server.mjs`
- Modify: `tests/integration/marketplace-install.test.mjs`
- Modify: `tests/skills-contracts.test.mjs`
- Modify: `tests/windows-compat.test.mjs`
- Modify: `package.json`
- Modify: `npm-shrinkwrap.json`
- Delete: `agents/zcode-rescue.md`

- [ ] **Step 1: Write atomic private-file tests**

Add focused tests proving exact byte preservation, mode `0600` on POSIX, atomic replacement, and tolerated unsupported Windows directory fsync. Import this exact public helper:

```js
import { atomicWritePrivateFile } from '../scripts/lib/fs.mjs';

await atomicWritePrivateFile(target, Buffer.from('role-bytes\n'));
assert.deepEqual(await readFile(target), Buffer.from('role-bytes\n'));
if (process.platform !== 'win32') assert.equal((await stat(target)).mode & 0o777, 0o600);
```

- [ ] **Step 2: Run the atomic-write tests and record RED**

Run:

```bash
node --test --test-name-pattern='atomic private file' tests/managed-agent-role.test.mjs tests/windows-compat.test.mjs
```

Expected: FAIL because `atomicWritePrivateFile` is not exported.

- [ ] **Step 3: Implement exact-byte atomic private writes**

Extract the existing atomic replacement body into this exact byte-oriented helper, then make `atomicWriteJson` serialize through it:

```js
/** @param {string} path @param {string|Buffer} bytes */
export async function atomicWritePrivateFile(path, bytes) {
  const directory = dirname(path);
  const temporaryPath = join(
    directory,
    `.${basename(path)}.${process.pid}.${randomBytes(12).toString('hex')}.tmp`,
  );
  let handle;
  try {
    await ensurePrivateDirectory(directory);
    handle = await open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      await rename(temporaryPath, path);
    } catch (error) {
      if (process.platform !== 'win32'
        || /** @type {NodeJS.ErrnoException} */ (error)?.code !== 'EPERM') throw error;
      await swap(temporaryPath, path);
      await unlink(temporaryPath);
    }
    await chmod(path, 0o600);
    await syncDirectory(directory);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await unlink(temporaryPath).catch(() => {});
    throw wrapError(error, 'ATOMIC_WRITE_FAILED', `Could not atomically write file: ${path}`, {
      category: 'storage',
      remedy: 'Check available disk space and permissions, then retry.',
      details: { path },
    });
  }
}

export async function atomicWriteJson(path, value) {
  await atomicWritePrivateFile(path, `${JSON.stringify(value, null, 2)}\n`);
}
```

- [ ] **Step 4: Write Role render, ownership, collision, and transaction tests**

Cover stable paths, deterministic TOML escaping on macOS/Linux/Windows paths, unsafe symlink rejection, exact receipt/config/file readiness, owned upgrade, missing receipt, modified registration/file/digest, foreign same-name Role, project shadow, higher-precedence override, unrelated config preservation, version races, rollback, and interrupted journal recovery. Use this exact public surface:

```js
export const MANAGED_ROLE_NAME = 'zcode-rescue';
export const MANAGED_ROLE_SCHEMA_VERSION = 1;
export const MANAGED_ROLE_DESCRIPTION =
  'Runs the fixed ZCode Rescue forwarder in an isolated Codex subagent.';
export function managedRolePaths(dataRoot) {}
export function renderManagedRescueRole({ template, pluginRoot }) {}
export async function inspectManagedRescueRole(input) {}
export async function reconcileManagedRescueRole(input) {}
```

Assert the inspection status union is exactly:

```js
['ready', 'install-required', 'upgrade-required', 'restart-required',
 'drift', 'foreign-conflict', 'project-shadowed',
 'higher-precedence-conflict', 'unsupported']
```

- [ ] **Step 5: Run Role ownership tests and record RED**

Run:

```bash
node --test tests/managed-agent-role.test.mjs
```

Expected: FAIL because the module and canonical TOML template do not exist.

- [ ] **Step 6: Implement the deep managed-Role module**

Use stable paths `${dataRoot}/agent-roles/zcode-rescue.toml`, `zcode-rescue.receipt.json`, `zcode-rescue.transaction.json`, and `lock/`. The Role config file itself has the Codex-validated `developer_instructions` field; Role name and description live in the parent `[agents.zcode-rescue]` registration. Render only the TOML-escaped canonical plugin root into this template:

```toml
developer_instructions = """
You are the installed ZCode Rescue forwarder. Accept only the fixed Rescue assignment or a fixed resume/fresh continuation. Run exactly one documented constant command in the current workspace, preserve stderr, and return public stdout verbatim. Never inspect or modify code independently, interpret results, retry, poll, cancel, choose a pending branch, or request/print/persist authorization material.

Initial assignment command:
node "<canonical-plugin-root>/scripts/zcode-companion.mjs" invoke rescue

Resume continuation command:
node "<canonical-plugin-root>/scripts/zcode-companion.mjs" invoke-choice rescue resume

Fresh continuation command:
node "<canonical-plugin-root>/scripts/zcode-companion.mjs" invoke-choice rescue fresh
"""
```

Persist a version-1 receipt containing Role name, plugin identity/version/root, config target, Role path/schema/digest, and provable prior spawn-metadata value. Journal before mutation, write Role bytes, optimistically write exact leaves, re-read effective config, write receipt last, then remove the journal. Roll back only state proven owned; never adopt or overwrite foreign state.

- [ ] **Step 7: Write setup integration tests and record RED**

Assert one optimistic batch contains only these new leaves alongside existing setup edits:

```js
{ keyPath: 'agents.zcode-rescue',
  value: { description: MANAGED_ROLE_DESCRIPTION, config_file: rolePath },
  mergeStrategy: 'upsert' }
{ keyPath: 'features.multi_agent_v2.hide_spawn_agent_metadata',
  value: false,
  mergeStrategy: 'upsert' }
```

Run:

```bash
node --test --test-name-pattern='managed Rescue role|setup uses current config/read|already enabled and trusted hooks' tests/setup.test.mjs tests/integration/marketplace-install.test.mjs
```

Expected: FAIL because setup neither installs the Role nor requires a fresh-session revalidation.

- [ ] **Step 8: Integrate setup, package the template, and remove the old artifact**

Bootstrap the writable data root first. If it changes config, return `restart-required` before Role mutation. Otherwise reconcile the Role, keep `review-gate.json.setupReady` false after any Role/metadata change, and report `ready` only on a later exact no-write verification. Delete `agents/zcode-rescue.md`, pin development Codex to `0.147.0`, update the shrinkwrap with `npm install --package-lock-only`, and ensure marketplace/package tests require the TOML template.

- [ ] **Step 9: Run focused GREEN and commit**

Run:

```bash
node --test tests/managed-agent-role.test.mjs tests/setup.test.mjs tests/plugin-data.test.mjs tests/skills-contracts.test.mjs tests/plugin-contracts.test.mjs tests/windows-compat.test.mjs tests/integration/marketplace-install.test.mjs
npm run lint
npm run typecheck
```

Expected: PASS.

Commit:

```bash
git add agents scripts/lib/fs.mjs scripts/lib/managed-agent-role.mjs scripts/lib/codex-config.mjs scripts/zcode-companion.mjs tests package.json npm-shrinkwrap.json
git commit -m "feat: install managed rescue agent role"
```

### Task 2: Subscribe to and safely describe semantic progress (#11)

**Files:**
- Create: `tests/fixtures/conversation-progress-frames.mjs`
- Create: `scripts/lib/conversation-progress.mjs`
- Create: `tests/conversation-progress.test.mjs`
- Modify: `scripts/lib/zcode-client.mjs`
- Modify: `scripts/lib/progress.mjs`
- Modify: `scripts/lib/review.mjs`
- Modify: `tests/zcode-client.test.mjs`
- Modify: `tests/progress.test.mjs`
- Modify: `tests/job-control.test.mjs`
- Modify: `tests/fixtures/fake-zcode-cli.mjs`
- Modify: `tests/integration/companion.test.mjs`
- Modify: `tests/state.test.mjs`
- Modify: `tests/render-progress.test.mjs`

- [ ] **Step 1: Lock the captured ZCode conversation protocol in fixtures**

Add captured-shape fixtures for `v4/conversation/subscribe`, ack, `initial` and `online` `v4/conversation/frame`, and unsubscribe. Add client tests for valid/malformed ack, exact topic/subscription filtering, disconnect, and unsubscribe.

- [ ] **Step 2: Run client tests and record RED**

Run:

```bash
node --test --test-name-pattern='conversation' tests/zcode-client.test.mjs
```

Expected: FAIL because `subscribeConversation` does not exist and the fake CLI rejects the RPC.

- [ ] **Step 3: Implement the client subscription boundary**

Add:

```js
async subscribeConversation(sessionId, {
  connectionId = randomUUID(),
  clientMode = 'desktop-continuous',
} = {}) {
  // Send v4/conversation/subscribe for conversation/<sessionId>, validate
  // subscriptionId, and return { subscriptionId, unsubscribe }.
}
```

`unsubscribe()` sends `v4/conversation/unsubscribe` once for the validated ID. Keep frame interpretation outside the client.

- [ ] **Step 4: Write adversarial describer tests**

Use this exact interface:

```js
export function createConversationProgressDescriber({
  sessionId, subscriptionId, workspace,
}) {
  return {
    observe(notification, observedAt) {},
    markTerminal() {},
  };
}
export function normalizePreview(value, maxCharacters = 96) {}
export async function containedRelativePath(workspace, candidate) {}
```

Cover Bash/Edit/Write/Read/Grep/Glob/WebSearch/unknown tools, success/failure, online-only delivery, exact topic/subscription, duplicates/reordering/post-terminal events, Unicode-safe 96-code-point preview, C0/C1 controls, huge strings, canonical path containment and symlink escape. Assert no output/reasoning/draft/Edit old/new/file content/env/capability/raw frame string appears.

- [ ] **Step 5: Run describer tests and record RED**

Run:

```bash
node --test tests/conversation-progress.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 6: Implement the allowlisted state machine**

Track each validated row/tool call in a `Map` with `startEmitted`, `terminalEmitted`, and last accepted version/status. Ignore `initial`, foreign, duplicate, stale, reordered, and post-terminal input. Emit at most one meaningful start and one terminal event per tool. Normalize command/query previews to one control-free line and at most 96 Unicode code points; emit only contained workspace-relative paths, fixed status words, bounded counts, and bounded durations.

- [ ] **Step 7: Write reporter and executor failure-isolation tests**

Update the old writer-failure expectation: first writer failure disables stderr but durable preview and final result continue; first preview failure disables only persistence; subscription/unsubscribe/diagnostic failure is nonfatal. Assert online semantic events reach both enabled sinks, initial/foreign frames do not, late frames cannot revive terminal state, and `state.updated` with revision greater than the send baseline remains the only completion signal.

- [ ] **Step 8: Run reporter/executor tests and record RED**

Run:

```bash
node --test tests/progress.test.mjs tests/job-control.test.mjs
node --test --test-name-pattern='progress|conversation|sink' tests/integration/companion.test.mjs
```

Expected: FAIL because conversation frames are ignored and current progress cleanup can replace a successful result with `ZCODE_PROGRESS_FAILED`.

- [ ] **Step 9: Integrate semantic events without coupling them to execution**

Extend `createProgressReporter` with an injected describer and bounded `onDiagnostic`. Register the general observer, attempt subscription after exact session creation, skip initial snapshot, send the turn, activate the reporter, settle only on the existing revision guard, mark the describer terminal, unsubscribe/drain, then extract/publish the authoritative result. Remove progress-only errors from the primary `cleanupErrors` failure path; critical job/result writes stay fail-closed.

- [ ] **Step 10: Run focused GREEN and commit**

Run:

```bash
node --test tests/zcode-client.test.mjs tests/conversation-progress.test.mjs tests/progress.test.mjs tests/job-control.test.mjs tests/integration/companion.test.mjs tests/state.test.mjs tests/render-progress.test.mjs
npm run lint
npm run typecheck
```

Expected: PASS.

Commit:

```bash
git add scripts/lib/zcode-client.mjs scripts/lib/conversation-progress.mjs scripts/lib/progress.mjs scripts/lib/review.mjs tests
git commit -m "feat: render child-local rescue progress"
```

### Task 3: Route foreground Rescue through the native child (#12)

**Files:**
- Modify: `skills/rescue/SKILL.md`
- Modify: `agents/zcode-rescue.toml.template`
- Modify: `scripts/lib/args.mjs`
- Modify: `scripts/lib/render.mjs`
- Modify: `scripts/zcode-companion.mjs`
- Modify: `hooks/subagent-hook.mjs`
- Modify: `tests/args.test.mjs`
- Modify: `tests/skills-contracts.test.mjs`
- Modify: `tests/hooks.test.mjs`
- Modify: `tests/integration/skills.test.mjs`
- Modify: `tests/integration/companion.test.mjs`
- Modify: `tests/e2e/codex-skills-e2e.test.mjs`

- [ ] **Step 1: Write routing contract and read-only preflight tests**

Assert the skill runs `role-status rescue` before spawn, contains no parent-inline `invoke rescue`, uses fresh context, a fixed task name/message, and permits generic fallback only for absent/unsupported `agent_type` schema support after a `ready` preflight. Assert role-status neither consumes caller context nor reserves/reconciles a job.

Named spawn contract:

```js
spawn_agent({
  task_name: 'zcode_rescue',
  fork_turns: 'none',
  agent_type: 'zcode-rescue',
  message: 'Run the installed ZCode Rescue forwarder now. Return its public stdout verbatim.',
})
```

- [ ] **Step 2: Run routing tests and record RED**

Run:

```bash
node --test --test-name-pattern='rescue skill|role-status|subagent hook' tests/skills-contracts.test.mjs tests/args.test.mjs tests/integration/skills.test.mjs tests/integration/companion.test.mjs tests/hooks.test.mjs
```

Expected: FAIL because Rescue currently executes inline and `role-status` is absent.

- [ ] **Step 3: Implement bounded role-status output**

Add the constant CLI entry `role-status rescue`, call `inspectManagedRescueRole`, and render only `{ type:'role-status', role:'zcode-rescue', status, remedy? }`. Return before caller-context consumption, recovery, discovery, reservation, or execution. Any non-ready state uses the exact `$zcode:setup` remedy.

- [ ] **Step 4: Replace the Rescue parent contract and child Role instructions**

The skill must prefer the named spawn above. A generic fallback is allowed only when the active tool schema hides `agent_type` or explicitly rejects that field as unsupported/reserved after a ready preflight. Its fresh-context spawn uses this fixed message after substituting only the preflight-verified canonical plugin root:

```text
Act only as the installed ZCode Rescue forwarder. In the current workspace run exactly:
node "<canonical-plugin-root>/scripts/zcode-companion.mjs" invoke rescue
Preserve stderr and return public stdout verbatim. Do not inspect or modify code independently, interpret results, retry, poll, cancel, choose a pending branch, or request/print/persist authorization material.
```

`unknown agent_type`, unavailable/mismatched Role, config error, drift, shadowing, or outdated state hard-fails. Both routes wait/rejoin one agent and return terminal public output without interpretation. The subagent hook may mark forwarding but must not mint or expose authorization.

- [ ] **Step 5: Add installed orchestration evidence**

Extend the installed Codex harness to assert child metadata names `zcode-rescue`, the child executes only the constant command, ZCode send happens after spawn, and the parent rollout contains no companion terminal output or raw frames. Assert final parent output equals child public stdout.

- [ ] **Step 6: Run focused GREEN and commit**

Run:

```bash
node --test tests/skills-contracts.test.mjs tests/args.test.mjs tests/integration/skills.test.mjs tests/integration/companion.test.mjs tests/hooks.test.mjs
npm run lint
npm run typecheck
```

Expected: PASS; installed E2E either PASS with prerequisites or explicitly reports `unqualified`.

Commit:

```bash
git add skills/rescue/SKILL.md agents/zcode-rescue.toml.template scripts hooks tests
git commit -m "feat: route rescue through native subagent"
```

### Task 4: Reuse one child across choice and waits (#13)

**Files:**
- Modify: `skills/rescue/SKILL.md`
- Modify: `agents/zcode-rescue.toml.template`
- Modify: `tests/identity.test.mjs`
- Modify: `tests/integration/skills.test.mjs`
- Modify: `tests/integration/companion.test.mjs`
- Modify: `tests/e2e/codex-skills-e2e.test.mjs`

- [ ] **Step 1: Write same-child continuation tests**

Assert `needs-choice` is returned verbatim, the parent asks once, and it calls `followup_task` against the existing agent ID with exactly one of:

```text
Continue the pending ZCode Rescue with resume. Run only the installed resume forwarder command and return its public stdout verbatim.
Continue the pending ZCode Rescue with fresh. Run only the installed fresh forwarder command and return its public stdout verbatim.
```

Assert the child runs only `invoke-choice rescue resume` or `invoke-choice rescue fresh`; a wait timeout, early wait return, or steering never triggers another spawn.

- [ ] **Step 2: Run continuation tests and record RED**

Run:

```bash
node --test --test-name-pattern='pending|invoke-choice|needs-choice|same child|wait timeout|steering' tests/identity.test.mjs tests/integration/skills.test.mjs tests/integration/companion.test.mjs
```

Expected: static Role/skill and installed orchestration assertions fail; existing exact-session/workspace/single-use companion tests remain green.

- [ ] **Step 3: Implement fixed same-child continuation instructions**

Teach the Role to return `needs-choice` without choosing and accept only the two fixed follow-ups. Teach the parent skill to retain the child ID, ask once, follow up the same child, and wait again. Preserve existing pending invocation storage; do not introduce a second orchestration store or capability.

- [ ] **Step 4: Qualify one agent ID across a real two-turn flow**

In installed E2E, capture spawn, follow-up, and wait events and assert a single child agent ID for both resume and fresh variants. Assert expired, sibling, wrong-workspace, and replayed pending choices fail actionably without spawning or executing again.

- [ ] **Step 5: Run focused GREEN and commit**

Run:

```bash
node --test tests/identity.test.mjs tests/integration/skills.test.mjs tests/integration/companion.test.mjs tests/skills-contracts.test.mjs
```

Expected: PASS.

Commit:

```bash
git add skills/rescue/SKILL.md agents/zcode-rescue.toml.template tests
git commit -m "feat: continue rescue in the same child"
```

### Task 5: Preserve production-owned background authorization (#14)

**Files:**
- Modify: `tests/background-worker.test.mjs`
- Modify: `tests/identity.test.mjs`
- Modify: `tests/integration/skills.test.mjs`
- Modify: `tests/integration/companion.test.mjs`
- Modify: `tests/skills-contracts.test.mjs`
- Modify: `tests/e2e/codex-skills-e2e.test.mjs`
- Modify production only on demonstrated RED: `scripts/lib/background-worker.mjs`, `scripts/lib/identity.mjs`, `scripts/zcode-companion.mjs`

- [ ] **Step 1: Add native-child background security regressions**

Assert the Role and generic fallback contain no capability transport; explicit `--background` returns only the public queued result; the execution envelope exists only on protected FD3 and ack on FD4; replay, tampering, permission mismatch, startup timeout, and failure revocation retain current behavior. Assert the child may finish after acknowledgement while the detached worker continues.

- [ ] **Step 2: Run background tests and record RED**

Run:

```bash
node --test --test-name-pattern='background|capability|descriptor|replay|tamper|permission' tests/background-worker.test.mjs tests/identity.test.mjs tests/integration/skills.test.mjs tests/integration/companion.test.mjs tests/skills-contracts.test.mjs
```

Expected: old capability-forwarder assumptions or missing native-child coverage fail; established FD and replay tests remain green.

- [ ] **Step 3: Make only the minimal demonstrated production correction**

Keep `startBackgroundWorker` as the only capability transport and keep the model-visible output to the queued public envelope. Do not add a capability parameter to Role, spawn, follow-up, argv, environment, progress, or result. If all production invariants already pass, commit the tests without changing production files.

- [ ] **Step 4: Run focused GREEN and commit**

Run:

```bash
node --test tests/background-worker.test.mjs tests/identity.test.mjs tests/integration/skills.test.mjs tests/integration/companion.test.mjs tests/skills-contracts.test.mjs
```

Expected: PASS.

Commit:

```bash
git add tests scripts/lib/background-worker.mjs scripts/lib/identity.mjs scripts/zcode-companion.mjs
git commit -m "test: preserve production background authorization"
```

### Task 6: Recover or cancel without duplicate execution (#15)

**Files:**
- Modify: `tests/job-control.test.mjs`
- Modify: `tests/recovery.test.mjs`
- Modify: `tests/session-end.test.mjs`
- Modify: `tests/integration/companion.test.mjs`
- Modify: `tests/e2e/codex-skills-e2e.test.mjs`
- Modify production only on demonstrated RED: `scripts/lib/job-control.mjs`, `scripts/lib/recovery.mjs`, `scripts/lib/state.mjs`, `scripts/zcode-companion.mjs`, `hooks/session-end-hook.mjs`

- [ ] **Step 1: Add isolated-child loss, stop, and race tests**

Cover child SIGTERM after accepted send, exactly-once stop, unacknowledged stop preserving nonterminal state/writable guard, parent SessionEnd settlement, ambiguous SessionEnd, late child success/progress after cancellation, competing SessionEnd/orphan election, sibling rejection, and steering with zero cancel/respawn.

- [ ] **Step 2: Run lifecycle tests and record RED**

Run:

```bash
node --test --test-name-pattern='SIGTERM|SessionEnd|unacknowledged|late|race|sibling|orphan|steering' tests/job-control.test.mjs tests/recovery.test.mjs tests/session-end.test.mjs tests/integration/companion.test.mjs
```

Expected: new direct-child composition cases fail where lifecycle wiring is incomplete; established acknowledged-stop, terminal-no-op, lease, and orphan cases remain green.

- [ ] **Step 3: Preserve parent-owned durable identity and acknowledged terminality**

Fix only demonstrated gaps. The job owner stays the runtime-observed parent `CODEX_THREAD_ID`; child loss does not create a second owner or executor. Cancellation marks terminal only after exact `session/stop` acknowledgement. Ambiguous stop retains the nonterminal guard. Existing election/lease locks choose one settlement, and terminal state rejects late child completion or progress.

- [ ] **Step 4: Add installed steering/recovery evidence**

Assert wait interruption and steering reuse the same child/job; explicit cancel targets the exact owned job; parent or Codex loss recovers/settles durable state without another ZCode `session/send`.

- [ ] **Step 5: Run focused GREEN and commit**

Run:

```bash
node --test tests/job-control.test.mjs tests/recovery.test.mjs tests/session-end.test.mjs tests/integration/companion.test.mjs
```

Expected: PASS.

Commit:

```bash
git add tests scripts/lib/job-control.mjs scripts/lib/recovery.mjs scripts/lib/state.mjs scripts/zcode-companion.mjs hooks/session-end-hook.mjs
git commit -m "test: cover isolated rescue recovery"
```

### Task 7: Qualify installed package, documentation, and release contracts (#16)

**Files:**
- Modify: `tests/integration/marketplace-install.test.mjs`
- Modify: `tests/integration/package-install.test.mjs`
- Modify: `tests/marketplace-snapshot.test.mjs`
- Modify: `tests/integration/plugin-layout.test.mjs`
- Modify: `tests/e2e/codex-skills-e2e.test.mjs`
- Modify: `tests/e2e/real-zcode.test.mjs`
- Modify: `scripts/build-marketplace-snapshot.mjs`
- Modify generated snapshot when its content changes: `marketplace/.agents/plugins/marketplace.json`
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `SECURITY.md`
- Modify: `CHANGELOG.md`
- Modify: `skills/setup/SKILL.md`
- Modify: `skills/rescue/SKILL.md`
- Modify: `skills/status/SKILL.md`
- Modify: `tests/plugin-contracts.test.mjs`
- Modify: `tests/release-contracts.test.mjs`

- [ ] **Step 1: Add package/install contract tests**

Assert npm pack and marketplace snapshots include the canonical Role template and progress modules, contain no obsolete Markdown forwarder, and setup installs the Role beneath stable plugin data rather than a versioned cache directory.

- [ ] **Step 2: Add real qualification assertions**

For each supported Codex line, assert Role load/named metadata, narrow fallback, exact inherited thread identity, missing/sibling/stale/mismatched identity failure, parent rollout isolation, child semantic progress, exact final stdout, same-child choice, no duplicate execution on steering/loss, production-only background capability, and acknowledged cancellation/recovery. Record `/agent`/`/subagents` child selection and current-thread `/ps` behavior where the harness exposes TUI events.

- [ ] **Step 3: Run package and qualification tests and record RED**

Run:

```bash
node --test tests/integration/marketplace-install.test.mjs tests/integration/package-install.test.mjs tests/marketplace-snapshot.test.mjs tests/integration/plugin-layout.test.mjs
npm run test:qualified
```

Expected: package assertions fail until snapshot contents are refreshed; real tests PASS only with prerequisites, otherwise explicitly report `unqualified`.

- [ ] **Step 4: Update user/security/release documentation**

Document mandatory setup and restart, exact managed Role ownership/collision behavior, host-only generic fallback, parent lifecycle versus child detail, `/agent`/`/subagents` versus current-thread `/ps`, one-line 96-character command/query previews and the fact that truncation is not secret redaction, subscription degradation, unchanged background semantics, durable status/recovery commands, and uninstall residue. Do not claim compatibility not proven by real qualification.

- [ ] **Step 5: Refresh generated marketplace artifacts**

Run:

```bash
node scripts/build-marketplace-snapshot.mjs
```

Then run:

```bash
node --test tests/integration/marketplace-install.test.mjs tests/integration/package-install.test.mjs tests/marketplace-snapshot.test.mjs tests/integration/plugin-layout.test.mjs tests/plugin-contracts.test.mjs tests/release-contracts.test.mjs tests/skills-contracts.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit qualification and documentation**

```bash
git add README.md README.zh-CN.md SECURITY.md CHANGELOG.md skills tests scripts/build-marketplace-snapshot.mjs marketplace
git commit -m "docs: qualify isolated rescue workflow"
```

### Task 8: Per-ticket reviews and complete local verification

**Files:**
- Review: all changes from merge-base `main...HEAD`
- Modify: only files named by concrete reviewer findings

- [ ] **Step 1: Verify every ticket review gate is closed**

For #10–#16, record the spec reviewer verdict, code-quality/security reviewer verdict, fix commit, and re-review verdict. No Critical or Important finding may remain open. A reviewer must be independent of the implementer for that ticket.

- [ ] **Step 2: Run formatting and static checks**

Run:

```bash
git diff --check main...HEAD
npm run lint
npm run typecheck
```

Expected: all commands exit 0.

- [ ] **Step 3: Run the complete local test suite**

Run:

```bash
npm test
npm run test:qualified
npm run check
```

Expected: ordinary tests and `npm run check` exit 0. Authenticated/credit/platform-dependent cases must be separately recorded as qualified PASS or `unqualified`; a prerequisite skip cannot support a compatibility claim.

- [ ] **Step 4: Inspect repository state**

Run:

```bash
git status --short
git log --oneline --decorate main..HEAD
git diff --stat main...HEAD
```

Expected: no unintended files, no uncommitted production/test changes, and one reviewable commit chain covering the approved spec and issues.

### Task 9: Independent whole-diff audit, PR, and required CI

**Files:**
- Review: all changes from merge-base `main...HEAD`
- Modify: only files named by concrete audit findings

- [ ] **Step 1: Dispatch the independent audit**

Give a fresh read-only audit subagent the approved spec, issues #10–#16, merge-base, and test evidence. Require findings ordered by severity with exact file/line evidence across Role ownership/config precedence, prompt/capability leakage, protocol compatibility, completion revision, progress allowlist, path containment, sink failures, background descriptors, choice replay, cancellation acknowledgement, terminal races, recovery, and duplicate execution.

- [ ] **Step 2: Resolve and re-audit findings**

The relevant original implementer fixes every Critical/Important finding with RED/GREEN evidence and a focused commit. The independent auditor re-runs the affected checks and returns an explicit clean verdict. Minor findings are fixed or documented with rationale before PR creation.

- [ ] **Step 3: Re-run final verification after the audit**

Run:

```bash
git diff --check main...HEAD
npm run check
```

Expected: exit 0 after the final audit fix.

- [ ] **Step 4: Push and open the PR without merging**

Run:

```bash
git push -u origin feat/rescue-native-subagent-progress
gh pr create --base main --head feat/rescue-native-subagent-progress --title "feat: isolate ZCode Rescue in a native subagent" --body-file /tmp/zcode-rescue-pr-body.md
```

The PR body must link `#10` through `#16`, summarize architecture/security boundaries, list local/real qualification evidence, and state that `main` has not been merged.

- [ ] **Step 5: Wait for every required CI check**

Run:

```bash
gh pr checks --watch --fail-fast=false
```

Expected: every required check is successful across the repository's Ubuntu/macOS/Windows and Node `22.13.0`/`lts/*` matrix. Pending, skipped-required, cancelled, or failed checks mean the work is not complete. Diagnose failures with logs, assign the fix to the appropriate serial implementer, re-review that fix, push, and wait again.

- [ ] **Step 6: Produce the final handoff**

Report the feature worktree and branch, commit list, PR link, all local verification commands, real qualification status per supported environment, per-ticket review verdicts, whole-diff audit verdict, and required CI results. Explicitly state that the PR remains unmerged.
