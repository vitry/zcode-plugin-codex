# Source-guided Foreground Wait Investigation Plan

> **For the executing agent:** Use `superpowers:executing-plans` inline, task by task. Independent spec and plan review is authorized by the user's latest request; further delegation follows current user authorization. This is a qualification plan: unknown host mechanisms are investigation tasks, not preselected production implementations.

**Goal:** Determine whether configured shell observation and host-executed MCP hooks can meet the original waiting goals while preserving existing Companion authority, results, background and lifecycle behavior.

**Architecture:** Keep the current Companion and its stores authoritative. Build only a small disposable fixture around source-supported host surfaces; compare larger empty shell waits and an owning-runtime MCP hook. Recommend a production delta only after the relevant installed observations and parity requirements pass.

**Tech Stack:** Node.js ESM/node:test, existing MCP SDK dependency and fixture helpers, Codex CLI/app-server where appropriate, read-only Rust source inspection.

**Spec:** [Source-guided qualification design](../specs/2026-09-30-source-guided-foreground-wait-design.md).

---

## Working rules and baseline

- Dedicated worktree: `.worktrees/source-guided-foreground-wait`, branch `docs/source-guided-foreground-wait`.
- Base is refreshed PR #64 head `b908cdab0608d86f51240c436d33a6be4adcb967`; PR #62 is merged. The spec/plan may still be uncommitted when handed off. Preserve them and inspect status before changing branches.
- Current drafting source: `../codex` at `67727e7cf114cf3e1b71db368d74b24e32f6cb12`; installed CLI reports 0.159.2. Do not assert they are the same build.
- No changes to production Skills, hooks, Role templates, Companion behavior, user config, plugin packaging, frozen qualification records, or `../codex` source. Synthetic dependencies can enter existing test seams without rewriting production authority.
- This plan does not ship either adapter. No push, PR, merge, or automatic commit unless the user separately authorizes that action.
- An unknown within-scope mechanism is not a reason to ask the user to design it: inspect source, try the bounded candidate, and record the result. Stop dependent work only; continue independent shell/source tasks.
- No new elaborate evidence framework. A private bounded JSONL trace and a concise report suffice; a parser pass or mock never equals live qualification.

## File responsibilities

| File | Responsibility |
| --- | --- |
| `docs/qualification/source-guided-foreground-wait.md` (new) | Source index, provenance, actual observations, candidate decisions, R1-R8 coverage and handoff. |
| `tools/wait-route-probe/fixture.mjs` (new) | Isolated marketplace/config/hooks/Skills and harmless processes, using actual installed plugin layout. |
| `tools/wait-route-probe/driver.mjs` (new) | Small case runner, host trace collection, time budgets and exact owned cleanup. |
| `tools/wait-route-probe/server.mjs` (new) | Capture/hold tools; synthetic invocation dependencies for a later viable hook candidate. |
| `tests/wait-route-probe.test.mjs` (new) | Instrument correctness, ownership cleanup, stale/duplicate negative controls and shared-seam fixture assertions. |
| `tools/run-test-suite.mjs` (modify) | Explicitly isolate the new research test with the existing four. |
| `tests/test-selection.test.mjs` (modify) | Routine/research selection and missing-entry checks for the added test. |

Keep retained live evidence in the report rather than a second frozen evidence schema. Add another helper file only if a measured case requires a clear separate responsibility. Do not append thousands of cases to the old probe tests.

Production seams to read/reuse, not assume finished MCP implementation files exist:

- `hooks/user-prompt-hook.mjs`, `hooks/subagent-hook.mjs`, `hooks/lib/hook-input.mjs`, `hooks/lib/hook-state.mjs`.
- `scripts/zcode-companion.mjs`: `runDirectInvocation` and `createManagementRescueReconcile`.
- `scripts/lib/identity.mjs`, `scripts/lib/rescue-preparation.mjs`, `scripts/lib/rescue-binding.mjs`, `scripts/lib/rescue-route-planner.mjs`.
- `scripts/lib/rescue-lifecycle.mjs`, `scripts/lib/host-lifecycle.mjs`, `scripts/lib/job-control.mjs`, `scripts/lib/state.mjs`.
- `scripts/lib/direct-invocation-result.mjs`: existing success/error mapping.
- `tests/rescue-preparation.test.mjs`, `tests/rescue-binding.test.mjs`, `tests/mcp-result.test.mjs`, `tests/mcp-lifecycle-controller.test.mjs`.

