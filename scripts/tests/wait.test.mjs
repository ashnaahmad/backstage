// The wait tool ends as soon as the user queues a message, so Pi delivers it at once instead of after
// the wait. Real Pi in RPC mode with a scripted model, its own agent directory and no tmux.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const modules = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
const sleep = ms => new Promise(done => setTimeout(done, ms));

// Pi with the wait extension and a model scripted to call wait({ seconds, command, every }) once per prompt.
async function startPi(dir, calls) {
  const { RpcClient } = await import(pathToFileURL(join(modules, '@earendil-works/pi-coding-agent/dist/modes/rpc/rpc-client.js')).href);
  writeFileSync(join(dir, 'scripted.ts'), `import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
export default function (pi) {
  const faux = fauxProvider({ provider: 'faux', models: [{ id: 'scripted' }] });
  faux.setResponses(${JSON.stringify(calls)}.flatMap(input => [
    fauxAssistantMessage(fauxToolCall('wait', input), { stopReason: 'toolUse' }),
    fauxAssistantMessage('done waiting'),
  ]));
  pi.registerProvider(faux.provider);
}
`);
  const env = { ...process.env, PI_CODING_AGENT_DIR: join(dir, 'agent') };
  delete env.TMUX;
  delete env.TMUX_PANE;
  const client = new RpcClient({ cliPath: join(modules, '@earendil-works/pi-coding-agent/dist/cli.js'), cwd: dir, env,
    provider: 'faux', model: 'scripted',
    args: ['--no-session', '--offline', '-ne', '-e', join(root, 'pi/extensions/wait.ts'), '-e', join(dir, 'scripted.ts')] });
  await client.start();
  const results = [];
  client.onEvent(event => { if (event.type === 'tool_execution_end') results.push(event); });
  return { client, results };
}
const text = event => event.result.content.map(part => part.text).join('');

test('a message sent during a wait is delivered at once; a met condition or the time limit also ends it', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pi-wait-')));
  const { client, results } = await startPi(dir, [
    { seconds: 120 },
    { seconds: 30, command: 'test -e ready', every: 1 },
    { seconds: 2, command: 'echo not yet; exit 1', every: 1 },
  ]);
  try {
    // 1. A two-minute wait; a message queued a second in ends it and reaches the model next.
    await client.prompt('watch the implementer');
    await sleep(1000);
    const sent = Date.now();
    await client.steer('User: stop watching, look at this');
    await client.waitForIdle(20000);
    assert.ok(Date.now() - sent < 5000, `delivered within seconds, not after the wait (${Date.now() - sent} ms)`);
    assert.match(text(results[0]), /the user sent a message/);
    const messages = await client.getMessages();
    const users = messages.filter(message => message.role === 'user').map(message =>
      typeof message.content === 'string' ? message.content : message.content.map(part => part.text).join(''));
    assert.deepEqual(users, ['watch the implementer', 'User: stop watching, look at this'], 'the queued message joined the conversation');
    assert.equal(messages.at(-1).role, 'assistant', 'and the model answered after it');

    // 2. A check command that starts succeeding ends the wait with its output.
    await client.prompt('wait for the file');
    await sleep(1500);
    writeFileSync(join(dir, 'ready'), '');
    await client.waitForIdle(20000);
    assert.match(text(results[1]), /^Condition met after \d+s\./);

    // 3. A condition never met ends at the time limit with the last check's output.
    await client.prompt('wait briefly');
    await client.waitForIdle(20000);
    assert.match(text(results[2]), /Waited \d+s; the condition was not met\.\nLast check \(exit 1\):\nnot yet/);
  } finally {
    await client.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
