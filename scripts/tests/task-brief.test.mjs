// Task-brief restoration through real Pi (RPC mode, scripted faux model) and the real coordination-record CLI.
// The model records every request it receives, so assertions concern what reached the model, not only what the
// extension wrote. Temporary HOME, agent dir, sessions and record; no tmux, daemon or live session is touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, unlinkSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const cliPath = join(root, 'scripts/coordination-record.mjs');
const extension = join(root, 'pi/extensions/task-brief.ts');
const piDist = join(execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim(), '@earendil-works/pi-coding-agent/dist');
const { RpcClient } = await import(pathToFileURL(join(piDist, 'modes/rpc/rpc-client.js')).href);

const dir = realpathSync(mkdtempSync(join(tmpdir(), 'task-brief-')));
test.after(() => { if (!process.env.KEEP_TEST_DIR) rmSync(dir, { recursive: true, force: true }); else console.log('kept', dir); });

// The scripted model: logs each request; "TOOL: <cmd>" in the newest user text runs one bash call, then replies.
const scripted = join(dir, 'scripted.ts');
writeFileSync(scripted, `import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { appendFileSync } from 'node:fs';
const text = m => typeof m.content === 'string' ? m.content : (m.content ?? []).map(b => b.text ?? '').join('');
export default function (pi) {
  const respond = context => {
    const messages = context.messages.filter(m => m.role !== 'system');
    const system = context.messages.filter(m => m.role === 'system').map(text).join('');
    const summarising = system.includes('summarization');
    appendFileSync(process.env.REQUEST_LOG, JSON.stringify({ summarising, messages: messages.map(m => ({ role: m.role, text: text(m) })) }) + '\\n');
    if (summarising) return fauxAssistantMessage('SUMMARY OF EARLIER WORK');
    const instruction = messages.findLastIndex(m => m.role === 'user' && !text(m).startsWith('Current task brief'));
    const tool = /TOOL: (.*)$/.exec(text(messages[instruction] ?? {}));
    const ran = messages.slice(instruction + 1).some(m => m.role === 'toolResult');
    if (tool && !ran) return fauxAssistantMessage(fauxToolCall('bash', { command: tool[1] }), { stopReason: 'toolUse' });
    return fauxAssistantMessage('ok');
  };
  const faux = fauxProvider({ provider: 'faux', models: [{ id: 'scripted' }, { id: 'small', contextWindow: 8000, maxTokens: 1000 }] });
  faux.setResponses(Array.from({ length: 60 }, () => respond));
  pi.registerProvider(faux.provider);
}
`);

// Test-only commands for operations RPC has no command for: /tree navigation and /reload.
const control = join(dir, 'control.ts');
writeFileSync(control, `export default function (pi) {
  pi.registerCommand('test-nav', { handler: async (args, ctx) => {
    const [target, label] = args.trim().split(/\\s+/);
    await ctx.waitForIdle();
    await ctx.navigateTree(target, { summarize: false, ...(label ? { label } : {}) });
  } });
  pi.registerCommand('test-reload', { handler: async (_args, ctx) => { await ctx.waitForIdle(); await ctx.reload(); } });
}
`);

// A preload for the coordination-record CLI only: when armed, it changes the record after a \`brief\` read has
// finished and before the extension looks at the files again, the window in which a result can be paired with a
// newer file state. Armed by a JSON file: { remaining, assignment, args | steps } runs \`<args> --expect-rev <current>\`,
// with steps giving each invocation its own args in turn.
const preload = join(dir, 'race-preload.mjs');
writeFileSync(preload, `import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const armed = process.env.BRIEF_RACE_FILE;
if (armed && process.argv[1]?.endsWith('coordination-record.mjs') && process.argv[2] === 'brief') {
  process.on('exit', () => {
    if (!existsSync(armed)) return;
    const spec = JSON.parse(readFileSync(armed, 'utf8'));
    if (spec.steps) spec.args = spec.steps.shift();
    if (spec.remaining <= 1) unlinkSync(armed); else writeFileSync(armed, JSON.stringify({ ...spec, remaining: spec.remaining - 1 }));
    const record = process.argv[process.argv.indexOf('--record') + 1];
    const rev = JSON.parse(readFileSync(record, 'utf8')).assignments[spec.assignment].rev;
    const env = { ...process.env, COORDINATION_ACTOR: 'orchestrator' };
    delete env.NODE_OPTIONS;
    execFileSync(process.execPath, [process.argv[1], ...spec.args, '--record', record, '--expect-rev', String(rev)], { env });
  });
}
`);

