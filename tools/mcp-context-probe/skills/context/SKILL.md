---
name: context
description: Probe-only skill for Codex MCP invocation-context qualification; never used in production.
---

# ZCode MCP Context Probe

This skill exists only inside the disposable `zcode-mcp-context-probe` qualification plugin. It proves how the Codex host delivers per-call MCP metadata, cancellation, timeout, and disconnect settlements to a plugin MCP server.

When the qualification conversation asks you to use `$zcode-mcp-context-probe:context`, follow it exactly:

- Call `mcp__zcode-mcp-context-probe__capture_context` with no arguments exactly as many times as the conversation states, once per requested Root or Child turn. Never pass arguments and never invent thread, turn, or workspace values.
- Call `mcp__zcode-mcp-context-probe__hold_until_cancelled` with no arguments only when the conversation asks you to hold, and wait for that call instead of doing anything else.
- Never call `mcp__zcode-mcp-context-probe__read_assertions`; it is reserved for the qualification driver.
- Do not call any other MCP tool while the probe conversation is running.
