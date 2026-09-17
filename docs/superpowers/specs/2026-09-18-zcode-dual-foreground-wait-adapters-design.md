# ZCode Dual Foreground Wait Adapters Design

Status: approved on 2026-09-18. Ready for implementation planning after user review of this written specification.

## Executive decision

ZCode will ship two parallel Skill families that preserve one Companion workflow and differ only in how a Foreground Companion Run stays attached:

- the existing canonical Skills remain the shell baseline and observe one CLI process with long, empty-input `write_stdin` waits;
- explicit-only `*-mcp` Skills use one command-specific MCP tool call that remains pending until the same Companion invocation reaches an authoritative outcome.

MCP is a Foreground Wait Adapter, not a new execution, binding, permission, job, or lifecycle implementation. Both adapters enter the existing Companion deep module and must produce identical durable effects and public terminal text. The parallel release is an evaluation mechanism; no automated result promotes MCP to the canonical names.

## Problem

The current Skills start the Companion through Codex's shell tool. When a foreground process outlives the shell tool's initial yield, the model must repeatedly decide to call `write_stdin`. Short observations consume turns and tokens even though the desired action is usually just to keep waiting for the same process.

The immediate repair is to make shell observation much less frequent. The comparative design is to expose the same long-running invocation as an MCP tool, allowing Codex to remain inside one tool call until terminal completion. The experiment must not fork the already-correct Companion logic or obscure the exact Rescue binding protocol.

## Goals

- Reduce model re-entry during long foreground execution.
- Preserve a canonical shell baseline and add clearly distinguishable MCP variants for human comparison.
- Reuse the existing direct invocation, preparation, binding, job, cancellation, and lifecycle paths.
- Preserve exact public output across adapters.
- Preserve all four Rescue placement branches from the approved placement design.
- Fail closed when Codex cannot supply trustworthy per-call MCP identity and workspace context.
- Make a later canonical-name switch a policy and packaging change, not another workflow migration.

## Non-goals

- No change to ZCode task execution semantics, provider behavior, or permission policy.
- No second binding, cancellation, job, progress, or lifecycle state machine.
- No generic MCP command runner or arbitrary argv surface.
- No MCP-side status polling, heartbeat, or inactivity watchdog.
- No promise that the model can issue a Child Status sidecar while one MCP call is pending.
- No automatic promotion, fixed trial duration, or mandatory run count.
- No removal of the shell baseline.
- No implementation in this specification.

## Dependency on Rescue placement semantics

This design composes with `2026-09-16-rescue-placement-semantics-parity-design.md`. That specification separates two independent dimensions:

1. **Host placement** controls whether Root joins the Rescue Child.
2. **Companion execution** controls whether the Child keeps an attached foreground invocation or hands work to the Detached Rescue Runner.

The Foreground Wait Adapter is selected only when Companion execution is `foreground`; it is independent of Host placement.

| Rescue request | Host placement | Companion execution | Canonical Child adapter | MCP Child adapter |
|---|---|---|---|---|
| Explicit `--background` | background | foreground | Shell wait to terminal | MCP wait to terminal |
| Explicit `--wait` | foreground | foreground | Shell wait to terminal | MCP wait to terminal |
| No flag, small/bounded | foreground | foreground | Shell wait to terminal | MCP wait to terminal |
| No flag, complex/long | foreground | background | Existing Detached Runner | Existing Detached Runner |

For explicit Rescue `--background`, Root returns only the bounded Host launch acknowledgement while the exact Rescue Child remains alive and waits for attached Companion completion. It is not converted into a queued Companion job. For no-flag complex Rescue, the existing detached path returns queued promptly and no foreground adapter owns the long execution.

The placement change and this foreground observation repair remain one release unit as required by the placement specification.

## Public Skill surface

The installed plugin exposes these pairs:

| Canonical shell baseline | Explicit MCP variant |
|---|---|
| `$zcode:rescue` | `$zcode:rescue-mcp` |
| `$zcode:review` | `$zcode:review-mcp` |
| `$zcode:adversarial-review` | `$zcode:adversarial-review-mcp` |
| `$zcode:status` | `$zcode:status-mcp` |

Canonical Skills retain their current descriptions and implicit/proactive selection policy. During evaluation, every `*-mcp` Skill is explicit-only: it runs only when the user names it. Its instructions still retain the proactive-source workflow required for a future canonical switch, but its published description must not compete for implicit routing.

