// Codex stop gate: the decision rules, and the hook and commands as processes against a temporary gate home,
// coordination record, synthetic Pi delegate and stub ccmux daemon. Real Codex lifecycle runs are in
// codex-stop-gate.e2e.mjs (they spend model calls, so they are not part of this suite).
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';
import { decideStop, onStop, ownership } from '../codex-stop-gate.mjs';
import { gateScript, piTranscript, startFixture } from './fixtures/codex-gate-fixture.mjs';

const fx = await startFixture();
test.after(() => fx.close());
const run = promisify(execFile);
const tick = () => new Promise(resolve => setTimeout(resolve, 5));
const stop = (session, extra = {}) => fx.hook({ hook_event_name: 'Stop', session_id: session, turn_id: 't', stop_hook_active: false, ...extra });
const interrupt = session => fx.hook({ hook_event_name: 'Interrupt', session_id: session, turn_id: 't' });
const sessionsDir = () => join(fx.env.CODEX_STOP_GATE_HOME, 'sessions');
const stateOf = session => JSON.parse(readFileSync(join(sessionsDir(), `${session}.json`), 'utf8'));
const revOf = id => JSON.parse(readFileSync(fx.record, 'utf8')).assignments[id].rev;

let seq = 0;
/** An enrolled orchestrator session (actor astra) watching a fresh assignment whose delegate has just been sent work. */
async function scenario(status = 'working', { enrollArgs = [] } = {}) {
  const n = ++seq;
  const session = `codex-${n}`;
  const t = piTranscript(fx.dir, `d${n}`);
  await fx.recordCli('assign', `a${n}`, '--title', `task ${n}`, '--accountable', 'astra', '--implementer', t.sessionId);
  await fx.gate(session, 'enroll', '--as', 'astra', ...enrollArgs);
  const since = new Date().toISOString();
  await tick();
  t.user('please implement');
  fx.delegate(t, status);
  await fx.gate(session, 'watch', `a${n}`, '--since', since);
  return { session, id: `a${n}`, t, since };
}

// ---------------------------------------------------------------- pure rules

const base = { assignment: 'x', state: 'awaiting', since: '2026-01-01T00:00:00.000Z', implementer: 'p' };
const busy = { x: { ownership: { status: 'current' }, verdict: 'in-progress', notes: [] } };

test('decideStop: paused or nothing checked allows; ownership is the declared actor', () => {
  const state = { maxUnacted: 3, watches: { x: base } };
  assert.deepEqual(decideStop({ state, paused: 'interrupted', observations: {} }).output, {});
  assert.deepEqual(decideStop({ state: { watches: {} }, paused: null, observations: {} }).output, {});
  const record = { assignments: { x: { accountable: { actor: 'other' }, implementer: { session: 'p' } } } };
  assert.equal(ownership(base, record, 'astra').status, 'stale');
  assert.equal(ownership(base, { assignments: { x: { accountable: { actor: 'astra' }, implementer: { session: 'p' } } } }, 'astra').status, 'current');
  const d = decideStop({ state, paused: null, observations: { x: { ownership: ownership(base, record, 'astra') } } });
  assert.equal(d.output.decision, undefined);
  assert.match(d.output.systemMessage, /stale/);
});

test('decideStop: only uncredited continuations count; crediting that continuation resets', () => {
  let watch = { ...base, continuationId: null };
  for (let i = 1; i <= 3; i++) {
    const d = decideStop({ state: { maxUnacted: 3, watches: { x: watch } }, paused: null, observations: busy });
    assert.equal(d.output.decision, 'block');
    assert.equal(d.updates.x.unacted, i);
    watch = { ...watch, ...d.updates.x };
  }
  const exhausted = decideStop({ state: { maxUnacted: 3, watches: { x: watch } }, paused: null, observations: busy });
  assert.equal(exhausted.output.decision, undefined);
  assert.equal(exhausted.updates.x.state, 'needs-attention');
  watch = { ...base, continuationId: null };
  for (let i = 0; i < 30; i++) {
    const d = decideStop({ state: { maxUnacted: 3, watches: { x: watch } }, paused: null, observations: busy });
    assert.equal(d.updates.x.unacted, 1);
    watch = { ...watch, ...d.updates.x };
    watch.creditedContinuation = watch.continuationId; // the agent acted on exactly this continuation
  }
  // Credit for an earlier continuation does not cover a newer one.
  const d = decideStop({ state: { maxUnacted: 3, watches: { x: { ...watch, creditedContinuation: 'older' } } }, paused: null, observations: busy });
  assert.equal(d.updates.x.unacted, 2);
});

