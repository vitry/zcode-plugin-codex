#!/usr/bin/env node
// @ts-nocheck
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { resolvePluginDataRoot } from '../scripts/lib/plugin-data.mjs';
import { createIdentityStore } from '../scripts/lib/identity.mjs';
import { createHostLifecycleStore } from '../scripts/lib/host-lifecycle.mjs';
import { settleEndedRescueJob } from '../scripts/lib/recovery.mjs';
import { resolveStoppedRescueChild } from '../scripts/lib/rescue-route-planner.mjs';
import { createStateStore } from '../scripts/lib/state.mjs';
import { createExistingManagedZCodeClient } from '../scripts/lib/zcode-client.mjs';
import { readHookInput } from './lib/hook-input.mjs';
import { markForwarding, resolveRoutedStoppedForwardingExecutor } from './lib/hook-state.mjs';

// The SubagentStop coordination-loss settlement mirrors the SessionEnd hook's
// stage shapes: one shared deadline slicing every stage budget, an
// existing-broker-only client (a never-lazily-spawned process), and a zero-wait
// job-state lock budget. The whole stage is strictly advisory: any failure or
// elapsed deadline defers to the durable SessionEnd receipt and the pending
// parent turn — it is written to stderr and never fails the hook.
const coordinationLossBudgetMs = 1_500;
const existingBrokerRequestTimeoutMs = process.platform === 'win32' ? 500 : 250;
// The coordination-loss settlement only ever applies to the role gate's
// approved Rescue executor types; every other SubagentStop is a quiet no-op.
const settlementAgentTypes = new Set(['zcode-rescue', 'default']);

// One derived window per stage from the single shared deadline: a positive
// remainder bounds the stage with an absolute-deadline signal and an integer
// lock budget, while an elapsed deadline yields NO window at all so the stage
// defers instead of manufacturing fresh time past the Host's native budget.
function stageWindow(deadline) {
  const remaining = deadline - Date.now();
  return remaining > 0 ? { signal: AbortSignal.timeout(remaining), timeoutMs: Math.floor(remaining) } : null;
}

/**
 * The elapsed-deadline deferral contract: one advisory stderr notice (never a
 * hook failure) leaves the remaining lifecycle work to the durable SessionEnd
 * receipt and the pending parent turn's reconciliation.
 * @returns {void}
 */
function deferStoppedRescueSettlement() {
  process.stderr.write('ZCode SubagentStop rescue settlement deferred: DEADLINE_ELAPSED\n');
}

// The hook flow runs only when the file is invoked directly as a script; the
// module stays importable so the settlement boundary is regression-testable.
const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) try {
  const input = await readHookInput(['SubagentStart', 'SubagentStop']); const rawEvent = input.hook_event_name; const dataRoot = resolvePluginDataRoot({ env: process.env, pluginRoot: resolve(fileURLToPath(new URL('../', import.meta.url))) }); const parentCaller = rawEvent === 'SubagentStart' ? await createIdentityStore({ dataRoot }).resolveActiveTurn({ sessionId: input.session_id, workspace: input.cwd, workspaceBinding: 'execution' }) : undefined;
  // The forwarding publication shares the coordination-loss deadline so its
  // contended hook-state lock waits can never run to the five-second default
  // and push the native hook past its own budget: SubagentStart bounds the
  // publication with the same budget; SubagentStop gives the settlement stage
  // whatever remains of the one shared deadline after the route write.
  const deadline = Date.now() + coordinationLossBudgetMs;
  // A clock that somehow jumped past the deadline before publication gets an
  // already-aborted window (fail bounded immediately), never fresh time.
  await markForwarding(dataRoot, input, parentCaller, stageWindow(deadline) ?? { signal: AbortSignal.abort(), timeoutMs: 0 });
  if (rawEvent === 'SubagentStop' && settlementAgentTypes.has(input.agent_type)) await settleStoppedRescueChild({ dataRoot, input, deadline }); process.stdout.write(rawEvent === 'SubagentStart' ? JSON.stringify({ hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: 'This is a forwarding subagent. Do not run the parent Stop review gate or mint a parent caller capability.' } }) : '{}');
}
catch (error) { process.stderr.write(`ZCode subagent hook failed safely: ${error?.code ?? 'HOOK_FAILED'}\n`); process.exitCode = 1; }

