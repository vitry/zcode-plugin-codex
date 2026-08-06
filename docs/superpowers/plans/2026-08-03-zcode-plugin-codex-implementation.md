# ZCode Plugin for Codex Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and verify a marketplace-ready native Codex plugin exposing eight `$zcode:*` skills backed by ZCode CLI 0.16.1+.

**Architecture:** Thin Codex skills and lifecycle hooks call one Node.js companion runtime. The companion owns argument contracts, caller/job authorization, workspace-scoped state, prompts, rendering, and two isolated adapters: a bounded Codex app-server client and a long-lived ZCode protocol broker.

**Tech Stack:** Node.js 18.18+ ESM, Node built-in test runner, JSDoc checked by TypeScript, ESLint, `fs-native-extensions` advisory locks, Codex plugin manifest/hooks/skills, JSONL app-server protocols.

---

## File Map

- `.codex-plugin/plugin.json`: Codex plugin identity and presentation metadata.
- `skills/*/SKILL.md`: eight thin user-facing workflows.
- `agents/zcode-rescue.md`: built-in forwarding subagent instructions.
- `hooks/hooks.json`: `SessionStart`, `UserPromptSubmit`, `SubagentStart`, `Stop`, and `SessionEnd` registrations.
- `hooks/*.mjs`: caller-context, unread-result, review-gate, and cleanup entrypoints.
- `scripts/zcode-companion.mjs`: public and private companion command router.
- `scripts/zcode-broker.mjs`: long-lived ZCode CLI transport owner.
- `scripts/lib/identity.mjs`: caller-context and execution-capability validation.
- `scripts/lib/state.mjs`: atomic config, turn, baseline, and tracked-job storage.
- `scripts/lib/zcode-client.mjs`: typed ZCode protocol operations.
- `scripts/lib/zcode-discovery.mjs`: cross-platform executable/version discovery.
- `scripts/lib/codex-app-server.mjs`: bounded Codex app-server calls.
- `scripts/lib/{args,errors,fs,git,process,workspace}.mjs`: focused runtime utilities.
- `scripts/lib/{job-control,prompts,render,review}.mjs`: orchestration policies.
- `prompts/*.md`, `schemas/*.json`: review/task contracts.
- `tests/*.test.mjs`: unit and contract tests.
- `tests/integration/*.test.mjs`: fake-protocol end-to-end tests.
- `tests/fixtures/{fake-zcode-cli,fake-codex-app-server}.mjs`: deterministic protocol peers.
- `README.md`, `README.zh-CN.md`, `LICENSE`, `NOTICE`, `SECURITY.md`: release documentation.
- `.github/workflows/ci.yml`: macOS/Linux/Windows fake-protocol CI.

## Task 1: Package and Plugin Contract

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `eslint.config.mjs`
- Create: `.gitignore`
- Create: `.codexignore`
- Create: `.codex-plugin/plugin.json`
- Create: `LICENSE`
- Create: `NOTICE`
- Create: `tests/plugin-contracts.test.mjs`

- [ ] **Step 1: Write the failing package and manifest contract test**

Create `tests/plugin-contracts.test.mjs` with table-driven assertions that:

```js
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const manifest = JSON.parse(fs.readFileSync(path.join(root, ".codex-plugin/plugin.json"), "utf8"));
const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

test("plugin manifest identifies the vitry ZCode plugin", () => {
  assert.equal(manifest.name, "zcode-plugin-codex");
  assert.match(manifest.version, semverPattern);
  assert.equal(manifest.author.name, "vitry");
  assert.equal(manifest.license, "Apache-2.0");
  assert.equal(manifest.interface.displayName, "ZCode for Codex");
  assert.equal("hooks" in manifest, false);
});

test("package requires Node 18.18 and only the pinned native lock dependency", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert.equal(pkg.type, "module");
  assert.equal(pkg.engines.node, ">=18.18.0");
  assert.deepEqual(pkg.dependencies ?? {}, {
    "fs-native-extensions": "1.5.0",
  });
  assert.deepEqual(pkg.overrides ?? {}, {
    "bare-addon-resolve": "1.9.4",
  });
  assert.deepEqual(pkg.bundleDependencies ?? [], ["fs-native-extensions"]);
  const shrinkwrap = JSON.parse(fs.readFileSync(path.join(root, "npm-shrinkwrap.json"), "utf8"));
  assert.equal(shrinkwrap.packages["node_modules/require-addon/node_modules/bare-addon-resolve"].version, "1.9.4");
  assert.match(pkg.version, semverPattern);
  assert.equal(manifest.version, pkg.version);
});
```

