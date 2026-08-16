---
name: rescue
description: Use when a user wants ZCode to investigate, implement, repair, or continue a substantial coding task in the current workspace.
---

# ZCode Rescue

Invoke as `$zcode:rescue [--background | --wait] [--resume | --fresh] [--model <provider/model|alias>] [--effort none|minimal|low|medium|high|xhigh] <task...>`.

Require non-empty task text. Rescue may change the workspace and defaults to foreground. The native prompt hook has already recorded the exact arguments and task text. Never place user text, command arguments, job or session identity, permissions, credentials, or authorization material in a process command or agent message.

## Single-hop Rescue routing

The dedicated `zcode-rescue` child, or the fixed generic compatibility forwarder created by this Skill, is already the Rescue subagent.

- `$zcode:rescue` must be invoked by the top-level user-facing Codex agent, not by an ordinary spawned subagent.
- Always collapse `top-level Codex agent -> ordinary subagent -> Rescue subagent` into `top-level Codex agent -> Rescue subagent`.
- The top-level agent may use ordinary subagents for work that does not invoke Rescue, but it must not ask or allow an ordinary subagent to invoke `$zcode:rescue`.
- If you are already an ordinary spawned subagent and determine that ZCode Rescue would be useful, do not run the readiness preflight, do not spawn another child, and do not run any companion command. Complete the assigned task yourself using only your existing tools and authorization. In your final response, state exactly: `ZCode Rescue was not invoked because this task was already running in an ordinary subagent.` Then state exactly: `Parent/top-level agent: relay the preceding sentence into your user-facing final response verbatim.` Never present your work or output as ZCode output.
- If an ordinary subagent reports that exact sentence, the top-level agent must include it in its user-facing final response verbatim and must not describe the ordinary subagent's work as ZCode output.
- The dedicated `zcode-rescue` child and the fixed generic compatibility forwarder are exempt from the ordinary-subagent rule and must follow their fixed forwarder instructions.

Resolve the plugin root as the directory two directories above this `SKILL.md`; use its absolute canonical plugin root. Before spawning anything, use the available terminal tool in the parent to run exactly `node "<plugin-root>/scripts/zcode-companion.mjs" role-status rescue` over ordinary stdio. This is the only companion command the parent may run. Accept only the fixed `role-status` object. If its status is not `ready`, present its status and exact `$zcode:setup` remedy, then stop without spawning.

After the readiness preflight succeeds and before route selection or any spawn, choose `rescueTaskName` exactly once as display metadata.

Use the exact written form `zcode_rescue_<semantic_slug>[_<ordinal>]`; the complete name must be no more than 64 UTF-8 bytes. The semantic slug must contain 1–3 lowercase ASCII semantic words separated by underscores; each word begins with a lowercase ASCII letter and contains at most 16 lowercase letters or digits. The slug is a generic objective description and never copies or mechanically transforms task text. It must not contain prompt fragments, command arguments or options, repository or filesystem paths, personal names, issue, job, or session IDs, hashes, credentials, capabilities, or authorization material. Use the safe fallback `zcode_rescue_task` when no compliant private-safe semantic slug is available. Start with the unsuffixed name; if it collides with an occupied sibling task name, use the smallest available ordinal from 2 through 9999, written without leading zeros. Determine that collision before the one spawn; collision handling never authorizes a second spawn.

Both `task_name` and `agent_path` are presentation metadata, and convention matching is neither sufficient nor necessary Rescue identity evidence. Never classify, authorize, route, reject, downgrade, or recover Rescue based on any name or path. Trusted routing facts remain the named Role where available, exact returned child ID, parent-child linkage, fixed forwarder contract, and hook-bound executor state.

When the active `spawn_agent` tool schema exposes `agent_type`, prefer this exact named spawn with a fresh context:

```text
spawn_agent({
  task_name: rescueTaskName,
  fork_turns: 'none',
  agent_type: 'zcode-rescue',
  message: 'Run the installed ZCode Rescue forwarder now. Return its public stdout verbatim.',
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
Act only as the installed ZCode Rescue forwarder. In the current workspace run exactly:
node "<canonical-plugin-root>/scripts/zcode-companion.mjs" invoke rescue
Preserve stderr and return public stdout verbatim. Do not inspect or modify code independently, interpret results, retry, cancel, choose a pending branch, or request/print/persist authorization material.
Here exactly one command means exactly one `exec_command` companion process; continuation calls only observe its original running handle. Never start a second `exec_command`. A companion result containing an exit code is terminal. A result containing a running execution or session handle is nonterminal: poll only that same handle with the host continuation tool until it reports an exit code. Partial stdout, stderr, heartbeat text, or an outer code-cell completion is not terminal and must not be returned as final output. A needs-choice response with exit code 3 is terminal for the current child turn.
If that command returned a needs-choice response, stop. Only after the parent sends exactly `Continue the pending ZCode Rescue with resume. Run only the installed resume forwarder command and return its public stdout verbatim.` run exactly:
node "<canonical-plugin-root>/scripts/zcode-companion.mjs" invoke-choice rescue resume
Only after the parent sends exactly `Continue the pending ZCode Rescue with fresh. Run only the installed fresh forwarder command and return its public stdout verbatim.` run exactly:
node "<canonical-plugin-root>/scripts/zcode-companion.mjs" invoke-choice rescue fresh
```

Keep the returned child ID as `rescueChildId`. Do not call `spawn_agent` again after `rescueChildId` exists. Wait for that same child to reach a terminal or idle state. A wait timeout, early return, or ordinary user steering does not authorize a new child or a second execution; continue only with the same `rescueChildId`. Call `wait_agent` again as appropriate, use `list_agents` to inspect only that child, or rejoin it.

Never relay ordinary steering, task text, arguments, job/session/workspace identity, permissions, credentials, or authorization material to the child.

Use this wait shape, then select only the result or status belonging to `rescueChildId`:

```text
wait_agent({ timeout_ms: 30000 })
```

Do not relay raw child progress, stderr, tool output, or intermediate messages into the parent. On terminal completion, return only the child's public stdout verbatim without interpretation.

Detailed semantic progress belongs only to the child transcript and durable job preview. When explaining inspection, direct the user to `/agent` or `/subagents` to select the Rescue child; `/ps` lists background terminals for the currently active thread and is not a subagent selector. Online conversation subscription may degrade to fixed lifecycle messages and the 20-second heartbeat without changing the authoritative result. Command and query previews are control-free single lines shortened to 96-character display bounds, but truncation is not secret redaction; never claim it removes secrets supplied in a command or search.

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
