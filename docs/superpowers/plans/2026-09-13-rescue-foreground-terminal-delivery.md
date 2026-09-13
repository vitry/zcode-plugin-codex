# Rescue Foreground Terminal Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Do not start implementation merely because this plan exists.

**Goal:** Reduce foreground Rescue model resumptions by removing routine Root progress relay and enforcing long original-handle waits while preserving terminal and lifecycle behavior.

**Architecture:** The companion records progress and observes the engine. The child waits for its original command and returns terminal stdout; Root waits for native child completion. Background remains on its existing detached runner path.

**Tech Stack:** Node.js ESM, node:test, Codex agent TOML templates and skill Markdown, existing transcript qualification and marketplace snapshot tooling.

**Spec:** [Foreground terminal delivery design](../specs/2026-09-13-rescue-foreground-terminal-delivery-design.md).

---

## Execution boundaries

This is an implementation-ready plan, not a record of completed changes. Work in an isolated checkout when implementing. Preserve unrelated existing files, including root-level planning notes. Do not edit sibling `codex` or `codex-plugin-cc`, global configuration, or installed cache directly. Stage only task-owned files for any implementation commits.

Before edits, run `git status --short` and inspect current versions of the listed seams. Existing authorization, role hash, lifecycle, and exact terminal checks must continue to pass. Read the project's applicable instructions. If tool bounds or higher-priority host cadence rules prevent the preferred waits, record that constraint in live qualification rather than weakening the semantics silently.

## Task 1: Revise forwarder and Root contracts together

**Files:**
- Modify: `agents/zcode-rescue.toml.template`
- Modify: `skills/rescue/SKILL.md` (generic assignment and parent supervision)
- Modify: `tests/helpers/rescue-skill-contract.mjs`
- Modify: `tests/helpers/installed-rescue-lifecycle-contract.mjs`
- Modify: `tests/skills-contracts.test.mjs`

- [x] Replace the live-relay contract test with a terminal-supervision test for both named and generic bodies. Keep the existing route extractors and exact assignment comparison. Assert the new long-wait, original-handle, explicit-status, outer-cell, and terminal-return requirements. Remove obsolete required relay-map markers; keep privacy and no-independent-execution assertions.
- [x] Use the following text in both forwarder bodies and matching expected-message fixtures; remove the old relay parsing/code-map paragraphs rather than appending contradictory instructions:

```text
Do not send routine progress, heartbeat, or phase messages to Root. Detailed progress is owned by the companion's stderr and durable status/log pipeline; do not interpret or summarize it. The native child completion mechanism delivers your terminal result to the parent.

Observe only the original running process handle. For empty-input write_stdin calls request yield_time_ms: 300000 when supported; otherwise use the longest wait allowed by the active tool bounds and higher-priority instructions. For the initial exec_command request the longest permitted yield up to 30000 ms. Never replace waiting with sleep, periodic status, or another execution.

If an outer code cell yields while an inner observation is pending, continue only that outer cell with its continuation tool and the longest permitted wait. Do not issue another inner poll until the pending call finishes. A completed outer cell alone is not proof that the companion exited.
```

- [x] Preserve the existing one-command-per-turn, exact status sidecar, needs-choice, same-child continuation, unsuccessful command outcome, and byte-for-byte terminal stdout paragraphs. Replace references to “optionally relaying” with same-handle observation. Do not weaken the rule that partial output is nonterminal.
- [x] Replace the Root wait example with:

```text
wait_agent({ timeout_ms: 600000 })
```

Add this parent policy adjacent to the example:

```text
Use the longest permitted native wait if active bounds or higher-priority instructions require a different interval. Do not use periodic sleep, list_agents, or status calls solely to check liveness. On timeout or unrelated mailbox activity, continue waiting for the same rescueChildPath. Inspect the exact child only when route discovery or lifecycle reconciliation requires evidence. Do not expect ordinary progress messages; native child completion/error delivery and the original execution remain authoritative. Background acknowledgement ends runner supervision as specified above.
```

- [x] Update installed lifecycle contract marker checks and mutations to exercise these new requirements without bypassing assignment hashes, privacy checks, or terminal checks. Remove obsolete positive requirements for send_message and relay validation from `tests/skills-contracts.test.mjs`, including its 30000 Root-wait assertion.
- [x] Run `node --test tests/skills-contracts.test.mjs tests/plugin-contracts.test.mjs`. Confirm contract changes fail against old instructions first, then pass with both routes updated. Do not treat textual tests as runtime performance proof.

## Task 2: Stop production Rescue CLI relay wiring

**Files:**
- Modify: `scripts/zcode-companion.mjs`
- Modify: `tests/e2e/codex-skills-e2e.test.mjs` (existing CLI-backed fixtures and qualification expectations)
- Test unchanged observer behavior: `tests/job-control.test.mjs`, `tests/progress.test.mjs`

