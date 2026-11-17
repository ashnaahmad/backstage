// session-snapshot.mjs against synthetic Pi transcripts (branching, oversized and partial lines, scan limits)
// and against transcripts written by real Pi in RPC mode with a scripted model. A stub HTTP server on a free port
// stands in for the ccmux daemon's GET /sessions; no tmux, ccmux daemon or live session is touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { analyzePiTranscript, readLinesBackwards, envelopeFromHead } from '../session-snapshot.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const script = join(root, 'scripts/session-snapshot.mjs');
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'session-snapshot-')));
test.after(() => rmSync(dir, { recursive: true, force: true }));
const run = promisify(execFile);

// --- synthetic Pi transcripts, in Pi's serialisation order (type, id, parentId, timestamp, ...) ---
let clock = Date.parse('2026-11-17T10:00:00.000Z');
let counter = 0;
function transcript(name) {
  const path = join(dir, `${name}.jsonl`);
  let leaf = null;
  const write = entry => { appendFileSync(path, `${JSON.stringify(entry)}\n`); leaf = entry.id; return entry; };
  write({ type: 'session', version: 3, id: `session-${name}`, timestamp: new Date(clock).toISOString(), cwd: dir });
  leaf = null;
  const entry = (type, extra, parentId = leaf) => {
    clock += 1000;
    return write({ type, id: `e${++counter}`, parentId, timestamp: new Date(clock).toISOString(), ...extra });
  };
  return {
    path,
    sessionId: `session-${name}`,
    entry,
    at: () => new Date(clock).toISOString(),
    user: (text, parentId) => entry('message', { message: { role: 'user', content: [{ type: 'text', text }], timestamp: clock } }, parentId),
    assistant: (text, stopReason = 'stop', parentId) => entry('message', { message: { role: 'assistant',
      content: [{ type: 'thinking', thinking: 'PRIVATE-REASONING' }, ...(text ? [{ type: 'text', text }] : []),
        ...(stopReason === 'toolUse' ? [{ type: 'toolCall', id: 't', name: 'bash', arguments: { command: 'true' } }] : [])],
      stopReason, timestamp: clock } }, parentId),
    toolResult: (text, parentId) => entry('message', { message: { role: 'toolResult', toolCallId: 't', content: [{ type: 'text', text }] } }, parentId),
    branchSummary: parentId => entry('branch_summary', { fromId: leaf, summary: 'abandoned path' }, parentId),
    raw: text => appendFileSync(path, text),
  };
}

// --- stub daemon: GET /sessions answers with the current list ---
let daemonSessions = [];
const daemon = createServer((req, res) => {
  if (req.method !== 'GET' || req.url !== '/sessions') { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ sessions: daemonSessions }));
});
await new Promise(resolve => daemon.listen(0, '127.0.0.1', resolve));
test.after(() => daemon.close());
const cliEnv = { ...process.env, CCMUX_PORT: String(daemon.address().port) };
const piSession = (t, status, extra = {}) => ({ id: 'pi_pane7', agentType: 'pi', tmuxPane: '%7', tmuxTarget: 'w:1.1',
  nativeSessionId: t?.sessionId ?? null, logPath: t?.path ?? null, status, statusChangedAt: '2026-11-17T10:00:00.000Z',
  previousStatus: null, ...extra });
const cli = (sessions, ...args) => { daemonSessions = sessions; return run('node', [script, ...args], { env: cliEnv }); };
async function snapshot(sessions, ...args) {
  const { stdout } = await cli(sessions, ...args, '--json');
  return JSON.parse(stdout);
}

