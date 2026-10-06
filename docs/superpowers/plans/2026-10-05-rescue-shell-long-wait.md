# Managed Rescue Native Shell Long-Wait Qualification Plan

> **For agentic workers:** Use `superpowers:executing-plans` to execute this plan inline, task by task. Use `superpowers:subagent-driven-development` only if delegation is separately authorized. Steps use checkbox syntax. This is qualification-artifact development, not authorization to ship a production policy. The user has authorized independent spec/plan review for this planning session.

**Goal:** Qualify longer native shell observations on the actual managed Rescue Child and Root-owned waiting commands while preserving the complete existing functional contract.

**Architecture:** Keep production Companion, hooks, preparation, binding, results and lifecycle authoritative. Use an isolated installed-plugin fixture with a harmless fake ZCode dependency, temporary cap/instruction variants, and a small shell-only case runner. Trace host configuration first; measure real Child ownership, outer/inner observations, result delivery and cancellation without reopening MCP or building a general rollout parser.

**Tech Stack:** Node.js ESM/node:test, existing installed-plugin/fake-ZCode/process helpers, installed Codex CLI/native host interaction, read-only Rust source inspection.

**Spec:** [Native shell long-wait design](../specs/2026-10-05-rescue-shell-long-wait-design.md).

---

## Execution boundary