Each MCP Skill preserves its canonical counterpart's public options. Branches that do not require foreground observation continue to use their existing path. In particular, Review and Adversarial Review background branches retain enqueue behavior, while Rescue follows the two-dimensional placement matrix above.

### Rescue Child adapter selection

Adding a sibling Skill alone is insufficient because the current managed Rescue Role and its fixed child assignments name only the shell launcher. This design therefore extends the existing task-free Rescue route instead of adding another Role or binding family.

The canonical and MCP Rescue Skills prepare the same workflow with an explicit private `foregroundAdapter` value of `shell` or `mcp`. New preparations use the next preparation-envelope version and persist this closed value through consumption and any `needs-choice` receipt. Historical version-4 preparations retain their shell meaning. The adapter is transport selection only: it is not added to Rescue Binding, Tracked Job, permission, placement, or resumable-session identity.

Root sends one of two exact task-free assignments to the same prescribed Rescue Child:

- shell assignment: execute the existing fixed launcher command;
- MCP assignment: call the fixed Rescue MCP tool.

The managed `zcode-rescue` Role template and generic fallback instructions allow exactly those two generated assignments. Route planning, child selection, canonical child path, Role evidence, SubagentStart proof, and binding stay unchanged. Fresh and resume routing select the child before adapter execution exactly as today.

The consumed preparation or pending-choice receipt must match the adapter used by the Child. A shell entry cannot consume an MCP preparation and an MCP handler cannot consume a shell preparation. A choice continuation must use the adapter captured by its originating invocation. Mismatch fails before reservation, session creation/resume, or provider activity. A later independent Rescue request may deliberately select the other Skill family while resuming the same valid Rescue Binding; adapter identity never becomes durable binding authority.

## Architectural seam

The authoritative module boundary remains `runDirectInvocation(argv, runtime)` and, where applicable, the existing `runCompanion` paths beneath it.

```text
Skill workflow
    |
    +-- Shell Wait Adapter --> Companion CLI --------+
    |                                                |
    +-- MCP Wait Adapter ----> fixed MCP handler ----+--> runDirectInvocation
                                                         --> existing command / binding / job / lifecycle core
```

The adapter owns only:

- host transport and waiting;
- translation of host cancellation into the existing `AbortSignal` path;
- transport-specific presentation of the existing invocation result.

It does not own command parsing, caller authority, preparation, route selection, binding, workspace admission, permissions, job transitions, cancellation settlement, terminal election, or result storage.

For Rescue foreground execution, the MCP semantic entry is exactly:

```js
runDirectInvocation(["invoke-prepared", "rescue"], runtime)
```

Review, Adversarial Review, and Status use the same constant argv vectors already used by their corresponding shell direct-invocation branches. Existing `needs-choice` continuations use separate fixed handlers rather than accepting model-selected argv.

## Shell Wait Adapter

Canonical Skills keep the current CLI launcher and apply this observation contract:

1. Start the intended Companion process once with the longest supported initial execution yield, up to 30 seconds.
2. If the tool returns a live process handle, call `write_stdin` on that exact handle with an empty `chars` value and `yield_time_ms: 60000`.
3. Repeat only while that process remains live.
4. Never send bytes during ordinary waiting, start a replacement process, substitute Status polling, or ask the model to reinterpret silence.

An empty write is significant: it asks the tool to keep observing without adding stdin that the child could interpret as protocol or user input.

Rescue preparation is a separate intentional input phase. After `prepare rescue` emits `preparation-input-ready`, Root sends exactly one LF-terminated private JSON frame. The later `invoke-prepared rescue` process receives no routine input; only its process handle is observed.

The fixed 60-second yield is an instruction-level cadence. A host may return earlier when output or completion arrives.

## MCP Wait Adapter and packaging

The plugin adds one local MCP server declared by the plugin-root `.mcp.json` companion file. `.codex-plugin/plugin.json` remains free of an `mcpServers` field. The configured tool timeout is exactly 360000 seconds (100 hours). This is a host safety ceiling, not a ZCode business deadline or inactivity threshold.

The npm `files` allowlist, marketplace snapshot builder, content manifest, packed-install fixtures, and installed-layout tests must carry and verify `.mcp.json` plus the server entry and its runtime dependencies.

One MCP tool call invokes one existing Companion path and awaits it until it returns, throws an existing PluginError, or is cancelled. The MCP server is long-lived and must never exit merely to encode one invocation's outcome.

The MCP variants must not be packaged or enabled until the trusted invocation-context qualification described below passes on the supported Codex host. The shell changes may be developed and qualified independently, but the advertised dual-adapter release requires both.

