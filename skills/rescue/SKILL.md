---
name: rescue
description: Use when a user wants ZCode to investigate, implement, repair, or continue a substantial coding task in the current workspace.
---

# ZCode Rescue

Invoke as `$zcode:rescue [--background | --wait] [--resume | --fresh] [--model <provider/model|alias>] [--effort none|minimal|low|medium|high|xhigh] <task...>`.

Require non-empty task text. Rescue may change the workspace and defaults to foreground. The native prompt hook has already recorded the exact arguments and task text. Never place user text, command arguments, job or session identity, permissions, credentials, or authorization material in a process command or agent message.

Resolve the plugin root as the directory two directories above this `SKILL.md`; use its absolute canonical plugin root. Before spawning anything, use the available terminal tool in the parent to run exactly `node "<plugin-root>/scripts/zcode-companion.mjs" role-status rescue` over ordinary stdio. This is the only companion command the parent may run. Accept only the fixed `role-status` object. If its status is not `ready`, present its status and exact `$zcode:setup` remedy, then stop without spawning.

When the active `spawn_agent` tool schema exposes `agent_type`, prefer this exact named spawn with a fresh context:

```text
spawn_agent({
  task_name: 'zcode_rescue',
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

For the generic route, substitute only the preflight-verified absolute canonical plugin root in this fixed message, then call `spawn_agent` with `task_name: 'zcode_rescue'`, `fork_turns: 'none'`, no `agent_type`, and exactly that message:

```text
Act only as the installed ZCode Rescue forwarder. In the current workspace run exactly:
node "<canonical-plugin-root>/scripts/zcode-companion.mjs" invoke rescue
Preserve stderr and return public stdout verbatim. Do not inspect or modify code independently, interpret results, retry, poll, cancel, choose a pending branch, or request/print/persist authorization material.
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
