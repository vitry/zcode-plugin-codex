#!/usr/bin/env node
// @ts-nocheck
/**
 * Real-process Rescue Child probe for the true-background handoff qualification.
 *
 * The probe is ONE real OS process that plays the Rescue Child role exactly as
 * the installed flow does: real SessionStart / UserPromptSubmit / SubagentStart
 * hook processes, the real `prepare rescue` planning step, and the real
 * `invoke-prepared rescue` reservation. For a background placement the probe
 * process itself becomes the detached runner's PARENT (the runner is spawned
 * from inside this process), so a test can terminate the probe and prove that
 * the runner survives and keeps publishing on its own.
 *
 * Handle protocol (single JSON file, atomically replaced on every update):
 *   { pid, workspace, runnerPid?, jobId?, spawnFailed?, type?, job?, result?,
 *     error?, done? }
 * The runner pid and job id are published SYNCHRONOUSLY inside the spawn
 * adapter seam (before the OS spawn event is awaited), so a test can observe
 * the child before the runner can possibly claim.
 *
 * Optional ack report (--ack-report <path>): the moment the prepared
 * invocation returns — before the SubagentStop coordination hook runs — the
 * parent's invocation receipt { pid, type, jobId, job } is published to this
 * second file. A test can therefore receive the real queued acknowledgement
 * from the live Rescue Child parent and only then terminate that parent for
 * real. The main report protocol is untouched.
 *
 * Optional pre-claim barrier (--barrier-lock <lock-dir> with
 * --barrier-release / --barrier-released <paths>): the probe acquires the
 * workspace job-state lock through the real spawn-adapter dependency seam,
 * strictly BEFORE the runner process exists, and holds the fence until the
 * test writes 'release' to the release path (the 'released' confirmation is
 * written after the lock is dropped). The freshly spawned runner therefore
 * cannot read or claim the job while the fence is held — the deterministic
 * pre-claim window the design's "no ordering without a test barrier" rule
 * requires. Spawn failures release the fence immediately.
 *
 * The probe never signals any process and never removes any directory: the
 * owning test captures every handle it needs from the report plus its own
 * spawn handle and performs all cleanup.
 */
import { spawn } from 'node:child_process';
import { readFileSync, renameSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import process from 'node:process';
import { Readable } from 'node:stream';

import { withFileLock } from '../../scripts/lib/fs.mjs';
import { spawnRescueRunner } from '../../scripts/lib/rescue-runner.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));

/** @returns {Record<string, string>} */
function parseArgs() {
  const parsed = {};
  for (let index = 2; index < process.argv.length; index += 2) {
    const key = process.argv[index];
    if (!key.startsWith('--')) throw new Error(`unexpected probe argument ${key}`);
    parsed[key.slice(2)] = process.argv[index + 1];
  }
  for (const required of ['workspace', 'session-id', 'child-id', 'turn-id', 'task', 'placement', 'resume', 'permission-mode', 'report']) {
    if (typeof parsed[required] !== 'string') throw new Error(`missing probe argument --${required}`);
  }
  return parsed;
}

const args = parseArgs();
const workspace = realpathSync.native(args.workspace);
// The recorded parent prompt must carry the real rescue marker so the explicit
// preparation source matches, exactly like the installed skill invocation.
const rescuePrompt = args.prompt ?? `$zcode:rescue ${args.placement === 'background' ? '--background' : '--wait'} ${args.resume === 'fresh' ? '--fresh' : '--resume'} ${args.task}`;
const reportPath = args.report;
const ackReportPath = args['ack-report'];
const report = { pid: process.pid, workspace };
const writeReport = () => {
  const temporary = `${reportPath}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(report));
  renameSync(temporary, reportPath);
};
/** Publish the prepared invocation's own receipt to the optional ack file. */
const writeAckReport = (invoked) => {
  if (typeof ackReportPath !== 'string') return;
  const temporary = `${ackReportPath}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify({
    pid: process.pid, type: invoked?.type,
    jobId: invoked?.job?.id ?? report.jobId, job: invoked?.job ?? null,
  }));
  renameSync(temporary, ackReportPath);
};

