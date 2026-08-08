# Cross-Session Orphan Rescue Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Safely settle a provably orphaned writable Rescue so another Codex session can reserve work without adopting the old job or claiming an unacknowledged remote stop.

**Architecture:** Extend the recovery module with a policy-driven single-job settlement core and an internal workspace scavenger. Writable reservation retries once after scavenging. SessionEnd uses an existing-broker-only client and the same cancellation-lock settlement semantics before generic owner release. Public owner selection remains unchanged.

**Tech Stack:** Node.js 22.13+ ESM, `node:test`, ZCode 0.16.1 JSON-lines protocol, native advisory locks, the existing managed broker and state store.

---

## File Map

- `scripts/lib/recovery.mjs`: shared settlement, cross-owner scavenging, post-stop reread, and SessionEnd settlement.
- `scripts/zcode-companion.mjs`: one writable reservation retry after scavenging.
- `scripts/lib/state.mjs`: honest writable-conflict remedy.
- `scripts/zcode-broker.mjs`: shared exact wire-profile identity calculation and bounded health probing.
- `scripts/lib/zcode-client.mjs`: exact-profile existing-broker-only client.
- `hooks/session-end-hook.mjs`: durable settlement before generic owner cleanup.
- `tests/recovery.test.mjs`, `tests/state.test.mjs`, `tests/integration/companion.test.mjs`, `tests/zcode-client.test.mjs`, `tests/hooks.test.mjs`: focused regression coverage.
- `tests/session-end.test.mjs`: isolated SessionEnd settlement matrix.
- `README.md`, `README.zh-CN.md`, `CHANGELOG.md`, `tests/release-contracts.test.mjs`: user-visible behavior.

### Task 1: Cross-Owner Writable Scavenger

**Files:**
- Modify: `scripts/lib/recovery.mjs`
- Modify: `tests/recovery.test.mjs`

- [ ] **Step 1: Write failing tests for blocker selection, maintenance identity, and lease proof**

Add these tests:

- `cross-owner scavenging derives maintenance ownership from each durable writable blocker`
- `workspace scavenging never inspects a blocker whose exact worker lease is held`
- `workspace scavenging ignores read-only and terminal jobs`

Use the wished-for API:

```js
const { scavengeWritableJobs } = await import('../scripts/lib/recovery.mjs');
await scavengeWritableJobs({
  store,
  dataRoot: fixture.dataRoot,
  workspace: fixture.workspace,
  reconcileOwnership: async ({ ownerId, ownedSessionIds }) => reconciled.push({ ownerId, ownedSessionIds }),
  createClient: async (job, ownerId) => clients.get(job.id)(ownerId),
});
```