## Narrow MCP tool contract

The server exposes only command- and phase-specific tools:

| Tool | Constant semantic action |
|---|---|
| `invoke_prepared_rescue` | `invoke-prepared rescue` |
| `choose_rescue_resume` | existing Rescue resume choice continuation |
| `choose_rescue_fresh` | existing Rescue fresh choice continuation |
| `invoke_review` | existing Review invocation; recorded state decides foreground, background, or choice |
| `choose_review_wait` | existing Review foreground choice continuation |
| `invoke_adversarial_review` | existing Adversarial Review invocation; recorded state decides foreground, background, or choice |
| `choose_adversarial_review_wait` | existing Adversarial Review foreground choice continuation |
| `invoke_status` | existing Status invocation; recorded state decides snapshot or wait |

The exact constant argv behind each non-Rescue handler is taken from the existing canonical Skill path during implementation; it is not reconstructed from MCP arguments.

These tools accept no thread ID, turn ID, parent or child identity, task, workspace, job ID, permission, binding selector, preparation token, timeout, or arbitrary argv. User choices and Status wait parameters remain in the existing hook-recorded invocation context. A handler that cannot resolve the required recorded state fails through the existing error path.

No generic `invoke(command, args)` tool is permitted.

## Trusted MCP invocation context

`runDirectInvocation` requires the exact current caller and workspace. A long-lived MCP process cannot use its startup environment or process cwd as per-call authority.

The MCP adapter introduces one small internal boundary, `resolveMcpInvocationContext`, whose only result is:

```ts
{
  threadId: string;
  turnId: string;
  workspace: string;
}
```

All three values must come from trusted host-supplied per-call metadata or an equivalently authoritative host call context. Thread and turn are expected from `_meta["x-codex-turn-metadata"]`; workspace is accepted only if the protocol probe proves an authoritative per-call source. The resolved workspace is then cross-checked through the same persisted Caller Context, preparation, binding, and active-turn rules used by shell invocation.

The adapter must not parse `turnId` and then discard it. Before entering the existing deep module it performs a command-specific authority join:

- Review, Adversarial Review, and Status require metadata thread and turn to match the exact active Caller Context recorded for that invocation and workspace.
- `invoke_prepared_rescue` requires metadata Child thread and current Child turn to match trustworthy Host/app-server turn evidence, the exact executor, and the unconsumed preparation—including its adapter—bound to that parent/Child join. The parent Caller Context remains the executor's proven `parentSessionId` and parent turn, never the Child thread substituted as parent authority.
- `choose_rescue_resume` and `choose_rescue_fresh` require metadata for the same Child thread and its current later turn to match trustworthy Host/app-server turn evidence, the exact executor, and the pending choice receipt—including the originating adapter—captured by the preceding invocation. They do not require an unconsumed preparation because the initial invocation has already consumed it.

These preflights are non-consuming. The current later Child turn is correlated through the Host/app-server mechanism qualified by the protocol probe; it is never assumed to equal the executor's persisted initial `childTurnId` or the preceding receipt's originating parent turn. Only after the applicable join succeeds does the bridge construct the legacy runtime expected by the existing deep module: canonical `cwd` from the trusted workspace, `CODEX_THREAD_ID` from the proven current MCP caller thread, the existing authorization source, and the handler's `AbortSignal`. Existing `resolveActiveTurn`, routed-executor, binding checks, and the locked `consume()` or `consumePending()` operation remain authoritative and must atomically revalidate the adapter and exact identity before consuming. The bridge does not weaken or replace them; a preflight race fails at atomic consumption without starting work.

Persisted records may verify a host-supplied identity and workspace. They may not be searched to guess the latest thread, choose the only apparent workspace, infer a child from a parent, or manufacture missing call context.

The following are forbidden authority sources:

- MCP tool arguments or model-authored text;
- MCP server process cwd;
- server startup environment inherited from an unrelated call;
- “latest” thread, turn, preparation, binding, or job lookup;
- uniqueness assumptions across workspaces or concurrent children.

Missing, malformed, ambiguous, or inconsistent context fails before Companion execution starts. The error names the corresponding canonical shell Skill as a manual alternative. The same call never silently falls back to shell because execution may already be ambiguous and fallback would invalidate the comparison.

### Mandatory protocol probe

Implementation begins with a disposable probe against the real supported Codex host. It must capture and prove, without model-supplied identifiers:

1. root-thread thread ID, turn ID, and exact invocation workspace;
2. Rescue Child identity and workspace;
3. the same Child on a later choice turn, including trustworthy current-turn correlation that does not reuse the initial executor turn or originating parent turn;
4. two concurrent children without cross-binding;
5. explicit cancellation and connection-loss delivery to the pending handler;
6. a temporary short `tool_timeout_sec` that proves host timeout reaches the handler as cancellation or otherwise terminates it, and that existing durable interruption settlement runs before the invocation becomes unsupervised;
7. no reuse of stale metadata between calls or workspaces.

The probe records only bounded diagnostic assertions, not private task or binding content. If Codex does not provide trustworthy per-call workspace together with caller identity, implementation stops: MCP Skills remain disabled/unpackaged and this design must be amended. Adding heuristic discovery or weakening exact binding is not an acceptable workaround.

## Existing Companion invariants

Both adapters preserve, without reimplementation:

- parent Role preflight;
- raw-TTY Rescue preparation and versioned private envelope;
- Host placement and Companion execution planning;
- prescribed spawn/follow-up directive and exact canonical Child path;
- SubagentStart evidence and child/parent identity join;
- one-shot preparation consumption and exact Rescue Binding validation;
- fresh/resume choice and resumable session behavior;
- model, effort, permission snapshot, origin workspace, and execution workspace;
- Writable Guard admission and release;
- Tracked Job reservation, transitions, progress, and stored result;
- Detached Rescue Runner claim/lease and queued semantics;
- interruption, Durable Stop Intent, Cancellation Settlement, and reconciliation;
- terminal result/error election and public rendering;
- SessionEnd and Host Coordination Loss behavior.

No MCP handler performs independent binding or lifecycle lookup beyond resolving and validating its trusted invocation context before entering the existing deep module.

## Results and control outcomes

The existing Companion output object and `renderOutput` remain authoritative.

For equivalent recorded input:

- shell stdout and MCP `content[].text` are byte-for-byte identical;
- MCP `structuredContent.outcome` is one of `terminal`, `needs-choice`, `parent-replan`, or `error`;
- an existing PluginError or error envelope sets MCP `isError: true` and uses `outcome: "error"`;
- `needs-choice` and `parent-replan` are non-error control outcomes;
- structured content contains no task, binding, thread, turn, workspace, job, capability, permission, or other private state.

The MCP discriminator replaces per-CLI-process exit-code signaling for the Skill. It does not add a new domain outcome. The server remains alive after every tool result.

`terminal` means the current direct invocation/tool call completed normally; it does not assert that a referenced Tracked Job is terminal. It therefore covers a foreground terminal result, a normal Status snapshot (including a nonterminal job), a background reservation/queued acknowledgement, and any other existing non-control success from the tools in this design. Only existing `needs-choice`, `parent-replan`, and error envelopes use the other three discriminators.

## Cancellation, connection loss, and liveness

There is no inactivity watchdog and no periodic model-driven Status call. Long silent intervals remain valid while the transport and underlying invocation are healthy.

For `rescue-mcp`, `review-mcp`, and `adversarial-review-mcp`, explicit tool interruption, transport loss, or the 100-hour host ceiling aborts the exact foreground invocation through the existing interruption and lifecycle-settlement path. Rescue retains its existing resumable-session semantics. Such loss is Host Coordination Loss where the existing lifecycle rules classify it that way; it is not reported as successful completion.

For `status-mcp`, interruption or connection loss ends observation only. It never cancels the observed Tracked Job. The explicit `status --wait --timeout-ms` value remains its separate business wait bound.

Authoritative terminal state, explicit cancellation, transport/process/protocol failure, and the outer host ceiling are the only reasons for the adapter to stop waiting. MCP notifications, logs, and progress messages are optional presentation enrichment and never participate in correctness or terminal detection.

## Foreground interaction model

The MCP Rescue variant follows the `codex-plugin-cc` foreground shape: the Rescue Child makes one tool call and waits for it to return. While that call is pending, the design does not promise that the same Child can initiate a Child Status sidecar, result lookup, monitor, or cancellation call.

The canonical shell Skill retains its existing exact Child Status sidecar opportunity between yielded observations during evaluation. This is a documented UX difference, not a difference in binding, execution, cancellation, or terminal semantics. Optional MCP progress notifications must not wake the model or require a model decision.

## Skill source maintenance

Separate Skill directories are required because the public names differ, but the long workflow contract must not be maintained as two independent prose copies.