let n = 0;
function world() {
  const base = join(dir, `w${++n}`);
  mkdirSync(base);
  for (const sub of ['home', 'agent', 'sessions', 'work', 'records', 'briefs']) mkdirSync(join(base, sub));
  writeFileSync(join(base, 'agent/settings.json'), JSON.stringify({
    compaction: { keepRecentTokens: 50, modelOverrides: { 'faux/small': { reserveTokens: 1500, keepRecentTokens: 500 } } } }));
  const record = join(base, 'records/record.json');
  const log = join(base, 'requests.jsonl');
  writeFileSync(log, '');
  const env = { ...process.env, HOME: join(base, 'home'), PI_CODING_AGENT_DIR: join(base, 'agent'), REQUEST_LOG: log,
    COORDINATION_RECORD: record, COORDINATION_ACTOR: 'orchestrator', XDG_CONFIG_HOME: join(base, 'home/.config'),
    XDG_STATE_HOME: join(base, 'home/.state'), XDG_DATA_HOME: join(base, 'home/.data') };
  delete env.TMUX;
  delete env.TMUX_PANE;
  const rec = (...args) => execFileSync('node', [cliPath, ...args], { env, encoding: 'utf8' }).trim();
  const rev = id => Number(/\(rev (\d+)\)/.exec(rec('show', id))[1]);
  const brief = (name, text) => { const path = join(base, 'briefs', name); writeFileSync(path, text); return path; };
  const requests = () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const lastRequest = () => requests().filter(r => !r.summarising).at(-1);
  async function pi(args, { withRecord = true, extraEnv = {} } = {}) {
    const clientEnv = { ...env, ...extraEnv };
    if (!withRecord) delete clientEnv.COORDINATION_RECORD;
    const client = new RpcClient({ cliPath: join(piDist, 'cli.js'), cwd: join(base, 'work'), env: clientEnv,
      provider: 'faux', model: 'scripted',
      args: ['--offline', '-ne', '-ns', '-np', '--session-dir', join(base, 'sessions'), '-e', scripted, '-e', control, '-e', extension, ...args] });
    await client.start();
    return client;
  }
  return { base, record, env, rec, rev, brief, requests, lastRequest, pi };
}

// Bounded so a broken implementation fails instead of hanging the suite.
const PROMPT_MS = 15_000;
const TEST = { timeout: 90_000 };
const ask = (client, text) => client.promptAndWait(text, undefined, PROMPT_MS);
const restorations = request => request.messages.filter(m => m.text.startsWith('Current task brief, restored'));
const sessionFile = (w, id) => join(w.base, 'sessions', readdirSync(join(w.base, 'sessions')).find(f => f.includes(id)));