test('previous reply, newer instruction, active work, eventual reply', async () => {
  const t = transcript('sequence');
  t.user('first task');
  const r1 = t.assistant('waiting, worktree clean');
  const sentAt = t.at();
  const u2 = t.user('second task');
  let s = await snapshot([piSession(t, 'working')], 'pi_pane7', '--since', sentAt);
  assert.equal(s.verdict, 'in-progress');
  assert.equal(s.transcript.latestUserMessage.entryId, u2.id);
  assert.equal(s.transcript.latestReply.entryId, r1.id);
  assert.equal(s.transcript.latestReply.order, 'before-latest-user-message');
  assert.equal(s.transcript.userMessagesAfterLatestReply, 1);
  assert.deepEqual(s.transcript.sinceWindow.userMessages.map(i => i.entryId), [u2.id]);
  assert.equal(s.transcript.sinceWindow.complete, true);
  assert.equal(s.transcript.afterLatestUserMessage.last, null);

  t.assistant('', 'toolUse');
  t.toolResult('ok');
  s = await snapshot([piSession(t, 'working')], '%7');
  assert.equal(s.verdict, 'in-progress');
  assert.equal(s.transcript.afterLatestUserMessage.last.stopReason, 'toolUse');
  assert.equal(s.transcript.latestReply.entryId, r1.id);

  const r2 = t.assistant('second done');
  s = await snapshot([piSession(t, 'working')], t.sessionId);
  assert.equal(s.verdict, 'reply-observed-still-working');
  assert.equal(s.transcript.latestReply.entryId, r2.id);
  assert.equal(s.transcript.latestReply.order, 'after-latest-user-message');
  s = await snapshot([piSession(t, 'idle')], 'pi_pane7');
  assert.equal(s.verdict, 'reply-observed');
  assert.equal(s.transcript.latestReply.text, 'second done');
  assert.ok(!JSON.stringify(s).includes('PRIVATE-REASONING'), 'thinking blocks are never exported');
  assert.ok(!JSON.stringify(s).includes('"command"'), 'tool calls are never exported');
});

test('steering inside a turn: the window lists both instructions and says it cannot pair them', async () => {
  const t = transcript('steer');
  t.user('old'); t.assistant('old reply');
  const since = t.at();
  const u1 = t.user('task'); t.assistant('', 'toolUse'); t.toolResult('ok');
  const u2 = t.user('steer: also do this'); const r = t.assistant('both done');
  const s = await snapshot([piSession(t, 'idle')], 'pi_pane7', '--since', since);
  assert.equal(s.verdict, 'reply-observed');
  assert.equal(s.transcript.latestUserMessage.entryId, u2.id);
  assert.equal(s.transcript.latestReply.entryId, r.id);
  assert.deepEqual(s.transcript.sinceWindow.userMessages.map(i => i.entryId), [u1.id, u2.id]);
  assert.ok(s.notes.some(n => n.includes('does not say which send')));
});

test('interrupted, errored and idle-without-reply turns keep the previous reply labelled as older', async () => {
  for (const [stop, verdict] of [['aborted', 'interrupted'], ['error', 'errored-no-reply'], ['length', 'ended-without-reply'], ['toolUse', 'idle-without-reply']]) {
    const t = transcript(`end-${stop}`);
    t.user('a'); const r = t.assistant('previous');
    t.user('b'); t.assistant('', stop);
    const s = await snapshot([piSession(t, 'idle')], 'pi_pane7');
    assert.equal(s.verdict, verdict, stop);
    assert.equal(s.transcript.latestReply.entryId, r.id);
    assert.equal(s.transcript.latestReply.order, 'before-latest-user-message');
    assert.equal(s.transcript.afterLatestUserMessage.last.stopReason, stop);
  }
  const t = transcript('idle-mid-turn');
  t.user('a'); t.assistant('', 'toolUse');
  const s = await snapshot([piSession(t, 'idle')], 'pi_pane7');
  assert.ok(s.notes.some(n => n.includes('disagree')));
});

