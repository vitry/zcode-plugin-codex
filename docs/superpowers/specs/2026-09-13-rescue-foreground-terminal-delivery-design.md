# Rescue foreground terminal delivery and long waits

Date: 2026-09-13
Status: implemented on `feat/rescue-foreground-terminal-delivery` (baseline `bd15b07`); the static contract, recorded-evidence qualification, and regression criteria below are verified by the named tests recorded in the Acceptance validation section at the end of this document, while the controlled live host run, matched-baseline token measurements, and the opt-in qualified-environment suites remain pending because a qualified environment was not available at delivery. Baseline: `bd15b07`.

## Decision

Keep foreground Rescue attached to its original Rescue Child and companion process. Remove routine progress forwarding to Root and use long native waits at both agent layers. The companion owns progress recording and authoritative terminal detection; the child returns terminal public stdout; native child completion wakes Root.

This adopts the thin-forwarder responsibility split in `../codex-plugin-cc`, without assuming Claude Bash and Codex terminal tools have identical lifetime semantics. It does not convert foreground into background.

## Evidence and problem

The inspected `tmp/zcodeplugin` job created at 2026-09-13T04:28:38Z has `hostPlacement: foreground`. In the approximately 7.5-minute window beginning 04:28:31Z, the child made 50 `write_stdin` calls and four `send_message` calls; Root made two `wait_agent`, 17 `sleep`, and three `list_agents` calls. The child requested 1,000 ms terminal waits. The inspected Codex implementation clamps empty terminal polls to at least 5,000 ms. These are requested waits, not evidence of one-second effective polling.

Root's requested 30-second waits were clamped to the configured 600 seconds, but mailbox activity returned them early. Subsequent short sleeps bypassed that setting. Reported cumulative token deltas were dominated by cached input; they are not a billing estimate or proof of extensive reasoning. The final child notification reported a usage limit.

Today `agents/zcode-rescue.toml.template` and the generic assignment in `skills/rescue/SKILL.md` require model-side relay parsing. `scripts/zcode-companion.mjs` wires a relay writer into direct Rescue entry points. `scripts/lib/progress.mjs` emits repeated eligible 20-second heartbeat relays. Removing messages alone would leave the short child poll loop intact.

## Goals and non-goals

Goals:

- Reduce child and Root model resumptions during otherwise uneventful foreground execution.
- Preserve exact terminal stdout, authoritative failures, needs-choice, continuation, user cancellation, and Host lifecycle handling.
- Preserve detailed stderr, durable progress logs, progress previews, and explicitly requested status.
- Apply identical supervision rules to named and generic forwarders.

Non-goals:

- No Codex host changes, non-LLM agent type, new daemon, new transport, or new user configuration.
- No automatic migration to background; no background execution or completion-discovery redesign.
- No promise of zero model calls, an exact percentage of token savings, or instant process completion delivery through every host wrapper.
- No deletion of the reusable relay codec/reporter capability or historical ADRs as incidental cleanup.

## Foreground sequence

1. Root prepares and selects the exact existing named/generic route using the current authorization and binding rules.
2. Child invokes its one fixed mapped companion command. No second execution is introduced.
3. Companion observes ZCode and persists progress as today. Its direct Rescue CLI does not install `progressRelayWriter`; detailed `progressWriter` and signal handling remain intact.
4. Child observes only the original process handle with long empty-input terminal waits. A running handle, partial output, heartbeat, or outer cell completion is nonterminal.
5. Original command exit settles this child interaction. Return terminal public stdout byte-for-byte, including unsuccessful outcomes and exit-code-3 needs-choice. Do not infer completion from words such as “done,” “finalizing,” or a failed project test.
6. Native child completion/error notification wakes Root. Root selects the exact child and uses existing terminal-result or lifecycle-reconciliation handling. Host child failure is not automatically ZCode terminal success or failure.

## Wait policy

### Child

- Request 300,000 ms for empty-input `write_stdin` observations when supported. If the advertised host bounds or higher-priority session rules require a lower maximum, use the longest permitted wait, not an arbitrary short polling interval.
- Initial `exec_command` uses the longest permitted initial yield, up to 30,000 ms in the inspected host. Startup responsiveness and original-handle ownership remain unchanged.
- If an outer code cell yields while the terminal call remains pending, resume that outer cell with its continuation tool. Never start a second inner terminal poll while the first remains in flight. Use the longest permitted outer wait as well.
- After a genuine nonterminal tool return, continue the same handle without a sleep, status query, progress interpretation, or unsolicited message. Respect explicit user status at the existing between-polls boundary; this does not authorize another Rescue invocation.
- Preserve stderr. Do not discard terminal stdout or reduce its output budget merely to save tokens. Existing truncation/terminal-output correctness remains a qualification requirement.

### Root

