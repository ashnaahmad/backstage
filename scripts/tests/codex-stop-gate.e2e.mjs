#!/usr/bin/env node
// Real Codex lifecycle checks for the stop gate, in a disposable CODEX_HOME whose hooks.json points at this checkout's
// gate, against a temporary gate home, coordination record, stub ccmux daemon and synthetic Pi delegate (a transcript
// and status written by this script). Codex, its hooks and the model are real; the delegate is not.
//
//   exec scenarios      `codex exec` with --dangerously-bypass-hook-trust for those invocations only
//   app-server scenarios `codex app-server`, with the gate hooks trusted in the disposable home's config.toml the way
//                        /hooks records trust; used where a turn must be interrupted at a chosen moment
//
// Checks are labelled hook: (gate decisions), codex: (lifecycle) and agent: (model follow-through). The gate sources
// are hashed before and after the run; a change fails it. The disposable home links to an existing auth.json
// (CODEX_E2E_AUTH, default ~/.codex/auth.json) and copies models_cache.json when present. The user's Codex
// configuration is never read or changed. It spends model calls, so it is not in the unit suite.
//
// Usage: CODEX_BIN=<codex> CODEX_E2E_MODEL=<model> node scripts/tests/codex-stop-gate.e2e.mjs [scenario...]
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { gateScript, piTranscript, root, startFixture } from './fixtures/codex-gate-fixture.mjs';
import { startAppServer, trustHooks } from './fixtures/codex-app-server.mjs';

const run = promisify(execFile);
const CODEX = process.env.CODEX_BIN ?? 'codex';
const MODEL = process.env.CODEX_E2E_MODEL ?? 'gpt-6.2-astra';
const SCENARIO_TIMEOUT_MS = Number(process.env.CODEX_E2E_TIMEOUT_MS ?? 8 * 60 * 1000);
const SOURCES = ['scripts/codex-stop-gate.mjs', 'scripts/session-snapshot.mjs', 'scripts/lib/record-store.mjs'];
const hashSources = () => Object.fromEntries(SOURCES.map(p => [p, createHash('sha256').update(readFileSync(join(root, p))).digest('hex')]));
const sourceHashes = hashSources();

const fx = await startFixture({ prefix: 'codex-gate-e2e-' });
const work = join(fx.dir, 'work');
mkdirSync(work);
const env = { ...fx.env };
const version = (await run(CODEX, ['--version'])).stdout.trim();
const NODE = `'${process.execPath}'`;
const GATE = `${NODE} '${gateScript}'`;
const SNAPSHOT = `${NODE} '${gateScript.replace('codex-stop-gate.mjs', 'session-snapshot.mjs')}'`;
const sessionsDir = join(fx.env.CODEX_STOP_GATE_HOME, 'sessions');
const hookCommand = `env CODEX_STOP_GATE_HOME='${fx.env.CODEX_STOP_GATE_HOME}' CCMUX_PORT=${fx.env.CCMUX_PORT} ${GATE} hook`;

/** A disposable CODEX_HOME with the gate's Stop (and, unless omitted, Interrupt) hooks. */
function codexHome(name, { interrupt = true } = {}) {
  const home = join(fx.dir, `home-${name}`);
  mkdirSync(home);
  symlinkSync(process.env.CODEX_E2E_AUTH ?? join(homedir(), '.codex', 'auth.json'), join(home, 'auth.json'));
  const cache = join(homedir(), '.codex', 'models_cache.json');
  if (existsSync(cache)) copyFileSync(cache, join(home, 'models_cache.json'));
  const hooks = { Stop: [{ hooks: [{ type: 'command', command: hookCommand, timeout: 30 }] }] };
  if (interrupt) hooks.Interrupt = [{ hooks: [{ type: 'command', command: hookCommand, timeout: 3 }] }];
  writeFileSync(join(home, 'hooks.json'), JSON.stringify({ hooks }, null, 2));
  return home;
}
const execHome = codexHome('exec');