## Task 1: Pin provenance and narrow the source questions

**Files:** Create `docs/qualification/source-guided-foreground-wait.md`; read the files indexed in spec section 2 and the production seams above.

- [ ] Record baseline state without altering another worktree:

```bash
git status --short
git log -1 --format='%H %s'
git fetch origin
gh pr view 64 --json state,headRefName,headRefOid,baseRefName
codex --version
git -C ../.. status --short
```

The last command checks the parent repository from the dedicated worktree; use its output only for preservation, not cleanup. If PR #64 has merged, retain these docs and choose a new execution base containing its isolation change; do not silently replay its research commits on main.

- [ ] Resolve the source repository separately: from the project root it is `../codex`, not the nested worktree's sibling. Record its full commit, clean/dirty status and any binary/source mapping actually established. Use exact commit-pinned source links; no claim that a current main checkout is the installed binary.
- [ ] Trace configuration from `background_terminal_max_timeout` to the Child process manager and `write_stdin` clamp, including Role overlay and tool description. Determine which actual host surface is in scope; inspect exposed wrapper constraints instead of treating description text as runtime proof.
- [ ] Trace hook loading/trust, local versus executor-scoped dispatch, server readiness, input templates, text/error output, UserPromptSubmit/PreToolUse/PostToolUse ordering, Interrupt and Child abort/stop paths. Read relevant official tests before building a substitute simulator.
- [ ] Record three candidate entry sketches and their first discriminating test: UserPromptSubmit (preparation/order issue), PreToolUse (exact already-prepared invocation), PostToolUse (no duplicate launch). A sketch identifies source of user authority, exact execution owner, wait owner, result route and cancel route; unknowns remain marked unknown.
- [ ] Baseline checks for this research change:

```bash
node --test tests/test-selection.test.mjs tests/mcp-result.test.mjs
node scripts/check-line-endings.mjs
```

Expected: focused tests pass; LF check passes. Record failures before touching probe code. No full source build, full Rust suite or full routine suite is needed just to trace code.

**Exit:** a source/provenance section distinguishing known source behavior from unmeasured host behavior. It must identify concurrent same-event hooks, early UserPromptSubmit, Child Interrupt exclusion, and text-only hook results.

## Task 2: Create the minimum isolated fixture and research test entry

**Files:** Create the three probe files and `tests/wait-route-probe.test.mjs`; modify the test selector and its test only.

- [ ] Read `tools/mcp-context-probe/build-fixture.mjs`, its server/hook helpers, and the direct probe's owned-process cleanup. Reuse suitable helpers without coupling new gate decisions to the old frozen record.
- [ ] Before implementation, add tests for a complete isolated marketplace, fixture-only config, direct Node binary launch, private trace bounds, exact cleanup ownership, and a two-second capture tool. Test server/host error outcomes separately from handler entry. A missing helper/module is an instrument failure, not host rejection.
- [ ] Add the research selection regression before changing the selector. The new test file must exist so discovery can list it. Use the current selection APIs:

```js
const entries = await discoverTestEntries();
assert.equal(selectTestEntries(entries, 'routine').includes('tests/wait-route-probe.test.mjs'), false);
assert.equal(selectTestEntries(entries, 'mcp-research').includes('tests/wait-route-probe.test.mjs'), true);
```

