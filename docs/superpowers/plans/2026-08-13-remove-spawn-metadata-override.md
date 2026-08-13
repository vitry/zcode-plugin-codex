# Remove Spawn-Metadata Override Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the managed `zcode-rescue` Role while removing ZCode's ownership of the host spawn-metadata flag, automatically migrate proven legacy installs in one setup run, and document safe residual-state cleanup.

**Architecture:** The managed-Role module remains the single ownership and transaction seam. It accepts numeric-v1 receipts as legacy evidence, conditionally deletes only the exact target user-layer legacy flag, writes a SemVer `"1.0.0"` receipt at the same path, and rolls every applied leaf/file back on failure. Runtime Rescue routing remains unchanged and setup trusts the post-write config read instead of requiring a receipt-timestamp rerun.

**Tech Stack:** Node.js ESM, JSDoc/TypeScript checking, `node:test`, Codex app-server config RPC fixtures, Markdown contract tests.

---

## File Map

- Modify `scripts/lib/managed-agent-role.mjs`: receipt parsing, legacy migration classification, conditional config edit, rollback, and one-run readiness.
- Modify `scripts/lib/codex-config.mjs`: consume the reconciler's ready result without adding another restart/rerun gate.
- Modify `tests/managed-agent-role.test.mjs`: focused red-green coverage for receipt SemVer, migration ownership, rollback, interrupted journals, and metadata-independent readiness.
- Modify `tests/setup.test.mjs`: setup batch shape and one-run readiness.
- Modify `tests/integration/marketplace-install.test.mjs`: installed-source setup lifecycle without regenerating the checked-in marketplace tree.
- Modify `tests/integration/skills.test.mjs`, `tests/release-contracts.test.mjs`, and `tests/skills-contracts.test.mjs`: remove obsolete flag assumptions and lock documentation/routing contracts.
- Modify `README.md`, `README.zh-CN.md`, `SECURITY.md`, `CHANGELOG.md`, and `skills/setup/SKILL.md`: describe host ownership, one-run reconciliation, and safe residual cleanup.
- Create `docs/manual-uninstall.md`: packaged bilingual manual cleanup guide.
- Modify `package.json`: include the manual guide in npm/plugin payloads.
- Modify `docs/superpowers/specs/2026-08-09-rescue-native-subagent-progress-design.md`: add an explicit supersession note; preserve it as historical design.
- Do not modify `marketplace/plugins/zcode/`: generated snapshot refresh is deferred until after merge.

### Task 1: Lock the receipt and migration contract in failing tests

**Files:**
- Modify: `tests/managed-agent-role.test.mjs`

- [ ] **Step 1: Replace fresh-install expectations with the new contract**

Update the install test to expect only:

```js
[
  {
    keyPath: 'agents.zcode-rescue',
    value: roleConfig(ctx.paths.rolePath),
    mergeStrategy: 'upsert',
  },
]
```

Assert the receipt has `schemaVersion === '1.0.0'`, has no own
`priorSpawnMetadataValue`, and reconciliation returns
`{ status: 'ready', changed: true, rolePath }`.

- [ ] **Step 2: Add a numeric-v1 legacy migration test**

Create exact legacy Role bytes, registration, target user-layer
`hide_spawn_agent_metadata: false`, and a numeric-v1 receipt. Assert one batch
deletes the legacy leaf with:

```js
{
  keyPath: 'features.multi_agent_v2.hide_spawn_agent_metadata',
  value: null,
  mergeStrategy: 'upsert',
}
```

and upserts the Role registration. Assert the same receipt path now contains
`schemaVersion: '1.0.0'`, no legacy field, and no transaction file remains.

- [ ] **Step 3: Add migration ownership edge cases**

Cover:

- numeric-v1 + target leaf absent: migrate receipt without emitting a metadata edit;
- numeric-v1 + target leaf true: fail closed as drift and do not mutate config;
- fresh install + unrelated false/true flag but no receipt: do not emit a metadata edit;
- current `"1.0.0"` receipt with absent/false/true effective metadata: report ready;
- malformed/foreign receipt, wrong digest, project shadow, or foreign registration: perform no cleanup.

- [ ] **Step 4: Add rollback and interrupted-journal cases**

Force post-write verification and receipt-commit failures. Assert rollback
restores the exact prior metadata leaf, registration, Role bytes, and numeric-v1
receipt. Preserve an existing numeric-v1 transaction fixture and prove
recovery still understands `previousMetadata`.

- [ ] **Step 5: Run focused tests and record RED**

Run:

```bash
node --test tests/managed-agent-role.test.mjs
```

Expected: FAIL on the old metadata edit, numeric receipt, timestamp restart,
and metadata readiness checks.

- [ ] **Step 6: Commit the failing tests**

```bash
git add tests/managed-agent-role.test.mjs
git commit -m "test: define managed role metadata migration"
```

### Task 2: Implement SemVer receipts and owned legacy cleanup

