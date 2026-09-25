// @ts-nocheck
/**
 * Bounded turn-identity matrix rules for the direct `mcpServer/tool/call`
 * feasibility probe (plan Task 4). This module is PURE — no IO, no host, no
 * durable state — and owns two frozen decision surfaces:
 *
 * 1. `classifyDirectIdentitySample` — the ordered attribution of one identity
 *    sample: whether the host's independently learned thread/turn identity,
 *    the ordered turn-state observations around the durable handler entry,
 *    and the per-run salted metadata candidate hashes prove a live-turn
 *    binding, a correlation, an inconclusive race, or a contradiction.
 * 2. The synthetic authorization-bridge candidate (`authorizeDirectIdentityCall`
 *    / `admitDirectIdentityCall` over `createDirectIdentityPreparationStore`)
 *    — a LOCAL fixture model of what an invocation-authority seam would have
 *    to guarantee. It is a candidate, never a fact: a passing fixture
 *    demonstrates the admission MECHANISM only and never upgrades G2, whose
 *    authority must come from a demonstrated trusted-caller path on the
 *    tested host.
 *
 * Every identity value crosses this module as a per-run salted hash only;
 * raw host IDs, paths, and diagnostic labels are inputs the caller must
 * already have reduced. A matching diagnostic label is correlation input and
 * is not part of any decision here.
 */
import { randomBytes } from 'node:crypto';

import { DIRECT_TURN_STATES } from './observer.mjs';

/** The closed identity classification vocabulary of one sample. */
export const DIRECT_IDENTITY_CLASSIFICATIONS = Object.freeze([
  'binding-observed',      // ordered active-turn proof + salted candidate equality
  'correlation-only',      // hashes correlate; no ordered live-turn authority proof
  'inconclusive',          // the turn landscape changed across the entry window, unattributed
  'mismatch-observed',     // a usable candidate contradicts the independently learned identity
  'no-candidate-observed', // durable entry, no usable metadata candidate
  'not-observed',          // no durable handler entry join for the sample
]);

/**
 * The closed operation vocabulary of the authorization-bridge candidate: the
 * one operation under qualification is a direct `mcpServer/tool/call`.
 */
export const DIRECT_IDENTITY_OPERATIONS = Object.freeze(['mcpServerToolCall']);

/**
 * The closed trusted-caller vocabulary of the fixture. The ONLY entry is the
 * probe driver acting on its OWN probe thread — the one caller path a local
 * fixture can honestly demonstrate. It is FIXTURE-INTERNAL trust: it proves
 * the admission mechanism, never host authority, and `classifyDirectGateG2`
 * (driver.mjs) refuses to upgrade G2 from it.
 */
export const DIRECT_IDENTITY_TRUSTED_CALLER_SOURCES = Object.freeze(['probe-driver-own-thread']);

/** The closed placement-adapter vocabulary of the fixture. */
export const DIRECT_IDENTITY_ADAPTERS = Object.freeze(['foreground', 'background']);

/** The closed rejection reason codes of the candidate admission gate. */
export const DIRECT_IDENTITY_REJECTION_REASONS = Object.freeze([
  'untrusted-caller', 'invalid-identity', 'invalid-operation', 'already-expired',
  'duplicate-authorization',
  'preparation-receipt-missing', 'preparation-missing', 'preparation-consumed', 'authorization-cancelled', 'authorization-expired',
  'operation-mismatch', 'thread-mismatch', 'turn-mismatch',
  'workspace-mismatch', 'permission-mismatch', 'executor-mismatch', 'adapter-mismatch',
  'host-thread-mismatch', 'host-turn-mismatch', 'host-turn-not-active',
]);

const DIRECT_HASH_PATTERN = /^[0-9a-f]{64}$/;

/** @param {string} code @param {string} message */
function identityError(code, message) {
  const error = /** @type {Error & {code:string}} */ (new Error(`${code}: ${message}`));
  error.code = code;
  return error;
}

/** Validates one salted-hash-or-null input. */
function requireHashOrNull(value, name) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !DIRECT_HASH_PATTERN.test(value)) {
    throw identityError('DIRECT_IDENTITY_INVALID', `${name} must be a 64 hexadecimal salted hash or null.`);
  }
  return value;
}

