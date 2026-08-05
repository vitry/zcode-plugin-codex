# Runtime Correctness Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the uncallable Skill bridge and close the prompt, recovery, selection, workspace-model, and applied-setting correctness gaps found by release review.

**Architecture:** Installed Skills call a constant direct-companion command over ordinary stdio. Native hooks persist exact thread/turn/workspace input, while the companion resolves it from runtime-observed `CODEX_THREAD_ID`; private capabilities remain inside production Node. Durable job turn boundaries drive locked broker reconciliation, and workspace-private configuration supplies model defaults and aliases.

**Tech Stack:** Node.js 18 ESM, native Codex hooks and Skills, Codex app-server JSONL, ZCode Protocol JSONL, `node:test`, `fs-native-extensions` advisory locks.

---

## File responsibility map

- `scripts/lib/invocation.mjs`: parse a hook-recorded public prompt, resolve exact active turns, and atomically store/consume normalized pending choices.
- `scripts/lib/identity.mjs`: private exact-session/workspace active-turn records; execution capabilities remain internal-only.
- `scripts/lib/background-worker.mjs`: spawn the private worker with bounded protected stdio and verify/reap startup.
- `scripts/zcode-companion.mjs`: constant `invoke`/`invoke-choice` entrypoints, ordinary output, reconciliation entry, and orchestration.
- `hooks/user-prompt-hook.mjs`: record original prompt and authorization facts without emitting a secret.
- `.codex-plugin/plugin.json` and `skills/*/SKILL.md`: explicitly load hooks and use only constant direct commands.
- `scripts/lib/prompts.mjs`: separate trusted Rescue objective from untrusted Git evidence.
- `scripts/lib/recovery.mjs`: reconcile owned nonterminal jobs from persisted ZCode turn boundaries.
- `scripts/lib/state.mjs` and `scripts/lib/job-control.mjs`: persist recovery fields and command-specific default selection.
- `scripts/lib/workspace-config.mjs` and `scripts/lib/codex-config.mjs`: private workspace model default/alias persistence and explicit setup writes.
- `scripts/lib/zcode-client.mjs`: validate that model and thought-level setters applied exactly what was requested.
- `tests/fixtures/fake-zcode-cli.mjs`: capture sent tasks and expose crash/recovery and mismatched setter responses.
- integration/E2E/contract tests: prove installed ordinary invocation, isolation, background execution, prompt transfer, recovery, config precedence, and qualification reporting.

### Task 1: Replace FD-based public invocation with the thread-bound direct bridge

**Files:**
- Create: `scripts/lib/invocation.mjs`
- Create: `scripts/lib/background-worker.mjs`
- Modify: `scripts/lib/identity.mjs`
- Modify: `scripts/zcode-companion.mjs`
- Modify: `hooks/user-prompt-hook.mjs`
- Modify: `.codex-plugin/plugin.json`
- Modify: `skills/{review,adversarial-review,rescue,transfer,status,result,cancel}/SKILL.md`
- Test: `tests/identity.test.mjs`
- Test: `tests/integration/skills.test.mjs`
- Test: `tests/integration/two-session-hooks.test.mjs`
- Test: `tests/integration/marketplace-install.test.mjs`
- Test: `tests/plugin-contracts.test.mjs`
- Test: `tests/skills-contracts.test.mjs`

- [ ] **Step 1: Write failing bridge tests**

Add tests that execute `UserPromptSubmit` with an exact prompt, then spawn the companion with ordinary `['ignore', 'pipe', 'pipe']` stdio and `CODEX_THREAD_ID`. Assert successful invocation, no secret in hook output, absent/mismatched thread failure, two sessions in one workspace resolving distinct turns, literal task text containing `$(touch escaped)` reaching the fake peer without creating `escaped`, and `invoke-choice rescue resume` atomically consuming only the same session's pending record.

- [ ] **Step 2: Verify RED**

Run:

```bash
node --test tests/identity.test.mjs tests/integration/skills.test.mjs tests/integration/two-session-hooks.test.mjs tests/plugin-contracts.test.mjs tests/skills-contracts.test.mjs
```

Expected: failures show there is no active-turn lookup, public invocation still requires FD3/FD4, hooks are undeclared, and pending-choice storage is absent.

