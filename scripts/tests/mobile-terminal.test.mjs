// The mobile terminal (scripts/mobile-terminal.sh, tmux/mobile.conf, mobile/page.js): its buttons'
// key sequences act on the phone's own window and pane, and install/uninstall touch only their own
// LaunchAgent and Tailscale Serve route.
//
// Isolation, as in tmux-views.test.mjs: every tmux call names a disposable socket with $TMUX unset; the
// code under test runs bare `tmux` through a wrapper first on PATH. `launchctl` and `tailscale` are
// stubs that record their arguments; HOME and XDG_STATE_HOME are temporary.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findExecutable } from '../lib/diff-pane.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const script = join(root, 'scripts/mobile-terminal.sh');
const sleep = ms => new Promise(done => setTimeout(done, ms));
async function until(check, message, ms = 10000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) {
    try { if (check()) return; } catch {}
  }
  assert.fail(message);
}
const REAL = findExecutable('tmux');

function sandbox() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mobile-terminal-')));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const stub = (name, body) => { writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`); chmodSync(join(bin, name), 0o755); };
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: join(dir, 'home'), XDG_STATE_HOME: join(dir, 'state'),
    TMUX_TMPDIR: dir, CCMUX_HOME: join(dir, 'ccmux'), CCMUX_PORT: String(40000 + process.pid % 20000) };
  delete env.TMUX;
  delete env.TMUX_PANE;
  return { dir, bin, stub, env };
}

