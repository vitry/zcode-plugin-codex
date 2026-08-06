#!/usr/bin/env node
// @ts-nocheck
import process from 'node:process';
import { createIdentityStore } from '../scripts/lib/identity.mjs';
import { ownerIdForSession } from '../scripts/lib/job-control.mjs';
import { releaseManagedZCodeOwner } from '../scripts/lib/zcode-client.mjs';
import { cleanupSession } from './lib/hook-state.mjs';
import { readHookInput } from './lib/hook-input.mjs';

try { const input = await readHookInput('SessionEnd'); const dataRoot = process.env.PLUGIN_DATA; if (!dataRoot) throw new Error('PLUGIN_DATA required'); await Promise.allSettled([releaseManagedZCodeOwner({ dataRoot, workspace: input.cwd, ownerId: ownerIdForSession(input.session_id), requestTimeoutMs: 750 }), cleanupSession(dataRoot, input.cwd, input.session_id), createIdentityStore({ dataRoot }).cleanupSession(input.cwd, input.session_id)]); }
catch (error) { process.stderr.write(`ZCode session cleanup advisory failed: ${error?.code ?? 'HOOK_FAILED'}\n`); process.exitCode = 1; }
