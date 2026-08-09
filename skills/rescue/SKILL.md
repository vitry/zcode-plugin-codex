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

Only after the preflight returned `ready`, use the generic native-agent compatibility route when either the active schema hides `agent_type` (the schema does not expose `agent_type`) or the named request is rejected before creating a child specifically because `agent_type` is an unsupported/reserved field. An `unknown agent_type`, missing or unavailable Role, Role/config mismatch, drift, shadowing, outdated state, configuration error, ambiguous failure, or any runtime child failure requires `$zcode:setup` and is not eligible. A rejected named request must not have created a child; spawn exactly once and never start a second executor. If spawning fails, stop: because no child ran the companion, there is no queued job or authorization artifact to clean up.

For the generic route, substitute only the preflight-verified absolute canonical plugin root in this fixed message, then call `spawn_agent` with `task_name: 'zcode_rescue'`, `fork_turns: 'none'`, no `agent_type`, and exactly that message:

```text
Act only as the installed ZCode Rescue forwarder. In the current workspace run exactly:
node "<canonical-plugin-root>/scripts/zcode-companion.mjs" invoke rescue
Preserve stderr and return public stdout verbatim. Do not inspect or modify code independently, interpret results, retry, poll, cancel, choose a pending branch, or request/print/persist authorization material.
```

Keep the returned child ID. Wait for that same child to reach a terminal state; if a wait yields, is interrupted, or returns while it is active, wait or rejoin the same child and never spawn another one. Do not relay raw child progress, stderr, tool output, or intermediate messages into the parent. On terminal completion, return only the child's public stdout verbatim without interpretation. If it returns `needs-choice`, preserve that public response verbatim; continuation is handled by the documented same-child choice flow.