- [ ] **Step 2: Run RED**

Run: `node --test tests/plugin-contracts.test.mjs`

Expected: FAIL because `package.json` and `.codex-plugin/plugin.json` do not exist.

- [ ] **Step 3: Add the minimal package and plugin files**

Use version `0.1.0`, repository `https://github.com/vitry/zcode-plugin-codex`, Node `>=18.18.0`, and Apache-2.0. The only runtime dependency is the exact pin `fs-native-extensions@1.5.0`, which provides process-owned advisory file locks on macOS, Linux, and Windows. Pin the `bare-addon-resolve` override to `1.9.4` because later releases use JavaScript unavailable in Node 18.18. Publish `npm-shrinkwrap.json` and bundle the `fs-native-extensions` tree, because a consuming install does not apply this package's root override. Contract tests must compare the complete dependency, override, and bundle objects and verify the shrinkwrapped resolver version so additional runtime packages cannot be added implicitly.

Use these scripts:

```json
{
  "test": "node --test",
  "test:unit": "node --test tests/plugin-contracts.test.mjs",
  "test:integration": "node --test tests/integration/plugin-layout.test.mjs",
  "lint": "eslint .",
  "typecheck": "tsc -p tsconfig.json",
  "check": "npm run lint && npm run typecheck && npm test"
}
```

Use Node-18-compatible development dependencies:

```json
{
  "@eslint/js": "^9.39.1",
  "@types/node": "^18.19.0",
  "eslint": "^9.39.1",
  "globals": "^16.5.0",
  "typescript": "^5.9.3"
}
```

Configure TypeScript with `allowJs`, `checkJs`, `noEmit`, `strict`, NodeNext
module resolution, and the Node types. Configure ESLint flat config for ESM,
Node globals, `tests/**`, and ignored generated/cache directories.

The manifest must use default `skills/` and `hooks/hooks.json` discovery, omit unsupported `hooks`, `mcpServers`, and `apps` fields, and contain real interface metadata with no placeholder asset paths.

- [ ] **Step 4: Run GREEN and validate the plugin**

Run:

```bash
npm install
node --test tests/plugin-contracts.test.mjs
python3 /Users/zhangzikai/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py .
```

Expected: test PASS and validator success.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json tsconfig.json eslint.config.mjs .gitignore .codexignore .codex-plugin LICENSE NOTICE tests/plugin-contracts.test.mjs
git commit -m "chore: scaffold native Codex plugin"
```

## Task 2: Workspace State and Authorization

**Files:**
- Create: `scripts/lib/errors.mjs`
- Create: `scripts/lib/fs.mjs`
- Create: `scripts/lib/workspace.mjs`
- Create: `scripts/lib/state.mjs`
- Create: `scripts/lib/identity.mjs`
- Create: `tests/state.test.mjs`
- Create: `tests/identity.test.mjs`

- [ ] **Step 1: Write failing state-transition tests**

Test the real filesystem in a temporary directory. Required public API:

```js
createStateStore({ dataRoot })
store.reserveJob({ workspace, ownerSessionId, ownerTurnId, command, readOnly, permissionSnapshot })
store.transitionJob(workspace, jobId, expectedStatuses, nextStatus, patch)
store.readJob(workspace, jobId)
store.listJobs(workspace)
```

Assert `queued -> running -> succeeded`, `running -> cancelling -> cancelled`, failed stop rollback `cancelling -> running` with `lastCancelError`, terminal-state immutability, one writable rescue per workspace, concurrent read-only jobs, and atomic JSON writes.

- [ ] **Step 2: Run RED**

Run: `node --test tests/state.test.mjs`

Expected: FAIL with missing module.

- [ ] **Step 3: Implement minimal state and error modules**

Use stable error shape:

```js
new PluginError(code, message, { category, remedy, cause, details })
```

Store data beneath `${PLUGIN_DATA}/workspaces/<sha256-real-workspace>/`; fall back to `${CODEX_HOME:-~/.codex}/plugins/data/zcode-plugin-codex` only outside an installed plugin. Use mode `0700` directories, `0600` files, unique temporary sibling files, `fsync`, and rename for atomic replacement. Serialize workspace mutations through one persistent lockfile per lock scope using `fs-native-extensions` locks on an open file descriptor. Never rename or unlink an active lockfile, and do not infer ownership from lease timestamps, hostnames, or PIDs.

- [ ] **Step 4: Write failing authorization tests**

Required API:

```js
identity.createCallerContext({ sessionId, turnId, workspace, permissionMode, now })
identity.consumeCallerContext(token, { workspace, now })
identity.createExecutionCapability({ jobId, ownerSessionId, workspace, operation, permissionSnapshot })
identity.consumeExecutionCapability(token, expected)
identity.consumeGateBaseline({ sessionId, turnId, workspace })
```

Assert random tokens are not stored in plaintext artifacts, caller context expires after 30 minutes, execution capability is single-use, forged job IDs and cross-session/workspace use fail, and two interleaved sessions in one workspace never resolve one another's records.

- [ ] **Step 5: Run RED, implement identity, run GREEN**

Run: `node --test tests/identity.test.mjs`

Expected RED: missing exports. Implement SHA-256 token digests at rest, timing-safe comparisons, keyed records, and atomic consume. Re-run both state and identity tests; expected PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/errors.mjs scripts/lib/fs.mjs scripts/lib/workspace.mjs scripts/lib/state.mjs scripts/lib/identity.mjs tests/state.test.mjs tests/identity.test.mjs
git commit -m "feat: add durable jobs and caller authorization"
```