test('a persisted branch excludes the physically newer abandoned path', async () => {
  const t = transcript('branch');
  t.user('u1'); const a1 = t.assistant('reply on kept path');
  t.user('u2 abandoned'); t.assistant('reply on abandoned path');
  const summary = t.branchSummary(a1.id); // /tree back to a1 with a summary
  const u3 = t.user('u3', summary.id); t.assistant('', 'toolUse');
  const s = await snapshot([piSession(t, 'working')], 'pi_pane7');
  assert.equal(s.transcript.latestUserMessage.entryId, u3.id);
  assert.equal(s.transcript.latestReply.entryId, a1.id, 'the abandoned reply is not reported');
  assert.equal(s.transcript.latestReply.order, 'before-latest-user-message');
  assert.equal(s.transcript.offPathMessages, 2);
  assert.equal(s.verdict, 'in-progress');
  assert.match(s.transcript.leafBasis, /not yet followed by a new entry is not visible/);
});

test('oversized lines: tool results keep the path; an unreadable assistant stop reason makes the verdict unknown', async () => {
  const big = 'x'.repeat(300 * 1024);
  const t = transcript('oversized');
  t.user('a'); t.assistant('previous');
  const u = t.user('b'); t.assistant('', 'toolUse'); t.toolResult(big); const r = t.assistant('done');
  let s = await snapshot([piSession(t, 'idle')], 'pi_pane7');
  assert.equal(s.verdict, 'reply-observed');
  assert.equal(s.transcript.latestUserMessage.entryId, u.id);
  assert.equal(s.transcript.latestReply.entryId, r.id);
  assert.deepEqual(s.notes, []);

  const t2 = transcript('oversized-assistant');
  t2.user('a'); const prev = t2.assistant('previous');
  t2.user('b'); t2.assistant(big, 'stop');
  s = await snapshot([piSession(t2, 'idle')], 'pi_pane7');
  assert.equal(s.verdict, 'unknown');
  assert.equal(s.transcript.afterLatestUserMessage.last.stopReason, 'unknown');
  assert.equal(s.transcript.latestReply.entryId, prev.id);
  assert.ok(s.notes.some(n => n.includes('too large')));
});

test('an unterminated oversized newest line is not trusted from its envelope', async () => {
  const t = transcript('partial-oversized');
  t.user('a'); const r = t.assistant('reply');
  t.raw(`{"type":"message","id":"partial","parentId":"${r.id}","timestamp":"${new Date(clock + 1000).toISOString()}","message":{"role":"user","content":[{"type":"text","text":"${'p'.repeat(300 * 1024)}`);
  const s = await snapshot([piSession(t, 'working')], 'pi_pane7');
  assert.equal(s.verdict, 'unknown');
  assert.equal(s.transcript.newestLineUnreadable, true);
  assert.notEqual(s.transcript.latestUserMessage?.entryId, 'partial');
  assert.equal(s.transcript.latestReply.entryId, r.id);
});

test('a partially written newest line is reported, and the rest is still read', async () => {
  const t = transcript('partial');
  t.user('a'); const r = t.assistant('reply');
  t.raw('{"type":"message","id":"half","parentId":"');
  const s = await snapshot([piSession(t, 'working')], 'pi_pane7');
  assert.equal(s.transcript.latestReply.entryId, r.id);
  assert.equal(s.verdict, 'unknown', 'a half-written entry may be a newer instruction');
  assert.ok(s.notes.some(n => n.includes('incomplete')));
});

test('--since with no instruction in the window, and a transcript file newer than the window', async () => {
  const t = transcript('since');
  t.user('a'); t.assistant('reply');
  const later = new Date(clock + 60_000).toISOString();
  let s = await snapshot([piSession(t, 'idle')], 'pi_pane7', '--since', later);
  assert.equal(s.verdict, 'no-user-message-since');
  assert.ok(s.notes.some(n => n.includes('queued, undelivered')));

  const before = new Date(Date.parse(JSON.parse(readFileSync(t.path, 'utf8').split('\n')[0]).timestamp) - 60_000).toISOString();
  s = await snapshot([piSession(t, 'idle')], 'pi_pane7', '--since', before);
  assert.equal(s.transcript.sinceWindow.userMessages.length, 1);
  assert.ok(s.notes.some(n => n.includes('previous session file')));
});

