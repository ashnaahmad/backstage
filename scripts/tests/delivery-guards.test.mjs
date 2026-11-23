// The delivery guards and the blocking-wait guard through real Pi (RPC mode, scripted faux model), the real
// coordination-record CLI, a fake `gh`, a fake Slack tool and a fake ccmux daemon. Temporary HOME, agent dir,
// sessions and record; no tmux, real daemon, network or live session is touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const cliPath = join(root, 'scripts/coordination-record.mjs');
const guards = join(root, 'pi/extensions/delivery-guards.ts');
const waitTool = join(root, 'pi/extensions/wait.ts');
const piDist = join(execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim(), '@earendil-works/pi-coding-agent/dist');
const { RpcClient } = await import(pathToFileURL(join(piDist, 'modes/rpc/rpc-client.js')).href);

const dir = realpathSync(mkdtempSync(join(tmpdir(), 'delivery-guards-')));
test.after(() => { if (!process.env.KEEP_TEST_DIR) rmSync(dir, { recursive: true, force: true }); else console.log('kept', dir); });

const HEAD = 'a'.repeat(40);
const OLD = 'b'.repeat(40);

// The scripted model: logs each request. The newest user text containing a directive decides the response:
// "TOOL: <cmd>" runs one bash call, "SLACK: <json>" one fake Slack post, "WAIT" one 30 s wait, "SAY: <text>" replies.
const scripted = join(dir, 'scripted.ts');
writeFileSync(scripted, `import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { appendFileSync } from 'node:fs';
const text = m => typeof m.content === 'string' ? m.content : (m.content ?? []).map(b => b.text ?? '').join('');
export default function (pi) {
  const respond = context => {
    const messages = context.messages.filter(m => m.role !== 'system');
    appendFileSync(process.env.REQUEST_LOG, JSON.stringify({ messages: messages.map(m => ({ role: m.role, text: text(m) })) }) + '\\n');
    const index = messages.findLastIndex(m => m.role === 'user' && /(TOOL|SLACK2?|SAY): |WAIT/.test(text(m)));
    const instruction = text(messages[index] ?? {});
    const ran = messages.slice(index + 1).some(m => m.role === 'toolResult');
    const tool = /TOOL: (.*)$/.exec(instruction), slack = /SLACK: (.*)$/.exec(instruction), say = /SAY: (.*)$/.exec(instruction), twice = /SLACK2: (.*)$/.exec(instruction);
    if (!ran && twice) return fauxAssistantMessage([fauxToolCall('mcp__slack__slack_send_message', JSON.parse(twice[1])), fauxToolCall('mcp__slack__slack_send_message', JSON.parse(twice[1]))], { stopReason: 'toolUse' });
    if (!ran && tool) return fauxAssistantMessage(fauxToolCall('bash', { command: tool[1] }), { stopReason: 'toolUse' });
    if (!ran && slack) return fauxAssistantMessage(fauxToolCall('mcp__slack__slack_send_message', JSON.parse(slack[1])), { stopReason: 'toolUse' });
    if (!ran && /WAIT/.test(instruction)) return fauxAssistantMessage(fauxToolCall('wait', { seconds: 30 }), { stopReason: 'toolUse' });
    return fauxAssistantMessage(say ? say[1] : 'ok');
  };
  const faux = fauxProvider({ provider: 'faux', models: [{ id: 'scripted' }] });
  faux.setResponses(Array.from({ length: 80 }, () => respond));
  pi.registerProvider(faux.provider);
}
`);

// A stand-in for the Slack MCP tool: echoes a permalink, threaded when thread_ts is given.
const slack = join(dir, 'slack.ts');
writeFileSync(slack, `import { Type } from '@earendil-works/pi-ai';
export default function (pi) {
  pi.registerTool({ name: 'mcp__slack__slack_send_message', label: 'Slack', description: 'fake',
    parameters: Type.Object({ channel_id: Type.String(), message: Type.String(), thread_ts: Type.Optional(Type.String()) }),
    async execute(_id, p) {
      const link = 'https://acme.slack.com/archives/' + p.channel_id + '/p1795170289429709' + (p.thread_ts ? '?thread_ts=' + p.thread_ts : '');
      return { content: [{ type: 'text', text: 'Message sent: ' + link }], details: {} };
    } });
}
`);