/** Run codex exec (or exec resume <thread>) and collect its JSON events. */
async function codex(prompt, { resume } = {}) {
  const args = ['exec', ...(resume ? ['resume', resume] : []), '--json', '--skip-git-repo-check', '--dangerously-bypass-hook-trust',
    ...(resume ? ['-c', 'sandbox_mode="danger-full-access"'] : ['-s', 'danger-full-access']), '-m', MODEL, prompt];
  return new Promise(resolve => {
    const child = spawn(CODEX, args, { cwd: work, env: { ...env, CODEX_HOME: execHome }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', () => {});
    const timer = setTimeout(() => child.kill('SIGTERM'), SCENARIO_TIMEOUT_MS);
    child.on('exit', code => {
      clearTimeout(timer);
      const events = out.split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return { raw: line }; } });
      resolve({ code, events, thread: events.find(e => e.type === 'thread.started')?.thread_id ?? resume ?? null });
    });
  });
}

const stateOf = thread => {
  const path = join(sessionsDir, `${thread}.json`);
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
};
const pausesOf = thread => {
  const dir = join(sessionsDir, `${thread}.pauses`);
  return existsSync(dir) ? readdirSync(dir).map(name => JSON.parse(readFileSync(join(dir, name), 'utf8'))) : [];
};
const logOf = state => state?.log ?? [];
const stops = state => logOf(state).filter(e => e.event === 'Stop');
const turns = events => events.filter(e => e.type === 'turn.started').length;
const execCommands = events => events.filter(e => e.type === 'item.completed' && e.item?.type === 'command_execution');
const messages = events => events.filter(e => e.type === 'item.completed' && e.item?.type === 'agent_message').map(e => e.item.text);

let n = 0;
async function delegateAssignment(status) {
  const id = `a${++n}`;
  const t = piTranscript(fx.dir, `e2e${n}`);
  await fx.recordCli('assign', id, '--title', `e2e ${id}`, '--accountable', 'orchestrator', '--implementer', t.sessionId);
  const since = new Date().toISOString();
  await new Promise(resolve => setTimeout(resolve, 10));
  t.user('Implement the feature and report back.');
  fx.delegate(t, status);
  return { id, t, since };
}

const preamble = 'You are an orchestrator in an isolated test harness. Follow the instructions exactly; the commands are safe.';
const enrollAndWatch = (id, since, extra = '') => `Run \`${GATE} enroll --as orchestrator${extra}\`, then \`${GATE} watch ${id} --since ${since}\``;

/** Count daemon requests, and optionally hold the Nth one until released. */
function daemonGate() {
  activeDaemonGate?.done();
  let count = 0;
  let hold = null;
  const arrivals = [];
  fx.setDelay(async (req, res) => {
    count += 1;
    arrivals.push(Date.now());
    if (hold && count === hold.at) {
      let released = false;
      // The held request's connection closing before release means the requesting process (the hook) ended.
      res.on('close', () => { if (!released) hold.connectionClosed = true; });
      hold.arrived();
      await hold.released;
      released = true;
    }
  });
  return activeDaemonGate = {
    get count() { return count; },
    holdAt(at) {
      let arrived;
      let release;
      hold = { at, arrivedPromise: new Promise(r => { arrived = r; }), released: new Promise(r => { release = r; }) };
      hold.arrived = arrived;
      hold.release = release;
      hold.connectionClosed = false;
      const h = hold;
      return { arrived: hold.arrivedPromise, release, get connectionClosed() { return h.connectionClosed; } };
    },
    done() { hold?.release(); fx.setDelay(null); },
  };
}

