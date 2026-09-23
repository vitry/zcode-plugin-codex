// @ts-nocheck
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
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
  ENTRY_REQUIRED_ASPECTS,
  ENTRY_ROW_FIELDS,
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