test('identity: exact refs only, Pi session id from the transcript header, unsupported sessions', async () => {
  const t = transcript('identity');
  t.user('a'); t.assistant('reply');
  const sessions = [piSession(t, 'idle'),
    { id: 'codex_1', agentType: 'codex', tmuxPane: '%9', logPath: '/nonexistent', status: 'working' },
    piSession(null, 'idle', { id: 'pi_pane8', tmuxPane: '%8' })];
  // After /new the pane keeps its ccmux id but the Pi session id changes: the old Pi id no longer matches.
  await assert.rejects(cli(sessions, 'session-before-new'), /no ccmux session has exact id/);
  await assert.rejects(cli(sessions, 'pi_pane'), /no ccmux session/);
  let s = await snapshot(sessions, t.sessionId);
  assert.equal(s.session.id, 'pi_pane7');
  assert.equal(s.transcript.sessionId, t.sessionId);
  assert.equal(s.verdict, 'reply-observed');
  s = await snapshot(sessions, 'codex_1');
  assert.equal(s.verdict, 'unknown');
  assert.equal(s.activity.status, 'working');
  assert.match(s.notes[0], /Pi sessions only/);
  s = await snapshot(sessions, '%8');
  assert.equal(s.verdict, 'unknown');
  assert.match(s.notes[0], /no transcript path/);

  // ccmux points at a transcript whose header names another Pi session.
  s = await snapshot([piSession(t, 'idle', { nativeSessionId: 'session-A' })], 'session-A');
  assert.equal(s.verdict, 'unknown');
  assert.ok(s.notes.some(n => n.includes(`belongs to Pi session ${t.sessionId}`)));
});

test('the daemon is read, never started: an unreachable port is an error', async () => {
  const closed = createServer();
  await new Promise(resolve => closed.listen(0, '127.0.0.1', resolve));
  const port = closed.address().port;
  await new Promise(resolve => closed.close(resolve));
  await assert.rejects(run('node', [script, 'pi_pane7'], { env: { ...process.env, CCMUX_PORT: String(port) } }),
    /not reachable at http:\/\/127\.0\.0\.1:\d+\/sessions .*does not start it/);
});

