# Managed Rescue Native Shell Long-Wait Qualification Plan

> **For agentic workers:** Use `superpowers:executing-plans` to execute this plan inline, task by task. Use `superpowers:subagent-driven-development` only if delegation is separately authorized. Steps use checkbox syntax. This is qualification-artifact development, not authorization to ship a production policy. The user has authorized independent spec/plan review for this planning session.

**Goal:** Qualify longer native shell observations on the actual managed Rescue Child and Root-owned waiting commands while preserving the complete existing functional contract.

**Architecture:** Keep production Companion, hooks, preparation, binding, results and lifecycle authoritative. Use an isolated installed-plugin fixture with a harmless fake ZCode dependency, temporary cap/instruction variants, and a small shell-only case runner. Trace host configuration first; measure real Child ownership, outer/inner observations, result delivery and cancellation without reopening MCP or building a general rollout parser.

**Tech Stack:** Node.js ESM/node:test, existing installed-plugin/fake-ZCode/process helpers, installed Codex CLI/native host interaction, read-only Rust source inspection.

**Spec:** [Native shell long-wait design](../specs/2026-10-05-rescue-shell-long-wait-design.md).

**Current status (2026-10-07 completion review):** Partial implementation and recorded research outcomes,
not full plan acceptance. The report honestly records missing proof, which spec §8 permits, but the review
found a preparation-data retention violation and planned instrument capabilities that were not implemented.
Resume with **R0–R5 below**, then close the remaining original task boxes. The spec and product goals are
unchanged. Historical successful observations remain valid within their recorded scope; no production
rollout, commit, push, PR or merge is authorized by this amendment.

**Status superseded (2026-10-10):** the R0–R5 remediation described below was EXECUTED and its final
state is recorded here: instruments fixed and reviewed (30-round plain codex `review` loop converged at
round 30 with zero findings, plus the ZCode dual-axis review ACCEPT/ACCEPT/CLOSE), the corrected R5
trials adjudicated (M bounded-but-imprecise, propagation POSITIVE-but-M-imprecise, repeat QUALIFIED),
and the work committed as `60b9fc5` and pushed to PR #66 — fresh-verified 2026-10-10 via `gh` (head
`60b9fc5`, OPEN, MERGEABLE, 6/6 checks pass, run 37862214745). The R0–R5 boxes below are the executed
ledger, not an execution instruction; commit/push/merge authority applies as recorded in each phase.

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

## Completion-review correction and resumption order (2026-10-07)

The independent read-only reviews `shell_wait_spec_acceptance_review` and `shell_wait_standards_review`
checked `6638878...5026009`, the report and retained case records. They identified the issues below.
The completion review reran selection (6/6) and shell-research (195/195), both passing; those tests did
not cover the newly identified failures. These are historical checks, not verification of future fixes.

| Finding | Responsibility | Required correction |
| --- | --- | --- |
| P1: unsupported-call excerpts persist private preparation/task content | R0; evidence/driver | Fail-closed redaction before any excerpt or record leaves credential homes, including parser failure paths |
| P2: unrecognized parent becomes `rootJoins: 0` | R1; evidence | Unknown is `null`; zero requires positively identified evidence |
| P2: Root cases use a Rescue-only observer | R2; evidence/driver | Implement the originally planned Root-owned command observation contract, not a Rescue Child requirement |
| P2: native interrupt case is only a placeholder | R4; driver/source investigation | Establish installed owning-session interaction and exercise it, or record a concrete investigated inability — DONE (R4): the installed owning-session interaction is established (V2 `interrupt_agent`, installed-config-enabled) and wired into the case prompt plus fail-closed delivery/settlement recording; the live delivery measurement is R5's |
| P2: Status case has no actual owned target/query timeout | R3; fixture/driver | Set up a real owned held job through production entry points; use its returned ID and actual timeout |
| P2: explicit Rescue background prompt requests `queued` | R3; driver | Require exact launched-Child acknowledgement, no Root join, attached Companion observation in Child |

Root observer work is **already in scope** under Task 6/spec Q5. The report's §9.2 sentence declaring it
out of scope must be corrected during R5. Similarly, a `delivered: null` placeholder is not evidence that
the installed host cannot interrupt. M/repeat/generic remaining `not-proven` is not itself a violation:
spec §8 allows precise bounded research outcomes, but not an unexplored missing implementation being
presented as a host limitation. Do not restart MCP research or expand the probe into a general interpreter.

### R0: Repair evidence privacy before collecting new live evidence

**Files:** Modify `tools/shell-wait-probe/evidence.mjs`, `tools/shell-wait-probe/driver.mjs`,
`tests/shell-wait-probe.test.mjs`; later record the correction in the qualification report.

- [x] Write failing regressions using synthetic canary task/preparation/capability values. Cover a valid
  v5 preparation write with the observed `yield_time_ms:1000`, malformed/truncated direct arguments,
  unsupported wrapper and multi-statement shapes, and final-message/error excerpts that echo private input.
  Assert that neither the returned evidence nor the persisted record contains any canary. An inconclusive
  verdict must still retain a useful *structural* reason without the private frame.
  (DONE R0: 11 canary regressions with synthetic `CANARY-*` values, incl. the production-valid v5
  preparation fixture; first failed 0/9 (+0/2 round-two) against the committed `5026009` instrument under
  a `git archive` replay, then passed 11/11. Report §12.4.)
- [x] Run the new focused tests and retain their intended RED output. For new test names, use
  `node --test --test-name-pattern='preparation privacy' tests/shell-wait-probe.test.mjs`.
  (DONE R0: RED runs retained per gate round; final focused privacy suite 19/19.)
- [x] Fix redaction independently of successful preparation parsing. Today `evidence.mjs`'s
  `unsupported-call-shape` path passes raw input to path-only `scrubExcerpt`, and the driver persists it.
  When input cannot safely be classified, suppress its raw body rather than trusting path substitution.
  Retain safe tool names, numeric wait arguments, directive facts and error classifications where possible;
  never retain nonempty private `chars`, task bodies, preparation/capability data or credentials.
  (DONE R0 through 13 recorded codex-gate rounds: raw unclassifiable bodies suppressed to structural facts
  — allowlisted public tool/directive-key names, counts, byte length; no numbers from unclassified bodies;
  supported-path excerpts projected onto validated public protocol fields; schema gates and position-
  validated wall-time headers. Report §12.4. R5 confirmation: every R5 unclassified-cell record retained only
  structural excerpts, zero private content.)
- [x] Re-run the focused privacy tests and `npm run test:shell-research`; require GREEN before live trials.
  (DONE R0: shell-research green at every gate round, ending 217/217; R5's pre-trial re-verification passed
  292/292, then 293/293 after the R5 defaults fix.)
