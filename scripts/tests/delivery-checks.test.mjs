// The delivery guards' checks: pure functions, the record's `pr` command and the readiness CLI against a fake `gh`.
// Synthetic records, sessions and GitHub responses only; no tmux, daemon, network or live session is touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { blockingWaitReason, mergeClaims, prRefs, readinessFindings, relayPostCheck, reportSince, slackPermalink,
  stallFindings, quietDelegates } from '../lib/delivery-checks.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const recordCli = join(root, 'scripts/coordination-record.mjs');
const checkCli = join(root, 'scripts/delivery-check.mjs');
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'delivery-checks-')));
test.after(() => rmSync(dir, { recursive: true, force: true }));

const HEAD = 'a'.repeat(40);
const OLD = 'b'.repeat(40);

let n = 0;
function world() {
  const base = join(dir, `w${++n}`);
  mkdirSync(base);
  // A gh that always fails, so no test reaches GitHub; tests that need responses put their own gh first on PATH.
  mkdirSync(join(base, 'nogh'));
  writeFileSync(join(base, 'nogh/gh'), '#!/bin/sh\necho "gh unavailable in tests" >&2\nexit 1\n');
  chmodSync(join(base, 'nogh/gh'), 0o755);
  const env = { ...process.env, COORDINATION_RECORD: join(base, 'record.json'), COORDINATION_ACTOR: 'coord', PATH: `${join(base, 'nogh')}:${process.env.PATH}` };
  delete env.TMUX; delete env.TMUX_PANE;
  const rec = (...args) => execFileSync('node', [recordCli, ...args], { env, encoding: 'utf8' }).trim();
  const fail = (...args) => spawnSync('node', [recordCli, ...args], { env, encoding: 'utf8' });
  const rev = id => Number(/\(rev (\d+)\)/.exec(rec('show', id))[1]);
  const json = () => JSON.parse(execFileSync('cat', [env.COORDINATION_RECORD], { encoding: 'utf8' }));
  rec('init');
  return { base, env, rec, fail, rev, json };
}

test('blocking waits: long sleeps, sleep loops and watch commands, not short sleeps or build watchers', () => {
  for (const command of ['sleep 840; ccmux show', 'sleep 2m', 'until ccmux show | grep idle; do sleep 2; done',
    'while true; do gh pr checks 5; sleep 1; done', 'gh run watch 123', 'gh pr checks 42 --watch', 'watch -n 5 ccmux show', 'tail -f app.log', 'sleep "30"', 'command "sleep" 30', 'x=1\nsleep 10',
    'tail --follow app.log', 'while true; do echo done; sleep 1; done', 'echo x\\ #; sleep 30']) {
    assert.ok(blockingWaitReason(command), command);
  }
  for (const command of ['sleep 2 && curl localhost', 'npm run test -- --watch=false', 'git log --oneline', 'echo "sleep 900"x', 'tsc --watch', 'tail -n 20 app.log',
    'git commit -m "Stop using gh run watch in the coordinator"', 'echo sleep 30', 'for f in *; do echo $f; done && sleep 1', 'npm run watch', 'echo then sleep 30', 'echo ok # ; sleep 30', 'tail -- --follow', "cat > poll.sh <<'EOF'\nwhile true; do sleep 60; done\nEOF\nchmod +x poll.sh"]) {
    assert.equal(blockingWaitReason(command), null, command);
  }
});