test('--since lists by timestamp across the whole path, and absence needs complete, dated evidence', async () => {
  // Wall-clock timestamps need not increase along the path.
  const t = transcript('clock');
  const u1 = t.entry('message', { timestamp: '2026-11-17T10:10:00.000Z', message: { role: 'user', content: [{ type: 'text', text: 'a' }] } });
  t.entry('message', { timestamp: '2026-11-17T10:11:00.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'r1' }], stopReason: 'stop' } });
  t.entry('message', { timestamp: '2026-11-17T10:00:00.000Z', message: { role: 'user', content: [{ type: 'text', text: 'b' }] } });
  t.entry('message', { timestamp: '2026-11-17T10:01:00.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'r2' }], stopReason: 'stop' } });
  let s = await snapshot([piSession(t, 'idle')], 'pi_pane7', '--since', '2026-11-17T10:05:00Z');
  assert.deepEqual(s.transcript.sinceWindow.userMessages.map(i => i.entryId), [u1.id]);
  assert.notEqual(s.verdict, 'no-user-message-since');

  const undated = transcript('undated');
  undated.entry('message', { timestamp: undefined, message: { role: 'user', content: [{ type: 'text', text: 'a' }] } });
  undated.assistant('reply');
  s = await snapshot([piSession(undated, 'idle')], 'pi_pane7', '--since', '2026-11-17T09:00:00Z');
  assert.equal(s.verdict, 'unknown');
  assert.equal(s.transcript.sinceWindow.undated, 1);

  // An extension message may start a turn that no user message records.
  const ext = transcript('extension');
  ext.user('a'); ext.assistant('reply');
  const since = new Date(clock + 500).toISOString();
  const custom = ext.entry('custom_message', { customType: 'x', content: 'context', display: true });
  s = await snapshot([piSession(ext, 'working')], 'pi_pane7', '--since', since);
  assert.equal(s.verdict, 'unknown');
  assert.deepEqual(s.transcript.sinceWindow.extensionMessages.map(i => i.entryId), [custom.id]);
  assert.ok(s.notes.some(n => n.includes('extension message')));
  // Without --since too: the older reply is not reported as following the latest instruction.
  s = await snapshot([piSession(ext, 'working')], 'pi_pane7');
  assert.equal(s.verdict, 'unknown');
  assert.equal(s.transcript.extensionMessagesAfterLatestReply, 1);
});

test('a missing parentId breaks the path instead of ending it', async () => {
  const t = transcript('noparent');
  t.user('a'); t.assistant('old');
  t.raw(`${JSON.stringify({ type: 'message', id: 'orphan', timestamp: new Date(clock += 1000).toISOString(), message: { role: 'user', content: [{ type: 'text', text: 'b' }] } })}\n`);
  t.assistant('', 'toolUse', 'orphan');
  const s = await snapshot([piSession(t, 'working')], 'pi_pane7', '--since', '2026-01-01T00:00:00Z');
  assert.equal(s.transcript.pathComplete, false);
  assert.equal(s.transcript.pathBroken, true);
  assert.equal(s.transcript.sinceWindow.complete, false);
  assert.ok(s.notes.some(n => n.includes('no valid parentId')));
});

test('--no-text removes transcript text from JSON and text output; text output states the leaf basis', async () => {
  const t = transcript('notext');
  t.user('SECRET-PROMPT'); t.assistant('SECRET-REPLY');
  let { stdout } = await cli([piSession(t, 'idle')], 'pi_pane7', '--json', '--no-text');
  assert.ok(!stdout.includes('SECRET'), stdout);
  assert.equal(JSON.parse(stdout).verdict, 'reply-observed');
  ({ stdout } = await cli([piSession(t, 'idle')], 'pi_pane7', '--no-text'));
  assert.ok(!stdout.includes('SECRET'), stdout);
  ({ stdout } = await cli([piSession(t, 'idle')], 'pi_pane7'));
  assert.match(stdout, /SECRET-REPLY/);
  assert.match(stdout, /unsaved \/tree navigation is not visible/);
  assert.match(stdout, /^verdict \(persisted path, ccmux-reported activity\): reply-observed$/m);
});

test('scan limit reports what it could not settle', async () => {
  const t = transcript('limit');
  t.user('a'); t.assistant('old reply');
  t.user('b');
  for (let i = 0; i < 40; i++) { t.assistant('', 'toolUse'); t.toolResult('y'.repeat(2000)); }
  const a = await analyzePiTranscript(t.path, { maxScanBytes: 20_000 });
  assert.equal(a.latestReply, null);
  assert.equal(a.latestUserMessage, null);
  assert.equal(a.userMessagesAfterLatestReply, null);
  assert.ok(a.notes.some(n => n.includes('scan stopped')));
});

test('backwards line reader matches a forward split across chunk boundaries and multi-byte text', async () => {
  const path = join(dir, 'lines.txt');
  const lines = Array.from({ length: 200 }, (_, i) => `${i} ${'é🙂'.repeat(i % 17)} ${'z'.repeat(i * 3)}`);
  writeFileSync(path, `${lines.join('\n')}\n`);
  const seen = [];
  for await (const line of readLinesBackwards(path, { chunkSize: 37 })) seen.push(line.text);
  assert.deepEqual(seen.reverse(), lines);
  const head = '{"type":"message","id":"abc","parentId":null,"timestamp":"2026-01-01T00:00:00.000Z","message":{"role":"toolResult","content":"';
  assert.deepEqual(envelopeFromHead(head), { type: 'message', id: 'abc', parentId: null, timestamp: '2026-01-01T00:00:00.000Z', role: 'toolResult' });
  assert.equal(envelopeFromHead('{"message":{}}'), null);
});

// --- real Pi: the transcript schema the snapshot reads is the one Pi writes ---
const modules = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
const piDist = join(modules, '@earendil-works/pi-coding-agent/dist');
const sleep = ms => new Promise(done => setTimeout(done, ms));

test('real Pi transcript: reply, newer instruction mid-tool, steering, reply, then an aborted turn', async () => {
  const work = join(dir, 'pi');
  const sessionDir = join(work, 'sessions');
  execFileSync('mkdir', ['-p', sessionDir]);
  writeFileSync(join(work, 'scripted.ts'), `import { fauxProvider, fauxAssistantMessage, fauxToolCall, fauxThinking, fauxText } from '@earendil-works/pi-ai';
export default function (pi) {
  const faux = fauxProvider({ provider: 'faux', models: [{ id: 'scripted' }] });
  faux.setResponses([
    fauxAssistantMessage([fauxThinking('PRIVATE-REASONING'), fauxText('first reply')]),
    fauxAssistantMessage(fauxToolCall('bash', { command: 'sleep 2' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage('second reply'),
    fauxAssistantMessage(fauxToolCall('bash', { command: 'sleep 5' }), { stopReason: 'toolUse' }),
  ]);
  pi.registerProvider(faux.provider);
}
`);
  const { RpcClient } = await import(pathToFileURL(join(piDist, 'modes/rpc/rpc-client.js')).href);
  const env = { ...process.env, PI_CODING_AGENT_DIR: join(work, 'agent') };
  delete env.TMUX;
  delete env.TMUX_PANE;
  const client = new RpcClient({ cliPath: join(piDist, 'cli.js'), cwd: work, env, provider: 'faux', model: 'scripted',
    args: ['--offline', '-ne', '--session-dir', sessionDir, '-e', join(work, 'scripted.ts')] });
  await client.start();
  try {
    await client.promptAndWait('first task');
    const path = join(sessionDir, readdirSync(sessionDir).find(name => name.endsWith('.jsonl')));
    const file = () => ({ path, sessionId: JSON.parse(readFileSync(path, 'utf8').split('\n')[0]).id });
    let s = await snapshot([piSession(file(), 'idle')], 'pi_pane7');
    assert.equal(s.verdict, 'reply-observed');
    assert.equal(s.transcript.latestReply.text, 'first reply');
    assert.ok(!JSON.stringify(s).includes('PRIVATE-REASONING'));
    const firstReply = s.transcript.latestReply.entryId;

    const since = new Date().toISOString();
    const done = client.promptAndWait('second task');
    await sleep(800); // inside `sleep 2`
    await client.steer('steer: and this');
    s = await snapshot([piSession(file(), 'working')], 'pi_pane7', '--since', since);
    assert.equal(s.verdict, 'in-progress');
    assert.equal(s.transcript.latestReply.entryId, firstReply);
    assert.equal(s.transcript.latestReply.order, 'before-latest-user-message');
    assert.equal(s.transcript.afterLatestUserMessage.last.stopReason, 'toolUse');
    assert.equal(s.transcript.sinceWindow.userMessages.length, 1, 'the queued steer is not in the transcript yet');
    await done;
    s = await snapshot([piSession(file(), 'idle')], 'pi_pane7', '--since', since);
    assert.equal(s.verdict, 'reply-observed');
    assert.equal(s.transcript.latestReply.text, 'second reply');
    assert.equal(s.transcript.sinceWindow.userMessages.length, 2, 'task and delivered steer');
    assert.match(s.transcript.latestUserMessage.preview, /steer: and this/);

    const aborted = client.promptAndWait('third task').catch(() => {});
    await sleep(800);
    await client.abort();
    await aborted;
    await sleep(300);
    s = await snapshot([piSession(file(), 'idle')], 'pi_pane7');
    assert.equal(s.transcript.latestReply.text, 'second reply');
    assert.equal(s.transcript.latestReply.order, 'before-latest-user-message');
    assert.match(s.transcript.latestUserMessage.preview, /third task/);
    assert.equal(s.verdict, 'interrupted');
    assert.equal(s.transcript.afterLatestUserMessage.last.stopReason, 'aborted');
  } finally {
    await client.stop();
  }
});