## Task 3: ZCode Discovery, Broker, and Protocol Adapter

**Files:**
- Create: `scripts/lib/process.mjs`
- Create: `scripts/lib/zcode-discovery.mjs`
- Create: `scripts/lib/zcode-protocol.mjs`
- Create: `scripts/lib/zcode-client.mjs`
- Create: `scripts/zcode-broker.mjs`
- Create: `tests/zcode-discovery.test.mjs`
- Create: `tests/zcode-client.test.mjs`
- Create: `tests/fixtures/fake-zcode-cli.mjs`

- [ ] **Step 1: Write failing discovery tests**

Assert discovery order: explicit configured path, `PATH`, platform locations, then macOS bundled `/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs`. Assert JavaScript entrypoints launch with `process.execPath`, native executables launch directly, versions below `0.16.1` fail with `ZCODE_VERSION_UNSUPPORTED`, and missing CLI fails with `ZCODE_NOT_FOUND` plus setup remedy.

- [ ] **Step 2: Run RED, implement discovery, run GREEN**

Run: `node --test tests/zcode-discovery.test.mjs`

Implement injectable `platform`, `env`, `which`, `exists`, and `runVersion` dependencies so tests do not depend on the host installation. Expected final result: PASS.

- [ ] **Step 3: Write the fake protocol peer and failing adapter tests**

The fixture must parse newline-delimited messages and record calls. Tests cover:

```text
session/create              including model and importedHistory
session/send
session/read
session/resume
session/list
session/stop
session/setModel
session/setThoughtLevel
interaction/requestPermission
state.updated completion
disconnect and malformed frames
```

Assert `importedHistory.source` is isolated as literal `claudeCode`, models use `{providerId, modelId, variant?}`, advertised thought levels are validated before send, and notification completion is correlated only to the requested session.

- [ ] **Step 4: Run RED, implement broker/client, run GREEN**

Run: `node --test tests/zcode-client.test.mjs`