test('start, no duplicate, idle and mid-run brief changes, unrecorded edit, missing file, transfer', TEST, async () => {
  const w = world();
  const id = randomUUID();
  const v1 = w.brief('brief.md', 'Implement the parser.\nExcluded: do not touch the CLI.\n');
  w.rec('init');
  w.rec('assign', 'a1', '--title', 'Parser', '--accountable', 'orchestrator', '--implementer', id, '--brief', v1);
  const client = await w.pi(['--session-id', id]);
  try {
    await ask(client, 'start the task');
    let r = restorations(w.lastRequest());
    assert.equal(r.length, 1, 'restored once at session start');
    assert.match(r[0].text, /\(session start\)/);
    assert.match(r[0].text, /Excluded: do not touch the CLI\./);

    await ask(client, 'continue');
    assert.equal(restorations(w.lastRequest()).length, 1, 'no repeat without a transition');

    // A status update changes the record revision but not the brief: no restoration.
    w.rec('update', 'a1', '--expect-rev', String(w.rev('a1')), '--status', 'halfway');
    await ask(client, 'continue again');
    assert.equal(restorations(w.lastRequest()).length, 1, 'status-only updates do not re-inject');

    // Correction recorded while idle: delivered with the next prompt, flagged as changed.
    writeFileSync(v1, 'Implement the parser.\nExcluded: do not touch the CLI.\nCorrection: keep the old error format.\n');
    w.rec('update', 'a1', '--expect-rev', String(w.rev('a1')), '--brief', v1);
    await ask(client, 'next step');
    r = restorations(w.lastRequest());
    assert.equal(r.length, 2);
    assert.match(r[1].text, /\(assignment changed\)/);
    assert.match(r[1].text, /has changed since the restoration earlier in this context/);
    assert.match(r[1].text, /Correction: keep the old error format\./);

    // Correction recorded during a tool call: reaches the very next request of the same run.
    const v3 = w.brief('brief-v3.md', 'Implement the parser.\nCorrection: also accept tabs.\n');
    const update = `COORDINATION_ACTOR=orchestrator node ${cliPath} update a1 --expect-rev ${w.rev('a1')} --brief ${v3}`;
    await ask(client, `TOOL: ${update}`);
    const run = w.requests().filter(q => !q.summarising).slice(-1)[0];
    const toolIndex = run.messages.findIndex(m => m.role === 'toolResult');
    const restoredIndex = run.messages.findIndex(m => m.text.includes('Correction: also accept tabs.'));
    assert.ok(toolIndex >= 0 && restoredIndex > toolIndex, 'restored after the tool result, before the next request');

    // The file edited without being recorded: notice only, the edit itself is not presented as the brief.
    writeFileSync(v3, 'Implement the parser.\nUNRECORDED: delete the tests.\n');
    await ask(client, 'carry on');
    r = restorations(w.lastRequest());
    assert.match(r.at(-1).text, /has changed since the assignment recorded it/);
    assert.match(r.at(-1).text, /grants no permission/);
    assert.ok(!JSON.stringify(w.lastRequest()).includes('UNRECORDED'), 'unrecorded edit never reaches the model');

    // Missing file.
    unlinkSync(v3);
    await ask(client, 'carry on 2');
    assert.match(restorations(w.lastRequest()).at(-1).text, /cannot be read now \(ENOENT\)/);

    // Transfer to another session: this one is told, and gets no brief text.
    writeFileSync(v3, 'Implement the parser.\nCorrection: also accept tabs.\n');
    w.rec('transfer', 'a1', '--role', 'implementer', '--to', randomUUID(), '--expect-rev', String(w.rev('a1')));
    await ask(client, 'carry on 3');
    const last = restorations(w.lastRequest()).at(-1).text;
    assert.match(last, /is not the recorded implementer of assignment a1/);
    assert.ok(!last.includes('----- brief -----'));
  } finally {
    await client.stop();
  }
});