- Replace the 30,000 ms sample with `wait_agent({ timeout_ms: 600000 })`. Adapt to advertised bounds and higher-priority session rules where necessary.
- No periodic `sleep`, `list_agents`, or status calls solely to check liveness. Existing route discovery and evidence-based child-loss reconciliation may still inspect the exact child.
- On timeout or unrelated mailbox activity, resume the same child's wait. A timeout is not permission to respawn, follow up, cancel, or claim completion.
- Do not send periodic “still waiting” commentary solely to create a progress cadence. If higher-priority host instructions require periodic updates or shorter waits, obey them and report the resulting qualification limitation; plugin prose cannot override the host.

## Progress and status

Foreground detailed stderr, structured observation, archival logs, and status previews remain program-owned. Ordinary progress, starting, waiting, and finalizing records do not produce child-to-Root `send_message` calls. No separate terminal relay is needed: the child's final result already has native delivery.

Remove the relay parser and message-map instructions from both forwarder routes. Do not replace them with instructions to summarize stderr. Preserve the exact explicit status sidecar and its privacy/output constraints. Its response is observational, remains in the requesting transcript, and never substitutes for final stdout. Status requested during a long poll may wait until the poll boundary; do not promise instantaneous status. Cancellation and session-end handling continue through existing runtime/lifecycle mechanisms.

Keep the optional internal reporter relay capability and its tests for other explicit callers. Only the production direct Rescue CLI stops wiring it. This keeps the change localized and avoids conflating observer-library behavior with host delivery policy.

## Background invariants

Background continues to reserve a job, spawn one session-bound detached runner, return queued, and end the enqueue child interaction. Root may wait for delivery of that initial acknowledgement if needed, but must not supervise the runner afterward. Status/Result and UserPromptSubmit unread-result discovery remain unchanged. No foreground wait policy is applied after a background acknowledgement.

## Alternatives

1. **Chosen: terminal delivery plus long waits.** Small runtime change and coordinated agent/qualification changes; removes the unnecessary relay responsibility.
2. **Rate-limited Root progress.** Retains extra model work and a timing policy despite no need for it in the agreed foreground experience. Defer unless explicitly requested.
3. **Host-native non-LLM forwarder.** Could eliminate periodic model supervision but requires Codex host work; outside this plugin change.

## Verification and acceptance

- CLI-path integration: direct foreground Rescue produces detailed progress and identical terminal stdout without dedicated relay lines; logs and previews still update.
- Agent contracts: named and generic routes specify long waits, original-handle ownership, no routine send_message, and exact terminal return. Root contract uses long waits without periodic liveness queries.
- Recorded evidence qualification: reject routine progress messages and unforced short polls; recognize empty polls both directly and inside code-mode wrappers; distinguish outer-cell continuation from inner polling. Reject overlapping polls and final-before-process-exit. Explain host-bound exceptions rather than silently passing them as fully optimized.
- Exercise successful terminal delivery, nonzero terminal failure, exit-code-3 choice and same-child continuation, explicit status while live, cancellation, child loss, and existing background enqueue/runner behavior.
- Controlled host run lasting at least six minutes: no routine child progress messages and no Root liveness polling. Measure actual inner and outer returns separately. In a host with 300-second effective inner waits and no interruptions, approximately `ceil(live observation duration / 300 seconds)` inner observations are expected, plus startup/boundary effects; this is not a portable exact count.
- Record input, cached input, output, and reasoning token deltas separately. Compare equal-duration runs under the same model, host, and context conditions. Do not attribute all counter changes to billable cost.
- A static contract test proves instructions were shipped, not that an LLM obeys them. Live qualification is required before claiming the token issue resolved. Skipped live tests must be reported.

## Distribution and compatibility

Update source contracts, their mirrored generic assignment, installed-role qualification, live evidence fixtures, and current English/Chinese documentation together. Regenerate `marketplace/plugins/zcode` through the existing snapshot builder, not hand edits. Existing instantiated agents may retain old instructions; qualify a newly loaded role. Preserve existing continuation evidence and role trust checks. Do not modify the user's global Codex timeout configuration, install a plugin, or disturb active sessions as part of writing these documents.

## Scope of delivery

Implementation plan: `../plans/2026-09-13-rescue-foreground-terminal-delivery.md`. Implementation is delivered on `feat/rescue-foreground-terminal-delivery` and recorded in the Acceptance validation section below. This document does not claim deployment or live performance validation has occurred: the controlled live host run, the matched-baseline token measurements, and the opt-in qualified-environment suites are pending because a qualified environment was not available at delivery; the opt-in live tests remain gated, and a skipped environment-gated suite is not evidence of token savings.

## Acceptance validation

Validated on branch `feat/rescue-foreground-terminal-delivery` (baseline `bd15b07`) by the delivery commit's runs. Evidence per verification item above (test file — test name — what it proves):