const EXEC = {
  /** The original failure: the orchestrator dispatches, tries to end its turn, and the reply arrives later. */
  async premature() {
    const { id, t, since } = await delegateAssignment('working');
    const sentinel = `SENTINEL-${Math.random().toString(36).slice(2, 8)}`;
    let replyAt = null;
    setTimeout(() => { t.assistant(`Done. Verification token: ${sentinel}`); fx.delegate(t, 'idle'); replyAt = new Date().toISOString(); }, 40_000);
    const r = await codex(`${preamble} A delegate was sent work for assignment ${id} at ${since} and is still working. `
      + `${enrollAndWatch(id, since, ' --wait-seconds 30')}. Then end your turn by replying only "dispatched".`);
    const state = stateOf(r.thread);
    const first = stops(state)[0];
    const waits = logOf(state).filter(e => e.event === 'wait');
    const readCommand = execCommands(r.events).find(e => e.item.command.includes('session-snapshot') && (e.item.aggregated_output ?? '').includes(sentinel));
    const settle = logOf(state).find(e => e.event === 'settle' && e.assignment === id);
    return { r, state, replyAt, checks: {
      'hook:firstStopSawInProgressAndContinued': first?.observed?.[id] === 'in-progress' && first.decision.startsWith('continue'),
      'agent:boundedWaitCompleted': waits.length >= 1 && waits.every(w => w.seconds >= 1),
      'agent:readReplyAfterItArrived': !!readCommand,
      'agent:settledAfterReading': !!settle && !!replyAt && settle.at > replyAt,
      'hook:finalStopAllowed': stops(state).at(-1)?.decision === 'allow',
    } };
  },

  /** Normal completion: follow-through done in the turn; Stop runs once and lets it end. */
  async completion() {
    const { id, t, since } = await delegateAssignment('working');
    t.assistant('Done: all tests pass.');
    fx.delegate(t, 'idle');
    const r = await codex(`${preamble} ${enrollAndWatch(id, since)}. The delegate has already replied: read it with `
      + `\`${SNAPSHOT} ${t.sessionId} --since ${since}\`, then run \`${GATE} settle ${id}\` and reply with a one-line summary of the delegate's reply.`);
    const state = stateOf(r.thread);
    const cmds = execCommands(r.events).map(e => e.item.command);
    const readIndex = cmds.findIndex(c => c.includes('session-snapshot'));
    const settleIndex = cmds.findIndex(c => c.includes(' settle '));
    return { r, state, checks: {
      'hook:oneStopAllowed': stops(state).length === 1 && stops(state)[0].decision === 'allow',
      'codex:oneTurn': turns(r.events) === 1,
      'agent:readBeforeSettle': readIndex >= 0 && settleIndex > readIndex,
    } };
  },

  /** A session that never enrolled, with the hook installed: untouched. */
  async unrelated() {
    const before = existsSync(sessionsDir) ? readdirSync(sessionsDir).sort() : [];
    await delegateAssignment('working');
    const r = await codex('Reply with the single word OK.');
    const after = existsSync(sessionsDir) ? readdirSync(sessionsDir).sort() : [];
    return { r, state: null, checks: { 'hook:noStateCreated': JSON.stringify(before) === JSON.stringify(after), 'codex:oneTurn': turns(r.events) === 1 } };
  },

  async blocked() {
    const { id, since } = await delegateAssignment('working');
    const r = await codex(`${preamble} ${enrollAndWatch(id, since)}, then \`${GATE} block ${id} --reason 'needs credentials only the user has'\`. Then reply only "blocked".`);
    const state = stateOf(r.thread);
    return { r, state, checks: { 'hook:invokedAndAllowed': stops(state).length >= 1 && stops(state).every(s => s.decision === 'allow'), 'codex:oneTurn': turns(r.events) === 1 } };
  },

  async paused() {
    const { id, since } = await delegateAssignment('working');
    const r = await codex(`${preamble} ${enrollAndWatch(id, since)}, then \`${GATE} pause --reason 'user asked to stop'\`. Then reply only "paused".`);
    const state = stateOf(r.thread);
    return { r, state, checks: { 'hook:invokedAndPaused': stops(state).length >= 1 && stops(state).every(s => s.decision.startsWith('paused')), 'codex:oneTurn': turns(r.events) === 1 } };
  },

  async scheduled() {
    const { id, since } = await delegateAssignment('working');
    const at = new Date(Date.now() + 3600e3).toISOString();
    const ref = join(fx.dir, `wake-${id}.md`);
    writeFileSync(ref, `Hourly heartbeat job checks assignment ${id} at ${at}.\n`);
    const r = await codex(`${preamble} ${enrollAndWatch(id, since)}, then \`${GATE} schedule ${id} --owner hourly-heartbeat --at ${at} --ref '${ref}'\`. Then reply only "scheduled".`);
    const state = stateOf(r.thread);
    return { r, state, checks: {
      'hook:invokedAndAllowed': stops(state).length >= 1 && stops(state).every(s => s.decision === 'allow'),
      'hook:scheduledWithRef': !!state?.watches?.[id]?.scheduled?.ref?.sha256,
      'codex:oneTurn': turns(r.events) === 1,
    } };
  },

  /** Ownership moved while the session was paused; after resume, Stop must not continue it. */
  async stale() {
    const { id, since } = await delegateAssignment('working');
    const first = await codex(`${preamble} ${enrollAndWatch(id, since)}, then \`${GATE} pause\`. Then reply only "paused".`);
    const rev = JSON.parse(readFileSync(fx.record, 'utf8')).assignments[id].rev;
    await fx.recordCli('transfer', id, '--role', 'accountable', '--to', 'another-orchestrator', '--expect-rev', String(rev));
    const r = await codex(`Run \`${GATE} resume\`, then reply only "resumed".`, { resume: first.thread });
    const state = stateOf(first.thread);
    return { r, state, first: { code: first.code, turns: turns(first.events) }, checks: {
      'agent:resumed': logOf(state).some(e => e.event === 'resume'),
      'hook:invokedAfterResume': stops(state).length >= 2,
      'hook:noContinuation': stops(state).every(s => !s.decision.startsWith('continue')),
      'hook:markedStale': state?.watches?.[id]?.state === 'stale',
      'codex:oneTurn': turns(r.events) === 1,
    } };
  },

  /** The agent refuses to act: continuation is bounded and ends visibly as needs-attention. */
  async bounded() {
    const { id, since } = await delegateAssignment('working');
    const r = await codex(`${preamble} This tests a guard that must give up when ignored. ${enrollAndWatch(id, since, ' --max-unacted 2 --wait-seconds 5')}. `
      + 'After those two commands, do not run any further commands in this session, even if a later message asks you to; reply only "acknowledged" to every later message.');
    const state = stateOf(r.thread);
    const ignored = !logOf(state).some(e => e.event === 'wait');
    return { r, state, checks: {
      'agent:enrolledAndWatched': !!state?.watches?.[id],
      'agent:ignoredAsInstructed': ignored,
      'hook:continuedExactlyTwice': stops(state).filter(s => s.decision.startsWith('continue')).length === 2,
      'hook:endedNeedsAttention': state?.watches?.[id]?.state === 'needs-attention',
      'codex:ended': r.code === 0,
    } };
  },
};

