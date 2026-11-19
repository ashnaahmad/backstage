#!/usr/bin/env node
// Codex Stop gate: keeps an enrolled Codex orchestrator from ending its turn while follow-through on a delegated
// assignment is due or still pending, and otherwise stays out of the way.
//
// Opt-in is explicit and per session: a Codex session runs `enroll --as <actor>` (its id comes from CODEX_THREAD_ID,
// which Codex sets for its shell commands and which equals the hook's session_id), declaring which coordination-record
// actor it represents. After sending work to an assignment's implementer it arms a `watch`, which is accepted only
// while that actor is the assignment's accountable. On Stop, each awaiting watch is checked against the record and
// session-snapshot (the delegate's state):
//   - delegate replied, was interrupted or errored: follow-through is due; continue the turn to read it and record
//     the outcome (settle, re-arm, block or schedule);
//   - delegate still working: continue with one bounded blocking `wait`, not repeated turns;
//   - sent message not visible, or state unknown: continue once to investigate;
//   - this session's actor is no longer accountable, or the implementer changed: the watch is stale and never blocks.
// Watches marked blocked, or scheduled (an attestation, with a reference file read and hashed when recorded, that a
// named owner already arranged to check at a future time; the gate does not verify that scheduler), let the turn end.
// Once the scheduled time has passed without an outcome, the next Stop reconsiders follow-through here. Unenrolled sessions, a held lock and any error
// inside the gate let the turn end.
//
// Pausing has one rule: an unacknowledged pause marker pauses the whole gate. The Interrupt hook and `pause` both write
// one (append-only, no lock, so within Interrupt's 1-3 s limit); `resume` removes only the markers it has read, so a
// pause is never lost. Stop decides once, with ownership and pauses read after observing the delegate. That narrows,
// but cannot close, the interval before Codex acts on a returned continuation; what Codex does with an interrupted turn
// is Codex behaviour (native checks: an interrupt arriving while the Stop hook runs stops that hook run).
//
// Bounding has one rule: a continuation is credited only when the agent acted on it, by recording an outcome or by a
// `wait` that started on pending work and then either observed it finish (a DUE verdict) or waited the full configured
// period with the delegate still observed busy at the end. A failed observation earns nothing. Replaying `watch` on an
// active (awaiting) watch with the same --since keeps its counts; re-arming one that is needs-attention, blocked,
// scheduled or stale is the explicit recovery and starts afresh.
// After maxUnacted consecutive uncredited continuations the watch becomes needs-attention: Stop no longer continues for
// it and warns visibly at every turn end until it is re-armed or settled. A slow delegate can be waited on indefinitely.
//
// State changes take the per-session lock from scripts/lib/record-store.mjs (never reclaimed automatically; `unlock`).
// State: CODEX_STOP_GATE_HOME, else $XDG_STATE_HOME/harness/codex-stop-gate, else ~/.local/state/harness/codex-stop-gate.
// Run without arguments for usage.
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireLock, canonicalRecordPath, readRecord, RecordError, releaseLock, unlock } from './lib/record-store.mjs';
import { snapshotFor } from './session-snapshot.mjs';

const SCRIPT = fileURLToPath(import.meta.url);
const SNAPSHOT_SCRIPT = join(SCRIPT, '..', 'session-snapshot.mjs');
// Codex ids are lowercase UUIDs. Lowercase only, so a case-insensitive filesystem cannot alias two sessions.
const SESSION_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const ASSIGNMENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
export const DEFAULT_MAX_UNACTED = 3;
export const DEFAULT_WAIT_SECONDS = 300;
const MAX_WAIT_SECONDS = 1800;
const LOG_LIMIT = 40;

/** session-snapshot verdicts after which the orchestrator has something to read or decide. */
export const DUE = new Set(['reply-observed', 'interrupted', 'errored-no-reply', 'ended-without-reply', 'idle-without-reply']);
/** Verdicts while the delegate is still working on a message it received: wait, boundedly. */
export const BUSY = new Set(['in-progress', 'reply-observed-still-working']);

