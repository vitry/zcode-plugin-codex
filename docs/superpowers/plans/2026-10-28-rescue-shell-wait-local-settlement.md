# Real Companion Observation and Native Settlement Acceptance Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:executing-plans` or the agreed subagent-driven workflow. Execute task by task; independently review the executable instrument before live use and the final branch afterward. Checkboxes describe execution, never production release permission.

**Goal:** Make the real managed-Rescue Companion's local identity and exit observable, enforce the missing-observer gates, then obtain native interruption plus all applicable owned/no-collateral settlement evidence under the existing spec.

**Architecture:** Reuse the merged bounded-name recognizer, real installed preparation/spawn/launcher/binding path and existing durable readers. Add only fixture-owned observation of the actual Companion process, compose local evidence with independent native/remote/durable/control evidence, and run one gated real-host acceptance case plus at most one cause-directed follow-up. Preserve previously proven long-wait, cadence and exact-output results for their measured cohort.

**Tech Stack:** Node.js ESM/`node:test`; fixture-generated preload or another demonstrated local read-side seam; exact process identity; the existing shell-research driver and opt-in installed-host fixture.

---

## 1. Authority, starting point and the evidence to carry

- The user requested this new plan and independent subagent review after merging PR #73. **The present task is planning/review only:** no implementation, hosted run, commit, push, PR or merge. A later execution delegation activates the tasks and the finite live ledger in §4; publication follows that delegation, never this document alone.
- Unchanged spec: [2026-10-05 Rescue shell long-wait design](../specs/2026-10-05-rescue-shell-long-wait-design.md), S1–S7, Q1–Q6 and §8. No functional goal, exact binding, private preparation, lifecycle, output, placement or privacy requirement is reduced.
- Fresh main/base: `a8f54d06f640777d539e8b6b44bb23dc924bec5f`, merge of [PR #73](https://github.com/vitry/zcode-plugin-codex/pull/73), obtained with `git pull --ff-only origin main`.
- Branch/worktree: `docs/rescue-shell-wait-local-settlement`, `.worktrees/rescue-shell-wait-local-settlement`. Preserve unrelated files, scratch and other worktrees. Do not amend/rebase merged history.
- Required reading: [2026-10-26 native-acceptance plan](2026-10-26-rescue-shell-wait-native-acceptance.md); [qualification report](../../qualification/rescue-shell-long-wait.md) §16.2/§16.4–§16.5, §19.3–§19.6/§19.9, §23.12 and §24, including the post-spec-review corrections. Earlier I/F and N/C ledgers remain CLOSED; unused old C is not new authorization.

| Carried conclusion | Boundary / remaining work |
| --- | --- |
| Actual managed-Child long observation and repeat, reduced 7→1 re-entry, exact public output | Already proven on the recorded CLI 0.163.0 cohort; reuse when pins compose. This ledger contains no new long-duration/repeat/cadence campaign. |
| Request, host acknowledgement and Child resolution are distinct | Reuse the prospective causal contract; acknowledgement-at-resolution is not itself failure or proof of pending dispatch. Complete call scan, exact identity and independently attributable native resolution still matter. |
| Bounded non-`r` wrapper family is implemented and offline-tested | Reuse it, including the literal decoder, full-body/directive guards, equal sink and negative family. It does not identify the lost historical F/I/N bodies retroactively. |
| Old N is unqualified | It observed a request inside the pending window, but scan completeness/control were unestablished and real Companion local exit was unobservable. Its later SessionEnd settlement remains its own recorded cause. |
| Old N's preflight deviation is acknowledged | This plan must enforce the missing-local-observer gate in the actual launch path. A report saying an applicable layer is unknown cannot be a replacement for that gate. |
| Production remains `do-not-adopt-yet` | This is qualification work only. Review/Adversarial/Status/background/shared-default compatibility and actual deployment remain separately scoped. |

Historical wrapper bodies are unrecoverable; digest fingerprints do not restore them. The old report's statements that real-body unredaction is the sole path, that no synthetic grounding exists, or that declining unredaction leaves no bounded option are **superseded for this plan**, including the old step-1/step-4 wording left alongside its correction. Continue authorized synthetic/fixture-controlled investigations without promising they match historical bytes. A proposal to collect future raw bodies is not mandatory for this plan: prefer in-memory analysis and bounded content-free structural facts; no new permission to persist preparation, credentials, tasks or complete private rollouts is granted here.

## 2. File responsibilities and change boundary

| Path | Responsibility |
| --- | --- |
| `tools/shell-wait-probe/local-process-observation.mjs` (new if needed) | Focused fixture observer: generated capture source, strict process-evidence admission and bounded local-duty verdict; no product stop authority |
| `tools/shell-wait-probe/fixture.mjs` | Arm the isolated observation seam, compose its environment and record declaration/provenance; keep product artifacts unmodified |
| `tools/shell-wait-probe/closure-observation.mjs` | Reuse or minimally extend the existing exact-entry preload/identity capture seam if the feasibility trace supports it; stdout capture contract remains intact |
| `tools/shell-wait-probe/driver.mjs` | Actual launch preflight, runtime readiness, concurrent local observation, persistence/fences and complete acceptance join |
| `tools/shell-wait-probe/release-qualification.mjs` | Compose the required local-duty fact with existing native/remote/durable/control requirements, with honest versioning |
| `tools/shell-wait-probe/evidence.mjs`, `shape-diagnostic.mjs` | Only a demonstrated bounded attribution defect; no speculative grammar expansion or generic interpreter |
| `tests/shell-wait-local-process.test.mjs` (new) | Focused deterministic offline admission tests and harmless real local-process controls, no Codex/provider launch |
| `tests/shell-wait-native-interruption.test.mjs`, `tests/shell-wait-probe.test.mjs` | Narrow actual pipeline integration and inherited regression coverage |
| `tools/run-test-suite.mjs`, `tests/test-selection.test.mjs` | Register the new test as shell-research only; maintain complete/disjoint selection and guarded self-test totals |
| This plan; `docs/qualification/rescue-shell-long-wait.md` | Preregistration, finite ledger, observed results, requirement map and exact next action |

**Read-only:** all specs; `scripts/`, `skills/`, `agents/`, `hooks/`, `.codex-plugin/`, `prompts/`, `schemas/`, `marketplace/`, dependency manifests/locks, active user configuration/caches/data and local Codex source. No product lifecycle repair, fake SessionEnd, direct state mutation, new cancellation authority, replacement Companion/Child, MCP route or custom host build. Existing operation timeouts and the 100-hour safety ceiling remain unchanged.

The new helper/test entry provide a focused boundary instead of another unrelated rewrite of the large driver. If an existing helper suffices, document that decision and omit the unnecessary helper. All executing new observer/preload bytes must enter the executing-source provenance; record-time rereads must detect source drift. New tests remain outside routine and MCP suites, even when executed through nested suite self-tests.

## Task 1: Establish the actual process target and a feasible local observation contract

**Read:** `skills/rescue/launcher.mjs`, `scripts/zcode-companion.mjs`, production foreground/lifecycle/runner/recovery paths, `fixture.mjs`, `closure-observation.mjs`, `runHeldHostTurn`, the identity helpers, preflight and Gate-D join/oracle. **Write:** a compact dated preregistration in the report. No hosted run.

- [ ] Re-pin base/tree and the selected installed executable realpath/hash/version, requested/effective model, configuration, installed artifact and Role/instruction provenance. Prefer the previously measured 0.163.0 binary if available and supported. A different binary needs an explicit evidence-applicability statement, not automatic reuse or another long-wait trial. Record supported-model discovery without treating a requested model as observed metadata.
- [ ] Trace what the attached foreground **Companion process actually is**: launcher entry, in-process dispatch, any shell/transport/runner/fake-peer descendants and their ownership. Source starting fact at this base: `skills/rescue/launcher.mjs` imports `runCompanionCli` and dispatches it in-process; a different JavaScript module does not by itself imply another OS process. The existing fake-peer marker or a verified host/peer PID does not prove the real Companion's identity. Produce an exact mapping from selected Child/initial launcher invocation to process and, where applicable, job/executor/generation. Do not use a command-name search or arbitrary ambient process enumeration.
- [ ] Investigate the existing **fixture-only preload seam first**, without requiring its success: `fixture.mjs` composes `NODE_OPTIONS` for a disposable fixture; `closurePreloadSource` already gates on installed launcher realpath, exact `invoke-prepared rescue` argv and a private nonce, and registers exit bookkeeping. This is a concrete candidate for early identity/exit metadata without changing canonical code or a host binary. Determine propagation and process selection with local harmless controls. Do not repeat the unproved assertion that every Companion-side marker requires patching the host. If this candidate is unavailable, investigate another existing exact local read-side seam and record why each candidate fails.
- [ ] Freeze a minimal process-evidence contract: real Companion role and exact invocation binding; per-invocation nonce; positive startup capture; PID plus OS start identity and any justified ancestry/generation link; local observation timestamps/clock; exit/absence evidence; applicability; integrity; causal/measurement/cleanup origin. Keep raw paths/nonce private, persist only necessary bounded/redacted facts. A process is not proven gone merely because its parent changed, its nonce read failed, permission was denied or a reused PID differs. Distinguish confirmed death of the **previously established generation** from observation failure; do not equate a missing startup marker with “never launched.”
- [ ] Determine which local duties apply on the actual path: the invocation process, any positively identified surviving descendants, marked runner claims and the separate writable guard/binding/remote duties. No unnecessary full-machine process-tree requirement; no applicable descendant silently ignored. Reparenting does not destroy an already captured child's independent start identity. `not-applicable` requires production-path evidence; unknown is neither not-applicable nor settled.
- [ ] Trace actual native-interrupt and downstream lifecycle authority, including epoch/receipt provenance when a genuine production SessionEnd occurs. Native cell response requires its own exact call/pending/resolution proof. A later SessionEnd is never relabeled as the earlier interrupt or inferred causally from timing alone. If a supported exact receipt/epoch chain establishes a real downstream stop authority, report that authority and settlement separately with their actual provenance; unrelated/unknown-origin SessionEnd, gate release or harness cleanup cannot backfill native proof. Preserve natural success and safe unresolved guard retention without fabricating cancellation.
- [ ] Freeze the complete observation schedule: actual worker start/lifetime, expected lawful finish, readiness cutoff/control lifetime, local and durable sampling cadence/limits, measurement cutoff, teardown and emergency-cleanup endpoint. Start from cap/poll 3600000 ms, worker duration 420000 ms and total case budget at most 1200000 ms. Retain the registered native-response comparison of 60000 ms when causal admission applies; it is not a production timeout. Keep durable-read limits (at least 1000-ms cadence, at most 600 attempts/32 summaries); explicitly bound additional local reads on the same case deadline. Reserve a real pre-cutoff collection window after an in-budget lawful finish, rather than assuming worker startup equals initial detection.
- [ ] Record the supported schema/platform and failure labels, all applicability decisions and the selected seam **before implementation**. Unknown external mechanisms remain executable investigation tasks. If no supported local seam exists, finish independent offline work and close this plan observer-blocked with no live launch; no demand for the user to invent the mechanism.

**Exit:** a source-backed actual-target map and falsifiable observation contract, or a precise blocked seam. A feasibility claim is fixture-tested, not installed-observed.

## Task 2: Implement exact local observation and prove non-interference offline

**Files:** local observer, fixture/preload wiring and focused local-process tests; report registration. No Codex/provider launch.

- [ ] Write RED tests against the Task-1 contract, including the original missing-real-Companion observation shape. If using preload, test the generated source in real harmless local Node processes through the selected entry/argv gate; an invented metadata object alone does not validate capture. Then implement the smallest observer and confirm GREEN. Freeze newly owned helper interfaces from the researched contract; no guessed host API is a mandatory dependency.
- [ ] Capture identity at invocation startup, before possible disappearance; distinguish initial start marker, OS-verified live observation and exit observation. A normal exit record can corroborate identity/outcome but cannot cover uncatchable termination. Support conservative generation-specific disappearance admission where the OS seam proves it; missing/invalid/foreign/torn records, failed liveness reads or absent baseline remain unestablished. A marker written by one process must not attest to another merely because they inherited a nonce.
- [ ] Test natural exit, explicit business exit/error, abrupt termination of **test-owned** local controls, missed exit callback, delayed capture, invalid/missing marker, concurrent invocation, reused PID/start identity, changed/reparented ancestor, wrong entry/argv/nonce, truncated/torn/foreign metadata and permission/read failure. Cover any applicable descendants separately. Synthetic process identities must always inject fake inspection/termination seams; tests must never signal a synthetic PID in the real OS.
- [ ] Prove observer non-interference: exact public stdout/stderr/exit semantics, unchanged private preparation and result ownership, no product-store writes/locks/chmod/stop intent, no signal handler or child process that changes lifecycle, and no unbounded timer keeping the process alive. Observer write failure becomes a named missing-observation fact, never a replacement business result. Fixture-only bounded files are private and outside product storage, with safe path/size/ownership validation and disposal.
- [ ] Register `tests/shell-wait-local-process.test.mjs` in shell-research only and update selection/guarded-entry tests. Test entries import no other test entry; imports launch nothing. Keep new offline tests fast through fake clocks where appropriate; preserve at least the necessary real-process controls. Do not silently skip research entries to shorten nested suite self-tests.
- [ ] Add all executing helper/generated-preload bytes to observer provenance. Test helper drift detection and record actual source hashes; old N's digest remains historical. Preserve the old stdout-capture schema, or version an actual change and test compatibility explicitly.

```bash
node --test tests/shell-wait-local-process.test.mjs
node --test tests/test-selection.test.mjs
npm run lint
npm run typecheck
git diff --check
```

**Exit:** the actual selected local process can be observed through the real fixture integration on harmless controls, with uncertainty and non-interference tested. No native-host qualification is claimed.

## Task 3: Wire mandatory gates and the complete persisted acceptance path

**Files:** driver, qualifier, fixture, focused integration tests and report. No hosted run.

- [ ] Wire the new seam through `createShellWaitFixture` → `evaluateLiveLaunchPreflight` → real executor/`runHeldHostTurn` → serializer/reload → `nativeInterruptionGateDInput` → final acceptance. Test this complete path on success, early failure, abort and cleanup, including both supported linkage and independently recovered partial facts. Export-only helpers and fixture declaration booleans do not prove runtime wiring.
- [ ] Enforce a **pre-host** capability gate: required observer source/artifact/env/selection and its offline proof must be present for every applicable mandatory layer. A known missing real-Companion mechanism refuses before invoking the host/provider. Separately enforce **runtime** evidence gates: actual identity, pending state, model obedience and captured exit cannot be known before startup; failure to establish them prevents qualification and is never guessed by preflight. Add tests asserting launch-call count zero for each known-missing mechanism and qualified false for each missing runtime proof.
- [ ] Arm concurrent exact local observation early enough to see the real Companion alive before interruption, without an extra Child poll or taking over its handle. Persist independent local duty facts and timestamps before disposal. Test that the actual capture admission receives the runtime declaration/nonce/identity, not a fake-peer identity or stale cached result; extra same-nonce processes do not qualify.
- [ ] Compose all applicable duties into final acceptance. A record with native response, remote terminal result and durable settled state but **applicable local cleanup unknown or still live** must not qualify; neither sample fallback nor another identity branch may bypass it. Exercise this original false-positive shape, then paired observed-clean/local-not-applicable controls. Applicability itself unknown refuses. Preserve old adjudications by explicit versioning; new trials may not omit the new required block to fall back to a permissive legacy contract. Keep local process exit independent of remote winner, writable exclusion and control survival.
- [ ] Preserve exact Root/Child/job/executor/generation joining, full call coverage and the measured request/acknowledgement/resolution contract. Unknown cells keep incomplete-scan refusal; the bounded-name family is forward recognition, not authority to infer lost historical content. Do not expand grammar in response to an unknown live cell without its own bounded offline demonstration and negative family.
- [ ] Test both fences end to end: each observation must complete strictly before the registered measurement cutoff and any earlier termination-initiation boundary. Equality, post-cutoff refresh, post-cleanup death, missing timestamps, torn/foreign origin or incompatible clocks get no credit. Normal observation teardown is not a termination boundary. Pre-cutoff facts joined later retain their qualified source, while later gate release/SessionEnd/cleanup cannot replace a missing fact.
- [ ] Keep unrelated control proof independent: exact Root-owned control handle, active at request and new emission afterward or positively proven natural completion afterward. Buffered old output, completion-before-request, missing reads/handle, hidden extra calls and collateral interruption refuse. No Status substitution, replacement process, second pending inner poll or private-preparation input change.
- [ ] Independently review the executable observer, preflight/runtime distinction, all-duty join, timing/fences, privacy and cleanup **before any live launch**. A reviewer must challenge an apparent synthetic success with each missing-layer counterexample. Resolve blocking findings and rerun the relevant offline checks; freeze readiness/commands only on those reviewed bytes.

```bash
node --test tests/shell-wait-local-process.test.mjs
node --test tests/test-selection.test.mjs
npm run test:shell-research
npm run lint
npm run typecheck
git diff --check
```

**Exit:** actual-path observation and fail-closed launch/acceptance gates are tested for every applicable mandatory layer. If a layer is known impossible, live work is blocked here; complete independent tasks and report the exact mechanism and proposed bounded next action. Do not repeat N's known-unobservable launch deviation.

## 4. Finite live ledger: Task 4

**Files:** dated report preregistration, this ledger and private fixture-owned case records. No old ledger is reopened.

| Label in this plan only | Maximum hosted cases | Dependency |
| --- | --- | --- |
| V | 1 | Main native/owned/no-collateral verification after Tasks 1–3 and independent pre-live review |
| V-fix | 1 total, conditional | One demonstrated bounded cause and tested correction/supported choreography change after V; no unrelated bundle |

- [ ] Before V, freeze actual binary/hash/version, requested/effective model, installed committed fixture source and instruction/config/artifact pins, executing observer/contract versions, exact parser-validated command and the Task-1 schedule. Record the entire command as implemented, not guessed flags. The merged invocation surface starts from:

```bash
ZCODE_SHELL_WAIT_E2E=1 node tools/shell-wait-probe/driver.mjs \
  --case rescue-interrupt \
  --codex "$LOCAL_SETTLEMENT_CODEX_BINARY" \
  --source-sha "$LOCAL_SETTLEMENT_PLUGIN_SHA" \
  --output "$LOCAL_SETTLEMENT_PRIVATE_OUTPUT" \
  --model "$LOCAL_SETTLEMENT_MODEL" \
  --worker-duration-ms 420000 --poll-ms 3600000 --budget-ms 1200000 \
  --cap-ms 3600000 --wait-policy config-default --exec-default-ms 3600000 \
  --unclassified-structural-diagnostic 1 --unclassified-shape-diagnostic 1 \
  --survival-control-selector progress-terminal
```

  Resolve the four variables to the preregistered absolute native executable, committed installed-fixture SHA, private output directory (0700) and supported model. If research implementation introduces a local-observer selector, publish its tested exact command before launch. The example neither bypasses the mandatory local gates nor edits user configuration. Parse the final command offline first. New case duration/control changes must already be within Task 1's frozen bounds.
- [ ] Count every real hosted/provider launch, including initialization/auth/provider errors, refusal after host startup, missing Rescue calls, unsupported shapes or model nonadherence. Pure offline rejection before host contact spends no hosted slot. No hidden warm-up/debug launches, new long/repeat trials, model shopping or auto-update reset. Use only the harmless fake-ZCode fixture action, never writable provider work in user projects.
- [ ] Execute V once. Capture bounded per-layer facts before disposal: exact startup/presence/absence/exit identities, original-handle pending and request/acknowledgement/native-resolution ordering, observed latency or conservative bound, real stop causes and receipt provenance, local/durable/control timelines, measurement/cleanup fences and any unknowns. Analyze unsupported calls in memory and retain allowed content-free facts. Historical raw bodies remain unavailable; collecting private raw preparation/auth/task bodies is not a prerequisite or an authority granted by this plan.
- [ ] Adjudicate V with three separate answers: native responsiveness; ALL applicable local/remote/durable/guard/no-collateral duties; applicability to the measured configuration/version. A responsive Child with an unobserved/live applicable Companion or unresolved guard is not full acceptance. No product failure is inferred solely from an observer gap; no unknown becomes zero or not-applicable. Keep legitimate natural completion and real downstream stop-authority causes separate.
- [ ] V-fix is eligible only after a concrete causal diagnosis and offline RED→GREEN correction or tested supported choreography change. Register the one named change, expected discriminating result, complete negative family and versioning; independently review changed bytes before launch. A new unclassified shape alone or retrying model obedience is not enough; a demonstrated bounded parser, identity, collection or fence defect can qualify without recovering historical raw text. Do not weaken acceptance or force a terminal result to spend the slot.
- [ ] If V passes, leave V-fix unused as `not-needed`. If no bounded correction exists or a product repair outside research authority is required, record the precise reason and leave it unused. After V-fix or justified non-use, stop hosted work. The ledger remains bounded even when a case fails; any further hosted case requires new user authority. Completion is evidence-complete or precisely blocked, not a promised positive result.

## Task 5: Final verification, independent review and production decision

**Files:** report/plan and authorized research implementation/tests only. No production enablement.

- [ ] Append one concise dated result section: prospective local-duty contract, actual target mapping, source/fixture/installed labels, V/V-fix ledger, per-layer evidence and causal origins, version/pin applicability, omitted data and blocked mechanisms. Preserve old N/F/I verdicts. Explicitly supersede stale historical “no synthetic route” conclusions wherever the new decision cites them; avoid contradictory effective instructions.
- [ ] Map S1/S6 binding/preparation/named/generic/same-Child authority, S2 original handle/empty observation/no duplicate poll, S3 exact output/choice/error, S4 placement/background/Status observation-only, S5 interruption/owned/no-collateral/timeout/100-hour semantics and S7 isolation/prohibited paths to inherited contract tests versus newly observed facts. Carry Q1–Q3/Q6 cohort limits, update Q4 from this ledger, and keep Q5 command-specific coverage separate. Existing successes are reused, not extrapolated across unproved binary/configuration changes.
- [ ] Run final verification on final executable/test bytes, record actual counts/skips/exits and retain failures. The complete shell-research suite now includes nested selection self-tests and is slower than its focused entries; run it once after convergence rather than repeatedly for docs-only records. No forced skips, fake timer results or lucky-path selection for green.

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
git diff a8f54d06f640777d539e8b6b44bb23dc924bec5f --stat -- scripts/ hooks/ skills/ agents/ .codex-plugin/ prompts/ schemas/ marketplace/ docs/superpowers/specs/ package.json npm-shrinkwrap.json
npm test
```

  The prohibited-path diff must be EMPTY. For clean-tree packaging use an exact clean verification source with `.git` and a real `node_modules`, preserving unrelated scratch, or matching final-source CI that demonstrably runs the full `npm test`. Keep actual local packaging/cwd/environment failures failed and diagnose read-only; matching CI may supply independent green evidence without erasing them. Old-source CI, research-only tests and reviewer agreement are not substitutes. Docs-only close-out may follow tested code with implementation-byte equality; later code/test changes need applicable fresh checks.
- [ ] Obtain independent final Spec/authority and implementation/evidence/privacy reviews on the actual final revision; record real findings and narrow rechecks. No completed-review checkbox while review is pending. Local commits/publication follow the later execution delegation; this drafting task makes none.
- [ ] Deliver an explicit decision. **Acceptance-proven** requires attributable native response and ALL applicable local/owned/no-collateral duties on an actual managed Child, with the carried long/cadence/stdout cohort applicable. If proven, state measured scope and the smallest separately authorized production integration/remaining command compatibility work; do not enable Skills/config or create a separately released `rescue-long` island. If **observer-blocked**, name the missing exact read-side fact and a researched bounded next action. If **production-defect-observed**, give the exact-path reproduction and bounded repair proposal requiring separate production authority. Do not call another generic long-wait feasibility campaign the next step.

**Completion:** the finite delegated qualification is executed or precisely blocked, verification/review status is accurate, and the next production or repair action is concrete. Research completion is not production rollout.

## 5. Drafting checks and plan review

This section concerns drafting/review only. All execution checkboxes remain open at handoff; no hosted case is spent by a planning check.

- Fresh base and merge verified: `a8f54d06f640777d539e8b6b44bb23dc924bec5f`; PR #73 reports `MERGED`. `.worktrees` is ignored; the new worktree started at that exact main revision. Root scratch and other worktrees were preserved.
- `npm ci --ignore-scripts` completed; dependency files stayed unchanged. Its audit output reported 4 moderate/5 high advisories; this plan made no dependency change.
- Fresh drafting baseline: selection **6/6** and the bounded-name/native negative-family targeted baseline **8/8**, zero failures/skips, exit 0. Tracked LF check: **545 files**, exit 0; `git diff --check`, exit 0. No complete shell-research or full `npm test` rerun is claimed for this documentation-only drafting task; Task 5 requires final executable-byte verification during execution.
- Main self-review mapped unchanged S1–S7/Q1–Q6; verified the actual launcher in-process dispatch and fixture preload starting references; checked both launch/runtime gates, legacy bypass prevention, per-duty/cause/fence separation, scope/privacy and finite ledger. Unknown external mechanisms remain investigation tasks, not invented prerequisites.
- Independent read-only plan reviews completed: `closure_spec_review` (Spec/authority/functional coverage) **CLEAR**, and `closure_standards_review` (executability/identity/evidence safety) **CLEAR**, no blocking P1/P2. Neither reviewer changed files, launched a host/provider or ran a live case. These verdicts assess the plan, not the feasibility of an as-yet unimplemented observer or production acceptance.
- Draft checks: all **33** execution checkboxes open; LF/final newline/no trailing whitespace; no unresolved placeholders; all **3** local document links resolve. The full existing CLI template parsed with harmless stand-in values against `parseShellWaitArguments` without executing the CLI. Prohibited-path diff is empty. Only this plan file is new; no spec, production, implementation or dependency byte changed. No commit, push or PR was performed.
