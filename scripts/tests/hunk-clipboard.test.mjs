// Hunk's copies reach the native clipboard under tmux: the parser on synthetic output, then real Hunk in a
// disposable tmux server with a fake pbcopy; never the user's tmux server or clipboard. Run with HOME, XDG
// and TMUX_TMPDIR isolated (see SETUP.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const { createParser, createQueue, osc52Text, pbcopy, pbcopyEnv, MAX_SEQUENCE } = await import(pathToFileURL(join(root, 'scripts/hunk-clipboard.mjs')).href);
const b64 = text => Buffer.from(text).toString('base64');
const osc = (text, end = '\x07') => `\x1b]52;c;${b64(text)}${end}`;
const wrapped = text => `\x1bPtmux;${osc(text, '\x1b\\').replaceAll('\x1b', '\x1b\x1b')}\x1b\\`;
const parse = (chunks, max) => {
  const copies = [], errors = [];
  const parser = createParser(bytes => copies.push(bytes.toString('utf8')), message => errors.push(message), max);
  for (const chunk of chunks) parser.write(Buffer.from(chunk, 'latin1'));
  return { copies, errors };
};

test('parser: plain and tmux-wrapped OSC 52, split at every byte, with other output around it', () => {
  const text = 'naïve “quotes”\nsecond line\t✓';
  const stream = Buffer.concat([Buffer.from('\x1b[2J\x1b[38;2;1;2;3mscreen text'), Buffer.from(wrapped(text)), Buffer.from('more \x1b]0;title\x07'),
    Buffer.from(osc('plain one', '\x1b\\'))]).toString('latin1');
  assert.deepEqual(parse([stream]).copies, [text, 'plain one']);
  assert.deepEqual(parse([...stream]).copies, [text, 'plain one'], 'one byte at a time');
});

test('parser: queries, clears, malformed and oversized sequences copy nothing, and parsing goes on', () => {
  const { copies, errors } = parse(['\x1b]52;c;?\x07', '\x1b]52;c;\x07', '\x1b]52;c;not base64!!\x07', '\x1b]52;c;abc\x07',
    '\x1bPtmux;\x1b]52;c;broken', '\x1bx', osc('x'.repeat(200)), osc('after')], 64);
  assert.deepEqual(copies, ['after']);
  assert.equal(errors.length, 1, 'the oversized one is reported once');
  assert.ok(!errors[0].includes('xxx'), 'without its content');
  assert.equal(osc52Text(Buffer.from('52;c;' + b64('ok'))).toString(), 'ok');
  // Valid data just under the limit, plain and wrapped, copies without breaking the parser; the next copy still arrives.
  const near = 'A'.repeat(MAX_SEQUENCE - 16);
  const big = parse([`\x1b]52;c;${near}\x07`, `\x1bPtmux;\x1b\x1b]52;c;${near}\x07\x1b\\`, osc('next')]);
  assert.deepEqual(big.copies.map(text => text.length), [near.length * 3 / 4, near.length * 3 / 4, 4]);
  assert.deepEqual(big.errors, []);
});

test('pbcopy runs under a UTF-8 locale even when LC_ALL says otherwise', () => {
  const env = pbcopyEnv({ ...process.env, LC_ALL: 'C', LANG: 'C' });
  assert.equal(execFileSync('/usr/bin/locale', ['charmap'], { env, encoding: 'utf8' }).trim(), 'UTF-8');
});