Implement a broker endpoint abstraction that uses Unix sockets on macOS/Linux and named pipes on Windows, a PID/identity file, lazy start, health probe, request IDs, bounded frame size, timeout, graceful close, and owner-aware idle shutdown. Expected: PASS with no leaked child process.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/process.mjs scripts/lib/zcode-discovery.mjs scripts/lib/zcode-protocol.mjs scripts/lib/zcode-client.mjs scripts/zcode-broker.mjs tests/zcode-discovery.test.mjs tests/zcode-client.test.mjs tests/fixtures/fake-zcode-cli.mjs
git commit -m "feat: add ZCode protocol adapter"
```

## Task 4: Companion Review, Rescue, and Job Control

**Files:**
- Create: `scripts/lib/args.mjs`
- Create: `scripts/lib/git.mjs`
- Create: `scripts/lib/prompts.mjs`
- Create: `scripts/lib/review.mjs`
- Create: `scripts/lib/job-control.mjs`
- Create: `scripts/lib/render.mjs`
- Create: `scripts/zcode-companion.mjs`
- Create: `prompts/review.md`
- Create: `prompts/adversarial-review.md`
- Create: `schemas/review-output.schema.json`
- Create: `tests/args.test.mjs`
- Create: `tests/permissions.test.mjs`
- Create: `tests/job-control.test.mjs`
- Create: `tests/integration/companion.test.mjs`

- [ ] **Step 1: Write failing public argument tests**

Cover the exact approved contracts. Assert mutually exclusive flags, Rescue foreground default, `status --wait` requiring a job ID, 240,000 ms default, `--timeout-ms` rejection without `--wait`, `provider/model` parsing, configured aliases, and rejection of `spark`, `--force`, `--prompt-file`, and public `--write`.

- [ ] **Step 2: Run RED, implement parser, run GREEN**

Run: `node --test tests/args.test.mjs`

Return structured `{command, options, positionals}` or a typed `PluginError`; never call `process.exit` inside the parser.

- [ ] **Step 3: Write failing permission and orchestration tests**

Assert reviews deny every mutation; writable Rescue allows low/medium; high/critical is allowed only for exact `bypassPermissions`; unknown denies. Assert resume selects only the latest same-owner/same-workspace Rescue with a ZCode session ID. Assert cancellation uses `running -> cancelling -> cancelled` only after stop acknowledgement and rolls back to `running` on failed stop.

- [ ] **Step 4: Run RED, implement orchestration, run GREEN**

Run:

```bash
node --test tests/permissions.test.mjs tests/job-control.test.mjs
```

Prompt templates must clearly identify read-only review versus writable Rescue, include Git scope/base facts as data blocks, and require structured findings without putting runtime flags into prompt text.

- [ ] **Step 5: Write failing companion integration tests**

Using the fake ZCode fixture and temporary plugin data, execute the real CLI for foreground review, adversarial focus, foreground Rescue, background reservation, private single-use `run-reserved-job`, status/list/wait, result, and cancel. Assert stdout/stderr/exit codes and persisted artifacts; assert secret capabilities are absent from prompts, results, logs, and rendered output.

- [ ] **Step 6: Run RED, implement command router, run GREEN**

Run: `node --test tests/integration/companion.test.mjs`

Expected: all paths PASS, a replayed execution capability fails, and foreground success is recorded only after its result artifact is durable.

- [ ] **Step 7: Commit**

```bash
git add scripts/lib/args.mjs scripts/lib/git.mjs scripts/lib/prompts.mjs scripts/lib/review.mjs scripts/lib/job-control.mjs scripts/lib/render.mjs scripts/zcode-companion.mjs prompts schemas tests/args.test.mjs tests/permissions.test.mjs tests/job-control.test.mjs tests/integration/companion.test.mjs
git commit -m "feat: implement review rescue and job commands"
```

## Task 5: Codex Host Adapter and Transfer

**Files:**
- Create: `scripts/lib/codex-app-server.mjs`
- Create: `scripts/lib/transfer.mjs`
- Create: `tests/fixtures/fake-codex-app-server.mjs`
- Create: `tests/codex-app-server.test.mjs`
- Create: `tests/transfer.test.mjs`
- Modify: `scripts/zcode-companion.mjs`
- Modify: `tests/integration/companion.test.mjs`

- [ ] **Step 1: Write failing bounded app-server tests**

Assert the client spawns `codex app-server`, sends `initialize`, waits for its response, sends `thread/read` with `{threadId, includeTurns: true}`, ignores unrelated notifications, enforces 15 seconds by default, bounds stderr, and terminates the child on success, error, timeout, or malformed response.

- [ ] **Step 2: Run RED, implement client, run GREEN**

Run: `node --test tests/codex-app-server.test.mjs`

Expected: PASS against the fake app-server with dependency-injected executable/args.

- [ ] **Step 3: Write failing Transfer conversion tests**

Test current source from validated caller context, explicit `--source`, inaccessible thread failure before ZCode session creation, ordered user/assistant text extraction, omission of unsupported tool/hidden items, empty-history rejection, timestamps when available, and ZCode `importedHistory: {source: "claudeCode", messages}`.

- [ ] **Step 4: Run RED, implement Transfer, run GREEN**

Run: `node --test tests/transfer.test.mjs`

Render `Imported from Codex`, the ZCode session ID, and a resume command built from the resolved launcher. Never parse `transcript_path`.

- [ ] **Step 5: Add and run full Transfer integration test**

Run: `node --test tests/integration/companion.test.mjs`

Expected: real companion talks to both fake app-servers and creates a resumable imported ZCode session without leaking caller context.

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/codex-app-server.mjs scripts/lib/transfer.mjs scripts/zcode-companion.mjs tests/fixtures/fake-codex-app-server.mjs tests/codex-app-server.test.mjs tests/transfer.test.mjs tests/integration/companion.test.mjs
git commit -m "feat: transfer Codex history into ZCode"
```

