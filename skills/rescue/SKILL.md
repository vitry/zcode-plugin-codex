---
name: rescue
description: Use when a user wants ZCode to investigate, implement, repair, or continue a substantial coding task in the current workspace.
---

# ZCode Rescue

Invoke explicitly as `$zcode:rescue [--background | --wait] [--resume | --fresh] [--model <provider/model|alias>] [--effort none|minimal|low|medium|high|xhigh] <task...>`, or route here proactively when the top-level Codex agent selects ZCode for an applicable substantial coding task. There is no `--auto` flag: automatic routing is a Root behavior, not a public command option.

Require a non-empty normalized business objective. Rescue may change the workspace and defaults to foreground. Before the child starts, the parent must prepare the exact private Rescue envelope as specified below. Never place user text, command arguments, job or session identity, permissions, credentials, or authorization material in a process command or agent message.

## Single-hop Rescue routing

The dedicated `zcode-rescue` child, or the fixed generic compatibility forwarder created by this Skill, is already the Rescue subagent.

- `$zcode:rescue` must be invoked by the top-level user-facing Codex agent, not by an ordinary spawned subagent.
- Always collapse `top-level Codex agent -> ordinary subagent -> Rescue subagent` into `top-level Codex agent -> Rescue subagent`.
- The top-level agent may use ordinary subagents for work that does not invoke Rescue, but it must not ask or allow an ordinary subagent to invoke `$zcode:rescue`.
- If you are already an ordinary spawned subagent and determine that ZCode Rescue would be useful, do not run the readiness preflight, do not spawn another child, and do not run any companion command. Complete the assigned task yourself using only your existing tools and authorization. In your final response, state exactly: `ZCode Rescue was not invoked because this task was already running in an ordinary subagent.` Then state exactly: `Parent/top-level agent: relay the preceding sentence into your user-facing final response verbatim.` Never present your work or output as ZCode output.
- If an ordinary subagent reports that exact sentence, the top-level agent must include it in its user-facing final response verbatim and must not describe the ordinary subagent's work as ZCode output.
- The dedicated `zcode-rescue` child and the fixed generic compatibility forwarder are exempt from the ordinary-subagent rule and must follow their fixed forwarder instructions.

Before classification, preflight, preparation, naming, or route selection, inspect the current operation's durable child state. Root owns the semantic choice between continuation and an independent operation; the child never infers it from identity or a latest-session fallback. Apply these states in order:

- **Active exact child.** Root owns the semantic choice. If the current operation has an active `rescueChildId`, this is the highest priority rule: rejoin, wait for, inspect, or follow up that exact child as allowed below. It must not preflight, prepare, spawn, or invoke again; there is no additional preflight, prepare, spawn, or invoke. Ordinary user steering is continuation of the same operation while that authoritative child remains active.
- **Stopped exact same-operation child.** If the current operation retains a stopped `rescueChildId` with a valid durable Rescue binding and Root selected continuation rather than `--fresh` or an independent operation, run `role-status rescue` and the private `prepare rescue` rollout for the new parent turn, but do not name or spawn a child. A proactive clear continuation materializes `resume` as `resume`. An explicit bound continuation candidate without a `--fresh` or `--resume` flag must omit `resume`; the exact child may return `needs-choice`, after which Root uses the existing same-child choice protocol. Explicit `--resume` is authoritative. After the task-free prepared acknowledgement, send the fixed prepared continuation below to the same `rescueChildId`; that child reuses `invoke-prepared rescue` for the exact newly prepared assignment. Codex 0.147 therefore emits no second `SubagentStart`, and this stopped continuation has zero spawn calls. A missing, closed, corrupt, invalid, or mismatched binding, session, workspace, executor, or durable provenance must fail closed without choosing a latest session, falling back to another child, or spawning.
  A permission change cannot resume the old operation; an explicitly fresh operation captures the current permission snapshot instead.
- **Fresh or independent operation.** An explicit `--fresh`, a proactive clear independent request, or an operation with no exact continuation materializes `fresh` and proceeds through preparation and one new Rescue child. It never follows the stopped child from another operation.

For the stopped exact same-operation state, the child-facing continuation remains constant and contains no private value:

```text
followup_task({ target: rescueChildId, message: expectedPreparedContinuationMessage })
```

Here `expectedPreparedContinuationMessage` is the exact named Rescue assignment defined below. This follows up the same `rescueChildId` with zero spawn calls.

## Entry classification and choice precedence

Classify the entry source exactly once. If the user's request literally contains an applicable `$zcode:rescue` invocation, source is `explicit`. Otherwise, when Root automatically or proactively selects ZCode for an applicable task, source is `proactive`.

