#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { isAbsolute, normalize, resolve } from 'node:path';

import { createStateStore } from '../scripts/lib/state.mjs';

const VALUE_FLAGS = new Map([
  ['--data-root', 'dataRoot'],
  ['--workspace', 'workspace'],
  ['--parent-session-id', 'parentSessionId'],
  ['--child-agent-id', 'childAgentId'],
  ['--child-agent-path', 'childAgentPath'],
  ['--binding-key', 'bindingKey'],
  ['--operation-id', 'operationId'],
  ['--anchor-job-id', 'anchorJobId'],
  ['--failed-current-job-id', 'failedCurrentJobId'],
  ['--expected-binding-updated-at', 'expectedBindingUpdatedAt'],
]);

/** @typedef {{dataRoot:string,workspace:string,parentSessionId:string,childAgentId:string,childAgentPath:string,bindingKey:string,operationId:string,anchorJobId:string,failedCurrentJobId:string,expectedBindingUpdatedAt:string,apply:boolean}} RepairCliArguments */

/** @param {string[]} argv @returns {RepairCliArguments} */
function parseRepairArguments(argv) {
  const parsed = /** @type {Record<string,string>} */ ({}); let apply = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--apply') {
      if (apply) throw new Error('invalid');
      apply = true; continue;
    }
    const field = VALUE_FLAGS.get(flag); const value = argv[index + 1];
    if (!field || Object.hasOwn(parsed, field) || typeof value !== 'string' || value.length === 0
      || value.startsWith('--')) throw new Error('invalid');
    parsed[field] = value; index += 1;
  }
  if (Object.keys(parsed).length !== VALUE_FLAGS.size
    || !isAbsolute(parsed.dataRoot) || normalize(parsed.dataRoot) !== parsed.dataRoot
    || !isAbsolute(parsed.workspace) || normalize(parsed.workspace) !== parsed.workspace) throw new Error('invalid');
  return /** @type {RepairCliArguments} */ ({ ...parsed, apply });
}

/** @param {string[]} argv @param {{stdout?:(text:string)=>void,stderr?:(text:string)=>void}} [io] */
export async function runRepairRescueContinuationBindingCli(argv, io = {}) {
  const stdout = io.stdout ?? ((text) => process.stdout.write(text));
  const stderr = io.stderr ?? ((text) => process.stderr.write(text));
  try {
    const { dataRoot, apply, ...input } = parseRepairArguments(argv);
    const result = await createStateStore({ dataRoot }).repairRescueContinuationBinding({
      ...input, ...(apply ? { apply: true } : {}),
    });
    stdout(`${JSON.stringify(result)}\n`); return 0;
  } catch {
    stderr(`${JSON.stringify({ code: 'RESCUE_BINDING_REPAIR_INVALID',
      message: 'The requested Rescue binding repair is not safe to apply.' })}\n`);
    return 1;
  }
}

const isEntrypoint = process.argv[1]
  && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isEntrypoint) process.exitCode = await runRepairRescueContinuationBindingCli(process.argv.slice(2));
