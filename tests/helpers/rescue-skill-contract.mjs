// @ts-nocheck
import assert from 'node:assert/strict';

export const expectedNamedRescueInstruction = 'When `prepared.route.action` is exactly `spawn` and the active `spawn_agent` tool schema exposes `agent_type`, prefer this exact named spawn with a fresh context:';
export const expectedNamedRescueMessage = 'Run the installed prepared ZCode Rescue forwarder now. Return its public stdout verbatim.';
export const expectedNamedRescueSpawn = [
  'spawn_agent({',
  '  task_name: prepared.route.taskName,',
  "  fork_turns: 'none',",
  "  agent_type: 'zcode-rescue',",
  `  message: '${expectedNamedRescueMessage}',`,
  '})',
].join('\n');
export const expectedGenericRescueInstruction = "For the generic route, substitute only the already-bound immutable `rescueLauncherCommand` for `<rescue-launcher-command>` in this fixed message, then call `spawn_agent` with `task_name: prepared.route.taskName`, `fork_turns: 'none'`, no `agent_type`, and exactly that message:";
export const expectedGenericRescueMessage = [
  'Act only as the installed ZCode Rescue forwarder. You are task-blind and capability-free. In the current workspace run exactly:',
  '<rescue-launcher-command> invoke-prepared rescue',
  'Preserve stderr and return public stdout verbatim. Do not inspect or modify code independently, interpret results, retry, cancel, choose a pending branch, or request/print/persist authorization material.',
  'The same exact prepared assignment is valid for either the initial turn or a stopped same-child prepared continuation selected by the parent. The one-command-per-turn rule applies to both. The assignment alone does not prove the sender or binding: run only its mapped companion command, which validates the exact executor and private binding before work starts.',
  'Within the same still-active parent turn, that parent may prepare exactly one proactive `resume` generation and follow up this same stopped child with the exact initial assignment. Each generation remains one-shot and the companion validates the required executor and exact bound ZCode session before work starts.',
  'Reject every non-exact assignment, arbitrary message, nested Rescue request, and independent repository work without running a command.',
  'Each exact assignment and child turn may start at most one mapped foreground `exec_command` companion process. Never start concurrent or retry foreground executions for the same assignment. Same-turn continuation calls only observe that turn\'s original running handle. The one expressly allowed status sidecar below is observational and does not replace that foreground process. A companion result containing an exit code is terminal. A result containing a running execution or session handle is nonterminal: poll only that same handle with the host continuation tool until it reports an exit code. Partial stdout, stderr, heartbeat text, or an outer code-cell completion is not terminal and must not be returned as final output. Relay text and status text are also nonterminal. A needs-choice response with exit code 3 is terminal for the current child turn. After that initial needs-choice terminal, the next exact parent continuation assignment may start one new exact `invoke-choice` foreground handle in the same child.',
  'For every result yielded by the original foreground handle, parse only complete dedicated `[zcode-relay]` lines. Before relay, require JSON with exact keys `version`, `sequence`, `phase`, `code`, and `observedAt`; require version 1, a positive bounded strictly increasing sequence, an allowlisted phase/code pair, and a valid bounded RFC3339 timestamp. Map only through this fixed allowlisted code-to-message map: `started` -> `ZCode Rescue started.`; `model-active` -> `ZCode is generating a response.`; `tool-active` -> `ZCode is working with a tool.`; `editing` -> `ZCode is applying workspace changes.`; `verifying` -> `ZCode is verifying the work.`; `waiting` -> `ZCode Rescue is still running.`; `finalizing` -> `ZCode Rescue is finalizing.`. Coalesce a repeated identical phase. If the native `send_message` tool is available, use `send_message` only to `/root` with the fixed mapped message. If it is unavailable or relay fails, continue polling the original handle. Relay is liveness only and never completion.',
  'Phase/code pairs are exactly `starting` / `started`, `running` / `model-active`, `investigating` / `tool-active`, `editing` / `editing`, `verifying` / `verifying`, `waiting` / `waiting`, and `finalizing` / `finalizing`.',
  'Never relay detailed `[zcode]` lines, arbitrary stderr, stdout, commands, paths, identifiers, content, results, or errors. Never invent a relay from a partial, malformed, unknown, stale, duplicate, or out-of-order record. After inspecting each yielded result and optionally relaying its valid complete records, continue only with same-handle `write_stdin` polling. A relay or its tool result never replaces a poll and never authorizes another Rescue invocation.',
  'While the original foreground handle is live and only between polls, accept exactly one of these exact trimmed no-argument user status intents: `zcode status`, `$zcode:status`, `/zcode:status`. For any of those spellings run the sidecar with no arguments using only this constant command:',
  '<rescue-launcher-command> invoke-status rescue',
  'Return its bounded status to that requesting child transcript, then resume polling the same original handle. Reject status arguments and every other spelling. Status is liveness only: it does not replace or complete the original handle, does not change terminal authority, and must never be returned as final output.',
  'If that command returned a needs-choice response, stop. Only after the parent sends exactly `Continue the pending ZCode Rescue with resume. Run only the installed resume forwarder command and return its public stdout verbatim.` run exactly:',
  '<rescue-launcher-command> invoke-choice rescue resume',
  'Only after the parent sends exactly `Continue the pending ZCode Rescue with fresh. Run only the installed fresh forwarder command and return its public stdout verbatim.` run exactly:',
  '<rescue-launcher-command> invoke-choice rescue fresh',
  'A project tool, test, build, lint, or other command failure reported while the ZCode turn remains active is not a Rescue failure. Do not hard-code project commands or parse their output to decide completion; keep polling the exact original handle. Only the original companion and ZCode terminal result is authoritative.',
  "Return only the original foreground execution's terminal public stdout. Never substitute relay output, status output, intermediate output, or child-authored text.",
].join('\n');

