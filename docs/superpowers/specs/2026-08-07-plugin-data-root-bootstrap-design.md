# Plugin Data Root Bootstrap Design

## Problem

Installed `$zcode:*` skills run ordinary companion commands without a guaranteed
`PLUGIN_DATA` environment variable. The companion currently rejects every command,
including `$zcode:setup`, before setup can configure the environment. Codex documents
`PLUGIN_DATA` for plugin hook commands, not as a guaranteed environment variable for
ordinary commands launched from a skill.

## Design

Add one plugin-data resolver shared by skills, setup, and hooks. An explicit
`ZCODE_DATA_ROOT` remains the test and operator override. Otherwise the resolver uses
an injected `PLUGIN_DATA` or `CLAUDE_PLUGIN_DATA` only when it matches the active
installed plugin identity. When no injected value is available, it derives a stable
marketplace-qualified root from the canonical plugin cache path and `CODEX_HOME`:

```text
${CODEX_HOME:-~/.codex}/plugins/data/zcode-<marketplace>
```

A source checkout uses the unqualified development root:

```text
${CODEX_HOME:-~/.codex}/plugins/data/zcode
```

Workspace state remains isolated below `workspaces/<sha256-canonical-workspace>`.
No state is written into the repository or plugin cache.

## Setup bootstrap

`$zcode:setup` must be able to run before the data root is writable. It reads Codex
configuration first, preserves existing writable roots, and adds the resolved plugin
data root through `config/batchWrite`. When the effective sandbox configuration changes,
setup reports `restart-required` and defers state writes and review-gate changes until
the user restarts Codex and reruns setup.

When the root is already writable, setup continues with the existing ZCode discovery,
authentication, hook validation/trust, model policy, and review-gate flow.

## Safety

- Canonicalize and validate cache-relative marketplace/plugin/version segments.
- Reject control characters, traversal, and unexpected plugin identities.
- Never accept an arbitrary injected `PLUGIN_DATA` path for an installed plugin.
- Preserve existing writable-root configuration and detect higher-precedence overrides.
- Keep private directory/file permissions and existing workspace hashing unchanged.
- Hooks and skills must resolve the same data root.

## Verification

Add regression coverage proving an installed-style setup invocation without
`PLUGIN_DATA` no longer returns `DATA_ROOT_REQUIRED`, derives the expected
marketplace-qualified path, requests only the required writable-root edit, requires a
restart before writing state, and succeeds after restart. Keep explicit data-root tests,
hook tests, marketplace installation tests, and the full suite green.