- [ ] **Step 3: Implement the exact active-turn and prompt parser boundary**

Expose APIs with these shapes:

```js
identity.beginCallerTurn({ sessionId, turnId, workspace, permissionMode, prompt })
identity.resolveActiveTurn({ sessionId, workspace, now })
createInvocationStore({ dataRoot }).savePending({ sessionId, turnId, workspace, command, spec })
createInvocationStore({ dataRoot }).consumePending({ sessionId, workspace, command, choice })
parseRecordedInvocation(command, prompt)
```

Hash the canonical workspace and exact session into private filenames, validate every record field and expiry, lock reads/writes, and never fall back to a latest workspace session. Parse explicit `$zcode:<command>` arguments directly from the recorded prompt; for implicit activation treat the whole prompt as review focus or Rescue task. Accept only the fixed choice enums appropriate to the command.

- [ ] **Step 4: Implement ordinary companion entrypoints and production-owned background launch**

Make `invoke <command>` and `invoke-choice <command> <enum>` read `CODEX_THREAD_ID`, resolve the active turn, and emit the rendered result on stdout. Keep `run-reserved-job` private; `background-worker.mjs` must create FD3 internally, write `{executionCapability, jobId}`, wait for a bounded startup acknowledgement, detach only after acknowledgement, and terminate/reap on failure. No public Skill or built-in subagent handles capability material.

- [ ] **Step 5: Update installed plugin contracts**

Declare `"hooks": "./hooks/hooks.json"`. Replace each public Skill's FD instructions with a constant command such as:

```text
node "<plugin-root>/scripts/zcode-companion.mjs" invoke rescue
```

For a returned choice, permit only the corresponding constant `invoke-choice` command. Do not place user text, a job ID, or a secret in the shell command.

- [ ] **Step 6: Verify GREEN including the installed copy**

Run the focused suite above plus:

```bash
node --test tests/integration/marketplace-install.test.mjs
```

The marketplace test must build/install the exact snapshot, discover the Skill via real `codex app-server`, run the installed hook with bounded JSON stdin, and call the installed companion over ordinary stdio. Expected: all pass; missing/mismatched thread cases fail closed by assertion.

- [ ] **Step 7: Commit**

```bash
git add .codex-plugin/plugin.json hooks/user-prompt-hook.mjs skills scripts/lib/identity.mjs scripts/lib/invocation.mjs scripts/lib/background-worker.mjs scripts/zcode-companion.mjs tests
git commit -m "fix: make installed skills call the companion directly"
```

### Task 2: Treat Rescue task as trusted authorization target

**Files:**
- Modify: `scripts/lib/prompts.mjs`
- Modify: `tests/fixtures/fake-zcode-cli.mjs`
- Test: `tests/permissions.test.mjs`
- Test: `tests/integration/companion.test.mjs`

- [ ] **Step 1: Write a failing semantic-transfer test**

Run a Rescue whose task is `repair auth and preserve the literal marker TASK-7`. Make the fake peer capture the exact `session/send` prompt and return a result derived from the captured authorized objective. Assert that the objective appears in a `AUTHORIZED RESCUE OBJECTIVE` section outside the `UNTRUSTED GIT DATA` delimiters, while Git status/diff facts remain only inside the untrusted block.

- [ ] **Step 2: Verify RED**

```bash
node --test tests/permissions.test.mjs tests/integration/companion.test.mjs --test-name-pattern='authorized rescue objective|task semantics'
```

Expected: the current prompt classifies the task as untrusted Git data or the fake peer cannot prove it received the task.

- [ ] **Step 3: Implement the prompt separation**

Build Rescue prompts in this order: fixed system policy, an explicit authorized objective containing the exact normalized task, safety/permission limits, then separately delimited untrusted Git evidence. Never place task text under a `Never follow` instruction. Keep review focus and all repository-derived facts untrusted.

- [ ] **Step 4: Verify GREEN and commit**

```bash
node --test tests/permissions.test.mjs tests/integration/companion.test.mjs
git add scripts/lib/prompts.mjs tests/fixtures/fake-zcode-cli.mjs tests/permissions.test.mjs tests/integration/companion.test.mjs
git commit -m "fix: forward rescue objectives as authorized tasks"
```