## Task 6: Codex Hooks, Setup, and Review Gate

**Files:**
- Create: `hooks/hooks.json`
- Create: `hooks/lib/hook-input.mjs`
- Create: `hooks/session-lifecycle-hook.mjs`
- Create: `hooks/user-prompt-hook.mjs`
- Create: `hooks/subagent-hook.mjs`
- Create: `hooks/stop-review-gate-hook.mjs`
- Create: `hooks/session-end-hook.mjs`
- Create: `scripts/lib/codex-config.mjs`
- Create: `prompts/stop-review-gate.md`
- Create: `tests/hooks.test.mjs`
- Create: `tests/setup.test.mjs`

- [ ] **Step 1: Write failing hook contract tests**

Assert hook registration and input bounds. Interleave two sessions in one workspace and verify distinct caller contexts, permission snapshots, turn baselines, unread results, and session-end ownership cleanup. Assert hook output contains only the internal caller instruction and bounded user-relevant context, never persisted secrets.

- [ ] **Step 2: Run RED, implement lifecycle hooks, run GREEN**

Run: `node --test tests/hooks.test.mjs`

Use documented `PLUGIN_ROOT` and `PLUGIN_DATA`, hook stdin `session_id`, `turn_id`, `permission_mode`, and `hook_event_name`; do not depend on `CLAUDE_ENV_FILE` or `CODEX_THREAD_ID`.

- [ ] **Step 3: Write failing review-gate tests**

Cover disabled, no baseline, unchanged fingerprint, nested/forwarding suppression, duplicate session/turn/fingerprint, setup-not-ready fail-open, `ALLOW:`, `BLOCK:`, empty/malformed output, task failure, and timeout. Assert only the exact Stop session/turn can atomically consume its baseline.

- [ ] **Step 4: Run RED, implement Stop gate, run GREEN**

Run: `node --test tests/hooks.test.mjs`

The hook must output valid Stop JSON, cap inline reasons, persist the full gate snapshot, and never approve a ZCode mutation.

- [ ] **Step 5: Write failing setup tests**

Assert setup discovers/version-checks/auth-checks ZCode, enables only stable `features.hooks`, never writes removed `features.plugin_hooks`, validates active plugin hook paths, trusts exact hashes through Codex `config/batchWrite`, never edits plugin cache files, preserves unrelated hooks/config, and toggles only workspace review-gate state.

- [ ] **Step 6: Run RED, implement setup, run GREEN**

Run: `node --test tests/setup.test.mjs`

Expected: deterministic reports for ready, restart-required, untrusted, outdated, missing, and unauthenticated states.

- [ ] **Step 7: Commit**

```bash
git add hooks scripts/lib/codex-config.mjs prompts/stop-review-gate.md tests/hooks.test.mjs tests/setup.test.mjs
git commit -m "feat: add Codex lifecycle hooks and setup"
```

## Task 7: Eight Skills, Release Docs, CI, and End-to-End Verification

**Files:**
- Create: `skills/{review,adversarial-review,rescue,transfer,status,result,cancel,setup}/SKILL.md`
- Create: `skills/*/agents/openai.yaml`
- Create: `agents/zcode-rescue.md`
- Create: `tests/skills-contracts.test.mjs`
- Create: `tests/integration/skills.test.mjs`
- Create: `README.md`
- Create: `README.zh-CN.md`
- Create: `SECURITY.md`
- Create: `CHANGELOG.md`
- Create: `.github/workflows/ci.yml`
- Create: `tests/e2e/real-zcode.test.mjs`
- Create: `tests/integration/package-install.test.mjs`

- [ ] **Step 1: Write failing skill contract tests**