1. CLI-path integration: `tests/e2e/codex-skills-e2e.test.mjs` — "installed continuation capture qualifies one parent turn from origin hooks into a linked execution worktree" — drives the actual direct Rescue CLI entry and proves the terminal stdout is exactly the public result, no `[zcode-relay]` line reaches any terminal stream, detailed `[zcode]` progress still survives on stderr, and the durable job logs and previews retain the accepted progress records. `tests/integration/marketplace-install.test.mjs` — the installed named/generic role contracts require the terminal-supervision text ("Do not send routine progress, heartbeat, or phase messages to Root", "The native child completion mechanism delivers your terminal result to the parent"), require verbatim public-stdout return, and reject any `[zcode-relay]` instruction.
2. Agent contracts: `tests/skills-contracts.test.mjs` — "named and generic Rescue forwarders supervise the original handle with long quiet terminal waits" and "named and generic Rescue forwarders keep yielded executions attached through a real exit code" — both routes require long empty-input `write_stdin` waits (300,000 ms requested when supported), original-handle ownership, no routine `send_message`, outer-cell continuation instead of a second inner poll, and exact terminal return; the Root contract keeps exactly one `wait_agent({ timeout_ms: 600000 })` example with the longest-permitted-wait, no-periodic-liveness parent policy, and the old 30,000 ms sample is rejected.
3. Recorded evidence qualification: `tests/codex-rescue-qualification.test.mjs` — "quiet supervision qualifies long inner waits, outer-cell continuations, and native terminal delivery", "quiet supervision rejects routine child progress messages with a specific reason", "quiet supervision rejects Root sleep and unforced liveness queries", "quiet supervision requires the long initial exec yield or explicit bound evidence", "quiet supervision rejects short inner waits without explicit fixture tool-bound evidence", "quiet supervision records applied wait bounds and rejects implausible bound evidence", "quiet supervision rejects unbounded, unlinked, and malformed outer-cell continuations", "quiet supervision resolves a pending poll cell through chained wait continuations", "quiet supervision rejects an inner poll that starts before the pending cell resolves", "quiet supervision rejects duplicate call identities across child host-call families", "quiet supervision requires the long Root wait or explicit bound evidence", and "parses direct tool calls through the same host-call contract as code-mode wrappers" — routine progress sends and unforced short polls are rejected with specific reasons, empty polls are recognized both directly and inside code-mode wrappers, outer-cell continuation is distinguished from inner polling, overlapping polls and final-before-process-exit are rejected, and host-bound shorter waits are recorded as explicit bound evidence rather than silently passed as fully optimized.
4. Scenario coverage: terminal success and nonzero failure — "foreground structured execution requires an exact zero exit code" and "yielded Rescue qualification rejects process replacement, handle drift, input, missing exit, and terminal-order violations"; exit-code-3 choice and same-child continuation — "needs-choice is terminal only with exit code 3 before same-child continuation", "choice qualification validates quiet supervision and optional status within both original-handle segments", and "choice qualification permits exactly one timeout-recovery list_agents under quiet supervision"; explicit status while live — "quiet supervision preserves execution boundaries, terminal integrity, and explicit status allowances" and "Rescue bound status qualification rejects arguments, sibling ownership, and handle substitution"; child loss — the existing `tests/rescue-child-reconciliation.test.mjs` and `tests/rescue-lifecycle.test.mjs` suites pass unchanged (110 pass, 0 fail together with `tests/integration/true-background-rescue.test.mjs`); background enqueue/runner behavior — "qualifies named and generic background Rescue with one linked queued output and no capability leak" plus the unchanged `tests/integration/true-background-rescue.test.mjs` suite.
5. Controlled six-minute live run: NOT performed. No qualified environment was available at delivery; recorded as pending, not as a pass.
6. Matched-baseline token measurements: NOT performed. No equal-duration baseline comparison exists; recorded as pending, and no token-savings claim is made.
7. Static-versus-live honesty: the contract and qualification suites above prove instructions were shipped and parsed evidence satisfies the policy; they do not prove live host obedience. The separately opt-in live tests remain gated and are reported: `tests/e2e/codex-skills-e2e.test.mjs` — "installed marketplace skill crosses a real ephemeral Codex turn into ZCode" (requires `ZCODE_CODEX_SKILLS_E2E=1`) and "installed Rescue uses one isolated native child for initial and choice continuations" (requires `ZCODE_CODEX_RESCUE_E2E=1`), and `tests/e2e/real-zcode.test.mjs` — "real ZCode discovery, two-turn session, read-only Companion, cancellation, model, and history import" (requires `ZCODE_REAL_E2E=1`). They ran skipped in the default suite; live qualification is still required before claiming the token issue resolved.
8. Distribution and compatibility: `marketplace/plugins/zcode` was regenerated through the actual `scripts/build-marketplace-snapshot.mjs` CLI (commit `a6eaf4a`), and `node --test tests/release-contracts.test.mjs tests/integration/marketplace-snapshot-build.mjs` passes (36 pass, 0 fail), so source and distributed role/skill contracts match.

Qualification status: live host qualification is PENDING and remains a release condition. `npm run check` passes at the delivery commit (LF line endings across 475 tracked files, lint, typecheck, the full suite with `--test-concurrency=1` including the marketplace-snapshot-build integration, and `test:qualified` with exactly the three opt-in live tests skipped as designed: 59 pass, 0 fail, 3 skipped). The qualified environment was not available, so `npm run test:qualification-required`, the six-minute controlled live run, and the matched-baseline token measurements were not run; per the verification section, a skipped environment-gated suite is reported, not counted as evidence of reduced model resumptions or token savings.