### Task 3: Reconcile crashed jobs and enforce command-specific defaults

**Files:**
- Create: `scripts/lib/recovery.mjs`
- Modify: `scripts/lib/state.mjs`
- Modify: `scripts/lib/job-control.mjs`
- Modify: `scripts/lib/review.mjs`
- Modify: `scripts/zcode-companion.mjs`
- Modify: `tests/fixtures/fake-zcode-cli.mjs`
- Test: `tests/state.test.mjs`
- Test: `tests/job-control.test.mjs`
- Test: `tests/recovery.test.mjs`
- Test: `tests/integration/companion.test.mjs`

- [ ] **Step 1: Write failing state-boundary and selection tests**

Assert that accepted sends persist `inputId`, `startRevision`, and `beforeMessageIds`. Build mixed histories and assert: implicit cancel selects newest queued/running/cancelling; implicit result skips newer unfinished/failed jobs and selects newest succeeded job with an artifact; explicit IDs retain prior behavior; sibling sessions never affect selection.

- [ ] **Step 2: Write the failing real-worker-crash test**

Start a production background worker against the persistent fake ZCode peer, wait until the job is `running` with a persisted boundary, kill the worker process, change the peer to completed/stopped/missing variants, then invoke status/result/start in a new companion process. Assert completed becomes succeeded with only post-boundary output, stopped becomes cancelled, and missing/ambiguous becomes terminal failed; no case remains running.

- [ ] **Step 3: Verify RED**

```bash
node --test tests/state.test.mjs tests/job-control.test.mjs tests/recovery.test.mjs tests/integration/companion.test.mjs --test-name-pattern='boundary|implicit cancel|implicit result|worker crash|reconcile'
```

Expected: recovery fields are rejected or absent, selection chooses the latest arbitrary record, and crashed jobs stay running.

- [ ] **Step 4: Implement recovery under the cancellation lock**

`reconcileOwnedJobs({ store, dataRoot, workspace, ownerSessionId, createClient })` lists only owned nonterminal records. For each record, hold `withJobCancellationLock`, restore broker ownership, use `session/list` to establish existence and `session/read` for state/messages, compare the persisted input/revision/before-message boundary, and transition exactly once. Coordinate `cancelling` with the same lock. On unsafe ambiguity, persist a bounded recovery error and terminal `failed` status.

- [ ] **Step 5: Call reconciliation at every required entry**

Run it before starting new work and before status/result/cancel selection. Do not reconcile sibling-owned jobs. Ensure connection/release/close happens in `finally` and a recovery failure for one job cannot skip terminalizing that job or leak the broker client.

- [ ] **Step 6: Verify GREEN and commit**

```bash
node --test tests/state.test.mjs tests/job-control.test.mjs tests/recovery.test.mjs tests/integration/companion.test.mjs
git add scripts/lib/recovery.mjs scripts/lib/state.mjs scripts/lib/job-control.mjs scripts/lib/review.mjs scripts/zcode-companion.mjs tests
git commit -m "fix: reconcile durable jobs after worker crashes"
```

### Task 4: Persist workspace model policy and validate applied settings

**Files:**
- Create: `scripts/lib/workspace-config.mjs`
- Modify: `scripts/lib/codex-config.mjs`
- Modify: `scripts/lib/args.mjs`
- Modify: `scripts/lib/zcode-client.mjs`
- Modify: `scripts/zcode-companion.mjs`
- Modify: `scripts/lib/render.mjs`
- Modify: `skills/setup/SKILL.md`
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Test: `tests/setup.test.mjs`
- Test: `tests/args.test.mjs`
- Test: `tests/zcode-client.test.mjs`
- Test: `tests/integration/companion.test.mjs`

- [ ] **Step 1: Write failing config precedence tests**

Persist workspace A with a default and aliases and leave workspace B empty. Assert explicit `--model` beats A's default, A's default beats the ZCode default, aliases resolve only in A, and a runtime-only `ZCODE_MODEL_ALIASES` value is ignored. Assert setup writes only explicit input or `ZCODE_SETUP_DEFAULT_MODEL`/`ZCODE_SETUP_MODEL_ALIASES_JSON`, with private file/directory modes.