const USAGE = `usage: codex-stop-gate.mjs <command> [options]     (session: CODEX_THREAD_ID inside Codex; --session <id> outside)

  enroll --as <actor> [--record <file>] [--max-unacted <n>] [--wait-seconds <s>]
                         opt this session in as a coordination-record actor (record: or COORDINATION_RECORD)
  withdraw               opt out and delete this session's gate state
  watch <assignment> --since <ISO time noted before sending>
                         arm: this session owes follow-through on the implementer's reply
  settle <assignment> [--note <text>]                   follow-through done; remove the watch
  block <assignment> --reason <text>                    genuinely blocked; stop continuing for it
  schedule <assignment> --owner <who> --at <future ISO time> --ref <file>
                         attest, with a reference to the arranged wake or handoff, that a named owner checks later
  pause [--reason <text>]  |  resume                    pause the whole gate / acknowledge pauses and interruptions
  wait <assignment> [--timeout <s>] [--every <s>]       block while the delegate works (default: the enrolled wait)
  status [--json]                                       state, pauses and what Stop would do now
  unlock --token <token>                                remove a dead holder's lock (see the lock diagnostic)
  hook                                                  Codex hook handler (Stop, Interrupt); reads the event on stdin`;

class UsageError extends Error {}

// ---------------------------------------------------------------- paths, state, pauses and locking

export function gateHome(env = process.env) {
  if (env.CODEX_STOP_GATE_HOME) return env.CODEX_STOP_GATE_HOME;
  const base = env.XDG_STATE_HOME || join(env.HOME || homedir(), '.local', 'state');
  return join(base, 'harness', 'codex-stop-gate');
}

function sessionPaths(env, session) {
  if (!SESSION_ID.test(session ?? '')) throw new UsageError(`not a session id: ${JSON.stringify(session)}`);
  const dir = join(gateHome(env), 'sessions');
  return { session, dir, state: join(dir, `${session}.json`), pauses: join(dir, `${session}.pauses`) };
}

const now = () => new Date().toISOString();
const sleep = ms => new Promise(done => setTimeout(done, ms));
const exists = path => stat(path).then(() => true, () => false);

function quote(text) {
  return /^[A-Za-z0-9_./:@%+=-]+$/.test(text) ? text : `'${text.replaceAll("'", "'\\''")}'`;
}
/** Commands are shown with the running node, so they work whatever the file mode or PATH. */
const NODE = quote(process.execPath);
const GATE = `${NODE} ${quote(SCRIPT)}`;
const SNAPSHOT = `${NODE} ${quote(SNAPSHOT_SCRIPT)}`;

async function loadState(paths) {
  let text;
  try { text = await readFile(paths.state, 'utf8'); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  const state = JSON.parse(text);
  if (state?.schema !== 2 || typeof state.watches !== 'object' || typeof state.actor !== 'string') {
    throw new Error(`gate state ${paths.state} is malformed`);
  }
  return state;
}

async function saveState(paths, state) {
  const temp = `${paths.state}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`);
  await rename(temp, paths.state);
}

function logEvent(state, entry) {
  state.log = [...(state.log ?? []), { at: now(), ...entry }].slice(-LOG_LIMIT);
}

async function withLock(paths, command, fn) {
  await mkdir(paths.dir, { recursive: true });
  const token = await acquireLock(paths.state, { command }, { unlockCommand: `${GATE} unlock --session ${paths.session}` });
  try { return await fn(); } finally { await releaseLock(paths.state, token); }
}

/** Unacknowledged pause markers (interruptions and explicit pauses), oldest first. */
async function pendingPauses(paths) {
  let names;
  try { names = (await readdir(paths.pauses)).filter(name => name.endsWith('.json')).sort(); } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  // A marker's presence pauses; its body is only a description, so an unreadable one still pauses and can be resumed.
  const markers = [];
  for (const name of names) {
    let body;
    try { body = JSON.parse(await readFile(join(paths.pauses, name), 'utf8')); } catch { body = { kind: 'unreadable' }; }
    markers.push({ name, ...body });
  }
  return markers;
}

/** Publish a pause marker atomically: written under a temporary name, then renamed into place. */
async function addPause(paths, body) {
  await mkdir(paths.pauses, { recursive: true });
  const at = now();
  const name = `${at.replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const temp = join(paths.pauses, `${name}.tmp`);
  await writeFile(temp, JSON.stringify({ at, ...body }), { flag: 'wx' });
  await rename(temp, join(paths.pauses, `${name}.json`));
}

const describePauses = markers => markers.length
  ? `${markers.map(m => (m.kind === 'interrupt' ? `interrupted at ${m.at}` : m.kind === 'pause' ? `paused at ${m.at}${m.reason ? ` (${m.reason})` : ''}`
    : `pause marker ${m.name} (unreadable)`)).join('; ')}; run resume to re-arm`
  : null;

// ---------------------------------------------------------------- the decision

/** Whether the watch still belongs to this session: its actor accountable, its implementer unchanged. */
export function ownership(watch, record, actor) {
  const a = record?.assignments?.[watch.assignment];
  if (!a) return { status: 'stale', detail: `assignment ${watch.assignment} is no longer in the record` };
  const accountable = a.accountable?.actor ?? null;
  const implementer = a.implementer?.session ?? null;
  if (accountable !== actor) return { status: 'stale', detail: `accountable is now ${accountable}, not this session's actor ${actor}` };
  if (implementer !== watch.implementer) return { status: 'stale', detail: `implementer changed from ${watch.implementer} to ${implementer ?? 'none'}` };
  return { status: 'current' };
}

