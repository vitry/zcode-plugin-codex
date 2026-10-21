# Shell-Wait Output and Native Settlement Evidence Closure Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` after execution delegation, or the already agreed subagent-driven workflow. Independently review instrument/evidence/privacy changes before live use and review final exact bytes afterward. Checkboxes mean completed work, not production approval.

**Goal:** Close the remaining exact-output and native-interruption/owned-settlement evidence gaps under the unchanged spec, retaining the already proven long-wait and reduced-re-entry results rather than reopening their feasibility.

**Architecture:** Add only narrowly bounded research observation seams to the existing isolated installed-plugin fixture. Observe the actual launcher stdout independently of the merged terminal transcript, bind native delivery to the exact pending Child through supported host evidence, and read the actual production job/binding/cleanup obligations without creating stop authority. Keep observation, native settlement, natural completion and harness disposal separate.

**Tech Stack:** Node.js ESM and `node:test`; existing shell-research driver/fixture/evidence/oracles; production launcher/formatters/state contracts read-only; pinned installed Codex CLI and local Codex source.

---

## 1. Authority, baseline and what this plan is NOT

- Same [2026-10-05 spec](../specs/2026-10-05-rescue-shell-long-wait-design.md), S1–S7/Q1–Q6 and §8, unchanged. The user approved preparing this follow-up after merging PR #70. No new spec, lower gate, MCP reopening or new shell engine.
- Start from merged PR [#70](https://github.com/vitry/zcode-plugin-codex/pull/70), `0b522b70b0ed72d7d1566de581dc306c70b38fac`. Worktree `.worktrees/rescue-shell-wait-evidence-closure`, branch `docs/rescue-shell-wait-evidence-closure`; main synchronized first. Preserve parent/other-worktree scratch.
- Read [report](../../qualification/rescue-shell-long-wait.md) §§16–18, especially §§16.2–16.5, 17.8, 17.10–17.14 and 18.3a–18.7, plus the [previous plan](2026-10-18-rescue-shell-wait-release-qualification.md). Old execution quotas are spent, never reset by merging a PR.
- Source checkout: `/Users/zhangzikai/Workspace/Codes/github/codex` (`../../../codex` from this worktree), NOT plugin `.codex`. Draft pin: clean `dffa0deb69268ed4ac31578794c9ea897b336ae3`; CLI `0.163.0`. Re-pin before execution, no source/binary correspondence inferred. Read only; no source fetch/build/patch.

**Current authority is plan drafting/review only.** Separately delegated execution authorizes the bounded research work described here, not production code/config/Skill/Role/cache edits, provider/project work, commit/push/PR/merge or rollout. Do not commit to satisfy clean-tree verification. Production defects require separate implementation authority; uncertainty about supported observation mechanisms is an execution investigation task, not a demand for the user to design host APIs.

### Retained successes — do not investigate these again

| Established result | What remains valid / limit |
| --- | --- |
| Actual managed named Child, CLI 0.163.0: M measured from its own nonterminal poll = 300004 ms | Historical measured reference on that exact pin, not a source default or guarantee for an updated host |
| L and fresh R: one natural original-handle observation each, 388400 ms; remaining at poll start 388336 / 388313, each ≥ M+30000 | Long waiting and its fresh repeat ARE demonstrated; exact stdout linkage was not established |
| Comparable canonical 60000 control: 7 observations; candidate L/R: 1 each | Reduced observation re-entry demonstrated; no percentage token savings or whole-job zero-decision claim |
| Outer-default C0/C1 v2, no decisive pragma | Effect already observed; no new 30000/240000 mechanism pair |
| PR #70 final implementation full suite at b4f3db9, report §18.3a | Historical exact-byte gate, not a substitute for tests after NEW implementation changes |

This plan does not repeat M, B, C0/C1, generic reachability or the whole compatibility campaign. New long natural runs, if needed, are **output/linkage corroborations** using a repaired instrument, not another inquiry into whether long waiting exists. No retrospective claim of exact stdout can be made from an old merged stream.

### Remaining scope and honest finish line

1. Gate B: capture attributable complete launcher stdout + exit and compare with the actual production framing, linked to the existing original-handle observation and exact job.
2. Gate D: establish exact native target/pending delivery, responsive turn/cell settlement, the attached Companion outcome, actual durable job/guard/executor obligations and unrelated-control survival.
3. Carry unchanged qualifications/limits forward: BG live placement remains unproven; Review no-send remains separate production scope; AR/ST are prior single-run compatible; generic remains structurally unavailable. This plan does NOT silently qualify them. The host-global numeric default still has no supported Role-scoped override. Even closure of B/D is not blanket shared-default deployment permission.

## 2. Known seams and investigation leads

### Output: observe the real writer, not a reconstruction

- `scripts/zcode-companion.mjs:2720–2774` calls `formatDirectInvocationSuccess/Error`, writes stdout and progress stderr separately. `scripts/lib/direct-invocation-result.mjs` is the transport-neutral stdout/stderr/exit contract; `render.mjs` remains authoritative for framing. Success includes the derived resumability indicator; an unknown indicator yields no complete expected output, not a partial expectation.
- `skills/rescue/launcher.mjs` accepts BOTH private preparation and terminal invocation. Any passive tap must select the exact installed realpath AND `['invoke-prepared','rescue']` argv for the declared invocation. **Never record all launcher stdout**, `prepare`, stdin, fd3, invocation envelopes, environment, auth, other Node processes or the fake ZCode protocol as the Companion result.
- First investigate an existing supported split-stream capture. A fixture-only Node preload is a possible passive fallback, NOT an established solution: admit it only after offline tests prove exact invocation scoping, stream-write callback/encoding/backpressure/error behavior, complete bytes, correct exit and no change of the production entrypoint/argv, original handle or business flow. No tee wrapper, replacement launcher, renderer patch or extra Companion launch to manufacture an attributable stdout.
- Fixture-only environment propagation to the actual Child is itself to be verified. A preload must be inert in every unrelated/preparation/worker process and absent outside the disposable fixture. Record its bytes/configuration and any timing impact; do not call an instrumented measurement an unmodified installed artifact.

### Native target: a stronger supported-source lead than widening a regex

- At `dffa0deb`, `core/src/tools/handlers/multi_agents_v2/interrupt_agent.rs:45–77` resolves the target, dispatches the interrupt, then emits a `SubAgentActivityItem` containing the call id, `agent_thread_id`, `agent_path`, kind `Interrupted`. `multi_agents_v2.rs:44–52` emits started/completed items. Protocol definitions: `protocol/src/items.rs:368–375`, `protocol/src/protocol.rs:4502–4524` (event time where present).
- Investigate whether the installed CLI rollout/output actually retains this HOST-generated item/event, and whether its identity/call/turn/timing can be joined to the actual spawn acknowledgement. Source presence is not an installed observation or a mandatory API. An alias may be compared/resolved in memory using authoritative host evidence; persist only the closed match/source facts and safe identifiers/digests, never arbitrary target text. Do not relabel caller-supplied text as authoritative.
- Existing `extractInterruptInteraction`, `interruptDeliveryAttributionGuard`, `waitForPollObservation`, `waitForChildSettlementObservation` and cleanup-boundary logic remain the starting implementation. Preserve exact session/call/cell/statement ownership, reject explicit tool termination as native credit, and retain actual pending-window evidence. The survival control's ~80-second clock floor is coordination ONLY; Root can never operate Child-owned handles, and a clock floor is not a pending acknowledgment.
- Unknown cells may be classified transiently in memory in fixture-owned retained data, retaining only fixed structural facts. Locate a real missing finite form before adding a whitelist; do not infer the lost historical cell from its byte count. No general JS interpreter, arbitrary AST evaluator or raw-body retention. Directives must still be validated on raw input; a strip-first fallback remains forbidden.

### Durable obligations: a reader is still missing

- Current `driver.mjs` settlement layers have `durableObligations: null`; parser fixes do not implement a job/guard reader. Trace `scripts/lib/state.mjs`, `rescue-binding.mjs`, `rescue-lifecycle.mjs`, `rescue-child-reconciliation.mjs`, `job-control.mjs`, `recovery.mjs` and hook state for the actual obligations on THIS attached path.
- An API called `readJob` is not automatically passive: `createStateStore().readJob` resolves `jobStorage` and takes a lock; workspace resolution can create/chmod directories. Prefer existing bounded, validated reads on a pre-existing layout, without calling maintenance/reconciliation or acquiring a worker lease. If no pure exported adapter suffices, a research-only reader may validate existing files against the production contracts; it must not become another lifecycle state machine or authorize any continuation/stop.
- Join fixture-owned data root/canonical workspace, owning Root/Child, operation/binding, exact current job and verified process identity. Multiple possible jobs, stale generations, symlinks, changed/missing/truncated files and inconsistent snapshots remain unknown. Enumerate only the exact fixture-owned partition under hard entry/byte bounds, never real user plugin data or latest-job guessing. A lock file's existence/absence or a terminal status alone is NOT proof that all executor/cleanup duties are discharged.
- Native Child interruption source trace (§16.2) aborts the turn/active cells but does NOT automatically terminate the process store/Companion or persist a durable stop intent. Freeze what the existing path actually does: prompt cell cancellation, then either an already-authorized stop/reconciliation path or separately observed natural completion. **Do not invent a stop trigger**, call Cancel/reconciler to help the trial, send an extra OS signal, fabricate SessionEnd/host loss or release the gate early. Preserve the real terminal winner, including natural success racing interruption. A correctly retained unresolved guard is safe preservation, not successful settlement.

Throughout these investigations preserve the original one-shot preparation/atomic binding, fresh/resume/choice checks, exactly one mapped launch/send and original handle. Routine terminal observations stay empty-input, separate from the private preparation frame; no overlapping inner poll or Status substitute. Preserve the single between-polls Child Status sidecar rule and report any opportunity/latency as observed or unmeasurable, not zero. No placement change, new operation deadline, inactivity detector or reduction of the 100-hour safety ceiling.

## 3. File ownership and observation contract

| File | Responsibility |
| --- | --- |
| `tools/shell-wait-probe/fixture.mjs` | Disposable capture/control setup, fixture-only environment, bounded artifact provenance and disposal; installed production files otherwise byte-identical |
| `tools/shell-wait-probe/driver.mjs` | Closed closure-case selection, original process/turn lifecycle, observation snapshots before cleanup and finite ledger; no alternate business execution |
| `tools/shell-wait-probe/evidence.mjs` | Supported host-event/finite-call admission and identity/pending/cell attribution; no generic parser growth |
| Conditional `tools/shell-wait-probe/closure-observation.mjs` | Small research-only passive stdout tap/read/projection and pre-existing durable-snapshot reader, if these cannot stay focused in existing modules; split a fixture-generated preload from the read-side module if required for import purity |
| `tools/shell-wait-probe/release-qualification.mjs` | Reuse exact-output and native-layer oracles; fix only demonstrated input/oracle defects with versioned adjudication |
| `tests/shell-wait-probe.test.mjs` | RED→GREEN closure pipeline tests; remain in the existing opt-in research selection, not ordinary/authenticated tests |
| `docs/qualification/rescue-shell-long-wait.md`, this plan | New dated evidence/ledger/coverage and verdict; preserve previous history |

No modifications to canonical `scripts/`, `hooks/`, `skills/`, `agents/`, configuration, snapshots, dependency files, the spec or Codex source. No production reorganization to make observation convenient. Keep `wait-comparison.mjs` v2 and ordinary/MCP test selection unchanged.

Before implementation, freeze a small typed projection with these facts (names may follow existing record conventions; meanings may not change): exact invocation identity; source/observer/tap hashes; stdout capture complete/missing/truncated with byte count/digest and exact match; independent stderr count; actual process exit; expected framing provenance/resumability; host delivery identity source and pending bounds; Companion outcome; durable winner/stop-intent presence; applicable cleanup/guard/executor obligations and their observed settled/unresolved/unknown state; sample times and cleanup boundary. Record classifications and named reasons, not private record dumps. Every added helper executing during observation must enter the observer digest; a purely offline adjudicator gets its own version/source digest. Null never becomes zero or not-applicable without a demonstrated path reason.

## Task 1: Freeze supported seams and stop/settlement expectations — OFFLINE FIRST

**Files:** report/new dated registration; existing fixture/evidence/production/source reads. No live model turn.

- [x] Record new baseline, real executable/version/hash, source SHA/dirty state and prior evidence applicability. Establish the currently approved explicit model through bounded supported read-only discovery before live use; separate requested/effective metadata, never dump auth/config. The previous requested model was `gpt-6.1-sol`, not an immutable choice. — DONE 2026-10-21, report [§19.1](../../qualification/rescue-shell-long-wait.md): pins re-executed (binary 0.163.0 SHA-256 `8813…e31`, source `dffa0deb…` clean, driver --help verbatim); `codex debug models` bounded discovery: 10 entries / same 7 list-visible, `gpt-6.1-sol` still priority 0 REQUESTED via the `--model` seam, effective model metadata stays `null`; no auth/config dumped.

```bash
git status --short
git rev-parse HEAD
codex --version
git -C ../../../codex rev-parse HEAD
git -C ../../../codex status --short
node tools/shell-wait-probe/driver.mjs --help
```

- [x] Inspect existing fixture-owned retained records/excerpts first; if suitable raw host events still exist, derive bounded target/settlement facts OFFLINE with their original provenance and a new adjudicator version. Do not claim deleted raw data was re-derived or stamp newly synthesized facts with the old observer digest. Do not persist unsupported bodies or aliases merely to simplify development. — DONE 2026-10-21, report [§19.2](../../qualification/rescue-shell-long-wait.md): all twelve §18.1 record dirs exist (digests bound); NO suitable raw host events survive (23-char target bytes scrubbed at capture, rollouts disposed, F's typed projection incomplete — each named); offline re-adjudication at the UNCHANGED oracle v1 reproduces the §17.10/§17.12 fail-closed verdicts, so no new adjudicator version was minted and no old observer digest was stamped onto new facts.
- [x] Select a concrete stdout-only seam from §2 after testing its transport to the actual invocation. Freeze: exact process/argv selector, byte/exit completion marker, max 64 KiB terminal stdout capture, private-file lifecycle, expected production formatting and actual resumability source. No-seam is a precise dependent blocker, not permission to change production output. — DONE 2026-10-21, report [§19.3](../../qualification/rescue-shell-long-wait.md): existing supported split-stream capture proven ABSENT at exact source lines (PTY receivers merged by `combine_output_receivers`, `stderr` empty by construction); the fixture-only preload seam selected and OFFLINE transport-tested through the REAL writer path (fast-fail `invoke-prepared rescue`, no model turn: 207-byte envelope byte-exact capture, production bytes/exit unchanged, inert on wrong entry/argv/foreign processes, mechanics verified); all freeze items pinned; two named dependent blockers registered (NODE_OPTIONS propagation through the actual Child spawn — in-fixture preflight duty; PTY transcript translation vs the capture basis).
- [x] Trace host target/activity event persistence and join rules, and identify the actual finite shape missing from any available fixture-owned evidence. Register the supported admission set and counterexamples BEFORE a live trial. Host activity proves dispatch identity, not cancellation/Companion/job settlement; emitted-after-dispatch timestamps bound timing rather than pretending to be the dispatch instant. — DONE 2026-10-21, report [§19.4](../../qualification/rescue-shell-long-wait.md): full persistence chain traced at `dffa0deb` (interrupt_agent.rs:37-77 → emit_sub_agent_activity → ItemCompleted persisted; ItemStarted transient; Paginated mode keeps the Interrupted item, Legacy drops it; LocalThreadStore defaults PAGINATED, Child inherits parent mode); the missing finite shape named (event_msg/item_completed/SubAgentActivity, never admitted by the current reader); admission set (6 conjuncts) + counterexamples registered BEFORE any live trial; installed-observation check registered as the next interrupt case's first step.
- [x] Freeze exact durable-job identity/obligation predicates on the real attached foreground path, including terminal versus retained unresolved duties. Determine which supposedly read-only adapters create/chmod/lock/update or reconcile. Choose a passive snapshot strategy and document its consistency limits. No hardcoded-null placeholder reader counts as implementation. — DONE 2026-10-21, report [§19.5](../../qualification/rescue-shell-long-wait.md): partition identity pinned (sha256(realpath) key); side-effect classification exact (`readJob`/`peekOwnedJobs`/`jobStorage`/`resolveWorkspaceStorage` create+chmod, `withFileLock` flock never unlinks, `createLayout:false` the no-create precedent, pure bounded reads named, `existingJobStorageForRepair` the passive layout resolver pattern); obligation predicates frozen from the EXPORTED production contracts (`TERMINAL`, `endedObligationSettled`, `isMarkedRunnerClaim`, stop-intent validity, writable guard, binding currency — terminal status alone is NOT discharged duties); passive snapshot strategy + consistency limits documented.
- [x] Register a common timing basis and actual interruption responsiveness oracle: retain the prior preregistered ≤60000-ms turn/cell bound where still applicable; Companion/job/guard outcomes remain separate. Existing natural completion is not falsely attributed to cancellation or required to become `cancelled`. Unknown aggregate job-settlement bounds remain explicit, never replaced by a new production deadline. Observations must finish before safety cleanup to receive native/natural credit. — DONE 2026-10-21, report [§19.6](../../qualification/rescue-shell-long-wait.md): the §16.5/`RESPONSIVENESS_BOUND_MS` 60000-ms oracle retained unchanged (registered-but-not-yet-applicable, all prior deliveries unattributable); the three clocks named and never merged with exact join rules (null stays unestablished, never zero); the new host-emission `completed_at_ms` bounds dispatch from above only; layer separation, natural-completion protection, no-new-deadline and cleanup-boundary rules restated with citations.

**Exit:** concrete tested observation design, or precise infeasibility only for its dependent task. Independent output and interrupt/read-side work continue. If a production lifecycle change is actually needed, produce a minimal evidence-backed fix proposal and stop that mutation, not the whole investigation.

## Task 2: Attributable stdout and durable snapshots — regression-first

**Files:** fixture/driver, conditional closure observation helper, research tests; production files read-only.

- [ ] Write and run failing PIPELINE tests for exact selected `invoke-prepared rescue` capture. Include valid production framing; stdout empty; sentinel plus extra stdout; missing/truncated/oversized capture; multibyte text split across chunks; independent noisy stderr containing a counterfeit sentinel; callback/encoding/return-value/error preservation; two distinct invocations; wrong process/argv/PID/handle; preparation/Status/background runner/foreign Node process; path escape/symlink/replacement; missing final exit/flush. Preparation markers/capabilities/auth must NEVER enter capture files, records or thrown error text. Validate all options before fixture side effects.
- [ ] Implement the smallest passive selected seam; never reconstruct stdout by stripping stderr from merged text. Preserve stdout delivery to Codex and production `process.exitCode`; capture failure is a named observer failure, not a replaced business result. Scope all capture state to a fresh fixture/nonce and expose only bounded data required by the exact-output oracle. Prove normal launcher/renderer/args unchanged apart from explicitly declared passive observation.
- [ ] Build expected bytes through the real formatter/renderer using independently established result/resumability facts. Do not derive the expected output by copying the captured bytes. Feed the attributable original exit and complete stdout to `evaluateExactTerminalLinkage`; unknown expectation or stream completion stays unestablished.

```js
// Existing oracle contract; PIPELINE tests must establish these inputs,
// not merely repeat this already-covered pure function assertion.
assert.equal(evaluateExactTerminalLinkage({
  terminalStdout: null, exitCode: 0,
  expectedOutput: 'fixture-result\n', expectedExitCode: 0,
}).matched, null);
assert.equal(evaluateExactTerminalLinkage({
  terminalStdout: 'fixture-result\nextra', exitCode: 0,
  expectedOutput: 'fixture-result\n', expectedExitCode: 0,
}).matched, false);
```

- [ ] Add failing durable-reader pipeline tests: exact current bound job and independently completed duties; terminal record while executor/runner still alive; retained cancelling guard; stale/advanced binding; foreign owner/worktree/permission; multiple candidate jobs; missing/corrupt/truncated/symlinked files; inconsistent before/after snapshot; replaced/reused PID; wrong lifecycle generation; capture after cleanup. A missing record is not successful cleanup. Compare directory/content/mode snapshots before/after reads to prove no mkdir/chmod/new lock/stop intent/state update. Do not probe a lease by acquiring it.
- [ ] Implement the passive exact-state reader and join it into the persisted live record and Gate D input; no permanently null `durableObligations` on an otherwise observable fixture. Map only production-defined obligations; a demonstrated not-applicable branch needs its source/record reason. Aggregate settled only when ALL applicable duties are positively established. Partial observations remain per-layer facts; do not infer guard release from terminal stdout or process exit.

Run focused RED→GREEN tests first; then:

```bash
npm run test:shell-research
node --test tests/test-selection.test.mjs
npm run lint
npm run typecheck
```

**Exit:** actual stdout and actual durable state can be measured through the production path without altering it; fixture tests prove they cannot manufacture success from merged output, stale state or cleanup.

## Task 3: Native delivery admission and sequencing — bounded, not another interpreter

**Files:** evidence/driver/fixture and the SAME research entry; source and production read-only.

- [ ] Add failing attribution tests for the investigated host activity/event representation: exact spawn/call/Child/Root/turn match; alias text hidden but host identity matches; conflicting/missing identity; wrong/duplicate call or session; self/root/unrelated target; dispatch rejection; unobserved outcome; terminal-before-delivery; activity item without pending observation; untimed event. Keep returned `previous_status` a pre-dispatch snapshot, never settlement.
- [ ] If an actual missing finite code shape is established, implement only that form in the existing bounded parser. Test raw directive validity/preservation, leading/trailing foreign statements, explicit terminate mixed with native cancel, shared-cell statement/continuation attribution, resolved-cell reuse and cross-session identical IDs. Do not broaden grammar to explain a hypothetical lost body. Unsupported shapes still fail closed, but safe structural diagnostics may survive so the exact target and all unrelated observations are not erased unnecessarily.
- [ ] Improve only the registered research interruption choreography through supported owning-Root tools. Reuse the exact spawn id or authoritative resolved host identity; preserve one native interrupt and a declared unrelated same-host Root-owned control active at delivery, with emission-time survival evidence afterward. A readiness signal/floor is never proof that the Child poll is pending. Any proposed supported readiness seam is investigated and fixture-tested, not guessed. Root must not issue the Child's `write_stdin`, a second poll, a replacement thread or a separate app-server pretending to own the session.
- [ ] Wire settlement readers through the exact identity to ALL Gate D layers. Add pipeline negatives for unreadable continuation, explicit cell termination, cleanup-generated cancellation/exit at or after the earliest cleanup boundary, negative/unknown/over-bound latency, still-live Companion, terminal status with outstanding duties, already-completed or unknown-at-delivery control and buffered-before-delivery lines. Preserve genuine pre-cleanup native settlement even if later harness cleanup is needed. No extra Cancel/OS signal/reconciler call is allowed as native proof.
- [ ] Re-run research/selection/lint/typecheck and independent evidence/privacy/oracle review on the actual implementation before authorizing any registered live launch. Short offline fake-host/native-shape fixtures are instrument tests, not installed qualification. No authenticated ordinary E2E or new MCP qualification is implied.

**Exit:** target and each settlement layer are actually observable (or a supported-path impossibility is precisely established); preflight rejects a live launch whose required observer is known absent.

## Task 4: Freeze the new finite live ledger; reuse first

**Files:** this ledger and a new dated report section BEFORE any trial. Existing source/instruction/provenance validators remain mandatory.

| Label | Maximum logical cases | Purpose and precondition |
| --- | --- | --- |
| O1 | 1 conditional | Natural actual managed foreground Child with attributable full stdout/exit, exact job linkage and unchanged candidate wait policy; only after capture/state seams pass offline |
| O2 | 1 conditional | Fresh matching corroboration of O1's exact output/long linkage, only when existing attributable evidence cannot complete the fresh-repeat requirement |
| I | 1 conditional | Exact pending Child native interruption, turn/cell response, actual Companion/job/duties and declared independent survival control; only after target/read-side seams pass |
| F | 1 TOTAL shared conditional | One demonstrated-cause, one named-change successor across O1/O2/I, preregistered; never a retry per label or for model nonadherence |

Maximum **4 logical cases**, not four guaranteed successes. Register every actual CLI/model turn, internal Child/control and finite sequence under its label; failed starts/unsupported shapes consume their case. Installation/version/model-list discovery without a model turn is not a live case. No standalone exploratory turn or unregistered smoke test is free. The previous plan's unavailable G label is not available here. Do not spend labels just to fill the table.

- [ ] Prefer immutable retained attributable evidence and versioned offline re-adjudication when it really answers a predicate. Old merged streams cannot answer stdout-only equality; fixture/synthetic success cannot replace an installed Child observation. Record reused/unspent prerequisite reasons explicitly.
- [ ] Freeze exact implemented CLI commands AFTER Tasks 1–3 add/test the closed options; do not pretend new flags already exist. Use a single finite closure selector rather than an arbitrary argv/config bag. Starting candidate settings: `config-default`, inner request/cap/outer default/same-cell continuation 3600000 ms, harmless hold 420000 ms, total experiment budget 1200000 ms, unchanged initial launcher ≤30000 ms, separate private preparation. Root join configuration and diagnostic/model/source settings must be recorded, not silently altered to get a pass.
- [ ] On the same applicable host pin, O1/O2 can corroborate Gate B using historical M=300004 and the retained cadence result, provided each new actual poll independently has remaining lifetime ≥ M+30000, original-handle observation >M, complete exact terminal linkage and matched current settings. No new M/B/C0/C1 is authorized. If host/config/instruction/model applicability changed, keep historical successes scoped and report the new cross-pin limit; do not silently start another calibration/cadence campaign.
- [ ] For I preregister exact native path, readiness method, pending interval criterion, independent control lifetime/read sequence, sample schedule and safety cleanup. Use the prior ≤60000-ms turn/cell responsiveness bound only after Task 1 confirms applicability. Record Companion/durable obligations separately over the existing natural/authorized-stop path within the declared budget; no new operation deadline. Classify responsive cell + surviving unresolved job honestly, not full settlement. If a natural terminal winner settles later, record it as natural, never as a cancellation caused by the interrupt.
- [ ] Re-pin binary/source/model/observer/tap/installed-artifact/instruction bytes immediately before each launch; include every executing helper and detected mid-run changes. No cross-version repeat or comparability claim. A demonstrated instrumentation defect may be corrected/versioned OFFLINE against retained suitable bytes, preserving prior verdicts; another live run still needs F or new authorization.

**Exit:** a concrete finite command/turn register and tested preconditions, reviewed BEFORE launch; no demand for a new user decision merely because an investigated mechanism differs from a starting hypothesis. Meaningful scope/authority expansion still requires user direction.

## Task 5: Execute only the eligible closure cases and adjudicate independently

**Files:** registered records and report. No production promotion.

- [ ] Run eligible O1/O2 at most once each in fresh private outputs. Retain bounded actual tool/handle/terminal linkage, both actual timing/headroom predicates, attributable captured stdout/exit and independently derived complete expectation. Report exact-output pass/mismatch/unestablished separately from long-wait success; don't erase prior successes because the new observer fails.
- [ ] Run eligible I once on the owning session. Prove exact host dispatch identity and pending ordering, then actual turn/cell settlement latency, Companion local/remote outcome, durable winner and ALL applicable guard/executor duties, unrelated control active at delivery and alive/independently naturally completed afterward. Read/sample before the earliest cleanup boundary and preserve times/source completeness. A successful delivery acknowledgment alone cannot qualify downstream layers.
- [ ] If a prerequisite is demonstrably unavailable, keep the dependent label unspent and publish the precise reason; independent cases continue. If model nonadherence, new unknown shape or missing pending window occurs after launch, record the consumed case and its partial facts. F needs a diagnosed correctable cause, one named change and preregistration; no repeated model requests until success.
- [ ] Report separately: (a) observer incapability/not-proven; (b) measured production contract failure; (c) compatible observed native/natural behavior; (d) deliberate cleanup. If existing behavior needs a production repair, supply minimal exact-path evidence and a bounded repair proposal for user approval, without editing it or weakening the spec. No forced stop/recovery to make the ledger green.

**Exit:** exact per-layer closure or an actionable smallest blocker, not another vague “long wait infeasible” verdict.

## Task 6: Final-source verification, independent review and scoped recommendation

**Files:** report, this plan, research implementation/tests only.

- [ ] Append a dated section preserving §§16–18 history: retained proven long-wait/cadence facts; observation strategy and provenance; supported source versus installed events; stdout/framing and durable snapshots; per-layer native/natural/cleanup results; every reused/consumed/unspent label; bounded raw-data disposal/retention omissions. Never copy private full rollouts/preparation/auth/job bodies into the repository.
- [ ] Map this work to S1–S7/Q1–Q6 and prior Gate A–E with unchanged requirements. Explicitly distinguish B/D closure from full compatibility/rollout: Review no-send and BG unproven are still separate limits unless independently qualified by existing matching evidence. No new RV/BG campaign is authorized. No supported numeric Role-scoped override is invented; broad shared-default adoption remains blocked by unqualified affected consumers.
- [ ] Run the following on the FINAL implementation, including every helper; record source, counts/skips/exit status and named failures. Do not reuse pre-fix success as a final gate.

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
git diff 0b522b70b0ed72d7d1566de581dc306c70b38fac --stat -- skills/ agents/ scripts/ hooks/ .codex-plugin/ marketplace/ docs/superpowers/specs/ package.json npm-shrinkwrap.json
npm test
```

  Prohibited diff expected EMPTY. For `npm test`, preserve unowned scratch and use a clean exact verification copy containing ALL selected implementation files when necessary. No blanket stash/staging/deletion/commit. Use a normal copied `node_modules` directory, not an unignored symlink, and a verification path without known guarded identity words (e.g. `mktemp -d /tmp/swverify.XXXXXX`). Prove copied tracked bytes match; don't reuse an old-source clone after later fixes. Failed runs stay failed; no gate waiver unless explicitly authorized and labeled unfulfilled/waived. Docs-only closing records may follow tested code, with implementation equality proven.
- [ ] Independently review Spec fidelity and implementation/evidence/privacy on the final branch. Record actual reviewers, revisions, findings and narrow correction rechecks in this plan/report; close the checkbox only when the reviews occurred. Provider outage is pending, not a silently substituted gate or permission for indefinite review loops.
- [ ] Deliver a scoped **adopt / adopt-only-on-listed-surface / do-not-adopt-yet** recommendation separating: established long-wait/cadence mechanism; exact-output B; native/obligations D; per-command deployment eligibility. No automatic config/Skill/Role/cache change or blanket version/platform claim. If core B/D close but RV/BG/global-config scope does not, state that exact result and the smallest separate production/compatibility action; do not call the original waiting mechanism unsuccessful or promise no remaining deployment work.

**Completion:** This bounded evidence-closure task is complete when output and native/owned-settlement questions are answered with actual evidence or precise supported-path blockers, final-source gates/reviews are honestly recorded, and the next production decision is specific. The original production goals remain binding; research completion is not automatic production adoption.

## 4. Planning verification record

- Drafted after PR #70 merge at `0b522b7` in the fresh worktree; unchanged spec and production code. All execution checkboxes remain open.
- Fresh drafting baseline on 2026-10-21: `npm ci --ignore-scripts` succeeded (1 moderate/3 high audit advisories; no dependency changes); `npm run test:shell-research` **709/709**, 62 suites, zero failures/skips, exit 0; selection **6/6**, exit 0; tracked-file LF **540 files**, exit 0. Full `npm test` is not claimed for this plan-only drafting step; Task 6 requires it on the final implementation bytes.
- Main-agent self-review checked unchanged spec coverage, explicit remaining BG/RV scope, finite cases, no guessed mandatory APIs and no placeholder tasks. New plan/scratch LF, final-newline, trailing-space and local-link checks passed; `git diff --check` passed and prohibited tracked-path diff against `0b522b7` was EMPTY.
- Two independent read-only subagents reviewed this draft: `campaign_spec_production_review` (spec/authority/coverage) and `config_path_a_plan_review` (executability/oracles/privacy). Both returned CLEAR, no P1/P2 or blocking P3; neither implemented or ran a live trial. Their review is of the plan, not proof that the proposed observer or production qualification will succeed.
- Drafting complete; ready for separately delegated execution. No live case, production change, commit, push or PR was performed. All execution checkboxes remain open.