test('PR references, merge claims and Slack permalinks', () => {
  assert.deepEqual(prRefs('see https://github.com/o/r/pull/12 and #34, not a&#35;'), [{ repo: 'o/r', number: 12 }, { repo: null, number: 34 }]);
  assert.deepEqual(mergeClaims('#5020 and #4890 are merge-ready. #5175 is awaiting human review, not merge-ready.'),
    [{ repo: null, number: 5020 }, { repo: null, number: 4890 }]);
  assert.deepEqual(mergeClaims('#7 will be merge-ready once the reviewer approves. Is #8 ready to merge? If #9 passes, it can be merged.'), []);
  assert.deepEqual(mergeClaims('#12 is merge-ready; I will wait for your permission.'), [{ repo: null, number: 12 }]);
  assert.deepEqual(mergeClaims('#12 is not quite ready, but #34 is ready to merge.'), [{ repo: null, number: 34 }]);
  assert.deepEqual(mergeClaims('o/r#12 is merge-ready.'), [{ repo: 'o/r', number: 12 }]);
  assert.deepEqual(mergeClaims('PR #12: merge-ready.'), [{ repo: null, number: 12 }]);
  assert.deepEqual(mergeClaims('#12 is merge-ready and will land tomorrow. #13 is merge-ready once CI passes.'), [{ repo: null, number: 12 }]);
  assert.deepEqual(slackPermalink('Posted: https://acme.slack.com/archives/C0CC/p1795170289429709?thread_ts=1795090172.516679&cid=C0CC.'),
    { permalink: 'https://acme.slack.com/archives/C0CC/p1795170289429709?thread_ts=1795090172.516679&cid=C0CC', channel: 'C0CC', ts: '1795170289.429709', threadTs: '1795090172.516679' });
  assert.equal(slackPermalink('no link'), null);
});

