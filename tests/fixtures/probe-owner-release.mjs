// @ts-nocheck
import { createStateStore } from '../../scripts/lib/state.mjs';
import { releaseManagedZCodeOwner } from '../../scripts/lib/zcode-client.mjs';

let contents = '';
for await (const chunk of process.stdin) contents += chunk;
const input = JSON.parse(contents);
const ownerId = input.ownerId;
let ownedJobs;
try { ownedJobs = { count: (await createStateStore({ dataRoot: input.dataRoot }).listOwnedJobs(input.workspace, input.ownerSessionId)).length }; }
catch (error) { ownedJobs = { error: { code: error?.code ?? null, category: error?.category ?? null, details: error?.details ?? null } }; }
let release;
try { release = { result: await releaseManagedZCodeOwner({ dataRoot: input.dataRoot, workspace: input.workspace, ownerId, requestTimeoutMs: 1_000, cleanupBudgetMs: 1_750 }) }; }
catch (error) { release = { error: { code: error?.code ?? null, category: error?.category ?? null, details: error?.details ?? null, causeCode: error?.cause?.code ?? null } }; }
process.stdout.write(JSON.stringify({ ownedJobs, release }));