Canonical Skill prose together with the managed Rescue Role template is the workflow source. A deterministic build step derives each MCP sibling and adapter-specific Rescue assignment regions by replacing only explicitly marked regions for:

- public Skill name and explicit-only description;
- foreground adapter invocation and observation instructions;
- adapter-specific foreground interaction notes;
- Rescue's exact task-free Child assignment and matching Role branch.

Generation covers each sibling directory's `SKILL.md` frontmatter/body and `agents/openai.yaml`, including an explicit-only description/default prompt that cannot compete for implicit routing. Generated MCP Skill files ship in source/package artifacts and marketplace snapshots; runtime does not load templates or generate Skills. A regeneration/parity test fails whenever text outside the allowlisted regions diverges. Any canonical binding, placement, permission, Role, or lifecycle edit therefore propagates to the MCP sibling or fails CI.

## Error behavior

Adapter failures remain bounded and actionable:

- missing or untrusted MCP call context: refuse before execution and point to the canonical shell Skill;
- context mismatch: use the existing exact-identity/binding error, without searching for an alternative;
- Companion error: render the same public error as shell and mark the MCP result as error;
- MCP cancellation after start: invoke existing interruption settlement, never launch a duplicate or silently retry;
- server startup/configuration failure: leave canonical Skills usable and report MCP variant unavailable;
- host timeout: treat as transport cancellation/coordination loss, never as a successful ZCode terminal result.

Errors must not expose private preparation, task, binding, capability, thread, turn, workspace, or permission values.

## Verification and release gates

Automated qualification must cover:

1. the mandatory real-Host metadata/workspace/cancellation/short-timeout protocol probe;
2. `.mcp.json`, absence of manifest `mcpServers`, npm/package/marketplace inclusion, server startup, tool schemas, explicit-only routing, and 100-hour production configuration;
3. shell initial yield and repeated empty-input 60-second observation of one exact process;
4. Rescue preparation's single intentional JSON+LF write and absence of routine foreground stdin;
5. all four Rescue placement rows for both Skill families, including Host-background/Companion-foreground MCP execution;
6. Rescue preparation and choice adapter capture, exact task-free assignment selection, same-Child continuation, shell/MCP mismatch refusal, and later independent cross-adapter resume of one valid binding;
7. Review and Adversarial Review foreground, choice, and background branches;
8. Status snapshot/wait completion, explicit timeout, and observation-only cancellation;
9. byte-for-byte rendered-text parity and complete invocation-outcome/exit-control mapping, including queued and nonterminal Status output;
10. missing, stale, malformed, cross-workspace, wrong-turn, wrong-child, and concurrent-child identity failures;
11. interruption before start, during execution, after terminal election, connection loss, and short configured host timeout;
12. no duplicate launch, silent fallback, heuristic lookup, discarded turn identity, or private structured content;
13. generated `SKILL.md`, `agents/openai.yaml`, Rescue Role/assignment regeneration, and non-allowlisted prose parity;
14. source, generated plugin, packaged artifact, installed plugin, and supported Codex-version qualification.

Adapter parity fixtures must feed equivalent recorded caller/preparation state through shell and MCP entry points and compare durable state transitions plus public output. Tests must use fake/local provider seams unless explicitly marked as real-Host qualification.

The placement specification's regression suite remains a joint release gate. In particular, explicit Rescue `--background` must keep an attached Child to terminal, while no-flag complex Rescue must still enqueue once and return queued promptly.

## Human evaluation and promotion

Passing automated tests authorizes only the parallel experiment. It does not switch canonical names.

Real users and maintainers compare the shell and MCP variants in normal work, including long silence, cancellation, failures, multiple workspaces, resumed Rescue sessions, and Child behavior. This specification sets no automatic threshold, duration, or run count because those would imply evidence the agent test environment cannot supply.

Promotion requires a later explicit maintainer decision recorded separately. That decision may change the canonical adapter and selection policy, but it must preserve the shell implementation as a fallback until a separate removal decision is approved.

## Documentation impact

Implementation updates must keep these descriptions aligned:

- plugin README and Skill reference for parallel names and explicit-only MCP selection;
- setup diagnostics for MCP availability and trusted-context qualification;
- Rescue placement documentation and relevant ADRs;
- cancellation/lifecycle documentation for MCP transport loss;
- contributor documentation for generated Skill parity and package qualification.

Documentation must say “Host placement,” “Companion execution,” and “Foreground Wait Adapter” where the unqualified words “background” or “MCP execution” would be ambiguous.