test('queue: one copy at a time; while one runs only the newest waits, so the last copy wins', async () => {
  const done = [], errors = [];
  let release;
  const queue = createQueue(bytes => new Promise(resolve => { done.push(bytes); release = resolve; }), message => errors.push(message));
  queue.push('a'); queue.push('b'); queue.push('c');
  assert.deepEqual(done, ['a']);
  release(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(done, ['a', 'c']);
  release(); await new Promise(resolve => setImmediate(resolve));
  assert.ok(queue.idle());
  const failing = createQueue(async () => { throw new Error('pbcopy exited 1'); }, message => errors.push(message));
  failing.push('x'); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(errors, ['pbcopy exited 1']);
  // A pbcopy that stalls (reads nothing, never exits) is killed after the timeout; the failure names no copied text.
  const dir = mkdtempSync(join(tmpdir(), 'stalled-pbcopy-'));
  const stalled = join(dir, 'pbcopy'), pidFile = join(dir, 'pid');
  writeFileSync(stalled, `#!/bin/sh\necho $$ > '${pidFile}'\nexec sleep 30\n`);
  chmodSync(stalled, 0o755);
  try {
    const started = Date.now();
    await assert.rejects(pbcopy(Buffer.from('secret'), stalled, 300), error => /stopped \(SIGKILL\)/.test(error.message) && !error.message.includes('secret'));
    assert.ok(Date.now() - started < 3000, 'within the timeout, not after sleep 30');
    const pid = Number(readFileSync(pidFile, 'utf8'));
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, 'the stalled child is gone');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('real Hunk in tmux: a selection copied with y reaches pbcopy, through the shared Hunk launch path', async () => {
  assert.notEqual(realpathSync(process.env.HOME), realpathSync(userInfo().homedir), 'run with an isolated HOME (see SETUP.md)');
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'hunk-clipboard-')));
  const socket = `hunk-clip-${process.pid}`;
  const tmux = (...args) => execFileSync('tmux', ['-L', socket, ...args], { encoding: 'utf8' }).trim();
  const previous = { TMUX: process.env.TMUX, TMUX_PANE: process.env.TMUX_PANE, PATH: process.env.PATH };
  // A fake pbcopy first on PATH, in a folder whose name needs quoting (', $, #, space): each copy is appended
  // to `sink` between markers. A second one records any copy that reached a replaced reader.
  const bin = join(dir, `bin it's $HOME #{pane_id}`), sink = join(dir, 'sink'), other = join(dir, 'other-sink');
  mkdirSync(bin);
  const fake = (name, out) => { writeFileSync(join(bin, name), `#!/bin/sh\n{ printf '<<'; cat; printf '>>'; } >> '${out}'\n`); chmodSync(join(bin, name), 0o755); };
  fake('pbcopy', sink); fake('other-pbcopy', other);
  process.env.PATH = `${bin}:${process.env.PATH}`;
  const repo = join(dir, 'repo');
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
  try {
    execFileSync('git', ['init', '-q', repo]);
    writeFileSync(join(repo, 'f.txt'), 'alpha\nbeta\n');
    git('add', '.'); git('-c', 'user.name=t', '-c', 'user.email=t@e.test', 'commit', '-qm', 'a');
    writeFileSync(join(repo, 'f.txt'), 'alpha\nCOPYME naïve text\n');
    tmux('-f', '/dev/null', 'new-session', '-d', '-s', 't', '-x', '160', '-y', '40', '-c', repo);
    const owner = tmux('display-message', '-p', '-t', 't', '#{pane_id}');
    process.env.TMUX = `${tmux('display-message', '-p', '#{socket_path}')},0,0`;
    process.env.TMUX_PANE = owner;
    assert.equal(execFileSync('tmux', ['display-message', '-p', '#{socket_path}'], { encoding: 'utf8' }).trim(), tmux('display-message', '-p', '#{socket_path}'));
    // The controller's own Hunk launch: a turn that changes the repository opens it.
    const { createDiffPane } = await import(pathToFileURL(join(root, 'scripts/lib/diff-pane.ts')).href);
    const pane = createDiffPane();
    const ctx = { mode: 'tui', cwd: repo };
    pane.setTempFiles([], join(dir, 'baselines'));
    await pane.before({ toolName: 'edit', input: { path: join(repo, 'f.txt') } }, ctx);
    writeFileSync(join(repo, 'f.txt'), 'alpha\nCOPYME naïve text\nmore\n');
    await pane.settle();
    const hunk = tmux('list-panes', '-a', '-F', '#{pane_id} #{@pi_diff_owner}').split('\n').map(row => row.split(' ')).find(([, tag]) => tag === owner)?.[0];
    assert.ok(hunk, 'Hunk opened');
    assert.equal(tmux('display-message', '-p', '-t', hunk, '#{pane_pipe}'), '1', 'its output is piped to the reader');
    let row, col;
    for (let i = 0; i < 50 && !row; i++) {
      const lines = tmux('capture-pane', '-p', '-t', hunk).split('\n');
      const at = lines.findIndex(line => line.includes('COPYME'));
      if (at >= 0) { row = at + 1; col = lines[at].indexOf('COPYME') + 1; } else await new Promise(done => setTimeout(done, 100));
    }
    assert.ok(row, 'the diff shows');
    const mouse = (button, x, end) => tmux('send-keys', '-t', hunk, '-l', `\x1b[<${button};${x};${row}${end}`);
    mouse(0, col, 'M'); mouse(32, col + 11, 'M'); mouse(0, col + 11, 'm');
    await new Promise(done => setTimeout(done, 400));
    tmux('send-keys', '-t', hunk, 'y');
    for (let i = 0; i < 50 && !(existsSync(sink) && readFileSync(sink, 'utf8').endsWith('>>')); i++) await new Promise(done => setTimeout(done, 100));
    assert.equal(readFileSync(sink, 'utf8'), '<<COPYME naïve>>', 'exactly the selection, once, UTF-8 intact');
    // Attaching again keeps the existing pipe: a second copy still reaches the first reader's pbcopy.
    const { attachHunkClipboard } = await import(pathToFileURL(join(root, 'scripts/lib/diff-pane.ts')).href);
    await attachHunkClipboard(hunk, join(bin, 'other-pbcopy'));
    assert.equal(tmux('display-message', '-p', '-t', hunk, '#{pane_pipe}'), '1');
    mouse(0, col, 'M'); mouse(32, col + 5, 'M'); mouse(0, col + 5, 'm');
    await new Promise(done => setTimeout(done, 400));
    tmux('send-keys', '-t', hunk, 'y');
    for (let i = 0; i < 50 && !readFileSync(sink, 'utf8').endsWith('<<COPYME>>'); i++) await new Promise(done => setTimeout(done, 100));
    assert.equal(readFileSync(sink, 'utf8'), '<<COPYME naïve>><<COPYME>>', 'both copies, in order');
    assert.ok(!existsSync(other), 'the second attachment did not replace the reader');
    // Without pbcopy nothing is attached.
    const plain = tmux('split-window', '-d', '-P', '-F', '#{pane_id}', '-t', owner, 'sleep 100');
    await attachHunkClipboard(plain, '');
    assert.equal(tmux('display-message', '-p', '-t', plain, '#{pane_pipe}'), '0');
    await pane.close('tui');
  } finally {
    try { tmux('kill-server'); } catch {}
    Object.assign(process.env, previous);
    for (const key of Object.keys(previous)) if (previous[key] === undefined) delete process.env[key];
    rmSync(dir, { recursive: true, force: true });
  }
});
