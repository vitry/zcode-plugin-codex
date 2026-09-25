// @ts-nocheck
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import fs, { readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import fsp, { chmod, lstat, mkdtemp, open, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';

import {
  DIRECT_EVENT_KINDS,
  DIRECT_PROBE_PHASES,
  DIRECT_RPC_CLASSIFICATIONS,
  appendDirectProbeEvent,
  readDirectProbeEvents,
  reduceDirectProbeEvents,
  reduceDirectProbeLog,
  validateDirectEventRecord,
  validateDirectResultRecord,
} from '../tools/direct-mcp-probe/observer.mjs';
import { createDirectProbeServer } from '../tools/direct-mcp-probe/server.mjs';
import { directProbeSealHead } from '../tools/direct-mcp-probe/probe-log.mjs';
import { canonicalJson, hashProbeValue } from '../tools/mcp-context-probe/observer.mjs';
import {
  ENTRY_CLASSIFICATION_STATES,
  ENTRY_CANDIDATES,
  ENTRY_DISPATCH_MODES,
  ENTRY_FIELD_MARKS,
  ENTRY_GATE_G4_DECISION_CODES,
  ENTRY_GATE_G4_MIN_HOLD_MS,
  ENTRY_REQUIRED_ASPECTS,
  ENTRY_ROW_FIELDS,
  classifyDirectGateG4,
  classifyEntryCandidate,
  inventoryEntryCandidates,
} from '../tools/direct-mcp-probe/entry-inventory.mjs';

/**
 * A candidate whose every plan-mandated row fact is demonstrated by a live
 * measurement of this run and whose dispatch is an explicit deterministic
 * user action. This is the positive control: only such a candidate may
 * classify `proven`.
 */
function demonstratedCandidate(overrides = {}) {
  const field = (note) => ({ mark: 'measured', note });
  return {
    id: 'fixture-explicit-entry',
    dispatch: 'explicit-deterministic',
    installedPluginBoundary: 'within',
    fields: {
      userAction: field('the user performed the single explicit entry action'),
      receivingComponent: field('the installed entry component received the action'),
      owningHostAccess: field('the component acted on the owning Host connection'),
      authorizationSource: field('the Host authorized the exact operation'),
      waitOwner: field('the entry component held the pending call'),
      outputRoute: field('the terminal result reached the original user'),
      cancellationRoute: field('the interruption reached the exact operation'),
      externalDependency: { mark: 'documented', note: 'none beyond the installed plugin' },
    },
    contradictions: [],
    ...overrides,
  };
}

test('entry decision classifies a fully demonstrated candidate as proven with no reasons', () => {
  const decision = classifyEntryCandidate(demonstratedCandidate());
  assert.deepEqual(decision, { status: 'proven', reasons: [] });
});

test('entry decision requires a live owning-host-access measurement', () => {
  const candidate = demonstratedCandidate();
  candidate.fields.owningHostAccess = { mark: 'documented', note: 'documented but never measured on the owning connection' };
  const decision = classifyEntryCandidate(candidate);
  assert.equal(decision.status, 'unproven');
  assert.ok(decision.reasons.includes('owning-host-access-unproven'));
});

test('entry decision requires a live terminal-delivery measurement', () => {
  const candidate = demonstratedCandidate();
  candidate.fields.outputRoute = { mark: 'unproven', note: 'no route back to the original user was demonstrated' };
  const decision = classifyEntryCandidate(candidate);
  assert.equal(decision.status, 'unproven');
  assert.ok(decision.reasons.includes('terminal-delivery-unproven'));
});

test('entry decision requires a live cancellation-routing measurement', () => {
  const candidate = demonstratedCandidate();
  candidate.fields.cancellationRoute = { mark: 'documented', note: 'no interruption reached the exact operation' };
  const decision = classifyEntryCandidate(candidate);
  assert.equal(decision.status, 'unproven');
  assert.ok(decision.reasons.includes('cancellation-routing-unproven'));
});

test('entry decision requires a live user-authorization measurement', () => {
  const candidate = demonstratedCandidate();
  candidate.fields.authorizationSource = { mark: 'documented', note: 'authorization for the exact user, operation, and turn described by docs only' };
  const decision = classifyEntryCandidate(candidate);
  assert.equal(decision.status, 'unproven');
  assert.deepEqual(decision.reasons, ['user-authorization-unproven']);
});

test('entry decision requires a live wait-ownership measurement', () => {
  const candidate = demonstratedCandidate();
  candidate.fields.waitOwner = { mark: 'unproven', note: 'no identified owner of the pending call' };
  const decision = classifyEntryCandidate(candidate);
  assert.equal(decision.status, 'unproven');
  assert.deepEqual(decision.reasons, ['wait-ownership-unproven']);
});

test('entry decision requires a measured receiving component even when the action is measured', () => {
  const candidate = demonstratedCandidate();
  candidate.fields.receivingComponent = { mark: 'documented', note: 'the receiver is described by docs only' };
  const decision = classifyEntryCandidate(candidate);
  assert.equal(decision.status, 'unproven');
  assert.deepEqual(decision.reasons, ['deterministic-dispatch-unproven']);
});

test('entry decision requires a measured user action even when the receiver is measured', () => {
  const candidate = demonstratedCandidate();
  candidate.fields.userAction = { mark: 'documented', note: 'the action is described by docs only' };
  const decision = classifyEntryCandidate(candidate);
  assert.equal(decision.status, 'unproven');
  assert.deepEqual(decision.reasons, ['deterministic-dispatch-unproven']);
});

test('entry decision rejects model-selected dispatch as deterministic', () => {
  const candidate = demonstratedCandidate({ dispatch: 'model-selected' });
  const decision = classifyEntryCandidate(candidate);
  assert.equal(decision.status, 'unproven');
  assert.deepEqual(decision.reasons, ['deterministic-dispatch-unproven', 'dispatch-model-selected']);
});

test('entry decision rejects lifecycle-automatic dispatch as deterministic', () => {
  const candidate = demonstratedCandidate({ dispatch: 'lifecycle-automatic' });
  const decision = classifyEntryCandidate(candidate);
  assert.equal(decision.status, 'unproven');
  assert.deepEqual(decision.reasons, ['deterministic-dispatch-unproven', 'dispatch-lifecycle-automatic']);
});

test('a driver-owned direct call never proves product entry even with every field measured', () => {
  const candidate = demonstratedCandidate({ dispatch: 'driver-owned' });
  const decision = classifyEntryCandidate(candidate);
  assert.equal(decision.status, 'unproven');
  assert.deepEqual(decision.reasons, ['deterministic-dispatch-unproven', 'dispatch-driver-owned']);
});

test('an external-host candidate never classifies proven even with every aspect measured', () => {
  const candidate = demonstratedCandidate({ installedPluginBoundary: 'external' });
  const decision = classifyEntryCandidate(candidate);
  assert.equal(decision.status, 'unproven');
  assert.deepEqual(decision.reasons, ['installed-plugin-boundary-external']);
});

test('a repeatable contradiction under tested conditions rejects the candidate', () => {
  const candidate = demonstratedCandidate({ contradictions: ['owning-host-access'] });
  const decision = classifyEntryCandidate(candidate);
  assert.deepEqual(decision, { status: 'rejected', reasons: ['owning-host-access-contradicted'] });
});

test('contradiction takes precedence over missing demonstrations', () => {
  const candidate = demonstratedCandidate({
    dispatch: 'model-selected',
    contradictions: ['terminal-delivery', 'cancellation-routing'],
  });
  candidate.fields.owningHostAccess = { mark: 'documented', note: 'never measured' };
  const decision = classifyEntryCandidate(candidate);
  assert.deepEqual(decision, {
    status: 'rejected',
    reasons: ['terminal-delivery-contradicted', 'cancellation-routing-contradicted'],
  });
});

test('entry decision fails closed on an unknown row-field mark', () => {
  const unknownMark = demonstratedCandidate();
  unknownMark.fields.waitOwner = { mark: 'assumed', note: 'not a closed mark' };
  assert.throws(() => classifyEntryCandidate(unknownMark), /ENTRY_CANDIDATE_INVALID/);
});

test('entry decision fails closed on an unknown dispatch mode', () => {
  const unknownDispatch = demonstratedCandidate({ dispatch: 'hopefully' });
  assert.throws(() => classifyEntryCandidate(unknownDispatch), /ENTRY_CANDIDATE_INVALID/);
});

test('entry decision fails closed on a missing row field', () => {
  const missingField = demonstratedCandidate();
  delete missingField.fields.authorizationSource;
  assert.throws(() => classifyEntryCandidate(missingField), /ENTRY_CANDIDATE_INVALID/);
});

test('entry decision fails closed on an extra row field', () => {
  const extraField = demonstratedCandidate();
  extraField.fields.extra = { mark: 'measured', note: 'not part of the closed row' };
  assert.throws(() => classifyEntryCandidate(extraField), /ENTRY_CANDIDATE_INVALID/);
});

test('entry decision fails closed on an unknown contradiction aspect', () => {
  const unknownAspect = demonstratedCandidate({ contradictions: ['model-feeling'] });
  assert.throws(() => classifyEntryCandidate(unknownAspect), /ENTRY_CANDIDATE_INVALID/);
});

test('entry decision fails closed on a missing candidate id', () => {
  const missingId = demonstratedCandidate();
  delete missingId.id;
  assert.throws(() => classifyEntryCandidate(missingId), /ENTRY_CANDIDATE_INVALID/);
});

test('entry decision fails closed on a missing dispatch mode', () => {
  const missingDispatch = demonstratedCandidate();
  delete missingDispatch.dispatch;
  assert.throws(() => classifyEntryCandidate(missingDispatch), /ENTRY_CANDIDATE_INVALID/);
});

test('entry decision fails closed on a missing candidate row', () => {
  const missingFields = demonstratedCandidate();
  delete missingFields.fields;
  assert.throws(() => classifyEntryCandidate(missingFields), /ENTRY_CANDIDATE_INVALID/);
});

test('entry decision fails closed on non-array contradictions', () => {
  const nonArrayContradictions = demonstratedCandidate({ contradictions: 'owning-host-access' });
  assert.throws(() => classifyEntryCandidate(nonArrayContradictions), /ENTRY_CANDIDATE_INVALID/);
});

test('entry decision fails closed on a missing contradictions array', () => {
  const missingContradictions = demonstratedCandidate();
  delete missingContradictions.contradictions;
  assert.throws(() => classifyEntryCandidate(missingContradictions), /ENTRY_CANDIDATE_INVALID/);
});

test('entry decision fails closed on null contradictions', () => {
  const nullContradictions = demonstratedCandidate({ contradictions: null });
  assert.throws(() => classifyEntryCandidate(nullContradictions), /ENTRY_CANDIDATE_INVALID/);
});

test('entry decision fails closed on a duplicate contradiction aspect', () => {
  const duplicateAspect = demonstratedCandidate({ contradictions: ['terminal-delivery', 'terminal-delivery'] });
  assert.throws(() => classifyEntryCandidate(duplicateAspect), /ENTRY_CANDIDATE_INVALID/);
});

test('entry decision fails closed on an unknown key inside a row field', () => {
  const extraKeyInField = demonstratedCandidate();
  extraKeyInField.fields.waitOwner = { mark: 'measured', note: 'a valid closed field', evidence: 'extra key' };
  assert.throws(() => classifyEntryCandidate(extraKeyInField), /ENTRY_CANDIDATE_INVALID/);
});

test('entry decision fails closed on an unknown top-level candidate key', () => {
  const sneakyTopLevel = demonstratedCandidate();
  sneakyTopLevel.sneakyTopLevel = 'x';
  assert.throws(() => classifyEntryCandidate(sneakyTopLevel), /ENTRY_CANDIDATE_INVALID/);
});

test('entry decision fails closed on a missing installed-plugin boundary', () => {
  const missingBoundary = demonstratedCandidate();
  delete missingBoundary.installedPluginBoundary;
  assert.throws(() => classifyEntryCandidate(missingBoundary), /ENTRY_CANDIDATE_INVALID/);
});

test('entry decision fails closed on an unknown installed-plugin boundary', () => {
  const unknownBoundary = demonstratedCandidate({ installedPluginBoundary: 'adjacent' });
  assert.throws(() => classifyEntryCandidate(unknownBoundary), /ENTRY_CANDIDATE_INVALID/);
});

test('shipped inventory row leaves are deep-frozen against in-place mutation', () => {
  const candidate = ENTRY_CANDIDATES.find((entry) => entry.id === 'skill-model-selected');
  assert.throws(() => { candidate.fields.owningHostAccess.mark = 'measured'; }, TypeError);
  assert.equal(candidate.fields.owningHostAccess.mark, 'unproven');
});

test('the entry vocabularies encode the plan floor plus the spec G4 requirements', () => {
  assert.deepEqual([...ENTRY_CLASSIFICATION_STATES], ['proven', 'unproven', 'rejected']);
  assert.deepEqual(
    [...ENTRY_REQUIRED_ASPECTS],
    [
      'owning-host-access',
      'deterministic-dispatch',
      'user-authorization',
      'wait-ownership',
      'terminal-delivery',
      'cancellation-routing',
    ],
  );
  assert.deepEqual([...ENTRY_FIELD_MARKS], ['documented', 'measured', 'unproven']);
  assert.deepEqual(
    [...ENTRY_ROW_FIELDS],
    [
      'userAction',
      'receivingComponent',
      'owningHostAccess',
      'authorizationSource',
      'waitOwner',
      'outputRoute',
      'cancellationRoute',
      'externalDependency',
    ],
  );
});

test('the shipped inventory carries only unproven or rejected documented candidates', () => {
  const inventory = inventoryEntryCandidates();
  assert.ok(inventory.length >= 5, 'the inventory covers the documented candidate classes');
  const ids = new Set(inventory.map((entry) => entry.candidate.id));
  assert.equal(ids.size, inventory.length, 'candidate ids are unique');
  for (const entry of inventory) {
    assert.ok(
      entry.decision.status === 'unproven' || entry.decision.status === 'rejected',
      `${entry.candidate.id} must not claim proven entry without live demonstration`,
    );
    assert.ok(entry.decision.reasons.length > 0, `${entry.candidate.id} records why it is not proven`);
    for (const [key, field] of Object.entries(entry.candidate.fields)) {
      assert.ok(ENTRY_ROW_FIELDS.includes(key), `${entry.candidate.id} row key ${key} is in the closed row`);
      assert.ok(ENTRY_FIELD_MARKS.includes(field.mark), `${entry.candidate.id} field ${key} uses a closed mark`);
    }
  }
});

test('the shipped inventory includes the installed skill and hook candidates', () => {
  const ids = ENTRY_CANDIDATES.map((candidate) => candidate.id);
  assert.ok(ids.includes('skill-model-selected'), 'the installed model-selected Skill route is inventoried');
  assert.ok(ids.includes('hook-user-prompt-submit'), 'the installed UserPromptSubmit hook is inventoried');
  assert.ok(ids.includes('app-server-client-external'), 'the external app-server client is inventoried as probe host only');
  for (const candidate of ENTRY_CANDIDATES) {
    assert.ok(ENTRY_DISPATCH_MODES.includes(candidate.dispatch), `${candidate.id} uses a closed dispatch mode`);
    assert.ok(['within', 'external'].includes(candidate.installedPluginBoundary), `${candidate.id} records a closed installed-plugin boundary`);
    assert.ok(candidate.fields.userAction.note.length > 0, `${candidate.id} records its user action`);
  }
});

test('the external app-server client records authorization as unproven transport setup', () => {
  const candidate = ENTRY_CANDIDATES.find((entry) => entry.id === 'app-server-client-external');
  assert.equal(candidate.fields.authorizationSource.mark, 'unproven');
  assert.match(candidate.fields.authorizationSource.note, /Transport setup only/);
});

test('transport-level candidates record authorization as unproven, never per-invocation authority', () => {
  for (const id of ['skill-structured-input', 'app-server-client-external', 'remote-ui-client']) {
    const candidate = ENTRY_CANDIDATES.find((entry) => entry.id === id);
    assert.equal(candidate.fields.authorizationSource.mark, 'unproven', `${id} must not claim documented authorization`);
    assert.match(candidate.fields.authorizationSource.note, /transport/i, `${id} describes its access as transport-level`);
  }
});

test('shell-path candidates record direct-call authorization as unproven exec context', () => {
  for (const id of ['skill-model-selected', 'subagent-rescue-forwarder']) {
    const candidate = ENTRY_CANDIDATES.find((entry) => entry.id === id);
    assert.equal(candidate.fields.authorizationSource.mark, 'unproven', `${id} must not present exec-path authorization as direct-call authorization`);
    assert.match(candidate.fields.authorizationSource.note, /exec.path/i, `${id} keeps its exec-path evidence explicitly scoped`);
  }
});

test('waits and output routes documented only on other paths are unproven for the direct-call inventory', () => {
  const otherPathEvidence = [
    ['skill-model-selected', 'waitOwner'],
    ['skill-model-selected', 'outputRoute'],
    ['skill-structured-input', 'outputRoute'],
    ['hook-user-prompt-submit', 'waitOwner'],
    ['hook-user-prompt-submit', 'outputRoute'],
    ['hook-stop-gate', 'waitOwner'],
    ['subagent-rescue-forwarder', 'waitOwner'],
    ['subagent-rescue-forwarder', 'outputRoute'],
    ['app-server-client-external', 'outputRoute'],
  ];
  for (const [id, field] of otherPathEvidence) {
    const candidate = ENTRY_CANDIDATES.find((entry) => entry.id === id);
    assert.equal(candidate.fields[field].mark, 'unproven', `${id}.${field} must not present other-path evidence as direct-call documentation`);
  }
});

test('no candidate documents terminal delivery of a direct-call result to the original user/Child yet', () => {
  for (const candidate of ENTRY_CANDIDATES) {
    assert.equal(candidate.fields.outputRoute.mark, 'unproven', `${candidate.id} has no established direct-call terminal delivery to the original user/Child`);
  }
});

test('turn-level interruption is never a documented route to the exact pending operation', () => {
  for (const id of ['skill-structured-input', 'app-server-client-external']) {
    const candidate = ENTRY_CANDIDATES.find((entry) => entry.id === id);
    assert.equal(candidate.fields.cancellationRoute.mark, 'unproven', `${id} must not present turn-level interruption as a route to the exact pending operation`);
    assert.match(candidate.fields.cancellationRoute.note, /turn-level/i, `${id} scopes its note to turn-level interruption`);
  }
});

test('the driver-owned rows scope cancellation with the Task 5 lifecycle campaign findings', () => {
  for (const id of ['skill-structured-input', 'app-server-client-external']) {
    const candidate = ENTRY_CANDIDATES.find((entry) => entry.id === id);
    assert.equal(candidate.fields.cancellationRoute.mark, 'unproven', `${id} keeps cancellation unproven`);
    assert.match(candidate.fields.cancellationRoute.note, /lifecycle campaign/, `${id} cites the bounded direct-call lifecycle campaign`);
    assert.match(
      candidate.fields.cancellationRoute.note,
      /no route to a durable held MCP handler call is demonstrated/,
      `${id} states the campaign's cancellation finding, not just the older unmeasured question`,
    );
  }
});

test('setup and model actions are never documented as per-invocation user actions', () => {
  for (const id of ['plugin-mcp-server', 'subagent-rescue-forwarder']) {
    const candidate = ENTRY_CANDIDATES.find((entry) => entry.id === id);
    assert.equal(candidate.fields.userAction.mark, 'unproven', `${id} must not present installation or model dispatch as a user action`);
    assert.match(candidate.fields.userAction.note, /per-invocation|per-call/i, `${id} distinguishes its trigger from a per-invocation user action`);
  }
});

test('no candidate documents an explicit per-invocation user action for a direct MCP call yet', () => {
  for (const candidate of ENTRY_CANDIDATES) {
    assert.equal(candidate.fields.userAction.mark, 'unproven', `${candidate.id} has no documented per-invocation user action for a direct MCP call`);
    assert.match(candidate.fields.userAction.note, /per-invocation|per invocation|one-time|model/i, `${candidate.id} scopes its trigger evidence against the per-invocation requirement`);
  }
});

// ---------------------------------------------------------------------------
// Task 2: direct evidence formats, reducer, and independent handler entry.
// The evidence/decision contract below is fixed before any live collection:
// later tasks select outcomes from these closed vocabularies but never add
// kinds. Every handler's first durable action is handler entry.
// ---------------------------------------------------------------------------

function directRunNonce() { return randomBytes(32).toString('hex'); }

/**
 * A fixed run nonce so a salted digest can be pinned to a value precomputed
 * by an independent tool — python3 hashlib: sha256("{DIRECT_FIXED_NONCE}\0{value}")
 * — instead of being recomputed by the same implementation under test.
 */
const DIRECT_FIXED_NONCE = 'c'.repeat(64);
/** The driver-side capability secret used by tests acting as the driver. */
const DIRECT_DRIVER_SECRET = 'd'.repeat(64);
function directLabel() { return randomBytes(16).toString('hex'); }
function directCallNonce() { return randomBytes(16).toString('hex'); }
function directHash(seed) { return createHash('sha256').update(seed).digest('hex'); }

/** Last committed state per run directory: the driver's in-memory anchor. */
const directAnchors = new Map();

/** Appends one driver-side event through the public driver API and tracks the commit. */
async function directDriverAppend(run, nonce, event, phase = 'reachability', ownerSecret = DIRECT_DRIVER_SECRET) {
  const result = await appendDirectProbeEvent({ runDirectory: run, runNonce: nonce, phase, event, ownerSecret });
  directAnchors.set(run, result.commit);
  return result;
}

/** Wraps a server instance's writer so its commits update the run anchor. */
function trackDirectProbeServer(run, server) {
  const inner = server.probeDirectAppend.bind(server);
  server.probeDirectAppend = (event) => server.probeDirectAppendTracked(event);
  server.probeDirectAppendTracked = async (event) => {
    const result = await inner(event);
    directAnchors.set(run, result.commit);
    return result;
  };
  return server;
}

async function withDirectProbeRun(prefix, setup) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  await chmod(directory, 0o700);
  try { return await setup(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

/** Hands out flat direct-probe records with dense sequences for reducer fixtures. */
function directRecordBuilder(runNonceValue) {
  let sequence = 0;
  return (kind, fields = {}, overrides = {}) => ({
    version: 1,
    runNonce: runNonceValue,
    sequence: sequence++,
    phase: 'reachability',
    kind,
    ...fields,
    ...overrides,
  });
}

function directCandidateHashes(overrides = {}) {
  return {
    envelopeThreadId: directHash('fixture-envelope-thread'),
    innerSessionId: directHash('fixture-session'),
    innerThreadId: directHash('fixture-thread'),
    innerTurnId: null,
    ...overrides,
  };
}

test('direct evidence fixes the closed event-kind union before any host collection', () => {
  assert.deepEqual([...DIRECT_EVENT_KINDS], [
    'request-sent', 'server-started', 'readiness-observed', 'turn-state-observed', 'handler-entered',
    'metadata-observed', 'hold-started', 'trigger-sent', 'trigger-observed', 'handler-settled',
    'worker-settled', 'rpc-observed', 'entry-action-observed', 'terminal-delivered', 'cleanup-observed',
  ]);
  assert.ok(Object.isFrozen(DIRECT_EVENT_KINDS), 'later tasks may select outcomes but never add kinds');
  assert.deepEqual([...DIRECT_PROBE_PHASES], ['reachability', 'identity', 'lifecycle', 'entry']);
  assert.ok(Object.isFrozen(DIRECT_PROBE_PHASES));
  assert.deepEqual([...DIRECT_RPC_CLASSIFICATIONS], [
    'rpc-rejected', 'error-result-handler-entered', 'error-result-unknown-origin',
    'success-handler-entered', 'success-unknown-origin', 'not-observed',
  ]);
});

test('direct evidence validation rejects unknown kinds, unknown fields, and non-closed values', () => {
  const nonce = directRunNonce();
  const record = directRecordBuilder(nonce);
  assert.throws(
    () => validateDirectEventRecord(record('handler-never-entered', { probeLabel: directLabel(), callNonce: directCallNonce(), serverInstanceHash: directHash('i') }), { runNonce: nonce }),
    /PROBE_EVENT_KIND_UNKNOWN/,
    'a novel kind must fail closed',
  );
  assert.throws(
    () => validateDirectEventRecord(record('handler-entered', { probeLabel: directLabel(), callNonce: directCallNonce(), serverInstanceHash: directHash('i'), rawValue: 'leak' }), { runNonce: nonce }),
    /PROBE_EVENT_INVALID/,
    'an unknown field for the kind must fail closed',
  );
  assert.throws(
    () => validateDirectEventRecord(record('request-sent', { probeLabel: directLabel(), tool: 'mystery_tool', state: 'sent' }), { runNonce: nonce }),
    /PROBE_EVENT_INVALID/,
    'a non-closed enum value must fail closed',
  );
  const wrongVersion = record('handler-entered', { probeLabel: directLabel(), callNonce: directCallNonce(), serverInstanceHash: directHash('i') });
  wrongVersion.version = 2;
  assert.throws(() => validateDirectEventRecord(wrongVersion, { runNonce: nonce }), /PROBE_EVENT_INVALID/, 'a foreign record version must fail closed');
});

test('direct evidence rejects a wrong run nonce and an unknown phase', () => {
  const nonce = directRunNonce();
  const record = directRecordBuilder(nonce);
  const request = record('request-sent', { probeLabel: directLabel(), tool: 'capture_direct', state: 'sent' });
  assert.throws(() => validateDirectEventRecord(request, { runNonce: directRunNonce() }), /PROBE_RUN_NONCE_FOREIGN/);
  const wrongPhase = record('request-sent', { probeLabel: directLabel(), tool: 'capture_direct', state: 'sent' }, { phase: 'unplanned' });
  assert.throws(() => validateDirectEventRecord(wrongPhase, { runNonce: nonce }), /PROBE_EVENT_INVALID/);
});

test('direct evidence appends dense versioned sequences into the private log', async () => {
  await withDirectProbeRun('zcode-direct-observer-', async (run) => {
    const nonce = directRunNonce();
    await directDriverAppend(run, nonce, { kind: 'request-sent', probeLabel: directLabel(), tool: 'capture_direct', state: 'sent' });
    const server = trackDirectProbeServer(run, createDirectProbeServer({ observer: { runDirectory: run, runNonce: nonce, phase: 'reachability' }, ownerSecret: DIRECT_DRIVER_SECRET }));
    await server.probeDirectAppend({ kind: 'server-started', serverInstanceHash: directHash('fixture-instance') });
    const records = await readDirectProbeEvents({ runDirectory: run, runNonce: nonce });
    assert.deepEqual(records.map((record) => record.sequence), [0, 1], 'sequences are dense from zero');
    assert.equal(records[0].version, 1);
    assert.equal(records[0].runNonce, nonce);
    assert.equal(records[0].kind, 'request-sent');
    assert.equal(records[0].phase, 'reachability');
    const stats = await lstat(join(run, 'events.jsonl'));
    assert.equal(stats.mode & 0o777, 0o600, 'evidence stays private at mode 0600');
    await assert.rejects(
      () => directDriverAppend(run, directRunNonce(), { kind: 'request-sent', probeLabel: directLabel(), tool: 'capture_direct', state: 'sent' }),
      /PROBE_RUN_NONCE_FOREIGN/,
      'a foreign run nonce must never join the log',
    );
  });
});

test('direct evidence refuses a truncated final JSONL line', async () => {
  await withDirectProbeRun('zcode-direct-observer-', async (run) => {
    const nonce = directRunNonce();
    await directDriverAppend(run, nonce, { kind: 'request-sent', probeLabel: directLabel(), tool: 'capture_direct', state: 'sent' });
    const eventsPath = join(run, 'events.jsonl');
    const log = await readFile(eventsPath, 'utf8');
    assert.match(log, /\n$/, 'the appender keeps every line terminated');
    await writeFile(eventsPath, log.slice(0, -1), 'utf8');
    await assert.rejects(() => readDirectProbeEvents({ runDirectory: run, runNonce: nonce }), /PROBE_LOG_TORN/);
  });
});

test('direct evidence refuses symlinked evidence files', async () => {
  await withDirectProbeRun('zcode-direct-observer-', async (run) => {
    const nonce = directRunNonce();
    await directDriverAppend(run, nonce, { kind: 'request-sent', probeLabel: directLabel(), tool: 'capture_direct', state: 'sent' });
    const eventsPath = join(run, 'events.jsonl');
    await rename(eventsPath, join(run, 'events.underneath'));
    await symlink(join(run, 'events.underneath'), eventsPath);
    await assert.rejects(
      () => createDirectProbeServer({ observer: { runDirectory: run, runNonce: nonce, phase: 'reachability' }, ownerSecret: DIRECT_DRIVER_SECRET })
        .probeDirectAppend({ kind: 'server-started', serverInstanceHash: directHash('fixture-instance') }),
      /PROBE_LOG_SYMLINK/,
    );
    await assert.rejects(() => readDirectProbeEvents({ runDirectory: run, runNonce: nonce }), /PROBE_LOG_SYMLINK/);
  });
});

test('direct evidence reducer rejects a duplicate probe label across calls', async () => {
  await withDirectProbeRun('zcode-direct-observer-', async (run) => {
    const nonce = directRunNonce();
    const label = directLabel();
    const server = trackDirectProbeServer(run, createDirectProbeServer({ observer: { runDirectory: run, runNonce: nonce, phase: 'reachability' }, ownerSecret: DIRECT_DRIVER_SECRET }));
    await directDriverAppend(run, nonce, { kind: 'request-sent', probeLabel: label, tool: 'hold_direct', state: 'sent' });
    await server.probeDirectAppend({ kind: 'handler-entered', probeLabel: label, callNonce: directCallNonce(), serverInstanceHash: directHash('fixture-instance') });
    await assert.rejects(
      () => server.probeDirectAppend({ kind: 'handler-entered', probeLabel: label, callNonce: directCallNonce(), serverInstanceHash: directHash('fixture-instance') }),
      /PROBE_LABEL_DUPLICATE/,
      'one label must identify exactly one call',
    );
  });
});

test('direct evidence reducer rejects a duplicate handler entry for one call', async () => {
  await withDirectProbeRun('zcode-direct-observer-', async (run) => {
    const nonce = directRunNonce();
    const label = directLabel();
    const callNonce = directCallNonce();
    const server = trackDirectProbeServer(run, createDirectProbeServer({ observer: { runDirectory: run, runNonce: nonce, phase: 'reachability' }, ownerSecret: DIRECT_DRIVER_SECRET }));
    await directDriverAppend(run, nonce, { kind: 'request-sent', probeLabel: label, tool: 'capture_direct', state: 'sent' });
    await server.probeDirectAppend({ kind: 'handler-entered', probeLabel: label, callNonce, serverInstanceHash: directHash('fixture-instance') });
    await assert.rejects(
      () => server.probeDirectAppend({ kind: 'handler-entered', probeLabel: label, callNonce, serverInstanceHash: directHash('fixture-instance') }),
      /PROBE_ENTRY_DUPLICATE/,
      'one call must enter exactly once',
    );
  });
});

test('direct evidence reducer fails closed when a driver event names a call nonce with no durable entry', async () => {
  await withDirectProbeRun('zcode-direct-observer-', async (run) => {
    const nonce = directRunNonce();
    const label = directLabel();
    const server = trackDirectProbeServer(run, createDirectProbeServer({ observer: { runDirectory: run, runNonce: nonce, phase: 'reachability' }, ownerSecret: DIRECT_DRIVER_SECRET }));
    const reduce = () => reduceDirectProbeLog({ runDirectory: run, runNonce: nonce, ownerSecret: DIRECT_DRIVER_SECRET, ownerPid: process.pid, expectedFinalState: directAnchors.get(run) });
    await directDriverAppend(run, nonce, { kind: 'request-sent', probeLabel: label, tool: 'hold_direct', state: 'sent' });
    await directDriverAppend(run, nonce, { kind: 'trigger-sent', callNonce: directCallNonce(), outcome: 'turn-interrupt' });
    await assert.rejects(reduce, /PROBE_JOIN_FAILED/, 'a driver event may not name a call nonce without a durable entry join');
    const secondLabel = directLabel();
    const issuedNonce = directCallNonce();
    await directDriverAppend(run, nonce, { kind: 'request-sent', probeLabel: secondLabel, tool: 'hold_direct', state: 'sent' });
    await server.probeDirectAppend({ kind: 'handler-entered', probeLabel: secondLabel, callNonce: issuedNonce, serverInstanceHash: directHash('fixture-instance') });
    await directDriverAppend(run, nonce, { kind: 'trigger-observed', callNonce: directCallNonce(), outcome: 'acknowledged', source: 'host' });
    await assert.rejects(reduce, /PROBE_JOIN_FAILED/, 'a call nonce no handler issued must fail closed');
  });
});

test('direct evidence reducer rejects reversed event order for one call', async () => {
  await withDirectProbeRun('zcode-direct-observer-', async (run) => {
    const nonce = directRunNonce();
    const label = directLabel();
    const callNonce = directCallNonce();
    const server = trackDirectProbeServer(run, createDirectProbeServer({ observer: { runDirectory: run, runNonce: nonce, phase: 'reachability' }, ownerSecret: DIRECT_DRIVER_SECRET }));
    await directDriverAppend(run, nonce, { kind: 'request-sent', probeLabel: label, tool: 'capture_direct', state: 'sent' });
    // Metadata cannot be REDUCED before its entry: the write lands (the log
    // primitive has no cross-record ordering knowledge for metadata), and the
    // authenticated reduction fails closed.
    await server.probeDirectAppend({ kind: 'metadata-observed', callNonce, fields: [], fieldsTruncated: false, candidateHashes: directCandidateHashes(), state: 'malformed' });
    await server.probeDirectAppend({ kind: 'handler-entered', probeLabel: label, callNonce, serverInstanceHash: directHash('fixture-instance') });
    await assert.rejects(
      () => reduceDirectProbeLog({ runDirectory: run, runNonce: nonce, ownerSecret: DIRECT_DRIVER_SECRET, ownerPid: process.pid, expectedFinalState: directAnchors.get(run) }),
      /PROBE_ORDER_INVALID/,
      'metadata inspection may not precede handler entry',
    );
    // Settlements cannot even be WRITTEN before their entry: the log-level
    // guard rejects them at append time.
    await assert.rejects(
      () => server.probeDirectAppend({ kind: 'handler-settled', callNonce: directCallNonce(), outcome: 'completed' }),
      /PROBE_ORDER_INVALID/,
      'settlement may not precede handler entry',
    );
  });
});

test('direct evidence reducer fails closed on a cross-phase call nonce join', async () => {
  await withDirectProbeRun('zcode-direct-observer-', async (run) => {
    const nonce = directRunNonce();
    const label = directLabel();
    const callNonce = directCallNonce();
    const server = trackDirectProbeServer(run, createDirectProbeServer({ observer: { runDirectory: run, runNonce: nonce, phase: 'reachability' }, ownerSecret: DIRECT_DRIVER_SECRET }));
    await directDriverAppend(run, nonce, { kind: 'request-sent', probeLabel: label, tool: 'hold_direct', state: 'sent' });
    await server.probeDirectAppend({ kind: 'handler-entered', probeLabel: label, callNonce, serverInstanceHash: directHash('fixture-instance') });
    // The driver observes the trigger in a different phase than the entry:
    // the append lands (driver kind), and the durable join — bounded to one
    // phase — fails closed at reduction.
    await directDriverAppend(run, nonce, { kind: 'trigger-sent', callNonce, outcome: 'turn-interrupt' });
    await directDriverAppend(run, nonce, { kind: 'trigger-observed', callNonce, outcome: 'acknowledged', source: 'host' }, 'identity');
    await assert.rejects(
      () => reduceDirectProbeLog({ runDirectory: run, runNonce: nonce, ownerSecret: DIRECT_DRIVER_SECRET, ownerPid: process.pid, expectedFinalState: directAnchors.get(run) }),
      /PROBE_JOIN_FAILED/,
      'the durable join is bounded to one phase',
    );
  });
});

test('direct evidence reducer keeps an error origin unknown without a durable entry join', async () => {
  await withDirectProbeRun('zcode-direct-observer-', async (run) => {
    const nonce = directRunNonce();
    const label = directLabel();
    await directDriverAppend(run, nonce, { kind: 'request-sent', probeLabel: label, tool: 'capture_direct', state: 'sent' });
    await directDriverAppend(run, nonce, { kind: 'rpc-observed', probeLabel: label, outcome: 'error-result' });
    const reduced = await reduceDirectProbeLog({ runDirectory: run, runNonce: nonce, ownerSecret: DIRECT_DRIVER_SECRET, ownerPid: process.pid, expectedFinalState: directAnchors.get(run) });
    assert.equal(reduced.calls.length, 0, 'no durable entry means no attributed call');
    assert.deepEqual(reduced.unjoined, [{ probeLabel: label, phase: 'reachability', rpc: ['error-result-unknown-origin'] }], 'the origin stays unknown');
  });
});

test('direct evidence reducer attributes an error result only through the unique label join', async () => {
  await withDirectProbeRun('zcode-direct-observer-', async (run) => {
    const nonce = directRunNonce();
    const label = directLabel();
    const callNonce = directCallNonce();
    const instanceHash = directHash('fixture-instance');
    const server = trackDirectProbeServer(run, createDirectProbeServer({ observer: { runDirectory: run, runNonce: nonce, phase: 'reachability' }, ownerSecret: DIRECT_DRIVER_SECRET }));
    await directDriverAppend(run, nonce, { kind: 'request-sent', probeLabel: label, tool: 'capture_direct', state: 'sent' });
    await server.probeDirectAppend({ kind: 'server-started', serverInstanceHash: instanceHash });
    await server.probeDirectAppend({ kind: 'handler-entered', probeLabel: label, callNonce, serverInstanceHash: instanceHash });
    await server.probeDirectAppend({ kind: 'metadata-observed', callNonce, fields: [['threadId', 'string']], fieldsTruncated: false, candidateHashes: directCandidateHashes(), state: 'complete' });
    await directDriverAppend(run, nonce, { kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'error-result' });
    const reduced = await reduceDirectProbeLog({ runDirectory: run, runNonce: nonce, ownerSecret: DIRECT_DRIVER_SECRET, ownerPid: process.pid, expectedFinalState: directAnchors.get(run) });
    assert.deepEqual(reduced.phases, ['reachability']);
    assert.equal(reduced.calls.length, 1);
    assert.equal(reduced.calls[0].probeLabel, label);
    assert.equal(reduced.calls[0].callNonce, callNonce);
    assert.equal(reduced.calls[0].entrySequence, 2);
    assert.equal(reduced.calls[0].metadataState, 'complete');
    assert.deepEqual(reduced.calls[0].rpc, ['error-result-handler-entered']);
    assert.equal(reduced.calls[0].handlerSettled, null);
    assert.equal(reduced.calls[0].workerSettled, null);
    assert.equal(reduced.unjoined.length, 0);
  });
});

test('direct evidence reducer never interprets driver records as handler or worker settlement', async () => {
  await withDirectProbeRun('zcode-direct-observer-', async (run) => {
    const nonce = directRunNonce();
    const label = directLabel();
    const callNonce = directCallNonce();
    const workerHash = directHash('fixture-worker');
    const server = trackDirectProbeServer(run, createDirectProbeServer({ observer: { runDirectory: run, runNonce: nonce, phase: 'reachability' }, ownerSecret: DIRECT_DRIVER_SECRET }));
    await directDriverAppend(run, nonce, { kind: 'request-sent', probeLabel: label, tool: 'hold_direct', state: 'sent' });
    await server.probeDirectAppend({ kind: 'handler-entered', probeLabel: label, callNonce, serverInstanceHash: directHash('fixture-instance') });
    await server.probeDirectAppend({ kind: 'hold-started', callNonce, workerHash });
    await directDriverAppend(run, nonce, { kind: 'trigger-sent', callNonce, outcome: 'turn-interrupt' });
    await directDriverAppend(run, nonce, { kind: 'trigger-observed', callNonce, outcome: 'acknowledged', source: 'host' });
    await directDriverAppend(run, nonce, { kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'success-result' });
    let reduced = await reduceDirectProbeLog({ runDirectory: run, runNonce: nonce, ownerSecret: DIRECT_DRIVER_SECRET, ownerPid: process.pid, expectedFinalState: directAnchors.get(run) });
    assert.equal(reduced.calls[0].handlerSettled, null, 'an acknowledged trigger is not a handler settlement');
    assert.equal(reduced.calls[0].workerSettled, null, 'only a durable worker-settled record proves worker settlement');
    assert.deepEqual(reduced.calls[0].rpc, ['success-handler-entered']);
    await server.probeDirectAppend({ kind: 'handler-settled', callNonce, outcome: 'cancelled' });
    await server.probeDirectAppend({ kind: 'worker-settled', callNonce, workerHash, outcome: 'cancelled' });
    reduced = await reduceDirectProbeLog({ runDirectory: run, runNonce: nonce, ownerSecret: DIRECT_DRIVER_SECRET, ownerPid: process.pid, expectedFinalState: directAnchors.get(run) });
    assert.equal(reduced.calls[0].handlerSettled, 'cancelled');
    assert.equal(reduced.calls[0].workerSettled, 'cancelled');
  });
});

test('direct evidence reducer rejects a worker settlement that does not match the held worker', async () => {
  await withDirectProbeRun('zcode-direct-observer-', async (run) => {
    const nonce = directRunNonce();
    const label = directLabel();
    const callNonce = directCallNonce();
    const server = trackDirectProbeServer(run, createDirectProbeServer({ observer: { runDirectory: run, runNonce: nonce, phase: 'reachability' }, ownerSecret: DIRECT_DRIVER_SECRET }));
    await directDriverAppend(run, nonce, { kind: 'request-sent', probeLabel: label, tool: 'hold_direct', state: 'sent' });
    await server.probeDirectAppend({ kind: 'handler-entered', probeLabel: label, callNonce, serverInstanceHash: directHash('fixture-instance') });
    await server.probeDirectAppend({ kind: 'hold-started', callNonce, workerHash: directHash('worker-a') });
    await server.probeDirectAppend({ kind: 'handler-settled', callNonce, outcome: 'completed' });
    await assert.rejects(
      () => server.probeDirectAppend({ kind: 'worker-settled', callNonce, workerHash: directHash('worker-b'), outcome: 'completed' }),
      /PROBE_WORKER_MISMATCH/,
      'a settlement for a different synthetic worker fails closed',
    );
  });
});

test('direct evidence result record rejects unknown fields and a wrong run nonce', () => {
  const nonce = directRunNonce();
  const valid = {
    version: 1,
    provenance: {
      runNonce: nonce,
      codexVersion: 'codex-cli 0.155.1',
      codexBinaryDigest: directHash('fixture-binary'),
      platform: 'darwin-arm64',
      sdkVersion: '1.30.0',
      sourceCommit: 'a'.repeat(40),
      schemaDigest: directHash('fixture-schema'),
      fixtureMode: 'reachability',
    },
    evidence: { digest: directHash('fixture-evidence'), count: 5 },
    gates: {
      G1: { status: 'not-proven', reasonCode: 'entry-unobserved', evidenceRefs: ['rpc-observed@4'] },
      G2: { status: 'not-proven', reasonCode: 'authority-unproven', evidenceRefs: [] },
      G3: { status: 'not-proven', reasonCode: 'lifecycle-unproven', evidenceRefs: [] },
      G4: { status: 'not-proven', reasonCode: 'entry-candidate-unproven', evidenceRefs: [] },
    },
  };
  validateDirectResultRecord(valid, { runNonce: nonce });
  assert.throws(() => validateDirectResultRecord({ ...valid, unexpected: true }, { runNonce: nonce }), /PROBE_RESULT_INVALID/, 'unknown top-level fields fail closed');
  assert.throws(() => validateDirectResultRecord(valid, { runNonce: directRunNonce() }), /PROBE_RUN_NONCE_FOREIGN/, 'a wrong run nonce fails closed');
  const badStatus = structuredClone(valid);
  badStatus.gates.G1.status = 'assumed';
  assert.throws(() => validateDirectResultRecord(badStatus, { runNonce: nonce }), /PROBE_RESULT_INVALID/, 'a non-closed gate status fails closed');
  const badProvenance = structuredClone(valid);
  badProvenance.provenance.extra = 'x';
  assert.throws(() => validateDirectResultRecord(badProvenance, { runNonce: nonce }), /PROBE_RESULT_INVALID/, 'unknown provenance fields fail closed');
  const badGateKey = structuredClone(valid);
  badGateKey.gates.G5 = badGateKey.gates.G4;
  assert.throws(() => validateDirectResultRecord(badGateKey, { runNonce: nonce }), /PROBE_RESULT_INVALID/, 'the gate keys are exactly G1 through G4');
});

async function connectDirectProbeClient(runDirectory, runNonceValue, phase = 'reachability') {
  const server = createDirectProbeServer({ observer: { runDirectory, runNonce: runNonceValue, phase } });
  const client = new Client({ name: 'direct-probe-test', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

async function callCaptureDirect(client, probeLabel, meta) {
  const params = { name: 'capture_direct', arguments: { probeLabel } };
  if (meta !== undefined) params._meta = meta;
  return client.request({ method: 'tools/call', params }, CallToolResultSchema);
}

async function waitUntilDirectEventKind(runDirectory, runNonceValue, kind, deadlineMs = 10_000) {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const found = (await readDirectProbeEvents({ runDirectory, runNonce: runNonceValue })).find((record) => record.kind === kind);
    if (found) return found;
    if (Date.now() > deadline) throw new Error(`${kind} never became durable`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test('handler entry is durable before metadata inspection when _meta is absent', async () => {
  await withDirectProbeRun('zcode-direct-entry-', async (run) => {
    const nonce = directRunNonce();
    const { client } = await connectDirectProbeClient(run, nonce);
    const label = directLabel();
    const result = await callCaptureDirect(client, label);
    assert.equal(result.isError ?? false, false);
    assert.deepEqual(result.structuredContent, { entered: true, metadataState: 'missing' });
    const records = await readDirectProbeEvents({ runDirectory: run, runNonce: nonce });
    assert.deepEqual(records.map((record) => record.kind), ['handler-entered', 'metadata-observed'], 'entry is the first durable record, before metadata inspection');
    assert.equal(records[0].sequence, 0);
    assert.equal(records[0].probeLabel, label);
    assert.match(records[0].callNonce, /^[0-9a-f]{32}$/);
    assert.match(records[0].serverInstanceHash, /^[0-9a-f]{64}$/);
    assert.equal(records[1].sequence, 1);
    assert.equal(records[1].callNonce, records[0].callNonce, 'the handler joins its metadata observation to its own call nonce');
    assert.equal(records[1].state, 'missing');
    assert.deepEqual(records[1].fields, []);
    assert.deepEqual(records[1].candidateHashes, { envelopeThreadId: null, innerSessionId: null, innerThreadId: null, innerTurnId: null });
    await client.close();
  });
});

test('handler entry is durable before metadata inspection when _meta is an empty object', async () => {
  await withDirectProbeRun('zcode-direct-entry-', async (run) => {
    const nonce = directRunNonce();
    const { client } = await connectDirectProbeClient(run, nonce);
    const label = directLabel();
    const result = await callCaptureDirect(client, label, {});
    assert.equal(result.isError ?? false, false);
    assert.equal(result.structuredContent.metadataState, 'malformed', 'present but unusable metadata is malformed, never complete');
    const records = await readDirectProbeEvents({ runDirectory: run, runNonce: nonce });
    assert.deepEqual(records.map((record) => record.kind), ['handler-entered', 'metadata-observed']);
    assert.equal(records[0].kind, 'handler-entered', 'entry precedes metadata inspection');
    assert.equal(records[1].state, 'malformed');
    assert.deepEqual(records[1].fields, []);
    assert.deepEqual(records[1].candidateHashes, { envelopeThreadId: null, innerSessionId: null, innerThreadId: null, innerTurnId: null });
    await client.close();
  });
});

test('handler entry is durable before metadata inspection when _meta is malformed', async () => {
  await withDirectProbeRun('zcode-direct-entry-', async (run) => {
    const nonce = directRunNonce();
    const { client } = await connectDirectProbeClient(run, nonce);
    const label = directLabel();
    const malformed = { threadId: 42, 'x-codex-turn-metadata': 'not-an-object' };
    const result = await callCaptureDirect(client, label, malformed);
    assert.equal(result.isError ?? false, false, 'malformed metadata must not fail the call');
    assert.equal(result.structuredContent.metadataState, 'malformed');
    const records = await readDirectProbeEvents({ runDirectory: run, runNonce: nonce });
    assert.deepEqual(records.map((record) => record.kind), ['handler-entered', 'metadata-observed']);
    assert.equal(records[1].state, 'malformed');
    assert.deepEqual(records[1].fields, [['threadId', 'number'], ['x-codex-turn-metadata', 'string']], 'only bounded name/type pairs are recorded');
    assert.deepEqual(records[1].candidateHashes, { envelopeThreadId: null, innerSessionId: null, innerThreadId: null, innerTurnId: null });
    const rawLog = await readFile(join(run, 'events.jsonl'), 'utf8');
    assert.equal(rawLog.includes('not-an-object'), false, 'no raw metadata value enters the evidence');
    await client.close();
  });
});

test('handler entry is durable before metadata inspection and hashes a complete synthetic _meta without retaining raw values', async () => {
  await withDirectProbeRun('zcode-direct-entry-', async (run) => {
    // The fixed nonce lets one digest be pinned to an independently
    // precomputed literal (see DIRECT_FIXED_NONCE) instead of trusting the
    // implementation's own hash to agree with itself.
    const nonce = DIRECT_FIXED_NONCE;
    const { client } = await connectDirectProbeClient(run, nonce);
    const label = directLabel();
    const synthetic = {
      progressToken: 7,
      threadId: 'direct-probe-envelope-thread',
      'x-codex-turn-metadata': {
        session_id: 'direct-probe-session',
        thread_id: 'direct-probe-thread',
        turn_id: 'direct-probe-turn',
      },
    };
    const result = await callCaptureDirect(client, label, synthetic);
    assert.equal(result.isError ?? false, false);
    assert.equal(result.structuredContent.metadataState, 'complete');
    const records = await readDirectProbeEvents({ runDirectory: run, runNonce: nonce });
    assert.deepEqual(records.map((record) => record.kind), ['handler-entered', 'metadata-observed']);
    assert.equal(records[0].kind, 'handler-entered', 'entry precedes metadata inspection');
    assert.equal(records[1].state, 'complete');
    assert.deepEqual(records[1].fields, [
      ['[redacted]', 'number'],
      ['threadId', 'string'],
      ['x-codex-turn-metadata', 'object'],
      ['x-codex-turn-metadata.session_id', 'string'],
      ['x-codex-turn-metadata.thread_id', 'string'],
      ['x-codex-turn-metadata.turn_id', 'string'],
    ], 'unknown top-level names are redacted; allowlisted paths keep their names');
    // Independently precomputed (python3 hashlib):
    // sha256("{DIRECT_FIXED_NONCE}\0direct-probe-envelope-thread")
    assert.equal(
      records[1].candidateHashes.envelopeThreadId,
      'ea564ebe1c818984db0e88fb18b946482115faa8764e87e0898ebb84d57a88d7',
      'the salted digest matches a value precomputed by an independent tool',
    );
    assert.equal(records[1].candidateHashes.innerSessionId, await hashProbeValue(nonce, 'direct-probe-session'));
    assert.equal(records[1].candidateHashes.innerThreadId, await hashProbeValue(nonce, 'direct-probe-thread'));
    assert.equal(records[1].candidateHashes.innerTurnId, await hashProbeValue(nonce, 'direct-probe-turn'));
    const rawLog = await readFile(join(run, 'events.jsonl'), 'utf8');
    for (const raw of ['direct-probe-envelope-thread', 'direct-probe-session', 'direct-probe-thread', 'direct-probe-turn']) {
      assert.equal(rawLog.includes(raw), false, `raw identity leaked: ${raw}`);
    }
    await client.close();
  });
});

test('handler entry treats the probe label as diagnostic only and fails closed on a missing or repeated label', async () => {
  await withDirectProbeRun('zcode-direct-entry-', async (run) => {
    const nonce = directRunNonce();
    const { client } = await connectDirectProbeClient(run, nonce);
    const missingLabel = await client.request({ method: 'tools/call', params: { name: 'capture_direct', arguments: {} } }, CallToolResultSchema);
    assert.equal(missingLabel.isError, true, 'a missing probe label fails closed');
    const invalidLabel = await callCaptureDirect(client, 'not-a-diagnostic-label');
    assert.equal(invalidLabel.isError, true, 'a non-closed probe label fails closed');
    assert.equal((await readDirectProbeEvents({ runDirectory: run, runNonce: nonce })).length, 0, 'no durable evidence without a valid probe label');
    const label = directLabel();
    const first = await callCaptureDirect(client, label);
    assert.equal(first.isError ?? false, false);
    assert.deepEqual(Object.keys(first.structuredContent), ['entered', 'metadataState'], 'the fixed result never echoes the label');
    const repeated = await callCaptureDirect(client, label);
    assert.equal(repeated.isError, true, 'a repeated label fails closed');
    const records = await readDirectProbeEvents({ runDirectory: run, runNonce: nonce });
    assert.equal(records.filter((record) => record.kind === 'handler-entered').length, 1, 'exactly one entry per label');
    assert.equal(records.some((record) => record.probeLabel === 'not-a-diagnostic-label'), false);
    await client.close();
  });
});

test('handler entry precedes the synthetic worker hold and exact settlement for hold_direct', async () => {
  await withDirectProbeRun('zcode-direct-entry-', async (run) => {
    const nonce = directRunNonce();
    const { client, server } = await connectDirectProbeClient(run, nonce);
    const label = directLabel();
    const held = client.request({ method: 'tools/call', params: { name: 'hold_direct', arguments: { probeLabel: label } } }, CallToolResultSchema);
    const started = await waitUntilDirectEventKind(run, nonce, 'hold-started');
    assert.match(started.workerHash, /^[0-9a-f]{64}$/);
    assert.equal(started.callNonce, (await readDirectProbeEvents({ runDirectory: run, runNonce: nonce }))[0].callNonce, 'the hold joins the entry call nonce');
    let records = await readDirectProbeEvents({ runDirectory: run, runNonce: nonce });
    assert.deepEqual(records.map((record) => record.kind), ['handler-entered', 'hold-started'], 'entry precedes the synthetic worker hold');
    assert.equal(typeof server.probeDirectDisconnect?.settlePendingHoldsOnDisconnect, 'function', 'the server exposes the disconnect settlement seam');
    server.probeDirectDisconnect.settlePendingHoldsOnDisconnect();
    const holdResult = await held;
    assert.equal(holdResult.isError ?? false, false);
    await waitUntilDirectEventKind(run, nonce, 'worker-settled');
    records = await readDirectProbeEvents({ runDirectory: run, runNonce: nonce });
    assert.deepEqual(records.map((record) => record.kind), ['handler-entered', 'hold-started', 'handler-settled', 'worker-settled']);
    assert.equal(records[2].callNonce, records[0].callNonce);
    assert.equal(records[2].outcome, 'connection-closed');
    assert.equal(records[3].callNonce, records[0].callNonce);
    assert.equal(records[3].workerHash, started.workerHash, 'the settled worker is exactly the held synthetic worker');
    assert.equal(records[3].outcome, 'connection-closed');
    await client.close();
  });
});

const directServerModulePath = fileURLToPath(new URL('../tools/direct-mcp-probe/server.mjs', import.meta.url));
const posix = process.platform !== 'win32';

/**
 * The real executable over real stdio: connect, hold, then SIGKILL the
 * client process so the server sees only an abrupt stdin EOF — the path the
 * MCP SDK's transport never reports through transport onclose.
 */
function directStdioDisconnectHelper(serverModulePath, runDirectory, runNonceValue, probeLabel, pidFilePath, ownerSecret) {
  return `
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const observer = await import(pathToFileURL(${JSON.stringify(serverModulePath.replace(/server\.mjs$/, 'observer.mjs'))}).href);
const transport = new StdioClientTransport({
  command: ${JSON.stringify(process.execPath)},
  args: [${JSON.stringify(serverModulePath)}],
  env: {
    ...process.env,
    ZCODE_DIRECT_MCP_PROBE_RUN: ${JSON.stringify(runDirectory)},
    ZCODE_DIRECT_MCP_PROBE_NONCE: ${JSON.stringify(runNonceValue)},
    ZCODE_DIRECT_MCP_PROBE_PHASE: 'reachability',
    DIRECT_PROBE_OWNER_SECRET: ${JSON.stringify(ownerSecret)},
  },
});
const client = new Client({ name: 'direct-stdio-disconnect', version: '0.0.0' });
await client.connect(transport);
writeFileSync(${JSON.stringify(pidFilePath)}, JSON.stringify({ pid: transport.pid }));
await observer.appendDirectProbeEvent({ runDirectory: ${JSON.stringify(runDirectory)}, runNonce: ${JSON.stringify(runNonceValue)}, phase: 'reachability', event: { kind: 'request-sent', probeLabel: ${JSON.stringify(probeLabel)}, tool: 'hold_direct', state: 'sent' }, ownerSecret: ${JSON.stringify(ownerSecret)} });
client.request({ method: 'tools/call', params: { name: 'hold_direct', arguments: { probeLabel: ${JSON.stringify(probeLabel)} } } }, {}).catch(() => {});
await new Promise((resolve) => setTimeout(resolve, 800));
process.kill(process.pid, 'SIGKILL');
`;
}

test('handler entry settles durably when the stdio client dies abruptly', { skip: !posix }, async () => {
  await withDirectProbeRun('zcode-direct-stdio-', async (run) => {
    const nonce = directRunNonce();
    const label = directLabel();
    // The driver generates the per-run capability secret and passes it to the
    // server executable through spawn-time env; the secret stays in the
    // server's memory and never enters any file.
    const ownerSecret = randomBytes(32).toString('hex');
    const pidFilePath = join(run, 'server-pid.json');
    const helper = spawn(process.execPath, ['-e', directStdioDisconnectHelper(
      directServerModulePath, run, nonce, label, pidFilePath, ownerSecret,
    )], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    const helperErr = [];
    helper.stderr.on('data', (chunk) => helperErr.push(chunk));
    try {
      const settled = await waitUntilDirectEventKind(run, nonce, 'worker-settled', 15_000);
      assert.equal(settled.outcome, 'connection-closed', 'an abruptly disconnected client must still produce a durable worker settlement');
      const records = await readDirectProbeEvents({ runDirectory: run, runNonce: nonce });
      assert.deepEqual(records.map((record) => record.kind), [
        'server-started', 'request-sent', 'handler-entered', 'hold-started', 'handler-settled', 'worker-settled',
      ], 'driver dispatch, entry, and hold stay ordered before the durable settlements');
      assert.equal(records[4].outcome, 'connection-closed');
      assert.equal(records[5].workerHash, records[3].workerHash, 'the settled worker is exactly the held synthetic worker');
      // End-to-end: after the writers quiesce, the driver performs its final
      // append (capturing the in-memory final anchor) and reduces.
      const { pid: serverPid } = JSON.parse(await readFile(pidFilePath, 'utf8'));
      const final = await directDriverAppend(run, nonce, { kind: 'cleanup-observed', outcome: 'released', source: 'driver' }, 'reachability', ownerSecret);
      const reduced = await reduceDirectProbeLog({ runDirectory: run, runNonce: nonce, ownerSecret, ownerPid: serverPid, expectedFinalState: final.commit });
      assert.equal(reduced.calls.length, 1);
      assert.equal(reduced.calls[0].handlerSettled, 'connection-closed');
      assert.equal(reduced.calls[0].workerSettled, 'connection-closed');
      assert.equal(reduced.uncommittedCount, 0);
      // A driver without the spawn-time secret cannot reduce this run.
      await assert.rejects(
        () => reduceDirectProbeLog({ runDirectory: run, runNonce: nonce, ownerSecret: randomBytes(32).toString('hex'), ownerPid: serverPid, expectedFinalState: final.commit }),
        /PROBE_OWNER_INVALID/,
      );
    } catch (error) {
      console.error('DEBUG-HELPER-ERR:', Buffer.concat(helperErr).toString('utf8').slice(0, 400));
      console.error('DEBUG-STDIO journal:', await readFile(join(run, 'events-seal.jsonl'), 'utf8').catch(() => 'none'));
      console.error('DEBUG-STDIO events:', await readFile(join(run, 'events.jsonl'), 'utf8').catch(() => 'none'));
      throw error;
    } finally {
      helper.kill('SIGKILL');
    }
  });
});

test('direct evidence result record carries model, effort, and sanitized-configuration provenance', () => {
  const nonce = directRunNonce();
  const base = {
    version: 1,
    provenance: {
      runNonce: nonce,
      codexVersion: 'codex-cli 0.155.1',
      codexBinaryDigest: directHash('fixture-binary'),
      platform: 'darwin-arm64',
      sdkVersion: '1.30.0',
      sourceCommit: 'a'.repeat(40),
      schemaDigest: directHash('fixture-schema'),
      fixtureMode: 'reachability',
    },
    evidence: { digest: directHash('fixture-evidence'), count: 1 },
    gates: {
      G1: { status: 'not-proven', reasonCode: 'entry-unobserved', evidenceRefs: [] },
      G2: { status: 'not-proven', reasonCode: 'authority-unproven', evidenceRefs: [] },
      G3: { status: 'not-proven', reasonCode: 'lifecycle-unproven', evidenceRefs: [] },
      G4: { status: 'not-proven', reasonCode: 'entry-candidate-unproven', evidenceRefs: [] },
    },
  };
  // "Where applicable": model/effort and the sanitized-configuration digest
  // are optional closed provenance fields, present on real-host records.
  const complete = structuredClone(base);
  complete.provenance.model = 'gpt-5.1-codex-max';
  complete.provenance.effort = 'high';
  complete.provenance.configurationDigest = directHash('fixture-sanitized-config');
  validateDirectResultRecord(complete, { runNonce: nonce });
  // A fixture with no model turn carries none of them and still validates.
  validateDirectResultRecord(structuredClone(base), { runNonce: nonce });
  const emptyModel = structuredClone(complete);
  emptyModel.provenance.model = '';
  assert.throws(() => validateDirectResultRecord(emptyModel, { runNonce: nonce }), /PROBE_RESULT_INVALID/, 'model provenance must be bounded text when present');
  const badDigest = structuredClone(complete);
  badDigest.provenance.configurationDigest = 'raw-config-object';
  assert.throws(() => validateDirectResultRecord(badDigest, { runNonce: nonce }), /PROBE_RESULT_INVALID/, 'the sanitized configuration enters only as a digest');
});

test('direct evidence permits absent turn hashes only when no turn was observed', () => {
  const nonce = directRunNonce();
  const record = directRecordBuilder(nonce);
  const source = 'host';
  // No Host-issued ID exists to hash: the hashes are absent, not null.
  validateDirectEventRecord(record('turn-state-observed', { state: 'not-observed', source }), { runNonce: nonce });
  validateDirectEventRecord(record('turn-state-observed', { state: 'unknown', source }), { runNonce: nonce });
  const contradictory = record('turn-state-observed', { state: 'not-observed', source, threadHash: directHash('t'), turnHash: directHash('u') });
  assert.throws(() => validateDirectEventRecord(contradictory, { runNonce: nonce }), /PROBE_EVENT_INVALID/, 'an unobserved turn cannot carry hashed IDs');
  const missingWhenObserved = record('turn-state-observed', { state: 'active', source });
  assert.throws(() => validateDirectEventRecord(missingWhenObserved, { runNonce: nonce }), /PROBE_EVENT_INVALID/, 'an observed turn requires both host-issued hashes');
  validateDirectEventRecord(record('turn-state-observed', { state: 'active', source, threadHash: directHash('t'), turnHash: directHash('u') }), { runNonce: nonce });
  const halfHashed = record('turn-state-observed', { state: 'completed', source, threadHash: directHash('t') });
  assert.throws(() => validateDirectEventRecord(halfHashed, { runNonce: nonce }), /PROBE_EVENT_INVALID/, 'both host-issued hashes are required when a turn is observed');
  const nullHash = record('turn-state-observed', { state: 'active', source, threadHash: null, turnHash: null });
  assert.throws(() => validateDirectEventRecord(nullHash, { runNonce: nonce }), /PROBE_EVENT_INVALID/, 'absence is a missing key, never null');
});

test('direct evidence partitions handler and driver writer responsibilities', async () => {
  // Imported dynamically so the partition's absence is a per-test failure.
  const { DIRECT_DRIVER_EVENT_KINDS, DIRECT_HANDLER_EVENT_KINDS } = await import('../tools/direct-mcp-probe/observer.mjs');
  assert.ok(DIRECT_HANDLER_EVENT_KINDS, 'the handler-side writer partition must exist');
  assert.ok(DIRECT_DRIVER_EVENT_KINDS, 'the driver-side writer partition must exist');
  assert.ok(Object.isFrozen(DIRECT_HANDLER_EVENT_KINDS) && Object.isFrozen(DIRECT_DRIVER_EVENT_KINDS));
  const handlerKinds = [...DIRECT_HANDLER_EVENT_KINDS];
  const driverKinds = [...DIRECT_DRIVER_EVENT_KINDS];
  for (const kind of handlerKinds) assert.equal(driverKinds.includes(kind), false, `${kind} must belong to exactly one writer`);
  assert.deepEqual([...handlerKinds, ...driverKinds].sort(), [...DIRECT_EVENT_KINDS].sort(), 'the partitions cover the whole closed union');
  for (const kind of ['handler-entered', 'handler-settled', 'worker-settled']) {
    assert.ok(handlerKinds.includes(kind), `${kind} is written only by the disposable server's writer`);
  }
  for (const kind of ['request-sent', 'trigger-sent', 'rpc-observed', 'cleanup-observed']) {
    assert.ok(driverKinds.includes(kind), `${kind} is written only by the driver`);
  }
});

test('direct evidence appender enforces the writer partition at the append boundary', async () => {
  await withDirectProbeRun('zcode-direct-observer-', async (run) => {
    const nonce = directRunNonce();
    const label = directLabel();
    const callNonce = directCallNonce();
    const workerHash = directHash('fixture-worker');
    // Handler writes are obtained the way the real server obtains them:
    // through the server factory, as a per-instance capability. There is no
    // module-level handler appender to import.
    const server = createDirectProbeServer({ observer: { runDirectory: run, runNonce: nonce, phase: 'reachability' }, ownerSecret: DIRECT_DRIVER_SECRET });
    assert.equal(typeof server.probeDirectAppend, 'function', 'the handler writer is a per-instance server capability');
    const handlerAppend = (event) => server.probeDirectAppend(event);
    // The same public API the driver will use in later tasks: it must reject
    // every handler-side kind outright, including settlements, so driver-
    // originated settlement records can never enter the durable log.
    const driverAppend = (event) => appendDirectProbeEvent({ runDirectory: run, runNonce: nonce, phase: 'reachability', event, ownerSecret: DIRECT_DRIVER_SECRET });
    await driverAppend({ kind: 'request-sent', probeLabel: label, tool: 'hold_direct', state: 'sent' });
    // Both capability wrappers validate asynchronously, so rejections are
    // awaited here.
    await assert.rejects(
      () => driverAppend({ kind: 'handler-entered', probeLabel: label, callNonce, serverInstanceHash: directHash('fixture-instance') }),
      /PROBE_EVENT_FORBIDDEN/,
      'the driver writer rejects handler entry outright',
    );
    // Only the server instance's writer can lay down entry and hold, and it
    // rejects driver kinds in turn.
    await handlerAppend({ kind: 'handler-entered', probeLabel: label, callNonce, serverInstanceHash: directHash('fixture-instance') });
    assert.throws(
      () => handlerAppend({ kind: 'request-sent', probeLabel: directLabel(), tool: 'hold_direct', state: 'sent' }),
      /PROBE_EVENT_FORBIDDEN/,
      'the handler writer rejects driver kinds outright',
    );
    await handlerAppend({ kind: 'hold-started', callNonce, workerHash });
    // ADVERSARIAL: entry AND hold exist durably; the driver still cannot
    // record settlement through the public API.
    await assert.rejects(
      () => driverAppend({ kind: 'handler-settled', callNonce, outcome: 'completed' }),
      /PROBE_EVENT_FORBIDDEN/,
      'a driver record must never become durable handler settlement',
    );
    await assert.rejects(
      () => driverAppend({ kind: 'worker-settled', callNonce, workerHash, outcome: 'completed' }),
      /PROBE_EVENT_FORBIDDEN/,
      'a driver record must never become durable worker settlement',
    );
    await assert.rejects(
      () => driverAppend({ kind: 'metadata-observed', callNonce, fields: [], fieldsTruncated: false, candidateHashes: directCandidateHashes(), state: 'missing' }),
      /PROBE_EVENT_FORBIDDEN/,
      'the driver writer rejects handler metadata observations outright',
    );
    // The server's writer still enforces ordering prerequisites (async, at
    // the log level, after the synchronous partition check).
    await assert.rejects(
      () => handlerAppend({ kind: 'handler-settled', callNonce: directCallNonce(), outcome: 'completed' }),
      /PROBE_ORDER_INVALID/,
      'even the server writer cannot settle a call without a durable entry',
    );
    await handlerAppend({ kind: 'handler-settled', callNonce, outcome: 'completed' });
    await handlerAppend({ kind: 'worker-settled', callNonce, workerHash, outcome: 'completed' });
    const records = await readDirectProbeEvents({ runDirectory: run, runNonce: nonce });
    assert.deepEqual(records.map((record) => record.kind), [
      'request-sent', 'handler-entered', 'hold-started', 'handler-settled', 'worker-settled',
    ], 'only server-scoped settlements reached the durable log');
  });
});

test('direct evidence exposes only the driver-scoped appender plus read, reduce, and format APIs', async () => {
  const surface = Object.keys(await import('../tools/direct-mcp-probe/observer.mjs')).sort();
  assert.equal(surface.includes('appendHandlerProbeEvent'), false, 'no handler-writer export exists at module level');
  assert.deepEqual(
    surface.filter((name) => name.startsWith('append')),
    ['appendDirectProbeEvent'],
    'the only append API on the module surface is the driver-scoped one',
  );
  assert.deepEqual(surface, [
    'DIRECT_DRIVER_EVENT_KINDS',
    'DIRECT_EVENT_KINDS',
    'DIRECT_FIELD_TYPE_NAMES',
    'DIRECT_FIXTURE_MODES',
    'DIRECT_GATE_KEYS',
    'DIRECT_GATE_STATUSES',
    'DIRECT_HANDLER_EVENT_KINDS',
    'DIRECT_METADATA_FIELD_NAMES',
    'DIRECT_OPTIONAL_PROVENANCE_FIELDS',
    'DIRECT_PROBE_EVENTS_MAX_BYTES',
    'DIRECT_PROBE_LABEL_PATTERN',
    'DIRECT_PROBE_PHASES',
    'DIRECT_PROVENANCE_FIELDS',
    'DIRECT_RPC_CLASSIFICATIONS',
    'DIRECT_TURN_STATES',
    'appendDirectProbeEvent',
    'hashProbeValue',
    'readDirectProbeEvents',
    'reduceDirectProbeEvents',
    'reduceDirectProbeLog',
    'validateDirectEventRecord',
    'validateDirectResultRecord',
  ].sort(), 'the public surface is exactly the driver appender plus read/reduce/format APIs');
});

test('direct evidence reducer exposes settlement attribution sequences', async () => {
  await withDirectProbeRun('zcode-direct-observer-', async (run) => {
    const nonce = directRunNonce();
    const label = directLabel();
    const callNonce = directCallNonce();
    const workerHash = directHash('fixture-worker');
    const server = trackDirectProbeServer(run, createDirectProbeServer({ observer: { runDirectory: run, runNonce: nonce, phase: 'reachability' }, ownerSecret: DIRECT_DRIVER_SECRET }));
    await directDriverAppend(run, nonce, { kind: 'request-sent', probeLabel: label, tool: 'hold_direct', state: 'sent' });
    await server.probeDirectAppend({ kind: 'handler-entered', probeLabel: label, callNonce, serverInstanceHash: directHash('fixture-instance') });
    await server.probeDirectAppend({ kind: 'hold-started', callNonce, workerHash });
    await server.probeDirectAppend({ kind: 'handler-settled', callNonce, outcome: 'cancelled' });
    await server.probeDirectAppend({ kind: 'worker-settled', callNonce, workerHash, outcome: 'cancelled' });
    const reduced = await reduceDirectProbeLog({ runDirectory: run, runNonce: nonce, ownerSecret: DIRECT_DRIVER_SECRET, ownerPid: process.pid, expectedFinalState: directAnchors.get(run) });
    assert.equal(reduced.calls[0].handlerSettled, 'cancelled');
    assert.equal(reduced.calls[0].handlerSettledSequence, 3, 'every settlement fact names its exact record');
    assert.equal(reduced.calls[0].workerSettledSequence, 4);
    // An entered-but-unsettled call exposes no settlement attribution.
    const secondLabel = directLabel();
    const secondCall = directCallNonce();
    await directDriverAppend(run, nonce, { kind: 'request-sent', probeLabel: secondLabel, tool: 'hold_direct', state: 'sent' });
    await server.probeDirectAppend({ kind: 'handler-entered', probeLabel: secondLabel, callNonce: secondCall, serverInstanceHash: directHash('fixture-instance') });
    const unproven = await reduceDirectProbeLog({ runDirectory: run, runNonce: nonce, ownerSecret: DIRECT_DRIVER_SECRET, ownerPid: process.pid, expectedFinalState: directAnchors.get(run) });
    assert.equal(unproven.calls[1].handlerSettled, null);
    assert.equal(unproven.calls[1].handlerSettledSequence, null, 'an unproven settlement exposes no attribution');
  });
});

test('handler entry records a bounded truncation flag for oversized metadata fingerprints', async () => {
  await withDirectProbeRun('zcode-direct-entry-', async (run) => {
    const nonce = directRunNonce();
    const { client } = await connectDirectProbeClient(run, nonce);
    const label = directLabel();
    const oversized = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`field${index}`, index]));
    const result = await callCaptureDirect(client, label, oversized);
    assert.equal(result.isError ?? false, false);
    assert.equal(result.structuredContent.metadataState, 'malformed');
    const records = await readDirectProbeEvents({ runDirectory: run, runNonce: nonce });
    const metadata = records.find((record) => record.kind === 'metadata-observed');
    assert.equal(metadata.fieldsTruncated, true, 'a capped fingerprint must say so');
    assert.equal(metadata.fields.length, 32, 'the fingerprint stays bounded at 32 pairs');
    const smallLabel = directLabel();
    const small = await callCaptureDirect(client, smallLabel, { threadId: 'direct-probe-envelope-thread' });
    assert.equal(small.isError ?? false, false);
    const allRecords = await readDirectProbeEvents({ runDirectory: run, runNonce: nonce });
    const smallMetadata = allRecords.filter((record) => record.kind === 'metadata-observed').at(-1);
    assert.equal(smallMetadata.fieldsTruncated, false, 'a short fingerprint is explicitly not truncated');
    assert.equal(smallMetadata.fields.length, 1);
    await client.close();
  });
});

test('direct evidence requires the truncation flag on metadata observations', () => {
  const nonce = directRunNonce();
  const record = directRecordBuilder(nonce);
  const missingFlag = record('metadata-observed', {
    callNonce: directCallNonce(), fields: [], candidateHashes: directCandidateHashes(), state: 'missing',
  });
  assert.throws(() => validateDirectEventRecord(missingFlag, { runNonce: nonce }), /PROBE_EVENT_INVALID/, 'the truncation flag is part of the closed contract');
  const nonBooleanFlag = record('metadata-observed', {
    callNonce: directCallNonce(), fields: [], candidateHashes: directCandidateHashes(), state: 'missing', fieldsTruncated: 'no',
  });
  assert.throws(() => validateDirectEventRecord(nonBooleanFlag, { runNonce: nonce }), /PROBE_EVENT_INVALID/, 'the truncation flag is a closed boolean');
  validateDirectEventRecord(record('metadata-observed', {
    callNonce: directCallNonce(), fields: [], candidateHashes: directCandidateHashes(), state: 'missing', fieldsTruncated: false,
  }), { runNonce: nonce });
});

test('direct evidence reducer never proves handler entry from a mismatched label and nonce', async () => {
  await withDirectProbeRun('zcode-direct-observer-', async (run) => {
    const nonce = directRunNonce();
    const labelA = directLabel();
    const labelB = directLabel();
    const callA = directCallNonce();
    const server = trackDirectProbeServer(run, createDirectProbeServer({ observer: { runDirectory: run, runNonce: nonce, phase: 'reachability' }, ownerSecret: DIRECT_DRIVER_SECRET }));
    // A response dispatched under label B that carries call A's nonce: the
    // unique-label join forbids attributing it to A as proof of handler entry.
    await directDriverAppend(run, nonce, { kind: 'request-sent', probeLabel: labelA, tool: 'capture_direct', state: 'sent' });
    await directDriverAppend(run, nonce, { kind: 'request-sent', probeLabel: labelB, tool: 'capture_direct', state: 'sent' });
    await server.probeDirectAppend({ kind: 'handler-entered', probeLabel: labelA, callNonce: callA, serverInstanceHash: directHash('fixture-instance') });
    await directDriverAppend(run, nonce, { kind: 'rpc-observed', probeLabel: labelB, callNonce: callA, outcome: 'error-result' });
    const reduced = await reduceDirectProbeLog({ runDirectory: run, runNonce: nonce, ownerSecret: DIRECT_DRIVER_SECRET, ownerPid: process.pid, expectedFinalState: directAnchors.get(run) });
    assert.deepEqual(reduced.calls[0].rpc, [], 'call A must not gain a handler-entered classification from label B');
    assert.deepEqual(reduced.unjoined, [
      { probeLabel: labelB, phase: 'reachability', rpc: ['error-result-unknown-origin'] },
    ], 'the mismatch fails closed to unknown-origin');
  });
});

test('direct evidence restricts metadata fingerprints to closed field names and types', () => {
  const nonce = directRunNonce();
  const record = directRecordBuilder(nonce);
  const metadata = (fields) => record('metadata-observed', {
    callNonce: directCallNonce(), fields, fieldsTruncated: false, candidateHashes: directCandidateHashes(), state: 'complete',
  });
  assert.throws(
    () => validateDirectEventRecord(metadata([['authorization', 'string']]), { runNonce: nonce }),
    /PROBE_EVENT_INVALID/,
    'a raw sensitive key can never be validated into the evidence',
  );
  assert.throws(
    () => validateDirectEventRecord(metadata([['threadId', 'password']]), { runNonce: nonce }),
    /PROBE_EVENT_INVALID/,
    'pair types come from the closed JSON type vocabulary',
  );
  validateDirectEventRecord(metadata([
    ['threadId', 'string'],
    ['x-codex-turn-metadata.session_id', 'string'],
    ['[redacted]', 'number'],
  ]), { runNonce: nonce });
});

test('direct evidence reducer never joins handler entry or rpc attribution to an unsent request', async () => {
  await withDirectProbeRun('zcode-direct-observer-', async (run) => {
    const nonce = directRunNonce();
    const server = trackDirectProbeServer(run, createDirectProbeServer({ observer: { runDirectory: run, runNonce: nonce, phase: 'reachability' }, ownerSecret: DIRECT_DRIVER_SECRET }));
    // The driver recorded that it did NOT dispatch: whatever follows, this
    // label cannot support handler entry, so the whole join fails closed.
    const unsentLabel = directLabel();
    await directDriverAppend(run, nonce, { kind: 'request-sent', probeLabel: unsentLabel, tool: 'capture_direct', state: 'not-sent' });
    await server.probeDirectAppend({ kind: 'handler-entered', probeLabel: unsentLabel, callNonce: directCallNonce(), serverInstanceHash: directHash('fixture-instance') });
    await assert.rejects(
      () => reduceDirectProbeLog({ runDirectory: run, runNonce: nonce, ownerSecret: DIRECT_DRIVER_SECRET, ownerPid: process.pid, expectedFinalState: directAnchors.get(run) }),
      /PROBE_ORDER_INVALID/,
      'a not-sent request is a missing prerequisite for handler entry',
    );
    // And even without an entry, a not-sent label's rpc observation can never
    // be attributed as handler-entered; it stays unknown-origin and unjoined.
    await withDirectProbeRun('zcode-direct-observer-', async (run2) => {
      const rpcNonce = directRunNonce();
      const rpcLabel = directLabel();
      await directDriverAppend(run2, rpcNonce, { kind: 'request-sent', probeLabel: rpcLabel, tool: 'capture_direct', state: 'not-sent' });
      await directDriverAppend(run2, rpcNonce, { kind: 'rpc-observed', probeLabel: rpcLabel, outcome: 'error-result' });
      const reduced = await reduceDirectProbeLog({ runDirectory: run2, runNonce: rpcNonce, ownerSecret: DIRECT_DRIVER_SECRET, ownerPid: process.pid, expectedFinalState: directAnchors.get(run2) });
      assert.deepEqual(reduced.calls, [], 'no call exists without a durable entry');
      assert.deepEqual(reduced.unjoined, [
        { probeLabel: rpcLabel, phase: 'reachability', rpc: ['error-result-unknown-origin'] },
      ], 'a not-sent label stays unknown-origin');
    });
    // A dispatched request keeps joining as before (positive control).
    await withDirectProbeRun('zcode-direct-observer-', async (run3) => {
      const sentNonce = directRunNonce();
      const sentLabel = directLabel();
      const sentServer = trackDirectProbeServer(run3, createDirectProbeServer({ observer: { runDirectory: run3, runNonce: sentNonce, phase: 'reachability' }, ownerSecret: DIRECT_DRIVER_SECRET }));
      await directDriverAppend(run3, sentNonce, { kind: 'request-sent', probeLabel: sentLabel, tool: 'capture_direct', state: 'sent' });
      await sentServer.probeDirectAppend({ kind: 'handler-entered', probeLabel: sentLabel, callNonce: directCallNonce(), serverInstanceHash: directHash('fixture-instance') });
      const reduced = await reduceDirectProbeLog({ runDirectory: run3, runNonce: sentNonce, ownerSecret: DIRECT_DRIVER_SECRET, ownerPid: process.pid, expectedFinalState: directAnchors.get(run3) });
      assert.equal(reduced.calls.length, 1, 'a sent request still satisfies the entry join');
    });
  });
});

const directProbeModulePath = (name) => fileURLToPath(new URL(`../tools/direct-mcp-probe/${name}`, import.meta.url));

/**
 * The reviewer's forgery scenario, run in a SEPARATE process with no server:
 * a fresh run dir and run nonce, then the full forgery sequence — claim
 * ownership, append request-sent, handler-entered, metadata-observed,
 * handler-settled, worker-settled, rpc-observed, then reduce. The fixture
 * prints a JSON summary and exits zero ONLY if the forgery failed (no
 * handler-kind append landed and the reducer produced no handler-entered
 * classification).
 */
function directForgeryHelper(observerModulePath, probeLogModulePath) {
  return `
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes, createHash } from 'node:crypto';
const observer = await import(pathToFileURL(${JSON.stringify(observerModulePath)}).href);
const probeLog = await import(pathToFileURL(${JSON.stringify(probeLogModulePath)}).href);
const run = mkdtempSync(join(tmpdir(), 'zcode-direct-forge-'));
chmodSync(run, 0o700);
const runNonce = randomBytes(32).toString('hex');
const label = randomBytes(16).toString('hex');
const callNonce = randomBytes(16).toString('hex');
const summary = { claim: 'unattempted', attempts: [], forgedAppendsLanded: false, reduceDirectAttempt: null, ok: false };
// 1. Try to claim ownership through an importable API: it must not exist.
summary.claim = typeof probeLog.registerDirectProbeHandlerOwner === 'function' ? 'importable' : 'api-removed';
// 2. Fall back to writing the owner JSON directly with our own pid and our
// own capability secret's digest (the documented tamper-evident, not
// tamper-proof, limit of file-based provenance). The forger knows the
// documented digest function; the REAL driver's secret is the part it can
// never obtain.
const forgedSecret = 'f'.repeat(64);
const secretDigest = observer.hashProbeValue(runNonce, forgedSecret);
writeFileSync(join(run, 'handler-owner.json'), JSON.stringify({ version: 1, runNonce, pid: process.pid, secretDigest }) + '\\n', { mode: 0o600 });
const driverAppend = (event) => observer.appendDirectProbeEvent({ runDirectory: run, runNonce, phase: 'reachability', event, ownerSecret: forgedSecret });
const logAppend = (event) => probeLog.appendDirectProbeLogRecord({ runDirectory: run, runNonce, phase: 'reachability', event, ownerSecret: forgedSecret });
async function attempt(name, fn) {
  try { await fn(); summary.attempts.push({ name, result: 'appended' }); }
  catch (error) { summary.attempts.push({ name, result: 'rejected', code: error.code ?? 'unknown', message: String(error.message || error).slice(0, 200) }); }
}
await attempt('request-sent(driver)', () => driverAppend({ kind: 'request-sent', probeLabel: label, tool: 'capture_direct', state: 'sent' }));
const fakeHash = createHash('sha256').update('forged').digest('hex');
const candidateHashes = { envelopeThreadId: null, innerSessionId: null, innerThreadId: null, innerTurnId: null };
await attempt('handler-entered', () => logAppend({ kind: 'handler-entered', probeLabel: label, callNonce, serverInstanceHash: fakeHash }));
await attempt('metadata-observed', () => logAppend({ kind: 'metadata-observed', callNonce, fields: [], fieldsTruncated: false, candidateHashes, state: 'missing' }));
await attempt('hold-started', () => logAppend({ kind: 'hold-started', callNonce, workerHash: fakeHash }));
await attempt('handler-settled', () => logAppend({ kind: 'handler-settled', callNonce, outcome: 'completed' }));
await attempt('worker-settled', () => logAppend({ kind: 'worker-settled', callNonce, workerHash: fakeHash, outcome: 'completed' }));
await attempt('rpc-observed(driver)', () => driverAppend({ kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'error-result' }));
summary.forgedAppendsLanded = ['handler-entered', 'metadata-observed', 'hold-started', 'handler-settled', 'worker-settled'].every((name) => summary.attempts.find((entry) => entry.name === name)?.result === 'appended');
// 3. The reducer path a legitimate driver runs: verify-then-reduce with the
// DRIVER's expected capability secret and expected server pid. The forged
// owner file must fail this closed (PROBE_OWNER_INVALID) — the forgery is
// writable but never reducible as handler evidence.
try {
  summary.reduceDirectAttempt = await observer.reduceDirectProbeLog({ runDirectory: run, runNonce, ownerSecret: 'e'.repeat(64), ownerPid: 424242 });
} catch (error) {
  summary.reduceDirectAttempt = { threw: error.code ?? 'unknown' };
}
summary.ok = summary.claim === 'api-removed'
  && summary.forgedAppendsLanded === true
  && summary.reduceDirectAttempt !== null
  && typeof summary.reduceDirectAttempt === 'object'
  && summary.reduceDirectAttempt.threw === 'PROBE_OWNER_INVALID';
console.log(JSON.stringify(summary));
process.exit(summary.ok ? 0 : 1);
`;
}

test('direct evidence handler provenance cannot be forged from a separate driver process', { skip: !posix }, async () => {
  const helper = spawn(process.execPath, ['--input-type=module', '-e', directForgeryHelper(
    directProbeModulePath('observer.mjs'),
    directProbeModulePath('probe-log.mjs'),
  )], { stdio: ['ignore', 'pipe', 'pipe'] });
  const stdout = [];
  const stderr = [];
  helper.stdout.on('data', (chunk) => stdout.push(chunk));
  helper.stderr.on('data', (chunk) => stderr.push(chunk));
  const [code, signal] = await new Promise((resolve) => helper.once('close', (c, s) => resolve([c, s])));
  const diagnostics = `exit=${code} signal=${signal} stderr=${Buffer.concat(stderr).toString('utf8').slice(0, 1600)} stdout=${Buffer.concat(stdout).toString('utf8').slice(0, 600)}`;
  assert.equal(signal, null, `the forgery fixture must exit on its own: ${diagnostics}`);
  assert.equal(code, 0, `the forgery attempt must fail closed in a separate driver process: ${diagnostics}`);
  const summary = JSON.parse(Buffer.concat(stdout).toString('utf8').trim().split('\n').at(-1));
  assert.equal(summary.claim, 'api-removed', 'no importable API may claim handler ownership');
  assert.equal(summary.forgedAppendsLanded, true, 'file-level forged appends land: the documented tamper-evident, not tamper-proof, limit');
  assert.equal(summary.reduceDirectAttempt.threw, 'PROBE_OWNER_INVALID', 'the legitimate verify-then-reduce path must reject the forged run');
  assert.equal(summary.ok, true);
});

test('direct evidence record Macs bind handler records and break replay or tampering', async () => {
  await withDirectProbeRun('zcode-direct-observer-', async (run) => {
    const nonce = directRunNonce();
    const ownerSecret = 'b'.repeat(64);
    const server = trackDirectProbeServer(run, createDirectProbeServer({ observer: { runDirectory: run, runNonce: nonce, phase: 'reachability' }, ownerSecret }));
    const label = directLabel();
    const callNonce = directCallNonce();
    const logPath = join(run, 'events.jsonl');
    const reduce = () => reduceDirectProbeLog({ runDirectory: run, runNonce: nonce, ownerSecret, ownerPid: process.pid, expectedFinalState: directAnchors.get(run) });
    await appendDirectProbeEvent({ runDirectory: run, runNonce: nonce, phase: 'reachability', event: { kind: 'request-sent', probeLabel: label, tool: 'capture_direct', state: 'sent' }, ownerSecret });
    await server.probeDirectAppend({ kind: 'handler-entered', probeLabel: label, callNonce, serverInstanceHash: directHash('fixture-instance') });
    await server.probeDirectAppend({ kind: 'metadata-observed', callNonce, fields: [], fieldsTruncated: false, candidateHashes: directCandidateHashes(), state: 'missing' });
    await reduce();
    const records = (await readFile(logPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(records[0].recordMac, undefined, 'driver kinds carry no Mac');
    assert.match(records[1].recordMac, /^[0-9a-f]{64}$/, 'handler records carry a closed Mac');
    // Tamper one byte of a handler record's content: the Mac must break.
    const tampered = records.map((record) => ({ ...record }));
    tampered[1].serverInstanceHash = directHash('tampered');
    await writeFile(logPath, tampered.map((record) => JSON.stringify(record)).join('\n') + '\n', { mode: 0o600 });
    await assert.rejects(reduce, /PROBE_OWNER_INVALID/, 'tampering any field of a handler record invalidates its Mac');
    // Replay/resequence: re-emitting a handler record at a different
    // sequence keeps the log dense, but the sequence is inside the Mac — the
    // resequenced records fail their Macs.
    const resequenced = records.map((record) => ({ ...record }));
    resequenced[1].sequence = 2;
    resequenced[2].sequence = 1;
    await writeFile(logPath, resequenced.map((record) => JSON.stringify(record)).join('\n') + '\n', { mode: 0o600 });
    await assert.rejects(reduce, /PROBE_OWNER_INVALID/, 'replaying a record at a different sequence fails');
    // Restoring the authentic bytes reduces again.
    await writeFile(logPath, records.map((record) => JSON.stringify(record)).join('\n') + '\n', { mode: 0o600 });
    await reduce();
  });
});

test('direct evidence a swap attack cannot forge reducible handler evidence in a legitimate run', async () => {
  await withDirectProbeRun('zcode-direct-observer-', async (run) => {
    const nonce = directRunNonce();
    const writers = makeDirectProbeWriters(run, nonce);
    const label = directLabel();
    const callNonce = directCallNonce();
    const workerHash = directHash('fixture-worker');
    await writers.driverAppend({ kind: 'request-sent', probeLabel: label, tool: 'hold_direct', state: 'sent' });
    await writers.handlerAppend({ kind: 'handler-entered', probeLabel: label, callNonce, serverInstanceHash: directHash('fixture-instance') });
    await writers.handlerAppend({ kind: 'hold-started', callNonce, workerHash });
    await writers.handlerAppend({ kind: 'handler-settled', callNonce, outcome: 'cancelled' });
    await writers.handlerAppend({ kind: 'worker-settled', callNonce, workerHash, outcome: 'cancelled' });
    // FORGERY: a same-user process with run-directory access appends a raw,
    // schema-valid handler record directly to the file (no capability
    // secret, no journal commit). The design accepts that this is writable;
    // what it must never be is reducible as handler evidence.
    const forgedLabel = directLabel();
    const forgedCall = directCallNonce();
    await writeFile(
      join(run, 'events.jsonl'),
      JSON.stringify({ version: 1, runNonce: nonce, sequence: 5, phase: 'reachability', kind: 'handler-entered', probeLabel: forgedLabel, callNonce: forgedCall, serverInstanceHash: directHash('forged-instance') }) + '\n',
      { mode: 0o600, flag: 'a' },
    );
    const reduced = await writers.reduce();
    assert.equal(reduced.uncommittedCount, 1, 'the forged trailing record is reported uncommitted');
    assert.ok(reduced.calls.every((call) => call.probeLabel !== forgedLabel), 'the forged entry never attributes as a call');
    assert.equal(reduced.calls[0].handlerSettled, 'cancelled', 'the legitimate committed evidence still reduces');
  });
});

test('direct evidence reduction fails closed on seal truncation, deletion, or forgery', async () => {
  await withDirectProbeRun('zcode-direct-observer-', async (run) => {
    const nonce = directRunNonce();
    const ownerSecret = 'b'.repeat(64);
    const server = trackDirectProbeServer(run, createDirectProbeServer({ observer: { runDirectory: run, runNonce: nonce, phase: 'reachability' }, ownerSecret }));
    const label = directLabel();
    const callNonce = directCallNonce();
    const workerHash = directHash('fixture-worker');
    const logPath = join(run, 'events.jsonl');
    const sealPath = join(run, 'events-seal.jsonl');
    const driverAppend = (event) => appendDirectProbeEvent({ runDirectory: run, runNonce: nonce, phase: 'reachability', event, ownerSecret });
    const handlerAppend = (event) => server.probeDirectAppend(event);
    await driverAppend({ kind: 'request-sent', probeLabel: label, tool: 'hold_direct', state: 'sent' });
    await handlerAppend({ kind: 'handler-entered', probeLabel: label, callNonce, serverInstanceHash: directHash('fixture-instance') });
    await handlerAppend({ kind: 'hold-started', callNonce, workerHash });
    await driverAppend({ kind: 'trigger-sent', callNonce, outcome: 'turn-interrupt' });
    await driverAppend({ kind: 'trigger-observed', callNonce, outcome: 'acknowledged', source: 'host' });
    await handlerAppend({ kind: 'handler-settled', callNonce, outcome: 'cancelled' });
    await handlerAppend({ kind: 'worker-settled', callNonce, workerHash, outcome: 'cancelled' });
    const reduce = () => reduceDirectProbeLog({ runDirectory: run, runNonce: nonce, ownerSecret, ownerPid: process.pid, expectedFinalState: directAnchors.get(run) });
    await reduce();
    const authenticLog = await readFile(logPath, 'utf8');
    const authenticSeal = await readFile(sealPath, 'utf8');
    // Attack A: delete complete trailing lines (a settlement) while keeping
    // the log newline-terminated and dense-looking. The seal must catch it.
    const truncatedLines = authenticLog.trim().split('\n').slice(0, -1);
    await writeFile(logPath, truncatedLines.join('\n') + '\n', { mode: 0o600 });
    await assert.rejects(reduce, /PROBE_OWNER_INVALID/, 'a truncated settlement must fail reduction closed');
    await writeFile(logPath, authenticLog, { mode: 0o600 });
    await reduce();
    // Attack B: delete the seal entirely.
    await rm(sealPath);
    await assert.rejects(reduce, /PROBE_OWNER_INVALID/, 'a missing seal must fail reduction closed');
    await writeFile(sealPath, authenticSeal, { mode: 0o600 });
    await reduce();
    // Attack C: forge the journal head — correct shape and correct file
    // digest, but a Mac the forger cannot compute under the driver secret.
    const journalLines = authenticSeal.trim().split('\n');
    const forgedHead = JSON.parse(journalLines.at(-1));
    forgedHead.sealMac = 'd'.repeat(64);
    journalLines[journalLines.length - 1] = JSON.stringify(forgedHead);
    await writeFile(sealPath, journalLines.join('\n') + '\n', { mode: 0o600 });
    await assert.rejects(reduce, /PROBE_OWNER_INVALID/, 'a forged seal Mac must fail reduction closed');
    await writeFile(sealPath, authenticSeal, { mode: 0o600 });
    await reduce();
  });
});

test('direct evidence plain reducer rejects handler-bearing transcripts', () => {
  const nonce = directRunNonce();
  const record = directRecordBuilder(nonce);
  const label = directLabel();
  const callNonce = directCallNonce();
  const handlerBearing = [
    record('request-sent', { probeLabel: label, tool: 'capture_direct', state: 'sent' }),
    record('handler-entered', { probeLabel: label, callNonce, serverInstanceHash: directHash('fixture-instance') }),
  ];
  assert.throws(
    () => reduceDirectProbeEvents(handlerBearing, { runNonce: nonce }),
    (error) => error.code === 'PROBE_REDUCTION_UNAUTHENTICATED' && /reduceDirectProbeLog/.test(error.message),
    'the plain reducer must refuse handler-bearing transcripts and name the authenticated path',
  );
  // Driver-only sets stay on the plain reducer (fresh dense sequences).
  const driverRecord = directRecordBuilder(nonce);
  const driverOnly = [
    driverRecord('request-sent', { probeLabel: label, tool: 'capture_direct', state: 'sent' }),
    driverRecord('rpc-observed', { probeLabel: label, outcome: 'error-result' }),
  ];
  const reduced = reduceDirectProbeEvents(driverOnly, { runNonce: nonce });
  assert.equal(reduced.calls.length, 0);
  assert.equal(reduced.unjoined[0].rpc[0], 'error-result-unknown-origin');
});
test('handler entry redacts unknown metadata names so raw sensitive keys never reach evidence', async () => {
  await withDirectProbeRun('zcode-direct-entry-', async (run) => {
    const nonce = directRunNonce();
    const { client } = await connectDirectProbeClient(run, nonce);
    const label = directLabel();
    const sensitive = {
      authorization: 'Bearer raw-credential-value',
      '/Users/x/secret/path': 'raw-path-value',
      threadId: 'direct-probe-envelope-thread',
    };
    const result = await callCaptureDirect(client, label, sensitive);
    assert.equal(result.isError ?? false, false);
    assert.equal(result.structuredContent.metadataState, 'complete', 'the allowlisted candidate stays usable');
    const records = await readDirectProbeEvents({ runDirectory: run, runNonce: nonce });
    const metadata = records.find((record) => record.kind === 'metadata-observed');
    assert.deepEqual(metadata.fields, [
      ['[redacted]', 'string'],
      ['[redacted]', 'string'],
      ['threadId', 'string'],
    ], 'unknown names are recorded only as the closed redaction token');
    assert.equal(metadata.candidateHashes.envelopeThreadId, await hashProbeValue(nonce, 'direct-probe-envelope-thread'));
    const rawLog = await readFile(join(run, 'events.jsonl'), 'utf8');
    for (const raw of ['authorization', '/Users/x/secret/path', 'Bearer raw-credential-value', 'direct-probe-envelope-thread']) {
      assert.equal(rawLog.includes(raw), false, `raw sensitive text leaked: ${raw}`);
    }
    await client.close();
  });
});

test('handler entry keeps allowlisted metadata paths when unknown keys overflow the fingerprint', async () => {
  await withDirectProbeRun('zcode-direct-entry-', async (run) => {
    const nonce = directRunNonce();
    const { client } = await connectDirectProbeClient(run, nonce);
    const label = directLabel();
    const oversized = {
      threadId: 'direct-probe-envelope-thread',
      'x-codex-turn-metadata': {
        session_id: 'direct-probe-session',
        thread_id: 'direct-probe-thread',
        turn_id: 'direct-probe-turn',
      },
      ...Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`unknown${index}`, index])),
    };
    const result = await callCaptureDirect(client, label, oversized);
    assert.equal(result.isError ?? false, false);
    assert.equal(result.structuredContent.metadataState, 'complete', 'the identity candidates stay usable regardless of unknown-key volume');
    const records = await readDirectProbeEvents({ runDirectory: run, runNonce: nonce });
    const metadata = records.find((record) => record.kind === 'metadata-observed');
    const names = metadata.fields.map(([name]) => name);
    for (const required of [
      'threadId',
      'x-codex-turn-metadata',
      'x-codex-turn-metadata.session_id',
      'x-codex-turn-metadata.thread_id',
      'x-codex-turn-metadata.turn_id',
    ]) {
      assert.ok(names.includes(required), `observed allowlisted path ${required} is never dropped by truncation`);
    }
    assert.equal(metadata.fields.length, 32, 'the fingerprint stays bounded');
    for (const [name, type] of metadata.fields) {
      if (!name.startsWith('x-codex-turn-metadata') && name !== 'threadId') {
        assert.deepEqual([name, type], ['[redacted]', 'number'], 'remaining capacity is filled with redacted pairs only');
      }
    }
    assert.equal(metadata.fieldsTruncated, true, 'dropped redacted pairs are flagged');
    assert.equal(metadata.candidateHashes.innerTurnId, await hashProbeValue(nonce, 'direct-probe-turn'));
    await client.close();
  });
});

test('direct evidence binds handler writes to the registered handler-owner process', async () => {
  await withDirectProbeRun('zcode-direct-observer-', async (run) => {
    const nonce = directRunNonce();
    // Simulate a registration written by ANOTHER process (pid 1) holding ITS
    // OWN capability secret: the file format is the fixed contract between
    // server.mjs's private writer and probe-log.mjs's reader/verifier. There
    // is no importable API that claims ownership — a process either genuinely
    // starts a server (which writes this file with its own pid and secret
    // digest) or it does not.
    const foreignSecret = 'f'.repeat(64);
    const foreignOwner = `${JSON.stringify({ version: 1, runNonce: nonce, pid: 1, secretDigest: await hashProbeValue(nonce, foreignSecret) })}\n`;
    await writeFile(join(run, 'handler-owner.json'), foreignOwner, { mode: 0o600 });
    const ownerStats = await lstat(join(run, 'handler-owner.json'));
    assert.equal(ownerStats.mode & 0o777, 0o600, 'the registration stays private');
    // (a) EVERY importable append path refuses handler kinds in a non-owner
    // process: the observer driver appender (by partition) and the shared
    // log primitive (by capability secret and owner pid), even when the
    // forger presents the foreign file's own secret.
    const handlerEvent = { kind: 'handler-entered', probeLabel: directLabel(), callNonce: directCallNonce(), serverInstanceHash: directHash('fixture-instance') };
    await assert.rejects(
      () => appendDirectProbeEvent({ runDirectory: run, runNonce: nonce, phase: 'reachability', event: { ...handlerEvent } }),
      /PROBE_EVENT_FORBIDDEN/,
    );
    await assert.rejects(
      () => import('../tools/direct-mcp-probe/probe-log.mjs').then((logModule) => logModule.appendDirectProbeLogRecord({ runDirectory: run, runNonce: nonce, phase: 'reachability', event: { ...handlerEvent }, ownerSecret: foreignSecret })),
      /PROBE_EVENT_FORBIDDEN/,
      'the shared log primitive refuses handler kinds from a non-owner process even with the foreign secret',
    );
    await assert.rejects(
      () => import('../tools/direct-mcp-probe/probe-log.mjs').then((logModule) => logModule.appendDirectProbeLogRecord({ runDirectory: run, runNonce: nonce, phase: 'reachability', event: { ...handlerEvent } })),
      /PROBE_EVENT_FORBIDDEN/,
      'handler kinds without a presented capability secret fail closed',
    );
    // (b) driver kinds remain writable by the driver API in this process.
    await appendDirectProbeEvent({
      runDirectory: run, runNonce: nonce, phase: 'reachability', event: { kind: 'request-sent', probeLabel: directLabel(), tool: 'capture_direct', state: 'sent' }, ownerSecret: foreignSecret,
    });
    // A server factory running in this non-owner process cannot claim the
    // handler side either: first registration wins, conflicts fail loudly.
    assert.throws(
      () => createDirectProbeServer({ observer: { runDirectory: run, runNonce: nonce, phase: 'reachability' } }),
      /PROBE_OWNER_CONFLICT/,
      'a second, different process cannot claim the handler side',
    );
    // (d) transient: the registration is a private file inside the run
    // directory, carrying only version/runNonce/pid/secretDigest, removed
    // with the run.
    const owner = JSON.parse(await readFile(join(run, 'handler-owner.json'), 'utf8'));
    assert.deepEqual(Object.keys(owner).sort(), ['pid', 'runNonce', 'secretDigest', 'version']);
    assert.equal(owner.version, 1);
    assert.equal(owner.runNonce, nonce);
    assert.equal(owner.pid, 1);
  });
});

test('direct evidence normalizes the handler-owner registration through the server factory', async () => {
  await withDirectProbeRun('zcode-direct-observer-', async (run) => {
    const nonce = directRunNonce();
    const ownerSecret = 'a'.repeat(64);
    const server = trackDirectProbeServer(run, createDirectProbeServer({ observer: { runDirectory: run, runNonce: nonce, phase: 'reachability' }, ownerSecret }));
    assert.equal(typeof server.probeDirectAppend, 'function');
    assert.equal(server.probeDirectOwnerSecret, ownerSecret, 'the instance holds its capability secret');
    const owner = JSON.parse(await readFile(join(run, 'handler-owner.json'), 'utf8'));
    assert.deepEqual(Object.keys(owner).sort(), ['pid', 'runNonce', 'secretDigest', 'version']);
    assert.equal(owner.pid, process.pid, 'a genuinely started server registers its own process');
    assert.equal(owner.runNonce, nonce);
    assert.equal(owner.secretDigest, await hashProbeValue(nonce, ownerSecret), 'only the secret digest is written, never the secret');
    // Re-instantiating a server in the same process with the same capability
    // is idempotent.
    createDirectProbeServer({ observer: { runDirectory: run, runNonce: nonce, phase: 'reachability' }, ownerSecret });
  });
});

test('direct evidence reduction fails closed when the handler-owner capability does not match', async () => {
  await withDirectProbeRun('zcode-direct-observer-', async (run) => {
    const nonce = directRunNonce();
    const ownerSecret = 'b'.repeat(64);
    const server = trackDirectProbeServer(run, createDirectProbeServer({ observer: { runDirectory: run, runNonce: nonce, phase: 'reachability' }, ownerSecret }));
    const label = directLabel();
    await appendDirectProbeEvent({ runDirectory: run, runNonce: nonce, phase: 'reachability', event: { kind: 'request-sent', probeLabel: label, tool: 'capture_direct', state: 'sent' }, ownerSecret });
    await server.probeDirectAppend({ kind: 'handler-entered', probeLabel: label, callNonce: directCallNonce(), serverInstanceHash: directHash('fixture-instance') });
    // A legitimately holding driver (secret + expected server pid) reduces.
    const reduced = await reduceDirectProbeLog({ runDirectory: run, runNonce: nonce, ownerSecret, ownerPid: process.pid, expectedFinalState: directAnchors.get(run) });
    assert.equal(reduced.calls.length, 1);
    // A wrong capability fails the whole reduction closed.
    await assert.rejects(
      () => reduceDirectProbeLog({ runDirectory: run, runNonce: nonce, ownerSecret: 'c'.repeat(64), ownerPid: process.pid }),
      /PROBE_OWNER_INVALID/,
      'a wrong capability must never reduce handler evidence',
    );
    // A wrong expected server pid fails closed too.
    await assert.rejects(
      () => reduceDirectProbeLog({ runDirectory: run, runNonce: nonce, ownerSecret, ownerPid: process.pid + 1 }),
      /PROBE_OWNER_INVALID/,
      'a wrong expected server pid must never reduce handler evidence',
    );
    // Driver-only runs (no handler evidence) reduce without a capability.
    const driverOnly = reduceDirectProbeEvents([
      { version: 1, runNonce: nonce, sequence: 0, phase: 'identity', kind: 'request-sent', probeLabel: directLabel(), tool: 'capture_direct', state: 'sent' },
    ], { runNonce: nonce });
    assert.equal(driverOnly.calls.length, 0);
  });
});


// --- Round 9 redesign: append-only seal journal, commit protocol, driver
// --- anchor, single-snapshot reduction. Regressions written FIRST.

function makeDirectProbeWriters(run, nonce, ownerSecret = DIRECT_DRIVER_SECRET) {
  const server = trackDirectProbeServer(run, createDirectProbeServer({ observer: { runDirectory: run, runNonce: nonce, phase: 'reachability' }, ownerSecret }));
  let anchor = null;
  const track = (result) => { anchor = result.commit; return result; };
  return {
    server,
    ownerSecret,
    anchor: () => anchor,
    driverAppend: async (event) => track(await directDriverAppend(run, nonce, event)),
    handlerAppend: async (event) => track(await server.probeDirectAppend(event)),
    reduce: () => reduceDirectProbeLog({ runDirectory: run, runNonce: nonce, ownerSecret, ownerPid: process.pid, expectedFinalState: anchor }),
  };
}

test('direct evidence reduction fails closed when a saved log and journal pair is rolled back', async () => {
  await withDirectProbeRun('zcode-direct-observer-', async (run) => {
    const nonce = directRunNonce();
    const writers = makeDirectProbeWriters(run, nonce);
    const label = directLabel();
    const callNonce = directCallNonce();
    await writers.driverAppend({ kind: 'request-sent', probeLabel: label, tool: 'hold_direct', state: 'sent' });
    await writers.handlerAppend({ kind: 'handler-entered', probeLabel: label, callNonce, serverInstanceHash: directHash('fixture-instance') });
    await writers.reduce();
    // Save the intermediate (log, journal) pair.
    const savedLog = await readFile(join(run, 'events.jsonl'), 'utf8');
    const savedJournal = await readFile(join(run, 'events-seal.jsonl'), 'utf8');
    // Later committed evidence disappears if the pair is restored...
    await writers.driverAppend({ kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'error-result' });
    const afterGrowth = await reduceDirectProbeLog({ runDirectory: run, runNonce: nonce, ownerSecret: DIRECT_DRIVER_SECRET, ownerPid: process.pid, expectedFinalState: writers.anchor() });
    assert.deepEqual(afterGrowth.calls[0].rpc, ['error-result-handler-entered'], 'the later evidence is attributed while present');
    await writeFile(join(run, 'events.jsonl'), savedLog, { mode: 0o600 });
    await writeFile(join(run, 'events-seal.jsonl'), savedJournal, { mode: 0o600 });
    // ...unless the driver's in-memory final anchor rejects the rollback.
    await assert.rejects(
      () => reduceDirectProbeLog({ runDirectory: run, runNonce: nonce, ownerSecret: DIRECT_DRIVER_SECRET, ownerPid: process.pid, expectedFinalState: writers.anchor() }),
      /PROBE_OWNER_INVALID/,
      'a restored older (log, journal) pair must fail the final-state anchor',
    );
  });
});

test('direct evidence treats records beyond the committed journal prefix as uncommitted', async () => {
  await withDirectProbeRun('zcode-direct-observer-', async (run) => {
    const nonce = directRunNonce();
    const writers = makeDirectProbeWriters(run, nonce);
    const label = directLabel();
    const callNonce = directCallNonce();
    const workerHash = directHash('fixture-worker');
    await writers.driverAppend({ kind: 'request-sent', probeLabel: label, tool: 'hold_direct', state: 'sent' });
    await writers.handlerAppend({ kind: 'handler-entered', probeLabel: label, callNonce, serverInstanceHash: directHash('fixture-instance') });
    await writers.handlerAppend({ kind: 'hold-started', callNonce, workerHash });
    // Fault injection: the record bytes are durable but the journal line was
    // never written (kill between record fsync and journal fsync).
    const unsealed = { version: 1, runNonce: nonce, sequence: 3, phase: 'reachability', kind: 'handler-settled', callNonce, outcome: 'completed' };
    // A real crash leaves a fully formed record whose Mac the server computed
    // before writing: valid Mac, just never journaled.
    const unsealedMac = createHmac('sha256', Buffer.from(DIRECT_DRIVER_SECRET, 'utf8')).update(canonicalJson(unsealed)).digest('hex');
    await writeFile(
      join(run, 'events.jsonl'),
      JSON.stringify({ ...unsealed, recordMac: unsealedMac }) + '\n',
      { mode: 0o600, flag: 'a' },
    );
    const reduced = await writers.reduce();
    assert.equal(reduced.uncommittedCount, 1, 'the unsealed trailing record is reported, not silently dropped');
    assert.equal(reduced.calls[0].handlerSettled, null, 'an uncommitted record never attributes handler evidence');
    // Kill after the journal line: the same record now commits — the journal
    // line for it (count 4 over the current file bytes) is appended.
    const committedBytes = await readFile(join(run, 'events.jsonl'));
    const eventsDigest = createHash('sha256').update(committedBytes).digest('hex');
    const sealMac = createHmac('sha256', Buffer.from(DIRECT_DRIVER_SECRET, 'utf8')).update(JSON.stringify({ eventsDigest, recordCount: 4, runNonce: nonce })).digest('hex');
    await writeFile(
      join(run, 'events-seal.jsonl'),
      JSON.stringify({ version: 1, runNonce: nonce, recordCount: 4, eventsDigest, sealMac }) + '\n',
      { mode: 0o600, flag: 'a' },
    );
    // The writer that journaled line 4 knows its commit {4, eventsDigest}:
    // the reduction over that anchor fully commits the record.
    const fullyReduced = await reduceDirectProbeLog({ runDirectory: run, runNonce: nonce, ownerSecret: DIRECT_DRIVER_SECRET, ownerPid: process.pid, expectedFinalState: { recordCount: 4, eventsDigest } });
    assert.equal(fullyReduced.uncommittedCount, 0, 'a journaled record is committed');
    assert.equal(fullyReduced.calls[0].handlerSettled, 'completed');
  });
});

test('direct evidence reduction is a single snapshot: post-anchor records never reduce', async () => {
  await withDirectProbeRun('zcode-direct-observer-', async (run) => {
    const nonce = directRunNonce();
    const writers = makeDirectProbeWriters(run, nonce);
    const label = directLabel();
    await writers.driverAppend({ kind: 'request-sent', probeLabel: label, tool: 'capture_direct', state: 'sent' });
    await writers.handlerAppend({ kind: 'handler-entered', probeLabel: label, callNonce: directCallNonce(), serverInstanceHash: directHash('fixture-instance') });
    // A concurrent writer lands a record after the anchor: the reduction must
    // fail closed (the anchor no longer matches the journal head), and must
    // never return a reduction containing the post-anchor record.
    const concurrentLabel = directLabel();
    const callNonce = directCallNonce();
    await writeFile(
      join(run, 'events.jsonl'),
      JSON.stringify({ version: 1, runNonce: nonce, sequence: 2, phase: 'reachability', kind: 'rpc-observed', probeLabel: concurrentLabel, callNonce, outcome: 'error-result' }) + '\n',
      { mode: 0o600, flag: 'a' },
    );
    const postAnchor = await writers.reduce();
    assert.equal(postAnchor.uncommittedCount, 1, 'the post-anchor record is reported uncommitted');
    assert.equal(postAnchor.calls.length, 1, 'the committed call still reduces');
    assert.equal(postAnchor.calls[0].rpc.length, 0, 'the post-anchor record never attributes handler evidence');
    assert.equal(postAnchor.unjoined.length, 0, 'the post-anchor record is not consumed as unjoined evidence');
  });
});

test('direct evidence seal journal chain fails closed on deletion or duplication', async () => {
  await withDirectProbeRun('zcode-direct-observer-', async (run) => {
    const nonce = directRunNonce();
    const writers = makeDirectProbeWriters(run, nonce);
    const label = directLabel();
    const callNonce = directCallNonce();
    const workerHash = directHash('fixture-worker');
    await writers.driverAppend({ kind: 'request-sent', probeLabel: label, tool: 'hold_direct', state: 'sent' });
    await writers.handlerAppend({ kind: 'handler-entered', probeLabel: label, callNonce, serverInstanceHash: directHash('fixture-instance') });
    await writers.handlerAppend({ kind: 'hold-started', callNonce, workerHash });
    await writers.handlerAppend({ kind: 'handler-settled', callNonce, outcome: 'completed' });
    const journalPath = join(run, 'events-seal.jsonl');
    const authentic = await readFile(journalPath, 'utf8');
    // Delete an intermediate journal line.
    const lines = authentic.trim().split('\n');
    await writeFile(journalPath, [lines[0], lines[2]].join('\n') + '\n', { mode: 0o600 });
    await assert.rejects(writers.reduce, /PROBE_OWNER_INVALID/, 'a deleted intermediate journal line breaks the chain');
    // Duplicate a journal line.
    await writeFile(journalPath, [lines[0], lines[1], lines[1], lines[3]].join('\n') + '\n', { mode: 0o600 });
    await assert.rejects(writers.reduce, /PROBE_OWNER_INVALID/, 'a duplicated journal line breaks the chain');
    await writeFile(journalPath, authentic, { mode: 0o600 });
    await writers.reduce();
  });
});

test('direct evidence writers detect a rolled back log and journal pair before appending', async () => {
  await withDirectProbeRun('zcode-direct-observer-', async (run) => {
    const nonce = directRunNonce();
    const writers = makeDirectProbeWriters(run, nonce);
    const label = directLabel();
    const callNonce = directCallNonce();
    // Intermediate state: two committed records → save the (log, journal) pair.
    await writers.driverAppend({ kind: 'request-sent', probeLabel: label, tool: 'hold_direct', state: 'sent' });
    await writers.handlerAppend({ kind: 'handler-entered', probeLabel: label, callNonce, serverInstanceHash: directHash('fixture-instance') });
    const savedLog = await readFile(join(run, 'events.jsonl'), 'utf8');
    const savedJournal = await readFile(join(run, 'events-seal.jsonl'), 'utf8');
    // Later evidence: driver and server events beyond the saved state.
    await writers.driverAppend({ kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'error-result' });
    await writers.handlerAppend({ kind: 'handler-settled', callNonce, outcome: 'completed' });
    // Roll back to the saved pair.
    await writeFile(join(run, 'events.jsonl'), savedLog, { mode: 0o600 });
    await writeFile(join(run, 'events-seal.jsonl'), savedJournal, { mode: 0o600 });
    // The next driver append must REFUSE: the journal no longer chains from
    // the writer's held commit, so nothing may be written.
    await assert.rejects(
      () => writers.driverAppend({ kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'success-result' }),
      /PROBE_STATE_DIVERGED/,
      'an append over a rolled back journal must be refused',
    );
    // No new journal line was written by the refused append.
    const journalLines = (await readFile(join(run, 'events-seal.jsonl'), 'utf8')).trim().split('\n');
    assert.equal(journalLines.length, 2, 'the rolled back journal stays untouched');
    // The server writer refuses as well.
    await assert.rejects(
      () => writers.handlerAppend({ kind: 'handler-settled', callNonce, outcome: 'completed' }),
      /PROBE_STATE_DIVERGED/,
      'the server writer also refuses a diverged state',
    );
    // No laundering: reduction with the driver's true final anchor still
    // fails for the rolled back state.
    await assert.rejects(
      () => reduceDirectProbeLog({ runDirectory: run, runNonce: nonce, ownerSecret: DIRECT_DRIVER_SECRET, ownerPid: process.pid, expectedFinalState: writers.anchor() }),
      /PROBE_OWNER_INVALID/,
      'the rolled back state never reduces as the anchored run',
    );
  });
});

test('direct evidence recovers uncommitted records on the next append without breaking the chain', async () => {
  await withDirectProbeRun('zcode-direct-observer-', async (run) => {
    const nonce = directRunNonce();
    const writers = makeDirectProbeWriters(run, nonce);
    const label = directLabel();
    const callNonce = directCallNonce();
    await writers.driverAppend({ kind: 'request-sent', probeLabel: label, tool: 'hold_direct', state: 'sent' });
    await writers.handlerAppend({ kind: 'handler-entered', probeLabel: label, callNonce, serverInstanceHash: directHash('fixture-instance') });
    await writers.handlerAppend({ kind: 'hold-started', callNonce, workerHash: directHash('fixture-worker') });
    // Kill between record fsync and journal fsync: the record bytes are
    // durable (with the Mac the server computed before writing) but the
    // journal line never landed.
    const orphan = { version: 1, runNonce: nonce, sequence: 3, phase: 'reachability', kind: 'handler-settled', callNonce, outcome: 'completed' };
    const orphanMac = createHmac('sha256', Buffer.from(DIRECT_DRIVER_SECRET, 'utf8')).update(canonicalJson(orphan)).digest('hex');
    await writeFile(join(run, 'events.jsonl'), JSON.stringify({ ...orphan, recordMac: orphanMac }) + '\n', { mode: 0o600, flag: 'a' });
    // The next append recovers: the orphan moves to the sidecar, the journal
    // chain stays contiguous, and the new record continues densely.
    await writers.driverAppend({ kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'error-result' });
    const sidecarLines = (await readFile(join(run, 'events-uncommitted.jsonl'), 'utf8')).trim().split('\n');
    assert.equal(sidecarLines.length, 1, 'the sidecar preserves the uncommitted record');
    assert.equal(JSON.parse(sidecarLines[0]).kind, 'handler-settled');
    const reduced = await writers.reduce();
    assert.equal(reduced.uncommittedCount, 0, 'the resumed chain has no uncommitted records');
    assert.equal(reduced.calls.length, 1);
    assert.equal(reduced.calls[0].handlerSettled, null, 'the recovered record was never attributed as handler evidence');
    assert.equal(reduced.recovery.sidecarPresent, true, 'the recovery surface is visible in the reduction');
    assert.equal(reduced.recovery.sidecarRecords, 1);
  });
});

// --- Codex gate re-review round 5: DEBUG_DIRECT_PROBE stderr redaction is a
// --- class — every debug print in every probe process emits fixed codes and
// --- bounded counts only, never raw evidence content. Regressions FIRST.

test('direct evidence recovery debug prints counts only, never raw uncommitted line text', async () => {
  await withDirectProbeRun('zcode-direct-observer-', async (run) => {
    const nonce = directRunNonce();
    const writers = makeDirectProbeWriters(run, nonce);
    const label = directLabel();
    await writers.driverAppend({ kind: 'request-sent', probeLabel: label, tool: 'hold_direct', state: 'sent' });
    // A simulated crash left a torn, malformed line in the log whose raw
    // text carries sensitive values (a path-shaped string and a token).
    const sensitive = `SECRET-HOST-RAW sensitive-path=${run}/events.jsonl token=raw-host-value`;
    await writeFile(join(run, 'events.jsonl'), 'not-json-at-all ' + sensitive + '\n', { flag: 'a', mode: 0o600 });
    const previousDebug = process.env.DEBUG_DIRECT_PROBE;
    process.env.DEBUG_DIRECT_PROBE = '1';
    const debugLines = [];
    const originalConsoleError = console.error;
    console.error = (...args) => { debugLines.push(args.map((entry) => String(entry)).join(' ')); };
    try {
      // The next append recovers: the torn line moves to the sidecar.
      await writers.handlerAppend({ kind: 'handler-entered', probeLabel: directLabel(), callNonce: directCallNonce(), serverInstanceHash: directHash('fixture-instance') });
    } finally {
      console.error = originalConsoleError;
      if (previousDebug === undefined) delete process.env.DEBUG_DIRECT_PROBE;
      else process.env.DEBUG_DIRECT_PROBE = previousDebug;
    }
    const debugText = debugLines.join('\n');
    // The debug output may carry NO raw evidence content: not the sensitive
    // line fragment, not the outcome values, not any path.
    assert.equal(debugText.includes('SECRET-HOST-RAW'), false, 'raw uncommitted line text never reaches the recovery debug output');
    assert.equal(debugText.includes('not-json-at-all'), false, 'malformed line fragments never reach the recovery debug output');
    assert.equal(debugText.includes(run), false, 'no run path reaches the recovery debug output');
    assert.equal(debugText.includes('token=raw-host-value'), false, 'no raw token reaches the recovery debug output');
    // The redacted diagnostics still exist: fixed code plus bounded counts.
    assert.equal(debugText.includes('DEBUG-REC36'), true, 'the recovery debug line is present under the flag');
    assert.equal(debugText.includes('malformed=1'), true, 'the malformed count is printed');
    assert.equal(debugText.includes('uncommitted=1'), true, 'the uncommitted count is printed');
    // The raw bytes themselves were preserved AS EVIDENCE in the private
    // sidecar — the redaction governs stderr, never the durable corpus.
    const sidecar = await readFile(join(run, 'events-uncommitted.jsonl'), 'utf8');
    assert.ok(sidecar.includes('SECRET-HOST-RAW'), 'the sidecar preserves the torn raw bytes as durable evidence');
  });
});

test('the server debug diagnostics print closed codes only, never raw stacks or paths', async () => {
  await withDirectProbeRun('zcode-direct-server-debug-', async (run) => {
    const nonce = directRunNonce();
    const { client } = await connectDirectProbeClient(run, nonce);
    // A first successful call creates the run files; then every run FILE
    // loses access, so the next handler-entered append fails with EACCES
    // naming `run/events.jsonl`. With DEBUG_DIRECT_PROBE set, the
    // tool-error diagnostic must print ONLY the closed error code — no raw
    // stack, error string, or path (stderr is commonly retained).
    const warmup = await callCaptureDirect(client, directLabel());
    assert.equal(warmup.isError, undefined, 'the warmup call succeeds');
    for (const entry of fs.readdirSync(run)) {
      const entryPath = join(run, entry);
      if (fs.statSync(entryPath).isFile()) fs.chmodSync(entryPath, 0o000);
    }
    const previousDebug = process.env.DEBUG_DIRECT_PROBE;
    process.env.DEBUG_DIRECT_PROBE = '1';
    const debugLines = [];
    const originalConsoleError = console.error;
    console.error = (...args) => { debugLines.push(args.map((entry) => String(entry)).join(' ')); };
    try {
      const result = await callCaptureDirect(client, directLabel());
      assert.equal(result.isError, true, 'the failing append surfaces as a tool error');
    } finally {
      console.error = originalConsoleError;
      if (previousDebug === undefined) delete process.env.DEBUG_DIRECT_PROBE;
      else process.env.DEBUG_DIRECT_PROBE = previousDebug;
      for (const entry of fs.readdirSync(run)) {
        const entryPath = join(run, entry);
        if (fs.statSync(entryPath).isFile()) fs.chmodSync(entryPath, 0o600);
      }
    }
    const debugText = debugLines.join('\n');
    assert.equal(debugText.includes(run), false, 'no run path reaches the tool-error diagnostic');
    assert.equal(debugText.includes('EACCES'), false, 'no raw filesystem error text reaches the diagnostic');
    assert.equal(debugText.includes('permission denied'), false, 'no raw errno message reaches the diagnostic');
    assert.equal(/\bat \b/.test(debugText), false, 'no raw stack frames reach the diagnostic');
    assert.ok(debugLines.some((entry) => /^DEBUG-TOOL-ERR \S+$/.test(entry)), 'the diagnostic carries exactly one closed error token');
    await client.close();
  });
});

test('direct evidence a new server instance cannot rebase onto a rolled back head', async () => {
  await withDirectProbeRun('zcode-direct-observer-', async (run) => {
    const nonce = directRunNonce();
    const ownerSecret = DIRECT_DRIVER_SECRET;
    const writers = makeDirectProbeWriters(run, nonce, ownerSecret);
    const label = directLabel();
    const callNonce = directCallNonce();
    const workerHash = directHash('fixture-worker');
    // Driver era: one committed record → save the (log, journal) pair.
    await writers.driverAppend({ kind: 'request-sent', probeLabel: label, tool: 'hold_direct', state: 'sent' });
    const savedLog = await readFile(join(run, 'events.jsonl'), 'utf8');
    const savedJournal = await readFile(join(run, 'events-seal.jsonl'), 'utf8');
    // Server era: the instance appends handler records → head count 5.
    await writers.handlerAppend({ kind: 'handler-entered', probeLabel: label, callNonce, serverInstanceHash: directHash('fixture-instance') });
    await writers.handlerAppend({ kind: 'hold-started', callNonce, workerHash });
    await writers.handlerAppend({ kind: 'handler-settled', callNonce, outcome: 'completed' });
    await writers.handlerAppend({ kind: 'worker-settled', callNonce, workerHash, outcome: 'completed' });
    // Roll back to the driver-era pair (deleting the handler-era records).
    await writeFile(join(run, 'events.jsonl'), savedLog, { mode: 0o600 });
    await writeFile(join(run, 'events-seal.jsonl'), savedJournal, { mode: 0o600 });
    // A NEW factory instance in the same process must refuse creation: the
    // current seal head (count 1) does not extend the process-held commit.
    assert.throws(
      () => createDirectProbeServer({ observer: { runDirectory: run, runNonce: nonce, phase: 'reachability' }, ownerSecret }),
      /PROBE_STATE_DIVERGED/,
      'a new instance cannot rebase onto a rolled back head',
    );
    // The process-held state is unchanged by the refused creation.
    const journalLines = (await readFile(join(run, 'events-seal.jsonl'), 'utf8')).trim().split('\n');
    assert.equal(journalLines.length, 1, 'no journal line was written for the rolled back state');
    // The driver's true-anchor reduction still fails (no laundering).
    await assert.rejects(
      () => reduceDirectProbeLog({ runDirectory: run, runNonce: nonce, ownerSecret: DIRECT_DRIVER_SECRET, ownerPid: process.pid, expectedFinalState: writers.anchor() }),
      /PROBE_OWNER_INVALID/,
      'no laundering: the rolled back state never reduces as the anchored run',
    );
  });
});

// --- Codex gate round 10: per-record Mac binding and anchored reduction. ---

test('direct evidence reduction fails closed when a committed handler record is tampered after the fact', async () => {
  await withDirectProbeRun('zcode-direct-observer-', async (run) => {
    const nonce = directRunNonce();
    const writers = makeDirectProbeWriters(run, nonce);
    const label = directLabel();
    const callNonce = directCallNonce();
    await writers.driverAppend({ kind: 'request-sent', probeLabel: label, tool: 'hold_direct', state: 'sent' });
    await writers.handlerAppend({ kind: 'handler-entered', probeLabel: label, callNonce, serverInstanceHash: directHash('fixture-instance') });
    await writers.handlerAppend({ kind: 'metadata-observed', callNonce, fields: [], fieldsTruncated: false, candidateHashes: directCandidateHashes(), state: 'missing' });
    // Tamper a committed record's outcome in place, keeping the Mac untouched.
    const tampered = { version: 1, runNonce: nonce, sequence: 2, phase: 'reachability', kind: 'metadata-observed', callNonce, fields: [['threadId', 'string']], fieldsTruncated: false, candidateHashes: directCandidateHashes(), state: 'complete' };
    const eventsPath = join(run, 'events.jsonl');
    const lines = (await readFile(eventsPath, 'utf8')).trim().split('\n');
    lines[2] = JSON.stringify(tampered);
    await writeFile(eventsPath, lines.join('\n') + '\n', { mode: 0o600 });
    await assert.rejects(
      () => reduceDirectProbeLog({ runDirectory: run, runNonce: nonce, ownerSecret: DIRECT_DRIVER_SECRET, ownerPid: process.pid, expectedFinalState: writers.anchor() }),
      /PROBE_OWNER_INVALID/,
      'a tampered committed handler record must fail the anchored reduction closed',
    );
  });
});

// --- Codex gate: the recovery sidecar is durable before truncation and its
// --- digest is recorded in the recovery commit line. Regressions written
// --- FIRST: recovery evidence must survive the truncation window and a
// --- same-user deletion of the sidecar must fail reduction closed.

/** Builds a run with three committed records and one durable uncommitted record. */
async function withDirectProbeRecoveryFixture(run, nonce, writers) {
  const label = directLabel();
  const callNonce = directCallNonce();
  const workerHash = directHash('fixture-worker');
  await writers.driverAppend({ kind: 'request-sent', probeLabel: label, tool: 'hold_direct', state: 'sent' });
  await writers.handlerAppend({ kind: 'handler-entered', probeLabel: label, callNonce, serverInstanceHash: directHash('fixture-instance') });
  await writers.handlerAppend({ kind: 'hold-started', callNonce, workerHash });
  // Fault injection (as in the round 9 recovery regression): the record bytes
  // are durable but the journal line never landed.
  const orphan = { version: 1, runNonce: nonce, sequence: 3, phase: 'reachability', kind: 'handler-settled', callNonce, outcome: 'completed' };
  const orphanMac = createHmac('sha256', Buffer.from(DIRECT_DRIVER_SECRET, 'utf8')).update(canonicalJson(orphan)).digest('hex');
  await writeFile(join(run, 'events.jsonl'), JSON.stringify({ ...orphan, recordMac: orphanMac }) + '\n', { mode: 0o600, flag: 'a' });
  return { label, callNonce };
}

test('direct evidence records a recovery in the commit line so a deleted or altered sidecar fails closed', async () => {
  await withDirectProbeRun('zcode-direct-observer-', async (run) => {
    const nonce = directRunNonce();
    const writers = makeDirectProbeWriters(run, nonce);
    const { label, callNonce } = await withDirectProbeRecoveryFixture(run, nonce, writers);
    // The recovering append's commit line must RECORD the recovery.
    await writers.driverAppend({ kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'error-result' });
    const sidecarPath = join(run, 'events-uncommitted.jsonl');
    const sidecarBytes = await readFile(sidecarPath);
    const journalLines = (await readFile(join(run, 'events-seal.jsonl'), 'utf8')).trim().split('\n');
    const recoveryCommit = JSON.parse(journalLines.at(-1));
    assert.equal(recoveryCommit.recoveredCount, 1, 'the recovery commit records the recovered record count');
    assert.equal(recoveryCommit.recoveredDigest, createHash('sha256').update(sidecarBytes).digest('hex'), 'the recovery commit records the sidecar digest the reader verifies');
    // With the sidecar intact the reduction succeeds: the recovery line
    // authenticates and the driver anchor holds.
    const reduced = await writers.reduce();
    assert.equal(reduced.recovery.sidecarPresent, true, 'the sidecar stays part of the reduction surface');
    // Deleting the sidecar erases the only copy of the recovered records:
    // the recorded digest can no longer be verified.
    await rm(sidecarPath);
    await assert.rejects(writers.reduce, /PROBE_OWNER_INVALID/, 'a deleted recovery sidecar must fail the reduction closed');
    // Altering one sidecar byte fails the same way.
    await writeFile(sidecarPath, sidecarBytes, { mode: 0o600 });
    const tampered = Buffer.from(sidecarBytes);
    tampered[0] = tampered[0] === 0x7b ? 0x7c : 0x7b;
    await writeFile(sidecarPath, tampered, { mode: 0o600 });
    await assert.rejects(writers.reduce, /PROBE_OWNER_INVALID/, 'an altered recovery sidecar must fail the reduction closed');
    // Restored bytes reduce again (no lingering taint from the tamper).
    await writeFile(sidecarPath, sidecarBytes, { mode: 0o600 });
    await writers.reduce();
  });
});

test('direct evidence truncates the event log only after the recovery sidecar is durable', async () => {
  await withDirectProbeRun('zcode-direct-observer-', async (run) => {
    const nonce = directRunNonce();
    const writers = makeDirectProbeWriters(run, nonce);
    const { label, callNonce } = await withDirectProbeRecoveryFixture(run, nonce, writers);
    const eventsPath = join(run, 'events.jsonl');
    const sidecarPath = join(run, 'events-uncommitted.jsonl');
    const journalPath = join(run, 'events-seal.jsonl');
    const logBeforeCrash = await readFile(eventsPath, 'utf8');
    const journalBeforeCrash = await readFile(journalPath, 'utf8');
    // Fault injection: crash the recovering append at its FIRST fsync — the
    // durable recovery intent's own write. Round 36 ordering: the intent
    // binds the exact sidecar bytes BEFORE the sidecar exists and BEFORE the
    // truncation erases the recovered records from the log, so a crash at
    // the very first fsync leaves the run untouched and fully resumable.
    const probeHandle = await open(eventsPath, 'r');
    const fileHandlePrototype = Object.getPrototypeOf(probeHandle);
    await probeHandle.close();
    const originalSync = fileHandlePrototype.sync;
    fileHandlePrototype.sync = function crashAtSidecarDurabilityStep() {
      throw new Error('PROBE_TEST_CRASH: injected crash at the first fsync of the recovering append');
    };
    try {
      await assert.rejects(
        () => writers.driverAppend({ kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'error-result' }),
        /PROBE_TEST_CRASH/,
        'the simulated crash interrupts the recovering append',
      );
    } finally { fileHandlePrototype.sync = originalSync; }
    // Nothing was written behind the crash: the events (with the recovered
    // records) and the journal survive untouched, and no sidecar exists yet.
    assert.equal(await readFile(eventsPath, 'utf8'), logBeforeCrash, 'the event log was not truncated behind the crash');
    assert.equal(await readFile(journalPath, 'utf8'), journalBeforeCrash, 'no journal line was committed');
    await assert.rejects(() => readFile(sidecarPath, 'utf8'), (error) => error.code === 'ENOENT', 'no sidecar was written behind the crash');
    // The retry recomputes the sidecar bytes from the event source, verifies
    // them against the durable intent, writes them, truncates, and commits —
    // the recovered evidence is never lost.
    await writers.driverAppend({ kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'error-result' });
    assert.match(await readFile(sidecarPath, 'utf8'), /handler-settled/, 'the sidecar preserved the recovered record');
    const reduced = await writers.reduce();
    assert.equal(reduced.uncommittedCount, 0, 'the run reduces cleanly after the retry');
    assert.equal(reduced.recovery.sidecarRecords, 1, 'the recovered record stays visible in the reduction');
  });
});

// --- Codex gate round 13: recovery intent, factory chain adoption, and
// --- cumulative sidecar prefix binding. Regressions written FIRST.

test('direct evidence resolves a recovery intent left by a crash between truncation and the recovery commit', async () => {
  await withDirectProbeRun('zcode-direct-observer-', async (run) => {
    const nonce = directRunNonce();
    const writers = makeDirectProbeWriters(run, nonce);
    const { label, callNonce } = await withDirectProbeRecoveryFixture(run, nonce, writers);
    const eventsPath = join(run, 'events.jsonl');
    const sidecarPath = join(run, 'events-uncommitted.jsonl');
    const journalPath = join(run, 'events-seal.jsonl');
    const committedLog = (await readFile(eventsPath, 'utf8')).trim().split('\n').slice(0, 3).join('\n') + '\n';
    // Fault injection: crash at the record handle's first stat — the first
    // prototype contact after the truncation — so the recovering append has
    // truncated the log and durably recorded a recovery intent, but the
    // record and its recovery commit never landed.
    const probeHandle = await open(eventsPath, 'r');
    const fileHandlePrototype = Object.getPrototypeOf(probeHandle);
    await probeHandle.close();
    const originalStat = fileHandlePrototype.stat;
    let plainStats = 0;
    fileHandlePrototype.stat = function crashBetweenTruncationAndCommit(...args) {
      // Only the unadorned stats count: the lock file is stat'ed with
      // {bigint:true}; the event log reads and the record handle use stat().
      if (args.length === 0) plainStats += 1;
      if (plainStats === 2) throw new Error('PROBE_TEST_CRASH: crash between truncation and the recovery commit');
      return originalStat.apply(this, args);
    };
    try {
      await assert.rejects(
        () => writers.driverAppend({ kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'error-result' }),
        /PROBE_TEST_CRASH/,
        'the simulated crash interrupted the recovering append',
      );
    } finally { fileHandlePrototype.stat = originalStat; }
    // The exact reviewer case: the log was truncated, the intent is present,
    // and no commit landed.
    const truncatedLog = await readFile(eventsPath, 'utf8');
    assert.equal(truncatedLog, committedLog, 'the log was truncated to the committed prefix');
    assert.doesNotMatch(truncatedLog, /handler-settled/, 'the orphan left the log');
    assert.equal((await readFile(journalPath, 'utf8')).trim().split('\n').length, 3, 'no commit landed');
    const sidecarBytes = await readFile(sidecarPath);
    const intentPath = join(run, 'recovery-intent.json');
    const intent = JSON.parse(await readFile(intentPath, 'utf8'));
    assert.equal(intent.version, 1);
    assert.equal(intent.runNonce, nonce);
    assert.equal(intent.recoveredCount, 1, 'the intent records the recovered count');
    assert.equal(intent.recoveredLength, sidecarBytes.length, 'the intent records the cumulative sidecar length');
    assert.equal(intent.recoveredDigest, createHash('sha256').update(sidecarBytes).digest('hex'), 'the intent records the sidecar digest');
    assert.match(intent.intentMac, /^[0-9a-f]{64}$/, 'the intent is authenticated');
    // Reduction with an unresolved intent fails closed — even though the
    // journal head still matches the driver anchor.
    await assert.rejects(writers.reduce, /PROBE_OWNER_INVALID/, 'an unresolved recovery intent must fail the reduction closed');
    // Deleting the sidecar while the intent is unresolved fails closed.
    await rm(sidecarPath);
    await assert.rejects(writers.reduce, /PROBE_OWNER_INVALID/, 'a deleted sidecar under an unresolved intent must fail the reduction closed');
    await writeFile(sidecarPath, sidecarBytes, { mode: 0o600 });
    // The next append RESOLVES the intent: its commit line carries the
    // intent's recovery fields, anchoring the sidecar.
    await writers.driverAppend({ kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'error-result' });
    const intentGone = await readFile(intentPath, 'utf8').then(() => false, (error) => error.code === 'ENOENT');
    assert.ok(intentGone, 'the resolved intent was removed after its commit landed');
    const resolvingCommit = JSON.parse((await readFile(journalPath, 'utf8')).trim().split('\n')[3]);
    assert.equal(resolvingCommit.recoveredCount, intent.recoveredCount, 'the resolving commit carries the intent recovered count');
    assert.equal(resolvingCommit.recoveredDigest, intent.recoveredDigest, 'the resolving commit carries the intent sidecar digest');
    assert.equal(resolvingCommit.recoveredLength, intent.recoveredLength, 'the resolving commit carries the intent sidecar length');
    // The sidecar is anchored now: deleting it fails the reduction closed.
    await rm(sidecarPath);
    await assert.rejects(writers.reduce, /PROBE_OWNER_INVALID/, 'a deleted sidecar after the recovery commit must fail the reduction closed');
    await writeFile(sidecarPath, sidecarBytes, { mode: 0o600 });
    await writers.reduce();
  });
});

test('direct evidence re-executes a recovery under an unresolved intent when uncommitted records remain', async () => {
  await withDirectProbeRun('zcode-direct-observer-', async (run) => {
    const nonce = directRunNonce();
    const writers = makeDirectProbeWriters(run, nonce);
    const { label, callNonce } = await withDirectProbeRecoveryFixture(run, nonce, writers);
    const eventsPath = join(run, 'events.jsonl');
    const sidecarPath = join(run, 'events-uncommitted.jsonl');
    const journalPath = join(run, 'events-seal.jsonl');
    // Fault injection: crash at the SIXTH fsync — the recovery intent temp
    // and directory writes, the sidecar's atomic write and its directory
    // entry (round 36 ordering), the recovering truncation's descriptor
    // fsync (round 47), then the record's own — so the sidecar, the intent,
    // and the directory entries are durable and the log is truncated, but
    // the new record was written without its commit. The intent stays
    // unresolved and a torn record remains in the log.
    const probeHandle = await open(eventsPath, 'r');
    const fileHandlePrototype = Object.getPrototypeOf(probeHandle);
    await probeHandle.close();
    const originalSync = fileHandlePrototype.sync;
    let syncCalls = 0;
    fileHandlePrototype.sync = function crashAtRecordSync(...args) {
      syncCalls += 1;
      if (syncCalls === 6) throw new Error('PROBE_TEST_CRASH: crash after the record write, before its commit');
      return originalSync.apply(this, args);
    };
    try {
      await assert.rejects(
        () => writers.driverAppend({ kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'error-result' }),
        /PROBE_TEST_CRASH/,
        'the simulated crash interrupted the recovering append',
      );
    } finally { fileHandlePrototype.sync = originalSync; }
    const intent = JSON.parse(await readFile(join(run, 'recovery-intent.json'), 'utf8'));
    assert.match((await readFile(eventsPath, 'utf8')), /rpc-observed/, 'the torn record remains in the log');
    assert.equal((await readFile(journalPath, 'utf8')).trim().split('\n').length, 3, 'no commit landed');
    // The next append resolves the unresolved intent by re-executing the
    // recovery: the torn record joins the sidecar and the fresh commit
    // anchors the whole cumulative sidecar.
    await writers.driverAppend({ kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'success-result' });
    const sidecarBytes = await readFile(sidecarPath);
    assert.match(sidecarBytes.toString('utf8'), /handler-settled/, 'the first recovered batch is still in the sidecar');
    assert.match(sidecarBytes.toString('utf8'), /error-result/, 'the torn record joined the sidecar');
    // The stale intent's prefix binding still verifies: appending never rewrote it.
    assert.equal(intent.recoveredDigest, createHash('sha256').update(sidecarBytes.subarray(0, intent.recoveredLength)).digest('hex'), 'the stale intent still verifies against the sidecar prefix it recorded');
    const resolvingCommit = JSON.parse((await readFile(journalPath, 'utf8')).trim().split('\n')[3]);
    assert.equal(resolvingCommit.recoveredCount, 1, 'the fresh recovery records the re-executed batch');
    assert.ok(resolvingCommit.recoveredLength > intent.recoveredLength, 'the cumulative sidecar length strictly grew');
    assert.equal(resolvingCommit.recoveredDigest, createHash('sha256').update(sidecarBytes.subarray(0, resolvingCommit.recoveredLength)).digest('hex'), 'the fresh commit anchors the cumulative sidecar prefix');
    const intentGone = await readFile(join(run, 'recovery-intent.json'), 'utf8').then(() => false, (error) => error.code === 'ENOENT');
    assert.ok(intentGone, 'the superseded intent was removed');
    await writers.reduce();
  });
});

test('direct evidence factories refuse a longer journal that diverges from the process-held commit', async () => {
  await withDirectProbeRun('zcode-direct-observer-', async (run) => {
    const nonce = directRunNonce();
    const writers = makeDirectProbeWriters(run, nonce);
    const label = directLabel();
    const callNonce = directCallNonce();
    await writers.driverAppend({ kind: 'request-sent', probeLabel: label, tool: 'hold_direct', state: 'sent' });
    // Save the count-1 pair; the process-held state will grow past it.
    const savedLog = await readFile(join(run, 'events.jsonl'), 'utf8');
    const savedJournal = await readFile(join(run, 'events-seal.jsonl'), 'utf8');
    await writers.handlerAppend({ kind: 'handler-entered', probeLabel: label, callNonce, serverInstanceHash: directHash('fixture-instance') });
    await writers.handlerAppend({ kind: 'hold-started', callNonce, workerHash: directHash('fixture-worker') });
    // Grow a DIFFERENT authentic history: roll back to the count-1 pair and
    // append driver records (which carry no process-held verification), so
    // the resulting chain is LONGER than the held commit (count 3) but
    // diverges from it at count 2.
    await writeFile(join(run, 'events.jsonl'), savedLog, { mode: 0o600 });
    await writeFile(join(run, 'events-seal.jsonl'), savedJournal, { mode: 0o600 });
    await writers.driverAppend({ kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'error-result' });
    await writers.driverAppend({ kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'success-result' });
    await writers.driverAppend({ kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'error-result' });
    await writers.driverAppend({ kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'success-result' });
    const divergentHead = JSON.parse((await readFile(join(run, 'events-seal.jsonl'), 'utf8')).trim().split('\n').at(-1));
    assert.equal(divergentHead.recordCount, 5, 'the divergent pair is longer than the held commit (count 3)');
    // TWO successive factories must BOTH refuse: the first must not adopt the
    // divergent head into the process-held state, and the second proves the
    // held state was not replaced.
    assert.throws(
      () => createDirectProbeServer({ observer: { runDirectory: run, runNonce: nonce, phase: 'reachability' }, ownerSecret: DIRECT_DRIVER_SECRET }),
      /PROBE_STATE_DIVERGED/,
      'the first factory must refuse a longer divergent head',
    );
    assert.throws(
      () => createDirectProbeServer({ observer: { runDirectory: run, runNonce: nonce, phase: 'reachability' }, ownerSecret: DIRECT_DRIVER_SECRET }),
      /PROBE_STATE_DIVERGED/,
      'the second factory must also refuse: the held state was not replaced by the divergent head',
    );
  });
});

test('direct evidence binds each recovery commit to its cumulative sidecar prefix', async () => {
  await withDirectProbeRun('zcode-direct-observer-', async (run) => {
    const nonce = directRunNonce();
    const writers = makeDirectProbeWriters(run, nonce);
    const { label, callNonce } = await withDirectProbeRecoveryFixture(run, nonce, writers);
    const sidecarPath = join(run, 'events-uncommitted.jsonl');
    // First recovery.
    await writers.driverAppend({ kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'error-result' });
    const firstLength = (await readFile(sidecarPath, 'utf8')).length;
    // Second torn record, then second recovery in the same run.
    const orphan = { version: 1, runNonce: nonce, sequence: 4, phase: 'reachability', kind: 'rpc-observed', callNonce, outcome: 'success-result' };
    await writeFile(join(run, 'events.jsonl'), JSON.stringify(orphan) + '\n', { mode: 0o600, flag: 'a' });
    await writers.driverAppend({ kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'success-result' });
    const sidecarBytes = await readFile(sidecarPath);
    const journalLines = (await readFile(join(run, 'events-seal.jsonl'), 'utf8')).trim().split('\n');
    const firstRecovery = JSON.parse(journalLines[3]);
    const secondRecovery = JSON.parse(journalLines[4]);
    // Each recovery line binds a cumulative sidecar PREFIX, lengths strictly
    // increasing.
    assert.equal(firstRecovery.recoveredCount, 1);
    assert.equal(firstRecovery.recoveredLength, firstLength, 'the first recovery recorded its cumulative length');
    assert.equal(secondRecovery.recoveredCount, 1);
    assert.ok(secondRecovery.recoveredLength > firstRecovery.recoveredLength, 'recovery lengths strictly increase');
    assert.equal(firstRecovery.recoveredDigest, createHash('sha256').update(sidecarBytes.subarray(0, firstRecovery.recoveredLength)).digest('hex'), 'the first line binds the first prefix');
    assert.equal(secondRecovery.recoveredDigest, createHash('sha256').update(sidecarBytes.subarray(0, secondRecovery.recoveredLength)).digest('hex'), 'the second line binds the cumulative prefix');
    // Both recovery lines validate and the run reduces.
    await writers.reduce();
    // Tampering the FIRST segment fails the FIRST recovery line.
    const tamperedFirst = Buffer.from(sidecarBytes);
    tamperedFirst[0] = tamperedFirst[0] === 0x7b ? 0x7c : 0x7b;
    await writeFile(sidecarPath, tamperedFirst, { mode: 0o600 });
    await assert.rejects(writers.reduce, /PROBE_OWNER_INVALID/, 'tampering the first sidecar segment must fail its recovery line');
    // Tampering ONLY the second segment fails the SECOND recovery line.
    await writeFile(sidecarPath, sidecarBytes, { mode: 0o600 });
    const tamperedSecond = Buffer.from(sidecarBytes);
    tamperedSecond[firstLength] = tamperedSecond[firstLength] === 0x7b ? 0x7c : 0x7b;
    await writeFile(sidecarPath, tamperedSecond, { mode: 0o600 });
    await assert.rejects(writers.reduce, /PROBE_OWNER_INVALID/, 'tampering the second sidecar segment must fail its recovery line');
    await writeFile(sidecarPath, sidecarBytes, { mode: 0o600 });
    await writers.reduce();
  });
});

// --- Codex gate round 14: crash-recovery edges. Regressions written FIRST:
// --- directory-entry durability, the empty committed prefix, and torn
// --- seal-journal tail repair with preserved evidence.

test('direct evidence fsyncs the run directory after the recovery intent and before truncating', async () => {
  await withDirectProbeRun('zcode-direct-observer-', async (run) => {
    const nonce = directRunNonce();
    const writers = makeDirectProbeWriters(run, nonce);
    const { label, callNonce } = await withDirectProbeRecoveryFixture(run, nonce, writers);
    const eventsPath = join(run, 'events.jsonl');
    const sidecarPath = join(run, 'events-uncommitted.jsonl');
    const journalPath = join(run, 'events-seal.jsonl');
    const intentPath = join(run, 'recovery-intent.json');
    const logBeforeCrash = await readFile(eventsPath, 'utf8');
    // Fault injection: crash at the FOURTH fsync of the recovering append —
    // the sidecar's directory entry fsync (round 36 ordering: the intent is
    // written first, then the sidecar is atomically replaced and its
    // directory entry fsynced). The sidecar and the intent are durable
    // BEFORE the truncation erases the recovered records from the log; a run
    // without the sidecar's directory fsync truncates first and crashes at
    // the record's fsync instead, so the post-crash state assertions below
    // fail.
    const probeHandle = await open(eventsPath, 'r');
    const fileHandlePrototype = Object.getPrototypeOf(probeHandle);
    await probeHandle.close();
    const originalSync = fileHandlePrototype.sync;
    let syncCalls = 0;
    fileHandlePrototype.sync = function crashAtDirectoryFsync(...args) {
      syncCalls += 1;
      if (syncCalls === 4) throw new Error('PROBE_TEST_CRASH: crash at the run directory fsync');
      return originalSync.apply(this, args);
    };
    try {
      await assert.rejects(
        () => writers.driverAppend({ kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'error-result' }),
        /PROBE_TEST_CRASH/,
        'the simulated crash interrupted the recovering append at the directory fsync',
      );
    } finally { fileHandlePrototype.sync = originalSync; }
    // Crash after sidecar + intent creation and their directory fsync, but
    // BEFORE the truncation: both new files exist and the log still holds
    // the recovered records.
    assert.match(await readFile(sidecarPath, 'utf8'), /handler-settled/, 'the sidecar exists');
    await readFile(intentPath, 'utf8');
    assert.equal(await readFile(eventsPath, 'utf8'), logBeforeCrash, 'the directory fsync ran between the intent and the truncation');
    assert.equal((await readFile(journalPath, 'utf8')).trim().split('\n').length, 3, 'no commit landed');
  });
});

test('direct evidence fsyncs the run directory after unlinking a resolved intent', async () => {
  await withDirectProbeRun('zcode-direct-observer-', async (run) => {
    const nonce = directRunNonce();
    const writers = makeDirectProbeWriters(run, nonce);
    const { label, callNonce } = await withDirectProbeRecoveryFixture(run, nonce, writers);
    const eventsPath = join(run, 'events.jsonl');
    const journalPath = join(run, 'events-seal.jsonl');
    const intentPath = join(run, 'recovery-intent.json');
    // First, create the unresolved-intent state: crash between truncation
    // and the recovery commit (the record handle's first stat).
    const probeHandle = await open(eventsPath, 'r');
    const fileHandlePrototype = Object.getPrototypeOf(probeHandle);
    await probeHandle.close();
    const originalStat = fileHandlePrototype.stat;
    let plainStats = 0;
    fileHandlePrototype.stat = function crashBetweenTruncationAndCommit(...args) {
      if (args.length === 0) plainStats += 1;
      if (plainStats === 2) throw new Error('PROBE_TEST_CRASH: crash between truncation and the recovery commit');
      return originalStat.apply(this, args);
    };
    try {
      await assert.rejects(
        () => writers.driverAppend({ kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'error-result' }),
        /PROBE_TEST_CRASH/,
      );
    } finally { fileHandlePrototype.stat = originalStat; }
    await readFile(intentPath, 'utf8');
    // Now the resolving append: crash at its FOURTH fsync — the run
    // directory fsync that must follow the intent's unlink. (Round 28
    // crashed at the third fsync; since round 29 EVERY commit fsyncs the
    // run directory, so the resolving append's third fsync is now the
    // commit's own directory fsync and the post-unlink directory fsync
    // follows it as the fourth. The invariant is unchanged: the unlink's
    // directory entry is made durable before the append can report.)
    const originalSync = fileHandlePrototype.sync;
    let syncCalls = 0;
    fileHandlePrototype.sync = function crashAtPostUnlinkDirectoryFsync(...args) {
      syncCalls += 1;
      if (syncCalls === 4) throw new Error('PROBE_TEST_CRASH: crash at the directory fsync after the intent unlink');
      return originalSync.apply(this, args);
    };
    try {
      await assert.rejects(
        () => writers.driverAppend({ kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'success-result' }),
        /PROBE_TEST_CRASH/,
        'the simulated crash interrupted the resolving append at the directory fsync',
      );
    } finally { fileHandlePrototype.sync = originalSync; }
    // The crash fired AFTER the commit and the intent unlink: the journal
    // head carries the recovery fields and the intent file is already gone.
    const resolvingCommit = JSON.parse((await readFile(journalPath, 'utf8')).trim().split('\n')[3]);
    assert.equal(resolvingCommit.recordCount, 4, 'the resolving commit landed');
    assert.equal(resolvingCommit.recoveredCount, 1, 'the resolving commit carries the recovery fields');
    const intentGone = await readFile(intentPath, 'utf8').then(() => false, (error) => error.code === 'ENOENT');
    assert.ok(intentGone, 'the intent was unlinked before the directory fsync');
    // The crashed driver never learned the commit, so it re-anchors from the
    // authenticated journal head; the run still reduces.
    const head = JSON.parse((await readFile(journalPath, 'utf8')).trim().split('\n').at(-1));
    const reduced = await reduceDirectProbeLog({ runDirectory: run, runNonce: nonce, ownerSecret: DIRECT_DRIVER_SECRET, ownerPid: process.pid, expectedFinalState: { recordCount: head.recordCount, eventsDigest: head.eventsDigest } });
    assert.equal(reduced.recovery.sidecarPresent, true, 'the sidecar stays anchored after the resolution');
  });
});

test('direct evidence recovers an unsealed first record onto an empty committed prefix', async () => {
  await withDirectProbeRun('zcode-direct-observer-', async (run) => {
    const nonce = directRunNonce();
    const writers = makeDirectProbeWriters(run, nonce);
    const label = directLabel();
    // Fault injection: the very FIRST record is fsynced but its seal never
    // landed — the committed prefix is empty and there is no journal file.
    const orphan = { version: 1, runNonce: nonce, sequence: 0, phase: 'reachability', kind: 'request-sent', probeLabel: label, tool: 'hold_direct', state: 'sent' };
    await writeFile(join(run, 'events.jsonl'), JSON.stringify(orphan) + '\n', { mode: 0o600 });
    // The next append recovers onto the empty committed prefix: the orphan
    // moves to the sidecar, the log truncates to empty, and the new record
    // starts the chain densely at sequence 0. (The recovering record is a
    // driver request-sent so the reduction needs no handler join.)
    const result = await writers.driverAppend({ kind: 'request-sent', probeLabel: label, tool: 'hold_direct', state: 'sent' });
    assert.equal(result.record.sequence, 0, 'the new record continues densely from the empty prefix');
    assert.equal(result.commit.recordCount, 1, 'the chain holds exactly the new committed record');
    assert.match(await readFile(join(run, 'events-uncommitted.jsonl'), 'utf8'), /request-sent/, 'the unsealed first record moved to the sidecar');
    const intentGone = await readFile(join(run, 'recovery-intent.json'), 'utf8').then(() => false, (error) => error.code === 'ENOENT');
    assert.ok(intentGone, 'the recovery intent was resolved after its commit landed');
    const reduced = await writers.reduce();
    assert.equal(reduced.uncommittedCount, 0);
    assert.equal(reduced.recovery.sidecarPresent, true, 'the recovery surface is visible in the reduction');
    assert.equal(reduced.recovery.sidecarRecords, 1);
  });
});

test('direct evidence repairs a torn seal-journal tail and preserves the fragment', async () => {
  await withDirectProbeRun('zcode-direct-observer-', async (run) => {
    const nonce = directRunNonce();
    const writers = makeDirectProbeWriters(run, nonce);
    const label = directLabel();
    const callNonce = directCallNonce();
    await writers.driverAppend({ kind: 'request-sent', probeLabel: label, tool: 'hold_direct', state: 'sent' });
    await writers.handlerAppend({ kind: 'handler-entered', probeLabel: label, callNonce, serverInstanceHash: directHash('fixture-instance') });
    // Fault injection: a crash mid journal-line write — the journal ends
    // with a torn fragment and no terminating newline.
    const journalPath = join(run, 'events-seal.jsonl');
    const completeJournal = await readFile(journalPath, 'utf8');
    const tornFragment = `{"version":1,"runNonce":"${nonce}","recordCo`;
    await writeFile(journalPath, completeJournal + tornFragment, { mode: 0o600 });
    // The next append repairs the tail, preserves the fragment, and proceeds.
    await writers.driverAppend({ kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'error-result' });
    const journalLines = (await readFile(journalPath, 'utf8')).trim().split('\n');
    assert.equal(journalLines.length, 3, 'the torn fragment was truncated away and the new commit landed');
    // The journal is exactly the repaired chain plus the new commit: every
    // line parses and the counts run 1, 2, 3 — no torn text remains.
    const repairedCounts = (await readFile(journalPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line).recordCount);
    assert.deepEqual(repairedCounts, [1, 2, 3], 'the repaired journal is the complete chain plus the new commit');
    // The fragment is preserved as authenticated evidence.
    const tornRecord = JSON.parse((await readFile(join(run, 'journal-torn.jsonl'), 'utf8')).trim().split('\n').at(-1));
    assert.equal(tornRecord.version, 1);
    assert.equal(tornRecord.runNonce, nonce);
    assert.match(tornRecord.fragment, /recordCo/, 'the torn fragment text is preserved');
    assert.match(tornRecord.tornMac, /^[0-9a-f]{64}$/, 'the preserved fragment is authenticated');
    // The run reduces and the torn fragment is visible in the reduction.
    const reduced = await writers.reduce();
    assert.equal(reduced.recovery.tornJournalFragments, 1, 'the torn fragment is visible in the reduction');
  });
});

test('direct evidence repairs a structurally broken final journal line while keeping the chain', async () => {
  await withDirectProbeRun('zcode-direct-observer-', async (run) => {
    const nonce = directRunNonce();
    const writers = makeDirectProbeWriters(run, nonce);
    const label = directLabel();
    const callNonce = directCallNonce();
    await writers.driverAppend({ kind: 'request-sent', probeLabel: label, tool: 'hold_direct', state: 'sent' });
    await writers.handlerAppend({ kind: 'handler-entered', probeLabel: label, callNonce, serverInstanceHash: directHash('fixture-instance') });
    // Fault injection: a COMPLETE but structurally broken final journal line
    // (record count far past the chain) after two validly chained lines.
    const brokenLine = JSON.stringify({ version: 1, runNonce: nonce, recordCount: 99, eventsDigest: 'f'.repeat(64), sealMac: 'e'.repeat(64) });
    const journalPath = join(run, 'events-seal.jsonl');
    await writeFile(journalPath, `${await readFile(journalPath, 'utf8')}${brokenLine}\n`, { mode: 0o600 });
    // The next append preserves the broken line as evidence, removes it from
    // the journal, and proceeds.
    await writers.driverAppend({ kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'error-result' });
    const journalLines = (await readFile(journalPath, 'utf8')).trim().split('\n');
    assert.equal(journalLines.length, 3, 'the broken final line was removed and the new commit landed');
    assert.equal(JSON.parse(journalLines[2]).recordCount, 3, 'the new commit chains directly onto the valid prefix');
    const tornRecord = JSON.parse((await readFile(join(run, 'journal-torn.jsonl'), 'utf8')).trim().split('\n').at(-1));
    assert.equal(tornRecord.fragment, brokenLine, 'the broken line is preserved verbatim');
    const reduced = await writers.reduce();
    assert.equal(reduced.recovery.tornJournalFragments, 1, 'the broken line is visible in the reduction');
  });
});

// --- Codex gate round 15: anchored repair evidence and the journal's first
// --- directory entry. Regressions written FIRST.

/** Builds a run with two committed records and one repaired torn journal tail. */
async function withDirectProbeRepairFixture(run, nonce, writers, label, callNonce) {
  await writers.driverAppend({ kind: 'request-sent', probeLabel: label, tool: 'hold_direct', state: 'sent' });
  await writers.handlerAppend({ kind: 'handler-entered', probeLabel: label, callNonce, serverInstanceHash: directHash('fixture-instance') });
  const journalPath = join(run, 'events-seal.jsonl');
  await writeFile(journalPath, `${await readFile(journalPath, 'utf8')}{"version":1,"runNonce":"${nonce}","recordCo`, { mode: 0o600 });
  await writers.driverAppend({ kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'error-result' });
  return journalPath;
}

/**
 * Hand-builds the durable, authenticated repair intent for the round 35
 * intent-first partial-evidence constructions: the intent binds the torn
 * sidecar's exact pre-truncation state (valid prefix + crashed-write tail)
 * and the preservation content the repair is about to materialize, so the
 * partial-evidence file only ever exists behind a durable binding.
 */
function makeDirectRepairIntent({ nonce, ownerSecret, validPrefixBytes, tailBytes, fragment, partialContentBytes }) {
  const fragmentRecord = { version: 1, runNonce: nonce, fragment, tornMac: createHmac('sha256', Buffer.from(ownerSecret, 'utf8')).update(canonicalJson({ version: 1, runNonce: nonce, fragment })).digest('hex') };
  const finalSidecarBytes = Buffer.concat([validPrefixBytes, Buffer.from(`${JSON.stringify(fragmentRecord)}\n`, 'utf8')]);
  const intent = {
    version: 1,
    runNonce: nonce,
    tornValidLength: validPrefixBytes.length,
    tornValidDigest: createHash('sha256').update(validPrefixBytes).digest('hex'),
    tornTailLength: tailBytes.length,
    tornTailDigest: createHash('sha256').update(tailBytes).digest('hex'),
    tornFragmentCount: 2,
    tornDigest: createHash('sha256').update(finalSidecarBytes).digest('hex'),
    tornLength: finalSidecarBytes.length,
    partialDigest: createHash('sha256').update(partialContentBytes).digest('hex'),
    partialLength: partialContentBytes.length,
  };
  return {
    intentLine: `${JSON.stringify({ ...intent, repairIntentMac: createHmac('sha256', Buffer.from(ownerSecret, 'utf8')).update(canonicalJson(intent)).digest('hex') })}\n`,
    finalSidecarBytes,
    fragmentRecord,
  };
}

/**
 * Round 35 intent-first fixture: produces anchored partial evidence the way
 * the protocol legitimately does it — a durable repair intent binds the
 * crashed preservation write's content (derived from the planted torn-sidecar
 * tail) BEFORE that content exists as a file, and the completing repair
 * recomputes it from the torn source, verifies it against the intent, writes
 * it, truncates the tail, and anchors it. Leaves the run with the partial
 * sidecar holding exactly one preservation record of `tailText`, the torn
 * sidecar at two fragment records, and the intent resolved.
 */
async function withDirectProbeIntentFirstPartialFixture(run, nonce, writers, label, callNonce, tailText) {
  const journalPath = join(run, 'events-seal.jsonl');
  const tornPath = join(run, 'journal-torn.jsonl');
  const intentPath = join(run, 'repair-intent.json');
  const anchorSidecarBytes = await readFile(tornPath);
  const tailBytes = Buffer.from(tailText, 'utf8');
  const preservationData = tailBytes.toString('base64');
  const preservationLine = JSON.stringify({ version: 1, runNonce: nonce, data: preservationData, partialMac: createHmac('sha256', Buffer.from(DIRECT_DRIVER_SECRET, 'utf8')).update(canonicalJson({ version: 1, runNonce: nonce, data: preservationData })).digest('hex') });
  const partialContentBytes = Buffer.from(`${preservationLine}\n`, 'utf8');
  const { intentLine } = makeDirectRepairIntent({ nonce, ownerSecret: DIRECT_DRIVER_SECRET, validPrefixBytes: anchorSidecarBytes, tailBytes, fragment: tailText, partialContentBytes });
  await writeFile(tornPath, Buffer.concat([anchorSidecarBytes, tailBytes]), { mode: 0o600 });
  await writeFile(intentPath, intentLine, { mode: 0o600 });
  await writeFile(journalPath, `${await readFile(journalPath, 'utf8')}${tailText}`, { mode: 0o600 });
  await writers.driverAppend({ kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'error-result' });
  return { tailBytes };
}

test('direct evidence fails reduction closed when preserved repair fragments are deleted', async () => {
  await withDirectProbeRun('zcode-direct-observer-', async (run) => {
    const nonce = directRunNonce();
    const writers = makeDirectProbeWriters(run, nonce);
    const label = directLabel();
    const callNonce = directCallNonce();
    const journalPath = await withDirectProbeRepairFixture(run, nonce, writers, label, callNonce);
    // The repairing append's commit line anchors the preserved fragments.
    const tornBytes = await readFile(join(run, 'journal-torn.jsonl'));
    const anchorLine = JSON.parse((await readFile(journalPath, 'utf8')).trim().split('\n')[2]);
    assert.equal(anchorLine.tornFragmentCount, 1, 'the repair anchor records the fragment count');
    assert.equal(anchorLine.tornLength, tornBytes.length, 'the repair anchor records the cumulative fragment length');
    assert.equal(anchorLine.tornDigest, createHash('sha256').update(tornBytes).digest('hex'), 'the repair anchor records the fragment digest');
    // Deleting the preserved fragments fails the reduction closed: the
    // evidence of the rejected tail can never silently disappear.
    await rm(join(run, 'journal-torn.jsonl'));
    await assert.rejects(writers.reduce, /PROBE_OWNER_INVALID/, 'a deleted torn-fragment sidecar must fail the reduction closed');
  });
});

test('direct evidence fails reduction closed when preserved repair fragments are altered', async () => {
  await withDirectProbeRun('zcode-direct-observer-', async (run) => {
    const nonce = directRunNonce();
    const writers = makeDirectProbeWriters(run, nonce);
    const label = directLabel();
    const callNonce = directCallNonce();
    await withDirectProbeRepairFixture(run, nonce, writers, label, callNonce);
    const tornPath = join(run, 'journal-torn.jsonl');
    const tornBytes = await readFile(tornPath);
    // Altering one byte of the preserved fragments fails the reduction...
    const tampered = Buffer.from(tornBytes);
    tampered[0] = tampered[0] === 0x7b ? 0x7c : 0x7b;
    await writeFile(tornPath, tampered, { mode: 0o600 });
    await assert.rejects(writers.reduce, /PROBE_OWNER_INVALID/, 'an altered torn-fragment sidecar must fail the reduction closed');
    // ...and restoring the bytes reduces again.
    await writeFile(tornPath, tornBytes, { mode: 0o600 });
    const reduced = await writers.reduce();
    assert.equal(reduced.recovery.tornJournalFragments, 1, 'the intact fragments stay visible in the reduction');
  });
});

test('direct evidence anchors multiple repairs with strictly growing cumulative state', async () => {
  await withDirectProbeRun('zcode-direct-observer-', async (run) => {
    const nonce = directRunNonce();
    const writers = makeDirectProbeWriters(run, nonce);
    const label = directLabel();
    const callNonce = directCallNonce();
    const journalPath = await withDirectProbeRepairFixture(run, nonce, writers, label, callNonce);
    // Second torn tail, second repair in the same run.
    await writeFile(journalPath, `${await readFile(journalPath, 'utf8')}{"version":1,"runNonce":"${nonce}","re`, { mode: 0o600 });
    await writers.driverAppend({ kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'success-result' });
    const tornBytes = await readFile(join(run, 'journal-torn.jsonl'));
    const journalLines = (await readFile(journalPath, 'utf8')).trim().split('\n');
    const firstAnchor = JSON.parse(journalLines[2]);
    const secondAnchor = JSON.parse(journalLines[3]);
    // Both repair anchors validate against their cumulative sidecar prefixes.
    assert.equal(firstAnchor.tornFragmentCount, 1);
    assert.equal(secondAnchor.tornFragmentCount, 2, 'the second repair records both fragments');
    assert.ok(secondAnchor.tornLength > firstAnchor.tornLength, 'repair lengths strictly increase');
    assert.equal(firstAnchor.tornDigest, createHash('sha256').update(tornBytes.subarray(0, firstAnchor.tornLength)).digest('hex'), 'the first anchor binds the first prefix');
    assert.equal(secondAnchor.tornDigest, createHash('sha256').update(tornBytes.subarray(0, secondAnchor.tornLength)).digest('hex'), 'the second anchor binds the cumulative prefix');
    // Both anchors validate and the run reduces.
    const reduced = await writers.reduce();
    assert.equal(reduced.recovery.tornJournalFragments, 2, 'both fragments stay visible in the reduction');
  });
});

test('direct evidence fsyncs the run directory when the seal journal is first created', async () => {
  await withDirectProbeRun('zcode-direct-observer-', async (run) => {
    const nonce = directRunNonce();
    const writers = makeDirectProbeWriters(run, nonce);
    const label = directLabel();
    const callNonce = directCallNonce();
    // Crash injection: on the FIRST append the journal file is created; the
    // run directory fsync must happen between the journal's own fsync and
    // the commit being reported durable. A run without it reports the first
    // commit durable with a directory entry that a power loss can drop, so
    // no third fsync ever fires and the rejection below fails.
    const probeHandle = await open(run, 'r');
    const fileHandlePrototype = Object.getPrototypeOf(probeHandle);
    await probeHandle.close();
    const originalSync = fileHandlePrototype.sync;
    let syncCalls = 0;
    fileHandlePrototype.sync = function crashAtJournalCreationDirectoryFsync(...args) {
      syncCalls += 1;
      if (syncCalls === 3) throw new Error('PROBE_TEST_CRASH: crash at the journal-creation directory fsync');
      return originalSync.apply(this, args);
    };
    try {
      await assert.rejects(
        () => writers.driverAppend({ kind: 'request-sent', probeLabel: label, tool: 'hold_direct', state: 'sent' }),
        /PROBE_TEST_CRASH/,
        'the simulated crash interrupted the first append at the journal-creation directory fsync',
      );
    } finally { fileHandlePrototype.sync = originalSync; }
    // The journal line landed before the crash; the commit was not reported.
    const journalLines = (await readFile(join(run, 'events-seal.jsonl'), 'utf8')).trim().split('\n');
    assert.equal(journalLines.length, 1, 'the journal line was created and fsynced before the directory fsync');
    // A SECOND append proceeds normally: since round 29 EVERY commit fsyncs
    // the run directory (unconditionally, so no cross-process file state can
    // ever skip it), and the injected crash was restored before this append,
    // so the second commit's directory fsync simply succeeds.
    await writers.handlerAppend({ kind: 'handler-entered', probeLabel: label, callNonce, serverInstanceHash: directHash('fixture-instance') });
    const journalAfter = (await readFile(join(run, 'events-seal.jsonl'), 'utf8')).trim().split('\n');
    assert.equal(journalAfter.length, 2, 'the second append commits without recreating the journal');
  });
});

// --- Codex gate round 16: the repair path gets the intent mechanism. ---
// --- Regressions written FIRST: a crash between the journal truncation and ---
// --- the anchoring commit must leave a durable, authenticated repair intent, ---
// --- and reduction must fail while it is unresolved.

test('direct evidence resolves a repair intent left by a crash between journal truncation and the anchoring commit', async () => {
  await withDirectProbeRun('zcode-direct-observer-', async (run) => {
    const nonce = directRunNonce();
    const writers = makeDirectProbeWriters(run, nonce);
    const label = directLabel();
    const callNonce = directCallNonce();
    await writers.driverAppend({ kind: 'request-sent', probeLabel: label, tool: 'hold_direct', state: 'sent' });
    await writers.handlerAppend({ kind: 'handler-entered', probeLabel: label, callNonce, serverInstanceHash: directHash('fixture-instance') });
    const journalPath = join(run, 'events-seal.jsonl');
    const tornPath = join(run, 'journal-torn.jsonl');
    const intentPath = join(run, 'repair-intent.json');
    await writeFile(journalPath, `${await readFile(journalPath, 'utf8')}{"version":1,"runNonce":"${nonce}","recordCo`, { mode: 0o600 });
    // Fault injection: crash at the FIFTH fsync of the repairing append —
    // the repaired journal's own, immediately after the truncation — so the
    // durable repair intent exists and no anchor commit ever landed.
    const probeHandle = await open(run, 'r');
    const fileHandlePrototype = Object.getPrototypeOf(probeHandle);
    await probeHandle.close();
    const originalSync = fileHandlePrototype.sync;
    let syncCalls = 0;
    fileHandlePrototype.sync = function crashAfterJournalTruncation(...args) {
      syncCalls += 1;
      if (syncCalls === 5) throw new Error('PROBE_TEST_CRASH: crash after the journal truncation, before the anchoring commit');
      return originalSync.apply(this, args);
    };
    try {
      await assert.rejects(
        () => writers.driverAppend({ kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'error-result' }),
        /PROBE_TEST_CRASH/,
        'the simulated crash interrupted the repairing append',
      );
    } finally { fileHandlePrototype.sync = originalSync; }
    // The journal was repaired (the torn tail is gone) but the anchor commit
    // never landed.
    const repairedJournal = await readFile(journalPath, 'utf8');
    assert.equal(repairedJournal.trim().split('\n').length, 2, 'the torn tail was truncated away');
    assert.ok(repairedJournal.endsWith('\n'), 'the journal ends with a complete line');
    // The durable repair intent records the repair.
    const tornBytes = await readFile(tornPath);
    const intent = JSON.parse(await readFile(intentPath, 'utf8'));
    assert.equal(intent.version, 1);
    assert.equal(intent.runNonce, nonce);
    assert.equal(intent.tornFragmentCount, 1, 'the intent records the fragment count');
    assert.equal(intent.tornLength, tornBytes.length, 'the intent records the cumulative fragment length');
    assert.equal(intent.tornDigest, createHash('sha256').update(tornBytes).digest('hex'), 'the intent records the fragment digest');
    assert.match(intent.repairIntentMac, /^[0-9a-f]{64}$/, 'the intent is authenticated');
    // Reduction with an unresolved repair intent fails closed — even though
    // the journal head still matches the driver anchor.
    await assert.rejects(writers.reduce, /PROBE_OWNER_INVALID/, 'an unresolved repair intent must fail the reduction closed');
    // Deleting the preserved fragments while the intent is unresolved fails closed.
    await rm(tornPath);
    await assert.rejects(writers.reduce, /PROBE_OWNER_INVALID/, 'deleted repair fragments under an unresolved intent must fail the reduction closed');
    await writeFile(tornPath, tornBytes, { mode: 0o600 });
    // Altering the intent fails closed too.
    await writeFile(intentPath, `${JSON.stringify({ ...intent, repairIntentMac: 'e'.repeat(64) })}\n`, { mode: 0o600 });
    await assert.rejects(writers.reduce, /PROBE_OWNER_INVALID/, 'an altered repair intent must fail the reduction closed');
    await writeFile(intentPath, `${JSON.stringify(intent)}\n`, { mode: 0o600 });
    // The next append resolves the intent: its commit carries the
    // intent-bound anchor fields and the intent is removed.
    await writers.driverAppend({ kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'error-result' });
    const intentGone = await readFile(intentPath, 'utf8').then(() => false, (error) => error.code === 'ENOENT');
    assert.ok(intentGone, 'the resolved repair intent was removed');
    const resolvingCommit = JSON.parse((await readFile(journalPath, 'utf8')).trim().split('\n')[2]);
    assert.equal(resolvingCommit.tornFragmentCount, intent.tornFragmentCount, 'the resolving commit carries the intent fragment count');
    assert.equal(resolvingCommit.tornDigest, intent.tornDigest, 'the resolving commit carries the intent fragment digest');
    assert.equal(resolvingCommit.tornLength, intent.tornLength, 'the resolving commit carries the intent fragment length');
    // The anchor landed: reduction succeeds and the fragments stay visible.
    const reduced = await writers.reduce();
    assert.equal(reduced.recovery.tornJournalFragments, 1, 'the fragments stay visible in the reduction');
  });
});

// --- Codex gate round 17: a repeat repair validates the existing repair ---
// --- intent before replacing it. Regressions written FIRST: repairing over ---
// --- an unverifiable intent could launder the deletion of a previously ---
// --- preserved fragment.

test('direct evidence refuses a repeat repair that would overwrite an unverifiable repair intent', async () => {
  await withDirectProbeRun('zcode-direct-observer-', async (run) => {
    const nonce = directRunNonce();
    const writers = makeDirectProbeWriters(run, nonce);
    const label = directLabel();
    const callNonce = directCallNonce();
    await writers.driverAppend({ kind: 'request-sent', probeLabel: label, tool: 'hold_direct', state: 'sent' });
    await writers.handlerAppend({ kind: 'handler-entered', probeLabel: label, callNonce, serverInstanceHash: directHash('fixture-instance') });
    const journalPath = join(run, 'events-seal.jsonl');
    const tornPath = join(run, 'journal-torn.jsonl');
    const intentPath = join(run, 'repair-intent.json');
    // First repair: torn tail, repair, crash after the truncation — the
    // first repair intent stays unresolved (no anchor commit landed).
    await writeFile(journalPath, `${await readFile(journalPath, 'utf8')}{"version":1,"runNonce":"${nonce}","recordCo`, { mode: 0o600 });
    const probeHandle = await open(run, 'r');
    const fileHandlePrototype = Object.getPrototypeOf(probeHandle);
    await probeHandle.close();
    const originalSync = fileHandlePrototype.sync;
    let syncCalls = 0;
    fileHandlePrototype.sync = function crashAfterJournalTruncation(...args) {
      syncCalls += 1;
      if (syncCalls === 5) throw new Error('PROBE_TEST_CRASH: crash after the journal truncation, before the anchoring commit');
      return originalSync.apply(this, args);
    };
    try {
      await assert.rejects(
        () => writers.driverAppend({ kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'error-result' }),
        /PROBE_TEST_CRASH/,
      );
    } finally { fileHandlePrototype.sync = originalSync; }
    const intentBefore = await readFile(intentPath, 'utf8');
    const firstIntent = JSON.parse(intentBefore);
    const firstTornBytes = await readFile(tornPath);
    assert.equal(firstIntent.tornLength, firstTornBytes.length, 'the first intent covers the first fragment');
    // The attack: delete the first preserved fragment, then tear the journal
    // again so the next append enters the repair path a second time.
    await writeFile(tornPath, '', { mode: 0o600 });
    const secondTornFragment = '{"version":1,"runN';
    await writeFile(journalPath, `${await readFile(journalPath, 'utf8')}${secondTornFragment}`, { mode: 0o600 });
    // The second repair must REFUSE: the existing intent no longer verifies
    // against its covered fragment prefix, so it must not be overwritten.
    await assert.rejects(
      () => writers.driverAppend({ kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'error-result' }),
      /PROBE_OWNER_INVALID/,
      'a repeat repair over an unverifiable repair intent must be refused',
    );
    // The intent remains intact (not replaced) and the refused repair never
    // touched the journal — the second torn tail is still there.
    assert.equal(await readFile(intentPath, 'utf8'), intentBefore, 'the existing intent was not replaced');
    const journalLinesAfterRefusal = (await readFile(journalPath, 'utf8')).trimEnd().split('\n');
    assert.equal(journalLinesAfterRefusal.length, 3, 'the journal was untouched by the refused repair');
    assert.equal(journalLinesAfterRefusal.at(-1), secondTornFragment, 'the second torn tail is untouched');
    // Reduction still fails closed.
    await assert.rejects(writers.reduce, /PROBE_OWNER_INVALID/, 'the run still fails reduction closed');
    // Restore the first fragment: the second repair succeeds and EXTENDS the
    // preserved history — one cumulative anchor covers both fragments, with
    // the first fragment's prefix preserved.
    await writeFile(tornPath, firstTornBytes, { mode: 0o600 });
    await writers.driverAppend({ kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'success-result' });
    const intentGone = await readFile(intentPath, 'utf8').then(() => false, (error) => error.code === 'ENOENT');
    assert.ok(intentGone, 'the extended repair intent was resolved after its anchor commit landed');
    const tornBytes = await readFile(tornPath);
    const journalLines = (await readFile(journalPath, 'utf8')).trim().split('\n');
    const anchorLine = JSON.parse(journalLines.at(-1));
    assert.equal(anchorLine.tornFragmentCount, 2, 'the second repair anchors both fragments');
    assert.equal(anchorLine.tornLength, tornBytes.length, 'the anchor covers the full cumulative history');
    assert.equal(anchorLine.tornDigest, createHash('sha256').update(tornBytes).digest('hex'), 'the anchor binds the cumulative history');
    assert.ok(anchorLine.tornLength > firstIntent.tornLength, 'the covered history strictly grew');
    assert.equal(
      createHash('sha256').update(tornBytes.subarray(0, firstIntent.tornLength)).digest('hex'),
      firstIntent.tornDigest,
      'the first fragment\u0027s prefix is preserved under the extended anchor',
    );
    // The run reduces and both fragments stay visible.
    const reduced = await writers.reduce();
    assert.equal(reduced.recovery.tornJournalFragments, 2, 'both fragments stay visible in the reduction');
  });
});

// --- Codex gate round 18: corruption is not a torn tail, and intent ---
// --- replacement is atomic. Regressions written FIRST.

test('direct evidence refuses to repair away an authenticated final commit with corrupted event bytes', async () => {
  await withDirectProbeRun('zcode-direct-observer-', async (run) => {
    const nonce = directRunNonce();
    const writers = makeDirectProbeWriters(run, nonce);
    const label = directLabel();
    const callNonce = directCallNonce();
    await writers.driverAppend({ kind: 'request-sent', probeLabel: label, tool: 'hold_direct', state: 'sent' });
    await writers.handlerAppend({ kind: 'handler-entered', probeLabel: label, callNonce, serverInstanceHash: directHash('fixture-instance') });
    // Corrupt the EVENT bytes covered by the final AUTHENTICATED commit: the
    // journal line itself stays complete and Mac-valid, but its event prefix
    // no longer matches — corruption, not a torn journal tail.
    const eventsPath = join(run, 'events.jsonl');
    const eventLines = (await readFile(eventsPath, 'utf8')).trim().split('\n');
    const tamperedRecord = { ...JSON.parse(eventLines[1]), serverInstanceHash: directHash('tampered-instance') };
    await writeFile(eventsPath, [eventLines[0], JSON.stringify(tamperedRecord)].join('\n') + '\n', { mode: 0o600 });
    const journalBefore = await readFile(join(run, 'events-seal.jsonl'), 'utf8');
    // The append must REFUSE outright — no repair, no truncation, no movement.
    await assert.rejects(
      () => writers.driverAppend({ kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'error-result' }),
      /PROBE_STATE_DIVERGED/,
      'an authenticated final commit with corrupted event bytes must be refused, not repaired',
    );
    assert.equal(await readFile(join(run, 'events-seal.jsonl'), 'utf8'), journalBefore, 'the journal was not truncated');
    const absent = (path) => readFile(path, 'utf8').then(() => false, (error) => error.code === 'ENOENT');
    assert.ok(await absent(join(run, 'events-uncommitted.jsonl')), 'no event record moved to the recovery sidecar');
    assert.ok(await absent(join(run, 'recovery-intent.json')), 'no recovery intent was written');
    assert.ok(await absent(join(run, 'journal-torn.jsonl')), 'no journal line was preserved as torn');
    // Reduction fails closed.
    await assert.rejects(writers.reduce, /PROBE_OWNER_INVALID/, 'the corrupted run must fail the reduction closed');
  });
});

test('direct evidence replaces a recovery intent atomically so a crash cannot destroy it', async () => {
  await withDirectProbeRun('zcode-direct-observer-', async (run) => {
    const nonce = directRunNonce();
    const writers = makeDirectProbeWriters(run, nonce);
    const { label, callNonce } = await withDirectProbeRecoveryFixture(run, nonce, writers);
    const eventsPath = join(run, 'events.jsonl');
    const intentPath = join(run, 'recovery-intent.json');
    // First crash: at the record's own fsync (round 36 ordering: the intent
    // temp and directory writes, the sidecar's atomic write and directory
    // entry, then the record) — the intent is left unresolved AND a torn
    // record remains in the log, so the next append must re-execute the
    // recovery.
    const probeHandle = await open(eventsPath, 'r');
    const fileHandlePrototype = Object.getPrototypeOf(probeHandle);
    await probeHandle.close();
    const originalSync = fileHandlePrototype.sync;
    let syncCalls = 0;
    fileHandlePrototype.sync = function crashAtRecordSync(...args) {
      syncCalls += 1;
      if (syncCalls === 6) throw new Error('PROBE_TEST_CRASH: crash after the record write, before its commit');
      return originalSync.apply(this, args);
    };
    try {
      await assert.rejects(
        () => writers.driverAppend({ kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'error-result' }),
        /PROBE_TEST_CRASH/,
      );
    } finally { fileHandlePrototype.sync = originalSync; }
    const intentBefore = await readFile(intentPath, 'utf8');
    assert.match((await readFile(eventsPath, 'utf8')), /rpc-observed/, 'the torn record remains in the log');
    // Second crash: the resolving append re-executes the recovery and
    // REPLACES the intent — crash at the replacement's temp fsync, exactly
    // where the old in-place pattern had already destroyed the prior intent.
    syncCalls = 0;
    fileHandlePrototype.sync = function crashAtIntentReplacement(...args) {
      syncCalls += 1;
      if (syncCalls === 1) throw new Error('PROBE_TEST_CRASH: crash at the replacement intent fsync');
      return originalSync.apply(this, args);
    };
    try {
      await assert.rejects(
        () => writers.driverAppend({ kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'success-result' }),
        /PROBE_TEST_CRASH/,
        'the simulated crash interrupted the intent replacement',
      );
    } finally { fileHandlePrototype.sync = originalSync; }
    // The OLD intent survives intact: the target was never truncated.
    assert.equal(await readFile(intentPath, 'utf8'), intentBefore, 'the prior intent survived the crashed replacement');
    // Reduction sees a VALID (unresolved) intent — never empty or partial.
    await assert.rejects(writers.reduce, /A recovery intent is unresolved/, 'the surviving intent is valid and still unresolved');
    // The resuming recovery re-executes: the events' uncommitted record (the
    // torn line) joins the sidecar behind a FRESH intent that binds the
    // extended content, and the run reduces cleanly.
    await writers.driverAppend({ kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'success-result' });
    const intentGone = await readFile(intentPath, 'utf8').then(() => false, (error) => error.code === 'ENOENT');
    assert.ok(intentGone, 'the superseded intent was resolved');
    const reduced = await writers.reduce();
    assert.equal(reduced.uncommittedCount, 0, 'the recovered run reduces cleanly');
    assert.equal(reduced.recovery.sidecarRecords, 2, 'the sidecar holds the batch and the torn record');
  });
});

test('direct evidence replaces a repair intent atomically so a crash cannot destroy it', async () => {
  await withDirectProbeRun('zcode-direct-observer-', async (run) => {
    const nonce = directRunNonce();
    const writers = makeDirectProbeWriters(run, nonce);
    const label = directLabel();
    const callNonce = directCallNonce();
    await writers.driverAppend({ kind: 'request-sent', probeLabel: label, tool: 'hold_direct', state: 'sent' });
    await writers.handlerAppend({ kind: 'handler-entered', probeLabel: label, callNonce, serverInstanceHash: directHash('fixture-instance') });
    const journalPath = join(run, 'events-seal.jsonl');
    const intentPath = join(run, 'repair-intent.json');
    // First repair: torn tail, repair, crash after the truncation — the
    // first repair intent stays unresolved.
    await writeFile(journalPath, `${await readFile(journalPath, 'utf8')}{"version":1,"runNonce":"${nonce}","recordCo`, { mode: 0o600 });
    const probeHandle = await open(run, 'r');
    const fileHandlePrototype = Object.getPrototypeOf(probeHandle);
    await probeHandle.close();
    const originalSync = fileHandlePrototype.sync;
    let syncCalls = 0;
    fileHandlePrototype.sync = function crashAfterJournalTruncation(...args) {
      syncCalls += 1;
      if (syncCalls === 5) throw new Error('PROBE_TEST_CRASH: crash after the journal truncation, before the anchoring commit');
      return originalSync.apply(this, args);
    };
    try {
      await assert.rejects(
        () => writers.driverAppend({ kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'error-result' }),
        /PROBE_TEST_CRASH/,
      );
    } finally { fileHandlePrototype.sync = originalSync; }
    const intentBefore = await readFile(intentPath, 'utf8');
    // Second repair: tear the journal again — the replacement of the intent
    // crashes at its own fsync (the FIRST fsync of the repairing append, the
    // replacement's temp file, before the rename), where the old in-place
    // pattern had already destroyed the prior durable intent.
    await writeFile(journalPath, `${await readFile(journalPath, 'utf8')}{"version":1,"runN`, { mode: 0o600 });
    syncCalls = 0;
    fileHandlePrototype.sync = function crashAtRepairIntentReplacement(...args) {
      syncCalls += 1;
      if (syncCalls === 1) throw new Error('PROBE_TEST_CRASH: crash at the replacement repair intent fsync');
      return originalSync.apply(this, args);
    };
    try {
      await assert.rejects(
        () => writers.driverAppend({ kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'error-result' }),
        /PROBE_TEST_CRASH/,
        'the simulated crash interrupted the repair intent replacement',
      );
    } finally { fileHandlePrototype.sync = originalSync; }
    // The OLD repair intent survives intact: never truncated in place.
    assert.equal(await readFile(intentPath, 'utf8'), intentBefore, 'the prior repair intent survived the crashed replacement');
    // A valid (unresolved) intent — never empty or partial.
    await assert.rejects(writers.reduce, /A repair intent is unresolved/, 'the surviving repair intent is valid and still unresolved');
    // A later append completes the repair and the run reduces. The crashed
    // attempt crashed at the intent replacement, BEFORE its own sidecar
    // work, so it preserved nothing (the torn tail was still in the
    // journal); the completing repair preserves that tail exactly once
    // alongside the first repair's fragment: two records.
    await writers.driverAppend({ kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'error-result' });
    const reduced = await writers.reduce();
    assert.equal(reduced.recovery.tornJournalFragments, 2, 'every preserved fragment stays visible in the reduction');
  });
});

// --- Codex gate round 19: a partially written torn-sidecar record must ---
// --- never strand repair. Regressions written FIRST: the partial tail is ---
// --- preserved as authenticated evidence, the sidecar is truncated to its ---
// --- last valid record boundary, and the repair stays resolvable. Round 32 ---
// --- reclassified UNBOUND torn-sidecar bytes as refusals (the repair may ---
// --- never authenticate bytes no anchor or intent binds), so the crashed ---
// --- partial write is simulated on the surface it can legitimately ---
// --- originate from: the partial-evidence sidecar's own atomic writes. ---

test('direct evidence recovers a partially written preservation record and keeps repair resolvable', async () => {
  await withDirectProbeRun('zcode-direct-observer-', async (run) => {
    const nonce = directRunNonce();
    const writers = makeDirectProbeWriters(run, nonce);
    const label = directLabel();
    const callNonce = directCallNonce();
    // First repair (bound base): the torn sidecar is anchored at one record.
    await withDirectProbeRepairFixture(run, nonce, writers, label, callNonce);
    const journalPath = join(run, 'events-seal.jsonl');
    const tornPath = join(run, 'journal-torn.jsonl');
    const partialPath = join(run, 'journal-torn-partial.jsonl');
    // Round 35 intent-first fault: the durable repair intent binds the
    // crashed preservation write's content BEFORE the partial file exists,
    // and the completing repair recomputes it from the torn source, verifies
    // it against the intent, writes it, and anchors it.
    const partialBytes = Buffer.from(`{"version":1,"runNonce":"${nonce}","frag`, 'utf8');
    await withDirectProbeIntentFirstPartialFixture(run, nonce, writers, label, callNonce, partialBytes.toString('utf8'));
    // The retry append recovers: the partial bytes are preserved as
    // authenticated evidence and the journal is repaired.
    // Every record in the torn sidecar is complete and authenticated — no
    // partial garbage rides along.
    const tornLines = (await readFile(tornPath, 'utf8')).trim().split('\n');
    assert.equal(tornLines.length, 2, 'the sidecar holds the anchored fragment plus the new fragment record');
    for (const line of tornLines) {
      const record = JSON.parse(line);
      const expectedMac = createHmac('sha256', Buffer.from(DIRECT_DRIVER_SECRET, 'utf8')).update(canonicalJson({ version: 1, runNonce: nonce, fragment: record.fragment })).digest('hex');
      assert.equal(record.tornMac, expectedMac, 'the sidecar record is complete and authenticated');
    }
    // The partial bytes are preserved verbatim as authenticated evidence.
    const partialEvidence = JSON.parse((await readFile(partialPath, 'utf8')).trim().split('\n').at(-1));
    assert.equal(partialEvidence.version, 1);
    assert.equal(partialEvidence.runNonce, nonce);
    assert.equal(partialEvidence.data, partialBytes.toString('base64'), 'the partial bytes are preserved verbatim');
    const expectedPartialMac = createHmac('sha256', Buffer.from(DIRECT_DRIVER_SECRET, 'utf8')).update(canonicalJson({ version: 1, runNonce: nonce, data: partialEvidence.data })).digest('hex');
    assert.equal(partialEvidence.partialMac, expectedPartialMac, 'the preserved partial bytes are authenticated');
    // The journal is repaired and the chain is contiguous.
    const journalLines = (await readFile(journalPath, 'utf8')).trim().split('\n');
    assert.deepEqual(journalLines.map((line) => JSON.parse(line).recordCount), [1, 2, 3, 4], 'the chain is contiguous across the repair');
    // Reduction succeeds with the partial-fragment evidence visible.
    const reduced = await writers.reduce();
    assert.equal(reduced.recovery.tornJournalFragments, 2);
    assert.equal(reduced.recovery.repairedPartialFragments, 1, 'the partial-fragment evidence is visible in the reduction');
    // Tampering the partial-evidence sidecar fails reduction closed.
    const partialEvidenceBytes = await readFile(partialPath);
    const tampered = Buffer.from(partialEvidenceBytes);
    tampered[0] = tampered[0] === 0x7b ? 0x7c : 0x7b;
    await writeFile(partialPath, tampered, { mode: 0o600 });
    await assert.rejects(writers.reduce, /PROBE_OWNER_INVALID/, 'an altered partial-evidence sidecar must fail the reduction closed');
    await writeFile(partialPath, partialEvidenceBytes, { mode: 0o600 });
    await writers.reduce();
  });
});

// --- Codex gate round 20: the partial-evidence sidecar gets the same ---
// --- durable anchor treatment as every other evidence sidecar, and its ---
// --- own writes recover from crashes. Regressions written FIRST.

test('direct evidence binds preserved partial fragments into the repair anchor and reduction', async () => {
  await withDirectProbeRun('zcode-direct-observer-', async (run) => {
    const nonce = directRunNonce();
    const writers = makeDirectProbeWriters(run, nonce);
    const label = directLabel();
    const callNonce = directCallNonce();
    // First repair (bound base): the torn sidecar is anchored at one record.
    await withDirectProbeRepairFixture(run, nonce, writers, label, callNonce);
    const journalPath = join(run, 'events-seal.jsonl');
    const partialPath = join(run, 'journal-torn-partial.jsonl');
    // Round 35 intent-first: the durable repair intent binds the crashed
    // preservation write's content BEFORE the partial file exists; the
    // completing repair recomputes it from the torn source, verifies it
    // against the intent, writes it, and anchors it.
    const partialBytes = Buffer.from(`{"version":1,"runNonce":"${nonce}","frag`, 'utf8');
    await withDirectProbeIntentFirstPartialFixture(run, nonce, writers, label, callNonce, partialBytes.toString('utf8'));
    // The retry append repairs and anchors the preserved partial fragments.
    const anchorLine = JSON.parse((await readFile(journalPath, 'utf8')).trim().split('\n')[3]);
    const partialFileBytes = await readFile(partialPath);
    assert.equal(anchorLine.partialLength, partialFileBytes.length, 'the repair anchor records the partial evidence length');
    assert.equal(anchorLine.partialDigest, createHash('sha256').update(partialFileBytes).digest('hex'), 'the repair anchor records the partial evidence digest');
    // Deleting the last preserved record fails the reduction closed...
    const partialLines = (await readFile(partialPath, 'utf8')).trim().split('\n');
    await writeFile(partialPath, `${partialLines.slice(0, -1).join('\n')}\n`, { mode: 0o600 });
    await assert.rejects(writers.reduce, /PROBE_OWNER_INVALID/, 'a deleted preserved partial record must fail the reduction closed');
    // ...and deleting the whole file fails the same way.
    await rm(partialPath);
    await assert.rejects(writers.reduce, /PROBE_OWNER_INVALID/, 'a deleted partial-evidence sidecar must fail the reduction closed');
    // Restored, the run reduces and the evidence stays visible.
    await writeFile(partialPath, `${partialLines.join('\n')}\n`, { mode: 0o600 });
    const reduced = await writers.reduce();
    assert.equal(reduced.recovery.repairedPartialFragments, 1, 'the partial evidence stays visible in the reduction');
  });
});

test('direct evidence refuses a partial-evidence rewrite whose existing bytes do not match the repair intent', async () => {
  await withDirectProbeRun('zcode-direct-observer-', async (run) => {
    const nonce = directRunNonce();
    const writers = makeDirectProbeWriters(run, nonce);
    const label = directLabel();
    const callNonce = directCallNonce();
    // First repair (bound base): the torn sidecar is anchored at one record.
    await withDirectProbeRepairFixture(run, nonce, writers, label, callNonce);
    const journalPath = join(run, 'events-seal.jsonl');
    const tornPath = join(run, 'journal-torn.jsonl');
    const partialPath = join(run, 'journal-torn-partial.jsonl');
    const anchorSidecarBytes = await readFile(tornPath);
    // A durable intent binds a NORMALIZED preservation record as the exact
    // partial content; the planted file holds the raw un-normalized bytes.
    const preservationTornBytes = Buffer.from(`{"version":1,"runNonce":"${nonce}","dat`, 'utf8');
    const preservationData = preservationTornBytes.toString('base64');
    const normalizedRecord = JSON.stringify({ version: 1, runNonce: nonce, data: preservationData, partialMac: createHmac('sha256', Buffer.from(DIRECT_DRIVER_SECRET, 'utf8')).update(canonicalJson({ version: 1, runNonce: nonce, data: preservationData })).digest('hex') });
    const intentPayload = {
      version: 1,
      runNonce: nonce,
      tornValidLength: 0,
      tornValidDigest: createHash('sha256').update(Buffer.alloc(0)).digest('hex'),
      tornTailLength: 0,
      tornTailDigest: createHash('sha256').update(Buffer.alloc(0)).digest('hex'),
      tornFragmentCount: 1,
      tornDigest: createHash('sha256').update(anchorSidecarBytes).digest('hex'),
      tornLength: anchorSidecarBytes.length,
      partialDigest: createHash('sha256').update(Buffer.from(`${normalizedRecord}\n`, 'utf8')).digest('hex'),
      partialLength: normalizedRecord.length + 1,
    };
    await writeFile(join(run, 'repair-intent.json'), `${JSON.stringify({ ...intentPayload, repairIntentMac: createHmac('sha256', Buffer.from(DIRECT_DRIVER_SECRET, 'utf8')).update(canonicalJson(intentPayload)).digest('hex') })}\n`, { mode: 0o600 });
    await writeFile(partialPath, preservationTornBytes, { mode: 0o600 });
    // Tear the journal so the append takes the repair path: the intent binds
    // the normalized bytes, the file holds different bytes — the rewrite
    // must refuse WITHOUT writing.
    const journalWithTear = Buffer.from(`${(await readFile(journalPath, 'utf8'))}{"version":1,"runNonce":"${nonce}","settle`, 'utf8');
    await writeFile(journalPath, journalWithTear, { mode: 0o600 });
    await assert.rejects(
      () => writers.driverAppend({ kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'error-result' }),
      (error) => error.code === 'PROBE_OWNER_INVALID',
      'a partial-evidence rewrite over bytes that do not match the repair intent must refuse closed',
    );
    assert.deepEqual(await readFile(partialPath), preservationTornBytes, 'the refused repair never rewrote the mismatched file');
    assert.deepEqual(await readFile(journalPath), journalWithTear, 'the journal was left untouched behind the refusal');
    // Planting the exact bound content: the repair completes and reduces.
    await writeFile(partialPath, Buffer.from(`${normalizedRecord}\n`, 'utf8'), { mode: 0o600 });
    await writers.driverAppend({ kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'error-result' });
    const reduced = await writers.reduce();
    assert.equal(reduced.recovery.repairedPartialFragments, 1, 'the bound preservation record stays visible in the reduction');
    assert.equal(reduced.uncommittedCount, 0, 'the run reduces cleanly');
  });
});

// --- Codex gate round 21: a repeat repair must verify the intent-bound ---
// --- partial evidence before any intent replacement, the partial-evidence ---
// --- move must be durably bound before the torn sidecar is truncated, and ---
// --- torn-line normalization must keep complete (anchored) records first. ---
// --- Regressions written FIRST.

test('direct evidence fails closed when the anchored partial evidence is deleted', async () => {
  await withDirectProbeRun('zcode-direct-observer-', async (run) => {
    const nonce = directRunNonce();
    const writers = makeDirectProbeWriters(run, nonce);
    const label = directLabel();
    const callNonce = directCallNonce();
    // Round 35 intent-first: the durable repair intent binds the crashed
    // preservation write's content BEFORE the partial file exists; the
    // completing repair recomputes, verifies, writes, and anchors it.
    // First repair (bound base): the torn sidecar is anchored at one record.
    await withDirectProbeRepairFixture(run, nonce, writers, label, callNonce);
    const partialText = `{"version":1,"runNonce":"${nonce}","frag`;
    await withDirectProbeIntentFirstPartialFixture(run, nonce, writers, label, callNonce, partialText);
    const partialPath = join(run, 'journal-torn-partial.jsonl');
    const baseline = await writers.reduce();
    assert.equal(baseline.recovery.repairedPartialFragments, 1, 'the anchored partial evidence is visible');
    // Deleting the anchored partial evidence: the last committed anchor
    // still binds those exact bytes, so every later append and the reduction
    // refuse — the deletion can never be laundered.
    const anchoredPartialBytes = await readFile(partialPath);
    await rm(partialPath);
    await assert.rejects(
      () => writers.driverAppend({ kind: 'request-sent', probeLabel: directLabel(), tool: 'hold_direct', state: 'sent' }),
      (error) => error.code === 'PROBE_OWNER_INVALID',
      'an append over deleted anchored partial evidence must refuse closed',
    );
    await assert.rejects(writers.reduce, /PROBE_OWNER_INVALID/, 'the deleted partial evidence stays irreducible');
    // Restoring the anchored bytes: the run reduces cleanly again.
    await writeFile(partialPath, anchoredPartialBytes, { mode: 0o600 });
    await writers.driverAppend({ kind: 'request-sent', probeLabel: directLabel(), tool: 'hold_direct', state: 'sent' });
    const reduced = await writers.reduce();
    assert.equal(reduced.uncommittedCount, 0, 'the run reduces cleanly once the anchored evidence is restored');
    assert.equal(reduced.recovery.repairedPartialFragments, 1, 'the anchored partial evidence stays visible');
  });
});

test('direct evidence refuses a repair when the partial sidecar does not match its repair intent', async () => {
  await withDirectProbeRun('zcode-direct-observer-', async (run) => {
    const nonce = directRunNonce();
    const writers = makeDirectProbeWriters(run, nonce);
    const label = directLabel();
    const callNonce = directCallNonce();
    // Round 35 intent-first base: anchored partial evidence, intent resolved.
    // First repair (bound base): the torn sidecar is anchored at one record.
    await withDirectProbeRepairFixture(run, nonce, writers, label, callNonce);
    const journalPath = join(run, 'events-seal.jsonl');
    const tornPath = join(run, 'journal-torn.jsonl');
    const partialPath = join(run, 'journal-torn-partial.jsonl');
    const partialText = `{"version":1,"runNonce":"${nonce}","frag`;
    await withDirectProbeIntentFirstPartialFixture(run, nonce, writers, label, callNonce, partialText);
    const anchoredPartialBytes = await readFile(partialPath);
    const boundTornBytes = await readFile(tornPath);
    // A new journal tear and a durable intent binding the CURRENT bound
    // state — torn sidecar and partial content both.
    const newTear = `{"version":1,"runNonce":"${nonce}","settle`;
    const intentPayload = {
      version: 1,
      runNonce: nonce,
      tornValidLength: boundTornBytes.length,
      tornValidDigest: createHash('sha256').update(boundTornBytes).digest('hex'),
      tornTailLength: 0,
      tornTailDigest: createHash('sha256').update(Buffer.alloc(0)).digest('hex'),
      tornFragmentCount: 2,
      tornDigest: createHash('sha256').update(boundTornBytes).digest('hex'),
      tornLength: boundTornBytes.length,
      partialDigest: createHash('sha256').update(anchoredPartialBytes).digest('hex'),
      partialLength: anchoredPartialBytes.length,
    };
    await writeFile(join(run, 'repair-intent.json'), `${JSON.stringify({ ...intentPayload, repairIntentMac: createHmac('sha256', Buffer.from(DIRECT_DRIVER_SECRET, 'utf8')).update(canonicalJson(intentPayload)).digest('hex') })}\n`, { mode: 0o600 });
    await writeFile(journalPath, `${await readFile(journalPath, 'utf8')}${newTear}`, { mode: 0o600 });
    // Garble the partial sidecar: the resuming repair must refuse WITHOUT
    // writing — the intent binds the exact bytes, and the garbled file no
    // longer matches.
    const journalWithTear = await readFile(journalPath);
    const garbled = Buffer.from('{"broken-preservation-garbage"\n', 'utf8');
    await writeFile(partialPath, garbled, { mode: 0o600 });
    await assert.rejects(
      () => writers.driverAppend({ kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'error-result' }),
      (error) => error.code === 'PROBE_OWNER_INVALID',
      'a repair over a garbled partial sidecar bound by an exact-content intent must refuse closed',
    );
    assert.deepEqual(await readFile(partialPath), garbled, 'the refused repair never touched the garbled file');
    assert.deepEqual(await readFile(journalPath), journalWithTear, 'the journal was left untouched behind the refusal');
    // Restoring the bound bytes: the repair completes and reduces.
    await writeFile(partialPath, anchoredPartialBytes, { mode: 0o600 });
    await writers.driverAppend({ kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'error-result' });
    const reduced = await writers.reduce();
    assert.equal(reduced.uncommittedCount, 0, 'the run reduces cleanly once the bound bytes are restored');
    assert.equal(reduced.recovery.repairedPartialFragments, 1, 'the bound preservation record stays visible');
  });
});
test('direct evidence refuses a repair over a suffix injected beyond the anchored partial evidence', async () => {
  await withDirectProbeRun('zcode-direct-observer-', async (run) => {
    const nonce = directRunNonce();
    const writers = makeDirectProbeWriters(run, nonce);
    const label = directLabel();
    const callNonce = directCallNonce();
    // Round 35 intent-first base: anchored partial evidence (one preservation
    // record), torn sidecar at two fragment records, intent resolved.
    const partialText = `{"version":1,"runNonce":"${nonce}","frag`;
    await withDirectProbeRepairFixture(run, nonce, writers, label, callNonce);
    const journalPath = join(run, 'events-seal.jsonl');
    const partialPath = join(run, 'journal-torn-partial.jsonl');
    await withDirectProbeIntentFirstPartialFixture(run, nonce, writers, label, callNonce, partialText);
    const anchoredPartialBytes = await readFile(partialPath);
    const baseline = await writers.reduce();
    assert.equal(baseline.recovery.repairedPartialFragments, 1, 'the baseline anchors exactly the preservation record');
    // Inject a suffix beyond the anchored length, then force a later journal
    // repair: the repair must refuse WITHOUT normalizing the suffix into
    // MACed evidence.
    const injectedSuffix = '{"unbound-partial-suffix';
    await writeFile(partialPath, Buffer.concat([anchoredPartialBytes, Buffer.from(injectedSuffix, 'utf8')]), { mode: 0o600 });
    const eventsBefore = await readFile(join(run, 'events.jsonl'));
    const journalWithTear = Buffer.from(`${(await readFile(journalPath, 'utf8'))}{"version":1,"runNonce":"${nonce}","recordCo`, 'utf8');
    await writeFile(journalPath, journalWithTear, { mode: 0o600 });
    await assert.rejects(
      () => writers.driverAppend({ kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'error-result' }),
      (error) => error.code === 'PROBE_OWNER_INVALID',
      'a repair over an unbound partial-evidence suffix must refuse closed',
    );
    // Nothing was written: the suffix was never normalized or MACed, and the
    // journal tail is untouched.
    assert.deepEqual(await readFile(partialPath), Buffer.concat([anchoredPartialBytes, Buffer.from(injectedSuffix, 'utf8')]), 'the refused repair never touched the altered partial sidecar');
    assert.deepEqual(await readFile(journalPath), journalWithTear, 'the journal was left untouched behind the refusal');
    await assert.rejects(() => readFile(join(run, 'repair-intent.json'), 'utf8'), (error) => error.code === 'ENOENT', 'no repair intent was written behind the refusal');
    assert.deepEqual(await readFile(join(run, 'events.jsonl')), eventsBefore, 'the event log was left untouched behind the refusal');
    await assert.rejects(writers.reduce, /PROBE_OWNER_INVALID/, 'the altered partial sidecar stays irreducible');
    // Restoring the anchored bytes: the pending repair completes and the run
    // reduces.
    await writeFile(partialPath, anchoredPartialBytes, { mode: 0o600 });
    await writers.driverAppend({ kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'error-result' });
    const reduced = await writers.reduce();
    assert.equal(reduced.uncommittedCount, 0, 'the pending repair completes once the anchored bytes are restored');
    assert.equal(reduced.recovery.repairedPartialFragments, 1, 'the anchored preservation record stays visible');
    assert.equal(reduced.recovery.tornJournalFragments, 3, 'the third fragment joins the anchored sidecar');
  });
});
// --- Codex gate round 22: an unresolved repair intent with a bound torn ---
// --- tail accepts ONLY the legal sidecar states — the exact bound ---
// --- pre-truncation bytes, the exact valid prefix right after truncation, ---
// --- or the verified final record state. A shortened or extended sidecar ---
// --- must refuse the repair instead of letting the append commit the ---
// --- intent's expected torn digest over absent bytes. Regressions written ---
// --- FIRST.

test('direct evidence refuses a repeat repair over a shortened intent-bound torn sidecar', async () => {
  await withDirectProbeRun('zcode-direct-observer-', async (run) => {
    const nonce = directRunNonce();
    const writers = makeDirectProbeWriters(run, nonce);
    const label = directLabel();
    const callNonce = directCallNonce();
    // First repair (bound base): the torn sidecar is anchored at one record.
    await withDirectProbeRepairFixture(run, nonce, writers, label, callNonce);
    const journalPath = join(run, 'events-seal.jsonl');
    const tornPath = join(run, 'journal-torn.jsonl');
    const intentPath = join(run, 'repair-intent.json');
    const tornJunk = `{"version":1,"runNonce":"${nonce}","recordCo`;
    await writeFile(journalPath, `${await readFile(journalPath, 'utf8')}${tornJunk}`, { mode: 0o600 });
    // Crash at the fsync AFTER the sidecar work and journal truncation, but
    // before the record write: the intent is durable and the sidecar sits in
    // its exact bound FINAL state.
    const probeHandle = await open(run, 'r');
    const fileHandlePrototype = Object.getPrototypeOf(probeHandle);
    await probeHandle.close();
    const originalSync = fileHandlePrototype.sync;
    let syncCalls = 0;
    fileHandlePrototype.sync = function crashAfterSidecarWorkBeforeRecord(...args) {
      syncCalls += 1;
      if (syncCalls === 5) throw new Error('PROBE_TEST_CRASH: crash after the sidecar work, before the record write');
      return originalSync.apply(this, args);
    };
    try {
      await assert.rejects(
        () => writers.driverAppend({ kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'error-result' }),
        /PROBE_TEST_CRASH/,
      );
    } finally { fileHandlePrototype.sync = originalSync; }
    const intentBefore = await readFile(intentPath, 'utf8');
    const journalAfterCrash = await readFile(journalPath, 'utf8');
    const boundBytes = await readFile(tornPath);
    // Tamper: SHORTEN the intent-bound sidecar (some of its bytes removed).
    await writeFile(tornPath, boundBytes.subarray(0, 20), { mode: 0o600 });
    // The repeat repair must REFUSE: a shortened sidecar is no legal state
    // of the unresolved intent, and committing its expected torn digest
    // over the absent bytes would create an unverifiable anchor.
    await assert.rejects(
      () => writers.driverAppend({ kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'success-result' }),
      /PROBE_OWNER_INVALID/,
      'a shortened intent-bound torn sidecar must refuse the repair',
    );
    assert.equal(await readFile(intentPath, 'utf8'), intentBefore, 'the intent was not replaced');
    assert.equal(await readFile(journalPath, 'utf8'), journalAfterCrash, 'the journal was untouched by the refused repair');
    await assert.rejects(writers.reduce, /PROBE_OWNER_INVALID/, 'the run still fails reduction closed');
    // Restoring the exact bound bytes: the repair resumes and resolves.
    await writeFile(tornPath, boundBytes, { mode: 0o600 });
    await writers.driverAppend({ kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'success-result' });
    const intentGone = await readFile(intentPath, 'utf8').then(() => false, (error) => error.code === 'ENOENT');
    assert.ok(intentGone, 'the resolved repair intent was removed');
    const reduced = await writers.reduce();
    assert.equal(reduced.uncommittedCount, 0, 'the resumed repair resolves cleanly');
  });
});

test('direct evidence refuses a repeat repair over an extended intent-bound torn sidecar', async () => {
  await withDirectProbeRun('zcode-direct-observer-', async (run) => {
    const nonce = directRunNonce();
    const writers = makeDirectProbeWriters(run, nonce);
    const label = directLabel();
    const callNonce = directCallNonce();
    // First repair (bound base): the torn sidecar is anchored at one record.
    await withDirectProbeRepairFixture(run, nonce, writers, label, callNonce);
    const journalPath = join(run, 'events-seal.jsonl');
    const tornPath = join(run, 'journal-torn.jsonl');
    const intentPath = join(run, 'repair-intent.json');
    // Crash at the fsync AFTER the sidecar work and journal truncation, but
    // before the record write: the intent is durable and the sidecar sits in
    // its exact bound FINAL state.
    await writeFile(journalPath, `${await readFile(journalPath, 'utf8')}{"version":1,"runNonce":"${nonce}","recordCo`, { mode: 0o600 });
    const probeHandle = await open(run, 'r');
    const fileHandlePrototype = Object.getPrototypeOf(probeHandle);
    await probeHandle.close();
    const originalSync = fileHandlePrototype.sync;
    let syncCalls = 0;
    fileHandlePrototype.sync = function crashAfterSidecarWorkBeforeRecord(...args) {
      syncCalls += 1;
      if (syncCalls === 5) throw new Error('PROBE_TEST_CRASH: crash after the sidecar work, before the record write');
      return originalSync.apply(this, args);
    };
    try {
      await assert.rejects(
        () => writers.driverAppend({ kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'error-result' }),
        /PROBE_TEST_CRASH/,
      );
    } finally { fileHandlePrototype.sync = originalSync; }
    const intentBefore = await readFile(intentPath, 'utf8');
    const journalAfterCrash = await readFile(journalPath, 'utf8');
    const boundBytes = await readFile(tornPath);
    // Tamper: EXTEND the sidecar beyond the bound state (extra bytes
    // appended after it).
    await writeFile(tornPath, Buffer.concat([boundBytes, Buffer.from(',"extra-tail-bytes"', 'utf8')]), { mode: 0o600 });
    // The repeat repair must REFUSE: an extended sidecar is no legal state
    // of the unresolved intent either.
    await assert.rejects(
      () => writers.driverAppend({ kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'success-result' }),
      /PROBE_OWNER_INVALID/,
      'an extended intent-bound torn sidecar must refuse the repair',
    );
    assert.equal(await readFile(intentPath, 'utf8'), intentBefore, 'the intent was not replaced');
    assert.equal(await readFile(journalPath, 'utf8'), journalAfterCrash, 'the journal was untouched by the refused repair');
    await assert.rejects(writers.reduce, /PROBE_OWNER_INVALID/, 'the run still fails reduction closed');
    // Restoring the exact bound bytes: the repair resumes and resolves.
    await writeFile(tornPath, boundBytes, { mode: 0o600 });
    await writers.driverAppend({ kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'success-result' });
    const intentGone = await readFile(intentPath, 'utf8').then(() => false, (error) => error.code === 'ENOENT');
    assert.ok(intentGone, 'the resolved repair intent was removed');
    const reduced = await writers.reduce();
    assert.equal(reduced.uncommittedCount, 0, 'the resumed repair resolves cleanly');
  });
});

// --- Codex gate round 23: an unterminated (newline-less) sidecar record is ---
// --- a torn tail, never a valid prefix record, and the repair-intent ---
// --- gate verifies the bound PREFIX digest in the pre-truncation state. ---
// --- Regressions written FIRST.

test('direct evidence refuses a repair over an unterminated unbound sidecar record', async () => {
  await withDirectProbeRun('zcode-direct-observer-', async (run) => {
    const nonce = directRunNonce();
    const writers = makeDirectProbeWriters(run, nonce);
    const label = directLabel();
    const callNonce = directCallNonce();
    await writers.driverAppend({ kind: 'request-sent', probeLabel: label, tool: 'hold_direct', state: 'sent' });
    await writers.handlerAppend({ kind: 'handler-entered', probeLabel: label, callNonce, serverInstanceHash: directHash('fixture-instance') });
    const journalPath = join(run, 'events-seal.jsonl');
    const tornPath = join(run, 'journal-torn.jsonl');
    const partialPath = join(run, 'journal-torn-partial.jsonl');
    const intentPath = join(run, 'repair-intent.json');
    // Torn journal tail: a repair is pending. An unterminated record — even
    // a COMPLETE, AUTHENTICATED one — sits on the sidecar UNBOUND (no anchor
    // or intent covers its bytes), so since round 32 the repair must refuse
    // it instead of preserving it as evidence.
    const unterminatedFragment = `{"version":1,"runNonce":"${nonce}","recordCo`;
    const unterminatedMac = createHmac('sha256', Buffer.from(DIRECT_DRIVER_SECRET, 'utf8')).update(canonicalJson({ version: 1, runNonce: nonce, fragment: unterminatedFragment })).digest('hex');
    const unterminatedLine = JSON.stringify({ version: 1, runNonce: nonce, fragment: unterminatedFragment, tornMac: unterminatedMac });
    await writeFile(tornPath, unterminatedLine, { mode: 0o600 });
    const eventsBefore = await readFile(join(run, 'events.jsonl'));
    const tornJunk = `{"version":1,"runNonce":"${nonce}","settle`;
    const journalWithTear = Buffer.from(`${(await readFile(journalPath, 'utf8'))}${tornJunk}`, 'utf8');
    await writeFile(journalPath, journalWithTear, { mode: 0o600 });
    await assert.rejects(
      () => writers.driverAppend({ kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'error-result' }),
      (error) => error.code === 'PROBE_OWNER_INVALID',
      'a repair over an unterminated unbound sidecar record must refuse closed',
    );
    // The refusal wrote NOTHING: the sidecar bytes were never preserved into
    // partial evidence, no intent or anchor landed.
    assert.deepEqual(await readFile(tornPath), Buffer.from(unterminatedLine, 'utf8'), 'the refused repair never touched the sidecar');
    await assert.rejects(() => readFile(intentPath, 'utf8'), (error) => error.code === 'ENOENT', 'no repair intent was written behind the refusal');
    await assert.rejects(() => readFile(partialPath, 'utf8'), (error) => error.code === 'ENOENT', 'no partial-evidence record was written behind the refusal');
    assert.deepEqual(await readFile(journalPath), journalWithTear, 'the journal was left untouched behind the refusal');
    assert.deepEqual(await readFile(join(run, 'events.jsonl')), eventsBefore, 'the event log was left untouched behind the refusal');
    // The unbound bytes can never be laundered: reduction still refuses.
    await assert.rejects(writers.reduce, /PROBE_OWNER_INVALID/, 'the unbound sidecar stays irreducible');
  });
});

test('direct evidence verifies the bound digest of a repair intent over its exact sidecar state', async () => {
  await withDirectProbeRun('zcode-direct-observer-', async (run) => {
    const nonce = directRunNonce();
    const writers = makeDirectProbeWriters(run, nonce);
    const label = directLabel();
    const callNonce = directCallNonce();
    // First repair (bound base): the torn sidecar is anchored at one record.
    await withDirectProbeRepairFixture(run, nonce, writers, label, callNonce);
    const journalPath = join(run, 'events-seal.jsonl');
    const tornPath = join(run, 'journal-torn.jsonl');
    const intentPath = join(run, 'repair-intent.json');
    // Tear the journal, then crash at the fsync AFTER the sidecar work and
    // journal truncation, but before the record write: the intent is durable
    // and the sidecar sits in its exact bound FINAL state.
    const tornJunk = `{"version":1,"runNonce":"${nonce}","settle`;
    await writeFile(journalPath, `${await readFile(journalPath, 'utf8')}${tornJunk}`, { mode: 0o600 });
    const probeHandle = await open(run, 'r');
    const fileHandlePrototype = Object.getPrototypeOf(probeHandle);
    await probeHandle.close();
    const originalSync = fileHandlePrototype.sync;
    let syncCalls = 0;
    fileHandlePrototype.sync = function crashAfterSidecarWorkBeforeRecord(...args) {
      syncCalls += 1;
      if (syncCalls === 5) throw new Error('PROBE_TEST_CRASH: crash after the sidecar work, before the record write');
      return originalSync.apply(this, args);
    };
    try {
      await assert.rejects(
        () => writers.driverAppend({ kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'error-result' }),
        /PROBE_TEST_CRASH/,
      );
    } finally { fileHandlePrototype.sync = originalSync; }
    const intentBefore = await readFile(intentPath, 'utf8');
    const journalAfterCrash = await readFile(journalPath, 'utf8');
    const boundBytes = await readFile(tornPath);
    // Attack: SAME-LENGTH mutation of the bound sidecar bytes (the first
    // byte of the intent-appended fragment record), so the length still
    // matches the intent's bound final state.
    const mutated = Buffer.from(boundBytes);
    mutated[boundBytes.indexOf(0x0a) + 1] = mutated[boundBytes.indexOf(0x0a) + 1] === 0x7b ? 0x7c : 0x7b;
    await writeFile(tornPath, mutated, { mode: 0o600 });
    // The repeat repair must REFUSE: the bound state is legal only when the
    // bytes still match their recorded digest.
    await assert.rejects(
      () => writers.driverAppend({ kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'success-result' }),
      /PROBE_OWNER_INVALID/,
      'a same-length mutated sidecar under an unresolved intent must refuse the repair',
    );
    assert.equal(await readFile(intentPath, 'utf8'), intentBefore, 'the intent was not replaced');
    assert.equal(await readFile(journalPath, 'utf8'), journalAfterCrash, 'the journal was untouched by the refused repair');
    await assert.rejects(writers.reduce, /PROBE_OWNER_INVALID/, 'the run still fails reduction closed');
    // Restoring the exact bound bytes: the repair resumes and resolves.
    await writeFile(tornPath, boundBytes, { mode: 0o600 });
    await writers.driverAppend({ kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'success-result' });
    const intentGone = await readFile(intentPath, 'utf8').then(() => false, (error) => error.code === 'ENOENT');
    assert.ok(intentGone, 'the resolved repair intent was removed');
    const reduced = await writers.reduce();
    assert.equal(reduced.uncommittedCount, 0, 'the run reduces cleanly');
    assert.equal(reduced.recovery.tornJournalFragments, 2, 'both fragment records stay visible in the reduction');
  });
});

// --- Codex gate round 24: the handler-owner registration is fsynced — file
// --- bytes AND directory entry — BEFORE the server can append anything, so
// --- a power loss can never leave a missing or partial registration behind
// --- committed handler evidence (reduction would reject that evidence with
// --- PROBE_OWNER_INVALID). Crash-order regression: the first append's sync
// --- sequence must BEGIN with the owner-file and directory fsyncs.

test('direct evidence fsyncs handler ownership before the server can append anything', async () => {
  const lineCount = (text) => (text === null || text.trim() === '' ? 0 : text.trim().split('\n').length);
  const readOrMissing = async (path) => readFile(path, 'utf8').then((value) => value, (error) => (error.code === 'ENOENT' ? null : Promise.reject(error)));
  const absent = async (path) => (await readOrMissing(path)) === null;
  const firstAppendCrashScenario = async (crashAtSync, expectDurableState) => {
    await withDirectProbeRun('zcode-direct-observer-', async (run) => {
      const nonce = directRunNonce();
      const writers = makeDirectProbeWriters(run, nonce);
      const label = directLabel();
      const callNonce = directCallNonce();
      // The driver-side prerequisite lands BEFORE the spy: the crash-order
      // observation below counts only the SERVER append's fsyncs.
      await writers.driverAppend({ kind: 'request-sent', probeLabel: label, tool: 'hold_direct', state: 'sent' });
      const probeHandle = await open(run, 'r');
      const fileHandlePrototype = Object.getPrototypeOf(probeHandle);
      await probeHandle.close();
      const originalSync = fileHandlePrototype.sync;
      let syncCalls = 0;
      fileHandlePrototype.sync = function crashAtNthSyncOfFirstServerAppend(...args) {
        syncCalls += 1;
        if (syncCalls === crashAtSync) throw new Error(`PROBE_TEST_CRASH: crash at the first server append's fsync #${crashAtSync}`);
        return originalSync.apply(this, args);
      };
      try {
        await assert.rejects(
          () => writers.handlerAppend({ kind: 'handler-entered', probeLabel: label, callNonce, serverInstanceHash: directHash('fixture-instance') }),
          /PROBE_TEST_CRASH/,
          `the simulated crash interrupted the first server append at fsync #${crashAtSync}`,
        );
      } finally { fileHandlePrototype.sync = originalSync; }
      // Observe exactly what became durable behind the crash.
      await expectDurableState(run, nonce);
      // The next append completes (re-executing the durability first) and
      // the run reduces cleanly.
      await writers.handlerAppend({ kind: 'handler-entered', probeLabel: label, callNonce, serverInstanceHash: directHash('fixture-instance') });
      const reduced = await writers.reduce();
      assert.equal(reduced.uncommittedCount, 0, 'the run reduces cleanly after the crash');
    });
  };

  // fsync #1: the owner registration's own fsync — NOTHING from the server
  // append (no event record, no seal) may be durable behind it.
  await firstAppendCrashScenario(1, async (run, nonce) => {
    assert.equal(lineCount(await readOrMissing(join(run, 'events.jsonl'))), 1, 'no event record was written behind the non-durable owner file');
    assert.equal(lineCount(await readOrMissing(join(run, 'events-seal.jsonl'))), 1, 'no seal was committed behind the non-durable owner file');
    assert.ok(await absent(join(run, 'events-uncommitted.jsonl')), 'no recovery sidecar was created');
    const owner = JSON.parse(await readFile(join(run, 'handler-owner.json'), 'utf8'));
    assert.equal(owner.runNonce, nonce, 'the owner registration itself is complete on disk');
  });

  // fsync #2: the registration's DIRECTORY entry fsync — still nothing from
  // the server append.
  await firstAppendCrashScenario(2, async (run) => {
    assert.equal(lineCount(await readOrMissing(join(run, 'events.jsonl'))), 1, 'no event record was written behind the owner durability boundary');
    assert.equal(lineCount(await readOrMissing(join(run, 'events-seal.jsonl'))), 1, 'no seal was committed behind the owner durability boundary');
  });

  // fsync #3: only now the event record's own fsync — the record bytes are
  // written but uncommitted, proving the durability fsyncs strictly precede
  // the record write's durability.
  await firstAppendCrashScenario(3, async (run) => {
    assert.equal(lineCount(await readOrMissing(join(run, 'events.jsonl'))), 2, 'the record fsync follows the owner durability fsyncs');
    assert.equal(lineCount(await readOrMissing(join(run, 'events-seal.jsonl'))), 1, 'the seal has not been committed yet');
  });
});

// --- Codex gate round 25: the owner gate FAILS CLOSED when the directory
// --- fsync cannot complete. syncRunDirectory soft-fails on EPERM, EACCES,
// --- EINVAL, and ENOTSUP; the owner gate must treat every non-success as
// --- fatal (re-armed, nothing appended) instead of committing handler
// --- evidence behind a non-durable registration entry.

test('direct evidence fails closed when the owner directory cannot be synced', async () => {
  for (const code of ['EPERM', 'EACCES', 'EINVAL', 'ENOTSUP']) {
    await withDirectProbeRun('zcode-direct-observer-', async (run) => {
      const nonce = directRunNonce();
      const writers = makeDirectProbeWriters(run, nonce);
      const label = directLabel();
      const callNonce = directCallNonce();
      await writers.driverAppend({ kind: 'request-sent', probeLabel: label, tool: 'hold_direct', state: 'sent' });
      // The second fsync of the first server append is the owner gate's
      // directory fsync (established by the round 24 crash-order test):
      // inject each swallowed code exactly there.
      const probeHandle = await open(run, 'r');
      const fileHandlePrototype = Object.getPrototypeOf(probeHandle);
      await probeHandle.close();
      const originalSync = fileHandlePrototype.sync;
      let syncCalls = 0;
      const injected = new Error(`PROBE_TEST_INJECTED: ${code} at the owner directory fsync`);
      injected.code = code;
      fileHandlePrototype.sync = function injectOwnerDirectorySyncFailure(...args) {
        syncCalls += 1;
        if (syncCalls === 2) throw injected;
        return originalSync.apply(this, args);
      };
      try {
        await assert.rejects(
          () => writers.handlerAppend({ kind: 'handler-entered', probeLabel: label, callNonce, serverInstanceHash: directHash('fixture-instance') }),
          (error) => error.code === 'PROBE_OWNER_INVALID',
          `${code} at the owner directory fsync must fail the gate closed`,
        );
      } finally { fileHandlePrototype.sync = originalSync; }
      // Nothing was appended: the handler record and its seal are absent.
      const events = await readFile(join(run, 'events.jsonl'), 'utf8');
      assert.equal(events.trim().split('\n').length, 1, 'no handler record was appended behind the failed directory sync');
      const journal = await readFile(join(run, 'events-seal.jsonl'), 'utf8');
      assert.equal(journal.trim().split('\n').length, 1, 'no seal was committed behind the failed directory sync');
      // Error cleared: the re-armed gate proceeds and the run reduces.
      await writers.handlerAppend({ kind: 'handler-entered', probeLabel: label, callNonce, serverInstanceHash: directHash('fixture-instance') });
      const reduced = await writers.reduce();
      assert.equal(reduced.uncommittedCount, 0, 'the run reduces cleanly once the directory syncs');
    });
  }
});

// --- Codex gate round 26: the PRE-TRUNCATION intent writes fail closed ---
// --- when the directory fsync soft-fails. Recovery and repair truncate ---
// --- their SOURCE (event log / seal journal / torn sidecar) only behind a ---
// --- durably linked intent; a swallowed EPERM/EACCES/EINVAL/ENOTSUP at the ---
// --- intent's directory fsync must refuse the write (source intact, run ---
// --- still recoverable) instead of letting the truncation proceed.

test('direct evidence fails closed when the recovery intent directory fsync cannot complete', async () => {
  for (const code of ['EPERM', 'EACCES', 'EINVAL', 'ENOTSUP']) {
    await withDirectProbeRun('zcode-direct-observer-', async (run) => {
      const nonce = directRunNonce();
      const writers = makeDirectProbeWriters(run, nonce);
      const { label, callNonce } = await withDirectProbeRecoveryFixture(run, nonce, writers);
      const eventsPath = join(run, 'events.jsonl');
      const journalPath = join(run, 'events-seal.jsonl');
      const sidecarPath = join(run, 'events-uncommitted.jsonl');
      const eventsBefore = await readFile(eventsPath);
      const journalBefore = await readFile(journalPath);
      // The recovering append's second fsync is the recovery intent's
      // directory fsync (round 36 ordering: the intent is written first —
      // temp fsync, then its directory entry — before the sidecar write).
      const probeHandle = await open(run, 'r');
      const fileHandlePrototype = Object.getPrototypeOf(probeHandle);
      await probeHandle.close();
      const originalSync = fileHandlePrototype.sync;
      let syncCalls = 0;
      const injected = new Error(`PROBE_TEST_INJECTED: ${code} at the recovery intent directory fsync`);
      injected.code = code;
      fileHandlePrototype.sync = function injectRecoveryIntentDirectorySyncFailure(...args) {
        syncCalls += 1;
        if (syncCalls === 2) throw injected;
        return originalSync.apply(this, args);
      };
      try {
        await assert.rejects(
          () => writers.driverAppend({ kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'error-result' }),
          (error) => error.code === 'PROBE_OWNER_INVALID',
          `${code} at the recovery intent directory fsync must fail the recovery closed`,
        );
      } finally { fileHandlePrototype.sync = originalSync; }
      // The truncation never happened: the event log (with its uncommitted
      // records) and the journal are byte-identical.
      assert.deepEqual(await readFile(eventsPath), eventsBefore, 'the event log was not truncated behind the failed directory fsync');
      assert.deepEqual(await readFile(journalPath), journalBefore, 'the journal was not extended behind the failed directory fsync');
      // The failed intent write rolled back BEFORE the sidecar write ever
      // ran (round 36 ordering: the intent precedes the sidecar), so nothing
      // unbound was created. The retry recomputes the sidecar bytes from the
      // event source, verifies them against the fresh intent, writes them,
      // truncates, and commits — the recovered evidence is never lost.
      await writers.driverAppend({ kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'error-result' });
      assert.match(await readFile(sidecarPath, 'utf8'), /handler-settled/, 'the sidecar preserved the recovered record');
      const intentGone = await readFile(join(run, 'recovery-intent.json'), 'utf8').then(() => false, (error) => error.code === 'ENOENT');
      assert.ok(intentGone, 'the resolved recovery intent was removed');
      const reduced = await writers.reduce();
      assert.equal(reduced.uncommittedCount, 0, 'the run reduces cleanly once the directory syncs');
      assert.equal(reduced.recovery.sidecarRecords, 1, 'the recovered record stays visible in the reduction');
    });
  }
});

test('direct evidence fails closed when the repair intent directory fsync cannot complete', async () => {
  for (const code of ['EPERM', 'EACCES', 'EINVAL', 'ENOTSUP']) {
    await withDirectProbeRun('zcode-direct-observer-', async (run) => {
      const nonce = directRunNonce();
      const writers = makeDirectProbeWriters(run, nonce);
      const label = directLabel();
      const callNonce = directCallNonce();
      await writers.driverAppend({ kind: 'request-sent', probeLabel: label, tool: 'hold_direct', state: 'sent' });
      await writers.handlerAppend({ kind: 'handler-entered', probeLabel: label, callNonce, serverInstanceHash: directHash('fixture-instance') });
      const journalPath = join(run, 'events-seal.jsonl');
      const tornJunk = `{"version":1,"runNonce":"${nonce}","recordCo`;
      await writeFile(journalPath, `${await readFile(journalPath, 'utf8')}${tornJunk}`, { mode: 0o600 });
      const journalBefore = await readFile(journalPath);
      const eventsBefore = await readFile(join(run, 'events.jsonl'));
      // The repairing append's second fsync is the repair intent's directory
      // fsync (intent temp fsync, then its directory fsync).
      const probeHandle = await open(run, 'r');
      const fileHandlePrototype = Object.getPrototypeOf(probeHandle);
      await probeHandle.close();
      const originalSync = fileHandlePrototype.sync;
      let syncCalls = 0;
      const injected = new Error(`PROBE_TEST_INJECTED: ${code} at the repair intent directory fsync`);
      injected.code = code;
      fileHandlePrototype.sync = function injectRepairIntentDirectorySyncFailure(...args) {
        syncCalls += 1;
        if (syncCalls === 2) throw injected;
        return originalSync.apply(this, args);
      };
      try {
        await assert.rejects(
          () => writers.driverAppend({ kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'error-result' }),
          (error) => error.code === 'PROBE_OWNER_INVALID',
          `${code} at the repair intent directory fsync must fail the repair closed`,
        );
      } finally { fileHandlePrototype.sync = originalSync; }
      // The truncation never happened: the journal still ends with its torn
      // tail and no fragment was appended; the event log is untouched.
      assert.deepEqual(await readFile(journalPath), journalBefore, 'the journal was not truncated behind the failed directory fsync');
      assert.deepEqual(await readFile(join(run, 'events.jsonl')), eventsBefore, 'no event record was appended behind the failed directory fsync');
      // Error cleared: the repair re-executes and the run reduces.
      await writers.driverAppend({ kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'success-result' });
      const reduced = await writers.reduce();
      assert.equal(reduced.recovery.tornJournalFragments, 1, 'the repair completes once the directory syncs');
    });
  }
});

test('direct evidence keeps the prior repair intent when its replacement fails the directory fsync gate', async () => {
  await withDirectProbeRun('zcode-direct-observer-', async (run) => {
    const nonce = directRunNonce();
    const writers = makeDirectProbeWriters(run, nonce);
    const label = directLabel();
    const callNonce = directCallNonce();
    await writers.driverAppend({ kind: 'request-sent', probeLabel: label, tool: 'hold_direct', state: 'sent' });
    await writers.handlerAppend({ kind: 'handler-entered', probeLabel: label, callNonce, serverInstanceHash: directHash('fixture-instance') });
    const journalPath = join(run, 'events-seal.jsonl');
    const intentPath = join(run, 'repair-intent.json');
    // First repair: torn tail, repair, crash after the truncation — the
    // first repair intent stays unresolved.
    await writeFile(journalPath, `${await readFile(journalPath, 'utf8')}{"version":1,"runNonce":"${nonce}","recordCo`, { mode: 0o600 });
    const probeHandle = await open(run, 'r');
    const fileHandlePrototype = Object.getPrototypeOf(probeHandle);
    await probeHandle.close();
    const originalSync = fileHandlePrototype.sync;
    let syncCalls = 0;
    fileHandlePrototype.sync = function crashAfterJournalTruncation(...args) {
      syncCalls += 1;
      if (syncCalls === 5) throw new Error('PROBE_TEST_CRASH: crash after the journal truncation, before the anchoring commit');
      return originalSync.apply(this, args);
    };
    try {
      await assert.rejects(
        () => writers.driverAppend({ kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'error-result' }),
        /PROBE_TEST_CRASH/,
      );
    } finally { fileHandlePrototype.sync = originalSync; }
    const intentBefore = await readFile(intentPath, 'utf8');
    // Second repair: tear the journal again, and inject EPERM at the
    // replacement intent's directory fsync. The replacement must be rolled
    // back to the PRIOR intent — losing it would bypass the verification
    // gates a repeat repair owes the unresolved binding.
    await writeFile(journalPath, `${await readFile(journalPath, 'utf8')}{"version":1,"runN`, { mode: 0o600 });
    syncCalls = 0;
    const injected = new Error('PROBE_TEST_INJECTED: EPERM at the replacement intent directory fsync');
    injected.code = 'EPERM';
    fileHandlePrototype.sync = function injectReplacementDirectorySyncFailure(...args) {
      syncCalls += 1;
      if (syncCalls === 2) throw injected;
      return originalSync.apply(this, args);
    };
    try {
      await assert.rejects(
        () => writers.driverAppend({ kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'error-result' }),
        (error) => error.code === 'PROBE_OWNER_INVALID',
        'a failed directory fsync at the intent replacement must refuse the append',
      );
    } finally { fileHandlePrototype.sync = originalSync; }
    assert.equal(await readFile(intentPath, 'utf8'), intentBefore, 'the prior repair intent survived the failed replacement');
    await assert.rejects(writers.reduce, /A repair intent is unresolved/, 'the surviving intent is valid and still unresolved');
    // Error cleared: the repair completes and the run reduces.
    await writers.driverAppend({ kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'error-result' });
    const reduced = await writers.reduce();
    assert.equal(reduced.recovery.tornJournalFragments, 2, 'every preserved fragment stays visible in the reduction');
  });
});

// --- Codex gate round 27: the rollback of a failed intent replacement is
// --- itself ATOMIC and DURABLE. The restored bytes are fsynced through the
// --- rollback's own temporary file and renamed over the target, so a crash
// --- at ANY point of the replacement or its rollback leaves the intent path
// --- holding either the complete OLD intent or the complete NEW intent —
// --- never a missing or partial one — and a fresh writer resolves it.

test('direct evidence fsyncs and crash-safely rolls back a replacement intent whose directory fsync fails', async () => {
  await withDirectProbeRun('zcode-direct-observer-', async (run) => {
    const nonce = directRunNonce();
    const writers = makeDirectProbeWriters(run, nonce);
    const label = directLabel();
    const callNonce = directCallNonce();
    // First repair (bound base): the torn sidecar is anchored at one record.
    await withDirectProbeRepairFixture(run, nonce, writers, label, callNonce);
    const journalPath = join(run, 'events-seal.jsonl');
    const intentPath = join(run, 'repair-intent.json');
    const tornPath = join(run, 'journal-torn.jsonl');
    // First phase: tear the journal, and crash the repair at the fsync AFTER
    // its sidecar work and journal truncation, but before the record write —
    // the first intent stays in place with the sidecar in its exact bound
    // FINAL state.
    await writeFile(journalPath, `${await readFile(journalPath, 'utf8')}{"version":1,"runNonce":"${nonce}","recordCo`, { mode: 0o600 });
    const probeHandle = await open(run, 'r');
    const fileHandlePrototype = Object.getPrototypeOf(probeHandle);
    await probeHandle.close();
    const originalSync = fileHandlePrototype.sync;
    let syncCalls = 0;
    fileHandlePrototype.sync = function crashAfterSidecarWorkBeforeRecord(...args) {
      syncCalls += 1;
      if (syncCalls === 5) throw new Error('PROBE_TEST_CRASH: crash after the sidecar work, before the record write');
      return originalSync.apply(this, args);
    };
    try {
      await assert.rejects(
        () => writers.driverAppend({ kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'error-result' }),
        /PROBE_TEST_CRASH/,
      );
    } finally { fileHandlePrototype.sync = originalSync; }
    const intentBefore = await readFile(intentPath, 'utf8');
    const tornBefore = await readFile(tornPath);
    // Second repair: a SECOND journal tear (so the replacement binding
    // differs), and the replacement intent's DIRECTORY fsync fails with a
    // soft-fail code. The refused append must DURABLY roll back: the
    // restored bytes are fsynced through the rollback's own temporary file
    // (intent temp, intent directory, RESTORE = three fsyncs) — not
    // silently truncate-written in place.
    await writeFile(journalPath, `${await readFile(journalPath, 'utf8')}{"version":1,"runN`, { mode: 0o600 });
    const journalAfterTear = await readFile(journalPath);
    syncCalls = 0;
    const injectedEperm = new Error('PROBE_TEST_INJECTED: EPERM at the replacement intent directory fsync');
    injectedEperm.code = 'EPERM';
    fileHandlePrototype.sync = function injectReplacementDirectorySyncFailure(...args) {
      syncCalls += 1;
      if (syncCalls === 2) throw injectedEperm;
      return originalSync.apply(this, args);
    };
    try {
      await assert.rejects(
        () => writers.driverAppend({ kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'error-result' }),
        (error) => error.code === 'PROBE_OWNER_INVALID',
        'a soft-failed directory fsync at the intent replacement must fail the gate closed',
      );
    } finally { fileHandlePrototype.sync = originalSync; }
    assert.equal(syncCalls, 3, 'the rollback fsynced the restored bytes through its own temporary file');
    assert.equal(await readFile(intentPath, 'utf8'), intentBefore, 'the prior intent survived the failed replacement');
    assert.deepEqual(await readFile(tornPath), tornBefore, 'the torn sidecar was untouched behind the failed directory fsync');
    assert.deepEqual(await readFile(journalPath), journalAfterTear, 'the journal was untouched behind the failed directory fsync');
    // Crash DURING the rollback: the gate fails again and the ROLLBACK
    // restore's own fsync crashes — the failure is contained, and the intent
    // path must still hold a COMPLETE authenticated intent (never missing or
    // partial) with the journal and sidecar untouched.
    await writeFile(journalPath, `${await readFile(journalPath, 'utf8')}{"version":1,"runN`, { mode: 0o600 });
    const journalBeforeCrash = await readFile(journalPath);
    syncCalls = 0;
    fileHandlePrototype.sync = function injectGateThenCrashRollback(...args) {
      syncCalls += 1;
      if (syncCalls === 2) { const error = new Error('PROBE_TEST_INJECTED: EPERM at the replacement intent directory fsync'); error.code = 'EPERM'; throw error; }
      if (syncCalls === 3) throw new Error('PROBE_TEST_CRASH: crash at the rollback restore fsync');
      return originalSync.apply(this, args);
    };
    try {
      await assert.rejects(
        () => writers.driverAppend({ kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'error-result' }),
        (error) => error.code === 'PROBE_OWNER_INVALID',
        'a crash inside the rollback is contained: the gate still fails closed',
      );
    } finally { fileHandlePrototype.sync = originalSync; }
    const surviving = JSON.parse(await readFile(intentPath, 'utf8'));
    assert.equal(surviving.version, 1);
    assert.equal(surviving.runNonce, nonce);
    assert.match(surviving.repairIntentMac, /^[0-9a-f]{64}$/, 'the surviving intent is complete and authenticated');
    assert.deepEqual(await readFile(journalPath), journalBeforeCrash, 'the journal remains untouched behind the crashed rollback');
    assert.deepEqual(await readFile(tornPath), tornBefore, 'the torn sidecar remains untouched behind the crashed rollback');
    // The crash left intent #2 durable while its bound FINAL sidecar state
    // was never materialized (the sidecar work runs behind the intent).
    // Completing the sidecar to the intent's EXACT bound final state — the
    // same authenticated record the interrupted attempt was about to append
    // (its fragment is the journal's accumulated torn tail), recomputed
    // here — lets the fresh writer resume and resolve it.
    const journalText = journalBeforeCrash.toString('utf8');
    const thirdFragment = journalText.slice(journalText.lastIndexOf('\n') + 1);
    const pendingRecord = { version: 1, runNonce: nonce, fragment: thirdFragment, tornMac: createHmac('sha256', Buffer.from(DIRECT_DRIVER_SECRET, 'utf8')).update(canonicalJson({ version: 1, runNonce: nonce, fragment: thirdFragment })).digest('hex') };
    await writeFile(tornPath, Buffer.concat([tornBefore, Buffer.from(`${JSON.stringify(pendingRecord)}\n`, 'utf8')]), { mode: 0o600 });
    // Restart-style: a fresh writer instance re-reads the surviving complete
    // intent, resumes the pending repair, and the run reduces.
    const fresh = makeDirectProbeWriters(run, nonce);
    await fresh.driverAppend({ kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'success-result' });
    const intentGone = await readFile(intentPath, 'utf8').then(() => false, (error) => error.code === 'ENOENT');
    assert.ok(intentGone, 'the surviving complete intent was resolved');
    const reduced = await fresh.reduce();
    assert.equal(reduced.recovery.tornJournalFragments, 3, 'every fragment record stays visible in the reduction');
    assert.equal(reduced.uncommittedCount, 0, 'the resumed repair resolves cleanly');
  });
});

// --- Codex gate round 28: the FIRST seal commit fails closed when the ---
// --- journal's directory fsync cannot complete. A soft-failed directory ---
// --- fsync must never let the append report a durable commit whose journal ---
// --- entry a power loss can still erase; the orphaned event bytes stay ---
// --- recoverable through the existing machinery.

test('direct evidence fails the first seal commit closed when the journal directory fsync fails', async () => {
  for (const code of ['EPERM', 'EACCES', 'EINVAL', 'ENOTSUP']) {
    await withDirectProbeRun('zcode-direct-observer-', async (run) => {
      const nonce = directRunNonce();
      const writers = makeDirectProbeWriters(run, nonce);
      const label = directLabel();
      // The first append creates the journal: its fsync order is the event
      // record's fsync, the journal line's fsync, then the journal-creation
      // directory fsync — inject each soft-fail code exactly there.
      const probeHandle = await open(run, 'r');
      const fileHandlePrototype = Object.getPrototypeOf(probeHandle);
      await probeHandle.close();
      const originalSync = fileHandlePrototype.sync;
      let syncCalls = 0;
      const injected = new Error(`PROBE_TEST_INJECTED: ${code} at the journal-creation directory fsync`);
      injected.code = code;
      fileHandlePrototype.sync = function injectJournalCreationDirectorySyncFailure(...args) {
        syncCalls += 1;
        if (syncCalls === 3) throw injected;
        return originalSync.apply(this, args);
      };
      try {
        await assert.rejects(
          () => writers.driverAppend({ kind: 'request-sent', probeLabel: label, tool: 'hold_direct', state: 'sent' }),
          (error) => error.code === 'PROBE_OWNER_INVALID',
          `${code} at the journal-creation directory fsync must fail the first commit closed`,
        );
      } finally { fileHandlePrototype.sync = originalSync; }
      // The record stays uncommitted-but-recoverable: its bytes and the
      // journal line landed; only the directory entry is non-durable.
      const events = await readFile(join(run, 'events.jsonl'), 'utf8');
      assert.equal(events.trim().split('\n').length, 1, 'the event record bytes remain recoverable');
      const journal = await readFile(join(run, 'events-seal.jsonl'), 'utf8');
      assert.equal(journal.trim().split('\n').length, 1, 'the journal line remains recoverable');
      // Error cleared: the retry proceeds normally and the run reduces.
      await writers.driverAppend({ kind: 'request-sent', probeLabel: directLabel(), tool: 'hold_direct', state: 'sent' });
      const journalLines = (await readFile(join(run, 'events-seal.jsonl'), 'utf8')).trim().split('\n');
      assert.equal(journalLines.length, 2, 'the retry commits normally');
      const reduced = await writers.reduce();
      assert.equal(reduced.uncommittedCount, 0, 'the run reduces cleanly once the directory syncs');
    });
  }
});

// --- Codex gate round 29: EVERY seal commit fsyncs the run directory and ---
// --- fails closed when that fsync cannot complete. After a soft-failed ---
// --- first journal-creation fsync, the journal FILE and its valid commit ---
// --- line remain visible on disk. A retry that skipped the directory fsync ---
// --- because the file now exists would report a commit whose directory ---
// --- entry a power loss can still erase — exactly the durability lie the ---
// --- round 28 gate closed for the first commit. The regression: while the ---
// --- directory fsync keeps failing, EVERY subsequent append must also ---
// --- refuse (nothing reported durable), and once it is cleared the chain ---
// --- must reduce cleanly over everything that landed behind the refusals. ---

test('direct evidence fails every seal commit closed while the journal directory fsync keeps failing', async () => {
  for (const code of ['EPERM', 'EACCES', 'EINVAL', 'ENOTSUP']) {
    await withDirectProbeRun('zcode-direct-observer-', async (run) => {
      const nonce = directRunNonce();
      const writers = makeDirectProbeWriters(run, nonce);
      const eventsPath = join(run, 'events.jsonl');
      const journalPath = join(run, 'events-seal.jsonl');
      const probeHandle = await open(run, 'r');
      const fileHandlePrototype = Object.getPrototypeOf(probeHandle);
      await probeHandle.close();
      const originalSync = fileHandlePrototype.sync;
      // Each commit's fsync order is the event record's fsync, the journal
      // line's fsync, then the commit's run-directory fsync (round 28
      // established the ordinal for the journal-creating commit; round 29
      // makes the third fsync unconditional on EVERY commit). Inject each
      // soft-fail code exactly at that third fsync of each append.
      const injectCommitDirectorySyncFailure = () => {
        let syncCalls = 0;
        fileHandlePrototype.sync = function injectThirdDirectorySyncFailure(...args) {
          syncCalls += 1;
          if (syncCalls === 3) {
            const error = new Error(`PROBE_TEST_INJECTED: ${code} at the commit directory fsync`);
            error.code = code;
            throw error;
          }
          return originalSync.apply(this, args);
        };
      };
      // FIRST append: creates the journal; its directory fsync soft-fails.
      injectCommitDirectorySyncFailure();
      try {
        await assert.rejects(
          () => writers.driverAppend({ kind: 'request-sent', probeLabel: directLabel(), tool: 'hold_direct', state: 'sent' }),
          (error) => error.code === 'PROBE_OWNER_INVALID',
          `${code} at the journal-creation directory fsync must fail the first commit closed`,
        );
      } finally { fileHandlePrototype.sync = originalSync; }
      assert.equal(writers.anchor(), null, 'the refused first commit was never reported durable');
      // The record bytes and the journal line landed behind the refused
      // commit (the round 28 semantics): recoverable, never reported.
      assert.equal((await readFile(eventsPath, 'utf8')).trim().split('\n').length, 1, 'the event record remains recoverable');
      assert.equal((await readFile(journalPath, 'utf8')).trim().split('\n').length, 1, 'the journal line remains on disk');
      // RETRY: the journal file now EXISTS. The directory fsync must still
      // run — the third fsync of this append is its commit's directory
      // fsync — and the retry must refuse while it keeps failing, instead of
      // skipping the fsync and reporting the commit durable.
      injectCommitDirectorySyncFailure();
      try {
        await assert.rejects(
          () => writers.driverAppend({ kind: 'request-sent', probeLabel: directLabel(), tool: 'hold_direct', state: 'sent' }),
          (error) => error.code === 'PROBE_OWNER_INVALID',
          `${code} at the retry's commit directory fsync must fail that commit closed too`,
        );
      } finally { fileHandlePrototype.sync = originalSync; }
      assert.equal(writers.anchor(), null, 'the refused retry was never reported durable');
      // The retry's bytes landed behind its refused commit exactly like the
      // first attempt's: the journal walk still chains over them, nothing
      // was reported, and the state stays recoverable.
      assert.equal((await readFile(eventsPath, 'utf8')).trim().split('\n').length, 2, 'the retry left its record recoverable behind the refused commit');
      assert.equal((await readFile(journalPath, 'utf8')).trim().split('\n').length, 2, 'the retry left its journal line behind the refused commit');
      // Error cleared: the next append's unconditional directory fsync
      // succeeds, commits, and the run reduces cleanly over the whole chain.
      await writers.driverAppend({ kind: 'request-sent', probeLabel: directLabel(), tool: 'hold_direct', state: 'sent' });
      assert.equal((await readFile(journalPath, 'utf8')).trim().split('\n').length, 3, 'the cleared append commits');
      const reduced = await writers.reduce();
      assert.equal(reduced.uncommittedCount, 0, 'the run reduces cleanly once the directory syncs complete');
    });
  }
});

// --- Codex gate round 30: the sidecars' reported recovery facts are ---
// --- AUTHENTICATED STATE, not free bytes. The journal walk verifies each ---
// --- anchor's sidecar PREFIX, but nothing tied a sidecar's full length to ---
// --- its anchor: appending arbitrary lines beyond the anchored length ---
// --- changed the reported recovery counts without failing reduction, and ---
// --- such a suffix could be erased again without detection. Reduction must ---
// --- require each present sidecar's full byte length to EQUAL its last ---
// --- recorded anchor exactly, and must refuse a sidecar present with no ---
// --- anchoring journal line at all — while the legitimate in-flight states ---
// --- (an unresolved intent covering the sidecar) keep failing through ---
// --- their own intent gates, and every anchored state keeps reducing. ---

test('direct evidence reduction refuses recovery-sidecar bytes beyond the anchored prefix', async () => {
  await withDirectProbeRun('zcode-direct-observer-', async (run) => {
    const nonce = directRunNonce();
    const writers = makeDirectProbeWriters(run, nonce);
    const { label, callNonce } = await withDirectProbeRecoveryFixture(run, nonce, writers);
    // The recovering append commits the line that anchors the sidecar.
    await writers.driverAppend({ kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'error-result' });
    const sidecarPath = join(run, 'events-uncommitted.jsonl');
    const sidecarBytes = await readFile(sidecarPath);
    const baseline = await writers.reduce();
    assert.equal(baseline.recovery.sidecarPresent, true, 'the anchored sidecar is part of the reduction surface');
    assert.equal(baseline.recovery.sidecarRecords, sidecarBytes.toString('utf8').trim().split('\n').length, 'the baseline reports exactly the anchored records');
    // Append forged lines BEYOND the anchored length: the reported recovery
    // evidence must not change, so the reduction must refuse outright.
    await writeFile(sidecarPath, `${sidecarBytes.toString('utf8')}{"kind":"forged-a"}\n{"kind":"forged-b"}\n`, { mode: 0o600 });
    await assert.rejects(
      () => writers.reduce(),
      (error) => error.code === 'PROBE_OWNER_INVALID',
      'recovery-sidecar bytes beyond the anchored prefix must fail the reduction closed',
    );
    // Restoring the exact anchored bytes reduces again, and deleting the
    // sidecar still fails closed (the existing prefix rule).
    await writeFile(sidecarPath, sidecarBytes, { mode: 0o600 });
    await writers.reduce();
    await rm(sidecarPath);
    await assert.rejects(writers.reduce, /PROBE_OWNER_INVALID/, 'a deleted recovery sidecar must fail the reduction closed');
  });
});

test('direct evidence reduction refuses preserved-fragment bytes beyond the anchored repair prefix', async () => {
  await withDirectProbeRun('zcode-direct-observer-', async (run) => {
    const nonce = directRunNonce();
    const writers = makeDirectProbeWriters(run, nonce);
    const label = directLabel();
    const callNonce = directCallNonce();
    await withDirectProbeRepairFixture(run, nonce, writers, label, callNonce);
    const tornPath = join(run, 'journal-torn.jsonl');
    const tornBytes = await readFile(tornPath);
    const baseline = await writers.reduce();
    assert.equal(baseline.recovery.tornJournalFragments, 1, 'the baseline reports exactly the anchored fragment');
    // Appending forged fragment lines beyond the anchored repair length must
    // never change the reported repair evidence.
    await writeFile(tornPath, `${tornBytes.toString('utf8')}{"version":1,"runNonce":"${nonce}","fragment":"forged","tornMac":"${'a'.repeat(64)}"}\n`, { mode: 0o600 });
    await assert.rejects(
      () => writers.reduce(),
      (error) => error.code === 'PROBE_OWNER_INVALID',
      'preserved-fragment bytes beyond the anchored repair prefix must fail the reduction closed',
    );
    // Restoring the anchored bytes reduces again; deletion still fails closed.
    await writeFile(tornPath, tornBytes, { mode: 0o600 });
    await writers.reduce();
    await rm(tornPath);
    await assert.rejects(writers.reduce, /PROBE_OWNER_INVALID/, 'a deleted torn-fragment sidecar must fail the reduction closed');
  });
});

test('direct evidence reduction refuses partial-evidence bytes beyond the anchored repair prefix', async () => {
  await withDirectProbeRun('zcode-direct-observer-', async (run) => {
    const nonce = directRunNonce();
    const writers = makeDirectProbeWriters(run, nonce);
    const label = directLabel();
    const callNonce = directCallNonce();
    // First repair (bound base): the torn sidecar is anchored at one record.
    await withDirectProbeRepairFixture(run, nonce, writers, label, callNonce);
    const partialPath = join(run, 'journal-torn-partial.jsonl');
    // Round 35 intent-first: the durable repair intent binds the crashed
    // preservation write's content BEFORE the partial file exists; the
    // completing repair recomputes it from the torn source, verifies it
    // against the intent, writes it, and anchors it.
    const partialBytes = Buffer.from(`{"version":1,"runNonce":"${nonce}","frag`, 'utf8');
    await withDirectProbeIntentFirstPartialFixture(run, nonce, writers, label, callNonce, partialBytes.toString('utf8'));
    const partialFileBytes = await readFile(partialPath);
    const baseline = await writers.reduce();
    assert.equal(baseline.recovery.tornJournalFragments, 2, 'the baseline anchors both fragment records');
    assert.equal(baseline.recovery.repairedPartialFragments, 1, 'the baseline anchors exactly the preserved tail');
    // A forged suffix whose records AUTHENTICATE (the writer processes hold
    // the run capability secret, so Mac-valid bytes are exactly what a
    // compromised writer can produce) must still fail: the anchor binds the
    // sidecar's full length, and the secret-garbage case already fails the
    // existing per-record Mac rule.
    const forgedRecord = { version: 1, runNonce: nonce, data: Buffer.from('forged-partial-tail\n', 'utf8').toString('base64') };
    const forged = { ...forgedRecord, partialMac: createHmac('sha256', Buffer.from(DIRECT_DRIVER_SECRET, 'utf8')).update(canonicalJson(forgedRecord)).digest('hex') };
    await writeFile(partialPath, `${partialFileBytes.toString('utf8')}${JSON.stringify(forged)}\n`, { mode: 0o600 });
    await assert.rejects(
      () => writers.reduce(),
      (error) => error.code === 'PROBE_OWNER_INVALID',
      'partial-evidence bytes beyond the anchored repair prefix must fail the reduction closed even when every record authenticates',
    );
    // Restoring the anchored bytes reduces again; deletion still fails closed.
    await writeFile(partialPath, partialFileBytes, { mode: 0o600 });
    await writers.reduce();
    await rm(partialPath);
    await assert.rejects(writers.reduce, /PROBE_OWNER_INVALID/, 'a deleted partial-evidence sidecar must fail the reduction closed');
  });
});

test('direct evidence reduction refuses a sidecar present without an anchoring journal line', async () => {
  await withDirectProbeRun('zcode-direct-observer-', async (run) => {
    const nonce = directRunNonce();
    const writers = makeDirectProbeWriters(run, nonce);
    // Committed records but NO recovery and NO repair: no sidecar is
    // anchored, so no sidecar file may exist at all.
    await writers.driverAppend({ kind: 'request-sent', probeLabel: directLabel(), tool: 'hold_direct', state: 'sent' });
    const baseline = await writers.reduce();
    assert.equal(baseline.recovery.sidecarPresent, false, 'the clean run reports no recovery surface');
    assert.equal(baseline.recovery.tornJournalFragments, 0);
    assert.equal(baseline.recovery.repairedPartialFragments, 0);
    // An anchorless recovery sidecar exists: reduction refuses outright.
    await writeFile(join(run, 'events-uncommitted.jsonl'), '{"kind":"forged"}\n', { mode: 0o600 });
    await assert.rejects(
      () => writers.reduce(),
      (error) => error.code === 'PROBE_OWNER_INVALID',
      'a recovery sidecar without an anchoring journal line must fail the reduction closed',
    );
    await rm(join(run, 'events-uncommitted.jsonl'));
    // Same for an anchorless torn-fragment sidecar...
    await writeFile(join(run, 'journal-torn.jsonl'), `{"version":1,"runNonce":"${nonce}","fragment":"forged","tornMac":"${'b'.repeat(64)}"}\n`, { mode: 0o600 });
    await assert.rejects(
      () => writers.reduce(),
      (error) => error.code === 'PROBE_OWNER_INVALID',
      'a torn-fragment sidecar without an anchoring journal line must fail the reduction closed',
    );
    await rm(join(run, 'journal-torn.jsonl'));
    // ...and for an anchorless partial-evidence sidecar — even when every
    // record in it authenticates.
    const forgedRecord = { version: 1, runNonce: nonce, data: Buffer.from('forged-partial-tail\n', 'utf8').toString('base64') };
    const forged = { ...forgedRecord, partialMac: createHmac('sha256', Buffer.from(DIRECT_DRIVER_SECRET, 'utf8')).update(canonicalJson(forgedRecord)).digest('hex') };
    await writeFile(join(run, 'journal-torn-partial.jsonl'), `${JSON.stringify(forged)}\n`, { mode: 0o600 });
    await assert.rejects(
      () => writers.reduce(),
      (error) => error.code === 'PROBE_OWNER_INVALID',
      'a partial-evidence sidecar without an anchoring journal line must fail the reduction closed',
    );
    await rm(join(run, 'journal-torn-partial.jsonl'));
    await writers.reduce();
  });
});

// --- Codex gate round 31: the recovery APPEND must not launder sidecar ---
// --- bytes either. The round 30 reduction gate refuses an altered sidecar, ---
// --- but the recovery path itself could still EXTEND an already-altered ---
// --- sidecar (forged suffix, or a half-written tail from a crashed append), ---
// --- hash its full contents, and commit a fresh recovery anchor — thereby ---
// --- making the unauthenticated bytes anchored, reported evidence. Before ---
// --- extending the sidecar, the append must require its existing bytes to ---
// --- match the binding record EXACTLY: the last committed recovery anchor, ---
// --- or an unresolved recovery intent's recorded length (the same ---
// --- intent-bound in-flight state the intent gate above authenticates). ---
// --- Anything else refuses closed WITHOUT writing a new anchor, while the ---
// --- legitimate continuation (sidecar exactly at anchor + genuinely new ---
// --- uncommitted records) keeps working. ---

test('direct evidence refuses a recovery append that would anchor sidecar bytes beyond the anchor', async () => {
  await withDirectProbeRun('zcode-direct-observer-', async (run) => {
    const nonce = directRunNonce();
    const writers = makeDirectProbeWriters(run, nonce);
    const { label, callNonce } = await withDirectProbeRecoveryFixture(run, nonce, writers);
    // First recovery anchors the sidecar (1 preserved record).
    await writers.driverAppend({ kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'error-result' });
    const eventsPath = join(run, 'events.jsonl');
    const journalPath = join(run, 'events-seal.jsonl');
    const sidecarPath = join(run, 'events-uncommitted.jsonl');
    const anchoredBytes = await readFile(sidecarPath);
    const baseline = await writers.reduce();
    assert.equal(baseline.recovery.sidecarRecords, 1, 'the anchored sidecar reports exactly its preserved record');
    assert.equal(baseline.uncommittedCount, 0);
    // Forge bytes BEYOND the anchor, then leave an uncommitted event behind
    // (durable record bytes, no journal line) so the next append re-executes
    // the recovery against the altered sidecar.
    const forgedSidecar = `${anchoredBytes.toString('utf8')}{"kind":"forged-suffix"}\n`;
    await writeFile(sidecarPath, forgedSidecar, { mode: 0o600 });
    const orphan = { version: 1, runNonce: nonce, sequence: 4, phase: 'reachability', kind: 'rpc-observed', probeLabel: directLabel(), callNonce: directCallNonce(), outcome: 'success-result' };
    const eventsWithOrphan = `${await readFile(eventsPath, 'utf8')}${JSON.stringify(orphan)}\n`;
    await writeFile(eventsPath, eventsWithOrphan, { mode: 0o600 });
    await assert.rejects(
      () => writers.driverAppend({ kind: 'request-sent', probeLabel: directLabel(), tool: 'hold_direct', state: 'sent' }),
      (error) => error.code === 'PROBE_OWNER_INVALID',
      'a recovery append over an altered sidecar must refuse closed',
    );
    // The refusal wrote NOTHING: no fresh anchor was committed over the
    // forged suffix, and the sidecar was not extended.
    assert.deepEqual(await readFile(sidecarPath), Buffer.from(forgedSidecar, 'utf8'), 'the refused append never touched the altered sidecar');
    assert.equal((await readFile(journalPath, 'utf8')).trim().split('\n').length, 4, 'no recovery anchor was committed over the forged suffix');
    assert.equal(await readFile(eventsPath, 'utf8'), eventsWithOrphan, 'the event log was left untouched behind the refusal');
    // The forged suffix can never be laundered: reduction still refuses.
    await assert.rejects(writers.reduce, /PROBE_OWNER_INVALID/, 'the altered sidecar stays irreducible');
    // Incomplete sidecar writes (a crash mid-append leaves a partial line)
    // are the same unbound state: the recovery must refuse them too.
    await writeFile(sidecarPath, `${anchoredBytes.toString('utf8')}{"kind":"ha`, { mode: 0o600 });
    await assert.rejects(
      () => writers.driverAppend({ kind: 'request-sent', probeLabel: directLabel(), tool: 'hold_direct', state: 'sent' }),
      (error) => error.code === 'PROBE_OWNER_INVALID',
      'a recovery append over a half-written sidecar tail must refuse closed',
    );
    // Legitimate continuation: with the sidecar EXACTLY at its anchor and a
    // genuinely new uncommitted record, the recovery proceeds, anchors the
    // full sidecar, and the run reduces cleanly.
    await writeFile(sidecarPath, anchoredBytes, { mode: 0o600 });
    await writers.driverAppend({ kind: 'request-sent', probeLabel: directLabel(), tool: 'hold_direct', state: 'sent' });
    const reduced = await writers.reduce();
    assert.equal(reduced.uncommittedCount, 0, 'the legitimate recovery completes');
    assert.equal(reduced.recovery.sidecarRecords, 2, 'the recovered orphan joins the anchored sidecar');
  });
});

// --- Codex gate round 32: the REPAIR path must not launder unbound torn ---
// --- sidecar bytes either. An injected tail beyond the last anchored ---
// --- journal-torn.jsonl length is treated by the repair as a crashed ---
// --- partial write: it is wrapped in a Mac-authenticated partial-evidence ---
// --- record and anchored by the fresh repair commit — the journal walk ---
// --- above verifies only the ANCHORED prefix, so the injected tail becomes ---
// --- reported recovery evidence. Before repairing, the sidecar's existing ---
// --- length must already be bound: exactly at the last committed repair ---
// --- anchor, or in one of the narrowly verified in-flight states of a ---
// --- previously durable repair intent. Anything else refuses the repair ---
// --- closed WITHOUT writing anything, while the legitimate continuation ---
// --- (sidecar exactly at anchor + a genuine new torn journal tail) keeps ---
// --- working. ---

test('direct evidence refuses a repair that would anchor unbound torn-sidecar bytes', async () => {
  await withDirectProbeRun('zcode-direct-observer-', async (run) => {
    const nonce = directRunNonce();
    const writers = makeDirectProbeWriters(run, nonce);
    const label = directLabel();
    const callNonce = directCallNonce();
    // First repair anchors the torn sidecar (1 preserved fragment).
    await withDirectProbeRepairFixture(run, nonce, writers, label, callNonce);
    const eventsPath = join(run, 'events.jsonl');
    const journalPath = join(run, 'events-seal.jsonl');
    const tornPath = join(run, 'journal-torn.jsonl');
    const intentPath = join(run, 'repair-intent.json');
    const partialPath = join(run, 'journal-torn-partial.jsonl');
    const anchoredBytes = await readFile(tornPath);
    const baseline = await writers.reduce();
    assert.equal(baseline.recovery.tornJournalFragments, 1, 'the anchored sidecar reports exactly its fragment');
    // Inject an UNBOUND tail beyond the anchor, then force a later journal
    // repair with a new torn seal-journal tail.
    const injectedTail = '{"unbound-tail';
    await writeFile(tornPath, `${anchoredBytes.toString('utf8')}${injectedTail}`, { mode: 0o600 });
    const eventsBefore = await readFile(eventsPath);
    const journalWithTornTail = Buffer.from(`${(await readFile(journalPath, 'utf8'))}{"version":1,"runNonce":"${nonce}","recordCo`, 'utf8');
    await writeFile(journalPath, journalWithTornTail, { mode: 0o600 });
    await assert.rejects(
      () => writers.driverAppend({ kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'error-result' }),
      (error) => error.code === 'PROBE_OWNER_INVALID',
      'a repair over an unbound torn-sidecar tail must refuse closed',
    );
    // The refusal wrote NOTHING: the injected tail was never preserved into
    // the partial evidence, no fragment was appended, no intent or anchor
    // landed, and the journal is byte-identical (torn tail included).
    assert.deepEqual(await readFile(tornPath), Buffer.from(`${anchoredBytes.toString('utf8')}${injectedTail}`, 'utf8'), 'the refused repair never touched the altered sidecar');
    await assert.rejects(() => readFile(intentPath, 'utf8'), (error) => error.code === 'ENOENT', 'no repair intent was written behind the refusal');
    await assert.rejects(() => readFile(partialPath, 'utf8'), (error) => error.code === 'ENOENT', 'no partial-evidence record was written behind the refusal');
    assert.deepEqual(await readFile(journalPath), journalWithTornTail, 'no repair anchor was committed over the injected tail');
    assert.deepEqual(await readFile(eventsPath), eventsBefore, 'the event log was left untouched behind the refusal');
    // The injected tail can never be laundered: reduction still refuses.
    await assert.rejects(writers.reduce, /PROBE_OWNER_INVALID/, 'the altered sidecar stays irreducible');
    // Legitimate continuation: with the sidecar EXACTLY at its anchor and a
    // genuine new torn journal tail, the repair proceeds, anchors the second
    // fragment, and the run reduces cleanly.
    await writeFile(tornPath, anchoredBytes, { mode: 0o600 });
    await writers.driverAppend({ kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'error-result' });
    const reduced = await writers.reduce();
    assert.equal(reduced.uncommittedCount, 0, 'the legitimate repair completes');
    assert.equal(reduced.recovery.tornJournalFragments, 2, 'the second fragment joins the anchored sidecar');
    assert.equal(reduced.recovery.repairedPartialFragments, 0, 'no partial evidence was fabricated for the bound repair');
  });
});

// --- Codex gate round 35 (reworks the round 33 regression): an ---
// --- anchorless partial sidecar is itself the laundering vector. The ---
// --- round 33 allowance let a repair normalize and anchor ANY planted ---
// --- journal-torn-partial.jsonl content, so a same-user process can plant ---
// --- the file before a journal repair and reduction accepts fabricated ---
// --- recovery evidence. Under the round 35 intent-first ordering a partial ---
// --- sidecar may only exist behind a durable, authenticated repair intent ---
// --- (the repair writes the intent — binding the computed partial content — ---
// --- BEFORE the partial file is written and verified). Planting one ---
// --- without an intent refuses the repair outright: nothing is written, ---
// --- the planted bytes are never authenticated, and the run stays ---
// --- irreducible. ---

test('direct evidence refuses a repair over a planted partial sidecar that no intent binds', async () => {
  await withDirectProbeRun('zcode-direct-observer-', async (run) => {
    const nonce = directRunNonce();
    const writers = makeDirectProbeWriters(run, nonce);
    const label = directLabel();
    const callNonce = directCallNonce();
    // First repair (bound base): the torn sidecar is anchored at one record.
    await withDirectProbeRepairFixture(run, nonce, writers, label, callNonce);
    const journalPath = join(run, 'events-seal.jsonl');
    const partialPath = join(run, 'journal-torn-partial.jsonl');
    const intentPath = join(run, 'repair-intent.json');
    // Plant a partial sidecar with NO intent and NO committed partial
    // anchor, then force a later journal repair.
    const plantedBytes = Buffer.from(`{"version":1,"runNonce":"${nonce}","planted", "partialMac": "${'p'.repeat(64)}"}`, 'utf8');
    await writeFile(partialPath, plantedBytes, { mode: 0o600 });
    const eventsBefore = await readFile(join(run, 'events.jsonl'));
    const journalWithTear = Buffer.from(`${(await readFile(journalPath, 'utf8'))}{"version":1,"runNonce":"${nonce}","settle`, 'utf8');
    await writeFile(journalPath, journalWithTear, { mode: 0o600 });
    await assert.rejects(
      () => writers.driverAppend({ kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'error-result' }),
      (error) => error.code === 'PROBE_OWNER_INVALID',
      'a repair over a planted anchorless partial sidecar must refuse closed',
    );
    // Everything is left unmodified: the planted bytes were never normalized
    // into MACed evidence, no intent or anchor landed, journal and events
    // are untouched, and the run stays irreducible.
    assert.deepEqual(await readFile(partialPath), plantedBytes, 'the refused repair never touched the planted sidecar');
    assert.deepEqual(await readFile(journalPath), journalWithTear, 'the journal was left untouched behind the refusal');
    assert.deepEqual(await readFile(join(run, 'events.jsonl')), eventsBefore, 'the event log was left untouched behind the refusal');
    await assert.rejects(() => readFile(intentPath, 'utf8'), (error) => error.code === 'ENOENT', 'no repair intent was written behind the refusal');
    await assert.rejects(writers.reduce, /PROBE_OWNER_INVALID/, 'the planted partial sidecar stays irreducible');
  });
});

test('direct evidence refuses a repair when a planted partial sidecar does not match its repair intent', async () => {
  await withDirectProbeRun('zcode-direct-observer-', async (run) => {
    const nonce = directRunNonce();
    const writers = makeDirectProbeWriters(run, nonce);
    const label = directLabel();
    const callNonce = directCallNonce();
    // First repair (bound base): the torn sidecar is anchored at one record.
    await withDirectProbeRepairFixture(run, nonce, writers, label, callNonce);
    const journalPath = join(run, 'events-seal.jsonl');
    const tornPath = join(run, 'journal-torn.jsonl');
    const partialPath = join(run, 'journal-torn-partial.jsonl');
    const intentPath = join(run, 'repair-intent.json');
    const anchorSidecarBytes = await readFile(tornPath);
    // Durable intent: binds the torn sidecar's current bound state as its
    // final torn state and carries NO partial binding of its own — a partial
    // file appearing now was never bound by anything.
    const intentPayload = {
      version: 1,
      runNonce: nonce,
      tornValidLength: anchorSidecarBytes.length,
      tornValidDigest: createHash('sha256').update(anchorSidecarBytes).digest('hex'),
      tornTailLength: 0,
      tornTailDigest: createHash('sha256').update(Buffer.alloc(0)).digest('hex'),
      tornFragmentCount: 1,
      tornDigest: createHash('sha256').update(anchorSidecarBytes).digest('hex'),
      tornLength: anchorSidecarBytes.length,
    };
    await writeFile(intentPath, `${JSON.stringify({ ...intentPayload, repairIntentMac: createHmac('sha256', Buffer.from(DIRECT_DRIVER_SECRET, 'utf8')).update(canonicalJson(intentPayload)).digest('hex') })}\n`, { mode: 0o600 });
    // Plant a partial sidecar under that intent: the repair must refuse —
    // the intent binds no partial content, so the bytes are unauthenticated.
    const plantedBytes = Buffer.from(`{"version":1,"runNonce":"${nonce}","planted-under-intent", "partialMac": "${'q'.repeat(64)}"}`, 'utf8');
    await writeFile(partialPath, plantedBytes, { mode: 0o600 });
    const eventsBefore = await readFile(join(run, 'events.jsonl'));
    const journalBefore = await readFile(journalPath);
    await assert.rejects(
      () => writers.driverAppend({ kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'error-result' }),
      (error) => error.code === 'PROBE_OWNER_INVALID',
      'a planted partial sidecar under an intent that binds no partial content must refuse the repair closed',
    );
    assert.deepEqual(await readFile(partialPath), plantedBytes, 'the refused repair never touched the planted sidecar');
    assert.deepEqual(await readFile(journalPath), journalBefore, 'the journal was left untouched behind the refusal');
    assert.deepEqual(await readFile(join(run, 'events.jsonl')), eventsBefore, 'the event log was left untouched behind the refusal');
    await assert.rejects(writers.reduce, /PROBE_OWNER_INVALID/, 'the planted partial sidecar stays irreducible');
  });
});

test('direct evidence completes a crashed preservation write by recomputing and verifying against its intent', async () => {
  await withDirectProbeRun('zcode-direct-observer-', async (run) => {
    const nonce = directRunNonce();
    const writers = makeDirectProbeWriters(run, nonce);
    const label = directLabel();
    const callNonce = directCallNonce();
    // First repair (bound base): the torn sidecar is anchored at one record.
    await withDirectProbeRepairFixture(run, nonce, writers, label, callNonce);
    const journalPath = join(run, 'events-seal.jsonl');
    const tornPath = join(run, 'journal-torn.jsonl');
    const partialPath = join(run, 'journal-torn-partial.jsonl');
    const intentPath = join(run, 'repair-intent.json');
    const anchorSidecarBytes = await readFile(tornPath);
    // The legitimate crashed-preservation flow, intent-first: the durable
    // intent binds the crashed preservation write's content AND the torn
    // sidecar's exact pre-truncation state (valid prefix + tail). The
    // partial-evidence file itself was never written.
    const tailBytes = Buffer.from(`{"version":1,"runNonce":"${nonce}","frag`, 'utf8');
    const journalTailFragment = `{"version":1,"runNonce":"${nonce}","recordCo`;
    const preservationData = tailBytes.toString('base64');
    const preservationLine = JSON.stringify({ version: 1, runNonce: nonce, data: preservationData, partialMac: createHmac('sha256', Buffer.from(DIRECT_DRIVER_SECRET, 'utf8')).update(canonicalJson({ version: 1, runNonce: nonce, data: preservationData })).digest('hex') });
    const partialContentBytes = Buffer.from(`${preservationLine}\n`, 'utf8');
    const { intentLine } = makeDirectRepairIntent({ nonce, ownerSecret: DIRECT_DRIVER_SECRET, validPrefixBytes: anchorSidecarBytes, tailBytes, fragment: journalTailFragment, partialContentBytes });
    await writeFile(tornPath, Buffer.concat([anchorSidecarBytes, tailBytes]), { mode: 0o600 });
    await writeFile(intentPath, intentLine, { mode: 0o600 });
    await writeFile(journalPath, `${await readFile(journalPath, 'utf8')}${journalTailFragment}`, { mode: 0o600 });
    // The retry recomputes the preservation record from the torn source,
    // verifies it against the durable intent, writes it, truncates the tail,
    // and resolves the intent with its partial anchor.
    await writers.driverAppend({ kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'error-result' });
    const partialEvidence = JSON.parse((await readFile(partialPath, 'utf8')).trim().split('\n').at(-1));
    assert.equal(partialEvidence.data, tailBytes.toString('base64'), 'the preservation record carries the torn-source bytes');
    const expectedPartialMac = createHmac('sha256', Buffer.from(DIRECT_DRIVER_SECRET, 'utf8')).update(canonicalJson({ version: 1, runNonce: nonce, data: partialEvidence.data })).digest('hex');
    assert.equal(partialEvidence.partialMac, expectedPartialMac, 'the preserved bytes are authenticated');
    const tornLines = (await readFile(tornPath, 'utf8')).trim().split('\n');
    assert.equal(tornLines.length, 2, 'the sidecar holds the anchored prefix plus the new fragment record');
    const intentGone = await readFile(intentPath, 'utf8').then(() => false, (error) => error.code === 'ENOENT');
    assert.ok(intentGone, 'the resolved repair intent was removed');
    const reduced = await writers.reduce();
    assert.equal(reduced.uncommittedCount, 0, 'the run reduces cleanly');
    assert.equal(reduced.recovery.repairedPartialFragments, 1, 'the preserved partial tail stays visible in the reduction');
    assert.equal(reduced.recovery.tornJournalFragments, 2, 'both fragment records stay visible in the reduction');
  });
});

// --- Codex gate round 34: the ORDINARY append path gets the same binding ---
// --- gate. When the seal journal is complete the append skips the repair ---
// --- machinery and hashes the full torn and partial sidecars into ---
// --- commitRepair — so replaying an existing valid sidecar record beyond ---
// --- its anchor (a plain byte copy, no capability secret needed) and then ---
// --- appending a normal event anchors the replay, and reduction accepts it ---
// --- as another preserved fragment. Before constructing commitRepair, each ---
// --- present sidecar must match its binding EXACTLY: the verified ---
// --- in-flight repair-intent state, or the last committed anchor. A ---
// --- mismatch refuses the WHOLE append closed (no event, no anchor); ---
// --- restoring the bound bytes lets the append succeed. ---

test('direct evidence refuses an ordinary append that would anchor replayed sidecar records', async () => {
  await withDirectProbeRun('zcode-direct-observer-', async (run) => {
    const nonce = directRunNonce();
    const writers = makeDirectProbeWriters(run, nonce);
    const label = directLabel();
    const callNonce = directCallNonce();
    // First repair (bound base): torn sidecar anchored at one record.
    await withDirectProbeRepairFixture(run, nonce, writers, label, callNonce);
    const journalPath = join(run, 'events-seal.jsonl');
    const tornPath = join(run, 'journal-torn.jsonl');
    const partialPath = join(run, 'journal-torn-partial.jsonl');
    const anchoredTornBytes = await readFile(tornPath);
    // Replay the valid record BEYOND the anchor (a plain byte copy) while
    // the journal stays COMPLETE, so the next append takes the ordinary
    // (non-repair) path.
    await writeFile(tornPath, Buffer.concat([anchoredTornBytes, anchoredTornBytes]), { mode: 0o600 });
    const eventsBefore = await readFile(join(run, 'events.jsonl'));
    await assert.rejects(
      () => writers.driverAppend({ kind: 'request-sent', probeLabel: directLabel(), tool: 'hold_direct', state: 'sent' }),
      (error) => error.code === 'PROBE_OWNER_INVALID',
      'an ordinary append over a replayed torn-sidecar record must refuse closed',
    );
    // The refusal appended and committed NOTHING.
    assert.deepEqual(await readFile(tornPath), Buffer.concat([anchoredTornBytes, anchoredTornBytes]), 'the refused append never touched the altered sidecar');
    assert.equal((await readFile(journalPath, 'utf8')).trim().split('\n').length, 3, 'no anchor was committed over the replayed record');
    assert.deepEqual(await readFile(join(run, 'events.jsonl')), eventsBefore, 'the event log was left untouched behind the refusal');
    // The replay can never be laundered: reduction still refuses.
    await assert.rejects(writers.reduce, /PROBE_OWNER_INVALID/, 'the altered torn sidecar stays irreducible');
    // Restoring the anchored bytes lets the ordinary append succeed.
    await writeFile(tornPath, anchoredTornBytes, { mode: 0o600 });
    await writers.driverAppend({ kind: 'request-sent', probeLabel: directLabel(), tool: 'hold_direct', state: 'sent' });
    const reduced = await writers.reduce();
    assert.equal(reduced.uncommittedCount, 0, 'the ordinary append completes once the sidecar is bound');
    assert.equal(reduced.recovery.tornJournalFragments, 1, 'the anchored fragment stays visible');
    assert.equal(reduced.recovery.repairedPartialFragments, 0, 'no partial evidence was fabricated');
    // The same attack through the PARTIAL sidecar: round 35 intent-first —
    // a durable intent binds the crashed preservation write's content before
    // the partial file exists; the completing repair anchors it. Then the
    // valid preservation record is replayed beyond its anchor.
    const partialRecordText = `{"version":1,"runNonce":"${nonce}","frag`;
    await withDirectProbeIntentFirstPartialFixture(run, nonce, writers, label, callNonce, partialRecordText);
    const anchoredPartialBytes = await readFile(partialPath);
    const partialBaseline = await writers.reduce();
    assert.equal(partialBaseline.recovery.repairedPartialFragments, 1, 'the baseline anchors exactly the preservation record');
    await writeFile(partialPath, Buffer.concat([anchoredPartialBytes, anchoredPartialBytes]), { mode: 0o600 });
    await assert.rejects(
      () => writers.driverAppend({ kind: 'request-sent', probeLabel: directLabel(), tool: 'hold_direct', state: 'sent' }),
      (error) => error.code === 'PROBE_OWNER_INVALID',
      'an ordinary append over a replayed partial record must refuse closed',
    );
    assert.deepEqual(await readFile(partialPath), Buffer.concat([anchoredPartialBytes, anchoredPartialBytes]), 'the refused append never touched the altered partial sidecar');
    await writeFile(partialPath, anchoredPartialBytes, { mode: 0o600 });
    await writers.driverAppend({ kind: 'request-sent', probeLabel: directLabel(), tool: 'hold_direct', state: 'sent' });
    const finalReduced = await writers.reduce();
    assert.equal(finalReduced.uncommittedCount, 0, 'the run reduces cleanly once the partial sidecar is bound');
    assert.equal(finalReduced.recovery.repairedPartialFragments, 1, 'the anchored preservation record stays visible');
  });
});

// --- Codex gate round 36, finding 1 (P1): a repair retry must never ---
// --- discard a partial-evidence binding. After the torn sidecar reaches ---
// --- its intent-bound final state, a missing partial file is NOT the ---
// --- intent-only crash window (the torn source is consumed — its bytes ---
// --- can no longer be recomputed), so the retry must refuse WITHOUT ---
// --- replacing the intent with a torn-only binding; otherwise the next ---
// --- retry truncates the journal and commits a torn-only anchor, making ---
// --- the missing partial evidence invisible to reduction. The legal ---
// --- recomputable case (the bound torn tail still present) keeps ---
// --- completing. ---

test('direct evidence refuses a repair retry that would discard a partial-evidence binding', async () => {
  await withDirectProbeRun('zcode-direct-observer-', async (run) => {
    const nonce = directRunNonce();
    const writers = makeDirectProbeWriters(run, nonce);
    const label = directLabel();
    const callNonce = directCallNonce();
    // First repair (bound base): the torn sidecar is anchored at one record.
    await withDirectProbeRepairFixture(run, nonce, writers, label, callNonce);
    const journalPath = join(run, 'events-seal.jsonl');
    const tornPath = join(run, 'journal-torn.jsonl');
    const partialPath = join(run, 'journal-torn-partial.jsonl');
    const intentPath = join(run, 'repair-intent.json');
    const anchorSidecarBytes = await readFile(tornPath);
    // The crashed preservation write: a durable intent binds the tail-derived
    // preservation content and the torn sidecar's final state; the tail is
    // planted and the journal is torn.
    const tailBytes = Buffer.from(`{"version":1,"runNonce":"${nonce}","frag`, 'utf8');
    const journalTailFragment = `{"version":1,"runNonce":"${nonce}","recordCo`;
    const preservationData = tailBytes.toString('base64');
    const preservationLine = JSON.stringify({ version: 1, runNonce: nonce, data: preservationData, partialMac: createHmac('sha256', Buffer.from(DIRECT_DRIVER_SECRET, 'utf8')).update(canonicalJson({ version: 1, runNonce: nonce, data: preservationData })).digest('hex') });
    const partialContentBytes = Buffer.from(`${preservationLine}\n`, 'utf8');
    const { intentLine, finalSidecarBytes } = makeDirectRepairIntent({ nonce, ownerSecret: DIRECT_DRIVER_SECRET, validPrefixBytes: anchorSidecarBytes, tailBytes, fragment: journalTailFragment, partialContentBytes });
    await writeFile(tornPath, Buffer.concat([anchorSidecarBytes, tailBytes]), { mode: 0o600 });
    await writeFile(intentPath, intentLine, { mode: 0o600 });
    await writeFile(journalPath, `${await readFile(journalPath, 'utf8')}${journalTailFragment}`, { mode: 0o600 });
    // Completing append with a crash AFTER the sidecar work (the torn sidecar
    // reached its intent-bound final state) but BEFORE the journal truncation.
    const probeHandle = await open(run, 'r');
    const fileHandlePrototype = Object.getPrototypeOf(probeHandle);
    await probeHandle.close();
    const originalSync = fileHandlePrototype.sync;
    fileHandlePrototype.sync = function crashAfterSidecarWorkBeforeJournalTruncation(...args) {
      let intentDurable = false;
      try { readFileSync(intentPath); intentDurable = true; } catch { intentDurable = false; }
      let journalStillTorn = false;
      try { journalStillTorn = readFileSync(journalPath, 'utf8').endsWith(journalTailFragment); } catch { journalStillTorn = false; }
      let sidecarAtFinal = false;
      try { sidecarAtFinal = readFileSync(tornPath).equals(finalSidecarBytes); } catch { sidecarAtFinal = false; }
      if (intentDurable && journalStillTorn && sidecarAtFinal) {
        throw new Error('PROBE_TEST_CRASH: crash after the sidecar reached its final state, before the journal truncation');
      }
      return originalSync.apply(this, args);
    };
    try {
      await assert.rejects(
        () => writers.driverAppend({ kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'error-result' }),
        /PROBE_TEST_CRASH/,
        'the simulated crash interrupted the repair after the sidecar work',
      );
    } finally { fileHandlePrototype.sync = originalSync; }
    assert.deepEqual(await readFile(tornPath), finalSidecarBytes, 'the sidecar sits in its intent-bound final state');
    // THE ATTACK: the partial file disappears (deleted) in the crash window
    // between the sidecar completion and the journal truncation.
    await rm(partialPath);
    const journalAfterCrash = await readFile(journalPath);
    const intentBefore = await readFile(intentPath, 'utf8');
    // The retry must refuse outright: the torn source is consumed, so the
    // old partial binding is unsatisfiable and the intent must never be
    // replaced with a torn-only binding.
    await assert.rejects(
      () => writers.driverAppend({ kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'success-result' }),
      (error) => error.code === 'PROBE_OWNER_INVALID',
      'a repair retry over a deleted partial binding must refuse closed',
    );
    // The intent survived UNREPLACED: it still carries its partial binding.
    const surviving = JSON.parse(await readFile(intentPath, 'utf8'));
    assert.equal(surviving.partialDigest, JSON.parse(intentBefore).partialDigest, 'the refused retry never replaced the intent with a torn-only binding');
    assert.deepEqual(await readFile(journalPath), journalAfterCrash, 'the journal was left untouched behind the refused retry');
    // A second retry refuses the same way, and reduction keeps reporting the
    // unresolved intent — the missing evidence is never laundered.
    await assert.rejects(
      () => writers.driverAppend({ kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'success-result' }),
      (error) => error.code === 'PROBE_OWNER_INVALID',
      'every retry refuses while the partial binding is unsatisfiable',
    );
    await assert.rejects(writers.reduce, /PROBE_OWNER_INVALID/, 'the unresolved intent keeps the run irreducible');
    // Restoring the bound partial content: the repair completes and reduces.
    await writeFile(partialPath, partialContentBytes, { mode: 0o600 });
    await writers.driverAppend({ kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'success-result' });
    const intentGone = await readFile(intentPath, 'utf8').then(() => false, (error) => error.code === 'ENOENT');
    assert.ok(intentGone, 'the resolved repair intent was removed');
    const reduced = await writers.reduce();
    assert.equal(reduced.uncommittedCount, 0, 'the repair completes once the bound content is restored');
    assert.equal(reduced.recovery.repairedPartialFragments, 1, 'the preserved partial tail stays visible in the reduction');
  });
});

// --- Codex gate round 36, finding 2 (P2): the recovery mirrors the round ---
// --- 35 ordering — the recovery intent is made durable BEFORE the sidecar ---
// --- is created or extended, binding the exact bytes to be preserved. A ---
// --- crash at the sidecar-write boundary leaves the INTENT-ONLY state ---
// --- (intent durable, sidecar pending), which the retry completes by ---
// --- recomputing the bytes from the event source and verifying them ---
// --- against the intent — the stranded sidecar-without-intent state of ---
// --- the old ordering becomes impossible. ---

test('direct evidence recovery writes its intent before the sidecar and completes the intent-only window', async () => {
  await withDirectProbeRun('zcode-direct-observer-', async (run) => {
    const nonce = directRunNonce();
    const writers = makeDirectProbeWriters(run, nonce);
    const label = directLabel();
    const callNonce = directCallNonce();
    await writers.driverAppend({ kind: 'request-sent', probeLabel: label, tool: 'hold_direct', state: 'sent' });
    await writers.handlerAppend({ kind: 'handler-entered', probeLabel: label, callNonce, serverInstanceHash: directHash('fixture-instance') });
    const eventsPath = join(run, 'events.jsonl');
    const recoveryIntentPath = join(run, 'recovery-intent.json');
    const sidecarPath = join(run, 'events-uncommitted.jsonl');
    // An uncommitted record: durable event bytes with no journal line.
    const orphan = { version: 1, runNonce: nonce, sequence: 2, phase: 'reachability', kind: 'rpc-observed', probeLabel: directLabel(), callNonce: directCallNonce(), outcome: 'error-result' };
    await writeFile(eventsPath, JSON.stringify(orphan) + '\n', { mode: 0o600, flag: 'a' });
    const eventsWithOrphan = await readFile(eventsPath);
    // Crash injection at the sidecar-write boundary: crash while the
    // recovery intent is durable and the sidecar has not been written yet —
    // only possible under the round 36 intent-first ordering.
    const probeHandle = await open(eventsPath, 'r');
    const fileHandlePrototype = Object.getPrototypeOf(probeHandle);
    await probeHandle.close();
    const originalSync = fileHandlePrototype.sync;
    fileHandlePrototype.sync = function crashAtIntentOnlyWindow(...args) {
      let intentDurable = false;
      try { readFileSync(recoveryIntentPath); intentDurable = true; } catch { intentDurable = false; }
      let sidecarMissing = true;
      try { readFileSync(sidecarPath); sidecarMissing = false; } catch { sidecarMissing = true; }
      if (intentDurable && sidecarMissing) {
        throw new Error('PROBE_TEST_CRASH: crash in the intent-only window, before the sidecar write');
      }
      return originalSync.apply(this, args);
    };
    try {
      await assert.rejects(
        () => writers.driverAppend({ kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'error-result' }),
        /PROBE_TEST_CRASH/,
        'the intent is durable before the sidecar write (round 36 ordering)',
      );
    } finally { fileHandlePrototype.sync = originalSync; }
    // Intent-only state: the intent is durable, the sidecar and the journal
    // are untouched, and the events still hold the uncommitted record.
    assert.deepEqual(await readFile(eventsPath), eventsWithOrphan, 'the events stayed untouched behind the crash');
    await assert.rejects(() => readFile(sidecarPath, 'utf8'), (error) => error.code === 'ENOENT', 'no sidecar was written behind the crash');
    const intentOnly = JSON.parse(await readFile(recoveryIntentPath, 'utf8'));
    assert.equal(intentOnly.recoveredCount, 1, 'the intent binds the uncommitted record');
    // The retry recomputes the sidecar bytes from the event source, verifies
    // them against the intent, writes them, truncates, and commits.
    await writers.driverAppend({ kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'success-result' });
    const sidecarWritten = JSON.parse((await readFile(sidecarPath, 'utf8')).trim().split('\n').at(-1));
    assert.deepEqual(sidecarWritten, JSON.parse(JSON.stringify(orphan)), 'the sidecar carries exactly the recomputed bytes');
    const intentGone = await readFile(recoveryIntentPath, 'utf8').then(() => false, (error) => error.code === 'ENOENT');
    assert.ok(intentGone, 'the resolved recovery intent was removed');
    const reduced = await writers.reduce();
    assert.equal(reduced.uncommittedCount, 0, 'the run reduces cleanly');
    assert.equal(reduced.recovery.sidecarRecords, 1, 'the recovered record stays visible in the reduction');
  });
});

// --- Codex gate round 37: a MISSING recovery sidecar is the intent-only ---
// --- crash window ONLY while the uncommitted event source remains intact ---
// --- (the bytes are still recomputable from the events). Once the events ---
// --- are truncated, the sidecar holds the ONLY copy of the recovered ---
// --- bytes: a deleted sidecar under an unresolved intent is ---
// --- unsatisfiable, and a retry that committed the intent's recovery ---
// --- fields anyway would report a successful append whose anchor ---
// --- references bytes nothing holds — reduction would then reject the run. ---
// --- The truncated-missing state must refuse EVERY retry (PROBE_OWNER_---
// --- INVALID, no commit, the intent preserved) until the sidecar bytes are ---
// --- restored. ---

test('direct evidence refuses a recovery retry when the truncated recovery sidecar is deleted', async () => {
  await withDirectProbeRun('zcode-direct-observer-', async (run) => {
    const nonce = directRunNonce();
    const writers = makeDirectProbeWriters(run, nonce);
    const { label, callNonce } = await withDirectProbeRecoveryFixture(run, nonce, writers);
    const eventsPath = join(run, 'events.jsonl');
    const journalPath = join(run, 'events-seal.jsonl');
    const sidecarPath = join(run, 'events-uncommitted.jsonl');
    const intentPath = join(run, 'recovery-intent.json');
    // Drive a recovery to the truncated state: crash between the truncation
    // and the recovery commit (the record handle's first stat) — the sidecar
    // and the durable intent hold the recovered bytes, the events are
    // truncated, and no commit landed.
    const probeHandle = await open(eventsPath, 'r');
    const fileHandlePrototype = Object.getPrototypeOf(probeHandle);
    await probeHandle.close();
    const originalStat = fileHandlePrototype.stat;
    let plainStats = 0;
    fileHandlePrototype.stat = function crashBetweenTruncationAndCommit(...args) {
      if (args.length === 0) plainStats += 1;
      if (plainStats === 2) throw new Error('PROBE_TEST_CRASH: crash between truncation and the recovery commit');
      return originalStat.apply(this, args);
    };
    try {
      await assert.rejects(
        () => writers.driverAppend({ kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'error-result' }),
        /PROBE_TEST_CRASH/,
        'the simulated crash interrupted the recovering append before its commit',
      );
    } finally { fileHandlePrototype.stat = originalStat; }
    const sidecarBytes = await readFile(sidecarPath);
    const intentBefore = await readFile(intentPath, 'utf8');
    assert.match(sidecarBytes.toString('utf8'), /handler-settled/, 'the sidecar holds the recovered bytes');
    // THE ATTACK: delete the sidecar. Every retry must refuse
    // PROBE_OWNER_INVALID, the intent must survive with its recovered
    // binding, and no commit line may be added.
    await rm(sidecarPath);
    const journalBeforeRetry = await readFile(journalPath, 'utf8');
    await assert.rejects(
      () => writers.driverAppend({ kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'success-result' }),
      (error) => error.code === 'PROBE_OWNER_INVALID',
      'a recovery retry over a deleted truncated recovery sidecar must refuse closed',
    );
    // The intent survives with its recovered binding; no commit landed; the
    // events stay truncated.
    assert.equal(await readFile(intentPath, 'utf8'), intentBefore, 'the intent survives the refused retry');
    assert.equal(await readFile(journalPath, 'utf8'), journalBeforeRetry, 'the journal was left untouched behind the refused retries');
    assert.doesNotMatch(await readFile(eventsPath, 'utf8'), /success-result/, 'no event was appended behind the refused retry');
    // Repeated retries refuse the same way...
    await assert.rejects(
      () => writers.driverAppend({ kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'success-result' }),
      (error) => error.code === 'PROBE_OWNER_INVALID',
      'repeated retries keep refusing while the sidecar is missing',
    );
    // ...and reduction keeps reporting the unresolved state.
    await assert.rejects(writers.reduce, /PROBE_OWNER_INVALID/, 'the truncated-missing state stays irreducible');
    // Restoring the sidecar bytes: the intent resolves and the run reduces.
    await writeFile(sidecarPath, sidecarBytes, { mode: 0o600 });
    await writers.driverAppend({ kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'success-result' });
    const intentGone = await readFile(intentPath, 'utf8').then(() => false, (error) => error.code === 'ENOENT');
    assert.ok(intentGone, 'the resolved recovery intent was removed');
    const reduced = await writers.reduce();
    assert.equal(reduced.uncommittedCount, 0, 'the run reduces cleanly once the sidecar is restored');
    assert.equal(reduced.recovery.sidecarRecords, 1, 'the recovered record stays visible in the reduction');
  });
});

// --- Codex gate round 38, finding 1: the post-truncation recovery commit ---
// --- path verifies the sidecar's FULL content. The round 37 missing- ---
// --- sidecar refusal left a sibling hole: a sidecar PRESENT at its bound ---
// --- length plus injected suffix bytes passed the intent's prefix check, ---
// --- so the truncated-state retry committed the intent's recovery fields ---
// --- over the enlarged file and reported a durable append for a run the ---
// --- next reduction would reject. The post-truncation commit path now ---
// --- requires the sidecar's full length and digest to equal the intent's ---
// --- binding; a suffix refuses PROBE_OWNER_INVALID without appending or ---
// --- clearing the intent, and restoring the exact bound bytes resolves. ---

test('direct evidence refuses a post-truncation recovery commit over an unauthenticated sidecar suffix', async () => {
  await withDirectProbeRun('zcode-direct-observer-', async (run) => {
    const nonce = directRunNonce();
    const writers = makeDirectProbeWriters(run, nonce);
    const { label, callNonce } = await withDirectProbeRecoveryFixture(run, nonce, writers);
    const eventsPath = join(run, 'events.jsonl');
    const journalPath = join(run, 'events-seal.jsonl');
    const sidecarPath = join(run, 'events-uncommitted.jsonl');
    const intentPath = join(run, 'recovery-intent.json');
    // Drive a recovery to the truncated state: crash between the truncation
    // and the recovery commit (the record handle's first stat) — the sidecar
    // and the durable intent hold the recovered bytes, the events are
    // truncated, and no commit landed.
    const probeHandle = await open(eventsPath, 'r');
    const fileHandlePrototype = Object.getPrototypeOf(probeHandle);
    await probeHandle.close();
    const originalStat = fileHandlePrototype.stat;
    let plainStats = 0;
    fileHandlePrototype.stat = function crashBetweenTruncationAndCommit(...args) {
      if (args.length === 0) plainStats += 1;
      if (plainStats === 2) throw new Error('PROBE_TEST_CRASH: crash between truncation and the recovery commit');
      return originalStat.apply(this, args);
    };
    try {
      await assert.rejects(
        () => writers.driverAppend({ kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'error-result' }),
        /PROBE_TEST_CRASH/,
        'the simulated crash interrupted the recovering append before its commit',
      );
    } finally { fileHandlePrototype.stat = originalStat; }
    const sidecarBytes = await readFile(sidecarPath);
    // THE ATTACK: forged bytes appended beyond the intent's recoveredLength.
    const forgedSuffix = '{"unauthenticated-suffix"}\n';
    await writeFile(sidecarPath, Buffer.concat([sidecarBytes, Buffer.from(forgedSuffix, 'utf8')]), { mode: 0o600 });
    const eventsBefore = await readFile(eventsPath);
    await assert.rejects(
      () => writers.driverAppend({ kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'success-result' }),
      (error) => error.code === 'PROBE_OWNER_INVALID',
      'a post-truncation recovery commit over an unauthenticated sidecar suffix must refuse closed',
    );
    // Nothing was written: the intent survives unreplaced with its binding,
    // no commit landed, and the events are untouched.
    assert.deepEqual(await readFile(sidecarPath), Buffer.concat([sidecarBytes, Buffer.from(forgedSuffix, 'utf8')]), 'the refused append never touched the sidecar');
    assert.equal((await readFile(journalPath, 'utf8')).trim().split('\n').length, 3, 'no commit line was added behind the refusal');
    assert.deepEqual(await readFile(eventsPath), eventsBefore, 'the event log was left untouched behind the refusal');
    await assert.rejects(writers.reduce, /PROBE_OWNER_INVALID/, 'the suffixed sidecar stays irreducible');
    // Restoring the exact bound bytes: the recovery completes and reduces.
    await writeFile(sidecarPath, sidecarBytes, { mode: 0o600 });
    await writers.driverAppend({ kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'success-result' });
    const intentGone = await readFile(intentPath, 'utf8').then(() => false, (error) => error.code === 'ENOENT');
    assert.ok(intentGone, 'the resolved recovery intent was removed');
    const reduced = await writers.reduce();
    assert.equal(reduced.uncommittedCount, 0, 'the recovery completes once the sidecar is bound');
    assert.equal(reduced.recovery.sidecarRecords, 1, 'the recovered record stays visible in the reduction');
  });
});

// --- Codex gate round 38, finding 2: authenticated reduction distinguishes ---
// --- the two uncommitted tail shapes. COMPLETE sealed-uncommitted records ---
// --- beyond the committed count keep the abrupt-kill behavior (excluded ---
// --- from the committed prefix, reported via uncommittedCount). An ---
// --- UNTERMINATED trailing event line (partial JSON bytes, no final ---
// --- newline) is write debris that the append-path recovery cleans up ---
// --- (sidecar move + truncation), so a log still carrying it has not ---
// --- completed its recovery and authenticated reduction refuses it — ---
// --- while the raw reader's torn-line refusal stays as is. ---

test('direct evidence reduction refuses a log with a torn trailing event until its recovery completes', async () => {
  await withDirectProbeRun('zcode-direct-observer-', async (run) => {
    const nonce = directRunNonce();
    const writers = makeDirectProbeWriters(run, nonce);
    const label = directLabel();
    const callNonce = directCallNonce();
    await writers.driverAppend({ kind: 'request-sent', probeLabel: label, tool: 'hold_direct', state: 'sent' });
    await writers.handlerAppend({ kind: 'handler-entered', probeLabel: label, callNonce, serverInstanceHash: directHash('fixture-instance') });
    const eventsPath = join(run, 'events.jsonl');
    // A torn trailing event: partial JSON bytes, no final newline — write
    // debris from a killed record append.
    const tornTail = `{"version":1,"runNonce":"${nonce}","seq`;
    await writeFile(eventsPath, `${await readFile(eventsPath, 'utf8')}${tornTail}`, { mode: 0o600 });
    await assert.rejects(
      () => writers.reduce(),
      (error) => error.code === 'PROBE_OWNER_INVALID',
      'a log with a torn trailing event must fail authenticated reduction',
    );
    // The repairing append cleans the tail: the torn bytes move to the
    // sidecar, the log is truncated to the committed prefix, and the new
    // record commits — the run reduces with the uncommitted accounting.
    await writers.driverAppend({ kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'error-result' });
    const reduced = await writers.reduce();
    assert.equal(reduced.uncommittedCount, 0, 'the recovery completes');
    assert.equal(reduced.recovery.sidecarRecords, 1, 'the torn bytes stay visible as preserved evidence');
    // A COMPLETE record beyond the committed count keeps today's behavior:
    // excluded from the prefix and reported via uncommittedCount.
    const completeRecord = { version: 1, runNonce: nonce, sequence: 3, phase: 'reachability', kind: 'rpc-observed', probeLabel: directLabel(), callNonce: directCallNonce(), outcome: 'success-result' };
    await writeFile(eventsPath, `${await readFile(eventsPath, 'utf8')}${JSON.stringify(completeRecord)}\n`, { mode: 0o600 });
    const postCommit = await writers.reduce();
    assert.equal(postCommit.uncommittedCount, 1, 'a complete sealed-uncommitted record is reported, not refused');
    // And the next append recovers it and reduces cleanly.
    await writers.driverAppend({ kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'error-result' });
    const finalReduced = await writers.reduce();
    assert.equal(finalReduced.uncommittedCount, 0, 'the run reduces cleanly');
  });
});

// --- Codex gate round 39: the recovery-path mirror of the round-32/35 ---
// --- pre-replacement window. On a SECOND recovery the durable intent ---
// --- binds the ENLARGED sidecar (existing content + the new batch) BEFORE ---
// --- the sidecar replacement runs. A crash after the intent is persisted ---
// --- leaves the sidecar at its PREVIOUS anchor state — still exactly what ---
// --- the previous journal anchor binds — and the retry must accept that ---
// --- state, reconstruct the target from the intact event source, verify it ---
// --- against the intent, replace the sidecar, and complete. A sidecar ---
// --- matching NEITHER binding still refuses, and the planted-file refusal ---
// --- of the earlier gates is preserved. ---

test('direct evidence completes a second recovery whose enlarged-sidecar intent crashed before the replacement', async () => {
  await withDirectProbeRun('zcode-direct-observer-', async (run) => {
    const nonce = directRunNonce();
    const writers = makeDirectProbeWriters(run, nonce);
    const eventsPath = join(run, 'events.jsonl');
    const sidecarPath = join(run, 'events-uncommitted.jsonl');
    const intentPath = join(run, 'recovery-intent.json');
    const { label, callNonce } = await withDirectProbeRecoveryFixture(run, nonce, writers);
    // THE FIRST RECOVERY, intent-first: the durable intent binds the orphan
    // batch's bytes BEFORE the sidecar exists; the recovery verifies the
    // recomputed bytes against the intent and materializes the sidecar.
    const orphan1 = { version: 1, runNonce: nonce, sequence: 3, phase: 'reachability', kind: 'handler-settled', callNonce, outcome: 'completed' };
    const orphan1Bytes = Buffer.from(`${JSON.stringify({ ...orphan1, recordMac: createHmac('sha256', Buffer.from(DIRECT_DRIVER_SECRET, 'utf8')).update(canonicalJson(orphan1)).digest('hex') })}\n`, 'utf8');
    const intent1Payload = {
      version: 1,
      runNonce: nonce,
      recoveredCount: 1,
      recoveredDigest: createHash('sha256').update(orphan1Bytes).digest('hex'),
      recoveredLength: orphan1Bytes.length,
    };
    await writeFile(intentPath, `${JSON.stringify({ ...intent1Payload, intentMac: createHmac('sha256', Buffer.from(DIRECT_DRIVER_SECRET, 'utf8')).update(canonicalJson(intent1Payload)).digest('hex') })}\n`, { mode: 0o600 });
    await writers.driverAppend({ kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'error-result' });
    const anchorSidecarLength = (await readFile(sidecarPath)).length;
    const anchoredSidecarBytes = await readFile(sidecarPath);
    const firstReduced = await writers.reduce();
    assert.equal(firstReduced.uncommittedCount, 0, 'the first recovery completes and the run reduces');
    assert.equal(firstReduced.recovery.sidecarRecords, 1, 'the first preserved record stays visible');
    // ROUND 39: a second uncommitted record and a second recovery that
    // crashes right after its ENLARGED-sidecar intent is persisted — BEFORE
    // the sidecar replacement. The sidecar still matches the PREVIOUS
    // journal anchor exactly (the interrupted pre-replacement state).
    const orphan2 = { version: 1, runNonce: nonce, sequence: 4, phase: 'reachability', kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'success-result' };
    await writeFile(eventsPath, `${await readFile(eventsPath, 'utf8')}${JSON.stringify(orphan2)}\n`, { mode: 0o600, flag: 'a' });
    const probeHandle = await open(run, 'r');
    const fileHandlePrototype = Object.getPrototypeOf(probeHandle);
    await probeHandle.close();
    const originalSync = fileHandlePrototype.sync;
    fileHandlePrototype.sync = function crashAfterSecondIntentPersisted(...args) {
      let intentDurable = false;
      try { readFileSync(intentPath); intentDurable = true; } catch { intentDurable = false; }
      let sidecarAtPrevious = false;
      try { sidecarAtPrevious = readFileSync(sidecarPath).length === anchorSidecarLength; } catch { sidecarAtPrevious = false; }
      if (intentDurable && sidecarAtPrevious) {
        throw new Error('PROBE_TEST_CRASH: crash after the enlarged-sidecar intent was persisted, before the sidecar replacement');
      }
      return originalSync.apply(this, args);
    };
    try {
      await assert.rejects(
        () => writers.driverAppend({ kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'error-result' }),
        /PROBE_TEST_CRASH/,
        'the simulated crash interrupted the second recovery after its intent was persisted',
      );
    } finally { fileHandlePrototype.sync = originalSync; }
    // THE STATE: the sidecar at its previous anchor length (matching the
    // previous journal anchor exactly), the enlarged intent durable, and the
    // second batch still uncommitted in the events.
    assert.deepEqual(await readFile(sidecarPath), anchoredSidecarBytes, 'the sidecar replacement never ran behind the crash');
    // THE RETRY: the interrupted pre-replacement state is accepted (the
    // sidecar matches the previous journal anchor exactly), the target is
    // reconstructed from the intact event source, verified against the
    // intent, written, and committed — the run completes.
    await writers.driverAppend({ kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'success-result' });
    const intentGone = await readFile(intentPath, 'utf8').then(() => false, (error) => error.code === 'ENOENT');
    assert.ok(intentGone, 'the resolved recovery intent was removed');
    const reduced = await writers.reduce();
    assert.equal(reduced.uncommittedCount, 0, 'the second recovery completes and the run reduces');
    assert.equal(reduced.recovery.sidecarRecords, 6, 'every preserved record stays visible in the reduction');
    // A sidecar matching NEITHER binding still refuses the recovery.
    const boundSidecarBytes = await readFile(sidecarPath);
    const junkSidecar = Buffer.from('{"planted-junk"}\n', 'utf8');
    await writeFile(sidecarPath, junkSidecar, { mode: 0o600 });
    const orphan3 = { version: 1, runNonce: nonce, sequence: 5, phase: 'reachability', kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'error-result' };
    await writeFile(eventsPath, `${await readFile(eventsPath, 'utf8')}${JSON.stringify(orphan3)}\n`, { mode: 0o600, flag: 'a' });
    await assert.rejects(
      () => writers.driverAppend({ kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'success-result' }),
      (error) => error.code === 'PROBE_OWNER_INVALID',
      'a sidecar matching neither binding must refuse the recovery closed',
    );
    // Restoring the bound sidecar: the recovery completes and reduces.
    await writeFile(sidecarPath, boundSidecarBytes, { mode: 0o600 });
    await writers.driverAppend({ kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'success-result' });
    const finalReduced = await writers.reduce();
    assert.equal(finalReduced.uncommittedCount, 0, 'the run reduces cleanly once the bound sidecar is restored');
  });
});
// --- Codex gate round 40: the two pre-append crash windows of a journal ---
// --- repair become legal, verified states. (a) A FIRST repair writes and ---
// --- syncs repair-intent.json BEFORE creating journal-torn.jsonl — a ---
// --- crash in that window leaves the intent durable, the sidecar absent, ---
// --- and the journal still torn. (b) With an existing anchored sidecar, ---
// --- the second repair's intent binds a ZERO-length tail (unchanged pre- ---
// --- append sidecar) — a crash after the intent leaves the sidecar ---
// --- unchanged at its previous anchor. Both states were refused by ---
// --- verifyRepairIntentFragments (the missing sidecar; the unchanged ---
// --- sidecar with a zero tail matching no legal state), stranding every ---
// --- retry despite the intact journal fragment. The retry now verifies ---
// --- the intact journal fragment against the intent's binding and ---
// --- completes: the sidecar is materialized/replaced per the intent, the ---
// --- journal truncated, the recovery committed, and the run reduces. A ---
// --- sidecar/journal state matching NEITHER the intent's binding nor the ---
// --- previous anchor still refuses. ---

test('direct evidence completes a first repair whose intent crashed before the torn sidecar was created', async () => {
  await withDirectProbeRun('zcode-direct-observer-', async (run) => {
    const nonce = directRunNonce();
    const writers = makeDirectProbeWriters(run, nonce);
    const { label, callNonce } = await withDirectProbeRecoveryFixture(run, nonce, writers);
    const eventsPath = join(run, 'events.jsonl');
    const journalPath = join(run, 'events-seal.jsonl');
    const tornPath = join(run, 'journal-torn.jsonl');
    const intentPath = join(run, 'repair-intent.json');
    // A torn journal tail: a repair is pending.
    const tornFragment = `{"version":1,"runNonce":"${nonce}","recordCo`;
    await writeFile(journalPath, `${await readFile(journalPath, 'utf8')}${tornFragment}`, { mode: 0o600 });
    // The FIRST repair with a crash after the intent write, before the torn
    // sidecar is created: the intent durable, the sidecar absent, the
    // journal still torn.
    const probeHandle = await open(eventsPath, 'r');
    const fileHandlePrototype = Object.getPrototypeOf(probeHandle);
    await probeHandle.close();
    const originalSync = fileHandlePrototype.sync;
    fileHandlePrototype.sync = function crashAfterFirstRepairIntent(...args) {
      let intentDurable = false;
      try { readFileSync(intentPath); intentDurable = true; } catch { intentDurable = false; }
      let sidecarMissing = true;
      try { readFileSync(tornPath); sidecarMissing = false; } catch { sidecarMissing = true; }
      if (intentDurable && sidecarMissing) {
        throw new Error('PROBE_TEST_CRASH: crash after the first repair intent was persisted, before the torn sidecar creation');
      }
      return originalSync.apply(this, args);
    };
    try {
      await assert.rejects(
        () => writers.driverAppend({ kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'error-result' }),
        /PROBE_TEST_CRASH/,
        'the simulated crash interrupted the first repair after its intent was persisted',
      );
    } finally { fileHandlePrototype.sync = originalSync; }
    // THE STATE: the intent durable, the torn sidecar absent, the journal
    // still torn.
    await assert.rejects(() => readFile(tornPath, 'utf8'), (error) => error.code === 'ENOENT', 'the torn sidecar was never created behind the crash');
    const journalAfterCrash = await readFile(journalPath, 'utf8');
    assert.ok(journalAfterCrash.endsWith(tornFragment), 'the journal is still torn behind the crash');
    // THE RETRY: reconstructs the bound target from the intact journal
    // fragment, verifies it against the intent, materializes the sidecar,
    // truncates the journal, and commits.
    await writers.driverAppend({ kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'success-result' });
    const intentGone = await readFile(intentPath, 'utf8').then(() => false, (error) => error.code === 'ENOENT');
    assert.ok(intentGone, 'the resolved repair intent was removed');
    const reduced = await writers.reduce();
    assert.equal(reduced.uncommittedCount, 0, 'the first repair completes and the run reduces');
    assert.equal(reduced.recovery.tornJournalFragments, 1, 'the preserved fragment stays visible in the reduction');
  });
});

test('direct evidence completes a second repair whose zero-tail intent crashed before the sidecar replacement', async () => {
  await withDirectProbeRun('zcode-direct-observer-', async (run) => {
    const nonce = directRunNonce();
    const writers = makeDirectProbeWriters(run, nonce);
    const eventsPath = join(run, 'events.jsonl');
    const journalPath = join(run, 'events-seal.jsonl');
    const tornPath = join(run, 'journal-torn.jsonl');
    const intentPath = join(run, 'repair-intent.json');
    const label = directLabel();
    const callNonce = directCallNonce();
    // The FIRST repair completes: the torn sidecar holds one fragment
    // record, anchored — a ZERO-length tail for the next repair.
    await withDirectProbeRepairFixture(run, nonce, writers, label, callNonce);
    await writers.driverAppend({ kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'error-result' });
    const anchoredSidecarBytes = await readFile(tornPath);
    // A second journal tear and a second repair that crashes right after
    // its ZERO-tail intent is persisted — BEFORE the sidecar replacement:
    // the torn sidecar is unchanged at its previous anchor length.
    const tornFragment2 = `{"version":1,"runNonce":"${nonce}","settle`;
    await writeFile(journalPath, `${await readFile(journalPath, 'utf8')}${tornFragment2}`, { mode: 0o600 });
    const probeHandle = await open(eventsPath, 'r');
    const fileHandlePrototype = Object.getPrototypeOf(probeHandle);
    await probeHandle.close();
    const originalSync = fileHandlePrototype.sync;
    fileHandlePrototype.sync = function crashAfterZeroTailIntent(...args) {
      let intentDurable = false;
      try { readFileSync(intentPath); intentDurable = true; } catch { intentDurable = false; }
      let sidecarUnchanged = false;
      try { sidecarUnchanged = readFileSync(tornPath).equals(anchoredSidecarBytes); } catch { sidecarUnchanged = false; }
      if (intentDurable && sidecarUnchanged) {
        throw new Error('PROBE_TEST_CRASH: crash after the zero-tail intent was persisted, before the sidecar replacement');
      }
      return originalSync.apply(this, args);
    };
    try {
      await assert.rejects(
        () => writers.driverAppend({ kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'error-result' }),
        /PROBE_TEST_CRASH/,
        'the simulated crash interrupted the second repair after its zero-tail intent was persisted',
      );
    } finally { fileHandlePrototype.sync = originalSync; }
    // THE STATE: the torn sidecar unchanged at its previous anchor length,
    // the zero-tail intent durable, and the journal still torn.
    assert.deepEqual(await readFile(tornPath), anchoredSidecarBytes, 'the sidecar replacement never ran behind the crash');
    // THE RETRY: the zero-tail intent is accepted (the sidecar matches the
    // previous anchor exactly), the target is reconstructed from the intact
    // journal fragment, verified against the intent, and completed.
    await writers.driverAppend({ kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'success-result' });
    const intentGone = await readFile(intentPath, 'utf8').then(() => false, (error) => error.code === 'ENOENT');
    assert.ok(intentGone, 'the resolved repair intent was removed');
    const reduced = await writers.reduce();
    assert.equal(reduced.uncommittedCount, 0, 'the second repair completes and the run reduces');
    assert.equal(reduced.recovery.tornJournalFragments, 2, 'both fragment records stay visible in the reduction');
  });
});
// --- ROUND 41: the same two pre-append crash windows with a NEWLINE- ---
// --- TERMINATED structurally rejected final journal line: the retry ---
// --- must reconstruct the bound fragment with the repair's own ---
// --- final-line extraction (not just unterminated tails), verify it ---
// --- against the intent, complete, and reduce; a mismatching ---
// --- reconstructed fragment still refuses. ---

test('direct evidence completes a first repair whose newline-terminated rejected line crashed before the torn sidecar was created', async () => {
  await withDirectProbeRun('zcode-direct-observer-', async (run) => {
    const nonce = directRunNonce();
    const writers = makeDirectProbeWriters(run, nonce);
    const { label, callNonce } = await withDirectProbeRecoveryFixture(run, nonce, writers);
    const eventsPath = join(run, 'events.jsonl');
    const journalPath = join(run, 'events-seal.jsonl');
    const tornPath = join(run, 'journal-torn.jsonl');
    const intentPath = join(run, 'repair-intent.json');
    // A NEWLINE-TERMINATED structurally rejected final line: the same
    // partial-write junk as the torn-tail case, but the newline landed, so
    // the walk classifies it as a complete rejected line, not a torn tail.
    // A repair is pending either way.
    const rejectedLine = `{"version":1,"runNonce":"${nonce}","recordCo`;
    await writeFile(journalPath, `${await readFile(journalPath, 'utf8')}${rejectedLine}\n`, { mode: 0o600 });
    // The FIRST repair with a crash after the intent write, before the torn
    // sidecar is created: the intent durable, the sidecar absent, the
    // journal still holding the rejected final line.
    const probeHandle = await open(eventsPath, 'r');
    const fileHandlePrototype = Object.getPrototypeOf(probeHandle);
    await probeHandle.close();
    const originalSync = fileHandlePrototype.sync;
    fileHandlePrototype.sync = function crashAfterFirstRepairIntent(...args) {
      let intentDurable = false;
      try { readFileSync(intentPath); intentDurable = true; } catch { intentDurable = false; }
      let sidecarMissing = true;
      try { readFileSync(tornPath); sidecarMissing = false; } catch { sidecarMissing = true; }
      if (intentDurable && sidecarMissing) {
        throw new Error('PROBE_TEST_CRASH: crash after the first repair intent was persisted, before the torn sidecar creation');
      }
      return originalSync.apply(this, args);
    };
    try {
      await assert.rejects(
        () => writers.driverAppend({ kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'error-result' }),
        /PROBE_TEST_CRASH/,
        'the simulated crash interrupted the first repair after its intent was persisted',
      );
    } finally { fileHandlePrototype.sync = originalSync; }
    // THE STATE: the intent durable, the torn sidecar absent, the journal
    // still ending with the newline-terminated rejected final line.
    await assert.rejects(() => readFile(tornPath, 'utf8'), (error) => error.code === 'ENOENT', 'the torn sidecar was never created behind the crash');
    const journalAfterCrash = await readFile(journalPath, 'utf8');
    assert.ok(journalAfterCrash.endsWith(`${rejectedLine}\n`), 'the journal still ends with the rejected final line');
    // A reconstructed fragment that does NOT match the intent refuses: the
    // rejected line is swapped for different junk, the retry refuses
    // WITHOUT writing, and the intent survives.
    const swappedJournal = `${journalAfterCrash.slice(0, journalAfterCrash.length - rejectedLine.length - 1)}{"version":1,"runNonce":"${nonce}","settleMismatch":true}\n`;
    await writeFile(journalPath, swappedJournal, { mode: 0o600 });
    await assert.rejects(
      () => writers.driverAppend({ kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'error-result' }),
      (error) => error.code === 'PROBE_OWNER_INVALID',
      'a mismatching reconstructed fragment refuses the retry',
    );
    await readFile(intentPath, 'utf8');
    // THE RETRY on the intact journal: reconstructs the bound fragment with
    // the repair's own final-line extraction, verifies it against the
    // intent, materializes the sidecar, truncates the journal, and commits.
    await writeFile(journalPath, journalAfterCrash, { mode: 0o600 });
    await writers.driverAppend({ kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'success-result' });
    const intentGone = await readFile(intentPath, 'utf8').then(() => false, (error) => error.code === 'ENOENT');
    assert.ok(intentGone, 'the resolved repair intent was removed');
    const reduced = await writers.reduce();
    assert.equal(reduced.uncommittedCount, 0, 'the first repair completes and the run reduces');
    assert.equal(reduced.recovery.tornJournalFragments, 1, 'the preserved fragment stays visible in the reduction');
  });
});

test('direct evidence completes a second repair whose newline-terminated rejected line crashed before the sidecar replacement', async () => {
  await withDirectProbeRun('zcode-direct-observer-', async (run) => {
    const nonce = directRunNonce();
    const writers = makeDirectProbeWriters(run, nonce);
    const eventsPath = join(run, 'events.jsonl');
    const journalPath = join(run, 'events-seal.jsonl');
    const tornPath = join(run, 'journal-torn.jsonl');
    const intentPath = join(run, 'repair-intent.json');
    const label = directLabel();
    const callNonce = directCallNonce();
    // The FIRST repair completes: the torn sidecar holds one fragment
    // record, anchored — a ZERO-length tail for the next repair.
    await withDirectProbeRepairFixture(run, nonce, writers, label, callNonce);
    await writers.driverAppend({ kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'error-result' });
    const anchoredSidecarBytes = await readFile(tornPath);
    // A second journal tear whose partial line NEWLINE-TERMINATED — a
    // complete, structurally rejected final line — and a second repair that
    // crashes right after its ZERO-tail intent is persisted, BEFORE the
    // sidecar replacement: the torn sidecar is unchanged at its previous
    // anchor length.
    const rejectedLine2 = `{"version":1,"runNonce":"${nonce}","settle`;
    await writeFile(journalPath, `${await readFile(journalPath, 'utf8')}${rejectedLine2}\n`, { mode: 0o600 });
    const probeHandle = await open(eventsPath, 'r');
    const fileHandlePrototype = Object.getPrototypeOf(probeHandle);
    await probeHandle.close();
    const originalSync = fileHandlePrototype.sync;
    fileHandlePrototype.sync = function crashAfterZeroTailIntent(...args) {
      let intentDurable = false;
      try { readFileSync(intentPath); intentDurable = true; } catch { intentDurable = false; }
      let sidecarUnchanged = false;
      try { sidecarUnchanged = readFileSync(tornPath).equals(anchoredSidecarBytes); } catch { sidecarUnchanged = false; }
      if (intentDurable && sidecarUnchanged) {
        throw new Error('PROBE_TEST_CRASH: crash after the zero-tail intent was persisted, before the sidecar replacement');
      }
      return originalSync.apply(this, args);
    };
    try {
      await assert.rejects(
        () => writers.driverAppend({ kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'error-result' }),
        /PROBE_TEST_CRASH/,
        'the simulated crash interrupted the second repair after its zero-tail intent was persisted',
      );
    } finally { fileHandlePrototype.sync = originalSync; }
    // THE STATE: the torn sidecar unchanged at its previous anchor length,
    // the zero-tail intent durable, and the journal still ending with the
    // newline-terminated rejected final line.
    assert.deepEqual(await readFile(tornPath), anchoredSidecarBytes, 'the sidecar replacement never ran behind the crash');
    const journalAfterCrash = await readFile(journalPath, 'utf8');
    assert.ok(journalAfterCrash.endsWith(`${rejectedLine2}\n`), 'the journal still ends with the rejected final line');
    // A reconstructed fragment that does NOT match the intent refuses: the
    // rejected line is swapped for different junk, the retry refuses
    // WITHOUT writing, and the sidecar stays at its anchor.
    const swappedJournal = `${journalAfterCrash.slice(0, journalAfterCrash.length - rejectedLine2.length - 1)}{"version":1,"runNonce":"${nonce}","settleMismatch":true}\n`;
    await writeFile(journalPath, swappedJournal, { mode: 0o600 });
    await assert.rejects(
      () => writers.driverAppend({ kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'error-result' }),
      (error) => error.code === 'PROBE_OWNER_INVALID',
      'a mismatching reconstructed fragment refuses the retry',
    );
    assert.deepEqual(await readFile(tornPath), anchoredSidecarBytes, 'the refused retry never touched the sidecar');
    // THE RETRY on the intact journal: the zero-tail intent is accepted,
    // the fragment is reconstructed with the repair's own final-line
    // extraction, verified against the intent, and the repair completes.
    await writeFile(journalPath, journalAfterCrash, { mode: 0o600 });
    await writers.driverAppend({ kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'success-result' });
    const intentGone = await readFile(intentPath, 'utf8').then(() => false, (error) => error.code === 'ENOENT');
    assert.ok(intentGone, 'the resolved repair intent was removed');
    const reduced = await writers.reduce();
    assert.equal(reduced.uncommittedCount, 0, 'the second repair completes and the run reduces');
    assert.equal(reduced.recovery.tornJournalFragments, 2, 'both fragment records stay visible in the reduction');
  });
});
// --- ROUND 42: a rejected hold-started append does not prove the hold ---
// --- never committed — the append commits the record and its journal ---
// --- line BEFORE its trailing steps (intent unlinks, the run-directory ---
// --- fsync) can still fail. On failure the server must reconcile ---
// --- against the committed journal state BEFORE dropping the pending ---
// --- hold: a hold proven committed still settles durably on disconnect; ---
// --- only a hold proven never-committed drops cleanly. ---

test('direct evidence settles a hold whose start append failed after committing durably', async () => {
  await withDirectProbeRun('zcode-direct-entry-', async (run) => {
    const nonce = directRunNonce();
    const { client, server } = await connectDirectProbeClient(run, nonce);
    const eventsPath = join(run, 'events.jsonl');
    const journalPath = join(run, 'events-seal.jsonl');
    const label = directLabel();
    /** True when the journal's committed head already covers a hold-started record. */
    const holdStartCoveredByJournal = async () => {
      try {
        const eventsText = await readFile(eventsPath, 'utf8');
        const holdIndex = eventsText.split('\n').findIndex((line) => {
          try { return JSON.parse(line).kind === 'hold-started'; } catch { return false; }
        });
        if (holdIndex < 0) return false;
        const journalLines = (await readFile(journalPath, 'utf8')).split('\n').filter((line) => line.trim() !== '');
        if (journalLines.length === 0) return false;
        const head = JSON.parse(journalLines[journalLines.length - 1]);
        return Number.isSafeInteger(head.recordCount) && head.recordCount > holdIndex;
      } catch { return false; }
    };
    // Fault injection: the run-DIRECTORY fsync fails exactly once AFTER the
    // hold-started commit's journal line is written and fsynced — the
    // append commits the hold durably and then rejects.
    const probeHandle = await open(run, 'r');
    const fileHandlePrototype = Object.getPrototypeOf(probeHandle);
    await probeHandle.close();
    const originalSync = fileHandlePrototype.sync;
    let armed = true;
    fileHandlePrototype.sync = async function failHoldDirectorySyncAfterCommit(...args) {
      const isDirectory = await this.stat().then((value) => value.isDirectory(), () => false);
      if (armed && isDirectory && (await holdStartCoveredByJournal())) {
        armed = false;
        throw new Error('PROBE_TEST_CRASH: directory fsync failed after the hold-started commit');
      }
      return originalSync.apply(this, args);
    };
    try {
      const result = await client.request({ method: 'tools/call', params: { name: 'hold_direct', arguments: { probeLabel: label } } }, CallToolResultSchema);
      assert.equal(result.isError, true, 'the post-commit append failure surfaces as a tool error');
    } finally { fileHandlePrototype.sync = originalSync; }
    // THE STATE: the hold-started IS durable — its record and journal commit
    // landed; only the trailing directory fsync failed. (The reconciling
    // server may already have appended the settlements by the time the tool
    // result returns; the required shape is asserted after the disconnect.)
    const records = await readDirectProbeEvents({ runDirectory: run, runNonce: nonce });
    assert.deepEqual(records.map((record) => record.kind).slice(0, 2), ['handler-entered', 'hold-started'], 'the hold-started committed durably behind the injected failure');
    const journalLines = (await readFile(journalPath, 'utf8')).split('\n').filter((line) => line.trim() !== '');
    assert.ok(journalLines.some((line) => JSON.parse(line).recordCount === 2), 'the failure landed after the hold commit was journaled');
    // THE DISCONNECT: the durable hold must still settle durably instead of
    // being stranded by the dropped registration.
    server.probeDirectDisconnect.settlePendingHoldsOnDisconnect();
    await waitUntilDirectEventKind(run, nonce, 'worker-settled');
    const settled = await readDirectProbeEvents({ runDirectory: run, runNonce: nonce });
    assert.deepEqual(settled.map((record) => record.kind), ['handler-entered', 'hold-started', 'handler-settled', 'worker-settled'], 'the durable hold still settles on disconnect');
    assert.equal(settled[2].callNonce, settled[0].callNonce);
    assert.equal(settled[2].outcome, 'connection-closed');
    assert.equal(settled[3].workerHash, records[1].workerHash, 'the settled worker is exactly the held synthetic worker');
    assert.equal(settled[3].outcome, 'connection-closed');
    await client.close();
  });
});

test('direct evidence drops a hold whose start append failed before committing', async () => {
  await withDirectProbeRun('zcode-direct-entry-', async (run) => {
    const nonce = directRunNonce();
    const { client, server } = await connectDirectProbeClient(run, nonce);
    const eventsPath = join(run, 'events.jsonl');
    const journalPath = join(run, 'events-seal.jsonl');
    const label = directLabel();
    /** True when hold-started bytes exist in the event file but no journal commit covers them yet. */
    const holdStartWrittenButUncommitted = async () => {
      try {
        const eventsText = await readFile(eventsPath, 'utf8');
        const holdIndex = eventsText.split('\n').findIndex((line) => {
          try { return JSON.parse(line).kind === 'hold-started'; } catch { return false; }
        });
        if (holdIndex < 0) return false;
        const journalLines = (await readFile(journalPath, 'utf8')).split('\n').filter((line) => line.trim() !== '');
        const headCount = journalLines.length > 0 ? JSON.parse(journalLines[journalLines.length - 1]).recordCount : 0;
        return !(Number.isSafeInteger(headCount) && headCount > holdIndex);
      } catch { return false; }
    };
    // Fault injection: the hold-started EVENT file fsync fails — before any
    // journal commit line exists. The hold was never committed.
    const probeHandle = await open(run, 'r');
    const fileHandlePrototype = Object.getPrototypeOf(probeHandle);
    await probeHandle.close();
    const originalSync = fileHandlePrototype.sync;
    let armed = true;
    fileHandlePrototype.sync = async function failHoldEventSyncBeforeCommit(...args) {
      const isDirectory = await this.stat().then((value) => value.isDirectory(), () => false);
      if (armed && !isDirectory && (await holdStartWrittenButUncommitted())) {
        armed = false;
        throw new Error('PROBE_TEST_CRASH: event fsync failed before the hold-started commit');
      }
      return originalSync.apply(this, args);
    };
    try {
      const result = await client.request({ method: 'tools/call', params: { name: 'hold_direct', arguments: { probeLabel: label } } }, CallToolResultSchema);
      assert.equal(result.isError, true, 'the pre-commit append failure surfaces as a tool error');
    } finally { fileHandlePrototype.sync = originalSync; }
    const journalLines = (await readFile(journalPath, 'utf8')).split('\n').filter((line) => line.trim() !== '');
    assert.equal(JSON.parse(journalLines[journalLines.length - 1]).recordCount, 1, 'the failure landed before the hold commit was journaled');
    // THE DISCONNECT: nothing pending may settle — the hold was proven
    // never-committed and its registration dropped cleanly.
    server.probeDirectDisconnect.settlePendingHoldsOnDisconnect();
    await new Promise((resolve) => setTimeout(resolve, 150));
    const after = await readDirectProbeEvents({ runDirectory: run, runNonce: nonce });
    assert.equal(after.some((record) => record.kind === 'handler-settled' || record.kind === 'worker-settled'), false, 'a proven never-committed hold drops cleanly: nothing settles and nothing strands');
    await client.close();
  });
});
// --- ROUND 43: settlement is a DURABLE-READ-DRIVEN retryable task, not a ---
// --- function of the in-memory entry lifetime. A single reconciliation ---
// --- loop (the holdDirect failure path and the disconnect seam) settles ---
// --- every registered hold: unknown reads keep the registration, an ---
// --- ambiguously failed append is adjudicated by the durable read, and ---
// --- the registration drops only when BOTH terminal records are ---
// --- confirmed committed by durable reads. ---

/** True when the journal's committed head already covers a record of `kind`. */
async function directJournalCoversKind(runDirectory, kind) {
  try {
    const eventsText = await readFile(join(runDirectory, 'events.jsonl'), 'utf8');
    const kindIndex = eventsText.split('\n').findIndex((line) => {
      try { return JSON.parse(line).kind === kind; } catch { return false; }
    });
    if (kindIndex < 0) return false;
    const journalLines = (await readFile(join(runDirectory, 'events-seal.jsonl'), 'utf8')).split('\n').filter((line) => line.trim() !== '');
    if (journalLines.length === 0) return false;
    const head = JSON.parse(journalLines[journalLines.length - 1]);
    return Number.isSafeInteger(head.recordCount) && head.recordCount > kindIndex;
  } catch { return false; }
}

/** True when a record of `kind` exists in the events file but no journal commit covers it yet. */
async function directKindWrittenButUncommitted(runDirectory, kind) {
  try {
    const eventsText = await readFile(join(runDirectory, 'events.jsonl'), 'utf8');
    const kindIndex = eventsText.split('\n').findIndex((line) => {
      try { return JSON.parse(line).kind === kind; } catch { return false; }
    });
    if (kindIndex < 0) return false;
    const journalLines = (await readFile(join(runDirectory, 'events-seal.jsonl'), 'utf8')).split('\n').filter((line) => line.trim() !== '');
    const headCount = journalLines.length > 0 ? JSON.parse(journalLines[journalLines.length - 1]).recordCount : 0;
    return !(Number.isSafeInteger(headCount) && headCount > kindIndex);
  } catch { return false; }
}

/** Waits until the seal journal's committed head covers a record of `kind`. */
async function waitUntilDirectJournalCoversKind(runDirectory, kind, deadlineMs = 10_000) {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    if (await directJournalCoversKind(runDirectory, kind)) return;
    if (Date.now() > deadline) throw new Error(`${kind} never became committed in the seal journal`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test('a committed hold whose reconciliation read fails stays registered and settles on disconnect', async () => {
  await withDirectProbeRun('zcode-direct-entry-', async (run) => {
    const nonce = directRunNonce();
    const { client, server } = await connectDirectProbeClient(run, nonce);
    const journalPath = join(run, 'events-seal.jsonl');
    const label = directLabel();
    // Fault injection: the hold-started commit's run-directory fsync fails
    // AFTER the journal line is durable, and the injected failure CORRUPTS
    // the journal first — the in-append reconciliation read fails
    // ('unknown'), so the hold must stay registered.
    const probeHandle = await open(run, 'r');
    const fileHandlePrototype = Object.getPrototypeOf(probeHandle);
    await probeHandle.close();
    const originalSync = fileHandlePrototype.sync;
    let armed = true;
    let journalOriginal = null;
    fileHandlePrototype.sync = async function failHoldCommitThenCorruptJournal(...args) {
      const isDirectory = await this.stat().then((value) => value.isDirectory(), () => false);
      if (armed && isDirectory && (await directJournalCoversKind(run, 'hold-started'))) {
        armed = false;
        journalOriginal = await readFile(journalPath, 'utf8');
        await writeFile(journalPath, '{"broken":true}\n', { mode: 0o600 });
        throw new Error('PROBE_TEST_CRASH: directory fsync failed after the hold-started commit');
      }
      return originalSync.apply(this, args);
    };
    let result;
    try {
      result = await client.request({ method: 'tools/call', params: { name: 'hold_direct', arguments: { probeLabel: label } } }, CallToolResultSchema);
    } finally { fileHandlePrototype.sync = originalSync; }
    assert.equal(result.isError, true, 'the post-commit append failure surfaces as a tool error');
    assert.ok(journalOriginal !== null, 'the injection corrupted the journal after the durable hold commit');
    // Recovery: the journal is restored to its durable committed state.
    await writeFile(journalPath, journalOriginal, { mode: 0o600 });
    // THE DISCONNECT: the retained hold settles exactly once and the
    // registration drops — a second pass settles nothing further.
    server.probeDirectDisconnect.settlePendingHoldsOnDisconnect();
    await waitUntilDirectJournalCoversKind(run, 'worker-settled', 15_000);
    server.probeDirectDisconnect.settlePendingHoldsOnDisconnect();
    await new Promise((resolve) => setTimeout(resolve, 200));
    const records = await readDirectProbeEvents({ runDirectory: run, runNonce: nonce });
    assert.deepEqual(records.map((record) => record.kind), ['handler-entered', 'hold-started', 'handler-settled', 'worker-settled'], 'the terminal records land exactly once behind the reconciled hold');
    assert.equal(records[2].outcome, 'connection-closed');
    assert.equal(records[3].outcome, 'connection-closed');
    await client.close();
  });
});

test('a handler settlement append that fails pre-commit is completed by the disconnect reconciliation', async () => {
  await withDirectProbeRun('zcode-direct-entry-', async (run) => {
    const nonce = directRunNonce();
    const { client, server } = await connectDirectProbeClient(run, nonce);
    const label = directLabel();
    const held = client.request({ method: 'tools/call', params: { name: 'hold_direct', arguments: { probeLabel: label } } }, CallToolResultSchema);
    await waitUntilDirectEventKind(run, nonce, 'hold-started');
    // Fault injection: the handler-settled EVENT fsync fails once — before
    // any journal commit line exists for it.
    const probeHandle = await open(run, 'r');
    const fileHandlePrototype = Object.getPrototypeOf(probeHandle);
    await probeHandle.close();
    const originalSync = fileHandlePrototype.sync;
    let armed = true;
    fileHandlePrototype.sync = async function failHandlerSettledEventSync(...args) {
      const isDirectory = await this.stat().then((value) => value.isDirectory(), () => false);
      if (armed && !isDirectory && (await directKindWrittenButUncommitted(run, 'handler-settled'))) {
        armed = false;
        throw new Error('PROBE_TEST_CRASH: handler-settled fsync failed before its commit');
      }
      return originalSync.apply(this, args);
    };
    try {
      server.probeDirectDisconnect.settlePendingHoldsOnDisconnect();
      await waitUntilDirectJournalCoversKind(run, 'worker-settled', 15_000);
    } finally { fileHandlePrototype.sync = originalSync; }
    const records = await readDirectProbeEvents({ runDirectory: run, runNonce: nonce });
    const journalLines = (await readFile(join(run, 'events-seal.jsonl'), 'utf8')).split('\n').filter((line) => line.trim() !== '');
    assert.equal(JSON.parse(journalLines[journalLines.length - 1]).recordCount, 4, 'all four records are committed, not merely written');
    assert.deepEqual(records.map((record) => record.kind), ['handler-entered', 'hold-started', 'handler-settled', 'worker-settled'], 'the disconnect completes the failed handler settlement exactly once');
    assert.equal(records[2].outcome, 'connection-closed');
    assert.equal(records[3].outcome, 'connection-closed');
    await held;
    await client.close();
  });
});

test('an ambiguously failed settlement append is reconciled by the durable committed read', async () => {
  await withDirectProbeRun('zcode-direct-entry-', async (run) => {
    const nonce = directRunNonce();
    const { client, server } = await connectDirectProbeClient(run, nonce);
    const label = directLabel();
    const held = client.request({ method: 'tools/call', params: { name: 'hold_direct', arguments: { probeLabel: label } } }, CallToolResultSchema);
    await waitUntilDirectEventKind(run, nonce, 'hold-started');
    // Fault injection: the handler-settled append commits its journal line
    // and THEN the run-directory fsync fails — an ambiguous failure whose
    // commitment only the durable read can adjudicate.
    const probeHandle = await open(run, 'r');
    const fileHandlePrototype = Object.getPrototypeOf(probeHandle);
    await probeHandle.close();
    const originalSync = fileHandlePrototype.sync;
    let armed = true;
    fileHandlePrototype.sync = async function failHandlerSettledDirectorySyncAfterCommit(...args) {
      const isDirectory = await this.stat().then((value) => value.isDirectory(), () => false);
      if (armed && isDirectory && (await directJournalCoversKind(run, 'handler-settled'))) {
        armed = false;
        throw new Error('PROBE_TEST_CRASH: directory fsync failed after the handler-settled commit');
      }
      return originalSync.apply(this, args);
    };
    try {
      server.probeDirectDisconnect.settlePendingHoldsOnDisconnect();
      await waitUntilDirectJournalCoversKind(run, 'worker-settled', 15_000);
    } finally { fileHandlePrototype.sync = originalSync; }
    const records = await readDirectProbeEvents({ runDirectory: run, runNonce: nonce });
    const journalLines = (await readFile(join(run, 'events-seal.jsonl'), 'utf8')).split('\n').filter((line) => line.trim() !== '');
    assert.equal(JSON.parse(journalLines[journalLines.length - 1]).recordCount, 4, 'all four records are committed, not merely written');
    assert.deepEqual(records.map((record) => record.kind), ['handler-entered', 'hold-started', 'handler-settled', 'worker-settled'], 'the ambiguous failure is reconciled by the durable read without duplicating the record');
    assert.equal(records[2].outcome, 'connection-closed');
    assert.equal(records[3].outcome, 'connection-closed');
    await held;
    await client.close();
  });
});

test('a worker settlement append that fails after the handler settlement is completed on disconnect', async () => {
  await withDirectProbeRun('zcode-direct-entry-', async (run) => {
    const nonce = directRunNonce();
    const { client, server } = await connectDirectProbeClient(run, nonce);
    const label = directLabel();
    const held = client.request({ method: 'tools/call', params: { name: 'hold_direct', arguments: { probeLabel: label } } }, CallToolResultSchema);
    await waitUntilDirectEventKind(run, nonce, 'hold-started');
    // Fault injection: the worker-settled EVENT fsync fails once, while the
    // handler settlement is already committed.
    const probeHandle = await open(run, 'r');
    const fileHandlePrototype = Object.getPrototypeOf(probeHandle);
    await probeHandle.close();
    const originalSync = fileHandlePrototype.sync;
    let armed = true;
    fileHandlePrototype.sync = async function failWorkerSettledEventSync(...args) {
      const isDirectory = await this.stat().then((value) => value.isDirectory(), () => false);
      if (armed && !isDirectory && (await directKindWrittenButUncommitted(run, 'worker-settled'))) {
        armed = false;
        throw new Error('PROBE_TEST_CRASH: worker-settled fsync failed before its commit');
      }
      return originalSync.apply(this, args);
    };
    try {
      server.probeDirectDisconnect.settlePendingHoldsOnDisconnect();
      await waitUntilDirectJournalCoversKind(run, 'worker-settled', 15_000);
    } finally { fileHandlePrototype.sync = originalSync; }
    const records = await readDirectProbeEvents({ runDirectory: run, runNonce: nonce });
    const journalLines = (await readFile(join(run, 'events-seal.jsonl'), 'utf8')).split('\n').filter((line) => line.trim() !== '');
    assert.equal(JSON.parse(journalLines[journalLines.length - 1]).recordCount, 4, 'all four records are committed, not merely written');
    assert.deepEqual(records.map((record) => record.kind), ['handler-entered', 'hold-started', 'handler-settled', 'worker-settled'], 'the disconnect completes only the missing worker settlement behind the committed handler settlement');
    assert.equal(records[2].outcome, 'connection-closed');
    assert.equal(records[3].outcome, 'connection-closed');
    await held;
    await client.close();
  });
});
// --- ROUND 44: settlement must not stall until disconnect. holdDirect ---
// --- keeps a bounded retry task active for every decided, registered ---
// --- hold (transient faults converge while the connection is open), and ---
// --- a budget expiry surfaces an UNSETTLED result instead of a clean ---
// --- held result, with the registration persisting for the disconnect ---
// --- pass. ---

test('a transient settlement failure recovers while the connection stays open', async () => {
  await withDirectProbeRun('zcode-direct-entry-', async (run) => {
    const nonce = directRunNonce();
    const { client, server } = await connectDirectProbeClient(run, nonce);
    const label = directLabel();
    const abortController = new AbortController();
    const held = client.request({ method: 'tools/call', params: { name: 'hold_direct', arguments: { probeLabel: label } } }, CallToolResultSchema, { signal: abortController.signal }).catch((error) => error);
    await waitUntilDirectEventKind(run, nonce, 'hold-started');
    // Fault injection: the handler-settled EVENT fsync fails once — a
    // transient, pre-commit terminal write failure.
    const probeHandle = await open(run, 'r');
    const fileHandlePrototype = Object.getPrototypeOf(probeHandle);
    await probeHandle.close();
    const originalSync = fileHandlePrototype.sync;
    let armed = true;
    fileHandlePrototype.sync = async function failHandlerSettledEventSyncOnce(...args) {
      const isDirectory = await this.stat().then((value) => value.isDirectory(), () => false);
      if (armed && !isDirectory && (await directKindWrittenButUncommitted(run, 'handler-settled'))) {
        armed = false;
        throw new Error('PROBE_TEST_CRASH: handler-settled fsync failed before its commit');
      }
      return originalSync.apply(this, args);
    };
    try {
      // Release the hold WITHOUT disconnecting: the request abort decides
      // the 'cancelled' outcome and the active settlement retry task must
      // converge while the connection stays open.
      abortController.abort();
      await waitUntilDirectJournalCoversKind(run, 'worker-settled', 15_000);
    } finally { fileHandlePrototype.sync = originalSync; }
    const records = await readDirectProbeEvents({ runDirectory: run, runNonce: nonce });
    assert.deepEqual(records.map((record) => record.kind), ['handler-entered', 'hold-started', 'handler-settled', 'worker-settled'], 'both terminal records commit exactly once without any disconnect');
    assert.equal(records[2].outcome, 'cancelled');
    assert.equal(records[3].outcome, 'cancelled');
    // The connection is still open: the disconnect seam settles nothing
    // further — the hold was already settled and deregistered.
    server.probeDirectDisconnect.settlePendingHoldsOnDisconnect();
    await new Promise((resolve) => setTimeout(resolve, 200));
    const after = await readDirectProbeEvents({ runDirectory: run, runNonce: nonce });
    assert.equal(after.length, records.length, 'no disconnect settlement was needed');
    await held;
    await client.close();
  });
});

test('a settlement that cannot complete within the retry budget surfaces unsettled and still completes on disconnect', async () => {
  await withDirectProbeRun('zcode-direct-entry-', async (run) => {
    const nonce = directRunNonce();
    const { client, server } = await connectDirectProbeClient(run, nonce);
    const journalPath = join(run, 'events-seal.jsonl');
    const label = directLabel();
    // Fault injection: the hold-started commit's run-directory fsync fails
    // AFTER the journal line is durable, and the injected failure CORRUPTS
    // the journal for the WHOLE budget — every reconciliation read fails
    // ('unknown') until the test restores it.
    const probeHandle = await open(run, 'r');
    const fileHandlePrototype = Object.getPrototypeOf(probeHandle);
    await probeHandle.close();
    const originalSync = fileHandlePrototype.sync;
    let armed = true;
    let journalOriginal = null;
    fileHandlePrototype.sync = async function corruptJournalForWholeBudget(...args) {
      const isDirectory = await this.stat().then((value) => value.isDirectory(), () => false);
      if (armed && isDirectory && (await directJournalCoversKind(run, 'hold-started'))) {
        armed = false;
        journalOriginal = await readFile(journalPath, 'utf8');
        await writeFile(journalPath, '{"broken":true}\n', { mode: 0o600 });
        throw new Error('PROBE_TEST_CRASH: directory fsync failed after the hold-started commit');
      }
      return originalSync.apply(this, args);
    };
    let result;
    try {
      result = await client.request({ method: 'tools/call', params: { name: 'hold_direct', arguments: { probeLabel: label } } }, CallToolResultSchema);
    } finally { fileHandlePrototype.sync = originalSync; }
    assert.ok(journalOriginal !== null, 'the injection corrupted the journal after the durable hold commit');
    // THE BUDGET EXPIRY: the result surfaces unsettled instead of surfacing
    // only the raw append failure.
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /PROBE_SETTLEMENT_UNSETTLED/, 'the budget expiry surfaces an unsettled result');
    // Recovery: the journal is restored; the registration persisted, so a
    // LATER disconnect still completes the settlements.
    await writeFile(journalPath, journalOriginal, { mode: 0o600 });
    server.probeDirectDisconnect.settlePendingHoldsOnDisconnect();
    await waitUntilDirectJournalCoversKind(run, 'worker-settled', 15_000);
    const records = await readDirectProbeEvents({ runDirectory: run, runNonce: nonce });
    assert.deepEqual(records.map((record) => record.kind), ['handler-entered', 'hold-started', 'handler-settled', 'worker-settled'], 'the persisted registration settles exactly once on the later disconnect');
    assert.equal(records[2].outcome, 'connection-closed');
    assert.equal(records[3].outcome, 'connection-closed');
    await client.close();
  });
});
// --- ROUND 45 finding 1: reduction refuses an un-repaired seal-journal ---
// --- tail (torn partial line or structurally rejected final line). The ---
// --- abrupt-kill shape (journal simply SHORTER than the event log) keeps ---
// --- reducing with uncommittedCount. ---

test('reduction refuses an un-repaired seal-journal tail until the repairing append lands', async () => {
  await withDirectProbeRun('zcode-direct-observer-', async (run) => {
    const nonce = directRunNonce();
    const writers = makeDirectProbeWriters(run, nonce);
    const { label, callNonce } = await withDirectProbeRecoveryFixture(run, nonce, writers);
    const journalPath = join(run, 'events-seal.jsonl');
    const reduceOptions = { runDirectory: run, runNonce: nonce, ownerSecret: DIRECT_DRIVER_SECRET, ownerPid: process.pid };
    // Baseline: the COMPLETE journal over an uncommitted event tail is the
    // approved abrupt-kill shape and keeps reducing with uncommittedCount.
    const anchor = directProbeSealHead({ runDirectory: run, runNonce: nonce, ownerSecret: DIRECT_DRIVER_SECRET });
    const baseline = await reduceDirectProbeLog({ ...reduceOptions, expectedFinalState: anchor });
    assert.equal(baseline.uncommittedCount, 1, 'the abrupt-kill shape still reduces with uncommittedCount');
    // A torn final journal line: unanchored bytes the reduction can neither
    // report nor bind — reduction must refuse.
    const tornFragment = `{"version":1,"runNonce":"${nonce}","recordCo`;
    const journalBeforeTear = await readFile(journalPath, 'utf8');
    await writeFile(journalPath, `${journalBeforeTear}${tornFragment}`, { mode: 0o600 });
    await assert.rejects(
      () => reduceDirectProbeLog({ ...reduceOptions, expectedFinalState: anchor }),
      /PROBE_OWNER_INVALID/,
      'a torn final journal line refuses reduction',
    );
    // A newline-terminated structurally rejected final line refuses too.
    await writeFile(journalPath, `${journalBeforeTear}${tornFragment}\n`, { mode: 0o600 });
    await assert.rejects(
      () => reduceDirectProbeLog({ ...reduceOptions, expectedFinalState: anchor }),
      /PROBE_OWNER_INVALID/,
      'a rejected final journal line refuses reduction',
    );
    // The repairing append preserves the fragment, truncates the journal,
    // and commits: reduction succeeds again.
    await writers.driverAppend({ kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'success-result' });
    const final = await directDriverAppend(run, nonce, { kind: 'cleanup-observed', outcome: 'released', source: 'driver' });
    const reduced = await reduceDirectProbeLog({ ...reduceOptions, expectedFinalState: final.commit });
    assert.equal(reduced.uncommittedCount, 0, 'after the repair the run reduces cleanly');
    assert.equal(reduced.recovery.tornJournalFragments, 1, 'the preserved fragment stays part of the reduction surface');
  });
});

// --- ROUND 45 finding 2: symlinked evidence files refuse closed on every ---
// --- path. A byte-identical alias OUTSIDE the private run directory is ---
// --- still a boundary violation. ---

/** The evidence files whose reads and repair paths must reject symlinks. */
const DIRECT_EVIDENCE_FILENAMES = [
  'events-seal.jsonl',
  'handler-owner.json',
  'recovery-intent.json',
  'repair-intent.json',
  'events-uncommitted.jsonl',
  'journal-torn.jsonl',
  'journal-torn-partial.jsonl',
];

/** A run whose journal anchors recovery, torn-fragment, AND partial evidence, so every walk reads all sidecars. */
async function withDirectProbeRichEvidenceRun(run, nonce, writers) {
  const recoveryJoin = await withDirectProbeRecoveryFixture(run, nonce, writers);
  await writers.driverAppend({ kind: 'rpc-observed', probeLabel: recoveryJoin.label, callNonce: recoveryJoin.callNonce, outcome: 'error-result' });
  const repairJoin = { label: directLabel(), callNonce: directCallNonce() };
  await withDirectProbeRepairFixture(run, nonce, writers, repairJoin.label, repairJoin.callNonce);
  await withDirectProbeIntentFirstPartialFixture(run, nonce, writers, repairJoin.label, repairJoin.callNonce, 'pa');
  return recoveryJoin;
}

/** Plants a symlink at an evidence path pointing OUTSIDE the run directory; returns the restore function. */
async function plantEvidenceSymlink(run, filename, outsideDir) {
  const evidencePath = join(run, filename);
  let original = null;
  try { original = await readFile(evidencePath); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const copyPath = join(outsideDir, filename);
  await writeFile(copyPath, original ?? Buffer.from('{"planted":true}\n', 'utf8'), { mode: 0o600 });
  await rm(evidencePath, { force: true });
  await symlink(copyPath, evidencePath);
  return async () => {
    await rm(evidencePath, { force: true });
    if (original !== null) await writeFile(evidencePath, original, { mode: 0o600 });
  };
}

test('direct evidence refuses symlinked evidence files on the reduction path', async () => {
  await withDirectProbeRun('zcode-direct-observer-', async (run) => {
    const nonce = directRunNonce();
    const writers = makeDirectProbeWriters(run, nonce);
    await withDirectProbeRichEvidenceRun(run, nonce, writers);
    const outsideDir = await mkdtemp(join(tmpdir(), 'evidence-outside-'));
    try {
      for (const filename of DIRECT_EVIDENCE_FILENAMES) {
        const restore = await plantEvidenceSymlink(run, filename, outsideDir);
        try {
          await assert.rejects(
            () => reduceDirectProbeLog({ runDirectory: run, runNonce: nonce, ownerSecret: DIRECT_DRIVER_SECRET, ownerPid: process.pid, expectedFinalState: writers.anchor() }),
            /PROBE_LOG_SYMLINK/,
            `${filename} must refuse the reduction while symlinked`,
          );
        } finally { await restore(); }
      }
    } finally { await rm(outsideDir, { recursive: true, force: true }); }
  });
});

test('direct evidence refuses symlinked evidence files on the append path', async () => {
  await withDirectProbeRun('zcode-direct-observer-', async (run) => {
    const nonce = directRunNonce();
    const writers = makeDirectProbeWriters(run, nonce);
    await withDirectProbeRichEvidenceRun(run, nonce, writers);
    const outsideDir = await mkdtemp(join(tmpdir(), 'evidence-outside-'));
    try {
      for (const filename of DIRECT_EVIDENCE_FILENAMES) {
        const restore = await plantEvidenceSymlink(run, filename, outsideDir);
        try {
          await assert.rejects(
            () => writers.handlerAppend({ kind: 'handler-entered', probeLabel: directLabel(), callNonce: directCallNonce(), serverInstanceHash: directHash('fixture-instance') }),
            /PROBE_LOG_SYMLINK/,
            `${filename} must refuse the append while symlinked`,
          );
        } finally { await restore(); }
      }
    } finally { await rm(outsideDir, { recursive: true, force: true }); }
  });
});
// --- ROUND 46 finding 1: reduction refuses EVERY unverified seal-journal ---
// --- suffix: whenever complete journal lines remain beyond the verified ---
// --- prefix, regardless of count or rejection reason (two rejected ---
// --- lines, or an authenticated final line whose event digest fails). ---

test('reduction refuses every unverified seal-journal suffix beyond the verified prefix', async () => {
  await withDirectProbeRun('zcode-direct-observer-', async (run) => {
    const nonce = directRunNonce();
    const writers = makeDirectProbeWriters(run, nonce);
    await withDirectProbeRecoveryFixture(run, nonce, writers);
    const journalPath = join(run, 'events-seal.jsonl');
    const reduceOptions = { runDirectory: run, runNonce: nonce, ownerSecret: DIRECT_DRIVER_SECRET, ownerPid: process.pid };
    const anchor = directProbeSealHead({ runDirectory: run, runNonce: nonce, ownerSecret: DIRECT_DRIVER_SECRET });
    const journalBefore = await readFile(journalPath, 'utf8');
    // TWO structurally rejected newline-terminated lines after the valid
    // head: exactly-one-line rejection detection never fires on this shape,
    // yet both lines are unverified suffix bytes.
    await writeFile(
      journalPath,
      `${journalBefore}{"version":1,"runNonce":"${nonce}","recordCo\n{"version":1,"runNonce":"${nonce}","settleMismatch":true}\n`,
      { mode: 0o600 },
    );
    await assert.rejects(
      () => reduceDirectProbeLog({ ...reduceOptions, expectedFinalState: anchor }),
      /PROBE_OWNER_INVALID/,
      'two rejected final journal lines refuse reduction',
    );
    // An AUTHENTICATED final commit whose event digest fails its bytes is
    // the same unverified suffix.
    const wrongDigest = createHash('sha256').update(Buffer.from('unverified-suffix-payload')).digest('hex');
    const sealMac = createHmac('sha256', Buffer.from(DIRECT_DRIVER_SECRET, 'utf8')).update(JSON.stringify({ eventsDigest: wrongDigest, recordCount: 4, runNonce: nonce })).digest('hex');
    await writeFile(
      journalPath,
      `${journalBefore}${JSON.stringify({ version: 1, runNonce: nonce, recordCount: 4, eventsDigest: wrongDigest, sealMac })}\n`,
      { mode: 0o600 },
    );
    await assert.rejects(
      () => reduceDirectProbeLog({ ...reduceOptions, expectedFinalState: anchor }),
      /PROBE_OWNER_INVALID/,
      'an authenticated final line with a failing event digest refuses reduction',
    );
  });
});

// --- ROUND 46 finding 2: evidence validation and IO share ONE file ---
// --- descriptor. A swap of the directory entry between validation and ---
// --- IO can no longer redirect the read through an alias: the swap fires ---
// --- inside the gap and the bytes still come from the descriptor's ---
// --- original inode. ---

test('evidence IO is descriptor-pinned across a validation-to-IO swap', async () => {
  await withDirectProbeRun('zcode-direct-observer-', async (run) => {
    const nonce = directRunNonce();
    const writers = makeDirectProbeWriters(run, nonce);
    const { label, callNonce } = await withDirectProbeRecoveryFixture(run, nonce, writers);
    const journalPath = join(run, 'events-seal.jsonl');
    const journalOriginal = await readFile(journalPath);
    const outsideDir = await mkdtemp(join(tmpdir(), 'evidence-outside-'));
    const aliasPath = join(outsideDir, 'events-seal.alias.jsonl');
    await writeFile(aliasPath, Buffer.from('{"version":1,"planted-alias":true}\n', 'utf8'), { mode: 0o600 });
    // The injection seam: the evidence helper reads through the node:fs
    // object, so the test swaps the directory entry for the outside alias
    // exactly once, between the descriptor validation and the byte read.
    let swapFired = false;
    const realReadFileSync = fs.readFileSync;
    fs.readFileSync = function readFileSyncWithGapSwap(target, encoding) {
      if (typeof target === 'number' && !swapFired) {
        // THE GAP: at this moment the descriptor is already validated and
        // the directory entry is swapped for the outside alias. The alias's
        // marker bytes would fail the journal walk if they were read.
        swapFired = true;
        rmSync(journalPath, { force: true });
        symlinkSync(aliasPath, journalPath);
        const bytes = realReadFileSync(target, encoding);
        rmSync(journalPath, { force: true });
        writeFileSync(journalPath, journalOriginal, { mode: 0o600 });
        return bytes;
      }
      return realReadFileSync(target, encoding);
    };
    try {
      // ROUND 48: the read is descriptor-pinned, so the gap swap cannot
      // poison the bytes; but the swap DID change the journal inode after
      // verification, so the commit refuses it (nothing durable reported).
      await assert.rejects(
        () => writers.driverAppend({ kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'success-result' }),
        /PROBE_LOG_REPLACED/,
        'the commit refuses the journal whose inode changed inside the gap',
      );
    } finally {
      fs.readFileSync = realReadFileSync;
    }
    assert.ok(swapFired, 'the swap fired inside the validation-to-IO gap');
    // The alias never entered: the journal carries the ORIGINAL bytes —
    // never the marker bytes that would have failed the walk.
    const journalNow = await readFile(journalPath, 'utf8');
    assert.doesNotMatch(journalNow, /planted-alias/, 'the alias bytes were never read or written');
    // The entry is restored to a regular file: the next append commits
    // normally over the re-verified descriptor.
    await writers.driverAppend({ kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'success-result' });
    const anchorAfter = writers.anchor();
    assert.ok(anchorAfter !== null && anchorAfter.recordCount > 3, 'the run stays healthy after the refused swap');
    await rm(outsideDir, { recursive: true, force: true });
  });
});
// --- ROUND 47: the recovery truncation is a WRITE through the validated ---
// --- descriptor. A directory-entry swap between validation and ---
// --- truncation must refuse the recovery and leave any outside alias ---
// --- untouched; a swapped-in regular file is refused by descriptor ---
// --- identity (same inode/mode as validated). ---

/** Installs the gap injection on the recovery truncation's no-follow open. */
function injectRecoveryTruncationGap(eventsPath, mutate) {
  let swapFired = false;
  const realOpen = fsp.open;
  fsp.open = async function openWithRecoveryGapSwap(target, flags, ...rest) {
    if (!swapFired && target === eventsPath && typeof flags === 'number'
      && (flags & fs.constants.O_WRONLY) === fs.constants.O_WRONLY) {
      swapFired = true;
      await mutate();
    }
    return realOpen(target, flags, ...rest);
  };
  return { restore: () => { fsp.open = realOpen; }, fired: () => swapFired };
}

test('recovery truncation refuses a symlink swap between validation and truncation', async () => {
  await withDirectProbeRun('zcode-direct-observer-', async (run) => {
    const nonce = directRunNonce();
    const writers = makeDirectProbeWriters(run, nonce);
    const { label, callNonce } = await withDirectProbeRecoveryFixture(run, nonce, writers);
    const eventsPath = join(run, 'events.jsonl');
    const eventsOriginal = await readFile(eventsPath);
    const outsideDir = await mkdtemp(join(tmpdir(), 'evidence-outside-'));
    const aliasPath = join(outsideDir, 'events.alias.jsonl');
    const aliasBytes = Buffer.from('{"writable-outside-alias":true}\n', 'utf8');
    await writeFile(aliasPath, aliasBytes, { mode: 0o600 });
    // The injection: when the recovery truncation opens events.jsonl with
    // O_WRONLY | O_NOFOLLOW, the directory entry is swapped for a symlink
    // to the writable OUTSIDE alias BEFORE the open resolves.
    const injection = injectRecoveryTruncationGap(eventsPath, async () => {
      await rm(eventsPath, { force: true });
      await symlink(aliasPath, eventsPath);
    });
    try {
      await assert.rejects(
        () => writers.driverAppend({ kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'success-result' }),
        /PROBE_LOG_SYMLINK/,
        'the swapped-in symlink refuses the recovery truncation',
      );
    } finally { injection.restore(); }
    assert.ok(injection.fired(), 'the swap fired between validation and truncation');
    // The outside alias is untouched: the truncation never followed it.
    assert.deepEqual(await readFile(aliasPath), aliasBytes, 'the outside alias file was never truncated');
    // Restore the original event log entry: the recovery completes and the
    // run stays healthy.
    await rm(eventsPath, { force: true });
    await writeFile(eventsPath, eventsOriginal, { mode: 0o600 });
    await writers.driverAppend({ kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'error-result' });
    const reduced = await writers.reduce();
    assert.equal(reduced.uncommittedCount, 0, 'the recovery completes after the alias is removed');
    await rm(outsideDir, { recursive: true, force: true });
  });
});

test('recovery truncation refuses a swapped-in regular file by descriptor identity', async () => {
  await withDirectProbeRun('zcode-direct-observer-', async (run) => {
    const nonce = directRunNonce();
    const writers = makeDirectProbeWriters(run, nonce);
    const { label, callNonce } = await withDirectProbeRecoveryFixture(run, nonce, writers);
    const eventsPath = join(run, 'events.jsonl');
    const eventsOriginal = await readFile(eventsPath);
    // The injection: a DIFFERENT regular 0600 file is renamed over the
    // validated entry before the truncation open resolves — descriptor
    // identity (inode) must refuse it.
    const decoyPath = join(run, 'decoy.jsonl');
    const injection = injectRecoveryTruncationGap(eventsPath, async () => {
      await writeFile(decoyPath, Buffer.from('{"decoy":true}\n', 'utf8'), { mode: 0o600 });
      await rename(decoyPath, eventsPath);
    });
    try {
      await assert.rejects(
        () => writers.driverAppend({ kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'success-result' }),
        /PROBE_LOG_REPLACED/,
        'a swapped-in regular file refuses the recovery truncation by descriptor identity',
      );
    } finally { injection.restore(); }
    assert.ok(injection.fired(), 'the swap fired between validation and truncation');
    // Restore the original event log entry: the recovery completes.
    await writeFile(eventsPath, eventsOriginal, { mode: 0o600 });
    await writers.driverAppend({ kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'error-result' });
    const reduced = await writers.reduce();
    assert.equal(reduced.uncommittedCount, 0, 'the recovery completes after the entry is restored');
  });
});
// --- ROUND 48 finding 1: the repair truncations verify the VALIDATED ---
// --- inode. A mode-0600 regular file swapped in between the ---
// --- authentication reads and a truncation open is refused by ---
// --- descriptor identity instead of being truncated. ---

/** Installs the gap injection on a repair truncation's no-follow write open. */
function injectRepairTruncationSwap(targetPath, decoyBytes) {
  let swapFired = false;
  let swappedIn = null;
  const realOpenSync = fs.openSync;
  fs.openSync = function openSyncWithRepairSwap(target, flags, ...rest) {
    if (!swapFired && target === targetPath && typeof flags === 'number'
      && (flags & fs.constants.O_WRONLY) === fs.constants.O_WRONLY) {
      swapFired = true;
      swappedIn = readFileSync(target);
      const decoyPath = `${targetPath}.round48-decoy`;
      writeFileSync(decoyPath, decoyBytes, { mode: 0o600 });
      renameSync(decoyPath, target);
    }
    return realOpenSync(target, flags, ...rest);
  };
  return {
    fired: () => swapFired,
    swappedIn: () => swappedIn,
    restore: () => { fs.openSync = realOpenSync; },
  };
}

test('repair torn-sidecar truncation refuses a swapped-in regular file', async () => {
  await withDirectProbeRun('zcode-direct-observer-', async (run) => {
    const nonce = directRunNonce();
    const writers = makeDirectProbeWriters(run, nonce);
    await withDirectProbeRecoveryFixture(run, nonce, writers);
    const repairJoin = { label: directLabel(), callNonce: directCallNonce() };
    await withDirectProbeRepairFixture(run, nonce, writers, repairJoin.label, repairJoin.callNonce);
    const tornPath = join(run, 'journal-torn.jsonl');
    // The injection: when the repair's TORN-sidecar truncation opens the
    // sidecar for writing, a different mode-0600 regular file has been
    // renamed over the validated entry.
    const injection = injectRepairTruncationSwap(tornPath, Buffer.from('{"decoy":true}\n', 'utf8'));
    let refused = null;
    try {
      await withDirectProbeIntentFirstPartialFixture(run, nonce, writers, repairJoin.label, repairJoin.callNonce, 'ta');
    } catch (error) { refused = error; } finally { injection.restore(); }
    assert.ok(injection.fired(), 'the swap fired at the torn truncation open');
    assert.ok(refused !== null, 'the repairing append was interrupted');
    assert.match(String(refused), /PROBE_LOG_REPLACED/, 'the swapped-in file is refused by descriptor identity');
    // Restore the real sidecar bytes: the journal still carries its tear
    // (the refusal fired at the TORN truncation, before the journal's), so
    // the retry completes the repair.
    await writeFile(tornPath, injection.swappedIn(), { mode: 0o600 });
    await writers.driverAppend({ kind: 'rpc-observed', probeLabel: repairJoin.label, callNonce: repairJoin.callNonce, outcome: 'success-result' });
    const reduced = await writers.reduce();
    assert.equal(reduced.uncommittedCount, 0, 'the repair completes after the swap is undone');
  });
});

test('repair journal truncation refuses a swapped-in regular file', async () => {
  await withDirectProbeRun('zcode-direct-observer-', async (run) => {
    const nonce = directRunNonce();
    const writers = makeDirectProbeWriters(run, nonce);
    await withDirectProbeRecoveryFixture(run, nonce, writers);
    const repairJoin = { label: directLabel(), callNonce: directCallNonce() };
    await withDirectProbeRepairFixture(run, nonce, writers, repairJoin.label, repairJoin.callNonce);
    const journalPath = join(run, 'events-seal.jsonl');
    // The injection: when the repair's JOURNAL truncation opens the journal
    // for writing, a different mode-0600 regular file has been renamed over
    // the validated entry.
    const injection = injectRepairTruncationSwap(journalPath, Buffer.from('{"decoy":true}\n', 'utf8'));
    let refused = null;
    try {
      await withDirectProbeIntentFirstPartialFixture(run, nonce, writers, repairJoin.label, repairJoin.callNonce, 'tb');
    } catch (error) { refused = error; } finally { injection.restore(); }
    assert.ok(injection.fired(), 'the swap fired at the journal truncation open');
    assert.ok(refused !== null, 'the repairing append was interrupted');
    assert.match(String(refused), /PROBE_LOG_REPLACED/, 'the swapped-in journal is refused by descriptor identity');
    // Restore the real journal bytes (captured at swap time, WITH the
    // tear): the retry completes the repair.
    await writeFile(journalPath, injection.swappedIn(), { mode: 0o600 });
    await writers.driverAppend({ kind: 'rpc-observed', probeLabel: repairJoin.label, callNonce: repairJoin.callNonce, outcome: 'success-result' });
    const reduced = await writers.reduce();
    assert.equal(reduced.uncommittedCount, 0, 'the repair completes after the swap is undone');
  });
});

// --- ROUND 48 finding 2: the seal commit verifies the journal descriptor's
// --- identity against the verified journal, so a regular-file swap in the
// --- verification-to-commit gap refuses the append, reports nothing
// --- durable, and leaves the swapped file without the commit line. ---

test('seal commit refuses a journal swapped in after verification', async () => {
  await withDirectProbeRun('zcode-direct-observer-', async (run) => {
    const nonce = directRunNonce();
    const writers = makeDirectProbeWriters(run, nonce);
    const { label, callNonce } = await withDirectProbeRecoveryFixture(run, nonce, writers);
    const journalPath = join(run, 'events-seal.jsonl');
    const journalOriginal = await readFile(journalPath);
    const anchorBefore = writers.anchor();
    const decoyPath = join(run, 'journal-decoy.jsonl');
    const decoyBytes = Buffer.from('{"swapped-in-decoy":true}\n', 'utf8');
    await writeFile(decoyPath, decoyBytes, { mode: 0o600 });
    // The injection: when the seal commit opens the journal for appending
    // (after the chain verification), a different regular 0600 file has
    // been renamed over the verified entry.
    let swapFired = false;
    const realOpen = fsp.open;
    fsp.open = async function openWithCommitGapSwap(target, flags, ...rest) {
      if (!swapFired && target === journalPath && typeof flags === 'number'
        && (flags & fs.constants.O_WRONLY) === fs.constants.O_WRONLY) {
        swapFired = true;
        renameSync(decoyPath, journalPath);
      }
      return realOpen(target, flags, ...rest);
    };
    try {
      await assert.rejects(
        () => writers.driverAppend({ kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'success-result' }),
        /PROBE_LOG_REPLACED/,
        'the swapped-in journal refuses the commit',
      );
    } finally {
      fsp.open = realOpen;
      if (process.env.DEBUG_DIRECT_PROBE) console.error('DEBUG-R48C', JSON.stringify({ swapFired, anchor: writers.anchor(), journalNow: (await readFile(journalPath, 'utf8')).slice(0, 80) }));
    }
    assert.ok(swapFired, 'the swap fired between verification and commit');
    // Nothing was reported durable: the anchor did not advance, and the
    // swapped-in file carries no commit line.
    const anchorAfter = writers.anchor();
    assert.equal(anchorAfter.recordCount, anchorBefore.recordCount, 'no commit was reported durable');
    const swappedInBytes = await readFile(journalPath);
    assert.match(String(swappedInBytes), /swapped-in-decoy/, 'the swapped-in file is in place');
    assert.doesNotMatch(swappedInBytes.toString('utf8'), /sealMac/, 'the swapped-in file never received the commit line');
    // Restore the real journal: the next append commits normally.
    await writeFile(journalPath, journalOriginal, { mode: 0o600 });
    await writers.driverAppend({ kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'success-result' });
    const reduced = await writers.reduce();
    assert.equal(reduced.uncommittedCount, 0, 'the run stays healthy after the swap is undone');
  });
});
// --- ROUND 49 finding 1: a sidecar directory fsync that soft-fails while ---
// --- a repair CREATES the torn sidecar is FATAL before the journal ---
// --- truncation — the journal stays untruncated, the intent survives, ---
// --- and the retry after the fault clears completes. ---

test('a soft sidecar-directory fsync failure is fatal before the journal truncation', async () => {
  await withDirectProbeRun('zcode-direct-observer-', async (run) => {
    const nonce = directRunNonce();
    const writers = makeDirectProbeWriters(run, nonce);
    const repairJoin = { label: directLabel(), callNonce: directCallNonce() };
    await writers.driverAppend({ kind: 'request-sent', probeLabel: repairJoin.label, tool: 'hold_direct', state: 'sent' });
    await writers.handlerAppend({ kind: 'handler-entered', probeLabel: repairJoin.label, callNonce: repairJoin.callNonce, serverInstanceHash: directHash('fixture-instance') });
    const tornPath = join(run, 'journal-torn.jsonl');
    const intentPath = join(run, 'repair-intent.json');
    const journalPath = join(run, 'events-seal.jsonl');
    // The journal tear that the sidecar-CREATING repair will repair.
    await writeFile(journalPath, `${await readFile(journalPath, 'utf8')}{"version":1,"runNonce":"${nonce}","recordCo`, { mode: 0o600 });
    // The injection: the sidecar directory-entry fsync soft-fails (EACCES
    // -> syncRunDirectory returns false) exactly when the sidecar exists,
    // the intent is durable, and the journal is still untruncated.
    const probeHandle = await open(journalPath, 'r');
    const fileHandlePrototype = Object.getPrototypeOf(probeHandle);
    await probeHandle.close();
    const originalSync = fileHandlePrototype.sync;
    let armed = true;
    fileHandlePrototype.sync = async function softFailSidecarDirectorySync(...args) {
      const isDirectory = await this.stat().then((value) => value.isDirectory(), () => false);
      if (armed && isDirectory) {
        let sidecarCreated = false;
        try { sidecarCreated = (await readFile(tornPath, 'utf8')).includes('tornMac'); } catch { sidecarCreated = false; }
        let intentDurable = false;
        try { intentDurable = (await readFile(intentPath, 'utf8')).includes('repairIntentMac'); } catch { intentDurable = false; }
        const journalText = await readFile(journalPath, 'utf8');
        if (sidecarCreated && intentDurable && !journalText.endsWith('\n')) {
          armed = false;
          const failure = new Error('EACCES: injected sidecar directory fsync failure');
          failure.code = 'EACCES';
          throw failure;
        }
      }
      return originalSync.apply(this, args);
    };
    try {
      await assert.rejects(
        () => writers.driverAppend({ kind: 'rpc-observed', probeLabel: repairJoin.label, callNonce: repairJoin.callNonce, outcome: 'success-result' }),
        /PROBE_OWNER_INVALID/,
        'the soft sidecar-directory fsync failure is fatal before the journal truncation',
      );
    } finally { fileHandlePrototype.sync = originalSync; }
    // THE STATE: the journal remains untruncated (the tear survives) and the
    // durable intent survives.
    const journalAfter = await readFile(journalPath, 'utf8');
    assert.ok(!journalAfter.endsWith('\n'), 'the journal remains untruncated behind the failed fsync');
    await readFile(intentPath, 'utf8');
    // The fault clears: the retry completes the repair and the run reduces.
    await writers.driverAppend({ kind: 'rpc-observed', probeLabel: repairJoin.label, callNonce: repairJoin.callNonce, outcome: 'success-result' });
    const intentGone = await readFile(intentPath, 'utf8').then(() => false, (error) => error.code === 'ENOENT');
    assert.ok(intentGone, 'the resolved repair intent was removed');
    const reduced = await writers.reduce();
    assert.equal(reduced.uncommittedCount, 0, 'the run reduces after the retry');
  });
});

// --- ROUND 49 finding 2: the fragment append writes to the VALIDATED ---
// --- inode. A regular-file swap between the validated truncation and the ---
// --- append open refuses PROBE_LOG_REPLACED with no fragment written. ---

test('the torn-sidecar fragment append refuses a swapped-in sidecar', async () => {
  await withDirectProbeRun('zcode-direct-observer-', async (run) => {
    const nonce = directRunNonce();
    const writers = makeDirectProbeWriters(run, nonce);
    await withDirectProbeRecoveryFixture(run, nonce, writers);
    const repairJoin = { label: directLabel(), callNonce: directCallNonce() };
    await withDirectProbeRepairFixture(run, nonce, writers, repairJoin.label, repairJoin.callNonce);
    const tornPath = join(run, 'journal-torn.jsonl');
    // The injection: between the validated truncation and the fragment
    // append, a decoy mode-0600 regular file is renamed over the sidecar.
    let swapFired = false;
    let truncatedBytes = null;
    const realOpen = fsp.open;
    fsp.open = async function openWithAppendGapSwap(target, flags, ...rest) {
      if (!swapFired && target === tornPath && typeof flags === 'number'
        && (flags & fs.constants.O_APPEND) === fs.constants.O_APPEND) {
        swapFired = true;
        truncatedBytes = await readFile(tornPath);
        const decoyPath = `${tornPath}.round49-decoy`;
        await writeFile(decoyPath, Buffer.from('{"decoy":true}\n', 'utf8'), { mode: 0o600 });
        await rename(decoyPath, tornPath);
      }
      return realOpen(target, flags, ...rest);
    };
    // The second repair (intent-first, binding the planted tail) drives the
    // truncation-then-append flow.
    try {
      await assert.rejects(
        () => withDirectProbeIntentFirstPartialFixture(run, nonce, writers, repairJoin.label, repairJoin.callNonce, 'ta'),
        /PROBE_LOG_REPLACED/,
        'the fragment append refuses the swapped-in sidecar',
      );
    } finally { fsp.open = realOpen; }
    assert.ok(swapFired, 'the swap fired at the fragment append open');
    // The decoy was never mutated: it carries no fragment record.
    assert.doesNotMatch((await readFile(tornPath, 'utf8')), /tornMac/, 'the decoy carries no fragment record');
    // Restore the truncated sidecar: the retry completes the repair.
    await writeFile(tornPath, truncatedBytes, { mode: 0o600 });
    await writers.driverAppend({ kind: 'rpc-observed', probeLabel: repairJoin.label, callNonce: repairJoin.callNonce, outcome: 'success-result' });
    const reduced = await writers.reduce();
    assert.equal(reduced.uncommittedCount, 0, 'the repair completes after the swap is undone');
  });
});
// --- ROUND 50 finding 1: the sidecar directory fsync gate runs ---
// --- UNCONDITIONALLY before the journal truncation — on the resume path ---
// --- too. A PERSISTENT soft directory fsync failure refuses every retry; ---
// --- the journal stays intact until the fault clears. ---

test('the resume path requires the sidecar directory fsync before journal truncation', async () => {
  await withDirectProbeRun('zcode-direct-observer-', async (run) => {
    const nonce = directRunNonce();
    const writers = makeDirectProbeWriters(run, nonce);
    const repairJoin = { label: directLabel(), callNonce: directCallNonce() };
    await writers.driverAppend({ kind: 'request-sent', probeLabel: repairJoin.label, tool: 'hold_direct', state: 'sent' });
    await writers.handlerAppend({ kind: 'handler-entered', probeLabel: repairJoin.label, callNonce: repairJoin.callNonce, serverInstanceHash: directHash('fixture-instance') });
    const tornPath = join(run, 'journal-torn.jsonl');
    const intentPath = join(run, 'repair-intent.json');
    const journalPath = join(run, 'events-seal.jsonl');
    await writeFile(journalPath, `${await readFile(journalPath, 'utf8')}{"version":1,"runNonce":"${nonce}","recordCo`, { mode: 0o600 });
    // The PERSISTENT injection: every run-directory fsync soft-fails while
    // the sidecar exists, the intent is durable, and the journal is
    // untruncated — across the creating attempt AND the resume retry.
    const probeHandle = await open(journalPath, 'r');
    const fileHandlePrototype = Object.getPrototypeOf(probeHandle);
    await probeHandle.close();
    const originalSync = fileHandlePrototype.sync;
    fileHandlePrototype.sync = async function persistentSoftDirSyncFailure(...args) {
      const isDirectory = await this.stat().then((value) => value.isDirectory(), () => false);
      if (isDirectory) {
        let sidecarCreated = false;
        try { sidecarCreated = (await readFile(tornPath, 'utf8')).includes('tornMac'); } catch { sidecarCreated = false; }
        let intentDurable = false;
        try { intentDurable = (await readFile(intentPath, 'utf8')).includes('repairIntentMac'); } catch { intentDurable = false; }
        const journalText = await readFile(journalPath, 'utf8');
        if (sidecarCreated && intentDurable && !journalText.endsWith('\n')) {
          const failure = new Error('EACCES: persistent sidecar directory fsync failure');
          failure.code = 'EACCES';
          throw failure;
        }
      }
      return originalSync.apply(this, args);
    };
    // Attempt 1 (creation): refuses.
    await assert.rejects(
      () => writers.driverAppend({ kind: 'rpc-observed', probeLabel: repairJoin.label, callNonce: repairJoin.callNonce, outcome: 'error-result' }),
      /PROBE_OWNER_INVALID/,
      'the creating attempt refuses on the soft directory fsync failure',
    );
    // Attempt 2 (RESUME): the sidecar already holds the fragment and the
    // intent is intact — the directory fsync gate must STILL run and refuse.
    await assert.rejects(
      () => writers.driverAppend({ kind: 'rpc-observed', probeLabel: repairJoin.label, callNonce: repairJoin.callNonce, outcome: 'error-result' }),
      /PROBE_OWNER_INVALID/,
      'the resume path refuses while the directory fsync still fails',
    );
    // The journal remains intact across both refusals.
    const journalAfter = await readFile(journalPath, 'utf8');
    assert.ok(!journalAfter.endsWith('\n'), 'the journal remains untruncated across the refusals');
    // The fault clears: the retry completes and the run reduces.
    fileHandlePrototype.sync = originalSync;
    await writers.driverAppend({ kind: 'rpc-observed', probeLabel: repairJoin.label, callNonce: repairJoin.callNonce, outcome: 'success-result' });
    const intentGone = await readFile(intentPath, 'utf8').then(() => false, (error) => error.code === 'ENOENT');
    assert.ok(intentGone, 'the resolved repair intent was removed');
    const reduced = await writers.reduce();
    assert.equal(reduced.uncommittedCount, 0, 'the retry after the fault clears completes');
  });
});

// --- ROUND 50 finding 2: an ambiguous entry commit (the commit landed, a ---
// --- trailing recovery-intent unlink failed) retains the label — the ---
// --- committed state is reconciled BY LABEL before release, so a ---
// --- same-label retry fails closed as already-used and the run remains ---
// --- reducible. ---

test('an ambiguous entry commit retains the label and the run stays reducible', async () => {
  await withDirectProbeRun('zcode-direct-observer-', async (run) => {
    const nonce = directRunNonce();
    const writers = makeDirectProbeWriters(run, nonce);
    const { label, callNonce } = await withDirectProbeRecoveryFixture(run, nonce, writers);
    void callNonce;
    const intentPath = join(run, 'recovery-intent.json');
    // A second server instance of the SAME process and capability: it
    // adopts the registered owner, and the MCP client drives its tools.
    const server = trackDirectProbeServer(run, createDirectProbeServer({ observer: { runDirectory: run, runNonce: nonce, phase: 'reachability' }, ownerSecret: DIRECT_DRIVER_SECRET }));
    const client = new Client({ name: 'direct-probe-round50', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    // The injection: the recovery-intent unlink's directory fsync fails
    // hard (EIO) — AFTER the entry and its recovery commit landed. The
    // append rejects even though the entry is durable.
    const probeHandle = await open(run, 'r');
    const fileHandlePrototype = Object.getPrototypeOf(probeHandle);
    await probeHandle.close();
    const originalSync = fileHandlePrototype.sync;
    let armed = true;
    fileHandlePrototype.sync = async function failIntentUnlinkDirectorySync(...args) {
      const isDirectory = await this.stat().then((value) => value.isDirectory(), () => false);
      if (armed && isDirectory) {
        let intentGoneAlready = false;
        try { await readFile(intentPath); intentGoneAlready = false; } catch (error) { intentGoneAlready = error.code === 'ENOENT'; }
        const eventsText = await readFile(join(run, 'events.jsonl'), 'utf8');
        if (intentGoneAlready && eventsText.includes(`"probeLabel":"${label}"`)) {
          armed = false;
          const failure = new Error('EIO: injected directory sync failure after the intent unlink');
          failure.code = 'EIO';
          throw failure;
        }
      }
      return originalSync.apply(this, args);
    };
    try {
      const result1 = await client.request({ method: 'tools/call', params: { name: 'capture_direct', arguments: { probeLabel: label } } }, CallToolResultSchema);
      assert.equal(result1.isError, true, 'the ambiguous append failure surfaces as a tool error');
      // A same-label retry: the committed entry is reconciled, the label is
      // retained, and no second entry is attempted.
      const result2 = await client.request({ method: 'tools/call', params: { name: 'capture_direct', arguments: { probeLabel: label } } }, CallToolResultSchema);
      assert.equal(result2.isError, true);
      assert.match(result2.content[0].text, /already used in this server run/, 'the committed label is retained instead of being released');
      assert.doesNotMatch(result2.content[0].text, /PROBE_LABEL_DUPLICATE/, 'no duplicate label reaches the append path');
    } finally { fileHandlePrototype.sync = originalSync; }
    // The run remains reducible, with exactly one call for the label.
    const final = await directDriverAppend(run, nonce, { kind: 'cleanup-observed', outcome: 'released', source: 'driver' });
    const reduced = await reduceDirectProbeLog({ runDirectory: run, runNonce: nonce, ownerSecret: DIRECT_DRIVER_SECRET, ownerPid: process.pid, expectedFinalState: final.commit });
    assert.equal(reduced.uncommittedCount, 0, 'the run remains reducible');
    assert.equal(reduced.calls.length, 1, 'exactly one call exists for the ambiguous label');
    await client.close();
  });
});
// --- ROUND 51: entry-label reconciliation is three-valued. A read failure
// --- during the reconciliation is UNKNOWN: the label stays RESERVED (a
// --- same-label retry fails closed as already used) — the label is
// --- released only when the committed read proves the entry absent.

test('a failed entry reconciliation keeps the label reserved', async () => {
  await withDirectProbeRun('zcode-direct-observer-', async (run) => {
    const nonce = directRunNonce();
    const writers = makeDirectProbeWriters(run, nonce);
    const { label, callNonce } = await withDirectProbeRecoveryFixture(run, nonce, writers);
    void callNonce;
    const intentPath = join(run, 'recovery-intent.json');
    const eventsPath = join(run, 'events.jsonl');
    const server = trackDirectProbeServer(run, createDirectProbeServer({ observer: { runDirectory: run, runNonce: nonce, phase: 'reachability' }, ownerSecret: DIRECT_DRIVER_SECRET }));
    const client = new Client({ name: 'direct-probe-round51', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    // Injection 1 (the round 50 ambiguous commit): the recovery-intent
    // unlink's directory fsync fails hard (EIO) — the entry and its
    // recovery commit land, the append rejects ambiguously.
    const probeHandle = await open(run, 'r');
    const fileHandlePrototype = Object.getPrototypeOf(probeHandle);
    await probeHandle.close();
    const originalSync = fileHandlePrototype.sync;
    let dirSyncFired = false;
    fileHandlePrototype.sync = async function failIntentUnlinkDirectorySync(...args) {
      const isDirectory = await this.stat().then((value) => value.isDirectory(), () => false);
      if (!dirSyncFired && isDirectory) {
        let intentGoneAlready = false;
        try { await readFile(intentPath); intentGoneAlready = false; } catch (error) { intentGoneAlready = error.code === 'ENOENT'; }
        const eventsText = await readFile(eventsPath, 'utf8');
        if (intentGoneAlready && eventsText.includes(`"probeLabel":"${label}"`)) {
          dirSyncFired = true;
          const failure = new Error('EIO: injected directory sync failure after the intent unlink');
          failure.code = 'EIO';
          throw failure;
        }
      }
      return originalSync.apply(this, args);
    };
    // Injection 2: the FIRST descriptor-based journal read after the
    // ambiguous failure — the label reconciliation read inside the catch —
    // fails (EIO). The reconciliation state becomes UNKNOWN.
    const realReadFileSync = fs.readFileSync;
    let readFailFired = false;
    fs.readFileSync = function readFileSyncWithReconcileFailure(target, encoding) {
      if (typeof target === 'number' && dirSyncFired && !readFailFired) {
        readFailFired = true;
        const failure = new Error('EIO: injected reconciliation read failure');
        failure.code = 'EIO';
        throw failure;
      }
      return realReadFileSync(target, encoding);
    };
    try {
      const result1 = await client.request({ method: 'tools/call', params: { name: 'capture_direct', arguments: { probeLabel: label } } }, CallToolResultSchema);
      assert.equal(result1.isError, true, 'the ambiguous append failure surfaces as a tool error');
    } finally {
      fs.readFileSync = realReadFileSync;
      fileHandlePrototype.sync = originalSync;
    }
    assert.ok(readFailFired, 'the reconciliation read failed as injected');
    // THE RETRY with the SAME label: the unknown reconciliation keeps the
    // label reserved — the retry fails closed as already used, never
    // reaching the append path.
    const result2 = await client.request({ method: 'tools/call', params: { name: 'capture_direct', arguments: { probeLabel: label } } }, CallToolResultSchema);
    assert.equal(result2.isError, true);
    assert.match(result2.content[0].text, /already used in this server run/, 'the reserved label fails the retry closed as already used');
    assert.doesNotMatch(result2.content[0].text, /PROBE_LABEL_DUPLICATE/, 'no duplicate label reaches the append path');
    // After the read recovers, the label STAYS reserved (the entry
    // committed): the retry surfaces already used as well.
    const result3 = await client.request({ method: 'tools/call', params: { name: 'capture_direct', arguments: { probeLabel: label } } }, CallToolResultSchema);
    assert.match(result3.content[0].text, /already used in this server run/, 'the label stays reserved once the entry committed');
    // The run remains reducible.
    const final = await directDriverAppend(run, nonce, { kind: 'cleanup-observed', outcome: 'released', source: 'driver' });
    const reduced = await reduceDirectProbeLog({ runDirectory: run, runNonce: nonce, ownerSecret: DIRECT_DRIVER_SECRET, ownerPid: process.pid, expectedFinalState: final.commit });
    assert.equal(reduced.uncommittedCount, 0, 'the run remains reducible');
    assert.equal(reduced.calls.length, 1, 'exactly one call exists');
    await client.close();
  });
});
// --- ROUND 52: a missing events.jsonl proves absence ONLY for a provably
// --- empty run (no journal, or a journal with zero committed records).
// --- Journal evidence of commits with the event bytes missing is UNKNOWN:
// --- the label stays retained and the hold stays registered. ---

test('a missing event file is unknown for label reconciliation', async () => {
  await withDirectProbeRun('zcode-direct-observer-', async (run) => {
    const nonce = directRunNonce();
    const writers = makeDirectProbeWriters(run, nonce);
    const { label, callNonce } = await withDirectProbeRecoveryFixture(run, nonce, writers);
    void callNonce;
    const intentPath = join(run, 'recovery-intent.json');
    const eventsPath = join(run, 'events.jsonl');
    const server = trackDirectProbeServer(run, createDirectProbeServer({ observer: { runDirectory: run, runNonce: nonce, phase: 'reachability' }, ownerSecret: DIRECT_DRIVER_SECRET }));
    const client = new Client({ name: 'direct-probe-round52', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    // The round 50 ambiguous commit: the entry and its recovery commit land,
    // then the intent unlink's directory fsync fails hard (EIO) — the append
    // rejects even though the entry is durable.
    const eventsOriginal = await readFile(eventsPath);
    const probeHandle = await open(run, 'r');
    const fileHandlePrototype = Object.getPrototypeOf(probeHandle);
    await probeHandle.close();
    const originalSync = fileHandlePrototype.sync;
    let armed = true;
    fileHandlePrototype.sync = async function failIntentUnlinkDirectorySync(...args) {
      const isDirectory = await this.stat().then((value) => value.isDirectory(), () => false);
      if (armed && isDirectory) {
        let intentGoneAlready = false;
        try { await readFile(intentPath); intentGoneAlready = false; } catch (error) { intentGoneAlready = error.code === 'ENOENT'; }
        const eventsText = await readFile(eventsPath, 'utf8');
        if (intentGoneAlready && eventsText.includes(`"probeLabel":"${label}"`)) {
          armed = false;
          // THE GAP: the entry is committed; the event file goes missing
          // BEFORE the handler's catch reconciles the label.
          await rm(eventsPath, { force: true });
          const failure = new Error('EIO: injected directory sync failure after the intent unlink');
          failure.code = 'EIO';
          throw failure;
        }
      }
      return originalSync.apply(this, args);
    };
    try {
      const result1 = await client.request({ method: 'tools/call', params: { name: 'capture_direct', arguments: { probeLabel: label } } }, CallToolResultSchema);
      assert.equal(result1.isError, true, 'the ambiguous append failure surfaces as a tool error');
    } finally { fileHandlePrototype.sync = originalSync; }
    // The reconciliation must treat the missing event file as UNKNOWN (the
    // journal still records commits): the label stays retained, so the
    // same-label retry fails closed as already used.
    const result2 = await client.request({ method: 'tools/call', params: { name: 'capture_direct', arguments: { probeLabel: label } } }, CallToolResultSchema);
    assert.equal(result2.isError, true);
    assert.match(result2.content[0].text, /already used in this server run/, 'the missing event file is unknown: the label stays retained');
    // The file is restored: the entry committed, so the label STILL never
    // releases.
    await writeFile(eventsPath, eventsOriginal, { mode: 0o600 });
    const result3 = await client.request({ method: 'tools/call', params: { name: 'capture_direct', arguments: { probeLabel: label } } }, CallToolResultSchema);
    assert.match(result3.content[0].text, /already used in this server run/, 'the committed entry keeps the label reserved');
    // The run remains reducible, with exactly one call.
    const final = await directDriverAppend(run, nonce, { kind: 'cleanup-observed', outcome: 'released', source: 'driver' });
    const reduced = await reduceDirectProbeLog({ runDirectory: run, runNonce: nonce, ownerSecret: DIRECT_DRIVER_SECRET, ownerPid: process.pid, expectedFinalState: final.commit });
    assert.equal(reduced.uncommittedCount, 0, 'the run remains reducible');
    assert.equal(reduced.calls.length, 1, 'exactly one call exists');
    await client.close();
  });
});

test('a missing event file is unknown for hold settlement reconciliation', async () => {
  await withDirectProbeRun('zcode-direct-observer-', async (run) => {
    const nonce = directRunNonce();
    const server = trackDirectProbeServer(run, createDirectProbeServer({ observer: { runDirectory: run, runNonce: nonce, phase: 'reachability' }, ownerSecret: DIRECT_DRIVER_SECRET }));
    const client = new Client({ name: 'direct-probe-round52-hold', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const label = directLabel();
    await directDriverAppend(run, nonce, { kind: 'request-sent', probeLabel: label, tool: 'hold_direct', state: 'sent' });
    // The hold request resolves only after the settlements land; never
    // awaited up front.
    const held = client.request({ method: 'tools/call', params: { name: 'hold_direct', arguments: { probeLabel: label } } }, CallToolResultSchema).catch((error) => error);
    await waitUntilDirectEventKind(run, nonce, 'hold-started');
    const eventsPath = join(run, 'events.jsonl');
    const eventsOriginal = await readFile(eventsPath);
    // The event file goes missing while the hold is committed and pending:
    // the settlement reconciliation is UNKNOWN — no settlement commit may
    // happen on that pass, and the hold stays registered.
    await rm(eventsPath, { force: true });
    server.probeDirectDisconnect.settlePendingHoldsOnDisconnect();
    await new Promise((resolve) => setTimeout(resolve, 300));
    const eventsMissingAfterFailedPass = await lstat(eventsPath).then(() => false, (error) => error.code === 'ENOENT');
    assert.ok(eventsMissingAfterFailedPass, 'no settlement commit happens while the event file is missing');
    // The file is restored: the disconnect pass completes the settlements
    // exactly once.
    await writeFile(eventsPath, eventsOriginal, { mode: 0o600 });
    server.probeDirectDisconnect.settlePendingHoldsOnDisconnect();
    await waitUntilDirectEventKind(run, nonce, 'worker-settled', 15_000);
    const records = await readDirectProbeEvents({ runDirectory: run, runNonce: nonce });
    assert.deepEqual(records.map((record) => record.kind), ['request-sent', 'handler-entered', 'hold-started', 'handler-settled', 'worker-settled'], 'the restored pass settles the hold exactly once');
    assert.equal(records[3].outcome, 'connection-closed');
    assert.equal(records[4].outcome, 'connection-closed');
    const final = await directDriverAppend(run, nonce, { kind: 'cleanup-observed', outcome: 'released', source: 'driver' });
    const reduced = await reduceDirectProbeLog({ runDirectory: run, runNonce: nonce, ownerSecret: DIRECT_DRIVER_SECRET, ownerPid: process.pid, expectedFinalState: final.commit });
    assert.equal(reduced.uncommittedCount, 0, 'the run reduces cleanly');
    assert.equal(reduced.calls[0].handlerSettled, 'connection-closed', 'the settlement evidence attributes cleanly');
    await held;
    await client.close();
  });
});
// --- ROUND 53: a missing or empty seal journal is UNKNOWN whenever event
// --- bytes exist, or whenever the process has observed a commit. Erasure
// --- is not proof that nothing committed: the label stays retained and
// --- the hold stays registered.

test('a missing seal journal is unknown for label reconciliation', async () => {
  await withDirectProbeRun('zcode-direct-observer-', async (run) => {
    const nonce = directRunNonce();
    const writers = makeDirectProbeWriters(run, nonce);
    const { label, callNonce } = await withDirectProbeRecoveryFixture(run, nonce, writers);
    void callNonce;
    const intentPath = join(run, 'recovery-intent.json');
    const journalPath = join(run, 'events-seal.jsonl');
    const journalOriginal = await readFile(journalPath);
    const server = trackDirectProbeServer(run, createDirectProbeServer({ observer: { runDirectory: run, runNonce: nonce, phase: 'reachability' }, ownerSecret: DIRECT_DRIVER_SECRET }));
    const client = new Client({ name: 'direct-probe-round53', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    // The round 50 ambiguous commit: the entry lands, then the intent
    // unlink's directory fsync fails hard (EIO) — and THE JOURNAL IS
    // REMOVED in the same gap, before the handler's catch reconciles.
    const probeHandle = await open(run, 'r');
    const fileHandlePrototype = Object.getPrototypeOf(probeHandle);
    await probeHandle.close();
    const originalSync = fileHandlePrototype.sync;
    let armed = true;
    fileHandlePrototype.sync = async function failIntentUnlinkDirSyncAndRemoveJournal(...args) {
      const isDirectory = await this.stat().then((value) => value.isDirectory(), () => false);
      if (armed && isDirectory) {
        let intentGoneAlready = false;
        try { await readFile(intentPath); intentGoneAlready = false; } catch (error) { intentGoneAlready = error.code === 'ENOENT'; }
        const eventsText = await readFile(join(run, 'events.jsonl'), 'utf8');
        if (intentGoneAlready && eventsText.includes(`"probeLabel":"${label}"`)) {
          armed = false;
          await rm(journalPath, { force: true });
          const failure = new Error('EIO: injected directory sync failure after the intent unlink');
          failure.code = 'EIO';
          throw failure;
        }
      }
      return originalSync.apply(this, args);
    };
    try {
      const result1 = await client.request({ method: 'tools/call', params: { name: 'capture_direct', arguments: { probeLabel: label } } }, CallToolResultSchema);
      assert.equal(result1.isError, true, 'the ambiguous append failure surfaces as a tool error');
    } finally { fileHandlePrototype.sync = originalSync; }
    // The reconciliation must be UNKNOWN (event bytes exist, journal
    // missing): the label stays retained, so the same-label retry fails
    // closed as already used.
    const result2 = await client.request({ method: 'tools/call', params: { name: 'capture_direct', arguments: { probeLabel: label } } }, CallToolResultSchema);
    assert.equal(result2.isError, true);
    assert.match(result2.content[0].text, /already used in this server run/, 'the missing journal is unknown: the label stays retained');
    // The journal is restored: the entry committed, so the label STILL
    // never releases.
    await writeFile(journalPath, journalOriginal, { mode: 0o600 });
    const result3 = await client.request({ method: 'tools/call', params: { name: 'capture_direct', arguments: { probeLabel: label } } }, CallToolResultSchema);
    assert.match(result3.content[0].text, /already used in this server run/, 'the committed entry keeps the label reserved');
    // The run remains reducible, with exactly one call.
    const final = await directDriverAppend(run, nonce, { kind: 'cleanup-observed', outcome: 'released', source: 'driver' });
    const reduced = await reduceDirectProbeLog({ runDirectory: run, runNonce: nonce, ownerSecret: DIRECT_DRIVER_SECRET, ownerPid: process.pid, expectedFinalState: final.commit });
    assert.equal(reduced.uncommittedCount, 0, 'the run remains reducible');
    assert.equal(reduced.calls.length, 1, 'exactly one call exists');
    await client.close();
  });
});

test('a missing seal journal is unknown for hold settlement reconciliation', async () => {
  await withDirectProbeRun('zcode-direct-observer-', async (run) => {
    const nonce = directRunNonce();
    const server = trackDirectProbeServer(run, createDirectProbeServer({ observer: { runDirectory: run, runNonce: nonce, phase: 'reachability' }, ownerSecret: DIRECT_DRIVER_SECRET }));
    const client = new Client({ name: 'direct-probe-round53-hold', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const label = directLabel();
    await directDriverAppend(run, nonce, { kind: 'request-sent', probeLabel: label, tool: 'hold_direct', state: 'sent' });
    const held = client.request({ method: 'tools/call', params: { name: 'hold_direct', arguments: { probeLabel: label } } }, CallToolResultSchema).catch((error) => error);
    await waitUntilDirectEventKind(run, nonce, 'hold-started');
    const journalPath = join(run, 'events-seal.jsonl');
    const journalOriginal = await readFile(journalPath);
    const eventsBefore = await readFile(join(run, 'events.jsonl'));
    // The journal goes missing while the hold is committed and pending: the
    // settlement reconciliation is UNKNOWN — no settlement commit happens
    // on that pass, and the hold stays registered.
    await rm(journalPath, { force: true });
    server.probeDirectDisconnect.settlePendingHoldsOnDisconnect();
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.deepEqual(await readFile(join(run, 'events.jsonl')), eventsBefore, 'no settlement commit happens while the journal is missing');
    // The journal is restored: the disconnect pass completes the settlements
    // exactly once.
    await writeFile(journalPath, journalOriginal, { mode: 0o600 });
    server.probeDirectDisconnect.settlePendingHoldsOnDisconnect();
    await waitUntilDirectEventKind(run, nonce, 'worker-settled', 15_000);
    const records = await readDirectProbeEvents({ runDirectory: run, runNonce: nonce });
    assert.deepEqual(records.map((record) => record.kind), ['request-sent', 'handler-entered', 'hold-started', 'handler-settled', 'worker-settled'], 'the restored pass settles the hold exactly once');
    assert.equal(records[3].outcome, 'connection-closed');
    assert.equal(records[4].outcome, 'connection-closed');
    const final = await directDriverAppend(run, nonce, { kind: 'cleanup-observed', outcome: 'released', source: 'driver' });
    const reduced = await reduceDirectProbeLog({ runDirectory: run, runNonce: nonce, ownerSecret: DIRECT_DRIVER_SECRET, ownerPid: process.pid, expectedFinalState: final.commit });
    assert.equal(reduced.uncommittedCount, 0, 'the run reduces cleanly');
    await held;
    await client.close();
  });
});
// --- ROUND 54: reconciliation verifies the chain REACHES the process-held
// --- commit. A rollback to an earlier valid nonempty prefix (both files
// --- consistent, but the committed hold/entry beyond the verified prefix)
// --- is UNKNOWN: the label stays retained and the hold stays registered.

test('a rolled-back committed prefix is unknown for label reconciliation', async () => {
  await withDirectProbeRun('zcode-direct-observer-', async (run) => {
    const nonce = directRunNonce();
    const writers = makeDirectProbeWriters(run, nonce);
    await withDirectProbeRecoveryFixture(run, nonce, writers);
    const intentPath = join(run, 'recovery-intent.json');
    const eventsPath = join(run, 'events.jsonl');
    const journalPath = join(run, 'events-seal.jsonl');
    const server = trackDirectProbeServer(run, createDirectProbeServer({ observer: { runDirectory: run, runNonce: nonce, phase: 'reachability' }, ownerSecret: DIRECT_DRIVER_SECRET }));
    const client = new Client({ name: 'direct-probe-round54', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    // A DISTINCT capture label: the rolled-back prefix must NOT contain an
    // entry for it, so the reconciliation's answer truly hinges on the
    // rolled-away committed entry.
    const captureLabel = directLabel();
    await directDriverAppend(run, nonce, { kind: 'request-sent', probeLabel: captureLabel, tool: 'capture_direct', state: 'sent' });
    // The round 50 ambiguous commit: the entry lands, then the intent
    // unlink's directory fsync fails hard (EIO) — and THE ROLLBACK lands in
    // the same gap: both evidence files are restored to an EARLIER VALID
    // NONEMPTY prefix (internally consistent, but the committed entry sits
    // beyond the verified prefix) BEFORE the handler's catch reconciles.
    // The committed (pre-rollback) bytes are captured by the injection so
    // the true state can be restored afterwards.
    const rollbackEvents = Buffer.from((await readFile(eventsPath, 'utf8')).split('\n').filter((line) => line.trim() !== '').slice(0, 3).join('\n') + '\n', 'utf8');
    const rollbackJournal = Buffer.from((await readFile(journalPath, 'utf8')).split('\n').filter((line) => line.trim() !== '').slice(0, 2).join('\n') + '\n', 'utf8');
    let committedEvents = null;
    let committedJournal = null;
    const probeHandle = await open(run, 'r');
    const fileHandlePrototype = Object.getPrototypeOf(probeHandle);
    await probeHandle.close();
    const originalSync = fileHandlePrototype.sync;
    let armed = true;
    fileHandlePrototype.sync = async function failIntentUnlinkDirSyncAndRollBack(...args) {
      const isDirectory = await this.stat().then((value) => value.isDirectory(), () => false);
      if (armed && isDirectory) {
        let intentGoneAlready = false;
        try { await readFile(intentPath); intentGoneAlready = false; } catch (error) { intentGoneAlready = error.code === 'ENOENT'; }
        const eventsText = await readFile(eventsPath, 'utf8');
        if (intentGoneAlready && eventsText.includes(`"probeLabel":"${captureLabel}"`)) {
          armed = false;
          committedEvents = await readFile(eventsPath);
          committedJournal = await readFile(journalPath);
          await writeFile(eventsPath, rollbackEvents, { mode: 0o600 });
          await writeFile(journalPath, rollbackJournal, { mode: 0o600 });
          const failure = new Error('EIO: injected directory sync failure after the intent unlink');
          failure.code = 'EIO';
          throw failure;
        }
      }
      return originalSync.apply(this, args);
    };
    try {
      const result1 = await client.request({ method: 'tools/call', params: { name: 'capture_direct', arguments: { probeLabel: captureLabel } } }, CallToolResultSchema);
      assert.equal(result1.isError, true, 'the ambiguous append failure surfaces as a tool error');
    } finally { fileHandlePrototype.sync = originalSync; }
    assert.ok(committedEvents !== null && committedJournal !== null, 'the rollback captured the committed bytes');
    // A same-label retry: the reconciliation must be UNKNOWN (rollback), so
    // the label stays retained and the retry fails closed as already used.
    const result2 = await client.request({ method: 'tools/call', params: { name: 'capture_direct', arguments: { probeLabel: captureLabel } } }, CallToolResultSchema);
    assert.equal(result2.isError, true);
    assert.match(result2.content[0].text, /already used in this server run/, 'the rolled-back prefix is unknown: the label stays retained');
    // The true state is restored: the entry committed, the label STILL
    // never releases, and the run remains reducible.
    await writeFile(eventsPath, committedEvents, { mode: 0o600 });
    await writeFile(journalPath, committedJournal, { mode: 0o600 });
    const result3 = await client.request({ method: 'tools/call', params: { name: 'capture_direct', arguments: { probeLabel: captureLabel } } }, CallToolResultSchema);
    assert.match(result3.content[0].text, /already used in this server run/, 'the committed entry keeps the label reserved');
    const final = await directDriverAppend(run, nonce, { kind: 'cleanup-observed', outcome: 'released', source: 'driver' });
    const reduced = await reduceDirectProbeLog({ runDirectory: run, runNonce: nonce, ownerSecret: DIRECT_DRIVER_SECRET, ownerPid: process.pid, expectedFinalState: final.commit });
    assert.equal(reduced.uncommittedCount, 0, 'the run remains reducible');
    assert.ok(reduced.calls.length >= 1, 'the committed calls reduce');
    await client.close();
  });
});

test('a rolled-back committed prefix is unknown for hold settlement reconciliation', async () => {
  await withDirectProbeRun('zcode-direct-observer-', async (run) => {
    const nonce = directRunNonce();
    const server = trackDirectProbeServer(run, createDirectProbeServer({ observer: { runDirectory: run, runNonce: nonce, phase: 'reachability' }, ownerSecret: DIRECT_DRIVER_SECRET }));
    const client = new Client({ name: 'direct-probe-round54-hold', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const label = directLabel();
    await directDriverAppend(run, nonce, { kind: 'request-sent', probeLabel: label, tool: 'hold_direct', state: 'sent' });
    const held = client.request({ method: 'tools/call', params: { name: 'hold_direct', arguments: { probeLabel: label } } }, CallToolResultSchema).catch((error) => error);
    await waitUntilDirectEventKind(run, nonce, 'hold-started');
    const eventsPath = join(run, 'events.jsonl');
    const journalPath = join(run, 'events-seal.jsonl');
    // THE ROLLBACK: both evidence files restored to an earlier valid
    // nonempty prefix — before hold-started committed.
    const eventsOriginal = await readFile(eventsPath);
    const journalOriginal = await readFile(journalPath);
    const rollbackEvents = Buffer.from((await readFile(eventsPath, 'utf8')).split('\n').filter((line) => line.trim() !== '').slice(0, 2).join('\n') + '\n', 'utf8');
    const rollbackJournal = Buffer.from((await readFile(journalPath, 'utf8')).split('\n').filter((line) => line.trim() !== '').slice(0, 2).join('\n') + '\n', 'utf8');
    await writeFile(eventsPath, rollbackEvents, { mode: 0o600 });
    await writeFile(journalPath, rollbackJournal, { mode: 0o600 });
    server.probeDirectDisconnect.settlePendingHoldsOnDisconnect();
    await new Promise((resolve) => setTimeout(resolve, 300));
    // UNKNOWN: the hold stays registered — no settlement commit that pass.
    assert.deepEqual(await readFile(eventsPath), rollbackEvents, 'no settlement commit happens on the unknown pass');
    // Restore the true state: the settlement completes exactly once.
    await writeFile(eventsPath, eventsOriginal, { mode: 0o600 });
    await writeFile(journalPath, journalOriginal, { mode: 0o600 });
    server.probeDirectDisconnect.settlePendingHoldsOnDisconnect();
    await waitUntilDirectEventKind(run, nonce, 'worker-settled', 15_000);
    const records = await readDirectProbeEvents({ runDirectory: run, runNonce: nonce });
    assert.deepEqual(records.map((record) => record.kind), ['request-sent', 'handler-entered', 'hold-started', 'handler-settled', 'worker-settled'], 'the restored pass settles the hold exactly once');
    assert.equal(records[3].outcome, 'connection-closed');
    assert.equal(records[4].outcome, 'connection-closed');
    const final = await directDriverAppend(run, nonce, { kind: 'cleanup-observed', outcome: 'released', source: 'driver' });
    const reduced = await reduceDirectProbeLog({ runDirectory: run, runNonce: nonce, ownerSecret: DIRECT_DRIVER_SECRET, ownerPid: process.pid, expectedFinalState: final.commit });
    assert.equal(reduced.uncommittedCount, 0, 'the run reduces cleanly');
    await held;
    await client.close();
  });
});
// --- ROUND 55: the DRIVER adopts the commit carried by an ambiguous append
// --- failure (monotonically), so a restored earlier valid log+journal
// --- prefix is refused as a rollback — by the next driver append and by
// --- reduction with the driver's advanced expectedFinalState.

test('the driver adopts the commit carried by an ambiguous append failure', async () => {
  await withDirectProbeRun('zcode-direct-observer-', async (run) => {
    const nonce = directRunNonce();
    const writers = makeDirectProbeWriters(run, nonce);
    const { label, callNonce } = await withDirectProbeRecoveryFixture(run, nonce, writers);
    const eventsPath = join(run, 'events.jsonl');
    const journalPath = join(run, 'events-seal.jsonl');
    const intentPath = join(run, 'recovery-intent.json');
    // The injection: the recovering DRIVER append's post-unlink directory
    // fsync fails hard (EIO) — after the commit line is durable. The
    // rejection is AMBIGUOUS: the commit landed.
    const probeHandle = await open(journalPath, 'r');
    const fileHandlePrototype = Object.getPrototypeOf(probeHandle);
    await probeHandle.close();
    const originalSync = fileHandlePrototype.sync;
    let armed = true;
    fileHandlePrototype.sync = async function failPostUnlinkDirectorySync(...args) {
      const isDirectory = await this.stat().then((value) => value.isDirectory(), () => false);
      if (armed && isDirectory) {
        let intentGoneAlready = false;
        try { await readFile(intentPath); intentGoneAlready = false; } catch (error) { intentGoneAlready = error.code === 'ENOENT'; }
        if (intentGoneAlready) {
          armed = false;
          const failure = new Error('EIO: injected directory sync failure after the intent unlink');
          failure.code = 'EIO';
          throw failure;
        }
      }
      return originalSync.apply(this, args);
    };
    try {
      await assert.rejects(
        () => directDriverAppend(run, nonce, { kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'error-result' }),
        /EIO/,
        'the recovering driver append rejects at the injected directory fsync',
      );
    } finally { fileHandlePrototype.sync = originalSync; }
    // The AMBIGUOUS committed state: the journal head now carries the
    // landed commit (4 records).
    const ambiguousEvents = await readFile(eventsPath);
    const ambiguousJournal = await readFile(journalPath, 'utf8');
    const ambiguousHead = JSON.parse(ambiguousJournal.trim().split('\n').at(-1));
    assert.equal(ambiguousHead.recordCount, 4, 'the landed commit is the fourth record');
    const expectedFinalState = { recordCount: ambiguousHead.recordCount, eventsDigest: ambiguousHead.eventsDigest };
    // THE ROLLBACK: both evidence files restored to the EARLIER valid
    // nonempty prefix (before the recovering append).
    const rollbackEvents = Buffer.from((await readFile(eventsPath, 'utf8')).split('\n').filter((line) => line.trim() !== '').slice(0, 3).join('\n') + '\n', 'utf8');
    const rollbackJournal = Buffer.from(ambiguousJournal.split('\n').filter((line) => line.trim() !== '').slice(0, 3).join('\n') + '\n', 'utf8');
    await writeFile(eventsPath, rollbackEvents, { mode: 0o600 });
    await writeFile(journalPath, rollbackJournal, { mode: 0o600 });
    // (a) The next driver append REFUSES the restored earlier prefix: the
    // driver's witness includes the adopted ambiguous commit.
    await assert.rejects(
      () => directDriverAppend(run, nonce, { kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'success-result' }),
      /PROBE_STATE_DIVERGED/,
      'the next driver append refuses the rolled-back prefix',
    );
    // (b) Reduction with the driver's (now advanced) expectedFinalState
    // refuses the rollback.
    await assert.rejects(
      () => reduceDirectProbeLog({ runDirectory: run, runNonce: nonce, ownerSecret: DIRECT_DRIVER_SECRET, ownerPid: process.pid, expectedFinalState }),
      /PROBE_OWNER_INVALID/,
      'the reduction refuses the rollback against the advanced anchor',
    );
    // The true state is restored: appends and reduction succeed as before.
    await writeFile(eventsPath, ambiguousEvents, { mode: 0o600 });
    await writeFile(journalPath, ambiguousJournal, { mode: 0o600 });
    await writers.driverAppend({ kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'success-result' });
    const reduced = await writers.reduce();
    assert.equal(reduced.uncommittedCount, 0, 'the run reduces cleanly after the true state is restored');
  });
});
// --- ROUND 56: a lock-release failure rejects AFTER the append callback —
// --- the landed durable commit must still reach the driver's witness
// --- (error.commit), so a restored earlier valid prefix is refused as a
// --- rollback by the next driver append and by reduction.

test('a lock-release failure keeps the landed commit in the driver witness', async () => {
  await withDirectProbeRun('zcode-direct-observer-', async (run) => {
    const nonce = directRunNonce();
    const writers = makeDirectProbeWriters(run, nonce);
    const { label, callNonce } = await withDirectProbeRecoveryFixture(run, nonce, writers);
    const eventsPath = join(run, 'events.jsonl');
    const journalPath = join(run, 'events-seal.jsonl');
    const advisoryPath = join(run, 'events.lock', 'advisory.lock');
    const advisoryIno = await lstat(advisoryPath).then((value) => value.ino);
    // The injection: the advisory-lock file descriptor is captured from the
    // lock-open stat and CLOSED once the append reaches its first directory
    // sync — the withFileLock release then fails (EBADF) and rejects with
    // LOCK_RELEASE_FAILED after the durable commit landed.
    const probeHandle = await open(eventsPath, 'r');
    const fileHandlePrototype = Object.getPrototypeOf(probeHandle);
    await probeHandle.close();
    const originalStat = fileHandlePrototype.stat;
    const originalSync = fileHandlePrototype.sync;
    let lockFd = null;
    let lockFdClosed = false;
    fileHandlePrototype.stat = function statCapturesLockFd(...args) {
      if (lockFd === null && args.length > 0 && args[0] && typeof args[0] === 'object' && args[0].bigint) {
        try {
          if (fs.fstatSync(this.fd).ino === advisoryIno) lockFd = this.fd;
        } catch { lockFd = null; }
      }
      return originalStat.apply(this, args);
    };
    const debugSyncs = [];
    fileHandlePrototype.sync = function closeLockFdAtDirSync(...args) {
      let isDirectory = false;
      try { isDirectory = fs.fstatSync(this.fd).isDirectory(); } catch { isDirectory = false; }
      if (process.env.DEBUG_DIRECT_PROBE) debugSyncs.push({ fd: this.fd, isDirectory, lockFd });
      if (lockFd !== null && !lockFdClosed && isDirectory) {
        lockFdClosed = true;
        try { fs.closeSync(lockFd); } catch { /* already closed */ }
      }
      return originalSync.apply(this, args);
    };
    try {
      await assert.rejects(
        () => directDriverAppend(run, nonce, { kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'error-result' }),
        /Could not release lock/,
        'the lock release fails after the durable commit',
      );
    } finally {
      fileHandlePrototype.stat = originalStat;
      fileHandlePrototype.sync = originalSync;
      if (process.env.DEBUG_DIRECT_PROBE) console.error('DEBUG-R56', JSON.stringify({ lockFd, lockFdClosed, debugSyncs }));
    }
    // The AMBIGUOUS committed state: the driver's rpc-observed landed as the
    // fourth record behind the release failure.
    const advancedJournal = await readFile(journalPath, 'utf8');
    const advancedHead = JSON.parse(advancedJournal.trim().split('\n').at(-1));
    assert.equal(advancedHead.recordCount, 4, 'the landed commit is durable behind the release failure');
    const advancedEvents = await readFile(eventsPath);
    // THE ROLLBACK: both evidence files restored to the earlier valid
    // prefix (3 records) — the events from the EVENT records, the journal
    // from the JOURNAL lines.
    const rollbackEvents = Buffer.from(advancedEvents.toString('utf8').split('\n').filter((line) => line.trim() !== '').slice(0, 3).join('\n') + '\n', 'utf8');
    const rollbackJournal = Buffer.from(advancedJournal.split('\n').filter((line) => line.trim() !== '').slice(0, 3).join('\n') + '\n', 'utf8');
    await writeFile(eventsPath, rollbackEvents, { mode: 0o600 });
    await writeFile(journalPath, rollbackJournal, { mode: 0o600 });
    // (a) The next driver append refuses PROBE_STATE_DIVERGED: the driver's
    // witness carries the landed commit.
    await assert.rejects(
      () => directDriverAppend(run, nonce, { kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'success-result' }),
      /PROBE_STATE_DIVERGED/,
      'the next driver append refuses the rolled-back prefix',
    );
    // (b) Reduction with the driver's advanced expectedFinalState refuses
    // the rollback.
    await assert.rejects(
      () => reduceDirectProbeLog({ runDirectory: run, runNonce: nonce, ownerSecret: DIRECT_DRIVER_SECRET, ownerPid: process.pid, expectedFinalState: { recordCount: advancedHead.recordCount, eventsDigest: advancedHead.eventsDigest } }),
      /PROBE_OWNER_INVALID/,
      'the reduction refuses the rolled-back prefix against the advanced anchor',
    );
    // The true state is restored: normal operation.
    await writeFile(eventsPath, advancedEvents, { mode: 0o600 });
    await writeFile(journalPath, advancedJournal, { mode: 0o600 });
    await writers.driverAppend({ kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'success-result' });
    const reduced = await writers.reduce();
    assert.equal(reduced.uncommittedCount, 0, 'the run reduces cleanly after the true state is restored');
  });
});
// --- ROUND 57: for an EXISTING seal journal, the appended line is durable
// --- the moment its own sync succeeds — any failure after that (close,
// --- per-commit directory fsync) is AMBIGUOUS and must carry the landed
// --- commit so both writers adopt it. A restored earlier valid prefix is
// --- then refused by the next append.

test('the driver adopts the commit from a journal close failure after sync', async () => {
  await withDirectProbeRun('zcode-direct-observer-', async (run) => {
    const nonce = directRunNonce();
    const writers = makeDirectProbeWriters(run, nonce);
    const { label, callNonce } = await withDirectProbeRecoveryFixture(run, nonce, writers);
    const eventsPath = join(run, 'events.jsonl');
    const journalPath = join(run, 'events-seal.jsonl');
    const journalIno = await lstat(journalPath).then((value) => value.ino);
    const preEvents = await readFile(eventsPath);
    const preJournal = await readFile(journalPath);
    // The injection: the JOURNAL handle's own sync succeeds (the line is
    // durable — the journal already existed), then the descriptor is closed,
    // so the append's journalHandle.close() fails AFTER sync.
    const probeHandle = await open(eventsPath, 'r');
    const fileHandlePrototype = Object.getPrototypeOf(probeHandle);
    await probeHandle.close();
    const originalSync = fileHandlePrototype.sync;
    let armed = true;
    fileHandlePrototype.sync = async function failJournalCloseAfterSync(...args) {
      const result = await originalSync.apply(this, args);
      let isJournal = false;
      try { isJournal = fs.fstatSync(this.fd).ino === journalIno; } catch { isJournal = false; }
      if (armed && isJournal) {
        armed = false;
        try { fs.closeSync(this.fd); } catch { /* already closed */ }
      }
      return result;
    };
    try {
      await assert.rejects(
        () => directDriverAppend(run, nonce, { kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'error-result' }),
        /EBADF/,
        'the journal close fails after its sync',
      );
    } finally { fileHandlePrototype.sync = originalSync; }
    // The TRUE post-attempt state: the journal line and the event record
    // both landed behind the failed close.
    const trueEvents = await readFile(eventsPath);
    const trueJournal = await readFile(journalPath);
    // The preceding valid prefix is restored → the next driver append must
    // refuse PROBE_STATE_DIVERGED (the adopted witness).
    await writeFile(eventsPath, preEvents, { mode: 0o600 });
    await writeFile(journalPath, preJournal, { mode: 0o600 });
    await assert.rejects(
      () => directDriverAppend(run, nonce, { kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'success-result' }),
      /PROBE_STATE_DIVERGED/,
      'the next driver append refuses the rolled-back prefix',
    );
    // The true state is restored: appends succeed and the run reduces.
    await writeFile(eventsPath, trueEvents, { mode: 0o600 });
    await writeFile(journalPath, trueJournal, { mode: 0o600 });
    await directDriverAppend(run, nonce, { kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'success-result' });
    const final = await directDriverAppend(run, nonce, { kind: 'cleanup-observed', outcome: 'released', source: 'driver' });
    const reduced = await reduceDirectProbeLog({ runDirectory: run, runNonce: nonce, ownerSecret: DIRECT_DRIVER_SECRET, ownerPid: process.pid, expectedFinalState: final.commit });
    assert.equal(reduced.uncommittedCount, 0, 'the run reduces cleanly');
    void trueEvents; void trueJournal;
  });
});

test('the server adopts the commit from a journal close failure after sync', async () => {
  await withDirectProbeRun('zcode-direct-observer-', async (run) => {
    const nonce = directRunNonce();
    const writers = makeDirectProbeWriters(run, nonce);
    const { label, callNonce } = await withDirectProbeRecoveryFixture(run, nonce, writers);
    const eventsPath = join(run, 'events.jsonl');
    const journalPath = join(run, 'events-seal.jsonl');
    const journalIno = await lstat(journalPath).then((value) => value.ino);
    const preEvents = await readFile(eventsPath);
    const preJournal = await readFile(journalPath);
    const secondJoin = { label: directLabel(), callNonce: directCallNonce() };
    // The injection: the JOURNAL handle's own sync succeeds, then the
    // descriptor is closed — the append's journalHandle.close() fails AFTER
    // sync.
    const probeHandle = await open(eventsPath, 'r');
    const fileHandlePrototype = Object.getPrototypeOf(probeHandle);
    await probeHandle.close();
    const originalSync = fileHandlePrototype.sync;
    let armed = true;
    fileHandlePrototype.sync = async function failJournalCloseAfterSyncServer(...args) {
      const result = await originalSync.apply(this, args);
      let isJournal = false;
      try { isJournal = fs.fstatSync(this.fd).ino === journalIno; } catch { isJournal = false; }
      if (armed && isJournal) {
        armed = false;
        try { fs.closeSync(this.fd); } catch { /* already closed */ }
      }
      return result;
    };
    try {
      await assert.rejects(
        () => writers.handlerAppend({ kind: 'handler-entered', probeLabel: secondJoin.label, callNonce: secondJoin.callNonce, serverInstanceHash: directHash('fixture-instance') }),
        /EBADF/,
        'the journal close fails after its sync',
      );
    } finally { fileHandlePrototype.sync = originalSync; }
    // The preceding valid prefix is restored → the next SERVER append must
    // refuse PROBE_STATE_DIVERGED (the adopted witness).
    await writeFile(eventsPath, preEvents, { mode: 0o600 });
    await writeFile(journalPath, preJournal, { mode: 0o600 });
    await assert.rejects(
      () => writers.handlerAppend({ kind: 'handler-entered', probeLabel: secondJoin.label, callNonce: secondJoin.callNonce, serverInstanceHash: directHash('fixture-instance') }),
      /PROBE_STATE_DIVERGED/,
      'the next server append refuses the rolled-back prefix',
    );
    // The true state is restored: appends succeed and the run reduces.
    await directDriverAppend(run, nonce, { kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'success-result' });
    const final = await directDriverAppend(run, nonce, { kind: 'cleanup-observed', outcome: 'released', source: 'driver' });
    const reduced = await reduceDirectProbeLog({ runDirectory: run, runNonce: nonce, ownerSecret: DIRECT_DRIVER_SECRET, ownerPid: process.pid, expectedFinalState: final.commit });
    assert.equal(reduced.uncommittedCount, 0, 'the run reduces cleanly');
  });
});
// --- ROUND 58: for an EXISTING journal, a HARD (thrown) directory fsync
// --- error after the commit line is durable is AMBIGUOUS and carries the
// --- landed commit — both writers adopt it, and a restored earlier valid
// --- prefix is refused as a rollback.

test('a hard commit directory-fsync error carries the landed commit (driver)', async () => {
  await withDirectProbeRun('zcode-direct-observer-', async (run) => {
    const nonce = directRunNonce();
    const writers = makeDirectProbeWriters(run, nonce);
    const { label, callNonce } = await withDirectProbeRecoveryFixture(run, nonce, writers);
    const eventsPath = join(run, 'events.jsonl');
    const journalPath = join(run, 'events-seal.jsonl');
    const preLines = (await readFile(journalPath, 'utf8')).split('\n').filter((line) => line.trim() !== '').length;
    const preEvents = await readFile(eventsPath);
    const preJournal = await readFile(journalPath);
    // The injection: the commit's own directory fsync THROWS EIO — after
    // the journal line was written and fsynced (an existing journal).
    const probeHandle = await open(eventsPath, 'r');
    const fileHandlePrototype = Object.getPrototypeOf(probeHandle);
    await probeHandle.close();
    const originalSync = fileHandlePrototype.sync;
    let armed = true;
    fileHandlePrototype.sync = async function failCommitDirSyncWithEIO(...args) {
      const isDirectory = await this.stat().then((value) => value.isDirectory(), () => false);
      if (armed && isDirectory) {
        const journalLines = (await readFile(journalPath, 'utf8')).split('\n').filter((line) => line.trim() !== '').length;
        if (journalLines === preLines + 1) {
          armed = false;
          const failure = new Error('EIO: injected commit directory fsync failure');
          failure.code = 'EIO';
          throw failure;
        }
      }
      return originalSync.apply(this, args);
    };
    try {
      await assert.rejects(
        () => directDriverAppend(run, nonce, { kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'error-result' }),
        /EIO/,
        'the hard commit directory fsync error surfaces',
      );
    } finally { fileHandlePrototype.sync = originalSync; }
    // The AMBIGUOUS committed state: the landed commit is durable behind
    // the hard error.
    const advancedHead = JSON.parse((await readFile(journalPath, 'utf8')).trim().split('\n').at(-1));
    assert.equal(advancedHead.recordCount, preLines + 1, 'the landed commit is durable behind the hard error');
    const advancedEvents = await readFile(eventsPath);
    const advancedJournal = await readFile(journalPath, 'utf8');
    // THE ROLLBACK: both evidence files restored to the earlier valid
    // prefix.
    await writeFile(eventsPath, preEvents, { mode: 0o600 });
    await writeFile(journalPath, preJournal, { mode: 0o600 });
    // (a) The next driver append refuses PROBE_STATE_DIVERGED.
    await assert.rejects(
      () => directDriverAppend(run, nonce, { kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'success-result' }),
      /PROBE_STATE_DIVERGED/,
      'the next driver append refuses the rolled-back prefix',
    );
    // (b) Reduction with the advanced anchor refuses the rollback.
    await assert.rejects(
      () => reduceDirectProbeLog({ runDirectory: run, runNonce: nonce, ownerSecret: DIRECT_DRIVER_SECRET, ownerPid: process.pid, expectedFinalState: { recordCount: advancedHead.recordCount, eventsDigest: advancedHead.eventsDigest } }),
      /PROBE_OWNER_INVALID/,
      'the reduction refuses the rolled-back prefix against the advanced anchor',
    );
    // The true state is restored: normal operation.
    await writeFile(eventsPath, advancedEvents, { mode: 0o600 });
    await writeFile(journalPath, advancedJournal, { mode: 0o600 });
    await writers.driverAppend({ kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'success-result' });
    const reduced = await writers.reduce();
    assert.equal(reduced.uncommittedCount, 0, 'the run reduces cleanly after the true state is restored');
  });
});

test('a hard commit directory-fsync error carries the landed commit (server)', async () => {
  await withDirectProbeRun('zcode-direct-observer-', async (run) => {
    const nonce = directRunNonce();
    const writers = makeDirectProbeWriters(run, nonce);
    const { label, callNonce } = await withDirectProbeRecoveryFixture(run, nonce, writers);
    const eventsPath = join(run, 'events.jsonl');
    const journalPath = join(run, 'events-seal.jsonl');
    const preLines = (await readFile(journalPath, 'utf8')).split('\n').filter((line) => line.trim() !== '').length;
    const secondJoin = { label: directLabel(), callNonce: directCallNonce() };
    // The capture attempt's own request-sent: commits (and resolves the
    // recovery fixture's orphan) before the injected entry append.
    await directDriverAppend(run, nonce, { kind: 'request-sent', probeLabel: secondJoin.label, tool: 'capture_direct', state: 'sent' });
    const preEvents = await readFile(eventsPath);
    const preJournal = await readFile(journalPath);
    const probeHandle = await open(eventsPath, 'r');
    const fileHandlePrototype = Object.getPrototypeOf(probeHandle);
    await probeHandle.close();
    const originalSync = fileHandlePrototype.sync;
    let armed = true;
    fileHandlePrototype.sync = async function failCommitDirSyncWithEIOServer(...args) {
      const isDirectory = await this.stat().then((value) => value.isDirectory(), () => false);
      if (armed && isDirectory) {
        const journalLines = (await readFile(journalPath, 'utf8')).split('\n').filter((line) => line.trim() !== '').length;
        if (journalLines === preLines + 2) {
          armed = false;
          const failure = new Error('EIO: injected commit directory fsync failure');
          failure.code = 'EIO';
          throw failure;
        }
      }
      return originalSync.apply(this, args);
    };
    try {
      await assert.rejects(
        () => writers.handlerAppend({ kind: 'handler-entered', probeLabel: secondJoin.label, callNonce: secondJoin.callNonce, serverInstanceHash: directHash('fixture-instance') }),
        /EIO/,
        'the hard commit directory fsync error surfaces',
      );
    } finally { fileHandlePrototype.sync = originalSync; }
    // The AMBIGUOUS committed state: the landed commit is durable behind
    // the hard error.
    const advancedHead = JSON.parse((await readFile(journalPath, 'utf8')).trim().split('\n').at(-1));
    assert.equal(advancedHead.recordCount, preLines + 2, 'the landed commit is durable behind the hard error');
    const advancedEvents = await readFile(eventsPath);
    const advancedJournal = await readFile(journalPath, 'utf8');
    // THE ROLLBACK: both evidence files restored to the earlier valid
    // prefix.
    await writeFile(eventsPath, preEvents, { mode: 0o600 });
    await writeFile(journalPath, preJournal, { mode: 0o600 });
    // (a) The next server append refuses PROBE_STATE_DIVERGED.
    await assert.rejects(
      () => writers.handlerAppend({ kind: 'handler-entered', probeLabel: directLabel(), callNonce: directCallNonce(), serverInstanceHash: directHash('fixture-instance') }),
      /PROBE_STATE_DIVERGED/,
      'the next server append refuses the rolled-back prefix',
    );
    // (b) Reduction with the advanced anchor refuses the rollback.
    await assert.rejects(
      () => reduceDirectProbeLog({ runDirectory: run, runNonce: nonce, ownerSecret: DIRECT_DRIVER_SECRET, ownerPid: process.pid, expectedFinalState: { recordCount: advancedHead.recordCount, eventsDigest: advancedHead.eventsDigest } }),
      /PROBE_OWNER_INVALID/,
      'the reduction refuses the rolled-back prefix against the advanced anchor',
    );
    // The true state is restored: normal operation.
    await writeFile(eventsPath, advancedEvents, { mode: 0o600 });
    await writeFile(journalPath, advancedJournal, { mode: 0o600 });
    await writers.driverAppend({ kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'success-result' });
    const reduced = await writers.reduce();
    assert.equal(reduced.uncommittedCount, 0, 'the run reduces cleanly after the true state is restored');
  });
});

// ---------------------------------------------------------------------------
// Task 3: bounded direct-call driver — fake app-server transcript tests.
// The driver's reachability schedule reduces every `mcpServer/tool/call`
// response, against the durable handler-entry join, into one of the closed
// classifications with independent evidence references. A prior
// `server-started` event must never imply handler entry. The schedule tests
// run against a local fake app-server fixture — no real host in this step.
// ---------------------------------------------------------------------------

const directDriverModulePath = fileURLToPath(new URL('../tools/direct-mcp-probe/driver.mjs', import.meta.url));

/** Loads the driver module dynamically so its absence is a per-test failure. */
const loadDirectDriver = () => import('../tools/direct-mcp-probe/driver.mjs');

/** The closure over records + authenticated reduction the case seam consumes. */
async function reduceDirectRun(run, nonce, ownerSecret = DIRECT_DRIVER_SECRET, ownerPid = process.pid) {
  const finalState = directAnchors.get(run) ?? null;
  const reduced = await reduceDirectProbeLog({ runDirectory: run, runNonce: nonce, ownerSecret, ownerPid, expectedFinalState: finalState });
  const records = await readDirectProbeEvents({ runDirectory: run, runNonce: nonce });
  return { records, reduced };
}

test('G1 direct driver reduces a true handler response to success-handler-entered with independent evidence references', async () => {
  const { DIRECT_PROBE_SERVER_NAME, directReachabilityCase, classifyDirectGateG1 } = await loadDirectDriver();
  assert.equal(DIRECT_PROBE_SERVER_NAME, 'zcode-direct-mcp-probe');
  await withDirectProbeRun('zcode-direct-driver-', async (run) => {
    const nonce = directRunNonce();
    const label = directLabel();
    const callNonce = directCallNonce();
    // The fake app-server transcript: request, server startup, durable entry,
    // then a true handler response observed by the driver.
    await directDriverAppend(run, nonce, { kind: 'request-sent', probeLabel: label, tool: 'capture_direct', state: 'sent' });
    const server = trackDirectProbeServer(run, createDirectProbeServer({ observer: { runDirectory: run, runNonce: nonce, phase: 'reachability' }, ownerSecret: DIRECT_DRIVER_SECRET }));
    await server.probeDirectAppend({ kind: 'server-started', serverInstanceHash: directHash('fixture-instance') });
    await server.probeDirectAppend({ kind: 'handler-entered', probeLabel: label, callNonce, serverInstanceHash: directHash('fixture-instance') });
    await directDriverAppend(run, nonce, { kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'success-result' });
    const { records, reduced } = await reduceDirectRun(run, nonce);
    const reachability = directReachabilityCase({ records, reduced, probeLabel: label });
    assert.equal(reachability.classification, 'success-handler-entered');
    assert.equal(reachability.handlerEntryObserved, true);
    assert.equal(reachability.readiness, 'not-observed');
    // Independent evidence references: the durable entry record and the RPC
    // observation are distinct records, both referenced by kind@sequence.
    assert.ok(reachability.evidenceRefs.includes(`handler-entered@${records[2].sequence}`));
    assert.ok(reachability.evidenceRefs.includes(`rpc-observed@${records[3].sequence}`));
    assert.ok(reachability.evidenceRefs.includes(`request-sent@${records[0].sequence}`));
    assert.deepEqual([...reachability.evidenceRefs], [...reachability.evidenceRefs].sort((left, right) => Number(left.split('@')[1]) - Number(right.split('@')[1])));
    const gate = classifyDirectGateG1(reachability);
    assert.equal(gate.status, 'proven');
    assert.equal(gate.reasonCode, 'handler-entry-observed');
    assert.ok(gate.evidenceRefs.includes(`handler-entered@${records[2].sequence}`), 'the proven gate cites the independent entry evidence');
  });
});

test('G1 direct driver attributes a success-shaped error to the handler only through the durable entry join', async () => {
  const { directReachabilityCase, classifyDirectGateG1 } = await loadDirectDriver();
  await withDirectProbeRun('zcode-direct-driver-', async (run) => {
    const nonce = directRunNonce();
    const label = directLabel();
    const callNonce = directCallNonce();
    await directDriverAppend(run, nonce, { kind: 'readiness-observed', state: 'discovered', source: 'host' });
    await directDriverAppend(run, nonce, { kind: 'request-sent', probeLabel: label, tool: 'capture_direct', state: 'sent' });
    const server = trackDirectProbeServer(run, createDirectProbeServer({ observer: { runDirectory: run, runNonce: nonce, phase: 'reachability' }, ownerSecret: DIRECT_DRIVER_SECRET }));
    await server.probeDirectAppend({ kind: 'server-started', serverInstanceHash: directHash('fixture-instance') });
    await server.probeDirectAppend({ kind: 'handler-entered', probeLabel: label, callNonce, serverInstanceHash: directHash('fixture-instance') });
    await directDriverAppend(run, nonce, { kind: 'rpc-observed', probeLabel: label, callNonce, outcome: 'error-result' });
    const { records, reduced } = await reduceDirectRun(run, nonce);
    const reachability = directReachabilityCase({ records, reduced, probeLabel: label });
    assert.equal(reachability.classification, 'error-result-handler-entered');
    assert.equal(reachability.readiness, 'discovered');
    assert.ok(reachability.evidenceRefs.includes(`handler-entered@${records[3].sequence}`));
    const gate = classifyDirectGateG1(reachability);
    assert.equal(gate.status, 'proven', 'an independently persisted entry attributable to the request proves G1 even when the result was an error');
  });
});

test('G1 direct driver keeps an error origin unknown without a durable entry join even when the server started', async () => {
  const { directReachabilityCase, classifyDirectGateG1 } = await loadDirectDriver();
  await withDirectProbeRun('zcode-direct-driver-', async (run) => {
    const nonce = directRunNonce();
    const label = directLabel();
    await directDriverAppend(run, nonce, { kind: 'request-sent', probeLabel: label, tool: 'capture_direct', state: 'sent' });
    const server = trackDirectProbeServer(run, createDirectProbeServer({ observer: { runDirectory: run, runNonce: nonce, phase: 'reachability' }, ownerSecret: DIRECT_DRIVER_SECRET }));
    // The disposable server STARTED — server-started is durable — but no
    // handler entry ever landed. Server startup must never imply entry.
    await server.probeDirectAppend({ kind: 'server-started', serverInstanceHash: directHash('fixture-instance') });
    // The driver observed a success-shaped error result; with no durable
    // entry join it carries no call nonce.
    await directDriverAppend(run, nonce, { kind: 'rpc-observed', probeLabel: label, outcome: 'error-result' });
    const { records, reduced } = await reduceDirectRun(run, nonce);
    const reachability = directReachabilityCase({ records, reduced, probeLabel: label });
    assert.equal(reachability.classification, 'error-result-unknown-origin');
    assert.equal(reachability.handlerEntryObserved, false);
    const gate = classifyDirectGateG1(reachability);
    assert.equal(gate.status, 'not-proven');
    assert.equal(gate.reasonCode, 'error-origin-unknown');
    assert.equal(gate.evidenceRefs.some((ref) => ref.startsWith('handler-entered@')), false, 'no handler-entered reference may exist without a durable entry');
    assert.ok(gate.evidenceRefs.some((ref) => ref.startsWith('server-started@')), 'server startup is honest supporting context, never entry');
  });
});

test('G1 direct driver reduces an RPC rejection to rpc-rejected regardless of readiness', async () => {
  const { directReachabilityCase, classifyDirectGateG1 } = await loadDirectDriver();
  await withDirectProbeRun('zcode-direct-driver-', async (run) => {
    const nonce = directRunNonce();
    const label = directLabel();
    // Discovery failed AND the call was rejected: the honest classification
    // is rpc-rejected with the failed readiness recorded beside it.
    await directDriverAppend(run, nonce, { kind: 'readiness-observed', state: 'failed', source: 'host' });
    await directDriverAppend(run, nonce, { kind: 'request-sent', probeLabel: label, tool: 'capture_direct', state: 'sent' });
    await directDriverAppend(run, nonce, { kind: 'rpc-observed', probeLabel: label, outcome: 'rpc-rejected' });
    const { records, reduced } = await reduceDirectRun(run, nonce);
    const reachability = directReachabilityCase({ records, reduced, probeLabel: label });
    assert.equal(reachability.classification, 'rpc-rejected');
    assert.equal(reachability.readiness, 'failed');
    assert.equal(reachability.requestState, 'sent');
    const gate = classifyDirectGateG1(reachability);
    assert.equal(gate.status, 'not-proven');
    assert.equal(gate.reasonCode, 'rpc-rejected');
    assert.equal(gate.evidenceRefs.some((ref) => ref.startsWith('handler-entered@')), false);
  });
});

test('G1 direct driver records a call it never dispatched as not observed', async () => {
  const { directReachabilityCase, classifyDirectGateG1 } = await loadDirectDriver();
  await withDirectProbeRun('zcode-direct-driver-', async (run) => {
    const nonce = directRunNonce();
    const label = directLabel();
    // The driver recorded the request as not-sent (a prerequisite failed) and
    // no RPC was observed: the case is not observed, never fabricated.
    await directDriverAppend(run, nonce, { kind: 'request-sent', probeLabel: label, tool: 'capture_direct', state: 'not-sent' });
    const { records, reduced } = await reduceDirectRun(run, nonce);
    const reachability = directReachabilityCase({ records, reduced, probeLabel: label });
    assert.equal(reachability.classification, 'not-observed');
    assert.equal(reachability.requestState, 'not-sent');
    const gate = classifyDirectGateG1(reachability);
    assert.equal(gate.status, 'not-proven');
    assert.equal(gate.reasonCode, 'call-not-observed');
    assert.deepEqual(gate.evidenceRefs, []);
    // An unknown label is equally not observed.
    const missing = directReachabilityCase({ records, reduced, probeLabel: directLabel() });
    assert.equal(missing.classification, 'not-observed');
    assert.equal(missing.requestState, null);
  });
});

test('the direct driver refuses a run directory that is missing, foreign in mode, or nonempty', async () => {
  const { runDirectReachabilityProbe } = await loadDirectDriver();
  await withDirectProbeRun('zcode-direct-driver-', async (run) => {
    await assert.rejects(
      () => runDirectReachabilityProbe({ codexPath: '/nonexistent/codex', sourceCodexHome: run, runDirectory: join(run, 'missing') }),
      /PROBE_RUN_DIRECTORY_MISSING/,
      'the run directory must already exist',
    );
    const shared = join(run, 'shared');
    await fsp.mkdir(shared, { mode: 0o755 });
    await assert.rejects(
      () => runDirectReachabilityProbe({ codexPath: '/nonexistent/codex', sourceCodexHome: run, runDirectory: shared }),
      /PROBE_RUN_DIRECTORY_MODE/,
      'the run directory must be private mode 0700',
    );
    await writeFile(join(shared, 'foreign'), 'x');
    await chmod(shared, 0o700);
    await assert.rejects(
      () => runDirectReachabilityProbe({ codexPath: '/nonexistent/codex', sourceCodexHome: run, runDirectory: shared }),
      /PROBE_RUN_DIRECTORY_NOT_EMPTY/,
      'the driver validates an empty run directory',
    );
    await assert.rejects(
      () => runDirectReachabilityProbe({ codexPath: 'relative/codex', sourceCodexHome: run, runDirectory: join(run, 'empty') }),
      /PROBE_CODEX_PATH_RELATIVE/,
      'the codex path must be absolute',
    );
  });
});

/**
 * Builds the disposable fake app-server fixture: a `codex`-shaped executable
 * whose `--version`, `login status`, and `plugin *` subcommands behave like
 * the real CLI, and whose `app-server` subcommand speaks the bounded
 * newline-delimited JSON-RPC transcript of the scenarios under test. The
 * tool-call scenarios spawn the REAL disposable probe server executable the
 * same way the real host would, so handler evidence comes from the genuine
 * handler writer.
 * @param {string} scenario @param {string} serverModulePath @param {string} intermediatePath
 */
function directFakeAppServerScript(scenario, serverModulePath, intermediatePath) {
  return `#!/usr/bin/env node
// Generated fake app-server fixture (tests/direct-mcp-probe.test.mjs) — disposable, never committed.
import { spawn } from 'node:child_process';
import { appendFileSync, chmodSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const SCENARIO = ${JSON.stringify(scenario)};
const SERVER_PATH = ${JSON.stringify(serverModulePath)};
const INTERMEDIATE_PATH = ${JSON.stringify(intermediatePath)};
const SELF = fileURLToPath(import.meta.url);
const send = (frame) => { process.stdout.write(\`\${JSON.stringify(frame)}\\n\`); };
const fixed = (value) => { send(value); process.exit(0); };
const argv = process.argv.slice(2);
if (argv[0] === '--version') { process.stdout.write('codex-cli 9.9.9-fixture\\n'); process.exit(0); }
if (argv[0] === 'login' && argv[1] === 'status') fixed('{}');
if (argv[0] === 'plugin' && argv[1] === 'marketplace' && argv[2] === 'add') {
  if (SCENARIO === 'self-replace') {
    // Unlink first so the replacement carries a NEW device/inode identity —
    // the pin the driver's recheck must catch before the next spawn.
    unlinkSync(SELF);
    writeFileSync(SELF, [
      '#!/usr/bin/env node',
      '// replaced-inode marker: the fixture replaced its own binary during install',
      "if (process.argv[2] === '--version') { console.log('codex-cli 9.9.9-replaced'); process.exit(0); }",
      'process.exit(0);',
      '',
    ].join('\\n'), { mode: 0o755 });
  }
  if (SCENARIO === 'self-rewrite-inplace') {
    // In-place rewrite: SAME device/inode, different content — only a content
    // digest recheck can catch this. The rewritten variant answers --version
    // with a different version and exits nonzero for everything else, so a
    // driver that misses the change fails loudly at the next command.
    writeFileSync(SELF, [
      '#!/usr/bin/env node',
      '// rewritten-in-place marker: same inode, different content',
      "if (process.argv[2] === '--version') { console.log('codex-cli 8.8.8-rewritten'); process.exit(0); }",
      'process.exit(2);',
      '',
    ].join('\\n'), { mode: 0o755 });
  }
  fixed('{}');
}
if (argv[0] === 'plugin' && argv[1] === 'add') fixed('{}');
if (argv[0] === 'plugin' && argv[1] === 'remove') {
  if (SCENARIO === 'cleanup-replace') {
    // Rewrites itself in place DURING cleanup, between the two removal
    // commands: the driver must re-verify the pin before EACH cleanup
    // command and refuse to spawn the changed binary.
    writeFileSync(SELF, [
      '#!/usr/bin/env node',
      '// rewritten-during-cleanup marker',
      "if (process.argv[2] === '--version') { console.log('codex-cli 8.8.8-rewritten'); process.exit(0); }",
      'process.exit(2);',
      '',
    ].join('\\n'), { mode: 0o755 });
  }
  fixed('{}');
}
if (argv[0] === 'plugin' && argv[1] === 'marketplace' && argv[2] === 'remove') fixed('{}');
if (argv[0] !== 'app-server') process.exit(2);
try { appendFileSync(join(dirname(SELF), 'invocations.log'), argv.join(' ') + '\\n'); } catch {}
const lockLogOnShutdown = () => {
  if (SCENARIO === 'log-unreadable-known-pid') {
    // The driver just closed/signalled the session at cleanup time — after
    // discovery captured the server pid. Lock the log now, so the cleanup
    // fresh read fails while a captured, verified server pid is in hand.
    try { chmodSync(join(process.env.ZCODE_DIRECT_MCP_PROBE_RUN, 'events.jsonl'), 0o000); } catch {}
  }
  process.exit(0);
};
process.stdin.on('end', () => {
  if (SCENARIO === 'lifecycle-disconnect-propagate') {
    // The host survives the client disconnect (long enough for the driver's
    // verification) and DETERMINISTICALLY propagates it: close the probe
    // server's stdin so its held worker settles connection-closed inside
    // the case window, then exit after a short grace.
    if (serverChild) serverChild.stdin.end();
    setTimeout(() => process.exit(0), 2000);
    return;
  }
  if (SCENARIO === 'lifecycle-disconnect-silent') {
    // The host survives the client disconnect WITHOUT propagating it: the
    // fixture keeps running (holding the probe server's stdin open) so the
    // held worker never learns the client vanished. Cleanup terminates the
    // fixture later; the case window itself observes no settlement.
    return;
  }
  if (SCENARIO === 'lifecycle-disconnect-propagate') {
    // The host survives the client disconnect and DETERMINISTICALLY
    // propagates it: the fixture stays alive (so the driver's survival
    // verification sees a live host) while closing the probe server's
    // stdin, whose durable settlement the case window then observes.
    if (serverChild) serverChild.stdin.end();
    return;
  }
  lockLogOnShutdown();
});
process.on('SIGTERM', lockLogOnShutdown);

const FIXTURE_THREAD_ID = 'fixture-thread-0001-0002-0003-0004';
const FIXTURE_THREAD_ID_2 = 'fixture-thread-0005-0006-0007-0008';
const FIXTURE_TURN_ID = 'fixture-turn-aaaa-bbbb-cccc-ddd';
let fixtureThreadStarts = 0;
let fixtureTurnStarted = false;
let fixtureDispatchCount = 0;
// One PERSISTENT disposable-server child: the identity schedule makes
// several calls against ONE server process (one handler-owner registration),
// exactly as a real host keeps one server per thread.
let serverChild = null;
let serverReadyResolve = null;
const fixtureChildIdByDriverFrameId = new Map();
// The DRIVER's JSON-RPC request id per dispatched mcpServer/tool/call, in
// dispatch order (1st = the case target, 2nd = the sentinel).
const fixtureDriverToolCallIds = [];
let serverNextId = 3;
const serverWaiters = new Map();
const serverReadyPromise = () => {
  if (serverReadyResolve === null) return Promise.resolve();
  return new Promise((resolveReady) => { const poll = () => (serverReadyResolve === null ? resolveReady() : setTimeout(poll, 20)); poll(); });
};
const ensureServerChild = () => {
  if (serverChild) return serverChild;
  serverChild = spawn(process.execPath, [SERVER_PATH], { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
  serverChild.stderr.resume();
  let buffer = '';
  const sendToServer = (frame) => { serverChild.stdin.write(\`\${JSON.stringify(frame)}\\n\`); };
  serverChild.stdout.setEncoding('utf8');
  serverChild.stdout.on('data', (chunk) => {
    buffer += chunk;
    let newline = buffer.indexOf('\\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      let frame;
      try { frame = JSON.parse(line); } catch { newline = buffer.indexOf('\\n'); continue; }
      if (frame.id === 1 && serverReadyResolve !== null) { const ready = serverReadyResolve; serverReadyResolve = null; ready(); }
      else if (frame.id !== undefined && serverWaiters.has(frame.id)) {
        const waiter = serverWaiters.get(frame.id);
        serverWaiters.delete(frame.id);
        waiter(frame.result ?? { content: [], isError: true });
      }
      newline = buffer.indexOf('\\n');
    }
  });
  serverReadyResolve = () => {};
  sendToServer({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'direct-fixture', version: '0.0.0' } } });
  return serverChild;
};
let fixtureLastToolCallId = null;
let fixtureTargetChildCallId = null;
const callServerTool = (toolName, toolArguments, meta, onDispatch) => new Promise((resolveCall) => {
  const child = ensureServerChild();
  const dispatch = async () => {
    await serverReadyPromise();
    const id = serverNextId++;
    fixtureLastToolCallId = id;
    if (onDispatch) onDispatch(id);
    serverWaiters.set(id, (value) => resolveCall(value));
    sendToServer2(child, { jsonrpc: '2.0', method: 'notifications/initialized' });
    sendToServer2(child, { jsonrpc: '2.0', id, method: 'tools/call', params: { name: toolName, arguments: toolArguments, ...(meta ? { _meta: meta } : {}) } });
  };
  void dispatch();
});
const sendToServer2 = (child, frame) => { child.stdin.write(\`\${JSON.stringify(frame)}\\n\`); };

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf('\\n');
  while (newline >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line.trim() !== '') {
      let frame;
      try { frame = JSON.parse(line); } catch { newline = buffer.indexOf('\\n'); continue; }
      if (frame.method === 'notifications/cancelled') {
        // The driver releases the sentinel: the cancellation arrives on the
        // fake app-server's stdin. Forward it to the MCP server child,
        // mapping the fixture's tools/call response id to the child's
        // tools/call id, and record WHICH driver request id the release
        // targeted, beside every dispatched tool-call request id, so the
        // e2e can assert the targeted release named the SENTINEL's request
        // (not the target's).
        const childCallId = fixtureChildIdByDriverFrameId.get(frame.params && frame.params.requestId);
        if (childCallId !== undefined) {
          sendToServer2(serverChild, { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: childCallId, reason: frame.params && frame.params.reason } });
        }
        if (fixtureDriverToolCallIds.length > 0 && process.env.ZCODE_DIRECT_MCP_PROBE_RUN) {
          try {
            writeFileSync(join(process.env.ZCODE_DIRECT_MCP_PROBE_RUN, 'fixture-cancelled-request.json'), JSON.stringify({
              cancelledRequestId: frame.params && frame.params.requestId,
              driverToolCallIds: fixtureDriverToolCallIds,
            }) + '\\n');
          } catch { /* diagnostics only */ }
        }
        newline = buffer.indexOf('\\n');
        continue;
      }
      if (frame.id === 9001 && frame.method === undefined) {
        // The driver answered the held approval: decision 'cancel' denies the
        // command AND interrupts the turn — emit the completion. The silent
        // scenario never does, so the driver's settle window observes nothing.
        if (SCENARIO !== 'identity-hold-silent') {
          fixtureTurnStarted = false;
          send({ method: 'turn/completed', params: { threadId: FIXTURE_THREAD_ID, turn: { id: FIXTURE_TURN_ID, status: 'interrupted' } } });
        }
      } else if (frame.id !== undefined && typeof frame.method === 'string') {
        if (frame.method === 'initialize') send({ id: frame.id, result: {} });
        else if (frame.method === 'thread/start') {
          if (SCENARIO.startsWith('identity-') || SCENARIO.startsWith('lifecycle-')) ensureServerChild();
          fixtureThreadStarts += 1;
          send({ id: frame.id, result: { thread: { id: fixtureThreadStarts === 1 ? FIXTURE_THREAD_ID : FIXTURE_THREAD_ID_2 } } });
        } else if (frame.method === 'turn/start') {
          // The identity scenarios: the hold variants answer with an active
          // turn and then HOLD a CommandExecutionRequestApproval naming the
          // exact turn (the documented active-turn mechanism); the no-hold
          // variant answers with an already-completed turn and emits the
          // completion notification immediately. Lifecycle interrupt scenarios
          // reuse both shapes: the hold variant also answers turn/interrupt
          // and emits the interrupted completion when interrupted.
          if (SCENARIO === 'lifecycle-interrupt-hold') {
            fixtureTurnStarted = true;
            send({ id: frame.id, result: { turn: { id: FIXTURE_TURN_ID, status: 'inProgress' } } });
            send({ id: 9002, method: 'CommandExecutionRequestApproval', params: { threadId: FIXTURE_THREAD_ID, turnId: FIXTURE_TURN_ID, itemId: 'fixture-item-1', command: ['sleep', '45'] } });
          } else if (SCENARIO.startsWith('identity-hold')) {
            fixtureTurnStarted = true;
            send({ id: frame.id, result: { turn: { id: FIXTURE_TURN_ID, status: 'inProgress' } } });
            send({ id: 9001, method: 'CommandExecutionRequestApproval', params: { threadId: FIXTURE_THREAD_ID, turnId: FIXTURE_TURN_ID, itemId: 'fixture-item-1', command: ['sleep', '45'] } });
          } else if (SCENARIO === 'identity-no-hold' || SCENARIO.startsWith('lifecycle-')) {
            fixtureTurnStarted = false;
            send({ id: frame.id, result: { turn: { id: FIXTURE_TURN_ID, status: 'completed' } } });
            send({ method: 'turn/completed', params: { threadId: FIXTURE_THREAD_ID, turn: { id: FIXTURE_TURN_ID, status: 'completed' } } });
          } else send({ id: frame.id, error: { code: -32601, message: 'unknown method' } });
        } else if (frame.method === 'turn/interrupt') {
          // The lifecycle interrupt-hold scenario: the exact-turn interrupt is
          // acknowledged and the turn completes interrupted. The pending MCP
          // tool call is NOT touched — whether an interrupt reaches the held
          // downstream call is precisely what the case observes.
          if (SCENARIO === 'lifecycle-interrupt-hold') {
            fixtureTurnStarted = false;
            send({ id: frame.id, result: {} });
            send({ method: 'turn/completed', params: { threadId: FIXTURE_THREAD_ID, turn: { id: FIXTURE_TURN_ID, status: 'interrupted' } } });
          } else send({ id: frame.id, error: { code: -32601, message: 'unknown method' } });
        } else if (frame.method === 'mcpServerStatus/list') {
          if (SCENARIO === 'discovery-failure-reject') send({ id: frame.id, error: { code: -32601, message: 'discovery rejected' } });
          else send({ id: frame.id, result: { data: [{ name: 'zcode-direct-mcp-probe', runtimeStatus: 'connected', tools: { capture_direct: { name: 'capture_direct' } } }], nextCursor: null } });
        } else if (frame.method === 'mcpServer/tool/call') {
          const probeLabel = frame.params && frame.params.arguments ? frame.params.arguments.probeLabel : null;
          fixtureDispatchCount += 1;
          fixtureDriverToolCallIds.push(frame.id);
          if (SCENARIO === 'lifecycle-refuses-after-trigger' && fixtureDispatchCount > 1) {
            // The host answers the FIRST dispatch (the case's held target)
            // but refuses EVERY later dispatch — exactly the shape in which
            // a sentinel can no longer be sent after the trigger.
            send({ id: frame.id, error: { code: -32000, message: 'refused after trigger' } });
            return;
          }
          if (SCENARIO === 'lifecycle-host-exits-before-close') {
            // Same deterministic death as lifecycle-host-dies-before-trigger,
            // but the case under test is connection-close: by the time the
            // driver closes the client input, the owning host is verifiably
            // gone, so the observation cannot count as surviving-host.
            const child = ensureServerChild();
            const dispatch = async () => {
              await serverReadyPromise();
              child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\\n', () => {
                child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 7800, method: 'tools/call', params: { name: (frame.params && frame.params.name) || 'hold_direct', arguments: (frame.params && frame.params.arguments) || { probeLabel } } }) + '\\n', () => process.exit(0));
              });
            };
            void dispatch().catch(() => process.exit(0));
            return;
          }
          if (SCENARIO === 'lifecycle-host-dies-before-trigger') {
            // Forward the first dispatch (it reaches the handler and writes
            // the durable hold-started), then DIE before the driver's
            // trigger: the host process can no longer be signalled. The exit
            // is deterministic relative to the driver's observation: the
            // fixture dies in the forwarding-write's flush callback — before
            // the server child even processes the dispatch, so hold-started
            // cannot exist yet — while the driver's hold-started poll can
            // only observe the record on a LATER 250 ms cadence tick. The
            // fixture is therefore provably dead before the driver can act.
            const child = ensureServerChild();
            const dispatch = async () => {
              await serverReadyPromise();
              const forward = (frame, done) => child.stdin.write(JSON.stringify(frame) + '\\n', done);
              sendToServer2(child, { jsonrpc: '2.0', method: 'notifications/initialized' });
              forward({ jsonrpc: '2.0', id: 7700, method: 'tools/call', params: { name: (frame.params && frame.params.name) || 'hold_direct', arguments: (frame.params && frame.params.arguments) || { probeLabel } } }, () => process.exit(0));
            };
            void dispatch().catch(() => process.exit(0));
            return;
          }
          if (SCENARIO === 'lifecycle-cancels-everything') {
            // The host cancels EVERY call active at trigger time: forward the
            // dispatch, then poll the durable evidence log for the driver's
            // trigger-sent record; on sighting it, send MCP cancellations for
            // every outstanding forwarded tool request. Under a sentinel
            // established BEFORE the trigger both holds settle cancelled and
            // the case must catch the broad cancellation; a sentinel that
            // starts only AFTER the trigger would complete untouched and
            // forge an isolation pass.
            callServerTool((frame.params && frame.params.name) || 'hold_direct', (frame.params && frame.params.arguments) || { probeLabel }, undefined).then(() => {}, () => {});
            if (!globalThis.__cancelPoller) {
              globalThis.__cancelPoller = setInterval(() => {
                try {
                  const log = readFileSync(join(process.env.ZCODE_DIRECT_MCP_PROBE_RUN, 'events.jsonl'), 'utf8');
                  if (log.includes('"trigger-sent"')) {
                    clearInterval(globalThis.__cancelPoller);
                    for (const [id] of serverWaiters) {
                      sendToServer2(serverChild, { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason: 'broad cancellation' } });
                    }
                  }
                } catch { /* log not readable yet */ }
              }, 20);
            }
            return;
          }
          if (SCENARIO === 'lifecycle-race-generic-error') {
            // Forward the dispatch to the REAL server (the synthetic worker
            // completes on its own) but answer the driver with a GENERIC host
            // error: under the honest boundary rule a generic RPC error is
            // not cancellation evidence.
            const toolName = (frame.params && frame.params.name) || 'hold_direct';
            const toolArguments = (frame.params && frame.params.arguments) || { probeLabel };
            callServerTool(toolName, toolArguments, undefined).then(() => {
              send({ id: frame.id, result: { content: [{ type: 'text', text: 'generic host error' }], isError: true } });
            }, () => send({ id: frame.id, error: { code: -32000, message: 'tool call failed' } }));
            return;
          }
          if (SCENARIO === 'lifecycle-slow-sentinel') {
            // A host whose sentinel setup is SLOW: the target dispatch is
            // forwarded immediately; when the configured timeout boundary
            // fires (8 s after the target's hold-started) ONLY the target is
            // cancelled, and the delayed sentinel dispatch is forwarded only
            // AFTER the target's cancellation settlement is durable — the
            // sentinel therefore starts after the boundary, never spanning it.
            if (fixtureDispatchCount === 1) {
              callServerTool((frame.params && frame.params.name) || 'hold_direct', (frame.params && frame.params.arguments) || { probeLabel }, undefined).then(() => {}, () => {});
              if (!globalThis.__slowBoundaryArmed) {
                globalThis.__slowBoundaryArmed = true;
                let phase = 'waiting-hold-started';
                const poll = setInterval(() => {
                  try {
                    const log = readFileSync(join(process.env.ZCODE_DIRECT_MCP_PROBE_RUN, 'events.jsonl'), 'utf8');
                    if (phase === 'waiting-hold-started' && log.includes('"hold-started"')) {
                      phase = 'waiting-boundary';
                      setTimeout(() => {
                        sendToServer2(serverChild, { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: fixtureLastToolCallId, reason: 'tool timeout boundary' } });
                      }, 8_000);
                    } else if (phase === 'waiting-boundary' && log.includes('"worker-settled"')) {
                      clearInterval(poll);
                      const pending = globalThis.__pendingSentinelFrame;
                      if (pending) {
                        callServerTool((pending.params && pending.params.name) || 'hold_direct', (pending.params && pending.params.arguments) || { probeLabel: undefined }, undefined).then(() => {}, () => {});
                      }
                    }
                  } catch { /* log not readable yet */ }
                }, 20);
              }
            } else {
              globalThis.__pendingSentinelFrame = frame;
            }
            return;
          }
          if (SCENARIO === 'lifecycle-cancels-at-timeout') {
            // A host that cancels the TARGET call when its configured tool
            // timeout fires: forward the dispatch, and once the TARGET's
            // hold-started is durably observable, schedule the boundary —
            // 8 s later (the descriptor's tool_timeout_sec), cancel the
            // TARGET only. The driver then orders the sentinel's release.
            const isTarget = fixtureDispatchCount === 1;
            callServerTool((frame.params && frame.params.name) || 'hold_direct', (frame.params && frame.params.arguments) || { probeLabel }, undefined, (childCallId) => {
              fixtureChildIdByDriverFrameId.set(frame.id, childCallId);
              if (isTarget) fixtureTargetChildCallId = childCallId;
            });
            if (isTarget && !globalThis.__boundaryArmed) {
              globalThis.__boundaryArmed = true;
              const poll = setInterval(() => {
                try {
                  const log = readFileSync(join(process.env.ZCODE_DIRECT_MCP_PROBE_RUN, 'events.jsonl'), 'utf8');
                  if (log.includes('"hold-started"')) {
                    clearInterval(poll);
                    setTimeout(() => {
                      if (fixtureTargetChildCallId !== null) {
                        sendToServer2(serverChild, { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: fixtureTargetChildCallId, reason: 'tool timeout boundary' } });
                      }
                    }, 8_000);
                  }
                } catch { /* log not readable yet */ }
              }, 20);
            }
            return;
          }
          if (SCENARIO === 'call-never-answers') {
            // The host accepts the dispatch but never answers: the client's
            // request deadline is the only bound, and the honest outcome is an
            // unanswered call.
            return;
          }
          if (SCENARIO === 'reject') {
            // The host rejection text deliberately embeds the run-directory
            // path: real host messages can carry paths or other sensitive
            // values, so the redaction test can prove none of it reaches the
            // driver's stderr even with DEBUG_DIRECT_PROBE set.
            send({ id: frame.id, error: { code: -32000, message: 'tool call rejected at ' + (process.env.ZCODE_DIRECT_MCP_PROBE_RUN || 'run-unknown') } });
          }
          else if (SCENARIO === 'discovery-failure-reject') send({ id: frame.id, error: { code: -32000, message: 'tool call rejected' } });
          else if (SCENARIO === 'server-restart') {
            // The host RESTARTS the disposable server during dispatch: it
            // spawns instance A, waits for its durable startup, kills A,
            // removes the handler-owner registration so instance B can
            // register itself, spawns B, waits for B's durable startup, and
            // only then answers the call itself without reaching the
            // handler. The durable log ends with TWO distinct server starts
            // while only one owner registration exists — cleanup must fail
            // as unresolved instead of accounting for one and releasing.
            const startAndProve = (instance) => new Promise((resolveStarted) => {
              const child = spawn(process.execPath, [SERVER_PATH], { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
              child.stderr.resume();
              let sb = '';
              child.stdout.setEncoding('utf8');
              child.stdout.on('data', (chunk) => {
                sb += chunk;
                let nl = sb.indexOf('\\n');
                while (nl >= 0) {
                  const line = sb.slice(0, nl);
                  sb = sb.slice(nl + 1);
                  let f;
                  try { f = JSON.parse(line); } catch { nl = sb.indexOf('\\n'); continue; }
                  if (f.id === 1) resolveStarted(child);
                  nl = sb.indexOf('\\n');
                }
              });
              const initFrame = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'direct-restart-' + instance, version: '0.0.0' } } });
              child.stdin.write(initFrame + '\\n');
            });
            (async () => {
              const first = await startAndProve('a');
              first.kill('SIGKILL');
              rmSync(join(process.env.ZCODE_DIRECT_MCP_PROBE_RUN, 'handler-owner.json'));
              const second = await startAndProve('b');
              send({ id: frame.id, result: { content: [{ type: 'text', text: 'after restart' }], isError: true } });
            })();
          }
          else if (SCENARIO === 'log-unreadable-known-pid') {
            // The host starts the REAL server (its durable startup append
            // lands while the log is still readable — proven by the server
            // answering its own initialize) and answers the call itself
            // without reaching the handler. When the driver later closes the
            // session at cleanup time, the host locks the log just before
            // exiting: discovery has already captured the server pid, the
            // log is now unreadable, and release must fail as unresolved
            // regardless of the captured pid's verified exit.
            const child = spawn(process.execPath, [SERVER_PATH], { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
            child.stderr.resume();
            let serverBuffer = '';
            child.stdout.setEncoding('utf8');
            child.stdout.on('data', (chunk) => {
              serverBuffer += chunk;
              let newline = serverBuffer.indexOf('\\n');
              while (newline >= 0) {
                const line = serverBuffer.slice(0, newline);
                serverBuffer = serverBuffer.slice(newline + 1);
                let serverFrame;
                try { serverFrame = JSON.parse(line); } catch { newline = serverBuffer.indexOf('\\n'); continue; }
                if (serverFrame.id === 1) {
                  send({ id: frame.id, result: { content: [{ type: 'text', text: 'host-side error' }], isError: true } });
                }
                newline = serverBuffer.indexOf('\\n');
              }
            });
            child.stdin.write(\`\${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'direct-known-pid', version: '0.0.0' } } })}\\n\`);
          } else if (SCENARIO === 'log-unreadable') {
            // The host makes the durable evidence log unreadable when it
            // receives the dispatch: every later driver read fails, so
            // cleanup cannot consult fresh evidence. Cleanup must treat an
            // unreadable log as unresolved instead of reporting release.
            chmodSync(join(process.env.ZCODE_DIRECT_MCP_PROBE_RUN, 'events.jsonl'), 0o000);
            send({ id: frame.id, result: { content: [{ type: 'text', text: 'host-side error' }], isError: true } });
          } else if (SCENARIO === 'detached-server') {
            // The host reaches the real handler THROUGH an intermediate
            // spawner whose own command line never references the server
            // path: the server's parent is NOT the app-server process, so a
            // parent-filtered process scan cannot see it. The intermediate
            // keeps the server's stdio open (the server stays alive until
            // cleanup resolves it) and exits when the server exits.
            spawn(process.execPath, [INTERMEDIATE_PATH], { env: { ...process.env, SERVER_PATH, PROBE_LABEL: probeLabel ?? '' }, stdio: 'ignore' });
            send({ id: frame.id, result: { content: [{ type: 'text', text: 'detached dispatch' }], isError: false } });
          } else if (SCENARIO === 'server-exits-early') {
            // The host starts the probe server with no live stdio, so the
            // server records its durable startup and exits immediately; the
            // host then answers the call itself. The startup is durably
            // observable, but no live process will remain to verify its exit.
            spawn(process.execPath, [SERVER_PATH], { env: process.env, stdio: 'ignore' });
            send({ id: frame.id, result: { content: [{ type: 'text', text: 'host-side error' }], isError: true } });
          } else if (SCENARIO === 'error-without-entry') {
            // The host starts the probe server (server-started becomes durable)
            // but answers the call itself without ever reaching the handler.
            // The server stays connected over piped stdio exactly as a real
            // host keeps it, so its exit remains the driver's cleanup problem.
            spawn(process.execPath, [SERVER_PATH], { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
            send({ id: frame.id, result: { content: [{ type: 'text', text: 'host-side error' }], isError: true } });
          } else {
            // The host attaches the envelope metadata the real host attaches:
            // the DISPATCHED thread id (or, in the mismatch scenario, a
            // foreign thread id) under _meta.threadId — and, while a turn is
            // active, the inner turn metadata (thread_id + turn_id), exactly
            // the allowlisted candidate shape the handler fingerprints. A
            // turnless dispatch (idle, two-threads, completed cells) carries
            // no turn metadata, matching a host that only emits candidates it
            // actually holds.
            const meta = SCENARIO === 'identity-hold-mismatch'
              ? { threadId: 'fixture-thread-foreign' }
              : (SCENARIO.startsWith('identity-') && frame.params && typeof frame.params.threadId === 'string'
                ? (fixtureTurnStarted
                  ? { threadId: frame.params.threadId, 'x-codex-turn-metadata': { thread_id: frame.params.threadId, turn_id: FIXTURE_TURN_ID } }
                  : { threadId: frame.params.threadId })
                : undefined);
            if (SCENARIO === 'identity-hold-ends' && fixtureTurnStarted) {
              // The held turn ends while the ACTIVE cell's call is in flight
              // (the flag restricts this to the first call after turn/start):
              // the host emits the completion BEFORE answering the call, so
              // the driver's post-call observation window sees real host
              // evidence instead of its own authored assumption.
              fixtureTurnStarted = false;
              send({ method: 'turn/completed', params: { threadId: frame.params.threadId, turn: { id: FIXTURE_TURN_ID, status: 'interrupted' } } });
              // (the meta for THIS call was already computed with the turn
              // metadata attached — the host emitted the completion only
              // after assembling the dispatch context)
            }
            // Lifecycle scenarios forward the REAL dispatched tool (hold_direct
            // with its synthetic worker arguments); every other scenario keeps
            // dispatching capture_direct exactly as before.
            const toolName = SCENARIO.startsWith('lifecycle-') ? (frame.params.name ?? 'hold_direct') : 'capture_direct';
            const toolArguments = SCENARIO.startsWith('lifecycle-') ? (frame.params.arguments ?? { probeLabel }) : { probeLabel };
            callServerTool(toolName, toolArguments, meta).then((toolResult) => {
              if (SCENARIO === 'error-with-entry') send({ id: frame.id, result: { content: [{ type: 'text', text: 'host-wrapped error' }], isError: true } });
              else send({ id: frame.id, result: toolResult });
            }, () => send({ id: frame.id, error: { code: -32000, message: 'tool call failed' } }));
          }
        } else send({ id: frame.id, error: { code: -32601, message: 'unknown method' } });
      }
    }
    newline = buffer.indexOf('\\n');
  }
});
`;
}

/**
 * Builds a fake codex fixture executable plus a source Codex home with a
 * fake auth.json inside a private parent directory. Returns absolute paths.
 * @param {string} scenario
 */
/**
 * The intermediate spawner used by the detached-server scenario: it spawns
 * the real probe server (keeping its stdio open so the server stays alive),
 * performs the capture dispatch through it, and exits when the server exits.
 * It deliberately reads the server path from env so its own command line
 * never references the server module path.
 */
function directDetachedSpawnerScript() {
  return `#!/usr/bin/env node
// Generated intermediate spawner (tests/direct-mcp-probe.test.mjs) — disposable, never committed.
import { spawn } from 'node:child_process';
const child = spawn(process.execPath, [process.env.SERVER_PATH], { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
child.stderr.resume();
let buffer = '';
const sendToServer = (frame) => { child.stdin.write(\`\${JSON.stringify(frame)}\\n\`); };
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf('\\n');
  while (newline >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    let frame;
    try { frame = JSON.parse(line); } catch { newline = buffer.indexOf('\\n'); continue; }
    if (frame.id === 1) {
      sendToServer({ jsonrpc: '2.0', method: 'notifications/initialized' });
      sendToServer({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'capture_direct', arguments: { probeLabel: process.env.PROBE_LABEL } } });
    }
    newline = buffer.indexOf('\\n');
  }
});
child.on('exit', () => process.exit(0));
sendToServer({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'direct-detached-spawner', version: '0.0.0' } } });
setInterval(() => {}, 1_000);
`;
}

async function buildDirectDriverFixture(scenario) {
  const parent = await mkdtemp(join(tmpdir(), `zcode-direct-fixture-${scenario}-`));
  await chmod(parent, 0o700);
  const codexPath = join(parent, 'codex-fixture.mjs');
  const intermediatePath = join(parent, 'codex-intermediate.mjs');
  await writeFile(codexPath, directFakeAppServerScript(scenario, directServerModulePath, intermediatePath), { mode: 0o755 });
  await chmod(codexPath, 0o755);
  await writeFile(intermediatePath, directDetachedSpawnerScript(), { mode: 0o755 });
  await chmod(intermediatePath, 0o755);
  const sourceHome = join(parent, 'source-home');
  await fsp.mkdir(sourceHome, { mode: 0o700 });
  await writeFile(join(sourceHome, 'auth.json'), '{"fixture":"auth"}\n', { mode: 0o600 });
  return { parent, codexPath, sourceHome };
}

test('the direct driver reachability schedule classifies a true handler response against the fake app-server', async () => {
  const { runDirectReachabilityProbe } = await loadDirectDriver();
  const fixture = await buildDirectDriverFixture('success');
  try {
    const run = join(fixture.parent, 'run');
    await fsp.mkdir(run, { mode: 0o700 });
    const counters = await runDirectReachabilityProbe({ codexPath: fixture.codexPath, sourceCodexHome: fixture.sourceHome, runDirectory: run });
    assert.equal(counters.probe, 'zcode-direct-mcp-probe');
    assert.equal(counters.mode, 'reachability');
    assert.equal(counters.codexVersion, 'codex-cli 9.9.9-fixture');
    const phase = counters.phases.reachability;
    assert.equal(phase.readiness, 'discovered');
    assert.equal(phase.requestsSent, 1);
    assert.equal(phase.rpcObservations, 1);
    assert.equal(phase.handlerEntries, 1);
    assert.equal(phase.classification, 'success-handler-entered');
    assert.equal(phase.cleanup, 'released');
    assert.equal(phase.uncommittedCount, 0);
    assert.ok(phase.eventsAfter > phase.eventsBefore, 'the durable event position advanced across the direct request');
    // The evidence stays private at mode 0600 inside the run container.
    const files = await fsp.readdir(run);
    assert.ok(files.includes('events.jsonl'), 'the durable evidence log exists');
    const eventsStats = await lstat(join(run, 'events.jsonl'));
    assert.equal(eventsStats.mode & 0o777, 0o600, 'evidence stays private at mode 0600');
    // The isolated credential copy and homes are verified-deleted; only the
    // evidence container remains.
    const leftovers = files.filter((name) => name.startsWith('codex-home') || name === 'home' || name === 'tmp' || name.startsWith('marketplace') || name === 'workspace');
    assert.deepEqual(leftovers, [], 'isolated homes and fixtures are removed after the run');
  } finally {
    await rm(fixture.parent, { recursive: true, force: true });
  }
});

test('the direct driver reachability schedule records an unknown origin when the fake app-server answers without handler entry', async () => {
  const { runDirectReachabilityProbe } = await loadDirectDriver();
  const fixture = await buildDirectDriverFixture('error-without-entry');
  try {
    const run = join(fixture.parent, 'run');
    await fsp.mkdir(run, { mode: 0o700 });
    const counters = await runDirectReachabilityProbe({ codexPath: fixture.codexPath, sourceCodexHome: fixture.sourceHome, runDirectory: run });
    const phase = counters.phases.reachability;
    assert.equal(phase.classification, 'error-result-unknown-origin');
    assert.equal(phase.handlerEntries, 0, 'no handler entry landed when the host answered without reaching the handler');
    assert.equal(phase.serverStarts, 1, 'the disposable server started, which alone must never imply entry');
    assert.equal(phase.readiness, 'discovered');
    assert.equal(phase.cleanup, 'released');
  } finally {
    await rm(fixture.parent, { recursive: true, force: true });
  }
});

test('the direct driver reachability schedule reduces an rpc rejection after a fake app-server discovery failure', async () => {
  const { runDirectReachabilityProbe } = await loadDirectDriver();
  const fixture = await buildDirectDriverFixture('discovery-failure-reject');
  try {
    const run = join(fixture.parent, 'run');
    await fsp.mkdir(run, { mode: 0o700 });
    const counters = await runDirectReachabilityProbe({ codexPath: fixture.codexPath, sourceCodexHome: fixture.sourceHome, runDirectory: run });
    const phase = counters.phases.reachability;
    assert.equal(phase.readiness, 'failed', 'the discovery rejection is recorded honestly');
    assert.equal(phase.requestsSent, 1, 'the transport observation is still attempted after a failed discovery');
    assert.equal(phase.rpcObservations, 1);
    assert.equal(phase.classification, 'rpc-rejected');
    assert.equal(phase.handlerEntries, 0);
    assert.equal(phase.cleanup, 'released');
  } finally {
    await rm(fixture.parent, { recursive: true, force: true });
  }
});

test('the direct driver reachability schedule attributes a host-reported error result to the durable handler entry', async () => {
  const { runDirectReachabilityProbe } = await loadDirectDriver();
  const fixture = await buildDirectDriverFixture('error-with-entry');
  try {
    const run = join(fixture.parent, 'run');
    await fsp.mkdir(run, { mode: 0o700 });
    const counters = await runDirectReachabilityProbe({ codexPath: fixture.codexPath, sourceCodexHome: fixture.sourceHome, runDirectory: run });
    const phase = counters.phases.reachability;
    assert.equal(phase.classification, 'error-result-handler-entered');
    assert.equal(phase.handlerEntries, 1, 'the entry is independently durable even though the host reported an error result');
    assert.equal(phase.readiness, 'discovered');
    assert.equal(phase.cleanup, 'released');
  } finally {
    await rm(fixture.parent, { recursive: true, force: true });
  }
});

test('the direct driver refuses a codex binary replaced mid-run and still deletes the credential copies', async () => {
  const { runDirectReachabilityProbe } = await loadDirectDriver();
  const fixture = await buildDirectDriverFixture('self-replace');
  try {
    const run = join(fixture.parent, 'run');
    await fsp.mkdir(run, { mode: 0o700 });
    await assert.rejects(
      () => runDirectReachabilityProbe({ codexPath: fixture.codexPath, sourceCodexHome: fixture.sourceHome, runDirectory: run }),
      /PROBE_CODEX_REPLACED/,
      'the device/inode pin refuses a replaced binary before the next spawn',
    );
    const files = await fsp.readdir(run);
    assert.equal(files.includes('auth-copy'), false, 'the isolated credential copy is verified-deleted even on the failure path');
    assert.equal(files.includes('codex-home'), false, 'the isolated codex home is removed even on the failure path');
    assert.equal(files.includes('events.jsonl'), false, 'no evidence exists before the app-server phase');
  } finally {
    await rm(fixture.parent, { recursive: true, force: true });
  }
});

test('the direct driver CLI prints only redacted phase and outcome counters', async () => {
  const fixture = await buildDirectDriverFixture('success');
  try {
    const run = join(fixture.parent, 'run');
    await fsp.mkdir(run, { mode: 0o700 });
    const child = spawn(process.execPath, [
      directDriverModulePath, '--mode', 'reachability', '--codex', fixture.codexPath, '--run-directory', run,
      '--source-codex-home', fixture.sourceHome,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdoutChunks = [];
    const stderrChunks = [];
    child.stdout.on('data', (chunk) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk) => stderrChunks.push(chunk));
    const exit = await new Promise((resolveExit) => child.once('close', (code) => resolveExit(code)));
    assert.equal(exit, 0, `the CLI exits 0 on an instrument-successful run (stderr: ${Buffer.concat(stderrChunks).toString('utf8').slice(0, 300)})`);
    const stdout = Buffer.concat(stdoutChunks).toString('utf8');
    const counters = JSON.parse(stdout);
    assert.equal(counters.probe, 'zcode-direct-mcp-probe');
    assert.equal(counters.mode, 'reachability');
    assert.equal(counters.phases.reachability.classification, 'success-handler-entered');
    assert.equal(counters.phases.reachability.cleanup, 'released');
    // Redaction: no run-directory path, no probe-label-shaped hex, no fake
    // thread identifier may appear in the counters stream.
    assert.equal(stdout.includes(run), false, 'the run directory path never reaches stdout');
    assert.equal(/[0-9a-f]{32}/.test(stdout.replace(/"codexVersion":"[^"]*"/g, '')), false, 'no probe-label-shaped raw hex reaches stdout');
    assert.equal(stdout.includes('fixture-thread'), false, 'no host-issued thread identifier reaches stdout');
    assert.equal(stdout.includes(fixture.sourceHome), false, 'the source home path never reaches stdout');
  } finally {
    await rm(fixture.parent, { recursive: true, force: true });
  }
});

test('the direct driver honors an injected direct-call deadline and records the unanswered call as not observed with verified cleanup', async () => {
  const { runDirectReachabilityProbe } = await loadDirectDriver();
  const fixture = await buildDirectDriverFixture('call-never-answers');
  try {
    const run = join(fixture.parent, 'run');
    await fsp.mkdir(run, { mode: 0o700 });
    const startedAt = Date.now();
    const counters = await runDirectReachabilityProbe({
      codexPath: fixture.codexPath,
      sourceCodexHome: fixture.sourceHome,
      runDirectory: run,
      directCallDeadlineMs: 1_500,
    });
    const elapsedMs = Date.now() - startedAt;
    assert.ok(elapsedMs < 30_000, `the injected deadline must bound the run (observed ${elapsedMs}ms)`);
    const phase = counters.phases.reachability;
    assert.equal(phase.readiness, 'discovered', 'readiness was observed before the unanswered dispatch');
    assert.equal(phase.requestsSent, 1);
    assert.equal(phase.rpcObservations, 1);
    assert.equal(phase.classification, 'not-observed', 'a call that never received an answer stays honestly not observed');
    assert.equal(phase.handlerEntries, 0);
    assert.equal(phase.cleanup, 'released', 'probe-owned processes must be verified gone after the timeout');
    // Cleanup after the timeout, verified at the process level as well: no
    // probe-owned process (fixture host or disposable server) survives.
    const deadline = Date.now() + 5_000;
    for (;;) {
      const listed = spawnSync('/bin/ps', ['-axo', 'command='], { encoding: 'utf8', timeout: 5_000 });
      const survivors = listed.status === 0
        ? listed.stdout.split('\n').filter((line) => line.includes(fixture.codexPath) || line.includes(directServerModulePath))
        : ['process listing unavailable'];
      if (survivors.length === 0) break;
      if (Date.now() > deadline) {
        assert.fail(`probe-owned processes survived the run: ${survivors.slice(0, 3).join(' | ').slice(0, 300)}`);
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    }
  } finally {
    await rm(fixture.parent, { recursive: true, force: true });
  }
});

test('the direct driver app-server session terminates on stdout overflow past its 4 MiB bound', async () => {
  const { startAppServerSession } = await loadDirectDriver();
  // A synthetic session flooding stdout past the per-stream bound: the new
  // client must terminate the child and settle the pending request through
  // the disconnect path, well before the request's own deadline.
  const flood = [
    'const chunk = "x".repeat(65536) + "\\n";',
    'const timer = setInterval(() => {',
    '  for (let i = 0; i < 64; i += 1) process.stdout.write(chunk);',
    '}, 1);',
  ].join('\n');
  const session = startAppServerSession({ command: process.execPath, args: ['-e', flood], env: process.env, cwd: tmpdir() });
  try {
    const startedAt = Date.now();
    await assert.rejects(
      session.request('initialize', { capabilities: null }),
      (error) => error.code === 'PROBE_APP_SERVER_DISCONNECTED',
      'stdout overflow must terminate the bounded session and settle the pending request',
    );
    assert.ok(Date.now() - startedAt < 30_000, 'the settlement must come from the overflow termination, not the request deadline');
  } finally {
    await session.terminate();
  }
});

test('the direct driver app-server session terminates on non-delta notification overflow while counting deltas redacted', async () => {
  const { startAppServerSession } = await loadDirectDriver();
  // 640 streamed deltas must NOT terminate the bounded session; a retained
  // non-delta flood past the 512-notification cap must. Pending requests
  // settle through the disconnect path and the redacted counters record both.
  const flood = [
    'let count = 0;',
    'let deltasDone = false;',
    'let noiseSent = false;',
    'const timer = setInterval(() => {',
    '  if (!deltasDone) {',
    '    for (let i = 0; i < 32; i += 1) {',
    '      count += 1;',
    '      process.stdout.write(JSON.stringify({ method: "item/agentMessage/delta", params: { n: count } }) + "\\n");',
    '    }',
    '    if (count >= 640) deltasDone = true;',
    '    return;',
    '  }',
    '  if (!noiseSent) {',
    '    let noise = "";',
    '    for (let i = 0; i < 600; i += 1) noise += JSON.stringify({ method: "probe/noise", params: {} }) + "\\n";',
    '    process.stdout.write(noise);',
    '    noiseSent = true;',
    '    return;',
    '  }',
    '  clearInterval(timer);',
    '}, 5);',
  ].join('\n');
  const session = startAppServerSession({ command: process.execPath, args: ['-e', flood], env: process.env, cwd: tmpdir() });
  try {
    const startedAt = Date.now();
    await assert.rejects(
      session.request('initialize', { capabilities: null }),
      (error) => error.code === 'PROBE_APP_SERVER_DISCONNECTED',
      'non-delta notification overflow must terminate the bounded session and settle the pending request',
    );
    assert.ok(Date.now() - startedAt < 30_000, 'the settlement must come from the overflow termination, not the request deadline');
    assert.ok(session.notificationsDeltaCount >= 640, `the delta stream must only be counted redacted (observed ${session.notificationsDeltaCount})`);
    assert.ok(session.notificationsOverflow >= 1, 'the overflow counter must count the discarded notifications');
  } finally {
    await session.terminate();
  }
});

test('the direct driver deletes the credential copy when auth setup fails inside the protected scope', { skip: !posix }, async () => {
  const { runDirectReachabilityProbe } = await loadDirectDriver();
  const fixture = await buildDirectDriverFixture('success');
  try {
    // A source auth.json that passes the regular-file lstat but cannot be
    // read: the copy fails AFTER the isolated homes exist. The credential
    // setup (directory creation and auth copy) must sit inside the
    // cleanup-protected scope, so the partial copy and every isolated home
    // are verified-deleted even on this failure.
    await chmod(join(fixture.sourceHome, 'auth.json'), 0o000);
    const run = join(fixture.parent, 'run');
    await fsp.mkdir(run, { mode: 0o700 });
    await assert.rejects(
      () => runDirectReachabilityProbe({ codexPath: fixture.codexPath, sourceCodexHome: fixture.sourceHome, runDirectory: run }),
      /PROBE_QUALIFICATION_UNAVAILABLE/,
      'the auth-copy failure maps to a closed probe code',
    );
    const files = await fsp.readdir(run);
    assert.equal(files.includes('codex-home'), false, 'the isolated home holding any partial credential copy is verified-deleted on setup failure');
    assert.equal(files.includes('home'), false, 'the other isolated homes are verified-deleted on setup failure');
    assert.equal(files.includes('workspace'), false, 'the isolated workspace is verified-deleted on setup failure');
  } finally {
    await rm(fixture.parent, { recursive: true, force: true });
  }
});

test('the direct driver CLI maps failures to a closed error code without raw paths', { skip: !posix }, async () => {
  const fixture = await buildDirectDriverFixture('success');
  try {
    await chmod(join(fixture.sourceHome, 'auth.json'), 0o000);
    const run = join(fixture.parent, 'run');
    await fsp.mkdir(run, { mode: 0o700 });
    const child = spawn(process.execPath, [
      directDriverModulePath, '--mode', 'reachability', '--codex', fixture.codexPath, '--run-directory', run,
      '--source-codex-home', fixture.sourceHome,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdoutChunks = [];
    const stderrChunks = [];
    child.stdout.on('data', (chunk) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk) => stderrChunks.push(chunk));
    const exit = await new Promise((resolveExit) => child.once('close', (code) => resolveExit(code)));
    assert.equal(exit, 1, 'a failed run exits nonzero');
    const stdout = Buffer.concat(stdoutChunks).toString('utf8');
    const stderrText = Buffer.concat(stderrChunks).toString('utf8');
    // The failure line carries only the closed code; the driver's own
    // redacted transcript lines (phase names, exit codes, basenames) may
    // accompany it, but no raw filesystem error message may.
    assert.equal(stderrText.split('\n').includes('direct driver failed: PROBE_QUALIFICATION_UNAVAILABLE'), true, 'the CLI boundary prints only the closed error code');
    assert.equal(/EACCES|permission denied/.test(stderrText), false, 'no raw filesystem error text reaches stderr');
    assert.equal(stderrText.includes(fixture.sourceHome), false, 'the source home path never reaches stderr');
    assert.equal(stderrText.includes(run), false, 'the run directory path never reaches stderr');
    assert.equal(stderrText.includes(fixture.codexPath), false, 'the codex path never reaches stderr');
    assert.equal(stdout, '', 'no counters are printed on a failed run');
  } finally {
    await rm(fixture.parent, { recursive: true, force: true });
  }
});

test('the direct driver prints no raw host text, paths, or stacks on stderr even with DEBUG_DIRECT_PROBE set', async () => {
  const fixture = await buildDirectDriverFixture('reject');
  try {
    const run = join(fixture.parent, 'run');
    await fsp.mkdir(run, { mode: 0o700 });
    // The fake host rejects the direct call with a message that deliberately
    // embeds the run-directory path: real host rejection text can carry paths
    // or other sensitive values. With the debug flag enabled the driver must
    // still emit ONLY closed codes on stderr — stderr is commonly retained by
    // the caller, and the CLI boundary must hold even under DEBUG_DIRECT_PROBE.
    const child = spawn(process.execPath, [
      directDriverModulePath, '--mode', 'reachability', '--codex', fixture.codexPath, '--run-directory', run,
      '--source-codex-home', fixture.sourceHome,
    ], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, DEBUG_DIRECT_PROBE: '1' } });
    const stdoutChunks = [];
    const stderrChunks = [];
    child.stdout.on('data', (chunk) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk) => stderrChunks.push(chunk));
    const exit = await new Promise((resolveExit) => child.once('close', (code) => resolveExit(code)));
    assert.equal(exit, 0, 'a rejected direct call is an observation, not a crash');
    const stderrText = Buffer.concat(stderrChunks).toString('utf8');
    // The raw host rejection text — with its embedded path — never reaches stderr.
    assert.equal(stderrText.includes('tool call rejected'), false, 'raw host rejection text never reaches stderr');
    assert.equal(stderrText.includes(run), false, 'the run-directory path inside the host rejection never reaches stderr');
    assert.equal(stderrText.includes(fixture.parent), false, 'the fixture parent path never reaches stderr');
    assert.equal(stderrText.includes(fixture.codexPath), false, 'the codex path never reaches stderr');
    assert.equal(stderrText.includes(fixture.sourceHome), false, 'the source home path never reaches stderr');
    // No raw stack frames and no raw host-message field reach stderr.
    assert.equal(/^\s+at /m.test(stderrText), false, 'no raw stack frames reach stderr');
    assert.equal(stderrText.includes('hostMessage'), false, 'the raw host-message field is never printed');
    // Under the flag the driver may print ONLY the closed error code.
    assert.equal(stderrText.includes('DEBUG-CALL-ERR PROBE_APP_SERVER_REQUEST_FAILED'), true, 'the debug line carries only the closed error code');
  } finally {
    await rm(fixture.parent, { recursive: true, force: true });
  }
});

test('the direct driver refuses an in-place binary rewrite that keeps the device and inode', async () => {
  const { runDirectReachabilityProbe } = await loadDirectDriver();
  const fixture = await buildDirectDriverFixture('self-rewrite-inplace');
  try {
    const run = join(fixture.parent, 'run');
    await fsp.mkdir(run, { mode: 0o700 });
    // The fixture rewrites its own file IN PLACE during `plugin marketplace
    // add` (same path, same device/inode, different content): the driver must
    // catch the change through its content digest and fail closed before the
    // next spawn, not silently run a binary whose version no longer matches.
    await assert.rejects(
      () => runDirectReachabilityProbe({ codexPath: fixture.codexPath, sourceCodexHome: fixture.sourceHome, runDirectory: run }),
      /PROBE_CODEX_REPLACED/,
      'a content change under the same inode must fail the pin closed',
    );
    const files = await fsp.readdir(run);
    assert.equal(files.includes('codex-home'), false, 'the isolated credential home is verified-deleted on the failure path');
  } finally {
    await rm(fixture.parent, { recursive: true, force: true });
  }
});

test('the direct driver fails closed when the pinned binary changes between cleanup commands', async () => {
  const { runDirectReachabilityProbe } = await loadDirectDriver();
  const fixture = await buildDirectDriverFixture('cleanup-replace');
  try {
    const run = join(fixture.parent, 'run');
    await fsp.mkdir(run, { mode: 0o700 });
    // The fixture behaves normally through the whole schedule, then rewrites
    // itself in place during `plugin remove`: the second cleanup command
    // (`marketplace remove`) must be preceded by a fresh pin recheck, and the
    // detected change must fail the run closed instead of spawning the
    // rewritten binary.
    await assert.rejects(
      () => runDirectReachabilityProbe({ codexPath: fixture.codexPath, sourceCodexHome: fixture.sourceHome, runDirectory: run }),
      /PROBE_CODEX_REPLACED/,
      'a binary change between cleanup commands must fail the run closed',
    );
    const files = await fsp.readdir(run);
    assert.equal(files.includes('codex-home'), false, 'the isolated credential home is still verified-deleted');
    assert.equal(files.includes('auth-copy'), false);
  } finally {
    await rm(fixture.parent, { recursive: true, force: true });
  }
});

test('the direct driver enforces one post-readiness ceiling across the direct call and cleanup', async () => {
  const { runDirectReachabilityProbe } = await loadDirectDriver();
  const fixture = await buildDirectDriverFixture('call-never-answers');
  try {
    const run = join(fixture.parent, 'run');
    await fsp.mkdir(run, { mode: 0o700 });
    // The injected per-call deadline alone would allow a 30-second call; the
    // single post-readiness case ceiling must bound the call AND the cleanup
    // together, and the ceiling-prevented observation records honestly.
    const startedAt = Date.now();
    const counters = await runDirectReachabilityProbe({
      codexPath: fixture.codexPath,
      sourceCodexHome: fixture.sourceHome,
      runDirectory: run,
      directCallDeadlineMs: 30_000,
      caseBudgetMs: 2_000,
    });
    const elapsedMs = Date.now() - startedAt;
    // The CASE ceiling is enforced, not just the call deadline: with a 2s
    // budget, discovery, the durable join, and cleanup must all fit inside a
    // small scheduling allowance above it.
    assert.ok(elapsedMs < 5_000, `the post-readiness ceiling must bound the whole case, including process inspection and cleanup (observed ${elapsedMs}ms)`);
    const phase = counters.phases.reachability;
    assert.equal(phase.requestsSent, 1);
    assert.equal(phase.rpcObservations, 1);
    assert.equal(phase.classification, 'not-observed', 'a ceiling-prevented observation records not-observed, never a pass');
    assert.equal(phase.postReadinessBudget, 'exhausted');
    assert.equal(phase.cleanup, 'released', 'the bounded cleanup still verifies every probe-owned process is gone');
  } finally {
    await rm(fixture.parent, { recursive: true, force: true });
  }
});

test('the direct driver resolves a server process the first scan cannot see and verifies its exit during cleanup', async () => {
  const { runDirectReachabilityProbe } = await loadDirectDriver();
  const fixture = await buildDirectDriverFixture('detached-server');
  try {
    const run = join(fixture.parent, 'run');
    await fsp.mkdir(run, { mode: 0o700 });
    // The host dispatches through an intermediate spawner, so the server's
    // parent is not the app-server process and the first (parent-filtered)
    // scan cannot see it. The durable handler entry still exists, so cleanup
    // must re-inspect, adopt the registered owner process, and verify its
    // exit — never report release while the server is unaccounted for.
    const counters = await runDirectReachabilityProbe({ codexPath: fixture.codexPath, sourceCodexHome: fixture.sourceHome, runDirectory: run });
    const phase = counters.phases.reachability;
    assert.equal(phase.handlerEntries, 1);
    assert.equal(phase.classification, 'success-handler-entered');
    assert.equal(phase.readiness, 'discovered');
    assert.equal(phase.cleanup, 'released', 'the late-resolved server is verified dead, so cleanup is released');
    assert.equal(phase.postReadinessBudget, 'within-budget');
  } finally {
    // Scoped teardown for this fixture only: the intermediate's command line
    // carries the fixture parent path; killing it closes the detached
    // server's stdin so the server exits through its own bounded watchdog
    // even if the assertions above failed first.
    spawnSync('/usr/bin/pkill', ['-f', fixture.parent], { timeout: 5_000 });
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
    await rm(fixture.parent, { recursive: true, force: true });
  }
});

test('the direct driver fails cleanup as unresolved when a durable server start cannot be verified to have exited', async () => {
  const { runDirectReachabilityProbe } = await loadDirectDriver();
  const fixture = await buildDirectDriverFixture('server-exits-early');
  try {
    const run = join(fixture.parent, 'run');
    await fsp.mkdir(run, { mode: 0o700 });
    // The durable server-started exists but no live process can be found to
    // verify its exit: cleanup must fail as unresolved instead of reporting
    // release for an unaccounted-for server.
    await assert.rejects(
      () => runDirectReachabilityProbe({ codexPath: fixture.codexPath, sourceCodexHome: fixture.sourceHome, runDirectory: run }),
      /PROBE_SERVER_PID_UNRESOLVED/,
      'an observed server start whose exit cannot be verified must fail cleanup closed',
    );
    const files = await fsp.readdir(run);
    assert.equal(files.includes('codex-home'), false, 'the isolated credential home is still verified-deleted on the failure path');
  } finally {
    await rm(fixture.parent, { recursive: true, force: true });
  }
});

test('the direct driver treats an unreadable durable log at cleanup as unresolved release', async () => {
  const { runDirectReachabilityProbe } = await loadDirectDriver();
  const fixture = await buildDirectDriverFixture('log-unreadable');
  try {
    const run = join(fixture.parent, 'run');
    await fsp.mkdir(run, { mode: 0o700 });
    // The host made the evidence log unreadable when it received the
    // dispatch: cleanup must RE-READ the durable log fresh (never trust the
    // earlier counters) and, when the log cannot be read at all, treat the
    // server exit as unverifiable — release-failed and fail closed — instead
    // of reporting release for a start it can no longer rule out.
    await assert.rejects(
      () => runDirectReachabilityProbe({ codexPath: fixture.codexPath, sourceCodexHome: fixture.sourceHome, runDirectory: run }),
      /PROBE_SERVER_PID_UNRESOLVED/,
      'an unreadable durable log must fail cleanup as unresolved, never released',
    );
    const files = await fsp.readdir(run);
    assert.equal(files.includes('codex-home'), false, 'the isolated credential home is still verified-deleted on the failure path');
  } finally {
    await rm(fixture.parent, { recursive: true, force: true });
  }
});

test('the direct driver keeps a live-server case inside the post-readiness ceiling', async () => {
  const { runDirectReachabilityProbe } = await loadDirectDriver();
  const fixture = await buildDirectDriverFixture('error-without-entry');
  try {
    const run = join(fixture.parent, 'run');
    await fsp.mkdir(run, { mode: 0o700 });
    // Unlike the other ceiling case, this fixture leaves a LIVE server
    // process running: discovery adopts it, identity capture and the exit
    // match are bounded by the remaining case time, and the truncated
    // cleanup records the exhaustion honestly while still verifying the
    // server's exit.
    const startedAt = Date.now();
    const counters = await runDirectReachabilityProbe({
      codexPath: fixture.codexPath,
      sourceCodexHome: fixture.sourceHome,
      runDirectory: run,
      caseBudgetMs: 3_500,
    });
    const elapsedMs = Date.now() - startedAt;
    assert.ok(elapsedMs < 5_000, `the whole case with a live server must sit inside the ceiling plus a small scheduling allowance (observed ${elapsedMs}ms)`);
    const phase = counters.phases.reachability;
    assert.equal(phase.readiness, 'discovered');
    assert.equal(phase.requestsSent, 1);
    assert.equal(phase.rpcObservations, 1);
    assert.equal(phase.serverStarts, 1);
    assert.equal(phase.classification, 'error-result-unknown-origin', 'the host answered without the handler, so the origin stays unknown');
    assert.equal(phase.cleanup, 'released', 'the live server is still verified gone inside the ceiling');
    assert.equal(phase.postReadinessBudget, 'exhausted');
  } finally {
    await rm(fixture.parent, { recursive: true, force: true });
  }
});

test('the direct driver forces release-failed when the log is unreadable even with a captured server pid', async () => {
  const { runDirectReachabilityProbe } = await loadDirectDriver();
  const fixture = await buildDirectDriverFixture('log-unreadable-known-pid');
  try {
    const run = join(fixture.parent, 'run');
    await fsp.mkdir(run, { mode: 0o700 });
    // The fixture leaves a CAPTURED, live server pid in place while the log
    // is unreadable: the pid's exit is verified for hygiene, but the release
    // verdict must still fail as unresolved — the unreadable evidence can no
    // longer rule out additional observed starts.
    await assert.rejects(
      () => runDirectReachabilityProbe({ codexPath: fixture.codexPath, sourceCodexHome: fixture.sourceHome, runDirectory: run }),
      /PROBE_SERVER_PID_UNRESOLVED/,
      'an unreadable durable log forces release-failed regardless of a captured pid',
    );
    const files = await fsp.readdir(run);
    assert.equal(files.includes('codex-home'), false, 'the isolated credential home is still verified-deleted on the failure path');
  } finally {
    await rm(fixture.parent, { recursive: true, force: true });
  }
});

test('the direct driver bounds the pin hash by its deadline', { skip: !posix }, async () => {
  const { sha256File } = await loadDirectDriver();
  const parent = await mkdtemp(join(tmpdir(), 'zcode-direct-hash-'));
  try {
    // /dev/zero delivers infinite bytes: the hash can never complete, so the
    // bounded hash must abort with the closed code within its deadline (and
    // still resolve for a regular file).
    const startedAt = Date.now();
    await assert.rejects(
      sha256File('/dev/zero', 250),
      (error) => error.code === 'PROBE_HASH_TIMEOUT',
      'a stalled hash must abort with the closed timeout code',
    );
    assert.ok(Date.now() - startedAt < 5_000, 'the hash abort must come from the deadline, not an unbounded wait');
    const regularPath = join(parent, 'regular.bin');
    await writeFile(regularPath, 'regular bytes');
    await sha256File(regularPath, 10_000);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('the direct driver fails cleanup as unresolved when the durable log holds multiple unaccountable server starts', async () => {
  const { runDirectReachabilityProbe } = await loadDirectDriver();
  const fixture = await buildDirectDriverFixture('server-restart');
  try {
    const run = join(fixture.parent, 'run');
    await fsp.mkdir(run, { mode: 0o700 });
    // The host restarted the disposable server during dispatch: the durable
    // log holds TWO distinct server starts (distinct instance hashes) while
    // only one handler-owner registration exists. Cleanup cannot account for
    // every start, so it must fail as unresolved instead of releasing.
    await assert.rejects(
      () => runDirectReachabilityProbe({ codexPath: fixture.codexPath, sourceCodexHome: fixture.sourceHome, runDirectory: run }),
      /PROBE_SERVER_PID_UNRESOLVED/,
      'multiple durable server starts must fail cleanup as unresolved, never released',
    );
    const files = await fsp.readdir(run);
    assert.equal(files.includes('codex-home'), false, 'the isolated credential home is still verified-deleted on the failure path');
  } finally {
    spawnSync('/usr/bin/pkill', ['-f', fixture.parent], { timeout: 5_000 });
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
    await rm(fixture.parent, { recursive: true, force: true });
  }
});

test('the direct driver skips the removal commands at an exhausted ceiling and records the skip', async () => {
  const { runDirectReachabilityProbe } = await loadDirectDriver();
  const fixture = await buildDirectDriverFixture('error-without-entry');
  try {
    const run = join(fixture.parent, 'run');
    await fsp.mkdir(run, { mode: 0o700 });
    // The live-server case under a tight ceiling: after the truncated
    // cleanup, the remaining budget is below the cleanup-command floor, so
    // the removal commands must be SKIPPED (the registration is removed with
    // its isolated home) and the skip recorded honestly — never spawned past
    // the ceiling.
    const counters = await runDirectReachabilityProbe({
      codexPath: fixture.codexPath,
      sourceCodexHome: fixture.sourceHome,
      runDirectory: run,
      caseBudgetMs: 3_500,
    });
    const phase = counters.phases.reachability;
    assert.equal(phase.postReadinessBudget, 'exhausted');
    assert.equal(phase.cleanup, 'released');
    const invocations = await readFile(join(fixture.parent, 'invocations.log'), 'utf8');
    assert.equal(invocations.includes('plugin remove'), false, 'no removal command may spawn past the ceiling');
    assert.equal(invocations.includes('marketplace remove'), false, 'no marketplace removal may spawn past the ceiling');
  } finally {
    spawnSync('/usr/bin/pkill', ['-f', fixture.parent], { timeout: 5_000 });
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
    await rm(fixture.parent, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Task 4: bounded turn-identity matrix and the synthetic authorization-bridge
// candidate. The ordering and authority rules live in
// `tools/direct-mcp-probe/identity.mjs` (pure, no IO). Every fixture below is
// a FAKE transcript: no real host is contacted, and every identity value is
// hashed under one fixed per-suite run nonce exactly as the run would salt
// them, so raw IDs never appear even in test fixtures.
// ---------------------------------------------------------------------------

const DIRECT_IDENTITY_NONCE = directRunNonce();
function identityHash(raw) { return hashProbeValue(DIRECT_IDENTITY_NONCE, raw); }

/** One ordered host turn-state observation (a reduced turn-state-observed fact). */
function identityTurn(sequence, state, threadRaw, turnRaw) {
  return {
    sequence,
    state,
    threadHash: threadRaw === null ? null : identityHash(threadRaw),
    turnHash: turnRaw === null ? null : identityHash(turnRaw),
  };
}

function identityCandidates(overrides = {}) {
  return { envelopeThreadId: null, innerSessionId: null, innerThreadId: null, innerTurnId: null, ...overrides };
}

test('identity ordering binds an active turn only when ordered host observations bracket handler entry', async () => {
  const { classifyDirectIdentitySample } = await import('../tools/direct-mcp-probe/identity.mjs');
  // Active turn A: the exact turn was observed active BEFORE and AFTER the
  // durable handler entry, and the metadata candidates match the
  // independently learned host thread and turn identities.
  const sample = {
    entryJoined: true,
    entrySequence: 10,
    metadataCandidates: identityCandidates({
      envelopeThreadId: identityHash('thread-T1'),
      innerTurnId: identityHash('turn-A'),
    }),
    expectedThreadHash: identityHash('thread-T1'),
    expectedTurnHash: identityHash('turn-A'),
    preTurn: identityTurn(5, 'active', 'thread-T1', 'turn-A'),
    postTurn: identityTurn(15, 'active', 'thread-T1', 'turn-A'),
  };
  assert.equal(classifyDirectIdentitySample(sample), 'binding-observed');
});

test('identity ordering classifies an idle-thread call as correlation only, never authority', async () => {
  const { classifyDirectIdentitySample } = await import('../tools/direct-mcp-probe/identity.mjs');
  // New idle thread: no turn was ever observed (pre and post absent); the
  // metadata echoes the thread id. The hash matches, but a matching hash on
  // an idle thread is a transport observation only — it can never bind a turn.
  const sample = {
    entryJoined: true,
    entrySequence: 4,
    metadataCandidates: identityCandidates({ envelopeThreadId: identityHash('thread-T1') }),
    expectedThreadHash: identityHash('thread-T1'),
    expectedTurnHash: null,
    preTurn: null,
    postTurn: null,
  };
  assert.equal(classifyDirectIdentitySample(sample), 'correlation-only');
});

test('identity ordering classifies a completed-thread call as correlation with a retained value distinguished from missing metadata', async () => {
  const { classifyDirectIdentitySample } = await import('../tools/direct-mcp-probe/identity.mjs');
  // Completed turn A: the host observed A completing BEFORE the call, and the
  // metadata may retain A's value. Even an exact match is correlation only —
  // a completed turn cannot authorize anything.
  const completed = {
    entryJoined: true,
    entrySequence: 20,
    metadataCandidates: identityCandidates({ envelopeThreadId: identityHash('thread-T1'), innerTurnId: identityHash('turn-A') }),
    expectedThreadHash: identityHash('thread-T1'),
    expectedTurnHash: identityHash('turn-A'),
    preTurn: identityTurn(5, 'completed', 'thread-T1', 'turn-A'),
    postTurn: identityTurn(25, 'completed', 'thread-T1', 'turn-A'),
  };
  assert.equal(classifyDirectIdentitySample(completed), 'correlation-only');
  // The missing-metadata variant on the same completed thread is recorded
  // distinctly: without candidates there is nothing to correlate.
  const missing = { ...completed, metadataCandidates: identityCandidates() };
  assert.equal(classifyDirectIdentitySample(missing), 'no-candidate-observed');
});

test('identity ordering binds a later active turn B and rejects a stale A candidate as a mismatch', async () => {
  const { classifyDirectIdentitySample } = await import('../tools/direct-mcp-probe/identity.mjs');
  // Later active turn B on the same thread: ordered observations bracket entry
  // and the candidate carries B's hash — binding for B.
  const activeB = {
    entryJoined: true,
    entrySequence: 30,
    metadataCandidates: identityCandidates({ envelopeThreadId: identityHash('thread-T1'), innerTurnId: identityHash('turn-B') }),
    expectedThreadHash: identityHash('thread-T1'),
    expectedTurnHash: identityHash('turn-B'),
    preTurn: identityTurn(25, 'active', 'thread-T1', 'turn-B'),
    postTurn: identityTurn(35, 'active', 'thread-T1', 'turn-B'),
  };
  assert.equal(classifyDirectIdentitySample(activeB), 'binding-observed');
  // Stale turn: the SAME request shape whose candidate still carries A's hash
  // while the host's independently learned turn is B contradicts the host —
  // the sample is a mismatch, never a binding, even though the thread matches.
  const stale = { ...activeB, metadataCandidates: identityCandidates({ envelopeThreadId: identityHash('thread-T1'), innerTurnId: identityHash('turn-A') }) };
  assert.equal(classifyDirectIdentitySample(stale), 'mismatch-observed');
});

test('identity ordering records an interrupted turn between the pre-read and entry as inconclusive', async () => {
  const { classifyDirectIdentitySample } = await import('../tools/direct-mcp-probe/identity.mjs');
  // A was active at the pre-read, but the post-read observed it interrupted.
  // A may have ended before handler entry: without an ordered notification
  // attributing the interruption to after the entry, the sample is
  // inconclusive — never a binding.
  const interrupted = {
    entryJoined: true,
    entrySequence: 10,
    metadataCandidates: identityCandidates({ envelopeThreadId: identityHash('thread-T1'), innerTurnId: identityHash('turn-A') }),
    expectedThreadHash: identityHash('thread-T1'),
    expectedTurnHash: identityHash('turn-A'),
    preTurn: identityTurn(5, 'active', 'thread-T1', 'turn-A'),
    postTurn: identityTurn(15, 'interrupted', 'thread-T1', 'turn-A'),
  };
  assert.equal(classifyDirectIdentitySample(interrupted), 'inconclusive');
});

test('identity ordering keeps the A-to-B transition race inconclusive without ordered attribution and binds it once B is ordered before entry', async () => {
  const { classifyDirectIdentitySample } = await import('../tools/direct-mcp-probe/identity.mjs');
  // Transition race: pre-read saw active A, the post-read saw active B. A
  // finished between the pre-read and entry and B started somewhere in
  // between; no ordered observation proves which turn owned the event.
  const race = {
    entryJoined: true,
    entrySequence: 10,
    metadataCandidates: identityCandidates({ envelopeThreadId: identityHash('thread-T1'), innerTurnId: identityHash('turn-B') }),
    expectedThreadHash: identityHash('thread-T1'),
    expectedTurnHash: identityHash('turn-B'),
    preTurn: identityTurn(5, 'active', 'thread-T1', 'turn-A'),
    postTurn: identityTurn(15, 'active', 'thread-T1', 'turn-B'),
  };
  assert.equal(classifyDirectIdentitySample(race), 'inconclusive');
  // With ordered notifications the race resolves: A's completion is recorded
  // BEFORE entry and B's activation is also recorded BEFORE entry, so the
  // event window belongs to B — the binding is provable.
  const resolved = { ...race, preTurn: identityTurn(6, 'active', 'thread-T1', 'turn-B') };
  assert.equal(classifyDirectIdentitySample(resolved), 'binding-observed');
});

test('identity ordering rejects a wrong-thread candidate even when the turn hashes match', async () => {
  const { classifyDirectIdentitySample } = await import('../tools/direct-mcp-probe/identity.mjs');
  // Two threads: the request landed on thread T2 while the comparison expected
  // the independently learned T1 identity. A candidate from the wrong thread
  // is a mismatch — thread isolation is never bridged by a matching turn.
  const wrongThread = {
    entryJoined: true,
    entrySequence: 10,
    metadataCandidates: identityCandidates({ envelopeThreadId: identityHash('thread-T2'), innerTurnId: identityHash('turn-A') }),
    expectedThreadHash: identityHash('thread-T1'),
    expectedTurnHash: identityHash('turn-A'),
    preTurn: identityTurn(5, 'active', 'thread-T1', 'turn-A'),
    postTurn: identityTurn(15, 'active', 'thread-T1', 'turn-A'),
  };
  assert.equal(classifyDirectIdentitySample(wrongThread), 'mismatch-observed');
});

test('identity ordering records a missing durable entry join and a diagnostic label can never upgrade a sample', async () => {
  const { classifyDirectIdentitySample } = await import('../tools/direct-mcp-probe/identity.mjs');
  // Without a durable entry join there is nothing to classify: not observed,
  // whatever the metadata looks like.
  const unjoined = {
    entryJoined: false,
    entrySequence: 10,
    metadataCandidates: identityCandidates({ envelopeThreadId: identityHash('thread-T1'), innerTurnId: identityHash('turn-A') }),
    expectedThreadHash: identityHash('thread-T1'),
    expectedTurnHash: identityHash('turn-A'),
    preTurn: identityTurn(5, 'active', 'thread-T1', 'turn-A'),
    postTurn: identityTurn(15, 'active', 'thread-T1', 'turn-A'),
  };
  assert.equal(classifyDirectIdentitySample(unjoined), 'not-observed');
  // The diagnostic probeLabel is correlation input only: the classification
  // signature has no label input at all, so a matching label can never
  // upgrade a sample — a sample with every hash unknown stays without
  // candidates.
  const labelOnly = {
    entryJoined: true,
    entrySequence: 10,
    metadataCandidates: identityCandidates(),
    expectedThreadHash: null,
    expectedTurnHash: null,
    preTurn: null,
    postTurn: null,
  };
  assert.equal(classifyDirectIdentitySample(labelOnly), 'no-candidate-observed');
});

// ---------------------------------------------------------------------------
// Task 4 Step 4: the authorization bridge is a CANDIDATE, not a fact. The
// store below is a pure LOCAL fixture — modeled on the existing preparation
// store's consume-time checks (exact turn/workspace/permission/executor
// binding, once-only atomic consume) — and demonstrates the admission
// MECHANISM only. Nothing here upgrades G2: the fixture's trusted-caller path
// is explicitly fixture-internal.
// ---------------------------------------------------------------------------

const DIRECT_IDENTITY_BASE = 1_700_000_000_000;

function identityAuthorizedRequest(overrides = {}) {
  return {
    callerSource: 'probe-driver-own-thread',
    threadHash: identityHash('thread-T1'),
    turnHash: identityHash('turn-A'),
    operation: 'mcpServerToolCall',
    workspaceHash: identityHash('workspace-W1'),
    permissionMode: 'default',
    executorAgentId: null,
    foregroundAdapter: 'foreground',
    ...overrides,
  };
}

function identityHostObservation(overrides = {}) {
  return {
    threadHash: identityHash('thread-T1'),
    turnHash: identityHash('turn-A'),
    state: 'active',
    preObserved: true,
    postObserved: true,
    ...overrides,
  };
}

test('identity authorization bridge admits the exact authorized turn through a demonstrated trusted caller and consumes once', async () => {
  const { createDirectIdentityPreparationStore } = await import('../tools/direct-mcp-probe/identity.mjs');
  const store = createDirectIdentityPreparationStore();
  const authorized = store.authorize({
    callerSource: 'probe-driver-own-thread',
    threadHash: identityHash('thread-T1'),
    turnHash: identityHash('turn-A'),
    operation: 'mcpServerToolCall',
    workspaceHash: identityHash('workspace-W1'),
    permissionMode: 'default',
    requiredExecutorAgentId: null,
    foregroundAdapter: 'foreground',
    expiresAt: DIRECT_IDENTITY_BASE + 60_000,
    now: DIRECT_IDENTITY_BASE,
  });
  assert.equal(authorized.status, 'authorized', 'the positive fixture requires the demonstrated trusted-caller path');
  const preparation = authorized.preparation;
  assert.equal(preparation.consumedAt, null, 'the preparation starts unconsumed');
  const verdict = store.admit({
    request: identityAuthorizedRequest(),
    hostObservation: identityHostObservation(),
    preparationId: preparation.preparationId,
    now: DIRECT_IDENTITY_BASE + 1_000,
  });
  assert.equal(verdict.status, 'admitted', 'the exact authorized operation/turn with an unconsumed matching preparation is admitted');
  assert.equal(typeof verdict.preparationId, 'string');
  const consumed = store.preparationById(verdict.preparationId);
  assert.equal(consumed.consumedAt, DIRECT_IDENTITY_BASE + 1_000, 'admit atomically consumes exactly once');
  const duplicate = store.admit({
    request: identityAuthorizedRequest(),
    hostObservation: identityHostObservation(),
    preparationId: preparation.preparationId,
    now: DIRECT_IDENTITY_BASE + 2_000,
  });
  assert.equal(duplicate.status, 'rejected');
  assert.equal(duplicate.reasonCode, 'preparation-consumed', 'a duplicate request cannot re-consume the same authorization');
});

test('identity authorization bridge fails closed on an untrusted caller path', async () => {
  const { createDirectIdentityPreparationStore } = await import('../tools/direct-mcp-probe/identity.mjs');
  const store = createDirectIdentityPreparationStore();
  const rejected = store.authorize({
    callerSource: 'metadata-correlation',
    threadHash: identityHash('thread-T1'),
    turnHash: identityHash('turn-A'),
    operation: 'mcpServerToolCall',
    workspaceHash: identityHash('workspace-W1'),
    permissionMode: 'default',
    requiredExecutorAgentId: null,
    foregroundAdapter: 'foreground',
    expiresAt: DIRECT_IDENTITY_BASE + 60_000,
    now: DIRECT_IDENTITY_BASE,
  });
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.reasonCode, 'untrusted-caller', 'a caller with no demonstrated trusted path is never authorized');
  assert.equal(rejected.preparation, undefined, 'no preparation exists for an untrusted caller');
});

test('identity authorization bridge rejects wrong-thread and stale-turn requests', async () => {
  const { createDirectIdentityPreparationStore } = await import('../tools/direct-mcp-probe/identity.mjs');
  const store = createDirectIdentityPreparationStore();
  const authorized = store.authorize({
    callerSource: 'probe-driver-own-thread',
    threadHash: identityHash('thread-T1'),
    turnHash: identityHash('turn-A'),
    operation: 'mcpServerToolCall',
    workspaceHash: identityHash('workspace-W1'),
    permissionMode: 'default',
    requiredExecutorAgentId: null,
    foregroundAdapter: 'foreground',
    expiresAt: DIRECT_IDENTITY_BASE + 60_000,
    now: DIRECT_IDENTITY_BASE,
  });
  // Wrong thread: the request CLAIMS the T1/turn-A preparation while
  // declaring thread T2's identity — the claim is refused on the thread.
  const wrongThread = store.admit({
    request: identityAuthorizedRequest({ threadHash: identityHash('thread-T2') }),
    hostObservation: identityHostObservation(),
    preparationId: authorized.preparation.preparationId,
    now: DIRECT_IDENTITY_BASE + 1_000,
  });
  assert.equal(wrongThread.status, 'rejected');
  assert.equal(wrongThread.reasonCode, 'thread-mismatch');
  // Stale turn: a request still carrying turn A's identity while the host
  // observation has independently moved to turn B contradicts the host.
  const stale = store.admit({
    request: identityAuthorizedRequest({ turnHash: identityHash('turn-A') }),
    hostObservation: identityHostObservation({ turnHash: identityHash('turn-B'), state: 'active' }),
    preparationId: authorized.preparation.preparationId,
    now: DIRECT_IDENTITY_BASE + 1_000,
  });
  assert.equal(stale.status, 'rejected');
  assert.equal(stale.reasonCode, 'host-turn-mismatch', 'a stale turn identity never admits');
});

test('identity authorization bridge rejects a cancelled authorization and an expired one', async () => {
  const { createDirectIdentityPreparationStore } = await import('../tools/direct-mcp-probe/identity.mjs');
  const store = createDirectIdentityPreparationStore();
  const first = store.authorize({
    callerSource: 'probe-driver-own-thread',
    threadHash: identityHash('thread-T1'),
    turnHash: identityHash('turn-A'),
    operation: 'mcpServerToolCall',
    workspaceHash: identityHash('workspace-W1'),
    permissionMode: 'default',
    requiredExecutorAgentId: null,
    foregroundAdapter: 'foreground',
    expiresAt: DIRECT_IDENTITY_BASE + 60_000,
    now: DIRECT_IDENTITY_BASE,
  });
  store.cancel(first.preparation.preparationId, DIRECT_IDENTITY_BASE + 500);
  const cancelled = store.admit({
    request: identityAuthorizedRequest(),
    hostObservation: identityHostObservation(),
    preparationId: first.preparation.preparationId,
    now: DIRECT_IDENTITY_BASE + 1_000,
  });
  assert.equal(cancelled.status, 'rejected');
  assert.equal(cancelled.reasonCode, 'authorization-cancelled', 'a cancelled authorization never admits');
  const second = store.authorize({
    callerSource: 'probe-driver-own-thread',
    threadHash: identityHash('thread-T1'),
    turnHash: identityHash('turn-B'),
    operation: 'mcpServerToolCall',
    workspaceHash: identityHash('workspace-W1'),
    permissionMode: 'default',
    requiredExecutorAgentId: null,
    foregroundAdapter: 'foreground',
    expiresAt: DIRECT_IDENTITY_BASE + 60_000,
    now: DIRECT_IDENTITY_BASE,
  });
  assert.equal(second.status, 'authorized', 'the second authorization for turn B is issued normally');
  const expired = store.admit({
    request: identityAuthorizedRequest({ turnHash: identityHash('turn-B') }),
    hostObservation: identityHostObservation({ turnHash: identityHash('turn-B') }),
    preparationId: second.preparation.preparationId,
    now: DIRECT_IDENTITY_BASE + 61_000,
  });
  assert.equal(expired.status, 'rejected');
  assert.equal(expired.reasonCode, 'authorization-expired', 'an expired authorization never admits');
});

test('identity authorization bridge preserves workspace, permission, executor, and adapter checks', async () => {
  const { createDirectIdentityPreparationStore } = await import('../tools/direct-mcp-probe/identity.mjs');
  const store = createDirectIdentityPreparationStore();
  const authorized = store.authorize({
    callerSource: 'probe-driver-own-thread',
    threadHash: identityHash('thread-T1'),
    turnHash: identityHash('turn-A'),
    operation: 'mcpServerToolCall',
    workspaceHash: identityHash('workspace-W1'),
    permissionMode: 'default',
    requiredExecutorAgentId: identityHash('executor-E1'),
    foregroundAdapter: 'foreground',
    expiresAt: DIRECT_IDENTITY_BASE + 60_000,
    now: DIRECT_IDENTITY_BASE,
  });
  for (const [overrides, reasonCode] of [
    [{ workspaceHash: identityHash('workspace-W2') }, 'workspace-mismatch'],
    [{ permissionMode: 'acceptEdits' }, 'permission-mismatch'],
    [{ executorAgentId: identityHash('executor-E2') }, 'executor-mismatch'],
    [{ executorAgentId: identityHash('executor-E1'), foregroundAdapter: 'background' }, 'adapter-mismatch'],
  ]) {
    const verdict = store.admit({
      request: identityAuthorizedRequest(overrides),
      hostObservation: identityHostObservation(),
      preparationId: authorized.preparation.preparationId,
      now: DIRECT_IDENTITY_BASE + 1_000,
    });
    assert.equal(verdict.status, 'rejected', `${reasonCode} must reject`);
    assert.equal(verdict.reasonCode, reasonCode);
  }
});

test('identity authorization bridge requires the host observation to confirm the exact active turn', async () => {
  const { createDirectIdentityPreparationStore } = await import('../tools/direct-mcp-probe/identity.mjs');
  const store = createDirectIdentityPreparationStore();
  const authorized = store.authorize({
    callerSource: 'probe-driver-own-thread',
    threadHash: identityHash('thread-T1'),
    turnHash: identityHash('turn-A'),
    operation: 'mcpServerToolCall',
    workspaceHash: identityHash('workspace-W1'),
    permissionMode: 'default',
    requiredExecutorAgentId: null,
    foregroundAdapter: 'foreground',
    expiresAt: DIRECT_IDENTITY_BASE + 60_000,
    now: DIRECT_IDENTITY_BASE,
  });
  const notActive = store.admit({
    request: identityAuthorizedRequest(),
    hostObservation: identityHostObservation({ state: 'completed' }),
    preparationId: authorized.preparation.preparationId,
    now: DIRECT_IDENTITY_BASE + 1_000,
  });
  assert.equal(notActive.status, 'rejected');
  assert.equal(notActive.reasonCode, 'host-turn-not-active', 'a completed turn is never an active authorization');
  const unobserved = store.admit({
    request: identityAuthorizedRequest(),
    hostObservation: identityHostObservation({ preObserved: false, postObserved: false }),
    preparationId: authorized.preparation.preparationId,
    now: DIRECT_IDENTITY_BASE + 1_000,
  });
  assert.equal(unobserved.status, 'rejected');
  assert.equal(unobserved.reasonCode, 'host-turn-not-active', 'without ordered pre/post observations there is no confirmed active turn');
});

test('identity authorization bridge treats an echoed threadId or nonce as correlation only, never admission', async () => {
  const { createDirectIdentityPreparationStore } = await import('../tools/direct-mcp-probe/identity.mjs');
  const store = createDirectIdentityPreparationStore();
  // No preparation was ever authorized, yet the request echoes exactly the
  // identity values the host metadata carried (the correlation case). The
  // echo passes a CORRELATION check only — it must never admit.
  const echoed = store.admit({
    request: identityAuthorizedRequest(),
    hostObservation: identityHostObservation(),
    now: DIRECT_IDENTITY_BASE + 1_000,
  });
  assert.equal(echoed.status, 'rejected');
  assert.equal(echoed.reasonCode, 'preparation-receipt-missing', 'correlation without a demonstrated authorization and without a receipt is not admission');
});

test('identity authorization bridge race: a late A call can never consume a distinct B preparation', async () => {
  const { createDirectIdentityPreparationStore } = await import('../tools/direct-mcp-probe/identity.mjs');
  const store = createDirectIdentityPreparationStore();
  let authorizedB = null;
  for (const turn of ['turn-A', 'turn-B']) {
    const authorized = store.authorize({
      callerSource: 'probe-driver-own-thread',
      threadHash: identityHash('thread-T1'),
      turnHash: identityHash(turn),
      operation: 'mcpServerToolCall',
      workspaceHash: identityHash('workspace-W1'),
      permissionMode: 'default',
      requiredExecutorAgentId: null,
      foregroundAdapter: 'foreground',
      expiresAt: DIRECT_IDENTITY_BASE + 60_000,
      now: DIRECT_IDENTITY_BASE,
    });
    if (turn === 'turn-B') authorizedB = authorized;
  }
  // B admits first and consumes B's preparation.
  const bVerdict = store.admit({
    request: identityAuthorizedRequest({ turnHash: identityHash('turn-B') }),
    hostObservation: identityHostObservation({ turnHash: identityHash('turn-B') }),
    preparationId: authorizedB.preparation.preparationId,
    now: DIRECT_IDENTITY_BASE + 1_000,
  });
  assert.equal(bVerdict.status, 'admitted');
  const bId = bVerdict.preparationId;
  // The late A call arrives and claims B's preparation id: the claimed
  // preparation's authorized turn does not match A's request identity, so
  // the claim is refused and B's preparation stays consumed by B.
  const lateAClaimingB = store.admit({
    request: identityAuthorizedRequest({ turnHash: identityHash('turn-A') }),
    hostObservation: identityHostObservation({ turnHash: identityHash('turn-A') }),
    preparationId: bId,
    now: DIRECT_IDENTITY_BASE + 2_000,
  });
  assert.equal(lateAClaimingB.status, 'rejected');
  assert.equal(lateAClaimingB.reasonCode, 'turn-mismatch', 'a late A call cannot consume the distinct B preparation');
  const bPreparation = store.preparationById(bId);
  assert.equal(bPreparation.consumedAt, DIRECT_IDENTITY_BASE + 1_000, 'B preparation remains consumed exactly once, by B');
});

// ---------------------------------------------------------------------------
// Task 4 Step 3: the driver's identity seam. `directIdentityCase` reduces one
// identity sample (durable records + authenticated reduction + the driver's
// independently learned host identity hashes) through the ordered-turn
// classifier; `classifyDirectGateG2` derives the G2 gate. Fake transcripts
// only here — the real-host case runs separately and never upgrades a gate.
// ---------------------------------------------------------------------------

/** Appends a full identity-phase transcript for one joined call and returns the case inputs. */
async function buildDirectIdentityTranscript(run, {
  nonce = directRunNonce(),
  label = directLabel(),
  callNonce = directCallNonce(),
  withEntry = true,
  candidates = {},
  preTurnRecords = [],
  postTurnRecords = [],
  rpcOutcome = 'success-result',
} = {}) {
  await directDriverAppend(run, nonce, { kind: 'readiness-observed', state: 'discovered', source: 'host' }, 'identity');
  await directDriverAppend(run, nonce, { kind: 'request-sent', probeLabel: label, tool: 'capture_direct', state: 'sent' }, 'identity');
  // Pre-read host turn observations land BEFORE the durable entry.
  for (const turnRecord of preTurnRecords) {
    await directDriverAppend(run, nonce, turnRecord, 'identity');
  }
  const server = trackDirectProbeServer(run, createDirectProbeServer({ observer: { runDirectory: run, runNonce: nonce, phase: 'identity' }, ownerSecret: DIRECT_DRIVER_SECRET }));
  await server.probeDirectAppend({ kind: 'server-started', serverInstanceHash: directHash('fixture-instance') });
  if (withEntry) {
    await server.probeDirectAppend({ kind: 'handler-entered', probeLabel: label, callNonce, serverInstanceHash: directHash('fixture-instance') });
    await server.probeDirectAppend({
      kind: 'metadata-observed',
      callNonce,
      fields: [],
      fieldsTruncated: false,
      candidateHashes: { envelopeThreadId: null, innerSessionId: null, innerThreadId: null, innerTurnId: null, ...candidates },
      state: Object.values(candidates).some((value) => value !== null) ? 'complete' : 'malformed',
    });
  }
  // Post-read host turn observations land AFTER the durable entry.
  for (const turnRecord of postTurnRecords) {
    await directDriverAppend(run, nonce, turnRecord, 'identity');
  }
  if (withEntry) {
    await directDriverAppend(run, nonce, { kind: 'rpc-observed', probeLabel: label, callNonce, outcome: rpcOutcome }, 'identity');
  } else {
    await directDriverAppend(run, nonce, { kind: 'rpc-observed', probeLabel: label, outcome: rpcOutcome }, 'identity');
  }
  return { label, server, nonce };
}

test('identity case reduces an ordered active-turn sample to binding-observed with independent evidence references', async () => {
  const { directIdentityCase } = await loadDirectDriver();
  await withDirectProbeRun('zcode-direct-identity-', async (run) => {
    const nonce = directRunNonce();
    const threadHash = hashProbeValue(nonce, 'thread-T1');
    const turnHash = hashProbeValue(nonce, 'turn-A');
    const { label } = await buildDirectIdentityTranscript(run, {
      nonce,
      candidates: { envelopeThreadId: threadHash, innerTurnId: turnHash },
      preTurnRecords: [{ kind: 'turn-state-observed', threadHash, turnHash, state: 'active', source: 'host' }],
      postTurnRecords: [{ kind: 'turn-state-observed', threadHash, turnHash, state: 'active', source: 'host' }],
    });
    const { records, reduced } = await reduceDirectRun(run, nonce);
    const identity = directIdentityCase({
      records,
      reduced,
      probeLabel: label,
      expectedThreadHash: threadHash,
      expectedTurnHash: turnHash,
    });
    assert.equal(identity.classification, 'binding-observed');
    assert.equal(identity.entryJoined, true);
    assert.ok(identity.preTurn !== null && identity.preTurn.state === 'active');
    assert.ok(identity.postTurn !== null && identity.postTurn.state === 'active');
    const entryRecord = records.find((record) => record.kind === 'handler-entered');
    assert.ok(identity.evidenceRefs.includes(`handler-entered@${entryRecord.sequence}`));
    assert.ok(identity.evidenceRefs.some((ref) => ref.startsWith('turn-state-observed@')), 'the ordered turn observations are cited');
  });
});

test('identity case keeps a completed-thread sample at correlation only and an unjoined one not observed', async () => {
  const { directIdentityCase } = await loadDirectDriver();
  await withDirectProbeRun('zcode-direct-identity-', async (run) => {
    const nonce = directRunNonce();
    const threadHash = hashProbeValue(nonce, 'thread-T1');
    const turnHash = hashProbeValue(nonce, 'turn-A');
    // Completed turn A: both ordered observations show the turn completed.
    const { label } = await buildDirectIdentityTranscript(run, {
      nonce,
      candidates: { envelopeThreadId: threadHash, innerTurnId: turnHash },
      preTurnRecords: [{ kind: 'turn-state-observed', threadHash, turnHash, state: 'completed', source: 'host' }],
      postTurnRecords: [{ kind: 'turn-state-observed', threadHash, turnHash, state: 'completed', source: 'host' }],
    });
    const { records, reduced } = await reduceDirectRun(run, nonce);
    const identity = directIdentityCase({
      records,
      reduced,
      probeLabel: label,
      expectedThreadHash: threadHash,
      expectedTurnHash: turnHash,
    });
    assert.equal(identity.classification, 'correlation-only', 'a completed turn correlates but never authorizes');
    // An unjoined call on the same transcript shape stays not observed.
    const unjoinedLabel = directLabel();
    await directDriverAppend(run, nonce, { kind: 'request-sent', probeLabel: unjoinedLabel, tool: 'capture_direct', state: 'not-sent' }, 'identity');
    await directDriverAppend(run, nonce, { kind: 'rpc-observed', probeLabel: unjoinedLabel, outcome: 'not-observed' }, 'identity');
    const second = await reduceDirectRun(run, nonce);
    const unjoined = directIdentityCase({
      records: second.records,
      reduced: second.reduced,
      probeLabel: unjoinedLabel,
      expectedThreadHash: threadHash,
      expectedTurnHash: turnHash,
    });
    assert.equal(unjoined.classification, 'not-observed');
  });
});

test('identity case reports a candidate that contradicts the learned host identity as a mismatch', async () => {
  const { directIdentityCase } = await loadDirectDriver();
  await withDirectProbeRun('zcode-direct-identity-', async (run) => {
    const nonce = directRunNonce();
    const threadHash = hashProbeValue(nonce, 'thread-T1');
    const turnHash = hashProbeValue(nonce, 'turn-A');
    const { label } = await buildDirectIdentityTranscript(run, {
      nonce,
      candidates: { envelopeThreadId: hashProbeValue(nonce, 'thread-OTHER') },
      preTurnRecords: [{ kind: 'turn-state-observed', threadHash, turnHash, state: 'active', source: 'host' }],
      postTurnRecords: [{ kind: 'turn-state-observed', threadHash, turnHash, state: 'active', source: 'host' }],
    });
    const { records, reduced } = await reduceDirectRun(run, nonce);
    const identity = directIdentityCase({
      records,
      reduced,
      probeLabel: label,
      expectedThreadHash: threadHash,
      expectedTurnHash: turnHash,
    });
    assert.equal(identity.classification, 'mismatch-observed', 'a wrong-thread candidate is a contradiction, never a binding');
  });
});

test('identity G2 gate never upgrades without the trusted-caller chain, whatever the identity evidence shows', async () => {
  const { classifyDirectGateG2 } = await loadDirectDriver();
  // Binding observed AND the hold observed: still not proven, because the
  // authorization bridge was not demonstrated on the host — metadata
  // correlation is not authority.
  const strongest = classifyDirectGateG2({
    identity: 'binding-observed',
    activeTurnHold: { status: 'observed', reasonCode: null },
    authorization: { status: 'not-demonstrated', reasonCode: 'no-trusted-caller-path' },
  });
  assert.equal(strongest.status, 'not-proven');
  assert.equal(strongest.reasonCode, 'no-trusted-caller-path');
  // Hold unproven: the active-turn prerequisite is missing.
  const noHold = classifyDirectGateG2({
    identity: 'correlation-only',
    activeTurnHold: { status: 'not-proven', reasonCode: 'no-controlled-hold' },
    authorization: { status: 'not-demonstrated', reasonCode: 'no-trusted-caller-path' },
  });
  assert.equal(noHold.status, 'not-proven');
  assert.equal(noHold.reasonCode, 'no-trusted-caller-path', 'the authorization reason takes precedence while it is the deepest missing link');
  // Even a hypothetically demonstrated authorization without the hold stays unproven.
  const noHoldAuthorized = classifyDirectGateG2({
    identity: 'correlation-only',
    activeTurnHold: { status: 'not-proven', reasonCode: 'no-controlled-hold' },
    authorization: { status: 'demonstrated', reasonCode: null },
  });
  assert.equal(noHoldAuthorized.status, 'not-proven');
  assert.equal(noHoldAuthorized.reasonCode, 'active-turn-not-proven');
  // A mismatched or unobserved identity never proves the gate.
  for (const identity of ['mismatch-observed', 'not-observed', 'inconclusive']) {
    const verdict = classifyDirectGateG2({
      identity,
      activeTurnHold: { status: 'observed', reasonCode: null },
      authorization: { status: 'demonstrated', reasonCode: null },
    });
    assert.equal(verdict.status, 'not-proven');
    assert.equal(verdict.reasonCode, 'identity-not-authoritative');
  }
});

// ---------------------------------------------------------------------------
// Task 4 Step 3 (schedule): the bounded real-host identity schedule runs the
// same pin/auth/install/readiness machinery as reachability, then executes
// the identity cells against ONE owned app-server connection. The fake
// app-server scenarios below simulate the host side: an approval-request
// hold, an unholdable turn, and a foreign metadata candidate.
// ---------------------------------------------------------------------------

test('the identity schedule classifies the idle, approval-held, and completed cells against the fake app-server', async () => {
  const { runDirectIdentityProbe } = await loadDirectDriver();
  const fixture = await buildDirectDriverFixture('identity-hold');
  try {
    const run = join(fixture.parent, 'run');
    await fsp.mkdir(run, { mode: 0o700 });
    const counters = await runDirectIdentityProbe({
      codexPath: fixture.codexPath,
      sourceCodexHome: fixture.sourceHome,
      runDirectory: run,
      turnSetupBudgetMs: 15_000,
    });
    assert.equal(counters.mode, 'identity');
    const phase = counters.phases.identity;
    assert.equal(phase.readiness, 'discovered');
    assert.equal(phase.cells.idle, 'correlation-only', 'the idle-thread call is a correlation-only transport observation');
    assert.equal(phase.cells.activeHold, 'binding-observed', 'the approval-held turn binds through the ordered observations');
    assert.equal(phase.cells.completed, 'correlation-only', 'the completed-thread call stays correlation only');
    assert.deepEqual(phase.activeTurnHold, { status: 'observed', reasonCode: null });
    assert.equal(phase.handlerEntries, 4, 'one entry per cell: idle, twoThreads, activeHold, completed');
    assert.deepEqual(phase.isolation.threads, { status: 'observed', reasonCode: null });
    assert.equal(phase.gateG2.status, 'not-proven', 'G2 is never inferred from identity evidence');
    assert.equal(phase.gateG2.reasonCode, 'no-trusted-caller-path', 'no host-side trusted-caller chain was demonstrated');
    assert.equal(phase.cleanup, 'released');
    assert.equal(phase.uncommittedCount, 0);
  } finally {
    await rm(fixture.parent, { recursive: true, force: true });
  }
});

test('the identity schedule records an unholdable turn as not proven and keeps the completed transport observation', async () => {
  const { runDirectIdentityProbe } = await loadDirectDriver();
  const fixture = await buildDirectDriverFixture('identity-no-hold');
  try {
    const run = join(fixture.parent, 'run');
    await fsp.mkdir(run, { mode: 0o700 });
    const counters = await runDirectIdentityProbe({
      codexPath: fixture.codexPath,
      sourceCodexHome: fixture.sourceHome,
      runDirectory: run,
      turnSetupBudgetMs: 15_000,
    });
    const phase = counters.phases.identity;
    assert.equal(phase.cells.idle, 'correlation-only');
    assert.deepEqual(phase.activeTurnHold, { status: 'not-proven', reasonCode: 'no-controlled-hold' }, 'the hold attempt is recorded honestly');
    assert.equal(phase.cells.activeHold, 'not-proven', 'no active-turn sample is taken without a controlled hold');
    assert.equal(phase.cells.completed, 'correlation-only', 'the call after the confirmed completion stays a transport observation');
    assert.equal(phase.handlerEntries, 3, 'one entry per cell: idle, twoThreads, completed');
    assert.deepEqual(phase.isolation.threads, { status: 'observed', reasonCode: null });
    assert.equal(phase.gateG2.status, 'not-proven');
    assert.equal(phase.gateG2.reasonCode, 'no-trusted-caller-path');
    assert.equal(phase.cleanup, 'released');
  } finally {
    await rm(fixture.parent, { recursive: true, force: true });
  }
});

test('the identity schedule reports a metadata candidate contradicting the held turn as a mismatch', async () => {
  const { runDirectIdentityProbe } = await loadDirectDriver();
  const fixture = await buildDirectDriverFixture('identity-hold-mismatch');
  try {
    const run = join(fixture.parent, 'run');
    await fsp.mkdir(run, { mode: 0o700 });
    const counters = await runDirectIdentityProbe({
      codexPath: fixture.codexPath,
      sourceCodexHome: fixture.sourceHome,
      runDirectory: run,
      turnSetupBudgetMs: 15_000,
    });
    const phase = counters.phases.identity;
    assert.equal(phase.cells.activeHold, 'mismatch-observed', 'a foreign metadata candidate contradicts the independently learned identity');
    // The foreign candidate rides EVERY dispatch, so the two-thread cell's
    // own sample also genuinely contradicts: the cell classification is the
    // mismatch, and the isolation reason must name the contradiction — the
    // own thread WAS resolved (it observed one), so the generic
    // own-thread-unresolved code would be misleading.
    assert.equal(phase.cells.twoThreads, 'mismatch-observed');
    assert.deepEqual(phase.isolation.threads, { status: 'not-proven', reasonCode: 'isolation-mismatch' });
    assert.equal(phase.gateG2.status, 'not-proven');
    assert.equal(phase.gateG2.reasonCode, 'no-trusted-caller-path', 'even a binding could not upgrade G2 without the authorization chain');
    assert.equal(phase.cleanup, 'released');
  } finally {
    await rm(fixture.parent, { recursive: true, force: true });
  }
});

test('the identity driver CLI accepts --mode identity and prints only redacted counters', async () => {
  const fixture = await buildDirectDriverFixture('identity-hold');
  try {
    const run = join(fixture.parent, 'run');
    await fsp.mkdir(run, { mode: 0o700 });
    const child = spawn(process.execPath, [
      directDriverModulePath, '--mode', 'identity', '--codex', fixture.codexPath, '--run-directory', run,
      '--source-codex-home', fixture.sourceHome,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdoutChunks = [];
    const stderrChunks = [];
    child.stdout.on('data', (chunk) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk) => stderrChunks.push(chunk));
    const exit = await new Promise((resolveExit) => child.once('close', (code) => resolveExit(code)));
    assert.equal(exit, 0, `the CLI exits 0 (stderr: ${Buffer.concat(stderrChunks).toString('utf8').slice(0, 300)})`);
    const stdout = Buffer.concat(stdoutChunks).toString('utf8');
    const counters = JSON.parse(stdout);
    assert.equal(counters.mode, 'identity');
    assert.equal(counters.phases.identity.gateG2.status, 'not-proven');
    assert.equal(stdout.includes(run), false, 'the run directory path never reaches stdout');
    assert.equal(stdout.includes('fixture-thread'), false, 'no host-issued thread identifier reaches stdout');
    assert.equal(/[0-9a-f]{32}/.test(stdout.replace(/"codexVersion":"[^"]*"/g, '')), false, 'no probe-label-shaped raw hex reaches stdout');
  } finally {
    await rm(fixture.parent, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Task 4 self-review fixes. Each test pins a reviewed gap: duplicate live
// authorizations, the G2 proven control, session-candidate asymmetry, and
// observed-versus-authored turn-state evidence in the identity schedule.
// ---------------------------------------------------------------------------

test('identity authorization bridge rejects a second live authorization for the identical thread, turn, and operation', async () => {
  const { createDirectIdentityPreparationStore } = await import('../tools/direct-mcp-probe/identity.mjs');
  const store = createDirectIdentityPreparationStore();
  const authorize = (turnHash) => store.authorize({
    callerSource: 'probe-driver-own-thread',
    threadHash: identityHash('thread-T1'),
    turnHash,
    operation: 'mcpServerToolCall',
    workspaceHash: identityHash('workspace-W1'),
    permissionMode: 'default',
    requiredExecutorAgentId: null,
    foregroundAdapter: 'foreground',
    expiresAt: DIRECT_IDENTITY_BASE + 60_000,
    now: DIRECT_IDENTITY_BASE,
  });
  const first = authorize(identityHash('turn-A'));
  assert.equal(first.status, 'authorized');
  // Same identity, second live authorization: refused — the lookup must never
  // depend on insertion order to tell two identical authorizations apart.
  const duplicate = authorize(identityHash('turn-A'));
  assert.equal(duplicate.status, 'rejected');
  assert.equal(duplicate.reasonCode, 'duplicate-authorization');
  // After the first is consumed, re-authorization for the same identity is
  // allowed again: no live duplicate exists.
  const admitted = store.admit({
    request: identityAuthorizedRequest(),
    hostObservation: identityHostObservation(),
    preparationId: first.preparation.preparationId,
    now: DIRECT_IDENTITY_BASE + 1_000,
  });
  assert.equal(admitted.status, 'admitted');
  const reauthorized = authorize(identityHash('turn-A'));
  assert.equal(reauthorized.status, 'authorized', 're-authorization after consume is not a live duplicate');
});

test('identity authorization bridge resolves admission strictly by receipt, never by thread-turn identity', async () => {
  const { createDirectIdentityPreparationStore } = await import('../tools/direct-mcp-probe/identity.mjs');
  const store = createDirectIdentityPreparationStore();
  // One preparation consumed, then a re-authorization for the SAME identity:
  // only the RECEIPT decides which preparation an admit touches. The spent
  // original's receipt refuses as consumed; the newer receipt admits.
  const first = store.authorize({
    callerSource: 'probe-driver-own-thread',
    threadHash: identityHash('thread-T1'),
    turnHash: identityHash('turn-A'),
    operation: 'mcpServerToolCall',
    workspaceHash: identityHash('workspace-W1'),
    permissionMode: 'default',
    requiredExecutorAgentId: null,
    foregroundAdapter: 'foreground',
    expiresAt: DIRECT_IDENTITY_BASE + 60_000,
    now: DIRECT_IDENTITY_BASE,
  });
  const admitted = store.admit({
    request: identityAuthorizedRequest(),
    hostObservation: identityHostObservation(),
    preparationId: first.preparation.preparationId,
    now: DIRECT_IDENTITY_BASE + 1_000,
  });
  assert.equal(admitted.status, 'admitted');
  const second = store.authorize({
    callerSource: 'probe-driver-own-thread',
    threadHash: identityHash('thread-T1'),
    turnHash: identityHash('turn-A'),
    operation: 'mcpServerToolCall',
    workspaceHash: identityHash('workspace-W1'),
    permissionMode: 'default',
    requiredExecutorAgentId: null,
    foregroundAdapter: 'foreground',
    expiresAt: DIRECT_IDENTITY_BASE + 60_000,
    now: DIRECT_IDENTITY_BASE + 2_000,
  });
  const readmitted = store.admit({
    request: identityAuthorizedRequest(),
    hostObservation: identityHostObservation(),
    preparationId: second.preparation.preparationId,
    now: DIRECT_IDENTITY_BASE + 3_000,
  });
  assert.equal(readmitted.status, 'admitted', 'the re-authorization admits through its own receipt (once-only per preparation)');
  const spentReceipt = store.admit({
    request: identityAuthorizedRequest(),
    hostObservation: identityHostObservation(),
    preparationId: first.preparation.preparationId,
    now: DIRECT_IDENTITY_BASE + 4_000,
  });
  assert.equal(spentReceipt.status, 'rejected');
  assert.equal(spentReceipt.reasonCode, 'preparation-consumed', "the spent original's receipt never resolves to the live re-authorization");
});

test('identity authorization bridge refuses a replayed unclaimed request after same-turn reauthorization instead of consuming the newer preparation', async () => {
  const { createDirectIdentityPreparationStore } = await import('../tools/direct-mcp-probe/identity.mjs');
  const store = createDirectIdentityPreparationStore();
  const authorize = () => store.authorize({
    callerSource: 'probe-driver-own-thread',
    threadHash: identityHash('thread-T1'),
    turnHash: identityHash('turn-A'),
    operation: 'mcpServerToolCall',
    workspaceHash: identityHash('workspace-W1'),
    permissionMode: 'default',
    requiredExecutorAgentId: null,
    foregroundAdapter: 'foreground',
    expiresAt: DIRECT_IDENTITY_BASE + 60_000,
    now: DIRECT_IDENTITY_BASE,
  });
  const first = authorize();
  assert.equal(first.status, 'authorized');
  const firstAdmit = store.admit({
    request: identityAuthorizedRequest(),
    hostObservation: identityHostObservation(),
    preparationId: first.preparation.preparationId,
    now: DIRECT_IDENTITY_BASE + 1_000,
  });
  assert.equal(firstAdmit.status, 'admitted');
  // Same-turn reauthorization is allowed (the first preparation is spent).
  const second = authorize();
  assert.equal(second.status, 'authorized');
  // P1's request is REPLAYED without its receipt: admission must refuse —
  // thread/turn identity alone must never select the newer preparation.
  const replay = store.admit({
    request: identityAuthorizedRequest(),
    hostObservation: identityHostObservation(),
    now: DIRECT_IDENTITY_BASE + 2_000,
  });
  assert.equal(replay.status, 'rejected', 'an unclaimed replay must never admit against the newer preparation');
  assert.equal(replay.reasonCode, 'preparation-receipt-missing');
  assert.equal(store.preparationById(second.preparation.preparationId).consumedAt, null, 'the replay must not consume P2');
  // The newer preparation remains usable through its OWN receipt.
  const secondAdmit = store.admit({
    request: identityAuthorizedRequest(),
    hostObservation: identityHostObservation(),
    preparationId: second.preparation.preparationId,
    now: DIRECT_IDENTITY_BASE + 3_000,
  });
  assert.equal(secondAdmit.status, 'admitted');
  // And P1's receipt still identifies the CONSUMED original.
  const replayedReceipt = store.admit({
    request: identityAuthorizedRequest(),
    hostObservation: identityHostObservation(),
    preparationId: first.preparation.preparationId,
    now: DIRECT_IDENTITY_BASE + 4_000,
  });
  assert.equal(replayedReceipt.status, 'rejected');
  assert.equal(replayedReceipt.reasonCode, 'preparation-consumed', "P1's receipt resolves to the consumed original");
});

test('identity G2 gate has a reachable proven branch demonstrated by the positive control', async () => {
  const { classifyDirectGateG2 } = await loadDirectDriver();
  // Positive control: ALL three demonstrations present — an ordered live-turn
  // identity binding, a controlled active-turn hold observed on the host, and
  // a demonstrated trusted-caller authorization chain. Only this combination
  // may reach proven; this test exists to kill any mutant that makes the
  // proven branch unreachable.
  const verdict = classifyDirectGateG2({
    identity: 'binding-observed',
    activeTurnHold: { status: 'observed', reasonCode: null },
    authorization: { status: 'demonstrated', reasonCode: null },
  });
  assert.equal(verdict.status, 'proven');
  assert.equal(verdict.reasonCode, 'identity-binding-observed');
});

test('identity ordering treats the session candidate as recorded but never comparable', async () => {
  const { classifyDirectIdentitySample } = await import('../tools/direct-mcp-probe/identity.mjs');
  // The schedule learns only host thread.id/turn.id — there is NO host-side
  // session identity to learn, so innerSessionId can never be compared. Pin
  // the asymmetry both ways:
  // (1) SESSION-ONLY NEGATIVE: an innerSessionId alone is recorded presence
  // but is NOT independently comparable, so it can never establish the
  // metadata-to-turn binding — even with the ordered active observations,
  // the sample downgrades to correlation-only. Binding requires a matching,
  // comparable thread AND turn candidate.
  const sessionOnly = {
    entryJoined: true,
    entrySequence: 10,
    metadataCandidates: identityCandidates({ innerSessionId: identityHash('session-1') }),
    expectedThreadHash: identityHash('thread-T1'),
    expectedTurnHash: identityHash('turn-A'),
    preTurn: identityTurn(5, 'active', 'thread-T1', 'turn-A'),
    postTurn: identityTurn(15, 'active', 'thread-T1', 'turn-A'),
  };
  assert.equal(classifyDirectIdentitySample(sessionOnly), 'correlation-only');
  // (2) a DIFFERENT session value in the same shape is equally
  // non-authoritative: the classification is unchanged, because nothing the
  // schedule learned can agree or disagree with a session id.
  const otherSession = { ...sessionOnly, metadataCandidates: identityCandidates({ innerSessionId: identityHash('session-2') }) };
  assert.equal(classifyDirectIdentitySample(otherSession), 'correlation-only');
  // (3) on an idle thread the session-only sample stays correlation-only:
  // recorded, non-comparable, and never authority.
  const idle = {
    entryJoined: true,
    entrySequence: 4,
    metadataCandidates: identityCandidates({ innerSessionId: identityHash('session-1') }),
    expectedThreadHash: identityHash('thread-T1'),
    expectedTurnHash: null,
    preTurn: null,
    postTurn: null,
  };
  assert.equal(classifyDirectIdentitySample(idle), 'correlation-only');
});

test('the identity schedule runs a live two-thread isolation cell independent of the active-turn hold', async () => {
  const { runDirectIdentityProbe } = await loadDirectDriver();
  const fixture = await buildDirectDriverFixture('identity-hold');
  try {
    const run = join(fixture.parent, 'run');
    await fsp.mkdir(run, { mode: 0o700 });
    const counters = await runDirectIdentityProbe({
      codexPath: fixture.codexPath,
      sourceCodexHome: fixture.sourceHome,
      runDirectory: run,
      turnSetupBudgetMs: 15_000,
    });
    const phase = counters.phases.identity;
    // The two-thread state is a transport-level isolation observation: a
    // second independently created thread on the SAME owned connection, one
    // direct call on each, and NO hold prerequisite.
    assert.equal(phase.cells.twoThreads, 'correlation-only', 'the second thread call is a correlation-only transport observation');
    assert.deepEqual(phase.isolation.threads, { status: 'observed', reasonCode: null }, 'each thread candidates only its own identity: isolation observed');
    // Child isolation stays not-proven: the host exposes no independently
    // learnable Child identity, and a caller-supplied Child id is never copied.
    assert.deepEqual(phase.isolation.children, { status: 'not-proven', reasonCode: 'child-identity-unestablishable' });
    assert.equal(phase.cells.idle, 'correlation-only');
    assert.equal(phase.cells.activeHold, 'binding-observed', 'the hold cell is unaffected by the two-thread cell');
    assert.equal(phase.cells.completed, 'correlation-only');
    assert.equal(phase.handlerEntries, 4, 'one entry per cell: idle, twoThreads, activeHold, completed');
  } finally {
    await rm(fixture.parent, { recursive: true, force: true });
  }
});

test('the identity schedule derives the active cell post-read from host evidence instead of authoring it', async () => {
  const { runDirectIdentityProbe } = await loadDirectDriver();
  const fixture = await buildDirectDriverFixture('identity-hold-ends');
  try {
    const run = join(fixture.parent, 'run');
    await fsp.mkdir(run, { mode: 0o700 });
    const counters = await runDirectIdentityProbe({
      codexPath: fixture.codexPath,
      sourceCodexHome: fixture.sourceHome,
      runDirectory: run,
      turnSetupBudgetMs: 15_000,
    });
    const phase = counters.phases.identity;
    // The host emitted the turn completion DURING the call window. The
    // post-read must carry that OBSERVED terminal state — the sample is then
    // inconclusive (active at the pre-read, interrupted at the post-read),
    // never a binding authored from an assumed still-active turn.
    assert.equal(phase.activeTurnHold.status, 'observed', 'the hold itself was established');
    assert.equal(phase.cells.activeHold, 'inconclusive', 'an observed mid-call completion makes the sample inconclusive');
    assert.equal(phase.cells.completed, 'correlation-only');
  } finally {
    await rm(fixture.parent, { recursive: true, force: true });
  }
});

test('the identity schedule never records a terminal turn state it did not observe', async () => {
  const { runDirectIdentityProbe } = await loadDirectDriver();
  const fixture = await buildDirectDriverFixture('identity-hold-silent');
  try {
    const run = join(fixture.parent, 'run');
    await fsp.mkdir(run, { mode: 0o700 });
    const counters = await runDirectIdentityProbe({
      codexPath: fixture.codexPath,
      sourceCodexHome: fixture.sourceHome,
      runDirectory: run,
      turnSetupBudgetMs: 15_000,
    });
    const phase = counters.phases.identity;
    assert.equal(phase.cells.completed, 'correlation-only', 'the completed-thread call stays a transport observation');
    // The durable evidence must not claim the presumed 'interrupted' terminal:
    // the settle window observed nothing, so every turn-state record after the
    // held call carries state 'unknown' (no hashes), never an authored state.
    const eventsText = await readFile(join(run, 'events.jsonl'), 'utf8');
    const turnStates = eventsText.split('\n').filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line))
      .filter((record) => record.kind === 'turn-state-observed')
      .map((record) => record.state);
    assert.equal(turnStates.includes('interrupted'), false, 'an unobserved terminal state must never be authored into the evidence');
    assert.equal(turnStates.includes('active'), true, 'the held-call window is still evidenced as active while the approval was outstanding');
  } finally {
    await rm(fixture.parent, { recursive: true, force: true });
  }
});

test('identity authorization bridge distinguishes a well-formed unknown receipt from a missing one', async () => {
  const { createDirectIdentityPreparationStore } = await import('../tools/direct-mcp-probe/identity.mjs');
  const store = createDirectIdentityPreparationStore();
  // A receipt of the right SHAPE that identifies no preparation: admission
  // and cancellation both report preparation-missing — distinct from
  // preparation-receipt-missing (no receipt presented at all) and from
  // preparation-consumed (a receipt resolving to a spent original).
  const unknownReceipt = createHash('sha256').update('unknown-receipt').digest('hex').slice(0, 32);
  const verdict = store.admit({
    request: identityAuthorizedRequest(),
    hostObservation: identityHostObservation(),
    preparationId: unknownReceipt,
    now: DIRECT_IDENTITY_BASE + 1_000,
  });
  assert.equal(verdict.status, 'rejected');
  assert.equal(verdict.reasonCode, 'preparation-missing');
  const cancelled = store.cancel(unknownReceipt, DIRECT_IDENTITY_BASE + 1_000);
  assert.equal(cancelled.status, 'rejected');
  assert.equal(cancelled.reasonCode, 'preparation-missing', 'cancel reports the same unknown-receipt code as admit');
});

// ---------------------------------------------------------------------------
// Task 5: lifecycle settlement — the synthetic worker, the command-specific
// expected-outcome table, the local case state machine, and the G3 gate.
// Everything here is LOCAL: in-process disposable servers and authenticated
// fixture transcripts. The real-host cases run separately and never upgrade
// G3 from RPC or turn status alone.
// ---------------------------------------------------------------------------

/** Issues one hold_direct call with the optional synthetic worker duration. */
async function callHoldDirect(client, probeLabel, holdMs) {
  const args = { probeLabel };
  if (holdMs !== undefined) args.holdMs = holdMs;
  return client.request({ method: 'tools/call', params: { name: 'hold_direct', arguments: args } }, CallToolResultSchema);
}

test('direct lifecycle synthetic worker completes normally and settles both terminals exactly once', async () => {
  await withDirectProbeRun('zcode-direct-lifecycle-', async (run) => {
    const nonce = directRunNonce();
    const { client, server } = await connectDirectProbeClient(run, nonce, 'lifecycle');
    const label = directLabel();
    const held = callHoldDirect(client, label, 300);
    const started = await waitUntilDirectEventKind(run, nonce, 'hold-started');
    // The entry, the hold, and the synthetic worker claim are durable BEFORE
    // the call answers: the worker claim is the hold-started record's
    // workerHash, written while the RPC is still outstanding.
    let records = await readDirectProbeEvents({ runDirectory: run, runNonce: nonce });
    assert.deepEqual(records.map((record) => record.kind), ['handler-entered', 'hold-started']);
    assert.equal(records[1].workerHash, started.workerHash);
    const result = await held;
    assert.equal(result.isError ?? false, false);
    await waitUntilDirectEventKind(run, nonce, 'worker-settled');
    records = await readDirectProbeEvents({ runDirectory: run, runNonce: nonce });
    assert.deepEqual(records.map((record) => record.kind), ['handler-entered', 'hold-started', 'handler-settled', 'worker-settled']);
    assert.equal(records[2].outcome, 'completed');
    assert.equal(records[3].outcome, 'completed', 'the synthetic worker completed normally');
    assert.equal(records[3].workerHash, started.workerHash, 'the settled worker is exactly the claimed synthetic worker');
    // Idempotent settlement: re-running the reconciliation must not duplicate
    // any terminal record.
    server.probeDirectDisconnect.settlePendingHoldsOnDisconnect();
    await new Promise((resolve) => setTimeout(resolve, 150));
    const after = await readDirectProbeEvents({ runDirectory: run, runNonce: nonce });
    assert.equal(after.filter((record) => record.kind === 'handler-settled').length, 1, 'handler settlement stays exactly once');
    assert.equal(after.filter((record) => record.kind === 'worker-settled').length, 1, 'worker settlement stays exactly once');
    await client.close();
  });
});

test('direct lifecycle completion-versus-cancellation race durably decides exactly one outcome', async () => {
  await withDirectProbeRun('zcode-direct-lifecycle-', async (run) => {
    const nonce = directRunNonce();
    // Boundary A: the cancellation (safety deadline) fires before completion.
    const canceller = createDirectProbeServer({ observer: { runDirectory: run, runNonce: nonce, phase: 'lifecycle' }, ownerSecret: DIRECT_DRIVER_SECRET, holdSafetyDeadlineMs: 200 });
    const clientA = new Client({ name: 'direct-lifecycle-race-a', version: '0.0.0' });
    const [transportA, serverTransportA] = InMemoryTransport.createLinkedPair();
    await Promise.all([canceller.connect(serverTransportA), clientA.connect(transportA)]);
    const labelA = directLabel();
    const raceA = callHoldDirect(clientA, labelA, 500);
    await waitUntilDirectEventKind(run, nonce, 'hold-started');
    const resultA = await raceA;
    assert.equal(resultA.isError ?? false, false);
    await waitUntilDirectEventKind(run, nonce, 'worker-settled');
    let records = await readDirectProbeEvents({ runDirectory: run, runNonce: nonce });
    assert.equal(records[2].outcome, 'safety-deadline', 'the injected cancellation decided before completion');
    assert.equal(records[3].outcome, 'safety-deadline');
    await clientA.close();
    // Boundary B: completion fires before the cancellation.
    const completer = createDirectProbeServer({ observer: { runDirectory: run, runNonce: nonce, phase: 'lifecycle' }, ownerSecret: DIRECT_DRIVER_SECRET, holdSafetyDeadlineMs: 5_000 });
    const clientB = new Client({ name: 'direct-lifecycle-race-b', version: '0.0.0' });
    const [transportB, serverTransportB] = InMemoryTransport.createLinkedPair();
    await Promise.all([completer.connect(serverTransportB), clientB.connect(transportB)]);
    const labelB = directLabel();
    const raceB = callHoldDirect(clientB, labelB, 150);
    await raceB;
    await waitUntilDirectEventKind(run, nonce, 'worker-settled');
    records = await readDirectProbeEvents({ runDirectory: run, runNonce: nonce });
    // Each race settles ITS OWN hold exactly once: boundary A durably decided
    // by the cancellation, boundary B by completion.
    const settlementA = records.filter((record) => record.kind === 'worker-settled' && record.outcome === 'safety-deadline');
    assert.equal(settlementA.length, 1, 'the cancelled race settled exactly once');
    const settlementB = records.filter((record) => record.kind === 'worker-settled' && record.outcome === 'completed');
    assert.equal(settlementB.length, 1, 'the completed race settled exactly once');
    assert.equal(records.filter((record) => record.kind === 'handler-settled' && record.outcome === 'completed').length, 1);
    await clientB.close();
  });
});

test('direct lifecycle a cancellation that wins never lets completion land afterwards', async () => {
  await withDirectProbeRun('zcode-direct-lifecycle-', async (run) => {
    const nonce = directRunNonce();
    const { client, server } = await connectDirectProbeClient(run, nonce, 'lifecycle');
    const label = directLabel();
    // A long synthetic completion racing a client close: whichever decision
    // lands first wins once, and the durable log must never contain a
    // completion after the cancellation.
    const held = callHoldDirect(client, label, 400).catch(() => null);
    await waitUntilDirectEventKind(run, nonce, 'hold-started');
    await client.close();
    const result = await Promise.race([held, new Promise((resolve) => setTimeout(() => resolve(null), 2_000))]);
    if (result !== null) assert.equal(result.isError ?? false, false);
    await new Promise((resolve) => setTimeout(resolve, 300));
    server.probeDirectDisconnect.settlePendingHoldsOnDisconnect();
    await waitUntilDirectEventKind(run, nonce, 'handler-settled');
    const records = await readDirectProbeEvents({ runDirectory: run, runNonce: nonce });
    const outcomes = records.filter((record) => record.kind === 'handler-settled').map((record) => record.outcome);
    assert.equal(outcomes.length, 1, 'exactly one handler settlement');
    assert.equal(['cancelled', 'connection-closed'].includes(outcomes[0]), true, 'the cancellation decided the hold');
    assert.equal(records.some((record) => record.kind === 'worker-settled' && record.outcome === 'completed'), false, 'completion never lands after the cancellation');
  });
});

test('direct lifecycle safety deadline settles a still-running hold (mechanism-only injected ceiling)', async () => {
  await withDirectProbeRun('zcode-direct-lifecycle-', async (run) => {
    const nonce = directRunNonce();
    // MECHANISM-ONLY: the short injected ceiling exercises the same forced
    // settlement MECHANISM as the production 100-hour safety ceiling; it is
    // never evidence that the tested host supports a 100-hour tool call.
    const server = createDirectProbeServer({ observer: { runDirectory: run, runNonce: nonce, phase: 'lifecycle' }, holdSafetyDeadlineMs: 250 });
    const client = new Client({ name: 'direct-lifecycle-ceiling', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const held = callHoldDirect(client, directLabel());
    await waitUntilDirectEventKind(run, nonce, 'hold-started');
    const result = await held;
    assert.equal(result.isError ?? false, false);
    await waitUntilDirectEventKind(run, nonce, 'worker-settled');
    const records = await readDirectProbeEvents({ runDirectory: run, runNonce: nonce });
    assert.deepEqual(records.map((record) => record.kind), ['handler-entered', 'hold-started', 'handler-settled', 'worker-settled']);
    assert.equal(records[2].outcome, 'safety-deadline');
    assert.equal(records[3].outcome, 'safety-deadline', 'the still-running worker was force-settled by the injected ceiling');
    assert.equal(records[3].workerHash, records[1].workerHash);
    await client.close();
  });
});

test('direct lifecycle sentinel call is unaffected by an unrelated held call', async () => {
  await withDirectProbeRun('zcode-direct-lifecycle-', async (run) => {
    const nonce = directRunNonce();
    const { client, server } = await connectDirectProbeClient(run, nonce, 'lifecycle');
    const heldLabel = directLabel();
    const sentinelLabel = directLabel();
    const held = callHoldDirect(client, heldLabel);
    await waitUntilDirectEventKind(run, nonce, 'hold-started');
    // The unrelated sentinel completes normally while the hold is pending.
    const sentinel = await callCaptureDirect(client, sentinelLabel);
    assert.equal(sentinel.isError ?? false, false);
    // The held call's settlement must not touch the sentinel call.
    server.probeDirectDisconnect.settlePendingHoldsOnDisconnect();
    await held;
    await waitUntilDirectEventKind(run, nonce, 'worker-settled');
    const records = await readDirectProbeEvents({ runDirectory: run, runNonce: nonce });
    const sentinelEntry = records.find((record) => record.kind === 'handler-entered' && record.probeLabel === sentinelLabel);
    const holdNonce = records.find((record) => record.kind === 'handler-entered' && record.probeLabel === heldLabel).callNonce;
    assert.ok(sentinelEntry, 'the sentinel call entered the handler');
    const sentinelRecords = records.filter((record) => record.callNonce === sentinelEntry.callNonce || record.probeLabel === sentinelLabel);
    assert.equal(sentinelRecords.some((record) => record.kind === 'handler-settled' || record.kind === 'worker-settled'), false, 'an unrelated hold settlement never settles the sentinel');
    assert.equal(records.filter((record) => record.kind === 'worker-settled').length, 1, 'exactly one synthetic worker settlement exists');
    assert.equal(records.find((record) => record.kind === 'worker-settled').callNonce, holdNonce);
    await client.close();
  });
});

test('direct lifecycle host loss leaves the held worker without durable settlement', { skip: !posix }, async () => {
  await withDirectProbeRun('zcode-direct-stdio-', async (run) => {
    const nonce = directRunNonce();
    const label = directLabel();
    const ownerSecret = directRunNonce();
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [directServerModulePath],
      env: {
        ...process.env,
        ZCODE_DIRECT_MCP_PROBE_RUN: run,
        ZCODE_DIRECT_MCP_PROBE_NONCE: nonce,
        ZCODE_DIRECT_MCP_PROBE_PHASE: 'lifecycle',
        DIRECT_PROBE_OWNER_SECRET: ownerSecret,
      },
    });
    const client = new Client({ name: 'direct-lifecycle-host-loss', version: '0.0.0' });
    await client.connect(transport);
    const held = client.request({ method: 'tools/call', params: { name: 'hold_direct', arguments: { probeLabel: label } } }, CallToolResultSchema).catch(() => null);
    await waitUntilDirectEventKind(run, nonce, 'hold-started');
    // ABRUPT HOST LOSS: the owning process of the held call is killed without
    // any settlement path. No durable terminal may appear, whatever grace
    // passes: a killed writer cannot settle, and the honest record is a
    // hold with no terminals.
    process.kill(transport.pid, 'SIGKILL');
    await held;
    await new Promise((resolve) => setTimeout(resolve, DIRECT_SERVER_EXIT_GRACE_TEST_MS));
    const records = await readDirectProbeEvents({ runDirectory: run, runNonce: nonce });
    assert.equal(records.some((record) => record.kind === 'hold-started'), true, 'the hold and its worker claim are durable');
    assert.equal(records.some((record) => record.kind === 'handler-settled'), false, 'no handler settlement survives host loss');
    assert.equal(records.some((record) => record.kind === 'worker-settled'), false, 'no worker settlement survives host loss');
  });
});

// Command-specific expected outcomes and the local lifecycle state machine.

async function buildDirectLifecycleTranscript(run, {
  nonce = directRunNonce(),
  label = directLabel(),
  callNonce = directCallNonce(),
  workerHash = directHash('fixture-worker'),
  requestState = 'sent',
  withEntry = true,
  withHold = true,
  triggerSent = null,
  triggerObserved = null,
  handlerOutcome = null,
  workerOutcome = null,
  rpcOutcome = null,
  sentinel = null,
  sentinelSettledBeforeTarget = false,
  sentinelJoinedAfterTargetSettlement = false,
  sentinelSpanningBoundary = false,
  sentinelJoinBeforeTrigger = false,
  sentinelJoinAfterTrigger = false,
  triggerAfterSettlement = false,
  sentinelDriverRelease = false,
  sentinelEarlyReleaseMarker = false,
} = {}) {
  await directDriverAppend(run, nonce, { kind: 'readiness-observed', state: 'discovered', source: 'host' }, 'lifecycle');
  await directDriverAppend(run, nonce, { kind: 'request-sent', probeLabel: label, tool: withHold ? 'hold_direct' : 'capture_direct', state: requestState }, 'lifecycle');
  const server = trackDirectProbeServer(run, createDirectProbeServer({ observer: { runDirectory: run, runNonce: nonce, phase: 'lifecycle' }, ownerSecret: DIRECT_DRIVER_SECRET }));
  await server.probeDirectAppend({ kind: 'server-started', serverInstanceHash: directHash('fixture-instance') });
  if (withEntry) {
    await server.probeDirectAppend({ kind: 'handler-entered', probeLabel: label, callNonce, serverInstanceHash: directHash('fixture-instance') });
    if (withHold) await server.probeDirectAppend({ kind: 'hold-started', callNonce, workerHash });
    // RED-shape fixture: the sentinel's own completed settlement can be
    // written BEFORE the target's boundary settlement, encoding a sentinel
    // that was already finished when the cancellation acted.
    const sentinelWorkerHash = sentinel !== null ? directHash(`fixture-sentinel-worker:${sentinel.label}`) : null;
    const sentinelJoin = async () => {
      await directDriverAppend(run, nonce, { kind: 'request-sent', probeLabel: sentinel.label, tool: sentinel.tool ?? 'hold_direct', state: sentinel.requestState ?? 'sent' }, 'lifecycle');
      await server.probeDirectAppend({ kind: 'handler-entered', probeLabel: sentinel.label, callNonce: sentinel.callNonce, serverInstanceHash: directHash('fixture-instance') });
      await server.probeDirectAppend({ kind: 'hold-started', callNonce: sentinel.callNonce, workerHash: sentinelWorkerHash });
    };
    const sentinelSettle = async () => {
      if (sentinel.workerOutcome !== null && sentinel.workerOutcome !== undefined) {
        if (sentinel.workerOnly) {
          // Partial sentinel write: the worker terminal alone.
          await server.probeDirectAppend({ kind: 'worker-settled', callNonce: sentinel.callNonce, workerHash: sentinelWorkerHash, outcome: sentinel.workerOutcome });
          return;
        }
        const handlerOutcomeForSentinel = sentinel.handlerOutcome !== null && sentinel.handlerOutcome !== undefined
          ? sentinel.handlerOutcome
          : sentinel.workerOutcome;
        await server.probeDirectAppend({ kind: 'handler-settled', callNonce: sentinel.callNonce, outcome: handlerOutcomeForSentinel });
        await server.probeDirectAppend({ kind: 'worker-settled', callNonce: sentinel.callNonce, workerHash: sentinelWorkerHash, outcome: sentinel.workerOutcome });
      }
    };
    // JoinBeforeTrigger: the sentinel is durably held BEFORE the driver even
    // declares the trigger — the real driver schedule.
    if (sentinel !== null && sentinelJoinBeforeTrigger) await sentinelJoin();
    // Settled-before-target: the sentinel joins AND settles before the
    // target's boundary settlement (the expired-at-boundary RED shape).
    if (sentinel !== null && sentinelSettledBeforeTarget) {
      await sentinelJoin();
      await sentinelSettle();
    }
    // Spanning: the sentinel JOINS before the driver's trigger declaration
    // (the real driver schedule: establish the sentinel, then declare the
    // trigger) and settles after the target's boundary settlement — the
    // genuine boundary-spanning shape.
    if (sentinel !== null && sentinelSpanningBoundary) await sentinelJoin();
    const appendTriggerRecords = async () => {
      if (triggerSent !== null) await directDriverAppend(run, nonce, { kind: 'trigger-sent', callNonce, outcome: triggerSent }, 'lifecycle');
      if (triggerObserved !== null) await directDriverAppend(run, nonce, { kind: 'trigger-observed', callNonce, outcome: triggerObserved, source: 'host' }, 'lifecycle');
    };
    if (!triggerAfterSettlement) await appendTriggerRecords();
    if (sentinel !== null && sentinelJoinAfterTrigger) await sentinelJoin();
    // EarlyReleaseMarker: the driver's release markers commit BEFORE the
    // target's boundary settlement (the round-13 D4 RED shape — the marker
    // does not follow the durably observed boundary).
    if (sentinel !== null && sentinelEarlyReleaseMarker) {
      await directDriverAppend(run, nonce, { kind: 'trigger-sent', callNonce: sentinel.callNonce, outcome: 'turn-interrupt' }, 'lifecycle');
      await directDriverAppend(run, nonce, { kind: 'trigger-observed', callNonce: sentinel.callNonce, outcome: 'acknowledged', source: 'driver' }, 'lifecycle');
    }
    // HandlerEarly: the sentinel's handler terminal commits BEFORE the
    // target's boundary settlement while its worker terminal commits after
    // it — the delayed-log-write RED shape.
    if (sentinel !== null && sentinelSpanningBoundary && sentinel.handlerEarly) {
      await server.probeDirectAppend({ kind: 'handler-settled', callNonce: sentinel.callNonce, outcome: sentinel.workerOutcome });
    }
    if (handlerOutcome !== null) await server.probeDirectAppend({ kind: 'handler-settled', callNonce, outcome: handlerOutcome });
    if (workerOutcome !== null) await server.probeDirectAppend({ kind: 'worker-settled', callNonce, workerHash, outcome: workerOutcome });
    if (triggerAfterSettlement) await appendTriggerRecords();
    if (sentinel !== null && !sentinelSpanningBoundary && !sentinelJoinedAfterTargetSettlement && !sentinelSettledBeforeTarget && !sentinelJoinBeforeTrigger && !sentinelJoinAfterTrigger) {
      await sentinelJoin();
      await sentinelSettle();
    }
    // Driver-ordered release: after the boundary, the driver explicitly
    // releases the sentinel — declaring the release (trigger-sent for the
    // sentinel's own call) and marking it acknowledged (trigger-observed).
    if (sentinel !== null && sentinelDriverRelease) {
      await directDriverAppend(run, nonce, { kind: 'trigger-sent', callNonce: sentinel.callNonce, outcome: 'turn-interrupt' }, 'lifecycle');
      await directDriverAppend(run, nonce, { kind: 'trigger-observed', callNonce: sentinel.callNonce, outcome: 'acknowledged', source: 'driver' }, 'lifecycle');
    }
    if (sentinel !== null && (sentinelSpanningBoundary || sentinelJoinBeforeTrigger || sentinelJoinAfterTrigger) && !sentinel.handlerEarly) await sentinelSettle();
    if (sentinel !== null && sentinelSpanningBoundary && sentinel.handlerEarly) {
      await server.probeDirectAppend({ kind: 'worker-settled', callNonce: sentinel.callNonce, workerHash: sentinelWorkerHash, outcome: sentinel.workerOutcome });
    }
    if (rpcOutcome !== null) await directDriverAppend(run, nonce, { kind: 'rpc-observed', probeLabel: label, callNonce, outcome: rpcOutcome }, 'lifecycle');
    if (sentinel !== null && sentinelJoinedAfterTargetSettlement) {
      await sentinelJoin();
      await sentinelSettle();
    }
  } else {
    await directDriverAppend(run, nonce, { kind: 'rpc-observed', probeLabel: label, outcome: rpcOutcome ?? 'not-observed' }, 'lifecycle');
  }
  return { label, callNonce, workerHash, sentinel, nonce };
}

test('status observation cancellation ends only observation and leaves the tracked job active', async () => {
  const lifecycle = await import('../tools/direct-mcp-probe/lifecycle.mjs');
  // The status --wait placement is pure observation: cancelling the wait may
  // never settle the tracked job, on any cancellation trigger.
  for (const trigger of ['turn-interrupt', 'config-timeout']) {
    const expectation = lifecycle.directLifecycleExpectation({ command: 'status-wait', trigger });
    assert.equal(expectation.scope, 'observation', 'status --wait cancellation is observation-scoped');
    assert.equal(expectation.settlesWorker, false, 'status --wait cancellation never settles the tracked job');
    assert.deepEqual(expectation.workerOutcomes, ['completed'], 'the tracked job may only settle by its own completion');
  }
  assert.throws(() => lifecycle.directLifecycleExpectation({ command: 'status-wait', trigger: 'mystery' }), /DIRECT_LIFECYCLE_INVALID/, 'an unknown trigger fails closed');
  assert.throws(() => lifecycle.directLifecycleExpectation({ command: 'mystery', trigger: 'turn-interrupt' }), /DIRECT_LIFECYCLE_INVALID/, 'an unknown command fails closed');
});

test('status observation expectation rejects a reducer that kills the status target', async () => {
  const lifecycle = await import('../tools/direct-mcp-probe/lifecycle.mjs');
  const { classifyDirectLifecycleCase } = lifecycle;
  await withDirectProbeRun('zcode-direct-lifecycle-', async (run) => {
    const nonce = directRunNonce();
    // The expectation table demands `completed` for the tracked job under
    // status --wait; the reducer reported it cancelled. A non-per-call
    // trigger (completion) isolates the expectation check: the mismatch must
    // surface on the TARGET's outcome, never masked by a sentinel
    // classification.
    const { label, callNonce, workerHash } = await buildDirectLifecycleTranscript(run, {
      nonce,
      handlerOutcome: 'cancelled',
      workerOutcome: 'cancelled',
      rpcOutcome: 'error-result',
    });
    const { records, reduced } = await reduceDirectRun(run, nonce);
    const verdict = classifyDirectLifecycleCase({
      records, reduced, probeLabel: label, phase: 'lifecycle', command: 'status-wait', trigger: 'completion',
    });
    assert.equal(verdict.classification, 'expectation-mismatch', 'a reducer that reports the status target cancelled is rejected');
    assert.equal(verdict.reasonCode, 'status-target-killed');
    assert.equal(verdict.workerOutcome, 'cancelled');
    assert.equal(verdict.workerOwned, true, 'ownership is still attributable even in a mismatch');
    assert.equal(callNonce, (await readDirectProbeEvents({ runDirectory: run, runNonce: nonce })).find((record) => record.kind === 'handler-entered' && record.probeLabel === label).callNonce);
    assert.ok(verdict.evidenceRefs.some((ref) => ref.startsWith('worker-settled@')), 'the mismatch cites the durable worker record');
    assert.ok(workerHash, 'the fixture worker hash is carried');
  });
});

test('direct lifecycle expectations are command-specific, never one generic worker rule', async () => {
  const lifecycle = await import('../tools/direct-mcp-probe/lifecycle.mjs');
  // The same trigger maps to DIFFERENT expectations per placement: the
  // foreground execution settles cancelled, while a background placement and
  // the status --wait observation survive caller cancellation.
  for (const trigger of ['turn-interrupt', 'config-timeout']) {
    const foreground = lifecycle.directLifecycleExpectation({ command: 'execution-foreground', trigger });
    const background = lifecycle.directLifecycleExpectation({ command: 'execution-background', trigger });
    const statusWait = lifecycle.directLifecycleExpectation({ command: 'status-wait', trigger });
    assert.equal(foreground.scope, 'operation');
    assert.equal(foreground.settlesWorker, true, 'foreground cancellation reaches the exact operation');
    assert.deepEqual(foreground.workerOutcomes, trigger === 'turn-interrupt' ? ['cancelled'] : ['cancelled', 'timed-out']);
    assert.equal(background.scope, 'observation');
    assert.equal(background.settlesWorker, false, 'background placement survives caller cancellation');
    assert.equal(statusWait.settlesWorker, false, 'status --wait cancellation never reaches the tracked job');
    assert.notDeepEqual(foreground.workerOutcomes, background.workerOutcomes, 'one generic expectation cannot cover both placements');
  }
  // Infrastructure triggers are classified from the durable record alone —
  // the table never presumes a settlement the host may not produce.
  for (const trigger of ['connection-close', 'host-stop', 'host-kill']) {
    const expectation = lifecycle.directLifecycleExpectation({ command: 'execution-foreground', trigger });
    assert.equal(expectation.scope, 'infrastructure');
    assert.equal(expectation.settlesWorker, false, 'infrastructure loss is not a caller cancellation rule');
    assert.equal(expectation.workerOutcomes, null, 'no presumed worker outcome exists for infrastructure loss');
  }
  // Completion and the injected ceiling settle the operation for every command.
  assert.deepEqual(lifecycle.directLifecycleExpectation({ command: 'execution-background', trigger: 'completion' }).workerOutcomes, ['completed']);
  assert.deepEqual(lifecycle.directLifecycleExpectation({ command: 'status-wait', trigger: 'safety-deadline' }).workerOutcomes, ['safety-deadline']);
});

test('direct lifecycle the race expectation is placement-specific, never one operation rule', async () => {
  const lifecycle = await import('../tools/direct-mcp-probe/lifecycle.mjs');
  // The race's cancellation side is a configured caller cancellation: for
  // the foreground placement it may reach the operation (one decided
  // winner), but background and status --wait keep the observation-only
  // rule — caller cancellation can never settle the tracked job, so the
  // race cell there expects only the job's own completion.
  const foreground = lifecycle.directLifecycleExpectation({ command: 'execution-foreground', trigger: 'cancel-race' });
  assert.equal(foreground.scope, 'operation');
  assert.deepEqual(foreground.workerOutcomes, ['completed', 'cancelled', 'safety-deadline']);
  for (const command of ['execution-background', 'status-wait']) {
    const cell = lifecycle.directLifecycleExpectation({ command, trigger: 'cancel-race' });
    assert.equal(cell.scope, 'observation', `the ${command} race stays observation-scoped`);
    assert.equal(cell.settlesWorker, false, `the ${command} race never settles the tracked job`);
    assert.deepEqual(cell.workerOutcomes, ['completed'], `the ${command} race never expects a cancellation-settled job`);
  }
});

test('direct lifecycle a race that settles the observed status target is the target-killed contradiction', async () => {
  const { classifyDirectLifecycleCase } = await import('../tools/direct-mcp-probe/lifecycle.mjs');
  await withDirectProbeRun('zcode-direct-lifecycle-', async (run) => {
    const nonce = directRunNonce();
    // The race's cancellation side killed the TRACKED job: under the
    // observation-only placements (status --wait, allowed background) the
    // durable cancelled terminals contradict the command expectation
    // outright — the contradiction must surface even though the race
    // boundary was observed and the sentinel state is unprovable.
    const sentinel = { label: directLabel(), callNonce: directCallNonce(), workerOutcome: 'completed' };
    const { label } = await buildDirectLifecycleTranscript(run, {
      nonce,
      triggerSent: 'config-timeout',
      triggerObserved: 'acknowledged',
      handlerOutcome: 'cancelled',
      workerOutcome: 'cancelled',
      rpcOutcome: 'error-result',
      sentinel,
      sentinelSpanningBoundary: true,
    });
    const { records, reduced } = await reduceDirectRun(run, nonce);
    const statusWait = classifyDirectLifecycleCase({
      records, reduced, probeLabel: label, phase: 'lifecycle', command: 'status-wait', trigger: 'cancel-race',
      cancellationObserved: true, sentinelLabel: sentinel.label,
    });
    assert.equal(statusWait.classification, 'expectation-mismatch', 'a race that settles the tracked job contradicts the observation placement');
    assert.equal(statusWait.reasonCode, 'status-target-killed');
    const background = classifyDirectLifecycleCase({
      records, reduced, probeLabel: label, phase: 'lifecycle', command: 'execution-background', trigger: 'cancel-race',
      cancellationObserved: true, sentinelLabel: sentinel.label,
    });
    assert.equal(background.classification, 'expectation-mismatch', 'a race that settles the background job is the same contradiction');
    assert.equal(background.reasonCode, 'unexpected-worker-outcome');
  });
});

test('direct lifecycle behavior-confirmed requires an acknowledged trigger and a wait that ended', async () => {
  const { classifyDirectLifecycleCase } = await import('../tools/direct-mcp-probe/lifecycle.mjs');
  await withDirectProbeRun('zcode-direct-lifecycle-', async (run) => {
    const nonce = directRunNonce();
    // An indefinitely pending wait must never become a passing case: with
    // the trigger acknowledged but the wait call never answering (rpc-observed
    // `not-observed`), the observation-only placement proves nothing.
    const sentinel = { label: directLabel(), callNonce: directCallNonce(), workerOutcome: 'completed' };
    const { label } = await buildDirectLifecycleTranscript(run, {
      nonce,
      triggerSent: 'turn-interrupt',
      triggerObserved: 'acknowledged',
      rpcOutcome: 'not-observed',
      sentinel,
    });
    const { records, reduced } = await reduceDirectRun(run, nonce);
    const pending = classifyDirectLifecycleCase({
      records, reduced, probeLabel: label, phase: 'lifecycle', command: 'status-wait', trigger: 'turn-interrupt', exactTurnConfirmed: true,
      sentinelLabel: sentinel.label,
    });
    assert.equal(pending.classification, 'settlement-unproven', 'a wait that never ended cannot confirm the observation behavior');
    assert.equal(pending.reasonCode, 'wait-ended-unobserved');
    // A wait-ended RPC observation without a durably acknowledged trigger is
    // equally unproven: no cancellation was ever in play.
    const second = await buildDirectLifecycleTranscript(run, {
      nonce,
      triggerSent: 'turn-interrupt',
      triggerObserved: 'rejected',
      rpcOutcome: 'error-result',
      sentinel: { label: directLabel(), callNonce: directCallNonce(), workerOutcome: 'completed' },
    });
    const secondReduce = await reduceDirectRun(run, nonce);
    const unacknowledged = classifyDirectLifecycleCase({
      records: secondReduce.records, reduced: secondReduce.reduced, probeLabel: second.label, phase: 'lifecycle',
      command: 'status-wait', trigger: 'turn-interrupt', exactTurnConfirmed: true, sentinelLabel: second.sentinel.label,
    });
    assert.equal(unacknowledged.classification, 'settlement-unproven', 'a rejected trigger never acknowledged the cancellation');
    assert.equal(unacknowledged.reasonCode, 'wait-ended-unobserved');
  });
});

test('direct lifecycle an unsettled sentinel keeps the observation behavior unproven', async () => {
  const { classifyDirectLifecycleCase } = await import('../tools/direct-mcp-probe/lifecycle.mjs');
  await withDirectProbeRun('zcode-direct-lifecycle-', async (run) => {
    const nonce = directRunNonce();
    // Acknowledged trigger, ended wait — but the joined sentinel has NO
    // durable settlement of its own: the unrelated call's fate is unknown
    // (it may have been cancelled by the same action), so the case can
    // never confirm the observation-only placement behavior. The G3 gate
    // accepts behavior-confirmed, so an unresolved sentinel must never
    // ride through it.
    const sentinel = { label: directLabel(), callNonce: directCallNonce(), workerOutcome: null };
    const { label } = await buildDirectLifecycleTranscript(run, {
      nonce,
      triggerSent: 'turn-interrupt',
      triggerObserved: 'acknowledged',
      rpcOutcome: 'error-result',
      sentinel,
    });
    const { records, reduced } = await reduceDirectRun(run, nonce);
    const verdict = classifyDirectLifecycleCase({
      records, reduced, probeLabel: label, phase: 'lifecycle', command: 'status-wait', trigger: 'turn-interrupt', exactTurnConfirmed: true,
      sentinelLabel: sentinel.label,
    });
    assert.equal(verdict.classification, 'settlement-unproven', 'an unresolved sentinel leaves the unrelated call fate unknown');
    assert.equal(verdict.reasonCode, 'sentinel-never-settled');
    assert.equal(verdict.sentinelClassification, 'unproven');
  });
});

test('direct lifecycle a settled-but-unprovable sentinel keeps the observation behavior unproven', async () => {
  const { classifyDirectLifecycleCase } = await import('../tools/direct-mcp-probe/lifecycle.mjs');
  await withDirectProbeRun('zcode-direct-lifecycle-', async (run) => {
    const nonce = directRunNonce();
    // The finding's exact shape: acknowledged trigger, ended wait, NO target
    // settlement, and a sentinel durably settled CANCELLED. For the
    // host-internal config-timeout boundary the sentinel's classification is
    // `unproven` (`sentinel-ordering-unprovable`) — the existence of its
    // worker terminal proves nothing about whether the broad cancellation
    // caught it — so the case must stay unproven, never behavior-confirmed.
    const sentinel = { label: directLabel(), callNonce: directCallNonce(), workerOutcome: 'cancelled' };
    const { label } = await buildDirectLifecycleTranscript(run, {
      nonce,
      triggerSent: 'config-timeout',
      triggerObserved: 'acknowledged',
      rpcOutcome: 'error-result',
      sentinel,
    });
    const { records, reduced } = await reduceDirectRun(run, nonce);
    const verdict = classifyDirectLifecycleCase({
      records, reduced, probeLabel: label, phase: 'lifecycle', command: 'status-wait', trigger: 'config-timeout',
      sentinelLabel: sentinel.label,
    });
    assert.equal(verdict.classification, 'settlement-unproven', 'an unprovable sentinel classification keeps the case unproven');
    assert.equal(verdict.reasonCode, 'sentinel-ordering-unprovable');
    assert.equal(verdict.sentinelClassification, 'unproven');
    // A PARTIAL sentinel terminal (worker settled, handler missing) is the
    // same refusal: the classification result, not the terminal's existence,
    // gates the observation pass.
    const partial = { label: directLabel(), callNonce: directCallNonce(), workerOutcome: 'completed', workerOnly: true };
    const second = await buildDirectLifecycleTranscript(run, {
      nonce,
      triggerSent: 'turn-interrupt',
      triggerObserved: 'acknowledged',
      rpcOutcome: 'error-result',
      sentinel: partial,
    });
    const secondReduce = await reduceDirectRun(run, nonce);
    const partialVerdict = classifyDirectLifecycleCase({
      records: secondReduce.records, reduced: secondReduce.reduced, probeLabel: second.label, phase: 'lifecycle',
      command: 'status-wait', trigger: 'turn-interrupt', exactTurnConfirmed: true, sentinelLabel: partial.label,
    });
    assert.equal(partialVerdict.classification, 'settlement-unproven', 'a partial sentinel write proves no conclusive result');
    assert.equal(partialVerdict.reasonCode, 'boundary-not-yet-observed');
    assert.equal(partialVerdict.sentinelClassification, 'unproven');
  });
});

test('direct lifecycle a caught sentinel is the observation mismatch, never a pass', async () => {
  const { classifyDirectLifecycleCase } = await import('../tools/direct-mcp-probe/lifecycle.mjs');
  await withDirectProbeRun('zcode-direct-lifecycle-', async (run) => {
    const nonce = directRunNonce();
    // A demonstrably CAUGHT sentinel (durably settled cancelled by the same
    // action) under an observation placement is the expectation-mismatch
    // contradiction — broad cancellation is never qualified behavior.
    const sentinel = { label: directLabel(), callNonce: directCallNonce(), workerOutcome: 'cancelled' };
    const { label } = await buildDirectLifecycleTranscript(run, {
      nonce,
      triggerSent: 'turn-interrupt',
      triggerObserved: 'acknowledged',
      rpcOutcome: 'error-result',
      sentinel,
    });
    const { records, reduced } = await reduceDirectRun(run, nonce);
    const verdict = classifyDirectLifecycleCase({
      records, reduced, probeLabel: label, phase: 'lifecycle', command: 'status-wait', trigger: 'turn-interrupt', exactTurnConfirmed: true,
      sentinelLabel: sentinel.label,
    });
    assert.equal(verdict.classification, 'expectation-mismatch', 'a caught sentinel is the broad-cancellation contradiction');
    assert.equal(verdict.reasonCode, 'sentinel-caught');
  });
});

test('direct lifecycle case classifier proves exact ownership and bounded settlement on matching records', async () => {
  const { classifyDirectLifecycleCase } = await import('../tools/direct-mcp-probe/lifecycle.mjs');
  await withDirectProbeRun('zcode-direct-lifecycle-', async (run) => {
    const nonce = directRunNonce();
    const { label } = await buildDirectLifecycleTranscript(run, {
      nonce,
      handlerOutcome: 'completed',
      workerOutcome: 'completed',
      rpcOutcome: 'success-result',
    });
    const { records, reduced } = await reduceDirectRun(run, nonce);
    const verdict = classifyDirectLifecycleCase({
      records, reduced, probeLabel: label, phase: 'lifecycle', command: 'execution-foreground', trigger: 'completion',
    });
    assert.equal(verdict.classification, 'settlement-observed');
    assert.equal(verdict.reasonCode, null);
    assert.equal(verdict.workerOwned, true, 'the settled worker hash joins the held worker exactly');
    assert.equal(verdict.handlerOutcome, 'completed');
    assert.equal(verdict.workerOutcome, 'completed');
    assert.ok(verdict.evidenceRefs.includes(`hold-started@${records.find((record) => record.kind === 'hold-started').sequence}`));
  });
});

test('direct lifecycle case classifier records not-sent when the hold prerequisite is missing', async () => {
  const { classifyDirectLifecycleCase } = await import('../tools/direct-mcp-probe/lifecycle.mjs');
  await withDirectProbeRun('zcode-direct-lifecycle-', async (run) => {
    const nonce = directRunNonce();
    // A label with no records at all: not observed.
    const absentLabel = directLabel();
    // A dispatched request whose handler never entered: the hold prerequisite
    // is missing, so the case records not-sent, never a settlement.
    const { label: unheldLabel } = await buildDirectLifecycleTranscript(run, { nonce, withHold: false, rpcOutcome: 'success-result' });
    const { records, reduced } = await reduceDirectRun(run, nonce);
    const absent = classifyDirectLifecycleCase({
      records, reduced, probeLabel: absentLabel, phase: 'lifecycle', command: 'execution-foreground', trigger: 'turn-interrupt',
    });
    assert.equal(absent.classification, 'not-observed');
    const unheld = classifyDirectLifecycleCase({
      records, reduced, probeLabel: unheldLabel, phase: 'lifecycle', command: 'execution-foreground', trigger: 'turn-interrupt',
    });
    assert.equal(unheld.classification, 'not-sent');
    assert.equal(unheld.reasonCode, 'hold-not-started');
  });
});

test('direct lifecycle case classifier records not-sent when the exact turn is unconfirmed for interrupt', async () => {
  const { classifyDirectLifecycleCase } = await import('../tools/direct-mcp-probe/lifecycle.mjs');
  await withDirectProbeRun('zcode-direct-lifecycle-', async (run) => {
    const nonce = directRunNonce();
    // Durable entry and hold exist, but no confirmed active exact turn: the
    // interrupt trigger is honestly not sent and the case records not-sent.
    const { label } = await buildDirectLifecycleTranscript(run, { nonce, handlerOutcome: 'connection-closed', workerOutcome: 'connection-closed' });
    const { records, reduced } = await reduceDirectRun(run, nonce);
    const verdict = classifyDirectLifecycleCase({
      records, reduced, probeLabel: label, phase: 'lifecycle', command: 'execution-foreground', trigger: 'turn-interrupt', exactTurnConfirmed: false,
    });
    assert.equal(verdict.classification, 'not-sent');
    assert.equal(verdict.reasonCode, 'turn-not-confirmed', 'the missing exact-turn prerequisite is recorded, never inferred past');
  });
});

test('direct lifecycle case classifier marks settlement-unproven when a foreground worker never settles', async () => {
  const { classifyDirectLifecycleCase } = await import('../tools/direct-mcp-probe/lifecycle.mjs');
  await withDirectProbeRun('zcode-direct-lifecycle-', async (run) => {
    const nonce = directRunNonce();
    // The interrupt was sent and acknowledged but no terminal record exists:
    // an interrupted turn with a still-running worker.
    const sentinel = { label: directLabel(), callNonce: directCallNonce(), workerOutcome: 'completed' };
    const { label } = await buildDirectLifecycleTranscript(run, {
      nonce,
      triggerSent: 'turn-interrupt',
      triggerObserved: 'acknowledged',
      rpcOutcome: 'not-observed',
      sentinel,
    });
    const { records, reduced } = await reduceDirectRun(run, nonce);
    const verdict = classifyDirectLifecycleCase({
      records, reduced, probeLabel: label, phase: 'lifecycle', command: 'execution-foreground', trigger: 'turn-interrupt', exactTurnConfirmed: true,
      sentinelLabel: sentinel.label,
    });
    assert.equal(verdict.classification, 'settlement-unproven', 'a still-running worker after interruption is unproven settlement');
    // The sentinel completed without any durable cancellation boundary for
    // the target: the boundary was never observed, so isolation is unproven.
    assert.equal(verdict.reasonCode, 'boundary-not-yet-observed');
    assert.equal(verdict.workerOutcome, null);
  });
});

test('direct lifecycle observation placements record the sentinel classification honestly', async () => {
  const { classifyDirectLifecycleCase } = await import('../tools/direct-mcp-probe/lifecycle.mjs');
  await withDirectProbeRun('zcode-direct-lifecycle-', async (run) => {
    const nonce = directRunNonce();
    // Caller cancellation durably acknowledged AND the wait itself ended
    // (the wait call answered — rpc-observed `error-result`), no worker
    // settlement: the placement table says the tracked job survives, but
    // behavior-confirmed demands a CONCLUSIVE sentinel result. Since the
    // decision-order adjudication no per-call sentinel classification is
    // conclusive, so these cases honestly record the sentinel's unproven
    // reason — the placement rule itself is pinned by the table cells and
    // the target-killed contradiction, never by an unprovable sentinel.
    const backgroundSentinel = { label: directLabel(), callNonce: directCallNonce(), workerOutcome: 'completed' };
    const { label: backgroundLabel } = await buildDirectLifecycleTranscript(run, {
      nonce,
      triggerSent: 'turn-interrupt',
      triggerObserved: 'acknowledged',
      rpcOutcome: 'error-result',
      sentinel: backgroundSentinel,
    });
    const first = await reduceDirectRun(run, nonce);
    const background = classifyDirectLifecycleCase({
      records: first.records, reduced: first.reduced, probeLabel: backgroundLabel, phase: 'lifecycle', command: 'execution-background', trigger: 'turn-interrupt', exactTurnConfirmed: true,
      sentinelLabel: backgroundSentinel.label,
    });
    assert.equal(background.classification, 'settlement-unproven', 'the completed sentinel cannot prove isolation across the unobserved boundary');
    assert.equal(background.reasonCode, 'boundary-not-yet-observed');
    assert.equal(background.sentinelClassification, 'unproven');
    const statusSentinel = { label: directLabel(), callNonce: directCallNonce(), workerOutcome: 'completed' };
    const { label: statusLabel } = await buildDirectLifecycleTranscript(run, {
      nonce,
      triggerSent: 'config-timeout',
      triggerObserved: 'acknowledged',
      rpcOutcome: 'error-result',
      sentinel: statusSentinel,
    });
    const second = await reduceDirectRun(run, nonce);
    const statusWait = classifyDirectLifecycleCase({
      records: second.records, reduced: second.reduced, probeLabel: statusLabel, phase: 'lifecycle', command: 'status-wait', trigger: 'config-timeout', exactTurnConfirmed: true,
      sentinelLabel: statusSentinel.label,
    });
    assert.equal(statusWait.classification, 'settlement-unproven', 'the host-internal timeout boundary is durably unorderable');
    assert.equal(statusWait.reasonCode, 'sentinel-ordering-unprovable');
  });
});

test('direct lifecycle case classifier catches a sentinel cancelled by an unrelated per-call trigger', async () => {
  const { classifyDirectLifecycleCase } = await import('../tools/direct-mcp-probe/lifecycle.mjs');
  await withDirectProbeRun('zcode-direct-lifecycle-', async (run) => {
    const nonce = directRunNonce();
    const sentinel = { label: directLabel(), callNonce: directCallNonce(), workerOutcome: 'cancelled' };
    const { label } = await buildDirectLifecycleTranscript(run, {
      nonce,
      triggerSent: 'turn-interrupt',
      triggerObserved: 'acknowledged',
      handlerOutcome: 'cancelled',
      workerOutcome: 'cancelled',
      rpcOutcome: 'error-result',
      sentinel,
    });
    const { records, reduced } = await reduceDirectRun(run, nonce);
    const verdict = classifyDirectLifecycleCase({
      records, reduced, probeLabel: label, phase: 'lifecycle', command: 'execution-foreground', trigger: 'turn-interrupt', exactTurnConfirmed: true,
      sentinelLabel: sentinel.label,
    });
    assert.equal(verdict.classification, 'expectation-mismatch', 'overly broad cancellation is a contradiction');
    assert.equal(verdict.reasonCode, 'sentinel-caught', 'the unrelated sentinel was cancelled by the per-call trigger');
    assert.equal(verdict.sentinelClassification, 'caught');
    assert.equal(verdict.workerOwned, true);
  });
});

test('direct lifecycle G3 gate stays not-proven unless every required case is durably observed', async () => {
  const { classifyDirectGateG3 } = await loadDirectDriver();
  const demonstrated = assessReconciliationDemonstrated();
  // The full positive control: every required trigger observed, settlement
  // matching, reconciliation demonstrated — and even then the gate only
  // upgrades when the interrupted-turn case was actually sent.
  const fullCases = requiredLifecycleCases().map(({ trigger, command }) => ({
    trigger, command, classification: 'settlement-observed', workerOutcome: 'completed', workerOwned: true, sent: true,
  }));
  const full = classifyDirectGateG3({ cases: fullCases, reconciliation: demonstrated });
  assert.equal(full.status, 'proven');
  assert.equal(full.reasonCode, 'lifecycle-settlement-durably-observed');
  // The interrupted-turn case recorded not-sent (its prerequisite was never
  // demonstrated): G3 stays not-proven — a not-sent case is a missing
  // prerequisite, never a pass.
  const interruptNotSent = fullCases.map((entry) => (
    entry.trigger === 'turn-interrupt' ? { ...entry, classification: 'not-sent', sent: false, reasonCode: 'turn-not-confirmed' } : entry
  ));
  const withNotSent = classifyDirectGateG3({ cases: interruptNotSent, reconciliation: demonstrated });
  assert.equal(withNotSent.status, 'not-proven');
  assert.equal(withNotSent.reasonCode, 'interrupt-case-not-sent');
  // Coverage missing: a required trigger with no case at all never proves.
  const partial = classifyDirectGateG3({ cases: fullCases.slice(0, 3), reconciliation: demonstrated });
  assert.equal(partial.status, 'not-proven');
  assert.equal(partial.reasonCode, 'case-coverage-missing');
  // Reconciliation not demonstrated: the gate stays down whatever the cases show.
  const unreconciled = classifyDirectGateG3({ cases: fullCases, reconciliation: { status: 'rejected', reasonCode: 'ownership-or-boundedness-unproven' } });
  assert.equal(unreconciled.status, 'not-proven');
  assert.equal(unreconciled.reasonCode, 'ownership-or-boundedness-unproven');
  // An expectation mismatch anywhere is a contradiction that fails the gate.
  const mismatched = fullCases.map((entry) => (
    entry.trigger === 'config-timeout' ? { ...entry, classification: 'expectation-mismatch', reasonCode: 'status-target-killed' } : entry
  ));
  const withMismatch = classifyDirectGateG3({ cases: mismatched, reconciliation: demonstrated });
  assert.equal(withMismatch.status, 'not-proven');
  assert.equal(withMismatch.reasonCode, 'expectation-mismatch-observed');
  // A host signal that cannot be verified as delivered records the case
  // not-sent with signal-unverified, and the gate names that prerequisite.
  const withUnverifiedSignal = fullCases.map((entry) => (
    entry.trigger === 'host-stop' ? { ...entry, classification: 'not-sent', sent: false, reasonCode: 'signal-unverified' } : entry
  ));
  const unverified = classifyDirectGateG3({ cases: withUnverifiedSignal, reconciliation: demonstrated });
  assert.equal(unverified.status, 'not-proven');
  assert.equal(unverified.reasonCode, 'host-signal-unverified');
  // Behavior-confirmed observation-only placements do not block the gate,
  // but a settlement-unproven case does.
  const withUnproven = fullCases.map((entry) => (
    entry.trigger === 'host-kill' ? { ...entry, classification: 'settlement-unproven', reasonCode: 'worker-never-settled' } : entry
  ));
  const unproven = classifyDirectGateG3({ cases: withUnproven, reconciliation: demonstrated });
  assert.equal(unproven.status, 'not-proven');
  assert.equal(unproven.reasonCode, 'settlement-unproven');
});

test('direct lifecycle G3 gate fails on an interrupted turn with a still-running worker', async () => {
  const { classifyDirectGateG3 } = await loadDirectDriver();
  // The plan rule, pinned: an interrupted turn with a still-running worker
  // must fail G3 — take precedence over every other reason.
  const cases = requiredLifecycleCases().map(({ trigger, command }) => (
    trigger === 'turn-interrupt'
      ? { trigger, command, classification: 'settlement-unproven', workerOutcome: null, workerOwned: false, sent: true, reasonCode: 'worker-never-settled' }
      : { trigger, command, classification: 'settlement-observed', workerOutcome: 'completed', workerOwned: true, sent: true }
  ));
  const verdict = classifyDirectGateG3({ cases, reconciliation: assessReconciliationDemonstrated() });
  assert.equal(verdict.status, 'not-proven');
  assert.equal(verdict.reasonCode, 'interrupted-worker-unsettled');
});

test('direct lifecycle reconciliation strategy is limited to surviving processes and never upgrades G3 alone', async () => {
  const { assessDirectReconciliationStrategy } = await import('../tools/direct-mcp-probe/lifecycle.mjs');
  // The synthetic worker tests prove exact ownership and bounded settlement
  // for the LOCAL mechanism: the strategy is accepted as demonstrated ONLY
  // under its conditions.
  const local = assessDirectReconciliationStrategy({
    exactOwnershipProven: true,
    boundedSettlementProven: true,
    hostLossSettlementDemonstrated: false,
  });
  assert.equal(local.status, 'demonstrated-with-limits');
  assert.equal(local.reasonCode, 'host-loss-unreconcilable', 'no durable writer survives host loss, so the strategy cannot cover that trigger');
  // Without the synthetic proof of ownership or boundedness, the strategy is
  // rejected outright.
  const rejected = assessDirectReconciliationStrategy({
    exactOwnershipProven: true,
    boundedSettlementProven: false,
    hostLossSettlementDemonstrated: false,
  });
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.reasonCode, 'ownership-or-boundedness-unproven');
});

/** The reconciliation facts the synthetic worker tests demonstrated locally. */
function assessReconciliationDemonstrated() {
  return { status: 'demonstrated-with-limits', reasonCode: 'host-loss-unreconcilable' };
}

/** The full required case matrix: every lifecycle trigger with its command placement. */
function requiredLifecycleCases() {
  return [
    { trigger: 'turn-interrupt', command: 'execution-foreground' },
    { trigger: 'connection-close', command: 'execution-foreground' },
    { trigger: 'host-stop', command: 'execution-foreground' },
    { trigger: 'host-kill', command: 'execution-foreground' },
    { trigger: 'config-timeout', command: 'execution-foreground' },
    { trigger: 'safety-deadline', command: 'execution-foreground' },
    { trigger: 'completion', command: 'execution-foreground' },
    { trigger: 'cancel-race', command: 'execution-foreground' },
  ];
}

// ---------------------------------------------------------------------------
// Task 6: the installed product entry (G4). Step 1 selects a candidate from
// the Task 1 inventory only; the G4 gate below derives its decision from that
// inventory's public decisions. These are GATE tests, not the Step 2
// installed-fixture acceptance demonstration: with no supported candidate the
// acceptance run is skipped, and the gate must refuse any demonstration
// recorded without a ready candidate.
// ---------------------------------------------------------------------------

/**
 * A fully demonstrated installed-fixture record (the plan Task 6 Step 2
 * fields): one explicit action dispatched exactly once, a hold beyond two
 * 60-second legacy wait intervals, zero model decisions, terminal delivery to
 * the original Root/Child, routed user interruption, and the recorded
 * wall-clock hold duration plus comparison baseline.
 */
function demonstratedEntryFixture(overrides = {}) {
  return {
    onInstalledUserSession: true,
    dispatchOnce: true,
    heldBeyondTwoWaitIntervals: true,
    modelDecisionsDuringHold: 0,
    terminalDelivered: true,
    cancellationRouted: true,
    holdDurationMs: 120_000,
    comparisonBaselineRecorded: true,
    ...overrides,
  };
}

test('direct entry G4 gate records not-proven with the concrete missing link on the shipped inventory', () => {
  const verdict = classifyDirectGateG4({ inventory: inventoryEntryCandidates() });
  assert.equal(verdict.status, 'not-proven');
  assert.equal(verdict.reasonCode, 'no-supported-entry-candidate');
  assert.deepEqual(
    verdict.missingAspects,
    [...ENTRY_REQUIRED_ASPECTS],
    'no within-boundary candidate demonstrates any required aspect — the concrete missing link',
  );
});

test('direct entry G4 gate refuses a demonstration recorded without a ready candidate', () => {
  const verdict = classifyDirectGateG4({ inventory: inventoryEntryCandidates(), demonstration: demonstratedEntryFixture() });
  assert.equal(verdict.status, 'not-proven', 'a demonstration without candidate-level proven readiness can never pass the gate');
  assert.equal(verdict.reasonCode, 'no-supported-entry-candidate');
});

test('direct entry G4 gate reclassifies candidates inside the gate and never trusts a supplied decision', () => {
  // Gate-review backfill P2 regression: a shipped row whose caller-supplied
  // decision was tampered to `proven` — while the candidate's own fields
  // still show unproven owning-host access and model-selected dispatch —
  // must not flip the gate, whatever demonstration accompanies it. The gate
  // derives every decision from the candidate itself (classifyEntryCandidate)
  // and ignores the supplied one, so the shipped decisions are derived,
  // never trusted.
  const tampered = inventoryEntryCandidates().map((entry) => (
    entry.candidate.id === 'skill-model-selected'
      ? { candidate: entry.candidate, decision: { status: 'proven', reasons: [] } }
      : entry
  ));
  const tamper = classifyDirectGateG4({ inventory: tampered, demonstration: demonstratedEntryFixture() });
  assert.equal(tamper.status, 'not-proven', 'a tampered decision can never promote an unproven candidate');
  assert.equal(tamper.reasonCode, 'no-supported-entry-candidate');
  assert.deepEqual(tamper.missingAspects, [...ENTRY_REQUIRED_ASPECTS], 'the derived missing link is unchanged by the tampered decision');
  // The derivation is total: the gate classifies from the candidates alone,
  // whether or not the caller supplies decision rows at all.
  const bare = classifyDirectGateG4({
    inventory: inventoryEntryCandidates().map((entry) => ({ candidate: entry.candidate })),
    demonstration: demonstratedEntryFixture(),
  });
  assert.equal(bare.status, 'not-proven');
  assert.equal(bare.reasonCode, 'no-supported-entry-candidate');
});

test('direct entry G4 gate validates every candidate before filtering by boundary', () => {
  // Gate-review re-review P2 regression: the gate filtered rows by their
  // CLAIMED installed-plugin boundary before classifying them, so a
  // malformed row claiming `external` (or carrying no boundary at all) was
  // silently skipped — and with a ready within-boundary candidate plus a
  // complete demonstration the gate still returned `proven`. Every
  // candidate is now validated FIRST (classify everything, then filter the
  // validated rows by boundary): a malformed row fails closed whatever
  // boundary it claims.
  const malformedExternal = demonstratedCandidate({ installedPluginBoundary: 'external' });
  malformedExternal.fields.userAction = { mark: 'bogus', note: 'an unknown mark makes the row malformed' };
  const missingBoundary = demonstratedCandidate();
  delete missingBoundary.installedPluginBoundary;
  for (const [name, bad] of [['malformed external', malformedExternal], ['missing boundary', missingBoundary]]) {
    const inventory = [...demonstratedEntryInventory(), { candidate: bad }];
    assert.throws(
      () => classifyDirectGateG4({ inventory, demonstration: demonstratedEntryFixture() }),
      /ENTRY_CANDIDATE_INVALID/,
      `a ${name} row must fail candidate validation, never be silently skipped beside a proven result`,
    );
  }
});

/** A ready inventory: the demonstrated positive-control candidate is within-boundary and classifies proven. */
function demonstratedEntryInventory() {
  const candidate = demonstratedCandidate();
  return [{ candidate, decision: classifyEntryCandidate(candidate) }];
}

test('direct entry G4 gate demands the demonstration only after a ready within-boundary candidate', () => {
  const inventory = demonstratedEntryInventory();
  assert.equal(inventory[0].decision.status, 'proven', 'the positive-control candidate is genuinely ready');
  const missing = classifyDirectGateG4({ inventory });
  assert.equal(missing.status, 'not-proven');
  assert.equal(missing.reasonCode, 'entry-demonstration-missing');
});

test('direct entry G4 gate fails closed on a malformed demonstration record', () => {
  const inventory = demonstratedEntryInventory();
  assert.throws(
    () => classifyDirectGateG4({ inventory, demonstration: { ...demonstratedEntryFixture(), unsanctionedField: true } }),
    /unknown key/,
  );
  assert.throws(
    () => classifyDirectGateG4({ inventory, demonstration: { ...demonstratedEntryFixture(), modelDecisionsDuringHold: 'zero' } }),
    /model decision count/,
  );
  assert.throws(
    () => classifyDirectGateG4({ inventory, demonstration: { ...demonstratedEntryFixture(), holdDurationMs: -5 } }),
    /hold duration/,
  );
  assert.throws(
    () => classifyDirectGateG4({ inventory, demonstration: { ...demonstratedEntryFixture(), terminalDelivered: 'yes' } }),
    /must be a boolean/,
  );
  // A non-object demonstration record is malformed; an ABSENT record (null or
  // undefined) is not malformed — it is the `entry-demonstration-missing` link.
  assert.throws(() => classifyDirectGateG4({ inventory, demonstration: ['not-an-object'] }), /must be an object/);
  assert.equal(classifyDirectGateG4({ inventory, demonstration: undefined }).reasonCode, 'entry-demonstration-missing');
});

test('direct entry G4 gate never counts a driver-owned thread as the installed user session', () => {
  const verdict = classifyDirectGateG4({
    inventory: demonstratedEntryInventory(),
    demonstration: demonstratedEntryFixture({ onInstalledUserSession: false }),
  });
  assert.equal(verdict.status, 'not-proven', "the disposable driver's own app-server thread is never the user's CLI/UI session");
  assert.equal(verdict.reasonCode, 'driver-thread-not-user-session');
});

test('direct entry G4 gate refuses an incomplete installed demonstration', () => {
  const incompleteDemonstrations = [
    demonstratedEntryFixture({ dispatchOnce: false }),
    demonstratedEntryFixture({ heldBeyondTwoWaitIntervals: false }),
    demonstratedEntryFixture({ modelDecisionsDuringHold: 2 }),
    demonstratedEntryFixture({ terminalDelivered: false }),
    demonstratedEntryFixture({ cancellationRouted: false }),
    demonstratedEntryFixture({ holdDurationMs: 119_999 }),
    demonstratedEntryFixture({ comparisonBaselineRecorded: false }),
  ];
  for (const demonstration of incompleteDemonstrations) {
    const verdict = classifyDirectGateG4({ inventory: demonstratedEntryInventory(), demonstration });
    assert.equal(verdict.status, 'not-proven');
    assert.equal(verdict.reasonCode, 'entry-demonstration-incomplete', `${JSON.stringify(demonstration)} must not demonstrate the entry`);
  }
});

test('direct entry G4 gate classifies a fully demonstrated installed entry as proven', () => {
  const verdict = classifyDirectGateG4({ inventory: demonstratedEntryInventory(), demonstration: demonstratedEntryFixture() });
  assert.deepEqual(verdict, { status: 'proven', reasonCode: 'installed-entry-demonstrated', evidenceRefs: [] });
});

test('the G4 gate decision codes and hold floor are closed', () => {
  assert.deepEqual(
    [...ENTRY_GATE_G4_DECISION_CODES],
    [
      'no-supported-entry-candidate',
      'entry-demonstration-missing',
      'driver-thread-not-user-session',
      'entry-demonstration-incomplete',
      'installed-entry-demonstrated',
    ],
  );
  assert.equal(ENTRY_GATE_G4_MIN_HOLD_MS, 120_000, 'the acceptance hold spans at least two 60-second legacy wait intervals');
});



/** The in-process server exit grace, for tests that wait past a killed writer. */
const DIRECT_SERVER_EXIT_GRACE_TEST_MS = 7_000;

// The lifecycle schedule and CLI, against the fake app-server fixture. The
// fake host forwards the REAL hold_direct dispatch to the REAL disposable
// server executable, so every durable settlement is genuine handler evidence.

test('direct lifecycle driver schedule classifies the completion case against the fake app-server', async () => {
  const { runDirectLifecycleProbe } = await loadDirectDriver();
  const fixture = await buildDirectDriverFixture('lifecycle-completion');
  try {
    const run = join(fixture.parent, 'run');
    await fsp.mkdir(run, { mode: 0o700 });
    const counters = await runDirectLifecycleProbe({
      codexPath: fixture.codexPath, sourceCodexHome: fixture.sourceHome, runDirectory: run,
      lifecycleObserveWindowMs: 15_000,
      cases: ['completion'],
    });
    const phase = counters.phases.lifecycle;
    assert.equal(phase.readiness, 'discovered');
    assert.equal(phase.cases.completion, 'settlement-observed');
    assert.equal(phase.workerOutcomes.completion, 'completed');
    // The case output names the command expectation it tested (plan Task 5
    // Step 4) and carries the classifier's ownership verdict.
    assert.deepEqual(phase.commandExpectations.completion, { scope: 'operation', settlesWorker: false, workerOutcomes: ['completed'] });
    assert.equal(phase.workerOwned.completion, true, 'the classifier joined the settled worker exactly');
    assert.equal(phase.prerequisites.holdStartedSeen, true, 'the case waited for the durable hold-started before acting');
    assert.equal(phase.gateG3.status, 'not-proven', 'one observed case never proves the whole gate');
    assert.equal(phase.gateG3.reasonCode, 'case-coverage-missing');
    assert.equal(phase.cleanup, 'released');
    assert.equal(phase.uncommittedCount, 0);
  } finally {
    await rm(fixture.parent, { recursive: true, force: true });
  }
});

test('direct lifecycle driver records not-sent for an interrupt with no controlled hold', async () => {
  const { runDirectLifecycleProbe } = await loadDirectDriver();
  const fixture = await buildDirectDriverFixture('lifecycle-interrupt-no-hold');
  try {
    const run = join(fixture.parent, 'run');
    await fsp.mkdir(run, { mode: 0o700 });
    const counters = await runDirectLifecycleProbe({
      codexPath: fixture.codexPath, sourceCodexHome: fixture.sourceHome, runDirectory: run,
      turnSetupBudgetMs: 3_000, lifecycleObserveWindowMs: 10_000,
      cases: ['turn-interrupt'],
    });
    const phase = counters.phases.lifecycle;
    assert.equal(phase.cases['turn-interrupt'], 'not-sent', 'a missing exact-turn prerequisite is recorded not-sent');
    assert.equal(phase.caseReasons['turn-interrupt'], 'turn-not-confirmed');
    assert.equal(phase.activeTurnHold.status, 'not-proven');
    // No hold was dispatched for the case, so the gate names the interrupt
    // prerequisite, not a settlement.
    assert.equal(phase.gateG3.status, 'not-proven');
    assert.equal(phase.gateG3.reasonCode, 'interrupt-case-not-sent');
    assert.equal(phase.cleanup, 'released');
  } finally {
    await rm(fixture.parent, { recursive: true, force: true });
  }
});

test('direct lifecycle driver interrupt with a controlled hold leaves the worker unsettled and fails G3', async () => {
  const { runDirectLifecycleProbe } = await loadDirectDriver();
  const fixture = await buildDirectDriverFixture('lifecycle-interrupt-hold');
  try {
    const run = join(fixture.parent, 'run');
    await fsp.mkdir(run, { mode: 0o700 });
    const counters = await runDirectLifecycleProbe({
      codexPath: fixture.codexPath, sourceCodexHome: fixture.sourceHome, runDirectory: run,
      // The boundary-spanning sentinel settles at 12 s: the window must
      // cover its in-window settlement for the isolation check to run.
      turnSetupBudgetMs: 5_000, lifecycleObserveWindowMs: 16_000, directCallDeadlineMs: 8_000,
      cases: ['turn-interrupt'],
    });
    const phase = counters.phases.lifecycle;
    assert.equal(phase.activeTurnHold.status, 'observed', 'the fake approval request holds the exact turn');
    assert.equal(phase.cases['turn-interrupt'], 'settlement-unproven', 'the interrupt reached the turn but never the held worker');
    assert.equal(phase.caseReasons['turn-interrupt'], 'boundary-not-yet-observed', 'the target never settled a cancellation, so no boundary marker exists');
    assert.equal(phase.workerOwned['turn-interrupt'], false, 'no worker settlement exists, so ownership is not attributable');
    assert.equal(phase.gateG3.status, 'not-proven');
    assert.equal(phase.gateG3.reasonCode, 'interrupted-worker-unsettled', 'an interrupted turn with a still-running worker must fail G3');
    assert.equal(phase.cleanup, 'released');
    // The corrected durable ordering, pinned end-to-end: the sentinel's
    // hold-started precedes the driver's trigger-sent record (the sentinel
    // was established before the action was declared).
    const rawLog = await readFile(join(run, 'events.jsonl'), 'utf8');
    const sentinelHoldSeq = rawLog.trim().split('\n').map((l) => JSON.parse(l))
      .filter((r) => r.kind === 'hold-started')[0].sequence;
    const triggerSentSeq = rawLog.trim().split('\n').map((l) => JSON.parse(l))
      .filter((r) => r.kind === 'trigger-sent')[0].sequence;
    assert.ok(sentinelHoldSeq < triggerSentSeq, 'the sentinel hold must precede the trigger declaration');
  } finally {
    await rm(fixture.parent, { recursive: true, force: true });
  }
});

test('direct lifecycle driver records settlement-unproven when a disconnect is not propagated', async () => {
  const { runDirectLifecycleProbe } = await loadDirectDriver();
  const fixture = await buildDirectDriverFixture('lifecycle-disconnect-silent');
  try {
    const run = join(fixture.parent, 'run');
    await fsp.mkdir(run, { mode: 0o700 });
    const counters = await runDirectLifecycleProbe({
      codexPath: fixture.codexPath, sourceCodexHome: fixture.sourceHome, runDirectory: run,
      lifecycleObserveWindowMs: 5_000,
      cases: ['connection-close'],
    });
    const phase = counters.phases.lifecycle;
    assert.equal(phase.prerequisites.hostSurvivedConnectionClose, 'survived', 'the host process survived the client disconnect');
    assert.equal(phase.cases['connection-close'], 'settlement-unproven', 'a silent host leaves the held worker unsettled inside the window');
    assert.equal(phase.caseReasons['connection-close'], 'worker-never-settled');
    assert.equal(phase.cleanup, 'released');
  } finally {
    await rm(fixture.parent, { recursive: true, force: true });
  }
});

test('direct lifecycle driver classifies a propagated connection close from durable settlement', async () => {
  const { runDirectLifecycleProbe } = await loadDirectDriver();
  // The fake host exits on client disconnect (its default), which closes the
  // probe server's stdin: the server settles the held worker connection-closed
  // within its bounded grace — the positive control for the case.
  const fixture = await buildDirectDriverFixture('lifecycle-disconnect-propagate');
  try {
    const run = join(fixture.parent, 'run');
    await fsp.mkdir(run, { mode: 0o700 });
    const counters = await runDirectLifecycleProbe({
      codexPath: fixture.codexPath, sourceCodexHome: fixture.sourceHome, runDirectory: run,
      lifecycleObserveWindowMs: 15_000,
      cases: ['connection-close'],
    });
    const phase = counters.phases.lifecycle;
    // The host survives (deterministically verified) and propagates the
    // close: the case window observes the server's durable two-terminal
    // connection-closed settlement.
    assert.equal(phase.prerequisites.hostSurvivedConnectionClose, 'survived');
    assert.equal(phase.cases['connection-close'], 'settlement-observed');
    assert.equal(phase.workerOutcomes['connection-close'], 'connection-closed');
    assert.equal(phase.workerOwned['connection-close'], true);
    assert.equal(phase.cleanup, 'released');
  } finally {
    await rm(fixture.parent, { recursive: true, force: true });
  }
});

test('direct lifecycle driver refuses a destructive case inside a shared selection', async () => {
  const { runDirectLifecycleProbe } = await loadDirectDriver();
  const fixture = await buildDirectDriverFixture('lifecycle-completion');
  try {
    const run = join(fixture.parent, 'run');
    await fsp.mkdir(run, { mode: 0o700 });
    await assert.rejects(
      () => runDirectLifecycleProbe({
        codexPath: fixture.codexPath, sourceCodexHome: fixture.sourceHome, runDirectory: run,
        cases: ['completion', 'host-kill'],
      }),
      /DIRECT_DRIVER_USAGE_INVALID/,
      'a destructive case must run in its own fresh isolated session',
    );
    await assert.rejects(
      () => runDirectLifecycleProbe({
        codexPath: fixture.codexPath, sourceCodexHome: fixture.sourceHome, runDirectory: run,
        cases: ['mystery-trigger'],
      }),
      /DIRECT_DRIVER_USAGE_INVALID/,
      'an unknown trigger fails closed',
    );
  } finally {
    await rm(fixture.parent, { recursive: true, force: true });
  }
});

test('direct lifecycle driver safety deadline case is labeled mechanism-only and settles the held worker', async () => {
  const { runDirectLifecycleProbe } = await loadDirectDriver();
  const fixture = await buildDirectDriverFixture('lifecycle-safety-deadline');
  try {
    const run = join(fixture.parent, 'run');
    await fsp.mkdir(run, { mode: 0o700 });
    const counters = await runDirectLifecycleProbe({
      codexPath: fixture.codexPath, sourceCodexHome: fixture.sourceHome, runDirectory: run,
      lifecycleObserveWindowMs: 20_000,
      cases: ['safety-deadline'],
    });
    const phase = counters.phases.lifecycle;
    assert.equal(phase.mechanismOnlySafetyDeadline, true, 'the injected ceiling is labeled mechanism-only evidence');
    assert.equal(phase.cases['safety-deadline'], 'settlement-observed');
    assert.equal(phase.workerOutcomes['safety-deadline'], 'safety-deadline');
    assert.equal(phase.cleanup, 'released');
  } finally {
    await rm(fixture.parent, { recursive: true, force: true });
  }
});

test('direct lifecycle driver CLI accepts --mode lifecycle and prints only redacted counters', async () => {
  const fixture = await buildDirectDriverFixture('lifecycle-completion');
  try {
    const run = join(fixture.parent, 'run');
    await fsp.mkdir(run, { mode: 0o700 });
    const run2 = join(fixture.parent, 'run-invalid-cases');
    await fsp.mkdir(run2, { mode: 0o700 });
    const result = spawnSync(process.execPath, [
      directDriverModulePath, '--mode', 'lifecycle', '--cases', 'completion',
      '--codex', fixture.codexPath, '--run-directory', run,
    ], { encoding: 'utf8', timeout: 240_000 });
    assert.equal(result.status, 0, `the lifecycle CLI run failed: ${result.stderr}`);
    const counters = JSON.parse(result.stdout);
    assert.equal(counters.mode, 'lifecycle');
    assert.equal(counters.phases.lifecycle.cases.completion, 'settlement-observed');
    // The stdout carries only closed counter values: no path, label, nonce,
    // or raw identifier may cross the CLI boundary.
    assert.equal(result.stdout.includes(fixture.parent), false, 'no fixture path leaks to stdout');
    assert.equal(result.stdout.includes(fixture.codexPath), false, 'no codex path leaks to stdout');
    const invalid = spawnSync(process.execPath, [
      directDriverModulePath, '--mode', 'lifecycle', '--cases', 'mystery',
      '--codex', fixture.codexPath, '--run-directory', run2,
    ], { encoding: 'utf8', timeout: 60_000 });
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /DIRECT_DRIVER_USAGE_INVALID/);
    assert.equal(invalid.stderr.includes(fixture.parent), false, 'no raw path on the failure boundary');
  } finally {
    await rm(fixture.parent, { recursive: true, force: true });
  }
});

test('direct lifecycle a respawned handler adopts the registration of a dead owner', async () => {
  await withDirectProbeRun('zcode-direct-lifecycle-', async (run) => {
    const nonce = directRunNonce();
    const secret = directRunNonce();
    const { hashProbeValue: hash } = await import('../tools/mcp-context-probe/observer.mjs');
    const registrationPath = join(run, 'handler-owner.json');
    const writeRegistration = (pid, digest) => writeFileSync(registrationPath, `${JSON.stringify({ version: 1, runNonce: nonce, pid, secretDigest: digest })}\n`, { mode: 0o600 });
    // The host spawned a handler instance that recorded the run capability
    // and then exited; its stale registration is all that remains.
    writeRegistration(await findDeadProcessPid(), hash(nonce, secret));
    // A respawned instance holding the SAME run capability must adopt the
    // registration of the dead owner and serve — not fail with
    // PROBE_OWNER_CONFLICT, which is what made the host's call-time restart
    // fail its initialize handshake.
    const respawned = createDirectProbeServer({ observer: { runDirectory: run, runNonce: nonce, phase: 'lifecycle' }, ownerSecret: secret });
    await respawned.probeDirectAppend({ kind: 'server-started', serverInstanceHash: directHash('respawned-instance') });
    const records = await readDirectProbeEvents({ runDirectory: run, runNonce: nonce });
    assert.equal(records.some((record) => record.kind === 'server-started'), true, 'the adopted handler can append durable evidence');
    // A LIVE owner with the same capability still conflicts: adoption never
    // takes over a running handler.
    const liveChild = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
    try {
      await new Promise((resolve) => setTimeout(resolve, 150));
      writeRegistration(liveChild.pid, hash(nonce, secret));
      assert.throws(() => createDirectProbeServer({ observer: { runDirectory: run, runNonce: nonce, phase: 'lifecycle' }, ownerSecret: secret }), /PROBE_OWNER_CONFLICT/, 'a live owner is never adopted over');
      // A DIFFERENT capability (any state) still conflicts.
      writeRegistration(await findDeadProcessPid(), directHash('other-secret'));
      assert.throws(() => createDirectProbeServer({ observer: { runDirectory: run, runNonce: nonce, phase: 'lifecycle' }, ownerSecret: secret }), /PROBE_OWNER_CONFLICT/, 'a foreign capability is never adopted');
    } finally {
      liveChild.kill('SIGKILL');
    }
  });
});

/** Finds a pid that is currently not alive (never the test process). */
async function findDeadProcessPid() {
  for (let candidate = 100_000; candidate < 2 ** 31; candidate += 7919) {
    try {
      process.kill(candidate, 0);
    } catch (error) {
      if (/** @type {any} */ (error).code === 'ESRCH') return candidate;
    }
  }
  throw new Error('no dead pid found');
}

// Self-review round (commit dfa75e8 findings): regressions first.

test('direct lifecycle a failed sentinel dispatch is a contradiction, never dropped', async () => {
  const { classifyDirectLifecycleCase } = await import('../tools/direct-mcp-probe/lifecycle.mjs');
  await withDirectProbeRun('zcode-direct-lifecycle-', async (run) => {
    const nonce = directRunNonce();
    const { label } = await buildDirectLifecycleTranscript(run, {
      nonce,
      triggerSent: 'config-timeout',
      triggerObserved: 'acknowledged',
      handlerOutcome: 'completed',
      workerOutcome: 'completed',
      rpcOutcome: 'success-result',
    });
    const { records, reduced } = await reduceDirectRun(run, nonce);
    // The per-call trigger landed and the case settled — but the sentinel
    // dispatch itself failed. The case may not quietly classify
    // settlement-observed with an invisible sentinel: an undispatched
    // sentinel is a contradiction under its command expectation.
    const verdict = classifyDirectLifecycleCase({
      records, reduced, probeLabel: label, phase: 'lifecycle', command: 'execution-foreground', trigger: 'config-timeout',
      sentinelLabel: directLabel(), sentinelDispatchFailed: true,
    });
    assert.equal(verdict.classification, 'expectation-mismatch');
    assert.equal(verdict.reasonCode, 'sentinel-undispatched');
  });
});

test('direct lifecycle case window keeps a later case from relabeling an earlier one', async () => {
  const { classifyDirectLifecycleCase } = await import('../tools/direct-mcp-probe/lifecycle.mjs');
  await withDirectProbeRun('zcode-direct-lifecycle-', async (run) => {
    const nonce = directRunNonce();
    // Case A settles completed under a per-call trigger; a LATER case B
    // settles cancelled in the same run. Bounded to its own window, case A's
    // sentinel lookup cannot see case B's records, so B cannot relabel A;
    // unbounded, the same sentinel attribution would read case B's
    // cancellation as overly broad — the window is load-bearing.
    const { label: labelA } = await buildDirectLifecycleTranscript(run, {
      nonce,
      triggerSent: 'config-timeout',
      triggerObserved: 'acknowledged',
      handlerOutcome: 'cancelled',
      workerOutcome: 'cancelled',
      rpcOutcome: 'error-result',
    });
    const windowEnd = (await readDirectProbeEvents({ runDirectory: run, runNonce: nonce })).length;
    const { label: labelB } = await buildDirectLifecycleTranscript(run, {
      nonce,
      handlerOutcome: 'cancelled',
      workerOutcome: 'cancelled',
      rpcOutcome: 'error-result',
    });
    const { records, reduced } = await reduceDirectRun(run, nonce);
    const bounded = classifyDirectLifecycleCase({
      records, reduced, probeLabel: labelA, phase: 'lifecycle', command: 'execution-foreground', trigger: 'config-timeout',
      sentinelLabel: labelB, windowStart: 0, windowEnd,
    });
    // Within case A's window the sentinel has joined but never settled: the
    // stricter sentinel rule records that honestly as unproven — and case B's
    // cancellation can neither survive nor catch case A from outside the
    // window.
    assert.equal(bounded.classification, 'settlement-unproven', 'the later case lies outside the window and cannot settle this one');
    assert.equal(bounded.reasonCode, 'sentinel-never-settled');
    assert.equal(bounded.sentinelClassification, 'unproven', 'the sentinel attribution is bounded to the case window');
    for (const ref of bounded.evidenceRefs) {
      const sequence = Number(ref.split('@')[1]);
      assert.ok(sequence < windowEnd, `evidence ref ${ref} lies outside the case window`);
    }
    const unbounded = classifyDirectLifecycleCase({
      records, reduced, probeLabel: labelA, phase: 'lifecycle', command: 'execution-foreground', trigger: 'config-timeout',
      sentinelLabel: labelB,
    });
    assert.equal(unbounded.sentinelClassification, 'unproven', 'without the window the later case reaches the verdict');
    assert.equal(unbounded.reasonCode, 'sentinel-ordering-unprovable', 'the window changed the verdict specificity, proving it is load-bearing');
    assert.equal(unbounded.classification, 'settlement-unproven');
  });
});

test('direct lifecycle a per-call case without an established sentinel is unproven', async () => {
  const { classifyDirectLifecycleCase } = await import('../tools/direct-mcp-probe/lifecycle.mjs');
  await withDirectProbeRun('zcode-direct-lifecycle-', async (run) => {
    const nonce = directRunNonce();
    const { label } = await buildDirectLifecycleTranscript(run, {
      nonce,
      triggerSent: 'config-timeout',
      triggerObserved: 'acknowledged',
      handlerOutcome: 'cancelled',
      workerOutcome: 'cancelled',
      rpcOutcome: 'error-result',
    });
    const { records, reduced } = await reduceDirectRun(run, nonce);
    // No sentinel label at all: the per-call isolation check cannot run, so
    // the case is unproven — never settlement-observed.
    const verdict = classifyDirectLifecycleCase({
      records, reduced, probeLabel: label, phase: 'lifecycle', command: 'execution-foreground', trigger: 'config-timeout',
    });
    assert.equal(verdict.classification, 'settlement-unproven');
    assert.equal(verdict.reasonCode, 'sentinel-missing');
  });
});

test('direct lifecycle driver flags a sentinel the host refuses after the trigger', async () => {
  const { runDirectLifecycleProbe } = await loadDirectDriver();
  const fixture = await buildDirectDriverFixture('lifecycle-refuses-after-trigger');
  try {
    const run = join(fixture.parent, 'run');
    await fsp.mkdir(run, { mode: 0o700 });
    const counters = await runDirectLifecycleProbe({
      codexPath: fixture.codexPath, sourceCodexHome: fixture.sourceHome, runDirectory: run,
      lifecycleObserveWindowMs: 5_000,
      cases: ['config-timeout'],
    });
    const phase = counters.phases.lifecycle;
    // The refused sentinel never durably joined, so the isolation check
    // cannot run: the case is honestly unproven.
    assert.equal(phase.cases['config-timeout'], 'settlement-unproven', 'a per-call case without a joined sentinel is never settlement-observed');
    assert.equal(phase.caseReasons['config-timeout'], 'sentinel-missing');
    assert.equal(phase.gateG3.status, 'not-proven');
    assert.equal(phase.cleanup, 'released');
  } finally {
    await rm(fixture.parent, { recursive: true, force: true });
  }
});

test('direct lifecycle driver records signal-unverified when the host dies before the trigger', async () => {
  const { runDirectLifecycleProbe } = await loadDirectDriver();
  const fixture = await buildDirectDriverFixture('lifecycle-host-dies-before-trigger');
  try {
    const run = join(fixture.parent, 'run');
    await fsp.mkdir(run, { mode: 0o700 });
    const counters = await runDirectLifecycleProbe({
      codexPath: fixture.codexPath, sourceCodexHome: fixture.sourceHome, runDirectory: run,
      lifecycleObserveWindowMs: 15_000,
      cases: ['host-stop'],
    });
    const phase = counters.phases.lifecycle;
    // The hold started durably (the dispatch reached the handler), but the
    // owning host was gone before the trigger: the signal cannot be verified
    // as delivered, so the case records the not-sent-style prerequisite.
    assert.equal(phase.prerequisites.holdStartedSeen, true);
    assert.equal(phase.cases['host-stop'], 'not-sent', 'an unverifiable host signal never proceeds into observation');
    assert.equal(phase.caseReasons['host-stop'], 'signal-unverified');
    assert.equal(phase.gateG3.status, 'not-proven');
    assert.equal(phase.gateG3.reasonCode, 'host-signal-unverified');
    assert.equal(phase.cleanup, 'released');
  } finally {
    await rm(fixture.parent, { recursive: true, force: true });
  }
});

// Codex gate review round (Task 5): regressions first.

test('direct lifecycle an unsettled sentinel is unproven, never survived', async () => {
  const { classifyDirectLifecycleCase } = await import('../tools/direct-mcp-probe/lifecycle.mjs');
  await withDirectProbeRun('zcode-direct-lifecycle-', async (run) => {
    const nonce = directRunNonce();
    // The target settled cancelled under the per-call timeout trigger; the
    // sentinel JOINED (handler entry, hold) but never settled within the
    // case window — a timed-out sentinel RPC can still report a joined call.
    const sentinel = { label: directLabel(), callNonce: directCallNonce() };
    const { label, sentinel: joinedSentinel } = await buildDirectLifecycleTranscript(run, {
      nonce,
      triggerSent: 'config-timeout',
      triggerObserved: 'acknowledged',
      handlerOutcome: 'cancelled',
      workerOutcome: 'cancelled',
      rpcOutcome: 'error-result',
      sentinel,
    });
    const { records, reduced } = await reduceDirectRun(run, nonce);
    const verdict = classifyDirectLifecycleCase({
      records, reduced, probeLabel: label, phase: 'lifecycle', command: 'execution-foreground', trigger: 'config-timeout',
      sentinelLabel: joinedSentinel.label,
    });
    assert.equal(verdict.sentinelClassification, 'unproven', 'a joined sentinel without a durable settlement is unproven');
    assert.equal(verdict.classification, 'settlement-unproven', 'the per-call isolation check cannot pass on an unsettled sentinel');
    assert.equal(verdict.reasonCode, 'sentinel-never-settled');
  });
});

test('direct lifecycle settlement requires both joined terminals with consistent outcomes', async () => {
  const { classifyDirectLifecycleCase } = await import('../tools/direct-mcp-probe/lifecycle.mjs');
  await withDirectProbeRun('zcode-direct-lifecycle-', async (run) => {
    const nonce = directRunNonce();
    // Partial settlement: the worker terminal exists without any durable
    // handler outcome — never a demonstrated settlement.
    const { label: partialLabel } = await buildDirectLifecycleTranscript(run, {
      nonce,
      handlerOutcome: null,
      workerOutcome: 'completed',
      rpcOutcome: 'success-result',
    });
    // Inconsistent terminals: the two durable outcomes disagree.
    const { label: inconsistentLabel } = await buildDirectLifecycleTranscript(run, {
      nonce,
      handlerOutcome: 'completed',
      workerOutcome: 'cancelled',
      rpcOutcome: 'success-result',
    });
    const { records, reduced } = await reduceDirectRun(run, nonce);
    const partial = classifyDirectLifecycleCase({
      records, reduced, probeLabel: partialLabel, phase: 'lifecycle', command: 'execution-foreground', trigger: 'completion',
    });
    assert.equal(partial.classification, 'settlement-unproven', 'a worker terminal alone is a partial settlement');
    assert.equal(partial.reasonCode, 'handler-terminal-missing');
    const inconsistent = classifyDirectLifecycleCase({
      records, reduced, probeLabel: inconsistentLabel, phase: 'lifecycle', command: 'execution-foreground', trigger: 'completion',
    });
    assert.equal(inconsistent.classification, 'settlement-unproven', 'disagreeing terminals do not demonstrate one settlement');
    assert.equal(inconsistent.reasonCode, 'inconsistent-terminals');
  });
});

test('direct lifecycle a race without an observed cancellation boundary is unproven', async () => {
  const { classifyDirectLifecycleCase } = await import('../tools/direct-mcp-probe/lifecycle.mjs');
  await withDirectProbeRun('zcode-direct-lifecycle-', async (run) => {
    const nonce = directRunNonce();
    // The worker completed and the RPC answered successfully: nothing
    // durable shows a cancellation was ever in play, so this is not a
    // demonstrated completion-versus-cancellation race.
    const boundarySentinel = { label: directLabel(), callNonce: directCallNonce(), workerOutcome: 'completed' };
    const { label } = await buildDirectLifecycleTranscript(run, {
      nonce,
      triggerSent: 'config-timeout',
      triggerObserved: 'acknowledged',
      handlerOutcome: 'completed',
      workerOutcome: 'completed',
      rpcOutcome: 'success-result',
      sentinel: boundarySentinel,
    });
    const { records, reduced } = await reduceDirectRun(run, nonce);
    const unproven = classifyDirectLifecycleCase({
      records, reduced, probeLabel: label, phase: 'lifecycle', command: 'execution-foreground', trigger: 'cancel-race',
      sentinelLabel: boundarySentinel.label,
    });
    assert.equal(unproven.classification, 'settlement-unproven');
    assert.equal(unproven.reasonCode, 'cancellation-boundary-unobserved');
    // Positive control: durable cancellation evidence (the RPC observed the
    // host acting, or the worker settled by a cancellation outcome) admits
    // the race classification.
    const raceSentinel = { label: directLabel(), callNonce: directCallNonce(), workerOutcome: 'completed' };
    const cancelled = await buildDirectLifecycleTranscript(run, {
      nonce,
      triggerSent: 'config-timeout',
      triggerObserved: 'acknowledged',
      handlerOutcome: 'cancelled',
      workerOutcome: 'cancelled',
      rpcOutcome: 'error-result',
      sentinel: raceSentinel,
      sentinelSpanningBoundary: true,
    });
    const second = await reduceDirectRun(run, nonce);
    const observed = classifyDirectLifecycleCase({
      records: second.records, reduced: second.reduced, probeLabel: cancelled.label, phase: 'lifecycle',
      command: 'execution-foreground', trigger: 'cancel-race', cancellationObserved: true,
      sentinelLabel: raceSentinel.label,
    });
    // Even a perfectly ordered cancel-race transcript cannot claim isolation:
    // the timeout decision is host-internal and durably unorderable.
    assert.equal(observed.classification, 'settlement-unproven');
    assert.equal(observed.reasonCode, 'sentinel-ordering-unprovable');
    assert.equal(observed.workerOutcome, 'cancelled');
  });
});

test('direct lifecycle both sentinel terminals must postdate the cancellation boundary', async () => {
  const { classifyDirectLifecycleCase } = await import('../tools/direct-mcp-probe/lifecycle.mjs');
  await withDirectProbeRun('zcode-direct-lifecycle-', async (run) => {
    const nonce = directRunNonce();
    // DELAYED-LOG-WRITE shape: the sentinel's handler-settled commits BEFORE
    // the target's cancellation settlement (the boundary marker), and its
    // worker-settled commits afterward — the sentinel had already finished
    // when the cancellation acted, so the straddling worker record alone
    // must never forge per-call isolation.
    const sentinel = { label: directLabel(), callNonce: directCallNonce(), workerOutcome: 'completed', handlerEarly: true };
    const { label } = await buildDirectLifecycleTranscript(run, {
      nonce,
      triggerSent: 'turn-interrupt',
      triggerObserved: 'acknowledged',
      handlerOutcome: 'cancelled',
      workerOutcome: 'cancelled',
      rpcOutcome: 'error-result',
      sentinel,
      sentinelSpanningBoundary: true,
    });
    const { records, reduced } = await reduceDirectRun(run, nonce);
    const verdict = classifyDirectLifecycleCase({
      records, reduced, probeLabel: label, phase: 'lifecycle', command: 'execution-foreground', trigger: 'turn-interrupt',
      exactTurnConfirmed: true, sentinelLabel: sentinel.label,
    });
    assert.equal(verdict.sentinelClassification, 'unproven', 'a straddling worker terminal with an expired handler terminal proves nothing');
    assert.equal(verdict.classification, 'settlement-unproven');
    assert.equal(verdict.reasonCode, 'sentinel-handler-expired-before-boundary');
  });
});

test('direct lifecycle case reasons are closed across the classifier and the driver emissions', async () => {
  const lifecycle = await import('../tools/direct-mcp-probe/lifecycle.mjs');
  assert.deepEqual([...lifecycle.DIRECT_LIFECYCLE_DRIVER_REASON_CODES], ['signal-unverified', 'host-lost-during-close']);
  assert.ok(Object.isFrozen(lifecycle.DIRECT_LIFECYCLE_DRIVER_REASON_CODES), 'the driver-emitted reason set is frozen');
  // Scan the driver source for every reason it can write into the redacted
  // caseReasons output; each must belong to a closed enumeration.
  const driverSource = readFileSync(directDriverModulePath, 'utf8');
  const written = [...driverSource.matchAll(/caseReasons\[[^\]]*\] = '([a-z][a-z0-9-]*)'/g)].map((match) => match[1]);
  assert.ok(written.includes('signal-unverified'), 'the scan sees the signal gate');
  assert.ok(written.includes('host-lost-during-close'), 'the scan sees the close gate');
  assert.ok(written.includes('turn-not-confirmed'), 'the scan sees the turn gate');
  const enumerated = new Set([...lifecycle.DIRECT_LIFECYCLE_REASON_CODES, ...lifecycle.DIRECT_LIFECYCLE_DRIVER_REASON_CODES]);
  for (const code of written) {
    assert.ok(enumerated.has(code), `caseReasons value ${code} is outside every closed enumeration`);
  }
});

test('direct lifecycle driver excludes host loss during the close from the surviving-host case', async () => {
  const { runDirectLifecycleProbe } = await loadDirectDriver();
  const fixture = await buildDirectDriverFixture('lifecycle-host-exits-before-close');
  try {
    const run = join(fixture.parent, 'run');
    await fsp.mkdir(run, { mode: 0o700 });
    const counters = await runDirectLifecycleProbe({
      codexPath: fixture.codexPath, sourceCodexHome: fixture.sourceHome, runDirectory: run,
      lifecycleObserveWindowMs: 15_000,
      cases: ['connection-close'],
    });
    const phase = counters.phases.lifecycle;
    assert.equal(phase.prerequisites.holdStartedSeen, true, 'the durable hold existed before the close');
    assert.equal(phase.prerequisites.hostSurvivedConnectionClose, 'not-survived', 'the host was verifiably gone during the close');
    assert.equal(phase.cases['connection-close'], 'settlement-unproven', 'host loss during the close is never the surviving-host result');
    assert.equal(phase.caseReasons['connection-close'], 'host-lost-during-close');
    // The durable trail must not claim the close was acknowledged when no
    // host survived to observe it: the closed trigger-observed vocabulary
    // carries 'not-observed' for exactly this.
    const rawLog = await readFile(join(run, 'events.jsonl'), 'utf8');
    const triggerObserved = rawLog.trim().split('\n').map((line) => JSON.parse(line)).filter((record) => record.kind === 'trigger-observed');
    assert.equal(triggerObserved.length, 1, 'exactly one trigger observation is durable');
    assert.equal(triggerObserved[0].outcome, 'not-observed', 'an unobserved close is recorded not-observed, never acknowledged');
    assert.equal(phase.gateG3.status, 'not-proven');
    assert.equal(phase.cleanup, 'released');
  } finally {
    await rm(fixture.parent, { recursive: true, force: true });
  }
});

test('direct lifecycle driver records an unobserved cancellation boundary for the race case', async () => {
  const { runDirectLifecycleProbe } = await loadDirectDriver();
  const fixture = await buildDirectDriverFixture('lifecycle-completion');
  try {
    const run = join(fixture.parent, 'run');
    await fsp.mkdir(run, { mode: 0o700 });
    const counters = await runDirectLifecycleProbe({
      codexPath: fixture.codexPath, sourceCodexHome: fixture.sourceHome, runDirectory: run,
      lifecycleObserveWindowMs: 20_000,
      cases: ['cancel-race'],
    });
    const phase = counters.phases.lifecycle;
    // The fake host has no cancellation side: the worker completes with a
    // successful RPC and nothing durable shows cancellation in play, so the
    // race prerequisite is honestly unproven.
    assert.equal(phase.cases['cancel-race'], 'settlement-unproven');
    assert.equal(phase.caseReasons['cancel-race'], 'cancellation-boundary-unobserved');
    assert.equal(phase.cancellationObserved['cancel-race'], false);
    assert.equal(phase.gateG3.status, 'not-proven');
    assert.equal(phase.cleanup, 'released');
  } finally {
    await rm(fixture.parent, { recursive: true, force: true });
  }
});

test('direct lifecycle driver establishes the sentinel before the trigger so broad cancellation is caught', async () => {
  const { runDirectLifecycleProbe } = await loadDirectDriver();
  const fixture = await buildDirectDriverFixture('lifecycle-cancels-everything');
  try {
    const run = join(fixture.parent, 'run');
    await fsp.mkdir(run, { mode: 0o700 });
    const counters = await runDirectLifecycleProbe({
      codexPath: fixture.codexPath, sourceCodexHome: fixture.sourceHome, runDirectory: run,
      lifecycleObserveWindowMs: 20_000,
      cases: ['config-timeout'],
    });
    const phase = counters.phases.lifecycle;
    // The fake host cancels every call active at trigger time. The sentinel
    // hold was durably established BEFORE the trigger, so it settles
    // cancelled too and the broad cancellation is caught — it can never
    // masquerade as isolated cancellation of the target.
    assert.equal(phase.prerequisites.holdStartedSeen, true);
    // The timeout boundary is host-internal: even a broad cancellation
    // caught by the sentinel cannot be durably ordered against the
    // decision, so the case is honestly unproven.
    assert.equal(phase.cases['config-timeout'], 'settlement-unproven');
    assert.equal(phase.caseReasons['config-timeout'], 'sentinel-ordering-unprovable');
    assert.equal(phase.gateG3.status, 'not-proven');
    assert.equal(phase.cleanup, 'released');
  } finally {
    await rm(fixture.parent, { recursive: true, force: true });
  }
});

test('direct lifecycle driver never lets a generic RPC error forge the race boundary', async () => {
  const { runDirectLifecycleProbe } = await loadDirectDriver();
  const fixture = await buildDirectDriverFixture('lifecycle-race-generic-error');
  try {
    const run = join(fixture.parent, 'run');
    await fsp.mkdir(run, { mode: 0o700 });
    const counters = await runDirectLifecycleProbe({
      codexPath: fixture.codexPath, sourceCodexHome: fixture.sourceHome, runDirectory: run,
      lifecycleObserveWindowMs: 30_000,
      cases: ['cancel-race'],
    });
    const phase = counters.phases.lifecycle;
    // The worker completed on its own and the driver saw a GENERIC host
    // error: that is not cancellation evidence, so the boundary is honestly
    // unobserved and the race stays unproven.
    assert.equal(phase.cancellationObserved['cancel-race'], false, 'a generic RPC error is not cancellation evidence');
    assert.equal(phase.cases['cancel-race'], 'settlement-unproven');
    assert.equal(phase.caseReasons['cancel-race'], 'cancellation-boundary-unobserved');
    assert.equal(phase.gateG3.status, 'not-proven');
    assert.equal(phase.cleanup, 'released');
  } finally {
    await rm(fixture.parent, { recursive: true, force: true });
  }
});

test('direct lifecycle a sentinel that expires before the cancellation boundary is unproven', async () => {
  const { classifyDirectLifecycleCase } = await import('../tools/direct-mcp-probe/lifecycle.mjs');
  await withDirectProbeRun('zcode-direct-lifecycle-', async (run) => {
    const nonce = directRunNonce();
    // The sentinel's completed settlement is durable BEFORE the target's
    // cancellation settlement: at the boundary moment the sentinel was
    // already finished, so its completion cannot prove per-call isolation.
    const sentinel = { label: directLabel(), callNonce: directCallNonce(), workerOutcome: 'completed' };
    const { label } = await buildDirectLifecycleTranscript(run, {
      nonce,
      triggerSent: 'config-timeout',
      triggerObserved: 'acknowledged',
      handlerOutcome: 'cancelled',
      workerOutcome: 'cancelled',
      rpcOutcome: 'error-result',
      sentinel,
      sentinelSettledBeforeTarget: true,
    });
    const { records, reduced } = await reduceDirectRun(run, nonce);
    const verdict = classifyDirectLifecycleCase({
      records, reduced, probeLabel: label, phase: 'lifecycle', command: 'execution-foreground', trigger: 'config-timeout',
      sentinelLabel: sentinel.label,
    });
    assert.equal(verdict.sentinelClassification, 'unproven');
    assert.equal(verdict.classification, 'settlement-unproven');
    assert.equal(verdict.reasonCode, 'sentinel-ordering-unprovable', 'a host-internal timeout boundary cannot order the sentinel against the decision');
    // Control: even the DRIVER-ORDERED release chain (the release marker
    // following the boundary) cannot upgrade a sentinel that settled by its
    // OWN watchdog — a self-completed terminal proves nothing about
    // isolation, whatever the orderings show.
    const after = await buildDirectLifecycleTranscript(run, {
      nonce,
      triggerSent: 'turn-interrupt',
      triggerObserved: 'acknowledged',
      handlerOutcome: 'cancelled',
      workerOutcome: 'cancelled',
      rpcOutcome: 'error-result',
      sentinel: { label: directLabel(), callNonce: directCallNonce(), workerOutcome: 'completed' },
      sentinelSpanningBoundary: true,
      sentinelDriverRelease: true,
    });
    const second = await reduceDirectRun(run, nonce);
    const survived = classifyDirectLifecycleCase({
      records: second.records, reduced: second.reduced, probeLabel: after.label, phase: 'lifecycle',
      command: 'execution-foreground', trigger: 'turn-interrupt', exactTurnConfirmed: true, sentinelLabel: after.sentinel.label,
    });
    assert.equal(survived.sentinelClassification, 'unproven', 'a self-completed sentinel proves nothing even under the verified release chain');
    assert.equal(survived.classification, 'settlement-unproven');
    assert.equal(survived.reasonCode, 'sentinel-watchdog-unprovable');
  });
});

test('direct lifecycle a sentinel that starts after the boundary settlement is unproven', async () => {
  const { classifyDirectLifecycleCase } = await import('../tools/direct-mcp-probe/lifecycle.mjs');
  await withDirectProbeRun('zcode-direct-lifecycle-', async (run) => {
    const nonce = directRunNonce();
    // The target's cancellation settlement (the boundary marker) is durable
    // BEFORE the sentinel even joins: the sentinel never spanned the
    // boundary, so survival must be refused however clean its later
    // completion looks.
    const sentinel = { label: directLabel(), callNonce: directCallNonce(), workerOutcome: 'completed' };
    const { label } = await buildDirectLifecycleTranscript(run, {
      nonce,
      triggerSent: 'config-timeout',
      triggerObserved: 'acknowledged',
      handlerOutcome: 'cancelled',
      workerOutcome: 'cancelled',
      rpcOutcome: 'error-result',
      sentinel,
      sentinelJoinedAfterTargetSettlement: true,
    });
    const { records, reduced } = await reduceDirectRun(run, nonce);
    const verdict = classifyDirectLifecycleCase({
      records, reduced, probeLabel: label, phase: 'lifecycle', command: 'execution-foreground', trigger: 'config-timeout',
      sentinelLabel: sentinel.label,
    });
    assert.equal(verdict.sentinelClassification, 'unproven');
    assert.equal(verdict.classification, 'settlement-unproven');
    assert.equal(verdict.reasonCode, 'sentinel-ordering-unprovable', 'a host-internal timeout boundary cannot order the sentinel against the decision');
  });
});

test('direct lifecycle driver flags a slow sentinel that starts after the timeout boundary', async () => {
  const { runDirectLifecycleProbe } = await loadDirectDriver();
  const fixture = await buildDirectDriverFixture('lifecycle-slow-sentinel');
  try {
    const run = join(fixture.parent, 'run');
    await fsp.mkdir(run, { mode: 0o700 });
    const counters = await runDirectLifecycleProbe({
      codexPath: fixture.codexPath, sourceCodexHome: fixture.sourceHome, runDirectory: run,
      lifecycleObserveWindowMs: 30_000,
      cases: ['config-timeout'],
    });
    const phase = counters.phases.lifecycle;
    // The fake host cancels ONLY the target at the 8-second timeout boundary
    // and forwards the sentinel dispatch only after the boundary settlement
    // is durable: the sentinel started after the boundary, so the case can
    // never claim the sentinel survived it.
    assert.equal(phase.prerequisites.holdStartedSeen, true);
    // The delayed sentinel forwarding also makes the driver's own trigger
    // declaration land AFTER the durable target settlement: the journal
    // cannot prove the settlement followed the declared action at all, so
    // the case is honestly unproven on the window gap.
    assert.equal(phase.cases['config-timeout'], 'settlement-unproven', 'a sentinel that started after the boundary never spans it');
    assert.equal(phase.caseReasons['config-timeout'], 'settlement-before-trigger');
    assert.equal(phase.gateG3.status, 'not-proven');
    assert.equal(phase.cleanup, 'released');
  } finally {
    await rm(fixture.parent, { recursive: true, force: true });
  }
});

test('direct lifecycle a host-internal cancellation boundary cannot prove sentinel isolation', async () => {
  const { classifyDirectLifecycleCase } = await import('../tools/direct-mcp-probe/lifecycle.mjs');
  await withDirectProbeRun('zcode-direct-lifecycle-', async (run) => {
    const nonce = directRunNonce();
    // Every journal ordering satisfied: the sentinel joined before the
    // target's cancellation settlement and completed after it. The timeout
    // decision itself happens INSIDE the host — no journal ordering can
    // prove the sentinel was held at the decision instant.
    const sentinel = { label: directLabel(), callNonce: directCallNonce(), workerOutcome: 'completed' };
    const { label } = await buildDirectLifecycleTranscript(run, {
      nonce,
      triggerSent: 'config-timeout',
      triggerObserved: 'acknowledged',
      handlerOutcome: 'cancelled',
      workerOutcome: 'cancelled',
      rpcOutcome: 'error-result',
      sentinel,
      sentinelSpanningBoundary: true,
    });
    const { records, reduced } = await reduceDirectRun(run, nonce);
    const verdict = classifyDirectLifecycleCase({
      records, reduced, probeLabel: label, phase: 'lifecycle', command: 'execution-foreground', trigger: 'config-timeout',
      sentinelLabel: sentinel.label,
    });
    assert.equal(verdict.sentinelClassification, 'unproven');
    assert.equal(verdict.classification, 'settlement-unproven');
    assert.equal(verdict.reasonCode, 'sentinel-ordering-unprovable');
  });
});

test('direct lifecycle driver cancels the boundary-spanning sentinel at the timeout boundary', async () => {
  const { runDirectLifecycleProbe } = await loadDirectDriver();
  const fixture = await buildDirectDriverFixture('lifecycle-cancels-at-timeout');
  try {
    const run = join(fixture.parent, 'run');
    await fsp.mkdir(run, { mode: 0o700 });
    const counters = await runDirectLifecycleProbe({
      codexPath: fixture.codexPath, sourceCodexHome: fixture.sourceHome, runDirectory: run,
      lifecycleObserveWindowMs: 30_000,
      cases: ['config-timeout'],
    });
    const phase = counters.phases.lifecycle;
    // The fake host broadly cancels every active call when the configured
    // 8-second timeout boundary fires (the target's durable cancellation
    // settlement is the boundary marker). The sentinel — held longer than
    // the timeout because it was established before the trigger — is active
    // at that moment and MUST be caught; a sentinel that had already
    // completed would prove nothing.
    assert.equal(phase.prerequisites.holdStartedSeen, true);
    // The boundary was host-internal: isolation is durably unorderable, so
    // the case is unproven even though the sentinel was caught by the broad
    // cancellation.
    assert.equal(phase.cases['config-timeout'], 'settlement-unproven');
    assert.equal(phase.caseReasons['config-timeout'], 'sentinel-ordering-unprovable');
    assert.equal(phase.gateG3.status, 'not-proven');
    assert.equal(phase.cleanup, 'released');
  } finally {
    await rm(fixture.parent, { recursive: true, force: true });
  }
});

test('direct lifecycle a sentinel that starts after the trigger declaration is inverted', async () => {
  const { classifyDirectLifecycleCase } = await import('../tools/direct-mcp-probe/lifecycle.mjs');
  await withDirectProbeRun('zcode-direct-lifecycle-', async (run) => {
    const nonce = directRunNonce();
    // INVERTED journal: the driver declared the trigger (trigger-sent)
    // BEFORE the sentinel ever joined — the action occurred before the
    // sentinel entry, so the later-completing hold proves nothing.
    const sentinel = { label: directLabel(), callNonce: directCallNonce(), workerOutcome: 'completed' };
    const { label } = await buildDirectLifecycleTranscript(run, {
      nonce,
      triggerSent: 'turn-interrupt',
      triggerObserved: 'acknowledged',
      handlerOutcome: 'cancelled',
      workerOutcome: 'cancelled',
      rpcOutcome: 'error-result',
      sentinel,
    });
    const { records, reduced } = await reduceDirectRun(run, nonce);
    const verdict = classifyDirectLifecycleCase({
      records, reduced, probeLabel: label, phase: 'lifecycle', command: 'execution-foreground', trigger: 'turn-interrupt',
      exactTurnConfirmed: true, sentinelLabel: sentinel.label,
    });
    assert.equal(verdict.classification, 'settlement-unproven');
    // The sentinel's hold began AFTER the driver had already declared the
    // trigger — the isolation ordering is inverted (the sentinel cannot
    // prove it was held ahead of the action), recorded on the unproven
    // path, never as survived isolation.
    assert.equal(verdict.reasonCode, 'sentinel-ordering-inverted');
  });
});

test('direct lifecycle the real driver order alone cannot prove a self-completed sentinel', async () => {
  const { classifyDirectLifecycleCase } = await import('../tools/direct-mcp-probe/lifecycle.mjs');
  await withDirectProbeRun('zcode-direct-lifecycle-', async (run) => {
    const nonce = directRunNonce();
    // The REAL driver schedule, durably ordered: sentinel hold-started
    // precedes the driver's trigger-sent, which precedes the target's
    // cancellation settlement (the boundary), and the sentinel completes
    // after it — every ordering holds, and the case is STILL unproven: the
    // completion decision was the probe server's internal watchdog, which
    // is durably unorderable against the host's cancellation action. Only
    // the driver-ordered release with a CANCELLED settlement proves
    // isolation.
    const sentinel = { label: directLabel(), callNonce: directCallNonce(), workerOutcome: 'completed' };
    const { label } = await buildDirectLifecycleTranscript(run, {
      nonce,
      triggerSent: 'turn-interrupt',
      triggerObserved: 'acknowledged',
      handlerOutcome: 'cancelled',
      workerOutcome: 'cancelled',
      rpcOutcome: 'error-result',
      sentinel,
      sentinelJoinBeforeTrigger: true,
      sentinelDriverRelease: true,
    });
    const { records, reduced } = await reduceDirectRun(run, nonce);
    const verdict = classifyDirectLifecycleCase({
      records, reduced, probeLabel: label, phase: 'lifecycle', command: 'execution-foreground', trigger: 'turn-interrupt',
      exactTurnConfirmed: true, sentinelLabel: sentinel.label,
    });
    assert.equal(verdict.classification, 'settlement-unproven', 'the real driver order alone cannot prove a self-completed sentinel');
    assert.equal(verdict.reasonCode, 'sentinel-watchdog-unprovable');
  });
});

test('direct lifecycle a target settled before the trigger declaration cannot claim isolation', async () => {
  const { classifyDirectLifecycleCase } = await import('../tools/direct-mcp-probe/lifecycle.mjs');
  await withDirectProbeRun('zcode-direct-lifecycle-', async (run) => {
    const nonce = directRunNonce();
    // WINDOW B (the gap): the sentinel hold-started precedes the target's
    // cancellation settlement, which precedes the driver's trigger-sent —
    // the target was cancelled independently BEFORE the driver ever fired
    // turn/interrupt, so the apparent span proves no isolation.
    const sentinel = { label: directLabel(), callNonce: directCallNonce(), workerOutcome: 'completed' };
    const { label } = await buildDirectLifecycleTranscript(run, {
      nonce,
      triggerSent: 'turn-interrupt',
      triggerObserved: 'acknowledged',
      handlerOutcome: 'cancelled',
      workerOutcome: 'cancelled',
      rpcOutcome: 'error-result',
      sentinel,
      triggerAfterSettlement: true,
    });
    const { records, reduced } = await reduceDirectRun(run, nonce);
    const verdict = classifyDirectLifecycleCase({
      records, reduced, probeLabel: label, phase: 'lifecycle', command: 'execution-foreground', trigger: 'turn-interrupt',
      exactTurnConfirmed: true, sentinelLabel: sentinel.label,
    });
    assert.equal(verdict.classification, 'settlement-unproven');
    assert.equal(verdict.reasonCode, 'settlement-before-trigger');
  });
});

test('direct lifecycle a sentinel joined after the trigger declaration is refused', async () => {
  const { classifyDirectLifecycleCase } = await import('../tools/direct-mcp-probe/lifecycle.mjs');
  await withDirectProbeRun('zcode-direct-lifecycle-', async (run) => {
    const nonce = directRunNonce();
    // WINDOW A: the driver declared the trigger BEFORE the sentinel joined;
    // the isolation ordering is inverted and the case refuses.
    const sentinel = { label: directLabel(), callNonce: directCallNonce(), workerOutcome: 'completed' };
    const { label } = await buildDirectLifecycleTranscript(run, {
      nonce,
      triggerSent: 'turn-interrupt',
      triggerObserved: 'acknowledged',
      handlerOutcome: 'cancelled',
      workerOutcome: 'cancelled',
      rpcOutcome: 'error-result',
      sentinel,
      sentinelJoinAfterTrigger: true,
    });
    const { records, reduced } = await reduceDirectRun(run, nonce);
    const verdict = classifyDirectLifecycleCase({
      records, reduced, probeLabel: label, phase: 'lifecycle', command: 'execution-foreground', trigger: 'turn-interrupt',
      exactTurnConfirmed: true, sentinelLabel: sentinel.label,
    });
    assert.equal(verdict.classification, 'settlement-unproven');
    assert.equal(verdict.reasonCode, 'sentinel-ordering-inverted');
  });
});

test('direct lifecycle a rejected interrupt observation refuses the settlement claim', async () => {
  const { classifyDirectLifecycleCase } = await import('../tools/direct-mcp-probe/lifecycle.mjs');
  await withDirectProbeRun('zcode-direct-lifecycle-', async (run) => {
    const nonce = directRunNonce();
    // The host REJECTED the requested turn/interrupt (trigger-observed
    // rejected), yet the target independently settled cancelled afterwards
    // and the sentinel completed: the durable chain looks clean, but the
    // settlement/isolation would be misattributed to an action that never
    // took effect — the case must refuse.
    const sentinel = { label: directLabel(), callNonce: directCallNonce(), workerOutcome: 'completed' };
    const { label } = await buildDirectLifecycleTranscript(run, {
      nonce,
      triggerSent: 'turn-interrupt',
      triggerObserved: 'rejected',
      handlerOutcome: 'cancelled',
      workerOutcome: 'cancelled',
      rpcOutcome: 'error-result',
      sentinel,
      sentinelSpanningBoundary: true,
    });
    const { records, reduced } = await reduceDirectRun(run, nonce);
    const verdict = classifyDirectLifecycleCase({
      records, reduced, probeLabel: label, phase: 'lifecycle', command: 'execution-foreground', trigger: 'turn-interrupt',
      exactTurnConfirmed: true, sentinelLabel: sentinel.label,
    });
    assert.equal(verdict.classification, 'settlement-unproven');
    assert.equal(verdict.reasonCode, 'trigger-not-acknowledged');
  });
});

test('direct lifecycle the sentinel requires both matching terminals like the target', async () => {
  const { classifyDirectLifecycleCase } = await import('../tools/direct-mcp-probe/lifecycle.mjs');
  await withDirectProbeRun('zcode-direct-lifecycle-', async (run) => {
    const nonce = directRunNonce();
    // The sentinel settled by its WORKER terminal alone: its handler
    // terminal is missing — under the VERIFIED release chain a partial
    // sentinel write can neither claim survived isolation nor pass the case.
    const sentinel = { label: directLabel(), callNonce: directCallNonce(), workerOutcome: 'completed', workerOnly: true };
    const { label } = await buildDirectLifecycleTranscript(run, {
      nonce,
      triggerSent: 'turn-interrupt',
      triggerObserved: 'acknowledged',
      handlerOutcome: 'cancelled',
      workerOutcome: 'cancelled',
      rpcOutcome: 'error-result',
      sentinel,
      sentinelSpanningBoundary: true,
      sentinelDriverRelease: true,
    });
    const { records, reduced } = await reduceDirectRun(run, nonce);
    const verdict = classifyDirectLifecycleCase({
      records, reduced, probeLabel: label, phase: 'lifecycle', command: 'execution-foreground', trigger: 'turn-interrupt',
      exactTurnConfirmed: true, sentinelLabel: sentinel.label,
    });
    assert.equal(verdict.classification, 'settlement-unproven');
    assert.equal(verdict.reasonCode, 'sentinel-handler-terminal-missing');
    // Conflicting sentinel terminals: the handler and worker disagree —
    // the sentinel's own two-terminal invariant is violated too.
    const conflictingSentinel = { label: directLabel(), callNonce: directCallNonce(), workerOutcome: 'completed', handlerOutcome: 'cancelled' };
    const second = await buildDirectLifecycleTranscript(run, {
      nonce,
      triggerSent: 'turn-interrupt',
      triggerObserved: 'acknowledged',
      handlerOutcome: 'cancelled',
      workerOutcome: 'cancelled',
      rpcOutcome: 'error-result',
      sentinel: conflictingSentinel,
      sentinelSpanningBoundary: true,
      sentinelDriverRelease: true,
    });
    const secondReduce = await reduceDirectRun(run, nonce);
    const conflicting = classifyDirectLifecycleCase({
      records: secondReduce.records, reduced: secondReduce.reduced, probeLabel: second.label, phase: 'lifecycle',
      command: 'execution-foreground', trigger: 'turn-interrupt', exactTurnConfirmed: true, sentinelLabel: conflictingSentinel.label,
    });
    assert.equal(conflicting.classification, 'settlement-unproven');
    assert.equal(conflicting.reasonCode, 'sentinel-terminals-inconsistent');
  });
});

test('direct lifecycle a watchdog self-completed sentinel can never claim isolation', async () => {
  const { classifyDirectLifecycleCase } = await import('../tools/direct-mcp-probe/lifecycle.mjs');
  await withDirectProbeRun('zcode-direct-lifecycle-', async (run) => {
    const nonce = directRunNonce();
    // The reviewer's exact gap: the sentinel's completion was DECIDED by our
    // server's internal watchdog before the boundary, and both terminals
    // committed after it — all orderings hold, but the completion decision
    // is durably unorderable against the host's cancellation action.
    const sentinel = { label: directLabel(), callNonce: directCallNonce(), workerOutcome: 'completed' };
    const { label } = await buildDirectLifecycleTranscript(run, {
      nonce,
      triggerSent: 'turn-interrupt',
      triggerObserved: 'acknowledged',
      handlerOutcome: 'cancelled',
      workerOutcome: 'cancelled',
      rpcOutcome: 'error-result',
      sentinel,
      sentinelSpanningBoundary: true,
    });
    const { records, reduced } = await reduceDirectRun(run, nonce);
    const verdict = classifyDirectLifecycleCase({
      records, reduced, probeLabel: label, phase: 'lifecycle', command: 'execution-foreground', trigger: 'turn-interrupt',
      exactTurnConfirmed: true, sentinelLabel: sentinel.label,
    });
    assert.equal(verdict.classification, 'settlement-unproven');
    assert.equal(verdict.reasonCode, 'sentinel-watchdog-unprovable');
  });
});

test('direct lifecycle a sentinel terminal predating the verified release proves nothing', async () => {
  const { classifyDirectLifecycleCase } = await import('../tools/direct-mcp-probe/lifecycle.mjs');
  await withDirectProbeRun('zcode-direct-lifecycle-', async (run) => {
    const nonce = directRunNonce();
    // The release marker follows the boundary, but the sentinel's HANDLER
    // terminal predates it (a straddling/delayed-log-write shape): the
    // sentinel was not verifiably pending at the driver-ordered release, so
    // BOTH terminals must postdate the marker for isolation.
    const sentinel = { label: directLabel(), callNonce: directCallNonce(), workerOutcome: 'cancelled', handlerEarly: true };
    const { label } = await buildDirectLifecycleTranscript(run, {
      nonce,
      triggerSent: 'turn-interrupt',
      triggerObserved: 'acknowledged',
      handlerOutcome: 'cancelled',
      workerOutcome: 'cancelled',
      rpcOutcome: 'error-result',
      sentinel,
      sentinelSpanningBoundary: true,
      sentinelDriverRelease: true,
    });
    const { records, reduced } = await reduceDirectRun(run, nonce);
    const verdict = classifyDirectLifecycleCase({
      records, reduced, probeLabel: label, phase: 'lifecycle', command: 'execution-foreground', trigger: 'turn-interrupt',
      exactTurnConfirmed: true, sentinelLabel: sentinel.label,
    });
    assert.equal(verdict.sentinelClassification, 'unproven', 'a handler terminal predating the verified release proves no post-release hold');
    assert.equal(verdict.classification, 'settlement-unproven');
    assert.equal(verdict.reasonCode, 'sentinel-handler-before-release');
  });
});

test('direct lifecycle driver releases the sentinel at the observed boundary over notifications/cancelled', async () => {
  const { runDirectLifecycleProbe } = await loadDirectDriver();
  const fixture = await buildDirectDriverFixture('lifecycle-cancels-at-timeout');
  try {
    const run = join(fixture.parent, 'run');
    await fsp.mkdir(run, { mode: 0o700 });
    const counters = await runDirectLifecycleProbe({
      codexPath: fixture.codexPath, sourceCodexHome: fixture.sourceHome, runDirectory: run,
      lifecycleObserveWindowMs: 30_000,
      cases: ['config-timeout'],
    });
    const phase = counters.phases.lifecycle;
    // The host cancels the TARGET at the configured timeout: the boundary is
    // durably observed, the driver releases the sentinel over
    // notifications/cancelled, and the classifier honestly records the
    // host-internal isolation as unprovable.
    assert.equal(phase.prerequisites.holdStartedSeen, true);
    assert.equal(phase.cases['config-timeout'], 'settlement-unproven');
    assert.equal(phase.caseReasons['config-timeout'], 'sentinel-ordering-unprovable');
    assert.equal(phase.cleanup, 'released');
    // The durable journal pins the real release path: the sentinel join
    // precedes the driver's release marker (trigger-observed acknowledged,
    // source driver), and BOTH sentinel terminals postdate the marker.
    const rawLog = await readFile(join(run, 'events.jsonl'), 'utf8');
    const recs = rawLog.trim().split('\n').map((l) => JSON.parse(l));
    const releaseMarker = recs.find((r) => r.kind === 'trigger-observed' && r.outcome === 'acknowledged' && r.source === 'driver');
    assert.ok(releaseMarker, 'the driver release marker is durable');
    const sentinelCallNonce = recs.find((r) => r.kind === 'trigger-sent' && r.callNonce !== undefined && r.sequence > 0
      && recs.some((o) => o.kind === 'trigger-observed' && o.callNonce === r.callNonce && o.source === 'driver')).callNonce;
    const boundaryRecord = recs.find((r) => r.kind === 'worker-settled' && r.callNonce !== sentinelCallNonce && r.outcome === 'cancelled');
    assert.ok(boundaryRecord, 'the target cancellation boundary is durable');
    assert.ok(releaseMarker.sequence > boundaryRecord.sequence, 'the release marker follows the durably observed boundary');
    const sentinelTerminals = recs.filter((r) => (r.kind === 'handler-settled' || r.kind === 'worker-settled') && r.callNonce === sentinelCallNonce);
    assert.equal(sentinelTerminals.length, 2, 'both sentinel terminals are durable');
    for (const terminal of sentinelTerminals) {
      assert.ok(terminal.sequence > boundaryRecord.sequence, 'the sentinel terminal postdates the observed boundary');
      // The sentinel settled CANCELLED by the forwarded targeted release: a
      // release that had hit the target's request id could never produce
      // this (the sentinel would only settle by its own watchdog later).
      assert.equal(terminal.outcome, 'cancelled', 'the released sentinel settled cancelled by the targeted release');
    }
    // The targeted release hit the SENTINEL's own request id, never the
    // target's: the fake host records WHICH driver request id the
    // notifications/cancelled frame named, beside every dispatched tool-call
    // request id (1st = the case target, 2nd = the sentinel).
    const cancelledRecord = JSON.parse(await readFile(join(run, 'fixture-cancelled-request.json'), 'utf8'));
    assert.equal(cancelledRecord.driverToolCallIds.length, 2, 'the case dispatched exactly the target and the sentinel');
    assert.notEqual(cancelledRecord.cancelledRequestId, cancelledRecord.driverToolCallIds[0], 'the targeted release never names the target request');
    assert.equal(cancelledRecord.cancelledRequestId, cancelledRecord.driverToolCallIds[1], 'the targeted release names the sentinel request');
  } finally {
    await rm(fixture.parent, { recursive: true, force: true });
  }
});

// Codex gate round 13 escalation (four P1s): regressions first.

test('direct lifecycle delayed sentinel terminal writes after an earlier broad cancellation are decision-order unprovable', async () => {
  const { classifyDirectLifecycleCase } = await import('../tools/direct-mcp-probe/lifecycle.mjs');
  await withDirectProbeRun('zcode-direct-lifecycle-', async (run) => {
    const nonce = directRunNonce();
    // The misattribution shape: a broad cancellation DECIDES the sentinel's
    // outcome before the driver releases it, while the server writes the
    // terminal records afterward — and the server sends the tools/call
    // response only AFTER both terminals are durably committed. The sentinel
    // request is therefore still outstanding when the driver releases it
    // (cancelRequestById returns true), both terminals postdate the verified
    // marker, and the journal is IDENTICAL to a genuine post-release
    // decision. The decision instant is durably unorderable against the
    // targeted release, so isolation stays unproven however clean the
    // orderings look.
    const sentinel = { label: directLabel(), callNonce: directCallNonce(), workerOutcome: 'cancelled' };
    const { label } = await buildDirectLifecycleTranscript(run, {
      nonce,
      triggerSent: 'turn-interrupt',
      triggerObserved: 'acknowledged',
      handlerOutcome: 'cancelled',
      workerOutcome: 'cancelled',
      rpcOutcome: 'error-result',
      sentinel,
      sentinelSpanningBoundary: true,
      sentinelDriverRelease: true,
    });
    const { records, reduced } = await reduceDirectRun(run, nonce);
    const verdict = classifyDirectLifecycleCase({
      records, reduced, probeLabel: label, phase: 'lifecycle', command: 'execution-foreground', trigger: 'turn-interrupt',
      exactTurnConfirmed: true, sentinelLabel: sentinel.label,
    });
    assert.equal(verdict.sentinelClassification, 'unproven', 'a verified release cannot prove the decision followed it');
    assert.equal(verdict.classification, 'settlement-unproven');
    assert.equal(verdict.reasonCode, 'sentinel-decision-order-unprovable');
  });
});

test('direct lifecycle a verified release with non-cancelled sentinel terminals is outcome-unprovable', async () => {
  const { classifyDirectLifecycleCase } = await import('../tools/direct-mcp-probe/lifecycle.mjs');
  await withDirectProbeRun('zcode-direct-lifecycle-', async (run) => {
    const nonce = directRunNonce();
    // The release chain holds, but the sentinel settled `timed-out`: only a
    // `cancelled` settlement is the server's cancellation decision at all —
    // any other non-completed outcome cannot witness the targeted release.
    const sentinel = { label: directLabel(), callNonce: directCallNonce(), workerOutcome: 'timed-out' };
    const { label } = await buildDirectLifecycleTranscript(run, {
      nonce,
      triggerSent: 'turn-interrupt',
      triggerObserved: 'acknowledged',
      handlerOutcome: 'cancelled',
      workerOutcome: 'cancelled',
      rpcOutcome: 'error-result',
      sentinel,
      sentinelSpanningBoundary: true,
      sentinelDriverRelease: true,
    });
    const { records, reduced } = await reduceDirectRun(run, nonce);
    const verdict = classifyDirectLifecycleCase({
      records, reduced, probeLabel: label, phase: 'lifecycle', command: 'execution-foreground', trigger: 'turn-interrupt',
      exactTurnConfirmed: true, sentinelLabel: sentinel.label,
    });
    assert.equal(verdict.sentinelClassification, 'unproven', 'a non-cancelled terminal cannot witness the targeted release');
    assert.equal(verdict.classification, 'settlement-unproven');
    assert.equal(verdict.reasonCode, 'sentinel-outcome-unprovable');
  });
});

test('direct lifecycle sentinel completed terminals after the verified release are watchdog-unprovable', async () => {
  const { classifyDirectLifecycleCase } = await import('../tools/direct-mcp-probe/lifecycle.mjs');
  await withDirectProbeRun('zcode-direct-lifecycle-', async (run) => {
    const nonce = directRunNonce();
    // The watchdog won the race: the sentinel completed (its own timer) even
    // though the driver's verified release marker followed the boundary.
    // The target settles cancelled (the durably observed boundary), and both
    // sentinel terminals commit after the marker — the completion decision
    // is still the probe server's internal watchdog, so isolation stays
    // unprovable.
    const sentinel = { label: directLabel(), callNonce: directCallNonce(), workerOutcome: 'completed' };
    const { label } = await buildDirectLifecycleTranscript(run, {
      nonce,
      triggerSent: 'turn-interrupt',
      triggerObserved: 'acknowledged',
      handlerOutcome: 'cancelled',
      workerOutcome: 'cancelled',
      rpcOutcome: 'error-result',
      sentinel,
      sentinelSpanningBoundary: true,
      sentinelDriverRelease: true,
    });
    const { records, reduced } = await reduceDirectRun(run, nonce);
    const verdict = classifyDirectLifecycleCase({
      records, reduced, probeLabel: label, phase: 'lifecycle', command: 'execution-foreground', trigger: 'turn-interrupt',
      exactTurnConfirmed: true, sentinelLabel: sentinel.label,
    });
    assert.equal(verdict.classification, 'settlement-unproven');
    assert.equal(verdict.reasonCode, 'sentinel-watchdog-unprovable');
  });
});

test('direct lifecycle an early release marker before the boundary is ordering-unprovable', async () => {
  const { classifyDirectLifecycleCase } = await import('../tools/direct-mcp-probe/lifecycle.mjs');
  await withDirectProbeRun('zcode-direct-lifecycle-', async (run) => {
    const nonce = directRunNonce();
    // The release marker (trigger-observed acknowledged for the sentinel's
    // call) is durable BEFORE the target's cancellation settlement: the
    // marker does not follow the durably observed boundary, so the
    // driver-ordered release chain is unproven.
    const sentinel = { label: directLabel(), callNonce: directCallNonce(), workerOutcome: 'completed' };
    const { label } = await buildDirectLifecycleTranscript(run, {
      nonce,
      triggerSent: 'turn-interrupt',
      triggerObserved: 'acknowledged',
      handlerOutcome: 'cancelled',
      workerOutcome: 'cancelled',
      rpcOutcome: 'error-result',
      sentinel,
      sentinelSpanningBoundary: true,
      sentinelEarlyReleaseMarker: true,
    });
    const { records, reduced } = await reduceDirectRun(run, nonce);
    const verdict = classifyDirectLifecycleCase({
      records, reduced, probeLabel: label, phase: 'lifecycle', command: 'execution-foreground', trigger: 'turn-interrupt',
      exactTurnConfirmed: true, sentinelLabel: sentinel.label,
    });
    assert.equal(verdict.classification, 'settlement-unproven');
    assert.equal(verdict.reasonCode, 'sentinel-ordering-unprovable', 'a marker preceding the boundary proves no post-boundary release');
  });
});