/** Validates one ordered turn observation or null. */
function requireTurnObservation(turn, name, entrySequence, position) {
  if (turn === null || turn === undefined) return null;
  if (!turn || typeof turn !== 'object' || Array.isArray(turn)) {
    throw identityError('DIRECT_IDENTITY_INVALID', `${name} must be a turn observation or null.`);
  }
  if (!DIRECT_TURN_STATES.includes(turn.state)) {
    throw identityError('DIRECT_IDENTITY_INVALID', `${name} requires a closed turn state.`);
  }
  if (!Number.isSafeInteger(turn.sequence)) {
    throw identityError('DIRECT_IDENTITY_INVALID', `${name} requires a bounded sequence.`);
  }
  const threadHash = requireHashOrNull(turn.threadHash, `${name}.threadHash`);
  const turnHash = requireHashOrNull(turn.turnHash, `${name}.turnHash`);
  // Ordering discipline: the pre-read must precede and the post-read must
  // follow the durable handler entry sequence; anything else is not an
  // observation of the entry window and is treated as absent (fail closed).
  const ordered = position === 'pre' ? turn.sequence < entrySequence : turn.sequence > entrySequence;
  if (!ordered) return null;
  return { sequence: turn.sequence, state: turn.state, threadHash, turnHash };
}

/**
 * Classifies ONE identity sample against the ordered-turn rules: a sample is
 * `binding-observed` only when the exact expected turn was observed ACTIVE
 * before AND after the durable handler entry, and the usable metadata
 * candidates agree with the independently learned host identity under the
 * per-run salt. A matching diagnostic label is not an input and can never
 * upgrade a sample. Mismatch beats binding; ordering decides between binding,
 * inconclusive, and correlation.
 * @param {{
 *   entryJoined: boolean,
 *   entrySequence: number,
 *   metadataCandidates: {envelopeThreadId: ?string, innerSessionId: ?string, innerThreadId: ?string, innerTurnId: ?string},
 *   expectedThreadHash: ?string,
 *   expectedTurnHash: ?string,
 *   preTurn: ?{sequence: number, state: string, threadHash: ?string, turnHash: ?string},
 *   postTurn: ?{sequence: number, state: string, threadHash: ?string, turnHash: ?string},
 * }} sample
 * @returns {string} one of DIRECT_IDENTITY_CLASSIFICATIONS
 */
