# Preserve upstream behavior, not Claude Code host internals

The plugin reproduces the user-visible `$zcode:*` command set, arguments, outcomes, and workflows of `codex-plugin-cc` wherever ZCode supports them, while implementing orchestration with Codex-native skills, hooks, session ownership, and built-in subagents. Claude Code-specific mechanisms such as slash-command files, `AskUserQuestion`, the Claude `Agent` tool, and background Bash are not compatibility requirements; copying them would weaken behavior inside the actual Codex Host.