/** A scheduled watch whose check time has passed without a recorded outcome. */
export function overdue(watch, at = now()) {
  return watch.state === 'scheduled' && Date.parse(at) >= Date.parse(watch.scheduled.at);
}

const checked = (watch, at) => watch.state === 'awaiting' || overdue(watch, at);

/**
 * What Stop does for this session, from its state and what was observed now. Pure: the caller supplies, per checked
 * watch, { ownership, verdict, notes } (verdict null when the delegate could not be observed, with notes saying why).
 * Returns the hook output plus the watch updates to persist.
 */
export function decideStop({ state, paused, observations, at = now(), newId = randomUUID }) {
  const attention = Object.values(state.watches).filter(w => w.state === 'needs-attention').map(w => w.assignment).sort();
  const warnings = attention.length ? [`stop gate: ${attention.join(', ')} still need${attention.length === 1 ? 's' : ''} attention `
    + '(repeated continuations were not acted on); follow-through is not confirmed. Re-arm with watch or record settle/block/schedule.'] : [];
  if (paused) return { output: warnings.length ? { systemMessage: warnings.join(' ') } : {}, updates: {}, summary: `paused (${paused})` };
  const max = state.maxUnacted ?? DEFAULT_MAX_UNACTED;
  const wait = state.waitSeconds ?? DEFAULT_WAIT_SECONDS;
  const lines = [];
  const updates = {};
  for (const [id, watch] of Object.entries(state.watches).sort(([a], [b]) => a.localeCompare(b))) {
    if (!checked(watch, at)) continue;
    const seen = observations[id];
    if (!seen) continue;
    if (seen.ownership.status !== 'current') {
      updates[id] = { state: 'stale', note: seen.ownership.detail };
      warnings.push(`stop gate: watch on ${id} is stale (${seen.ownership.detail}); it no longer continues this session.`);
      continue;
    }
    // The latest continuation, if any, was acted on (credited by its own id): the count starts again.
    const credited = !watch.continuationId || watch.creditedContinuation === watch.continuationId;
    const unacted = credited ? 0 : (watch.unacted ?? 0);
    if (unacted >= max) {
      updates[id] = { state: 'needs-attention', note: `${max} consecutive continuations not acted on` };
      warnings.push(`stop gate: ${id} needs attention: ${max} consecutive continuations were not acted on, so the gate stops continuing for it; `
        + 'follow-through is not confirmed. Re-arm with watch or record settle/block/schedule.');
      continue;
    }
    const n = unacted + 1;
    const tag = `${id} (implementer ${watch.implementer}; unacted continuation ${n} of ${max})`;
    const since = quote(watch.since);
    const record = `\`${GATE} settle ${id}\` when follow-through is done; \`${GATE} watch ${id} --since <time noted before sending>\` after `
      + `sending a follow-up; \`${GATE} block ${id} --reason ...\` if genuinely blocked; or \`${GATE} schedule ${id} --owner ... --at ... --ref <file>\` `
      + 'if an already-arranged check owns it';
    let line;
    if (seen.verdict && DUE.has(seen.verdict)) {
      line = `- ${tag}: the delegate's state is "${seen.verdict}" since ${watch.since}. Read it with `
        + `\`${SNAPSHOT} ${quote(watch.implementer)} --since ${since}\` (or ccmux last), act on it, then record the outcome: ${record}.`;
    } else if (seen.verdict && BUSY.has(seen.verdict)) {
      line = `- ${tag}: the delegate is still working ("${seen.verdict}"). Run one bounded blocking wait, `
        + `\`${GATE} wait ${id}\` (up to ${wait}s), and act on its result. Do not poll repeatedly or end the turn with only a status note.`;
    } else if (seen.verdict === 'no-user-message-since') {
      line = `- ${tag}: no message to the delegate is visible in its transcript since ${watch.since}; it may not have been delivered. `
        + `Check delivery (ccmux show / \`${SNAPSHOT} ${quote(watch.implementer)} --since ${since}\`), resend if needed, then record: ${record}.`;
    } else {
      line = `- ${tag}: the delegate's state could not be established (${seen.verdict ?? 'not observed'}${seen.notes?.length ? `: ${seen.notes.join('; ')}` : ''}). `
        + `Investigate, then record: ${record}.`;
    }
    if (overdue(watch, at)) line += ` The scheduled check by ${watch.scheduled.owner} at ${watch.scheduled.at} recorded no outcome, so this session owns follow-through again.`;
    lines.push(line);
    updates[id] = { unacted: n, continuationId: newId(), lastContinuedAt: at, continuations: (watch.continuations ?? 0) + 1,
      ...(overdue(watch, at) ? { state: 'awaiting', scheduled: null, note: `scheduled check by ${watch.scheduled.owner} at ${watch.scheduled.at} overdue` } : {}) };
  }
  const output = {};
  if (warnings.length) output.systemMessage = warnings.join(' ');
  if (lines.length) {
    output.decision = 'block';
    output.reason = ['[codex-stop-gate] This session enrolled in the stop gate and still owes follow-through on delegated work:',
      ...lines,
      `If the user asked you to stop or pause, run \`${GATE} pause --reason ...\` and end the turn.`].join('\n');
  }
  const continued = Object.keys(updates).filter(id => updates[id].unacted);
  return { output, updates, continued, summary: continued.length ? `continue (${continued.join(', ')})` : 'allow' };
}

