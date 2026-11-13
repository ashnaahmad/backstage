// A session's own temporary files in the existing panels: real Pi loader, Hunk, Neovim and a disposable tmux
// server; never the user's tmux server. Run with HOME, XDG and TMUX_TMPDIR isolated (see SETUP.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const socketName = `pi-temp-test-${process.pid}`;
// The fixture lives in the system temporary folder, as an agent's /tmp output does.
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'temp-panels-')));
const repo = join(dir, 'repo'), scratch = join(dir, 'scratch');
const tmux = (...args) => execFileSync('tmux', ['-L', socketName, ...args], { encoding: 'utf8' }).trim();
const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe', env: { ...process.env,
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.test', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.test' } });
const sleep = ms => new Promise(done => setTimeout(done, ms));
const tagged = (tag, owner) => tmux('list-panes', '-a', '-F', `#{pane_id} #{${tag}}`).split('\n').map(row => row.split(' '))
  .filter(([, value]) => value === owner).map(([id]) => id);
const diffPanes = owner => tagged('@pi_diff_owner', owner);
const docPanes = owner => tagged('@pi_doc_owner', owner);
const rootOf = pane => tmux('show-options', '-pqv', '-t', pane, '@pi_diff_root');
const diffOf = (owner, file) => diffPanes(owner).filter(pane => rootOf(pane) === file);
const screen = pane => tmux('capture-pane', '-p', '-t', pane);
async function waitFor(check, message) {
  for (let i = 0; i < 60; i++) { try { if (await check()) return; } catch {} await sleep(100); }
  assert.fail(message);
}
const previous = { TMUX: process.env.TMUX, TMUX_PANE: process.env.TMUX_PANE };
const signals = Object.fromEntries(['SIGHUP', 'SIGTERM'].map(signal => [signal, process.listeners(signal)]));
let loader, lib, calls = 0;

const fire = async (pi, name, event = {}) => { for (const handler of pi.ext.handlers.get(name) ?? []) await handler(event, pi.ctx); };
// One tool call as its own turn; `change` is what the tool does.
async function tool(pi, toolName, input, change) {
  const event = { toolCallId: `call-${++calls}`, toolName, input };
  await fire(pi, 'tool_call', event);
  change?.();
  await fire(pi, 'tool_result', { ...event, content: [] });
  await fire(pi, 'turn_end');
}
// A Pi in `pane` on session `id`, whose custom entries live in `saved` (as a session file keeps them).
async function start(pane, id, saved) {
  const runtime = loader.createExtensionRuntime();
  runtime.appendEntry = (customType, data) => saved.push({ type: 'custom', customType, data });
  const before = process.env.TMUX_PANE;
  process.env.TMUX_PANE = pane;
  try {
    const result = await loader.loadExtensions([join(root, 'pi/extensions/diff-pane.ts')], root, undefined, runtime);
    assert.deepEqual(result.errors, []);
    const notices = [];
    const pi = { ext: result.extensions[0], saved, notices, pane,
      // Entries come back as a session file gives them: serialised and read again.
      ctx: { mode: 'tui', cwd: repo, hasUI: true, ui: { notify: text => notices.push(text) },
        sessionManager: { getSessionId: () => id, getEntries: () => JSON.parse(JSON.stringify(saved)) } } };
    await fire(pi, 'session_start');
    await fire(pi, 'before_agent_start');
    return pi;
  } finally { process.env.TMUX_PANE = before; }
}
const quit = pi => fire(pi, 'session_shutdown', { reason: 'quit' });
const temps = pi => pi.saved.filter(entry => entry.customType === 'harness-session-temp-file').map(entry => entry.data);
async function panel(pi, name) {
  const shown = [];
  await pi.ext.commands.get('panel').handler(name, { ...pi.ctx, ui: { ...pi.ctx.ui, notify: text => shown.push(text) } });
  return shown[0];
}
const showPanel = async (pi, name) => (await pi.ext.tools.get('show_panel').definition.execute('call', { name }, undefined, undefined, pi.ctx)).content[0].text;
// What /panels offers, as its selector draws it.
async function offered(pi) {
  let drawn = '';
  const ui = { ...pi.ctx.ui, custom: factory => new Promise(resolve => {
    drawn = factory({ requestRender() {} }, { fg: (_color, text) => text, bold: text => text }, undefined, resolve).render(220).join('\n');
    resolve(undefined);
  }) };
  await pi.ext.commands.get('panels').handler('', { ...pi.ctx, ui });
  return drawn;
}
const newPane = () => tmux('new-window', '-d', '-P', '-F', '#{pane_id}', '-c', repo, 'sleep 100000');
// The /tmp or /var spelling of a path in /private (macOS aliases), or the path itself elsewhere.
const alias = file => /^\/private\/(tmp|var)\//.test(file) ? file.slice('/private'.length) : file;

