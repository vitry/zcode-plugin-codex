# Shell Long-Wait Follow-up Qualification Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to execute this plan task-by-task after user delegation. Independent read-only review is required before close-out. Steps use checkbox syntax. This document is a qualification plan, not authorization to ship a new wait policy.

**Goal:** Resolve the remaining shell long-wait qualification questions under the unchanged spec, preserving every binding, lifecycle, result and placement requirement.

**Architecture:** Reuse the merged shell-only driver, fixture and fail-closed observer. Pin one installed host per comparable case group, retain poll-owned timing and exact interruption evidence, and make only cause-directed changes to isolated research tooling when a measured gap requires them. Production entry points and user configuration remain untouched.

**Tech Stack:** Node.js ESM and `node:test`; installed Codex CLI; read-only Codex Rust source; existing production Companion with a harmless fake ZCode dependency in disposable workspaces.

---

## 1. Authority, location and scope

- Unchanged authority: [2026-10-05 spec](../specs/2026-10-05-rescue-shell-long-wait-design.md), especially S1–S7, Q1–Q6 and §8. Do not edit the spec to fit an unsuccessful measurement.
- Prior executed plan: [2026-10-05 plan](2026-10-05-rescue-shell-long-wait.md); it is a historical execution ledger, not instructions to rerun R0–R5.
- Retained findings and remaining causes: [qualification report](../../qualification/rescue-shell-long-wait.md), §§7.7, 10, 11.2 and 12.8. Read these before attempting a case.
- PR [#66](https://github.com/vitry/zcode-plugin-codex/pull/66) is merged. New baseline: `41e5b0aa24189903f77acb971931df6de04a170e`.
- Branch: `docs/rescue-shell-wait-qualification-next`.
- Worktree: `/Users/zhangzikai/Workspace/Codes/github/zcode-plugin-codex/.worktrees/rescue-shell-wait-qualification-next`.
- Codex source: `/Users/zhangzikai/Workspace/Codes/github/codex`, or `../../../codex` from this worktree. This is NOT the plugin's `.codex` configuration directory. Record its revision/dirty state, inspect pinned files with `git show`, and do not fetch/build/edit that repository as part of a probe.

The current request authorizes drafting and independently reviewing this plan only. Execution needs a later user delegation. Execution delegation permits bounded harmless qualification and necessary research-only instrument corrections, not production changes, user cache/config edits, new adapters, commit/push/PR/merge or automatic promotion. Commit authority must be explicit; do not commit merely to satisfy a clean-tree test.

Keep the original 100-hour safety ceiling, configured operation deadlines, one-shot private preparation, atomic binding and exact-child resume unchanged. Empty terminal observations do NOT prohibit the separate private preparation write. No six-hour ceiling, inactivity detector, MCP reopening, hidden polling script or Codex fork.

## 2. What is already proved, and what is not

| Dimension | Prior evidence | Follow-up responsibility |
| --- | --- | --- |
| Named managed Rescue long wait | Installed 0.160.1/0.161.0: exact route/handle, one launch/send, terminal exit and byte-exact sentinel; fresh 0.161.0 Case B/repeat each 388.3 s with zero outer waiting returns on distinct Children | Preserve these historical facts. Revalidate only the necessary current-version comparison group, not every prior trial |
| Default/unraised cap M | A nonterminal return was observed; exact duration was not retained. `85000` is a terminal poll, NOT M | Measure the actual nonterminal original-handle poll; close the numeric discriminator only with attributable timing |
| Re-entry reduction | Historical cap-matched instruction comparison: 15 outer continuations versus 0 | Current-version comparison if host/provenance differs. Count Root joins separately; no token-savings or whole-job zero-decisions claim |
| Native interruption | Owning-session path investigated and wired; Root-wrapper parser gap already fixed. Actual delivery/settlement unproved | Exercise the repaired path during a demonstrably pending observation; verify stop/reconciliation and unrelated control survival |
| Noise/background | Unclassified cells; no proof of model nonadherence | Bounded cause adjudication, then separate compatibility cases |
| Root waiting Skills | Review host early exit; adversarial rendered marker miss; Status missing owned acknowledgement | Diagnose each specific cause and qualify each entry point independently |
| Generic route | Structural paragraph parity only; no installed generic observation | Discover whether a genuinely supported route is reachable; never force fallback after named-Role rejection |

Planning-session `codex --version` returned `0.162.1`. This is a non-authenticated version observation, NOT a live qualification. Re-pin at execution time; the binary may auto-update. Historical qualification cannot be generalized to another binary/version/configuration/instruction variant.

## 3. File ownership and bounded execution rules

| File | Responsibility |
| --- | --- |
| `tools/shell-wait-probe/driver.mjs` | Case orchestration, prompts, exact lifecycle/timeline and persisted facts; conditional minimal changes only |
| `tools/shell-wait-probe/evidence.mjs` | Bounded call/output adjudication and poll/interrupt attribution; reuse existing parsing and privacy projections |
| `tools/shell-wait-probe/fixture.mjs` | Disposable installs, harmless dependencies, candidate paragraph seam and exact owned cleanup |
| `tests/shell-wait-probe.test.mjs` | Focused RED→GREEN regressions for any new measured instrument gap; no new mixed-MCP interpreter |
| `tests/test-selection.test.mjs` / `tools/run-test-suite.mjs` | Inspect existing isolation; modify only if an actual selection defect is found |
| `docs/qualification/rescue-shell-long-wait.md` | Append dated follow-up evidence and update §§10/11 current mapping/recommendation; preserve historical records |
| This plan | Execution checkboxes, exact tested revisions and final review status |

Do not modify `skills/`, `agents/`, `scripts/`, `hooks/`, `.codex-plugin/`, marketplace snapshots, production qualification gates, user data/config or Codex source. Preserve unrelated root/old-worktree scratch files. If a future production fix is needed, report its scope and request separate authority instead of including it here.

One execution per listed live label/group, with at most one concrete cause-directed follow-up for an inconclusive/failed case. A fresh diagnostic that launches a host counts as that case's initial run or its follow-up, not an extra free run before a formal trial. Before a follow-up, identify the cause and state the single changed variable. A resized comparable cap group counts as that group's follow-up. Task 3's optional native short-window responsiveness control is a separately named, predefined group with exactly ONE run and no retry; it cannot be used to retry the candidate or replace its qualification. Never retry model behavior until it disappears. Stop only dependent claims; finish independent tasks with evidence or precise `not-proven` reasons. If the same new unknown shape recurs after its bounded follow-up, retain it and stop that case; no generic parser expansion or 30-round review campaign.

For a discovered instrument defect: first add a regression to the relevant existing test section using its existing rollout builders, show RED, implement the smallest research-only correction, show GREEN, and run the focused privacy/ownership regressions. If no defect is demonstrated, do not change code just to create a commit.

## Task 1: Re-pin provenance and check the already repaired measurement seams

**Files:** Inspect the three shell probe modules and relevant test sections; record facts in the report. Conditional fixes belong only to their owning module/test.

- [ ] Verify baseline/source/status and pin the actual installed executable, not `node_modules/@openai/codex`'s development pin:

```bash
git status --short
git rev-parse HEAD
shell_codex_binary=$(node -e 'process.stdout.write(require("node:fs").realpathSync(process.argv[1]))' "$(command -v codex)")
"$shell_codex_binary" --version
shell_source_sha=$(git rev-parse HEAD)
git -C ../../../codex rev-parse HEAD
git -C ../../../codex status --short
node tools/shell-wait-probe/driver.mjs --help
```

- [ ] Record executable/version, plugin source/artifact digests, executing observer digest, model, effective isolated configuration, route and instruction variant per run. Configuration retention uses the existing fixture's redacted provenance/hash convention: only the observation-cap key, relevant feature booleans and numeric wait bounds, file digest/mode and verified application facts may be retained. Never persist full TOML, authentication, tokens, private preparation or arbitrary environment values; schema-unknown values are suppressed. Source checkout existence never proves source/binary correspondence. If a later case observes a changed binary/version, stop cross-version comparisons, repin and record the boundary; do not restart the whole campaign silently.
- [ ] Run the existing timing/interrupt/Root/privacy regressions before authenticating:

```bash
node --test --test-name-pattern='review adjudication fixes|review round 2 refinements|review round 3 refinements|native interrupt interaction recording|root-family observer contract|unsupported-call and final-message preparation privacy' tests/shell-wait-probe.test.mjs
node --test tests/test-selection.test.mjs
```

Expected: zero failures. Existing `pollWallTimesMs` covers individual polls; a preparation continuation or shared-cell wall time is not a cap duration. The existing Root-control wrapper exemption must stay forbidden inside the observed Rescue Child.

- [ ] Read `mapShellWaitLiveFacts`, `extractInterruptInteraction`, `analyzeCallSequence`, `waitForPollObservation`, `waitForChildSettlementObservation` and their tests. Determine how an actual nonterminal poll's timing, live original process, pending cell and eventual exit are linked. Missing fields stay null. Do not introduce a fixed undocumented API requirement; record any needed minimal evidence seam as a research task, with an example regression, before changing it.

**Exit:** measurement/cleanup/privacy seams are understood and test-backed; no new installed behavior has yet been claimed.

## Task 2: Measure M and adjudicate the cap discriminator on one comparable host

**Files:** Existing `rescue-long`/`rescue-repeat`/`rescue-baseline` cases; conditional timing correction in evidence/driver/test; report §§7/10/11.

- [ ] Execute one unraised candidate control. Omit `--cap-ms` completely; `0` is invalid. Use private fresh output for every invocation:

```bash
shell_case_output=$(mktemp -d)
ZCODE_SHELL_WAIT_E2E=1 CODEX_BINARY="$shell_codex_binary" \
  node tools/shell-wait-probe/driver.mjs --case rescue-long \
  --codex "$shell_codex_binary" --source-sha "$shell_source_sha" \
  --output "$shell_case_output" --worker-duration-ms 420000 \
  --poll-ms 3600000 --budget-ms 1200000
```

- [ ] Adjudicate M from the nonterminal original-handle poll's OWN `pollWallTimesMs` value and linked return shape: worker/process still running, request window not expired, no interrupt or other ender. Do not take the last terminal poll, whole-cell duration or source default. No nonterminal return or null poll timing means M remains imprecise/unproved; investigate one cause-directed follow-up, not a fabricated number. Preserve poll/result ordering without persisting private output.
- [ ] Execute a raised `rescue-long` with the SAME executable, model, paragraph, requested yield and worker duration, adding only `--cap-ms 3600000`. A causal comparison requires matching pins/configuration apart from that key. At decisive poll start, the independently measured remaining lifetime must be at least `M + 30000`; its basis remains the conservative hold-deadline-at-poll-start measurement, not `workerDurationMs - decisiveWallMs`.
- [ ] If the initial hold cannot meet that precondition, record it as inconclusive. A single cause-directed resized group may use `workerDurationMs = max(420000, ceil(M) + 90000)` with enough finite probe budget; measure actual remaining lifetime again and keep worker duration matched across its unraised/raised runs. If M is at/above the candidate cap, do not claim propagation from this candidate or enlarge the cap without first reporting the changed experimental scope.
- [ ] On the current comparable pin, execute one fresh `rescue-repeat` with the qualified raised flags and a distinct actual Child. Because the planning binary differs from 0.161.0, the historical repeat does not replace this current-version repeat. If an exactly matching historical pin is actually reused, retain its qualified repeat without re-running it merely for ceremony; explain all provenance matches.
- [ ] Where current-version re-entry benefit lacks a comparable instruction control, run one `rescue-baseline` with the SAME cap/worker/budget and `--poll-ms 60000`. This isolates instructions from cap configuration. Unknown baseline linkage/counts remain unknown, not zero. Reuse qualified matching evidence if available; do not recreate four historical M attempts.
- [ ] Record exact route, parent/Child linkage, one launch/send, original handle, directive and inner yield, individual poll outcomes, outer returns, Root joins, terminal exit and sentinel. Exit 0 from the DRIVER means execution/cleanup completed, not that the case qualified. Calculate ratio/precondition only when M is attributable; otherwise keep `POSITIVE-but-M-imprecise` as a clue, not spec Q3 acceptance.

**Exit:** exact M and the quantitative discriminator are proved on the comparable pin, or the missing fact/cause is explicit. Natural completion/repeat evidence remains useful regardless of the causal verdict.

## Task 3: Native pending-observation interruption and owned settlement

**Files:** Existing `rescue-interrupt`, Root-control extraction and lifecycle fixture/tests; report S5/Q4.

- [ ] Trace the current installed family's owning-session delivery path using the report/source starting points. The historical V2 `interrupt_agent` path is the starting hypothesis, not a mandate to use a nonexistent API. Use V1 only if the current host actually exposes its interrupt flag; never use a separate app-server's `turn/interrupt` to pretend it owns the CLI's Child. No MCP or fork.
- [ ] Run the repaired case once, with a long enough held original observation for pending-window evidence:

```bash
shell_case_output=$(mktemp -d)
ZCODE_SHELL_WAIT_E2E=1 CODEX_BINARY="$shell_codex_binary" \
  node tools/shell-wait-probe/driver.mjs --case rescue-interrupt \
  --codex "$shell_codex_binary" --source-sha "$shell_source_sha" \
  --output "$shell_case_output" --worker-duration-ms 420000 \
  --cap-ms 3600000 --poll-ms 3600000 --budget-ms 900000
```

- [ ] Require ONE actual exact-target delivery, active prior status, an attributable pending original-handle observation at delivery, and linked post-delivery outcome. Record `attempted`, `delivered`, `exactTargetMatch`, `callCount`, `orderingBound`, `settled`, `settledBasis` and timing. Nulls, terminal-before-interrupt, wrong target, multiple delivery, unreadable continuation and external budget kill never qualify.
- [ ] Distinguish native Child turn interruption, inner poll/cell settlement, exact Companion process cleanup and durable job/reconciler settlement. A successful interrupt tool response alone proves none of the latter. Read the isolated production stores through existing bounded seams to establish the original job, stop cause/intent and terminal winner; no accepted running work may become untracked. Retain only sanitized ownership/settlement facts.
- [ ] Establish no collateral cancellation using one unrelated harmless owned job/Child control in the same relevant host lifecycle, with independently observed survival. Reuse the existing lifecycle fixture/production seams; investigate the minimum isolated control if not already available. No new binding, separate owner authority or parallel original-handle poll. Without live control evidence, do not claim live no-collateral preservation from a unit test alone.
- [ ] For responsiveness, compare delivery-to-settlement against the native short-window expectation on the same host. Inspect source plus existing controlled baseline first; if neither provides a comparable measured latency, allow ONE separately recorded `native-short-window-responsiveness-control` run (a report/group name, not a new assumed CLI option), with no retry. State the sole experimental change before running: the temporary waiting paragraph requests the baseline 60000-ms window; executable/model/cap/worker/entry/ownership/delivery method and evidence rules remain matched to the candidate. Use only the minimum tested isolated fixture seam if current case selection cannot express that control. This control neither consumes nor adds retries to the candidate's one-run-plus-one-cause-follow-up allowance, and cannot substitute for candidate delivery/settlement qualification. Record the measured delay instead of inventing a universal SLA or waiting secretly until the one-hour window ends.
- [ ] If the host interrupts the turn but the pending poll survives, record that exact result and keep production blocked. Investigate one cause-directed follow-up using existing supported host mechanisms; never substitute process-budget cleanup for native cancellation. A missing model call stays distinct from tool rejection, parser failure and delivered-but-unsettled work.

**Exit:** pending delivery, responsive owned settlement and unrelated control survival are proved, or each dependent production dimension stays precisely `not-proven`. The 100-hour ceiling is exercised through inherited controlled tests, not a 100-hour live run.

## Task 4: Noisy output, background placement and sidecar opportunity

**Files:** Existing `rescue-noise` and `background`; conditional narrow evidence/fixture/test corrections; report S2–S4/Q4.

- [ ] Before retrying, inspect the recorded shape facts/known grammar fixes. A privacy-suppressed unknown cell cannot be retroactively reconstructed or labelled model nonadherence. If needed, use one fresh bounded diagnostic retaining only whitelisted structural facts and manually adjudicate the observed narrow shape; no raw private rollout archive or general JS interpreter.
- [ ] Run each case once after that concrete prerequisite is understood:

```bash
shell_case_output=$(mktemp -d)
ZCODE_SHELL_WAIT_E2E=1 CODEX_BINARY="$shell_codex_binary" \
  node tools/shell-wait-probe/driver.mjs --case rescue-noise \
  --codex "$shell_codex_binary" --source-sha "$shell_source_sha" \
  --output "$shell_case_output" --worker-duration-ms 130000 \
  --cap-ms 3600000 --poll-ms 3600000 --budget-ms 360000

shell_case_output=$(mktemp -d)
ZCODE_SHELL_WAIT_E2E=1 CODEX_BINARY="$shell_codex_binary" \
  node tools/shell-wait-probe/driver.mjs --case background \
  --codex "$shell_codex_binary" --source-sha "$shell_source_sha" \
  --output "$shell_case_output" --worker-duration-ms 120000 \
  --cap-ms 3600000 --poll-ms 3600000 --budget-ms 600000
```

- [ ] Noise: same handle and terminal bytes; ordinary stderr/progress must not substitute for completion or be routinely relayed to Root. Record actual extra interventions, not just requested long yields.
- [ ] Background: Root's decoded acknowledgement is launch-only for the exact Child, with zero positively observed Root joins; the exact Child remains responsible for attached Companion observation to terminal. Root acknowledgement is not Child settlement; verify the existing settlement watch and final process outcome. A completed Root alone cannot qualify background placement.
- [ ] Preserve existing between-polls-only sidecar intents (`zcode status`, `$zcode:status`, `/zcode:status`, trim only). Inspect/test the structural policy and observe installed latency only if the same native session supports safe steering. Do not issue a parallel poll or turn Status into the waiting engine. If unreachable, retain the concrete interface limitation; do not demand a new undocumented steering API.

**Exit:** each placement/noise surface has its own result; uncertainty does not erase the already measured named foreground behavior.

## Task 5: Root Review, Adversarial Review and Status remain separate

**Files:** Existing Root-family case specs/observer, `validateStatusWaitFlow`, renderer fixture/test seams; report Q5.

- [ ] Review: trace the concrete early host exit with redacted bounded evidence. Keep Root placement and the real `invoke review` entry; no Rescue-shaped replacement or invented new process.
- [ ] Adversarial Review: compare the production renderer's actual contract with the fake peer payload and linked bytes. A fixture marker mismatch can be an instrument/dependency mismatch; test the correct framing with existing renderer contracts before changing a probe marker. Never remove exact terminal/exit checks or change production output to manufacture qualification.
- [ ] Status: use the existing two-turn owner-session flow. Turn 1 launches `review --background`; turn 2 uses ONLY the actually observed reserved job id in that SAME session, with an explicit Status query timeout. No pre-reserved foreign-owner job, guessed id, assistant-reported result or unrelated final reply substitutes for the acknowledgement/linked command.
- [ ] Run `review-wait` and `adversarial-review-wait` separately with the existing CLI, each using fresh output, `--worker-duration-ms 130000 --cap-ms 3600000 --poll-ms 3600000 --budget-ms 600000`. Run `status-wait` separately with those flags plus `--status-query-timeout-ms 120000`. Record per-case verdicts, natural completion OR the production timeout envelope, and original process termination. Confirm Status's timeout is not extended by the requested shell observation window.
- [ ] Qualify Root Status observation cancellation separately from Child interruption: discover a supported native interaction owning that EXACT running Root observation, prove it ends while the selected job remains authorized/running and receives no stop/cancel intent. Do not call Root self-interrupt, target another agent, or assume SIGINT means observation-only cancellation. If no supported interaction is reachable, retain live cancellation `not-proven`; the existing AbortController wait-boundary test is instrument-level only.
- [ ] Background Review/Adversarial stay enqueue-only. Re-run controlled timeout/ownership/result tests as relevant without modifying their expectations. Do not infer these commands' qualification from generic Root shell support or one successful command.

**Exit:** each real Root command has a bounded, owned, command-specific conclusion; failure of one does not disqualify or qualify the others.

## Task 6: Supported generic route, without weakening admission

**Files:** Read Rescue Skill/route planner/Role preflight; conditional isolated route selection in fixture/driver/tests only; report S6/Q2.

- [ ] Trace the current host's actual named/generic selection and supported spawn schema from existing production preflight. Decide whether the generic route is genuinely reachable under that host's ordinary capability conditions. Do not fake a named-Role rejection or route around a recognized-but-rejected Role.
- [ ] If supported, add only the minimum explicit research-fixture seam needed to exercise that ordinary generic condition, recording the condition and delivered immutable assignment hash. No CLI flag/API name is pre-required by this plan. Define any new seam in the report, test the exact admissible condition and named-rejection negative RED→GREEN, and keep production planner/binding/assignment authority unchanged.
- [ ] Execute one generic qualification with matched candidate cap/paragraph and enough measured remaining lifetime. Require actual generic linkage, one mapped Companion launch/send, original handle, exact terminal output and no fallback weakening. Its installed result remains distinct from fixture paragraph parity.
- [ ] If unavailable, record source and installed schema/preflight evidence, not merely that the model selected named. Do not force a generic run for a checkbox. Any later rollout recommendation must explicitly describe the named/generic scope and preserve parity before broader promotion.

**Exit:** generic is independently proved or precisely unavailable/unproved; no false universal qualification.

## Task 7: Contract regression, evidence matrix and decision handoff

**Files:** Report §§10/11 and a dated follow-up section; this plan checkboxes; no spec/production updates.

- [ ] Run the changed shell instrument, isolation and inherited authority/lifecycle/result regressions. Record exact source plus executing-tree digests, commands, counts, skips and failures:

```bash
npm run test:shell-research
node --test tests/test-selection.test.mjs
node --test tests/rescue-preparation.test.mjs tests/rescue-binding.test.mjs tests/rescue-route-planner.test.mjs
node --test tests/rescue-lifecycle.test.mjs tests/rescue-child-reconciliation.test.mjs tests/rescue-progress-relay.test.mjs
node --test tests/job-control.test.mjs tests/mcp-result.test.mjs
npm run lint
npm run typecheck
node scripts/check-line-endings.mjs
git diff --check
git status --short
```

- [ ] For final `npm test`, use a clean exact source. Without explicit commit authority, use the existing spec §2 owned park-and-restore method ONLY for documentation/scratch, leaving all tested implementation present; record the exact parked paths, pre/post content hashes, test result and successful restoration, without touching unrelated user files. If uncommitted implementation prevents a clean exact-source run and the existing builder cannot stage it faithfully without a commit, report that final gate as blocked pending authorization; do not commit to make it pass. Only when separate explicit commit authority is actually granted may a fully committed source be used. Never hide implementation or cite the clean planning baseline as current changed-tree verification. Do not run `test:mcp-research` or authenticated ordinary E2E merely as a new routine gate.
- [ ] Verify no production/spec/marketplace diff against `41e5b0aa24189903f77acb971931df6de04a170e`. Check exact fixture-owned process/worktree/config/credential cleanup; keep redacted outcome summaries and decisive tool evidence only. A cleanup failure is reported, not silently called success or resolved by broad directory deletion.
- [ ] Update S1–S7 and Q1–Q6 coverage with source-confirmed, fixture-tested and installed-observed labels, versions, scope and precise remaining causes. Do not rewrite historical facts, fold unknown counts into zero or collapse native tool acknowledgement, poll exit and durable cancellation settlement into one boolean.
- [ ] Independent read-only Spec and Standards review once at close-out, then narrow recheck of any actual fixes. No fixed 30-round loop. Where implementation changes are needed, honor the user's established ZCode-coding/independent-review workflow; a tooling quota failure is not authority to switch coding agents silently.
- [ ] Deliver a temporary handoff linking this spec/plan/report, records, executed cases, unproved dimensions and minimal proposed production scope. A positive recommendation requires spec §8's actual route, quantitative long discriminator, repeat, reduced re-entry, exact handle/terminal linkage and native interruption/settlement. Root commands and generic/background surfaces retain their own qualification boundaries. Only after explicit user adoption may a separate production-change plan be written; never auto-promote canonical behavior.

## 4. Coverage and completion

| Requirement | This plan |
| --- | --- |
| S1 preparation, atomic binding, one-shot/resume authority | Tasks 1/2/6/7; unchanged production negatives |
| S2 one launch, original handle, empty observations, pending-cell ownership | Tasks 1–4/7 |
| S3 exact public output, errors, choice/resume/control outcomes | Tasks 2/4/5/7; inherited result/choice tests |
| S4 placement matrix, background and Status observation-only | Tasks 4/5/7 |
| S5 interruption, reconciliation/loss, deadlines and ceiling | Tasks 3/5/7; controlled inherited loss/ceiling tests, no literal 100-hour run |
| S6 named/generic alignment, no fallback weakening | Tasks 2/6/7 |
| S7 isolation, no production/canonical/config changes | All tasks, final diff/cleanup in Task 7 |
| Q1/Q2 effective config and delivered route instructions | Tasks 1/2/6 |
| Q3 timing, discriminator, re-entry and repeat | Task 2 |
| Q4 noise, interruption and sidecar latency | Tasks 3/4 |
| Q5 Root waiting Skills | Task 5 |
| Q6 smallest supported/version-scoped next delta | Task 7 |

Research completion accepts honest evidence or precise investigated `not-proven` causes. Production acceptance does not. Current canonical remains the existing shell adapter and instructions; MCP remains in its prior recorded state.

## 5. Planning verification and independent review

Planning complete; execution has NOT started. The formal plan is stored in this new worktree's `docs/superpowers/plans/` directory, where its relative links resolve. All execution checkboxes remain open.

- Fresh clean baseline at `41e5b0aa24189903f77acb971931df6de04a170e`: `npm ci` succeeded without dependency-file changes. `npm test` exited 0: routine **3397 tests / 3394 pass / 0 fail / 3 skipped**, plus marketplace snapshot **2/2 pass**. The plan was drafted outside the worktree until that clean-source run completed. Log: `/tmp/zcode-shell-wait-next-baseline-2026-10-13.log`. These are planning-baseline tests, not verification of future instrument changes or installed long-wait behavior.
- `npm ci` reported three high-severity dependency audit advisories. No automatic dependency change or audit fix was performed; this planning session does not adjudicate those advisories.
- Independent read-only Spec review: `closure_spec_review`, no blocking P1/P2. Its optional clarification was incorporated: fresh host diagnostics count against the case's finite run/follow-up allowance.
- Independent read-only executability review: `final_plan_review`; configuration privacy, the optional short-window-control quota and the no-authority clean-source branch were clarified. The same reviewer narrowly rechecked and confirmed all P2 corrections sufficient, with no remaining blocker. Its temporary-link note is resolved by placing this file at its formal path.
- Main-agent self-review mapped S1–S7 and Q1–Q6, checked existing command/file names, and found no speculative mandatory API or lowered production requirement. No authenticated trial, research implementation, spec/production/config change, commit, push or PR was performed during planning.
- Final document checks: LF/newline/trailing whitespace and all three local Markdown links passed; `git diff --check` passed, tracked diff against the baseline was empty, and selection tests passed **6/6**. The new plan is the only untracked file in this worktree. Spec and implementation remain unchanged.
