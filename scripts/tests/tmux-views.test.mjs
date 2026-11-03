// Two terminals on the Pi workspace each get their own view (scripts/tmux-view.sh, scripts/pi-shell.zsh),
// and the sidebar toggle and Panels clicks treat a window shared by views as one window.
//
// Isolation: Pi runs inside the user's tmux, where a bare `tmux` follows $TMUX to the live server.
// Every call here names one of two disposable sockets with $TMUX unset: the test's own calls through
// `inner`/`outer`, and the code under test (which runs bare `tmux`) through a wrapper first on PATH.
// Nothing here runs a bare `tmux`. The "terminals" are panes of the outer server, each attached to
// the inner one, which plays the workspace. `pi` and the sidebar's `ccmux` are stubs that only wait.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findExecutable } from '../lib/diff-pane.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const sleep = ms => new Promise(done => setTimeout(done, ms));
async function until(check, message, ms = 10000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) {
    try { if (check()) return; } catch {}
  }
  assert.fail(message);
}

const REAL = findExecutable('tmux');
// The sidebar toggle under test: CCMUX_BIN, else the installed ccmux.
const CCMUX = process.env.CCMUX_BIN || findExecutable('ccmux');

test('each terminal views its own window; one sidebar per window; Panels clicks stay in the clicking view', { skip: !REAL && 'tmux is not installed' }, async t => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'tmux-views-')));
  const bin = join(dir, 'bin');
  const innerSock = join(dir, 'inner.sock'), outerSock = join(dir, 'outer.sock');
  mkdirSync(bin);
  writeFileSync(join(dir, 'inner.conf'), `source-file ${join(root, 'tmux/pi-tabs.conf')}\n`);
  const script = (name, body) => { writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`); chmodSync(join(bin, name), 0o755); };
  script('tmux', `unset TMUX TMUX_PANE\nexec '${REAL}' -S '${innerSock}' -f '${join(dir, 'inner.conf')}' "$@"`);
  script('pi', 'exec sleep 100000');
  // Sidebar panes run `ccmux sidebar` from PATH; the stub only takes the sidebar's pane title.
  script('ccmux', 'tmux select-pane -t "$TMUX_PANE" -T ccmux-sidebar\nexec sleep 100000');

  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, TMUX_TMPDIR: dir,
    CCMUX_HOME: join(dir, 'ccmux'), CCMUX_TMUX_SOCKET: innerSock, CCMUX_PORT: String(40000 + process.pid % 20000) };
  delete env.TMUX;
  delete env.TMUX_PANE;
  const call = sock => (...args) => execFileSync(REAL, ['-S', sock, ...args], { env, encoding: 'utf8' }).trim();
  const inner = call(innerSock), outer = call(outerSock);
  assert.ok(!('TMUX' in env) && innerSock.startsWith(dir) && outerSock.startsWith(dir), 'isolated before anything runs');

  // A terminal: an outer session whose pane runs `command`; returns its inner client name (its tty).
  let terminals = 0;
  async function terminal(command) {
    const name = `t${++terminals}`;
    const shell = `unset TMUX TMUX_PANE; cd '${dir}'; ${command}`;
    if (terminals === 1) outer('-f', '/dev/null', 'new-session', '-d', '-s', name, '-x', '120', '-y', '30', 'zsh', '-f', '-c', shell);
    else outer('new-session', '-d', '-s', name, '-x', '120', '-y', '30', 'zsh', '-f', '-c', shell);
    const tty = outer('display-message', '-p', '-t', name, '#{pane_tty}');
    await until(() => inner('list-clients', '-F', '#{client_name}').split('\n').includes(tty), `${name} attaches`);
    return { name, tty };
  }
  const piTerminal = () => terminal(`source '${join(root, 'scripts/pi-shell.zsh')}'; pi`);
  const sessionOf = client => inner('list-clients', '-F', '#{client_name} #{session_name}').split('\n')
    .map(line => line.split(' ')).find(([name]) => name === client.tty)?.[1];
  const windowOf = client => inner('display-message', '-p', '-t', sessionOf(client), '#{window_id}');

  try {
    const a = await piTerminal();
    assert.equal(inner('display-message', '-p', '#{socket_path}'), innerSock, 'the workspace is the test server');
    assert.equal(execFileSync(join(bin, 'tmux'), ['display-message', '-p', '#{socket_path}'],
      { env: { ...env, TMUX: '/elsewhere,1,0' }, encoding: 'utf8' }).trim(), innerSock, 'the wrapper ignores $TMUX');

    // Two `pi` terminals: two windows, each terminal on its own.
    const b = await piTerminal();
    const groups = inner('list-sessions', '-F', '#{session_name} #{session_group}').split('\n');
    assert.ok(groups.every(line => line.endsWith(' pi-workspace')), `one group: ${groups}`);
    assert.notEqual(sessionOf(a), sessionOf(b), 'each terminal has its own view');
    await until(() => windowOf(a) !== windowOf(b), 'the second Pi does not move the first terminal');
    const [windowA, windowB] = [windowOf(a), windowOf(b)];
    inner('select-window', '-t', `${sessionOf(b)}:${windowA}`);
    assert.equal(windowOf(a), windowA);
    inner('select-window', '-t', `${sessionOf(b)}:${windowB}`);

    // Plain attaches: a terminal alone on the session keeps it; a second one sharing it gets a view.
    const c = await terminal('tmux attach -t pi-workspace');
    await sleep(500);
    assert.equal(sessionOf(c), 'pi-workspace', 'alone in its session, nothing changes');
    const d = await terminal('tmux attach -t pi-workspace');
    await until(() => sessionOf(d) !== 'pi-workspace', 'a terminal sharing a session gets its own view');
    assert.equal(windowOf(d), windowOf(c), 'the view starts where the terminal was');
    const before = windowOf(c);
    inner('select-window', '-t', `${sessionOf(d)}:${before === windowA ? windowB : windowA}`);
    assert.equal(windowOf(c), before, 'switching windows in one view leaves the other');

    // A sidebar jump to a bare pane id (ccmux) from the terminal used last stays in its own view.
    const paneB = inner('list-panes', '-t', windowB, '-F', '#{pane_id}').split('\n')[0];
    outer('send-keys', '-t', a.name, 'x');
    await sleep(300);
    inner('switch-client', '-c', a.tty, '-t', paneB);
    assert.equal(windowOf(a), windowB);
    assert.ok(sessionOf(a) !== sessionOf(b) && sessionOf(a) !== 'pi-workspace', 'a jump keeps the terminal in its view');
    inner('switch-client', '-c', a.tty, '-t', `${sessionOf(a)}:${windowA}`);

    // Ctrl-Q's toggle, run as its binding does (run-shell, so $TMUX is the test server's): one sidebar per window, however many views list it; toggling again removes all.
    const sidebars = () => {
      const rows = inner('list-panes', '-a', '-F', '#{pane_id} #{window_id} #{pane_title}').split('\n')
        .filter(row => row.endsWith(' ccmux-sidebar'));
      return [...new Set(rows)].map(row => row.split(' ')[1]).sort();
    };
    const windows = () => [...new Set(inner('list-windows', '-a', '-F', '#{window_id}').split('\n'))].sort();
    if (!CCMUX) t.diagnostic('ccmux not found; sidebar toggle not checked');
    else {
      inner('run-shell', `'${CCMUX}' sidebar --toggle`);
      await until(() => sidebars().length >= windows().length, 'a sidebar in every window');
      await sleep(1000);
      assert.deepEqual(sidebars(), windows(), 'exactly one sidebar per window');
      inner('run-shell', `'${CCMUX}' sidebar --toggle`);
      await until(() => sidebars().length === 0, 'toggling again removes every sidebar');
    }

    // Ctrl+Q (the harness binding) acts on the pressing terminal's window only, at the configured width.
    mkdirSync(env.CCMUX_HOME, { recursive: true });
    writeFileSync(join(env.CCMUX_HOME, 'ccmux.json'), JSON.stringify({ sidebar: { width: 25 } }));
    const inWindow = window => inner('list-panes', '-t', window, '-F', '#{pane_title} #{pane_width}').split('\n')
      .filter(row => row.startsWith('ccmux-sidebar '));
    const [shownA, shownB] = [windowOf(a), windowOf(b)];
    assert.notEqual(shownA, shownB);
    outer('send-keys', '-t', a.name, 'C-q');
    await until(() => inWindow(shownA).length === 1, 'Ctrl+Q opens a sidebar in the pressing terminal\'s window');
    assert.deepEqual(inWindow(shownA), ['ccmux-sidebar 25'], 'at the configured width');
    await sleep(500);
    assert.deepEqual(sidebars(), [shownA], 'no other window gets one');
    assert.deepEqual([windowOf(a), windowOf(b)], [shownA, shownB], 'neither terminal moves');
    // A terminal resize keeps the configured width (ccmux's resize hook, registered on opening).
    outer('resize-window', '-t', a.name, '-x', '80', '-y', '30');
    await until(() => inWindow(shownA)[0] === 'ccmux-sidebar 25' && inner('display-message', '-p', '-t', shownA, '#{window_width}') === '80',
      'the sidebar keeps its width when its terminal is resized');
    outer('resize-window', '-t', a.name, '-x', '120', '-y', '30');
    outer('send-keys', '-t', b.name, 'C-q');
    await until(() => inWindow(shownB).length === 1, 'the other terminal opens its own');
    outer('send-keys', '-t', a.name, 'C-q');
    await until(() => inWindow(shownA).length === 0, 'pressing again closes only that window\'s sidebar');
    assert.deepEqual(sidebars(), [shownB]);
    outer('send-keys', '-t', b.name, 'C-q');
    await until(() => sidebars().length === 0, 'and the other');

    // A Panels tab click from terminal D, for terminal A's Pi: D shows that Pi in D's own view.
    const piA = inner('list-panes', '-t', windowA, '-F', '#{pane_id}').split('\n')[0];
    const hunk = inner('new-window', '-d', '-P', '-F', '#{pane_id}', '-t', 'pi-workspace:', 'sleep 100000');
    inner('set-option', '-p', '-t', hunk, '@pi_diff_root', dir);
    inner('set-option', '-p', '-t', hunk, '@pi_diff_owner', piA);
    inner('select-window', '-t', `${sessionOf(d)}:${windowB}`);
    outer('send-keys', '-t', b.name, 'x');  // another view is the most recently active
    const [viewD, windowC, windowAView] = [sessionOf(d), windowOf(c), windowOf(a)];
    execFileSync(process.execPath, ['--no-warnings', join(root, 'scripts/tmux-tabs.mjs'), `ps${hunk}`, d.tty], { env, encoding: 'utf8' });
    assert.equal(inner('display-message', '-p', '-t', hunk, '#{window_id}'), windowA, 'the preview joins its Pi');
    assert.equal(sessionOf(d), viewD, 'the clicking terminal stays in its view');
    assert.equal(windowOf(d), windowA, 'and shows that Pi');
    assert.deepEqual([windowOf(c), windowOf(a)], [windowC, windowAView], 'the other terminals do not move');

    // Two terminals of different sizes on one window: it takes the size of the terminal just focused,
    // so the bigger screen is filled, and a click right after the focus lands in that layout's pane.
    const shared = windowB;
    for (const view of [c, d]) inner('select-window', '-t', `${sessionOf(view)}:${shared}`);
    inner('split-window', '-h', '-d', '-t', shared, 'sleep 100000');
    inner('select-layout', '-t', shared, 'even-horizontal');
    outer('resize-window', '-t', d.name, '-x', '160', '-y', '40');
    const size = () => inner('display-message', '-p', '-t', shared, '#{window_width}x#{window_height}');
    const focus = view => outer('send-keys', '-t', view.name, '-l', '\x1b[I');
    focus(d);
    await until(() => size() === '160x38', `focusing the bigger terminal fills it (${size()})`);
    focus(c);
    await until(() => size() === '120x28', `focusing the smaller one fits it (${size()})`);
    const last = inner('list-panes', '-t', shared, '-F', '#{pane_id} #{pane_left}').split('\n').at(-1).split(' ');
    const x = Number(last[1]) + 2;  // inside the last pane at this size, inside an earlier pane at 160
    outer('send-keys', '-t', c.name, '-l', `\x1b[<0;${x};5M`);
    outer('send-keys', '-t', c.name, '-l', `\x1b[<0;${x};5m`);
    await until(() => inner('display-message', '-p', '-t', shared, '#{pane_id}') === last[0], 'the click selects the pane under it');

    // Closing terminals closes their views; the workspace and its windows remain.
    for (const closing of [a, b, d]) outer('kill-session', '-t', closing.name);
    await until(() => inner('list-sessions', '-F', '#{session_name}') === 'pi-workspace', 'only the workspace session is left');
    assert.ok(inner('list-windows', '-t', 'pi-workspace', '-F', '#{window_id}').split('\n').length >= 2);
  } finally {
    for (const stop of [outer, inner]) try { stop('kill-server'); } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
});
