// @ts-nocheck
import assert from 'node:assert/strict';

export const expectedNamedRescueInstruction = 'When the active `spawn_agent` tool schema exposes `agent_type`, prefer this exact named spawn with a fresh context:';
export const expectedNamedRescueMessage = 'Run the installed ZCode Rescue forwarder now. Return its public stdout verbatim.';
export const expectedNamedRescueSpawn = [
  'spawn_agent({',
  '  task_name: rescueTaskName,',
  "  fork_turns: 'none',",
  "  agent_type: 'zcode-rescue',",
  `  message: '${expectedNamedRescueMessage}',`,
  '})',
].join('\n');
export const expectedGenericRescueInstruction = "For the generic route, substitute only the preflight-verified absolute canonical plugin root in this fixed message, then call `spawn_agent` with `task_name: rescueTaskName`, `fork_turns: 'none'`, no `agent_type`, and exactly that message:";
export const expectedGenericRescueMessage = [
  'Act only as the installed ZCode Rescue forwarder. In the current workspace run exactly:',
  'node "<canonical-plugin-root>/scripts/zcode-companion.mjs" invoke rescue',
  'Preserve stderr and return public stdout verbatim. Do not inspect or modify code independently, interpret results, retry, cancel, choose a pending branch, or request/print/persist authorization material.',
  'Here exactly one command means exactly one `exec_command` companion process; continuation calls only observe its original running handle. Never start a second `exec_command`. A companion result containing an exit code is terminal. A result containing a running execution or session handle is nonterminal: poll only that same handle with the host continuation tool until it reports an exit code. Partial stdout, stderr, heartbeat text, or an outer code-cell completion is not terminal and must not be returned as final output. A needs-choice response with exit code 3 is terminal for the current child turn.',
  'If that command returned a needs-choice response, stop. Only after the parent sends exactly `Continue the pending ZCode Rescue with resume. Run only the installed resume forwarder command and return its public stdout verbatim.` run exactly:',
  'node "<canonical-plugin-root>/scripts/zcode-companion.mjs" invoke-choice rescue resume',
  'Only after the parent sends exactly `Continue the pending ZCode Rescue with fresh. Run only the installed fresh forwarder command and return its public stdout verbatim.` run exactly:',
  'node "<canonical-plugin-root>/scripts/zcode-companion.mjs" invoke-choice rescue fresh',
].join('\n');

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
  const namingStart = source.indexOf('After the readiness preflight succeeds and before route selection or any spawn', preflightEnd);
  const namedRouteStart = source.indexOf('\nWhen the active `spawn_agent` tool schema exposes `agent_type`', namingStart) + 1;
  const namedRouteEnd = source.indexOf(namedBoundary, namedRouteStart);

  assert.ok(preflightStart >= 0, `${assertionPrefix}Rescue preflight marker must exist`);
  assert.ok(preflightEnd > preflightStart, `${assertionPrefix}Rescue successful-preflight boundary must follow the preflight`);
  assert.ok(namingStart > preflightEnd, `${assertionPrefix}Rescue naming section must follow the successful preflight`);
  assert.ok(namedRouteStart > namingStart, `${assertionPrefix}Rescue named-route marker must follow the naming section`);

  const named = routeBlock(source, namedRouteStart, namedRouteEnd, `${assertionPrefix}named`);
  const genericRouteStartMarker = source.indexOf('\nFor the generic route,', namedRouteEnd);
  const genericRouteStart = genericRouteStartMarker < 0 ? -1 : genericRouteStartMarker + 1;
  const genericRouteEnd = source.indexOf(genericBoundary, genericRouteStart);
  assert.ok(genericRouteStart > namedRouteEnd, `${assertionPrefix}Rescue generic-route marker must follow the named route`);
  const generic = routeBlock(source, genericRouteStart, genericRouteEnd, `${assertionPrefix}generic`);

  assert.equal(named.instruction, expectedNamedRescueInstruction.slice(0, -1), `${assertionPrefix}named route must preserve its exact instruction`);
  assert.equal(named.body.text.match(/task_name:\s*rescueTaskName/g)?.length, 1, `${assertionPrefix}named spawn must use rescueTaskName exactly once`);
  assert.equal(named.body.text, expectedNamedRescueSpawn, `${assertionPrefix}named spawn must preserve the exact dynamic Rescue object`);
  assert.equal(generic.instruction.match(/task_name:\s*rescueTaskName/g)?.length, 1, `${assertionPrefix}generic route must use rescueTaskName exactly once`);
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