Assert exactly eight skill directories, `$zcode:` naming, approved argument hints, plugin-root resolution, unchanged argv forwarding, caller-context forwarding only on Skill-facing commands, built-in subagent use only for explicit background work, no public `spark`/`--force`/`--prompt-file`/`--write`, and Transfer presence.

- [ ] **Step 2: Run RED, implement skills/agent, run GREEN**

Run: `node --test tests/skills-contracts.test.mjs`

Each `SKILL.md` must explain when to invoke, its public arguments, interaction rules, exact companion call, error presentation, and no protocol internals. Rescue defaults foreground. Review/adversarial are read-only. The forwarding agent accepts only a reserved job ID and one-time execution capability.

- [ ] **Step 3: Add failing skill integration tests and make them pass**

Run: `node --test tests/integration/skills.test.mjs`

Exercise every skill against fake Codex/ZCode peers, including the two-session interleave and background execution replay rejection.

- [ ] **Step 4: Write release documentation and CI**

Document installation through a Codex marketplace, ZCode `>=0.16.1`, macOS bundled discovery, model aliases, all eight commands, permission limits, job storage, review gate, troubleshooting, Linux/Windows qualification status, and Apache-2.0 provenance.

Add a package-install integration test that packs the plugin, installs that tarball into an empty temporary consumer with production dependencies only, asserts the bundled plugin-local `bare-addon-resolve` is exactly `1.9.4`, loads the installed `fs-native-extensions` binding on Node 18.18, and acquires/releases a lock through the installed companion runtime. The test must prove that the native dependency is installed beside the plugin rather than relying on the repository's development `node_modules`.

CI runs the fake-protocol suite on current macOS, Ubuntu, and Windows. Each platform job must start with `npm ci`, run `npm run check`, perform the clean packed-plugin production install, and execute a binding-load plus lock smoke test. Include Node 18.18 coverage for the pinned override in addition to the current Node LTS matrix. A platform job is not successful if it skips the native binding smoke.

- [ ] **Step 5: Add opt-in real ZCode E2E**

`tests/e2e/real-zcode.test.mjs` must skip unless `ZCODE_REAL_E2E=1`. When enabled on macOS it verifies discovery/version/auth diagnostics, creates a harmless temporary-workspace read-only session, selects a configured test model when supplied, stops a session, and imports two synthetic Codex turns. It must not depend on exact model prose or modify the repository.

- [ ] **Step 6: Run the complete verification suite**

Run:

```bash
npm ci
npm run check
node --test tests/integration/package-install.test.mjs
npm pack --dry-run
npm ci --omit=dev
node -e "const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path'); const lock = require('fs-native-extensions'); const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-lock-')); const file = fs.openSync(path.join(dir, 'smoke.lock'), 'a+'); if (!lock.tryLock(file)) throw new Error('native lock unavailable'); lock.unlock(file); fs.closeSync(file); fs.rmSync(dir, { recursive: true });"
npm ci
python3 /Users/zhangzikai/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py .
git diff --check
```

Expected: all lint, typecheck, unit, integration, contract, fake-protocol, clean-install, native-binding, and packaging checks pass; plugin validation succeeds; no whitespace errors. The direct `npm ci --omit=dev` smoke verifies production installation from the lockfile, while `tests/integration/package-install.test.mjs` verifies the packed plugin in an isolated consumer.

If ZCode is authenticated and a harmless model is available, additionally run:

```bash
ZCODE_REAL_E2E=1 node --test tests/e2e/real-zcode.test.mjs
```

Record a skip as unqualified local real E2E, not as a pass.

- [ ] **Step 7: Commit**

```bash
git add skills agents tests README.md README.zh-CN.md SECURITY.md CHANGELOG.md .github/workflows/ci.yml
git commit -m "feat: ship complete ZCode for Codex plugin"
```

## Final Review and Completion

- [ ] Dispatch an independent full-spec reviewer against `docs/superpowers/specs/2026-08-03-zcode-plugin-codex-design.md` and all commits since the plan baseline.
- [ ] Fix every spec-compliance finding and re-run the affected tests.
- [ ] Dispatch an independent code-quality reviewer only after spec approval.
- [ ] Fix every important quality finding and re-run `npm run check`.
- [ ] Run `git status --short`, `git log --oneline --decorate`, plugin validation, and the full verification suite once more before claiming completion.