let n = 0;
function world({ role = 'coordinator', actor = 'coord' } = {}) {
  const base = join(dir, `w${++n}`);
  for (const sub of ['home', 'agent', 'sessions', 'work', 'bin']) mkdirSync(join(base, sub), { recursive: true });
  writeFileSync(join(base, 'agent/settings.json'), '{}');
  const record = join(base, 'record.json');
  const log = join(base, 'requests.jsonl');
  writeFileSync(log, '');
  const ghResponse = join(base, 'gh.json');
  writeFileSync(join(base, 'bin/gh'), `#!/bin/sh\necho "$*" >> "${join(base, 'gh-calls.log')}"\nif [ "$1" = api ]; then cat "${ghResponse}"; else echo "merged"; fi\n`);
  chmodSync(join(base, 'bin/gh'), 0o755);
  const env = { ...process.env, HOME: join(base, 'home'), PI_CODING_AGENT_DIR: join(base, 'agent'), REQUEST_LOG: log,
    COORDINATION_RECORD: record, COORDINATION_ACTOR: actor, PATH: `${join(base, 'bin')}:${process.env.PATH}`,
    CCMUX_PORT: '1', XDG_CONFIG_HOME: join(base, 'home/.config'), XDG_STATE_HOME: join(base, 'home/.state'), XDG_DATA_HOME: join(base, 'home/.data') };
  if (role) env.DELIVERY_ROLE = role; else delete env.DELIVERY_ROLE;
  delete env.TMUX; delete env.TMUX_PANE;
  const rec = (...args) => execFileSync('node', [cliPath, ...args], { env, encoding: 'utf8' }).trim();
  const rev = id => Number(/\(rev (\d+)\)/.exec(rec('show', id))[1]);
  const json = () => JSON.parse(readFileSync(record, 'utf8'));
  const requests = () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const gh = pr => writeFileSync(ghResponse, JSON.stringify({ data: { repository: { pullRequest: pr } } }));
  rec('init');
  async function pi(extraEnv = {}) {
    const client = new RpcClient({ cliPath: join(piDist, 'cli.js'), cwd: join(base, 'work'), env: { ...env, ...extraEnv },
      provider: 'faux', model: 'scripted',
      args: ['--offline', '-ne', '-ns', '-np', '--session-dir', join(base, 'sessions'), '-e', scripted, '-e', slack, '-e', waitTool, '-e', guards] });
    await client.start();
    return client;
  }
  return { base, env, rec, rev, json, requests, gh, pi };
}

const PROMPT_MS = 20_000;
const TEST = { timeout: 120_000 };
const ask = (client, text) => client.promptAndWait(text, undefined, PROMPT_MS);
const all = w => w.requests().flatMap(r => r.messages.map(m => m.text)).join('\n---\n');
const lastResults = w => w.requests().at(-1).messages.filter(m => m.role === 'toolResult').map(m => m.text);
const ghPr = overrides => ({ number: 12, state: 'OPEN', isDraft: false, headRefOid: HEAD, mergeStateStatus: 'CLEAN', author: { login: 'me' },
  latestOpinionatedReviews: { nodes: [{ author: { __typename: 'User', login: 'reviewer' }, state: 'APPROVED', commit: { oid: HEAD } }] },
  reviewThreads: { nodes: [] }, commits: { nodes: [{ commit: { oid: HEAD, statusCheckRollup: { state: 'SUCCESS', contexts: { nodes: [{ name: 'CI passed', conclusion: 'SUCCESS', isRequired: true }] } } } }] }, ...overrides });
const cli = `node ${cliPath}`;