Run `node --test tests/test-selection.test.mjs`; expect the new assertions to fail against the unchanged selector. Add exactly `tests/wait-route-probe.test.mjs` to the explicit research entry list, update the existing exact-list assertion, and rerun. Do not exclude existing production parity or lifecycle tests.
- [ ] Implement the fixture with `process.execPath` for fake hosts/workers, an isolated plugin/data/config/workspace and owned process groups. Use no real ZCode provider tasks. Capture `handler-entered` before inspecting identity, then hold/completion/settlement events. Keep normal result text synthetic and bounded.
- [ ] Give the small driver these case labels: `shell-window`, `hook-entry`, `authority`, `lifecycle`. It accepts an exact Codex binary, an empty private output directory, and a bounded per-case observation budget. It must not silently substitute a second app-server process for the session under test. The case runner can accept further fixture selectors discovered in later tasks; do not freeze guessed host API payloads.
- [ ] Support this concrete case invocation. Resolve and record the actual installed binary; reserve the output directory with mktemp rather than using a user workspace. `--budget-ms` is the probe observation/cleanup bound, never a production job timeout:

```bash
probe_run_dir=$(mktemp -d)
probe_codex_bin=$(command -v codex)
node tools/wait-route-probe/driver.mjs --case hook-entry --codex "$probe_codex_bin" --output-dir "$probe_run_dir" --budget-ms 60000
```

Expected: bounded redacted entry/outcome summary and exact owned cleanup, or an explicit inconclusive result with the missing prerequisite. Independently, after shared instrument tests and the actual-shell smoke below pass, `--case shell-window --budget-ms 600000` supports one 420-second profile per invocation whether or not hook-entry succeeds. `authority` and `lifecycle` require the candidate's own MCP prerequisites and run one selected targeted case per invocation, not an automatic exhaustive campaign.
- [ ] Validate the fixture and isolation:

```bash
node --test tests/test-selection.test.mjs tests/wait-route-probe.test.mjs
node scripts/check-line-endings.mjs
```

Expected: all new instrument/selection tests pass, existing four research entries remain research-only, production tests remain routine, no live host/provider run starts from ordinary tests. Short injected holds must be labeled fixture-only.

- [ ] Run a separate short installed-shell smoke with the harmless fixture command. Record the actual tool outcome and exact owned cleanup; if a running handle is returned, continue only that handle with empty input. This shell smoke does not depend on MCP loading, hook trust, handler entry or hook result delivery.

**Exit:** shared fixture/trace/cleanup tests pass and the short actual-shell smoke reports an honest outcome and exact cleanup, enabling Task 3 independently. An inconclusive or failed MCP smoke does not block shell measurements. MCP long holds in Task 4 require their own successful two-second installed MCP entry/completion/cleanup smoke. Keep this one small runnable fixture, not a general evidence framework.

## Task 3: Measure configured shell windows independently

**Files:** Probe fixture/driver and research test; append actual evidence to the report.

- [ ] Write fixture tests for a harmless command with a fixed completion marker, optional noisy output, graceful signal handling and exact process identity. Verify noisy output cannot be mistaken for terminal output and no second invocation is launched.
- [ ] Use the actual installed shell tool with these synthetic profiles:

| Profile | Configuration and requested wait | Observation |
| --- | --- | --- |
| Baseline | Default cap; initial exec 30000, subsequent empty yield 60000 | Tool/model-call cadence over a 130-second task. |
| Long request | Default cap; subsequent empty yield 180000 | Whether the original task completes inside one observation after initial exec. |
| Increased cap | Fixture cap 3600000; empty yield 3600000 | On a 420-second task, distinguish a default-cap return near 300 seconds from terminal completion in one configured poll. |

Run the 420-second profile once with default configuration as the cap control, and once with the increased cap. Confirm at least 330000 ms of process lifetime remains when the first empty poll begins; otherwise the sample is inconclusive because it cannot distinguish the cap from early process completion. Durations are diagnostic, not new operation timeouts. Collect the actual host tool return, not just worker elapsed time. Node-only simulation cannot pass this task.
- [ ] Test the larger window in Root and the actual managed Rescue Child surface. Trace effective Child config and explicit yield; do not assume Root settings propagate. If the actual managed Role cannot be changed within a disposable fixture, record that integration as not-proven and test a clearly labeled synthetic Role control.
- [ ] On the viable surface, interrupt a held command and verify existing bounded interruption/result behavior; repeat with noisy output. Distinguish outer orchestration yields from completed inner observations. No parallel second poll while the first is pending.
- [ ] Count model decisions during each tool hold and re-entry between holds. Report observed counts, not promised token savings or a guessed per-call cost. Repeat the decisive configured result once on a fresh fixture; investigate one inconsistent result by cause rather than increasing random run counts.
- [ ] Write a deployment recommendation only for demonstrated surfaces: fixture/user-config/Role changes needed, any wrapper cap, and the required Skill yield policy. Do not apply it to user configuration or shipped Skills yet.