const hook = async (script, input) => {
  const child = spawn(process.execPath, [join(root, 'hooks', script)], {
    cwd: workspace, env: process.env, stdio: ['pipe', 'ignore', 'pipe'], shell: false,
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdin.end(JSON.stringify(input));
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  if (code !== 0) throw new Error(`probe hook ${script} exited ${code}: ${stderr.slice(0, 500)}`);
};

const main = async () => {
  const { runDirectInvocation } = await import(pathToFileURL(join(root, 'scripts', 'zcode-companion.mjs')));
  // 1. The real SessionStart hook proves the lifecycle epoch. Same-epoch
  // continuations skip it (a live session runs SessionStart once); a same-ID
  // resume after a real SessionEnd runs it with source 'resume', exactly like
  // the installed flow.
  if (args['session-source'] !== 'skip') {
    await hook('session-lifecycle-hook.mjs', {
      session_id: args['session-id'], cwd: workspace, hook_event_name: 'SessionStart',
      transcript_path: null, model: 'gpt', permission_mode: args['permission-mode'], source: args['session-source'] ?? 'startup',
    });
  }
  // 2. The real UserPromptSubmit hook establishes the active caller turn.
  await hook('user-prompt-hook.mjs', {
    session_id: args['session-id'], turn_id: args['turn-id'], cwd: workspace, hook_event_name: 'UserPromptSubmit',
    transcript_path: null, model: 'gpt', permission_mode: args['permission-mode'], prompt: rescuePrompt,
  });
  // 3. The real preparation planning step (task-free private preparation). A
  // fresh spawn plans from an unoccupied child namespace; a resume serves the
  // session's ENDED (notLoaded) Rescue Child spawn evidence so the planner can
  // select and reactivate the exact bound child, exactly like the real host.
  const rescueSpawnChild = {
    id: args['child-id'], parentThreadId: args['session-id'], agentRole: 'zcode-rescue', cwd: workspace,
    createdAt: 3, updatedAt: 4,
    status: args.resume === 'resume' ? { type: 'notLoaded' } : { type: 'active', activeFlags: [] },
    source: { subAgent: { thread_spawn: {
      parent_thread_id: args['session-id'], depth: 1, agent_path: '/root/zcode_rescue_task',
      agent_nickname: null, agent_role: 'zcode-rescue',
    } } },
  };
  const envelope = {
    version: 1, source: 'explicit', task: args.task,
    options: { execution: args.placement, resume: args.resume },
  };
  await runDirectInvocation(['prepare', 'rescue'], {
    cwd: workspace,
    env: {
      ...process.env, CODEX_THREAD_ID: args['session-id'],
      FAKE_CODEX_THREAD_SPAWN_GRAPH_JSON: JSON.stringify(args.resume === 'resume' ? [rescueSpawnChild] : []),
    },
    input: Readable.from([`${JSON.stringify(envelope)}\n`]),
  });
  // 4. A fresh spawn records the Rescue Child execution authority with the
  // real SubagentStart hook. A resume REACTIVATION has no new child process:
  // the invocation replays the durable stopped executor provenance instead.
  if (args.resume !== 'resume') {
    await hook('subagent-hook.mjs', {
      session_id: args['session-id'], turn_id: args['turn-id'], cwd: workspace, hook_event_name: 'SubagentStart',
      transcript_path: null, model: 'gpt', permission_mode: args['permission-mode'],
      agent_id: args['child-id'], agent_type: 'zcode-rescue',
    });
  }
  // 5. The real prepared reservation. For background placement the detached
  // runner is spawned from THIS process: the spawn seam is intercepted only to
  // publish the child handles; the real spawn call is otherwise untouched.
  const spawnChild = (command, commandArgs, options) => {
    const child = spawn(command, commandArgs, options);
    report.runnerPid = child.pid;
    report.jobId = typeof commandArgs[2] === 'string' ? commandArgs[2] : null;
    child.once('error', (error) => { report.spawnFailed = String(error); writeReport(); });
    writeReport();
    return child;
  };
  // The optional deterministic pre-claim barrier, armed through the same
  // production spawn-adapter seam: the job-state lock is acquired strictly
  // BEFORE the real spawn call, so the runner process cannot exist — and can
  // therefore never read or claim the job — while the fence is held.
  const spawnRunnerUnderBarrier = typeof args['barrier-lock'] !== 'string' ? undefined : async (input) => {
    let armBarrier; let failBarrier;
    const armed = new Promise((resolve, reject) => { armBarrier = resolve; failBarrier = reject; });
    const barrierState = () => { try { return readFileSync(args['barrier-release'], 'utf8'); } catch { return ''; } };
    const releaseBarrier = () => { try { writeFileSync(args['barrier-release'], 'release'); } catch { /* fixture directory already removed */ } };
    const held = withFileLock(args['barrier-lock'], async () => {
      armBarrier();
      while (barrierState().trim() !== 'release') await new Promise((resolve) => setTimeout(resolve, 10));
    });
    held.then(() => { try { writeFileSync(args['barrier-released'], 'released'); } catch { /* fixture directory already removed */ } })
      .catch((error) => failBarrier(error instanceof Error ? error : new Error(String(error))));
    await armed;
    try {
      return await spawnRescueRunner(input);
    } catch (error) {
      releaseBarrier();
      throw error;
    }
  };
  const invoked = await runDirectInvocation(['invoke-prepared', 'rescue'], {
    cwd: workspace,
    env: {
      ...process.env, CODEX_THREAD_ID: args['child-id'],
      FAKE_CODEX_THREAD_JSON: JSON.stringify(rescueSpawnChild),
    },
    dependencies: { spawnChild, ...(spawnRunnerUnderBarrier === undefined ? {} : { spawnRescueRunner: spawnRunnerUnderBarrier }) },
  });
  // The parent's real receipt of the invocation (for a background placement
  // the bounded queued acknowledgement) is published immediately — before the
  // SubagentStop coordination hook below — so a terminating test provably
  // receives it while this parent is still alive.
  writeAckReport(invoked);
  // 6. A fresh Rescue Child is finished after enqueue (or after the foreground
  // result): the Host fires the real SubagentStop, which records the child as
  // stopped — exactly the durable executor state a later reactivation plan
  // requires. For a background placement this is a coordination observation
  // only: the detached runner keeps executing independently.
  if (args.resume !== 'resume') {
    await hook('subagent-hook.mjs', {
      session_id: args['session-id'], turn_id: args['turn-id'], cwd: workspace, hook_event_name: 'SubagentStop',
      transcript_path: null, model: 'gpt', permission_mode: args['permission-mode'],
      agent_id: args['child-id'], agent_type: 'zcode-rescue', agent_transcript_path: null,
      stop_hook_active: false, last_assistant_message: null,
    });
  }
  report.type = invoked?.type;
  report.jobId = invoked?.job?.id ?? report.jobId;
  report.job = invoked?.job ?? null;
  report.result = typeof invoked?.result === 'string' ? invoked.result : undefined;
  report.done = true;
  writeReport();
};

main()
  .then(() => {
    writeReport();
    if (args.hold === 'true') setInterval(() => { /* hold: the test owns this parent's lifetime */ }, 1 << 30);
  })
  .catch((error) => {
    report.error = {
      code: typeof error?.code === 'string' ? error.code : 'PROBE_FAILED',
      message: String(error?.message ?? error).slice(0, 800),
      stack: String(error?.stack ?? '').split('\n').slice(0, 4).join(' | ').slice(0, 500),
      remedy: typeof error?.remedy === 'string' ? error.remedy.slice(0, 300) : undefined,
    };
    writeReport();
    process.exitCode = 1;
  });
