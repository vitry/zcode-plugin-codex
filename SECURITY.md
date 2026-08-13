# Security Policy

## Reporting a vulnerability

Report suspected vulnerabilities privately through GitHub's private vulnerability reporting for `vitry/zcode-plugin-codex`. Do not open a public issue containing credentials, caller-context or execution capabilities, private prompts, results, repository data, or ZCode authentication material. Include the affected version, platform, minimal reproduction, and impact after removing secrets.

## Security boundaries

- Treat caller-context and one-time background execution capabilities as secrets. They belong only on protected process descriptors and must never appear in argv, user output, logs, prompts, artifacts, or subagents outside the reserved worker.
- ZCode permission approval is not an operating-system sandbox. Read-only reviews deny mutation; Rescue uses the initiating Codex turn's immutable permission snapshot and restricts unknown states.
- Jobs are scoped to the canonical workspace and owning Codex session. Knowing a job ID does not authorize status, result, cancellation, or resumption.
- Transfer imports only visible text. Review output and Git content remain untrusted model input.
- The digest-backed managed Role is owned only when its stable-data receipt, file bytes and SHA-256, selected config target, and exact Codex registration agree. Installation, migration, and manual cleanup fail closed when that receipt proof is incomplete. Never overwrite or delete foreign registrations, project Roles, higher-precedence overrides, or modified Role files.
- The named child and Codex 0.147 generic compatibility child rely on exact host-issued thread identity inside the private same-UID data boundary. This prevents accidental sibling reuse; it is not a cryptographic boundary against a hostile process running as the same operating-system user.
- Semantic progress is an allowlist over untrusted conversation frames. A command or query preview is one control-free line with a 96-character display bound, but truncation is not secret redaction. Never place credentials or authorization material in commands or searches; raw output, file contents, reasoning, and environment values are not allowed progress fields.
- Child stderr and detailed progress stay in the child thread. Parent-visible output is limited to host lifecycle events and the final public result. Subscription or optional progress-sink failure is observational and cannot weaken the authoritative completion guard.
- Uninstall does not automatically erase stable plugin data, managed Role artifacts, durable jobs, or user-config leaves. Verify receipt-based ownership before removing residue. ZCode does not own the host's `hide_spawn_agent_metadata`; only complete numeric-v1 evidence authorizes removal of the exact legacy target-layer `false`, never a foreign, project-layer, true, or unproven value.

Only the latest release receives security fixes. Rotate exposed credentials and disable the plugin until a compromised capability has expired or its Codex turn has ended.