export function assertRescueLauncherGate(source, { assertionPrefix = '' } = {}) {
  const gate = source.indexOf('## Immutable Rescue launcher gate');
  const objective = source.indexOf('Invoke explicitly as');
  const routing = source.indexOf('## Single-hop Rescue routing');
  assert.ok(gate >= 0, `${assertionPrefix}immutable Rescue launcher gate must exist`);
  assert.ok(gate < objective && objective < routing, `${assertionPrefix}launcher gate must precede objective handling and routing`);
  const block = source.slice(gate, objective);
  assert.match(block, /trusted lifecycle additional-context descriptor/i);
  assert.match(block, /\[zcode-rescue-launcher\][^\n]+"version":1[^\n]+"launcherCommand":"node/i);
  assert.match(block, /bind `rescueLauncherCommand` exactly once/i);
  assert.match(block, /immutable/i);
  assert.match(block, /missing[\s\S]+ambiguous[\s\S]+malformed[\s\S]+terminal/i);
  assert.match(block, /\[zcode-rescue-launcher-error\][\s\S]+reinstall[\s\S]+terminal/i);
  assert.match(block, /launcher-error[\s\S]+(?:do not|never)[^\n]+\$zcode:setup[\s\S]+prepare[\s\S]+follow[ -]?up[\s\S]+spawn/i);
  assert.match(block, /(?:do not|never)[^\n]+companion[\s\S]+\$zcode:setup[\s\S]+prepare[\s\S]+follow[ -]?up[\s\S]+spawn/i);
  assert.match(block, /every[^\n]+Rescue command[^\n]+exact `rescueLauncherCommand` bytes[^\n]+fixed allowlisted arguments/i);
  assert.match(block, /never[^\n]+quote[^\n]+escape[^\n]+parse[^\n]+rebuild[^\n]+raw path/i);
  assert.match(block, /(?:do not|never)[^\n]+cwd[\s\S]+repository[\s\S]+Skill prose[\s\S]+plugin root/i);
  assert.match(block, /(?:do not|never)[^\n]+`scripts\/zcode-companion\.mjs`[\s\S]+PATH[\s\S]+global[\s\S]+cache/i);
  assert.match(block, /(?:do not|never)[^\n]+switch[^\n]+launcher[^\n]+diagnostic/i);
  return { gate, objective, routing, block };
}

const namedBoundary = '\nOnly after the preflight returned `ready`';
const genericBoundary = '\nKeep the returned child ID as `rescueChildId`';

function routeBlock(source, start, end, label) {
  assert.ok(start >= 0, `${label} route marker must exist`);
  assert.ok(end > start, `${label} route boundary must follow its marker`);
  const text = source.slice(start, end);
  const match = /^(?<instruction>[^\n]+):\n\n```text\n(?<body>[\s\S]*?)\n```(?<adjacency>\s*)$/.exec(text);
  assert.ok(match, `${label} route must be one instruction and one fenced block with whitespace-only adjacency`);
  const fenceStart = text.indexOf('\n```text\n') + '\n```text\n'.length;
  const fenceEnd = text.length - match.groups.adjacency.length - '\n```'.length;
  return {
    start,
    end,
    text,
    instruction: match.groups.instruction,
    body: {
      start: start + fenceStart,
      end: start + fenceEnd,
      text: match.groups.body,
    },
  };
}

export function assertRescueRouteContract(source, { assertionPrefix = '' } = {}) {
  const preflightStart = source.indexOf('role-status rescue');
  const preflightEnd = source.indexOf('then stop without spawning.', preflightStart);
  const namingStart = source.indexOf('Strictly parse the terminal prepared route object', preflightEnd);
  const namedRouteStart = source.indexOf('\nWhen `prepared.route.action` is exactly `spawn` and the active `spawn_agent` tool schema exposes `agent_type`', namingStart) + 1;
  const namedRouteEnd = source.indexOf(namedBoundary, namedRouteStart);

  assert.ok(preflightStart >= 0, `${assertionPrefix}Rescue preflight marker must exist`);
  assert.ok(preflightEnd > preflightStart, `${assertionPrefix}Rescue successful-preflight boundary must follow the preflight`);
  assert.ok(namingStart > preflightEnd, `${assertionPrefix}Rescue directive section must follow the successful preflight`);
  assert.ok(namedRouteStart > namingStart, `${assertionPrefix}Rescue named-route marker must follow the directive section`);

  const named = routeBlock(source, namedRouteStart, namedRouteEnd, `${assertionPrefix}named`);
  const genericRouteStartMarker = source.indexOf('\nFor the generic route,', namedRouteEnd);
  const genericRouteStart = genericRouteStartMarker < 0 ? -1 : genericRouteStartMarker + 1;
  const genericRouteEnd = source.indexOf(genericBoundary, genericRouteStart);
  assert.ok(genericRouteStart > namedRouteEnd, `${assertionPrefix}Rescue generic-route marker must follow the named route`);
  const generic = routeBlock(source, genericRouteStart, genericRouteEnd, `${assertionPrefix}generic`);

  assert.equal(named.instruction, expectedNamedRescueInstruction.slice(0, -1), `${assertionPrefix}named route must preserve its exact instruction`);
  assert.equal(named.body.text.match(/task_name:\s*prepared\.route\.taskName/g)?.length, 1, `${assertionPrefix}named spawn must use the exact prepared taskName once`);
  assert.equal(named.body.text, expectedNamedRescueSpawn, `${assertionPrefix}named spawn must preserve the exact dynamic Rescue object`);
  assert.equal(generic.instruction.match(/task_name:\s*prepared\.route\.taskName/g)?.length, 1, `${assertionPrefix}generic route must use the exact prepared taskName once`);
  assert.equal(generic.instruction, expectedGenericRescueInstruction.slice(0, -1), `${assertionPrefix}generic call sentence must preserve the exact dynamic Rescue arguments`);
  assert.equal(generic.body.text, expectedGenericRescueMessage, `${assertionPrefix}generic child message must remain fixed`);
  assert.doesNotMatch(source, /task_name:\s*['"]zcode_rescue['"]/);

  return {
    naming: { start: namingStart, end: namedRouteStart, text: source.slice(namingStart, namedRouteStart) },
    namedInstruction: named.instruction,
    namedSpawn: named.body,
    genericInstruction: { start: generic.start, end: generic.start + generic.instruction.length, text: generic.instruction },
    genericMessage: generic.body,
  };
}

export function assertExactChildContinuationContract(source, { assertionPrefix = '' } = {}) {
  const active = source.indexOf('Active exact child');
  const stopped = source.indexOf('Stopped exact same-operation child');
  const fresh = source.indexOf('Fresh or independent operation');
  assert.ok(active >= 0 && stopped > active && fresh > stopped, `${assertionPrefix}Rescue child-state precedence must be explicit and ordered`);
  const end = source.indexOf('\n## Entry classification', fresh);
  assert.ok(end > fresh, `${assertionPrefix}Rescue child-state block must precede entry classification`);
  const block = source.slice(active, end);
  const activeBlock = source.slice(active, stopped);
  assert.match(activeBlock, /Active exact child[\s\S]+(?:rejoin|wait|poll)[\s\S]+existing live handle/i);
  assert.match(activeBlock, /Never call `followup_task`/i);
  assert.doesNotMatch(activeBlock, /followup_task\s*\(/i);
  assert.match(activeBlock, /(?:zero|no|must not|never)[^\n]*(?:preflight|prepare|spawn|invoke)/i);
  assert.match(block, /Stopped exact same-operation child[\s\S]+companion[\s\S]+prepared route[\s\S]+exact persisted child/i);
  assert.match(block, /Fresh or independent operation[\s\S]+`fresh`[\s\S]+new Rescue child/i);
  assert.match(block, /Root[^\n]+owns[^\n]+semantic choice/i);
  assert.match(source, /followup_task\(\{\s*target:\s*prepared\.route\.target,\s*message:\s*expectedPreparedContinuationMessage,?\s*\}\)/s);
  assert.match(source, /Preparation authorizes exactly one host action[^\n]+never both/i);
  assert.match(source, /must not[^\n]+collision[^\n]+fallback/i);
  assert.doesNotMatch(source, /Root chooses[^\n]+rescueTaskName/i);
  assert.doesNotMatch(source, /Preparation authorizes exactly one (?:named or generic )?spawn\./i);
  assert.doesNotMatch(source, /explicit continuation[^.\n]*proceeds through prepare and spawn\./i);
  assert.doesNotMatch(source, /preparation (?:succeeds|success)[^\n]{0,180}(?:always|must)[^\n]{0,80}spawn/i);
  return { active, stopped, fresh, block };
}