test('resume restores again; fork, new session, a reused name and an unbound session never inherit the task', TEST, async () => {
  const w = world();
  const id = randomUUID();
  const b = w.brief('brief.md', 'Write the migration.\nExcluded: production data.\n');
  w.rec('init');
  w.rec('assign', 'a1', '--title', 'Migration', '--accountable', 'orchestrator', '--implementer', id, '--brief', b);
  // A second assignment whose implementer string is a name, which must not bind a session with that name.
  w.rec('assign', 'a2', '--title', 'Other', '--accountable', 'orchestrator', '--implementer', 'shared-name', '--brief', b);

  let client = await w.pi(['--session-id', id, '--name', 'shared-name']);
  try {
    await ask(client, 'begin');
    assert.equal(restorations(w.lastRequest()).length, 1);
    assert.match(restorations(w.lastRequest())[0].text, /Assignment a1:/, 'bound by id, not by the name a2 records');
  } finally {
    await client.stop();
  }

  // A fresh process on the same session (resume), without COORDINATION_RECORD: the path comes from the session.
  client = await w.pi(['--session', sessionFile(w, id)], { withRecord: false });
  try {
    await ask(client, 'back again');
    const r = restorations(w.lastRequest());
    assert.equal(r.length, 2, 'restored again on resume though the brief is unchanged');
    assert.match(r[1].text, /\(session start\)/);

    // In-process switch: /new gets nothing (unbound, no earlier restoration on its branch).
    await client.newSession();
    await ask(client, 'fresh session');
    assert.equal(restorations(w.lastRequest()).length, 0);

    // Switch back (resume reason), then fork: the fork carries the restorations but is not the implementer.
    await client.switchSession(sessionFile(w, id));
    await ask(client, 'resumed');
    assert.match(restorations(w.lastRequest()).at(-1).text, /\(session resume\)/);
    const entries = (await client.getForkMessages());
    await client.fork(entries.at(-1).entryId);
    const forkId = (await client.getState()).sessionId;
    assert.notEqual(forkId, id);
    await ask(client, 'in the fork');
    const last = restorations(w.lastRequest()).at(-1).text;
    assert.match(last, /\(fork\)/);
    assert.match(last, new RegExp(`This session \\(${forkId}\\) is not the recorded implementer of assignment a1`));
  } finally {
    await client.stop();
  }

  // A session with the record configured but no binding, named like a recorded implementer: silent.
  client = await w.pi(['--name', 'shared-name']);
  try {
    await ask(client, 'unrelated work');
    assert.equal(restorations(w.lastRequest()).length, 0);
  } finally {
    await client.stop();
  }
});

test('compaction: manual while idle restores with the next prompt; threshold inside a run restores before the next request', TEST, async () => {
  const w = world();
  const id = randomUUID();
  const b = w.brief('brief.md', 'Refactor the store.\nUnresolved: lock timeout value, ask root.\n');
  w.rec('init');
  w.rec('assign', 'a1', '--title', 'Store', '--accountable', 'orchestrator', '--implementer', id, '--brief', b);
  const client = await w.pi(['--session-id', id]);
  try {
    await ask(client, `TOOL: printf '${'y'.repeat(2000)}'`);
    await ask(client, 'second');
    await client.compact();
    await ask(client, 'after manual compaction');
    let r = restorations(w.lastRequest());
    assert.match(r.at(-1).text, /\(after compaction\)/);
    assert.match(r.at(-1).text, /Unresolved: lock timeout value/);
    assert.ok(w.lastRequest().messages.some(m => m.text.includes('SUMMARY OF EARLIER WORK')), 'context really was compacted');

    await client.setModel('faux', 'small');
    const big = 'x'.repeat(6000);
    const before = w.requests().length;
    await ask(client, `TOOL: printf '${big}'; printf '${big}'`);
    await ask(client, `TOOL: printf '${big}'`);
    const later = w.requests().slice(before);
    const summaryAt = later.findIndex(q => q.summarising);
    assert.ok(summaryAt >= 0, 'threshold compaction happened');
    const next = later.slice(summaryAt + 1).find(q => !q.summarising);
    assert.ok(next, 'a request followed the compaction');
    r = restorations(next);
    assert.equal(r.length, 1, 'exactly one restoration in the compacted context');
    assert.match(r[0].text, /\(after compaction\)/);
  } finally {
    await client.stop();
  }
});

test('an unreadable record is reported to a bound session, never treated as an empty brief', TEST, async () => {
  const w = world();
  const id = randomUUID();
  const b = w.brief('brief.md', 'Task.\n');
  w.rec('init');
  w.rec('assign', 'a1', '--title', 'T', '--accountable', 'orchestrator', '--implementer', id, '--brief', b);
  const client = await w.pi(['--session-id', id]);
  try {
    await ask(client, 'one');
    writeFileSync(w.record, '{not json');
    await ask(client, 'two');
    const last = restorations(w.lastRequest()).at(-1).text;
    assert.match(last, /could not be read/);
    assert.match(last, /grants no permission/);
  } finally {
    await client.stop();
  }
});