**Files:**
- Modify: `scripts/lib/managed-agent-role.mjs`
- Test: `tests/managed-agent-role.test.mjs`

- [ ] **Step 1: Introduce exact current and legacy receipt predicates**

Define:

```js
export const MANAGED_ROLE_RECEIPT_SCHEMA_VERSION = '1.0.0';
```

Keep Role template schema separate. Parse only exact current `"1.0.0"` and
exact legacy numeric `1`; reject unknown numeric, malformed SemVer, and future
major versions. Current receipts must not contain
`priorSpawnMetadataValue`. Legacy receipts may contain the prior field only as
boolean.

- [ ] **Step 2: Classify valid legacy state as upgrade-required**

After proving registration and Role digest, classify numeric-v1 as
`upgrade-required`. Remove effective metadata from current receipt readiness.
Remove the receipt mutation-time/session-start comparison so an exact
`"1.0.0"` installation is ready in the current setup process.

- [ ] **Step 3: Make the metadata edit conditional**

Compute migration state only for a proven numeric-v1 receipt:

```js
const legacyMetadata = targetMetadata(input.config, input.configTarget.filePath);
```

- absent: no metadata edit;
- exact false: emit the null deletion;
- any other present value: fail closed before journal/write.

Fresh installs and current receipts never emit a metadata edit.

- [ ] **Step 4: Preserve transaction rollback semantics**

Keep `previousMetadata` readable in numeric-v1 journals. Add a journal field
that records whether this reconciliation intended the legacy deletion, and make
`configLeavesOwned`, previous-state matching, applied-write detection, and
rollback conditional on that intent. Never restore or compare metadata for a
fresh/current install transaction.

- [ ] **Step 5: Write the SemVer receipt atomically**

Write one receipt at the stable path:

```js
{
  schemaVersion: MANAGED_ROLE_RECEIPT_SCHEMA_VERSION,
  roleName: MANAGED_ROLE_NAME,
  plugin: { identity, version, root },
  configTarget: { filePath },
  role: { path, schemaVersion: MANAGED_ROLE_SCHEMA_VERSION, sha256 },
  mutatedAt,
}
```

Return `ready` after successful post-write verification and receipt commit.

- [ ] **Step 6: Run focused tests and reach GREEN**

```bash
node --test tests/managed-agent-role.test.mjs
npm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit implementation**

```bash
git add scripts/lib/managed-agent-role.mjs tests/managed-agent-role.test.mjs
git commit -m "fix: stop overriding Codex spawn metadata"
```

### Task 3: Make setup one-run and preserve runtime routing

**Files:**
- Modify: `tests/setup.test.mjs`
- Modify: `tests/integration/marketplace-install.test.mjs`
- Modify: `tests/integration/skills.test.mjs`
- Modify if required: `scripts/lib/codex-config.mjs`
- Verify: `skills/rescue/SKILL.md`

- [ ] **Step 1: Write failing setup lifecycle expectations**

Change setup tests so the first Role reconciliation:

- batches hooks/trust plus `agents.zcode-rescue`, with no metadata edit;
- returns `ready` after the successful reload/read;
- writes review-gate state with `setupReady: true`;
- does not require a future `sessionStartedAt` rerun.

Add a setup-level numeric-v1 fixture proving one run emits the null legacy
deletion and preserves unrelated config.

- [ ] **Step 2: Update installed-source integration expectations**

Make the isolated install test expect one setup reconciliation after writable
root bootstrap. Assert no request writes metadata false and a migrated install
returns ready. Do not build or modify the checked-in generated marketplace
directory.

- [ ] **Step 3: Run setup/integration tests and record RED**

```bash
node --test tests/setup.test.mjs tests/integration/skills.test.mjs tests/integration/marketplace-install.test.mjs
```

Expected: FAIL where old tests require metadata false or a second setup.

- [ ] **Step 4: Apply the minimal setup integration change**

If `codex-config.mjs` still converts a successful changed Role result to
`restart-required`, preserve `ready` from the reconciler. Keep the separate
writable-root bootstrap restart requirement unchanged because that root must be
available before plugin state can be written.

- [ ] **Step 5: Re-run focused tests**

```bash
node --test tests/setup.test.mjs tests/integration/skills.test.mjs tests/integration/marketplace-install.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Verify routing contracts remain unchanged**

```bash
node --test tests/skills-contracts.test.mjs tests/codex-rescue-qualification.test.mjs
```

Expected: named `agent_type: 'zcode-rescue'` and generic pre-child fallback
contracts remain PASS.

- [ ] **Step 7: Commit setup changes**

```bash
git add scripts/lib/codex-config.mjs tests/setup.test.mjs tests/integration/skills.test.mjs tests/integration/marketplace-install.test.mjs
git commit -m "fix: complete role setup in one reconciliation"
```

### Task 4: Package self-documenting uninstall guidance