- [x] Inspect only the known private noise/repeat2 records referenced in report §§7.4/8.2 without printing
  their payloads. Record field-presence findings only. Do not upload, commit or copy the contaminated
  excerpts into documentation. If overwriting/removing historical records is needed, first obtain approval
  for those exact targets and explain the evidence impact; do not delete evidence or alter historical
  verdicts silently. Pending that decision does not block fixing the instrument or independent trials.
  (DONE R0: field-presence-only inspection recorded in §12.4 — noise 364 chars / repeat2 455 chars, one
  excerpt each; repeat1 none; payloads never printed or copied; both files stay in place pending an
  approved destructive-cleanup decision.)

**Exit:** new returned/persisted evidence is demonstrably private-safe on both supported and unsupported
paths; existing-record remediation status is explicit, not silently claimed complete.

### R1: Repair bounded parsing, unknown counts and timing provenance

**Files:** Modify `tools/shell-wait-probe/evidence.mjs`, `tools/shell-wait-probe/driver.mjs`,
`tests/shell-wait-probe.test.mjs`; inspect the retained sanitized structure and report §§7.3/7.4/8.2.

- [x] Add a failing regression for the observed preparation write with `yield_time_ms:1000`, preserving
  production v5 validation, original handle and one-shot admission. Add negatives for duplicate preparation,
  trailing input, foreign handle and unresolved/overlapping writes. Support this observed optional argument
  without `eval`, a general JS parser, or treating private preparation as an empty terminal poll.
  (DONE R1: PREPARATION_PATTERN accepts the one optional bounded numeric literal in the observed position;
  duplicate/foreign/trailing-input/invalid-envelope negatives still block. Report §12.5.)
- [x] Add a failing case where parent linkage is unavailable but a rollout contains a `wait_agent` call:
  Rescue-mode `rootJoins` must be `null`, not the current fabricated zero. Also check positively identified
  zero and nonzero cases; Root-mode accounting is separately completed in R2.
  (DONE R1: `rootJoins` is null without a uniquely identified parent rollout; positively identified
  zero/nonzero unchanged. Report §12.5.)
- [x] Implement the narrow fixes and re-run `npm run test:shell-research` plus selection tests.
  (DONE R1: shell-research 229/229 exit 0, selection 6/6.)
- [x] Record the executing observer revision/digest separately from the fixture source SHA, actual binary
  version/executable, reachable tool family, model when observable, and sanitized actual directive/yield
  facts. Missing runtime facts remain unknown rather than inferred from fixture hashes.
  (DONE R1: `provenance.observer` block — revision `working-tree-uncommitted` + stable sha256 over the
  working-tree evidence.mjs+driver.mjs bytes; binary version in `provenance.codexVersion`;
  model/reachableToolFamily stay null. R5 exercised this per record — §7.7/§12.9.)
- [x] Do not use `workerDurationMs - decisiveWallMs` as poll-start remaining lifetime. Record the actual
  gate/hold and decisive-poll-start timing on a documented comparable clock, or retain `null` with its
  limitation. Add timing regressions with delayed model start. Keep the old arithmetic residual labelled
  as such in historical records; never retroactively qualify the M + 30000 discriminator from it.
  (DONE R1: arithmetic retired from new records; `held.timeline` on the monotonic elapsed clock with
  `pollStartedAtElapsedMs`; `remainingLifetimeMs` = hold-deadline − measured poll start, basis
  `hold-deadline-at-poll-start`, a conservative lower bound. R5 recorded timings on this basis; the
  discriminator's precondition is NOT evaluated — M is bounded-but-imprecise and the earlier
  verification is WITHDRAWN (post-trials review-loop correction; §7.7/§10).)

**Exit:** the known legal preparation shape no longer blocks unrelated measurements, absent evidence is
never zero, and new records can establish the discriminator's timing or explicitly state why not.

### R2: Implement the planned Root-family observer

**Files:** Modify `tools/shell-wait-probe/evidence.mjs`, `tools/shell-wait-probe/driver.mjs`,
`tools/shell-wait-probe/fixture.mjs`, `tests/shell-wait-probe.test.mjs`; reuse existing command renderers
and production tests read-only.

- [x] Add failing Root-owned Review/Adversarial/Status success cases with no Rescue Child. Each must qualify
  only its actual validated Companion invocation/arguments, exact Root process handle, settled outer-cell
  continuations, terminal exit, command-specific rendered result and Root observation cadence.
  (DONE R2: Root-mode positives/negatives in the observer; slice RED 2/14 before GREEN 14/14. Report §12.6.)
- [x] Add negatives for foreign handle/result, quoted invocation, unresolved cell, overlapping poll,
  duplicated process launch, truncated evidence and a renderer mismatch. A Root delay script or assistant
  claim must never qualify a command; an absent Rescue Child must not disqualify a legitimate Root case.
  (DONE R2: all listed negatives fail closed; absent Rescue Child no longer disqualifies Root cases. §12.6.)
- [x] Select the observer contract from the existing case family. Keep Rescue's exact Child/binding checks
  unchanged. Do not weaken them to make Root cases pass. Preserve `null` for unavailable Root facts and
  keep Root observation calls separate from Rescue Child joins.
  (DONE R2: `mode` selected per case family ('rescue'/'root', unknown fails closed); Rescue checks
  byte-for-byte unchanged; `rootJoins` stays null for root cases. §12.6.)
- [x] Verify that the candidate policy is actually delivered to Root for each command. The current fixture
  changes only Rescue's named/generic paragraphs, while the canonical Review/Adversarial/Status Skills
  still prescribe `60000`. Add a tested temporary installed-instruction or supported case-delivery seam
  requesting the candidate outer/inner policy; retain sanitized differences and hashes. Change waiting
  instructions only, preserving commands, arguments, renderer, ownership and placement. A raised fixture
  cap or a `--poll-ms` record alone is not proof that Root was instructed to request a long observation.
  (DONE R2: `commandSkillVariant` seam applies the candidate waiting paragraph to the isolated installed
  command Skills with hashes + sanitized diffs and the explicit not-proof note. R5's root trials ran
  with it (§9.4). §12.6.)
- [x] Verify rendered output against the actual command contract, not a bare Rescue sentinel. Where only
  sentinel presence is checked, label that narrower check; do not claim complete stdout equality.
  (DONE R2: `publicResultMarkers` + `resultCheckLabel` narrower checks. R5's adversarial run exercised
  exactly this check — markers missing, run not qualified (§9.4). §12.6.)