- [x] Extend the existing direct Rescue CLI fixture to capture stdout and stderr through the actual CLI entry, emit structured progress before terminal success, and inspect the stored job log/preview. Required observations: detailed `[zcode]` output survives; no `[zcode-relay]` line is delivered; terminal stdout equals the expected public output; archive and preview still contain accepted progress. Run it against old wiring and confirm the relay-output assertion fails. Do not use `executeJob` with an omitted relay callback as a substitute for driving the CLI wiring.
- [x] In `scripts/zcode-companion.mjs`, remove the `serializeRescueProgressRelay` import and the `rescueDirect` variable if its sole remaining use is the deleted writer. Remove only this member from `foregroundProgress`:

```js
...(rescueDirect ? { progressRelayWriter: (record) => process.stderr.write(serializeRescueProgressRelay(record)) } : {}),
```

Keep this member and the existing signal/preparation members:

```js
progressWriter: (line) => process.stderr.write(line),
```

- [x] Leave `scripts/lib/progress.mjs`, `scripts/lib/rescue-progress-relay.mjs`, and explicit programmatic relay injection semantics intact. Existing library tests may still verify repeated heartbeat relays for an explicitly supplied observer; that does not mean production forwards them.
- [x] Run `node --test tests/progress.test.mjs tests/rescue-progress-relay.test.mjs tests/job-control.test.mjs`. Run the modified CLI-backed fixture through its existing qualification entry. Report any environment skip; it is not a pass of the CLI delivery requirement.

## Task 3: Qualify actual wait behavior and terminal-only delivery

**Files:**
- Modify: `tests/helpers/codex-rescue-qualification.mjs`
- Modify: `tests/codex-rescue-qualification.test.mjs`
- Modify: `tests/e2e/codex-skills-e2e.test.mjs`
- Modify as needed for changed marker outputs: `tests/helpers/installed-rescue-lifecycle-contract.mjs`

- [x] Replace mandatory `requireProgressRelay: true`/`progressRelayChecked` success criteria in foreground qualification with evidence of terminal delivery and quiet supervision. Use explicit fields on qualification results:

```js
// New foreground qualification result fields; populate from parsed evidence.
terminalDeliveryChecked: true,
quietSupervisionChecked: true,
```

`quietSupervisionChecked` may be true only if observable evidence covers the live interval and satisfies the policy. Missing, opaque, or encrypted arguments cannot prove compliant wait parameters. Return the existing unqualified/evidence-mismatch outcome with a specific reason rather than treating missing events as zero activity.

- [x] Add synthetic transcript cases using the existing fixture constructors: long inner wait + terminal exit succeeds; short inner wait without host-bound evidence fails; routine progress send fails; Root sleep/liveness-query cycle fails; outer yield followed by same-cell continuation succeeds; a second inner poll while the first is pending fails; final-before-exit fails. Preserve exact command/child identity checks. Explicit status and lifecycle-required inspection remain allowed.
- [x] Parse direct tool calls and existing code-mode wrapper forms through the current parser. Never execute transcript code to recover arguments. Supply fixture tool-bound evidence for legitimate shorter waits. Count requested inner calls, outer waits, mailbox notifications, and actual elapsed waits separately; do not equate a requested 1000 ms to effective 1000 ms when the host clamps it.
- [x] Retain and run existing needs-choice/resume/fresh, restored-child, prepared-continuation, privacy, and background qualification cases. Update old progress-relay fixture expectations to the new production behavior rather than disabling whole suites.
- [x] Run `node --test tests/codex-rescue-qualification.test.mjs tests/skills-contracts.test.mjs`. Expected: new negative traces rejected and compliant traces accepted, with existing identity and lifecycle cases intact.

## Task 4: Update user-facing documentation and distribution

**Files:**
- Modify: `README.md`, `README.zh-CN.md`, `CHANGELOG.md`
- Generated: `marketplace/plugins/zcode/**` and builder-owned provenance

- [x] Replace current README claims that Root receives coarse liveness with this behavior, translated consistently in Chinese:

```text
Foreground Rescue records detailed progress in the child terminal and durable job state. The child returns the original command's terminal public output, and native child completion notifies Root. Routine progress and heartbeat messages are not forwarded to Root. Explicit status remains available; foreground execution stays attached until terminal completion or interruption.
```