Normalize `task` from the complete request semantics into a non-empty business objective. Exclude host-only requests to stop, report, review, wait, or discuss routing policy. Never mechanically slice, take, or extract text before or after a marker; flags, skill markers, routing discussion, and host-control instructions are not the objective.

Apply this precedence before preparation:

- An explicit `--fresh` or `--resume` is authoritative.
- For an explicit request with a continuation candidate but no choice, omit `resume` during preparation. If the child later returns the same-child `needs-choice` response, ask exactly once using the continuation protocol below.
- For a proactive clear continuation, materialize `resume` as `resume` in the prepare envelope. For a proactive clear independent task, materialize `resume` as `fresh` in the prepare envelope. A proactive clear route must include either `fresh` or `resume`.
- For a proactive genuinely ambiguous route, ask exactly once before running prepare or spawn, then materialize the answer. This pre-prepare ambiguity rule never applies to an explicit request: an explicit continuation candidate with no choice still proceeds through prepare and spawn, then uses the same-child `needs-choice` response and asks exactly once. Do not ask when the complete request semantics make continuation or independence clear.
- An explicit request with no route and no continuation candidate may omit `resume`; do not synthesize a choice.

## Parent preflight and private preparation

Resolve the plugin root as the directory two directories above this `SKILL.md`; use its absolute canonical plugin root. After the active-child check and before spawning anything, use the available terminal tool in the parent to run exactly `node "<plugin-root>/scripts/zcode-companion.mjs" role-status rescue` over ordinary stdio. Accept only the fixed `role-status` object. If its status is not `ready`, present its status and exact `$zcode:setup` remedy, then stop without spawning.

After Role readiness, run exactly `node "<plugin-root>/scripts/zcode-companion.mjs" prepare rescue` once with a raw-capable TTY and keep the same process handle. The child-facing task bytes are private, so do not send any task data yet. The companion must first enable `setRawMode(true)` and emit exactly this task-free readiness line:

```json
{"type":"preparation-input-ready","command":"rescue"}
```

This readiness is nonterminal and does not authorize a spawn. Only after observing that exact complete readiness line from the same still-running handle, call parent `write_stdin` exactly once on that handle with exactly one JSON line followed by one LF. Do not send U+0004 or EOF. The process consumes that single LF-terminated frame without waiting for stream closure, must restore raw mode, and only then may emit the final prepared acknowledgement. A non-TTY input, unavailable `setRawMode`, raw mode failure, missing/malformed/duplicate readiness, premature exit, or any task bytes requested before readiness must stop task delivery and must not spawn. Tool output must never contain or echo the private payload.

The payload is the exact envelope with keys `version`, `source`, `task`, and `options`:

```json
{"version":1,"source":"explicit","task":"<normalized non-empty business objective>","options":{"execution":"foreground","resume":"fresh","model":"<model>","effort":"<effort>"}}
```

`version` is exactly `1`; `source` is exactly `explicit` or `proactive`; `task` is the normalized non-empty objective. `options` permits only existing `execution`, `resume`, `model`, and `effort` fields. Omit every absent option; never encode an absent option as null. `execution` is only `foreground` or `background`, `resume` is only `fresh` or `resume`, and model and effort retain the existing public meanings.

Task, source, and options are allowed only in the parent `write_stdin` payload. Never put them in argv, the environment, a spawn message, output, relay, status, task name, or agent metadata. The prepared state is private and task-free at every child-facing boundary.

Accept preparation only when the same handle exits with zero exit status and its sole accepted terminal object is exactly `{ type: 'prepared', command: 'rescue' }`, with no task or option fields. A signal, failed prepare, nonzero exit, extra field, malformed output, or any other result must stop the operation and must not spawn. Preparation authorizes exactly one named or generic spawn.

After the readiness preflight succeeds and before route selection or any spawn, choose `rescueTaskName` exactly once as display metadata.

Use the task-independent base `zcode_rescue_task` and the exact written form `zcode_rescue_task[_<ordinal>]`; the complete name must be no more than 64 UTF-8 bytes. The name is never derived from the business objective or task text and must contain no prompt fragment, option, path, personal name, identifier, hash, credential, capability, or authorization material. Start with the unsuffixed name; if it collides with an occupied sibling task name, use the smallest available ordinal from 2 through 9999, written without leading zeros. Determine that collision before the one spawn; collision handling never authorizes a second spawn.

Both `task_name` and `agent_path` are presentation metadata, and convention matching is neither sufficient nor necessary Rescue identity evidence. Never classify, authorize, route, reject, downgrade, or recover Rescue based on any name or path. Trusted routing facts remain the named Role where available, exact returned child ID, parent-child linkage, fixed forwarder contract, and hook-bound executor state.