test('blocking waits are refused for coordinators and relays only; ordinary commands run', TEST, async () => {
  for (const role of ['coordinator', 'relay']) {
    const w = world({ role });
    const client = await w.pi();
    try {
      await ask(client, 'TOOL: sleep 30; echo done');
      assert.match(lastResults(w).at(-1), /Blocked: this command waits in one long shell call \(sleep 30\)/, role);
      await ask(client, 'TOOL: echo fine');
      assert.match(lastResults(w).at(-1), /^fine/);
    } finally { await client.stop(); }
  }
  const w = world({ role: null });
  const client = await w.pi();
  try {
    await ask(client, 'TOOL: sleep 6; echo slept');
    assert.match(lastResults(w).at(-1), /^slept/, 'other sessions are not restricted');
    assert.doesNotMatch(all(w), /Landing map check/, 'no delivery role, no reminder');
  } finally { await client.stop(); }
});

test('coordinator: reminder per incoming message, stall check on record change, merge guard on commands and claims', TEST, async () => {
  const w = world();
  w.rec('assign', 'a1', '--title', 'One', '--accountable', 'coord', '--implementer', 'sess-1');
  const client = await w.pi();
  try {
    await ask(client, 'SAY: hello');
    const first = w.requests().at(-1).messages.map(m => m.text);
    assert.match(first[first.indexOf('SAY: hello') + 1], /^Landing map check \(delivery guard\)/, 'the reminder follows the message');
    assert.match(first.find(t => t.startsWith('Landing map check')), /Rewrite the entry in place: the landing map holds the current state, not a log/);

    await ask(client, `TOOL: ${cli} pr a1 --expect-rev 1 --repo o/r --number 12 --head ${HEAD} --stage awaiting-review`);
    const continuation = w.requests().at(-1).messages;
    assert.equal(continuation.at(-1).role, 'toolResult');
    assert.equal(continuation.filter(m => m.text.startsWith('Landing map check')).length, 0, 'a tool-only continuation does not repeat the reminder');
    const stall = lastResults(w).at(-1);
    assert.match(stall, /Landing map stall check \(delivery guard\)/);
    assert.match(stall, /no next action with an owner/);
    assert.match(stall, /awaiting review but no review request is recorded/);
    assert.match(stall, /implementer sess-1 could not be checked/, 'an unreachable daemon is reported, not taken as quiet');

    w.rec('pr', 'a1', '--expect-rev', '2', '--next', 'wait for review', '--next-owner', 'relay');
    await ask(client, 'TOOL: echo unrelated');
    assert.match(lastResults(w).at(-1), /Landing map stall check[\s\S]*no review request/, 'a change by another writer is noticed at the next tool result');
    await ask(client, 'TOOL: echo again');
    assert.doesNotMatch(lastResults(w).at(-1), /stall check/, 'once per change');

    w.gh(ghPr({ latestOpinionatedReviews: { nodes: [{ author: { __typename: 'User', login: 'reviewer' }, state: 'APPROVED', commit: { oid: OLD } }] } }));
    await ask(client, 'TOOL: gh pr merge 12 --squash');
    const blocked = lastResults(w).at(-1);
    assert.match(blocked, /Blocked by the merge-readiness guard: o\/r#12 is not merge-ready/);
    assert.match(blocked, /no human approval on the current head/);
    assert.match(blocked, /no live QA recorded/);
    for (const command of ['gh pr merge 12 && gh pr merge 13', 'gh pr merge #12', 'gh pr merge 12 --subject "Merge --repo o/r now"', 'gh pr merge 12 --auto',
      'gh pr "merge" 12 --squash', 'gh pr merge 12 --repo']) {
      await ask(client, `TOOL: ${command}`);
      assert.match(lastResults(w).at(-1), /run the merge as a single plain command/, command);
    }
    await ask(client, 'TOOL: gh pr merge https://github.com/o/r/pull/12 --repo x/y');
    assert.match(lastResults(w).at(-1), /the merge names both o\/r and x\/y/);
    await ask(client, `TOOL: ${cli} pr a1 --expect-rev 3 --stage "merge-ready"`);
    assert.match(lastResults(w).at(-1), /not recorded: o\/r#12 is not merge-ready/, 'the record refuses the stage however it is quoted');
    assert.equal(w.json().assignments.a1.pr.stage, 'awaiting-review');

    await ask(client, `SLACK: ${JSON.stringify({ channel_id: 'C0CC', message: '<@U1> please review #12' })}`);
    assert.match(lastResults(w).at(-1), /the relay session owns review requests/);

    await ask(client, 'SAY: #12 is merge-ready.');
    assert.match(all(w), /Merge-readiness guard: your reply calls a PR merge-ready, but the check disagrees/);
    const corrections = () => w.requests().at(-1).messages.filter(m => /check disagrees/.test(m.text)).length;
    await ask(client, 'SAY: #12 is merge-ready.');
    assert.equal(corrections(), 2, 'a repeated claim in a later reply is corrected again');

    w.rec('pr', 'a1', '--expect-rev', '3', '--qa-head', HEAD);
    w.gh(ghPr({}));
    await ask(client, `TOOL: ${cli} pr a1 --expect-rev 4 --stage merge-ready`);
    assert.equal(w.json().assignments.a1.pr.stage, 'merge-ready', 'a ready PR passes');
    await ask(client, 'TOOL: gh pr merge 12 --squash');
    assert.match(readFileSync(join(w.base, 'gh-calls.log'), 'utf8'), new RegExp(`^pr merge 12 --repo o/r --squash --match-head-commit ${HEAD}$`, 'm'), 'the merge is bound to the checked PR and head');
    const before = corrections();
    await ask(client, 'SAY: #12 is merge-ready.');
    assert.equal(w.requests().at(-1).messages.filter(m => /check disagrees/.test(m.text)).length, before, 'no correction for a ready PR');
  } finally { await client.stop(); }
});

test('relay: QA on the head, recorded permalink, same thread only after a head change', TEST, async () => {
  const w = world({ role: 'relay', actor: 'relay' });
  w.rec('assign', 'a1', '--title', 'One', '--accountable', 'coord');
  w.rec('pr', 'a1', '--expect-rev', '1', '--repo', 'o/r', '--number', '12', '--head', HEAD, '--stage', 'publishing');
  w.gh(ghPr({}));
  const client = await w.pi();
  const post = args => ask(client, `SLACK: ${JSON.stringify({ channel_id: 'C0CC', ...args })}`);
  try {
    await post({ message: '<@U1> please review #12' });
    assert.match(lastResults(w).at(-1), /Blocked by the relay guard:\n- o\/r#12 \(a1\): live QA is not recorded on the head/);
    await post({ message: '<@U1> CI is green on #12' });
    assert.match(lastResults(w).at(-1), /^Message sent/, 'a post that is not a review request passes');
    assert.doesNotMatch(all(w), /Landing map check/, 'the relay gets no coordinator reminder');

    w.rec('pr', 'a1', '--expect-rev', '2', '--qa-head', HEAD);
    w.gh(ghPr({ headRefOid: OLD }));
    await post({ message: '<@U1> please review #12' });
    assert.match(lastResults(w).at(-1), /GitHub's head is bbbbbbbbbbbb, but the landing map and its QA are on aaaaaaaaaaaa/);
    w.gh(ghPr({}));
    await ask(client, `SLACK2: ${JSON.stringify({ channel_id: 'C0CC', message: '<@U1> please review #12' })}`);
    const pair = lastResults(w).slice(-2);
    assert.equal(pair.filter(t => /recorded the review request for a1/.test(t)).length, 1, 'one of two parallel posts goes out');
    assert.equal(pair.filter(t => /already being posted/.test(t)).length, 1, 'the other is held');
    const request = w.json().assignments.a1.pr.reviewRequest;
    assert.deepEqual([request.thread, request.head, request.by], ['1795170289.429709', HEAD, 'relay']);

    await post({ message: '<@U1> please review #12 again', thread_ts: '1795170289.429709' });
    assert.match(lastResults(w).at(-1), /already requested at the head/);
    w.rec('pr', 'a1', '--expect-rev', String(w.rev('a1')), '--head', OLD, '--qa-head', OLD);
    w.gh(ghPr({ headRefOid: OLD }));
    await post({ message: '<@U1> #12 has changed, please review' });
    assert.match(lastResults(w).at(-1), /post again only as a reply in that thread \(channel C0CC, thread_ts 1795170289.429709\)/);
    await post({ message: '<@U1> #12 has changed, please review', thread_ts: '1795170289.429709' });
    assert.match(lastResults(w).at(-1), /recorded the review request for a1/);
    assert.equal(w.json().assignments.a1.pr.reviewRequest.head, OLD);
  } finally { await client.stop(); }
});

test('coordinator: a delegate idle without a report is announced, ending a running wait, once per instruction', TEST, async () => {
  const w = world();
  const transcript = join(w.base, 'delegate.jsonl');
  writeFileSync(transcript, [
    { type: 'session', id: 'sess-q', timestamp: '2026-11-23T10:00:00.000Z' },
    { type: 'message', id: 'u1', parentId: null, timestamp: '2026-11-23T10:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: 'implement it' }] } },
    { type: 'message', id: 'a1', parentId: 'u1', timestamp: '2026-11-23T10:05:00.000Z', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'Done; I will keep working while you reply.' }] } },
  ].map(e => JSON.stringify(e)).join('\n') + '\n');
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ sessions: [{ id: 'pi_pane9', agentType: 'pi', nativeSessionId: 'sess-q', logPath: transcript, status: 'idle', statusChangedAt: '2026-11-23T10:05:01.000Z' }] }));
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  w.rec('assign', 'a1', '--title', 'One', '--accountable', 'coord', '--implementer', 'sess-q');
  w.rec('pr', 'a1', '--expect-rev', '1', '--repo', 'o/r', '--number', '12', '--stage', 'implementing', '--next', 'implement', '--next-owner', 'sess-q');
  const client = await w.pi({ CCMUX_PORT: String(server.address().port), DELIVERY_IDLE_CHECK_SECONDS: '1' });
  try {
    await ask(client, 'WAIT');
    const results = lastResults(w);
    assert.match(results.at(-1), /Stopped after \d+s: the user sent a message/, 'the announcement ends the wait');
    await new Promise(done => setTimeout(done, 4000));
    await ask(client, 'SAY: still here');
    const latest = w.requests().at(-1).messages.filter(m => m.text.startsWith('[From delivery-guards, automatic check] A delegate has gone quiet'));
    assert.equal(latest.length, 1, 'announced once for the same instruction, across several checks');
    assert.match(latest[0].text, /a1: idle since 2026-11-23T10:05:01.000Z with no message to its owner/);
  } finally { await client.stop(); server.close(); }
});

test('coordinator: a message steered in during a run brings the reminder with it', TEST, async () => {
  const w = world();
  const client = await w.pi();
  try {
    const done = ask(client, 'WAIT');
    await new Promise(resolve => setTimeout(resolve, 1500));
    await client.steer('[From impl-1] SAY: handoff ready');
    await done;
    for (let i = 0; i < 50 && !w.requests().some(r => r.messages.some(m => m.text.includes('[From impl-1]'))); i++) await new Promise(r => setTimeout(r, 200));
    const request = w.requests().find(r => r.messages.some(m => m.text.includes('[From impl-1]')));
    assert.ok(request, 'the steered message reached the model');
    const texts = request.messages.map(m => m.text);
    const steered = texts.findIndex(t => t.includes('[From impl-1]'));
    assert.match(texts[steered + 1], /^Landing map check/, 'the reminder follows the steered message in the same request');
    assert.equal(texts.filter(t => t.startsWith('Landing map check')).length, 1, 'the reminder is not stored, so it does not accumulate');
  } finally { await client.stop(); }
});