// An extension command is handled without starting a run; its handler has finished when prompt() resolves.
const command = async (client, text) => {
  const disposition = await client.prompt(text);
  assert.equal(disposition?.disposition ?? disposition, 'handled', `${text} ran as a command`);
};
const bind = (w, extra = {}) => {
  const id = randomUUID();
  const b = w.brief('brief.md', 'Do the task.\nExcluded: the CLI.\n');
  w.rec('init');
  w.rec('assign', 'a1', '--title', 'Task', '--accountable', 'orchestrator', '--implementer', id, '--brief', b);
  return { id, b };
};

test('a change landing between the read and the file check is not missed (observation consistency)', TEST, async () => {
  const w = world();
  const { id } = bind(w);
  const race = join(w.base, 'race.json');
  const client = await w.pi(['--session-id', id], { extraEnv: { NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`, BRIEF_RACE_FILE: race } });
  try {
    await ask(client, 'one');
    // The next read is followed at once by a transfer away from this session.
    writeFileSync(race, JSON.stringify({ remaining: 1, assignment: 'a1', args: ['transfer', 'a1', '--role', 'implementer', '--to', randomUUID()] }));
    await ask(client, 'TOOL: true');
    const run = w.requests().filter(q => !q.summarising).slice(-2);
    assert.match(run[1].messages.map(m => m.text).join('\n'), /is not the recorded implementer of assignment a1/,
      'the transfer reaches the model within the same run');
  } finally {
    await client.stop();
  }
});

test('repeated movement defers restoration honestly and keeps the transition for the next boundary', TEST, async () => {
  const w = world();
  const { id } = bind(w);
  const race = join(w.base, 'race.json');
  // Every read during startup is followed by a status update, so no read is stable until the movement stops.
  writeFileSync(race, JSON.stringify({ remaining: 3, assignment: 'a1', args: ['update', 'a1', '--status', 'moving'] }));
  const client = await w.pi(['--session-id', id], { extraEnv: { NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`, BRIEF_RACE_FILE: race } });
  try {
    await ask(client, 'TOOL: true');
    const [first, second] = w.requests().filter(q => !q.summarising);
    assert.equal(restorations(first).length, 0, 'nothing delivered while the record kept moving');
    assert.equal(restorations(second).length, 1, 'delivered at the next boundary once stable');
    assert.match(restorations(second)[0].text, /\(session start\)/, 'the start transition survived the deferral');
  } finally {
    await client.stop();
  }
});

test('tree navigation and restart keep the binding from session history; reload follows the context', TEST, async () => {
  const w = world();
  const { id } = bind(w);
  let client = await w.pi(['--session-id', id]);
  try {
    await ask(client, 'first');
    const [firstUser] = await client.getForkMessages();
    await ask(client, 'second');
    // Unchanged context: /reload does not repeat the restoration.
    await command(client, '/test-reload');
    await ask(client, 'after plain reload');
    assert.equal(restorations(w.lastRequest()).length, 1);

    // Compaction, then /reload before the next prompt: the context lacks the brief, so it is restored.
    await ask(client, `TOOL: printf '${'y'.repeat(2000)}'`);
    await ask(client, 'more');
    await client.compact();
    await command(client, '/test-reload');
    await ask(client, 'after compaction and reload');
    assert.equal(restorations(w.lastRequest()).length, 1);
    assert.ok(w.lastRequest().messages.some(m => m.text.includes('SUMMARY OF EARLIER WORK')));

    // /tree to before the first restoration: the branch lacks it, so it is restored.
    await command(client, `/test-nav ${firstUser.entryId}`);
    await ask(client, 'on the earlier branch');
    assert.equal(restorations(w.lastRequest()).length, 1);
    assert.match(restorations(w.lastRequest())[0].text, /\(tree navigation\)/);
    // Leave the session on that earlier point; the label is written to the file, so a restart resumes there.
    await command(client, `/test-nav ${firstUser.entryId} restart-here`);
    const context = await client.getMessages();
    assert.ok(!JSON.stringify(context).includes('Current task brief'), 'the resumed branch holds no restoration');
    // The record changes meanwhile, so a restoration on restart cannot be an old one.
    w.rec('transfer', 'a1', '--role', 'accountable', '--to', 'root-3', '--expect-rev', String(w.rev('a1')));
  } finally {
    await client.stop();
  }
  // Restart on that session without COORDINATION_RECORD: the path comes from this session's history.
  client = await w.pi(['--session', sessionFile(w, id)], { withRecord: false });
  try {
    await ask(client, 'after restart');
    const r = restorations(w.lastRequest());
    assert.equal(r.length, 1);
    assert.match(r[0].text, /\(session start\)[\s\S]*Accountable: root-3\./);
  } finally {
    await client.stop();
  }
});

