// The Markdown editor's command index, and its self-correction when a document's folder or file is
// removed (a deleted worktree). Real Neovim, config and renderer in a disposable tmux server.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const sleep = ms => new Promise(done => setTimeout(done, ms));
let runs = 0;

// An editor on `files`, started in `cwd` at the size of a narrow pane beside Pi.
function editor(dir, cwd, files, options = '') {
  const server = `markdown-editor-${process.pid}-${++runs}`;
  const socket = join(dir, `nvim-${runs}.sock`);
  const tmux = (...args) => execFileSync('tmux', ['-L', server, ...args], { encoding: 'utf8' }).trim();
  tmux('-f', '/dev/null', 'new-session', '-d', '-s', 'e', '-x', '55', '-y', '40', '-c', cwd,
    `env XDG_STATE_HOME=${join(dir, 'state')} NVIM_APPNAME=pi-markdown nvim ${options} -u ${join(root, 'nvim/pi-markdown/init.lua')} --listen ${socket} ${files.join(' ')}`);
  return {
    tmux,
    screen: () => tmux('capture-pane', '-p', '-t', 'e'),
    remote: expr => execFileSync('nvim', ['--clean', '--server', socket, '--remote-expr', expr], { encoding: 'utf8', timeout: 3000 }).trim(),
    alive: () => { try { tmux('has-session', '-t', 'e'); return true; } catch { return false; } },
    stop() {
      let path;
      try { path = tmux('display-message', '-p', '#{socket_path}'); tmux('kill-server'); } catch {}
      if (path) rmSync(path, { force: true });
    },
  };
}
async function until(check, message, ms = 8000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) if (check()) return;
  assert.fail(message);
}

test('the command index sits above the document, is never focused, and q closes the editor', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'markdown-editor-'));
  writeFileSync(join(dir, 'doc.md'), '# Doc\n\nbody text\n');
  const e = editor(dir, dir, [join(dir, 'doc.md')]);
  try {
    await until(() => e.screen().startsWith('Not typing? Every key is a command:'), 'the index is the first line');
    const lines = e.screen().split('\n');
    const bar = lines.findIndex(line => line.includes('doc.md'));
    assert.ok(lines.slice(0, bar).some(line => line.includes('Esc  stop typing')), 'the index lists the commands');
    assert.ok(lines.slice(bar + 1).some(line => line.includes('body text')), 'the document follows its bar');
    e.remote("execute('lua vim.api.nvim_set_current_win(vim.fn.win_getid(1))')");
    await until(() => e.remote('winnr()') === '2', 'entering the index returns to the document');
    assert.equal(e.remote("expand('%:t')"), 'doc.md');
    e.tmux('send-keys', '-t', 'e', 'G', 'o', 'typed', 'Escape');
    await until(() => e.screen().includes('[+] unsaved'), 'the bar marks unsaved text');
    e.tmux('send-keys', '-t', 'e', 'u');
    await until(() => !e.screen().includes('[+] unsaved'), 'undo clears the mark');
    e.tmux('send-keys', '-t', 'e', 'q');
    await until(() => !e.alive(), 'q closes the editor, index included');
  } finally {
    e.stop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });  // Neovim may still be writing state as it exits
  }
});