/**
 * Settle the exact Host-owned writable Rescue job one stopped Rescue child owns.
 * The stopped child's route proves its execution workspace, and its agent ID is
 * cross-checked against the parent's durable binding partition, so a sibling
 * child's stop can never inherit the one live run. Receipt evidence for the
 * job's own lifecycle epoch selects the reconciler's cause: a matching receipt
 * always stops for session-end (background placement included); without one,
 * only a foreground placement carries Host Coordination Loss authority, and a
 * live-session background Rescue is merely observed. Every stage shares the
 * single advisory deadline (the forwarding publication's budget included);
 * uncertainty keeps the durable record and the writable guard — never a
 * claimed stopped terminal.
 * @param {{dataRoot:string,input:any,deadline?:number}} arguments0
 * @returns {Promise<void>}
 */
export async function settleStoppedRescueChild({ dataRoot, input, deadline = Date.now() + coordinationLossBudgetMs }) {
  try {
    // Every stage draws ONLY what remains of the single shared deadline (the
    // forwarding publication's spend included): once that deadline has elapsed
    // the settlement defers — no stage starts, no fresh window is manufactured
    // — so receipt reads, state mutations, and broker setup never continue
    // past the Host's native hook budget.
    let stage = stageWindow(deadline);
    if (stage === null) return deferStoppedRescueSettlement();
    // The lookup's contended hook-state lock waits inherit the same shared
    // deadline so neither the executor-probe nor the route-validation lock can
    // run to the five-second default and outlive the Host's native hook budget.
    const stopped = await resolveRoutedStoppedForwardingExecutor(dataRoot, input.cwd, input.agent_id, stage);
    stage = stageWindow(deadline);
    if (stage === null) return deferStoppedRescueSettlement();
    const job = await resolveStoppedRescueChild({
      childAgentId: input.agent_id, dataRoot,
      parentSessionId: input.session_id, workspace: stopped.executionWorkspace,
      signal: stage.signal, timeoutMs: stage.timeoutMs,
    });
    if (!job) return;
    stage = stageWindow(deadline);
    if (stage === null) return deferStoppedRescueSettlement();
    // Existence of the epoch-keyed receipt IS the matching proof; an absent or
    // unreadable receipt grants no session-end authority (fail-safe to 'older').
    const receipt = await createHostLifecycleStore({ dataRoot }).readReceipt(job.ownerLifecycleEpoch).catch(() => null);
    stage = stageWindow(deadline);
    if (stage === null) return deferStoppedRescueSettlement();
    const intent = receipt === null && job.hostPlacement === 'foreground'
      ? { kind: 'stop', cause: 'host-coordination-loss' }
      : { kind: 'observe' };
    await settleEndedRescueJob({
      store: createStateStore({ dataRoot }), dataRoot, workspace: stopped.executionWorkspace,
      ownerSessionId: input.session_id, epoch: job.ownerLifecycleEpoch,
      lockTimeoutMs: 0, requestTimeoutMs: existingBrokerRequestTimeoutMs,
      timeoutMs: stage.timeoutMs, signal: stage.signal,
      includeSettlementEvidence: true, intent,
      // Unconfirmed control never proves the remote turn ended: retain the
      // durable cancelling guard instead of archiving the accepted job.
      unavailableOutcome: 'retain',
      // A matching receipt published between the initial evidence read and the
      // persist must win the cause, so the later SessionEnd reconciliation owns
      // its own boundary instead of inheriting coordination loss.
      revalidateReceiptBeforeStop: true,
      sessionEndReceiptEvidence: receipt ? 'matching' : 'older',
      createClient: (/** @type {any} */ owned, ownerId) => createExistingManagedZCodeClient({ dataRoot, workspace: stopped.executionWorkspace, ownerId, requestTimeoutMs: existingBrokerRequestTimeoutMs }),
    }, job.id);
  } catch (error) {
    process.stderr.write(`ZCode SubagentStop rescue settlement deferred: ${error?.code ?? 'HOOK_FAILED'}\n`);
  }
}