test('buttons act on the phone client\'s window and pane', { skip: !REAL && 'tmux is not installed' }, async () => {
  const { dir, stub, env } = sandbox();
  const innerSock = join(dir, 'inner.sock'), outerSock = join(dir, 'outer.sock');
  writeFileSync(join(dir, 'inner.conf'), `source-file ${join(root, 'tmux/pi-tabs.conf')}\n`);
  stub('tmux', `unset TMUX TMUX_PANE\nexec '${REAL}' -S '${innerSock}' -f '${join(dir, 'inner.conf')}' "$@"`);
  stub('ccmux', 'tmux select-pane -t "$TMUX_PANE" -T ccmux-sidebar\nexec sleep 100000');
  const call = sock => (...args) => execFileSync(REAL, ['-S', sock, ...args], { env, encoding: 'utf8' }).trim();
  const inner = call(innerSock), outer = call(outerSock);
  assert.ok(!('TMUX' in env) && innerSock.startsWith(dir) && outerSock.startsWith(dir), 'isolated before anything runs');
  try {
    // The workspace: window A with "Pi" and an "editor" (recording the bytes it is sent), window B.
    inner('-f', join(dir, 'inner.conf'), 'new-session', '-d', '-s', 'pi-workspace', '-x', '120', '-y', '30', 'sleep 100000');
    const windowA = inner('display-message', '-p', '#{window_id}');
    const pi = inner('display-message', '-p', '#{pane_id}');
    const recorder = `process.stdin.setRawMode(true); process.stdin.on('data', d => require('fs').appendFileSync('${dir}/editor', d))`;
    writeFileSync(join(dir, 'editor'), '');
    const editor = inner('split-window', '-h', '-d', '-P', '-F', '#{pane_id}', '-t', windowA, `node -e "${recorder}"`);
    inner('set-option', '-p', '-t', editor, '@pi_doc_server', '/tmp/editor.sock');
    inner('set-option', '-p', '-t', pi, '@pi_owner', '1');
    const diff = inner('split-window', '-v', '-d', '-P', '-F', '#{pane_id}', '-t', editor, 'sleep 100000');
    inner('set-option', '-p', '-t', diff, '@pi_diff_owner', pi);
    const windowB = inner('new-window', '-d', '-P', '-F', '#{window_id}', '-t', 'pi-workspace:', 'sleep 100000');
    mkdirSync(env.CCMUX_HOME);
    writeFileSync(join(env.CCMUX_HOME, 'ccmux.json'), JSON.stringify({ sidebar: { width: 30 } }));

    // A desktop terminal on window B, then the phone through ttyd's command (attach), which gets its own view.
    const terminal = (name, size, command) => {
      outer('-f', '/dev/null', 'new-session', '-d', '-s', name, '-x', size[0], '-y', size[1], '/bin/sh', '-c', `${command}; sleep 100000`);
      return outer('display-message', '-p', '-t', name, '#{pane_tty}');
    };
    inner('select-window', '-t', `pi-workspace:${windowB}`);
    const desktop = terminal('desktop', ['120', '30'], 'tmux attach -t =pi-workspace');
    await until(() => inner('list-clients', '-F', '#{client_name}').includes(desktop), 'the desktop attaches');
    // The phone attaches as the LaunchAgent runs it: the real tmux, reaching the workspace only through
    // the recorded socket (the default one, in this test's TMUX_TMPDIR, has no server).
    const realBin = join(dir, 'real');
    mkdirSync(realBin);
    execFileSync('ln', ['-s', REAL, join(realBin, 'tmux')]);
    const phone = terminal('phone', ['60', '30'],
      `PATH='${realBin}':"$PATH" PI_MOBILE_TMUX_SOCKET='${innerSock}' sh '${script}' attach pi-workspace`);
    const viewOf = client => inner('list-clients', '-F', '#{client_name} #{session_name}').split('\n').find(line => line.startsWith(client + ' '))?.split(' ')[1];
    await until(() => viewOf(phone) && viewOf(phone) !== 'pi-workspace', 'the phone gets its own view');
    const view = viewOf(phone);
    inner('select-window', '-t', `${view}:${windowA}`);
    const press = key => outer('send-keys', '-t', 'phone', '-l', `\x1b[${key}~`);
    const sidebars = window => inner('list-panes', '-t', window, '-F', '#{pane_title} #{pane_width}').split('\n').filter(row => row.startsWith('ccmux-sidebar '));
    const zoomed = () => inner('display-message', '-p', '-t', windowA, '#{window_zoomed_flag}');

    // Sidebar, narrower, wider: the phone's window only; a resize keeps the chosen width; closing forgets it.
    press(9001);
    await until(() => sidebars(windowA).length === 1, 'Sidebar opens one in the phone\'s window');
    assert.deepEqual(sidebars(windowB), [], 'not in the desktop\'s window');
    press(9002);
    await until(() => sidebars(windowA)[0] === 'ccmux-sidebar 25', 'narrower by 5');
    press(9003); press(9003);
    await until(() => sidebars(windowA)[0] === 'ccmux-sidebar 35', 'wider by 5, twice');
    outer('resize-window', '-t', 'phone', '-x', '70', '-y', '25');
    await until(() => inner('display-message', '-p', '-t', windowA, '#{window_width}') === '70', 'the phone resizes');
    await sleep(500);
    assert.deepEqual(sidebars(windowA), ['ccmux-sidebar 35'], 'the chosen width survives a resize');

    // Focus survives the page resizing (a keyboard opening), although the window has a sidebar.
    inner('select-pane', '-t', editor);
    press(9007);
    await until(() => zoomed() === '1', 'Focus zooms the active pane');
    outer('resize-window', '-t', 'phone', '-x', '60', '-y', '15');
    await until(() => inner('display-message', '-p', '-t', windowA, '#{window_height}') !== '23', 'the phone resizes');
    await sleep(500);
    assert.equal(zoomed(), '1', 'still focused after the resize');

    // Top controls select a pane type while keeping Focus; repeated presses never cycle previews.
    const activePane = () => inner('display-message', '-p', '-t', view, '#{pane_id}');
    const sidebarPane = inner('list-panes', '-t', windowA, '-F', '#{pane_id} #{pane_title}').split('\n')
      .find(row => row.endsWith(' ccmux-sidebar')).split(' ')[0];
    const select = async (key, check, message) => {
      press(key);
      await until(() => check(activePane()), message);
      assert.equal(zoomed(), '1', `${message}: still focused`);
      return activePane();
    };
    await select(9009, pane => pane === pi, 'Agent selects Pi');
    const first = await select(9010, pane => pane === editor || pane === diff, 'Preview selects a preview');
    press(9010);
    await sleep(300);
    assert.equal(activePane(), first, 'Preview again keeps the selected preview');
    const other = first === editor ? diff : editor;
    inner('select-pane', '-Z', '-t', other);
    press(9010);
    await sleep(300);
    assert.equal(activePane(), other, 'Preview preserves a different explicitly selected preview');
    await select(9008, pane => pane === sidebarPane, 'Sessions selects the sidebar');
    inner('select-pane', '-Z', '-t', editor);

    // Edit, Esc and Save reach the editor pane; with Pi active they type nothing anywhere.
    for (const key of [9004, 9005, 9006]) press(key);
    const sent = '\x1c\x0ei\x1c\x0e\x1c\x0ew';
    await until(() => readFileSync(join(dir, 'editor'), 'utf8') === sent, 'Ctrl-\\ Ctrl-N, then i or w, reach the editor');
    press(9007);
    await until(() => zoomed() === '0', 'Focus again shows every pane');
    inner('select-pane', '-t', pi);
    const piBefore = inner('capture-pane', '-p', '-t', pi);
    for (const key of [9004, 9005, 9006]) press(key);
    await sleep(500);
    assert.equal(readFileSync(join(dir, 'editor'), 'utf8'), sent, 'nothing more reaches the editor');
    assert.equal(inner('capture-pane', '-p', '-t', pi), piBefore, 'nor Pi');

    // Switching the phone to window B moves the buttons with it. B has no Pi: Agent says so and changes nothing.
    inner('select-window', '-t', `${view}:${windowB}`);
    const onlyB = inner('display-message', '-p', '-t', view, '#{pane_id}');
    press(9009);
    await until(() => outer('capture-pane', '-p', '-t', 'phone').includes('No Pi pane in this window'), 'Agent reports no Pi');
    assert.equal(inner('display-message', '-p', '-t', view, '#{pane_id}'), onlyB);
    assert.equal(inner('list-panes', '-t', windowB, '-F', '#{pane_id}'), onlyB, 'nothing opened');
    press(9001);
    await until(() => sidebars(windowB).length === 1, 'Sidebar follows the phone to window B');
    press(9001);
    await until(() => sidebars(windowB).length === 0, 'and closes there');
    inner('select-window', '-t', `${view}:${windowA}`);
    press(9001);
    await until(() => sidebars(windowA).length === 0, 'closing window A\'s sidebar');
    assert.equal(spawnSync(REAL, ['-S', innerSock, 'show-options', '-wqv', '-t', windowA, '@pi_sidebar_width'], { env, encoding: 'utf8' }).stdout.trim(), '',
      'closing forgets the chosen width');

    // Leaving closes only the phone's view.
    outer('kill-session', '-t', 'phone');
    await until(() => !inner('list-sessions', '-F', '#{session_name}').includes(view), 'the phone\'s view closes');
    assert.deepEqual(inner('list-panes', '-t', windowA, '-F', '#{pane_id}').split('\n').sort(), [pi, editor, diff].sort(), 'Pi and the previews remain');
    assert.notEqual(spawnSync(REAL, ['list-sessions'], { env }).status, 0, 'no server was started on the default socket');
  } finally {
    for (const stop of [outer, inner]) try { stop('kill-server'); } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
});

test('install and uninstall touch only their own service and Serve route', () => {
  const { dir, stub, env } = sandbox();
  const serve = join(dir, 'serve.json'), calls = join(dir, 'calls');
  // tailscale: `serve status --json` prints serve.json; everything is recorded.
  stub('tailscale', `echo "tailscale $*" >> '${calls}'\n[ "$2" = status ] && cat '${serve}'\nexit 0`);
  // launchctl: a service counts as loaded once bootstrapped, until booted out.
  stub('launchctl', `echo "launchctl $*" >> '${calls}'
case $1 in
  bootstrap) touch '${dir}/loaded' ;;
  bootout) [ -f '${dir}/loaded' ] || exit 3; rm -f '${dir}/loaded' ;;
  print) [ -f '${dir}/loaded' ] && echo 'state = running' || exit 113 ;;
esac`);
  for (const tool of ['ttyd', 'nc']) stub(tool, tool === 'nc' ? 'exit 1' : 'exit 0');
  const run = (...args) => spawnSync('sh', [script, ...args], { env: { ...env, PI_MOBILE_LABEL: 'test.mobile' }, encoding: 'utf8' });
  const host = 'mac.example.ts.net';
  const route = (proxy, extra = {}) => JSON.stringify({ TCP: { 8443: { HTTPS: true } },
    Web: { [`${host}:8443`]: { Handlers: { '/': { Proxy: proxy }, ...extra } } } });
  const log = () => existsSync(calls) ? readFileSync(calls, 'utf8') : '';
  const plist = join(env.HOME, 'Library/LaunchAgents/test.mobile.plist');
  try {
    // Another route on 8443: refused before anything is installed.
    writeFileSync(serve, route('http://127.0.0.1:3000'));
    let result = run('install');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /already in use/);
    assert.ok(!existsSync(plist) && !/bootstrap|serve --bg/.test(log()), 'nothing installed or served');
    // Unreadable Serve configuration (tailscale failing or not JSON): refused, not taken as free.
    for (const broken of ['', 'not json']) {
      writeFileSync(serve, broken);
      result = run('install');
      assert.match(result.stderr, /Could not read/, `serve status ${JSON.stringify(broken)}`);
    }
    assert.ok(!existsSync(plist) && !/bootstrap|serve --bg/.test(log()), 'still nothing installed or served');
    // Funnel on that port: refused too.
    writeFileSync(serve, JSON.stringify({ ...JSON.parse(route('http://127.0.0.1:7681')), AllowFunnel: { [`${host}:8443`]: true } }));
    assert.notEqual(run('install').status, 0, 'a public Funnel route is refused');

    // Free port: the LaunchAgent runs `run` at login and keeps it alive; the route is added. A path
    // with XML's special characters still makes a valid plist.
    writeFileSync(serve, '{}');
    env.PI_MOBILE_STATE = join(dir, 'a&b<c');
    env.XDG_DATA_HOME = join(dir, 'data');
    const installed = join(dir, 'data/pi-mobile-terminal');
    const files = ['scripts/mobile-terminal.sh', 'scripts/tmux-sidebar.sh', 'scripts/tmux-mobile-select.sh', 'tmux/mobile.conf', 'mobile/page.js'];
    result = run('install', 'pi-workspace');
    assert.equal(result.status, 0, result.stderr);
    const agent = readFileSync(plist, 'utf8');
    // The service runs a copy outside the checkout, which macOS may refuse a LaunchAgent (~/Documents).
    assert.match(agent, new RegExp(`<string>${installed}/scripts/mobile-terminal.sh</string><string>run</string><string>pi-workspace</string>`));
    for (const file of files) assert.equal(readFileSync(join(installed, file), 'utf8'), readFileSync(join(root, file), 'utf8'), `${file} copied`);
    assert.match(agent, /<key>RunAtLoad<\/key><true\/>/);
    assert.ok(agent.includes(`<key>PATH</key><string>${env.PATH}</string>`), 'the installer\'s PATH, in its order');
    assert.ok(agent.includes('a&amp;b&lt;c'), 'escaped');
    assert.equal(spawnSync('plutil', ['-lint', '-s', plist]).status, 0, 'a valid plist');
    assert.match(agent, /<key>KeepAlive<\/key><true\/>/);
    assert.match(log(), /launchctl bootstrap gui\/\d+ .*test\.mobile\.plist/);
    assert.match(log(), /tailscale serve --bg --https=8443 http:\/\/127\.0\.0\.1:7681/);
    // Reinstalling with our route already present does not add it again, and refreshes the copy.
    writeFileSync(serve, route('http://127.0.0.1:7681'));
    writeFileSync(join(installed, 'mobile/page.js'), 'stale');
    writeFileSync(join(installed, 'extra'), 'left over');
    writeFileSync(calls, '');
    assert.equal(run('install').status, 0);
    assert.doesNotMatch(log(), /serve --bg/);
    assert.equal(readFileSync(join(installed, 'mobile/page.js'), 'utf8'), readFileSync(join(root, 'mobile/page.js'), 'utf8'), 'refreshed');
    assert.ok(!existsSync(join(installed, 'extra')), 'replaced as a whole');
    // A plist that fails its check leaves the running service and its copy alone.
    const failing = join(dir, 'failing');
    mkdirSync(failing);
    writeFileSync(join(failing, 'plutil'), '#!/bin/sh\nexit 1\n');
    chmodSync(join(failing, 'plutil'), 0o755);
    writeFileSync(join(installed, 'mobile/page.js'), 'running copy');
    writeFileSync(calls, '');
    result = spawnSync('sh', [script, 'install'], { env: { ...env, PI_MOBILE_LABEL: 'test.mobile', PATH: `${failing}:${env.PATH}` }, encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(log(), /bootout|bootstrap/);
    assert.equal(readFileSync(join(installed, 'mobile/page.js'), 'utf8'), 'running copy', 'the running copy is kept');
    assert.ok(!existsSync(`${installed}.new`) && !existsSync(`${plist}.new`), 'no staged files left');
    // Install from the installed copy is refused (it would replace itself).
    assert.match(spawnSync('sh', [join(installed, 'scripts/mobile-terminal.sh'), 'install'], { env: { ...env, PI_MOBILE_LABEL: 'test.mobile' }, encoding: 'utf8' }).stderr, /from the checkout/);
    assert.match(run('status').stdout, new RegExp(`Service: running\\nURL: https://${host}:8443`));

    // Uninstall: our route is removed; a route with other handlers is left alone.
    writeFileSync(calls, '');
    assert.equal(run('uninstall').status, 0);
    assert.ok(!existsSync(plist));
    assert.ok(!existsSync(installed) && existsSync(join(dir, 'data')), 'only its own copy is removed');
    assert.match(log(), /launchctl bootout gui\/\d+\/test\.mobile/);
    assert.match(log(), /tailscale serve --https=8443 off/);
    writeFileSync(serve, route('http://127.0.0.1:7681', { '/other': { Proxy: 'http://127.0.0.1:9000' } }));
    writeFileSync(calls, '');
    result = run('uninstall');
    assert.match(result.stderr, /Left Tailscale Serve/);
    assert.doesNotMatch(log(), /off/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