- [x] Run `npm run test:shell-research`, selection, lint and typecheck before any Root live trial.
  (DONE R2: 253/253 exit 0, selection 6/6, lint/typecheck clean. R5's pre-trial re-verification passed.)

**Exit:** positive/negative fixture evidence proves the instrument can adjudicate the Task 6 command
surfaces. This is instrument readiness, not installed command qualification.

### R3: Correct Status targets and Rescue background semantics

**Files:** Modify `tools/shell-wait-probe/driver.mjs`, `tools/shell-wait-probe/fixture.mjs`,
`tests/shell-wait-probe.test.mjs`; read canonical Skills/Companion job and placement contracts.

- [x] Add a failing Status setup test that requires creating/selecting one actually owned held job through
  production entry points in the owning session, retaining its returned ID, and passing an explicit query
  timeout to the real Status command. Reject guessed IDs, missing ownership and missing targets. Do not
  manually manufacture binding/authority records or leave target setup to a vague model prompt.
  (DONE R3, reworked after a self-review P1: the two-turn SAME-SESSION live contract — turn 1 launches the
  held job in the live session through `$zcode:review --background`, turn 2 resumes the SAME session with
  the explicit `$zcode:status <observed-id> --wait --timeout-ms <ms>`; fail-closed observed-flow validation.
  §12.7. R5's status run exercised this and failed closed as designed (§9.4).)
- [x] Implement that setup using fake ZCode only. Test Status process timeout separately from job completion;
  a long shell observation cannot extend the query deadline. Keep the second cancelled Status-observation
  subcase pending R4 and verify that ending that wait sends no job stop/cancel request.
  (DONE R3: JOB_WAIT_TIMEOUT at expiry while the job stays held; the cancelled-observation subcase was
  completed by R4 through the production wait boundary with no stop/cancel request. §12.7/§12.8.)
- [x] Add a failing background-prompt/flow test: explicit Rescue `--background` asks for exact launched-Child
  acknowledgement, not `queued`, and Root does not join. The exact Child observes its foreground Companion
  until terminal. Keep Review/Adversarial enqueue-only and complex no-flag detached behavior distinct.
  (DONE R3: backgroundFlow only on `background`; queued wording deleted; distinctness enforced by spec
  facts. §12.7.)
- [x] Correct the prompt and probe lifecycle so legitimate Root acknowledgement is not confused with Child
  terminal completion. Observe Child settlement before fixture disposal; do not prematurely kill the Child
  merely because Root acknowledged. If the actual host cannot keep that branch alive, retain that measured
  result rather than constructing a replacement process or changing production placement.
  (DONE R3: child-settlement phase — Root's acknowledgement recorded, Child gate opened first, settlement
  watched, exact-process termination after the watch. §12.7. R5's background run ended
  inconclusive (unclassified cell) before this flow could be exercised (§7.7); the lifecycle
  remains tested, unexercised live.)
- [x] Run `npm run test:shell-research` and relevant existing job/placement tests without changing their
  expectations. Root/background installed claims remain open until R5's actual runs.
  (DONE R3: 277/277 exit 0; tests/job-control.test.mjs 209/209 and tests/rescue-route-planner.test.mjs
  161/161 unchanged. R5's runs are recorded in §7.7/§9.4 — background and Root claims remain `not-proven`.)

**Exit:** command prerequisites and probe expectations match S4; no new product job semantics.

### R4: Investigate and exercise native interruption in the owning session

**Files:** Modify `tools/shell-wait-probe/driver.mjs`, `tests/shell-wait-probe.test.mjs` and the report's
control/lifecycle sections; inspect `../../../codex` read-only with a fresh source pin.

- [x] Determine what the installed owning Root session exposes and can actually use for an exact Child
  interruption and, separately, cancellation of Root's Status observation. Start with report §3's V2
  `interrupt_agent`, V1 `send_input {interrupt:true}`, and code-mode cancellation findings; these are
  source-backed candidates, not mandatory APIs or proof of installed availability. Record the actual family,
  ownership/target checks, reachable interaction and rejected/unavailable paths with sanitized evidence.
  (DONE 2026-10-08: family = V2, installed-config-enabled — the live `~/.codex/config.toml` contains
  `features.multi_agent_v2.enabled = true`; the config block's AUTHORSHIP is NOT ESTABLISHED: the plugin's
  own setup writes only `features.hooks`, `hooks.state`, the `hide_spawn_agent_metadata` leaf and
  `[agents.zcode-rescue]`, while the `features list` true/false probe stands either way; installed binary
  re-pinned to 0.161.0
  (auto-update from 0.160.1); non-authenticated probes: `codex features list`, `codex debug models`
  (bundled catalog declares v2 for the current default models), binary `strings` carry the exact V2
  `interrupt_agent` spec text. Source pin 67727e7c (clean): `add_collaboration_tools` registers
  `interrupt_agent` in ANY V2 session whose `collab_tools_enabled` holds — the ROOT of a normal exec
  session qualifies (`get_agent_path().is_none()`), so it is not restricted to special agent setups;
  targeting = known non-root non-self agent in the shared in-process registry; nested-poll cancellation
  stays gated by `Feature::CodeModeInterrupt` (default false at the pin AND installed-observed false), so
  exact-Child TURN interruption is reachable while inner-poll settlement is NOT guaranteed. Report §3.3.)
- [x] Add failing instrument tests for confirmed pending observation → exact target delivery → settlement.
  Cover unsent intent, wrong target, gate already completed, external budget kill, and turn interruption
  without inner-poll settlement. Include an unrelated harmless Child/job that must survive.
  (DONE: 14 new R4 instrument tests, RED first, all GREEN; the unrelated-survivor assertion uses the
  fixture's held-job machinery — two production-reserved jobs in two owning sessions, only one observed.)
- [x] If a supported interaction is reachable, wire it into the live case through the **same owning native
  session**. Record actual delivery result, exact target, pending interval, inner observation settlement,
  delivery-to-settlement latency and the existing stop/reconciliation outcome. The `rescue-interrupt` case
  must no longer use permanently-null delivery fields in place of an attempted interaction.
  (DONE: the reachable in-exec-session path IS the model-facing tool in the owning Root turn — the case
  prompt now directs exactly one `interrupt_agent` delivery to the exact spawn-acknowledgement id while
  pending, forbidding collateral interruption; `evidence.mjs` `extractInterruptInteraction` parses the
  call/output with fail-closed privacy (id-shaped targets only, structural rejection kinds), and the
  driver mapping records attempted/delivered/rejection/exactTargetMatch/settled/settledBasis/
  pendingIntervalMs/deliveryToSettlementMs/timingBasis or an explicit investigated reason. Actual live
  delivery measurement happens in R5 through this wired path.)
- [x] Exercise the separate Root Status-observation cancellation using R3's owned job and prove that job
  remains running, with no stop/cancel request caused by cancellation. Child interruption, Root joins and
  Root Status cancellation are distinct interactions; `wait_agent` alone establishes none of them.
  (DONE: production `runCompanion(['status', jobId, '--wait', …])` cancelled mid-flight through the
  wait's own external observation signal — the WAIT ends with the abort reason, both held jobs stay
  `queued` in the production store, and neither records a stop intent. There is no model-facing
  self-interrupt tool, so observation cancellation is exercised at the production wait boundary, labeled
  instrument-level — never as a Child interrupt.)
- [x] If no supported owning-session interaction is reachable after one bounded cause-directed follow-up,
  record precisely what was inspected/attempted and why it cannot deliver. Leave only the dependent live
  claims `not-proven`, continue independent cases, and do not ask the user to invent the mechanism.
  A separate diagnostic app-server, Root SIGINT or probe-budget cleanup cannot stand in for exact delivery.
  (MOOT for the delivery surface: a supported owning-session interaction WAS established — V2
  `interrupt_agent`, installed-config-enabled, reachable from the Root turn — and was wired instead. The
  Root Status-observation cancellation, which has NO model-facing self-interrupt surface, is recorded as
  exercised at the production wait boundary, instrument-level.)

**Exit:** installed delivery/settlement evidence, or a concrete investigated prerequisite failure. Neither
model prompting nor source existence alone guarantees delivery; no MCP/fork/second engine bypass.

### R5: Bounded follow-up trials and corrected closure

**Files:** Qualification report and this plan; only cause-directed fixes in the listed probe/test files.

- [x] Verify R0–R3 instrument regressions before authenticated work. Re-pin installed binary/version and
  source/observer/artifact provenance; do not assume 0.160.1 is still installed. Preserve all prior outcomes.
  (DONE R5: installed binary re-pinned to **0.161.0** (auto-updated from 0.160.1) 2026-10-08; R0–R4 gates
  re-verified at the working tree (shell-research 292/292 pre-trials; 293/293 after the mid-campaign
  defaults fix); every record carries `provenance.sourceSha` 5026009 and the per-record observer digest.
  Report §1.2.2.)
- [x] Resume original Tasks 4–6 with one corrected trial per unresolved case: unraised Child cap M, raised
  discriminating comparison if needed, fresh comparable repeat, noise, explicit background, Review,
  Adversarial Review, and Status. Include R4 interruption subcases only through its established interaction;
  an investigated missing surface remains a documented dependent limitation, not a fake interrupt run.
  Use one cause-directed follow-up at most per failed/inconclusive case; never retry model nonadherence
  until it disappears. No new statistical or universal-host qualification campaign.
  (DONE R5 — ten trials, each run once (§7.7; final adjudication set by the post-trials review loop):
  the unraised control **QUALIFIED with M bounded-but-imprecise** — the cap-limited return is
  observed (returned to the model with the 420000-ms worker still running, no other ender) but its
  exact duration was not retained; the `decisiveWallMs: 85000` figure is the TERMINAL poll, not M,
  so no numeric cap claim stands. **Propagation POSITIVE-but-M-imprecise** (fresh raised Case B one
  388300-ms observation, zero re-entries, natural completion); the numeric ratio and the
  `115000 ≤ 388169` validity-precondition verification are WITHDRAWN with the unattributable M
  number. **repeat QUALIFIED** (second qualified
  388.3-s run on a distinct Child). `rescue-baseline`, `rescue-noise`, `background` and the R4-wired
  `rescue-interrupt` ended inconclusive before their measurements (unclassified
  `unsupported-call-shape` cells — cause not established, attributed neither to model
  nonadherence nor to host rejection; R0 suppression held; interrupt intent recorded
  `requested: true`/family v2 with delivery null and the explicit missing-prerequisite reason —
  recorded as found, not retried). Root commands produced their first real
  outcomes (§9.4): review-wait host-early-exit; adversarial-review-wait ran through the Root observer but
  renderer markers missing; status-wait fail-closed validation fired. No case was retried out of the record.)
- [x] Use the original case CLI and private `mktemp -d` outputs. For the unraised candidate control omit
  `--cap-ms` (its default is `null`); for cap-matched/candidate cases pass `--cap-ms 3600000` explicitly.
  Keep original hold/budget examples unless the measured current cap requires a recorded adjustment.
  Reuse the Task 4/5/6 command shapes, updating exact binary and fixture source inputs, not historical pins.
  (DONE R5: private `mktemp -d` outputs; M omitted `--cap-ms`; raised cases passed `--cap-ms 3600000`
  explicitly; Task 4/5/6 hold/budget shapes retained — 420000/1200000 foreground, 130000/360000 noise,
  120000/600000 background, 130000/600000 root commands, interrupt 420000/900000, status timeout 120000
  explicit.)
- [x] Respect clean-source provenance without unauthorized commits. The fixture's `--source-sha` installs
  committed source, not working-tree edits; uncommitted observer changes must have an independent digest.
  If fixture changes needed for these cases cannot be exercised through its recorded temporary seams,
  investigate a narrowly owned clean exact staging input or request commit authority. Do not secretly run
  stale committed fixture code and call it the fixed implementation, or commit just to obtain a test tree.
  (DONE R5: fixture installed committed source 5026009; the working-tree observer ran with its independent
  per-record digest (two digests across the campaign — §12.9); no stale-code run, no commit made or needed
  for the fixture path.)
- [x] Update report §§8–12 and the original task boxes. Remove the erroneous Root-observer out-of-scope
  claim; distinguish code omissions/instrument failures from measured host limitations. Update S1–S7 and
  Q1–Q6 rows with actual evidence labels; historical 386.6/387.1-second observations are not a comparable
  fresh repeat or proof of interruption, and 15 → 0 re-entry is not measured token savings.
  (DONE R5 documentation phase: report §1.2.2, §7.7, §9.2 correction, §9.4, §10 register, §11.1–§11.3,
  §12.9 added (old §12.9 → §12.10); §9.2's out-of-scope sentence corrected — Root observer work was in
  scope under Task 6/spec Q5, implemented in R2 and exercised at R5. Instrument defects (the driver
  defaults bug) are separated from measured host limitations and from the unclassified-cell
  inconclusive runs (cause not established; §7.7). The
  historical 0.160.1 observations keep their own scope; no token savings claimed.)
- [x] Run `npm run test:shell-research`, `node --test tests/test-selection.test.mjs`, `npm run lint`,
  `npm run typecheck`, `node scripts/check-line-endings.mjs`, `git diff --check`, and relevant unchanged
  production contract tests. Use Task 7's clean exact-source method for the final routine/marketplace check.
  Record actual failures/skips and exact tested revisions; do not infer live coverage from fixture tests.
  (DONE R5 at the uncommitted working tree: shell-research 293/293 exit 0, selection 6/6, lint, typecheck,
  line endings and `git diff --check` clean. **The final routine/marketplace check had not run at
  that point** — it needs a clean tree (commit authorization or the spec §2 park-and-restore method;
  recorded in §11.3 as an open human decision). Superseded: commit authorization was later granted
  and exercised — the work is committed as `60b9fc5` (message records 442 shell-research tests) and
  the full routine + marketplace suites run in PR #66 CI, fresh-verified 2026-10-10 via `gh` at head
  `60b9fc5`: OPEN, MERGEABLE, 6/6 checks pass (run 37862214745).)
- [x] Independently review the implemented corrections and spec coverage before declaring closure; use
  `code-review`'s separate axes. This plan authorizes that read-only review, not delegation of implementation
  or changes to production. Address findings and deliver an updated handoff for the human adoption decision.
  (CLOSED post-R5: the 30-round plain codex `review` loop over the accumulated R0–R5 working tree
  converged at round 30 with zero findings (all findings in rounds 1–29 fixed test-first, ~61 P2s), plus
  the independent ZCode dual-axis review — spec acceptance ACCEPT / standards ACCEPT / close-out CLOSE.
  The reviewed work is committed as `60b9fc5` and pushed to PR #66.)

**Exit:** the instrument omissions/privacy failure are corrected; each remaining research question has
actual evidence or a precise investigated `not-proven` reason. A positive rollout recommendation still
requires spec §8's discriminator, repeat, linkage, reduced re-entry and native interruption/settlement.
Incomplete evidence never lowers a functional requirement or automatically promotes the candidate.

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
- [x] **REOPENED by completion review — closed by R4 (2026-10-08).** Identify an available native interaction capable of interrupting the exact pending Child turn, and separately the Root Status observation. Establish ownership and target from the same host session. `turn/interrupt` is useful only on a verified connection owning that live target; a separate diagnostic app-server is not the running CLI session. Root SIGINT or probe-budget expiry alone is not exact Child interruption. (R4 outcome: the exact-Child interaction is the owning Root turn's own model-facing V2 `interrupt_agent` tool — installed-config-enabled via the `features.multi_agent_v2` block present in the live config (block authorship not established; the `features list` probe stands either way), registered for a normal exec Root at source pin 67727e7c, targeting the known non-root non-self child in the shared in-process registry; wired into the case prompt and fail-closed recorded. The Root Status observation has no model-facing self-interrupt; its cancellation is exercised at the production wait boundary and provably sends no job stop/cancel. Live delivery measurement remains R5's; §3.3 records the sanitized evidence.)
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
- [x] **REOPENED — R0/R1/R2: unsupported preparation excerpts leak private input; known legal preparation shape is rejected; unavailable parent joins are counted as zero; Root cases lack their own observer. CLOSED by R0/R1/R2 (2026-10-07).** Implement a bounded observer for actual observed call shapes: direct function calls, simple script wrapper calls and linked outer continuation. Use native JSON records and actual tool-reported wall times where available; for unsupported script shape, retain a sanitized decisive excerpt and manually adjudicate only that case. Do not infer invocation from quoted text. Missing or ambiguous records are inconclusive, never a zero decision count. (R0 closed the privacy leak with content-fail-closed suppression (§12.4); R1 made the observed legal preparation shape parse and removed the fabricated zero (§12.5); R2 implemented the Root-family observer contract, exercised live at R5 (§9.4, §12.6).)
- [x] **REOPENED — R0/R1: privacy on parser failures, observer/runtime provenance and poll-start lifetime need correction. CLOSED by R0/R1 (2026-10-07).** Keep a small case record: CLI/source/plugin provenance; requested/actual route and instruction/config variant; exact Child linkage checked; one Companion launch/send checked; original handle linkage checked; outer-return/model-call counts separated from Root joins; decisive wall time and remaining lifetime; original process exit and exact public result checked; native interrupt delivery and settlement or its missing prerequisite; cleanup result. Use null for unknown facts, not false or zero. Retain at most 64 decisive excerpts, each bounded and scrubbed, with truncation explicitly recorded; no large frozen proof schema. (R0 closed content-fail-closed privacy; R1 added the observer provenance block and the monotonic held timeline with measured poll start and hold-deadline-relative remaining lifetime — §§12.4/12.5; the R5 records carry both.)
- [x] **HISTORICAL cleanup actions executed; this does not certify excerpt privacy, which is reopened in R0.** Only after observation completion/settlement, retain the redacted evidence outside credential homes, then clean homes and exact owned processes. A fixture gate timer must still bound work if the model never calls a tool or exits early. Gate release at the experiment deadline is test control, not a production timeout.
- [x] **REOPENED — case labels exist, but R2/R3/R4 must complete Root adjudication, Status prerequisites, background prompt/lifecycle and native interrupt delivery investigation. CLOSED through R4 (2026-10-08).** Implement these closed CLI cases: `rescue-baseline`, `rescue-long`, `rescue-repeat`, `rescue-noise`, `rescue-interrupt`, `review-wait`, `adversarial-review-wait`, `status-wait`, `background`. Shared arguments: `--codex`, `--source-sha`, `--output`, `--worker-duration-ms`, `--cap-ms`, `--poll-ms`, `--budget-ms`. Baseline preserves 30000/60000 plain observation; other foreground cases request the candidate outer/inner policy. Reject unknown cases/options. Background is a short compatibility case, not a second execution adapter. (R2 closed Root adjudication, R3 closed Status prerequisites and the background lifecycle, R4 closed the native interrupt delivery investigation: the case prompt wires the established V2 `interrupt_agent` interaction and the record carries measured delivery/settlement facts or an explicit investigated reason.)
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
the separately recorded unraised cap remains `not-proven` (historical Task 4 wording; R5 later observed
the cap-limited return — M bounded-but-imprecise, report §7.7/§10).

Expected baseline is an observation, not an assumed 31-second return. Record what this actual Child did; cap configuration alone is not improvement proof.

```bash
shell_case_output=$(mktemp -d)
ZCODE_SHELL_WAIT_E2E=1 CODEX_BINARY="$shell_codex_binary" node tools/shell-wait-probe/driver.mjs \
  --case rescue-long --codex "$shell_codex_binary" --source-sha "$shell_source_sha" \
  --output "$shell_case_output" --worker-duration-ms 420000 --cap-ms 3600000 --poll-ms 3600000 --budget-ms 720000
```

- [ ] **PARTIAL (corrected by the post-trials review loop; the earlier R5 closure rested on withdrawn numbers).** Verify actual native Child parent/thread/path linkage and production preparation/binding admission; one Companion launch and one fake session/send; exact original process handle; actual directive/inner yield; terminal exit and byte-for-byte sentinel; no routine progress relay to Root. The cap-discrimination poll must begin with at least measured unraised/default configuration cap + 30000 ms remaining. A short run, gate released too soon or slow model leaving too little lifetime is inconclusive for that claim; an unestablished default cap must not be guessed from an unmatched source snapshot.
  (PARTIAL as of the post-trials review loop's M correction, measured at R5 2026-10-08, installed 0.161.0:
  the linkage pieces are qualified — named route, launch 1/send 1, original handle, terminal exit 0,
  sentinel in linked output (§7.7); but M is bounded-but-imprecise (the 85000 figure is the terminal
  poll, not the cap-return duration), so the cap-discrimination precondition (measured cap + 30000 ms
  remaining) is NOT evaluated and the earlier `85000 + 30000 = 115000 ≤ 388169` verification is
  WITHDRAWN. The discriminator subcase reopens until M is re-measured with the per-poll-timing
  instrument (report §12.8). Report §7.7/§10.)

**R5 verification/discriminator record (corrected by the post-trials review loop — the cap-discrimination
item above is PARTIAL):** Case B fresh and `rescue-repeat` qualify named-route linkage, one
launch/send, original handle, terminal exit and the sentinel; M is bounded-but-imprecise and the
M + 30000 poll-start condition is NOT established (post-trials review-loop correction; §7.7/§10). Case A's
Task 4 completion-linkage limitation remains historical, and its R5 raised re-run also ended
inconclusive (`unsupported-call-shape`, recorded as found). Routine progress-relay absence is still
not established by retained call excerpts.

- [x] Run `rescue-repeat` once with the same candidate flags and a fresh output. Do not retry model nonadherence out of the record. Compare outer re-entry counts over comparable remaining work intervals; separately report Root native child joins. One long held observation has no intervening model return; whole-operation decisions need not be zero. Do not claim token savings without actual token measurements.
  (CLOSED at R5, 2026-10-08: `rescue-repeat` qualified — 388300 ms, 0 outer returns, `rootJoins: 7`, sentinel true, exit 0, on a DISTINCT Child (`01a11857-f6e4-…` vs Case B fresh's `01a11850-998d-…`); the equal wall time is a return-granularity coincidence. Report §7.7.)

**Closed at R5 (repeat):** the Task 4 attempts are retained as historical records (repeat1 instrument
natural-exit verification failure; repeat2 instrument grammar limitation, execution behavior unknown).
The fresh 0.161.0 repeat closes the repeat dimension; no token savings are claimed (no measurements).

- [x] Record named versus generic route as actually selected by the host. If only one route is reachable, retain the other as unavailable/not-proven with structural parity checks. Never force a generic fallback after a recognized Role-value rejection. A positive conclusion is scoped to the observed route; claiming both requires actual evidence for both.
- [x] If the Child cap is ineffective or instructions are not followed, inspect the one concrete configuration/delivery cause established by the trace and perform at most one cause-directed follow-up per failed/inconclusive case. No second engine, generic interpreter, synthetic authority or mutable latest-state lookup. Record Root timing separately; do not relaunch old MCP cases.

**Recorded completion:** Named selected for Cases A/B and Case 0 run3; generic remains installed
`not-proven`, with `fixture-tested` artifact parity (§12), no forced fallback. Case 0 follow-ups addressed
distinct established grammar/terminal-rule causes in `9b2bbcd`, `cede2d8`, `7edb8ad`; all four outcomes
remain in the record. No host-behavior outcome or repeat2 instrument grammar limitation was retried out
of the record; repeat2 execution behavior is unknown and model nonadherence is not established.

**Amendment gates:** selection 6/6, lint/typecheck/diff-check exit 0. The requested one shell-research
run: 173 tests, 169 pass, 4 fail, 0 skipped; all four are sandbox artifacts (two npm-cache `open EPERM`,
two macOS process-inspection `spawn EPERM`), not host-behavior rejection. Report §7.6 records the details.

**Exit (partial):** Q1 configuration propagation and M are `not-proven`; Q2 named candidate behavior is
`installed-observed`; Q3 cadence is `installed-observed` (A 15 outer returns vs B 0), repeat `not-proven`.
Report §7.5 fills the Task 4-owned S1/S2/S3 partial and Q1/Q2/Q3 coverage rows; full Task 7 coverage and
Task 5/6 work remain open. Child completion proves only the current invocation, not automatic production
release. (Historical Task 4 Exit wording; R5 updated the labels: propagation POSITIVE-but-M-imprecise,
M bounded-but-imprecise, repeat QUALIFIED — current adjudication in report §7.7/§10 and the Task 7
mapping.)

## Task 5: Preserve lifecycle, results, placement and Status sidecar semantics

**Files:** Report lifecycle/result/placement sections; new shell instrument regressions if an observed seam needs correction.

- [ ] **OPEN — R5 re-run also inconclusive (§7.7): the R1 grammar fix removed the old preparation blocker, but the run again produced an unclassified 4-line cell (`unsupported-call-shape`, 300 bytes; R0 structural suppression held — no private content). A different shape than the R1-CONFIRMED preparation-grammar gap; whether it is a further parser gap or a departure from the prompted flow is not established from the retained evidence. Recorded as found, not retried.** Run `rescue-noise` with a 130-second harmless hold and candidate observations (`--worker-duration-ms 130000 --cap-ms 3600000 --poll-ms 3600000 --budget-ms 360000`). Use existing conversation/progress output, not a new heartbeat protocol. Check same handle, no replacement Status loop, no ordinary progress relay to Root, and terminal stdout exactly preserved.
- [ ] **OPEN — R5 wired-path runs ended inconclusive before delivery (§7.7): the R4-wired prompt path exists and the retained record shows the intent was requested (`requested: true`, `previousStatus: "running"`, `family: "v2"`) but `attempted`/`delivered`/`settled` are null with the explicit missing-prerequisite reason (evidence collection did not complete; `unsupported-call-shape` unclassified cell, cause not established). Live delivery/settlement remains `not-proven`.** Run `rescue-interrupt` while a long observation is demonstrably pending. The driver uses the native exact-Child interaction identified in Task 1; it must record actual delivery, target, pending interval and settlement. A timer intent without delivery, host early exit, gate completion before the signal or killing the outer probe is inconclusive, not successful interruption. Measure delivery-to-settlement latency and compare with the matched baseline/native expectations; no hidden waiting until the new one-hour cap may be presented as preserved responsiveness.
- [ ] **OPEN — not exercised live in this campaign; inherited production suites recorded (§8.5).** Check existing stop intent, reconciliation, durable winner and no accepted running work left untracked. Keep an unrelated harmless job/Child control live and verify it survives. Host loss and probe-budget cleanup are separately labelled; do not use either as native user-interrupt proof. If no exact native interrupt surface is reachable, document the prerequisite and leave that release dimension not-proven without blocking Root wait measurements.
- [x] **DONE (structural; live steering not reachable this campaign, §8.4).** Preserve exact no-argument Child Status intents: `zcode status`, `$zcode:status`, `/zcode:status`, trimmed only. The sidecar runs at most once per accepted intent, **between polls**, and never authorizes another Rescue execution or replaces terminal stdout. Test the policy structurally; if the native interface permits safe live steering, observe its response opportunity under a long wait. Report delay as a usability limitation, never issue a parallel inner poll to improve responsiveness. Ordinary steering must not become a command.
- [ ] **OPEN — R5 re-run with the R3-corrected prompt/lifecycle ended inconclusive before the background flow (§7.7): `unsupported-call-shape`, budget-cleanup at 600021 ms, Root acknowledgement recorded at 41333 ms but no Child linkage — the record retains an unclassified cell where the prompted invocation was expected; whether this was a further parser gap or a departure from the prompted flow is not established. Recorded as found, not retried.** Run one short `background` compatibility case using explicit Rescue `--background`: Root sends only the existing launched-Child acknowledgement and does not join; the exact Child still observes attached Companion to terminal with the candidate policy. Use current functional tests for small no-flag and complex detached placement, Review/Adversarial enqueue-only, same-child choices and owner-only queries. Do not run every unchanged product contract live merely because it is a release requirement; distinguish inherited contract regression coverage from new installed evidence.
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

- [ ] **OPEN — R5 outcomes recorded, neither qualified (§9.4): review-wait's host ended before the held completion boundary (`endedAtElapsedMs: 14477`) after the observed companion invocation (launch 1, send 0, Root linkage recorded); adversarial-review-wait ran through the Root-family observer end to end (launch 1, send 1, `decisiveWallMs: 98100`, `rootThreadId` recorded) but the narrower renderer-marker check failed — command-rendered result markers missing from the linked terminal output. Two earlier R5 attempts ran no trial (a `--status-query-timeout-ms` mis-issue, correctly rejected fail-closed, and the driver defaults bug, fixed in the working tree — §12.9).** Run `review-wait` and `adversarial-review-wait`, each once with a 130-second fake-ZCode hold and the same candidate policy. Invoke their actual installed Skills/constant Companion commands in Root, with explicit `--wait`; no Rescue Child. Record same process handle, actual outer/inner long observation, decision cadence, exact command's rendered result, exit/error path and owner. A direct Root delay command alone is not command-specific qualification.
- [ ] **OPEN — R5 outcome: the fail-closed statusQuery validation fired (§9.4) — the live session produced no unambiguous reserved-job acknowledgement (`validation.valid: false`, 0 distinct IDs on both extraction sides), so the Status query had no in-session target and the case failed closed instead of guessing; `status: "failed"`. Qualification and the cancellation subcase remain `not-proven`.** Run `status-wait` on one explicitly owned harmless held job with an explicit query timeout. Long shell observation must end promptly when that original Status process times out or the job completes; it must not extend Status's configured deadline. Through the verified native Root interaction, cancel a second Status observation and prove the target job continues with no stop/cancel request caused by ending the wait. This subcase is separately not-proven if native interruption cannot be delivered.
- [x] **DONE (inherited: the command renderer/error contracts are covered by the recorded production suites, §8.5; §9.1 retains only ASSISTANT-REPORTED ARGUMENT_INVALID final-agent-message diagnostics, with invocation, executed arguments and renderer/error-path execution not-proven).** Use short fake-provider cases/unchanged production tests for terminal success, PluginError, needs-choice and background queued output. Do not apply byte-identical Rescue sentinel expectations to Review's different renderer. Do not accidentally reinterpret quiet status-sidecar output as Companion completion.
- [x] **REOPENED — §9.2 identifies a Rescue-shaped instrument defect, not a host failure. CLOSED: R2 implemented the originally in-scope Root-family observation contract (§12.6), the §9.2 out-of-scope sentence is corrected (§9.2), and R5 completed command-specific outcomes — each command ran once through the new contract with its own recorded result (review-wait host-early-exit; adversarial-review-wait renderer-marker miss; status-wait fail-closed validation) and none qualified (§9.4).** If one Root command's native long-wait path fails, record that command's own outcome and inspect its concrete difference from the already observed Root mechanism. One follow-up is allowed; do not declare all commands impossible or all qualified from a single run.

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

- [x] **REOPENED for R5 — CLOSED at the R5 documentation phase (2026-10-08): report §11.1 is the authoritative filled mapping and now carries the R5 evidence labels (propagation POSITIVE-but-M-imprecise and repeat QUALIFIED on 0.161.0 with M bounded-but-imprecise (labels finalized by the post-trials review loop); interrupt delivery, noise/background, Root commands and the generic route `not-proven` with recorded causes).** Fill this coverage mapping with evidence labels and the actual retained command/case links. Do not leave missing evidence silently marked passed:

*(Task 4-era snapshot rows kept for the record; the authoritative current mapping is REPORT §11.1.
Updated in 2026-10-10: production mismatch/one-shot/result/choice/error regression suites were
re-recorded via report §8.5 and the inherited-contract runs are DONE — see the rows below.)*

| Spec item | Task and evidence |
| --- | --- |
| S1 preparation/binding authority | **Partial**: Tasks 1/3/4; Task 4 `installed-observed` Case B production linkage/one launch/send, §12 `fixture-tested` negatives. Production mismatch/one-shot regression coverage re-recorded (report §8.5, inherited contract suites); [report §7.5](../../qualification/rescue-shell-long-wait.md#75-task-4-coverage-partial-report-closure-task-7-mapping) |
| S2 original-handle/outer-cell ownership | **Partial**: Task 4 `installed-observed` Case B exact original handle and settled long observation; §12 `fixture-tested` negatives. Case A completion linkage `not-proven` (instrument); Task 5 open; [report §7.5](../../qualification/rescue-shell-long-wait.md#75-task-4-coverage-partial-report-closure-task-7-mapping) |
| S3 exact public/terminal/control outcomes | **Partial**: Task 4 `installed-observed` Case B terminal/host exit 0 and byte-exact sentinel in linked output; §12 `fixture-tested` sentinel negatives. Task 5 production result/choice/error suites re-recorded (report §8.5); installed Root-command qualification remains `not-proven` (report §9.4/§10); [report §7.5](../../qualification/rescue-shell-long-wait.md#75-task-4-coverage-partial-report-closure-task-7-mapping) |
| S4 placement/background/Status observation-only | 5, 6; one short installed background case and current matrix/Status tests |
| S5 interruption/loss/timeouts/ceiling | 5, 6; actual native delivery separated from controlled tests and cleanup |
| S6 named/generic parity and no fallback weakening | 1, 3, 4; actual route plus structural parity and explicit unavailable labels |
| S7 isolation/no production changes | 2, 3, 7; suite selection, installed-fixture cleanup and final diff |
| Q1 effective Child configuration | Tasks 1/3/4 historical `not-proven` (§7.3, link below); R5: propagation **POSITIVE-but-M-imprecise** and M **BOUNDED-BUT-IMPRECISE** (`installed-observed` 0.161.0, §7.7) — the cap-limited return is observed but its exact duration was not retained, so the numeric discriminator and the M + 30000 precondition remain open pending per-poll re-measurement (report §12.8/§10); [report §7.3 (historical)](../../qualification/rescue-shell-long-wait.md#73-case-0-unraised-child-cap-m-not-established-not-proven) |
| Q2 effective Child instructions | Task 4: **`installed-observed`**, named candidate invocation only; directive-led long request, 0 outer returns vs baseline 15. Generic remains `not-proven`; artifact parity `fixture-tested`; [report §7.1–§7.2](../../qualification/rescue-shell-long-wait.md#71-case-b-qualified-named-route-long-observation-installed-observed) |
| Q3 cadence and repeat | Task 4: **`installed-observed`** A/B outer returns 15/0, Child calls 23/2, Root joins 7/1; Task 4-era repeat attempts `not-proven` (report §7.4, historical, link below); R5 closed **repeat QUALIFIED** (fresh Case B + `rescue-repeat` on distinct Children, both 388.3 s, zero outer re-entries, natural exit, §7.7); [report §7.4 (historical)](../../qualification/rescue-shell-long-wait.md#74-repeat-outcome-not-proven) |
| Q4 noise/native interruption/sidecar latency | 5 |
| Q5 other waiting commands | 6 |
| Q6 version scope and smallest adoption delta | 7 |

- [x] **DONE (report §11.2 — scoped follow-up campaign; research-only delivery, no production rollout recommended: the precise M/discriminator, native interruption/settlement, noise/background, Root commands and the generic route remain not-proven; repeat is qualified and propagation is positive-in-shape but M-imprecise).** Propose a precise minimal adoption delta only for qualified surfaces: configuration location supported by the actual Child/Root trace, compatible instruction form, named/generic synchronization, setup/upgrade guidance, and known version/latency limitations. Do not promote an unseen Role-field propagation path or claim a wrapper pragma is universal. Separate demonstrated improvement from release-blocking compatibility findings and optional human usability evaluation.
- [x] **REOPENED for R5 — CLOSED at the R5 documentation phase: the distinction is recorded throughout (§12.9 separates the driver defaults bug — an instrument defect found and fixed during R5 — from measured host limitations; §7.7/§9.4 record the unclassified-cell runs as evidence-insufficient (inconclusive) — attributed neither to model nonadherence nor to host rejection — while the confirmed parser/instrument gaps are separately labeled (§11.3 grammar limitations; §12.9 driver defaults bug; §12.8 root-side wrapper-cell scan fix); §9.2's erroneous out-of-scope claim is corrected).** If a case remains not-proven, close research with the exact cause and one useful next step; do not lower a requirement, fabricate success or freeze all independent work. Production canonical remains shell with its existing instructions until the human adopts a subsequent change. MCP results remain untouched.
- [x] **DONE (recorded in §11.3/§7.6 and the commit messages; see verification below).** Verify artifact changes proportionately:

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
- [x] **DONE — see the recorded run in §11.3 (clean-source method documented).** For the final routine/marketplace check, use a clean exact source containing the changes **only if commits are separately authorized**, or the existing builder's explicit snapshot inputs/owned isolated clean staging. Do not temporarily hide implementation source needed by the test, commit without authority, or mislabel an old baseline as current verification. Record the exact method and run `npm test` once when appropriate; do not re-enter the previous huge MCP research suite.
- [x] **REOPENED for R5 — CLOSED at the R5 documentation phase — the phase wording is preserved in report §11.3 as a historical record: at that phase R0–R5 work was uncommitted pending commit authorization, backfill reviews were pending, and the clean-tree check awaited commit authorization; ten R5 records plus eight trialless invocation-artifact directories; open human decisions enumerated. Superseded 2026-10-08/10: commit authorization was granted and exercised — the work is committed as `60b9fc5` and pushed to PR #66; the backfill closure ran as the 30-round plain codex `review` loop, converging at round 30 with zero findings, alongside the ZCode dual-axis review (ACCEPT/ACCEPT/CLOSE); PR #66 fresh-verified 2026-10-10 via `gh`: head `60b9fc5`, OPEN, MERGEABLE, 6/6 checks pass (run 37862214745). Current open human decisions: PR merge, the §11.2 campaign, production adoption.** Write a concise execution handoff linking this report/spec/plan, completed task boxes, actual probe commands, unresolved prerequisites and proposed production file scope. Human review decides whether to commission the subsequent production change; do not automatically ship it.

**Exit:** finite completed qualification artifacts, honest evidence coverage and a concrete human decision. No production rollout is implied.

## Planning-session review status

- Spec independent review: `shell_wait_spec_review`, 2026-10-05, no blocking P1/P2 findings; nonblocking Status-sidecar clarification incorporated.
- Plan independent review: separate read-only `shell_wait_plan_review`, 2026-10-05, no blocking P1/P2 findings. Its optional clarification was incorporated: the raised-cap baseline is explicitly a cap-matched current-instruction control, with default-cap/configuration claims recorded separately. Spec terminology was aligned without adding a new experiment or weakening requirements. The same reviewer narrowly rechecked the final changed paragraphs and confirmed no contradictions or blocking findings.
- These 2026-10-05 reviews were pre-execution document reviews, not approval of the current implementation.
- Completion review on 2026-10-07: independent read-only `shell_wait_spec_acceptance_review` and
  `shell_wait_standards_review` found the correction items mapped to R0–R5. Original Tasks 1/3/6/7 boxes
  affected by those findings are reopened; earlier executions and test results remain historical records.
  This amendment has been checked against S1–S7/Q1–Q6 without changing the spec or claiming fixes are done.
- Amendment review: the separate read-only `shell_wait_spec_acceptance_review` rechecked the revised
  plan and temporary handoff and found no blocking document gaps. Its cleanup/privacy checkbox
  clarification is incorporated. This is plan review, not implementation verification.
- Earlier authorization to amend Task 4 was scoped to that historical operation, not continuing commit
  authority. The current request authorizes this plan correction and a temporary handoff only. The next
  agent should execute the research correction after the user delegates it, preserving the three untracked
  scratch files; commit/push/PR/merge and production rollout still require separate authority.
- **Superseded (2026-10-10):** the bullets above are dated phase records. Remediation R0–R5 was
  subsequently executed; the accumulated working tree was committed as `60b9fc5` with user commit
  authorization and pushed to PR #66, and the review closures are recorded in the report §11.3 Current
  closure status. An agent reading this plan should NOT re-execute the R0–R5 remediation; the remaining
  human decisions are PR merge, the report §11.2 follow-up campaign, and any production adoption.
