// The Markdown editor must scroll back above a table wider than the window: the renderer draws each
// such row as several virtual lines, which scrolling by buffer line could not move back over.
// Real Neovim, config and renderer in a disposable tmux server, with wheel events from a real client.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const sleep = ms => new Promise(done => setTimeout(done, ms));

test('wheel and Ctrl-Y scroll back to the top past a wide rendered table', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'markdown-scroll-'));
  const server = `markdown-scroll-${process.pid}`, outer = `${server}-o`;
  const tmux = (socket, ...args) => execFileSync('tmux', ['-L', socket, ...args], { encoding: 'utf8' }).trim();
  const socket = join(dir, 'nvim.sock');
  const remote = expr => execFileSync('nvim', ['--clean', '--server', socket, '--remote-expr', expr], { encoding: 'utf8' }).trim();
  const cell = word => `${word} ${'with enough words to need wrapping in a narrow pane '.repeat(2)}`;
  const rows = Array.from({ length: 6 }, (_, i) => `| Item ${i} | ${cell('purpose')} | ${cell('version')} |`);
  const text = Array.from({ length: 60 }, (_, i) => `Line ${i} of ordinary prose after the table.`);
  writeFileSync(join(dir, 'doc.md'), ['# Doc', '', '## Table', '', '| A | B | C |', '| --- | --- | --- |', ...rows, '', ...text, ''].join('\n'));
  try {
    tmux(server, '-f', '/dev/null', 'new-session', '-d', '-s', 'e', '-x', '100', '-y', '40',
      `env XDG_STATE_HOME=${join(dir, 'state')} NVIM_APPNAME=pi-markdown nvim -u ${join(root, 'nvim/pi-markdown/init.lua')} --listen ${socket} ${join(dir, 'doc.md')}`);
    tmux(outer, '-f', '/dev/null', 'new-session', '-d', '-s', 'o', '-x', '100', '-y', '40', `env -u TMUX tmux -L ${server} attach -t e`);
    await sleep(2000);
    if (remote("luaeval('package.loaded[\"render-markdown\"] ~= nil')") !== 'true') {
      t.skip('render-markdown is not installed (scripts/install-markdown-editor.sh); the bug needs it');
      return;
    }
    tmux(server, 'send-keys', '-t', 'e', 'G');
    await sleep(500);
    assert.ok(Number(remote("line('w0')")) > 1, 'starts scrolled down');
    for (let i = 0; i < 30; i++) {
      tmux(outer, 'send-keys', '-t', 'o', '-l', '\x1b[<64;40;15M');
      await sleep(40);
    }
    await sleep(800);
    assert.equal(remote("line('w0')"), '1', 'the wheel scrolls back to the top');
    tmux(server, 'send-keys', '-t', 'e', 'G');
    await sleep(500);
    for (let i = 0; i < 120; i++) tmux(server, 'send-keys', '-t', 'e', 'C-y');
    await sleep(800);
    assert.equal(remote("line('w0')"), '1', 'Ctrl-Y scrolls back to the top');
  } finally {
    // kill-server leaves the socket file; remove exactly this test's two.
    for (const name of [outer, server]) {
      let path;
      try { path = tmux(name, 'display-message', '-p', '#{socket_path}'); tmux(name, 'kill-server'); } catch {}
      if (path) rmSync(path, { force: true });
    }
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });  // Neovim may still be writing state as it exits
  }
});