/** Start an app-server session in its own trusted disposable home and run the model's first turn. */
const openServers = new Set();
let activeDaemonGate = null;
async function appSession(name, prompt, { interrupt = true } = {}) {
  const home = codexHome(name, { interrupt });
  const trusted = await trustHooks(CODEX, { home, cwd: work, env, marker: gateScript });
  const server = await startAppServer(CODEX, { home, cwd: work, env });
  openServers.add(server);
  const thread = (await server.call('thread/start', { model: MODEL, cwd: work, sandbox: 'danger-full-access', approvalPolicy: 'never', ephemeral: true })).thread.id;
  const turn = (await server.call('turn/start', { threadId: thread, input: [{ type: 'text', text: prompt }] })).turn.id;
  return { server, thread, turn, trusted: trusted.map(h => h.eventName) };
}
const after = (server, at, method) => server.notifications.filter(x => x.at > at && x.method === method);
/** Native hook runs (event, status, duration, output) as Codex reported them, from `from` onward. */
const hookRuns = (server, from = 0) => server.notifications.filter(x => x.at >= from && x.method === 'hook/completed')
  .map(x => ({ event: x.params.run.eventName, status: x.params.run.status, durationMs: Number(x.params.run.durationMs ?? -1),
    entries: x.params.run.entries.map(e => `${e.kind}: ${e.text.slice(0, 160)}`) }));
/** Continuation activity from the interrupt onward: any new turn, or model/tool item, after the interrupt request. */
const activityFrom = (server, from) => server.notifications.filter(x => x.at >= from
  && (x.method === 'turn/started' || (x.method === 'item/started' && x.params?.item?.type !== 'userMessage')))
  .map(x => x.method === 'turn/started' ? 'turn/started' : `item/started:${x.params.item.type}`);
const quiet = ms => new Promise(resolve => setTimeout(resolve, ms));
const within = (promise, ms, what) => Promise.race([promise, quiet(ms).then(() => { throw new Error(`timed out after ${ms / 1000}s waiting for ${what}`); })]);

