// @ts-nocheck
import assert from 'node:assert/strict';
import test from 'node:test';

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