export function classifyDirectIdentitySample(sample) {
  if (!sample || typeof sample !== 'object' || Array.isArray(sample)) {
    throw identityError('DIRECT_IDENTITY_INVALID', 'The identity sample must be an object.');
  }
  if (typeof sample.entryJoined !== 'boolean') {
    throw identityError('DIRECT_IDENTITY_INVALID', 'The identity sample requires a boolean entryJoined.');
  }
  if (!Number.isSafeInteger(sample.entrySequence)) {
    throw identityError('DIRECT_IDENTITY_INVALID', 'The identity sample requires a bounded entrySequence.');
  }
  const candidates = sample.metadataCandidates;
  if (!candidates || typeof candidates !== 'object' || Array.isArray(candidates)) {
    throw identityError('DIRECT_IDENTITY_INVALID', 'The identity sample requires the metadata candidate map.');
  }
  for (const key of ['envelopeThreadId', 'innerSessionId', 'innerThreadId', 'innerTurnId']) {
    requireHashOrNull(candidates[key], `metadataCandidates.${key}`);
  }
  const expectedThreadHash = requireHashOrNull(sample.expectedThreadHash, 'expectedThreadHash');
  const expectedTurnHash = requireHashOrNull(sample.expectedTurnHash, 'expectedTurnHash');
  const preTurn = requireTurnObservation(sample.preTurn, 'preTurn', sample.entrySequence, 'pre');
  const postTurn = requireTurnObservation(sample.postTurn, 'postTurn', sample.entrySequence, 'post');

  // Without a durable entry join there is nothing to attribute.
  if (!sample.entryJoined) return 'not-observed';
  // With an entry but no usable candidate there is nothing to compare.
  const usableCandidates = ['envelopeThreadId', 'innerSessionId', 'innerThreadId', 'innerTurnId']
    .filter((key) => typeof candidates[key] === 'string');
  if (usableCandidates.length === 0) return 'no-candidate-observed';

  // Candidate-vs-host contradictions beat every other observation: a usable
  // candidate that disagrees with the independently learned host identity is
  // a mismatch, whatever the turn state was (wrong thread, stale turn).
  //
  // COMPARABILITY ASYMMETRY (explicit): the schedule learns ONLY the host's
  // thread.id and turn.id, so `envelopeThreadId`/`innerThreadId` compare
  // against `expectedThreadHash` and `innerTurnId` against
  // `expectedTurnHash`. `innerSessionId` is recorded as a usable candidate
  // (presence/type evidence) but is NEVER compared: the host exposes no
  // session identity this probe could independently learn, so there is
  // nothing for it to agree or disagree with — it can neither produce a
  // mismatch nor strengthen a binding. If a host-side session identity ever
  // becomes learnable, add the expected hash input and the comparison here.
  if (expectedThreadHash !== null && typeof candidates.envelopeThreadId === 'string' && candidates.envelopeThreadId !== expectedThreadHash) {
    return 'mismatch-observed';
  }
  if (expectedThreadHash !== null && typeof candidates.innerThreadId === 'string' && candidates.innerThreadId !== expectedThreadHash) {
    return 'mismatch-observed';
  }
  if (expectedTurnHash !== null && typeof candidates.innerTurnId === 'string' && candidates.innerTurnId !== expectedTurnHash) {
    return 'mismatch-observed';
  }

  // Ordered activity: the EXACT expected turn (learned independently, never
  // from the metadata) must be observed active before AND after the entry.
  const preActive = preTurn !== null
    && preTurn.state === 'active'
    && expectedTurnHash !== null
    && preTurn.turnHash === expectedTurnHash;
  const postActive = postTurn !== null
    && postTurn.state === 'active'
    && expectedTurnHash !== null
    && postTurn.turnHash === expectedTurnHash;
  if (preActive && postActive) {
    // BINDING METADATA REQUIREMENT: ordered host activity alone is not a
    // binding. The sample must also carry a matching, independently
    // COMPARABLE thread candidate AND a matching comparable turn candidate —
    // `innerSessionId` is incomparable and thread-only or turn-only evidence
    // is partial — so the metadata genuinely corroborates the same identity
    // the ordered observations established. Incomparable-only or partial
    // metadata stays correlation-only, never binding.
    const threadComparable = (typeof candidates.envelopeThreadId === 'string' && candidates.envelopeThreadId === expectedThreadHash)
      || (typeof candidates.innerThreadId === 'string' && candidates.innerThreadId === expectedThreadHash);
    const turnComparable = typeof candidates.innerTurnId === 'string' && candidates.innerTurnId === expectedTurnHash;
    if (threadComparable && turnComparable) return 'binding-observed';
    return 'correlation-only';
  }
  // The pre-read saw the expected turn active but it was no longer active at
  // the post-read (or a different turn took its place): the turn may have
  // ended before handler entry, so the sample stays unattributed.
  const preActiveAny = preTurn !== null && preTurn.state === 'active';
  const postActiveAny = postTurn !== null && postTurn.state === 'active';
  if (preActiveAny && (!postActiveAny || postTurn.turnHash !== preTurn.turnHash)) return 'inconclusive';
  // Everything else — idle threads, completed turns, one-sided observations —
  // is correlation only. Correlation is never authority.
  return 'correlation-only';
}

// ---------------------------------------------------------------------------
// The synthetic authorization-bridge candidate (plan Task 4 Step 4).
// Modeled on the existing Rescue preparation store's consume-time discipline
// (exact turn/workspace/permission/executor binding, expiry, once-only atomic
// consume), this LOCAL fixture demonstrates what an invocation-authority seam
// would have to guarantee. It is a candidate, not a fact: the trusted-caller
// vocabulary contains only the probe driver on its own probe thread, and no
// tested host demonstrated any caller path into it.
// ---------------------------------------------------------------------------

const DIRECT_IDPREP_PATTERN = /^[0-9a-f]{64}$/;
const DIRECT_IDPREP_TEXT_PATTERN = /^[\x20-\x7e]{1,64}$/;

/** @param {string} code @param {string} message */
function requireBoundedText(value, name) {
  if (typeof value !== 'string' || !DIRECT_IDPREP_TEXT_PATTERN.test(value)) {
    throw identityError('DIRECT_IDENTITY_INVALID', `${name} must be bounded printable text.`);
  }
  return value;
}

/** Validates the salted identity fields shared by authorize and admit. */
function requireIdentityFields({ threadHash, turnHash, workspaceHash }) {
  if (typeof threadHash !== 'string' || !DIRECT_IDPREP_PATTERN.test(threadHash)
    || typeof turnHash !== 'string' || !DIRECT_IDPREP_PATTERN.test(turnHash)
    || typeof workspaceHash !== 'string' || !DIRECT_IDPREP_PATTERN.test(workspaceHash)) {
    throw identityError('DIRECT_IDENTITY_INVALID', 'The authorization candidate requires 64 hexadecimal salted thread, turn, and workspace hashes.');
  }
}

/**
 * Validates an admit request's caller declarations against a preparation.
 * The request carries the caller-side key `executorAgentId`; the preparation
 * records it as `requiredExecutorAgentId`. Null and undefined both read as
 * "no required executor binding".
 * @returns {string|null} the first mismatching reason code, or null
 */
