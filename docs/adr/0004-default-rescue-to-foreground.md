---
status: superseded by ADR-0015
---

# Default Rescue to foreground execution

When `$zcode:rescue` receives neither `--wait` nor `--background`, it runs in the foreground, matching `codex-plugin-cc` rather than applying the newer `cc-plugin-codex` complexity heuristic. This keeps invocation behavior deterministic and makes background execution an explicit user choice for long-running work.