test('brief identity includes its path: moved identical bytes, then an edit to the new file mid-run, and an accountable change', TEST, async () => {
  const w = world();
  const { id, b } = bind(w);
  const client = await w.pi(['--session-id', id]);
  try {
    await ask(client, 'one');
    const moved = w.brief('moved.md', readFileSync(b, 'utf8'));
    w.rec('update', 'a1', '--expect-rev', String(w.rev('a1')), '--brief', moved);
    await ask(client, 'two');
    const r = restorations(w.lastRequest());
    assert.equal(r.length, 2, 'same bytes at a new path is a new identity');
    assert.ok(r[1].text.includes(moved));
    await ask(client, `TOOL: printf 'EDITED-NEW-PATH' >> ${moved}`);
    const run = w.requests().filter(q => !q.summarising).at(-1);
    assert.match(restorations(run).at(-1).text, /has changed since the assignment recorded it/, 'the new path is the one watched');
    assert.ok(!JSON.stringify(run).includes('EDITED-NEW-PATH\n-----'));

    writeFileSync(moved, readFileSync(b, 'utf8'));
    w.rec('transfer', 'a1', '--role', 'accountable', '--to', 'root-2', '--expect-rev', String(w.rev('a1')));
    await ask(client, 'three');
    assert.match(restorations(w.lastRequest()).at(-1).text, /Accountable: root-2\./);
  } finally {
    await client.stop();
  }
});

test('a bound session whose record keeps moving is told its brief is unconfirmed, then gets the actual state', TEST, async () => {
  const w = world();
  const { id } = bind(w);
  const race = join(w.base, 'race.json');
  const client = await w.pi(['--session-id', id], { extraEnv: { NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`, BRIEF_RACE_FILE: race } });
  try {
    await ask(client, 'one');
    assert.equal(restorations(w.lastRequest()).length, 1);
    // During the next check: a transfer away, then unrelated churn after every read in all three attempts (once
    // the session is no longer the implementer, an attempt reads twice: by session, then by the assignment it held).
    const steps = [['transfer', 'a1', '--role', 'implementer', '--to', randomUUID()],
      ...[1, 2, 3, 4].map(i => ['update', 'a1', '--status', `churn ${i}`])];
    writeFileSync(race, JSON.stringify({ remaining: steps.length, assignment: 'a1', steps }));
    await ask(client, 'TOOL: true');
    const [during, after] = w.requests().filter(q => !q.summarising).slice(-2);
    const latest = request => request.messages.filter(m => m.text.startsWith('Current task brief')).at(-1).text;
    assert.match(latest(during), /^Current task brief: unconfirmed\./, 'the model hears the earlier brief may be stale');
    assert.ok(!latest(during).includes('----- brief -----'), 'nothing is presented as confirmed');
    assert.match(latest(after), /is not the recorded implementer of assignment a1/, 'a later stable read restores the actual state');

    await ask(client, 'later');
    assert.equal(w.lastRequest().messages.filter(m => m.text.startsWith('Current task brief: unconfirmed')).length, 1, 'not repeated');
  } finally {
    await client.stop();
  }
});
