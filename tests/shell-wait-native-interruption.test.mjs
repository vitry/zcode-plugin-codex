// @ts-nocheck
// Focused offline regressions for the native-acceptance causal contract
// (report docs/qualification/rescue-shell-long-wait.md §24.4, implemented by
// plan Task 2). Every test runs the REAL extractor → mapper → serializer →
// join → oracle pipeline (evidence.mjs → mapShellWaitLiveFacts →
// runShellWaitCase → nativeInterruptionGateDInput →
// evaluateNativeInterruptionSettlement) on synthetic rollouts; importing the
// modules launches nothing and every host dependency is faked — there is no
// live case anywhere in this file (plan Task 2: fully offline).
// Selected only through the dedicated shell-research suite
// (tools/run-test-suite.mjs); it never imports another test entry, because
// that would trigger the entry's test registrations.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// --- the registered rollout vocabulary (the same wire shapes the pinned host
// persists: rollout_payload.rs EventMsg, protocol.rs ItemCompletedEvent,
// items.rs SubAgentActivityItem; epoch-ms rollout-event timestamps) ---------

const CHILD_THREAD = 'a445b927-1e4d-4f11-9a34-2b6ac19b7d51';
const ROOT_THREAD = 'root-thread-1';
const LAUNCHER = 'node launcher';

const stamped = (timestamp, event) => ({ timestamp, ...event });
const fnCall = (name, callId, args, timestamp = null) => ({
  ...(timestamp ? stamped(timestamp, {}) : {}),
  type: 'response_item', payload: { type: 'function_call', name, call_id: callId, arguments: JSON.stringify(args) },
});
const fnOutput = (callId, output, timestamp = null) => ({
  ...(timestamp ? stamped(timestamp, {}) : {}),
  type: 'response_item', payload: { type: 'function_call_output', call_id: callId, output },
});
const interruptCall = (callId, target, timestamp = null) => fnCall('interrupt_agent', callId, { target }, timestamp);
const interruptSuccess = (callId, previousStatus, timestamp = null) => fnOutput(callId, JSON.stringify({ previous_status: previousStatus }), timestamp);
const activityItem = ({ id, kind = 'interrupted', agentThreadId = CHILD_THREAD, threadId = ROOT_THREAD, completedAtMs }) => ({
  type: 'event_msg',
  payload: {
    type: 'item_completed',
    thread_id: threadId,
    turn_id: 'root-turn-1',
    item: { type: 'SubAgentActivity', model: null, reasoning_effort: null, id, kind, agent_thread_id: agentThreadId, agent_path: '/root/zcode_rescue_task_1' },
    completed_at_ms: completedAtMs,
  },
});
const completedOutputBody = (result) => [
  { type: 'input_text', text: 'Script completed\n' },
  { type: 'input_text', text: JSON.stringify(result) },
];
const pendingOutputBody = (cellId) => [{ type: 'input_text', text: `Script running with cell ID ${cellId}\n` }];
// The pinned native-cancellation framing (parallel.rs:376-382): the marker
// the extractor decodes as the Child-side native resolution (f4).
const nativeMarkerOutput = [
  { type: 'input_text', text: 'Script terminated\nWall time 0.1 seconds\nOutput:\n' },
  { type: 'input_text', text: 'killed\n' },
];

const CALL_MS = Date.parse('2026-10-06T00:00:07.000Z');
const RESOLUTION_MS = Date.parse('2026-10-06T00:00:12.000Z');

/**
 * The full causal shape with EVERY §24.4 leg satisfiable, each test mutating
 * one dimension. Timeline: launch 00:00 → pending poll 00:02 → interrupt call
 * 00:07 → native cancellation marker 00:12. `completedAtMs` is the host
 * activity item's emission stamp — the F record's registered shape sets it
 * EQUAL to the marker stamp (the submission-result item emitted AT the
 * resolution instant, report §24.3).
 */
function causalRollouts({
  callId = 'int-1', target = CHILD_THREAD, completedAtMs = RESOLUTION_MS,
  withPendingPoll = true, childTerminalBeforeCall = false, withNativeResolution = true,
} = {}) {
  const childEvents = [
    { type: 'session_meta', payload: { id: CHILD_THREAD } },
    fnCall('exec_command', 'launch-1', { cmd: LAUNCHER }, '2026-10-06T00:00:00.000Z'),
    fnOutput('launch-1', completedOutputBody({ output: '', exit_code: 0, session_id: 5 }), '2026-10-06T00:00:01.000Z'),
    ...(withPendingPoll ? [
      fnCall('write_stdin', 'poll-1', { session_id: 5, chars: '', yield_time_ms: 60_000 }, '2026-10-06T00:00:02.000Z'),
      fnOutput('poll-1', pendingOutputBody('cell-1'), '2026-10-06T00:00:02.500Z'),
    ] : []),
    ...(childTerminalBeforeCall ? [
      fnCall('wait', 'outer-1', { cell_id: 'cell-1' }, '2026-10-06T00:00:03.000Z'),
      fnOutput('outer-1', completedOutputBody({ output: 'done', exit_code: 0 }), '2026-10-06T00:00:04.000Z'),
    ] : []),
    ...(withNativeResolution && withPendingPoll && !childTerminalBeforeCall ? [
      fnCall('wait', 'outer-native', { cell_id: 'cell-1' }, '2026-10-06T00:00:09.000Z'),
      fnOutput('outer-native', nativeMarkerOutput, RESOLUTION_MS),
    ] : []),
  ];
  const rootEvents = [
    { type: 'session_meta', payload: { id: ROOT_THREAD } },
    interruptCall(callId, target, '2026-10-06T00:00:07.000Z'),
    interruptSuccess(callId, 'running', '2026-10-06T00:00:07.100Z'),
    activityItem({ id: callId, completedAtMs }),
  ];
  return [rootEvents, childEvents];
}

/** The supported-case evidence stub the mapper consumes (exact Root/Child
 * linkage; the independent spawn-acknowledgement join recovers nothing from
 * these rollouts, so the supported linkage grounds the identity). */
const supportedEvidence = () => ({
  status: 'supported',
  facts: {
    completion: { qualified: false, processExit: null, publicResultMatched: null, decisiveEnd: null, structuralViolationCount: 0 },
    linkage: { checked: true, exact: true, agentType: 'zcode-rescue', childThreadId: CHILD_THREAD, parentThreadId: ROOT_THREAD },
    collection: { rolloutCount: 2, childToolCallCount: 4, truncated: false, excerpts: [] },
    companion: { launchCount: 1, sendCount: 1, sendCountKnown: true, duplicateLaunch: false, preLaunchDiagnostics: { excerpts: [], truncated: false } },
    handle: { originalHandleChecked: true },
    observations: { outerReturns: 1, modelCalls: 2, rootJoins: 1, decisiveWallMs: 5, pendingInnerAtEnd: false },
  },
});

const heldObservation = () => ({
  endedBeforeGate: false, budgetExpired: false, processAliveWhileHeld: true,
  result: { code: null, stdout: '', stderr: '' },
  cleanup: { label: 'observation', releasedGate: true, verifiedProcessTerminated: false, codexTerminated: false, nativeInterruptionClaimed: false, errors: [] },
  timeline: null,
});

const mapperFixture = {
  workspace: '/private/tmp/native-interruption-ws', codexHome: '/private/tmp/native-interruption-home',
  installedRoot: '/private/tmp/native-interruption-installed', env: { HOME: '/private/tmp/native-interruption-home' },
  record: { variant: 'candidate', capMs: null, pollMs: 3_600_000, appliedArtifacts: [] },
};

// --- the real pipeline, end to end ------------------------------------------

const pipeline = await import('../tools/shell-wait-probe/driver.mjs');
const { extractInterruptInteraction, admitInterruptHostDelivery, inspectShellWaitEvidence } = await import('../tools/shell-wait-probe/evidence.mjs');
const { evaluateNativeInterruptionSettlement } = await import('../tools/shell-wait-probe/release-qualification.mjs');

/** Extract → map through the REAL mapper. `heldOverrides` fakes the held-turn
 * observation record (budget/cleanup facts) — never a live host. */
const mapCausal = (rollouts, evidence = supportedEvidence(), heldOverrides = {}) => pipeline.mapShellWaitLiveFacts(
  { case: 'rescue-interrupt', pollMs: 3_600_000, waitPolicy: null, interruptBaselineSelector: null, survivalControlSelector: null },
  { ...heldObservation(), ...heldOverrides },
  evidence,
  null, null, mapperFixture, rollouts, [], LAUNCHER,
);

/** Map → serialize through the REAL serializer → reload from disk → join →
 * oracle. The returned verdict is the persisted record's offline Gate-D
 * adjudication, never a hand-set boolean. */
async function adjudicate(t, rollouts, evidence = supportedEvidence()) {
  const facts = mapCausal(rollouts, evidence);
  const root = await mkdtemp(join(tmpdir(), 'shell-wait-native-interruption-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const persistFixture = { ...mapperFixture, dispose: async () => {} };
  await pipeline.runShellWaitCase(
    { case: 'rescue-interrupt', codexBinary: process.execPath, sourceSha: 'a'.repeat(40), workerDurationMs: 420_000, capMs: 3_600_000, pollMs: 3_600_000, budgetMs: 1_200_000, output: root },
    { createFixture: async () => persistFixture, executeLiveCase: async () => facts },
  );
  const recordName = (await readdir(root)).find((name) => name.endsWith('.record.json'));
  const reloaded = JSON.parse(await readFile(join(root, recordName), 'utf8'));
  const input = pipeline.nativeInterruptionGateDInput(reloaded);
  return { facts, record: reloaded, input, verdict: evaluateNativeInterruptionSettlement(input) };
}

// --- §24.4 counterexample matrix: every non-crediting family fails closed ---
// Each entry runs the REAL pipeline and asserts the named §24.4/§24.6/§24.7
// registration string; none may ever produce native-interrupt credit.

test('request before poll start: no pending window exists for the request to sit in', async (t) => {
  // The poll OPENS after the call: the request demonstrably precedes the
  // observation — leg (a) fails, the admission is refused by name.
  const rollouts = causalRollouts();
  const childEvents = rollouts[1];
  const pollCall = childEvents.findIndex((event) => /** @type {any} */ (event)?.payload?.call_id === 'poll-1');
  // Re-stamp the poll (call+output) after the interrupt (07.0) and drop the
  // post-call native resolution: the observation did not exist at the call.
  rollouts[1] = [
    ...childEvents.slice(0, pollCall).map((event) => event),
    fnCall('write_stdin', 'poll-1', { session_id: 5, chars: '', yield_time_ms: 60_000 }, '2026-10-06T00:00:08.000Z'),
    fnOutput('poll-1', pendingOutputBody('cell-1'), '2026-10-06T00:00:08.500Z'),
    fnCall('wait', 'outer-native', { cell_id: 'cell-1' }, '2026-10-06T00:00:09.000Z'),
    fnOutput('outer-native', nativeMarkerOutput, RESOLUTION_MS),
  ];
  const interaction = extractInterruptInteraction(rollouts, [], { childThreadId: CHILD_THREAD, command: LAUNCHER });
  assert.equal(interaction.pendingBeforeCall.observed, false, 'the poll started after the interrupt');
  const admission = admitInterruptHostDelivery(rollouts, interaction, { childThreadId: CHILD_THREAD, rootThreadId: ROOT_THREAD });
  assert.equal(admission.admitted, false);
  assert.ok(admission.reasons.includes('host-activity-without-pending-observation'), JSON.stringify(admission.reasons));
  const { facts, verdict } = await adjudicate(t, rollouts);
  assert.equal(facts.interrupt.settled, null, 'a cancellation of an observation that did not exist at the call never settles');
  assert.equal(facts.interrupt.settledBasis, 'settlement-unavailable');
  assert.ok(verdict.reasons.includes('host-activity-unadmitted'), JSON.stringify(verdict.reasons));
  assert.equal(verdict.layers.delivery, false);
});

test('prior natural completion: the pre-call resolution refuses the request window and the settlement', async (t) => {
  // The Child completed naturally BEFORE the call (the §24.4 family-(1)
  // post-completion guard): the pending window never spans the request.
  const rollouts = causalRollouts({ childTerminalBeforeCall: true, withNativeResolution: false, completedAtMs: Date.parse('2026-10-06T00:00:04.000Z') });
  const { facts, verdict } = await adjudicate(t, rollouts);
  assert.equal(facts.interrupt.settled, null);
  assert.equal(facts.interrupt.settledBasis, 'post-completion-delivery-not-attributed');
  assert.equal(facts.interrupt.hostDelivery.admitted, false);
  assert.ok(facts.interrupt.hostDelivery.reasons.includes('host-activity-without-pending-observation'), JSON.stringify(facts.interrupt.hostDelivery.reasons));
  assert.ok(verdict.reasons.includes('terminal-before-interrupt'), JSON.stringify(verdict.reasons));
});

// ---------------------------------------------------------------------------
// Native-acceptance review round (PR #73, 2026-10-26): the §24.10 grammar
// deferral EXECUTED. The plan's Task-2 bullet authorized reproducing the
// concrete finite recognition gap offline with ISOLATED SYNTHETIC bodies; the
// reviewer's repro seed (the same wrapper call shape: a binding named `r`
// parses, a binding named `result` is refused) reproduces the retained
// structural anchors (report §24.3 / N's complete shape diagnostic: NON-`r`
// binding, bound-await, literal-object argument, equal text-binding sink,
// single statement). Every test here runs the REAL extractor → mapper →
// serializer → join → oracle pipeline on synthetic rollouts — no hand-set
// booleans — and each body is a SYNTHETIC fixture: synthetic grounding does
// NOT prove conformance with the historical F/I/N bodies (the digest-only
// anchors remain the only historical link). The frozen grammar and its
// complete negative family are registered in the §24.11 amendment and in the
// BOUND_RESULT_WRAPPER_PATTERN freeze comment (evidence.mjs).
// ---------------------------------------------------------------------------

/** The anchored synthetic wrapper body (the reviewer's repro shape, single
 * content line + the trailing-newline artifact): bound-await, literal-object
 * argument, equal text-binding sink, non-`r` binding. */
const anchoredWrapperBody = (name, tool, valueJson) =>
  `const ${name} = await tools.${tool}(${valueJson}); text(${name});\n`;
const anchoredWrapperCell = (name, tool, callId, valueJson) => ({
  type: 'response_item',
  payload: { type: 'custom_tool_call', name: 'exec', call_id: callId, input: anchoredWrapperBody(name, tool, valueJson) },
});
const wrapperCellOutput = (callId, output, timestamp = null) => ({
  ...(timestamp ? stamped(timestamp, {}) : {}),
  type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: callId, output },
});
const WRAPPER_CELL_AGENT_PATH = '/root/zcode_rescue_task_1';
/** The full causal shape with the launch and poll cells as WRAPPER cells of
 * the given binding name (everything else identical to causalRollouts): the
 * §24.4 legs all satisfiable, the activity item EQUAL to the marker stamp. */
function wrapperCausalRollouts(bindingName) {
  const rollouts = causalRollouts();
  // The spawn-acknowledgement identity the independent join recovers (the
  // same shapes the §24.10 scan-abort fixture uses), so the settlement chain
  // adjudicates on identity grounding rather than the earlier
  // ordering-unbound refusal.
  rollouts[1][0] = { type: 'session_meta', payload: { id: CHILD_THREAD, parent_thread_id: ROOT_THREAD, source: { subagent: { thread_spawn: { agent_path: WRAPPER_CELL_AGENT_PATH } } } } };
  rollouts[0].splice(1, 0,
    fnCall('spawn_agent', 'spawn-1', { task_name: 'zcode_rescue_task_1', fork_turns: 'none', agent_type: 'zcode-rescue', message: 'Run the installed prepared ZCode Rescue forwarder now. Return its public stdout verbatim.' }, '2026-10-06T00:00:00.000Z'),
    { type: 'event_msg', payload: { type: 'item_completed', thread_id: ROOT_THREAD, turn_id: 'root-turn-1', item: { type: 'SubAgentActivity', model: null, reasoning_effort: null, id: 'spawn-item-1', kind: 'started', agent_thread_id: CHILD_THREAD, agent_path: WRAPPER_CELL_AGENT_PATH }, completed_at_ms: Date.parse('2026-10-06T00:00:00.500Z') } },
    fnCall('wait_agent', 'root-wait-1', { timeout_ms: 600000 }, '2026-10-06T00:00:01.000Z'),
  );
  // The launch and poll as anchored wrapper cells (call ids preserved so the
  // response linkage is unchanged).
  const launchIndex = rollouts[1].findIndex((event) => /** @type {any} */ (event)?.payload?.call_id === 'launch-1');
  rollouts[1].splice(launchIndex, 2,
    anchoredWrapperCell(bindingName, 'exec_command', 'launch-1', '{cmd:"node launcher"}'),
    wrapperCellOutput('launch-1', completedOutputBody({ output: '', exit_code: 0, session_id: 5 }), '2026-10-06T00:00:01.000Z'),
  );
  const pollIndex = rollouts[1].findIndex((event) => /** @type {any} */ (event)?.payload?.call_id === 'poll-1');
  rollouts[1].splice(pollIndex, 2,
    anchoredWrapperCell(bindingName, 'write_stdin', 'poll-1', '{session_id:5,chars:"",yield_time_ms:60000}'),
    wrapperCellOutput('poll-1', pendingOutputBody('cell-1'), '2026-10-06T00:00:02.500Z'),
  );
  return rollouts;
}
/** The REAL whole-case scan on the wrapper-cell causal shape. */
const scanWrapperCausal = (bindingName) => inspectShellWaitEvidence({
  rollouts: wrapperCausalRollouts(bindingName),
  zcodeCalls: [{ method: 'session/send', params: { sessionId: 'fake-session' } }],
  command: LAUNCHER,
  publicResult: 'ZCODE_RESCUE_PUBLIC_SENTINEL_7C9C',
  requestedPollMs: 60_000,
  workerStillAliveAfterObservation: false,
  redactions: [],
});
/** Replace the launch cell's body with an arbitrary raw candidate (the
 * negative-family driver). */
const withLaunchBody = (rollouts, body) => {
  const cellIndex = rollouts[1].findIndex((event) => /** @type {any} */ (event)?.payload?.call_id === 'launch-1' && event.payload.type === 'custom_tool_call');
  rollouts[1][cellIndex] = { type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'launch-1', input: body } };
  return rollouts;
};
const scanRollouts = (rollouts) => inspectShellWaitEvidence({
  rollouts,
  zcodeCalls: [{ method: 'session/send', params: { sessionId: 'fake-session' } }],
  command: LAUNCHER,
  publicResult: 'ZCODE_RESCUE_PUBLIC_SENTINEL_7C9C',
  requestedPollMs: 60_000,
  workerStillAliveAfterObservation: false,
  redactions: [],
});

test('wrapper-cell control differential: the causal shape with the pinned r binding runs the real scan and pipeline to the marker settlement (the harness baseline)', async (t) => {
  // The falsifiability control ON THE CURRENT ACCEPTED FAMILY: the identical
  // causal shape whose launch/poll cells carry the pinned `r` binding — this
  // control is GREEN before and after the frozen family lands, and pins the
  // verdict fields the `result` repro must reproduce IDENTICALLY (the binding
  // spelling is never a verdict input).
  const evidence = scanWrapperCausal('r');
  assert.equal(evidence.status, 'supported', JSON.stringify(evidence.inconclusive));
  const { facts, record } = await adjudicate(t, wrapperCausalRollouts('r'), evidence);
  assert.equal(facts.interrupt.settled, true);
  assert.equal(facts.interrupt.settledBasis, 'native-cancellation-settlement-after-delivery');
  assert.equal(facts.interrupt.deliveryToSettlementMs, 5000);
  assert.equal(record.interrupt.hostDelivery.acknowledgementAtResolution, 'at');
});

test('the reviewer repro: the SAME wrapper body with the binding result is admitted by the frozen anchored family and settles IDENTICALLY through the real pipeline', async (t) => {
  // THE USER'S REPRO: the same call with a binding named `result`. Before the
  // frozen family the whole-case scan aborted `unsupported-call-shape` (the
  // third instance's refusal shape — the RED evidence, reproduced on the
  // pre-fix bytes); after it the scan classifies the cell and the REAL causal
  // chain settles the delivery THROUGH the marker, with the persisted
  // interrupt block IDENTICAL to the `r` control's (the binding spelling is
  // never a verdict input — the differential is pinned structurally).
  const evidence = scanWrapperCausal('result');
  assert.equal(evidence.status, 'supported', JSON.stringify(evidence.inconclusive));
  const { facts, record } = await adjudicate(t, wrapperCausalRollouts('result'), evidence);
  assert.equal(facts.interrupt.settled, true);
  assert.equal(facts.interrupt.settledBasis, 'native-cancellation-settlement-after-delivery');
  assert.equal(facts.interrupt.deliveryToSettlementMs, 5000);
  assert.equal(record.interrupt.hostDelivery.acknowledgementAtResolution, 'at');
  const control = await adjudicate(t, wrapperCausalRollouts('r'), scanWrapperCausal('r'));
  // The one EXPECTED delta: the raw-rollout digest in the partial-facts block
  // (the rollout bytes differ by the binding spelling by construction).
  const withoutRolloutDigest = (interruptBlock) => {
    const clone = structuredClone(interruptBlock);
    if (clone.partialFacts && typeof clone.partialFacts === 'object') delete clone.partialFacts.sourceRolloutsSha256;
    return clone;
  };
  assert.deepEqual(withoutRolloutDigest(record.interrupt), withoutRolloutDigest(control.record.interrupt),
    'the r form and the result form persist IDENTICAL interrupt blocks through the real pipeline (apart from the rollout-bytes digest)');
});

test('the complete negative family still aborts the REAL scan fail-closed with the body withheld (each frozen negative, one named shape)', () => {
  // Every §24.11-registered negative, one per case, through the REAL
  // whole-case scan: the anchored-family candidates that must stay refused.
  const negatives = [
    ['mismatched sink binding', 'const result = await tools.exec_command({cmd:"node launcher"}); text(other);\n'],
    ['dynamic template argument', 'const result = await tools.exec_command({cmd:`node launcher`}); text(result);\n'],
    ['dynamic identifier argument', 'const result = await tools.exec_command(args); text(result);\n'],
    ['dynamic call-expression argument', 'const result = await tools.exec_command({cmd: buildCmd()}); text(result);\n'],
    ['unknown property tail', 'const result = await tools.exec_command({cmd:"node launcher"}); text(result.status);\n'],
    ['unknown String tail', 'const result = await tools.exec_command({cmd:"node launcher"}); text(String(result));\n'],
    ['stringify tail under the anchored family', 'const result = await tools.exec_command({cmd:"node launcher"}); text(JSON.stringify(result));\n'],
    ['let declaration', 'let result = await tools.exec_command({cmd:"node launcher"}); text(result);\n'],
    ['over-64-char binding name', `const ${'a'.repeat(65)} = await tools.exec_command({cmd:"node launcher"}); text(${'a'.repeat(65)});\n`],
    ['dollar character in the name', 'const re$sult = await tools.exec_command({cmd:"node launcher"}); text(re$sult);\n'],
    ['leading digit in the name', 'const 1result = await tools.exec_command({cmd:"node launcher"}); text(1result);\n'],
    ['valid directive still not in the family', '// @exec: {"yield_time_ms": 3600000}\nconst result = await tools.exec_command({cmd:"node launcher"}); text(result);\n'],
    ['interior newline (same-line rule)', 'const result = await tools.exec_command({cmd:"node launcher"});\ntext(result);\n'],
    ['trailing blank line', 'const result = await tools.exec_command({cmd:"node launcher"}); text(result);\n\n'],
    ['over-limit argument', `const result = await tools.exec_command({cmd:"${'x'.repeat(4090)}"}); text(result);\n`],
    ['truncated emission', 'const result = await tools.exec_command({cmd:"node launcher"}); text(result\n'],
    ['hidden trailing statement', 'const result = await tools.exec_command({cmd:"node launcher"}); text(result); console.log("x");\n'],
    ['hidden second awaited call', 'const result = await tools.exec_command({cmd:"node launcher"}); text(result); const poll2 = await tools.write_stdin({session_id:5,chars:""}); text(poll2);\n'],
  ];
  for (const [label, body] of negatives) {
    const evidence = scanRollouts(withLaunchBody(wrapperCausalRollouts('result'), body));
    assert.equal(evidence.status, 'inconclusive', `${label}: must stay fail-closed`);
    assert.equal(evidence.inconclusive.reason, 'unsupported-call-shape', label);
    assert.equal(JSON.stringify(evidence.inconclusive.excerpt).includes('node launcher'), false, `${label}: the body content stays withheld`);
  }
});

test('the scan-incomplete refusal chain is unchanged for a refused anchored-family candidate (mapper overlays the registered reasons)', () => {
  // A refused anchored-family candidate (mismatched sink) keeps the FULL
  // §24.10 fail-closed chain end to end: the candidate rides as a third cell
  // beside the RECOGNIZED anchored launch/poll facts (they survive as
  // observations, never credit), the scan aborts by name, the mapper overlays
  // the registered reasons and the settlement names the ambiguous-scan
  // refusal — the §24.10 structure with the anchored family in the recognized
  // slots.
  const rollouts = wrapperCausalRollouts('result');
  rollouts[1].push({
    type: 'response_item',
    payload: { type: 'custom_tool_call', name: 'exec', call_id: 'unknown-1', input: 'const result = await tools.exec_command({cmd:"node launcher"}); text(other);\n' },
  });
  const evidence = scanRollouts(rollouts);
  assert.equal(evidence.status, 'inconclusive');
  assert.equal(evidence.inconclusive.reason, 'unsupported-call-shape');
  const facts = mapCausal(rollouts, evidence);
  assert.equal(facts.interrupt.attempted, true, 'the recognized call facts survive the aborted scan');
  assert.equal(facts.interrupt.hostDelivery.admitted, false);
  assert.ok(facts.interrupt.hostDelivery.reasons.includes('host-activity-call-scan-incomplete'), JSON.stringify(facts.interrupt.hostDelivery.reasons));
  assert.equal(facts.interrupt.settledBasis, 'ambiguous-cell-scan-incomplete-not-attributed');
  assert.equal(facts.interrupt.settled, null);
});

test('a nonterminal pre-call resolution closes the window exactly like a completion (§24.4 f3)', () => {
  // A live-handle (still-running) completion BEFORE the call resolved the
  // observation: the window does not span the request, whatever the
  // resolution's terminality (the round-1 rule, carried through the
  // relocation unchanged on the request side).
  const rollouts = causalRollouts({ withNativeResolution: false, completedAtMs: Date.parse('2026-10-06T00:00:08.500Z') });
  rollouts[1].push(
    fnCall('wait', 'outer-live', { cell_id: 'cell-1' }, '2026-10-06T00:00:03.000Z'),
    fnOutput('outer-live', completedOutputBody({ output: 'still running', session_id: 9 }), '2026-10-06T00:00:04.000Z'),
  );
  const interaction = extractInterruptInteraction(rollouts, [], { childThreadId: CHILD_THREAD, command: LAUNCHER });
  assert.equal(interaction.pendingBeforeCall.observed, false, 'the observation was already resolved at the call');
  const admission = admitInterruptHostDelivery(rollouts, interaction, { childThreadId: CHILD_THREAD, rootThreadId: ROOT_THREAD });
  assert.equal(admission.admitted, false);
  assert.ok(admission.reasons.includes('host-activity-without-pending-observation'), JSON.stringify(admission.reasons));
});

test('completion concurrent with an unorderable request stays fail-closed (no creditable ordering)', async (t) => {
  // The completion's arrival cannot be ordered against the call (untimed
  // cross-rollout events — the round-13 rule): the window claim stays
  // UNPROVEN, never observed, and nothing credits.
  const rollouts = causalRollouts({ withNativeResolution: false, completedAtMs: Date.parse('2026-10-06T00:00:08.500Z') });
  rollouts[1].push(
    fnCall('wait', 'outer-unordered', { cell_id: 'cell-1' }),
    fnOutput('outer-unordered', completedOutputBody({ output: 'done', exit_code: 0 })),
  );
  const interaction = extractInterruptInteraction(rollouts, [], { childThreadId: CHILD_THREAD, command: LAUNCHER });
  assert.equal(interaction.pendingBeforeCall.observed, false, 'an unorderable resolution never confirms the window');
  const admission = admitInterruptHostDelivery(rollouts, interaction, { childThreadId: CHILD_THREAD, rootThreadId: ROOT_THREAD });
  assert.equal(admission.admitted, false);
  assert.ok(admission.reasons.includes('host-activity-without-pending-observation'), JSON.stringify(admission.reasons));
  const { facts } = await adjudicate(t, rollouts);
  assert.equal(facts.interrupt.settled, null);
});

test('stale/foreign target: a sibling Child identity never joins, a prior interruption is never this delivery', async (t) => {
  // Foreign identity: the item's agent_thread_id is a SIBLING agent — the
  // exact-target conjunct refuses by name (the caller text is never
  // relabeled).
  const foreignRollouts = causalRollouts({ completedAtMs: Date.parse('2026-10-06T00:00:08.500Z') });
  const foreignItem = /** @type {any} */ (foreignRollouts[0].find((event) => /** @type {any} */ (event)?.payload?.item?.type === 'SubAgentActivity'));
  foreignItem.payload.item.agent_thread_id = 'ffffffff-ffff-4fff-8fff-fffffffffff0';
  const foreignInteraction = extractInterruptInteraction(foreignRollouts, [], { childThreadId: CHILD_THREAD, command: LAUNCHER });
  const foreignAdmission = admitInterruptHostDelivery(foreignRollouts, foreignInteraction, { childThreadId: CHILD_THREAD, rootThreadId: ROOT_THREAD });
  assert.equal(foreignAdmission.admitted, false);
  assert.equal(foreignAdmission.agentThreadIdMatch, false);
  assert.ok(foreignAdmission.reasons.includes('host-activity-agent-thread-mismatch'), JSON.stringify(foreignAdmission.reasons));
  // Stale: previous_status 'interrupted' — the interrupt landed on an
  // ALREADY-interrupted (terminal) Child (the round-20 rule keeps its basis).
  const staleRollouts = causalRollouts({ withNativeResolution: false, completedAtMs: Date.parse('2026-10-06T00:00:08.500Z') });
  const staleOutput = /** @type {any} */ (staleRollouts[0].find((event) => /** @type {any} */ (event)?.payload?.call_id === 'int-1' && event.payload.type === 'function_call_output'));
  staleOutput.payload.output = JSON.stringify({ previous_status: 'interrupted' });
  const { facts: staleFacts } = await adjudicate(t, staleRollouts);
  assert.equal(staleFacts.interrupt.settled, null);
  assert.equal(staleFacts.interrupt.settledBasis, 'previous-status-terminal-no-interruption-claim');
  assert.equal(staleFacts.interrupt.previousStatusTerminal, true);
});

test('rejected and unsent submissions never credit (f2 requires the send to have returned)', async (t) => {
  // REJECTED: the tool returned an error (interrupt_agent.rs rejects BEFORE
  // any dispatch) — a host item beside it is contradictory evidence.
  const rejectedRollouts = causalRollouts({ withNativeResolution: false, completedAtMs: Date.parse('2026-10-06T00:00:08.500Z') });
  const rejectedOutput = /** @type {any} */ (rejectedRollouts[0].find((event) => /** @type {any} */ (event)?.payload?.call_id === 'int-1' && event.payload.type === 'function_call_output'));
  rejectedOutput.payload.output = JSON.stringify({ error: 'unknown agent: no such thread' });
  const rejectedInteraction = extractInterruptInteraction(rejectedRollouts, [], { childThreadId: CHILD_THREAD, command: LAUNCHER });
  assert.equal(rejectedInteraction.delivered, false);
  const rejectedAdmission = admitInterruptHostDelivery(rejectedRollouts, rejectedInteraction, { childThreadId: CHILD_THREAD, rootThreadId: ROOT_THREAD });
  assert.equal(rejectedAdmission.admitted, false);
  assert.ok(rejectedAdmission.reasons.includes('host-activity-delivery-rejected'), JSON.stringify(rejectedAdmission.reasons));
  const rejected = await adjudicate(t, rejectedRollouts);
  assert.equal(rejected.facts.interrupt.settledBasis, 'delivery-rejected-no-settlement-claim');
  assert.ok(rejected.verdict.reasons.includes('delivery-not-established'), JSON.stringify(rejected.verdict.reasons));
  // UNSENT/UNOBSERVED: no parseable tool output — the dispatch itself stays
  // unestablished.
  const unobservedRollouts = causalRollouts({ withNativeResolution: false, completedAtMs: Date.parse('2026-10-06T00:00:08.500Z') });
  const outputIndex = unobservedRollouts[0].findIndex((event) => /** @type {any} */ (event)?.payload?.call_id === 'int-1' && event.payload.type === 'function_call_output');
  unobservedRollouts[0].splice(outputIndex, 1);
  const unobservedInteraction = extractInterruptInteraction(unobservedRollouts, [], { childThreadId: CHILD_THREAD, command: LAUNCHER });
  assert.equal(unobservedInteraction.delivered, null);
  const unobservedAdmission = admitInterruptHostDelivery(unobservedRollouts, unobservedInteraction, { childThreadId: CHILD_THREAD, rootThreadId: ROOT_THREAD });
  assert.equal(unobservedAdmission.admitted, false);
  assert.ok(unobservedAdmission.reasons.includes('host-activity-delivery-unobserved'), JSON.stringify(unobservedAdmission.reasons));
  const unobserved = await adjudicate(t, unobservedRollouts);
  assert.equal(unobserved.facts.interrupt.settledBasis, 'delivery-outcome-unobserved');
  assert.ok(unobserved.verdict.reasons.includes('delivery-dispatch-unestablished'), JSON.stringify(unobserved.verdict.reasons));
});

test('an unreadable continuation keeps the settlement outcome unknown (never credited)', async (t) => {
  // A linked wait whose response arrived but fails its statement decode: the
  // outcome could be completion or termination — round-27 fail-closed.
  const rollouts = causalRollouts({ withNativeResolution: false, completedAtMs: Date.parse('2026-10-06T00:00:08.500Z') });
  rollouts[1].push(
    fnCall('wait', 'outer-unreadable', { cell_id: 'cell-1' }, '2026-10-06T00:00:09.000Z'),
    fnOutput('outer-unreadable', 'unrelated failure text', '2026-10-06T00:00:10.000Z'),
  );
  const interaction = extractInterruptInteraction(rollouts, [], { childThreadId: CHILD_THREAD, command: LAUNCHER });
  assert.equal((interaction.unparseableBoundResponses ?? 0) > 0, true);
  const { facts, verdict } = await adjudicate(t, rollouts);
  assert.equal(facts.interrupt.settled, null);
  assert.equal(facts.interrupt.settledBasis, 'unparseable-continuation-settlement-unknown');
  assert.equal(facts.interrupt.unreadableContinuationObserved, true);
  assert.ok(verdict.reasons.includes('unreadable-continuation'), JSON.stringify(verdict.reasons));
});

test('duplicate interruption: more than one attempt hides collateral interruptions — never attributed', async (t) => {
  // A SECOND interrupt-shaped call: the retained facts describe only the
  // last call, so settlement is refused by name and the admission's
  // exactly-one conjunct fails.
  const rollouts = causalRollouts();
  rollouts[0].splice(1, 0,
    interruptCall('int-0', CHILD_THREAD, '2026-10-06T00:00:06.000Z'),
    interruptSuccess('int-0', 'running', '2026-10-06T00:00:06.100Z'),
  );
  const interaction = extractInterruptInteraction(rollouts, [], { childThreadId: CHILD_THREAD, command: LAUNCHER });
  assert.equal(interaction.callCount, 2);
  const admission = admitInterruptHostDelivery(rollouts, interaction, { childThreadId: CHILD_THREAD, rootThreadId: ROOT_THREAD });
  assert.equal(admission.admitted, false);
  assert.ok(admission.reasons.includes('host-activity-call-count-not-one'), JSON.stringify(admission.reasons));
  const { facts, verdict } = await adjudicate(t, rollouts);
  assert.equal(facts.interrupt.settled, null);
  assert.equal(facts.interrupt.settledBasis, 'multiple-delivery-attempts-not-attributed');
  assert.ok(verdict.reasons.includes('host-activity-unadmitted'), JSON.stringify(verdict.reasons));
  assert.ok(verdict.reasons.includes('previous-status-snapshot-only'), 'the unadmitted multi-attempt delivery downgrades to a snapshot-only fact');
  assert.equal(verdict.qualified, false);
});

test('wrapped (code-mode) interrupt: the delegate-allocated id never joins — named unjoinable', async (t) => {
  // The §19.9 registered limitation: a custom_tool_call that JUST registered
  // the v2 interrupt statement is the wrapped shape; the nested exec id
  // never persists, so the exact-target identity conjunct is unsatisfiable.
  const rollouts = [[
    { type: 'session_meta', payload: { id: ROOT_THREAD } },
    { type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'int-1', input: `text(await tools.interrupt_agent({ "target": "${CHILD_THREAD}" }));\n` } },
    { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'int-1', output: JSON.stringify({ previous_status: 'running' }) } },
    activityItem({ id: 'int-1', completedAtMs: Date.parse('2026-10-06T00:00:08.500Z') }),
  ], ...causalRollouts().slice(1)];
  const interaction = extractInterruptInteraction(rollouts, [], { childThreadId: CHILD_THREAD, command: LAUNCHER });
  assert.equal(interaction.wrappedInterrupt, true);
  const admission = admitInterruptHostDelivery(rollouts, interaction, { childThreadId: CHILD_THREAD, rootThreadId: ROOT_THREAD });
  assert.equal(admission.admitted, false);
  assert.ok(admission.reasons.includes('host-activity-wrapped-interrupt-unjoinable'), JSON.stringify(admission.reasons));
  const { facts, verdict } = await adjudicate(t, rollouts);
  assert.equal(facts.interrupt.settled, null);
  assert.ok(verdict.reasons.includes('host-activity-unadmitted'), JSON.stringify(verdict.reasons));
});

test('truncated/ambiguous scan: an unclassified cell blocks the exactly-one conjunct through the REAL analyzer', () => {
  // The §23.15 discipline through the real whole-case analyzer: an
  // unclassifiable cell body (a non-recognized statement grammar — the same
  // wrapper family the retained F/I records withhold) aborts the scan — the
  // recognized call facts ride as observations while the admission gains the
  // named scan reason and the settlement names the ambiguous-scan refusal.
  // One recognized interrupt is never "exactly one" while an unclassified
  // cell could hide another.
  const rollouts = causalRollouts();
  // The spawn acknowledgement markers the independent identity join recovers
  // (the same shapes the §23.15 abort fixtures use): with the recovered
  // identity grounding the binding, the settlement chain reaches the
  // scan-incompleteness refusal instead of the earlier ordering-unbound one.
  const AGENT_PATH = '/root/zcode_rescue_task_1';
  rollouts[1][0] = { type: 'session_meta', payload: { id: CHILD_THREAD, parent_thread_id: ROOT_THREAD, source: { subagent: { thread_spawn: { agent_path: AGENT_PATH } } } } };
  rollouts[0].splice(1, 0,
    fnCall('spawn_agent', 'spawn-1', { task_name: 'zcode_rescue_task_1', fork_turns: 'none', agent_type: 'zcode-rescue', message: 'Run the installed prepared ZCode Rescue forwarder now. Return its public stdout verbatim.' }, '2026-10-06T00:00:00.000Z'),
    { type: 'event_msg', payload: { type: 'item_completed', thread_id: ROOT_THREAD, turn_id: 'root-turn-1', item: { type: 'SubAgentActivity', model: null, reasoning_effort: null, id: 'spawn-item-1', kind: 'started', agent_thread_id: CHILD_THREAD, agent_path: AGENT_PATH }, completed_at_ms: Date.parse('2026-10-06T00:00:00.500Z') } },
    fnCall('wait_agent', 'root-wait-1', { timeout_ms: 600000 }, '2026-10-06T00:00:01.000Z'),
  );
  rollouts[1].push(
    { type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'unknown-1', input: 'console.log("synthetic-unknown-cell");\n' } },
  );
  const evidence = inspectShellWaitEvidence({
    rollouts,
    zcodeCalls: [{ method: 'session/send', params: { sessionId: 'fake-session' } }],
    command: LAUNCHER,
    publicResult: 'ZCODE_RESCUE_PUBLIC_SENTINEL_7C9C',
    requestedPollMs: 60_000,
    workerStillAliveAfterObservation: false,
    redactions: [],
  });
  assert.equal(evidence.status, 'inconclusive');
  assert.equal(evidence.inconclusive.reason, 'unsupported-call-shape');
  const facts = mapCausal(rollouts, evidence);
  assert.equal(facts.interrupt.attempted, true, 'the recognized call facts survive the aborted scan');
  assert.equal(facts.interrupt.callCount, 1, 'the RECOGNIZED count — never a completeness claim');
  assert.equal(facts.interrupt.hostDelivery.admitted, false);
  assert.ok(facts.interrupt.hostDelivery.reasons.includes('host-activity-call-scan-incomplete'), JSON.stringify(facts.interrupt.hostDelivery.reasons));
  assert.equal(facts.interrupt.settledBasis, 'ambiguous-cell-scan-incomplete-not-attributed');
  assert.equal(facts.interrupt.settled, null, 'recognized f1/f2 facts keep riding as observations, never credit');
});

test('incompatible/absent clocks: unresolvable ordering binding and unstamped events keep the trial uncredited', () => {
  // Family (2)+(9): with no resolvable Child binding the ordering is unbound
  // (the held monotonic clock is never joined to epoch stamps), and with NO
  // event stamps at all no epoch-measurable interval exists
  // (`timingBasis: 'unavailable'`).
  const unstamped = causalRollouts().map((events) => events.map((event) => {
    const clone = { ...event };
    delete clone.timestamp;
    return clone;
  }));
  // No identity evidence at all: the linkage and the spawn join stay null.
  const anonymousEvidence = { ...supportedEvidence(), facts: { ...supportedEvidence().facts, linkage: { checked: true, exact: false, agentType: 'zcode-rescue', childThreadId: null, parentThreadId: null } } };
  const facts = mapCausal(unstamped, anonymousEvidence);
  assert.equal(facts.interrupt.orderingBound, false);
  assert.equal(facts.interrupt.settled, null);
  assert.equal(facts.interrupt.settledBasis, 'ordering-unbound-not-attributed');
  assert.equal(facts.interrupt.pendingIntervalMs, null);
  assert.equal(facts.interrupt.timingBasis, 'unavailable', 'no epoch interval is measurable — never borrowed from the held monotonic clock');
});

test('explicit cell terminate: window-closing evidence only, never native settlement credit', async (t) => {
  // The alternate ender's own stop produces the SAME framing a native
  // cancellation produces — the round-10 classification keeps it separately
  // named and never credits it as the delivery's settlement.
  const rollouts = causalRollouts({ withNativeResolution: false });
  rollouts[1].push(
    fnCall('wait', 'term-1', { session_id: 5, cell_id: 'cell-1', terminate: true }, '2026-10-06T00:00:09.000Z'),
    fnOutput('term-1', [
      { type: 'input_text', text: 'Script terminated\nWall time 0.1 seconds\nOutput:\n' },
      { type: 'input_text', text: 'terminated\n' },
    ], RESOLUTION_MS),
  );
  const interaction = extractInterruptInteraction(rollouts, [], { childThreadId: CHILD_THREAD, command: LAUNCHER });
  assert.equal(interaction.settledAfterCall.atMs, null, 'an explicit stop is never a settlement');
  assert.equal(interaction.resolvedExplicitStopAfterCall.atMs, RESOLUTION_MS);
  const { facts } = await adjudicate(t, rollouts);
  assert.equal(facts.interrupt.settled, null);
  assert.equal(facts.interrupt.settledBasis, 'explicit-cell-termination-not-attributed');
  assert.equal(facts.interrupt.deliveryToSettlementMs, null, 'no latency is ever measured against an explicit stop');
});

test('budget cleanup: a marker at/after the cleanup boundary is the kill resolution, never native settlement', () => {
  // The observation was still unsettled at budget expiry; the collected
  // marker is PRESUMED to be the cleanup kill's resolution (the round-19
  // semantics — here with the kill demonstrably initiated and no recordable
  // boundary, the fail-closed arm).
  const rollouts = causalRollouts();
  const held = {
    budgetExpired: true,
    cleanup: { label: 'budget', releasedGate: true, verifiedProcessTerminated: true, codexTerminated: true, nativeInterruptionClaimed: false, errors: [] },
  };
  const facts = mapCausal(rollouts, supportedEvidence(), held);
  assert.equal(facts.interrupt.settled, null);
  assert.equal(facts.interrupt.settledBasis, 'budget-cleanup-termination-not-attributed');
  assert.equal(facts.interrupt.settlementCleanupGenerated, true, 'the cleanup-generated attribution rides the record');
  assert.equal(facts.interrupt.deliveryToSettlementMs, null);
});

test('genuine later SessionEnd: its own stop cause rides verbatim and never settles the interrupt (cause discipline through the join)', () => {
  // The §23.5 join-level cause discipline: a pre-boundary sample whose
  // winner rode a REAL session-end stop intent is an OBSERVED LAYER FACT
  // ONLY — the Gate-D terminal-winner conjunct is never flipped by it, and
  // the interrupt block's unattributed settlement stands.
  const sample = {
    attemptIndex: 42, baseline: false, transition: true,
    startedAtMs: 1000, completedAtMs: 2000,
    aggregate: 'settled', jobPresence: 'found', jobStatus: 'cancelled',
    stopCause: 'session-end', stopIntentCause: 'session-end', stopIntentRequestedAt: '2026-10-24T15:32:38.087Z',
    executorLinkage: 'verified', snapshotEqual: true, lockState: null, partitionStatus: null,
    layers: { bindingCurrency: { state: 'current', anchorsJob: 'job-1' } },
  };
  const record = {
    case: 'rescue-interrupt',
    linkage: { childThreadId: CHILD_THREAD, parentThreadId: ROOT_THREAD },
    interrupt: {
      attempted: true, delivered: true, exactTargetMatch: true, settled: null,
      settledBasis: 'submission-enqueued-unresolved', deliveryToSettlementMs: null,
      pendingWindowObserved: true, previousStatus: 'running', unreadableContinuationObserved: false,
      hostDelivery: {
        checked: true, attemptedCall: true, callId: 'int-1', itemPresent: true, interruptedItemCount: 1,
        joinedItemCount: 1, foreignItemCount: 0, idJoin: true, idJoinBasis: 'outer-call-id',
        agentThreadIdMatch: true, rootRolloutOwned: true, insidePendingWindow: true,
        acknowledgementAtResolution: 'unestablishable', timed: true, completedAtMs: 1500,
        admitted: true, reasons: [],
      },
    },
    observations: {},
    child: {
      settlementLayers: null,
      durableSnapshot: { aggregate: 'unresolved', executorLinkage: 'verified', completedAtMs: 3000, passive: { snapshotEqual: true }, job: { presence: 'found', projection: { id: 'job-1', status: null, ownerSessionId: ROOT_THREAD } } },
      durableSamples: { version: 1, summaries: [sample] },
    },
    survivalControl: null,
  };
  const input = pipeline.nativeInterruptionGateDInput(record);
  assert.equal(input.durableObligations, 'unresolved', 'the sample grounds the OBSERVED obligations layer fact');
  assert.equal(input.terminalWinner, null, 'the final snapshot is not fenced here, but its job status is null — never the sample winner');
  assert.equal(input.turnSettled, null, 'the interrupt block stays unattributed: the session end is not the interrupt settlement');
  assert.equal(input.durableSamplesJoin.admitted[0].stopCause, 'session-end', 'the cause provenance rides verbatim');
  const verdict = evaluateNativeInterruptionSettlement(input);
  assert.equal(verdict.qualified, false);
  assert.ok(verdict.reasons.includes('turn-settlement-unobserved'), JSON.stringify(verdict.reasons));
  assert.ok(verdict.reasons.includes('survival-control-unadjudicated'), JSON.stringify(verdict.reasons));
});

// --- the two NEW §24.4 family-(10) names ------------------------------------

test('submission-enqueued-unresolved: the admitted f2 with no f4 resolution never credits', async (t) => {
  // The three-leg rule: (a) the request sits inside the proven pending
  // window, (b) the host-side submission result is admitted — but (c) NO
  // Child resolution ever joined (the observation never resolved). The
  // enqueued-but-unresolved submission is named, never credited.
  const rollouts = causalRollouts({ withNativeResolution: false, completedAtMs: Date.parse('2026-10-06T00:00:08.500Z') });
  const interaction = extractInterruptInteraction(rollouts, [], { childThreadId: CHILD_THREAD, command: LAUNCHER });
  const admission = admitInterruptHostDelivery(rollouts, interaction, { childThreadId: CHILD_THREAD, rootThreadId: ROOT_THREAD });
  assert.equal(admission.admitted, true, 'premise: f2 admits on its identity/timing conjuncts');
  assert.equal(admission.acknowledgementAtResolution, 'unestablishable', 'no closing stamp exists — the observation never resolved');
  const { facts, record, verdict } = await adjudicate(t, rollouts);
  assert.equal(facts.interrupt.settled, null, 'an enqueue fact is never a Child receipt/processing claim');
  assert.equal(facts.interrupt.settledBasis, 'submission-enqueued-unresolved');
  assert.equal(record.interrupt.settledBasis, 'submission-enqueued-unresolved', 'the REAL serializer persists the named basis');
  assert.ok(verdict.reasons.includes('turn-settlement-unobserved'), JSON.stringify(verdict.reasons));
});

test('an OBSERVED nonterminal resolution after the call is never an unresolved submission (the f4 fact must stay visible)', async (t) => {
  // Codex P2 review finding on the Task-2 fallback: a pending poll that
  // resolves after the interrupt with a completed NONTERMINAL result (the
  // live-handle `{session_id}` shape) JOINS a resolution fact —
  // `resolvedNonterminalAfterCall` is populated and the acknowledgement is
  // measured against it (`after`). The enqueued-but-unresolved basis must
  // then stay SILENT: claiming "no f4 resolution ever joined" beside a
  // recorded post-resolution acknowledgement would be contradictory evidence.
  // The observed nonterminal resolution is a resolution fact, never a
  // settlement (the round-1 rule): the outcome stays the plain unknown.
  const rollouts = causalRollouts({ withNativeResolution: false, completedAtMs: Date.parse('2026-10-06T00:00:10.500Z') });
  rollouts[1].push(
    fnCall('wait', 'outer-live', { cell_id: 'cell-1' }, '2026-10-06T00:00:09.000Z'),
    fnOutput('outer-live', completedOutputBody({ output: 'still running', session_id: 9 }), '2026-10-06T00:00:10.000Z'),
  );
  const interaction = extractInterruptInteraction(rollouts, [], { childThreadId: CHILD_THREAD, command: LAUNCHER });
  assert.equal(interaction.pendingBeforeCall.observed, true);
  assert.equal(interaction.resolvedNonterminalAfterCall.atMs, Date.parse('2026-10-06T00:00:10.000Z'),
    'the nonterminal resolution JOINED as an f4-class fact');
  const admission = admitInterruptHostDelivery(rollouts, interaction, { childThreadId: CHILD_THREAD, rootThreadId: ROOT_THREAD });
  assert.equal(admission.admitted, true, 'premise: the f2 admission holds (the window test binds to the request)');
  const { facts, record, verdict } = await adjudicate(t, rollouts);
  assert.equal(record.interrupt.hostDelivery.acknowledgementAtResolution, 'after',
    'the acknowledgement was measured against the joined nonterminal closing stamp');
  assert.equal(facts.interrupt.settled, null, 'a nonterminal resolution is never a settlement');
  assert.equal(facts.interrupt.settledBasis, 'settlement-unavailable',
    'an observed resolution is never relabeled an unresolved submission');
  assert.notEqual(facts.interrupt.settledBasis, 'submission-enqueued-unresolved');
  assert.equal(facts.interrupt.deliveryToSettlementMs, null);
  assert.ok(verdict.reasons.includes('turn-settlement-unobserved'), JSON.stringify(verdict.reasons));
});

test('already-dead-tolerance-not-a-resolution: the tolerated ThreadNotFound/InternalAgentDied send is not a Child resolution', async (t) => {
  // The pinned wrapper tolerates ThreadNotFound/InternalAgentDied as
  // already-dead SUCCESS (report §24.2): the send returned
  // (`delivered: true`) with a terminal previous status — the registered
  // family-(10) name records that this tolerated path is not an f4
  // resolution and never credits (the other terminal labels keep the
  // round-20 basis).
  for (const toleratedStatus of ['not_found', 'shutdown']) {
    const rollouts = causalRollouts({ withNativeResolution: false, completedAtMs: Date.parse('2026-10-06T00:00:08.500Z') });
    const output = /** @type {any} */ (rollouts[0].find((event) => /** @type {any} */ (event)?.payload?.call_id === 'int-1' && event.payload.type === 'function_call_output'));
    output.payload.output = JSON.stringify({ previous_status: toleratedStatus });
    const { facts } = await adjudicate(t, rollouts);
    assert.equal(facts.interrupt.delivered, true, toleratedStatus);
    assert.equal(facts.interrupt.settled, null, toleratedStatus);
    assert.equal(facts.interrupt.settledBasis, 'already-dead-tolerance-not-a-resolution', toleratedStatus);
    assert.equal(facts.interrupt.previousStatusTerminal, true, toleratedStatus);
  }
});

// --- versioning (the §24.4 duty: the changed contract is separately named) --

test('the wired choreography is versioned: join v4 (the §24.8 cutoff fence) and oracle v4 over the unchanged family stamp', async () => {
  const { NATIVE_INTERRUPTION_GATE_D_JOIN_VERSION, MEASUREMENT_CUTOFF_ENABLED_CASES } = await import('../tools/shell-wait-probe/driver.mjs');
  const { NATIVE_INTERRUPTION_ORACLE_VERSION, RELEASE_QUALIFICATION_VERSION } = await import('../tools/shell-wait-probe/release-qualification.mjs');
  assert.equal(NATIVE_INTERRUPTION_GATE_D_JOIN_VERSION, 5, 'join v5: the preserved pre-cutoff snapshot grounds the winner under its own pre-fence instant and owning-Root binding and joins the layer-evidence selection (§24.11 codex gate fix A + round 3); v4 = the persisted §24.8 measurement cutoff as the second credit fence and the relocated window inputs (§24.8/§24.11)');
  assert.equal(NATIVE_INTERRUPTION_ORACLE_VERSION, 4, 'oracle v4: the §24.4 relocated window contract (Task 3 grows only the JOIN input contract; the oracle logic is unchanged)');
  assert.equal(RELEASE_QUALIFICATION_VERSION, 1, 'the shared exact-terminal/layer family stamp stays unchanged');
  // The Task-3 schedule arms for the registered case(s) through the closed
  // producer map (the §20.8 precedent), never through call-site literals.
  assert.deepEqual([...MEASUREMENT_CUTOFF_ENABLED_CASES], ['rescue-interrupt']);
  assert.equal(Object.isFrozen(MEASUREMENT_CUTOFF_ENABLED_CASES), true);
  // No new helper module was introduced: the schedule lives in driver.mjs and
  // the readiness arm in evidence.mjs, whose module-init bytes are ALREADY
  // observer-provenance digest inputs, so the digest moves with these bytes
  // without any digest-input growth (the plan's helper rule).
  assert.match(String(pipeline.EXECUTING_OBSERVER_PROVENANCE.digestInput), /evidence\.mjs/u);
});

// --- unknown vs conflict semantics (plan Task 2, §24.4 family (6)) ----------

test('an unavailable identity field stays unestablished — never positive or negative evidence', () => {
  // Without any resolvable Child id the agent_thread conjunct is
  // UNESTABLISHED (null, named) — never read as a mismatch and never as a
  // match (the unknown-vs-conflict rule).
  const rollouts = causalRollouts({ withNativeResolution: false, completedAtMs: Date.parse('2026-10-06T00:00:08.500Z') });
  const interaction = extractInterruptInteraction(rollouts, [], { childThreadId: CHILD_THREAD, command: LAUNCHER });
  const admission = admitInterruptHostDelivery(rollouts, interaction, { childThreadId: null, rootThreadId: ROOT_THREAD });
  assert.equal(admission.agentThreadIdMatch, null, 'unavailable identity is never folded into a boolean');
  assert.ok(admission.reasons.includes('host-activity-child-identity-unestablished'), JSON.stringify(admission.reasons));
  assert.equal(admission.admitted, false);
});

test('conflicting identity sources: a cross-source Root disagreement refuses through BOTH sources, the sample fallback and the oracle', () => {
  // The close-out-6 union gate at record level: the §23.4 spawn-recovery
  // block and the supported-case linkage BOTH exact, DISAGREEING on the Root
  // — contradictory identity evidence, named once
  // (`owning-root-identity-conflict`), with every durable-side credit
  // consumer refused (obligations, Companion outcome, terminal winner and
  // any pre-boundary sample fallback).
  const record = {
    case: 'rescue-interrupt',
    linkage: { childThreadId: CHILD_THREAD, parentThreadId: 'root-b-linkage-session' },
    interrupt: {
      attempted: true, delivered: true, exactTargetMatch: true, settled: true,
      settledBasis: 'native-cancellation-settlement-after-delivery', deliveryToSettlementMs: 5000,
      pendingWindowObserved: true, previousStatus: 'running', unreadableContinuationObserved: false,
      partialFacts: {
        adjudicator: 'interrupt-partial-facts', version: 1, basis: 'raw-rollout-fixture-proof',
        sourceRolloutsSha256: 'a'.repeat(64),
        capture: { rolloutsCaptured: true, rolloutCount: 2, rolloutsFailureReason: null },
        adjudication: 'supported',
        spawnIdentity: { checked: true, exact: true, reason: null, childThreadId: CHILD_THREAD, parentThreadId: 'root-a-spawn-session' },
      },
      hostDelivery: {
        checked: true, attemptedCall: true, callId: 'int-1', itemPresent: true, interruptedItemCount: 1,
        joinedItemCount: 1, foreignItemCount: 0, idJoin: true, idJoinBasis: 'outer-call-id',
        agentThreadIdMatch: true, rootRolloutOwned: true, insidePendingWindow: true,
        acknowledgementAtResolution: 'at', timed: true, completedAtMs: 123,
        admitted: true, reasons: [],
      },
    },
    observations: {},
    child: {
      settlementLayers: null,
      durableSnapshot: {
        aggregate: 'settled', executorLinkage: 'verified', completedAtMs: 3000, passive: { snapshotEqual: true },
        job: { presence: 'found', projection: { id: 'job-1', status: 'succeeded', ownerSessionId: 'root-a-spawn-session' } },
      },
      durableSamples: {
        version: 1,
        summaries: [{
          attemptIndex: 7, baseline: false, transition: false, startedAtMs: 1000, completedAtMs: 2000,
          aggregate: 'settled', jobPresence: 'found', jobStatus: 'succeeded',
          stopCause: null, stopIntentCause: null, stopIntentRequestedAt: null,
          executorLinkage: 'verified', snapshotEqual: true, lockState: null, partitionStatus: null,
          layers: { bindingCurrency: { state: 'current', anchorsJob: 'job-1' } },
        }],
      },
    },
    survivalControl: { noCollateralQualified: true, reason: null, postDelivery: 'alive', releaseQualificationVersion: 1 },
  };
  const input = pipeline.nativeInterruptionGateDInput(record);
  assert.equal(input.spawnIdentityJoin.exact, true, 'premise: both sources are exact');
  assert.equal(input.spawnIdentityJoin.owningRootBound, false, 'the cross-source disagreement is the conflict shape');
  assert.equal(input.durableObligations, null, 'the obligations never join under the conflict');
  assert.equal(input.companionOutcome, null);
  assert.equal(input.terminalWinner, null);
  assert.equal(input.durableSamplesJoin.settlementFallback.used, false, 'the pre-boundary sample fallback never fires under the conflict');
  assert.equal(input.durableSamplesJoin.settlementFallback.basis, 'durable-owner-identity-conflict', 'the named conflict basis rides the provenance block');
  assert.equal(input.durableSamplesJoin.admitted.length, 1, 'the sample still rides as an OBSERVATION fact — never erased, never credit');
  const verdict = evaluateNativeInterruptionSettlement(input);
  assert.equal(verdict.qualified, false, 'conflicted evidence can never qualify');
  assert.ok(verdict.reasons.includes('owning-root-identity-conflict'), JSON.stringify(verdict.reasons));
  // The distinction holds: one-side-unresolvable stays the named-unestablished
  // path, never conflated with the conflict.
  const anonymous = pipeline.nativeInterruptionGateDInput({
    ...record,
    linkage: { childThreadId: CHILD_THREAD, parentThreadId: null },
    interrupt: { ...record.interrupt, partialFacts: undefined },
  });
  assert.equal(anonymous.spawnIdentityJoin, null, 'no exact source at all: the join is unestablished, never conflicting');
  assert.equal(anonymous.durableObligations, 'settled', 'an unresolvable (not conflicting) Root keeps the durable facts');
  const anonymousVerdict = evaluateNativeInterruptionSettlement(anonymous);
  assert.ok(!anonymousVerdict.reasons.includes('owning-root-identity-conflict'), JSON.stringify(anonymousVerdict.reasons));
});

// --- the legacy-record replay mechanism (the committed offline arm) ---------

test('a legacy §19.4-era admission block (no acknowledgement fact) replays with the fact null and the verdict fields unchanged', () => {
  // The committed arm of the §24.4 falsification duty: a record persisted by
  // the PRE-relocation join/oracle (its hostDelivery block carries no
  // `acknowledgementAtResolution` — exactly the retained F/I record shape)
  // replays under join v3 / oracle v4 with the new fact null and every
  // verdict field byte-identical. (The REAL F/I replay against the retained
  // digested records is executed and recorded in the report — the records
  // are machine-local retained evidence, never committed bytes.)
  const legacyRecord = {
    case: 'rescue-interrupt',
    linkage: { childThreadId: CHILD_THREAD, parentThreadId: ROOT_THREAD },
    interrupt: {
      attempted: true, delivered: true, exactTargetMatch: true, settled: null,
      settledBasis: 'delivery-target-unmatched-no-settlement-claim', deliveryToSettlementMs: null,
      pendingWindowObserved: true, previousStatus: 'running', unreadableContinuationObserved: false,
      hostDelivery: {
        checked: true, attemptedCall: true, callId: 'int-1', itemPresent: true, interruptedItemCount: 1,
        joinedItemCount: 1, foreignItemCount: 0, idJoin: true, idJoinBasis: 'outer-call-id',
        agentThreadIdMatch: true, rootRolloutOwned: true, insidePendingWindow: false,
        timed: true, completedAtMs: 123,
        admitted: false, reasons: ['host-activity-after-settlement'],
      },
    },
    observations: {},
    child: { settlementLayers: null, durableSnapshot: null },
    survivalControl: null,
  };
  const input = pipeline.nativeInterruptionGateDInput(legacyRecord);
  assert.equal(input.delivery.acknowledgementAtResolution, null, 'the new fact is null on every legacy block — never invented');
  assert.equal(input.delivery.hostActivityAdmitted, false, 'the persisted verdict is consumed as persisted');
  const verdict = evaluateNativeInterruptionSettlement(input);
  assert.equal(verdict.qualified, false);
  assert.ok(verdict.reasons.includes('host-activity-unadmitted'), JSON.stringify(verdict.reasons));
  assert.equal(verdict.nativeInterruptionOracleVersion, 4, 'the replay is stamped under the NEW version, never re-stamped as the old one');
});

// --- §24.4 RED: the item-at-resolution acknowledgement shape ----------------

test('the submission-result item emitted AT the native resolution admits as f2 while the request carries the window (§24.4 relocation)', async (t) => {
  // The F-record shape (report §24.3): the host emits the interrupted item at
  // the cancellation-marker millisecond. The OLD §19.4 conjunct 4 read that
  // stamp as an at-resolution emission and refused the admission
  // (`host-activity-after-settlement`) — failing closed BY DESIGN on the
  // physically expected shape. The relocated contract (§24.4): the
  // [poll start, resolution) window binds to the REQUEST (the call sits
  // strictly inside [00:02, 00:12) on the one rollout-event clock — the
  // cross-rollout timestamp/bounds witness), the item admits through its
  // identity/timing conjuncts, and its stamp's relation to the resolution is
  // the typed acknowledgement shape `at` — an enqueue fact that never by
  // itself claims Child receipt or processing.
  const rollouts = causalRollouts();
  const interaction = extractInterruptInteraction(rollouts, [], { childThreadId: CHILD_THREAD, command: LAUNCHER });
  assert.equal(interaction.pendingBeforeCall.observed, true, 'the request-side pending window is proven');
  assert.equal(interaction.callAtMs, CALL_MS);
  const admission = admitInterruptHostDelivery(rollouts, interaction, { childThreadId: CHILD_THREAD, rootThreadId: ROOT_THREAD });
  assert.equal(admission.admitted, true, `the at-resolution acknowledgement admits through identity/timing: ${JSON.stringify(admission.reasons)}`);
  assert.equal(admission.acknowledgementAtResolution, 'at', 'the emission stamp EQUALS the resolution stamp: the recorded shape is `at`');
  assert.equal(admission.insidePendingWindow, true, 'the WINDOW conjunct reads the REQUEST position, not the emission stamp');
  assert.deepEqual(admission.reasons, [], 'no contradiction guard fires on the physically expected shape');
  // The f2/f4 distinction: the acknowledgement is an enqueue fact; the
  // Child-side settlement is attributed through the independent f4 resolution
  // (the native cancellation marker), never through the item.
  const { facts, record, input, verdict } = await adjudicate(t, rollouts);
  assert.equal(record.interrupt.hostDelivery.admitted, true, 'the REAL serializer persists the admitted f2');
  assert.equal(record.interrupt.hostDelivery.acknowledgementAtResolution, 'at');
  assert.equal(facts.interrupt.settled, true, 'f4: the native cancellation resolving the pending observation settles the turn');
  assert.equal(facts.interrupt.settledBasis, 'native-cancellation-settlement-after-delivery');
  assert.equal(facts.interrupt.deliveryToSettlementMs, RESOLUTION_MS - CALL_MS, 'the latency joins the request to the f4 resolution on one clock');
  assert.equal(input.delivery.hostActivityAdmitted, true, 'the offline join consumes the persisted admission');
  assert.equal(input.delivery.acknowledgementAtResolution, 'at');
  assert.equal(verdict.qualified, false, 'the remaining unobserved layers keep the case unqualified (fail closed)');
  assert.ok(!verdict.reasons.includes('host-activity-unadmitted'), `the admission conjunct no longer fails: ${JSON.stringify(verdict.reasons)}`);
  assert.ok(!verdict.reasons.includes('delivery-target-unmatched'), `the admitted item establishes the exact target: ${JSON.stringify(verdict.reasons)}`);
  assert.equal(verdict.layers.delivery, true, 'the delivery layer passes on the admitted f2');
});

test('the same at-resolution acknowledgement WITHOUT independent pending-request proof stays refused (the paired counterexample)', async (t) => {
  // Drop the pending-request proof: the observation resolved BEFORE the call
  // (prior natural completion). The item at the resolution stamp then joins
  // nothing pending — leg (a) fails and the admission stays refused even
  // though the f2 stamp shape is identical.
  const rollouts = causalRollouts({ childTerminalBeforeCall: true, withNativeResolution: false, completedAtMs: Date.parse('2026-10-06T00:00:04.000Z') });
  const interaction = extractInterruptInteraction(rollouts, [], { childThreadId: CHILD_THREAD, command: LAUNCHER });
  assert.equal(interaction.pendingBeforeCall.observed, false, 'the observation was not pending at the call');
  const admission = admitInterruptHostDelivery(rollouts, interaction, { childThreadId: CHILD_THREAD, rootThreadId: ROOT_THREAD });
  assert.equal(admission.admitted, false);
  assert.ok(admission.reasons.includes('host-activity-without-pending-observation'), JSON.stringify(admission.reasons));
  const { record, verdict } = await adjudicate(t, rollouts);
  assert.equal(record.interrupt.hostDelivery.admitted, false);
  assert.equal(record.interrupt.settled, null, 'no f4 resolution is attributed to the delivery');
  assert.ok(verdict.reasons.includes('host-activity-unadmitted'), JSON.stringify(verdict.reasons));
  assert.equal(verdict.layers.delivery, false);
});

// --- native-acceptance Task 3: the registered choreography wired through the
// REAL live executor and the persisted record (report §24.8/§24.10 handoff) ---

const MEASUREMENT_CUTOFF_AT_MS = Date.parse('2026-10-06T00:07:12.000Z');

const heldObservationWithSchedule = () => ({
  ...heldObservation(),
  cleanup: {
    ...heldObservation().cleanup,
    // The §24.8 measurement cutoff fact the held turn computes AT the
    // hold-deadline crossing, before any teardown (the wired schedule fact).
    measurementCutoffAtMs: MEASUREMENT_CUTOFF_AT_MS,
  },
});

/** Map with the §24.8 schedule facts carried by the held record. */
const mapScheduled = (rollouts, evidence = supportedEvidence(), heldOverrides = {}) => pipeline.mapShellWaitLiveFacts(
  { case: 'rescue-interrupt', pollMs: 3_600_000, waitPolicy: null, interruptBaselineSelector: null, survivalControlSelector: null },
  { ...heldObservationWithSchedule(), ...heldOverrides },
  evidence,
  null, null, mapperFixture, rollouts, [], LAUNCHER,
);

/** Serialize → reload with the held schedule facts, for the offline join. */
async function adjudicateScheduled(t, rollouts, evidence = supportedEvidence(), heldOverrides = {}) {
  const facts = mapScheduled(rollouts, evidence, heldOverrides);
  const root = await mkdtemp(join(tmpdir(), 'shell-wait-native-interruption-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const persistFixture = { ...mapperFixture, dispose: async () => {} };
  await pipeline.runShellWaitCase(
    { case: 'rescue-interrupt', codexBinary: process.execPath, sourceSha: 'a'.repeat(40), workerDurationMs: 420_000, capMs: 3_600_000, pollMs: 3_600_000, budgetMs: 1_200_000, output: root },
    { createFixture: async () => persistFixture, executeLiveCase: async () => facts },
  );
  const recordName = (await readdir(root)).find((name) => name.endsWith('.record.json'));
  const reloaded = JSON.parse(await readFile(join(root, recordName), 'utf8'));
  const input = pipeline.nativeInterruptionGateDInput(reloaded);
  return { facts, record: reloaded, input, verdict: evaluateNativeInterruptionSettlement(input) };
}

test('§24.4 window inputs and the §24.8 measurement cutoff ride the REAL executor path through serialize→reload (success path)', async (t) => {
  // Task 3 (report §24.10 handoff): the relocated causal contract's REQUEST
  // -side witness inputs (f1: the call's attributable position and bounds;
  // f3: the attributable pending start) and the measurement-cutoff instant
  // (§24.8, computed by the held turn at the hold-deadline crossing) are
  // produced by the actual mapper over the actual extractor and persist on
  // the REAL serialized record — the offline join exposes them additively.
  const { record, input } = await adjudicateScheduled(t, causalRollouts());
  assert.equal(record.interrupt.callAtMs, CALL_MS, 'the f1 request instant persists');
  assert.equal(record.interrupt.pendingBeforeCallAtMs, Date.parse('2026-10-06T00:00:02.500Z'), 'the f3 attributable pending start persists');
  assert.equal(record.interrupt.measurementCutoffAtMs, MEASUREMENT_CUTOFF_AT_MS, 'the §24.8 cutoff instant persists');
  assert.equal(input.delivery.relocatedWindowInputs.callAtMs, CALL_MS, 'the offline join consumes the persisted window inputs');
  assert.equal(input.delivery.relocatedWindowInputs.pendingBeforeCallAtMs, Date.parse('2026-10-06T00:00:02.500Z'));
  assert.equal(input.measurementCutoffAtMs, MEASUREMENT_CUTOFF_AT_MS, 'the offline join consumes the persisted cutoff');
  assert.equal(input.delivery.acknowledgementAtResolution, 'at', 'the Task-2 acknowledgement shape still rides beside the new facts');
});

test('the same new facts ride the independently recovered partial-facts path (the abort branch)', async (t) => {
  // The §23.4 abort path (the whole-case analysis aborted on an unsupported
  // cell while rollouts were captured) keeps the raw-rollout layer facts —
  // the Task-3 facts are part of that layer block, never a supported-case
  // -only fact.
  const rollouts = causalRollouts();
  const AGENT_PATH = '/root/zcode_rescue_task_1';
  rollouts[1][0] = { type: 'session_meta', payload: { id: CHILD_THREAD, parent_thread_id: ROOT_THREAD, source: { subagent: { thread_spawn: { agent_path: AGENT_PATH } } } } };
  rollouts[0].splice(1, 0,
    fnCall('spawn_agent', 'spawn-1', { task_name: 'zcode_rescue_task_1', fork_turns: 'none', agent_type: 'zcode-rescue', message: 'Run the installed prepared ZCode Rescue forwarder now. Return its public stdout verbatim.' }, '2026-10-06T00:00:00.000Z'),
    { type: 'event_msg', payload: { type: 'item_completed', thread_id: ROOT_THREAD, turn_id: 'root-turn-1', item: { type: 'SubAgentActivity', model: null, reasoning_effort: null, id: 'spawn-item-1', kind: 'started', agent_thread_id: CHILD_THREAD, agent_path: AGENT_PATH }, completed_at_ms: Date.parse('2026-10-06T00:00:00.500Z') } },
    fnCall('wait_agent', 'root-wait-1', { timeout_ms: 600000 }, '2026-10-06T00:00:01.000Z'),
  );
  rollouts[1].push(
    { type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'unknown-1', input: 'console.log("synthetic-unknown-cell");\n' } },
  );
  const evidence = inspectShellWaitEvidence({
    rollouts,
    zcodeCalls: [{ method: 'session/send', params: { sessionId: 'fake-session' } }],
    command: LAUNCHER,
    publicResult: 'ZCODE_RESCUE_PUBLIC_SENTINEL_7C9C',
    requestedPollMs: 60_000,
    workerStillAliveAfterObservation: false,
    redactions: [],
  });
  assert.equal(evidence.status, 'inconclusive', 'premise: the whole-case adjudication aborted');
  const { record } = await adjudicateScheduled(t, rollouts, evidence);
  assert.equal(record.interrupt.attempted, true, 'the recognized call facts ride the abort branch');
  assert.equal(record.interrupt.callAtMs, CALL_MS, 'the window inputs persist on the abort branch too');
  assert.equal(record.interrupt.measurementCutoffAtMs, MEASUREMENT_CUTOFF_AT_MS);
  assert.ok(record.interrupt.partialFacts, 'the §23.4 partial-facts block still rides');
});

test('the error path persists the new facts from the carried liveFacts', async (t) => {
  // A failed observation must not erase its evidence: the executor's failure
  // path maps the surviving held record and persists the redacted record —
  // the Task-3 facts ride that record exactly like the success path.
  const root = await mkdtemp(join(tmpdir(), 'shell-wait-native-interruption-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const facts = mapScheduled(causalRollouts());
  facts.held.endedBeforeGate = false;
  const persistFixture = { ...mapperFixture, dispose: async () => {} };
  await assert.rejects(pipeline.runShellWaitCase(
    { case: 'rescue-interrupt', codexBinary: process.execPath, sourceSha: 'a'.repeat(40), workerDurationMs: 420_000, capMs: 3_600_000, pollMs: 3_600_000, budgetMs: 1_200_000, output: root },
    {
      createFixture: async () => persistFixture,
      executeLiveCase: async () => {
        throw Object.assign(new Error('the held observation failed'), { liveFacts: facts });
      },
    },
  ));
  const recordName = (await readdir(root)).find((name) => name.endsWith('.record.json'));
  const reloaded = JSON.parse(await readFile(join(root, recordName), 'utf8'));
  assert.equal(reloaded.status, 'failed', 'the failed record was persisted before disposal');
  assert.equal(reloaded.interrupt.measurementCutoffAtMs, MEASUREMENT_CUTOFF_AT_MS);
  assert.equal(reloaded.interrupt.callAtMs, CALL_MS);
});

test('the early-exit path persists the new facts and the identity-establishment facts', async (t) => {
  // endedBeforeGate runs keep every §24.4/§24.8 fact that was already
  // observed, and the Task-3 process-identity establishment facts ride the
  // held block (the exact fake-ZCode identity was established before the
  // early exit, never lazily at cleanup).
  const root = await mkdtemp(join(tmpdir(), 'shell-wait-native-interruption-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const held = {
    ...heldObservationWithSchedule(),
    endedBeforeGate: true,
    cleanup: {
      ...heldObservationWithSchedule().cleanup,
      label: 'early-exit',
      identityEstablished: { established: true, capturedAtElapsedMs: 1200, basis: 'marker-nonce-start-ancestry-verified' },
    },
  };
  const facts = pipeline.mapShellWaitLiveFacts(
    { case: 'rescue-interrupt', pollMs: 3_600_000, waitPolicy: null, interruptBaselineSelector: null, survivalControlSelector: null },
    held, supportedEvidence(), null, null, mapperFixture, causalRollouts(), [], LAUNCHER,
  );
  const persistFixture = { ...mapperFixture, dispose: async () => {} };
  await pipeline.runShellWaitCase(
    { case: 'rescue-interrupt', codexBinary: process.execPath, sourceSha: 'a'.repeat(40), workerDurationMs: 420_000, capMs: 3_600_000, pollMs: 3_600_000, budgetMs: 1_200_000, output: root },
    { createFixture: async () => persistFixture, executeLiveCase: async () => facts },
  );
  const recordName = (await readdir(root)).find((name) => name.endsWith('.record.json'));
  const reloaded = JSON.parse(await readFile(join(root, recordName), 'utf8'));
  assert.equal(reloaded.interrupt.measurementCutoffAtMs, MEASUREMENT_CUTOFF_AT_MS);
  assert.deepEqual(reloaded.held.processIdentity, { established: true, capturedAtElapsedMs: 1200, basis: 'marker-nonce-start-ancestry-verified' },
    'the identity-establishment facts persist on the early-exit path');
});

test('the §24.8 measurement cutoff fences the offline join: pre-cutoff samples credit, at/after the cutoff never does', () => {
  // The cutoff is the credit fence alongside the cleanup boundary (f5): a
  // completed consistent PRE-cutoff sample is the settlement selection when
  // the final read completed at/after the cutoff; samples at/after the
  // cutoff are refused BY NAME; the fenced final read's own winner never
  // leaks through.
  const boundSample = (attemptIndex, completedAtMs) => ({
    attemptIndex, baseline: attemptIndex === 1, transition: false, startedAtMs: completedAtMs - 10, completedAtMs,
    aggregate: 'unresolved', jobPresence: 'found', jobStatus: null,
    stopCause: null, stopIntentCause: null, stopIntentRequestedAt: null,
    executorLinkage: 'verified', snapshotEqual: true, lockState: null, partitionStatus: null,
    layers: { bindingCurrency: { state: 'current', anchorsJob: 'job-1' } },
  });
  const record = {
    case: 'rescue-interrupt',
    linkage: { childThreadId: CHILD_THREAD, parentThreadId: ROOT_THREAD },
    interrupt: {
      attempted: true, delivered: true, exactTargetMatch: true, settled: null,
      settledBasis: 'submission-enqueued-unresolved', deliveryToSettlementMs: null,
      pendingWindowObserved: true, previousStatus: 'running', unreadableContinuationObserved: false,
      measurementCutoffAtMs: 20_000,
      hostDelivery: {
        checked: true, attemptedCall: true, callId: 'int-1', itemPresent: true, interruptedItemCount: 1,
        joinedItemCount: 1, foreignItemCount: 0, idJoin: true, idJoinBasis: 'outer-call-id',
        agentThreadIdMatch: true, rootRolloutOwned: true, insidePendingWindow: true,
        acknowledgementAtResolution: 'after', timed: true, completedAtMs: 15_000,
        admitted: true, reasons: [],
      },
    },
    observations: {},
    child: {
      settlementLayers: null,
      durableSnapshot: {
        aggregate: 'settled', executorLinkage: 'verified', completedAtMs: 25_000, passive: { snapshotEqual: true },
        job: { presence: 'found', projection: { id: 'job-1', status: 'succeeded', ownerSessionId: ROOT_THREAD } },
      },
      durableSamples: { version: 1, summaries: [boundSample(1, 5_000), boundSample(2, 20_000), boundSample(3, 25_000)] },
    },
    survivalControl: null,
  };
  const input = pipeline.nativeInterruptionGateDInput(record);
  assert.equal(pipeline.NATIVE_INTERRUPTION_GATE_D_JOIN_VERSION, 5, 'the cutoff fence was the join v4 input-contract growth; v5 preserves the pre-cutoff snapshot (winner + own owner binding + layer evidence)');
  assert.equal(input.measurementCutoffAtMs, 20_000);
  assert.equal(input.durableReadPostCleanupBoundary, true, 'the final read completed at/after the cutoff — credit withheld');
  assert.equal(input.durableReadBoundaryBasis, 'durable-read-at-or-after-measurement-cutoff', 'the named cutoff basis rides');
  assert.equal(input.durableSamplesJoin.settlementFallback.used, true, 'the pre-cutoff sample is the §24.8 settlement selection');
  assert.equal(input.durableSamplesJoin.settlementFallback.sample.attemptIndex, 1);
  assert.equal(input.durableSamplesJoin.admitted.length, 1, 'only the strictly pre-cutoff sample is admitted');
  assert.equal(input.durableSamplesJoin.admitted[0].attemptIndex, 1);
  assert.equal(input.durableSamplesJoin.admitted[0].creditEligible, true, 'a positively consistent pre-cutoff sample is credit-eligible');
  assert.deepEqual(input.durableSamplesJoin.refused.map((refusal) => refusal.reason).sort(),
    ['sample-at-or-after-measurement-cutoff', 'sample-at-or-after-measurement-cutoff'],
    'the at-cutoff and post-cutoff samples are refused by name (zero credit, equality included)');
  assert.equal(input.durableObligations, 'unresolved', 'the fallback grounds the OBSERVED obligations layer from the pre-cutoff sample');
  assert.equal(input.companionOutcome, 'survived-unsettled', 'the guarded running job is reported as the actual result');
  assert.equal(input.terminalWinner, null, 'the fenced final snapshot never publishes its winner');
  const verdict = evaluateNativeInterruptionSettlement(input);
  assert.equal(verdict.qualified, false);
  assert.ok(verdict.reasons.includes('durable-obligations-unresolved'), JSON.stringify(verdict.reasons));
  assert.ok(verdict.reasons.includes('companion-still-live-unsettled'), JSON.stringify(verdict.reasons));
});

test('a legacy record without the cutoff field replays with the fence inert (the §24.10 replay stability holds under join v4)', () => {
  // The same record minus `measurementCutoffAtMs` — the retained F/I shape:
  // with NO boundary and NO cutoff recorded the fence is unestablishable, the
  // final snapshot is not fenced, and the samples ride as boundary-unrecorded
  // observation facts with no credit (the pre-Task-3 behavior, byte-stable).
  const boundSample = {
    attemptIndex: 1, baseline: true, transition: false, startedAtMs: 4_990, completedAtMs: 5_000,
    aggregate: 'unresolved', jobPresence: 'found', jobStatus: null,
    stopCause: null, stopIntentCause: null, stopIntentRequestedAt: null,
    executorLinkage: 'verified', snapshotEqual: true, lockState: null, partitionStatus: null,
    layers: { bindingCurrency: { state: 'current', anchorsJob: 'job-1' } },
  };
  const record = {
    case: 'rescue-interrupt',
    linkage: { childThreadId: CHILD_THREAD, parentThreadId: ROOT_THREAD },
    interrupt: {
      attempted: true, delivered: true, exactTargetMatch: true, settled: null,
      settledBasis: 'delivery-target-unmatched-no-settlement-claim', deliveryToSettlementMs: null,
      pendingWindowObserved: true, previousStatus: 'running', unreadableContinuationObserved: false,
      hostDelivery: {
        checked: true, attemptedCall: true, callId: 'int-1', itemPresent: true, interruptedItemCount: 1,
        joinedItemCount: 1, foreignItemCount: 0, idJoin: true, idJoinBasis: 'outer-call-id',
        agentThreadIdMatch: true, rootRolloutOwned: true, insidePendingWindow: true,
        acknowledgementAtResolution: 'after', timed: true, completedAtMs: 15_000,
        admitted: true, reasons: [],
      },
    },
    observations: {},
    child: {
      settlementLayers: null,
      durableSnapshot: {
        aggregate: 'settled', executorLinkage: 'verified', completedAtMs: 25_000, passive: { snapshotEqual: true },
        job: { presence: 'found', projection: { id: 'job-1', status: 'succeeded', ownerSessionId: ROOT_THREAD } },
      },
      durableSamples: { version: 1, summaries: [boundSample] },
    },
    survivalControl: null,
  };
  const input = pipeline.nativeInterruptionGateDInput(record);
  assert.equal(input.measurementCutoffAtMs, null, 'the cutoff is null — never invented');
  assert.equal(input.durableReadPostCleanupBoundary, false, 'no fence recorded: the final read is not withheld');
  assert.equal(input.durableReadBoundaryBasis, null);
  assert.equal(input.durableSamplesJoin.settlementFallback.used, false);
  assert.equal(input.durableSamplesJoin.settlementFallback.basis, 'final-snapshot-not-fenced');
  assert.equal(input.durableSamplesJoin.admitted[0].timingState, 'boundary-unrecorded');
  assert.equal(input.durableSamplesJoin.admitted[0].creditEligible, false, 'no fence: the sample stays an observation fact, never credit');
  assert.equal(input.durableObligations, 'settled', 'the final snapshot keeps its pre-Task-3 consumption');
  assert.equal(input.terminalWinner, 'succeeded');
});

test('runHeldHostTurn arms the §24.8 schedule: the cutoff is stamped at the hold deadline, reads stop at it, and teardown waits past it', async () => {
  // Fake-host instrument test (dependency-injected clocks — no live host):
  // the cutoff is computed ON THE WALL CLOCK at the hold-deadline crossing
  // (+10000 ms), BEFORE any teardown; the passive sampler stops at the cutoff
  // with its named reason; the held phase extends to the teardown deadline
  // (hold + 15000 ms); and NO cleanup boundary is recorded — the cutoff is
  // independent of any termination-initiation boundary (§24.8/§24.3's
  // no-manufactured-boundary rule).
  let monotonic = 0;
  const mono0 = monotonic;
  const reads = [];
  // The Root acknowledgement resolves on the fake-clock flow — during the
  // `readProcessIdentity` probe, BEFORE the §24.8 post-release races — the
  // natural-success shape (Root returned inside the window; nothing is
  // terminated, no boundary exists).
  let resolveRootResult = null;
  const held = await pipeline.runHeldHostTurn({
    launch: async () => ({ result: new Promise((resolve) => { resolveRootResult = resolve; }) }),
    waitForGate: async () => {},
    waitForObservation: async () => {},
    captureProcessIdentity: async () => ({ pid: 66141, ppid: 81, nonce: 'a'.repeat(64), startIdentity: 'start-a' }),
    terminateProcessIdentity: async () => ({ attempted: true, signalled: 'SIGTERM', exited: true, failure: null }),
    readProcessIdentity: async () => {
      if (resolveRootResult !== null) {
        const resolve = resolveRootResult;
        resolveRootResult = null;
        resolve({ code: 0, stdout: 'sentinel', stderr: '' });
      }
      return undefined;
    },
    waitForProcessExit: async () => {},
    sleep: async () => {},
    now: () => (monotonic += 10_000),
    // The wall clock is a PURE function of the monotonic one (wall ≡ 500000 +
    // mono): the hold-deadline PROJECTION is then exactly 920000 no matter
    // how many clock reads the machinery spends, and the cutoff is exactly
    // the projected scheduled deadline + 10000 ms.
    wallClockNow: () => 500_000 + monotonic,
    holdMs: 420_000,
    budgetMs: 1_200_000,
    measurementCutoffSchedule: true,
    sampleDurableSnapshots: { intervalMs: 2_000 },
    readDurableSnapshot: async () => {
      reads.push(500_000 + monotonic);
      return { aggregate: 'unresolved', executorLinkage: 'verified', reasons: [], job: { presence: 'found', projection: { status: null } } };
    },
  });
  assert.equal(held.endedBeforeGate, false);
  assert.equal(typeof held.cleanup.measurementCutoffAtMs, 'number', 'the cutoff was computed at the hold-deadline crossing');
  // Codex gate round-10 finding 2 (clock-shape hardening): with the wall
  // clock a PURE function of the monotonic one, the hold-deadline projection
  // is immune to how many clock reads the machinery spends — the record's
  // own hold-deadline elapsed fixes the expectation exactly:
  // cutoff = (wall@start 500000 + startMs) projected to the scheduled
  // deadline + 10000 ms = 500000 + startMs + holdDeadlineElapsedMs, where
  // startMs is the driver's single entry `now()` reading (mono0 + 10000).
  assert.equal(held.cleanup.measurementCutoffAtMs,
    500_000 + (mono0 + 10_000) + held.timeline.holdDeadlineElapsedMs,
    'the cutoff is exactly the hold-deadline wall-clock projection + 10000 ms');
  assert.equal(held.cleanup.cleanupBoundaryAtMs, null, 'NO termination boundary is manufactured: the cutoff is independent of any kill');
  assert.equal(held.childSettlement.durableSamples.stoppedReason, 'durable-sampling-stopped-at-measurement-cutoff',
    'the passive reads stopped at the measurement cutoff with the named reason');
  assert.ok(held.childSettlement.durableSamples.attemptCount > 0, 'reads ran before the cutoff');
  const cutoff = held.cleanup.measurementCutoffAtMs;
  assert.ok(held.childSettlement.durableSamples.summaries.some((summary) => summary.completedAtMs <= cutoff),
    'pre-cutoff reads survived on the record (the settlement-selection input)');
  assert.ok(held.timeline.endedAtElapsedMs >= 420_000 + 15_000,
    `teardown waited until the post-cutoff observation end (got ${String(held.timeline.endedAtElapsedMs)})`);
});

test('without the schedule flag the held turn keeps its schema and natural end (no cutoff, no grace)', async () => {
  let monotonic = 0;
  const held = await pipeline.runHeldHostTurn({
    launch: async () => ({ result: Promise.resolve({ code: 0, stdout: 'sentinel', stderr: '' }) }),
    waitForGate: async () => {},
    captureProcessIdentity: async () => ({ pid: 66142, ppid: 82, nonce: 'a'.repeat(64), startIdentity: 'start-a' }),
    terminateProcessIdentity: async () => ({ attempted: true, signalled: 'SIGTERM', exited: true, failure: null }),
    readProcessIdentity: async () => undefined,
    waitForProcessExit: async () => {},
    sleep: async () => {},
    now: () => (monotonic += 1_000),
    holdMs: 0,
    budgetMs: 60_000,
  });
  assert.equal(held.cleanup.measurementCutoffAtMs, null, 'the cutoff field exists and stays null without the schedule');
  assert.ok(held.timeline.endedAtElapsedMs < 15_000, 'no post-cutoff grace is added without the schedule');
});

test('a read whose interval wait straddles the armed cutoff stops WITHOUT starting (the post-wait fence re-check)', async () => {
  // Self-review P3 fix: the pre-start fence alone left a ~one-interval drift
  // window — a wait that straddles the ARMED cutoff would start a read at/after
  // it. The fence is re-checked after the interval wait, BEFORE the attempt is
  // counted or stamped: the drifted slot stops by the PRE-START reason with no
  // read started (never the completion backstop, never a post-cutoff sample).
  let monotonic = 0;
  let wall = 500_000;
  let cutoffAtRelease = null;
  /** @type {(value?: unknown) => void[]} */
  const heldSamplerWaits = [];
  let releasedAll = false;
  // The Root acknowledgement resolves BEFORE the §24.8 post-release races
  // (see the arms test): the natural-success shape — no endpoint miss, no
  // termination, no boundary.
  let resolveRootResult = null;
  const held = await pipeline.runHeldHostTurn({
    launch: async () => ({ result: new Promise((resolve) => { resolveRootResult = resolve; }) }),
    waitForGate: async () => {},
    waitForObservation: async () => {},
    captureProcessIdentity: async () => ({ pid: 66151, ppid: 91, nonce: 'a'.repeat(64), startIdentity: 'start-a' }),
    terminateProcessIdentity: async () => ({ attempted: true, signalled: 'SIGTERM', exited: true, failure: null }),
    readProcessIdentity: async () => {
      if (resolveRootResult !== null) {
        const resolve = resolveRootResult;
        resolveRootResult = null;
        resolve({ code: 0, stdout: 'sentinel', stderr: '' });
      }
      return undefined;
    },
    waitForProcessExit: async () => {},
    // The hold/grace loops wait ≤100 ms per tick; the sampler's ≥1000-ms
    // interval wait is the only >100-ms sleep — HOLD read 2's wait so the
    // cutoff arming (at the hold-deadline crossing, before the gate release)
    // happens while the read is still pending: the straddle.
    sleep: async (ms) => {
      if (ms > 100) {
        if (releasedAll) return;
        await new Promise((resolve) => heldSamplerWaits.push(resolve));
      }
    },
    now: () => (monotonic += 10_000),
    wallClockNow: () => { wall += 1; return wall; },
    holdMs: 420_000,
    budgetMs: 1_200_000,
    measurementCutoffSchedule: true,
    sampleDurableSnapshots: { intervalMs: 2_000 },
    readDurableSnapshot: async () => ({ aggregate: 'unresolved', executorLinkage: 'verified', reasons: [], job: { presence: 'found', projection: { status: null } } }),
    releaseGate: async () => {
      // The §24.8 cutoff is armed immediately before the gate release and the
      // sampler is parked in its held wait, so `wall` still holds the arming
      // value here. Advance the wall clock PAST the cutoff, then release the
      // straddled wait.
      cutoffAtRelease = wall + 420_000;
      wall += 430_000;
      releasedAll = true;
      for (const resolve of heldSamplerWaits.splice(0)) resolve();
    },
  });
  // Codex gate round-9 finding 1 (as refined by round 10 finding 1): the
  // cutoff is the OFFSET-SNAPSHOT anchor — the wall reading at the post-gate
  // instant plus the remaining monotonic distance (the scheduled deadline on
  // the wall clock), tracked within a few interleaved sampler reads.
  assert.equal(held.cleanup.measurementCutoffAtMs, cutoffAtRelease, 'premise: the cutoff was armed from the projected deadline anchor');
  assert.equal(held.childSettlement.durableSamples.stoppedReason, 'durable-sampling-stopped-at-measurement-cutoff',
    'the straddled slot stopped at the cutoff');
  assert.equal(held.childSettlement.durableSamples.attemptCount, 1,
    'the drifted read NEVER started: only the pre-cutoff read counts as an attempt');
  assert.ok(held.childSettlement.durableSamples.summaries.every((summary) => summary.completedAtMs < /** @type {number} */ (cutoffAtRelease)),
    'every sample completed strictly before the cutoff — no post-cutoff sample exists');
  assert.ok(!held.childSettlement.durableSamples.omissions.some((omission) => omission.reason === 'durable-read-completed-at-or-after-measurement-cutoff'),
    'the completion backstay never fired: the drifted read was refused at the START fence, not after completing');
});

test('a read completing exactly AT the measurement cutoff rides as the named post-cutoff limit and stops sampling (the completion backstop)', async () => {
  // The after-read backstop: a read that STARTED strictly before the cutoff
  // and COMPLETED exactly AT it (equality included) rides as an observation
  // fact, is named by the `durable-read-completed-at-or-after-measurement-cutoff`
  // omission, and stops the sampler — no further attempt runs.
  let monotonic = 0;
  let wall = 500_000;
  let targetCutoff = null;
  let releasedAll = false;
  let completionArmed = false;
  let postReleaseReads = 0;
  let releaseWallMs = null;
  /** @type {(value?: unknown) => void[]} */
  const heldSamplerWaits = [];
  // The Root acknowledgement resolves LATE — on the wall clock, well after
  // the backstop read has claimed and completed AT the cutoff — so the turn
  // stays alive across the shared stream's floor-paced slots.
  let resolveRootResult = null;
  const held = await pipeline.runHeldHostTurn({
    launch: async () => ({ result: new Promise((resolve) => { resolveRootResult = resolve; }) }),
    waitForGate: async () => {},
    waitForObservation: async () => {},
    captureProcessIdentity: async () => ({ pid: 66152, ppid: 92, nonce: 'a'.repeat(64), startIdentity: 'start-a' }),
    terminateProcessIdentity: async () => ({ attempted: true, signalled: 'SIGTERM', exited: true, failure: null }),
    readProcessIdentity: async () => undefined,
    waitForProcessExit: async () => {},
    sleep: async (ms) => {
      if (ms > 100) {
        // The sampler's hold-phase interval wait is the only >100-ms sleep
        // before the release: park it so exactly ONE read runs during the
        // hold and the rest of the schedule unfolds post-release.
        if (releasedAll) return;
        await new Promise((resolve) => heldSamplerWaits.push(resolve));
        return;
      }
      // Post-release pacing sleeps (≤100 ms — the shared stream's claim
      // waits and the window waits) ADVANCE the wall: the clock must move
      // while they wait, or the floor-paced slots could never arrive.
      if (releasedAll) wall += ms;
    },
    now: () => { monotonic += releasedAll ? 1 : 10_000; return monotonic; },
    // Until the backstop read is in flight the wall clock steps by 1 per call
    // (every start stamp stays far below the cutoff); from the FOURTH
    // post-release read onward it SATURATES at the armed cutoff, so that
    // read — started strictly pre-cutoff — completes EXACTLY AT it
    // (equality included) no matter how the settlement-read stamps
    // interleave.
    wallClockNow: () => {
      if (completionArmed) return /** @type {number} */ (targetCutoff);
      wall += 1;
      if (resolveRootResult !== null && releasedAll && releaseWallMs !== null && wall >= releaseWallMs + 2_500) {
        const resolve = resolveRootResult;
        resolveRootResult = null;
        resolve({ code: 0, stdout: 'sentinel', stderr: '' });
      }
      return wall;
    },
    holdMs: 420_000,
    budgetMs: 1_200_000,
    measurementCutoffSchedule: true,
    sampleDurableSnapshots: { intervalMs: 2_000 },
    readDurableSnapshot: async () => {
      if (releasedAll) postReleaseReads += 1;
      // The FIRST post-release call is the settlement-watch read; the rest
      // are the sampler's own floor-paced reads. The FIFTH call — the
      // sampler's read the shared stream scheduled after three full
      // intervals — SATURATES the clock: it STARTS strictly pre-cutoff and
      // COMPLETES EXACTLY AT the armed cutoff (the completion backstop).
      if (releasedAll && postReleaseReads >= 5) completionArmed = true;
      return { aggregate: 'unresolved', executorLinkage: 'verified', reasons: [], job: { presence: 'found', projection: { status: null } } };
    },
    releaseGate: async () => {
      // The offset-snapshot anchor: wall@post-gate + the remaining mono
      // (420_000); the wall at this point is within a few reads of
      // wall@post-gate, so targetCutoff tracks the persisted cutoff.
      releaseWallMs = wall;
      targetCutoff = wall + 420_000;
      releasedAll = true;
      for (const resolve of heldSamplerWaits.splice(0)) resolve();
    },
  });
  const cutoff = /** @type {number} */ (held.cleanup.measurementCutoffAtMs);
  assert.ok(Math.abs(cutoff - targetCutoff) <= 8,
    `premise: the cutoff was armed from the projected deadline anchor (got ${String(cutoff)}, expected ≈ ${String(targetCutoff)})`);
  assert.equal(held.childSettlement.durableSamples.stoppedReason, 'durable-sampling-stopped-at-measurement-cutoff');
  const backstopOmission = held.childSettlement.durableSamples.omissions.find((omission) => omission.reason === 'durable-read-completed-at-or-after-measurement-cutoff');
  assert.ok(backstopOmission, 'the at-cutoff completion is NAMED by the post-cutoff-limit omission');
  assert.equal(backstopOmission?.attemptIndex, held.childSettlement.durableSamples.attemptCount,
    'the backstop names the LAST read — the one that completed at the cutoff (none follows)');
  const atCutoffSummary = held.childSettlement.durableSamples.summaries.find((summary) => summary.completedAtMs === cutoff);
  assert.ok(atCutoffSummary, 'the at-cutoff observation fact still rides the record (zero settlement credit is the join fence below)');
  assert.equal(atCutoffSummary?.startedAtMs < cutoff, true, 'the backstopped read STARTED strictly before the cutoff');
  assert.equal(held.childSettlement.durableSamples.summaries.length, held.childSettlement.durableSamples.attemptCount,
    'no attempt runs after the backstop');
});

test('the exact process identity is established BEFORE disappearance and rides the held record (never lazily at cleanup)', async () => {
  // The §24.7 local-identity row, wired: the eager establishment runs
  // CONCURRENTLY with the held phase, so an exact verified identity (marker
  // nonce + start identity + ancestry — never the PID alone) exists before
  // the host exits. Part A — natural completion: the capture happens before
  // the natural-exit wait. Part B — early exit: the identity was already
  // established when the cleanup ran, and the DISAPPEARED process is never
  // signalled (no kill — the identity facts survive).
  const events = [];
  const captured = { pid: 66143, ppid: 83, nonce: 'a'.repeat(64), startIdentity: 'start-a' };
  const heldA = await pipeline.runHeldHostTurn({
    launch: async () => ({ result: new Promise((resolve) => setTimeout(() => resolve({ code: 0, stdout: 'sentinel', stderr: '' }), 5)) }),
    waitForGate: async () => {},
    captureProcessIdentity: async () => { events.push('captured'); return captured; },
    terminateProcessIdentity: async () => ({ attempted: true, signalled: 'SIGTERM', exited: true, failure: null }),
    readProcessIdentity: async () => ({ ...captured }),
    waitForProcessExit: async () => { events.push('exit'); },
    sleep: async () => {},
    now: (() => { let value = 0; return () => (value += 1_000); })(),
    holdMs: 0,
    budgetMs: 60_000,
  });
  assert.deepEqual(events, ['captured', 'exit'], 'the identity capture strictly precedes the natural-exit wait');
  assert.deepEqual(heldA.cleanup.identityEstablished,
    { established: true, capturedAtElapsedMs: heldA.cleanup.identityEstablished.capturedAtElapsedMs, basis: 'marker-nonce-start-ancestry-verified' });
  assert.equal(typeof heldA.cleanup.identityEstablished.capturedAtElapsedMs, 'number');
  assert.deepEqual(heldA.identity, captured, 'the verified identity (nonce + start identity + ancestry) rides the held record');
  // Part B — early exit: the eager establishment wins the race against the
  // host exit; the cleanup observes the disappearance (readProcessIdentity
  // undefined) and records zero kills.
  const heldB = await pipeline.runHeldHostTurn({
    launch: async () => {
      const released = Promise.withResolvers();
      setTimeout(() => released.resolve({ code: 0, stdout: 'early root finish', stderr: '' }), 5);
      return { result: released.promise };
    },
    waitForGate: async () => new Promise(() => {}),
    captureProcessIdentity: async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return captured;
    },
    readProcessIdentity: async () => undefined,
    sleep: async () => {},
    now: (() => { let value = 0; return () => (value += 1_000); })(),
    holdMs: 0,
    budgetMs: 60_000,
  });
  assert.equal(heldB.endedBeforeGate, true);
  assert.equal(heldB.cleanup.identityEstablished.established, true, 'the identity was established before the early exit');
  assert.equal(heldB.cleanup.verifiedProcessTerminated, false, 'a disappeared verified process is never signalled');
  assert.equal(heldB.cleanup.codexTerminated, false, 'no host terminate was supplied — nothing to terminate, nothing claimed');
});

test('a never-established identity is named, never guessed', async () => {
  // The marker never appeared (the fake process never launched): the
  // establishment fact names the confirmed absence — the record keeps the
  // honest basis instead of a fabricated identity.
  const absentError = Object.assign(new Error('the exact fake-ZCode process marker never appeared'), { code: 'ZCODE_SHELL_WAIT_MARKER_ABSENT' });
  const held = await pipeline.runHeldHostTurn({
    launch: async () => ({ result: Promise.resolve({ code: 0, stdout: 'early root finish', stderr: '' }) }),
    waitForGate: async () => new Promise(() => {}),
    captureProcessIdentity: async () => { throw absentError; },
    terminateProcessIdentity: async () => ({ attempted: true, signalled: 'SIGTERM', exited: true, failure: null }),
    readProcessIdentity: async () => undefined,
    sleep: async () => {},
    now: (() => { let value = 0; return () => (value += 1_000); })(),
    holdMs: 0,
    budgetMs: 60_000,
  });
  assert.equal(held.endedBeforeGate, true);
  assert.equal(held.cleanup.identityEstablished.established, false);
  assert.equal(held.cleanup.identityEstablished.capturedAtElapsedMs, null);
  assert.match(String(held.cleanup.identityEstablished.basis), /marker-absent|turn-ended/iu,
    `the named basis rides: ${String(held.cleanup.identityEstablished.basis)}`);
  assert.equal(held.identity, undefined);
});

test('the persisted record keeps the separate stop causes on a session-end resolution (serialize→reload)', async (t) => {
  // Deliverable (e) through the REAL serializer: the durable job's genuine
  // session-end winner rides the samples' own cause provenance while the
  // interrupt block stays unattributed and the running job's safe guard
  // retention is reported as the actual result (unresolved obligations,
  // survived-unsettled Companion) — never folded into the interrupt.
  const held = {
    ...heldObservationWithSchedule(),
    childSettlement: {
      observed: false, basis: null,
      layers: { remoteTerminal: null, localProcessReaping: null, durableObligations: 'unresolved' },
      durableSnapshot: {
        aggregate: 'unresolved', executorLinkage: 'verified', completedAtMs: MEASUREMENT_CUTOFF_AT_MS - 2_000,
        passive: { snapshotEqual: true },
        job: { presence: 'found', projection: { id: 'job-1', status: 'cancelled', ownerSessionId: ROOT_THREAD, stopCause: 'session-end', stopIntent: { cause: 'session-end', requestedAt: '2026-10-24T15:32:38.087Z' } } },
      },
      durableSamples: {
        version: 1,
        summaries: [{
          attemptIndex: 153, baseline: false, transition: true, startedAtMs: MEASUREMENT_CUTOFF_AT_MS - 3_000, completedAtMs: MEASUREMENT_CUTOFF_AT_MS - 2_000,
          aggregate: 'unresolved', jobPresence: 'found', jobStatus: 'cancelled',
          stopCause: 'session-end', stopIntentCause: 'session-end', stopIntentRequestedAt: '2026-10-24T15:32:38.087Z',
          executorLinkage: 'verified', snapshotEqual: true, lockState: null, partitionStatus: null,
          layers: { bindingCurrency: { state: 'current', anchorsJob: 'job-1' } },
        }],
      },
    },
  };
  const facts = pipeline.mapShellWaitLiveFacts(
    { case: 'rescue-interrupt', pollMs: 3_600_000, waitPolicy: null, interruptBaselineSelector: null, survivalControlSelector: null },
    held, supportedEvidence(), null, null, mapperFixture, causalRollouts({ withNativeResolution: false, completedAtMs: Date.parse('2026-10-06T00:00:08.500Z') }), [], LAUNCHER,
  );
  const root = await mkdtemp(join(tmpdir(), 'shell-wait-native-interruption-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const persistFixture = { ...mapperFixture, dispose: async () => {} };
  await pipeline.runShellWaitCase(
    { case: 'rescue-interrupt', codexBinary: process.execPath, sourceSha: 'a'.repeat(40), workerDurationMs: 420_000, capMs: 3_600_000, pollMs: 3_600_000, budgetMs: 1_200_000, output: root },
    { createFixture: async () => persistFixture, executeLiveCase: async () => facts },
  );
  const recordName = (await readdir(root)).find((name) => name.endsWith('.record.json'));
  const reloaded = JSON.parse(await readFile(join(root, recordName), 'utf8'));
  assert.equal(reloaded.child.durableSamples.summaries[0].stopCause, 'session-end', 'the genuine SessionEnd cause persists verbatim');
  const input = pipeline.nativeInterruptionGateDInput(reloaded);
  assert.equal(input.durableObligations, 'unresolved', 'the safely guarded running job is the actual reported result');
  assert.equal(input.companionOutcome, 'terminal-result', 'the production-published session-end winner is the Companion remote outcome');
  assert.equal(input.terminalWinner, 'cancelled', 'the winner is consumed from the FINAL snapshot only, with its own session-end cause');
  assert.equal(input.turnSettled, null, 'the interrupt stays unattributed: the session end is never the earlier interrupt');
  assert.equal(input.durableSamplesJoin.admitted[0].stopCause, 'session-end', 'the cause provenance rides the admitted sample');
  const verdict = evaluateNativeInterruptionSettlement(input);
  assert.equal(verdict.qualified, false);
  assert.ok(verdict.reasons.includes('durable-obligations-unresolved'), JSON.stringify(verdict.reasons));
  assert.ok(verdict.reasons.includes('turn-settlement-unobserved'), JSON.stringify(verdict.reasons));
});

// --- Task 3 (f): the survival-control observation block through the record --

const CONTROL_PATH = '/private/tmp/survival-control.mjs';
const controlLine = (index, tag) => `zcode-survival-control ${index} ${tag}\n`;

/** A Root rollout carrying the §16.4 control choreography: launch, reads
 * (each returning the ACCUMULATED lines), the exactly-one interrupt, and the
 * host item. `preRequestReadLineCounts` counts how many lines each
 * pre-request read returns; the completion marker rides the LAST read. */
function controlRollouts({ preRequestReadLineCounts = [1, 10, 45], completionInPostRead = true } = {}) {
  const linesThrough = (count) => Array.from({ length: count }, (_, index) => controlLine(index + 1, (index + 1) * 2_000)).join('');
  const rootEvents = [
    { type: 'session_meta', payload: { id: ROOT_THREAD } },
    fnCall('exec_command', 'ctl-1', { cmd: `${CONTROL_PATH}`, yield_time_ms: 1_000 }, '2026-10-06T00:00:00.000Z'),
    fnOutput('ctl-1', completedOutputBody({ output: linesThrough(1), exit_code: 0, session_id: 7 }), '2026-10-06T00:00:00.500Z'),
  ];
  let readAt = 1;
  let callAt = null;
  for (const count of preRequestReadLineCounts) {
    readAt += 1;
    rootEvents.push(
      fnCall('write_stdin', `ctl-read-${readAt}`, { session_id: 7, chars: '', yield_time_ms: 1_000 }, `2026-10-06T00:00:0${readAt}.000Z`),
      fnOutput(`ctl-read-${readAt}`, completedOutputBody({ output: linesThrough(count), exit_code: 0 }), `2026-10-06T00:00:0${readAt}.500Z`),
    );
  }
  callAt = readAt + 1;
  rootEvents.push(
    interruptCall('int-1', CHILD_THREAD, `2026-10-06T00:00:${String(callAt).padStart(2, '0')}.000Z`),
    interruptSuccess('int-1', 'running', `2026-10-06T00:00:${String(callAt).padStart(2, '0')}.100Z`),
    activityItem({ id: 'int-1', completedAtMs: Date.parse(`2026-10-06T00:00:${String(callAt + 2).padStart(2, '0')}.000Z`) }),
  );
  const postAt = callAt + 3;
  rootEvents.push(
    fnCall('write_stdin', 'ctl-read-post', { session_id: 7, chars: '', yield_time_ms: 1_000 }, `2026-10-06T00:00:${String(postAt).padStart(2, '0')}.000Z`),
    fnOutput('ctl-read-post', completedOutputBody({ output: linesThrough(completionInPostRead ? 60 : 50), exit_code: 0 }), `2026-10-06T00:00:${String(postAt).padStart(2, '0')}.500Z`),
  );
  const childEvents = [
    { type: 'session_meta', payload: { id: CHILD_THREAD, parent_thread_id: ROOT_THREAD } },
    fnCall('exec_command', 'launch-1', { cmd: LAUNCHER }, '2026-10-06T00:00:00.000Z'),
    fnOutput('launch-1', completedOutputBody({ output: '', exit_code: 0, session_id: 5 }), '2026-10-06T00:00:00.200Z'),
    fnCall('write_stdin', 'poll-1', { session_id: 5, chars: '', yield_time_ms: 60_000 }, '2026-10-06T00:00:01.000Z'),
    fnOutput('poll-1', pendingOutputBody('cell-1'), '2026-10-06T00:00:01.500Z'),
    fnCall('wait', 'outer-native', { cell_id: 'cell-1' }, `2026-10-06T00:00:${String(callAt + 1).padStart(2, '0')}.000Z`),
    fnOutput('outer-native', nativeMarkerOutput, Date.parse(`2026-10-06T00:00:${String(callAt + 2).padStart(2, '0')}.000Z`)),
  ];
  return [rootEvents, childEvents];
}

test('the §24.8 readiness facts ride the survival-control observation block (ready vs readiness-cutoff-exceeded)', async () => {
  const { extractSurvivalControlFacts } = await import('../tools/shell-wait-probe/evidence.mjs');
  // READY: a pre-request read returned a line at/above the readiness floor.
  const readyRollouts = controlRollouts({ preRequestReadLineCounts: [1, 10, 45] });
  const readyInteraction = extractInterruptInteraction(readyRollouts, [], { childThreadId: CHILD_THREAD, command: LAUNCHER });
  const readyFacts = extractSurvivalControlFacts(readyRollouts, CONTROL_PATH, { lineCount: 60, interruptInteraction: readyInteraction, exactTargetMatch: true, childThreadId: CHILD_THREAD });
  assert.equal(readyFacts.readinessFloor.observed, true, 'the readiness floor (line index ≥ 40) was observed before the request');
  assert.equal(readyFacts.readinessFloor.highestPreRequestLineIndex, 45);
  assert.equal(readyFacts.readinessCutoffExceeded, false);
  // NEVER-READY: the reads never reached the floor, yet the control reached
  // its designed end (the completion marker line 60) — the named
  // readiness-cutoff-exceeded outcome (a live model-obedience fact).
  // Codex gate round-5 finding 2: expiry is established ONLY from the
  // readiness PHASE itself reaching the designed end. The reviewer's repro —
  // an early interrupt after reading line 5, the control's normal completion
  // observed in the POST-interrupt read — is NOT expiry (the readiness loop
  // ended before the request; the later marker proves nothing about any
  // cutoff): it stays null.
  const neverReadyRollouts = controlRollouts({ preRequestReadLineCounts: [1, 3, 5], completionInPostRead: true });
  const neverReadyInteraction = extractInterruptInteraction(neverReadyRollouts, [], { childThreadId: CHILD_THREAD, command: LAUNCHER });
  const neverReadyFacts = extractSurvivalControlFacts(neverReadyRollouts, CONTROL_PATH, { lineCount: 60, interruptInteraction: neverReadyInteraction, exactTargetMatch: true, childThreadId: CHILD_THREAD });
  assert.equal(neverReadyFacts.readinessFloor.observed, false);
  assert.equal(neverReadyFacts.readinessCutoffExceeded, null,
    'a post-interrupt completion marker never establishes readiness-cutoff expiry');
  // TRUE-positive: the readiness PHASE demonstrably ran to the designed end
  // without the floor — the last readiness-phase read was INVOKED before the
  // request and its response carried the designed-end completion line (60),
  // while the completed pre-request reads never crossed the floor (line 3).
  const straddlerRollouts = controlRollouts({ preRequestReadLineCounts: [1, 3, 5], completionInPostRead: true });
  const straddleOutput = straddlerRollouts[0].find((event) => /** @type {any} */ (event)?.payload?.call_id === 'ctl-read-4'
    && /** @type {any} */ (event)?.payload?.type === 'function_call_output');
  assert.ok(straddleOutput, 'premise: the third readiness-phase read exists');
  // The read was INVOKED pre-request (04.000) but its response — carrying the
  // designed-end completion line 60 — lands AFTER the interrupt request
  // (05.000): the readiness phase demonstrably ran to the designed end while
  // the completed pre-request reads never crossed the floor.
  straddleOutput.payload.output = completedOutputBody({
    output: Array.from({ length: 60 }, (_, index) => controlLine(index + 1, (index + 1) * 2_000)).join(''),
    exit_code: 0,
  });
  straddleOutput.timestamp = '2026-10-06T00:00:05.500Z';
  const straddleInteraction = extractInterruptInteraction(straddlerRollouts, [], { childThreadId: CHILD_THREAD, command: LAUNCHER });
  const straddleFacts = extractSurvivalControlFacts(straddlerRollouts, CONTROL_PATH, { lineCount: 60, interruptInteraction: straddleInteraction, exactTargetMatch: true, childThreadId: CHILD_THREAD });
  assert.equal(straddleFacts.readinessFloor.observed, false, 'the completed pre-request reads never crossed the floor');
  assert.equal(straddleFacts.readinessCutoffExceeded, true,
    'the readiness phase demonstrably ran to the designed end with the loop unfilled');
  // Unestablishable stays null (no request stamp to order the reads against).
  const unstampedRollouts = controlRollouts({ preRequestReadLineCounts: [1, 10, 45] }).map((events) => events.map((event) => {
    const clone = { ...event };
    delete clone.timestamp;
    return clone;
  }));
  const unstampedInteraction = extractInterruptInteraction(unstampedRollouts, [], { childThreadId: CHILD_THREAD, command: LAUNCHER });
  const unstampedFacts = extractSurvivalControlFacts(unstampedRollouts, CONTROL_PATH, { lineCount: 60, interruptInteraction: unstampedInteraction, exactTargetMatch: true, childThreadId: CHILD_THREAD });
  assert.equal(unstampedFacts.readinessCutoffExceeded, null, 'an unorderable readiness stays null — never a guessed outcome');
});

test('the readiness floor first seen only in the designed-end read is NOT a mid-phase observation: the 1\u21923\u219260 sequential run exceeds the cutoff', async () => {
  // Codex gate round-18 finding 2's repro (the reviewer's numbers): the
  // pre-request control reads return line indexes 1, 3, then 60 — the floor
  // (line 40) was not observed until the control had reached its DESIGNED
  // END (line 60 rides the same completion read). The pre-fix branch forced
  // `readinessCutoffExceeded` to false from that floor observation alone,
  // suppressing the §24.8 expiry outcome for a readiness phase that
  // demonstrably ran to the designed end unfilled. The expiry decision must
  // distinguish a floor observed in a read that ended BEFORE the designed
  // end (the positive non-expiry fact) from one FIRST observed in the
  // completion read (the registered true shape). The readinessFloor FACT
  // keeps its registered meaning — the completion read DID return a line
  // at/above the floor — only the expiry decision reclassifies it.
  const { extractSurvivalControlFacts } = await import('../tools/shell-wait-probe/evidence.mjs');
  const rollouts = controlRollouts({ preRequestReadLineCounts: [1, 3, 60] });
  const interaction = extractInterruptInteraction(rollouts, [], { childThreadId: CHILD_THREAD, command: LAUNCHER });
  const facts = extractSurvivalControlFacts(rollouts, CONTROL_PATH, { lineCount: 60, interruptInteraction: interaction, exactTargetMatch: true, childThreadId: CHILD_THREAD });
  assert.equal(facts.readinessFloor.observed, true,
    'the designed-end read returned a line at/above the floor — the floor FACT stays observed');
  assert.equal(facts.readinessFloor.highestPreRequestLineIndex, 60);
  assert.equal(facts.readinessCutoffExceeded, true,
    `the floor was FIRST observed in the read that reached the designed end — the readiness phase ran to the end unfilled (readiness: ${JSON.stringify({ floor: facts.readinessFloor, exceeded: facts.readinessCutoffExceeded })})`);
});

test('the survival-control block — including the readiness facts — persists through the record and reaches the oracle', async (t) => {
  const rollouts = controlRollouts({ preRequestReadLineCounts: [1, 10, 45] });
  const evidence = supportedEvidence();
  const input0 = { case: 'rescue-interrupt', pollMs: 3_600_000, waitPolicy: null, interruptBaselineSelector: null, survivalControlSelector: 'progress-terminal' };
  const facts = pipeline.mapShellWaitLiveFacts(
    input0, heldObservationWithSchedule(), evidence, null, null,
    { ...mapperFixture, survivalControlPath: CONTROL_PATH }, rollouts, [], LAUNCHER,
  );
  const root = await mkdtemp(join(tmpdir(), 'shell-wait-native-interruption-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const persistFixture = { ...mapperFixture, survivalControlPath: CONTROL_PATH, dispose: async () => {} };
  await pipeline.runShellWaitCase(
    { case: 'rescue-interrupt', codexBinary: process.execPath, sourceSha: 'a'.repeat(40), workerDurationMs: 420_000, capMs: 3_600_000, pollMs: 3_600_000, budgetMs: 1_200_000, output: root, survivalControlSelector: 'progress-terminal', waitPolicy: 'config-default', execDefaultMs: 3_600_000 },
    { createFixture: async () => persistFixture, executeLiveCase: async () => facts },
  );
  const recordName = (await readdir(root)).find((name) => name.endsWith('.record.json'));
  const reloaded = JSON.parse(await readFile(join(root, recordName), 'utf8'));
  assert.ok(reloaded.survivalControl, 'the control verdict persists beside the versioned oracle input');
  assert.ok(reloaded.survivalControlInputs, 'the bounded whitelisted oracle inputs persist');
  assert.equal(reloaded.survivalControlInputs.readinessFloor.observed, true, 'the readiness fact persists for the offline reader');
  assert.equal(reloaded.survivalControlInputs.readinessCutoffExceeded, false);
  const input = pipeline.nativeInterruptionGateDInput(reloaded);
  assert.deepEqual(input.survivalControl, reloaded.survivalControl, 'the join passes the persisted verdict straight to the oracle');
  const verdict = evaluateNativeInterruptionSettlement(input);
  assert.equal(verdict.layers.noCollateral, true, 'a genuinely active root-owned control with its reads qualifies no-collateral');
});

// --- Task 3 (g): the preflight rejects known-absent §24.8 choreography -------

test('the preflight rejects known-absent §24.8 choreography artifacts and wrong control declarations before a launch', async (t) => {
  const { evaluateLiveLaunchPreflight, SURVIVAL_CONTROL_DECLARATION_FACTS } = await import('../tools/shell-wait-probe/driver.mjs');
  const root = await mkdtemp(join(tmpdir(), 'shell-wait-native-interruption-preflight-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace');
  const dataRoot = join(root, 'data-root');
  await mkdir(workspace, { recursive: true });
  await mkdir(dataRoot, { recursive: true });
  const controlPath = join(root, 'survival-control.mjs');
  await writeFile(controlPath, '#!/usr/bin/env node\n', { mode: 0o700 });
  const preloadPath = join(root, 'armed-preload.cjs');
  await writeFile(preloadPath, '// armed preload\n', 'utf8');
  const declaration = { ...SURVIVAL_CONTROL_DECLARATION_FACTS, scriptSha256: 'b'.repeat(64) };
  const gateArtifacts = { completionGatePath: join(root, 'rescue-interrupt.completion.gate'), completionGateReachedPath: join(root, 'rescue-interrupt.completion.reached') };
  await writeFile(gateArtifacts.completionGatePath, 'hold', 'utf8');
  await writeFile(gateArtifacts.completionGateReachedPath, '', 'utf8');
  const armedFixture = {
    workspace, env: { ZCODE_DATA_ROOT: dataRoot }, survivalControlPath: controlPath,
    stdoutCapture: { preloadPath }, record: { survivalControl: declaration },
  };
  // (4) A declared run whose §24.8 completion-gate artifacts are absent: the
  // gate release could never happen — known-absent choreography, rejected at
  // zero model turns.
  const missingGates = await evaluateLiveLaunchPreflight({
    case: 'rescue-interrupt', survivalControlSelector: null, fixture: { ...armedFixture, record: {} },
    gateArtifacts: { ...gateArtifacts, completionGatePath: join(root, 'gone.gate') },
  });
  assert.equal(missingGates.ok, false);
  assert.match(String(missingGates.reason ?? ''), /completion gate/iu);
  // (5) A declared control without the fixture's declaration block: the
  // record could never bind the control bytes after disposal — the anchor is
  // known absent.
  const missingDeclaration = await evaluateLiveLaunchPreflight({
    case: 'rescue-interrupt', survivalControlSelector: 'progress-terminal', fixture: { ...armedFixture, record: {} },
  });
  assert.equal(missingDeclaration.ok, false);
  assert.match(String(missingDeclaration.reason ?? ''), /declaration/iu);
  // (5b) A declaration that disagrees with the frozen §24.8 control sizing:
  // the wrong instrument, rejected before any launch.
  const wrongSizing = await evaluateLiveLaunchPreflight({
    case: 'rescue-interrupt', survivalControlSelector: 'progress-terminal',
    fixture: { ...armedFixture, record: { survivalControl: { ...declaration, lineCount: 30 } } },
  });
  assert.equal(wrongSizing.ok, false);
  assert.match(String(wrongSizing.reason ?? ''), /control (?:sizing|declaration)/iu);
  // The ARMED run passes with every required artifact present.
  const armed = await evaluateLiveLaunchPreflight({
    case: 'rescue-interrupt', survivalControlSelector: 'progress-terminal', fixture: armedFixture, gateArtifacts,
  });
  assert.deepEqual(armed, { ok: true, reason: null });
  // The gate-artifact check follows the DECLARED artifacts: an unregistered
  // case is never blocked.
  const other = await evaluateLiveLaunchPreflight({
    case: 'rescue-baseline', survivalControlSelector: null, fixture: { workspace, env: {} },
    gateArtifacts: { completionGatePath: join(root, 'gone.gate'), completionGateReachedPath: join(root, 'gone.reached') },
  });
  assert.equal(other.ok, true);
});

// --- codex gate on Task 3: the four P2 fixes (regression tests, RED first) ---

test('an identity-capture failure message is redacted before it reaches the persisted record (no private path leaks)', async (t) => {
  // P2 fix 1: a capture failure carrying a filesystem error (e.g. EACCES)
  // embeds the private process-marker path; that message rode
  // `identityEstablished.basis` verbatim into `buildCaseRecord` — the only
  // free-text in the new facts block that bypassed `redactPrivatePaths`.
  const root = await mkdtemp(join(tmpdir(), 'shell-wait-native-interruption-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const codexHome = join(root, 'codex-home');
  const markerPath = join(codexHome, '..', 'gates', 'rescue-interrupt.process.json');
  const captured = { pid: 66161, ppid: 93, nonce: 'a'.repeat(64), startIdentity: 'start-a' };
  const held = await pipeline.runHeldHostTurn({
    launch: async () => ({ result: Promise.resolve({ code: 0, stdout: 'early root finish', stderr: '' }) }),
    waitForGate: async () => new Promise(() => {}),
    captureProcessIdentity: async () => {
      throw Object.assign(new Error(`EACCES: permission denied, open '${markerPath}'`), { code: 'EACCES' });
    },
    terminateProcessIdentity: async () => ({ attempted: true, signalled: 'SIGTERM', exited: true, failure: null }),
    readProcessIdentity: async () => ({ ...captured }),
    sleep: async () => {},
    now: (() => { let value = 0; return () => (value += 1_000); })(),
    holdMs: 0,
    budgetMs: 60_000,
  });
  assert.equal(held.cleanup.identityEstablished.established, false, 'premise: the capture failed with the named basis');
  const facts = pipeline.mapShellWaitLiveFacts(
    { case: 'rescue-interrupt', pollMs: 3_600_000, waitPolicy: null, interruptBaselineSelector: null, survivalControlSelector: null },
    held, supportedEvidence(), null, null,
    { ...mapperFixture, codexHome }, causalRollouts(), [], LAUNCHER,
  );
  assert.equal(facts.held?.processIdentity?.basis?.includes(markerPath), false,
    'the mapper must never carry the private marker path in the establishment basis');
  const persistFixture = { ...mapperFixture, codexHome, dispose: async () => {} };
  await pipeline.runShellWaitCase(
    { case: 'rescue-interrupt', codexBinary: process.execPath, sourceSha: 'a'.repeat(40), workerDurationMs: 420_000, capMs: 3_600_000, pollMs: 3_600_000, budgetMs: 1_200_000, output: root },
    { createFixture: async () => persistFixture, executeLiveCase: async () => facts },
  );
  const recordName = (await readdir(root)).find((name) => name.endsWith('.record.json'));
  const reloaded = JSON.parse(await readFile(join(root, recordName), 'utf8'));
  const persisted = JSON.stringify(reloaded);
  assert.equal(persisted.includes(markerPath), false, 'the serialized record carries no private path');
  assert.match(String(reloaded.held?.processIdentity?.basis), /<redacted>/u,
    'the basis is redacted through the same treatment as cleanup errors');
  assert.ok(String(reloaded.held?.processIdentity?.basis).length <= 512 + '<truncated>'.length,
    'the basis respects the cleanup-error length bound');
});

test('the authoritative durable snapshot is refreshed at the measurement window end: post-release settlement is adjudicable', async (t) => {
  // P2 fix 2 (the reviewer's repro): the final snapshot taken at the gate
  // release read `unresolved`; the duties settled DURING the added window and
  // the sampler caught a pre-cutoff `settled` sample — yet the join reported
  // unresolved obligations because the stale unfenced snapshot wins. The
  // authoritative snapshot must be (re)taken at the window's end so the added
  // measurement window can affect adjudication: the refreshed read's own
  // completion instant (post-cutoff) is the named fenced observation and the
  // pre-cutoff samples adjudicate through the existing settlement fallback.
  let monotonic = 0;
  let wall = 500_000;
  let settleAtMs = null;
  const UNRESOLVED = { aggregate: 'unresolved', executorLinkage: 'verified', reasons: [], passive: { snapshotEqual: true }, job: { presence: 'found', projection: { id: 'job-1', status: null } }, layers: { bindingCurrency: { state: 'current', anchorsJob: 'job-1' } } };
  const SETTLED = { aggregate: 'settled', executorLinkage: 'verified', reasons: [], passive: { snapshotEqual: true }, job: { presence: 'found', projection: { id: 'job-1', status: null } }, layers: { bindingCurrency: { state: 'current', anchorsJob: 'job-1' } } };
  const held = await pipeline.runHeldHostTurn({
    launch: async () => ({ result: new Promise((resolve) => setTimeout(() => resolve({ code: 0, stdout: 'sentinel', stderr: '' }), 5)) }),
    waitForGate: async () => {},
    waitForObservation: async () => {},
    captureProcessIdentity: async () => ({ pid: 66162, ppid: 94, nonce: 'a'.repeat(64), startIdentity: 'start-a' }),
    terminateProcessIdentity: async () => ({ attempted: true, signalled: 'SIGTERM', exited: true, failure: null }),
    readProcessIdentity: async () => undefined,
    waitForProcessExit: async () => {},
    // The clocks are PURE readers; the injected sleep is the advancer, so the
    // raced waits genuinely span the planned endpoint on the fake clock.
    sleep: async (ms) => { monotonic += ms; wall += ms; },
    now: () => monotonic,
    wallClockNow: () => wall,
    holdMs: 420_000,
    budgetMs: 1_200_000,
    measurementCutoffSchedule: true,
    sampleDurableSnapshots: { intervalMs: 2_000 },
    readDurableSnapshot: async () => (settleAtMs !== null && wall >= settleAtMs ? SETTLED : UNRESOLVED),
    releaseGate: async () => {
      // Arming happened immediately before the release: the settle instant
      // sits INSIDE the post-release window (after the stale early read,
      // strictly before the cutoff).
      settleAtMs = wall + 2_000;
    },
  });
  const facts = pipeline.mapShellWaitLiveFacts(
    { case: 'rescue-interrupt', pollMs: 3_600_000, waitPolicy: null, interruptBaselineSelector: null, survivalControlSelector: null },
    held, supportedEvidence(), null, null, mapperFixture, causalRollouts(), [], LAUNCHER,
  );
  const root = await mkdtemp(join(tmpdir(), 'shell-wait-native-interruption-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const persistFixture = { ...mapperFixture, dispose: async () => {} };
  await pipeline.runShellWaitCase(
    { case: 'rescue-interrupt', codexBinary: process.execPath, sourceSha: 'a'.repeat(40), workerDurationMs: 420_000, capMs: 3_600_000, pollMs: 3_600_000, budgetMs: 1_200_000, output: root },
    { createFixture: async () => persistFixture, executeLiveCase: async () => facts },
  );
  const recordName = (await readdir(root)).find((name) => name.endsWith('.record.json'));
  const reloaded = JSON.parse(await readFile(join(root, recordName), 'utf8'));
  const input = pipeline.nativeInterruptionGateDInput(reloaded);
  assert.equal(reloaded.child.durableSnapshot.aggregate, 'settled',
    'the authoritative snapshot is the REFRESHED one (post-window), never the stale gate-release read');
  assert.equal(input.durableReadPostCleanupBoundary, true, 'the refreshed read completed after the cutoff — the named fence');
  assert.equal(input.durableSamplesJoin.settlementFallback.used, true, 'the pre-cutoff samples adjudicate through the fallback');
  assert.equal(input.durableSamplesJoin.settlementFallback.basis, 'final-snapshot-fenced-pre-boundary-sample');
  assert.ok(input.durableSamplesJoin.admitted.some((sample) => sample.aggregate === 'settled' && sample.creditEligible === true),
    'a settled pre-cutoff sample is credit-eligible');
  assert.equal(input.durableObligations, 'settled', 'the join must see the duties that settled during the window');
});

test('post-release operations are raced against the planned observation end: a pending Root result or read is named, never absorbed', { timeout: 10_000 }, async () => {
  // P2 fix 3: the Root result / natural-exit wait / final durable read were
  // awaited unboundedly, so the teardown deadline was only a MINIMUM lifetime
  // and a delayed operation could hold the observation open until the much
  // larger experiment budget. The operations race the §24.8 endpoint; one
  // that is still pending there is preserved as a NAMED late/missing fact.
  let monotonic = 0;
  let wall = 500_000;
  const held = await pipeline.runHeldHostTurn({
    launch: async () => ({
      result: new Promise((resolve) => {
        // Safety valve only: the §24.8 endpoint must end the observation long
        // before this resolves (on the pre-fix bytes this test times out).
        const timer = setTimeout(() => resolve({ code: 0, stdout: 'too late', stderr: '' }), 30_000);
        timer.unref?.();
      }),
    }),
    waitForGate: async () => {},
    waitForObservation: async () => {},
    captureProcessIdentity: async () => ({ pid: 66163, ppid: 95, nonce: 'a'.repeat(64), startIdentity: 'start-a' }),
    terminateProcessIdentity: async () => ({ attempted: true, signalled: 'SIGTERM', exited: true, failure: null }),
    readProcessIdentity: async () => undefined,
    waitForProcessExit: async () => {},
    sleep: async (ms) => { monotonic += ms; wall += ms; },
    now: () => monotonic,
    wallClockNow: () => wall,
    holdMs: 420_000,
    budgetMs: 1_200_000,
    measurementCutoffSchedule: true,
    sampleDurableSnapshots: { intervalMs: 2_000 },
    // EVERY durable read stays pending through the endpoint (the sampler's
    // reads, the gate-release read and the window-end refresh alike — the
    // sampler never awaits them; each pending promise carries an unref'd
    // safety valve so the process can always exit).
    readDurableSnapshot: async () => new Promise((resolve) => { const timer = setTimeout(resolve, 30_000); timer.unref?.(); }),
  });
  assert.equal(held.endedBeforeGate, false);
  assert.equal(held.budgetExpired, false, 'the planned observation end ended the turn — never the experiment budget');
  assert.equal(held.result, undefined, 'a Root result pending at the endpoint is missing, never absorbed');
  assert.equal(held.postRelease?.rootResult, 'root-result-missing-at-planned-observation-end');
  assert.equal(held.postRelease?.earlyDurableRead, 'durable-read-pending-at-planned-observation-end');
  assert.ok(held.timeline.endedAtElapsedMs >= 420_000 + 15_000,
    `the observation ended at the planned endpoint (got ${String(held.timeline.endedAtElapsedMs)})`);
});

test('budget expiry during the post-release section propagates onto the returned record and the mapper classification', async () => {
  // P2 fix 4: the answer copied `budgetExpired: false` before the new wait,
  // so a budget expiring during it was invisible to `mapShellWaitLiveFacts`'
  // budget-expired inconclusive classification. The armed path builds the
  // answer AFTER the section, so the returned record reflects the expiry.
  let monotonic = 0;
  let wall = 500_000;
  const held = await pipeline.runHeldHostTurn({
    launch: async () => ({ result: new Promise((resolve) => setTimeout(() => resolve({ code: 0, stdout: 'sentinel', stderr: '' }), 5)) }),
    waitForGate: async () => {},
    waitForObservation: async () => {},
    captureProcessIdentity: async () => ({ pid: 66164, ppid: 96, nonce: 'a'.repeat(64), startIdentity: 'start-a' }),
    terminateProcessIdentity: async () => ({ attempted: true, signalled: 'SIGTERM', exited: true, failure: null }),
    readProcessIdentity: async () => undefined,
    waitForProcessExit: async () => {},
    // The clocks are pure readers; the injected sleep is the advancer AND
    // yields REAL time per tick (5 ms — enough real time that the experiment-
    // budget timer, a real 50 ms interval on this clock, reliably fires while
    // the post-release window is still spinning) — the exact mid-wait expiry
    // the fix must propagate.
    sleep: async (ms) => {
      monotonic += ms;
      wall += ms;
      await new Promise((resolve) => setTimeout(resolve, 5));
    },
    now: () => monotonic,
    wallClockNow: () => wall,
    holdMs: 5_000,
    // The budget deadline (14000) sits INSIDE the §24.8 window
    // (holdDeadline ≈ 6000 → observation end ≈ 21000): the expiry lands
    // mid-window, exactly the shape the fix must propagate.
    budgetMs: 14_000,
    measurementCutoffSchedule: true,
    sampleDurableSnapshots: { intervalMs: 2_000 },
    readDurableSnapshot: async () => ({ aggregate: 'unresolved', executorLinkage: 'verified', reasons: [], job: { presence: 'found', projection: { status: null } } }),
  });
  assert.equal(held.budgetExpired, true, 'budget expiry during the post-release section must ride the returned record');
  assert.equal(held.cleanup.label, 'budget-cleanup', 'the cleanup label and the record flag agree');
  const facts = pipeline.mapShellWaitLiveFacts(
    { case: 'rescue-interrupt', pollMs: 3_600_000, waitPolicy: null, interruptBaselineSelector: null, survivalControlSelector: null },
    held, supportedEvidence(), null, null, mapperFixture, causalRollouts(), [], LAUNCHER,
  );
  assert.match(String(facts.inconclusive?.reason ?? ''), /budget expired/u,
    `the mapper's budget-expired classification must fire: ${String(facts.inconclusive?.reason)}`);
});

// --- codex gate on the P2-fix bytes: the three introduced findings (regression tests, RED first) ---

const CUTOFF_WALL_MS = 500_000 + 420_000 + 10_000;

test('a verified pre-cutoff succeeded snapshot survives the fenced window-end refresh: the natural completion keeps its winner', async (t) => {
  // Finding A: the window-end refresh REPLACED the only authoritative
  // snapshot with one that always completes after the measurement cutoff, so
  // `terminalWinner` was withheld even when the gate-release-time read had
  // POSITIVELY verified `succeeded` before the cutoff — the lawful natural
  // completion failed the oracle with `terminal-winner-unobserved`. The
  // completed gate-release read must be preserved as independently
  // established pre-cutoff winner evidence; the (always post-cutoff) refresh
  // stays the fenced final observation and never displaces the winner.
  let monotonic = 0;
  let wall = 500_000;
  let finishAtMs = null;
  // The Root acknowledgement resolves on the INJECTED clock, shortly after
  // the gate release and inside the §24.8 window — the natural-success shape
  // (Root returns; the worker's lawful finish lands in the gate-release→
  // first-read gap).
  let releaseWallMs = null;
  let resolveRootResult = null;
  const RUNNING = { aggregate: 'unresolved', executorLinkage: 'verified', reasons: [], passive: { snapshotEqual: true }, job: { presence: 'found', projection: { id: 'job-1', status: null } }, layers: { bindingCurrency: { state: 'current', anchorsJob: 'job-1' } } };
  const SUCCEEDED = { aggregate: 'settled', executorLinkage: 'verified', reasons: [], passive: { snapshotEqual: true }, job: { presence: 'found', projection: { id: 'job-1', status: 'succeeded' } }, layers: { bindingCurrency: { state: 'current', anchorsJob: 'job-1' } } };
  const held = await pipeline.runHeldHostTurn({
    launch: async () => ({ result: new Promise((resolve) => { resolveRootResult = resolve; }) }),
    waitForGate: async () => {},
    waitForObservation: async () => {},
    captureProcessIdentity: async () => ({ pid: 66171, ppid: 97, nonce: 'a'.repeat(64), startIdentity: 'start-a' }),
    terminateProcessIdentity: async () => ({ attempted: true, signalled: 'SIGTERM', exited: true, failure: null }),
    readProcessIdentity: async () => undefined,
    waitForProcessExit: async () => {},
    // The clocks are pure readers; the injected sleep is the advancer.
    sleep: async (ms) => {
      monotonic += ms;
      wall += ms;
      if (resolveRootResult !== null && releaseWallMs !== null && wall >= releaseWallMs + 1_000) {
        const resolve = resolveRootResult;
        resolveRootResult = null;
        resolve({ code: 0, stdout: 'sentinel', stderr: '' });
      }
    },
    now: () => monotonic,
    wallClockNow: () => wall,
    holdMs: 420_000,
    budgetMs: 1_200_000,
    measurementCutoffSchedule: true,
    sampleDurableSnapshots: { intervalMs: 2_000 },
    readDurableSnapshot: async () => (finishAtMs !== null && wall >= finishAtMs ? SUCCEEDED : RUNNING),
    releaseGate: async () => {
      // The worker's lawful natural finish lands INSIDE the gate-release→
      // first-read gap (§24.8: a finish at/after the release still gets a
      // pre-cutoff read) — the gate-release read itself verifies `succeeded`
      // strictly before the cutoff; the window-end refresh reads the same
      // terminal state but always completes POST-cutoff.
      finishAtMs = wall;
      releaseWallMs = wall;
    },
  });
  assert.equal(held.endedBeforeGate, false);
  assert.equal(held.budgetExpired, false);
  assert.equal(held.result?.stdout, 'sentinel', 'premise: Root returned inside the window (the natural-success shape)');
  assert.equal(held.postRelease?.rootResult, undefined, 'premise: Root did not miss the endpoint');
  assert.equal(held.cleanup.cleanupBoundaryAtMs, null, 'premise: no kill — the natural completion terminated nothing');
  assert.ok(held.childSettlement?.preCutoffDurableSnapshot,
    'the completed gate-release read must be preserved on the held record');
  assert.equal(held.childSettlement.preCutoffDurableSnapshot.job.projection.status, 'succeeded');
  assert.ok(held.childSettlement.preCutoffDurableSnapshot.completedAtMs < held.cleanup.measurementCutoffAtMs,
    'the preserved read completed strictly before the armed cutoff');
  const facts = pipeline.mapShellWaitLiveFacts(
    { case: 'rescue-interrupt', pollMs: 3_600_000, waitPolicy: null, interruptBaselineSelector: null, survivalControlSelector: null },
    held, supportedEvidence(), null, null, mapperFixture, causalRollouts(), [], LAUNCHER,
  );
  const root = await mkdtemp(join(tmpdir(), 'shell-wait-native-interruption-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const persistFixture = { ...mapperFixture, dispose: async () => {} };
  await pipeline.runShellWaitCase(
    { case: 'rescue-interrupt', codexBinary: process.execPath, sourceSha: 'a'.repeat(40), workerDurationMs: 420_000, capMs: 3_600_000, pollMs: 3_600_000, budgetMs: 1_200_000, output: root },
    { createFixture: async () => persistFixture, executeLiveCase: async () => facts },
  );
  const recordName = (await readdir(root)).find((name) => name.endsWith('.record.json'));
  const reloaded = JSON.parse(await readFile(join(root, recordName), 'utf8'));
  assert.equal(reloaded.child.preCutoffDurableSnapshot.job.projection.status, 'succeeded',
    'the preserved pre-cutoff snapshot persists beside the final read');
  const input = pipeline.nativeInterruptionGateDInput(reloaded);
  // The refresh is still the (fenced) final read: the winner cannot come from it.
  assert.equal(input.durableReadPostCleanupBoundary, true, 'the window-end refresh completed after the cutoff — the named fence');
  assert.equal(input.durableReadBoundaryBasis, 'durable-read-at-or-after-measurement-cutoff');
  assert.equal(input.durableObligations, 'settled', 'obligations still adjudicate through the pre-cutoff samples');
  assert.equal(input.durableSamplesJoin.settlementFallback.basis, 'final-snapshot-fenced-pre-boundary-sample');
  // THE finding-A assertions: the verified pre-cutoff `succeeded` passes.
  assert.equal(input.terminalWinner, 'succeeded',
    'the winner comes from the preserved pre-cutoff authoritative snapshot, never the fenced refresh');
  const verdict = evaluateNativeInterruptionSettlement(input);
  assert.equal(verdict.terminalWinner, 'succeeded');
  assert.equal(verdict.reasons.includes('terminal-winner-unobserved'), false,
    `a verified pre-cutoff succeeded must pass terminal-winner-unobserved: ${JSON.stringify(verdict.reasons)}`);
});

test('a refreshed durable read that stalls at the planned observation end is named and never awaited past it', { timeout: 10_000 }, async () => {
  // Finding B: the window-end refresh was awaited through
  // `buildDurableSettlementLayer`, which races only the experiment budget —
  // a stalled refreshed read kept the turn pending far past the planned
  // observation end (timed out here on the pre-fix bytes). The refresh must
  // be bounded by the endpoint: still pending there → the named missing-read
  // fact rides, the read is abandoned (never awaited), and the turn ends AT
  // the endpoint.
  let monotonic = 0;
  let wall = 500_000;
  const held = await pipeline.runHeldHostTurn({
    launch: async () => ({ result: new Promise((resolve) => setTimeout(() => resolve({ code: 0, stdout: 'sentinel', stderr: '' }), 5)) }),
    waitForGate: async () => {},
    waitForObservation: async () => {},
    captureProcessIdentity: async () => ({ pid: 66172, ppid: 98, nonce: 'a'.repeat(64), startIdentity: 'start-a' }),
    terminateProcessIdentity: async () => ({ attempted: true, signalled: 'SIGTERM', exited: true, failure: null }),
    readProcessIdentity: async () => undefined,
    waitForProcessExit: async () => {},
    sleep: async (ms) => { monotonic += ms; wall += ms; },
    now: () => monotonic,
    wallClockNow: () => wall,
    holdMs: 420_000,
    budgetMs: 1_200_000,
    measurementCutoffSchedule: true,
    sampleDurableSnapshots: { intervalMs: 2_000 },
    // EVERY durable read stalls forever (sampler reads, the gate-release
    // read, and the window-end refresh alike) — each carries an unref'd
    // safety valve so the process can always exit.
    readDurableSnapshot: async () => new Promise((resolve) => { const timer = setTimeout(resolve, 30_000); timer.unref?.(); }),
  });
  assert.equal(held.endedBeforeGate, false);
  assert.equal(held.budgetExpired, false, 'the planned observation end ended the turn — never the experiment budget');
  assert.equal(held.postRelease?.earlyDurableRead, 'durable-read-pending-at-planned-observation-end');
  assert.equal(held.postRelease?.refreshedDurableRead, 'durable-read-pending-at-planned-observation-end',
    'the stalled refreshed read is preserved as a NAMED missing-read fact at the endpoint');
  assert.equal(held.childSettlement?.durableSnapshot?.aggregate, 'unestablished',
    'the abandoned final read rides as the named unestablished observation, never fabricated');
  assert.ok(held.childSettlement?.durableSnapshot?.reasons?.includes('durable-read-pending-at-planned-observation-end'));
  assert.ok(held.timeline.endedAtElapsedMs >= 420_000 + 15_000,
    `the observation ended at the planned endpoint (got ${String(held.timeline.endedAtElapsedMs)})`);
  assert.ok(held.timeline.endedAtElapsedMs < 1_200_000,
    `no budget consumption past the endpoint (got ${String(held.timeline.endedAtElapsedMs)})`);
});

test('a Root still running at the planned observation end is terminated by the RECORDED, awaited cleanup — not the teardown abort', { timeout: 10_000 }, async () => {
  // Finding C: with Root missing at the endpoint, the turn used to return
  // with no termination at all; the exit `finally` then aborted the shared
  // signal as pure WATCHER teardown (recorder inert), the real launch
  // forwarded that abort to runProcess, and the fixture-owned host was
  // terminated WITHOUT a recorded boundary, with `codexTerminated: false`,
  // and with fixture disposal racing the unawaited kill. The registered
  // termination cleanup must run — and be awaited — INSIDE the turn, with
  // the cleanup-boundary recorder active.
  let monotonic = 0;
  let wall = 500_000;
  let terminateSettled = false;
  let terminateCalls = 0;
  const terminateOnce = async () => {
    terminateCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    terminateSettled = true;
  };
  const held = await pipeline.runHeldHostTurn({
    launch: async ({ signal }) => {
      // The real launch forwards the shared abort to runProcess — emulated
      // here on the SAME idempotent terminate so the emulation cannot double-
      // kill after the registered cleanup already ran.
      signal.addEventListener('abort', () => { void terminateOnce(); }, { once: true });
      return {
        result: new Promise((resolve) => {
          // Safety valve only: the §24.8 endpoint must end the observation
          // long before this resolves.
          const timer = setTimeout(() => resolve({ code: 0, stdout: 'too late', stderr: '' }), 30_000);
          timer.unref?.();
        }),
        terminate: terminateOnce,
      };
    },
    waitForGate: async () => {},
    waitForObservation: async () => {},
    captureProcessIdentity: async () => ({ pid: 66173, ppid: 99, nonce: 'a'.repeat(64), startIdentity: 'start-a' }),
    readProcessIdentity: async () => ({ pid: 66173, ppid: 99, nonce: 'a'.repeat(64), startIdentity: 'start-a' }),
    terminateProcessIdentity: async () => { await terminateOnce(); },
    waitForProcessExit: async () => {},
    sleep: async (ms) => { monotonic += ms; wall += ms; },
    now: () => monotonic,
    wallClockNow: () => wall,
    holdMs: 420_000,
    budgetMs: 1_200_000,
    measurementCutoffSchedule: true,
  });
  assert.equal(held.budgetExpired, false);
  assert.equal(held.postRelease?.rootResult, 'root-result-missing-at-planned-observation-end',
    'premise: Root was still running at the planned observation end');
  assert.equal(held.timeline.endedAtElapsedMs >= 420_000 + 15_000, true);
  // THE finding-C assertions: the termination was the REGISTERED cleanup —
  // recorded, reflected in the cleanup flags, and awaited before return.
  assert.equal(held.cleanup.verifiedProcessTerminated, true,
    'the fixture-owned process termination ran inside the turn with the recorder active');
  assert.equal(held.cleanup.codexTerminated, true, 'codexTerminated reflects the real termination');
  assert.equal(typeof held.cleanup.cleanupBoundaryAtMs, 'number',
    `the termination boundary is recorded (got ${String(held.cleanup.cleanupBoundaryAtMs)})`);
  assert.equal(terminateSettled, true,
    'the termination settled before the turn returned — fixture disposal cannot race it');
  assert.ok(terminateCalls >= 1, 'the terminate seam ran (the registered cleanup, then the idempotent teardown forwarder at most)');
  const facts = pipeline.mapShellWaitLiveFacts(
    { case: 'rescue-interrupt', pollMs: 3_600_000, waitPolicy: null, interruptBaselineSelector: null, survivalControlSelector: null },
    held, supportedEvidence(), null, null, mapperFixture, causalRollouts(), [], LAUNCHER,
  );
  assert.equal(facts.held?.processTermination?.codexTerminated, true, 'the mapper mirrors the real termination');
  assert.equal(typeof facts.interrupt?.cleanupBoundaryAtMs, 'number', 'the boundary persists on the interrupt block');
});

// --- codex gate round 3 on the fix bytes: five edge-completion findings (regression tests, RED first) ---

test('an already-exited fixture at the natural-exit endpoint records the fact and never manufactures a kill', { timeout: 30_000 }, async () => {
  // The finding-5 branch's dead-fixture arm: when the natural-exit wait
  // expires but the verified fixture process is ALREADY gone, the branch
  // records the missing exit and terminates nothing — no cleanup boundary is
  // manufactured for a process that no longer exists.
  let monotonic = 0;
  let wall = 500_000;
  let releaseWallMs = null;
  let resolveRootResult = null;
  const held = await pipeline.runHeldHostTurn({
    launch: async () => ({ result: new Promise((resolve) => { resolveRootResult = resolve; }) }),
    waitForGate: async () => {},
    waitForObservation: async () => {},
    captureProcessIdentity: async () => ({ pid: 66185, ppid: 105, nonce: 'a'.repeat(64), startIdentity: 'start-a' }),
    readProcessIdentity: async () => undefined,
    terminateProcessIdentity: async () => { throw new Error('nothing to terminate'); },
    waitForProcessExit: async () => new Promise(() => {}),
    sleep: async (ms) => {
      monotonic += ms;
      wall += ms;
      if (resolveRootResult !== null && releaseWallMs !== null && wall >= releaseWallMs + 1_000) {
        const resolve = resolveRootResult;
        resolveRootResult = null;
        resolve({ code: 0, stdout: 'sentinel', stderr: '' });
      }
    },
    now: () => monotonic,
    wallClockNow: () => wall,
    holdMs: 420_000,
    budgetMs: 1_200_000,
    measurementCutoffSchedule: true,
    releaseGate: async () => { releaseWallMs = wall; },
  });
  assert.equal(held.budgetExpired, false);
  assert.equal(held.result?.stdout, 'sentinel', 'premise: Root returned inside the window');
  assert.equal(held.postRelease?.naturalExit, 'natural-exit-unobserved-at-planned-observation-end');
  assert.equal(held.cleanup.verifiedProcessTerminated, false, 'a disappeared fixture is never signalled');
  assert.equal(held.cleanup.codexTerminated, false, 'the launched handle is never terminated for a dead fixture');
  assert.equal(held.cleanup.cleanupBoundaryAtMs, null, 'NO termination boundary is manufactured for a dead fixture');
  assert.deepEqual(held.cleanup.errors, [], 'the dead fixture leaves no cleanup errors');
});

test('a post-release rejection stops the window and refresh waiters on the shared signal (no busy spin)', { timeout: 60_000 }, async () => {
  // Finding 1: a post-release operation rejecting before the endpoint throws
  // out of the section; the exit finally then aborts the shared signal while
  // `budgetExpired` stays false. The observation-window loop and the
  // refresh-arm loop kept spinning on an `abortableSleep` that now resolves
  // immediately — a hot loop (and timer allocation) until their deadlines.
  // Both loops must observe the shared signal and exit promptly.
  let monotonic = 0;
  let wall = 500_000;
  let released = false;
  let postReleaseSleeps = 0;
  let rejectRootResult = null;
  await assert.rejects(
    pipeline.runHeldHostTurn({
      launch: async () => ({ result: new Promise((_resolve, reject) => { rejectRootResult = reject; }) }),
      waitForGate: async () => {},
      waitForObservation: async () => {},
      captureProcessIdentity: async () => ({ pid: 66181, ppid: 101, nonce: 'a'.repeat(64), startIdentity: 'start-a' }),
      terminateProcessIdentity: async () => ({ attempted: true, signalled: 'SIGTERM', exited: true, failure: null }),
      readProcessIdentity: async () => undefined,
      waitForProcessExit: async () => {},
      // The clock advances fast through the hold and SLOWLY after the
      // release, so a waiter that ignores the abort is visible in the sleep
      // count; every sleep yields a real timer turn so the rejection (and
      // then the finally's abort) can land while the waiters spin.
      sleep: async () => {
        if (released) {
          postReleaseSleeps += 1;
          monotonic += 1;
          wall += 1;
          if (postReleaseSleeps === 50 && rejectRootResult !== null) {
            const reject = rejectRootResult;
            rejectRootResult = null;
            reject(new Error('the host result failed'));
          }
        } else {
          monotonic += 10_000;
          wall += 10_000;
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
      },
      now: () => monotonic,
      wallClockNow: () => wall,
      holdMs: 420_000,
      budgetMs: 1_200_000,
      measurementCutoffSchedule: true,
      sampleDurableSnapshots: { intervalMs: 2_000 },
      readDurableSnapshot: async () => ({ aggregate: 'unresolved', executorLinkage: 'verified', reasons: [], job: { presence: 'found', projection: { status: null } } }),
      releaseGate: async () => { released = true; },
    }),
    /the host result failed/u,
  );
  // Give any still-spinning detached waiter a bounded real-time window to
  // incriminate itself, then require the bounded post-release sleep count.
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.ok(postReleaseSleeps < 200, `the post-release waiters must stop on the shared-signal abort (got ${String(postReleaseSleeps)} post-release sleeps)`);
});

test('a settlement landing later in the credit window is captured by the preserved authoritative read (the +5000 repro)', async (t) => {
  // Finding 2: the gate-release read is captured ONCE — a job settling at
  // release+5000 ms (still strictly before the +10000 ms cutoff) left no
  // authoritative terminal snapshot: this read observed `running`, the
  // window-end refresh is always post-cutoff, and samples never carry the
  // winner. The pre-cutoff read arm must keep taking authoritative reads and
  // preserve the latest completed strictly-pre-cutoff one.
  let monotonic = 0;
  let wall = 500_000;
  let finishAtMs = null;
  let releaseWallMs = null;
  let resolveRootResult = null;
  const RUNNING = { aggregate: 'unresolved', executorLinkage: 'verified', reasons: [], passive: { snapshotEqual: true }, job: { presence: 'found', projection: { id: 'job-1', status: null } }, layers: { bindingCurrency: { state: 'current', anchorsJob: 'job-1' } } };
  const SUCCEEDED = { aggregate: 'settled', executorLinkage: 'verified', reasons: [], passive: { snapshotEqual: true }, job: { presence: 'found', projection: { id: 'job-1', status: 'succeeded' } }, layers: { bindingCurrency: { state: 'current', anchorsJob: 'job-1' } } };
  const held = await pipeline.runHeldHostTurn({
    launch: async () => ({ result: new Promise((resolve) => { resolveRootResult = resolve; }) }),
    waitForGate: async () => {},
    waitForObservation: async () => {},
    captureProcessIdentity: async () => ({ pid: 66182, ppid: 102, nonce: 'a'.repeat(64), startIdentity: 'start-a' }),
    terminateProcessIdentity: async () => ({ attempted: true, signalled: 'SIGTERM', exited: true, failure: null }),
    readProcessIdentity: async () => undefined,
    waitForProcessExit: async () => {},
    sleep: async (ms) => {
      monotonic += ms;
      wall += ms;
      if (resolveRootResult !== null && releaseWallMs !== null && wall >= releaseWallMs + 1_000) {
        const resolve = resolveRootResult;
        resolveRootResult = null;
        resolve({ code: 0, stdout: 'sentinel', stderr: '' });
      }
    },
    now: () => monotonic,
    wallClockNow: () => wall,
    holdMs: 420_000,
    budgetMs: 1_200_000,
    measurementCutoffSchedule: true,
    sampleDurableSnapshots: { intervalMs: 2_000 },
    readDurableSnapshot: async () => (
      finishAtMs !== null && wall >= finishAtMs ? SUCCEEDED : RUNNING
    ),
    releaseGate: async () => {
      // The lawful natural finish lands at release+5000 ms — strictly before
      // the cutoff at release+10000 ms.
      finishAtMs = wall + 5_000;
      releaseWallMs = wall;
    },
  });
  assert.equal(held.endedBeforeGate, false);
  assert.equal(held.budgetExpired, false);
  assert.ok(held.childSettlement?.preCutoffDurableSnapshot, 'a pre-cutoff authoritative snapshot survived');
  assert.equal(held.childSettlement.preCutoffDurableSnapshot.job.projection.status, 'succeeded');
  assert.ok(held.childSettlement.preCutoffDurableSnapshot.completedAtMs < held.cleanup.measurementCutoffAtMs,
    'the preserved read completed strictly before the armed cutoff');
  const facts = pipeline.mapShellWaitLiveFacts(
    { case: 'rescue-interrupt', pollMs: 3_600_000, waitPolicy: null, interruptBaselineSelector: null, survivalControlSelector: null },
    held, supportedEvidence(), null, null, mapperFixture, causalRollouts(), [], LAUNCHER,
  );
  const root = await mkdtemp(join(tmpdir(), 'shell-wait-native-interruption-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const persistFixture = { ...mapperFixture, dispose: async () => {} };
  await pipeline.runShellWaitCase(
    { case: 'rescue-interrupt', codexBinary: process.execPath, sourceSha: 'a'.repeat(40), workerDurationMs: 420_000, capMs: 3_600_000, pollMs: 3_600_000, budgetMs: 1_200_000, output: root },
    { createFixture: async () => persistFixture, executeLiveCase: async () => facts },
  );
  const recordName = (await readdir(root)).find((name) => name.endsWith('.record.json'));
  const reloaded = JSON.parse(await readFile(join(root, recordName), 'utf8'));
  assert.equal(reloaded.child.preCutoffDurableSnapshot.job.projection.status, 'succeeded');
  const input = pipeline.nativeInterruptionGateDInput(reloaded);
  assert.equal(input.durableReadBoundaryBasis, 'durable-read-at-or-after-measurement-cutoff', 'the window-end refresh is still the fenced final read');
  assert.equal(input.terminalWinner, 'succeeded',
    'the later pre-cutoff settlement is winner-credible through the preserved snapshot');
  const verdict = evaluateNativeInterruptionSettlement(input);
  assert.equal(verdict.reasons.includes('terminal-winner-unobserved'), false, JSON.stringify(verdict.reasons));
});

test('the preserved snapshot outdates the latest sample for EVERY settlement layer (the +9000/+9900 repro)', async (t) => {
  // Finding 3: the last sampler observation is `running` at release+9000 ms
  // while the preserved authoritative read observes settled/succeeded at
  // +9900 ms — before the +10000 ms cutoff. The winner arm credited the
  // preserved snapshot but the Companion and obligations branches still
  // selected the OLDER running sample (survived-unsettled / unresolved). The
  // admitted preserved snapshot must join the latest-creditable-evidence
  // selection for every layer.
  let monotonic = 0;
  let wall = 500_000;
  let finishAtMs = null;
  let releaseWallMs = null;
  let resolveRootResult = null;
  const RUNNING = { aggregate: 'unresolved', executorLinkage: 'verified', reasons: [], passive: { snapshotEqual: true }, job: { presence: 'found', projection: { id: 'job-1', status: null } }, layers: { bindingCurrency: { state: 'current', anchorsJob: 'job-1' } } };
  const SUCCEEDED = { aggregate: 'settled', executorLinkage: 'verified', reasons: [], passive: { snapshotEqual: true }, job: { presence: 'found', projection: { id: 'job-1', status: 'succeeded', ownerSessionId: ROOT_THREAD } }, layers: { bindingCurrency: { state: 'current', anchorsJob: 'job-1' } } };
  const held = await pipeline.runHeldHostTurn({
    launch: async () => ({ result: new Promise((resolve) => { resolveRootResult = resolve; }) }),
    waitForGate: async () => {},
    waitForObservation: async () => {},
    captureProcessIdentity: async () => ({ pid: 66183, ppid: 103, nonce: 'a'.repeat(64), startIdentity: 'start-a' }),
    terminateProcessIdentity: async () => ({ attempted: true, signalled: 'SIGTERM', exited: true, failure: null }),
    readProcessIdentity: async () => undefined,
    waitForProcessExit: async () => {},
    sleep: async (ms) => {
      monotonic += ms;
      wall += ms;
      if (resolveRootResult !== null && releaseWallMs !== null && wall >= releaseWallMs + 1_000) {
        const resolve = resolveRootResult;
        resolveRootResult = null;
        resolve({ code: 0, stdout: 'sentinel', stderr: '' });
      }
    },
    now: () => monotonic,
    wallClockNow: () => wall,
    holdMs: 420_000,
    budgetMs: 1_200_000,
    measurementCutoffSchedule: true,
    // No passive sampler here: the sampler's coarse interval jumps share the
    // injected clock and would skip over the read arm's final pre-cutoff
    // stretch; the deterministic sampler-vs-preserved selection is pinned by
    // the join-level test below.
    readDurableSnapshot: async () => (finishAtMs !== null && wall >= finishAtMs ? SUCCEEDED : RUNNING),
    releaseGate: async () => {
      // The finish lands ~1500 ms BEFORE the armed measurement cutoff (the
      // cutoff is armed from the hold-deadline wall crossing +10000; the
      // wall can drift a concurrent sampler interval past this gate
      // crossing, so the margin exceeds one sampler jump): the late
      // pre-cutoff sampler observations still report running, while the
      // read arm's pulled-in read just before the cutoff observes the
      // settlement.
      finishAtMs = wall + 10_000 - 1_500;
      releaseWallMs = wall;
    },
  });
  assert.equal(held.budgetExpired, false);
  assert.equal(held.childSettlement?.preCutoffDurableSnapshot?.job?.projection?.status, 'succeeded',
    'the preserved read at ~release+9900 observed the settlement');
  const facts = pipeline.mapShellWaitLiveFacts(
    { case: 'rescue-interrupt', pollMs: 3_600_000, waitPolicy: null, interruptBaselineSelector: null, survivalControlSelector: null },
    held, supportedEvidence(), null, null, mapperFixture, causalRollouts(), [], LAUNCHER,
  );
  const root = await mkdtemp(join(tmpdir(), 'shell-wait-native-interruption-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const persistFixture = { ...mapperFixture, dispose: async () => {} };
  await pipeline.runShellWaitCase(
    { case: 'rescue-interrupt', codexBinary: process.execPath, sourceSha: 'a'.repeat(40), workerDurationMs: 420_000, capMs: 3_600_000, pollMs: 3_600_000, budgetMs: 1_200_000, output: root },
    { createFixture: async () => persistFixture, executeLiveCase: async () => facts },
  );
  const recordName = (await readdir(root)).find((name) => name.endsWith('.record.json'));
  const reloaded = JSON.parse(await readFile(join(root, recordName), 'utf8'));
  const input = pipeline.nativeInterruptionGateDInput(reloaded);
  assert.equal(input.terminalWinner, 'succeeded');
  assert.equal(input.companionOutcome, 'terminal-result',
    `the preserved snapshot must outdate the older running sample for the Companion layer (got ${String(input.companionOutcome)})`);
  assert.equal(input.durableObligations, 'settled',
    `the preserved snapshot must outdate the older running sample for the obligations layer (got ${String(input.durableObligations)})`);
  const verdict = evaluateNativeInterruptionSettlement(input);
  assert.equal(verdict.reasons.includes('terminal-winner-unobserved'), false, JSON.stringify(verdict.reasons));
  assert.equal(verdict.reasons.includes('companion-still-live-unsettled'), false, JSON.stringify(verdict.reasons));
  assert.equal(verdict.reasons.includes('durable-obligations-unresolved'), false, JSON.stringify(verdict.reasons));
});

test('the admitted preserved snapshot outdates an older running sample in the join layer selection (deterministic)', () => {
  // Finding 3 at the join level: the last sampler observation is `running`
  // ~1000 ms before the cutoff while the preserved authoritative read
  // observes settled/succeeded ~100 ms before it. The winner arm credits the
  // preserved snapshot AND the Companion/obligations branches must select the
  // LATEST creditable evidence (the preserved snapshot), never the older
  // running sample.
  const preserved = {
    aggregate: 'settled', executorLinkage: 'verified', reasons: [], completedAtMs: MEASUREMENT_CUTOFF_AT_MS - 100,
    passive: { snapshotEqual: true },
    job: { presence: 'found', projection: { id: 'job-1', status: 'succeeded', ownerSessionId: ROOT_THREAD } },
  };
  const runningSample = (completedAtMs) => ({
    attemptIndex: 429, baseline: false, transition: false, startedAtMs: completedAtMs - 500, completedAtMs,
    aggregate: 'unresolved', jobPresence: 'found', jobStatus: null,
    stopCause: null, stopIntentCause: null, stopIntentRequestedAt: null,
    executorLinkage: 'verified', snapshotEqual: true, lockState: 'present', partitionStatus: 'resolved',
    layers: { bindingCurrency: { state: 'current', anchorsJob: 'job-1' } },
  });
  const record = {
    case: 'rescue-interrupt',
    linkage: { parentThreadId: ROOT_THREAD, childThreadId: CHILD_THREAD },
    interrupt: { measurementCutoffAtMs: MEASUREMENT_CUTOFF_AT_MS },
    child: {
      settlement: { observed: false, basis: null },
      durableSnapshot: { aggregate: 'unestablished', reasons: ['durable-read-at-or-after-measurement-cutoff'], sampledAggregate: 'settled' },
      preCutoffDurableSnapshot: preserved,
      durableSamples: { version: 1, summaries: [runningSample(MEASUREMENT_CUTOFF_AT_MS - 1_000)] },
    },
  };
  const input = pipeline.nativeInterruptionGateDInput(record);
  assert.equal(input.terminalWinner, 'succeeded');
  assert.equal(input.companionOutcome, 'terminal-result',
    `the preserved snapshot must outdate the older running sample for the Companion layer (got ${String(input.companionOutcome)})`);
  assert.equal(input.durableObligations, 'settled',
    `the preserved snapshot must outdate the older running sample for the obligations layer (got ${String(input.durableObligations)})`);
  const verdict = evaluateNativeInterruptionSettlement(input);
  assert.equal(verdict.reasons.includes('companion-still-live-unsettled'), false, JSON.stringify(verdict.reasons));
  assert.equal(verdict.reasons.includes('durable-obligations-unresolved'), false, JSON.stringify(verdict.reasons));
});

test('the preserved snapshot validates its OWN owning Root — a foreign owner never credits (final snapshot irrelevant)', () => {
  // Finding 4: the owning-Root conflict is computed exclusively from the
  // FINAL snapshot. A record whose final snapshot matches the observed Root
  // (or is an ownerless placeholder) but whose preserved snapshot names
  // ANOTHER owner must refuse the preserved arm's winner credit.
  const FOREIGN = 'foreign-root-thread';
  const preCutoffForeign = {
    aggregate: 'settled', executorLinkage: 'verified', reasons: [], completedAtMs: MEASUREMENT_CUTOFF_AT_MS - 1_000,
    passive: { snapshotEqual: true },
    job: { presence: 'found', projection: { id: 'job-1', status: 'succeeded', ownerSessionId: FOREIGN } },
  };
  const base = (finalSnapshot) => ({
    case: 'rescue-interrupt',
    linkage: { parentThreadId: ROOT_THREAD, childThreadId: CHILD_THREAD },
    interrupt: { measurementCutoffAtMs: MEASUREMENT_CUTOFF_AT_MS },
    child: {
      settlement: { observed: false, basis: null },
      durableSnapshot: finalSnapshot,
      preCutoffDurableSnapshot: preCutoffForeign,
    },
  });
  // (a) the reviewer's shape: the FINAL snapshot matches the observed Root.
  const matchingFinal = {
    aggregate: 'settled', executorLinkage: 'verified', reasons: [], completedAtMs: MEASUREMENT_CUTOFF_AT_MS + 5_000,
    passive: { snapshotEqual: true },
    job: { presence: 'found', projection: { id: 'job-1', status: 'succeeded', ownerSessionId: ROOT_THREAD } },
  };
  const matched = pipeline.nativeInterruptionGateDInput(base(matchingFinal));
  assert.equal(matched.spawnIdentityJoin.owningRootBound, true, 'the final snapshot still binds to the observed Root');
  assert.equal(matched.terminalWinner, null,
    'a foreign-owner preserved snapshot never grounds the terminal winner');
  // (b) the ownerless final placeholder does not bypass the validation.
  const placeholderFinal = { aggregate: 'unestablished', reasons: ['durable-read-pending-at-planned-observation-end'], sampledAggregate: null };
  const placeholder = pipeline.nativeInterruptionGateDInput(base(placeholderFinal));
  assert.equal(placeholder.spawnIdentityJoin.owningRootBound, null, 'the ownerless final binds nobody');
  assert.equal(placeholder.terminalWinner, null,
    'the ownerless final placeholder must not bypass the preserved snapshot\'s owner validation');
});

test('a resolvable foreign-owner conflict on the preserved snapshot disables the settlement sample fallback too', () => {
  // Codex gate round-19 finding 1's repro (the reviewer's shape): the final
  // snapshot is an OWNERLESS fenced placeholder (binds nobody —
  // `owningRootBound` null, the credit withheld), the PRESERVED snapshot
  // names a resolvable FOREIGN Root (its own arm is refused), and the
  // §23.5 samples anchored to that same job are credit-eligible. The
  // pre-fix fallback guard keyed ONLY on the final snapshot's conflict, so
  // the anchored samples still entered the fallback:
  // `durableObligations: 'settled'` and `companionOutcome:
  // 'terminal-result'` rode on contradictory identity evidence while
  // `owningRootBound` stayed null. The preserved snapshot's resolvable
  // owner conflict must propagate into the fallback guard — samples
  // anchored to that same job cannot receive settlement-layer credit —
  // with the conflict provenance riding the join.
  const FOREIGN = 'foreign-root-thread';
  const record = (preservedOwnerSessionId) => ({
    case: 'rescue-interrupt',
    linkage: { parentThreadId: ROOT_THREAD, childThreadId: CHILD_THREAD },
    interrupt: { measurementCutoffAtMs: MEASUREMENT_CUTOFF_AT_MS },
    child: {
      settlement: { observed: false, basis: null },
      durableSnapshot: { aggregate: 'unestablished', reasons: ['durable-read-pending-at-planned-observation-end'], sampledAggregate: null },
      preCutoffDurableSnapshot: {
        aggregate: 'settled', executorLinkage: 'verified', reasons: [], completedAtMs: MEASUREMENT_CUTOFF_AT_MS - 1_000,
        passive: { snapshotEqual: true },
        job: { presence: 'found', projection: { id: 'job-1', status: 'succeeded', ownerSessionId: preservedOwnerSessionId } },
      },
      durableSamples: {
        version: 1,
        summaries: [{
          attemptIndex: 7, baseline: false, transition: false, startedAtMs: 1000, completedAtMs: 2000,
          aggregate: 'settled', jobPresence: 'found', jobStatus: 'succeeded',
          stopCause: null, stopIntentCause: null, stopIntentRequestedAt: null,
          executorLinkage: 'verified', snapshotEqual: true, lockState: null, partitionStatus: null,
          layers: { bindingCurrency: { state: 'current', anchorsJob: 'job-1' } },
        }],
      },
    },
  });
  const conflicted = pipeline.nativeInterruptionGateDInput(record(FOREIGN));
  assert.equal(conflicted.spawnIdentityJoin.owningRootBound, null, 'premise: the ownerless final binds nobody');
  assert.equal(conflicted.durableSamplesJoin.admitted.length, 1, 'the sample still rides as an OBSERVATION fact — never erased');
  assert.equal(conflicted.durableSamplesJoin.settlementFallback.used, false,
    'the settlement sample fallback never fires under the preserved owner conflict');
  assert.equal(conflicted.durableSamplesJoin.settlementFallback.basis, 'preserved-owner-identity-conflict',
    `the conflict provenance rides the join (basis: ${String(conflicted.durableSamplesJoin.settlementFallback.basis)})`);
  assert.equal(conflicted.durableObligations, null,
    `contradictory identity evidence never receives the settlement-layer credit (obligations: ${String(conflicted.durableObligations)})`);
  assert.notEqual(conflicted.companionOutcome, 'terminal-result',
    `the Companion outcome is never terminal-result on contradictory identity evidence (outcome: ${String(conflicted.companionOutcome)})`);
  assert.equal(conflicted.terminalWinner, null, 'the winner conjunct stays sample-free and refused');
  // The distinction holds: the SAME shape with the preserved owner MATCHING
  // the observed Root keeps the registered fallback behavior — the anchored
  // samples ground the fenced final's layer facts as before.
  const matching = pipeline.nativeInterruptionGateDInput(record(ROOT_THREAD));
  assert.equal(matching.durableSamplesJoin.settlementFallback.used, true,
    'the fallback still fires when the preserved owner matches the observed Root');
  assert.equal(matching.durableSamplesJoin.settlementFallback.basis, 'final-snapshot-fenced-pre-boundary-sample');
  assert.equal(matching.durableObligations, 'settled');
  assert.equal(matching.companionOutcome, 'terminal-result');
});

test('a live fixture surviving the natural-exit endpoint is terminated by the RECORDED, awaited cleanup', { timeout: 30_000 }, async () => {
  // Finding 5: Root returns late but the verified fixture process is STILL
  // alive when the natural-exit wait reaches the planned endpoint — the
  // branch only recorded the missing exit, so the turn returned without
  // terminating the fixture, without a cleanup boundary, and with the losing
  // wait still running past disposal.
  let monotonic = 0;
  let wall = 500_000;
  let finishAtMs = null;
  let releaseWallMs = null;
  let resolveRootResult = null;
  let terminateSettled = false;
  let exitWaitSettled = false;
  const terminateOnce = async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    terminateSettled = true;
  };
  const held = await pipeline.runHeldHostTurn({
    launch: async ({ signal }) => {
      signal.addEventListener('abort', () => { void terminateOnce(); }, { once: true });
      return {
        result: new Promise((resolve) => { resolveRootResult = resolve; }),
        terminate: terminateOnce,
      };
    },
    waitForGate: async () => {},
    waitForObservation: async () => {},
    captureProcessIdentity: async () => ({ pid: 66184, ppid: 104, nonce: 'a'.repeat(64), startIdentity: 'start-a' }),
    readProcessIdentity: async () => ({ pid: 66184, ppid: 104, nonce: 'a'.repeat(64), startIdentity: 'start-a' }),
    terminateProcessIdentity: async () => { await terminateOnce(); },
    // The natural-exit watch resolves only when the fixture is terminated —
    // the real watcher's semantics.
    waitForProcessExit: async () => new Promise((resolve) => {
      const check = setInterval(() => { if (terminateSettled) { clearInterval(check); exitWaitSettled = true; resolve(); } }, 5);
      check.unref?.();
    }),
    sleep: async (ms) => {
      monotonic += ms;
      wall += ms;
      if (resolveRootResult !== null && releaseWallMs !== null && wall >= releaseWallMs + 14_000) {
        const resolve = resolveRootResult;
        resolveRootResult = null;
        resolve({ code: 0, stdout: 'sentinel', stderr: '' });
      }
    },
    now: () => monotonic,
    wallClockNow: () => wall,
    holdMs: 420_000,
    budgetMs: 1_200_000,
    measurementCutoffSchedule: true,
    readDurableSnapshot: async () => (finishAtMs !== null && wall >= finishAtMs ? { aggregate: 'unresolved', executorLinkage: 'verified', reasons: [], job: { presence: 'found', projection: { status: null } } } : { aggregate: 'unresolved', executorLinkage: 'verified', reasons: [], job: { presence: 'found', projection: { status: null } } }),
    releaseGate: async () => {
      // Root returns LATE (release+14000 ms, inside the window) while the
      // fixture process lives on past the natural-exit endpoint.
      finishAtMs = wall + 20_000;
      releaseWallMs = wall;
    },
  });
  assert.equal(held.budgetExpired, false);
  assert.equal(held.result?.stdout, 'sentinel', 'premise: Root returned late but inside the window');
  assert.equal(held.postRelease?.naturalExit, 'natural-exit-unobserved-at-planned-observation-end',
    'premise: the natural-exit wait reached the endpoint');
  // THE finding-5 assertions.
  assert.equal(held.cleanup.verifiedProcessTerminated, true,
    'the live fixture was terminated by the registered cleanup inside the turn');
  assert.equal(held.cleanup.codexTerminated, true);
  assert.equal(typeof held.cleanup.cleanupBoundaryAtMs, 'number',
    `the termination boundary is recorded (got ${String(held.cleanup.cleanupBoundaryAtMs)})`);
  assert.equal(terminateSettled, true, 'the termination settled before the turn returned');
  assert.equal(exitWaitSettled, true, 'the losing natural-exit wait cannot outlive disposal');
});

// --- codex gate round 4: the last unexplored corners of the window mechanism (regression tests, RED first) ---

test('a native cancellation at/after the measurement cutoff never credits settlement or latency (retained as an observation)', async (t) => {
  // Finding 1: the cutoff fence gated durable reads but left the NATIVE
  // settlement and its responsiveness latency credited — a cancellation
  // arriving at cutoff+1000 ms with a valid pre-cutoff succeeded snapshot
  // returned qualified: true. §24.4 f5: pre-cutoff + pre-boundary credit
  // only; the late event rides the record as a named observation.
  const cancellationAtMs = MEASUREMENT_CUTOFF_AT_MS + 1_000;
  const rollouts = causalRollouts({ completedAtMs: cancellationAtMs });
  const childEvents = rollouts[1];
  const nativeOutput = childEvents.find((event) => /** @type {any} */ (event)?.payload?.call_id === 'outer-native'
    && /** @type {any} */ (event)?.payload?.type === 'function_call_output');
  if (nativeOutput) nativeOutput.timestamp = new Date(cancellationAtMs).toISOString();
  const rootItem = rollouts[0].find((event) => /** @type {any} */ (event)?.payload?.item?.type === 'SubAgentActivity');
  if (rootItem) rootItem.timestamp = new Date(cancellationAtMs).toISOString();
  const held = {
    ...heldObservationWithSchedule(),
    childSettlement: {
      observed: false, basis: null,
      layers: { remoteTerminal: null, localProcessReaping: null, durableObligations: 'settled' },
      // The reviewer's shape: a valid PRE-CUTOFF succeeded snapshot survives.
      preCutoffDurableSnapshot: {
        aggregate: 'settled', executorLinkage: 'verified', reasons: [], completedAtMs: MEASUREMENT_CUTOFF_AT_MS - 500,
        passive: { snapshotEqual: true },
        job: { presence: 'found', projection: { id: 'job-1', status: 'succeeded', ownerSessionId: ROOT_THREAD } },
      },
      durableSamples: { version: 1, summaries: [] },
    },
  };
  const facts = mapScheduled(rollouts, supportedEvidence(), held);
  // THE finding-1 assertions: the late cancellation is retained but credited
  // with neither settlement nor latency.
  assert.equal(facts.interrupt.cancelledAtMs, cancellationAtMs, 'the late cancellation marker rides as an observation');
  assert.equal(facts.interrupt.settled, null,
    'a cancellation at/after the cutoff must not settle the interrupted turn');
  assert.equal(facts.interrupt.settledBasis, 'measurement-cutoff-settlement-not-attributed');
  assert.equal(facts.interrupt.deliveryToSettlementMs, null, 'no responsiveness latency past the cutoff');
  const root = await mkdtemp(join(tmpdir(), 'shell-wait-native-interruption-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const persistFixture = { ...mapperFixture, dispose: async () => {} };
  await pipeline.runShellWaitCase(
    { case: 'rescue-interrupt', codexBinary: process.execPath, sourceSha: 'a'.repeat(40), workerDurationMs: 420_000, capMs: 3_600_000, pollMs: 3_600_000, budgetMs: 1_200_000, output: root },
    { createFixture: async () => persistFixture, executeLiveCase: async () => facts },
  );
  const recordName = (await readdir(root)).find((name) => name.endsWith('.record.json'));
  const reloaded = JSON.parse(await readFile(join(root, recordName), 'utf8'));
  const input = pipeline.nativeInterruptionGateDInput(reloaded);
  assert.equal(input.turnSettled, null);
  const verdict = evaluateNativeInterruptionSettlement(input);
  assert.equal(verdict.qualified, false);
  assert.ok(verdict.reasons.includes('turn-settlement-unobserved'), JSON.stringify(verdict.reasons));
  // The completion arm: an exit-code completion at/after the cutoff is
  // likewise retained but credited with neither settlement nor latency.
  const lateCompletionEvidence = supportedEvidence();
  lateCompletionEvidence.facts.completion.qualified = true;
  const lateCompletionRollouts = causalRollouts({ childTerminalBeforeCall: true, withNativeResolution: false, completedAtMs: cancellationAtMs });
  // Re-stamp the exit-code completion AFTER the call (the registration's
  // pre-call completion events would trip the post-completion guard).
  const completionOutput = lateCompletionRollouts[1].find((event) => /** @type {any} */ (event)?.payload?.call_id === 'outer-1'
    && /** @type {any} */ (event)?.payload?.type === 'function_call_output');
  if (completionOutput) completionOutput.timestamp = new Date(cancellationAtMs).toISOString();
  const lateCompletionFacts = mapScheduled(lateCompletionRollouts, lateCompletionEvidence, held);
  assert.equal(lateCompletionFacts.interrupt.settled, null,
    'a completion at/after the cutoff must not settle the interrupted turn');
  assert.equal(lateCompletionFacts.interrupt.settledBasis, 'measurement-cutoff-settlement-not-attributed');
  assert.equal(lateCompletionFacts.interrupt.deliveryToSettlementMs, null);
  // The keeper: a cancellation strictly BEFORE the cutoff keeps full credit.
  const earlyRollouts = causalRollouts({ completedAtMs: MEASUREMENT_CUTOFF_AT_MS - 2_000 });
  const earlyNative = earlyRollouts[1].find((event) => /** @type {any} */ (event)?.payload?.call_id === 'outer-native'
    && /** @type {any} */ (event)?.payload?.type === 'function_call_output');
  if (earlyNative) earlyNative.timestamp = new Date(MEASUREMENT_CUTOFF_AT_MS - 2_000).toISOString();
  const earlyRootItem = earlyRollouts[0].find((event) => /** @type {any} */ (event)?.payload?.item?.type === 'SubAgentActivity');
  if (earlyRootItem) earlyRootItem.timestamp = new Date(MEASUREMENT_CUTOFF_AT_MS - 2_000).toISOString();
  const earlyFacts = mapScheduled(earlyRollouts, supportedEvidence(), {
    ...held,
    childSettlement: { ...held.childSettlement, preCutoffDurableSnapshot: { ...held.childSettlement.preCutoffDurableSnapshot, completedAtMs: MEASUREMENT_CUTOFF_AT_MS - 3_000 } },
  });
  assert.equal(earlyFacts.interrupt.settled, true, 'the keeper: a pre-cutoff cancellation still settles');
  assert.equal(earlyFacts.interrupt.settledBasis, 'native-cancellation-settlement-after-delivery');
});

test('the read arm runs concurrently with the window: a late Root return cannot push authoritative reads past the cutoff', async (t) => {
  // Finding 2: the read arm was serialized behind the Root result and
  // natural-exit waits — Root returning at release+12000 ms started every
  // authoritative read past the +10000 ms cutoff even though the job settled
  // at release+3000 ms. The arm must run from the window's start.
  let monotonic = 0;
  let wall = 500_000;
  let finishAtMs = null;
  let releaseWallMs = null;
  let resolveRootResult = null;
  const RUNNING = { aggregate: 'unresolved', executorLinkage: 'verified', reasons: [], passive: { snapshotEqual: true }, job: { presence: 'found', projection: { id: 'job-1', status: null } }, layers: { bindingCurrency: { state: 'current', anchorsJob: 'job-1' } } };
  const SUCCEEDED = { aggregate: 'settled', executorLinkage: 'verified', reasons: [], passive: { snapshotEqual: true }, job: { presence: 'found', projection: { id: 'job-1', status: 'succeeded' } }, layers: { bindingCurrency: { state: 'current', anchorsJob: 'job-1' } } };
  const held = await pipeline.runHeldHostTurn({
    launch: async () => ({ result: new Promise((resolve) => { resolveRootResult = resolve; }) }),
    waitForGate: async () => {},
    waitForObservation: async () => {},
    captureProcessIdentity: async () => ({ pid: 66191, ppid: 106, nonce: 'a'.repeat(64), startIdentity: 'start-a' }),
    terminateProcessIdentity: async () => ({ attempted: true, signalled: 'SIGTERM', exited: true, failure: null }),
    readProcessIdentity: async () => undefined,
    waitForProcessExit: async () => {},
    sleep: async (ms) => {
      monotonic += ms;
      wall += ms;
      // Root returns LATE: release+12000 ms — after the +10000 ms cutoff but
      // inside the window (before the +15000 ms endpoint).
      if (resolveRootResult !== null && releaseWallMs !== null && wall >= releaseWallMs + 12_000) {
        const resolve = resolveRootResult;
        resolveRootResult = null;
        resolve({ code: 0, stdout: 'sentinel', stderr: '' });
      }
    },
    now: () => monotonic,
    wallClockNow: () => wall,
    holdMs: 420_000,
    budgetMs: 1_200_000,
    measurementCutoffSchedule: true,
    readDurableSnapshot: async () => (finishAtMs !== null && wall >= finishAtMs ? SUCCEEDED : RUNNING),
    releaseGate: async () => {
      // The job settles at release+3000 ms — strictly pre-cutoff.
      finishAtMs = wall + 3_000;
      releaseWallMs = wall;
    },
  });
  assert.equal(held.budgetExpired, false);
  assert.equal(held.result?.stdout, 'sentinel', 'premise: Root returned at release+12000 ms');
  assert.ok(held.childSettlement?.preCutoffDurableSnapshot,
    'pre-cutoff authoritative reads happened despite the late Root return');
  assert.equal(held.childSettlement.preCutoffDurableSnapshot.job.projection.status, 'succeeded');
  assert.ok(held.childSettlement.preCutoffDurableSnapshot.completedAtMs < held.cleanup.measurementCutoffAtMs,
    'the preserved read completed strictly before the armed cutoff');
  const facts = pipeline.mapShellWaitLiveFacts(
    { case: 'rescue-interrupt', pollMs: 3_600_000, waitPolicy: null, interruptBaselineSelector: null, survivalControlSelector: null },
    held, supportedEvidence(), null, null, mapperFixture, causalRollouts(), [], LAUNCHER,
  );
  const root = await mkdtemp(join(tmpdir(), 'shell-wait-native-interruption-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const persistFixture = { ...mapperFixture, dispose: async () => {} };
  await pipeline.runShellWaitCase(
    { case: 'rescue-interrupt', codexBinary: process.execPath, sourceSha: 'a'.repeat(40), workerDurationMs: 420_000, capMs: 3_600_000, pollMs: 3_600_000, budgetMs: 1_200_000, output: root },
    { createFixture: async () => persistFixture, executeLiveCase: async () => facts },
  );
  const recordName = (await readdir(root)).find((name) => name.endsWith('.record.json'));
  const reloaded = JSON.parse(await readFile(join(root, recordName), 'utf8'));
  const input = pipeline.nativeInterruptionGateDInput(reloaded);
  assert.equal(input.terminalWinner, 'succeeded',
    'the winner is creditable from a pre-cutoff snapshot despite the late Root return');
  const verdict = evaluateNativeInterruptionSettlement(input);
  assert.equal(verdict.reasons.includes('terminal-winner-unobserved'), false, JSON.stringify(verdict.reasons));
});

test('a torn terminal projection keeps the read arm reading until a consistent success lands', async (t) => {
  // Finding 3: a durable read can retain a terminal job projection while
  // reporting aggregate 'unestablished' with snapshotEqual false (the
  // partition changed during the read). Stopping the arm on that projection
  // traded a recoverable later consistent success for a snapshot the join
  // refuses. The early-stop predicate now requires authority AND integrity.
  let monotonic = 0;
  let wall = 500_000;
  let finishAtMs = null;
  let releaseWallMs = null;
  let resolveRootResult = null;
  let readCalls = 0;
  const RUNNING = { aggregate: 'unresolved', executorLinkage: 'verified', reasons: [], passive: { snapshotEqual: true }, job: { presence: 'found', projection: { id: 'job-1', status: null } }, layers: { bindingCurrency: { state: 'current', anchorsJob: 'job-1' } } };
  const TORN = { aggregate: 'unestablished', executorLinkage: 'verified', reasons: ['partition-changed-during-read'], passive: { snapshotEqual: false }, job: { presence: 'found', projection: { id: 'job-1', status: 'succeeded' } }, layers: { bindingCurrency: { state: 'current', anchorsJob: 'job-1' } } };
  const SUCCEEDED = { aggregate: 'settled', executorLinkage: 'verified', reasons: [], passive: { snapshotEqual: true }, job: { presence: 'found', projection: { id: 'job-1', status: 'succeeded' } }, layers: { bindingCurrency: { state: 'current', anchorsJob: 'job-1' } } };
  const held = await pipeline.runHeldHostTurn({
    launch: async () => ({ result: new Promise((resolve) => { resolveRootResult = resolve; }) }),
    waitForGate: async () => {},
    waitForObservation: async () => {},
    captureProcessIdentity: async () => ({ pid: 66192, ppid: 107, nonce: 'a'.repeat(64), startIdentity: 'start-a' }),
    terminateProcessIdentity: async () => ({ attempted: true, signalled: 'SIGTERM', exited: true, failure: null }),
    readProcessIdentity: async () => undefined,
    waitForProcessExit: async () => {},
    sleep: async (ms) => {
      monotonic += ms;
      wall += ms;
      if (resolveRootResult !== null && releaseWallMs !== null && wall >= releaseWallMs + 1_000) {
        const resolve = resolveRootResult;
        resolveRootResult = null;
        resolve({ code: 0, stdout: 'sentinel', stderr: '' });
      }
    },
    now: () => monotonic,
    wallClockNow: () => wall,
    holdMs: 420_000,
    budgetMs: 1_200_000,
    measurementCutoffSchedule: true,
    readDurableSnapshot: async () => {
      readCalls += 1;
      // The gate-release read observes the torn terminal partition; every
      // later read (post-finish) observes the consistent success.
      if (finishAtMs !== null && wall >= finishAtMs) return SUCCEEDED;
      if (readCalls === 1) return TORN;
      return RUNNING;
    },
    releaseGate: async () => {
      finishAtMs = wall + 2_000;
      releaseWallMs = wall;
    },
  });
  assert.equal(held.budgetExpired, false);
  assert.ok(held.childSettlement?.preCutoffDurableSnapshot, 'a pre-cutoff authoritative snapshot survived');
  assert.equal(held.childSettlement.preCutoffDurableSnapshot.aggregate, 'settled',
    'the preserved snapshot is the later CONSISTENT success, not the torn terminal read');
  assert.equal(held.childSettlement.preCutoffDurableSnapshot.passive.snapshotEqual, true);
  assert.ok(readCalls >= 3, `the arm kept reading past the torn terminal projection (got ${String(readCalls)} reads)`);
  const facts = pipeline.mapShellWaitLiveFacts(
    { case: 'rescue-interrupt', pollMs: 3_600_000, waitPolicy: null, interruptBaselineSelector: null, survivalControlSelector: null },
    held, supportedEvidence(), null, null, mapperFixture, causalRollouts(), [], LAUNCHER,
  );
  const root = await mkdtemp(join(tmpdir(), 'shell-wait-native-interruption-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const persistFixture = { ...mapperFixture, dispose: async () => {} };
  await pipeline.runShellWaitCase(
    { case: 'rescue-interrupt', codexBinary: process.execPath, sourceSha: 'a'.repeat(40), workerDurationMs: 420_000, capMs: 3_600_000, pollMs: 3_600_000, budgetMs: 1_200_000, output: root },
    { createFixture: async () => persistFixture, executeLiveCase: async () => facts },
  );
  const recordName = (await readdir(root)).find((name) => name.endsWith('.record.json'));
  const reloaded = JSON.parse(await readFile(join(root, recordName), 'utf8'));
  const input = pipeline.nativeInterruptionGateDInput(reloaded);
  assert.equal(input.terminalWinner, 'succeeded',
    'the later consistent pre-cutoff success supplies the winner');
  const verdict = evaluateNativeInterruptionSettlement(input);
  assert.equal(verdict.reasons.includes('terminal-winner-unobserved'), false, JSON.stringify(verdict.reasons));
});

test('a rejecting Root result preserves the completed pre-cutoff snapshot on the failure record', async (t) => {
  // Finding 1: an authoritative pre-cutoff read observing `succeeded` and a
  // Root result rejecting afterwards — the outer catch's bare heldTurn used
  // to drop `preCutoffDurableSnapshot` entirely, so independently established
  // winner/duty evidence disappeared from the persisted failure record (the
  // exit finally restores only passive samples, which cannot supply the
  // winner). The error path must preserve the completed snapshot carriers.
  let monotonic = 0;
  let wall = 500_000;
  let releaseWallMs = null;
  let rejectRootResult = null;
  let failure;
  try {
    await pipeline.runHeldHostTurn({
      launch: async () => ({ result: new Promise((_resolve, reject) => { rejectRootResult = reject; }) }),
      waitForGate: async () => {},
      waitForObservation: async () => {},
      captureProcessIdentity: async () => ({ pid: 66201, ppid: 108, nonce: 'a'.repeat(64), startIdentity: 'start-a' }),
      terminateProcessIdentity: async () => ({ attempted: true, signalled: 'SIGTERM', exited: true, failure: null }),
      readProcessIdentity: async () => undefined,
      waitForProcessExit: async () => {},
      sleep: async (ms) => {
        monotonic += ms;
        wall += ms;
        if (rejectRootResult !== null && releaseWallMs !== null && wall >= releaseWallMs + 1_000) {
          const reject = rejectRootResult;
          rejectRootResult = null;
          reject(new Error('the Root result rejected'));
        }
      },
      now: () => monotonic,
      wallClockNow: () => wall,
      holdMs: 420_000,
      budgetMs: 1_200_000,
      measurementCutoffSchedule: true,
      sampleDurableSnapshots: { intervalMs: 2_000 },
      readDurableSnapshot: async () => ({ aggregate: 'settled', executorLinkage: 'verified', reasons: [], passive: { snapshotEqual: true }, job: { presence: 'found', projection: { id: 'job-1', status: 'succeeded' } }, layers: { bindingCurrency: { state: 'current', anchorsJob: 'job-1' } } }),
      releaseGate: async () => { releaseWallMs = wall; },
    });
  } catch (error) {
    failure = error;
  }
  assert.ok(failure, 'premise: the rejecting Root result failed the turn');
  const heldTurn = /** @type {any} */ (failure).heldTurn;
  assert.ok(heldTurn, 'the failure carries the held-turn record');
  assert.ok(heldTurn.childSettlement?.preCutoffDurableSnapshot,
    'the completed pre-cutoff snapshot rides the FAILURE record');
  assert.equal(heldTurn.childSettlement.preCutoffDurableSnapshot.job.projection.status, 'succeeded');
  assert.equal(heldTurn.childSettlement.durableSamples !== undefined, true, 'the §23.5 samples still merge into the same block');
  // The persisted failure record keeps the winner evidence and the join
  // credits it — the evidence survives even though the turn failed.
  const facts = pipeline.mapShellWaitLiveFacts(
    { case: 'rescue-interrupt', pollMs: 3_600_000, waitPolicy: null, interruptBaselineSelector: null, survivalControlSelector: null },
    heldTurn, supportedEvidence(), null, null, mapperFixture, causalRollouts(), [], LAUNCHER,
  );
  const root = await mkdtemp(join(tmpdir(), 'shell-wait-native-interruption-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const persistFixture = { ...mapperFixture, dispose: async () => {} };
  await pipeline.runShellWaitCase(
    { case: 'rescue-interrupt', codexBinary: process.execPath, sourceSha: 'a'.repeat(40), workerDurationMs: 420_000, capMs: 3_600_000, pollMs: 3_600_000, budgetMs: 1_200_000, output: root },
    { createFixture: async () => persistFixture, executeLiveCase: async () => facts },
  );
  const recordName = (await readdir(root)).find((name) => name.endsWith('.record.json'));
  const reloaded = JSON.parse(await readFile(join(root, recordName), 'utf8'));
  assert.equal(reloaded.child.preCutoffDurableSnapshot.job.projection.status, 'succeeded',
    'the preserved snapshot persists on the failure record');
  const input = pipeline.nativeInterruptionGateDInput(reloaded);
  assert.equal(input.terminalWinner, 'succeeded',
    'the failure record\'s pre-cutoff snapshot still grounds the winner');
});

test('a cleanup-time capture establishes the identity: terminated true never coexists with established false', async (t) => {
  // Finding: the first eager capture reports an absent marker and Root exits
  // before the retry — `safeTerminateExactProcess` then captures and
  // terminates the verified process WITHOUT calling `noteIdentityEstablished`,
  // so the record carried `verifiedProcessTerminated: true` beside
  // `identityEstablished.established: false` and an absence basis.
  const captured = { pid: 66211, ppid: 109, nonce: 'a'.repeat(64), startIdentity: 'start-a' };
  let captureCalls = 0;
  let terminateCalls = 0;
  const held = await pipeline.runHeldHostTurn({
    launch: async () => ({ result: new Promise((resolve) => setTimeout(() => resolve({ code: 0, stdout: 'early root finish', stderr: '' }), 5)) }),
    // A never-gate: the Root result wins the boundary race — the early-exit
    // branch runs the registered cleanup while the eager worker is parked in
    // its absent-marker retry.
    waitForGate: async () => new Promise(() => {}),
    captureProcessIdentity: async () => {
      captureCalls += 1;
      if (captureCalls === 1) {
        // The first eager capture: the marker has not appeared yet.
        throw Object.assign(new Error('the process marker is absent'), { code: 'ZCODE_SHELL_WAIT_MARKER_ABSENT' });
      }
      // By the cleanup capture the marker exists and verifies.
      return { ...captured };
    },
    readProcessIdentity: async () => ({ ...captured }),
    terminateProcessIdentity: async () => {
      terminateCalls += 1;
      return { exited: true };
    },
    // The absent-marker retry parks in REAL time, so the cleanup capture is
    // deterministically the second call.
    sleep: async (ms) => { await new Promise((resolve) => setTimeout(resolve, ms)); },
    now: (() => { let value = 0; return () => (value += 1_000); })(),
    holdMs: 0,
    budgetMs: 60_000,
  });
  assert.equal(captureCalls >= 2, true, `premise: the cleanup captured the identity (got ${String(captureCalls)} captures)`);
  assert.equal(terminateCalls, 1, 'the verified process was terminated');
  assert.equal(held.cleanup.verifiedProcessTerminated, true);
  // THE finding assertions: the cleanup-time capture established the identity.
  assert.equal(held.cleanup.identityEstablished.established, true,
    `the cleanup-time capture must establish the identity (basis: ${String(held.cleanup.identityEstablished.basis)})`);
  assert.equal(held.cleanup.identityEstablished.basis, 'marker-nonce-start-ancestry-verified');
  assert.equal(held.cleanup.identityEstablished.capturedAtElapsedMs !== null, true);
  void captured;
  // No contradictory pair survives the persisted record.
  const facts = pipeline.mapShellWaitLiveFacts(
    { case: 'rescue-interrupt', pollMs: 3_600_000, waitPolicy: null, interruptBaselineSelector: null, survivalControlSelector: null },
    held, supportedEvidence(), null, null, mapperFixture, causalRollouts(), [], LAUNCHER,
  );
  const root = await mkdtemp(join(tmpdir(), 'shell-wait-native-interruption-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const persistFixture = { ...mapperFixture, dispose: async () => {} };
  await pipeline.runShellWaitCase(
    { case: 'rescue-interrupt', codexBinary: process.execPath, sourceSha: 'a'.repeat(40), workerDurationMs: 420_000, capMs: 3_600_000, pollMs: 3_600_000, budgetMs: 1_200_000, output: root },
    { createFixture: async () => persistFixture, executeLiveCase: async () => facts },
  );
  const recordName = (await readdir(root)).find((name) => name.endsWith('.record.json'));
  const reloaded = JSON.parse(await readFile(join(root, recordName), 'utf8'));
  assert.equal(reloaded.held.processIdentity.established, true, 'the persisted record keeps the establishment');
  assert.equal(reloaded.held.processTermination.verifiedTerminated, true);
  assert.equal(
    reloaded.held.processTermination.verifiedTerminated === true && reloaded.held.processIdentity.established !== true,
    false,
    'no contradictory terminated/established pair anywhere in the record',
  );
});

test('a confirmed process disappearance stops identity retries: the named process-exit failure, never budget exhaustion', async () => {
  // Finding 1: the marker existed and validated but the worker process had
  // already exited — captureVerifiedProcessIdentity reported that permanent
  // disappearance with the same ABSENT code as launch unreadiness, so the
  // eager retry loop spun until the experiment budget expired and the turn
  // reported budget exhaustion even though the gate had won and Root had
  // returned. The disappearance carries its own code; the retry loop stops
  // with the named process-exit basis and the gate-branch fallback surfaces
  // the named failure.
  let monotonic = 0;
  let captureCalls = 0;
  const startedAt = Date.now();
  let failure;
  try {
    await pipeline.runHeldHostTurn({
      launch: async () => ({ result: new Promise((resolve) => { const timer = setTimeout(() => resolve({ code: 0, stdout: 'late root', stderr: '' }), 30_000); timer.unref?.(); }) }),
      // The gate wins the boundary race — the gate-first branch awaits the
      // establishment.
      waitForGate: async () => {},
      captureProcessIdentity: async () => {
        captureCalls += 1;
        throw Object.assign(new Error('the exact fake-ZCode process exited before identity capture'), { code: 'ZCODE_SHELL_WAIT_PROCESS_EXITED' });
      },
      terminateProcessIdentity: async () => ({ attempted: true, signalled: 'SIGTERM', exited: true, failure: null }),
      sleep: async (ms) => { monotonic += ms; },
      now: () => monotonic,
      wallClockNow: () => 500_000 + monotonic,
      holdMs: 420_000,
      budgetMs: 60_000,
    });
  } catch (error) {
    failure = error;
  }
  assert.ok(failure, 'premise: the confirmed disappearance fails the turn');
  assert.match(String(failure.message), /exited before identity capture/u, 'the named process-exit failure propagates');
  const heldTurn = /** @type {any} */ (failure).heldTurn;
  assert.ok(heldTurn, 'the failure carries the held-turn record');
  assert.equal(heldTurn.budgetExpired, false, 'budgetExpired stays false — never budget exhaustion');
  assert.equal(heldTurn.cleanup.identityEstablished.basis, 'identity-unestablished-process-exited',
    `the named process-exit basis rides (got ${String(heldTurn.cleanup.identityEstablished.basis)})`);
  // Three capture sites, each stopping at the first confirmed disappearance:
  // the eager worker, the gate-branch fallback, and the cleanup capture.
  assert.ok(captureCalls <= 3, `the retries stopped promptly (got ${String(captureCalls)} captures)`);
  assert.ok(Date.now() - startedAt < 5_000, 'the turn ended promptly — never at the budget');
});

test('the read arm reserves a genuinely pre-cutoff final read: a +9500 ms finish keeps its winner', async (t) => {
  // Finding 2: the pull-in scheduled the next read exactly AT the cutoff,
  // where the fence check skipped it — the deterministic +0..+9000 schedule
  // left only the fenced +14000 ms refresh, so a job succeeding at +9500 ms
  // retained a running pre-cutoff snapshot and lost the winner. The pull-in
  // now reserves half the remaining stretch, so the final read starts
  // strictly before the cutoff.
  let monotonic = 0;
  let wall = 500_000;
  let finishAtMs = null;
  let releaseWallMs = null;
  let resolveRootResult = null;
  /** @type {number[]} */
  const readStarts = [];
  const RUNNING = { aggregate: 'unresolved', executorLinkage: 'verified', reasons: [], passive: { snapshotEqual: true }, job: { presence: 'found', projection: { id: 'job-1', status: null } }, layers: { bindingCurrency: { state: 'current', anchorsJob: 'job-1' } } };
  const SUCCEEDED = { aggregate: 'settled', executorLinkage: 'verified', reasons: [], passive: { snapshotEqual: true }, job: { presence: 'found', projection: { id: 'job-1', status: 'succeeded' } }, layers: { bindingCurrency: { state: 'current', anchorsJob: 'job-1' } } };
  const held = await pipeline.runHeldHostTurn({
    launch: async () => ({ result: new Promise((resolve) => { resolveRootResult = resolve; }) }),
    waitForGate: async () => {},
    waitForObservation: async () => {},
    captureProcessIdentity: async () => ({ pid: 66221, ppid: 110, nonce: 'a'.repeat(64), startIdentity: 'start-a' }),
    terminateProcessIdentity: async () => ({ attempted: true, signalled: 'SIGTERM', exited: true, failure: null }),
    readProcessIdentity: async () => undefined,
    waitForProcessExit: async () => {},
    sleep: async (ms) => {
      monotonic += ms;
      wall += ms;
      if (resolveRootResult !== null && releaseWallMs !== null && wall >= releaseWallMs + 1_000) {
        const resolve = resolveRootResult;
        resolveRootResult = null;
        resolve({ code: 0, stdout: 'sentinel', stderr: '' });
      }
    },
    now: () => monotonic,
    wallClockNow: () => wall,
    holdMs: 420_000,
    budgetMs: 1_200_000,
    measurementCutoffSchedule: true,
    readDurableSnapshot: async () => {
      if (releaseWallMs !== null) readStarts.push(wall - releaseWallMs);
      return finishAtMs !== null && wall >= finishAtMs ? SUCCEEDED : RUNNING;
    },
    releaseGate: async () => {
      // The job succeeds at release+9500 ms — inside the last floor-sized
      // stretch before the +10000 ms cutoff.
      finishAtMs = wall + 9_500;
      releaseWallMs = wall;
    },
  });
  assert.equal(held.budgetExpired, false);
  assert.ok(held.childSettlement?.preCutoffDurableSnapshot, 'a pre-cutoff authoritative snapshot survived');
  assert.equal(held.childSettlement.preCutoffDurableSnapshot.job.projection.status, 'succeeded',
    `the preserved snapshot observed the settlement (reads at ${JSON.stringify(readStarts)})`);
  assert.ok(held.childSettlement.preCutoffDurableSnapshot.completedAtMs < held.cleanup.measurementCutoffAtMs,
    'the preserved read completed strictly before the armed cutoff');
  assert.ok(readStarts.some((start) => start >= 9_000 && start < 10_000),
    `a read ran in the final pre-cutoff stretch after the finish (reads: ${JSON.stringify(readStarts)})`);
  const facts = pipeline.mapShellWaitLiveFacts(
    { case: 'rescue-interrupt', pollMs: 3_600_000, waitPolicy: null, interruptBaselineSelector: null, survivalControlSelector: null },
    held, supportedEvidence(), null, null, mapperFixture, causalRollouts(), [], LAUNCHER,
  );
  const root = await mkdtemp(join(tmpdir(), 'shell-wait-native-interruption-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const persistFixture = { ...mapperFixture, dispose: async () => {} };
  await pipeline.runShellWaitCase(
    { case: 'rescue-interrupt', codexBinary: process.execPath, sourceSha: 'a'.repeat(40), workerDurationMs: 420_000, capMs: 3_600_000, pollMs: 3_600_000, budgetMs: 1_200_000, output: root },
    { createFixture: async () => persistFixture, executeLiveCase: async () => facts },
  );
  const recordName = (await readdir(root)).find((name) => name.endsWith('.record.json'));
  const reloaded = JSON.parse(await readFile(join(root, recordName), 'utf8'));
  const input = pipeline.nativeInterruptionGateDInput(reloaded);
  assert.equal(input.terminalWinner, 'succeeded', 'the winner credits from the reserved pre-cutoff read');
  const verdict = evaluateNativeInterruptionSettlement(input);
  assert.equal(verdict.reasons.includes('terminal-winner-unobserved'), false, JSON.stringify(verdict.reasons));
});

test('a late final hold tick never extends the cutoff past the registered window (the 6-second oversleep repro)', async (t) => {
  // Finding 1: the cutoff was computed from the wall reading at the (late)
  // hold-deadline crossing, while the teardown endpoint stayed anchored to
  // the SCHEDULED deadline — a 6-second oversleep placed the cutoff one
  // second after planned teardown and credited reads beyond the registered
  // hold-deadline-plus-10000-ms window. Both endpoints anchor to the wall
  // reading at the last ON-TIME hold tick; the overrun rides as a named fact.
  let monotonic = 0;
  let wall = 500_000;
  let releaseWallMs = null;
  let resolveRootResult = null;
  let bonusApplied = false;
  let oversleepMs = 0;
  /** @type {number[]} */
  const readStamps = [];
  const held = await pipeline.runHeldHostTurn({
    launch: async () => ({ result: new Promise((resolve) => { resolveRootResult = resolve; }) }),
    waitForGate: async () => {},
    waitForObservation: async () => {},
    captureProcessIdentity: async () => ({ pid: 66231, ppid: 111, nonce: 'a'.repeat(64), startIdentity: 'start-a' }),
    terminateProcessIdentity: async () => ({ attempted: true, signalled: 'SIGTERM', exited: true, failure: null }),
    readProcessIdentity: async () => undefined,
    waitForProcessExit: async () => {},
    sleep: async (ms) => {
      let advance = ms;
      // The final hold tick's sleep OVERSLEEPS by 6 seconds (both clocks).
      if (!bonusApplied && monotonic + ms >= 420_000 && monotonic < 420_000) {
        bonusApplied = true;
        oversleepMs = 6_000;
        advance = ms + 6_000;
      }
      monotonic += advance;
      wall += advance;
      if (resolveRootResult !== null && releaseWallMs !== null && wall >= releaseWallMs + 1_000) {
        const resolve = resolveRootResult;
        resolveRootResult = null;
        resolve({ code: 0, stdout: 'sentinel', stderr: '' });
      }
    },
    now: () => monotonic,
    wallClockNow: () => wall,
    holdMs: 420_000,
    budgetMs: 1_200_000,
    measurementCutoffSchedule: true,
    readDurableSnapshot: async () => {
      if (releaseWallMs !== null) readStamps.push(wall - releaseWallMs);
      return { aggregate: 'unresolved', executorLinkage: 'verified', reasons: [], passive: { snapshotEqual: true }, job: { presence: 'found', projection: { id: 'job-1', status: null } } };
    },
    releaseGate: async () => { releaseWallMs = wall; },
  });
  assert.equal(bonusApplied, true, 'premise: the final hold tick overslept by 6 seconds');
  assert.equal(held.budgetExpired, false);
  // The scheduled deadline (mono 420000) corresponds to wall 926000 (the
  // oversleep advanced the wall too) — the ANCHORED cutoff is the wall
  // reading at the scheduled crossing (926000 − 6000 = 920000) + 10000,
  // within one hold tick's granularity — never the overslept 936000.
  const anchoredCutoffUpper = 500_000 + 420_000 + 10_000;
  assert.equal(held.cleanup.holdDeadlineOverrunMs, 6_000, 'the overrun rides as the named fact');
  assert.ok(held.cleanup.measurementCutoffAtMs > anchoredCutoffUpper - 1_000 && held.cleanup.measurementCutoffAtMs <= anchoredCutoffUpper,
    `the cutoff stays anchored at the scheduled deadline+10000 (got ${String(held.cleanup.measurementCutoffAtMs)}, expected ≤ ${String(anchoredCutoffUpper)})`);
  assert.ok(held.cleanup.measurementCutoffAtMs < anchoredCutoffUpper + oversleepMs,
    'the oversleep never extended the cutoff');
  // Every authoritative read stamp is fenced: none at/after the anchored cutoff.
  assert.ok(readStamps.every((stamp) => stamp < held.cleanup.measurementCutoffAtMs - 500_000),
    `no authoritative read at/after the anchored cutoff (stamps: ${JSON.stringify(readStamps)})`);
  const facts = pipeline.mapShellWaitLiveFacts(
    { case: 'rescue-interrupt', pollMs: 3_600_000, waitPolicy: null, interruptBaselineSelector: null, survivalControlSelector: null },
    held, supportedEvidence(), null, null, mapperFixture, causalRollouts(), [], LAUNCHER,
  );
  assert.equal(facts.interrupt.holdDeadlineOverrunMs, 6_000, 'the overrun rides the interrupt facts');
  const root = await mkdtemp(join(tmpdir(), 'shell-wait-native-interruption-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const persistFixture = { ...mapperFixture, dispose: async () => {} };
  await pipeline.runShellWaitCase(
    { case: 'rescue-interrupt', codexBinary: process.execPath, sourceSha: 'a'.repeat(40), workerDurationMs: 420_000, capMs: 3_600_000, pollMs: 3_600_000, budgetMs: 1_200_000, output: root },
    { createFixture: async () => persistFixture, executeLiveCase: async () => facts },
  );
  const recordName = (await readdir(root)).find((name) => name.endsWith('.record.json'));
  const reloaded = JSON.parse(await readFile(join(root, recordName), 'utf8'));
  assert.equal(reloaded.interrupt.holdDeadlineOverrunMs, 6_000, 'the overrun fact persists on the record');
  assert.equal(reloaded.interrupt.measurementCutoffAtMs, held.cleanup.measurementCutoffAtMs, 'the anchored cutoff persists');
});

test('a post-cutoff completion never grounds the Companion layer (retained as an observation)', async (t) => {
  // Finding 2: a qualified exit-code completion arriving after the cutoff
  // correctly withheld turn settlement, but the remote-terminal derivation
  // still rode that completion and the join prioritized it over the
  // pre-cutoff evidence, reporting companionOutcome terminal-result. The
  // Companion-layer derivation must gate on the cutoff too: the late
  // completion rides as an observation, never qualification credit.
  const completionAtMs = MEASUREMENT_CUTOFF_AT_MS + 1_000;
  const rollouts = causalRollouts({ childTerminalBeforeCall: true, withNativeResolution: false, completedAtMs: completionAtMs });
  const completionOutput = rollouts[1].find((event) => /** @type {any} */ (event)?.payload?.call_id === 'outer-1'
    && /** @type {any} */ (event)?.payload?.type === 'function_call_output');
  if (completionOutput) completionOutput.timestamp = new Date(completionAtMs).toISOString();
  const evidence = supportedEvidence();
  evidence.facts.completion.qualified = true;
  const held = {
    ...heldObservationWithSchedule(),
    childSettlement: {
      observed: false, basis: null,
      layers: { remoteTerminal: null, localProcessReaping: null, durableObligations: 'unresolved' },
      // The reviewer's shape: an UNRESOLVED pre-cutoff snapshot.
      preCutoffDurableSnapshot: {
        aggregate: 'unresolved', executorLinkage: 'verified', reasons: [], completedAtMs: MEASUREMENT_CUTOFF_AT_MS - 500,
        passive: { snapshotEqual: true },
        job: { presence: 'found', projection: { id: 'job-1', status: null } },
      },
      durableSamples: { version: 1, summaries: [] },
    },
  };
  const facts = mapScheduled(rollouts, evidence, held);
  assert.equal(facts.interrupt.completedAfterCallMs, completionAtMs, 'the late completion rides as an observation');
  assert.equal(facts.interrupt.settled, null, 'turn settlement is already withheld past the cutoff');
  assert.equal(facts.child.settlementLayers.remoteTerminal, true,
    'the mapper-level remote-terminal observation is retained on the record');
  const root = await mkdtemp(join(tmpdir(), 'shell-wait-native-interruption-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const persistFixture = { ...mapperFixture, dispose: async () => {} };
  await pipeline.runShellWaitCase(
    { case: 'rescue-interrupt', codexBinary: process.execPath, sourceSha: 'a'.repeat(40), workerDurationMs: 420_000, capMs: 3_600_000, pollMs: 3_600_000, budgetMs: 1_200_000, output: root },
    { createFixture: async () => persistFixture, executeLiveCase: async () => facts },
  );
  const recordName = (await readdir(root)).find((name) => name.endsWith('.record.json'));
  const reloaded = JSON.parse(await readFile(join(root, recordName), 'utf8'));
  assert.equal(reloaded.child.settlementLayers.remoteTerminal, true, 'the observation persists');
  const input = pipeline.nativeInterruptionGateDInput(reloaded);
  assert.equal(input.companionOutcome, 'survived-unsettled',
    `the unresolved pre-cutoff evidence decides — never the post-cutoff completion (got ${String(input.companionOutcome)})`);
  const verdict = evaluateNativeInterruptionSettlement(input);
  assert.equal(verdict.reasons.includes('companion-still-live-unsettled'), true, JSON.stringify(verdict.reasons));
});

test('a late eager-capture rejection never overwrites the successful establishment', async () => {
  // Finding 3: the eager capture was still PENDING when cleanup
  // independently captured and terminated the verified process (the
  // establishment metadata noted the success); the eager capture then
  // rejected with the process-exited code (the process is gone by now) and
  // the generic failure branch OVERWROTE the successful basis — the record
  // carried established/terminated true beside the failure basis. Both
  // failure branches must recheck before writing failure metadata.
  const captured = { pid: 66241, ppid: 112, nonce: 'a'.repeat(64), startIdentity: 'start-a' };
  let captureCalls = 0;
  let terminateCalls = 0;
  let rejectEagerCapture = null;
  const held = await pipeline.runHeldHostTurn({
    launch: async () => ({ result: new Promise((resolve) => setTimeout(() => resolve({ code: 0, stdout: 'early root finish', stderr: '' }), 5)) }),
    waitForGate: async () => new Promise(() => {}),
    captureProcessIdentity: async () => {
      captureCalls += 1;
      if (captureCalls === 1) {
        // The eager capture PENDING while cleanup captures.
        return new Promise((_resolve, reject) => { rejectEagerCapture = reject; });
      }
      return { ...captured };
    },
    readProcessIdentity: async () => ({ ...captured }),
    terminateProcessIdentity: async () => {
      terminateCalls += 1;
      return { exited: true };
    },
    sleep: async () => {},
    now: (() => { let value = 0; return () => (value += 1_000); })(),
    holdMs: 0,
    budgetMs: 60_000,
  });
  assert.equal(captureCalls, 2, 'premise: cleanup captured while the eager capture was pending');
  assert.equal(held.cleanup.verifiedProcessTerminated, true, 'premise: the verified process was terminated');
  assert.equal(held.cleanup.identityEstablished.established, true, 'premise: the cleanup capture established the identity');
  assert.equal(held.cleanup.identityEstablished.basis, 'marker-nonce-start-ancestry-verified');
  // The eager capture then rejects with the process-exited code.
  rejectEagerCapture(Object.assign(new Error('the exact fake-ZCode process exited before identity capture'), { code: 'ZCODE_SHELL_WAIT_PROCESS_EXITED' }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  // THE finding assertions: the successful establishment stands.
  assert.equal(held.cleanup.identityEstablished.established, true);
  assert.equal(held.cleanup.identityEstablished.basis, 'marker-nonce-start-ancestry-verified',
    `the late rejection never overwrites the successful basis (got ${String(held.cleanup.identityEstablished.basis)})`);
  assert.equal(held.cleanup.verifiedProcessTerminated, true);
  assert.equal(terminateCalls, 1, 'exactly one verified termination (the registered cleanup)');
});

test('the cutoff anchors exactly at deadline+10000 under synchronized clocks: final-interval settlements credit', async () => {
  // Finding 1's repro: synchronized clocks with a 1000-ms hold — the
  // unprojected anchor read the wall up to one tick BEFORE the deadline and
  // closed measurement at deadline+9900, refusing settlements in the missing
  // final interval. The projected anchor lands exactly at deadline+10000.
  // The wall base shares the causal rollouts' epoch, so the re-stamped
  // settlement marker keeps a consistent 2026 ordering in the rollouts.
  const wallBase = Date.parse('2026-10-06T00:16:40.000Z');
  let monotonic = 0;
  let wall = wallBase;
  let releaseWallMs = null;
  let resolveRootResult = null;
  const held = await pipeline.runHeldHostTurn({
    launch: async () => ({ result: new Promise((resolve) => { resolveRootResult = resolve; }) }),
    waitForGate: async () => {},
    waitForObservation: async () => {},
    captureProcessIdentity: async () => ({ pid: 66251, ppid: 113, nonce: 'a'.repeat(64), startIdentity: 'start-a' }),
    terminateProcessIdentity: async () => ({ attempted: true, signalled: 'SIGTERM', exited: true, failure: null }),
    readProcessIdentity: async () => undefined,
    waitForProcessExit: async () => {},
    // SYNCHRONIZED clocks: both advance by exactly the sleep amount.
    sleep: async (ms) => {
      monotonic += ms;
      wall += ms;
      if (resolveRootResult !== null && releaseWallMs !== null && wall >= releaseWallMs + 200) {
        const resolve = resolveRootResult;
        resolveRootResult = null;
        resolve({ code: 0, stdout: 'sentinel', stderr: '' });
      }
    },
    now: () => monotonic,
    wallClockNow: () => wall,
    holdMs: 1_000,
    budgetMs: 60_000,
    measurementCutoffSchedule: true,
    readDurableSnapshot: async () => ({ aggregate: 'unresolved', executorLinkage: 'verified', reasons: [], passive: { snapshotEqual: true }, job: { presence: 'found', projection: { status: null } } }),
  });
  const deadlineWall = wallBase + 1_000;
  assert.equal(held.cleanup.holdDeadlineOverrunMs ?? 0, 0, 'synchronized clocks: no overrun');
  assert.equal(held.cleanup.measurementCutoffAtMs, deadlineWall + 10_000,
    `the cutoff is exactly deadline+10000 (got ${String(held.cleanup.measurementCutoffAtMs)}, expected ${String(deadlineWall + 10_000)})`);
  // A settlement in the missing final interval (deadline−50) credits.
  const markerAtMs = deadlineWall - 50;
  const rollouts = causalRollouts({ completedAtMs: markerAtMs });
  const nativeOutput = rollouts[1].find((event) => /** @type {any} */ (event)?.payload?.call_id === 'outer-native'
    && /** @type {any} */ (event)?.payload?.type === 'function_call_output');
  if (nativeOutput) nativeOutput.timestamp = new Date(markerAtMs).toISOString();
  const rootItem = rollouts[0].find((event) => /** @type {any} */ (event)?.payload?.item?.type === 'SubAgentActivity');
  if (rootItem) rootItem.timestamp = new Date(markerAtMs).toISOString();
  const facts = pipeline.mapShellWaitLiveFacts(
    { case: 'rescue-interrupt', pollMs: 3_600_000, waitPolicy: null, interruptBaselineSelector: null, survivalControlSelector: null },
    held, supportedEvidence(), null, null, mapperFixture, rollouts, [], LAUNCHER,
  );
  assert.equal(facts.interrupt.settled, true, 'a settlement in the final interval credits');
  assert.equal(facts.interrupt.settledBasis, 'native-cancellation-settlement-after-delivery');
});

test('the read arm keeps the registered read cadence except for the one reserved pull-in', async () => {
  // Finding 2's repro: settlement unobserved near the cutoff — repeated
  // halving compressed every subsequent read (spacings down to ~1 ms),
  // invoking the full reader at sub-floor cadences. The pull-in applies at
  // most once; every other read keeps the registered ≥1000-ms floor. The
  // injected sleep advances the clocks by AT MOST 25 ms per call so the
  // compression zone has room for the cascade to manifest deterministically.
  let monotonic = 0;
  let wall = 500_000;
  let releaseWallMs = null;
  let resolveRootResult = null;
  /** @type {number[]} */
  const readStarts = [];
  const held = await pipeline.runHeldHostTurn({
    launch: async () => ({ result: new Promise((resolve) => { resolveRootResult = resolve; }) }),
    waitForGate: async () => {},
    waitForObservation: async () => {},
    captureProcessIdentity: async () => ({ pid: 66261, ppid: 114, nonce: 'a'.repeat(64), startIdentity: 'start-a' }),
    terminateProcessIdentity: async () => ({ attempted: true, signalled: 'SIGTERM', exited: true, failure: null }),
    readProcessIdentity: async () => undefined,
    waitForProcessExit: async () => {},
    sleep: async (ms) => {
      const advance = Math.min(ms, 25);
      monotonic += advance;
      wall += advance;
      if (resolveRootResult !== null && releaseWallMs !== null && wall >= releaseWallMs + 1_000) {
        const resolve = resolveRootResult;
        resolveRootResult = null;
        resolve({ code: 0, stdout: 'sentinel', stderr: '' });
      }
    },
    now: () => monotonic,
    wallClockNow: () => wall,
    holdMs: 420_000,
    budgetMs: 1_200_000,
    measurementCutoffSchedule: true,
    readDurableSnapshot: async () => {
      if (releaseWallMs !== null) readStarts.push(wall - releaseWallMs);
      // Settlement remains UNOBSERVED near the cutoff — the reviewer's shape.
      return { aggregate: 'unresolved', executorLinkage: 'verified', reasons: [], passive: { snapshotEqual: true }, job: { presence: 'found', projection: { status: null } } };
    },
    releaseGate: async () => { releaseWallMs = wall; },
  });
  assert.equal(held.budgetExpired, false);
  assert.ok(readStarts.length >= 3, `the arm read through the window (got ${String(readStarts.length)} reads)`);
  /** @type {number[]} */
  const spacings = [];
  for (let index = 1; index < readStarts.length; index += 1) spacings.push(readStarts[index] - readStarts[index - 1]);
  const subFloorCount = spacings.filter((spacing) => spacing < 1_000).length;
  assert.ok(subFloorCount <= 1, `at most ONE reserved pull-in: no repeated halving (spacings: ${JSON.stringify(spacings)})`);
  for (let index = 1; index < spacings.length; index += 1) {
    assert.ok(!(spacings[index - 1] < 1_000 && spacings[index] < 1_000),
      `no consecutive sub-floor spacings (got ${JSON.stringify(spacings)})`);
  }
  assert.ok(readStarts[readStarts.length - 1] < CUTOFF_WALL_MS,
    'the final read started strictly before the cutoff');
  assert.equal(held.childSettlement?.preCutoffDurableSnapshot?.aggregate, 'unresolved',
    'the honest unobserved-settlement snapshot still rides');
});

test('the cutoff anchors exactly at deadline+10000 with synchronized clocks and a 1000-ms hold', async () => {
  // Round-10 finding 1's repro: synchronized clocks, a 1000-ms hold — the
  // anchor must land EXACTLY at deadline+10000 (never one tick early).
  const wallBase = 1_000_000;
  let monotonic = 0;
  let wall = wallBase;
  let releaseWallMs = null;
  let resolveRootResult = null;
  const held = await pipeline.runHeldHostTurn({
    launch: async () => ({ result: new Promise((resolve) => { resolveRootResult = resolve; }) }),
    waitForGate: async () => {},
    waitForObservation: async () => {},
    captureProcessIdentity: async () => ({ pid: 66271, ppid: 115, nonce: 'a'.repeat(64), startIdentity: 'start-a' }),
    terminateProcessIdentity: async () => ({ attempted: true, signalled: 'SIGTERM', exited: true, failure: null }),
    readProcessIdentity: async () => undefined,
    waitForProcessExit: async () => {},
    sleep: async (ms) => {
      monotonic += ms;
      wall += ms;
      if (resolveRootResult !== null && releaseWallMs !== null && wall >= releaseWallMs + 200) {
        const resolve = resolveRootResult;
        resolveRootResult = null;
        resolve({ code: 0, stdout: 'sentinel', stderr: '' });
      }
    },
    now: () => monotonic,
    wallClockNow: () => wall,
    holdMs: 1_000,
    budgetMs: 60_000,
    measurementCutoffSchedule: true,
  });
  const deadlineWall = wallBase + 1_000;
  assert.equal(held.cleanup.holdDeadlineOverrunMs ?? 0, 0, 'synchronized clocks: no overrun');
  assert.equal(held.cleanup.measurementCutoffAtMs, deadlineWall + 10_000,
    `the cutoff is exactly deadline+10000 (got ${String(held.cleanup.measurementCutoffAtMs)}, expected ${String(deadlineWall + 10_000)})`);
});

test('an unstamped qualified terminal response never credits settlement or the Companion layer (the observation retained)', async (t) => {
  // Finding 1's repro: in a scheduled run a qualified terminal response can
  // lack a timestamp while an earlier timestamped nonterminal resolution
  // establishes the pending window — the cutoff fence skipped the missing
  // instant and fell through to settled: true, and the Companion layer
  // credited terminal-result. Completion credit requires a FINITE completion
  // instant strictly before the armed cutoff; the unstamped response rides
  // as an uncredited observation through the real extractor (the unstamped
  // response yields no completion instant) and the real mapper/join.
  // The exit-code completion lands AFTER the interrupt call (the timestamped
  // wait at 08, the response UNSTAMPED): the completion instant is MISSING.
  const rollouts = causalRollouts({ childTerminalBeforeCall: false, withNativeResolution: false, completedAtMs: RESOLUTION_MS });
  rollouts[1].push(
    fnCall('wait', 'outer-1', { cell_id: 'cell-1' }, '2026-10-06T00:00:08.000Z'),
    fnOutput('outer-1', completedOutputBody({ output: 'done', exit_code: 0 })),
  );
  const interaction = extractInterruptInteraction(rollouts, [], { childThreadId: CHILD_THREAD, command: LAUNCHER });
  assert.equal(interaction.completedAfterCall.atMs, null, 'the unstamped terminal response carries no completion instant');
  assert.equal(interaction.attempted, true, 'the interrupt is recognized');
  const evidence = supportedEvidence();
  evidence.facts.completion.qualified = true;
  const held = {
    ...heldObservationWithSchedule(),
    childSettlement: {
      observed: false, basis: null,
      layers: { remoteTerminal: null, localProcessReaping: null, durableObligations: 'unresolved' },
      preCutoffDurableSnapshot: {
        aggregate: 'unresolved', executorLinkage: 'verified', reasons: [], completedAtMs: MEASUREMENT_CUTOFF_AT_MS - 500,
        passive: { snapshotEqual: true },
        job: { presence: 'found', projection: { id: 'job-1', status: null } },
      },
      durableSamples: { version: 1, summaries: [] },
    },
  };
  const facts = mapScheduled(rollouts, evidence, held);
  // THE finding assertions: the unstamped completion is retained as an
  // observation and credited with neither settlement nor latency.
  // The attribution chain: the pending window's resolution is the UNSTAMPED
  // terminal response — its arrival relative to the interrupt is unknown, so
  // the post-completion guard refuses the attribution before the cutoff
  // fence is reached; either way the unstamped completion is an UNCREDITED
  // observation.
  assert.equal(facts.interrupt.settled, null,
    'an unstamped qualified completion must not settle the interrupted turn');
  assert.equal(facts.interrupt.settledBasis, 'post-completion-delivery-not-attributed');
  assert.equal(facts.interrupt.deliveryToSettlementMs, null, 'no responsiveness latency without a completion instant');
  assert.equal(facts.child.settlementLayers.remoteTerminal, true, 'the mapper-level observation is retained');
  const root = await mkdtemp(join(tmpdir(), 'shell-wait-native-interruption-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const persistFixture = { ...mapperFixture, dispose: async () => {} };
  await pipeline.runShellWaitCase(
    { case: 'rescue-interrupt', codexBinary: process.execPath, sourceSha: 'a'.repeat(40), workerDurationMs: 420_000, capMs: 3_600_000, pollMs: 3_600_000, budgetMs: 1_200_000, output: root },
    { createFixture: async () => persistFixture, executeLiveCase: async () => facts },
  );
  const recordName = (await readdir(root)).find((name) => name.endsWith('.record.json'));
  const reloaded = JSON.parse(await readFile(join(root, recordName), 'utf8'));
  assert.equal(reloaded.child.settlementLayers.remoteTerminal, true, 'the mapper-level observation persists');
  const input = pipeline.nativeInterruptionGateDInput(reloaded);
  assert.equal(input.companionOutcome, 'survived-unsettled',
    `the Companion layer must not credit the unstamped completion (got ${String(input.companionOutcome)})`);
  const verdict = evaluateNativeInterruptionSettlement(input);
  assert.equal(verdict.reasons.includes('companion-still-live-unsettled'), true, JSON.stringify(verdict.reasons));
  assert.equal(verdict.reasons.includes('turn-settlement-unobserved'), true, JSON.stringify(verdict.reasons));
});

test('a bounds-only interrupt with an unstamped completion refuses attribution as the named cutoff observation', () => {
  // The missing-instant arm of the round-10 fence: the pending window IS
  // confirmed (the bounded wrapped interrupt's execution bounds), the
  // completion is QUALIFIED, and the completion instant is MISSING — the
  // cutoff fence names the uncredited observation instead of crediting
  // settlement.
  // A timestamped nonterminal resolution (the poll-2 still-running yield)
  // lands AFTER the interrupt call, establishing the pending window; the
  // terminal exit-code completion lands after the call with its response
  // UNSTAMPED — the completion instant is MISSING.
  const rollouts = causalRollouts({ childTerminalBeforeCall: false, withNativeResolution: false, completedAtMs: RESOLUTION_MS });
  rollouts[1].push(
    fnCall('write_stdin', 'poll-2', { session_id: 5, chars: '', yield_time_ms: 60_000 }, '2026-10-06T00:00:08.000Z'),
    fnOutput('poll-2', pendingOutputBody('cell-2'), '2026-10-06T00:00:08.500Z'),
    fnCall('wait', 'outer-1', { cell_id: 'cell-1' }, '2026-10-06T00:00:09.000Z'),
    fnOutput('outer-1', completedOutputBody({ output: 'done', exit_code: 0 })),
  );
  const evidence = supportedEvidence();
  evidence.facts.completion.qualified = true;
  const held = heldObservationWithSchedule();
  const facts = mapScheduled(rollouts, evidence, held);
  assert.equal(facts.interrupt.settled, null,
    'an unstamped qualified completion must not settle the interrupted turn');
  assert.equal(facts.interrupt.settledBasis, 'measurement-cutoff-settlement-not-attributed');
  assert.equal(facts.interrupt.deliveryToSettlementMs, null);
});

test('a scheduled run writes no diagnostics to stdout: the JSON record stream stays parseable', async (t) => {
  // Finding 3: the round-9 forensics left unconditional `console.log`
  // diagnostics in the read arm's loop breaks — a successful scheduled run
  // wrote `R9DEBUG ...` prefix lines to stdout before the CLI's JSON record,
  // breaking stdout consumers. The scheduled pipeline must write NOTHING to
  // stdout (the CLI's own JSON record write excluded — it is asserted
  // separately by the CLI tests).
  const logged = [];
  const originalLog = console.log;
  console.log = (...args) => { logged.push(args.map((a) => String(a)).join(' ')); };
  try {
    let monotonic = 0;
    let wall = 500_000;
    let releaseWallMs = null;
    let resolveRootResult = null;
    const held = await pipeline.runHeldHostTurn({
      launch: async () => ({ result: new Promise((resolve) => { resolveRootResult = resolve; }) }),
      waitForGate: async () => {},
      waitForObservation: async () => {},
      captureProcessIdentity: async () => ({ pid: 66271, ppid: 115, nonce: 'a'.repeat(64), startIdentity: 'start-a' }),
      terminateProcessIdentity: async () => ({ attempted: true, signalled: 'SIGTERM', exited: true, failure: null }),
      readProcessIdentity: async () => undefined,
      waitForProcessExit: async () => {},
      sleep: async (ms) => {
        monotonic += ms;
        wall += ms;
        if (resolveRootResult !== null && releaseWallMs !== null && wall >= releaseWallMs + 1_000) {
          const resolve = resolveRootResult;
          resolveRootResult = null;
          resolve({ code: 0, stdout: 'sentinel', stderr: '' });
        }
      },
      now: () => monotonic,
      wallClockNow: () => wall,
      holdMs: 420_000,
      budgetMs: 1_200_000,
      measurementCutoffSchedule: true,
      sampleDurableSnapshots: { intervalMs: 2_000 },
      readDurableSnapshot: async () => ({ aggregate: 'unresolved', executorLinkage: 'verified', reasons: [], passive: { snapshotEqual: true }, job: { presence: 'found', projection: { status: null } } }),
      releaseGate: async () => { releaseWallMs = wall; },
    });
    assert.equal(held.endedBeforeGate, false);
    assert.equal(held.budgetExpired, false);
    const facts = pipeline.mapShellWaitLiveFacts(
      { case: 'rescue-interrupt', pollMs: 3_600_000, waitPolicy: null, interruptBaselineSelector: null, survivalControlSelector: null },
      held, supportedEvidence(), null, null, mapperFixture, causalRollouts(), [], LAUNCHER,
    );
    const root = await mkdtemp(join(tmpdir(), 'shell-wait-native-interruption-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const persistFixture = { ...mapperFixture, dispose: async () => {} };
    await pipeline.runShellWaitCase(
      { case: 'rescue-interrupt', codexBinary: process.execPath, sourceSha: 'a'.repeat(40), workerDurationMs: 420_000, capMs: 3_600_000, pollMs: 3_600_000, budgetMs: 1_200_000, output: root },
      { createFixture: async () => persistFixture, executeLiveCase: async () => facts },
    );
    const recordName = (await readdir(root)).find((name) => name.endsWith('.record.json'));
    const reloaded = JSON.parse(await readFile(join(root, recordName), 'utf8'));
    assert.equal(reloaded.interrupt.measurementCutoffAtMs !== null, true, 'premise: the scheduled run armed the cutoff');
  } finally {
    console.log = originalLog;
  }
  assert.deepEqual(logged, [],
    `the scheduled pipeline must write no diagnostics to stdout (got ${JSON.stringify(logged)})`);
});

test('the sampler and the read arm share one paced read stream: every start ≥1000 ms apart', async () => {
  // Finding 2's shared-clock repro: the §23.5 passive sampler and the
  // authoritative pre-cutoff read arm both read the same supplier, each on
  // its own interval — together they repeatedly started reads at the same
  // instant (1000, 1000, 2000, 2000). One shared ledger paces both through a
  // single claim stream: the ledger's start stamps are strictly increasing
  // with ≥1000 ms between consecutive starts, GLOBALLY across both
  // consumers, and the ledger rides the turn result so the record carries
  // the combined §24.8 accounting.
  let monotonic = 0;
  let wall = 500_000;
  let releaseWallMs = null;
  let resolveRootResult = null;
  const held = await pipeline.runHeldHostTurn({
    launch: async () => ({ result: new Promise((resolve) => { resolveRootResult = resolve; }) }),
    waitForGate: async () => {},
    waitForObservation: async () => {},
    captureProcessIdentity: async () => ({ pid: 66281, ppid: 116, nonce: 'a'.repeat(64), startIdentity: 'start-a' }),
    terminateProcessIdentity: async () => ({ attempted: true, signalled: 'SIGTERM', exited: true, failure: null }),
    readProcessIdentity: async () => undefined,
    waitForProcessExit: async () => {},
    // The SHARED clock: both consumers pace off the same advancing clocks.
    sleep: async (ms) => {
      monotonic += ms;
      wall += ms;
      if (resolveRootResult !== null && releaseWallMs !== null && wall >= releaseWallMs + 1_000) {
        const resolve = resolveRootResult;
        resolveRootResult = null;
        resolve({ code: 0, stdout: 'sentinel', stderr: '' });
      }
    },
    now: () => monotonic,
    wallClockNow: () => wall,
    holdMs: 420_000,
    budgetMs: 1_200_000,
    measurementCutoffSchedule: true,
    sampleDurableSnapshots: { intervalMs: 2_000 },
    readDurableSnapshot: async () => (
      { aggregate: 'unresolved', executorLinkage: 'verified', reasons: [], passive: { snapshotEqual: true }, job: { presence: 'found', projection: { status: null } } }
    ),
    releaseGate: async () => { releaseWallMs = wall; },
  });
  assert.equal(held.budgetExpired, false);
  // The ONE ledger: every read start of BOTH consumers, in claim order.
  const ledger = /** @type {any} */ (held.childSettlement)?.durableReadLedger;
  assert.ok(ledger && typeof ledger === 'object', 'premise: the combined durable read ledger rides the turn result');
  const starts = /** @type {number[]} */ (ledger.starts);
  assert.ok(Array.isArray(starts) && starts.length >= 4,
    `premise: both consumers claimed through the one ledger (got ${String(starts?.length)} starts)`);
  assert.equal(ledger.attempts, starts.length + (ledger.unpacedAttempts ?? 0),
    'every ledger attempt is one claimed start (paced) or a named unpaced account-only claim');
  const summaryStarts = (held.childSettlement?.durableSamples?.summaries ?? []).map((summary) => summary.startedAtMs);
  assert.ok(summaryStarts.every((startedAtMs) => starts.includes(startedAtMs)),
    'every §23.5 summary start went through the shared stream');
  assert.ok(starts.some((startedAtMs) => releaseWallMs !== null && startedAtMs >= releaseWallMs && !summaryStarts.includes(startedAtMs)),
    'premise: the authoritative arm claimed post-release starts of its own');
  for (let index = 1; index < starts.length; index += 1) {
    assert.ok(starts[index] > starts[index - 1],
      `no two read starts may share an instant (gap ${String(starts[index] - starts[index - 1])} between ${String(starts[index - 1])} and ${String(starts[index])}; all: ${JSON.stringify(starts)})`);
  }
  // Every floor-paced gap is ≥1000 ms. §24.8's ONE registered exception —
  // the arm's reserved final pull-in read (round-9 finding 2) — may compress
  // a single gap, never to zero and never more than once.
  const shortGaps = [];
  for (let index = 1; index < starts.length; index += 1) {
    if (starts[index] - starts[index - 1] < 1_000) shortGaps.push([starts[index - 1], starts[index]]);
  }
  assert.ok(shortGaps.length <= 1,
    `read starts must honor the global ≥1000-ms cadence (reserved-pull-in compression allowed at most once; got ${JSON.stringify(shortGaps)}; all: ${JSON.stringify(starts)})`);
});

test('under NORMAL timers the competing arms keep the global cadence: no sub-floor gap outside the reserved pull-in, never two starts in one millisecond', async () => {
  // Codex gate round-11 finding 1's repro: with the default (real) scheduler
  // the arm's pacing chunk is 100 ms and the round-10 `reWaited` flag granted
  // the claim after that FIRST chunk even though the ledger floor was still
  // positive — repeated 100-113 ms gaps (even two starts in the same
  // millisecond) while the sampler competed for the same stream. The claim
  // now keeps re-reading the ledger after every chunk and grants only when
  // the floor is actually satisfied; an early-resolving scheduler (clock
  // progress below the request) is bounded to the registered named-shortfall
  // two-wait shape.
  const mono0 = Date.now();
  let releaseWallMs = null;
  /** @type {number[]} */
  const supplierCallStamps = [];
  const RUNNING = { aggregate: 'unresolved', executorLinkage: 'verified', reasons: [], passive: { snapshotEqual: true }, job: { presence: 'found', projection: { status: null } } };
  const held = await pipeline.runHeldHostTurn({
    // NO injected sleep: the driver's default REAL setTimeout drives every
    // wait — the exact scheduler family the finding's production run used.
    launch: async () => ({ result: new Promise((resolve) => { setTimeout(() => resolve({ code: 0, stdout: 'sentinel', stderr: '' }), 2_500); }) }),
    waitForGate: async () => {},
    waitForObservation: async () => {},
    captureProcessIdentity: async () => ({ pid: 66301, ppid: 120, nonce: 'a'.repeat(64), startIdentity: 'start-a' }),
    terminateProcessIdentity: async () => ({ attempted: true, signalled: 'SIGTERM', exited: true, failure: null }),
    readProcessIdentity: async () => undefined,
    waitForProcessExit: async () => {},
    now: () => Date.now() - mono0,
    wallClockNow: () => 500_000 + (Date.now() - mono0),
    holdMs: 100,
    budgetMs: 60_000,
    measurementCutoffSchedule: true,
    sampleDurableSnapshots: { intervalMs: 2_000 },
    readDurableSnapshot: async () => {
      const stamp = 500_000 + (Date.now() - mono0);
      if (releaseWallMs !== null) supplierCallStamps.push(stamp - releaseWallMs);
      return RUNNING;
    },
    releaseGate: async () => { releaseWallMs = 500_000 + (Date.now() - mono0); },
  });
  assert.equal(held.budgetExpired, false);
  const ledger = /** @type {any} */ (held.childSettlement)?.durableReadLedger;
  assert.ok(ledger && typeof ledger === 'object', 'the shared read ledger rides the turn result');
  const starts = /** @type {number[]} */ (ledger.starts);
  assert.ok(Array.isArray(starts) && starts.length >= 3,
    `premise: both consumers competed on the stream (got ${String(starts?.length)} starts)`);
  for (let index = 1; index < starts.length; index += 1) {
    assert.ok(starts[index] > starts[index - 1],
      `no two read starts may share a millisecond (gap ${String(starts[index] - starts[index - 1])} between ${String(starts[index - 1])} and ${String(starts[index])}; all: ${JSON.stringify(starts)})`);
  }
  const shortGaps = [];
  for (let index = 1; index < starts.length; index += 1) {
    if (starts[index] - starts[index - 1] < 1_000) shortGaps.push(starts[index] - starts[index - 1]);
  }
  assert.ok(shortGaps.length <= 1,
    `zero sub-floor gaps outside the one reserved pull-in under normal timers (got ${JSON.stringify(shortGaps)}; all: ${JSON.stringify(starts)})`);
  assert.ok(starts.length >= 3 && supplierCallStamps.length >= 2,
    `premise: both consumers read post-release (starts ${JSON.stringify(starts)}, calls ${JSON.stringify(supplierCallStamps)})`);
});

test('the combined ≤600 ceiling is enforced at the shared claim for EVERY consumer: the sampler-capped turn starts no extra read, and cap refusals are named', async () => {
  // Codex gate round-11 finding 2's timed-scheduler repro: the sampler
  // consumes the whole registered 600-attempt ceiling before gate release
  // (startup/observation detection took that long), and the shared claim
  // still started ANOTHER read for the arm while the window-end refresh
  // bypassed accounting entirely — 602 supplier calls against a 600-attempt
  // budget. The ceiling is now enforced atomically INSIDE the shared claim
  // for every consumer (arm, settlement-watch reads, window-end refresh),
  // and every read refused at the cap rides as a named ledger fact.
  let monotonic = 0;
  let wall = 500_000;
  let supplierCalls = 0;
  let releaseGateNow = () => {};
  const gateReleased = new Promise((resolve) => { releaseGateNow = () => resolve(); });
  const RUNNING = { aggregate: 'unresolved', executorLinkage: 'verified', reasons: [], passive: { snapshotEqual: true }, job: { presence: 'found', projection: { status: null } } };
  const held = await pipeline.runHeldHostTurn({
    launch: async () => ({ result: new Promise(() => {}) }),
    waitForGate: async () => {},
    waitForObservation: async () => {},
    captureProcessIdentity: async () => ({ pid: 66311, ppid: 121, nonce: 'a'.repeat(64), startIdentity: 'start-a' }),
    terminateProcessIdentity: async () => ({ attempted: true, signalled: 'SIGTERM', exited: true, failure: null }),
    readProcessIdentity: async () => undefined,
    waitForProcessExit: async () => {},
    // Synchronized fake clocks: every wait advances both clocks by exactly
    // the requested amount, so the 600 registered intervals elapse in
    // bounded real time while the schedule stays exact.
    sleep: async (ms) => {
      monotonic += ms;
      wall += ms;
    },
    now: () => monotonic,
    wallClockNow: () => wall,
    holdMs: 700_000,
    budgetMs: 10_000_000,
    measurementCutoffSchedule: true,
    sampleDurableSnapshots: { intervalMs: 1_000 },
    readDurableSnapshot: async () => {
      supplierCalls += 1;
      // The gate releases only when the sampler has consumed the WHOLE
      // registered ceiling — the release cannot race the cap.
      if (supplierCalls === 600) releaseGateNow();
      return RUNNING;
    },
    // The release hook PENDS until the cap is consumed: the arm's claims
    // cannot start before the sampler has exhausted the combined ceiling.
    releaseGate: async () => { await gateReleased; },
  });
  assert.equal(held.budgetExpired, false);
  const ledger = /** @type {any} */ (held.childSettlement)?.durableReadLedger;
  assert.ok(ledger && typeof ledger === 'object', 'the shared read ledger rides the turn result');
  assert.ok(supplierCalls <= 600,
    `the combined ceiling caps EVERY consumer's supplier calls (got ${String(supplierCalls)})`);
  assert.equal(ledger.attempts, 600, 'the ledger counts exactly the registered combined attempts');
  assert.ok((ledger.attemptsRefusedAtCap ?? 0) >= 2,
    `reads refused at the cap are NAMED (got ${String(ledger.attemptsRefusedAtCap)})`);
  const samples = held.childSettlement?.durableSamples;
  assert.ok(samples?.omissions?.some((omission) => omission.reason === 'durable-sampling-attempt-cap-reached'),
    `the sampler's own attempt-cap omission rides (actual ${JSON.stringify(samples?.omissions ?? [])})`);
  assert.equal(ledger.starts.length + (ledger.unpacedAttempts ?? 0) + 0, ledger.attempts,
    'every counted attempt is either a paced start or a named unpaced account-only claim');
});

test('the shared read ledger survives mapping, serialization, and reload: the retained record carries the combined accounting', async (t) => {
  // Codex gate round-11 finding 3's repro: attaching the ledger to the held
  // record does NOT preserve it in the case record — mapShellWaitLiveFacts
  // rebuilt the child facts without it and buildCaseRecord omitted it from
  // `child`, so the serialized→reloaded record lost the field at BOTH
  // boundaries and could not verify the combined attempt accounting or the
  // global cadence (the sampler-only summaries never include the
  // authoritative-arm starts). The bounded projection now flows through both
  // stages and the reloaded record carries it verbatim.
  let monotonic = 0;
  let wall = 500_000;
  let releaseWallMs = null;
  let resolveRootResult = null;
  const RUNNING = { aggregate: 'unresolved', executorLinkage: 'verified', reasons: [], passive: { snapshotEqual: true }, job: { presence: 'found', projection: { status: null } } };
  const held = await pipeline.runHeldHostTurn({
    launch: async () => ({ result: new Promise((resolve) => { resolveRootResult = resolve; }) }),
    waitForGate: async () => {},
    waitForObservation: async () => {},
    captureProcessIdentity: async () => ({ pid: 66321, ppid: 122, nonce: 'a'.repeat(64), startIdentity: 'start-a' }),
    terminateProcessIdentity: async () => ({ attempted: true, signalled: 'SIGTERM', exited: true, failure: null }),
    readProcessIdentity: async () => undefined,
    waitForProcessExit: async () => {},
    sleep: async (ms) => {
      monotonic += ms;
      wall += ms;
      if (resolveRootResult !== null && releaseWallMs !== null && wall >= releaseWallMs + 1_000) {
        const resolve = resolveRootResult;
        resolveRootResult = null;
        resolve({ code: 0, stdout: 'sentinel', stderr: '' });
      }
    },
    now: () => monotonic,
    wallClockNow: () => wall,
    holdMs: 100_000,
    budgetMs: 1_200_000,
    measurementCutoffSchedule: true,
    sampleDurableSnapshots: { intervalMs: 2_000 },
    readDurableSnapshot: async () => RUNNING,
    releaseGate: async () => { releaseWallMs = wall; },
  });
  const liveLedger = /** @type {any} */ (held.childSettlement)?.durableReadLedger;
  assert.ok(liveLedger && typeof liveLedger === 'object' && Array.isArray(liveLedger.starts) && liveLedger.starts.length >= 2,
    'premise: the held turn carries a combined read ledger with paced starts');
  // Boundary 1: the mapper.
  const facts = pipeline.mapShellWaitLiveFacts(
    { case: 'rescue-interrupt', pollMs: 3_600_000, waitPolicy: null, interruptBaselineSelector: null, survivalControlSelector: null },
    held, supportedEvidence(), null, null, mapperFixture, causalRollouts(), [], LAUNCHER,
  );
  assert.deepEqual(/** @type {any} */ (facts.child)?.durableReadLedger, liveLedger,
    'the mapper carries the combined ledger projection verbatim');
  // Boundary 2: the serializer + reload.
  const root = await mkdtemp(join(tmpdir(), 'shell-wait-native-interruption-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  try {
    await pipeline.runShellWaitCase(
      { case: 'rescue-interrupt', codexBinary: process.execPath, sourceSha: 'a'.repeat(40), workerDurationMs: 420_000, capMs: 3_600_000, pollMs: 3_600_000, budgetMs: 1_200_000, output: root },
      { createFixture: async () => mapperFixture, executeLiveCase: async () => facts },
    );
    const recordName = (await readdir(root)).find((name) => name.endsWith('.record.json'));
    const reloaded = JSON.parse(await readFile(join(root, recordName), 'utf8'));
    assert.deepEqual(/** @type {any} */ (reloaded.child)?.durableReadLedger, liveLedger,
      'the reloaded record carries the combined ledger exactly as the live facts held it');
    assert.equal(/** @type {any} */ (reloaded.child)?.durableReadLedger?.attempts, liveLedger.attempts);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('under NORMAL timers the sampler never starves the authoritative arm: a +5000 ms success keeps its winner', async (t) => {
  // Codex gate round-12 finding 1's repro: with both consumers on the shared
  // stream under normal timers, the sampler repeatedly claimed each newly
  // available slot before the authoritative reader woke from its 100 ms
  // pacing chunks — the arm's claim stayed pending until the cutoff and even
  // the reserved final read never started: only sampler reads ran before the
  // cutoff, `terminalWinner` stayed null despite pre-cutoff success. The
  // shared claim now serves queued claimants FAIRLY (FIFO by wait
  // registration): a queued authoritative claim is served before the sampler
  // may claim again — the global ≥1000-ms spacing and the ≤600 combined cap
  // stay intact (fairness, not a cadence exception).
  const mono0 = Date.now();
  let finishAtMs = null;
  let releaseWallMs = null;
  /** @type {number[]} */
  const readStarts = [];
  const RUNNING = { aggregate: 'unresolved', executorLinkage: 'verified', reasons: [], passive: { snapshotEqual: true }, job: { presence: 'found', projection: { id: 'job-1', status: null } }, layers: { bindingCurrency: { state: 'current', anchorsJob: 'job-1' } } };
  const SUCCEEDED = { aggregate: 'settled', executorLinkage: 'verified', reasons: [], passive: { snapshotEqual: true }, job: { presence: 'found', projection: { id: 'job-1', status: 'succeeded' } }, layers: { bindingCurrency: { state: 'current', anchorsJob: 'job-1' } } };
  const held = await pipeline.runHeldHostTurn({
    // NO injected sleep: the driver's default REAL setTimeout drives every
    // wait — the exact scheduler family the reviewer's production run used.
    launch: async () => ({ result: new Promise((resolve) => { setTimeout(() => resolve({ code: 0, stdout: 'sentinel', stderr: '' }), 6_500); }) }),
    waitForGate: async () => {},
    waitForObservation: async () => {},
    captureProcessIdentity: async () => ({ pid: 66331, ppid: 123, nonce: 'a'.repeat(64), startIdentity: 'start-a' }),
    terminateProcessIdentity: async () => ({ attempted: true, signalled: 'SIGTERM', exited: true, failure: null }),
    readProcessIdentity: async () => undefined,
    waitForProcessExit: async () => {},
    now: () => Date.now() - mono0,
    wallClockNow: () => 500_000 + (Date.now() - mono0),
    holdMs: 100,
    budgetMs: 60_000,
    measurementCutoffSchedule: true,
    sampleDurableSnapshots: { intervalMs: 2_000 },
    readDurableSnapshot: async () => {
      const stamp = 500_000 + (Date.now() - mono0);
      if (releaseWallMs !== null) readStarts.push(stamp - releaseWallMs);
      return finishAtMs !== null && stamp >= finishAtMs ? SUCCEEDED : RUNNING;
    },
    releaseGate: async () => {
      // The job succeeds at release+5000 ms — inside the credit window
      // (cutoff at release+10000 ms).
      finishAtMs = 500_000 + (Date.now() - mono0) + 5_000;
      releaseWallMs = 500_000 + (Date.now() - mono0);
    },
  });
  assert.equal(held.budgetExpired, false);
  const cutoff = /** @type {number} */ (held.cleanup.measurementCutoffAtMs);
  assert.ok(held.childSettlement?.preCutoffDurableSnapshot,
    `at least one authoritative pre-cutoff read happened (reads at ${JSON.stringify(readStarts)})`);
  assert.equal(held.childSettlement.preCutoffDurableSnapshot.job.projection.status, 'succeeded',
    `the preserved authoritative read observed the +5000 ms success (reads at ${JSON.stringify(readStarts)})`);
  assert.ok(held.childSettlement.preCutoffDurableSnapshot.completedAtMs < cutoff,
    'the preserved read completed strictly before the armed cutoff');
  assert.ok(readStarts.some((start) => start >= 5_000 && start < 10_000),
    `a read ran in the final pre-cutoff stretch after the finish (reads: ${JSON.stringify(readStarts)})`);
  const facts = pipeline.mapShellWaitLiveFacts(
    { case: 'rescue-interrupt', pollMs: 3_600_000, waitPolicy: null, interruptBaselineSelector: null, survivalControlSelector: null },
    held, supportedEvidence(), null, null, mapperFixture, causalRollouts(), [], LAUNCHER,
  );
  const root = await mkdtemp(join(tmpdir(), 'shell-wait-native-interruption-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const persistFixture = { ...mapperFixture, dispose: async () => {} };
  await pipeline.runShellWaitCase(
    { case: 'rescue-interrupt', codexBinary: process.execPath, sourceSha: 'a'.repeat(40), workerDurationMs: 420_000, capMs: 3_600_000, pollMs: 3_600_000, budgetMs: 1_200_000, output: root },
    { createFixture: async () => persistFixture, executeLiveCase: async () => facts },
  );
  const recordName = (await readdir(root)).find((name) => name.endsWith('.record.json'));
  const reloaded = JSON.parse(await readFile(join(root, recordName), 'utf8'));
  const input = pipeline.nativeInterruptionGateDInput(reloaded);
  assert.equal(input.terminalWinner, 'succeeded', 'the winner credits from the authoritative pre-cutoff read');
  const verdict = evaluateNativeInterruptionSettlement(input);
  assert.equal(verdict.reasons.includes('terminal-winner-unobserved'), false, JSON.stringify(verdict.reasons));
});

test('a settlement-arm read still pending at the observation endpoint is a NAMED abandonment on the persisted record', async (t) => {
  // Codex gate round-12 finding 2's repro: the release-edge read completed,
  // but a subsequent settlement-arm read remained pending through observation
  // teardown while the final refresh succeeded — the endpoint branch silently
  // abandoned the stalled read (no named late/missing fact, `postRelease`
  // absent from the record). The branch now records the endpoint abandonment
  // in `postRelease` before breaking — the same discipline as the early-read
  // and refresh branches.
  let monotonic = 0;
  let wall = 500_000;
  let readCalls = 0;
  let stalled = false;
  const RUNNING = { aggregate: 'unresolved', executorLinkage: 'verified', reasons: [], passive: { snapshotEqual: true }, job: { presence: 'found', projection: { id: 'job-1', status: null } } };
  const SUCCEEDED = { aggregate: 'settled', executorLinkage: 'verified', reasons: [], passive: { snapshotEqual: true }, job: { presence: 'found', projection: { id: 'job-1', status: 'succeeded' } } };
  const held = await pipeline.runHeldHostTurn({
    launch: async () => ({ result: new Promise(() => {}) }),
    waitForGate: async () => {},
    waitForObservation: async () => {},
    captureProcessIdentity: async () => ({ pid: 66341, ppid: 124, nonce: 'a'.repeat(64), startIdentity: 'start-a' }),
    terminateProcessIdentity: async () => ({ attempted: true, signalled: 'SIGTERM', exited: true, failure: null }),
    readProcessIdentity: async () => undefined,
    waitForProcessExit: async () => {},
    // Synchronized fake clocks: the window elapses in bounded real time.
    sleep: async (ms) => {
      monotonic += ms;
      wall += ms;
    },
    now: () => monotonic,
    wallClockNow: () => wall,
    holdMs: 100_000,
    budgetMs: 10_000_000,
    measurementCutoffSchedule: true,
    readDurableSnapshot: async () => {
      readCalls += 1;
      // Call 4: the settlement-arm read that STALLS through the endpoint.
      // Calls ≥5: the window-end refresh succeeds (the reviewer's shape).
      if (readCalls === 4) {
        stalled = true;
        return new Promise(() => {});
      }
      return readCalls >= 5 ? SUCCEEDED : RUNNING;
    },
    releaseGate: async () => {},
  });
  assert.equal(held.budgetExpired, false);
  assert.equal(stalled, true, 'premise: a settlement-arm read stalled');
  // The successful final refresh rode the record (the reviewer's shape).
  assert.equal(held.childSettlement?.durableSnapshot?.job?.projection?.status, 'succeeded',
    'the final refresh succeeded and its snapshot rides the record');
  assert.equal(held.postRelease?.settlementArmRead, 'durable-read-pending-at-planned-observation-end',
    `the stalled settlement-arm read is NAMED (postRelease: ${JSON.stringify(held.postRelease ?? null)})`);
  const root = await mkdtemp(join(tmpdir(), 'shell-wait-native-interruption-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const facts = pipeline.mapShellWaitLiveFacts(
    { case: 'rescue-interrupt', pollMs: 3_600_000, waitPolicy: null, interruptBaselineSelector: null, survivalControlSelector: null },
    held, supportedEvidence(), null, null, mapperFixture, causalRollouts(), [], LAUNCHER,
  );
  await pipeline.runShellWaitCase(
    { case: 'rescue-interrupt', codexBinary: process.execPath, sourceSha: 'a'.repeat(40), workerDurationMs: 420_000, capMs: 3_600_000, pollMs: 3_600_000, budgetMs: 1_200_000, output: root },
    { createFixture: async () => mapperFixture, executeLiveCase: async () => facts },
  );
  const recordName = (await readdir(root)).find((name) => name.endsWith('.record.json'));
  const reloaded = JSON.parse(await readFile(join(root, recordName), 'utf8'));
  assert.equal(/** @type {any} */ (reloaded.held)?.postRelease?.settlementArmRead, 'durable-read-pending-at-planned-observation-end',
    'the named abandonment persists on the record');
});

test('the reserved final read survives queue fairness: a +9500 ms success with BOTH consumers keeps its winner', async (t) => {
  // Codex gate round-13's repro: with both consumers enabled under default
  // timers, queue fairness could block the reserved pull-in behind an older
  // sampler claim whose next legal slot falls at/after the cutoff — the last
  // authoritative read stayed around +9012 ms (running) and the next read was
  // the fenced +14000 ms refresh, so Gate D lost the legitimate terminal
  // winner. Fairness now yields to the reserve when the older floor-paced
  // claimant cannot legally run before credit closes: the reserved read
  // proceeds within the final pre-cutoff stretch (starting no earlier than
  // cutoff−500 ms — exactly where this finish sits), while the global floor
  // and cap stay intact for everyone else.
  const mono0 = Date.now();
  let finishAtMs = null;
  let releaseWallMs = null;
  /** @type {number[]} */
  const readStarts = [];
  const RUNNING = { aggregate: 'unresolved', executorLinkage: 'verified', reasons: [], passive: { snapshotEqual: true }, job: { presence: 'found', projection: { id: 'job-1', status: null } }, layers: { bindingCurrency: { state: 'current', anchorsJob: 'job-1' } } };
  const SUCCEEDED = { aggregate: 'settled', executorLinkage: 'verified', reasons: [], passive: { snapshotEqual: true }, job: { presence: 'found', projection: { id: 'job-1', status: 'succeeded' } }, layers: { bindingCurrency: { state: 'current', anchorsJob: 'job-1' } } };
  const held = await pipeline.runHeldHostTurn({
    // NO injected sleep: the driver's default REAL setTimeout — the exact
    // scheduler family the reviewer's run used.
    launch: async () => ({ result: new Promise((resolve) => { setTimeout(() => resolve({ code: 0, stdout: 'sentinel', stderr: '' }), 10_800); }) }),
    waitForGate: async () => {},
    waitForObservation: async () => {},
    captureProcessIdentity: async () => ({ pid: 66351, ppid: 125, nonce: 'a'.repeat(64), startIdentity: 'start-a' }),
    terminateProcessIdentity: async () => ({ attempted: true, signalled: 'SIGTERM', exited: true, failure: null }),
    readProcessIdentity: async () => undefined,
    waitForProcessExit: async () => {},
    now: () => Date.now() - mono0,
    wallClockNow: () => 500_000 + (Date.now() - mono0),
    holdMs: 1_000,
    budgetMs: 60_000,
    measurementCutoffSchedule: true,
    // BOTH consumers enabled (the reviewer's shape).
    sampleDurableSnapshots: { intervalMs: 2_000 },
    readDurableSnapshot: async () => {
      const stamp = 500_000 + (Date.now() - mono0);
      if (releaseWallMs !== null) readStarts.push(stamp - releaseWallMs);
      return finishAtMs !== null && stamp >= finishAtMs ? SUCCEEDED : RUNNING;
    },
    releaseGate: async () => {
      // The job succeeds at release+9500 ms — inside the final pre-cutoff
      // stretch (the cutoff sits at release+10000 ms).
      finishAtMs = 500_000 + (Date.now() - mono0) + 9_500;
      releaseWallMs = 500_000 + (Date.now() - mono0);
    },
  });
  assert.equal(held.budgetExpired, false);
  const cutoff = /** @type {number} */ (held.cleanup.measurementCutoffAtMs);
  assert.ok(held.childSettlement?.preCutoffDurableSnapshot,
    `a pre-cutoff authoritative snapshot survived (reads at ${JSON.stringify(readStarts)})`);
  assert.equal(held.childSettlement.preCutoffDurableSnapshot.job.projection.status, 'succeeded',
    `the preserved snapshot carries the +9500 ms success (reads at ${JSON.stringify(readStarts)})`);
  assert.ok(held.childSettlement.preCutoffDurableSnapshot.completedAtMs < cutoff,
    'the preserved read completed strictly before the armed cutoff');
  assert.ok(readStarts.some((start) => start >= 9_000 && start < 10_000),
    `the reserved read ran in the final pre-cutoff stretch (reads: ${JSON.stringify(readStarts)})`);
  const facts = pipeline.mapShellWaitLiveFacts(
    { case: 'rescue-interrupt', pollMs: 3_600_000, waitPolicy: null, interruptBaselineSelector: null, survivalControlSelector: null },
    held, supportedEvidence(), null, null, mapperFixture, causalRollouts(), [], LAUNCHER,
  );
  const root = await mkdtemp(join(tmpdir(), 'shell-wait-native-interruption-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const persistFixture = { ...mapperFixture, dispose: async () => {} };
  await pipeline.runShellWaitCase(
    { case: 'rescue-interrupt', codexBinary: process.execPath, sourceSha: 'a'.repeat(40), workerDurationMs: 420_000, capMs: 3_600_000, pollMs: 3_600_000, budgetMs: 1_200_000, output: root },
    { createFixture: async () => persistFixture, executeLiveCase: async () => facts },
  );
  const recordName = (await readdir(root)).find((name) => name.endsWith('.record.json'));
  const reloaded = JSON.parse(await readFile(join(root, recordName), 'utf8'));
  const input = pipeline.nativeInterruptionGateDInput(reloaded);
  assert.equal(input.terminalWinner, 'succeeded', 'Gate D credits the legitimate terminal winner');
  const verdict = evaluateNativeInterruptionSettlement(input);
  assert.equal(verdict.reasons.includes('terminal-winner-unobserved'), false, JSON.stringify(verdict.reasons));
});

test('a refresh pending at the endpoint that finishes during host termination keeps its deadline-miss fact', async () => {
  // Codex gate round-14 finding 1's repro: Root remains running at the
  // planned endpoint, so the RECORDED termination cleanup is awaited before
  // the refresh check — a refresh pending at the endpoint can FINISH during
  // that cleanup, its mutable `state.settled` flipping true and bypassing
  // the required `postRelease.refreshedDurableRead` deadline-miss fact. The
  // outcome is now LATCHED when the window ends (before the cleanup); the
  // late completion's data still rides the fenced observation placeholder.
  let monotonic = 0;
  let wall = 500_000;
  let releaseWallMs = null;
  let refreshPending = null;
  let resolveRefresh = null;
  let terminationCalls = 0;
  const RUNNING = { aggregate: 'unresolved', executorLinkage: 'verified', reasons: [], passive: { snapshotEqual: true }, job: { presence: 'found', projection: { id: 'job-1', status: null } } };
  const SUCCEEDED = { aggregate: 'settled', executorLinkage: 'verified', reasons: [], passive: { snapshotEqual: true }, job: { presence: 'found', projection: { id: 'job-1', status: 'succeeded' } } };
  const identity = { pid: 66361, ppid: 126, nonce: 'a'.repeat(64), startIdentity: 'start-a' };
  const held = await pipeline.runHeldHostTurn({
    // Root never resolves: the window ends with Root running (the fix-C
    // recorded-termination path the finding describes).
    launch: async () => ({ result: new Promise(() => {}) }),
    waitForGate: async () => {},
    waitForObservation: async () => {},
    captureProcessIdentity: async () => identity,
    readProcessIdentity: async () => identity,
    terminateProcessIdentity: async () => {
      terminationCalls += 1;
      // The refresh finishes DURING host termination (the reviewer's shape).
      if (resolveRefresh !== null) {
        const resolve = resolveRefresh;
        resolveRefresh = null;
        resolve(SUCCEEDED);
      }
      return { attempted: true, signalled: 'SIGTERM', exited: true, failure: null };
    },
    waitForProcessExit: async () => {},
    // Synchronized fake clocks: the window elapses in bounded real time.
    sleep: async (ms) => {
      monotonic += ms;
      wall += ms;
    },
    now: () => monotonic,
    wallClockNow: () => wall,
    holdMs: 100_000,
    budgetMs: 10_000_000,
    measurementCutoffSchedule: true,
    readDurableSnapshot: async () => {
      // The window-end refresh pends until host termination resolves it.
      if (releaseWallMs !== null && wall >= releaseWallMs + 13_000) {
        if (refreshPending === null) {
          refreshPending = new Promise((resolve) => { resolveRefresh = resolve; });
        }
        return refreshPending;
      }
      return RUNNING;
    },
    releaseGate: async () => { releaseWallMs = wall; },
  });
  assert.equal(held.budgetExpired, false);
  assert.equal(held.postRelease?.rootResult, 'root-result-missing-at-planned-observation-end',
    'premise: the recorded termination cleanup path ran (Root running at the endpoint)');
  assert.ok(terminationCalls >= 1, 'premise: host termination ran and the refresh finished during it');
  assert.equal(held.postRelease?.refreshedDurableRead, 'durable-read-pending-at-planned-observation-end',
    `the deadline-miss fact SURVIVES the late-during-cleanup completion (postRelease: ${JSON.stringify(held.postRelease ?? null)})`);
  // The late completion's data still rides the fenced observation placeholder.
  assert.equal(held.childSettlement?.durableSnapshot?.sampledAggregate, 'settled',
    `the late completion rides as the fenced observation sample aggregate (got ${String(held.childSettlement?.durableSnapshot?.sampledAggregate)}, snapshot ${JSON.stringify(held.childSettlement?.durableSnapshot ?? null)})`);
});

test('a rejecting Root result keeps the release-edge abandonment fact on the FAILURE record', async (t) => {
  // Codex gate round-14 finding 2's repro: Root rejects while the
  // release-edge durable read stalls through the observation endpoint — the
  // early-read branch records `postRelease.earlyDurableRead`, but joining the
  // rejected Root result then THROWS, and the outer catch rebuilt the
  // held-turn record without the block, so the abandonment fact never reached
  // the mapper or the persisted record. The diagnostics object is hoisted to
  // turn scope (the round-5 carrier pattern) and the failure record carries
  // whatever was already recorded before the throw.
  let monotonic = 0;
  let wall = 500_000;
  let rootRejected = false;
  let rejectRoot = null;
  const harness = {
    // Root REJECTS at release+2000 fake-ms (fake-clock driven — the
    // rejection lands mid-window, deterministically, while the release-edge
    // read is still stalled).
    launch: async () => ({
      result: new Promise((_, reject) => { rejectRoot = reject; }),
    }),
    waitForGate: async () => {},
    waitForObservation: async () => {},
    captureProcessIdentity: async () => ({ pid: 66371, ppid: 127, nonce: 'a'.repeat(64), startIdentity: 'start-a' }),
    terminateProcessIdentity: async () => ({ attempted: true, signalled: 'SIGTERM', exited: true, failure: null }),
    readProcessIdentity: async () => undefined,
    waitForProcessExit: async () => {},
    // Synchronized fake clocks: the release-edge read stalls through the
    // observation endpoint in bounded real time. Root REJECTS at hold+2000
    // fake-ms (fake-clock driven — the rejection lands mid-window,
    // deterministically, while the release-edge read is still stalled).
    sleep: async (ms) => {
      monotonic += ms;
      wall += ms;
      if (!rootRejected && rejectRoot !== null && monotonic >= 100_000 + 2_000) {
        rootRejected = true;
        rejectRoot(new Error('the host result rejected'));
      }
    },
    now: () => monotonic,
    wallClockNow: () => wall,
    holdMs: 100_000,
    budgetMs: 10_000_000,
    measurementCutoffSchedule: true,
    readDurableSnapshot: async () => {
      // The release-edge read is the FIRST post-release read in this flow:
      // it STALLS through the observation endpoint (every later read stalls
      // with it).
      return new Promise(() => {});
    },
    releaseGate: async () => {},
  };
  // The held turn THROWS on a rejecting Root result — the structured record
  // rides the error (the production executor maps exactly this).
  let held;
  try {
    held = await pipeline.runHeldHostTurn(harness);
  } catch (error) {
    held = /** @type {any} */ (error)?.heldTurn ?? null;
  }
  assert.ok(held, 'premise: the held-turn record survived the throw');
  assert.ok(held.failure !== undefined, 'premise: the held turn failed');
  assert.equal(held.postRelease?.earlyDurableRead, 'durable-read-pending-at-planned-observation-end',
    `the release-edge abandonment was recorded before the throw (postRelease: ${JSON.stringify(held.postRelease ?? null)})`);
  const root = await mkdtemp(join(tmpdir(), 'shell-wait-native-interruption-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const caseInput = { case: 'rescue-interrupt', codexBinary: process.execPath, sourceSha: 'a'.repeat(40), workerDurationMs: 420_000, capMs: 3_600_000, pollMs: 3_600_000, budgetMs: 1_200_000, output: root };
  // The production executor's failure mapping, replayed: whatever held-turn
  // record survived is mapped into redacted live facts and carried on the
  // rethrown error, so runShellWaitCase persists the FAILED record.
  await assert.rejects(
    pipeline.runShellWaitCase(
      caseInput,
      { createFixture: async () => mapperFixture, executeLiveCase: async ({ input }) => {
        const liveFacts = pipeline.mapShellWaitLiveFacts(
          input, held, { status: 'inconclusive', inconclusive: { reason: 'the held observation failed before evidence collection', detail: 'the host result rejected' }, facts: null },
          null, null, mapperFixture,
        );
        throw Object.assign(new Error('the held observation failed'), { liveFacts });
      } }),
    /the held observation failed/u,
  );
  const recordName = (await readdir(root)).find((name) => name.endsWith('.record.json'));
  const reloaded = JSON.parse(await readFile(join(root, recordName), 'utf8'));
  assert.equal(/** @type {any} */ (reloaded.held)?.postRelease?.earlyDurableRead, 'durable-read-pending-at-planned-observation-end',
    'the abandonment fact rides the FAILURE record through serialize→reload');
});


test('a refresh finishing during natural-exit cleanup keeps its deadline-miss fact (the latch precedes BOTH endpoint cleanups)', async () => {
  // Codex gate round-15 finding 1's repro: Root returns INSIDE the window
  // (after the window-end refresh has fired) but the fixture survives until
  // the natural-exit endpoint — that branch awaits termination cleanup
  // before the round-14 re-latch, so a refresh pending at the endpoint can
  // FINISH during the cleanup and its mutable `state.settled` suppresses
  // `postRelease.refreshedDurableRead` — the same deadline-miss loss the
  // round-14 latch fixed for the Root-missing branch. The endpoint latch now
  // happens ONCE, before EITHER endpoint cleanup path.
  let monotonic = 0;
  let wall = 500_000;
  let releaseWallMs = null;
  let refreshPending = null;
  let resolveRefresh = null;
  let resolveRefreshOnNextTick = false;
  let resolveRoot = null;
  let terminationCalls = 0;
  const RUNNING = { aggregate: 'unresolved', executorLinkage: 'verified', reasons: [], passive: { snapshotEqual: true }, job: { presence: 'found', projection: { id: 'job-1', status: null } } };
  const SUCCEEDED = { aggregate: 'settled', executorLinkage: 'verified', reasons: [], passive: { snapshotEqual: true }, job: { presence: 'found', projection: { id: 'job-1', status: 'succeeded' } } };
  const identity = { pid: 66381, ppid: 128, nonce: 'a'.repeat(64), startIdentity: 'start-a' };
  // The synchronized fake clocks, as a LOCAL (the injected exit watch spins
  // on it too — object properties are not bindings).
  const fakeSleep = async (ms) => {
    monotonic += ms;
    wall += ms;
    if (resolveRefreshOnNextTick && refreshPending !== null && resolveRefresh !== null) {
      resolveRefreshOnNextTick = false;
      const resolve = resolveRefresh;
      resolveRefresh = null;
      resolve(SUCCEEDED);
    }
    if (releaseWallMs !== null && resolveRoot !== null && wall >= releaseWallMs + 14_000) {
      const resolve = resolveRoot;
      resolveRoot = null;
      resolve({ code: 0, stdout: 'sentinel', stderr: '' });
    }
  };
  const held = await pipeline.runHeldHostTurn({
    // Root resolves INSIDE the window, at release+14 s (after the window-end
    // refresh has fired at release+13 s), driven by the fake clock.
    launch: async () => ({ result: new Promise((resolve) => { resolveRoot = resolve; }) }),
    waitForGate: async () => {},
    waitForObservation: async () => {},
    captureProcessIdentity: async () => identity,
    // The fixture SURVIVES past the natural-exit endpoint.
    readProcessIdentity: async () => identity,
    terminateProcessIdentity: async () => {
      terminationCalls += 1;
      // The refresh finishes DURING the natural-exit termination cleanup:
      // arm the resolution; the next fake-clock hop fires it (after the
      // branch's endpoint latch has frozen the pending outcome).
      resolveRefreshOnNextTick = true;
      return { attempted: true, signalled: 'SIGTERM', exited: true, failure: null };
    },
    waitForProcessExit: async () => {
      // The exact-Companion exit watch PENDS past the natural-exit endpoint
      // (the fixture survives), then reports the legacy timeout failure —
      // the endpoint decision is the observation window's, not the watch's.
      while (monotonic < 116_000) await fakeSleep(100);
      // The exit resolves (the fixture gone) — the endpoint decision stays the
      // observation window's (it ended at 115000, before this resolution).
      return;
    },
    // Synchronized fake clocks: the window elapses in bounded real time.
    sleep: fakeSleep,
    now: () => monotonic,
    wallClockNow: () => wall,
    holdMs: 100_000,
    budgetMs: 10_000_000,
    measurementCutoffSchedule: true,
    readDurableSnapshot: async () => {
      // The window-end refresh pends; the natural-exit cleanup resolves it.
      if (releaseWallMs !== null && wall >= releaseWallMs + 13_000) {
        if (refreshPending === null) {
        refreshPending = new Promise((resolve) => { resolveRefresh = resolve; });
      }
      return refreshPending;
      }
      return RUNNING;
    },
    releaseGate: async () => { releaseWallMs = wall; },
  }) .catch((error) => /** @type {any} */ (error)?.heldTurn ?? null);
  assert.ok(held, 'premise: the held-turn record survived the watcher timeout throw');
  assert.equal(held.budgetExpired, false);
  assert.equal(held.postRelease?.naturalExit, 'natural-exit-unobserved-at-planned-observation-end',
    'premise: the natural-exit expiry path ran');
  assert.ok(terminationCalls >= 1, 'premise: the refresh finished during the natural-exit cleanup');
  assert.equal(held.postRelease?.refreshedDurableRead, 'durable-read-pending-at-planned-observation-end',
    `the deadline-miss fact SURVIVES the refresh finishing during cleanup (postRelease: ${JSON.stringify(held.postRelease ?? null)})`);
  // The late completion's data may still ride the fenced observation
  // placeholder (its sampled aggregate updates whenever the late carrier
  // lands); the deadline-miss fact above is the round-15 requirement.
  assert.ok(held.childSettlement?.durableSnapshot !== undefined,
    'the refresh observation block still rides the record');
});

test('on the scheduled path the default exit watcher waits for the planned observation endpoint: a lawful natural exit at +12.5 s is observed, never cut off at +10 s', async () => {
  // Codex gate round-15 finding 2's repro: Root returns promptly, but the
  // fixture is scheduled to exit naturally at release+12.5 s — inside the
  // 15-s observation window. The default exit watcher's independent
  // 10-second natural-exit timeout fired first: the lawful natural exit was
  // cut off, termination cleanup ran, and the remaining observation window
  // was lost. The scheduled path now binds the default watcher to the
  // planned observation endpoint.
  let monotonic = 0;
  let wall = 500_000;
  let releaseWallMs = null;
  let resolveRoot = null;
  let terminateCalls = 0;
  const identity = { pid: 66391, ppid: 129, nonce: 'a'.repeat(64), startIdentity: 'start-a' };
  const held = await pipeline.runHeldHostTurn({
    // Root returns promptly (inside the window), fake-clock driven.
    launch: async () => ({ result: new Promise((resolve) => { resolveRoot = resolve; }) }),
    waitForGate: async () => {},
    waitForObservation: async () => {},
    captureProcessIdentity: async () => identity,
    // The fixture exits NATURALLY at release+12.5 s (inside the window).
    readProcessIdentity: async () => (releaseWallMs !== null && wall < releaseWallMs + 12_500 ? identity : undefined),
    terminateProcessIdentity: async () => {
      terminateCalls += 1;
      return { attempted: true, signalled: 'SIGTERM', exited: true, failure: null };
    },
    // The DEFAULT exit watcher (no injection): its legacy natural timeout is
    // 10 s from turn start.
    // Synchronized fake clocks: the window elapses in bounded real time.
    sleep: async (ms) => {
      monotonic += ms;
      wall += ms;
      if (releaseWallMs !== null && resolveRoot !== null && wall >= releaseWallMs + 1_000) {
        const resolve = resolveRoot;
        resolveRoot = null;
        resolve({ code: 0, stdout: 'sentinel', stderr: '' });
      }
    },
    now: () => monotonic,
    wallClockNow: () => wall,
    holdMs: 100_000,
    budgetMs: 10_000_000,
    measurementCutoffSchedule: true,
    releaseGate: async () => { releaseWallMs = wall; },
  });
  assert.equal(held.budgetExpired, false);
  assert.equal(held.failure, undefined,
    `the lawful natural exit is never cut off into a failure (failure: ${String(held.failure?.message ?? 'none')})`);
  assert.equal(held.cleanup.verifiedProcessTerminated, false,
    `no premature termination at the legacy timeout (terminations: ${String(terminateCalls)})`);
  assert.equal(terminateCalls, 0, 'the fixture was never terminated');
  assert.ok(held.result !== undefined, 'the natural completion is recorded with the Root outcome');
});

test('the default exit watcher\u2019s planned deadline expiry is the named missing-exit outcome, never a turn failure', async (t) => {
  // Codex gate round-16's repro: Root returns promptly; the fixture stays
  // alive past the planned observation endpoint; the DEFAULT exit watcher's
  // deadline IS that endpoint — its rejection there is the EXPECTED
  // missing-exit outcome (named in postRelease), never a turn failure: the
  // termination cleanup is still awaited with boundary recording, the final
  // refresh join still runs, and the bounded observation is preserved.
  const mono0 = Date.now();
  const identity = { pid: 66401, ppid: 130, nonce: 'a'.repeat(64), startIdentity: 'start-a' };
  const held = await pipeline.runHeldHostTurn({
    // DEFAULT real timers everywhere: the reviewer's scheduler family.
    launch: async () => ({ result: new Promise((resolve) => { setTimeout(() => resolve({ code: 0, stdout: 'sentinel', stderr: '' }), 200); }) }),
    waitForGate: async () => {},
    waitForObservation: async () => {},
    captureProcessIdentity: async () => identity,
    terminateProcessIdentity: async () => ({ attempted: true, signalled: 'SIGTERM', exited: true, failure: null }),
    // The fixture stays ALIVE past the planned observation endpoint.
    readProcessIdentity: async () => identity,
    now: () => Date.now() - mono0,
    wallClockNow: () => 500_000 + (Date.now() - mono0),
    holdMs: 100,
    budgetMs: 60_000,
    measurementCutoffSchedule: true,
    readDurableSnapshot: async () => {
      // EVERY durable read — the release-edge read, the settlement-arm reads,
      // the window-end refresh — STALLS through the observation endpoint.
      return new Promise(() => {});
    },
    releaseGate: async () => {},
  });
  assert.equal(held.budgetExpired, false);
  assert.notEqual(held.cleanup.label, 'failure',
    `the planned deadline expiry is never a turn failure (label: ${String(held.cleanup.label)})`);
  assert.equal(held.failure, undefined, 'the bounded observation is preserved (no failure record)');
  assert.equal(held.postRelease?.naturalExit, 'natural-exit-unobserved-at-planned-observation-end',
    'the named missing-exit outcome rides');
  assert.equal(held.postRelease?.earlyDurableRead, 'durable-read-pending-at-planned-observation-end',
    `the stalled release-edge read is named (postRelease: ${JSON.stringify(held.postRelease ?? null)})`);
  assert.equal(held.postRelease?.refreshedDurableRead, 'durable-read-pending-at-planned-observation-end',
    'the final refresh join executed and named the pending refresh');
  const facts = pipeline.mapShellWaitLiveFacts(
    { case: 'rescue-interrupt', pollMs: 3_600_000, waitPolicy: null, interruptBaselineSelector: null, survivalControlSelector: null },
    held, supportedEvidence(), null, null, mapperFixture, causalRollouts(), [], LAUNCHER,
  );
  const root = await mkdtemp(join(tmpdir(), 'shell-wait-native-interruption-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const persistFixture = { ...mapperFixture, dispose: async () => {} };
  await pipeline.runShellWaitCase(
    { case: 'rescue-interrupt', codexBinary: process.execPath, sourceSha: 'a'.repeat(40), workerDurationMs: 420_000, capMs: 3_600_000, pollMs: 3_600_000, budgetMs: 1_200_000, output: root },
    { createFixture: async () => persistFixture, executeLiveCase: async () => facts },
  );
  const recordName = (await readdir(root)).find((name) => name.endsWith('.record.json'));
  const reloaded = JSON.parse(await readFile(join(root, recordName), 'utf8'));
  assert.equal(/** @type {any} */ (reloaded.held)?.postRelease?.refreshedDurableRead, 'durable-read-pending-at-planned-observation-end',
    'the named missing-exit and refresh facts persist on the record');
});

test('an inspection failure in the default exit watcher propagates as a real failure, never mistaken for the planned deadline expiry', async () => {
  // Codex gate round-17 finding 1's repro (the reviewer's numbers, fake
  // clocks): a 1000-ms hold — the planned observation endpoint at
  // hold+15000 ms (16 s) — with readProcessIdentity FAILING once at elapsed
  // 2000 ms, long before the endpoint, then recovering (the reviewer's
  // transient shape). The DEFAULT exit watcher rejects mid-window with that
  // INSPECTION error; ONLY the identified planned-deadline-expiry rejection
  // may convert to the named missing-exit outcome — an inspection failure
  // must propagate as a real failure through the existing failure chain
  // (pre-fix the round-16 conversion swallowed it: the error disappeared
  // from the failure record and the turn terminated at ~2 s instead of
  // running to the planned 16 s endpoint, reporting no failure at all).
  let monotonic = 0;
  let wall = 500_000;
  let releaseWallMs = null;
  let resolveRoot = null;
  let terminateCalls = 0;
  let inspectFailures = 0;
  const identity = { pid: 66431, ppid: 133, nonce: 'a'.repeat(64), startIdentity: 'start-a' };
  let held = null;
  let thrownMessage = null;
  try {
    held = await pipeline.runHeldHostTurn({
      // Root resolves INSIDE the window (release+1 s) so the default exit
      // watcher is constructed and ticking long before the failure instant.
      launch: async () => ({ result: new Promise((resolve) => { resolveRoot = resolve; }) }),
      waitForGate: async () => {},
      waitForObservation: async () => {},
      captureProcessIdentity: async () => identity,
      // The identity inspection FAILS ONCE at elapsed 2000 ms (transient —
      // the reviewer's shape), then recovers; the fixture stays alive.
      readProcessIdentity: async () => {
        if (releaseWallMs !== null && monotonic >= 2_000 && inspectFailures === 0) {
          inspectFailures += 1;
          throw new Error('the durable identity inspection failed');
        }
        return identity;
      },
      terminateProcessIdentity: async () => {
        terminateCalls += 1;
        return { attempted: true, signalled: 'SIGTERM', exited: true, failure: null };
      },
      // The DEFAULT exit watcher (no injection): its natural deadline IS the
      // planned observation endpoint (hold 1000 + 10000 + 5000 = 16000).
      // Synchronized fake clocks: the schedule elapses in bounded real time.
      sleep: async (ms) => {
        monotonic += ms;
        wall += ms;
        if (releaseWallMs !== null && resolveRoot !== null && wall >= releaseWallMs + 1_000) {
          const resolve = resolveRoot;
          resolveRoot = null;
          resolve({ code: 0, stdout: 'sentinel', stderr: '' });
        }
      },
      now: () => monotonic,
      wallClockNow: () => wall,
      holdMs: 1_000,
      budgetMs: 60_000,
      measurementCutoffSchedule: true,
      releaseGate: async () => { releaseWallMs = wall; },
    });
  } catch (error) {
    thrownMessage = String(/** @type {any} */ (error)?.message ?? error);
    held = /** @type {any} */ (error)?.heldTurn ?? null;
  }
  assert.ok(inspectFailures >= 1, 'premise: the identity inspection failed mid-window');
  assert.match(thrownMessage ?? '', /the durable identity inspection failed/u,
    `the turn FAILS with the inspection error visible — never silently converted (thrown: ${String(thrownMessage)})`);
  assert.equal(held?.cleanup.label, 'failure',
    `the turn is labelled a failure (label: ${String(held?.cleanup?.label)}, postRelease: ${JSON.stringify(held?.postRelease ?? null)})`);
  assert.equal(held?.postRelease?.naturalExit, undefined,
    'the planned-expiry conversion never fired for an inspection failure');
  assert.ok(terminateCalls >= 1, 'the failure path still terminated the alive fixture');
});

test('the refresh-endpoint latch precedes the termination cleanup on the watcher-deadline-won planned-expiry path too', async () => {
  // Codex gate round-17 finding 2's repro: the DEFAULT watcher's planned
  // deadline rejection can WIN the withinObservationWindow race (it settles
  // before the observation window resolves) — the round-16 conversion then
  // names the missing-exit outcome, but the refresh-endpoint latch fired
  // only in the ENDPOINT branch: the termination cleanup's awaits let a
  // refresh pending at the endpoint FINISH, the late latch observed it
  // settled, and postRelease.refreshedDurableRead was omitted — the
  // deadline-miss fact lost. The latch now precedes the cleanup for BOTH
  // deadline outcomes (the endpoint branch AND the watcher-deadline-won
  // planned-expiry path).
  let monotonic = 0;
  let wall = 500_000;
  let releaseWallMs = null;
  let refreshPending = null;
  let resolveRefresh = null;
  let resolveRoot = null;
  let terminateCalls = 0;
  const identity = { pid: 66441, ppid: 134, nonce: 'a'.repeat(64), startIdentity: 'start-a' };
  const SUCCEEDED = { aggregate: 'settled', executorLinkage: 'verified', reasons: [], passive: { snapshotEqual: true }, job: { presence: 'found', projection: { id: 'job-1', status: 'succeeded' } } };
  const RUNNING = { aggregate: 'unresolved', executorLinkage: 'verified', reasons: [], passive: { snapshotEqual: true }, job: { presence: 'found', projection: { id: 'job-1', status: null } } };
  const held = await pipeline.runHeldHostTurn({
    // Root resolves INSIDE the window, fake-clock driven.
    launch: async () => ({ result: new Promise((resolve) => { resolveRoot = resolve; }) }),
    waitForGate: async () => {},
    waitForObservation: async () => {},
    captureProcessIdentity: async () => identity,
    // The fixture stays ALIVE past the planned observation endpoint.
    readProcessIdentity: async () => identity,
    terminateProcessIdentity: async () => {
      terminateCalls += 1;
      // The refresh settles DURING the termination cleanup.
      if (refreshPending !== null && resolveRefresh !== null) {
        const resolve = resolveRefresh;
        resolveRefresh = null;
        resolve(SUCCEEDED);
      }
      return { attempted: true, signalled: 'SIGTERM', exited: true, failure: null };
    },
    // The DEFAULT exit watcher (no injection): its planned deadline IS the
    // observation endpoint — its rejection there races the window's own end.
    // Synchronized fake clocks: the schedule elapses in bounded real time.
    sleep: async (ms) => {
      monotonic += ms;
      wall += ms;
      if (releaseWallMs !== null && resolveRoot !== null && wall >= releaseWallMs + 1_000) {
        const resolve = resolveRoot;
        resolveRoot = null;
        resolve({ code: 0, stdout: 'sentinel', stderr: '' });
      }
    },
    now: () => monotonic,
    wallClockNow: () => wall,
    holdMs: 100_000,
    budgetMs: 10_000_000,
    measurementCutoffSchedule: true,
    readDurableSnapshot: async () => {
      // Every pre-cutoff read settles RUNNING; the window-end refresh (armed
      // at the OBSERVATION_REFRESH_LEAD lead, release+14 s) PENDS until the
      // termination cleanup resolves it.
      if (releaseWallMs !== null && wall >= releaseWallMs + 13_000) {
        if (refreshPending === null) {
          refreshPending = new Promise((resolve) => { resolveRefresh = resolve; });
        }
        return refreshPending;
      }
      return RUNNING;
    },
    releaseGate: async () => { releaseWallMs = wall; },
  });
  assert.equal(held.budgetExpired, false);
  assert.equal(held.failure, undefined, 'the planned deadline expiry is converted, never a failure');
  assert.equal(held.postRelease?.naturalExit, 'natural-exit-unobserved-at-planned-observation-end',
    'premise: the named missing-exit outcome rode');
  assert.ok(terminateCalls >= 1, 'premise: the refresh settled during the termination cleanup');
  assert.equal(held.postRelease?.refreshedDurableRead, 'durable-read-pending-at-planned-observation-end',
    `the deadline-miss fact SURVIVES the refresh settling during termination (postRelease: ${JSON.stringify(held.postRelease ?? null)}, snapshot: ${JSON.stringify(held.childSettlement?.durableSnapshot ?? null)}, label: ${String(held.cleanup?.label)})`);
  assert.equal(held.childSettlement?.durableSnapshot?.sampledAggregate, 'settled',
    'the late completion rides as the fenced observation sample aggregate');
});

test('the refresh latch reads the read\u2019s own completion instant: a refresh finishing after the planned endpoint keeps the deadline-miss fact even when the final window tick lands late', async () => {
  // Codex gate round-18 finding 1's repro (the reviewer's shape): the
  // window-end refresh read completes 267 ms AFTER the planned observation
  // endpoint but BEFORE the latch runs — event-loop work delays the final
  // window tick — so `state.settled` is already true at latch time and the
  // pre-fix latch took the on-time join branch, omitting
  // `postRelease.refreshedDurableRead`. The latch must decide from the
  // read's OWN completion instant (stamped on the turn's wall clock, the
  // same clock the planned endpoint derives from): a completion at/after
  // the endpoint keeps the named deadline-miss fact.
  let monotonic = 0;
  let wall = 500_000;
  let releaseWallMs = null;
  let refreshPending = null;
  let resolveRefresh = null;
  let refreshSettledAtWallMs = null;
  let resolveRoot = null;
  // hold 100_000 + 10_000 + 5_000: the planned observation endpoint.
  const ENDPOINT_MONO_MS = 115_000;
  // The reviewer's number: the refresh completes 267 ms past the endpoint.
  const POST_ENDPOINT_COMPLETION_MS = 267;
  const identity = { pid: 66451, ppid: 135, nonce: 'a'.repeat(64), startIdentity: 'start-a' };
  const SUCCEEDED = { aggregate: 'settled', executorLinkage: 'verified', reasons: [], passive: { snapshotEqual: true }, job: { presence: 'found', projection: { id: 'job-1', status: 'succeeded' } } };
  // Synchronized fake clocks — with ONE faithful wrinkle: the final window
  // chunk is DELAYED (the reviewer's event-loop work). The wall clock runs
  // 267 ms past the planned endpoint and the shared read finishes there,
  // BEFORE the tick lands.
  const fakeSleep = async (ms) => {
    if (releaseWallMs !== null && monotonic < ENDPOINT_MONO_MS && monotonic + ms >= ENDPOINT_MONO_MS) {
      wall = releaseWallMs + ENDPOINT_MONO_MS + POST_ENDPOINT_COMPLETION_MS;
      if (refreshPending !== null && resolveRefresh !== null) {
        const resolve = resolveRefresh;
        resolveRefresh = null;
        refreshSettledAtWallMs = wall;
        resolve(SUCCEEDED);
      }
      monotonic = ENDPOINT_MONO_MS;
      return;
    }
    monotonic += ms;
    wall += ms;
    if (releaseWallMs !== null && resolveRoot !== null && wall >= releaseWallMs + 1_000) {
      const resolve = resolveRoot;
      resolveRoot = null;
      resolve({ code: 0, stdout: 'sentinel', stderr: '' });
    }
  };
  const held = await pipeline.runHeldHostTurn({
    // Root returns promptly (inside the window), fake-clock driven.
    launch: async () => ({ result: new Promise((resolve) => { resolveRoot = resolve; }) }),
    waitForGate: async () => {},
    waitForObservation: async () => {},
    captureProcessIdentity: async () => identity,
    terminateProcessIdentity: async () => ({ attempted: true, signalled: 'SIGTERM', exited: true, failure: null }),
    readProcessIdentity: async () => identity,
    // The fixture exits NATURALLY inside the window (injected watcher): no
    // exit-endpoint crossing, so the ONLY latch is the window's true end —
    // where the reviewer's delayed tick runs AFTER the refresh completed.
    waitForProcessExit: async () => {
      while (monotonic < 114_500) await fakeSleep(50);
    },
    sleep: fakeSleep,
    now: () => monotonic,
    wallClockNow: () => wall,
    holdMs: 100_000,
    budgetMs: 10_000_000,
    measurementCutoffSchedule: true,
    readDurableSnapshot: async () => {
      // EVERY durable read — the release-edge read, the settlement-arm reads,
      // the window-end refresh — shares ONE pending read that finishes 267 ms
      // past the planned endpoint (during the delayed final window chunk).
      if (refreshPending === null) {
        refreshPending = new Promise((resolve) => { resolveRefresh = resolve; });
      }
      return refreshPending;
    },
    releaseGate: async () => { releaseWallMs = wall; },
  });
  assert.ok(refreshSettledAtWallMs !== null, 'premise: the shared read completed during the delayed final window chunk');
  assert.ok(refreshSettledAtWallMs >= releaseWallMs + ENDPOINT_MONO_MS,
    `premise: the read\u2019s own completion instant is at/after the planned endpoint (wall ${String(refreshSettledAtWallMs)} vs endpoint ${String(releaseWallMs + ENDPOINT_MONO_MS)})`);
  assert.equal(held.budgetExpired, false);
  assert.equal(held.failure, undefined,
    `the natural-exit turn is never a failure (failure: ${String(held.failure?.message ?? 'none')})`);
  assert.equal(held.postRelease?.refreshedDurableRead, 'durable-read-pending-at-planned-observation-end',
    `the deadline-miss fact rides whenever the read's OWN completion instant is at/after the endpoint (postRelease: ${JSON.stringify(held.postRelease ?? null)}, snapshot: ${JSON.stringify(held.childSettlement?.durableSnapshot ?? null)})`);
  assert.equal(held.childSettlement?.durableSnapshot?.sampledAggregate, 'settled',
    'the post-endpoint completion still rides the fenced observation placeholder');
});

test('the release-edge read finishing after the planned endpoint keeps its deadline-miss fact even when the final window tick lands late', async () => {
  // Codex gate round-19 finding 2's release-edge repro (the reviewer's
  // synchronized-clock shape): the release-edge read completes 267 ms AFTER
  // the planned observation endpoint but BEFORE the early-read branch
  // resumes — event-loop work delays the final window tick — so
  // `state.settled` selected the preservation arm, whose own cutoff check
  // silently discarded the post-cutoff carrier WITHOUT recording
  // `postRelease.earlyDurableRead`. The branch must decide from the read's
  // OWN completion instant against the planned endpoint, exactly like the
  // round-18 refresh latch: an at/after-endpoint completion is a deadline
  // miss and keeps the named diagnostic.
  let monotonic = 0;
  let wall = 500_000;
  let releaseWallMs = null;
  let refreshPending = null;
  let resolveRefresh = null;
  let sharedReadSettledAtWallMs = null;
  let resolveRoot = null;
  // hold 100_000 + 10_000 + 5_000: the planned observation endpoint.
  const ENDPOINT_MONO_MS = 115_000;
  // The reviewer's number: the carrier completes 267 ms past the endpoint.
  const POST_ENDPOINT_COMPLETION_MS = 267;
  const identity = { pid: 66461, ppid: 136, nonce: 'a'.repeat(64), startIdentity: 'start-a' };
  const SUCCEEDED = { aggregate: 'settled', executorLinkage: 'verified', reasons: [], passive: { snapshotEqual: true }, job: { presence: 'found', projection: { id: 'job-1', status: 'succeeded' } } };
  // Synchronized fake clocks with the same faithful wrinkle as the round-18
  // repro: the final window chunk is DELAYED — the wall clock runs 267 ms
  // past the planned endpoint and the shared read finishes there, BEFORE
  // the tick lands.
  const fakeSleep = async (ms) => {
    if (releaseWallMs !== null && monotonic < ENDPOINT_MONO_MS && monotonic + ms >= ENDPOINT_MONO_MS) {
      wall = releaseWallMs + ENDPOINT_MONO_MS + POST_ENDPOINT_COMPLETION_MS;
      if (refreshPending !== null && resolveRefresh !== null) {
        const resolve = resolveRefresh;
        resolveRefresh = null;
        sharedReadSettledAtWallMs = wall;
        resolve(SUCCEEDED);
      }
      monotonic = ENDPOINT_MONO_MS;
      return;
    }
    monotonic += ms;
    wall += ms;
    if (releaseWallMs !== null && resolveRoot !== null && wall >= releaseWallMs + 1_000) {
      const resolve = resolveRoot;
      resolveRoot = null;
      resolve({ code: 0, stdout: 'sentinel', stderr: '' });
    }
  };
  const held = await pipeline.runHeldHostTurn({
    // Root returns promptly (inside the window), fake-clock driven.
    launch: async () => ({ result: new Promise((resolve) => { resolveRoot = resolve; }) }),
    waitForGate: async () => {},
    waitForObservation: async () => {},
    captureProcessIdentity: async () => identity,
    terminateProcessIdentity: async () => ({ attempted: true, signalled: 'SIGTERM', exited: true, failure: null }),
    readProcessIdentity: async () => identity,
    // The fixture exits NATURALLY inside the window (injected watcher): the
    // only window-end crossing is the observation window's delayed tick.
    waitForProcessExit: async () => {
      while (monotonic < 114_500) await fakeSleep(50);
    },
    sleep: fakeSleep,
    now: () => monotonic,
    wallClockNow: () => wall,
    holdMs: 100_000,
    budgetMs: 10_000_000,
    measurementCutoffSchedule: true,
    readDurableSnapshot: async () => {
      // EVERY durable read — the release-edge read, the settlement-arm
      // reads, the window-end refresh — shares ONE pending read that
      // finishes 267 ms past the planned endpoint.
      if (refreshPending === null) {
        refreshPending = new Promise((resolve) => { resolveRefresh = resolve; });
      }
      return refreshPending;
    },
    releaseGate: async () => { releaseWallMs = wall; },
  });
  assert.ok(sharedReadSettledAtWallMs !== null, 'premise: the shared read completed during the delayed final window chunk');
  assert.ok(sharedReadSettledAtWallMs >= releaseWallMs + ENDPOINT_MONO_MS,
    `premise: the carrier's own completion instant is at/after the planned endpoint (wall ${String(sharedReadSettledAtWallMs)} vs endpoint ${String(releaseWallMs + ENDPOINT_MONO_MS)})`);
  assert.equal(held.budgetExpired, false);
  assert.equal(held.failure, undefined,
    `the natural-exit turn is never a failure (failure: ${String(held.failure?.message ?? 'none')})`);
  assert.equal(held.postRelease?.earlyDurableRead, 'durable-read-pending-at-planned-observation-end',
    `the release-edge deadline miss is NAMED whenever the read's OWN completion instant is at/after the endpoint (postRelease: ${JSON.stringify(held.postRelease ?? null)})`);
});

test('a settlement-arm read finishing after the planned endpoint keeps its deadline-miss fact even when the final window tick lands late', async () => {
  // Codex gate round-19 finding 2's settlement-arm repro (the same
  // synchronized-clock shape): the settlement-arm read completes 267 ms
  // AFTER the planned observation endpoint but BEFORE its branch resumes —
  // `state.settled` selected the preservation arm, whose own cutoff check
  // silently discarded the post-cutoff carrier WITHOUT recording
  // `postRelease.settlementArmRead`. The branch must decide from the read's
  // OWN completion instant against the planned endpoint, exactly like the
  // round-18 refresh latch.
  let monotonic = 0;
  let wall = 500_000;
  let releaseWallMs = null;
  let refreshPending = null;
  let resolveRefresh = null;
  let sharedReadSettledAtWallMs = null;
  let resolveRoot = null;
  let settlementArmReads = 0;
  const ENDPOINT_MONO_MS = 115_000;
  const POST_ENDPOINT_COMPLETION_MS = 267;
  const identity = { pid: 66462, ppid: 137, nonce: 'a'.repeat(64), startIdentity: 'start-a' };
  const RUNNING = { aggregate: 'unresolved', executorLinkage: 'verified', reasons: [], passive: { snapshotEqual: true }, job: { presence: 'found', projection: { id: 'job-1', status: null } } };
  const SUCCEEDED = { aggregate: 'settled', executorLinkage: 'verified', reasons: [], passive: { snapshotEqual: true }, job: { presence: 'found', projection: { id: 'job-1', status: 'succeeded' } } };
  const fakeSleep = async (ms) => {
    if (releaseWallMs !== null && monotonic < ENDPOINT_MONO_MS && monotonic + ms >= ENDPOINT_MONO_MS) {
      wall = releaseWallMs + ENDPOINT_MONO_MS + POST_ENDPOINT_COMPLETION_MS;
      if (refreshPending !== null && resolveRefresh !== null) {
        const resolve = resolveRefresh;
        resolveRefresh = null;
        sharedReadSettledAtWallMs = wall;
        resolve(SUCCEEDED);
      }
      monotonic = ENDPOINT_MONO_MS;
      return;
    }
    monotonic += ms;
    wall += ms;
    if (releaseWallMs !== null && resolveRoot !== null && wall >= releaseWallMs + 1_000) {
      const resolve = resolveRoot;
      resolveRoot = null;
      resolve({ code: 0, stdout: 'sentinel', stderr: '' });
    }
  };
  const held = await pipeline.runHeldHostTurn({
    launch: async () => ({ result: new Promise((resolve) => { resolveRoot = resolve; }) }),
    waitForGate: async () => {},
    waitForObservation: async () => {},
    captureProcessIdentity: async () => identity,
    readProcessIdentity: async () => identity,
    waitForProcessExit: async () => {
      while (monotonic < 114_500) await fakeSleep(50);
    },
    sleep: fakeSleep,
    now: () => monotonic,
    wallClockNow: () => wall,
    holdMs: 100_000,
    budgetMs: 10_000_000,
    measurementCutoffSchedule: true,
    readDurableSnapshot: async () => {
      settlementArmReads += 1;
      // The RELEASE-EDGE read (call 1) settles promptly ON TIME — the main
      // flow must progress so the pre-cutoff settlement arm (created behind
      // it) starts its own reads INSIDE the window. The settlement-arm reads
      // and the window-end refresh (every later call) share ONE pending read
      // that finishes 267 ms past the planned endpoint — the arm's first
      // read (started right after the release) pends there until the
      // delayed crossing.
      if (settlementArmReads === 1) return RUNNING;
      if (refreshPending === null) {
        refreshPending = new Promise((resolve) => { resolveRefresh = resolve; });
      }
      return refreshPending;
    },
    releaseGate: async () => { releaseWallMs = wall; },
  });
  assert.ok(settlementArmReads >= 1, 'premise: the settlement arm started its read');
  assert.ok(sharedReadSettledAtWallMs !== null, 'premise: the shared read completed during the delayed final window chunk');
  assert.ok(sharedReadSettledAtWallMs >= releaseWallMs + ENDPOINT_MONO_MS,
    `premise: the carrier's own completion instant is at/after the planned endpoint (wall ${String(sharedReadSettledAtWallMs)} vs endpoint ${String(releaseWallMs + ENDPOINT_MONO_MS)})`);
  assert.equal(held.budgetExpired, false);
  assert.equal(held.failure, undefined,
    `the natural-exit turn is never a failure (failure: ${String(held.failure?.message ?? 'none')})`);
  assert.equal(held.postRelease?.settlementArmRead, 'durable-read-pending-at-planned-observation-end',
    `the settlement-arm deadline miss is NAMED whenever the read's OWN completion instant is at/after the endpoint (postRelease: ${JSON.stringify(held.postRelease ?? null)})`);
});

test('a Root result completing after the planned observation endpoint keeps the deadline-miss fact even when the final window tick lands late', async () => {
  // Codex gate round-20 finding 2's repro (the reviewer's synchronized-clock
  // shape): the Root result arrives at endpoint+267 ms (115267 against a
  // 115000 endpoint) while the final window tick is DELAYED — the result
  // wins the promise race and was accepted in-window WITHOUT the required
  // `postRelease.rootResult` deadline-miss diagnostic. The in-window
  // decision must read the result's OWN completion instant — stamped when
  // the promise settles, on the SAME wall clock the planned endpoint derives
  // from — exactly like the durable-read carriers' on-time predicate: race
  // order is never deadline evidence. The result's data still rides as an
  // observation; the diagnostic rides with it.
  let monotonic = 0;
  let wall = 500_000;
  let releaseWallMs = null;
  let refreshPending = null;
  let resolveRefresh = null;
  let rootResolvedAtWallMs = null;
  let resolveRoot = null;
  // hold 100_000 + 10_000 + 5_000: the planned observation endpoint.
  const ENDPOINT_MONO_MS = 115_000;
  // The reviewer's number: the result arrives 267 ms past the endpoint.
  const POST_ENDPOINT_ARRIVAL_MS = 267;
  const identity = { pid: 66471, ppid: 138, nonce: 'a'.repeat(64), startIdentity: 'start-a' };
  const SUCCEEDED = { aggregate: 'settled', executorLinkage: 'verified', reasons: [], passive: { snapshotEqual: true }, job: { presence: 'found', projection: { id: 'job-1', status: 'succeeded' } } };
  const fakeSleep = async (ms) => {
    if (releaseWallMs !== null && monotonic < ENDPOINT_MONO_MS && monotonic + ms >= ENDPOINT_MONO_MS) {
      wall = releaseWallMs + ENDPOINT_MONO_MS + POST_ENDPOINT_ARRIVAL_MS;
      if (refreshPending !== null && resolveRefresh !== null) {
        const resolve = resolveRefresh;
        resolveRefresh = null;
        resolve(SUCCEEDED);
      }
      if (resolveRoot !== null) {
        const resolve = resolveRoot;
        resolveRoot = null;
        rootResolvedAtWallMs = wall;
        resolve({ code: 0, stdout: 'sentinel', stderr: '' });
      }
      monotonic = ENDPOINT_MONO_MS;
      return;
    }
    monotonic += ms;
    wall += ms;
  };
  const held = await pipeline.runHeldHostTurn({
    // The Root result stays pending until the delayed final window chunk
    // resolves it 267 ms past the planned endpoint (before the tick lands).
    launch: async () => ({ result: new Promise((resolve) => { resolveRoot = resolve; }) }),
    waitForGate: async () => {},
    waitForObservation: async () => {},
    captureProcessIdentity: async () => identity,
    terminateProcessIdentity: async () => ({ attempted: true, signalled: 'SIGTERM', exited: true, failure: null }),
    readProcessIdentity: async () => identity,
    // The fixture exits NATURALLY inside the window (injected watcher).
    waitForProcessExit: async () => {
      while (monotonic < 114_500) await fakeSleep(50);
    },
    sleep: fakeSleep,
    now: () => monotonic,
    wallClockNow: () => wall,
    holdMs: 100_000,
    budgetMs: 10_000_000,
    measurementCutoffSchedule: true,
    readDurableSnapshot: async () => {
      // EVERY durable read shares ONE pending read that finishes at the
      // delayed crossing (post-endpoint — the round-18/19 facts ride too).
      if (refreshPending === null) {
        refreshPending = new Promise((resolve) => { resolveRefresh = resolve; });
      }
      return refreshPending;
    },
    releaseGate: async () => { releaseWallMs = wall; },
  });
  assert.ok(rootResolvedAtWallMs !== null, 'premise: the Root result resolved during the delayed final window chunk');
  assert.ok(rootResolvedAtWallMs >= releaseWallMs + ENDPOINT_MONO_MS,
    `premise: the result's own completion instant is at/after the planned endpoint (wall ${String(rootResolvedAtWallMs)} vs endpoint ${String(releaseWallMs + ENDPOINT_MONO_MS)})`);
  assert.equal(held.budgetExpired, false);
  assert.equal(held.failure, undefined,
    `the natural-exit turn is never a failure (failure: ${String(held.failure?.message ?? 'none')})`);
  assert.equal(held.postRelease?.rootResult, 'root-result-missing-at-planned-observation-end',
    `the Root-result deadline miss is NAMED whenever the result's own completion instant is at/after the endpoint (postRelease: ${JSON.stringify(held.postRelease ?? null)})`);
  assert.ok(held.result !== undefined, 'the late result data still rides as an observation');
});

let OBS_OFFSET = 0;
test('the reserved pull-in read proceeds when yielding to the sampler would leave it no completion window (the in-dead-zone success, 200-ms reads)', async (t) => {
  // Codex gate round-20 finding 1's OUTCOME contract (the reviewer's shape):
  // reads take 200 ms; the job succeeds INSIDE the final pre-cutoff stretch —
  // after the sampler's last completing read and before the cutoff, in the
  // dead zone only the reserved pull-in read can close — and the preserved
  // snapshot must carry that success with `terminalWinner` credited. The
  // fix protects the reserve's completion window: when the older claimant's
  // next legal slot is too close to the cutoff for the reserve to also fit
  // (the reviewer's normal-timer numbers: sampler/reserve starts at
  // release+9913/+9914 against a +10000 cutoff, both completions fenced,
  // the preserved snapshot left `running`), the reserve proceeds instead of
  // yielding. NOTE: on this machine's deterministic fake-clock schedule the
  // pre-fix fairness yield is itself shadowed by the round-13 protection
  // (the sampler's next legal slot falls at/after the cutoff under the
  // reviewer's drifted real-timer cadence, not under this aligned one), so
  // the test LOCKS the protected outcome; the yield-shape failure itself
  // reproduces only under the reviewer's drifted real-timer cadence
  // (documented in the report §24.11 amendment).
  let monotonic = 0;
  let wall = 500_000;
  let finishAtMs = null;
  const observationOffsetMs = OBS_OFFSET;
  void observationOffsetMs;
  let releaseWallMs = null;
  let resolveRootResult = null;
  const RUNNING = { aggregate: 'unresolved', executorLinkage: 'verified', reasons: [], passive: { snapshotEqual: true }, job: { presence: 'found', projection: { id: 'job-1', status: null } }, layers: { bindingCurrency: { state: 'current', anchorsJob: 'job-1' } } };
  const SUCCEEDED = { aggregate: 'settled', executorLinkage: 'verified', reasons: [], passive: { snapshotEqual: true }, job: { presence: 'found', projection: { id: 'job-1', status: 'succeeded' } }, layers: { bindingCurrency: { state: 'current', anchorsJob: 'job-1' } } };
  const fakeSleep = async (ms) => {
    monotonic += ms;
    wall += ms;
    if (resolveRootResult !== null && releaseWallMs !== null && wall >= releaseWallMs + 1_000) {
      const resolve = resolveRootResult;
      resolveRootResult = null;
      resolve({ code: 0, stdout: 'sentinel', stderr: '' });
    }
  };
  const held = await pipeline.runHeldHostTurn({
    launch: async () => ({ result: new Promise((resolve) => { resolveRootResult = resolve; }) }),
    waitForGate: async () => {},
    waitForObservation: async () => {},
    captureProcessIdentity: async () => ({ pid: 66481, ppid: 139, nonce: 'a'.repeat(64), startIdentity: 'start-a' }),
    readProcessIdentity: async () => undefined,
    waitForProcessExit: async () => {},
    sleep: fakeSleep,
    now: () => monotonic,
    wallClockNow: () => wall,
    holdMs: 420_000,
    budgetMs: 1_200_000,
    measurementCutoffSchedule: true,
    sampleDurableSnapshots: { intervalMs: 1_000 },
    readDurableSnapshot: async () => {
      // The reviewer's 200-ms reads — they CONSUME shared clock so the
      // completion instants (not just the starts) cross the cutoff.
      await fakeSleep(200);
      return finishAtMs !== null && wall >= finishAtMs ? SUCCEEDED : RUNNING;
    },
    releaseGate: async () => {
      // The lawful natural finish lands INSIDE the final pre-cutoff
      // stretch — after the sampler's last completing read (its `running`
      // observation) and before the cutoff: the dead zone only the
      // reserved read can close.
      finishAtMs = wall + 8_000;
      releaseWallMs = wall;
    },
  });
  assert.equal(held.budgetExpired, false);
  const preserved = /** @type {any} */ (held.childSettlement)?.preCutoffDurableSnapshot;
  assert.ok(preserved, 'a pre-cutoff authoritative snapshot survived');
  assert.equal(preserved.job?.projection?.status, 'succeeded',
    `the reserve completed strictly before the cutoff and captured the in-dead-zone success (preserved: ${JSON.stringify({ status: preserved.job?.projection?.status, rel: preserved.completedAtMs - releaseWallMs })})`);
  assert.ok(preserved.completedAtMs < held.cleanup.measurementCutoffAtMs,
    'the preserved read completed strictly before the armed cutoff');
  const facts = pipeline.mapShellWaitLiveFacts(
    { case: 'rescue-interrupt', pollMs: 3_600_000, waitPolicy: null, interruptBaselineSelector: null, survivalControlSelector: null },
    held, supportedEvidence(), null, null, mapperFixture, causalRollouts(), [], LAUNCHER,
  );
  const root = await mkdtemp(join(tmpdir(), 'shell-wait-native-interruption-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const persistFixture = { ...mapperFixture, dispose: async () => {} };
  await pipeline.runShellWaitCase(
    { case: 'rescue-interrupt', codexBinary: process.execPath, sourceSha: 'a'.repeat(40), workerDurationMs: 420_000, capMs: 3_600_000, pollMs: 3_600_000, budgetMs: 1_200_000, output: root },
    { createFixture: async () => persistFixture, executeLiveCase: async () => facts },
  );
  const recordName = (await readdir(root)).find((name) => name.endsWith('.record.json'));
  const reloaded = JSON.parse(await readFile(join(root, recordName), 'utf8'));
  const input = pipeline.nativeInterruptionGateDInput(reloaded);
  assert.equal(input.terminalWinner, 'succeeded',
    `the in-dead-zone pre-cutoff success is winner-credible through the reserve (terminalWinner: ${String(input.terminalWinner)})`);
});

test('a stalled injected exit watcher does not extend the turn past the planned observation endpoint (the losing-wait join is endpoint-bounded)', async () => {
  // Codex gate round-23 finding 2's repro: the injected exit watcher NEVER
  // settles; the termination cleanup completes at the planned observation
  // endpoint; the losing watcher's second join previously re-awaited it
  // against `budgetOutcome` — the MUCH LARGER experiment budget — so the
  // turn never returned under the injected clock. The losing watcher's
  // second join is bounded by the planned observation endpoint: the turn
  // returns at/near the planned endpoint even when the watcher never
  // settles.
  let monotonic = 0;
  let wall = 500_000;
  let releaseWallMs = null;
  let resolveRootResult = null;
  let terminateCalls = 0;
  const identity = { pid: 66491, ppid: 141, nonce: 'a'.repeat(64), startIdentity: 'start-a' };
  const fakeSleep = async (ms) => {
    monotonic += ms;
    wall += ms;
    if (resolveRootResult !== null && releaseWallMs !== null && wall >= releaseWallMs + 1_000) {
      const resolve = resolveRootResult;
      resolveRootResult = null;
      resolve({ code: 0, stdout: 'sentinel', stderr: '' });
    }
  };
  const held = await pipeline.runHeldHostTurn({
    // The Root result resolves promptly inside the window.
    launch: async () => ({ result: new Promise((resolve) => { resolveRootResult = resolve; }) }),
    waitForGate: async () => {},
    waitForObservation: async () => {},
    captureProcessIdentity: async () => identity,
    // The fixture stays ALIVE through the endpoint: the second join runs.
    readProcessIdentity: async () => (releaseWallMs !== null && monotonic < releaseWallMs + 15_000 ? identity : undefined),
    // The STALLED injected exit watcher: never settles.
    waitForProcessExit: async () => new Promise(() => {}),
    terminateProcessIdentity: async () => {
      terminateCalls += 1;
      return { attempted: true, signalled: 'SIGTERM', exited: true, failure: null };
    },
    sleep: fakeSleep,
    now: () => monotonic,
    wallClockNow: () => wall,
    holdMs: 100_000,
    budgetMs: 10_000_000,
    measurementCutoffSchedule: true,
    releaseGate: async () => { releaseWallMs = wall; },
  });
  assert.equal(held.budgetExpired, false);
  assert.equal(held.postRelease?.naturalExit, 'natural-exit-unobserved-at-planned-observation-end',
    `the planned-endpoint abandonment is named (postRelease: ${JSON.stringify(held.postRelease ?? null)})`);
  assert.ok(terminateCalls >= 1, 'the recorded termination cleanup ran');
});

test('the DEFAULT natural-exit watcher returning absence after the planned endpoint but before the delayed final window tick keeps the missing-exit fact on the successful done branch (the default-watcher late-winner repro)', async () => {
  // Codex gate round-23 finding: with the DEFAULT watcher (no injected
  // waitForProcessExit — the round-22 repro injected one, so its race resolved
  // `endpoint` and the successful `done` branch was never exercised), a
  // delayed final observation-window tick lets the in-flight identity
  // inspection return absence AFTER the planned endpoint (the reviewer's
  // reproduced ~390 ms post-endpoint) but BEFORE that tick — the exit race
  // resolves `done`, and the stamped `naturalExitCompletedAtWallMs` was
  // recorded but never compared with `plannedEndpointWallMs`, silently losing
  // the required `postRelease.naturalExit` deadline-miss fact. Race order is
  // never deadline evidence: the watcher's OWN completion instant must decide
  // on the SUCCESSFUL race branch exactly as on the endpoint branch.
  let monotonic = 0;
  let wall = 500_000;
  let releaseWallMs = null;
  let resolveRootResult = null;
  let absenceReturnedAtWallMs = null;
  let watcherSettledWhileTickHeld = null;
  let tickReleasedAtWallMs = null;
  let releaseHeldTick = null;
  const identity = { pid: 66492, ppid: 141, nonce: 'b'.repeat(64), startIdentity: 'start-b' };
  // Hold deadline at mono 100_000; the planned observation endpoint at mono
  // 115_000 (wall release reading + 15_000). Every identity inspection
  // consumes 390 ms of the saturated event loop; the fixture dies AT the
  // planned endpoint, so the inspection that starts at mono ≥ 114_610
  // (endpoint − 390) completes at mono 115_390 — endpoint+390, the reviewer's
  // reproduced shape — and returns the ABSENCE.
  const INSPECTION_MS = 390;
  const LATE_START_MONO = 114_610;
  const LATE_COMPLETION_MONO = 115_390;
  // The delayed tick: the window's final tick (due at mono 115_000) is held by
  // the same saturated event loop and lands at mono 115_500 — AFTER the
  // watcher settled at 115_390 — so the watcher wins its race as `done`.
  const DELAYED_TICK_MONO = 115_500;
  const advanceClock = (ms) => {
    monotonic += ms;
    wall += ms;
    if (resolveRootResult !== null && releaseWallMs !== null && wall >= releaseWallMs + 1_000) {
      const resolve = resolveRootResult;
      resolveRootResult = null;
      resolve({ code: 0, stdout: 'sentinel', stderr: '' });
    }
  };
  const held = await pipeline.runHeldHostTurn({
    // The Root result resolves promptly inside the window.
    launch: async () => ({ result: new Promise((resolve) => { resolveRootResult = resolve; }) }),
    waitForGate: async () => {},
    waitForObservation: async () => {},
    captureProcessIdentity: async () => identity,
    terminateProcessIdentity: async () => ({ attempted: true, signalled: 'SIGTERM', exited: true, failure: null }),
    // The identity inspections run 390 ms apiece on the shared clock: the
    // inspection in flight across the planned endpoint completes at
    // endpoint+390 and returns the ABSENCE (the fixture died at the endpoint)
    // — while the final window tick is still HELD, so the DEFAULT watcher's
    // settlement wins the exit race as `done` POST-ENDPOINT.
    readProcessIdentity: async () => {
      if (releaseWallMs !== null && monotonic >= LATE_START_MONO && monotonic < LATE_COMPLETION_MONO) {
        advanceClock(LATE_COMPLETION_MONO - monotonic);
        absenceReturnedAtWallMs = wall;
        watcherSettledWhileTickHeld = releaseHeldTick !== null;
        // The held tick releases on the macrotask turn AFTER the watcher's
        // settlement microtasks (and the driver's done-branch) ran.
        setTimeout(() => {
          if (releaseHeldTick !== null) {
            const release = releaseHeldTick;
            releaseHeldTick = null;
            release();
          }
        }, 0);
        return undefined;
      }
      advanceClock(INSPECTION_MS);
      if (releaseWallMs !== null && wall >= releaseWallMs + 15_000) return undefined;
      return identity;
    },
    // NO waitForProcessExit injection — the DEFAULT watcher runs (its poll
    // loop over readProcessIdentity, bound to the planned observation
    // endpoint). The observation window's final tick (a non-poll sleep once
    // the shared clock passes 113_000) is HELD — the saturated event loop —
    // and only releases after the watcher settled; the watcher's own poll
    // pauses are absorbed by that same saturation (they advance the clock at
    // most up to the late-inspection start).
    sleep: async (ms) => {
      if (releaseHeldTick === null && monotonic >= 113_000 && ms !== 50) {
        await new Promise((resolve) => {
          releaseHeldTick = () => {
            advanceClock(DELAYED_TICK_MONO - monotonic);
            tickReleasedAtWallMs = wall;
            resolve();
          };
        });
        return;
      }
      if (ms === 50 && releaseHeldTick !== null) {
        advanceClock(Math.max(0, Math.min(50, LATE_START_MONO - monotonic)));
        return;
      }
      advanceClock(ms);
    },
    now: () => monotonic,
    wallClockNow: () => wall,
    holdMs: 100_000,
    budgetMs: 10_000_000,
    measurementCutoffSchedule: true,
    releaseGate: async () => { releaseWallMs = wall; },
  });
  const plannedEndpointWallMs = (held.cleanup?.measurementCutoffAtMs ?? 0) + 5_000;
  assert.ok(absenceReturnedAtWallMs !== null, 'premise: the inspection returned absence');
  assert.ok(watcherSettledWhileTickHeld === true,
    'premise: the window tick was still HELD when the watcher settled — the DEFAULT watcher won its exit race as `done`');
  assert.ok(tickReleasedAtWallMs !== null && tickReleasedAtWallMs > absenceReturnedAtWallMs,
    `premise: the delayed final tick landed strictly after the watcher's settlement (tick ${String(tickReleasedAtWallMs)} vs absence ${String(absenceReturnedAtWallMs)})`);
  assert.ok(absenceReturnedAtWallMs >= plannedEndpointWallMs,
    `premise: the watcher's own completion instant (the stamp) landed at/after the planned observation endpoint (absence ${String(absenceReturnedAtWallMs)} vs endpoint ${String(plannedEndpointWallMs)})`);
  assert.equal(held.budgetExpired, false);
  assert.equal(held.postRelease?.naturalExit, 'natural-exit-unobserved-at-planned-observation-end',
    `the natural-exit missing-exit fact rides the SUCCESSFUL done branch whenever the watcher's own completion instant is at/after the endpoint (postRelease: ${JSON.stringify(held.postRelease ?? null)})`);
});
