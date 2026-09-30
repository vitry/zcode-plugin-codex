// @ts-nocheck
// Opt-in validator for the direct MCP feasibility result (plan Task 7 Step 2).
//
//   ZCODE_DIRECT_MCP_E2E=1 ZCODE_DIRECT_MCP_RESULT=<path> \
//     node --test tests/e2e/codex-direct-mcp-feasibility.test.mjs
//
// STRUCTURALLY validates ONE supplied redacted result record against the
// closed Task 2 contract (`validateDirectResultRecord`) plus the
// anti-fabrication rules. A pass here is structural validation of the
// record's shape, closed reason codes, and evidence references — NEVER live
// qualification and never a feasibility result (the record must declare the
// closed top-level `validationScope: 'structural'` to be accepted at all).
// The default run performs NO live qualification: the opt-in test skips, a
// skip is never qualification, and the always-on tests below exercise only
// closed-vocabulary fixtures and the committed frozen record.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { DIRECT_GATE_KEYS, validateDirectResultRecord } from '../../tools/direct-mcp-probe/observer.mjs';

const optInEnabled = process.env.ZCODE_DIRECT_MCP_E2E === '1';
const optInSkip = optInEnabled
  ? false
  : 'opt-in required: set ZCODE_DIRECT_MCP_E2E=1 and ZCODE_DIRECT_MCP_RESULT=<path> to structurally validate a supplied redacted result; a skip is never qualification';

const FROZEN_RECORD_URL = new URL('../../qualification/direct-mcp-feasibility.json', import.meta.url);
const FROZEN_REPORT_URL = new URL('../../docs/qualification/codex-app-server-direct-mcp.md', import.meta.url);

/**
 * The unique closed proven reason code per gate — the exact reason the
 * committed classifiers return on their proven branches (G1
 * `classifyDirectGateG1`, G2 `classifyDirectGateG2`, G3
 * `classifyDirectGateG3`, G4 `classifyDirectGateG4`). Any other reason code
 * on a `proven` gate is a fabricated pass.
 */
const PROVEN_REASON_CODES = Object.freeze({
  G1: 'handler-entry-observed',
  G2: 'identity-binding-observed',
  G3: 'lifecycle-settlement-durably-observed',
  G4: 'installed-entry-demonstrated',
});
/** G2/G3/G4 all dispatch through the reachability G1 establishes. */
const DOWNSTREAM_GATES = Object.freeze(['G2', 'G3', 'G4']);

/** @param {string} code @param {string} message */
function frozenError(code, message) {
  const error = /** @type {Error & {code: string}} */ (new Error(`${code}: ${message}`));
  error.code = code;
  return error;
}

/** No raw identity anywhere in a result record: no paths, no separators. */
function assertNoRawIdentity(value, at = 'record') {
  if (typeof value === 'string') {
    if (value.includes('/') || value.includes('\\') || value.includes('~')) {
      throw frozenError('PROBE_IDENTITY_LEAK', `${at} must not embed a path, separator, or raw identity.`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoRawIdentity(entry, `${at}[${index}]`));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) assertNoRawIdentity(entry, `${at}.${key}`);
  }
}

/**
 * The frozen-record validator. Throws unless the record passes the closed
 * Task 2 schema AND every anti-fabrication rule: an obsolete record version
 * or shape, unsupported provenance, a missing gate, a fabricated `proven`
 * gate (foreign reason code or uncited evidence), a G2/G3/G4 pass inferred
 * from G1, and a record that does not declare the closed
 * `validationScope: 'structural'` — every record this validator accepts is
 * structurally validated only, never live qualification — all fail.
 * @param {unknown} record
 * @param {{runNonce?: string | null}} [options]
 */