Keep the existing detailed stderr heartbeat/log documentation and distinguish it from Root notifications. Explain that plugin long waits remain subject to host bounds. Add an unreleased changelog entry covering the changed foreground progress experience and reduced routine agent polling, without asserting measured savings.
- [x] Do not rewrite historical specs or ADRs. The new spec records the superseding foreground delivery decision.
- [x] Run `node scripts/build-marketplace-snapshot.mjs`, inspect its generated diff, then run `node --test tests/release-contracts.test.mjs tests/integration/marketplace-snapshot-build.mjs`. Verify source and distributed role/skill contracts match. No direct edits to installed caches.

## Task 5: Regression checks and measured Host qualification

- [x] Run `npm run check` after implementation and generated snapshot are consistent. Separate successful checks from skipped qualified tests in the report. Fix failures introduced by this change; do not modify unrelated user work to clear pre-existing failures.
- [ ] Use a fresh loaded role and the project's existing qualified-test environment. Run `npm run test:qualification-required` only with its required environment available; otherwise record live validation as pending. Do not present a skipped environment-gated suite as evidence of token savings.
- [ ] In a controlled scratch workspace, use the existing CLI/host fixture path to hold a foreground run live for at least six minutes with progress and silence intervals. Compare the baseline and changed version with the same host/model/context setup. Do not spend a production coding-engine run merely to simulate waiting when the existing controlled fixture suffices.
- [ ] Record: effective tool bounds; startup call count; inner terminal observations; outer cell continuations; routine send_message count; Root wait/sleep/list/status counts with purposes; completion timestamp; final stdout equality; input/cached/output/reasoning deltas. Exclude setup, explicit status, unrelated mailbox activity, and recovery work from the unforced-poll count, but retain them in the raw aggregate.
- [ ] Accept only when routine child progress sends and Root periodic liveness polling are zero, child waits follow the effective long-wait policy, terminal output remains exact, and the model-resumption count is lower than the matched baseline. If higher-priority host rules force frequent outer returns, report the remaining constraint and do not claim the host is fully quiet.
- [x] Verify explicit live status, terminal error, choice continuation, cancellation, and Host child-loss behavior through the existing fixture cases. Re-run `node --test tests/integration/true-background-rescue.test.mjs tests/rescue-child-reconciliation.test.mjs tests/rescue-lifecycle.test.mjs` to verify enqueue acknowledgements, runner lifetime, and cancellation authority remain intact.
- [x] Finish with the actual changed files, check results, and the live-validation limitation; the measured observations remain pending with the controlled live run. Installation or release is a separate action; do not assume existing live children have loaded changed role instructions.

## Self-review coverage

| Spec requirement | Implementation task |
| --- | --- |
| Named/generic long waits and Root quiet supervision | 1, 3 |
| Runtime progress retained without direct relay | 2 |
| Original-handle and outer-cell semantics | 1, 3, 5 |
| Terminal, choice, explicit status, cancellation, child loss | 1, 3, 5 |
| Background unchanged | 1, 3, 5 |
| Distribution and current docs | 4 |
| Actual performance evidence and host limitations | 5 |

## Validation record

Tasks 1-4 and the runnable parts of Task 5 are implemented and validated on branch `feat/rescue-foreground-terminal-delivery` (baseline `bd15b07`) in commits `86c750f` (Task 1), `128e6e0` (Task 2), `08cfeb6` (Task 3), and `a6eaf4a` (Task 4, including the regenerated marketplace snapshot and CHANGELOG entries). Focused suites at the delivery commit: `node --test tests/skills-contracts.test.mjs tests/plugin-contracts.test.mjs` (48 pass, 0 fail), `node --test tests/progress.test.mjs tests/rescue-progress-relay.test.mjs tests/job-control.test.mjs` (245 pass, 0 fail), `node --test tests/codex-rescue-qualification.test.mjs` (160 pass, 0 fail), `node --test tests/release-contracts.test.mjs tests/integration/marketplace-snapshot-build.mjs` (36 pass, 0 fail), and `node --test tests/integration/true-background-rescue.test.mjs tests/rescue-child-reconciliation.test.mjs tests/rescue-lifecycle.test.mjs` (110 pass, 0 fail). `npm run check` passes at the delivery commit: LF line endings across 475 tracked files, lint, typecheck, the full suite with `--test-concurrency=1` including the marketplace-snapshot-build integration, and `test:qualified` with exactly the three opt-in live tests skipped as designed (59 pass, 0 fail, 3 skipped). Live validation is PENDING and remains a release condition: no qualified environment was available, so `npm run test:qualification-required` was not run, the six-minute controlled live run and the matched-baseline token measurements were not performed, and Task 5's qualification, measurement, and acceptance items above stay unchecked. The criterion-to-evidence map and the skip report are recorded in the spec's Acceptance validation section: `docs/superpowers/specs/2026-09-13-rescue-foreground-terminal-delivery-design.md`. Installation or release is a separate action; existing live children have not loaded the changed role instructions.
