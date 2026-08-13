# Remove the Spawn-Metadata Override Design

Status: approved for implementation

## Problem

ZCode setup currently installs the managed `zcode-rescue` Role and also writes
`features.multi_agent_v2.hide_spawn_agent_metadata = false` into the Codex user
configuration. The Role is plugin-owned, but the feature flag controls a
host-owned reserved-tool schema. Codex 0.147 testing demonstrated that registered
custom Roles can be selected with `agent_type` when the flag is absent or true,
while forcing it to false can make Sol-origin sessions fail every turn with:

```text
Invalid Value: 'tools'. Function 'collaboration.spawn_agent' is reserved for use
by this model and must match the configured schema.
```

The plugin also treats the flag as Role readiness state, records its previous
value, and restores it during transaction rollback. Raw plugin removal cannot
clean this external state because Codex exposes no plugin uninstall hook.

## Goals

- Stop writing, owning, validating, or restoring the host-owned spawn-metadata
  flag for new installations.
- On reinstall or upgrade, remove the legacy false leaf from the exact writable
  user config when a valid managed Role receipt, registration, and digest prove
  that the installation belongs to ZCode.
- Keep the managed `zcode-rescue` Role and runtime `agent_type` routing.
- Make one post-install `$zcode:setup` reconciliation sufficient; do not require
  a second setup after restarting merely because Role configuration changed.
- Preserve jobs, prompts, results, logs, and other durable history.
- Document residual state and safe manual cleanup for permanent uninstall.
- Do not add a ZCode-specific uninstall command.
- Stop after creating the implementation PR. Do not merge, rebuild the
  marketplace snapshot, reinstall the local plugin, or package a release.

## Non-goals

- Do not change Rescue task semantics, authorization, progress, cancellation,
  result handling, or the generic compatibility route.
- Do not clean a foreign or project-level Role.
- Do not delete durable workspace history automatically.
- Do not make `codex plugin remove` run cleanup that the host does not support.
- Do not promise `agent_type` on unqualified Codex versions.

## Chosen Architecture

### Host and plugin ownership

ZCode owns the `agents.zcode-rescue` registration, its stable Role file, and
the digest receipt. Codex owns the collaboration tool schema and every
`features.multi_agent_v2` switch. ZCode observes the active `spawn_agent`
interface and selects its existing named or generic route; it never changes the
host schema to manufacture a route.

### Receipt schema

Managed Role receipt schema version 2 removes
`priorSpawnMetadataValue`. New receipts contain only the data needed to prove
Role ownership. Version-1 receipts remain readable solely as a migration input
and interrupted version-1 transaction journals remain recoverable.

### Legacy migration

Inspection classifies an otherwise valid version-1 managed installation as
`upgrade-required`. Reconciliation verifies all existing ownership evidence
before mutation:

- receipt plugin identity, config target, Role path, schema, and digest;
- effective `agents.zcode-rescue` registration;
- current Role bytes;
- absence of project shadowing or a foreign higher-precedence definition.

For that proven legacy state, one optimistic `config/batchWrite`:

1. deletes the target user-layer
   `features.multi_agent_v2.hide_spawn_agent_metadata` leaf with a null value;
2. upserts the canonical `agents.zcode-rescue` registration; and
3. applies unrelated setup-owned edits exactly as before.

The Role file and version-2 receipt are written atomically. If any post-write
verification or receipt commit fails, rollback restores the exact pre-migration
user-layer leaf, registration, Role bytes, and receipt. A fresh install never
deletes or edits a pre-existing host flag because no legacy ZCode receipt proves
ownership.

After successful reconciliation, effective Role validation ignores the metadata
flag entirely. The setup result is based on the reloaded, re-read configuration;
the managed Role lifecycle no longer uses receipt mutation time to force a
second setup invocation. Runtime named-role failure continues to fail closed
according to the Rescue skill rather than being hidden by setup.

### Runtime routing

The existing Rescue routing contract remains:

- when the active `spawn_agent` interface exposes `agent_type`, request the
  named `zcode-rescue` Role with `fork_turns: none`;
- when the active host omits or rejects the field before creating a child, use
  the existing fixed generic compatibility route;
- never retry generically after ambiguous activity or a managed Role error.

### Reinstall lifecycle

The supported repair flow is:

```text
codex plugin remove <installed-zcode-plugin>
codex plugin add <rebuilt-zcode-plugin>
$zcode:setup
```

Plugin remove deletes only host-managed installation/cache state. The one setup
run after reinstall reconciles proven legacy Role state, deletes the stale flag,
and preserves durable history. No `$zcode:uninstall` skill is introduced.

### Permanent uninstall documentation

The English and Chinese READMEs link to a repository-owned manual cleanup guide.
The guide explains that raw removal has no cleanup hook and tells users to
settle active jobs first. It separates:

- plugin-owned configuration and Role state that may be removed only after
  checking the receipt, registration path, and digest;
- ephemeral authorization, hook, lock, broker, and review-gate state that may
  be removed when no jobs are active; and
- durable `jobs`, `job-specs`, `prompts`, `results`, progress, and log
  history that is retained by default.

The guide explicitly identifies the legacy metadata leaf as removable only for
a proven ZCode legacy installation, warns never to remove a colliding user or
project Role, and uses placeholders derived from the receipt rather than
hard-coding one marketplace data-root name. The receipt remains the
self-describing cleanup manifest after plugin removal.

## Error Handling

- Missing, malformed, drifted, shadowed, or foreign ownership evidence remains
  fail closed and performs no legacy cleanup.
- Version races use the existing optimistic config version and transaction
  journal.
- Interrupted old and new transactions are recovered before new reconciliation.
- A failed migration restores the legacy false value so setup never reports a
  half-migrated installation.
- An externally supplied host flag without a valid version-1 ZCode receipt is
  left untouched.

## Testing

Tests must follow red-green-refactor and cover:

- fresh install writes the Role registration but no metadata edit;
- valid version-1 upgrade deletes the exact user-layer leaf and emits a
  version-2 receipt without `priorSpawnMetadataValue`;
- fresh or foreign state never deletes an unrelated host flag;
- current Role readiness ignores absent, true, false, and higher-precedence
  metadata values;
- migration rollback restores the exact prior leaf;
- interrupted version-1 journals still recover;
- setup requires only one successful reconciliation after the writable-root
  bootstrap;
- Rescue contracts still prefer named `agent_type` and preserve generic
  fallback;
- English, Chinese, marketplace, and release-contract documentation stays in
  sync;
- no uninstall skill or command is added.

Focused managed-Role/setup tests, complete unit and integration tests, lint,
typecheck, line-ending checks, and the portable qualification suite must pass.
Installed authenticated qualification remains opt-in and must be reported
honestly if credentials or explicit opt-ins are unavailable.

## Review and Delivery

Implementation occurs on an isolated branch. Independent subagents review:

1. compliance with this specification;
2. code quality and rollback safety; and
3. conflicts with the prior native-subagent design and `../codex-plugin-cc`
   lifecycle conventions.

All critical and important findings are resolved and re-reviewed. The branch is
pushed and a PR is created against `main`. Marketplace snapshot regeneration,
local reinstall, release packaging, and merge are deliberately deferred until
the user merges the PR and requests the next packaging step.