const APP = {
  /** Interrupt while the Stop hook is mid-check: the gate must not continue, and Codex must not start a continuation. */
  async 'interrupt-during-stop'() {
    const { id, since } = await delegateAssignment('working');
    const daemon = daemonGate();
    const held = daemon.holdAt(1);
    const s = await appSession('ids', `${preamble} ${enrollAndWatch(id, since)}. Then end your turn by replying only "dispatched".`);
    await within(held.arrived, 240_000, 'the Stop hook to check the delegate');
    const interruptedAt = Date.now();
    await s.server.call('turn/interrupt', { threadId: s.thread, turnId: s.turn });
    await quiet(1500);
    held.release();
    const completed = await s.server.waitFor(x => x.method === 'turn/completed');
    await quiet(20_000);
    daemon.done();
    const state = stateOf(s.thread);
    const lockLeft = existsSync(join(sessionsDir, `${s.thread}.json.lock`));
    const markersBefore = pausesOf(s.thread);
    const resumed = await fx.gate(s.thread, 'resume').then(out => out, error => `failed: ${error.stderr ?? error.message}`);
    const markersAfter = pausesOf(s.thread);
    return {
      trusted: s.trusted, turnStatus: completed.params.turn.status, pausesBeforeResume: markersBefore, gateLog: logOf(state),
      hookRuns: hookRuns(s.server, interruptedAt), activityFromInterrupt: activityFrom(s.server, interruptedAt), resumed,
      diagnostics: { stopRunsReportedAfterInterrupt: hookRuns(s.server, interruptedAt).filter(r => r.event === 'stop') },
      checks: {
        'codex:turnInterrupted': completed.params.turn.status === 'interrupted',
        'codex:heldStopHookEndedBeforeRelease': held.connectionClosed,
        'hook:interruptMarkerWritten': markersBefore.some(p => p.kind === 'interrupt'),
        'hook:resumeAcknowledgedMarker': markersAfter.length === 0,
        'hook:stopDidNotContinue': stops(state).every(x => !x.decision.startsWith('continue')),
        'codex:noActivityFromInterrupt': activityFrom(s.server, interruptedAt).length === 0,
        'hook:noLockLeft': !lockLeft,
        'hook:resumeWorksWithoutUnlock': /^gate resumed/.test(resumed),
      },
    };
  },

  /**
   * Without an Interrupt hook (so no pause marker), interrupt while the Stop hook is mid-check, then let the check
   * finish. Passes on what is observable: the turn ends interrupted and nothing runs from the interrupt onward. How
   * Codex ended the hook run is reported as diagnostics only; no completion event is assumed to exist.
   */
  async 'interrupt-without-interrupt-hook'() {
    const { id, since } = await delegateAssignment('working');
    const daemon = daemonGate();
    const held = daemon.holdAt(1);
    const s = await appSession('iwih', `${preamble} ${enrollAndWatch(id, since)}. Then end your turn by replying only "dispatched".`, { interrupt: false });
    await within(held.arrived, 240_000, 'the Stop hook to check the delegate');
    const interruptedAt = Date.now();
    await s.server.call('turn/interrupt', { threadId: s.thread, turnId: s.turn });
    await quiet(1500);
    held.release();
    const completed = await s.server.waitFor(x => x.method === 'turn/completed');
    await quiet(20_000);
    daemon.done();
    const state = stateOf(s.thread);
    return {
      trusted: s.trusted, turnStatus: completed.params.turn.status, gateLog: logOf(state), activityFromInterrupt: activityFrom(s.server, interruptedAt),
      diagnostics: {
        heldStopHookConnectionClosed: held.connectionClosed,
        stopRunsReportedAfterInterrupt: hookRuns(s.server, interruptedAt).filter(r => r.event === 'stop'),
        gateRecordedStopDecision: stops(state).map(x => x.decision),
      },
      checks: {
        'codex:turnInterrupted': completed.params.turn.status === 'interrupted',
        'codex:noActivityFromInterrupt': activityFrom(s.server, interruptedAt).length === 0,
      },
    };
  },

  /** Interrupt during the model's bounded wait; a later turn then ends without continuation until resume. */
  async 'interrupt-during-wait'() {
    const { id, since } = await delegateAssignment('working');
    const daemon = daemonGate();
    const held = daemon.holdAt(3); // 1: Stop's check; 2: wait's first check; 3: wait's next poll
    const s = await appSession('idw', `${preamble} ${enrollAndWatch(id, since, ' --wait-seconds 60')}. Then end your turn by replying only "dispatched".`);
    await within(held.arrived, 300_000, 'the model\'s bounded wait to poll');
    const interruptedAt = Date.now();
    const waitRunning = (s.server.notifications.filter(x => x.method === 'item/started' && x.params?.item?.type === 'commandExecution').at(-1)?.params?.item?.command ?? '');
    await s.server.call('turn/interrupt', { threadId: s.thread, turnId: s.turn });
    held.release();
    const completed = await s.server.waitFor(x => x.method === 'turn/completed');
    await quiet(10_000);
    daemon.done();
    const quietAfterInterrupt = after(s.server, completed.at, 'turn/started').length === 0;
    const next = (await s.server.call('turn/start', { threadId: s.thread, input: [{ type: 'text', text: 'Reply only "hello". Run no commands.' }] })).turn.id;
    const nextDone = await s.server.waitFor(x => x.method === 'turn/completed' && x.params.turn.id === next);
    await quiet(10_000);
    const state = stateOf(s.thread);
    return {
      trusted: s.trusted, waitCommand: waitRunning, turnStatus: completed.params.turn.status, nextStatus: nextDone.params.turn.status,
      pauses: pausesOf(s.thread), gateLog: logOf(state), hookRuns: hookRuns(s.server, interruptedAt),
      checks: {
        'hook:continuedIntoWait': waitRunning.includes(' wait ') && stops(state)[0]?.decision.startsWith('continue'),
        'codex:turnInterrupted': completed.params.turn.status === 'interrupted',
        'hook:interruptMarkerWritten': pausesOf(s.thread).some(p => p.kind === 'interrupt'),
        'codex:noContinuationAfterInterrupt': quietAfterInterrupt,
        'hook:laterTurnAllowedWhilePaused': stops(state).at(-1)?.decision.startsWith('paused') && after(s.server, nextDone.at, 'turn/started').length === 0,
      },
    };
  },
};