**Files:**
- Create: `docs/manual-uninstall.md`
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `SECURITY.md`
- Modify: `CHANGELOG.md`
- Modify: `skills/setup/SKILL.md`
- Modify: `package.json`
- Modify: `tests/release-contracts.test.mjs`
- Modify: `tests/skills-contracts.test.mjs`
- Modify: `docs/superpowers/specs/2026-08-09-rescue-native-subagent-progress-design.md`

- [ ] **Step 1: Write failing documentation/package contracts**

Assert:

- both READMEs link to `docs/manual-uninstall.md`;
- `package.json.files` includes that exact file;
- the guide names receipt-based ownership checks, Role/config cleanup,
  ephemeral state cleanup, history retention, and the no-uninstall-hook limit;
- setup docs state ZCode does not own
  `hide_spawn_agent_metadata` and one setup run performs proven migration;
- no `uninstall` skill directory or command is introduced;
- generated `marketplace/plugins/zcode/` remains outside this PR's changed
  file set.

- [ ] **Step 2: Run contract tests and record RED**

```bash
node --test tests/release-contracts.test.mjs tests/skills-contracts.test.mjs
```

Expected: FAIL until source docs and package allowlist are updated.

- [ ] **Step 3: Write the manual cleanup guide**

Document the reinstall flow and permanent cleanup. Require users to settle
active jobs, inspect the stable receipt, verify the exact config target, Role
path, registration, and SHA-256, then remove only proven Role state and the
legacy false leaf. Describe ephemeral state that may be removed and durable
`jobs`, `job-specs`, `prompts`, `results`, progress, and logs retained by
default. Warn against deleting project or foreign Roles.

- [ ] **Step 4: Update source documentation and historical design**

Remove claims that setup needs or owns spawn metadata. Explain that Codex owns
the active tool schema and Rescue detects `agent_type` at runtime. Replace
Role-specific restart-and-rerun guidance with one-run reconciliation while
retaining the separate writable-root restart flow. Add a superseded paragraph
to the 2026-08-09 design rather than rewriting its historical body.

- [ ] **Step 5: Re-run documentation/package tests**

```bash
node --test tests/release-contracts.test.mjs tests/skills-contracts.test.mjs tests/marketplace-snapshot.test.mjs
npm pack --dry-run
```

Expected: PASS and packed file listing includes `docs/manual-uninstall.md`.

- [ ] **Step 6: Commit documentation**

```bash
git add docs/manual-uninstall.md README.md README.zh-CN.md SECURITY.md CHANGELOG.md skills/setup/SKILL.md package.json tests/release-contracts.test.mjs tests/skills-contracts.test.mjs docs/superpowers/specs/2026-08-09-rescue-native-subagent-progress-design.md
git commit -m "docs: explain ZCode residual state cleanup"
```

### Task 5: Full verification and independent reviews

**Files:**
- Review all changes since `origin/main`

- [ ] **Step 1: Run complete portable verification**

```bash
npm run check:line-endings
npm run lint
npm run typecheck
npm test
npm run test:qualified
git diff --check origin/main...HEAD
```

Expected: zero failures. Opt-in authenticated suites may report their documented
machine-readable unqualified skips, not false qualification.

- [ ] **Step 2: Dispatch spec-compliance reviewer**

Give a fresh review subagent the approved design, base SHA, head SHA, and diff.
Resolve every missing/extra behavior and repeat until approved.

- [ ] **Step 3: Dispatch code-quality and rollback-safety reviewer**

Ask a separate review subagent to inspect receipt parsing, migration ownership,
transaction recovery, version races, and accidental user-config deletion.
Resolve critical/important findings and re-review.

- [ ] **Step 4: Dispatch design-conflict reviewer**

Ask a third subagent to compare the implementation against the superseded native
subagent design and `../codex-plugin-cc`, specifically checking host/plugin
ownership, runtime fallback, uninstall lifecycle, and generated-snapshot
boundaries. Resolve conflicts and re-review.

- [ ] **Step 5: Re-run complete verification after review fixes**

Repeat Step 1 and inspect `git status --short`.

- [ ] **Step 6: Commit any review fixes**

```bash
git add <reviewed-source-files>
git commit -m "fix: address spawn metadata migration review"
```

Skip the commit only if reviewers required no changes.

### Task 6: Push and create the PR

**Files:**
- No source changes expected

- [ ] **Step 1: Confirm delivery boundary**

Verify `marketplace/plugins/zcode/` is unchanged, the local installed plugin
was not modified, and no package/release artifact was created.

- [ ] **Step 2: Push the feature branch**

```bash
git push -u origin fix/remove-spawn-metadata-override
```

- [ ] **Step 3: Create a PR against main**

Use a title such as:

```text
fix: stop overriding Codex spawn metadata
```

The body summarizes the exact 400 regression, owned numeric-v1 migration,
one-run setup, retained Role routing, cleanup documentation, tests, and deferred
marketplace rebuild.

- [ ] **Step 4: Report and stop**

Return the PR URL, verification evidence, review outcomes, migration behavior,
and explicit statement that merge, snapshot rebuild, local reinstall, and
release packaging are waiting for the user's next instruction.