- Worktree `.worktrees/rescue-shell-long-wait`, branch `docs/rescue-shell-long-wait`, base `6638878e910154d7d1bc4effd4c9aa62f149f23a` (merged PR #65). Inspect current status and remote before execution; preserve these uncommitted documents and progress files. Do not reset, clean, amend earlier branches, or change branches automatically.
- Execute research/fixture tasks only. Do not edit canonical Skills, Role template, Companion stores, hooks, installed user caches/configuration, packaging snapshot or Codex source. Temporary isolated installed variants are allowed. A separate human adoption decision precedes any production implementation plan.
- No automatic commit, push, PR or merge is authorized. Neither a successful case nor a clean-tree test requirement grants that authority.
- Unknown host configuration, wrapper or interruption mechanisms are investigation tasks, not preselected mandatory APIs. Investigate source and one bounded cause-directed follow-up before recording an exact not-proven reason. Continue independent tasks; do not ask the user to design an unknown mechanism.
- Authenticated Codex trials must be explicit opt-in and confined to disposable workspaces with fake ZCode. They can consume Codex credits, but must never launch real ZCode provider work or edit user projects. Missing authentication, unavailable supported host interaction or materially broader authority is a recorded prerequisite.
- Existing baseline: spec §2 records the previous full routine run and the explained dirty-tree snapshot failure plus passing three-test clean-tree recheck. Do not repeat the 12-minute suite merely to begin research. Recheck changed modules proportionately; reserve full routine checks for final implementation verification.

## File responsibilities

| File | Action and responsibility |
| --- | --- |
| `docs/qualification/rescue-shell-long-wait.md` | Create: provenance, source/Child path trace, bounded case records, S1–S7/Q1–Q6 coverage, exact limitations and proposed next delta. |
| `tools/shell-wait-probe/fixture.mjs` | Create: clean-source isolated install, private homes/workspace, fake-ZCode completion gate, temporary cap and instruction variants; owned cleanup. |
| `tools/shell-wait-probe/evidence.mjs` | Create: small structural call/return linkage and sanitized decisive excerpts; supported observed shapes only, manual adjudication for unknown scripts. |
| `tools/shell-wait-probe/driver.mjs` | Create: opt-in closed case CLI, exact installed executable, bounded host/gate lifecycle, case summaries; import has no launch side effects. |
| `tests/shell-wait-probe.test.mjs` | Create: fast fake-host/fixture/instrument regressions, no authenticated trials in this file. |
| `tools/run-test-suite.mjs`, `tests/test-selection.test.mjs`, `package.json` | Modify: a distinct `shell-research` selector/script; preserve all five MCP research entries and every existing production test. |

Read/reuse seams: `tests/e2e/codex-skills-e2e.test.mjs` (isolated installed setup, hook capture and held completion), `tests/fixtures/fake-zcode-cli.mjs`, `tests/helpers/rescue-skill-contract.mjs`, `tests/helpers/installed-rescue-lifecycle-contract.mjs`, `scripts/lib/managed-agent-role.mjs`, `scripts/lib/tool-launch.mjs`, `scripts/lib/process.mjs`, `scripts/build-marketplace-snapshot.mjs`, production preparation/binding/lifecycle modules. Copy only necessary research orchestration into the small fixture; do not import a test entry and trigger its test registrations.

Do not import the old `tools/wait-route-probe/driver.mjs` summarizer/verdict machinery or append new campaigns to `tests/wait-route-probe.test.mjs`. Existing cleanup mechanisms can be read/reused if they do not initialize MCP or pull in unrelated mutable case state. A helper extraction or another file is allowed only when a concrete seam requires it; record the responsibility rather than inventing a framework.

## Task 1: Pin provenance and resolve the actual Child/config/control path

**Files:** Create the report; read the spec's source index and the listed production seams.

- [x] Record current base, worktree status and actual executable without modifying any other checkout:

```bash
git status --short
git log -1 --format='%H %s'
git fetch origin
command -v codex
codex --version
git -C ../../../codex status --short
git -C ../../../codex rev-parse HEAD
node --test tests/test-selection.test.mjs
```

Expected: selection tests pass; source/installed provenance are recorded separately. `scripts/lib/tool-launch.mjs` defaults to the package's pinned 0.147.0 Codex unless `CODEX_BINARY` is supplied. Every live case must explicitly use the recorded installed executable; a dependency version is not the current host.

- [x] Trace actual native spawn → Child config derivation → Role overlay → session process manager → empty-poll clamp. Start with `agent/child_config.rs`, `agent/role.rs`, `session/session.rs`, `config/mod.rs`, `unified_exec/process_manager.rs`. Read relevant source tests; cite exact commit/path. Discover renamed files. Do not rebuild Codex or claim binary equivalence from its checkout.
- [x] Trace current `skills/rescue/SKILL.md`, rendered managed Role, `hooks/subagent-hook.mjs`, preparation/binding and native follow-up route. Distinguish named and schema-supported generic paths, fresh/choice/prepared continuation, Root `wait_agent`, private preparation TTY writes and Child empty observations.
- [x] Identify an available native interaction capable of interrupting the exact pending Child turn, and separately the Root Status observation. Establish ownership and target from the same host session. `turn/interrupt` is useful only on a verified connection owning that live target; a separate diagnostic app-server is not the running CLI session. Root SIGINT or probe-budget expiry alone is not exact Child interruption.
- [x] Document existing harness limitations: the old E2E qualifier pins supported Codex lines, old v4 prepared expectations and 60000-ms observation policy. Do not edit/relax that canonical oracle; use current v5 production preparation and a separate research observer. Reuse real stores and launchers, not manually manufactured authority records.
- [x] Record a narrow source-backed hypothesis, effective unraised/default configuration cap if observable, and the first discriminating live trial. This reference cap is not the deliberately raised cap in Task 4's instruction comparison. Cap placement remains open: test fixture session/user configuration first; do not put the cap in the managed Role file merely because the awaiter asset contains it.

**Exit:** Q1 source/control-path findings, with unverified installed steps named explicitly. Lack of an interrupt interaction stops interrupt qualification only, not shell timing or Root-command work.

## Task 2: Isolate shell research tests without changing MCP or functional coverage

**Files:** Create `tests/shell-wait-probe.test.mjs`; modify selector, selection test and package script.

- [x] Add a selection regression to `tests/test-selection.test.mjs` that initially fails because `shell-research` is unknown:

```js
test('shell qualification is separate from routine and unchanged MCP research', async () => {
  const entries = await discoverTestEntries();
  const shell = selectTestEntries(entries, 'shell-research');
  const mcp = selectTestEntries(entries, 'mcp-research');
  const routine = selectTestEntries(entries, 'routine');
  assert.deepEqual(shell, ['tests/shell-wait-probe.test.mjs']);
  assert.deepEqual(mcp, researchEntries); // existing five-entry MCP list
  assert.deepEqual(routine, entries.filter((entry) => !shell.includes(entry) && !mcp.includes(entry)));
  assert.equal(new Set([...routine, ...mcp, ...shell]).size, entries.length);
  for (const entry of ['tests/mcp-result.test.mjs', 'tests/mcp-lifecycle-controller.test.mjs', 'tests/plugin-contracts.test.mjs']) {
    assert.ok(routine.includes(entry));
  }
});
```

- [x] Add the shell research test file with one fast import/shape test, not a live runner. Run `node --test tests/test-selection.test.mjs` and observe the intended RED selection failure before implementing the selector.
- [x] Preserve the current five-entry `researchEntries`. Add the distinct list and update only selection/CLI messaging:

```js
const shellResearchEntries = Object.freeze(['tests/shell-wait-probe.test.mjs']);
const shellResearchSet = new Set(shellResearchEntries);
```

Keep validation of duplicate/invalid input and missing MCP entries; also reject a missing shell entry. The selector's final filter is:

```js
return entries.filter((entry) => suite === 'routine'
  ? !researchSet.has(entry) && !shellResearchSet.has(entry)
  : suite === 'mcp-research' ? researchSet.has(entry) : shellResearchSet.has(entry)).sort();
```

Recognize exactly `routine`, `mcp-research`, `shell-research`; keep `Unknown test suite` failure for others. Update the existing routine test's expected union instead of weakening it. Include missing-shell and cross-suite duplicate/disjoint assertions.
- [x] Add only this script; do not change `test`, `check` or `test:mcp-research`:

```json
"test:shell-research": "node tools/run-test-suite.mjs shell-research"
```

- [x] Run `node --test tests/test-selection.test.mjs` and `npm run test:shell-research`. Expected: green, no credentials or host launches, same five MCP entries and all existing functional entries preserved. No commits unless separately authorized.

**Exit:** the new research instrument is explicitly selectable and excluded from routine tests without relabelling MCP research.

## Task 3: Build the minimum production-path fixture and bounded observer

**Files:** Three new shell probe modules and `tests/shell-wait-probe.test.mjs`; report fixture section.

- [x] Write failing fast tests for these public research interfaces before implementing them:

```js
// fixture.mjs
// createShellWaitFixture({ sourceRoot, sourceSha, codexBinary, output, variant, capMs })
// -> { workspace, codexHome, installedRoot, env, dispose }
// driver.mjs
// parseShellWaitArguments(argv) -> validated closed case input
// runShellWaitCase(input, dependencies?) -> bounded redacted case record
// evidence.mjs
// inspectShellWaitEvidence(input) -> supported facts or an explicit inconclusive reason
```

`variant` is `baseline` or `candidate`. Exact internal host APIs are deliberately not prescribed before Task 1. These interfaces are fixture orchestration, not a new product protocol or binding authority.

- [x] Minimum regression cases: no live work without `ZCODE_SHELL_WAIT_E2E=1`; importing modules launches nothing; exact absolute executable; output must be a private real empty directory; user config/cache unchanged; candidate changes only cap and waiting paragraph in temporary installed artifacts; incomplete/wrong Child linkage cannot qualify Rescue; unknown/truncated call shape produces inconclusive; cap return/live cell cannot qualify completion; duplicate launch or overlapping inner poll fails; stale PID identity is never signalled; budget cleanup is not labelled native interruption; copied credentials are removed even when preserving redacted evidence.
- [x] Build the marketplace from a temporary **clean detached source worktree** at `sourceSha`, owned by the fixture. Install dependencies there only if the builder requires them. The caller's uncommitted docs/progress files must not enter or invalidate the snapshot. Reuse `buildMarketplaceSnapshot`, install via the exact chosen binary into isolated `CODEX_HOME`, then apply the recorded candidate cap/wait paragraph to the isolated install before running isolated setup. Remove only the exact owned detached registration during cleanup; never commit just to obtain a clean tree.
- [x] Use production setup/preflight, prompt/SubagentStart hooks, private v5 preparation, prescribed one-hop native spawn/follow-up and original `invoke-prepared rescue` launcher. Only fake ZCode supplies harmless delayed outcomes. Reuse `FAKE_ZCODE_COMPLETION_GATE`, `FAKE_ZCODE_COMPLETION_GATE_REACHED`, `FAKE_ZCODE_PROCESS_FILE` and `FAKE_ZCODE_PROCESS_NONCE`, a fixed harmless public sentinel, and existing direct-Node process identity/cleanup discipline. A bare delay command may diagnose shell mechanics but cannot qualify Rescue.
- [x] Candidate instructions change only the waiting policy in temporary named Role and generic assignment, preserving the exact initial/choice assignment literals, fixed command, authority and terminal rules. Capture rendered/delivered instruction hashes and narrowly redacted differences; do not merely assert repository text matches the running Role. Record sandbox, hooks trust/bypass, source artifact and actual permissions. A fixture trust bypass is not persisted production-trust qualification.
- [x] Implement a bounded observer for actual observed call shapes: direct function calls, simple script wrapper calls and linked outer continuation. Use native JSON records and actual tool-reported wall times where available; for unsupported script shape, retain a sanitized decisive excerpt and manually adjudicate only that case. Do not infer invocation from quoted text. Missing or ambiguous records are inconclusive, never a zero decision count.
- [x] Keep a small case record: CLI/source/plugin provenance; requested/actual route and instruction/config variant; exact Child linkage checked; one Companion launch/send checked; original handle linkage checked; outer-return/model-call counts separated from Root joins; decisive wall time and remaining lifetime; original process exit and exact public result checked; native interrupt delivery and settlement or its missing prerequisite; cleanup result. Use null for unknown facts, not false or zero. Retain at most 64 decisive excerpts, each bounded and scrubbed, with truncation explicitly recorded; no large frozen proof schema.
- [x] Only after observation completion/settlement, retain the redacted evidence outside credential homes, then clean homes and exact owned processes. A fixture gate timer must still bound work if the model never calls a tool or exits early. Gate release at the experiment deadline is test control, not a production timeout.
- [x] Implement these closed CLI cases: `rescue-baseline`, `rescue-long`, `rescue-repeat`, `rescue-noise`, `rescue-interrupt`, `review-wait`, `adversarial-review-wait`, `status-wait`, `background`. Shared arguments: `--codex`, `--source-sha`, `--output`, `--worker-duration-ms`, `--cap-ms`, `--poll-ms`, `--budget-ms`. Baseline preserves 30000/60000 plain observation; other foreground cases request the candidate outer/inner policy. Reject unknown cases/options. Background is a short compatibility case, not a second execution adapter.
- [x] Run `npm run test:shell-research`, `node --test tests/test-selection.test.mjs`, `npm run lint`, `npm run typecheck`. Expected: instrument correctness green; these are not live qualification. Record any failing instrument as instrument failure, not host rejection.

**Exit:** disposable actual-product-path fixture plus tested owned cleanup and honest observation; no MCP server or changes to canonical policy/oracles.

## Task 4: Measure the real managed Child, not a synthetic substitute

**Files:** Report Child/config/wait sections; only bounded fixture fixes in new probe files if evidence identifies them.

- [x] Resolve the actual installed executable once, set `CODEX_BINARY` to that absolute path, and record its real version. Do not use `node_modules/@openai/codex` accidentally. Each output is a newly created private OS-temporary directory; raw path values must not enter public results.
- [x] Run one **cap-matched current-instruction control** and one candidate with the same cap/profile/permissions to isolate the instruction policy. The case label `rescue-baseline` below means that instruction control, not a completely unmodified production-runtime baseline: both cases raise the fixture cap. Record the current unraised/default cap separately and do not infer configuration causality from this A/B comparison alone. The example uses the prior one-hour cap and a 420-second worker; adapt duration only if Task 1/current observations establish a different effective default cap:

```bash
shell_codex_binary=$(readlink -f "$(command -v codex)")
shell_source_sha=$(git rev-parse HEAD)
shell_case_output=$(mktemp -d)
ZCODE_SHELL_WAIT_E2E=1 CODEX_BINARY="$shell_codex_binary" node tools/shell-wait-probe/driver.mjs \
  --case rescue-baseline --codex "$shell_codex_binary" --source-sha "$shell_source_sha" \
  --output "$shell_case_output" --worker-duration-ms 420000 --cap-ms 3600000 --poll-ms 60000 --budget-ms 720000
```

Task 4 execution: Case A and B used `--budget-ms 1200000` (the commands above are design examples).
Both used the regular installed `0.160.1` executable after the pipeline auto-update from `0.160.0`;
Case A/B source pin is `7edb8adb1781404301f0a29bcc3bd7de6ab45972`.
See report [§1 and §7](../../qualification/rescue-shell-long-wait.md) for the actual records,
earlier Case 0 pins, exact call excerpts and evidence labels. The comparative A/B execution is complete;
the separately recorded unraised cap remains `not-proven`.

Expected baseline is an observation, not an assumed 31-second return. Record what this actual Child did; cap configuration alone is not improvement proof.

```bash
shell_case_output=$(mktemp -d)
ZCODE_SHELL_WAIT_E2E=1 CODEX_BINARY="$shell_codex_binary" node tools/shell-wait-probe/driver.mjs \
  --case rescue-long --codex "$shell_codex_binary" --source-sha "$shell_source_sha" \
  --output "$shell_case_output" --worker-duration-ms 420000 --cap-ms 3600000 --poll-ms 3600000 --budget-ms 720000
```

- [ ] Verify actual native Child parent/thread/path linkage and production preparation/binding admission; one Companion launch and one fake session/send; exact original process handle; actual directive/inner yield; terminal exit and byte-for-byte sentinel; no routine progress relay to Root. The cap-discrimination poll must begin with at least measured unraised/default configuration cap + 30000 ms remaining. A short run, gate released too soon or slow model leaving too little lifetime is inconclusive for that claim; an unestablished default cap must not be guessed from an unmatched source snapshot.

**Still open (verification/discriminator):** Case B qualifies named-route linkage, one launch/send, original
handle, terminal exit and byte-exact sentinel. Case A completion linkage is an instrument limitation; M and
the M + 30000 poll-start condition are not established. Routine progress-relay absence is not established
by retained call excerpts. This complete verification box remains unchecked.

- [ ] Run `rescue-repeat` once with the same candidate flags and a fresh output. Do not retry model nonadherence out of the record. Compare outer re-entry counts over comparable remaining work intervals; separately report Root native child joins. One long held observation has no intervening model return; whole-operation decisions need not be zero. Do not claim token savings without actual token measurements.

**Still open (repeat):** Both attempts are retained: repeat1 failed instrument natural-exit verification
(cleanup complete), repeat2 was model nonadherence/unsupported inline preparation and was not retried.
No comparable qualified repeat or interval comparison was obtained; this deliverable remains unchecked.

- [x] Record named versus generic route as actually selected by the host. If only one route is reachable, retain the other as unavailable/not-proven with structural parity checks. Never force a generic fallback after a recognized Role-value rejection. A positive conclusion is scoped to the observed route; claiming both requires actual evidence for both.
- [x] If the Child cap is ineffective or instructions are not followed, inspect the one concrete configuration/delivery cause established by the trace and perform at most one cause-directed follow-up per failed/inconclusive case. No second engine, generic interpreter, synthetic authority or mutable latest-state lookup. Record Root timing separately; do not relaunch old MCP cases.

**Recorded completion:** Named selected for Cases A/B and Case 0 run3; generic remains installed
`not-proven`, with `fixture-tested` artifact parity (§12), no forced fallback. Case 0 follow-ups addressed
distinct established grammar/terminal-rule causes in `9b2bbcd`, `cede2d8`, `7edb8ad`; all four outcomes
remain in the record. No host-behavior outcome or repeat2 nonadherence was retried out of the record.

**Amendment gates:** selection 6/6, lint/typecheck/diff-check exit 0. The requested one shell-research
run: 173 tests, 169 pass, 4 fail, 0 skipped; all four are sandbox artifacts (two npm-cache `open EPERM`,
two macOS process-inspection `spawn EPERM`), not host-behavior rejection. Report §7.6 records the details.

**Exit (partial):** Q1 configuration propagation and M are `not-proven`; Q2 named candidate behavior is
`installed-observed`; Q3 cadence is `installed-observed` (A 15 outer returns vs B 0), repeat `not-proven`.
Report §7.5 fills the Task 4-owned S1/S2/S3 partial and Q1/Q2/Q3 coverage rows; full Task 7 coverage and
Task 5/6 work remain open. Child completion proves only the current invocation, not automatic production release.

## Task 5: Preserve lifecycle, results, placement and Status sidecar semantics

**Files:** Report lifecycle/result/placement sections; new shell instrument regressions if an observed seam needs correction.

- [ ] **OPEN — run once, model nonadherence → inconclusive (§8.2).** Run `rescue-noise` with a 130-second harmless hold and candidate observations (`--worker-duration-ms 130000 --cap-ms 3600000 --poll-ms 3600000 --budget-ms 360000`). Use existing conversation/progress output, not a new heartbeat protocol. Check same handle, no replacement Status loop, no ordinary progress relay to Root, and terminal stdout exactly preserved.
- [ ] **OPEN — run once; the pending observation qualified but the driver never delivered a native interrupt (§8.1).** Run `rescue-interrupt` while a long observation is demonstrably pending. The driver uses the native exact-Child interaction identified in Task 1; it must record actual delivery, target, pending interval and settlement. A timer intent without delivery, host early exit, gate completion before the signal or killing the outer probe is inconclusive, not successful interruption. Measure delivery-to-settlement latency and compare with the matched baseline/native expectations; no hidden waiting until the new one-hour cap may be presented as preserved responsiveness.
- [ ] **OPEN — not exercised live in this campaign; inherited production suites recorded (§8.5).** Check existing stop intent, reconciliation, durable winner and no accepted running work left untracked. Keep an unrelated harmless job/Child control live and verify it survives. Host loss and probe-budget cleanup are separately labelled; do not use either as native user-interrupt proof. If no exact native interrupt surface is reachable, document the prerequisite and leave that release dimension not-proven without blocking Root wait measurements.
- [x] **DONE (structural; live steering not reachable this campaign, §8.4).** Preserve exact no-argument Child Status intents: `zcode status`, `$zcode:status`, `/zcode:status`, trimmed only. The sidecar runs at most once per accepted intent, **between polls**, and never authorizes another Rescue execution or replaces terminal stdout. Test the policy structurally; if the native interface permits safe live steering, observe its response opportunity under a long wait. Report delay as a usability limitation, never issue a parallel inner poll to improve responsiveness. Ordinary steering must not become a command.
- [ ] **OPEN — run once, host ended before the boundary with zero launches (§8.3).** Run one short `background` compatibility case using explicit Rescue `--background`: Root sends only the existing launched-Child acknowledgement and does not join; the exact Child still observes attached Companion to terminal with the candidate policy. Use current functional tests for small no-flag and complex detached placement, Review/Adversarial enqueue-only, same-child choices and owner-only queries. Do not run every unchanged product contract live merely because it is a release requirement; distinguish inherited contract regression coverage from new installed evidence.
- [x] **DONE (§8.5: 417/417, 126/126, 213/213 at `074fb07`).** Run focused production regressions without changing their expected text/authority:

```bash
node --test tests/rescue-preparation.test.mjs tests/rescue-binding.test.mjs tests/rescue-route-planner.test.mjs
node --test tests/rescue-lifecycle.test.mjs tests/rescue-child-reconciliation.test.mjs tests/rescue-progress-relay.test.mjs
node --test tests/job-control.test.mjs tests/mcp-result.test.mjs
```

Check exact file presence first (`rg --files tests`); if a seam was renamed, name its actual equivalent in the report. Run only relevant existing controlled timeout/safety-ceiling tests; production 100-hour semantics must not be replaced with the probe budget. A fake timer in a new probe is not production ceiling proof. No literal 100-hour experiment is required.

**Exit:** S1–S6 coverage and Q4, separately scoped for actual installed cancellation, controlled lifecycle tests and sidecar latency.

## Task 6: Qualify Root waiting commands without changing their job semantics

**Files:** Report Root-command section; reuse the shell fixture/case runner.

- [ ] Run `review-wait` and `adversarial-review-wait`, each once with a 130-second fake-ZCode hold and the same candidate policy. Invoke their actual installed Skills/constant Companion commands in Root, with explicit `--wait`; no Rescue Child. Record same process handle, actual outer/inner long observation, decision cadence, exact command's rendered result, exit/error path and owner. A direct Root delay command alone is not command-specific qualification.
- [ ] Run `status-wait` on one explicitly owned harmless held job with an explicit query timeout. Long shell observation must end promptly when that original Status process times out or the job completes; it must not extend Status's configured deadline. Through the verified native Root interaction, cancel a second Status observation and prove the target job continues with no stop/cancel request caused by ending the wait. This subcase is separately not-proven if native interruption cannot be delivered.
- [ ] Use short fake-provider cases/unchanged production tests for terminal success, PluginError, needs-choice and background queued output. Do not apply byte-identical Rescue sentinel expectations to Review's different renderer. Do not accidentally reinterpret quiet status-sidecar output as Companion completion.
- [ ] If one Root command's native long-wait path fails, record that command's own outcome and inspect its concrete difference from the already observed Root mechanism. One follow-up is allowed; do not declare all commands impossible or all qualified from a single run.

**Example case invocation** (each case gets a fresh private output; the same shape applies to the three documented case labels):

```bash
shell_case_output=$(mktemp -d)
ZCODE_SHELL_WAIT_E2E=1 CODEX_BINARY="$shell_codex_binary" node tools/shell-wait-probe/driver.mjs \
  --case review-wait --codex "$shell_codex_binary" --source-sha "$shell_source_sha" \
  --output "$shell_case_output" --worker-duration-ms 130000 --cap-ms 3600000 --poll-ms 3600000 --budget-ms 360000
```

**Exit:** Q5 conclusions scoped separately to Review, Adversarial Review and Status `--wait`; their background and cancellation ownership contracts remain intact.

## Task 7: Close the report and recommend only the proven next delta

**Files:** Report; plan progress boxes; no production edits.

- [ ] Fill this coverage mapping with evidence labels and the actual retained command/case links. Do not leave missing evidence silently marked passed:

| Spec item | Task and evidence |
| --- | --- |
| S1 preparation/binding authority | **Partial**: Tasks 1/3/4; Task 4 `installed-observed` Case B production linkage/one launch/send, §12 `fixture-tested` negatives. Full production mismatch/one-shot regression coverage still open; [report §7.5](../../qualification/rescue-shell-long-wait.md#75-task-4-coverage-partial-report-closure-task-7-mapping) |
| S2 original-handle/outer-cell ownership | **Partial**: Task 4 `installed-observed` Case B exact original handle and settled long observation; §12 `fixture-tested` negatives. Case A completion linkage `not-proven` (instrument); Task 5 open; [report §7.5](../../qualification/rescue-shell-long-wait.md#75-task-4-coverage-partial-report-closure-task-7-mapping) |
| S3 exact public/terminal/control outcomes | **Partial**: Task 4 `installed-observed` Case B terminal/host exit 0 and byte-exact sentinel in linked output; §12 `fixture-tested` sentinel negatives. Tasks 5/6 choice/error/command checks remain open; [report §7.5](../../qualification/rescue-shell-long-wait.md#75-task-4-coverage-partial-report-closure-task-7-mapping) |
| S4 placement/background/Status observation-only | 5, 6; one short installed background case and current matrix/Status tests |
| S5 interruption/loss/timeouts/ceiling | 5, 6; actual native delivery separated from controlled tests and cleanup |
| S6 named/generic parity and no fallback weakening | 1, 3, 4; actual route plus structural parity and explicit unavailable labels |
| S7 isolation/no production changes | 2, 3, 7; suite selection, installed-fixture cleanup and final diff |
| Q1 effective Child configuration | Tasks 1/3/4: **`not-proven`** propagation/M; `installed-observed` ≥386.6-s ceiling is insufficient for causality; [report §7.3](../../qualification/rescue-shell-long-wait.md#73-case-0-unraised-child-cap-m-not-established-not-proven) |
| Q2 effective Child instructions | Task 4: **`installed-observed`**, named candidate invocation only; directive-led long request, 0 outer returns vs baseline 15. Generic remains `not-proven`; artifact parity `fixture-tested`; [report §7.1–§7.2](../../qualification/rescue-shell-long-wait.md#71-case-b-qualified-named-route-long-observation-installed-observed) |
| Q3 cadence and repeat | Task 4: **`installed-observed`** A/B outer returns 15/0, Child calls 23/2, Root joins 7/1; repeat **`not-proven`** with both attempts retained; [report §7.4](../../qualification/rescue-shell-long-wait.md#74-repeat-outcome-not-proven) |
| Q4 noise/native interruption/sidecar latency | 5 |
| Q5 other waiting commands | 6 |
| Q6 version scope and smallest adoption delta | 7 |

- [ ] Propose a precise minimal adoption delta only for qualified surfaces: configuration location supported by the actual Child/Root trace, compatible instruction form, named/generic synchronization, setup/upgrade guidance, and known version/latency limitations. Do not promote an unseen Role-field propagation path or claim a wrapper pragma is universal. Separate demonstrated improvement from release-blocking compatibility findings and optional human usability evaluation.
- [ ] If a case remains not-proven, close research with the exact cause and one useful next step; do not lower a requirement, fabricate success or freeze all independent work. Production canonical remains shell with its existing instructions until the human adopts a subsequent change. MCP results remain untouched.
- [ ] Verify artifact changes proportionately:

```bash
npm run test:shell-research
node --test tests/test-selection.test.mjs
npm run lint
npm run typecheck
node scripts/check-line-endings.mjs
git diff --check
git status --short
git diff --stat
```

Expected: no failures in changed instrument/selection checks; no production Skills/Role/Companion/config/packaging changes. Also inspect newly created untracked files, which ordinary `git diff` omits. Record real skips and observed failures rather than calling mocks live qualification.
- [ ] For the final routine/marketplace check, use a clean exact source containing the changes **only if commits are separately authorized**, or the existing builder's explicit snapshot inputs/owned isolated clean staging. Do not temporarily hide implementation source needed by the test, commit without authority, or mislabel an old baseline as current verification. Record the exact method and run `npm test` once when appropriate; do not re-enter the previous huge MCP research suite.
- [ ] Write a concise execution handoff linking this report/spec/plan, completed task boxes, actual probe commands, unresolved prerequisites and proposed production file scope. Human review decides whether to commission the subsequent production change; do not automatically ship it.

**Exit:** finite completed qualification artifacts, honest evidence coverage and a concrete human decision. No production rollout is implied.

## Planning-session review status

- Spec independent review: `shell_wait_spec_review`, 2026-10-05, no blocking P1/P2 findings; nonblocking Status-sidecar clarification incorporated.
- Plan independent review: separate read-only `shell_wait_plan_review`, 2026-10-05, no blocking P1/P2 findings. Its optional clarification was incorporated: the raised-cap baseline is explicitly a cap-matched current-instruction control, with default-cap/configuration claims recorded separately. Spec terminology was aligned without adding a new experiment or weakening requirements. The same reviewer narrowly rechecked the final changed paragraphs and confirmed no contradictions or blocking findings.
- The planning session initially left all execution boxes unchecked. Tasks 1–3 and the completed Task 4
  deliverables are now checked; incomplete Task 4 verification/repeat and Tasks 5–7 remain open with the
  recorded limits. Production changes remain unauthorized. The current user explicitly authorized amending
  the Task 4 commit with report/plan changes using `git add -u`, preserving the three untracked scratch files;
  this does not authorize push, PR, merge or rollout.