export function validateDirectMcpFeasibilityRecord(record, { runNonce = null } = {}) {
  validateDirectResultRecord(record, { runNonce });
  if (record.validationScope !== 'structural') {
    throw frozenError(
      'PROBE_VALIDATION_SCOPE_MISSING',
      'A record validated here is structurally validated only: it must declare the closed top-level validationScope "structural" — a pass of this validator is never live qualification.',
    );
  }
  for (const key of DIRECT_GATE_KEYS) {
    const gate = record.gates[key];
    if (gate.status !== 'proven') continue;
    if (gate.reasonCode !== PROVEN_REASON_CODES[key]) {
      throw frozenError('PROBE_GATE_FABRICATED', `A proven ${key} gate must carry the closed proven reason code ${PROVEN_REASON_CODES[key]}.`);
    }
    if (gate.evidenceRefs.length === 0) {
      throw frozenError('PROBE_GATE_FABRICATED', `A proven ${key} gate must cite at least one evidence reference.`);
    }
  }
  if (record.gates.G1.status !== 'proven') {
    for (const key of DOWNSTREAM_GATES) {
      if (record.gates[key].status === 'proven') {
        throw frozenError('PROBE_GATE_INFERRED', `A proven ${key} gate cannot stand on G1 reachability that is itself not proven.`);
      }
    }
  }
  assertNoRawIdentity(record);
  return record;
}

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

/** A schema-valid fixture record (synthetic digests; not the frozen record). */
function fixtureRecord() {
  return {
    version: 1,
    validationScope: 'structural',
    provenance: {
      runNonce: 'a'.repeat(64),
      codexVersion: 'codex-cli 0.155.1',
      codexBinaryDigest: sha256('fixture-binary'),
      platform: 'darwin-arm64',
      sdkVersion: '1.30.0',
      sourceCommit: 'b'.repeat(40),
      schemaDigest: sha256('fixture-schema'),
      fixtureMode: 'campaign',
    },
    evidence: { digest: sha256('fixture-evidence'), count: 1 },
    gates: {
      G1: { status: 'proven', reasonCode: 'handler-entry-observed', evidenceRefs: ['section-8@1'] },
      G2: { status: 'not-proven', reasonCode: 'no-trusted-caller-path', evidenceRefs: [] },
      G3: { status: 'not-proven', reasonCode: 'settlement-unproven', evidenceRefs: [] },
      G4: { status: 'not-proven', reasonCode: 'no-supported-entry-candidate', evidenceRefs: [] },
    },
  };
}