function preparationMismatch(preparation, request) {
  if (request.operation !== preparation.operation) return 'operation-mismatch';
  if (request.threadHash !== preparation.threadHash) return 'thread-mismatch';
  if (request.turnHash !== preparation.turnHash) return 'turn-mismatch';
  if (request.workspaceHash !== preparation.workspaceHash) return 'workspace-mismatch';
  if (request.permissionMode !== preparation.permissionMode) return 'permission-mismatch';
  if ((request.executorAgentId ?? null) !== preparation.requiredExecutorAgentId) return 'executor-mismatch';
  if (request.foregroundAdapter !== preparation.foregroundAdapter) return 'adapter-mismatch';
  return null;
}

/**
 * Builds the preparation store. All inputs and outputs carry per-run salted
 * hashes only; the store never sees a raw host identity. `authorize` issues a
 * preparation only on the demonstrated (fixture-internal) trusted-caller
 * path; `admit` is the atomic, once-only admission gate; `cancel` records a
 * cancelled authorization; `preparationById` exposes a preparation for
 * verification. Store verdicts are closed `{status, reasonCode?}` objects —
 * policy outcomes never throw.
 */
export function createDirectIdentityPreparationStore() {
  /** @type {Map<string, object>} */
  const preparations = new Map();
  return {
    /**
     * Issues one synthetic preparation. Fails closed on any untrusted caller,
     * unknown operation, past expiry, or malformed identity.
     */
    authorize(input) {
      if (!input || typeof input !== 'object') throw identityError('DIRECT_IDENTITY_INVALID', 'authorize requires an input object.');
      if (!DIRECT_IDENTITY_TRUSTED_CALLER_SOURCES.includes(input.callerSource)) {
        return { status: 'rejected', reasonCode: 'untrusted-caller' };
      }
      if (!DIRECT_IDENTITY_OPERATIONS.includes(input.operation)) {
        return { status: 'rejected', reasonCode: 'invalid-operation' };
      }
      requireIdentityFields(input);
      requireBoundedText(input.permissionMode, 'permissionMode');
      if (input.requiredExecutorAgentId !== null && input.requiredExecutorAgentId !== undefined
        && (typeof input.requiredExecutorAgentId !== 'string' || !DIRECT_IDPREP_PATTERN.test(input.requiredExecutorAgentId))) {
        throw identityError('DIRECT_IDENTITY_INVALID', 'requiredExecutorAgentId must be a 64 hexadecimal salted hash or null.');
      }
      if (!DIRECT_IDENTITY_ADAPTERS.includes(input.foregroundAdapter)) {
        throw identityError('DIRECT_IDENTITY_INVALID', 'foregroundAdapter must be a closed placement adapter.');
      }
      if (!Number.isSafeInteger(input.now) || !Number.isSafeInteger(input.expiresAt)) {
        throw identityError('DIRECT_IDENTITY_INVALID', 'authorize requires bounded integer now and expiresAt.');
      }
      if (input.expiresAt <= input.now) return { status: 'rejected', reasonCode: 'already-expired' };
      // One LIVE authorization per exact (thread, turn, operation) identity:
      // a second authorize for an identity that still has a live (unconsumed,
      // uncancelled, unexpired) preparation is refused, so the unclaimed
      // admit lookup can never depend on insertion order between two
      // identical authorizations. Re-authorization after the earlier one was
      // consumed, cancelled, or expired is allowed.
      for (const existing of preparations.values()) {
        if (existing.operation === input.operation
          && existing.threadHash === input.threadHash
          && existing.turnHash === input.turnHash
          && existing.consumedAt === null
          && existing.cancelledAt === null
          && existing.expiresAt > input.now) {
          return { status: 'rejected', reasonCode: 'duplicate-authorization' };
        }
      }
      const preparationId = randomBytes(16).toString('hex');
      const preparation = {
        version: 1,
        preparationId,
        callerSource: input.callerSource,
        threadHash: input.threadHash,
        turnHash: input.turnHash,
        operation: input.operation,
        workspaceHash: input.workspaceHash,
        permissionMode: input.permissionMode,
        requiredExecutorAgentId: input.requiredExecutorAgentId ?? null,
        foregroundAdapter: input.foregroundAdapter,
        createdAt: input.now,
        expiresAt: input.expiresAt,
        consumedAt: null,
        cancelledAt: null,
      };
      preparations.set(preparationId, preparation);
      return { status: 'authorized', preparation };
    },
    /**
     * The admission gate. Atomic and once-only: a successful admit consumes
     * the preparation at `now`, and any later admit of the same preparation
     * is rejected. Admission is bound to the UNIQUE PREPARATION RECEIPT the
     * caller was issued at authorize time — thread/turn identity alone never
     * selects a preparation, so a replay of an earlier request can never
     * consume a newer reauthorization of the same identity. A missing
     * receipt fails closed (`preparation-receipt-missing`); an unknown
     * receipt fails closed (`preparation-missing`); a receipt whose
     * preparation contradicts the request on ANY bound dimension fails with
     * that dimension's closed code; and a receipt identifying a consumed
     * original reports `preparation-consumed` instead of silently consuming
     * anything newer.
     */
    admit({ request, hostObservation, preparationId, now }) {
      if (!request || typeof request !== 'object' || !hostObservation || typeof hostObservation !== 'object') {
        throw identityError('DIRECT_IDENTITY_INVALID', 'admit requires request and hostObservation objects.');
      }
      if (typeof preparationId !== 'string' || preparationId.length === 0) {
        return { status: 'rejected', reasonCode: 'preparation-receipt-missing' };
      }
      if (!Number.isSafeInteger(now)) throw identityError('DIRECT_IDENTITY_INVALID', 'admit requires a bounded integer now.');
      requireIdentityFields(request);
      requireBoundedText(request.permissionMode, 'permissionMode');
      if (request.executorAgentId !== null && request.executorAgentId !== undefined
        && (typeof request.executorAgentId !== 'string' || !DIRECT_IDPREP_PATTERN.test(request.executorAgentId))) {
        throw identityError('DIRECT_IDENTITY_INVALID', 'executorAgentId must be a 64 hexadecimal salted hash or null.');
      }
      const requestShape = {
        operation: request.operation,
        threadHash: request.threadHash,
        turnHash: request.turnHash,
        workspaceHash: request.workspaceHash,
        permissionMode: request.permissionMode,
        executorAgentId: request.executorAgentId ?? null,
        foregroundAdapter: request.foregroundAdapter,
      };
      // Lookup: the claimed receipt ONLY. The request's thread/turn identity
      // never selects a preparation, so a replay of an earlier (consumed)
      // request can never be re-resolved onto a newer reauthorization.
      const preparation = preparations.get(preparationId) ?? null;
      if (!preparation) return { status: 'rejected', reasonCode: 'preparation-missing' };
      // Caller and identity dimensions come FIRST: a foreign claim on an
      // already-consumed preparation must surface the identity mismatch, not
      // merely consumption, so a late call can never disguise whose
      // authorization it tried to consume.
      if (!DIRECT_IDENTITY_TRUSTED_CALLER_SOURCES.includes(request.callerSource)
        || request.callerSource !== preparation.callerSource) {
        return { status: 'rejected', reasonCode: 'untrusted-caller' };
      }
      const mismatch = preparationMismatch(preparation, requestShape);
      if (mismatch !== null) return { status: 'rejected', reasonCode: mismatch };
      if (preparation.cancelledAt !== null) return { status: 'rejected', reasonCode: 'authorization-cancelled' };
      if (preparation.consumedAt !== null) return { status: 'rejected', reasonCode: 'preparation-consumed' };
      if (now >= preparation.expiresAt) return { status: 'rejected', reasonCode: 'authorization-expired' };
      // The host observation must independently confirm the exact authorized
      // turn, active, with the ordered pre/post evidence present.
      if (hostObservation.threadHash !== preparation.threadHash) return { status: 'rejected', reasonCode: 'host-thread-mismatch' };
      if (hostObservation.turnHash !== preparation.turnHash) return { status: 'rejected', reasonCode: 'host-turn-mismatch' };
      if (hostObservation.state !== 'active' || hostObservation.preObserved !== true || hostObservation.postObserved !== true) {
        return { status: 'rejected', reasonCode: 'host-turn-not-active' };
      }
      // ATOMIC CONSUME: exactly once, decided at admission.
      preparation.consumedAt = now;
      return { status: 'admitted', preparationId: preparation.preparationId, consumedAt: now };
    },
    /** Records a cancelled authorization; a cancelled preparation never admits. */
    cancel(preparationId, now) {
      const preparation = preparations.get(preparationId) ?? null;
      if (!preparation) return { status: 'rejected', reasonCode: 'preparation-missing' };
      if (preparation.cancelledAt === null) preparation.cancelledAt = now;
      return { status: 'cancelled', preparationId: preparation.preparationId };
    },
    /** Verification accessor for fixtures and tests. */
    preparationById(preparationId) {
      return preparations.get(preparationId) ?? null;
    },
  };
}
