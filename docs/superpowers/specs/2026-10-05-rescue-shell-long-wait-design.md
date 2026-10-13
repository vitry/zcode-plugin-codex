# Native Shell Long Wait for Managed Rescue

Status: planning authorized by the user on 2026-10-05; independent spec review completed with no blocking P1/P2 findings. This is a focused qualification design, not authorization to change shipped behavior or user configuration. No new live measurements have been performed for this design; no commit, push or PR is authorized by this document.

## 1. Goal and decision

Reduce model re-entry while ZCode work is running by using Codex's existing shell observation tools with a longer observation window. Preserve the existing Companion implementation, private preparation, exact binding, placement, background execution, public results and lifecycle behavior.

First qualify the actual managed `zcode-rescue` Child, including its effective configuration and delivered instructions. Root-only or synthetic-Role observations do not qualify that Child. Also assess the same policy on Root-owned Review, Adversarial Review and Status `--wait`, without moving those commands into a subagent.

This work does not reopen the MCP investigations. A successful shell qualification does not qualify MCP or change its recorded release-blocked state. A qualification PR remains research-only; a later user decision is required before shipping the demonstrated policy/configuration changes.

## 2. Baseline and prior findings

The user merged PR [#65](https://github.com/vitry/zcode-plugin-codex/pull/65). This worktree was created after `git fetch origin`, from remote main at `6638878e910154d7d1bc4effd4c9aa62f149f23a`:

- Branch: `docs/rescue-shell-long-wait`.
- Worktree: `.worktrees/rescue-shell-long-wait`.
- Preserve unrelated scratch files in the parent repo and other worktrees.
- The authoritative prior record is [source-guided foreground wait](../../qualification/source-guided-foreground-wait.md), especially sections 2, 7.3, 7.5, 7.7, 7.8 and 7.10. Its historical observations and uncertainty labels must remain unchanged.
- Existing product requirements R1–R8 are inherited from [the previous design](2026-09-30-source-guided-foreground-wait-design.md#4-unchanged-product-requirements). Existing canonical code and Skill contracts resolve details that older designs have subsequently changed; for example, new Rescue preparation currently emits version 5. This work introduces no preparation schema change.

Drafting baseline checks on 2026-10-05: `npm ci` completed without dependency-file changes. `npm test` ran 3395 tests: 3391 passed, three skipped and one failed because this draft was created before the clean-tree marketplace check ran. The failure was reproduced as `Marketplace source tree must be clean, including tracked and untracked files.` After temporarily moving only this newly created draft out, `node --test tests/integration/marketplace-install.test.mjs tests/integration/marketplace-snapshot-build.mjs` passed all three tests; the draft was then restored. This is an explained drafting-order failure with a passing focused recheck, not a claim that the complete `npm test` command was rerun green. Future snapshot checks must run against a clean exact source without committing documents merely to satisfy a test.

What has already been established:

| Evidence | Finding | Limit of that finding |
| --- | --- | --- |
| Source-confirmed at `67727e7cf114cf3e1b71db368d74b24e32f6cb12` | Empty `write_stdin` observations use a configurable cap; the initial `exec_command` remains capped at 30000 ms. | This source commit was not matched to the installed binary. |
| Installed-observed on CLI 0.160.0, Root | Raising the cap plus a leading `@exec` directive produced a single 384.6-second observation to process exit; one fresh repeat produced 380.1 seconds. | This demonstrates the measured Root surface, not the real managed Rescue Child or a portable wrapper contract. |
| Installed-observed on the same Root surface | Raising only the configuration or only the inner requested yield did not eliminate approximately 31-second model-visible wrapper returns. | A live outer cell may still own a longer inner observation; wrapper returns do not prove the inner cap failed. |
| Source-confirmed at the prior pin | The Role override whitelist excludes `background_terminal_max_timeout`; the built-in awaiter registration is commented out. | The awaiter asset's one-hour declaration is not proof of an active Role or Child configuration inheritance. |
| Not-proven | Actual managed Rescue Child effective cap and long-wait behavior. | A synthetic Role spawn proved only the registration/spawn/child-shell mechanism. |

The previous report records that raw rollouts were deleted with isolated homes. Retained timings remain recorded observations; do not claim new independent re-derivation of missing raw evidence or reproduce the old parser-review campaign.

## 3. Source location and starting references

The Codex source repository is **not** this plugin's `.codex` configuration directory:

- Absolute location: `/Users/zhangzikai/Workspace/Codes/github/codex`.
- From the plugin repository root: `../codex`.
- From this nested worktree: `../../../codex`.

Read it without edits. Record the checkout's actual revision and dirty state before tracing it. Use `git show <recorded-commit>:<path>` for reproducible inspection; never claim a source/binary mapping without establishing it.

Start from these paths at the prior pin; discover renamed paths rather than treating a missing file as a host limitation:

- `codex-rs/core/src/unified_exec/process_manager.rs`: empty/nonempty input clamp and output collection.
- `codex-rs/core/src/config/mod.rs` and `codex-rs/core/src/session/session.rs`: configuration resolution and per-session process manager.
- `codex-rs/core/src/agent/child_config.rs` and `codex-rs/core/src/agent/role.rs`: actual child configuration derivation and Role whitelist.
- `codex-rs/core/src/tools/handlers/shell_spec.rs`: description text versus effective runtime bounds.
- `codex-rs/core/assets/agent/builtins/awaiter.toml`: declaration only; verify registration before drawing runtime conclusions.

Portable pinned references: [empty poll clamp](https://github.com/openai/codex/blob/67727e7cf114cf3e1b71db368d74b24e32f6cb12/codex-rs/core/src/unified_exec/process_manager.rs#L1013), [child configuration](https://github.com/openai/codex/blob/67727e7cf114cf3e1b71db368d74b24e32f6cb12/codex-rs/core/src/agent/child_config.rs#L290), [Role whitelist](https://github.com/openai/codex/blob/67727e7cf114cf3e1b71db368d74b24e32f6cb12/codex-rs/core/src/agent/role.rs#L37).

The [official configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference) documents `background_terminal_max_timeout` as the maximum empty-poll window, default 300000 ms. It does not establish the observed script-wrapper directive as a stable public contract. Check current official documentation if making a new deployment claim.

## 4. Approach and alternatives

Recommended: qualify the combination of a session/user-level cap and an explicitly requested outer/inner long observation, using temporary configuration and temporary instruction changes in an isolated installed-plugin fixture. This is the smallest candidate supported by the previous Root observations; how it reaches the actual Child is still a research task.

Not sufficient as the intended solution: merely replace `60000` with a larger inner `write_stdin` argument, or merely raise the cap. Neither addresses the measured outer-wrapper decision cadence by itself. Keep the existing short-window policy as the comparison baseline, not as evidence of improvement.

Out of scope: patching/building a custom Codex fork, introducing another shell execution engine, hidden polling scripts, MCP adapters, a new binding identity, new watchdogs or a general JavaScript rollout interpreter. If the installed host lacks a supported effective configuration path, record that specific limitation and stop only the dependent qualification; do not invent a bypass.

The previous successful Root experiment used this pair; this example is a candidate to investigate, not an instruction to edit the user's installation:

```toml
# Temporary fixture config only; this is an observation window, not a job timeout.
background_terminal_max_timeout = 3600000
```

```js
// @exec: {"yield_time_ms": 3600000}
text(await tools.write_stdin({session_id: originalSessionId, chars: "", yield_time_ms: 3600000}));
```

`originalSessionId` must be the actual returned handle, never a replacement process or inferred identifier. Runtime ceilings and higher-priority host instructions still apply. A Skill can request this policy, but cannot force model adherence or change a host cap. Do not hide multiple polls inside one script to manufacture zero model decisions.

## 5. Unchanged requirements

These requirements retain the original functional goals. The shell solution aims to reduce intervention frequency, not promise one infinite wait, zero decisions across an entire job, or guaranteed prompt obedience.

S1. Keep existing launcher/Companion entry points, Root semantic fresh/resume selection, Role preflight, task-free Child assignment, one-shot private preparation and exact atomic binding checks. Wrong/stale executor, duplicate, cross-workspace/worktree and permission rejection remain unchanged. No new `_meta`, workspace field or binding mechanism is required.

S2. Start at most one mapped Companion process for the authorized Child assignment. Observe only its original handle, with empty input during terminal observation. Preserve the separate nonempty private preparation frame used before Child launch; the empty-input rule must not break preparation. Preserve outer-cell continuation without issuing another inner poll while one is pending. Partial output, a completed outer cell or an expired observation window is never process completion.

S3. Preserve byte-for-byte terminal public stdout, stderr/progress ownership, exit/error semantics, needs-choice, exact same-child resume, parent-replan and queued acknowledgement. Do not change a renderer or summarize a result to accommodate long waits. A project command failure inside ongoing ZCode work is not Companion termination.

S4. Preserve the placement matrix:

| Branch | Host placement | Companion execution | Required behavior |
| --- | --- | --- | --- |
| Explicit `--background` | background | foreground | Root acknowledges the exact launched Child without joining; Child observes Companion to terminal. |
| Explicit `--wait` | foreground | foreground | Root joins the exact Child; Child observes Companion to terminal. |
| Small bounded no-flag task | foreground | foreground | Same exact Child join and terminal observation. |
| Complex no-flag task | foreground | background | Existing detached runner and queued acknowledgement; no new terminal observation loop. |

Review/Adversarial Review background remains enqueue-only. Status `--wait` remains observation of the explicitly selected owned job: ending that wait must not cancel the job. Preserve ownership, redacted `--all`, explicit Status timeout, and recovery guidance.

S5. Preserve existing explicit interruption, Child-loss reconciliation, host/process loss, configured operation timeouts and the 100-hour safety ceiling. A long observation window is not a new operation timeout. Introduce no six-hour ceiling or inactivity detector. Do not claim that the earlier driver's budget kill proves native user interruption; directly qualify interruption during the pending observation. Unrelated work must survive.

S6. Keep named and generic Rescue paths behaviorally aligned. Do not select a generic fallback to manufacture success when the host recognizes but rejects the named Role. Keep exact initial/choice assignment and preparation authority intact; only a later approved waiting-policy change may amend the generic message's wait instructions and matching contracts.

S7. Production configuration, canonical Skills, Role templates, installed caches, marketplace snapshots and `../codex` remain unchanged in this qualification stage. Temporary fixture edits are permitted and must be recorded as such. No global configuration edits, auto-promotion or release authorization follows from a passing probe.

## 6. Open questions become tasks

Q1. Which installed host path actually launches the managed Rescue Child, and which configuration layers reach its process manager? Trace native spawn/configuration code and the installed plugin flow. `scripts/lib/codex-config.mjs` setup/inspection clients are not evidence of managed-Child inheritance.

Q2. Can that actual Child request and receive the longer observation with both the named Role and the supported generic route? Verify the delivered installed instructions, not only repository text. A generic route unavailable under the active schema may be labelled unavailable; do not falsify a Role rejection or pretend that a synthetic Child is the production route.

Q3. Does the effective policy reduce model-visible observation re-entry compared with the existing 30000/60000 policy? Record requested versus actual directives/yields, each outer return, pending inner calls, exact process ownership, remaining worker lifetime and process exit. A raised-cap trial must start its decisive poll with at least the measured unraised/default configuration cap plus 30000 ms remaining (330000 ms for the previously observed five-minute cap); otherwise it cannot distinguish cap behavior and is inconclusive. That default-cap reference is distinct from the cap-matched current-instruction control used to isolate the policy change. If the current host's default differs, size the harmless trial accordingly rather than hard-coding the old duration. Run one discriminating long trial and one fresh repeat, not an unbounded statistical campaign. Record model nonadherence as an outcome rather than retrying it out of the record.

Q4. Does ordinary progress/noisy stderr cause extra intervention or corrupt terminal delivery? Can native explicit interruption during a pending long observation reach the existing stop/reconciliation path, with owned settlement and no collateral cancellation? Test separately from external probe-budget expiry. Record real signal delivery, pending status and final settlement; scheduled-but-unsent interruption is not evidence. Preserve the exact trimmed no-argument Child Status intents and the one observational sidecar permitted only between polls. Record any delayed response opportunity under long observation; never run a parallel poll or replace terminal observation with Status to reduce that delay.

Q5. Are Root-owned Review, Adversarial Review and Status `--wait` eligible for the same demonstrated policy? Use their real command entry points and harmless dependencies. Preserve background and Status observation-only semantics; root shell support by itself is not command-specific qualification.

Q6. What is the smallest supported deployment change, and which versions/surfaces would it cover? Discover whether setup guidance, an opt-in configuration step, instruction edits or another already-supported configuration seam is needed. Do not preselect an unverified Role-file config field or silently edit user config. If different host versions expose different wrappers, describe the actual supported/fallback behavior instead of declaring the old pragma universal.

## 7. Evidence and safe experiment boundaries

- Use the real installed Codex and the production Rescue preparation/spawn/launcher/binding flow in an isolated workspace. A harmless fake ZCode dependency may supply a bounded delayed outcome through existing test seams; it must not replace Companion authority. A bare spawned Child running a delay script is a mechanism control only.
- Reuse `tests/e2e/codex-skills-e2e.test.mjs`, `tests/fixtures/fake-zcode-cli.mjs`, `tests/helpers/rescue-skill-contract.mjs`, `tests/helpers/installed-rescue-lifecycle-contract.mjs` and existing binding/lifecycle tests where suitable. The existing E2E helper pins supported versions and fixed 60-second expectations; inspect and record those limits rather than silently relaxing the canonical qualifier to accept a new policy.
- Keep new timing/live qualification explicitly opt-in and separate from ordinary functional tests. Existing MCP research isolation and selection contracts remain intact. Reuse harmless worker/cleanup utilities if suitable, but keep new verdicts in a small shell-specific instrument, not thousands of additions to the old mixed MCP probe or its parser.
- Pin actual CLI executable/version, source revision, plugin artifact provenance, model, configuration layers, Role/instruction variant and exact case duration. No frozen dependency version or source snapshot proves the installed host version.
- Allow temporary installed-artifact/instruction variants for the A/B trial; clearly distinguish unmodified baseline from candidate fixture. Do not patch the user's active plugin cache or launch writable/provider work against user projects.
- Keep a bounded, private, redacted transcript excerpt containing the decisive actual tool calls, timing and terminal result linkage before isolated-home cleanup. A concise report and small structural case record suffice. Do not persist tasks, credentials, private preparation/capability data or an entire private rollout for convenience.
- Count outer waiting decisions separately from Root child joins and Child shell observations. Missing/truncated/unknown evidence is inconclusive, never zero. Manually adjudicate an unsupported observed shape; no general interpreter is required.
- Source-confirmed, fixture-tested and installed-observed are distinct labels. Native Child configuration, model adherence, interruption and other command surfaces each need their own conclusion. An unknown mechanism within scope is an agent investigation task, not a request for the user to design it.
- Investigate one concrete cause-directed follow-up for a failed/inconclusive live case; do not turn this into an open-ended host qualification campaign. Report blockers precisely and continue independent tasks. Actual credentials, authority for provider writes, or a materially expanded scope require user direction.

## 8. Acceptance and deliverables

The qualification is complete when a report answers Q1–Q6 with recorded evidence or precise not-proven reasons and maps S1–S7 to retained invariants, fixture regressions and actual installed observations. Completion of research is not completion of production rollout.

A positive managed-Rescue recommendation requires the actual Child route, a discriminating long observation and repeat, reduced re-entry under the observed policy, exact handle/terminal linkage, and observed native interruption/settlement. Separate inherited contract coverage from newly measured behavior. Do not demand a literal 100-hour live run; do preserve and exercise the production safety-ceiling semantics through existing controlled tests. Root command recommendations are scoped separately.

Deliverables after approval:

1. A task-by-task qualification plan with exact file responsibilities, commands, bounded live cases, opt-in isolation and evidence retention.
2. `docs/qualification/rescue-shell-long-wait.md`: provenance, Child configuration trace, A/B observations, lifecycle/result/placement compatibility, other waiting commands, limitations and smallest proposed production delta.
3. Only the minimum isolated fixture/instrument changes needed for those cases, with focused regression tests for instrument ownership and verdict correctness.
4. A human adoption decision and, only if requested, a subsequent production change plan. Any public-facing rollout must retain the original goals rather than lower them to fit a host limitation.

## 9. Draft self-review

- [x] Prior Root proof is distinguished from unknown managed-Child behavior.
- [x] Awaiter asset and Role config are not used as inheritance proof.
- [x] Unknown mechanisms are research questions, not mandatory undocumented APIs.
- [x] Binding, results, placement, background and lifecycle goals remain unchanged.
- [x] Private preparation writes are distinguished from empty terminal observation.
- [x] Review, Adversarial Review and Status `--wait` are included without reopening MCP.
- [x] No production change, automatic commit or canonical promotion is authorized.
- [x] User authorized plan completion and independent subagent review on 2026-10-05.

## 10. Independent review record

On 2026-10-05, the separate read-only subagent `shell_wait_spec_review` reviewed this spec against the prior report, inherited R1–R8 and current Rescue Skill/Role. Result: no blocking P1/P2 findings. Its one nonblocking suggestion, preserving between-polls-only Child Status sidecar semantics and documenting latency, is incorporated into Q4 and the plan. A narrow final recheck of Q3/Q4 and review status also found no blocking findings. This is document review, not live host qualification.