When the active `spawn_agent` tool schema exposes `agent_type`, prefer this exact named spawn with a fresh context:

```text
spawn_agent({
  task_name: rescueTaskName,
  fork_turns: 'none',
  agent_type: 'zcode-rescue',
  message: 'Run the installed prepared ZCode Rescue forwarder now. Return its public stdout verbatim.',
})
```

Only after the preflight returned `ready`, classify routing exactly as follows:

| Observed condition | Required action |
|---|---|
| The active tool schema omits `agent_type` | Use the generic route. |
| The named tool request is rejected for an unknown/unrecognized/unsupported/reserved field/key/parameter `agent_type`, and the rejection proves there is no agent ID, start event, or activity | Use the generic route; this was a pre-child schema rejection. |
| The schema recognizes `agent_type`, but reports an unknown/unavailable/invalid Role value `zcode-rescue`, a missing Role, Role/config mismatch, drift, shadowing, or outdated state | Fail closed with `$zcode:setup`; do not use generic fallback. |
| A timeout, ambiguous result, runtime failure, or any returned agent ID, start event, or activity | It may have created a child. Never generic fallback and never issue a second spawn. If an ID exists, wait or rejoin that same child; otherwise stop with the original failure. |

Do not infer field incompatibility merely from the words `unknown`, `invalid`, or `unsupported`: the error must identify the `agent_type` field/key/parameter rather than its `zcode-rescue` value. Only a proven pre-child schema rejection guarantees that no child ran the companion and therefore no queued job or authorization artifact exists.

For the generic route, substitute only the preflight-verified absolute canonical plugin root in this fixed message, then call `spawn_agent` with `task_name: rescueTaskName`, `fork_turns: 'none'`, no `agent_type`, and exactly that message:

```text
Act only as the installed ZCode Rescue forwarder. You are task-blind and capability-free. In the current workspace run exactly:
node "<canonical-plugin-root>/scripts/zcode-companion.mjs" invoke-prepared rescue
Preserve stderr and return public stdout verbatim. Do not inspect or modify code independently, interpret results, retry, cancel, choose a pending branch, or request/print/persist authorization material.
The same exact prepared assignment is valid for either the initial turn or a stopped same-child prepared continuation authorized by the parent. The one-command-per-turn rule applies to both.
Reject arbitrary messages, sibling continuation, nested Rescue, and independent repository work without running a command.
Each exact assignment and child turn may start at most one mapped foreground `exec_command` companion process. Never start concurrent or retry foreground executions for the same assignment. Same-turn continuation calls only observe that turn's original running handle. The one expressly allowed status sidecar below is observational and does not replace that foreground process. A companion result containing an exit code is terminal. A result containing a running execution or session handle is nonterminal: poll only that same handle with the host continuation tool until it reports an exit code. Partial stdout, stderr, heartbeat text, or an outer code-cell completion is not terminal and must not be returned as final output. Relay text and status text are also nonterminal. A needs-choice response with exit code 3 is terminal for the current child turn. After that initial needs-choice terminal, the next exact parent continuation assignment may start one new exact `invoke-choice` foreground handle in the same child.
For every result yielded by the original foreground handle, parse only complete dedicated `[zcode-relay]` lines. Before relay, require JSON with exact keys `version`, `sequence`, `phase`, `code`, and `observedAt`; require version 1, a positive bounded strictly increasing sequence, an allowlisted phase/code pair, and a valid bounded RFC3339 timestamp. Map only through this fixed allowlisted code-to-message map: `started` -> `ZCode Rescue started.`; `model-active` -> `ZCode is generating a response.`; `tool-active` -> `ZCode is working with a tool.`; `editing` -> `ZCode is applying workspace changes.`; `verifying` -> `ZCode is verifying the work.`; `waiting` -> `ZCode Rescue is still running.`; `finalizing` -> `ZCode Rescue is finalizing.`. Coalesce a repeated identical phase. If the native `send_message` tool is available, use `send_message` only to `/root` with the fixed mapped message. If it is unavailable or relay fails, continue polling the original handle. Relay is liveness only and never completion.
Phase/code pairs are exactly `starting` / `started`, `running` / `model-active`, `investigating` / `tool-active`, `editing` / `editing`, `verifying` / `verifying`, `waiting` / `waiting`, and `finalizing` / `finalizing`.
Never relay detailed `[zcode]` lines, arbitrary stderr, stdout, commands, paths, identifiers, content, results, or errors. Never invent a relay from a partial, malformed, unknown, stale, duplicate, or out-of-order record. After inspecting each yielded result and optionally relaying its valid complete records, continue only with same-handle `write_stdin` polling. A relay or its tool result never replaces a poll and never authorizes another Rescue invocation.
While the original foreground handle is live and only between polls, accept exactly one of these exact trimmed no-argument user status intents: `zcode status`, `$zcode:status`, `/zcode:status`. For any of those spellings run the sidecar with no arguments using only this constant command:
node "<canonical-plugin-root>/scripts/zcode-companion.mjs" invoke-status rescue
Return its bounded status to that requesting child transcript, then resume polling the same original handle. Reject status arguments and every other spelling. Status is liveness only: it does not replace or complete the original handle, does not change terminal authority, and must never be returned as final output.
If that command returned a needs-choice response, stop. Only after the parent sends exactly `Continue the pending ZCode Rescue with resume. Run only the installed resume forwarder command and return its public stdout verbatim.` run exactly:
node "<canonical-plugin-root>/scripts/zcode-companion.mjs" invoke-choice rescue resume
Only after the parent sends exactly `Continue the pending ZCode Rescue with fresh. Run only the installed fresh forwarder command and return its public stdout verbatim.` run exactly:
node "<canonical-plugin-root>/scripts/zcode-companion.mjs" invoke-choice rescue fresh
A project tool, test, build, lint, or other command failure reported while the ZCode turn remains active is not a Rescue failure. Do not hard-code project commands or parse their output to decide completion; keep polling the exact original handle. Only the original companion and ZCode terminal result is authoritative.
Return only the original foreground execution's terminal public stdout. Never substitute relay output, status output, intermediate output, or child-authored text.
```

