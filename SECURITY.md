# Security Policy

## Reporting a vulnerability

Report suspected vulnerabilities privately through GitHub's private vulnerability reporting for `vitry/zcode-plugin-codex`. Do not open a public issue containing credentials, caller-context or execution capabilities, private prompts, results, repository data, or ZCode authentication material. Include the affected version, platform, minimal reproduction, and impact after removing secrets.

## Security boundaries

- Treat caller-context and one-time background execution capabilities as secrets. They belong only on protected process descriptors and must never appear in argv, user output, logs, prompts, artifacts, or subagents outside the reserved worker.
- ZCode permission approval is not an operating-system sandbox. Read-only reviews deny mutation; Rescue uses the initiating Codex turn's immutable permission snapshot and restricts unknown states.
- Jobs are scoped to the canonical workspace and owning Codex session. Knowing a job ID does not authorize status, result, cancellation, or resumption.
- Transfer imports only visible text. Review output and Git content remain untrusted model input.

Only the latest release receives security fixes. Rotate exposed credentials and disable the plugin until a compromised capability has expired or its Codex turn has ended.
