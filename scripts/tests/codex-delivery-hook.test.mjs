// The Codex delivery hook against a temporary stop-gate home and coordination record, with GitHub replaced by a
// fixture. No Codex session, network, tmux or live state is touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handle, runHook } from '../codex-delivery-hook.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const recordCli = join(root, 'scripts/coordination-record.mjs');
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'codex-delivery-')));
test.after(() => rmSync(dir, { recursive: true, force: true }));

const HEAD = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
const SESSION = '01a20911-25a6-7460-8a5e-9a5e4a74e8af';

let n = 0;
function world() {
  const base = join(dir, `w${++n}`);
  mkdirSync(join(base, 'gate/sessions'), { recursive: true });
  const record = join(base, 'record.json');
  const env = { ...process.env, CODEX_STOP_GATE_HOME: join(base, 'gate'), COORDINATION_RECORD: record, COORDINATION_ACTOR: 'coord' };
  const rec = (...args) => execFileSync('node', [recordCli, ...args], { env, encoding: 'utf8' }).trim();
  rec('init');
  rec('assign', 'a1', '--title', 'One', '--accountable', 'coord');
  rec('pr', 'a1', '--expect-rev', '1', '--repo', 'o/r', '--number', '12', '--head', HEAD, '--stage', 'awaiting-review');
  const enroll = () => writeFileSync(join(base, 'gate/sessions', `${SESSION}.json`),
    JSON.stringify({ schema: 2, session: SESSION, actor: 'coord', record, watches: {}, log: [] }));
  return { base, env, rec, enroll };
}

const ghPr = overrides => ({ state: 'OPEN', isDraft: false, headRefOid: HEAD, mergeStateStatus: 'CLEAN', author: { login: 'me' },
  latestOpinionatedReviews: { nodes: [{ author: { __typename: 'User', login: 'reviewer' }, state: 'APPROVED', commit: { oid: HEAD } }] },
  reviewThreads: { nodes: [] }, commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS', contexts: { nodes: [{ name: 'CI', conclusion: 'SUCCESS', isRequired: true }] } } } }] }, ...overrides });
const event = (name, fields = {}) => ({ hook_event_name: name, session_id: SESSION, turn_id: 't', cwd: dir, ...fields });

test('unenrolled sessions get no output', async () => {
  const w = world();
  for (const name of ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop']) {
    assert.deepEqual(await handle(event(name, { tool_name: 'Bash', tool_input: { command: 'gh pr merge 12' }, last_assistant_message: '#12 is merge-ready.' }), w.env), {});
  }
});

test('reminder on each message; stalls once per record change after the baseline', async () => {
  const w = world();
  w.enroll();
  const reminder = await handle(event('UserPromptSubmit', { prompt: 'status?' }), w.env);
  assert.equal(reminder.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(reminder.hookSpecificOutput.additionalContext, /Rewrite the entry in place: the landing map holds the current state, not a log/);
  assert.deepEqual(await handle(event('PostToolUse', { tool_name: 'Bash' }), w.env), {}, 'unchanged since the baseline');
  w.rec('pr', 'a1', '--expect-rev', '2', '--qa-head', OLD);
  const stalls = await handle(event('PostToolUse', { tool_name: 'Bash' }), w.env);
  assert.match(stalls.hookSpecificOutput.additionalContext, /Landing map stall check[\s\S]*no next action with an owner[\s\S]*no review request is recorded[\s\S]*no live QA recorded on the head/);
  assert.deepEqual(await handle(event('PostToolUse', { tool_name: 'Bash' }), w.env), {}, 'once per change');
});

test('merge: denied when not ready, rewritten to the checked PR and head when ready; other commands untouched', async () => {
  const w = world();
  w.enroll();
  const notReady = { fetch: async () => ghPr({ latestOpinionatedReviews: { nodes: [] } }) };
  const denied = await handle(event('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'gh pr merge 12 --squash' } }), w.env, notReady);
  assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(denied.hookSpecificOutput.permissionDecisionReason, /o\/r#12 is not merge-ready[\s\S]*no human approval[\s\S]*no live QA recorded/);
  const odd = await handle(event('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'gh pr merge 12 && echo done' } }), w.env, notReady);
  assert.match(odd.hookSpecificOutput.permissionDecisionReason, /run the merge as a single plain command/);
  w.rec('pr', 'a1', '--expect-rev', '2', '--qa-head', HEAD);
  const ready = await handle(event('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'gh pr merge 12 --squash' } }), w.env, { fetch: async () => ghPr({}) });
  assert.deepEqual(ready.hookSpecificOutput, { hookEventName: 'PreToolUse', permissionDecision: 'allow',
    updatedInput: { command: `gh pr merge 12 --repo o/r --squash --match-head-commit ${HEAD}` } });
  assert.deepEqual(await handle(event('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'git status' } }), w.env), {});
});

test('stop: one continuation for an unsupported merge-ready claim; none when ready, already continued, or no claim', async () => {
  const w = world();
  w.enroll();
  const notReady = { fetch: async () => ghPr({ isDraft: true }) };
  const stop = await handle(event('Stop', { stop_hook_active: false, last_assistant_message: '#12 is merge-ready.' }), w.env, notReady);
  assert.equal(stop.decision, 'block');
  assert.match(stop.reason, /check disagrees[\s\S]*o\/r#12 is a draft/);
  assert.deepEqual(await handle(event('Stop', { stop_hook_active: true, last_assistant_message: '#12 is merge-ready.' }), w.env, notReady), {});
  assert.deepEqual(await handle(event('Stop', { stop_hook_active: false, last_assistant_message: '#12 is awaiting review.' }), w.env, notReady), {});
  w.rec('pr', 'a1', '--expect-rev', '2', '--qa-head', HEAD);
  assert.deepEqual(await handle(event('Stop', { stop_hook_active: false, last_assistant_message: '#12 is merge-ready.' }), w.env, { fetch: async () => ghPr({}) }), {});
});

test('errors and bad input never trap the session', async () => {
  assert.match((await runHook('not json')).systemMessage, /unreadable hook input/);
  const w = world();
  w.enroll();
  rmSync(join(w.base, 'record.json'));
  assert.match((await runHook(JSON.stringify(event('Stop', { last_assistant_message: '#12 is merge-ready.' })), w.env)).systemMessage, /delivery guards error/);
});