/** snapshotFor reads CCMUX_PORT from process.env; run it against the caller's environment. */
async function withEnv(env, fn) {
  if (env === process.env || env.CCMUX_PORT === process.env.CCMUX_PORT) return fn();
  const saved = process.env.CCMUX_PORT;
  if (env.CCMUX_PORT === undefined) delete process.env.CCMUX_PORT; else process.env.CCMUX_PORT = env.CCMUX_PORT;
  try { return await fn(); } finally { if (saved === undefined) delete process.env.CCMUX_PORT; else process.env.CCMUX_PORT = saved; }
}

async function readOwnership(state, watch) {
  try { return ownership(watch, await readRecord(state.record), state.actor); } catch (error) {
    return { status: 'unknown', detail: `coordination record unreadable: ${error.message}` };
  }
}

async function observeOne(state, watch, env) {
  const owner = await readOwnership(state, watch);
  if (owner.status === 'stale') return { ownership: owner };
  if (owner.status === 'unknown') return { ownership: { status: 'current' }, verdict: null, notes: [owner.detail] };
  try {
    const result = await withEnv(env, () => snapshotFor(watch.implementer, { since: watch.since, replyChars: 0 }));
    if (result.error) return { ownership: owner, verdict: null, notes: [result.error] };
    return { ownership: owner, verdict: result.snapshot.verdict, notes: result.snapshot.notes ?? [] };
  } catch (error) {
    return { ownership: owner, verdict: null, notes: [error.message] };
  }
}

async function observe(state, env, at = now()) {
  const observations = {};
  for (const watch of Object.values(state.watches)) {
    if (checked(watch, at)) observations[watch.assignment] = await observeOne(state, watch, env);
  }
  return observations;
}

// ---------------------------------------------------------------- hook handlers

/** Ownership of the given watches from one validated read of the record; throws when it cannot be read. */
async function ownershipSnapshot(state, watches) {
  const record = await readRecord(state.record);
  return Object.fromEntries(watches.map(w => [w.assignment, ownership(w, record, state.actor)]));
}

/**
 * The Stop handler. The delegates are observed without holding the state lock (an interrupted turn ends this process,
 * which must not strand the lock); the lock is then held only to reload state, read ownership once and pauses last,
 * decide once and save. `afterObserve` is a test seam between the observation and the final reads.
 */
