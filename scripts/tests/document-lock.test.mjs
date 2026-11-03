// The document lock shared by Pi and the tab helper: exclusive across processes, released when its holder dies.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const lib = fileURLToPath(new URL('../lib/diff-pane.ts', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'document-lock-'));
const holder = join(dir, 'hold.mjs');
writeFileSync(holder, `const { withDocuments } = await import(${JSON.stringify(lib)});
const [name, ms] = process.argv.slice(2), start = Date.now();
await withDocuments('%1', async () => {
  console.log(name, 'in', Date.now() - start);
  await new Promise(done => setTimeout(done, Number(ms)));
});
`);
// A lock key no Pi uses: the key is derived from the tmux socket in TMUX.
const env = { ...process.env, TMUX: join(dir, 'no-such-socket') + ',0,0' };
const run = (name, ms) => {
  const child = spawn(process.execPath, ['--no-warnings', holder, name, String(ms)], { env });
  child.entered = new Promise(done => child.stdout.on('data', data => done(Number(String(data).split(' ')[2]))));
  child.done = new Promise(done => child.on('exit', done));
  return child;
};
test.after(() => rmSync(dir, { recursive: true, force: true }));

test('a second process waits for the holder to leave', async () => {
  const first = run('first', 1200);
  await first.entered;
  const second = run('second', 0);
  assert.ok(await second.entered >= 800, 'entered only after the first left');
  await Promise.all([first.done, second.done]);
});

test('a holder killed mid-task releases the lock at once', async () => {
  const first = run('first', 60000);
  await first.entered;
  first.kill('SIGKILL');
  await first.done;
  const second = run('second', 0);
  assert.ok(await second.entered < 2000, 'no stale lock to wait out');
  await second.done;
});
