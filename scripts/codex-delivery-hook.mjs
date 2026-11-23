#!/usr/bin/env node
// Delivery guards for a Codex coordinator, as Codex hooks (UserPromptSubmit, PreToolUse on Bash, PostToolUse, Stop).
// Only the coordinator ever runs in Codex; implementers, QA and the relay are Pi sessions with their own guards
// (pi/extensions/delivery-guards.ts). The checks are shared: scripts/lib/delivery-checks.mjs.
//
// Active only in a Codex session enrolled in the stop gate (`codex-stop-gate.mjs enroll --as <actor> --record <file>`),
// which names the coordination record and the accountable actor; every other session gets no output.
//   UserPromptSubmit  the landing-map reminder, as context for the turn (your messages and delegates' handoffs)
//   PreToolUse        `gh pr merge` only in the plain form, on a merge-ready PR, rewritten to the checked PR and head
//   PostToolUse       when the coordination record has changed since this session last looked, its stalls
//   Stop              once per turn, a continuation when the reply calls a mapped PR merge-ready and the check disagrees
// Quiet delegates are the stop gate's job. Any error lets Codex continue normally, with a visible message.
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { gateHome } from './codex-stop-gate.mjs';
import { readRecord } from './lib/record-store.mjs';
import { claimCorrection, guardMerge, LANDING_MAP_REMINDER, parseMerge, stallFindings, stallReport } from './lib/delivery-checks.mjs';

const SESSION_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;

/** The stop gate's enrollment for this Codex session, or null when it has none. */
async function enrollment(session, env) {
  if (!SESSION_ID.test(session ?? '')) return null;
  try {
    const state = JSON.parse(await readFile(join(gateHome(env), 'sessions', `${session}.json`), 'utf8'));
    return typeof state.actor === 'string' && typeof state.record === 'string' ? { actor: state.actor, record: state.record } : null;
  } catch { return null; }
}

async function recordStamp(path) {
  try { const s = await stat(path); return `${s.ino}:${s.size}:${s.mtimeMs}`; } catch (error) { return error.code ?? '?'; }
}

/** The record state this session last reported stalls for, kept beside the stop gate's state. */
const stampFile = (session, env) => join(gateHome(env), 'sessions', `${session}.delivery.json`);
async function lastStamp(session, env) {
  try { return JSON.parse(await readFile(stampFile(session, env), 'utf8')).recordStamp ?? null; } catch { return null; }
}
async function saveStamp(session, env, value) {
  const path = stampFile(session, env);
  await mkdir(join(gateHome(env), 'sessions'), { recursive: true });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify({ recordStamp: value })}\n`);
  await rename(temp, path);
}

/** The hook's JSON reply for one event; {} means no change. */
export async function handle(input, env = process.env, options = {}) {
  const event = input.hook_event_name;
  const enrolled = await enrollment(input.session_id, env);
  if (!enrolled) return {};
  if (event === 'UserPromptSubmit') {
    // The first message after enrolling sets the baseline, so record changes later in the turn are reported.
    if (await lastStamp(input.session_id, env) === null) await saveStamp(input.session_id, env, await recordStamp(enrolled.record));
    return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: LANDING_MAP_REMINDER } };
  }
  if (event === 'PreToolUse') {
    const command = input.tool_input?.command;
    if (input.tool_name !== 'Bash' || typeof command !== 'string' || !parseMerge(command)) return {};
    let decision;
    try { decision = await guardMerge(await readRecord(enrolled.record), command, options); } catch (error) {
      decision = { block: `Blocked by the merge-readiness guard: the coordination record could not be read (${error.message}).` };
    }
    if (!decision) return {};
    if (decision.block) return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: decision.block.replace(/\.$/, '') } };
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { command: decision.command } } };
  }
  if (event === 'PostToolUse') {
    const now = await recordStamp(enrolled.record);
    const before = await lastStamp(input.session_id, env);
    if (now === before) return {};
    await saveStamp(input.session_id, env, now);
    if (before === null) return {};   // first look this session: a baseline, not a change
    const report = stallReport(stallFindings(await readRecord(enrolled.record), { actor: enrolled.actor }));
    return report ? { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: report } } : {};
  }
  if (event === 'Stop') {
    if (input.stop_hook_active || !input.last_assistant_message) return {};
    const correction = await claimCorrection(await readRecord(enrolled.record), input.last_assistant_message, options);
    return correction ? { decision: 'block', reason: correction } : {};
  }
  return {};
}

export async function runHook(text, env = process.env, options = {}) {
  let input;
  try { input = JSON.parse(text); } catch { return { systemMessage: 'delivery guards: unreadable hook input; skipped.' }; }
  try {
    return await handle(input, env, options);
  } catch (error) {
    return { systemMessage: `delivery guards error (${error.message}); skipped.` };
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  process.stdout.write(`${JSON.stringify(await runHook(text))}\n`);
}