**Exit:** source-confirmed capability plus measured supported scope, or a precise wrapper/config/model limitation. This task continues even if every hook candidate fails. It does not qualify MCP by substitution.

## Task 4: Prove installed hook dispatch, readiness and sequencing

**Files:** Probe fixture/server/driver, research test and report. Production hooks remain unchanged.

- [ ] Start with a disposable local UserPromptSubmit `mcp_tool` hook and a model-hidden two-second capture tool, using fixture-local hooks feature/trust settings. Do not put a real invocation in this early hook. Record hook discovery, ready server, exact owning session, handler entry and output receipt.
- [ ] Add disabled/untrusted-hook and unavailable-server controls. Expected: no accepted synthetic work and a classified load/dispatch/rejection outcome. Do not add arbitrary sleep as the production readiness strategy.
- [ ] Demonstrate the concurrent same-event ordering risk against a delayed synthetic authority publisher. A declaration-order change is not a fix. Assess each candidate from Task 1 with the actual event boundaries; reject any that require authorizing work before the real preparation exists.
- [ ] Select at most one viable candidate for a 130-second awaited hold. Local versus executor-scoped behavior must be observed, not inferred from the `mcp_tool` handler label. Record zero model decisions during the pending hold, one dispatch and exact output destination. The MCP tool itself must not depend on model tool selection.
- [ ] Characterize server tool timeout versus hook timeout and record the effective bound; the shorter bound controls waiting. A two-second success does not prove long-duration settings. Do not promote a user-config control to plugin-packaged timeout qualification.
- [ ] Repeat the decisive entry/order result once. If no candidate remains, record the exact missing mechanism, skip dependent MCP Tasks 5-6 and complete Task 7; do not request an external host/fork silently.

**Exit:** a supported owning-session entry candidate with explicit authority/result/cancel questions still open, or a bounded rejection. Handler reachability alone is not a production recommendation.

## Task 5: Join exact authority and preserve result/control outcomes

**Files:** Research test/fixture/server and report; read/reuse real stores and formatter.

- [ ] Before wiring the candidate, write negative tests using real identity/preparation/binding stores: missing issuer, mismatched thread/session join, stale issuing turn, wrong Child, concurrent Child, duplicate preparation consume, cross-workspace/worktree, changed permissions and wrong foregroundAdapter. Assertions include no consumption, no job reservation and no synthetic execution on rejection.
- [ ] Add one bounded non-hook impersonation control on the disposable candidate: deliver otherwise matching identity/event arguments, but no independently established per-invocation authority, through a distinct non-hook ingress, such as direct `mcpServer/tool/call` where the same owning fixture connection supports it. Do not consume the preparation first and count duplicate rejection as proof; the test must start with an otherwise eligible unconsumed preparation and reach the candidate's real admission boundary. Matching threadId/turn_id, caller-supplied metadata, hidden-tool discovery policy or a diagnostic nonce alone must not establish hook provenance. Require rejection before consumption, reservation or synthetic execution; a separately supported exact authorization mechanism can authorize another ingress, but matching fields alone cannot. Investigate a supported channel discriminator or equivalent existing exact invocation authority rather than prescribe a guessed token/API. If the candidate cannot establish provenance or equivalent exact authority, or the replay cannot be delivered to the same candidate so only a parser mock was tested, mark that authority requirement not-proven and do not qualify the candidate.
- [ ] Construct a schema-valid private Rescue preparation with the existing store and execute the candidate through the actual locked consumption seam. Host-issued event identity and model-authored tool_input must stay separately identified; only the proven hook channel can supply its attested context. Never populate an ambient env variable from arbitrary tool arguments and call that host authority.
- [ ] Test fresh spawn and same-child reactivation/continuation, including needs-choice and the existing pending-fresh parent-replan branch. Preserve Root semantic selection, Role preflight, immutable launcher descriptor and exact returned Child path. Keep private task content out of process argv, hook output, agent messages and retained logs.
- [ ] Compare every result category through `formatDirectInvocationSuccess`/`formatDirectInvocationError` and the actual hook delivery path: terminal success, ordinary PluginError, interrupted invocation, needs-choice, parent-replan, queued acknowledgement and status of a running job. Verify exact public text and outcome/error handling. An inserted additionalContext summary does not pass.
- [ ] Record a supported result route if one exists. Do not prescribe a receipt/no-op launcher, updatedInput substitution or another tool call solely to obtain a success-shaped trace. If lossless delivery/control continuity cannot be demonstrated, mark the candidate unqualified without changing the original goal.
- [ ] Exercise all four Rescue placement branches and Review/adversarial-review background with harmless dependencies. Explicit Rescue --background must retain attached Child execution; complex no-flag must retain the existing detached runner. Status --wait targets only the owned requested job and workspace partition.
- [ ] Run focused parity tests after fixture changes:

```bash
node --test tests/wait-route-probe.test.mjs tests/rescue-preparation.test.mjs tests/rescue-binding.test.mjs tests/mcp-result.test.mjs
```

Expected: fixture and existing focused tests pass. These tests prove shared-seam parity, not installed hook integration; the report must also cite live event/output evidence.

**Exit:** exact one-shot admission and lossless installed terminal/control delivery, or a clearly recorded authority/presentation limitation. Do not weaken atomic checks or invent a new binding format.

## Task 6: Characterize cancellation and durable settlement

**Files:** Probe/test/report only; reuse existing lifecycle, job controller, stop-intent and reconciliation seams.

- [ ] Only trigger cancellation after independently persisted handler hold and synthetic worker acceptance. An unentered handler or absent active turn is not a cancellation result. The held invocation has exact operation/executor ownership; keep an unrelated sentinel alive.
- [ ] Test these cases with real shared lifecycle code and small live fixtures:

| Case | Required observation |
| --- | --- |
| Root explicit interrupt | Exact stop intent/accepted policy and worker/job settlement, not only turn interrupted. |
| Rescue Child interrupt with Root awaiting | Characterize actual Child abort/stop events; root Interrupt absence cannot count as delivery. |
| Child interrupt after Root returned for Host background | Preserve Child ownership and exact cancellation without needing an active initiating Root turn. |
| Later same-child continuation and concurrent Child | Old authorization cannot stop the later or unrelated operation. |
| Status --wait interrupt | Observer settles; underlying target job and unrelated worker survive. |
| Host abrupt loss, surviving-host connection loss and graceful stop | Separate process loss from transport loss; prove eventual exact durable settlement or record the gap. |
| Hook/server configured timeout | Local error is not worker settlement; verify explicit supervisor/deadline strategy. |
| Completion versus cancel race | One authoritative public terminal election and no false success. |
| 100-hour ceiling | Short injected clock enters the actual production lifecycle branch; no 100-hour real sleep or new six-hour cap. |

- [ ] Investigate Interrupt as a bounded stop-intent writer only. Verify trust/loading, root-only scope, three-second budget and durable acknowledgement before relying on it. Evaluate existing SubagentStop/reconciliation as a distinct Child route; do not assume SubagentStop fires on interruption because it fires on normal completion.
- [ ] Observe worker exit, tracked state, lease/guard release and result election separately from host/tool settlement. Test timeout/loss during preparation, after consumption, after acceptance and before final delivery with a small number of shared-seam negative controls.
- [ ] Reuse production cancellation semantics for read-only Review/adversarial-review and observational Status; do not apply writable Rescue stop policy to every command.
- [ ] Run `node --test tests/wait-route-probe.test.mjs tests/mcp-lifecycle-controller.test.mjs`; record focused results plus live evidence. Repeat only the decisive installed lifecycle result with a fresh fixture and unrelated sentinel.