export async function onStop(input, env = process.env, { afterObserve } = {}) {
  const paths = sessionPaths(env, input.session_id);
  const first = await loadState(paths);
  if (!first) return {};
  const at = now();
  const early = describePauses(await pendingPauses(paths));
  const observed = early ? {} : await observe(first, env, at);
  if (afterObserve) await afterObserve();
  return withLock(paths, 'Stop', async () => {
    const state = await loadState(paths);
    if (!state) return {};
    // Reconcile with the fresh state: watches no longer checked (settled, blocked, scheduled) drop out; a checked watch
    // observed as it is now keeps its observation; one that changed or appeared meanwhile is unknown and inspected.
    const observations = {};
    for (const watch of Object.values(state.watches)) {
      if (!checked(watch, at)) continue;
      const was = first.watches[watch.assignment];
      const same = was && was.armId === watch.armId && was.state === watch.state && observed[watch.assignment];
      observations[watch.assignment] = same ? observed[watch.assignment]
        : { ownership: { status: 'current' }, verdict: null, notes: ['not observed in this check (the watch changed, or the gate was paused when the check began); inspect it'] };
    }
    // The final authority on ownership: one validated read of the record for every watch. If it cannot be read, the
    // error path lets the turn end with a warning; an earlier ownership verdict is never reused.
    const owners = await ownershipSnapshot(state, Object.keys(observations).map(id => state.watches[id]));
    for (const [id, owner] of Object.entries(owners)) {
      observations[id] = owner.status === 'current' ? { ...observations[id], ownership: owner } : { ownership: owner };
    }
    // Pauses last, from the markers as they are now: an early pause only skipped the observation.
    const paused = describePauses(await pendingPauses(paths));
    const decision = decideStop({ state, paused, observations: paused ? {} : observations, at });
    for (const [id, update] of Object.entries(decision.updates)) Object.assign(state.watches[id], update);
    const seen = Object.fromEntries(Object.entries(observations).map(([id, o]) => [id, o.ownership.status === 'current' ? o.verdict ?? 'unknown' : 'stale']));
    logEvent(state, { event: 'Stop', turn: input.turn_id ?? null, stopHookActive: !!input.stop_hook_active, decision: decision.summary, observed: seen });
    await saveState(paths, state);
    return decision.output;
  });
}

async function onInterrupt(input, env) {
  const paths = sessionPaths(env, input.session_id);
  if (!(await exists(paths.state))) return {};
  await addPause(paths, { kind: 'interrupt', turn: input.turn_id ?? null });
  return { systemMessage: 'stop gate paused by this interruption; it will not continue this session until resume is run.' };
}

export async function runHook(stdinText, env = process.env) {
  let input;
  try { input = JSON.parse(stdinText); } catch { return { systemMessage: 'stop gate: unreadable hook input; not continuing.' }; }
  try {
    if (input.hook_event_name === 'Stop') return await onStop(input, env);
    if (input.hook_event_name === 'Interrupt') return await onInterrupt(input, env);
    return {};
  } catch (error) {
    // Fail open: an error in the gate (including a held lock) must never trap a session.
    return { systemMessage: `stop gate error (${error.message}); not continuing.` };
  }
}

// ---------------------------------------------------------------- commands

function parseArgs(argv) {
  const positional = [];
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) { positional.push(arg); continue; }
    const name = arg.slice(2);
    if (name === 'json') { options.json = true; continue; }
    const value = argv[++i];
    if (value === undefined) throw new UsageError(`--${name} needs a value`);
    options[name] = value;
  }
  return { positional, options };
}

function needTime(value, flag) {
  if (!value || Number.isNaN(Date.parse(value))) throw new UsageError(`${flag} needs an ISO time`);
  return new Date(value).toISOString();
}

function needAssignment(id) {
  if (!ASSIGNMENT_ID.test(id ?? '')) throw new UsageError('name the assignment id');
  return id;
}

function boundedInteger(value, flag, min, max) {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!(Number.isInteger(n) && n >= min && n <= max)) throw new UsageError(`${flag} is ${min} to ${max}`);
  return n;
}

async function mutate(paths, command, fn) {
  return withLock(paths, command, async () => {
    const state = await loadState(paths);
    if (!state) throw new UsageError('this session is not enrolled; run enroll first');
    const result = await fn(state);
    await saveState(paths, state);
    return result;
  });
}

function watchFor(state, id) {
  const watch = state.watches[id];
  if (!watch) throw new UsageError(`no watch on ${id} in this session`);
  return watch;
}

/** Record an outcome on a watch: the agent acted, which credits the latest continuation. */
function recordOutcome(watch, fields) {
  Object.assign(watch, fields, { creditedContinuation: watch.continuationId ?? null });
}