test('the direct MCP feasibility validator rejects obsolete records, unsupported provenance, missing gates, and fabricated passes', () => {
  const valid = fixtureRecord();
  assert.deepEqual(validateDirectMcpFeasibilityRecord(valid, { runNonce: valid.provenance.runNonce }), valid);
  assert.deepEqual(validateDirectMcpFeasibilityRecord(structuredClone(valid)), valid);

  // Obsolete record version and the pre-freeze all-boolean record shape.
  assert.throws(() => validateDirectMcpFeasibilityRecord({ ...valid, version: 2 }), /PROBE_RESULT_INVALID/, 'an obsolete record version fails');
  assert.throws(
    () => validateDirectMcpFeasibilityRecord({ version: 1, context: { allTrue: true }, lifecycle: { allTrue: true } }),
    /PROBE_RESULT_INVALID/,
    'the obsolete non-gate record shape fails',
  );

  // Unsupported provenance: missing, malformed, unknown, non-closed, raw path.
  const missingSchema = structuredClone(valid);
  delete missingSchema.provenance.schemaDigest;
  assert.throws(() => validateDirectMcpFeasibilityRecord(missingSchema), /PROBE_RESULT_INVALID/, 'provenance missing a required digest fails');
  const truncatedBinary = structuredClone(valid);
  truncatedBinary.provenance.codexBinaryDigest = 'abc';
  assert.throws(() => validateDirectMcpFeasibilityRecord(truncatedBinary), /PROBE_RESULT_INVALID/, 'a malformed binary digest fails');
  const unknownProvenance = structuredClone(valid);
  unknownProvenance.provenance.hostname = 'operator-host';
  assert.throws(() => validateDirectMcpFeasibilityRecord(unknownProvenance), /PROBE_RESULT_INVALID/, 'unknown provenance fields fail');
  const unclosedMode = structuredClone(valid);
  unclosedMode.provenance.fixtureMode = 'production';
  assert.throws(() => validateDirectMcpFeasibilityRecord(unclosedMode), /PROBE_RESULT_INVALID/, 'a non-closed fixture mode fails');
  const rawPath = structuredClone(valid);
  rawPath.provenance.platform = '/Users/operator';
  assert.throws(() => validateDirectMcpFeasibilityRecord(rawPath), /PROBE_IDENTITY_LEAK/, 'a raw path in provenance fails');

  // A missing gate (case) fails closed.
  const missingGate = structuredClone(valid);
  delete missingGate.gates.G3;
  assert.throws(() => validateDirectMcpFeasibilityRecord(missingGate), /PROBE_RESULT_INVALID/, 'a missing gate fails');
  assert.throws(() => validateDirectMcpFeasibilityRecord({ ...valid, gates: {} }), /PROBE_RESULT_INVALID/, 'an empty gates object fails');

  // Fabricated proven gates: foreign reason codes and uncited evidence.
  const contradictory = structuredClone(valid);
  contradictory.gates.G4 = { status: 'proven', reasonCode: 'no-supported-entry-candidate', evidenceRefs: ['section-3@0'] };
  assert.throws(() => validateDirectMcpFeasibilityRecord(contradictory), /PROBE_GATE_FABRICATED/, 'a proven gate carrying a not-proven reason code fails');
  const inferredReason = structuredClone(valid);
  inferredReason.gates.G2 = { status: 'proven', reasonCode: 'handler-entry-observed', evidenceRefs: ['section-8@1'] };
  assert.throws(() => validateDirectMcpFeasibilityRecord(inferredReason), /PROBE_GATE_FABRICATED/, 'a G2 pass carrying the G1 reason code fails');
  const uncited = structuredClone(valid);
  uncited.gates.G1 = { status: 'proven', reasonCode: 'handler-entry-observed', evidenceRefs: [] };
  assert.throws(() => validateDirectMcpFeasibilityRecord(uncited), /PROBE_GATE_FABRICATED/, 'a proven gate without cited evidence fails');

  // G2/G3/G4 passes inferred from a G1 that is not proven fail.
  for (const g1Status of ['not-proven', 'incompatible-under-tested-conditions']) {
    const downstream = structuredClone(valid);
    downstream.gates.G1 = { status: g1Status, reasonCode: 'rpc-rejected', evidenceRefs: [] };
    downstream.gates.G3 = { status: 'proven', reasonCode: PROVEN_REASON_CODES.G3, evidenceRefs: ['section-13@0'] };
    assert.throws(() => validateDirectMcpFeasibilityRecord(downstream), /PROBE_GATE_INFERRED/, `a G3 pass cannot stand on G1 ${g1Status}`);
  }
});

