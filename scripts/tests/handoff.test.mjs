// submit_handoff through Pi's real extension loader and exec, with a fake `codex` named by CODEX_CLI_PATH.
// CODEX_CLI_PATH is set before every call so no test can reach the bundled CLI or a real Codex thread.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const OWNER = '00000000-0000-4000-8000-00000000c0de';
const modules = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
const piAi = modules + '/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/index.js';

async function setup(t) {
  const { loadExtensions } = await import(pathToFileURL(modules + '/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js'));
  const loaded = await loadExtensions([process.cwd() + '/pi/extensions/handoff.ts'], process.cwd());
  assert.deepEqual(loaded.errors, []);
  const tool = loaded.extensions[0].tools.get('submit_handoff').definition;
  const dir = mkdtempSync(join(tmpdir(), 'handoff-test-'));
  const work = join(dir, 'work');
  mkdirSync(work);
  writeFileSync(join(work, 'HANDOFF.md'), '# QA\n\n**App QA pending.**\n');
  writeFileSync(join(work, 'notes.txt'), 'not markdown');
  const calls = join(dir, 'calls.jsonl');
  const fake = join(dir, 'codex');
  /** The fake records its argv, then behaves as `script` (JS run with `args` in scope) says. */
  const behave = script => writeFileSync(fake, `#!/usr/bin/env node\nconst args = process.argv.slice(2);\n`
    + `require('fs').appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + '\\n');\n${script}\n`, { mode: 0o755 });
  const previous = { cli: process.env.CODEX_CLI_PATH, pane: process.env.TMUX_PANE };
  process.env.CODEX_CLI_PATH = fake;
  process.env.TMUX_PANE = '%42';
  t.after(() => {
    for (const [key, value] of [['CODEX_CLI_PATH', previous.cli], ['TMUX_PANE', previous.pane]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  });
  const ctx = { cwd: work, model: { provider: 'claude-bridge', id: 'claude-opus-5-5' }, sessionManager: {
    getSessionId: () => '00000000-0000-4000-8000-0000000000f1', getSessionName: () => 'qa-fixture',
    getSessionFile: () => '/sessions/qa-fixture.jsonl' } };
  const submit = (params, signal) => tool.execute('call-1', { ownerThreadId: OWNER, qaState: 'pending', path: 'HANDOFF.md', ...params }, signal, undefined, ctx);
  const recorded = () => existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
  return { tool, dir, work, fake, behave, submit, recorded };
}

test('a queued submission sends one message naming the handoff, state and sender, and claims only the queue', async t => {
  const { work, behave, submit, recorded } = await setup(t);
  behave(`console.log('Queued message 00000000-0000-4000-8000-000000000a01 for thread ' + args[2] + '.');`);
  const result = await submit({ qaState: 'blocked' });
  assert.equal(result.isError, undefined);
  const [args] = recorded();
  assert.equal(recorded().length, 1);
  assert.deepEqual(args.slice(0, 4), ['queue', '--thread', OWNER, '--message']);
  assert.equal(args.length, 5);
  const message = args[4];
  const path = join(work, 'HANDOFF.md');
  assert.ok(message.includes(`Handoff submitted: ${path}`), 'relative path resolved against the session cwd');
  assert.ok(message.includes('QA state reported by the sender: blocked.'));
  assert.match(message, /not readiness, publication or merge authority/);
  for (const part of ['qa-fixture', '00000000-0000-4000-8000-0000000000f1', 'claude-bridge/claude-opus-5-5', `cwd ${work}`, 'tmux pane %42']) {
    assert.ok(message.includes(part), `sender identity includes ${part}`);
  }
  assert.match(message, /reconcile the relevant entry in your landing plan, and coordinate the next action/);
  assert.ok(!message.includes('App QA pending'), 'the handoff body is read by the owner, not copied');
  const { details } = result;
  assert.equal(details.path, path);
  assert.equal(details.qaState, 'blocked');
  assert.equal(details.ownerThreadId, OWNER);
  assert.equal(details.sender.sessionFile, '/sessions/qa-fixture.jsonl');
  assert.equal(details.transport.status, 'queued');
  assert.equal(details.transport.queuedMessageId, '00000000-0000-4000-8000-000000000a01');
  assert.match(result.content[0].text, /queue acknowledgement only: it does not show that the owner has read the handoff/);
});

test('the destination is the given owner, never an ambient thread id', async t => {
  const { behave, submit, recorded } = await setup(t);
  const previous = process.env.CODEX_THREAD_ID;
  process.env.CODEX_THREAD_ID = '00000000-0000-4000-8000-0000000a4b1e';
  t.after(() => { if (previous === undefined) delete process.env.CODEX_THREAD_ID; else process.env.CODEX_THREAD_ID = previous; });
  behave(`console.log('Queued message m-3 for thread ' + args[2] + '.');`);
  const other = '00000000-0000-4000-8000-00000000b0b0';
  const result = await submit({ ownerThreadId: other });
  assert.equal(result.details.transport.status, 'queued');
  assert.equal(result.details.ownerThreadId, other);
  assert.equal(recorded()[0][2], other);
});

test('without an acknowledgement for this thread the outcome is unconfirmed; an abnormal ending is recorded, never shown as exit 0', async t => {
  const { dir, behave, submit, recorded } = await setup(t);
  behave(`console.error('Error: thread not found'); process.exit(2);`);
  const failed = await submit({});
  assert.equal(failed.isError, true);
  assert.equal(failed.details.transport.status, 'unconfirmed', 'a CLI error does not show the message was not queued');
  assert.equal(failed.details.transport.exitCode, 2);
  assert.match(failed.content[0].text, /^Delivery unconfirmed: codex queue exited 2\.\nCLI output: Error: thread not found\nThe message may or may not be queued/);

  behave(`console.log('Queued message m-9 for thread ' + args[2] + '.'); process.exit(9);`);
  const ackThenError = await submit({});
  assert.equal(ackThenError.details.transport.status, 'queued', 'the acknowledgement is evidence of enqueueing');
  assert.equal(ackThenError.details.transport.exitCode, 9, 'the abnormal ending is recorded, not reported as exit 0');
  assert.equal(ackThenError.isError, undefined);
  assert.match(ackThenError.content[0].text, /^Queued .*Note: after acknowledging, codex queue exited 9\./);

  behave(`console.log('Queued message m-k for thread ' + args[2] + '.'); process.kill(process.pid, 'SIGKILL');`);
  const ackThenKilled = await submit({});
  assert.equal(ackThenKilled.details.transport.status, 'queued');
  assert.equal(ackThenKilled.details.transport.exitCode, null, 'a signal ending is not reported as exit 0');
  assert.equal(ackThenKilled.details.transport.signal, 'SIGKILL');
  assert.match(ackThenKilled.content[0].text, /Note: after acknowledging, codex queue ended by SIGKILL/);

  behave(`process.stdout.write('x'.repeat(200000));`);
  const noisy = await submit({});
  assert.equal(noisy.details.transport.status, 'unconfirmed');
  assert.equal(noisy.details.transport.outputTruncated, true);
  assert.match(noisy.content[0].text, /more output than expected and was killed, its exit status was not observed.*\nCLI output \(partial\)/s);

  // The output cap cuts another thread's acknowledgement right after "<owner id>.": a cut-off line is not a receipt.
  behave(`const head = 'Queued message m-c for thread ' + args[2] + '.'; process.stdout.write('x'.repeat(65536 - head.length - 1) + '\\n' + head + 'other-thread.\\n');`);
  const cut = await submit({});
  assert.equal(cut.details.transport.outputTruncated, true);
  assert.ok(cut.details.transport.output.endsWith(`for thread ${OWNER}.`), 'the fixture cuts exactly after the owner id');
  assert.equal(cut.details.transport.status, 'unconfirmed', 'a line cut off by the output cap is not an acknowledgement');

  behave(`console.log('Done.');`);
  const unrecognised = await submit({});
  assert.equal(unrecognised.isError, true);
  assert.equal(unrecognised.details.transport.status, 'unconfirmed');
  assert.match(unrecognised.content[0].text, /^Delivery unconfirmed: codex queue exited 0 without acknowledging this thread/);

  behave(`console.log('Queued message m-2 for thread 11111111-2222-4333-8444-555555555555.');`);
  const otherThread = await submit({});
  assert.equal(otherThread.details.transport.status, 'unconfirmed', 'a confirmation for another thread is not this delivery');

  behave(`console.log('Queued message m-2 for thread 11111111-2222-4333-8444-555555555555.'); console.log('Queued message m-4 for thread ' + args[2] + '.');`);
  const second = await submit({});
  assert.equal(second.details.transport.status, 'queued', 'any complete acknowledgement line for this thread counts');
  assert.equal(second.details.transport.queuedMessageId, 'm-4');

  // Cancellation kills the CLI, even one ignoring SIGTERM: it cannot act after the tool returns.
  const marker = join(dir, 'late-marker');
  behave(`process.on('SIGTERM', () => {}); setTimeout(() => require('fs').writeFileSync(${JSON.stringify(marker)}, 'late'), 1500); setTimeout(() => {}, 10000);`);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 300);
  const started = Date.now();
  const stopped = await submit({}, controller.signal);
  assert.ok(Date.now() - started < 1400, 'cancellation returns promptly');
  assert.equal(stopped.isError, true);
  assert.equal(stopped.details.transport.status, 'unconfirmed');
  assert.equal(stopped.details.transport.exitCode, null);
  assert.equal(stopped.details.transport.signal, 'SIGKILL', 'the ending is observed after the kill');
  assert.match(stopped.content[0].text, /^Delivery unconfirmed: codex queue was killed on cancellation\..*may or may not be queued/s);
  await new Promise(done => setTimeout(done, 1700));
  assert.equal(existsSync(marker), false, 'the cancelled CLI did not keep running');

  behave(`console.log('Queued message m-a for thread ' + args[2] + '.'); setTimeout(() => {}, 10000);`);
  const acked = new AbortController();
  setTimeout(() => acked.abort(), 500);
  const ackThenCancelled = await submit({}, acked.signal);
  assert.equal(ackThenCancelled.details.transport.status, 'queued', 'an acknowledgement before cancellation still shows enqueueing');
  assert.match(ackThenCancelled.content[0].text, /Note: after acknowledging, codex queue was killed on cancellation\./);
  assert.equal(recorded().length, 10);
});

test('nothing is executed without a valid owner thread, an existing Markdown handoff and a working CLI', async t => {
  const { dir, work, fake, behave, submit, recorded } = await setup(t);
  behave(`console.log('Queued message m for thread ' + args[2] + '.');`);
  await assert.rejects(submit({ ownerThreadId: 'astra' }), /must be the owner's Codex thread UUID.*Nothing was sent/);
  await assert.rejects(submit({ ownerThreadId: `${OWNER}\n--message x` }), /Nothing was sent/);
  await assert.rejects(submit({ path: 'MISSING.md' }), /not an existing Markdown file\. Nothing was sent/);
  await assert.rejects(submit({ path: 'notes.txt' }), /not an existing Markdown file/);
  await assert.rejects(submit({ path: '.' }), /not an existing Markdown file/);
  const cancelled = new AbortController();
  cancelled.abort();
  const early = await submit({}, cancelled.signal);
  assert.equal(early.details.transport.status, 'not-sent');
  assert.match(early.content[0].text, /^Not sent: cancelled before codex queue was started/);
  const configured = process.env.CODEX_CLI_PATH;
  writeFileSync(join(work, 'codex'), readFileSync(fake), { mode: 0o755 });
  for (const value of [join(dir, 'absent-codex'), 'codex', './codex', '', dir]) {
    process.env.CODEX_CLI_PATH = value;
    const missing = await submit({});
    assert.equal(missing.isError, true);
    assert.equal(missing.details.transport.status, 'not-sent');
    assert.equal(missing.details.transport.cli, null);
    assert.match(missing.content[0].text, /^Not sent: CODEX_CLI_PATH \(.*\) is not an absolute path to an executable file/);
  }
  // An executable whose interpreter is missing cannot start: nothing was sent.
  const broken = join(dir, 'broken-codex');
  writeFileSync(broken, '#!/nonexistent/interpreter\n', { mode: 0o755 });
  process.env.CODEX_CLI_PATH = broken;
  const unstartable = await submit({});
  assert.equal(unstartable.details.transport.status, 'not-sent');
  assert.match(unstartable.content[0].text, /^Not sent: codex queue could not be started/);
  process.env.CODEX_CLI_PATH = configured;
  assert.equal(recorded().length, 0);
});

test('Pi validates qaState against the approved values before execution', async t => {
  const { tool } = await setup(t);
  const { validateToolArguments } = await import(pathToFileURL(piAi));
  const call = qaState => ({ type: 'toolCall', id: 'v', name: 'submit_handoff', arguments: { path: 'H.md', ownerThreadId: OWNER, qaState } });
  for (const state of ['pending', 'passed', 'failed', 'blocked', 'not-applicable']) {
    assert.equal(validateToolArguments(tool, call(state)).qaState, state);
  }
  assert.throws(() => validateToolArguments(tool, call('ready')));
  assert.throws(() => validateToolArguments(tool, { ...call('passed'), arguments: { path: 'H.md', qaState: 'passed' } }), /ownerThreadId/);
});