test('decideStop: a scheduled check is exempt until its time, then reconsidered here', () => {
  const watch = { ...base, state: 'scheduled', scheduled: { owner: 'heartbeat', at: '2026-01-01T01:00:00.000Z' } };
  assert.deepEqual(decideStop({ state: { watches: { x: watch } }, paused: null, observations: busy, at: '2026-01-01T00:59:59.000Z' }).output, {});
  const d = decideStop({ state: { watches: { x: watch } }, paused: null, observations: busy, at: '2026-01-01T01:00:00.000Z' });
  assert.equal(d.output.decision, 'block');
  assert.match(d.output.reason, /scheduled check by heartbeat .* recorded no outcome/);
  assert.equal(d.updates.x.state, 'awaiting');
});

// ---------------------------------------------------------------- hook and commands as processes

test('an unenrolled session is left alone and gets no state', async () => {
  assert.deepEqual(await stop('codex-unrelated'), {});
  assert.deepEqual(await interrupt('codex-unrelated'), {});
  assert.equal(existsSync(join(sessionsDir(), 'codex-unrelated.json')), false);
});

test('sessions are isolated: another session, a differently cased id, and --session inside Codex', async () => {
  const { session } = await scenario('working');
  await fx.gate('codex-bystander', 'enroll', '--as', 'astra');
  assert.deepEqual(await stop('codex-bystander'), {});
  const upper = await stop(session.toUpperCase());
  assert.equal(upper.decision, undefined);
  assert.match(upper.systemMessage, /not a session id/);
  assert.equal((await stop(session)).decision, 'block');
  const inside = { ...fx.env, CODEX_THREAD_ID: 'codex-bystander' };
  await assert.rejects(run('node', [gateScript, 'pause', '--session', session], { env: inside }).catch(e => { throw new Error(e.stderr); }),
    /act on that session only/);
});

test('the continuation\'s commands run exactly as emitted', async () => {
  const { session, id, t } = await scenario('working');
  const first = await stop(session);
  const waitCommand = first.reason.match(/`([^`]* wait [^`]*)`/)[1];
  t.assistant('done');
  fx.delegate(t, 'idle');
  const waited = await run('/bin/sh', ['-c', `${waitCommand} --every 1`], { env: { ...fx.env, CODEX_THREAD_ID: session } });
  assert.match(waited.stdout, /nothing pending \(reply-observed/);
  const due = await stop(session);
  const read = due.reason.match(/`([^`]*session-snapshot\.mjs[^`]*)`/)[1];
  assert.match((await run('/bin/sh', ['-c', read], { env: fx.env })).stdout, /reply-observed/);
  const settle = due.reason.match(/`([^`]* settle [^`]*)`/)[1];
  await run('/bin/sh', ['-c', settle], { env: { ...fx.env, CODEX_THREAD_ID: session } });
  assert.equal(stateOf(session).watches[id], undefined);
});

test('reply delivered: continue to read it; settle lets the turn end', async () => {
  const { session, id, t } = await scenario('working');
  assert.match((await stop(session)).reason, /still working/);
  t.assistant('done: tests pass');
  fx.delegate(t, 'idle');
  const out = await stop(session);
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /"reply-observed"/);
  await fx.gate(session, 'settle', id);
  assert.deepEqual(await stop(session), {});
});

