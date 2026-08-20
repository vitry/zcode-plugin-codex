# Conversation Progress Incident Completion Plan

**Goal:** Complete PR #36 so it fixes both the ZCode 0.16.3 conversation-frame incompatibility and the incident-specific fallback/state-integrity failures.

**Constraints:** Preserve bounded parsing, sequence/recovery fencing, source/marketplace byte identity, and existing lifecycle behavior. A structurally accepted online frame is not semantically healthy until it emits at least one public progress event.

## Task 1: Make online frame application transactional

**Files:**
- Modify: `scripts/lib/conversation-progress.mjs`
- Modify: `marketplace/plugins/zcode/scripts/lib/conversation-progress.mjs`
- Modify: `tests/conversation-progress.test.mjs`

1. Add a regression test where an online frame mutates a tool state, then waits on an async path description while a gap/overflow is marked. Recover and complete the same tool; assert data from the ignored frame is never emitted and its watermark was not committed.
2. Run the focused test and confirm it fails for the state leak.
3. Stage online-frame row/tool state, public events, terminal state, and watermarks locally. Commit them only after all async descriptions finish and the frame is still admissible.
4. Copy the implementation to the marketplace mirror and verify byte identity.
5. Run `node --test tests/conversation-progress.test.mjs`.

## Task 2: Keep fallback active until semantic online progress exists

**Files:**
- Modify: `scripts/lib/progress.mjs`
- Modify: `marketplace/plugins/zcode/scripts/lib/progress.mjs`
- Modify: `tests/progress.test.mjs`
- Modify: `tests/integration/companion.test.mjs`

1. Reverse the zero-event expectations: structurally accepted empty online frames still increment diagnostics but neither clean up an active snapshot fallback nor block compatibility-boundary activation.
2. Add an incident-shaped regression: repeated sequence/row-shape rejects activate fallback; interleaved accepted empty online frames preserve heartbeat snapshot reads; the first nonempty online event exits fallback exactly once; later empty frames do not regress state.
3. Run focused tests and confirm they fail before implementation.
4. Track semantic online health separately from structural acceptance and use it for fallback activation/cleanup.
5. Copy the implementation to the marketplace mirror and verify byte identity.
6. Run `node --test tests/progress.test.mjs tests/integration/companion.test.mjs`.

## Task 3: Align the design contract and changelog

**Files:**
- Modify: `docs/superpowers/specs/2026-08-15-rescue-forwarder-progress-compatibility-design.md`
- Modify: `CHANGELOG.md`
- Modify marketplace copies only where plugin contract tests require them.

1. State that ignored online frames commit neither state nor watermarks.
2. Distinguish structural acceptance from semantic health: only a nonempty bounded public event exits or permanently suppresses fallback.
3. Document the incident regression and user-visible consequence.

## Task 4: Independent review and verification

1. Run independent spec and standards reviews against `origin/main...HEAD`; fix all blockers and repeat reviews.
2. Run focused progress suites, `npm run check`, and `git diff --check origin/main...HEAD`.
3. Push the existing PR branch, then watch all six GitHub Actions matrix checks to success. Diagnose, fix, and rerun if any check fails.