For the held-lease case, call the scavenger while `withWorkerLease` holds the persisted lease. Assert zero ownership/client calls and unchanged state. The API must not accept caller owner or remote-session selectors.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
node --test --test-name-pattern="cross-owner scavenging|workspace scavenging never|ignores read-only" tests/recovery.test.mjs
```

Expected: FAIL because `scavengeWritableJobs` is not exported.

- [ ] **Step 3: Implement the selection and lock/lease shell**

Add:

```js
export async function scavengeWritableJobs(input) {
  const jobs = (await input.store.listJobs(input.workspace))
    .filter((job) => job.command === 'rescue' && job.readOnly === false && !TERMINAL.has(job.status));
  const outcomes = [];
  for (const job of jobs) {
    outcomes.push(await settleSelectedJob({
      ...input,
      selectedJobId: job.id,
      expectedOwnerSessionId: job.ownerSessionId,
      intent: 'scavenge',
    }).catch(() => job));
  }
  return outcomes;
}
```

`settleSelectedJob` acquires `withJobCancellationLock`, rereads the job, rechecks ID/owner/writable/nonterminal predicates, and probes a persisted lease with `withWorkerLease(..., timeoutMs: 0)`. `LOCK_TIMEOUT` returns the unchanged job without remote work. Never hold the workspace state lock around remote I/O.

- [ ] **Step 4: Write failing policy tests**

Add:

- `workspace scavenging preserves an unclaimed reservation through claim grace and fails it after expiry`
- `workspace scavenging stops an active orphan and rereads completion before terminalizing`
- `workspace scavenging retains the writable guard when active stop is unacknowledged`
- `workspace scavenging maps paused running to failed but requires stop acknowledgement for cancelling`
- `workspace scavenging fails an orphan whose persisted remote session is missing`
- `terminal completion racing orphan settlement is never overwritten`

Use an injected clock and assert unclaimed age from immutable `createdAt`. For active stop/reread, return `running`, acknowledge `stopSession`, then return `completed` with a current-turn result; assert `succeeded`, one stop, two reads, and a result artifact. For stop failure, assert `running` plus bounded `lastCancelError`.

- [ ] **Step 5: Run the new tests and verify RED**

```bash
node --test --test-name-pattern="claim grace|stops an active orphan|active stop is unacknowledged|paused running|remote session is missing|racing orphan" tests/recovery.test.mjs
```

Expected: FAIL against the current same-owner-only behavior.

- [ ] **Step 6: Implement policy-driven settlement**

Refactor the private recovery core to accept `intent: 'owner-recovery' | 'scavenge'`. Same-owner recovery continues to retain active `running` work. Scavenging stops active work.

`stopThenSettle` must:

1. call `session/stop` once;
2. retain `running + lastCancelError` if it is not acknowledged;
3. after acknowledgement, call `readSession` once;
4. publish a valid completed/idle current-turn result as `succeeded`;
5. otherwise publish `cancelled` when the durable pre-stop status was `cancelling`, or `failed` for scavenged `running`;
6. reread rather than overwrite a terminal/status-conflict winner.

Map paused `running` to `failed`. Paused `cancelling` must repeat stop and require acknowledgement. For unclaimed queued jobs use:

```js
const expired = now() - Date.parse(job.createdAt) >= LEGACY_QUEUED_STALE_MS;
```

- [ ] **Step 7: Verify GREEN and commit**

```bash
node --test tests/recovery.test.mjs
git add scripts/lib/recovery.mjs tests/recovery.test.mjs
git commit -m "fix: scavenge orphaned writable rescues"
```

Expected: all recovery tests PASS without unhandled rejections.

### Task 2: Reservation Retry and Owner Isolation

**Files:**
- Modify: `scripts/zcode-companion.mjs`
- Modify: `scripts/lib/state.mjs`
- Modify: `tests/integration/companion.test.mjs`
- Modify: `tests/state.test.mjs`

- [ ] **Step 1: Write failing integration and remedy tests**

Add:

- `a new owner scavenges one orphan blocker and retries writable reservation exactly once`
- `a live exact worker lease keeps a new owner blocked without remote inspection`
- `an unacknowledged orphan stop preserves WRITABLE_JOB_EXISTS with an honest remedy`
- `two new owners racing through scavenging admit at most one writable rescue`
- `the owner that triggers scavenging cannot status result cancel or resume the recovered job`
- `status --all reports a scavenged foreign job only through redacted other-owner metadata`
- `a recovered foreign completion remains readable only by its original owner`
- `writable exclusion remedy does not advertise a read-only rescue mode`

Make the first admission test use a dead/free lease whose persisted remote session is absent: the old job must become `failed` and owner B must successfully reserve. The live-lease test runs a real held exact lease while owner B invokes Rescue; assert `WRITABLE_JOB_EXISTS`, unchanged owner-A state, and zero remote list/read/stop calls.

The concurrency test invokes two distinct caller sessions concurrently after one orphan becomes recoverable. Assert one new reservation succeeds, one rejects with `WRITABLE_JOB_EXISTS`, and only one new writable job is active. Do not add a test-only admission lock.

For isolation, owner B triggers recovery of owner A's completed orphan. Assert B gets `OWNED_JOB_NOT_FOUND` for status/result/cancel, cannot resume A's session, and sees only redacted `owned: false`/`owner: 'other'` metadata through `status --all`. Owner A must still read the recovered result.

- [ ] **Step 2: Run tests and verify RED**

```bash
node --test --test-name-pattern="scavenges one orphan|live exact worker lease|unacknowledged orphan|racing through scavenging|triggers scavenging|scavenged foreign|foreign completion" tests/integration/companion.test.mjs
node --test --test-name-pattern="does not advertise a read-only" tests/state.test.mjs
```

- [ ] **Step 3: Implement exactly one writable retry**

Replace the direct public reservation with:

```js
async function reservePublicJob(context, reservation) {
  try {
    return await context.store.reserveJob(reservation);
  } catch (error) {
    if (reservation.readOnly || !(error instanceof PluginError) || error.code !== 'WRITABLE_JOB_EXISTS') throw error;
    await scavengeWritableJobs({
      store: context.store,
      dataRoot: context.dataRoot,
      workspace: context.cwd,
      createClient: async (job, ownerId) => {
        context.signal?.throwIfAborted();
        const launch = await discoverLaunch(context.env, context.dependencies);
        return (context.dependencies?.createManagedZCodeClient ?? createManagedZCodeClient)({
          dataRoot: context.dataRoot,
          workspace: context.cwd,
          launch,
          ownerId,
          env: context.env,
          ...managedWireOptionsForJob(job),
        });
      },
    });
    return context.store.reserveJob(reservation);
  }
}
```

Keep normal same-owner startup reconciliation. Do not return scavenged job payloads. Change the conflict remedy to exactly:

```text
Retry later or inspect the redacted workspace list with $zcode:status --all.
```

- [ ] **Step 4: Verify GREEN and commit**

```bash
node --test tests/state.test.mjs tests/integration/companion.test.mjs
git add scripts/zcode-companion.mjs scripts/lib/state.mjs tests/integration/companion.test.mjs tests/state.test.mjs
git commit -m "fix: retry rescue after orphan settlement"
```

### Task 3: Existing-Broker-Only Client Boundary

**Files:**
- Modify: `scripts/zcode-broker.mjs`
- Modify: `scripts/lib/zcode-client.mjs`
- Modify: `tests/zcode-client.test.mjs`

- [ ] **Step 1: Write failing exact-profile and no-spawn tests**

Add:

- `existing managed client connects to the exact healthy wire profile without ensuring a broker`
- `existing managed client returns null and never spawns when the broker is absent`
- `existing managed client does not fall back to a sibling wire profile`
- `existing managed client bounds an unhealthy broker probe`
- `existing managed client returns null when the broker dies between health and connect`

The wished-for call intentionally has no `launch` or `env`:

```js
const client = await createExistingManagedZCodeClient({
  dataRoot,
  workspace,
  ownerId,
  requestTimeoutMs: 100,
  maxFrameBytes: 16 * 1024 * 1024,
  maxOutboundBytes: 16 * 1024 * 1024,
});
```

Create default and hashed broker identities together and prove only the exact requested wire profile is contacted. Missing, wrong-profile, or unhealthy identity returns `null` within the request timeout.

- [ ] **Step 2: Run and verify RED**

```bash
node --test --test-name-pattern="existing managed client" tests/zcode-client.test.mjs
```

Expected: FAIL because the API is absent.

- [ ] **Step 3: Share profile identity calculation**

Export and use from both ensure and connect paths:

```js
export function brokerIdentityNameForWireOptions(options = {}) {
  const profile = options.maxFrameBytes === undefined
    && options.maxOutboundBytes === undefined
    && options.drainTimeoutMs === undefined
    ? null
    : createHash('sha256').update(JSON.stringify([
        options.maxFrameBytes ?? null,
        options.maxOutboundBytes ?? null,
        options.drainTimeoutMs ?? null,
      ])).digest('hex').slice(0, 16);
  return profile ? `identity-${profile}.json` : 'identity.json';
}
```

Allow `probeBrokerHealth(record, requestTimeoutMs = 1_000)` with a validated bounded positive integer.

- [ ] **Step 4: Implement the existing-only client**

```js
export async function createExistingManagedZCodeClient(options) {
  const storage = await resolveWorkspaceStorage(options);
  const identityName = brokerIdentityNameForWireOptions(options);
  const identity = await readHealthyBrokerIdentity(resolve(storage.directory, 'broker', identityName), {
    healthProbe: (record) => probeBrokerHealth(record, options.requestTimeoutMs),
  });
  if (!identity) return null;
  try {
    return await createZCodeClient({
      workspace: storage.workspacePath,
      brokerEndpoint: identity.endpoint,
      brokerToken: identity.brokerToken,
      ownerId: options.ownerId,
      requestTimeoutMs: options.requestTimeoutMs,
      maxFrameBytes: options.maxFrameBytes,
      maxOutboundBytes: options.maxOutboundBytes,
      drainTimeoutMs: options.drainTimeoutMs,
    });
  } catch {
    return null;
  }
}
```

Validate the same wire bounds as managed client construction. Never call `ensureZCodeBroker`, scan sibling profiles, reconcile ownership, or accept launch configuration.

- [ ] **Step 5: Verify GREEN and commit**

```bash
node --test tests/zcode-client.test.mjs tests/zcode-protocol.test.mjs
git add scripts/zcode-broker.mjs scripts/lib/zcode-client.mjs tests/zcode-client.test.mjs
git commit -m "feat: connect to existing zcode broker profiles"
```

### Task 4: Bounded SessionEnd Settlement

**Files:**
- Modify: `scripts/lib/recovery.mjs`
- Modify: `hooks/session-end-hook.mjs`
- Create: `tests/session-end.test.mjs`
- Modify: `tests/hooks.test.mjs`

- [ ] **Step 1: Write failing exact-owner settlement tests**

Create `tests/session-end.test.mjs` with:

- unclaimed queued becomes `cancelled` and a later claim fails;
- claimed queued with held lease stays queued, free lease becomes `cancelled`;
- completed first read becomes `succeeded` with an artifact and zero stops;
- active read, acknowledged stop, and noncompleted reread becomes `cancelled`;
- completion racing stop becomes `succeeded`;
- null existing client, lock contention, read timeout, and stop failure leave the job nonterminal;
- foreign-owner and read-only jobs remain untouched;
- a concurrent terminal executor outcome is never overwritten.

Use:

```js
await settleEndedOwnerWritableJob({
  store,
  dataRoot,
  workspace,
  ownerSessionId: 'owner-a',
  lockTimeoutMs: 0,
  requestTimeoutMs: 250,
  createClient: async (job, ownerId) => existingClients.get(job.id)?.(ownerId) ?? null,
});
```

Assert the original owner and remote session come only from the reread job.

- [ ] **Step 2: Run and verify RED**

```bash
node --test tests/session-end.test.mjs
```

Expected: FAIL because `settleEndedOwnerWritableJob` is absent.

- [ ] **Step 3: Implement bounded settlement by reusing the recovery core**

Export `settleEndedOwnerWritableJob` from `scripts/lib/recovery.mjs`. Select only the ending owner's active writable Rescue. Acquire its cancellation lock with `lockTimeoutMs ?? 0`, reread, and recheck all predicates.

Queued rules:

```js
if (job.status === 'queued' && !isDigest(job.workerLeaseId)) return cancelQueued(job);
if (job.status === 'queued') {
  try {
    return await withWorkerLease({ ...leaseInput, timeoutMs: 0 }, () => cancelQueued(job));
  } catch (error) {
    if (error instanceof PluginError && error.code === 'LOCK_TIMEOUT') return job;
    throw error;
  }
}
```

For `running`/`cancelling`, require an accepted session and a non-null existing-only client. Do not reconcile ownership. Under the same cancellation lock perform read → optional stop → reread. A valid completed/idle result becomes `succeeded`; acknowledged stop with no provable completion becomes `cancelled`; missing client or unacknowledged operation leaves the job nonterminal. Close the client in `finally`.

Catch cancellation-lock `LOCK_TIMEOUT` as advisory unchanged output. Every protocol request uses the client-level `requestTimeoutMs`; never use the default 30-second lock timeout.

- [ ] **Step 4: Verify settlement unit tests GREEN**

```bash
node --test tests/session-end.test.mjs tests/recovery.test.mjs
```

- [ ] **Step 5: Write failing real-hook ordering tests**

Add:

- `SessionEnd settles its writable job before generic owner release and preserves siblings`
- `SessionEnd never starts a broker when exact existing settlement is unavailable`
- `generic releasedSessionIds never terminalize a durable job`
- `SessionEnd remains bounded when the existing broker or stop acknowledgement is unavailable`
- `a failed SessionEnd stop is later settled by reservation scavenging before owner B is admitted`

The acknowledged case persists an owner-A running Rescue, creates a fake managed-broker session, runs the hook, then asserts owner A terminal and owner B unchanged. The unavailable case records zero ZCode spawns, keeps the job active, still cleans hook/identity state, and finishes within 2.5 seconds. The fallback sequence first makes SessionEnd stop fail, then releases the worker lease and changes the remote fixture to completed or missing; owner B's later Rescue must settle A through reservation scavenging and reserve successfully.

- [ ] **Step 6: Wire the hook in settlement → release → cleanup order**

```js
const ownerSessionId = input.session_id;
const ownerId = ownerIdForSession(ownerSessionId);
const store = createStateStore({ dataRoot });
await settleEndedOwnerWritableJob({
  store,
  dataRoot,
  workspace: input.cwd,
  ownerSessionId,
  requestTimeoutMs: 250,
  lockTimeoutMs: 0,
  createClient: (job, derivedOwnerId) => createExistingManagedZCodeClient({
    dataRoot,
    workspace: input.cwd,
    ownerId: derivedOwnerId,
    requestTimeoutMs: 250,
  }),
}).catch(() => null);
await releaseManagedZCodeOwner({ dataRoot, workspace: input.cwd, ownerId, requestTimeoutMs: 500 }).catch(() => null);
await Promise.allSettled([
  cleanupSession(dataRoot, input.cwd, ownerSessionId),
  createIdentityStore({ dataRoot }).cleanupSession(input.cwd, ownerSessionId),
]);
```

The only writable command is Rescue and uses the default profile; pin that invariant in a test. Never use generic `releasedSessionIds` to transition a job.

- [ ] **Step 7: Verify GREEN and commit**

```bash
node --test tests/session-end.test.mjs tests/hooks.test.mjs tests/recovery.test.mjs tests/zcode-client.test.mjs
git add scripts/lib/recovery.mjs hooks/session-end-hook.mjs tests/session-end.test.mjs tests/hooks.test.mjs
git commit -m "fix: settle writable rescue on session end"
```

### Task 5: Documentation and Full Verification

**Files:**
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `CHANGELOG.md`
- Modify: `tests/release-contracts.test.mjs`

- [ ] **Step 1: Write failing release-contract tests**

Require both READMEs to state that a later Rescue settles a provable orphan without transferring ownership; held leases and unacknowledged stops retain the guard; `$zcode:status --all` is redacted inspection; and SessionEnd is best effort with reservation-time crash fallback. Require the Unreleased changelog to mention safe orphan settlement without a version bump.

- [ ] **Step 2: Verify RED**

```bash
node --test tests/release-contracts.test.mjs
```

- [ ] **Step 3: Update English, Chinese, and changelog text minimally**

Do not advertise force release, cross-owner result access, a read-only Rescue, publishing, installation, or a version change.

- [ ] **Step 4: Verify GREEN and commit**

```bash
node --test tests/release-contracts.test.mjs
git add README.md README.zh-CN.md CHANGELOG.md tests/release-contracts.test.mjs
git commit -m "docs: explain orphan rescue settlement"
```

- [ ] **Step 5: Run focused regression suites**

```bash
node --test tests/recovery.test.mjs tests/state.test.mjs tests/zcode-client.test.mjs tests/session-end.test.mjs tests/hooks.test.mjs tests/integration/companion.test.mjs tests/release-contracts.test.mjs
```

Expected: zero failures and zero cancellations.

- [ ] **Step 6: Run complete CI-equivalent verification**

```bash
npm run lint
npm run typecheck
npm test
npm run test:qualified
npm run check
git diff --check c753155...HEAD
git status --short --branch
```

Expected: all mandatory commands exit zero; real E2E tests may only report their documented explicit unqualified skips; no unstaged implementation changes remain.

- [ ] **Step 7: Run independent final reviews**

Using fixed point `c753155`, run parallel Standards and Spec reviews. The Spec reviewer compares the full diff to `/tmp/zcode-orphan-handoff.ETQEum/HANDOFF.md`, the amended lifecycle design, and ADR 0011. Resolve every blocking or high-severity finding, rerun affected tests, and repeat the relevant review until both axes pass.