const COMMANDS = {
  async enroll(paths, { options }, env, session) {
    const actor = options.as;
    if (!actor) throw new UsageError('name the coordination-record actor this session represents with --as');
    const given = options.record ?? env.COORDINATION_RECORD;
    if (!given) throw new UsageError('name the coordination record with --record or COORDINATION_RECORD');
    // Hooks run in the session's cwd, which can differ from here: store the absolute, canonical path.
    const recordPath = await canonicalRecordPath(resolve(given));
    await readRecord(recordPath);
    const max = boundedInteger(options['max-unacted'], '--max-unacted', 1, 20);
    const waitSeconds = boundedInteger(options['wait-seconds'], '--wait-seconds', 5, MAX_WAIT_SECONDS);
    return withLock(paths, 'enroll', async () => {
      const state = (await loadState(paths)) ?? { schema: 2, session, enrolledAt: now(), watches: {}, log: [] };
      if (Object.keys(state.watches).length && (state.record !== recordPath || state.actor !== actor)) {
        throw new UsageError(`this session's watches refer to ${state.record} as ${state.actor}; settle them or withdraw before changing either`);
      }
      Object.assign(state, { record: recordPath, actor });
      if (max !== undefined || state.maxUnacted === undefined) state.maxUnacted = max ?? DEFAULT_MAX_UNACTED;
      if (waitSeconds !== undefined || state.waitSeconds === undefined) state.waitSeconds = waitSeconds ?? DEFAULT_WAIT_SECONDS;
      logEvent(state, { event: 'enroll', record: recordPath, actor });
      await saveState(paths, state);
      return `session ${session} enrolled as ${actor} (record ${recordPath}; waits up to ${state.waitSeconds}s; `
        + `at most ${state.maxUnacted} consecutive unacted continuations per watch)`;
    });
  },

  async withdraw(paths) {
    return withLock(paths, 'withdraw', async () => {
      await rm(paths.state, { force: true });
      await rm(paths.pauses, { recursive: true, force: true });
      return 'withdrawn; Stop no longer checks this session';
    });
  },

  async watch(paths, { positional: [rawId], options }) {
    const id = needAssignment(rawId);
    const since = needTime(options.since, '--since');
    return mutate(paths, 'watch', async state => {
      const a = (await readRecord(state.record)).assignments[id];
      if (!a) throw new UsageError(`no assignment ${id} in ${state.record}`);
      if (a.accountable.actor !== state.actor) {
        throw new UsageError(`${id} is accountable to ${a.accountable.actor}, not this session's actor ${state.actor}; not watched`);
      }
      if (!a.implementer) throw new UsageError(`${id} has no recorded implementer to watch`);
      const existing = state.watches[id];
      if (existing && existing.state === 'awaiting' && existing.since === since && existing.implementer === a.implementer.session) {
        // Replaying an active watch is not follow-through: keep its counts. Re-arming from needs-attention, blocked,
        // scheduled or stale (below) is the explicit recovery and starts afresh.
        logEvent(state, { event: 'watch', assignment: id, since, replay: true });
        return `already watching ${id} since ${since}; counts kept. Record an outcome (settle, block, schedule), or watch again after a new send.`;
      }
      state.watches[id] = { assignment: id, state: 'awaiting', since, implementer: a.implementer.session, armId: randomUUID(),
        armedAt: now(), continuationId: null, creditedContinuation: null, unacted: 0, continuations: 0 };
      logEvent(state, { event: 'watch', assignment: id, since });
      return `watching ${id}: implementer ${a.implementer.session}, since ${since}`;
    });
  },

  async settle(paths, { positional: [rawId], options }) {
    const id = needAssignment(rawId);
    return mutate(paths, 'settle', async state => {
      watchFor(state, id);
      delete state.watches[id];
      logEvent(state, { event: 'settle', assignment: id, note: options.note ?? null });
      return `${id} settled; watch removed`;
    });
  },

  async block(paths, { positional: [rawId], options }) {
    const id = needAssignment(rawId);
    if (!options.reason) throw new UsageError('block needs --reason');
    return mutate(paths, 'block', async state => {
      recordOutcome(watchFor(state, id), { state: 'blocked', note: options.reason });
      logEvent(state, { event: 'block', assignment: id, reason: options.reason });
      return `${id} blocked: ${options.reason}`;
    });
  },

  async schedule(paths, { positional: [rawId], options }) {
    const id = needAssignment(rawId);
    if (!options.owner) throw new UsageError('schedule needs --owner');
    if (!options.ref) throw new UsageError('schedule needs --ref <file> describing the already-arranged wake or handoff');
    const at = needTime(options.at, '--at');
    const ref = await fileRef(options.ref);
    return mutate(paths, 'schedule', async state => {
      if (Date.parse(at) <= Date.now()) throw new UsageError('--at must be in the future: a scheduled owner checks later');
      recordOutcome(watchFor(state, id), { state: 'scheduled', scheduled: { owner: options.owner, at, ref }, note: null });
      logEvent(state, { event: 'schedule', assignment: id, owner: options.owner, at, ref });
      return `${id} scheduled: ${options.owner} checks at ${at} (attested by ${ref.path}, sha256 ${ref.sha256.slice(0, 12)}); `
        + 'the next Stop after that time reconsiders follow-through here unless an outcome is recorded';
    });
  },

  async pause(paths, { options }) {
    if (!(await exists(paths.state))) throw new UsageError('this session is not enrolled');
    await addPause(paths, { kind: 'pause', reason: options.reason ?? null });
    return 'gate paused; Stop will not continue this session until resume';
  },

  async resume(paths) {
    return mutate(paths, 'resume', async state => {
      const seen = await pendingPauses(paths);
      // Remove only the markers read here: a pause or interruption arriving meanwhile keeps the gate paused.
      for (const marker of seen) await rm(join(paths.pauses, marker.name), { force: true });
      logEvent(state, { event: 'resume', acknowledged: seen.map(m => m.kind) });
      return `gate resumed${seen.length ? ` (${seen.length} pause(s) acknowledged)` : ''}`;
    });
  },

  /**
   * Block while the delegate works. Credit for acting on a continuation is given only when the wait started on
   * pending work and then observed it finish (a DUE verdict), or lasted the enrolled period with the delegate still
   * observed busy, and only while the gate is unpaused and the watch unchanged. Failed observations neither end the
   * wait nor earn credit; a watched send that drops out of view ends it uncredited.
   */
  async wait(paths, { positional: [rawId], options }, env) {
    const id = needAssignment(rawId);
    const state = await loadState(paths);
    if (!state) throw new UsageError('this session is not enrolled');
    const watch = watchFor(state, id);
    const { armId, continuationId } = watch;
    const period = state.waitSeconds ?? DEFAULT_WAIT_SECONDS;
    const timeout = Math.min(Number(options.timeout ?? period), MAX_WAIT_SECONDS);
    const every = Math.max(Number(options.every ?? 10), 1);
    if (!(timeout > 0)) throw new UsageError('--timeout is a positive number of seconds');
    const started = Date.now();
    const deadline = started + timeout * 1000;
    const first = await observeOne(state, watch, env);
    if (first.ownership.status !== 'current') return `${id}: not waiting; the watch is stale (${first.ownership.detail})`;
    if (!BUSY.has(first.verdict)) return `${id}: not waiting; nothing pending (${describeVerdict(first, watch)})`;
    let finished = null;
    let last = first;
    let lostSight = false;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await sleep(Math.min(every * 1000, remaining));
      if ((await pendingPauses(paths)).length) return `${id}: stopped waiting; the gate was paused or interrupted`;
      const current = (await loadState(paths))?.watches?.[id];
      if (!current || current.armId !== armId || !checked(current)) {
        return `${id}: stopped waiting; the watch was ${!current ? 'settled or withdrawn' : current.armId !== armId ? 're-armed' : current.state}`;
      }
      last = await observeOne(state, watch, env);
      if (last.ownership.status !== 'current') return `${id}: stopped waiting; the watch is stale (${last.ownership.detail})`;
      if (DUE.has(last.verdict)) { finished = last; break; }
      if (!BUSY.has(last.verdict)) lostSight = true;
      if (last.verdict === 'no-user-message-since') {
        return `${id}: stopped waiting, not counted as acting: the watched send is no longer visible in the delegate's transcript (${describeVerdict(last, watch)})`;
      }
    }
    // A full period counts only when the delegate was observed busy at every poll.
    const fullAndBusy = Date.now() - started >= period * 1000 && !lostSight && BUSY.has(last.verdict);
    let credited = false;
    if (finished || fullAndBusy) {
      // Credit only the continuation this wait answered: same armed watch, no newer continuation, still owned and
      // checked, and the gate not paused.
      credited = await mutate(paths, 'wait', async s => {
        const w = s.watches[id];
        if (!w || w.armId !== armId || (w.continuationId ?? null) !== (continuationId ?? null) || !checked(w)) return false;
        if ((await ownershipSnapshot(s, [w]))[id].status !== 'current') return false;
        if ((await pendingPauses(paths)).length) return false; // last, after the ownership read
        w.creditedContinuation = continuationId ?? null;
        logEvent(s, { event: 'wait', assignment: id, seconds: Math.round((Date.now() - started) / 1000), outcome: finished?.verdict ?? 'still busy' });
        return true;
      });
    }
    const secs = Math.round((Date.now() - started) / 1000);
    if ((finished || fullAndBusy) && !credited) return `${id}: not counted as acting after ${secs}s: the gate was paused or the watch changed meanwhile`;
    if (finished) return `${id}: ${describeVerdict(finished, watch)}`;
    if (fullAndBusy) return `${id}: still working after ${secs}s`;
    return `${id}: not counted as acting after ${secs}s: ${lostSight ? `the delegate's state could not be observed at every poll (last: ${describeVerdict(last, watch)})` : `shorter than the enrolled ${period}s wait`}`;
  },

  async status(paths, { options }, env) {
    const state = await loadState(paths);
    if (!state) return options.json ? JSON.stringify({ enrolled: false }) : 'not enrolled';
    const paused = describePauses(await pendingPauses(paths));
    const observations = paused ? {} : await observe(state, env);
    const preview = decideStop({ state, paused, observations });
    if (options.json) return JSON.stringify({ enrolled: true, state, paused, observations, wouldDo: preview }, null, 2);
    const lines = [`session ${state.session} as ${state.actor}, record ${state.record}, ${paused ? `paused: ${paused}` : 'armed'}`];
    for (const w of Object.values(state.watches)) {
      const seen = observations[w.assignment];
      lines.push(`- ${w.assignment}: ${w.state}${w.note ? ` (${w.note})` : ''}${w.scheduled ? ` by ${w.scheduled.owner} at ${w.scheduled.at}` : ''}; `
        + `implementer ${w.implementer}; since ${w.since}; unacted ${w.unacted ?? 0}/${state.maxUnacted}; continuations ${w.continuations ?? 0}`
        + `${seen ? `; now ${seen.ownership.status === 'current' ? seen.verdict ?? 'unknown' : seen.ownership.detail}` : ''}`);
    }
    lines.push(`Stop now: ${preview.summary}`);
    return lines.join('\n');
  },

  async unlock(paths, { options }) {
    if (!options.token) throw new UsageError('unlock needs --token (from the lock diagnostic)');
    await unlock(paths.state, options.token);
    return 'unlocked';
  },
};