test('undelivered message: continue to check delivery, not to wait', async () => {
  const n = ++seq;
  const t = piTranscript(fx.dir, `u${n}`);
  await fx.recordCli('assign', `a${n}`, '--title', 'u', '--accountable', 'astra', '--implementer', t.sessionId);
  t.user('old message');
  t.assistant('old reply');
  fx.delegate(t, 'idle');
  const session = `codex-${n}`;
  await fx.gate(session, 'enroll', '--as', 'astra');
  await fx.gate(session, 'watch', `a${n}`, '--since', new Date(Date.now() + 1000).toISOString());
  const out = await stop(session);
  assert.match(out.reason, /may not have been delivered/);
  assert.match(await fx.gate(session, 'wait', `a${n}`, '--timeout', '5', '--every', '1'), /not waiting; nothing pending/);
});

test('wait blocks while busy and returns when the delegate finishes', async () => {
  const { session, id, t } = await scenario('working', { enrollArgs: ['--wait-seconds', '5'] });
  setTimeout(() => { t.assistant('finished'); fx.delegate(t, 'idle'); }, 1200);
  const started = Date.now();
  assert.match(await fx.gate(session, 'wait', id, '--every', '1'), /reply-observed/);
  assert.ok(Date.now() - started >= 1000);
  assert.equal(stateOf(session).log.at(-1).event, 'wait');
});

test('ineffective waits earn no credit, so the guard still bounds them', async () => {
  // Already delivered: wait returns at once, uncredited.
  const due = await scenario('working', { enrollArgs: ['--max-unacted', '2', '--wait-seconds', '5'] });
  due.t.assistant('done');
  fx.delegate(due.t, 'idle');
  for (let i = 0; i < 2; i++) {
    assert.equal((await stop(due.session)).decision, 'block');
    assert.match(await fx.gate(due.session, 'wait', due.id), /not waiting/);
  }
  assert.equal((await stop(due.session)).decision, undefined);
  assert.equal(stateOf(due.session).watches[due.id].state, 'needs-attention');
  // Busy, but a wait shorter than the enrolled period: uncredited.
  const short = await scenario('working', { enrollArgs: ['--max-unacted', '2', '--wait-seconds', '5'] });
  for (let i = 0; i < 2; i++) {
    assert.equal((await stop(short.session)).decision, 'block');
    assert.match(await fx.gate(short.session, 'wait', short.id, '--timeout', '1', '--every', '1'), /not counted as acting/);
  }
  assert.equal((await stop(short.session)).decision, undefined);
  assert.equal(stateOf(short.session).watches[short.id].state, 'needs-attention');
});

test('slow delegate: full waits between continuations never exhaust the guard', async () => {
  const { session, id } = await scenario('working', { enrollArgs: ['--max-unacted', '1', '--wait-seconds', '5'] });
  for (let i = 0; i < 3; i++) {
    assert.equal((await stop(session)).decision, 'block', `continuation ${i + 1}`);
    assert.match(await fx.gate(session, 'wait', id, '--every', '2'), /still working after/);
  }
  assert.equal(stateOf(session).watches[id].state, 'awaiting');
});

test('ignored continuations become needs-attention, warned at every later stop', async () => {
  const { session, id } = await scenario('working', { enrollArgs: ['--max-unacted', '2'] });
  assert.equal((await stop(session)).decision, 'block');
  assert.equal((await stop(session)).decision, 'block');
  const third = await stop(session);
  assert.equal(third.decision, undefined);
  assert.match(third.systemMessage, /needs attention/);
  assert.match((await stop(session)).systemMessage, /still needs attention/);
  assert.match(await fx.gate(session, 'status'), new RegExp(`${id}: needs-attention`));
  await fx.gate(session, 'watch', id, '--since', new Date().toISOString());
  assert.equal((await stop(session)).decision, 'block');
});