test('the frozen direct MCP feasibility record validates and binds the campaign decisions', async () => {
  let bytes;
  try {
    bytes = await readFile(FROZEN_RECORD_URL, 'utf8');
  } catch {
    throw new Error('qualification/direct-mcp-feasibility.json is missing: the frozen four-gate record must exist');
  }
  const record = JSON.parse(bytes);
  validateDirectMcpFeasibilityRecord(record, { runNonce: record.provenance.runNonce });

  // The frozen provenance of the campaign (measured, digests only).
  assert.equal(record.version, 1);
  // The closed self-description (gate review): the frozen record declares
  // that anything this validator accepts for it is structural validation.
  assert.equal(record.validationScope, 'structural');
  assert.equal(record.provenance.codexVersion, 'codex-cli 0.155.1');
  assert.equal(record.provenance.codexBinaryDigest, '8eaf1ad12fe6bf89b1710330f58900014322c7c5af677e43be116d8ac5fc0a9e');
  assert.equal(record.provenance.schemaDigest, '0e8d8c9d679fee54544f595d779e37156ad413e3f253404412a9752cdec6e44a');
  assert.equal(record.provenance.sourceCommit, '04b2d23ae712f79ebf8660e412e4e8fad10d3ca4');
  assert.equal(record.provenance.platform, 'darwin-arm64');
  assert.equal(record.provenance.sdkVersion, '1.30.0');
  assert.equal(record.provenance.fixtureMode, 'campaign');

  // The frozen four-gate decision, exactly as the campaign classified it:
  // G1's positive did not survive the Task 7 Step 3 frozen-driver
  // confirmation (report section 8.6), so it is frozen not-proven.
  assert.deepEqual(record.gates.G1, { status: 'not-proven', reasonCode: 'confirmation-failed', evidenceRefs: ['section-8@1', 'section-8@2', 'section-8@5', 'section-8@6'] });
  assert.deepEqual(record.gates.G2, { status: 'not-proven', reasonCode: 'no-trusted-caller-path', evidenceRefs: ['section-10@1', 'section-10@3'] });
  assert.deepEqual(record.gates.G3, { status: 'not-proven', reasonCode: 'settlement-unproven', evidenceRefs: ['section-12@2', 'section-13@0', 'section-13@2'] });
  assert.deepEqual(record.gates.G4, { status: 'not-proven', reasonCode: 'no-supported-entry-candidate', evidenceRefs: ['section-3@0', 'section-15@0', 'section-15@1'] });

  // Evidence binding: the digest covers the report bytes at freeze time and
  // the count is the durable event rows the report documents at sequence
  // granularity (7 in the reproduced reachability table, 5 in the divergent
  // run's table). Editing the report invalidates the freeze by design.
  const report = await readFile(FROZEN_REPORT_URL, 'utf8');
  const documentedRows = [...report.matchAll(/^\| \d+ \| `[a-z-]+` \|/gm)].length;
  assert.equal(documentedRows, 12, 'the report must document exactly the frozen durable event rows');
  assert.deepEqual(record.evidence, { digest: sha256(report), count: documentedRows });

  // The structural-scope honesty label (gate review): the report must state
  // plainly that a pass of the opt-in validator is structural validation of
  // the supplied record — never live qualification, never a feasibility
  // result — so the validator's pass can never be reported as qualification.
  assert.match(report, /A pass of the opt-in validator is structural validation of the supplied record/);
  assert.match(report, /never live qualification and never a feasibility result/);

  // Every evidence reference anchors into the report: section-N@0 addresses
  // the section body, section-N@M addresses subsection N.M.
  for (const ref of Object.values(record.gates).flatMap((gate) => gate.evidenceRefs)) {
    const match = /^section-(\d+)@(\d+)$/.exec(ref);
    assert.ok(match, `evidence ref ${ref} must use the section anchor vocabulary`);
    const pattern = match[2] === '0' ? `^## ${match[1]}\\.` : `^### ${match[1]}.${match[2]} `;
    assert.match(report, new RegExp(pattern, 'm'), `evidence ref ${ref} must anchor into the frozen report`);
  }
});

test('the opted-in direct MCP feasibility test structurally validates the supplied result record (NOT live qualification)', { skip: optInSkip }, async () => {
  const resultPath = process.env.ZCODE_DIRECT_MCP_RESULT;
  let bytes;
  try {
    if (!resultPath) throw Object.assign(new Error('result path is unset'), { code: 'ENOENT' });
    bytes = await readFile(resultPath, 'utf8');
  } catch {
    throw new Error('the opted-in direct MCP result is unavailable: ZCODE_DIRECT_MCP_RESULT must name a real redacted result file');
  }
  const record = JSON.parse(bytes);
  validateDirectMcpFeasibilityRecord(record, { runNonce: record.provenance.runNonce });
  // The pass above is STRUCTURAL VALIDATION ONLY — it establishes the
  // supplied record's shape, closed reason codes, and evidence references.
  // It is never live qualification and never a feasibility result.
  console.log('structural validation only — NOT live qualification: this pass establishes the supplied record\'s shape, closed reason codes, and evidence references, never a feasibility result');
});