test('outside typing, a table stays rendered on the cursor line; typing shows its Markdown', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'markdown-editor-'));
  writeFileSync(join(dir, 'doc.md'), '# Doc\n\n| Name | Value |\n|---|---|\n| one | 1 |\n');
  const e = editor(dir, dir, [join(dir, 'doc.md')]);
  const table = () => e.screen().split('\n').filter(line => /Name|---|one|[┌├└]/.test(line)).join('\n');
  try {
    await sleep(2000);
    if (e.remote("luaeval('package.loaded[\"render-markdown\"] ~= nil')") !== 'true') {
      t.skip('render-markdown is not installed (scripts/install-markdown-editor.sh); the failure needs it');
      return;
    }
    for (const line of [3, 4, 5]) {  // header, delimiter, row
      e.tmux('send-keys', '-t', 'e', `:${line}`, 'Enter');
      await until(() => e.remote("line('.')") === String(line), `cursor on line ${line}`);
      await sleep(500);
      assert.ok(table().includes('├') && !/\||---/.test(table()), `line ${line} under the cursor:\n${table()}`);
    }
    e.tmux('send-keys', '-t', 'e', 'i');
    await until(() => table().includes('|---|---|'), 'typing shows the Markdown');
  } finally {
    e.stop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('copies and cuts reach the clipboard shared by every panel; deleting leaves it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'markdown-editor-'));
  const clip = join(dir, 'clip');
  const read = () => { try { return readFileSync(clip, 'utf8'); } catch { return ''; } };
  // A stand-in for the system clipboard, so the test never touches the real one.
  writeFileSync(join(dir, 'clipboard.vim'), `let g:clipboard = {'name': 'test', 'cache_enabled': 0,
    \\ 'copy': {'+': ['sh', '-c', 'cat > ${clip}'], '*': ['sh', '-c', 'cat > ${clip}']},
    \\ 'paste': {'+': ['cat', '${clip}'], '*': ['cat', '${clip}']}}\n`);
  writeFileSync(join(dir, 'a.md'), 'alpha beta\nsecond line\n');
  writeFileSync(join(dir, 'b.md'), 'other\n');
  const options = `--cmd 'source ${join(dir, 'clipboard.vim')}'`;
  const a = editor(dir, dir, [join(dir, 'a.md')], options), b = editor(dir, dir, [join(dir, 'b.md')], options);
  const keys = (e, ...k) => e.tmux('send-keys', '-t', 'e', ...k);
  const mouse = (e, ...events) => { for (const event of events) keys(e, '-l', `\x1b[<${event}`); };
  try {
    await until(() => a.screen().includes('alpha beta') && b.screen().includes('other'), 'both editors are up');
    const row = a.screen().split('\n').findIndex(line => line.startsWith('alpha')) + 1;
    mouse(a, `0;1;${row}M`, `32;5;${row}M`, `0;5;${row}m`);
    await until(() => read() === 'alpha', 'a mouse selection outside typing is copied on release');
    keys(a, 'Escape');
    keys(b, 'p');
    await until(() => b.remote('getline(1)') === 'oalphather', 'p in another panel pastes it');
    keys(a, 'g', 'g', '0', 'x');
    await until(() => a.remote('getline(1)') === 'lpha beta', 'x deletes');
    assert.equal(read(), 'alpha', 'x leaves the clipboard');
    keys(a, 'j', 'd', 'd');
    await until(() => read() === 'second line\n', 'dd cuts the line');
    keys(a, 'g', 'g', '0', 'i');
    await until(() => a.screen().includes('-- INSERT --'), 'typing');
    mouse(a, `0;1;${row}M`, `32;3;${row}M`, `0;3;${row}m`);
    await until(() => a.screen().includes('SELECT --'), 'a drag while typing selects to replace');
    keys(a, 'BSpace');
    await until(() => a.remote('getline(1)') === 'a beta', 'the delete key removes the selection');
    assert.equal(read(), 'second line\n', 'deleting a selection while typing leaves the clipboard');
  } finally {
    a.stop();
    b.stop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('a removed working directory does not break rendering', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'markdown-editor-'));
  mkdirSync(join(dir, 'worktree'));
  writeFileSync(join(dir, 'doc.md'), '# Doc\n\n```python\nprint(1)\n```\n');
  const e = editor(dir, join(dir, 'worktree'), [join(dir, 'doc.md')]);
  try {
    await sleep(2000);
    if (e.remote("luaeval('package.loaded[\"render-markdown\"] ~= nil')") !== 'true') {
      t.skip('render-markdown is not installed (scripts/install-markdown-editor.sh); the failure needs it');
      return;
    }
    rmSync(join(dir, 'worktree'), { recursive: true });
    await sleep(1500);
    e.tmux('resize-window', '-t', 'e', '-x', '70', '-y', '40');  // a full redraw resolves the code block's language
    await sleep(1500);
    assert.ok(!/assertion failed|Press ENTER/.test(e.screen()), e.screen());
    assert.notEqual(e.remote('getcwd()'), '', 'the editor has a working directory again');
  } finally {
    e.stop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });  // Neovim may still be writing state as it exits
  }
});

test('a removed document closes unless it has unsaved text; the last one closes the editor', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'markdown-editor-'));
  const kept = join(dir, 'kept.md'), gone = join(dir, 'gone.md');
  writeFileSync(kept, '# Kept\n');
  writeFileSync(gone, '# Gone\n');
  const e = editor(dir, dir, [gone, kept]);
  try {
    await until(() => e.screen().includes('# Gone'), 'the first document is shown');
    e.tmux('send-keys', '-t', 'e', 'G', 'o', 'unsaved words', 'Escape');
    rmSync(gone);
    await until(() => e.screen().includes('File removed from disk; your text is kept here'), 'the bar says why it stays');
    await sleep(4000);
    assert.equal(e.remote("expand('%:t')"), 'gone.md', 'unsaved text keeps the document open');
    assert.ok(e.screen().includes('unsaved words'));

    e.tmux('send-keys', '-t', 'e', 'u');  // no unsaved text left
    await until(() => e.remote("expand('%:t')") === 'kept.md', 'the clean removed document closes; the other is shown');
    assert.equal(e.remote("len(getbufinfo({'buflisted': 1}))"), '1');
    rmSync(kept);
    await until(() => !e.alive(), 'removing the last document closes the editor');
  } finally {
    e.stop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });  // Neovim may still be writing state as it exits
  }
});
