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

test('writing view: Write keeps the editor as it is; the clean side without the cursor follows its file; closing a side\'s document with none spare closes that side', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'markdown-editor-'));
  const left = join(dir, 'left.md'), right = join(dir, 'right.md');
  writeFileSync(left, '# Left\n');
  writeFileSync(right, '# Right\n');
  const e = editor(dir, dir, [left]);
  const hex = file => Buffer.from(file).toString('hex');
  const sides = () => JSON.parse(e.remote("json_encode(map(filter(getwininfo(), 'getwinvar(v:val.winid, \"&winfixbuf\") == 0'), 'fnamemodify(bufname(v:val.bufnr), \":t\")'))"));
  try {
    await until(() => e.screen().includes('# Left'), 'the editor is up');
    e.remote(`execute('badd ${right}')`);  // another document, held behind
    assert.equal(e.remote('v:lua.PiMarkdownWrite()'), 'writing');
    assert.deepEqual(sides(), ['left.md'], 'Write adds no side, though another document is there');
    assert.equal(e.remote('&laststatus'), '0', 'the bar stays above the one document');
    assert.equal(e.remote(`v:lua.PiMarkdownOpenLeft('${hex(right)}', '')`), 'writing');
    assert.deepEqual(sides(), ['right.md', 'left.md'], 'Open on left adds the second; the current document stays on the right');
    assert.equal(e.remote("expand('%:t')"), 'right.md', 'with the cursor on the left');
    e.remote("execute('wincmd l')");
    assert.equal(e.remote('&laststatus'), '2', 'each side has its bar');
    await sleep(1200);
    writeFileSync(right, '# Right\n\nrewritten on disk\n');
    await until(() => e.screen().includes('rewritten on disk'), 'the clean side without the cursor reloads');
    e.tmux('send-keys', '-t', 'e', '-l', '\x1b[<0;3;20M\x1b[<0;3;20m');  // a click on the left side
    await until(() => e.remote("expand('%:t')") === 'right.md', 'a click moves the cursor there');
    assert.equal(e.remote('v:lua.PiMarkdownSingle()'), 'single');
    assert.deepEqual(sides(), ['left.md'], 'back to one document: the right side\'s, wherever the cursor was');
    assert.equal(e.remote(`v:lua.PiMarkdownOpenLeft('${hex(right)}', '')`), 'writing');

    // Only two documents: closing the right one leaves no spare, so its side closes.
    assert.match(e.remote(`v:lua.PiMarkdownCloseDoc('${hex(right)}', 'close')`), /^Closed right\.md/);
    await until(() => sides().length === 1, 'one side left');
    assert.deepEqual(sides(), ['left.md']);
    await until(() => e.remote('&laststatus') === '0', 'the bar is the index\'s line again');
    assert.equal(e.remote('v:lua.PiMarkdownWrite()'), 'writing', 'Write with the only document');
    assert.deepEqual(sides(), ['left.md'], 'shows it once');
    assert.equal(e.remote('v:lua.PiMarkdownSingle()'), 'single');
    assert.deepEqual(sides(), ['left.md']);
  } finally {
    e.stop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('writing view: Open on left of the only document changes nothing rather than show it twice', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'markdown-editor-'));
  const only = join(dir, 'only.md');
  writeFileSync(only, '# Only\n');
  const e = editor(dir, dir, [only]);
  try {
    await until(() => e.screen().includes('# Only'), 'the editor is up');
    e.tmux('send-keys', '-t', 'e', 'G', 'o', 'unsaved only', 'Escape');
    await until(() => e.remote('&modified') === '1', 'unsaved text');
    assert.equal(e.remote(`v:lua.PiMarkdownOpenLeft('${Buffer.from(only).toString('hex')}', '')`), 'alone');
    assert.equal(e.remote("len(filter(getwininfo(), 'getwinvar(v:val.winid, \"&winfixbuf\") == 0'))"), '1', 'one side');
    assert.equal(e.remote('&modified'), '1', 'its text kept');
  } finally {
    e.stop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('writing view: Open on left keeps the right side; copying and pasting between the sides, by mouse and keys, keeps both texts and saves each alone', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'markdown-editor-'));
  const clip = join(dir, 'clip');
  const read = () => { try { return readFileSync(clip, 'utf8'); } catch { return ''; } };
  // A stand-in for the system clipboard, so the test never touches the real one.
  writeFileSync(join(dir, 'clipboard.vim'), `let g:clipboard = {'name': 'test', 'cache_enabled': 0,
    \\ 'copy': {'+': ['sh', '-c', 'cat > ${clip}'], '*': ['sh', '-c', 'cat > ${clip}']},
    \\ 'paste': {'+': ['cat', '${clip}'], '*': ['cat', '${clip}']}}\n`);
  const source = '# Source\n\nåäö — 日本語 😀\nsecond line ✓\n';
  const files = { a: join(dir, 'a.md'), b: join(dir, 'b.md'), c: join(dir, 'c.md') };
  writeFileSync(files.a, source);
  writeFileSync(files.b, '# Dest\n');
  writeFileSync(files.c, '# Third\n');
  const e = editor(dir, dir, [files.b], `--cmd 'source ${join(dir, 'clipboard.vim')}'`);
  const hex = file => Buffer.from(file).toString('hex');
  const sides = () => JSON.parse(e.remote("json_encode(map(filter(getwininfo(), 'getwinvar(v:val.winid, \"&winfixbuf\") == 0'), 'fnamemodify(bufname(v:val.bufnr), \":t\")'))"));
  const focused = () => e.remote("expand('%:t')");
  const lines = name => JSON.parse(e.remote(`json_encode(getbufline(bufnr('${name}'), 1, '$'))`));
  const modified = name => e.remote(`getbufvar(bufnr('${name}'), '&modified')`) === '1';
  const keys = (...k) => e.tmux('send-keys', '-t', 'e', ...k);
  // Paced as a person's gestures: sent straight after Escape, a mouse sequence can be read as part of it.
  const mouse = async (...events) => { for (const event of events) { await sleep(200); keys('-l', `\x1b[<${event}`); } };
  const disk = file => readFileSync(file, 'utf8');
  // Screen position (1-based) of `text` in the left or right half.
  const at = (text, side) => {
    const rows = e.screen().split('\n');
    const y = rows.findIndex(row => (side === 'left' ? row.split('│')[0] : row.split('│')[1] ?? '').includes(text));
    assert.ok(y >= 0, `${text} on the ${side}:\n${e.screen()}`);
    const row = rows[y], offset = side === 'left' ? 0 : row.indexOf('│') + 1;
    return { x: [...row.slice(0, row.indexOf(text, offset))].length + 1, y: y + 1 };
  };
  try {
    await until(() => e.screen().includes('# Dest'), 'the editor is up');
    assert.equal(e.remote(`v:lua.PiMarkdownOpenLeft('${hex(files.a)}', '')`), 'writing');
    assert.deepEqual(sides(), ['a.md', 'b.md'], 'the chosen document on the left; the one shown stays on the right');
    assert.equal(focused(), 'a.md', 'the cursor on the left');
    await until(() => e.screen().includes('日本語'), 'both are drawn');

    // Unsaved text in the destination first, by a click into the right side and typing.
    const dest = at('# Dest', 'right');
    await mouse(`0;${dest.x};${dest.y}M`, `0;${dest.x};${dest.y}m`);
    await until(() => focused() === 'b.md', 'a click moves the cursor to the right');
    keys('G', 'o', 'typed before pasting', 'Escape');
    await until(() => modified('b.md'), 'unsaved destination text');

    // A mouse drag over the Unicode line on the left copies it on release.
    const line = at('åäö', 'left');
    // To past the line's end (15 cells wide), within the left side.
    await mouse(`0;${line.x};${line.y}M`, `32;${line.x + 20};${line.y}M`, `0;${line.x + 20};${line.y}m`);
    await until(() => read().startsWith('åäö — 日本語 😀'), `the drag copies the line (clipboard: ${JSON.stringify(read())})`);
    keys('Escape');
    await mouse(`0;${dest.x};${dest.y}M`, `0;${dest.x};${dest.y}m`);
    await until(() => focused() === 'b.md', 'back on the right');
    keys('G', 'o', 'Escape', 'p');
    await until(() => lines('b.md').some(text => text.includes('åäö — 日本語 😀')), 'p pastes it on the right');

    // Several lines, by keys: V j y on the left, p on the right.
    const left = at('second line', 'left');
    await mouse(`0;${left.x};${left.y}M`, `0;${left.x};${left.y}m`);
    await until(() => focused() === 'a.md', 'a click returns to the left');
    keys('g', 'g', 'j', 'j', 'V', 'j', 'y');
    await until(() => read() === 'åäö — 日本語 😀\nsecond line ✓\n', `V j y copies both lines (clipboard: ${JSON.stringify(read())})`);
    await mouse(`0;${dest.x};${dest.y}M`, `0;${dest.x};${dest.y}m`);
    await until(() => focused() === 'b.md', 'on the right again');
    keys('G', 'p');
    await until(() => lines('b.md').slice(-2).join('\n') === 'åäö — 日本語 😀\nsecond line ✓', 'the lines are pasted below');
    assert.ok(lines('b.md').includes('typed before pasting'), 'the destination keeps its unsaved text');
    assert.deepEqual(lines('a.md'), source.trimEnd().split('\n'), 'copying leaves the source as it was');
    assert.ok(!modified('a.md'), 'and unmodified');

    // Each side saves alone.
    keys('w');
    await until(() => !modified('b.md'), 'w saves the right side');
    assert.match(disk(files.b), /typed before pasting\n.*日本語 😀[\s\S]*second line ✓\n$/);
    await mouse(`0;${left.x};${left.y}M`, `0;${left.x};${left.y}m`);
    await until(() => focused() === 'a.md', 'left');
    keys('G', 'o', 'left draft', 'Escape');
    await until(() => modified('a.md'), 'unsaved text on the left');
    await mouse(`0;${dest.x};${dest.y}M`, `0;${dest.x};${dest.y}m`);
    await until(() => focused() === 'b.md', 'right');
    keys('G', 'o', 'more', 'Escape', 'w');
    await until(() => disk(files.b).endsWith('more\n'), 'the right saves again');
    assert.equal(disk(files.a), source, 'the left\'s file is untouched');
    assert.ok(modified('a.md') && lines('a.md').includes('left draft'), 'and its unsaved text kept');

    // Open on left for the document on the right swaps the sides; for the one on the left, only the cursor moves.
    assert.equal(e.remote(`v:lua.PiMarkdownOpenLeft('${hex(files.b)}', '')`), 'writing');
    assert.deepEqual(sides(), ['b.md', 'a.md'], 'never the same document twice');
    assert.equal(e.remote(`v:lua.PiMarkdownOpenLeft('${hex(files.b)}', '')`), 'writing');
    assert.deepEqual(sides(), ['b.md', 'a.md']);
    assert.equal(e.remote(`v:lua.PiMarkdownOpenLeft('${hex(files.c)}', '')`), 'writing');
    assert.deepEqual(sides(), ['c.md', 'a.md'], 'another document replaces the left only');
    assert.ok(modified('a.md') && lines('a.md').includes('left draft'), 'the right keeps its unsaved text throughout');

    // The focused document with unsaved text can be asked for too: on the left already, the cursor stays; from
    // one side, it moves left and another takes the right. Its text stays.
    const right = at('# Source', 'right');
    await mouse(`0;${right.x};${right.y}M`, `0;${right.x};${right.y}m`);
    await until(() => focused() === 'a.md', 'the cursor on the right, in unsaved a.md');
    assert.equal(e.remote(`v:lua.PiMarkdownOpenLeft('${hex(files.a)}', '')`), 'writing', 'the right side\'s modified document');
    assert.deepEqual(sides(), ['a.md', 'c.md'], 'swapped');
    assert.equal(e.remote(`v:lua.PiMarkdownOpenLeft('${hex(files.a)}', '')`), 'writing', 'asked again, focused and modified, on the left');
    assert.deepEqual(sides(), ['a.md', 'c.md']);
    assert.equal(e.remote('v:lua.PiMarkdownSingle()'), 'single');
    assert.deepEqual(sides(), ['c.md'], 'back beside Pi: the right side\'s');
    e.remote("execute('buffer a.md')");
    assert.equal(focused(), 'a.md');
    assert.equal(e.remote(`v:lua.PiMarkdownOpenLeft('${hex(files.a)}', '${hex(files.b)}')`), 'writing', 'from one side, focused and modified');
    assert.deepEqual(sides(), ['a.md', 'c.md'], 'the right takes the document shown before');
    assert.ok(modified('a.md') && lines('a.md').includes('left draft'), 'its unsaved text kept');
  } finally {
    e.stop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});