test.before(async () => {
  // Baseline copies go to XDG_STATE_HOME and Hunk and Neovim write under HOME: both must be the test's own.
  assert.notEqual(realpathSync(process.env.HOME), realpathSync(userInfo().homedir), 'run with an isolated HOME (see SETUP.md)');
  assert.ok(process.env.XDG_STATE_HOME && !realpathSync(process.env.XDG_STATE_HOME).startsWith(realpathSync(userInfo().homedir) + '/'),
    'run with an isolated XDG_STATE_HOME');
  mkdirSync(scratch);
  execFileSync('git', ['init', '-q', repo]);
  writeFileSync(join(repo, 'tracked.txt'), 'one\n');
  git('add', '.'); git('commit', '-qm', 'baseline');
  tmux('new-session', '-d', '-s', 'test', '-x', '240', '-y', '50', '-c', repo);
  process.env.TMUX = `${tmux('display-message', '-p', '#{socket_path}')},0,0`;
  // Guard: plain `tmux` must now address the disposable server.
  assert.equal(execFileSync('tmux', ['display-message', '-p', '#{socket_path}'], { encoding: 'utf8' }).trim(), tmux('display-message', '-p', '#{socket_path}'));
  const modules = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
  loader = await import(pathToFileURL(join(modules, '@earendil-works/pi-coding-agent/dist/core/extensions/loader.js')).href);
  lib = await import(pathToFileURL(join(root, 'scripts/lib/diff-pane.ts')).href);
});
test.after(() => {
  const socket = tmux('display-message', '-p', '#{socket_path}');
  try { tmux('kill-server'); } catch {}
  rmSync(socket, { force: true });
  for (const [signal, kept] of Object.entries(signals)) for (const listener of process.listeners(signal)) if (!kept.includes(listener)) process.off(signal, listener);
  Object.assign(process.env, previous);
  for (const key of Object.keys(previous)) if (previous[key] === undefined) delete process.env[key];
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

test('a temporary file the session writes or edits shows its diff against what it held first; other files there stay out', async () => {
  const pane = newPane();
  const pi = await start(pane, 'session-a', []);
  try {
    // A write through the /tmp alias into folders that do not exist yet, as the write tool creates them.
    const made = join(scratch, 'run', 'nested', 'result.txt');
    await tool(pi, 'write', { path: alias(made) }, () => { mkdirSync(join(scratch, 'run', 'nested'), { recursive: true }); writeFileSync(made, 'first result\n'); });
    await waitFor(() => diffOf(pane, made).length === 1, 'the new temporary file opens its own Hunk');
    const [hunk] = diffOf(pane, made);
    await waitFor(() => screen(hunk).includes('first result') && screen(hunk).includes('result.txt (new)'), 'shown as added');
    assert.deepEqual(temps(pi).map(entry => [entry.file, entry.added]), [[made, true]], 'recorded once, canonical, with an empty baseline');
    assert.ok(temps(pi)[0].baseline.startsWith(join(process.env.XDG_STATE_HOME, 'pi-harness', 'temp-baselines', 'session-a')), 'the copy is in local state');
    assert.equal(readFileSync(temps(pi)[0].baseline, 'utf8'), '');

    // An edit of a file that existed: compared with its content before the first edit, through two edits.
    const config = join(scratch, 'config.ini');
    writeFileSync(config, 'mode = old\n');
    await tool(pi, 'edit', { path: config }, () => writeFileSync(config, 'mode = middle\n'));
    await tool(pi, 'edit', { path: config }, () => writeFileSync(config, 'mode = new\n'));
    await waitFor(() => diffOf(pane, config).length === 1, 'the edited file opens its Hunk');
    const [edited] = diffOf(pane, config);
    await waitFor(() => /-\s+mode = old/.test(screen(edited)) && /\+\s+mode = new/.test(screen(edited)), 'old against new, not middle');
    assert.equal(temps(pi).filter(entry => entry.file === config).length, 1, 'the first baseline is kept');

    // Another agent's file beside it, changed during this session's turn, is not this session's.
    const theirs = join(scratch, 'theirs.txt');
    await tool(pi, 'bash', { command: 'true' }, () => writeFileSync(theirs, 'another agent\n'));
    assert.deepEqual(diffOf(pane, theirs), []);
    assert.ok(!(await offered(pi)).includes('theirs.txt'), '/panels does not list it');
    assert.equal(temps(pi).length, 2);

    // A file of the watched repository, here inside the temporary folder too, keeps the repository's diff.
    await tool(pi, 'edit', { path: join(repo, 'tracked.txt') }, () => appendFileSync(join(repo, 'tracked.txt'), 'repo change\n'));
    await waitFor(() => diffOf(pane, repo).length === 1, 'the repository diff opens');
    assert.deepEqual(diffOf(pane, join(repo, 'tracked.txt')), [], 'no second, per-file diff');
    assert.equal(temps(pi).length, 2, 'not recorded as a temporary file');
    git('checkout', 'tracked.txt');

    // A command's later change to a file that is the session's shows too.
    await tool(pi, 'bash', { command: 'make' }, () => appendFileSync(made, 'second line from a script\n'));
    await waitFor(() => screen(diffOf(pane, made)[0] ?? pane).includes('second line from a script'), 'its Hunk follows');
    assert.match(await offered(pi), /config\.ini · changed[\s\S]*result\.txt · added|result\.txt · added[\s\S]*config\.ini · changed/);
  } finally { await quit(pi); }
});

test('script output named with show_panel becomes the session\'s, as added; Markdown opens in the editor', async () => {
  const pane = newPane();
  const pi = await start(pane, 'session-b', []);
  try {
    const out = join(scratch, 'report', 'out.csv'), notes = join(scratch, 'report', 'summary.md');
    await tool(pi, 'bash', { command: 'python make_report.py' }, () => {
      mkdirSync(join(scratch, 'report'));
      writeFileSync(out, 'a,b\n1,2\n');
      writeFileSync(notes, '# Summary\n\nscript summary text\n');
    });
    assert.deepEqual([...diffPanes(pane), ...docPanes(pane)], [], 'a command\'s output is nobody\'s until named');
    assert.match(await showPanel(pi, join(scratch, 'report')), /temporary folder: only files are this session's/, 'a folder is refused');
    assert.deepEqual(temps(pi), []);

    assert.match(await showPanel(pi, alias(out)), /out\.csv is this session's; showing its diff \(added\)/);
    const [hunk] = diffOf(pane, out);
    await waitFor(() => screen(hunk).includes('out.csv (new)') && screen(hunk).includes('1,2'), 'the output shows as added');
    assert.match(await showPanel(pi, notes), /Showing summary\.md in the editor/);
    await waitFor(() => docPanes(pane).length === 1 && screen(docPanes(pane)[0]).includes('script summary text'), 'Markdown in Neovim');
    assert.deepEqual(temps(pi).map(entry => entry.file).sort(), [notes, out].sort(), 'both recorded');

    // The script runs again in a later turn: the Hunk follows, and the summary reloads in the editor.
    await fire(pi, 'before_agent_start');
    await tool(pi, 'bash', { command: 'python make_report.py' }, () => {
      appendFileSync(out, '3,4\n');
      appendFileSync(notes, '\nsecond run text\n');
    });
    await waitFor(() => screen(diffOf(pane, out)[0]).includes('3,4'), 'the diff updates');
    assert.ok((await offered(pi)).includes('summary.md'), '/panels lists the temporary Markdown');
  } finally { await quit(pi); }
});

test('reload and resume keep the session\'s files; another session sees none; a lost original baseline is reported and its stale diff closes', async () => {
  const pane = newPane();
  const saved = [];
  const first = await start(pane, 'session-c', saved);
  const log = join(scratch, 'build.log');
  writeFileSync(log, 'line one\n');
  await tool(first, 'edit', { path: log }, () => appendFileSync(log, 'line two\n'));
  await waitFor(() => diffOf(pane, log).length === 1, 'opens');
  const [hunk] = diffOf(pane, log);

  // Reload: the same session, the same Hunk, still this session's; a command's change shows.
  await fire(first, 'session_shutdown', { reason: 'reload' });
  const reloaded = await start(pane, 'session-c', saved);
  assert.deepEqual(diffOf(pane, log), [hunk], 'adopted, not duplicated');
  await tool(reloaded, 'bash', { command: 'tail' }, () => appendFileSync(log, 'line three\n'));
  await waitFor(() => screen(hunk).includes('line three'), 'still watched after reload');
  assert.match(await offered(reloaded), /build\.log · changed/);

  // Its original copy goes while the session runs and the file stays the same: the Hunk closes after the
  // next turn, and naming it does not bring a cached comparison back.
  const report = join(scratch, 'review.log');
  writeFileSync(report, 'first\n');
  await tool(reloaded, 'edit', { path: report }, () => appendFileSync(report, 'second\n'));
  await waitFor(() => diffOf(pane, report).length === 1, 'opens');
  rmSync(temps(reloaded).find(entry => entry.file === report).baseline);
  assert.match(await panel(reloaded, 'review.log'), /No preview named review\.log|baseline missing/, 'explicit selection checks it');
  assert.deepEqual(diffOf(pane, report), [], 'closed');
  writeFileSync(join(scratch, 'unrelated'), '');
  await tool(reloaded, 'bash', { command: 'true' });
  assert.deepEqual(diffOf(pane, report), []);

  // Another session in another pane knows nothing of it.
  const elsewhere = newPane();
  const other = await start(elsewhere, 'session-d', []);
  assert.ok(!(await offered(other)).includes('build.log'));
  await tool(other, 'bash', { command: 'true' }, () => appendFileSync(log, 'line four\n'));
  assert.deepEqual(diffPanes(elsewhere), [], 'its turns open nothing for this file');
  await quit(other);

  // The original copy goes: resuming reports it and closes the Hunk that would show a comparison it cannot make.
  await fire(reloaded, 'session_shutdown', { reason: 'reload' });
  const [entry] = temps(reloaded);
  rmSync(entry.baseline);
  const resumed = await start(pane, 'session-c', saved);
  assert.ok(resumed.notices.some(text => text.startsWith("No baseline remains for this session's temporary files") && text.includes(log)), resumed.notices.join('\n'));
  await waitFor(() => diffOf(pane, log).length === 0, 'the stale Hunk closes');
  assert.match(await offered(resumed), /build\.log · baseline missing/);
  assert.match(await panel(resumed, log), /baseline missing, so there is nothing to show/);
  assert.ok(!existsSync(entry.baseline), 'never rebuilt from the file as it is now');
  await quit(resumed);
});

test('a temporary diff closes when its file goes or returns to its baseline, without counting as dismissal; a replaced path shows nothing', async () => {
  const pane = newPane();
  const pi = await start(pane, 'session-e', []);
  try {
    const data = join(scratch, 'data.json');
    writeFileSync(data, '{"v": 1}\n');
    await tool(pi, 'edit', { path: data }, () => writeFileSync(data, '{"v": 2}\n'));
    await waitFor(() => diffOf(pane, data).length === 1, 'opens');
    await tool(pi, 'bash', { command: 'git restore' }, () => writeFileSync(data, '{"v": 1}\n'));
    await waitFor(() => diffOf(pane, data).length === 0, 'back to its baseline: closes');
    await tool(pi, 'bash', { command: 'gen' }, () => writeFileSync(data, '{"v": 3}\n'));
    await waitFor(() => diffOf(pane, data).length === 1, 'a later change in the same prompt reopens it');
    await tool(pi, 'bash', { command: 'rm' }, () => rmSync(data));
    await waitFor(() => diffOf(pane, data).length === 0, 'deleted: closes rather than showing the old content');
    assert.match(await offered(pi), /data\.json · deleted/);
    await tool(pi, 'bash', { command: 'gen' }, () => writeFileSync(data, '{"v": 4}\n'));
    await waitFor(() => diffOf(pane, data).length === 1 && screen(diffOf(pane, data)[0]).includes('"v": 4'), 'recreated: reopens');

    // The user closing it is respected until the next prompt.
    tmux('send-keys', '-t', diffOf(pane, data)[0], 'q');
    await waitFor(() => diffOf(pane, data).length === 0, 'closed by the user');
    await tool(pi, 'bash', { command: 'gen' }, () => writeFileSync(data, '{"v": 5}\n'));
    await sleep(300);
    assert.deepEqual(diffOf(pane, data), [], 'dismissed');

    // Replaced by a symlink to a file that is not the session's: nothing shows that file.
    const secret = join(scratch, 'other-agent-secret.txt');
    writeFileSync(secret, 'OTHER_AGENT_PRIVATE_OUTPUT\n');
    await fire(pi, 'before_agent_start');
    await tool(pi, 'bash', { command: 'ln' }, () => { rmSync(data); symlinkSync(secret, data); });
    await sleep(300);
    assert.deepEqual(diffOf(pane, data), []);
    assert.match(await offered(pi), /data\.json · replaced/);
    assert.match(await panel(pi, 'data.json'), /data\.json has no changes to show|nothing to show/);
    assert.deepEqual(diffPanes(pane).filter(id => screen(id).includes('OTHER_AGENT_PRIVATE_OUTPUT')), []);

    // The same for the session's Markdown: an agent turn does not load what a replaced path leads to into
    // the editor. (An editor already holding that path keeps its buffer under the file's real name, as
    // Neovim does; that is the user's buffer, not an automatic opening.)
    const review = join(scratch, 'review.md'), foreign = join(scratch, 'foreign.md');
    writeFileSync(foreign, '# Foreign\n\nFOREIGN_MARKDOWN_TEXT\n');
    await tool(pi, 'write', { path: review }, () => writeFileSync(review, '# Review\n\nown review text\n'));
    await waitFor(() => docPanes(pane).length === 1 && screen(docPanes(pane)[0]).includes('own review text'), 'opens');
    tmux('send-keys', '-t', docPanes(pane)[0], ':q', 'Enter');
    await waitFor(() => docPanes(pane).length === 0, 'the user closes it');
    await tool(pi, 'bash', { command: 'ln' }, () => { rmSync(review); symlinkSync(foreign, review); });
    await sleep(500);
    assert.deepEqual(docPanes(pane), [], 'no editor opens on it');
    assert.ok(!(await offered(pi)).includes('foreign.md'), '/panels does not offer it');
  } finally { await quit(pi); }
});

test('temporary Markdown the agent writes shares the one editor with repository Markdown; unsaved text is kept', async () => {
  const pane = newPane();
  const pi = await start(pane, 'session-m', []);
  const listed = () => tmux('show-options', '-pqv', '-t', pane, '@pi_docs').split('\n').filter(Boolean);
  try {
    const plan = join(scratch, 'plans', 'plan.md'), readme = join(repo, 'readme.md');
    await tool(pi, 'write', { path: alias(plan) }, () => { mkdirSync(join(scratch, 'plans')); writeFileSync(plan, '# Plan\n\ntemporary plan text\n'); });
    await waitFor(() => docPanes(pane).length === 1 && screen(docPanes(pane)[0]).includes('temporary plan text'), 'opens in the editor');
    const [editor] = docPanes(pane);
    assert.deepEqual(diffPanes(pane), [], 'Markdown has no Hunk');
    await tool(pi, 'write', { path: readme }, () => writeFileSync(readme, '# Readme\n\nrepository readme text\n'));
    await waitFor(() => screen(editor).includes('repository readme text'), 'repository Markdown in the same editor');
    assert.deepEqual(docPanes(pane), [editor], 'one editor');
    assert.deepEqual(listed().sort(), [plan, readme].sort(), 'both are document tabs');

    // Unsaved text in the editor survives the agent changing the temporary document.
    tmux('send-keys', '-t', editor, 'G', 'o', 'unsaved readme note', 'Escape');
    await waitFor(() => screen(editor).includes('unsaved readme note'), 'typed');
    await tool(pi, 'edit', { path: plan }, () => appendFileSync(plan, 'agent addition\n'));
    await sleep(500);
    assert.ok(screen(editor).includes('unsaved readme note'), 'the unsaved buffer stays shown');
    assert.deepEqual(docPanes(pane), [editor]);
    assert.ok((await offered(pi)).includes('plan.md'));
    tmux('send-keys', '-t', editor, ':w', 'Enter');
    await waitFor(() => readFileSync(readme, 'utf8').includes('unsaved readme note'), 'saved by the user');
  } finally {
    await quit(pi);
    rmSync(join(repo, 'readme.md'), { force: true });
  }
});

test('a write through a dangling symlink belongs to the file it creates', async () => {
  const pane = newPane();
  const pi = await start(pane, 'session-f', []);
  try {
    mkdirSync(join(scratch, 'links')); mkdirSync(join(scratch, 'targets'));
    const link = join(scratch, 'links', 'link.txt'), target = join(scratch, 'targets', 'made.txt');
    symlinkSync(target, link);
    await tool(pi, 'write', { path: link }, () => writeFileSync(link, 'through the link\n'));
    assert.deepEqual(temps(pi).map(entry => entry.file), [target]);
    await waitFor(() => diffOf(pane, target).length === 1 && screen(diffOf(pane, target)[0]).includes('through the link'), 'its diff shows');
  } finally { await quit(pi); }
});

test('a new session in the same pane keeps a carried temporary diff as its own, with its baseline', async () => {
  const pane = newPane();
  const first = await start(pane, 'session-g', []);
  // A name that once confused the carried metadata: it ends as an added marker would.
  const file = join(scratch, 'carried added');
  writeFileSync(file, 'before\n');
  await tool(first, 'edit', { path: file }, () => writeFileSync(file, 'after\n'));
  await waitFor(() => diffOf(pane, file).length === 1, 'opens');
  const [hunk] = diffOf(pane, file);
  // /new: Pi replaces the session in the same runtime pane; the previews belong to the new one.
  await fire(first, 'session_shutdown', { reason: 'new' });
  const second = await start(pane, 'session-h', []);
  assert.deepEqual(diffOf(pane, file), [hunk], 'kept');
  assert.deepEqual(temps(second).map(entry => [entry.file, entry.baseline]), [[file, temps(first)[0].baseline]], 'recorded in the new session with the same baseline');
  assert.equal(temps(second)[0].added, false, 'an edited file, not an added one');
  assert.match(await offered(second), /carried added · changed/, 'listed as a temporary diff, not a repository');
  await tool(second, 'bash', { command: 'gen' }, () => writeFileSync(file, 'before\n'));
  await waitFor(() => diffOf(pane, file).length === 0, 'its turns track it: back to its baseline, it closes');
  await quit(second);
});

test('library: only the injected temporary folders count; without Neovim temporary Markdown shows in Hunk', async () => {
  const pane = newPane();
  const ownerBefore = process.env.TMUX_PANE;
  process.env.TMUX_PANE = pane;
  try {
    const ctx = { mode: 'tui', cwd: repo };
    const roots = join(dir, 'injected-temp'), outside = join(dir, 'not-temp');
    mkdirSync(roots); mkdirSync(outside);
    const run = async (controller, path, change) => {
      await controller.before({ toolName: 'write', input: { path } }, ctx);
      change();
      return controller.settle();
    };
    const plain = lib.createDiffPane({ tempRoots: [roots] });
    plain.setTempFiles([], join(process.env.XDG_STATE_HOME, 'lib-test'));
    const loose = join(outside, 'loose.md');
    await run(plain, loose, () => writeFileSync(loose, '# Not temporary\n'));
    assert.deepEqual([...diffPanes(pane), ...docPanes(pane)], [], 'Markdown outside the temporary folders and skills opens nothing');
    assert.deepEqual(plain.takeTempFiles(), []);

    const noEditor = lib.createDiffPane({ tempRoots: [roots], nvim: '' });
    noEditor.setTempFiles([], join(process.env.XDG_STATE_HOME, 'lib-test'));
    const doc = join(roots, 'draft.md');
    await run(noEditor, doc, () => writeFileSync(doc, '# Draft\n\nno editor here\n'));
    await waitFor(() => diffOf(pane, doc).length === 1 && screen(diffOf(pane, doc)[0]).includes('no editor here'), 'Hunk instead of the editor');
    assert.deepEqual(docPanes(pane), []);
    await noEditor.close('tui');
  } finally { process.env.TMUX_PANE = ownerBefore; }
});