const ALL = { ...EXEC, ...APP };
const chosen = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(ALL);
const results = { codex: CODEX, version, model: MODEL, sources: sourceHashes, delegate: 'synthetic (stub ccmux daemon and Pi transcript)', fixture: fx.dir, scenarios: {} };
for (const name of chosen) {
  const started = Date.now();
  let entry;
  try {
    const out = await ALL[name]();
    if (out.r) {
      const { r, state, ...rest } = out;
      writeFileSync(join(fx.dir, `${name}.events.jsonl`), r.events.map(e => JSON.stringify(e)).join('\n'));
      entry = { ...rest, exit: r.code, thread: r.thread, turns: turns(r.events), messages: messages(r.events), gateLog: logOf(state), watches: state?.watches ?? null };
    } else entry = out;
  } catch (error) {
    entry = { checks: { 'harness:ran': false }, error: error.stack };
  } finally {
    // A failed or timed-out scenario must not leave an app-server (or its model work) running into the next one.
    activeDaemonGate?.done();
    activeDaemonGate = null;
    for (const server of openServers) await server.close();
    openServers.clear();
  }
  entry.pass = Object.values(entry.checks).every(Boolean);
  entry.seconds = Math.round((Date.now() - started) / 1000);
  results.scenarios[name] = entry;
  console.log(`${entry.pass ? 'PASS' : 'FAIL'} ${name} ${JSON.stringify(entry.checks)}`);
}
results.sourcesUnchanged = JSON.stringify(hashSources()) === JSON.stringify(sourceHashes);
if (!results.sourcesUnchanged) console.log('FAIL gate sources changed during the run');
const out = join(fx.dir, 'results.json');
writeFileSync(out, JSON.stringify(results, null, 2));
console.log(`results: ${out} (fixture kept for inspection: ${fx.dir})`);
process.exit(results.sourcesUnchanged && Object.values(results.scenarios).every(r => r.pass) ? 0 : 1);