test('blocked, scheduled (with a reference) and paused let the turn end', async () => {
  const blocked = await scenario('working');
  await fx.gate(blocked.session, 'block', blocked.id, '--reason', 'needs credentials from the user');
  assert.deepEqual(await stop(blocked.session), {});

  const scheduled = await scenario('working');
  const future = new Date(Date.now() + 3600e3).toISOString();
  await assert.rejects(fx.gate(scheduled.session, 'schedule', scheduled.id, '--owner', 'h', '--at', future), /needs --ref/);
  await assert.rejects(fx.gate(scheduled.session, 'schedule', scheduled.id, '--owner', 'h', '--at', future, '--ref', join(fx.dir, 'missing')), /cannot read/);
  const ref = join(fx.dir, `wake-${seq}.md`);
  writeFileSync(ref, 'heartbeat job 42 checks a-N at the hour');
  await assert.rejects(fx.gate(scheduled.session, 'schedule', scheduled.id, '--owner', 'h', '--at', new Date(Date.now() - 1000).toISOString(), '--ref', ref), /must be in the future/);
  await fx.gate(scheduled.session, 'schedule', scheduled.id, '--owner', 'heartbeat', '--at', future, '--ref', ref);
  assert.match(stateOf(scheduled.session).watches[scheduled.id].scheduled.ref.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(await stop(scheduled.session), {});

  const paused = await scenario('working');
  await fx.gate(paused.session, 'pause', '--reason', 'user said stop');
  assert.deepEqual(await stop(paused.session), {});
  await fx.gate(paused.session, 'resume');
  assert.equal((await stop(paused.session)).decision, 'block');
});

test('ownership: watch needs this actor accountable; a transfer makes the watch stale and re-arming is refused', async () => {
  const { session, id } = await scenario('working');
  await fx.recordCli('transfer', id, '--role', 'accountable', '--to', 'other-orchestrator', '--expect-rev', String(revOf(id)));
  const out = await stop(session);
  assert.equal(out.decision, undefined);
  assert.match(out.systemMessage, /stale \(accountable is now other-orchestrator/);
  await assert.rejects(fx.gate(session, 'watch', id, '--since', new Date().toISOString()), /accountable to other-orchestrator/);
  assert.deepEqual(await stop(session), {});
});

test('a transfer landing while Stop observes withdraws that continuation', async () => {
  const { session, id } = await scenario('working');
  const out = await onStop({ hook_event_name: 'Stop', session_id: session }, fx.env, {
    afterObserve: () => fx.recordCli('transfer', id, '--role', 'accountable', '--to', 'someone-else', '--expect-rev', String(revOf(id))),
  });
  assert.equal(out.decision, undefined);
  assert.match(out.systemMessage, /stale \(accountable is now someone-else/);
  assert.equal(stateOf(session).watches[id].unacted, 0);
});

test('a transfer of one watch during the check keeps the other watch\'s continuation', async () => {
  const { session, id } = await scenario('working');
  const t2 = piTranscript(fx.dir, `m${seq}`);
  await fx.recordCli('assign', `${id}-b`, '--title', 'b', '--accountable', 'astra', '--implementer', t2.sessionId);
  const since = new Date().toISOString();
  await tick();
  t2.user('second task');
  fx.delegate(t2, 'working');
  await fx.gate(session, 'watch', `${id}-b`, '--since', since);
  const out = await onStop({ hook_event_name: 'Stop', session_id: session }, fx.env, {
    afterObserve: () => fx.recordCli('transfer', id, '--role', 'accountable', '--to', 'someone-else', '--expect-rev', String(revOf(id))),
  });
  assert.equal(out.decision, 'block');
  assert.match(out.reason, new RegExp(`- ${id}-b `));
  assert.doesNotMatch(out.reason, new RegExp(`- ${id} \\(`));
  assert.match(out.systemMessage, new RegExp(`watch on ${id} is stale`));
  const state = stateOf(session);
  assert.equal(state.watches[id].state, 'stale');
  assert.equal(state.watches[`${id}-b`].unacted, 1);
});

test('enroll stores the canonical record path and refuses to retarget live watches', async () => {
  const { session } = await scenario('working');
  assert.equal(stateOf(session).record, realpathSync(fx.record));
  const other = join(fx.dir, 'other-record.json');
  await fx.recordCli('init', '--record', other);
  await assert.rejects(fx.gate(session, 'enroll', '--as', 'astra', '--record', other), /settle them or withdraw/);
  await assert.rejects(fx.gate(session, 'enroll', '--as', 'someone-else'), /settle them or withdraw/);
  const fresh = `codex-rel-${seq}`;
  await fx.gate(fresh, 'enroll', '--as', 'astra', '--record', relative(process.cwd(), fx.record));
  assert.equal(stateOf(fresh).record, realpathSync(fx.record));
});

test('interruption and pause share one rule; resume acknowledges only what it saw', async () => {
  const { session } = await scenario('working');
  assert.match((await interrupt(session)).systemMessage, /paused by this interruption/);
  assert.deepEqual(await stop(session), {});
  await fx.gate(session, 'pause');
  assert.match(await fx.gate(session, 'status'), /interrupted at .*paused at/);
  await fx.gate(session, 'resume');
  assert.equal((await stop(session)).decision, 'block');
});

test('an interruption during observation, or after it before the decision, withdraws the continuation', async () => {
  const during = await scenario('working');
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  fx.setDelay(() => gate);
  const pending = stop(during.session);
  await new Promise(resolve => setTimeout(resolve, 300));
  await interrupt(during.session);
  release();
  fx.setDelay(null);
  assert.deepEqual(await pending, {});
  assert.equal(stateOf(during.session).watches[during.id].unacted, 0);

  const after = await scenario('working');
  const out = await onStop({ hook_event_name: 'Stop', session_id: after.session }, fx.env, { afterObserve: () => interrupt(after.session) });
  assert.deepEqual(out, {});
  assert.equal(stateOf(after.session).watches[after.id].unacted, 0);
});

test('wait stops when the gate is paused or the watch settles, without credit', async () => {
  const { session, id } = await scenario('working', { enrollArgs: ['--wait-seconds', '30'] });
  setTimeout(() => fx.gate(session, 'pause'), 700);
  assert.match(await fx.gate(session, 'wait', id, '--every', '1'), /gate was paused/);
  await fx.gate(session, 'resume');
  setTimeout(() => fx.gate(session, 'settle', id), 700);
  assert.match(await fx.gate(session, 'wait', id, '--every', '1'), /settled or withdrawn/);
  assert.ok(!stateOf(session).log.some(e => e.event === 'wait'));
});

test('concurrent hooks and commands keep every change', async () => {
  const { session, id } = await scenario('working');
  const extra = [];
  for (let i = 0; i < 4; i++) {
    const t2 = piTranscript(fx.dir, `c${seq}-${i}`);
    await fx.recordCli('assign', `${id}-c${i}`, '--title', 'c', '--accountable', 'astra', '--implementer', t2.sessionId);
    fx.delegate(t2, 'working');
    extra.push(`${id}-c${i}`);
  }
  const since = new Date().toISOString();
  await Promise.all([...extra.map(x => fx.gate(session, 'watch', x, '--since', since)), stop(session), stop(session), interrupt(session)]);
  const state = stateOf(session);
  for (const x of [id, ...extra]) assert.ok(state.watches[x], `watch ${x} kept`);
  assert.equal(readdirSync(join(sessionsDir(), `${session}.pauses`)).length, 1);
});

test('a held lock is never reclaimed automatically: hooks fail open, unlock refuses a live holder', async () => {
  const { session, id } = await scenario('working');
  const lock = join(sessionsDir(), `${session}.json.lock`);
  writeFileSync(lock, JSON.stringify({ token: 'live', pid: process.pid, host: hostname(), at: new Date().toISOString() }));
  const out = await stop(session);
  assert.equal(out.decision, undefined);
  assert.match(out.systemMessage, /locked: .*unlock --session .* --token live/);
  await assert.rejects(fx.gate(session, 'unlock', '--token', 'live'), /still running/);
  const child = spawn('true');
  await new Promise(resolve => child.on('exit', resolve));
  writeFileSync(lock, JSON.stringify({ token: 'dead', pid: child.pid, host: hostname(), at: new Date().toISOString() }));
  await assert.rejects(fx.gate(session, 'settle', id), /locked/);
  await assert.rejects(fx.gate(session, 'unlock', '--token', 'wrong'), /does not match/);
  assert.equal(await fx.gate(session, 'unlock', '--token', 'dead'), 'unlocked');
  await fx.gate(session, 'settle', id);
});

test('a broken gate fails open; commands need enrollment', async () => {
  const session = 'codex-broken';
  mkdirSync(sessionsDir(), { recursive: true });
  writeFileSync(join(sessionsDir(), `${session}.json`), '{not json');
  const out = await stop(session);
  assert.equal(out.decision, undefined);
  assert.match(out.systemMessage, /stop gate error/);
  assert.match((await fx.hook({ hook_event_name: 'Stop', session_id: '../escape' })).systemMessage, /not a session id/);
  await assert.rejects(fx.gate('codex-never', 'watch', 'a1', '--since', new Date().toISOString()), /not enrolled/);
  // An ambient COORDINATION_ACTOR (set in the fixture) is not an explicit identity.
  await assert.rejects(fx.gate('codex-never', 'enroll'), /--as/);
});

test('second review: a pause completing after observation, before the decision, wins', async () => {
  const { session, id } = await scenario('working');
  const out = await onStop({ hook_event_name: 'Stop', session_id: session }, fx.env, { afterObserve: () => fx.gate(session, 'pause') });
  assert.deepEqual(out, {});
  assert.equal(stateOf(session).watches[id].unacted, 0);
});

test('second review: a watch already stale and one transferred during the check are both warned and stale', async () => {
  const { session, id } = await scenario('working');
  const t2 = piTranscript(fx.dir, `s${seq}`);
  await fx.recordCli('assign', `${id}-b`, '--title', 'b', '--accountable', 'astra', '--implementer', t2.sessionId);
  fx.delegate(t2, 'working');
  await fx.gate(session, 'watch', `${id}-b`, '--since', new Date().toISOString());
  await fx.recordCli('transfer', `${id}-b`, '--role', 'accountable', '--to', 'x', '--expect-rev', String(revOf(`${id}-b`)));
  const out = await onStop({ hook_event_name: 'Stop', session_id: session }, fx.env, {
    afterObserve: () => fx.recordCli('transfer', id, '--role', 'accountable', '--to', 'y', '--expect-rev', String(revOf(id))),
  });
  assert.equal(out.decision, undefined);
  assert.match(out.systemMessage, new RegExp(`watch on ${id} is stale`));
  assert.match(out.systemMessage, new RegExp(`watch on ${id}-b is stale`));
  const state = stateOf(session);
  assert.equal(state.watches[id].state, 'stale');
  assert.equal(state.watches[`${id}-b`].state, 'stale');
});

test('second review: waits that lose sight of the delegate earn no credit', async () => {
  const { session, id, t } = await scenario('working', { enrollArgs: ['--max-unacted', '1', '--wait-seconds', '5'] });
  assert.equal((await stop(session)).decision, 'block');
  setTimeout(() => fx.forget(t), 500);
  assert.match(await fx.gate(session, 'wait', id, '--every', '1'), /not counted as acting .*could not be observed/);
  fx.delegate(t, 'working');
  const out = await stop(session);
  assert.equal(out.decision, undefined);
  assert.equal(stateOf(session).watches[id].state, 'needs-attention');
});

test('replaying an active watch keeps the counts; re-arming from needs-attention is the recovery', async () => {
  const { session, id, since } = await scenario('working', { enrollArgs: ['--max-unacted', '1'] });
  assert.equal((await stop(session)).decision, 'block');
  assert.match(await fx.gate(session, 'watch', id, '--since', since), /counts kept/);
  assert.equal((await stop(session)).decision, undefined);
  assert.equal(stateOf(session).watches[id].state, 'needs-attention');
  // Explicit recovery from needs-attention re-arms the same real send, without inventing a new send time.
  assert.match(await fx.gate(session, 'watch', id, '--since', since), /watching/);
  assert.equal(stateOf(session).watches[id].state, 'awaiting');
  assert.equal(stateOf(session).watches[id].unacted, 0);
  assert.equal((await stop(session)).decision, 'block');
});

test('second review: an unreadable pause marker still pauses and resume acknowledges it', async () => {
  const { session } = await scenario('working');
  mkdirSync(join(sessionsDir(), `${session}.pauses`), { recursive: true });
  writeFileSync(join(sessionsDir(), `${session}.pauses`, 'partial.json'), '');
  assert.deepEqual(await stop(session), {});
  assert.match(await fx.gate(session, 'status'), /partial\.json \(unreadable\)/);
  await fx.gate(session, 'resume');
  assert.equal((await stop(session)).decision, 'block');
});

test('second review: schedule checks the time when it records, and the continuation names --ref', async () => {
  const { session, id, t: delegate } = await scenario('working');
  delegate.assistant('done');
  fx.delegate(delegate, 'idle');
  assert.match((await stop(session)).reason, /schedule .* --ref <file>/);
  const ref = join(fx.dir, `wake-late-${seq}.md`);
  writeFileSync(ref, 'arranged');
  const lock = join(sessionsDir(), `${session}.json.lock`);
  writeFileSync(lock, JSON.stringify({ token: 'held', pid: process.pid, host: hostname(), at: new Date().toISOString() }));
  const pending = fx.gate(session, 'schedule', id, '--owner', 'h', '--at', new Date(Date.now() + 800).toISOString(), '--ref', ref);
  await new Promise(resolve => setTimeout(resolve, 1200));
  (await import('node:fs')).rmSync(lock, { force: true });
  await assert.rejects(pending, /must be in the future/);
});

test('third review: an unreadable record at the final read fails open with a warning', async () => {
  const { session } = await scenario('working');
  const saved = readFileSync(fx.record, 'utf8');
  const out = await onStop({ hook_event_name: 'Stop', session_id: session }, fx.env, { afterObserve: () => writeFileSync(fx.record, '{broken') })
    .catch(error => ({ thrown: error.message }));
  writeFileSync(fx.record, saved);
  assert.match(out.thrown ?? '', /malformed record/);
  // Through the hook, the same failure is a warning and the turn ends.
  const hooked = await fx.hook({ hook_event_name: 'Stop', session_id: session, _: writeFileSync(fx.record, '{broken') });
  writeFileSync(fx.record, saved);
  assert.equal(hooked.decision, undefined);
  assert.match(hooked.systemMessage, /stop gate error/);
});

test('third review: a send that drops out of view ends the wait without credit', async () => {
  const { session, id, t, since } = await scenario('working', { enrollArgs: ['--max-unacted', '1', '--wait-seconds', '5'] });
  assert.equal((await stop(session)).decision, 'block');
  // The same delegate, now showing a transcript in which the watched send does not appear.
  const other = piTranscript(fx.dir, `gone${seq}`, { sessionId: t.sessionId });
  const earlier = new Date(Date.parse(since) - 60_000).toISOString();
  other.user('an older instruction', earlier);
  other.assistant('an older reply', 'stop', earlier);
  setTimeout(() => fx.delegate(other, 'working'), 500);
  assert.match(await fx.gate(session, 'wait', id, '--every', '1'), /no longer visible/);
  fx.delegate(t, 'working');
  assert.equal((await stop(session)).decision, undefined);
  assert.equal(stateOf(session).watches[id].state, 'needs-attention');
});

test('third review: a pause landing during the last wait observation prevents credit', async () => {
  const { session, id, t } = await scenario('working', { enrollArgs: ['--max-unacted', '1', '--wait-seconds', '30'] });
  assert.equal((await stop(session)).decision, 'block');
  let calls = 0;
  fx.setDelay(async () => {
    if (++calls !== 2) return;
    await fx.gate(session, 'pause');
    t.assistant('done');
    fx.delegate(t, 'idle');
  });
  const out = await fx.gate(session, 'wait', id, '--every', '1');
  fx.setDelay(null);
  assert.match(out, /not counted as acting .*paused/);
  await fx.gate(session, 'resume');
  assert.equal((await stop(session)).decision, undefined);
  assert.equal(stateOf(session).watches[id].state, 'needs-attention');
});

test('third review: a wait cannot credit a newer continuation', async () => {
  const { session, id } = await scenario('working', { enrollArgs: ['--max-unacted', '2', '--wait-seconds', '5'] });
  assert.equal((await stop(session)).decision, 'block');
  const waiting = fx.gate(session, 'wait', id, '--every', '1');
  await new Promise(resolve => setTimeout(resolve, 1500));
  assert.equal((await stop(session)).decision, 'block'); // a newer continuation while the first wait runs
  assert.match(await waiting, /not counted as acting .*watch changed/);
  assert.equal(stateOf(session).watches[id].unacted, 2);
});

test('third review: a Stop process ended mid-observation leaves no lock, and resume works', async () => {
  const { session } = await scenario('working');
  let arrived;
  const inFlight = new Promise(resolve => { arrived = resolve; });
  fx.setDelay(() => { arrived(); return new Promise(() => {}); });
  const child = spawn('node', [gateScript, 'hook'], { env: fx.env, stdio: ['pipe', 'ignore', 'ignore'] });
  child.stdin.end(JSON.stringify({ hook_event_name: 'Stop', session_id: session }));
  await inFlight;
  child.kill('SIGKILL');
  await new Promise(resolve => child.on('exit', resolve));
  fx.setDelay(null);
  assert.equal(existsSync(join(sessionsDir(), `${session}.json.lock`)), false);
  await interrupt(session);
  assert.match(await fx.gate(session, 'resume'), /resumed/);
});

test('reconciliation: a watch re-armed during the check is inspected, not omitted; a settled one drops', async () => {
  const { session, id } = await scenario('working');
  const t2 = piTranscript(fx.dir, `r${seq}`);
  await fx.recordCli('assign', `${id}-b`, '--title', 'b', '--accountable', 'astra', '--implementer', t2.sessionId);
  fx.delegate(t2, 'working');
  await fx.gate(session, 'watch', `${id}-b`, '--since', new Date(Date.now() - 1000).toISOString());
  const out = await onStop({ hook_event_name: 'Stop', session_id: session }, fx.env, {
    afterObserve: async () => {
      await fx.gate(session, 'settle', id);
      await fx.gate(session, 'watch', `${id}-b`, '--since', new Date().toISOString());
    },
  });
  assert.equal(out.decision, 'block');
  assert.doesNotMatch(out.reason, new RegExp(`- ${id} \\(`));
  assert.match(out.reason, new RegExp(`- ${id}-b .*could not be established .*the watch changed`));
});

test('fourth review: a Stop in flight while a wait credits the previous continuation does not inherit that credit', async () => {
  const { session, id, t } = await scenario('working', { enrollArgs: ['--max-unacted', '1', '--wait-seconds', '30'] });
  assert.equal((await stop(session)).decision, 'block'); // continuation c1
  const waiting = fx.gate(session, 'wait', id, '--every', '1');
  await new Promise(resolve => setTimeout(resolve, 300));
  const out = await onStop({ hook_event_name: 'Stop', session_id: session }, fx.env, {
    afterObserve: async () => { t.assistant('done'); fx.delegate(t, 'idle'); assert.match(await waiting, /reply-observed/); },
  });
  assert.equal(out.decision, 'block'); // c2: c1 was credited, so the count started again
  assert.equal(stateOf(session).watches[id].unacted, 1);
  const next = await stop(session); // c2 was not acted on
  assert.equal(next.decision, undefined);
  assert.equal(stateOf(session).watches[id].state, 'needs-attention');
});

test('fourth review: a resume during the check supersedes an early pause; unobserved watches are inspected', async () => {
  const { session, id } = await scenario('working');
  await fx.gate(session, 'pause');
  const out = await onStop({ hook_event_name: 'Stop', session_id: session }, fx.env, { afterObserve: () => fx.gate(session, 'resume') });
  assert.equal(out.decision, 'block');
  assert.match(out.reason, new RegExp(`- ${id} .*not observed in this check`));
});

test('fourth review: a full wait with a lost observation in the middle earns no credit', async () => {
  const { session, id, t } = await scenario('working', { enrollArgs: ['--max-unacted', '1', '--wait-seconds', '5'] });
  assert.equal((await stop(session)).decision, 'block');
  setTimeout(() => fx.forget(t), 1200);
  setTimeout(() => fx.delegate(t, 'working'), 2600);
  assert.match(await fx.gate(session, 'wait', id, '--every', '1'), /could not be observed at every poll/);
  assert.equal((await stop(session)).decision, undefined);
  assert.equal(stateOf(session).watches[id].state, 'needs-attention');
});