/** A reference file as the coordination record records one: canonical path and content hash, read now. */
async function fileRef(path) {
  try {
    const real = await realpath(path);
    return { path: real, sha256: createHash('sha256').update(await readFile(real)).digest('hex') };
  } catch (error) {
    throw new UsageError(`cannot read ${path} (${error.code})`);
  }
}

function describeVerdict(seen, watch) {
  const notes = seen.notes?.length ? ` (${seen.notes.join('; ')})` : '';
  const read = DUE.has(seen.verdict) ? `. Read it with ${SNAPSHOT} ${quote(watch.implementer)} --since ${quote(watch.since)}` : '';
  return `${seen.verdict ?? 'unknown'}${notes}${read}`;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

export async function main(argv, env = process.env) {
  const { positional, options } = parseArgs(argv);
  const command = positional.shift();
  if (!command || !COMMANDS[command]) throw new UsageError(USAGE);
  // Inside Codex a command acts on its own session only; --session is for operators outside Codex.
  if (env.CODEX_THREAD_ID && options.session && options.session !== env.CODEX_THREAD_ID) {
    throw new UsageError(`inside Codex session ${env.CODEX_THREAD_ID}, gate commands act on that session only`);
  }
  const session = env.CODEX_THREAD_ID ?? options.session;
  if (!session) throw new UsageError('no session: run inside Codex (CODEX_THREAD_ID) or pass --session <id>');
  return COMMANDS[command](sessionPaths(env, session), { positional, options }, env, session);
}

if (process.argv[1] && SCRIPT === (await import('node:fs')).realpathSync(process.argv[1])) {
  if (process.argv[2] === 'hook') {
    console.log(JSON.stringify(await runHook(await readStdin())));
  } else {
    try {
      console.log(await main(process.argv.slice(2)));
    } catch (error) {
      console.error(`codex-stop-gate: ${error.message}`);
      process.exit(error instanceof UsageError ? 2 : error instanceof RecordError ? 3 : 1);
    }
  }
}