Keep the returned child ID as `rescueChildId`. Do not call `spawn_agent` again after `rescueChildId` exists. Wait for that same child to reach a terminal or idle state. A wait timeout, early return, or ordinary user steering does not authorize a new child or a second execution; continue only with the same `rescueChildId`. Call `wait_agent` again as appropriate, use `list_agents` to inspect only that child, or rejoin it.

Never relay ordinary steering, task text, arguments, job/session/workspace identity, permissions, credentials, or authorization material to the child.

Use this wait shape, then select only the result or status belonging to `rescueChildId`:

```text
wait_agent({ timeout_ms: 30000 })
```

Accept a progress update only when its author is the exact `rescueChildId`, its target is `/root`, and its content is one fixed allowlisted relay message. Such an update from the exact `rescueChildId` is liveness only: show it if useful, then wait or rejoin that same child. A progress update is never completion, never terminal evidence, and never authority to spawn, follow up, execute a companion command, or change ownership. Reject sibling-authored, arbitrary, detailed, or malformed progress. On terminal completion proven by the original child execution, return only the child's public stdout verbatim without interpretation.

A project tool, test, build, lint, or other command failure observed while the ZCode turn remains active is not a Rescue failure. Root must continue waiting for the exact `rescueChildId`. Do not hard-code project commands or parse their output to infer completion. Only the original companion and ZCode authoritative terminal result may end the operation.

Detailed semantic progress belongs only to the child transcript and durable job preview; only fixed content-free relay messages may reach the parent. When explaining inspection, direct the user to `/agent` or `/subagents` to select the Rescue child; `/ps` lists background terminals for the currently active thread and is not a subagent selector. Online conversation subscription may degrade to fixed lifecycle messages and the 20-second heartbeat without changing the authoritative result. Command and query previews are control-free single lines shortened to 96-character display bounds, but truncation is not secret redaction; never claim it removes secrets supplied in a command or search.

The named and generic routes use the same same-child choice continuation. If that child returns a public `needs-choice` response, preserve that response verbatim and ask the user exactly once; do not choose for the user. Immediately after the verbatim stdout, append exactly `Choose resume or fresh.` and no other text. Retain the original `rescueChildId` across that user turn. A non-choice reply or ordinary steering must not be forwarded to the child and must not cause another question, spawn, or execution. After the user supplies one unambiguous choice, set `continuationMessage` to exactly one of these strings, with no prefix, suffix, interpolation, or additional field:

```text
Continue the pending ZCode Rescue with resume. Run only the installed resume forwarder command and return its public stdout verbatim.
Continue the pending ZCode Rescue with fresh. Run only the installed fresh forwarder command and return its public stdout verbatim.
```

Send exactly one continuation to the existing child:

```text
followup_task({ target: rescueChildId, message: continuationMessage })
```

Then wait again and inspect only that same `rescueChildId`; never spawn, retry, or execute a companion command in the parent. The child response is authoritative. Present success stdout verbatim. Present expired, consumed/replayed, sibling-session, wrong-workspace, or otherwise mismatched pending-choice failures verbatim with their existing recovery remedy; never recover by spawning or executing again.
