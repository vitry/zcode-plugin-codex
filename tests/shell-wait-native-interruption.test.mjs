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
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
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

test('the relocated causal contract is versioned: join v3 and oracle v4 over the unchanged family stamp', async () => {
  const { NATIVE_INTERRUPTION_GATE_D_JOIN_VERSION } = await import('../tools/shell-wait-probe/driver.mjs');
  const { NATIVE_INTERRUPTION_ORACLE_VERSION, RELEASE_QUALIFICATION_VERSION } = await import('../tools/shell-wait-probe/release-qualification.mjs');
  assert.equal(NATIVE_INTERRUPTION_GATE_D_JOIN_VERSION, 3, 'join v3: the delivery block carries the typed acknowledgementAtResolution fact (§24.4)');
  assert.equal(NATIVE_INTERRUPTION_ORACLE_VERSION, 4, 'oracle v4: the §24.4 relocated window contract (the falsification replay marks every v4 adjudication)');
  assert.equal(RELEASE_QUALIFICATION_VERSION, 1, 'the shared exact-terminal/layer family stamp stays unchanged');
  // No new helper module was introduced by Task 2: the relocation lives in
  // evidence.mjs, whose module-init bytes are ALREADY an observer-provenance
  // digest input, so the digest moves with these bytes without any
  // digest-input growth (the plan's helper rule: no helper merely to satisfy
  // the file list).
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
