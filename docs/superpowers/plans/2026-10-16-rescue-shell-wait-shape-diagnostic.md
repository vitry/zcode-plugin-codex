# Controlled Shell Call-Shape Diagnosis and Wait Verification Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` after explicit execution delegation. Independently review the bounded diagnostic before live use and the final branch before close-out. Checkboxes track execution, not production approval.

**Goal:** Identify the current observer's missing call form without exporting private code, decide whether one finite recognition adaptation is safe, and, only if measurement is restored, test the configured outer-wait default on the actual managed Rescue Child.

**Architecture:** Inspect raw fixture calls only inside the existing in-memory evidence path. A separate opt-in static diagnostic emits a fixed, bounded vocabulary of syntax/decision facts, never source snippets or arbitrary literals. Diagnosis does not authorize admission: a new recognizer requires a complete finite grammar, RED→GREEN tests and unchanged ownership/output checks before one bounded replay and a conditional config pair.

**Tech Stack:** Node.js ESM/`node:test`; existing shell-only driver/evidence/fixture; installed Codex CLI and disposable plugin installs with harmless fake ZCode. No evaluation engine or new runtime dependency is preselected.

---

## 1. Same spec, new plan, explicit authority

- Unchanged spec: [2026-10-05 design](../specs/2026-10-05-rescue-shell-long-wait-design.md), S1–S7, Q1–Q6 and §8. This plan does not weaken any product/release requirement.
- Durable record: [qualification report](../../qualification/rescue-shell-long-wait.md), §§13.10–13.11 and **14–14.1**. Prior [config-path-A plan](2026-10-16-rescue-shell-wait-config-path-a.md) is closed, not reusable run authority.
- PR [#68](https://github.com/vitry/zcode-plugin-codex/pull/68) merged at `7fe8cbb80489664eb6ea56917c795cb9a17233cb`. This fresh worktree starts there: `.worktrees/rescue-shell-wait-shape-diagnostic`, branch `docs/rescue-shell-wait-shape-diagnostic`.
- Codex source: `/Users/zhangzikai/Workspace/Codes/github/codex` (`../../../codex` here, not plugin `.codex`). At drafting: clean `dffa0deb69268ed4ac31578794c9ea897b336ae3`; installed CLI `0.163.0`. Re-pin before execution; source/binary correspondence remains unestablished. Inspect source read-only with `git show <pin>:<path>`, no fetch/build/edit.

Current authorization is **draft and independently review this plan only**. Future execution delegation permits the finite research tasks below, not changes to production/user config/cache, credentials/provider projects, commit/push/PR/merge or automatic release. Commit authority is separate. Preserve the established coding/review workflow; record outages as pending, not passed, and do not silently switch coding agents.

### What the last plan did and did not establish

A0 consumed one live run on 0.163.0. Its fresh `exec_command` cell had a 2-physical-line/243-byte envelope, one listed nonempty diagnostic line, no omitted diagnostic lines, `const-r-await` prefix and `wholeBodyStatementMatch: false`. That excludes the **existing** parser set and **planned** raw-body fallback for that cell. It proves neither the precise statement form nor impossibility of a new finite recognizer. The raw cell was not retained. Historical cells cannot be reconstructed by this plan.

The configured outer default's transport was validated through isolated positive/negative `features list` probes. C0/C1 never ran; runtime effect remains unproved, not refuted. Source findings give a mechanism to test, not a production recommendation. Local `npm test` recorded a failure; CI subsequently passed on PR #68. Keep both facts, never relabel the failed local run as passed.

This plan deliberately investigates the actual missing form before deciding its implementation. Do not encode a guessed host syntax as a mandatory success condition, demand that the user design a decoder, or default to a forced choice between raw-data retention and waiting for another host version.

## 2. Scope, ownership and privacy contract

| File | Responsibility |
| --- | --- |
| Create `tools/shell-wait-probe/shape-diagnostic.mjs` | Bounded, non-executing memory-only shape classification; optional finite recognizer only after a demonstrated form is adjudicated |
| `tools/shell-wait-probe/evidence.mjs` | Opt-in diagnostic integration before unknown-call suppression; conditional adapter integration at the common parser; all downstream admission/privacy checks unchanged |
| `tools/shell-wait-probe/driver.mjs` | Closed CLI/programmatic inputs, provenance, optional explicit model selection and config trial transport; legacy defaults preserved |
| `tools/shell-wait-probe/fixture.mjs` | Conditional config-default waiting paragraph before setup/Role rendering; isolated artifacts only |
| `tests/shell-wait-probe.test.mjs` | All new unit/privacy/ownership regressions, importing the helper rather than creating an ordinary test entry |
| `tests/test-selection.test.mjs`, `tools/run-test-suite.mjs` | Inspect selection; change only if a real isolation defect exists |
| `docs/qualification/rescue-shell-long-wait.md`, this plan | Dated evidence, exact ledger, seam/grammar decisions, honest limits and review results |

No spec, canonical Skill/Role, production scripts/hooks, marketplace snapshot, production E2E gate, user configuration/cache or Codex source changes. No MCP reopening, alternate shell, hidden poll/sleep loop, forced generic route, watchdog or interpreter. Preserve preparation/binding/ownership, exact initial/choice assignment, one mapped launch/send, original handle, separate sanctioned nonempty preparation, empty routine observations and one pending inner poll. Exact result/error/resume/placement semantics, operation deadlines, reconciliation and the 100-hour ceiling remain mandatory; no new six-hour/inactivity timeout.

### Memory-only means no additional raw disclosure

The host already writes fixture-owned session rollouts. This work may read those through existing instrument paths while that isolated home exists; it must NOT create an additional raw archive, print source to the agent/console, attach raw inputs to exceptions, persist an unfiltered token/AST dump, copy rollouts outside the owned fixture, or extend raw-data lifetime. Existing owned cleanup still runs on success/failure. If the old record is gone, do not attempt recovery. A hash identifies a recurrence, not recovered content.

Retained new facts must be booleans or closed enums representing **public syntax relationships**, plus existing sanctioned envelope counts/digests. These facts may compose a schema-projected syntax/decision tree: fixed public node kinds, fixed child slots and binding-equality relations, at most 64 nodes/depth 8/16 statement slots, with argument payloads and unknown identifiers/literals opaque. This is not a raw AST dump or an interpreter; whole-input coverage is still separate from admission. Never persist arbitrary variable/property/tool names, command/task text, arguments, strings/templates/comments, number values, source offsets, paths, preparation/capability data or auth. Unknown names/literals map to fixed `other`/`unknown` classes, not their spelling, prefix, length series or per-token hashes. Existing sanctioned protocol values remain available only through the existing admitted-call privacy projection. A redacted skeleton is NOT a copy of source with a few secrets replaced.

Starting diagnostic dimensions (Task 1 may refine the finite schema within these same privacy bounds, with tests before live use): declaration/await/inline head class; allowlisted tool family; literal-object versus unsupported argument form; complete/invalid/unsupported lexical state; result-binding equality without retaining the binding; fixed tail classes such as `text(binding)`, `text(JSON.stringify(binding))`, a whitelisted public result-field projection, none or other; existing-parser accept/reject stage; directive absent/valid/invalid/unknown; whole-input-consumed versus residual unknown content. Public syntax strings may exist as **fixed enum labels**, never arbitrary extracted code. Do not infer "one statement", output semantics or exact form from a prefix/brace count.

Use lexical string/comment boundaries before structural classification: tool-like text inside task strings is not a tool call. Do not evaluate expressions, resolve prior variables, interpolate templates or execute candidate source. Unsupported lexical features remain unknown. Discover the minimum discriminators needed with synthetic cases first; neither a general JS parser nor an additional dependency is required by this plan. If one is proposed, justify its bounded non-executing role and dependency/scope consequences before use; this plan does not authorize a general interpreter.

## 3. New finite run ledger and stopping rules

All new budgets start unspent; old A0/A1/C0/C1 remain historical. Every model-turn launch counts, including failed startup or a synthetic/control diagnostic. Plugin installation, version/help/config parsing without a model turn are not live runs.

| Label | Maximum | Purpose / prerequisite |
| --- | --- | --- |
| D0 | 1 | Opt-in richer structural diagnosis on actual managed Rescue flow, original candidate paragraph |
| D1 | 1 conditional, shared follow-up | EITHER one concrete diagnostic refinement if D0 was insufficient, OR one replay after a demonstrated finite adaptation; not both |
| C0 | 1 conditional | Matched config-default control, only after actual managed-route observation can be fully admitted/measured |
| C1 | 1 conditional | Raised outer default, only if C0 is measurable and comparable |

Maximum four live runs. D0/D1 use 130000-ms harmless holds and 360000-ms observation budgets. C0/C1 use 180000-ms holds, 240000-ms inner/outer-continuation requests and 600000-ms budgets. Setup/install adds wall time; these budgets are NOT production timeouts. No whole campaign, extra Root control, resized group or live interruption trial.

Before D1 name the exact cause, the sole change, and whether its one allowance is spent on diagnosis or adapted replay. If D1 is diagnostic, fixture-only adaptation may still be developed when justified, but no additional replay is authorized. A next run's form may differ; each diagnosis belongs only to its own fresh cell, not D0 or history. Stop comparisons on changed executable/model selection. Unknown residual statements, unsupported lexical semantics, missing ownership or a new admission blocker stop admission and dependent config trials, not the expressly registered D1 diagnostic-refinement branch when its one-cause prerequisite holds. No retry-until-adherent or unregistered grammar family. Finish independent source/fixture/document tasks instead of inventing another budget.

An `unknown` result is not "no finite adapter exists". A positive syntax classifier is not admission, and admitted calls are not wait/config/production qualification. Do not bypass the whole-case unknown-call gate, discard troublesome cells, fabricate zero counts from missing data or substitute Root-only observations for actual managed-Child evidence.

## Task 1: Pin inputs and freeze a diagnostic that can distinguish causes

**Files:** inspect current driver/evidence/fixture, tests and report; record local schema/transport decision in this plan/report. Do not implement a guessed live form.

- [x] Record merged plugin source, executing source/dirty state, real native CLI path/version/hash and read-only source checkout revision. Use the installed binary, not npm's development dependency. (recorded 2026-10-16 in report §15.1: plugin `7fe8cbb…`, binary realpath `.codex/packages/standalone/…/0.163.0/bin/codex` sha256 `8813367…`, source pin `dffa0deb…` clean)

```bash
git status --short
git rev-parse HEAD
shell_plugin_sha=$(git rev-parse HEAD)
shell_codex_binary=$(node -e 'process.stdout.write(require("node:fs").realpathSync(process.argv[1]))' "$(command -v codex)")
"$shell_codex_binary" --version
shasum -a 256 "$shell_codex_binary"
git -C ../../../codex rev-parse HEAD
git -C ../../../codex status --short
node tools/shell-wait-probe/driver.mjs --help
```

- [x] Read `structuralExcerptForUnclassifiedInput`, `parseCallStatements`, `parseCallEvent`, `parseWrapperArguments`, `inspectShellWaitEvidence`, driver call/output watches, privacy scrubber and fixture disposal. Locate the in-memory raw-call seam BEFORE suppression/disposal. Determine how diagnostic results reach the redacted case record without carrying a raw input reference or exception message. (seam: evidence.mjs:2043-2048 and analog :2065-2102, before `structuralExcerptForUnclassifiedInput` fact-projection; record flow driver.mjs:2713-2715 → :545-688 → :704-714 @0600 — report §15.1)
- [x] Use synthetic **different** forms sharing A0's known prefix/line envelope to test information sufficiency: an accepted canonical wrapper; changed result binding; missing/changed emission tail; unsupported argument expression; tool-like text inside a private literal; extra hidden statement; trailing blank formatting. These are alternative hypotheses, never reconstructions of A0. Define closed decision dimensions separating whole-wrapper mismatch, argument decoding rejection, output projection and extra/unresolved content. If the existing naive brace hint cannot tell, use a bounded string-aware static scan rather than treating it as truth. (8-alternative set S-canonical…S-trailing-blank + 8 closed dimensions frozen in report §15.1; brace hint verdict: NOT sufficient — needs bounded string-aware scan)
- [x] Freeze a versioned output schema and bounds before live use: proposed input ceiling 8192 bytes, at most 16 top-level statement slots and 4096 argument characters; stay within the existing 2048-character excerpt budget. Bounds may be made stricter to match existing paths; never turn truncated input into success. A classification that needs information outside the safe schema stays unknown. Add only fixed enum discriminators within the stated privacy contract as a local investigation decision, not a user-design question. No live syntax is predeclared known. (schema v1 frozen with full field/enum/bounds table in report §15.1 — inputs ≤8192 bytes/16 slots/4096 arg chars; public-field allowlist EMPTY at v1; `parse-accepted` is diagnosis, never admission)
- [x] Resolve model comparison provenance: the old driver records `model: null` and does not pass `-m`. Investigate a supported explicit selection/metadata seam for the already authorized qualification model. If needed, plan an optional research `--model <id>` forwarded as a separate `-m` argument (bounded safe identifier, not arbitrary argv), tested at CLI and programmatic boundaries. Do not invent a model ID or silently switch provider/account; discover the approved/current selection without dumping user config, and record the validated selection in the task shell as `shell_trial_model` for the commands below. Record requested model separately from effective host/Child metadata, which may remain unknown. C0/C1 need matching explicit selection and Role model settings; if model control cannot be established, stop causal claims rather than compare two silent defaults. (`-m` seam source-verified at pin `dffa0deb…` — `Option<String>`, exec+interactive, no argv validation, precedence `-m`>`-c`>profile>config.toml; design resolved — Task 2 implements the bounded-validated driver flag; **`shell_trial_model` NOT established**: scoped docs deliberately name no authorized id, offline `codex debug models` lists only bundled-catalog entries (8 list-visible slugs on 0.163.0), real account default needs auth+network — so D0/D1 keep model unknown, and C0/C1's matched-explicit-selection prerequisite is UNMET until a user-authorized id exists — report §15.1)
- [x] Recheck supported numeric config transport from report §14: `-c features.code_mode.default_exec_yield_time_ms=<n>`, positive and malformed-value rejection via isolated `features list` if required; no model turn. `--version`/`--help` alone do not deserialize the key. Root joins, inner cap, exec default and outer continuation defaults stay distinct. Do not force-enable interruption or claim installed settlement from feature availability. (re-verified 2026-10-16 with true exit codes, isolated CODEX_HOME: positive/zero accept exit 0; malformed and negative reject exit 1 "did not match any variant of untagged enum FeatureToml"; `=abc --version` prints version — report §15.1)
- [x] Run baseline `npm run test:shell-research`, `node --test tests/test-selection.test.mjs` and tracked LF check. Record failures and audit advisories, not dependency fixes or another Windows stability project. (2026-10-16: 451/451 in 46 suites, selection 6/6, LF 535 files — all zero failures, matches drafting baseline; npm advisories remain disclosed-not-fixed — report §15.1)

**Execution record (2026-10-16, Task 1):** local work complete; three environmental degradations recorded in report §15.1 at execution start — (1) local proxy's foreign upstream down ⇒ codex review pending-backfill, never passed; (2) general-purpose subagent channel provider-rejected ~15 min (5 attempts incl. probe) while Explore (read-only) works ⇒ Task 1 evidence produced by Explore + root doc edits (recorded degradation; Tasks 2+ still require the standard subagent chain); (3) no live run attempted (§3 counts failed starts). Recovery ~11:15Z same day: foreign upstream restored, general-purpose channel recovered, and the pending review submitted via the plain non-adversarial `review` channel (user-directed) — **zero actionable findings** (job `review-mvavfwqo-dqcqv4`, full diff vs `7fe8cbb…`; report §15.1). `shell_trial_model` unestablished ⇒ C0/C1 prerequisites recorded unmet in report §15.1.

**Exit:** concrete safe schema, raw-call lifecycle seam, model/control limits and parser-stage distinctions are recorded. Unknown host syntax is still an investigation result, not a frozen mandatory API.

## Task 2: Build the opt-in memory classifier and prove its privacy boundary

**Files:** new helper, evidence/driver and existing shell-research tests. These are research-only code changes; there is no recognizer/admission change yet.

- [ ] Add a pure classification interface (proposed name `inspectCallShape(raw)` in the new helper) with closed return fields from Task 1. Write tests first. Initial examples, using the final frozen schema's names consistently:

```js
const raw = 'const alias = await tools.exec_command({cmd:"PRIVATE_MARKER_A"}); text(alias);';
const facts = inspectCallShape(raw);
assert.equal(facts.version, 1);
assert.equal(facts.tool, 'exec_command');
assert.equal(facts.head, 'bound-await');
assert.equal(facts.tail, 'text-binding');
assert.equal(facts.wholeInputConsumed, true);
assert.equal(JSON.stringify(facts).includes('PRIVATE_MARKER_A'), false);
assert.equal(JSON.stringify(facts).includes('alias'), false);
assert.equal(parseCallStatements({ payload: { type: 'custom_tool_call', input: raw } }), null);
```

  The last assertion pins diagnosis/admission separation for this noncanonical synthetic binding, not a claim about the missing live form. Proposed names may change at Task 1; update all tests/docs coherently before live work. `wholeInputConsumed` describes classification coverage only, never authorization to run or admit.
- [ ] Add RED cases for secrets in strings, nested objects, templates, comments, identifiers/property names, malformed directives and error text; public-looking `tools.*`/`text(...)` embedded inside private literals must not generate syntax facts. Vary literals/binding spellings while keeping syntax relations identical and assert identical retained facts apart from existing sanctioned body digest/envelope and apart from the `parserStage` diagnosis (the existing grammar pins the canonical binding spelling — WRAPPER_PATTERN, evidence.mjs:49 — so changed-binding forms necessarily report the existing wrapper stage; report §15.1 record 2). Include non-string, oversized, unterminated string/comment, nested/residual code, >bound and Unicode/control input: bounded fixed unknown result, never thrown private text, partial acceptance or new raw log.
- [ ] Implement the smallest finite static classifier satisfying those tests; never evaluate source. Record distinctions between supported lexical analysis and unknown features. Reuse the existing literal decoder in memory where appropriate; do not let classifier output become a fake validated-call object.
- [ ] Add **new proposed** flag `--unclassified-shape-diagnostic 1` (literal `1` only), requiring existing `--unclassified-structural-diagnostic 1`. Validate the pair at CLI, public `runShellWaitCase`/`validateCaseInput`, fixture/evidence boundaries where applicable; invalid programmatic combinations fail before side effects. When absent, existing structural retention/admission defaults remain unchanged. Add a closed diagnostic version marker to opt-in records; no general diagnostic/config passthrough.
- [ ] Invoke the classifier only for unknown raw calls in the existing evidence path; project all new results through the schema/budget before record serialization. If extra facts do not fit, drop whole optional facts and mark incomplete; never truncate mid-JSON, retain raw fallback or silently claim complete classification. Maintain existing cleanup and fail-closed verdict even if the helper fails.
- [ ] Bind the new helper's **executing module-init bytes** into observer provenance alongside evidence/driver. Version the digest construction and test it: a helper-only change changes the executing digest; on-disk mid-run edits are detected without relabelling already loaded code. Copying the old v1 two-file hash would misattribute the new classifier. Legacy fact projection stays unchanged, apart from honest provenance/version changes due to changed executing code.
- [ ] Run RED→GREEN focused `node --test --test-name-pattern='controlled shape diagnosis' tests/shell-wait-probe.test.mjs`, full shell-research, selection, lint and typecheck. Independently review privacy/sufficiency/no-admission-change before D0; fix findings and recheck, no authenticated run by the reviewer. If a helper is not safe/informative, finish this task's investigation before spending a model turn; do not rerun to discover a schema flaw already demonstrable offline.

**Exit:** opt-in diagnosis is informative on synthetic alternatives and cannot serialize private source/values. Importing the modules launches nothing. Default admission and legacy regressions remain intact.

## Task 3: D0 diagnosis and one conditional cause-directed successor

**Files:** research modules and report/ledger. All new option names below require Task 2 implementation; this command is not runnable against merged baseline.

- [ ] Run D0 once with a fresh private output directory. Omit `--cap-ms`; recognition, not five-minute cap propagation, is being investigated. If Task 1 established explicit model selection, add the same recorded `--model` selection for D0/D1 and later C0/C1; otherwise keep model unknown and do not manufacture a comparable-model claim.

```bash
shell_case_output=$(mktemp -d)
ZCODE_SHELL_WAIT_E2E=1 CODEX_BINARY="$shell_codex_binary" \
  node tools/shell-wait-probe/driver.mjs --case rescue-long \
  --codex "$shell_codex_binary" --source-sha "$shell_plugin_sha" \
  --output "$shell_case_output" --worker-duration-ms 130000 \
  --poll-ms 3600000 --budget-ms 360000 \
  --unclassified-structural-diagnostic 1 --unclassified-shape-diagnostic 1
```

- [ ] Adjudicate only the NEW cell using fixed facts: which existing stage rejected, whether a complete finite form is established, argument/output semantics and residual unknowns. If code is already admitted naturally, do not invent a recognizer; proceed only if managed-route/handle/terminal evidence is measurable. Do not infer a multi-line statement from raw line count or describe the raw source beyond the safe enums.
- [ ] If safe facts are insufficient but expose one concrete missing discriminator, spend D1 on one **diagnostic refinement** after new synthetic/privacy RED→GREEN tests and narrow independent review. Record that choice before launch; use D0's exact flags/pins/worker settings and only the recorded schema change. No later live adapted replay is available under this ledger. If diagnosis remains unknown, report that precise limit, not impossibility of every finite recognition design.
- [ ] If D0 establishes one complete finite form, decide the minimal recognition grammar locally. Static formatting/binding or one bounded literal representation may be considered, not only the old fallback; this new plan exists to assess that question. Document exact grammar, full-input consumption, output mapping, bounds and rejection set using synthetic public placeholders. Prefer reuse of existing argument decoding. Any new static literal normalization must be justified, bounded and tested; no variable evaluation, arbitrary expressions, interpolation, callbacks, imports, reflection, `eval`/`Function`/`vm`, unknown statements or permissive trailing content. If required semantics exceed this finite static scope, do not implement a general interpreter or claim all alternatives impossible.
- [ ] Write a RED regression at `parseCallStatements` for the one established form and existing privacy/ownership validators; implement one bounded adapter shared by every launch/poll/settlement watch. Prefer original parser first, finite adapter second. Validate directives on the **raw** input and preserve them; stripping first can bypass invalid directives. Do not widen the whole-case scan into "skip unknown calls". Hidden extra statements/tool calls, malformed directives, wrong binding, unsupported argument expression, foreign handles, overlapping polls and Root-control inside Child must still fail. Existing argument/statement/envelope bounds and exact command validation remain.
- [ ] Validate actual output semantics too: recognizing `tools.exec_command` does not prove that an emission such as a result-field projection preserves the native result. Use synthetic host-response fixtures showing the exact observed emission shape, per-statement output ownership and terminal metadata. If required metadata is absent/truncated, admit only syntax facts or leave completion unknown; never reconstruct a successful native result/exit from an incomplete print.
- [ ] Run focused adapter RED→GREEN and full shell/privacy/watch regressions; get an independent narrow grammar/privacy review. If D1 is still unspent, spend it once as the **adapted replay** using D0's same command and fresh output directory. Record the changed executing observer/helper digest; installed-plugin source remains separately pinned. A new fresh unknown form stops dependent trials, not another parser extension or model retry. If D1 was diagnostic, any later fixture-tested adapter has no installed replay qualification; keep that distinction.

**Exit:** recognition restored with attributable actual-route evidence, or precise shape/output/privacy/ownership limit; D0/D1 use and choice are explicit. A diagnostic-only D1 cannot authorize C0/C1 unless its own actual observation is already fully admitted/measurable without an untested post-run adapter.

## Task 4: Conditional actual-Child outer-default comparison

**Files:** driver/fixture/evidence/test seams, report/ledger. Research-only. Do not build or launch unreachable comparison work if the managed route remains unmeasurable. Historical/new Root-only controls cannot replace it.

- [ ] Implement **new proposed** `--wait-policy config-default` plus `--exec-default-ms <bounded positive integer, max 3600000>`, valid only together and for `rescue-long`; validate CLI and public programmatic/fixture boundaries with fail-before-side-effect negative tests. Defaults/legacy projections unchanged when omitted. Apply the supported finite numeric host `-c` override before the prompt; no shell interpolation or arbitrary argv/config bag. Apply Task 1's model-selection seam identically in both arms, recording requested/effective evidence separately.
- [ ] Use an isolated named/generic waiting paragraph variant applied before setup/Role rendering. Both arms get identical instructions: initial launch up to 30000; empty original-handle inner poll 240000; no explicit exec pragma/yield on the decisive outer cell; if it yields, continue that SAME cell with explicit outer wait 240000, not a second inner poll. No original command/preparation/binding/placement/result change; no edits to Root-owned Review/Adversarial/Status Skills. Record artifact hashes and path-normalized instruction comparison; different fixture paths/IDs/rendered hashes are expected, not cross-arm incompatibility by themselves.
- [ ] Test transport placement, finite validation and safe record projection, paragraph-before-setup, legacy directive behavior and helper provenance. Add comparison regressions: explicit pragma ⇒ default-causality inconclusive; missing/null timings/counts ⇒ unknown, not zero; mismatched pins/model settings/Role/inner cap/Root waits ⇒ no causal comparison; direct native shell without code-mode ⇒ different surface; early completion, unknown output or no conservative headroom ⇒ inconclusive. Legacy structural/terminal completion is NOT a config-effect gate: retain it and add a separate actual-window/default-effect verdict.
- [ ] After GREEN shell-research/selection/lint/typecheck, run C0 once. Fresh private directory; no cap override. Add the explicit `--model` chosen and verified in Task 1 identically to BOTH arms; if that prerequisite is unavailable, record both arms unspent rather than assume two default models match.

```bash
shell_case_output=$(mktemp -d)
ZCODE_SHELL_WAIT_E2E=1 CODEX_BINARY="$shell_codex_binary" \
  node tools/shell-wait-probe/driver.mjs --case rescue-long \
  --codex "$shell_codex_binary" --source-sha "$shell_plugin_sha" \
  --output "$shell_case_output" --worker-duration-ms 180000 \
  --poll-ms 240000 --budget-ms 600000 \
  --model "$shell_trial_model" \
  --unclassified-structural-diagnostic 1 --unclassified-shape-diagnostic 1 \
  --wait-policy config-default --exec-default-ms 30000
```

- [ ] Run C1 once with a NEW private directory and the same command changing only `--exec-default-ms 240000`. All executable/model selection/Role/instructions/inner cap/Root waits/worker/observer/fixture source settings match; record expected per-run private IDs/path differences. If C0 is not measurable, C1 remains unspent. No automatic parser patch, re-run, model change or resized hold between arms.
- [ ] Record actual Child/parent linkage, one launch/send, original handle, empty poll, absence of pragma, observed outer returns/continuations and linked poll timing, conservative hold-deadline remaining lifetime at decisive poll start (at least 60000 ms to interpret the 30000-ms contrast), exact terminal output/exit and cleanup where attributable. Count Root joins separately. C0 pending around short outer window versus C1 holding beyond it is the expected discriminator, not forced output. Explicit yield/preemption/input, transport/resource limits or real completion are alternative enders and must be disclosed.
- [ ] Label installed config effect/no observed effect/nonadherence/not-proven with actual basis; accepted config, source inheritance, diagnosis, long inner wait, zero parseable returns or driver exit 0 alone qualify none of these. No inner-cap M/propagation, quantified token savings, repeat, native cancellation or production-readiness claim follows from this pair.

**Exit:** current-surface measured comparison or exact bounded not-proven/unspent cause. No new budget from an inconclusive result.

## Task 5: Verification, independent close-out and next decision

**Files:** research-only modules/tests plus report and this plan. Preserve all historical data and limits.

- [ ] Append dated results: exact binary/source/plugin/observer/helper/instruction/model evidence, safe diagnostic schema/version and coverage, actual finite grammar if any, each fresh-cell adjudication, full run ledger including unspent causes, actual/null observations and cleanup. Public synthetic cases illustrate a grammar, never reconstruct A0 or prove it had that form. Current spec remains unchanged; proposed production scope ZERO.
- [ ] Map S1–S7 and Q1–Q6 explicitly: preparation/binding/ownership/output/handle invariants unchanged, admitted only where proved; placement/Root/Status and generic history keep their own scopes; source/default interrupt capability is not installed native interruption/durable no-collateral settlement; full M/raised-cap/repeat/re-entry, noise/sidecar and remaining per-command questions still require their own qualification. No human adoption follows automatically.
- [ ] Run the following exact gates and record counts/failures/skips and tested source, not historical passes:

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
git diff 7fe8cbb80489664eb6ea56917c795cb9a17233cb --stat -- skills/ agents/ scripts/ hooks/ .codex-plugin/ marketplace/ docs/superpowers/specs/
```

  Final prohibited-path diff must be EMPTY. Run `npm test` once against a clean exact source including every new helper/research implementation, not the merged base alone. Do not repeat the previous predictable scratch failure: before that gate, identify only this session's exact owned scratch/draft paths, move those temporarily to a private OS-temp directory, record hashes and restore them in a guaranteed finalizer. Do not park another agent's edits or use a blanket stash. If implementation is uncommitted or other unowned dirt prevents a clean exact gate, use a private verification copy containing the selected changes; any local-only verification snapshot must be isolated from the working branch and explicitly documented. Never commit in the working branch merely to make tests clean. Do not delete scratch, change expectations or silently remove proxy settings to manufacture a pass; an environment experiment must name the changed variable. A failed suite stays failed with cause/limits even when CI or review later passes. No implied authenticated ordinary E2E/MCP research.
- [ ] Independently review spec fidelity, grammar/admission and output attribution, diagnostic privacy/sufficiency, executing-source provenance, finite budgets and honest conclusions. Fix real findings, narrowly recheck corrections and record actual reviewed bytes/revisions. Review outage is pending, not passed; no endless review loop or silent workflow substitution.
- [ ] Hand off results and smallest evidence-backed next step. If recognition/config work succeeds, the unchanged spec §8 still requires quantitative long discriminator and repeat, reduced re-entry, exact terminal linkage and native pending-observation interruption with responsive owned/no-collateral settlement before production recommendation. If not, report the specific measured diagnostic/semantic boundary, not "all finite adapters impossible" or "long waits infeasible". New authority is required for additional runs or a separate production plan.

**Completion:** Safe diagnosis and any justified conditional adapter/config trial have measured evidence or precise investigated not-proven causes; tests, cleanup, finite ledger and independent review are honest. This is research completion under the same spec, not release completion.

## 4. Planning verification and review

- Draft base: merged PR #68 `7fe8cbb80489664eb6ea56917c795cb9a17233cb`. Root main synchronized; unrelated scratch/old worktrees preserved. No live host, implementation, spec/production/config edit, commit, push or PR in this drafting session.
- Fresh drafting baseline: `npm ci --ignore-scripts` succeeded without dependency-file changes (three high-severity npm audit advisories disclosed, not adjudicated or fixed). `npm run test:shell-research`: **451/451**, 46 suites, zero failures/skips; `node --test tests/test-selection.test.mjs`: **6/6**; tracked LF check: **535 files**. Full routine `npm test` was not rerun for this plan-only draft; these are not future implementation or installed-wait results.
- Independent read-only review: `config_path_a_plan_review` checked the full plan, report §14–14.1 and inherited spec/closed-plan boundaries, actual evidence/driver/fixture seams and research selection. Verdict: no blocking P1/P2. Two nonblocking precision suggestions were incorporated: explicitly permit a capped fixed-schema syntax/decision relationship tree without private token/AST disclosure, and clarify that unknown admission blockers do not cancel the already registered one-cause D1 diagnostic branch. The same independent reviewer narrowly rechecked both corrections and confirmed sufficient, with no unresolved findings. No host or live probe was launched by that review.
- Main self-review checked task/option/API consistency, exact finite budgets, schema sufficiency/privacy, new-helper executing-byte attribution, explicit model-selection limits, no historical reconstruction, raw-directive/output semantics and unchanged spec §8 production gates. New diagnostic/model/config options and helper are clearly proposed, not present in merged code.
- Final draft verification: direct LF/final-newline/trailing-whitespace check and all three local Markdown links passed; `git diff --check` passed; tracked implementation/spec/production/dependency diff against merged base is EMPTY. Only the new plan and three unstaged drafting scratch files exist as additions. All live-execution checkboxes remain open; execution requires user delegation. No working-branch commit, push or PR was created.
