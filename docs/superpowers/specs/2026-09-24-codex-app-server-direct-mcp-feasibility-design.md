# Codex App-server Direct MCP Feasibility

Status: investigation design; no direct-call production adapter is authorized or qualified by this document.

## Purpose and baseline

Determine whether `mcpServer/tool/call` can support the existing ZCode foreground workflow through a deterministic plugin entry, trustworthy invocation authority, and reliable lifecycle settlement without periodic model decisions while waiting.

This is the user-approved option B: investigate both protocol behavior and the usable product entry. A working RPC by itself is insufficient. The deliverable is evidence and a recommendation for or against a subsequent production design, not a production bridge.

Baseline: PR [#62](https://github.com/vitry/zcode-plugin-codex/pull/62), head `263bf2f` at drafting. This document is on a separate branch based on that head because the PR remains open. Reconcile the baseline with the actual remote state before implementing the investigation.

Read these existing artifacts rather than duplicating their requirements:

- [Dual-adapter specification](2026-09-18-zcode-dual-foreground-wait-adapters-design.md), especially Non-negotiable release outcomes and Trusted MCP invocation context.
- [Dual-adapter plan](../plans/2026-09-18-zcode-dual-foreground-wait-adapters.md), particularly Tasks 2, 4, 6, and installed qualification.
- [Host qualification report](../../qualification/zcode-mcp-context.md), especially the 0.155.1 transport control.
- `qualification/mcp-lifecycle.json` and `tools/mcp-context-probe/`.

Those artifacts retain their existing release decisions. Findings here cannot automatically qualify the original model-driven path or enable MCP packaging.

## Known evidence and open questions

The prior 0.155.1 run accepted structured Skill input and observed zero MCP captures in both the structured and text-only app-server turns. Its exec path captured six calls. This establishes the observed difference under that fixture and configuration; it does not establish that every app-server model or configuration is incapable of calling MCP tools.

The direct-call control returned `error-result-undetermined-origin`. Server startup was observed; handler entry was not independently instrumented before metadata-dependent validation. Consequently, handler reachability, the origin of that error, and direct-call turn identity remain unknown. An absent capture is not evidence that the handler was never entered.

There is no demonstrated direct-call cancellation result. Earlier SIGINT and timeout observations belong to their recorded paths and cannot be substituted for this path.

Research must distinguish:

- a target thread supplied by a client from an authenticated caller identity;
- a metadata field matching the active turn from authorization to act for that turn;
- tool-call failure or turn completion from downstream execution settlement;
- missing evidence from an observed incompatible behavior.

In particular, echoing the request's `threadId` proves target correlation, not authority. Knowing a turn ID does not authorize a caller. Conversely, absence of a `turnId` request parameter alone does not prove the route unsafe: a supported, trusted host mechanism may establish equivalent per-invocation authority. Such a mechanism must be demonstrated and reviewed before any production design adopts it.

## Scope and deliverables

Produce a disposable probe, tests of its evidence collection and reduction, a redacted qualification report, and a candidate-entry assessment. Reuse suitable existing fixture, observer, process isolation, and cleanup components. Keep new experiment results separate from the original context and lifecycle qualification records.

No real ZCode/provider task, user workspace mutation, production binding consumption, canonical Skill promotion, or production MCP packaging belongs to this investigation. Use synthetic preparations, bindings, and tracked operations in isolated temporary workspaces when testing parity. Codex model turns may be used only for bounded qualification, with their usage recorded.

Unknown host mechanisms are research tasks. The implementation plan must choose and justify how to hold an active turn, reach the owning host, and observe terminal settlement; this spec does not assume that an undocumented callback, metadata field, hook, or bridge is available.

## Four feasibility gates

| Gate | Required evidence |
| --- | --- |
| G1: Handler reachability | A direct RPC produces an independently persisted handler-entry event before metadata validation, attributable to that exact probe request. |
| G2: Invocation authority | A supported caller/host mechanism binds the request to the intended Root/Child, operation, and authorized turn, preserves existing binding/workspace/permission checks, and rejects stale or misattributed requests. |
| G3: Lifecycle | Explicit interruption, host/connection loss, timeout, and the safety ceiling produce the existing required durable outcomes without affecting unrelated work. |
| G4: Product entry and waiting | A user-authorized plugin workflow deterministically dispatches the direct call and delivers the terminal outcome without model-selected MCP dispatch or periodic model waiting decisions. |

Each gate is `proven`, `not-proven`, or `incompatible-under-tested-conditions`, with prerequisites and evidence references. A missing prerequisite or observation ceiling is `not-proven`. A repeatable observation contradicting a specific candidate's required behavior can reject that candidate under the recorded conditions; it cannot reject all possible MCP architectures.

Stop dependent cases when prerequisites fail; still complete safe independent observations and the entry assessment. Do not invent a held invocation merely to exercise an interrupt. All four gates must be proven before recommending a production design. Even then, implementation and release remain subject to that later design and installed-plugin qualification.

## Probe structure and evidence

Use three small responsibilities: a driver that owns the host connection and experiment schedule; a disposable MCP server that records entry and held-call events; and an observer/reducer that persists and classifies evidence. An observation component must not manufacture host identity or supply a missing authorization event.

The first handler action records `handler-entered` independently of metadata presence or correctness. Metadata extraction then records allowed field paths, presence, types, and salted equality candidates. Malformed or absent identity must not prevent the entry event. An instrument-specific nonce/request label may correlate events; it is diagnostic input and must never count as host authority.

Record distinct stages for request sent, RPC response/error, handler entry, metadata inspection, hold started, cancellation/transport event, handler settled, synthetic worker settled, and cleanup. Persist known probe error codes at their origin. Reduce arbitrary host error text to redacted categories; retain `unknown-origin` where attribution is not proven. Server startup, a success-shaped JSON-RPC response, and handler entry are separate observations.

Use private temporary directories and append-only mode-0600 evidence on POSIX, with equivalent restricted access where supported. Persist only allowlisted fields, closed outcomes, counts, relative timing/order, and per-run salted hashes. Raw IDs, paths, prompt text, credentials, full metadata, response bodies, and private environment values must not enter retained logs. Version and non-sensitive model/configuration identifiers are provenance, not identity values. Raw identity may be held transiently to issue protocol requests; clear it with the isolated run.

Provenance includes exact Codex version and binary identity, model/effort where applicable, platform, SDK version, source commit, sanitized effective configuration, fixture mode, generated protocol schema digest, and run nonce. A version change starts a new evidence set; it never relabels old results.

## Identity and state matrix

First use the tested binary's generated schema to verify request shapes. Verify server registration/tool discovery on the relevant thread and record readiness before testing dispatch. Use the same owning app-server connection/process for creating and controlling the primary experimental thread. A separate app-server process must not be assumed to control an existing CLI/UI session.

| State | Experiment and comparison |
| --- | --- |
| New idle thread | Direct call before any turn; record whether thread/turn fields are present and what they correlate with. |
| Active turn A | Obtain A from host notifications/responses; establish active state independently, then call the probe. Compare metadata to the host's thread and A. |
| Completed turn A | Call after confirmed completion; distinguish missing turn metadata from a retained A value. |
| Later active turn B | Same thread, different host-issued turn; compare against both A and B. |
| Interrupted turn | Call after interruption; determine whether stale context survives or the host refuses. |
| Separate threads/Children | Use independently established Root/Child records, including concurrent Children where supported, to test isolation. |
| Turn transition race | Delay dispatch/admission around A completion and B start; verify that reading the newest active turn cannot relabel an old request. |

Capture active-state evidence before and after dispatch. If the turn ends before handler entry and ordering cannot resolve attribution, classify the sample as inconclusive and rerun within the bounded budget. A requested sleep in model prose alone does not prove an active turn; the plan must establish a controlled, observable hold without depending on the disputed MCP selection behavior. If no supported hold works, record that limitation.

Matching hashes establish correlation only. G2 additionally requires an entry candidate's trust boundary: who may dispatch, how that party obtains authority from the actual user action, which operation/turn it authorizes, and how admission atomically preserves it through execution. Test wrong-thread, stale-turn, duplicate request, cancelled authorization, and turn-transition cases against synthetic existing preparation/binding seams. Preserve once-only consumption, executor checks, adapter selection, workspace resolution, and generation/receipt checks.

Do not claim that thread-only handling necessarily permits duplicate launch: existing atomic consumption already blocks repeated consumption of one preparation. The unresolved concern is whether an old or unrelated invocation can consume a different currently eligible operation. Demonstrate any claimed failure with a concrete negative test; retain uncertainty otherwise.

Idle or completed-thread calls can be valid transport observations. They cannot establish user-turn authority merely by returning identity values. Any different authorization mechanism is a candidate to evaluate explicitly, not a fabricated current turn.

## Lifecycle matrix

Use a probe-owned held handler and a harmless synthetic worker. Persist hold entry before triggering lifecycle actions. For explicit interruption, both the held call and the exact active turn must be observed; otherwise record `not-sent` and the missing prerequisite.

Test separate isolated cases for exact `turn/interrupt`, client connection closure while the host survives, owning host exit, abrupt host loss, configured tool timeout, and server safety deadline. Do not equate connection loss with process loss. Include normal completion and a completion-versus-cancellation race. Keep an unrelated sentinel invocation where practical to detect overly broad cancellation.

Record independently: interrupt request/acknowledgement, turn terminal status, RPC outcome, handler cancellation/settlement, transport state, worker state, durable operation outcome, and hooks if present. `interrupted`, a timeout response, and a killed observer are not proofs that accepted downstream work stopped.

Direct abort is one possible mechanism. If absent, investigate whether an existing supported stop-intent or supervision seam can achieve the same required outcome with exact ownership. Demonstrate that seam against the synthetic worker before marking G3 proven. A polling loop in a trusted process is a separate mechanism requiring assessment against existing design constraints; it must not be smuggled in as model-free waiting or automatically accepted.

Settlement expectations are command-specific. For `status --wait`, cancellation ends observation and leaves the underlying job running. Execution-tool cases follow the existing foreground/background placement and cancellation rules. The plan must map each tested command/placement to its expected durable outcome; one generic "kill the worker" expectation cannot qualify all tools.

The existing 100-hour production ceiling remains the target. Exercise its implementation through a shorter injected test deadline; label that as mechanism testing, not proof that the host supports a continuous 100-hour tool call. Record any remaining duration/host timeout limitation for production qualification.

Use bounded observation windows and output buffers, stable process identity before signalling, and ordered cleanup in `finally`, following the existing harness. The implementation plan specifies finite per-case and total campaign budgets before running. Missing events at a ceiling remain unknown. Cleanup failures fail the campaign and report the precise remaining probe resources; never terminate unrelated host sessions.

## Deterministic entry and terminal delivery

Investigate G4 early so transport success does not create false product confidence. Inventory current documented plugin/host capabilities and assess each plausible entry against the actual installed Codex CLI/UI session, not only a driver-owned test thread.

For each candidate, identify the user's explicit action, the component receiving it, how that component reaches the session's owning host, how request authority is established, who holds the pending call, how output reaches the original user/Child, and how cancellation reaches the exact operation. Record external dependencies or required host changes.

A terminal command manually run by a probe driver proves RPC dispatch, not a plugin entry. A Skill that asks the model to select MCP remains the existing model-driven route. A shell wrapper that yields and requires repeated `write_stdin`, status calls, or `wait` decisions does not meet the foreground goal. A transport keepalive that does not invoke the model is not itself model re-entry; measure actual transcript events.

G4 requires a bounded installed disposable-fixture demonstration: explicit user action, deterministic dispatch, a held interval spanning multiple former observation intervals, no periodic model decisions, terminal result delivery, and user cancellation routing. The hold duration and comparison baseline must be recorded. Do not claim token savings without measured evidence.

If the only workable candidate requires a custom UI, a separate app-server host, a Codex fork, or an external coordinator outside the supported plugin installation, document it as an external architecture candidate. That does not pass G4 for the current plugin goal; adoption would require a separate user scope decision.

## Validation, results, and continuation

Tests must establish that handler entry survives absent/malformed metadata; correlation cannot be fabricated by probe arguments; unknown error origin remains unknown; idle or stale metadata cannot be counted as active authorization; host completion cannot be counted as worker settlement; and cleanup targets only probe-owned resources. Reducer tests include missing, duplicate, out-of-order, wrong-run, and truncated events. Test the synthetic admission and lifecycle counterexamples rather than simply asserting request object shapes.

Run the real host campaign after unit/integration checks. Require a confirmation run on a frozen driver for any positive feasibility recommendation. Record negative observations with their exact conditions and instrument limitations. Failure to reproduce a pass returns the relevant gate to `not-proven`.

Expected investigation artifacts (created by the later implementation task):

- `docs/qualification/codex-app-server-direct-mcp.md`: evidence-backed report, gate decisions, entry candidates, limitations, and exact reproducible commands.
- `qualification/direct-mcp-feasibility.json`: a separate versioned, redacted observation/decision record with evidence references and per-gate reasons. The implementation plan defines its closed schema before collection.
- Probe/test changes with references to the reused original harness and regression evidence for its existing results.

All gates proven means “candidate ready for production design,” not “MCP released.” Partial success means “technically characterized; product feasibility incomplete.” A rejected candidate remains scoped to its version/configuration/mechanism. Keep the existing shell adapter usable and the original release records intact in every case.

The next implementation plan must turn unresolved mechanisms into bounded research tasks, select controls and campaign budgets, and arrange independent review of the evidence and conclusions. Review this written specification before beginning that plan or live experiments.

## Official references and their limits

- [Codex App Server](https://developers.openai.com/zh-Hans/docs/app-server): documented `mcpServer/tool/call`, thread/turn APIs, structured Skill input, and generation of version-specific schemas. Its `turn/interrupt` description concerns the turn result; downstream handler cancellation must be measured.
- [Codex MCP configuration](https://developers.openai.com/zh-Hans/docs/extend/mcp): tool startup/configuration and `tool_timeout_sec`. A tool timeout description alone does not establish downstream cancellation.
- [Plugin architecture](https://developers.openai.com/plugins/concepts/plugins): Skill, MCP, and lifecycle-hook capabilities. Their availability alone does not establish deterministic dispatch into the current host session.

These are research starting points previously consulted in this conversation. Recheck current pages and the exact installed binary when implementing; neither a moving documentation page nor a schema method's existence proves runtime behavior or identifies the release that introduced it.

## Document review

Independent subagent review on 2026-09-24 found no blocking issues after checking the baseline specification and qualification report. Its clarification about observation-only cancellation for `status --wait` is incorporated above. Document review establishes clarity and consistency, not Host feasibility; no live direct-call qualification was performed while drafting.