test('record pr entries replace values in place and validate their pairs', () => {
  const w = world();
  w.rec('assign', 'a1', '--title', 'One', '--accountable', 'coord', '--implementer', 'sess-1');
  assert.match(w.fail('pr', 'a1', '--expect-rev', '1', '--head', HEAD).stderr, /has no PR yet/);
  w.rec('pr', 'a1', '--expect-rev', '1', '--repo', 'o/r', '--number', '12', '--head', OLD, '--stage', 'qa', '--next', 'run QA', '--next-owner', 'qa-1');
  w.rec('pr', 'a1', '--expect-rev', '2', '--head', HEAD, '--qa-head', HEAD, '--stage', 'awaiting-review');
  const { pr } = w.json().assignments.a1;
  assert.equal(pr.head, HEAD);
  assert.equal(pr.stage, 'awaiting-review');
  assert.deepEqual(pr.next, { action: 'run QA', owner: 'qa-1' });
  assert.equal(pr.qa.head, HEAD);
  assert.match(w.fail('pr', 'a1', '--expect-rev', '3', '--next', 'x').stderr, /go together/);
  assert.match(w.fail('pr', 'a1', '--expect-rev', '3', '--stage', 'done').stderr, /--stage is one of/);
  assert.match(w.fail('pr', 'a1', '--expect-rev', '2', '--stage', 'qa').stderr, /conflict/);
  w.rec('assign', 'a2', '--title', 'Two', '--accountable', 'coord');
  assert.match(w.fail('pr', 'a2', '--expect-rev', '1', '--repo', 'o/r', '--number', '12').stderr, /already the PR of a1/);
  w.rec('assign', 'a3', '--title', 'Three', '--accountable', 'coord');
  assert.match(w.fail('pr', 'a3', '--expect-rev', '1', '--repo', 'O/R', '--number', '12').stderr, /o\/r#12 is already the PR of a1/, 'repo identity ignores case');
  assert.match(w.fail('pr', 'a1', '--expect-rev', '3', '--review-request', 'https://example.com/x', '--thread', '1.2', '--request-head', HEAD).stderr, /Slack permalink/);
  w.rec('pr', 'a3', '--expect-rev', '1', '--repo', 'o/r', '--number', '99', '--head', HEAD, '--stage', 'qa', '--qa-head', HEAD);
  w.rec('pr', 'a3', '--expect-rev', '2', '--repo', 'o/r', '--number', '98');
  assert.deepEqual(w.json().assignments.a3.pr, { ...w.json().assignments.a3.pr, number: 98, head: null, stage: null, qa: null, next: null, reviewRequest: null },
    'a new PR identity drops the old PR\'s facts');
  const map = w.rec('map');
  assert.match(map, /## Landing map/);
  assert.match(map, /\| a1 \| o\/r#12 \| aaaaaaaaaaaa \| awaiting-review \| run QA \(qa-1\) \| aaaaaaaaaaaa \|  \|/);
  assert.match(w.fail('pr', 'a1', '--expect-rev', '3', '--stage', 'merge-ready').stderr, /merge-readiness check for o\/r#12 could not run|not merge-ready/,
    'merge-ready needs a passing GitHub check');
  assert.equal(w.json().assignments.a1.pr.stage, 'awaiting-review');
});

const recordWith = pr => ({ assignments: { a1: { id: 'a1', accountable: { actor: 'coord' }, implementer: { session: 's1' },
  pr: { repo: 'o/r', number: 12, head: HEAD, stage: 'awaiting-review', next: null, qa: null, reviewRequest: null, ...pr } } } });

test('stall findings: missing owner, missing or stale review request, QA on another head, quiet delegates', () => {
  const findings = stallFindings(recordWith({ qa: { head: OLD } }), { actor: 'coord',
    quiet: [{ assignment: 'a1', session: 's1', ccmux: 'pi_pane9', state: 'quiet', detail: 'idle with no message' }] });
  assert.equal(findings.length, 4);
  assert.match(findings[0], /no next action with an owner/);
  assert.match(findings[1], /no review request is recorded/);
  assert.match(findings[2], /no live QA recorded on the head/);
  assert.match(findings[3], /pi_pane9 has gone quiet/);
  const settled = recordWith({ next: { action: 'wait for the reviewer', owner: 'relay' }, qa: { head: HEAD },
    reviewRequest: { permalink: 'https://x.slack.com/archives/C/p1', thread: '1.2', head: HEAD } });
  assert.deepEqual(stallFindings(settled, { actor: 'coord' }), []);
  assert.deepEqual(stallFindings(recordWith({ stage: 'landed' }), { actor: 'coord' }), []);
  assert.deepEqual(stallFindings(recordWith({}), { actor: 'someone-else' }), []);
  assert.match(stallFindings(recordWith({ stage: null, next: { action: 'x', owner: 'y' } }), { actor: 'coord' })[0], /no stage recorded/, 'an entry without a stage is still open');
  assert.match(stallFindings(recordWith({ head: null, next: { action: 'x', owner: 'y' }, reviewRequest: { permalink: 'p', thread: '1.2', head: HEAD } }), { actor: 'coord' })[0], /no head recorded/);
});

const rollup = (state, contexts) => ({ nodes: [{ commit: { oid: HEAD, statusCheckRollup: { state, contexts: { pageInfo: { hasNextPage: false }, nodes: contexts } } } }] });
const ghPr = overrides => ({ state: 'OPEN', isDraft: false, headRefOid: HEAD, mergeStateStatus: 'CLEAN', author: { login: 'me' },
  latestOpinionatedReviews: { pageInfo: { hasNextPage: false }, nodes: [{ author: { __typename: 'User', login: 'reviewer' }, state: 'APPROVED', commit: { oid: HEAD } }] },
  reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] },
  commits: rollup('SUCCESS', [{ __typename: 'CheckRun', name: 'CI passed', conclusion: 'SUCCESS', isRequired: true }]), ...overrides });

test('readiness: approval on the head, answered P1/P2 threads, CI and QA on the head', () => {
  const a = recordWith({ qa: { head: HEAD } }).assignments.a1;
  assert.deepEqual(readinessFindings(a, ghPr({})), []);
  const findings = readinessFindings(recordWith({ qa: { head: OLD } }).assignments.a1, ghPr({
    mergeStateStatus: 'BEHIND',
    latestOpinionatedReviews: { nodes: [
      { author: { __typename: 'User', login: 'reviewer' }, state: 'APPROVED', commit: { oid: OLD } },
      { author: { __typename: 'Bot', login: 'approver' }, state: 'APPROVED', commit: { oid: HEAD } }] },
    reviewThreads: { nodes: [
      { isResolved: false, comments: { nodes: [{ author: { login: 'reviewer' }, body: 'P2: this drops the filter', url: 'u1' }] }, last: { nodes: [{ author: { login: 'reviewer' } }] } },
      { isResolved: false, comments: { nodes: [{ author: { login: 'reviewer' }, body: 'P3 (nit): rename', url: 'u2' }] }, last: { nodes: [{ author: { login: 'reviewer' } }] } },
      { isResolved: false, comments: { nodes: [{ author: { login: 'reviewer' }, body: 'P1: crash', url: 'u3' }] }, last: { nodes: [{ author: { login: 'implementer' } }] } },
    ] },
    commits: rollup('FAILURE', [{ __typename: 'CheckRun', name: 'CI passed', conclusion: 'FAILURE', isRequired: true },
      { __typename: 'CheckRun', name: 'optional lint', conclusion: 'FAILURE', isRequired: false }]),
  }));
  assert.equal(findings.length, 5, findings.join('\n'));
  assert.match(findings[0], /behind its base/);
  assert.match(findings[1], /no human approval on the current head aaaaaaaaaaaa: approvals are on bbbbbbbbbbbb \(reviewer\)/, 'a bot approval does not count');
  assert.match(findings[2], /1 review thread\(s\) with no reply: P2 u1/, 'a reply by anyone answers a thread; P3 is not a blocker');
  assert.match(findings[3], /required checks not passing on the head: CI passed \(failure\)/, 'optional checks are not required');
  assert.match(findings[4], /live QA is recorded on bbbbbbbbbbbb/);
  const paged = readinessFindings(a, ghPr({ reviewThreads: { pageInfo: { hasNextPage: true }, nodes: [] } }));
  assert.deepEqual(paged, ['more than 100 review threads: not all were checked']);
});

test('relay posts: review requests need QA on the head, the recorded thread and channel, and a head change', () => {
  const base = { qa: { head: HEAD }, reviewRequest: null };
  assert.deepEqual(relayPostCheck(recordWith(base), { message: '<@U1> please review #12', channel: 'C1' }).problems, []);
  assert.deepEqual(relayPostCheck(recordWith({}), { message: '<@U1> CI is green on #12', channel: 'C1' }).problems, [], 'not a review request');
  assert.match(relayPostCheck(recordWith({}), { message: 'Please review #12 again', channel: 'C1' }).problems[0], /live QA is not recorded/, 'untagged requests are checked too');
  const requested = { ...base, reviewRequest: { permalink: 'https://x.slack.com/archives/C1/p1111111111222222', thread: '1111111111.222222', head: HEAD.slice(0, 12) } };
  const sameHead = relayPostCheck(recordWith(requested), { message: '<@U1> #12 again, please review', channel: 'C1', threadTs: '1111111111.222222' }).problems;
  assert.deepEqual(sameHead.length, 1);
  assert.match(sameHead[0], /already requested at the head/, 'an abbreviated head is the same head');
  assert.match(relayPostCheck(recordWith(requested), { message: '<@U1> review this revision', channel: 'C1', threadTs: '1111111111.222222' }).problems[0],
    /already requested at the head/, 'a request in the recorded thread is checked without naming the PR');
  const moved = { ...requested, reviewRequest: { ...requested.reviewRequest, head: OLD } };
  assert.deepEqual(relayPostCheck(recordWith(moved), { message: '<@U1> #12 has changed, please review', channel: 'C1', threadTs: '1111111111.222222' }).problems, []);
  assert.match(relayPostCheck(recordWith(moved), { message: '<@U1> #12 has changed, please review', channel: 'C1' }).problems[0], /only as a reply in that thread/);
  assert.match(relayPostCheck(recordWith(moved), { message: '<@U1> #12 has changed, please review', channel: 'C2', threadTs: '1111111111.222222' }).problems[0], /channel C1/);
  const two = recordWith(moved);
  two.assignments.a2 = { id: 'a2', accountable: { actor: 'coord' }, pr: { repo: 'o/r', number: 13, head: HEAD, stage: 'awaiting-review', qa: { head: HEAD },
    reviewRequest: { ...requested.reviewRequest, head: HEAD } } };
  assert.deepEqual(relayPostCheck(two, { message: '<@U1> please review #12 again', channel: 'C1', threadTs: '1111111111.222222' }).problems, [],
    'a request naming #12 is not blocked by #13 in the same thread');
  assert.match(relayPostCheck(two, { message: '<@U1> please review again', channel: 'C1', threadTs: '1111111111.222222' }).problems[0], /name the PR/);
});

function transcript(entries) {
  const path = join(dir, `t${++n}.jsonl`);
  writeFileSync(path, entries.map(e => JSON.stringify(e)).join('\n') + '\n');
  return path;
}
let id = 0;
function chain(entries) {
  let parentId = null;
  return entries.map(e => { const entry = { ...e, id: `e${++id}`, parentId }; parentId = entry.id; return entry; });
}
const msg = (role, content, timestamp, extra = {}) => ({ type: 'message', timestamp, message: { role, content, ...extra } });
const call = (callId, name, args) => ({ type: 'toolCall', id: callId, name, arguments: args });
const result = (callId, text, isError = false) => msg('toolResult', [{ type: 'text', text }], 'r', { toolCallId: callId, isError });

test('report since the latest instruction: a delivered send to the owner or a queued handoff; not a pane reply, a failed send or another recipient', async () => {
  const replied = transcript(chain([msg('user', [{ type: 'text', text: 'do it' }], 't1'), msg('assistant', [{ type: 'text', text: 'done, see above' }], 't2')]));
  assert.deepEqual(await reportSince(replied), { instructionAt: 't1', reported: null });
  const sent = transcript(chain([msg('user', [{ type: 'text', text: 'old' }], 't0'),
    msg('assistant', [call('c0', 'bash', { command: 'ccmux send --stdin pi_pane1 < report.md' })], 't0b'), result('c0', 'Sent to session: pi_pane1'),
    msg('user', [{ type: 'text', text: 'new instruction' }], 't1'),
    msg('assistant', [call('c1', 'bash', { command: 'ccmux send --stdin pi_pane7 <<EOF\nreport\nEOF' })], 't2'), result('c1', 'Sent to session: pi_pane7'),
    msg('assistant', [call('c2', 'bash', { command: 'ccmux send --stdin pi_pane1 <<EOF\nreport\nEOF' })], 't3'), result('c2', 'error: no session', true)]));
  assert.deepEqual(await reportSince(sent, { owners: ['pi_pane1'] }), { instructionAt: 't1', reported: null }, 'failed or misdirected sends do not count');
  assert.deepEqual(await reportSince(sent, { owners: ['pi_pane7'] }), { instructionAt: 't1', reported: { at: 't2', via: 'ccmux send to pi_pane7' } });
  const handoff = transcript(chain([msg('user', [{ type: 'text', text: 'go' }], 't1'), msg('assistant', [call('h', 'submit_handoff', {})], 't2'), result('h', 'Queued for Codex thread')]));
  assert.equal((await reportSince(handoff, { owners: ['pi_pane1'] })).reported.via, 'submit_handoff');
  // A branch the session left (by /tree) is not on the path followed from the newest entry.
  const [u, a] = chain([msg('user', [{ type: 'text', text: 'go' }], 't1'), msg('assistant', [call('b', 'bash', { command: 'ccmux send x' })], 't2')]);
  const left = { ...result('b', 'Sent to session: pi_pane1'), id: 'left', parentId: a.id };
  const resumed = { ...msg('assistant', [{ type: 'text', text: 'resumed elsewhere' }], 't3'), id: 'resumed', parentId: u.id };
  assert.deepEqual(await reportSince(transcript([u, a, left, resumed])), { instructionAt: 't1', reported: null });
  // An entry too large to parse is followed by its envelope, so the instruction before it is still found.
  const [u2, big] = chain([msg('user', [{ type: 'text', text: 'go' }], 't1'), result('x', 'y'.repeat(300 * 1024))]);
  assert.deepEqual(await reportSince(transcript([u2, big])), { instructionAt: 't1', reported: null });
});

test('quiet delegates: idle without a report is quiet; working, reported or unseen sessions are not', async () => {
  const quietPath = transcript(chain([msg('user', [{ type: 'text', text: 'go' }], 't1'), msg('assistant', [{ type: 'text', text: 'ok' }], 't2')]));
  const reportedPath = transcript(chain([msg('user', [{ type: 'text', text: 'go' }], 't1'), msg('assistant', [call('h', 'submit_handoff', {})], 't2'), result('h', 'Queued')]));
  const noInstruction = transcript(chain([msg('assistant', [{ type: 'text', text: 'hello' }], 't0')]));
  const record = { assignments: {
    q: { id: 'q', accountable: { actor: 'coord' }, implementer: { session: 'sq' }, pr: { stage: 'qa' } },
    r: { id: 'r', accountable: { actor: 'coord' }, implementer: { session: 'sr' }, pr: { stage: 'qa' } },
    w: { id: 'w', accountable: { actor: 'coord' }, implementer: { session: 'sw' }, pr: { stage: 'qa' } },
    u: { id: 'u', accountable: { actor: 'coord' }, implementer: { session: 'su' }, pr: { stage: 'qa' } },
    n: { id: 'n', accountable: { actor: 'coord' }, implementer: { session: 'sn' }, pr: { stage: 'qa' } },
    l: { id: 'l', accountable: { actor: 'coord' }, implementer: { session: 'sl' }, pr: { stage: 'landed' } },
    o: { id: 'o', accountable: { actor: 'other' }, implementer: { session: 'so' }, pr: { stage: 'qa' } },
  } };
  record.assignments.m = { id: 'm', accountable: { actor: 'coord' }, implementer: { session: 'sm' }, pr: { stage: 'qa' } };
  const snaps = { sq: ['idle', quietPath], sr: ['idle', reportedPath], sw: ['working', quietPath], sn: ['idle', noInstruction], sm: ['idle', quietPath, 'someone-else'] };
  const snapshot = async ref => snaps[ref]
    ? { snapshot: { session: { id: `pi_${ref}`, transcriptPath: snaps[ref][1] }, activity: { status: snaps[ref][0], statusChangedAt: 'then' },
      transcript: { sessionId: snaps[ref][2] ?? ref }, verdict: 'reply-observed' } }
    : { error: `no ccmux session ${ref}` };
  const quiet = await quietDelegates(record, { actor: 'coord', snapshot });
  assert.deepEqual(quiet.map(q => [q.assignment, q.state]), [['q', 'quiet'], ['u', 'unknown'], ['n', 'unknown'], ['m', 'unknown']]);
});

test('readiness CLI against a fake gh', () => {
  const w = world();
  w.rec('assign', 'a1', '--title', 'One', '--accountable', 'coord');
  w.rec('pr', 'a1', '--expect-rev', '1', '--repo', 'o/r', '--number', '12', '--head', HEAD, '--qa-head', HEAD, '--stage', 'awaiting-review');
  const bin = join(w.base, 'bin');
  mkdirSync(bin);
  const response = join(w.base, 'gh.json');
  writeFileSync(join(bin, 'gh'), `#!/bin/sh\ncat "${response}"\n`);
  chmodSync(join(bin, 'gh'), 0o755);
  const env = { ...w.env, PATH: `${bin}:${process.env.PATH}` };
  writeFileSync(response, JSON.stringify({ data: { repository: { pullRequest: ghPr({}) } } }));
  assert.match(execFileSync('node', [checkCli, 'readiness', '#12'], { env, encoding: 'utf8' }), /every checked condition holds/);
  writeFileSync(response, JSON.stringify({ data: { repository: { pullRequest: ghPr({ isDraft: true }) } } }));
  const out = JSON.parse(execFileSync('node', [checkCli, 'readiness', 'a1', '--json'], { env, encoding: 'utf8' }));
  assert.equal(out.ready, false);
  assert.deepEqual(out.findings, ['o/r#12 is a draft']);
  assert.match(spawnSync('node', [recordCli, 'pr', 'a1', '--expect-rev', '2', '--stage', 'merge-ready'], { env, encoding: 'utf8' }).stderr, /not recorded: o\/r#12 is not merge-ready:\n- o\/r#12 is a draft/);
  writeFileSync(response, JSON.stringify({ data: { repository: { pullRequest: ghPr({}) } } }));
  execFileSync('node', [recordCli, 'pr', 'a1', '--expect-rev', '2', '--stage', 'merge-ready'], { env });
  assert.equal(w.json().assignments.a1.pr.stage, 'merge-ready');
  assert.match(spawnSync('node', [recordCli, 'pr', 'a1', '--expect-rev', '3', '--head', OLD], { env, encoding: 'utf8' }).stderr,
    /not merge-ready[\s\S]*records head bbbbbbbbbbbb but GitHub's head is aaaaaaaaaaaa/, 'a head change while merge-ready is rechecked');
  assert.equal(w.json().assignments.a1.pr.head, HEAD);
  assert.match(spawnSync('node', [recordCli, 'pr', 'a1', '--expect-rev', '3', '--repo', 'O/R', '--number', '12', '--head', OLD], { env, encoding: 'utf8' }).stderr,
    /not merge-ready/, 'restating the same PR identity does not skip the recheck');
});
