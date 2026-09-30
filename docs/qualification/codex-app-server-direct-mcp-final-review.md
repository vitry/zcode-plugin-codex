# Direct MCP feasibility: independent final review record

Review date: 2026-09-27

Reviewed branch and commit: `docs/direct-mcp-feasibility` at `a1218b6`

Scope: Task 7, Step 5 of the [investigation plan](../superpowers/plans/2026-09-24-codex-app-server-direct-mcp-feasibility.md), covering the [frozen evidence report](codex-app-server-direct-mcp.md) and [`qualification/direct-mcp-feasibility.json`](../../qualification/direct-mcp-feasibility.json).

The independent final review reported **no P1/P2 findings**. It passed its checks of the durable-evidence reducer, private-log redaction, process cleanup, event ordering, candidate-entry and invocation authority, and `status --wait` cancellation semantics. It also found the frozen decisions for all four gates supported by the evidence:

| Gate | Frozen decision | Review conclusion |
| --- | --- | --- |
| G1 — handler reachability | `not-proven` / `confirmation-failed` | The positive handler-entry observation did not reproduce in the second frozen-driver confirmation run. |
| G2 — invocation authority | `not-proven` / `no-trusted-caller-path` | No controlled active-turn hold or trusted caller-to-operation authorization chain was demonstrated. |
| G3 — lifecycle settlement | `not-proven` / `settlement-unproven` | Several held-worker outcomes remained durably unsettled; explicit turn interruption was not sent without a confirmed active turn. |
| G4 — installed product entry | `not-proven` / `no-supported-entry-candidate` | No supported plugin component demonstrated access to the owning session's Host connection and the required direct-call entry behavior. |

The only finding was **Low**: the frozen report says its independent review is pending. That statement described the state *at freeze time*; this later review is now complete. We retain the frozen report unchanged so its evidence digest remains valid. This record supplies the post-freeze status without changing any gate decision or claiming live qualification from the structural validator.

The investigation therefore remains qualification-only. It does not authorize a production direct-MCP adapter, change the shell adapter, or promote the original model-driven MCP release decision. Further product work first needs a supported owning-session entry and a trusted invocation path; G1 reachability alone cannot establish product feasibility.

This record summarizes the 2026-09-27 independent-review handoff. It does not claim that the review's experiments were rerun when this record was added.