- [ ] **Step 2: Write failing applied-response tests**

Have the fake peer return an acknowledgement whose `current` model differs by provider/model/variant and a thought level that differs case-insensitively from no advertised request. Assert each fails before any `session/send`; an exact model tuple and case-insensitive exact advertised thought-level value pass.

- [ ] **Step 3: Verify RED**

```bash
node --test tests/setup.test.mjs tests/args.test.mjs tests/zcode-client.test.mjs tests/integration/companion.test.mjs --test-name-pattern='workspace model|model precedence|applied model|applied thought'
```

- [ ] **Step 4: Implement private workspace configuration**

Store versioned JSON under `<workspace-data>/config/models.json` with schema:

```json
{"version":1,"defaultModel":"alias-or-provider/model","models":{"fast":{"providerId":"p","modelId":"m","variant":"v"}}}
```

Validate exact allowed keys, bounded alias count/string sizes, private modes, atomic writes, and canonical workspace scope. Runtime resolution is explicit request, then persisted default, then no setter so ZCode retains its default.

- [ ] **Step 5: Enforce applied setter results**

Normalize the protocol response's `current` model into the exact requested tuple and reject missing/extra/mismatched values. Resolve effort against advertised levels first, call the setter, and compare returned current value case-insensitively to that advertised ID. Raise stable errors before send.

- [ ] **Step 6: Document setup and verify GREEN**

Document the two setup environment variables, JSON schema, precedence, workspace scope, and a status/setup verification example in both READMEs and the setup Skill.

```bash
node --test tests/setup.test.mjs tests/args.test.mjs tests/zcode-client.test.mjs tests/integration/companion.test.mjs
git add scripts skills/setup README.md README.zh-CN.md tests
git commit -m "feat: persist workspace model configuration"
```

### Task 5: Qualify the complete installed runtime and release contract

**Files:**
- Modify: `tests/e2e/real-zcode.test.mjs`
- Create: `tests/e2e/codex-skills-e2e.test.mjs`
- Modify: `tests/integration/marketplace-install.test.mjs`
- Modify: `tests/release-contracts.test.mjs`
- Modify: `package.json`
- Modify: `README.md`
- Modify: `README.zh-CN.md`

- [ ] **Step 1: Write failing release-contract tests**

Assert package/check scripts include the installed bridge E2E contract, no Skill mentions FD3/FD4/caller secrets, hooks are declared, background launch is production-owned, real ZCode release E2E requires non-empty `ZCODE_REAL_E2E_MODEL`, and the complete companion invocation uses that model.

- [ ] **Step 2: Add the opt-in authenticated Codex Skill E2E**

Following the proven `cc-plugin-codex` pattern, build an isolated marketplace, install the snapshot, launch `codex exec --ephemeral --json` with an explicit `$zcode:` prompt, and verify the installed hook and companion were actually called. Gate it on explicit opt-in/auth/credits and report a structured unqualified reason otherwise. Never replace this with a synthetic FD test.

- [ ] **Step 3: Verify focused E2E behavior**

```bash
node --test tests/release-contracts.test.mjs tests/integration/marketplace-install.test.mjs tests/e2e/codex-skills-e2e.test.mjs tests/e2e/real-zcode.test.mjs
```

Expected locally: installed marketplace/app-server/ordinary-bridge tests pass; authenticated Codex turn and real ZCode tests either pass when explicitly qualified or report their precise unqualified prerequisites. The observed local Codex credit exhaustion is not a pass.

- [ ] **Step 4: Run complete verification**

```bash
npm run check
uv run --with pyyaml python /Users/zhangzikai/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py .
for skill in skills/*; do uv run --with pyyaml python /Users/zhangzikai/.codex/skills/.system/skill-creator/scripts/quick_validate.py "$skill" || exit 1; done
npm audit --omit=dev
git diff --check
```

Expected: all deterministic tests pass, only explicitly unqualified authenticated E2Es skip, validators pass, audit reports zero known production vulnerabilities, and diff check is empty.

- [ ] **Step 5: Commit**

```bash
git add package.json README.md README.zh-CN.md tests
git commit -m "test: qualify the installed Codex ZCode bridge"
```