**Exit:** all required lifecycle branches demonstrated for the candidate, or precise not-proven/rejected branches. A remaining Child cancellation gap blocks that MCP recommendation, not the independent shell finding.

## Task 7: Report, inline self-review and execution handoff

**Files:** Complete `docs/qualification/source-guided-foreground-wait.md`; update checkboxes in this plan with actual evidence references. Use inline self-checks and any independent review authorized by the user.

- [ ] Build a compact comparison for configured shell, host-executed MCP hook and retained direct-RPC route. For each R1-R8 requirement name the source fact, fixture assertion, installed observation and remaining gap; label untested branches not-proven. Link existing baseline tests instead of recreating them.
- [ ] Self-check privacy, exact authority, same-event ordering, Child lifecycle, background distinction, lossless control results and whether the recommendation follows observed scope. Do not revise frozen old records or claim a structural validator performs live qualification.
- [ ] Verify probe tests remain research-only and production tests remain routine. Run:

```bash
node --test tests/test-selection.test.mjs tests/wait-route-probe.test.mjs
npm run test:mcp-research
node scripts/check-line-endings.mjs
npm run lint
npm run typecheck
git diff --check
git status --short
```

Expected: research suite explicitly includes the new probe, skips are labeled and are not qualification; static checks pass. Live opt-in measurements are recorded separately. For a final research-code PR, also run `npm test` once on the final code revision and report any unrelated baseline failure instead of fixing it silently.
- [ ] Recommend the smallest subsequent action: configured-shell production delta, focused qualified MCP-hook adapter design, or no viable hook with the exact missing host capability. Preserve original release gates and human canonical-switch decision. No production work is implicitly unlocked by this plan.
- [ ] Provide a handoff containing worktree, branch/base, exact completed cases, commands, report/spec/plan paths, remaining not-proven requirements and any needed new authority. Do not push/create a PR until requested; if PR #64 remains open, identify this as stacked work or rebase onto its merged main before a separate PR.

**Exit:** complete evidence-backed investigation, not necessarily a qualified MCP route. Human review can then decide production scope without relaying undocumented implementation questions between agents.

## Requirement coverage and pause rules

| Requirement | Tasks |
| --- | --- |
| R1 shared Companion/module boundary | 1, 2, 5, 6 |
| R2 exact Root/Child/preparation/choice workflow | 1, 4, 5 |
| R3 invocation authority, workspace and permissions | 1, 4, 5, 6 |
| R4 four placements, background and observation-only Status | 3, 5, 6 |
| R5 exact shell handle and one pending MCP hold | 3, 4, 5 |
| R6 public text, control outcomes and terminal election | 3, 5, 6 |
| R7 interrupt/loss/timeout/100-hour settlement | 3, 6 |
| R8 explicit-only evaluation, background reuse, no promotion | 5, 7 |

Missing source/binary mapping does not block source research; it limits what can be claimed. An unavailable hook entry skips its dependent integration work, not the shell task. A production scope expansion, real-provider/user-project mutation, weakening of any R1-R8 outcome, or new external-host architecture requires user direction. Ordinary instrument mistakes and within-scope unknowns should be diagnosed here, not turned into mandatory user design questions.

## Document review record (2026-10-01)

Two independent read-only subagents reviewed the actual spec and plan files: `source_wait_spec_review` and `source_wait_plan_review`. Initial spec review found no P1/P2 and one P3 stale review prohibition, now removed. Plan review found two P2 issues: the generic smoke prerequisite could block independent shell measurements on MCP failure, and exact-identity negatives omitted non-hook ingress impersonation.

Both corrections were applied to the spec and plan. Focused independent re-review confirmed both P2 issues resolved, no new P1/P2 introduced, and R1-R8 and the production release boundary intact. Verdict: ready for investigation within the stated scope. This is document review, not installed-host qualification or production approval. No live experiment, production change, commit or push was performed during review.
